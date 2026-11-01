package main

// Maple Atlas on the computer itself: the helper serves the Maple Atlas site on a fixed
// loopback address (a pass-through of the published site, so it is always the current one)
// and links the page to the game on this computer, the way a paired phone is linked, but
// without the network: an event stream for what the computer sends and POST for what the
// page sends. The app opens it in its own window, so the map, quests, Look and prices all
// work with no phone near.
//
//	GET  /__companion/link?t=TOKEN   event stream: {kind:"hello", …} first, then the phone
//	                                 protocol's messages (location, position, quests,
//	                                 tracking, look-*), the latest of each replayed on connect
//	POST /__companion/send           {kind:"nav"|"pins"|"look"|"controls", …} with the
//	                                 X-Companion-Token header, from this origin only
//	everything else                  the Maple Atlas site (main or dev), through this helper
//
// Only this computer can reach it (127.0.0.1), every request must name this address as its
// Host (no DNS rebinding), and the link needs the per-launch token the app gives its window.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

func channelOf(site string) string {
	if strings.Contains(site, "/dev") {
		return "dev"
	}
	return "main"
}

// Fixed ports, so the page keeps its saved quests and settings (they belong to its address).
const (
	atlasPortMain = 47913
	atlasPortDev  = 47914
)

// peer is where a look's answer goes: the paired phone (session) or this computer's own
// Maple Atlas window (desk).
type peer interface {
	sendLook(shot lookShot) error
	sendLookFound(req string, raw []byte) error
	sendLookProgress(req, text string)
	sendLookError(req, msg string)
}

// kept is a live message kept for a window that (re)connects, with its sequence number.
type kept struct {
	seq int
	b   []byte
}

// desk is the link with the Maple Atlas window on this computer.
type desk struct {
	mu      sync.Mutex
	token   string
	host    string // "mac" or "windows"
	ui      string // where the page opens the companion's controls ("" = the app shows them)
	clients map[chan []byte]struct{}
	seq     int
	latest  map[string]kept // the last location, position, quests and tracking, for a page that (re)connects
	reqs    map[string]time.Time
	emit    func(map[string]any)
}

func newDesk(host string, emit func(map[string]any)) *desk {
	return &desk{token: randomHex(16), host: host, clients: map[chan []byte]struct{}{}, latest: map[string]kept{}, reqs: map[string]time.Time{}, emit: emit}
}

// open reports whether a Maple Atlas window is linked now.
func (d *desk) open() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.clients) > 0
}

func (d *desk) subscribe() (chan []byte, [][]byte) {
	d.mu.Lock()
	defer d.mu.Unlock()
	c := make(chan []byte, 256)
	first := len(d.clients) == 0
	d.clients[c] = struct{}{}
	hello, _ := json.Marshal(map[string]any{"kind": "hello", "v": 2, "role": "pc", "host": d.host, "ui": d.ui, "version": version})
	replay := [][]byte{hello}
	// In the order they were sent: the page takes only newer sequence numbers.
	held := make([]kept, 0, len(d.latest))
	for _, k := range d.latest {
		held = append(held, k)
	}
	sort.Slice(held, func(i, j int) bool { return held[i].seq < held[j].seq })
	for _, k := range held {
		replay = append(replay, k.b)
	}
	if first {
		go d.emit(map[string]any{"event": "desk", "open": true})
	}
	return c, replay
}

func (d *desk) unsubscribe(c chan []byte) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.clients, c)
	if len(d.clients) == 0 {
		go d.emit(map[string]any{"event": "desk", "open": false})
	}
}

// send gives a message to every open window. wait: block (up to 5 s) rather than drop it,
// for the parts of a look; the live messages are dropped for a stalled window instead.
func (d *desk) send(v map[string]any, wait bool) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	d.mu.Lock()
	clients := make([]chan []byte, 0, len(d.clients))
	for c := range d.clients {
		clients = append(clients, c)
	}
	d.mu.Unlock()
	if len(clients) == 0 {
		return errors.New("Maple Atlas is not open on this computer")
	}
	for _, c := range clients {
		if wait {
			select {
			case c <- b:
			case <-time.After(5 * time.Second):
				return errors.New("the Maple Atlas window stalled")
			}
			continue
		}
		select {
		case c <- b:
		default:
		}
	}
	return nil
}

