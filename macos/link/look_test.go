package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLookCard(t *testing.T) {
	icon := "a44f101bffa8272164ca47484ab18c078dcab0a0/data/images/monsters/7e55e8ffa6e2ee9e8ebc23ff8516ffd6.png"
	raw, _ := json.Marshal(map[string]any{"title": "In the box", "note": "On The Forest East of Henesys", "items": []map[string]any{
		{"t": "monster", "n": "Blue Mushroom", "i": icon, "d": "Lv 19 · 342 HP", "e": "Drops Blue Mushroom Cap 47%", "c": 2},
		{"t": "item", "n": "Snail Shell", "i": "https://evil.example/x.png", "d": "Etc", "c": 1},
	}})
	card, ok := lookCard(raw)
	if !ok {
		t.Fatal("a valid card was refused")
	}
	items := card["items"].([]map[string]any)
	if items[0]["icon"] != spriteBase+icon || items[0]["count"] != 2 || items[0]["name"] != "Blue Mushroom" {
		t.Fatalf("first item: %v", items[0])
	}
	if items[1]["icon"] != "" {
		t.Fatal("an icon from anywhere else must be dropped")
	}
	bad, _ := json.Marshal(map[string]any{"items": []map[string]any{{"t": "script", "n": "x"}}})
	if _, ok := lookCard(bad); ok {
		t.Fatal("an unknown type must be refused")
	}
	many := make([]map[string]any, 41)
	for i := range many {
		many[i] = map[string]any{"t": "npc", "n": "x"}
	}
	tooMany, _ := json.Marshal(map[string]any{"items": many})
	if _, ok := lookCard(tooMany); ok {
		t.Fatal("more than 40 things must be refused")
	}
	if c, ok := lookCard(mustJSON(map[string]any{"items": many[:40]})); !ok || len(c["items"].([]map[string]any)) != 40 {
		t.Fatal("40 things fit")
	}
	priced, _ := lookCard(mustJSON(map[string]any{"items": []map[string]any{{"t": "item", "n": "Toga", "p": "≈ 22,167 mesos"}}}))
	if priced["items"].([]map[string]any)[0]["price"] != "≈ 22,167 mesos" {
		t.Fatal("the price is kept")
	}
	long, _ := json.Marshal(map[string]any{"title": strings.Repeat("a", 500), "items": []any{}})
	if c, ok := lookCard(long); !ok || len([]rune(c["title"].(string))) > 61 {
		t.Fatal("a long title is cut short")
	}
	if !lookReq.MatchString("p1a2") || !lookReq.MatchString("c12") || lookReq.MatchString("x1") || lookReq.MatchString("p") {
		t.Fatal("request names")
	}
}

func TestSendLookRefusesBadShots(t *testing.T) {
	s := &session{}
	for _, shot := range []lookShot{{Req: "bad", JPEG: []byte{1}, W: 100, H: 100}, {Req: "p1", W: 100, H: 100}, {Req: "p1", JPEG: []byte{1}, W: 5, H: 100}} {
		if s.sendLook(shot) == nil {
			t.Fatalf("accepted %+v", shot.Req)
		}
	}
	if s.sendLook(lookShot{Req: "p1", JPEG: []byte{1, 2}, W: 100, H: 100}) == nil {
		t.Fatal("sent without a connected phone")
	}
}

func TestLookProgressText(t *testing.T) {
	if got, ok := lookProgressText("Naming 3 of 12…"); !ok || got != "Naming 3 of 12…" {
		t.Fatalf("plain line: %q %v", got, ok)
	}
	for _, bad := range []string{"", "two\nlines", "bell\x07", strings.Repeat("x", 300)} {
		if _, ok := lookProgressText(bad); ok {
			t.Fatalf("accepted %q", bad)
		}
	}
	if got, _ := lookProgressText(strings.Repeat("a", 100)); len([]rune(got)) > 61 {
		t.Fatalf("not clipped: %d", len([]rune(got)))
	}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
