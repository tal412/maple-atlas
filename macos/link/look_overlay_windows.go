//go:build desktopui && windows

package main

// Look on Windows: Ctrl+Alt+M marks a box on the game window (drag, or click for the area
// around the pointer), Ctrl+Alt+A looks at all of it. The screenshot goes to the phone, which
// finds what is in it and sends a card back (look-result), drawn next to the box.
//
// The hotkeys are RegisterHotKey on the overlay's window (no extra permission); the marking
// layer and the card are two more windows on the overlay's thread (overlay_windows.go).

import (
	"encoding/json"
	"strconv"
	"sync"
	"time"
	"unsafe"
)

var (
	pRegisterHotKey  = user32.NewProc("RegisterHotKey")
	pSetCapture      = user32.NewProc("SetCapture")
	pReleaseCapture  = user32.NewProc("ReleaseCapture")
	pSetForeground   = user32.NewProc("SetForegroundWindow")
	pSetFocus        = user32.NewProc("SetFocus")
	pCreatePenLook   = gdi32.NewProc("CreatePen")
	pFrameRectLook   = user32.NewProc("FrameRect")
	pGetCursorPosWin = user32.NewProc("GetCursorPos")
)

const (
	wmHotkey      = 0x0312
	wmMouseMove   = 0x0200
	wmLButtonDown = 0x0201
	wmMouseWheel  = 0x020A
	wmLButtonUp   = 0x0202
	wmRButtonDown = 0x0204
	wmKeyDown     = 0x0100
	vkEscape      = 0x1B
	modAlt        = 0x0001
	modControl    = 0x0002
	modNoRepeat   = 0x4000
)

type lookCardItem struct {
	Type   string `json:"type"`
	Name   string `json:"name"`
	Icon   string `json:"icon"`
	Detail string `json:"detail"`
	Extra  string `json:"extra"`
	Count  int    `json:"count"`
	Price  string `json:"price"` // an item's market price ("≈ 39,999 mesos")
}

type lookCardData struct {
	Title string         `json:"title"`
	Note  string         `json:"note"`
	Items []lookCardItem `json:"items"`
}

// lookUI is the marking layer and the card; its fields are used on the overlay's thread
// except where mu is held.
type lookUI struct {
	mu        sync.Mutex
	mark      uintptr // the marking layer
	card      uintptr // the result card
	marking   bool
	game      winRect // the game's client area on screen while marking
	from, to  winPoint
	dragging  bool
	pending   string // the look waiting for the phone's card
	count     int
	waiting   bool
	message   string
	progress  string // the line while it looks ("Naming 3 of 12…")
	scroll    int32  // how far the card's list is scrolled (px)
	full      int32  // the card's whole height (px), when taller than shown
	data      *lookCardData
	box       winRect // where the card goes (screen)
	hideAt    time.Time
	failTimer *time.Timer
}

var look = &lookUI{}

// IntersectClipRect: the card's list is drawn under its title only (it scrolls).
var pIntersectClipRect = gdi32.NewProc("IntersectClipRect")

// lookSession returns the live phone session (set by desktop.go).
var lookSession = func() *session { return nil }

// overlayStart runs the overlay's thread now: the Look hotkeys live on its window.
func overlayStart() {
	overlay.mu.Lock()
	overlay.startLocked()
	overlay.mu.Unlock()
}

func init() {
	overlayReady = lookReady
	overlayExtraProc = lookProc
}

// lookReady runs on the overlay's thread once its windows exist: the hotkeys and two windows.
func lookReady(owner uintptr) {
	pRegisterHotKey.Call(owner, 1, modControl|modAlt|modNoRepeat, 'M')
	pRegisterHotKey.Call(owner, 2, modControl|modAlt|modNoRepeat, 'A')
	pRegisterHotKey.Call(owner, 3, modControl|modAlt|modNoRepeat, 'W')
	class := utf16("MapleAtlasOverlay")
	mark, _, _ := pCreateWindowExW.Call(wsExLayered|wsExTopmost|wsExToolWindow, uintptr(unsafe.Pointer(class)),
		uintptr(unsafe.Pointer(utf16("Maple Atlas Look"))), wsPopup, 0, 0, 100, 100, 0, 0, 0, 0)
	if mark != 0 {
		pSetLayeredWindowAttributes.Call(mark, keyColor, 140, lwaColorKey|lwaAlpha)
	}
	// The card takes the mouse (the wheel scrolls a long list, a click closes it), never the focus.
	card, _, _ := pCreateWindowExW.Call(wsExLayered|wsExTopmost|wsExToolWindow|wsExNoActivate, uintptr(unsafe.Pointer(class)),
		uintptr(unsafe.Pointer(utf16("Maple Atlas Look card"))), wsPopup, 0, 0, 360, 120, 0, 0, 0, 0)
	if card != 0 {
		pSetLayeredWindowAttributes.Call(card, keyColor, 240, lwaColorKey|lwaAlpha)
		pSetTimer.Call(card, 2, 400, 0)
	}
	look.mu.Lock()
	look.mark, look.card = mark, card
	look.mu.Unlock()
}

