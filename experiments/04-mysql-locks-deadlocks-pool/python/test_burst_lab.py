"""동시 요청 실행 틀이 요청 SQL·다시 시도·오류 처리·검사를 정한 대로 하는지 가짜 DB로 확인한다. DB 없이 돈다."""

from functools import partial
import threading
import unittest

from burst_lab import (BUMP, COUNT, INSERT, LOCK_POINTS, PAY, PAY_IF_ZERO, SCENES, VERSION_UP, Scene, deduct, reward,
                       run_burst, serve, summarize)


class FakeDBError(Exception):
    """PyMySQL 오류처럼 args가 (오류 번호, 메시지)다."""


class FakeCursor:
    """실행한 SQL을 남기고, 정해 둔 SQL에는 정해 둔 값이나 오류를 돌려준다."""

    def __init__(self, *, count: int = 0, balance: int = 1000, version: int = 0, bump_rows: int = 1,
                 pay_rows: int = 1, fail: dict[str, int] | None = None):
        self.executed: list[tuple[str, tuple | None]] = []
        self.count, self.balance, self.version, self.bump_rows = count, balance, version, bump_rows
        self.pay_rows = pay_rows
        self.fail = fail or {}
        self._row = None

    def execute(self, sql: str, args: tuple | None = None) -> int:
        self.executed.append((sql, args))
        if sql in self.fail:
            raise FakeDBError(self.fail[sql], f"fake {self.fail[sql]}")
        if sql.startswith(COUNT):
            self._row = (self.count,)
        elif sql.startswith("SELECT balance"):
            self._row = (self.balance,)
        elif sql.startswith("SELECT version"):
            self._row = (self.version,)
        if sql == BUMP:
            return self.bump_rows
        if sql == PAY_IF_ZERO:
            return self.pay_rows
        return 1

    def fetchone(self):
        return self._row

    def fetchall(self):
        return [self._row]

    def sqls(self) -> list[str]:
        return [sql for sql, _ in self.executed]


def scene(request, retries: int = 0) -> Scene:
    return Scene("fake", "가짜", "가짜", ("SETUP",), request, ("FINAL",), retries=retries, rewards=False)


