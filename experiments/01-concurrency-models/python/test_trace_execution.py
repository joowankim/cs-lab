"""추적 식별자와 실제 실행 위치, 대기 전후 기록을 확인한다."""

import os
import sys
import threading
from time import perf_counter_ns
import unittest

from models import run_asyncio, run_threads
from trace_execution import TraceInput, trace_async_job, trace_job
from workloads import Job


class TraceTests(unittest.TestCase):
    def inputs(self, count=8, task="io"):
        origin = perf_counter_ns()
        job = Job(task, sys._is_gil_enabled(), n=100, sleep_s=0.001)
        expected = 25 if task == "cpu" else 1
        return [TraceInput(i, job, expected, origin) for i in range(count)]

    def check_records(self, records, count=8):
        self.assertEqual(sorted(r["job_id"] for r in records), list(range(count)))
        for record in records:
            self.assertTrue(record["valid"])
            start, end = record["events"]
            self.assertEqual([start["event"], end["event"]], ["work_start", "work_end"])
            self.assertLessEqual(start["at_ns"], end["at_ns"])
            self.assertEqual(start["pid"], end["pid"])
            self.assertEqual(start["native_thread_id"], end["native_thread_id"])

    def test_sync_cpu_records_the_calling_thread_without_an_asyncio_task(self):
        record = trace_job(self.inputs(count=1, task="cpu")[0])
        self.check_records([record], count=1)
        self.assertEqual(record["check"], 25)
        for event in record["events"]:
            self.assertEqual(event["pid"], os.getpid())
            self.assertEqual(event["native_thread_id"], threading.get_native_id())
            self.assertIsNone(event["asyncio_task_id"])
            self.assertIsNone(event["loop_id"])

    def test_thread_pool_jobs_are_recorded_in_worker_threads(self):
        records = run_threads(self.inputs(), 4, trace_job)
        self.check_records(records)
        observed = set()
        for record in records:
            for event in record["events"]:
                self.assertEqual(event["pid"], os.getpid())
                self.assertNotEqual(event["native_thread_id"], threading.get_native_id())
                self.assertIsNone(event["asyncio_task_id"])
                observed.add(event["native_thread_id"])
        self.assertLessEqual(len(observed), 4)

    def test_asyncio_tasks_resume_on_the_loop_thread_with_the_limit_preserved(self):
        records = run_asyncio(self.inputs(), 4, trace_async_job)
        self.check_records(records)
        task_ids, loop_ids, timeline = set(), set(), []
        for record in records:
            start, end = record["events"]
            self.assertEqual(start["asyncio_task_id"], end["asyncio_task_id"])
            self.assertEqual(start["loop_id"], end["loop_id"])
            for event in record["events"]:
                self.assertEqual(event["pid"], os.getpid())
                self.assertEqual(event["native_thread_id"], threading.get_native_id())
                self.assertIsNotNone(event["asyncio_task_id"])
                self.assertIsNotNone(event["loop_id"])
                task_ids.add(event["asyncio_task_id"])
                loop_ids.add(event["loop_id"])
                timeline.append((event["at_ns"], 1 if event["event"] == "work_start" else -1))
        self.assertEqual(len(task_ids), 8)
        self.assertEqual(len(loop_ids), 1)
        active = peak = 0
        for _, change in sorted(timeline):
            active += change
            peak = max(peak, active)
        self.assertEqual(active, 0)
        self.assertGreater(peak, 1)
        self.assertLessEqual(peak, 4)

    def test_worker_error_is_preserved_as_a_failed_trace(self):
        item = TraceInput(0, Job("cpu", not sys._is_gil_enabled(), n=100), 25, perf_counter_ns())
        record = trace_job(item)
        self.assertFalse(record["valid"])
        self.assertIsNone(record["check"])
        self.assertIn("GIL 상태 불일치", record["error"])
        self.assertEqual(record["events"][-1]["event"], "work_error")


if __name__ == "__main__":
    unittest.main()
