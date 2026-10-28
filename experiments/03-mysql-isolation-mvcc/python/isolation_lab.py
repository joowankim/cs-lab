# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3", "psycopg[binary]==3.3.6"]
# ///
"""두 세션에 SQL 순서표를 차례로 흘려 넣고, 단계마다 돌려받은 값과 기다림을 기록한다."""

import argparse
from collections import deque
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from datetime import datetime
import json
from pathlib import Path
import platform
import sys
from time import perf_counter
from zoneinfo import ZoneInfo

from isolation_timelines import TIMELINES, Timeline

EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EXPERIMENT_DIR.parent.parent
sys.path.insert(0, str(REPO_DIR / "tools"))
from lab_env import collect_environment, command_info  # noqa: E402

WAIT_S = 0.5  # 이 시간 안에 끝나지 않은 단계를 '기다림'으로 기록한다.
SETTLE_S = 0.3  # 단계 하나를 넣은 뒤, 기다리던 단계가 그 단계로 풀렸는지 이만큼 더 보고 모은다.
LOCK_TIMEOUT_S = 5  # 락을 기다리다 포기하는 시간. 두 DB에 같은 값을 건다.
STUCK_S = 15  # 락 대기 시간을 넘겨도 끝나지 않으면 실행 오류로 본다.


class MySQLSession:
    def __init__(self, connection):
        self.connection = connection
        self.server_id = self.execute("SELECT CONNECTION_ID()")["rows"][0][0]

    def execute(self, sql: str) -> dict:
        with self.connection.cursor() as cursor:
            cursor.execute(sql)
            rows = [list(row) for row in cursor.fetchall()] if cursor.description else None
            return {"rows": rows, "rowcount": cursor.rowcount, "status": None, "notices": None}

    def close(self) -> None:
        self.connection.close()


class MySQL:
    name = "mysql"

    def __init__(self, address: str):
        self.host, port = address.rsplit(":", 1)
        self.port = int(port)

    def _connect(self):
        import pymysql

        return pymysql.connect(host=self.host, port=self.port, user="root", password="", database="lab",
                               autocommit=True, connect_timeout=5)

    def connect(self, isolation: str | None = None) -> MySQLSession:
        session = MySQLSession(self._connect())
        session.execute(f"SET SESSION innodb_lock_wait_timeout = {LOCK_TIMEOUT_S}")
        if isolation:
            session.execute(f"SET SESSION TRANSACTION ISOLATION LEVEL {isolation}")
        return session

    def reset(self, statements: tuple[str, ...]) -> None:
        session = MySQLSession(self._connect())
        try:
            for sql in statements:
                session.execute(sql)
        finally:
            session.close()

    def cancel(self, server_id: int) -> None:
        self.reset((f"KILL QUERY {int(server_id)}",))

    def server_info(self) -> dict:
        session = MySQLSession(self._connect())
        try:
            names = ("version", "transaction_isolation", "innodb_flush_log_at_trx_commit", "sync_binlog",
                     "log_bin", "innodb_lock_wait_timeout", "default_storage_engine", "autocommit")
            row = session.execute("SELECT " + ", ".join(f"@@global.{name}" for name in names))["rows"][0]
            return dict(zip(names, row))
        finally:
            session.close()


class PostgresSession:
    def __init__(self, connection):
        self.connection = connection
        self._notices: list[str] = []
        connection.add_notice_handler(lambda notice: self._notices.append(
            f"{notice.severity}: {notice.message_primary}"))
        self.server_id = self.execute("SELECT pg_backend_pid()")["rows"][0][0]

    def execute(self, sql: str) -> dict:
        self._notices.clear()
        cursor = self.connection.execute(sql)
        rows = [list(row) for row in cursor.fetchall()] if cursor.description else None
        # 명령 태그. 오류로 실패한 트랜잭션의 COMMIT은 ROLLBACK으로 돌아온다.
        return {"rows": rows, "rowcount": cursor.rowcount, "status": cursor.statusmessage,
                "notices": list(self._notices)}

    def close(self) -> None:
        self.connection.close()


class Postgres:
    name = "postgres"

    def __init__(self, address: str):
        self.host, port = address.rsplit(":", 1)
        self.port = int(port)

    def _connect(self):
        import psycopg

        return psycopg.connect(host=self.host, port=self.port, user="postgres", dbname="lab",
                               autocommit=True, connect_timeout=5)

    def connect(self, isolation: str | None = None) -> PostgresSession:
        session = PostgresSession(self._connect())
        session.execute(f"SET lock_timeout = '{LOCK_TIMEOUT_S}s'")
        if isolation:
            session.execute(f"SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL {isolation}")
        return session

    def reset(self, statements: tuple[str, ...]) -> None:
        session = PostgresSession(self._connect())
        try:
            for sql in statements:
                session.execute(sql)
        finally:
            session.close()

    def cancel(self, server_id: int) -> None:
        self.reset((f"SELECT pg_cancel_backend({int(server_id)})",))

    def server_info(self) -> dict:
        session = PostgresSession(self._connect())
        try:
            names = ("server_version", "default_transaction_isolation", "synchronous_commit", "fsync",
                     "lock_timeout", "wal_level")
            return {name: session.execute(f"SHOW {name}")["rows"][0][0] for name in names}
        finally:
            session.close()


