//go:build desktopui && !windows

package main

import "errors"

// Desktop mode on a Mac or Linux (development only): no window finding or system OCR;
// the page falls back to the share picker and the bundled reader.

type ocrLine struct {
	Text       string  `json:"text"`
	X, Y, W, H float64 `json:"-"`
}

func findGameWindow() (uintptr, string, int)    { return 0, "", 0 }
func grabWindow(uintptr) (frame, error)         { return frame{}, errNoGame }
func grabWindowCheck(uintptr) (struct{}, error) { return struct{}{}, errNoGame }
func recognizeText(frame) ([]ocrLine, error) {
	return nil, errors.New("system text recognition is only used on Windows")
}
