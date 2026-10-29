//go:build desktopui

// Desktop mode (the Windows app): the helper serves its own companion window, a
// local page that captures the game window, runs the matcher and shows the QR.
// The page talks to the helper over loopback only: an event stream for helper
// events and POST /api/cmd for commands, both guarded by a per-launch token.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed all:webui
var webui embed.FS

func init() { desktopMain = runDesktop }

// hub fans helper events out to the open window and replays the latest pairing
// and connection state when the window (re)connects.
type hub struct {
	mu       sync.Mutex
	clients  map[chan []byte]struct{}
	pairing  []byte
	state    []byte
	logger   *log.Logger
	lastGone time.Time
	ever     bool
}

func (h *hub) emit(v map[string]any) {
	b, _ := json.Marshal(v)
	h.logger.Printf("%s", b)
	h.mu.Lock()
	defer h.mu.Unlock()
	switch v["event"] {
	case "code", "paired":
		h.pairing = b
	case "state":
		h.state = b
	}
	for c := range h.clients {
		select {
		case c <- b:
		default: // a stalled window misses an event rather than blocking the helper
		}
	}
}

func (h *hub) subscribe() (chan []byte, [][]byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := make(chan []byte, 64)
	h.clients[c] = struct{}{}
	h.ever = true
	var replay [][]byte
	for _, b := range [][]byte{h.pairing, h.state} {
		if b != nil {
			replay = append(replay, b)
		}
	}
	return c, replay
}

func (h *hub) unsubscribe(c chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c)
	if len(h.clients) == 0 {
		h.lastGone = time.Now()
	}
}

// windowGone reports whether the window was open once and has now been closed for a while.
func (h *hub) windowGone(after time.Duration) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ever && len(h.clients) == 0 && time.Since(h.lastGone) > after
}

func channelOf(site string) string {
	if strings.Contains(site, "/dev") {
		return "dev"
	}
	return "main"
}

func runDesktop(site, stateDir string, _ bool) {
	if stateDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			fatal("Maple Atlas Companion could not find its settings folder: " + err.Error())
		}
		stateDir = filepath.Join(base, "Maple Atlas Companion", channelOf(site))
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		fatal("Maple Atlas Companion could not create " + stateDir + ": " + err.Error())
	}
	logOut := io.Writer(os.Stderr)
	if f, err := os.OpenFile(filepath.Join(stateDir, "companion.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		defer f.Close()
		logOut = io.MultiWriter(os.Stderr, f)
	}
	logger := log.New(logOut, "", log.LstdFlags)
	h := &hub{clients: map[chan []byte]struct{}{}, logger: logger}
	// Navigation from the phone also feeds the on-game overlay (overlay_windows.go).
	emit := func(v map[string]any) {
		if v["event"] == "nav" {
			overlayNav(v)
		}
		h.emit(v)
	}
	ctrl := &controller{site: site, stateDir: stateDir, emit: emit}
	token := randomHex(16)

	files, _ := fs.Sub(webui, "webui")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fatal("Maple Atlas Companion could not start its window: " + err.Error())
	}
	origin := "http://" + ln.Addr().String()
	mux := http.NewServeMux()
	static := http.FileServer(http.FS(files))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		static.ServeHTTP(w, r)
	}))
	mux.HandleFunc("/api/events", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("t") != token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		c, replay := h.subscribe()
		defer h.unsubscribe(c)
		for _, b := range replay {
			fmt.Fprintf(w, "data: %s\n\n", b)
		}
		flusher.Flush()
		ping := time.NewTicker(15 * time.Second)
		defer ping.Stop()
		for {
			select {
			case b := <-c:
				fmt.Fprintf(w, "data: %s\n\n", b)
				flusher.Flush()
			case <-ping.C:
				fmt.Fprint(w, ": ping\n\n")
				flusher.Flush()
			case <-r.Context().Done():
				return
			}
		}
	})
	registerGameAPI(mux, token, logger.Printf)
	mux.HandleFunc("/api/cmd", func(w http.ResponseWriter, r *http.Request) {
		// Only this window may send commands: same origin and the launch token.
		if r.Method != http.MethodPost || r.Header.Get("X-Companion-Token") != token || r.Header.Get("Origin") != origin {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var cmd command
		if json.NewDecoder(io.LimitReader(r.Body, 16384)).Decode(&cmd) != nil {
			http.Error(w, "bad command", http.StatusBadRequest)
			return
		}
		go ctrl.handle(cmd)
		w.WriteHeader(http.StatusNoContent)
	})
	// Windows Firewall: GET reports whether the phone can get through; POST asks
	// Windows (administrator approval) to allow this program.
	mux.HandleFunc("/api/firewall", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Companion-Token") != token || r.Method == http.MethodPost && r.Header.Get("Origin") != origin {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodPost {
			if err := fixFirewall(); err != nil {
				logger.Printf("firewall fix: %v", err)
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusAccepted)
			return
		}
		report := firewallStatus()
		logger.Printf("firewall: %s %s", report.State, report.Detail)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(report)
	})
	// Updates: GET checks the latest release; POST downloads its setup and starts it.
	// Progress arrives as "update" events.
	var updating sync.Mutex
	mux.HandleFunc("/api/update", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Companion-Token") != token || r.Header.Get("Origin") != origin && r.Method == http.MethodPost {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		rel, err := latestRelease()
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"current": version, "error": "Could not check for updates: " + err.Error()})
			return
		}
		latest, setup := releaseVersion(rel.Tag), rel.asset(setupName)
		available := setup != nil && newerVersion(latest, version)
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"current": version, "latest": latest, "available": available, "page": rel.Page})
			return
		}
		if r.Method != http.MethodPost || !available {
			http.Error(w, "no update", http.StatusConflict)
			return
		}
		if !updating.TryLock() {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		go func() {
			defer updating.Unlock()
			h.emit(map[string]any{"event": "update", "phase": "downloading", "message": "Downloading version " + latest + "…"})
			path, err := downloadAsset(setup, latest)
			if err == nil {
				err = startInstaller(path)
			}
			if err != nil {
				h.emit(map[string]any{"event": "update", "phase": "failed", "message": "Update failed: " + err.Error()})
				return
			}
			h.emit(map[string]any{"event": "update", "phase": "installing", "message": "Follow the setup window. The companion reopens when it finishes."})
		}()
		w.WriteHeader(http.StatusAccepted)
	})
	go http.Serve(ln, mux)

	ctrl.handle(command{Cmd: "start"})
	url := origin + "/?t=" + token
	logger.Printf("window at %s/ (state %s)", origin, stateDir)
	if err := openWindow(url, filepath.Join(stateDir, "window")); err != nil {
		fatal("Maple Atlas Companion could not open its window: " + err.Error() + "\n\nOpen this address in Microsoft Edge or Google Chrome:\n" + url)
	}

	// Quit when the window has been closed for 10 s, or if it never opened.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	started := time.Now()
	for {
		select {
		case <-stop:
			ctrl.close()
			return
		case <-time.After(2 * time.Second):
		}
		if h.windowGone(10*time.Second) || (!h.ever && time.Since(started) > 2*time.Minute) {
			logger.Printf("window closed; quitting")
			ctrl.close()
			return
		}
	}
}