// gameClient is the game window's client area on screen (what the screenshot shows).
func gameClient() (winRect, bool) {
	overlay.mu.Lock()
	g := overlay.gameWindow()
	overlay.mu.Unlock()
	if g == 0 {
		g, _, _ = findGameWindow()
	}
	if g == 0 {
		return winRect{}, false
	}
	var rc winRect
	pGetClientRect.Call(g, uintptr(unsafe.Pointer(&rc)))
	pt := winPoint{0, 0}
	pClientToScreen.Call(g, uintptr(unsafe.Pointer(&pt)))
	return winRect{pt.X, pt.Y, pt.X + rc.Right, pt.Y + rc.Bottom}, rc.Right > 50 && rc.Bottom > 50
}

func lookProc(hwnd, msg, wparam, lparam uintptr) (uintptr, bool) {
	l := look
	switch {
	case msg == wmHotkey:
		if wparam == 1 {
			l.beginMark()
		} else if wparam == 2 {
			l.lookAll()
		} else if wparam == 3 {
			toggleAtlasPopup()
		}
		return 0, true
	case hwnd == l.mark && hwnd != 0:
		switch msg {
		case wmLButtonDown:
			l.from = winPoint{int32(int16(lparam & 0xFFFF)), int32(int16(lparam >> 16 & 0xFFFF))}
			l.to, l.dragging = l.from, true
			pSetCapture.Call(hwnd)
			return 0, true
		case wmMouseMove:
			if l.dragging {
				l.to = winPoint{int32(int16(lparam & 0xFFFF)), int32(int16(lparam >> 16 & 0xFFFF))}
				pInvalidateRect.Call(hwnd, 0, 0)
			}
			return 0, true
		case wmLButtonUp:
			if l.dragging {
				l.dragging = false
				pReleaseCapture.Call()
				l.finishMark()
			}
			return 0, true
		case wmRButtonDown:
			l.cancelMark()
			return 0, true
		case wmKeyDown:
			if wparam == vkEscape {
				l.cancelMark()
			}
			return 0, true
		case wmPaint:
			l.paintMark(hwnd)
			return 0, true
		case wmEraseBkgnd:
			return 1, true
		}
	case hwnd == l.card && hwnd != 0:
		switch msg {
		case wmPaint:
			l.paintCard(hwnd)
			return 0, true
		case wmMouseWheel:
			delta := int32(int16(wparam >> 16 & 0xFFFF))
			var r winRect
			pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
			l.mu.Lock()
			if l.full > r.Bottom-r.Top {
				l.scroll = max(0, min(l.full-(r.Bottom-r.Top), l.scroll-delta*48/120))
				l.hideAt = time.Now().Add(60 * time.Second)
			}
			l.mu.Unlock()
			pInvalidateRect.Call(hwnd, 0, 0)
			return 0, true
		case wmLButtonDown:
			l.mu.Lock()
			l.hideAt = time.Time{}
			l.mu.Unlock()
			pShowWindow.Call(hwnd, swHide)
			return 0, true
		case wmEraseBkgnd:
			return 1, true
		case wmTimer:
			l.mu.Lock()
			visible := !l.hideAt.IsZero()
			expired := visible && time.Now().After(l.hideAt)
			if expired {
				l.hideAt = time.Time{}
			}
			l.mu.Unlock()
			if expired {
				pShowWindow.Call(hwnd, swHide)
			} else if visible {
				pInvalidateRect.Call(hwnd, 0, 0) // the spinner and icons as they arrive
			}
			return 0, true
		}
	}
	return 0, false
}

