# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["pymysql==1.2.3"]
# ///
"""같은 요청 여러 개를 같은 순간에 보내고, 요청마다 결과·오류·다시 시도·걸린 시간과 끝난 뒤 표를 기록한다.

묶음 ②의 문제 상황 2-1(동시에 몰린 포인트 차감)과 묶음 ③(리워드 두 번 지급을 막는 방법 비교)에 쓴다.
③의 막는 SQL은 사람이 쓴 판(scenes의 note)을 그대로 옮겼다.
"""

import argparse
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from functools import partial
import json
from pathlib import Path
import platform
import statistics
import sys
import threading
from time import perf_counter, sleep
from typing import Callable
from zoneinfo import ZoneInfo

EXPERIMENT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EXPERIMENT_DIR.parent.parent
sys.path.insert(0, str(REPO_DIR / "tools"))
from lab_env import collect_environment, command_info  # noqa: E402

LOCK_TIMEOUT_S = 5  # innodb_lock_wait_timeout. 묶음 ①②의 순서표와 같다.
REQUESTS = 10  # 같은 순간에 보내는 요청 수
PAUSE_S = 0.05  # 읽은 뒤 쓰기 전까지 앱이 일하는 시간
JOIN_S = 60  # 요청 하나가 이보다 오래 끝나지 않으면 실행 오류로 본다.
SCHEMA = "lab"


def error_code(error: Exception) -> int | None:
    # PyMySQL 오류는 (오류 번호, 메시지)를 args로 갖는다. 번호가 없으면 DB가 낸 오류가 아니다.
    return error.args[0] if error.args and isinstance(error.args[0], int) else None


def error_info(error: Exception) -> dict:
    return {"type": type(error).__name__, "code": error_code(error), "message": str(error).strip()}


def deduct(cursor, pause_s: float) -> tuple[str, dict | None]:
    # 문제 상황 2-1: 읽은 잔액에서 앱이 100을 빼 계산한 값을 쓴다.
    cursor.execute("START TRANSACTION")
    cursor.execute("SELECT balance FROM points WHERE user_id = 7")
    balance = cursor.fetchone()[0]
    sleep(pause_s)
    cursor.execute("UPDATE points SET balance = %s WHERE user_id = 7", (balance - 100,))
    cursor.execute("COMMIT")
    return "done", None


COUNT = "SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1"
INSERT = "INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000)"
PAY = "UPDATE points SET balance = balance + 1000 WHERE user_id = 7"
BUMP = "UPDATE points SET version = version + 1 WHERE user_id = 7 AND version = %s"
LOCK_POINTS = "SELECT balance FROM points WHERE user_id = 7 FOR UPDATE"
# 사람이 처음 쓴 낙관적 락 두 판은 비교할 version을 읽지 않고 0으로 박아 두었다.
PAY_IF_ZERO = "UPDATE points SET balance = balance + 1000 WHERE user_id = 7 AND version = 0"
VERSION_UP = "UPDATE points SET version = version + 1 WHERE user_id = 7"


