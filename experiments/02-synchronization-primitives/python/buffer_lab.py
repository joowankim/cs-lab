# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""조건 변수 버퍼에서 take()가 깨어난 뒤 jobs를 다시 확인하는지에 따라 남는 작업자 수와 처리 시간을 기록한다."""

import argparse
from collections import Counter, deque
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
from time import perf_counter, process_time, sleep
from zoneinfo import ZoneInfo

from buffer_kernels import CAPACITY, TAKES, WAKES, Buffer, put
from release_lab import EXPERIMENT_DIR, collect_environment, positive_int


JOB_S = 0.02
UPLOADS = 3
BURST = 20
WORKER_COUNTS = (2, 4)
SETTLE_TIMEOUT_S = 10
WATCHDOG_S = 120
# README 표의 번호 순서다. 1~4번이 if, 5~8번이 while이고, take()만 다른 짝은 번호가 4 차이 난다.
CASES = [(take, workers, wake) for take in TAKES for workers in WORKER_COUNTS for wake in WAKES]
# 작업자를 끝낼 때만 넣는 표시다. 측정하는 작업이 아니다.
STOP = object()


class RecordingCondition:
    """실험 대상 Condition을 감싸 아직 깨우지 않은 대기 수와 빈 jobs에서 깨어난 횟수를 센다. 깨우는 순서는 감싼 Condition이 정한다."""

    def __init__(self, jobs: deque):
        self.inner = threading.Condition()
        self.jobs = jobs
        self.workers: frozenset[threading.Thread] = frozenset()
        # 아래 값은 모두 조건 변수의 락을 쥔 채 읽고 바꾼다.
        self.phase = "start"
        self.unnotified = 0
        self.empty_wakeups: Counter[str] = Counter()

    def __enter__(self):
        return self.inner.__enter__()

    def __exit__(self, *exc_info):
        return self.inner.__exit__(*exc_info)

    def wait(self) -> bool:
        # 실험 코드는 시간 제한 없이 기다리므로 notify를 받아야만 돌아온다.
        self.unnotified += 1
        notified = self.inner.wait()
        if threading.current_thread() in self.workers and not self.jobs:
            self.empty_wakeups[self.phase] += 1
        return notified

    def notify(self, n: int = 1) -> None:
        # Condition.notify(n)은 기다리는 스레드 중 앞에서부터 최대 n개를 깨운다.
        self.unnotified -= min(n, self.unnotified)
        self.inner.notify(n)

    def notify_all(self) -> None:
        self.unnotified = 0
        self.inner.notify_all()


class ThreadErrors:
    """작업자 스레드를 끝낸 예외를 threading.excepthook 자리에서 받아 남긴다. 기본 훅과 달리 표준 오류에 찍지 않는다."""

    def __init__(self, cond: RecordingCondition):
        self.cond = cond
        self.records: list[dict] = []

    def __call__(self, args) -> None:
        # 죽는 스레드가 끝나야 settle()이 다음 단계로 넘어가므로 phase는 그동안 바뀌지 않는다.
        self.records.append({
            "thread": args.thread.name if args.thread else None, "type": args.exc_type.__name__,
            "message": str(args.exc_value), "phase": self.cond.phase,
        })