// ---- Marking ----

func (l *lookUI) beginMark() {
	r, ok := gameClient()
	if !ok || l.mark == 0 {
		return
	}
	l.marking, l.dragging, l.game = true, false, r
	l.from, l.to = winPoint{}, winPoint{}
	pSetWindowPos.Call(l.mark, ^uintptr(0), uintptr(r.Left), uintptr(r.Top), uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top), swpShowWindow)
	pSetForeground.Call(l.mark)
	pSetFocus.Call(l.mark)
	pInvalidateRect.Call(l.mark, 0, 0)
}

func (l *lookUI) cancelMark() {
	l.marking, l.dragging = false, false
	pShowWindow.Call(l.mark, swHide)
}

func (l *lookUI) finishMark() {
	w, h := l.game.Right-l.game.Left, l.game.Bottom-l.game.Top
	x0, y0, x1, y1 := min(l.from.X, l.to.X), min(l.from.Y, l.to.Y), max(l.from.X, l.to.X), max(l.from.Y, l.to.Y)
	if x1-x0 < 12 || y1-y0 < 12 {
		// A click: the area around it (about a character and its surroundings).
		bw, bh := int32(float64(w)*0.22), int32(float64(h)*0.3)
		x0, y0 = l.from.X-bw/2, l.from.Y-bh/2
		x1, y1 = x0+bw, y0+bh
	}
	x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
	l.cancelMark()
	if x1-x0 < 4 || y1-y0 < 4 {
		return
	}
	mark := []float64{float64(x0) / float64(w), float64(y0) / float64(h), float64(x1-x0) / float64(w), float64(y1-y0) / float64(h)}
	l.start(mark, winRect{l.game.Left + x0, l.game.Top + y0, l.game.Left + x1, l.game.Top + y1})
}

