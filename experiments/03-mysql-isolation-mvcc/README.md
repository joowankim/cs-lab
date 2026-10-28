# 03 MySQL 격리 수준과 MVCC

두 세션을 번갈아 실행해 격리 수준마다 읽기가 무엇을 보는지 확인하고, 그 결과를 MVCC로 설명한다. 같은 순서표를 PostgreSQL에서도 돌려 비교한다. 커밋한 데이터를 지키는 장치(ROLLBACK, redo log를 디스크에 쓰는 설정)의 동작과 비용도 잰다. 공통 규칙은 [작업 지침](../../AGENTS.md)을 따른다.

2026-10-27에 목표와 범위를 정했고, 2026-10-28에 맥에서 본 측정을 마쳤다. 시작 전 기록은 측정하지 않은 상태의 예상과 문답이며, 측정값과 판정은 [결과 정리](#결과-정리)에 있다. 같은 날 결과를 해석하며 추론 하나를 확인하는 측정(이어 쓰기와 덮어쓰기)을 더했고, 그 문답은 [첫 해석](#첫-해석)에 있다.

## 목표

실험을 마치면 다음을 할 수 있어야 한다.

1. **예측:** 두 세션이 번갈아 실행되는 순서표를 보고, 격리 수준(READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE)과 읽기 방식(평범한 `SELECT`, `FOR UPDATE`)에 따라 각 읽기가 돌려줄 값과 기다리게 되는 경우를 맞힌다.
2. **설명:** 그 값이 나온 이유를 MVCC로 설명한다. 스냅숏이 언제 만들어져 언제까지 쓰이는지, 옛 값이 어디에서 오는지, 열어 둔 트랜잭션 하나가 무엇을 남기는지를 직접 잰 숫자로 말한다. 같은 순서표가 MySQL과 PostgreSQL에서 다르게 보이는 곳도 설명한다.
3. **선택:** ACID의 원자성·격리성·지속성을 직접 본 장면으로 말하고, 격리 수준과 지속성 설정을 바꿀 때 얻고 잃는 것을 숫자로 들어 상황에 맞는 설정을 고른다. 일관성은 이번에 재지 않고, 유니크 제약은 04 실험에서 직접 쓴다.

확인 방법은 둘이다. 측정 전에 적은 예상을 실측과 대조해 맞힌 수를 센다. 예상마다 틀렸다고 볼 조건을 같이 적는다. 완료 후에는 아래 질문 9개에 해설 없이 답하고, 직접 잰 숫자를 넣어 답한 수와 "왜?"에 두 번까지 답한 수를 센다.

### 확인할 질문

1. 커밋과 롤백은 각각 무엇을 확정하고 무엇을 되돌리는가.
2. ACID의 네 성질은 각각 무엇이 보장하는가.
3. 격리 수준 네 단계에서 각각 어떤 이상현상(dirty read, non-repeatable read, phantom read)이 생기는가.
4. 격리 수준을 올리면 무엇을 얻고 무엇을 잃는가. 세션마다 격리 수준은 어떻게 바꾸는가.
5. DB마다 기본 격리 수준이 다른 이유는 무엇인가(MySQL InnoDB와 PostgreSQL).
6. InnoDB의 REPEATABLE READ에서 팬텀이 보이는가.
7. MVCC는 옛 값을 어디에 두고 어떻게 고르는가. 오래 열린 트랜잭션은 무엇을 남기는가.
8. InnoDB와 MyISAM은 무엇이 다른가.
9. 커밋한 데이터는 장애 뒤에 어떻게 살아남는가(redo log, 체크포인트, flush 설정).

## 다룰 범위

| 묶음 | 볼 것 | DB |
|---|---|---|
| 1 | 세션 두 개로 격리 수준별 dirty·non-repeatable·phantom read를 재현하고, REPEATABLE READ에서 평범한 `SELECT`와 `FOR UPDATE`가 보는 것을 비교 | MySQL, PostgreSQL |
| 2 | 트랜잭션 하나를 열어 둔 채 다른 세션이 같은 행을 계속 고칠 때 치우지 못하고 쌓이는 이전 버전(MySQL은 `SHOW ENGINE INNODB STATUS`의 History list length, PostgreSQL은 `VACUUM (VERBOSE)`가 보고하는 아직 지울 수 없는 행 버전 수)과 읽기 시간 | MySQL, PostgreSQL |
| 3 | MyISAM 테이블에서 ROLLBACK과 테이블 락 | MySQL |
| 4 | 커밋을 디스크에 내리는 설정(MySQL `innodb_flush_log_at_trx_commit` 1·2와 `sync_binlog` 1·0, PostgreSQL `synchronous_commit` on·off)에 따른 자동 커밋 INSERT 처리량 | MySQL, PostgreSQL |

MySQL을 기준으로 두고 묶음 1·2에서 같은 순서표와 같은 관찰을 PostgreSQL에서도 한다(2026-10-27 사람의 결정). 다른 세션의 INSERT가 왜 막히는지(gap·next-key lock), 걸린 락 읽기, 데드락, 갱신 손실을 막는 방법은 04 실험(MySQL 락·데드락·커넥션 풀)에서 다룬다. 이번에는 기다리는지와 무엇이 보이는지까지만 기록한다.

MySQL 8.4.13과 PostgreSQL 18.6을 Docker Desktop으로 띄운다. 실행 규칙과 방법은 아래 [순서표 실행 규칙](#순서표-실행-규칙), [열어 둔 트랜잭션 측정 규칙](#열어-둔-트랜잭션-측정-규칙), [지속성 설정 측정 규칙](#지속성-설정-측정-규칙), [실행 방법](#실행-방법)에 적었다.

## 시작 전 기록

아래는 준비 단계의 예상과 문답이다. 측정하지 않은 상태를 그대로 남기며, 실제 결과는 뒤의 결과 정리에 기록한다.

### 지난 실험의 변형 문제 (2026-10-27)

- 문제(에이전트): [02 실험 문제 상황 1](../02-synchronization-primitives/README.md#문제-상황-1-상한-4개인데-동시-호출이-늘어난-서버)의 서버(타임아웃이 나면 `except`와 `finally`에서 `release()`를 두 번 부른다)에서 `Semaphore(4)`만 `BoundedSemaphore(4)`로 바꾸면, 첫 타임아웃 때 그 요청은 어떻게 끝나고 동시 호출 수는 어떻게 되는가. 02의 "다시 확인할 내용" 중 `BoundedSemaphore`의 역할을 다시 묻는 문제다.
- 사람의 답(원문): "Semahpore가 BoundedSemaphore로 대체되어도 동시에 작업중인 스레드 수가 2개 이상인 상태에서 타임아웃이 발생한다면 value error 없이 최대 동시 호출 수가 1개 증가된 채로 작업이 진행될거야. 그러다가 다른 작업들이 종료되면서 bounded semaphore의 내부 카운터가 상한을 넘도록 변경하는 release 호출이 발생하면 그 때 value error가 발생할거야."
- 에이전트 피드백: 맞다. `BoundedSemaphore.release()`는 부를 때마다 카운터에 더한 값이 초깃값을 넘는지만 검사하므로, 타임아웃 난 스레드 말고 한 스레드라도 더 들어가 있으면 두 번째 `release()`가 통과하고 동시 호출이 5개까지 나갈 수 있다. 덧붙인 것은 셋이다. (1) 타임아웃 난 스레드 혼자 들어가 있던 경우(카운터 3)에는 두 번째 `release()`에서 바로 `ValueError`가 나고, `finally`에서 난 예외가 `send_later()`의 반환값을 덮어써 다시 보낼 큐에는 넣었는데 부른 쪽에는 실패로 보인다. (2) 나중에 나는 `ValueError`는 원인을 만든 스레드가 아니라 `acquire()`와 `release()`를 한 번씩 제대로 부른 다른 스레드에서 나고, 그 스레드는 API 호출이 성공했는데도 실패로 보인다. 그 `release()`는 거부되어 카운터가 4에 머물고, 늘어난 하나는 그때 사라진다. (3) 호출이 몰려 늘 두 개 이상 진행 중이면 카운터가 초깃값을 넘을 일이 없어 오류가 나지 않고, 동시 5개가 계속될 수 있다. 고치는 방법은 `except`의 `release()`를 지우고 `with api_slots:`로 한 번씩만 부르게 하는 것이다. (1)(2)는 02에서 CPython 소스로 판단한 내용이고 (3)은 같은 소스에서 에이전트가 이어서 추론한 것이다. 실행으로는 확인하지 않았다.
- 현재 확인한 부분: 검사 조건과 오류가 늦게 나는 때를 해설 없이 다시 설명했다. 02 문답에서 피드백으로 들었던 두 가지(오류가 원인과 다른 스레드에서 난다는 점, `finally`의 예외가 반환값을 덮어쓴다는 점)는 이번 답에 나오지 않아 피드백으로 다시 짚었다.

### 문제 상황 1: 같은 트랜잭션에서 개수가 2, 3, 2로 바뀐 응모 확인

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다.

응모는 한 사람당 3번까지다. 응모 요청을 받으면 트랜잭션 안에서 그 사람의 응모 수를 읽고 검증한 뒤 한 번 더 확인한다. MySQL은 기본 설정 그대로이고 격리 수준을 바꾸지 않았다. 같은 사람(`user_id = 7`)의 요청 두 개가 거의 동시에 들어와 아래 순서로 실행됐다.

| 순서 | 세션 A (응모 확인) | 세션 B (다른 요청) |
|---|---|---|
| 1 | `START TRANSACTION;`<br>`SELECT COUNT(*) FROM entries WHERE user_id = 7;` → 2 | |
| 2 | (검증 로직 실행 중) | 응모 한 줄 `INSERT` 후 `COMMIT` |
| 3 | `SELECT COUNT(*) FROM entries WHERE user_id = 7 FOR UPDATE;` → 3 | |
| 4 | `SELECT COUNT(*) FROM entries WHERE user_id = 7;` → 2 | |

물은 것: 같은 트랜잭션에서 같은 조건의 개수가 2, 3, 2로 나온 이유, 격리 수준을 READ COMMITTED로 바꾸면 1·3·4번이 각각 몇이 되는지, 모르는 용어나 부분.

- 사람의 질문(2026-10-27, 원문): "우선 격리 수준에 대한 설명이 필요해. 개념이 기억이 안 나."
- 에이전트 설명(기초 설명): 격리 수준은 동시에 도는 다른 트랜잭션의 변경을 내 트랜잭션이 얼마나 보게 되는지 정하는 설정이다. SQL 표준의 세 이상현상을 예와 함께 설명했다. dirty read는 다른 트랜잭션이 커밋하기 전의 값을 읽는 것, non-repeatable read는 같은 행을 다시 읽는 사이 다른 트랜잭션이 그 행을 고치고 커밋해 값이 달라지는 것, phantom read는 같은 조건으로 다시 읽는 사이 다른 트랜잭션이 조건에 맞는 행을 넣거나 지우고 커밋해 행 집합이 달라지는 것이다. 네 단계가 막는 것은 READ UNCOMMITTED 없음, READ COMMITTED dirty read, REPEATABLE READ dirty·non-repeatable read, SERIALIZABLE 셋 다로 표를 보여 주었다. 표준은 단계마다 최소한 막을 것만 정해 실제 DB는 더 막기도 한다는 점, MySQL(InnoDB)의 기본이 REPEATABLE READ라는 점(컨테이너의 MySQL 8.4.13에서 `@@transaction_isolation`으로 확인), `FOR UPDATE`는 읽은 행을 트랜잭션이 끝날 때까지 다른 트랜잭션이 고치지 못하게 잠그면서 읽는 `SELECT`라는 점을 덧붙였다. 문제 상황 1에서 어떤 값이 왜 나오는지는 설명하지 않았다.
- 줄인 질문(에이전트): `FOR UPDATE`가 없는 1번과 4번이 둘 다 2로 같았던 것을 표에 비춰 보고, READ COMMITTED였다면 4번이 몇이 될지 예상한다. 3번만 3이 나온 이유는 그다음에 묻는다.
- 사람의 첫 생각(2026-10-27, 원문): "진짜 모르겠네. 같은 트랙잭션에서 저렇게 세 번의 조회를 하는데 중간에 값이 바뀌었다가 되돌아 올 수도 있나. 2번에서 커밋이 되었다면 4번 쿼리 결과도 3이 되어야하는거 아닌가? 1,4번이 동시에 쿼리 실행된 것도 아니고 순차적으로 실행됐을텐데..."
- 에이전트 확인할 지점: 지금의 추론이 "커밋된 것은 그 뒤에 읽으면 바로 보인다"이며, 이것이 표의 네 단계 중 어디에 맞는지 짚게 했다. (1) 1번이 2인데 4번이 3이었다면 같은 조건으로 두 번 센 값이 달라진 것이다. 이것이 세 현상 중 무엇이고 REPEATABLE READ라는 이름이 무엇을 약속하는지, 표의 칸과 실제로 나온 값(2)을 표준은 최소한만 정한다는 점과 함께 비교한다. (2) 값이 바뀌었다 되돌아온 것이 아니라 3번이 1·4번과 다른 것을 보고 읽었다고 생각해 본다. `FOR UPDATE`는 행을 잠그면서 읽으므로, 잠그려면 지금 실제로 있는 행과 1번 때 있던 행 중 무엇을 봐야 하는지 답한다.
- 사람의 가설(2026-10-27, 원문): "4번은 2가 나왔잖아. 3번이 3이 나왔고. 설마 같은 트랜잭션에서 같은 조건으로 읽게 되면 앞에 읽은 데이터로 어딘가에 캐시가 되나? 그게 repeatable read인거야? 3번이 최신화된 데이터가 나온 이유는 for update 구문이 붙었기 때문에 앞선 조회 조건과 완전히 똑같지 않으니까 새로 조회한 데이터로 집계한 값이 반환된거라고 추측하고 있어."
- 에이전트 확인: 3번이 최신 데이터를 읽었다는 점, REPEATABLE READ에는 같은 트랜잭션이 앞에서 본 것을 다시 보게 하는 장치가 있다는 점까지는 결과와 맞다고 했다. 그 장치가 같은 조건의 결과를 담아 둔 캐시인지는 실험으로 가르기로 하고 아래 문제 상황 1-1을 냈다. 가설이 맞는지는 말하지 않았다.

PostgreSQL은 집계 함수에 `FOR UPDATE`를 붙일 수 없어 이 순서표는 MySQL용이다. 두 DB에 같이 돌릴 순서표는 묶음 1의 조건을 정할 때 행을 읽는 꼴로 쓴다.

### 문제 상황 1-1: 처음 쓰는 조건으로 다시 세기

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 문제 상황 1에서 나온 가설(같은 트랜잭션이 같은 조건으로 읽으면 앞의 결과를 캐시해 돌려준다)을 가르려고 3번만 바꿨다. 표에는 처음에 3줄(`user_id` 7이 2줄, 8이 1줄)이 있고, 2번에서 1줄이 늘어 4줄이 된다.

| 순서 | 세션 A | 세션 B |
|---|---|---|
| 1 | `START TRANSACTION;`<br>`SELECT COUNT(*) FROM entries WHERE user_id = 7;` → 2 | |
| 2 | | 응모 한 줄 `INSERT` 후 `COMMIT` |
| 3 | `SELECT COUNT(*) FROM entries;` (이 트랜잭션에서 처음 쓰는 조건) | |

물은 것: 기본 설정(REPEATABLE READ)에서 3번의 값과 이유, 어떤 값이 나오면 캐시 가설이 틀렸다고 볼지, READ COMMITTED였다면 문제 상황 1의 1·3·4번이 각각 몇일지. 이 순서표는 `FOR UPDATE`가 없어 PostgreSQL에서도 돌린다.

- 사람의 예상과 이유(2026-10-27, 원문): "1. 4가 나올거라 생각해. 앞선 가설에 따르면 RR 격리수준은 같은 트랜잭션 안에서 같은 조회 조건에만 같은 데이터를 반환하고 다른 조건에는 새로운 조회 결과를 반환하니까 2번에서 새로 추가된 row까지 포함해서 총 4가 나오는거야."
- READ COMMITTED일 때 문제 상황 1의 예상(원문): "3. 격리수준의 이름만 보면 committed 된 것만 읽을 수 있으니까 2,3,3이 결과로 나왔을 거 같아."
- 틀렸다고 볼 조건, 사람의 질문(원문): "2. 그건 모르겠네. 몇 번에서의 값을 말하는거야? 3번 조회의 결과는 같은 조회 조건이 아니니까 비교대상으로 사용할 수 없는거 아니야?"
- 에이전트 보충: 질문이 모호했다. 3번 값은 1번과 비교하려는 것이 아니라 A가 표의 어느 때 모습을 봤는지 알려 준다. 2번 전에는 전체 3줄, 뒤에는 4줄이므로 3이면 2번 전 모습, 4면 지금 모습을 본 것이다. 캐시 가설대로라면 처음 쓰는 조건은 지금 모습을 읽어야 한다. 3번이 어떤 값이면 가설이 틀렸다고 볼지 다시 물었다.
- 틀렸다고 볼 조건(사람의 답, 원문): "4가 아닌 값이 나오면 틀린거라고 생각해"
- 에이전트 피드백(예제와 설명 단계): 컨테이너 임시 확인(본 측정 아님. Linux 컨테이너의 MySQL 8.4.13·PostgreSQL 18.6에서 순서표 `entries-total`과 `entries-count`를 조건마다 워밍업 1회와 2회 돌렸고 세 번 모두 같았다. 원자료는 남기지 않았다)에서 1-1의 3번은 REPEATABLE READ일 때 두 DB 모두 3, READ COMMITTED일 때 4였다. 사람이 정한 조건대로 캐시 가설은 틀렸다. 문제 상황 1을 READ COMMITTED로 돌린 값은 2, 3, 3이었다. 설명한 것은 셋이다.
  1. REPEATABLE READ는 조건마다 결과를 담아 두지 않는다. 트랜잭션의 평범한 `SELECT`가 읽을 DB 전체의 한 시점 모습(스냅숏)을 정해 두고, 그 뒤의 평범한 `SELECT`는 조건이 달라도 모두 그 모습을 읽는다. 그래서 처음 쓰는 조건인 전체 개수도 2번 전 모습인 3이 나왔다. READ COMMITTED는 `SELECT`마다 스냅숏을 새로 정해 4가 된다.
  2. `FOR UPDATE`는 행을 잠그며 읽는 읽기(잠금 읽기)라서 스냅숏이 아니라 지금 커밋된 최신 행을 읽는다. 잠글 수 있는 것은 지금 실제로 있는 행이기 때문이다. 그래서 문제 상황 1의 3번만 3이고, 4번은 다시 스냅숏을 읽어 2가 됐다. MySQL 8.4 매뉴얼 [Locking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)는 `FOR UPDATE`가 "reads the latest available data"라고 하고, 같은 문서에 "Old versions of a record cannot be locked"라는 설명이 있다.
  3. 옛 모습을 읽을 수 있는 것은 행을 바꿀 때 이전 버전을 남겨 두기 때문이며, 이를 MVCC(다중 버전 동시성 제어)라 한다. MySQL InnoDB는 이전 버전을 undo log에 남겨 읽을 때 옛 행을 다시 만들고([InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)), PostgreSQL은 테이블 안에 행의 옛 버전을 남긴다(에이전트 설명, 묶음 2에서 확인한다).

  스냅숏이 정확히 언제 정해지는지는 설명하지 않고 문제 상황 1-2로 물었다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): 1-1의 REPEATABLE READ 3번(예상 4, 확인 3)은 빗나감, 문제 상황 1의 READ COMMITTED 1·3·4번(예상 2, 3, 3)은 적중.
- 현재 확인한 부분: READ COMMITTED에서 커밋된 행이 바로 보인다는 것은 이름에서 혼자 예상했다. REPEATABLE READ가 같은 값을 다시 보게 하는 방식(스냅숏)과 `FOR UPDATE`가 최신 행을 읽는 이유는 설명을 들은 부분이라, 뒤의 문제 상황과 완료 후 질문에서 다시 확인한다.

### 문제 상황 1-2: 트랜잭션을 연 뒤 처음 세기

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 1-1에서 REPEATABLE READ의 평범한 `SELECT`가 한 시점의 스냅숏을 읽는다는 것을 확인했다. 그 스냅숏이 언제 정해지는지 가르려고, A가 트랜잭션을 열고 아직 아무것도 읽지 않았을 때 B가 끼어들게 했다. 표는 1-1과 같이 처음에 `user_id` 7이 2줄이다.

| 순서 | 세션 A | 세션 B |
|---|---|---|
| 1 | `START TRANSACTION;` (아직 아무것도 읽지 않음) | |
| 2 | | 응모 한 줄 `INSERT` 후 `COMMIT` |
| 3 | `SELECT COUNT(*) FROM entries WHERE user_id = 7;` (이 트랜잭션의 첫 읽기) | |

물은 것: REPEATABLE READ에서 3번의 값과 이유(MySQL과 PostgreSQL 각각), 예상이 틀렸다고 볼 값. 순서표는 `entries-late`이며 READ COMMITTED도 함께 돌린다.

- 사람의 질문(2026-10-27, 원문): "평범한 SELECT는 뭐야? 특이한 SELECT도 있어? 스냅샷을 정해둔다는게 무슨 말이야? 표준용어로 다시 설명해줘."
- 에이전트 설명(용어): SQL 표준은 격리 수준을 막아야 할 이상현상으로만 정하고 구현 방법은 정하지 않으므로, MySQL 매뉴얼의 용어로 다시 설명했다. 평범한 `SELECT`는 일관된 비잠금 읽기(consistent nonlocking read, 줄여서 consistent read)로, 락을 걸지 않고 스냅숏을 읽는다. 잠금 읽기(locking read)는 `SELECT ... FOR UPDATE`(배타 락)와 `SELECT ... FOR SHARE`(공유 락)이며, 가장 최근에 커밋된 행을 읽으면서 잠근다. 스냅숏은 한 시점의 DB 모습으로, 그 시점 전에 커밋된 트랜잭션의 변경만 보인다. InnoDB는 스냅숏을 읽기 뷰(read view)로 만들고, 일관된 읽기는 행마다 붙은 트랜잭션 ID(`DB_TRX_ID`)가 읽기 뷰 기준으로 보이는지 따져 안 보이면 undo log로 이전 버전을 만들어 읽거나 그 시점에 없던 행은 건너뛴다. "스냅숏을 정해 둔다"는 읽기 뷰를 한 번 만들어 두고 다시 쓴다는 뜻이며, REPEATABLE READ는 트랜잭션 안의 일관된 읽기가 같은 읽기 뷰를 쓰고 READ COMMITTED는 일관된 읽기마다 새로 만든다. 1-1에서 B가 넣은 행은 B의 트랜잭션 ID를 달고 있고, A의 읽기 뷰가 만들어질 때 B는 커밋 전이었으므로 보이지 않았다. `DB_TRX_ID`와 undo log로 이전 버전을 만드는 것은 [InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)에 있고, 읽기 뷰가 그 순간 커밋을 마친 트랜잭션과 아닌 트랜잭션을 가르는 기록이라는 것은 InnoDB 소스 구조에 대한 에이전트 설명이다. 읽기 뷰를 언제 만드는지는 1-2의 답이라 설명하지 않았고, 그 내용이 적힌 문서는 예상을 받은 뒤 건다.
- 사람의 예상과 이유(2026-10-27, 원문): "둘 다 2라고 생각해. RR 격리수준은 같은 트랜잭션에서 같은 조건으로 조회할 때 같은 스냅샷을 사용한다는거야. 그러면 첫 조회에서 사용한 스냅샷이 다른 일관된 비잠금 읽기에서 다시 사용될 것이라고 생각해."
- 틀렸다고 볼 값: 사람이 따로 적지 않았다. 값 하나를 예상했으므로 다른 값이 나오면 빗나감으로 판정한다(에이전트).
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 순서표 `entries-late`를 조건마다 워밍업 1회와 2회 돌렸고 세 번 모두 같았다)에서 3번은 REPEATABLE READ일 때 두 DB 모두 3이었다(READ COMMITTED도 3). "첫 조회에서 쓴 스냅숏을 이후 일관된 읽기가 다시 쓴다"는 이유는 맞지만, 1-2에서는 3번이 바로 그 첫 조회라서 스냅숏이 B가 커밋한 뒤에 만들어진다. 예상 2는 스냅숏이 `START TRANSACTION` 때 만들어진다고 본 것과 맞는다(에이전트 해석). `START TRANSACTION`은 트랜잭션을 열 뿐 스냅숏을 만들지 않는다. 근거로 두 문서 문장을 보여 주었다. MySQL 8.4 매뉴얼 [Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html): "If the transaction isolation level is REPEATABLE READ (the default level), all consistent reads within the same transaction read the snapshot established by the first such read in that transaction." PostgreSQL 18 문서 [Transaction Isolation](https://www.postgresql.org/docs/18/transaction-iso.html): "a query in a repeatable read transaction sees a snapshot as of the start of the first non-transaction-control statement in the transaction, not as of the start of the current statement within the transaction." MySQL에서 트랜잭션을 열 때 스냅숏을 만들려면 `START TRANSACTION WITH CONSISTENT SNAPSHOT`을 쓴다(같은 문서에 이름이 나온다). 컨테이너 임시 확인에서 이 경우 2였고, 본 측정에서는 순서표 `entries-late-snapshot`(MySQL만)으로 잰다. 이유에 남은 "같은 조건으로 조회할 때"는 1-1처럼 조건이 달라도 같은 스냅숏을 쓴다고 짚었다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): MySQL REPEATABLE READ 3번(예상 2, 확인 3) 빗나감, PostgreSQL REPEATABLE READ 3번(예상 2, 확인 3) 빗나감.
- 현재 확인한 부분: 1-1 설명(일관된 읽기가 같은 스냅숏을 다시 쓴다)을 이유에 스스로 적용했다. 스냅숏이 만들어지는 때는 문서 문장으로 설명을 들었고, 아래 변형에서 두 문장의 차이를 적용하는지 확인한다.
- 사람의 덧붙임(2026-10-27, 아래 변형의 답과 함께, 원문): "아까는 내가 insert 구문이 커밋된걸 놓쳤어." 사람의 말로는 예상 2가 B의 `COMMIT`을 놓친 데서 나왔다. 그렇다면 이유(첫 조회의 스냅숏을 다시 쓴다)와 예상이 서로 맞으므로, 위의 에이전트 해석(스냅숏을 `START TRANSACTION` 때로 봤다)은 따르지 않는다. 판정은 값으로 하므로 빗나감은 그대로 둔다.

### 문제 상황 1-2 변형: 첫 문장이 다른 표의 UPDATE일 때

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 1-2 피드백의 두 문서 문장을 그대로 적용해 보는 변형이다. 응모 수를 세기 전에 방문 수 표 `visits`를 먼저 고친다. `entries`는 1-2와 같이 처음에 `user_id` 7이 2줄이다.

| 순서 | 세션 A | 세션 B |
|---|---|---|
| 1 | `START TRANSACTION;`<br>`UPDATE visits SET n = n + 1 WHERE id = 1;` | |
| 2 | | 응모 한 줄 `INSERT` 후 `COMMIT` |
| 3 | `SELECT COUNT(*) FROM entries WHERE user_id = 7;` | |

물은 것: REPEATABLE READ에서 3번의 값과 이유(MySQL과 PostgreSQL 각각), 예상이 틀렸다고 볼 값. 순서표는 `entries-late-update`이며 READ COMMITTED도 함께 돌린다.

- 사람의 예상과 틀렸다고 볼 값(2026-10-27, 원문): "둘 다 3이야. 아까는 내가 insert 구문이 커밋된걸 놓쳤어. 틀렸다볼 값은 3이 아닌 수야."
- 이유: 따로 적지 않았다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 순서표 `entries-late-update`를 조건마다 워밍업 1회와 2회 돌렸고 세 번 모두 같았다)에서 3번은 REPEATABLE READ일 때 MySQL 3, PostgreSQL 2였다(READ COMMITTED는 둘 다 3). MySQL은 첫 일관된 읽기가 스냅숏을 만들고, `UPDATE`는 일관된 읽기가 아니어서 스냅숏을 만들지 않는다. 같은 매뉴얼 문서에 "The snapshot of the database state applies to SELECT statements within a transaction, not necessarily to DML statements."라고 있다. 그래서 스냅숏이 3번에서 만들어져 B의 행이 보인다. PostgreSQL은 트랜잭션 제어문이 아닌 첫 문장인 1번의 `UPDATE`가 시작할 때 스냅숏을 만들어, 그 뒤에 커밋된 B의 행이 보이지 않는다. 같은 REPEATABLE READ라도 스냅숏을 만드는 때가 DB마다 다르다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): MySQL REPEATABLE READ 3번(예상 3, 확인 3) 적중, PostgreSQL REPEATABLE READ 3번(예상 3, 확인 2) 빗나감.
- 현재 확인한 부분: MySQL 쪽은 첫 일관된 읽기에서 스냅숏이 만들어진다는 설명을 적용해 맞혔다. PostgreSQL의 "트랜잭션 제어문이 아닌 첫 문장"에 `UPDATE`도 든다는 차이는 설명을 들은 부분이다. 이유를 적지 않아 PostgreSQL을 어떻게 판단했는지는 확인하지 못했다.

