"""DB 없이 EXPLAIN ANALYZE 읽기, 데이터 생성, 조건 목록을 검사한다."""

from collections import Counter
from datetime import datetime
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import index_cases  # noqa: E402
import index_lab  # noqa: E402
import orders_data  # noqa: E402

FULL_SCAN = """-> Filter: ((orders.user_id = 4242) and (orders.created_at >= TIMESTAMP'2026-08-10 00:00:00'))  (cost=100977 rows=33129) (actual time=162..204 rows=1 loops=1)
    -> Table scan on orders  (cost=100977 rows=993983) (actual time=0.13..148 rows=1e+6 loops=1)
"""
LOOKUP = """-> Filter: (orders.created_at >= TIMESTAMP'2026-08-10 00:00:00')  (cost=1.42 rows=1.67) (actual time=0.0289..0.0296 rows=1 loops=1)
    -> Index lookup on orders using idx_user (user_id = 4242)  (cost=1.42 rows=5) (actual time=0.0268..0.0287 rows=5 loops=1)
"""
EMPTY = """-> Filter: (orders.user_id = 0)  (cost=1.1 rows=1) (actual time=0.0101..0.0101 rows=0 loops=1)
    -> Index lookup on orders using idx_user (user_id = 0)  (cost=1.1 rows=1) (actual time=0.00953..0.00953 rows=0 loops=1)
"""


class ParseAnalyzeTest(unittest.TestCase):
    def test_reads_top_iterator_only(self):
        parsed = index_lab.parse_analyze(FULL_SCAN)
        self.assertEqual(parsed["first_ms"], 162.0)
        self.assertEqual(parsed["last_ms"], 204.0)
        self.assertEqual(parsed["rows"], 1.0)
        self.assertEqual(parsed["loops"], 1)
        self.assertEqual(parsed["est_cost"], 100977.0)
        self.assertEqual(parsed["est_rows"], 33129.0)

    def test_reads_fractional_times(self):
        parsed = index_lab.parse_analyze(LOOKUP)
        self.assertAlmostEqual(parsed["last_ms"], 0.0296)
        self.assertEqual(parsed["est_rows"], 1.67)

    def test_reads_zero_rows(self):
        parsed = index_lab.parse_analyze(EMPTY)
        self.assertEqual(parsed["rows"], 0.0)

    def test_missing_actual_gives_none(self):
        parsed = index_lab.parse_analyze("-> Table scan on orders  (cost=1 rows=1)\n")
        self.assertIsNone(parsed["last_ms"])


class OrdersDataTest(unittest.TestCase):
    def test_same_seed_gives_same_rows(self):
        first = list(orders_data.rows(count=2000, heavy_rows=100))
        second = list(orders_data.rows(count=2000, heavy_rows=100))
        self.assertEqual(first, second)

    def test_shape_and_order(self):
        rows = list(orders_data.rows(count=5000, heavy_rows=250))
        self.assertEqual([row[0] for row in rows], list(range(1, 5001)))
        self.assertEqual(sum(1 for row in rows if row[1] == orders_data.HEAVY_USER), 250)
        self.assertTrue(all(2 <= row[1] <= orders_data.USERS for row in rows if row[1] != orders_data.HEAVY_USER))
        created = [row[6] for row in rows]
        self.assertEqual(created, sorted(created))  # id 순서가 곧 시간 순서
        self.assertGreaterEqual(created[0], orders_data.START)
        self.assertLess(created[-1], datetime(2026, 11, 10))
        self.assertTrue(all(len(row) == len(orders_data.COLUMNS) for row in rows))
        self.assertTrue(all(row[4].startswith("010") and len(row[4]) == 11 for row in rows))

    def test_status_shares(self):
        counts = Counter(row[2] for row in orders_data.rows(count=20000, heavy_rows=1000))
        self.assertAlmostEqual(counts["paid"] / 20000, 0.90, delta=0.01)
        self.assertAlmostEqual(counts["cancelled"] / 20000, 0.07, delta=0.01)
        self.assertAlmostEqual(counts["refunded"] / 20000, 0.03, delta=0.01)