// sequenced sends a live message with the next sequence number and keeps it for replay.
func (d *desk) sequenced(v map[string]any) bool {
	d.mu.Lock()
	v["seq"] = d.seq
	d.seq++
	b, _ := json.Marshal(v)
	d.latest[v["kind"].(string)] = kept{seq: d.seq - 1, b: b}
	d.mu.Unlock()
	return d.send(v, false) == nil
}

func (d *desk) sendLocation(id string, confidence int, observedAt int64) bool {
	if id == "" || confidence < 0 || confidence > 100 || observedAt <= 0 {
		return false
	}
	return d.sequenced(map[string]any{"kind": "location", "id": id, "confidence": confidence, "observedAt": observedAt})
}

func (d *desk) sendPosition(id string, x, y float64, observedAt int64) bool {
	if id == "" || observedAt <= 0 || math.IsNaN(x) || math.IsNaN(y) || math.Abs(x) > 1e6 || math.Abs(y) > 1e6 {
		return false
	}
	return d.sequenced(map[string]any{"kind": "position", "id": id, "x": math.Round(x), "y": math.Round(y), "observedAt": observedAt})
}

func (d *desk) sendQuests(visible bool, raw json.RawMessage, observedAt int64) bool {
	if observedAt <= 0 || len(raw) > 6000 {
		return false
	}
	var quests []any
	if len(raw) > 0 && (json.Unmarshal(raw, &quests) != nil || len(quests) > 8) {
		return false
	}
	if quests == nil {
		quests = []any{}
	}
	return d.sequenced(map[string]any{"kind": "quests", "visible": visible, "quests": quests, "observedAt": observedAt})
}

func (d *desk) sendTracking(state string) bool {
	if state != "searching" && state != "paused" {
		return false
	}
	return d.sequenced(map[string]any{"kind": "tracking", "state": state, "observedAt": time.Now().UnixMilli()})
}

// own records a look this window asked for, so its answer comes back here.
func (d *desk) own(req string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for r, at := range d.reqs {
		if time.Since(at) > 2*time.Minute {
			delete(d.reqs, r)
		}
	}
	d.reqs[req] = time.Now()
}

func (d *desk) owns(req string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.reqs[req]
	return ok
}

func (d *desk) sendLook(shot lookShot) error {
	if !lookReq.MatchString(shot.Req) || len(shot.JPEG) == 0 || len(shot.JPEG) > lookMaxBytes || shot.W < 16 || shot.H < 16 || shot.W > 4096 || shot.H > 4096 {
		return errors.New("bad screenshot")
	}
	data := base64.StdEncoding.EncodeToString(shot.JPEG)
	parts := (len(data) + lookPart - 1) / lookPart
	lines := make([][]any, 0, len(shot.Lines))
	for _, ln := range shot.Lines {
		if t := strings.TrimSpace(ln.Text); t != "" {
			lines = append(lines, []any{clip(t, 60), int(ln.X), int(ln.Y), int(ln.W), int(ln.H)})
		}
	}
	var mark any
	if len(shot.Mark) == 4 {
		mark = shot.Mark
	}
	meta := map[string]any{"kind": "look-meta", "v": 1, "req": shot.Req, "w": shot.W, "h": shot.H, "parts": parts, "bytes": len(shot.JPEG), "mark": mark, "map": shot.Map}
	for {
		meta["lines"] = lines
		b, _ := json.Marshal(meta)
		if len(b) <= lookMetaMax || len(lines) == 0 {
			break
		}
		lines = lines[:len(lines)*9/10]
	}
	if err := d.send(meta, true); err != nil {
		return err
	}
	for i := 0; i < parts; i++ {
		end := min((i+1)*lookPart, len(data))
		if err := d.send(map[string]any{"kind": "look-part", "v": 1, "req": shot.Req, "i": i, "data": data[i*lookPart : end]}, true); err != nil {
			return err
		}
	}
	return nil
}

