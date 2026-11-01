package main

// The Look feature's link messages: the phone asks for a screenshot of the game window, the
// computer sends it (a JPEG, in parts, with the text its system reader found on it), the phone
// finds what in it is in the database and, when the look was marked on the computer, sends a
// small result card back for the overlay on the game.
//
//	phone → computer  {kind:"look", v:1, req:"p…"}                      ask for a screenshot
//	computer → phone  {kind:"look-meta", v:1, req, w, h, parts, bytes, mark, lines}
//	                  {kind:"look-part", v:1, req, i, data}             base64 JPEG pieces
//	phone → computer  {kind:"look-result", v:1, req:"c…", card}         for a look marked here
//	phone → computer  {kind:"look-progress", v:1, req:"c…", text}       how that look is going
//	computer → phone  {kind:"look-progress", v:1, req:"p…", text}       how this computer's look goes
//	computer → phone  {kind:"look-found", v:1, req:"p…", i, n, data}   what it found (base64 JSON, in parts)
//
// Requests from the phone start with "p", looks marked on the computer with "c".

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

var lookReq = regexp.MustCompile(`^[pc][0-9a-z]{1,16}$`)

const (
	lookPart     = 6000    // base64 characters per part (the phone takes messages up to 8 KB)
	lookMaxBytes = 3 << 20 // largest screenshot sent
	lookMetaMax  = 7800    // the meta message, lines included
	lookBuffered = 1 << 20 // pause sending while this much is still queued
	lookTimeout  = 20 * time.Second
)

// lookLine is one line of text read on the screenshot, in its pixels.
type lookLine struct {
	Text       string
	X, Y, W, H float64
}

// lookShot is one screenshot for the phone. Mark: the box marked on the computer (0…1 of the
// shot), nil when the phone asked.
type lookShot struct {
	Req   string
	JPEG  []byte
	W, H  int
	Lines []lookLine
	Mark  []float64
	// Map: the map read from the minimap, when known.
	Map string
}

// lookRequested handles a screenshot request on Windows, where the helper captures the game
// itself (set by look_windows.go); nil on the Mac, where the app does it.
var lookRequested func(s *session, req string)

// sendLook sends a screenshot to the live phone, in parts. It waits while the link is busy,
// so the position and quest messages keep flowing between parts.
func (s *session) sendLook(shot lookShot) error {
	if !lookReq.MatchString(shot.Req) || len(shot.JPEG) == 0 || len(shot.JPEG) > lookMaxBytes || shot.W < 16 || shot.H < 16 || shot.W > 4096 || shot.H > 4096 {
		return errors.New("bad screenshot")
	}
	s.mu.Lock()
	l := s.cur
	ok := l != nil && l.verified && s.phase == "connected" && !l.dead && l.dc != nil
	s.mu.Unlock()
	if !ok {
		return errors.New("the phone is not connected")
	}
	data := base64.StdEncoding.EncodeToString(shot.JPEG)
	parts := (len(data) + lookPart - 1) / lookPart
	lines := make([][]any, 0, len(shot.Lines))
	for _, ln := range shot.Lines {
		t := strings.TrimSpace(ln.Text)
		if t == "" {
			continue
		}
		lines = append(lines, []any{clip(t, 60), int(ln.X), int(ln.Y), int(ln.W), int(ln.H)})
	}
	var mark any
	if len(shot.Mark) == 4 {
		mark = shot.Mark
	}
	meta := map[string]any{"kind": "look-meta", "v": 1, "session": s.id, "req": shot.Req, "w": shot.W, "h": shot.H, "parts": parts, "bytes": len(shot.JPEG), "mark": mark, "map": shot.Map}
	// As many lines as fit in one message.
	for {
		meta["lines"] = lines
		b, _ := json.Marshal(meta)
		if len(b) <= lookMetaMax || len(lines) == 0 {
			break
		}
		lines = lines[:len(lines)*9/10]
	}
	send := func(v map[string]any) error {
		deadline := time.Now().Add(lookTimeout)
		for l.dc.BufferedAmount() > lookBuffered {
			if time.Now().After(deadline) || l.dc.ReadyState() != webrtc.DataChannelStateOpen {
				return errors.New("the link stalled")
			}
			time.Sleep(10 * time.Millisecond)
		}
		b, _ := json.Marshal(v)
		return l.dc.SendText(string(b))
	}
	if err := send(meta); err != nil {
		return err
	}
	for i := 0; i < parts; i++ {
		end := (i + 1) * lookPart
		if end > len(data) {
			end = len(data)
		}
		if err := send(map[string]any{"kind": "look-part", "v": 1, "session": s.id, "req": shot.Req, "i": i, "data": data[i*lookPart : end]}); err != nil {
			return err
		}
	}
	return nil
}

