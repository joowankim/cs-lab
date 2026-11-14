"""묶음 ①②의 조건(보조 인덱스)과 쿼리.

조건마다 orders 표의 보조 인덱스를 모두 지우고 그 조건의 인덱스만 만든 뒤 쿼리를 잰다.
DDL이 오류로 끝나면 오류를 남기고 인덱스 없이 쿼리를 잰다.
author가 "사람"이면 그 조건의 DDL이나 쿼리를 사람이 문제 상황에 답하며 쓴 문장 그대로 쓴다(어느 것인지는 조건 옆 주석에).
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Case:
    name: str
    situation: str  # 문제 상황 번호
    label: str  # 문제 상황에서 부른 이름, 예: "(가)"
    ddl: tuple[str, ...]  # 만들 보조 인덱스. 비어 있으면 보조 인덱스 없음
    queries: tuple[str, ...]  # QUERIES의 이름
    author: str = "에이전트"
    expect_ddl_error: bool = False  # DDL이 오류로 끝나는 것을 보려는 조건이면 True


QUERIES = {
    # 문제 상황 1: "최근 3개월 내 주문" 화면
    "recent-4242": "SELECT created_at, amount FROM orders WHERE user_id = 4242 AND created_at >= '2026-08-10'",
    # 문제 상황 1-1: 같은 화면, 주문이 5만 건인 기업 고객
    "recent-1": "SELECT created_at, amount FROM orders WHERE user_id = 1 AND created_at >= '2026-08-10'",
    # 문제 상황 1-3: 인덱스가 있는데도 범위를 좁히지 못하는 쿼리. 전화번호는 id 777777 행의 값이다.
    "day-func": "SELECT id, amount FROM orders WHERE DATE(created_at) = '2026-08-10'",
    "day-range": "SELECT id, amount FROM orders WHERE created_at >= '2026-08-10' AND created_at < '2026-08-11'",
    "phone-number": "SELECT id, amount FROM orders WHERE phone = 01009234282",
    "phone-string": "SELECT id, amount FROM orders WHERE phone = '01009234282'",
    "phone-suffix": "SELECT id, amount FROM orders WHERE phone LIKE '%4282'",
    "phone-prefix": "SELECT id, amount FROM orders WHERE phone LIKE '0100923%'",
    "user-string": "SELECT id, amount FROM orders WHERE user_id = '4242'",
    "user-int": "SELECT id, amount FROM orders WHERE user_id = 4242",
    "memo-like": "SELECT id, amount FROM orders WHERE memo LIKE '%포장%'",
    # 1-3 3번에 사람이 고쳐 쓴 쿼리(2026-11-10). 끝의 세미콜론만 뺐다.
    "day-fix-person": "SELECT id, amount FROM orders WHERE created_at = DATE('2026-08-10')",
    "phone-fix-person": "SELECT id, amount FROM orders WHERE phone = '01009234282'",
    # 위 day-fix-person이 0행이라 힌트를 받고 다시 고쳐 쓴 판(2026-11-10). 끝의 세미콜론만 뺐다.
    "day-fix-person-2": "SELECT id, amount FROM orders WHERE created_at >= DATE('2026-08-10') and created_at < DATE('2026-08-11')",
    # 묶음 ② 문제 상황 2: 주문 목록을 최신순 20개씩 보여 주는 화면
    "latest-20": "SELECT id, user_id, amount, created_at FROM orders ORDER BY created_at DESC LIMIT 20",
    "user1-latest-20": "SELECT id, amount, created_at FROM orders WHERE user_id = 1 ORDER BY created_at DESC LIMIT 20",
    # 문제 상황 2-1: 5,001번째 페이지(앞에 10만 행)
    "latest-offset-100k": "SELECT id, user_id, amount, created_at FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 100000",
    # 옵티마이저가 idx_created를 고르지 않을 때, 억지로 쓰게 하면 얼마나 걸리는지 견준다.
    "latest-offset-100k-force": ("SELECT id, user_id, amount, created_at FROM orders FORCE INDEX (idx_created) "
                                 "ORDER BY created_at DESC LIMIT 20 OFFSET 100000"),
    # 견줄 커서 쿼리(에이전트가 씀). 5,000번째 페이지의 마지막 행은 (2026-10-04 10:09:05, 900001)이다.
    "latest-cursor-or": ("SELECT id, user_id, amount, created_at FROM orders "
                         "WHERE created_at < '2026-10-04 10:09:05' OR (created_at = '2026-10-04 10:09:05' AND id < 900001) "
                         "ORDER BY created_at DESC, id DESC LIMIT 20"),
    "latest-cursor-row": ("SELECT id, user_id, amount, created_at FROM orders "
                          "WHERE (created_at, id) < ('2026-10-04 10:09:05', 900001) "
                          "ORDER BY created_at DESC, id DESC LIMIT 20"),
    "latest-cursor-created-only": ("SELECT id, user_id, amount, created_at FROM orders "
                                   "WHERE created_at < '2026-10-04 10:09:05' ORDER BY created_at DESC LIMIT 20"),
    # 2-1 2번에 사람이 쓴 커서 쿼리(2026-11-11)는 `ORDER BY created-at`이라 오류 1054(Unknown column 'created')가 난다.
    # 아래는 하이픈 하나만 밑줄로 고친 판이다(오름차순 그대로).
    "latest-cursor-person-hyphen-fixed": ("SELECT id, user_id, amount, created_at FROM orders "
                                          "WHERE created_at < '2026-10-04 10:09:05' ORDER BY created_at LIMIT 20"),
    # 힌트 뒤 사람이 다시 쓴 커서(2026-11-11). 끝의 세미콜론만 뺐다. '10:09;05'의 ';'는 경고 4095와 함께 ':'로 읽힌다.
    "latest-cursor-person-2": ("SELECT id, user_id, amount, created_at FROM orders WHERE created_at < '2026-10-04 10:09;05' "
                               "ORDER BY created_at DESC , id DESC LIMIT 20"),
    # 같은 모양을 같은 초가 경계에 걸친 170번째 페이지에 쓴 판(169번째 페이지 마지막 행 2026-11-08 18:56:53, 996621).
    "latest-cursor-person-2-p170": ("SELECT id, user_id, amount, created_at FROM orders WHERE created_at < '2026-11-08 18:56;53' "
                                    "ORDER BY created_at DESC , id DESC LIMIT 20"),
    "latest-offset-p170": ("SELECT id, user_id, amount, created_at FROM orders ORDER BY created_at DESC, id DESC "
                           "LIMIT 20 OFFSET 3380"),
    "latest-cursor-or-p170": ("SELECT id, user_id, amount, created_at FROM orders "
                              "WHERE created_at < '2026-11-08 18:56:53' OR (created_at = '2026-11-08 18:56:53' AND id < 996621) "
                              "ORDER BY created_at DESC, id DESC LIMIT 20"),
}

CASES = {case.name: case for case in (
    Case("s1-none", "1", "(가)", (), ("recent-4242",)),
    Case("s1-user", "1", "(나)", ("CREATE INDEX idx_user ON orders (user_id)",), ("recent-4242",)),
    # (다)(라)는 사람이 쓴 칼럼 순서에 에이전트가 인덱스 이름과 표를 붙였다(2026-11-09).
    Case("s1-user-created", "1", "(다)", ("CREATE INDEX idx_user_created ON orders (user_id, created_at)",),
         ("recent-4242",), author="사람"),
    Case("s1-created-user", "1", "(라)", ("CREATE INDEX idx_created_user ON orders (created_at, user_id)",),
         ("recent-4242",), author="사람"),
    # (마)는 "클러스터형 인덱스를 다시 읽지 않고 끝나게 하는 인덱스"로 물었고, 사람이 쓴 문장 그대로다(2026-11-09).
    Case("s1-covering", "1", "(마)", ("CREATE INDEX idx_user_id_created_at ON orders (user_id, created_at)",),
         ("recent-4242",), author="사람"),
    # 문제 상황 1-1. (마)는 문제 상황 1 피드백에서 에이전트가 설명한 커버링 인덱스다.
    Case("s1-1-none", "1-1", "(가)", (), ("recent-1",)),
    Case("s1-1-user", "1-1", "(나)", ("CREATE INDEX idx_user ON orders (user_id)",), ("recent-1",)),
    Case("s1-1-user-created", "1-1", "(다)", ("CREATE INDEX idx_user_created ON orders (user_id, created_at)",),
         ("recent-1",), author="사람"),
    Case("s1-1-covering", "1-1", "(마)",
         ("CREATE INDEX idx_user_created_amount ON orders (user_id, created_at, amount)",), ("recent-1",)),
    # 문제 상황 1-3. 인덱스 셋을 함께 두고, 쿼리마다 인덱스로 읽을 범위를 좁히는지 본다.
    # day-range·phone-string·phone-prefix·user-int는 견주어 볼 쿼리다.
    Case("s1-3-indexes", "1-3", "(가)~(라)",
         ("CREATE INDEX idx_created ON orders (created_at)",
          "CREATE INDEX idx_phone ON orders (phone)",
          "CREATE INDEX idx_user ON orders (user_id)"),
         ("day-func", "day-range", "phone-number", "phone-string", "phone-suffix", "phone-prefix",
          "user-string", "user-int")),
    # (마) TEXT 칼럼에 길이 없이 만든 인덱스는 오류(1170)가 날 것으로 보고 오류를 남긴다. 앞부분 길이를 준 인덱스와 견준다.
    Case("s1-3-memo", "1-3", "(마)", ("CREATE INDEX idx_memo ON orders (memo)",), ("memo-like",),
         expect_ddl_error=True),
    Case("s1-3-memo-prefix", "1-3", "(마) 앞부분 길이", ("CREATE INDEX idx_memo ON orders (memo(20))",),
         ("memo-like",)),
    # 3번: 인덱스는 1-3과 같고, 쿼리는 사람이 쓴 문장 그대로다.
    Case("s1-3-fix", "1-3", "3번 고쳐 쓴 쿼리",
         ("CREATE INDEX idx_created ON orders (created_at)",
          "CREATE INDEX idx_phone ON orders (phone)",
          "CREATE INDEX idx_user ON orders (user_id)"),
         ("day-fix-person", "phone-fix-person", "day-fix-person-2", "day-func", "day-range"), author="사람"),
    # (가)를 고치지 않고 함수 인덱스(8.0.13부터)로 받는 방법과 견준다.
    Case("s1-3-func-index", "1-3", "(가) 함수 인덱스", ("CREATE INDEX idx_created_date ON orders ((DATE(created_at)))",),
         ("day-func",)),
    # 묶음 ② 문제 상황 2. (가)(나)는 전체 목록, (다)(라)는 고객 1의 목록이다.
    Case("s2-none", "2", "(가)", (), ("latest-20",)),
    Case("s2-created", "2", "(나)", ("CREATE INDEX idx_created ON orders (created_at)",),
         ("latest-20", "latest-offset-100k", "latest-offset-100k-force", "latest-cursor-or", "latest-cursor-row",
          "latest-cursor-created-only", "latest-cursor-person-hyphen-fixed", "latest-cursor-person-2",
          "latest-cursor-person-2-p170", "latest-offset-p170", "latest-cursor-or-p170")),
    Case("s2-user", "2", "(다)", ("CREATE INDEX idx_user ON orders (user_id)",), ("user1-latest-20",)),
    Case("s2-user-created", "2", "(라)", ("CREATE INDEX idx_user_created ON orders (user_id, created_at)",),
         ("user1-latest-20",)),
)}
