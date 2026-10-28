# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3", "psycopg[binary]==3.3.6"]
# ///
"""세션 A가 트랜잭션을 열어 둔 채 세션 B가 같은 행을 계속 고칠 때, 치우지 못하고 쌓이는 이전 버전과 읽기 시간을 잰다."""

import argparse
from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
import platform
import re
import statistics
import sys
from time import perf_counter, sleep
from zoneinfo import ZoneInfo

from isolation_lab import EXPERIMENT_DIR, REPO_DIR, MySQL, Postgres, error_info, positive_int

sys.path.insert(0, str(REPO_DIR / "tools"))
from lab_env import collect_environment, command_info  # noqa: E402

UPDATES = 10_000  # B가 한 행을 고치고 커밋하는 횟수
SMOKE_UPDATES = 200
READS = 7  # 읽기 시간은 이만큼 읽은 값의 중앙값으로 본다.
CHUNKS = 5  # B가 고치는 동안 느려지는지 보려고 이만큼 구간을 나눠 평균을 남긴다.
SETTLE_HISTORY = 1000  # 시작 전 History list length가 이 값 이하로 줄 때까지 기다린다.
SETTLE_LIMIT_S = 60  # 그 기다림의 최대 시간
CLOSE_POLL_S = (1, 3, 10)  # A가 끝난 뒤 History list length를 보는 때(초)
START_BALANCE = 1000

READ_BALANCE = "SELECT balance FROM accounts WHERE id = 1"
UPDATE_BALANCE = "UPDATE accounts SET balance = balance + 1 WHERE id = 1"
SETUP = (
    "DROP TABLE IF EXISTS accounts",
    "DROP TABLE IF EXISTS visits",
    "CREATE TABLE accounts (id INT PRIMARY KEY, balance INT NOT NULL)",
    f"INSERT INTO accounts (id, balance) VALUES (1, {START_BALANCE})",
    "CREATE TABLE visits (id INT PRIMARY KEY, n INT NOT NULL)",
    "INSERT INTO visits (id, n) VALUES (1, 0)",
)
# PostgreSQL은 재는 도중 자동 VACUUM이 끼어들지 않게 이 표에서 끈다. 무엇을 지울 수 있는지는 VACUUM을 직접 돌려 본다.
SETUP_BY_DB = {"mysql": SETUP, "postgres": SETUP + ("ALTER TABLE accounts SET (autovacuum_enabled = false)",)}


@dataclass(frozen=True)
class Hold:
    name: str
    title: str
    isolation: str | None  # None이면 DB 기본값으로 둔다.
    statements: tuple[str, ...]  # B가 고치기 전에 A가 실행하고 커밋하지 않은 채 두는 문장


HOLDS = {hold.name: hold for hold in (
    Hold("none", "(가) 트랜잭션을 열지 않음", None, ()),
    Hold("rr-read", "(나) REPEATABLE READ, 읽고 그대로 둠", "REPEATABLE READ", ("START TRANSACTION", READ_BALANCE)),
    Hold("rc-read", "(다) READ COMMITTED, 읽고 그대로 둠", "READ COMMITTED", ("START TRANSACTION", READ_BALANCE)),
    Hold("rr-begin", "(라) REPEATABLE READ, 열기만 함", "REPEATABLE READ", ("START TRANSACTION",)),
    Hold("rr-update", "(마) REPEATABLE READ, 다른 표를 고치고 그대로 둠", "REPEATABLE READ",
         ("START TRANSACTION", "UPDATE visits SET n = n + 1 WHERE id = 1")),
    Hold("rr-read-other", "(바) REPEATABLE READ, 다른 표를 읽고 그대로 둠", "REPEATABLE READ",
         ("START TRANSACTION", "SELECT n FROM visits WHERE id = 1")),
)}

HISTORY_LENGTH = re.compile(r"History list length (\d+)")
VACUUM_TUPLES = re.compile(r"tuples: (\d+) removed, (\d+) remain, (\d+) are dead but not yet removable")
VACUUM_CUTOFF = re.compile(r"removable cutoff: \d+, which was (\d+) XIDs old")


