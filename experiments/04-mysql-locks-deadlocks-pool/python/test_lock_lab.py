"""순서표 실행 틀이 값·기다림·미룸·지연·락 읽기·데드락 보고·탐지 설정을 제대로 기록하는지 가짜 DB로 확인한다.
DB 없이 돈다. 가짜 DB는 03 실험 test_isolation_lab.py의 것에 관찰용 연결을 더했다."""

from collections import defaultdict
import threading
import unittest

from lock_lab import deadlock_section, describe_locks, observation, parse_deadlock, run_timeline
from lock_timelines import TIMELINES, Step, Timeline

FAST = {"wait_s": 0.05, "settle_s": 0.05, "stuck_s": 1.0}

DEADLOCK = """2026-11-03 12:19:55 140535012517440
*** (1) TRANSACTION:
TRANSACTION 3570, ACTIVE 3 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1128, 2 row lock(s), undo log entries 1
MySQL thread id 109, OS thread handle 140535431923264, query id 728 localhost root updating
UPDATE accounts SET balance = balance + 100 WHERE id = 2

*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 43 page no 4 n bits 72 index PRIMARY of table `t`.`accounts` trx id 3570 lock_mode X locks rec but not gap
Record lock, heap no 2 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
 0: len 4; hex 80000001; asc     ;;
 1: len 6; hex 000000000df2; asc       ;;


*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 43 page no 4 n bits 72 index PRIMARY of table `t`.`accounts` trx id 3570 lock_mode X locks rec but not gap waiting
Record lock, heap no 3 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
 0: len 4; hex 80000002; asc     ;;


*** (2) TRANSACTION:
TRANSACTION 3571, ACTIVE 2 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1128, 2 row lock(s), undo log entries 1
MySQL thread id 110, OS thread handle 140535559837248, query id 730 localhost root updating
UPDATE accounts SET balance = balance + 100 WHERE id = 1

*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 43 page no 4 n bits 72 index PRIMARY of table `t`.`accounts` trx id 3571 lock_mode X locks rec but not gap
Record lock, heap no 3 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
 0: len 4; hex 80000002; asc     ;;


*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 43 page no 5 n bits 72 index idx_user of table `t`.`entries` trx id 3571 lock_mode X insert intention waiting
Record lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0
 0: len 8; hex 73757072656d756d; asc supremum;;

*** WE ROLL BACK TRANSACTION (2)"""


class FakeSession:
    """WAIT 이름은 같은 이름의 SIGNAL이 올 때까지 막히고(LATER는 0.15초 뒤 SIGNAL), FAIL은 오류를 낸다.
    나머지는 SQL을 그대로 돌려준다."""

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
            return {"rows": [[f"waited {name}"]], "rowcount": 1}
        if word == "SIGNAL":
            self.driver.events[name].set()
            return {"rows": None, "rowcount": 0}
        if word == "LATER":
            threading.Timer(0.15, self.driver.events[name].set).start()
            return {"rows": None, "rowcount": 0}
        if word == "FAIL":
            raise RuntimeError(name)
        self.driver.executed.append(sql)
        return {"rows": [[sql]], "rowcount": 1}

    def close(self) -> None:
        self.driver.closed += 1


class FakeDriver:
    name = "fake"

    def __init__(self, *, detect: str = "ON", reports: tuple = (None, None), fail_connect: bool = False):
        self.events: defaultdict[str, threading.Event] = defaultdict(threading.Event)
        self.executed: list[str] = []
        self.setup: list[str] = []
        self.cancelled: set[int] = set()
        self.closed = 0
        self.detect = detect
        self.detect_history: list[str] = []
        self.reports = list(reports)
        self.fail_connect = fail_connect
        self.lock_rows: tuple[list, list] = ([], [])
        self.snapshots = 0
        self._next_id = 100

    def connect(self, isolation: str | None = None) -> FakeSession:
        if self.fail_connect:
            raise RuntimeError("연결 실패")
        self._next_id += 1
        return FakeSession(self, self._next_id)

    def observer(self) -> FakeSession:
        return FakeSession(self, 0)

    def reset(self, statements: tuple[str, ...]) -> None:
        self.setup.extend(statements)

    def cancel(self, server_id: int) -> None:
        self.cancelled.add(server_id)
        for event in self.events.values():
            event.set()

    def deadlock_detect(self, observer) -> str:
        return self.detect

    def set_deadlock_detect(self, observer, value: str) -> str:
        self.detect = value
        self.detect_history.append(value)
        return value

    def locks(self, observer) -> tuple[list, list]:
        self.snapshots += 1
        return self.lock_rows

    def latest_deadlock(self, observer):
        return self.reports.pop(0) if len(self.reports) > 1 else self.reports[0]


