#!/usr/bin/env python3
"""Prepare reproducible PUBLIC-image crops; optional private photos stay ignored."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.openai/vision-benchmark'
parser = argparse.ArgumentParser()
parser.add_argument('--photo', type=Path)
parser.add_argument('--expected', help='Known map ID for the optional photo')
args = parser.parse_args()
if args.photo and not args.expected:
    parser.error('--photo requires --expected')
OUT.mkdir(parents=True, exist_ok=True)
rows = []

def read(path):
    im = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if im is None:
        raise ValueError(f'Cannot read {path}')
    if im.ndim == 2:
        return cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
    if im.shape[2] == 4:
        alpha = im[:, :, 3:4] / 255
        im = (im[:, :, :3] * alpha + 60 * (1-alpha)).astype('uint8')
    return im

def add(name, im, expected, kind):
    scale = min(1, 960/max(im.shape[:2]))
    im = cv2.resize(im, None, fx=scale, fy=scale)
    rgba = cv2.cvtColor(im, cv2.COLOR_BGR2RGBA)
    filename = name + '.rgba'
    (OUT / filename).write_bytes(rgba.tobytes())
    rows.append(dict(name=name, file=filename, width=im.shape[1], height=im.shape[0], expected=expected, kind=kind))

sources = json.loads((ROOT / 'data/visual-sources.json').read_text())
scene_ids = {'10000000','10003080','10001000','10002000','10004000','10005000','1','90040000'}
for m in sources['maps']:
    im = read(ROOT / 'docs' / (m['preview'] or m['image'])['path'])
    scale = 600/max(im.shape[:2])
    im = cv2.resize(im, None, fx=scale, fy=scale)
    h, w = im.shape[:2]
    add('catalog-'+m['id'], im[h//10:h,w//5:max(w//5+1,w*4//5)], m['id'], 'synthetic partial')
    if m['id'] in scene_ids:
        im = read(ROOT / 'docs' / m['image']['path'])
        h, w = im.shape[:2]
        add('scene-'+m['id'], im[max(0,h//2-300):min(h,h//2+300),max(0,w//2-480):min(w,w//2+480)], m['id'], 'synthetic game scene')
add('solid', np.full((400,600,3),65,np.uint8), None, 'negative')
add('noise', np.random.default_rng(20).integers(0,256,(400,600,3),dtype=np.uint8), None, 'negative')
if args.photo:
    add('private-photo', read(args.photo), args.expected, 'real photo')
(OUT / 'fixtures.json').write_text(json.dumps(rows))
print(f'Prepared {len(rows)} cases under ignored .openai/vision-benchmark.')
