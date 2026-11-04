# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3", "sqlalchemy==2.1.8"]
# ///
"""커넥션 풀 크기와 풀 대기 한도에 따라, 같은 순간 몰린 요청이 연결을 얼마나 기다리고 몇 건이 실패하는지 잰다.

풀 없이 요청마다 새로 연결할 때와, 한 건씩 차례로 연결을 얻을 때(새 연결, 풀에서 빌리기)도 잰다. 묶음 ④에 쓴다.
"""

import argparse
from dataclasses import dataclass
from datetime import datetime
import json
import math
from pathlib import Path
import platform
import statistics
import sys
import threading
from time import perf_counter, sleep
from zoneinfo import ZoneInfo

EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EXPERIMENT_DIR.parent.parent
sys.path.insert(0, str(REPO_DIR / "tools"))
from lab_env import collect_environment, command_info  # noqa: E402

REQUESTS = 50  # 같은 순간에 들어오는 요청 수
HOLD_S = 0.2  # 요청마다 트랜잭션 안에서 쓰는 시간(외부 API 응답을 기다리는 셈)
SEQUENTIAL = 200  # 한 건씩 차례로 연결을 얻는 횟수
JOIN_S = 60  # 요청 하나가 이보다 오래 끝나지 않으면 실행 오류로 본다.
SCHEMA = "lab"


@dataclass(frozen=True)
class Case:
    name: str
    kind: str  # "burst"(요청이 한꺼번에) 또는 "sequential"(한 건씩 차례로)
    pool: str  # "queue"(SQLAlchemy QueuePool) 또는 "null"(NullPool, 요청마다 새 연결)
    size: int | None = None  # pool_size. max_overflow는 0이라 이보다 더 만들지 않는다.
    timeout_s: float | None = None  # pool_timeout


CASES = {case.name: case for case in (
    Case("queue-5-30", "burst", "queue", 5, 30),
    Case("queue-10-30", "burst", "queue", 10, 30),
    Case("queue-50-30", "burst", "queue", 50, 30),
    Case("queue-5-0.5", "burst", "queue", 5, 0.5),
    Case("null", "burst", "null"),
    Case("connect-null", "sequential", "null"),
    Case("checkout-queue", "sequential", "queue", 1, 30),
)}


def percentile(samples: list[float], fraction: float) -> float:
    # 가장 가까운 순위 방식. 표본에서 실제로 잰 값 하나를 돌려준다(03 실험 durability_lab.py와 같음).
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def spread(values: list[float]) -> dict:
    if not values:
        return {"median": None, "p95": None, "min": None, "max": None}
    return {"median": statistics.median(values), "p95": percentile(values, 0.95), "min": min(values),
            "max": max(values)}


def burst(engine, statement, timeout_errors: tuple[type[BaseException], ...], *, requests: int = REQUESTS,
          hold_s: float = HOLD_S, join_s: float = JOIN_S) -> dict:
    """요청 requests개가 Barrier로 같은 순간에 출발해 연결을 빌리고, 트랜잭션 안에서 hold_s를 쓴 뒤 돌려준다."""
    barrier = threading.Barrier(requests)
    out: list[dict | None] = [None] * requests
    failures: list[str] = []

    def worker(index: int) -> None:
        try:
            barrier.wait()
            started = perf_counter()
            try:
                with engine.connect() as connection:
                    borrowed = perf_counter()
                    with connection.begin():
                        connection.execute(statement)
                        sleep(hold_s)
                out[index] = {"request": index, "outcome": "ok", "started_at": started,
                              "wait_s": borrowed - started, "total_s": perf_counter() - started}
            except timeout_errors:
                ended = perf_counter()
                out[index] = {"request": index, "outcome": "timeout", "started_at": started,
                              "wait_s": ended - started, "total_s": ended - started}
        except Exception as error:  # 실행 틀이나 DB의 다른 오류는 실행 오류로 본다.
            failures.append(f"요청 {index}: {type(error).__name__}: {error}")

    threads = [threading.Thread(target=worker, args=(index,), name=f"request-{index}") for index in range(requests)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=join_s)
    hung = [thread.name for thread in threads if thread.is_alive()]
    done = [record for record in out if record is not None]
    first = min((record["started_at"] for record in done), default=0.0)
    for record in done:
        record["started_at_s"] = record.pop("started_at") - first
    ok = [record for record in done if record["outcome"] == "ok"]
    timeouts = [record for record in done if record["outcome"] == "timeout"]
    return {
        "check": len(done), "expected_check": requests,
        "valid": len(done) == requests and not failures and not hung,
        "wall_s": max((record["started_at_s"] + record["total_s"] for record in done), default=0.0),
        "summary": {"ok": len(ok), "timeout": len(timeouts),
                    "wait_s": spread([record["wait_s"] for record in ok]),
                    "timeout_after_s": spread([record["wait_s"] for record in timeouts]),
                    "start_spread_s": max((record["started_at_s"] for record in done), default=0.0)},
        "requests": done, "failures": failures, "hung": hung,
    }