def reward(cursor, pause_s: float, *, parent_lock: bool = False, count_lock: bool = False,
           lock_after_count: bool = False, version: bool = False, zero_version: str | None = None,
           unique: bool = False) -> tuple[str, dict | None]:
    """문제 상황 3의 지급 요청 하나. 'granted'(지급하고 커밋), 'already'(이미 받음으로 되돌림),
    'conflict'(version 확인이 0행이라 되돌림, 처음부터 다시 할 수 있음), 'unpaid'(잔액을 못 올린 채 커밋) 중 하나와,
    앱이 처리한 DB 오류를 돌려준다.

    zero_version은 사람이 쓴 낙관적 락의 앞선 두 판이다. 'first'는 잔액 UPDATE에 version = 0만 붙이고 결과를
    보지 않고 커밋하고, 'fixed'는 그 UPDATE가 0행이면 되돌리고 1행이면 version을 1 올린 뒤 커밋한다."""
    cursor.execute("START TRANSACTION")
    if parent_lock:
        cursor.execute(LOCK_POINTS)
        cursor.fetchall()
    if version:
        cursor.execute("SELECT version FROM points WHERE user_id = 7")
        seen = cursor.fetchone()[0]
    cursor.execute(COUNT + (" FOR UPDATE" if count_lock else ""))
    count = cursor.fetchone()[0]
    if lock_after_count:
        # COUNT 다음(3번째 문장)에 points 행을 잠근다. COUNT는 잠그기 전에 읽은 값 그대로다.
        cursor.execute(LOCK_POINTS)
        cursor.fetchall()
    if count > 0:
        cursor.execute("ROLLBACK")
        return "already", None
    sleep(pause_s)
    try:
        cursor.execute(INSERT)
    except Exception as error:
        if unique and error_code(error) == 1062:
            cursor.execute("ROLLBACK")
            return "already", error_info(error)
        raise
    if version and cursor.execute(BUMP, (seen,)) == 0:
        cursor.execute("ROLLBACK")
        return "conflict", None
    if zero_version:
        paid = cursor.execute(PAY_IF_ZERO)
        if zero_version == "first":
            cursor.execute("COMMIT")
            return ("granted" if paid else "unpaid"), None
        if paid == 0:
            cursor.execute("ROLLBACK")
            return "conflict", None
        cursor.execute(VERSION_UP)
        cursor.execute("COMMIT")
        return "granted", None
    cursor.execute(PAY)
    cursor.execute("COMMIT")
    return "granted", None


POINTS_ONLY = (
    "DROP TABLE IF EXISTS rewards",
    "DROP TABLE IF EXISTS points",
    "CREATE TABLE points (user_id INT PRIMARY KEY, balance INT NOT NULL)",
    "INSERT INTO points (user_id, balance) VALUES (7, 1000)",
)


def reward_setup(unique: bool, version: int = 0) -> tuple[str, ...]:
    key = "UNIQUE KEY" if unique else "KEY"
    return (
        "DROP TABLE IF EXISTS rewards",
        "DROP TABLE IF EXISTS points",
        "CREATE TABLE points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)",
        f"INSERT INTO points (user_id, balance, version) VALUES (7, 0, {version})",
        "CREATE TABLE rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, "
        f"amount INT NOT NULL, {key} idx_user_event (user_id, event_id))",
    )


REWARD_FINAL = (
    "SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1",
    "SELECT balance, version FROM points WHERE user_id = 7",
)


@dataclass(frozen=True)
class Scene:
    name: str
    title: str
    note: str
    setup: tuple[str, ...]
    request: Callable
    final: tuple[str, ...]
    isolations: tuple[str, ...] = ("REPEATABLE READ",)
    retries: int = 0  # 'conflict'로 끝난 요청을 처음부터 다시 하는 최대 횟수
    rewards: bool = field(default=True)  # 지급 수와 잔액이 맞는지 검사할지


