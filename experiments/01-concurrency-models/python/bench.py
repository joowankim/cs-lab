# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""CPU·I/O 작업 비교. --smoke는 작은 입력의 기능 검증만 실행한다."""

import argparse
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import resource
import shlex
from statistics import median
import subprocess
import sys
import sysconfig
from time import perf_counter
from zoneinfo import ZoneInfo

from models import MODELS, RUNNERS, WORKERS
from workloads import Job, reference_count, require_gil, run_async_job, run_job


EXPERIMENT_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Case:
    model: str
    n: int | None
    workers: int
    task: str = "cpu"
    sleep_s: float = 0.0


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("1 이상의 정수가 필요하다.")
    return number


def positive_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("0보다 큰 유한한 값이 필요하다.")
    return number


def parse_args(*, compare_gil: bool = False) -> argparse.Namespace:
    description = "같은 free-threaded 빌드에서 GIL 켜짐·꺼짐을 번갈아 비교한다." if compare_gil else __doc__
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--task", choices=("cpu", "io"), default="cpu")
    parser.add_argument("--models", nargs="+", choices=RUNNERS, default=list(MODELS))
    parser.add_argument("--workers", type=positive_int, default=WORKERS)
    parser.add_argument(
        "--compare-workers", nargs="+", type=positive_int, default=[],
        help="기본 작업자 수와 함께 비교할 작업자 수",
    )
    parser.add_argument("--sizes", nargs="+", type=positive_int, help="CPU 작업의 N")
    parser.add_argument("--sleep-s", type=positive_float, help="I/O 작업당 대기 시간")
    parser.add_argument("--tasks", type=positive_int, help="작업 수: CPU 기본 8, I/O 기본 40")
    parser.add_argument("--repeats", type=positive_int, default=3, help="워밍업을 뺀 반복 횟수")
    if not compare_gil:
        parser.add_argument("--expect-gil", choices=("on", "off"), default="on")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="작은 입력, 워밍업 1회와 검증 1회만 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 비교에는 CPython 3.14를 사용한다.")
    if compare_gil and not sysconfig.get_config_var("Py_GIL_DISABLED"):
        parser.error("GIL 켜짐·꺼짐 비교에는 free-threaded 빌드가 필요하다.")
    if not args.models or any(model not in RUNNERS for model in args.models):
        parser.error("models.py의 MODELS 또는 --models를 확인한다.")
    if args.workers < 1:
        parser.error("작업자 수는 1 이상이어야 한다.")
    if args.task == "cpu":
        if args.sleep_s is not None:
            parser.error("--sleep-s는 I/O 작업에만 사용한다.")
        args.sizes = args.sizes or [200_000, 20_000]
        args.sleep_s = 0.0
    else:
        if args.sizes is not None:
            parser.error("--sizes는 CPU 작업에만 사용한다.")
        args.sizes = []
        args.sleep_s = 0.1 if args.sleep_s is None else args.sleep_s
    if args.tasks is None:
        args.tasks = 8 if args.task == "cpu" else 40
    if len(set(args.models)) != len(args.models) or len(set(args.sizes)) != len(args.sizes):
        parser.error("실행 방식과 입력 크기는 중복 없이 지정한다.")
    if args.smoke:
        if args.task == "cpu":
            args.sizes = [100]
        else:
            args.tasks = 8
            args.sleep_s = 0.001
        args.repeats = 1
    elif args.repeats < 3:
        parser.error("본 측정은 조건마다 3회 이상 반복한다.")
    return args


def build_cases(args: argparse.Namespace) -> list[Case]:
    worker_counts = sorted({args.workers, *args.compare_workers})
    return [
        Case(model, n, workers, args.task, args.sleep_s)
        for n in (args.sizes if args.task == "cpu" else [None])
        for model in args.models
        for workers in ([1] if model == "sequential" else worker_counts)
    ]


def cpu_times() -> tuple[float, float]:
    parent = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return parent.ru_utime + parent.ru_stime, children.ru_utime + children.ru_stime


