# 03 MySQL 격리 수준과 MVCC — 복습 카드

2026-10-27~28의 실험과 문답을 바탕으로 만든 카드 38개다. MySQL은 8.4.13(InnoDB), PostgreSQL은 18.6을 기준으로 하고, 측정값은 2026-10-28 맥 본 측정(Docker Desktop)에서 잰 값이다. 각 카드의 앞면·뒷면을 나중에 Anki로 옮긴다.

뒷면은 에이전트가 정리한 복습용 답이며, 사람의 독립적인 답변 기록이 아니다. 사람의 실제 예상과 해석은 [실험 README의 시작 전 기록][before]과 [첫 해석][interpretation]에 남겼다. 완료 후 학습 확인은 이 카드를 만든 뒤에 하므로, 학습 확인에서 고친 결론이 생기면 카드를 더하거나 고친다.

우선 복습할 카드는 **03-008, 03-010, 03-018, 03-023, 03-026, 03-036**이다. 스냅숏을 만드는 때, 잠금 읽기가 최신 행을 읽는 이유, 갱신 손실, 이전 버전을 지우지 못하는 이유, 오래된 스냅숏의 읽기 비용, 커밋마다 남는 fsync를 다룬다.

## 트랜잭션과 격리 수준

### 03-001

**앞면:** 트랜잭션에서 `COMMIT`과 `ROLLBACK`은 각각 무엇을 확정하고 무엇을 되돌리는가? MyISAM 표가 섞이면 무엇이 달라지는가?

**뒷면:** `COMMIT`은 트랜잭션의 변경을 확정해 다른 트랜잭션에 보이게 하고 장애 뒤에도 남게 한다. `ROLLBACK`은 그 트랜잭션의 변경을 모두 되돌린다. InnoDB는 고치기 전 값을 undo log에 남겨 두어 되돌릴 수 있다. MyISAM처럼 트랜잭션을 지원하지 않는 storage engine의 표는 문장이 끝나는 순간 반영되고, `ROLLBACK`이 되돌리지 못한다. 실험에서 `ROLLBACK`은 오류 없이 끝났고 경고 1196만 남겼다.

**근거:** [문제 상황 5][problem5], [COMMIT과 ROLLBACK 문서][commit-doc]

### 03-002

**앞면:** ACID의 네 성질(원자성, 일관성, 격리성, 지속성)을 이번 실험에서 무엇이 지켰는지, 또는 어디서 깨졌는지로 말하라.

**뒷면:** 원자성은 `ROLLBACK`이 전부 되돌리는 것이다. InnoDB 표는 그랬고, 같은 트랜잭션의 MyISAM 표는 되돌려지지 않아 주문 없이 주문 기록만 남았다(문제 상황 5). 격리성은 동시에 도는 트랜잭션이 서로의 변경을 얼마나 보는지로, 격리 수준과 MVCC·락이 정한다(묶음 1·2). 지속성은 커밋한 변경이 장애 뒤에도 남는 것으로, 커밋할 때 redo log나 WAL을 디스크에 내리는(fsync) 설정이 정한다(묶음 4). 일관성(제약 조건)은 이번에 재지 않았고 04 실험에서 다룬다.

**근거:** [목표][goal], [문제 상황 5][problem5], [문제 상황 6][problem6]

### 03-003

**앞면:** dirty read, non-repeatable read, phantom read는 각각 무엇인가?

**뒷면:** dirty read는 다른 트랜잭션이 커밋하기 전의 값을 읽는 것이다. non-repeatable read는 같은 행을 다시 읽는 사이 다른 트랜잭션이 그 행을 고치고 커밋해 값이 달라지는 것이다. phantom read는 같은 조건으로 다시 읽는 사이 다른 트랜잭션이 조건에 맞는 행을 넣거나 지우고 커밋해 행 집합이 달라지는 것이다.

**근거:** [문제 상황 1의 기초 설명][problem1]

### 03-004

**앞면:** SQL 표준의 격리 수준 네 단계는 세 이상현상 중 무엇을 막는가? 실제 DB가 표와 다르게 동작할 수 있는 이유는?

**뒷면:** READ UNCOMMITTED는 아무것도 막지 않고, READ COMMITTED는 dirty read, REPEATABLE READ는 dirty·non-repeatable read, SERIALIZABLE은 셋 다 막는다. 표준은 단계마다 최소한 막을 것만 정하므로 실제 DB는 더 막기도 한다. 예를 들어 PostgreSQL의 READ UNCOMMITTED는 READ COMMITTED처럼 동작해 dirty read가 없고(실험에서 1000을 읽음), InnoDB의 REPEATABLE READ는 평범한 `SELECT`에서 팬텀이 보이지 않았다. 기본 격리 수준은 MySQL InnoDB가 REPEATABLE READ, PostgreSQL이 READ COMMITTED다.

**근거:** [문제 상황 1의 기초 설명][problem1], [문제 상황 2][problem2], [PostgreSQL Transaction Isolation][pg-iso]

### 03-005

**앞면:** 리포트(A)가 트랜잭션 안에서 잔액을 세 번 읽는 사이 결제(B)가 1000을 700으로 고치고 커밋한다. A의 둘째 읽기는 B가 커밋하기 전, 셋째는 뒤다. MySQL에서 격리 수준 네 단계별로 둘째·셋째 값과 기다림은?

**뒷면:** READ UNCOMMITTED는 700, 700(둘째가 dirty read). READ COMMITTED는 1000, 700(셋째가 non-repeatable read). REPEATABLE READ는 1000, 1000. SERIALIZABLE도 1000, 1000인데, B의 `UPDATE`가 A의 `COMMIT`까지 1.74초 기다렸고 B의 `COMMIT`은 그 뒤에 나갔다. SERIALIZABLE에서는 평범한 `SELECT`가 공유 락을 거는 읽기가 되어, 배타 락이 필요한 B가 기다린다. 결과는 A가 다 끝난 뒤 B가 돈 것과 같다.

