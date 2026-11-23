# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3"]
# ///
"""실험 07 스키마 설계와 정규화의 측정(묶음 ④ 외래 키).

P1 schema: 보조 인덱스 없이 외래 키만 건 표에 InnoDB가 어떤 인덱스를 만드는지 SHOW INDEX와 SHOW CREATE TABLE로 남긴다.
P2 insert: 외래 키가 있는 판(res_fk)과 없는 판(res_nofk)에 같은 예약을 1000건씩 executemany·COMMIT으로 넣으며 잰다.
           run마다 표를 TRUNCATE한 뒤(측정 밖) 넣는다. 워밍업 1회(run 0)와 본 측정 trials회, 반복마다 판의 순서를 바꾼다.
P3 locks(측정 아님): 연결 A가 예약을 넣고 커밋하기 전에 부모 행에 걸린 락을 보고,
           연결 B가 그 부모 행을 UPDATE할 때 기다리는지(innodb_lock_wait_timeout 3초) res_fk와 res_nofk로 견준다.
"""

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta
import json
from pathlib import Path
import platform
import random
import statistics
import sys
import threading
from time import perf_counter, sleep
from zoneinfo import ZoneInfo

EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EXPERIMENT_DIR.parent.parent
sys.path.insert(0, str(REPO_DIR / "tools"))
from lab_env import collect_environment, command_info  # noqa: E402

SCHEMA = "lab7_fk"
SEED = 7
PARTS = ("schema", "insert", "locks")
VARIANTS = ("res_fk", "res_nofk")
LOAD_BATCH = 5000
EPOCH = datetime(2026, 1, 1)
SECONDS = 365 * 24 * 3600
LOCK_TIMEOUT_S = 3
SERVER_VARIABLES = ("version", "innodb_buffer_pool_size", "innodb_flush_log_at_trx_commit", "sync_binlog",
                    "log_bin", "transaction_isolation", "innodb_lock_wait_timeout", "foreign_key_checks")


@dataclass(frozen=True)
class Scale:
    members: int
    cars: int
    reservations: int
    batch: int


FULL = Scale(members=100_000, cars=1000, reservations=100_000, batch=1000)
SMALL = Scale(members=1000, cars=100, reservations=10_000, batch=1000)

PARENTS = [
    "DROP TABLE IF EXISTS reservations_auto, res_fk, res_nofk, members, cars",
    "CREATE TABLE members (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL, plan VARCHAR(10) NOT NULL)",
    "CREATE TABLE cars (id INT PRIMARY KEY, number VARCHAR(20) NOT NULL UNIQUE)",
]
AUTO_TABLE = """CREATE TABLE reservations_auto (
  id INT AUTO_INCREMENT PRIMARY KEY, member_id INT NOT NULL, car_id INT NOT NULL, started_at DATETIME NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id), FOREIGN KEY (car_id) REFERENCES cars(id))"""
CHILD_TABLES = {
    "res_fk": """CREATE TABLE res_fk (
  id INT PRIMARY KEY, member_id INT NOT NULL, car_id INT NOT NULL, started_at DATETIME NOT NULL,
  KEY idx_member (member_id), KEY idx_car (car_id),
  FOREIGN KEY (member_id) REFERENCES members(id), FOREIGN KEY (car_id) REFERENCES cars(id))""",
    "res_nofk": """CREATE TABLE res_nofk (
  id INT PRIMARY KEY, member_id INT NOT NULL, car_id INT NOT NULL, started_at DATETIME NOT NULL,
  KEY idx_member (member_id), KEY idx_car (car_id))""",
}
ORPHANS = ("SELECT COUNT(*) FROM {table} r LEFT JOIN members m ON m.id = r.member_id "
           "LEFT JOIN cars c ON c.id = r.car_id WHERE m.id IS NULL OR c.id IS NULL")
LOCK_COLUMNS = ("ENGINE_TRANSACTION_ID, OBJECT_NAME, INDEX_NAME, LOCK_TYPE, LOCK_MODE, LOCK_STATUS, LOCK_DATA")


def make_parents(scale: Scale) -> tuple[list[tuple], list[tuple]]:
    members = [(i, f"m{i}", "일반") for i in range(1, scale.members + 1)]
    cars = [(i, f"{i:04d}가{i:04d}") for i in range(1, scale.cars + 1)]
    return members, cars


def make_reservations(scale: Scale, seed: int = SEED) -> list[tuple]:
    rng = random.Random(seed)
    return [(i, rng.randint(1, scale.members), rng.randint(1, scale.cars),
             EPOCH + timedelta(seconds=rng.randrange(SECONDS))) for i in range(1, scale.reservations + 1)]


def rotate(items: list, run: int) -> list:
    shift = run % len(items)
    return items[shift:] + items[:shift]


class Server:
    def __init__(self, address: str, password: str = ""):
        self.host, port = address.rsplit(":", 1)
        self.port = int(port)
        self.password = password

    def connect(self, database: str | None = SCHEMA):
        import pymysql

        return pymysql.connect(host=self.host, port=self.port, user="root", password=self.password,
                               database=database, autocommit=True, connect_timeout=5, read_timeout=600,
                               charset="utf8mb4")


