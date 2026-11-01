#!/usr/bin/env python3
"""Price history for every market item, built by the site itself: each hourly publish reads the
history already on the site, adds the current snapshot as today's point (one per UTC day, the
day's latest snapshot), keeps the last DAYS days and writes it next to the site's market.json.

    python3 scripts/market_history.py data/market-snapshot.json site/data/market-history.json

History file:
  {"schema": 1, "source": <market source>, "days": ["2026-11-01", ...],
   "items": {"<name>": [[median...], [typicalLow...], [typicalHigh...], [askingMedian...], [sales...]]}}
Each list holds one value per day (null where the item had no record that day).
"""
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PUBLISHED = 'https://tal412.github.io/maple-atlas/data/market-history.json'
SOURCE = 'https://maplestory-classic.com/market.json'
DAYS = 60
FIELDS = ('median', 'typicalLow', 'typicalHigh', 'askingMedian', 'sales')


def valid(history):
    """The published history, if it is well formed (else start again)."""
    try:
        days, items = history['days'], history['items']
        assert history.get('schema') == 1 and history.get('source') == SOURCE and isinstance(days, list) and isinstance(items, dict)
        assert len(days) <= DAYS and all(isinstance(d, str) and len(d) == 10 for d in days) and days == sorted(set(days))
        for name, series in items.items():
            assert isinstance(name, str) and len(series) == len(FIELDS) and all(len(s) == len(days) for s in series)
            assert all(v is None or (isinstance(v, (int, float)) and 0 <= v <= 1e15) for s in series for v in s)
        return history
    except (KeyError, TypeError, AssertionError):
        return None


def download(url=PUBLISHED):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Cache-Control': 'no-cache'}), timeout=30) as r:
            return json.loads(r.read())
    except Exception:
        return None


def add(history, snapshot):
    """history (or None) + this snapshot -> the new history."""
    day = datetime.fromisoformat(snapshot['updatedAt'].replace('Z', '+00:00')).astimezone(timezone.utc).strftime('%Y-%m-%d')
    history = history or {'schema': 1, 'source': SOURCE, 'days': [], 'items': {}}
    days, items = list(history['days']), {k: [list(s) for s in v] for k, v in history['items'].items()}
    if not days or days[-1] < day:
        days.append(day)
        for series in items.values():
            for s in series:
                s.append(None)
    elif days[-1] > day:
        return history   # an older snapshot: keep what is there
    i = len(days) - 1
    seen = set()
    for item in snapshot['items']:
        name = item['name']
        seen.add(name)
        series = items.setdefault(name, [[None] * len(days) for _ in FIELDS])
        for s, field in zip(series, FIELDS):
            s[i] = item.get(field)
    # Keep the last DAYS days; drop items with nothing left.
    cut = max(0, len(days) - DAYS)
    days = days[cut:]
    items = {k: [s[cut:] for s in v] for k, v in items.items()}
    items = {k: v for k, v in items.items() if any(x is not None for x in v[0]) or k in seen}
    return {'schema': 1, 'source': SOURCE, 'days': days, 'items': dict(sorted(items.items()))}


def main():
    snapshot = json.loads(Path(sys.argv[1]).read_text())
    history = add(valid(download()) if len(sys.argv) < 4 else valid(json.loads(Path(sys.argv[3]).read_text())), snapshot)
    out = Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(history, separators=(',', ':')))
    print(f"market history: {len(history['days'])} days, {len(history['items'])} items, {out.stat().st_size // 1024} KB")


if __name__ == '__main__':
    main()
