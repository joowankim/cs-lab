"""묶음 1·3의 순서표. 단계는 적힌 순서대로 실행하고, 각 단계는 자기 세션의 연결에서 돈다."""

from dataclasses import dataclass, field

ISOLATIONS = ("READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE")


@dataclass(frozen=True)
class Step:
    session: str
    sql: str
    note: str = ""


@dataclass(frozen=True)
class Timeline:
    name: str
    title: str
    dbs: tuple[str, ...]
    setup: tuple[str, ...]
    steps: tuple[Step, ...]
    isolations: tuple[str, ...] = ISOLATIONS
    # DB마다 준비 SQL이 다를 때만 채운다. 없으면 setup을 쓴다.
    setup_by_db: dict[str, tuple[str, ...]] = field(default_factory=dict)

    def setup_for(self, db: str) -> tuple[str, ...]:
        return self.setup_by_db.get(db, self.setup)


ENTRIES_COUNT = Timeline(
    name="entries-count",
    title="문제 상황 1: 같은 트랜잭션에서 개수가 2, 3, 2로 바뀐 응모 확인",
    # PostgreSQL은 집계 함수에 FOR UPDATE를 붙일 수 없어 MySQL에서만 돌린다.
    dbs=("mysql",),
    setup=(
        "DROP TABLE IF EXISTS entries",
        "CREATE TABLE entries (id INT PRIMARY KEY, user_id INT NOT NULL)",
        "INSERT INTO entries (id, user_id) VALUES (1, 7), (2, 7), (3, 8)",
    ),
    steps=(
        Step("A", "START TRANSACTION"),
        Step("A", "SELECT COUNT(*) FROM entries WHERE user_id = 7", "1번"),
        Step("B", "START TRANSACTION", "2번: 다른 요청"),
        Step("B", "INSERT INTO entries (id, user_id) VALUES (4, 7)", "2번: 다른 요청"),
        Step("B", "COMMIT", "2번: 다른 요청"),
        Step("A", "SELECT COUNT(*) FROM entries WHERE user_id = 7 FOR UPDATE", "3번"),
        Step("A", "SELECT COUNT(*) FROM entries WHERE user_id = 7", "4번"),
        Step("A", "COMMIT"),
    ),
    isolations=("REPEATABLE READ", "READ COMMITTED"),
)

ENTRIES_TOTAL = Timeline(
    name="entries-total",
    title="문제 상황 1-1: 처음 쓰는 조건으로 다시 세기",
    dbs=("mysql", "postgres"),
    setup=ENTRIES_COUNT.setup,
    steps=(
        Step("A", "START TRANSACTION"),
        Step("A", "SELECT COUNT(*) FROM entries WHERE user_id = 7", "1번"),
        Step("B", "START TRANSACTION", "2번: 다른 요청"),
        Step("B", "INSERT INTO entries (id, user_id) VALUES (4, 7)", "2번: 다른 요청"),
        Step("B", "COMMIT", "2번: 다른 요청"),
        Step("A", "SELECT COUNT(*) FROM entries", "3번: 이 트랜잭션에서 처음 쓰는 조건"),
        Step("A", "COMMIT"),
    ),
    isolations=("REPEATABLE READ", "READ COMMITTED"),
)

ENTRIES_LATE = Timeline(
    name="entries-late",
    title="문제 상황 1-2: 트랜잭션을 연 뒤 처음 세기",
    dbs=("mysql", "postgres"),
    setup=ENTRIES_COUNT.setup,
    steps=(
        Step("A", "START TRANSACTION", "1번: 아직 아무것도 읽지 않음"),
        Step("B", "START TRANSACTION", "2번: 다른 요청"),
        Step("B", "INSERT INTO entries (id, user_id) VALUES (4, 7)", "2번: 다른 요청"),
        Step("B", "COMMIT", "2번: 다른 요청"),
        Step("A", "SELECT COUNT(*) FROM entries WHERE user_id = 7", "3번: 이 트랜잭션의 첫 읽기"),
        Step("A", "COMMIT"),
    ),
    isolations=("REPEATABLE READ", "READ COMMITTED"),
)

