"""DB 없이 데이터 생성, 기대값, 조건 목록을 검사한다."""

from collections import Counter
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import norm_lab  # noqa: E402


class DataTest(unittest.TestCase):
    def check_scale(self, scale):
        data = norm_lab.make_data(scale)
        counts = Counter(row[1] for row in data.reservations)
        self.assertEqual(len(data.members), scale.members)
        self.assertEqual(len(data.cars), scale.cars)
        self.assertEqual(len(data.reservations), scale.reservations)
        self.assertEqual(counts[1], scale.heavy)
        self.assertEqual(set(counts) - {1}, set(range(2, scale.regular_members + 2)))
        self.assertEqual({counts[m] for m in counts if m != 1}, {10})
        self.assertEqual(data.members[0][3], norm_lab.NORMAL)
        self.assertEqual(sum(1 for row in data.members if row[3] == norm_lab.GOLD), scale.members // 5)
        self.assertEqual(len({row[3] for row in data.reservations}), scale.reservations)
        self.assertTrue(all(1 <= row[2] <= scale.cars for row in data.reservations))

    def test_small(self):
        self.check_scale(norm_lab.SMALL)
        self.assertEqual((norm_lab.SMALL.heavy, norm_lab.SMALL.regular_members), (100, 990))

    def test_full(self):
        self.check_scale(norm_lab.FULL)
        self.assertEqual((norm_lab.FULL.heavy, norm_lab.FULL.regular_members), (10_000, 99_000))

    def test_seed_is_fixed(self):
        self.assertEqual(norm_lab.make_data(norm_lab.SMALL).reservations[:5],
                         norm_lab.make_data(norm_lab.SMALL).reservations[:5])


class ExpectedTest(unittest.TestCase):
    def test_q1_is_latest_twenty_of_member_1(self):
        data = norm_lab.make_data(norm_lab.SMALL)
        ids = norm_lab.expected_q1(data)
        times = {row[0]: row[3] for row in data.reservations}
        self.assertEqual(len(ids), 20)
        self.assertEqual([times[i] for i in ids], sorted((times[i] for i in ids), reverse=True))

    def test_rows_affected(self):
        data = norm_lab.make_data(norm_lab.SMALL)
        got = {(c.name, c.variant): norm_lab.expected_rows_affected(data, c)
               for c in norm_lab.cases() if c.name.startswith("u")}
        self.assertEqual(got, {("u1", "norm"): 1, ("u1", "denorm"): 101, ("u2", "norm"): 1, ("u2", "denorm"): 11})


class CasesTest(unittest.TestCase):
    def test_each_task_has_both_variants(self):
        names = Counter(c.name for c in norm_lab.cases())
        self.assertEqual(names, {"q1": 2, "q2": 2, "u1": 2, "u2": 2})

    def test_denorm_index_options(self):
        self.assertEqual(norm_lab.DENORM_INDEX["plain"], ("denorm", []))
        name, statements = norm_lab.DENORM_INDEX["cov"]
        self.assertEqual(name, "denorm_cov")
        self.assertIn("(member_id, started_at, member_plan)", statements[1])

    def test_rotate_keeps_items(self):
        items = list(range(8))
        for run in range(5):
            self.assertEqual(sorted(norm_lab.rotate(items, run)), items)


if __name__ == "__main__":
    unittest.main()
