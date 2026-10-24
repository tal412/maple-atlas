// maple-link is the pairing helper inside Maple Atlas Companion.app.
//
// It talks to the Swift app over newline-delimited JSON on stdin/stdout, serves
// the visual-matching engine files on 127.0.0.1, and runs a WebRTC ICE-lite peer
// so a phone can connect by scanning a single QR code. Nothing goes to the
// internet: no signaling, STUN or TURN server is used.
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
	"sync"
)

type command struct {
	Cmd        string `json:"cmd"`
	ID         string `json:"id"`
	Confidence int    `json:"confidence"`
	ObservedAt int64  `json:"observedAt"`
	State      string `json:"state"`
}

func main() {
	engineDir := flag.String("engine-dir", "", "directory with engine.html and the visual index")
	site := flag.String("site", "https://tal412.github.io/maple-atlas/dev/", "Maple Atlas site the phone opens")
	flag.Parse()

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

	var current *session
	var mu sync.Mutex
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 64*1024)
	for in.Scan() {
		var c command
		if json.Unmarshal(in.Bytes(), &c) != nil {
			continue
		}
		mu.Lock()
		switch c.Cmd {
		case "pair":
			if current != nil {
				current.close()
			}
			s, code, link, addresses, expires, err := newSession(*site, emit)
			if err != nil {
				current = nil
				emit(map[string]any{"event": "state", "phase": "failed", "reason": "setup", "message": "Could not create a pairing code: " + err.Error()})
				break
			}
			current = s
			emit(map[string]any{"event": "code", "code": code, "link": link, "expires": expires, "addresses": addresses})
		case "location":
			if current != nil {
				current.sendLocation(c.ID, c.Confidence, c.ObservedAt)
			}
		case "tracking":
			if current != nil {
				current.sendTracking(c.State)
			}
		case "stop":
			if current != nil {
				current.end("disconnected", "You disconnected. Create a new code to pair again.")
				current = nil
			}
		}
		mu.Unlock()
	}
	// stdin closed: the app quit.
	mu.Lock()
	if current != nil {
		current.close()
	}
	mu.Unlock()
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
