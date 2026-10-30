"""Monsters each quest's own journal text names ("He said I can easily get them by defeating
Stump, Slime, and Pig, found around Henesys"), from the pinned OSMS datamine snapshot (the
same commit as the map images, data/map-assets.json). The phone uses them for quest items the
MapleClassic Wiki has no source for (the Omok Table: Stump). Only monsters that appear on a
known map are kept. Writes data/quest-hints.json:
{"sourceCommit", "source", "quests": {questId: ["Stump", "Slime", "Pig"], ...}}.

    python3 scripts/quest-hints.py              # download the pinned snapshot and write
    python3 scripts/quest-hints.py quests.json  # use a local copy of it
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMMIT = json.loads((ROOT / 'data/map-assets.json').read_text())['sourceCommit']
SOURCE = f'https://raw.githubusercontent.com/ohmi69/osms_datamine_dashboard/{COMMIT}/data/current/quests.json'


def monsters_named(text, names):
    """Known monster names in text, in order of appearance; longer names first ("Orange
    Mushroom" before "Mushroom"), plurals allowed ("Slimes")."""
    found, taken = [], [False] * len(text)
    for name in sorted(names, key=len, reverse=True):
        for m in re.finditer(r'\b' + re.escape(name) + r'(?:e?s)?\b', text, re.IGNORECASE):
            if any(taken[m.start():m.end()]):
                continue
            taken[m.start():m.end()] = [True] * (m.end() - m.start())
            found.append((m.start(), name))
    return [name for _, name in sorted(found)]


def main():
    raw = Path(sys.argv[1]).read_bytes() if len(sys.argv) > 1 else urllib.request.urlopen(SOURCE, timeout=60).read()
    data = json.loads(raw)
    quests = data['quests'] if isinstance(data, dict) else data
    world = json.loads((ROOT / 'data/world.json').read_text())
    names = {x['name'] for m in world['maps'] for x in m.get('monsters') or [] if x.get('name')}
    known = {str(q['id']) for q in world['quests']}
    out = {}
    for q in quests:
        qid = str(q.get('id'))
        if qid not in known or not isinstance(q.get('description'), str):
            continue
        named = list(dict.fromkeys(monsters_named(q['description'], names)))
        if named:
            out[qid] = named
    result = {'sourceCommit': COMMIT, 'source': SOURCE, 'quests': dict(sorted(out.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0))}
    (ROOT / 'data/quest-hints.json').write_text(json.dumps(result, separators=(',', ':'), ensure_ascii=False) + '\n')
    print(f'Wrote monster hints for {len(out)} quests.')


if __name__ == '__main__':
    main()
