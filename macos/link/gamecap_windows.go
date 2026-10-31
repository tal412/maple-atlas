//go:build desktopui && windows

package main

// Finding and capturing the game window on Windows, so the app needs no share-picker
// click: the visible top-level window whose title holds "MapleStory" is read with
// PrintWindow (full DirectX content, works behind other windows), else copied from the
// screen while it is in front.

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

var (
	pGetClientRect    = user32.NewProc("GetClientRect")
	pClientToScreen   = user32.NewProc("ClientToScreen")
	pPrintWindow      = user32.NewProc("PrintWindow")
	pCreateDIBSection = gdi32.NewProc("CreateDIBSection")
)

// Physical pixels everywhere (set before any window exists; the overlay asks again).
func init() { pSetProcessDpiAwareContext.Call(^uintptr(3)) }

type bitmapInfoHeader struct {
	Size                         uint32
	Width, Height                int32
	Planes, BitCount             uint16
	Compression, SizeImage       uint32
	XPelsPerMeter, YPelsPerMeter int32
	ClrUsed, ClrImportant        uint32
}

func windowTitle(h uintptr) string {
	buf := make([]uint16, 256)
	n, _, _ := pGetWindowTextW.Call(h, uintptr(unsafe.Pointer(&buf[0])), 256)
	return syscall.UTF16ToString(buf[:n])
}

func clientSize(h uintptr) (int, int) {
	var rc winRect
	pGetClientRect.Call(h, uintptr(unsafe.Pointer(&rc)))
	return int(rc.Right - rc.Left), int(rc.Bottom - rc.Top)
}

// allowOwnWindows lets the --capture-demo self-check find its stand-in window, which belongs
// to this program (never set otherwise).
var allowOwnWindows bool

var (
	pGetWindowThreadProcessId  = user32.NewProc("GetWindowThreadProcessId")
	pQueryFullProcessImageName = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")
)

// windowProgram: the path of the program that owns a window ("" when Windows won't say).
func windowProgram(h uintptr) string {
	var pid uint32
	pGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return ""
	}
	const queryLimited = 0x1000
	proc, err := syscall.OpenProcess(queryLimited, false, pid)
	if err != nil {
		return ""
	}
	defer syscall.CloseHandle(proc)
	buf := make([]uint16, 1024)
	n := uint32(len(buf))
	if ok, _, _ := pQueryFullProcessImageName.Call(uintptr(proc), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); ok == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:n])
}

// findGameWindow returns the game's own window, or 0: never the launcher, Steam, a browser
// or Maple Atlas (gameWindowRank). Of several, the one titled exactly "MapleStory", then the
// largest.
func findGameWindow() (uintptr, string) {
	var best uintptr
	var bestTitle string
	bestRank, bestArea := 0, 0
	self, _ := os.Executable()
	cb := syscall.NewCallback(func(h, _ uintptr) uintptr {
		if v, _, _ := pIsWindowVisible.Call(h); v == 0 {
			return 1
		}
		title := windowTitle(h)
		if !strings.Contains(strings.ToLower(title), "maplestory") {
			return 1
		}
		exe := windowProgram(h)
		if allowOwnWindows && strings.EqualFold(exe, self) {
			exe = ""
		}
		rank := gameWindowRank(title, exe)
		if rank == 0 {
			return 1
		}
		w, hh := clientSize(h)
		if iconic, _, _ := pIsIconic.Call(h); iconic == 0 && (w < 320 || hh < 240) {
			return 1
		}
		if rank > bestRank || rank == bestRank && w*hh >= bestArea {
			best, bestTitle, bestRank, bestArea = h, title, rank, w*hh
		}
		return 1
	})
	pEnumWindows.Call(cb, 0)
	return best, bestTitle
}

// grabWindowCheck: the remembered window still exists and is shown.
func grabWindowCheck(h uintptr) (struct{}, error) {
	if ok, _, _ := pIsWindow.Call(h); ok == 0 {
		return struct{}{}, errNoGame
	}
	if v, _, _ := pIsWindowVisible.Call(h); v == 0 {
		return struct{}{}, errNoGame
	}
	return struct{}{}, nil
}

// grabWindow copies the window's client area.
func grabWindow(h uintptr) (frame, error) {
	if ok, _, _ := pIsWindow.Call(h); ok == 0 {
		return frame{}, errors.New("the game window was closed")
	}
	if iconic, _, _ := pIsIconic.Call(h); iconic != 0 {
		return frame{}, errors.New("the game window is minimized")
	}
	w, hh := clientSize(h)
	if w < 16 || hh < 16 {
		return frame{}, errors.New("the game window is too small")
	}
	screen, _, _ := pGetDC.Call(0)
	defer pReleaseDC.Call(0, screen)
	mem, _, _ := pCreateCompatibleDC.Call(screen)
	defer pDeleteDC.Call(mem)
	bi := bitmapInfoHeader{Width: int32(w), Height: -int32(hh), Planes: 1, BitCount: 32}
	bi.Size = uint32(unsafe.Sizeof(bi))
	var bits unsafe.Pointer
	dib, _, _ := pCreateDIBSection.Call(screen, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if dib == 0 || bits == nil {
		return frame{}, errors.New("could not make a capture buffer")
	}
	defer pDeleteObject.Call(dib)
	old, _, _ := pSelectObject.Call(mem, dib)
	defer pSelectObject.Call(mem, old)
	raw := unsafe.Slice((*byte)(bits), w*hh*4)
	read := func() frame {
		f := frame{W: w, H: hh, Pix: make([]byte, len(raw))}
		for i := 0; i < len(raw); i += 4 { // BGRA -> RGBA
			f.Pix[i], f.Pix[i+1], f.Pix[i+2], f.Pix[i+3] = raw[i+2], raw[i+1], raw[i], 255
		}
		return f
	}
	// PW_CLIENTONLY | PW_RENDERFULLCONTENT
	if ok, _, _ := pPrintWindow.Call(h, mem, 3); ok != 0 {
		if f := read(); !isBlank(f) {
			return f, nil
		}
	}
	// Some games only draw to the screen: copy it there while the game is in front.
	if front, _, _ := pGetForegroundWindow.Call(); front != h {
		return frame{}, errors.New("the game window is behind another window")
	}
	var pt struct{ X, Y int32 }
	pClientToScreen.Call(h, uintptr(unsafe.Pointer(&pt)))
	const srcCopy, captureBlt = 0x00CC0020, 0x40000000
	if ok, _, _ := pBitBlt.Call(mem, 0, 0, uintptr(w), uintptr(hh), screen, uintptr(pt.X), uintptr(pt.Y), srcCopy|captureBlt); ok == 0 {
		return frame{}, errors.New("could not copy the game window")
	}
	f := read()
	if isBlank(f) {
		return frame{}, errors.New("the game window shows only black")
	}
	return f, nil
}
