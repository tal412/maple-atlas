//go:build desktopui && windows

package main

import (
	"math"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// The navigation card on top of the game window during a route on the phone: an arrow from
// your dot toward the next portal (or the best hunting spot), what it is, the live hint and
// the step. A layered, topmost, click-through tool window drawn with GDI; it follows the
// game window (found by the title the browser reports for the captured window) and shows
// only while that window is in front.

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	gdi32  = syscall.NewLazyDLL("gdi32.dll")

	pRegisterClassExW           = user32.NewProc("RegisterClassExW")
	pCreateWindowExW            = user32.NewProc("CreateWindowExW")
	pDefWindowProcW             = user32.NewProc("DefWindowProcW")
	pGetMessageW                = user32.NewProc("GetMessageW")
	pTranslateMessage           = user32.NewProc("TranslateMessage")
	pDispatchMessageW           = user32.NewProc("DispatchMessageW")
	pSetLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
	pSetWindowPos               = user32.NewProc("SetWindowPos")
	pShowWindow                 = user32.NewProc("ShowWindow")
	pSetTimer                   = user32.NewProc("SetTimer")
	pInvalidateRect             = user32.NewProc("InvalidateRect")
	pBeginPaint                 = user32.NewProc("BeginPaint")
	pEndPaint                   = user32.NewProc("EndPaint")
	pFillRect                   = user32.NewProc("FillRect")
	pDrawTextW                  = user32.NewProc("DrawTextW")
	pGetWindowRect              = user32.NewProc("GetWindowRect")
	pIsWindow                   = user32.NewProc("IsWindow")
	pIsWindowVisible            = user32.NewProc("IsWindowVisible")
	pIsIconic                   = user32.NewProc("IsIconic")
	pGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	pEnumWindows                = user32.NewProc("EnumWindows")
	pGetWindowTextW             = user32.NewProc("GetWindowTextW")
	pGetDpiForWindow            = user32.NewProc("GetDpiForWindow")
	pSetProcessDpiAwareContext  = user32.NewProc("SetProcessDpiAwarenessContext")

	pCreateSolidBrush = gdi32.NewProc("CreateSolidBrush")
	pCreatePen        = gdi32.NewProc("CreatePen")
	pCreateFontW      = gdi32.NewProc("CreateFontW")
	pSelectObject     = gdi32.NewProc("SelectObject")
	pDeleteObject     = gdi32.NewProc("DeleteObject")
	pRoundRect        = gdi32.NewProc("RoundRect")
	pEllipse          = gdi32.NewProc("Ellipse")
	pPolygon          = gdi32.NewProc("Polygon")
	pSetBkMode        = gdi32.NewProc("SetBkMode")
	pSetTextColor     = gdi32.NewProc("SetTextColor")
	pGetStockObject   = gdi32.NewProc("GetStockObject")
)

const (
	wsPopup         = 0x80000000
	wsExLayered     = 0x00080000
	wsExTransparent = 0x00000020
	wsExTopmost     = 0x00000008
	wsExToolWindow  = 0x00000080
	wsExNoActivate  = 0x08000000
	lwaColorKey     = 0x1
	lwaAlpha        = 0x2
	swHide          = 0
	swShowNoActive  = 4
	swpNoActivate   = 0x0010
	swpShowWindow   = 0x0040
	wmPaint         = 0x000F
	wmEraseBkgnd    = 0x0014
	wmTimer         = 0x0113
	dtSingleLine    = 0x0020
	dtWordBreak     = 0x0010
	dtEndEllipsis   = 0x8000
	dtNoPrefix      = 0x0800
	dtCenter        = 0x0001
	dtVCenter       = 0x0004
	nullPen         = 8
	keyColor        = 0x00FF00FF // magenta: the see-through corners
)

type winRect struct{ Left, Top, Right, Bottom int32 }
type winPoint struct{ X, Y int32 }
type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      winPoint
	Private uint32
}
type paintStruct struct {
	Hdc       uintptr
	Erase     int32
	Paint     winRect
	Restore   int32
	IncUpdate int32
	Reserved  [32]byte
}
type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type navTarget struct {
	kind, label string
	x, y        float64
	hasXY       bool
}