def sequential(engine, statement, count: int = SEQUENTIAL) -> dict:
    """한 건씩 차례로 연결을 얻어 문장 하나를 실행하는 데 걸린 시간. 연결을 닫거나 돌려주는 시간은 넣지 않는다."""
    samples = []
    for _ in range(count):
        started = perf_counter()
        with engine.connect() as connection:
            connection.execute(statement)
            samples.append(perf_counter() - started)
    return {"check": len(samples), "expected_check": count, "valid": len(samples) == count,
            "wall_s": sum(samples), "summary": {"seconds": spread(samples)}, "samples_s": samples}


class Server:
    """풀과 따로 붙는 관찰용 연결. 서버가 본 연결 수를 읽는다."""

    def __init__(self, address: str):
        self.host, port = address.rsplit(":", 1)
        self.port = int(port)

    def url(self) -> str:
        return f"mysql+pymysql://root@{self.host}:{self.port}/{SCHEMA}"

    def connect(self):
        import pymysql

        return pymysql.connect(host=self.host, port=self.port, user="root", password="", database=SCHEMA,
                               autocommit=True, connect_timeout=5)

    @staticmethod
    def status(connection) -> dict:
        with connection.cursor() as cursor:
            cursor.execute("SHOW GLOBAL STATUS WHERE Variable_name IN "
                           "('Connections', 'Max_used_connections', 'Threads_connected')")
            return {name: int(value) for name, value in cursor.fetchall()}

    @staticmethod
    def reset_peak(connection) -> None:
        # FLUSH STATUS는 Max_used_connections를 지금 열린 연결 수로 되돌린다.
        with connection.cursor() as cursor:
            cursor.execute("FLUSH STATUS")

    def info(self) -> dict:
        connection = self.connect()
        try:
            names = ("version", "max_connections", "thread_cache_size", "skip_name_resolve", "wait_timeout",
                     "authentication_policy")
            with connection.cursor() as cursor:
                cursor.execute("SELECT " + ", ".join(f"@@global.{name}" for name in names))
                return dict(zip(names, cursor.fetchone()))
        finally:
            connection.close()


def make_engine(case: Case, url: str):
    from sqlalchemy import create_engine
    from sqlalchemy.pool import NullPool, QueuePool

    if case.pool == "null":
        return create_engine(url, poolclass=NullPool)
    return create_engine(url, poolclass=QueuePool, pool_size=case.size, max_overflow=0, pool_timeout=case.timeout_s)


def warm(engine, count: int) -> None:
    # 연결을 count개 만들어 두고 돌려준다. NullPool도 첫 연결에서 하는 방언 초기화를 측정 밖으로 뺀다.
    connections = [engine.connect() for _ in range(count)]
    for connection in connections:
        connection.close()