// lookFoundMax is the largest result sent for the phone's Look (what the computer found).
const lookFoundMax = 512 << 10

// sendLookFound sends what this computer found in its screenshot for the phone's Look (a JSON
// object: each thing with its box), base64 in parts {kind:"look-found", req, i, n, data}.
func (s *session) sendLookFound(req string, raw []byte) error {
	if !lookReq.MatchString(req) || !strings.HasPrefix(req, "p") || len(raw) < 2 || len(raw) > lookFoundMax || raw[0] != '{' || !json.Valid(raw) {
		return errors.New("bad result")
	}
	s.mu.Lock()
	l := s.cur
	ok := l != nil && l.verified && s.phase == "connected" && !l.dead && l.dc != nil
	s.mu.Unlock()
	if !ok {
		return errors.New("the phone is not connected")
	}
	data := base64.StdEncoding.EncodeToString(raw)
	parts := (len(data) + lookPart - 1) / lookPart
	for i := 0; i < parts; i++ {
		deadline := time.Now().Add(lookTimeout)
		for l.dc.BufferedAmount() > lookBuffered {
			if time.Now().After(deadline) || l.dc.ReadyState() != webrtc.DataChannelStateOpen {
				return errors.New("the link stalled")
			}
			time.Sleep(10 * time.Millisecond)
		}
		end := min((i+1)*lookPart, len(data))
		b, _ := json.Marshal(map[string]any{"kind": "look-found", "v": 1, "session": s.id, "req": req, "i": i, "n": parts, "data": data[i*lookPart : end]})
		if err := l.dc.SendText(string(b)); err != nil {
			return err
		}
	}
	return nil
}

// sendLookProgress tells the phone how this computer's look is going ("Naming 3 of 12…").
func (s *session) sendLookProgress(req, text string) {
	t, ok := lookProgressText(text)
	if !ok || !lookReq.MatchString(req) || !strings.HasPrefix(req, "p") {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != nil && s.cur.verified {
		s.sendLocked(s.cur, map[string]any{"kind": "look-progress", "v": 1, "session": s.id, "req": req, "text": t})
	}
}

// sendLookError tells the phone a screenshot could not be taken, so it stops waiting.
func (s *session) sendLookError(req, msg string) {
	if !lookReq.MatchString(req) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != nil && s.cur.verified {
		s.sendLocked(s.cur, map[string]any{"kind": "look-error", "v": 1, "session": s.id, "req": req, "message": clip(msg, 160)})
	}
}

// lookProgressText checks the phone's progress line for a look marked here: one short line of
// plain text (no control characters), at most 60 characters.
func lookProgressText(s string) (string, bool) {
	if s == "" || len(s) > 240 {
		return "", false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return "", false
		}
	}
	return clip(s, 60), true
}

// lookCard checks the phone's result card for a look marked on the computer, field by field:
// a title and at most 6 things, each a type, a name, an icon from the datamine CDN (spritePath)
// and two short lines of detail.
func lookCard(raw json.RawMessage) (map[string]any, bool) {
	var in struct {
		Title string `json:"title"`
		Note  string `json:"note"`
		Items []struct {
			T string `json:"t"`
			N string `json:"n"`
			I string `json:"i"`
			D string `json:"d"`
			E string `json:"e"`
			C int    `json:"c"`
			P string `json:"p"`
		} `json:"items"`
	}
	if len(raw) == 0 || len(raw) > 6000 || json.Unmarshal(raw, &in) != nil || len(in.Items) > 6 {
		return nil, false
	}
	items := []map[string]any{}
	for _, it := range in.Items {
		switch it.T {
		case "monster", "npc", "item", "quest", "map":
		default:
			return nil, false
		}
		icon := ""
		if spritePath.MatchString(it.I) {
			icon = spriteBase + it.I
		}
		count := it.C
		if count < 0 || count > 99 {
			count = 0
		}
		items = append(items, map[string]any{"type": it.T, "name": clip(it.N, 50), "icon": icon, "detail": clip(it.D, 90), "extra": clip(it.E, 90), "count": count, "price": clip(it.P, 40)})
	}
	return map[string]any{"title": clip(in.Title, 60), "note": clip(in.Note, 90), "items": items}, true
}