class RequestTest(unittest.TestCase):
    def test_deduct_writes_the_value_it_read_minus_100(self):
        cursor = FakeCursor(balance=700)
        self.assertEqual(deduct(cursor, 0), ("done", None))
        self.assertEqual(cursor.executed[2], ("UPDATE points SET balance = %s WHERE user_id = 7", (600,)))
        self.assertEqual(cursor.sqls()[-1], "COMMIT")

    def test_plain_reward_inserts_then_pays(self):
        cursor = FakeCursor()
        self.assertEqual(reward(cursor, 0), ("granted", None))
        self.assertEqual(cursor.sqls(), ["START TRANSACTION", COUNT, INSERT, PAY, "COMMIT"])

    def test_already_received_rolls_back_before_insert(self):
        cursor = FakeCursor(count=1)
        self.assertEqual(reward(cursor, 0), ("already", None))
        self.assertEqual(cursor.sqls(), ["START TRANSACTION", COUNT, "ROLLBACK"])

    def test_lock_variants_add_their_statement(self):
        count_lock = FakeCursor()
        reward(count_lock, 0, count_lock=True)
        self.assertEqual(count_lock.sqls()[1], COUNT + " FOR UPDATE")
        parent = FakeCursor()
        reward(parent, 0, parent_lock=True)
        self.assertEqual(parent.sqls()[1], "SELECT balance FROM points WHERE user_id = 7 FOR UPDATE")
        self.assertEqual(parent.sqls()[2], COUNT)

    def test_version_checks_the_value_read_first(self):
        cursor = FakeCursor(version=3)
        self.assertEqual(reward(cursor, 0, version=True), ("granted", None))
        self.assertIn((BUMP, (3,)), cursor.executed)
        self.assertLess(cursor.sqls().index(BUMP), cursor.sqls().index(PAY))
        conflict = FakeCursor(version=3, bump_rows=0)
        self.assertEqual(reward(conflict, 0, version=True), ("conflict", None))
        self.assertEqual(conflict.sqls()[-1], "ROLLBACK")
        self.assertNotIn(PAY, conflict.sqls())

    def test_lock_after_count_is_the_third_statement(self):
        cursor = FakeCursor()
        self.assertEqual(reward(cursor, 0, lock_after_count=True), ("granted", None))
        self.assertEqual(cursor.sqls(), ["START TRANSACTION", COUNT, LOCK_POINTS, INSERT, PAY, "COMMIT"])
        already = FakeCursor(count=1)
        self.assertEqual(reward(already, 0, lock_after_count=True), ("already", None))
        self.assertEqual(already.sqls(), ["START TRANSACTION", COUNT, LOCK_POINTS, "ROLLBACK"])

    def test_first_optimistic_draft_commits_without_checking(self):
        cursor = FakeCursor()
        self.assertEqual(reward(cursor, 0, zero_version="first"), ("granted", None))
        self.assertEqual(cursor.sqls(), ["START TRANSACTION", COUNT, INSERT, PAY_IF_ZERO, "COMMIT"])
        unpaid = FakeCursor(pay_rows=0)
        self.assertEqual(reward(unpaid, 0, zero_version="first"), ("unpaid", None))
        self.assertEqual(unpaid.sqls()[-1], "COMMIT")

    def test_fixed_optimistic_draft_rolls_back_on_zero_rows(self):
        cursor = FakeCursor()
        self.assertEqual(reward(cursor, 0, zero_version="fixed"), ("granted", None))
        self.assertEqual(cursor.sqls(), ["START TRANSACTION", COUNT, INSERT, PAY_IF_ZERO, VERSION_UP, "COMMIT"])
        lost = FakeCursor(pay_rows=0)
        self.assertEqual(reward(lost, 0, zero_version="fixed"), ("conflict", None))
        self.assertEqual(lost.sqls()[-1], "ROLLBACK")
        self.assertNotIn(VERSION_UP, lost.sqls())

    def test_unique_turns_duplicate_key_into_already(self):
        cursor = FakeCursor(fail={INSERT: 1062})
        outcome, handled = reward(cursor, 0, unique=True)
        self.assertEqual(outcome, "already")
        self.assertEqual(handled["code"], 1062)
        self.assertEqual(cursor.sqls()[-1], "ROLLBACK")
        # 유니크 제약이 없는 판은 1062를 처리하지 않고 그대로 올린다.
        with self.assertRaises(FakeDBError):
            reward(FakeCursor(fail={INSERT: 1062}), 0)


class ServeTest(unittest.TestCase):
    def test_conflict_is_retried_at_most_three_times(self):
        calls = []
        result = serve(scene(lambda cursor, pause_s: calls.append(1) or ("conflict", None), retries=3),
                       FakeCursor(), 0)
        self.assertEqual(len(calls), 4)
        self.assertEqual(result["result"], "gave-up")
        self.assertEqual(result["retries"], 3)

    def test_retry_stops_when_the_request_settles(self):
        outcomes = iter(["conflict", "already"])
        result = serve(scene(lambda cursor, pause_s: (next(outcomes), None), retries=3), FakeCursor(), 0)
        self.assertEqual((result["result"], result["retries"]), ("already", 1))

    def test_db_error_rolls_back_and_is_not_retried(self):
        cursor = FakeCursor(fail={"UPDATE points SET balance = %s WHERE user_id = 7": 1213})
        result = serve(scene(deduct, retries=3), cursor, 0)
        self.assertEqual(result["result"], "error")
        self.assertEqual(result["attempts"][0]["error"]["code"], 1213)
        self.assertEqual(result["retries"], 0)
        self.assertEqual(cursor.sqls()[-1], "ROLLBACK")

    def test_harness_bug_is_not_hidden_as_db_error(self):
        def broken(cursor, pause_s):
            raise ValueError("실행 틀 오류")

        with self.assertRaises(ValueError):
            serve(scene(broken), FakeCursor(), 0)


