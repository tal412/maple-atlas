// maple-link is the pairing helper of Maple Atlas Companion.
//
// On the Mac it runs inside the app and talks to the Swift UI over newline-delimited
// JSON on stdin/stdout. Built with the desktopui tag (the Windows app) it serves its
// own local UI page instead (see desktop.go). Either way it serves the visual-matching
// engine on 127.0.0.1 and runs a WebRTC ICE-lite peer so a phone can connect by
// scanning a single QR code. Nothing goes to the internet: no signaling, STUN or TURN.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type command struct {
	Cmd        string  `json:"cmd"`
	ID         string  `json:"id"`
	Confidence int     `json:"confidence"`
	ObservedAt int64   `json:"observedAt"`
	State      string  `json:"state"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	// quests: what the game's Quest Helper shows (MapleQuestHelper.pack form).
	Visible bool            `json:"visible"`
	Quests  json.RawMessage `json:"quests"`
}

// controller runs one pairing session at a time and applies app commands to it.
type controller struct {
	mu       sync.Mutex
	site     string
	stateDir string
	emit     func(map[string]any)
	current  *session
}

func (c *controller) handle(cmd command) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch cmd.Cmd {
	case "start", "pair":
		// start: wait for the saved phone, or show a code when none is paired.
		// pair: forget the saved phone and show a code for a new one.
		if c.current != nil {
			c.current.close()
			c.current = nil
		}
		var ident *identity
		if cmd.Cmd == "start" {
			ident = loadIdentity(c.stateDir)
		} else {
			forgetIdentity(c.stateDir)
		}
		if ident == nil {
			var err error
			if ident, err = newIdentity(); err != nil {
				c.emit(map[string]any{"event": "state", "phase": "failed", "reason": "setup", "message": "Could not create a pairing: " + err.Error()})
				return
			}
		}
		s, info, err := newSession(c.site, c.emit, ident, c.stateDir)
		if err != nil {
			c.emit(map[string]any{"event": "state", "phase": "failed", "reason": "setup", "message": "Could not start pairing: " + err.Error()})
			return
		}
		c.current = s
		if info.Paired {
			c.emit(map[string]any{"event": "paired", "addresses": info.Addresses})
		} else {
			if info.Note != "" {
				c.emit(map[string]any{"event": "error", "message": info.Note})
			}
			c.emit(map[string]any{"event": "code", "code": info.Code, "link": info.Link, "expires": info.Expires, "addresses": info.Addresses})
		}
	case "location":
		if c.current != nil {
			c.current.sendLocation(cmd.ID, cmd.Confidence, cmd.ObservedAt)
		}
	case "position":
		if c.current != nil {
			c.current.sendPosition(cmd.ID, cmd.X, cmd.Y, cmd.ObservedAt)
		}
	case "quests":
		if c.current != nil {
			c.current.sendQuests(cmd.Visible, cmd.Quests, cmd.ObservedAt)
		}
	case "tracking":
		if c.current != nil {
			c.current.sendTracking(cmd.State)
		}
	case "stop":
		if c.current != nil {
			c.current.disconnect()
		}
	}
}

func (c *controller) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.current != nil {
		c.current.close()
		c.current = nil
	}
}

// desktopMain is set by desktop.go when built with the desktopui tag.
var desktopMain func(site, stateDir string, ui bool)

// firewallCommand handles --repair-firewall and --remove-firewall on Windows (set
// by firewall_windows.go); the setup program and the window's repair button run them.
var firewallCommand func(arg string) int

func main() {
	if len(os.Args) == 2 && strings.HasSuffix(os.Args[1], "-firewall") && firewallCommand != nil {
		os.Exit(firewallCommand(os.Args[1]))
	}
	engineDir := flag.String("engine-dir", "", "directory with engine.html and the visual index")
	site := flag.String("site", "https://tal412.github.io/maple-atlas/", "Maple Atlas site the phone opens")
	stateDir := flag.String("state-dir", "", "folder that keeps the pairing so the phone reconnects after restarts")
	ui := flag.Bool("ui", false, "serve the built-in companion window (desktopui builds)")
	flag.Parse()

	if desktopMain != nil {
		desktopMain(*site, *stateDir, *ui)
		return
	}

	var outMu sync.Mutex
	out := json.NewEncoder(os.Stdout)
	emit := func(v map[string]any) {
		outMu.Lock()
		defer outMu.Unlock()
		_ = out.Encode(v)
	}
	if *engineDir != "" {
		if url, err := serveEngine(*engineDir); err != nil {
			emit(map[string]any{"event": "error", "message": "The map matcher could not start: " + err.Error()})
		} else {
			emit(map[string]any{"event": "engine", "url": url})
		}
	}
	ctrl := &controller{site: *site, stateDir: *stateDir, emit: emit}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 64*1024)
	for in.Scan() {
		var c command
		if json.Unmarshal(in.Bytes(), &c) == nil {
			ctrl.handle(c)
		}
	}
	// stdin closed: the app quit.
	ctrl.close()
}

// serveEngine serves the matcher files to the app's hidden web view. It listens
// only on loopback, so nothing else on the network can reach it.
func serveEngine(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(abs, "engine.html")); err != nil {
		return "", fmt.Errorf("engine.html missing in %s", abs)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	files := http.FileServer(http.Dir(abs))
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		files.ServeHTTP(w, r)
	}))
	return fmt.Sprintf("http://%s/engine.html", ln.Addr()), nil
}