func (d *desk) sendLookFound(req string, raw []byte) error {
	if !lookReq.MatchString(req) || !strings.HasPrefix(req, "p") || len(raw) < 2 || len(raw) > lookFoundMax || raw[0] != '{' || !json.Valid(raw) {
		return errors.New("bad result")
	}
	data := base64.StdEncoding.EncodeToString(raw)
	parts := (len(data) + lookPart - 1) / lookPart
	for i := 0; i < parts; i++ {
		end := min((i+1)*lookPart, len(data))
		if err := d.send(map[string]any{"kind": "look-found", "v": 1, "req": req, "i": i, "n": parts, "data": data[i*lookPart : end]}, true); err != nil {
			return err
		}
	}
	return nil
}

func (d *desk) sendLookProgress(req, text string) {
	if t, ok := lookProgressText(text); ok && lookReq.MatchString(req) && strings.HasPrefix(req, "p") {
		d.send(map[string]any{"kind": "look-progress", "v": 1, "req": req, "text": t}, false)
	}
}

func (d *desk) sendLookError(req, msg string) {
	if lookReq.MatchString(req) {
		d.send(map[string]any{"kind": "look-error", "v": 1, "req": req, "message": clip(msg, 160)}, false)
	}
}

// received handles a message from the window: the same checks as the phone's.
func (d *desk) received(m message) {
	switch {
	case m.Kind == "nav" && m.V == 1:
		if ev, ok := navEvent(m.Nav); ok {
			d.emit(ev)
		}
	case m.Kind == "pins" && m.V == 1:
		if ev, ok := pinsEvent(m.Pins); ok {
			d.emit(ev)
		}
	case m.Kind == "look" && m.V == 1 && lookReq.MatchString(m.Req) && strings.HasPrefix(m.Req, "p"):
		d.own(m.Req)
		if lookRequested != nil {
			go lookRequested(d, m.Req)
		} else {
			d.emit(map[string]any{"event": "look-request", "req": m.Req})
		}
	case m.Kind == "controls":
		// The page asks the app to show its controls (game window, phone pairing).
		d.emit(map[string]any{"event": "controls"})
	}
}

// atlas is the loopback server: the site, the window's link and (Windows) the controls.
type atlas struct {
	Origin string // http://127.0.0.1:PORT
	Mux    *http.ServeMux
	desk   *desk
	ln     net.Listener
}

// newAtlas listens on the channel's fixed port (or any free one when it is taken) and
// passes the site through. logf may be nil.
func newAtlas(site string, d *desk, logf func(string, ...any)) (*atlas, error) {
	if logf == nil {
		logf = log.Printf
	}
	target, err := url.Parse(site)
	if err != nil || target.Scheme != "https" && target.Scheme != "http" {
		return nil, fmt.Errorf("bad site %q", site)
	}
	port := atlasPortMain
	if channelOf(site) == "dev" {
		port = atlasPortDev
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		logf("atlas: port %d is taken (%v); using another (saved quests and settings stay on %d)", port, err, port)
		if ln, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
			return nil, err
		}
	}
	a := &atlas{Origin: "http://" + ln.Addr().String(), Mux: http.NewServeMux(), desk: d, ln: ln}
	a.Mux.Handle("/", siteProxy(target, d, logf))
	a.Mux.HandleFunc("/__companion/link", a.link)
	a.Mux.HandleFunc("/__companion/send", a.send)
	return a, nil
}

// Serve answers requests until the listener closes; it refuses any Host but its own.
func (a *atlas) Serve() error {
	host := strings.TrimPrefix(a.Origin, "http://")
	return http.Serve(a.ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host && r.Host != strings.Replace(host, "127.0.0.1", "localhost", 1) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		a.Mux.ServeHTTP(w, r)
	}))
}

