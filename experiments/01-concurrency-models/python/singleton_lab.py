# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""지연 초기화의 생성 횟수와 반환 객체 동일성을 함께 기록한다."""

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
import time
from zoneinfo import ZoneInfo

from bench import EXPERIMENT_DIR, collect_environment, positive_int
from singleton_kernels import GETTERS, SingletonState
from workloads import require_gil


def run_trial(
    get_instance: Callable[[SingletonState, threading.Lock, Callable[[], object]], object], *,
    workers: int, yield_in_factory: bool, expected_gil: bool,
) -> dict:
    state = SingletonState()
    lock = threading.Lock()
    start = threading.Barrier(workers + 1)
    created = []
    creation_log_lock = threading.Lock()

    def factory() -> object:
        if yield_in_factory:
            time.sleep(0)
        value = object()
        # 기록만 보호한다. None 검사와 공유 객체 저장은 보호하지 않는다.
        with creation_log_lock:
            created.append(value)
        return value

    def worker() -> tuple[dict, object | None]:
        value = None
        actual_gil = None
        finished = 0
        error = None
        started = False
        try:
            actual_gil = require_gil(expected_gil)
            start.wait(timeout=10)
            started = True
            value = get_instance(state, lock, factory)
            finished = 1
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            if not started:
                start.abort()
        return {
            "native_thread_id": threading.get_native_id(),
            "thread_name": threading.current_thread().name,
            "gil_enabled": actual_gil, "finished_calls": finished, "error": error,
            "returned_id": id(value) if value is not None else None,
        }, value

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(worker) for _ in range(workers)]
        try:
            start.wait(timeout=10)
        except threading.BrokenBarrierError:
            pass
        results = [future.result() for future in futures]
    metadata = [result[0] for result in results]
    returned = [result[1] for result in results if result[0]["finished_calls"] == 1]
    valid = len(returned) == workers and all(r["error"] is None for r in metadata)
    # 생성·반환 객체의 참조를 판정 끝까지 유지해 ID 재사용을 막는다.
    check = {
        "created_count": len(created),
        "returned_unique": len({id(value) for value in returned}),
        "all_returned_published": valid and state.instance is not None
            and all(value is state.instance for value in returned),
        "published_was_created": any(value is state.instance for value in created),
    }
    expected = {"created_count": 1, "returned_unique": 1,
                "all_returned_published": True, "published_was_created": True}
    return {
        "check": check, "expected_check": expected,
        "finished_calls": len(returned), "valid": valid, "correct": valid and check == expected,
        "created_ids": [id(value) for value in created],
        "published_id": id(state.instance) if state.instance is not None else None,
        "worker_results": metadata,
    }


def print_singleton_summary(rows: list[dict]) -> None:
    print("case        trials correct mismatches errors", file=sys.stderr)
    for case in sorted({r["case"] for r in rows}):
        samples = [r for r in rows if r["case"] == case and r["run"] > 0]
        correct = sum(r["valid"] and r["correct"] for r in samples)
        mismatches = sum(r["valid"] and not r["correct"] for r in samples)
        errors = sum(not r["valid"] for r in samples)
        print(f"{case:11} {len(samples):6} {correct:7} {mismatches:10} {errors:6}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", nargs="+", choices=GETTERS, default=["unlocked"])
    parser.add_argument("--workers", type=positive_int, default=2)
    parser.add_argument("--trials", type=positive_int, default=100)
    parser.add_argument("--yield-in-factory", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--expect-gil", choices=("on", "off"), default="on")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="스레드 2개·각 1회 요청·검증 3회로 고정")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if len(args.cases) != len(set(args.cases)):
        parser.error("비교할 함수를 중복 없이 지정한다.")
    if args.smoke:
        args.workers, args.trials = 2, 3
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    return args


def main() -> int:
    args = parse_args()
    expected_gil = args.expect_gil == "on"
    gil_enabled = require_gil(expected_gil)
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-singleton" + ("-smoke" if args.smoke else "")
    version = platform.python_version() + ("t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "")
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(
        args, started, gil_enabled,
        sources=("singleton_lab.py", "singleton_kernels.py", "bench.py", "models.py", "workloads.py"),
    )
    environment.update(purpose="race", scenario="singleton", validation=args.smoke)
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
                    GETTERS[case], workers=args.workers, yield_in_factory=args.yield_in_factory,
                    expected_gil=expected_gil,
                )
                row.update(
                    lang="python", runtime=f"cpython-{version}",
                    variant=f"gil={'on' if gil_enabled else 'off'};case={case};yield={args.yield_in_factory}",
                    model="threads", task="singleton", case=case,
                    purpose="race", scenario="singleton", validation=args.smoke,
                    workers=args.workers, size=args.workers,
                    params={"requests_per_worker": 1, "yield_in_factory": args.yield_in_factory,
                            "start_barrier": True, "creation_log_lock": True},
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
        print_singleton_summary(rows)
    return int(any(r["case"] == "candidate" and r["run"] > 0 and not r["correct"] for r in rows))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"싱글톤 실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