def error_info(error: Exception) -> dict:
    # MySQL(PyMySQL)은 (오류 번호, 메시지)로, PostgreSQL(psycopg)은 SQLSTATE로 원인을 알려 준다.
    # MySQL의 SQLSTATE는 HY000처럼 여러 오류가 같이 쓰는 값이 많아 오류 번호를 먼저 쓴다.
    number = error.args[0] if error.args and isinstance(error.args[0], int) else None
    sqlstate = getattr(error, "sqlstate", None)
    return {"type": type(error).__name__, "code": number if number is not None else sqlstate,
            "sqlstate": sqlstate, "message": str(error).strip()}


def timed(session, sql: str) -> dict:
    started = perf_counter()
    try:
        result = session.execute(sql)
        return {"outcome": "ok", **result, "elapsed_s": perf_counter() - started, "error": None}
    except Exception as error:
        return {"outcome": "error", "rows": None, "rowcount": None, "status": None, "notices": None,
                "elapsed_s": perf_counter() - started, "error": error_info(error)}


def run_timeline(
    timeline: Timeline, driver, isolation: str, *,
    wait_s: float = WAIT_S, settle_s: float = SETTLE_S, stuck_s: float = STUCK_S,
) -> dict:
    driver.reset(timeline.setup_for(driver.name))
    names = sorted({step.session for step in timeline.steps})
    executors = {name: ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"session-{name}") for name in names}
    sessions = {}
    records: list[dict] = []
    # 아직 끝나지 않은 단계. 세션마다 하나뿐이다.
    pending: dict[str, tuple[dict, Future]] = {}
    # 앞 단계가 끝나지 않아 미뤄 둔 단계. 실제 요청처럼 그 세션은 앞 문장이 돌아와야 다음 문장을 보낸다.
    deferred: dict[str, deque[dict]] = {name: deque() for name in names}
    stuck: list[str] = []
    frozen: list[str] = []  # 취소한 뒤에도 돌아오지 않아 정리하지 못한 세션

    def finish(record: dict, future: Future, after: int) -> None:
        record.update(future.result(), finished_after_step=after)

    def send(record: dict, after: int) -> None:
        record.update(sent_after_step=after, sent_at_s=perf_counter() - started)
        future = executors[record["session"]].submit(timed, sessions[record["session"]], record["sql"])
        if wait([future], timeout=wait_s).done:
            finish(record, future, after)
        else:
            record["blocked"] = True
            pending[record["session"]] = (record, future)

    def advance(after: int) -> None:
        # 기다리던 단계가 끝났는지 모으고, 풀린 세션의 미뤄 둔 단계를 보낸다. 더 바뀌는 것이 없을 때까지 한다.
        changed = True
        while changed:
            changed = False
            if pending:
                wait([future for _, future in pending.values()], timeout=settle_s)
            for name, (record, future) in list(pending.items()):
                if future.done():
                    del pending[name]
                    finish(record, future, after)
                    changed = True
            for name in names:
                if name not in pending and deferred[name]:
                    send(deferred[name].popleft(), after)
                    changed = True

    def give_up(name: str) -> None:
        # 락 대기 시간을 넘겨도 끝나지 않은 단계는 서버에서 취소하고 실행 오류로 남긴다.
        record, future = pending.pop(name)
        driver.cancel(sessions[name].server_id)
        stuck.append(name)
        if not wait([future], timeout=stuck_s).done:
            frozen.append(name)
        record.update(outcome="stuck", finished_after_step=None)

    started = perf_counter()
    try:
        for name in names:
            sessions[name] = executors[name].submit(driver.connect, isolation).result(timeout=stuck_s)
        for index, step in enumerate(timeline.steps, start=1):
            record = {"step": index, "session": step.session, "sql": step.sql, "note": step.note,
                      "blocked": False, "deferred": False}
            records.append(record)
            if step.session in pending or deferred[step.session]:
                record["deferred"] = True
                deferred[step.session].append(record)
            else:
                send(record, index)
            advance(index)
        last = len(timeline.steps)
        while pending:
            if not wait([future for _, future in pending.values()], timeout=stuck_s,
                        return_when=FIRST_COMPLETED).done:
                for name in list(pending):
                    give_up(name)
                break
            advance(last)
        for name in names:
            for record in deferred[name]:
                record.update(outcome="not_sent", sent_after_step=None, sent_at_s=None, finished_after_step=None)
    finally:
        wall_s = perf_counter() - started
        for name, session in sessions.items():
            if name not in frozen:
                executors[name].submit(timed, session, "ROLLBACK").result(timeout=stuck_s)
                executors[name].submit(session.close).result(timeout=stuck_s)
        for name, executor in executors.items():
            executor.shutdown(wait=name not in frozen)
    finished = sum(record.get("outcome") in ("ok", "error") for record in records)
    return {
        "check": finished, "expected_check": len(timeline.steps),
        "valid": not stuck and finished == len(timeline.steps),
        "wall_s": wall_s, "stuck_sessions": stuck, "steps": records,
    }


