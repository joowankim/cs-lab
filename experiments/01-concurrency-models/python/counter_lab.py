# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""공유 카운터의 기대값 불일치와 실행 오류를 구분해 기록한다."""

import argparse
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from pathlib import Path
import platform
import sys
import sysconfig
import threading
from zoneinfo import ZoneInfo

from bench import EXPERIMENT_DIR, collect_environment, positive_int
from counter_kernels import Counter, UPDATERS
from workloads import require_gil


def run_trial(
    update: Callable[[Counter, threading.Lock, bool], None], *, workers: int,
    increments: int, yield_between: bool, expected_gil: bool,
) -> dict:
    counter = Counter()
    lock = threading.Lock()
    # 시작 장벽은 읽기·쓰기와 락 바깥에 둔다. 같은 값을 읽도록 강제하지는 않는다.
    start = threading.Barrier(workers + 1)

    def worker() -> dict:
        finished = 0
        actual_gil = None
        error = None
        started = False
        try:
            actual_gil = require_gil(expected_gil)
            start.wait(timeout=10)
            started = True
            for _ in range(increments):
                update(counter, lock, yield_between)
                finished += 1
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            if not started:
                start.abort()
        return {
            "native_thread_id": threading.get_native_id(),
            "thread_name": threading.current_thread().name,
            "gil_enabled": actual_gil, "finished_calls": finished, "error": error,
        }

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(worker) for _ in range(workers)]
        try:
            start.wait(timeout=10)
        except threading.BrokenBarrierError:
            pass
        results = [future.result() for future in futures]
    expected = workers * increments
    finished = sum(result["finished_calls"] for result in results)
    valid = finished == expected and all(result["error"] is None for result in results)
    return {
        "check": counter.completed, "expected_check": expected,
        "finished_calls": finished, "valid": valid,
        "correct": valid and counter.completed == expected,
        "worker_results": results,
    }


def print_counter_summary(rows: list[dict]) -> None:
    print("case        trials correct mismatches errors", file=sys.stderr)
    for case in sorted({r["case"] for r in rows}):
        samples = [r for r in rows if r["case"] == case and r["run"] > 0]
        correct = sum(r["valid"] and r["correct"] for r in samples)
        mismatches = sum(r["valid"] and not r["correct"] for r in samples)
        errors = sum(not r["valid"] for r in samples)
        print(f"{case:11} {len(samples):6} {correct:7} {mismatches:10} {errors:6}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", nargs="+", choices=UPDATERS, default=["unlocked"])
    parser.add_argument("--workers", type=positive_int, default=2)
    parser.add_argument("--increments", type=positive_int, default=1)
    parser.add_argument("--trials", type=positive_int, default=100)
    parser.add_argument("--yield-between", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--expect-gil", choices=("on", "off"), default="on")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="스레드 2개·각 1회 증가·검증 3회로 고정")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if len(args.cases) != len(set(args.cases)):
        parser.error("비교할 함수를 중복 없이 지정한다.")
    if args.smoke:
        args.workers, args.increments, args.trials = 2, 1, 3
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    return args


def main() -> int:
    args = parse_args()
    expected_gil = args.expect_gil == "on"
    gil_enabled = require_gil(expected_gil)
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-counter" + ("-smoke" if args.smoke else "")
    version = platform.python_version() + ("t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "")
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(
        args, started, gil_enabled,
        sources=("counter_lab.py", "counter_kernels.py", "bench.py", "models.py", "workloads.py"),
    )
    environment.update(purpose="race", scenario="counter", validation=args.smoke)
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    rows = []
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.trials + 1):
            order = args.cases if run % 2 == 0 else list(reversed(args.cases))
            for position, case in enumerate(order):
                row = run_trial(
                    UPDATERS[case], workers=args.workers, increments=args.increments,
                    yield_between=args.yield_between, expected_gil=expected_gil,
                )
                row.update(
                    lang="python", runtime=f"cpython-{version}",
                    variant=f"gil={'on' if gil_enabled else 'off'};case={case};yield={args.yield_between}",
                    model="threads", task="counter", case=case,
                    purpose="race", scenario="counter", validation=args.smoke,
                    workers=args.workers, size=args.workers * args.increments,
                    params={"increments_per_worker": args.increments, "yield_between": args.yield_between,
                            "start_barrier": True},
                    run_id=run_id, environment_file=env_path.name,
                    run=run, order_index=position, gil_enabled=gil_enabled,
                )
                line = json.dumps(row, ensure_ascii=False)
                stream.write(line + "\n")
                stream.flush()
                print(line, flush=True)
                rows.append(row)
                if not row["valid"]:
                    print("실행 오류를 기록했다. worker_results를 확인한다.", file=sys.stderr)
                    return 1
    if args.smoke:
        print("작은 입력의 실행·저장 검증 완료. 재현 빈도나 수정 완료를 판단하지 않는다.", file=sys.stderr)
    else:
        print_counter_summary(rows)
    # 수정본의 기대값 불일치도 보존한 뒤 실패로 알린다.
    return int(any(r["case"] == "candidate" and r["run"] > 0 and not r["correct"] for r in rows))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"카운터 실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
