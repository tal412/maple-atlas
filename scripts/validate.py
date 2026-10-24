#!/usr/bin/env python3
"""Validate the published map bundle against the pinned portal audit."""
import json
import re
from collections import Counter, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
world = json.loads((ROOT / 'data/world.json').read_text())
proof = json.loads((ROOT / 'docs/data/validated-portal-graph.json').read_text())
maps = {m['id']: m for m in world['maps']}
anchors = {s['primary']: s for s in world['spots']}
assert len(maps) == len(world['maps']) == 246
assert len(anchors) == len(world['spots']) == 67
assert sum(bool(s.get('schematic')) for s in anchors.values()) == 3
assert sum(len(m['portals']) for m in maps.values()) == 457
assert not proof['arrivalProblems'] and not proof['ambiguousArrivalNames']

def edge_tuple(edge):
    return (str(edge['to']), edge['name'], edge['arrival'], edge['type'])

for ident, m in maps.items():
    assert Counter(map(edge_tuple, m['portals'])) == Counter(map(edge_tuple, proof['byMap'][ident]['portals'])), ident
    for edge in m['portals']:
        destination = str(edge['to'])
        assert destination in maps, (ident, destination)
        if ident in anchors and destination in anchors:
            assert any(k in world['artRoutes'] for k in (f'{ident}:{destination}', f'{destination}:{ident}')), ('Missing road', ident, destination)
    assert m['spot'] == (anchors[ident]['id'] if ident in anchors else None), ('Misplaced map', ident)

art = (ROOT / 'src/world.svg').read_text()
for key, path in world['artRoutes'].items():
    source, target = key.split(':')
    assert any(str(e['to']) == target for e in maps[source]['portals']) or any(str(e['to']) == source for e in maps[target]['portals']), ('Invented road', key)
    values = list(map(float, re.findall(r'-?\d+(?:\.\d+)?', path)))
    assert len(values) == 8, ('Expected single reversible cubic', key)
    expected = [anchors[source]['x'], anchors[source]['y'], anchors[target]['x'], anchors[target]['y']]
    assert all(abs(actual - wanted) < .1 for actual, wanted in zip(values[:2] + values[-2:], expected)), ('Wrong endpoint', key)
    assert path in art, ('Route and illustration diverge', key)

def route(source, destination):
    queue = deque([[source]])
    seen = {source}
    while queue:
        path = queue.popleft()
        if path[-1] == destination:
            return path
        for edge in maps[path[-1]]['portals']:
            target = str(edge['to'])
            if target not in seen:
                seen.add(target)
                queue.append(path + [target])
    return []

assert route('10000000', '10001000') == ['10000000', '10000010', '10000011', '10000012', '10000013', '10000020', '10001030', '10001020', '10001010', '10001000']
forest = ['10005010', '10005020', '10005030']
for a, b in zip(forest, forest[1:]):
    assert route(a, b) == [a, b] and route(b, a) == [b, a]
for kind in ('npc', 'monster'):
    field = 'npcs' if kind == 'npc' else 'monsters'
    for m in maps.values():
        for entity in m[field]:
            assert str(entity['id']) in world['sprites'][kind], ('Missing sprite', kind, entity)
for quest in world['quests']:
    if quest.get('npcId'):
        assert quest['npcId'] in world['sprites']['npc'], quest['name']
    for item in quest.get('items', []):
        assert item['id'] in world['sprites']['item'], ('Missing reward sprite', item)

page = (ROOT / 'docs/index.html').read_text()
assert 'indexedDB.open' in page
assert not re.search(r'\b(fetch|XMLHttpRequest|WebSocket)\s*\(', page), 'Unexpected backend request'
assert 'id="mc-caption"' in page.split('</form>', 1)[0], 'Route summary escaped its form'
for path in [ROOT / 'docs/index.html', ROOT / 'docs/plan.html', *ROOT.glob('docs/data/*.json')]:
    text = path.read_text()
    assert not re.search(r'/Users/|/private/|sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]+|maple-atlas-api', text), ('Private build data', path)
assert page.count('window.mapleStorageReady.then') == 1
print('PASS: 246 maps, 457 source-matched portal pairs, 67 anchors, 68 shared road curves; route regressions, sprites and static publication checks.')
