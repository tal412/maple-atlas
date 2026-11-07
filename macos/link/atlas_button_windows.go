//go:build desktopui && windows

package main

// The Atlas button: a small round button on the game window's bottom-left corner (the free
// space left of the chat bar) while the game is in front. A click opens a menu with what is
// useful in play: Maple Atlas over the game, search, your quests, directions, Look, and the
// on-game navigation, so the game never has to be left.

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
	pLoadCursorW     = user32.NewProc("LoadCursorW")
	pSetCursor       = user32.NewProc("SetCursor")
)

const (
	mfString     = 0x0000
	mfGrayed     = 0x0001
	mfChecked    = 0x0008
	mfSeparator  = 0x0800
	tpmReturnCmd = 0x0100
	tpmBottom    = 0x0020 // the menu's bottom at the point: it opens upward
	wmSetCursor  = 0x0020
	idcHand      = 32649
	buttonSize   = 40 // at 96 dpi
)

// atlasDesk is the Maple Atlas window's link (set by desktop.go), for the menu's views.
var atlasDesk *desk

func setAtlasDesk(d *desk) { atlasDesk = d }

var button struct {
	mu    sync.Mutex
	on    bool
	hwnd  uintptr
	shown bool
	emit  func(map[string]any)
}

func init() { button.on = true }

// overlayButton turns the button on or off (the controls page's setting).
func overlayButton(on bool) {
	button.mu.Lock()
	button.on = on
	button.mu.Unlock()
}

// buttonReady makes the button on the overlay's thread (called from lookReady).
func buttonReady() {
	class := utf16("MapleAtlasOverlay")
	h, _, _ := pCreateWindowExW.Call(wsExLayered|wsExTopmost|wsExToolWindow|wsExNoActivate, uintptr(unsafe.Pointer(class)),
		uintptr(unsafe.Pointer(utf16("Maple Atlas button"))), wsPopup, 0, 0, buttonSize, buttonSize, 0, 0, 0, 0)
	if h == 0 {
		return
	}
	pSetLayeredWindowAttributes.Call(h, keyColor, 235, lwaColorKey|lwaAlpha)
	pSetTimer.Call(h, 3, 300, 0)
	button.mu.Lock()
	button.hwnd = h
	button.mu.Unlock()
}

// gameHwnd is the game's window: the one being tracked, else the MapleStory window found.
func gameHwnd() uintptr {
	overlay.mu.Lock()
	g := overlay.gameWindow()
	overlay.mu.Unlock()
	if g == 0 {
		g, _, _ = findGameWindow()
	}
	return g
}

// placeButton keeps the button on the game's bottom-left corner while the game (or the button,
// its menu, or Maple Atlas over the game) is in front; otherwise it hides it.
func placeButton(h uintptr) {
	button.mu.Lock()
	on := button.on
	button.mu.Unlock()
	game := gameHwnd()
	visible := on && game != 0
	var c winRect
	if visible {
		iconic, _, _ := pIsIconic.Call(game)
		front, _, _ := pGetForegroundWindow.Call()
		popup.mu.Lock()
		over := popup.on && front == popup.hwnd
		popup.mu.Unlock()
		var ok bool
		c, ok = gameClient()
		visible = ok && iconic == 0 && (front == game || front == h || over)
	}
	if !visible {
		if button.shown {
			pShowWindow.Call(h, swHide)
			button.shown = false
		}
		return
	}
	scale := dpiScale(game)
	size, inset := int32(buttonSize*scale), int32(12*scale)
	pSetWindowPos.Call(h, ^uintptr(0), uintptr(c.Left+inset), uintptr(c.Bottom-inset-size), uintptr(size), uintptr(size), swpNoActivate|swpShowWindow)
	if !button.shown {
		pInvalidateRect.Call(h, 0, 0)
	}
	button.shown = true
}

func paintButton(h uintptr) {
	var ps paintStruct
	hdc, _, _ := pBeginPaint.Call(h, uintptr(unsafe.Pointer(&ps)))
	defer pEndPaint.Call(h, uintptr(unsafe.Pointer(&ps)))
	var rc winRect
	pGetClientRect.Call(h, uintptr(unsafe.Pointer(&rc)))
	key, _, _ := pCreateSolidBrush.Call(keyColor)
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&rc)), key)
	pDeleteObject.Call(key)
	scale := float64(rc.Right) / buttonSize
	fill, _, _ := pCreateSolidBrush.Call(rgb(24, 26, 30))
	pen, _, _ := pCreatePen.Call(0, uintptr(int32(2*scale)), rgb(240, 196, 25))
	oldB, _, _ := pSelectObject.Call(hdc, fill)
	oldP, _, _ := pSelectObject.Call(hdc, pen)
	pEllipse.Call(hdc, 1, 1, uintptr(rc.Right-1), uintptr(rc.Bottom-1))
	pSelectObject.Call(hdc, oldB)
	pSelectObject.Call(hdc, oldP)
	pDeleteObject.Call(fill)
	pDeleteObject.Call(pen)
	// A map glyph (Segoe MDL2 Assets, on every Windows 10 and 11).
	font, _, _ := pCreateFontW.Call(uintptr(uint32(-int32(20*scale))), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(utf16("Segoe MDL2 Assets"))))
	oldF, _, _ := pSelectObject.Call(hdc, font)
	pSetBkMode.Call(hdc, 1)
	pSetTextColor.Call(hdc, rgb(255, 255, 255))
	glyph := utf16("")
	pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(glyph)), 1, uintptr(unsafe.Pointer(&rc)), 0x25) // centre, vcentre, single line
	pSelectObject.Call(hdc, oldF)
	pDeleteObject.Call(font)
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
	add(mfString|mfGrayed, 1, "Maple Atlas")
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
	add(mfString, cmdMark, "Mark a box to look at\tCtrl+Alt+M")
	add(mfSeparator, 0, "")
	nav := uintptr(mfString)
	if navOn {
		nav |= mfChecked
	}
	add(nav, cmdNav, "Navigation and pins on the game")
	add(mfString, cmdControls, "Game window & phone…")
	var rc winRect
	pGetWindowRect.Call(h, uintptr(unsafe.Pointer(&rc)))
	// The menu needs the foreground; the click on the button gives this program that right.
	pSetForegroundWindow.Call(h)
	id, _, _ := pTrackPopupMenu.Call(m, tpmReturnCmd|tpmBottom, uintptr(rc.Left), uintptr(rc.Top-4), 0, h, 0)
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

// buttonProc handles the button's messages (from lookProc); false for any other window.
func buttonProc(hwnd, msg, wparam, lparam uintptr) (uintptr, bool) {
	button.mu.Lock()
	h := button.hwnd
	button.mu.Unlock()
	if h == 0 || hwnd != h {
		return 0, false
	}
	switch msg {
	case wmTimer:
		if wparam == 3 {
			placeButton(hwnd)
		}
		return 0, true
	case wmPaint:
		paintButton(hwnd)
		return 0, true
	case wmEraseBkgnd:
		return 1, true
	case wmSetCursor:
		c, _, _ := pLoadCursorW.Call(0, idcHand)
		pSetCursor.Call(c)
		return 1, true
	case wmLButtonDown:
		return 0, true
	case wmLButtonUp:
		buttonMenu(hwnd)
		return 0, true
	}
	return 0, false
}
