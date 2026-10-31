"""Monsters each quest's own journal text names ("He said I can easily get them by defeating
Stump, Slime, and Pig, found around Henesys"), the NPC the quest is handed in to when its text
says so ("deliver a letter to Dances with Balrog in Perion"), and the items the quest itself
gives you when you take it (Lewis's Letter), from the pinned OSMS datamine snapshot (the same
commit as the map images, data/map-assets.json). The phone uses them for quest items the
MapleClassic Wiki has no source for (the Omok Table: Stump) and to send you to the right NPC.
Only monsters and NPCs that appear on a known map are kept. Writes data/quest-hints.json:
{"sourceCommit", "source", "quests": {questId: {"hunt": [...], "to": "NPC", "given": [...]}}}.

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
    npcs = {x['name'] for m in world['maps'] for x in m.get('npcs') or [] if x.get('name')}
    givers = {str(q['id']): q.get('npc') for q in world['quests']}
    out = {}
    for q in quests:
        qid = str(q.get('id'))
        if qid not in givers or not isinstance(q.get('description'), str):
            continue
        text, hint = q['description'], {}
        named = list(dict.fromkeys(monsters_named(text, names)))
        if named:
            hint['hunt'] = named
        # The NPC it goes to: one other than the giver, after "to" / "see" / "visit" / "find".
        for name in sorted(npcs, key=len, reverse=True):
            if name == givers[qid] or len(name) < 3:
                continue
            if re.search(r'\b(?:to|see|visit|find|meet|ask)\s+(?:the\s+)?' + re.escape(name) + r'\b', text):
                hint['to'] = name
                break
        given = [i['name'] for i in q.get('start_items') or [] if isinstance(i, dict) and i.get('name')]
        if given:
            hint['given'] = given
        if hint:
            out[qid] = hint
    result = {'sourceCommit': COMMIT, 'source': SOURCE, 'quests': dict(sorted(out.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0))}
    (ROOT / 'data/quest-hints.json').write_text(json.dumps(result, separators=(',', ':'), ensure_ascii=False) + '\n')
    print(f"Wrote hints for {len(out)} quests: {sum('hunt' in v for v in out.values())} with monsters, "
          f"{sum('to' in v for v in out.values())} with an NPC to go to, {sum('given' in v for v in out.values())} with items given.")


if __name__ == '__main__':
    main()
