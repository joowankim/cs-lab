"""05 실험 내내 쓰는 orders 표와 100만 행을 만든다.

같은 씨앗(SEED)이면 언제 어디서 만들어도 같은 행이 나온다. 행은 id 순서가 곧 시간 순서다(id 1이 가장 오래됨).
"""

from datetime import datetime, timedelta
import random

SEED = 5
ROWS = 1_000_000
HEAVY_USER = 1  # 주문이 아주 많은 기업 고객
HEAVY_ROWS = 50_000
USERS = 100_000  # 나머지 행은 user_id 2 ~ USERS에 고르게
START = datetime(2025, 11, 10, 0, 0, 0)
SPAN_S = 365 * 86400  # START부터 2026-11-09 23:59:59까지
STATUS = (("paid", 0.90), ("cancelled", 0.97), ("refunded", 1.00))  # 누적 비율
MEMOS = (
    "문 앞에 놓아 주세요",
    "경비실에 맡겨 주세요",
    "배송 전에 연락 바랍니다",
    "부재 시 문 앞에 두고 문자 주세요",
    "택배함에 넣어 주세요",
    "깨지기 쉬운 물건이라 조심히 다뤄 주세요",
    "초인종 누르지 말고 노크해 주세요",
    "공동현관 비밀번호는 문자로 보냈어요",
    "선물 포장 부탁드립니다",
    "빠른 배송 부탁드려요",
)

CREATE_TABLE = """
CREATE TABLE orders (
  id         BIGINT      PRIMARY KEY AUTO_INCREMENT,
  user_id    INT         NOT NULL,
  status     VARCHAR(10) NOT NULL,
  amount     INT         NOT NULL,
  phone      VARCHAR(20) NOT NULL,
  memo       TEXT        NOT NULL,
  created_at DATETIME    NOT NULL
) ENGINE=InnoDB
"""

COLUMNS = ("id", "user_id", "status", "amount", "phone", "memo", "created_at")


def rows(seed: int = SEED, count: int = ROWS, heavy_rows: int = HEAVY_ROWS):
    """(id, user_id, status, amount, phone, memo, created_at)를 id 순서로 하나씩 돌려준다."""
    rng = random.Random(seed)
    offsets = sorted(rng.randrange(SPAN_S) for _ in range(count))
    heavy = set(rng.sample(range(1, count + 1), heavy_rows))
    for row_id in range(1, count + 1):
        user_id = HEAVY_USER if row_id in heavy else rng.randint(2, USERS)
        draw = rng.random()
        status = next(name for name, upto in STATUS if draw < upto)
        amount = rng.randint(10, 2000) * 100
        phone = f"010{rng.randrange(10 ** 8):08d}"
        memo = MEMOS[rng.randrange(len(MEMOS))]
        created_at = START + timedelta(seconds=offsets[row_id - 1])
        yield (row_id, user_id, status, amount, phone, memo, created_at)


# 묶음 ③: 100만 행 표에 더 넣을 10만 행. 같은 분포로 2026-11-10부터 이어지는 시간(100만 행과 같은 빈도)을 쓴다.
MORE_ROWS = 100_000
MORE_SPAN_S = SPAN_S * MORE_ROWS // ROWS  # 36.5일


def more_rows(seed: int = SEED + 1, count: int = MORE_ROWS, first_id: int = ROWS + 1):
    """(id, user_id, status, amount, phone, memo, created_at)를 first_id부터 id 순서로 돌려준다."""
    rng = random.Random(seed)
    span = MORE_SPAN_S * count // MORE_ROWS
    offsets = sorted(rng.randrange(span) for _ in range(count))
    start = START + timedelta(seconds=SPAN_S)
    for n in range(count):
        user_id = HEAVY_USER if rng.random() < HEAVY_ROWS / ROWS else rng.randint(2, USERS)
        draw = rng.random()
        status = next(name for name, upto in STATUS if draw < upto)
        amount = rng.randint(10, 2000) * 100
        phone = f"010{rng.randrange(10 ** 8):08d}"
        memo = MEMOS[rng.randrange(len(MEMOS))]
        yield (first_id + n, user_id, status, amount, phone, memo, start + timedelta(seconds=offsets[n]))


# 묶음 ④: 기본 키로 쓸 16바이트 UUID. 같은 씨앗이면 같은 값이 나오도록 난수 생성기를 받는다.
EPOCH = datetime(1970, 1, 1)


def uuid4_bytes(rng: random.Random) -> bytes:
    """무작위 UUID(버전 4, RFC 9562). 122비트가 난수라 값의 순서가 넣는 순서와 상관없다."""
    value = rng.getrandbits(128)
    value = (value & ~(0xF << 76)) | (0x4 << 76)  # 버전 4
    value = (value & ~(0x3 << 62)) | (0x2 << 62)  # 변형 10
    return value.to_bytes(16, "big")


def uuid7_bytes(created_at: datetime, rng: random.Random) -> bytes:
    """시간 순 UUID(버전 7, RFC 9562). 앞 48비트가 유닉스 밀리초라 넣는 시간 순서대로 커진다.

    같은 밀리초 안에서는 뒤 난수 비트가 순서를 정한다(이 데이터는 created_at이 초 단위라 같은 초끼리는 무작위).
    """
    unix_ms = int((created_at - EPOCH).total_seconds() * 1000)
    rand_a = rng.getrandbits(12)
    rand_b = rng.getrandbits(62)
    value = (unix_ms << 80) | (0x7 << 76) | (rand_a << 64) | (0x2 << 62) | rand_b
    return value.to_bytes(16, "big")
