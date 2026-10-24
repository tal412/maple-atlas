#!/usr/bin/env python3
"""Validate the developer-published market export and retain the newest good copy."""
import argparse
import hashlib
import json
import math
import re
import subprocess
import unicodedata
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'https://maplestory-classic.com/market.json'
PAGE = 'https://maplestory-classic.com/market'
PUBLISHED = 'https://tal412.github.io/maple-atlas/data/market.json'


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('Missing timestamp')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Timestamp needs a timezone')
    return result


def amount(value, *, integer=False):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1e15:
        raise ValueError('Invalid market number')
    if integer and value != int(value):
        raise ValueError('Invalid market count')
    return value


def normalize(raw, *, now=None, min_items=100):
    now = now or datetime.now(timezone.utc)
    date = timestamp(raw.get('updatedAt'))
    if date > now + timedelta(minutes=15):
        raise ValueError('Future source timestamp')
    if not isinstance(raw.get('items'), list) or not min_items <= len(raw['items']) <= 50000:
        raise ValueError('Unexpected source coverage')
    threshold = amount(raw.get('lowDataBelow', 5), integer=True)
    if threshold is None or threshold < 1:
        raise ValueError('Invalid low-data threshold')
    items, names, slugs = [], set(), set()
    for row in raw['items']:
        name, slug = row.get('n'), row.get('s')
        if not isinstance(name, str) or not name.strip() or len(name) > 200 or not isinstance(slug, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
            raise ValueError('Invalid item identity')
        key = ' '.join(unicodedata.normalize('NFKC', name).split()).lower()
        if key in names or slug in slugs:
            raise ValueError('Duplicate source item')
        names.add(key); slugs.add(slug)
        sales = amount(row.get('sold'), integer=True)
        if sales is None:
            raise ValueError('Missing sales count')
        record = dict(name=name.strip(), slug=slug, category=str(row.get('k', ''))[:80],
                      median=amount(row.get('p')) if sales else None,
                      askingMedian=amount(row.get('ask')), sales=sales,
                      typicalLow=amount(row.get('p25')), typicalHigh=amount(row.get('p75')),
                      unit='set' if row.get('u') == 'set' else 'item')
        if record['typicalLow'] is not None and record['typicalHigh'] is not None and record['typicalLow'] > record['typicalHigh']:
            raise ValueError('Reversed price range')
        items.append(record)
    digest = hashlib.sha256(json.dumps(items, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return dict(schema=1, source=SOURCE, page=PAGE, updatedAt=date.isoformat(),
                retrievedAt=now.isoformat(), digest=digest, lowDataBelow=threshold,
                count=len(items), items=items)


def validate(snapshot):
    if snapshot.get('schema') != 1 or snapshot.get('source') != SOURCE or snapshot.get('page') != PAGE:
        raise ValueError('Invalid snapshot source')
    timestamp(snapshot['updatedAt']); timestamp(snapshot['retrievedAt'])
    if snapshot.get('count') != len(snapshot.get('items', [])) or snapshot['count'] < 100:
        raise ValueError('Invalid snapshot coverage')
    # Reuse source validation for cached and published records too.
    normalized = normalize(dict(updatedAt=snapshot['updatedAt'], lowDataBelow=snapshot['lowDataBelow'], items=[
        dict(n=i['name'], s=i['slug'], k=i['category'], p=i['median'], ask=i['askingMedian'], sold=i['sales'],
             p25=i['typicalLow'], p75=i['typicalHigh'], u=i['unit']) for i in snapshot['items']]))
    if normalized['digest'] != snapshot.get('digest'):
        raise ValueError('Snapshot digest mismatch')
    return snapshot


def newest(current, candidate):
    return candidate if not current or (timestamp(candidate['updatedAt']), timestamp(candidate['retrievedAt'])) >= (timestamp(current['updatedAt']), timestamp(current['retrievedAt'])) else current


def download(url):
    response = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--max-time', '25',
                               '--max-filesize', '5000000', url], capture_output=True, check=True)
    return json.loads(response.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, help='Use a previously downloaded source export')
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'data/market-snapshot.json')
    args = parser.parse_args()
    current = validate(json.loads(args.output.read_text())) if args.output.exists() else None
    if args.refresh:
        try:
            current = newest(current, validate(download(PUBLISHED)))
        except Exception as error:
            print('Published fallback unavailable:', type(error).__name__)
        try:
            current = newest(current, normalize(download(SOURCE)))
        except Exception as error:
            print('::warning::Market refresh failed; keeping last valid snapshot (' + type(error).__name__ + ')')
    elif args.input:
        current = newest(current, normalize(json.loads(args.input.read_text())))
    if current is None:
        raise ValueError('No valid market snapshot available')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(current, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f"Market: {current['count']} items; source updated {current['updatedAt']}")


if __name__ == '__main__':
    main()
