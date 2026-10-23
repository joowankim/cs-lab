# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""같은 이벤트 루프의 A 작업이 주기적 B 작업을 얼마나 늦추는지 기록한다."""

import argparse
import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime
import json
import os
from pathlib import Path
import platform
import random
from statistics import median
import sys
import sysconfig
import threading
from time import perf_counter
from zoneinfo import ZoneInfo

from bench import EXPERIMENT_DIR, collect_environment, cpu_times, positive_float, positive_int
from loop_kernels import ACTIONS, LoopWork
from workloads import reference_count, require_gil


def identity() -> dict:
    task = asyncio.current_task()
    return {
        "pid": os.getpid(), "native_thread_id": threading.get_native_id(),
        "loop_id": id(asyncio.get_running_loop()),
        "task_id": id(task), "task_name": task.get_name(),
    }


async def observe(
    action: Callable[[LoopWork], Awaitable[int]] | None, work: LoopWork, *,
    period_s: float, ticks: int, expected_check: int | None, expected_gil: bool,
) -> dict:
    require_gil(expected_gil)
    loop = asyncio.get_running_loop()
    ready = asyncio.Event()
    origin = None
    heartbeats = []
    action_events = []

    async def heartbeat() -> int:
        nonlocal origin
        origin = loop.time()
        # 이 set 뒤 첫 sleep에서 대기하기 전까지 A에 실행 흐름을 넘기지 않는다.
        ready.set()
        for index in range(1, ticks + 1):
            due = origin + index * period_s
            await asyncio.sleep(max(0.0, due - loop.time()))
            resumed = loop.time()
            heartbeats.append({
                "index": index, "due_s": due - origin, "resumed_s": resumed - origin,
                "lag_s": resumed - due, "gil_enabled": require_gil(expected_gil),
                **identity(),
            })
        return len(heartbeats)

    async def run_action() -> int:
        await ready.wait()
        action_events.append({"event": "start", "at_s": loop.time() - origin, **identity()})
        try:
            require_gil(expected_gil)
            return await action(work)
        finally:
            action_events.append({"event": "end", "at_s": loop.time() - origin, **identity()})

    heartbeat_task = asyncio.create_task(heartbeat(), name="B-heartbeat")
    # 대조군에는 A의 Task 자체를 만들지 않는다.
    tasks = [heartbeat_task]
    if action is not None:
        tasks.append(asyncio.create_task(run_action(), name="A-work"))
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)
    errors = [f"{type(value).__name__}: {value}" for value in outcomes if isinstance(value, BaseException)]
    check = outcomes[1] if action is not None and not isinstance(outcomes[1], BaseException) else None
    expected = {"action": expected_check, "ticks": ticks}
    actual = {"action": check, "ticks": len(heartbeats)}
    locations = {(e["pid"], e["native_thread_id"], e["loop_id"]) for e in heartbeats + action_events}
    valid = not errors and actual == expected and len(locations) == 1
    if not valid and not errors:
        errors.append("작업 반환값·기록 수·실행 위치가 기대값과 일치하지 않는다.")
    phase_ok = action is None or bool(action_events and action_events[0]["at_s"] < period_s)
    lags = [event["lag_s"] for event in heartbeats]
    return {
        "check": actual, "expected_check": expected, "valid": valid, "errors": errors,
        "phase_ok": phase_ok, "comparison_valid": valid and phase_ok,
        "heartbeats": heartbeats, "action_events": action_events,
        "first_lag_s": lags[0] if lags else None,
        "max_lag_s": max(lags) if lags else None,
        "action_wall_s": action_events[-1]["at_s"] - action_events[0]["at_s"] if action_events else None,
    }


def measure(case: str, work: LoopWork, *, period_s: float, ticks: int,
            expected_check: int | None, expected_gil: bool) -> dict:
    before = cpu_times()
    started = perf_counter()
    row = asyncio.run(observe(ACTIONS[case], work, period_s=period_s, ticks=ticks,
                              expected_check=expected_check, expected_gil=expected_gil))
    wall_s = perf_counter() - started
    after = cpu_times()
    parent, children = after[0] - before[0], after[1] - before[1]
    row.update(wall_s=wall_s, cpu_parent_s=parent, cpu_children_s=children,
               cpu_percent=100 * (parent + children) / wall_s)
    return row


