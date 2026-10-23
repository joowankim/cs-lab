"""재개 시각·고정된 예정 시각·실행 위치·오류 분리를 검증한다."""

import asyncio
from contextlib import redirect_stderr
from io import StringIO
import sys
import unittest

from loop_kernels import LoopWork, blocking_wait, compute
from loop_lab import observe, print_loop_summary


class LoopTests(unittest.TestCase):
    def run_observation(self, action, expected=1):
        return asyncio.run(observe(action, LoopWork(sleep_s=0.02, n=100, cpu_jobs=2),
                                   period_s=0.005, ticks=6, expected_check=expected,
                                   expected_gil=sys._is_gil_enabled()))

    def test_blocking_work_delays_heartbeat_without_shifting_deadlines(self):
        row = self.run_observation(blocking_wait)
        self.assertTrue(row["valid"])
        events, beats = row["action_events"], row["heartbeats"]
        self.assertGreaterEqual(beats[0]["resumed_s"], events[-1]["at_s"])
        for index, beat in enumerate(beats, start=1):
            self.assertAlmostEqual(beat["due_s"], index * 0.005, places=7)
            self.assertAlmostEqual(beat["lag_s"], beat["resumed_s"] - beat["due_s"], places=7)
        self.assertEqual(row["first_lag_s"], beats[0]["lag_s"])
        self.assertEqual(row["max_lag_s"], max(beat["lag_s"] for beat in beats))
        self.assertEqual(len({(e["pid"], e["native_thread_id"], e["loop_id"]) for e in events + beats}), 1)
        self.assertNotEqual(events[0]["task_id"], beats[0]["task_id"])

    def test_async_reference_allows_heartbeat_before_a_finishes(self):
        # 실행 틀 검증용 기준 함수다. 사용자가 수정할 candidate와 별개다.
        async def reference(work):
            await asyncio.sleep(work.sleep_s)
            return 1

        row = self.run_observation(reference)
        self.assertTrue(row["valid"])
        self.assertLess(row["heartbeats"][0]["resumed_s"], row["action_events"][-1]["at_s"])

    def test_idle_control_has_no_a_task(self):
        row = self.run_observation(None, expected=None)
        self.assertTrue(row["comparison_valid"])
        self.assertEqual(row["action_events"], [])
        self.assertIsNone(row["action_wall_s"])
        self.assertEqual(row["check"], {"action": None, "ticks": 6})

    def test_cpu_result_uses_all_jobs(self):
        row = self.run_observation(compute, expected=50)
        self.assertTrue(row["valid"])
        self.assertEqual(row["check"], {"action": 50, "ticks": 6})

    def test_wrong_return_and_exception_are_not_valid_latency_samples(self):
        async def wrong(work):
            return 99

        async def failing(work):
            raise RuntimeError("검사용 오류")

        for action in (wrong, failing):
            with self.subTest(action=action.__name__):
                row = self.run_observation(action)
                self.assertFalse(row["valid"])
                self.assertFalse(row["comparison_valid"])
                self.assertTrue(row["errors"])
                self.assertEqual(len(row["heartbeats"]), 6)

    def test_summary_excludes_warmup_errors_and_different_inputs(self):
        def row(run, first, peak, valid=True, period=0.1, variant="gil=on;case=blocking"):
            return {"runtime": "test", "variant": variant, "case": "blocking",
                    "params": {"period_s": period}, "run": run, "comparison_valid": valid,
                    "first_lag_s": first, "max_lag_s": peak}

        rows = [row(0, 99, 99), row(1, 0.8, 0.9), row(2, 1.0, 1.1), row(3, 99, 99, valid=False),
                row(1, 0.01, 0.02, period=0.01), row(1, 0.4, 0.5, variant="gil=off;case=blocking")]
        output = StringIO()
        with redirect_stderr(output):
            print_loop_summary(rows)
        text = output.getvalue()
        self.assertEqual(text.count("samples="), 3)
        self.assertIn("first_lag_s: median=0.900000 min=0.800000 max=1.000000", text)
        self.assertIn("max_lag_s: median=1.000000 min=0.900000 max=1.100000", text)
        self.assertNotIn("99.000000", text)


if __name__ == "__main__":
    unittest.main()