**근거:** [문제 상황 2][problem2], [묶음 1·3 결과][batch13], [Transaction Isolation Levels][mysql-iso]

### 03-006

**앞면:** 세션 하나의 격리 수준은 MySQL과 PostgreSQL에서 각각 어떻게 바꾸는가? 실험은 어떤 범위로 걸었는가?

**뒷면:** MySQL은 `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`처럼, PostgreSQL은 `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED`처럼 세션의 기본값을 바꾼다. 그 뒤 그 연결에서 여는 트랜잭션에 적용된다. 실험은 조건마다 두 세션에 같은 격리 수준을 걸었다.

**근거:** [순서표 실행 규칙][timeline-rules]

## 스냅숏

### 03-007

**앞면:** MVCC의 스냅숏(MySQL에서는 read view)은 무엇을 담는가? 트랜잭션마다 만들면 DB 크기만큼 메모리를 쓰는가?

**뒷면:** DB를 복사한 것이 아니다. "이 시점에 커밋을 마친 트랜잭션의 변경만 보인다"를 판정하는 트랜잭션 ID 몇 개와, 만들 때 진행 중이던 트랜잭션 ID 목록이다(InnoDB `m_low_limit_id`, `m_up_limit_id`, `m_ids`, PostgreSQL `xmax`, `xmin`, `xip`). 크기는 DB 용량이 아니라 그때 진행 중이던 트랜잭션 수에 따라 달라진다. 비용이 되는 것은 개수가 아니라 오래 남아 있는 스냅숏이다. 그동안 이전 버전을 지우지 못한다.

**근거:** [문제 상황 4 변형의 스냅숏 크기 문답][problem4-variant], [PostgreSQL System Information Functions][pg-snapshot]

### 03-008

**앞면:** MySQL 기본 설정(REPEATABLE READ)에서 A가 트랜잭션 안에서 `user_id = 7`의 응모 수를 세어 2를 얻은 뒤, B가 응모 한 줄을 넣고 커밋했다. A가 같은 조건을 `FOR UPDATE`로 세면 3, 다시 평범한 `SELECT`로 세면 2다. 왜 그런가?

**뒷면:** 평범한 `SELECT`는 consistent read로, 트랜잭션의 첫 consistent read에서 만든 스냅숏을 다시 읽는다. 그 스냅숏에는 B의 행이 없어 2다. `FOR UPDATE`는 잠금 읽기라 스냅숏이 아니라 지금 커밋된 최신 행을 읽는다. 잠글 수 있는 것은 지금 실제로 있는 행이기 때문이다. 그래서 3이 나오고, 그 뒤 평범한 `SELECT`는 다시 스냅숏을 읽어 2가 된다. 값이 바뀌었다 되돌아온 것이 아니라 두 읽기가 다른 것을 본다.

**근거:** [문제 상황 1][problem1], [문제 상황 1-1][problem1-1], [Locking Reads][locking-reads]

### 03-009

**앞면:** "REPEATABLE READ는 같은 조건의 조회 결과를 캐시해 두었다가 돌려준다"는 가설을 실험은 어떻게 가렸는가?

**뒷면:** A가 `user_id = 7`을 센 뒤 B가 한 줄을 넣고 커밋하고, A가 처음 쓰는 조건(표 전체 개수)으로 셌다. 캐시라면 처음 쓰는 조건은 지금 모습(4)을 읽어야 하는데 두 DB 모두 3이 나왔다. 스냅숏은 조건마다 담는 결과가 아니라 DB 전체의 한 시점 모습이어서, 조건이 달라도 같은 시점을 읽는다. READ COMMITTED는 문장마다 새 스냅숏을 만들어 4였다.

**근거:** [문제 상황 1-1][problem1-1]

### 03-010

**앞면:** REPEATABLE READ에서 스냅숏은 언제 만들어지는가? A가 `START TRANSACTION`만 하고 아무것도 읽지 않았을 때 B가 행을 넣고 커밋하면, A의 첫 `SELECT`에 B의 행이 보이는가?

**뒷면:** 보인다(두 DB 모두 3). `START TRANSACTION`은 트랜잭션을 열 뿐 스냅숏을 만들지 않는다. MySQL은 트랜잭션의 첫 consistent read, PostgreSQL은 트랜잭션 제어문이 아닌 첫 문장에서 만들고, `COMMIT`이나 `ROLLBACK`까지 다시 쓴다. MySQL에서 열 때 바로 만들려면 `START TRANSACTION WITH CONSISTENT SNAPSHOT`을 쓰고, 그러면 2가 나왔다. 트랜잭션이 열려 있는 것과 스냅숏이 있는 것은 다르다.

**근거:** [문제 상황 1-2][problem1-2], [Consistent Nonlocking Reads][consistent-read], [PostgreSQL Transaction Isolation][pg-iso]

### 03-011

**앞면:** REPEATABLE READ에서 A가 트랜잭션을 열고 먼저 다른 표를 `UPDATE`한 뒤, B가 응모 한 줄을 넣고 커밋했다. 그다음 A가 응모 수를 세면 MySQL과 PostgreSQL에서 각각 몇인가(처음 2줄)?

**뒷면:** MySQL 3, PostgreSQL 2. MySQL은 첫 consistent read에서 스냅숏을 만들고 `UPDATE`는 consistent read가 아니므로, 스냅숏이 B가 커밋한 뒤의 `SELECT`에서 만들어진다. PostgreSQL은 트랜잭션 제어문이 아닌 첫 문장인 `UPDATE`가 시작할 때 스냅숏을 만들어 B의 행이 보이지 않는다. 같은 REPEATABLE READ라도 스냅숏을 만드는 때가 DB마다 다르다.

