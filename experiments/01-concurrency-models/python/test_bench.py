"""정답 검증과 측정 결과 집계의 기본 동작을 확인한다."""

from contextlib import redirect_stderr
import asyncio
from io import StringIO
import sys
import unittest

from bench import print_summary
from models import run_asyncio
from workloads import Job, count_primes, reference_count, run_job


class WorkloadTests(unittest.TestCase):
    def test_prime_counts_at_boundaries(self):
        for n, expected in [(0, 0), (1, 0), (2, 1), (3, 2), (4, 2), (10, 4), (100, 25)]:
            with self.subTest(n=n):
                self.assertEqual(count_primes(n), expected)
                self.assertEqual(reference_count(n), expected)

    def test_reference_for_planned_inputs(self):
        self.assertEqual(reference_count(20_000), 2_262)
        self.assertEqual(reference_count(200_000), 17_984)

    def test_worker_rejects_wrong_gil_state(self):
        for task in ("cpu", "io"):
            with self.subTest(task=task), self.assertRaisesRegex(RuntimeError, "GIL 상태 불일치"):
                run_job(Job(task, not sys._is_gil_enabled(), n=10))


class AsyncLimitTests(unittest.TestCase):
    def test_active_jobs_respect_the_limit_and_all_finish(self):
        for workers in (1, 4):
            with self.subTest(workers=workers):
                active = peak = completed = 0

                async def instrumented_job(job):
                    nonlocal active, peak, completed
                    active += 1
                    peak = max(peak, active)
                    await asyncio.sleep(0)
                    active -= 1
                    completed += 1
                    return 1

                jobs = [Job("io", sys._is_gil_enabled())] * 9
                results = run_asyncio(jobs, workers, instrumented_job)
                self.assertEqual(peak, workers)
                self.assertEqual(active, 0)
                self.assertEqual(completed, 9)
                self.assertEqual(results, [1] * 9)


class SummaryTests(unittest.TestCase):
    def test_warmup_failures_and_different_sizes_are_not_mixed(self):
        def row(n, run, seconds, valid=True):
            return {
                "task": "cpu", "size": 8,
                "params": {"n": n}, "model": "sequential", "workers": 1,
                "run": run, "wall_s": seconds, "valid": valid,
            }

        rows = [row(10, 0, 100), row(10, 1, 1), row(10, 2, 3), row(10, 3, 50, False), row(100, 1, 8)]
        output = StringIO()
        with redirect_stderr(output):
            print_summary(rows)
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[1].split(), ["cpu", "sequential", "n=10", "8", "1", "2.000000", "1.000000", "3.000000"])
        self.assertEqual(lines[2].split(), ["cpu", "sequential", "n=100", "8", "1", "8.000000", "8.000000", "8.000000"])

    def test_worker_counts_are_summarized_separately(self):
        rows = [
            {"task": "cpu", "size": 8, "params": {"n": 100}, "model": "processes", "workers": workers,
             "run": run, "wall_s": seconds, "valid": True}
            for workers, run, seconds in [(4, 1, 2), (8, 1, 8), (4, 2, 4), (8, 2, 12)]
        ]
        output = StringIO()
        with redirect_stderr(output):
            print_summary(rows)
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[1].split(), ["cpu", "processes", "n=100", "8", "4", "3.000000", "2.000000", "4.000000"])
        self.assertEqual(lines[2].split(), ["cpu", "processes", "n=100", "8", "8", "10.000000", "8.000000", "12.000000"])

    def test_task_input_and_workload_sizes_are_not_mixed(self):
        rows = [
            {"task": task, "params": params, "size": size, "model": "sequential",
             "workers": 1, "run": 1, "wall_s": seconds, "valid": True}
            for task, params, size, seconds in [
                ("cpu", {"n": 1}, 8, 2),
                ("io", {"sleep_s": 1}, 8, 3),
                ("io", {"sleep_s": 1}, 40, 4),
                ("io", {"sleep_s": 2}, 8, 5),
            ]
        ]
        output = StringIO()
        with redirect_stderr(output):
            print_summary(rows)
        lines = [line.split() for line in output.getvalue().splitlines()[1:]]
        self.assertEqual(len(lines), 4)
        self.assertEqual([line[:5] for line in lines], [
            ["cpu", "sequential", "n=1", "8", "1"],
            ["io", "sequential", "sleep=1", "8", "1"],
            ["io", "sequential", "sleep=1", "40", "1"],
            ["io", "sequential", "sleep=2", "8", "1"],
        ])
        self.assertEqual([line[5] for line in lines], ["2.000000", "3.000000", "4.000000", "5.000000"])


if __name__ == "__main__":
    unittest.main()
