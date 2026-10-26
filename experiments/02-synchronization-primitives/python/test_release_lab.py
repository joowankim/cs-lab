"""오류 위치·동시 호출 수·실행 오류를 구분해 기록하는지 검증한다."""

from contextlib import redirect_stderr
from io import StringIO
import threading
import unittest

from release_kernels import LIMITS, call_api_buggy, call_api_candidate, make_slots
from release_lab import print_release_summary, run_trial


def reference_slots(kind):
    # 실행 틀 검증용 기준 도구다. 실험에 쓰는 make_slots()와 따로 둔다.
    limit = LIMITS[kind]
    return {
        "semaphore": lambda: threading.Semaphore(limit),
        "bounded": lambda: threading.BoundedSemaphore(limit),
        "lock": threading.Lock,
        "rlock": threading.RLock,
    }[kind]()


def reference_fix(slots, api, req):
    # 실행 틀 검증용 기준 함수다. 실험에 쓰는 call_api_candidate()와 따로 둔다.
    with slots:
        try:
            return api.send(req)
        except TimeoutError:
            return api.send_later(req)


class ReleaseLabTests(unittest.TestCase):
    def test_reference_fix_keeps_limit_without_errors(self):
        for kind in LIMITS:
            with self.subTest(kind=kind):
                row = run_trial(reference_fix, reference_slots, kind,
                                requests=12, workers=4, timeout_calls=(3, 7), call_s=0.01)
                self.assertTrue(row["valid"])
                self.assertEqual((row["check"], row["expected_check"]), (12, 12))
                self.assertEqual(row["error_types"], {})
                self.assertEqual(row["release_errors"], {})
                self.assertLessEqual(row["max_in_flight"], LIMITS[kind])
                self.assertEqual(row["timeout_releases"], [["ok"], ["ok"]])
                self.assertEqual(row["queued"], 2)

    def test_concurrent_calls_are_counted(self):
        both_acquired = threading.Barrier(2)

        def overlapping(slots, api, req):
            with slots:
                both_acquired.wait(timeout=5)
                return api.send(req)

        row = run_trial(overlapping, lambda kind: threading.Semaphore(2), "semaphore",
                        requests=2, workers=2, timeout_calls=(), call_s=0.05)
        self.assertTrue(row["valid"])
        self.assertEqual(row["max_in_flight"], 2)

    def test_single_double_release_is_recorded_on_the_timeout_call(self):
        # 다른 스레드가 없으므로 타임아웃 난 호출의 두 번째 release()만 결과를 정한다.
        for kind in LIMITS:
            with self.subTest(kind=kind):
                row = run_trial(call_api_buggy, reference_slots, kind,
                                requests=1, workers=1, timeout_calls=(1,), call_s=0.01)
                self.assertTrue(row["valid"])
                self.assertEqual(row["errors_in_other_calls"], 0)
                second = row["timeout_releases"][0][1]
                self.assertEqual(row["errors_in_timeout_calls"], int(second != "ok"))
                if second == "ok":
                    self.assertEqual(row["calls"][0]["result"], "queued")
                else:
                    self.assertTrue(row["calls"][0]["error"].startswith(second))

    def test_forced_release_of_another_threads_lock_is_an_observation(self):
        # T의 두 번째 release()가 U가 잠근 Lock을 풀게 순서를 고정한다.
        t_acquired = threading.Event()
        u_acquired = threading.Event()

        def forced(slots, api, req):
            if req == 1:
                slots.acquire()
                t_acquired.set()
                try:
                    return api.send(req)
                except TimeoutError:
                    slots.release()
                    u_acquired.wait(timeout=5)
                    return api.send_later(req)
                finally:
                    slots.release()
            t_acquired.wait(timeout=5)
            slots.acquire()
            u_acquired.set()
            try:
                return api.send(req)
            finally:
                slots.release()

        row = run_trial(forced, reference_slots, "lock",
                        requests=2, workers=2, timeout_calls=(1,), call_s=0.01)
        self.assertTrue(row["valid"])
        self.assertEqual(row["timeout_releases"], [["ok", "ok"]])
        self.assertEqual(row["errors_in_timeout_calls"], 0)
        self.assertEqual(row["errors_in_other_calls"], 1)
        self.assertEqual(row["error_types"], {"RuntimeError": 1})
        self.assertEqual(row["release_errors"], {"RuntimeError": 1})
        self.assertEqual(row["calls"][1]["releases"], ["RuntimeError"])

    def test_error_outside_release_marks_the_trial_invalid(self):
        def unfinished(slots, api, req):
            raise NotImplementedError("작성 중")

        row = run_trial(unfinished, reference_slots, "semaphore",
                        requests=3, workers=2, timeout_calls=(), call_s=0.01)
        self.assertFalse(row["valid"])
        self.assertEqual(row["check"], 0)

    def test_make_slots_builds_each_tool(self):
        expected = {"semaphore": threading.Semaphore, "bounded": threading.BoundedSemaphore,
                    "lock": type(threading.Lock()), "rlock": type(threading.RLock())}
        for kind, tool in expected.items():
            with self.subTest(kind=kind):
                self.assertIs(type(make_slots(kind)), tool)

    def test_candidate_keeps_limit_without_errors(self):
        for kind in LIMITS:
            with self.subTest(kind=kind):
                row = run_trial(call_api_candidate, make_slots, kind,
                                requests=12, workers=6, timeout_calls=(3, 7), call_s=0.01)
                self.assertTrue(row["valid"])
                self.assertEqual(row["release_errors"], {})
                self.assertLessEqual(row["max_in_flight"], LIMITS[kind])
                self.assertEqual(row["timeout_releases"], [["ok"], ["ok"]])

    def test_summary_excludes_warmup(self):
        def row(run, peak):
            return {"code": "buggy", "kind": "semaphore", "run": run, "max_in_flight": peak,
                    "errors_in_timeout_calls": 0, "errors_in_other_calls": 0,
                    "timeout_releases": [["ok", "ok"]], "release_errors": {}, "final_state": 5}

        output = StringIO()
        with redirect_stderr(output):
            print_release_summary([row(0, 9), row(1, 5), row(2, 6), row(3, 7)])
        fields = output.getvalue().splitlines()[1].split()
        self.assertEqual(fields[:6], ["buggy", "semaphore", "3", "6", "[5~7]", "0/0"])
        self.assertEqual(fields[6], "0/3")
        self.assertEqual(fields[7:9], ["{0:", "3}"])


if __name__ == "__main__":
    unittest.main()