**근거:** [문제 상황 1-2 변형][problem1-2-variant], [Consistent Nonlocking Reads][consistent-read]

### 03-012

**앞면:** READ COMMITTED에서 스냅숏은 언제 만들어지고 언제 버려지는가? 응모 수를 2로 센 뒤 B가 한 줄을 넣고 커밋했을 때, 같은 트랜잭션의 `FOR UPDATE` 세기와 평범한 다시 세기는 몇인가?

**뒷면:** 평범한 `SELECT` 한 문장마다 새로 만들고 그 문장이 끝나면 버린다(PostgreSQL은 문장마다). 그래서 B가 커밋한 뒤의 읽기는 모두 B의 행을 본다. `FOR UPDATE` 세기도 3, 평범한 다시 세기도 3이다(실험에서 2, 3, 3).

**근거:** [문제 상황 1-1][problem1-1], [문제 상황 4 변형의 스냅숏 생애주기 표][problem4-variant]

### 03-013

**앞면:** InnoDB의 consistent read는 행 하나를 읽을 때 스냅숏(read view)으로 무엇을 따지고, 보이지 않으면 어떻게 하는가?

**뒷면:** 행 버전마다 그 버전을 쓴 트랜잭션의 ID(숨은 열 `DB_TRX_ID`)가 붙어 있다. 그 ID가 read view 기준으로 보이는지 따진다. 자기 것이거나 가장 작은 진행 중 ID보다 작으면 보이고, 만들 때의 다음 ID 이상이면 안 보이고, 그 사이면 만들 때 진행 중이던 목록에 없을 때만 보인다(`ReadView::changes_visible`). 안 보이면 roll pointer(`DB_ROLL_PTR`)를 따라 undo log로 이전 버전을 다시 만들어 같은 판정을 하고, 그 시점에 없던 행은 건너뛴다. PostgreSQL은 튜플의 xmin·xmax를 스냅숏과 비교하고, 이전 버전이 표 안에 있어 다시 만들 필요가 없다.

**근거:** [문제 상황 1-2의 용어 설명][problem1-2], [문제 상황 4 변형의 스냅숏 크기 문답][problem4-variant], [InnoDB Multi-Versioning][multi-versioning]

## 잠금 읽기와 쓰기

### 03-014

**앞면:** 공유 락(S)과 배타 락(X)은 각각 무엇을 허락하고 무엇과 충돌하는가? 평범한 `SELECT`는 어느 락을 거는가?

**뒷면:** 공유 락은 그 행을 읽게 하고 여러 트랜잭션이 함께 걸 수 있지만, 걸려 있는 동안 다른 트랜잭션은 배타 락을 바로 얻지 못한다(`SELECT ... FOR SHARE`). 배타 락은 그 행을 고치거나 지우게 하고, 걸려 있는 동안 다른 트랜잭션은 어느 락도 바로 얻지 못한다(`FOR UPDATE`, `UPDATE`, `DELETE`). 둘 다 트랜잭션이 끝날 때까지 쥔다. 평범한 `SELECT`는 락을 걸지도 기다리지도 않고 스냅숏을 읽는다(MySQL SERIALIZABLE에서는 예외로 공유 락을 건다). PostgreSQL에도 같은 개념이 있고 행 락이 네 가지로 나뉜다.

**근거:** [문제 상황 1-3의 용어 설명][problem1-3], [InnoDB Locking][innodb-locking], [PostgreSQL Explicit Locking][pg-locking]

### 03-015

**앞면:** REPEATABLE READ에서 A가 `user_id = 7`의 행(1, 2)을 읽은 뒤 B가 id 4를 넣고 커밋했다. A가 같은 조건을 `FOR UPDATE`로 읽고, 다시 평범하게 읽는다. MySQL과 PostgreSQL의 결과는? InnoDB REPEATABLE READ에서 팬텀이 보이는가?

**뒷면:** MySQL은 1,2,4 → 1,2, PostgreSQL은 1,2 → 1,2다. 두 DB 모두 `FOR UPDATE`로 행을 잠그지만 잠글 행을 찾는 기준이 다르다. MySQL의 잠금 읽기는 지금 커밋된 최신 행을 찾아 4까지 잠그고, PostgreSQL REPEATABLE READ는 스냅숏 기준으로 대상 행을 찾는다. 그래서 InnoDB REPEATABLE READ에서 팬텀은 평범한 `SELECT`에서는 보이지 않고 잠금 읽기에서는 보인다.

**근거:** [문제 상황 1-3][problem1-3], [PostgreSQL Transaction Isolation][pg-iso]

### 03-016

**앞면:** MySQL SERIALIZABLE에서 A가 `user_id = 7`의 행을 평범하게 읽은 뒤, B가 A가 읽지 않은 새 행(id 4)을 넣으려 한다. B는 어떻게 되는가? 같은 순서표의 PostgreSQL SERIALIZABLE은?

**뒷면:** MySQL은 B의 `INSERT`가 A의 `COMMIT`까지 1.74초 기다렸다. SERIALIZABLE에서는 평범한 `SELECT`가 공유 락을 거는 읽기가 되고(autocommit이 꺼진 트랜잭션 안), 그 락이 행 사이 범위(gap)까지 잠가 새 행을 넣지 못하게 한다. 범위 락의 자세한 규칙은 04 실험에서 다룬다. PostgreSQL SERIALIZABLE은 락으로 막지 않고 REPEATABLE READ와 같은 스냅숏으로 읽으며 직렬 실행으로 설명할 수 없는 조합만 감시하므로, B는 기다리지 않았고 오류도 없었다.

