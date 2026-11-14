# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3"]
# ///
"""쓰기 비용을 잰다. 묶음 ③은 보조 인덱스 수에 따른 INSERT 10만 건, 묶음 ④는 기본 키 종류에 따른 INSERT 100만 건이다.

③ 조건마다 orders(100만 행)를 orders_w로 복사하고 조건의 보조 인덱스를 만든 뒤, orders_data.more_rows()의 10만 행을
   5,000행씩 넣으며 배치마다 커밋한다. 넣는 구간의 경과 시간과 페이지 분할 수를 남기고 표를 지운다.
④ 조건마다 기본 키만 다른 빈 orders_pk(보조 인덱스는 idx_user 하나)를 만들고 orders_data.rows()의 100만 행을 같은 방식으로
   넣는다. 경과 시간, 페이지 분할 수, ANALYZE 뒤 인덱스별 페이지 수·리프 수와 파일 크기를 남기고 표를 지운다.
넣을 행은 시간을 재기 전에 모두 만들어 두므로 경과 시간에 행 생성은 들지 않는다(PyMySQL이 INSERT 문을 만드는 시간은 든다).
"""

import argparse
from datetime import datetime
import json
from pathlib import Path
import platform
import random
import sys
from time import perf_counter
from zoneinfo import ZoneInfo

EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EXPERIMENT_DIR.parent.parent
sys.path.insert(0, str(REPO_DIR / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lab_env import collect_environment, command_info  # noqa: E402
import index_lab  # noqa: E402
import orders_data  # noqa: E402

BATCH = 5000
COLUMNS = orders_data.COLUMNS
# ③ 보조 인덱스 0·3·6개. 3개는 ①②에서 쓴 단일 칼럼 셋, 6개는 거기에 셋을 더한다.
INDEX_SETS = {
    "idx-0": (),
    "idx-3": ("CREATE INDEX idx_user ON orders_w (user_id)",
              "CREATE INDEX idx_created ON orders_w (created_at)",
              "CREATE INDEX idx_phone ON orders_w (phone)"),
}
INDEX_SETS["idx-6"] = INDEX_SETS["idx-3"] + ("CREATE INDEX idx_status ON orders_w (status)",
                                             "CREATE INDEX idx_user_created ON orders_w (user_id, created_at)",
                                             "CREATE INDEX idx_amount ON orders_w (amount)")
# ④ 기본 키 셋. UUID 둘은 BINARY(16)로 둔다.
PK_TYPES = {
    "pk-auto": "BIGINT PRIMARY KEY AUTO_INCREMENT",
    "pk-uuid4": "BINARY(16) PRIMARY KEY",
    "pk-uuid7": "BINARY(16) PRIMARY KEY",
}
PK_TABLE = """CREATE TABLE orders_pk (
  id         {pk},
  user_id    INT         NOT NULL,
  status     VARCHAR(10) NOT NULL,
  amount     INT         NOT NULL,
  phone      VARCHAR(20) NOT NULL,
  memo       TEXT        NOT NULL,
  created_at DATETIME    NOT NULL,
  KEY idx_user (user_id)
) ENGINE=InnoDB"""
METRICS = ("index_page_splits", "index_page_merge_attempts", "index_page_merge_successful",
           "index_page_reorg_attempts", "index_page_discards")
STATUS = ("Innodb_os_log_written", "Innodb_data_written", "Innodb_pages_written", "Innodb_buffer_pool_reads")


def pk_rows(kind: str, count: int, seed: int = orders_data.SEED) -> list[tuple]:
    """④에 넣을 행. pk-auto는 id 없이, UUID 둘은 orders_data.rows()의 id 자리에 16바이트 값을 넣는다."""
    rng = random.Random(seed * 1000 + 7)
    out = []
    for row in orders_data.rows(count=count, heavy_rows=orders_data.HEAVY_ROWS * count // orders_data.ROWS):
        if kind == "pk-auto":
            out.append(row[1:])
        elif kind == "pk-uuid4":
            out.append((orders_data.uuid4_bytes(rng),) + row[1:])
        elif kind == "pk-uuid7":
            out.append((orders_data.uuid7_bytes(row[6], rng),) + row[1:])
        else:
            raise ValueError(kind)
    return out


def rotated(names: list[str], run: int) -> list[str]:
    """반복마다 조건 순서를 하나씩 돌린다."""
    shift = run % len(names)
    return names[shift:] + names[:shift]


def metrics(connection) -> dict:
    rows = index_lab.all_rows(connection, "SELECT NAME, COUNT FROM information_schema.INNODB_METRICS WHERE NAME IN ("
                              + ", ".join(["%s"] * len(METRICS)) + ")", METRICS)
    return {name: int(value) for name, value in rows}


def counters(connection) -> dict:
    return {**metrics(connection), **index_lab.global_status(connection, STATUS)}


def delta(after: dict, before: dict) -> dict:
    return {name: after[name] - before.get(name, 0) for name in after}


def insert_all(connection, table: str, columns: tuple[str, ...], rows: list[tuple]) -> tuple[float, int]:
    sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))})"
    started = perf_counter()
    batches = 0
    with connection.cursor() as cursor:
        for start in range(0, len(rows), BATCH):
            connection.begin()  # 배치 하나를 트랜잭션 하나로(PyMySQL이 문장을 여럿으로 나눠도 커밋은 한 번)
            cursor.executemany(sql, rows[start:start + BATCH])
            connection.commit()
            batches += 1
    return perf_counter() - started, batches