SCENES = {scene.name: scene for scene in (
    Scene("deduct", "문제 상황 2-1: 동시에 몰린 포인트 차감", "읽은 잔액 - 100을 쓴다. 오류가 나면 그 요청은 실패로 끝난다.",
          POINTS_ONLY, deduct, ("SELECT balance FROM points WHERE user_id = 7",),
          isolations=("READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"), rewards=False),
    Scene("reward-plain", "문제 상황 3: 막지 않은 지급", "COUNT가 0이면 INSERT와 잔액 UPDATE",
          reward_setup(False), reward, REWARD_FINAL),
    Scene("reward-count-lock", "(가) 처음 판: COUNT를 FOR UPDATE로", "COUNT(*) ... FOR UPDATE, 표는 처음 그대로",
          reward_setup(False), partial(reward, count_lock=True), REWARD_FINAL),
    Scene("reward-parent-lock", "(가) 고친 판: points 행을 먼저 잠금", "첫 문장 SELECT balance FROM points WHERE user_id = 7 FOR UPDATE",
          reward_setup(False), partial(reward, parent_lock=True), REWARD_FINAL),
    Scene("reward-version", "(나) 최종판: version으로 확인", "처음 읽은 version과 같을 때만 version + 1, 0행이면 ROLLBACK 뒤 처음부터 최대 3번",
          reward_setup(False), partial(reward, version=True), REWARD_FINAL, retries=3),
    Scene("reward-unique", "(다) 유니크 제약", "UNIQUE KEY idx_user_event (user_id, event_id), 1062면 ROLLBACK",
          reward_setup(True), partial(reward, unique=True), REWARD_FINAL),
    Scene("reward-count-lock-unique", "(가)+(다)", "COUNT(*) ... FOR UPDATE와 UNIQUE KEY, 1062면 ROLLBACK",
          reward_setup(True), partial(reward, count_lock=True, unique=True), REWARD_FINAL),
    # 아래 넷은 사람이 앞서 쓴 판과 이어서 낸 물음이다. 예상을 받았으므로 맥에서도 잰다.
    Scene("reward-version-first", "(나) 첫 판: version = 0일 때만 잔액 UPDATE",
          "INSERT 뒤 UPDATE points SET balance = balance + 1000 WHERE user_id = 7 AND version = 0, 0행이어도 COMMIT",
          reward_setup(False), partial(reward, zero_version="first"), REWARD_FINAL),
    Scene("reward-version-const", "(나) 고친 판: version = 0 확인 뒤 version + 1",
          "잔액 UPDATE ... AND version = 0이 0행이면 ROLLBACK(다시 하지 않음), 1행이면 version + 1 뒤 COMMIT",
          reward_setup(False), partial(reward, zero_version="fixed"), REWARD_FINAL),
    Scene("reward-version-const-v3", "(나) 고친 판, points의 처음 version이 3", "reward-version-const와 같고 처음 version만 3",
          reward_setup(False, version=3), partial(reward, zero_version="fixed"), REWARD_FINAL),
    Scene("reward-lock-after-count", "(가) 고친 판에서 FOR UPDATE를 COUNT 다음으로",
          "COUNT 다음(3번째 문장)에 SELECT balance FROM points WHERE user_id = 7 FOR UPDATE",
          reward_setup(False), partial(reward, lock_after_count=True), REWARD_FINAL),
)}


class MySQL:
    def __init__(self, address: str):
        self.host, port = address.rsplit(":", 1)
        self.port = int(port)

    def connect(self, isolation: str | None = None):
        import pymysql

        connection = pymysql.connect(host=self.host, port=self.port, user="root", password="", database=SCHEMA,
                                     autocommit=True, connect_timeout=5)
        with connection.cursor() as cursor:
            cursor.execute(f"SET SESSION innodb_lock_wait_timeout = {LOCK_TIMEOUT_S}")
            if isolation:
                cursor.execute(f"SET SESSION TRANSACTION ISOLATION LEVEL {isolation}")
        return connection

    def run(self, statements: tuple[str, ...]) -> list:
        connection = self.connect()
        try:
            rows = []
            with connection.cursor() as cursor:
                for sql in statements:
                    cursor.execute(sql)
                    rows.append([list(row) for row in cursor.fetchall()] if cursor.description else None)
            return rows
        finally:
            connection.close()

    def server_info(self) -> dict:
        names = ("version", "transaction_isolation", "innodb_lock_wait_timeout", "innodb_deadlock_detect",
                 "innodb_rollback_on_timeout", "max_connections", "autocommit")
        row = self.run(("SELECT " + ", ".join(f"@@global.{name}" for name in names),))[0][0]
        return dict(zip(names, row))


def attempt_request(scene: Scene, cursor, pause_s: float) -> dict:
    started = perf_counter()
    try:
        outcome, handled = scene.request(cursor, pause_s)
        return {"outcome": outcome, "error": handled, "elapsed_s": perf_counter() - started}
    except Exception as error:
        if error_code(error) is None:
            raise
        try:
            cursor.execute("ROLLBACK")
        except Exception:
            pass
        return {"outcome": "error", "error": error_info(error), "elapsed_s": perf_counter() - started}


def serve(scene: Scene, cursor, pause_s: float) -> dict:
    """요청 하나를 끝까지 처리한다. conflict면 정한 횟수까지 처음부터 다시 하고, DB 오류는 다시 하지 않는다."""
    started = perf_counter()
    attempts = []
    for _ in range(scene.retries + 1):
        attempts.append(attempt_request(scene, cursor, pause_s))
        if attempts[-1]["outcome"] != "conflict":
            break
    last = attempts[-1]["outcome"]
    return {"result": "gave-up" if last == "conflict" else last, "attempts": attempts,
            "retries": len(attempts) - 1, "elapsed_s": perf_counter() - started}


