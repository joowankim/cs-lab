# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = []
# ///
"""동일 free-threaded 빌드의 GIL 설정을 조건마다 바꿔 비교한다."""

from contextlib import ExitStack
from dataclasses import asdict
from datetime import datetime
import json
import os
from pathlib import Path
import platform
import random
import subprocess
import sys
import sysconfig
from zoneinfo import ZoneInfo

from bench import Case, EXPERIMENT_DIR, build_cases, collect_environment, measure, parse_args, print_summary
from workloads import reference_count, require_gil


def serve_samples() -> int:
    """측정 프로세스 내부 통신용 진입점. 각 요청을 하나씩 처리한다."""
    expected_gil = os.environ["PYTHON_GIL"] == "1"
    actual_gil = require_gil(expected_gil)
    if not sysconfig.get_config_var("Py_GIL_DISABLED"):
        raise RuntimeError("free-threaded 빌드가 아니다.")
    metadata = {
        "runtime": f"cpython-{platform.python_version()}t",
        "python": sys.version,
        "variant": "gil=on" if actual_gil else "gil=off",
        "gil_enabled": actual_gil,
        "free_threaded_build": True,
        "PYTHON_GIL": os.environ["PYTHON_GIL"],
        "pid": os.getpid(),
        "executable": sys.executable,
        "resolved_executable": str(Path(sys.executable).resolve()),
        "base_prefix": sys.base_prefix,
    }
    print(json.dumps(metadata), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        row = measure(Case(**request["case"]), request["tasks"], expected_gil, request["expected"])
        row.update(runtime=metadata["runtime"], variant=metadata["variant"], measurement_pid=os.getpid())
        print(json.dumps(row), flush=True)
    return 0


def read_response(process: subprocess.Popen) -> dict:
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(f"측정 프로세스 {process.pid}가 응답하지 않고 종료했다.")
    try:
        return json.loads(line)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"측정 프로세스 {process.pid}의 응답이 JSON이 아니다.") from error


def print_comparison_summary(rows: list[dict]) -> None:
    for runtime, variant in sorted({(r["runtime"], r["variant"]) for r in rows}):
        print(f"{runtime} {variant}", file=sys.stderr)
        print_summary([r for r in rows if (r["runtime"], r["variant"]) == (runtime, variant)])


def main() -> int:
    args = parse_args(compare_gil=True)
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    purpose = "smoke" if args.smoke else "benchmark"
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-gil-compare-{purpose}"
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{platform.python_version()}t.jsonl"
    expected = {n: reference_count(n) for n in args.sizes} if args.task == "cpu" else {None: 1}
    conditions = [(case, gil) for case in build_cases(args) for gil in (False, True)]
    random.Random(args.seed).shuffle(conditions)
    rows = []

    with ExitStack() as stack:
        processes, runtimes = {}, {}
        for gil in (False, True):
            process = stack.enter_context(subprocess.Popen(
                [sys.executable, "-u", str(Path(__file__).resolve()), "--_serve"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
                env={**os.environ, "PYTHON_GIL": "1" if gil else "0"},
            ))
            metadata = read_response(process)
            if metadata["gil_enabled"] is not gil or not metadata["free_threaded_build"]:
                raise RuntimeError("측정 프로세스의 GIL 설정이나 빌드가 요청과 다르다.")
            if metadata["resolved_executable"] != str(Path(sys.executable).resolve()):
                raise RuntimeError("두 조건이 같은 Python 실행 파일을 사용하지 않는다.")
            processes[gil] = process
            runtimes["gil=on" if gil else "gil=off"] = metadata

        environment = collect_environment(
            args, started, sys._is_gil_enabled(),
            sources=("compare_gil.py", "bench.py", "models.py", "workloads.py"),
        )
        environment.update(
            role="comparison_controller", comparison="gil_same_build",
            measurement_runtimes=runtimes,
        )
        with env_path.open("x", encoding="utf-8") as stream:
            json.dump(environment, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
        with result_path.open("x", encoding="utf-8") as stream:
            for run in range(args.repeats + 1):
                order = conditions if run % 2 == 0 else list(reversed(conditions))
                for position, (case, gil) in enumerate(order):
                    process = processes[gil]
                    request = {"case": asdict(case), "tasks": args.tasks, "expected": expected[case.n]}
                    process.stdin.write(json.dumps(request) + "\n")
                    process.stdin.flush()
                    row = read_response(process)
                    row.update(
                        lang="python", run_id=run_id, environment_file=env_path.name,
                        purpose=purpose, comparison="gil_same_build",
                        run=run, order_index=position, seed=args.seed,
                    )
                    line = json.dumps(row, ensure_ascii=False)
                    stream.write(line + "\n")
                    stream.flush()
                    print(line, flush=True)
                    rows.append(row)
                    if not row["valid"]:
                        print(row["error"], file=sys.stderr)
                        return 1
    if args.smoke:
        print("GIL 두 조건의 기능 검증 완료. 성능 가설은 판단하지 않는다.", file=sys.stderr)
    else:
        print_comparison_summary(rows)
    return 0


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--_serve"]:
            raise SystemExit(serve_samples())
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"GIL 비교 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