func (l *lookUI) lookAll() {
	r, ok := gameClient()
	if !ok {
		return
	}
	mid := winRect{(r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2, (r.Left+r.Right)/2 + 2, (r.Top+r.Bottom)/2 + 2}
	l.start([]float64{0, 0, 1, 1}, mid)
}

// start looks at the marked box on this PC (lookEngine: Look's page in a hidden Edge) and shows
// the card, waiting with its progress; no phone needed.
func (l *lookUI) start(mark []float64, box winRect) {
	l.mu.Lock()
	l.box = box
	l.count++
	req := "c" + strconv.Itoa(l.count)
	l.pending, l.waiting, l.data, l.message, l.progress = req, true, nil, "Looking…", ""
	if l.failTimer != nil {
		l.failTimer.Stop()
	}
	l.failTimer = time.AfterFunc(90*time.Second, func() { l.fail(req, "Look took too long. Try again.") })
	l.mu.Unlock()
	l.showCard(90 * time.Second)
	go func() {
		shot, err := lookShotOf(req, mark)
		var card json.RawMessage
		if err == nil {
			card, _, err = lookEngine.analyze(shot, mark, func(text string) {
				overlayLookProgress(map[string]any{"req": req, "text": text})
			})
		}
		if err != nil {
			gameLog("look: %v", err)
			l.fail(req, "Could not look: "+clip(err.Error(), 70))
			return
		}
		normal, ok := lookCard(card)
		if !ok {
			l.fail(req, "Look gave no answer.")
			return
		}
		overlayLookCard(map[string]any{"req": req, "card": normal})
	}()
}

func (l *lookUI) fail(req, msg string) {
	l.mu.Lock()
	if l.pending != req {
		l.mu.Unlock()
		return
	}
	l.pending, l.waiting, l.data, l.message, l.progress = "", false, nil, msg, ""
	l.mu.Unlock()
	l.showCard(8 * time.Second)
}

// overlayLookProgress takes the helper's "look-progress" event: the line under "Looking" while
// the phone works. The phone is still working, so the no-answer timer starts again.
func overlayLookProgress(v map[string]any) {
	req, _ := v["req"].(string)
	text, _ := v["text"].(string)
	l := look
	l.mu.Lock()
	if req == "" || req != l.pending || !l.waiting {
		l.mu.Unlock()
		return
	}
	grow := l.progress == ""
	l.progress = text
	if l.failTimer != nil {
		l.failTimer.Stop()
	}
	l.failTimer = time.AfterFunc(90*time.Second, func() { l.fail(req, "Look took too long. Try again.") })
	card := l.card
	l.mu.Unlock()
	if grow {
		l.showCard(20 * time.Second)
	} else if card != 0 {
		pInvalidateRect.Call(card, 0, 0)
	}
}

// overlayLookCard takes the helper's "look-result" event (checked by lookCard).
func overlayLookCard(v map[string]any) {
	req, _ := v["req"].(string)
	b, _ := json.Marshal(v["card"])
	var card lookCardData
	if json.Unmarshal(b, &card) != nil {
		return
	}
	l := look
	l.mu.Lock()
	if req != l.pending {
		l.mu.Unlock()
		return
	}
	if l.failTimer != nil {
		l.failTimer.Stop()
	}
	l.pending, l.waiting, l.data, l.progress, l.scroll = "", false, &card, "", 0
	l.message = card.Note
	if len(card.Items) == 0 && card.Note == "" {
		l.message = "Nothing from the database found here."
	}
	l.mu.Unlock()
	for _, it := range card.Items {
		icons.want(it.Icon)
	}
	d := 15 * time.Second
	if len(card.Items) > 0 {
		d = 60 * time.Second
	}
	l.showCard(d)
}

// ---- Drawing ----

func (l *lookUI) paintMark(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	defer pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	w, h := l.game.Right-l.game.Left, l.game.Bottom-l.game.Top
	dark, _, _ := pCreateSolidBrush.Call(rgb(0, 0, 0))
	full := winRect{0, 0, w, h}
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&full)), dark)
	pDeleteObject.Call(dark)
	if l.dragging {
		r := winRect{min(l.from.X, l.to.X), min(l.from.Y, l.to.Y), max(l.from.X, l.to.X), max(l.from.Y, l.to.Y)}
		key, _, _ := pCreateSolidBrush.Call(keyColor)
		pFillRect.Call(hdc, uintptr(unsafe.Pointer(&r)), key)
		pDeleteObject.Call(key)
		blue, _, _ := pCreateSolidBrush.Call(rgb(51, 140, 255))
		for i := int32(0); i < 3; i++ {
			e := winRect{r.Left - i, r.Top - i, r.Right + i, r.Bottom + i}
			pFrameRectLook.Call(hdc, uintptr(unsafe.Pointer(&e)), blue)
		}
		pDeleteObject.Call(blue)
	}
	font := makeFont(18, 600)
	old, _, _ := pSelectObject.Call(hdc, font)
	pSetBkMode.Call(hdc, 1)
	pSetTextColor.Call(hdc, rgb(255, 255, 255))
	box := winRect{0, 40, w, 80}
	pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16("Drag a box around what you want to know · click for the area around a spot · Esc cancels"))), ^uintptr(0),
		uintptr(unsafe.Pointer(&box)), dtCenter|dtSingleLine|dtNoPrefix)
	pSelectObject.Call(hdc, old)
	pDeleteObject.Call(font)
}

// cardSize is the card's height for its content at this scale.
func (l *lookUI) cardSize(scale float64) (int32, int32) {
	px := func(v float64) int32 { return int32(v * scale) }
	h := px(44)
	if l.waiting && l.progress != "" {
		h += px(20)
	}
	if l.data != nil {
		for _, it := range l.data.Items {
			h += px(30)
			if it.Price != "" {
				h += px(18)
			}
			if it.Detail != "" {
				h += px(18)
			}
			if it.Extra != "" {
				h += px(18)
			}
			h += px(8)
		}
	}
	h += px(8)
	// At most about 75% of the game window: a longer list scrolls (the mouse wheel).
	l.full = h
	if g, ok := gameClient(); ok {
		if most := (g.Bottom - g.Top) * 3 / 4; h > most && most > px(160) {
			h = most
		}
	}
	return px(380), h
}

func (l *lookUI) showCard(d time.Duration) {
	g, ok := gameClient()
	if !ok || l.card == 0 {
		return
	}
	overlay.mu.Lock()
	scale := dpiScale(overlay.game)
	overlay.mu.Unlock()
	l.mu.Lock()
	w, h := l.cardSize(scale)
	box := l.box
	l.hideAt = time.Now().Add(d)
	l.mu.Unlock()
	x := box.Right + int32(12*scale)
	if x+w > g.Right-8 {
		x = box.Left - int32(12*scale) - w
	}
	x = max(g.Left+8, min(x, g.Right-w-8))
	y := max(g.Top+8, min(box.Top, g.Bottom-h-8))
	pSetWindowPos.Call(l.card, ^uintptr(0), uintptr(x), uintptr(y), uintptr(w), uintptr(h), swpNoActivate|swpShowWindow)
	pInvalidateRect.Call(l.card, 0, 0)
}

