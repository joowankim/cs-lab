# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""작업과 실행 스레드의 대응을 기록한다. 성능 비교에는 사용하지 않는다."""

import argparse
import asyncio
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
import json
import os
from pathlib import Path
import platform
import sys
import sysconfig
import threading
from time import perf_counter_ns
from zoneinfo import ZoneInfo

from bench import EXPERIMENT_DIR, collect_environment, positive_float, positive_int
from models import RUNNERS
from workloads import Job, reference_count, require_gil, run_async_job, run_job


@dataclass(frozen=True)
class TraceInput:
    job_id: int
    job: Job
    expected_check: int
    origin_ns: int


def snapshot(event: str, origin_ns: int) -> dict:
    at_ns = perf_counter_ns()
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    task = asyncio.current_task() if loop is not None else None
    return {
        "event": event,
        "at_ns": at_ns,
        "elapsed_s": (at_ns - origin_ns) / 1_000_000_000,
        "pid": os.getpid(),
        "native_thread_id": threading.get_native_id(),
        "thread_name": threading.current_thread().name,
        "loop_id": hex(id(loop)) if loop is not None else None,
        "asyncio_task_id": hex(id(task)) if task is not None else None,
        "asyncio_task_name": task.get_name() if task is not None else None,
        "gil_enabled": sys._is_gil_enabled(),
    }


def finish_record(item: TraceInput, events: list[dict], value: int | None, error: str | None) -> dict:
    record = {
        "job_id": item.job_id,
        "check": value,
        "expected_check": item.expected_check,
        "valid": error is None and value == item.expected_check,
        "events": events,
    }
    if error is not None:
        record["error"] = error
    return record


def trace_job(item: TraceInput) -> dict:
    events = [snapshot("work_start", item.origin_ns)]
    value = None
    error = None
    try:
        value = run_job(item.job)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    events.append(snapshot("work_error" if error else "work_end", item.origin_ns))
    return finish_record(item, events, value, error)


async def trace_async_job(item: TraceInput) -> dict:
    # models.py의 세마포어를 획득한 뒤 호출된다.
    events = [snapshot("work_start", item.origin_ns)]
    value = None
    error = None
    try:
        value = await run_async_job(item.job)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    events.append(snapshot("work_error" if error else "work_end", item.origin_ns))
    return finish_record(item, events, value, error)


def mapping_text(model: str, workers: int, records: list[dict]) -> str:
    assignments = defaultdict(set)
    names = defaultdict(set)
    task_ids = set()
    for record in records:
        for event in record["events"]:
            key = event["pid"], event["native_thread_id"], event["thread_name"]
            assignments[key].add(record["job_id"])
            if event["asyncio_task_id"] is not None:
                identity = event["pid"], event["loop_id"], event["asyncio_task_id"]
                task_ids.add(identity)
                names[key].add(event["asyncio_task_name"])
    lines = [
        f"{model}: 작업자 상한={workers}, 작업 수={len(records)}, "
        f"관찰한 OS 스레드={len(assignments)}, 작업용 asyncio Task={len(task_ids)}",
        "PID\tOS 스레드 ID\t스레드 이름\t작업 번호\tasyncio Task 이름",
    ]
    for key, job_ids in sorted(assignments.items()):
        pid, native_id, thread_name = key
        jobs = ",".join(map(str, sorted(job_ids)))
        tasks = ",".join(sorted(names[key])) or "-"
        lines.append(f"{pid}\t{native_id}\t{thread_name}\t{jobs}\t{tasks}")
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", choices=("cpu", "io"), default="io")
    parser.add_argument("--models", nargs="+", choices=RUNNERS, default=list(RUNNERS))
    parser.add_argument("--workers", type=positive_int, default=4)
    parser.add_argument("--tasks", type=positive_int, default=8)
    parser.add_argument("--n", type=positive_int, default=100)
    parser.add_argument("--sleep-s", type=positive_float, default=0.001)
    parser.add_argument("--expect-gil", choices=("on", "off"), default="on")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="작업 8개, N=100, 대기 0.001초로 고정")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 기록에는 CPython 3.14를 사용한다.")
    if len(args.models) != len(set(args.models)):
        parser.error("실행 방식은 중복 없이 지정한다.")
    if args.smoke:
        args.tasks, args.n, args.sleep_s = 8, 100, 0.001
    return args


def main() -> int:
    args = parse_args()
    expected_gil = args.expect_gil == "on"
    gil_enabled = require_gil(expected_gil)
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-trace" + ("-smoke" if args.smoke else "")
    version = platform.python_version() + ("t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "")
    variant = "gil=on" if gil_enabled else "gil=off"
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "traces")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}-{variant.replace('=', '-')}.jsonl"
    mapping_path = directory / f"{run_id}-mapping.txt"
    environment = collect_environment(
        args, started, gil_enabled,
        sources=("trace_execution.py", "bench.py", "models.py", "workloads.py"),
    )
    environment.update(purpose="trace", validation=args.smoke, trace_schema=1)
    environment["driver"] = snapshot("driver", perf_counter_ns())
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(f"환경: {env_path}\n기록: {result_path}\n대응표: {mapping_path}", file=sys.stderr)
    expected = reference_count(args.n) if args.task == "cpu" else 1
    job = Job(args.task, expected_gil, n=args.n, sleep_s=args.sleep_s)
    with result_path.open("x", encoding="utf-8") as stream, mapping_path.open("x", encoding="utf-8") as mapping:
        for model in args.models:
            workers = 1 if model == "sequential" else args.workers
            origin_ns = perf_counter_ns()
            items = [TraceInput(i, job, expected, origin_ns) for i in range(args.tasks)]
            job_fn = trace_async_job if model == "asyncio" else trace_job
            records = RUNNERS[model](items, workers, job_fn)
            params = {"n": args.n, "algorithm": "trial_division"} if args.task == "cpu" else {"sleep_s": args.sleep_s}
            if model == "processes":
                params["start_method"] = "spawn"
            for record in records:
                record.update(
                    lang="python", runtime=f"cpython-{version}", variant=variant,
                    purpose="trace", validation=args.smoke, trace_schema=1,
                    run_id=run_id, environment_file=env_path.name, run=1,
                    model=model, workers=workers, task=args.task, size=args.tasks,
                    params=params, origin_ns=origin_ns,
                )
                line = json.dumps(record, ensure_ascii=False)
                stream.write(line + "\n")
                stream.flush()
                print(line, flush=True)
            summary = mapping_text(model, workers, records)
            mapping.write(summary + "\n")
            mapping.flush()
            print(summary, file=sys.stderr)
            if not all(record["valid"] for record in records):
                print("작업 결과 검증에 실패했다. 오류를 원자료에서 확인한다.", file=sys.stderr)
                return 1
    print("추적 완료. 이 기록은 성능 비교나 모든 스케줄링 가능성의 증명에 사용하지 않는다.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"추적 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