def all_rows(connection, sql: str, args=None):
    with connection.cursor() as cursor:
        cursor.execute(sql, args)
        return cursor.fetchall()


def execute_all(connection, statements: list[str]) -> None:
    with connection.cursor() as cursor:
        for sql in statements:
            cursor.execute(sql)
            cursor.fetchall()


def load_parents(connection, scale: Scale) -> float:
    started = perf_counter()
    execute_all(connection, PARENTS)
    members, cars = make_parents(scale)
    with connection.cursor() as cursor:
        for table, rows in (("members", members), ("cars", cars)):
            marks = ", ".join(["%s"] * len(rows[0]))
            for start in range(0, len(rows), LOAD_BATCH):
                cursor.executemany(f"INSERT INTO {table} VALUES ({marks})", rows[start:start + LOAD_BATCH])
        cursor.execute("ANALYZE TABLE members, cars")
        cursor.fetchall()
    execute_all(connection, [AUTO_TABLE, *CHILD_TABLES.values()])
    return perf_counter() - started


def show_table(connection, table: str) -> dict:
    with connection.cursor() as cursor:
        cursor.execute(f"SHOW INDEX FROM {table}")
        names = [column[0] for column in cursor.description]
        indexes = [dict(zip(names, row)) for row in cursor.fetchall()]
    return {"show_create_table": all_rows(connection, f"SHOW CREATE TABLE {table}")[0][1], "show_index": indexes}


def run_schema(connection) -> dict:
    return {table: show_table(connection, table) for table in ("reservations_auto", *VARIANTS)}


def insert_reservations(connection, table: str, rows: list[tuple], batch: int) -> float:
    """측정 구간: 첫 INSERT부터 마지막 COMMIT까지. batch건마다 executemany 한 번과 COMMIT 한 번."""
    started = perf_counter()
    with connection.cursor() as cursor:
        for start in range(0, len(rows), batch):
            connection.begin()
            cursor.executemany(f"INSERT INTO {table} VALUES (%s, %s, %s, %s)", rows[start:start + batch])
            connection.commit()
    return perf_counter() - started


def run_insert(connection, run: int, rows: list[tuple], scale: Scale) -> list[dict]:
    measured = []
    for variant in rotate(list(VARIANTS), run):
        execute_all(connection, [f"TRUNCATE TABLE {variant}"])
        elapsed = insert_reservations(connection, variant, rows, scale.batch)
        count = all_rows(connection, f"SELECT COUNT(*) FROM {variant}")[0][0]
        orphans = all_rows(connection, ORPHANS.format(table=variant))[0][0]
        measured.append({"variant": variant, "task": "insert", "wall_s": elapsed,
                         "rows_per_s": len(rows) / elapsed, "check": [count, orphans],
                         "expected_check": [len(rows), 0], "valid": count == len(rows) and orphans == 0})
    return measured


def data_locks(connection, waiting_only: bool = False) -> list[dict]:
    sql = f"SELECT {LOCK_COLUMNS} FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = %s"
    if waiting_only:
        sql += " AND LOCK_STATUS = 'WAITING'"
    names = [name.strip() for name in LOCK_COLUMNS.split(",")]
    return [dict(zip(names, row)) for row in all_rows(connection, sql + " ORDER BY ENGINE_TRANSACTION_ID", (SCHEMA,))]


def run_locks(server: Server) -> dict:
    """측정 아님. A가 res_*에 member_id=1 예약을 넣고 커밋 전, B가 members id=1을 UPDATE한다."""
    import pymysql

    results = {}
    for variant in VARIANTS:
        a, b, watcher = server.connect(), server.connect(), server.connect()
        try:
            a.begin()
            all_rows(a, f"INSERT INTO {variant} VALUES (%s, 1, 1, %s)", (10_000_000, EPOCH))
            held = data_locks(watcher)
            outcome: dict = {}

            def update() -> None:
                execute_all(b, [f"SET SESSION innodb_lock_wait_timeout = {LOCK_TIMEOUT_S}"])
                started = perf_counter()
                try:
                    b.begin()
                    with b.cursor() as cursor:
                        outcome["rows_affected"] = cursor.execute("UPDATE members SET plan = '골드' WHERE id = 1")
                    b.rollback()
                    outcome["error"] = None
                except pymysql.err.OperationalError as error:
                    outcome["error"] = list(error.args)
                    b.rollback()
                outcome["waited_s"] = perf_counter() - started

            thread = threading.Thread(target=update)
            thread.start()
            sleep(0.5)
            waiting = data_locks(watcher, waiting_only=True)
            thread.join()
            a.rollback()
            results[variant] = {"locks_held_before_update": held, "waiting_during_update": waiting, **outcome}
        finally:
            for connection in (a, b, watcher):
                connection.close()
    return results


