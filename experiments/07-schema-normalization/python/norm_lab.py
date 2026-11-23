# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3"]
# ///
"""실험 07 스키마 설계와 정규화의 측정(묶음 ③ 정규화 대 비정규화).

같은 예약 데이터를 정규화 판(reservations_n + members 조인)과 비정규화 판(reservations_d에 member_plan 복사)으로 두고
읽기 두 가지(Q1 한 회원의 최근 예약 20건, Q2 골드 회원 예약 수)와 쓰기 두 가지(U1 예약 1만 건인 회원 1의 등급 변경,
U2 예약 10건인 회원 2의 등급 변경)를 잰다.
조건마다 워밍업 1회(run 0)와 본 측정 trials회. 반복마다 조건의 실행 순서를 한 칸씩 돌린다.
측정 구간은 쿼리 실행부터 결과 행을 모두 받을 때까지(UPDATE는 COMMIT까지)이고 연결 생성과 적재는 뺀다.
"""

import argparse
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta
import json
from pathlib import Path
import platform
import random
import statistics
import sys
from time import perf_counter
from zoneinfo import ZoneInfo

EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EXPERIMENT_DIR.parent.parent
sys.path.insert(0, str(REPO_DIR / "tools"))
from lab_env import collect_environment, command_info  # noqa: E402

SCHEMA = "lab7_perf"
SEED = 7
LOAD_BATCH = 5000
GOLD, NORMAL = "골드", "일반"
EPOCH = datetime(2026, 1, 1)
SECONDS = 365 * 24 * 3600
SERVER_VARIABLES = ("version", "innodb_buffer_pool_size", "innodb_flush_log_at_trx_commit", "sync_binlog",
                    "log_bin", "transaction_isolation", "sql_mode")

TABLES = [
    "DROP TABLE IF EXISTS reservations_n, reservations_d, members, cars",
    """CREATE TABLE members (
         id INT PRIMARY KEY, email VARCHAR(50) NOT NULL UNIQUE, name VARCHAR(20) NOT NULL, plan VARCHAR(10) NOT NULL)""",
    """CREATE TABLE cars (
         id INT PRIMARY KEY, number VARCHAR(20) UNIQUE, type VARCHAR(20) NOT NULL, fee INT NOT NULL)""",
    """CREATE TABLE reservations_n (
         id INT PRIMARY KEY, member_id INT NOT NULL, car_id INT NOT NULL, started_at DATETIME NOT NULL,
         KEY idx_member (member_id, started_at))""",
    """CREATE TABLE reservations_d (
         id INT PRIMARY KEY, member_id INT NOT NULL, car_id INT NOT NULL, started_at DATETIME NOT NULL,
         member_plan VARCHAR(10) NOT NULL, KEY idx_member (member_id, started_at))""",
]
# 비정규화 판은 정규화 판과 같은 행에 회원의 plan을 복사해 넣는다.
COPY_DENORM = """INSERT INTO reservations_d (id, member_id, car_id, started_at, member_plan)
                 SELECT r.id, r.member_id, r.car_id, r.started_at, m.plan
                 FROM reservations_n r JOIN members m ON m.id = r.member_id ORDER BY r.id"""


@dataclass(frozen=True)
class Scale:
    members: int
    reservations: int
    cars: int

    @property
    def heavy(self) -> int:
        """회원 1의 예약 수. 본 측정 100만 건 중 1만 건(1%)."""
        return self.reservations // 100

    @property
    def regular_members(self) -> int:
        """예약 10건씩인 회원 수(회원 2부터)."""
        return (self.reservations - self.heavy) // 10


FULL = Scale(members=100_000, reservations=1_000_000, cars=1000)
SMALL = Scale(members=1000, reservations=10_000, cars=1000)


@dataclass
class Data:
    members: list[tuple]
    cars: list[tuple]
    reservations: list[tuple]


