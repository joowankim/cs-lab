# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""반대 순서로 락을 잡는 이체와 식사하는 철학자가 멈추는지, 끝난다면 걸린 시간을 고친 코드와 함께 기록한다."""

import argparse
from collections.abc import Callable
from datetime import datetime
import faulthandler
import json
import os
from pathlib import Path
import platform
from statistics import median
import subprocess
import sys
import sysconfig
import threading
from time import perf_counter, process_time
from zoneinfo import ZoneInfo

from deadlock_kernels import (
    BACKOFF_S, CHECKS, DB_S, EAT_S, PHILOSOPHERS, PICK_S, PICKS, THINK_S, TRANSFERS, Account, philosopher,
)
from release_lab import EXPERIMENT_DIR, collect_environment, positive_int


# 이 시간 안에 끝나지 않으면 멈춘 것으로 본다.
HANG_S = 10
# 실행 한 번을 맡은 자식 프로세스가 이 시간 안에 답하지 않으면 실행 오류로 본다.
CHILD_TIMEOUT_S = 60
BALANCE = 1_000_000
MEALS = 100
# 검증 실행은 이체 수와 먹는 횟수를 1/10로 줄이고 3초로 멈춤을 판단한다.
SMOKE_SCALE = 10
SMOKE_HANG_S = 3
# README 측정 조건 표의 번호 순서다. 철학자의 waiter는 웨이터가 한 번에 들여보내는 수이고 0이면 웨이터가 없다.
TRANSFER_CASES = [
    {"case": 1, "transfer": "opposite", "check": "db", "per_thread": 1000},
    {"case": 2, "transfer": "opposite", "check": "memory", "per_thread": 1000},
    {"case": 3, "transfer": "opposite", "check": "memory", "per_thread": 100_000},
    {"case": 4, "transfer": "ordered", "check": "db", "per_thread": 1000},
    {"case": 5, "transfer": "retry", "check": "db", "per_thread": 1000},
]
PHILOSOPHER_CASES = [
    {"case": 1, "pick": "left", "waiter": 0},
    {"case": 2, "pick": "larger", "waiter": 0},
    {"case": 3, "pick": "left", "waiter": PHILOSOPHERS - 1},
]
TASKS = {"transfer": TRANSFER_CASES, "philosophers": PHILOSOPHER_CASES}


def watch(threads: list[threading.Thread], hang_s: float, stack_path: Path | None) -> dict:
    # 스레드를 띄우고 hang_s초 안에 모두 끝나는지 본다. 끝나지 않으면 각 스레드가 멈춘 줄을 파일에 남긴다.
    cpu_before = process_time()
    started = perf_counter()
    for thread in threads:
        thread.start()
    deadline = started + hang_s
    for thread in threads:
        thread.join(timeout=max(0.0, deadline - perf_counter()))
    finished = perf_counter()
    hung = any(thread.is_alive() for thread in threads)
    stack_file = None
    if hung and stack_path is not None:
        with stack_path.open("w", encoding="utf-8") as stream:
            faulthandler.dump_traceback(stream, all_threads=True)
        stack_file = stack_path.name
    return {
        "hung": hung,
        # 멈춘 실행에는 걸린 시간이 없다. 멈췄다고 판단하기까지 기다린 시간은 hang_s다.
        "elapsed_s": None if hung else finished - started,
        "hang_s": hang_s,
        # 프로세스 전체의 CPU 시간이다. 멈춘 실행에서는 멈춘 동안 CPU를 썼는지 보는 데 쓴다.
        "cpu_s": process_time() - cpu_before,
        "stack_file": stack_file,
    }


def run_transfer_trial(
    transfer: Callable, check: Callable, per_thread: int, *,
    hang_s: float = HANG_S, stack_path: Path | None = None,
) -> dict:
    a, b = Account("A", BALANCE), Account("B", BALANCE)
    done = {"a_to_b": 0, "b_to_a": 0}
    retries = {"a_to_b": 0, "b_to_a": 0}
    errors: list[str] = []

    def move(name: str, src: Account, dst: Account) -> None:
        # 문제 상황 4의 a_to_b()·b_to_a()다. 마친 이체 수와 다시 시도한 횟수를 스레드마다 센다.
        try:
            for _ in range(per_thread):
                retries[name] += transfer(src, dst, 1, check)
                done[name] += 1
        except Exception as exc:
            errors.append(f"{name}: {type(exc).__name__}: {exc}")

    threads = [
        threading.Thread(target=move, args=("a_to_b", a, b), name="a_to_b", daemon=True),
        threading.Thread(target=move, args=("b_to_a", b, a), name="b_to_a", daemon=True),
    ]
    row = watch(threads, hang_s, stack_path)
    # 멈춘 실행에서는 아직 도는 스레드가 있을 수 있어 잔액 합을 보지 않는다.
    sum_ok = None if row["hung"] else a.balance + b.balance == 2 * BALANCE
    done_total = sum(done.values())
    row.update(
        done=dict(done), done_total=done_total, retries=sum(retries.values()), sum_ok=sum_ok, errors=errors,
        valid=not errors and (row["hung"] or (sum_ok and done_total == 2 * per_thread)),
    )
    return row