def observation(record: dict) -> str:
    if record["outcome"] == "ok":
        value = json.dumps(record["rows"], ensure_ascii=False, default=str) if record["rows"] is not None \
            else f"rowcount={record['rowcount']}"
    elif record["outcome"] == "error":
        value = f"오류 {record['error']['code']}"
    elif record["outcome"] == "not_sent":
        return "보내지 않음"
    else:
        return "멈춤 (취소함)"
    if record["deferred"]:
        value += f" (미룸, {record['sent_after_step']}단계 뒤 보냄)"
    if record["blocked"]:
        value += f" (기다림, {record['finished_after_step']}단계 뒤 끝남)"
    return value


def print_summary(rows: list[dict]) -> None:
    cases = sorted({(r["timeline"], r["db"], r["isolation"]) for r in rows})
    for timeline, db, isolation in cases:
        samples = [r for r in rows if (r["timeline"], r["db"], r["isolation"]) == (timeline, db, isolation)
                   and r["run"] > 0]
        if not samples:
            continue
        print(f"\n{timeline} · {db} · {isolation} · {len(samples)}회", file=sys.stderr)
        for position, record in enumerate(samples[0]["steps"]):
            seen = sorted({observation(sample["steps"][position]) for sample in samples
                           if position < len(sample["steps"])})
            print(f"  {record['step']:>2} {record['session']} {record['sql']}: {' | '.join(seen)}", file=sys.stderr)


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("1 이상의 정수가 필요하다.")
    return number


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timelines", nargs="+", choices=TIMELINES, default=list(TIMELINES))
    parser.add_argument("--dbs", nargs="+", choices=("mysql", "postgres"), default=["mysql", "postgres"])
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--mysql", default="127.0.0.1:13306", help="MySQL 주소(호스트:포트)")
    parser.add_argument("--postgres", default="127.0.0.1:15432", help="PostgreSQL 주소(호스트:포트)")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="조건마다 워밍업 1회와 검증 2회만 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if args.smoke:
        args.trials = 2
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    return args


def main() -> int:
    args = parse_args()
    drivers = {"mysql": MySQL(args.mysql), "postgres": Postgres(args.postgres)}
    cases = [
        (TIMELINES[name], db, isolation)
        for name in args.timelines for db in TIMELINES[name].dbs if db in args.dbs
        for isolation in TIMELINES[name].isolations
    ]
    if not cases:
        print("고른 순서표와 DB에 맞는 조건이 없다.", file=sys.stderr)
        return 1
    used = sorted({db for _, db, _ in cases})
    try:
        servers = {db: drivers[db].server_info() for db in used}
    except Exception as error:
        print(f"DB에 붙지 못했다({error_info(error)['message']}). infra/compose.yaml로 띄웠는지 확인한다.",
              file=sys.stderr)
        return 1
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-isolation" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(
        started=started, purpose="isolation", validation=args.smoke,
        config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None},
        conditions={"wait_s": WAIT_S, "settle_s": SETTLE_S, "lock_timeout_s": LOCK_TIMEOUT_S, "stuck_s": STUCK_S},
        experiment_dir=EXPERIMENT_DIR,
        sources=[Path(__file__), Path(__file__).with_name("isolation_timelines.py"), REPO_DIR / "tools" / "lab_env.py"],
    )
    environment["databases"] = servers
    environment["docker_images"] = command_info(
        ["docker", "compose", "-f", str(REPO_DIR / "infra" / "compose.yaml"), "images"])
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2, default=str)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    rows = []
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.trials + 1):
            order = cases if run % 2 == 0 else list(reversed(cases))
            for position, (timeline, db, isolation) in enumerate(order):
                row = run_timeline(timeline, drivers[db], isolation)
                row.update(
                    lang="python", runtime=f"cpython-{version}", variant=f"db={db};isolation={isolation}",
                    model="two-sessions", workers=len({s.session for s in timeline.steps}),
                    task=timeline.name, size=len(timeline.steps),
                    params={"wait_s": WAIT_S, "settle_s": SETTLE_S, "lock_timeout_s": LOCK_TIMEOUT_S},
                    timeline=timeline.name, db=db, db_version=servers[db].get("version")
                    or servers[db].get("server_version"), isolation=isolation,
                    run_id=run_id, environment_file=env_path.name, run=run, order_index=position,
                    validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                stream.flush()
                rows.append(row)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({timeline.name}, {db}, {isolation}). steps를 확인한다.", file=sys.stderr)
                    return 1
    if args.smoke:
        print("작은 입력의 실행·저장 검증 완료. 가설 판단에 쓰지 않는다.", file=sys.stderr)
    print_summary(rows)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