**근거:** [문제 상황 1-3][problem1-3], [문제 상황 2][problem2], [Transaction Isolation Levels][mysql-iso]

### 03-017

**앞면:** SERIALIZABLE은 무엇을 보장하는 수준인가? MySQL과 PostgreSQL은 각각 어떤 방법으로 지키는가?

**뒷면:** 동시에 돈 트랜잭션들의 결과가 하나씩 차례로(serially) 돈 결과와 같도록 보장한다. MySQL은 락으로 지킨다. 평범한 `SELECT`도 공유 락을 걸어 충돌하는 쓰기를 기다리게 한다. PostgreSQL은 REPEATABLE READ와 같은 스냅숏으로 읽고, 차례로 돈 결과로 설명할 수 없는 조합이 생기면 한쪽을 직렬화 실패(오류 40001)로 되돌린다. REPEATABLE READ보다 더 기다리게 하지는 않는다.

**근거:** [문제 상황 2][problem2], [PostgreSQL Transaction Isolation][pg-iso]

### 03-018

**앞면:** 잔액 1000을 A(300 차감)와 B(500 차감)가 각각 읽고, 앱에서 계산한 700과 500으로 `UPDATE`한 뒤 커밋한다. A의 `UPDATE`와 `COMMIT`이 B의 `UPDATE`보다 먼저 보내졌다. MySQL READ COMMITTED·REPEATABLE READ에서 무슨 일이 생기는가?

**뒷면:** B의 `UPDATE`는 A가 그 행에 쥔 배타 락 때문에 A의 `COMMIT`까지 기다린다(0.81~0.82초). 풀리면 B가 그대로 500으로 덮어써 최종 잔액이 500이다. A의 300 차감이 사라지는 갱신 손실(lost update)이다. MySQL의 `UPDATE`는 스냅숏이 아니라 최신 행을 고치므로, B가 읽은 뒤 누가 바꿨는지 따지지 않는다. 둘 다 반영된 200은 어느 조건에서도 나오지 않았다.

**근거:** [문제 상황 3][problem3], [묶음 1·3 결과][batch13]

### 03-019

**앞면:** 같은 차감 순서표를 PostgreSQL에서 돌리면 READ COMMITTED와 REPEATABLE READ의 결과가 어떻게 다른가?

**뒷면:** 둘 다 B의 `UPDATE`가 A의 `COMMIT`까지 기다린다. READ COMMITTED는 풀린 뒤 최신 버전으로 조건을 다시 확인하고 500으로 고쳐 갱신 손실이 난다(최종 500). REPEATABLE READ(와 SERIALIZABLE)는 B의 스냅숏 뒤에 다른 트랜잭션이 고쳐 커밋한 행이라 B를 오류 40001("could not serialize access due to concurrent update")로 끝내고, B의 `COMMIT`은 `ROLLBACK`으로 끝난다. 최종 700이다. B가 처음부터 다시 하면 700을 읽고 200을 만들 수 있다.

**근거:** [문제 상황 3][problem3], [PostgreSQL Transaction Isolation][pg-iso]

### 03-020

**앞면:** MySQL SERIALIZABLE에서 차감 순서표(둘 다 읽은 뒤 각자 `UPDATE`)를 돌리면 어떻게 되는가?

**뒷면:** 두 평범한 `SELECT`가 모두 공유 락을 걸어 A와 B가 같은 행에 공유 락을 쥔다. A의 `UPDATE`는 B의 공유 락이 풀리기를 기다리고, 이어 B의 `UPDATE`가 A의 공유 락을 기다리면서 서로 기다리는 고리가 된다. InnoDB가 데드락을 알아채 B를 오류 1213으로 되돌렸고, A의 `UPDATE`가 이어서 끝나 최종 700이었다. 갱신 손실은 막았지만 한쪽이 실패해 다시 해야 한다.

**근거:** [문제 상황 3][problem3], [묶음 1·3 결과][batch13]

### 03-021

**앞면:** `UPDATE`, `DELETE`, `FOR UPDATE`가 고치거나 잠글 행을 찾는 기준은 MySQL과 PostgreSQL(READ COMMITTED, REPEATABLE READ)에서 각각 무엇인가?

**뒷면:** MySQL은 스냅숏을 만들지도 쓰지도 않고 지금 커밋된 최신 행을 잠가 고친다. PostgreSQL은 스냅숏으로 대상 행을 찾는다. 그 행을 다른 트랜잭션이 고치는 중이면 끝날 때까지 기다리고, 커밋되면 READ COMMITTED는 최신 버전으로 다시 확인해 진행하고, REPEATABLE READ는 오류 40001로 끝낸다.

**근거:** [문제 상황 4 변형의 스냅숏 생애주기 표][problem4-variant], [문제 상황 3][problem3]

## 이전 버전과 정리

### 03-022

**앞면:** 행을 고친 뒤 고치기 전 버전은 InnoDB와 PostgreSQL에서 각각 어디에 남는가? 필요 없어진 버전은 누가 지우는가?

**뒷면:** InnoDB는 표(클러스터드 인덱스)에 최신 버전만 두고, 고치기 전 값을 undo log 레코드에 남겨 행의 roll pointer가 가리킨다. 필요 없어진 undo log는 purge 스레드가 백그라운드에서 주기적으로 지운다. PostgreSQL은 `UPDATE`가 표 안에 새 튜플을 쓰고, 이전 튜플(dead tuple)도 표에 남는다. 이를 VACUUM(보통 autovacuum)이 표 전체에서, HOT pruning이 페이지 하나 안에서 평소 문장이 지운다.

