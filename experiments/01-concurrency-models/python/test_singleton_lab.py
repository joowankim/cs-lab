"""중복 생성과 반환 객체 불일치를 놓치지 않는지 검증한다."""

from contextlib import redirect_stderr
from io import StringIO
import sys
import threading
import unittest

from singleton_kernels import get_unlocked
from singleton_lab import print_singleton_summary, run_trial


class SingletonTests(unittest.TestCase):
    def trial(self, getter):
        return run_trial(getter, workers=2, yield_in_factory=True,
                         expected_gil=sys._is_gil_enabled())

    def test_reference_lock_creates_once_and_returns_the_published_object(self):
        # 실행 틀 검증용 기준 함수다. 사용자가 수정할 candidate와 별개다.
        def reference(state, lock, factory):
            with lock:
                return get_unlocked(state, lock, factory)

        row = self.trial(reference)
        self.assertTrue(row["valid"])
        self.assertTrue(row["correct"])
        self.assertEqual(row["check"], row["expected_check"])
        self.assertEqual(row["finished_calls"], 2)
        self.assertEqual(row["created_ids"], [row["published_id"]])
        self.assertTrue(all(r["returned_id"] == row["published_id"] for r in row["worker_results"]))

    def test_duplicate_creation_fails_even_when_both_return_the_same_object(self):
        both_checked = threading.Barrier(2)
        both_published = threading.Barrier(2)

        def forced_interleaving(state, lock, factory):
            if state.instance is None:
                both_checked.wait(timeout=5)
                state.instance = factory()
            both_published.wait(timeout=5)
            return state.instance

        row = self.trial(forced_interleaving)
        self.assertTrue(row["valid"])
        self.assertFalse(row["correct"])
        self.assertEqual(row["check"]["created_count"], 2)
        self.assertEqual(len(set(row["created_ids"])), 2)
        self.assertEqual(row["check"]["returned_unique"], 1)
        self.assertTrue(row["check"]["all_returned_published"])

    def test_one_creation_is_not_enough_when_a_different_object_is_returned(self):
        def wrong_return(state, lock, factory):
            with lock:
                get_unlocked(state, lock, factory)
            return object()

        row = self.trial(wrong_return)
        self.assertTrue(row["valid"])
        self.assertFalse(row["correct"])
        self.assertEqual(row["check"]["created_count"], 1)
        self.assertFalse(row["check"]["all_returned_published"])

    def test_exception_is_not_counted_as_a_race_observation(self):
        def failing(state, lock, factory):
            raise RuntimeError("검사용 오류")

        row = self.trial(failing)
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
            print_singleton_summary(rows)
        self.assertEqual(output.getvalue().splitlines()[1].split(), ["unlocked", "3", "1", "1", "1"])


if __name__ == "__main__":
    unittest.main()
