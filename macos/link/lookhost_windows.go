//go:build desktopui && windows

package main

// Look's recognition on Windows: Microsoft Edge (part of Windows 10 and 11), started hidden
// (headless) with its own profile in the app's folder, opens the site's look-host.html (Look's
// own detector, namers and files, kept in that profile after the first download). The helper
// calls it over Chrome's DevTools protocol; the page reports progress through a binding
// (lookProgress). A box marked on the game is recognized here; the phone only shows results.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/websocket"
	"golang.org/x/sys/windows/registry"
)

// The site (for look-host.html) and the app's folder, set when the helper starts.
var lookSite, lookDir string

var lookEngine = &edgeLook{}

type edgeLook struct {
	mu       sync.Mutex // one start or look at a time
	wmu      sync.Mutex // writes to the socket
	cmd      *exec.Cmd
	ws       *websocket.Conn
	session  string
	next     int
	waits    map[int]chan cdpReply
	wait     sync.Mutex
	progress func(string)
	live     bool
}

type cdpReply struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type cdpMessage struct {
	ID        int             `json:"id"`
	Method    string          `json:"method"`
	SessionID string          `json:"sessionId"`
	Params    json.RawMessage `json:"params"`
	Result    json.RawMessage `json:"result"`
	Error     *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// edgePath finds msedge.exe: the App Paths entry, else its usual folders.
func edgePath() string {
	for _, root := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		if k, err := registry.OpenKey(root, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe`, registry.QUERY_VALUE); err == nil {
			p, _, err := k.GetStringValue("")
			k.Close()
			if err == nil && p != "" {
				if _, err := os.Stat(p); err == nil {
					return p
				}
			}
		}
	}
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		p := filepath.Join(os.Getenv(env), "Microsoft", "Edge", "Application", "msedge.exe")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// start opens Edge and the page; the caller holds e.mu.
func (e *edgeLook) start() error {
	e.stop()
	exe := edgePath()
	if exe == "" {
		return errors.New("Microsoft Edge was not found")
	}
	if lookSite == "" || lookDir == "" {
		return errors.New("not set up")
	}
	dir := filepath.Join(lookDir, "look-edge")
	os.MkdirAll(dir, 0o700)
	port := filepath.Join(dir, "DevToolsActivePort")
	os.Remove(port)
	cmd := exec.Command(exe, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
		"--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--remote-debugging-port=0", "--remote-allow-origins=*",
		"--user-data-dir="+dir, "about:blank")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Edge did not start: %w", err)
	}
	e.cmd = cmd
	var lines []string
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if b, err := os.ReadFile(port); err == nil {
			lines = strings.Split(strings.TrimSpace(string(b)), "\n")
			if len(lines) >= 2 {
				break
			}
		}
	}
	if len(lines) < 2 {
		e.stop()
		return errors.New("Edge did not open its port")
	}
	ws, err := websocket.Dial("ws://127.0.0.1:"+strings.TrimSpace(lines[0])+strings.TrimSpace(lines[1]), "", "http://127.0.0.1/")
	if err != nil {
		e.stop()
		return fmt.Errorf("Edge did not answer: %w", err)
	}
	ws.MaxPayloadBytes = 64 << 20
	e.ws, e.waits, e.live = ws, map[int]chan cdpReply{}, true
	go e.read(ws)
	var target struct {
		TargetID string `json:"targetId"`
	}
	if err := e.call("Target.createTarget", map[string]any{"url": lookSite + "look-host.html"}, "", &target); err != nil {
		e.stop()
		return err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := e.call("Target.attachToTarget", map[string]any{"targetId": target.TargetID, "flatten": true}, "", &attached); err != nil {
		e.stop()
		return err
	}
	e.session = attached.SessionID
	e.call("Runtime.enable", map[string]any{}, e.session, nil)
	e.call("Runtime.addBinding", map[string]any{"name": "lookProgress"}, e.session, nil)
	if _, err := e.evaluate(`(async()=>{for(let i=0;i<600&&!window.MapleLookHost;i++)await new Promise(r=>setTimeout(r,100));if(!window.MapleLookHost)throw new Error('Look did not start');await MapleLookHost.ready();return 'ok';})()`); err != nil {
		e.stop()
		return err
	}
	return nil
}

func (e *edgeLook) stop() {
	if e.ws != nil {
		e.ws.Close()
	}
	if e.cmd != nil && e.cmd.Process != nil {
		e.cmd.Process.Kill()
		e.cmd.Wait()
	}
	e.ws, e.cmd, e.live, e.session = nil, nil, false, ""
}

func (e *edgeLook) read(ws *websocket.Conn) {
	for {
		var m cdpMessage
		if err := websocket.JSON.Receive(ws, &m); err != nil {
			e.wait.Lock()
			for id, ch := range e.waits {
				ch <- cdpReply{Error: &struct {
					Message string `json:"message"`
				}{Message: "Edge closed"}}
				delete(e.waits, id)
			}
			e.wait.Unlock()
			return
		}
		if m.ID != 0 {
			e.wait.Lock()
			ch := e.waits[m.ID]
			delete(e.waits, m.ID)
			e.wait.Unlock()
			if ch != nil {
				ch <- cdpReply{Result: m.Result, Error: m.Error}
			}
			continue
		}
		if m.Method == "Runtime.bindingCalled" {
			var p struct {
				Name    string `json:"name"`
				Payload string `json:"payload"`
			}
			if json.Unmarshal(m.Params, &p) == nil && p.Name == "lookProgress" {
				var v struct {
					Progress string `json:"progress"`
				}
				if json.Unmarshal([]byte(p.Payload), &v) == nil && v.Progress != "" && e.progress != nil {
					e.progress(clip(v.Progress, 60))
				}
			}
		}
	}
}

func (e *edgeLook) call(method string, params any, session string, out any) error {
	e.wait.Lock()
	e.next++
	id := e.next
	ch := make(chan cdpReply, 1)
	e.waits[id] = ch
	e.wait.Unlock()
	msg := map[string]any{"id": id, "method": method, "params": params}
	if session != "" {
		msg["sessionId"] = session
	}
	e.wmu.Lock()
	err := websocket.JSON.Send(e.ws, msg)
	e.wmu.Unlock()
	if err != nil {
		return err
	}
	select {
	case r := <-ch:
		if r.Error != nil {
			return errors.New(r.Error.Message)
		}
		if out != nil {
			return json.Unmarshal(r.Result, out)
		}
		return nil
	case <-time.After(120 * time.Second):
		return errors.New("Edge took too long")
	}
}

// evaluate runs an expression in the page (awaiting a promise) and returns its string value.
func (e *edgeLook) evaluate(expr string) (string, error) {
	var r struct {
		Result struct {
			Value any `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text      string `json:"text"`
			Exception *struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	if err := e.call("Runtime.evaluate", map[string]any{"expression": expr, "awaitPromise": true, "returnByValue": true}, e.session, &r); err != nil {
		return "", err
	}
	if r.ExceptionDetails != nil {
		msg := r.ExceptionDetails.Text
		if r.ExceptionDetails.Exception != nil {
			msg = r.ExceptionDetails.Exception.Description
		}
		return "", errors.New(clip(msg, 120))
	}
	s, _ := r.Result.Value.(string)
	return s, nil
}

// analyze recognizes a screenshot (in mark, 0…1 of the window, or the whole window): the card
// for the overlay and what was found for the phone, as JSON.
func (e *edgeLook) analyze(shot lookShot, mark []float64, progress func(string)) (card, result json.RawMessage, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.progress = progress
	defer func() { e.progress = nil }()
	if !e.live || e.cmd == nil || e.cmd.ProcessState != nil {
		if progress != nil {
			progress("Getting Look ready…")
		}
		if err := e.start(); err != nil {
			return nil, nil, err
		}
	}
	lines := make([][]any, 0, len(shot.Lines))
	for _, l := range shot.Lines {
		lines = append(lines, []any{l.Text, l.X, l.Y, l.W, l.H})
	}
	args := map[string]any{"jpeg": base64.StdEncoding.EncodeToString(shot.JPEG), "lines": lines, "map": nil, "mark": nil}
	if shot.Map != "" {
		args["map"] = shot.Map
	}
	if len(mark) == 4 && !(mark[2] > .98 && mark[3] > .98) {
		args["mark"] = map[string]float64{"x": mark[0], "y": mark[1], "w": mark[2], "h": mark[3]}
	}
	b, _ := json.Marshal(args)
	out, err := e.evaluate("MapleLookHost.analyze(" + string(b) + ").then(r=>JSON.stringify(r))")
	if err != nil {
		if strings.Contains(err.Error(), "closed") {
			e.stop()
		}
		return nil, nil, err
	}
	var v struct {
		Card   json.RawMessage `json:"card"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil || len(v.Card) == 0 {
		return nil, nil, errors.New("Look gave no answer")
	}
	return v.Card, v.Result, nil
}

// lookSetup remembers the site and the app's folder and opens Look in the background, so the
// first look is quick.
func lookSetup(site, dir string) {
	lookSite, lookDir = site, dir
	lookWarm()
}

func lookWarm() {
	go func() {
		lookEngine.mu.Lock()
		defer lookEngine.mu.Unlock()
		if !lookEngine.live {
			if err := lookEngine.start(); err != nil {
				gameLog("look: %v", err)
			}
		}
	}()
}

func init() { lookCheck = lookSelfCheck }

// lookSelfCheck (--look-check): Look in a hidden Edge from the live site answers for a drawn
// picture (sky, ground, no game things): a card comes back, with its progress on the way.
func lookSelfCheck() int {
	dir, _ := os.MkdirTemp("", "look-check")
	lookSite, lookDir = "https://tal412.github.io/maple-atlas/", dir
	img := image.NewRGBA(image.Rect(0, 0, 1366, 768))
	for y := 0; y < 768; y++ {
		for x := 0; x < 1366; x++ {
			c := color.RGBA{uint8(90 + y/8), uint8(150 + y/12), 230, 255}
			if y > 600 {
				c = color.RGBA{110, 80, 40, 255}
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85})
	steps := 0
	start := time.Now()
	card, result, err := lookEngine.analyze(lookShot{Req: "c1", JPEG: buf.Bytes(), W: 1366, H: 768}, nil, func(t string) { steps++; fmt.Println("progress:", t) })
	if err != nil {
		fmt.Println("FAIL:", err)
		return 1
	}
	if _, ok := lookCard(card); !ok || len(result) < 2 {
		fmt.Println("FAIL: no card:", string(card))
		return 1
	}
	fmt.Printf("PASS: Look answered in %s (%d progress lines): %s\n", time.Since(start).Round(time.Millisecond), steps, string(card))
	lookEngine.mu.Lock()
	lookEngine.stop()
	lookEngine.mu.Unlock()
	return 0
}
