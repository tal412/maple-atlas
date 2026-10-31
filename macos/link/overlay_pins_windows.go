//go:build desktopui && windows

package main

// The quests pinned on the phone, drawn in one row at the top of the game window: each
// objective's picture and count, a check when done, a divider between quests. A second
// click-through window, run on the overlay's thread.

import (
	"bytes"
	"encoding/json"
	"image"
	"image/draw"
	_ "image/png"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"
)

type pinObjective struct {
	Name    string   `json:"name"`
	Have    *int     `json:"have"`
	Need    *int     `json:"need"`
	Icon    string   `json:"icon"`
	Monster string   `json:"monster"` // ores: the monster that drops it most here
	Chance  *float64 `json:"chance"`  // ores: its drop chance in percent
}

type pinQuest struct {
	Title      string         `json:"title"`
	Ready      bool           `json:"ready"`
	Kind       string         `json:"kind"` // "ores" for the map's ores
	Objectives []pinObjective `json:"objectives"`
}

// overlayPins takes the helper's "pins" event (already checked by pinsEvent).
func overlayPins(v map[string]any) {
	b, _ := json.Marshal(v["quests"])
	var quests []pinQuest
	json.Unmarshal(b, &quests)
	o := overlay
	o.mu.Lock()
	o.pins = quests
	o.startLocked()
	h := o.pinsHwnd
	o.mu.Unlock()
	if h != 0 {
		pInvalidateRect.Call(h, 0, 0)
	}
	for _, q := range quests {
		for _, ob := range q.Objectives {
			icons.want(ob.Icon)
			icons.want(ob.Monster)
		}
	}
}

const (
	pinIcon   = 28
	pinHeight = 50
)

var pinCard = [3]byte{22, 24, 28} // the row's background, which icons are blended onto

// iconCache fetches each picture once (only datamine CDN addresses reach it), blends it onto
// the row's background and keeps it as BGRA pixels.
type iconCache struct {
	mu   sync.Mutex
	pix  map[string][]byte
	busy map[string]bool
}

var icons = &iconCache{pix: map[string][]byte{}, busy: map[string]bool{}}

func (c *iconCache) get(url string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pix[url]
}

func (c *iconCache) want(url string) {
	if !strings.HasPrefix(url, spriteBase) {
		return
	}
	c.mu.Lock()
	if c.pix[url] != nil || c.busy[url] || len(c.pix) > 300 {
		c.mu.Unlock()
		return
	}
	c.busy[url] = true
	c.mu.Unlock()
	go func() {
		pix := fetchIcon(url)
		c.mu.Lock()
		delete(c.busy, url)
		if pix != nil {
			c.pix[url] = pix
		}
		c.mu.Unlock()
		overlay.mu.Lock()
		h := overlay.pinsHwnd
		overlay.mu.Unlock()
		if h != 0 && pix != nil {
			pInvalidateRect.Call(h, 0, 0)
		}
	}()
}

func fetchIcon(url string) []byte {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 512<<10))
	if err != nil {
		return nil
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil
	}
	src := image.NewRGBA(img.Bounds())
	draw.Draw(src, src.Bounds(), img, img.Bounds().Min, draw.Src)
	// Fit into pinIcon×pinIcon, keeping pixels sharp (nearest), centred.
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	k := float64(pinIcon) / float64(max(w, h))
	if k > 2 {
		k = 2
	}
	ow, oh := max(1, int(float64(w)*k)), max(1, int(float64(h)*k))
	ox, oy := (pinIcon-ow)/2, (pinIcon-oh)/2
	out := make([]byte, pinIcon*pinIcon*4)
	for i := 0; i < pinIcon*pinIcon; i++ {
		out[i*4], out[i*4+1], out[i*4+2] = pinCard[2], pinCard[1], pinCard[0]
	}
	for y := 0; y < oh; y++ {
		for x := 0; x < ow; x++ {
			sx, sy := min(w-1, int(float64(x)/k)), min(h-1, int(float64(y)/k))
			p := src.Pix[(sy*w+sx)*4 : (sy*w+sx)*4+4]
			a := int(p[3])
			o := ((oy+y)*pinIcon + ox + x) * 4
			out[o] = byte((int(p[2])*a + int(pinCard[2])*(255-a)) / 255)
			out[o+1] = byte((int(p[1])*a + int(pinCard[1])*(255-a)) / 255)
			out[o+2] = byte((int(p[0])*a + int(pinCard[0])*(255-a)) / 255)
		}
	}
	return out
}

