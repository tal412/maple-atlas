//go:build desktopui

package main

// A plain-text report for whoever is helping a player ("Copy diagnostics" in the window):
// version, system, phone link, firewall, game window, text recognition and the recent log.
// The pairing code and link are never included: they let a phone pair with this PC.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var secretPattern = regexp.MustCompile(`("code"\s*:\s*")[^"]*(")|(#link=)[A-Za-z0-9_-]+|("link"\s*:\s*")[^"]*(")`)

func scrubSecrets(s string) string {
	return secretPattern.ReplaceAllStringFunc(s, func(m string) string {
		switch {
		case strings.HasPrefix(m, "#link="):
			return "#link=(hidden)"
		case strings.Contains(m, `"code"`):
			return `"code":"(hidden)"`
		default:
			return `"link":"(hidden)"`
		}
	})
}

func diagnosticsText(stateDir string, h *hub) string {
	var b strings.Builder
	line := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }
	line("Maple Atlas Companion %s · %s · %s/%s", version, osVersion(), runtime.GOOS, runtime.GOARCH)
	line("Report made %s", time.Now().Format(time.RFC3339))
	h.mu.Lock()
	state, pairing, contact := h.state, h.pairing, h.contact
	h.mu.Unlock()
	if state != nil {
		line("Phone link: %s", scrubSecrets(string(state)))
	}
	if contact != nil {
		line("Phone reached this computer: %s", contact)
	} else {
		line("Phone reached this computer: never (no packet from a phone holding this code arrived; a firewall or a different network keeps them out)")
	}
	var p struct {
		Addresses []string `json:"addresses"`
		Event     string   `json:"event"`
	}
	if pairing != nil && json.Unmarshal(pairing, &p) == nil {
		line("Pairing: %s · this PC: %s", p.Event, strings.Join(p.Addresses, ", "))
	}
	fw, _ := json.MarshalIndent(firewallStatus(), "", "  ")
	line("Firewall: %s", fw)
	if r, err := os.ReadFile(filepath.Join(stateDir, "firewall-repair.json")); err == nil {
		line("Last firewall repair: %s", r)
	}
	game.mu.Lock()
	title, gerr := game.title, game.err
	game.mu.Unlock()
	line("Game window: %q %s", title, gerr)
	if events := firewallEvents(); events != "" {
		line("Windows Firewall events (2011 = it blocked an app's incoming connection; 2004/2006 = rule added/removed):")
		line("%s", events)
	}
	line("Text recognition: %s", ocrStatus())
	line("")
	line("Recent log:")
	if raw, err := os.ReadFile(filepath.Join(stateDir, "companion.log")); err == nil {
		lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
		if len(lines) > 250 {
			lines = lines[len(lines)-250:]
		}
		b.WriteString(scrubSecrets(strings.Join(lines, "\n")))
		b.WriteString("\n")
	}
	return b.String()
}

// openLog keeps the log across launches (a player reopening the app must not wipe what
// went wrong), starting a fresh file once it passes 2 MB.
func openLog(stateDir string) *os.File {
	path := filepath.Join(stateDir, "companion.log")
	if st, err := os.Stat(path); err == nil && st.Size() > 2<<20 {
		os.Rename(path, filepath.Join(stateDir, "companion.old.log"))
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil
	}
	fmt.Fprintf(f, "\n---- Maple Atlas Companion %s started %s ----\n", version, time.Now().Format(time.RFC3339))
	return f
}