def run_burst(scene: Scene, driver, isolation: str, *, requests: int = REQUESTS, pause_s: float = PAUSE_S,
              join_s: float = JOIN_S) -> dict:
    driver.run(scene.setup)
    barrier = threading.Barrier(requests)
    results: list[dict | None] = [None] * requests
    failures: list[str] = []

    def worker(index: int) -> None:
        try:
            connection = driver.connect(isolation)
        except Exception as error:
            failures.append(f"요청 {index} 연결 실패: {error}")
            barrier.abort()
            return
        try:
            cursor = connection.cursor()
            barrier.wait()
            started = perf_counter()
            results[index] = {"request": index, "started_at": started, **serve(scene, cursor, pause_s)}
        except Exception as error:  # 실행 틀의 문제. DB 오류는 serve에서 기록한다.
            failures.append(f"요청 {index}: {type(error).__name__}: {error}")
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(index,), name=f"request-{index}") for index in range(requests)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=join_s)
    hung = [thread.name for thread in threads if thread.is_alive()]
    done = [result for result in results if result is not None]
    final_rows = driver.run(scene.final)
    return summarize(scene, done, final_rows, requests=requests, failures=failures, hung=hung)


def summarize(scene: Scene, done: list[dict], final_rows: list, *, requests: int, failures: list[str],
              hung: list[str]) -> dict:
    first = min((result["started_at"] for result in done), default=0.0)
    for result in done:
        result["started_at_s"] = result.pop("started_at") - first
    elapsed = sorted(result["elapsed_s"] for result in done)
    errors = Counter(str(attempt["error"]["code"]) for result in done for attempt in result["attempts"]
                     if attempt["error"])
    results = Counter(result["result"] for result in done)
    summary = {
        "results": dict(sorted(results.items())), "errors": dict(sorted(errors.items())),
        "retries": sum(result["retries"] for result in done),
        "request_s_median": statistics.median(elapsed) if elapsed else None,
        "request_s_max": elapsed[-1] if elapsed else None,
        "start_spread_s": max((result["started_at_s"] for result in done), default=0.0),
    }
    consistent = True
    if scene.rewards:
        count, (balance, version) = final_rows[0][0][0], final_rows[1][0]
        summary.update(rewards=count, balance=balance, version=version)
        # 지급마다 행 하나와 잔액 1000을 한 트랜잭션으로 남기므로 셋이 맞아야 한다.
        # 'unpaid'는 잔액 없이 행만 커밋한 요청이다(reward-version-first에서만 생길 수 있음).
        granted = results.get("granted", 0)
        consistent = count == granted + results.get("unpaid", 0) and balance == 1000 * granted
    else:
        summary.update(balance=final_rows[0][0][0])
    wall_s = max((result["started_at_s"] + result["elapsed_s"] for result in done), default=0.0)
    return {
        "check": len(done), "expected_check": requests,
        "valid": len(done) == requests and not failures and not hung and consistent,
        "wall_s": wall_s, "summary": summary, "final_rows": final_rows, "requests": sorted(done, key=lambda r: r["request"]),
        "failures": failures, "hung": hung,
    }


def print_summary(rows: list[dict]) -> None:
    cases = sorted({(r["scene"], r["isolation"]) for r in rows})
    for scene, isolation in cases:
        samples = [r for r in rows if (r["scene"], r["isolation"]) == (scene, isolation) and r["run"] > 0]
        if not samples:
            continue
        print(f"\n{scene} · {isolation} · {len(samples)}회", file=sys.stderr)
        for sample in samples:
            s = sample["summary"]
            table = f"rewards {s['rewards']}, 잔액 {s['balance']}, version {s['version']}" if "rewards" in s \
                else f"잔액 {s['balance']}"
            print(f"  run {sample['run']}: {table} · 결과 {s['results']} · 오류 {s['errors']} · 다시 시도 {s['retries']}"
                  f" · 요청 중앙값 {s['request_s_median'] * 1000:.0f}ms, 최대 {s['request_s_max'] * 1000:.0f}ms",
                  file=sys.stderr)


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("1 이상의 정수가 필요하다.")
    return number


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenes", nargs="+", choices=SCENES, default=list(SCENES))
    parser.add_argument("--trials", type=positive_int, default=3)
    parser.add_argument("--requests", type=positive_int, default=REQUESTS)
    parser.add_argument("--mysql", default="127.0.0.1:13306", help="MySQL 주소(호스트:포트)")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="조건마다 워밍업 1회와 검증 2회만 실행")
    args = parser.parse_args()
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        parser.error("이 실험은 CPython 3.14에서 실행한다.")
    if args.smoke:
        args.trials = 2
    elif args.trials < 3:
        parser.error("본 실행은 조건마다 3회 이상 반복한다.")
    return args


