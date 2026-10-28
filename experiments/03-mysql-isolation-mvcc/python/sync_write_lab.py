# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3", "psycopg[binary]==3.3.6"]
# ///
"""DB 데이터와 같은 볼륨에서 파일 끝에 이어 쓰는 동기 쓰기와 미리 만든 파일을 덮어쓰는 동기 쓰기의 한 번 시간을 비교한다."""

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

from durability_lab import COMPOSE, PROBE_BLOCK, data_directory, dd_seconds
from isolation_lab import EXPERIMENT_DIR, REPO_DIR, MySQL, Postgres, error_info, positive_int

sys.path.insert(0, str(REPO_DIR / "tools"))
from lab_env import collect_environment, command_info  # noqa: E402

WRITES = 500  # 조건마다 dd가 동기 쓰기를 하는 횟수
SMOKE_WRITES = 50
BLOCK_BYTES = 8192  # PROBE_BLOCK(8k)의 바이트 수
MODES = ("append", "overwrite")
DD_BYTES = re.compile(r"(\d+) bytes")


def dd_bytes(output: str) -> int:
    match = DD_BYTES.search(output)
    if match is None:
        raise ValueError("dd 출력에서 쓴 바이트 수를 찾지 못했다.")
    return int(match.group(1))


def mode_commands(directory: str, mode: str, writes: int) -> tuple[str, str]:
    # 준비 명령과 재는 명령. 재는 명령만 시간을 읽는다.
    path = f"{directory}/sync-write-{mode}"
    if mode == "append":
        # 새 파일 끝에 이어 쓴다. 쓸 때마다 파일 크기가 커진다(durability_lab.py의 디스크 기준과 같은 방식).
        return f"rm -f {path}", f"dd if=/dev/zero of={path} bs={PROBE_BLOCK} count={writes} oflag=dsync 2>&1"
    if mode == "overwrite":
        # 같은 크기의 파일을 먼저 만들어 디스크에 내려 두고, 그 자리를 처음부터 덮어쓴다. 파일 크기는 그대로다.
        return (f"rm -f {path} && dd if=/dev/zero of={path} bs={PROBE_BLOCK} count={writes} conv=fsync 2>/dev/null",
                f"dd if=/dev/zero of={path} bs={PROBE_BLOCK} count={writes} oflag=dsync conv=notrunc 2>&1")
    raise ValueError(f"모르는 방식: {mode}")


def compose_exec(service: str, script: str) -> dict:
    return command_info(["docker", "compose", "-f", str(COMPOSE), "exec", "-T", service, "sh", "-c", script])


def run_mode(service: str, directory: str, mode: str, writes: int) -> dict:
    prepare, measure = mode_commands(directory, mode, writes)
    prepared = compose_exec(service, prepare)
    started = perf_counter()
    result = compose_exec(service, measure)
    wall_s = perf_counter() - started
    compose_exec(service, f"rm -f {directory}/sync-write-{mode}")
    output = result.get("stdout", "")
    try:
        seconds, written = dd_seconds(output), dd_bytes(output)
    except ValueError:
        seconds, written = None, None
    expected = writes * BLOCK_BYTES
    return {
        "mode": mode, "prepare": prepared, "raw": result, "wall_s": wall_s,
        "dd_s": seconds, "ms_per_write": seconds / writes * 1000 if seconds is not None else None,
        "check": written, "expected_check": expected,
        "valid": prepared.get("returncode") == 0 and result.get("returncode") == 0 and written == expected,
    }


def print_summary(rows: list[dict]) -> None:
    for db in ("mysql", "postgres"):
        medians = {}
        for mode in MODES:
            samples = [r["ms_per_write"] for r in rows if r["db"] == db and r["mode"] == mode and r["run"] > 0]
            if samples:
                medians[mode] = statistics.median(samples)
                print(f"{db} · {mode}: 한 번 {medians[mode]:.3f} ms [{min(samples):.3f}~{max(samples):.3f}] · "
                      f"{len(samples)}회", file=sys.stderr)
        if len(medians) == 2:
            print(f"{db} · 덮어쓰기 / 이어 쓰기 = {medians['overwrite'] / medians['append']:.2f}배", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dbs", nargs="+", choices=("mysql", "postgres"), default=["mysql", "postgres"])
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--writes", type=positive_int, help=f"조건마다 동기 쓰기 횟수(기본 {WRITES})")
    parser.add_argument("--mysql", default="127.0.0.1:13306", help="MySQL 주소(호스트:포트)")
    parser.add_argument("--postgres", default="127.0.0.1:15432", help="PostgreSQL 주소(호스트:포트)")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true",
                        help=f"조건마다 워밍업 1회와 검증 2회만, 동기 쓰기 {SMOKE_WRITES}번으로 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if args.smoke:
        args.trials = 2
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    if args.writes is None:
        args.writes = SMOKE_WRITES if args.smoke else WRITES
    return args


def main() -> int:
    args = parse_args()
    drivers = {"mysql": MySQL(args.mysql), "postgres": Postgres(args.postgres)}
    try:
        servers = {db: drivers[db].server_info() for db in args.dbs}
        directories = {db: data_directory(drivers[db]) for db in args.dbs}
    except Exception as error:
        print(f"DB에 붙지 못했다({error_info(error)['message']}). infra/compose.yaml로 띄웠는지 확인한다.",
              file=sys.stderr)
        return 1
    cases = [(db, mode) for db in args.dbs for mode in MODES]
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-sync-write" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(
        started=started, purpose="sync-write", validation=args.smoke,
        config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None},
        conditions={"writes": args.writes, "block": PROBE_BLOCK, "modes": list(MODES)},
        experiment_dir=EXPERIMENT_DIR,
        sources=[Path(__file__), Path(__file__).with_name("durability_lab.py"), REPO_DIR / "tools" / "lab_env.py"],
    )
    environment["databases"] = servers
    environment["data_directories"] = directories
    environment["filesystems"] = {db: compose_exec(db, f"df -T {directories[db]}") for db in args.dbs}
    environment["docker_images"] = command_info(["docker", "compose", "-f", str(COMPOSE), "images"])
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2, default=str)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    rows = []
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.trials + 1):
            order = cases if run % 2 == 0 else list(reversed(cases))
            for position, (db, mode) in enumerate(order):
                row = run_mode(db, directories[db], mode, args.writes)
                row.update(
                    lang="python", runtime=f"cpython-{version}", variant=f"db={db};mode={mode}",
                    model="dd-oflag-dsync", workers=1, task="sync-write", size=args.writes,
                    params={"writes": args.writes, "block": PROBE_BLOCK},
                    db=db, db_version=servers[db].get("version") or servers[db].get("server_version"),
                    run_id=run_id, environment_file=env_path.name, run=run, order_index=position,
                    validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                stream.flush()
                rows.append(row)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({db} {mode}). raw와 check를 확인한다.", file=sys.stderr)
                    return 1
                print(f"{run}회 {db} {mode}: 한 번 {row['ms_per_write']:.3f} ms", file=sys.stderr)
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
