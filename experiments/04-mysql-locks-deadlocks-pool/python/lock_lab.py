# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3"]
# ///
"""두 세션에 SQL 순서표를 차례로 흘려 넣고, 단계마다 돌려받은 값·기다림·오류와 그때 걸린 락을 기록한다.

실행 규칙(0.5초 기다림 판정, 0.3초 모으기, 미룸, 락 대기 5초, 15초 뒤 취소)은 03 실험 isolation_lab.py와 같고
MySQL에서만 돌린다. 더한 것은 앞 단계를 보낸 때부터 기다렸다 보내기, 단계 직후 락 읽기, 데드락 탐지 설정과
마지막 데드락 보고 읽기, 끝난 뒤 표 읽기다.
"""

import argparse
from collections import deque
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from datetime import datetime
import json
from pathlib import Path
import platform
import re
import sys
from time import perf_counter, sleep
from zoneinfo import ZoneInfo

from lock_timelines import TIMELINES, Timeline

EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EXPERIMENT_DIR.parent.parent
sys.path.insert(0, str(REPO_DIR / "tools"))
from lab_env import collect_environment, command_info  # noqa: E402

WAIT_S = 0.5  # 이 시간 안에 끝나지 않은 단계를 '기다림'으로 기록한다.
SETTLE_S = 0.3  # 단계 하나를 넣은 뒤, 기다리던 단계가 그 단계로 풀렸는지 이만큼 더 보고 모은다.
LOCK_TIMEOUT_S = 5  # 락을 기다리다 포기하는 시간(innodb_lock_wait_timeout)
STUCK_S = 15  # 락 대기 시간을 넘겨도 끝나지 않으면 실행 오류로 본다.
SCHEMA = "lab"

LOCKS_SQL = f"""
SELECT t.PROCESSLIST_ID, l.ENGINE_LOCK_ID, l.OBJECT_NAME, l.INDEX_NAME, l.LOCK_TYPE, l.LOCK_MODE,
       l.LOCK_STATUS, l.LOCK_DATA
FROM performance_schema.data_locks AS l
JOIN performance_schema.threads AS t ON t.THREAD_ID = l.THREAD_ID
WHERE l.OBJECT_SCHEMA = '{SCHEMA}'
"""
WAITS_SQL = """
SELECT r.PROCESSLIST_ID, w.REQUESTING_ENGINE_LOCK_ID, b.PROCESSLIST_ID, w.BLOCKING_ENGINE_LOCK_ID
FROM performance_schema.data_lock_waits AS w
JOIN performance_schema.threads AS r ON r.THREAD_ID = w.REQUESTING_THREAD_ID
JOIN performance_schema.threads AS b ON b.THREAD_ID = w.BLOCKING_THREAD_ID
"""


class MySQLSession:
    def __init__(self, connection):
        self.connection = connection
        self.server_id = self.execute("SELECT CONNECTION_ID()")["rows"][0][0]

    def execute(self, sql: str) -> dict:
        with self.connection.cursor() as cursor:
            cursor.execute(sql)
            rows = [list(row) for row in cursor.fetchall()] if cursor.description else None
            return {"rows": rows, "rowcount": cursor.rowcount}

    def close(self) -> None:
        self.connection.close()


class MySQL:
    name = "mysql"

    def __init__(self, address: str):
        self.host, port = address.rsplit(":", 1)
        self.port = int(port)

    def _connect(self):
        import pymysql

        return pymysql.connect(host=self.host, port=self.port, user="root", password="", database=SCHEMA,
                               autocommit=True, connect_timeout=5)

    def connect(self, isolation: str | None = None) -> MySQLSession:
        session = MySQLSession(self._connect())
        session.execute(f"SET SESSION innodb_lock_wait_timeout = {LOCK_TIMEOUT_S}")
        if isolation:
            session.execute(f"SET SESSION TRANSACTION ISOLATION LEVEL {isolation}")
        return session

    def observer(self) -> MySQLSession:
        return MySQLSession(self._connect())

    def reset(self, statements: tuple[str, ...]) -> None:
        session = self.observer()
        try:
            for sql in statements:
                session.execute(sql)
        finally:
            session.close()

    def cancel(self, server_id: int) -> None:
        self.reset((f"KILL QUERY {int(server_id)}",))

    def deadlock_detect(self, observer) -> str:
        return on_off(observer.execute("SELECT @@global.innodb_deadlock_detect")["rows"][0][0])

    def set_deadlock_detect(self, observer, value: str) -> str:
        observer.execute(f"SET GLOBAL innodb_deadlock_detect = {'ON' if on_off(value) == 'ON' else 'OFF'}")
        return self.deadlock_detect(observer)

    def locks(self, observer) -> tuple[list, list]:
        return observer.execute(LOCKS_SQL)["rows"], observer.execute(WAITS_SQL)["rows"]

    def latest_deadlock(self, observer) -> str | None:
        status = observer.execute("SHOW ENGINE INNODB STATUS")["rows"][0][2]
        return deadlock_section(status)

    def server_info(self) -> dict:
        session = self.observer()
        try:
            names = ("version", "transaction_isolation", "innodb_lock_wait_timeout", "innodb_deadlock_detect",
                     "innodb_rollback_on_timeout", "innodb_print_all_deadlocks", "autocommit",
                     "default_storage_engine")
            row = session.execute("SELECT " + ", ".join(f"@@global.{name}" for name in names))["rows"][0]
            return dict(zip(names, row))
        finally:
            session.close()


