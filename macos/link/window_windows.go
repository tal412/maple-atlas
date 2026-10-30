//go:build desktopui && windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

// openWindow opens the companion page as its own app window in Edge (installed on
// Windows 10/11) or Chrome. A separate profile lets the flags apply: background
// timers keep running while the game window is in front.
func openWindow(url, profile string) error {
	if os.Getenv("MAPLE_LINK_NO_WINDOW") != "" { // automated checks drive the page's API directly
		os.Stdout.WriteString("page: " + url + "\n")
		return nil
	}
	var candidates []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
		if base := os.Getenv(env); base != "" {
			candidates = append(candidates,
				filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
				filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
		}
	}
	for _, path := range candidates {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		cmd := exec.Command(path, appWindowArgs(url, profile)...)
		if err := cmd.Start(); err == nil {
			return nil
		}
	}
	// Last resort: the default browser (background slowing may then apply).
	if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start(); err != nil {
		return errors.New("no browser found")
	}
	return nil
}

func appWindowArgs(url, profile string) []string {
	return []string{"--app=" + url, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
		"--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
		"--window-size=560,920"}
}

// fatal shows a message box (the app has no console) and exits.
func fatal(message string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	box := user32.NewProc("MessageBoxW")
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("Maple Atlas Companion")
	box.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
	os.Exit(1)
}
