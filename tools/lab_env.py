"""실험마다 같은 항목으로 측정 환경을 기록한다.

01 실험 bench.py와 02 실험 *_lab.py에 같은 코드가 있었고, 03 실험에서 세 번째로 쓰게 되어 여기로 옮겼다.
끝난 01·02 실험의 코드는 재실행 결과가 바뀌지 않도록 그대로 둔다.
"""

from datetime import datetime
import hashlib
import os
from pathlib import Path
import platform
import shlex
import subprocess
import sys
import sysconfig


def command_info(command: list[str], cwd: Path | None = None) -> dict:
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=10)
        return {"returncode": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": str(error)}


def collect_environment(
    *, started: datetime, purpose: str, validation: bool, config: dict, conditions: dict,
    experiment_dir: Path, sources: list[Path],
) -> dict:
    return {
        "started_at": started.isoformat(),
        "timezone": str(started.tzinfo),
        "purpose": purpose,
        "validation": validation,
        "command": shlex.join([sys.executable, *sys.argv]),
        "python": sys.version,
        "executable": sys.executable,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "logical_cpus": os.cpu_count(),
        "available_cpus": os.process_cpu_count(),
        "gil_enabled": sys._is_gil_enabled(),
        "free_threaded_build": bool(sysconfig.get_config_var("Py_GIL_DISABLED")),
        "config": config,
        "conditions": conditions,
        "commit": command_info(["git", "rev-parse", "HEAD"], experiment_dir),
        "working_tree": command_info(["git", "status", "--short"], experiment_dir),
        "source_sha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sources},
        "hardware": command_info([
            "sysctl", "machdep.cpu.brand_string", "hw.physicalcpu", "hw.logicalcpu",
            "hw.perflevel0.name", "hw.perflevel0.physicalcpu",
            "hw.perflevel1.name", "hw.perflevel1.physicalcpu",
        ]),
        "os_version": command_info(["sw_vers", "-productVersion"]),
        "power": command_info(["pmset", "-g", "batt"]),
        "uv": command_info(["uv", "--version"]),
    }