def on_off(value) -> str:
    return "ON" if str(value).upper() in ("1", "ON", "TRUE") else "OFF"


def error_info(error: Exception) -> dict:
    # PyMySQL은 (오류 번호, 메시지)로 원인을 알려 준다. 1205는 락 대기 초과, 1213은 데드락으로 되돌림이다.
    number = error.args[0] if error.args and isinstance(error.args[0], int) else None
    return {"type": type(error).__name__, "code": number, "message": str(error).strip()}


def timed(session, sql: str) -> dict:
    started = perf_counter()
    try:
        result = session.execute(sql)
        return {"outcome": "ok", **result, "elapsed_s": perf_counter() - started, "error": None}
    except Exception as error:
        return {"outcome": "error", "rows": None, "rowcount": None, "elapsed_s": perf_counter() - started,
                "error": error_info(error)}


def data_key(lock_data):
    # 'supremum pseudo-record'는 인덱스에서 가장 큰 값 뒤의 자리라 맨 뒤에 둔다.
    if lock_data is None:
        return (0, ())
    if "supremum" in str(lock_data):
        return (2, ())
    parts = []
    for part in str(lock_data).split(","):
        part = part.strip()
        parts.append((0, int(part), "") if part.lstrip("-").isdigit() else (1, 0, part))
    return (1, tuple(parts))


def describe_locks(locks: list, waits: list, names: dict[int, str]) -> dict:
    """performance_schema의 행을 세션 이름이 붙은 락 목록과 기다림 목록으로 바꾼다."""
    by_id = {}
    described = []
    for processlist_id, lock_id, table, index, lock_type, mode, status, data in locks:
        lock = {"session": names.get(processlist_id, f"thread-{processlist_id}"), "table": table, "index": index,
                "type": lock_type, "mode": mode, "status": status, "data": data}
        by_id[lock_id] = lock
        described.append(lock)
    described.sort(key=lambda lock: (lock["session"], lock["type"] != "TABLE", lock["index"] or "",
                                     data_key(lock["data"]), lock["status"]))
    waiting = []
    for waiting_id, waiting_lock, blocking_id, blocking_lock in waits:
        if waiting_lock not in by_id:
            continue
        waiting.append({
            "waiting": names.get(waiting_id, f"thread-{waiting_id}"), "waiting_lock": lock_label(by_id[waiting_lock]),
            "blocking": names.get(blocking_id, f"thread-{blocking_id}"),
            "blocking_lock": lock_label(by_id.get(blocking_lock)),
        })
    return {"locks": described, "waits": waiting}


def lock_label(lock: dict | None) -> str | None:
    if lock is None:
        return None
    if lock["type"] == "TABLE":
        return f"{lock['table']} {lock['mode']} (표)"
    return f"{lock['index']} {lock['mode']} {lock['data']}"


def deadlock_section(status: str) -> str | None:
    match = re.search(r"LATEST DETECTED DEADLOCK\n-+\n(.*?)\n-+\nTRANSACTIONS\n", status, re.S)
    return match.group(1).strip() if match else None


LOCK_HEADER = re.compile(r"index (\S+) of table (\S+) trx id \d+ (lock_mode .+|lock mode .+)$")
FIELD_ZERO = re.compile(r"^\s*0: len (\d+); hex ([0-9a-f]+); asc (.*?);;")


