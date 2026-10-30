//go:build desktopui && windows

package main

import (
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// firewallEvents: the latest entries of Windows Firewall's own log that matter here, read
// with wevtutil (Windows' event tool): 2011 says which program, port and protocol it
// blocked an incoming connection for, 2004/2006 which rules were added or removed.
func firewallEvents() string {
	cmd := exec.Command("wevtutil", "qe", "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall",
		"/q:*[System[(EventID=2011 or EventID=2004 or EventID=2006)]]", "/c:12", "/rd:true", "/f:text")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	done := make(chan struct{})
	var out []byte
	var err error
	go func() { out, err = cmd.CombinedOutput(); close(done) }()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		cmd.Process.Kill()
		return "(wevtutil did not answer in time)"
	}
	text := strings.TrimSpace(string(out))
	if err != nil {
		return "(could not read: " + err.Error() + " " + text + ")"
	}
	// Keep only the useful lines of each event.
	var keep []string
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimRight(l, "\r")
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "Date:") || strings.HasPrefix(t, "Event ID:") || strings.HasPrefix(t, "Description:") || strings.HasPrefix(t, "Application Path:") ||
			strings.HasPrefix(t, "Port:") || strings.HasPrefix(t, "Protocol:") || strings.HasPrefix(t, "Profile") || strings.HasPrefix(t, "Rule Name:") || strings.HasPrefix(t, "Action:") || strings.HasPrefix(t, "Direction:") {
			keep = append(keep, "  "+t)
		}
	}
	if len(keep) == 0 {
		return "  (none)"
	}
	return strings.Join(keep, "\n")
}
