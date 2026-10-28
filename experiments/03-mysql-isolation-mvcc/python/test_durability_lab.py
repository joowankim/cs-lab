"""묶음 4 측정이 설정을 걸고 되돌리는지, 지연과 dd 보고를 바르게 읽는지 가짜 DB로 확인한다. DB 없이 돈다."""

import re
import unittest

from durability_lab import (
    INSERT_EVENT, SETTINGS, dd_seconds, globals_restored, percentile, read_globals, run_setting,
)

# 컨테이너의 MySQL 8.4.13 볼륨에서 dd가 돌려준 보고
DD_OUTPUT = "500+0 records in\n500+0 records out\n8192000 bytes (8.2 MB, 7.8 MiB) copied, 0.285381 s, 28.7 MB/s\n"
SET_GLOBAL = re.compile(r"SET GLOBAL (\w+) = (\w+)")
SET_SESSION = re.compile(r"SET (\w+) = (\w+)")
SELECT_GLOBALS = re.compile(r"@@global\.(\w+)")


class FakeSession:
    def __init__(self, driver):
        self.driver = driver
        self.session_values: dict[str, str] = {}

    def execute(self, sql: str) -> dict:
        driver = self.driver
        driver.log.append(sql)
        rows = None
        if sql == INSERT_EVENT:
            driver.rows += 1
        elif sql == "SELECT COUNT(*) FROM events":
            rows = [[driver.rows]]
        elif sql.startswith("SELECT @@global."):
            rows = [[driver.globals[name] for name in SELECT_GLOBALS.findall(sql)]]
        elif sql.startswith("SHOW "):
            rows = [[self.session_values.get(sql.removeprefix("SHOW "), "on")]]
        elif match := SET_GLOBAL.fullmatch(sql):
            if driver.obeys:
                driver.globals[match.group(1)] = match.group(2)
        elif match := SET_SESSION.fullmatch(sql):
            self.session_values[match.group(1)] = match.group(2)
        elif sql.startswith("CREATE TABLE"):
            driver.rows = 0
        return {"rows": rows, "rowcount": 1, "status": None, "notices": []}

    def close(self) -> None:
        self.driver.closed += 1


class FakeDriver:
    def __init__(self, name: str, obeys: bool = True):
        self.name = name
        self.obeys = obeys  # False면 SET GLOBAL을 무시해 설정이 걸리지 않은 서버를 흉내 낸다.
        self.globals = {"innodb_flush_log_at_trx_commit": "1", "sync_binlog": "1"}
        self.rows = 0
        self.log: list[str] = []
        self.closed = 0

    def connect(self, isolation: str | None = None) -> FakeSession:
        return FakeSession(self)

    def reset(self, statements: tuple[str, ...]) -> None:
        session = self.connect()
        for sql in statements:
            session.execute(sql)
        session.close()


class ParseTest(unittest.TestCase):
    def test_percentile_returns_a_measured_value_by_nearest_rank(self):
        samples = [float(value) for value in range(1, 11)]
        self.assertEqual([percentile(samples, f) for f in (0.5, 0.9, 0.99)], [5.0, 9.0, 10.0])

    def test_reads_dd_seconds(self):
        self.assertEqual(dd_seconds(DD_OUTPUT), 0.285381)
        with self.assertRaises(ValueError):
            dd_seconds("dd: failed to open")


class RunSettingTest(unittest.TestCase):
    def test_mysql_setting_is_set_globally_and_checked(self):
        driver = FakeDriver("mysql")
        result = run_setting(SETTINGS["flush2-binlog0"], driver, 30, warmup=5)
        self.assertTrue(result["valid"])
        self.assertEqual(result["applied"], {"innodb_flush_log_at_trx_commit": "2", "sync_binlog": "0"})
        self.assertEqual((result["check"], result["expected_check"]), (30, 30))
        self.assertIn("SET GLOBAL innodb_flush_log_at_trx_commit = 2", driver.log)
        self.assertEqual(driver.log.count(INSERT_EVENT), 35)

    def test_postgres_setting_is_set_on_the_measuring_connection(self):
        driver = FakeDriver("postgres")
        result = run_setting(SETTINGS["sync-off"], driver, 10, warmup=2)
        self.assertTrue(result["valid"])
        self.assertEqual(result["applied"], {"synchronous_commit": "off"})
        self.assertFalse(any(sql.startswith("SET GLOBAL") for sql in driver.log))

    def test_setting_that_did_not_apply_marks_the_run_invalid(self):
        result = run_setting(SETTINGS["flush2-binlog1"], FakeDriver("mysql", obeys=False), 10, warmup=2)
        self.assertFalse(result["valid"])

    def test_globals_are_restored_even_when_a_run_fails(self):
        driver = FakeDriver("mysql")
        with self.assertRaises(RuntimeError):
            with globals_restored(driver):
                run_setting(SETTINGS["flush2-binlog0"], driver, 5, warmup=0)
                raise RuntimeError("중간 실패")
        self.assertEqual(read_globals(driver), {"innodb_flush_log_at_trx_commit": "1", "sync_binlog": "1"})


if __name__ == "__main__":
    unittest.main()
