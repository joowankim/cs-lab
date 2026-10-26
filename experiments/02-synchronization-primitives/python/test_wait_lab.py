"""로딩 시간·깨어나기까지 걸린 시간·실행 오류를 구분해 기록하는지 검증한다."""

from contextlib import redirect_stderr
from io import StringIO
from statistics import median
import threading
import unittest

from wait_kernels import WAITS, Ready, build_index
from wait_lab import calibrate, print_wait_summary, run_trial


N = 20_000
EXPECTED = build_index(N)


def reference_wait(ready):
    # 실행 틀 검증용 기준 함수다. 실험에 쓰는 wait_event()와 따로 둔다.
    ready.event.wait(timeout=5)


class WaitLabTests(unittest.TestCase):
    def test_each_wait_returns_after_ready(self):
        for name, wait in WAITS.items():
            with self.subTest(wait=name):
                ready = Ready()
                thread = threading.Thread(target=wait, args=(ready,), daemon=True)
                thread.start()
                threading.Timer(0.02, ready.set).start()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())

    def test_loader_alone_and_with_waiters_are_recorded(self):
        alone = run_trial(None, 0, N, EXPECTED)
        self.assertTrue(alone["valid"])
        self.assertEqual((alone["check"], alone["wake_s"], alone["last_wake_s"]), (EXPECTED, [], None))
        row = run_trial(reference_wait, 3, N, EXPECTED)
        self.assertTrue(row["valid"])
        self.assertEqual(len(row["wake_s"]), 3)
        self.assertGreaterEqual(min(row["wake_s"]), 0)
        self.assertEqual(row["last_wake_s"], max(row["wake_s"]))
        self.assertGreater(row["load_s"], 0)

    def test_waiter_error_marks_the_trial_invalid(self):
        def unfinished(ready):
            raise NotImplementedError("작성 중")

        row = run_trial(unfinished, 2, N, EXPECTED)
        self.assertFalse(row["valid"])
        self.assertEqual(row["waiter_errors"], ["NotImplementedError: 작성 중"] * 2)

    def test_wrong_check_marks_the_trial_invalid(self):
        self.assertFalse(run_trial(reference_wait, 1, N, EXPECTED + 1)["valid"])

    def test_calibration_lands_near_the_target(self):
        # 시간에 기대는 검사라 넓게 본다.
        result = calibrate(0.05)
        self.assertEqual(result["expected"], build_index(result["n"]))
        self.assertLess(0.02, median(result["alone_s"]))
        self.assertLess(median(result["alone_s"]), 0.2)

    def test_summary_excludes_warmup_and_compares_to_loader_alone(self):
        def row(wait, waiters, run, load_s, last_wake_s):
            return {"wait": wait, "waiters": waiters, "run": run, "load_s": load_s,
                    "last_wake_s": last_wake_s, "waiter_cpu_s": 0.5, "cpu_s": 1.0}

        rows = [row("none", 0, 0, 9.0, None), row("none", 0, 1, 1.0, None), row("none", 0, 2, 1.0, None),
                row("pass", 4, 0, 9.0, 0.5), row("pass", 4, 1, 4.0, 0.002), row("pass", 4, 2, 6.0, 0.004)]
        output = StringIO()
        with redirect_stderr(output):
            print_wait_summary(rows)
        lines = output.getvalue().splitlines()
        self.assertEqual(lines[1].split()[:6], ["none", "0", "2", "1.000", "[1.000~1.000]", "1.00"])
        self.assertEqual(lines[2].split()[:9],
                         ["pass", "4", "2", "5.000", "[4.000~6.000]", "5.00", "3.00", "[2.00~4.00]", "0.500"])


if __name__ == "__main__":
    unittest.main()
