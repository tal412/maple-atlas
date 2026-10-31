package main

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// navEvent turns the phone's navigation state into an "nav" event for the app, or reports
// it malformed. Every field is bounded: text is cut to a short length, numbers must be
// small non-negative integers, and the target kind is one of three.
func navEvent(raw json.RawMessage) (map[string]any, bool) {
	var n struct {
		Active bool   `json:"active"`
		Map    string `json:"map"`
		Name   string `json:"name"`
		Dest   string `json:"dest"`
		Step   int    `json:"step"`
		Steps  int    `json:"steps"`
		Live   bool   `json:"live"`
		Hint   string `json:"hint"`
		Target *struct {
			Kind  string   `json:"kind"`
			Label string   `json:"label"`
			X     *float64 `json:"x"`
			Y     *float64 `json:"y"`
		} `json:"target"`
	}
	if len(raw) == 0 || len(raw) > 4096 || json.Unmarshal(raw, &n) != nil {
		return nil, false
	}
	if !n.Active {
		return map[string]any{"event": "nav", "active": false}, true
	}
	if !digits(n.Map, 12) || n.Step < 1 || n.Steps < n.Step || n.Steps > 200 || n.Target == nil {
		return nil, false
	}
	target := map[string]any{"kind": n.Target.Kind, "label": clip(n.Target.Label, 160)}
	switch n.Target.Kind {
	case "portal", "spot", "npc":
		if n.Target.X == nil || n.Target.Y == nil || *n.Target.X < 0 || *n.Target.Y < 0 || *n.Target.X > 100000 || *n.Target.Y > 100000 {
			return nil, false
		}
		target["x"], target["y"] = int(*n.Target.X), int(*n.Target.Y)
	case "arrived":
	default:
		return nil, false
	}
	return map[string]any{"event": "nav", "active": true, "map": n.Map, "name": clip(n.Name, 80), "dest": clip(n.Dest, 80),
		"step": n.Step, "steps": n.Steps, "live": n.Live, "hint": clip(n.Hint, 120), "target": target}, true
}

func digits(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// clip keeps at most n runes and drops control characters.
func clip(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if utf8.RuneCountInString(s) > n {
		s = string([]rune(s)[:n])
	}
	return strings.TrimSpace(s)
}