def parse_deadlock(section: str, names: dict[int, str]) -> dict:
    """LATEST DETECTED DEADLOCK 부분에서 트랜잭션마다 세션·문장·보유한 락·기다린 락과 되돌린 쪽을 뽑는다."""
    transactions: dict[str, dict] = {}
    current = None
    part = None
    lines = section.splitlines()
    for position, line in enumerate(lines):
        header = re.match(r"\*\*\* \((\d+)\) (TRANSACTION|HOLDS THE LOCK\(S\)|WAITING FOR THIS LOCK TO BE GRANTED):",
                          line)
        if header:
            current = transactions.setdefault(header.group(1), {"session": None, "thread_id": None, "query": None,
                                                                 "holds": [], "waiting": []})
            part = {"TRANSACTION": None, "HOLDS THE LOCK(S)": "holds"}.get(header.group(2), "waiting")
            continue
        if current is None:
            continue
        thread = re.match(r"MySQL thread id (\d+),", line)
        if thread:
            current["thread_id"] = int(thread.group(1))
            current["session"] = names.get(current["thread_id"])
            if position + 1 < len(lines):
                current["query"] = lines[position + 1].strip()
            continue
        lock = LOCK_HEADER.search(line)
        if lock and part:
            current[part].append({"index": lock.group(1), "table": lock.group(2), "mode": lock.group(3),
                                  "records": []})
            continue
        field = FIELD_ZERO.match(line)
        if field and part and current[part]:
            length, value, text = int(field.group(1)), field.group(2), field.group(3)
            # INT 칸은 부호 비트를 뒤집어 저장한다(80000001이 1). supremum pseudo-record는 0번 칸이 글자다.
            if "supremum" in text:
                decoded = "supremum"
            else:
                decoded = int(value, 16) ^ 0x80000000 if length == 4 else value
            current[part][-1]["records"].append(decoded)
    victim = re.search(r"\*\*\* WE ROLL BACK TRANSACTION \((\d+)\)", section)
    rolled_back = victim.group(1) if victim else None
    return {
        "detected_at": lines[0].strip() if lines else None,
        "rolled_back": rolled_back,
        "rolled_back_session": transactions.get(rolled_back, {}).get("session") if rolled_back else None,
        "transactions": transactions,
    }


def run_timeline(
    timeline: Timeline, driver, isolation: str, detect: str = "ON", *,
    wait_s: float = WAIT_S, settle_s: float = SETTLE_S, stuck_s: float = STUCK_S,
) -> dict:
    driver.reset(timeline.setup)
    observer = driver.observer()
    try:
        original_detect = driver.deadlock_detect(observer)
        applied_detect = driver.set_deadlock_detect(observer, detect)
        report_before = driver.latest_deadlock(observer)
        try:
            result = drive(timeline, driver, observer, isolation, wait_s=wait_s, settle_s=settle_s, stuck_s=stuck_s)
        finally:
            restored = driver.set_deadlock_detect(observer, original_detect)
        report_after = driver.latest_deadlock(observer)
        final_rows = observer.execute(timeline.final)["rows"] if timeline.final else None
    finally:
        observer.close()
    deadlock = None
    if report_after and report_after != report_before:
        deadlock = {**parse_deadlock(report_after, result["session_ids"]), "report": report_after}
    result.update(session_ids={name: server_id for server_id, name in result["session_ids"].items()},
                  deadlock_detect=detect, deadlock_detect_applied=applied_detect,
                  deadlock_detect_restored=restored, deadlock=deadlock, final_rows=final_rows)
    result["valid"] = result["valid"] and applied_detect == on_off(detect) and restored == original_detect
    return result


def drive(timeline: Timeline, driver, observer, isolation: str, *, wait_s: float, settle_s: float,
          stuck_s: float) -> dict:
    names = sorted({step.session for step in timeline.steps})
    executors = {name: ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"session-{name}") for name in names}
    sessions = {}
    session_ids: dict[int, str] = {}
    records: list[dict] = []
    # 아직 끝나지 않은 단계. 세션마다 하나뿐이다.
    pending: dict[str, tuple[dict, Future]] = {}
    # 앞 단계가 끝나지 않아 미뤄 둔 단계. 실제 요청처럼 그 세션은 앞 문장이 돌아와야 다음 문장을 보낸다.
    deferred: dict[str, deque[dict]] = {name: deque() for name in names}
    stuck: list[str] = []
    frozen: list[str] = []  # 취소한 뒤에도 돌아오지 않아 정리하지 못한 세션
    sent_at: dict[int, float] = {}

    def finish(record: dict, future: Future, after: int) -> None:
        record.update(future.result(), finished_after_step=after)

    def send(record: dict, after: int) -> None:
        sent_at[record["step"]] = perf_counter()
        record.update(sent_after_step=after, sent_at_s=sent_at[record["step"]] - started)
        future = executors[record["session"]].submit(timed, sessions[record["session"]], record["sql"])
        if wait([future], timeout=wait_s).done:
            finish(record, future, after)
        else:
            record["blocked"] = True
            pending[record["session"]] = (record, future)
        if record["snapshot"]:
            record["locks"] = describe_locks(*driver.locks(observer), session_ids)
            record["snapshot_at_s"] = perf_counter() - started

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

    def pause(until: float, after: int) -> None:
        # 다음 단계를 보낼 때까지 기다리는 동안에도 풀린 단계를 모으고 미뤄 둔 단계를 보낸다.
        while (left := until - perf_counter()) > 0:
            if not pending:
                sleep(left)
                return
            done, _ = wait([future for _, future in pending.values()], timeout=left, return_when=FIRST_COMPLETED)
            if done:
                advance(after)

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
            session_ids[sessions[name].server_id] = name
        for index, step in enumerate(timeline.steps, start=1):
            record = {"step": index, "session": step.session, "sql": step.sql, "note": step.note,
                      "delay_s": step.delay_s, "snapshot": step.snapshot, "blocked": False, "deferred": False}
            records.append(record)
            if step.session in pending or deferred[step.session]:
                # 미룬 단계는 그 세션의 앞 단계가 끝나는 대로 보내므로 delay_s를 쓰지 않는다.
                record["deferred"] = True
                deferred[step.session].append(record)
            else:
                if step.delay_s and index - 1 in sent_at:
                    pause(sent_at[index - 1] + step.delay_s, index - 1)
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
        "wall_s": wall_s, "stuck_sessions": stuck, "session_ids": session_ids, "steps": records,
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