**근거:** [문제 상황 4의 용어 설명][problem4], [InnoDB Multi-Versioning][multi-versioning], [PostgreSQL Routine Vacuuming][pg-vacuum]

### 03-023

**앞면:** A가 REPEATABLE READ 트랜잭션에서 `visits` 표만 읽고 커밋하지 않은 채, B가 `accounts`의 한 행을 1만 번 고쳤다(자동 커밋). A는 `accounts`를 한 번도 읽지 않았다. 이전 버전은 얼마나 남고, 그 뒤 A가 `accounts`를 처음 읽으면 무슨 값을 받는가?

**뒷면:** 거의 다 남는다. MySQL History list length 10002, PostgreSQL dead but not yet removable 10000이었다. A는 B가 고치기 전 값 1000을 읽었다. 스냅숏은 행이나 표 하나가 아니라 DB 전체의 한 시점 모습이고, DB는 A가 다음에 어느 표를 읽을지 모른다. 그래서 그 버전이 필요할 수 있는 스냅숏이 있으면 지우지 못한다. 원인은 "그 행을 읽었는지"가 아니라 "스냅숏이 있는지"다. 락이 없어 B가 기다리지 않는 것과 이전 버전을 지울 수 있는 것은 별개다.

**근거:** [문제 상황 4 변형][problem4-variant], [묶음 2 결과][batch2]

### 03-024

**앞면:** B가 한 행을 1만 번 고치는 동안 A가 해 둔 일만 다르다: (가) 트랜잭션 없음, (나) REPEATABLE READ로 그 행을 읽고 둠, (다) READ COMMITTED로 읽고 둠, (라) REPEATABLE READ로 열기만 함, (마) REPEATABLE READ로 다른 표를 `UPDATE`함. B가 끝난 직후 이전 버전이 1만 근처로 남는 경우는(MySQL, PostgreSQL)?

**뒷면:** (나)는 두 DB 모두, (마)는 PostgreSQL만 1만 근처였다(MySQL History list length 10002, PostgreSQL 10000). 나머지는 MySQL 수십~300여 개, PostgreSQL 0이었다. B가 고치는 동안 A에게 스냅숏이 있었는지로 갈린다. (다)는 문장이 끝나면 스냅숏을 버리고, (라)는 아직 만들지 않았고, (마)는 MySQL `UPDATE`가 스냅숏을 만들지 않지만 PostgreSQL은 첫 문장에서 만든다.

**근거:** [문제 상황 4][problem4], [묶음 2 결과][batch2]

### 03-025

**앞면:** PostgreSQL에서 이 표의 자동 VACUUM을 꺼 두었는데, 열린 스냅숏 없이 B가 한 행을 1만 번 고친 뒤 dead tuple이 0이고 표 크기도 8,192바이트 그대로였다. 무엇이 지웠는가?

**뒷면:** HOT pruning이다. 인덱스에 걸린 열을 바꾸지 않는 `UPDATE`는 같은 페이지에 자리가 있으면 새 버전을 그 페이지에 쓰고 인덱스 항목을 새로 만들지 않는다(HOT, heap-only tuple). 그렇게 이어진 버전 중 이제 아무도 볼 수 없는 것을 그 페이지를 읽거나 고치는 평소 문장이 그 자리에서 지운다. 열린 스냅숏이 그 버전을 볼 수 있으면 HOT pruning도 지우지 못한다((나)에서 10000이 남음).

**근거:** [문제 상황 4][problem4], [문제 상황 4 변형][problem4-variant], [Heap-Only Tuples][pg-hot]

### 03-026

**앞면:** A가 REPEATABLE READ로 한 행을 읽어 스냅숏을 만든 채 두고 B가 그 행을 1만 번 고쳤다. 그 뒤 A와 새 세션 C가 그 행을 읽는 시간은 A가 없을 때와 비교해 MySQL과 PostgreSQL에서 어떻게 달라졌는가? 왜 그런가?

**뒷면:** MySQL은 A만 9.3배 느렸고(약 0.3ms → 2.9ms) C는 그대로였다(0.89배). 표에는 최신 버전만 있고 A의 read view에는 보이지 않으므로, roll pointer를 따라 undo log로 한 단계씩 1만 번 되짚어야 1000에 닿는다. C는 최신 버전이 바로 보인다. PostgreSQL은 A 1.33배, C 1.62배로 둘 다 조금 느렸다. 1만 개를 지우지 못해 표에 남아 있어, 읽는 쪽 모두 보이지 않는 버전의 xmin·xmax를 확인하며 지나간다. 다시 만드는 일 없이 비교만 한다.

**근거:** [문제 상황 4-1][problem4-1], [묶음 2 결과][batch2], [Undo Logs][undo-logs]

### 03-027

**앞면:** 같은 상황(오래 열린 스냅숏이 있는 동안 B가 한 행을 1만 번 고침)에서 B의 `UPDATE` 한 번의 시간은 뒤로 갈수록 늘어나는가? MySQL과 PostgreSQL 각각.

**뒷면:** MySQL은 평평했다(구간 5 / 구간 1이 1.03~1.09배). `UPDATE`는 최신 버전을 바로 고치고 undo log 레코드 하나를 쓸 뿐이고, purge가 밀려도 `innodb_max_purge_lag` 기본값 0에서는 쓰기를 늦추지 않는다. PostgreSQL은 세 번 중 두 번 늘었다(1.36, 1.13, 1.34배). 고칠 행의 최신 버전을 찾아 사슬을 따라가야 하는데, 지우지 못한 버전이 고칠수록 1만 개까지 쌓이기 때문이다.

**근거:** [문제 상황 4-2][problem4-2], [묶음 2 결과][batch2], [Purge Configuration][purge-config]

### 03-028

