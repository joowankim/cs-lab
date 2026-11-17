"""실험 06의 표, 데이터, 조건과 쿼리.

묶음 ①은 손으로 결과를 셀 수 있는 작은 표, ②는 각 1만 행의 두 표를 회원 코드로 맞춰 보는 조인,
③은 회원 1만 명·주문 10만 건에서 회원 N명과 그 주문을 가져오는 방법이다.
사람이 쓴 쿼리는 쓴 문장 그대로 두고(author "사람"), 문법 오류였던 판은 고친 사람과 함께 적는다.
"""

from dataclasses import dataclass, field

# ① 작은 표 (문제 상황 1·1-1)
SMALL_TABLES = [
    "DROP TABLE IF EXISTS orders",
    "DROP TABLE IF EXISTS users",
    "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(10) NOT NULL)",
    "CREATE TABLE orders (id INT PRIMARY KEY, user_id INT NULL, item VARCHAR(10) NOT NULL, "
    "status VARCHAR(10) NOT NULL, KEY idx_user (user_id))",
    "INSERT INTO users VALUES (1,'kim'),(2,'lee'),(3,'park'),(4,'choi'),(5,'jung')",
    "INSERT INTO orders VALUES (1,1,'book','paid'),(2,1,'cup','cancelled'),(3,2,'pen','paid'),"
    "(4,3,'bag','cancelled'),(5,NULL,'gift','paid')",
    "ANALYZE TABLE users, orders",
]


@dataclass(frozen=True)
class ResultQuery:
    name: str
    situation: str
    label: str
    sql: str
    expected: tuple  # 기대하는 결과 행(손으로 셈)
    author: str = "에이전트"


_PAIR = "SELECT u.id, o.id FROM users u "
RESULT_QUERIES = [
    ResultQuery("1-ga-inner", "1", "(가) JOIN", _PAIR + "JOIN orders o ON u.id = o.user_id ORDER BY u.id, o.id",
                ((1, 1), (1, 2), (2, 3), (3, 4))),
    ResultQuery("1-na-left", "1", "(나) LEFT JOIN", _PAIR + "LEFT JOIN orders o ON u.id = o.user_id ORDER BY u.id, o.id",
                ((1, 1), (1, 2), (2, 3), (3, 4), (4, None), (5, None))),
    ResultQuery("1-da-left-where", "1", "(다) LEFT JOIN + WHERE",
                _PAIR + "LEFT JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid' ORDER BY u.id, o.id",
                ((1, 1), (2, 3))),
    ResultQuery("1-ra-left-on", "1", "(라) LEFT JOIN + ON",
                _PAIR + "LEFT JOIN orders o ON u.id = o.user_id AND o.status = 'paid' ORDER BY u.id, o.id",
                ((1, 1), (2, 3), (3, None), (4, None), (5, None))),
    ResultQuery("1-1-A-left-is-null", "1-1", "(A) LEFT JOIN … IS NULL",
                "SELECT u.id FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id is NULL;",
                ((4,), (5,)), "사람"),
    ResultQuery("1-1-B-not-exists", "1-1", "(B) NOT EXISTS",
                "SELECT u.id FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)",
                ((4,), (5,))),
    ResultQuery("1-1-C-not-in", "1-1", "(C) NOT IN",
                "SELECT u.id FROM users u WHERE u.id NOT IN (SELECT user_id FROM orders)", ()),
    ResultQuery("1-1-C-not-in-person", "1-1", "(C) 사람 판(결제 완료 기준)",
                "SELECT u.id FROM users u WHERE u.id NOT IN (SELECT u.id FROM users u JOIN orders o "
                "ON u.id = o.user_id WHERE o.status = 'paid');", ((3,), (4,), (5,)), "사람"),
    ResultQuery("1-1-D-in", "1-1", "(D) IN",
                "SELECT u.id FROM users u WHERE u.id IN (SELECT user_id FROM orders)", ((1,), (2,), (3,))),
    ResultQuery("1-1-D-in-person", "1-1", "(D) 사람 판(결제 완료 기준)",
                "SELECT u.id FROM users u WHERE u.id IN (SELECT u.id FROM users u JOIN orders o "
                "ON u.id = o.user_id WHERE o.status = 'paid');", ((1,), (2,)), "사람"),
    ResultQuery("1-1-E-exists", "1-1", "(E) EXISTS",
                "SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)",
                ((1,), (2,), (3,))),
    ResultQuery("1-1-F-join", "1-1", "(F) JOIN",
                "SELECT u.id FROM users u JOIN orders o ON u.id = o.user_id;", ((1,), (1,), (2,), (3,)), "사람"),
]

