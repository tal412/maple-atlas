//go:build desktopui && windows

package main

// --capture-demo [image.png]: opens a stand-in game window titled "Fake MapleStory" that
// shows a Quest Helper panel (drawn text, or the given picture), then finds it by title,
// captures it and reads it with Windows' text recognition, as the app does. Prints the
// lines as JSON and exits 0 when the window was found and "18 / 20 Pig's Ribbon" was read
// (with a picture: when any line was read).

import (
	"encoding/json"
	"image"
	"image/draw"
	_ "image/png"
	"os"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var pStretchDIBits = gdi32.NewProc("StretchDIBits")

func init() { captureDemo = runCaptureDemo }

var demoPanel = []string{"Quest Helper (2/5)", "Make a Match Cards Set", "15 / 15 Monster Card", "", "Mrs. Ming Ming's First Worry", "10 / 10 Slime Bubble", "18 / 20 Pig's Ribbon"}

func runCaptureDemo(picture string) int {
	var pic *image.RGBA
	if picture != "" {
		f, err := os.Open(picture)
		if err != nil {
			os.Stdout.WriteString(`{"error":"` + err.Error() + `"}` + "\n")
			return 2
		}
		img, _, err := image.Decode(f)
		f.Close()
		if err != nil {
			os.Stdout.WriteString(`{"error":"` + err.Error() + `"}` + "\n")
			return 2
		}
		pic = image.NewRGBA(img.Bounds())
		draw.Draw(pic, pic.Bounds(), img, img.Bounds().Min, draw.Src)
	}
	ready := make(chan uintptr)
	go func() {
		runtime.LockOSThread()
		class := utf16("FakeGameCapture")
		proc := syscall.NewCallback(func(h, m, w, l uintptr) uintptr {
			if m == wmPaint {
				var ps paintStruct
				hdc, _, _ := pBeginPaint.Call(h, uintptr(unsafe.Pointer(&ps)))
				paintDemo(hdc, h, pic)
				pEndPaint.Call(h, uintptr(unsafe.Pointer(&ps)))
				return 0
			}
			r, _, _ := pDefWindowProcW.Call(h, m, w, l)
			return r
		})
		wc := wndClassEx{WndProc: proc, ClassName: class}
		wc.Size = uint32(unsafe.Sizeof(wc))
		pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
		const overlapped, visible = 0x00CF0000, 0x10000000
		h, _, _ := pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(utf16("Fake MapleStory"))), overlapped|visible, 0, 0, 1000, 700, 0, 0, 0, 0)
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
	demo := <-ready
	pSetForegroundWindow.Call(demo)
	time.Sleep(1500 * time.Millisecond)

	found, title := findGameWindow()
	report := map[string]any{"found": found == demo, "title": title}
	f, err := grabWindow(found)
	if err != nil {
		report["error"] = err.Error()
		return demoReport(report, 1)
	}
	report["size"] = []int{f.W, f.H}
	// The panel sits at the top right, as in the game; read the same box the app reads.
	box, _ := cropScale(f, .55, 0, .45, .5, 2600)
	if pic != nil {
		box = f
	}
	started := time.Now()
	lines, err := recognizeText(box)
	report["ms"] = time.Since(started).Milliseconds()
	if err != nil {
		report["error"] = err.Error()
		return demoReport(report, 1)
	}
	again := time.Now()
	recognizeText(box)
	report["msWarm"] = time.Since(again).Milliseconds()
	report["lines"] = lines
	var rect winRect
	pGetWindowRect.Call(demo, uintptr(unsafe.Pointer(&rect)))
	report["screenshot"] = screenshot(rect, "capture-demo.bmp")
	if found != demo {
		return demoReport(report, 1)
	}
	if pic != nil {
		return demoReport(report, map[bool]int{true: 0, false: 1}[len(lines) > 0])
	}
	want := regexp.MustCompile(`^18\s*/\s*20\s+Pig'?s Ribbon$`)
	for _, l := range lines {
		if want.MatchString(strings.TrimSpace(l.Text)) {
			return demoReport(report, 0)
		}
	}
	return demoReport(report, 1)
}

func demoReport(report map[string]any, code int) int {
	b, _ := json.Marshal(report)
	os.Stdout.Write(append(b, '\n'))
	return code
}

// paintDemo draws the stand-in game: green scenery and, at the top right, a light-blue
// Quest Helper panel with dark text; or the given picture at the top right.
func paintDemo(hdc, hwnd uintptr, pic *image.RGBA) {
	var rc winRect
	pGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
	right := rc.Right
	bg, _, _ := pCreateSolidBrush.Call(rgb(70, 140, 80))
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&rc)), bg)
	pDeleteObject.Call(bg)
	if pic != nil {
		b := pic.Bounds()
		w, h := b.Dx(), b.Dy()
		bi := bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
		bi.Size = uint32(unsafe.Sizeof(bi))
		bgra := make([]byte, len(pic.Pix))
		for i := 0; i < len(bgra); i += 4 {
			bgra[i], bgra[i+1], bgra[i+2], bgra[i+3] = pic.Pix[i+2], pic.Pix[i+1], pic.Pix[i], 255
		}
		pStretchDIBits.Call(hdc, uintptr(max(0, int(right)-w)), 0, uintptr(w), uintptr(h), 0, 0, uintptr(w), uintptr(h),
			uintptr(unsafe.Pointer(&bgra[0])), uintptr(unsafe.Pointer(&bi)), 0, 0x00CC0020)
		return
	}
	panel := winRect{Left: right - 360, Top: 20, Right: right - 10, Bottom: 230}
	blue, _, _ := pCreateSolidBrush.Call(rgb(150, 190, 235))
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&panel)), blue)
	pDeleteObject.Call(blue)
	fontHeight := int32(-15)
	font, _, _ := pCreateFontW.Call(uintptr(uint32(fontHeight)), 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(utf16("Tahoma"))))
	old, _, _ := pSelectObject.Call(hdc, font)
	pSetBkMode.Call(hdc, 1)
	pSetTextColor.Call(hdc, rgb(25, 25, 30))
	for i, line := range demoPanel {
		box := winRect{Left: right - 348, Top: int32(28 + i*26), Right: right - 14, Bottom: int32(28 + i*26 + 24)}
		pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16(line))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), 0x20|0x800) // DT_SINGLELINE|DT_NOPREFIX
	}
	pSelectObject.Call(hdc, old)
	pDeleteObject.Call(font)
}
