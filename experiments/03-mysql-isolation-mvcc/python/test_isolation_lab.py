"""실행 틀이 단계의 값·기다림·오류를 제대로 기록하는지 가짜 DB로 확인한다. DB 없이 돈다."""

from collections import defaultdict
import threading
import unittest

from isolation_lab import observation, run_timeline
from isolation_timelines import TIMELINES, Step, Timeline

FAST = {"wait_s": 0.05, "settle_s": 0.05, "stuck_s": 1.0}


class FakeSession:
    """WAIT 이름은 같은 이름의 SIGNAL이 올 때까지 막히고, FAIL은 오류를 낸다. 나머지는 SQL을 그대로 돌려준다."""

    def __init__(self, driver, server_id: int):
        self.driver = driver
        self.server_id = server_id

    def execute(self, sql: str) -> dict:
        word, _, name = sql.partition(" ")
        if word == "WAIT":
            event = self.driver.events[name]
            event.wait()
            if self.server_id in self.driver.cancelled:
                raise RuntimeError("취소됨")
            return {"rows": [[f"waited {name}"]], "rowcount": 1, "status": None, "notices": None}
        if word == "SIGNAL":
            self.driver.events[name].set()
            return {"rows": None, "rowcount": 0, "status": None, "notices": None}
        if word == "FAIL":
            raise RuntimeError(name)
        self.driver.executed.append(sql)
        return {"rows": [[sql]], "rowcount": 1, "status": None, "notices": None}

    def close(self) -> None:
        self.driver.closed += 1


class FakeDriver:
    name = "fake"

    def __init__(self):
        self.events: defaultdict[str, threading.Event] = defaultdict(threading.Event)
        self.executed: list[str] = []
        self.setup: list[str] = []
        self.cancelled: set[int] = set()
        self.closed = 0
        self._next_id = 0

    def connect(self, isolation: str | None = None) -> FakeSession:
        self._next_id += 1
        return FakeSession(self, self._next_id)

    def reset(self, statements: tuple[str, ...]) -> None:
        self.setup.extend(statements)

    def cancel(self, server_id: int) -> None:
        self.cancelled.add(server_id)
        for event in self.events.values():
            event.set()


def timeline(*steps: Step) -> Timeline:
    return Timeline(name="fake", title="가짜", dbs=("fake",), setup=("SETUP",), steps=steps)