class SummaryTest(unittest.TestCase):
    def done(self, result: str, error: int | None = None) -> dict:
        attempt = {"outcome": result, "error": {"code": error} if error else None, "elapsed_s": 0.05}
        return {"request": 0, "started_at": 1.0, "result": result, "attempts": [attempt], "retries": 0,
                "elapsed_s": 0.05}

    def test_reward_counts_must_match_the_table(self):
        reward_scene = SCENES["reward-unique"]
        rows = [self.done("granted")] + [self.done("already", 1062) for _ in range(2)]
        good = summarize(reward_scene, rows, [[[1]], [[1000, 0]]], requests=3, failures=[], hung=[])
        self.assertTrue(good["valid"])
        self.assertEqual(good["summary"]["errors"], {"1062": 2})
        self.assertEqual(good["summary"]["results"], {"already": 2, "granted": 1})
        rows = [self.done("granted")] + [self.done("already", 1062) for _ in range(2)]
        bad = summarize(reward_scene, rows, [[[2]], [[1000, 0]]], requests=3, failures=[], hung=[])
        self.assertFalse(bad["valid"])

    def test_unpaid_rows_count_as_rewards_without_balance(self):
        reward_scene = SCENES["reward-version-first"]
        rows = [self.done("granted"), self.done("unpaid")]
        good = summarize(reward_scene, rows, [[[2]], [[1000, 0]]], requests=2, failures=[], hung=[])
        self.assertTrue(good["valid"])
        rows = [self.done("granted"), self.done("unpaid")]  # summarize가 started_at을 바꾸므로 새로 만든다.
        bad = summarize(reward_scene, rows, [[[2]], [[2000, 0]]], requests=2, failures=[], hung=[])
        self.assertFalse(bad["valid"])

    def test_missing_requests_make_the_run_invalid(self):
        result = summarize(SCENES["deduct"], [self.done("done")], [[[900]]], requests=2, failures=[], hung=[])
        self.assertFalse(result["valid"])
        self.assertEqual(result["summary"]["balance"], 900)


class FakeConnection:
    def __init__(self, driver):
        self.driver = driver

    def cursor(self):
        return FakeCursor()

    def close(self):
        with self.driver.lock:
            self.driver.closed += 1


class FakeDriver:
    def __init__(self):
        self.lock = threading.Lock()
        self.closed = 0
        self.ran: list[tuple] = []

    def connect(self, isolation=None):
        return FakeConnection(self)

    def run(self, statements):
        self.ran.append(statements)
        return [[[1000]] for _ in statements]


class RunBurstTest(unittest.TestCase):
    def test_requests_start_together_and_connections_close(self):
        driver = FakeDriver()
        result = run_burst(scene(partial(lambda cursor, pause_s: ("done", None))), driver, "READ COMMITTED",
                           requests=5, pause_s=0)
        self.assertTrue(result["valid"])
        self.assertEqual(result["check"], 5)
        self.assertEqual(driver.closed, 5)
        self.assertEqual(driver.ran, [("SETUP",), ("FINAL",)])
        self.assertLess(result["summary"]["start_spread_s"], 0.05)


class SceneTableTest(unittest.TestCase):
    def test_reward_scenes_are_the_planned_ten(self):
        self.assertEqual(sorted(name for name in SCENES if name.startswith("reward-")), sorted([
            "reward-plain", "reward-count-lock", "reward-parent-lock", "reward-version", "reward-unique",
            "reward-count-lock-unique", "reward-version-first", "reward-version-const", "reward-version-const-v3",
            "reward-lock-after-count"]))
        self.assertEqual(SCENES["reward-version"].retries, 3)
        self.assertEqual(SCENES["reward-version-const"].retries, 0)
        self.assertIn("VALUES (7, 0, 3)", SCENES["reward-version-const-v3"].setup[3])
        self.assertIn("VALUES (7, 0, 0)", SCENES["reward-version-const"].setup[3])
        self.assertEqual(SCENES["deduct"].isolations, ("READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"))
        self.assertIn("UNIQUE KEY", SCENES["reward-unique"].setup[-1])
        self.assertNotIn("UNIQUE KEY", SCENES["reward-count-lock"].setup[-1])


if __name__ == "__main__":
    unittest.main()
