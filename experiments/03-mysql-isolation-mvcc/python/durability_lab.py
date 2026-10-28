# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3", "psycopg[binary]==3.3.6"]
# ///
"""커밋을 디스크에 언제 내리는지 정하는 설정에 따라, 한 줄씩 INSERT하고 커밋하는 처리량과 지연을 잰다."""

import argparse
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from datetime import datetime
import json
import math
from pathlib import Path
import platform
import re
import statistics
import sys
from time import perf_counter
from zoneinfo import ZoneInfo

from isolation_lab import EXPERIMENT_DIR, REPO_DIR, MySQL, Postgres, error_info, positive_int

sys.path.insert(0, str(REPO_DIR / "tools"))
from lab_env import collect_environment, command_info  # noqa: E402

INSERTS = 3000  # 조건마다 재는 자동 커밋 INSERT 횟수
SMOKE_INSERTS = 100
WARMUP_INSERTS = 200  # 설정을 바꾼 뒤 재기 전에 먼저 넣고 버리는 수
PROBE_WRITES = 500  # 디스크 동기 쓰기 기준을 잴 때 dd가 쓰는 횟수
PROBE_BLOCK = "8k"
COMPOSE = REPO_DIR / "infra" / "compose.yaml"

INSERT_EVENT = "INSERT INTO events (payload) VALUES ('order paid')"
SETUP_BY_DB = {
    "mysql": (
        "DROP TABLE IF EXISTS events",
        "CREATE TABLE events (id BIGINT AUTO_INCREMENT PRIMARY KEY, payload VARCHAR(64) NOT NULL)",
    ),
    "postgres": (
        "DROP TABLE IF EXISTS events",
        "CREATE TABLE events (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payload VARCHAR(64) NOT NULL)",
    ),
}
# MySQL의 두 설정은 서버 전체(GLOBAL)에만 걸 수 있어 재는 동안 바꾸고 끝나면 처음 값으로 되돌린다.
# PostgreSQL의 synchronous_commit은 재는 연결에만 건다.
GLOBAL_NAMES = ("innodb_flush_log_at_trx_commit", "sync_binlog")
DEFAULT_SETTING = {"mysql": "flush1-binlog1", "postgres": "sync-on"}  # 요약에서 배수를 셀 기준


@dataclass(frozen=True)
class Setting:
    name: str
    db: str
    title: str
    values: tuple[tuple[str, str], ...]  # (설정 이름, 값)


SETTINGS = {setting.name: setting for setting in (
    Setting("flush1-binlog1", "mysql", "innodb_flush_log_at_trx_commit=1, sync_binlog=1 (기본값)",
            (("innodb_flush_log_at_trx_commit", "1"), ("sync_binlog", "1"))),
    Setting("flush2-binlog1", "mysql", "innodb_flush_log_at_trx_commit=2, sync_binlog=1",
            (("innodb_flush_log_at_trx_commit", "2"), ("sync_binlog", "1"))),
    Setting("flush1-binlog0", "mysql", "innodb_flush_log_at_trx_commit=1, sync_binlog=0",
            (("innodb_flush_log_at_trx_commit", "1"), ("sync_binlog", "0"))),
    Setting("flush2-binlog0", "mysql", "innodb_flush_log_at_trx_commit=2, sync_binlog=0",
            (("innodb_flush_log_at_trx_commit", "2"), ("sync_binlog", "0"))),
    Setting("sync-on", "postgres", "synchronous_commit=on (기본값)", (("synchronous_commit", "on"),)),
    Setting("sync-off", "postgres", "synchronous_commit=off", (("synchronous_commit", "off"),)),
)}

DD_SECONDS = re.compile(r"copied, ([\d.]+) s")


def percentile(samples: list[float], fraction: float) -> float:
    # 가장 가까운 순위 방식. 표본에서 실제로 잰 값 하나를 돌려준다.
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def dd_seconds(output: str) -> float:
    match = DD_SECONDS.search(output)
    if match is None:
        raise ValueError("dd 출력에서 걸린 시간을 찾지 못했다.")
    return float(match.group(1))


def read_globals(driver) -> dict[str, str]:
    session = driver.connect()
    try:
        row = session.execute("SELECT " + ", ".join(f"@@global.{name}" for name in GLOBAL_NAMES))["rows"][0]
        return {name: str(value) for name, value in zip(GLOBAL_NAMES, row)}
    finally:
        session.close()


