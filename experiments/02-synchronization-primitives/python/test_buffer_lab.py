"""작업자가 끝난 단계·남은 작업자 수·실행 오류를 구분해 기록하는지 검증한다."""

from collections import deque
from contextlib import redirect_stderr
from io import StringIO
import threading
from time import sleep
import unittest

from buffer_kernels import WAKES, take_if, take_while
from buffer_lab import RecordingCondition, print_buffer_summary, run_trial


SMALL = {"burst": 8, "job_s": 0.005}


def reference_take(buf):
    # 실행 틀 검증용 기준 함수다. 실험에 쓰는 take_while()과 따로 둔다.
    with buf.cond:
        while not buf.jobs:
            buf.cond.wait()
        job = buf.jobs.popleft()
        buf.wake()
        return job


def take_failing_on(job_no: int):
    # job_no번 작업을 처음 본 작업자 하나를 IndexError로 끝낸다. 작업은 꺼내지 않고 다음 작업자를 깨워 넘긴다.
    failed: list[str] = []

    def take(buf):
        with buf.cond:
            while not buf.jobs:
                buf.cond.wait()
            if buf.jobs[0] == job_no and not failed:
                failed.append(threading.current_thread().name)
                buf.wake()
                raise IndexError("시험용 실패")
            job = buf.jobs.popleft()
            buf.wake()
            return job

    return take, failed


class BufferLabTests(unittest.TestCase):
    def test_reference_take_keeps_every_worker(self):
        for wake in WAKES:
            for workers in (2, 4):
                with self.subTest(wake=wake, workers=workers):
                    row = run_trial(reference_take, wake, workers, **SMALL)
                    self.assertTrue(row["valid"])
                    self.assertEqual((row["check"], row["expected_check"]), (11, 11))
                    self.assertEqual(row["alive_at_start"], workers)
                    self.assertEqual(row["alive_after_uploads"], [workers] * 3)
                    self.assertEqual(row["alive_after_burst"], workers)
                    self.assertEqual(row["thread_errors"], [])
                    self.assertNotIn(None, row["upload_takers"])
                    self.assertGreater(row["wall_s"], 0)

    def test_worker_death_is_recorded_in_its_phase(self):
        hook = threading.excepthook
        for wake in WAKES:
            with self.subTest(wake=wake):
                take, failed = take_failing_on(2)
                row = run_trial(take, wake, 2, **SMALL)
                self.assertTrue(row["valid"])
                self.assertEqual(row["alive_after_uploads"], [2, 1, 1])
                self.assertEqual(row["alive_after_burst"], 1)
                self.assertEqual(row["index_errors_by_phase"], {"upload2": 1})
                self.assertEqual([e["thread"] for e in row["thread_errors"]], failed)
                self.assertNotEqual(row["upload_takers"][1], failed[0])
                self.assertIs(threading.excepthook, hook)

    def test_error_other_than_index_error_marks_the_trial_invalid(self):
        def unfinished(buf):
            if threading.current_thread().name == "worker-1":
                raise RuntimeError("작성 중")
            return reference_take(buf)

        row = run_trial(unfinished, "notify", 2, **SMALL)
        self.assertFalse(row["valid"])
        self.assertEqual(row["alive_at_start"], 1)
        self.assertEqual([e["type"] for e in row["thread_errors"]], ["RuntimeError"])

    def test_wakeup_with_empty_jobs_is_counted(self):
        jobs = deque()
        cond = RecordingCondition(jobs)

        def waiter():
            with cond:
                cond.wait()

        thread = threading.Thread(target=waiter)
        cond.workers = frozenset({thread})
        thread.start()
        for _ in range(1000):
            with cond:
                if cond.unnotified == 1:
                    cond.notify()
                    break
            sleep(0.001)
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual((cond.unnotified, dict(cond.empty_wakeups)), (0, {"start": 1}))

    def test_while_kernel_keeps_every_worker(self):
        for wake in WAKES:
            for workers in (2, 4):
                with self.subTest(wake=wake, workers=workers):
                    row = run_trial(take_while, wake, workers, **SMALL)
                    self.assertTrue(row["valid"])
                    self.assertEqual(row["alive_after_uploads"], [workers] * 3)
                    self.assertEqual(row["thread_errors"], [])

    def test_if_kernel_rows_are_consistent(self):
        # 남는 수 자체는 측정으로 확인한다. 여기서는 기록끼리 맞는지만 본다.
        for wake in WAKES:
            for workers in (2, 4):
                with self.subTest(wake=wake, workers=workers):
                    row = run_trial(take_if, wake, workers, **SMALL)
                    self.assertTrue(row["valid"])
                    alive = [row["alive_at_start"], *row["alive_after_uploads"], row["alive_after_burst"]]
                    self.assertEqual(alive, sorted(alive, reverse=True))
                    self.assertEqual(row["index_errors"], workers - row["alive_after_burst"])
                    self.assertEqual(row["empty_wakeups"], row["index_errors"])

    def test_summary_excludes_warmup_and_compares_pairs(self):
        def row(take, run, wall_s):
            return {"take": take, "wake": "notify", "workers": 2, "run": run, "wall_s": wall_s,
                    "alive_after_uploads": [1, 1, 1] if take == "if" else [2, 2, 2],
                    "index_errors": 1 if take == "if" else 0, "empty_wakeups": 1}

        rows = [row("if", 0, 9.0), row("if", 1, 0.4), row("if", 2, 0.5), row("if", 3, 0.6),
                row("while", 0, 9.0), row("while", 1, 0.2), row("while", 2, 0.25), row("while", 3, 0.3)]
        output = StringIO()
        with redirect_stderr(output):
            print_buffer_summary(rows)
        lines = output.getvalue().splitlines()
        self.assertIn("{'1·1·1': 3} {1: 3} 0.500 [0.400~0.600]", lines[1])
        self.assertIn("{'2·2·2': 3} {0: 3} 0.250 [0.200~0.300]", lines[2])
        self.assertEqual(lines[-1].split(), ["1/5", "2.00"])


if __name__ == "__main__":
    unittest.main()
