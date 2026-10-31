package main

import "testing"

func TestGameWindowRank(t *testing.T) {
	cases := []struct {
		title, exe string
		want       int
	}{
		{"MapleStory", `C:\Nexon\MapleStory\MapleStory.exe`, 2},
		{"MapleStory", "", 2},
		{"MapleStory Classic World", `D:\Games\MSCW\MapleStory.exe`, 1},
		{"MapleStory Launcher", `C:\Nexon\Launcher\ms-launcher.exe`, 0},
		{"MapleStory", `C:\Nexon\Launcher\ms-launcher.exe`, 0},
		{"MapleStory Classic World on Steam", `C:\Steam\steamwebhelper.exe`, 0},
		{"Maple Atlas — MapleStory map", `C:\Program Files\Microsoft\Edge\Application\msedge.exe`, 0},
		{"MapleStory wiki - Google Chrome", "", 0},
		{"Maple Atlas Companion", `C:\Program Files\Maple Atlas Companion\MapleAtlasCompanion.exe`, 0},
		{"Fake MapleStory", "", 1},
		{"Notepad", `C:\Windows\notepad.exe`, 0},
	}
	for _, c := range cases {
		if got := gameWindowRank(c.title, c.exe); got != c.want {
			t.Errorf("%q %q: got %d, want %d", c.title, c.exe, got, c.want)
		}
	}
}
