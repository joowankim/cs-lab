# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""상한 도구에서 release()가 한 번 더 불릴 때 동시 호출 수와 오류 위치를 기록한다."""

import argparse
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import faulthandler
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
from statistics import median
import subprocess
import sys
import sysconfig
import threading
from time import perf_counter, sleep
from zoneinfo import ZoneInfo

from release_kernels import CALLERS, LIMITS, make_slots


EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REQUESTS = 40
WORKERS = 8
TIMEOUT_CALLS = (5, 15, 25)
CALL_S = 0.05
WATCHDOG_S = 120


class FakeApi:
    """동시에 들어와 있는 호출 수를 세는 가짜 외부 API. 측정용 락은 실험 대상과 따로 둔다."""

    def __init__(self, timeout_calls: tuple[int, ...], call_s: float):
        self.timeout_calls = frozenset(timeout_calls)
        self.call_s = call_s
        self._lock = threading.Lock()
        self.entered = 0
        self.in_flight = 0
        self.max_in_flight = 0
        self.call_no: dict[int, int] = {}
        self.queued: list[int] = []

    def send(self, req: int) -> str:
        with self._lock:
            self.entered += 1
            number = self.entered
            self.call_no[req] = number
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            sleep(self.call_s)
        finally:
            with self._lock:
                self.in_flight -= 1
        if number in self.timeout_calls:
            raise TimeoutError(f"가짜 API 타임아웃: {number}번째 호출")
        return "ok"

    def send_later(self, req: int) -> str:
        with self._lock:
            self.queued.append(req)
        return "queued"


class RecordingSlots:
    """실험 대상 도구를 감싸 요청별 acquire()·release() 결과를 남긴다. 판정은 감싼 도구가 한다."""

    def __init__(self, inner):
        self.inner = inner
        self.current = threading.local()
        # list.append는 따로 잠그지 않는다. 기록이 실행 순서에 주는 영향을 줄이려는 선택이다.
        self.events: list[tuple[int, str, str | None]] = []

    def acquire(self) -> bool:
        acquired = self.inner.acquire()
        self.events.append((self.current.req, "acquire", None))
        return acquired

    def release(self) -> None:
        try:
            self.inner.release()
        except Exception as exc:
            self.events.append((self.current.req, "release", type(exc).__name__))
            raise
        self.events.append((self.current.req, "release", None))

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc_info) -> None:
        self.release()


def final_state(inner) -> int | str:
    if hasattr(inner, "_value"):
        # Semaphore·BoundedSemaphore의 CPython 내부 카운터다. 공개 API가 아니므로 진단에만 쓴다.
        return inner._value
    if inner.acquire(blocking=False):
        inner.release()
        return "unlocked"
    return "locked"


def run_trial(
    call_api: Callable, slots_factory: Callable[[str], object], kind: str, *,
    requests: int = REQUESTS, workers: int = WORKERS,
    timeout_calls: tuple[int, ...] = TIMEOUT_CALLS, call_s: float = CALL_S,
) -> dict:
    api = FakeApi(timeout_calls, call_s)
    slots = RecordingSlots(slots_factory(kind))

    def handle(req: int) -> dict:
        slots.current.req = req
        try:
            return {"req": req, "result": call_api(slots, api, req), "error": None}
        except Exception as exc:
            return {"req": req, "result": None, "error": f"{type(exc).__name__}: {exc}"}

    # 끝나지 않는 실행은 스택을 남기고 멈춘다. 그때까지 저장한 원자료는 남는다.
    faulthandler.dump_traceback_later(WATCHDOG_S, exit=True)
    started = perf_counter()
    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            outcomes = list(executor.map(handle, range(1, requests + 1)))
    finally:
        faulthandler.cancel_dump_traceback_later()
    wall_s = perf_counter() - started

    releases: dict[int, list[str]] = {}
    for req, op, error in slots.events:
        if op == "release":
            releases.setdefault(req, []).append(error or "ok")
    calls = []
    for outcome in outcomes:
        number = api.call_no.get(outcome["req"])
        calls.append({
            "req": outcome["req"], "call_no": number,
            "timeout": number in api.timeout_calls, "releases": releases.get(outcome["req"], []),
            "result": outcome["result"], "error": outcome["error"],
        })
    errors = [c for c in calls if c["error"]]
    # release()가 낸 오류만 관찰값이다. 그 밖의 오류는 실행 틀이나 작성 중인 코드의 문제다.
    other_errors = [c for c in errors if all(r == "ok" for r in c["releases"])]
    valid = (api.entered == requests and len(api.call_no) == requests and not other_errors)
    timeout_calls_seen = [c for c in calls if c["timeout"]]
    return {
        "check": api.entered, "expected_check": requests, "valid": valid,
        "wall_s": wall_s, "max_in_flight": api.max_in_flight, "limit": LIMITS[kind],
        "final_state": final_state(slots.inner),
        "error_types": dict(Counter(c["error"].split(":", 1)[0] for c in errors)),
        # 요청 단위가 아니라 release() 호출 단위로 센 예외 수다. 오류 횟수 판단은 이 값으로 한다.
        "release_errors": dict(Counter(r for rs in releases.values() for r in rs if r != "ok")),
        "errors_in_timeout_calls": sum(c["timeout"] for c in errors),
        # 타임아웃이 아닌 호출은 API가 성공한다. 이 값은 API는 성공했는데 call_api()가 오류로 끝난 호출 수다.
        "errors_in_other_calls": sum(not c["timeout"] for c in errors),
        # 타임아웃 난 호출의 release() 결과를 부른 순서대로 남긴다. 고치지 않은 코드에서는 두 번이다.
        "timeout_releases": [c["releases"] for c in sorted(timeout_calls_seen, key=lambda c: c["call_no"])],
        "queued": len(api.queued),
        "calls": calls,
    }


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("1 이상의 정수가 필요하다.")
    return number


