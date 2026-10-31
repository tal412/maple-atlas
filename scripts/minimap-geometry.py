"""Where each map's in-game minimap picture sits on the map, so the player's dot can be
placed by where it is on that picture (no portal rings needed).

The minimap picture (data/map-assets.json "preview") is the map drawn at 1/16 scale with its
own margins; the full map image ("image") is in map coordinates (portals and spawn points
match its pixels). Each map's offset is found by sliding the 1/16-scaled map image over the
minimap picture and keeping the best match (normalized correlation). Then

    map x = 16 * (minimap x + dx),   map y = 16 * (minimap y + dy)

Writes data/minimap-geometry.json: {"scale": 16, "maps": {id: {"w", "h", "dx", "dy", "score"}}}
for maps whose match scored at least MIN_SCORE. Needs numpy and Pillow (build-time only).

    python3 scripts/minimap-geometry.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SCALE = 16
SEARCH = 40          # offsets tried, in minimap pixels, each way
MIN_SCORE = 0.6


def gray(image):
    image = image.convert('RGBA')
    flat = Image.new('RGBA', image.size, (0, 0, 0, 255))
    flat.alpha_composite(image)
    return np.asarray(flat.convert('L'), dtype=np.float32)


def register(big, mini):
    small = gray(big.resize((max(1, round(big.width / SCALE)), max(1, round(big.height / SCALE))), Image.BILINEAR))
    m = gray(mini)
    best = (-2.0, 0, 0)
    for dy in range(-SEARCH, SEARCH + 1):
        for dx in range(-SEARCH, SEARCH + 1):
            x0, y0 = max(0, -dx), max(0, -dy)
            x1, y1 = min(m.shape[1], small.shape[1] - dx), min(m.shape[0], small.shape[0] - dy)
            if x1 - x0 < m.shape[1] * .6 or y1 - y0 < m.shape[0] * .6:
                continue
            a = m[y0:y1, x0:x1] - m[y0:y1, x0:x1].mean()
            b = small[y0 + dy:y1 + dy, x0 + dx:x1 + dx]
            b = b - b.mean()
            d = float(np.sqrt((a * a).sum() * (b * b).sum()))
            if d:
                c = float((a * b).sum() / d)
                if c > best[0]:
                    best = (c, dx, dy)
    return best


def main():
    assets = json.loads((ROOT / 'data/map-assets.json').read_text())['maps']
    out, weak = {}, []
    for mid, v in sorted(assets.items(), key=lambda kv: int(kv[0])):
        try:
            big = Image.open(ROOT / 'docs' / v['image']['path'])
            mini = Image.open(ROOT / 'docs' / v['preview']['path'])
        except (KeyError, OSError):
            continue
        score, dx, dy = register(big, mini)
        if score < MIN_SCORE:
            weak.append((mid, round(score, 3)))
            continue
        out[mid] = {'w': mini.width, 'h': mini.height, 'dx': dx, 'dy': dy, 'score': round(score, 3)}
    (ROOT / 'data/minimap-geometry.json').write_text(json.dumps({'scale': SCALE, 'maps': out}, separators=(',', ':')) + '\n')
    print(f'Placed {len(out)} minimap pictures; {len(weak)} matched too weakly: {weak[:12]}')


if __name__ == '__main__':
    main()
