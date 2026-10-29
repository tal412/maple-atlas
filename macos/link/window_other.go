//go:build desktopui && !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

// openWindow is for running the desktop mode on a Mac or Linux during development.
func openWindow(url, profile string) error {
	if os.Getenv("MAPLE_LINK_NO_WINDOW") != "" { // headless page tests
		fmt.Println("page:", url)
		return nil
	}
	if runtime.GOOS == "darwin" {
		chrome := "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		if _, err := os.Stat(chrome); err == nil {
			return exec.Command(chrome, "--app="+url, "--user-data-dir="+profile, "--no-first-run", "--no-default-browser-check",
				"--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows").Start()
		}
		return exec.Command("open", url).Start()
	}
	return exec.Command("xdg-open", url).Start()
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