# ② 1만 × 1만 (문제 상황 2)
ALGO_ROWS = 10_000
ALGO_TABLES = [
    "DROP TABLE IF EXISTS algo_orders",
    "DROP TABLE IF EXISTS algo_users",
    "CREATE TABLE algo_users (id INT PRIMARY KEY, code INT NOT NULL, name VARCHAR(20) NOT NULL)",
    "CREATE TABLE algo_orders (id INT PRIMARY KEY, user_code INT NOT NULL, amount INT NOT NULL)",
]
ALGO_EXPECTED = (ALGO_ROWS, sum(n % 1000 for n in range(1, ALGO_ROWS + 1)))
ALGO_SMALL_EXPECTED = (10, sum(n % 1000 for n in range(1, 11)))


def algo_rows():
    """회원 code와 주문 user_code는 모두 100000~109999의 순열(7919, 104729는 10000과 서로소)."""
    users = [(n, 100_000 + (n * 7919) % ALGO_ROWS, f"user{n}") for n in range(1, ALGO_ROWS + 1)]
    orders = [(n, 100_000 + (n * 104_729) % ALGO_ROWS, n % 1000) for n in range(1, ALGO_ROWS + 1)]
    return users, orders


@dataclass(frozen=True)
class AlgoCase:
    name: str
    label: str
    index: bool  # algo_users.code에 idx_code를 두는지
    sql: str
    expected: tuple


_ALGO_SQL = "SELECT {hint}COUNT(*), SUM(o.amount) FROM algo_users u JOIN algo_orders o ON u.code = o.user_code{where}"
ALGO_CASES = [
    AlgoCase("2-ga-no-index", "(가) 인덱스 없음", False, _ALGO_SQL.format(hint="", where=""), ALGO_EXPECTED),
    AlgoCase("2-na-no-index-no-bnl", "(나) 인덱스 없음 + NO_BNL", False,
             _ALGO_SQL.format(hint="/*+ NO_BNL(u, o) */ ", where=""), ALGO_EXPECTED),
    AlgoCase("2-da-index", "(다) users.code 인덱스", True, _ALGO_SQL.format(hint="", where=""), ALGO_EXPECTED),
    AlgoCase("2-da-small-index", "(다) 주문 10건, 인덱스 중첩 루프", True,
             _ALGO_SQL.format(hint="", where=" WHERE o.id <= 10"), ALGO_SMALL_EXPECTED),
    AlgoCase("2-da-small-hash", "(다) 주문 10건, 인덱스 끄고 해시 조인", True,
             _ALGO_SQL.format(hint="/*+ NO_INDEX(u idx_code) */ ", where=" WHERE o.id <= 10"), ALGO_SMALL_EXPECTED),
]

# ③ N+1 (문제 상황 3)
N1_USERS = 10_000
N1_ORDERS = 100_000
N1_SIZES = (10, 100, 1000)
N1_TABLES = [
    "DROP TABLE IF EXISTS n1_orders",
    "DROP TABLE IF EXISTS n1_users",
    "CREATE TABLE n1_users (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL)",
    "CREATE TABLE n1_orders (id INT PRIMARY KEY, user_id INT NOT NULL, amount INT NOT NULL, KEY idx_user (user_id))",
]


def n1_rows():
    """주문 user_id = 1 + (n*7919) % 10000이라 회원마다 정확히 10건."""
    users = [(n, f"user{n}") for n in range(1, N1_USERS + 1)]
    orders = [(n, 1 + (n * 7919) % N1_USERS, n % 1000) for n in range(1, N1_ORDERS + 1)]
    return users, orders


@dataclass(frozen=True)
class N1Variant:
    name: str
    label: str
    queries: tuple = field(default_factory=tuple)
    author: str = "에이전트"


N1_LIST = "SELECT id, name FROM n1_users ORDER BY id LIMIT %s"
N1_PER_USER = "SELECT id, amount FROM n1_orders WHERE user_id = %s"
N1_JOIN = ("SELECT u.id, u.name, o.id, o.amount FROM (SELECT id, name FROM n1_users ORDER BY id LIMIT %s) u "
           "LEFT JOIN n1_orders o ON o.user_id = u.id")
N1_IN = "SELECT id, user_id, amount FROM n1_orders WHERE user_id IN ({placeholders})"
# 사람이 쓴 판(IN 서브쿼리 안 LIMIT은 1235 오류)을 에이전트가 파생 테이블로 감쌌다.
N1_IN_SUBQUERY = ("SELECT o.id, o.user_id, o.amount FROM n1_orders o WHERE o.user_id IN "
                  "(SELECT id FROM (SELECT id FROM n1_users ORDER BY id LIMIT %s) x)")
N1_VARIANTS = [
    N1Variant("n-plus-1", "(가) N+1", (N1_LIST, N1_PER_USER)),
    N1Variant("join", "(나) JOIN 한 번", (N1_JOIN,)),
    N1Variant("in-list", "(다) IN 두 번", (N1_LIST, N1_IN)),
    N1Variant("in-subquery", "(라) IN 서브쿼리 한 번", (N1_IN_SUBQUERY,), "사람(에이전트가 감쌈)"),
]