def summarize(rows: list[dict]) -> None:
    groups: dict[str, list[dict]] = {}
    for row in rows:
        if row["run"] > 0:
            groups.setdefault(row["variant"], []).append(row)
    for variant, group in sorted(groups.items()):
        walls = sorted(row["wall_s"] * 1000 for row in group)
        rates = sorted(row["rows_per_s"] for row in group)
        print(f"insert {variant:8} median {statistics.median(walls):10.3f}ms [{walls[0]:.3f}~{walls[-1]:.3f}] "
              f"{statistics.median(rates):,.0f} rows/s valid={all(row['valid'] for row in group)}", file=sys.stderr)


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("1 이상")
    return number


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parts", nargs="+", choices=PARTS, default=list(PARTS))
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--smoke", action="store_true",
                        help="회원 1000·차 100·예약 1만으로 워밍업 1회와 검증 2회. results/validation/에 저장")
    parser.add_argument("--mysql", default="127.0.0.1:13306")
    parser.add_argument("--password", default="")
    parser.add_argument("--output-dir", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.smoke:
        args.trials = 2
    scale = SMALL if args.smoke else FULL
    server = Server(args.mysql, args.password)
    try:
        bootstrap = server.connect(database=None)
        execute_all(bootstrap, [f"CREATE DATABASE IF NOT EXISTS {SCHEMA}"])
        bootstrap.close()
        connection = server.connect()
    except Exception as error:
        print(f"DB에 붙지 못했다({error}). infra/compose.yaml로 띄웠는지 확인한다.", file=sys.stderr)
        return 1
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-fk" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    try:
        load_s = load_parents(connection, scale)
        rows_in = make_reservations(scale)
        environment = collect_environment(
            started=started, purpose="foreign-key", validation=args.smoke,
            config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None, "password": None},
            conditions={"schema": SCHEMA, "seed": SEED, "scale": scale.__dict__, "load_parents_s": load_s,
                        "tables": {"parents": PARENTS, "auto": AUTO_TABLE, **CHILD_TABLES},
                        "lock_timeout_s": LOCK_TIMEOUT_S},
            experiment_dir=EXPERIMENT_DIR,
            sources=[Path(__file__), REPO_DIR / "tools" / "lab_env.py"],
        )
        environment["databases"] = {"mysql": dict(zip(SERVER_VARIABLES, all_rows(
            connection, "SELECT " + ", ".join(f"@@global.{name}" for name in SERVER_VARIABLES))[0]))}
        environment["docker_images"] = command_info(
            ["docker", "compose", "-f", str(REPO_DIR / "infra" / "compose.yaml"), "images"])
        environment["docker_stats_before"] = command_info(
            ["docker", "stats", "--no-stream", "--format", "{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}"])
        with env_path.open("x", encoding="utf-8") as stream:
            json.dump(environment, stream, ensure_ascii=False, indent=2, default=str)
            stream.write("\n")
        print(f"환경: {env_path}", file=sys.stderr)
        ok = True
        if "schema" in args.parts:
            schema_path = directory / f"{run_id}-schema.json"
            with schema_path.open("x", encoding="utf-8") as stream:
                json.dump(run_schema(connection), stream, ensure_ascii=False, indent=2, default=str)
                stream.write("\n")
            print(f"P1 스키마: {schema_path}", file=sys.stderr)
        if "insert" in args.parts:
            rows = []
            with result_path.open("x", encoding="utf-8") as stream:
                for run in range(args.trials + 1):
                    for position, measured in enumerate(run_insert(connection, run, rows_in, scale)):
                        row = {"lang": "python", "runtime": f"cpython-{version}", "variant": measured.pop("variant"),
                               "model": "single-session", "workers": 1, "task": measured.pop("task"),
                               "size": scale.reservations,
                               "params": {"members": scale.members, "cars": scale.cars, "batch": scale.batch,
                                          "commit_every": scale.batch},
                               "run": run, **measured, "db": "mysql", "run_id": run_id,
                               "environment_file": env_path.name, "order_index": position, "validation": args.smoke}
                        stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                        stream.flush()
                        rows.append(row)
                        if not row["valid"]:
                            print(f"검증 실패: {row['variant']} {row['check']} != {row['expected_check']}",
                                  file=sys.stderr)
                    print(f"run {run} 끝", file=sys.stderr)
            print(f"P2 결과: {result_path}", file=sys.stderr)
            summarize(rows)
            ok = all(row["valid"] for row in rows)
        if "locks" in args.parts:
            locks_path = directory / f"{run_id}-locks.json"
            with locks_path.open("x", encoding="utf-8") as stream:
                json.dump(run_locks(server), stream, ensure_ascii=False, indent=2, default=str)
                stream.write("\n")
            print(f"P3 락: {locks_path}", file=sys.stderr)
        if args.smoke:
            print("작은 입력의 실행·저장 검증 완료. 가설 판단에 쓰지 않는다.", file=sys.stderr)
        return 0 if ok else 1
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