def command_info(command: list[str], cwd: Path | None = None) -> dict:
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=10)
        return {
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": str(error)}


def collect_environment(
    args: argparse.Namespace, started: datetime, gil_enabled: bool,
    sources: tuple[str, ...] = ("bench.py", "models.py", "workloads.py"),
) -> dict:
    return {
        "started_at": started.isoformat(),
        "timezone": "Asia/Seoul",
        "purpose": "smoke" if args.smoke else "benchmark",
        "command": shlex.join([sys.executable, *sys.argv]),
        "python": sys.version,
        "executable": sys.executable,
        "resolved_executable": str(Path(sys.executable).resolve()),
        "base_prefix": sys.base_prefix,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "logical_cpus": os.cpu_count(),
        "available_cpus": os.process_cpu_count(),
        "gil_enabled": gil_enabled,
        "free_threaded_build": bool(sysconfig.get_config_var("Py_GIL_DISABLED")),
        "gil_configuration": {
            "PYTHON_GIL": os.environ.get("PYTHON_GIL"),
            "xoption_gil": sys._xoptions.get("gil"),
        },
        "config": {**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None},
        "commit": command_info(["git", "rev-parse", "HEAD"], EXPERIMENT_DIR),
        "working_tree": command_info(["git", "status", "--short"], EXPERIMENT_DIR),
        "source_sha256": {
            name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
            for name in sources
        },
        "hardware": command_info([
            "sysctl", "machdep.cpu.brand_string", "hw.physicalcpu", "hw.logicalcpu",
            "hw.perflevel0.name", "hw.perflevel0.physicalcpu",
            "hw.perflevel1.name", "hw.perflevel1.physicalcpu",
        ]),
        "os_version": command_info(["sw_vers", "-productVersion"]),
        "power": command_info(["pmset", "-g", "batt"]),
        "uv": command_info(["uv", "--version"]),
    }


def measure(case: Case, tasks: int, expected_gil: bool, expected_value: int) -> dict:
    # 입력과 검증용 정답은 타이머 시작 전에 준비한다.
    jobs = [Job(case.task, expected_gil, n=case.n or 0, sleep_s=case.sleep_s)] * tasks
    gil_enabled = require_gil(expected_gil)
    runner = RUNNERS[case.model]
    job_fn = run_async_job if case.model == "asyncio" else run_job
    error = None
    cpu_before = cpu_times()
    started = perf_counter()
    try:
        values = runner(jobs, case.workers, job_fn)
    except Exception as exc:
        wall_s = perf_counter() - started
        values = []
        error = f"{type(exc).__name__}: {exc}"
    else:
        wall_s = perf_counter() - started
    cpu_after = cpu_times()
    cpu_parent_s = cpu_after[0] - cpu_before[0]
    cpu_children_s = cpu_after[1] - cpu_before[1]
    valid = error is None and len(values) == tasks and all(v == expected_value for v in values)
    if not valid and error is None:
        error = f"검증 실패: expected={expected_value} x {tasks}, actual={values!r}"
    params = {
        "timing": "end_to_end",
        "cpu_accounting": "getrusage_self_and_reaped_children",
    }
    if case.task == "cpu":
        params.update(n=case.n, algorithm="trial_division")
    else:
        params["sleep_s"] = case.sleep_s
    if case.model == "processes":
        params["start_method"] = "spawn"
    result = {
        "model": case.model,
        "workers": case.workers,
        "task": case.task,
        "size": tasks,
        "params": params,
        "wall_s": wall_s,
        "cpu_parent_s": cpu_parent_s,
        "cpu_children_s": cpu_children_s,
        "cpu_percent": 100 * (cpu_parent_s + cpu_children_s) / wall_s,
        "check": sum(values) if values else None,
        "expected_check": expected_value * tasks,
        "gil_enabled": gil_enabled,
        "valid": valid,
    }
    if error:
        result["error"] = error
    return result


def print_summary(rows: list[dict]) -> None:
    def key(row: dict) -> tuple:
        parameter = row["params"]["n" if row["task"] == "cpu" else "sleep_s"]
        return row["task"], parameter, row["size"], row["model"], row["workers"]

    print("task model        input        tasks workers   median_s      min_s      max_s", file=sys.stderr)
    for group in sorted({key(r) for r in rows}):
        task, parameter, tasks, model, workers = group
        values = [
            r["wall_s"] for r in rows
            if r["valid"] and r["run"] > 0 and key(r) == group
        ]
        if values:
            label = f"n={parameter}" if task == "cpu" else f"sleep={parameter:g}"
            print(
                f"{task:4} {model:12} {label:12} {tasks:5} {workers:7} {median(values):10.6f} "
                f"{min(values):10.6f} {max(values):10.6f}", file=sys.stderr,
            )


def main() -> int:
    args = parse_args()
    expected_gil = args.expect_gil == "on"
    gil_enabled = require_gil(expected_gil)
    purpose = "smoke" if args.smoke else "benchmark"
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-{purpose}"
    build_suffix = "t" if sysconfig.get_config_var("Py_GIL_DISABLED") else ""
    version = platform.python_version() + build_suffix
    runtime = f"cpython-{version}"
    variant = "gil=on" if gil_enabled else "gil=off"
    directory = args.output_dir or EXPERIMENT_DIR / "results"
    if args.output_dir is None and args.smoke:
        directory = directory / "validation"
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}-{variant.replace('=', '-')}.jsonl"
    environment = collect_environment(args, started, gil_enabled)
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    expected = {n: reference_count(n) for n in args.sizes} if args.task == "cpu" else {None: 1}
    cases = build_cases(args)
    random.Random(args.seed).shuffle(cases)
    rows = []
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.repeats + 1):
            # 두 조건의 선후 관계가 반복마다 바뀌도록 순서를 뒤집는다.
            order = cases if run % 2 == 0 else list(reversed(cases))
            for position, case in enumerate(order):
                row = measure(case, args.tasks, expected_gil, expected[case.n])
                row.update({
                    "lang": "python", "runtime": runtime, "variant": variant,
                    "run_id": run_id, "environment_file": env_path.name,
                    "purpose": purpose, "run": run, "order_index": position,
                    "seed": args.seed,
                })
                line = json.dumps(row, ensure_ascii=False)
                stream.write(line + "\n")
                stream.flush()
                print(line, flush=True)
                rows.append(row)
                if not row["valid"]:
                    print(row["error"], file=sys.stderr)
                    return 1
    if args.smoke:
        print("기능 검증 완료. 이 결과로 성능 순위를 판단하지 않는다.", file=sys.stderr)
    else:
        print_summary(rows)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
