package main

import "math"

// frame is one captured picture of the game window: RGBA, top-left origin, 4 bytes a pixel.
type frame struct {
	W, H int
	Pix  []byte
}

// cropScale cuts the normalized region (x, y, w, h in 0…1) out of f and shrinks it so
// its longer side is at most maxSide (0: no limit). Shrinking averages each source area,
// so thin strokes and the minimap's coloured dots keep their colour. Returns the crop and
// the factor it was scaled by.
func cropScale(f frame, x, y, w, h float64, maxSide int) (frame, float64) {
	clamp := func(v float64) float64 { return math.Max(0, math.Min(1, v)) }
	x0, y0 := int(math.Round(clamp(x)*float64(f.W))), int(math.Round(clamp(y)*float64(f.H)))
	x1, y1 := int(math.Round(clamp(x+w)*float64(f.W))), int(math.Round(clamp(y+h)*float64(f.H)))
	if x1-x0 < 1 || y1-y0 < 1 {
		return frame{}, 1
	}
	cw, ch := x1-x0, y1-y0
	scale := 1.0
	if longest := max(cw, ch); maxSide > 0 && longest > maxSide {
		scale = float64(maxSide) / float64(longest)
	}
	ow, oh := max(1, int(math.Round(float64(cw)*scale))), max(1, int(math.Round(float64(ch)*scale)))
	out := frame{W: ow, H: oh, Pix: make([]byte, ow*oh*4)}
	for oy := 0; oy < oh; oy++ {
		sy0, sy1 := y0+oy*ch/oh, y0+(oy+1)*ch/oh
		if sy1 <= sy0 {
			sy1 = sy0 + 1
		}
		for ox := 0; ox < ow; ox++ {
			sx0, sx1 := x0+ox*cw/ow, x0+(ox+1)*cw/ow
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			var r, g, b, n int
			for sy := sy0; sy < sy1; sy++ {
				i := (sy*f.W + sx0) * 4
				for sx := sx0; sx < sx1; sx++ {
					r += int(f.Pix[i])
					g += int(f.Pix[i+1])
					b += int(f.Pix[i+2])
					n++
					i += 4
				}
			}
			o := (oy*ow + ox) * 4
			out.Pix[o], out.Pix[o+1], out.Pix[o+2], out.Pix[o+3] = byte(r/n), byte(g/n), byte(b/n), 255
		}
	}
	return out, scale
}

// enlarged scales f up by k (k ≥ 1) with bilinear filtering: text recognition reads
// small game text better at about twice its screen size.
func enlarged(f frame, k float64) frame {
	if k <= 1.01 {
		return f
	}
	ow, oh := int(float64(f.W)*k), int(float64(f.H)*k)
	out := frame{W: ow, H: oh, Pix: make([]byte, ow*oh*4)}
	for oy := 0; oy < oh; oy++ {
		fy := math.Max(0, (float64(oy)+.5)/k-.5)
		y0 := min(int(fy), f.H-1)
		y1, ty := min(y0+1, f.H-1), fy-float64(int(fy))
		for ox := 0; ox < ow; ox++ {
			fx := math.Max(0, (float64(ox)+.5)/k-.5)
			x0 := min(int(fx), f.W-1)
			x1, tx := min(x0+1, f.W-1), fx-float64(int(fx))
			o := (oy*ow + ox) * 4
			for c := 0; c < 3; c++ {
				p := func(x, y int) float64 { return float64(f.Pix[(y*f.W+x)*4+c]) }
				top := p(x0, y0)*(1-tx) + p(x1, y0)*tx
				bottom := p(x0, y1)*(1-tx) + p(x1, y1)*tx
				out.Pix[o+c] = byte(math.Round(top*(1-ty) + bottom*ty))
			}
			out.Pix[o+3] = 255
		}
	}
	return out
}

// isBlank: almost every sampled pixel is black (a window that could not be captured).
func isBlank(f frame) bool {
	if f.W == 0 || f.H == 0 {
		return true
	}
	lit, all := 0, 0
	for y := 0; y < f.H; y += max(1, f.H/40) {
		for x := 0; x < f.W; x += max(1, f.W/40) {
			i := (y*f.W + x) * 4
			all++
			if int(f.Pix[i])+int(f.Pix[i+1])+int(f.Pix[i+2]) > 30 {
				lit++
			}
		}
	}
	return lit*50 < all
}