def run_philosopher_trial(
    dine: Callable, pick: Callable, waiter_size: int, meals: int, *,
    hang_s: float = HANG_S, stack_path: Path | None = None,
) -> dict:
    forks = [threading.Lock() for _ in range(PHILOSOPHERS)]
    waiter = threading.Semaphore(waiter_size) if waiter_size else None
    eaten = [0] * PHILOSOPHERS
    errors: list[str] = []

    def seat(i: int) -> None:
        try:
            dine(forks, i, pick, meals, eaten, waiter)
        except Exception as exc:
            errors.append(f"philosopher-{i}: {type(exc).__name__}: {exc}")

    threads = [
        threading.Thread(target=seat, args=(i,), name=f"philosopher-{i}", daemon=True)
        for i in range(PHILOSOPHERS)
    ]
    row = watch(threads, hang_s, stack_path)
    row.update(
        eaten=list(eaten), eaten_total=sum(eaten), errors=errors,
        valid=not errors and (row["hung"] or eaten == [meals] * PHILOSOPHERS),
    )
    return row


def run_spec(spec: dict) -> dict:
    stack_path = Path(spec["stack_path"]) if spec.get("stack_path") else None
    if spec["task"] == "transfer":
        row = run_transfer_trial(
            TRANSFERS[spec["transfer"]], CHECKS[spec["check"]], spec["per_thread"],
            hang_s=spec["hang_s"], stack_path=stack_path,
        )
    else:
        row = run_philosopher_trial(
            philosopher, PICKS[spec["pick"]], spec["waiter"], spec["meals"],
            hang_s=spec["hang_s"], stack_path=stack_path,
        )
    row.update(gil_enabled=sys._is_gil_enabled(), switch_interval_s=sys.getswitchinterval())
    return row


def child_main(raw: str) -> None:
    print(json.dumps(run_spec(json.loads(raw)), ensure_ascii=False), flush=True)
    # 멈춘 스레드가 남아 있어도 기다리지 않고 프로세스를 끝낸다.
    os._exit(0)


