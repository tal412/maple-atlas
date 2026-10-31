"""Copies each map's minimap picture (the phone's preview image, data/map-assets.json) into a
folder as <map id>.png, for the companion apps: a minimap whose picture is bigger than its
window scrolls, and the apps find how far by matching the window against this image.

    python3 scripts/minimap-images.py <destination folder>
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    dest = Path(sys.argv[1])
    dest.mkdir(parents=True, exist_ok=True)
    assets = json.loads((ROOT / 'data/map-assets.json').read_text())['maps']
    placed = json.loads((ROOT / 'data/minimap-geometry.json').read_text())['maps']
    n = 0
    for mid in placed:
        path = assets.get(mid, {}).get('preview', {}).get('path')
        if path and (ROOT / 'docs' / path).is_file():
            shutil.copyfile(ROOT / 'docs' / path, dest / f'{mid}.png')
            n += 1
    print(f'Copied {n} minimap pictures to {dest}')


if __name__ == '__main__':
    main()
