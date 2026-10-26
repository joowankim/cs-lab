# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""로더가 계산하는 동안 기다리는 방법과 스레드 수에 따라 로딩 시간과 깨어나기까지 걸린 시간을 기록한다."""

import argparse
from collections.abc import Callable
from datetime import datetime
import faulthandler
import json
from pathlib import Path
import platform
from statistics import median
import sys
import sysconfig
import threading
from time import perf_counter, process_time, thread_time
from zoneinfo import ZoneInfo

from release_lab import EXPERIMENT_DIR, collect_environment, positive_int
from wait_kernels import POLL_S, WAITS, Ready, build_index


TARGET_S = 1.0
WAITER_COUNTS = (4, 8)
JOIN_TIMEOUT_S = 120
WATCHDOG_S = 300
# README 표의 순서다. 기준(none)은 기다리는 스레드 없이 로더만 돈다.
CASES = [("none", 0)] + [(wait, waiters) for wait in WAITS for waiters in WAITER_COUNTS]


def calibrate(target_s: float) -> dict:
    # 혼자 돌 때 target_s초쯤 걸리는 n을 찾는다. 측정 전에 한 번만 하고 모든 조건에 같은 n을 쓴다.
    n = 100_000
    while True:
        started = perf_counter()
        build_index(n)
        elapsed = perf_counter() - started
        if elapsed >= 0.1:
            break
        n *= 2
    n = max(1, round(n * target_s / elapsed))
    alone_s = []
    for _ in range(3):
        started = perf_counter()
        expected = build_index(n)
        alone_s.append(perf_counter() - started)
    return {"n": n, "expected": expected, "target_s": target_s, "alone_s": alone_s}


def run_trial(wait: Callable | None, waiters: int, n: int, expected: int) -> dict:
    ready = Ready()
    loaded: dict = {}
    lock = threading.Lock()
    woke: list[dict] = []

    def load() -> None:
        # 문제 상황 3의 load()다. 로딩 시간은 로더 스레드 안에서 계산 앞뒤로 잰다.
        started = perf_counter()
        value = build_index(n)
        finished = perf_counter()
        loaded.update(value=value, load_s=finished - started, ready_at=finished)
        ready.set()

    def serve() -> None:
        # 문제 상황 3의 serve()에서 기다리는 부분만 둔다. 기다리는 동안 이 스레드가 쓴 CPU 시간을 함께 남긴다.
        cpu = thread_time()
        error = None
        try:
            wait(ready)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        at = perf_counter()
        with lock:
            woke.append({"thread": threading.current_thread().name, "at": at,
                         "cpu_s": thread_time() - cpu, "error": error})

    threads = [threading.Thread(target=load, name="loader", daemon=True)]
    threads += [threading.Thread(target=serve, name=f"serve-{i}", daemon=True) for i in range(1, waiters + 1)]
    # 끝나지 않는 실행은 스택을 남기고 멈춘다. 그때까지 저장한 원자료는 남는다.
    faulthandler.dump_traceback_later(WATCHDOG_S, exit=True)
    cpu_before = process_time()
    started = perf_counter()
    try:
        # 문제 상황 3처럼 로더를 먼저 띄우고 기다리는 스레드를 띄운다.
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=JOIN_TIMEOUT_S)
    finally:
        faulthandler.cancel_dump_traceback_later()
    wall_s = perf_counter() - started
    cpu_s = process_time() - cpu_before

    errors = [w["error"] for w in woke if w["error"]]
    # 깨어난 시각에서 로더가 계산을 마친 시각을 뺀다. 가장 늦은 값이 "깨어나기까지 걸린 시간"이다.
    wake_s = sorted(w["at"] - loaded["ready_at"] for w in woke) if "ready_at" in loaded else []
    valid = (
        loaded.get("value") == expected and len(woke) == waiters and not errors
        and not any(thread.is_alive() for thread in threads)
    )
    return {
        "check": loaded.get("value"), "expected_check": expected, "valid": valid,
        "wall_s": wall_s, "cpu_s": cpu_s,
        "load_s": loaded.get("load_s"),
        "last_wake_s": wake_s[-1] if wake_s else None,
        "wake_s": wake_s,
        "waiter_cpu_s": sum(w["cpu_s"] for w in woke),
        "waiter_errors": errors,
    }


