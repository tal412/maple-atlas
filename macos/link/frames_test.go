package main

import "testing"

func solid(w, h int, r, g, b byte) frame {
	f := frame{W: w, H: h, Pix: make([]byte, w*h*4)}
	for i := 0; i < len(f.Pix); i += 4 {
		f.Pix[i], f.Pix[i+1], f.Pix[i+2], f.Pix[i+3] = r, g, b, 255
	}
	return f
}

func TestCropScale(t *testing.T) {
	f := solid(200, 100, 10, 20, 30)
	// The right half's top-right pixel is red.
	i := (0*200 + 199) * 4
	f.Pix[i], f.Pix[i+1], f.Pix[i+2] = 255, 0, 0
	c, s := cropScale(f, .5, 0, .5, 1, 0)
	if c.W != 100 || c.H != 100 || s != 1 {
		t.Fatalf("crop %dx%d scale %v", c.W, c.H, s)
	}
	if c.Pix[(99)*4] != 255 {
		t.Fatalf("red pixel lost: %v", c.Pix[99*4:99*4+4])
	}
	small, s := cropScale(f, 0, 0, 1, 1, 50)
	if small.W != 50 || small.H != 25 || s != .25 {
		t.Fatalf("scaled %dx%d scale %v", small.W, small.H, s)
	}
	if small.Pix[0] != 10 || small.Pix[1] != 20 || small.Pix[3] != 255 {
		t.Fatalf("average wrong: %v", small.Pix[:4])
	}
	if e, _ := cropScale(f, .9, .9, 0, 0, 0); e.W != 0 {
		t.Fatal("empty crop should be empty")
	}
}

func TestEnlargedAndBlank(t *testing.T) {
	f := solid(10, 4, 200, 100, 50)
	e := enlarged(f, 2)
	if e.W != 20 || e.H != 8 || e.Pix[0] != 200 || e.Pix[len(e.Pix)-3] != 100 {
		t.Fatalf("enlarged %dx%d %v", e.W, e.H, e.Pix[:4])
	}
	if !isBlank(solid(64, 64, 0, 0, 0)) || isBlank(f) {
		t.Fatal("blank check wrong")
	}
}