def run_in_child(spec: dict) -> dict:
    # 멈춘 스레드가 다음 실행에 남지 않도록 실행마다 새 프로세스를 쓴다.
    command = [sys.executable, str(Path(__file__).resolve()), "--child", json.dumps(spec)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=CHILD_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return {"valid": False, "child_error": f"{CHILD_TIMEOUT_S}초 안에 답하지 않았다."}
    lines = result.stdout.strip().splitlines()
    if result.returncode != 0 or not lines:
        return {"valid": False, "child_error": f"returncode={result.returncode}: {result.stderr.strip()[-2000:]}"}
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as error:
        return {"valid": False, "child_error": f"결과를 읽지 못했다: {error}"}


def make_spec(task: str, case: dict, smoke: bool, stack_path: Path) -> dict:
    scale = SMOKE_SCALE if smoke else 1
    spec = {"task": task, **case, "hang_s": SMOKE_HANG_S if smoke else HANG_S, "stack_path": str(stack_path)}
    if task == "transfer":
        spec["per_thread"] = case["per_thread"] // scale
    else:
        spec["meals"] = MEALS // scale
    return spec


def describe(row: dict) -> str:
    if not row["valid"]:
        return "실행 오류"
    if row["hung"]:
        total = row["done_total"] if row["task"] == "transfer" else row["eaten_total"]
        return f"멈춤({'마친 이체' if row['task'] == 'transfer' else '먹은 횟수'} {total})"
    return f"끝남 {1000 * row['elapsed_s']:.1f}ms"


def print_deadlock_summary(rows: list[dict]) -> None:
    # at_hang은 멈춘 실행에서 그때까지 마친 이체 수(이체) 또는 먹은 횟수의 합(철학자)이다.
    print("task         case trials hung zero_at_hang at_hang(median [min~max]) "
          "elapsed_ms(median [min~max]) retries(median) cpu_s_hung(median)", file=sys.stderr)
    for task, cases in TASKS.items():
        key = "done_total" if task == "transfer" else "eaten_total"
        for case in cases:
            samples = [r for r in rows if r["task"] == task and r["case"] == case["case"] and r["run"] > 0]
            if not samples:
                continue
            hung = [r for r in samples if r["hung"]]
            finished = [r for r in samples if not r["hung"]]
            at_hang = [r[key] for r in hung]
            elapsed = [1000 * r["elapsed_s"] for r in finished]
            at = f"{median(at_hang):g} [{min(at_hang)}~{max(at_hang)}]" if at_hang else "-"
            took = f"{median(elapsed):.2f} [{min(elapsed):.2f}~{max(elapsed):.2f}]" if elapsed else "-"
            retries = f"{median(r['retries'] for r in finished):g}" if task == "transfer" and finished else "-"
            cpu = f"{median(r['cpu_s'] for r in hung):.3f}" if hung else "-"
            print(
                f"{task:12} {case['case']:4} {len(samples):6} {len(hung):4} {sum(v == 0 for v in at_hang):12}"
                f" {at} {took} {retries} {cpu}",
                file=sys.stderr,
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", nargs="+", choices=TASKS, default=list(TASKS))
    parser.add_argument("--trials", type=positive_int, default=10)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="조건마다 워밍업 1회와 검증 2회만, 크기를 1/10로 줄여 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if not sys._is_gil_enabled():
        parser.error("이 실험은 GIL이 켜진 상태에서 실행한다(uv run --python 3.14.2+gil).")
    if len(args.tasks) != len(set(args.tasks)):
        parser.error("작업을 중복 없이 지정한다.")
    if args.smoke:
        args.trials = 2
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    return args


def main() -> int:
    args = parse_args()
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-deadlock" + ("-smoke" if args.smoke else "")
    version = platform.python_version() + ("t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "")
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    stack_dir = directory / f"{run_id}-stacks"
    stack_dir.mkdir()
    environment = collect_environment(
        args, started, sources=("deadlock_lab.py", "deadlock_kernels.py", "release_lab.py"),
    )
    environment.update(purpose="deadlock", conditions={
        "hang_s": SMOKE_HANG_S if args.smoke else HANG_S, "child_timeout_s": CHILD_TIMEOUT_S,
        "scale": SMOKE_SCALE if args.smoke else 1, "balance": BALANCE, "db_s": DB_S, "backoff_s": BACKOFF_S,
        "philosophers": PHILOSOPHERS, "meals": MEALS, "think_s": THINK_S, "pick_s": PICK_S, "eat_s": EAT_S,
        "transfer_cases": TRANSFER_CASES, "philosopher_cases": PHILOSOPHER_CASES,
    })
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    cases = [(task, case) for task in args.tasks for case in TASKS[task]]
    rows = []
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.trials + 1):
            order = cases if run % 2 == 0 else list(reversed(cases))
            for position, (task, case) in enumerate(order):
                spec = make_spec(task, case, args.smoke, stack_dir / f"{task}-{case['case']}-run{run}.txt")
                row = run_in_child(spec)
                size = spec.get("per_thread", spec.get("meals"))
                row.update(
                    lang="python", runtime=f"cpython-{version}",
                    variant=";".join(f"{k}={v}" for k, v in case.items() if k not in ("case", "per_thread")),
                    model="threads", workers=2 if task == "transfer" else PHILOSOPHERS, task=task, size=size,
                    params={k: v for k, v in spec.items() if k not in ("task", "case", "stack_path")},
                    case=case["case"], run_id=run_id, environment_file=env_path.name,
                    run=run, order_index=position, validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                stream.flush()
                rows.append(row)
                print(f"[{run}/{args.trials}] {task} {case['case']}번: {describe(row)}", file=sys.stderr)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({task} {case['case']}번). errors와 child_error를 확인한다.",
                          file=sys.stderr)
                    return 1
    if not any(stack_dir.iterdir()):
        stack_dir.rmdir()
    if args.smoke:
        print("작은 입력의 실행·저장 검증 완료. 멈춤 여부나 걸린 시간을 판단하지 않는다.", file=sys.stderr)
    print_deadlock_summary(rows)
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--child"]:
        child_main(sys.argv[2])
    try:
        raise SystemExit(main())
    except (OSError, NotImplementedError) as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
