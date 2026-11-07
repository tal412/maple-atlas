package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// A stand-in for the published site at /maple-atlas/.
func fakeSite(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/maple-atlas/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Companion-Token") != "" {
			t.Errorf("private headers reached the site: %v", r.Header)
		}
		switch r.URL.Path {
		case "/maple-atlas/":
			w.Header().Set("Set-Cookie", "a=b")
			w.Write([]byte("<!doctype html>atlas"))
		case "/maple-atlas/dir":
			http.Redirect(w, r, "/maple-atlas/dir/", http.StatusMovedPermanently)
		default:
			http.NotFound(w, r)
		}
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

type events struct {
	mu   sync.Mutex
	list []map[string]any
}

func (e *events) emit(v map[string]any) { e.mu.Lock(); e.list = append(e.list, v); e.mu.Unlock() }
func (e *events) find(name string) map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, v := range e.list {
		if v["event"] == name {
			return v
		}
	}
	return nil
}

func startAtlas(t *testing.T, site string) (*atlas, *events) {
	t.Helper()
	ev := &events{}
	a, err := newAtlas(site, newDesk("mac", ev.emit), t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	go a.Serve()
	t.Cleanup(func() { a.ln.Close() })
	return a, ev
}

func TestAtlasPassesTheSiteThrough(t *testing.T) {
	site := fakeSite(t)
	a, _ := startAtlas(t, site.URL+"/maple-atlas/")
	req, _ := http.NewRequest("GET", a.Origin+"/", nil)
	req.Header.Set("Cookie", "secret=1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body := make([]byte, 64)
	n, _ := res.Body.Read(body)
	if res.StatusCode != 200 || !strings.Contains(string(body[:n]), "atlas") || res.Header.Get("Set-Cookie") != "" {
		t.Fatalf("got %d %q cookie %q", res.StatusCode, body[:n], res.Header.Get("Set-Cookie"))
	}
	// Redirects point back here, without the site's base path.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err = client.Get(a.Origin + "/dir")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if loc := res.Header.Get("Location"); loc != "/dir/" {
		t.Fatalf("redirect to %q", loc)
	}
}

func TestAtlasRefusesOtherHostsAndNoToken(t *testing.T) {
	a, _ := startAtlas(t, fakeSite(t).URL+"/maple-atlas/")
	req, _ := http.NewRequest("GET", a.Origin+"/", nil)
	req.Host = "evil.example:80"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("other host: %d", res.StatusCode)
	}
	res, _ = http.Get(a.Origin + "/__companion/link?t=wrong")
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	// Commands need the token and this origin.
	for _, origin := range []string{"https://evil.example", ""} {
		req, _ = http.NewRequest("POST", a.Origin+"/__companion/send", strings.NewReader(`{"kind":"controls"}`))
		req.Header.Set("X-Companion-Token", a.desk.token)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, _ = http.DefaultClient.Do(req)
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("origin %q: %d", origin, res.StatusCode)
		}
	}
}

func TestDeskLinksTheWindow(t *testing.T) {
	a, ev := startAtlas(t, fakeSite(t).URL+"/maple-atlas/")
	d := a.desk
	// Sent before the window opens: kept and replayed, in order.
	d.sendTracking("paused")
	d.sendLocation("100000000", 92, 1700000000000)
	res, err := http.Get(a.Origin + "/__companion/link?t=" + d.token)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	lines := make(chan map[string]any, 64)
	go func() {
		sc := bufio.NewScanner(res.Body)
		sc.Buffer(make([]byte, 64<<10), 64<<10)
		for sc.Scan() {
			if b, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				var v map[string]any
				json.Unmarshal([]byte(b), &v)
				lines <- v
			}
		}
	}()
	next := func() map[string]any {
		select {
		case v := <-lines:
			return v
		case <-time.After(3 * time.Second):
			t.Fatal("no message")
			return nil
		}
	}
	if v := next(); v["kind"] != "hello" || v["host"] != "mac" {
		t.Fatalf("first %v", v)
	}
	if v := next(); v["kind"] != "tracking" || v["seq"].(float64) != 0 {
		t.Fatalf("replay %v", v)
	}
	if v := next(); v["kind"] != "location" || v["id"] != "100000000" || v["seq"].(float64) != 1 {
		t.Fatalf("replay %v", v)
	}
	d.sendPosition("100000000", 12.4, -40.6, 1700000000100)
	if v := next(); v["kind"] != "position" || v["x"].(float64) != 12 || v["seq"].(float64) != 2 {
		t.Fatalf("live %v", v)
	}
	if !d.open() || ev.find("desk") == nil {
		t.Fatal("the window should count as open")
	}
	// A look the window asks for comes back to it.
	post := func(body string) int {
		req, _ := http.NewRequest("POST", a.Origin+"/__companion/send", strings.NewReader(body))
		req.Header.Set("X-Companion-Token", d.token)
		req.Header.Set("Origin", a.Origin)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := post(`{"kind":"look","v":1,"req":"pabc1"}`); code != http.StatusNoContent {
		t.Fatalf("look: %d", code)
	}
	time.Sleep(50 * time.Millisecond)
	if v := ev.find("look-request"); v == nil || v["req"] != "pabc1" || !d.owns("pabc1") {
		t.Fatalf("look-request %v", v)
	}
	ctrl := &controller{desk: d}
	if ctrl.peerFor("pabc1") != peer(d) || ctrl.peerFor("pother") != nil {
		t.Fatal("look answers go to whoever asked")
	}
	if err := d.sendLook(lookShot{Req: "pabc1", JPEG: make([]byte, 9000), W: 100, H: 80, Lines: []lookLine{{Text: "Henesys", X: 1, Y: 2, W: 3, H: 4}}}); err != nil {
		t.Fatal(err)
	}
	if v := next(); v["kind"] != "look-meta" || v["parts"].(float64) != 2 {
		t.Fatalf("meta %v", v)
	}
	for i := 0; i < 2; i++ {
		if v := next(); v["kind"] != "look-part" || v["i"].(float64) != float64(i) {
			t.Fatalf("part %v", v)
		}
	}
	if err := d.sendLookFound("pabc1", []byte(`{"found":[]}`)); err != nil {
		t.Fatal(err)
	}
	if v := next(); v["kind"] != "look-found" || v["n"].(float64) != 1 {
		t.Fatalf("found %v", v)
	}
	// The Atlas button's views reach the window; unknown ones do not.
	if !d.show("quests") || d.show("evil") {
		t.Fatal("show: known views only")
	}
	if v := next(); v["kind"] != "show" || v["what"] != "quests" {
		t.Fatalf("show %v", v)
	}
	// Pins and the controls request become events, like the phone's.
	post(`{"kind":"pins","v":1,"pins":[]}`)
	post(`{"kind":"controls"}`)
	time.Sleep(50 * time.Millisecond)
	if ev.find("pins") == nil || ev.find("controls") == nil {
		t.Fatalf("events %v", ev.list)
	}
}
