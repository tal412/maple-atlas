//go:build desktopui && windows

package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

// --overlay-demo: opens a stand-in game window titled "Fake MapleStory", feeds the overlay a
// route step and a position, then prints where the card is and saves a screenshot of the
// game window area (overlay-demo.bmp). Exits 0 when the card shows at the game's top centre.

var (
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pGetDC               = user32.NewProc("GetDC")
	pReleaseDC           = user32.NewProc("ReleaseDC")
	pCreateCompatibleDC  = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatibleBmp = gdi32.NewProc("CreateCompatibleBitmap")
	pBitBlt              = gdi32.NewProc("BitBlt")
	pGetDIBits           = gdi32.NewProc("GetDIBits")
	pDeleteDC            = gdi32.NewProc("DeleteDC")
)

func init() { overlayDemo = runOverlayDemo }

func runOverlayDemo() int {
	ready := make(chan uintptr)
	go func() {
		runtime.LockOSThread()
		class := utf16("FakeGame")
		def := syscall.NewCallback(func(h, m, w, l uintptr) uintptr { r, _, _ := pDefWindowProcW.Call(h, m, w, l); return r })
		brush, _, _ := pCreateSolidBrush.Call(rgb(60, 120, 70))
		wc := wndClassEx{WndProc: def, ClassName: class, Background: brush}
		wc.Size = uint32(unsafe.Sizeof(wc))
		pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
		const overlapped, visible = 0x00CF0000, 0x10000000
		h, _, _ := pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(utf16("Fake MapleStory"))), overlapped|visible, 100, 100, 1280, 760, 0, 0, 0, 0)
		ready <- h
		var m winMsg
		for {
			if r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0); int32(r) <= 0 {
				return
			}
			pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
	}()
	game := <-ready
	pSetForegroundWindow.Call(game)
	overlayWindow("Fake MapleStory")
	overlayEnabled(true)
	overlayTracking("tracking")
	overlayNav(map[string]any{"event": "nav", "active": true, "map": "10001000", "name": "Henesys", "dest": "L Forest I", "step": 1, "steps": 3, "live": true,
		"hint": "Head right, about 2 screens", "target": map[string]any{"kind": "portal", "label": "Take the right-hand portal to The Hill East of Henesys.", "x": 6587, "y": 1050}})
	overlayPosition("10001000", 5000, 1000)
	// Two pinned quests, as the phone sends them (checked the same way).
	commit := "a44f101bffa8272164ca47484ab18c078dcab0a0"
	if ev, ok := pinsEvent(json.RawMessage(`[{"t":"Make a Slime & Pig Omok Set","r":false,"o":[` +
		`{"n":"Omok Table","h":1,"d":1,"i":"` + commit + `/data/current/images/items/04031049.png"},` +
		`{"n":"Omok Piece: Slime","h":1,"d":1,"i":"` + commit + `/data/current/images/items/04031050.png"},` +
		`{"n":"Omok Piece: Pig","h":0,"d":1,"i":"` + commit + `/data/current/images/items/04031051.png"}]},` +
		`{"t":"Ores","k":"ores","o":[{"n":"Iron Ore","i":"` + commit + `/data/current/images/items/04010001.png","m":"` + commit + `/data/images/monsters/d8caace4e0f119f7a3f2b1fb450f7ed4.png","p":2.9}]}]`)); ok {
		overlayPins(ev)
	}
	time.Sleep(6 * time.Second)

	overlay.mu.Lock()
	hwnd, pinsHwnd := overlay.hwnd, overlay.pinsHwnd
	overlay.mu.Unlock()
	var pr winRect
	pinsVisible, _, _ := pIsWindowVisible.Call(pinsHwnd)
	if pinsHwnd != 0 {
		pGetWindowRect.Call(pinsHwnd, uintptr(unsafe.Pointer(&pr)))
	}
	var gr, or winRect
	pGetWindowRect.Call(game, uintptr(unsafe.Pointer(&gr)))
	vis, _, _ := pIsWindowVisible.Call(hwnd)
	if hwnd != 0 {
		pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&or)))
	}
	front, _, _ := pGetForegroundWindow.Call()
	shot := screenshot(gr, "overlay-demo.bmp")
	centred := or.Left > gr.Left && or.Right < gr.Right && abs32((or.Left+or.Right)/2-(gr.Left+gr.Right)/2) <= 2 && or.Top >= gr.Top && or.Top < gr.Top+200
	pinsAbove := pinsVisible != 0 && pr.Bottom <= or.Top && abs32((pr.Left+pr.Right)/2-(gr.Left+gr.Right)/2) <= 2
	icons.mu.Lock()
	loaded := len(icons.pix)
	icons.mu.Unlock()
	report, _ := json.Marshal(map[string]any{"overlayWindow": hwnd != 0, "visible": vis != 0, "centred": centred, "gameInFront": front == game,
		"pinsVisible": pinsVisible != 0, "pinsAboveCard": pinsAbove, "pins": []int32{pr.Left, pr.Top, pr.Right, pr.Bottom}, "iconsLoaded": loaded,
		"game": []int32{gr.Left, gr.Top, gr.Right, gr.Bottom}, "card": []int32{or.Left, or.Top, or.Right, or.Bottom}, "screenshot": shot})
	os.Stdout.Write(append(report, '\n'))
	if hwnd != 0 && vis != 0 && centred && pinsAbove {
		return 0
	}
	return 1
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// screenshot saves the screen area r as a 24-bit BMP; returns the path or "".
func screenshot(r winRect, path string) string {
	w, h := r.Right-r.Left, r.Bottom-r.Top
	if w <= 0 || h <= 0 {
		return ""
	}
	screen, _, _ := pGetDC.Call(0)
	defer pReleaseDC.Call(0, screen)
	mem, _, _ := pCreateCompatibleDC.Call(screen)
	defer pDeleteDC.Call(mem)
	bmp, _, _ := pCreateCompatibleBmp.Call(screen, uintptr(w), uintptr(h))
	defer pDeleteObject.Call(bmp)
	old, _, _ := pSelectObject.Call(mem, bmp)
	pBitBlt.Call(mem, 0, 0, uintptr(w), uintptr(h), screen, uintptr(r.Left), uintptr(r.Top), 0x00CC0020) // SRCCOPY
	pSelectObject.Call(mem, old)
	stride := (int(w)*3 + 3) &^ 3
	pixels := make([]byte, stride*int(h))
	info := make([]byte, 40)
	binary.LittleEndian.PutUint32(info[0:], 40)
	binary.LittleEndian.PutUint32(info[4:], uint32(w))
	binary.LittleEndian.PutUint32(info[8:], uint32(h))
	binary.LittleEndian.PutUint16(info[12:], 1)
	binary.LittleEndian.PutUint16(info[14:], 24)
	pGetDIBits.Call(mem, bmp, 0, uintptr(h), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&info[0])), 0)
	head := make([]byte, 14)
	head[0], head[1] = 'B', 'M'
	binary.LittleEndian.PutUint32(head[2:], uint32(54+len(pixels)))
	binary.LittleEndian.PutUint32(head[10:], 54)
	f, err := os.Create(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	f.Write(head)
	f.Write(info)
	f.Write(pixels)
	return path
}
