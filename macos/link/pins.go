package main

import (
	"encoding/json"
	"regexp"
)

// spriteBase is where quest icons come from (the datamine CDN the phone uses); the phone
// sends only the part after it, and only these shapes are accepted, so a message can never
// make the computer fetch anything else.
const spriteBase = "https://cdn.jsdelivr.net/gh/ohmi69/osms_datamine_dashboard@"

var spritePath = regexp.MustCompile(`^[0-9a-f]{40}/data/(current/images/(items|npcs)/\d{7,8}|images/monsters/[0-9a-f]{32})\.png$`)

// pinsEvent turns the phone's pinned quests into a "pins" event for the app's overlay row, or
// reports them malformed. At most 3 quests of 6 objectives; text cut short; counts small.
func pinsEvent(raw json.RawMessage) (map[string]any, bool) {
	var in []struct {
		T string `json:"t"`
		R bool   `json:"r"`
		O []struct {
			N string `json:"n"`
			H *int   `json:"h"`
			D *int   `json:"d"`
			I string `json:"i"`
		} `json:"o"`
	}
	if len(raw) == 0 || len(raw) > 8192 || json.Unmarshal(raw, &in) != nil || len(in) > 3 {
		return nil, false
	}
	count := func(v *int) any {
		if v == nil || *v < 0 || *v > 99999 {
			return nil
		}
		return *v
	}
	quests := []map[string]any{}
	for _, q := range in {
		if len(q.O) > 6 {
			return nil, false
		}
		objectives := []map[string]any{}
		for _, o := range q.O {
			icon := ""
			if spritePath.MatchString(o.I) {
				icon = spriteBase + o.I
			}
			objectives = append(objectives, map[string]any{"name": clip(o.N, 40), "have": count(o.H), "need": count(o.D), "icon": icon})
		}
		quests = append(quests, map[string]any{"title": clip(q.T, 60), "ready": q.R, "objectives": objectives})
	}
	return map[string]any{"event": "pins", "quests": quests}, true
}