### 문제 상황 2: 정산 리포트가 세 번 읽은 잔액

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 격리 수준 네 단계에서 dirty read와 non-repeatable read가 생기는지, 기다리는 요청이 있는지를 한 순서표로 본다. 정산 리포트(A)가 트랜잭션 안에서 같은 계좌의 잔액을 세 번 읽는 사이, 결제(B)가 잔액을 1000에서 700으로 바꾼다. 어느 세션이 기다리면 그 세션의 다음 문장은 기다리던 문장이 끝난 뒤에 보낸다([순서표 실행 규칙](#순서표-실행-규칙)의 미룸).

| 순서 | 세션 A (리포트) | 세션 B (결제) |
|---|---|---|
| 1 | `START TRANSACTION;`<br>`SELECT balance FROM accounts WHERE id = 1;` → (가) 1000 | |
| 2 | | `START TRANSACTION;`<br>`UPDATE accounts SET balance = 700 WHERE id = 1;` |
| 3 | `SELECT balance FROM accounts WHERE id = 1;` → (나) | |
| 4 | | `COMMIT;` |
| 5 | `SELECT balance FROM accounts WHERE id = 1;` → (다) | |
| 6 | `COMMIT;` | |

물은 것: MySQL에서 READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE 각각 (나)(다)의 값과 기다리는 단계(있다면 어느 단계가 언제까지), PostgreSQL에서 달라질 칸, 이유와 틀렸다고 볼 조건. 순서표는 `balance-reads`이며 두 DB에 네 단계를 모두 돌린다.

- 사람의 예상과 이유 1(2026-10-27, 원문): "READ UNCOMMITTED: 나 = 700 / 다 = 700, 커밋되지 않은 변경까지 읽을거라 생각해서 (나)도 700이라고 답했어. READ COMMITTED: 나 = 1000 / 다 = 700, 커밋된 변경까지만 읽을거라 생각해서 (나)는 1000이라고 답했어. REPEATABLE READ: 나 = 1000 / 다 = 1000, 일관된 읽기를 1번 순서에서 수행하면서 보관한 스냅샷을 읽어서 (나),(다) 모두 1000이라고 답했어. SERIALIZABLE: 나 = 1000 / 다 = 1000, 이건 정렬 순서 때문에 REPEATABLE READ 보다 더 엄격하게 트랜잭션을 지킬거 같아서 (나), (다) 모두 1000이라고 답했어. 이 격리수준의 의미는 추측을 못했어."
- 기다리는 단계 2(원문): "SERIALIZABLE에서 2번 단계가 6번 단계까지 기다리고 그 다음에 실행될 것이라고 추측만 했어. 근거는 없어."
- PostgreSQL에서 달라질 칸 3(원문): "이 둘의 차이를 몰라서 이건 모르겠어"
- 틀렸다고 볼 조건: 따로 적지 않았다. 값마다 적은 값과 다르면 빗나감으로 판정한다(에이전트).
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 순서표 `balance-reads`를 조건마다 워밍업 1회와 2회 돌렸고 세 번 모두 같았다) 값은 아래와 같다.

  | 격리 수준 | MySQL (나)·(다) | MySQL 기다림 | PostgreSQL (나)·(다) | PostgreSQL 기다림 |
  |---|---|---|---|---|
  | READ UNCOMMITTED | 700, 700 | 없음 | 1000, 700 | 없음 |
  | READ COMMITTED | 1000, 700 | 없음 | 1000, 700 | 없음 |
  | REPEATABLE READ | 1000, 1000 | 없음 | 1000, 1000 | 없음 |
  | SERIALIZABLE | 1000, 1000 | B의 `UPDATE`(2번)가 A의 `COMMIT`(6번)까지 기다렸고, B의 `COMMIT`은 그 뒤에 나갔다 | 1000, 1000 | 없음 |

  설명한 것은 넷이다. (1) READ UNCOMMITTED의 (나) 700은 dirty read(커밋 전 값을 읽음), READ COMMITTED의 (다) 700은 non-repeatable read(같은 행을 다시 읽었더니 값이 바뀜)이고, REPEATABLE READ부터는 둘 다 생기지 않았다. (2) SERIALIZABLE은 "직렬(serial)"로, 동시에 돈 트랜잭션들의 결과가 하나씩 차례로 돈 결과와 같도록 보장한다는 뜻이다. PostgreSQL 문서는 "as if transactions had been executed one after another, serially, rather than concurrently"라고 쓴다. (3) MySQL은 이를 락으로 지킨다. 이 수준에서는 평범한 `SELECT`가 `SELECT ... FOR SHARE`(공유 락을 거는 잠금 읽기)가 되어 A가 잔액 행에 공유 락을 쥐고, B의 `UPDATE`는 배타 락이 필요해 A가 끝날 때까지 기다린다. 결과는 A가 다 끝난 뒤 B가 돈 것과 같다. MySQL 8.4 매뉴얼 [Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html): "InnoDB implicitly converts all plain SELECT statements to SELECT ... FOR SHARE if autocommit is disabled." `START TRANSACTION`으로 연 트랜잭션 안은 커밋할 때까지 autocommit이 꺼진 상태라 이 경우에 든다(에이전트 설명, 컨테이너에서 B가 기다린 것과 맞는다). (4) PostgreSQL은 READ UNCOMMITTED를 READ COMMITTED처럼 동작시켜 dirty read가 없고([Transaction Isolation](https://www.postgresql.org/docs/18/transaction-iso.html): "PostgreSQL's Read Uncommitted mode behaves like Read Committed"), SERIALIZABLE은 락으로 막는 대신 REPEATABLE READ와 같은 스냅숏으로 읽다가 차례로 돈 결과로 설명할 수 없는 조합이 생기면 한쪽 트랜잭션을 오류로 되돌린다. 같은 문서: "This monitoring does not introduce any blocking beyond that present in repeatable read, but there is some overhead to the monitoring, and detection of the conditions which could cause a serialization anomaly will trigger a serialization failure." 이 순서표는 A가 읽기만 해서 그런 조합이 아니라 둘 다 그대로 커밋됐다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): MySQL 네 단계의 (나)(다) 4개와 SERIALIZABLE의 기다림 1개 모두 적중(5/5). PostgreSQL은 예상하지 않았다(모르겠다고 답함).
- 현재 확인한 부분: READ UNCOMMITTED·READ COMMITTED·REPEATABLE READ는 이유까지 혼자 설명했고, REPEATABLE READ에는 1-x에서 들은 스냅숏을 적용했다. SERIALIZABLE은 값과 기다림을 맞혔지만 사람의 말대로 이유는 추측이었다. SERIALIZABLE의 뜻과 MySQL의 구현, PostgreSQL의 두 차이는 설명을 들은 부분이라 뒤의 문제 상황과 완료 후 질문에서 다시 확인한다.

### 문제 상황 1-3: 응모 행을 잠그며 읽기

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 문제 상황 1을 두 DB에서 같이 돌리려고 개수 대신 행을 읽는다(PostgreSQL은 집계 함수에 `FOR UPDATE`를 붙일 수 없다). 처음에 `user_id` 7의 행은 id 1, 2다.

| 순서 | 세션 A | 세션 B |
|---|---|---|
| 1 | `START TRANSACTION;`<br>`SELECT id FROM entries WHERE user_id = 7 ORDER BY id;` → 1, 2 | |
| 2 | | `START TRANSACTION;`<br>`INSERT INTO entries (id, user_id) VALUES (4, 7);`<br>`COMMIT;` |
| 3 | `SELECT id FROM entries WHERE user_id = 7 ORDER BY id FOR UPDATE;` | |
| 4 | `SELECT id FROM entries WHERE user_id = 7 ORDER BY id;` | |
| 5 | `COMMIT;` | |

물은 것: REPEATABLE READ에서 3·4번이 돌려줄 행(MySQL과 PostgreSQL 각각), SERIALIZABLE에서 기다리는 단계와 3·4번의 행(두 DB 각각), 이유와 틀렸다고 볼 조건. 순서표는 `entries-rows`이며 READ COMMITTED도 함께 돌린다.

- 사람의 질문(2026-10-27, 원문): "공유락과 배타락은 뭐야? 각각 어떤 역할을 맡는지 설명하고 postgresql에서도 유효한 개념이야?"
- 에이전트 설명(용어): 공유 락(S)과 배타 락(X)은 행 하나를 두고 트랜잭션끼리 차례를 정하는 락이다. MySQL 8.4 매뉴얼 [InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html): "A shared (S) lock permits the transaction that holds the lock to read a row. An exclusive (X) lock permits the transaction that holds the lock to update or delete a row." 공유 락은 여러 트랜잭션이 같은 행에 함께 걸 수 있지만, 걸려 있는 동안 다른 트랜잭션은 배타 락을 바로 얻지 못해 그 행을 고치거나 지우지 못한다(`SELECT ... FOR SHARE`). 배타 락이 걸린 행에는 다른 트랜잭션이 어느 락도 바로 얻지 못하고 풀릴 때까지 기다린다(`SELECT ... FOR UPDATE`, `UPDATE`, `DELETE`). 두 락 모두 트랜잭션이 끝날 때까지 쥐며, 문제 상황 2의 SERIALIZABLE에서 B가 A의 `COMMIT`까지 기다린 것이 이 때문이다. 평범한 `SELECT`는 락을 걸지도 기다리지도 않고 스냅숏을 읽는다. PostgreSQL에도 같은 개념이 있고 행 락이 `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE` 네 가지로 나뉜다([Explicit Locking](https://www.postgresql.org/docs/18/explicit-locking.html): `FOR SHARE`는 "acquires a shared lock rather than exclusive lock on each retrieved row", "Row-level locks do not affect data querying; they block only writers and lockers to the same row."). [MVCC 소개](https://www.postgresql.org/docs/18/mvcc-intro.html)는 "reading never blocks writing and writing never blocks reading"이라고 쓴다.
- 사람의 예상과 이유(2026-10-27, 원문): "1. 3번: MySQL = 1,2,4 postgreSQL = 1,2 / 문제를 보니 postgresql은 for update(배타락)을 사용하지 않는거 같아서 스냅샷에서 데이터를 읽어온다고 생각해서 1,2만 적었어. 4번: MySQL = 1,2 postgreSQL = 1,2 / 둘 다 스냅샷에서 데이터를 읽어온다고 생각했어. 2. 두 db 모두 2번 단계가 5번이 끝날 때까지 기다려. 3번과 4번의 행은 둘 다 1,2만 읽어줘. postgreSQL이 오류가 날 수도 있다고 생각했는데 세션 A가 읽기만 수행해서 오류는 나지 않아."
- 틀렸다고 볼 조건: 따로 적지 않았다. 문제를 낼 때 말한 대로 적은 값과 다르면 빗나감으로 판정한다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 순서표 `entries-rows`를 조건마다 워밍업 1회와 2회 돌렸고 세 번 모두 같았다) 값은 아래와 같다.

  | 격리 수준 | MySQL 3번·4번 | MySQL 기다림 | PostgreSQL 3번·4번 | PostgreSQL 기다림 |
  |---|---|---|---|---|
  | READ COMMITTED | 1,2,4 · 1,2,4 | 없음 | 1,2,4 · 1,2,4 | 없음 |
  | REPEATABLE READ | 1,2,4 · 1,2 | 없음 | 1,2 · 1,2 | 없음 |
  | SERIALIZABLE | 1,2 · 1,2 | B의 `INSERT`(2번)가 A의 `COMMIT`(5번)까지 기다렸고, B의 `COMMIT`은 그 뒤에 나갔다 | 1,2 · 1,2 | 없음 |

  고친 이유: PostgreSQL도 `FOR UPDATE`면 1, 2에 배타 락을 건다. 다른 것은 잠글 행을 찾는 기준이다. PostgreSQL REPEATABLE READ의 `SELECT ... FOR UPDATE`는 평범한 `SELECT`와 같이 스냅숏 기준으로 대상 행을 찾고([Transaction Isolation](https://www.postgresql.org/docs/18/transaction-iso.html): "they will only find target rows that were committed as of the transaction start time"), MySQL의 잠금 읽기는 지금 커밋된 최신 행을 찾아 새로 들어온 4까지 잠근다. 그래서 InnoDB REPEATABLE READ에서 팬텀은 평범한 `SELECT`에서는 보이지 않고 잠금 읽기에서는 보인다(질문 6). PostgreSQL SERIALIZABLE은 락 대신 감시로 지켜 B가 기다리지 않았고 오류도 없었다. MySQL SERIALIZABLE에서 B가 A가 읽지 않은 새 행을 넣는데도 기다린 것은 행 사이 범위까지 잠그는 락(gap lock) 때문이며, 이유는 04 실험에서 다룬다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): REPEATABLE READ의 MySQL 행, PostgreSQL 행, SERIALIZABLE의 MySQL 행, PostgreSQL 행, MySQL 기다림은 적중, PostgreSQL 기다림은 빗나감(5/6). PostgreSQL에서 오류가 나지 않는다는 덧붙임도 맞았다.
- 현재 확인한 부분: MySQL의 잠금 읽기가 최신 행을 읽는다는 것(1-1)과 PostgreSQL이 스냅숏을 쓴다는 것(1-2 변형)을 이어 PostgreSQL REPEATABLE READ 값을 맞혔다. 다만 이유("PostgreSQL은 `FOR UPDATE` 배타 락을 쓰지 않는 것 같다")는 틀려, 락은 걸되 대상 행을 스냅숏으로 찾는다고 고쳤다. PostgreSQL SERIALIZABLE이 락으로 기다리게 하지 않는다는 점은 문제 상황 2에서 들었지만 이번 예상에 적용되지 않아 다시 확인한다.

### 문제 상황 3: 동시에 차감한 포인트

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 포인트를 쓰는 요청이 잔액을 읽어 앱에서 뺀 값을 계산한 뒤 그 값으로 고친다. 잔액 1000인 사람(`user_id` 7)에게 300 차감(A)과 500 차감(B)이 거의 동시에 들어왔다. 둘 다 반영되면 200이 남아야 한다.

| 순서 | 세션 A (300 차감) | 세션 B (500 차감) |
|---|---|---|
| 1 | `START TRANSACTION;`<br>`SELECT balance FROM points WHERE user_id = 7;` → 1000, 앱이 700을 계산 | |
| 2 | | `START TRANSACTION;`<br>`SELECT balance FROM points WHERE user_id = 7;` → 1000, 앱이 500을 계산 |
| 3 | `UPDATE points SET balance = 700 WHERE user_id = 7;` | |
| 4 | | `UPDATE points SET balance = 500 WHERE user_id = 7;` |
| 5 | `COMMIT;` | |
| 6 | | `COMMIT;` |
| 7 | 끝난 뒤 `SELECT balance FROM points WHERE user_id = 7;` → 최종 잔액 | |

물은 것: READ COMMITTED, REPEATABLE READ, SERIALIZABLE 각각에서 기다리거나 오류가 나는 단계(있다면 언제까지, 어떤 오류인지)와 최종 잔액, MySQL과 PostgreSQL 각각. 이유와 틀렸다고 볼 조건. 순서표는 `points-deduct`이며 READ UNCOMMITTED도 함께 돌린다.

- 사람의 예상과 이유(2026-10-27, 원문): "1. 기다리거나 오류가 나는 단계 (MySQL / PostgreSQL) * READ COMMITTED: 없음 / 없음 * REPEATABLE READ: 없음 / 없음 * SERIALIZABLE: 2번이 5번이 끝날 때까지 기다림 / 7번에서 오류 발생, 5번에서 커밋된 내용과 충돌하는 변경을 커밋하려다가 에러가 발생할 것으로 추측하고 있어. 2. 최종 잔액 (MySQL / PostgreSQL) * READ COMMITTED: 500 / 500, 둘 다 4번이 덮어쓸 것으로 추측함. * REPEATABLE READ: 500 / 500, RC와 마찬가지. * SERIALIZABLE: 200 / 오류 발생으로 조회 불가"
- 틀렸다고 볼 조건: 따로 적지 않았다. 적은 값과 다르면 빗나감으로 판정한다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 순서표 `points-deduct`를 조건마다 워밍업 1회와 2회 돌렸고 세 번 모두 같았다) 값은 아래와 같다. READ UNCOMMITTED는 두 DB 모두 READ COMMITTED와 같았다.

  | 격리 수준 | MySQL | PostgreSQL |
  |---|---|---|
  | READ COMMITTED | B의 4번이 A의 `COMMIT`(5번)까지 기다린 뒤 500으로 고침, 최종 500 | 같음, 최종 500 |
  | REPEATABLE READ | 같음, 최종 500 | B의 4번이 5번까지 기다린 뒤 오류 40001 "could not serialize access due to concurrent update", B의 `COMMIT`은 `ROLLBACK`으로 끝남, 최종 700 |
  | SERIALIZABLE | A의 3번이 기다리는 중 B의 4번에서 오류 1213 "Deadlock found when trying to get lock; try restarting transaction"(B가 되돌려짐), 이어 A의 3번이 끝남, 최종 700 | REPEATABLE READ와 같음, 최종 700 |

  설명한 것은 셋이다. (1) 같은 행을 고치는 `UPDATE`끼리는 모든 격리 수준에서 기다린다. A의 `UPDATE`가 배타 락을 `COMMIT`까지 쥐고 있어 B의 `UPDATE`는 그동안 고치지 못한다. (2) 기다린 뒤의 동작이 갈린다. MySQL의 READ COMMITTED·REPEATABLE READ와 PostgreSQL READ COMMITTED는 B가 그대로 500으로 덮어써 A의 300 차감이 사라진다(갱신 손실, lost update). MySQL의 `UPDATE`는 스냅숏이 아니라 최신 행을 고치므로 B가 읽은 뒤에 누가 바꿨는지 따지지 않는다. PostgreSQL REPEATABLE READ는 B를 오류로 끝낸다([Transaction Isolation](https://www.postgresql.org/docs/18/transaction-iso.html): "a repeatable read transaction cannot modify or lock rows changed by other transactions after the repeatable read transaction began"). (3) MySQL SERIALIZABLE에서는 1·2번이 둘 다 공유 락을 거는 읽기가 되어, 두 `UPDATE`가 상대의 공유 락이 풀리기를 서로 기다리는 데드락이 되고 InnoDB가 B를 되돌린다. 어느 조건에서도 200은 나오지 않았다. 오류로 끝난 쪽이 처음부터 다시 하면 700을 읽고 200을 만들 수 있으며, 갱신 손실을 막는 방법은 04 실험에서 다룬다. B가 실패해도 A의 700은 커밋되어 7번 조회는 정상이다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): 격리 수준 셋 × DB 둘 × (기다림·오류, 최종 잔액) 12개 중 READ COMMITTED 최종 잔액 두 DB와 REPEATABLE READ MySQL 최종 잔액 3개 적중(3/12). PostgreSQL SERIALIZABLE에서 오류가 나고 그 원인이 5번에 커밋된 변경과의 충돌이라는 것은 맞았으나, 오류가 나는 단계(7번이라고 봄, 실제는 4번)와 최종 잔액은 빗나갔다.
- 현재 확인한 부분: "4번이 덮어쓴다"는 갱신 손실의 결과는 혼자 예상했다. 바로 앞에서 설명을 들은 배타 락을 `UPDATE`끼리의 기다림에 적용하지 못했고, MySQL과 PostgreSQL REPEATABLE READ의 차이(덮어쓰기와 오류), MySQL SERIALIZABLE의 데드락은 설명을 들은 부분이라 완료 후 질문에서 다시 확인한다.

### 문제 상황 4: 열어 둔 정산 트랜잭션

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 묶음 2의 첫 문제다. 정산 리포트(세션 A)가 트랜잭션을 연 채 머무는 동안, 결제(세션 B)가 계좌 하나(`accounts`의 id 1, 잔액 1000)의 잔액을 1씩 올리는 `UPDATE accounts SET balance = balance + 1 WHERE id = 1;`을 1만 번 실행한다. B는 자동 커밋이라 `UPDATE` 한 번이 트랜잭션 하나다. B가 끝나면 A가 잔액을 다시 읽고, 마지막에 A가 `COMMIT`한다. A가 B보다 먼저 해 둔 일에 따라 다섯 경우로 나눈다.

| 경우 | A의 격리 수준 | B가 고치기 전에 A가 실행하고 그대로 둔 문장 |
|---|---|---|
| (가) | DB 기본값 | 없음. 트랜잭션을 열지 않는다(비교 기준) |
| (나) | REPEATABLE READ | `START TRANSACTION;`<br>`SELECT balance FROM accounts WHERE id = 1;` |
| (다) | READ COMMITTED | (나)와 같음 |
| (라) | REPEATABLE READ | `START TRANSACTION;` |
| (마) | REPEATABLE READ | `START TRANSACTION;`<br>`UPDATE visits SET n = n + 1 WHERE id = 1;`(다른 표) |

볼 값은 B가 끝난 직후 아직 치우지 못한 이전 버전의 수다.

- MySQL: `SHOW ENGINE INNODB STATUS`의 History list length. 커밋한 트랜잭션 중 purge(InnoDB가 커밋된 변경의 undo log를 뒤에서 정리하는 일)가 아직 처리하지 못한 것의 수다. 1000 이하로 줄어든 것을 확인한 뒤 B를 시작한다.
- PostgreSQL: B가 끝난 직후 `VACUUM (VERBOSE) accounts`가 보고하는 "dead but not yet removable"의 수. 새 버전으로 바뀌어 죽은 행 버전 중 VACUUM이 아직 지울 수 없던 것이다. 재는 동안 이 표의 자동 VACUUM은 꺼 둔다.

물은 것: (가)~(마) 각각에서 이 값이 1만 근처일지, 1만보다 훨씬 작을지(MySQL과 PostgreSQL 각각). 이유와 틀렸다고 볼 조건. 측정은 [`history_lab.py`](python/history_lab.py)이며, 같은 실행에서 A와 새 세션이 읽은 값과 읽기 시간, B가 한 번 고치는 시간, A가 끝난 뒤의 변화도 기록한다. 이것들은 다음 문제에서 묻는다.

- 사람의 질문(2026-10-27, 원문): "갑자기 치우지 못한 이전 버전의 수를 본다는게 무슨 말이야? inno db는 뭔데 계속 언급되는거야? 갑자기 왜 뭔가를 치운다고 하는거야? '이 값'이라는 건 뭘 지칭하는거야? 표준 용어를 사용해서 설명해줘"
- 에이전트 설명(예상 전): 배경 없이 문제부터 낸 것을 바로잡아 용어를 풀었다. (1) InnoDB는 MySQL의 스토리지 엔진(storage engine)이다. SQL을 해석하는 서버 부분과 데이터 저장·트랜잭션·락을 맡는 엔진 부분이 나뉘고, MySQL 5.5부터 기본 엔진이 InnoDB다. 묶음 3의 MyISAM은 다른 엔진이다. (2) 이전 버전(row version): 문제 상황 2에서 B가 커밋한 뒤에도 A가 1000을 읽으려면 고치기 전 값이 남아 있어야 한다. 한 행의 여러 버전을 두고 트랜잭션마다 볼 버전을 고르는 방식이 MVCC(multi-version concurrency control)다. InnoDB는 표에 최신 버전만 두고 이전 값은 undo log에 남겨 필요할 때 되짚어 만든다. PostgreSQL은 `UPDATE`가 표 안에 새 행 버전(tuple)을 쓰고, 최신이 아니게 된 이전 버전(dead tuple)이 표에 남는다. (3) 정리: 이전 버전을 계속 두면 저장 공간이 끝없이 늘어나므로, 어떤 트랜잭션도 더 읽을 일이 없어진 이전 버전을 지운다. InnoDB에서는 purge라 하고 백그라운드 스레드가 하며, PostgreSQL에서는 VACUUM(평소에는 autovacuum)이 한다. (4) 물은 값은 B가 끝난 직후의 두 숫자다. MySQL History list length는 커밋됐지만 purge가 아직 처리하지 못한 트랜잭션 수(문서 용어로 purge lag), PostgreSQL의 "dead but not yet removable"은 VACUUM이 찾은 dead tuple 중 아직 지울 수 없어 남긴 수다. B의 `UPDATE` 하나가 이전 버전 하나를 남기므로 하나도 못 치우면 둘 다 1만쯤이 된다. 경우별로 무엇이 지우지 못하게 하는지는 말하지 않았고, 출처 문장은 예상을 받은 뒤 피드백에 건다.
- 사람의 예상과 이유(2026-10-27, 원문): "1. MySQL / PostgreSQL * (가): 훨씬 작아 / 훨씬 작아, A 세션 트랜잭션이 없기 때문에 매 UPDATE마다 purge, vacuum이 동작해서 이전 버전을 B 세션 트랜잭션 직후 바로 지워졌을거라 생각해. * (나): 1만에 가까워 / 1만에 가까워, A 세션 트랜잭션이 시작되었고 id = 1인 행을 참조하기 때문에 B 세션에서 발생한 수정에 대한 이전 버전이 A 세션 트랜잭션이 끝날 때까지 유지될 것이라 생각해. 그리고 REPEATABLE READ이기 때문에 A 세션 트랜잭션의 읽기 작업이 진행되는 동안 B 세션 트랜잭션의 수정 작업이 진행될 수 있어서 A 세션 트랜잭션이 끝나는 걸 B 세션이 트랜잭션이 기다릴 필요가 없어. * (다): 1만에 가까워 / 1만에 가까워, 이유는 (나)와 같아. * (라): 훨씬 작아 / 훨씬 작아, 트랜잭션만 시작되고 특정 행을 A 세션에서 조회하지 않았기 때문에 해당 행에 대한 이전 버전이 B 세션 트랜잭션 안에서 바로 제거되어서 1만보다 훨씬 작을거라 생각해. * (마): 훨씬 작아 / 훨씬 작아, B 세션이 진행하려다가 MySQL은 데드락 오류로 실패해서 이전 버전을 만들지 않을거라 생각하고 postgreSQL도 같을 거라 생각해."
- 틀렸다고 볼 조건: 따로 적지 않았다. 적은 쪽(1만 근처, 1만보다 훨씬 작음)과 다르면 빗나감으로 판정한다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. `history_lab.py` 기본값으로 조건마다 워밍업 1회와 3회를 돌렸고 세 번 모두 같은 쪽이었다) 값은 아래와 같다. B의 `UPDATE` 1만 번은 모든 경우에서 기다림 없이 끝났고 새 세션은 11000을 읽었다.

  | 경우 | MySQL History list length (B가 끝난 직후) | PostgreSQL dead but not yet removable |
  |---|---|---|
  | (가) 트랜잭션 없음 | 13, 89, 116 | 0, 0, 0 |
  | (나) REPEATABLE READ, 읽고 둠 | 10002, 10002, 10002 | 10000, 10000, 10000 |
  | (다) READ COMMITTED, 읽고 둠 | 29, 90, 58 | 0, 0, 0 |
  | (라) REPEATABLE READ, 열기만 | 289, 75, 182 | 0, 0, 0 |
  | (마) REPEATABLE READ, 다른 표 `UPDATE` | 226, 26, 103 | 10000, 10000, 10000 |

  설명한 것은 넷이다. (1) 이전 버전을 지우지 못하게 하는 것은 그 버전이 필요할 수 있는 스냅숏(읽기 뷰)을 가진 트랜잭션이다. [InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html): "Update undo logs are used also in consistent reads, but they can be discarded only after there is no transaction present for which InnoDB has assigned a snapshot that in a consistent read could require the information in the update undo log to build an earlier version of a database row." [Routine Vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html): "the row version must not be deleted while it is still potentially visible to other transactions." (2) 그래서 경우마다 B가 고치는 동안 A가 스냅숏을 쥐고 있었는지를 보면 된다. (나)는 REPEATABLE READ의 첫 읽기에서 만든 스냅숏을 `COMMIT`까지 쓴다(문제 상황 1-2). (다)는 READ COMMITTED라 문장마다 새 스냅숏을 만들고 그 문장이 끝나면 놓는다(문제 상황 1·2). (라)는 `START TRANSACTION`만으로는 두 DB 모두 스냅숏이 아직 없다(문제 상황 1-2). (마)는 MySQL의 `UPDATE`가 스냅숏을 만들지 않고 PostgreSQL은 첫 문장인 `UPDATE` 때 만든다(문제 상황 1-2 변형에서 MySQL 3, PostgreSQL 2가 나온 이유와 같다). A는 `visits`, B는 `accounts`를 고쳐 서로 기다리지 않았고 데드락도 없었다. (3) (가)에서 치운 방식: MySQL purge는 `UPDATE`마다가 아니라 백그라운드 스레드가 주기적으로 돌아([Purge Configuration](https://dev.mysql.com/doc/refman/8.4/en/innodb-purge-configuration.html): "Purge runs on a periodic schedule.") B가 끝난 직후에도 수십~백여 개가 남아 있었다. PostgreSQL은 이 표의 자동 VACUUM을 꺼 두었는데도 0이었고 표 크기도 8192바이트 그대로였다. VACUUM이 아니라 `UPDATE`가 같은 페이지를 다시 읽을 때 하는 페이지 정리(HOT pruning)가 지웠다([Heap-Only Tuples](https://www.postgresql.org/docs/18/storage-hot.html): "row versions other than the oldest and the newest can be completely removed during normal operation, including SELECTs, instead of requiring periodic vacuum operations"). (4) B가 기다리지 않는다는 덧붙임은 맞았다. 평범한 `SELECT`가 락을 걸지 않아서이며 REPEATABLE READ라서는 아니다(READ COMMITTED에서도 같았다). (나)의 이유 "id = 1인 행을 참조하기 때문"이 맞는지는 아래 변형 (바)로 가린다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): 경우 다섯 × DB 둘 10개 중 (가)(나)(라)의 두 DB와 (마)의 MySQL 7개 적중(7/10, 누적 22/39). (마) MySQL은 값은 맞았지만 이유(데드락으로 B가 실패)는 틀렸다. (다)의 두 DB와 (마)의 PostgreSQL은 빗나갔다.
- 현재 확인한 부분: A가 트랜잭션을 연 채 읽으면 이전 버전이 남는다는 것은 혼자 예상했다. 다만 그 근거를 "A가 그 행을 참조해서"로 봤고((라)의 이유도 같다), READ COMMITTED의 문장 단위 스냅숏과 MySQL `UPDATE`가 스냅숏을 만들지 않는다는 것(1-2 변형)을 정리 쪽에 적용하지 못했다. 데드락은 두 트랜잭션이 서로 상대가 쥔 락을 기다릴 때 생기는데, 서로 다른 표를 고쳐 기다릴 락이 없는 (마)에서 예상했다.

### 문제 상황 4 변형: 다른 표만 읽고 둔 트랜잭션

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 문제 상황 4의 (나)에서 A가 읽는 표만 바꾼다. A는 `accounts`를 한 번도 읽지 않은 채 B가 `accounts`를 1만 번 고친다.

| 경우 | A의 격리 수준 | B가 고치기 전에 A가 실행하고 그대로 둔 문장 |
|---|---|---|
| (바) | REPEATABLE READ | `START TRANSACTION;`<br>`SELECT n FROM visits WHERE id = 1;` |

물은 것: B가 끝난 직후 MySQL History list length와 PostgreSQL dead but not yet removable이 1만 근처일지 훨씬 작을지, B가 끝난 뒤 A가 처음으로 `SELECT balance FROM accounts WHERE id = 1;`을 하면 받을 값(두 DB), 이유와 틀렸다고 볼 조건. `history_lab.py`의 경우 `rr-read-other`다.

- 사람의 질문(2026-10-27, 원문): "내가 몰랐던 규칙이 너무 많이 나왔어. 표준 용어로 정리가 필요해. RR이 첫 읽기에서 만든 스냅샷을 commit까지 사용한다는게 무슨말이야 mysql, pg 둘다 해당하는 이야기야? RC가 문장만다 새 스냅샷을 만들고 문장이 끝나면 놓는다는 건 무슨 의미야? pg는 트랜잭션 시작할 때 스냅샷을 만든다고 하지 않았어? 스냅샷 생애주기가 헷갈려. consistent read가 아니라 UPDATE에서 스냅샷을 만드는 거였어? hot pruning은 또 뭐야."
- 에이전트 설명(예상 전): 스냅숏(MySQL 용어로 read view)의 생애주기를 표로 정리했다. 스냅숏은 "이 시점까지 커밋된 것만 보인다"는 DB의 한 시점 모습이고, 평범한 `SELECT`가 스냅숏으로 읽는 것이 consistent read(일관된 읽기)다.

  | | MySQL InnoDB | PostgreSQL |
  |---|---|---|
  | REPEATABLE READ: 만드는 때 | 트랜잭션의 첫 consistent read(평범한 `SELECT`). `START TRANSACTION WITH CONSISTENT SNAPSHOT`이면 그 즉시 | 트랜잭션의 첫 문장(`SELECT`든 `UPDATE`든. `BEGIN` 같은 트랜잭션 제어 문장은 빼고) |
  | REPEATABLE READ: 놓는 때 | `COMMIT` 또는 `ROLLBACK` | 같음 |
  | READ COMMITTED | 평범한 `SELECT` 한 문장마다 새로 만들고, 그 문장이 끝나면 놓음 | 문장마다 새로 만들고, 그 문장이 끝나면 놓음 |
  | `START TRANSACTION`만 했을 때 | 아직 없음 | 아직 없음 |
  | `UPDATE`·`DELETE`·`FOR UPDATE` | 스냅숏을 만들지도 쓰지도 않고, 지금 커밋된 최신 행을 잠가 고침 | 스냅숏으로 대상 행을 찾음. REPEATABLE READ는 그 행을 남이 스냅숏 뒤에 고쳐 커밋했으면 오류 40001, READ COMMITTED는 최신 버전으로 다시 확인하고 고침 |

  표의 근거: REPEATABLE READ에서 만드는 때는 문제 상황 1-2와 그 변형, 문제 상황 4의 (라)(마). READ COMMITTED는 문제 상황 1·2와 4의 (다). `UPDATE`는 문제 상황 3. PostgreSQL을 "트랜잭션을 시작할 때 만든다"로 기억한 것은 1-3과 문제 상황 3 피드백에서 인용한 문서 문장("as of the transaction start time", "after the repeatable read transaction began")이 느슨하게 쓴 탓이고, 같은 문서의 정의는 "a query in a repeatable read transaction sees a snapshot as of the start of the first non-transaction-control statement in the transaction"(문제 상황 1-2에 인용)이다. HOT pruning은 두 가지를 합친 말이다. PostgreSQL에서 인덱스에 걸린 열을 바꾸지 않는 `UPDATE`는 같은 페이지에 자리가 있으면 새 버전을 그 페이지에 쓰고 인덱스 항목을 새로 만들지 않는다(HOT, heap-only tuple). 그렇게 한 페이지에 이어진 버전 중 이제 아무도 볼 수 없는 것을, 그 페이지를 읽거나 고치는 평소 문장이 그 자리에서 지운다(pruning). VACUUM 없이 페이지 하나 안에서 하는 정리다.
- 사람의 질문(2026-10-27, 원문): "그림으로 설명해줘"
- 에이전트 설명(예상 전): 위 표를 그림으로 다시 그렸다. A가 순서 2에 하는 일만 바꾼 여섯 경우다. A는 순서 1에 트랜잭션을 열고, 순서 4에 `SELECT balance FROM accounts WHERE id = 1;`로 읽고, 순서 5에 `COMMIT`한다. B는 순서 3에 `UPDATE accounts SET balance = 700 WHERE id = 1;`을 자동 커밋한다(처음 잔액 1000, 문제 상황 2의 값). ●는 스냅숏을 만든 때, ━는 쥐고 있는 동안, ✕는 놓은 때, ·는 트랜잭션은 열려 있지만 쥔 스냅숏이 없는 때다.

  | A의 경우 | DB | 순서 1 | 순서 2 | 순서 3 (B 커밋) | 순서 4 | 순서 5 |
  |---|---|---|---|---|---|---|
  | REPEATABLE READ, 순서 2에 같은 행 `SELECT` | 같음 | `START` · | `SELECT` ● → 1000 | ━ | `SELECT` ━ → 1000 | `COMMIT` ✕ |
  | READ COMMITTED, 순서 2에 같은 행 `SELECT` | 같음 | `START` · | `SELECT` ●✕ → 1000 | · | `SELECT` ●✕ → 700 | `COMMIT` · |
  | REPEATABLE READ, 순서 2에 아무것도 안 함 | 같음 | `START` · | · | · | `SELECT` ● → 700 | `COMMIT` ✕ |
  | REPEATABLE READ, 순서 2에 다른 표 `UPDATE` | MySQL | `START` · | `UPDATE visits` · (최신 행을 잠가 고침) | · | `SELECT` ● → 700 | `COMMIT` ✕ |
  | REPEATABLE READ, 순서 2에 다른 표 `UPDATE` | PostgreSQL | `START` · | `UPDATE visits` ● | ━ | `SELECT` ━ → 1000 | `COMMIT` ✕ |
  | REPEATABLE READ, `START TRANSACTION WITH CONSISTENT SNAPSHOT` | MySQL | `START …` ● | ━ | ━ | `SELECT` ━ → 1000 | `COMMIT` ✕ |

  순서 4에서 읽는 값은 스냅숏을 만든 때 커밋돼 있던 값이다. ●가 순서 3보다 앞이면 B가 고치기 전 값 1000, 뒤면 700이다. 트랜잭션이 열려 있는 것과 스냅숏을 쥐고 있는 것은 다르다. 마지막 줄만 이번 실험에서 재지 않은 문서 내용이다.

  이전 버전이 남는 곳과 HOT pruning도 그렸다. B가 1000을 700으로 고친 직후, InnoDB는 표의 행에 최신 값 700만 두고 숨은 열 `DB_ROLL_PTR`(roll pointer)가 고치기 전 값 1000이 적힌 undo log 레코드를 가리킨다. purge 스레드가 주기적으로 돌며 필요 없어진 undo log를 지운다. PostgreSQL은 같은 표 페이지에 1000 버전(xmax = B, dead tuple)과 700 버전(xmin = B)이 함께 있고 t_ctid로 이어지며, pruning(평소 문장, 페이지 하나)과 VACUUM(표 전체, 보통 autovacuum)이 필요 없어진 dead tuple을 지운다. HOT pruning은 열린 스냅숏 없이 B가 잔액을 세 번 올린 페이지로 그렸다.

  | | 인덱스 | 칸(item identifier) | 버전 |
  |---|---|---|---|
  | 정리 전 | id 1 → 칸 1 | 칸 1~4가 각자 버전을 가리킴 | 1000 → 1001 → 1002 → 1003 (HOT 사슬, 앞의 셋은 이제 아무도 볼 수 없음) |
  | 정리 후 | 그대로 id 1 → 칸 1 | 칸 1은 칸 4로 가는 redirect, 칸 2·3은 빈 칸(다시 씀), 칸 4 → 1003 | 1003만 남고 나머지 자리는 빈 공간 |
- 사람의 질문(2026-10-27, 원문): "스냅샷을 쥔다/놓는다가 표준용어야?"
- 에이전트 설명(예상 전): 아니다. 그림을 설명하려고 고른 쉬운 말이다. 두 DB 문서가 쓰는 말은 아래와 같고, 이후 설명은 "만든다(take)", "버린다(discard)", "스냅숏이 있는 동안"으로 쓴다. 위 두 설명의 "쥔다/놓는다"는 그때 한 설명의 기록이라 그대로 둔다.

  | 위에서 쓴 말 | MySQL | PostgreSQL |
  |---|---|---|
  | 만든다 | establish, take, set. [Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html): "the snapshot established by the first such read", "when the transaction's snapshot was taken", READ COMMITTED는 "sets and reads its own fresh snapshot" | take, acquire. [SET TRANSACTION](https://www.postgresql.org/docs/18/sql-set-transaction.html): "READ COMMITTED mode takes a new snapshot for each command", "when first acquiring its snapshot" |
  | 쥐고 있다 | 정해진 동사가 없다. [InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)은 "InnoDB has assigned a snapshot"처럼 트랜잭션에 스냅숏이 할당돼 있다고 쓴다 | 정해진 동사가 없다. [Transaction Isolation](https://www.postgresql.org/docs/18/transaction-iso.html)은 문장이 스냅숏을 "sees"한다고 쓴다 |
  | 놓는다 | Consistent Nonlocking Reads에는 버리는 동사가 없고 "You can get a fresher snapshot for your queries by committing the current transaction and after that issuing new queries."라고 쓴다. InnoDB 소스 코드(`storage/innobase/read/read0read.cc`, 8.4)는 read view를 `MVCC::view_open`으로 열고 `MVCC::view_close`로 닫는다 | discard. SET TRANSACTION: "the snapshot would be discarded immediately" |
- 사람의 예상과 이유(2026-10-28, 원문): "1. 둘다 훨씬 작아 2. 수 백개, 0개 (mysql, pg) 3. 서로 다른 테이블을 조회하기 때문에 서로가 같은 행을 참조하지 않아서 각 테이블에 각 스레드가 동시 접근 가능해서 b의 이전 버전이 필요하지 않아. 그래서 mysql은 purge가 백그라운드에서 이전 버전 행을 정리하고 pg는 hot pruning으로 정리되"
- 에이전트 확인(피드백 전): 2번은 B가 끝난 뒤 A가 처음 읽는 `balance` 값을 물은 것이라, "수 백개, 0개"는 1번의 두 숫자(MySQL History list length, PostgreSQL dead but not yet removable)로 기록하고 A가 받을 값을 다시 물었다. 틀렸다고 볼 조건은 적지 않았다.
- 사람의 예상(2번을 다시 물은 답, 2026-10-28, 원문): "둘다 11000이야"
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 10-27, `history_lab.py` 기본값으로 워밍업 1회와 2회) 값은 MySQL History list length 10002, 10002, PostgreSQL dead but not yet removable 10000, 10000이고, B가 끝난 뒤 A가 처음 읽은 `balance`는 두 DB 모두 1000이었다. (나)와 같은 결과다. 설명한 것은 넷이다. (1) 스냅숏은 행이나 표 하나가 아니라 DB 전체의 한 시점 모습이다. [Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html): "A consistent read means that InnoDB uses multi-versioning to present to a query a snapshot of the database at a point in time." [Introduction](https://www.postgresql.org/docs/18/mvcc-intro.html): "This means that each SQL statement sees a snapshot of data (a database version) as it was some time ago, regardless of the current state of the underlying data." A의 `SELECT n FROM visits`는 MySQL에서 첫 consistent read, PostgreSQL에서 첫 문장이라 두 DB 모두 이때 DB 전체의 스냅숏을 만들고, REPEATABLE READ라 `COMMIT`까지 쓴다. 그 스냅숏 속 `accounts`의 잔액은 1000이라 B가 끝난 뒤 처음 읽어도 1000이다. (2) 이전 버전을 지울지는 트랜잭션이 실제로 읽은 행이 아니라 그 버전이 필요할 수 있는지로 정한다. DB는 A가 다음에 어느 표를 읽을지 모른다. 문제 상황 4 피드백 (1)의 MySQL 문장도 "could require"라고 쓴다. [idle_in_transaction_session_timeout](https://www.postgresql.org/docs/18/runtime-config-client.html): "Even when no significant locks are held, an open transaction prevents vacuuming away recently-dead tuples that may be visible only to this transaction" (3) 이유 중 B가 기다리지 않고 동시에 고친다는 것은 맞지만, 락이 없다는 것과 이전 버전을 지울 수 있다는 것은 별개다. MySQL은 purge가 백그라운드에서 돌고 PostgreSQL은 HOT pruning이 지운다는 방식도 맞지만, 둘 다 어떤 스냅숏도 볼 수 없는 버전만 지운다. A의 스냅숏이 있는 동안에는 HOT pruning도 지우지 못해 PostgreSQL에 10000이 남았다. (4) 그래서 (나)의 이유 "id = 1인 행을 참조하기 때문에"는 원인이 아니다. 원인은 A에게 스냅숏이 있다는 것이고, 어느 표를 읽다가 만들었는지는 상관없다. 문제 상황 4의 (마)에서 두 DB가 갈린 것도 같은 이유다(PostgreSQL만 `UPDATE visits`에서 스냅숏을 만든다).
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): 1번(B가 끝난 직후의 두 숫자)과 2번(A가 처음 읽은 값) × 두 DB 4개 모두 빗나감(0/4, 누적 22/43).
- 현재 확인한 부분: 정리 방식(MySQL purge는 백그라운드 스레드, PostgreSQL은 HOT pruning)과 B가 기다리지 않는다는 것은 알고 있었다. 이전 버전을 지울지를 "그 행을 참조했는지"와 동시 접근(락)으로 판단했고, 스냅숏이 DB 전체의 한 시점이라 다른 표를 읽어 만든 스냅숏도 `accounts`의 이전 값을 붙잡는다는 것은 적용하지 못했다.
- 사람의 질문(2026-10-28, 원문): "스냅샷은 매 트랜잭션마다 만들어지는거야? 그러면 동시에 다수에 트랜잭션이 열리면 그 개수에 db 총 용량 만큼 스냅샷이 더 생기는거야? 스레드 풀로 요청의 개수를 제한할 수는 있겠지만 그건 너무 비효율적인거 아니야?"
- 에이전트 설명(문제 상황 4-1 예상 전): 스냅숏은 DB를 복사한 것이 아니라, 어느 트랜잭션의 변경까지 보일지를 정하는 트랜잭션 ID 몇 개와 만들 때 진행 중이던 트랜잭션 ID 목록이다. 크기는 DB 용량이 아니라 그때 진행 중이던 트랜잭션 수에 따라 달라진다. 만드는 횟수는 많다. REPEATABLE READ는 트랜잭션마다 하나, READ COMMITTED는 문장마다 하나이고, 자동 커밋으로 실행한 `SELECT` 하나도 그 자체가 트랜잭션이라 하나를 만든다.

  | 뜻 | MySQL InnoDB 읽기 뷰(read view) | PostgreSQL 스냅숏 |
  |---|---|---|
  | 이 ID 이상인 트랜잭션의 변경은 안 보임 | `m_low_limit_id` | `xmax` |
  | 이 ID 미만인 트랜잭션의 변경은 보임 | `m_up_limit_id` | `xmin` |
  | 만들 때 진행 중이던 트랜잭션(변경이 안 보임) | `m_ids` | `xip` |

  근거: [System Information Functions](https://www.postgresql.org/docs/18/functions-info.html): "The data type pg_snapshot stores information about transaction ID visibility at a particular moment in time." "pg_snapshot's textual representation is xmin:xmax:xip_list. For example 10:20:10,14,15 means xmin=10, xmax=20, xip_list=10, 14, 15." `pg_current_snapshot()`은 "Returns a current snapshot, a data structure showing which transaction IDs are now in-progress." MySQL 매뉴얼에는 읽기 뷰의 구조가 없어 소스로 확인했다. InnoDB 소스 `storage/innobase/include/read0types.h`(8.4)의 `ReadView` 주석 "Read view lists the trx ids of those transactions for which a consistent read should not see the modifications to the database.", 필드 주석 "The read should not see any transaction with trx id >= this value."(`m_low_limit_id`), "The read should see all trx ids which are strictly smaller (<) than this value."(`m_up_limit_id`), "Set of RW transactions that was active when this snapshot was taken"(`m_ids`). PostgreSQL 소스 `src/include/utils/snapshot.h`(REL_18_STABLE)의 `SnapshotData`: "all XID < xmin are visible to me", "all XID >= xmax are invisible to me", `xip`는 "all xact IDs that are in progress".
  행 버전마다 그 버전을 쓴 트랜잭션의 ID가 붙어 있고(MySQL은 숨은 열 `DB_TRX_ID`. [InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html): "A 6-byte DB_TRX_ID field indicates the transaction identifier for the last transaction that inserted or updated the row." PostgreSQL은 튜플의 xmin(만든 트랜잭션)과 xmax(지우거나 새 버전으로 바꾼 트랜잭션)), 읽을 때 그 ID를 스냅숏과 비교해 보이면 그 버전을, 안 보이면 이전 버전을 쓴다(MySQL은 roll pointer를 따라 undo log에서 되짚어 만들고, PostgreSQL은 힙에 남은 이전 튜플을 본다). 이전 버전은 한 벌만 저장되고 그것이 필요한 스냅숏이 모두 같이 쓴다. InnoDB의 판정은 `ReadView::changes_visible`(ID가 `m_up_limit_id`보다 작거나 자기 것이면 보임, `m_low_limit_id` 이상이면 안 보임, 그 사이면 `m_ids`에 없을 때만 보임)이다.
  직접 보는 방법: PostgreSQL은 `SELECT pg_current_snapshot();`, MySQL은 `SHOW ENGINE INNODB STATUS`의 TRANSACTIONS 부분이 읽기 뷰가 있는 트랜잭션마다 "Trx read view will not see trx with id >= …, sees < …"를 찍는다(`ReadView::print_limits`, `lock_trx_print_wait_and_mvcc_state`. 소스로 확인했고 실행해 보지는 않음).
  그래서 스냅숏 크기 때문에 동시 트랜잭션 수를 줄일 필요는 없다. 문제가 되는 것은 개수가 아니라 오래 열려 있는 스냅숏이고, 그동안 이전 버전을 지우지 못하는 것이 비용이다(문제 상황 4의 (나)와 변형 (바)의 1만 개). [InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html): "It is recommend that you commit transactions regularly, including transactions that issue only consistent reads." 이 비용이 읽기와 쓰기에 어떻게 나타나는지는 문제 상황 4-1에서 잰다.

### 문제 상황 4-1: 열어 둔 트랜잭션이 있을 때의 읽기 시간

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 문제 상황 4와 같은 실행에서 잰다. B가 1만 번을 다 고친 뒤 A가 `SELECT balance FROM accounts WHERE id = 1;`을 7번 읽고, 이어서 새 세션(B가 끝난 뒤 연 자동 커밋 연결)이 같은 문장을 7번 읽어, 각자 읽기 시간의 중앙값을 남긴다. 읽는 값은 문제 상황 4에서 본 대로다.

| 경우 | A가 읽는 값 | 새 세션이 읽는 값 |
|---|---|---|
| (가) 트랜잭션 없음 | 11000 | 11000 |
| (나) REPEATABLE READ, 읽고 둠 | 1000 | 11000 |

물은 것: (나)에서 A의 읽기와 새 세션의 읽기가 (가)의 같은 쪽 읽기보다 확연히 느릴지(중앙값이 3배 이상), 비슷할지(3배 미만). MySQL과 PostgreSQL 각각이라 모두 네 칸이다. 1ms 아래의 읽기 시간은 실행마다 흔들려서 3배를 경계로 둔다. 느리다고 보면 몇 배쯤일지 어림도 적는다(적중 판정에는 쓰지 않는다). 이유와 틀렸다고 볼 조건. B가 한 번 고치는 시간(4-2)과 A가 끝난 뒤의 변화(4-3)는 이어서 따로 묻는다.

- 사람의 질문(2026-10-28, 원문): "질문이 뭐야? 표준 용어로 다시 설명해줘"
- 에이전트 설명(예상 전): 질문을 "long-running transaction이 스냅숏을 가진 채 열려 있을 때 `SELECT`의 latency가 얼마나 늘어나는가"로 다시 썼다. 세션은 A((나)에서 REPEATABLE READ 트랜잭션을 열고 `SELECT` 한 번으로 스냅숏(MySQL은 read view)을 만든 채 `COMMIT`하지 않음, (가)에서는 트랜잭션 없이 자동 커밋), B(writer, 자동 커밋 `UPDATE` 1만 번으로 id 1 행에 커밋된 버전이 1만 개 더 생김), C(지금까지 "새 세션", B가 끝난 뒤 연 자동 커밋 연결이라 `SELECT`마다 새 스냅숏)로 이름 붙였다. 재는 것은 B가 끝난 뒤 A와 C가 같은 primary key lookup을 7번씩 실행한 latency의 median이고, 읽는 버전은 (가)에서 둘 다 최신 11000, (나)에서 A는 스냅숏 시점의 1000(B가 1만 번 고치기 전), C는 최신 11000이다. 물은 것은 그대로다.
- 사람의 예상과 이유(2026-10-28, 원문): "MySQL / PostgreSQL * A: 비슷함 / 확연히 느림 * C: 비슷함 / 비슷함 MySQL의 경우에 (나) 상황에서 B 세션의 특정 행의 이전 버전들이 정리되기 시작했겠지만 백그라운드에서 purge 작업을 진행하기 때문에 바라보는 스냅샷이 다른 트랜잭션의 연산에는 영향을 주지 않을것이라고 생각해서 (가)나 (나)의 조회 시간 차이는 거의 없을거라고 생각함. PostgreSQL의 경우에는 (나)의 상황에서 참조하는 스냅샷이 서로 같아서 특정 행의 이전 버전을 정리하지 못한채로 B 세션이 끝나서 이를 정리하는 작업이 조회시간에 영향을 줄것이라 생각함. 그런데, 이러면 MySQL이랑 다른게 없는거 같은데.. 얘도 다른 스레드나 프로세스에서 정리하면 연산시간엔 영향없는거 아닌가?"
- 틀렸다고 볼 조건: 따로 적지 않았다. 적은 쪽과 다르면 빗나감으로 판정한다. 느리다고 본 칸의 배수 어림도 적지 않았다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 10-27, `history_lab.py` 기본값으로 워밍업 1회와 3회) 값이다. 칸마다 세 실행의 median과 그 가운데 값(배수는 가운데 값끼리 나눔)이다.

  | | MySQL (가) | MySQL (나) | PostgreSQL (가) | PostgreSQL (나) |
  |---|---|---|---|---|
  | A | 0.36, 0.36, 0.40 ms | 9.31, 6.82, 12.85 ms(약 26배) | 0.35, 0.36, 0.40 ms | 0.78, 0.90, 0.88 ms(약 2.4배) |
  | C | 0.36, 0.41, 0.36 ms | 0.43, 0.32, 0.35 ms(약 1배) | 0.37, 0.43, 0.48 ms | 0.71, 0.80, 0.51 ms(약 1.7배) |

  설명한 것은 셋이다. (1) MySQL A가 느린 것은 정리 작업이 아니라 읽을 버전을 만드는 일 때문이다. (나)에서는 purge가 아무것도 지우지 못한다(문제 상황 4의 History list length 10002). 클러스터드 인덱스에는 최신 버전(11000)만 있고 A의 읽기 뷰에는 보이지 않으므로, roll pointer를 따라 undo log 레코드로 한 단계 전 버전을 다시 만들고, 보이지 않으면 또 한 단계 전으로 가서 1만 번을 되짚어야 1000에 닿는다. [InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html): "It also uses the information to build earlier versions of a row for a consistent read." [Undo Logs](https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-logs.html): "If another transaction needs to see the original data as part of a consistent read operation, the unmodified data is retrieved from undo log records." C는 최신 버전이 바로 보여 되짚을 것이 없어 (가)와 같다. (2) PostgreSQL은 이전 버전을 표 안에 두고, (나)에서는 A의 스냅숏 때문에 1만 개를 하나도 지우지 못했다. A든 C든 자기 스냅숏에 보이는 버전을 찾으려면 보이지 않는 버전의 xmin·xmax도 확인하며 지나가야 한다. 다시 만드는 일 없이 비교만 하므로 둘 다 2배 안팎이었다. (3) 이유 끝의 질문("다른 스레드나 프로세스에서 정리하면 연산시간엔 영향없는거 아닌가?")에는, 정리 작업 자체는 읽기를 느리게 하는 원인이 아니고 차이는 이전 버전이 있는 곳과 읽는 쪽이 자기 버전을 찾는 방법에서 나온다고 답했다. MySQL은 표에 최신 버전만 있어 오래된 스냅숏을 가진 쪽(A)만 undo log를 거꾸로 따라가는 비용을 내고, PostgreSQL은 모든 버전이 표에 있어 그 행을 읽는 쪽 모두(A와 C)가 보이지 않는 버전을 건너뛰는 비용을 조금씩 낸다. PostgreSQL의 HOT pruning은 백그라운드가 아니라 그 페이지를 읽는 문장이 직접 하지만, (나)에서는 지울 수 있는 버전이 없었다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): C의 두 DB 적중, A의 두 DB 빗나감(2/4, 누적 24/47). PostgreSQL A는 약 2.4배로 느려졌지만 3배 경계 아래라 빗나감으로 셌고, 경계에 가까워 맥 본 측정에서 바뀔 수 있다.
- 현재 확인한 부분: 정리 작업(purge, VACUUM)이 다른 스레드·프로세스에서 돈다는 것은 알고 있었다. 다만 (나)에서는 A의 스냅숏 때문에 MySQL에서도 이전 버전이 정리되지 않는다는 것(문제 상황 4)을 MySQL 쪽 이유에 적용하지 못했고, 읽기 시간을 정리 작업과 연결해 생각해 MySQL에서 오래된 스냅숏으로 읽으면 undo log로 버전을 되짚어 만든다는 점을 쓰지 못했다.

### 문제 상황 4-2: long-running transaction이 있을 때 writer B의 UPDATE latency

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 문제 상황 4와 같은 실행에서 잰다. B는 `UPDATE accounts SET balance = balance + 1 WHERE id = 1`을 자동 커밋으로 1만 번 실행하고, 1만 번을 2,000번씩 다섯 구간으로 나눠 구간마다 `UPDATE` 한 번의 평균 latency를 남긴다.

| 구간 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `UPDATE` 번호 | 1~2,000 | 2,001~4,000 | 4,001~6,000 | 6,001~8,000 | 8,001~10,000 |

물은 것: (나)(B가 시작하기 전에 A가 REPEATABLE READ 트랜잭션에서 스냅숏을 만들고 B가 끝날 때까지 열어 둠)에서 B의 `UPDATE` latency가 뒤로 갈수록 늘어날지(구간 5의 평균이 구간 1의 1.2배 이상), 평평할지(1.2배 미만). MySQL과 PostgreSQL 각각이라 두 칸이다. 2,000번의 평균이라 읽기 시간보다 덜 흔들려서 1.2배를 경계로 둔다. 피드백에서 (가)(long-running transaction 없음)의 같은 값을 비교 기준으로 함께 보인다. 이유와 틀렸다고 볼 조건.

- 사람의 예상과 이유(2026-10-28, 원문): "둘 다 평평해. MySQL은 항상 최신 버전의 값으로 테이블이 갱신되어 있기 때문에 UPDATE할 대상을 바로 찾을 수 있어. PostgreSQL은 테이블에 모든 버전을 일단 남겨두고 있긴 하지만 최신 버전의 값을 찾는 시간이 그리 길지 않기 때문에 둘다 평평거라 생각해."
- 틀렸다고 볼 조건: 따로 적지 않았다. 적은 쪽과 다르면 빗나감으로 판정한다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 10-27, `history_lab.py` 기본값으로 워밍업 1회와 3회) 값이다. 구간마다 `UPDATE` 한 번의 평균(ms)과 구간 5 / 구간 1 배수를 실행 순서대로 적는다.

  | | 구간 1 → 구간 5 (ms) | 구간 5 / 구간 1 |
  |---|---|---|
  | MySQL (가) | 1.44 → 1.41, 1.48 → 1.51, 1.40 → 1.33 | 0.98, 1.02, 0.95배 |
  | MySQL (나) | 1.57 → 1.40, 1.42 → 1.34, 1.60 → 1.36 | 0.89, 0.94, 0.85배(평평함) |
  | PostgreSQL (가) | 0.84 → 0.64, 0.71 → 0.68, 0.63 → 0.65 | 0.76, 0.96, 1.03배 |
  | PostgreSQL (나) | 0.66 → 0.96, 0.69 → 1.05, 0.70 → 1.02 | 1.45, 1.52, 1.46배(늘어남) |

  설명한 것은 둘이다. (1) MySQL은 이유까지 맞았다. `UPDATE`는 클러스터드 인덱스의 최신 버전을 바로 고치고 undo log 레코드를 하나 쓸 뿐 이전 버전을 따라가지 않는다. (나)에서 purge가 밀려 History list length가 1만이 되어도 기본 설정에서는 writer를 늦추지 않는다. [Purge Configuration](https://dev.mysql.com/doc/refman/8.4/en/innodb-purge-configuration.html): "When the purge lag exceeds the innodb_max_purge_lag threshold, a delay is imposed on INSERT, UPDATE, and DELETE operations to allow time for purge operations to catch up. The default value is 0, which means there is no maximum purge lag and no delay." (2) PostgreSQL은 버전 하나를 확인하는 시간은 짧지만 확인할 버전 수가 늘어난다. B의 `UPDATE`도 고칠 행의 최신 버전을 먼저 찾아야 하고, 오래된 버전에서 최신 버전 쪽으로 사슬을 따라간다. (가)에서는 HOT pruning이 지나간 버전을 그때그때 지워 사슬이 짧고(그림 페이지의 pruning 후처럼 redirect로 바로 간다), (나)에서는 A의 스냅숏 때문에 지울 수 없어 B가 고칠수록 지나가야 할 버전이 1만 개까지 늘어난다. 4-1에서 C가 최신 버전을 읽는 데 1.7배 걸린 것과 같은 비용을 B가 `UPDATE`마다 내고, 그 비용이 점점 커진 것이다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): MySQL 적중, PostgreSQL 빗나감(1/2, 누적 25/49).
- 현재 확인한 부분: MySQL `UPDATE`가 최신 버전을 바로 고친다는 것은 맞게 설명했다. PostgreSQL에서 최신 버전을 찾는 비용을 버전 하나의 시간으로만 보고, (나)에서 지울 수 없는 버전이 B가 고칠수록 쌓여 그 수만큼 비용이 커진다는 것(4-1의 C와 같은 원리)은 적용하지 못했다.

### 문제 상황 4-3: long-running transaction이 끝난 뒤

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 문제 상황 4의 (나)에서 이어진다. B가 1만 번을 다 고치고 A와 C가 읽기를 마친 뒤 A가 `COMMIT`해 스냅숏을 버린다.

- MySQL: A가 `COMMIT`하고 1초, 3초, 10초 뒤 History list length를 읽는다. `COMMIT` 직전 값은 문제 상황 4의 10002다.
- PostgreSQL: 이 표의 자동 VACUUM은 꺼 둔다. A가 `COMMIT`하기 전에 돌린 `VACUUM (VERBOSE) accounts`는 문제 상황 4대로 1만 개를 dead but not yet removable로 남겼다. A가 `COMMIT`한 직후 VACUUM을 한 번 더 돌려 지운 dead tuple 수를 보고, 이어서 표 크기(`pg_relation_size`)를 읽는다. 표 크기는 B가 시작하기 전 8,192바이트(페이지 하나), B가 끝난 직후 368,640바이트(페이지 45개)였다(버전 1만 개가 페이지 하나에 다 들어가지 않는다).

물은 것(세 칸): (1) MySQL에서 `COMMIT` 10초 뒤 History list length가 1,000 이하로 줄어들지, 그보다 많이 남을지. (2) PostgreSQL에서 `COMMIT` 뒤 VACUUM이 지운 dead tuple 수가 9,000 이상일지, 그보다 적을지. (3) PostgreSQL에서 그 VACUUM 뒤 표 크기가 B 전 크기(8,192바이트)로 돌아갈지, 그보다 크게 남을지. 이유와 틀렸다고 볼 조건.

- 사람의 질문과 예상(2026-10-28, 원문): "이전 버전이 지워지는 속도를 내가 어떻게 알아? 이걸 실제 측정없이 어떻게 추측할 수가 있어? 3. 8192 바이트로 돌아가. 사용하지 않는 버전은 hot pruning에서 제거하기 때문이야."
- 에이전트 설명(예상 전): (1)은 purge 속도를 잰 적이 없어 측정 없이 맞히기 어려운 질문이라 적중 판정에서 빼고 어림으로만 받기로 했다. 예상은 정답을 아는지가 아니라 아는 사실로 어디까지 추론할 수 있는지 적어 두는 것이라고 하고, (1)에 쓸 수 있는 단서로 셋을 들었다. A가 `COMMIT`하면 그 버전들을 필요로 하는 스냅숏이 더는 없다, purge는 백그라운드 스레드가 주기적으로 돈다(문제 상황 4 피드백), 문제 상황 4의 (가)에서 B가 약 14초 동안 버전 1만 개를 만드는 동안 History list length가 수십~백여 개에 머물러 purge가 적어도 B가 만드는 속도는 따라잡았다. (2)의 답과 (1)의 어림을 다시 물었다.
- 사람의 답(2026-10-28, 원문): "전혀 모르겠어."
- 에이전트 설명(예상 전): (2)를 작은 질문 둘로 나눴다. A가 `COMMIT`하기 전 VACUUM이 1만 개를 dead but not yet removable로 남긴 이유는 무엇이었나((바) 피드백의 규칙), A가 `COMMIT`하면 그 이유가 아직 남아 있나. 그래도 모르면 "모름"으로 적고 넘어가도 되고, 문제 상황 1-3처럼 모르겠다고 한 칸은 적중 계산에서 뺀다고 했다. (1)의 어림은 모르겠다고 답한 것으로 기록한다.
- 사람의 답(2026-10-28, 원문): "1. 해당 세션의 트랜잭션이 참조하는 스냅샷을 다른 세션의 트랜잭션에서도 참조하고 있었기 때문이야. 2. A가 커밋되면 그 스냅샷을 유지할 이유는 사라져. 그냥 스냅샷이 제거가 되기 때문에 이전 버전들도 제거 대상이 되지만 그게 얼마나 제거되는지는 모르겠어"
- 판정에 쓰는 예상: (1)은 어림으로만 받기로 했고 모르겠다고 답했다. (2)는 이전 버전이 제거 대상이 된다고 했지만 지운 수는 모르겠다고 답해 문제 상황 1-3처럼 적중 계산에서 뺀다. (3)은 "8192 바이트로 돌아가"(이유: hot pruning이 사용하지 않는 버전을 제거). 틀렸다고 볼 조건은 적지 않았다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 10-27, `history_lab.py` 기본값으로 워밍업 1회와 3회) 값이다.

  | 칸 | 결과 |
  |---|---|
  | (1) MySQL History list length(`COMMIT` 직전 10002) | 1초 뒤 0, 7903, 7003. 3초 뒤 0, 0, 0. 10초 뒤 1, 1, 1 |
  | (2) PostgreSQL `COMMIT` 뒤 VACUUM이 지운 dead tuple 수 | 10000, 10000, 10000(dead but not yet removable 0) |
  | (3) PostgreSQL VACUUM 뒤 표 크기 | 368,640바이트 그대로(세 번 모두) |

  설명한 것은 셋이다. (1) (2)를 나눈 두 질문의 답(A가 `COMMIT`하면 버전을 남길 이유가 사라진다)은 맞았다. VACUUM은 한 번 돌 때 그때 지울 수 있는 dead tuple을 표 전체에서 다 지우므로 1만 개가 한 번에 지워졌다. 다만 "다른 세션의 트랜잭션에서도 참조"는 아니다. 스냅숏은 트랜잭션마다 따로 있고 공유하지 않으며, 지우지 못한 것은 A 자신의 스냅숏이 B가 고치기 전에 만들어졌기 때문이다. VACUUM VERBOSE 보고의 removable cutoff가 `COMMIT` 전 "10000 XIDs old"에서 `COMMIT` 뒤 0이 됐다. (2) MySQL은 A의 읽기 뷰가 닫히자 purge 스레드가 history list를 처리해, B가 약 14초 동안 만든 1만 개가 3초 안에 정리됐다. (3) VACUUM은 비운 공간을 표 안에서 다시 쓰게 표시할 뿐 파일을 줄이지 않는다. [Routine Vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html): "The standard form of VACUUM removes dead row versions in tables and indexes and marks the space available for future reuse. However, it will not return the space to the operating system, except in the special case where one or more pages at the end of a table become entirely free and an exclusive table lock can be easily obtained." 남은 버전 11000은 B가 마지막에 쓴 끝 쪽 페이지에 있어 끝 페이지가 비지 않았을 것이다(재지 않은 추론). HOT pruning도 페이지 안의 공간을 비울 뿐 파일 크기는 그대로이고, 파일까지 줄이려면 표를 새로 쓰는 VACUUM FULL이 필요하다: "In contrast, VACUUM FULL actively compacts tables by writing a complete new version of the table file with no dead space." long-running transaction 하나로 표가 페이지 1개에서 45개가 되었고 VACUUM 뒤에도 그 크기가 남았다. 비운 공간은 이후 INSERT·UPDATE가 다시 쓴다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): (1)은 어림이라 판정하지 않고, (2)는 모르겠다고 답해 뺀다. (3) 빗나감(0/1, 누적 25/50). 묶음 2(문제 상황 4, 변형 (바), 4-1~4-3)는 10/21.
- 현재 확인한 부분: A가 끝나면 이전 버전이 제거 대상이 된다는 것은 작은 질문으로 나누자 스스로 답했다. 스냅숏을 여러 트랜잭션이 함께 참조한다고 보는 부분이 남아 있고(4-1의 "참조하는 스냅샷이 서로 같아서"도 같다), 이전 버전을 지우는 것과 파일 크기가 줄어드는 것을 같은 일로 보았다.

### 문제 상황 5: 되돌린 주문과 남은 기록

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 묶음 3의 첫 문제다. 주문 서비스가 주문을 `orders`에, 주문 기록을 `order_logs`에 남긴다. `orders`는 InnoDB 표이고, `order_logs`는 예전에 storage engine을 MyISAM으로 정해 만든 표다. 주문 요청(세션 A)은 트랜잭션 안에서 두 표에 한 행씩 넣은 뒤 결제가 실패해 `ROLLBACK`한다. 그사이 관리 화면(세션 B, 자동 커밋)이 두 표의 행 수를 센다. 두 표는 빈 상태에서 시작하고, 격리 수준은 MySQL 기본값(REPEATABLE READ)이다. MyISAM은 MySQL에만 있어 PostgreSQL에서는 돌리지 않는다.

```sql
CREATE TABLE orders (id INT PRIMARY KEY, amount INT NOT NULL) ENGINE=InnoDB;
CREATE TABLE order_logs (id INT PRIMARY KEY, order_id INT NOT NULL) ENGINE=MyISAM;
```

| 순서 | 세션 A (주문 요청) | 세션 B (관리 화면) |
|---|---|---|
| 1 | `START TRANSACTION;`<br>`INSERT INTO orders (id, amount) VALUES (1, 5000);`<br>`INSERT INTO order_logs (id, order_id) VALUES (1, 1);` | |
| 2 | | `SELECT (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM order_logs);` → (가) |
| 3 | 결제 실패로 `ROLLBACK;` → (나) | |
| 4 | | 2번과 같은 `SELECT` → (다) |

물은 것(다섯 칸): (가)와 (다)에서 B가 읽는 두 개수(`orders`, `order_logs`), (나)에서 `ROLLBACK`이 어떻게 끝나는지(정상, 경고, 오류 중 하나. 경고나 오류라면 무엇을 알리는지). 이유와 틀렸다고 볼 조건. 순서표는 `order-rollback`이며, A가 3번 바로 뒤에 `SHOW WARNINGS`로 경고 목록을 읽어 함께 남긴다(경고가 없으면 빈 목록).

- 사람의 예상과 이유(2026-10-28, 원문): "1. 0, 0 / 커밋되지 않은 데이터는 읽히지 않아서 둘 다 0개로 조회될거라 생각해 2. 정상으로 끝날거라 생각해. 3. 0, 0 / 결과적으로 변경된게 없다고 생각해"
- 틀렸다고 볼 조건: 따로 적지 않았다. 적은 값과 다르면 빗나감으로 판정한다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 10-28, `isolation_lab.py --smoke`로 워밍업 1회와 2회를 돌렸고 세 번 모두 같았다. 10-27 초안 점검도 같았다) 값은 아래와 같다.

  | 칸 | 결과 |
  |---|---|
  | (가) 2번에서 B가 읽은 두 개수 | `orders` 0, `order_logs` 1 |
  | (나) 3번 `ROLLBACK` | 오류 없이 끝남. 바로 뒤 `SHOW WARNINGS`에 경고 1196(`ER_WARNING_NOT_COMPLETE_ROLLBACK`) "Some non-transactional changed tables couldn't be rolled back" |
  | (다) 4번에서 B가 읽은 두 개수 | `orders` 0, `order_logs` 1 |

  설명한 것은 셋이다. (1) InnoDB 표(`orders`)는 예상대로였다. 커밋 전 변경은 B에게 보이지 않았고 `ROLLBACK` 뒤에도 0이다. (2) MyISAM은 트랜잭션을 지원하지 않는 storage engine이라 커밋이라는 단계가 없다([The MyISAM Storage Engine](https://dev.mysql.com/doc/refman/8.4/en/myisam-storage-engine.html)의 기능 표에서 Transactions가 No). `INSERT`가 끝나는 순간 표에 반영되고, `START TRANSACTION` 안에서 실행해도 같다. 커밋 전 변경을 다른 세션에서 숨기는 것은 InnoDB의 MVCC가 하는 일이고(행마다 고친 트랜잭션 ID를 남기고 읽기 뷰로 거른다, 묶음 2), MyISAM에는 그런 장치가 없어 B가 바로 본다. [START TRANSACTION, COMMIT, and ROLLBACK Statements](https://dev.mysql.com/doc/refman/8.4/en/commit.html): "If you use tables that are not transaction-safe within a transaction, changes to those tables are stored at once, regardless of the status of autocommit mode." (3) `ROLLBACK`은 InnoDB 쪽 변경만 되돌리고, MyISAM 쪽은 되돌릴 undo log가 없어 그대로 둔 채 경고만 남긴다. 같은 문서: "If you issue a ROLLBACK statement after updating a nontransactional table within a transaction, an ER_WARNING_NOT_COMPLETE_ROLLBACK warning occurs. Changes to transaction-safe tables are rolled back, but not changes to nontransaction-safe tables." 오류가 아니라 경고라서 실행 틀(PyMySQL)도 `ROLLBACK`을 정상으로 끝난 단계로 기록했다. 경고를 따로 읽지 않으면 애플리케이션은 전부 되돌려졌다고 보게 된다. 그 결과 주문은 없는데 주문 기록만 남았다. 트랜잭션의 원자성(전부 반영되거나 전부 되돌려짐)은 트랜잭션을 지원하는 storage engine의 표에만 적용된다. 같은 문서도 "For best results, transactions should be performed using only tables managed by a single transaction-safe storage engine."이라고 한다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): (가)·(다)의 `orders` 2개 적중, (가)·(다)의 `order_logs`와 (나) 빗나감(2/5, 누적 27/55).
- 현재 확인한 부분: InnoDB 표에서 커밋 전 변경이 다른 세션에 보이지 않고 `ROLLBACK`으로 사라진다는 것은 맞혔다. 두 표를 같은 규칙으로 보았고, MyISAM이 트랜잭션을 지원하지 않는다는 점과 그 결과(문장이 끝나는 순간 반영되어 다른 세션에 보이고, `ROLLBACK`으로 되돌려지지 않으며, MySQL은 이를 오류가 아닌 경고로 알린다)는 답에 나오지 않았다.

### 문제 상황 5-1: 재고 리포트가 도는 중에 들어온 차감

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 재고 리포트(세션 A, 자동 커밋)가 `stock` 표 전체를 읽는 오래 걸리는 쿼리를 돌리는 중에, 주문 처리(세션 B, 자동 커밋)가 상품 2의 재고를 1 줄인다. 같은 순서표를 `stock` 표의 storage engine만 바꿔 MyISAM과 InnoDB로 한 번씩 돌린다. 격리 수준은 MySQL 기본값(REPEATABLE READ)이다. `WHERE SLEEP(1) = 0`은 행마다 1초씩 쉬게 해 오래 걸리는 리포트를 흉내 낸다(`SLEEP`은 0을 돌려주므로 모든 행이 나온다).

```sql
CREATE TABLE stock (id INT PRIMARY KEY, qty INT NOT NULL) ENGINE=MyISAM;  -- 한 번은 ENGINE=InnoDB
INSERT INTO stock (id, qty) VALUES (1, 10), (2, 10);
```

| 순서 | 세션 A (재고 리포트) | 세션 B (주문 처리) |
|---|---|---|
| 1 | `SELECT id, qty FROM stock WHERE SLEEP(1) = 0;` 행마다 1초, 모두 약 2초 → (나) | |
| 2 | (1번이 도는 중) | A가 1번을 시작하고 약 0.8초 뒤 `UPDATE stock SET qty = qty - 1 WHERE id = 2;` → (가) |
| 3 | | `SELECT id, qty FROM stock ORDER BY id;` |

물은 것(네 칸): (가) B의 `UPDATE`가 A의 읽기가 끝날 때까지 기다릴지, 바로 끝날지. (나) A의 `SELECT`가 돌려주는 id 2의 `qty`가 10일지 9일지. MyISAM과 InnoDB 각각. 이유와 틀렸다고 볼 조건. 순서표는 `stock-read-myisam`과 `stock-read-innodb`다. B의 2번을 보내는 때(약 0.8초 뒤)는 [순서표 실행 규칙](#순서표-실행-규칙)의 0.5초와 0.3초에서 나온다. A의 1번은 약 2초 걸려 같은 규칙으로는 기다림으로 기록되지만, 락을 기다린 것이 아니라 `SLEEP` 때문이다. B가 기다렸는지는 2번의 기다림 기록과 걸린 시간으로 본다.

- 사람의 예상과 이유(2026-10-28, 원문): "MyISAM / InnoDB 1. 바로 끝남 / 바로 끝남, MyISAM은 트랜잭션 개념이 없으니 A 세션의 작업과 상관없이 바로 업데이트 및 조회하고 끝날거라 생각함. InnoDB는 트랜잭션 개념은 있으나 세션 A가 단순 읽기 작업만 수행하기 때문에 배타락이 사용되지 않아서 세션 B도 작업을 곧바로 진행해서 바로 끝날거라 생각함. 2. 9 / 10, 트랜잭션 개념이 없는 MyISAM은 변경된 최신 버전을 그대로 가져온다고 추측함. InnoDB는 RR에서 한 트랜잭션에서 첫 조회 시의 시점에 대한 스냅샷을 참조하기 때문에 세션 B가 동작하기 전의 데이터인 10을 가져온다고 추측함."
- 틀렸다고 볼 조건: 따로 적지 않았다. 적은 쪽과 다르면 빗나감으로 판정한다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 10-28, `isolation_lab.py --smoke`로 엔진마다 워밍업 1회와 2회를 돌렸고 세 번 모두 같았다. 10-27 초안 점검도 같았다) 값은 아래와 같다. B의 2번은 A가 1번을 시작하고 0.83초 뒤에 보냈고, A의 1번은 두 엔진 모두 약 2.0초 걸렸다.

  | 칸 | MyISAM | InnoDB |
  |---|---|---|
  | (가) B의 `UPDATE` | 1.20~1.21초 기다리다 A의 1번이 끝난 뒤(시작부터 약 2.03초) 끝남 | 바로 끝남(1ms 미만) |
  | (나) A가 읽은 id 2의 `qty` | 10 | 10 |
  | B의 3번(참고) | (1, 10), (2, 9) | (1, 10), (2, 9) |

  설명한 것은 셋이다. (1) InnoDB는 이유까지 맞았다. 평범한 `SELECT`(consistent read)는 락을 하나도 걸지 않아, B의 `UPDATE`가 id 2 행에 배타 락을 걸고 바로 고친다. [Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html): "A consistent read does not set any locks on the tables it accesses, and therefore other sessions are free to modify those tables at the same time a consistent read is being performed on the table." A는 자동 커밋이라 `SELECT` 하나가 트랜잭션 하나이고, 스냅숏은 그 `SELECT`가 시작할 때 만들어진다. B의 커밋(0.83초)이 스냅숏보다 늦으므로 A는 10을 읽는다. A가 id 2에 닿은 것은 행마다 1초씩 쉰 뒤인 약 1초 뒤로 보이고, 그때 최신 버전은 이미 9라 undo log로 10을 다시 만들어 읽었을 것이다(묶음 2와 같은 원리, 재지 않은 추론). (2) MyISAM은 트랜잭션은 없지만 락은 있다. 문장 하나가 도는 동안 표 전체에 락을 건다. A의 `SELECT`가 표에 읽기 락을 쥔 동안 B의 `UPDATE`는 쓰기 락을 얻지 못하고 줄을 서서 기다린다. B가 고치는 행을 A가 지금 읽고 있든 아니든 표 전체가 잠겨 있어 기다린다. [Internal Locking Methods](https://dev.mysql.com/doc/refman/8.4/en/internal-locking.html): "MySQL uses table-level locking for MyISAM, MEMORY, and MERGE tables, permitting only one session to update those tables at a time." 쓰기 락을 주는 규칙: "If there are no locks on the table, put a write lock on it." "Otherwise, put the lock request in the write lock queue." (3) MyISAM (나)의 9는 (가)에서 B가 바로 끝난다고 본 데서 이어진 추론이고, 스냅숏이 없어 최신 값을 읽는다는 부분은 맞다. 다만 B가 기다렸기 때문에 A가 id 2를 읽을 때는 아직 10이었다. 문제 상황 5에서 A의 트랜잭션이 열린 채인데도 B가 `order_logs`를 바로 읽은 것도 같은 규칙이다. MyISAM의 락은 트랜잭션이 아니라 문장이 끝나면 풀리고, 그때 A의 `INSERT`는 이미 끝나 있었다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): InnoDB 두 칸 적중, MyISAM 두 칸 빗나감(2/4, 누적 29/59). 묶음 3(문제 상황 5, 5-1)은 4/9.
- 현재 확인한 부분: InnoDB에서 평범한 읽기가 쓰기를 막지 않는다는 것과, 오래 걸리는 읽기가 시작할 때의 스냅숏으로 읽는다는 것은 이유까지 맞혔다. MyISAM에 트랜잭션이 없다는 것(문제 상황 5)은 바로 적용했지만 트랜잭션이 없는 것을 락이 없는 것으로 보았고, MyISAM이 문장이 도는 동안 표 전체에 락을 건다는 점은 답에 나오지 않았다.

### 문제 상황 6: 커밋을 디스크에 언제 내릴까

에이전트가 제시한 가정 상황이며 실제 측정 결과가 아니다. 묶음 4의 문제다. 결제 이벤트를 남기는 서비스가 이벤트 하나를 자동 커밋 `INSERT` 한 번으로 기록한다(트랜잭션 하나에 행 하나). 연결 하나로 3,000번 넣는 데 걸린 시간으로 초당 `INSERT` 수(처리량)를 잰다.

```sql
CREATE TABLE events (id BIGINT AUTO_INCREMENT PRIMARY KEY, payload VARCHAR(64) NOT NULL);
INSERT INTO events (payload) VALUES ('order paid');  -- 자동 커밋으로 3,000번
```

커밋할 때 DB가 디스크에 내리는 로그와 그 시점을 정하는 설정은 아래와 같다(에이전트가 문서 설명을 줄인 것). fsync는 OS가 메모리에 들고 있는 파일 내용을 디스크에 실제로 쓰게 하고, 끝날 때까지 기다리는 호출이다.

- MySQL redo log(InnoDB가 장애 뒤 커밋한 변경을 다시 적용하는 로그): `innodb_flush_log_at_trx_commit`이 1(기본값)이면 커밋마다 OS에 쓰고 fsync까지 하고, 2면 커밋마다 OS에 쓰기만 하고 fsync는 약 1초마다 한다.
- MySQL binary log(복제와 시점 복구에 쓰는 로그, MySQL 8.4에서 기본으로 켜져 있다): `sync_binlog`가 1(기본값)이면 커밋마다 fsync하고, 0이면 fsync를 OS에 맡긴다.
- PostgreSQL WAL: `synchronous_commit`이 on(기본값)이면 WAL을 디스크에 내린 뒤 커밋 완료를 알리고, off면 내리기 전에 알린다(WAL writer가 조금 뒤에 내린다).

| 조건 | DB | 설정 |
|---|---|---|
| 기본값 | MySQL | `innodb_flush_log_at_trx_commit=1`, `sync_binlog=1` |
| (가) | MySQL | `innodb_flush_log_at_trx_commit=2`, `sync_binlog=1` |
| (나) | MySQL | `innodb_flush_log_at_trx_commit=1`, `sync_binlog=0` |
| (다) | MySQL | `innodb_flush_log_at_trx_commit=2`, `sync_binlog=0` |
| 기본값 | PostgreSQL | `synchronous_commit=on` |
| (라) | PostgreSQL | `synchronous_commit=off` |

물은 것(네 칸): (가)~(라) 각각의 초당 `INSERT` 수가 같은 DB 기본값의 1.5배 이상일지(확연히 늘어남), 1.5배 미만일지. 이유와 틀렸다고 볼 조건. 설정을 바꿀 때 잃는 것(장애가 나면 잃을 수 있는 커밋)은 이번에 재지 않고 피드백에서 문서로 다룬다. 측정은 [`python/durability_lab.py`](python/durability_lab.py)이고 규칙은 [지속성 설정 측정 규칙](#지속성-설정-측정-규칙)에 적었다.

- 사람의 예상과 질문(2026-10-28, 원문): "* (가): 확연히 늘어남. 매 커밋마다 fsync를 호출하다가 1초에 한 번씩만 호출하도록 변경되면서 소요시간이 큰 디스크에 접근하는 작업 횟수가 현저히 줄어들기 때문 * (나): 확연히 늘어남, 매 커밋마다 fsync를 수행하다가 fsync 작업을 OS에 위임했기 때문에 INSERT 자체는 기존보다 더 빨리 끝나게됨 * (다): 현저히 늘어남, (가)와 (나)의 이유가 합쳐짐 * (라): 디스크에 내린다는게 무슨 뜻이야? 표준 용어로 설명해주"
- 에이전트 설명((라) 예상 전): "디스크에 내린다"를 flush로 다시 설명했다. DB 프로세스가 로그를 OS에 넘기는 write(OS는 메모리의 page cache에 두고 바로 돌아오므로 DB 프로세스만 죽으면 남지만 OS가 죽거나 전원이 꺼지면 사라진다)와, 그 내용을 디스크에 실제로 쓰고 끝날 때까지 기다리는 fsync(돌아온 뒤에는 전원이 꺼져도 남는다)로 나누고, 디스크에 내린다는 것은 fsync까지 끝내는 것이라고 했다. PostgreSQL `synchronous_commit=on`은 커밋할 때 그 트랜잭션의 WAL 레코드를 WAL 파일에 write하고 fsync가 끝날 때까지 기다린 뒤 성공을 돌려주고, off는 WAL 레코드가 DB 메모리의 WAL buffer에 들어가면 바로 성공을 돌려주며 write와 fsync는 백그라운드 프로세스 WAL writer가 나중에 한다(기본 200ms마다). (라)를 "커밋이 fsync를 기다리지 않게 하면 초당 INSERT 수가 on일 때의 1.5배 이상이 될까"로 다시 물었다.
- 사람의 예상((라), 2026-10-28, 원문): "라도 확연히 줄어들거라고 생각해. synchronous_commit=on 이면 매 커밋마다 fsync가 끝날때까지 기다리지만 off면 WAL 버퍼에 변경사항이 입력되면 fsync는 기다리지 않으니까."
- 판정에 쓰는 예상: (가)·(나)·(다)는 1.5배 이상. (라)의 "줄어들거라고"는 `INSERT` 한 번의 시간이 줄어 초당 `INSERT` 수가 1.5배 이상이 된다는 뜻으로 읽었다(에이전트 해석. 앞 세 칸과 같은 쪽이라는 "라도"와 이유를 근거로 했고, 피드백에서 이렇게 읽었다고 알렸다). 틀렸다고 볼 조건은 적지 않았다.
- 에이전트 피드백(설명): 컨테이너 임시 확인(본 측정 아님. 10-28, `durability_lab.py` 기본값으로 설정마다 워밍업 1회와 3회) 값이다. 초당 `INSERT` 수를 실행 순서대로 적고, 배수는 세 실행의 중앙값끼리 나눴다. 같은 볼륨에서 8KB 동기 쓰기 한 번은 MySQL 0.58ms, PostgreSQL 0.54ms였다.

  | 조건 | 초당 `INSERT` | 기본값 대비 | 지연 p50(ms) |
  |---|---|---|---|
  | MySQL 기본값(1, 1) | 664, 652, 651 | | 1.40, 1.41, 1.39 |
  | (가) `innodb_flush_log_at_trx_commit=2`, `sync_binlog=1` | 893, 875, 922 | 1.37배 | 1.04, 1.05, 1.00 |
  | (나) `innodb_flush_log_at_trx_commit=1`, `sync_binlog=0` | 810, 870, 817 | 1.25배 | 1.12, 1.06, 1.10 |
  | (다) `innodb_flush_log_at_trx_commit=2`, `sync_binlog=0` | 2207, 2484, 2081 | 3.38배 | 0.40, 0.34, 0.42 |
  | PostgreSQL 기본값(`synchronous_commit=on`) | 1215, 1225, 1236 | | 0.71, 0.73, 0.72 |
  | (라) `synchronous_commit=off` | 4908, 4467, 4083 | 3.65배 | 0.17, 0.16, 0.17 |

  설명한 것은 셋이다. (1) MySQL은 기본값에서 커밋마다 fsync를 두 번 기다린다(redo log 한 번, binary log 한 번). (가)는 redo log 쪽만, (나)는 binary log 쪽만 없애 남은 하나 때문에 여전히 커밋마다 디스크를 기다렸고, 둘 다 없앤 (다)에서야 3배 넘게 빨라졌다. 지연 p50도 fsync 두 번 약 1.4ms, 한 번 1.0~1.1ms, 0번 약 0.4ms였다. 두 fsync를 따로 없앤 몫을 더한 만큼 (다)가 빨라진 것은 아니었고, 그 이유는 재지 않았다. (2) (라)는 이유까지 맞았다. on에서는 커밋마다 WAL의 write와 fsync를 기다리고, off에서는 기다리지 않아 지연 p50이 0.72ms에서 0.17ms로 줄었다. (3) 대신 잃는 것은 문서로 보았다. MySQL 매뉴얼의 변수 항목은 받아 오지 못해 MySQL 8.4.13 소스의 변수 설명을 썼다. `innodb_flush_log_at_trx_commit`은 "Set to 0 (write and flush once per second), 1 (write and flush at each commit), or 2 (write at commit, flush once per second)."이다. 2는 커밋마다 OS까지는 write하므로 mysqld만 죽으면 남고, OS가 죽거나 전원이 꺼지면 마지막 약 1초를 잃을 수 있다(이 설명에서 이어지는 추론). [The Binary Log](https://dev.mysql.com/doc/refman/8.4/en/binary-log.html): "If sync_binlog was not enabled, and the operating system or machine (not only the MySQL server) crashed, there is a chance that the last statements of the binary log could be lost." PostgreSQL [synchronous_commit](https://www.postgresql.org/docs/18/runtime-config-wal.html): "Unlike fsync, setting this parameter to off does not create any risk of database inconsistency: an operating system or database crash might result in some recent allegedly-committed transactions being lost, but the database state will be just the same as if those transactions had been aborted cleanly." "(The maximum delay is three times wal_writer_delay.)" `wal_writer_delay` 기본값 200ms로 최대 600ms이다. WAL이 아직 DB 메모리에 있을 수 있어 MySQL의 2와 달리 DB만 죽어도 잃을 수 있다. [Asynchronous Commit](https://www.postgresql.org/docs/18/wal-async-commit.html)은 "Thus asynchronous commit should not be used if the client will take external actions relying on the assumption that the transaction will be remembered."라고 한다. 결제 이벤트를 남긴 뒤 영수증을 보내는 경우처럼 커밋을 믿고 바깥에 알리는 일이 있으면 맞지 않는다.
- 예상 적중(컨테이너 임시 확인 기준, 판정은 맥 본 측정으로 한다): (다)·(라) 적중, (가)·(나) 빗나감(2/4, 누적 31/63). 묶음 4는 2/4. 예상 단계 전체는 31/63(묶음 1 15/29, 묶음 2 10/21, 묶음 3 4/9, 묶음 4 2/4).
- 현재 확인한 부분: fsync를 기다리지 않으면 커밋이 빨라진다는 것과 PostgreSQL off의 이유는 맞혔다. 문제에서 MySQL이 커밋 때 로그 두 개를 내린다고 했지만, 커밋마다 fsync가 두 번이라 하나만 없애면 하나가 남는다는 것을 (가)·(나)에 적용하지 못했다. "디스크에 내린다"(flush)를 write와 fsync로 나누는 설명은 (라) 예상 전에 들었다.

## 순서표 실행 규칙

묶음 1·3의 순서표는 아래 규칙으로 실행한다. 두 DB에 같은 규칙을 쓴다. 묶음 3은 MyISAM이 MySQL에만 있어 MySQL에서만 돌린다.

| 항목 | 규칙 |
|---|---|
| 순서표 | [`python/isolation_timelines.py`](python/isolation_timelines.py)에 단계(세션, SQL)를 적힌 순서대로 둔다. 실행마다 준비 SQL로 표를 새로 만든다. |
| 세션 | 세션마다 연결 하나와 스레드 하나를 쓴다. 연결은 자동 커밋으로 열고, 트랜잭션은 순서표의 `START TRANSACTION`과 `COMMIT`으로 열고 닫는다. 격리 수준은 조건마다 두 세션에 같게 건다(MySQL은 `SET SESSION TRANSACTION ISOLATION LEVEL`, PostgreSQL은 `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL`). |
| 기다림 | 단계를 넣고 0.5초 안에 끝나지 않으면 기다림으로 기록하고 다음 단계로 넘어간다. 단계를 넣을 때마다 0.3초 동안 기다리던 단계가 끝나는지 보고, 끝났으면 그 단계 뒤에 끝난 것으로 남긴다. |
| 미룸 | 기다리는 세션의 다음 단계는 미뤄 두었다가 그 세션의 앞 단계가 끝나면 바로 넣는다. 그동안 다른 세션의 단계는 순서대로 계속 넣는다. 실제 요청 두 개가 서로를 기다려 주지 않고 따로 도는 것과 같게 하려는 규칙이다(2026-10-27 바꿈. 전에는 그 세션이 풀릴 때까지 순서표 전체를 멈춰, 상대 세션의 `COMMIT`이 뒤에 있으면 락 대기 초과로만 끝났다). |
| 락 대기 | 두 DB 모두 락을 5초까지 기다리게 한다(MySQL `innodb_lock_wait_timeout`, PostgreSQL `lock_timeout`). 기본값(MySQL 50초, PostgreSQL 제한 없음)에서 줄였고, 그 뒤에 나는 오류도 관찰값으로 남긴다. 15초가 지나도 끝나지 않으면 서버에서 취소하고 실행 오류로 본다. |
| 반복 | 조건(순서표·DB·격리 수준)마다 워밍업 1회(`run: 0`)와 본 측정 3회를 하고, 반복할 때 조건 순서를 뒤집는다. 실행이 끝나면 남은 트랜잭션을 `ROLLBACK`하고 연결을 닫는다. |

## 열어 둔 트랜잭션 측정 규칙

묶음 2(문제 상황 4)는 아래 규칙으로 잰다. 두 DB에 같은 규칙을 쓰고, 쌓인 것을 읽는 방법만 DB마다 다르다.

| 항목 | 규칙 |
|---|---|
| 경우 | A가 B보다 먼저 실행하고 커밋하지 않은 채 두는 문장으로 나눈다. 문제 상황 4의 (가)~(마)와 변형 (바)이며 [`python/history_lab.py`](python/history_lab.py)의 `HOLDS`에 있다. 실행마다 표(`accounts`, `visits`)를 새로 만든다. |
| 연결 | 관찰용 연결, A, B, 새 세션(마지막 값을 읽는 쪽)에 연결을 하나씩 쓴다. 모두 자동 커밋으로 열고, A에만 경우에 맞는 격리 수준을 건다. |
| 고치기 | B가 `UPDATE accounts SET balance = balance + 1 WHERE id = 1`을 1만 번 실행한다. 자동 커밋이라 한 번이 트랜잭션 하나다. 다섯 구간으로 나눠 구간마다 한 번 고치는 데 든 평균 시간을 남긴다. |
| 쌓인 것 | MySQL은 B가 끝난 직후 History list length를 읽는다. 서버 전체의 값이라 실행을 시작하기 전에 1000 이하로 줄 때까지 최대 60초 기다린다. PostgreSQL은 이 표의 자동 VACUUM을 끄고(`autovacuum_enabled = false`), B가 끝난 직후 표 크기(`pg_relation_size`)를 읽고, 두 세션의 읽기가 끝난 뒤 `VACUUM (VERBOSE)`를 돌려 지운 수와 아직 지울 수 없던 수를 읽는다. |
| 읽기 | B가 끝난 뒤 A와 새 세션이 같은 행을 7번씩 읽어, 읽은 값과 읽기 시간의 중앙값을 남긴다. |
| 끝난 뒤 | A가 `COMMIT`한 뒤 MySQL은 1·3·10초 뒤의 History list length를, PostgreSQL은 한 번 더 돌린 `VACUUM (VERBOSE)`의 보고와 표 크기를 남긴다. (가)는 `COMMIT`할 것이 없어 같은 때에 읽는다. |
| 제대로 돈 실행 | B의 `UPDATE`가 매번 한 행을 고쳤고 새 세션이 1000 + 1만을 읽었으면 제대로 돈 실행으로 본다. 아니면 실행 오류로 멈춘다. |
| 반복 | 조건(DB·경우)마다 워밍업 1회(`run: 0`)와 본 측정 3회를 하고, 반복할 때 조건 순서를 뒤집는다. 실행이 끝나면 연결을 닫아 열린 트랜잭션을 되돌린다. |

## 지속성 설정 측정 규칙

묶음 4(문제 상황 6)는 아래 규칙으로 잰다.

| 항목 | 규칙 |
|---|---|
| 설정 | MySQL은 `innodb_flush_log_at_trx_commit`(1, 2)과 `sync_binlog`(1, 0)의 네 조합, PostgreSQL은 `synchronous_commit`(on, off) 둘이다. [`python/durability_lab.py`](python/durability_lab.py)의 `SETTINGS`에 있다. MySQL은 커밋 때 로그 두 개를 내리므로 두 설정을 함께 나눴다(2026-10-28 에이전트가 정함). |
| 설정 걸기 | MySQL의 두 설정은 서버 전체(`SET GLOBAL`)에만 걸 수 있어 재는 동안 바꾸고, 끝나거나 중간에 실패해도 처음 값으로 되돌린다. 그래서 다른 측정과 동시에 돌리지 않는다. PostgreSQL은 재는 연결에만 건다(`SET synchronous_commit`). 재기 전에 실제로 걸린 값을 읽어 남긴다. |
| 넣기 | 실행마다 `events` 표를 새로 만들고, 연결 하나에서 자동 커밋 `INSERT`를 200번 먼저 넣어 버린 뒤 3,000번을 잰다. `INSERT` 한 번이 트랜잭션 하나다. |
| 남기는 값 | 3,000번에 걸린 시간으로 초당 `INSERT` 수를, `INSERT`마다 걸린 시간으로 지연 p50·p90·p99·최댓값·평균을 남긴다. 백분위는 가장 가까운 순위 방식으로 잰 값 하나를 고른다. |
| 디스크 기준 | 실행을 시작하기 전에 DB마다 데이터와 같은 볼륨에 `dd`로 8KB 동기 쓰기(`oflag=dsync`)를 500번 해, 한 번에 걸린 시간을 남긴다. 커밋이 디스크를 기다리는 시간을 가늠하는 기준이다. |
| 해석 범위 | Docker Desktop의 디스크는 리눅스 VM 안의 가상 디스크라 fsync 비용이 실제 서버와 다를 수 있다. 숫자는 이 맥에서의 값으로만 말하고, 디스크 기준과 함께 본다. |
| 제대로 돈 실행 | 바라던 설정이 실제로 걸렸고 표의 행 수가 넣은 수와 같으면 제대로 돈 실행으로 본다. 아니면 실행 오류로 멈춘다. |
| 반복 | 조건(설정)마다 워밍업 1회(`run: 0`)와 본 측정 3회를 하고, 반복할 때 조건 순서를 뒤집는다. |

## 동기 쓰기 비교 측정 규칙

결과를 해석하던 중(2026-10-28)에 더한 측정이다. 묶음 4의 맥 결과를 설명하는 추론(binary log는 커밋마다 파일이 커지고 redo log·WAL은 미리 만든 파일을 덮어써서, 같은 `fdatasync`라도 비용이 다르다)을 확인한다. 사람이 다음 단계로 고르고(원문: "1번 측정하고 넘어가자") 에이전트가 규칙을 정했다.

| 항목 | 규칙 |
|---|---|
| 방식 | 이어 쓰기(`append`)는 새 파일 끝에 `dd`로 8KB씩 500번 쓰고, 쓸 때마다 동기화한다(`oflag=dsync`). 파일 크기가 계속 커지며, 묶음 4의 디스크 기준과 같은 방식이다. 덮어쓰기(`overwrite`)는 같은 크기(4,096,000바이트)의 파일을 먼저 만들어 디스크에 내린 뒤(`conv=fsync`), 그 자리를 처음부터 같은 방식으로 덮어쓴다(`conv=notrunc`). 파일 크기는 그대로다. |
| 위치 | DB 컨테이너마다 데이터 디렉터리 안에서 쓰고(`docker compose exec`), 다 쓴 파일은 지운다. 데이터 디렉터리가 있는 파일시스템은 `df -T`로 환경 파일에 남긴다. |
| 남기는 값 | `dd`가 보고한 시간을 쓴 횟수로 나눈 한 번 시간(ms)과 명령 전체의 벽시계 시간이다. 파일을 미리 만드는 준비 명령은 시간에 넣지 않는다. |
| 제대로 돈 실행 | 준비와 재는 명령이 모두 성공하고 `dd`가 보고한 바이트 수가 500 × 8,192바이트이면 제대로 돈 실행으로 본다. 아니면 실행 오류로 멈춘다. |
| 반복 | (DB, 방식) 네 조건마다 워밍업 1회(`run: 0`)와 본 측정 3회를 하고, 반복할 때 조건 순서를 뒤집는다. |
| 해석 범위 | 디스크는 Docker Desktop VM의 가상 디스크다. 한 번 시간은 500번의 평균이라, 파일이 커지는 동안 한 번 시간이 어떻게 변하는지는 볼 수 없다. |

## 실행 방법

DB는 저장소 루트의 [`infra/compose.yaml`](../../infra/compose.yaml)로 띄운다. MySQL은 `127.0.0.1:13306`, PostgreSQL은 `127.0.0.1:15432`에서 받는다.

```sh
docker compose -f infra/compose.yaml up -d --wait   # 저장소 루트에서 띄우기
docker compose -f infra/compose.yaml down -v        # 끄고 데이터 지우기
```

| 파일 | 역할 |
|---|---|
| [isolation_timelines.py](python/isolation_timelines.py) | 묶음 1·3의 순서표(문제 상황 1·1-1·1-2와 변형·1-3·2·3·5·5-1, 에이전트 작성) |
| [isolation_lab.py](python/isolation_lab.py) | 두 세션 실행, 값·기다림·오류 기록, 반복, 환경·원자료 저장과 요약 |
| [test_isolation_lab.py](python/test_isolation_lab.py) | 가짜 DB로 값·기다림·미룸·오류·취소가 기록되는지 검사. 순서표가 두 세션과 돌릴 수 있는 DB로 짜였는지도 본다 |
| [history_lab.py](python/history_lab.py) | 묶음 2의 경우(문제 상황 4와 변형, 에이전트 작성)와 측정. 열어 두기, 고치기, 쌓인 것·읽기·끝난 뒤 기록, 반복, 환경·원자료 저장과 요약. DB 연결은 `isolation_lab.py`의 것을 쓴다 |
| [test_history_lab.py](python/test_history_lab.py) | 가짜 DB로 두 DB의 보고 읽기와 열기·고치기·읽기·VACUUM·`COMMIT` 순서를 검사 |
| [durability_lab.py](python/durability_lab.py) | 묶음 4의 설정(문제 상황 6, 에이전트 작성)과 측정. 설정 걸기·되돌리기, 자동 커밋 `INSERT`, 동기 쓰기 기준, 반복, 환경·원자료 저장과 요약. DB 연결은 `isolation_lab.py`의 것을 쓴다 |
| [test_durability_lab.py](python/test_durability_lab.py) | 가짜 DB로 설정 걸기·되돌리기, 설정이 걸리지 않은 실행 거르기, 지연 백분위와 `dd` 보고 읽기를 검사 |
| [sync_write_lab.py](python/sync_write_lab.py) | 해석 중에 더한 동기 쓰기 비교(이어 쓰기, 덮어쓰기)와 측정. 준비·재기 명령, `dd` 보고 읽기, 반복, 환경·원자료 저장과 요약. `dd` 시간 읽기와 데이터 디렉터리 찾기는 `durability_lab.py`의 것을 쓴다 |
| [test_sync_write_lab.py](python/test_sync_write_lab.py) | DB 없이 두 방식의 명령(새 파일에 쓰기, 미리 만든 파일 덮어쓰기, 같은 양 쓰기)과 `dd`가 쓴 바이트 수 읽기를 검사 |
| [lab_env.py](../../tools/lab_env.py) | 측정 환경 기록. 01·02의 같은 코드를 세 번째로 쓰게 되어 `tools/`로 옮겼고, 끝난 01·02 코드는 그대로 둔다 |

이 실험 폴더에서 실행한다.

```sh
cd experiments/03-mysql-isolation-mvcc
uv run --python 3.14.2+gil python -m unittest discover -s python -p 'test_*.py' -v
uv run --python 3.14.2+gil python/isolation_lab.py --smoke
uv run --python 3.14.2+gil python/isolation_lab.py
uv run --python 3.14.2+gil python/history_lab.py --smoke
uv run --python 3.14.2+gil python/history_lab.py
uv run --python 3.14.2+gil python/durability_lab.py --smoke
uv run --python 3.14.2+gil python/durability_lab.py
uv run --python 3.14.2+gil python/sync_write_lab.py --smoke
uv run --python 3.14.2+gil python/sync_write_lab.py
```

`--smoke`는 조건마다 워밍업 1회와 검증 2회만 돌려 `results/validation/`에 저장하며, 가설 판단에 쓰지 않는다. `history_lab.py --smoke`는 고치는 횟수도 200번으로, `durability_lab.py --smoke`는 `INSERT`를 100번으로, `sync_write_lab.py --smoke`는 동기 쓰기를 50번으로 줄인다. `--timelines`(묶음 1·3), `--holds`(묶음 2), `--settings`(묶음 4), `--dbs`로 조건을 줄일 수 있다. 의존성(PyMySQL 1.2.3, psycopg 3.3.6)은 스크립트 머리의 PEP 723 블록과 [`isolation_lab.py.lock`](python/isolation_lab.py.lock), [`history_lab.py.lock`](python/history_lab.py.lock), [`durability_lab.py.lock`](python/durability_lab.py.lock), [`sync_write_lab.py.lock`](python/sync_write_lab.py.lock)에 고정했다.

`3.14.2+gil`은 GIL이 있는 일반 빌드를 고르라는 uv 요청이다. `3.14.2`만 주면 uv는 free-threaded(GIL 없는) 빌드도 고를 수 있는데, 맥에는 uv가 관리하는 3.14.2가 free-threaded 빌드뿐이라 그것이 골라졌다. psycopg-binary 3.3.6에는 free-threaded용 wheel이 없어 2026-10-28 맥의 첫 작은 입력 검증이 의존성 설치에서 멈췄고, 그래서 일반 빌드로 고정했다. 실행한 빌드는 env 파일의 `gil_enabled`, `free_threaded_build`에 남는다.

결과는 순서표를 한 번 돌린 것을 JSON 한 줄로 남긴다. 공통 필드에 더해 `timeline`, `db`, `db_version`, `isolation`, `steps`를 쓴다. `check`는 끝난 단계 수, `expected_check`는 단계 수다. 환경 파일에는 공통 항목에 더해 DB 버전과 주요 설정(`databases`), 띄운 이미지(`docker_images`)를 남긴다. `steps`의 원소는 다음과 같다.

| 필드 | 뜻 |
|---|---|
| `step`, `session`, `sql`, `note` | 순서, 세션, 실행한 SQL, 순서표의 메모 |
| `blocked` | 0.5초 안에 끝나지 않았으면 `true` |
| `deferred` | 세션이 앞 단계를 기다리고 있어 미뤘으면 `true` |
| `sent_after_step`, `sent_at_s` | 실제로 보낸 때의 마지막 단계 번호와, 실행 시작부터 보낼 때까지의 시간(초). 미루지 않은 단계는 자기 번호다. 미룬 단계끼리의 실제 순서는 `sent_at_s`로 본다 |
| `finished_after_step` | 끝난 것을 확인한 때의 마지막 단계 번호. 기다리지 않은 단계는 보낸 때와 같다 |
| `outcome` | `ok`, `error`(DB가 오류로 돌려줌, 관찰값), `stuck`(취소함, 실행 오류), `not_sent`(멈춘 세션에 미뤄 둔 단계라 보내지 않음) |
| `rows`, `rowcount` | 돌려받은 행과 영향받은 행 수 |
| `status`, `notices` | PostgreSQL이 돌려준 명령 태그와 알림. MySQL은 `null` |
| `error` | 오류 종류, 번호(MySQL은 오류 번호, PostgreSQL은 SQLSTATE), SQLSTATE, 메시지 |
| `elapsed_s` | 단계를 넣고 끝날 때까지 걸린 시간(초) |

묶음 2 결과는 실행 한 번(DB·경우 하나)을 JSON 한 줄로 남긴다. 공통 필드에 더해 아래를 쓴다. `check`는 한 행을 고친 `UPDATE` 수, `expected_check`는 고치는 횟수다. 환경 파일의 `databases`에는 정리 관련 설정(MySQL의 purge 스레드 수 등, PostgreSQL의 `autovacuum` 등)도 남긴다.

| 필드 | 뜻 |
|---|---|
| `db`, `db_version`, `hold`, `isolation` | DB, 경우(`none`, `rr-read`, `rc-read`, `rr-begin`, `rr-update`, `rr-read-other`가 (가)~(바)), A의 격리 수준(`null`이면 DB 기본값) |
| `hold_steps` | A가 실행하고 그대로 둔 문장과 돌려받은 행·시간 |
| `before` | 시작 전 값. MySQL은 History list length와 줄기를 기다린 시간, PostgreSQL은 표 크기(바이트) |
| `updates` | 고치는 횟수, 한 행을 고친 수, 걸린 시간(초), 구간별 한 번 고치는 데 든 평균 시간(ms) |
| `after_updates` | 고친 직후 값. MySQL은 History list length, PostgreSQL은 표 크기와 VACUUM 보고(지운 수 `removed`, 남은 수 `remain`, 아직 지울 수 없던 수 `dead_not_removable`, 지울 수 있는 경계가 몇 XID 전인지 `cutoff_age_xids`) |
| `reads` | A(`holder`)와 새 세션(`fresh`)이 읽은 값, 읽기 시간 중앙값과 표본(ms) |
| `after_close` | A가 끝난 뒤 값. MySQL은 1·3·10초 뒤 History list length, PostgreSQL은 VACUUM 보고와 표 크기 |

묶음 4 결과는 실행 한 번(설정 하나)을 JSON 한 줄로 남긴다. 공통 필드에 더해 아래를 쓴다. `check`는 잰 `INSERT` 수(표의 행 수에서 먼저 넣은 수를 뺀 값), `expected_check`는 재려던 수다. 환경 파일에는 DB 데이터 디렉터리(`data_directories`)와 동기 쓰기 기준(`sync_write_probe`, `dd` 출력 원문 포함)도 남긴다.

| 필드 | 뜻 |
|---|---|
| `db`, `db_version`, `setting` | DB, 설정 이름(`flush1-binlog1`, `flush2-binlog1`, `flush1-binlog0`, `flush2-binlog0`, `sync-on`, `sync-off`) |
| `values`, `applied` | 걸려던 설정 값과 실제로 걸린 값(MySQL은 `@@global`, PostgreSQL은 `SHOW`) |
| `warmup`, `total_s`, `inserts_per_s` | 먼저 넣고 버린 수, 잰 `INSERT`에 걸린 시간(초), 초당 `INSERT` 수 |
| `latency_ms` | `INSERT` 한 번의 지연 p50·p90·p99·최댓값·평균(ms) |

동기 쓰기 비교 결과는 실행 한 번(DB·방식 하나)을 JSON 한 줄로 남긴다. 공통 필드에 더해 아래를 쓴다. `check`는 `dd`가 보고한 바이트 수, `expected_check`는 쓰려던 바이트 수다. 환경 파일에는 데이터 디렉터리(`data_directories`)와 그 파일시스템(`filesystems`, `df -T` 출력)도 남긴다.

| 필드 | 뜻 |
|---|---|
| `db`, `db_version`, `mode` | DB(데이터 디렉터리를 쓴 컨테이너), 방식(`append`, `overwrite`) |
| `prepare`, `raw` | 준비 명령과 재는 명령의 결과(종료 코드, 출력 원문) |
| `dd_s`, `ms_per_write`, `wall_s` | `dd`가 보고한 시간(초), 한 번 시간(ms), 명령 전체의 벽시계 시간(초) |

2026-10-27 준비 상태: 자동 검사 15개(묶음 1 7개, 묶음 2 8개)가 uv의 CPython 3.14.2(Linux x86_64 컨테이너)에서 통과했다. 같은 컨테이너에서 같은 버전의 MySQL·PostgreSQL 이미지(linux/amd64)를 띄워 두 스크립트의 `--smoke` 실행·저장 경로와, 두 DB에서 기다림·미룸과 락 대기 시간 초과가 기록되는 것, 묶음 2의 쌓인 것·읽기·끝난 뒤 값이 기록되는 것을 확인했다. 그 원자료는 저장소 밖에서 만든 것이라 보존하지 않고 가설 판단에 쓰지 않는다. 맥에서의 작은 입력 검증은 본 측정 직전에 한다.

2026-10-28에 묶음 3의 순서표 `order-rollback`(문제 상황 5)과 `stock-read-myisam`·`stock-read-innodb`(문제 상황 5-1)를 더했다. 자동 검사 16개(묶음 1·3 8개, 묶음 2 8개)가 같은 환경에서 통과했고, 같은 컨테이너에서 세 순서표의 `--dbs mysql --smoke` 실행·저장 경로를 확인했다. 같은 날 묶음 4의 `durability_lab.py`와 검사를 더해 자동 검사 22개(묶음 1·3 8개, 묶음 2 8개, 묶음 4 6개)가 통과했고, 같은 컨테이너에서 `durability_lab.py --smoke`의 실행·저장 경로와 끝난 뒤 MySQL 설정이 처음 값(1, 1)으로 돌아오는 것을 확인했다. 이 원자료도 보존하지 않고 가설 판단에 쓰지 않는다. 결과를 해석하던 중에 `sync_write_lab.py`와 검사 6개를 더해 자동 검사 28개가 같은 환경에서 통과했고, 같은 컨테이너에서 `--smoke`와 기본 실행의 실행·저장 경로를 확인했다. 그 값은 피드백에서 컨테이너 임시 확인 값으로만 보였고 원자료는 보존하지 않는다.

## 결과 정리

### 측정 환경과 원자료 (2026-10-28)

Apple M2 Pro(성능 코어 8개·효율 코어 4개), macOS 26.5의 Docker Desktop에 MySQL 8.4.13과 PostgreSQL 18.6을 띄우고(이미지 `linux/arm64/v8`, `docker compose images`의 ID `a0225d1ea663`, `979bccfde354`), 2026-10-28 21:57~22:16(KST)에 세 실행 파일을 [실행 방법](#실행-방법)의 순서대로 하나씩 돌렸다. Python은 uv가 고른 Homebrew의 CPython 3.14.2 일반 빌드(GIL 켜짐)다. 사람이 예상을 마치고 다음 단계로 넘어가자고 해(원문: "넘어가자") 에이전트가 맥에 연 원격 Claude Code 세션이 실행했고, 측정하는 동안 그 세션이 함께 떠 있었다. 전원은 연결된 상태였고 배터리는 여섯 환경 파일 모두 80%(충전 안 함)였다. 1분 load average는 세 본 실행의 시작 직전 5.37·4.44·4.59, 끝난 뒤 6.46이었다(원격 세션이 `uptime`으로 읽은 값이며 환경 파일에는 없다). 코드는 커밋 `5a24c46` 위의 커밋하지 않은 상태였고, 환경 파일에 남은 소스 sha256은 이 README와 함께 커밋한 코드와 같다. 시작 직전에 자동 검사 22개가 통과했고 `--smoke` 셋이 실행 오류 없이 끝났다(`results/validation/`의 `2026-10-28T2157…`·`2158…`·`2201…` 파일). 그보다 앞선 첫 `--smoke`는 uv가 free-threaded 빌드를 골라 의존성 설치에서 멈췄고 파일을 만들지 않았다([실행 방법](#실행-방법)). 본 실행의 기록은 모두 검증(`valid`)을 통과했고 실행 오류는 없었다. `durability_lab.py`가 끝난 뒤 MySQL의 두 설정은 처음 값(1, 1)으로 돌아와 있었다. 아래 값은 모두 워밍업을 뺀 세 번이다.

| 실행 파일 | 묶음 | 조건 × 반복 | 환경 | 원자료 |
|---|---|---|---|---|
| `isolation_lab.py` | 1·3 | 41 × (워밍업 1 + 3) | [환경](results/2026-10-28T220156065912-isolation-env.txt) | [JSONL](results/2026-10-28T220156065912-isolation-python-3.14.2.jsonl) |
| `history_lab.py` | 2 | 12 × (1 + 3) | [환경](results/2026-10-28T220300298631-history-env.txt) | [JSONL](results/2026-10-28T220300298631-history-python-3.14.2.jsonl) |
| `durability_lab.py` | 4 | 6 × (1 + 3) | [환경](results/2026-10-28T221519136661-durability-env.txt) | [JSONL](results/2026-10-28T221519136661-durability-python-3.14.2.jsonl) |
| `sync_write_lab.py` | 해석 중 더함 | 4 × (1 + 3) | [환경](results/2026-10-28T225717392478-sync-write-env.txt) | [JSONL](results/2026-10-28T225717392478-sync-write-python-3.14.2.jsonl) |

판정은 시작 전 기록에 적은 예상과 판정 기준대로 했다. 문제 상황마다 컨테이너 임시 확인 값으로 센 판정과 비교하면, 묶음 1~3은 칸마다 같고 묶음 4는 맞힌 칸이 (다)·(라)에서 (나)·(다)로 바뀌었다(수는 같다).

| 묶음 | 문제 상황 | 적중 | 빗나감 | 판정에서 뺀 칸 |
|---|---|---:|---:|---|
| 1 | 1-1, 1-2, 1-2 변형, 2, 1-3, 3 | 15 | 14 | 문제 상황 2의 PostgreSQL(모르겠다고 답함) |
| 2 | 4, 4 변형 (바), 4-1, 4-2, 4-3 | 10 | 11 | 4-3의 (1)(어림으로만 받음), (2)(모르겠다고 답함) |
| 3 | 5, 5-1 | 4 | 5 | |
| 4 | 6 | 2 | 2 | |
| 합계 | | 31 | 32 | |

### 묶음 1·3: 순서표 (조건마다 3회)

41개 조건(순서표·DB·격리 수준)이 모두 워밍업을 포함한 네 번에서 단계마다 같은 행·기다림·오류를 돌려줬다. 값은 문제 상황마다 피드백에 적은 컨테이너 임시 확인 값과 모두 같았다. 기다린 시간은 세 번의 최솟값~최댓값이다.

| 문제 상황 | 칸 | 예상 | 측정 | 판단 |
|---|---|---|---|---|
| 1-1 | REPEATABLE READ 3번(전체 개수) | 4 | 3(MySQL, PostgreSQL 모두) | 빗나감 |
| 1-1 | 문제 상황 1을 READ COMMITTED로 돌린 1·3·4번 | 2, 3, 3 | 2, 3, 3 | 적중 |
| 1-2 | MySQL REPEATABLE READ 3번 | 2 | 3 | 빗나감 |
| 1-2 | PostgreSQL REPEATABLE READ 3번 | 2 | 3 | 빗나감 |
| 1-2 변형 | MySQL REPEATABLE READ 3번 | 3 | 3 | 적중 |
| 1-2 변형 | PostgreSQL REPEATABLE READ 3번 | 3 | 2 | 빗나감 |
| 2 | MySQL READ UNCOMMITTED (나)·(다) | 700, 700 | 700, 700 | 적중 |
| 2 | MySQL READ COMMITTED (나)·(다) | 1000, 700 | 1000, 700 | 적중 |
| 2 | MySQL REPEATABLE READ (나)·(다) | 1000, 1000 | 1000, 1000 | 적중 |
| 2 | MySQL SERIALIZABLE (나)·(다) | 1000, 1000 | 1000, 1000 | 적중 |
| 2 | MySQL SERIALIZABLE 기다림 | B의 2번이 6번(A의 `COMMIT`)까지 기다림 | B의 `UPDATE`가 A의 `COMMIT`까지 1.74초 기다렸고, B의 `COMMIT`은 그 뒤에 나감 | 적중 |
| 2 | PostgreSQL 네 단계 | 모르겠다고 답함 | READ UNCOMMITTED·READ COMMITTED 1000, 700, REPEATABLE READ·SERIALIZABLE 1000, 1000, 기다림 없음 | 뺌 |
| 1-3 | MySQL REPEATABLE READ 3번·4번 | 1,2,4 · 1,2 | 1,2,4 · 1,2 | 적중 |
| 1-3 | PostgreSQL REPEATABLE READ 3번·4번 | 1,2 · 1,2 | 1,2 · 1,2 | 적중 |
| 1-3 | MySQL SERIALIZABLE 3번·4번 | 1,2 · 1,2 | 1,2 · 1,2 | 적중 |
| 1-3 | PostgreSQL SERIALIZABLE 3번·4번 | 1,2 · 1,2 | 1,2 · 1,2 | 적중 |
| 1-3 | MySQL SERIALIZABLE 기다림 | B의 2번이 5번까지 기다림 | B의 `INSERT`가 A의 `COMMIT`까지 1.74~1.75초 기다림 | 적중 |
| 1-3 | PostgreSQL SERIALIZABLE 기다림 | B의 2번이 5번까지 기다림 | 기다림 없음, 오류 없음 | 빗나감 |
| 3 | READ COMMITTED 기다림·오류, MySQL / PostgreSQL | 없음 / 없음 | 두 DB 모두 B의 4번이 A의 `COMMIT`까지 0.81~0.82초 기다린 뒤 고침 | 빗나감, 빗나감 |
| 3 | READ COMMITTED 최종 잔액 | 500 / 500 | 500 / 500 | 적중, 적중 |
| 3 | REPEATABLE READ 기다림·오류 | 없음 / 없음 | MySQL은 READ COMMITTED와 같음, PostgreSQL은 B의 4번이 0.81~0.82초 기다린 뒤 오류 40001 | 빗나감, 빗나감 |
| 3 | REPEATABLE READ 최종 잔액 | 500 / 500 | 500 / 700 | 적중, 빗나감 |
| 3 | SERIALIZABLE 기다림·오류 | 2번이 5번까지 기다림 / 7번에서 오류 | MySQL은 A의 3번이 기다리는 중 B의 4번에서 오류 1213(데드락)이 나고 A의 3번이 끝남(0.82초), PostgreSQL은 B의 4번이 0.81~0.82초 기다린 뒤 오류 40001 | 빗나감, 빗나감 |
| 3 | SERIALIZABLE 최종 잔액 | 200 / 오류로 조회 불가 | 700 / 700 | 빗나감, 빗나감 |
| 5 | (가) `orders`, `order_logs` | 0, 0 | 0, 1 | 적중, 빗나감 |
| 5 | (나) `ROLLBACK` | 정상 | 오류 없이 끝나고 바로 뒤 `SHOW WARNINGS`에 경고 1196 "Some non-transactional changed tables couldn't be rolled back" | 빗나감 |
| 5 | (다) `orders`, `order_logs` | 0, 0 | 0, 1 | 적중, 빗나감 |
| 5-1 | MyISAM (가) B의 `UPDATE` | 바로 끝남 | A의 `SELECT`가 끝날 때까지 1.20~1.21초 기다림 | 빗나감 |
| 5-1 | InnoDB (가) B의 `UPDATE` | 바로 끝남 | 0.005~0.007초 | 적중 |
| 5-1 | MyISAM (나) A가 읽은 id 2의 `qty` | 9 | 10 | 빗나감 |
| 5-1 | InnoDB (나) A가 읽은 id 2의 `qty` | 10 | 10 | 적중 |

예상을 받지 않은 칸: 1-2의 READ COMMITTED는 두 DB 모두 3, `entries-late-snapshot`(MySQL)은 REPEATABLE READ 2·READ COMMITTED 3, 1-2 변형의 READ COMMITTED는 두 DB 모두 3, 1-3의 READ COMMITTED는 두 DB 모두 3번·4번이 1,2,4 · 1,2,4였다. 문제 상황 3의 READ UNCOMMITTED는 두 DB 모두 READ COMMITTED와 같았다. 5-1에서 A의 `SELECT`는 두 엔진 모두 2.01~2.02초 걸렸고, B의 `UPDATE`는 A가 시작하고 0.83~0.86초 뒤에 나갔다.

### 묶음 2: 열어 둔 트랜잭션 (경우마다 3회)

B의 `UPDATE` 1만 번은 모든 실행에서 기다림 없이 매번 한 행을 고쳤고, 새 세션(C)은 모두 11000을 읽었다. 칸마다 세 번의 값을 실행 순서대로 적는다.

| 경우 | MySQL History list length (B가 끝난 직후) | PostgreSQL dead but not yet removable | 예상 (MySQL / PostgreSQL) | 판단 |
|---|---|---|---|---|
| (가) 트랜잭션 없음 | 271, 276, 304 | 0, 0, 0 | 훨씬 작음 / 훨씬 작음 | 적중, 적중 |
| (나) REPEATABLE READ, 읽고 둠 | 10002, 10002, 10002 | 10000, 10000, 10000 | 1만 근처 / 1만 근처 | 적중, 적중 |
| (다) READ COMMITTED, 읽고 둠 | 92, 59, 259 | 0, 0, 0 | 1만 근처 / 1만 근처 | 빗나감, 빗나감 |
| (라) REPEATABLE READ, 열기만 | 64, 80, 301 | 0, 0, 0 | 훨씬 작음 / 훨씬 작음 | 적중, 적중 |
| (마) REPEATABLE READ, 다른 표 `UPDATE` | 39, 119, 310 | 10000, 10000, 10000 | 훨씬 작음 / 훨씬 작음 | 적중, 빗나감 |
| (바) REPEATABLE READ, 다른 표 `SELECT` | 10002, 10002, 10002 | 10000, 10000, 10000 | 훨씬 작음 / 훨씬 작음 | 빗나감, 빗나감 |
| (바) B가 끝난 뒤 A가 처음 읽은 `balance` | 1000, 1000, 1000 | 1000, 1000, 1000 | 11000 / 11000 | 빗나감, 빗나감 |

PostgreSQL 표 크기는 (나)(마)(바)에서 B가 끝난 직후 368,640바이트(시작은 8,192바이트)였고, 나머지 경우는 8,192바이트 그대로였다.

문제 상황 4-1: 읽기 시간. 칸마다 세 실행의 읽기 중앙값(ms)이고, 배수는 (나)와 (가)의 세 값 중 가운데 값끼리 나눴다. 3배 이상이면 확연히 느림이다.

| | MySQL (가) | MySQL (나) | 배수 | PostgreSQL (가) | PostgreSQL (나) | 배수 | 예상 (MySQL / PostgreSQL) | 판단 |
|---|---|---|---|---|---|---|---|---|
| A | 0.28, 0.31, 0.31 | 2.91, 2.90, 2.92 | 9.3배 | 0.35, 0.37, 0.28 | 0.55, 0.47, 0.41 | 1.33배 | 비슷함 / 확연히 느림 | 빗나감, 빗나감 |
| C | 0.30, 0.22, 0.35 | 0.26, 0.27, 0.28 | 0.89배 | 0.28, 0.36, 0.30 | 0.46, 0.48, 0.62 | 1.62배 | 비슷함 / 비슷함 | 적중, 적중 |

문제 상황 4-2: B가 한 번 고치는 시간. 구간 1과 구간 5의 `UPDATE` 한 번 평균(ms)과 그 배수를 실행 순서대로 적는다. 1.2배 이상이면 늘어남이다.

| | 구간 1 → 구간 5 (ms) | 구간 5 / 구간 1 | 예상 | 판단 |
|---|---|---|---|---|
| MySQL (가) | 1.06 → 1.09, 1.07 → 1.13, 1.14 → 1.10 | 1.03, 1.06, 0.97배 | | |
| MySQL (나) | 1.14 → 1.18, 1.11 → 1.21, 1.06 → 1.10 | 1.03, 1.09, 1.04배(평평함) | 평평함 | 적중 |
| PostgreSQL (가) | 0.40 → 0.39, 0.42 → 0.43, 0.40 → 0.43 | 0.97, 1.02, 1.09배 | | |
| PostgreSQL (나) | 0.39 → 0.54, 0.45 → 0.51, 0.39 → 0.52 | 1.36, 1.13, 1.34배(세 번 중 두 번 늘어남, 가운데 값 1.34배) | 평평함 | 빗나감 |

문제 상황 4-3: (나)에서 A가 `COMMIT`한 뒤.

| 칸 | 측정 | 예상 | 판단 |
|---|---|---|---|
| (1) MySQL History list length(`COMMIT` 직전 10002) | 1초 뒤 2203, 7603, 6103. 3초 뒤 2203, 0, 0. 10초 뒤 2204, 1, 1 | 어림으로만 받음(모르겠다고 답함) | 판정 안 함 |
| (2) PostgreSQL `COMMIT` 뒤 VACUUM이 지운 dead tuple 수 | 10000, 10000, 10000(dead but not yet removable 0) | 모르겠다고 답함 | 뺌 |
| (3) PostgreSQL VACUUM 뒤 표 크기 | 368,640바이트, 세 번 모두 | 8,192바이트로 돌아감 | 빗나감 |

### 묶음 4: 지속성 설정 (설정마다 3회)

모든 실행에서 바라던 설정이 실제로 걸렸고 표의 행 수가 넣은 수와 같았다. 같은 볼륨에서 8KB 동기 쓰기(`dd`, `oflag=dsync`) 한 번은 MySQL 0.612ms, PostgreSQL 0.683ms였다. 초당 `INSERT`는 실행 순서대로 적고, 배수는 세 실행의 중앙값끼리 나눴다. 지연은 세 실행 값의 중앙값이다. 1.5배 이상이면 확연히 늘어남이다.

| 조건 | 초당 `INSERT` | 중앙값 [최소~최대] | 기본값 대비 | 지연 p50 (ms) | 지연 p99 (ms) | 예상 | 판단 |
|---|---|---|---|---|---|---|---|
| MySQL 기본값(1, 1) | 892, 899, 964 | 899 [892~964] | | 0.82 | 3.32 | | |
| (가) `innodb_flush_log_at_trx_commit=2`, `sync_binlog=1` | 997, 961, 1047 | 997 [961~1047] | 1.11배 | 0.73 | 3.21 | 1.5배 이상 | 빗나감 |
| (나) `innodb_flush_log_at_trx_commit=1`, `sync_binlog=0` | 2253, 2251, 2200 | 2251 [2200~2253] | 2.50배 | 0.37 | 2.15 | 1.5배 이상 | 적중 |
| (다) `innodb_flush_log_at_trx_commit=2`, `sync_binlog=0` | 2466, 2521, 2491 | 2491 [2466~2521] | 2.77배 | 0.34 | 2.00 | 1.5배 이상 | 적중 |
| PostgreSQL 기본값(`synchronous_commit=on`) | 2482, 2426, 2608 | 2482 [2426~2608] | | 0.32 | 1.85 | | |
| (라) `synchronous_commit=off` | 3025, 3137, 3179 | 3137 [3025~3179] | 1.26배 | 0.28 | 1.51 | 1.5배 이상 | 빗나감 |

### 해석 중 더한 측정: 이어 쓰기와 덮어쓰기 (방식마다 3회)

[동기 쓰기 비교 측정 규칙](#동기-쓰기-비교-측정-규칙)대로 2026-10-28 22:57(KST)에 같은 맥에서 돌렸다. 코드는 커밋 `5a24c46` 위의 커밋하지 않은 상태였고, 환경 파일의 소스 sha256은 이 README와 함께 커밋한 코드와 같다. 에이전트가 맥에 연 원격 Claude Code 세션이 실행했고, 시작 직전에 자동 검사 28개가 통과했고 `--smoke`가 실행 오류 없이 끝났다(`results/validation/2026-10-28T225704582600-sync-write-smoke-…`). 전원은 연결된 상태, 배터리는 80%(충전 안 함)였다. 1분 load average는 `--smoke` 앞 4.70, 본 실행 앞 4.56, 끝난 뒤 4.46이었다(원격 세션이 `uptime`으로 읽은 값). 본 실행은 1분 안에 끝났고 16개 기록이 모두 검증(`valid`)을 통과했다. 두 DB의 데이터 디렉터리는 Docker Desktop VM 안의 같은 파일시스템(`/dev/vda1`, ext4)에 있었다. 그래서 두 DB의 칸은 서로 독립된 조건이 아니다.

물은 것: 덮어쓰기의 한 번 시간이 이어 쓰기의 절반 이하일지(확연히 쌈), 절반보다 클지. MySQL과 PostgreSQL의 데이터 디스크 각각이라 두 칸이다. 이유와 틀렸다고 볼 조건.

- 사람의 예상(2026-10-28, 원문): "파일이 커질 수록 확연히 싸질거라 생각해"
- 에이전트 확인(예상 전): 문장이 "덮어쓰기가 이어 쓰기보다 확연히 쌀 것"과 "이어 쓰기 안에서 파일이 커질수록 한 번 시간이 싸질 것" 두 가지로 읽혀 어느 쪽인지 되묻고, 두 디스크 각각의 예상과 이유, 틀렸다고 볼 조건을 다시 물었다. 뒤쪽은 500번의 평균만 재므로 이 측정으로 확인할 수 없다고 알렸다.
- 사람의 예상(원문): "덮어쓰기가 이어쓰기보다 확연히 쌀 것 같아. 그 이유는 파일이 커질 수록 이어쓰기는 새로 데이터를 입력할 위치를 찾는 시간이 증가하지만 덮어쓰기는 쓸 위치를 찾을 필요가 없기 때문이야. 그래서 둘 다 절반 이하로 예상해."
- 판정에 쓰는 예상: 두 칸 모두 덮어쓰기 ÷ 이어 쓰기 0.5배 이하. 틀렸다고 볼 조건은 따로 적지 않았다.

한 번 시간은 세 실행의 값을 실행 순서대로 적고, 배수는 중앙값끼리 나눴다.

| 데이터 디스크 | 이어 쓰기 (ms) | 덮어쓰기 (ms) | 덮어쓰기 ÷ 이어 쓰기 | 예상 | 판단 |
|---|---|---|---|---|---|
| MySQL | 0.675, 0.763, 0.739 (중앙값 0.739) | 0.088, 0.073, 0.094 (중앙값 0.088) | 0.12배 | 0.5배 이하 | 적중 |
| PostgreSQL | 0.643, 0.719, 0.658 (중앙값 0.658) | 0.087, 0.102, 0.075 (중앙값 0.087) | 0.13배 | 0.5배 이하 | 적중 |

이 두 칸(2/2)은 해석 중에 더한 문제라 위의 예상 단계 합계(31/63)와 따로 센다. 이유("쓸 위치를 찾는 시간")에 대한 피드백은 [첫 해석](#첫-해석)에 있다.

### 측정하며 본 것

- 묶음 2의 MySQL에서 시작 전 History list length가 1000 이하로 줄기를 기다린 시간이 두 번 60초를 다 채웠다. 워밍업의 (다)는 바로 앞 (나)가 남긴 1016에서, 1회차의 (가)는 바로 앞 (나)가 남긴 2216에서 시작했다. 이 두 실행은 걸린 시간이 약 81초였고 나머지 실행은 약 21초였다. 1회차 (가)의 B가 끝난 직후 값(271)은 다른 회차(276, 304)와 비슷했다. 규칙의 60초는 기다림의 상한이고 제대로 돈 실행의 조건이 아니라서 결과에 넣었다.
- MySQL에서 A가 끝난 뒤 History list length가 10초 동안 줄지 않은 실행이 있었다. (나)의 워밍업은 1·3·10초 뒤 1003·1003·1004, 1회차는 2203·2203·2204였고, (나)의 2·3회차와 (바)는 워밍업을 포함한 네 번 모두 3초 안에 0이 되었다. (가)·(다)·(라)의 네 번과 (마)의 워밍업·1·2회차는 B가 끝난 직후 값이 10초 뒤에도 그대로이거나 1~2만 늘었다(예: (가) 1회차 271 → 272). (마)의 3회차만 310에서 1초 뒤 0이 되었다.
- PostgreSQL 4-2의 (나)는 2회차만 구간 5/구간 1이 1.13배였다. 이 회차는 구간 1이 0.45ms로 다른 회차(0.39ms)보다 느렸다. 같은 2회차의 (마)·(바)도 세 번 중 가장 작았다(1.23배, 1.09배. 나머지 1.39~1.40배, 1.28~1.31배).
- 5-1의 InnoDB에서 B의 `UPDATE`는 0.005~0.007초 걸렸다(컨테이너는 1ms 미만). 0.5초 규칙으로는 기다림이 아니다.
- 묶음 4는 컨테이너 임시 확인 값과 배수가 크게 달랐다(아래 표).

### 참고: 컨테이너 임시 확인 값과 맥 본 측정

컨테이너 값은 문제 상황마다 피드백에서 이미 보였다. Linux x86_64 컨테이너에서 같은 버전의 MySQL·PostgreSQL 이미지(`linux/amd64`)로 돌린 값이며, 환경이 달라 판정에 쓰지 않는다.

| 항목 | 컨테이너 | 맥 본 측정 |
|---|---|---|
| 묶음 1·3 순서표 41개 조건의 값·기다림·오류 | 문제 상황 피드백의 표 | 모두 같음 |
| 4-1 MySQL (나) A의 읽기 중앙값 | 9.31, 6.82, 12.85ms(약 26배) | 2.91, 2.90, 2.92ms(9.3배) |
| 4-1 PostgreSQL (나) A, C의 배수 | 약 2.4배, 약 1.7배 | 1.33배, 1.62배 |
| 4-2 PostgreSQL (나) 구간 5/구간 1 | 1.45, 1.52, 1.46배 | 1.36, 1.13, 1.34배 |
| 4-3 MySQL `COMMIT` 3초 뒤 History list length | 0, 0, 0 | 2203, 0, 0 |
| 묶음 4 MySQL 기본값 | 초당 652, p50 1.40ms | 초당 899, p50 0.82ms |
| 묶음 4 (가) / (나) / (다) | 1.37 / 1.25 / 3.38배 | 1.11 / 2.50 / 2.77배 |
| 묶음 4 PostgreSQL 기본값 | 초당 1225, p50 0.72ms | 초당 2482, p50 0.32ms |
| 묶음 4 (라) | 3.65배 | 1.26배 |
| 8KB 동기 쓰기 MySQL / PostgreSQL | 0.58 / 0.54ms | 0.61 / 0.68ms |
| 이어 쓰기 → 덮어쓰기, MySQL 데이터 디스크 | 0.311 → 0.150ms(0.48배) | 0.739 → 0.088ms(0.12배) |
| 이어 쓰기 → 덮어쓰기, PostgreSQL 데이터 디스크 | 0.359 → 0.153ms(0.43배) | 0.658 → 0.087ms(0.13배) |

### 첫 해석

2026-10-28에 맥 본 측정의 표를 보며 나눈 문답이다. 에이전트가 결과 표와 측정상의 문제를 먼저 보이고, 사람이 관찰한 사실과 예상에서 벗어난 점을 해석했다. 사람의 말은 원문 그대로 적고, 에이전트의 말은 줄여 적는다.

#### 컨테이너 임시 확인과 맥 본 측정의 차이

- 사람의 질문(원문): "컨테이너 측정과 맥 본 측정은 어떤 차이가 있는거야?"
- 에이전트 설명: 컨테이너 값은 에이전트가 코드를 점검하며 돌린 참고값으로, 예상을 받은 뒤 피드백에서만 보였고 판정에 쓰지 않았으며 원자료도 남기지 않았다. 맥 본 측정은 판정에 쓰고 원자료를 `results/`에 남겼다. 기계(클라우드 Linux VM의 Intel Xeon 4 vCPU, x86_64 / M2 Pro, arm64), DB가 도는 곳(그 VM 안의 Docker, `linux/amd64` 이미지 / Docker Desktop이 macOS 위에 띄운 Linux VM, `linux/arm64` 이미지), DB 파일이 있는 디스크(클라우드 VM의 가상 디스크 / 맥 SSD 위의 파일인 Docker Desktop VM의 가상 디스크), Python 클라이언트 위치(DB와 같은 Linux / macOS에서 port forwarding으로 VM에 붙음), 반복 횟수(워밍업 1회와 2~3회 / 모든 조건 워밍업 1회와 3회)가 달랐다. DB 버전, 측정 코드, DB 설정, Python 3.14.2(GIL 빌드)는 같았다. 누가 무엇을 읽고 누가 기다리는지(묶음 1·3)는 두 곳이 같았고, 지연과 처리량처럼 시간을 재는 숫자는 달랐다.

#### 묶음 4: 커밋마다 기다리는 두 fsync의 몫

- 사람의 질문(원문): "어떤 해석을 워하는 거야?"
- 에이전트 설명: 바라는 해석은 표에서 보이는 것, 그중 예상과 다른 것, 왜 그랬을 것 같은지라고 했다. 지연 p50(MySQL 기본값 0.82ms, (가) 0.73ms, (나) 0.37ms, (다) 0.34ms, PostgreSQL on 0.32ms → off 0.28ms)을 보이고 두 가지를 물었다. (1) 이 맥에서 redo log fsync와 binary log fsync는 각각 얼마쯤 걸렸고 어느 쪽이 비싼가. (2) 예상 (가)는 어떤 점 때문에 빗나갔다고 보는가.
- 사람의 해석(원문): "1. binlog fsync가 더 비싼 작업이야. 약 0.1ms, 0.5ms씩 걸렸어. 2. 커밋 한 번마다 각 작업을 위해 fsync를  두 번씩 호출하는 걸 놓쳤어. 그래서, 각 커밋에서 디스크 접근 작업이 완전 배제된 줄 알았어."
- 에이전트 피드백(설명): 둘 다 맞았다. redo log fsync를 빼면 p50이 0.09ms, binary log fsync를 빼면 0.46ms 줄어, 이 맥에서는 binary log 쪽이 약 5배 비쌌다. (가)는 남은 쪽이 비싼 binary log라 1.11배에 그쳤다. 컨테이너에서는 두 fsync가 각각 0.3~0.4ms로 비슷해 하나만 빼도 1.37배였다. 같은 이유("하나가 남는다")라도 어느 쪽이 남느냐에 따라 배수가 달라졌다. 이어서 두 fsync가 같은 디스크에 같은 시스템 호출(`fdatasync`, MySQL 8.4.13 소스에서 확인)인데 binary log 쪽이 5배 비싸고 PostgreSQL WAL은 0.04ms로 redo log처럼 싼 까닭을, 커밋이 쌓일 때 두 파일이 어떻게 변하는지로 물었다.
- 사람의 해석(원문): "정확히는 모르겠어. WAL 로그를 추가하는건 append only 작업이라서 기존의 데이터를 확인한다던가 하는 보조 작업이 필요없다는게 비용이 작은 것의 원인이지 않을까 싶어."
- 에이전트 피드백(설명): 로그 끝에 이어 쓰는 것은 redo log, binary log, WAL이 모두 같고, 다른 것은 파일 수준이다. binary log는 커밋마다 파일 끝에 바이트가 붙어 파일 크기가 커진다. redo log(`#innodb_redo`의 파일을 돌려 씀)와 WAL(16MB 세그먼트를 미리 만들어 둠)은 미리 만든 고정 크기 파일의 자리를 덮어써 파일 크기가 변하지 않는다. `fdatasync`는 데이터만 내리지만 파일 크기가 바뀌었으면 그 metadata도 내려야 한다([fdatasync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html): "a change to the file size (st_size, as made by say ftruncate(2)), would require a metadata flush"). 파일시스템 journal 쓰기가 더 붙는다는 뜻이다. 새 파일에 8KB씩 이어 쓰고 동기화하는 `dd` 기준(0.61~0.68ms)이 binary log 몫(0.46ms)과 비슷했다. 컨테이너에서는 동기 쓰기 자체가 비싸 세 로그가 비슷하게 비쌌던 것으로 보인다. 이 설명은 추론이라, 확인하는 짧은 측정과 다음 해석 주제(묶음 2) 중에서 고르게 했다.
- 사람의 선택(원문): "1번 측정하고 넘어가자"

#### 이어 쓰기와 덮어쓰기

예상과 결과는 [해석 중 더한 측정](#해석-중-더한-측정-이어-쓰기와-덮어쓰기-방식마다-3회)에 있다. 에이전트는 결과 표와 함께 측정상의 문제 셋(두 DB의 데이터 디렉터리가 같은 파일시스템이라 독립된 두 조건이 아님, 500번의 평균만 있어 파일이 커질수록 느려지는지는 알 수 없음, load average 4.3~4.7의 배경 부하와 조건마다 3회)을 보이고, 관찰한 사실과 예상에서 벗어난 점, 그리고 예상의 이유를 결과가 뒷받침하는지 물었다.

- 사람의 답(원문): "넘어가자"
- 에이전트 피드백(설명): 결과(덮어쓰기가 확연히 쌈)는 맞았지만, 이유로 든 "쓸 위치를 찾는 시간"은 이 측정으로 확인되지 않았다. 파일 끝 위치는 inode에 있는 파일 크기로 바로 알 수 있어 찾는 비용은 거의 없다. 더 그럴듯한 설명은, 이어 쓰기는 쓸 때마다 새 블록을 할당하고 파일 크기가 바뀌어 `fdatasync`가 이 metadata를 ext4 journal에도 내려야 하고, 덮어쓰기는 이미 할당된 블록에 데이터만 내리면 된다는 것이다(추론이며 journal 쓰기를 직접 재지는 않았다). 덮어쓰기 0.088ms는 묶음 4의 redo log 몫(0.09ms)과 거의 같아 앞의 추론과도 맞는다.

#### 묶음 2: History list length가 줄지 않고 머문 실행

에이전트가 보인 사실은 [측정하며 본 것](#측정하며-본-것)의 첫 두 항목이다. (나)에서 A가 `COMMIT`한 뒤 2·3회차는 3초 안에 0이 되었지만 워밍업은 1003·1003·1004, 1회차는 2203·2203·2204로 10초 동안 그대로였다. 그 두 번 바로 뒤의 실행만 1000 이하로 줄기를 기다리는 시간이 60초 상한을 다 채웠다(1016, 2216에서 시작). (가)·(다)·(라)는 B가 끝난 직후 값(약 270)이 10초 뒤에도 그대로였다. 측정상의 문제로 값을 1·3·10초 세 번만 읽었고, History list length가 이 표만이 아닌 서버 전체의 값이라는 것을 보였다. 물음은 같은 (나)인데 왜 어떤 실행은 0까지 줄고 어떤 실행은 1000이나 2200 근처에 머물렀느냐였다.

- 사람의 답(원문): "짐작도 못하겠어"
- 에이전트 설명(단서 1): MySQL 8.4.13 소스 `srv0srv.cc`의 purge coordinator는 10ms 기다리는 동안 History list length가 그대로이고 그 값이 5000보다 작으면 쉬러 들어가고, 행을 바꾸는 새 DML이 들어올 때까지 다시 일어나지 않는다(소스 주석이 이 5000을 "magic number"라고 부른다). 범위를 좁혀, (나) 1회차 다음 실행이 2216에서 시작해 60초 동안 줄지 않은 까닭을 기다리는 동안 그 실행이 DB에 무엇을 했는지로 물었다.
- 사람의 질문(원문): "'이 실행'이라는게 뭐야?"
- 에이전트 설명: `history_lab.py`는 경우 (가)~(바)를 회차마다 하나씩 차례로 돌리고, 그 하나(예: 1회차의 (가))를 실행이라고 불렀다. 각 실행은 앞 실행이 남긴 History list length가 1000 이하로 줄 때까지 기다린 뒤(최대 60초) A를 열고 B가 고치기 시작한다. 물음의 실행은 1회차의 (가)다.
- 사람의 답(원문): "다른 트랜잭션의 스냅샷에서 참조하는 행을 이 트랜잭션의 스냅샷에서 포함하고 있어서?"
- 에이전트 피드백(설명): (나)에서 A가 열려 있는 동안 1만까지 쌓인 이유로는 맞지만 이 60초에는 맞지 않는다. 기다리는 단계에는 A가 아직 열리지 않았고 앞 실행의 A는 이미 `COMMIT`했으며, 스크립트는 0.2초마다 `SHOW ENGINE INNODB STATUS`로 값을 읽기만 했다(열린 트랜잭션 목록은 남기지 않아 코드로 확인한 것이다). 또 2·3회차의 (나)는 같은 순서로 `COMMIT`했는데 3초 안에 0이 되었다. 이어서 `SHOW ENGINE INNODB STATUS`가 DML인지, 단서 1의 규칙에 넣으면 그동안 purge thread가 어떤 상태였을지 물었다.
- 사람의 질문(원문): "DML이 뭐야?"
- 에이전트 설명: DML(Data Manipulation Language)은 표 안의 행을 다루는 SQL 문장이고, 여기서는 행을 바꾸는 `INSERT`, `UPDATE`, `DELETE`를 가리킨다. 표의 구조를 만들거나 바꾸는 `CREATE TABLE`, `ALTER TABLE`은 DDL(Data Definition Language)이다. `SHOW ENGINE INNODB STATUS`는 서버 상태를 보여 줄 뿐 행을 건드리지 않는다. MySQL 매뉴얼은 `SELECT`도 data manipulation 문장으로 묶지만, purge thread를 깨우는 것은 행을 바꾸는 문장이다.
- 사람의 질문(원문): "질문이 뭐였지?"
- 에이전트 설명: 상황(2216에서 60초 동안 `SHOW ENGINE INNODB STATUS`만 보냈고 값이 줄지 않음), 단서 1, 물음 둘((1) `SHOW ENGINE INNODB STATUS`는 DML인가, (2) 그동안 purge thread는 어떤 상태였고 왜 값이 줄지 않았나)을 한곳에 모아 다시 적었다.
- 사람의 해석(원문): "1. DML이 아니야. 데이터를 조작하진 않잖아. 2. 잠든 상태였을거야. 개수가 5000을 넘지도 않고 DML을 실행한것도 아니니까."
- 에이전트 피드백(설명): 둘 다 맞았다. 60초가 지나 B의 `UPDATE`가 시작되자 purge가 다시 돌아, 그 실행은 다른 실행(약 21초)보다 60초쯤 긴 약 81초가 걸렸고 B가 끝난 직후 값(271)은 다른 회차와 비슷했다. 다만 purge thread가 잠들어 있었다는 것은 소스로 한 추론이다. `SHOW ENGINE INNODB STATUS`에는 purge 상태를 보여 주는 줄이 있지만 이번에는 그 줄을 남기지 않았다. 단서 2로, History list length는 purge가 undo log를 정리할 때 바로 줄지 않고 purge가 128번 돌 때마다 한 번 하는 truncate 단계에서만 준다고 했다(같은 소스의 `srv_purge_rseg_truncate_frequency`, 그리고 history list에서 undo log를 떼어 내며 이 수를 줄이는 `trx_purge_remove_log_hdr`가 truncate 때만 불린다). 그리고 단서 1·2로 어떤 회차는 0까지, 어떤 회차는 2203에서 멈출 수 있는 까닭을 물었다.
- 사람의 답(원문): "그건 잘 모르겠어"
- 에이전트 설명(소스로 한 추론, 이번 자료로 확인하지 않음): (1) `COMMIT` 직후는 10002로 5000보다 커서 purge thread는 쉬지 않고 정리하며 128번마다 truncate로 수를 줄인다. (2) 5000 아래로 내려오면 쉬는 규칙이 걸린다. 수는 truncate 때만 줄기 때문에 truncate와 truncate 사이에는 purge가 일하는 중이어도 수가 그대로처럼 보이고, 이때 10ms 확인에 걸리면 변화가 없다고 보고 잠든다. (3) 그래서 어디서 멈추는지는 타이밍에 달렸다. 마지막 truncate가 정리를 다 끝낸 뒤에 돌았다면 0까지 내려가고(2·3회차), 그 전에 잠들었다면 그때 수(2203, 1003)에서 새 DML이 올 때까지 멈춘다. (가)·(다)·(라)의 약 270이 10초 동안 그대로였던 것도, B가 끝난 뒤 새 DML이 없고 수가 5000 아래였으니 같은 규칙으로 설명된다. 이 설명대로라면 History list length는 "purge가 아직 처리하지 못한 수"라기보다 history list에 아직 남아 있는 커밋된 트랜잭션의 undo log 수이고, truncate 전에는 이미 정리한 몫도 들어 있다. 확인하려면 `COMMIT` 뒤 purge 상태 줄을 함께 0.2초마다 남기거나, 멈춘 뒤 작은 `UPDATE` 하나를 넣어 수가 줄어드는지 보면 된다.
- 사람의 선택(원문): "1로 진행하자". 확인하는 측정은 하지 않고 여기까지의 해석을 정리했다.
