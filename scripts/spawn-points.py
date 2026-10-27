"""Monster spawn points per map, from the pinned OSMS datamine snapshot (the same commit as
the map images, data/map-assets.json). Positions are in map-image pixels: the snapshot's
portal positions equal this project's for all 457 recorded portals. Writes
data/spawn-points.json: {"sourceCommit", "source", "maps": {mapId: {monsterId: [[x, y], ...]}}}.

    python3 scripts/spawn-points.py            # download the pinned snapshot and write
    python3 scripts/spawn-points.py maps.json  # use a local copy of it
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMMIT = json.loads((ROOT / 'data/map-assets.json').read_text())['sourceCommit']
SOURCE = f'https://raw.githubusercontent.com/ohmi69/osms_datamine_dashboard/{COMMIT}/data/current/maps.json'


def walk(node):
    if isinstance(node, dict):
        if isinstance(node.get('maps'), list):
            yield from (m for m in node['maps'] if isinstance(m, dict) and 'id' in m)
        for value in node.values():
            if isinstance(value, (dict, list)):
                yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)


def main():
    raw = Path(sys.argv[1]).read_bytes() if len(sys.argv) > 1 else urllib.request.urlopen(SOURCE, timeout=60).read()
    world = {str(m['id']) for m in json.loads((ROOT / 'data/world.json').read_text())['maps']}
    out = {}
    for m in walk(json.loads(raw)):
        mid = str(m['id'])
        if mid not in world or not m.get('mob_positions'):
            continue
        by = {}
        for p in m['mob_positions']:
            if isinstance(p.get('x'), (int, float)) and isinstance(p.get('y'), (int, float)):
                by.setdefault(str(p['id']), []).append([int(p['x']), int(p['y'])])
        if by:
            out[mid] = dict(sorted(by.items()))
    data = {'sourceCommit': COMMIT, 'source': SOURCE, 'maps': dict(sorted(out.items(), key=lambda kv: int(kv[0])))}
    (ROOT / 'data/spawn-points.json').write_text(json.dumps(data, separators=(',', ':')) + '\n')
    print(f"Wrote spawn points for {len(out)} maps, {sum(len(v) for m in out.values() for v in m.values())} points.")


if __name__ == '__main__':
    main()