ENTRIES_LATE_SNAPSHOT = Timeline(
    name="entries-late-snapshot",
    title="문제 상황 1-2 피드백: 트랜잭션을 열 때 스냅숏 만들기",
    # PostgreSQL에는 WITH CONSISTENT SNAPSHOT이 없다.
    dbs=("mysql",),
    setup=ENTRIES_COUNT.setup,
    steps=(
        Step("A", "START TRANSACTION WITH CONSISTENT SNAPSHOT", "1번"),
        Step("B", "START TRANSACTION", "2번: 다른 요청"),
        Step("B", "INSERT INTO entries (id, user_id) VALUES (4, 7)", "2번: 다른 요청"),
        Step("B", "COMMIT", "2번: 다른 요청"),
        Step("A", "SELECT COUNT(*) FROM entries WHERE user_id = 7", "3번: 이 트랜잭션의 첫 읽기"),
        Step("A", "COMMIT"),
    ),
    isolations=("REPEATABLE READ", "READ COMMITTED"),
)

ENTRIES_LATE_UPDATE = Timeline(
    name="entries-late-update",
    title="문제 상황 1-2 변형: 첫 문장이 다른 표의 UPDATE",
    dbs=("mysql", "postgres"),
    setup=ENTRIES_COUNT.setup + (
        "DROP TABLE IF EXISTS visits",
        "CREATE TABLE visits (id INT PRIMARY KEY, n INT NOT NULL)",
        "INSERT INTO visits (id, n) VALUES (1, 0)",
    ),
    steps=(
        Step("A", "START TRANSACTION", "1번"),
        Step("A", "UPDATE visits SET n = n + 1 WHERE id = 1", "1번: 방문 수를 먼저 고침"),
        Step("B", "START TRANSACTION", "2번: 다른 요청"),
        Step("B", "INSERT INTO entries (id, user_id) VALUES (4, 7)", "2번: 다른 요청"),
        Step("B", "COMMIT", "2번: 다른 요청"),
        Step("A", "SELECT COUNT(*) FROM entries WHERE user_id = 7", "3번"),
        Step("A", "COMMIT"),
    ),
    isolations=("REPEATABLE READ", "READ COMMITTED"),
)

ENTRIES_ROWS = Timeline(
    name="entries-rows",
    title="문제 상황 1-3: 응모 행을 잠그며 읽기",
    # 두 DB에 같이 돌리려고 개수 대신 행을 읽는다.
    dbs=("mysql", "postgres"),
    setup=ENTRIES_COUNT.setup,
    steps=(
        Step("A", "START TRANSACTION"),
        Step("A", "SELECT id FROM entries WHERE user_id = 7 ORDER BY id", "1번"),
        Step("B", "START TRANSACTION", "2번: 다른 요청"),
        Step("B", "INSERT INTO entries (id, user_id) VALUES (4, 7)", "2번: 다른 요청"),
        Step("B", "COMMIT", "2번: 다른 요청"),
        Step("A", "SELECT id FROM entries WHERE user_id = 7 ORDER BY id FOR UPDATE", "3번"),
        Step("A", "SELECT id FROM entries WHERE user_id = 7 ORDER BY id", "4번"),
        Step("A", "COMMIT"),
    ),
    isolations=("READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"),
)

BALANCE_READS = Timeline(
    name="balance-reads",
    title="문제 상황 2: 리포트가 읽은 잔액",
    dbs=("mysql", "postgres"),
    setup=(
        "DROP TABLE IF EXISTS accounts",
        "CREATE TABLE accounts (id INT PRIMARY KEY, balance INT NOT NULL)",
        "INSERT INTO accounts (id, balance) VALUES (1, 1000)",
    ),
    steps=(
        Step("A", "START TRANSACTION", "1번: 리포트"),
        Step("A", "SELECT balance FROM accounts WHERE id = 1", "1번: (가)"),
        Step("B", "START TRANSACTION", "2번: 결제"),
        Step("B", "UPDATE accounts SET balance = 700 WHERE id = 1", "2번: 결제"),
        Step("A", "SELECT balance FROM accounts WHERE id = 1", "3번: (나)"),
        Step("B", "COMMIT", "4번: 결제"),
        Step("A", "SELECT balance FROM accounts WHERE id = 1", "5번: (다)"),
        Step("A", "COMMIT"),
    ),
)