def set_globals(driver, values) -> None:
    driver.reset(tuple(f"SET GLOBAL {name} = {int(value)}" for name, value in dict(values).items()))


@contextmanager
def globals_restored(driver):
    # 중간에 실패해도 MySQL 서버 설정을 처음 값으로 되돌린다.
    original = read_globals(driver)
    try:
        yield original
    finally:
        set_globals(driver, original)


def data_directory(driver) -> str:
    session = driver.connect()
    try:
        sql = "SELECT @@datadir" if driver.name == "mysql" else "SHOW data_directory"
        return session.execute(sql)["rows"][0][0].rstrip("/")
    finally:
        session.close()


def probe_sync_writes(service: str, directory: str, writes: int = PROBE_WRITES) -> dict:
    # DB 데이터와 같은 볼륨에 동기 쓰기(dd oflag=dsync)를 writes번 해서 커밋 한 번이 기다릴 디스크 동기화의 기준을 잰다.
    path = f"{directory}/sync-probe"
    command = ["docker", "compose", "-f", str(COMPOSE), "exec", "-T", service, "sh", "-c",
               f"dd if=/dev/zero of={path} bs={PROBE_BLOCK} count={writes} oflag=dsync 2>&1; rm -f {path}"]
    result = command_info(command)
    try:
        seconds = dd_seconds(result.get("stdout", ""))
    except ValueError:
        return {"writes": writes, "block": PROBE_BLOCK, "ms_per_write": None, "raw": result}
    return {"writes": writes, "block": PROBE_BLOCK, "ms_per_write": seconds / writes * 1000, "raw": result}


def applied_values(session, setting: Setting) -> dict[str, str]:
    if setting.db == "mysql":
        names = [name for name, _ in setting.values]
        row = session.execute("SELECT " + ", ".join(f"@@global.{name}" for name in names))["rows"][0]
        return {name: str(value) for name, value in zip(names, row)}
    return {name: str(session.execute(f"SHOW {name}")["rows"][0][0]) for name, _ in setting.values}


def run_setting(setting: Setting, driver, inserts: int, *, warmup: int = WARMUP_INSERTS) -> dict:
    driver.reset(SETUP_BY_DB[driver.name])
    if driver.name == "mysql":
        set_globals(driver, setting.values)
    session = driver.connect()
    try:
        if driver.name == "postgres":
            for name, value in setting.values:
                session.execute(f"SET {name} = {value}")
        applied = applied_values(session, setting)
        for _ in range(warmup):
            session.execute(INSERT_EVENT)
        samples = []
        started = perf_counter()
        for _ in range(inserts):
            began = perf_counter()
            session.execute(INSERT_EVENT)
            samples.append((perf_counter() - began) * 1000)
        total_s = perf_counter() - started
        rows = session.execute("SELECT COUNT(*) FROM events")["rows"][0][0]
    finally:
        session.close()
    # 바라던 설정이 실제로 걸렸고 넣은 수만큼 행이 있어야 제대로 돈 실행으로 본다.
    valid = applied == dict(setting.values) and rows == warmup + inserts
    return {
        "check": rows - warmup, "expected_check": inserts, "valid": valid, "setting": setting.name,
        "values": dict(setting.values), "applied": applied, "warmup": warmup, "total_s": total_s,
        "inserts_per_s": inserts / total_s,
        "latency_ms": {"p50": percentile(samples, 0.5), "p90": percentile(samples, 0.9),
                       "p99": percentile(samples, 0.99), "max": max(samples), "mean": statistics.fmean(samples)},
    }


