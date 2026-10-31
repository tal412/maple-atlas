"""Where each NPC stands on its map, from the pinned OSMS datamine snapshot (the same commit as
the map images, data/map-assets.json; positions in map-image pixels, like the portals and the
spawn points). The phone marks the NPC on the local map and guides you to it. Writes
data/npc-positions.json: {"sourceCommit", "source", "maps": {mapId: {npcId: [x, y]}}}.

    python3 scripts/npc-positions.py            # download the pinned snapshot and write
    python3 scripts/npc-positions.py maps.json  # use a local copy of it
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
        if mid not in world or mid in out:
            continue
        spots = {}
        for p in m.get('npc_positions') or []:
            if isinstance(p, dict) and all(isinstance(p.get(k), (int, float)) for k in ('x', 'y')) and p.get('id') is not None:
                spots[str(p['id'])] = [int(p['x']), int(p['y'])]
        if spots:
            out[mid] = spots
    data = {'sourceCommit': COMMIT, 'source': SOURCE, 'maps': dict(sorted(out.items(), key=lambda kv: int(kv[0])))}
    (ROOT / 'data/npc-positions.json').write_text(json.dumps(data, separators=(',', ':')) + '\n')
    print(f"Wrote positions of {sum(len(v) for v in out.values())} NPCs on {len(out)} maps.")


if __name__ == '__main__':
    main()
