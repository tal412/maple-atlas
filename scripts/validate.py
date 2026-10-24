#!/usr/bin/env python3
"""Validate the published map bundle against the pinned portal audit."""
import json
import hashlib
import re
from collections import Counter, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
world = json.loads((ROOT / 'data/world.json').read_text())
proof = json.loads((ROOT / 'docs/data/validated-portal-graph.json').read_text())
image_audit = json.loads((ROOT / 'data/map-image-audit.json').read_text())
asset_manifest = json.loads((ROOT / 'data/map-assets.json').read_text())
maps = {m['id']: m for m in world['maps']}
anchors = {s['primary']: s for s in world['spots']}
assert len(maps) == len(world['maps']) == 246
assert len(anchors) == len(world['spots']) == 67
assert sum(bool(s.get('schematic')) for s in anchors.values()) == 3
assert sum(len(m['portals']) for m in maps.values()) == 457
assert not proof['arrivalProblems'] and not proof['ambiguousArrivalNames']
assert not image_audit['errors'] and set(image_audit['maps']) == set(maps)
assert set(asset_manifest['maps']) == set(maps)
assert asset_manifest['sourceCommit'] == image_audit['sourceCommit']

def edge_tuple(edge):
    return (str(edge['to']), edge['name'], edge['arrival'], edge['type'])

for ident, m in maps.items():
    image = image_audit['maps'][ident]
    assert image['url'] == m['image'] and image['bytes'] > 0, ('Wrong audited image', ident)
    assert re.fullmatch(r'https://cdn\.jsdelivr\.net/gh/ohmi69/osms_datamine_dashboard@[0-9a-f]{40}/data/maps/[0-9a-f]{32}\.webp', m['image']), ('Invalid map image', ident)
    if m['minimap']:
        assert m['minimap'].endswith('/data/current/images/maps/' + ident.zfill(9) + '.png'), ('Wrong minimap', ident)
    assets = asset_manifest['maps'][ident]
    assert ('preview' in assets) == bool(m['minimap']), ('Wrong preview coverage', ident)
    for kind, asset in assets.items():
        assert asset['source'] == m['image' if kind == 'image' else 'minimap']
        assert re.fullmatch(r'assets/(maps|minimaps)/[a-zA-Z0-9.]+\.(webp|png)', asset['path']), ('Unsafe asset path', ident)
        content = (ROOT / 'docs' / asset['path']).read_bytes()
        assert len(content) == asset['bytes'], ('Wrong asset length', ident, kind)
        assert hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest() == asset['gitBlob'], ('Changed game image', ident, kind)
        assert (content[:8] == b'\x89PNG\r\n\x1a\n' if kind == 'preview' else content[:4] == b'RIFF' and content[8:12] == b'WEBP'), ('Invalid image signature', ident, kind)
    assert Counter(map(edge_tuple, m['portals'])) == Counter(map(edge_tuple, proof['byMap'][ident]['portals'])), ident
    for edge in m['portals']:
        assert 0 <= edge['x'] <= image['width'] and 0 <= edge['y'] <= image['height'], ('Portal outside game image', ident, edge)
        recorded = next(e for e in proof['byMap'][ident]['portals'] if edge_tuple(e) == edge_tuple(edge))
        assert any(edge['x'] == p['localX'] and edge['y'] == p['localY'] for p in recorded['alternatives']), ('Wrong portal image coordinates', ident, edge)
        destination = str(edge['to'])
        assert destination in maps, (ident, destination)
        if ident in anchors and destination in anchors:
            assert any(k in world['artRoutes'] for k in (f'{ident}:{destination}', f'{destination}:{ident}')), ('Missing road', ident, destination)
    assert m['spot'] == (anchors[ident]['id'] if ident in anchors else None), ('Misplaced map', ident)

art = (ROOT / 'src/world.svg').read_text()
palette = json.loads((ROOT / 'data/night-palette.json').read_text())
assert set(re.findall(r'#[0-9a-fA-F]{6}\b', art)) <= set(palette), 'Missing night colors'
assert all(re.fullmatch(r'#[0-9a-fA-F]{6}', value) for value in palette.values())
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
assert not re.search(r'\b(XMLHttpRequest|WebSocket)\s*\(', page), 'Unexpected backend request'
assert len(re.findall(r'\bfetch\s*\(', page)) == 2, 'Only the static catalog and explicit MCW item loader may fetch'
catalog_blob = (ROOT / 'data/search-catalog.json').read_bytes()
catalog_name = 'search-' + hashlib.sha256(catalog_blob).hexdigest()[:16] + '.json'
assert (ROOT / 'docs/data' / catalog_name).read_bytes() == catalog_blob
assert './data/' + catalog_name in page
catalog = json.loads(catalog_blob)
assert len(catalog['entities']) == len({e['key'] for e in catalog['entities']}) == 9355
assert Counter(e['type'] for e in catalog['entities']) == catalog['counts']
assert all('marketPrice' not in e for e in catalog['entities']), 'Do not invent market values'
assert {e['id'] for e in catalog['entities'] if e['type'] == 'map' and e.get('covered')} == set(maps)
assert 'id="mc-caption"' in page.split('</form>', 1)[0], 'Route summary escaped its form'
for path in [ROOT / 'docs/index.html', ROOT / 'docs/plan.html', *ROOT.glob('docs/data/*.json')]:
    text = path.read_text()
    assert not re.search(r'/Users/|/private/|sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]+|maple-atlas-api', text), ('Private build data', path)
assert page.count('window.mapleStorageReady.then') == 1
assert sum(bool(m['minimap']) for m in maps.values()) == 218
assert 'maple-atlas-dev' in page and '!saved && !development' in page
assert 'rel="icon"' in page and (ROOT / 'docs/favicon.svg').exists()
assert 'nearbyNPCs' not in page
assert '<meta name="color-scheme" content="light dark">' in page
assert '@media(prefers-color-scheme:dark)' in page and 'MapleGestures.create' in page
print('PASS: 246 map images, 218 minimaps, 457 source-matched portal pairs and image coordinates, 67 anchors, 68 road curves; route, sprite and static publication checks.')
print('PASS: all 464 hosted map assets match their pinned source Git blobs.')
print('PASS: 9,355 unique catalog entities; same-origin versioned search bundle; no live-price claims.')