**앞면:** 오래 열린 트랜잭션 때문에 PostgreSQL 표가 8,192바이트에서 368,640바이트로 커졌다. 그 트랜잭션이 커밋한 뒤 VACUUM을 돌리면 dead tuple과 표 크기는 어떻게 되는가?

**뒷면:** VACUUM이 dead tuple 1만 개를 한 번에 지웠지만(아직 지울 수 없던 수 0), 표 크기는 368,640바이트 그대로였다. VACUUM은 비운 공간을 표 안에서 다시 쓰게 표시할 뿐 파일을 줄이지 않는다. 끝쪽 페이지가 통째로 비는 특별한 경우만 운영체제에 돌려준다. 파일까지 줄이려면 표를 새로 쓰는 VACUUM FULL이 필요하다. 비운 공간은 이후 `INSERT`·`UPDATE`가 다시 쓴다.

**근거:** [문제 상황 4-3][problem4-3], [묶음 2 결과][batch2], [PostgreSQL Routine Vacuuming][pg-vacuum]

### 03-029

**앞면:** 오래 열린 트랜잭션이 커밋한 뒤 MySQL History list length(10002)는 세 번 중 두 번 3초 안에 0이 되었는데, 한 번은 2203에서 10초 동안 그대로였다. 소스로 보면 어떻게 설명되는가?

**뒷면:** 소스로 한 추론이고 확인하지 않았다. MySQL 8.4.13의 purge coordinator는 잠깐(10ms) 기다리는 동안 History list length가 그대로이고 5000보다 작으면 쉬러 들어가 새 DML이 올 때까지 일어나지 않는다(`srv0srv.cc`). 그리고 이 수는 undo log를 정리할 때 바로 줄지 않고 purge가 128번 돌 때마다 하는 truncate 단계에서만 준다. 5000 아래에서 truncate 사이에 잠들면 그때 수에서 멈추고, 다음 실행의 기다림도 B의 `UPDATE`가 시작할 때까지 60초를 다 채웠다. 확인하려면 `SHOW ENGINE INNODB STATUS`의 purge 상태 줄을 함께 남긴다.

**근거:** [첫 해석의 History list length 문답][interpretation-history], [측정하며 본 것][observed]

### 03-030

**앞면:** 읽기만 하는 트랜잭션도 오래 열어 두면 안 되는 이유는? 실험에서 무엇이 커졌는가?

**뒷면:** 스냅숏이 있는 동안 그 뒤에 생긴 이전 버전을 지우지 못하기 때문이다. 실험에서 그 사이 고친 1만 번의 이전 버전이 모두 남았고(MySQL History list length 10002, PostgreSQL 10000), 오래된 스냅숏으로 읽는 MySQL 쪽 읽기가 9.3배, PostgreSQL에서는 그 행을 고치는 쓰기가 최대 1.36배 느려졌으며, PostgreSQL 표 파일은 페이지 1개에서 45개로 커진 채 남았다. MySQL 매뉴얼도 consistent read만 하는 트랜잭션을 포함해 정기적으로 커밋하라고 권하고, PostgreSQL은 `idle_in_transaction_session_timeout`으로 열린 채 쉬는 트랜잭션을 끊을 수 있다.

**근거:** [문제 상황 4-1][problem4-1], [문제 상황 4-3][problem4-3], [InnoDB Multi-Versioning][multi-versioning], [PostgreSQL Client Connection Defaults][pg-client]

## 스토리지 엔진

### 03-031

**앞면:** InnoDB와 MyISAM은 트랜잭션, 다른 세션에 보이는 때, 락의 범위에서 어떻게 다른가?

**뒷면:** InnoDB는 트랜잭션을 지원하고(커밋, 롤백), 커밋 전 변경을 MVCC로 다른 세션에서 숨기며, 행 단위로 락을 건다. MyISAM은 트랜잭션이 없어 문장이 끝나는 순간 반영되어 다른 세션에 바로 보이고 `ROLLBACK`으로 되돌릴 수 없다. 락은 문장이 도는 동안 표 전체에 걸고 문장이 끝나면 푼다. MySQL 5.5부터 기본 storage engine은 InnoDB다.

**근거:** [문제 상황 5][problem5], [문제 상황 5-1][problem5-1], [The MyISAM Storage Engine][myisam-doc]

### 03-032

**앞면:** 주문 요청이 트랜잭션 안에서 InnoDB 표 `orders`와 MyISAM 표 `order_logs`에 한 행씩 넣은 뒤 결제 실패로 `ROLLBACK`했다. 그사이와 그 뒤 다른 세션이 센 두 표의 행 수는? `ROLLBACK`은 어떻게 끝났는가?

**뒷면:** 두 때 모두 `orders` 0, `order_logs` 1이었다. `ROLLBACK`은 오류 없이 끝나고 경고 1196("Some non-transactional changed tables couldn't be rolled back")만 남겼다. InnoDB 쪽만 되돌리고 MyISAM 쪽은 되돌릴 undo log가 없어 그대로 둔다. 경고를 따로 읽지 않으면 애플리케이션은 모두 되돌려졌다고 보게 되고, 주문은 없는데 주문 기록만 남는다. 원자성은 트랜잭션을 지원하는 storage engine의 표에만 적용된다.

**근거:** [문제 상황 5][problem5], [COMMIT과 ROLLBACK 문서][commit-doc]

### 03-033

**앞면:** 재고 리포트(A, 자동 커밋)가 `stock` 표 전체를 약 2초 동안 읽는 중에 B가 상품 2의 재고를 1 줄인다. MyISAM과 InnoDB에서 B는 기다리는가? A가 읽은 상품 2의 재고는?