def run_trial(
    take: Callable, wake: str, workers: int, *,
    uploads: int = UPLOADS, burst: int = BURST, job_s: float = JOB_S,
) -> dict:
    jobs: deque = deque()
    cond = RecordingCondition(jobs)
    buf = Buffer(jobs, cond, wake)
    errors = ThreadErrors(cond)
    last_job = uploads + burst
    done_lock = threading.Lock()
    done: list[tuple[int, str]] = []
    burst_done = threading.Event()
    burst_finished_at: list[float] = []

    def work() -> None:
        # 문제 상황 2의 worker()다. 썸네일 작업은 job_s초 쉬는 것으로 대신하고, STOP을 꺼내면 끝난다.
        while True:
            job = take(buf)
            if job is STOP:
                return
            sleep(job_s)
            with done_lock:
                done.append((job, threading.current_thread().name))
                if len(done) == last_job:
                    burst_finished_at.append(perf_counter())
                    burst_done.set()

    threads = [threading.Thread(target=work, name=f"worker-{i}", daemon=True) for i in range(1, workers + 1)]
    cond.workers = frozenset(threads)

    def set_phase(name: str) -> None:
        with cond:
            cond.phase = name

    def settle(expected_done: int) -> int:
        # 살아 있는 작업자가 모두 깨우지 않은 대기에 들어가고 꺼낸 작업이 다 끝나면 살아 있는 수를 돌려준다.
        # 락을 쥔 동안에는 대기에 들어가거나 깨어날 수 없고, 살아 있는 수는 줄기만 하므로 같다고 본 순간이 안정 상태다.
        deadline = perf_counter() + SETTLE_TIMEOUT_S
        while perf_counter() < deadline:
            with cond:
                alive = sum(t.is_alive() for t in threads)
                with done_lock:
                    finished = len(done)
                if not jobs and cond.unnotified == alive and finished == expected_done:
                    return alive
            sleep(0.001)
        raise TimeoutError(f"{cond.phase} 단계가 {SETTLE_TIMEOUT_S}초 안에 가라앉지 않았다.")

    alive_at_start = alive_after_burst = burst_s = cpu_s = timed_out = None
    alive_after_uploads: list[int] = []
    previous_hook = threading.excepthook
    threading.excepthook = errors
    # 끝나지 않는 실행은 스택을 남기고 멈춘다. 그때까지 저장한 원자료는 남는다.
    faulthandler.dump_traceback_later(WATCHDOG_S, exit=True)
    try:
        for thread in threads:
            thread.start()
        alive_at_start = settle(0)
        for job in range(1, uploads + 1):
            set_phase(f"upload{job}")
            put(buf, job)
            alive_after_uploads.append(settle(job))
        set_phase("burst")
        # 측정 구간은 첫 put() 직전부터 마지막 작업의 처리가 끝난 순간까지다. 작업자 생성과 종료는 넣지 않는다.
        cpu_before = process_time()
        started = perf_counter()
        for job in range(uploads + 1, last_job + 1):
            put(buf, job)
        if not burst_done.wait(SETTLE_TIMEOUT_S):
            raise TimeoutError(f"작업 {burst}개가 {SETTLE_TIMEOUT_S}초 안에 끝나지 않았다.")
        burst_s = burst_finished_at[0] - started
        cpu_s = process_time() - cpu_before
        alive_after_burst = settle(last_job)
    except TimeoutError as exc:
        timed_out = str(exc)
    finally:
        set_phase("stop")
        with cond:
            # 살아 있는 작업자 수만큼 STOP을 한 번에 넣고 모두 깨운다. if로 기다리는 작업자도 빈 jobs를 만나지 않는다.
            jobs.extend([STOP] * sum(t.is_alive() for t in threads))
            cond.notify_all()
        for thread in threads:
            thread.join(timeout=SETTLE_TIMEOUT_S)
        threading.excepthook = previous_hook
        faulthandler.cancel_dump_traceback_later()

    finished_jobs = sorted(job for job, _ in done)
    index_errors = Counter(e["phase"] for e in errors.records if e["type"] == "IndexError")
    # IndexError로 작업자가 끝나는 것만 관찰값이다. 그 밖의 예외나 멈춤은 실행 틀이나 실험 코드의 문제다.
    valid = (
        timed_out is None and not any(t.is_alive() for t in threads)
        and finished_jobs == list(range(1, last_job + 1))
        and all(e["type"] == "IndexError" for e in errors.records)
    )
    takers = dict(done)
    return {
        "check": len(done), "expected_check": last_job, "valid": valid,
        "wall_s": burst_s, "cpu_s": cpu_s,
        "alive_at_start": alive_at_start,
        "alive_after_uploads": alive_after_uploads,
        "alive_after_burst": alive_after_burst,
        # 업로드마다 작업을 꺼내 처리한 스레드 이름이다.
        "upload_takers": [takers.get(job) for job in range(1, uploads + 1)],
        "index_errors": sum(index_errors.values()),
        "index_errors_by_phase": dict(index_errors),
        # 작업자가 깨어났는데 jobs가 비어 있던 횟수다. if에서는 곧 IndexError가 되고, while에서는 다시 기다린다.
        "empty_wakeups": sum(cond.empty_wakeups.values()),
        "empty_wakeups_by_phase": dict(cond.empty_wakeups),
        "thread_errors": errors.records,
        "timed_out": timed_out,
    }