type pinItem struct {
	x, w     int32
	divider  bool
	flag     bool
	icon     string
	name     string
	have     string
	need     string
	done     bool
	countW   int32
	needW    int32
	haveFont uintptr
	monster  string // ores: the monster's picture, drawn smaller after the ore
	chance   string // ores: "2.9%"
}

var pGetTextExtentPoint32W = gdi32.NewProc("GetTextExtentPoint32W")

func textWidth(hdc uintptr, font uintptr, s string) int32 {
	if s == "" {
		return 0
	}
	old, _, _ := pSelectObject.Call(hdc, font)
	var size struct{ CX, CY int32 }
	u := utf16(s)
	pGetTextExtentPoint32W.Call(hdc, uintptr(unsafe.Pointer(u)), uintptr(len([]rune(s))), uintptr(unsafe.Pointer(&size)))
	pSelectObject.Call(hdc, old)
	return size.CX
}

// layoutPins places every part of the row; returns the items and the row's width.
func layoutPins(hdc uintptr, quests []pinQuest, scale float64) ([]pinItem, int32) {
	px := func(v float64) int32 { return int32(v * scale) }
	bold, light := makeFont(px(15), 700), makeFont(px(12), 500)
	defer pDeleteObject.Call(bold)
	defer pDeleteObject.Call(light)
	x := px(16)
	var items []pinItem
	for qi, q := range quests {
		if qi > 0 {
			items = append(items, pinItem{x: x + px(2), divider: true})
			x += px(14)
		}
		if q.Ready {
			items = append(items, pinItem{x: x, flag: true})
			x += px(24)
		}
		for _, ob := range q.Objectives {
			if q.Kind == "ores" {
				chance := "?"
				if ob.Chance != nil {
					switch c := *ob.Chance; {
					case c >= 10:
						chance = strconv.Itoa(int(c+0.5)) + "%"
					case c >= 1:
						chance = strconv.FormatFloat(c, 'f', 1, 64) + "%"
					default:
						chance = strconv.FormatFloat(c, 'f', 2, 64) + "%"
					}
				}
				it := pinItem{x: x, icon: ob.Icon, name: ob.Name, monster: ob.Monster, chance: chance}
				it.countW = textWidth(hdc, light, chance)
				it.w = px(pinIcon) + px(3) + px(22) + px(4) + it.countW
				items = append(items, it)
				x += it.w + px(12)
				continue
			}
			have, need := "?", "?"
			if ob.Have != nil {
				have = strconv.Itoa(*ob.Have)
			}
			if ob.Need != nil {
				need = strconv.Itoa(*ob.Need)
			}
			done := ob.Have != nil && ob.Need != nil && *ob.Have >= *ob.Need
			it := pinItem{x: x, icon: ob.Icon, name: ob.Name, have: have, need: "/" + need, done: done}
			it.countW, it.needW = textWidth(hdc, bold, have), textWidth(hdc, light, "/"+need)
			it.w = px(pinIcon) + px(5) + it.countW + it.needW
			if done {
				it.w += px(18)
			}
			items = append(items, it)
			x += it.w + px(12)
		}
	}
	return items, x - px(12) + px(16)
}