def print_loop_summary(rows: list[dict]) -> None:
    # 같은 실행의 각 조건을 표시한다. 조건이 다른 기록은 섞지 않는다.
    def group(row):
        return row["runtime"], row["variant"], row["case"], json.dumps(row["params"], sort_keys=True)

    for key in sorted({group(row) for row in rows}):
        samples = [r for r in rows if group(r) == key and r["run"] > 0 and r["comparison_valid"]]
        if not samples:
            continue
        print(f"{key[0]} {key[1]} params={key[3]} samples={len(samples)}", file=sys.stderr)
        for field in ("first_lag_s", "max_lag_s"):
            values = [row[field] for row in samples]
            print(f"  {field}: median={median(values):.6f} min={min(values):.6f} max={max(values):.6f}",
                  file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", nargs="+", choices=ACTIONS, default=["idle", "blocking", "cpu"])
    parser.add_argument("--period-s", type=positive_float, default=0.1)
    parser.add_argument("--ticks", type=positive_int, default=12)
    parser.add_argument("--sleep-s", type=positive_float, default=1.0)
    parser.add_argument("--n", type=positive_int, default=200_000)
    parser.add_argument("--cpu-jobs", type=positive_int, default=8)
    parser.add_argument("--repeats", type=positive_int, default=3)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--expect-gil", choices=("on", "off"), default="on")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="주기 1ms·4회·A 대기 2ms·N=100의 작은 입력 검증")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if len(args.cases) != len(set(args.cases)):
        parser.error("비교 조건을 중복 없이 지정한다.")
    if args.smoke:
        args.period_s, args.ticks, args.sleep_s = 0.001, 4, 0.002
        args.n, args.cpu_jobs, args.repeats = 100, 1, 1
    elif args.repeats < 3:
        parser.error("본 측정은 조건마다 3회 이상 반복한다.")
    return args


def main() -> int:
    args = parse_args()
    expected_gil = args.expect_gil == "on"
    gil_enabled = require_gil(expected_gil)
    work = LoopWork(args.sleep_s, args.n, args.cpu_jobs)
    expected = {"idle": None, "blocking": 1, "candidate": 1,
                "cpu": reference_count(args.n) * args.cpu_jobs}
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-loop" + ("-smoke" if args.smoke else "")
    version = platform.python_version() + ("t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "")
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(
        args, started, gil_enabled,
        sources=("loop_lab.py", "loop_kernels.py", "bench.py", "models.py", "workloads.py"),
    )
    environment.update(purpose="latency", scenario="event_loop", validation=args.smoke)
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    cases = list(args.cases)
    random.Random(args.seed).shuffle(cases)
    rows = []
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.repeats + 1):
            for position, case in enumerate(cases if run % 2 == 0 else list(reversed(cases))):
                row = measure(case, work, period_s=args.period_s, ticks=args.ticks,
                              expected_check=expected[case], expected_gil=expected_gil)
                params = {"period_s": args.period_s, "ticks": args.ticks, "loop_threads": 1,
                          "timing": "end_to_end", "deadline_clock": "loop.time",
                          "schedule": "fixed_deadlines_with_catch_up",
                          "cpu_accounting": "getrusage_self_and_reaped_children"}
                if case == "cpu":
                    params.update(n=args.n, cpu_jobs=args.cpu_jobs, algorithm="trial_division")
                elif case != "idle":
                    params["sleep_s"] = args.sleep_s
                row.update(
                    lang="python", runtime=f"cpython-{version}",
                    variant=f"gil={'on' if gil_enabled else 'off'};case={case}",
                    model="asyncio", task="event_loop", case=case,
                    purpose="latency", scenario="event_loop", validation=args.smoke,
                    workers=1 if case == "idle" else 2, size=args.ticks, params=params,
                    run_id=run_id, environment_file=env_path.name, seed=args.seed,
                    run=run, order_index=position, gil_enabled=gil_enabled,
                )
                line = json.dumps(row, ensure_ascii=False)
                stream.write(line + "\n")
                stream.flush()
                print(line, flush=True)
                rows.append(row)
                if not row["valid"]:
                    print(f"실행 검증 실패: {row['errors']}", file=sys.stderr)
                    return 1
    if args.smoke:
        print("작은 입력의 실행·저장 검증 완료. 지연 가설은 본 측정에서 판단한다.", file=sys.stderr)
    else:
        print_loop_summary(rows)
    if any(not row["phase_ok"] for row in rows):
        print("A가 첫 예정 시각 전에 시작하지 못한 기록이 있다. 비교에서 제외하고 새 파일로 재실행한다.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"이벤트 루프 실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