def lock_line(lock: dict) -> str:
    where = "표" if lock["type"] == "TABLE" else f"{lock['index']} {lock['data']}"
    return f"{lock['session']} {where} {lock['mode']} {lock['status']}"


def print_summary(rows: list[dict]) -> None:
    cases = sorted({(r["timeline"], r["isolation"], r["deadlock_detect"]) for r in rows})
    for timeline, isolation, detect in cases:
        samples = [r for r in rows if (r["timeline"], r["isolation"], r["deadlock_detect"]) == (timeline, isolation, detect)
                   and r["run"] > 0]
        if not samples:
            continue
        print(f"\n{timeline} · {isolation} · 데드락 탐지 {detect} · {len(samples)}회", file=sys.stderr)
        for position, record in enumerate(samples[0]["steps"]):
            seen = sorted({observation(sample["steps"][position]) for sample in samples})
            took = sorted(round(sample["steps"][position].get("elapsed_s") or 0, 2) for sample in samples)
            print(f"  {record['step']:>2} {record['session']} {record['sql']}: {' | '.join(seen)} · {took}초",
                  file=sys.stderr)
            if record.get("locks"):
                for lock in record["locks"]["locks"]:
                    print(f"       {lock_line(lock)}", file=sys.stderr)
        finals = sorted({json.dumps(sample["final_rows"], default=str) for sample in samples})
        print(f"  끝난 뒤: {' | '.join(finals)}", file=sys.stderr)
        rolled = sorted({str((sample["deadlock"] or {}).get("rolled_back_session")) for sample in samples})
        print(f"  데드락으로 되돌린 세션: {' | '.join(rolled)}", file=sys.stderr)


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("1 이상의 정수가 필요하다.")
    return number


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timelines", nargs="+", choices=TIMELINES, default=list(TIMELINES))
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--mysql", default="127.0.0.1:13306", help="MySQL 주소(호스트:포트)")
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
    driver = MySQL(args.mysql)
    cases = [(TIMELINES[name], isolation, detect) for name in args.timelines
             for isolation in TIMELINES[name].isolations for detect in TIMELINES[name].detects]
    try:
        server = driver.server_info()
    except Exception as error:
        print(f"DB에 붙지 못했다({error_info(error)['message']}). infra/compose.yaml로 띄웠는지 확인한다.",
              file=sys.stderr)
        return 1
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-locks" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(
        started=started, purpose="locks", validation=args.smoke,
        config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None},
        conditions={"wait_s": WAIT_S, "settle_s": SETTLE_S, "lock_timeout_s": LOCK_TIMEOUT_S, "stuck_s": STUCK_S},
        experiment_dir=EXPERIMENT_DIR,
        sources=[Path(__file__), Path(__file__).with_name("lock_timelines.py"), REPO_DIR / "tools" / "lab_env.py"],
    )
    environment["databases"] = {"mysql": server}
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
            for position, (timeline, isolation, detect) in enumerate(order):
                row = run_timeline(timeline, driver, isolation, detect)
                row.update(
                    lang="python", runtime=f"cpython-{version}",
                    variant=f"isolation={isolation};deadlock_detect={detect}",
                    model="two-sessions", workers=len({s.session for s in timeline.steps}),
                    task=timeline.name, size=len(timeline.steps),
                    params={"wait_s": WAIT_S, "settle_s": SETTLE_S, "lock_timeout_s": LOCK_TIMEOUT_S},
                    timeline=timeline.name, db="mysql", db_version=server.get("version"), isolation=isolation,
                    run_id=run_id, environment_file=env_path.name, run=run, order_index=position,
                    validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                stream.flush()
                rows.append(row)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({timeline.name}, {isolation}, {detect}). steps를 확인한다.",
                          file=sys.stderr)
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