def print_summary(rows: list[dict], probes: dict) -> None:
    for db in ("mysql", "postgres"):
        samples_by_setting = {name: [r for r in rows if r["setting"] == name and r["run"] > 0]
                              for name, setting in SETTINGS.items() if setting.db == db}
        samples_by_setting = {name: samples for name, samples in samples_by_setting.items() if samples}
        if not samples_by_setting:
            continue
        probe = probes.get(db, {}).get("ms_per_write")
        probe_text = f"{probe:.3f} ms" if probe is not None else "잴 수 없음"
        print(f"\n{db} · 같은 볼륨에 {PROBE_BLOCK} 동기 쓰기 한 번: {probe_text}", file=sys.stderr)
        default = samples_by_setting.get(DEFAULT_SETTING[db])
        base = statistics.median(r["inserts_per_s"] for r in default) if default else None
        for name, samples in samples_by_setting.items():
            rate = statistics.median(r["inserts_per_s"] for r in samples)
            p50 = statistics.median(r["latency_ms"]["p50"] for r in samples)
            p99 = statistics.median(r["latency_ms"]["p99"] for r in samples)
            ratio = f" (기본값의 {rate / base:.2f}배)" if base else ""
            print(f"  {SETTINGS[name].title}: 초당 {rate:.0f}건{ratio}, "
                  f"지연 p50 {p50:.3f} ms, p99 {p99:.3f} ms · {len(samples)}회", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", nargs="+", choices=SETTINGS, default=list(SETTINGS))
    parser.add_argument("--dbs", nargs="+", choices=("mysql", "postgres"), default=["mysql", "postgres"])
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--inserts", type=positive_int, help=f"조건마다 재는 INSERT 횟수(기본 {INSERTS})")
    parser.add_argument("--mysql", default="127.0.0.1:13306", help="MySQL 주소(호스트:포트)")
    parser.add_argument("--postgres", default="127.0.0.1:15432", help="PostgreSQL 주소(호스트:포트)")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true",
                        help=f"조건마다 워밍업 1회와 검증 2회만, INSERT {SMOKE_INSERTS}번으로 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if args.smoke:
        args.trials = 2
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    if args.inserts is None:
        args.inserts = SMOKE_INSERTS if args.smoke else INSERTS
    return args


def main() -> int:
    args = parse_args()
    drivers = {"mysql": MySQL(args.mysql), "postgres": Postgres(args.postgres)}
    cases = [SETTINGS[name] for name in args.settings if SETTINGS[name].db in args.dbs]
    if not cases:
        print("고른 설정과 DB에 맞는 조건이 없다.", file=sys.stderr)
        return 1
    used = sorted({setting.db for setting in cases})
    try:
        servers = {db: drivers[db].server_info() for db in used}
        directories = {db: data_directory(drivers[db]) for db in used}
    except Exception as error:
        print(f"DB에 붙지 못했다({error_info(error)['message']}). infra/compose.yaml로 띄웠는지 확인한다.",
              file=sys.stderr)
        return 1
    probes = {db: probe_sync_writes(db, directories[db]) for db in used}
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-durability" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(
        started=started, purpose="durability", validation=args.smoke,
        config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None},
        conditions={"inserts": args.inserts, "warmup": WARMUP_INSERTS, "probe_writes": PROBE_WRITES,
                    "probe_block": PROBE_BLOCK},
        experiment_dir=EXPERIMENT_DIR,
        sources=[Path(__file__), Path(__file__).with_name("isolation_lab.py"), REPO_DIR / "tools" / "lab_env.py"],
    )
    environment["databases"] = servers
    environment["data_directories"] = directories
    environment["sync_write_probe"] = probes
    environment["docker_images"] = command_info(["docker", "compose", "-f", str(COMPOSE), "images"])
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2, default=str)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    rows = []
    with result_path.open("x", encoding="utf-8") as stream, \
            (globals_restored(drivers["mysql"]) if "mysql" in used else nullcontext()):
        for run in range(args.trials + 1):
            order = cases if run % 2 == 0 else list(reversed(cases))
            for position, setting in enumerate(order):
                try:
                    row = run_setting(setting, drivers[setting.db], args.inserts,
                                      warmup=min(WARMUP_INSERTS, args.inserts))
                except Exception as error:
                    print(f"실행 실패({setting.name}): {error_info(error)['message']}", file=sys.stderr)
                    return 1
                row.update(
                    lang="python", runtime=f"cpython-{version}", variant=f"db={setting.db};setting={setting.name}",
                    model="one-connection-autocommit", workers=1, task="durability", size=args.inserts,
                    params={"inserts": args.inserts, "warmup": row["warmup"]},
                    db=setting.db, db_version=servers[setting.db].get("version")
                    or servers[setting.db].get("server_version"),
                    run_id=run_id, environment_file=env_path.name, run=run, order_index=position,
                    validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                stream.flush()
                rows.append(row)
                print(f"{run}회 {setting.name}: 초당 {row['inserts_per_s']:.0f}건", file=sys.stderr)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({setting.name}). applied와 check를 확인한다.", file=sys.stderr)
                    return 1
    if args.smoke:
        print("작은 입력의 실행·저장 검증 완료. 가설 판단에 쓰지 않는다.", file=sys.stderr)
    print_summary(rows, probes)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
