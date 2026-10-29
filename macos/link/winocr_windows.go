//go:build desktopui && windows

package main

// Windows' built-in text recognition (Windows.Media.Ocr, Windows 10 and 11), called
// through WinRT directly. It reads the game's Quest Helper far better than the bundled
// Tesseract. Everything runs on one OS thread that owns the WinRT apartment.

import (
	"errors"
	"math"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	ole "github.com/go-ole/go-ole"
)

type ocrLine struct {
	Text string  `json:"text"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
}

var (
	iidOcrEngineStatics      = ole.NewGUID("5BFFA85A-3384-3540-9940-699120D428A8")
	iidLanguageFactory       = ole.NewGUID("9B0252AC-0C27-44F8-B792-9793FB66C63E")
	iidSoftwareBitmapStatics = ole.NewGUID("DF0385DB-672F-4A9D-806E-C2442F343E86")
	iidCryptoBufferStatics   = ole.NewGUID("320B7E22-3CB0-4CDF-8663-1D28910065EB")
	iidAsyncInfo             = ole.NewGUID("00000036-0000-0000-C000-000000000046")
)

// comObj is a COM/WinRT interface pointer: its first word points at the method table.
type comObj struct{ vtbl *[64]uintptr }

// vcall calls method idx of a COM/WinRT interface.
func vcall(obj *comObj, idx int, args ...uintptr) error {
	r, _, _ := syscall.SyscallN(obj.vtbl[idx], append([]uintptr{uintptr(unsafe.Pointer(obj))}, args...)...)
	if int32(r) < 0 {
		return ole.NewError(r)
	}
	return nil
}

func ptr(o *comObj) uintptr   { return uintptr(unsafe.Pointer(o)) }
func outp(o **comObj) uintptr { return uintptr(unsafe.Pointer(o)) }

func comRelease(obj *comObj) {
	if obj != nil {
		vcall(obj, 2)
	}
}

func factory(class string, iid *ole.GUID) (*comObj, error) {
	f, err := ole.RoGetActivationFactory(class, iid)
	if err != nil {
		return nil, err
	}
	return (*comObj)(unsafe.Pointer(f)), nil
}

type ocrJob struct {
	f    frame
	done chan ocrResult
}
type ocrResult struct {
	lines []ocrLine
	err   error
}

var (
	ocrOnce  sync.Once
	ocrQueue = make(chan ocrJob)
	ocrReady = make(chan error, 1)
)

// recognizeText reads the lines in f (pixel boxes in f's own coordinates).
func recognizeText(f frame) ([]ocrLine, error) {
	ocrOnce.Do(func() { go ocrWorker() })
	job := ocrJob{f: f, done: make(chan ocrResult, 1)}
	select {
	case ocrQueue <- job:
	case <-time.After(15 * time.Second):
		return nil, errors.New("text recognition is busy")
	}
	r := <-job.done
	return r.lines, r.err
}

type ocrEngine struct {
	engine, bitmaps, buffers *comObj
	maxSide                  int
}

func ocrWorker() {
	runtime.LockOSThread()
	e, err := newOcrEngine()
	for job := range ocrQueue {
		if err != nil {
			job.done <- ocrResult{err: err}
			continue
		}
		lines, rerr := e.recognize(job.f)
		job.done <- ocrResult{lines: lines, err: rerr}
	}
}

func newOcrEngine() (*ocrEngine, error) {
	if err := ole.RoInitialize(1); err != nil { // multithreaded apartment
		if oe, ok := err.(*ole.OleError); !ok || oe.Code() != 1 { // S_FALSE: already initialized
			return nil, err
		}
	}
	statics, err := factory("Windows.Media.Ocr.OcrEngine", iidOcrEngineStatics)
	if err != nil {
		return nil, errors.New("Windows text recognition is not available: " + err.Error())
	}
	defer comRelease(statics)
	e := &ocrEngine{}
	// English first (quest and item names are English); else the user's own languages.
	if langs, err := factory("Windows.Globalization.Language", iidLanguageFactory); err == nil {
		if tag, err := ole.NewHString("en-US"); err == nil {
			var lang *comObj
			if vcall(langs, 6, uintptr(tag), outp(&lang)) == nil && lang != nil {
				vcall(statics, 9, ptr(lang), outp(&e.engine))
				comRelease(lang)
			}
			ole.DeleteHString(tag)
		}
		comRelease(langs)
	}
	if e.engine == nil {
		vcall(statics, 10, outp(&e.engine))
	}
	if e.engine == nil {
		return nil, errors.New("Windows text recognition has no English language pack (Settings › Time & language › Language: add English)")
	}
	var maxDim uint32
	if vcall(statics, 6, uintptr(unsafe.Pointer(&maxDim))) == nil && maxDim > 0 {
		e.maxSide = int(maxDim)
	} else {
		e.maxSide = 2600
	}
	if e.bitmaps, err = factory("Windows.Graphics.Imaging.SoftwareBitmap", iidSoftwareBitmapStatics); err != nil {
		return nil, err
	}
	if e.buffers, err = factory("Windows.Security.Cryptography.CryptographicBuffer", iidCryptoBufferStatics); err != nil {
		return nil, err
	}
	return e, nil
}

func (e *ocrEngine) recognize(f frame) ([]ocrLine, error) {
	if f.W < 8 || f.H < 8 {
		return nil, errors.New("image too small")
	}
	// Game text is small: about twice its screen size reads best, within the engine's limit.
	k := math.Min(2, float64(e.maxSide)/float64(max(f.W, f.H)))
	img := f
	if k > 1.01 {
		img = enlarged(f, k)
	} else if k < 1 {
		img, k = cropScale(f, 0, 0, 1, 1, e.maxSide)
	} else {
		k = 1
	}
	bgra := make([]byte, len(img.Pix))
	for i := 0; i < len(bgra); i += 4 {
		bgra[i], bgra[i+1], bgra[i+2], bgra[i+3] = img.Pix[i+2], img.Pix[i+1], img.Pix[i], 255
	}
	var buffer, bitmap, op, info, result, lines *comObj
	defer func() {
		comRelease(lines)
		comRelease(result)
		comRelease(info)
		comRelease(op)
		comRelease(bitmap)
		comRelease(buffer)
	}()
	err := vcall(e.buffers, 9, uintptr(len(bgra)), uintptr(unsafe.Pointer(&bgra[0])), outp(&buffer))
	runtime.KeepAlive(bgra)
	if err != nil {
		return nil, err
	}
	const bgra8 = 87
	if err := vcall(e.bitmaps, 9, ptr(buffer), bgra8, uintptr(img.W), uintptr(img.H), outp(&bitmap)); err != nil {
		return nil, err
	}
	if err := vcall(e.engine, 6, ptr(bitmap), outp(&op)); err != nil {
		return nil, err
	}
	if err := vcall(op, 0, uintptr(unsafe.Pointer(iidAsyncInfo)), outp(&info)); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		var status int32
		if err := vcall(info, 7, uintptr(unsafe.Pointer(&status))); err != nil {
			return nil, err
		}
		if status == 1 {
			break
		}
		if status > 1 {
			return nil, errors.New("text recognition failed")
		}
		if time.Now().After(deadline) {
			vcall(info, 9)
			return nil, errors.New("text recognition timed out")
		}
		time.Sleep(4 * time.Millisecond)
	}
	if err := vcall(op, 8, outp(&result)); err != nil {
		return nil, err
	}
	if err := vcall(result, 6, outp(&lines)); err != nil {
		return nil, err
	}
	var n uint32
	vcall(lines, 7, uintptr(unsafe.Pointer(&n)))
	out := make([]ocrLine, 0, n)
	for i := uint32(0); i < n; i++ {
		var line *comObj
		if vcall(lines, 6, uintptr(i), outp(&line)) != nil || line == nil {
			continue
		}
		l := ocrLine{Text: hstringText(line, 7)}
		var words *comObj
		if vcall(line, 6, outp(&words)) == nil && words != nil {
			var wn uint32
			vcall(words, 7, uintptr(unsafe.Pointer(&wn)))
			x0, y0, x1, y1 := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
			for j := uint32(0); j < wn; j++ {
				var word *comObj
				if vcall(words, 6, uintptr(j), outp(&word)) != nil || word == nil {
					continue
				}
				var r struct{ X, Y, W, H float32 }
				if vcall(word, 6, uintptr(unsafe.Pointer(&r))) == nil {
					x0, y0 = math.Min(x0, float64(r.X)), math.Min(y0, float64(r.Y))
					x1, y1 = math.Max(x1, float64(r.X+r.W)), math.Max(y1, float64(r.Y+r.H))
				}
				comRelease(word)
			}
			comRelease(words)
			if x1 > x0 {
				l.X, l.Y, l.W, l.H = x0/k, y0/k, (x1-x0)/k, (y1-y0)/k
			}
		}
		comRelease(line)
		if l.Text != "" {
			out = append(out, l)
		}
	}
	return out, nil
}

// hstringText calls a getter returning an HSTRING and frees it.
func hstringText(obj *comObj, idx int) string {
	var hs uintptr
	if vcall(obj, idx, uintptr(unsafe.Pointer(&hs))) != nil || hs == 0 {
		return ""
	}
	s := ole.HString(hs).String()
	ole.DeleteHString(ole.HString(hs))
	return s
}
