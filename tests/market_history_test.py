import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import market_history as H


def snap(day, items):
    return {'updatedAt': day + 'T07:00:00+00:00', 'items': [{'name': n, 'median': m, 'typicalLow': m - 1, 'typicalHigh': m + 1, 'askingMedian': m + 5, 'sales': 3} for n, m in items]}


class MarketHistoryTest(unittest.TestCase):
    def test_days_append_and_replace(self):
        h = H.add(None, snap('2026-11-01', [('Wings', 100)]))
        h = H.add(h, snap('2026-11-01', [('Wings', 110)]))   # same day: replaced
        h = H.add(h, snap('2026-11-02', [('Wings', 120), ('Ears', 50)]))
        self.assertEqual(h['days'], ['2026-11-01', '2026-11-02'])
        self.assertEqual(h['items']['Wings'][0], [110, 120])
        self.assertEqual(h['items']['Ears'][0], [None, 50])
        self.assertIsNotNone(H.valid(h))

    def test_older_snapshot_and_window(self):
        h = H.add(None, snap('2026-11-02', [('Wings', 100)]))
        self.assertEqual(H.add(h, snap('2026-11-01', [('Wings', 1)]))['items']['Wings'][0], [100])
        for d in range(3, 80):
            h = H.add(h, snap(f'2026-11-{d:02d}' if d <= 30 else f'2026-12-{d - 30:02d}' if d <= 61 else f'2027-01-{d - 61:02d}', [('Wings', d)]))
        self.assertEqual(len(h['days']), H.DAYS)
        self.assertIsNotNone(H.valid(h))

    def test_bad_history_is_dropped(self):
        self.assertIsNone(H.valid({'schema': 1, 'source': H.SOURCE, 'days': ['2026-11-01'], 'items': {'x': [[1]]}}))


if __name__ == '__main__':
    unittest.main()
