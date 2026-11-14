# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3"]
# ///
"""100만 행 orders 표에서 보조 인덱스 조건마다 같은 쿼리의 실행 계획과 걸린 시간, 읽은 행 수를 잰다.

조건마다 보조 인덱스를 그 조건의 것만 남기고 ANALYZE TABLE을 한 뒤, 쿼리마다 EXPLAIN(전통 형식과 트리 형식)을 남기고
워밍업 1회와 본 측정 trials회 동안 EXPLAIN ANALYZE의 서버 안 시간과, 쿼리를 그대로 실행한 응답 시간·Handler_read_* 증가분을 잰다.
묶음 ①②에 쓴다. 조건과 쿼리는 index_cases.py에 있다.
"""

import argparse
from datetime import datetime
import json
from pathlib import Path
import platform
import re
import sys
from time import perf_counter, sleep
from zoneinfo import ZoneInfo

EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EXPERIMENT_DIR.parent.parent
sys.path.insert(0, str(REPO_DIR / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lab_env import collect_environment, command_info  # noqa: E402
import index_cases  # noqa: E402
import orders_data  # noqa: E402

SCHEMA = "lab"
BUFFER_POOL_MB = 1024  # 표 전체가 메모리에 올라가도록
LOAD_BATCH = 5000
ACTUAL = re.compile(r"\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.e+]+) loops=(\d+)\)")
ESTIMATE = re.compile(r"\(cost=([\d.e+]+) rows=([\d.e+]+)\)")
SERVER_VARIABLES = ("version", "innodb_buffer_pool_size", "innodb_page_size", "innodb_flush_log_at_trx_commit",
                    "optimizer_switch", "eq_range_index_dive_limit", "innodb_stats_persistent_sample_pages",
                    "sort_buffer_size", "character_set_server", "collation_server")


def parse_analyze(text: str) -> dict:
    """EXPLAIN ANALYZE 첫 줄(맨 위 반복자)의 실제 시간(ms)·행 수·반복 수와 어림 비용·행 수를 뽑는다."""
    first = text.strip().splitlines()[0]
    actual = ACTUAL.search(first)
    estimate = ESTIMATE.search(first)
    return {
        "first_ms": float(actual.group(1)) if actual else None,
        "last_ms": float(actual.group(2)) if actual else None,
        "rows": float(actual.group(3)) if actual else None,
        "loops": int(actual.group(4)) if actual else None,
        "est_cost": float(estimate.group(1)) if estimate else None,
        "est_rows": float(estimate.group(2)) if estimate else None,
        "top": first.strip(),
    }


class Server:
    def __init__(self, address: str, password: str = ""):
        self.host, port = address.rsplit(":", 1)
        self.port = int(port)
        self.password = password

    def connect(self, *, autocommit: bool = True):
        import pymysql

        return pymysql.connect(host=self.host, port=self.port, user="root", password=self.password,
                               database=SCHEMA, autocommit=autocommit, connect_timeout=5, read_timeout=600)


def scalar(connection, sql: str, args=None):
    with connection.cursor() as cursor:
        cursor.execute(sql, args)
        row = cursor.fetchone()
        return None if row is None else row[0]


def all_rows(connection, sql: str, args=None, *, dicts: bool = False):
    import pymysql.cursors

    with connection.cursor(pymysql.cursors.DictCursor if dicts else None) as cursor:
        cursor.execute(sql, args)
        return cursor.fetchall()


def server_info(connection) -> dict:
    return dict(zip(SERVER_VARIABLES, all_rows(
        connection, "SELECT " + ", ".join(f"@@global.{name}" for name in SERVER_VARIABLES))[0]))


def set_buffer_pool(connection, size_bytes: int, wait_s: float = 120) -> int:
    """버퍼 풀 크기를 바꾸고 바뀔 때까지 기다린다. 실제로 걸린 값을 돌려준다(청크 단위로 올림될 수 있음)."""
    if scalar(connection, "SELECT @@global.innodb_buffer_pool_size") != size_bytes:
        with connection.cursor() as cursor:
            cursor.execute("SET GLOBAL innodb_buffer_pool_size = %s", (size_bytes,))
    deadline = perf_counter() + wait_s
    while perf_counter() < deadline:
        code = all_rows(connection, "SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_resize_status_code'")
        if not code or code[0][1] == "0":
            break
        sleep(0.5)
    else:
        raise RuntimeError("버퍼 풀 크기 바꾸기가 끝나지 않았다.")
    return int(scalar(connection, "SELECT @@global.innodb_buffer_pool_size"))


def expected_fingerprint() -> dict:
    count = user_sum = amount_sum = 0
    first = last = None
    for row in orders_data.rows():
        count += 1
        user_sum += row[1]
        amount_sum += row[3]
        first = row[6] if first is None else first
        last = row[6]
    return {"rows": count, "user_sum": user_sum, "amount_sum": amount_sum,
            "first_created": first.isoformat(sep=" "), "last_created": last.isoformat(sep=" ")}


def table_fingerprint(connection) -> dict | None:
    """orders 표의 행 수와 합계. 표가 없거나 컬럼이 다르면(다른 실험이 같은 이름으로 남긴 표) None."""
    columns = tuple(row[0] for row in all_rows(
        connection, "SELECT column_name FROM information_schema.COLUMNS WHERE table_schema = %s "
                    "AND table_name = 'orders' ORDER BY ordinal_position", (SCHEMA,)))
    if columns != orders_data.COLUMNS:
        return None
    count, user_sum, amount_sum, first, last = all_rows(
        connection, "SELECT COUNT(*), SUM(user_id), SUM(amount), MIN(created_at), MAX(created_at) FROM orders")[0]
    return {"rows": int(count), "user_sum": int(user_sum or 0), "amount_sum": int(amount_sum or 0),
            "first_created": first.isoformat(sep=" ") if first else None,
            "last_created": last.isoformat(sep=" ") if last else None}


def load(connection) -> float:
    """orders 표를 새로 만들고 orders_data의 행을 넣는다. 걸린 초를 돌려준다."""
    sql = (f"INSERT INTO orders ({', '.join(orders_data.COLUMNS)}) "
           f"VALUES ({', '.join(['%s'] * len(orders_data.COLUMNS))})")
    started = perf_counter()
    with connection.cursor() as cursor:
        cursor.execute("DROP TABLE IF EXISTS orders")
        cursor.execute(orders_data.CREATE_TABLE)
        batch = []
        for row in orders_data.rows():
            batch.append(row)
            if len(batch) == LOAD_BATCH:
                cursor.executemany(sql, batch)
                connection.commit()
                batch = []
        if batch:
            cursor.executemany(sql, batch)
            connection.commit()
    return perf_counter() - started


def secondary_indexes(connection) -> list[str]:
    return [row[0] for row in all_rows(
        connection, "SELECT DISTINCT index_name FROM information_schema.STATISTICS WHERE table_schema = %s "
                    "AND table_name = 'orders' AND index_name <> 'PRIMARY' ORDER BY index_name", (SCHEMA,))]


def apply_case(connection, case: index_cases.Case) -> dict:
    """보조 인덱스를 모두 지우고 조건의 DDL만 실행한 뒤 통계를 새로 만든다.

    DDL 오류는 오류 번호와 메시지를 남긴다. 오류를 보려는 조건(expect_ddl_error)이 아닌데 오류가 나면 멈춘다.
    """
    import pymysql

    errors = []
    with connection.cursor() as cursor:
        for name in secondary_indexes(connection):
            cursor.execute(f"DROP INDEX `{name}` ON orders")
        started = perf_counter()
        for ddl in case.ddl:
            try:
                cursor.execute(ddl)
            except pymysql.MySQLError as error:
                if not case.expect_ddl_error:
                    raise
                code, message = (error.args + (None, None))[:2]
                errors.append({"ddl": ddl, "code": code, "message": message})
        built_s = perf_counter() - started
        cursor.execute("ANALYZE TABLE orders")
        cursor.fetchall()
    if case.expect_ddl_error and not errors:
        raise RuntimeError(f"{case.name}: DDL 오류를 기대했지만 성공했다.")
    return {"indexes": secondary_indexes(connection), "build_s": built_s, "ddl_errors": errors,
            "index_stats": index_stats(connection)}


def index_stats(connection) -> list[dict]:
    rows = all_rows(connection, "SELECT index_name, stat_name, stat_value FROM mysql.innodb_index_stats "
                                "WHERE database_name = %s AND table_name = 'orders' "
                                "AND stat_name IN ('size', 'n_leaf_pages') ORDER BY index_name, stat_name",
                    (SCHEMA,))
    out: dict[str, dict] = {}
    for name, stat, value in rows:
        out.setdefault(name, {"index": name})[stat] = int(value)
    return list(out.values())


def warm(connection) -> None:
    # 클러스터형 인덱스와 보조 인덱스를 한 번씩 끝까지 읽어 버퍼 풀에 올린다.
    with connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*), SUM(amount) FROM orders FORCE INDEX (PRIMARY)")
        cursor.fetchall()
        for name in secondary_indexes(connection):
            cursor.execute(f"SELECT COUNT(*) FROM orders FORCE INDEX (`{name}`)")
            cursor.fetchall()


def global_status(connection, names: tuple[str, ...]) -> dict:
    rows = all_rows(connection, "SHOW GLOBAL STATUS WHERE Variable_name IN (" + ", ".join(["%s"] * len(names)) + ")",
                    names)
    return {name: int(value) for name, value in rows}


def handler_reads(connection) -> dict:
    return {name: int(value) for name, value in all_rows(connection, "SHOW SESSION STATUS LIKE 'Handler_read%'")}


def measure_query(connection, sql: str) -> dict:
    """EXPLAIN ANALYZE 한 번과 쿼리 그대로 한 번. 버퍼 풀에서 디스크로 읽은 페이지 수도 남긴다."""
    reads = ("Innodb_buffer_pool_reads", "Innodb_buffer_pool_read_requests")
    before = global_status(connection, reads)
    analyze = all_rows(connection, "EXPLAIN ANALYZE " + sql)[0][0]
    with connection.cursor() as cursor:
        cursor.execute("FLUSH STATUS")  # 세션 Handler_read_* 를 0으로
        started = perf_counter()
        cursor.execute(sql)
        result = cursor.fetchall()
        elapsed = perf_counter() - started
    handlers = handler_reads(connection)
    after = global_status(connection, reads)
    return {"analyze": parse_analyze(analyze), "analyze_text": analyze, "client_s": elapsed,
            "result_rows": len(result), "handler_reads": handlers,
            "pool_disk_reads": after["Innodb_buffer_pool_reads"] - before["Innodb_buffer_pool_reads"],
            "pool_read_requests": after["Innodb_buffer_pool_read_requests"]
                                  - before["Innodb_buffer_pool_read_requests"]}


def ms(value: float | None) -> str:
    return "-" if value is None else f"{value:.3f}ms"


def print_summary(rows: list[dict]) -> None:
    keys = dict.fromkeys((r["case"], r["query"]) for r in rows)
    for case, query in keys:
        samples = [r for r in rows if r["case"] == case and r["query"] == query and r["run"] > 0]
        if not samples:
            continue
        plan = samples[0]["explain"][0] if samples[0]["explain"] else {}
        times = sorted(s["measure"]["analyze"]["last_ms"] for s in samples)
        print(f"\n{case} · {query}: type={plan.get('type')} key={plan.get('key')} rows={plan.get('rows')} "
              f"Extra={plan.get('Extra')}", file=sys.stderr)
        print(f"  EXPLAIN ANALYZE {ms(times[0])}~{ms(times[-1])} · 결과 {samples[0]['measure']['result_rows']}행"
              f" · 디스크 읽기 {sum(s['measure']['pool_disk_reads'] for s in samples)}", file=sys.stderr)
        for error in samples[0]["applied"].get("ddl_errors", []):
            print(f"  DDL 오류 {error['code']}: {error['message']}", file=sys.stderr)


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("1 이상의 정수가 필요하다.")
    return number


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", nargs="+", choices=index_cases.CASES, default=list(index_cases.CASES))
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--mysql", default="127.0.0.1:13306", help="MySQL 주소(호스트:포트)")
    parser.add_argument("--password", default="", help="root 비밀번호(infra/compose.yaml은 없음)")
    parser.add_argument("--buffer-pool-mb", type=positive_int, default=BUFFER_POOL_MB)
    parser.add_argument("--reload", action="store_true", help="표가 맞아도 새로 만들고 다시 넣는다")
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
    server = Server(args.mysql, args.password)
    try:
        connection = server.connect()
    except Exception as error:
        print(f"DB에 붙지 못했다({error}). infra/compose.yaml로 띄웠는지 확인한다.", file=sys.stderr)
        return 1
    cases = [index_cases.CASES[name] for name in args.cases]
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-index" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    original_pool = int(scalar(connection, "SELECT @@global.innodb_buffer_pool_size"))
    try:
        applied_pool = set_buffer_pool(connection, args.buffer_pool_mb * 1024 * 1024)
        expected = expected_fingerprint()
        found = table_fingerprint(connection)
        load_s = None
        if args.reload or found != expected:
            print("orders 표를 새로 만들고 100만 행을 넣는다.", file=sys.stderr)
            load_connection = server.connect(autocommit=False)
            try:
                load_s = load(load_connection)
            finally:
                load_connection.close()
            found = table_fingerprint(connection)
            if found != expected:
                print(f"넣은 표가 기대와 다르다: {found} != {expected}", file=sys.stderr)
                return 1
        environment = collect_environment(
            started=started, purpose="index", validation=args.smoke,
            config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None, "password": None},
            conditions={"seed": orders_data.SEED, "rows": orders_data.ROWS, "buffer_pool_bytes": applied_pool,
                        "original_buffer_pool_bytes": original_pool, "load_s": load_s, "fingerprint": found,
                        "cases": {case.name: {"ddl": case.ddl, "author": case.author, "queries": case.queries}
                                  for case in cases},
                        "queries": index_cases.QUERIES},
            experiment_dir=EXPERIMENT_DIR,
            sources=[Path(__file__), Path(index_cases.__file__), Path(orders_data.__file__),
                     REPO_DIR / "tools" / "lab_env.py"],
        )
        environment["databases"] = {"mysql": server_info(connection)}
        environment["docker_images"] = command_info(
            ["docker", "compose", "-f", str(REPO_DIR / "infra" / "compose.yaml"), "images"])
        with env_path.open("x", encoding="utf-8") as stream:
            json.dump(environment, stream, ensure_ascii=False, indent=2, default=str)
            stream.write("\n")
        print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
        rows = []
        with result_path.open("x", encoding="utf-8") as stream:
            for position, case in enumerate(cases):
                applied = apply_case(connection, case)
                warm(connection)
                for query_name in case.queries:
                    sql = index_cases.QUERIES[query_name]
                    explain = all_rows(connection, "EXPLAIN " + sql, dicts=True)
                    # 1003(옵티마이저가 고쳐 쓴 쿼리)과 1739(형변환으로 인덱스를 못 씀) 같은 메모
                    warnings = [list(row) for row in all_rows(connection, "SHOW WARNINGS")]
                    tree = all_rows(connection, "EXPLAIN FORMAT=TREE " + sql)[0][0]
                    for run in range(args.trials + 1):
                        measure = measure_query(connection, sql)
                        valid = measure["analyze"]["last_ms"] is not None
                        row = {
                            "lang": "python", "runtime": f"cpython-{version}", "variant": case.name,
                            "model": "single-session", "workers": 1, "task": query_name,
                            "size": orders_data.ROWS, "params": {"ddl": case.ddl, "author": case.author},
                            "case": case.name, "situation": case.situation, "label": case.label,
                            "query": query_name, "sql": sql, "applied": applied, "explain": explain,
                            "explain_warnings": warnings,
                            "tree": tree, "measure": measure, "check": 1 if valid else 0, "expected_check": 1,
                            "valid": valid, "db": "mysql", "run_id": run_id, "environment_file": env_path.name,
                            "run": run, "order_index": position, "validation": args.smoke,
                        }
                        stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                        stream.flush()
                        rows.append(row)
                        if not valid:
                            print(f"EXPLAIN ANALYZE를 읽지 못했다({case.name}): {measure['analyze_text'][:200]}",
                                  file=sys.stderr)
                            return 1
        if args.smoke:
            print("작은 입력의 실행·저장 검증 완료. 가설 판단에 쓰지 않는다.", file=sys.stderr)
        print_summary(rows)
        return 0
    finally:
        try:
            set_buffer_pool(connection, original_pool)
        finally:
            connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