def sizes(connection, table: str) -> dict:
    with connection.cursor() as cursor:
        cursor.execute(f"ANALYZE TABLE {table}")
        cursor.fetchall()
        cursor.execute("SET SESSION information_schema_stats_expiry = 0")
    stats: dict[str, dict] = {}
    for name, stat, value in index_lab.all_rows(
            connection, "SELECT index_name, stat_name, stat_value FROM mysql.innodb_index_stats "
                        "WHERE database_name = %s AND table_name = %s AND stat_name IN ('size', 'n_leaf_pages')",
            (index_lab.SCHEMA, table)):
        stats.setdefault(name, {})[stat] = int(value)
    data_length, index_length = index_lab.all_rows(
        connection, "SELECT DATA_LENGTH, INDEX_LENGTH FROM information_schema.TABLES WHERE table_schema = %s "
                    "AND table_name = %s", (index_lab.SCHEMA, table))[0]
    file_size, allocated = index_lab.all_rows(
        connection, "SELECT FILE_SIZE, ALLOCATED_SIZE FROM information_schema.INNODB_TABLESPACES WHERE NAME = %s",
        (f"{index_lab.SCHEMA}/{table}",))[0]
    return {"index_pages": stats, "data_length": int(data_length), "index_length": int(index_length),
            "file_size": int(file_size), "allocated_size": int(allocated)}


def run_indexes(connection, name: str, more: list[tuple]) -> dict:
    """③ 한 번: 복사, 인덱스 만들기, 10만 행 넣기, 확인, 지우기."""
    create = orders_data.CREATE_TABLE.replace("CREATE TABLE orders", "CREATE TABLE orders_w", 1)
    with connection.cursor() as cursor:
        cursor.execute("DROP TABLE IF EXISTS orders_w")
        cursor.execute(create)
        started = perf_counter()
        cursor.execute("INSERT INTO orders_w SELECT * FROM orders")
        copy_s = perf_counter() - started
        started = perf_counter()
        for ddl in INDEX_SETS[name]:
            cursor.execute(ddl)
        build_s = perf_counter() - started
        cursor.execute("ANALYZE TABLE orders_w")
        cursor.fetchall()
    before = counters(connection)
    wall_s, batches = insert_all(connection, "orders_w", COLUMNS, more)
    after = counters(connection)
    count = index_lab.scalar(connection, "SELECT COUNT(*) FROM orders_w")
    with connection.cursor() as cursor:
        cursor.execute("DROP TABLE orders_w")
    return {"wall_s": wall_s, "batches": batches, "copy_s": copy_s, "build_s": build_s,
            "counters": delta(after, before), "check": int(count)}