POINTS_DEDUCT = Timeline(
    name="points-deduct",
    title="문제 상황 3: 동시에 차감한 포인트",
    dbs=("mysql", "postgres"),
    setup=(
        "DROP TABLE IF EXISTS points",
        "CREATE TABLE points (user_id INT PRIMARY KEY, balance INT NOT NULL)",
        "INSERT INTO points (user_id, balance) VALUES (7, 1000)",
    ),
    steps=(
        Step("A", "START TRANSACTION", "1번: 300 차감 요청"),
        Step("A", "SELECT balance FROM points WHERE user_id = 7", "1번: 읽은 값에서 300을 빼 계산"),
        Step("B", "START TRANSACTION", "2번: 500 차감 요청"),
        Step("B", "SELECT balance FROM points WHERE user_id = 7", "2번: 읽은 값에서 500을 빼 계산"),
        Step("A", "UPDATE points SET balance = 700 WHERE user_id = 7", "3번: 1000 - 300"),
        Step("B", "UPDATE points SET balance = 500 WHERE user_id = 7", "4번: 1000 - 500"),
        Step("A", "COMMIT", "5번"),
        Step("B", "COMMIT", "6번"),
        Step("A", "SELECT balance FROM points WHERE user_id = 7", "7번: 최종 잔액"),
    ),
)

ORDER_ROLLBACK = Timeline(
    name="order-rollback",
    title="문제 상황 5: 되돌린 주문과 남은 기록",
    # MyISAM은 MySQL에만 있다. 격리 수준은 기본값 하나로 돌린다.
    dbs=("mysql",),
    setup=(
        "DROP TABLE IF EXISTS orders",
        "DROP TABLE IF EXISTS order_logs",
        "CREATE TABLE orders (id INT PRIMARY KEY, amount INT NOT NULL) ENGINE=InnoDB",
        "CREATE TABLE order_logs (id INT PRIMARY KEY, order_id INT NOT NULL) ENGINE=MyISAM",
    ),
    steps=(
        Step("A", "START TRANSACTION", "1번: 주문 요청"),
        Step("A", "INSERT INTO orders (id, amount) VALUES (1, 5000)", "1번: 주문 (InnoDB)"),
        Step("A", "INSERT INTO order_logs (id, order_id) VALUES (1, 1)", "1번: 주문 기록 (MyISAM)"),
        Step("B", "SELECT (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM order_logs)", "2번: (가)"),
        Step("A", "ROLLBACK", "3번: 결제 실패, (나)"),
        # SHOW WARNINGS는 그 세션이 바로 앞에 실행한 문장의 경고만 보여 주므로 ROLLBACK 바로 다음에 둔다. 없으면 빈 목록이다.
        Step("A", "SHOW WARNINGS", "3번: (나)의 경고 목록"),
        Step("B", "SELECT (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM order_logs)", "4번: (다)"),
    ),
    isolations=("REPEATABLE READ",),
)


def stock_read(engine: str) -> Timeline:
    return Timeline(
        name=f"stock-read-{engine.lower()}",
        title=f"문제 상황 5-1: 재고 리포트가 도는 중에 들어온 차감 ({engine})",
        # 표의 storage engine만 바꿔 같은 순서표를 돌린다. MyISAM은 MySQL에만 있다.
        dbs=("mysql",),
        setup=(
            "DROP TABLE IF EXISTS stock",
            f"CREATE TABLE stock (id INT PRIMARY KEY, qty INT NOT NULL) ENGINE={engine}",
            "INSERT INTO stock (id, qty) VALUES (1, 10), (2, 10)",
        ),
        steps=(
            # 표 전체를 훑으며 행마다 SLEEP(1)을 불러 읽기가 약 2초 이어지게 한다.
            Step("A", "SELECT id, qty FROM stock WHERE SLEEP(1) = 0", "1번: 재고 리포트, 행마다 1초, (나)"),
            Step("B", "UPDATE stock SET qty = qty - 1 WHERE id = 2", "2번: 재고 차감, (가)"),
            Step("B", "SELECT id, qty FROM stock ORDER BY id", "3번"),
        ),
        isolations=("REPEATABLE READ",),
    )


STOCK_READ_MYISAM = stock_read("MyISAM")
STOCK_READ_INNODB = stock_read("InnoDB")

TIMELINES = {timeline.name: timeline for timeline in (
    ENTRIES_COUNT, ENTRIES_TOTAL, ENTRIES_LATE, ENTRIES_LATE_SNAPSHOT, ENTRIES_LATE_UPDATE, ENTRIES_ROWS,
    BALANCE_READS, POINTS_DEDUCT, ORDER_ROLLBACK, STOCK_READ_MYISAM, STOCK_READ_INNODB)}