**뒷면:** MyISAM은 B의 `UPDATE`가 1.20~1.21초 기다려 A의 읽기가 끝난 뒤 끝났고, A는 10을 읽었다. A의 `SELECT`가 표에 읽기 락을 쥔 동안 쓰기 락이 줄을 선다. 트랜잭션이 없다고 락이 없는 것은 아니다. InnoDB는 평범한 `SELECT`가 락을 걸지 않아 B가 0.005~0.007초에 끝났고, A는 `SELECT`가 시작할 때의 스냅숏으로 읽어 역시 10이었다. 두 엔진 모두 10이지만 이유가 다르다.

**근거:** [문제 상황 5-1][problem5-1], [Internal Locking Methods][internal-locking], [Consistent Nonlocking Reads][consistent-read]

## 지속성

### 03-034

**앞면:** 커밋할 때 MySQL과 PostgreSQL은 어떤 로그를 디스크에 내리는가? 그 시점을 정하는 설정과 값은?

**뒷면:** MySQL은 redo log(InnoDB가 장애 뒤 커밋한 변경을 다시 적용하는 로그)와 binary log(복제와 시점 복구에 쓰는 로그, 8.4에서 기본으로 켜짐) 둘이다. `innodb_flush_log_at_trx_commit`이 1(기본)이면 커밋마다 redo log를 쓰고 fsync하고, 2면 커밋마다 OS에 쓰기만 하고 fsync는 약 1초마다 한다. `sync_binlog`가 1(기본)이면 커밋마다 binary log를 fsync하고, 0이면 OS에 맡긴다. PostgreSQL은 WAL 하나이고, `synchronous_commit`이 on(기본)이면 WAL을 디스크에 내린 뒤 커밋 완료를 알리고, off면 내리기 전에 알린다. fsync는 OS가 메모리에 든 파일 내용을 디스크에 실제로 쓰고 끝날 때까지 기다리는 호출이다.

**근거:** [문제 상황 6][problem6], [지속성 설정 측정 규칙][durability-rules]

### 03-035

**앞면:** `innodb_flush_log_at_trx_commit=2`, `sync_binlog=0`, PostgreSQL `synchronous_commit=off`는 장애가 나면 각각 무엇을 잃을 수 있는가?

**뒷면:** `innodb_flush_log_at_trx_commit=2`는 커밋마다 OS까지는 쓰므로 mysqld만 죽으면 남고, OS가 죽거나 전원이 꺼지면 마지막 약 1초의 커밋을 잃을 수 있다. `sync_binlog=0`은 OS나 기계가 죽으면 binary log의 마지막 문장을 잃을 수 있다. `synchronous_commit=off`는 최근 커밋을 잃을 수 있지만(최대 `wal_writer_delay`의 3배, 기본 600ms) DB가 깨지지는 않고 그 트랜잭션들이 깨끗이 취소된 것과 같은 상태가 된다. WAL이 아직 DB 메모리에 있을 수 있어 DB만 죽어도 잃을 수 있다. 커밋을 믿고 영수증을 보내는 것처럼 바깥에 알리는 일이 있으면 쓰지 않는다.

**근거:** [문제 상황 6][problem6], [The Binary Log][binary-log], [synchronous_commit][pg-wal-config], [Asynchronous Commit][pg-async]

### 03-036

**앞면:** 맥에서 자동 커밋 `INSERT`의 초당 수는 MySQL 기본값(1, 1)에 비해 redo log fsync만 뺀 설정(2, 1)이 1.11배, binary log fsync만 뺀 설정(1, 0)이 2.50배, 둘 다 뺀 설정(2, 0)이 2.77배였다. 무엇을 알 수 있는가?

**뒷면:** MySQL 기본값은 커밋 한 번마다 fsync를 두 번 기다린다(redo log, binary log). 하나만 빼면 나머지 하나가 남아 여전히 커밋마다 디스크를 기다린다. 지연 p50이 0.82ms에서 redo log 쪽을 빼면 0.09ms, binary log 쪽을 빼면 0.46ms 줄어, 이 맥에서는 binary log fsync가 약 5배 비쌌다. 그래서 남는 쪽이 비싼 binary log인 (2, 1)은 거의 늘지 않았다. 같은 설정을 컨테이너에서 임시로 쟀을 때는 두 fsync가 비슷해 (2, 1)도 1.37배였다. 배수는 디스크의 fsync 비용에 따라 달라진다.

**근거:** [묶음 4 결과][batch4], [첫 해석의 fsync 문답][interpretation-fsync]

### 03-037

**앞면:** 같은 디스크, 같은 `fdatasync`인데 MySQL binary log의 fsync가 redo log나 PostgreSQL WAL보다 훨씬 비쌌다. 파일이 어떻게 변하는지로 설명하라. 실험은 이를 어떻게 확인했는가?

**뒷면:** binary log는 커밋마다 파일 끝에 바이트가 붙어 파일 크기가 커진다. redo log(`#innodb_redo`의 파일을 돌려 씀)와 WAL(16MB 세그먼트를 미리 만듦)은 미리 만든 고정 크기 파일의 자리를 덮어써 크기가 변하지 않는다. `fdatasync`는 데이터만 내리지만 파일 크기가 바뀌면 그 metadata도 내려야 해서 파일시스템 journal 쓰기가 더 붙는다. 같은 디스크에서 8KB를 500번 동기 쓰기 했을 때, 미리 만든 파일 덮어쓰기는 한 번 0.087~0.088ms로 새 파일 이어 쓰기(0.658~0.739ms)의 0.12~0.13배였다. 덮어쓰기가 싸다는 것은 쟀고, 그 차이가 journal 쓰기 때문이라는 것은 추론이다.

**근거:** [해석 중 더한 측정][sync-write], [첫 해석의 fsync 문답][interpretation-fsync], [fdatasync(2)][fsync-man]

