# 04 MySQL 락·데드락·커넥션 풀 — 복습 카드

2026-11-03~04의 실험과 문답을 바탕으로 만든 카드 33개다. MySQL 8.4.13(InnoDB)과 SQLAlchemy 2.1.8을 기준으로 하고, 측정값은 2026-11-04 맥 본 측정(Docker Desktop)에서 잰 값이다. 컨테이너 임시 확인에서만 본 값과 재지 않은 계산은 그 자리에 표시한다. 각 카드의 앞면·뒷면을 나중에 Anki로 옮긴다.

뒷면은 에이전트가 정리한 복습용 답이며, 사람의 독립적인 답변 기록이 아니다. 사람의 실제 예상과 해석은 [실험 README의 시작 전 기록][before]과 [첫 해석][interpretation]에 남겼다. 완료 후 학습 확인은 이 카드를 만든 뒤에 한다.

우선 복습할 카드는 **04-003, 04-006, 04-008, 04-009, 04-011, 04-015, 04-019, 04-024**이다. 보조 인덱스와 클러스터형 인덱스의 정렬, phantom read의 뜻, 조건이 아니라 훑은 레코드마다 걸리는 락, SERIALIZABLE의 평범한 `SELECT`가 거는 공유 락, 함께 쥘 수 있는 갭 락, 데드락 탐지와 락 대기 시간 초과가 되돌리는 범위, 두 데드락의 차이, version을 상수로 쓴 낙관적 락을 다룬다.

## 락의 종류와 표기

### 04-001

**앞면:** InnoDB의 공유 락(S)과 배타 락(X)은 무엇이 다르고, 서로 언제 부딪히는가? `SELECT ... FOR SHARE`, `SELECT ... FOR UPDATE`, `UPDATE`·`DELETE`, 평범한 `SELECT`는 각각 어떤 락을 거는가?

**뒷면:** 같은 레코드에 S는 여러 트랜잭션이 함께 쥘 수 있고, X는 한 트랜잭션만 쥔다. S끼리는 부딪히지 않고, X는 같은 레코드의 S·X 모두와 부딪힌다. `FOR SHARE`는 S, `FOR UPDATE`·`UPDATE`·`DELETE`는 X를 건다. 평범한 `SELECT`는 락 없이 스냅숏을 읽지만, SERIALIZABLE에서는 트랜잭션 안의 평범한 `SELECT`가 `FOR SHARE`로 바뀌어 S를 건다. 락은 격리 수준과 상관없이 쓰기끼리 부딪히고(READ COMMITTED에서도 같은 행의 `UPDATE`는 기다림), 격리 수준은 잠그는 범위를 바꾼다.

**근거:** [문제 상황 1][problem1], [문제 상황 1-2][problem1-2], [InnoDB Locking][innodb-locking], [Transaction Isolation Levels][mysql-iso]

### 04-002

**앞면:** `performance_schema.data_locks`의 `LOCK_MODE`가 `X`, `X,REC_NOT_GAP`, `X,GAP`, `X,GAP,INSERT_INTENTION`, `X,INSERT_INTENTION`이면 각각 어떤 락인가? `LOCK_DATA`가 `supremum pseudo-record`이거나 `7, 2`처럼 값이 둘이면 무엇을 잠근 것인가?

**뒷면:** `X`는 넥스트 키 락(next-key lock, 레코드와 그 앞 갭), `X,REC_NOT_GAP`은 레코드 락(record lock, 레코드만), `X,GAP`은 갭 락(gap lock, 레코드 앞 갭만)이다. `INSERT_INTENTION`이 붙은 것은 `INSERT`가 행을 넣기 전에 그 갭에 거는 삽입 의도 락(insert intention lock)이고, supremum 앞 갭에서는 `GAP` 없이 보였다. S도 같은 꼴이다. supremum pseudo-record는 인덱스의 마지막 레코드 뒤에 있다고 치는 가상 레코드로, 그 락은 마지막 레코드 뒤의 갭을 잠근다. 보조 인덱스의 `LOCK_DATA`는 보조 키 값 뒤에 기본 키 값을 붙여 보여 준다(`idx_user`의 `7, 2`는 user_id 7, id 2의 인덱스 레코드). 매뉴얼의 `LOCK_MODE` 설명에는 `REC_NOT_GAP`과 `INSERT_INTENTION`이 없고, 이 두 표기는 측정에서 본 값이다.

**근거:** [묶음 ① 결과][batch1], [문제 상황 1의 이어진 문답][problem1], [The data_locks Table][data-locks]

### 04-003

**앞면:** `entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))`에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. `PRIMARY`와 `idx_user`의 인덱스 레코드는 각각 어떤 순서로 놓이는가? 새 행 (10, 7), (11, 5), (13, 15)는 두 인덱스에서 각각 어느 갭에 들어가는가?

**뒷면:** 클러스터형 인덱스(clustered index) `PRIMARY`는 기본 키 순으로 1, 2, 3, 4, supremum이고 행 데이터가 여기에 있다. 보조 인덱스(secondary index) `idx_user`는 (user_id, id) 순으로 (3, 1), (7, 2), (7, 3), (12, 4), supremum이다. `idx_user`에서 (7, 10)은 (7, 3)과 (12, 4) 사이, (5, 11)은 (3, 1)과 (7, 2) 사이, (15, 13)은 (12, 4)와 supremum 사이 갭에 들어간다. `PRIMARY`에서는 셋 모두 4와 supremum 사이 갭이다. 갭은 정렬 순서에서 이웃한 두 레코드 사이의 키 범위라, 같은 행도 인덱스마다 다른 갭에 들어간다. 보조 인덱스가 없는 표에서는 `PRIMARY`의 id 순서만 따진다.

**근거:** [문제 상황 1의 이어진 문답][problem1], [문제 상황 1-2][problem1-2]

## 범위를 잠그는 락

### 04-004

**앞면:** `entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))`에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 REPEATABLE READ에서 `START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;`(2, 3)를 하고 커밋하지 않았다. 이어서 B가 자동 커밋으로 다섯 문장 중 하나를 보내고, 경우마다 처음 행에서 따로 돌린다. (가) `INSERT INTO entries VALUES (10, 7);` (나) `(11, 5)` (다) `(12, 10)` (라) `(13, 15)` (마) `(14, 1)`. 각각 A의 `COMMIT`까지 기다리는가, 바로 끝나는가? A가 쥔 락은?