def run_pk(connection, name: str, count: int) -> dict:
    """④ 한 번: 행 만들기(시간 밖), 빈 표 만들기, 100만 행 넣기, 크기 재기, 확인, 지우기."""
    columns = COLUMNS[1:] if name == "pk-auto" else COLUMNS
    rows = pk_rows(name, count)
    with connection.cursor() as cursor:
        cursor.execute("DROP TABLE IF EXISTS orders_pk")
        cursor.execute(PK_TABLE.format(pk=PK_TYPES[name]))
    before = counters(connection)
    wall_s, batches = insert_all(connection, "orders_pk", columns, rows)
    after = counters(connection)
    measured = sizes(connection, "orders_pk")
    count = index_lab.scalar(connection, "SELECT COUNT(*) FROM orders_pk")
    with connection.cursor() as cursor:
        cursor.execute("DROP TABLE orders_pk")
    return {"wall_s": wall_s, "batches": batches, "counters": delta(after, before), "sizes": measured,
            "check": int(count)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parts", nargs="+", choices=("indexes", "pk"), default=["indexes", "pk"])
    parser.add_argument("--trials", type=index_lab.positive_int, default=3)
    parser.add_argument("--mysql", default="127.0.0.1:13306", help="MySQL 주소(호스트:포트)")
    parser.add_argument("--password", default="", help="root 비밀번호(infra/compose.yaml은 없음)")
    parser.add_argument("--buffer-pool-mb", type=index_lab.positive_int, default=index_lab.BUFFER_POOL_MB)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="작은 입력(③ 5,000행, ④ 2만 행)으로 워밍업 1회와 검증 2회")
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
    server = index_lab.Server(args.mysql, args.password)
    try:
        connection = server.connect()
    except Exception as error:
        print(f"DB에 붙지 못했다({error}). infra/compose.yaml로 띄웠는지 확인한다.", file=sys.stderr)
        return 1
    more_count = 5_000 if args.smoke else orders_data.MORE_ROWS
    pk_count = 20_000 if args.smoke else orders_data.ROWS
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-write" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    original_pool = int(index_lab.scalar(connection, "SELECT @@global.innodb_buffer_pool_size"))
    enabled_before = {name: status for name, status in index_lab.all_rows(
        connection, "SELECT NAME, STATUS FROM information_schema.INNODB_METRICS WHERE NAME IN ("
                    + ", ".join(["%s"] * len(METRICS)) + ")", METRICS)}
    try:
        applied_pool = index_lab.set_buffer_pool(connection, args.buffer_pool_mb * 1024 * 1024)
        with connection.cursor() as cursor:
            for name in METRICS:
                cursor.execute("SET GLOBAL innodb_monitor_enable = %s", (name,))
        found = index_lab.table_fingerprint(connection) if "indexes" in args.parts else None
        if "indexes" in args.parts and found != index_lab.expected_fingerprint():
            print("orders 표가 기대와 다르다. index_lab.py로 먼저 넣는다(--reload).", file=sys.stderr)
            return 1
        environment = collect_environment(
            started=started, purpose="write", validation=args.smoke,
            config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None, "password": None},
            conditions={"seed": orders_data.SEED, "batch_rows": BATCH, "more_rows": more_count, "pk_rows": pk_count,
                        "buffer_pool_bytes": applied_pool, "original_buffer_pool_bytes": original_pool,
                        "base_fingerprint": found, "index_sets": INDEX_SETS, "pk_types": PK_TYPES,
                        "pk_table": PK_TABLE, "metrics": METRICS},
            experiment_dir=EXPERIMENT_DIR,
            sources=[Path(__file__), Path(index_lab.__file__), Path(orders_data.__file__),
                     REPO_DIR / "tools" / "lab_env.py"],
        )
        environment["databases"] = {"mysql": index_lab.server_info(connection)}
        environment["docker_images"] = command_info(
            ["docker", "compose", "-f", str(REPO_DIR / "infra" / "compose.yaml"), "images"])
        with env_path.open("x", encoding="utf-8") as stream:
            json.dump(environment, stream, ensure_ascii=False, indent=2, default=str)
            stream.write("\n")
        print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
        plans = []
        if "indexes" in args.parts:
            more = list(orders_data.more_rows(count=more_count))
            plans.append(("indexes", list(INDEX_SETS), lambda name: run_indexes(connection, name, more),
                          "insert-more-rows", more_count, lambda name: {"ddl": INDEX_SETS[name]},
                          orders_data.ROWS + more_count))
        if "pk" in args.parts:
            plans.append(("pk", list(PK_TYPES), lambda name: run_pk(connection, name, pk_count),
                          "insert-pk", pk_count, lambda name: {"pk": PK_TYPES[name], "table": PK_TABLE},
                          pk_count))
        rows = []
        with result_path.open("x", encoding="utf-8") as stream:
            for part, names, runner, task, size, params, expected in plans:
                for run in range(args.trials + 1):
                    for position, name in enumerate(rotated(names, run)):
                        print(f"{part} {name} run {run}", file=sys.stderr)
                        measured = runner(name)
                        valid = measured["check"] == expected
                        row = {
                            "lang": "python", "runtime": f"cpython-{version}", "variant": name,
                            "model": "single-session", "workers": 1, "task": task, "size": size,
                            "params": {**params(name), "batch_rows": BATCH}, "part": part,
                            "run": run, "wall_s": measured["wall_s"], "check": measured["check"],
                            "expected_check": expected, "valid": valid, "measure": measured, "db": "mysql",
                            "run_id": run_id, "environment_file": env_path.name, "order_index": position,
                            "validation": args.smoke,
                        }
                        stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                        stream.flush()
                        rows.append(row)
                        if not valid:
                            print(f"행 수가 다르다({name}): {measured['check']} != {expected}", file=sys.stderr)
                            return 1
        if args.smoke:
            print("작은 입력의 실행·저장 검증 완료. 가설 판단에 쓰지 않는다.", file=sys.stderr)
        print_summary(rows)
        return 0
    finally:
        try:
            with connection.cursor() as cursor:
                for name, status in enabled_before.items():
                    if status != "enabled":
                        cursor.execute("SET GLOBAL innodb_monitor_disable = %s", (name,))
            index_lab.set_buffer_pool(connection, original_pool)
        finally:
            connection.close()


def print_summary(rows: list[dict]) -> None:
    for key in dict.fromkeys((r["part"], r["variant"]) for r in rows):
        samples = sorted((r for r in rows if (r["part"], r["variant"]) == key and r["run"] > 0),
                         key=lambda r: r["wall_s"])
        if not samples:
            continue
        middle = samples[len(samples) // 2]
        splits = middle["measure"]["counters"].get("index_page_splits")
        line = (f"{key[0]} {key[1]}: 중앙값 {middle['wall_s']:.2f}s ({samples[0]['wall_s']:.2f}~{samples[-1]['wall_s']:.2f})"
                f" · 페이지 분할 {splits}")
        if "sizes" in middle["measure"]:
            pages = middle["measure"]["sizes"]["index_pages"]
            line += " · " + ", ".join(f"{name} {stat.get('size')}쪽/리프 {stat.get('n_leaf_pages')}"
                                      for name, stat in pages.items())
            line += f" · 파일 {middle['measure']['sizes']['file_size'] / 2**20:.1f}MiB"
        print(line, file=sys.stderr)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