func (l *lookUI) paintCard(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	defer pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	var r winRect
	pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	w, h := r.Right-r.Left, r.Bottom-r.Top
	overlay.mu.Lock()
	scale := dpiScale(overlay.game)
	overlay.mu.Unlock()
	px := func(v float64) int32 { return int32(v * scale) }
	l.mu.Lock()
	data, message, waiting, progress := l.data, l.message, l.waiting, l.progress
	l.mu.Unlock()

	key, _, _ := pCreateSolidBrush.Call(keyColor)
	full := winRect{0, 0, w, h}
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&full)), key)
	pDeleteObject.Call(key)
	bg, _, _ := pCreateSolidBrush.Call(rgb(pinCard[0], pinCard[1], pinCard[2]))
	edge, _, _ := pCreatePenLook.Call(0, 1, rgb(70, 74, 82))
	ob, _, _ := pSelectObject.Call(hdc, bg)
	op, _, _ := pSelectObject.Call(hdc, edge)
	pRoundRect.Call(hdc, 0, 0, uintptr(w), uintptr(h), uintptr(px(28)), uintptr(px(28)))
	pSelectObject.Call(hdc, ob)
	pSelectObject.Call(hdc, op)
	pDeleteObject.Call(bg)
	pDeleteObject.Call(edge)
	pSetBkMode.Call(hdc, 1)
	text := func(s string, left, top, right, bottom int32, size int32, weight uintptr, color uintptr) {
		if s == "" {
			return
		}
		font := makeFont(size, weight)
		old, _, _ := pSelectObject.Call(hdc, font)
		pSetTextColor.Call(hdc, color)
		box := winRect{left, top, right, bottom}
		pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16(s))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtSingleLine|dtNoPrefix|dtEndEllipsis|dtVCenter)
		pSelectObject.Call(hdc, old)
		pDeleteObject.Call(font)
	}
	title := message
	if data != nil && data.Title != "" {
		title = data.Title
	}
	if waiting {
		dots := []string{"·", "··", "···"}[int(time.Now().UnixMilli()/400)%3]
		title = "Looking " + dots
	}
	text(title, px(16), px(10), w-px(14), px(36), px(15), 600, rgb(255, 255, 255))
	if waiting && progress != "" {
		text(progress, px(16), px(36), w-px(14), px(58), px(13), 400, rgb(180, 186, 196))
	}
	if data == nil {
		return
	}
	l.mu.Lock()
	scroll := l.scroll
	l.mu.Unlock()
	if scroll > 0 || l.full > h {
		pIntersectClipRect.Call(hdc, 0, uintptr(px(40)), uintptr(w), uintptr(h-px(6)))
		if l.full > h {
			text(strconv.Itoa(len(data.Items))+" found · scroll", w-px(150), px(10), w-px(14), px(36), px(12), 400, rgb(160, 166, 176))
		}
	}
	y := px(44) - scroll
	small := makeFont(px(13), 700)
	for _, it := range data.Items {
		drawPinIcon(hdc, it.Icon, it.Name, px(14), y, px(pinIcon), small, px)
		name := it.Name
		if it.Count > 1 {
			name += " ×" + strconv.Itoa(it.Count)
		}
		left := px(14 + pinIcon + 10)
		text(name, left, y, w-px(12), y+px(28), px(15), 700, rgb(255, 255, 255))
		y += px(30)
		if it.Price != "" {
			text(it.Price, left, y-px(2), w-px(12), y+px(16), px(13), 600, rgb(81, 207, 102))
			y += px(18)
		}
		if it.Detail != "" {
			text(it.Detail, left, y-px(2), w-px(12), y+px(16), px(12), 400, rgb(215, 218, 224))
			y += px(18)
		}
		if it.Extra != "" {
			text(it.Extra, left, y-px(2), w-px(12), y+px(16), px(12), 500, rgb(255, 214, 79))
			y += px(18)
		}
		y += px(8)
	}
	pDeleteObject.Call(small)
}