// overlayState is shared between the helper (commands, phone events) and the window thread.
type overlayState struct {
	mu       sync.Mutex
	on       bool
	tracking bool
	title    string
	navOn    bool
	navMap   string
	step     string
	hint     string
	target   navTarget
	posMap   string
	posX     float64
	posY     float64
	posAt    time.Time
	game     uintptr
	findAt   time.Time
	shown    bool
	hwnd     uintptr
	started  bool
	pins     []pinQuest // quests pinned on the phone (overlay_pins_windows.go)
	pinsHwnd uintptr
}

var overlay = &overlayState{on: true}

func rgb(r, g, b byte) uintptr { return uintptr(r) | uintptr(g)<<8 | uintptr(b)<<16 }

func utf16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

// ---- Inputs ----

func overlayNav(v map[string]any) {
	o := overlay
	o.mu.Lock()
	defer o.mu.Unlock()
	o.navOn, _ = v["active"].(bool)
	if !o.navOn {
		return
	}
	o.navMap, _ = v["map"].(string)
	hint, _ := v["hint"].(string)
	live, _ := v["live"].(bool)
	if hint == "" && !live {
		hint = "Waiting for your position on the minimap"
	}
	o.hint = hint
	step, _ := v["step"].(int)
	steps, _ := v["steps"].(int)
	dest, _ := v["dest"].(string)
	o.step = "Step " + itoa(step) + " of " + itoa(steps)
	if dest != "" {
		o.step += " · to " + dest
	}
	o.target = navTarget{}
	if t, ok := v["target"].(map[string]any); ok {
		o.target.kind, _ = t["kind"].(string)
		o.target.label, _ = t["label"].(string)
		x, okx := t["x"].(int)
		y, oky := t["y"].(int)
		o.target.x, o.target.y, o.target.hasXY = float64(x), float64(y), okx && oky
	}
	o.startLocked()
}

func overlayPosition(id string, x, y float64) {
	o := overlay
	o.mu.Lock()
	o.posMap, o.posX, o.posY, o.posAt = id, x, y, time.Now()
	o.mu.Unlock()
}

func overlayWindow(title string) {
	o := overlay
	o.mu.Lock()
	o.title, o.game, o.findAt = strings.TrimSpace(title), 0, time.Time{}
	o.mu.Unlock()
}

func overlayEnabled(on bool) {
	o := overlay
	o.mu.Lock()
	o.on = on
	o.mu.Unlock()
}