**뒷면:** (가)(나)(다)는 A의 `COMMIT`까지 기다렸고, (라)(마)는 바로 끝났다. A는 `idx_user`의 (7, 2)·(7, 3)에 넥스트 키 락, (12, 4)에 갭 락, `PRIMARY`의 2·3에 레코드 락을 쥐었다. 잠금 읽기는 훑은 인덱스 레코드마다 락을 건다. 조건에 맞는 (7, 2)·(7, 3)은 넥스트 키 락으로 각자의 앞 갭까지, 멈추려고 읽은 (12, 4)는 조건에 맞지 않아 앞 갭만 잠갔다. 그래서 user_id 7이 들어갈 수 있는 갭이 모두 잠겼고, 같은 갭에 들어가는 user 5·10도 막혔다. (가)(다)는 (7, 3)과 (12, 4) 사이 갭이라 (12, 4)에, (나)는 (3, 1)과 (7, 2) 사이 갭이라 (7, 2)에 `X,GAP,INSERT_INTENTION`으로 기다렸다. 행 데이터가 있는 `PRIMARY`는 고유 키로 찾아 레코드만 잠갔다.

**근거:** [문제 상황 1][problem1], [묶음 ① 결과][batch1]

### 04-005

**앞면:** `entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))`에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 REPEATABLE READ에서 `START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;`(2, 3)를 하고 커밋하지 않자, B(자동 커밋)의 `INSERT INTO entries VALUES (10, 7);`뿐 아니라 user_id가 7이 아닌 `(11, 5)`와 `(12, 10)`의 삽입도 A의 `COMMIT`까지 기다렸다. A의 잠금 읽기는 user_id 7인 행뿐 아니라 그 앞뒤 갭까지 잠근 것이다. 갭까지 잠그는 이유는 무엇이고, 그 대가는?

**뒷면:** 팬텀을 막기 위해서다. A가 2, 3을 잠근 뒤 B가 (10, 7)을 넣고 커밋할 수 있다면, A가 같은 `FOR UPDATE`를 다시 할 때 10이 새로 나타난다(phantom read). READ COMMITTED에서는 실제로 둘째 `FOR UPDATE`가 2, 3, 10을 돌려줬다(컨테이너 임시 확인). 레코드 락은 아직 없는 행에 걸 수 없어서, 새 행이 들어올 수 있는 범위(갭)를 잠가 삽입을 막는다. 막는 것은 수정이 아니라 삽입이다. 대가는 갭이 키 범위라 조건에 맞지 않는 키의 삽입도 함께 기다린다는 것이다(user 5·10). 평범한 `SELECT`의 일관성은 스냅숏이 맡고, 갭 락은 최신 행을 읽고 잠그는 문장에서 생긴다.

**근거:** [문제 상황 1의 이어진 문답][problem1], [InnoDB Locking][innodb-locking]

### 04-006

**앞면:** `entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))`에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 READ COMMITTED에서 `START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;`(2, 3)를 하고, B가 자동 커밋으로 `INSERT INTO entries VALUES (10, 7);`을 한 뒤, A가 같은 `SELECT ... FOR UPDATE`를 다시 하자 2, 3, 10이 나왔다. 새로 나타난 10은 어떤 현상이고, non-repeatable read와 무엇이 다른가? REPEATABLE READ에서는 무엇이 이것을 막는가?

**뒷면:** phantom read다. 같은 조건으로 다시 읽은 행 집합에 없던 행이 나타나거나 있던 행이 사라진 것이다. non-repeatable read는 이미 읽은 같은 행의 값이 다른 트랜잭션의 커밋으로 바뀐 것이다. 이미 읽은 행은 레코드 락으로 지킬 수 있지만, 아직 없는 행에는 레코드 락을 걸 수 없어 팬텀은 갭 락(넥스트 키 락)이 막는다. REPEATABLE READ에서는 A의 넥스트 키 락·갭 락이 user_id 7이 들어갈 갭을 잠가 B의 `INSERT`가 A의 `COMMIT`까지 기다린다. 잠그지 않는 평범한 `SELECT`는 REPEATABLE READ에서 스냅숏으로 읽어 팬텀을 보지 않는다.

