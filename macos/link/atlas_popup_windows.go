//go:build desktopui && windows

package main

// Ctrl+Alt+W: the Maple Atlas window pops up over the game (on top, most of the game's size),
// and the same shortcut puts it back where it was and returns to the game. The window is the
// Edge app window the app opened (window_windows.go); if it was closed, it opens again.

import (
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	hwndTopmost   = ^uintptr(0)     // HWND_TOPMOST (-1)
	hwndNoTopmost = ^uintptr(0) - 1 // HWND_NOTOPMOST (-2)
	swRestore     = 9
	swMinimize    = 6
)

var popup struct {
	mu     sync.Mutex
	url    string // the Maple Atlas address, to open it again
	dir    string // its Edge profile
	on     bool
	saved  winRect
	hwnd   uintptr
	game   uintptr
	iconic bool
}

// atlasWindowAt records where the window was opened (desktop.go).
func atlasWindowAt(url, dir string) {
	popup.mu.Lock()
	popup.url, popup.dir = url, dir
	popup.mu.Unlock()
}

// isAtlasTitle: an Edge or Chrome app window shows the page's own title ("Maple Atlas"); a
// browser tab adds " - Microsoft Edge", so it is not taken.
func isAtlasTitle(title, exe string) bool {
	base := strings.ToLower(filepath.Base(exe))
	return (title == "Maple Atlas" || strings.HasPrefix(title, "Maple Atlas ·")) && (base == "msedge.exe" || base == "chrome.exe" || exe == "")
}

func findAtlasWindow() uintptr {
	var found uintptr
	cb := syscall.NewCallback(func(h, _ uintptr) uintptr {
		if v, _, _ := pIsWindowVisible.Call(h); v == 0 {
			return 1
		}
		if isAtlasTitle(windowTitle(h), windowProgram(h)) {
			found = h
			return 0
		}
		return 1
	})
	pEnumWindows.Call(cb, 0)
	return found
}

func toggleAtlasPopup() {
	popup.mu.Lock()
	defer popup.mu.Unlock()
	if popup.on {
		popup.on = false
		h := popup.hwnd
		if v, _, _ := pIsWindow.Call(h); v != 0 {
			r := popup.saved
			pSetWindowPos.Call(h, hwndNoTopmost, uintptr(r.Left), uintptr(r.Top), uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top), swpNoActivate)
			if popup.iconic {
				pShowWindow.Call(h, swMinimize)
			}
		}
		if popup.game != 0 {
			pSetForegroundWindow.Call(popup.game)
		}
		gameLog("atlas: back behind the game")
		return
	}
	h := findAtlasWindow()
	if h == 0 {
		// Closed: open it again (it pops up on its own; the next Ctrl+Alt+W places it).
		if popup.url != "" {
			go openWindow(popup.url, popup.dir)
		}
		gameLog("atlas: window not open; opening it")
		return
	}
	game, _, _ := findGameWindow()
	var area winRect
	if game != 0 {
		pGetWindowRect.Call(game, uintptr(unsafe.Pointer(&area)))
	}
	if area.Right-area.Left < 400 || area.Bottom-area.Top < 300 {
		// No game window: the middle of the screen the window is on.
		pGetWindowRect.Call(h, uintptr(unsafe.Pointer(&area)))
	}
	iconic, _, _ := pIsIconic.Call(h)
	popup.iconic = iconic != 0
	if popup.iconic {
		pShowWindow.Call(h, swRestore)
	}
	pGetWindowRect.Call(h, uintptr(unsafe.Pointer(&popup.saved)))
	w, ht := (area.Right-area.Left)*86/100, (area.Bottom-area.Top)*86/100
	w, ht = max(w, 720), max(ht, 520)
	x, y := area.Left+(area.Right-area.Left-w)/2, area.Top+(area.Bottom-area.Top-ht)/2
	pSetWindowPos.Call(h, hwndTopmost, uintptr(x), uintptr(y), uintptr(w), uintptr(ht), swpShowWindow)
	// The hotkey gives this program the right to bring a window to the front.
	pSetForegroundWindow.Call(h)
	popup.on, popup.hwnd, popup.game = true, h, game
	gameLog("atlas: over the game (Ctrl+Alt+W again to hide)")
}
