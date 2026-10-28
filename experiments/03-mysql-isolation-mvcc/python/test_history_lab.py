"""묶음 2 측정이 DB의 보고를 바르게 읽고, 정해진 순서로 열어 두고 고치고 읽는지 가짜 DB로 확인한다. DB 없이 돈다."""

import unittest

from history_lab import (
    HOLDS, READ_BALANCE, START_BALANCE, UPDATE_BALANCE, history_list_length, run_hold, vacuum_counts,
)

# 컨테이너의 MySQL 8.4.13과 PostgreSQL 18.6이 돌려준 보고에서 숫자만 바꿨다.
INNODB_STATUS = """------------
TRANSACTIONS
------------
Trx id counter 124256
Purge done for trx's n:o < 114254 undo n:o < 0 state: running but idle
History list length 10002
LIST OF TRANSACTIONS FOR EACH SESSION:
"""
VACUUM_NOTICES = [
    'INFO: vacuuming "lab.public.accounts"',
    'INFO: finished vacuuming "lab.public.accounts": index scans: 0\n'
    "pages: 0 removed, 45 remain, 45 scanned (100.00% of total), 0 eagerly scanned\n"
    "tuples: 0 removed, 10001 remain, 10000 are dead but not yet removable\n"
    "removable cutoff: 59548, which was 10001 XIDs old when operation ended\n"
    "new relfrozenxid: 59546, which is 1 XIDs ahead of previous value",
]
FAST = {"reads": 3, "chunks": 5, "close_poll_s": (0.0, 0.01), "settle_limit_s": 0.1}


class FakeSession:
    """연결 순서대로 번호를 받고, 실행한 SQL을 번호와 함께 남긴다. 잔액 하나를 흉내 낸다."""

    def __init__(self, driver, number: int):
        self.driver = driver
        self.number = number

    def execute(self, sql: str) -> dict:
        driver = self.driver
        driver.log.append((self.number, sql))
        rows, rowcount, notices = None, 0, []
        if sql == UPDATE_BALANCE:
            driver.balance += driver.step
            rowcount = 1
        elif sql == READ_BALANCE:
            rows = [[driver.balance]]
        elif sql == "SHOW ENGINE INNODB STATUS":
            rows = [["InnoDB", "", INNODB_STATUS]]
        elif sql.startswith("VACUUM"):
            notices = VACUUM_NOTICES
        elif sql.startswith("SELECT pg_relation_size"):
            rows = [[8192]]
        return {"rows": rows, "rowcount": rowcount, "status": None, "notices": notices}

    def close(self) -> None:
        self.driver.closed += 1


class FakeDriver:
    def __init__(self, name: str, step: int = 1):
        self.name = name
        self.step = step  # UPDATE 한 번에 늘어나는 잔액. 1이 아니면 마지막 값이 어긋난다.
        self.balance = START_BALANCE
        self.log: list[tuple[int, str]] = []
        self.setup: list[str] = []
        self.isolations: list[str | None] = []
        self.closed = 0

    def connect(self, isolation: str | None = None) -> FakeSession:
        self.isolations.append(isolation)
        return FakeSession(self, len(self.isolations))

    def reset(self, statements: tuple[str, ...]) -> None:
        self.setup.extend(statements)


OBSERVER, HOLDER, WRITER, READER = 1, 2, 3, 4


def positions(log, session: int, sql: str) -> list[int]:
    return [index for index, (number, text) in enumerate(log) if number == session and text == sql]


class ReportParseTest(unittest.TestCase):
    def test_reads_history_list_length(self):
        self.assertEqual(history_list_length(INNODB_STATUS), 10002)

    def test_reads_vacuum_counts(self):
        self.assertEqual(vacuum_counts(VACUUM_NOTICES), {
            "removed": 0, "remain": 10001, "dead_not_removable": 10000, "cutoff_age_xids": 10001})

    def test_missing_report_is_an_error(self):
        with self.assertRaises(ValueError):
            history_list_length("TRANSACTIONS\n")
        with self.assertRaises(ValueError):
            vacuum_counts(['INFO: vacuuming "lab.public.accounts"'])


class RunHoldTest(unittest.TestCase):
    def test_holder_keeps_its_transaction_open_while_the_writer_updates(self):
        driver = FakeDriver("mysql")
        result = run_hold(HOLDS["rr-read"], driver, 20, **FAST)
        log = driver.log
        self.assertTrue(result["valid"])
        self.assertEqual((result["check"], result["expected_check"]), (20, 20))
        self.assertEqual(driver.isolations, [None, "REPEATABLE READ", None, None])
        # A가 열고 읽은 뒤에 B가 고치고, A는 두 세션의 읽기가 끝난 뒤에야 COMMIT한다.
        updates = positions(log, WRITER, UPDATE_BALANCE)
        self.assertEqual(len(updates), 20)
        self.assertLess(positions(log, HOLDER, READ_BALANCE)[0], updates[0])
        commit = positions(log, HOLDER, "COMMIT")
        self.assertEqual(len(commit), 1)
        self.assertGreater(commit[0], positions(log, READER, READ_BALANCE)[-1])
        self.assertEqual(result["reads"]["fresh"]["values"], [START_BALANCE + 20])
        self.assertEqual(len(result["updates"]["chunk_ms_per_update"]), 5)
        self.assertEqual(result["after_updates"], {"history_list_length": 10002})
        self.assertEqual(list(result["after_close"]["history_list_length_at_s"]), ["0.0", "0.01"])
        self.assertEqual(driver.closed, 4)

    def test_baseline_opens_no_transaction(self):
        driver = FakeDriver("mysql")
        result = run_hold(HOLDS["none"], driver, 10, **FAST)
        self.assertTrue(result["valid"])
        self.assertEqual(result["hold_steps"], [])
        self.assertFalse(any(sql in ("START TRANSACTION", "COMMIT") for _, sql in driver.log))

    def test_postgres_vacuums_after_the_reads_and_again_after_commit(self):
        driver = FakeDriver("postgres")
        result = run_hold(HOLDS["rr-update"], driver, 10, **FAST)
        log = driver.log
        self.assertIn("ALTER TABLE accounts SET (autovacuum_enabled = false)", driver.setup)
        vacuums = positions(log, OBSERVER, "VACUUM (VERBOSE) accounts")
        self.assertEqual(len(vacuums), 2)
        self.assertGreater(vacuums[0], positions(log, READER, READ_BALANCE)[-1])
        self.assertLess(vacuums[0], positions(log, HOLDER, "COMMIT")[0])
        self.assertGreater(vacuums[1], positions(log, HOLDER, "COMMIT")[0])
        self.assertEqual(result["after_updates"]["vacuum"]["dead_not_removable"], 10000)
        self.assertEqual(result["after_close"]["relation_bytes"], 8192)

    def test_wrong_final_value_marks_the_run_invalid(self):
        result = run_hold(HOLDS["rc-read"], FakeDriver("mysql", step=2), 10, **FAST)
        self.assertFalse(result["valid"])

    def test_holds_open_a_transaction_except_the_baseline(self):
        for hold in HOLDS.values():
            if hold.name == "none":
                self.assertEqual((hold.isolation, hold.statements), (None, ()))
            else:
                self.assertEqual(hold.statements[0], "START TRANSACTION")
                self.assertIsNotNone(hold.isolation)


if __name__ == "__main__":
    unittest.main()