func (o *overlayState) paintPins(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	defer pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	var r winRect
	pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	w, h := r.Right-r.Left, r.Bottom-r.Top
	o.mu.Lock()
	quests := o.pins
	scale := dpiScale(o.game)
	o.mu.Unlock()
	px := func(v float64) int32 { return int32(v * scale) }

	key, _, _ := pCreateSolidBrush.Call(keyColor)
	full := winRect{0, 0, w, h}
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&full)), key)
	pDeleteObject.Call(key)
	card, _, _ := pCreateSolidBrush.Call(rgb(pinCard[0], pinCard[1], pinCard[2]))
	edge, _, _ := pCreatePen.Call(0, 1, rgb(70, 74, 82))
	oldB, _, _ := pSelectObject.Call(hdc, card)
	oldP, _, _ := pSelectObject.Call(hdc, edge)
	pRoundRect.Call(hdc, 0, 0, uintptr(w), uintptr(h), uintptr(h), uintptr(h))
	pSelectObject.Call(hdc, oldB)
	pSelectObject.Call(hdc, oldP)
	pDeleteObject.Call(card)
	pDeleteObject.Call(edge)

	items, _ := layoutPins(hdc, quests, scale)
	bold, light := makeFont(px(15), 700), makeFont(px(12), 500)
	defer pDeleteObject.Call(bold)
	defer pDeleteObject.Call(light)
	pSetBkMode.Call(hdc, 1)
	green := rgb(115, 230, 140)
	cy := h / 2
	for _, it := range items {
		switch {
		case it.divider:
			line, _, _ := pCreateSolidBrush.Call(rgb(90, 94, 102))
			bar := winRect{it.x, cy - px(13), it.x + px(1), cy + px(13)}
			pFillRect.Call(hdc, uintptr(unsafe.Pointer(&bar)), line)
			pDeleteObject.Call(line)
		case it.flag:
			f := makeFont(px(16), 700)
			old, _, _ := pSelectObject.Call(hdc, f)
			pSetTextColor.Call(hdc, green)
			box := winRect{it.x, 0, it.x + px(22), h}
			pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16("⚑"))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtSingleLine|dtVCenter|dtCenter)
			pSelectObject.Call(hdc, old)
			pDeleteObject.Call(f)
		case it.chance != "":
			size := px(pinIcon)
			drawPinIcon(hdc, it.icon, it.name, it.x, cy-size/2, size, bold, px)
			small := px(22)
			mx := it.x + size + px(3)
			drawPinIcon(hdc, it.monster, "?", mx, cy-small/2, small, light, px)
			old, _, _ := pSelectObject.Call(hdc, light)
			pSetTextColor.Call(hdc, rgb(255, 214, 79))
			box := winRect{mx + small + px(4), 0, mx + small + px(4) + it.countW + px(2), h}
			pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16(it.chance))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtSingleLine|dtVCenter|dtNoPrefix)
			pSelectObject.Call(hdc, old)
		default:
			size := px(pinIcon)
			top := cy - size/2
			if pix := icons.get(it.icon); pix != nil {
				bi := bitmapInfoHeader{Width: pinIcon, Height: -pinIcon, Planes: 1, BitCount: 32}
				bi.Size = uint32(unsafe.Sizeof(bi))
				pStretchDIBitsPins.Call(hdc, uintptr(it.x), uintptr(top), uintptr(size), uintptr(size), 0, 0, pinIcon, pinIcon,
					uintptr(unsafe.Pointer(&pix[0])), uintptr(unsafe.Pointer(&bi)), 0, 0x00CC0020)
			} else {
				// No picture (yet): the name's first letter in a soft circle.
				soft, _, _ := pCreateSolidBrush.Call(rgb(60, 64, 72))
				none, _, _ := pGetStockObject.Call(nullPen)
				ob, _, _ := pSelectObject.Call(hdc, soft)
				op, _, _ := pSelectObject.Call(hdc, none)
				pEllipse.Call(hdc, uintptr(it.x+px(1)), uintptr(top+px(1)), uintptr(it.x+size-px(1)), uintptr(top+size-px(1)))
				pSelectObject.Call(hdc, ob)
				pSelectObject.Call(hdc, op)
				pDeleteObject.Call(soft)
				old, _, _ := pSelectObject.Call(hdc, bold)
				pSetTextColor.Call(hdc, rgb(255, 255, 255))
				box := winRect{it.x, top, it.x + size, top + size}
				letter := strings.ToUpper(string([]rune(it.name + "?")[:1]))
				pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16(letter))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtSingleLine|dtVCenter|dtCenter)
				pSelectObject.Call(hdc, old)
			}
			color := rgb(255, 255, 255)
			if it.done {
				color = rgb(190, 194, 200)
			}
			tx := it.x + size + px(5)
			old, _, _ := pSelectObject.Call(hdc, bold)
			pSetTextColor.Call(hdc, color)
			box := winRect{tx, 0, tx + it.countW + px(2), h}
			pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16(it.have))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtSingleLine|dtVCenter|dtNoPrefix)
			pSelectObject.Call(hdc, light)
			box = winRect{tx + it.countW, px(2), tx + it.countW + it.needW + px(2), h}
			pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16(it.need))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtSingleLine|dtVCenter|dtNoPrefix)
			if it.done {
				pSetTextColor.Call(hdc, green)
				pSelectObject.Call(hdc, bold)
				box = winRect{tx + it.countW + it.needW + px(3), 0, tx + it.countW + it.needW + px(20), h}
				pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16("✓"))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtSingleLine|dtVCenter)
			}
			pSelectObject.Call(hdc, old)
		}
	}
}

