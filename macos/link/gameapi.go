//go:build desktopui

package main

// The game window for the desktop page, served by the helper: it finds the MapleStory
// window by itself (no share-picker click) and hands the page crops of it, and reads text
// with the system's own recognizer. Loopback only, guarded by the launch token.
//
//	GET  /api/game                 {found, title, width, height, error}
//	GET  /api/frame?x&y&w&h&max    raw RGBA of a normalized crop; X-Width, X-Height,
//	                               X-Frame-Height (window height at the crop's scale)
//	GET  /api/ocr?x&y&w&h          {lines:[{text,x,y,w,h}], width, height} for a crop
//	POST /api/ocr?w&h              same, for RGBA pixels the page sends (picker capture)

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type gameSource struct {
	mu     sync.Mutex
	hwnd   uintptr
	title  string
	findAt time.Time
	last   frame
	lastAt time.Time
	err    string
}

var game = &gameSource{}

var errNoGame = errors.New("No MapleStory window is open.")

// current returns the game window, looked for again at most once a second.
func (g *gameSource) current() (uintptr, string) {
	if g.hwnd != 0 {
		if _, err := grabWindowCheck(g.hwnd); err == nil {
			return g.hwnd, g.title
		}
	}
	if time.Since(g.findAt) < time.Second {
		return g.hwnd, g.title
	}
	g.findAt = time.Now()
	h, title := findGameWindow()
	if h != g.hwnd && h != 0 {
		gameLog("game window found: %q", title)
	}
	g.hwnd, g.title = h, title
	return h, title
}

// grab returns a fresh frame (shared by requests within 90 ms of each other).
func (g *gameSource) grab() (frame, string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	h, title := g.current()
	if h == 0 {
		return frame{}, "", errNoGame
	}
	if time.Since(g.lastAt) < 90*time.Millisecond && g.last.W > 0 {
		return g.last, title, nil
	}
	f, err := grabWindow(h)
	if err != nil {
		g.err = err.Error()
		return frame{}, title, err
	}
	g.last, g.lastAt, g.err = f, time.Now(), ""
	return f, title, nil
}

// gameLog writes to the companion log (set when the API is registered).
var gameLog = func(string, ...any) {}

func registerGameAPI(mux *http.ServeMux, token string, logf func(string, ...any)) {
	gameLog = logf
	allowed := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("X-Companion-Token") != token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return false
		}
		w.Header().Set("Cache-Control", "no-store")
		return true
	}
	region := func(r *http.Request) (x, y, w, h float64) {
		q := r.URL.Query()
		num := func(k string, d float64) float64 {
			v, err := strconv.ParseFloat(q.Get(k), 64)
			if err != nil || math.IsNaN(v) {
				return d
			}
			return v
		}
		return num("x", 0), num("y", 0), num("w", 1), num("h", 1)
	}
	mux.HandleFunc("/api/game", func(w http.ResponseWriter, r *http.Request) {
		if !allowed(w, r) {
			return
		}
		f, title, err := game.grab()
		out := map[string]any{"found": err == nil, "title": title, "width": f.W, "height": f.H}
		if err != nil {
			out["error"] = err.Error()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("/api/frame", func(w http.ResponseWriter, r *http.Request) {
		if !allowed(w, r) {
			return
		}
		f, _, err := game.grab()
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		x, y, cw, ch := region(r)
		maxSide, _ := strconv.Atoi(r.URL.Query().Get("max"))
		c, scale := cropScale(f, x, y, cw, ch, maxSide)
		if c.W == 0 {
			http.Error(w, "empty region", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Width", strconv.Itoa(c.W))
		w.Header().Set("X-Height", strconv.Itoa(c.H))
		w.Header().Set("X-Frame-Height", strconv.Itoa(int(math.Round(float64(f.H)*scale))))
		w.Write(c.Pix)
	})
	mux.HandleFunc("/api/ocr", func(w http.ResponseWriter, r *http.Request) {
		if !allowed(w, r) {
			return
		}
		var f frame
		if r.Method == http.MethodPost {
			q := r.URL.Query()
			fw, _ := strconv.Atoi(q.Get("w"))
			fh, _ := strconv.Atoi(q.Get("h"))
			if fw < 8 || fh < 8 || fw*fh > 4096*4096 {
				http.Error(w, "bad size", http.StatusBadRequest)
				return
			}
			pix, err := io.ReadAll(io.LimitReader(r.Body, int64(fw*fh*4)+1))
			if err != nil || len(pix) != fw*fh*4 {
				http.Error(w, "bad pixels", http.StatusBadRequest)
				return
			}
			f = frame{W: fw, H: fh, Pix: pix}
		} else {
			full, _, err := game.grab()
			if err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			x, y, cw, ch := region(r)
			f, _ = cropScale(full, x, y, cw, ch, 2600)
		}
		lines, err := recognizeText(f)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
			return
		}
		if lines == nil {
			lines = []ocrLine{}
		}
		json.NewEncoder(w).Encode(map[string]any{"lines": lines, "width": f.W, "height": f.H})
	})
}
