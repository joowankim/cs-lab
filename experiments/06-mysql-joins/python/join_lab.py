# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3"]
# ///
"""실험 06 조인과 SQL의 측정.

묶음 ① results: 작은 표에서 조인·서브쿼리 쿼리의 결과 행과 트리 형식 계획, 결과가 손으로 센 기대값과 같은지.
묶음 ② algo: 1만 × 1만 조인을 조건마다 EXPLAIN ANALYZE의 서버 안 시간과 쿼리 그대로의 응답 시간으로 잰다.
묶음 ③ n1: 회원 N명과 그 주문을 N+1·JOIN·IN 두 번·IN 서브쿼리로 가져오며 쿼리 횟수와 경과 시간을 잰다.
조건마다 워밍업 1회(run 0)와 본 측정 trials회. 반복마다 조건의 실행 순서를 한 칸씩 돌린다.
"""

import argparse
from datetime import datetime
import json
from pathlib import Path
import platform
import re
import statistics
import sys
from time import perf_counter
from zoneinfo import ZoneInfo

EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EXPERIMENT_DIR.parent.parent
sys.path.insert(0, str(REPO_DIR / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lab_env import collect_environment, command_info  # noqa: E402
import join_cases  # noqa: E402

SCHEMA = "lab6"
PARTS = ("results", "algo", "n1")
LOAD_BATCH = 5000
ACTUAL = re.compile(r"\(actual time=([\d.e+-]+)\.\.([\d.e+-]+) rows=([\d.e+]+) loops=(\d+)\)")
JOIN_KIND = re.compile(r"(Inner hash join|Left hash join|Hash semijoin|Hash antijoin|Nested loop \w+ join|"
                       r"Nested loop antijoin|Nested loop semijoin)")
SERVER_VARIABLES = ("version", "innodb_buffer_pool_size", "join_buffer_size", "optimizer_switch", "sql_mode")


def parse_analyze(text: str) -> dict:
    """EXPLAIN ANALYZE 첫 줄(맨 위 반복자)의 실제 시간(ms)과 행 수, 계획에 나온 조인 방식들."""
    first = text.strip().splitlines()[0]
    actual = ACTUAL.search(first)
    return {
        "first_ms": float(actual.group(1)) if actual else None,
        "last_ms": float(actual.group(2)) if actual else None,
        "rows": float(actual.group(3)) if actual else None,
        "join_kinds": JOIN_KIND.findall(text),
    }


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
                               database=database, autocommit=True, connect_timeout=5, read_timeout=600)


def all_rows(connection, sql: str, args=None):
    with connection.cursor() as cursor:
        cursor.execute(sql, args)
        return cursor.fetchall()


def execute_all(connection, statements: list[str]) -> None:
    with connection.cursor() as cursor:
        for sql in statements:
            cursor.execute(sql)
            cursor.fetchall()


def load(connection, statements: list[str], tables: list[tuple[str, list[tuple]]]) -> float:
    started = perf_counter()
    execute_all(connection, statements)
    with connection.cursor() as cursor:
        for table, rows in tables:
            marks = ", ".join(["%s"] * len(rows[0]))
            for start in range(0, len(rows), LOAD_BATCH):
                cursor.executemany(f"INSERT INTO {table} VALUES ({marks})", rows[start:start + LOAD_BATCH])
        if tables:
            cursor.execute("ANALYZE TABLE " + ", ".join(table for table, _ in tables))
            cursor.fetchall()
    return perf_counter() - started


def explain_tree(connection, sql: str) -> str:
    return all_rows(connection, "EXPLAIN FORMAT=TREE " + sql.rstrip("; "))[0][0]


def explain_analyze(connection, sql: str) -> str:
    return all_rows(connection, "EXPLAIN ANALYZE " + sql.rstrip("; "))[0][0]


def run_results(connection, run: int) -> list[dict]:
    rows = []
    for query in rotate(list(join_cases.RESULT_QUERIES), run):
        started = perf_counter()
        got = tuple(tuple(row) for row in all_rows(connection, query.sql))
        elapsed = perf_counter() - started
        valid = sorted(got, key=repr) == sorted(query.expected, key=repr)
        rows.append({"variant": query.name, "task": "result-rows", "situation": query.situation,
                     "label": query.label, "author": query.author, "sql": query.sql,
                     "size": 5, "params": {"users": 5, "orders": 5},
                     "wall_s": elapsed, "result": [list(r) for r in got], "expected": [list(r) for r in query.expected],
                     "tree": explain_tree(connection, query.sql), "check": len(got),
                     "expected_check": len(query.expected), "valid": valid})
    return rows


def set_algo_index(connection, wanted: bool) -> None:
    has = bool(all_rows(connection, "SELECT 1 FROM information_schema.STATISTICS WHERE table_schema = %s "
                                    "AND table_name = 'algo_users' AND index_name = 'idx_code'", (SCHEMA,)))
    if wanted and not has:
        execute_all(connection, ["CREATE INDEX idx_code ON algo_users (code)", "ANALYZE TABLE algo_users"])
    elif has and not wanted:
        execute_all(connection, ["DROP INDEX idx_code ON algo_users", "ANALYZE TABLE algo_users"])


def run_algo(connection, run: int, skip_slow: bool) -> list[dict]:
    rows = []
    cases = [case for case in join_cases.ALGO_CASES if not (skip_slow and "no-bnl" in case.name)]
    for case in rotate(cases, run):
        set_algo_index(connection, case.index)
        analyze = explain_analyze(connection, case.sql)
        started = perf_counter()
        got = tuple(int(value) for value in all_rows(connection, case.sql)[0])
        elapsed = perf_counter() - started
        parsed = parse_analyze(analyze)
        rows.append({"variant": case.name, "task": "join-count-sum", "situation": "2", "label": case.label,
                     "author": "에이전트", "sql": case.sql, "size": join_cases.ALGO_ROWS,
                     "params": {"users": join_cases.ALGO_ROWS, "orders": join_cases.ALGO_ROWS, "index": case.index},
                     "wall_s": elapsed, "analyze": parsed, "analyze_text": analyze,
                     "check": list(got), "expected_check": list(case.expected),
                     "valid": got == case.expected and parsed["last_ms"] is not None})
    return rows


def fetch_n1(connection, variant: join_cases.N1Variant, n: int) -> tuple[int, int, int]:
    """(보낸 쿼리 수, 받은 회원 수, 받은 주문 수). 앱이 받는 데이터까지 포함한 구간."""
    queries = 0
    with connection.cursor() as cursor:
        if variant.name == "n-plus-1":
            cursor.execute(join_cases.N1_LIST, (n,))
            users = cursor.fetchall()
            queries += 1
            orders = 0
            for user_id, _ in users:
                cursor.execute(join_cases.N1_PER_USER, (user_id,))
                orders += len(cursor.fetchall())
                queries += 1
            return queries, len(users), orders
        if variant.name == "join":
            cursor.execute(join_cases.N1_JOIN, (n,))
            got = cursor.fetchall()
            return 1, len({row[0] for row in got}), sum(1 for row in got if row[2] is not None)
        if variant.name == "in-list":
            cursor.execute(join_cases.N1_LIST, (n,))
            users = cursor.fetchall()
            ids = [user_id for user_id, _ in users]
            cursor.execute(join_cases.N1_IN.format(placeholders=", ".join(["%s"] * len(ids))), ids)
            return 2, len(users), len(cursor.fetchall())
        if variant.name == "in-subquery":
            cursor.execute(join_cases.N1_IN_SUBQUERY, (n,))
            got = cursor.fetchall()
            return 1, len({row[1] for row in got}), len(got)
    raise ValueError(variant.name)


def round_trip_ms(connection, count: int = 1000) -> float:
    times = []
    with connection.cursor() as cursor:
        for _ in range(count):
            started = perf_counter()
            cursor.execute("SELECT 1")
            cursor.fetchall()
            times.append((perf_counter() - started) * 1000)
    return statistics.median(times)


def run_n1(connection, run: int, sizes: tuple[int, ...]) -> list[dict]:
    rows = []
    conditions = [(variant, n) for n in sizes for variant in join_cases.N1_VARIANTS]
    for variant, n in rotate(conditions, run):
        started = perf_counter()
        queries, users, orders = fetch_n1(connection, variant, n)
        elapsed = perf_counter() - started
        expected = (1 + n if variant.name == "n-plus-1" else len(variant.queries), n, 10 * n)
        rows.append({"variant": variant.name, "task": "list-users-with-orders", "situation": "3",
                     "label": variant.label, "author": variant.author, "sql": list(variant.queries), "size": n,
                     "params": {"users": join_cases.N1_USERS, "orders": join_cases.N1_ORDERS},
                     "wall_s": elapsed, "queries": queries, "check": [queries, users, orders],
                     "expected_check": list(expected), "valid": (queries, users, orders) == expected})
    rows.append({"variant": "select-1", "task": "round-trip", "situation": "3", "label": "SELECT 1 왕복",
                 "author": "에이전트", "sql": ["SELECT 1"], "size": 1000, "params": {},
                 "wall_s": round_trip_ms(connection) / 1000, "check": 1, "expected_check": 1, "valid": True})
    return rows


def summarize(rows: list[dict]) -> None:
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        if row["run"] > 0:
            groups.setdefault((row["part"], row["variant"], row["size"]), []).append(row)
    for (part, variant, size), group in groups.items():
        walls = sorted(row["wall_s"] * 1000 for row in group)
        extra = ""
        if part == "algo":
            inside = sorted(row["analyze"]["last_ms"] for row in group)
            extra = f" server {statistics.median(inside):.3f}ms [{inside[0]:.3f}~{inside[-1]:.3f}] " \
                    f"{group[0]['analyze']['join_kinds']}"
        valid = all(row["valid"] for row in group)
        print(f"{part:7} {variant:28} n={size:<6} client {statistics.median(walls):.3f}ms "
              f"[{walls[0]:.3f}~{walls[-1]:.3f}]{extra} valid={valid}", file=sys.stderr)


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
                        help="워밍업 1회와 검증 2회, ②는 NO_BNL을 빼고 ③은 N=10만. results/validation/에 저장")
    parser.add_argument("--mysql", default="127.0.0.1:13306")
    parser.add_argument("--password", default="")
    parser.add_argument("--output-dir", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.smoke:
        args.trials = 2
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
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-join" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    sizes = (10,) if args.smoke else join_cases.N1_SIZES
    try:
        load_s = {}
        if "results" in args.parts:
            load_s["results"] = load(connection, join_cases.SMALL_TABLES, [])
        if "algo" in args.parts:
            users, orders = join_cases.algo_rows()
            load_s["algo"] = load(connection, join_cases.ALGO_TABLES,
                                  [("algo_users", users), ("algo_orders", orders)])
        if "n1" in args.parts:
            users, orders = join_cases.n1_rows()
            load_s["n1"] = load(connection, join_cases.N1_TABLES, [("n1_users", users), ("n1_orders", orders)])
        environment = collect_environment(
            started=started, purpose="join", validation=args.smoke,
            config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None, "password": None},
            conditions={"schema": SCHEMA, "load_s": load_s, "n1_sizes": sizes,
                        "results": [q.__dict__ for q in join_cases.RESULT_QUERIES],
                        "algo": [c.__dict__ for c in join_cases.ALGO_CASES],
                        "n1": [v.__dict__ for v in join_cases.N1_VARIANTS]},
            experiment_dir=EXPERIMENT_DIR,
            sources=[Path(__file__), Path(join_cases.__file__), REPO_DIR / "tools" / "lab_env.py"],
        )
        environment["databases"] = {"mysql": dict(zip(SERVER_VARIABLES, all_rows(
            connection, "SELECT " + ", ".join(f"@@global.{name}" for name in SERVER_VARIABLES))[0]))}
        environment["docker_images"] = command_info(
            ["docker", "compose", "-f", str(REPO_DIR / "infra" / "compose.yaml"), "images"])
        with env_path.open("x", encoding="utf-8") as stream:
            json.dump(environment, stream, ensure_ascii=False, indent=2, default=str)
            stream.write("\n")
        print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
        rows = []
        with result_path.open("x", encoding="utf-8") as stream:
            for run in range(args.trials + 1):
                for part in args.parts:
                    if part == "results":
                        measured = run_results(connection, run)
                    elif part == "algo":
                        measured = run_algo(connection, run, skip_slow=args.smoke)
                    else:
                        measured = run_n1(connection, run, sizes)
                    for position, row in enumerate(measured):
                        row = {"lang": "python", "runtime": f"cpython-{version}", "model": "single-session",
                               "workers": 1, "part": part, **row, "db": "mysql", "run_id": run_id,
                               "environment_file": env_path.name, "run": run, "order_index": position,
                               "validation": args.smoke}
                        stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                        stream.flush()
                        rows.append(row)
                        if not row["valid"]:
                            print(f"검증 실패: {part} {row['variant']} {row['check']} != {row['expected_check']}",
                                  file=sys.stderr)
                    print(f"run {run} {part} 끝", file=sys.stderr)
        if args.smoke:
            print("작은 입력의 실행·저장 검증 완료. 가설 판단에 쓰지 않는다.", file=sys.stderr)
        summarize(rows)
        return 0 if all(row["valid"] for row in rows) else 1
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