def timeline(*steps: Step, final: str = "") -> Timeline:
    return Timeline(name="fake", title="가짜", setup=("SETUP",), steps=steps, final=final)


class RunTimelineTest(unittest.TestCase):
    def test_records_values_and_final_rows(self):
        driver = FakeDriver()
        result = run_timeline(timeline(Step("A", "one"), Step("B", "two"), Step("A", "three"), final="FINAL"),
                              driver, "READ COMMITTED", **FAST)
        self.assertTrue(result["valid"])
        self.assertEqual(driver.setup, ["SETUP"])
        self.assertEqual([s["rows"] for s in result["steps"]], [[["one"]], [["two"]], [["three"]]])
        self.assertEqual([s["finished_after_step"] for s in result["steps"]], [1, 2, 3])
        self.assertEqual(result["final_rows"], [["FINAL"]])
        self.assertEqual(sorted(result["session_ids"]), ["A", "B"])
        # 세션마다 ROLLBACK으로 정리하고, 두 세션과 관찰용 연결을 닫는다.
        self.assertEqual(driver.executed.count("ROLLBACK"), 2)
        self.assertEqual(driver.closed, 3)

    def test_blocked_step_defers_the_same_session(self):
        driver = FakeDriver()
        result = run_timeline(timeline(Step("A", "WAIT go"), Step("A", "after"), Step("B", "SIGNAL go")),
                              driver, "REPEATABLE READ", **FAST)
        wait_step, after, signal = result["steps"]
        self.assertTrue(result["valid"])
        self.assertTrue(wait_step["blocked"])
        self.assertEqual(wait_step["finished_after_step"], 3)
        self.assertTrue(after["deferred"])
        self.assertEqual(after["sent_after_step"], 3)
        self.assertEqual(observation(after), '[["after"]] (미룸, 3단계 뒤 보냄)')
        self.assertFalse(signal["blocked"])

    def test_delay_counts_from_previous_send(self):
        driver = FakeDriver()
        result = run_timeline(timeline(Step("A", "one"), Step("B", "two", delay_s=0.3)), driver, "REPEATABLE READ",
                              **FAST)
        first, second = result["steps"]
        self.assertGreaterEqual(second["sent_at_s"] - first["sent_at_s"], 0.3)
        self.assertLess(second["sent_at_s"] - first["sent_at_s"], 0.6)

    def test_delay_still_collects_released_steps(self):
        # 다음 단계를 보내려고 기다리는 동안 풀린 단계는 그 단계를 보내기 전에 끝난 것으로 모은다.
        driver = FakeDriver()
        result = run_timeline(timeline(Step("A", "WAIT go"), Step("B", "LATER go"), Step("B", "later", delay_s=0.4)),
                              driver, "REPEATABLE READ", **FAST)
        self.assertTrue(result["steps"][0]["blocked"])
        self.assertEqual(result["steps"][0]["finished_after_step"], 2)

    def test_snapshot_names_sessions(self):
        driver = FakeDriver()
        # 세션 연결 번호는 정렬한 세션 이름 순서로 101(A), 102(B)가 된다.
        driver.lock_rows = (
            [[101, "l1", "entries", "idx_user", "RECORD", "X", "GRANTED", "7, 2"],
             [102, "l2", "entries", "idx_user", "RECORD", "X,GAP,INSERT_INTENTION", "WAITING", "12, 4"],
             [101, "l0", "entries", None, "TABLE", "IX", "GRANTED", None]],
            [[102, "l2", 101, "l1"]],
        )
        result = run_timeline(timeline(Step("A", "one"), Step("B", "two", snapshot=True)), driver,
                              "REPEATABLE READ", **FAST)
        self.assertEqual(driver.snapshots, 1)
        locks = result["steps"][1]["locks"]
        self.assertEqual([(lock["session"], lock["type"]) for lock in locks["locks"]],
                         [("A", "TABLE"), ("A", "RECORD"), ("B", "RECORD")])
        self.assertEqual(locks["waits"], [{"waiting": "B", "waiting_lock": "idx_user X,GAP,INSERT_INTENTION 12, 4",
                                           "blocking": "A", "blocking_lock": "idx_user X 7, 2"}])
        self.assertNotIn("locks", result["steps"][0])

    def test_detect_is_applied_and_restored(self):
        driver = FakeDriver(detect="ON")
        result = run_timeline(timeline(Step("A", "one")), driver, "REPEATABLE READ", "OFF", **FAST)
        self.assertEqual(driver.detect_history, ["OFF", "ON"])
        self.assertEqual(result["deadlock_detect_applied"], "OFF")
        self.assertEqual(result["deadlock_detect_restored"], "ON")
        self.assertTrue(result["valid"])

    def test_detect_is_restored_when_the_run_fails(self):
        driver = FakeDriver(detect="ON", fail_connect=True)
        with self.assertRaises(RuntimeError):
            run_timeline(timeline(Step("A", "one")), driver, "REPEATABLE READ", "OFF", **FAST)
        self.assertEqual(driver.detect, "ON")

    def test_only_a_new_deadlock_report_is_kept(self):
        same = run_timeline(timeline(Step("A", "one")), FakeDriver(reports=("old", "old")), "REPEATABLE READ",
                            **FAST)
        self.assertIsNone(same["deadlock"])
        new = run_timeline(timeline(Step("A", "one")), FakeDriver(reports=("old", DEADLOCK)), "REPEATABLE READ",
                           **FAST)
        self.assertEqual(new["deadlock"]["rolled_back"], "2")
        self.assertEqual(new["deadlock"]["report"], DEADLOCK)

    def test_failed_step_is_recorded(self):
        result = run_timeline(timeline(Step("A", "FAIL boom"), Step("A", "next")), FakeDriver(), "REPEATABLE READ",
                              **FAST)
        self.assertEqual(result["steps"][0]["outcome"], "error")
        self.assertEqual(result["steps"][1]["outcome"], "ok")
        self.assertTrue(result["valid"])

    def test_stuck_step_is_cancelled(self):
        result = run_timeline(timeline(Step("A", "WAIT never")), FakeDriver(), "REPEATABLE READ",
                              wait_s=0.05, settle_s=0.05, stuck_s=0.2)
        self.assertFalse(result["valid"])
        self.assertEqual(result["steps"][0]["outcome"], "stuck")
        self.assertEqual(result["stuck_sessions"], ["A"])