def history_list_length(status: str) -> int:
    # SHOW ENGINE INNODB STATUS의 TRANSACTIONS 부분에 있는 값. 커밋했지만 purge가 아직 처리하지 못한 트랜잭션 수다(purge lag).
    match = HISTORY_LENGTH.search(status)
    if match is None:
        raise ValueError("SHOW ENGINE INNODB STATUS에서 History list length를 찾지 못했다.")
    return int(match.group(1))


def vacuum_counts(notices: list[str]) -> dict:
    # VACUUM (VERBOSE)가 알림으로 돌려주는 보고에서 지운 수, 남은 수, 아직 지울 수 없던 죽은 버전 수를 읽는다.
    text = "\n".join(notices)
    tuples = VACUUM_TUPLES.search(text)
    if tuples is None:
        raise ValueError("VACUUM VERBOSE 보고에서 tuples 줄을 찾지 못했다.")
    cutoff = VACUUM_CUTOFF.search(text)
    removed, remain, dead_not_removable = (int(value) for value in tuples.groups())
    return {"removed": removed, "remain": remain, "dead_not_removable": dead_not_removable,
            "cutoff_age_xids": int(cutoff.group(1)) if cutoff else None}


def mysql_history(session) -> int:
    return history_list_length(session.execute("SHOW ENGINE INNODB STATUS")["rows"][0][2])


def postgres_vacuum(session) -> dict:
    return vacuum_counts(session.execute("VACUUM (VERBOSE) accounts")["notices"])


def postgres_relation_bytes(session) -> int:
    return session.execute("SELECT pg_relation_size('accounts')")["rows"][0][0]


def settle_history(session, limit: int, limit_s: float) -> dict:
    # History list length는 서버 전체의 값이라, 앞 실행이 남긴 것이 줄어들 때까지(최대 limit_s초) 기다린 뒤 시작한다.
    started = perf_counter()
    length = mysql_history(session)
    while length > limit and perf_counter() - started < limit_s:
        sleep(0.2)
        length = mysql_history(session)
    return {"history_list_length": length, "waited_s": perf_counter() - started}


def timed_step(session, sql: str) -> dict:
    started = perf_counter()
    result = session.execute(sql)
    return {"sql": sql, "rows": result["rows"], "rowcount": result["rowcount"], "elapsed_s": perf_counter() - started}