func overlayTracking(state string) {
	o := overlay
	o.mu.Lock()
	o.tracking = state == "tracking" || state == "searching"
	o.mu.Unlock()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

// ---- Window thread ----

func (o *overlayState) startLocked() {
	if o.started {
		return
	}
	o.started = true
	go o.run()
}

func (o *overlayState) run() {
	runtime.LockOSThread()
	pSetProcessDpiAwareContext.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
	class := utf16("MapleAtlasOverlay")
	wc := wndClassEx{WndProc: syscall.NewCallback(o.proc), ClassName: class}
	wc.Size = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	hwnd, _, _ := pCreateWindowExW.Call(wsExLayered|wsExTransparent|wsExTopmost|wsExToolWindow|wsExNoActivate,
		uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(utf16("Maple Atlas navigation"))), wsPopup,
		0, 0, 460, 102, 0, 0, 0, 0)
	if hwnd == 0 {
		return
	}
	pSetLayeredWindowAttributes.Call(hwnd, keyColor, 235, lwaColorKey|lwaAlpha)
	pins, _, _ := pCreateWindowExW.Call(wsExLayered|wsExTransparent|wsExTopmost|wsExToolWindow|wsExNoActivate,
		uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(utf16("Maple Atlas pinned quests"))), wsPopup,
		0, 0, 400, pinHeight, 0, 0, 0, 0)
	if pins != 0 {
		pSetLayeredWindowAttributes.Call(pins, keyColor, 235, lwaColorKey|lwaAlpha)
	}
	o.mu.Lock()
	o.hwnd = hwnd
	o.pinsHwnd = pins
	o.mu.Unlock()
	pSetTimer.Call(hwnd, 1, 250, 0)
	var m winMsg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func (o *overlayState) proc(hwnd, msg, wparam, lparam uintptr) uintptr {
	switch msg {
	case wmTimer:
		o.tick(hwnd)
		return 0
	case wmEraseBkgnd:
		return 1
	case wmPaint:
		o.mu.Lock()
		isPins := hwnd == o.pinsHwnd && hwnd != 0
		o.mu.Unlock()
		if isPins {
			o.paintPins(hwnd)
		} else {
			o.paint(hwnd)
		}
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return r
}

// gameWindow finds (and remembers) the visible top-level window with the captured title.
func (o *overlayState) gameWindow() uintptr {
	if o.game != 0 {
		if ok, _, _ := pIsWindow.Call(o.game); ok != 0 {
			return o.game
		}
		o.game = 0
	}
	if o.title == "" || time.Since(o.findAt) < 2*time.Second {
		return 0
	}
	o.findAt = time.Now()
	want := strings.ToLower(o.title)
	var exact, partial uintptr
	cb := syscall.NewCallback(func(h, _ uintptr) uintptr {
		if v, _, _ := pIsWindowVisible.Call(h); v == 0 || h == o.hwnd {
			return 1
		}
		buf := make([]uint16, 256)
		n, _, _ := pGetWindowTextW.Call(h, uintptr(unsafe.Pointer(&buf[0])), 256)
		title := strings.ToLower(syscall.UTF16ToString(buf[:n]))
		if title == "" || strings.Contains(title, "maple atlas") {
			return 1
		}
		if title == want {
			exact = h
			return 0
		}
		if partial == 0 && (strings.Contains(title, want) || strings.Contains(want, title)) {
			partial = h
		}
		return 1
	})
	pEnumWindows.Call(cb, 0)
	if exact != 0 {
		o.game = exact
	} else {
		o.game = partial
	}
	return o.game
}

// tick shows the card at the game window's top centre while a route is active and the game
// is in front; otherwise it hides it.
func (o *overlayState) tick(hwnd uintptr) {
	o.mu.Lock()
	game := o.gameWindow()
	visible := o.on && o.tracking && game != 0
	if visible {
		front, _, _ := pGetForegroundWindow.Call()
		iconic, _, _ := pIsIconic.Call(game)
		visible = iconic == 0 && (front == game || front == hwnd || front == o.pinsHwnd)
	}
	want := visible && o.navOn
	o.mu.Unlock()
	var gr winRect
	if game != 0 {
		pGetWindowRect.Call(game, uintptr(unsafe.Pointer(&gr)))
	}
	below := o.placePins(game, gr, visible)
	if !want {
		if o.shown {
			pShowWindow.Call(hwnd, swHide)
			o.shown = false
		}
		return
	}
	var r winRect
	pGetWindowRect.Call(game, uintptr(unsafe.Pointer(&r)))
	scale := dpiScale(game)
	w, h := int32(460*scale), int32(102*scale)
	if gw := r.Right - r.Left - int32(40*scale); w > gw {
		w = gw
	}
	if w < int32(240*scale) {
		w = int32(240 * scale)
	}
	x, y := r.Left+(r.Right-r.Left-w)/2, r.Top+int32(48*scale)+below
	pSetWindowPos.Call(hwnd, ^uintptr(0), uintptr(x), uintptr(y), uintptr(w), uintptr(h), swpNoActivate|swpShowWindow)
	o.shown = true
	pInvalidateRect.Call(hwnd, 0, 0)
}

func dpiScale(h uintptr) float64 {
	if pGetDpiForWindow.Find() != nil {
		return 1
	}
	dpi, _, _ := pGetDpiForWindow.Call(h)
	if dpi < 96 {
		return 1
	}
	return float64(dpi) / 96
}

func (o *overlayState) paint(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	defer pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	var r winRect
	pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	w, h := r.Right-r.Left, r.Bottom-r.Top
	o.mu.Lock()
	label, hint, step, kind := o.target.label, o.hint, o.step, o.target.kind
	angle, hasAngle := 0.0, false
	if o.target.hasXY && o.posMap == o.navMap && time.Since(o.posAt) < 10*time.Second {
		angle, hasAngle = math.Atan2(o.target.y-o.posY, o.target.x-o.posX), true
	}
	scale := dpiScale(o.game)
	o.mu.Unlock()
	px := func(v float64) int32 { return int32(v * scale) }

	key, _, _ := pCreateSolidBrush.Call(keyColor)
	full := winRect{0, 0, w, h}
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&full)), key)
	pDeleteObject.Call(key)

	card, _, _ := pCreateSolidBrush.Call(rgb(22, 24, 28))
	edge, _, _ := pCreatePen.Call(0, 1, rgb(70, 74, 82))
	oldB, _, _ := pSelectObject.Call(hdc, card)
	oldP, _, _ := pSelectObject.Call(hdc, edge)
	pRoundRect.Call(hdc, 0, 0, uintptr(w), uintptr(h), uintptr(px(36)), uintptr(px(36)))
	pSelectObject.Call(hdc, oldB)
	pSelectObject.Call(hdc, oldP)
	pDeleteObject.Call(card)
	pDeleteObject.Call(edge)

	// The blue circle with the arrow (or a check mark on arrival).
	cx, cy, rad := px(46), h/2, px(30)
	blue, _, _ := pCreateSolidBrush.Call(rgb(11, 87, 208))
	none, _, _ := pGetStockObject.Call(nullPen)
	oldB, _, _ = pSelectObject.Call(hdc, blue)
	oldP, _, _ = pSelectObject.Call(hdc, none)
	pEllipse.Call(hdc, uintptr(cx-rad), uintptr(cy-rad), uintptr(cx+rad), uintptr(cy+rad))
	pSelectObject.Call(hdc, oldB)
	pDeleteObject.Call(blue)
	white, _, _ := pCreateSolidBrush.Call(rgb(255, 255, 255))
	pSelectObject.Call(hdc, white)
	if kind != "arrived" && hasAngle {
		shape := [][2]float64{{-14, -5}, {2, -5}, {2, -13}, {17, 0}, {2, 13}, {2, 5}, {-14, 5}}
		pts := make([]winPoint, len(shape))
		s, c := math.Sin(angle), math.Cos(angle)
		for i, p := range shape {
			pts[i] = winPoint{cx + px(p[0]*c-p[1]*s), cy + px(p[0]*s+p[1]*c)}
		}
		pPolygon.Call(hdc, uintptr(unsafe.Pointer(&pts[0])), uintptr(len(pts)))
	} else if kind != "arrived" {
		// Your position is being worked out: a spinner of dots (the card repaints every 250 ms).
		phase := int(time.Now().UnixMilli()/125) % 8
		for i := 0; i < 8; i++ {
			a := float64(i) * math.Pi / 4
			r := px(4)
			if i == phase {
				r = px(6)
			}
			x, y := cx+px(16*math.Cos(a)), cy+px(16*math.Sin(a))
			pEllipse.Call(hdc, uintptr(x-r), uintptr(y-r), uintptr(x+r), uintptr(y+r))
		}
	} else {
		mark := "✓"
		font := makeFont(px(30), 700)
		oldF, _, _ := pSelectObject.Call(hdc, font)
		pSetBkMode.Call(hdc, 1)
		pSetTextColor.Call(hdc, rgb(255, 255, 255))
		box := winRect{cx - rad, cy - rad, cx + rad, cy + rad}
		pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16(mark))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtCenter|dtVCenter|dtSingleLine)
		pSelectObject.Call(hdc, oldF)
		pDeleteObject.Call(font)
	}
	pSelectObject.Call(hdc, oldB)
	pSelectObject.Call(hdc, oldP)
	pDeleteObject.Call(white)

	// Text: what to reach, the live hint, the step.
	pSetBkMode.Call(hdc, 1)
	left, right := px(90), w-px(14)
	text := func(s string, top, bottom int32, size int32, weight uintptr, color uintptr, flags uintptr) {
		if s == "" {
			return
		}
		font := makeFont(size, weight)
		oldF, _, _ := pSelectObject.Call(hdc, font)
		pSetTextColor.Call(hdc, color)
		box := winRect{left, top, right, bottom}
		pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16(s))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), flags|dtNoPrefix|dtEndEllipsis)
		pSelectObject.Call(hdc, oldF)
		pDeleteObject.Call(font)
	}
	text(label, px(8), px(50), px(15), 600, rgb(255, 255, 255), dtWordBreak)
	text(hint, px(53), px(73), px(15), 500, rgb(255, 214, 79), dtSingleLine)
	text(step, px(76), px(94), px(12), 400, rgb(180, 184, 190), dtSingleLine)
}

func makeFont(height int32, weight uintptr) uintptr {
	f, _, _ := pCreateFontW.Call(uintptr(uint32(-height)), 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(utf16("Segoe UI"))))
	return f
}
