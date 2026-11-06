"""풀 측정 틀이 기다림·타임아웃·끝난 시간을 제대로 세는지 가짜 풀로 확인한다. DB와 SQLAlchemy 없이 돈다."""

from contextlib import contextmanager
import threading
import unittest

from pool_lab import CASES, burst, percentile, sequential, spread


class FakeTimeout(Exception):
    pass


class FakeConnection:
    def __init__(self, engine):
        self.engine = engine

    @contextmanager
    def begin(self):
        yield

    def execute(self, statement):
        with self.engine.lock:
            self.engine.executed += 1


class FakeEngine:
    """연결이 size개인 풀. 남은 연결이 없으면 timeout_s까지 기다리고, 넘으면 FakeTimeout을 낸다."""

    def __init__(self, size: int, timeout_s: float):
        self.slots = threading.BoundedSemaphore(size)
        self.timeout_s = timeout_s
        self.lock = threading.Lock()
        self.executed = 0

    @contextmanager
    def connect(self):
        if not self.slots.acquire(timeout=self.timeout_s):
            raise FakeTimeout()
        try:
            yield FakeConnection(self)
        finally:
            self.slots.release()


class BurstTest(unittest.TestCase):
    def test_requests_queue_for_the_pool(self):
        # 연결 2개에 요청 6개, 0.1초씩 보유하면 0, 0.1, 0.2초에 두 개씩 받아 0.3초쯤 끝난다.
        result = burst(FakeEngine(2, 5), "SELECT 1", (FakeTimeout,), requests=6, hold_s=0.1)
        self.assertTrue(result["valid"])
        self.assertEqual((result["summary"]["ok"], result["summary"]["timeout"]), (6, 0))
        self.assertAlmostEqual(result["summary"]["wait_s"]["max"], 0.2, delta=0.05)
        self.assertAlmostEqual(result["wall_s"], 0.3, delta=0.05)
        self.assertEqual(len(result["requests"]), 6)

    def test_pool_timeout_is_counted_not_raised(self):
        # 연결 2개를 0.2초씩 보유하는 동안 나머지 4개는 0.1초를 기다리다 타임아웃한다.
        result = burst(FakeEngine(2, 0.1), "SELECT 1", (FakeTimeout,), requests=6, hold_s=0.2)
        self.assertTrue(result["valid"])
        self.assertEqual((result["summary"]["ok"], result["summary"]["timeout"]), (2, 4))
        self.assertAlmostEqual(result["summary"]["timeout_after_s"]["median"], 0.1, delta=0.05)

    def test_other_errors_make_the_run_invalid(self):
        class Broken(FakeEngine):
            @contextmanager
            def connect(self):
                raise RuntimeError("DB가 거절함")
                yield

        result = burst(Broken(1, 1), "SELECT 1", (FakeTimeout,), requests=3, hold_s=0)
        self.assertFalse(result["valid"])
        self.assertEqual(len(result["failures"]), 3)


class SequentialTest(unittest.TestCase):
    def test_counts_every_sample(self):
        engine = FakeEngine(1, 1)
        result = sequential(engine, "SELECT 1", count=20)
        self.assertTrue(result["valid"])
        self.assertEqual(len(result["samples_s"]), 20)
        self.assertEqual(engine.executed, 20)
        self.assertLessEqual(result["summary"]["seconds"]["min"], result["summary"]["seconds"]["median"])


class StatsTest(unittest.TestCase):
    def test_nearest_rank(self):
        values = [float(n) for n in range(1, 21)]
        self.assertEqual(percentile(values, 0.95), 19.0)
        self.assertEqual(percentile([5.0], 0.95), 5.0)
        self.assertEqual(spread([]), {"median": None, "p95": None, "min": None, "max": None})


class CaseTableTest(unittest.TestCase):
    def test_cases_match_the_problem(self):
        bursts = {name: case for name, case in CASES.items() if case.kind == "burst"}
        self.assertEqual(sorted(bursts), ["null", "queue-10-30", "queue-5-0.5", "queue-5-30", "queue-50-30"])
        self.assertEqual(sorted(CASES[name].size for name in bursts if name != "null"), [5, 5, 10, 50])
        self.assertEqual({case.pool for case in CASES.values() if case.kind == "sequential"}, {"null", "queue"})


if __name__ == "__main__":
    unittest.main()