def print_buffer_summary(rows: list[dict]) -> None:
    print("#  take  wake       workers trials alive_after_uploads(pattern:trials) index_errors(count:trials) "
          "wall_s(median [min~max]) empty_wakeups(median [min~max])", file=sys.stderr)
    medians = {}
    for number, (take, workers, wake) in enumerate(CASES, 1):
        samples = [r for r in rows if (r["take"], r["workers"], r["wake"]) == (take, workers, wake) and r["run"] > 0]
        if not samples:
            continue
        patterns = Counter("·".join(map(str, r["alive_after_uploads"])) for r in samples)
        errors = Counter(r["index_errors"] for r in samples)
        seconds = [r["wall_s"] for r in samples]
        empties = [r["empty_wakeups"] for r in samples]
        medians[number] = median(seconds)
        print(
            f"{number}  {take:5} {wake:10} {workers:7} {len(samples):6}"
            f" {dict(patterns)} {dict(sorted(errors.items()))}"
            f" {median(seconds):.3f} [{min(seconds):.3f}~{max(seconds):.3f}]"
            f" {median(empties):g} [{min(empties)}~{max(empties)}]",
            file=sys.stderr,
        )
    pairs = [(number, number + 4) for number in range(1, 5) if number in medians and number + 4 in medians]
    if pairs:
        print("pair wall_s_median_ratio(if/while)", file=sys.stderr)
    for slow, fast in pairs:
        print(f"{slow}/{fast}  {medians[slow] / medians[fast]:.2f}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--takes", nargs="+", choices=TAKES, default=list(TAKES))
    parser.add_argument("--wakes", nargs="+", choices=WAKES, default=list(WAKES))
    parser.add_argument("--workers", nargs="+", type=int, choices=WORKER_COUNTS, default=list(WORKER_COUNTS))
    parser.add_argument("--trials", type=positive_int, default=30)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="조건마다 워밍업 1회와 검증 2회만 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if any(len(values) != len(set(values)) for values in (args.takes, args.wakes, args.workers)):
        parser.error("take, 깨우기 방법, 작업자 수를 중복 없이 지정한다.")
    if args.smoke:
        args.trials = 2
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    return args


def main() -> int:
    args = parse_args()
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-buffer" + ("-smoke" if args.smoke else "")
    version = platform.python_version() + ("t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "")
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(args, started, sources=("buffer_lab.py", "buffer_kernels.py", "release_lab.py"))
    environment.update(purpose="wakeup", conditions={
        "capacity": CAPACITY, "job_s": JOB_S, "uploads": UPLOADS, "burst": BURST,
        "worker_counts": list(WORKER_COUNTS), "settle_timeout_s": SETTLE_TIMEOUT_S,
    })
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    cases = [c for c in CASES if c[0] in args.takes and c[1] in args.workers and c[2] in args.wakes]
    rows = []
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.trials + 1):
            order = cases if run % 2 == 0 else list(reversed(cases))
            for position, (take, workers, wake) in enumerate(order):
                row = run_trial(TAKES[take], wake, workers)
                row.update(
                    lang="python", runtime=f"cpython-{version}",
                    variant=f"take={take};wake={wake};workers={workers}",
                    model="threads", workers=workers, task="wakeup", size=BURST,
                    params={"capacity": CAPACITY, "job_s": JOB_S, "uploads": UPLOADS, "burst": BURST},
                    case=CASES.index((take, workers, wake)) + 1, take=take, wake=wake,
                    run_id=run_id, environment_file=env_path.name,
                    run=run, order_index=position, gil_enabled=sys._is_gil_enabled(), validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                stream.flush()
                rows.append(row)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({take}, {wake}, {workers}). thread_errors와 timed_out을 확인한다.",
                          file=sys.stderr)
                    return 1
    if args.smoke:
        print("작은 입력의 실행·저장 검증 완료. 남는 작업자 수나 처리 시간을 판단하지 않는다.", file=sys.stderr)
    print_buffer_summary(rows)
    # 고친 take()에서 작업자가 예외로 끝나면 원자료를 보존한 뒤 실패로 알린다.
    return int(any(r["take"] == "while" and r["run"] > 0 and r["thread_errors"] for r in rows))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, NotImplementedError) as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