def make_data(scale: Scale, seed: int = SEED) -> Data:
    rng = random.Random(seed)
    gold = set(rng.sample(range(2, scale.members + 1), scale.members // 5))
    members = [(i, f"m{i}@a.com", f"m{i}", GOLD if i in gold else NORMAL) for i in range(1, scale.members + 1)]
    types = [("모닝", 5000), ("레이", 4000), ("아반떼", 8000), ("쏘나타", 10000)]
    cars = [(i, f"{i:04d}가{i:04d}", *types[i % len(types)]) for i in range(1, scale.cars + 1)]
    owners = [1] * scale.heavy + [m for m in range(2, scale.regular_members + 2) for _ in range(10)]
    rng.shuffle(owners)
    # started_at은 전체에서 겹치지 않게 뽑아 Q1의 ORDER BY started_at DESC LIMIT 20이 하나로 정해지게 한다.
    seconds = rng.sample(range(SECONDS), len(owners))
    reservations = [(i + 1, member, rng.randint(1, scale.cars), EPOCH + timedelta(seconds=second))
                    for i, (member, second) in enumerate(zip(owners, seconds))]
    return Data(members, cars, reservations)


@dataclass(frozen=True)
class Case:
    name: str      # q1, q2, u1, u2
    variant: str   # norm, denorm
    sql: tuple[str, ...]


def cases() -> list[Case]:
    return [
        Case("q1", "norm", ("SELECT r.id, r.started_at, m.plan FROM reservations_n r JOIN members m ON m.id = r.member_id "
                            "WHERE r.member_id = 1 ORDER BY r.started_at DESC LIMIT 20",)),
        Case("q1", "denorm", ("SELECT id, started_at, member_plan FROM reservations_d WHERE member_id = 1 "
                              "ORDER BY started_at DESC LIMIT 20",)),
        Case("q2", "norm", ("SELECT COUNT(*) FROM reservations_n r JOIN members m ON m.id = r.member_id "
                            "WHERE m.plan = '골드'",)),
        Case("q2", "denorm", ("SELECT COUNT(*) FROM reservations_d WHERE member_plan = '골드'",)),
        Case("u1", "norm", ("UPDATE members SET plan = %s WHERE id = %s",)),
        Case("u1", "denorm", ("UPDATE members SET plan = %s WHERE id = %s",
                              "UPDATE reservations_d SET member_plan = %s WHERE member_id = %s")),
        Case("u2", "norm", ("UPDATE members SET plan = %s WHERE id = %s",)),
        Case("u2", "denorm", ("UPDATE members SET plan = %s WHERE id = %s",
                              "UPDATE reservations_d SET member_plan = %s WHERE member_id = %s")),
    ]


UPDATE_MEMBER = {"u1": 1, "u2": 2}
# --denorm-index cov: 비정규화 판의 idx_member를 member_plan까지 덮는 인덱스로 바꾼 판(variant denorm_cov).
DENORM_INDEX = {
    "plain": ("denorm", []),
    "cov": ("denorm_cov", ["DROP INDEX idx_member ON reservations_d",
                           "CREATE INDEX idx_member_cov ON reservations_d (member_id, started_at, member_plan)",
                           "ANALYZE TABLE reservations_d"]),
}


def other(plan: str) -> str:
    return NORMAL if plan == GOLD else GOLD


def expected_q1(data: Data) -> list[int]:
    own = sorted((row for row in data.reservations if row[1] == 1), key=lambda row: row[3], reverse=True)
    return [row[0] for row in own[:20]]


def expected_q2(data: Data) -> int:
    plans = {row[0]: row[3] for row in data.members}
    return sum(1 for row in data.reservations if plans[row[1]] == GOLD)


def expected_rows_affected(data: Data, case: Case) -> int:
    member = UPDATE_MEMBER[case.name]
    if case.variant == "norm":
        return 1
    return 1 + Counter(row[1] for row in data.reservations)[member]


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


def load(connection, data: Data) -> dict:
    """표를 새로 만들고 적재한다. 단계별 시간(초)을 돌려준다."""
    times = {}
    started = perf_counter()
    execute_all(connection, TABLES)
    with connection.cursor() as cursor:
        for table, rows in (("members", data.members), ("cars", data.cars), ("reservations_n", data.reservations)):
            marks = ", ".join(["%s"] * len(rows[0]))
            begun = perf_counter()
            for start in range(0, len(rows), LOAD_BATCH):
                cursor.executemany(f"INSERT INTO {table} VALUES ({marks})", rows[start:start + LOAD_BATCH])
            times[table] = perf_counter() - begun
        begun = perf_counter()
        cursor.execute(COPY_DENORM)
        times["reservations_d"] = perf_counter() - begun
        begun = perf_counter()
        cursor.execute("ANALYZE TABLE members, cars, reservations_n, reservations_d")
        cursor.fetchall()
        times["analyze"] = perf_counter() - begun
    times["total"] = perf_counter() - started
    return times


def table_sizes(connection) -> list:
    execute_all(connection, ["SET SESSION information_schema_stats_expiry = 0"])
    return [list(row) for row in all_rows(
        connection, "SELECT table_name, table_rows, data_length, index_length FROM information_schema.TABLES "
                    "WHERE table_schema = %s ORDER BY table_name", (SCHEMA,))]


def index_sizes(connection) -> list:
    """innodb_index_stats의 인덱스별 페이지 수(size, 16KB 페이지)."""
    return [list(row) for row in all_rows(
        connection, "SELECT table_name, index_name, stat_value, stat_value * @@innodb_page_size "
                    "FROM mysql.innodb_index_stats WHERE database_name = %s AND table_name = 'reservations_d' "
                    "AND stat_name = 'size' ORDER BY index_name", (SCHEMA,))]


def explain(connection, case: Case, plan: str) -> dict:
    """SELECT는 FORMAT=TREE와 EXPLAIN ANALYZE, 단일 표 UPDATE는 TREE를 지원하지 않아 FORMAT=JSON만 남긴다."""
    member = UPDATE_MEMBER.get(case.name)
    out = {}
    for index, sql in enumerate(case.sql):
        args = None if case.name.startswith("q") else (plan, member)
        out[f"traditional_{index}"] = [list(row) for row in all_rows(connection, "EXPLAIN " + sql, args)]
        if case.name.startswith("q"):
            out[f"tree_{index}"] = all_rows(connection, "EXPLAIN FORMAT=TREE " + sql)[0][0]
            out[f"analyze_{index}"] = all_rows(connection, "EXPLAIN ANALYZE " + sql)[0][0]
        else:
            out[f"json_{index}"] = json.loads(all_rows(connection, "EXPLAIN FORMAT=JSON " + sql, (plan, member))[0][0])
    return out


def run_update(connection, case: Case, plan: str) -> tuple[float, int]:
    member = UPDATE_MEMBER[case.name]
    affected = 0
    started = perf_counter()
    connection.begin()
    with connection.cursor() as cursor:
        for sql in case.sql:
            affected += cursor.execute(sql, (plan, member))
    connection.commit()
    return perf_counter() - started, affected


def restore(connection, member: int, plan: str) -> None:
    """측정 밖에서 회원 등급과 비정규화 판의 복사본을 함께 원래 값으로 돌린다."""
    connection.begin()
    with connection.cursor() as cursor:
        cursor.execute("UPDATE members SET plan = %s WHERE id = %s", (plan, member))
        cursor.execute("UPDATE reservations_d SET member_plan = %s WHERE member_id = %s", (plan, member))
    connection.commit()


def measure(connection, case: Case, data: Data, original: dict[int, str], expected: dict) -> dict:
    if case.name == "q1":
        started = perf_counter()
        got = all_rows(connection, case.sql[0])
        elapsed = perf_counter() - started
        ids = [row[0] for row in got]
        return {"wall_s": elapsed, "check": ids, "expected_check": expected["q1"], "valid": ids == expected["q1"]}
    if case.name == "q2":
        started = perf_counter()
        count = int(all_rows(connection, case.sql[0])[0][0])
        elapsed = perf_counter() - started
        return {"wall_s": elapsed, "check": count, "expected_check": expected["q2"], "valid": count == expected["q2"]}
    member = UPDATE_MEMBER[case.name]
    plan = other(original[member])
    elapsed, affected = run_update(connection, case, plan)
    after = all_rows(connection, "SELECT plan FROM members WHERE id = %s", (member,))[0][0]
    copies = all_rows(connection, "SELECT COUNT(*) FROM reservations_d WHERE member_id = %s AND member_plan = %s",
                      (member, plan))[0][0]
    restore(connection, member, original[member])
    want = expected["rows_affected"][(case.name, case.variant)]
    copied = case.variant == "norm" or copies == want - 1
    return {"wall_s": elapsed, "rows_affected": affected, "check": affected, "expected_check": want,
            "plan_from": original[member], "plan_to": plan,
            "valid": affected == want and after == plan and copied}


def summarize(rows: list[dict]) -> None:
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        if row["run"] > 0:
            groups.setdefault((row["task"], row["variant"]), []).append(row)
    for (task, variant), group in sorted(groups.items()):
        walls = sorted(row["wall_s"] * 1000 for row in group)
        affected = {row.get("rows_affected") for row in group}
        print(f"{task:3} {variant:7} median {statistics.median(walls):9.3f}ms "
              f"[{walls[0]:.3f}~{walls[-1]:.3f}] rows_affected={affected} "
              f"valid={all(row['valid'] for row in group)}", file=sys.stderr)


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("1 이상")
    return number


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--denorm-index", choices=tuple(DENORM_INDEX), default="plain",
                        help="plain: idx_member(member_id, started_at), cov: idx_member_cov(member_id, started_at, member_plan)")
    parser.add_argument("--smoke", action="store_true",
                        help="회원 1000·예약 1만으로 워밍업 1회와 검증 2회. results/validation/에 저장")
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
    denorm_name, index_change = DENORM_INDEX[args.denorm_index]
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-norm" + ("-cov" if args.denorm_index == "cov" else "") \
        + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    explain_path = directory / f"{run_id}-explain.json"
    try:
        print(f"데이터 생성: {scale}", file=sys.stderr)
        data = make_data(scale)
        print("적재 중", file=sys.stderr)
        load_s = load(connection, data)
        print(f"적재 {load_s['total']:.1f}s", file=sys.stderr)
        sizes_before = {"tables": table_sizes(connection), "indexes": index_sizes(connection)}
        if index_change:
            begun = perf_counter()
            execute_all(connection, index_change)
            load_s["denorm_index_change"] = perf_counter() - begun
        sizes_after = {"tables": table_sizes(connection), "indexes": index_sizes(connection)}
        original = {row[0]: row[3] for row in data.members[:2]}
        all_cases = [Case(c.name, denorm_name, c.sql) if c.variant == "denorm" else c for c in cases()]
        expected = {"q1": expected_q1(data), "q2": expected_q2(data),
                    "rows_affected": {(c.name, c.variant): expected_rows_affected(data, c)
                                      for c in all_cases if c.name.startswith("u")}}
        environment = collect_environment(
            started=started, purpose="normalization", validation=args.smoke,
            config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None, "password": None},
            conditions={"schema": SCHEMA, "seed": SEED, "scale": scale.__dict__, "heavy": scale.heavy,
                        "regular_members": scale.regular_members, "load_s": load_s,
                        "original_plans": original, "cases": [c.__dict__ for c in all_cases],
                        "expected": {**expected, "rows_affected": {f"{k[0]}-{k[1]}": v for k, v in
                                                                   expected["rows_affected"].items()}}},
            experiment_dir=EXPERIMENT_DIR,
            sources=[Path(__file__), REPO_DIR / "tools" / "lab_env.py"],
        )
        environment["databases"] = {"mysql": dict(zip(SERVER_VARIABLES, all_rows(
            connection, "SELECT " + ", ".join(f"@@global.{name}" for name in SERVER_VARIABLES))[0]))}
        environment["table_sizes"] = {"before_index_change": sizes_before, "after_index_change": sizes_after}
        environment["docker_images"] = command_info(
            ["docker", "compose", "-f", str(REPO_DIR / "infra" / "compose.yaml"), "images"])
        environment["docker_stats_before"] = command_info(
            ["docker", "stats", "--no-stream", "--format", "{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}"])
        with env_path.open("x", encoding="utf-8") as stream:
            json.dump(environment, stream, ensure_ascii=False, indent=2, default=str)
            stream.write("\n")
        explains = {f"{c.name}-{c.variant}": explain(connection, c, other(original.get(UPDATE_MEMBER.get(c.name), NORMAL)))
                    for c in all_cases}
        with explain_path.open("x", encoding="utf-8") as stream:
            json.dump(explains, stream, ensure_ascii=False, indent=2, default=str)
            stream.write("\n")
        print(f"환경: {env_path}\n계획: {explain_path}\n결과: {result_path}", file=sys.stderr)
        rows = []
        with result_path.open("x", encoding="utf-8") as stream:
            for run in range(args.trials + 1):
                for position, case in enumerate(rotate(all_cases, run)):
                    measured = measure(connection, case, data, original, expected)
                    row = {"lang": "python", "runtime": f"cpython-{version}", "variant": case.variant,
                           "model": "single-session", "workers": 1, "task": case.name,
                           "size": scale.reservations,
                           "params": {"members": scale.members, "reservations": scale.reservations,
                                      "cars": scale.cars, "heavy_member_reservations": scale.heavy,
                                      "denorm_index": args.denorm_index},
                           "sql": list(case.sql), "run": run, **measured, "db": "mysql", "run_id": run_id,
                           "environment_file": env_path.name, "order_index": position, "validation": args.smoke}
                    stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                    stream.flush()
                    rows.append(row)
                    if not row["valid"]:
                        print(f"검증 실패: {case.name} {case.variant} {row['check']} != {row['expected_check']}",
                              file=sys.stderr)
                print(f"run {run} 끝", file=sys.stderr)
        final = {"plans": {m: all_rows(connection, "SELECT plan FROM members WHERE id = %s", (m,))[0][0]
                           for m in original},
                 "q2_norm": int(all_rows(connection, cases()[2].sql[0])[0][0]),
                 "q2_denorm": int(all_rows(connection, cases()[3].sql[0])[0][0])}
        final_ok = final["plans"] == original and final["q2_norm"] == final["q2_denorm"] == expected["q2"]
        print(f"측정 뒤 상태: {final} 원래와 같음={final_ok}", file=sys.stderr)
        if args.smoke:
            print("작은 입력의 실행·저장 검증 완료. 가설 판단에 쓰지 않는다.", file=sys.stderr)
        summarize(rows)
        return 0 if final_ok and all(row["valid"] for row in rows) else 1
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