def run_case(case: Case, server: Server, *, requests: int = REQUESTS) -> dict:
    from sqlalchemy import exc, text

    engine = make_engine(case, server.url())
    observer = server.connect()
    try:
        warm(engine, case.size or 1)
        server.reset_peak(observer)
        before = server.status(observer)
        if case.kind == "burst":
            row = burst(engine, text("SELECT 1"), (exc.TimeoutError,), requests=requests)
        else:
            row = sequential(engine, text("SELECT 1"))
        after = server.status(observer)
        checked_out = engine.pool.checkedout() if case.pool == "queue" else 0
    finally:
        observer.close()
        engine.dispose()
    row["server"] = {"before": before, "after": after,
                     "new_connections": after["Connections"] - before["Connections"],
                     "peak_connections": after["Max_used_connections"]}
    row["valid"] = row["valid"] and checked_out == 0
    row["checked_out_after"] = checked_out
    return row


def ms(value: float | None) -> str:
    return "-" if value is None else f"{value * 1000:.2f}ms"


def print_summary(rows: list[dict]) -> None:
    for name in dict.fromkeys(r["case"] for r in rows):
        samples = [r for r in rows if r["case"] == name and r["run"] > 0]
        if not samples:
            continue
        print(f"\n{name} · {len(samples)}회", file=sys.stderr)
        for sample in samples:
            s, server = sample["summary"], sample["server"]
            if sample["kind"] == "burst":
                print(f"  run {sample['run']}: 성공 {s['ok']} · 타임아웃 {s['timeout']} · 다 끝남 {sample['wall_s']:.3f}초"
                      f" · 연결 기다림 중앙값 {ms(s['wait_s']['median'])}, 최대 {ms(s['wait_s']['max'])}"
                      f" · 서버 새 연결 {server['new_connections']}, 동시 최대 {server['peak_connections']}", file=sys.stderr)
            else:
                t = s["seconds"]
                print(f"  run {sample['run']}: 중앙값 {ms(t['median'])} · p95 {ms(t['p95'])} · 최소 {ms(t['min'])}"
                      f" · 최대 {ms(t['max'])} · 서버 새 연결 {server['new_connections']}", file=sys.stderr)


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("1 이상의 정수가 필요하다.")
    return number


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", nargs="+", choices=CASES, default=list(CASES))
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--requests", type=positive_int, default=REQUESTS)
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
    import sqlalchemy

    args = parse_args()
    server = Server(args.mysql)
    cases = [CASES[name] for name in args.cases]
    try:
        info = server.info()
    except Exception as error:
        print(f"DB에 붙지 못했다({error}). infra/compose.yaml로 띄웠는지 확인한다.", file=sys.stderr)
        return 1
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-pool" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(
        started=started, purpose="pool", validation=args.smoke,
        config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None},
        conditions={"hold_s": HOLD_S, "sequential": SEQUENTIAL, "join_s": JOIN_S, "max_overflow": 0},
        experiment_dir=EXPERIMENT_DIR, sources=[Path(__file__), REPO_DIR / "tools" / "lab_env.py"],
    )
    environment["databases"] = {"mysql": info}
    environment["sqlalchemy"] = sqlalchemy.__version__
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
            for position, case in enumerate(order):
                row = run_case(case, server, requests=args.requests)
                size = args.requests if case.kind == "burst" else SEQUENTIAL
                row.update(
                    lang="python", runtime=f"cpython-{version}",
                    variant=f"pool={case.pool};size={case.size};timeout={case.timeout_s}",
                    model="threads" if case.kind == "burst" else "sequential",
                    workers=args.requests if case.kind == "burst" else 1, task=case.kind, size=size,
                    params={"pool": case.pool, "pool_size": case.size, "max_overflow": 0,
                            "pool_timeout_s": case.timeout_s, "hold_s": HOLD_S if case.kind == "burst" else None},
                    case=case.name, kind=case.kind, db="mysql", db_version=info.get("version"),
                    sqlalchemy=sqlalchemy.__version__, run_id=run_id, environment_file=env_path.name, run=run,
                    order_index=position, validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                stream.flush()
                rows.append(row)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({case.name}): {row.get('failures') or row.get('hung')}",
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
