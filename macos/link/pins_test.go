package main

import (
	"encoding/json"
	"testing"
)

func TestPinsEvent(t *testing.T) {
	commit := "a44f101bffa8272164ca47484ab18c078dcab0a0"
	raw := `[{"t":"Make a Slime & Pig Omok Set","r":false,"o":[` +
		`{"n":"Omok Table","h":1,"d":1,"i":"` + commit + `/data/current/images/items/04031049.png"},` +
		`{"n":"Pig","h":3,"d":20,"i":"` + commit + `/data/images/monsters/d8caace4e0f119f7a3f2b1fb450f7ed4.png"},` +
		`{"n":"Evil","h":0,"d":1,"i":"../../etc/passwd"},` +
		`{"n":"Other","h":null,"d":5,"i":"https://evil.example/x.png"}]}]`
	ev, ok := pinsEvent(json.RawMessage(raw))
	if !ok {
		t.Fatal("valid pins rejected")
	}
	b, _ := json.Marshal(ev)
	var out struct {
		Quests []struct {
			Title      string
			Objectives []struct {
				Name, Icon string
				Have, Need *int
			}
		}
	}
	json.Unmarshal(b, &out)
	o := out.Quests[0].Objectives
	if out.Quests[0].Title != "Make a Slime & Pig Omok Set" || len(o) != 4 {
		t.Fatalf("got %s", b)
	}
	if o[0].Icon != spriteBase+commit+"/data/current/images/items/04031049.png" || o[1].Icon == "" {
		t.Fatalf("icons not built: %s", b)
	}
	if o[2].Icon != "" || o[3].Icon != "" {
		t.Fatalf("a foreign icon path got through: %s", b)
	}
	if o[3].Have != nil || *o[0].Need != 1 {
		t.Fatalf("counts wrong: %s", b)
	}
	if _, ok := pinsEvent(json.RawMessage(`[{},{},{},{}]`)); ok {
		t.Fatal("more than 3 quests accepted")
	}
	if ev, ok := pinsEvent(json.RawMessage(`[]`)); !ok || len(ev["quests"].([]map[string]any)) != 0 {
		t.Fatal("no pins must clear the row")
	}
}

func TestPinsEventOres(t *testing.T) {
	commit := "a44f101bffa8272164ca47484ab18c078dcab0a0"
	raw := `[{"t":"Ores · The Hill East of Henesys","k":"ores","o":[{"n":"Iron Ore","h":null,"d":null,"i":"` + commit + `/data/current/images/items/04010001.png","m":"` + commit + `/data/images/monsters/d8caace4e0f119f7a3f2b1fb450f7ed4.png","p":2.898}]}]`
	ev, ok := pinsEvent(json.RawMessage(raw))
	if !ok {
		t.Fatal("ore pins rejected")
	}
	q := ev["quests"].([]map[string]any)[0]
	o := q["objectives"].([]map[string]any)[0]
	if q["kind"] != "ores" || o["chance"] != 2.898 || o["monster"] == "" || o["icon"] == "" {
		t.Fatalf("got %v", q)
	}
}