def run_updates(session, updates: int, chunks: int) -> dict:
    # 자동 커밋이라 UPDATE 한 번이 트랜잭션 하나다. 구간마다 한 번 고치는 데 든 평균 시간을 남긴다.
    edges = {updates * part // chunks for part in range(1, chunks + 1)}
    changed = 0
    chunk_ms = []
    started = mark = perf_counter()
    last = 0
    for index in range(1, updates + 1):
        if session.execute(UPDATE_BALANCE)["rowcount"] == 1:
            changed += 1
        if index in edges:
            now = perf_counter()
            chunk_ms.append((now - mark) / (index - last) * 1000)
            mark, last = now, index
    return {"count": updates, "changed": changed, "total_s": perf_counter() - started, "chunk_ms_per_update": chunk_ms}


def timed_reads(session, count: int) -> dict:
    values, samples = [], []
    for _ in range(count):
        started = perf_counter()
        values.append(session.execute(READ_BALANCE)["rows"][0][0])
        samples.append((perf_counter() - started) * 1000)
    return {"values": sorted(set(values)), "median_ms": statistics.median(samples), "samples_ms": samples}


def run_hold(
    hold: Hold, driver, updates: int, *, reads: int = READS, chunks: int = CHUNKS,
    close_poll_s: tuple[float, ...] = CLOSE_POLL_S, settle_limit_s: float = SETTLE_LIMIT_S,
) -> dict:
    driver.reset(SETUP_BY_DB[driver.name])
    sessions = []

    def connect(isolation: str | None = None):
        session = driver.connect(isolation)
        sessions.append(session)
        return session

    started = perf_counter()
    try:
        observer = connect()
        if driver.name == "mysql":
            before = settle_history(observer, SETTLE_HISTORY, settle_limit_s)
        else:
            before = {"relation_bytes": postgres_relation_bytes(observer)}
        holder = connect(hold.isolation)
        hold_steps = [timed_step(holder, sql) for sql in hold.statements]
        update = run_updates(connect(), updates, chunks)
        # 고친 직후의 모습을 본다. 읽기 시간도 VACUUM보다 먼저 잰다.
        if driver.name == "mysql":
            after_updates = {"history_list_length": mysql_history(observer)}
        else:
            after_updates = {"relation_bytes": postgres_relation_bytes(observer)}
        read = {"holder": timed_reads(holder, reads), "fresh": timed_reads(connect(), reads)}
        if driver.name == "postgres":
            after_updates["vacuum"] = postgres_vacuum(observer)
        if hold.statements:
            holder.execute("COMMIT")
        closed_at = perf_counter()
        if driver.name == "mysql":
            lengths = {}
            for offset in close_poll_s:
                sleep(max(0.0, closed_at + offset - perf_counter()))
                lengths[str(offset)] = mysql_history(observer)
            after_close = {"history_list_length_at_s": lengths}
        else:
            after_close = {"vacuum": postgres_vacuum(observer), "relation_bytes": postgres_relation_bytes(observer)}
    finally:
        wall_s = perf_counter() - started
        # 열어 둔 트랜잭션은 연결을 닫으면 되돌려진다.
        for session in sessions:
            session.close()
    # B가 고친 횟수와 새 세션이 읽은 마지막 값이 맞아야 제대로 돈 실행으로 본다.
    valid = update["changed"] == updates and read["fresh"]["values"] == [START_BALANCE + updates]
    return {
        "check": update["changed"], "expected_check": updates, "valid": valid, "wall_s": wall_s,
        "hold": hold.name, "isolation": hold.isolation, "hold_steps": hold_steps, "before": before,
        "updates": update, "after_updates": after_updates, "reads": read, "after_close": after_close,
    }


def cleanup_settings(driver) -> dict:
    session = driver.connect()
    try:
        if driver.name == "mysql":
            names = ("innodb_purge_threads", "innodb_purge_batch_size", "innodb_max_purge_lag",
                     "innodb_undo_log_truncate")
            row = session.execute("SELECT " + ", ".join(f"@@global.{name}" for name in names))["rows"][0]
            return dict(zip(names, row))
        names = ("autovacuum", "autovacuum_naptime", "idle_in_transaction_session_timeout", "transaction_timeout")
        return {name: session.execute(f"SHOW {name}")["rows"][0][0] for name in names}
    finally:
        session.close()


def kept(row: dict) -> int:
    # 고친 직후 치우지 못한 이전 버전의 수. MySQL은 History list length, PostgreSQL은 VACUUM이 지우지 못한 수다.
    after = row["after_updates"]
    return after["history_list_length"] if row["db"] == "mysql" else after["vacuum"]["dead_not_removable"]


def joined(values) -> str:
    return " | ".join(str(value) for value in values)


def print_summary(rows: list[dict]) -> None:
    for db in ("mysql", "postgres"):
        for hold in HOLDS.values():
            samples = [r for r in rows if r["db"] == db and r["hold"] == hold.name and r["run"] > 0]
            if not samples:
                continue
            print(f"\n{db} · {hold.title} · {len(samples)}회", file=sys.stderr)
            print(f"  고친 직후 치우지 못한 이전 버전: {joined(kept(r) for r in samples)}", file=sys.stderr)
            for who, label in (("holder", "A가"), ("fresh", "새 세션이")):
                values = sorted({value for r in samples for value in r["reads"][who]["values"]})
                times = joined(f"{r['reads'][who]['median_ms']:.2f}" for r in samples)
                print(f"  {label} 읽은 값 {joined(values)}, 읽기 중앙값(ms) {times}", file=sys.stderr)
            pace = joined(f"{r['updates']['chunk_ms_per_update'][0]:.2f}→{r['updates']['chunk_ms_per_update'][-1]:.2f}"
                          for r in samples)
            print(f"  B가 한 번 고치는 시간(ms, 첫 구간→끝 구간): {pace}", file=sys.stderr)
            if db == "mysql":
                closed = joined("/".join(str(v) for v in r["after_close"]["history_list_length_at_s"].values())
                                for r in samples)
                print(f"  A가 끝난 뒤 History list length({'/'.join(map(str, CLOSE_POLL_S))}초): {closed}",
                      file=sys.stderr)
            else:
                size = joined(f"{r['before']['relation_bytes']}→{r['after_updates']['relation_bytes']}→"
                              f"{r['after_close']['relation_bytes']}" for r in samples)
                removed = joined(r["after_close"]["vacuum"]["removed"] for r in samples)
                print(f"  표 크기(바이트, 처음→고친 직후→A가 끝나고 VACUUM 뒤): {size}", file=sys.stderr)
                print(f"  A가 끝난 뒤 VACUUM이 지운 버전: {removed}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--holds", nargs="+", choices=HOLDS, default=list(HOLDS))
    parser.add_argument("--dbs", nargs="+", choices=("mysql", "postgres"), default=["mysql", "postgres"])
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--updates", type=positive_int, help=f"B가 고치고 커밋하는 횟수(기본 {UPDATES})")
    parser.add_argument("--mysql", default="127.0.0.1:13306", help="MySQL 주소(호스트:포트)")
    parser.add_argument("--postgres", default="127.0.0.1:15432", help="PostgreSQL 주소(호스트:포트)")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true",
                        help=f"조건마다 워밍업 1회와 검증 2회만, 고치는 횟수 {SMOKE_UPDATES}번으로 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if args.smoke:
        args.trials = 2
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    if args.updates is None:
        args.updates = SMOKE_UPDATES if args.smoke else UPDATES
    if args.updates < CHUNKS:
        parser.error(f"--updates는 {CHUNKS} 이상이어야 한다.")
    return args


def main() -> int:
    args = parse_args()
    drivers = {"mysql": MySQL(args.mysql), "postgres": Postgres(args.postgres)}
    cases = [(HOLDS[name], db) for db in args.dbs for name in args.holds]
    try:
        servers = {db: {**drivers[db].server_info(), **cleanup_settings(drivers[db])} for db in args.dbs}
    except Exception as error:
        print(f"DB에 붙지 못했다({error_info(error)['message']}). infra/compose.yaml로 띄웠는지 확인한다.",
              file=sys.stderr)
        return 1
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-history" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    conditions = {"updates": args.updates, "reads": READS, "chunks": CHUNKS, "settle_history": SETTLE_HISTORY,
                  "settle_limit_s": SETTLE_LIMIT_S, "close_poll_s": CLOSE_POLL_S}
    environment = collect_environment(
        started=started, purpose="history", validation=args.smoke,
        config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None},
        conditions=conditions, experiment_dir=EXPERIMENT_DIR,
        sources=[Path(__file__), Path(__file__).with_name("isolation_lab.py"), REPO_DIR / "tools" / "lab_env.py"],
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
            for position, (hold, db) in enumerate(order):
                try:
                    row = run_hold(hold, drivers[db], args.updates)
                except Exception as error:
                    print(f"실행 실패({hold.name}, {db}): {error_info(error)['message']}", file=sys.stderr)
                    return 1
                row.update(
                    lang="python", runtime=f"cpython-{version}", variant=f"db={db};hold={hold.name}",
                    model="holder-writer", workers=2, task="history", size=args.updates,
                    params={"updates": args.updates, "reads": READS, "chunks": CHUNKS},
                    db=db, db_version=servers[db].get("version") or servers[db].get("server_version"),
                    run_id=run_id, environment_file=env_path.name, run=run, order_index=position,
                    validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                stream.flush()
                rows.append(row)
                print(f"{run}회 {db} {hold.name}: {row['wall_s']:.1f}초", file=sys.stderr)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({hold.name}, {db}). check와 reads를 확인한다.", file=sys.stderr)
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
