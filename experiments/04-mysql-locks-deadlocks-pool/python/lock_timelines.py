"""묶음 ①②의 순서표와, 묶음 ③ (가) 처음 판을 두 요청으로 줄인 순서표.
단계는 적힌 순서대로 실행하고, 각 단계는 자기 세션의 연결에서 돈다.

03 실험 isolation_timelines.py의 Step·Timeline을 바탕으로 세 가지를 더했다. 앞 단계를 보낸 때부터 기다렸다가
보내는 시간(delay_s), 보낸 직후 락을 읽을지(snapshot), 조건으로 바꿀 데드락 탐지 설정(detects)이다.
순서표가 끝난 뒤 읽을 표(final)도 둔다. MySQL에서만 돌린다.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Step:
    session: str
    sql: str
    note: str = ""
    # 앞 단계를 보낸 때부터 이만큼 지난 뒤에 보낸다. 0이면 바로 보낸다.
    delay_s: float = 0.0
    # 보낸 직후(0.5초 안에 끝났거나 기다림으로 기록한 뒤) performance_schema의 락 표를 읽는다.
    snapshot: bool = False


@dataclass(frozen=True)
class Timeline:
    name: str
    title: str
    setup: tuple[str, ...]
    steps: tuple[Step, ...]
    isolations: tuple[str, ...] = ("REPEATABLE READ", "READ COMMITTED")
    # innodb_deadlock_detect 값. 서버 전체 설정이라 실행마다 걸고 끝나면 처음 값으로 되돌린다.
    detects: tuple[str, ...] = ("ON",)
    # 순서표가 끝나고 두 세션을 정리한 뒤 관찰용 연결로 읽는 SQL
    final: str = ""


ENTRIES_ROWS = ((1, 3), (2, 7), (3, 7), (4, 12))
ENTRIES_VALUES = ", ".join(f"({id_}, {user_id})" for id_, user_id in ENTRIES_ROWS)
ENTRIES_FINAL = "SELECT id, user_id FROM entries ORDER BY id"


def entries_setup(index: bool) -> tuple[str, ...]:
    key = ", KEY idx_user (user_id)" if index else ""
    return (
        "DROP TABLE IF EXISTS entries",
        f"CREATE TABLE entries (id INT PRIMARY KEY, user_id INT NOT NULL{key})",
        f"INSERT INTO entries (id, user_id) VALUES {ENTRIES_VALUES}",
    )


def locked_range(name: str, title: str, index: bool, sql: str, note: str) -> Timeline:
    # 문제 상황 1·1-1: A가 user_id = 7을 잠그며 읽은 채로 있는 동안 B가 자동 커밋으로 한 문장을 보낸다.
    return Timeline(
        name=name,
        title=title,
        setup=entries_setup(index),
        steps=(
            Step("A", "START TRANSACTION"),
            Step("A", "SELECT id FROM entries WHERE user_id = 7 FOR UPDATE", "A: user 7의 응모를 잠그며 읽음"),
            Step("B", sql, note, snapshot=True),
            Step("A", "COMMIT"),
        ),
        final=ENTRIES_FINAL,
    )


GAP_CASES = (
    ("idx-insert-user7", "(가)", "INSERT INTO entries (id, user_id) VALUES (10, 7)", "B: user 7(잠근 값과 같음)"),
    ("idx-insert-user5", "(나)", "INSERT INTO entries (id, user_id) VALUES (11, 5)", "B: user 5(3과 7 사이)"),
    ("idx-insert-user10", "(다)", "INSERT INTO entries (id, user_id) VALUES (12, 10)", "B: user 10(7과 12 사이)"),
    ("idx-insert-user15", "(라)", "INSERT INTO entries (id, user_id) VALUES (13, 15)", "B: user 15(12보다 큼)"),
    ("idx-insert-user1", "(마)", "INSERT INTO entries (id, user_id) VALUES (14, 1)", "B: user 1(3보다 작음)"),
)

NO_INDEX_CASES = (
    ("noidx-insert-user7", "(가)", "INSERT INTO entries (id, user_id) VALUES (10, 7)", "B: user 7"),
    ("noidx-insert-user15", "(나)", "INSERT INTO entries (id, user_id) VALUES (13, 15)", "B: user 15"),
    ("noidx-delete-id1", "(다)", "DELETE FROM entries WHERE id = 1", "B: user 3의 응모(id 1) 취소"),
)

GAP_TIMELINES = tuple(
    locked_range(name, f"문제 상황 1 {mark}: 잠근 응모 사이로 들어오는 새 응모", True, sql, note)
    for name, mark, sql, note in GAP_CASES
)

NO_INDEX_TIMELINES = tuple(
    locked_range(name, f"문제 상황 1-1 {mark}: 인덱스가 없을 때", False, sql, note)
    for name, mark, sql, note in NO_INDEX_CASES
)

SERIALIZABLE_INSERT = Timeline(
    name="serializable-insert",
    title="문제 상황 1-2: 실험 3에서 미뤄 둔 1.74초",
    # 03 실험 순서표 entries-rows(문제 상황 1-3)와 같은 표와 단계다. B의 INSERT가 기다리는 동안 락을 읽는다.
    setup=(
        "DROP TABLE IF EXISTS entries",
        "CREATE TABLE entries (id INT PRIMARY KEY, user_id INT NOT NULL)",
        "INSERT INTO entries (id, user_id) VALUES (1, 7), (2, 7), (3, 8)",
    ),
    steps=(
        Step("A", "START TRANSACTION"),
        Step("A", "SELECT id FROM entries WHERE user_id = 7 ORDER BY id", "1번"),
        Step("B", "START TRANSACTION", "2번: 다른 요청"),
        Step("B", "INSERT INTO entries (id, user_id) VALUES (4, 7)", "2번: 다른 요청", snapshot=True),
        Step("B", "COMMIT", "2번: 다른 요청"),
        Step("A", "SELECT id FROM entries WHERE user_id = 7 ORDER BY id FOR UPDATE", "3번"),
        Step("A", "SELECT id FROM entries WHERE user_id = 7 ORDER BY id", "4번"),
        Step("A", "COMMIT"),
    ),
    isolations=("SERIALIZABLE",),
    final=ENTRIES_FINAL,
)

ACCOUNTS_SETUP = (
    "DROP TABLE IF EXISTS accounts",
    "CREATE TABLE accounts (id INT PRIMARY KEY, balance INT NOT NULL)",
    "INSERT INTO accounts (id, balance) VALUES (1, 1000), (2, 1000)",
)
ACCOUNTS_FINAL = "SELECT id, balance FROM accounts ORDER BY id"

TRANSFER_REVERSE = Timeline(
    name="transfer-reverse",
    title="문제 상황 2: 서로 반대로 보낸 두 이체",
    setup=ACCOUNTS_SETUP,
    steps=(
        Step("A", "START TRANSACTION", "A: 1번 계좌 → 2번 계좌로 100"),
        Step("A", "UPDATE accounts SET balance = balance - 100 WHERE id = 1", "1번"),
        Step("B", "START TRANSACTION", "B: 2번 계좌 → 1번 계좌로 100"),
        Step("B", "UPDATE accounts SET balance = balance - 100 WHERE id = 2", "2번"),
        Step("A", "UPDATE accounts SET balance = balance + 100 WHERE id = 2", "3번", snapshot=True),
        # 탐지를 껐을 때 두 대기의 시작을 2초 떼어, 어느 쪽이 먼저 대기 한도에 닿는지 갈리게 한다.
        Step("B", "UPDATE accounts SET balance = balance + 100 WHERE id = 1", "4번: 3번 2초 뒤", delay_s=2.0,
             snapshot=True),
        Step("A", "COMMIT", "5번"),
        Step("B", "COMMIT", "6번"),
    ),
    isolations=("REPEATABLE READ",),
    detects=("ON", "OFF"),
    final=ACCOUNTS_FINAL,
)

TRANSFER_ORDERED = Timeline(
    name="transfer-ordered",
    title="문제 상황 2 이어서: 두 이체가 작은 id부터 고칠 때(락 순서 고정)",
    setup=ACCOUNTS_SETUP,
    steps=(
        Step("A", "START TRANSACTION", "A: 1번 계좌 → 2번 계좌로 100"),
        Step("A", "UPDATE accounts SET balance = balance - 100 WHERE id = 1", "1번"),
        Step("B", "START TRANSACTION", "B: 2번 계좌 → 1번 계좌로 100, 작은 id부터"),
        Step("B", "UPDATE accounts SET balance = balance + 100 WHERE id = 1", "2번", snapshot=True),
        Step("A", "UPDATE accounts SET balance = balance + 100 WHERE id = 2", "3번"),
        Step("B", "UPDATE accounts SET balance = balance - 100 WHERE id = 2", "4번"),
        Step("A", "COMMIT", "5번"),
        Step("B", "COMMIT", "6번"),
    ),
    isolations=("REPEATABLE READ",),
    detects=("ON", "OFF"),
    final=ACCOUNTS_FINAL,
)

REWARD_COUNT_LOCK = "SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 FOR UPDATE"
REWARD_INSERT = "INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000)"

REWARD_COUNT_LOCK_PAIR = Timeline(
    name="reward-count-lock-pair",
    title="문제 상황 3 (가) 처음 판을 두 요청으로 줄임: 아직 없는 범위를 잠근 두 지급 요청",
    # burst_lab.py의 reward-count-lock에서 50ms와 잔액 UPDATE를 빼고 두 요청을 차례로 보내,
    # 두 요청이 쥔 락과 데드락 보고를 읽는다. 표는 문제 상황 3의 rewards와 같다(비어 있음).
    setup=(
        "DROP TABLE IF EXISTS rewards",
        "CREATE TABLE rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, "
        "amount INT NOT NULL, KEY idx_user_event (user_id, event_id))",
    ),
    steps=(
        Step("A", "START TRANSACTION", "A: 첫 지급 요청"),
        Step("A", REWARD_COUNT_LOCK, "A: 받았는지 확인하며 잠금"),
        Step("B", "START TRANSACTION", "B: 같은 지급 요청"),
        Step("B", REWARD_COUNT_LOCK, "B: 받았는지 확인하며 잠금", snapshot=True),
        Step("A", REWARD_INSERT, "A: 0이라 지급 기록", snapshot=True),
        Step("B", REWARD_INSERT, "B: 0이라 지급 기록", snapshot=True),
        Step("A", "COMMIT"),
        Step("B", "COMMIT"),
    ),
    isolations=("REPEATABLE READ",),
    final="SELECT id, user_id, event_id, amount FROM rewards ORDER BY id",
)

TIMELINES = {timeline.name: timeline for timeline in (
    *GAP_TIMELINES, *NO_INDEX_TIMELINES, SERIALIZABLE_INSERT, TRANSFER_REVERSE, TRANSFER_ORDERED,
    REWARD_COUNT_LOCK_PAIR,
)}