def command_info(command: list[str], cwd: Path | None = None) -> dict:
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=10)
        return {"returncode": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": str(error)}


def collect_environment(
    args: argparse.Namespace, started: datetime,
    sources: tuple[str, ...] = ("release_lab.py", "release_kernels.py"),
) -> dict:
    # 01 실험 bench.py의 환경 기록과 같은 항목이다. 세 번째로 쓰게 되면 tools/로 옮긴다.
    return {
        "started_at": started.isoformat(),
        "timezone": "Asia/Seoul",
        "purpose": "double-release",
        "validation": args.smoke,
        "command": shlex.join([sys.executable, *sys.argv]),
        "python": sys.version,
        "executable": sys.executable,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "logical_cpus": os.cpu_count(),
        "available_cpus": os.process_cpu_count(),
        "gil_enabled": sys._is_gil_enabled(),
        "free_threaded_build": bool(sysconfig.get_config_var("Py_GIL_DISABLED")),
        "switch_interval_s": sys.getswitchinterval(),
        "config": {**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None},
        "conditions": {"requests": REQUESTS, "workers": WORKERS, "timeout_calls": list(TIMEOUT_CALLS),
                       "call_s": CALL_S, "limits": LIMITS},
        "commit": command_info(["git", "rev-parse", "HEAD"], EXPERIMENT_DIR),
        "working_tree": command_info(["git", "status", "--short"], EXPERIMENT_DIR),
        "source_sha256": {
            name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in sources
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


def print_release_summary(rows: list[dict]) -> None:
    print("code      kind      trials max_in_flight(median [min~max]) errors(timeout/other) "
          "second_release(raised/ok) release_errors(count:trials) final_state", file=sys.stderr)
    for code, kind in sorted({(r["code"], r["kind"]) for r in rows}):
        samples = [r for r in rows if (r["code"], r["kind"]) == (code, kind) and r["run"] > 0]
        if not samples:
            continue
        peaks = [r["max_in_flight"] for r in samples]
        seconds = [releases[1] for r in samples for releases in r["timeout_releases"] if len(releases) > 1]
        raised = sum(s != "ok" for s in seconds)
        states = Counter(str(r["final_state"]) for r in samples)
        per_trial = Counter(sum(r["release_errors"].values()) for r in samples)
        print(
            f"{code:9} {kind:9} {len(samples):6} {median(peaks):g} [{min(peaks)}~{max(peaks)}]"
            f" {sum(r['errors_in_timeout_calls'] for r in samples)}/{sum(r['errors_in_other_calls'] for r in samples)}"
            f" {raised}/{len(seconds) - raised}"
            f" {dict(sorted(per_trial.items()))}"
            f" {dict(states)}",
            file=sys.stderr,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codes", nargs="+", choices=CALLERS, default=list(CALLERS))
    parser.add_argument("--kinds", nargs="+", choices=LIMITS, default=list(LIMITS))
    parser.add_argument("--trials", type=positive_int, default=100)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="조건마다 워밍업 1회와 검증 2회만 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if len(args.codes) != len(set(args.codes)) or len(args.kinds) != len(set(args.kinds)):
        parser.error("코드와 상한 도구를 중복 없이 지정한다.")
    if args.smoke:
        args.trials = 2
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    return args


def main() -> int:
    args = parse_args()
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-release" + ("-smoke" if args.smoke else "")
    version = platform.python_version() + ("t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "")
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(collect_environment(args, started), stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    cases = [(code, kind) for code in args.codes for kind in args.kinds]
    rows = []
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.trials + 1):
            order = cases if run % 2 == 0 else list(reversed(cases))
            for position, (code, kind) in enumerate(order):
                row = run_trial(CALLERS[code], make_slots, kind)
                row.update(
                    lang="python", runtime=f"cpython-{version}", variant=f"code={code};kind={kind}",
                    model="threads", workers=WORKERS, task="double-release", size=REQUESTS,
                    params={"limit": LIMITS[kind], "call_s": CALL_S, "timeout_calls": list(TIMEOUT_CALLS)},
                    code=code, kind=kind, run_id=run_id, environment_file=env_path.name,
                    run=run, order_index=position, gil_enabled=sys._is_gil_enabled(), validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                stream.flush()
                rows.append(row)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({code}, {kind}). calls를 확인한다.", file=sys.stderr)
                    return 1
    if args.smoke:
        print("작은 입력의 실행·저장 검증 완료. 오류 빈도나 수정 완료를 판단하지 않는다.", file=sys.stderr)
    print_release_summary(rows)
    # 수정본에서 상한을 넘거나, 오류가 나거나, 요청마다 release()가 한 번이 아니면 원자료를 보존한 뒤 실패로 알린다.
    return int(any(
        r["code"] == "candidate" and r["run"] > 0 and (
            r["max_in_flight"] > r["limit"] or r["error_types"] or r["release_errors"]
            or any(len(c["releases"]) != 1 for c in r["calls"])
        )
        for r in rows
    ))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, NotImplementedError) as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
