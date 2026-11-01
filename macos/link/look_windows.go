//go:build desktopui && windows

package main

// The Look feature on Windows: the helper captures the game window and reads its text itself,
// then sends the screenshot to the phone (look.go).

import (
	"bytes"
	"image"
	"image/jpeg"
)

func init() { lookRequested = lookFromGame }

// lookShotOf makes a screenshot of the game window, at most 1600 px wide, with its text.
func lookShotOf(req string, mark []float64) (lookShot, error) {
	f, _, err := game.grab()
	if err != nil {
		return lookShot{}, err
	}
	shot, _ := cropScale(f, 0, 0, 1, 1, 1600)
	img := &image.RGBA{Pix: shot.Pix, Stride: shot.W * 4, Rect: image.Rect(0, 0, shot.W, shot.H)}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 82}); err != nil {
		return lookShot{}, err
	}
	var lines []lookLine
	if found, err := recognizeText(shot); err == nil {
		for _, l := range found {
			lines = append(lines, lookLine{Text: l.Text, X: l.X, Y: l.Y, W: l.W, H: l.H})
		}
	}
	return lookShot{Req: req, JPEG: buf.Bytes(), W: shot.W, H: shot.H, Lines: lines, Mark: mark}, nil
}

func lookFromGame(s *session, req string) {
	shot, err := lookShotOf(req, nil)
	if err == nil {
		err = s.sendLook(shot)
	}
	if err != nil {
		s.sendLookError(req, "Could not take a screenshot of the game: "+err.Error())
		gameLog("look: %v", err)
		return
	}
	gameLog("look: sent a %d×%d screenshot (%d KB, %d text lines)", shot.W, shot.H, len(shot.JPEG)/1024, len(shot.Lines))
}
