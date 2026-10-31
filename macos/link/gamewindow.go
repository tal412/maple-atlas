package main

import (
	"path/filepath"
	"strings"
)

// gameWindowRank says whether a window is the game itself and how sure that is: 0 = not the
// game; 2 = the game's own window (titled exactly "MapleStory"); 1 = another MapleStory
// window of a non-excluded program. The launcher, Steam, browsers (a page about MapleStory,
// or the Maple Atlas site) and Maple Atlas itself are never the game. exe: the program's
// file name or path ("" when unknown).
func gameWindowRank(title, exe string) int {
	t := strings.ToLower(strings.TrimSpace(title))
	e := strings.ToLower(filepath.Base(strings.ReplaceAll(exe, `\`, "/")))
	for _, bad := range []string{"launcher", "atlas", "steam", "installer", "setup", "patcher", "updater"} {
		if strings.Contains(t, bad) || strings.Contains(e, bad) {
			return 0
		}
	}
	switch e {
	case "msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "iexplore.exe", "arc.exe", "explorer.exe", "mapleatlascompanion.exe", "discord.exe":
		return 0
	}
	if !strings.Contains(t, "maplestory") {
		return 0
	}
	// A browser window's title ends with its own name ("MapleStory - Google Chrome").
	for _, browser := range []string{" - google chrome", " - microsoft edge", " - mozilla firefox", " - brave", " - opera", "— mozilla firefox"} {
		if strings.Contains(t, browser) {
			return 0
		}
	}
	if t == "maplestory" {
		return 2
	}
	return 1
}