### 03-038

**앞면:** 같은 실험 코드와 DB 버전으로 컨테이너(클라우드 Linux VM)와 맥(Docker Desktop)에서 잰 결과는 무엇이 같고 무엇이 달랐는가? 숫자를 어떻게 읽어야 하는가?

**뒷면:** 누가 무엇을 읽고 누가 기다리는지 같은 순서 결과(묶음 1·3의 41개 조건)는 모두 같았다. 지연과 처리량처럼 시간을 재는 숫자는 달랐다. 예를 들어 PostgreSQL `synchronous_commit=off`의 처리량 배수는 컨테이너 3.65배, 맥 1.26배였고, MySQL에서 어느 fsync를 빼야 빨라지는지도 바뀌었다. 두 곳 모두 VM 안의 가상 디스크라 fsync 비용이 실제 서버와 다를 수 있으므로, 숫자는 그 환경의 값으로만 말하고 디스크 기준(동기 쓰기 한 번의 시간)과 함께 본다.

**근거:** [참고: 컨테이너 임시 확인 값과 맥 본 측정][container-vs-mac], [첫 해석의 환경 문답][interpretation-env]

[before]: ../experiments/03-mysql-isolation-mvcc/README.md#시작-전-기록
[goal]: ../experiments/03-mysql-isolation-mvcc/README.md#목표
[interpretation]: ../experiments/03-mysql-isolation-mvcc/README.md#첫-해석
[interpretation-env]: ../experiments/03-mysql-isolation-mvcc/README.md#컨테이너-임시-확인과-맥-본-측정의-차이
[interpretation-fsync]: ../experiments/03-mysql-isolation-mvcc/README.md#묶음-4-커밋마다-기다리는-두-fsync의-몫
[interpretation-history]: ../experiments/03-mysql-isolation-mvcc/README.md#묶음-2-history-list-length가-줄지-않고-머문-실행
[problem1]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-1-같은-트랜잭션에서-개수가-2-3-2로-바뀐-응모-확인
[problem1-1]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-1-1-처음-쓰는-조건으로-다시-세기
[problem1-2]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-1-2-트랜잭션을-연-뒤-처음-세기
[problem1-2-variant]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-1-2-변형-첫-문장이-다른-표의-update일-때
[problem2]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-2-정산-리포트가-세-번-읽은-잔액
[problem1-3]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-1-3-응모-행을-잠그며-읽기
[problem3]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-3-동시에-차감한-포인트
[problem4]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-4-열어-둔-정산-트랜잭션
[problem4-variant]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-4-변형-다른-표만-읽고-둔-트랜잭션
[problem4-1]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-4-1-열어-둔-트랜잭션이-있을-때의-읽기-시간
[problem4-2]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-4-2-long-running-transaction이-있을-때-writer-b의-update-latency
[problem4-3]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-4-3-long-running-transaction이-끝난-뒤
[problem5]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-5-되돌린-주문과-남은-기록
[problem5-1]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-5-1-재고-리포트가-도는-중에-들어온-차감
[problem6]: ../experiments/03-mysql-isolation-mvcc/README.md#문제-상황-6-커밋을-디스크에-언제-내릴까
[timeline-rules]: ../experiments/03-mysql-isolation-mvcc/README.md#순서표-실행-규칙
[durability-rules]: ../experiments/03-mysql-isolation-mvcc/README.md#지속성-설정-측정-규칙
[batch13]: ../experiments/03-mysql-isolation-mvcc/README.md#묶음-13-순서표-조건마다-3회
[batch2]: ../experiments/03-mysql-isolation-mvcc/README.md#묶음-2-열어-둔-트랜잭션-경우마다-3회
[batch4]: ../experiments/03-mysql-isolation-mvcc/README.md#묶음-4-지속성-설정-설정마다-3회
[sync-write]: ../experiments/03-mysql-isolation-mvcc/README.md#해석-중-더한-측정-이어-쓰기와-덮어쓰기-방식마다-3회
[observed]: ../experiments/03-mysql-isolation-mvcc/README.md#측정하며-본-것
[container-vs-mac]: ../experiments/03-mysql-isolation-mvcc/README.md#참고-컨테이너-임시-확인-값과-맥-본-측정
[consistent-read]: https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html
[locking-reads]: https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html
[multi-versioning]: https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html
[undo-logs]: https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-logs.html
[mysql-iso]: https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html
[innodb-locking]: https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html
[purge-config]: https://dev.mysql.com/doc/refman/8.4/en/innodb-purge-configuration.html
[myisam-doc]: https://dev.mysql.com/doc/refman/8.4/en/myisam-storage-engine.html
[commit-doc]: https://dev.mysql.com/doc/refman/8.4/en/commit.html
[internal-locking]: https://dev.mysql.com/doc/refman/8.4/en/internal-locking.html
[binary-log]: https://dev.mysql.com/doc/refman/8.4/en/binary-log.html
[pg-iso]: https://www.postgresql.org/docs/18/transaction-iso.html
[pg-locking]: https://www.postgresql.org/docs/18/explicit-locking.html
[pg-vacuum]: https://www.postgresql.org/docs/18/routine-vacuuming.html
[pg-hot]: https://www.postgresql.org/docs/18/storage-hot.html
[pg-snapshot]: https://www.postgresql.org/docs/18/functions-info.html
[pg-client]: https://www.postgresql.org/docs/18/runtime-config-client.html
[pg-wal-config]: https://www.postgresql.org/docs/18/runtime-config-wal.html
[pg-async]: https://www.postgresql.org/docs/18/wal-async-commit.html
[fsync-man]: https://man7.org/linux/man-pages/man2/fsync.2.html