def main() -> int:
    args = parse_args()
    driver = MySQL(args.mysql)
    cases = [(SCENES[name], isolation) for name in args.scenes for isolation in SCENES[name].isolations]
    try:
        server = driver.server_info()
    except Exception as error:
        print(f"DB에 붙지 못했다({error}). infra/compose.yaml로 띄웠는지 확인한다.", file=sys.stderr)
        return 1
    if str(server["innodb_deadlock_detect"]) not in ("1", "ON"):
        print("innodb_deadlock_detect가 꺼져 있다. 켠 뒤 다시 돌린다.", file=sys.stderr)
        return 1
    started = datetime.now(ZoneInfo("Asia/Seoul"))
    run_id = f"{started:%Y-%m-%dT%H%M%S%f}-burst" + ("-smoke" if args.smoke else "")
    version = platform.python_version()
    directory = args.output_dir or EXPERIMENT_DIR / "results" / ("validation" if args.smoke else "")
    directory.mkdir(parents=True, exist_ok=True)
    env_path = directory / f"{run_id}-env.txt"
    result_path = directory / f"{run_id}-python-{version}.jsonl"
    environment = collect_environment(
        started=started, purpose="burst", validation=args.smoke,
        config={**vars(args), "output_dir": str(args.output_dir) if args.output_dir else None},
        conditions={"lock_timeout_s": LOCK_TIMEOUT_S, "pause_s": PAUSE_S, "join_s": JOIN_S},
        experiment_dir=EXPERIMENT_DIR, sources=[Path(__file__), REPO_DIR / "tools" / "lab_env.py"],
    )
    environment["databases"] = {"mysql": server}
    environment["docker_images"] = command_info(
        ["docker", "compose", "-f", str(REPO_DIR / "infra" / "compose.yaml"), "images"])
    with env_path.open("x", encoding="utf-8") as stream:
        json.dump(environment, stream, ensure_ascii=False, indent=2, default=str)
        stream.write("\n")
    print(f"환경: {env_path}\n결과: {result_path}", file=sys.stderr)
    rows = []
    with result_path.open("x", encoding="utf-8") as stream:
        for run in range(args.trials + 1):
            order = cases if run % 2 == 0 else list(reversed(cases))
            for position, (scene, isolation) in enumerate(order):
                row = run_burst(scene, driver, isolation, requests=args.requests)
                row.update(
                    lang="python", runtime=f"cpython-{version}", variant=f"scene={scene.name};isolation={isolation}",
                    model="threads", workers=args.requests, task=scene.name, size=args.requests,
                    params={"lock_timeout_s": LOCK_TIMEOUT_S, "pause_s": PAUSE_S, "retries": scene.retries},
                    scene=scene.name, note=scene.note, db="mysql", db_version=server.get("version"),
                    isolation=isolation, run_id=run_id, environment_file=env_path.name, run=run,
                    order_index=position, validation=args.smoke,
                )
                stream.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                stream.flush()
                rows.append(row)
                if not row["valid"]:
                    print(f"실행 오류를 기록했다({scene.name}, {isolation}): {row['failures'] or row['hung'] or row['summary']}",
                          file=sys.stderr)
                    return 1
    if args.smoke:
        print("작은 입력의 실행·저장 검증 완료. 가설 판단에 쓰지 않는다.", file=sys.stderr)
    print_summary(rows)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(f"실행 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
