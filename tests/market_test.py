import copy
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from market import normalize, validate, newest


class MarketImport(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 24, 12, tzinfo=timezone.utc)
        self.raw = dict(updatedAt='2026-10-24T07:00:00Z', lowDataBelow=5, items=[
            dict(n=f'Item {i}', s=f'item-{i}', k='Etc', p=100, ask=150, sold=12, p25=90, p75=110)
            for i in range(100)])

    def test_valid_digest_and_tampering(self):
        data = normalize(self.raw, now=self.now)
        self.assertEqual(validate(data), data)
        data['items'][0]['median'] = 200
        with self.assertRaises(ValueError):
            validate(data)

    def test_invalid_source_rejected(self):
        changes = [lambda r: r.update(updatedAt='2026-10-25T00:00:00Z'),
                   lambda r: r.update(updatedAt='2026-10-24'),
                   lambda r: r.update(lowDataBelow=0),
                   lambda r: r['items'].pop(),
                   lambda r: r['items'][1].update(n='Item 0'),
                   lambda r: r['items'][1].update(s='item-0'),
                   lambda r: r['items'][0].update(p=-1),
                   lambda r: r['items'][0].update(sold=True),
                   lambda r: r['items'][0].update(p25=200)]
        for change in changes:
            raw = copy.deepcopy(self.raw)
            change(raw)
            with self.assertRaises(ValueError):
                normalize(raw, now=self.now)

    def test_unknown_zero_and_set(self):
        self.raw['items'][0].update(p=0, u='set')
        self.raw['items'][1].update(p=0, sold=0)
        self.raw['items'][2].pop('p')
        data = normalize(self.raw, now=self.now)
        self.assertEqual(data['items'][0]['median'], 0)
        self.assertEqual(data['items'][0]['unit'], 'set')
        self.assertIsNone(data['items'][1]['median'])
        self.assertIsNone(data['items'][2]['median'])

    def test_previous_deployment_cannot_roll_back_newer_prices(self):
        old = normalize(self.raw, now=self.now)
        self.raw['updatedAt'] = '2026-10-24T08:00:00Z'
        new = normalize(self.raw, now=self.now)
        self.assertIs(newest(new, old), new)
        self.assertIs(newest(old, new), new)


if __name__ == '__main__':
    unittest.main()
