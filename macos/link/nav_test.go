package main

import "testing"

func TestNavEvent(t *testing.T) {
	ok := `{"active":true,"map":"10001000","name":"Henesys","dest":"L Forest I","step":1,"steps":3,"live":true,"hint":"Head right, about 2 screens","target":{"kind":"portal","label":"Take the right-hand portal to The Hill East of Henesys.","x":6587,"y":1050}}`
	ev, good := navEvent([]byte(ok))
	if !good || ev["map"] != "10001000" || ev["target"].(map[string]any)["x"] != 6587 {
		t.Fatalf("valid nav refused: %v %v", good, ev)
	}
	npc := `{"active":true,"map":"10001000","step":2,"steps":2,"live":true,"target":{"kind":"npc","label":"Talk to Chief Stan","x":4166,"y":719}}`
	if ev, good := navEvent([]byte(npc)); !good || ev["target"].(map[string]any)["kind"] != "npc" || ev["target"].(map[string]any)["y"] != 719 {
		t.Fatalf("an NPC target was refused: %v %v", good, ev)
	}
	if ev, good := navEvent([]byte(`{"active":false}`)); !good || ev["active"] != false {
		t.Fatal("route end refused")
	}
	for _, bad := range []string{
		`{"active":true,"map":"abc","step":1,"steps":1,"target":{"kind":"arrived"}}`,
		`{"active":true,"map":"1","step":2,"steps":1,"target":{"kind":"arrived"}}`,
		`{"active":true,"map":"1","step":1,"steps":1,"target":{"kind":"portal"}}`,
		`{"active":true,"map":"1","step":1,"steps":1,"target":{"kind":"teleport","x":1,"y":1}}`,
		`{"active":true,"map":"1","step":1,"steps":1,"target":{"kind":"spot","x":-5,"y":1}}`,
		`not json`,
	} {
		if _, good := navEvent([]byte(bad)); good {
			t.Fatalf("malformed nav accepted: %s", bad)
		}
	}
	long := clip("a\u0007b"+string(make([]byte, 0)), 10)
	if long != "ab" {
		t.Fatalf("clip kept a control character: %q", long)
	}
}
