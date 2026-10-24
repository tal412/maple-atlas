#!/usr/bin/env python3
"""Regenerate the search catalog from the pinned, hash-checked OSMS export.

Normal builds use the committed catalog and never need the research directory.
"""
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'research/osms'
COMMIT = 'a44f101bffa8272164ca47484ab18c078dcab0a0'
TREE = {x['path']: x for x in json.loads((RAW / 'repo-tree.json').read_text())['tree']}
SOURCES = {}


def read(name):
    blob = (RAW / (name + '.json')).read_bytes()
    sha = hashlib.sha1(b'blob ' + str(len(blob)).encode() + b'\0' + blob).hexdigest()
    assert sha == TREE['data/current/' + name + '.json']['sha'], name
    SOURCES[name] = sha
    return json.loads(blob)


def image(path):
    return path if path and 'data/' + path in TREE else None


def unique(values):
    return list(dict.fromkeys(values))


world = json.loads((ROOT / 'data/world.json').read_text())
lookups, raw_maps, items, monsters, quests, crafting, skills, cash_shop = (read(n) for n in
    ['lookups', 'maps', 'items', 'monsters', 'quests', 'crafting', 'skills', 'cash_shop'])
api_snapshot = json.loads((ROOT / 'data/mcw-items.json').read_text())
assert api_snapshot['region'] == 'MCW' and api_snapshot['version'] == '1'
api_items = {str(i['id']): i for i in api_snapshot['items']}
entities = {}


def add(kind, ident, name, **values):
    ident = str(int(ident))
    record = dict(key=kind + ':' + ident, type=kind, id=ident, name=name or 'Unnamed ' + kind + ' ' + ident, **values)
    entities[record['key']] = record
    return record


covered = {m['id'] for m in world['maps']}
for ident, name in lookups['map_names'].items():
    add('map', ident, name, limited=True)
for region in raw_maps['regions']:
    for m in region['maps']:
        add('map', m['id'], m['name'], street=m.get('street_name', ''),
            region=region['region'], town=m.get('is_town', False),
            covered=str(m['id']) in covered,
            npcs=[str(n) for n in m.get('npcs', [])])
for m in world['maps']:
    e = entities['map:' + m['id']]
    e.update(town=m['town'], covered=True, monsters=[str(x['id']) for x in m['monsters']])

for ident, name in lookups['npc_names'].items():
    n = raw_maps['npc_lookup'].get(ident, {})
    add('npc', ident, name, image=image('current/' + n['thumbnail']) if n.get('thumbnail') else None,
        maps=[m['id'] for m in entities.values() if m['type'] == 'map' and ident in m.get('npcs', [])])
for ident, name in lookups['mob_names'].items():
    add('monster', ident, name, limited=True)
for m in monsters['monsters']:
    add('monster', m['id'], m['name'], level=m['level'], hp=m['hp'], exp=m['exp'],
        image=image('images/monsters/' + m['thumbnail'] + '.png') if m.get('thumbnail') else None,
        maps=unique(str(x['id']) for x in m.get('maps', [])))

details = {str(i['id']): i for i in items['items'] + items['scrolls']}
cash_items = {str(i['id']): i for c in cash_shop['categories'] for i in c['items']}
item_names = dict(lookups['item_names'])
item_names.update({ident: i['name'] for ident, i in cash_items.items()})
item_names.update({ident: i['name'] for ident, i in api_items.items()})
for ident, name in item_names.items():
    i = details.get(ident, {})
    cash = cash_items.get(ident)
    api = api_items.get(ident, {})
    kind = api.get('typeInfo', {})
    stats = i.get('stats', {})
    aliases = {'Work Gloves': ['wg'], 'Henesys': ['hene']}.get(name, [])
    old_name = lookups['item_names'].get(ident)
    if old_name and old_name != name:
        aliases.append(old_name)
    add('item', ident, name, category=(cash['category'] if cash else i.get('category', kind.get('category', 'Scroll' if 'success_rate' in i else 'Item'))),
        subcategory=(cash.get('sub_category') if cash else i.get('sub_category', kind.get('subCategory', ''))),
        description=i.get('description') or (cash or {}).get('description') or api.get('desc', ''),
        image=image('current/images/items/' + ident.zfill(8) + '.png'),
        level=stats.get('reqLevel', api.get('requiredLevel')), stats=stats, sell=i.get('price', stats.get('price')),
        success=i.get('success_rate'), job=i.get('req_job_label'), aliases=aliases,
        cash=bool(cash) or api.get('isCash', False), apiRecord=bool(api),
        cashShop=({k: cash[k] for k in ['price', 'count', 'period', 'on_sale']} if cash else None),
        limited=not bool(i or cash or api))
for q in world['quests']:
    raw = next(x for x in quests['quests'] if str(x['id']) == q['id'])
    npc = entities.get('npc:' + str(q.get('npcId')))
    add('quest', q['id'], q['name'], level=q['level'], npc=q.get('npcId'), npcName=q['npc'],
        image=npc.get('image') if npc else None, maps=npc.get('maps', []) if npc else [],
        description=raw.get('description', ''), region=raw.get('region', ''),
        objectives=q['objectives'], rewards=q.get('items', []), exp=q['exp'], mesos=q['mesos'], next=q['next'])

# Recipe ingredients have names, not IDs. Link all exact matches; never guess a drop source.
by_name = defaultdict(list)
for e in entities.values():
    if e['type'] == 'item':
        by_name[e['name']].append(e['key'])
for discipline in crafting['disciplines']:
    for output in discipline['output_types']:
        for level in output['levels']:
            for r in level['recipes']:
                add('recipe', r['id'], r['result_item_name'], discipline=discipline['discipline'],
                    level=r['req_level'], output=str(r['output_id']), count=r['result_count'],
                    mesos=r['meso_cost'], ingredients=[dict(name=i['item_name'], count=i['count'],
                    keys=by_name[i['item_name']]) for i in r['ingredients']],
                    image=entities.get('item:' + str(r['output_id']), {}).get('image'))
for groups in skills.values():
    if not isinstance(groups, list):
        continue
    for group in groups:
        if not isinstance(group, dict):
            continue
        for s in group.get('skills', []):
            add('skill', s['id'], s['name'], job=s['class_name'], description=s['description'],
                maxLevel=s['max_level'], image=image('current/' + s['thumbnail']) if s.get('thumbnail') else None)

for key, aliases in {'map:10001000': ['hene'], 'map:10003000': ['kerning'],
                     'map:10002000': ['ellinia']}.items():
    if key in entities:
        entities[key]['aliases'] = aliases
records = list(entities.values())
for e in records:
    for k in list(e):
        if e[k] is None or e[k] == '' or e[k] == []:
            del e[k]
catalog = dict(schema=1, snapshot=world['snapshot'], sourceCommit=COMMIT,
    gameApi={k: api_snapshot[k] for k in ['source', 'region', 'version', 'checked', 'sha256']},
    sources=SOURCES, counts=dict(Counter(e['type'] for e in records)), entities=records)
output = ROOT / 'data/search-catalog.json'
output.write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n')
print('Catalog:', catalog['counts'], output.stat().st_size, 'bytes')