var pStretchDIBitsPins = gdi32.NewProc("StretchDIBits")

// drawPinIcon draws a cached picture at (x, top), size×size, or the name's first letter in a
// soft circle while there is none.
func drawPinIcon(hdc uintptr, url, name string, x, top, size int32, font uintptr, px func(float64) int32) {
	if pix := icons.get(url); pix != nil {
		bi := bitmapInfoHeader{Width: pinIcon, Height: -pinIcon, Planes: 1, BitCount: 32}
		bi.Size = uint32(unsafe.Sizeof(bi))
		pStretchDIBitsPins.Call(hdc, uintptr(x), uintptr(top), uintptr(size), uintptr(size), 0, 0, pinIcon, pinIcon,
			uintptr(unsafe.Pointer(&pix[0])), uintptr(unsafe.Pointer(&bi)), 0, 0x00CC0020)
		return
	}
	soft, _, _ := pCreateSolidBrush.Call(rgb(60, 64, 72))
	none, _, _ := pGetStockObject.Call(nullPen)
	ob, _, _ := pSelectObject.Call(hdc, soft)
	op, _, _ := pSelectObject.Call(hdc, none)
	pEllipse.Call(hdc, uintptr(x+px(1)), uintptr(top+px(1)), uintptr(x+size-px(1)), uintptr(top+size-px(1)))
	pSelectObject.Call(hdc, ob)
	pSelectObject.Call(hdc, op)
	pDeleteObject.Call(soft)
	old, _, _ := pSelectObject.Call(hdc, font)
	pSetTextColor.Call(hdc, rgb(255, 255, 255))
	box := winRect{x, top, x + size, top + size}
	letter := strings.ToUpper(string([]rune(name + "?")[:1]))
	pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16(letter))), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtSingleLine|dtVCenter|dtCenter)
	pSelectObject.Call(hdc, old)
}

// placePins shows the row at the top centre of the game window and returns its height (0
// when hidden), so the route card goes under it.
func (o *overlayState) placePins(game uintptr, r winRect, show bool) int32 {
	o.mu.Lock()
	h, quests := o.pinsHwnd, o.pins
	o.mu.Unlock()
	if h == 0 {
		return 0
	}
	if !show || len(quests) == 0 {
		pShowWindow.Call(h, swHide)
		return 0
	}
	scale := dpiScale(game)
	screen, _, _ := pGetDC.Call(0)
	_, width := layoutPins(screen, quests, scale)
	pReleaseDC.Call(0, screen)
	if gw := r.Right - r.Left - int32(40*scale); width > gw {
		width = gw
	}
	height := int32(pinHeight * scale)
	x, y := r.Left+(r.Right-r.Left-width)/2, r.Top+int32(48*scale)
	pSetWindowPos.Call(h, ^uintptr(0), uintptr(x), uintptr(y), uintptr(width), uintptr(height), swpNoActivate|swpShowWindow)
	pInvalidateRect.Call(h, 0, 0)
	return height + int32(8*scale)
}