// URL is the address the app opens: the site, with the token in the fragment (never sent).
func (a *atlas) URL() string { return a.Origin + "/#companion=" + a.desk.token }

func (a *atlas) link(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("t") != a.desk.token {
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
	w.Header().Set("X-Content-Type-Options", "nosniff")
	c, replay := a.desk.subscribe()
	defer a.desk.unsubscribe(c)
	for _, b := range replay {
		fmt.Fprintf(w, "data: %s\n\n", b)
	}
	flusher.Flush()
	ping := time.NewTicker(10 * time.Second)
	defer ping.Stop()
	for {
		select {
		case b := <-c:
			fmt.Fprintf(w, "data: %s\n\n", b)
			// Send what else is queued in the same write (the parts of a look).
			for more := true; more; {
				select {
				case b := <-c:
					fmt.Fprintf(w, "data: %s\n\n", b)
				default:
					more = false
				}
			}
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (a *atlas) send(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.Header.Get("X-Companion-Token") != a.desk.token || r.Header.Get("Origin") != a.Origin {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var m message
	if json.NewDecoder(io.LimitReader(r.Body, 16384)).Decode(&m) != nil {
		http.Error(w, "bad message", http.StatusBadRequest)
		return
	}
	a.desk.received(m)
	w.WriteHeader(http.StatusNoContent)
}

// siteProxy passes requests to the published site. Redirects are pointed back here; cookies
// are never passed either way. When the site cannot be reached and the page has nothing saved,
// a short page says so (and, on Windows, still shows the companion's controls).
func siteProxy(target *url.URL, d *desk, logf func(string, ...any)) http.Handler {
	base := strings.TrimSuffix(target.Path, "/")
	p := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme, r.Out.URL.Host = target.Scheme, target.Host
			r.Out.URL.Path, r.Out.URL.RawPath = base+r.In.URL.Path, ""
			r.Out.Host = target.Host
			for _, h := range []string{"Cookie", "Origin", "Referer", "X-Companion-Token"} {
				r.Out.Header.Del(h)
			}
		},
		ModifyResponse: func(res *http.Response) error {
			res.Header.Del("Set-Cookie")
			if loc := res.Header.Get("Location"); loc != "" {
				if u, err := url.Parse(loc); err == nil && (u.Host == "" || u.Host == target.Host) && strings.HasPrefix(u.Path, base+"/") {
					u.Scheme, u.Host, u.Path = "", "", strings.TrimPrefix(u.Path, base)
					res.Header.Set("Location", u.String())
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			logf("atlas: %s %s: %v", r.Method, r.URL.Path, err)
			if r.Method != http.MethodGet || !strings.Contains(r.Header.Get("Accept"), "text/html") {
				http.Error(w, "Maple Atlas could not be reached", http.StatusBadGateway)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusServiceUnavailable)
			io.WriteString(w, offlinePage(d))
		},
	}
	return p
}

// offlinePage is shown when the site cannot be reached and nothing is saved yet.
func offlinePage(d *desk) string {
	frame := ""
	if d.ui != "" {
		frame = `<iframe src="` + html.EscapeString(d.ui) + `" title="Companion" allow="display-capture; clipboard-write"></iframe>`
	}
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Maple Atlas</title>
<style>body{margin:0;font:15px/1.45 system-ui,sans-serif;display:grid;grid-template-rows:auto 1fr;height:100vh}header{padding:18px 22px}h1{font-size:19px;margin:0 0 4px}p{margin:0;opacity:.75}iframe{border:0;width:100%;height:100%}</style>
<script>setTimeout(()=>location.reload(),15000)</script></head><body><header><h1>Maple Atlas needs the internet once</h1><p>Connect this computer to the internet. The map opens by itself, and works offline after that.</p></header>` + frame + `</body></html>`
}