**근거:** [문제 상황 1의 이어진 문답][problem1], [03-003](03-mysql-isolation-mvcc.md#03-003)

### 04-007

**앞면:** `entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))`에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 READ COMMITTED에서 `START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;`를 하고 커밋하지 않았다. 이어서 B가 자동 커밋으로 다섯 문장 중 하나를 보내고, 경우마다 처음 행에서 따로 돌린다. (가) `INSERT INTO entries VALUES (10, 7);` (나) `(11, 5)` (다) `(12, 10)` (라) `(13, 15)` (마) `(14, 1)`. 각각 기다리는가? A가 쥔 락은?

**뒷면:** 다섯 모두 바로 끝났다. A는 `idx_user`의 (7, 2)·(7, 3)과 `PRIMARY`의 2·3에 레코드 락만 쥐었다. READ COMMITTED의 잠금 읽기와 `UPDATE`·`DELETE`는 인덱스 레코드만 잠그고 그 앞 갭은 잠그지 않는다(갭 락은 외래 키 검사와 중복 키 검사에만 쓴다). 삽입을 덜 막는 대신, 같은 잠금 읽기를 다시 하면 새 행이 보이는 팬텀을 허용한다.

**근거:** [묶음 ① 결과][batch1], [Transaction Isolation Levels][mysql-iso]

### 04-008

**앞면:** `entries (id INT PRIMARY KEY, user_id INT NOT NULL)`(user_id 인덱스 없음)에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 REPEATABLE READ에서 `START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;`를 하고 커밋하지 않았다. 이어서 B가 자동 커밋으로 세 문장 중 하나를 보내고, 경우마다 처음 행에서 따로 돌린다. (가) `INSERT INTO entries VALUES (10, 7);` (나) `INSERT INTO entries VALUES (13, 15);` (다) `DELETE FROM entries WHERE id = 1;`(user_id 3의 행). 각각 A의 `COMMIT`까지 기다리는가? A가 READ COMMITTED라면?

**뒷면:** REPEATABLE READ에서는 셋 모두 A의 `COMMIT`까지 기다렸다. user_id로 찾을 인덱스가 없어 A는 `PRIMARY`를 처음부터 끝까지 훑었고, 잠금 읽기는 조건과 상관없이 훑은 레코드마다 락을 걸어 1, 2, 3, 4와 supremum에 넥스트 키 락이 걸렸다. 두 삽입은 supremum의 락(4 뒤 갭)에, 삭제는 1의 락에 막혔다. A도 행 1을 읽어 봐야 user_id가 3인 것을 알고, 읽으면서 이미 잠갔다. READ COMMITTED에서는 셋 모두 바로 끝났다. 조건을 확인한 뒤 맞지 않는 행(1, 4)의 락을 풀고 갭을 잠그지 않아 `PRIMARY` 2·3의 레코드 락만 남았다. 보조 인덱스가 없어도 클러스터형 인덱스의 레코드와 갭은 있다.

**근거:** [문제 상황 1-1][problem1-1], [묶음 ① 결과][batch1], [Locks Set by Different SQL Statements in InnoDB][locks-set]

### 04-009

**앞면:** `entries (id INT PRIMARY KEY, user_id INT NOT NULL)`(user_id 인덱스 없음)에 (id, user_id) = (1, 7), (2, 7), (3, 8)이 있다. A와 B 모두 SERIALIZABLE이다. A가 `START TRANSACTION;` 뒤 평범한 `SELECT id FROM entries WHERE user_id = 7 ORDER BY id;`만 하고 커밋하기 전에, B가 `START TRANSACTION;` `INSERT INTO entries (id, user_id) VALUES (4, 7);` `COMMIT;`을 했다. B의 `INSERT`는 A의 `COMMIT`까지 기다렸다. A가 쥔 락을 `data_locks` 꼴(인덱스, `LOCK_MODE`, `LOCK_DATA`)로 적고, B를 막은 락은 그중 어느 것인지 말하라.

**뒷면:** SERIALIZABLE은 트랜잭션 안의 평범한 `SELECT`를 `SELECT ... FOR SHARE`로 바꾼다. A는 user_id 인덱스가 없어 `PRIMARY`를 훑으며 1, 2, 3과 supremum에 공유 넥스트 키 락(`S`)을 쥐었다. `PRIMARY`는 id 순이라 id 4는 3과 supremum 사이 갭에 들어가고, B를 막은 것은 supremum의 넥스트 키 락이다(B는 supremum에 `X,INSERT_INTENTION` WAITING). A가 읽기만 했는데 삽입이 막힌 것은 갭 락이 S든 X든 똑같이 삽입만 막기 때문이다. B가 기다린 1.74~1.75초는 순서표가 A의 `COMMIT`을 보낸 때로 정해진 값이고, 기다렸다는 것이 결과다.

**근거:** [문제 상황 1-2][problem1-2], [묶음 ① 결과][batch1], [InnoDB Locking][innodb-locking]

### 04-010

**앞면:** 삽입 의도 락(insert intention lock)은 무엇이고, 무엇과 부딪히는가? 두 트랜잭션이 같은 갭의 서로 다른 자리에 행을 넣으면 서로 기다리는가?

**뒷면:** `INSERT`가 행을 넣기 전에 들어갈 갭에 거는 갭 락의 한 종류다. 같은 갭이라도 같은 자리에 넣는 것이 아니면 삽입끼리는 서로 기다리지 않는다. 대신 다른 트랜잭션이 그 갭에 쥔 갭 락·넥스트 키 락과 부딪혀, 그 트랜잭션이 끝날 때까지 기다린다. 이번 순서표에서 갭의 락에 막힌 `INSERT`는 모두 `data_locks`에 `INSERT_INTENTION` WAITING으로 보였다.

**근거:** [묶음 ① 결과][batch1], [InnoDB Locking][innodb-locking]

### 04-011

**앞면:** 빈 표 `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))`가 있다. A가 REPEATABLE READ에서 `START TRANSACTION; SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 FOR UPDATE;`를 하고 커밋하지 않았다. 이어서 B가 같은 두 문장을 보내면 기다리는가? 두 트랜잭션이 쥔 락은?

**뒷면:** B는 기다리지 않고 0을 받았다. A와 B 모두 `idx_user_event`의 supremum pseudo-record에 `X`를 GRANTED로 쥐었다. 아직 행이 없어 잠긴 것은 갭이고, 갭 락끼리는 부딪히지 않는다. 갭 락은 삽입만 막는 락이라 S와 X의 차이가 없고, 여러 트랜잭션이 같은 갭에 함께 쥘 수 있다. 그래서 갭 락으로는 같은 범위를 노리는 요청을 줄 세울 수 없다.

**근거:** [묶음 ②·③ 결과의 두 요청 순서표][burst], [InnoDB Locking][innodb-locking]

## 데드락

### 04-012

**앞면:** `points (user_id INT PRIMARY KEY, balance INT NOT NULL)`에 (7, 1000)이 있다. 요청 10개가 같은 순간에 연결 하나씩으로 `START TRANSACTION;` → `SELECT balance FROM points WHERE user_id = 7;` → 앱이 읽은 값 - 100을 계산(50ms) → `UPDATE points SET balance = <계산한 값> WHERE user_id = 7;` → `COMMIT;`을 한다. 오류가 나면 그 요청은 실패로 끝나고 다시 하지 않는다. 데드락 탐지 켬, 락 대기 한도 5초이고, 다 반영되면 잔액은 0이다. READ COMMITTED, REPEATABLE READ, SERIALIZABLE에서 1213(데드락)을 받는 요청 수와 끝난 뒤 잔액은?

**뒷면:** 셋 모두 잔액 900이었다. READ COMMITTED·REPEATABLE READ는 1213 없이 10건이 모두 성공했다. 10건이 모두 1000을 읽어 900을 계산했고, `UPDATE`가 행 락을 차례로 받아 모두 900을 써서 9건이 갱신 손실(lost update)로 조용히 사라졌다. SERIALIZABLE은 9건이 1213을 받고 1건만 성공했다. 평범한 `SELECT`가 `FOR SHARE`가 되어 10건이 모두 S를 쥐었고, 각자의 `UPDATE`에 필요한 X가 다른 요청들의 S와 부딪혀 고리가 생겼다. 같은 900이어도 SERIALIZABLE은 잃은 9건이 오류로 드러나 다시 시도할 수 있다.

**근거:** [문제 상황 2-1][problem2-1], [묶음 ②·③ 결과][burst]

### 04-013

**앞면:** `accounts (id INT PRIMARY KEY, balance INT NOT NULL)`에 (1, 1000), (2, 1000)이 있다. REPEATABLE READ, 데드락 탐지 켬(기본값), 락 대기 한도 5초. A(1번 계좌 → 2번으로 100)가 `START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1;`, B(2번 → 1번으로 100)가 `START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 2;`, A가 `UPDATE accounts SET balance = balance + 100 WHERE id = 2;`, 2초 뒤 B가 `UPDATE accounts SET balance = balance + 100 WHERE id = 1;`을 보내고, 이어서 A `COMMIT;`, B `COMMIT;`이다. 오류가 나도 다음 문장을 그대로 보낸다(오류를 확인하지 않는 앱). A의 셋째 문장과 B의 넷째 문장은 어떻게 끝나고, 잔액은?

**뒷면:** A의 셋째 문장은 B가 쥔 id 2의 레코드 락을 기다렸다. B의 넷째 문장이 A가 쥔 id 1을 기다리며 고리를 만들자 InnoDB가 바로 찾아 B에 1213(Deadlock found when trying to get lock)을 주고 B의 트랜잭션 전체를 되돌렸다. B가 쥔 id 2의 락이 풀려 A의 셋째 문장이 끝났다(2.01초 기다림, 넷째 문장까지의 시간). A만 커밋돼 잔액은 900, 1100이고 합 2000이 유지된다.

**근거:** [문제 상황 2][problem2], [묶음 ② 결과][batch2]

### 04-014

**앞면:** `accounts (id INT PRIMARY KEY, balance INT NOT NULL)`에 (1, 1000), (2, 1000)이 있다. REPEATABLE READ, 데드락 탐지 끔(`innodb_deadlock_detect=OFF`), 락 대기 한도(`innodb_lock_wait_timeout`) 5초. A(1번 계좌 → 2번으로 100)가 `START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1;`, B(2번 → 1번으로 100)가 `START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 2;`, A가 `UPDATE accounts SET balance = balance + 100 WHERE id = 2;`, 2초 뒤 B가 `UPDATE accounts SET balance = balance + 100 WHERE id = 1;`을 보내고, 이어서 A `COMMIT;`, B `COMMIT;`이다. 오류가 나도 다음 문장을 그대로 보낸다(오류를 확인하지 않는 앱). A의 셋째 문장과 B의 넷째 문장은 어떻게 끝나고, 잔액은?

**뒷면:** 먼저 기다린 A의 셋째 문장이 5.03~5.04초 뒤 1205(Lock wait timeout exceeded)를 받았다. 1205는 기다리던 문장 하나만 되돌리고 트랜잭션과 쥔 락은 그대로 둔다. A가 id 1의 락을 쥔 채 `COMMIT`해 id 1의 -100만 확정했고, 그때 락이 풀려 B의 넷째 문장이 끝났다(3.33~3.34초 기다림). 잔액은 1000, 900으로 합 1900이라 100이 사라졌다. 1205를 받으면 앱은 그대로 `COMMIT`하지 말고 `ROLLBACK`한 뒤 다시 해야 한다.

**근거:** [문제 상황 2][problem2], [묶음 ② 결과][batch2], [InnoDB Error Handling][error-handling]

### 04-015

**앞면:** InnoDB에서 데드락을 끝내는 두 방법, 데드락 탐지(`innodb_deadlock_detect=ON`)와 락 대기 시간 초과(`innodb_lock_wait_timeout`)는 무엇이 다르고, 각각 무엇을 되돌리는가? 앱은 각각 어떻게 대응하는가?

**뒷면:** 탐지(기본값)는 기다리는 관계에서 고리를 찾아, 고리가 생기는 즉시 한 트랜잭션을 골라 1213을 주고 그 트랜잭션 전체를 되돌린다. 이체 실험에서 고리를 만든 B의 문장은 기다리지 않고 바로 1213을 받았다. 탐지를 끄면 고리를 찾지 않고, 기다린 시간이 `innodb_lock_wait_timeout`(이번 5초)을 넘은 문장이 1205를 받는다. 1205는 그 문장만 되돌리고 트랜잭션은 열어 둔다. 앱은 1213이면 트랜잭션을 처음부터 다시 하고, 1205면 `ROLLBACK`할지 직접 정해야 한다(반쪽 이체를 커밋하지 않으려면 `ROLLBACK`). 탐지는 같은 락을 기다리는 스레드가 아주 많으면 느려질 수 있어, 그런 곳에서는 끄고 시간 초과에 맡기기도 한다.

**근거:** [문제 상황 2][problem2], [InnoDB Error Handling][error-handling], [Deadlock Detection][deadlock-detection]

### 04-016

**앞면:** `accounts (id INT PRIMARY KEY, balance INT NOT NULL)`에 (1, 1000), (2, 1000)이 있다. REPEATABLE READ, 데드락 탐지 켬. A(1번 → 2번으로 100)가 `START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1;`, B(2번 → 1번으로 100)가 `START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 2;`, A가 `UPDATE accounts SET balance = balance + 100 WHERE id = 2;`, 2초 뒤 B가 `UPDATE accounts SET balance = balance + 100 WHERE id = 1;`을 보내 데드락이 났다. `SHOW ENGINE INNODB STATUS`의 LATEST DETECTED DEADLOCK을 줄이면 아래와 같다(맥 측정, 줄임은 `...`). (1)과 (2)는 A와 B 중 누구인가? 데드락의 네 조건(상호 배제, 점유 대기, 비선점, 순환 대기)은 각각 어디에 보이는가? `80000001`은 무엇인가?

```
*** (1) TRANSACTION:
UPDATE accounts SET balance = balance + 100 WHERE id = 2
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS ... index PRIMARY of table `lab`.`accounts` ... lock_mode X locks rec but not gap
 0: len 4; hex 80000001; ...
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS ... index PRIMARY of table `lab`.`accounts` ... lock_mode X locks rec but not gap waiting
 0: len 4; hex 80000002; ...
*** (2) TRANSACTION:
UPDATE accounts SET balance = balance + 100 WHERE id = 1
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS ... index PRIMARY of table `lab`.`accounts` ... lock_mode X locks rec but not gap
 0: len 4; hex 80000002; ...
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS ... index PRIMARY of table `lab`.`accounts` ... lock_mode X locks rec but not gap waiting
 0: len 4; hex 80000001; ...
*** WE ROLL BACK TRANSACTION (2)
```

**뒷면:** (1)은 id 2를 기다리는 A, (2)는 id 1을 기다리는 B다(각 트랜잭션의 문장으로 안다). 상호 배제는 쥔 락의 `lock_mode X`(한 트랜잭션만 쥠)에, 점유 대기는 두 트랜잭션 모두 HOLDS와 WAITING이 함께 있는 데, 순환 대기는 (1)이 기다리는 `80000002`를 (2)가 쥐고 (2)가 기다리는 `80000001`을 (1)이 쥔 짝에 보인다. 비선점은 InnoDB가 락을 빼앗지 않고 한쪽 트랜잭션을 통째로 되돌리는 마지막 줄 `WE ROLL BACK TRANSACTION (2)`로 보인다. 레코드 칸 `0:`은 기본 키이고, `80000001`은 INT 1(부호 비트를 뒤집어 저장)이다. `lock_mode X locks rec but not gap`은 `data_locks`의 `X,REC_NOT_GAP`이다.

**근거:** [문제 상황 2의 이어서 낸 물음][problem2], [묶음 ② 결과][batch2]

### 04-017

**앞면:** `accounts (id INT PRIMARY KEY, balance INT NOT NULL)`에 (1, 1000), (2, 1000)이 있다. REPEATABLE READ, 락 대기 한도 5초. A(1번 → 2번으로 100)와 B(2번 → 1번으로 100)가 둘 다 작은 id부터 고친다. A `START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1;` → B `START TRANSACTION; UPDATE accounts SET balance = balance + 100 WHERE id = 1;` → A `UPDATE accounts SET balance = balance + 100 WHERE id = 2;` → B `UPDATE accounts SET balance = balance - 100 WHERE id = 2;` → A `COMMIT;` → B `COMMIT;`. B가 id 2부터 고치던 판에서는 데드락이 났다. 이 순서는 어떻게 끝나는가? 데드락 탐지를 켜고 끄는 것이 결과를 바꾸는가?

**뒷면:** B의 첫 `UPDATE`가 A가 쥔 id 1의 락에서 A의 `COMMIT`까지 기다렸다가 끝났고(1.42~1.44초), 데드락과 오류 없이 1000, 1000이었다. 두 트랜잭션이 같은 순서로 락을 잡으면 뒤 트랜잭션이 첫 락에서 줄을 서서 고리가 생기지 않으므로, 탐지를 켜도 꺼도 같았다. 이 방법은 먼저 잡는 락이 서로 부딪힐 때(같은 행의 배타 락) 통한다.

**근거:** [문제 상황 2의 이어서 낸 물음][problem2], [묶음 ② 결과][batch2], [How to Minimize and Handle Deadlocks][deadlocks-handling]

### 04-018

**앞면:** 격리 수준을 올리면 데드락이 줄어드는가? InnoDB에서 데드락을 줄이는 방법은?

**뒷면:** 줄지 않고 늘 수 있다. 같은 행을 10건이 읽고 고친 실험에서 READ COMMITTED·REPEATABLE READ는 데드락이 없었지만(대신 갱신 손실), SERIALIZABLE은 평범한 `SELECT`가 공유 락을 걸어 9건이 1213을 받았다. REPEATABLE READ의 잠금 읽기도 갭까지 잠가 READ COMMITTED보다 넓게 막는다. 매뉴얼이 드는 방법은 여러 행을 늘 같은 순서로 고치기, 트랜잭션을 작고 짧게 하기, 잠금 읽기에는 READ COMMITTED처럼 낮은 격리 수준 쓰기, 데드락으로 실패한 트랜잭션을 다시 하기다. 데드락을 모두 없앨 수는 없어 다시 하기를 늘 준비한다.

**근거:** [문제 상황 2-1][problem2-1], [묶음 ① 결과][batch1], [How to Minimize and Handle Deadlocks][deadlocks-handling]

### 04-019

**앞면:** 빈 표 `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))`가 있다. REPEATABLE READ, 데드락 탐지 켬. A가 `START TRANSACTION; SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 FOR UPDATE;`(0), B가 같은 두 문장(0), A가 `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);`, B가 같은 `INSERT`, A `COMMIT;`, B `COMMIT;`을 차례로 보낸다. 어떻게 끝나는가? 다음 이체 데드락과 같은 점·다른 점은? `accounts (id INT PRIMARY KEY, balance INT NOT NULL)` (1, 1000), (2, 1000)에서 A가 `UPDATE accounts SET balance = balance - 100 WHERE id = 1;`, B가 `UPDATE accounts SET balance = balance - 100 WHERE id = 2;`, A가 `UPDATE accounts SET balance = balance + 100 WHERE id = 2;`, B가 `UPDATE accounts SET balance = balance + 100 WHERE id = 1;`을 보내 B가 1213을 받았고, B도 id 1부터 고치게 바꾸자(락 순서 고정) 데드락이 없어졌다. 락 순서 고정으로 rewards의 데드락도 막을 수 있는가?

**뒷면:** B의 `COUNT ... FOR UPDATE`는 기다리지 않아 A와 B 모두 supremum에 `X`를 쥐었다. A의 `INSERT`는 삽입 의도 락이 B의 갭 락에 막혀 기다렸고, B의 `INSERT`가 A의 갭 락을 기다리며 고리가 되어 B가 바로 1213을 받았다(rewards는 A의 1행). 고리가 생겨 InnoDB가 한쪽 트랜잭션 전체를 되돌린 것은 이체와 같다. 다른 것은 쥔 락이다. 이체는 서로 다른 두 행의 레코드 락을 반대 순서로 잡아, 상대 행을 잡으려는 순간 기다렸다. 여기서는 같은 갭을 같은 순서로 잡았지만 갭 락끼리 부딪히지 않아 둘 다 첫 락을 통과했다. 이미 같은 순서라 락 순서 고정으로는 막지 못하고, 이미 있는 행의 배타 락을 먼저 잡거나 유니크 제약을 둬야 한다.

**근거:** [묶음 ②·③ 결과의 두 요청 순서표][burst], [첫 해석][interpretation-deadlocks]

## 중복 지급 막기

### 04-020

**앞면:** `points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)`에 (7, 0, 0)이 있고, `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))`는 비어 있다. REPEATABLE READ에서 user 7의 같은 리워드 요청 10건이 같은 순간에 온다. 요청마다 `START TRANSACTION;` → `SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;`(0이 아니면 `ROLLBACK`, 이미 받음) → 50ms → `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7;` → `COMMIT;`. 끝난 뒤 rewards 행 수, 잔액, 오류는?

**뒷면:** 10행, 10000, 오류 없음이었다. 10건이 모두 아무도 커밋하기 전에 COUNT 0을 보고 지급했다. 확인한 때와 쓰는 때 사이에 다른 요청이 끼어든 경쟁 상태(race condition)이고, 평범한 `SELECT`는 락을 걸지 않아 서로를 막지 않는다. 잔액은 `balance = balance + 1000`이 최신 행을 고쳐 10번 모두 반영됐다.

**근거:** [문제 상황 3][problem3], [묶음 ②·③ 결과][burst]

### 04-021

**앞면:** `points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)`에 (7, 0, 0)이 있고, `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))`는 비어 있다. REPEATABLE READ에서 같은 요청 10건이 동시에 `START TRANSACTION;` → `SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 FOR UPDATE;`(0이 아니면 `ROLLBACK`) → 50ms → `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7;` → `COMMIT;`을 한다(비관적 락의 첫 판). 10건의 결과는? 표를 `UNIQUE KEY idx_user_event (user_id, event_id)`로 바꾸면?

**뒷면:** 1행, 1000이었지만 9건이 1213(데드락)을 받았다. 10건이 모두 같은 supremum 갭에 갭 락을 함께 쥐고, 각자의 `INSERT`가 다른 요청들의 갭 락에 막혀 고리가 생겨 InnoDB가 9건을 되돌렸다. 중복은 막았지만 줄을 세운 것이 아니라 데드락으로 막은 것이다. `UNIQUE KEY`로 바꿔도 데드락이 먼저 나서 1213 9건 그대로였고 1062는 없었다.

**근거:** [문제 상황 3][problem3], [묶음 ②·③ 결과][burst]

### 04-022

**앞면:** `points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)`에 (7, 0, 0)이 있고, `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))`는 비어 있다. REPEATABLE READ에서 같은 리워드 요청 10건이 동시에 오고, 요청마다 `START TRANSACTION;` → `SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;`(0이 아니면 `ROLLBACK`, 이미 받음) → 50ms → `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7;` → `COMMIT;`이다. 이 COUNT를 `SELECT COUNT(*) ... FOR UPDATE`로 바꾼 첫 판은 10건이 아직 없는 범위의 갭 락을 함께 쥐어 9건이 1213을 받았다. 10건을 데드락 없이 줄 세우려면 무엇을 잠가야 하는가? 그렇게 고친 요청과 10건의 결과는?

**뒷면:** 같은 사용자의 요청이 모두 거쳐 가는, 이미 있는 행을 첫 문장에서 잠근다. 요청은 `START TRANSACTION;` → `SELECT balance FROM points WHERE user_id = 7 FOR UPDATE;` → `SELECT COUNT(*) ...`(0이 아니면 `ROLLBACK`) → 50ms → `INSERT` → 잔액 `UPDATE` → `COMMIT;`이다. 그 행의 배타 락은 한 트랜잭션만 쥐어 나머지가 첫 문장에서 줄을 선다. 결과는 1행, 1000, 오류 없음이었다. 9건은 락을 받은 뒤 처음 읽는 COUNT가 스냅숏을 만들어 앞 요청이 커밋한 행을 보고 "이미 받음"으로 끝났다. 첫 요청이 58~64ms에 끝난 뒤 나머지는 약 1.5ms 간격으로 끝났다(요청 시간 중앙값 65~70ms, 최대 72~78ms).

**근거:** [문제 상황 3의 고친 판][problem3], [묶음 ②·③ 결과][burst]

### 04-023

**앞면:** `points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)`에 (7, 0, 0)이 있고, `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))`는 비어 있다. REPEATABLE READ에서 같은 요청 10건이 동시에 `START TRANSACTION;` → `SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;` → `SELECT balance FROM points WHERE user_id = 7 FOR UPDATE;` → (COUNT가 0이 아니면 `ROLLBACK`) → 50ms → `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7;` → `COMMIT;`을 한다. 10건의 결과는? 잠근 뒤 평범한 COUNT를 한 번 더 하면?

**뒷면:** 10행, 10000이었다. 10건이 잠그기 전에 COUNT 0을 받아 둔 채 락에서 줄을 섰다가 그 0을 믿고 지급했다(time-of-check to time-of-use). 줄은 서서 약 62~63ms 간격으로 끝났다(마지막 621~626ms). 잠근 뒤 평범한 COUNT를 다시 해도 REPEATABLE READ에서는 첫 COUNT가 만든 스냅숏으로 읽어 0을 봐 10행이고, READ COMMITTED는 문장마다 새 스냅숏이라 1을 봐 1행이었다(둘 다 컨테이너 임시 확인). 잠그는 문장이 트랜잭션의 첫 문장이어야 한다.

**근거:** [문제 상황 3의 이어서 낸 물음][problem3], [묶음 ②·③ 결과][burst]

### 04-024

**앞면:** `points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)`에 (7, 0, 0)이 있고, `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))`는 비어 있다. REPEATABLE READ에서 같은 요청 10건이 동시에 온다. (가) 요청이 `START TRANSACTION;` → `SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;`(0이 아니면 `ROLLBACK`) → 50ms → `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7 AND version = 0;` → `COMMIT;`(0행이어도 커밋)이면? (나) 잔액 `UPDATE`가 0행이면 `ROLLBACK`하고, 1행이면 `UPDATE points SET version = version + 1 WHERE user_id = 7;` 뒤 `COMMIT`하면? (다) (나)에서 points의 처음 version이 3이면?

**뒷면:** (가)는 10행, 10000이었다. 아무도 version을 올리지 않아 10건 모두 `version = 0`에 맞았다. (나)는 1행, 1000이었다. 1건이 version을 1로 올리고, 9건은 잔액 `UPDATE`가 0행이라 되돌렸다. (다)는 10건 모두 0행이라 0행, 0이었다(아무도 받지 못함). 비교할 값을 상수 0으로 박아 두어서 처음 값이 0일 때만 맞게 보였다. 낙관적 락은 "내가 읽은 뒤로 아무도 바꾸지 않았으면 쓴다"라서, 비교할 값은 트랜잭션 처음에 읽은 version이다.

**근거:** [문제 상황 3][problem3], [묶음 ②·③ 결과][burst]

### 04-025

**앞면:** `points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)`에 (7, 0, 0)이 있고, `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))`는 비어 있다. REPEATABLE READ에서 같은 리워드 요청 10건이 동시에 오고, 지금 요청은 `START TRANSACTION;` → `SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;`(0이 아니면 `ROLLBACK`, 이미 받음) → 50ms → `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7;` → `COMMIT;`이다(10건 모두 지급해 10행, 10000). 이 요청을 version으로 중복 지급을 막는 낙관적 락으로 고쳐 적고, 10건의 결과를 말하라. version 확인이 0행일 때 처음부터 다시 하는 이유는? 확인을 `SELECT`가 아니라 `UPDATE`에서 하는 이유는?

**뒷면:** `START TRANSACTION;` → `SELECT version FROM points WHERE user_id = 7;`(v, 잠그지 않음) → COUNT(0이 아니면 `ROLLBACK`) → 50ms → `INSERT` → `UPDATE points SET version = version + 1 WHERE user_id = 7 AND version = v;`(0행이면 `ROLLBACK` 뒤 처음부터, 최대 3번) → 잔액 `UPDATE` → `COMMIT;`. 결과는 1행, 1000, version 1, 오류 없음이었다. 9건은 version 확인이 0행이라 되돌린 뒤 다시 해 COUNT 1을 보고 "이미 받음"으로 끝났다(다시 시도 9번, 요청 시간 중앙값 63~69ms, 최대 66~74ms). 0행은 "읽은 뒤 누군가 이 행을 바꿨다"만 알려 주므로, 이미 받았는지는 다시 해 봐야 안다. `UPDATE`는 그 행의 배타 락을 잡은 채 최신 행으로 `WHERE`를 따져 확인과 쓰기 사이에 끼어들 틈이 없고, `SELECT`로 따로 확인하면 확인 뒤에 틈이 생긴다.

**근거:** [문제 상황 3의 낙관적 락 최종판][problem3], [묶음 ②·③ 결과][burst]

### 04-026

**앞면:** `points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)`에 (7, 0, 0)이 있고, `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, UNIQUE KEY idx_user_event (user_id, event_id))`는 비어 있다. REPEATABLE READ에서 같은 요청 10건이 동시에 `START TRANSACTION;` → `SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;`(0이 아니면 `ROLLBACK`, 이미 받음) → 50ms → `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7;` → `COMMIT;`을 하고, `INSERT`가 1062면 `ROLLBACK`하고 "이미 받음"으로 끝낸다. 10건의 결과는? 2~10번째 `INSERT`는 어떻게 1062를 받는가?

**뒷면:** 1행, 1000이었고 9건이 1062(Duplicate entry)를 받아 "이미 받음"으로 끝났다. 10건 모두 COUNT 0을 봤지만, 2~10번째 `INSERT`는 첫 요청이 넣고 아직 커밋하지 않은 같은 키를 만나 그 커밋까지 기다린 뒤 1062를 받았다(컨테이너 임시 확인에서 본 순서). 같은 (user_id, event_id) 행이 둘이 될 수 없다는 규칙을 DB가 지켜, 앱 코드의 순서와 상관없이 막는다. 대신 앱이 1062를 "이미 받음"으로 처리해야 하고, 잔액 갱신은 같은 트랜잭션에 묶어 함께 되돌려야 한다.

**근거:** [문제 상황 3][problem3], [묶음 ②·③ 결과][burst]

### 04-027

**앞면:** `points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)`에 (7, 0, 0)이 있고, `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))`는 비어 있다. REPEATABLE READ에서 user 7의 같은 리워드 요청 10건이 동시에 오고, 막지 않은 요청은 `START TRANSACTION;` → `SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;`(0이 아니면 `ROLLBACK`, 이미 받음) → 50ms → `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7;` → `COMMIT;`이다(10건 모두 지급해 10행, 10000). 중복 지급을 막은 세 방법의 맥 측정 결과(세 번의 최솟값~최댓값)는 아래와 같다. 세 방법은 각각 무엇을 대가로 막고, 언제 무엇을 고르는가?

| 방법 | 바꾼 것 | 결과 | 다시 시도 | 요청 시간 중앙값 / 최대 |
|---|---|---|---:|---|
| 비관적 락 | 첫 문장으로 `SELECT balance FROM points WHERE user_id = 7 FOR UPDATE` | 1행, 1000, 오류 없음 | 0 | 65~70 / 72~78ms |
| 낙관적 락 | 처음에 version을 읽어 두고(v), `INSERT` 뒤 `UPDATE points SET version = version + 1 WHERE user_id = 7 AND version = v`, 0행이면 `ROLLBACK` 뒤 처음부터(최대 3번) | 1행, 1000, 오류 없음 | 9 | 63~69 / 66~74ms |
| 유니크 제약 | 표를 `UNIQUE KEY idx_user_event (user_id, event_id)`로, `INSERT`가 1062면 `ROLLBACK` | 1행, 1000, 1062 ×9(앱이 처리) | 0 | 59~73 / 61~73ms |

**뒷면:** 비관적 락은 오류와 다시 시도 없이 같은 사용자의 요청을 한 줄로 세우고, 그 대가는 락을 기다리는 시간이다. 여기서는 뒤의 9건이 COUNT 1을 보고 바로 끝나 약 1.5ms 간격이었지만, 락을 쥔 채 50ms 일을 하는 요청이 10건이면(`FOR UPDATE`를 COUNT 다음에 둔 판, 10건 모두 지급) 약 62~63ms 간격으로 쌓여 마지막이 621~626ms에 끝났다. 잠그는 문장은 트랜잭션의 첫 문장이어야 한다. 낙관적 락은 읽을 때 잠그지 않고, 충돌하면 해 둔 일(`INSERT`)을 되돌리고 다시 하는 것이 대가다(9건이 한 번씩 다시 함). 충돌이 잦을수록 버리는 일과 다시 시도가 는다. 유니크 제약은 앱 코드의 순서와 상관없이 DB가 같은 키의 두 번째 행을 막고, 앱이 1062를 "이미 받음"으로 처리해야 한다. 키로 적을 수 있는 규칙(사용자·이벤트마다 한 행)만 지킨다. 충돌이 잦으면 비관적 락, 드물면 낙관적 락이 낫고, 중복이 생기면 안 되는 키에는 어느 쪽이든 유니크 제약을 마지막 방어선으로 함께 둔다. 다만 잘못 건 락은 유니크 제약이 고치지 못한다(`COUNT ... FOR UPDATE`에 `UNIQUE KEY`를 더해도 1213 9건). 이 선택 기준은 에이전트 정리이고, 학습 확인 뒤 다시 정한다.

**근거:** [묶음 ②·③ 결과][burst]

## 커넥션 풀

### 04-028

**앞면:** 웹 서버가 SQLAlchemy `QueuePool`(`max_overflow=0`, 연결은 미리 다 만듦)로 MySQL에 붙어 있다. 요청 50개가 같은 순간에 오고, 요청마다 풀에서 연결을 빌려 트랜잭션 안에서 `SELECT 1` 뒤 200ms를 쓰고 커밋한 뒤 돌려준다. `pool_size`가 5, 10, 50일 때 50건이 다 끝나는 시간과, 가장 오래 기다린 요청이 연결을 받기까지 기다린 시간은?

**뒷면:** 풀 5는 2.09~2.10초와 1.88~1.89초, 풀 10은 1.07초와 0.86초, 풀 50은 0.22초와 0.04ms 이하였다. 다 끝나는 시간은 대략 (요청 수 ÷ 풀 크기) × 트랜잭션 시간이다. 풀 5는 다섯 건씩 10차례로 나뉘어, 마지막 차례가 앞 9차례를 기다린다. 계산(2초, 1.8초)보다 5~7% 긴 것은 한 차례가 0.2초가 아니라 약 0.216초였기 때문이다.

**근거:** [문제 상황 4][problem4], [묶음 ④ 결과][batch4]

### 04-029

**앞면:** SQLAlchemy `QueuePool`(`pool_size=5`, `max_overflow=0`, 연결은 미리 다 만듦)에 요청 50개가 같은 순간에 오고, 요청마다 트랜잭션 안에서 200ms를 쓴다. `pool_timeout`이 0.5초면 몇 건이 성공하고 몇 건이 실패하는가? 왜?

**뒷면:** 15건 성공, 35건 타임아웃이었다. 다섯 건씩 약 0.2초마다 연결을 받아 세 차례(15건)가 0.5초 안에 연결을 받았고, 나머지 35건은 기다리기 시작하고 0.504~0.512초 뒤 타임아웃했다. 풀은 넘치는 요청을 바로 거절하지 않고 줄을 세웠다가, 정한 시간을 넘으면 실패로 돌려준다.

**근거:** [문제 상황 4][problem4], [묶음 ④ 결과][batch4]

### 04-030

**앞면:** 한 건씩 차례로 할 때, 요청마다 MySQL에 새로 연결해 `SELECT 1`을 하는 시간과 미리 연 풀에서 연결을 빌려 `SELECT 1`을 하는 시간은 얼마나 다른가? 새 연결은 무엇에 시간을 쓰는가?

**뒷면:** 맥에서 새로 연결하기는 중앙값 9.25~9.63ms, 풀에서 빌리기는 0.31~0.32ms로 약 30배였다(컨테이너 임시 확인은 6.3ms와 0.09ms로 약 70배). 새 연결은 매번 TCP 연결, MySQL 인증 주고받기(handshake), 서버의 세션 준비를 거치고, 풀은 이미 열린 연결을 넘겨받는다. 배수는 환경에 따라 달랐고, 이 맥에서 풀이 요청마다 줄이는 시간은 약 9ms다.

**근거:** [문제 상황 4][problem4], [묶음 ④ 결과][batch4], [참고: 컨테이너와 맥][container-vs-mac]

### 04-031

**앞면:** 요청 50개가 같은 순간에 오고, 요청마다 트랜잭션 안에서 200ms를 쓴다. 미리 연 연결 5개짜리 풀(SQLAlchemy `QueuePool`, `pool_size=5`, `max_overflow=0`)과, 풀 없이 요청마다 새로 연결하고 끝나면 끊는 `NullPool` 중 어느 쪽이 먼저 끝나는가? 한 건씩 잴 때 새로 연결하기는 풀에서 빌리기보다 약 30배 느렸는데 왜 그런가?

**뒷면:** `NullPool`이 0.29~0.32초로, 풀 5(2.09~2.10초)보다 먼저 끝났다. 50건이 연결을 하나씩 따로 얻어 200ms를 함께 썼기 때문이다. 30배는 연결을 얻는 몫에만 걸리고, 그 차이(약 9ms)는 요청마다 연결을 쥐는 200ms와 풀 5에서 줄 선 시간(최대 1.88~1.89초)보다 훨씬 작다. 50건이 한꺼번에 연결하느라 연결 얻기는 한 건씩일 때보다 느린 중앙값 61~70ms였고, 서버의 동시 연결은 51개(관찰용 연결 포함)까지 올라갔다.

**근거:** [묶음 ④ 결과][batch4], [첫 해석][interpretation-pool]

### 04-032

**앞면:** 요청 50개가 동시에 오고 요청마다 트랜잭션 안에서 200ms를 쓸 때, 풀 없이 요청마다 새로 연결한 쪽(0.29~0.32초)이 풀 5(2.09~2.10초)보다 빨랐다. 그런데도 커넥션 풀을 쓰는 이유를 잰 숫자로 말하라. MySQL의 `max_connections`는 151, 한 건씩 잴 때 새로 연결하기는 9.25~9.63ms, 풀에서 빌리기는 0.31~0.32ms였다.

**뒷면:** 첫째, DB가 받는 연결 수에는 한도가 있다. `max_connections`가 151이면 풀 없이 동시 요청이 약 150건을 넘을 때 넘는 요청은 기다리지 않고 바로 1040(Too many connections)을 받는다(재지는 않음, MySQL은 `CONNECTION_ADMIN` 권한 계정용으로 1개를 더 받음). 풀은 연결 수를 풀 크기로 묶고 넘치는 요청을 `pool_timeout`까지 줄 세운다(풀 5·0.5초에서 35건 타임아웃). 둘째, 요청마다 새 연결 비용 약 9ms를 없앤다. 트랜잭션이 200ms면 약 5%지만, 쿼리가 짧을수록 이 9ms가 요청 시간의 대부분이 된다.

**근거:** [첫 해석][interpretation-pool], [묶음 ④ 결과][batch4], [Too many connections][too-many-connections]

### 04-033

**앞면:** 커넥션 풀 크기는 어떻게 정하는가? 요청마다 트랜잭션 안에서 외부 API 응답을 200ms 기다리는 서비스에서, 풀을 키우는 것 말고 연결 기다림을 줄이는 방법은?

**뒷면:** 다 끝나는 시간은 대략 (요청 수 ÷ 풀 크기) × 연결을 쥐는 시간이라 풀을 키우면 빨라지지만, DB가 쥐는 연결도 는다. 앱 서버가 여러 대면 서버마다의 풀 크기 합이 `max_connections` 안에 들어야 한다. 연결을 쥐는 시간을 줄이는 것이 더 직접적이다. 외부 API 호출을 트랜잭션 밖으로 빼서 연결을 200ms씩 쥐지 않으면 같은 풀 5로도 50건이 훨씬 빨리 끝난다(쥐는 시간이 20ms면 계산상 약 0.2초, 재지는 않음).

**근거:** [문제 상황 4의 피드백][problem4]

[before]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#시작-전-기록
[interpretation]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#첫-해석
[interpretation-pool]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#묶음--30배-비싼-새-연결이-먼저-끝낸-50건
[interpretation-deadlocks]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#묶음--두-데드락의-같은-점과-다른-점
[problem1]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#문제-상황-1-잠근-응모-사이로-들어오는-새-응모-2026-11-03
[problem1-1]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#문제-상황-1-1-인덱스가-없을-때-2026-11-03
[problem1-2]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#문제-상황-1-2-실험-3에서-미뤄-둔-174초-2026-11-03
[problem2]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#문제-상황-2-서로-반대로-보낸-두-이체-2026-11-03
[problem2-1]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#문제-상황-2-1-동시에-몰린-포인트-차감-10건-2026-11-03
[problem3]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#문제-상황-3-동시에-들어온-같은-리워드-지급-10건-2026-11-03
[problem4]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#문제-상황-4-커넥션-풀보다-많이-몰린-요청-2026-11-04
[batch1]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#묶음--잠근-범위-사이의-삽입과-삭제-조건마다-3회
[batch2]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#묶음--반대로-보낸-두-이체와-락-순서-조건마다-3회
[burst]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#묶음--같은-요청-10건-판마다-3회
[batch4]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#묶음--커넥션-풀-경우마다-3회
[container-vs-mac]: ../experiments/04-mysql-locks-deadlocks-pool/README.md#참고-컨테이너-임시-확인-값과-맥-본-측정
[innodb-locking]: https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html
[locks-set]: https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html
[mysql-iso]: https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html
[data-locks]: https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html
[error-handling]: https://dev.mysql.com/doc/refman/8.4/en/innodb-error-handling.html
[deadlock-detection]: https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlock-detection.html
[deadlocks-handling]: https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html
[too-many-connections]: https://dev.mysql.com/doc/refman/8.4/en/too-many-connections.html