def print_wait_summary(rows: list[dict]) -> None:
    print("wait  waiters trials load_s(median [min~max]) load/none last_wake_ms(median [min~max]) "
          "waiter_cpu_s(median) cpu_s(median)", file=sys.stderr)
    baseline = [r["load_s"] for r in rows if r["wait"] == "none" and r["run"] > 0]
    for wait, waiters in CASES:
        samples = [r for r in rows if (r["wait"], r["waiters"]) == (wait, waiters) and r["run"] > 0]
        if not samples:
            continue
        loads = [r["load_s"] for r in samples]
        ratio = f"{median(loads) / median(baseline):.2f}" if baseline else "-"
        wakes = [1000 * r["last_wake_s"] for r in samples if r["last_wake_s"] is not None]
        wake = f"{median(wakes):.2f} [{min(wakes):.2f}~{max(wakes):.2f}]" if wakes else "-"
        print(
            f"{wait:5} {waiters:7} {len(samples):6}"
            f" {median(loads):.3f} [{min(loads):.3f}~{max(loads):.3f}] {ratio:>9}"
            f" {wake} {median(r['waiter_cpu_s'] for r in samples):.3f} {median(r['cpu_s'] for r in samples):.3f}",
            file=sys.stderr,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--waits", nargs="+", choices=["none", *WAITS], default=["none", *WAITS])
    parser.add_argument("--waiters", nargs="+", type=int, choices=WAITER_COUNTS, default=list(WAITER_COUNTS))
    parser.add_argument("--trials", type=positive_int, default=10)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="조건마다 워밍업 1회와 검증 2회만 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if not sys._is_gil_enabled():
        parser.error("이 실험은 GIL이 켜진 상태에서 실행한다(uv run --python 3.14.2+gil).")
    if len(args.waits) != len(set(args.waits)) or len(args.waiters) != len(set(args.waiters)):
        parser.error("기다리는 방법과 스레드 수를 중복 없이 지정한다.")
    if args.smoke:
        args.trials = 2
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    return args


def main() -> int:
    args = parse_args()
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-wait" + ("-smoke" if args.smoke else "")
    version = platform.python_version() + ("t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "")
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    print("로더 계산량을 맞추는 중이다.", file=sys.stderr)
    calibration = calibrate(TARGET_S)
    environment = collect_environment(args, started, sources=("wait_lab.py", "wait_kernels.py", "release_lab.py"))
    environment.update(purpose="busy-wait", calibration=calibration, conditions={
        "target_s": TARGET_S, "poll_s": POLL_S, "waiter_counts": list(WAITER_COUNTS),
        "join_timeout_s": JOIN_TIMEOUT_S,
    })
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    cases = [(w, n) for w, n in CASES if w in args.waits and (w == "none" or n in args.waiters)]
    rows = []
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.trials + 1):
            order = cases if run % 2 == 0 else list(reversed(cases))
            for position, (wait, waiters) in enumerate(order):
                row = run_trial(WAITS.get(wait), waiters, calibration["n"], calibration["expected"])
                row.update(
                    lang="python", runtime=f"cpython-{version}", variant=f"wait={wait};waiters={waiters}",
                    model="threads", workers=waiters, task="busy-wait", size=calibration["n"],
                    params={"n": calibration["n"], "target_s": TARGET_S, "poll_s": POLL_S},
                    wait=wait, waiters=waiters, run_id=run_id, environment_file=env_path.name,
                    run=run, order_index=position, gil_enabled=sys._is_gil_enabled(),
                    switch_interval_s=sys.getswitchinterval(), validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                stream.flush()
                rows.append(row)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({wait}, {waiters}). check와 waiter_errors를 확인한다.", file=sys.stderr)
                    return 1
    if args.smoke:
        print("작은 입력의 실행·저장 검증 완료. 로딩 시간이나 깨어나는 시간을 판단하지 않는다.", file=sys.stderr)
    print_wait_summary(rows)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, NotImplementedError) as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