class RunTimelineTest(unittest.TestCase):
    def test_records_values_in_order(self):
        driver = FakeDriver()
        result = run_timeline(timeline(Step("A", "one"), Step("B", "two"), Step("A", "three")), driver,
                              "READ COMMITTED", **FAST)
        self.assertTrue(result["valid"])
        self.assertEqual(driver.setup, ["SETUP"])
        self.assertEqual([s["rows"] for s in result["steps"]], [[["one"]], [["two"]], [["three"]]])
        self.assertEqual([s["finished_after_step"] for s in result["steps"]], [1, 2, 3])
        self.assertFalse(any(s["blocked"] or s["deferred"] for s in result["steps"]))
        # 세션마다 ROLLBACK으로 정리하고 연결을 닫는다.
        self.assertEqual(driver.executed.count("ROLLBACK"), 2)
        self.assertEqual(driver.closed, 2)

    def test_blocked_step_finishes_after_the_step_that_unblocks_it(self):
        result = run_timeline(timeline(Step("A", "WAIT x"), Step("B", "SIGNAL x"), Step("A", "after")),
                              FakeDriver(), "REPEATABLE READ", **FAST)
        first, second, third = result["steps"]
        self.assertTrue(first["blocked"])
        self.assertEqual(first["finished_after_step"], 2)
        self.assertEqual(first["rows"], [["waited x"]])
        self.assertFalse(second["blocked"])
        self.assertEqual(third["finished_after_step"], 3)
        self.assertIn("기다림, 2단계 뒤 끝남", observation(first))

    def test_errors_are_recorded_as_observations(self):
        result = run_timeline(timeline(Step("A", "FAIL boom"), Step("A", "next")), FakeDriver(), "SERIALIZABLE",
                              **FAST)
        self.assertTrue(result["valid"])
        failed = result["steps"][0]
        self.assertEqual(failed["outcome"], "error")
        self.assertEqual(failed["error"]["type"], "RuntimeError")
        self.assertEqual(failed["error"]["message"], "boom")
        self.assertEqual(result["steps"][1]["outcome"], "ok")

    def test_steps_of_a_waiting_session_are_deferred_while_the_other_continues(self):
        driver = FakeDriver()
        result = run_timeline(timeline(Step("A", "WAIT x"), Step("A", "a2"), Step("B", "b1"), Step("B", "SIGNAL x"),
                                       Step("B", "b3")), driver, "SERIALIZABLE", **FAST)
        self.assertTrue(result["valid"])
        waiting, later, *_ = result["steps"]
        self.assertTrue(waiting["blocked"])
        self.assertEqual(waiting["finished_after_step"], 4)
        # A의 2단계는 A가 풀린 4단계 뒤에 보내고, 그동안 B는 순서대로 계속 간다.
        self.assertTrue(later["deferred"])
        self.assertEqual(later["sent_after_step"], 4)
        self.assertEqual(later["rows"], [["a2"]])
        self.assertEqual([s["sent_after_step"] for s in result["steps"]], [1, 4, 3, 4, 5])
        self.assertEqual(driver.executed[:3], ["b1", "a2", "b3"])
        sent = [s["sent_at_s"] for s in result["steps"]]
        self.assertLess(sent[2], sent[1])
        self.assertIn("미룸, 4단계 뒤 보냄", observation(later))

    def test_deferred_step_is_sent_when_its_session_frees_after_the_last_step(self):
        driver = FakeDriver()
        threading.Timer(0.5, driver.events["late"].set).start()
        result = run_timeline(timeline(Step("A", "WAIT late"), Step("A", "after")), driver, "READ COMMITTED",
                              **FAST)
        first, second = result["steps"]
        self.assertTrue(first["blocked"])
        self.assertEqual(first["finished_after_step"], 2)
        self.assertTrue(second["deferred"])
        self.assertEqual(second["rows"], [["after"]])
        self.assertTrue(result["valid"])

    def test_stuck_step_is_cancelled_and_marks_the_run_invalid(self):
        driver = FakeDriver()
        result = run_timeline(timeline(Step("A", "WAIT never"), Step("B", "other"), Step("A", "after")), driver,
                              "READ COMMITTED", **FAST)
        self.assertFalse(result["valid"])
        self.assertEqual(result["check"], 1)
        self.assertEqual(result["stuck_sessions"], ["A"])
        self.assertEqual(result["steps"][0]["outcome"], "stuck")
        self.assertEqual(driver.cancelled, {1})
        self.assertEqual(observation(result["steps"][0]), "멈춤 (취소함)")
        # 멈춘 세션에 미뤄 둔 단계는 보내지 않는다.
        self.assertEqual(observation(result["steps"][2]), "보내지 않음")


class TimelineTest(unittest.TestCase):
    def test_timelines_use_two_sessions_and_known_dbs(self):
        for timeline_ in TIMELINES.values():
            self.assertLessEqual({s.session for s in timeline_.steps}, {"A", "B"})
            self.assertLessEqual(set(timeline_.dbs), {"mysql", "postgres"})
            for db in timeline_.dbs:
                self.assertTrue(timeline_.setup_for(db))

    def test_myisam_timelines_run_only_on_mysql(self):
        # PostgreSQL에는 MyISAM이 없어 준비 SQL부터 실패한다.
        for timeline_ in TIMELINES.values():
            if any("MyISAM" in sql for sql in timeline_.setup):
                self.assertEqual(timeline_.dbs, ("mysql",))


if __name__ == "__main__":
    unittest.main()