class CasesTest(unittest.TestCase):
    def test_queries_exist_and_ddl_targets_orders(self):
        for case in index_cases.CASES.values():
            for query in case.queries:
                self.assertIn(query, index_cases.QUERIES)
            for ddl in case.ddl:
                self.assertIn(" ON orders ", ddl)
        for sql in index_cases.QUERIES.values():
            self.assertFalse(sql.rstrip().endswith(";"))

    def test_situation_labels(self):
        def labels(situation):
            return [case.label for case in index_cases.CASES.values() if case.situation == situation]

        self.assertEqual(labels("1"), ["(가)", "(나)", "(다)", "(라)", "(마)"])
        self.assertEqual(labels("1-1"), ["(가)", "(나)", "(다)", "(마)"])
        self.assertEqual(labels("1-3"), ["(가)~(라)", "(마)", "(마) 앞부분 길이", "3번 고쳐 쓴 쿼리", "(가) 함수 인덱스"])
        self.assertEqual(labels("2"), ["(가)", "(나)", "(다)", "(라)"])

    def test_phone_queries_use_an_existing_value(self):
        # 1-3 전화번호 쿼리는 id 777777 행의 값을 쓴다. 숫자 리터럴은 앞의 0이 빠진 같은 값이다.
        # 행 수가 달라지면 난수 순서도 달라지므로 100만 행 그대로 만들며 찾는다.
        phone = next(row[4] for row in orders_data.rows() if row[0] == 777777)
        self.assertIn(f"phone = '{phone}'", index_cases.QUERIES["phone-string"])
        self.assertIn(f"phone = {phone}", index_cases.QUERIES["phone-number"])
        self.assertIn(f"LIKE '%{phone[-4:]}'", index_cases.QUERIES["phone-suffix"])
        self.assertIn(f"LIKE '{phone[:7]}%'", index_cases.QUERIES["phone-prefix"])

    def test_only_memo_case_expects_ddl_error(self):
        expecting = [case.name for case in index_cases.CASES.values() if case.expect_ddl_error]
        self.assertEqual(expecting, ["s1-3-memo"])


class WriteDataTest(unittest.TestCase):
    def test_more_rows_follow_main_rows(self):
        first = list(orders_data.more_rows(count=3000))
        self.assertEqual(first, list(orders_data.more_rows(count=3000)))
        self.assertEqual([row[0] for row in first], list(range(orders_data.ROWS + 1, orders_data.ROWS + 3001)))
        created = [row[6] for row in first]
        self.assertEqual(created, sorted(created))
        self.assertGreaterEqual(created[0], datetime(2026, 11, 10))
        self.assertTrue(all(len(row) == len(orders_data.COLUMNS) for row in first))

    def test_uuid_bits_and_order(self):
        import random
        import uuid

        rng = random.Random(3)
        v4 = [uuid.UUID(bytes=orders_data.uuid4_bytes(rng)) for _ in range(200)]
        self.assertTrue(all(u.version == 4 and u.variant == uuid.RFC_4122 for u in v4))
        rows = list(orders_data.rows(count=2000, heavy_rows=100))
        v7 = [orders_data.uuid7_bytes(row[6], rng) for row in rows]
        self.assertTrue(all(uuid.UUID(bytes=b).version == 7 for b in v7))
        # 앞 48비트(밀리초)는 created_at 순서와 같다. 같은 초 안에서는 뒤 난수가 순서를 정한다.
        self.assertEqual([b[:6] for b in v7], sorted(b[:6] for b in v7))
        self.assertNotEqual(v7, sorted(v7)) if len({row[6] for row in rows}) < len(rows) else None

    def test_pk_rows_shape(self):
        import write_lab

        auto = write_lab.pk_rows("pk-auto", 500)
        uuid4 = write_lab.pk_rows("pk-uuid4", 500)
        self.assertEqual(len(auto[0]), len(orders_data.COLUMNS) - 1)
        self.assertEqual(len(uuid4[0]), len(orders_data.COLUMNS))
        self.assertEqual(len({row[0] for row in uuid4}), 500)
        self.assertEqual(uuid4, write_lab.pk_rows("pk-uuid4", 500))
        self.assertEqual(write_lab.rotated(["a", "b", "c"], 1), ["b", "c", "a"])
        self.assertEqual(write_lab.rotated(["a", "b", "c"], 3), ["a", "b", "c"])


if __name__ == "__main__":
    unittest.main()
