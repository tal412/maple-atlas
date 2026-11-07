//go:build desktopui && windows

package main

// The Atlas menu: Ctrl+Alt+M pops a menu up over the game's middle with what is useful in
// play: Maple Atlas over the game, search, your quests, directions, Look, and the on-game
// navigation, so the game never has to be left. Its owner is a hidden window of the overlay.

import (
	"sync"
	"time"
	"unsafe"
)

var (
	pCreatePopupMenu = user32.NewProc("CreatePopupMenu")
	pAppendMenuW     = user32.NewProc("AppendMenuW")
	pTrackPopupMenu  = user32.NewProc("TrackPopupMenu")
	pDestroyMenu     = user32.NewProc("DestroyMenu")
	pPostMessageW    = user32.NewProc("PostMessageW")
)

const (
	mfString     = 0x0000
	mfGrayed     = 0x0001
	mfChecked    = 0x0008
	mfSeparator  = 0x0800
	tpmReturnCmd = 0x0100
	tpmCenterAlign  = 0x0004
	tpmVCenterAlign = 0x0010
)

// atlasDesk is the Maple Atlas window's link (set by desktop.go), for the menu's views.
var atlasDesk *desk

func setAtlasDesk(d *desk) { atlasDesk = d }

// button holds the menu's owner window.
var button struct {
	mu   sync.Mutex
	hwnd uintptr
}

// overlayButton is kept for older controls pages (the on-game button is gone).
func overlayButton(on bool) {}

// menuReady makes the menu's hidden owner window on the overlay's thread (from lookReady).
func menuReady() {
	class := utf16("MapleAtlasOverlay")
	h, _, _ := pCreateWindowExW.Call(wsExToolWindow|wsExNoActivate, uintptr(unsafe.Pointer(class)),
		uintptr(unsafe.Pointer(utf16("Maple Atlas menu"))), wsPopup, 0, 0, 1, 1, 0, 0, 0, 0)
	button.mu.Lock()
	button.hwnd = h
	button.mu.Unlock()
}

// openMenu shows the menu over the game's middle (Ctrl+Alt+M).
func openMenu() {
	button.mu.Lock()
	h := button.hwnd
	button.mu.Unlock()
	if h != 0 {
		buttonMenu(h)
	}
}

// The menu's commands.
const (
	cmdAtlas = 10 + iota
	cmdSearch
	cmdQuests
	cmdDirections
	cmdLook
	cmdAround
	cmdMark
	cmdNav
	cmdControls
)

func buttonMenu(h uintptr) {
	popup.mu.Lock()
	over := popup.on
	popup.mu.Unlock()
	overlay.mu.Lock()
	navOn := overlay.on
	overlay.mu.Unlock()
	m, _, _ := pCreatePopupMenu.Call()
	if m == 0 {
		return
	}
	defer pDestroyMenu.Call(m)
	add := func(flags uintptr, id int, text string) {
		pAppendMenuW.Call(m, flags, uintptr(id), uintptr(unsafe.Pointer(utf16(text))))
	}
	add(mfString|mfGrayed, 1, "Maple Atlas\tCtrl+Alt+M")
	if over {
		add(mfString, cmdAtlas, "Back to the game\tCtrl+Alt+W")
	} else {
		add(mfString, cmdAtlas, "Maple Atlas over the game\tCtrl+Alt+W")
	}
	add(mfString, cmdSearch, "Search…")
	add(mfString, cmdQuests, "Your quests")
	add(mfString, cmdDirections, "Directions")
	add(mfString, cmdLook, "Look: picture and list")
	add(mfSeparator, 0, "")
	add(mfString, cmdAround, "Look around me\tCtrl+Alt+A")
	add(mfString, cmdMark, "Mark a box to look at")
	add(mfSeparator, 0, "")
	nav := uintptr(mfString)
	if navOn {
		nav |= mfChecked
	}
	add(nav, cmdNav, "Navigation and pins on the game")
	add(mfString, cmdControls, "Game window & phone…")
	// Over the game's middle (else where the pointer is).
	var x, y int32
	if c, ok := gameClient(); ok {
		x, y = (c.Left+c.Right)/2, (c.Top+c.Bottom)/2
	} else {
		var pt winPoint
		pGetCursorPosWin.Call(uintptr(unsafe.Pointer(&pt)))
		x, y = pt.X, pt.Y
	}
	// The menu needs the foreground; the hotkey gives this program that right.
	pSetForegroundWindow.Call(h)
	id, _, _ := pTrackPopupMenu.Call(m, tpmReturnCmd|tpmCenterAlign|tpmVCenterAlign, uintptr(x), uintptr(y), 0, h, 0)
	pPostMessageW.Call(h, 0, 0, 0) // WM_NULL: lets the menu close properly
	switch int(id) {
	case cmdAtlas:
		toggleAtlasPopup()
	case cmdSearch:
		showInAtlas("search")
	case cmdQuests:
		showInAtlas("quests")
	case cmdDirections:
		showInAtlas("directions")
	case cmdLook:
		showInAtlas("look")
	case cmdControls:
		showInAtlas("controls")
	case cmdAround:
		look.lookAll()
	case cmdMark:
		look.beginMark()
	case cmdNav:
		overlayEnabled(!navOn)
		// The controls page keeps the setting (its checkbox follows).
		if atlasDesk != nil {
			go atlasDesk.emit(map[string]any{"event": "overlay", "on": !navOn})
		}
	}
	if int(id) != cmdAtlas && int(id) != cmdNav && int(id) != 0 {
		gameLog("atlas button: %d", id)
	}
}

// showInAtlas brings Maple Atlas over the game and opens a view in it.
func showInAtlas(what string) {
	popup.mu.Lock()
	over := popup.on
	popup.mu.Unlock()
	if !over {
		toggleAtlasPopup()
	}
	d := atlasDesk
	if d == nil {
		return
	}
	go func() {
		// A window that was closed opens again first: wait for it to link.
		for i := 0; i < 60 && !d.open(); i++ {
			time.Sleep(250 * time.Millisecond)
		}
		d.show(what)
	}()
}