class ReportTest(unittest.TestCase):
    def test_section_is_cut_from_status(self):
        status = ("=====\nINNODB MONITOR OUTPUT\n------------------------\nLATEST DETECTED DEADLOCK\n"
                  "------------------------\n" + DEADLOCK + "\n------------\nTRANSACTIONS\n------------\nTrx id counter")
        self.assertEqual(deadlock_section(status), DEADLOCK)
        self.assertIsNone(deadlock_section("no deadlock yet\n------------\nTRANSACTIONS\n"))

    def test_parse_maps_threads_to_sessions(self):
        parsed = parse_deadlock(DEADLOCK, {109: "A", 110: "B"})
        self.assertEqual(parsed["detected_at"], "2026-11-03 12:19:55 140535012517440")
        self.assertEqual(parsed["rolled_back"], "2")
        self.assertEqual(parsed["rolled_back_session"], "B")
        first, second = parsed["transactions"]["1"], parsed["transactions"]["2"]
        self.assertEqual((first["session"], first["thread_id"]), ("A", 109))
        self.assertEqual(first["query"], "UPDATE accounts SET balance = balance + 100 WHERE id = 2")
        self.assertEqual(first["holds"], [{"index": "PRIMARY", "table": "`t`.`accounts`",
                                           "mode": "lock_mode X locks rec but not gap", "records": [1]}])
        self.assertEqual(first["waiting"][0]["records"], [2])
        self.assertEqual(second["holds"][0]["records"], [2])
        self.assertEqual(second["waiting"][0]["mode"], "lock_mode X insert intention waiting")
        self.assertEqual(second["waiting"][0]["records"], ["supremum"])

    def test_describe_skips_waits_outside_the_schema(self):
        described = describe_locks([[5, "l1", "t", "PRIMARY", "RECORD", "X", "GRANTED", "1"]],
                                   [[6, "other", 5, "l1"]], {5: "A"})
        self.assertEqual(described["waits"], [])
        self.assertEqual(described["locks"][0]["session"], "A")


class TimelineTableTest(unittest.TestCase):
    def test_timelines_have_two_sessions_a_snapshot_and_a_final_read(self):
        for name, item in TIMELINES.items():
            with self.subTest(name):
                self.assertEqual({step.session for step in item.steps}, {"A", "B"})
                self.assertTrue(any(step.snapshot for step in item.steps))
                self.assertTrue(item.final.startswith("SELECT"))
                self.assertTrue(set(item.detects) <= {"ON", "OFF"})

    def test_problem_cases_are_all_present(self):
        self.assertEqual(len([n for n in TIMELINES if n.startswith("idx-")]), 5)
        self.assertEqual(len([n for n in TIMELINES if n.startswith("noidx-")]), 3)
        self.assertEqual(TIMELINES["transfer-reverse"].steps[5].delay_s, 2.0)
        self.assertEqual(TIMELINES["serializable-insert"].isolations, ("SERIALIZABLE",))
        pair = TIMELINES["reward-count-lock-pair"]
        self.assertEqual(pair.isolations, ("REPEATABLE READ",))
        self.assertEqual([step.sql for step in pair.steps if step.sql.startswith("SELECT")],
                         ["SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 FOR UPDATE"] * 2)


if __name__ == "__main__":
    unittest.main()
