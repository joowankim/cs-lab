"""DB 없이 EXPLAIN ANALYZE 읽기, 데이터 생성, 조건 목록을 검사한다."""

from collections import Counter
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import join_cases  # noqa: E402
import join_lab  # noqa: E402

HASH = """-> Aggregate: count(0), sum(o.amount)  (cost=11e+6 rows=1) (actual time=4.55..4.55 rows=1 loops=1)
    -> Inner hash join (u.`code` = o.user_code)  (cost=9.98e+6 rows=9.98e+6) (actual time=1.67..4.17 rows=10000 loops=1)
        -> Table scan on u  (cost=0.0109 rows=10028) (actual time=0.0345..0.843 rows=10000 loops=1)
        -> Hash
            -> Table scan on o  (cost=1001 rows=9955) (actual time=0.0404..0.911 rows=10000 loops=1)
"""
SMALL = """-> Aggregate: count(0), sum(o.amount)  (cost=13.4 rows=1) (actual time=0.0868..0.0868 rows=1 loops=1)
    -> Nested loop inner join  (cost=12.4 rows=10) (actual time=0.066..0.0837 rows=10 loops=1)
        -> Covering index lookup on u using idx_code (code=o.user_code)  (cost=0.927 rows=1) (actual time=565e-6..747e-6 rows=1 loops=10)
"""


class ParseAnalyzeTest(unittest.TestCase):
    def test_reads_top_iterator_and_join_kind(self):
        parsed = join_lab.parse_analyze(HASH)
        self.assertEqual((parsed["first_ms"], parsed["last_ms"], parsed["rows"]), (4.55, 4.55, 1.0))
        self.assertEqual(parsed["join_kinds"], ["Inner hash join"])

    def test_nested_loop(self):
        parsed = join_lab.parse_analyze(SMALL)
        self.assertEqual(parsed["last_ms"], 0.0868)
        self.assertEqual(parsed["join_kinds"], ["Nested loop inner join"])


class DataTest(unittest.TestCase):
    def test_algo_codes_are_permutations(self):
        users, orders = join_cases.algo_rows()
        self.assertEqual(sorted(code for _, code, _ in users), list(range(100_000, 110_000)))
        self.assertEqual(sorted(code for _, code, _ in orders), list(range(100_000, 110_000)))
        self.assertEqual(join_cases.ALGO_EXPECTED, (10_000, sum(amount for _, _, amount in orders)))

    def test_n1_every_user_has_ten_orders(self):
        users, orders = join_cases.n1_rows()
        counts = Counter(user_id for _, user_id, _ in orders)
        self.assertEqual(len(users), 10_000)
        self.assertEqual(set(counts.values()), {10})
        self.assertEqual(set(counts), {user_id for user_id, _ in users})


class CasesTest(unittest.TestCase):
    def test_names_are_unique(self):
        for cases in (join_cases.RESULT_QUERIES, join_cases.ALGO_CASES, join_cases.N1_VARIANTS):
            names = [case.name for case in cases]
            self.assertEqual(len(names), len(set(names)))

    def test_rotate_keeps_items(self):
        items = list(range(5))
        for run in range(7):
            self.assertEqual(sorted(join_lab.rotate(items, run)), items)
        self.assertEqual(join_lab.rotate(items, 1)[0], 1)


if __name__ == "__main__":
    unittest.main()
