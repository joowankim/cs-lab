"""정상 완료, 갱신 유실, 실행 오류를 구분하는지 검증한다."""

from contextlib import redirect_stderr
from io import StringIO
import sys
import threading
import unittest

from counter_kernels import increment_unlocked
from counter_lab import print_counter_summary, run_trial


class CounterTests(unittest.TestCase):
    def test_reference_lock_preserves_all_updates(self):
        # 실행 틀 검증용 기준 함수다. 사용자가 수정할 candidate와 별개다.
        def reference(counter, lock, pause):
            with lock:
                increment_unlocked(counter, lock, pause)

        row = run_trial(reference, workers=2, increments=3, yield_between=True,
                        expected_gil=sys._is_gil_enabled())
        self.assertTrue(row["valid"])
        self.assertTrue(row["correct"])
        self.assertEqual((row["check"], row["expected_check"], row["finished_calls"]), (6, 6, 6))

    def test_lost_update_is_a_valid_observation_not_an_execution_error(self):
        both_read = threading.Barrier(2)

        def forced_interleaving(counter, lock, pause):
            previous = counter.completed
            both_read.wait(timeout=5)
            counter.completed = previous + 1

        row = run_trial(forced_interleaving, workers=2, increments=1, yield_between=True,
                        expected_gil=sys._is_gil_enabled())
        self.assertTrue(row["valid"])
        self.assertFalse(row["correct"])
        self.assertEqual((row["check"], row["expected_check"], row["finished_calls"]), (1, 2, 2))

    def test_worker_exception_is_not_counted_as_a_lost_update(self):
        def failing(counter, lock, pause):
            raise RuntimeError("검사용 오류")

        row = run_trial(failing, workers=2, increments=1, yield_between=True,
                        expected_gil=sys._is_gil_enabled())
        self.assertFalse(row["valid"])
        self.assertFalse(row["correct"])
        self.assertEqual(row["finished_calls"], 0)
        self.assertTrue(all("검사용 오류" in r["error"] for r in row["worker_results"]))

    def test_summary_excludes_warmup_and_separates_errors(self):
        rows = [
            {"case": "unlocked", "run": run, "valid": valid, "correct": correct}
            for run, valid, correct in [(0, True, False), (1, True, True), (2, True, False), (3, False, False)]
        ]
        output = StringIO()
        with redirect_stderr(output):
            print_counter_summary(rows)
        self.assertEqual(output.getvalue().splitlines()[1].split(), ["unlocked", "3", "1", "1", "1"])


if __name__ == "__main__":
    unittest.main()
