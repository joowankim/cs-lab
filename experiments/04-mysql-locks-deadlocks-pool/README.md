# 04 MySQL 락·데드락·커넥션 풀

두 세션을 번갈아 실행해 다른 세션의 문장이 언제 기다리는지 보고, 그때 걸린 락을 `performance_schema.data_locks`로 읽는다. 두 이체로 데드락을 일으켜 InnoDB가 어떻게 끝내는지(데드락 탐지를 켰을 때와 껐을 때) 보고, 같은 요청 여러 개를 동시에 보내 갱신 손실과 중복 지급을 재현한 뒤 막는 방법 셋(비관적 락, 낙관적 락, 유니크 제약)을 비교한다. 커넥션 풀 크기에 따른 연결 대기와 타임아웃, 새 연결 비용도 잰다. MySQL에서만 한다. 공통 규칙은 [작업 지침](../../AGENTS.md)을 따른다.

2026-11-03에 목표와 범위를 정했고, 2026-11-03~04에 문제 상황마다 측정 전 예상을 받았으며, 2026-11-04에 맥에서 본 측정을 마쳤다. 시작 전 기록은 측정하지 않은 상태의 예상과 문답이고, 그 피드백의 값은 클라우드 컨테이너에서 임시로 돌린 값이다. 측정값과 판정은 [결과 정리](#결과-정리)에, 결과를 보며 나눈 문답은 [첫 해석](#첫-해석)에 있다. 2026-11-05~06에 학습 확인을 했고, 그 문답은 [완료 후 학습 확인](#완료-후-학습-확인)에, 정리한 결론은 [정리한 결론과 선택 기준](#정리한-결론과-선택-기준)에 있다.

복습할 때는 [앞면·뒷면으로 정리한 카드](../../anki/04-mysql-locks-deadlocks-pool.md)와 [복습 화면](https://joowankim.github.io/cs-lab/04-mysql-locks-deadlocks-pool/)을 쓴다.

## 목표

실험을 마치면 다음을 할 수 있어야 한다.

1. **예측:** 두 세션 순서표에서 기다리는 문장, 데드락이 나는지와 되돌려지는 쪽을 격리 수준(REPEATABLE READ, READ COMMITTED)과 인덱스 유무에 따라 맞힌다. 03 실험에서 이유를 미뤄 둔 "SERIALIZABLE에서 A가 읽지 않은 새 행의 `INSERT`도 1.74초 기다림"을 gap lock·next-key lock으로 설명한다.
2. **설명:** 기다림과 데드락을 `performance_schema.data_locks`와 `SHOW ENGINE INNODB STATUS`에서 읽은 실제 락(어느 인덱스의 어느 레코드와 범위에 어떤 모드)으로 설명하고, 데드락 탐지를 켰을 때와 껐을 때 데드락이 끝나는 방식을 잰 시간으로 말한다.
3. **고르기:** 중복 지급을 막는 세 방법을 지급 수·오류 수·다시 시도 수·걸린 시간으로 비교해 상황에 맞게 고른다. 커넥션 풀 크기에 따른 대기 시간과 타임아웃 수, 새 연결 비용을 숫자로 말한다.

확인 방법은 03과 같다. 측정 전에 적은 예상을 실측과 대조해 맞힌 수를 센다. 완료 후에는 아래 질문 8개에 해설 없이 답하고, 직접 잰 숫자를 넣어 답한 수와 "왜?"에 두 번까지 답한 수를 센다. 03의 값(예상 31/63, 숫자를 넣어 혼자 답한 질문 1/9)과 견줘 기록한다.

### 확인할 질문

1. 공유 락과 배타 락은 무엇이 다르고, 서로 언제 충돌(conflict)하는가.
2. gap lock과 next-key lock은 왜 있는가. 무엇을 막고, 그 대가는 무엇인가.
3. DB에서 데드락은 어떤 과정으로 생기는가. 데드락의 네 조건은 어디에서 보이는가.
4. 데드락을 끝내는 두 방법(대기 그래프로 찾아 되돌리기, 락 대기 시간 초과)은 무엇이 다르고, 각각 무엇을 되돌리는가.
5. 데드락은 어떻게 줄이는가(락 순서, 격리 수준). 격리 수준을 올리면 데드락이 줄어드는가.
6. 낙관적 락과 비관적 락은 무엇이 다르고, 언제 무엇을 고르는가.
7. 재고 차감, 중복 지급, 중복 예약 같은 중복은 어떻게 막는가.
8. DB 커넥션 풀은 왜 쓰고, 크기는 어떻게 정하는가.

## 다룰 범위

| 묶음 | 볼 것 | 실행 틀 |
|---|---|---|
| ① | 범위를 `FOR UPDATE`로 잠근 뒤 다른 세션이 범위 안·밖·경계에 `INSERT`할 때 기다리는지, 인덱스가 있을 때와 없을 때, REPEATABLE READ와 READ COMMITTED 비교와 그때의 `data_locks` | `lock_lab.py` |
| ② | 두 세션이 두 행을 반대 순서로 고치는 데드락, LATEST DETECTED DEADLOCK 보고 읽기, 탐지를 껐을 때 끝나는 방식과 걸린 시간, 락 순서 고정. 같은 "읽고 고치기" 10건을 RC·RR·SERIALIZABLE에서 동시에 보낼 때의 데드락 수와 잔액 | `lock_lab.py`, `burst_lab.py` |
| ③ | 같은 리워드 지급 요청 10건을 동시에 보내고, 막지 않음 / 비관적 락 / 낙관적 락(version, 실패 시 다시 시도) / 유니크 제약으로 지급 수·오류 수·다시 시도 수·걸린 시간 비교. 사람이 앞서 쓴 판과 이어서 낸 물음의 판, 비관적 락 처음 판을 두 요청으로 줄였을 때 보유(hold)한 락 | `burst_lab.py`, `lock_lab.py` |
| ④ | 풀 크기 5·10·50에 동시 요청 50개, 트랜잭션 안 200ms. 연결 대기 시간·풀 타임아웃 수와, 요청마다 새로 연결할 때의 지연 비교 | `pool_lab.py` |

①~④를 MySQL에서만 하고, ③은 리워드 두 번 지급 한 상황만 다루며, ③을 막는 SQL 세 가지는 사람이 직접 쓴다(2026-11-03 사람이 고른 범위). 중복 예약은 유니크 제약이 겹치는 시간 범위를 막지 못하는 문제가 더해져 이번에 다루지 않는다.

MySQL 8.4.13을 Docker Desktop으로 띄운다. 실행 규칙과 방법은 아래 [순서표 실행 규칙](#순서표-실행-규칙), [동시 요청 측정 규칙](#동시-요청-측정-규칙), [커넥션 풀 측정 규칙](#커넥션-풀-측정-규칙), [실행 방법](#실행-방법)에 적었다.

## 시작 전 기록

아래는 측정 전의 예상과 문답이다. 에이전트 피드백에 적은 값은 클라우드 컨테이너(Linux, Docker, MySQL 8.4.13 공식 이미지)에서 임시로 돌린 값이고 본 측정이 아니다. 예상 적중도 그 값으로 센 잠정치였고, 맥 본 측정으로 다시 센 판정은 [결과 정리](#결과-정리)에 있다. 사람의 답은 원문 그대로 옮겼다.

### 지난 실험의 변형 문제 (2026-11-02 질문, 11-03 답)

- 문제(에이전트): MySQL REPEATABLE READ. A가 `START TRANSACTION;` 뒤 `SELECT balance FROM accounts WHERE id = 1;`을 하고 둔다. B가 `id = 2`, `id = 3` 행을 각각 5000번씩 고친다(자동 커밋). 그다음 A가 `SELECT balance FROM accounts WHERE id = 2;`를 한다. (1) 3번 직전 A의 스냅숏 수 (2) 치우지 못한 이전 버전 수와 이유 (3) 3번 읽기가 B가 없을 때보다 느린지, 무엇을 따라가서인지.
- 사람의 답(원문): "1. 1개야. 스냅샷은 한 트랜잭션에는 하나만 가질 수 있어. 2. 대략 100~200개 정도 될거라 생각해. 그 이유는 앞선 조회에서의 조건은 id가 1인 행에 대한 조회였기 때문에 2에 대한 스냅샷은 참조하지 않았어. 그래서 세션 B에서 수행한 5000번의 2에 대한 수정 이전 버전은 자동 커밋 후 곧바로 지워지기 시작했을거야. 그래서 5000번 보다 훨씬 작게 undo log에 이전 버전이 남아있을거야. 3. 느리지 않아."
- 에이전트 피드백: 1은 맞다. 2·3은 03 문제 상황 4 변형 (바)의 맥 측정(A가 `visits`만 읽고 둔 채 B가 `accounts`를 1만 번 고치자 History list length 10002)과 어긋난다고 짚고 다시 답하게 했다.
- 사람의 답 2(원문): "2. 5000개 정도가 될거라 생각해. 그 이유는 A 세션의 앞선 일관된 조회에서 해당 db에 대해 참조하는 스냅샷이 생겼고 이 스냅샷이 세션 B에서 수정한 테이블을 포함하고 있기 때문에 undo log에 해당 행에 대한 이전 버전이 지워지지 않기 때문이야. 3. 느려져. undo log에 남아있는 해당 행의 이전 버전을 타고 올라가서 A 세션의 트랜잭션이 참조하는 해당 행을 수정했던 트랜잭션 id를 찾기 때문이야."
- 에이전트 피드백: 2는 개수만 고친다. B가 id 2와 3을 5000번씩 고쳐 약 1만 개가 남는다. purge는 A의 스냅숏이 만들어진 뒤 커밋된 트랜잭션의 undo log를 지우지 못하고, InnoDB는 A가 나중에 어느 행을 읽을지 미리 알 수 없다. 스냅숏은 표를 담는 것이 아니라 트랜잭션 ID로 보이는지를 가리는 규칙이다. 3은 맞다(id 2의 이전 버전 약 5000개를 따라 내려감). 이어진 질문("다른 행의 이전 버전까지 탐색하는 이유")에는, 롤 포인터는 행마다 따로 이어져 id 2를 읽을 때는 id 2의 줄만 따라가며, id 3의 이전 버전은 읽기를 느리게 하지 않지만 지워지지 못하고 쌓인다고 답했다.
- 확인한 부분: 스냅숏이 트랜잭션마다 하나라는 것은 혼자 답했다. 스냅숏이 읽은 행이 아니라 DB 전체에 걸린다는 것은 03 측정을 다시 본 뒤 고쳤고, 그래도 "테이블을 포함"한다고 말해 학습 확인에서 다시 묻는다.

### 문제 상황 1: 잠근 응모 사이로 들어오는 새 응모 (2026-11-03)

- 표: `entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))`, 처음 행 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12).
- 순서: A `START TRANSACTION;` `SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;`(→ 2, 3) → B(자동 커밋)가 다섯 문장 중 하나 → A `COMMIT;`. 경우마다 처음 행에서 따로 돌린다. B는 (가) `INSERT INTO entries VALUES (10, 7);` (나) `(11, 5)` (다) `(12, 10)` (라) `(13, 15)` (마) `(14, 1)`이고, 순서표는 `idx-insert-user7`, `-user5`, `-user10`, `-user15`, `-user1`이다.
- 물은 것: A가 REPEATABLE READ일 때와 READ COMMITTED일 때 (가)~(마)가 A의 `COMMIT`까지 기다릴지 바로 끝날지, 이유.
- 사람의 예상과 이유(원문): "모두 바로 끝난다고 생각해. 배타락이 잠근건 해당 statement가 실행되는 시점의 user_id가 7인 행들이라고 추측했어. 그러면 새로 추가되는 행과는 관련이 없을거라 생각해. serializable 격리수준이 아니라면 서로 다른 세션에서의 트랜잭션이 서로 커밋되지 않게 막지는 않으니까." 틀렸다고 볼 조건은 적지 않았다(적은 것과 다르면 빗나감).
- 에이전트 피드백: 컨테이너에서 RR은 (가)(나)(다)가 기다렸고 (라)(마)는 바로 끝났다. RC는 다섯 모두 바로 끝났다. RR의 `data_locks`는 `idx_user`에 `X` (7, 2)·`X` (7, 3)·`X,GAP` (12, 4), `PRIMARY`에 `X,REC_NOT_GAP` 2·3이었고, RC는 두 인덱스 모두 `X,REC_NOT_GAP`만이었다. "SERIALIZABLE이 아니면 막지 않는다"는 03 문제 상황 3(같은 행 `UPDATE`가 RC에서도 기다림)으로 고쳤다. 락은 격리 수준과 상관없이 쓰기끼리 충돌하고, 격리 수준은 잠그는 범위를 바꾼다.
- 이어진 문답: 처음에 쓴 "빈 틈"은 에이전트가 지어낸 말이라 표준 용어로 고쳤다. 인덱스 레코드(index record)는 키 순서로 정렬되어 있고 보조 인덱스 레코드는 (user_id, id) 순이며, 갭(gap)은 정렬 순서에서 이웃한 두 레코드 사이의 키 범위다. 레코드 락(record lock), 갭 락(gap lock), 넥스트 키 락(next-key lock, 레코드와 그 앞 갭), 삽입 의도 락(insert intention lock)을 `data_locks` 표기와 맞춰 설명했다. 사람은 새 레코드가 들어갈 자리를 처음에 (id, user_id) 순으로 놓았다가(에이전트가 칸 순서를 반대로 적은 것이 원인) 스스로 고쳤다(원문): "1. (가) (7, 3)과 (12, 4) 사이, (나) (3, 1)과 (7, 2) 사이, (다) (7, 3)과 (12, 4) 사이, (라) (12, 4) 뒤, (마) (3, 1) 앞 / 그런데 왜 행마다 걸린 락의 모드가 다른거야?" 잠금 읽기는 훑은 인덱스 레코드마다 락을 걸어, 조건에 맞는 (7, 2)·(7, 3)은 넥스트 키 락, 멈추려고 읽은 (12, 4)는 조건에 맞지 않아 갭 락, 행 데이터가 있는 클러스터형 인덱스(`PRIMARY`)의 2·3은 고유 키라 레코드 락만 걸린다고 설명했다.
- 왜 갭까지 잠그는지(사람의 답, 원문): "모르겠어. 락을 어디에 거는지는 알겠는데 왜 갭까지 락을 걸어 잠그는지 모르겠어." 에이전트가 RC에서는 A의 두 번째 `FOR UPDATE`가 2, 3, 10을 돌려준다는 것을 보이고 물었고, 사람은 답했다(원문): "1. non-repeatable read 2. user_id = 7 인덱스 레코드 뒤에 갭에도 락을 걸어서 수정이 불가능하게 만들어야겠네. 그런데 이거는 수정을 위한 기능이 아니라 조회의 데이터 일관성을 위한 기능인거야?" 1은 틀렸다. 새로 나타난 10은 phantom read이고, non-repeatable read는 있던 행의 값이 바뀐 것이다(SQL-92의 현상 이름). 레코드 락은 아직 없는 행에 걸 수 없어 팬텀은 갭 락이 막는다. 2는 맞다. 막는 것은 수정이 아니라 삽입이고, user_id 7이 들어갈 수 있는 갭을 모두 잠그며, 갭은 범위라 user_id 5·10의 삽입도 같이 막힌 것이 그 대가다. 평범한 `SELECT`의 일관성은 스냅숏이 맡고, 갭 락은 최신 행을 읽고 잠그는 문장에서만 생긴다.
- 예상 적중(컨테이너 기준): 7/10(RC 다섯, RR (라)(마)).
- 확인한 부분: 갭까지 잠그는 이유는 RC 비교 힌트를 받은 뒤 스스로 답했다. 새로 나타난 행을 non-repeatable read로 불러, 두 현상의 구분을 학습 확인에서 다시 묻는다.

### 문제 상황 1-1: 인덱스가 없을 때 (2026-11-03)

- 표: 문제 상황 1에서 `KEY idx_user (user_id)`만 뺐다. 처음 행과 순서는 같고, B는 (가) `INSERT INTO entries VALUES (10, 7);` (나) `INSERT INTO entries VALUES (13, 15);` (다) `DELETE FROM entries WHERE id = 1;`(user_id 3의 응모 취소)이다. 순서표는 `noidx-insert-user7`, `noidx-insert-user15`, `noidx-delete-id1`이다.
- 물은 것: RR과 RC에서 (가)~(다)가 기다릴지 바로 끝날지, 이유. A가 어느 인덱스의 어떤 레코드를 훑었을지부터 생각해 보라고 덧붙였다.
- 사람의 예상과 이유(원문): "인덱스가 없으면 모두 바로 끝나는거 아니야? 새로 추가되는 행에 락이 걸릴리는 없고, 인덱스 레코드도 없으니 갭에 락이 걸리지도 않을거잖아." 이어서(원문): "아, (다)는 삽입이 아니고 삭제구나. 그런데 어차피 (다)의 user_id는 3이니까 락이 걸려있지 않아서 똑같이 바로 끝나는거 아니야?" 두 메시지를 RR·RC 모두 (가)(나)(다) 바로 끝남이라는 예상으로 받았다.
- 에이전트 피드백: 컨테이너에서 RR은 셋 모두 기다렸고 RC는 모두 바로 끝났다. `data_locks`는 RR이 `PRIMARY`에 `X` 1, 2, 3, 4와 supremum pseudo-record, RC가 `PRIMARY`에 `X,REC_NOT_GAP` 2, 3이었다. 새 행에는 락이 없고 `INSERT`를 막는 것이 갭의 락이라는 것은 맞다. 인덱스 레코드가 없다는 것은 틀렸다. 빠진 것은 `idx_user`뿐이고 클러스터형 인덱스 `PRIMARY`의 레코드와 갭은 그대로다. user_id로 찾을 인덱스가 없어 A는 `PRIMARY`를 처음부터 끝까지 훑고, 잠금 읽기는 조건과 상관없이 훑은 레코드마다 락을 걸어 RR에서는 모든 행과 supremum(인덱스 끝의 가상 레코드, 그 락이 4 뒤의 갭을 잠금)에 넥스트 키 락이 걸렸다. (다)는 A도 행 1을 읽어 봐야 user_id 3인 것을 알고, 읽으면서 이미 잠갔다. RC는 조건을 확인한 뒤 맞지 않는 행(1, 4)의 락을 해제(release)하고 갭을 잠그지 않는다. 근거는 [Locks Set by Different SQL Statements in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html): "If you have no indexes suitable for your statement and MySQL must scan the entire table to process the statement, every row of the table becomes locked, which in turn blocks all inserts by other users to the table."
- 예상 적중(컨테이너 기준): 3/6(RC 셋).
- 확인한 부분: 갭의 락이 `INSERT`를 막는다는 것은 혼자 말했다. 클러스터형 인덱스에도 레코드와 갭이 있다는 것은 예상에 쓰지 못했고, 락이 걸리는 기준을 조건에 맞는 행으로 본 것((다)의 이유)은 학습 확인에서 다시 묻는다.

### 문제 상황 1-2: 실험 3에서 미뤄 둔 1.74초 (2026-11-03)

- 장면: 03 문제 상황 1-3의 MySQL SERIALIZABLE. 표 `entries (id INT PRIMARY KEY, user_id INT NOT NULL)`(user_id 인덱스 없음), 처음 행 (1, 7), (2, 7), (3, 8). A가 `START TRANSACTION;` 뒤 평범한 `SELECT id FROM entries WHERE user_id = 7 ORDER BY id;`만 하고 커밋하기 전에, B가 `START TRANSACTION;` `INSERT INTO entries (id, user_id) VALUES (4, 7);` `COMMIT;`을 했고, B의 `INSERT`가 A의 `COMMIT`까지 1.74~1.75초 기다렸다(03 맥 측정). 순서표는 03의 `entries-rows`와 같은 `serializable-insert`다.
- 물은 것: (1) A가 보유했을 락을 `data_locks` 꼴(인덱스, `LOCK_MODE`, `LOCK_DATA`)로 적기 (2) B의 `INSERT`를 막은 락은 그중 어느 것인가. 03 문제 상황 2에서 SERIALIZABLE의 평범한 `SELECT`가 무엇으로 바뀌었는지 떠올리라고 덧붙였다.
- 사람의 답(원문): "1. 세 행과 그 뒤 supremum 모두 넥스트 키 락이 걸림. 2. (2, 7)과 (3, 8) 사이 갭에 걸린 넥스트 키 락"
- 에이전트 피드백: 1은 맞다(잠긴 범위와 넥스트 키 락). 적지 않은 모드는 `S`다. SERIALIZABLE은 평범한 `SELECT`를 `SELECT ... FOR SHARE`로 바꾼다. 컨테이너의 `data_locks`는 `PRIMARY`에 `S` 1, 2, 3, supremum pseudo-record였다. 2는 빗나갔다. user_id 순으로 놓은 자리인데, 이 표에 남은 인덱스는 id 순으로만 정렬된 `PRIMARY` 하나라 id 4는 3과 supremum 사이 갭에 들어가고, 막은 것은 supremum의 넥스트 키 락이다. A가 읽기만(공유 락) 했는데 `INSERT`가 막힌 것은 갭 락이 S든 X든 똑같이 삽입만 막기 때문이다. 근거는 [InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html): "There is no difference between shared and exclusive gap locks. They do not conflict with each other, and they perform the same function." 03의 1.74초는 인덱스 없는 표를 SERIALIZABLE로 읽어 표 전체가 `S` 넥스트 키 락으로 잠기고, supremum의 락이 id 4가 들어갈 갭을 막아 A의 `COMMIT`까지 기다린 시간이다.
- 예상 적중(컨테이너 기준): 1/2.
- 확인한 부분: 인덱스가 없으면 표 전체와 supremum이 잠긴다는 것은 1-1 피드백을 바로 적용했다. 클러스터형 인덱스의 정렬 기준(기본 키만)과 보조 인덱스의 정렬 기준((user_id, id))을 섞고, SERIALIZABLE의 평범한 `SELECT`가 공유 락을 건다는 것은 힌트를 줘도 쓰지 않아 둘 다 학습 확인에서 다시 묻는다.

### 문제 상황 2: 서로 반대로 보낸 두 이체 (2026-11-03)

- 표: `accounts (id INT PRIMARY KEY, balance INT NOT NULL)`, (1, 1000), (2, 1000). REPEATABLE READ, 락 대기 한도 5초.
- 순서: 1번 A(1번 계좌 → 2번 계좌로 100) `START TRANSACTION;` `UPDATE accounts SET balance = balance - 100 WHERE id = 1;` → 2번 B(2번 → 1번으로 100) `START TRANSACTION;` `UPDATE accounts SET balance = balance - 100 WHERE id = 2;` → 3번 A `UPDATE accounts SET balance = balance + 100 WHERE id = 2;` → 4번(3번 2초 뒤) B `UPDATE accounts SET balance = balance + 100 WHERE id = 1;` → 5번 A `COMMIT;` → 6번 B `COMMIT;`. 오류가 나도 순서표의 다음 문장을 그대로 보낸다(오류를 확인하지 않는 앱). 조건은 (가) 데드락 탐지 켬(`innodb_deadlock_detect=ON`, 기본값) (나) 끔이고, 순서표는 `transfer-reverse`다.
- 물은 것: (1) (가)(나)에서 3번과 4번이 어떻게 끝나는지(바로, 기다렸다가, 오류), 언제까지 기다리는지, 무슨 오류인지 (2) 5·6번 뒤 두 계좌의 잔액 (3) 이유(02의 데드락 4조건으로 설명해도 됨).
- 사람의 예상과 이유(원문): "1. (가) 오류, 오류는 뭔지 몰라. 그냥 추측이야. (나) 기다렸다가 끝날거 같긴 한데, 끝나는 이유가 뭔지는 몰라. 2. (가) 1000 / 1000 (나) 900 / 1000 3. (가)는 오류가 발생해서 둘다 변경이 롤백될거라 생각했어. (나)는 B가 일정시간 락을 가지고 있다가 포기하고 작업이 롤백되고 되면서 A의 점유대기 조건이 지켜지지 않으면서 데드락이 풀려서 A 세션 작업은 완료될거라 생각했어." (가)는 3·4번 모두 오류, (나)는 둘 다 기다렸다가 끝남으로 받았다.
- 에이전트 피드백: 컨테이너에서 (가)는 3번이 4번까지 약 2초 기다렸다가 끝났고 4번이 바로 1213(Deadlock found when trying to get lock)을 받아 잔액 900, 1100이었다. (나)는 3번이 5초 뒤 1205(Lock wait timeout exceeded)를 받고, 4번이 A의 `COMMIT`까지 약 3초 기다렸다가 끝나 잔액 1000, 900이었다. (가)에서 InnoDB는 4번이 고리를 만들자 바로 찾아내 B의 트랜잭션 전체만 되돌렸고, B가 보유하던 2번 계좌의 락이 해제되어 A가 끝났다. 합 2000이 유지된다. (나)에서는 먼저 기다린 A의 5초가 먼저 찼고, 1205는 기다리던 문장 하나만 되돌린다. A가 1번 계좌의 락을 보유한 채 오류를 무시하고 `COMMIT`해 1번의 -100만 커밋했고, 그때 락이 해제되어 B의 4번이 끝났다. 합 1900으로 100이 사라졌다. "점유 대기가 깨져 풀린다"는 방향은 맞고, 깨진 것은 A의 대기(문장 취소)이며 점유는 `COMMIT`까지 남았다. 근거는 [InnoDB Error Handling](https://dev.mysql.com/doc/refman/8.4/en/innodb-error-handling.html): "A transaction deadlock causes InnoDB to roll back the entire transaction." "A lock wait timeout causes InnoDB to roll back the current statement (the statement that was waiting for the lock and encountered the timeout)."
- 예상 적중(컨테이너 기준): 2/6((가)의 4번, (나)의 4번). 오류 이름과 기다린 시간은 모른다고 해서 셈에서 뺐다.
- 이어서 낸 물음: 컨테이너에서 뜬 LATEST DETECTED DEADLOCK 보고를 줄여 보이고((1) HOLDS id 1·WAITING id 2, (2) HOLDS id 2·WAITING id 1, WE ROLL BACK TRANSACTION (2)), `0:` 칸이 id(INT는 부호 비트를 뒤집어 저장해 80000001이 1)이고 `lock_mode X locks rec but not gap`이 `X,REC_NOT_GAP`이라고 설명한 뒤 물었다. (1) (1)·(2)는 A·B 중 누구이고 점유 대기와 순환 대기가 어느 줄에 보이는가 (2) 02의 락 순서 고정을 쓰면 문장 순서가 어떻게 바뀌고 (가)(나)가 각각 어떻게 끝나는가.
- 사람의 답(원문): "1. (1) A (2) B, 점유 대기: 6줄, 순환 대기: 14줄 2. id 1부터 처리되도록 바꾸면 2에서 id 1인 account를 조회하기 위해 A세션의 작업이 4에서 커밋될때까지 기다림 그러고 락을 획득하고 id 1 account balance에서 100을 빼고 5에 id 2에 100을 더함. 그러소 6에 커밋함."
- 에이전트 피드백: 1은 맞다. 점유 대기는 두 트랜잭션 모두에 보이고, 순환 대기는 (1)이 기다리는 80000002를 (2)가 보유하고 (2)가 기다리는 80000001을 (1)이 보유한 짝으로 보인다. 상호 배제는 `lock_mode X`, 비선점은 InnoDB가 락을 뺏지 않아 탐지기가 한쪽 트랜잭션을 통째로 되돌리는 것(마지막 줄)으로 보인다. 2는 흐름이 맞다. 컨테이너에서 B를 id 1 먼저로 바꾸면(`transfer-ordered`) 탐지 켬·끔 모두 B의 첫 `UPDATE`가 A의 `COMMIT`까지 기다렸다가 끝나고, 데드락과 오류 없이 잔액 1000, 1000이다. 고리가 없어 탐지 설정과 상관없다. B는 2번 → 1번 이체라 순서를 바꿔도 1번에 +100, 2번에 -100인데 A의 계산을 적었다고 짚었다. 근거는 [How to Minimize and Handle Deadlocks](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html): "When modifying multiple tables within a transaction, or different sets of rows in the same table, do those operations in a consistent order each time. Then transactions form well-defined queues and do not deadlock." 1205 뒤 그대로 `COMMIT`하면 반쪽 이체가 남으니 앱은 `ROLLBACK`하고 다시 해야 한다(에이전트 판단).
- 예상 적중(컨테이너 기준): 1/1(락 순서 고정의 흐름). 보고 읽기(물음 1)는 측정 전 예상이 아니라 셈에서 뺐다.
- 확인한 부분: 데드락 보고에서 누가 무엇을 보유한 채 무엇을 기다리는지와 점유 대기·순환 대기를 혼자 읽었고, 락 순서 고정을 SQL 이체에 옮겼다. 탐지가 한쪽만 되돌린다는 것은 예상에 쓰지 못했고, 대기 시간 초과가 문장만 되돌린다는 것은 이번에 처음 봤다.

### 문제 상황 2-1: 동시에 몰린 포인트 차감 10건 (2026-11-03)

- 표: `points (user_id INT PRIMARY KEY, balance INT NOT NULL)`, (7, 1000). 03 문제 상황 3을 10건으로 늘렸다.
- 요청: 10개가 같은 순간에 들어오고, 요청마다 연결 하나로 `START TRANSACTION;` → `SELECT balance FROM points WHERE user_id = 7;`(앱이 읽은 값 - 100을 계산, 50ms) → `UPDATE points SET balance = <계산한 값> WHERE user_id = 7;` → `COMMIT;`. 오류가 나면 그 요청은 실패로 끝나고 다시 하지 않는다. 데드락 탐지 켬, 락 대기 한도 5초. 다 반영되면 잔액은 0이다. 장면은 `deduct`다. 참고로 03에서 두 건(300, 500 차감)일 때 MySQL RC·RR은 최종 500, SERIALIZABLE은 B가 1213을 받고 최종 700이었다는 것을 보였다.
- 물은 것: RC, RR, SERIALIZABLE에서 (1) 1213을 받는 요청 수 (2) 끝난 뒤 잔액 (3) 이유.
- 사람의 예상과 이유(원문): "1. RC: 0, RR: 0, S: 0 2. RC: 900, RR: 900, S: 900 3. 10개의 세션이 같은 타이밍에 같은 값을 조회해서 1000에서 100을 뺀 900으로 값을 수정하려고 하기 때문에 결국 900으로 값이 수정된다."
- 에이전트 피드백: 컨테이너에서 RC·RR은 1213 없이 10건 모두 성공하고 잔액 900, SERIALIZABLE은 1213 9건(1건만 성공)에 잔액 900이었다. RC·RR은 이유까지 맞다. 10건이 모두 1000을 읽어 900을 계산했고 `UPDATE`가 행 락을 차례로 받아 모두 900을 써 갱신 손실(lost update)이 9건이다. SERIALIZABLE은 잔액은 맞았지만 이유가 다르다. 평범한 `SELECT`가 `FOR SHARE`가 되어 10건이 모두 `S`를 보유하고, `UPDATE`의 `X`가 다른 요청들의 `S`와 충돌해 고리가 생겨 InnoDB가 하나씩 되돌렸다. 같은 900이어도 RC·RR은 10건 모두에 성공이라 답하고 9건을 조용히 잃었고, SERIALIZABLE은 9건이 오류로 드러나 앱이 다시 시도할 수 있다.
- 예상 적중(컨테이너 기준): 5/6(SERIALIZABLE의 1213 수만 빗나감).
- 확인한 부분: 같은 값을 읽어 덮어쓰는 갱신 손실은 혼자 일반화했다. SERIALIZABLE의 평범한 `SELECT`가 공유 락을 건다는 것은 1-2에 이어 이번에도 예상에 쓰지 못해 학습 확인에서 다시 묻는다.

### 문제 상황 3: 동시에 들어온 같은 리워드 지급 10건 (2026-11-03)

- 표: `points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)` (7, 0, 0), `rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))` 비어 있음. REPEATABLE READ.
- 지금 코드(요청마다): `START TRANSACTION;` → `SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;`(0이 아니면 `ROLLBACK`, "이미 받음") → (앱 50ms) → `INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7;` → `COMMIT;`. user 7의 같은 요청 10건이 같은 순간에 들어온다.
- 물은 것: (1) 지금 코드로 10건이 끝난 뒤 rewards 행 수, 잔액, 오류 수 (2) 막는 요청 SQL을 비관적 락·낙관적 락(version)·유니크 제약 세 가지로 직접 쓰기 (3) 쓴 것마다 지급 수, 오류, 다시 시도 수 예상. 세 방법은 한 줄 정의만 줬다(비관적: 먼저 잠근 뒤 확인, 낙관적: 잠그지 않고 진행하다 고칠 때 version으로 확인, 유니크: 같은 (user_id, event_id) 행이 두 개 생기지 못하게 DB가 막음).
- 사람의 답(원문): "1. 10행, 10000, 오류 없음 2. (표) points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0) / rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY UNIQUE idx_user_event (user_id, event_id)) (요청) START TRANSACTION; SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 for update; INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); UPDATE points SET balance = balance + 1000 WHERE user_id = 7; COMMIT; idx_user_event 유니크 제약으로 인해 오류가 발생하면 무시. 3. 잘 모르겠어"
- 에이전트 피드백: 1은 맞다(컨테이너 10행, 10000, 오류 없음). 2는 비관적 락과 유니크 제약을 한 SQL에 넣었고 낙관적 락이 없다. 세 방법을 하나씩 비교하려고 (가) 비관적 = 적은 SQL 그대로(`COUNT(*) ... FOR UPDATE`, 표는 처음의 `KEY`), (다) 유니크 = 처음 SQL에 표만 `UNIQUE KEY idx_user_event (user_id, event_id)`로 나눠 돌리겠다고 물었다. `KEY UNIQUE`는 MySQL 문법으로 `UNIQUE KEY` 순서다.
- 사람의 답(원문): "의도한 SQL은 맞아. 둘을 같이 쓴 것도 실행해보자. UNIQUE KEY가 없으면 비관/낙관적 락은 rewards에 같은 키의 행이 10번 추가되는걸 막을 수 없는거 아니야? 정할 것 1. 맞아. 2. 1번에 해당해 낙관적 락 (요청) START TRANSACTION; SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1; INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); UPDATE points SET balance = balance + 1000 WHERE user_id = 7 and version = 0; COMMIT; 3. (가) supremum이 잠길거야. 그리고 balance + 1000 수정이 10번 실행될거야. insert도 10번 실행될거야. (나) insert가 10번 실행될거야. balance는 + 1000 한번만 실행될거야. (다) insert는 1번 실행될거야. balance + 1000 수정도 한 번 실행될거야." COUNT가 0이 아니면 `ROLLBACK`하고 "이미 받음", 1062면 `ROLLBACK`하고 "이미 받음"으로 정했다. (나)는 적은 SQL 그대로 돌렸다.
- 에이전트 피드백: 컨테이너에서 (가) 1행 / 1000, 1213 9건, (나) 10행 / 10000, 오류 없음, (다) 1행 / 1000, 1062 9건, (가)+(다) 1행 / 1000, 1213 9건, 1062 0건이었다. (다)는 2~10번째 `INSERT`가 첫 요청의 같은 키 때문에 기다렸다가 그 커밋 뒤 1062를 받았다. (나)는 아무도 version을 올리지 않아 10건이 모두 `version = 0`에 맞았다. (가)는 두 요청으로 줄여 `data_locks`를 보였다. 둘 다 `FOR UPDATE` 뒤 `idx_user_event`의 supremum pseudo-record에 `X` GRANTED, 먼저 `INSERT`한 쪽은 `X,INSERT_INTENTION` WAITING이었다. 아직 행이 없어 잠긴 것은 갭이고, 갭 락끼리는 충돌하지 않아 10건이 함께 보유하며, `INSERT`의 삽입 의도 락이 다른 요청들의 갭 락에 막혀 고리가 되어 InnoDB가 9건을 되돌렸다. 중복은 막았지만 줄을 세운 것이 아니라 데드락으로 막은 것이다. "UNIQUE가 없으면 못 막는다"는 반만 맞고, 무엇을 잠그고 무엇을 확인하느냐에 따라 유니크 제약 없이도 막을 수 있다고 답했다.
- 예상 적중(컨테이너 기준): 1은 3/3, 세 방법의 첫 판은 4/7((가)의 supremum, (나)의 10행, (다)의 행 수와 잔액).
- 이어서 낸 물음: (1) (가)를 데드락 없이 줄 세우려면 아직 없는 범위 대신 무엇을 잠그면 되는가(같은 사용자의 요청이 모두 거쳐 가는 이미 있는 행이라는 힌트) (2) (나)에서 10건이 모두 `version = 0`에 맞은 이유를 보고 SQL 고치기.
- 사람의 답(원문): "1. 모르겠어. 2. (요청) START TRANSACTION; SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1; INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); UPDATE points SET balance = balance + 1000 WHERE user_id = 7 and version = 0; UPDATE points SET version = version + 1 WHERE user_id = 7; COMMIT; 0행을 고치면 앱은 다른 동시 요청에 대한 세션은 무시한다." 에이전트가 points의 user 7 행이라는 힌트를 더 주자 사람이 "(가)는 원래 그렇게 고친거였잖아."라고 했고, 에이전트는 잠그는 표가 다르다고 설명했다. 처음 (가)는 아직 없는 rewards 범위의 갭을 잠가 10건이 함께 보유했고, points의 user 7 행은 이미 있어 그 배타 레코드 락을 한 번에 한 트랜잭션만 보유한다.
- 사람의 답(원문): "(요청) START TRANSACTION; SELECT balance FROM points WHERE user_id = 7 FOR UPDATE; SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1; INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); UPDATE points SET balance = balance + 1000 WHERE user_id = 7; COMMIT; * rewards 행 수: (가) 1 (나) 1 * 잔액: (가) 1000 (나) 1000 * 오류: 둘 다 없음"
- 에이전트 피드백: 컨테이너에서 (가) 고친 판은 1행 / 1000, 오류 없음(나머지 9건은 COUNT 1을 보고 "이미 받음"), (나) 고친 판은 1행 / 1000, 오류 없음(나머지 9건은 첫 `UPDATE`가 0행이라 `ROLLBACK`)이었다. 그때 (가)의 요청 시간을 중앙값 287ms·최대 520ms로 알리고 "10건이 user 7 행의 락을 하나씩 받아 COUNT 뒤 50ms를 쉬고 끝내 줄을 섰다"고 설명했는데, 이 시간은 컨테이너 임시 확인 틀이 "이미 받음" 확인 전에도 50ms를 쉬어 문제의 순서(확인 → 50ms → `INSERT`)와 다르게 잰 값이었다(2026-11-04 실행 틀을 짜며 찾음). 문제의 순서대로 짠 `burst_lab.py`의 컨테이너 작은 입력 검증에서는 (가) 고친 판의 요청 시간이 중앙값 58ms·최대 63ms였다.
- 예상 적중(컨테이너 기준): 6/6.
- 이어서 낸 짧은 물음과 답: (1) (가)에서 `FOR UPDATE`를 COUNT 다음으로 옮기면? 사람(원문): "1. 10행, 10000 / rewards 조회 결과 카운트가 0이니까 10개 세션 모두 balance update를 실행해서 결과적으로 잔액이 10000이 된다." 맞았다(컨테이너 10행, 10000, 2/2). 잠그기 전에 COUNT로 0을 받아 둔 채 줄을 섰다가 그 0을 믿고 지급했다(확인한 때와 쓰는 때 사이에 다른 요청이 끼어듦, time-of-check to time-of-use). 잠근 뒤 COUNT를 다시 해도 RR에서는 앞의 COUNT가 만든 스냅숏 때문에 0을 봐 10행이고 RC는 1행이라(둘 다 컨테이너 확인), 잠그는 문장이 트랜잭션의 첫 문장이어야 한다. 에이전트가 처음 준 스냅숏 힌트는 이 물음에는 필요 없었다고 바로잡았다. (2) (나)에서 처음 version이 3이면? 사람이 상수인지 물은 뒤 답했다(원문): "2는 그러면 10행이 되고 잔액은 10000이 되겠지." 빗나갔다(컨테이너 0행, 0, 0/2). 10건 모두 `version = 0`에 맞는 행이 없어 첫 `UPDATE`가 0행이고, 정한 대로 `ROLLBACK`하니 각자의 `INSERT`도 되돌려져 아무도 받지 못한다. 낙관적 락은 "내가 읽은 뒤로 아무도 안 바꿨으면 쓴다"라서 비교할 값은 처음에 읽은 version이어야 한다.
- 낙관적 락 최종판: 사람이 "UPDATE statement를 바꿔야하는거야? SELECT가 아니라?"라고 물어, 둘 다 바꾼다고 답했다. `SELECT`는 맨 앞에서 지금 version을 읽어 두기만 하고(v), 확인과 쓰기는 `UPDATE` 한 문장에서 한다. 확인을 `SELECT`로 따로 하면 방금 본 틈이 생기고, `UPDATE`는 그 행의 배타 락을 보유한 채 최신 행으로 `WHERE`를 따지므로 끼어들 틈이 없다. 사람의 답(원문): "UPDATE points SET version = version + 1 WHERE user_id = 7 AND version = v;" 맞다. 에이전트가 맞춰 보인 (나) 전체는 `START TRANSACTION` → `SELECT version FROM points WHERE user_id = 7`(v) → COUNT(0이 아니면 `ROLLBACK`, 이미 받음) → 50ms → `INSERT` → `UPDATE points SET version = version + 1 WHERE user_id = 7 AND version = v`(0행이면 `ROLLBACK`) → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7` → `COMMIT`이다. 0행일 때 다시 할지는 사람이 "모르겠어"라고 해서, 한 요청을 따라가 보인 뒤 "0행이면 `ROLLBACK`하고 처음부터 다시, 최대 3번"으로 정했다(에이전트 추천). 0행은 읽은 뒤 누군가 바꿨다는 것만 알려 주므로 다시 해 봐야 이미 받았는지 안다. 그때 알린 컨테이너 값 "다시 하면 약 110ms"도 위와 같은 이유로 문제의 순서와 다르게 잰 값이며, `burst_lab.py`의 작은 입력 검증에서는 중앙값 60ms·최대 64ms였다. 이 물음은 예상이 없어 셈에서 뺐다.
- 맥에서 돌릴 판(정함): 막지 않음(`reward-plain`) / (가) 처음 판(`reward-count-lock`) / (가) 고친 판(`reward-parent-lock`) / (나) 최종판(`reward-version`) / (다) 유니크 제약(`reward-unique`) / (가)+(다)(`reward-count-lock-unique`). 모두 REPEATABLE READ, 같은 요청 10건 동시, COUNT 뒤 50ms다.
- 확인한 부분: 아직 없는 범위를 잠그면 supremum이 잠긴다는 것은 1-1·1-2를 옮겨 혼자 맞혔다. 갭 락끼리 함께 보유할 수 있다는 것과 묶음 ②의 고리를 이어 붙이지는 못했다. 비관적 락을 이미 있는 행에 걸어야 한다는 것은 힌트 두 번을 받은 뒤 썼고 잠그는 문장을 맨 앞에 두었다. 낙관적 락은 version을 상수로 박아 두었다가 피드백 뒤 처음에 읽은 값으로 고쳤다. 상수로 쓴 것은 학습 확인에서 다시 묻는다.

### 문제 상황 4: 커넥션 풀보다 많이 몰린 요청 (2026-11-04)

- 장면: 웹 서버가 SQLAlchemy `QueuePool`로 MySQL에 붙어 있다(직접 만든 풀 대신 실제 서비스에서 흔히 쓰는 쪽으로 정함, 에이전트 추천). 요청 50개가 같은 순간에 들어오고, 요청마다 풀에서 연결을 빌려(`with engine.connect() as conn:`) 트랜잭션을 연 채(`with conn.begin():`) `SELECT 1` 뒤 200ms를 쓰고(트랜잭션 안에서 외부 API 응답을 기다리는 셈) 커밋하고 돌려준다. `max_overflow=0`이라 `pool_size`보다 더 만들지 않고, `pool_timeout`을 넘게 기다리면 오류이며, 풀의 연결은 미리 다 만들어 둔 상태에서 시작한다.
- 물은 것: (1) `pool_size=5`, `pool_timeout=30`초일 때 50건이 다 끝나는 시간과 가장 오래 기다린 요청이 연결을 받기까지 기다린 시간 (2) `pool_size` 10, 50일 때 같은 두 값 (3) `pool_size=5`, `pool_timeout=0.5`초일 때 풀 타임아웃 오류 수 (4) 풀 없이 요청마다 새로 연결하고 끝나면 끊을 때 (가) 한 건씩 차례로 할 때 연결을 얻는 시간이 풀에서 빌릴 때의 몇 배쯤인지 (나) 50건을 동시에 보내면 다 끝나는 시간이 (1)의 풀 5보다 긴지 짧은지. 이유도.
- 사람의 예상과 이유(원문, 메시지에서는 번호마다 줄을 바꿈): "1. 2초, 1.8초 / 0.2초마다 5개의 요청이 처리되기 때문에 50개의 요청은 2초만에 처리됨. 그리고 2초가 되면 끝나기 때문에 연결을 받고 바로 작업을 시작한다는 가정 하에 2초의 0.2초 전이 1.8초에 마지막 5개 작업이 연결을 받아서 작업을 시작함. 그래서 가장 오래 기다린 요청이 연결을 받기까지 기다린 시간은 50개가 동시에 연결을 요청하고 나서부터 1.8초 후임. 2. 1초, 0.8초 3. 35건 / 0.2초에 첫 다섯 요청이 처리되고 0.4초에 두번째 다섯 요청이 처리되고 0.4초에 세번째 다섯 요청이 시작됨. 그리고 세번째 다섯 요청이 끝난 0.6초가되면 이미 나머지 35개의 요청의 pool timeout인 0.5초가 지나서 타임아웃 오류로 끝나있음. 4. (가) 모름. 측정해본 적 없음. (나) 연결 개수에 제한이 없다면 더 빨리 끝날 수도 있지만 연결 개수 제한에 따라 달라질 듯함." 틀렸다고 볼 조건은 적지 않았다.
- 에이전트 피드백: 컨테이너에서 풀 5는 2.03초에 다 끝나고 가장 오래 기다린 요청이 1.82초, 풀 10은 1.02초와 0.81초, 풀 50은 0.22초와 0초였다. 풀 5·타임아웃 0.5초는 35건이 타임아웃이었고 이유도 적은 그대로다. 4(가)는 한 건씩 차례로 할 때 새 연결 + `SELECT 1`이 6.3ms, 풀에서 빌리기 + `SELECT 1`이 0.09ms로 약 70배였다. 새 연결은 매번 TCP 연결, MySQL 인증 주고받기(handshake), 서버의 세션 준비를 거치고, 풀은 이미 열린 연결을 넘겨받기만 한다. 4(나)는 풀 없이 50건 동시가 0.40~0.45초로 풀 5보다 짧았다(연결 얻기에 0.06~0.22초). 조건으로 든 연결 수 제한은 MySQL `max_connections`(기본값 151, 컨테이너에서 151 확인)이고 50건에는 걸리지 않아 맞힌 것으로 셌다. 이 한도를 넘으면 기다리지 않고 바로 1040(Too many connections) 오류가 난다. 다 끝나는 시간은 대략 (요청 수 ÷ 풀 크기) × 트랜잭션 시간이다. 풀을 키우면 빨라지지만 DB에 열린 연결이 늘고, 서버가 여러 대면 풀 크기의 합이 `max_connections` 안에 들어야 한다. 트랜잭션 안에서 외부 API를 기다리는 200ms를 줄이면 같은 풀로도 빨라진다.
- 예상 적중(컨테이너 기준): 6/6(1의 두 값, 2의 풀 10 두 값, 3, 4(나)). 풀 50(적지 않음)과 4(가)("모름")는 셈에서 뺐다.
- 확인한 부분: 풀 크기와 트랜잭션 시간으로 다 끝나는 시간, 가장 오래 기다린 시간, 타임아웃 수를 혼자 계산했다. 새 연결 비용은 재 본 적이 없어 몰랐다.

### 예상 적중 (컨테이너 기준 잠정)

| 묶음 | 문제 상황 | 맞힌 예상 / 적은 예상 |
|---|---|---|
| ① | 1 잠근 응모 사이의 새 응모 | 7/10 |
| ① | 1-1 인덱스가 없을 때 | 3/6 |
| ① | 1-2 03의 1.74초 | 1/2 |
| ② | 2 반대로 보낸 두 이체 | 2/6 |
| ② | 2 이어서: 락 순서 고정 | 1/1 |
| ② | 2-1 동시에 몰린 차감 10건 | 5/6 |
| ③ | 3 막지 않은 지급 | 3/3 |
| ③ | 3 세 방법의 첫 판 | 4/7 |
| ③ | 3 고친 판 (가)(나) | 6/6 |
| ③ | 3 이어서: `FOR UPDATE`를 COUNT 뒤로 | 2/2 |
| ③ | 3 이어서: 처음 version 3 | 0/2 |
| ④ | 4 풀보다 많이 몰린 요청 | 6/6 |
| | 합 | 40/57 |

맥 본 측정으로 다시 세어도 칸마다 같아 40/57이다([결과 정리](#결과-정리)).

## 순서표 실행 규칙

묶음 ①②의 순서표(문제 상황 1·1-1·1-2·2)와 묶음 ③ (가) 처음 판을 두 요청으로 줄인 순서표는 아래 규칙으로 실행한다. 03 실험의 [순서표 실행 규칙](../03-mysql-isolation-mvcc/README.md#순서표-실행-규칙)과 같고, 표의 아래 다섯 줄(지연~끝난 뒤)을 더했다.

| 항목 | 규칙 |
|---|---|
| 순서표 | [`python/lock_timelines.py`](python/lock_timelines.py)에 단계(세션, SQL)를 적힌 순서대로 둔다. 실행마다 준비 SQL로 표를 새로 만든다. 단계 번호는 `START TRANSACTION`까지 센 실행 순서이고, 문제 상황의 번호(1번, 2번 …)는 단계의 메모에 적었다. |
| 세션 | 세션마다 연결 하나와 스레드 하나를 쓴다. 연결은 자동 커밋으로 열고, 트랜잭션은 순서표의 `START TRANSACTION`과 `COMMIT`으로 열고 닫는다. 격리 수준은 조건마다 두 세션에 같게 건다. 이와 따로 관찰용 연결 하나가 락 읽기, 데드락 탐지 설정, 끝난 뒤 표 읽기를 맡는다. |
| 기다림 | 단계를 넣고 0.5초 안에 끝나지 않으면 기다림으로 기록하고 다음 단계로 넘어간다. 단계를 넣을 때마다 0.3초 동안 기다리던 단계가 끝나는지 보고, 끝났으면 그 단계 뒤에 끝난 것으로 남긴다. |
| 미룸 | 기다리는 세션의 다음 단계는 미뤄 두었다가 그 세션의 앞 단계가 끝나면 바로 넣는다. 앞 단계가 오류로 끝나도 다음 단계를 그대로 넣는다(오류를 확인하지 않는 앱). |
| 락 대기 | `innodb_lock_wait_timeout`을 5초로 건다. 15초가 지나도 끝나지 않으면 서버에서 취소하고 실행 오류로 본다. |
| 지연 | `delay_s`가 있는 단계는 앞 단계를 보낸 때부터 그만큼 지난 뒤 보내고, 그동안 풀린 단계도 모은다. 문제 상황 2의 4번(3번 2초 뒤)에만 쓴다. 미룬 단계에는 쓰지 않는다. |
| 락 읽기 | `snapshot` 단계는 보낸 직후(끝났거나 기다림으로 기록한 뒤) 관찰용 연결로 `performance_schema.data_locks`(스키마 `lab`)와 `data_lock_waits`를 읽어, 연결 번호(`PROCESSLIST_ID`)를 세션 이름으로 바꿔 남긴다. 읽는 몇 ms만큼 다음 단계를 늦게 보낸다. |
| 데드락 탐지 | 조건마다 `SET GLOBAL innodb_deadlock_detect`를 걸고, 끝나거나 중간에 실패해도 처음 값으로 되돌린다. 서버 전체 설정이라 다른 측정과 동시에 돌리지 않는다. |
| 데드락 보고 | 실행 전후 `SHOW ENGINE INNODB STATUS`의 LATEST DETECTED DEADLOCK 부분을 읽어, 달라졌으면 그 실행의 데드락으로 보고 원문과 뽑은 값(되돌린 트랜잭션, 트랜잭션마다 세션·문장·보유한 락·기다린 락)을 남긴다. |
| 끝난 뒤 | 두 세션을 `ROLLBACK`하고 닫은 뒤 관찰용 연결로 순서표의 `final` SQL을 읽어 표의 마지막 상태를 남긴다. |
| 제대로 돈 실행 | 모든 단계가 끝났고(`ok` 또는 `error`), 데드락 탐지가 바라던 값으로 걸렸다가 처음 값으로 돌아왔으면 제대로 돈 실행으로 본다. 아니면 실행 오류로 멈춘다. |
| 반복 | 조건(순서표·격리 수준·데드락 탐지)마다 워밍업 1회(`run: 0`)와 본 측정 3회를 하고, 반복할 때 조건 순서를 뒤집는다. |

| 순서표 | 문제 상황 | 격리 수준 | 데드락 탐지 |
|---|---|---|---|
| `idx-insert-user7`, `idx-insert-user5`, `idx-insert-user10`, `idx-insert-user15`, `idx-insert-user1` | 1의 (가)~(마) | RR, RC | ON |
| `noidx-insert-user7`, `noidx-insert-user15`, `noidx-delete-id1` | 1-1의 (가)~(다) | RR, RC | ON |
| `serializable-insert` | 1-2(03 `entries-rows`와 같은 표와 단계) | SERIALIZABLE | ON |
| `transfer-reverse` | 2 | RR | ON, OFF |
| `transfer-ordered` | 2 이어서(B도 작은 id부터) | RR | ON, OFF |
| `reward-count-lock-pair` | 3 (가) 처음 판을 두 요청으로 줄임. A·B가 차례로 `COUNT(*) ... FOR UPDATE` 뒤 `INSERT`, 50ms와 잔액 `UPDATE`는 뺌 | RR | ON |

## 동시 요청 측정 규칙

문제 상황 2-1과 묶음 ③은 아래 규칙으로 잰다.

| 항목 | 규칙 |
|---|---|
| 장면 | [`python/burst_lab.py`](python/burst_lab.py)의 `SCENES`에 있다. 실행마다 준비 SQL로 표를 새로 만든다. |
| 요청 | 요청마다 연결 하나와 스레드 하나를 쓴다. 연결을 열고 격리 수준과 `innodb_lock_wait_timeout` 5초를 건 뒤 `Barrier`로 같은 순간에 출발하므로, 연결을 여는 시간은 요청 시간에 넣지 않는다. 요청 수는 10이다. |
| 앱 시간 | 읽은 뒤 쓰기 전에 앱이 50ms 일한다. 2-1은 `SELECT` 뒤, ③은 COUNT로 이미 받았는지 확인한 뒤 `INSERT` 전이다. 이미 받았으면 50ms를 쓰지 않고 바로 `ROLLBACK`한다. |
| 다시 시도 | `reward-version`만 version 확인이 0행이면 `ROLLBACK`하고 처음부터 최대 3번 다시 한다. `reward-version-const`·`-v3`는 잔액 `UPDATE`가 0행이면 `ROLLBACK`하고 다시 하지 않는다(사람이 쓴 판). DB 오류(1213, 1205 등)를 받은 요청은 `ROLLBACK`하고 실패로 끝내며 다시 하지 않는다. 유니크 제약 판의 1062는 앱이 처리해 `ROLLBACK`하고 "이미 받음"으로 끝내며, 오류 수에는 센다. |
| 남기는 값 | 요청마다 결과(`granted` 지급, `already` 이미 받음, `done` 차감, `error` DB 오류, `gave-up` 0행으로 되돌린 뒤 더 다시 하지 않음, `unpaid` 잔액을 못 올린 채 행만 커밋)와 시도마다의 오류 번호·걸린 시간, 실행마다 결과별 수, 오류 번호별 수, 다시 시도 수, 요청 시간 중앙값·최댓값, 요청이 출발한 시각의 차이, 끝난 뒤 표의 값(③은 rewards 행 수·잔액·version, 2-1은 잔액)이다. |
| 제대로 돈 실행 | 10건이 모두 끝났고 실행 틀 오류가 없으면 제대로 돈 실행으로 본다. ③은 rewards 행 수가 `granted`와 `unpaid`의 합과 같고 잔액이 1000 × `granted`여야 한다(지급마다 행 하나와 1000을 한 트랜잭션으로 남기므로). 아니면 실행 오류로 멈춘다. |
| 반복 | 조건(장면·격리 수준)마다 워밍업 1회와 본 측정 3회를 하고, 반복할 때 조건 순서를 뒤집는다. 데드락 탐지가 켜져 있어야 하며, 꺼져 있으면 돌리지 않는다. |

| 장면 | 문제 상황 | 요청 |
|---|---|---|
| `deduct` | 2-1 (RC, RR, SERIALIZABLE) | `START TRANSACTION` → `SELECT balance FROM points WHERE user_id = 7` → 50ms → `UPDATE points SET balance = <읽은 값 - 100> WHERE user_id = 7` → `COMMIT` |
| `reward-plain` | 3 막지 않음 | `START TRANSACTION` → COUNT(0이 아니면 `ROLLBACK`, 이미 받음) → 50ms → `INSERT` → `UPDATE points SET balance = balance + 1000 WHERE user_id = 7` → `COMMIT` |
| `reward-count-lock` | 3 (가) 처음 판 | COUNT를 `SELECT COUNT(*) ... FOR UPDATE`로 |
| `reward-parent-lock` | 3 (가) 고친 판 | 첫 문장으로 `SELECT balance FROM points WHERE user_id = 7 FOR UPDATE` |
| `reward-version` | 3 (나) 최종판 | `SELECT version FROM points WHERE user_id = 7`(v) → COUNT → 50ms → `INSERT` → `UPDATE points SET version = version + 1 WHERE user_id = 7 AND version = v`(0행이면 `ROLLBACK`, 처음부터 최대 3번) → 잔액 `UPDATE` → `COMMIT` |
| `reward-unique` | 3 (다) | 표를 `UNIQUE KEY idx_user_event (user_id, event_id)`로, `INSERT`가 1062면 `ROLLBACK`(이미 받음) |
| `reward-count-lock-unique` | 3 (가)+(다) | `COUNT(*) ... FOR UPDATE`와 `UNIQUE KEY`, 1062면 `ROLLBACK` |
| `reward-version-first` | 3 (나) 첫 판 | `INSERT` 뒤 `UPDATE points SET balance = balance + 1000 WHERE user_id = 7 AND version = 0` → `COMMIT`(0행이어도 커밋) |
| `reward-version-const` | 3 (나) 고친 판 | `INSERT` 뒤 위의 잔액 `UPDATE`(0행이면 `ROLLBACK`) → `UPDATE points SET version = version + 1 WHERE user_id = 7` → `COMMIT` |
| `reward-version-const-v3` | 3 이어서: 처음 version 3 | `reward-version-const`와 같고 points의 처음 version만 3 |
| `reward-lock-after-count` | 3 이어서: `FOR UPDATE`를 COUNT 다음으로 | `START TRANSACTION` → COUNT → `SELECT balance FROM points WHERE user_id = 7 FOR UPDATE` → (COUNT가 0이 아니면 `ROLLBACK`) → 50ms → `INSERT` → 잔액 `UPDATE` → `COMMIT` |

③은 모두 REPEATABLE READ에서 돌린다. 아래 넷은 처음 맥 본 측정(앞의 여섯 판)을 마친 뒤, 예상을 받았지만 맥에서 재지 않은 칸을 재려고 더했다.

## 커넥션 풀 측정 규칙

묶음 ④(문제 상황 4)는 아래 규칙으로 잰다.

| 항목 | 규칙 |
|---|---|
| 풀 | [`python/pool_lab.py`](python/pool_lab.py)의 `CASES`에 있다. SQLAlchemy 2.1.8 `QueuePool`(`pool_size` 5·10·50, `max_overflow=0`, `pool_timeout` 30초·0.5초)과 `NullPool`(요청마다 새로 연결하고 돌려줄 때 끊음), 드라이버는 PyMySQL 1.2.3이다. |
| 미리 데우기 | `QueuePool`은 `pool_size`개 연결을 만들어 두고 시작한다. `NullPool`도 한 번 연결해 SQLAlchemy가 엔진의 첫 연결에서 하는 초기화를 측정 밖으로 뺀다. |
| 요청 | 50개 스레드가 `Barrier`로 같은 순간에 출발해, 연결을 빌리고(`engine.connect()`) 트랜잭션 안에서 `SELECT 1` 뒤 200ms를 쓰고 커밋한 뒤 돌려준다. 연결 기다림은 `connect()`를 부른 때부터 받은 때까지, 다 끝나는 시간은 가장 먼저 출발한 요청부터 가장 늦게 끝난 요청까지다. 풀 타임아웃(`sqlalchemy.exc.TimeoutError`)은 그 요청의 결과로 센다. |
| 한 건씩 | `connect-null`은 `NullPool`로 200번 차례로 새로 연결해 `SELECT 1`을 하고, `checkout-queue`는 미리 데운 `QueuePool`(연결 1개)에서 200번 빌려 `SELECT 1`을 한다. 연결을 닫거나 돌려주는 시간은 넣지 않는다. |
| 서버 쪽 | 실행 직전에 `FLUSH STATUS`로 `Max_used_connections`를 지금 열린 연결 수로 되돌리고, 실행 뒤 그 값(관찰용 연결 1개 포함)과 `Connections` 증가분(새로 연 연결 수)을 남긴다. |
| 제대로 돈 실행 | 50건이 모두 성공이나 풀 타임아웃으로 끝났고 다른 오류가 없으며, `QueuePool`은 끝난 뒤 빌려 간 연결이 0이면 제대로 돈 실행으로 본다. 아니면 실행 오류로 멈춘다. |
| 해석 범위 | DB가 같은 맥의 Docker Desktop 컨테이너라 새 연결 비용(네트워크 왕복)은 실제 서버와 다르다. 숫자는 이 맥에서의 값으로만 말한다. |
| 반복 | 조건마다 워밍업 1회와 본 측정 3회를 하고, 반복할 때 조건 순서를 뒤집는다. |

## 실행 방법

DB는 저장소 루트의 [`infra/compose.yaml`](../../infra/compose.yaml)로 띄운다(03과 같음). MySQL은 `127.0.0.1:13306`에서 받는다.

```sh
docker compose -f infra/compose.yaml up -d --wait   # 저장소 루트에서 띄우기
docker compose -f infra/compose.yaml down -v        # 끄고 데이터 지우기
```

| 파일 | 역할 |
|---|---|
| [lock_timelines.py](python/lock_timelines.py) | 묶음 ①②의 순서표(문제 상황 1·1-1·1-2·2와 락 순서 고정판)와 묶음 ③ (가) 처음 판을 두 요청으로 줄인 순서표(에이전트 작성) |
| [lock_lab.py](python/lock_lab.py) | 두 세션 실행, 값·기다림·오류·락·데드락 보고 기록, 데드락 탐지 설정과 되돌리기, 반복, 환경·원자료 저장과 요약. 03 `isolation_lab.py`의 실행 규칙을 MySQL만 쓰도록 옮기고 더했다 |
| [test_lock_lab.py](python/test_lock_lab.py) | 가짜 DB로 값·기다림·미룸·지연·락 읽기·데드락 보고 읽기·탐지 설정 되돌리기를 검사 |
| [burst_lab.py](python/burst_lab.py) | 문제 상황 2-1과 묶음 ③의 요청(③의 막는 SQL은 사람이 쓴 판)과 동시 실행, 다시 시도, 결과·오류 집계, 표 검사, 환경·원자료 저장과 요약 |
| [test_burst_lab.py](python/test_burst_lab.py) | 가짜 DB로 요청마다 보내는 SQL, 1062 처리, 다시 시도 상한, DB 오류와 실행 틀 오류 구분, 표 검사를 검사 |
| [pool_lab.py](python/pool_lab.py) | 묶음 ④의 풀 조건과 측정. 동시 요청, 한 건씩 연결 얻기, 서버가 본 연결 수, 환경·원자료 저장과 요약 |
| [test_pool_lab.py](python/test_pool_lab.py) | DB와 SQLAlchemy 없이 가짜 풀로 연결 기다림·풀 타임아웃·다 끝나는 시간과 백분위를 검사 |
| [lab_env.py](../../tools/lab_env.py) | 측정 환경 기록(03과 같은 공용 코드) |

이 실험 폴더에서 실행한다.

```sh
cd experiments/04-mysql-locks-deadlocks-pool
uv run --python 3.14.2+gil python -m unittest discover -s python -p 'test_*.py' -v
uv run --python 3.14.2+gil python/lock_lab.py --smoke
uv run --python 3.14.2+gil python/lock_lab.py
uv run --python 3.14.2+gil python/burst_lab.py --smoke
uv run --python 3.14.2+gil python/burst_lab.py
uv run --python 3.14.2+gil python/pool_lab.py --smoke
uv run --python 3.14.2+gil python/pool_lab.py
```

`--smoke`는 조건마다 워밍업 1회와 검증 2회만 돌려 `results/validation/`에 저장하며, 가설 판단에 쓰지 않는다. `--timelines`(묶음 ①②), `--scenes`(2-1과 ③), `--cases`(④), `--trials`, `--requests`, `--mysql`로 조건과 주소를 바꿀 수 있다. 세 실행 틀은 서버 설정을 바꾸거나(`innodb_deadlock_detect`, `FLUSH STATUS`) 같은 표를 쓰므로 하나씩 돌린다. 의존성(PyMySQL 1.2.3, SQLAlchemy 2.1.8)은 스크립트 머리의 PEP 723 블록과 [`lock_lab.py.lock`](python/lock_lab.py.lock), [`burst_lab.py.lock`](python/burst_lab.py.lock), [`pool_lab.py.lock`](python/pool_lab.py.lock)에 고정했다. `3.14.2+gil`은 03과 같이 GIL이 있는 일반 빌드를 고르라는 uv 요청이다.

결과는 실행 한 번을 JSON 한 줄로 남긴다. 공통 필드에 더해 실행 틀마다 아래를 쓴다.

순서표(`lock_lab.py`): `timeline`, `db`, `db_version`, `isolation`, `deadlock_detect`(걸려던 값), `deadlock_detect_applied`·`deadlock_detect_restored`(실제로 걸린 값과 되돌린 값), `session_ids`(세션 이름과 연결 번호), `steps`, `deadlock`, `final_rows`. `check`는 끝난 단계 수, `expected_check`는 단계 수다. `steps`의 원소는 03의 필드(`step`, `session`, `sql`, `note`, `blocked`, `deferred`, `sent_after_step`, `sent_at_s`, `finished_after_step`, `outcome`, `rows`, `rowcount`, `error`, `elapsed_s`)에 아래를 더했다.

| 필드 | 뜻 |
|---|---|
| `delay_s` | 앞 단계를 보낸 때부터 기다렸다 보낸 시간(초) |
| `snapshot`, `locks`, `snapshot_at_s` | 보낸 직후 락을 읽었는지, 읽은 락(`locks`: 세션·표·인덱스·종류·모드·상태·`LOCK_DATA`, `waits`: 기다리는 세션과 락, 막고 있는 세션과 락), 읽은 때(실행 시작부터 초) |

`deadlock`은 그 실행에서 새로 생긴 데드락이 없으면 `null`이고, 있으면 `detected_at`, `rolled_back`(되돌린 트랜잭션 번호), `rolled_back_session`, `transactions`(번호마다 `session`, `thread_id`, `query`, `holds`·`waiting`: 인덱스·표·모드·레코드의 첫 칸 값), `report`(LATEST DETECTED DEADLOCK 원문)다.

동시 요청(`burst_lab.py`): `scene`, `note`, `isolation`, `summary`(`results`, `errors`, `retries`, `request_s_median`, `request_s_max`, `start_spread_s`, ③은 `rewards`·`balance`·`version`, 2-1은 `balance`), `requests`(요청마다 `request`, `result`, `attempts`, `retries`, `elapsed_s`, `started_at_s`), `final_rows`, `failures`, `hung`. `check`는 끝난 요청 수, `expected_check`는 요청 수다.

풀(`pool_lab.py`): `case`, `kind`(`burst` 또는 `sequential`), `sqlalchemy`, `summary`(동시 요청은 `ok`, `timeout`, `wait_s`·`timeout_after_s`의 `median`·`p95`·`min`·`max`, `start_spread_s`, 한 건씩은 `seconds`), `requests` 또는 `samples_s`, `server`(`before`, `after`, `new_connections`, `peak_connections`), `checked_out_after`. 동시 요청의 `check`는 끝난 요청 수, 한 건씩의 `check`는 잰 횟수다. 백분위는 가장 가까운 순위 방식으로 잰 값 하나를 고른다.

환경 파일에는 공통 항목에 더해 DB 버전과 주요 설정(`databases`), 띄운 이미지(`docker_images`)를 남기고, 풀 측정은 SQLAlchemy 버전도 남긴다.

## 결과 정리

### 측정 환경과 원자료 (2026-11-04)

Apple M2 Pro(성능 코어 8개·효율 코어 4개), macOS 26.5의 Docker Desktop에 MySQL 8.4.13을 띄우고(이미지 `linux/arm64/v8`, `docker compose images`의 ID `a0225d1ea663`), 2026-11-04 16:39~17:03(KST)에 실행 파일을 [실행 방법](#실행-방법)의 순서대로 하나씩 돌렸다. Python은 uv 0.12.5가 고른 CPython 3.14.2 일반 빌드(GIL 켜짐)다. 묶음 ④의 예상까지 받은 뒤 에이전트가 맥에 연 원격 Claude Code 세션이 실행했고, 측정하는 동안 그 세션이 함께 떠 있었다. 전원은 연결된 상태였고 배터리는 모든 환경 파일에서 80%(충전 안 함)였다. 코드는 커밋 `04cae9a` 위의 커밋하지 않은 상태였다.

실행은 세 번에 나눠 했다. (1) 16:39~16:43에 자동 검사 35개가 통과하고 `--smoke` 셋이 실행 오류 없이 끝난 뒤, 본 실행 셋(순서표 21개 조건, 동시 요청 9개 조건, 풀 7경우)을 돌렸다. (2) 결과를 정리하다 ③에서 예상을 받았지만 맥에서 재지 않은 칸 10개를 찾아, 동시 요청 판 넷과 순서표 하나를 더했다([동시 요청 측정 규칙](#동시-요청-측정-규칙)의 아래 네 판과 `reward-count-lock-pair`). 16:58~16:59에 자동 검사 39개가 통과한 뒤 더한 조건만 `--smoke`와 본 실행으로 돌렸다. (3) 더하면서 `lock_timelines.py`와 `burst_lab.py`가 바뀌어, 커밋할 코드로 두 실행 파일의 전체 조건을 17:00~17:03에 `--smoke`와 본 실행으로 다시 돌렸다. 풀은 코드가 그대로라 다시 돌리지 않았다. 아래 표의 순서표와 동시 요청 값은 (3), 풀 값은 (1)이다. 이 세 파일의 환경 파일에 남은 소스 sha256은 이 README와 함께 커밋한 코드와 같다.

| 실행 파일 | 묶음 | 조건 × 반복 | 환경 | 원자료 |
|---|---|---|---|---|
| `lock_lab.py` | ①②, ③ 두 요청 | 22 × (워밍업 1 + 3) | [환경](results/2026-11-04T170113049668-locks-env.txt) | [JSONL](results/2026-11-04T170113049668-locks-python-3.14.2.jsonl) |
| `burst_lab.py` | 2-1, ③ | 13 × (1 + 3) | [환경](results/2026-11-04T170237309105-burst-env.txt) | [JSONL](results/2026-11-04T170237309105-burst-python-3.14.2.jsonl) |
| `pool_lab.py` | ④ | 7 × (1 + 3) | [환경](results/2026-11-04T164215794556-pool-env.txt) | [JSONL](results/2026-11-04T164215794556-pool-python-3.14.2.jsonl) |

(1)·(2)의 순서표와 동시 요청 파일(`2026-11-04T164056160332-locks`, `2026-11-04T164210463469-burst`, `2026-11-04T165914436903-locks`, `2026-11-04T165925835877-burst`)도 `results/`에 남겼다. 둘을 합하면 (3)의 조건을 모두 한 번씩 돌린 셈이고, 조건마다 순서표의 행·기다림·오류·락·끝난 뒤 값·되돌려진 세션과 동시 요청의 결과별 수·오류·다시 시도 수·끝난 뒤 값이 (3)과 같았다. 본 실행의 기록은 모두 검증(`valid`)을 통과했고 실행 오류는 없었으며, 조건마다 워밍업을 포함한 네 번이 같은 행·기다림·오류·락·끝난 뒤 값을 돌려줬다. 실행이 끝난 뒤 `innodb_deadlock_detect`는 1(ON), `max_connections`는 151이었다. 아래 시간은 워밍업을 뺀 세 번의 최솟값~최댓값이다.

판정은 시작 전 기록의 예상대로 했다. 맥 본 측정의 행·기다림·오류·락·최종 값은 칸마다 컨테이너 임시 확인과 같아, 판정도 칸마다 같다. 03의 31/63(49%)보다 높은 40/57(70%)이다.

| 묶음 | 문제 상황 | 적중 | 빗나감 | 판정에서 뺀 칸 |
|---|---|---:|---:|---|
| ① | 1, 1-1, 1-2 | 11 | 7 | |
| ② | 2, 2 이어서, 2-1 | 8 | 5 | 2의 오류 이름과 기다린 시간(모른다고 답함) |
| ③ | 3과 이어서 낸 물음 둘 | 15 | 5 | |
| ④ | 4 | 6 | 0 | 풀 50(적지 않음), 4(가)(모른다고 답함) |
| 합계 | | 40 | 17 | |

### 묶음 ①: 잠근 범위 사이의 삽입과 삭제 (조건마다 3회)

B가 기다린 단계는 모두 A의 `COMMIT` 직후 끝났다. 기다린 시간은 실행 틀이 기다림을 기록하고(0.5초) 락을 읽은 뒤 A의 `COMMIT`을 보내기까지의 시간이라, 얼마나 기다렸는지보다 기다렸는지가 결과다.

| 문제 상황 | 칸 | 예상 | 측정 | 판단 |
|---|---|---|---|---|
| 1 | REPEATABLE READ (가) user 7 | 바로 끝남 | A의 `COMMIT`까지 기다림(0.82~0.83초) | 빗나감 |
| 1 | REPEATABLE READ (나) user 5 | 바로 끝남 | 기다림(0.81~0.83초) | 빗나감 |
| 1 | REPEATABLE READ (다) user 10 | 바로 끝남 | 기다림(0.82~0.83초) | 빗나감 |
| 1 | REPEATABLE READ (라) user 15, (마) user 1 | 바로 끝남, 바로 끝남 | 바로 끝남, 바로 끝남 | 적중, 적중 |
| 1 | READ COMMITTED (가)~(마) | 다섯 모두 바로 끝남 | 다섯 모두 바로 끝남 | 적중 ×5 |
| 1-1 | REPEATABLE READ (가) user 7, (나) user 15, (다) id 1 삭제 | 셋 모두 바로 끝남 | 셋 모두 A의 `COMMIT`까지 기다림(0.82~0.83초) | 빗나감 ×3 |
| 1-1 | READ COMMITTED (가)~(다) | 셋 모두 바로 끝남 | 셋 모두 바로 끝남 | 적중 ×3 |
| 1-2 | (1) A가 보유한 락 | 세 행과 supremum 모두 넥스트 키 락 | `PRIMARY`에 `S` 1, 2, 3, supremum pseudo-record(넥스트 키 락, 모드는 공유) | 적중 |
| 1-2 | (2) B의 `INSERT`를 막은 락 | (2, 7)과 (3, 8) 사이 갭의 넥스트 키 락 | supremum의 넥스트 키 락(B는 supremum에 `X,INSERT_INTENTION` WAITING) | 빗나감 |

1-2에서 B의 `INSERT`는 1.74~1.75초 기다렸다(03 맥 측정 1.74~1.75초). 끝난 뒤 표는 경우마다 B의 문장이 반영된 상태였다.

B가 문장을 보낸 직후 읽은 `data_locks`다. 표 락(`IX`, `IS`)은 뺐고, `idx_user`의 값은 (user_id, id)다. 세 번 모두 같았다.

| 순서표 | A가 보유한 락 | B가 기다린 락 |
|---|---|---|
| 1, REPEATABLE READ | `idx_user`에 `X` (7, 2)·(7, 3), `X,GAP` (12, 4). `PRIMARY`에 `X,REC_NOT_GAP` 2·3 | (가)·(다) `idx_user` (12, 4)에 `X,GAP,INSERT_INTENTION`, (나) `idx_user` (7, 2)에 `X,GAP,INSERT_INTENTION`, (라)·(마) 없음 |
| 1, READ COMMITTED | `idx_user`에 `X,REC_NOT_GAP` (7, 2)·(7, 3). `PRIMARY`에 `X,REC_NOT_GAP` 2·3 | 없음 |
| 1-1, REPEATABLE READ | `PRIMARY`에 `X` 1·2·3·4·supremum pseudo-record | (가)·(나) supremum에 `X,INSERT_INTENTION`, (다) `PRIMARY` 1에 `X,REC_NOT_GAP` |
| 1-1, READ COMMITTED | `PRIMARY`에 `X,REC_NOT_GAP` 2·3 | 없음 |
| 1-2, SERIALIZABLE | `PRIMARY`에 `S` 1·2·3·supremum pseudo-record | supremum에 `X,INSERT_INTENTION` |

### 묶음 ②: 반대로 보낸 두 이체와 락 순서 (조건마다 3회)

| 문제 상황 | 칸 | 예상 | 측정 | 판단 |
|---|---|---|---|---|
| 2 | (가) 탐지 켬, 3번 | 오류 | 4번까지 2.01초 기다렸다가 끝남 | 빗나감 |
| 2 | (가) 탐지 켬, 4번 | 오류 | 바로 1213, B의 트랜잭션 전체가 되돌려짐 | 적중 |
| 2 | (가) 잔액 | 1000, 1000 | 900, 1100 | 빗나감 |
| 2 | (나) 탐지 끔, 3번 | 기다렸다가 끝남 | 5.03~5.04초 기다린 뒤 1205 | 빗나감 |
| 2 | (나) 탐지 끔, 4번 | 기다렸다가 끝남 | A의 `COMMIT` 직후 끝남(3.33~3.34초) | 적중 |
| 2 | (나) 잔액 | 900, 1000 | 1000, 900 | 빗나감 |
| 2 이어서 | B도 작은 id부터 | B의 첫 문장이 A의 커밋까지 기다렸다가 끝나고 데드락 없음 | 탐지 켬·끔 모두 B의 첫 `UPDATE`가 A의 `COMMIT` 직후 끝남(1.42~1.44초), 오류 없음, 1000, 1000 | 적중 |

(가)의 LATEST DETECTED DEADLOCK은 세 번 모두 (1) A가 `PRIMARY` 1을 `lock_mode X locks rec but not gap`으로 보유하고 2를 기다림, (2) B가 2를 보유하고 1을 기다림, `WE ROLL BACK TRANSACTION (2)`(B)였다. (나)에서 B가 4번을 보낸 직후의 `data_locks`는 A가 1을 보유하고 2를 기다리고 B가 2를 보유하고 1을 기다리는 같은 고리였고, A의 1205까지 그대로 남았다.

### 묶음 ②·③: 같은 요청 10건 (판마다 3회)

| 판 | 끝난 뒤 표 | 결과 | 오류 | 다시 시도 | 요청 시간 중앙값 / 최대 (ms) |
|---|---|---|---|---:|---|
| `deduct` READ COMMITTED | 잔액 900 | `done` 10 | 없음 | 0 | 57~63 / 61~67 |
| `deduct` REPEATABLE READ | 잔액 900 | `done` 10 | 없음 | 0 | 60~70 / 62~73 |
| `deduct` SERIALIZABLE | 잔액 900 | `done` 1, `error` 9 | 1213 ×9 | 0 | 55~65 / 61~67 |
| `reward-plain` | 10행, 잔액 10000 | `granted` 10 | 없음 | 0 | 59~65 / 65~72 |
| `reward-count-lock` | 1행, 잔액 1000 | `granted` 1, `error` 9 | 1213 ×9 | 0 | 59~65 / 63~70 |
| `reward-parent-lock` | 1행, 잔액 1000 | `granted` 1, `already` 9 | 없음 | 0 | 65~70 / 72~78 |
| `reward-version` | 1행, 잔액 1000, version 1 | `granted` 1, `already` 9 | 없음 | 9 | 63~69 / 66~74 |
| `reward-unique` | 1행, 잔액 1000 | `granted` 1, `already` 9 | 1062 ×9(앱이 처리) | 0 | 59~73 / 61~73 |
| `reward-count-lock-unique` | 1행, 잔액 1000 | `granted` 1, `error` 9 | 1213 ×9 | 0 | 58~63 / 61~67 |
| `reward-version-first` | 10행, 잔액 10000, version 0 | `granted` 10 | 없음 | 0 | 61~67 / 67~73 |
| `reward-version-const` | 1행, 잔액 1000, version 1 | `granted` 1, `gave-up` 9 | 없음 | 0 | 60~64 / 64~66 |
| `reward-version-const-v3` | 0행, 잔액 0, version 3 | `gave-up` 10 | 없음 | 0 | 59~61 / 63~65 |
| `reward-lock-after-count` | 10행, 잔액 10000 | `granted` 10 | 없음 | 0 | 343~346 / 621~626 |

같은 points 행의 락으로 줄을 선 두 판은 끝나는 간격이 달랐다. `reward-parent-lock`은 첫 요청이 58~64ms에 끝난 뒤 나머지 9건이 COUNT 1을 보고 바로 `ROLLBACK`해 약 1.5ms 간격으로 끝났다. `reward-lock-after-count`는 10건이 모두 COUNT 0을 받아 둔 채 락을 기다렸다가 50ms를 쉬고 지급해, 약 62~63ms 간격으로 끝났다(첫 요청 56~65ms, 마지막 621~626ms).

`reward-count-lock-pair`(③ (가) 처음 판을 두 요청으로 줄인 순서표)의 락은 세 번 모두 같았다. B가 `COUNT(*) ... FOR UPDATE`를 보낸 직후 A와 B 모두 `idx_user_event`의 supremum pseudo-record에 `X` GRANTED였다. A의 `INSERT`는 supremum에 `X,INSERT_INTENTION` WAITING으로 기다렸고(B의 `INSERT`까지 0.82~0.83초), B의 `INSERT`는 바로 1213을 받았다. LATEST DETECTED DEADLOCK은 (1)(2) 모두 supremum을 `lock_mode X`로 보유하고 같은 supremum에 `lock_mode X insert intention waiting`으로 기다렸고, `WE ROLL BACK TRANSACTION (2)`(B)였다. 끝난 뒤 rewards는 A의 1행이었다.

| 문제 상황 | 칸 | 예상 | 측정 | 판단 |
|---|---|---|---|---|
| 2-1 | READ COMMITTED 1213 수, 잔액 | 0, 900 | 0, 900 | 적중, 적중 |
| 2-1 | REPEATABLE READ 1213 수, 잔액 | 0, 900 | 0, 900 | 적중, 적중 |
| 2-1 | SERIALIZABLE 1213 수, 잔액 | 0, 900 | 9, 900 | 빗나감, 적중 |
| 3 | 막지 않음: 행, 잔액, 오류 | 10, 10000, 없음 | 10, 10000, 없음 | 적중 ×3 |
| 3 | (가) 처음 판: 잠긴 것 | supremum | 두 요청 모두 supremum에 `X` | 적중 |
| 3 | (가) 처음 판: `INSERT`, 잔액 `UPDATE` 횟수 | 10번, 10번 | 1행, 1000(나머지 9건은 1213) | 빗나감 ×2 |
| 3 | (나) 첫 판: `INSERT`, 잔액 | 10번, +1000 한 번 | 10행, 10000 | 적중, 빗나감 |
| 3 | (다) 유니크: `INSERT`, 잔액 | 1번, +1000 한 번 | 1행, 1000 | 적중 ×2 |
| 3 | (가) 고친 판: 행, 잔액, 오류 | 1, 1000, 없음 | 1, 1000, 없음 | 적중 ×3 |
| 3 | (나) 고친 판: 행, 잔액, 오류 | 1, 1000, 없음 | 1, 1000, 없음 | 적중 ×3 |
| 3 이어서 | `FOR UPDATE`를 COUNT 다음으로: 행, 잔액 | 10, 10000 | 10, 10000 | 적중 ×2 |
| 3 이어서 | 처음 version 3: 행, 잔액 | 10, 10000 | 0, 0 | 빗나감 ×2 |

### 묶음 ④: 커넥션 풀 (경우마다 3회)

동시 요청 50건. 칸마다 세 번의 값을 실행 순서대로 적는다. 연결 기다림은 성공한 요청만이다.

| 경우 | 성공 / 타임아웃 | 다 끝난 시간 (초) | 연결 기다림 중앙값 / 최대 (ms) | 서버: 새 연결 / 동시 최대 |
|---|---|---|---|---|
| `QueuePool` 5, 타임아웃 30초 | 50 / 0 | 2.103, 2.099, 2.087 | 949.65 / 1892.70, 939.12 / 1886.94, 934.16 / 1880.47 | 1, 1, 1 / 7, 7, 7 |
| `QueuePool` 10, 30초 | 50 / 0 | 1.069, 1.071, 1.068 | 428.33 / 859.41, 431.52 / 860.36, 428.96 / 856.78 | 1, 0, 0 / 12, 11, 12 |
| `QueuePool` 50, 30초 | 50 / 0 | 0.218, 0.218, 0.222 | 0.01 / 0.04, 0.01 / 0.04, 0.01 / 0.03 | 0, 0, 0 / 51, 51, 51 |
| `QueuePool` 5, 0.5초 | 15 / 35 | 0.637, 0.638, 0.631 | 214.46 / 428.94, 215.91 / 427.75, 214.60 / 424.25 | 1, 0, 0 / 7, 6, 6 |
| `NullPool`(요청마다 새로 연결) | 50 / 0 | 0.318, 0.310, 0.291 | 61.23 / 68.72, 69.62 / 75.65, 63.87 / 73.68 | 50, 50, 50 / 51, 51, 51 |

풀 5·0.5초의 타임아웃 35건은 기다리기 시작하고 0.504~0.512초 뒤에 났다(실행마다 중앙값과 최대). `NullPool`에서 가장 빨리 연결을 얻은 요청은 19~27ms였다.

한 건씩 200번(연결을 닫거나 돌려주는 시간은 뺌).

| 경우 | 중앙값 (ms) | p95 (ms) | 최소~최대 (ms) | 서버: 새 연결 |
|---|---|---|---|---|
| `connect-null`: 새로 연결 + `SELECT 1` | 9.25, 9.56, 9.63 | 11.19, 11.63, 11.68 | 8.58~15.75 | 201, 201, 202 |
| `checkout-queue`: 풀에서 빌리기 + `SELECT 1` | 0.31, 0.31, 0.32 | 0.34, 0.34, 0.34 | 0.22~0.77 | 0, 0, 0 |

| 문제 상황 | 칸 | 예상 | 측정 | 판단 |
|---|---|---|---|---|
| 4 | (1) 풀 5: 다 끝나는 시간, 가장 오래 기다린 시간 | 2초, 1.8초 | 2.09~2.10초, 1.88~1.89초 | 적중, 적중 |
| 4 | (2) 풀 10: 같은 두 값 | 1초, 0.8초 | 1.07초, 0.86초 | 적중, 적중 |
| 4 | (2) 풀 50 | 적지 않음 | 0.22초, 0.04ms 이하 | 뺌 |
| 4 | (3) 풀 5·0.5초의 타임아웃 | 35건 | 35건 | 적중 |
| 4 | (4)(가) 새 연결 ÷ 풀에서 빌리기 | 모름 | 약 30배(중앙값 9.56ms ÷ 0.31ms) | 뺌 |
| 4 | (4)(나) 풀 없이 50건 동시가 풀 5보다 | 연결 수 제한이 없으면 짧을 수 있음 | 0.29~0.32초로 짧음(`max_connections` 151 안) | 적중 |

(1)(2)는 적은 계산(차례 수 × 0.2초)보다 5~7% 길었다. 틀렸다고 볼 조건을 적지 않아 컨테이너 판정과 같은 기준으로 적중으로 셌다.

### 측정하며 본 것

- 서버가 센 새 연결과 동시 최대 연결에 Docker의 상태 검사 연결이 섞였다. `infra/compose.yaml`은 2초마다 컨테이너 안에서 `mysqladmin ping`을 돌리고, 이 연결도 `Connections`와 `Max_used_connections`에 들어간다. 풀을 미리 데워 새 연결이 0이어야 할 `QueuePool`에서 2초쯤 걸린 풀 5의 세 번은 모두 새 연결 1·동시 최대 7(풀 5 + 관찰용 1 + 1)이었고, 1초쯤 걸린 풀 10은 세 번 중 한 번, 0.2초쯤 걸린 풀 50은 한 번도 없었다. 200번에 약 2초 걸린 `connect-null`도 200이 아니라 201·202였다(에이전트 판단, 상태 검사를 끄고 확인하지는 않았다).
- 풀 5에서 첫 차례 다섯 요청은 연결을 받은 뒤 돌려줄 때까지 약 0.216초를 썼고, 다음 요청은 앞 요청이 돌려준 직후에 받았다(0.5ms 안). 그래서 다 끝나는 시간이 차례마다 0.2초보다 조금씩 길어졌다.
- 묶음 ②의 (나) 4번이 기다린 3.33~3.34초는 A가 5.03~5.04초에 1205를 받은 뒤 실행 틀이 그것을 알아채고(0.3초 간격) 미뤄 둔 A의 `COMMIT`을 보내기까지다. 4번은 3번보다 2초 늦게 보냈다.
- 컨테이너 임시 확인 틀은 "이미 받음"을 확인하기 전에도 50ms를 쉬어, 문제의 순서(확인 → 0이 아니면 바로 `ROLLBACK`)와 달랐다. 그래서 피드백에 적은 ③ (가) 고친 판의 287 / 520ms와 (나) 최종판의 다시 하는 요청 약 110ms는 맞지 않는 값이었다([문제 상황 3](#문제-상황-3-동시에-들어온-같은-리워드-지급-10건-2026-11-03)에 적음). 행 수·잔액·오류·다시 시도 수는 이 순서와 상관없어 그대로다.

### 참고: 컨테이너 임시 확인 값과 맥 본 측정

컨테이너 값은 문제 상황마다 피드백에서 이미 보였다. Linux x86_64 컨테이너에서 같은 버전의 MySQL 이미지(`linux/amd64`)로 돌린 값이며, 환경이 달라 판정에 쓰지 않는다.

| 항목 | 컨테이너 | 맥 본 측정 |
|---|---|---|
| ①② 순서표 22개 조건의 행·기다림·오류·락·끝난 뒤 값 | 문제 상황 피드백 | 모두 같음 |
| 2-1·③ 13개 판의 행·잔액·오류·다시 시도 수 | 문제 상황 피드백 | 모두 같음 |
| 1-2 B의 `INSERT` 기다림 | 1.70초 | 1.74~1.75초 |
| ③ (가) 고친 판 요청 시간 중앙값 / 최대 | 287 / 520ms(틀의 순서가 달랐음) | 65~70 / 72~78ms |
| ③ (나) 최종판, 다시 하는 요청 | 약 110ms(같은 이유) | 63~69 / 66~74ms(10건 전체, 그중 9건이 다시 함) |
| ④ 풀 5: 다 끝남 / 가장 오래 기다림 | 2.03초 / 1.82초 | 2.09~2.10초 / 1.88~1.89초 |
| ④ 풀 10 | 1.02초 / 0.81초 | 1.07초 / 0.86초 |
| ④ `NullPool` 50건 동시: 다 끝남 | 0.40~0.45초 | 0.29~0.32초 |
| ④ 새로 연결 / 풀에서 빌리기(`SELECT 1` 포함) | 6.3ms / 0.09ms(약 70배) | 9.25~9.63ms / 0.31~0.32ms(약 30배) |

### 첫 해석

2026-11-04에 맥 본 측정의 표를 보며 나눈 문답이다. 에이전트가 결과 표와 측정상의 문제를 먼저 보이고, 사람이 관찰한 사실과 예상에서 벗어난 점을 해석했다. 사람의 말은 원문 그대로 적고, 에이전트의 말은 줄여 적는다.

#### 묶음 ④: 30배 비싼 새 연결이 먼저 끝낸 50건

- 에이전트 질문: 한 건씩 잴 때 새로 연결하기(9.25~9.63ms)는 풀에서 빌리기(0.31~0.32ms)의 약 30배였는데, 50건이 동시에 몰리자 요청마다 새로 연결한 `NullPool`(0.29~0.32초)이 풀 5(2.09~2.10초)보다 먼저 끝났다. (1) 두 결과는 어떻게 함께 성립하는가. (2) 그런데도 풀을 쓰는 이유를 이 맥에서 잰 숫자로 말해 달라.
- 사람의 해석(원문, 메시지에서는 (1)과 (2) 사이에 줄을 바꿈): "(1) 동시에 처리할 수 있는 개수 제한이 없으면 한 건에 200ms 씩 요구되는 작업을 새로 연결이 생성되더라도 한 번에 50건을 처리할 수 있기 때문에 한 번에 5건 씩 처리하는 pull_size 5인 경우보다 먼저 끝날 수 있었어. (2) 맥에서 잰 숫자가 상관이 있어? 풀을 쓰는 이유는 커넥션의 개수에 제한이 없을 경우 리소스의 한계로 인해 어떤 요청 처리는 누락될 수 있는 위험이 있기 때문에 프로그램의 안정성을 위해서 커넥션 개수에 제한을 두고 미리 그 개수만큼 생성해서 커넥션을 생성할 때 소요되는 리소스는 없애서 같은 제한이라면 풀이 있는게 더 빠르게 요청을 처리할 수 있게 하기 위함이라고 추측했어."
- 에이전트 피드백(설명): (1)은 맞았다. 30배는 연결을 얻는 몫(9ms 대 0.3ms)에만 걸리고, 요청마다 연결을 보유하는 200ms와 풀 5에서 줄 선 시간(가장 오래 기다린 요청 1.88~1.89초)이 훨씬 컸다. `NullPool`은 50건이 한꺼번에 연결해 연결 얻기가 중앙값 61~70ms로 한 건씩일 때보다 느렸지만 0.29~0.32초에 다 끝났다. (2)의 두 이유(연결 수를 제한해 안정성을 지킴, 미리 만든 연결로 생성 비용을 없앰)도 맞았다. 숫자를 물은 것은 목표가 숫자로 말하기이고 학습 확인에서 숫자를 넣은 답을 세기 때문이라고 답하고 숫자를 붙였다. 누락은 이 맥의 `max_connections` 151을 넘는 요청이 기다리지 않고 바로 받는 1040(Too many connections)이고(재지 않음), 풀은 넘는 요청을 `pool_timeout`까지 줄 세운다(풀 5·0.5초에서 35건 타임아웃). 생성 비용은 요청마다 9.25~9.63ms가 0.31~0.32ms로 줄고, 쿼리가 짧을수록 그 차이가 요청 시간의 대부분이 된다.

#### 묶음 ②·③: 두 데드락의 같은 점과 다른 점

- 에이전트 질문: ③ (가) 처음 판을 두 요청으로 줄인 순서표(`reward-count-lock-pair`)에서 A와 B는 같은 supremum에 `X`를 함께 보유했고(둘 다 GRANTED), 두 `INSERT`에서 데드락이 나 B가 1213을 받았다. (1) 문제 상황 2의 이체 데드락과 비교해 같은 점과 다른 점은 무엇인가(각자 보유한 락, 기다린 락, 고리가 생긴 까닭). (2) 2 이어서의 락 순서 고정으로 이 데드락을 막을 수 있는가.
- 사람의 답(원문): "문제 상황이 기억이 안 나"
- 에이전트 설명: 문제 상황 2의 순서와 데드락 보고(A가 id 1을 보유하고 id 2를 기다림, B가 id 2를 보유하고 id 1을 기다림, 둘 다 `X,REC_NOT_GAP`), 2 이어서(B도 id 1부터 고쳐 데드락 없음), 두 요청 순서표의 순서와 락(두 `COUNT(*) ... FOR UPDATE`가 모두 바로 끝나 A·B 모두 supremum에 `X` GRANTED, A의 `INSERT`가 `X,INSERT_INTENTION`으로 기다리고 B의 `INSERT`가 바로 1213)을 다시 보이고 같은 두 물음을 물었다.
- 사람의 해석(원문, 메시지에서는 (1)과 (2) 사이에 줄을 바꿈): "(1) 같은점: 데드락이 걸렸다? 다른점: 이거 user_id 가 보조 인덱스로 쓰이는지 여부에 따라 갈렸던 거 아닌가? 인덱스가 있던 쪽은 각행의 앞 뒤 갭과 행에만 락이 걸리고 인덱스가 없던 쪽은 배타락을 쥔 statement가 모든 id를 조회하기 때문에 테이블 전체에 락이 걸리는게 차이였던거 같은데. (2) 락 순서 고정으로 데드락을 막을 수 있지. 항상 먼저 락을 얻어야 하는 행이 고정되어서 다른 행의 변경이 커밋될 때까지 해당 트랜잭션은 대기하니까."
- 에이전트 피드백(설명): (1)의 같은 점은 맞았다. 두 경우 모두 각자 락 하나를 보유한 채 상대가 보유한 락을 기다리는 고리가 생겼고, InnoDB가 바로 찾아 B를 1213으로 통째로 되돌렸다. 다른 점으로 든 인덱스 유무는 문제 상황 1과 1-1의 차이이고, 이번 둘은 모두 인덱스를 탔다(이체는 `PRIMARY`의 id, ③은 보조 인덱스 `idx_user_event`). 차이는 보유한 락이다. 이체는 서로 다른 두 행의 레코드 락(`X,REC_NOT_GAP`)을 반대 순서로 획득(acquire)했고, 레코드 락끼리 충돌해 상대 행의 락을 요청하는 순간 기다렸다. ③은 아직 행이 없는 같은 갭(supremum)을 같은 순서로 획득했다. 갭 락끼리는 충돌하지 않아 B의 `COUNT(*) ... FOR UPDATE`도 기다리지 않고 둘 다 보유했고, 그다음 `INSERT`의 삽입 의도 락이 상대의 갭 락에 막혀 서로를 기다렸다. (2)는 이체에는 맞는 설명이지만 ③에는 통하지 않는다. ③의 두 요청은 이미 같은 문장을 같은 순서로 보냈다. 락 순서 고정은 먼저 요청하는 락에서 뒤 요청이 기다려야 통하는데, 갭 락은 함께 보유할 수 있어 둘 다 첫 락을 지나갔다. ③ (가) 고친 판은 이미 있는 points 행을 맨 앞에서 `FOR UPDATE`로 잠가, 함께 보유할 수 없는 그 행의 배타 락에서 두 번째 요청부터 기다려 데드락 없이 줄을 섰다(1행, 1000, 오류 없음).
- 확인한 부분: ④는 `NullPool`이 먼저 끝난 이유와 풀을 쓰는 이유를 혼자 말했고, 숫자는 피드백에서 붙였다. 두 데드락의 차이를 인덱스 유무(문제 상황 1·1-1)와 섞었고, 갭 락끼리 함께 보유할 수 있어 락 순서 고정이 ③에 통하지 않는다는 것은 설명을 들은 뒤라 학습 확인에서 다시 묻는다.

## 완료 후 학습 확인

2026-11-05~06에 확인할 질문 8개를 하나씩 해설 없이 묻고, 답마다 "왜?"를 이어 물었다. 질문 7·8은 처음 답이 막연해 물음을 둘로 나눈 뒤 "왜?"를 한 번만 물었다. 이어 목표 3과 목표 1을 확인하려고 처음 보는 상황 3개와 순서표 2개를 냈다. 사람은 코드와 원자료를 볼 수 있었고, 복습 카드와 화면은 끝난 뒤에 보기로 했다. 앞의 문제 상황을 짚을 때는 처음 낼 때의 글(표, 처음 행, 순서, 조건)을 그대로 다시 적었다. 도움은 장면 짚기, 측정값 다시 보이기, 작은 힌트, 설명의 순서로 줬다. 피드백에 맥에서 재지 않은 값이 필요하면 클라우드 컨테이너(Linux x86_64, MySQL 8.4.13)에서 저장소 코드를 고치지 않고 불러 돌렸고, 그 값은 "컨테이너 확인(판정용 아님)"으로 적는다. 그 원자료는 저장소에 넣지 않았다. 문서 인용은 원문을 확인한 문장만 썼다. 사람의 답은 원문 그대로 두고(메시지의 줄 바꿈은 번호 앞에서는 띄어 쓰고 그 밖에서는 " / "로 적음) 에이전트의 피드백과 나눈다. 대화 전체를 옮기지는 않았다.

### 질문 1: 공유 락과 배타 락

- 사람의 답(원문): "공유 락은 여러 스레드가 락이 걸린 대상에 동시에 조회는 가능하지만 수정은 불가능하고 배타락은 조회까지 불가능한걸 말해. 서로 부딪히기는건 모르겠어."
- 사람의 질문(원문): "'부딪힌다'가 표준 용어야? 표준용어로 다시 말해줘."
- 에이전트: 표준 용어가 아니라고 답하고, 락 충돌(conflict)·호환(compatible), 요청(request)·부여(grant)·보유(hold)로 질문을 고쳐 다시 물었다. 이 README의 확인할 질문과 카드·화면의 같은 말도 이 용어로 고쳤다. 락을 보유하는 쪽은 스레드가 아니라 트랜잭션이라고 짚고, 장면 짚기로 문제 상황 2-1을 처음 낸 글 그대로 다시 적어 맥 측정(READ COMMITTED·REPEATABLE READ 10건 모두 끝남·1213 0건·잔액 900, SERIALIZABLE 1건 끝남·1213 9건·잔액 900)을 보인 뒤 물었다. (1) SERIALIZABLE에서 10건의 `SELECT`가 보유한 락과 그 락끼리 충돌했는지 (2) `UPDATE`가 요청한 락과 9건이 1213을 받은 까닭 (3) READ COMMITTED·REPEATABLE READ에서 `UPDATE`끼리는 어떻게 됐는지.
- 사람의 답(원문): "1. 공유락을 획득했어. 호환됐어. 2. 배타락을 요청했어. 하지만 다른 트랜잭션들에서 이미 SELECT로 공유락을 들고 있기 때문에 배타락 요청과 충돌이 발생해서 첫 트랜잭션부터 순서대로 UPDATE 문에서 배타락을 얻기 위해 대기하다가 5초가 지나서 데드락 오류가 발생하고 마지막 트랜잭션의 요청만 처리되는거야. 3. RC와 RR에서는 락을 사용하지 않고 현재 커밋된 데이터나 스냅샷을 참조하기 때문에 다른 트랜잭션과 상관없이 모두 실행되었어. / 충돌했어."
- 에이전트 피드백: 1은 맞다. SERIALIZABLE의 평범한 `SELECT`는 공유 락을 걸고, 공유 락끼리는 호환된다. 2에서 배타 락 요청이 다른 트랜잭션들의 공유 락과 충돌했다는 것도 맞다. "5초가 지나서"는 빗나갔다. 맥에서 SERIALIZABLE 10건은 세 번 모두 요청 시간 최대 61~67ms 안에 끝났다(바로 1213이 난 까닭은 질문 3·4로 미뤘다). 3에서 `SELECT`가 락 없이 스냅숏을 읽었다는 것과 `UPDATE`끼리 충돌했다는 것은 맞다. "다른 트랜잭션과 상관없이 모두 실행"은 고쳤다. `UPDATE`는 격리 수준과 상관없이 배타 락을 요청해, 앞 요청이 커밋할 때까지 기다렸다가 하나씩 끝났다(READ COMMITTED 한 번의 원자료에서 57.7~66.8ms 사이에 약 1ms 간격).
- 사람의 질문(원문, 같은 메시지에서 이어짐): "여기서 새삼 질문이 생겼어. 왜 '락 충돌'이라고 표현하는거야? 한 트랜잭션이 락을 요청했을 때 다른 트랙잭션이 해당 락을 보유하고 있어서 요청한 락을 얻지 못하는 상황을 충돌이라고 부르는게 이상해. 두 락의 상호작용으로 인한 요청 거절이 아니라. 왜 한 쪽은 락이 없으니까 락을 원했지만 이미 다른 쪽이 락을 보유하고 있기 때문에 락을 요청한 쪽이 락을 가지지 못하는 상황이 '충돌'로 표현되는거야?"
- 에이전트 설명: 충돌은 두 락 모드가 같은 대상에 함께 부여될 수 없다는 관계를 가리킨다. InnoDB는 기다리는 요청도 락으로 만들어 `data_locks`에 남긴다(`LOCK_STATUS`는 "The status of the lock request"이고 GRANTED와 WAITING이 있다). 락 모드는 트랜잭션이 하려는 연산을 나타내고, 동시성 제어 이론에서는 서로 다른 트랜잭션의 두 연산이 같은 데이터를 다루고 하나 이상이 쓰기여서 순서를 바꾸면 결과가 달라질 때 두 연산이 충돌한다고 한다. 그 연산의 충돌이 락 모드끼리의 충돌이 된다. [InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html): "A lock is granted to a requesting transaction if it is compatible with existing locks, but not if it conflicts with existing locks. A transaction waits until the conflicting existing lock is released."
- 왜? 1(에이전트): READ COMMITTED·REPEATABLE READ에서도 `UPDATE`끼리 충돌해 락 대기가 생겼는데 왜 1213은 없었나. / 왜? 2(에이전트, 변형 문제, 측정 아님): 2-1의 처음 잔액 1000에서 REPEATABLE READ의 한 트랜잭션이 `UPDATE`로 900을 쓰고 커밋하기 전에, 새 트랜잭션 Y(REPEATABLE READ)가 `START TRANSACTION` 뒤 같은 행을 평범한 `SELECT`로 읽으면 (가) 락 대기에 들어가는가, 바로 끝나는가 (나) 읽는 값은 무엇인가.
- 사람의 답(원문): "1. SELECT 문에서 해당 행에 대한 공유락을 획득하지 않았기 때문에 데드락의 조건 중 순환대기가 만족되지 않아서 앞서 배타락을 가진 작업이 끝나고 락이 해제되면 다른 트랜잭션이 해당 락을 다시 보유해서 작업을 처리해나갔기 때문이야. 2. (가) 대기에 들어가. (나) 900이야"
- 에이전트 피드백: 왜? 1은 맞다(순환 대기로 혼자 설명). 왜? 2는 빗나가, 03의 문제 상황 2를 03 README 기록 그대로 다시 적고 03 맥 측정(MySQL REPEATABLE READ에서 A가 1000·1000을 읽고 기다리지 않음, SERIALIZABLE에서만 B의 `UPDATE`가 1.74초 기다림)을 보인 뒤, 같은 변형 문제와 "배타 락은 조회까지 불가능"이 맞는 읽기는 어떤 것인지 물었다.
- 사람의 답(원문): "1. (가) Y는 락 대기에 들어가지 않고 바로 끝나. (나) 1000 2. 읽기에도 종류가 있어?"
- 에이전트 피드백(설명): 1은 맞다. 2는 질문으로 받아 설명했다. REPEATABLE READ·READ COMMITTED의 평범한 `SELECT`는 일관된 읽기(consistent nonlocking read)로, 락 없이 스냅숏을 읽고 다른 트랜잭션이 락을 건 행은 undo log로 만든 옛 버전을 읽는다([Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html): "A consistent read does not set any locks on the tables it accesses, and therefore other sessions are free to modify those tables at the same time a consistent read is being performed on the table."). `FOR SHARE`·`FOR UPDATE`와 SERIALIZABLE의 평범한 `SELECT`는 잠금 읽기(locking read)로, 최신 버전을 읽으며 락을 걸고 충돌하면 기다린다. 처음 답의 "배타 락은 조회까지 불가능"은 잠금 읽기에만 맞는다.

### 질문 2: 갭 락과 넥스트 키 락

- 사람의 답(원문): "특정 행이나 특정 행의 앞/뒤 갭에 락을 걸어서 다른 트랜잭션이 조회하거나 수정하는걸 제한하기 위함이야. 대가는 뭉뚱그려서 데이터 정합성이라고 생각하는데 구체적인 사례는 모르겠어. 이걸 주제로 실험한건 기억이 나는데 장면이나 숫자가 떠오르진 않아."
- 에이전트: 락을 거는 자리(행과 갭)는 맞고 정합성은 얻는 쪽에 가깝다고만 짚었다. 문제 상황 1을 처음 낸 글 그대로 다시 적고 맥 측정(REPEATABLE READ (가)(나)(다) 기다림·(라)(마) 바로, READ COMMITTED 다섯 모두 바로)과 `data_locks` 표를 보인 뒤 물었다. (1) 갭 락이 막은 B의 문장은 어떤 종류인지 (2) 갭을 잠그지 않았다면 B의 (가) 뒤에 A가 같은 `FOR UPDATE`를 다시 할 때 결과가 어떻게 되고 그 이상현상의 이름은 무엇인지 (3) user 5·10은 조건에 맞지 않는데 왜 기다렸고, 그것이 무엇의 대가인지.
- 사람의 답(원문): "1. (3, 7)과 (4, 12) 사이에 삽입하려는 (가), (1, 3)과 (2, 7) 사이에 삽입하려는 (나),  (3, 7)과 (4, 12) 사이에 삽입하려는 (다)가 막혔어. 조회나 수정이 아니야. 2. 2->3으로 결과가 바뀌고 해당 현상의 이름은 phantom read야. 3. (2, 7)과 (3, 7) 행 앞뒤 갭까지 모두 배타락으로 잠겨있었기 때문에 (나)와 (다)도 새로운 행을 삽입하지 못하고 해당 배타락을 얻기 위해 기다렸어. 무엇의 대가인지는 표현을 못하겠어. 뭐가 대가라는거야?"
- 에이전트 피드백(설명): 1은 맞다. 자리를 (id, user_id)로 적었지만 이웃은 `idx_user`의 순서대로 맞았다. 갭 락은 삽입만 막는다([InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html): "Gap locks in InnoDB are “purely inhibitive”, which means that their only purpose is to prevent other transactions from inserting to the gap."). 2도 맞다. 시작 전 예상에서 non-repeatable read라고 했던 것을 이번에는 팬텀으로 답했다. 3에서 갭까지 잠겨 기다렸다는 것은 맞고, B가 기다린 것은 A의 배타 락을 얻으려 해서가 아니라 B의 삽입 의도 락(`X,GAP,INSERT_INTENTION`)이 A의 갭 락과 충돌해서라고 다듬었다. 대가는 질문으로 받아 설명했다. 얻는 것은 팬텀을 막는 것이고, 대가는 갭이 조건이 아니라 이웃한 두 인덱스 레코드 사이의 범위라서 조건에 맞지 않는 user 5·10의 삽입까지 기다리는 것(동시에 처리할 수 있는 일이 줄어듦)이다. READ COMMITTED는 다섯 모두 바로 끝났지만 팬텀을 허용한다.
- 왜? 1(에이전트): (12, 4)는 조건에 맞지 않고 결과에도 없는데, A는 왜 그 레코드에 `X,GAP`을 걸었나(`idx_user`의 값은 (user_id, id)).
- 사람의 질문과 답(원문): "배타락, 공유락, 갭락, 삽입 의도락, 넥스트 키 락 이것들이 모두 같은 클래스야? 아니면 공유락 배타락은 다른 영역에 위치한 개념이야? / X, GAP이 갭 락이라서 (4, 12) 행 자체에는 락이 걸리지 않고 그 행 앞의 갭에만 락을 걸려고 한거 아니야?"
- 에이전트: 락은 모드(S·X)와, 인덱스의 어디를 잠그는지(레코드, 갭, 넥스트 키, 삽입 의도)를 함께 가진다고 설명했다. 이때 에이전트가 쓴 "축"은 표준 용어가 아니라는 지적을 받고 다음 답에서 고쳤다. "(12, 4) 자체는 잠그지 않고 앞 갭만"은 맞지만 왜 (12, 4)에 락이 붙었는지는 아직이라, A가 `idx_user`에서 user_id 7을 다 찾았다는 것을 언제 알 수 있었는지 작은 힌트로 물었다.
- 사람의 답(원문): "모드라는 용어가 평범한 읽기와 잠금 읽기에서도 나왔떤거 같은데 이것도 서로 다른 영역이야?(영역이라고 표현하는게 맞나, 너도 축이라는 용어가 표준용어는 아닌거 같은데 표준 용어로 설명해줘) / 보조 인덱스로써 각 인덱스의 순서가 user_id로 오름차순 정렬되어 있었으니까 (12, 4)행에 '무언가(포인터? 커서?표준용어를 모르겠네)'가 도달해서 해당 행을 확인하고 user_id가 7인 인덱스는 모두 찾았다고 '무엇(인지하는 주체를 뭐라고 부르지?)'이 인지했을거라 생각해."
- 에이전트 피드백(설명): 왜? 1은 힌트 뒤 맞았다. 용어를 정리했다. "축"·"영역"은 표준 용어가 아니다. `data_locks`에는 `LOCK_MODE`(S·X·IS·IX, 락 호환성 표는 이 모드끼리의 관계)와 `LOCK_TYPE`(행 락 RECORD, 표 락 TABLE)이 있고, 레코드·갭·넥스트 키·삽입 의도는 행 락이 인덱스의 어디를 잠그는지에 붙는 이름이다(매뉴얼에는 넷을 묶는 이름이 없다). 일관된 읽기를 설명하는 "mode"는 InnoDB가 `SELECT`를 처리하는 방식이고 락 모드가 아니다. 사람이 찾던 말은 인덱스 스캔(index scan)의 커서(cursor)와, 확인하는 주체인 스토리지 엔진(storage engine) InnoDB다. 커서가 (12, 4)까지 읽어야 user 7이 끝났음을 알고, 읽은 (12, 4)에도 락이 걸린다. 조건에 맞지 않아 REPEATABLE READ는 앞 갭만(`X,GAP`) 잠갔고, 그 갭이 id가 3보다 큰 user 7의 새 행이 들어갈 자리다.
- 왜? 2(에이전트): 문제 상황 1-1(인덱스 없음)을 처음 낸 글 그대로 다시 적고 맥 측정(REPEATABLE READ 셋 모두 A의 `COMMIT`까지 기다림, READ COMMITTED 셋 모두 바로)을 보인 뒤, REPEATABLE READ에서 (가)(나)(다)가 기다린 까닭과 READ COMMITTED에서 셋 다 바로 끝난 까닭을 물었다.
- 사람의 답(원문): "1. 인덱스가 존재하지 않은 조건에 대해서는 풀 스캔을 수행하는데 RR 격리 수준에서 조회하는 행마다 락을 걸고 premum이었나 락을 건 행 뒤의 갭 위치에도 락을 걸기 때문이야. 2. RC에서는 각 행에만 락을 걸기 때문이야."
- 에이전트 피드백(설명): 1은 맞다. 용어는 전체 테이블 스캔(full table scan)이고, InnoDB는 행이 클러스터형 인덱스 `PRIMARY`에 있어 `PRIMARY` 전체를 읽는다. "premum"은 supremum pseudo-record다. 넥스트 키 락은 레코드와 그 앞 갭을 잠가("A next-key lock is a combination of a record lock on the index record and a gap lock on the gap before the index record."), 마지막 레코드 뒤 갭은 supremum의 넥스트 키 락이 잠근다. 원리는 [Locks Set by Different SQL Statements in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)의 첫 문장이다: "A locking read, an UPDATE, or a DELETE generally set record locks on every index record that is scanned ... It does not matter whether there are WHERE conditions in the statement that would exclude the row." 2는 (가)(나)만 설명된다. "각 행에만 락"이면 id 1을 지우는 (다)는 기다렸어야 한다. 이어 (1) A가 id 1·4도 읽었는데 왜 락이 남지 않았나 (2) (가)는 user 7인데 왜 user 7 행 근처가 아니라 supremum에서 기다렸나를 물었고, 사람은 둘 다 "모르겠어"라고 답했다.
- 에이전트 설명: (1) 문제 상황 1은 `idx_user`가 있어 InnoDB가 user_id = 7을 검색 키로 받아 직접 비교했다. 1-1은 인덱스가 없어 InnoDB가 `PRIMARY`를 읽으며 행마다 락을 걸고, 조건(`WHERE`)은 서버(SQL 계층)가 평가한다. READ COMMITTED는 서버가 맞지 않는다고 판정한 행의 레코드 락을 해제하고("Record locks for nonmatching rows are released after MySQL has evaluated the WHERE condition."), REPEATABLE READ는 보유한다. (2) 새 행이 들어갈 자리는 그 인덱스의 정렬 순서가 정한다. `PRIMARY`는 id로만 정렬되어 새 id 10·13은 id 4와 supremum 사이 갭에 들어가고, 그래서 A의 supremum 넥스트 키 락과 충돌했다. 문제 상황 1에서 (7, 3)과 (12, 4) 사이였던 것은 `idx_user`가 (user_id, id) 순이라서다.

### 질문 3: 데드락이 생기는 과정과 네 조건

- 사람의 답(원문): "잠금 읽기 모드에서 두 트랜잭션이 동시에 같은 행을 수정하려고 할 때 발생할 수 있어. A 트랜잭션에서 먼저 행 r에 공유 락을 걸고 B 트랜잭션에서 행 r에 공유 락을 건 상태에서 A 트랜잭션에서 행 r을 수정하려고 배타 락을 얻으려다 충돌이 발생해서 대기하고 마찬가지로 B 트랜잭션도 같은 행에 대한 배타 락을 얻으려다 충돌이 발생해. / 상호배제: 잠금 읽기 모드에서의 공유 락이 update 문의 배타락 요청을 배제하면서 조건이 만족됨 / 점유대기: 각 트랜잭션이 배타락을 얻기 위해 대기함 / 비선점: 다른 트랜잭션이 보유중인 공유락을 해제할 수 없음 / 순환대기: 서로가 같은 행에 대해 보유한 공유락을 해제하기를 기다림"
- 에이전트 피드백: 과정은 맞다(같은 행에 공유 락을 보유한 채 배타 락을 요청해 서로의 공유 락과 충돌). 장면과 숫자가 없어 문제 상황 2-1과 맥 측정을 다시 보였다. 네 조건 가운데 상호 배제·비선점·순환 대기는 맞고, 점유 대기는 "공유 락을 보유한 채"가 빠져 반만 맞다(빠지면 READ COMMITTED·REPEATABLE READ에서 `UPDATE`가 줄을 선 것과 구분되지 않는다). "잠금 읽기 모드"는 "잠금 읽기"로 고쳤다.
- 왜? 1(에이전트): 문제 상황 2(서로 반대로 보낸 두 이체)를 처음 낸 글 그대로 다시 적고 (가) 탐지 켬의 맥 측정(3번은 2.01초 기다렸다가 끝남, 4번은 바로 1213)만 보인 뒤, 같은 행도 아니고 공유 락도 없는데 왜 데드락이 났는지, 네 조건은 어디에서 보이는지 물었다.
- 사람의 답(원문): "같은 행을 고치진 않지만 서로 다음 순서에 수정할 행에 대한 배타락을 가지고 있으니까 데드락이 발생했어. / * 상호 배제: 각 트랜잭션의 첫 UPDATE 문이 id 1, 2에 대한 배타락을 보유하고 그 다음으로 각자 2, 1 id 행에 접근하려는데 각자 이미 보유한 배타락과 배타락 요청에 의해 충돌이 발생하는 상호 배제 상태가 되었어. / * 점유 대기: 각자 1,2 행에 대한 배타락을 보유하고 2, 1행에 대한 배타락 요청이 호환되도록 대기하고 있어. / * 비선점: 각 트랜잭션은 다른 트랜잭션이 보유한 배타락을 임의로 가져올 수 없어. / * 순환 대기: 1, 2행에 대한 배타락을 각자 보유하고 2, 1행에 대한 배타락을 대기하고 있어서 순환 대기 상태야."
- 에이전트 피드백: 맞다. 네 조건을 모두 혼자 맞혔고, 점유 대기에 "보유하고"가 들어갔다. 같은 행이든 다른 행이든, 락을 보유한 채 상대가 보유한 락과 충돌하는 락을 요청하고 그 기다림이 고리를 이루면 데드락이라고 정리했다.
- 왜? 2(에이전트): 문제 상황 3과 사람이 쓴 (가) 처음 판(`COUNT(*) ... FOR UPDATE`)을 다시 적고, 맥 측정(10건: 1행·1000·1213 ×9)과 두 요청 순서표(두 `COUNT(*) ... FOR UPDATE` 모두 바로 0, 그 뒤 A·B 모두 `idx_user_event`의 supremum에 `X` GRANTED, A의 `INSERT`는 `X,INSERT_INTENTION` WAITING, B의 `INSERT`는 바로 1213)를 보인 뒤, 행이 없는데 A·B가 같은 supremum에 `X`를 함께 보유할 수 있었던 까닭과 네 조건을 물었다.
- 사람의 답(원문): "supremum은 가장 끝 인덱스를 표현하기 때문에 아무것도 없으면 supremum에 대한 락을 보유할 수 있었을걸로 추측했어. / * 상호 배제: insert 문 실행을 위해 supremum에 대한 삽입 의도락을 요청하지만 충돌하면서 상호 배제 상태가 됨 / * 점유 대기: select 문을 실행하면서 supermum에 대한 배타락을 획득한 채로 서로 빈 테이블에 insert 하기 위해 supremum에 대한 삽입 의도락을 요청하고 충돌해서 대기함 / * 비선점: 서로 가진 배타락을 해제할 수 없음 / * 순환 대기: 서로 supremum에 대한 삽입 의도락을 획득하기 위해 대기함."
- 에이전트 피드백(설명): supremum에 락이 붙은 까닭은 맞고, 둘이 함께 보유한 까닭은 빠졌다. supremum의 넥스트 키 락은 사실상 갭 락이고("The supremum is not a real index record, so, in effect, this next-key lock locks only the gap following the largest index value."), 갭 락끼리는 모드와 상관없이 충돌하지 않는다([InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html): "Gap locks can co-exist. A gap lock taken by one transaction does not prevent another transaction from taking a gap lock on the same gap. There is no difference between shared and exclusive gap locks. They do not conflict with each other, and they perform the same function."). 그래서 충돌은 `INSERT`의 삽입 의도 락에서 처음 생긴다. 네 조건 가운데 상호 배제·점유 대기·비선점은 맞고, 순환 대기는 각자 상대가 보유한 갭 락이 해제되기를 기다린다는 것이 빠졌다.

### 질문 4: 데드락을 끝내는 두 방법

- 사람의 질문(원문, 질문 4를 낸 직후): "삽입 의도락이 갭 락을 기다린다는게 무슨 뜻이야? 락끼리 어느때는 충돌하고 어느때는 호환되는거야? 공유락 배타락이랑 갭락 삽입의도락 계열은 서로 충돌하긴 하는거야?"
- 에이전트 설명: "삽입 의도 락이 갭 락을 기다린다"는 삽입 의도 락 요청이 다른 트랜잭션의 갭 락과 충돌해 부여되지 않고 락 대기(`data_locks`의 WAITING)에 있다는 뜻이다. 충돌하는지는 모드와, 락이 인덱스의 어디를 잠그는지를 함께 봐야 한다. 에이전트는 이를 설명하려고 한 락을 "레코드 부분"과 "갭 부분"으로 나눠 말했고 표준 용어가 아니라고 밝혔다(근거는 Oracle MySQL 블로그 [InnoDB Data Locking Part 2.5](https://dev.mysql.com/blog-archive/innodb-data-locking-part-2-5-locks-deeper-dive/)의 "conceptually it holds that X = X,GAP + X,REC_NOT_GAP"). 레코드 부분끼리는 모드로 정해져 S끼리만 호환되고, 갭 부분끼리는 모드와 상관없이 호환되며(같은 글: "\*,GAP requests do not ever have to wait for anything"), 갭 부분과 그 갭에 들어오려는 삽입 의도 락은 충돌하고, 삽입 의도 락끼리는 넣는 자리가 다르면 호환된다. 공유·배타와 갭·삽입 의도는 따로 된 계열이 아니다(갭 락도 S·X 모드를 갖고, 삽입 의도 락은 X다).
- 사람의 답(원문): "둘 다 대기중인 statement를 되돌리는거 아니야? 다른 점은 그냥 바로 오류가 발생하는지 아니면 일정 시간 이후에 오류가 발생하는지 차이 아닌가? 장면은 안 떠올라."
- 에이전트 피드백: 오류가 나는 때는 맞다. 탐지는 고리가 생기는 순간 바로, 시간 초과는 정한 시간이 지난 뒤 오류를 낸다. 질문 1의 "5초 뒤 데드락 오류"를 이번엔 바르게 나눴다. "둘 다 기다리던 문장을 되돌린다"는 빗나가, 문제 상황 2를 처음 낸 글 그대로 다시 적고 (가)(나)의 맥 측정(잔액 (가) 900, 1100 / (나) 1000, 900)을 보인 뒤, 잔액으로 따져 1213과 1205가 각각 무엇을 되돌렸는지 물었다.
- 사람의 질문(원문): "여튼 트랜잭션 안에서 실패했으니까 그 트랜잭션에서 변경한 사항들이 모두 롤백됐을거잖아. 서로 다른걸 되돌린다고?"
- 에이전트 설명: 잔액을 셈으로 보였다. (가)에서 B의 4번 문장만 되돌렸다면 900, 1000이어야 하는데 측정은 900, 1100이라 1213은 B의 트랜잭션 전체를 되돌렸다. (나)에서 A의 트랜잭션 전체를 되돌렸다면 1100, 900이어야 하는데 측정은 1000, 900이라 1205는 A의 3번 문장만 되돌렸고, 남은 1번(-100)을 순서표대로 보낸 A의 `COMMIT`이 커밋해 이체가 반쪽만 남았다(합 2000 → 1900). [InnoDB Error Handling](https://dev.mysql.com/doc/refman/8.4/en/innodb-error-handling.html): "A transaction deadlock causes InnoDB to roll back the entire transaction. Retry the entire transaction when this happens." / "A lock wait timeout causes InnoDB to roll back the current statement (the statement that was waiting for the lock and encountered the timeout)."
- 왜? 1(에이전트): (나)에서 A가 1205를 받은 뒤에도 B의 4번은 A의 `COMMIT`까지 기다렸다. 데드락에서는 왜 문장만이 아니라 트랜잭션 전체를 되돌리나.
- 사람의 답(원문): "데드락에서는 이미 변경된 사항이 존재하고 한 쪽이 데드락으로 인해 실패했을 때 그 변경이 남아있으면 데이터 정합성이 위배되기 때문이야."
- 에이전트 피드백(설명): 빗나갔다. 정합성이 까닭이라면 시간 초과도 전체를 되돌려야 하는데 (나)는 반쪽 이체를 남겼다. 까닭은 락이다("Locks are not released in a rollback of a single SQL statement."). (가)에서 B의 4번만 되돌리면 고리는 끊기지만 B가 보유한 id 2의 배타 락이 남아 A는 B가 끝날 때까지 기다리고, B가 4번을 다시 보내면 같은 고리가 생긴다. 락은 트랜잭션이 끝나야 해제되므로, 상대를 바로 진행시키려면 한쪽 트랜잭션을 통째로 끝내야 한다. 실제로 B가 1213을 받은 직후 A의 3번이 끝났다(2.01초).
- 왜? 2(에이전트): (1) 탐지를 켜 두면 시간 초과는 없어도 되나 (2) 오류를 확인하는 앱이라면 1205를 받은 A와 1213을 받은 B는 각각 무엇을 해야 하나.
- 사람의 답(원문): "1. 없어도 될거라 생각해. 결국 데드락은 발생하지 않게 되잖아. 2. 모르겠어"
- 에이전트 피드백(설명): (1)은 빗나갔다. 탐지는 데드락을 막지 않고, 생긴 뒤 고리를 찾아 한쪽을 되돌린다(1213이 났다는 것이 데드락이 생겼다는 뜻이다). (가)의 3번~4번 사이 2초처럼 고리가 없는 기다림은 탐지 대상이 아니라서, 락을 보유한 트랜잭션이 오래 끝나지 않을 때(앱이 느리거나 커밋을 빠뜨림) 그 기다림을 끝내는 것은 시간 초과뿐이다. (2) 1205를 받은 A는 3번만 되돌려져 트랜잭션과 1번의 변경, id 1의 락이 남는다. 그대로 `COMMIT`하면 반쪽 이체가 되니 `ROLLBACK`한 뒤 이체를 처음부터 다시 한다. 1213을 받은 B는 이미 통째로 되돌려졌으니 성공으로 보고하지 말고 처음부터 다시 하며, 다시 시도에는 횟수 한도를 둔다.

### 질문 5: 데드락 줄이기(락 순서, 격리 수준)

- 사람의 질문(원문): "데드락을 줄인다는게 무슨 말이야? 예방하는걸 말하는거야?"
- 에이전트 설명: 질문 4는 생긴 데드락을 끝내는 것이고 질문 5는 애초에 덜 생기게 하는 것이라고 풀었다(매뉴얼 절 제목 [How to Minimize and Handle Deadlocks](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html)의 minimize). 데드락 예방(deadlock prevention)은 네 조건 가운데 하나가 성립할 수 없게 해 아예 생기지 않게 하는 것이고, 줄이기는 예방을 포함한다고 답했다. 어느 방법이 어느 쪽인지는 말하지 않았다.
- 사람의 답(원문): "행에 대한 접근 순서를 고정하는 방법이 하나가 있었어. / 이건 행에 대한 락 획득 순서를 결정하는 거니까 락 순서 관점이라고 생각해. / 격리 수준을 올리면 오히려 데드락이 걸릴 확률이 높아져. / 아예 격리 수준을 낮춰서 락을 덜 사용하거나 사용하지 않게 하면 상호 배제나 점유 대기 등과 같은 데드락 조건을 만족하는 상황이 생기지 않아서 데드락 발생을 줄일 수 있을거라 생각해. / 장면은 떠오르지 않아"
- 에이전트 피드백: 락 순서는 맞다(매뉴얼: "When modifying multiple tables within a transaction, or different sets of rows in the same table, do those operations in a consistent order each time. Then transactions form well-defined queues and do not deadlock."). 격리 수준을 올리면 늘어난다는 것도 맞다(2-1: READ COMMITTED·REPEATABLE READ 1213 0건, SERIALIZABLE 9건). 낮추면 줄어든다는 것은 반만 맞다. 높은 격리 수준이 더 걸던 락이 만들던 데드락만 없어지고, 모든 락이 빠지지는 않는다. 장면과 숫자가 없어 문제 상황 2, 2 이어서, 2-1을 처음 낸 글 그대로 다시 적고 맥 측정을 보였다.
- 왜? 1(에이전트): (1) 락 순서를 고정하면 왜 데드락이 생길 수 없나, 네 조건 가운데 무엇이 성립할 수 없게 되나 (2) READ COMMITTED로 낮추면 문제 상황 2의 데드락도 없어지나.
- 사람의 답(원문): "1. 락 순서를 고정하면 한 쪽 트랜잭션은 이미 다른 트랜잭션이 보유한 락을 먼저 요청하게 되기 때문에 점유대기가 불가능해져서 데드락이 생길 수 없어. 2. 데드락이 없어지지 않아. UPDATE를 호출하면서 배타락 모드에서 id 1,2에 대한 레코드 락을 각 트랜잭션이 서로에게 요청하게 되니까"
- 에이전트 피드백(설명): (2)는 맞다. READ COMMITTED에서 빠지는 것은 갭 락이고 쓰기의 레코드 락은 남는다([Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html): "For locking reads (SELECT with FOR UPDATE or FOR SHARE), UPDATE statements, and DELETE statements, InnoDB locks only index records, not the gaps before them, ..."). 컨테이너 확인(판정용 아님)에서도 READ COMMITTED 이체는 REPEATABLE READ와 같았다(탐지 켬: B가 바로 1213, 900, 1100 / 탐지 끔: A가 5.0초 뒤 1205, 1000, 900). (1)의 점유 대기는 이 두 문장 장면에서만 맞다. B의 첫 요청이 A가 보유한 id 1이라 B는 아무 락도 보유하지 않고 기다렸다. 일반적인 답은 순환 대기다. 컨테이너 확인(판정용 아님)의 세 계좌 예(1·2·3 각 1000, A는 1→2, B는 2→3, 둘 다 작은 id부터)에서 A는 id 1의 락을 보유한 채 id 2를 기다려 점유 대기가 생겼지만, 기다림이 늘 더 큰 id 쪽으로만 향해 고리가 생기지 않았다(데드락 없음, 900, 1000, 1100).
- 왜? 2(에이전트): 문제 상황 3과 (가) 처음 판, 두 요청 순서표를 질문 3 때와 같은 글로 다시 적고 물었다. (1) 같은 순서로 같은 자리에 락을 요청했는데 데드락이 났다. 이체에서 통한 락 순서 고정이 왜 여기서는 통하지 않나 (2) (가) 처음 판 10건을 READ COMMITTED로 보내면 1213 수, rewards 행 수, 잔액은.
- 사람의 답(원문): "1. 이체에서는 서로 다른 행에 대한 락을 서로가 대기하면서 발생한 데드락이라면 이번 데드락은 같은 행에 대한 락을 기다리기 때문이야. 2. RC에서는 갭락을 사용하지 않기 때문에 INSERT 문이 바로 실행될 수 있어. 그래서 1213은 발생하지 않고 rewards 행수는 10개 잔액은 10000으로 변경될거야."
- 에이전트 피드백(설명): (2)는 숫자까지 맞다(컨테이너 확인(판정용 아님): 1213 0건, 10행, 10000, 두 요청으로 줄이면 락은 표 락 `IX`뿐). 데드락은 없어지지만 갭 락이 막던 두 번 지급도 막지 못한다. 질문 2의 얻는 것과 대가가 한 장면에 있다. (1)은 반만 맞다. 같은 자리라는 차이는 맞지만, 같은 자리를 같은 순서로 잠그면 보통은 첫 락에서 줄이 서므로 그것만으로는 까닭이 되지 않는다. supremum 락은 사실상 갭 락이고 갭 락끼리는 호환되어 두 요청이 첫 락을 함께 보유한 채 지나갔고, 둘 다 삽입 의도 락을 요청하면서 상대의 갭 락과 충돌해 고리가 생겼다. 락 순서 고정은 첫 락에서 뒤 트랜잭션이 기다려야 통한다. (가) 고친 판처럼 이미 있는 points 행을 맨 앞에서 `FOR UPDATE`로 잠그면 첫 문장에서 줄이 선다(맥: 1행, 1000, 오류 없음).

### 질문 6: 낙관적 락과 비관적 락

- 사람의 답(원문): "낙관적 락은 좀 더 느슨하다고 밖에 표현이 안되네. 비관적 락은 어떤 상황이 필수적으로 발생할 것이라 생각해서 그 상황 자체를 차단하는 락을 설정하는 걸로 기억하는데 어떤 상황인지 기억이 안 나."
- 에이전트: 비관적 락의 뼈대(생길 거라 보는 상황을 미리 막는 락)는 맞다고 하고, 문제 상황 3을 처음 낸 글 그대로 다시 적되 세 방법의 정의는 이 질문의 답이라 뺐다. (가) 고친 판과 (나) 최종판의 SQL, 맥 측정((가) 1행·1000·이미 받음 9·다시 시도 0, (나) 1행·1000·version 1·이미 받음 9·다시 시도 9)을 보이고, 9건이 각 판에서 어떤 과정을 거쳤는지 따져 두 방법의 차이를 물었다.
- 사람의 답(원문): "비관적 락은 같은 요청이 중복으로 시작되는 걸 차단해. / 낙관적 락은 같은 요청이 중복으로 시작되는건 허용하지만 한 번을 초과해서 반영되진 않게 해." (보낸 직후 "한 번 이상"을 "한 번을 초과해서"로 고침)
- 에이전트 피드백: 장면에서 본 차이는 맞다. 비관적 락은 9건을 첫 문장에서 기다리게 했고, 낙관적 락은 다 진행시킨 뒤 마지막 확인에서 걸러 냈다. 컨테이너 확인(판정용 아님, 두 요청)으로 과정을 보였다. (가)는 B의 첫 `FOR UPDATE`가 A의 `COMMIT`까지 기다린 뒤 COUNT 1을 보고 `ROLLBACK`했다. (나)는 둘 다 version 0·COUNT 0을 읽고 `INSERT`까지 한 뒤, B의 version `UPDATE`가 A의 `COMMIT`까지 기다렸다가 0행이 되어 자기 `INSERT`를 되돌리고 다시 시도했다. 두 가지를 다듬었다. (1) "같은 요청의 중복"은 이 장면의 모습이고 일반적으로는 충돌(그사이 다른 트랜잭션이 같은 데이터를 바꿈)이다. 비관적 락은 충돌이 날 거라 보고 읽기 전에 잠가 기다리게 하고, 낙관적 락은 드물 거라 보고 잠그지 않고 진행하다 쓸 때 version으로 확인해 바뀌었으면 되돌리고 다시 한다. (2) 낙관적 락도 쓰는 `UPDATE`에서는 배타 락을 건다(B가 version `UPDATE`에서 기다림).
- 왜? 1(에이전트): (1) 이 장면처럼 같은 요청이 같은 순간 몰리면 둘 중 무엇이 낫고 왜 (2) 어떤 상황이면 다른 쪽이 나은가.
- 사람의 답(원문): "1. '낫다'는 기준은 잘 모르겠지만, 나라면 낙관적 락을 선택할거야. 그 이유는 같은 요청이 순간에 몰려도 다른 요청이 대기하지 않으면서 데이터 정합성에도 문제가 생기지 않아서 요청을 비관적 락에 비해 빠르게 처리할 수 있어서 리소스를 덜 쓸 수 있으니까. 2. 커넥션 풀 사이즈가 작아서 동시에 처리할 요청 수가 아예 적은 상황이라면 비관적 락으로 인해 대기시간이 길어져도 사실 낙관적 락을 사용해서 병렬로 처리할 때랑 비슷한 시간이 걸린다면 비관적 락을 사용해서 잘못된 작업을 원천적으로 차단할 수 있다고 생각해."
- 에이전트 피드백(설명): (1)은 빗나갔다. "대기하지 않음"은 (나)도 version `UPDATE`에서 기다렸고, "빠름"은 맥 요청 시간 최대 (나) 66~74ms와 (가) 72~78ms로 몇 ms 차이였으며(일이 50ms로 작아서), "리소스를 덜"은 반대였다((나)는 10건이 모두 `INSERT`까지 하고 9건이 그 일을 버린 뒤 다시 시도했고, (가)의 9건은 `INSERT` 없이 끝났다). 기준은 충돌이 얼마나 자주 나는가다. Martin Fowler의 P of EAA 카탈로그는 여러 요청에 걸친 업무 트랜잭션을 다루지만 같은 기준을 적는다. [Optimistic Offline Lock](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html): "Whereas Pessimistic Offline Lock assumes that the chance of session conflict is high and therefore limits the system's concurrency, Optimistic Offline Lock assumes that the chance of conflict is low." / [Pessimistic Offline Lock](https://martinfowler.com/eaaCatalog/pessimisticOfflineLock.html): "Since the conflict is only detected at the end of the business transaction, the victims will do all the transaction work only to find at the last minute that the whole thing will fail and their time will have been wasted." 이 장면은 10건에 지급 1건으로 충돌이 확실해 비관적 락이 맞다. (2)는 반만 맞다. 기다림이 짧으면 비관적 락의 약점이 작아진다는 것은 맞지만, "잘못된 작업을 원천적으로 차단"은 차이가 아니다(둘 다 1행, 1000). 낙관적 락이 나은 것은 충돌이 드물고 읽은 뒤 쓰기까지 오래 걸리는 경우(사람이 화면에서 몇 분 고치는 편집)다.
- 왜? 2(에이전트): 시작 전(2026-11-03)에 사람이 처음 고친 (나)(version을 상수 0과 비교)를 다시 적고, 처음 행이 (7, 0, 3)이면 rewards 행 수와 잔액은 얼마인지, version을 상수가 아니라 처음 읽은 값과 비교해야 하는 까닭은 무엇인지 물었다.
- 사람의 답(원문): "1. 행 수는 0개고 잔액도 0이야. 2. 처음 읽은 값이 해당 상수가 아니라면 처리되어야 할 한 번의 요청도 처리되지 않기 때문이야."
- 에이전트 피드백: 둘 다 맞고 (1)은 숫자까지 맞다(맥 `reward-version-const-v3` 0행·0, 시작 전 예상 10행·10000에서 빗나갔던 것). 까닭을 보탰다. 낙관적 락이 확인하는 것은 "내가 읽은 뒤로 아무도 바꾸지 않았나"라서 비교할 값은 읽은 version이다. 확인과 쓰기를 `UPDATE` 한 문장에서 하면 그 행의 배타 락을 보유한 채 최신 행으로 `WHERE`를 따지므로 사이에 틈이 없다.

### 질문 7: 재고 차감, 중복 지급, 중복 예약 막기

- 사람의 질문(원문): "방금 질문 6에서 논의했던 낙관적 락이랑 비관적 락으로 막는거 아니었어?"
- 에이전트 설명: 둘 다 막는 방법이 맞고, 질문 6은 두 방법의 차이와 고르는 기준, 질문 7은 경우마다 막는 방법 자체를 고르는 것이라고 풀었다. 세 경우는 막아야 하는 것이 조금씩 달라 맞는 방법도 다르고, 두 락 말고 다른 방법이 있으면 넣어 달라고 했다. 경우를 구체적으로 다시 냈다(셋 다 REPEATABLE READ). (1) 재고 차감: `products (id INT PRIMARY KEY, stock INT NOT NULL)`에 (1, 5), 1개씩 주문 10건 동시, 5건만 성공하고 음수는 안 됨 (2) 중복 지급: user 7에게 같은 이벤트 리워드 1000포인트 요청 10건 동시, 한 번만 (3) 중복 예약: 비어 있는 `bookings (id INT AUTO_INCREMENT PRIMARY KEY, show_id INT NOT NULL, seat VARCHAR(8) NOT NULL, user_id INT NOT NULL)`, 공연 1의 좌석 'A-1'에 서로 다른 두 사용자가 동시에 예약, 한 명만.
- 사람의 답(원문): "잘 모르겠어."
- 에이전트: 물음을 나눴다. 문제 상황 3을 처음 낸 글 그대로 다시 적고 맥의 세 판((가) 고친 판, (나) 최종판, (다) 유니크: 모두 1행·1000)을 보인 뒤 물었다. (1) (다)는 `FOR UPDATE`도 version도 없는데 무엇이 두 번째 행을 막았나, 중복 예약에 쓰려면 bookings 표를 어떻게 바꾸나 (2) 재고가 남았는지 확인하는 것과 1 줄이는 것을 `UPDATE` 한 문장에 넣으려면 어떻게 쓰고, 0행이면 앱은 무엇을 하나.
- 사람의 답(원문, 다음 날): "1. 인덱스의 unique key 제약이 두 번째 행 추가를 막았어. bookings가 어딨어? 2. 갑자기 재고는 어디서 나온거야?"
- 에이전트 피드백: (1)의 앞 절반은 맞다. UNIQUE KEY가 같은 (7, 1)의 두 번째 행을 1062로 거부했고(맥 9건), 앱의 확인 코드가 틀려도 DB가 막는다. bookings와 재고는 전날 메시지에 넣은 경우를 다음 날 "앞 메시지"라고만 가리켜 사람이 찾지 못했다. 에이전트의 잘못이라 두 경우를 그대로 다시 적고, 재고 차감은 실험에서 직접 재지 않았으며 가장 가까운 장면은 문제 상황 2-1이라고 밝힌 뒤 2-1도 다시 적었다.
- 사람의 답(원문): "1. user_id를 인덱스로 만들로 UNIQUE KEY 제약을 걸어야 해. 2. update products set stock = stock - 1 where id = 1 and stock > 0; / update가 0행이면 앱을 사용자에게 재고가 없다고 할거 같아."
- 에이전트 피드백: (2)는 맞다. 확인과 쓰기가 한 문장이라 그 행의 배타 락을 보유한 채 최신 값으로 `WHERE`를 따진다. 컨테이너 확인(판정용 아님, 2-1과 같은 points 표에 10건 동시, 100씩 차감)에서 처음 잔액 500이면 "읽은 값 − 100"은 400, `FOR UPDATE`로 읽기만 하면(확인 없음) -500, 조건부 `UPDATE`는 5건 성공·5건 0행·잔액 0이었다. 0행이면 "재고 없음"이 맞고, 같은 트랜잭션의 다른 변경은 `ROLLBACK`한다. (1)은 빗나갔다. 유니크 키는 "두 번 생기면 안 되는 것"에 건다. 같은 공연의 같은 좌석이라 `UNIQUE KEY (show_id, seat)`이고, user_id에 걸면 서로 다른 사용자의 두 예약이 다 들어가고 한 사용자의 다른 좌석까지 막는다. 리워드의 (user_id, event_id)는 "한 사람이 이벤트마다 한 번"이라는 규칙이라 맞았던 것이다.
- 왜?(에이전트): (1) bookings에 유니크 키 없이 비관적 락으로 막으려면 무엇을 잠그나(예약 전 bookings는 비어 있음) (2) 재고 차감을 조건부 `UPDATE` 대신 질문 6의 낙관적 락(version)으로 하면 10건 동시일 때 무엇이 달라지나.
- 사람의 답(원문): "1. 특정 seat에 대한 insert를 잠궈야 해. 그 이유는 같은 자리에 둘 이상의 예약이 추가되면 안되기 때문이야. 2. 실패하는 재고 차감 요청 9개가 성공하는 요청 1개가 끝날때까지 대기하기 때문에 요청에 대한 응답이 느릴거라 생각해"
- 에이전트 피드백(설명): 둘 다 반만 맞다. (1) 막을 대상(그 좌석의 `INSERT`)은 맞다. 그런데 빈 표에는 잠글 행이 없어 `FOR UPDATE`는 그 좌석이 들어갈 갭(빈 표면 supremum 앞)을 잠그고, 갭 락끼리는 호환되어 두 요청이 함께 보유한 뒤 두 `INSERT`의 삽입 의도 락이 서로의 갭 락과 충돌해 데드락이 난다(컨테이너 확인(판정용 아님): 1건 예약·1213 1건). 줄을 세우려면 이미 있는 행을 잠가야 한다. 좌석 행을 미리 만들어 두고 `UPDATE seats SET user_id = ? WHERE show_id = 1 AND seat = 'A-1' AND user_id IS NULL`로 하면 재고 차감과 같은 모양이 된다(컨테이너 확인: 1건 예약·1건 이미 예약됨·오류 없음). (2) 느려진다는 것은 맞고, 까닭은 기다림이 아니라 다시 시도다. 컨테이너 확인(판정용 아님, 재고 5에 주문 10건, 0행이면 처음부터 최대 3번)에서 조건부 `UPDATE`는 5건 성공·5건 거절·재고 0·다시 시도 0·중앙값 56ms였고, 낙관적 락은 4건 성공·6건 포기·재고 1·다시 시도 24·중앙값 약 212ms였다. 매번 한 건만 version 확인을 통과해(9 + 8 + 7 = 24번 다시 시도) 한도 때문에 재고가 남았는데도 6건이 포기했다. 낙관적 락이 보는 조건("그사이 바뀌었나")과 재고에 필요한 조건("남았나")이 다르다.

### 질문 8: 커넥션 풀

- 사람의 답(원문): "커넥션의 개수를 제한하고 커넥션 생성 비용을 배제해서 리소스를 효율적으로 사용하기 위함이야. 크기를 정하는 방법은 몰라."
- 에이전트 피드백: 까닭 둘은 맞다(첫 해석과 같은 답). 숫자를 붙였다. 한 건씩 새로 연결 + `SELECT 1`은 9.25~9.63ms, 풀에서 빌리기 + `SELECT 1`은 0.31~0.32ms(약 30배)였고, `NullPool` 50건 동시는 서버 새 연결 50·동시 최대 51, 풀 5는 동시 최대 7이었다. 크기는 문제 상황 4를 처음 낸 글 그대로 다시 적고 묶음 ④ 표를 보인 뒤 물음을 나눴다. 1. 다 끝나는 시간이 `pool_size`와 연결을 보유하는 200ms로 어떻게 정해지나, 50건이 0.5초 안에 끝나려면 `pool_size`는 최소 얼마인가 2. 늘 넉넉하게(예: 200) 잡으면 되나("커넥션의 개수를 제한"과 이어서).
- 사람의 답(원문): "1. 어떻게 정해지냐는게 무슨말이야? 전체 요청 수 / pool_size * 200ms가 전체 소요시간을 계산하는 식이야. 25개여야 해. 2. 늘 넉넉하게 잡아두게 되면 항상 그 pool_size를 유지하는 메모리만큼을 사용하고 있다는 뜻이기 때문에 메모리가 여유가 있다면 상관없지만 부족하다면 다른 작업을 수행할 리소스가 부족하게 될거야."
- 에이전트 피드백(설명): 1은 숫자까지 맞다("어떻게 정해지나"는 그 식을 물은 것이라고 답했다). 정확히는 차례 수를 올림해야 한다(풀 30이면 333ms가 아니라 두 차례 400ms). 맥은 차례마다 조금씩 더 걸려 풀 5가 2.09~2.10초였다. 2는 반만 맞다. 메모리는 맞는 대가인데, 크게 드는 곳은 DB 서버다([Connection Interfaces](https://dev.mysql.com/doc/refman/8.4/en/connection-interfaces.html): "Connection manager threads associate each client connection with a thread dedicated to it that handles authentication and request processing for that connection." / "Also, each thread requires server and kernel resources, such as stack space."). 메모리보다 먼저 닿는 한도는 `max_connections`(이 맥 서버 151)이고, 풀은 넘는 요청을 `pool_timeout`까지 앱 안에서 줄 세우지만 서버 한도를 넘는 연결은 기다리지 않고 1040(Too many connections)을 받는다(재지 않음). 풀 200이면 몰릴 때 한 대가 151을 다 쓸 수 있고, 웹 서버가 여러 대면 풀 크기의 합이 151 안에 들어야 한다. 풀 50은 서버 동시 연결이 51로 `NullPool`과 같아, 키울수록 "개수 제한"이라는 이득이 사라진다. "항상 유지"는 고쳤다. `QueuePool`은 연결 없이 시작해 한 번 요청된 수만큼을 보유한다(SQLAlchemy 2.1.8 `pool_size` 설명: "Note that the pool begins with no connections; once this number of connections is requested, that number of connections will remain."). 실험은 측정 전에 풀을 미리 데웠다.
- 왜?(에이전트): `pool_size` 5를 그대로 두고 50건이 다 끝나는 시간을 줄이려면 코드를 어떻게 바꾸나(200ms는 트랜잭션 안에서 외부 API 응답을 기다리는 시간), 그렇게 바꾸면 왜 빨라지나.
- 사람의 답(원문): "외부 api를 응답을 기다리는 코드를 트랜잭션 밖으로 꺼내거나 트랜잭션을 해제하면 소요시간은 줄어들어. 외부 api를 호출하고 대기하는 동안 db와의 커넥션을 유지할 필요가 없기 때문이야."
- 에이전트 피드백: 맞다. 하나만 보탰다. 연결을 빌리는 곳은 `conn.begin()`이 아니라 `with engine.connect()`라서, 트랜잭션만 끝내고 같은 블록 안에서 기다리면 연결은 그대로 보유한다. API 호출을 연결을 빌리기 전이나 돌려준 뒤로 옮기면 식의 200ms 자리가 1ms 안팎(풀에서 빌리기 + `SELECT 1` 0.31~0.32ms)이 되어, 풀 5로도 연결을 쓰는 몫은 약 10ms이고 다 끝나는 시간은 API 기다림 200ms에 가까워진다(식으로 셈, 재지 않음). 트랜잭션을 연 채 기다리면 행 락도 커밋까지 보유한다.

### 목표 3 확인: 처음 보는 상황 3개

- 에이전트: 리워드와 좌석은 질문 6·7에서 깊게 다뤄, 옮겨 쓰는지 보려고 처음 보는 세 상황을 냈다. 셋 다 MySQL 8.4, REPEATABLE READ, 요청마다 트랜잭션 하나이고, 비관적 락·낙관적 락·유니크 제약·`UPDATE` 한 문장(필요하면 `WHERE`에 조건) 가운데 고르거나 섞게 했다. 상황마다 고를 방법과 요청 SQL, 결과를 보고 앱이 할 일, 바꿀 표, 고른 근거를 물었다.
  - 상황 1(선착순 쿠폰 100장): `coupons (id INT PRIMARY KEY, remaining INT NOT NULL)`에 (1, 100), 비어 있는 `coupon_issues (id INT AUTO_INCREMENT PRIMARY KEY, coupon_id INT NOT NULL, user_id INT NOT NULL)`. 여는 순간 요청 수천 건이 몰리고 같은 사용자가 버튼을 여러 번 누르기도 한다. 100장보다 많이 나가면 안 되고, 한 사람은 한 장만 받아야 한다.
  - 상황 2(게시글 수정): `posts (id INT PRIMARY KEY, body TEXT NOT NULL)`. 두 사람이 같은 글을 편집 화면에 열어 몇 분 동안 고친 뒤 저장한다. 열 때 `SELECT body FROM posts WHERE id = 1;`, 저장할 때 `UPDATE posts SET body = ? WHERE id = 1;`이고, 열기와 저장은 서로 다른 HTTP 요청이다. 같은 글을 동시에 고치는 일은 드물고, 뒤에 저장한 사람이 앞사람의 수정을 모르고 덮어쓰면 안 된다.
  - 상황 3(조회수 올리기): `posts (id INT PRIMARY KEY, views INT NOT NULL)`에 (1, 0). 인기 글 하나에 1초에 수백 번 조회가 들어오고, 지금 코드는 한 트랜잭션에서 `SELECT views FROM posts WHERE id = 1;`로 읽은 값 + 1을 `UPDATE posts SET views = ? WHERE id = 1;`로 쓴다. 조회 횟수가 빠지면 안 된다.
- 사람의 답(원문): "유니크 제약, 낙관적 락 / `UNIQUE KEY user_id INT NOT NULL` / `UPDATE coupons SET remaining = remaining - 1 WHERE remaining > 0;` / duplicated key 에러가 발생하면 앱은 쿠폰을 발급하지 않는다. 1. 쿠폰이 중복 발행되면 안되기 때문에 유니크 제약이 필요함 2. 쿠폰 발행 수가 100장을 넘어가면 안되기 때문에 낙관적 락이 필요함 / --- / 비관적 락 / `SELECT body FROM posts WHERE id = 1 FOR UPDATE;` / 비관적 락으로 인해 뒤에 저장을 시도한 사람의 쓰기가 실패하면 사용자에게 쓰기가 실패했다고 알림 1. 사용자가 자신의 쓰기가 실패했다는걸 알아야하기 때문에 / --- / 그냥 update 문에서 최신값 조회랑 조회수 1 증가를 같이 처리하면 views를 중복 조회할 일도 없는거 아니야? / `UPDATE posts SET views = ? WHERE id = 1;`"
- 에이전트 피드백(상황 1): 짝(유니크 제약 + `UPDATE` 한 문장)은 맞다. 고칠 것이 넷이었다. 유니크 키는 (coupon_id, user_id)다(user_id만이면 같은 사람이 다른 쿠폰을 받지 못한다). `UPDATE`에 `id = 1`이 빠졌다. 그 문장은 낙관적 락이 아니라 조건부 `UPDATE`다. version으로 "그사이 바뀌었나"를 보지 않고, 배타 락 아래 최신 행에서 "남았나"를 봐 줄을 선 순서대로 남은 만큼 성공한다(질문 7의 컨테이너 확인 재고 표를 다시 보였다). 0행이면 `ROLLBACK`해 먼저 넣은 발급 기록도 함께 취소하고 "마감"으로 알린다.
- 에이전트 피드백(상황 2): 빗나갔다. 열기와 저장이 다른 요청이라 열 때 건 `FOR UPDATE` 락은 그 요청이 커밋할 때 해제되어, 두 `UPDATE`가 모두 성공하고 뒤 사람이 덮어쓴다. 락을 저장까지 이어 가려면 트랜잭션을 몇 분 열어 두어 그동안 연결과 행 락을 보유해야 하고(질문 8), 두 번째 사람은 `FOR UPDATE`에서 락 대기 한도(이 맥 서버의 `innodb_lock_wait_timeout` 50초)가 지나 오류를 받는다. 답에 쓴 "저장이 실패하면 알림"은 낙관적 락의 동작이다([Optimistic Offline Lock](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html): "The expectation that session conflict isn't likely allows multiple users to work with the same data at the same time.").
- 에이전트 피드백(상황 3): 방향은 맞다. 지금 코드는 2-1과 같은 갱신 손실(맥: 1000에서 "읽은 값 − 100" 10건 → 900)이다. 답의 `views = ?`는 여전히 앱이 계산한 값이라, `UPDATE posts SET views = views + 1 WHERE id = 1`로 써야 배타 락 아래 최신 값에 더한다. 낙관적 락이면 다시 시도만 쌓이고, 비관적 락은 결과는 같지만 문장이 둘이라 락 보유가 길어진다.
- 다시 쓰기(에이전트): 상황 2를 낙관적 락으로 다시 써 달라고 했다(표에 더할 것, 편집 화면을 열 때와 저장할 때의 SQL, 저장이 0행일 때 앱이 할 일).
- 사람의 답(원문): "그러면 테이블이 바뀌어야겠네. attribute로 version INT NOT NULL을 추가하자. / `UPDATE posts SET body = ? WHERE id = 1 and version = ?; / 저장이 0행이면 읽기도 안됐어야하는거 아니야?"
- 에이전트 피드백(설명): version 열과 `WHERE`의 version 확인은 맞다. version을 올리지 않아 막지 못한다. A와 B가 둘 다 0을 읽으면 A가 저장해도 version은 0 그대로라 B도 `version = 0`으로 성공해 덮어쓴다. 열 때 `SELECT body, version FROM posts WHERE id = 1`, 저장할 때 `UPDATE posts SET body = ?, version = version + 1 WHERE id = 1 AND version = ?`(뒤의 ?는 열 때 읽은 값)로 쓴다. 0행이면 "다른 사람이 먼저 고쳤다"고 알리고 최신 글과 새 version을 보여 줘 사람이 합친 뒤 다시 저장하게 한다(자동 다시 시도가 아님). 읽기까지 막을 필요는 없다. 낙관적 락은 읽기를 막지 않는 것이 핵심이고, 진 쪽은 한 일을 마지막에 버리는 값을 치른다. 읽기부터 막아야 한다면 DB 락이 아니라 앱이 "편집 중" 기록을 두는 방법(Pessimistic Offline Lock)을 쓴다.

### 목표 1 확인: 처음 보는 순서표 2개

- 에이전트: 두 세션이 번갈아 문장을 보내고 데드락 탐지는 켜져 있다. 순서표마다 REPEATABLE READ와 READ COMMITTED 각각에서 (1) 2·4·5·6번이 바로 끝나는지 기다리는지, 오류면 무슨 오류이고 어느 세션이 되돌려지는지 (2) 끝난 뒤 표 (3) 그 까닭을 어느 락이 무엇과 충돌하거나 호환되는지로 물었다.
  - 순서표 1(회의실 예약, COUNT가 0이면 `INSERT`): `reservations (id INT PRIMARY KEY, room INT NOT NULL, slot INT NOT NULL, KEY idx_room_slot (room, slot))`에 (1, 7, 9), (2, 7, 13). 1번 A `START TRANSACTION;` → 2번 A `SELECT COUNT(*) FROM reservations WHERE room = 7 AND slot = 11 FOR UPDATE;` → 3번 B `START TRANSACTION;` → 4번 B 같은 `SELECT ... FOR UPDATE` → 5번 A `INSERT INTO reservations (id, room, slot) VALUES (3, 7, 11);` → 6번 B `INSERT INTO reservations (id, room, slot) VALUES (4, 7, 11);` → 7번 A `COMMIT;` → 8번 B `COMMIT;`
  - 순서표 2(같은 계좌를 공유 락으로 읽고 고치기): `accounts (id INT PRIMARY KEY, balance INT NOT NULL)`에 (1, 1000). 1번 A `START TRANSACTION;` → 2번 A `SELECT balance FROM accounts WHERE id = 1 FOR SHARE;` → 3번 B `START TRANSACTION;` → 4번 B 같은 `FOR SHARE` → 5번 A `UPDATE accounts SET balance = 900 WHERE id = 1;` → 6번 B 같은 `UPDATE` → 7번 A `COMMIT;` → 8번 B `COMMIT;`
- 사람의 답(원문): "RC: 바로 끝나. 결과는 예약이 두 번 삽입되어서 (3, 7, 11), (4, 7, 11)이 추가될거야. 그 이유는 RC에서는 갭락을 사용하지 않기 때문에 두 트랜잭션에서의 삽입 의도락을 충돌없이 얻어지고 두 insert 문 모두 받아들여져. / RR: 5에서 기다려. 데드락 타임아웃 오류가 발생하고 세션 A가 먼저 대기하기 때문에 세션 A가 오류가 발생하고 되돌려져. 그리고 세션 B는 삽입 작업을 수행해. 작업이 끝나면 (4, 7, 11) 예약 행이 하나 추가될거야. 이런 현상이 발생하는 이유는 RR에서는 갭락을 사용하고 2, 4 순서에서 (7, 11) idx_room_slot 인덱스를 찾다가 (2,7,13)에서 해당 인덱스를 찾을 수 없다는걸 알고 (2,7,13)행에 갭 락을 걸어. 그러면 insert 문에서 데이터를 삽입할 위치에 갭락이 걸리기 때문에 삽입 의도락을 요청하다가 데드락이 발생해. / --- / 두 격리수준 기다릴거야. 그리고 세션 A에서 데드락 타임아웃 오류가 발생해서 롤백될거야. 그 결과 밸런스는 900이 될거야. / 이런 현상이 발생하는 이유는 같은 행을 조회하고 수정하려다 보니 레코드락 충돌이 발생하면서 5,6 작업을 수행하기 위해서 서로의 트랜잭션에서 레코드락을 해제하기를 대기하게 되기 때문이야."
- 에이전트 피드백: 컨테이너 확인(판정용 아님, 워밍업 뒤 3회 모두 같음) 결과는 아래 표와 같았다. `data_locks`는 순서표 1 REPEATABLE READ에서 4번 뒤 A와 B 모두 `idx_room_slot`의 (7, 13, 2)에 `X,GAP` GRANTED, 5번 뒤 A의 `X,GAP,INSERT_INTENTION` WAITING이었고, READ COMMITTED는 표 락만 있었다. 순서표 2는 4번 뒤 A와 B 모두 `PRIMARY` 1에 `S,REC_NOT_GAP` GRANTED, 5번 뒤 A의 `X,REC_NOT_GAP` WAITING이었다.

| 순서표 | 격리 수준 | 2·4번 | 5번 | 6번 | 끝난 뒤 |
|---|---|---|---|---|---|
| 1 회의실 | REPEATABLE READ | 둘 다 바로 0 | 기다림 | 바로 1213, B 되돌림 → A의 5번 끝남 | (1, 7, 9), (2, 7, 13), (3, 7, 11) |
| 1 회의실 | READ COMMITTED | 둘 다 바로 0 | 바로 | 바로 | 네 행, (3, 7, 11)과 (4, 7, 11) 둘 다 |
| 2 계좌 | 두 격리 수준 같음 | 둘 다 바로 1000 | 기다림 | 바로 1213, B 되돌림 → A의 5번 끝남 | 900 |

- 에이전트 피드백(이어서): 순서표 1의 READ COMMITTED는 결과와 까닭(갭 락이 없어 두 `INSERT`가 다 들어감)까지 맞았다. REPEATABLE READ에서 5번이 기다린다는 것, 데드락이 난다는 것, 갭 락이 (2, 7, 13) 앞 갭에 걸린다는 것, 4번이 기다리지 않는다는 것도 맞았다. 순서표 2가 두 격리 수준에서 같다는 것, 데드락, 잔액 900도 맞았다. 고칠 것은 셋이었다. (1) 데드락과 락 대기 시간 초과는 다른 오류다. 탐지가 켜져 있으면 고리를 닫는 6번이 들어오는 순간 바로 1213을 주고 트랜잭션 전체를 되돌린다. 1205는 고리 없이 오래 기다릴 때 락 대기 한도가 지나서 나고 기다리던 문장 하나만 되돌린다. (2) 먼저 기다린 쪽이 되돌려지는 것이 아니다([Deadlock Detection](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlock-detection.html): "InnoDB tries to pick small transactions to roll back, where the size of a transaction is determined by the number of rows inserted, updated, or deleted."). 두 순서표 모두 A와 B가 아직 바꾼 행이 없어 크기가 같았고, 컨테이너에서는 세 번 모두 고리를 닫은 B가 되돌려졌다(크기가 같을 때의 규칙은 문서에서 확인하지 못했다). 그래서 순서표 1 REPEATABLE READ에는 B의 (4, 7, 11)이 아니라 A의 (3, 7, 11)이 남는다. (3) 순서표 2의 까닭은 모드까지 써야 한다. `FOR SHARE`는 공유 락이라 서로 호환되어 2·4번이 바로 끝나고, 5번에서 A의 배타 락이 B의 공유 락과 충돌해 기다리며, 6번에서 B의 배타 락이 A의 공유 락과 충돌하면서 고리가 닫힌다.
- 왜?(에이전트): 순서표 1의 REPEATABLE READ에서, 4번의 B는 A가 이미 갭 락을 건 같은 갭((7, 13, 2) 앞)에 갭 락을 요청했는데 기다리지 않고 바로 끝났다. 왜 그런가.
- 사람의 답(원문): "갭락 끼리는 서로 호환되기 때문이야."
- 에이전트 피드백: 맞다. 시작 전 기록(문제 상황 1-2), 첫 해석, 질문 3·5·7에서 다섯 번 빠졌던 이 규칙을 처음 혼자 말했다. 갭 락은 그 갭에 들어오는 삽입만 막아, 충돌은 5·6번의 삽입 의도 락에서 처음 생긴다. 칸으로 세면 16칸 중 12칸을 맞혔다(순서표마다, 격리 수준마다 2·4번, 5번, 6번, 끝난 뒤의 네 칸. 순서표 2의 2·4번은 답에 직접 적지 않았지만 5·6번에서 처음 기다린다고 본 것으로 셈). 빗나간 4칸은 모두 6번과 그 뒤다. 데드락을 "데드락 타임아웃"이라 부르며 1205와 섞었고, 먼저 기다린 쪽이 되돌려진다고 봤다. 순서표 2의 까닭에는 S·X 모드가 빠졌다.

## 정리한 결론과 선택 기준

아래는 맥 본 측정(MySQL 8.4.13, Docker Desktop, M2 Pro)과 사람의 답을 대조해 정리한 결론이다. 시간은 워밍업을 뺀 세 번의 최솟값~최댓값이다. 학습 확인 피드백에서만 확인한 값은 "컨테이너 확인(판정용 아님)"으로 적었다. 이 기계와 설정 밖으로 숫자를 일반화하지 않는다.

| 상황 | 이번에 확인한 내용과 선택 기준 |
|---|---|
| 락끼리 충돌하는 때 | 락은 모드(S·X)와, 인덱스의 어디를 잠그는지(레코드, 갭, 넥스트 키, 삽입 의도)를 함께 가진다. 레코드를 잠그는 락끼리는 모드로 정해져 S끼리만 호환되고 X가 끼면 충돌한다. 갭 락끼리는 모드와 상관없이 호환되고, 갭 락은 그 갭에 들어오려는 삽입 의도 락과만 충돌한다. 그래서 같은 빈 범위를 `FOR UPDATE`로 잠근 두 요청은 둘 다 기다리지 않고 지나간 뒤 `INSERT`에서 데드락이 났다(③ 두 요청 순서표: 둘 다 supremum에 `X` GRANTED, B의 `INSERT`가 1213). 충돌하는 요청은 부여되지 않고 `data_locks`에 WAITING으로 남으니, 기다림은 그 표에서 누가 무엇을 보유하고 무엇을 요청했는지로 읽는다. |
| 평범한 읽기와 잠금 읽기 | READ COMMITTED·REPEATABLE READ의 평범한 `SELECT`는 락 없이 스냅숏을 읽어 배타 락을 기다리지 않는다. `FOR SHARE`·`FOR UPDATE`와 SERIALIZABLE의 평범한 `SELECT`는 최신 버전을 읽으며 락을 건다. 2-1의 SERIALIZABLE에서는 10건이 공유 락을 보유한 채 `UPDATE`로 배타 락을 요청해 9건이 1213을 받았고(최대 61~67ms), READ COMMITTED·REPEATABLE READ에서는 `UPDATE`끼리만 충돌해 1213 없이 하나씩 끝났지만 모두 "읽은 값 − 100"을 써서 잔액이 900인 갱신 손실이었다. |
| 갭 락과 넥스트 키 락 | REPEATABLE READ의 잠금 읽기는 훑은 인덱스 레코드마다 넥스트 키 락을 걸어 팬텀을 막는다. 갭 락은 삽입만 막지만 갭이 조건이 아니라 이웃한 두 레코드 사이의 범위라서, 조건에 맞지 않는 user 5·10의 `INSERT`까지 A의 `COMMIT`까지 기다렸다(문제 상황 1). 인덱스가 없으면 `PRIMARY` 전체와 supremum이 잠겨 표 끝의 삽입과 다른 행의 삭제도 기다렸다(1-1). READ COMMITTED는 갭 락을 걸지 않고, 조건에 맞지 않는 행의 레코드 락을 서버가 `WHERE`를 평가한 뒤 해제해 모두 바로 끝났지만 팬텀을 허용한다. 잠기는 범위를 줄이려면 조건에 맞는 인덱스를 둔다. |
| 데드락이 난 뒤 | 탐지가 켜져 있으면 고리를 닫는 요청이 들어오는 순간 1213을 주고 한쪽 트랜잭션 전체를 되돌린다(문제 상황 2 (가): 4번이 바로 1213, 900, 1100). 되돌릴 쪽은 먼저 기다린 쪽이 아니라 바꾼 행이 적은 작은 트랜잭션이고, 이번 순서표들은 크기가 같아 모두 고리를 닫은 B였다. 락 대기 시간 초과(1205)는 고리와 상관없이 한도(실험은 5초)가 지나면 기다리던 문장 하나만 되돌리고, 그 트랜잭션의 락과 앞 변경은 남는다((나): 5.03~5.04초 뒤 1205, 순서대로 `COMMIT`해 1000, 900의 반쪽 이체). 오류를 받은 앱은 `ROLLBACK`한 뒤 트랜잭션을 처음부터 다시 하고(1213은 이미 되돌려짐), 다시 시도에 횟수 한도를 둔다. 탐지를 켜도 고리 없는 긴 기다림을 끝내는 것은 시간 초과다. |
| 데드락 줄이기: 락 순서 | 모두 같은 순서로 락을 요청하면 기다림이 한 방향으로만 향해 순환 대기가 생기지 않는다(2 이어서: B의 첫 `UPDATE`가 1.42~1.44초 기다린 뒤 끝남, 오류 없음, 1000, 1000). 첫 락이 충돌해야 줄이 선다. 첫 락이 갭 락처럼 호환되면 같은 순서여도 둘 다 보유한 채 다음 락에서 고리가 생긴다(③ (가) 처음 판, 1213 ×9). 이미 있는 행(③에서는 points 행)을 맨 앞에서 `FOR UPDATE`로 잠그면 첫 문장에서 줄이 선다(`reward-parent-lock`: 1행, 1000, 오류 없음, 최대 72~78ms). |
| 데드락 줄이기: 격리 수준 | 올리면 락이 늘어 데드락도 늘었다(2-1: READ COMMITTED·REPEATABLE READ 1213 0건, SERIALIZABLE 9건). 낮추면 높은 격리 수준이 더 걸던 락이 만들던 데드락만 없어지고, 그 락이 막던 것도 함께 사라진다. ③ (가) 처음 판을 READ COMMITTED로 보내면 데드락 없이 10행, 10000으로 열 번 지급됐고, 쓰기의 레코드 락은 남아 반대 순서 이체의 데드락은 그대로였다(둘 다 컨테이너 확인, 판정용 아님). 낮추기 전에 그 락이 무엇을 막는지 본다. |
| 낙관적 락과 비관적 락 고르기 | 기준은 충돌이 얼마나 자주 나는가다. 비관적 락은 읽기 전에 잠가 진 쪽이 첫 문장에서 기다리고, 낙관적 락은 잠그지 않고 일한 뒤 쓸 때 version으로 확인해 진 쪽이 한 일을 버리고 다시 한다. ③에서는 둘 다 1행, 1000이었고 낙관적 락은 9건이 다시 시도했다. 충돌이 확실한 경합에는 비관적 락이나 유니크 제약을, 충돌이 드물고 읽은 뒤 쓰기까지 긴 편집에는 낙관적 락을 고른다. 낙관적 락도 쓰는 `UPDATE`에서는 배타 락을 건다. |
| 낙관적 락의 version | 읽을 때 version을 함께 읽고, 쓸 때 `SET ..., version = version + 1 WHERE ... AND version = (읽은 값)` 한 문장으로 확인하고 올린다. 0행이면 그사이 다른 트랜잭션이 바꾼 것이다. 상수와 비교하면 처음 값이 다를 때 아무도 쓰지 못하고(`reward-version-const-v3`: 0행, 0), 올리지 않으면 둘 다 같은 version으로 성공해 덮어쓴다. |
| 조건부 `UPDATE` | 확인과 쓰기를 `UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0` 같은 한 문장에 넣으면 배타 락 아래 최신 값으로 조건을 따져, 줄을 선 순서대로 남은 만큼 성공하고 나머지는 0행으로 거절한다. version으로 "그사이 바뀌었나"를 보는 낙관적 락과 다르다. 컨테이너 확인(판정용 아님, 재고 5에 주문 10건)에서 조건부 `UPDATE`는 5건 성공·재고 0·중앙값 56ms, version 낙관적 락(최대 3번 다시 시도)은 4건 성공·6건 포기·재고 1·다시 시도 24·약 212ms였다. 재고·쿠폰 수량·조회수(`views = views + 1`)처럼 이미 있는 한 행의 숫자를 바꾸는 일에 쓴다. |
| 유니크 제약 | 두 번 생기면 안 되는 것에 유니크 키를 건다(리워드 (user_id, event_id), 좌석 (show_id, seat), 쿠폰 (coupon_id, user_id)). 두 번째 `INSERT`는 1062를 받고 앱이 "이미 받음"으로 처리한다(`reward-unique`: 1행, 1000, 1062 ×9, 최대 61~73ms). 앱의 확인 코드가 틀려도 DB가 막는다. 유니크 키로 막지 못하는 겹치는 기간의 예약은 이번에 다루지 않았다. |
| 아직 없는 행을 비관적 락으로 막기 | 빈 범위를 `FOR UPDATE`로 잠그면 갭 락만 걸려 두 요청이 함께 보유하고, 두 `INSERT`가 데드락으로 끝난다(③ (가) 처음 판 1213 ×9, 같은 좌석 예약 2건도 컨테이너 확인에서 1213 1건). 줄을 세우려면 이미 있는 행(부모 행, 미리 만든 좌석 행)을 잠그거나, 행을 미리 만들어 `UPDATE seats SET user_id = ? WHERE ... AND user_id IS NULL`로 한다(컨테이너 확인: 1건 예약, 1건 이미 예약됨, 오류 없음). |
| 여러 요청에 걸친 수정 | 편집 화면을 열 때와 저장할 때가 다른 HTTP 요청이면, 열 때 건 DB 락은 그 요청이 끝날 때 해제되어 저장까지 이어지지 않는다. 트랜잭션을 열어 두면 그동안 연결과 행 락을 보유하고 다른 사람은 락 대기 한도까지 기다린다. version을 쓰는 낙관적 락으로 저장 때 확인하고, 0행이면 사람에게 알려 최신 글과 합치게 한다. 읽기부터 막아야 하면 앱이 "편집 중" 기록을 둔다(Pessimistic Offline Lock). |
| 커넥션 풀 크기 | 연결을 보유하는 시간이 같으면 다 끝나는 시간 ≈ 올림(요청 수 ÷ 풀 크기) × 보유 시간이다(50건·200ms: 풀 5 2.09~2.10초, 10 1.07초, 50 0.22초). 0.5초 안에 끝내려면 25 이상이다. 키우면 DB 서버의 연결이 는다. 연결마다 서버 스레드가 하나씩 붙고, `max_connections`(이 맥 서버 151)를 넘는 연결은 기다리지 않고 1040을 받는다(재지 않음). 웹 서버가 여러 대면 풀 크기(와 `max_overflow`)의 합이 그 안에 들어야 한다. 풀 50은 서버 동시 연결이 51로, 요청마다 새로 연결한 `NullPool`과 같았다. HikariCP 위키의 `connections = ((core_count * 2) + effective_spindle_count)`는 DB가 실제로 일하는 연결 수의 출발점이고, 이번에는 재지 않았다. |
| 연결 보유 시간 | 풀 크기보다 먼저 연결을 보유하는 시간을 줄인다. 트랜잭션 안에서 외부 API를 기다리면 그 200ms 동안 연결과 행 락을 보유한다. 외부 호출을 `with engine.connect()` 블록 밖(연결을 빌리기 전이나 돌려준 뒤)으로 옮기면 보유 시간이 풀에서 빌리기 + `SELECT 1`의 0.31~0.32ms 수준이 된다(식으로 셈, 재지 않음). 새로 연결하는 비용(9.25~9.63ms, 약 30배)은 쿼리가 짧을수록 요청 시간의 대부분이 되고, 풀이 이 몫을 없앤다. |

## 학습 확인 요약

질문 8개 중 직접 잰 숫자를 넣어 스스로 답한 것은 질문 5·6·8의 셋이었다(03은 9개 중 1개). 셋 모두 처음 답이 아니라 이어 물은 데서였다. 질문 5는 READ COMMITTED로 낮춘 리워드 10건(1213 0건, 10행, 10000, 맥에서는 재지 않아 컨테이너 확인과 대조), 질문 6은 처음 version이 3일 때(0행, 0), 질문 8은 다 끝나는 시간의 식과 0.5초에 필요한 풀 25다. 여덟 질문 모두 처음 답에는 장면과 숫자가 없었다. "왜?"에 두 번까지 이어 답한 것은 질문 1~6이다(03은 질문 1·3·6·7). 두 번 모두 혼자 다 맞힌 질문은 없었고, 질문 4는 두 번 모두 빗나갔다. 질문 7·8은 물음을 나눈 뒤 "왜?"를 한 번 물었다. 끝난 뒤 낸 처음 보는 문제에서는 목표 1의 순서표 2개 16칸 중 12칸을 맞혔고(컨테이너 확인 기준, 판정용 아님), 목표 3의 상황 3개 중 쿠폰의 짝(유니크 제약 + `UPDATE` 한 문장)과 조회수의 방향(`UPDATE` 한 문장)을 혼자 골랐다.

| 구분 | 실제 답에서 확인한 내용 |
|---|---|
| 이번 확인에서 직접 설명 | 공유 락과 배타 락의 뜻과 SERIALIZABLE의 평범한 `SELECT`가 공유 락이라는 것, 2-1의 READ COMMITTED·REPEATABLE READ에 1213이 없던 까닭(순환 대기가 없음), 갭 락이 막은 것이 삽입이고 그 이상현상이 팬텀이라는 것, 인덱스가 없을 때 REPEATABLE READ가 읽은 행마다 락을 걸고 supremum까지 잠근다는 것, 같은 행 S→X 데드락의 과정과 이체 데드락의 네 조건, 탐지와 시간 초과가 오류를 내는 때, 락 순서 고정과 "올리면 늘어남", READ COMMITTED에서도 이체 데드락이 남는 까닭(쓰기의 레코드 락), READ COMMITTED 리워드의 1213 0건·10행·10000, 상수 version이면 0행·0인 까닭, 유니크 제약이 두 번째 행을 막는다는 것, 재고 차감을 조건부 `UPDATE` 한 문장으로 쓰고 0행이면 재고 없음으로 처리하기(힌트 뒤), 풀을 쓰는 두 까닭, 다 끝나는 시간의 식과 0.5초에 풀 25, 외부 API 기다림을 트랜잭션 밖으로 빼기, 쿠폰을 유니크 제약과 `UPDATE` 한 문장으로 막는 짝, 순서표 1 READ COMMITTED의 결과와 까닭, 4번이 기다리지 않는 까닭(갭 락끼리 호환). |
| 설명 후 적용 | 03의 측정을 다시 본 뒤 평범한 `SELECT`가 배타 락을 기다리지 않고 1000을 읽는다고 고쳤다. 작은 힌트를 받고 (12, 4)에 락이 붙은 까닭(커서가 거기까지 읽어야 끝을 앎)을 말했다. 질문 3 처음 답의 피드백 뒤 이체의 점유 대기에 "보유하고"를 넣었다. 질문 1의 "5초 뒤 데드락 오류"를 질문 4에서 바르게 나눴다. 문제 상황 3을 다시 본 뒤 두 락이 9건을 다루는 과정의 차이를 끌어냈다. 질문 6에서 들은 낙관적 락 설명으로 게시글 다시 쓰기에 version 열과 `WHERE`의 version 확인을 썼다. 다섯 번 설명을 들은 갭 락끼리의 호환을 목표 1 순서표에 적용해 4번이 기다리지 않는다고 예상하고 까닭을 말했다. |
| 도움받은 내용 | 충돌·호환·요청·부여·보유라는 표준 용어와 락 충돌의 뜻, 락 모드·락 타입과 레코드·갭·넥스트 키·삽입 의도라는 이름, 일관된 읽기와 잠금 읽기의 구분, 갭 락의 대가, READ COMMITTED가 맞지 않는 행의 락을 서버의 `WHERE` 평가 뒤 해제한다는 것, 클러스터형 인덱스의 정렬 기준, 갭 락끼리 함께 보유한다는 것과 락끼리 충돌·호환하는 규칙, 1213과 1205가 되돌리는 범위와 그 까닭(문장 롤백으로는 락이 해제되지 않음), 탐지를 켜도 시간 초과가 필요한 까닭과 오류 뒤 앱이 할 일, 락 순서 고정이 깨는 조건(순환 대기)과 첫 락이 충돌해야 통한다는 것, 낙관적 락과 비관적 락을 고르는 기준(충돌 빈도)과 낙관적 락도 쓸 때 배타 락을 건다는 것, 좌석의 유니크 키, 빈 범위 비관적 락의 갭 락 데드락, 낙관적 재고 차감의 다시 시도와 포기, 큰 풀의 대가(서버 스레드, `max_connections`), 연결을 빌리는 곳이 `engine.connect()`라는 것, 다른 요청에 걸친 수정에는 DB 락이 이어지지 않는다는 것과 version을 올리는 것, 데드락에서 되돌릴 쪽을 고르는 규칙. |
| 다시 확인할 내용 | 갭 락끼리 호환(다섯 번 빠지고 여섯 번째에 처음 혼자 말함), 데드락(1213, 바로, 트랜잭션 전체)과 락 대기 시간 초과(1205, 한도 뒤, 문장 하나)의 구분과 되돌릴 쪽(질문 4에서 정리했지만 목표 1에서 "데드락 타임아웃"으로 섞고 먼저 기다린 쪽을 골랐음), 평범한 `SELECT`가 배타 락을 기다리지 않고 커밋 전 값을 보지 않는다는 것(질문 1 왜? 2에서 처음엔 기다렸다가 900을 읽는다고 답함), 클러스터형 인덱스의 정렬 기준(시작 전 1-2에 이어 두 번째로 놓침), 락 순서 고정이 깨는 조건과 첫 락이 충돌해야 한다는 것, 낙관적 락의 version(읽은 값과 비교하고 쓸 때 올림)과 조건부 `UPDATE`의 구분, 유니크 키를 거는 열, 순서표의 까닭을 S·X 모드까지 쓰기, 처음 답에 장면과 숫자 넣기. |

측정과 학습 확인 문답을 마쳤다는 사실을 모든 개념을 혼자 설명할 수 있다는 판단으로 바꾸지 않는다. 다음 실험을 시작할 때는 위 재확인 항목 중 하나로 짧은 변형 문제를 묻는다.

남은 질문은 다음과 같다. 이번 측정으로 답하지 않은 질문으로 남기며 실험 범위를 더 넓히지 않았다.

- 데드락에서 두 트랜잭션의 크기가 같을 때 어느 쪽을 되돌리는지는 문서에서 확인하지 못했다. 이번 순서표들에서는 모두 고리를 닫은 쪽이 되돌려졌다.
- `max_connections`를 넘을 때의 1040과, 풀 크기를 DB가 동시에 처리할 수 있는 양(HikariCP 공식)에 맞추는 것은 재지 않았다. 이번 200ms는 DB의 일이 아니라 외부 API 기다림이었다.
- 외부 API 호출을 연결 밖으로 옮긴 판은 식으로 셈했을 뿐 재지 않았다.
- 학습 확인 피드백의 컨테이너 확인(READ COMMITTED 이체와 리워드, 세 계좌, 두 요청으로 줄인 비관적·낙관적 판, 차감·재고·좌석 예약을 막는 판, 목표 1의 순서표 2개)은 맥 본 측정이 아니다.
- 겹치는 기간의 예약처럼 유니크 키로 막지 못하는 중복은 다루지 않았다.
