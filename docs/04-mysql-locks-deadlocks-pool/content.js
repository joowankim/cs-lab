/*
 * 요소 설명·장면 안내·근거 링크. 실행 상태는 model.js가 만들고 여기서는 고정된 설명만 둔다.
 * 근거 종류: measured(실측 기록), source(소스·공식 문서), record(실험 문답 기록), model(설명용 가정).
 * 장면의 "먼저 생각해 볼 질문"은 실험 README의 문제 상황을 표, 처음 행, 문장 순서, 조건까지 처음 낸 그대로 다시 적는다. 답은 적지 않는다.
 */
(function (root) {
  'use strict';

  // 근거 파일은 GitHub의 main 브랜치 판을 연다. 화면을 Pages에서 열든 내려받은 폴더에서 열든 같은 곳으로 간다.
  const REPO = 'https://github.com/joowankim/cs-lab/blob/main/';
  const EXP = `${REPO}experiments/04-mysql-locks-deadlocks-pool/`;
  const README = `${EXP}README.md`;
  const ANKI = `${REPO}anki/04-mysql-locks-deadlocks-pool.md`;
  const MYSQL = 'https://dev.mysql.com/doc/refman/8.4/en/';
  const SQLA = 'https://docs.sqlalchemy.org/en/21/';

  const EV = {
    readmeProblem1: { type: 'record', label: '실험 README · 문제 상황 1: 잠근 응모 사이로 들어오는 새 응모', href: `${README}#문제-상황-1-잠근-응모-사이로-들어오는-새-응모-2026-11-03` },
    readmeProblem1_1: { type: 'record', label: '실험 README · 문제 상황 1-1: 인덱스가 없을 때', href: `${README}#문제-상황-1-1-인덱스가-없을-때-2026-11-03` },
    readmeProblem1_2: { type: 'record', label: '실험 README · 문제 상황 1-2: 실험 3에서 미뤄 둔 1.74초', href: `${README}#문제-상황-1-2-실험-3에서-미뤄-둔-174초-2026-11-03` },
    readmeProblem2: { type: 'record', label: '실험 README · 문제 상황 2: 서로 반대로 보낸 두 이체', href: `${README}#문제-상황-2-서로-반대로-보낸-두-이체-2026-11-03` },
    readmeProblem2_1: { type: 'record', label: '실험 README · 문제 상황 2-1: 동시에 몰린 포인트 차감 10건', href: `${README}#문제-상황-2-1-동시에-몰린-포인트-차감-10건-2026-11-03` },
    readmeProblem3: { type: 'record', label: '실험 README · 문제 상황 3: 동시에 들어온 같은 리워드 지급 10건', href: `${README}#문제-상황-3-동시에-들어온-같은-리워드-지급-10건-2026-11-03` },
    readmeProblem4: { type: 'record', label: '실험 README · 문제 상황 4: 커넥션 풀보다 많이 몰린 요청', href: `${README}#문제-상황-4-커넥션-풀보다-많이-몰린-요청-2026-11-04` },
    readmeTimelineRules: { type: 'record', label: '실험 README · 순서표 실행 규칙 (0.5초 기다림, 미룸, 지연, 락 읽기)', href: `${README}#순서표-실행-규칙` },
    readmeBurstRules: { type: 'record', label: '실험 README · 동시 요청 측정 규칙', href: `${README}#동시-요청-측정-규칙` },
    readmePoolRules: { type: 'record', label: '실험 README · 커넥션 풀 측정 규칙', href: `${README}#커넥션-풀-측정-규칙` },
    readmeEnv: { type: 'measured', label: '실험 README · 측정 환경과 원자료 (Apple M2 Pro, Docker Desktop, MySQL 8.4.13)', href: `${README}#측정-환경과-원자료-2026-11-04` },
    readmeBatch1: { type: 'measured', label: '실험 README · 묶음 ① 결과: 잠근 범위 사이의 삽입과 삭제 (조건마다 3회)', href: `${README}#묶음--잠근-범위-사이의-삽입과-삭제-조건마다-3회` },
    readmeBatch2: { type: 'measured', label: '실험 README · 묶음 ② 결과: 반대로 보낸 두 이체와 락 순서 (조건마다 3회)', href: `${README}#묶음--반대로-보낸-두-이체와-락-순서-조건마다-3회` },
    readmeBurst: { type: 'measured', label: '실험 README · 묶음 ②·③ 결과: 같은 요청 10건 (판마다 3회)', href: `${README}#묶음--같은-요청-10건-판마다-3회` },
    readmeBatch4: { type: 'measured', label: '실험 README · 묶음 ④ 결과: 커넥션 풀 (경우마다 3회)', href: `${README}#묶음--커넥션-풀-경우마다-3회` },
    readmeObserved: { type: 'measured', label: '실험 README · 측정하며 본 것', href: `${README}#측정하며-본-것` },
    readmeContainer: { type: 'measured', label: '실험 README · 참고: 컨테이너 임시 확인 값과 맥 본 측정', href: `${README}#참고-컨테이너-임시-확인-값과-맥-본-측정` },
    readmeInterpretPool: { type: 'record', label: '실험 README · 첫 해석: 30배 비싼 새 연결이 먼저 끝낸 50건', href: `${README}#묶음--30배-비싼-새-연결이-먼저-끝낸-50건` },
    readmeInterpretDeadlocks: { type: 'record', label: '실험 README · 첫 해석: 두 데드락의 같은 점과 다른 점', href: `${README}#묶음--두-데드락의-같은-점과-다른-점` },
    timelines: { type: 'source', label: 'python/lock_timelines.py (순서표의 SQL)', href: `${EXP}python/lock_timelines.py` },
    lockLab: { type: 'source', label: 'python/lock_lab.py (세션마다 한 문장씩, 기다림·미룸, data_locks 읽기)', href: `${EXP}python/lock_lab.py` },
    burstLab: { type: 'source', label: 'python/burst_lab.py (요청 코드와 판)', href: `${EXP}python/burst_lab.py` },
    poolLab: { type: 'source', label: 'python/pool_lab.py (풀 경우와 요청 50개)', href: `${EXP}python/pool_lab.py` },
    lockData: { type: 'measured', label: '원자료 · 묶음 ①②와 ③의 두 요청 순서표', href: `${EXP}results/2026-11-04T170113049668-locks-python-3.14.2.jsonl` },
    burstData: { type: 'measured', label: '원자료 · 2-1과 ③의 같은 요청 10건', href: `${EXP}results/2026-11-04T170237309105-burst-python-3.14.2.jsonl` },
    poolData: { type: 'measured', label: '원자료 · 묶음 ④ 커넥션 풀', href: `${EXP}results/2026-11-04T164215794556-pool-python-3.14.2.jsonl` },
    docInnodbLocking: { type: 'source', label: 'MySQL 8.4 문서 · InnoDB Locking (레코드·갭·넥스트 키·삽입 의도 락)', href: `${MYSQL}innodb-locking.html` },
    docLocksSet: { type: 'source', label: 'MySQL 8.4 문서 · Locks Set by Different SQL Statements in InnoDB', href: `${MYSQL}innodb-locks-set.html` },
    docIsoMysql: { type: 'source', label: 'MySQL 8.4 문서 · Transaction Isolation Levels', href: `${MYSQL}innodb-transaction-isolation-levels.html` },
    docIndexTypes: { type: 'source', label: 'MySQL 8.4 문서 · Clustered and Secondary Indexes', href: `${MYSQL}innodb-index-types.html` },
    docDataLocks: { type: 'source', label: 'MySQL 8.4 문서 · The data_locks Table', href: `${MYSQL}performance-schema-data-locks-table.html` },
    docDataLockWaits: { type: 'source', label: 'MySQL 8.4 문서 · The data_lock_waits Table', href: `${MYSQL}performance-schema-data-lock-waits-table.html` },
    docErrorHandling: { type: 'source', label: 'MySQL 8.4 문서 · InnoDB Error Handling (1213, 1205가 되돌리는 범위)', href: `${MYSQL}innodb-error-handling.html` },
    docDeadlockDetection: { type: 'source', label: 'MySQL 8.4 문서 · Deadlock Detection', href: `${MYSQL}innodb-deadlock-detection.html` },
    docDeadlocksHandling: { type: 'source', label: 'MySQL 8.4 문서 · How to Minimize and Handle Deadlocks', href: `${MYSQL}innodb-deadlocks-handling.html` },
    docTooMany: { type: 'source', label: 'MySQL 8.4 문서 · Too many connections (max_connections)', href: `${MYSQL}too-many-connections.html` },
    sqlaPooling: { type: 'source', label: 'SQLAlchemy 2.1 문서 · Connection Pooling (QueuePool, NullPool, pool_timeout)', href: `${SQLA}core/pooling.html` },
    modelRules: { type: 'model', label: '화면 README · 모형의 가정 (락 규칙, 기다림 줄, 데드락, 단계)', href: `${REPO}docs/04-mysql-locks-deadlocks-pool/README.md#모형의-가정` },
    anki: { type: 'record', label: '복습 카드 (anki/04-mysql-locks-deadlocks-pool.md)', href: ANKI },
  };

  const TYPE_LABEL = { measured: '실측 기록', source: '소스·공식 문서', record: '실험 기록', model: '설명용 가정' };

  // 문제 상황의 표와 문장. 질문마다 처음 낸 그대로 다시 적는다.
  const ENTRIES = 'entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))';
  const ENTRIES_NOIDX = 'entries (id INT PRIMARY KEY, user_id INT NOT NULL)(user_id 인덱스 없음)';
  const ROWS4 = '(id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)';
  const A_LOCK = 'A가 START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;(→ 2, 3)를 하고 커밋하기 전에';
  const ACCOUNTS = '표 accounts (id INT PRIMARY KEY, balance INT NOT NULL)에 (1, 1000), (2, 1000)이 있다.';
  const TRANSFER = '1번 A(1번 계좌 → 2번 계좌로 100) START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1; → 2번 B(2번 → 1번으로 100) START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 2; → 3번 A UPDATE accounts SET balance = balance + 100 WHERE id = 2; → 4번(3번 2초 뒤) B UPDATE accounts SET balance = balance + 100 WHERE id = 1; → 5번 A COMMIT; → 6번 B COMMIT;. 오류가 나도 다음 문장을 그대로 보낸다(오류를 확인하지 않는 앱).';
  const POINTS_V = 'points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)';
  const REWARDS = 'rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))';
  const REWARD_CODE = 'START TRANSACTION; → SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;(0이 아니면 ROLLBACK, "이미 받음") → (앱 50ms) → INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); → UPDATE points SET balance = balance + 1000 WHERE user_id = 7; → COMMIT;';
  const POOL_SCENE = '웹 서버가 SQLAlchemy QueuePool로 MySQL에 붙어 있다. 요청 50개가 같은 순간에 들어오고, 요청마다 풀에서 연결을 빌려(with engine.connect() as conn:) 트랜잭션을 연 채(with conn.begin():) SELECT 1 뒤 200ms를 쓰고(트랜잭션 안에서 외부 API 응답을 기다리는 셈) 커밋하고 돌려준다. max_overflow=0이라 pool_size보다 더 만들지 않고, pool_timeout을 넘게 기다리면 오류이며, 풀의 연결은 미리 다 만들어 둔 상태에서 시작한다.';
  const MEASURED_ENV = '실험: Apple M2 Pro의 Docker Desktop, MySQL 8.4.13, 조건마다 워밍업 1회와 3회. 네 번 모두 같은 행·기다림·오류·락·끝난 뒤 값을 돌려줬다.';

  const SCENES = {
    gap: {
      questions: [
        `표 ${ENTRIES}에 처음 행 ${ROWS4}가 있다. ${A_LOCK}, B(자동 커밋)가 다섯 문장 중 하나를 보내고, 이어서 A가 COMMIT;한다. 경우마다 처음 행에서 따로 돌린다. B는 (가) INSERT INTO entries VALUES (10, 7); (나) (11, 5) (다) (12, 10) (라) (13, 15) (마) (14, 1)이다. A가 REPEATABLE READ일 때와 READ COMMITTED일 때 (가)~(마)는 각각 A의 COMMIT까지 기다릴까, 바로 끝날까? 이유는?`,
        '같은 상황에서 A의 FOR UPDATE가 idx_user와 PRIMARY에 거는 락을 data_locks 꼴(인덱스, LOCK_MODE, LOCK_DATA)로 적어 보자. B가 넣으려는 다섯 행은 idx_user에서 각각 어느 두 레코드 사이 갭에 들어갈까?',
      ],
      observe: [
        'A의 FOR UPDATE 뒤(단계 2) idx_user 줄에서 이름표가 붙은 칸을 본다. 조건에 맞는 레코드 칸, 그 앞 갭 칸, 끝을 확인하려고 읽은 다음 레코드의 칸이 각각 어떻게 다른지 data_locks 표와 견준다.',
        'B의 INSERT가 들어갈 갭은 idx_user의 키 (user_id, id) 순서로 정해진다. B에서 나가는 회색 점선이 어느 칸으로 가는지 본다.',
        '격리 수준을 READ COMMITTED로 바꿔 같은 칸의 이름표와 B의 기다림을 견준다.',
        'B의 레코드가 들어오면 그 자리의 갭 칸이 둘로 나뉜다. PRIMARY 줄에서는 새 id가 어디에 들어가는지도 본다.',
      ],
      measured: [
        MEASURED_ENV,
        'REPEATABLE READ: (가) user 7, (나) user 5, (다) user 10이 A의 COMMIT까지 기다렸고(0.81~0.83초, 실행 틀이 기다림을 기록하고 COMMIT을 보내기까지의 시간), (라) user 15, (마) user 1은 바로 끝났다.',
        'READ COMMITTED: 다섯 모두 바로 끝났다.',
        'B가 보낸 직후 data_locks(REPEATABLE READ): A가 idx_user에 X (7, 2)·(7, 3), X,GAP (12, 4), PRIMARY에 X,REC_NOT_GAP 2·3. B는 (가)·(다) idx_user (12, 4)에, (나) idx_user (7, 2)에 X,GAP,INSERT_INTENTION으로 기다렸다.',
        'READ COMMITTED의 data_locks: A가 idx_user (7, 2)·(7, 3)과 PRIMARY 2·3에 X,REC_NOT_GAP만 쥐었다.',
      ],
      evidence: ['readmeProblem1', 'readmeBatch1', 'readmeTimelineRules', 'readmeEnv', 'lockData', 'timelines', 'lockLab', 'docInnodbLocking', 'docLocksSet', 'docIsoMysql', 'docDataLocks'],
      cards: ['04-002', '04-003', '04-004', '04-005', '04-006', '04-007', '04-010'],
    },
    noidx: {
      questions: [
        `표 ${ENTRIES_NOIDX}에 처음 행 ${ROWS4}가 있다. ${A_LOCK}, B(자동 커밋)가 세 문장 중 하나를 보내고, 이어서 A가 COMMIT;한다. 경우마다 처음 행에서 따로 돌린다. B는 (가) INSERT INTO entries VALUES (10, 7); (나) INSERT INTO entries VALUES (13, 15); (다) DELETE FROM entries WHERE id = 1;(user_id 3의 응모 취소)이다. REPEATABLE READ와 READ COMMITTED에서 (가)~(다)는 각각 A의 COMMIT까지 기다릴까, 바로 끝날까? 이유는?`,
        '같은 상황에서 A가 user_id = 7인 행을 찾으려면 어느 인덱스의 어떤 레코드를 훑어야 할까? 훑은 레코드마다 어떤 락이 남을까(REPEATABLE READ, READ COMMITTED)?',
      ],
      observe: [
        'idx_user가 없으면 A가 user_id = 7을 찾으려고 어느 인덱스를 훑는지, 훑은 레코드마다 어떤 이름표가 붙는지 본다.',
        '(다) DELETE에서 B가 기다리는 칸과 (가)·(나) INSERT에서 기다리는 칸을 견준다.',
        'READ COMMITTED로 바꾸면 조건에 맞지 않는 레코드의 칸이 어떻게 되는지 본다.',
      ],
      measured: [
        MEASURED_ENV,
        'REPEATABLE READ: (가) user 7, (나) user 15, (다) id 1 삭제 모두 A의 COMMIT까지 기다렸다(0.82~0.83초).',
        'READ COMMITTED: 셋 모두 바로 끝났다.',
        'data_locks(REPEATABLE READ): A가 PRIMARY에 X 1·2·3·4·supremum pseudo-record. B는 (가)·(나) supremum에 X,INSERT_INTENTION, (다) PRIMARY 1에 X,REC_NOT_GAP으로 기다렸다.',
        'data_locks(READ COMMITTED): A가 PRIMARY에 X,REC_NOT_GAP 2·3만 쥐었다.',
      ],
      evidence: ['readmeProblem1_1', 'readmeBatch1', 'readmeTimelineRules', 'readmeEnv', 'lockData', 'timelines', 'docLocksSet', 'docInnodbLocking', 'docIndexTypes', 'docIsoMysql'],
      cards: ['04-008', '04-003', '04-002'],
    },
    serial: {
      questions: [
        `표 ${ENTRIES_NOIDX}에 처음 행 (id, user_id) = (1, 7), (2, 7), (3, 8)이 있고, A와 B 모두 SERIALIZABLE이다. 1번 A가 START TRANSACTION; 뒤 평범한 SELECT id FROM entries WHERE user_id = 7 ORDER BY id;를 하고, 2번 B가 START TRANSACTION; INSERT INTO entries (id, user_id) VALUES (4, 7); COMMIT;을 보내고, 3번 A가 같은 SELECT에 FOR UPDATE를 붙여 읽고, 4번 A가 평범한 SELECT로 다시 읽은 뒤 COMMIT;한다. 03 실험의 맥 측정에서 B의 INSERT는 A의 COMMIT까지 1.74~1.75초 기다렸다. A가 1번 뒤에 쥐었을 락을 data_locks 꼴(인덱스, LOCK_MODE, LOCK_DATA)로 적어 보자.`,
        '같은 상황에서 B의 INSERT를 막은 락은 그중 어느 것일까? id 4는 이 표의 어느 인덱스에서 어느 두 레코드 사이 갭에 들어갈까?',
        '같은 상황에서 3번과 4번에 A가 읽는 id는 각각 무엇일까?',
      ],
      observe: [
        '1번(단계 2) 뒤 A의 평범한 SELECT가 남긴 이름표와 data_locks의 LOCK_MODE를 본다.',
        'B의 INSERT(단계 4)에서 나가는 점선이 어느 칸으로 가는지, id 4가 PRIMARY의 어느 갭에 들어가는지 본다.',
        'B의 COMMIT(단계 5)이 왜 미뤄지는지, A의 COMMIT(단계 8) 뒤에 무엇이 이어서 끝나는지 본다.',
      ],
      measured: [
        MEASURED_ENV,
        'A가 쥔 락: PRIMARY에 S 1·2·3·supremum pseudo-record(넥스트 키 락, 모드는 공유).',
        'B의 INSERT는 supremum에 X,INSERT_INTENTION WAITING으로 A의 COMMIT까지 1.74~1.75초 기다렸다(03 맥 측정과 같음). B의 COMMIT은 INSERT가 끝난 뒤에 나갔다.',
        'A가 읽은 id: 1번 1, 2 · 3번(FOR UPDATE) 1, 2 · 4번 1, 2. 끝난 뒤 표에는 B의 (4, 7)이 있었다.',
      ],
      evidence: ['readmeProblem1_2', 'readmeBatch1', 'readmeTimelineRules', 'readmeEnv', 'lockData', 'timelines', 'docInnodbLocking', 'docIsoMysql', 'docIndexTypes'],
      cards: ['04-009', '04-001', '04-003'],
    },
    transfer: {
      questions: [
        `${ACCOUNTS} REPEATABLE READ, 락 대기 한도 5초. ${TRANSFER} (가) 데드락 탐지 켬(innodb_deadlock_detect=ON, 기본값)과 (나) 끔에서 3번과 4번은 각각 어떻게 끝날까(바로, 기다렸다가, 오류)? 언제까지 기다리고 무슨 오류일까? 5·6번 뒤 두 계좌의 잔액은?`,
        `${ACCOUNTS} REPEATABLE READ, 락 대기 한도 5초. 이번에는 B도 작은 id부터 고친다: 1번 A START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1; → 2번 B START TRANSACTION; UPDATE accounts SET balance = balance + 100 WHERE id = 1; → 3번 A UPDATE accounts SET balance = balance + 100 WHERE id = 2; → 4번 B UPDATE accounts SET balance = balance - 100 WHERE id = 2; → 5번 A COMMIT; → 6번 B COMMIT;. 어떻게 끝날까? 데드락 탐지를 켜고 끄는 것이 결과를 바꿀까?`,
      ],
      observe: [
        '3번(단계 5)과 4번(단계 6) 뒤 data_lock_waits에서 누가 누구의 락을 기다리는지 본다. 주황 선은 기다림의 고리다.',
        '데드락 탐지를 끄면 고리가 언제까지 남고 무엇이 그것을 푸는지, 끝 단계의 두 계좌 합을 본다.',
        '"둘 다 작은 id부터"로 바꿔 B의 첫 UPDATE가 무엇을 기다리는지 본다.',
      ],
      measured: [
        MEASURED_ENV,
        '(가) 탐지 켬: 3번이 4번까지 2.01초 기다렸다가 끝났고, 4번은 바로 1213을 받아 B의 트랜잭션 전체가 되돌려졌다. 끝난 뒤 잔액 900, 1100.',
        'LATEST DETECTED DEADLOCK(세 번 같음): (1) A가 PRIMARY 1을 lock_mode X locks rec but not gap으로 쥐고 2를 기다림, (2) B가 2를 쥐고 1을 기다림, WE ROLL BACK TRANSACTION (2)(B).',
        '(나) 탐지 끔: 3번이 5.03~5.04초 기다린 뒤 1205를 받았고, 4번은 A의 COMMIT 직후 끝났다(3.33~3.34초, A의 1205를 실행 틀이 알아채고 미뤄 둔 COMMIT을 보내기까지). 끝난 뒤 잔액 1000, 900.',
        '둘 다 작은 id부터: 탐지 켬·끔 모두 B의 첫 UPDATE가 A의 COMMIT 직후 끝났고(1.42~1.44초) 오류 없이 1000, 1000.',
      ],
      evidence: ['readmeProblem2', 'readmeBatch2', 'readmeObserved', 'readmeTimelineRules', 'lockData', 'timelines', 'docErrorHandling', 'docDeadlockDetection', 'docDeadlocksHandling', 'docDataLockWaits'],
      cards: ['04-013', '04-014', '04-015', '04-016', '04-017', '04-018'],
    },
    pair: {
      questions: [
        `빈 표 ${REWARDS}가 있다. REPEATABLE READ, 데드락 탐지 켬. A가 START TRANSACTION; SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 FOR UPDATE;(→ 0), B가 같은 두 문장(→ 0), A가 INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);, B가 같은 INSERT, A COMMIT;, B COMMIT;을 차례로 보낸다. 두 COUNT ... FOR UPDATE는 idx_user_event의 어디를 잠그고, B의 COUNT는 A를 기다릴까? 두 INSERT는 어떻게 끝날까?`,
        `이 데드락을 문제 상황 2의 이체 데드락과 견줘 보자. 이체 데드락은 ${ACCOUNTS.replace('표 ', '표 ')} REPEATABLE READ에서 A가 UPDATE accounts SET balance = balance - 100 WHERE id = 1;, B가 UPDATE accounts SET balance = balance - 100 WHERE id = 2;, A가 UPDATE accounts SET balance = balance + 100 WHERE id = 2;, B가 UPDATE accounts SET balance = balance + 100 WHERE id = 1;을 보내 B가 1213을 받았고, B도 id 1부터 고치게 바꾸자(락 순서 고정) 데드락이 없어졌다. 두 데드락의 같은 점과 다른 점은? 락 순서 고정으로 rewards의 데드락도 막을 수 있을까?`,
      ],
      observe: [
        '두 COUNT ... FOR UPDATE 뒤(단계 4) idx_user_event의 supremum 칸 이름표를 본다. 빈 표에서 두 요청이 같은 칸의 락을 함께 쥐는지 본다.',
        'A의 INSERT(단계 5)와 B의 INSERT(단계 6)에서 나가는 점선이 어느 칸으로 가는지, 고리가 어떻게 생기는지 본다.',
        '"반대로 보낸 두 이체" 장면의 고리(서로 다른 행의 레코드 락)와 견준다.',
      ],
      measured: [
        MEASURED_ENV,
        'B가 COUNT(*) ... FOR UPDATE를 보낸 직후 A와 B 모두 idx_user_event의 supremum pseudo-record에 X GRANTED였다.',
        'A의 INSERT는 supremum에 X,INSERT_INTENTION WAITING으로 기다렸고(B의 INSERT까지 0.82~0.83초), B의 INSERT는 바로 1213을 받았다.',
        'LATEST DETECTED DEADLOCK: (1)(2) 모두 supremum을 lock_mode X로 쥐고 같은 supremum에 lock_mode X insert intention waiting으로 기다림, WE ROLL BACK TRANSACTION (2)(B). 끝난 뒤 rewards는 A의 1행이었다.',
      ],
      evidence: ['readmeBurst', 'readmeInterpretDeadlocks', 'readmeProblem3', 'readmeTimelineRules', 'lockData', 'timelines', 'docInnodbLocking', 'docDeadlocksHandling'],
      cards: ['04-011', '04-019', '04-021', '04-010'],
    },
    deduct: {
      questions: [
        '표 points (user_id INT PRIMARY KEY, balance INT NOT NULL)에 (7, 1000)이 있다. 요청 10개가 같은 순간에 들어오고, 요청마다 연결 하나로 START TRANSACTION; → SELECT balance FROM points WHERE user_id = 7;(앱이 읽은 값 - 100을 계산, 50ms) → UPDATE points SET balance = <계산한 값> WHERE user_id = 7; → COMMIT;을 한다. 오류가 나면 그 요청은 실패로 끝나고 다시 하지 않는다. 데드락 탐지 켬, 락 대기 한도 5초이고, 다 반영되면 잔액은 0이다. READ COMMITTED, REPEATABLE READ, SERIALIZABLE에서 1213(데드락)을 받는 요청 수와 끝난 뒤 잔액은? 이유는?',
        '같은 상황에서 격리 수준마다 SELECT balance와 UPDATE가 거는 락은 무엇이고, 요청끼리 무엇을 기다릴까?',
      ],
      observe: [
        '격리 수준마다 요청들의 SELECT 뒤 points의 7 칸 이름표를 본다.',
        'UPDATE 단계에서 요청끼리 누가 누구를 기다리는지, 기다림의 고리가 생기는지 본다.',
        '단계 띠의 잔액 줄에서 차감이 몇 번 반영되는지 본다. 요청 수를 늘려 1213 수와 잔액이 어떻게 바뀌는지 본다.',
      ],
      measured: [
        '실험: Apple M2 Pro의 Docker Desktop, MySQL 8.4.13, 요청 10개로 판마다 워밍업 1회와 3회. 네 번 모두 같은 결과별 수·오류·끝난 뒤 값을 돌려줬다.',
        'READ COMMITTED: 차감 끝 10, 오류 없음, 잔액 900. REPEATABLE READ: 차감 끝 10, 오류 없음, 잔액 900.',
        'SERIALIZABLE: 차감 끝 1, 1213 ×9, 잔액 900.',
        '요청 시간 중앙값은 세 격리 수준 모두 약 55~70ms였다.',
      ],
      evidence: ['readmeProblem2_1', 'readmeBurst', 'readmeBurstRules', 'readmeEnv', 'burstData', 'burstLab', 'docIsoMysql', 'docInnodbLocking', 'docDeadlocksHandling'],
      cards: ['04-012', '04-001'],
    },
    reward: {
      questions: [
        `표 ${POINTS_V}에 (7, 0, 0)이 있고, ${REWARDS}는 비어 있다. REPEATABLE READ. 지금 코드는 요청마다 ${REWARD_CODE}이다. user 7의 같은 요청 10건이 같은 순간에 들어오면, 끝난 뒤 rewards 행 수, 잔액, 오류 수는?`,
        '같은 표와 요청 10건에서 "막는 방법"으로 고른 판(코드 칸에 그 판의 SQL이 있다)마다 지급 수, 오류, 다시 시도 수는? 비관적 락(먼저 잠근 뒤 확인), 낙관적 락(잠그지 않고 진행하다 고칠 때 version으로 확인), 유니크 제약(같은 (user_id, event_id) 행이 두 개 생기지 못하게 DB가 막음)은 각각 무엇을 대가로 막을까?',
      ],
      observe: [
        '막지 않음에서 각 요청의 COUNT가 언제 실행되고, 앞 요청의 INSERT가 언제 커밋되는지 단계 띠로 본다.',
        '(가) 처음 판에서 요청들이 rewards의 어느 칸을 함께 쥐는지, INSERT 단계에서 무엇을 기다리는지 본다.',
        '(가) 고친 판과 FOR UPDATE를 COUNT 다음으로 옮긴 판에서 points의 7 칸을 기다리는 줄과, 락을 받은 뒤 COUNT가 무엇을 읽었는지 견준다.',
        '(나)의 판들에서 version 줄과 바꾼 행 수를, (다)에서 1062가 나기 전에 무엇을 기다리는지 본다.',
      ],
      measured: [
        '실험: Apple M2 Pro의 Docker Desktop, MySQL 8.4.13, 요청 10개로 판마다 워밍업 1회와 3회. 네 번 모두 같은 결과별 수·오류·끝난 뒤 값을 돌려줬다.',
        '막지 않음: 10행, 잔액 10000, 지급 10, 오류 없음.',
        '(가) 처음 판(COUNT FOR UPDATE): 1행, 1000, 지급 1, 1213 ×9. (가)+(다)도 같다.',
        '(가) 고친 판(points 행 먼저 잠금): 1행, 1000, 지급 1, 이미 받음 9. 첫 요청이 58~64ms에 끝난 뒤 나머지가 약 1.5ms 간격으로 끝났다.',
        'FOR UPDATE를 COUNT 다음으로: 10행, 10000, 지급 10. 약 62~63ms 간격으로 끝났다(마지막 621~626ms).',
        '(나) 첫 판: 10행, 10000, version 0, 지급 10. 고친 판: 1행, 1000, version 1, 지급 1, 포기 9. 처음 version이 3이면 0행, 0, version 3, 포기 10.',
        '(나) 최종판: 1행, 1000, version 1, 지급 1, 이미 받음 9, 다시 시도 9.',
        '(다) 유니크 제약: 1행, 1000, 지급 1, 이미 받음 9(1062 ×9를 앱이 처리).',
      ],
      evidence: ['readmeProblem3', 'readmeBurst', 'readmeBurstRules', 'readmeObserved', 'burstData', 'burstLab', 'docInnodbLocking', 'docLocksSet', 'docDeadlocksHandling'],
      cards: ['04-020', '04-021', '04-022', '04-023', '04-024', '04-025', '04-026', '04-027'],
    },
    pool: {
      questions: [
        `${POOL_SCENE} (1) pool_size=5, pool_timeout=30초일 때 50건이 다 끝나는 시간과 가장 오래 기다린 요청이 연결을 받기까지 기다린 시간은? (2) pool_size 10, 50일 때 같은 두 값은? (3) pool_size=5, pool_timeout=0.5초일 때 풀 타임아웃 오류는 몇 건일까?`,
        `${POOL_SCENE} 이번에는 풀 없이 요청마다 새로 연결하고 끝나면 끊는다(NullPool). (가) 한 건씩 차례로 할 때 연결을 얻는 시간은 풀에서 빌릴 때의 몇 배쯤일까? (나) 50건을 동시에 보내면 다 끝나는 시간이 pool_size=5보다 길까, 짧을까? 그래도 풀을 쓰는 이유는?`,
      ],
      observe: [
        '풀 5에서 0.2초마다 몇 개의 점이 채운 원이 되는지, 가장 늦게 연결을 받는 요청이 언제인지 본다.',
        'pool_timeout 0.5초로 바꿔 0.5초 단계에 무슨 일이 생기는지 본다.',
        'NullPool로 바꿔 MySQL 상자의 열린 연결 수를 풀 5와 견준다.',
      ],
      measured: [
        '실험: Apple M2 Pro의 Docker Desktop, MySQL 8.4.13, SQLAlchemy 2.1.8·PyMySQL 1.2.3, 경우마다 워밍업 1회와 3회.',
        'QueuePool 5, 30초: 성공 50, 다 끝남 2.087~2.103초, 가장 오래 기다림 1.88~1.89초.',
        'QueuePool 10: 다 끝남 1.068~1.071초, 가장 오래 기다림 0.86초. QueuePool 50: 0.218~0.222초, 0.04ms 이하.',
        'QueuePool 5, 0.5초: 성공 15, 타임아웃 35(기다리기 시작하고 0.504~0.512초 뒤), 다 끝남 0.631~0.638초.',
        'NullPool: 성공 50, 다 끝남 0.291~0.318초, 연결을 얻기까지 약 19~76ms. 서버의 새 연결 50, 동시 최대 51.',
        '한 건씩 200번: 새로 연결 + SELECT 1 중앙값 9.25~9.63ms, 풀에서 빌리기 + SELECT 1 0.31~0.32ms(약 30배).',
        '서버가 센 새 연결과 동시 최대에는 관찰용 연결과 Docker 상태 검사 연결이 섞였다(풀 5는 새 연결 1, 동시 최대 7).',
      ],
      evidence: ['readmeProblem4', 'readmeBatch4', 'readmeInterpretPool', 'readmePoolRules', 'readmeObserved', 'readmeContainer', 'poolData', 'poolLab', 'sqlaPooling', 'docTooMany'],
      cards: ['04-028', '04-029', '04-030', '04-031', '04-032', '04-033'],
    },
  };

  const ELEMENTS = {
    session: {
      kind: '세션 (연결 하나)',
      concept: '실험의 연결 하나다. 순서표의 문장을 한 번에 하나씩 보내고, 앞 문장이 돌아와야 다음 문장을 보낸다. 연결은 자동 커밋으로 열고, START TRANSACTION과 COMMIT으로 트랜잭션을 열고 닫는다.',
      props: [
        '상자 안 글줄은 위에서부터 상태(다음 문장 전, 락 대기, 끝), 트랜잭션(트랜잭션 없음, 자동 커밋 문장, 트랜잭션 중), 마지막 결과나 오류다.',
        '락을 기다리는 동안 그 세션의 다음 줄은 미룬다. 앞 문장이 오류로 끝나도 다음 줄을 그대로 보낸다(오류를 확인하지 않는 앱).',
        '자동 커밋 문장은 끝나자마자 커밋하고 락을 놓는다. 트랜잭션 안의 락은 COMMIT이나 ROLLBACK까지 쥔다.',
      ],
      ev: ['readmeTimelineRules', 'lockLab', 'timelines', 'docErrorHandling'],
      cards: ['04-001', '04-015'],
    },
    request: {
      kind: '요청 (연결 하나)',
      concept: '동시 요청 장면의 요청 하나다. 스레드 하나와 연결 하나를 쓰고, 모든 요청이 같은 순간에 출발해 코드 칸의 SQL을 차례로 보낸다.',
      props: [
        'DB 오류(1213, 1205 등)를 받으면 ROLLBACK하고 실패로 끝나며 다시 하지 않는다. 낙관적 락 최종판만 version 확인이 0행이면 처음부터 다시 한다(최대 3번).',
        '상자의 끝 글자는 요청의 결과다: 지급, 이미 받음, 오류, 포기(0행으로 되돌린 뒤 더 다시 하지 않음), 차감 끝, 잔액 없이 커밋.',
        '모형은 한 단계에 요청마다 문장을 하나씩 요청 번호 순으로 보낸다. 실제로는 거의 같은 때 보내므로 누가 먼저 락을 얻는지는 실행마다 다를 수 있다.',
      ],
      ev: ['readmeBurstRules', 'burstLab', 'burstData', 'modelRules'],
      cards: ['04-012', '04-020'],
    },
    table: {
      kind: 'InnoDB 표',
      concept: 'InnoDB 표는 기본 키 순으로 정렬된 클러스터형 인덱스(PRIMARY)에 행 데이터를 담고, 보조 인덱스는 따로 정렬된 레코드를 둔다. 행 락은 행이 아니라 인덱스 레코드에 건다.',
      props: [
        '행 락을 걸기 전에 표에 의도 락(IX, IS)을 건다. 의도 락끼리는 부딪히지 않고, 표 전체를 잠그는 락과만 부딪힌다.',
        '이 화면은 표 상자 안에 인덱스마다 한 줄을 그린다. 위가 보조 인덱스, 아래가 PRIMARY다.',
      ],
      ev: ['docInnodbLocking', 'docIndexTypes', 'docDataLocks'],
      cards: ['04-002', '04-003'],
    },
    'index-primary': {
      kind: '클러스터형 인덱스 (PRIMARY)',
      concept: '기본 키 값 순으로 정렬된 인덱스이고, 레코드에 행 데이터 전체가 있다. 보조 인덱스로 찾은 행도 이 인덱스의 레코드를 함께 잠근다.',
      props: [
        '인덱스 레코드의 순서는 기본 키 값만 따진다. 조건에 쓸 보조 인덱스가 없으면 InnoDB는 이 인덱스를 처음부터 끝까지 훑는다.',
        '맨 끝의 supremum은 마지막 레코드 뒤에 있다고 치는 가상 레코드다. 그 락은 마지막 레코드 뒤 갭을 잠근다.',
        'data_locks의 LOCK_DATA는 기본 키 값이다(1, 2 …).',
      ],
      ev: ['docIndexTypes', 'docInnodbLocking', 'readmeProblem1_1', 'readmeProblem1_2'],
      cards: ['04-003', '04-008', '04-009'],
    },
    'index-secondary': {
      kind: '보조 인덱스',
      concept: '보조 키 값 뒤에 기본 키 값을 붙인 값 순으로 정렬된 인덱스다. idx_user의 레코드는 (user_id, id) 순이라 같은 user_id도 id로 순서가 정해진다.',
      props: [
        'data_locks의 LOCK_DATA는 보조 키 값과 기본 키 값이다(7, 2는 user_id 7, id 2인 인덱스 레코드).',
        '같은 행이라도 PRIMARY와 보조 인덱스에서 들어가는 갭이 다르다.',
        '보조 인덱스로 찾아 잠그면 보조 인덱스 레코드와 PRIMARY 레코드를 함께 잠근다.',
      ],
      ev: ['docIndexTypes', 'readmeProblem1', 'readmeBatch1', 'docDataLocks'],
      cards: ['04-002', '04-003', '04-004'],
    },
    'index-unique': {
      kind: '유니크 보조 인덱스',
      concept: '같은 키 값을 두 번 넣지 못하는 보조 인덱스다. 넣기 전에 같은 값의 레코드가 있는지 확인한다.',
      props: [
        '같은 값의 레코드가 있으면 InnoDB는 그 레코드에 공유 락(S)을 걸고 확인한다. 아직 커밋하지 않은 트랜잭션이 넣은 레코드면 그 트랜잭션이 끝날 때까지 기다린다.',
        '커밋된 같은 값이 있으면 오류 1062(중복 키)로 그 문장만 되돌린다. 트랜잭션과 확인에 쓴 공유 락은 남는다.',
        'rewards의 UNIQUE KEY idx_user_event (user_id, event_id)는 user 7이 event 1의 리워드를 두 번 받는 행을 DB가 막는다.',
      ],
      ev: ['docLocksSet', 'readmeProblem3', 'readmeBurst'],
      cards: ['04-021', '04-026', '04-027'],
    },
    'record-primary': {
      kind: '인덱스 레코드 (PRIMARY)',
      concept: 'PRIMARY의 레코드 하나가 행 하나다. 칸 위의 수가 기본 키 값이고, 칸 안 작은 상자가 그 행의 값이다.',
      props: [
        '레코드 락(X,REC_NOT_GAP)은 이 레코드만, 넥스트 키 락(X)은 이 레코드와 그 앞 갭을 잠근다.',
        'UPDATE와 DELETE, 잠그며 읽기는 찾은 레코드에 배타 락(X)을 걸고 트랜잭션이 끝날 때까지 쥔다. 기본 키 값 하나로 찾으면 레코드 락만 건다.',
        '점선 칸은 커밋하기 전에 넣은 레코드다. 넣은 쪽은 그 레코드를 락 구조 없이 잠근다(암묵적 락). 다른 트랜잭션이 그 레코드의 락을 청하면 그때 넣은 쪽의 X,REC_NOT_GAP으로 바꿔 적는다.',
      ],
      ev: ['docInnodbLocking', 'docLocksSet', 'docDataLocks'],
      cards: ['04-001', '04-002', '04-013'],
    },
    'record-secondary': {
      kind: '인덱스 레코드 (보조 인덱스)',
      concept: '보조 인덱스의 레코드 하나다. 칸 위 글자는 레코드 키(보조 키 값, 기본 키 값)이고 data_locks의 LOCK_DATA와 같다.',
      props: [
        '잠그며 읽기는 조건이 아니라 훑은 레코드마다 락을 건다. REPEATABLE READ에서 조건에 맞는 레코드는 넥스트 키 락, 끝을 확인하려고 읽은 다음 레코드는 갭 락을 받는다.',
        'READ COMMITTED에서는 갭을 잠그지 않고 조건에 맞는 레코드에 레코드 락만 건다.',
      ],
      ev: ['docInnodbLocking', 'docLocksSet', 'readmeBatch1'],
      cards: ['04-002', '04-004', '04-005', '04-007'],
    },
    gap: {
      kind: '갭',
      concept: '인덱스의 정렬 순서에서 이웃한 두 레코드 사이의 키 범위다. 레코드가 아니라 그 사이의 빈 범위이고, 새 레코드는 키 순서에 맞는 갭에 들어간다.',
      props: [
        '갭 락(X,GAP)과 넥스트 키 락의 갭 부분은 그 갭에 레코드를 넣지 못하게 한다. 이미 있는 레코드는 막지 않는다.',
        '갭을 잠그는 락끼리는 S든 X든 부딪히지 않는다. 여러 트랜잭션이 같은 갭을 함께 쥘 수 있다.',
        'INSERT는 넣기 전에 그 갭에 삽입 의도 락을 청하고, 다른 트랜잭션의 갭 락이 있으면 기다린다. 삽입 의도 락끼리는 같은 갭의 다른 자리라면 부딪히지 않는다.',
        '레코드가 들어오면 갭이 둘로 나뉘고, 새 레코드는 다음 레코드에 걸린 갭 쪽 락을 같은 주인의 갭 락으로 물려받는다.',
      ],
      ev: ['docInnodbLocking', 'readmeProblem1', 'readmeBatch1', 'modelRules'],
      cards: ['04-003', '04-005', '04-010'],
    },
    sup: {
      kind: 'supremum pseudo-record',
      concept: '인덱스의 마지막 레코드 뒤에 있다고 치는 가상 레코드다. 그 락은 레코드 없이 마지막 레코드 뒤 갭만 잠근다. 빈 표에서는 인덱스 전체가 이 갭 하나다.',
      props: [
        'data_locks에는 LOCK_DATA가 supremum pseudo-record이고, LOCK_MODE가 넥스트 키 락 꼴(X, S)로 보이지만 갭만 잠근다.',
        '여기에 삽입 의도 락을 청하면 LOCK_MODE가 GAP 없이 X,INSERT_INTENTION으로 보였다.',
        '갭 쪽 락끼리는 부딪히지 않아, 여러 트랜잭션이 같은 supremum의 X를 함께 쥘 수 있다. 그 뒤 둘 이상이 이 갭에 넣으려 하면 서로의 락을 기다린다.',
      ],
      ev: ['docInnodbLocking', 'docDataLocks', 'readmeBurst', 'readmeBatch1'],
      cards: ['04-002', '04-009', '04-011', '04-019'],
    },
    'pool-app': {
      kind: '앱 프로세스의 요청',
      concept: '웹 서버의 요청 50개다. 스레드 50개가 Barrier로 같은 순간에 출발해, 연결을 얻고 트랜잭션 안에서 SELECT 1 뒤 200ms를 쓰고 돌려준다.',
      props: [
        '연결 기다림은 connect()를 부른 때부터 연결을 받은 때까지다. 다 끝나는 시간은 가장 먼저 출발한 요청부터 가장 늦게 끝난 요청까지다.',
        '풀 타임아웃(sqlalchemy.exc.TimeoutError)으로 끝난 요청은 쿼리를 한 번도 보내지 못한다.',
      ],
      ev: ['readmePoolRules', 'poolLab', 'poolData'],
      cards: ['04-028', '04-029'],
    },
    'pool-queue': {
      kind: '커넥션 풀 (SQLAlchemy QueuePool)',
      concept: '미리 연 연결을 모아 두고 빌려주는 풀이다. 연결이 모두 쓰이는 중이면 요청은 돌아오는 연결을 기다린다.',
      props: [
        'pool_size는 풀이 유지하는 연결 수, max_overflow는 그보다 더 만들 수 있는 수(실험은 0), pool_timeout은 연결을 기다리는 최대 시간이다.',
        '연결을 쓰는 시간이 길수록(트랜잭션 안에서 외부 API를 기다리는 등) 다른 요청의 기다림이 늘어난다.',
        '이 맥에서 한 건씩 잴 때 풀에서 빌리기는 0.31~0.32ms(SELECT 1 포함), 새로 연결하기는 9.25~9.63ms였다.',
      ],
      ev: ['sqlaPooling', 'readmePoolRules', 'readmeBatch4'],
      cards: ['04-028', '04-029', '04-030', '04-033'],
    },
    'pool-null': {
      kind: 'NullPool (풀 없음)',
      concept: '연결을 모아 두지 않는 SQLAlchemy 풀 클래스다. 요청마다 새 연결을 열고, 돌려줄 때 끊는다.',
      props: [
        '새 연결은 TCP 연결, 핸드셰이크, 인증을 거친다. 이 맥에서 한 건씩 9.25~9.63ms로 풀에서 빌리기의 약 30배였다.',
        '연결 수에 앱 쪽 한도가 없어, 동시에 몰리면 MySQL의 max_connections(151)까지 연결이 늘 수 있다.',
      ],
      ev: ['sqlaPooling', 'readmeBatch4', 'readmeInterpretPool', 'docTooMany'],
      cards: ['04-030', '04-031', '04-032'],
    },
    'pool-db': {
      kind: 'MySQL 서버의 연결',
      concept: 'MySQL은 연결마다 서버 쪽 스레드와 세션을 둔다. 동시에 열 수 있는 연결 수는 max_connections(이 실험 151)까지다.',
      props: [
        '실험은 Connections 증가분(새로 연 연결 수)과 Max_used_connections(동시 최대)를 읽었다.',
        '측정값에는 관찰용 연결 1개가 늘 더해지고, Docker 상태 검사 연결이 섞인 실행도 있었다.',
      ],
      ev: ['readmeBatch4', 'readmeObserved', 'docTooMany'],
      cards: ['04-032'],
    },
  };

  // 복습 카드의 앞면(anki/04에서 옮김). 04-016의 데드락 보고 원문은 카드 문서에 있다.
  const CARDS = {
    '04-001': 'InnoDB의 공유 락(S)과 배타 락(X)은 무엇이 다르고, 서로 언제 부딪히는가? SELECT ... FOR SHARE, SELECT ... FOR UPDATE, UPDATE·DELETE, 평범한 SELECT는 각각 어떤 락을 거는가?',
    '04-002': 'performance_schema.data_locks의 LOCK_MODE가 X, X,REC_NOT_GAP, X,GAP, X,GAP,INSERT_INTENTION, X,INSERT_INTENTION이면 각각 어떤 락인가? LOCK_DATA가 supremum pseudo-record이거나 7, 2처럼 값이 둘이면 무엇을 잠근 것인가?',
    '04-003': 'entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. PRIMARY와 idx_user의 인덱스 레코드는 각각 어떤 순서로 놓이는가? 새 행 (10, 7), (11, 5), (13, 15)는 두 인덱스에서 각각 어느 갭에 들어가는가?',
    '04-004': 'entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 REPEATABLE READ에서 START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;(2, 3)를 하고 커밋하지 않았다. 이어서 B가 자동 커밋으로 다섯 문장 중 하나를 보내고, 경우마다 처음 행에서 따로 돌린다. (가) INSERT INTO entries VALUES (10, 7); (나) (11, 5) (다) (12, 10) (라) (13, 15) (마) (14, 1). 각각 A의 COMMIT까지 기다리는가, 바로 끝나는가? A가 쥔 락은?',
    '04-005': 'entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 REPEATABLE READ에서 START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;(2, 3)를 하고 커밋하지 않자, B(자동 커밋)의 INSERT INTO entries VALUES (10, 7);뿐 아니라 user_id가 7이 아닌 (11, 5)와 (12, 10)의 삽입도 A의 COMMIT까지 기다렸다. A의 잠금 읽기는 user_id 7인 행뿐 아니라 그 앞뒤 갭까지 잠근 것이다. 갭까지 잠그는 이유는 무엇이고, 그 대가는?',
    '04-006': 'entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 READ COMMITTED에서 START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;(2, 3)를 하고, B가 자동 커밋으로 INSERT INTO entries VALUES (10, 7);을 한 뒤, A가 같은 SELECT ... FOR UPDATE를 다시 하자 2, 3, 10이 나왔다. 새로 나타난 10은 어떤 현상이고, non-repeatable read와 무엇이 다른가? REPEATABLE READ에서는 무엇이 이것을 막는가?',
    '04-007': 'entries (id INT PRIMARY KEY, user_id INT NOT NULL, KEY idx_user (user_id))에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 READ COMMITTED에서 START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;를 하고 커밋하지 않았다. 이어서 B가 자동 커밋으로 다섯 문장 중 하나를 보내고, 경우마다 처음 행에서 따로 돌린다. (가) INSERT INTO entries VALUES (10, 7); (나) (11, 5) (다) (12, 10) (라) (13, 15) (마) (14, 1). 각각 기다리는가? A가 쥔 락은?',
    '04-008': 'entries (id INT PRIMARY KEY, user_id INT NOT NULL)(user_id 인덱스 없음)에 (id, user_id) = (1, 3), (2, 7), (3, 7), (4, 12)가 있다. A가 REPEATABLE READ에서 START TRANSACTION; SELECT id FROM entries WHERE user_id = 7 FOR UPDATE;를 하고 커밋하지 않았다. 이어서 B가 자동 커밋으로 세 문장 중 하나를 보내고, 경우마다 처음 행에서 따로 돌린다. (가) INSERT INTO entries VALUES (10, 7); (나) INSERT INTO entries VALUES (13, 15); (다) DELETE FROM entries WHERE id = 1;(user_id 3의 행). 각각 A의 COMMIT까지 기다리는가? A가 READ COMMITTED라면?',
    '04-009': 'entries (id INT PRIMARY KEY, user_id INT NOT NULL)(user_id 인덱스 없음)에 (id, user_id) = (1, 7), (2, 7), (3, 8)이 있다. A와 B 모두 SERIALIZABLE이다. A가 START TRANSACTION; 뒤 평범한 SELECT id FROM entries WHERE user_id = 7 ORDER BY id;만 하고 커밋하기 전에, B가 START TRANSACTION; INSERT INTO entries (id, user_id) VALUES (4, 7); COMMIT;을 했다. B의 INSERT는 A의 COMMIT까지 기다렸다. A가 쥔 락을 data_locks 꼴(인덱스, LOCK_MODE, LOCK_DATA)로 적고, B를 막은 락은 그중 어느 것인지 말하라.',
    '04-010': '삽입 의도 락(insert intention lock)은 무엇이고, 무엇과 부딪히는가? 두 트랜잭션이 같은 갭의 서로 다른 자리에 행을 넣으면 서로 기다리는가?',
    '04-011': '빈 표 rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))가 있다. A가 REPEATABLE READ에서 START TRANSACTION; SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 FOR UPDATE;를 하고 커밋하지 않았다. 이어서 B가 같은 두 문장을 보내면 기다리는가? 두 트랜잭션이 쥔 락은?',
    '04-012': 'points (user_id INT PRIMARY KEY, balance INT NOT NULL)에 (7, 1000)이 있다. 요청 10개가 같은 순간에 연결 하나씩으로 START TRANSACTION; → SELECT balance FROM points WHERE user_id = 7; → 앱이 읽은 값 - 100을 계산(50ms) → UPDATE points SET balance = <계산한 값> WHERE user_id = 7; → COMMIT;을 한다. 오류가 나면 그 요청은 실패로 끝나고 다시 하지 않는다. 데드락 탐지 켬, 락 대기 한도 5초이고, 다 반영되면 잔액은 0이다. READ COMMITTED, REPEATABLE READ, SERIALIZABLE에서 1213(데드락)을 받는 요청 수와 끝난 뒤 잔액은?',
    '04-013': 'accounts (id INT PRIMARY KEY, balance INT NOT NULL)에 (1, 1000), (2, 1000)이 있다. REPEATABLE READ, 데드락 탐지 켬(기본값), 락 대기 한도 5초. A(1번 계좌 → 2번으로 100)가 START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1;, B(2번 → 1번으로 100)가 START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 2;, A가 UPDATE accounts SET balance = balance + 100 WHERE id = 2;, 2초 뒤 B가 UPDATE accounts SET balance = balance + 100 WHERE id = 1;을 보내고, 이어서 A COMMIT;, B COMMIT;이다. 오류가 나도 다음 문장을 그대로 보낸다(오류를 확인하지 않는 앱). A의 셋째 문장과 B의 넷째 문장은 어떻게 끝나고, 잔액은?',
    '04-014': 'accounts (id INT PRIMARY KEY, balance INT NOT NULL)에 (1, 1000), (2, 1000)이 있다. REPEATABLE READ, 데드락 탐지 끔(innodb_deadlock_detect=OFF), 락 대기 한도(innodb_lock_wait_timeout) 5초. A(1번 계좌 → 2번으로 100)가 START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1;, B(2번 → 1번으로 100)가 START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 2;, A가 UPDATE accounts SET balance = balance + 100 WHERE id = 2;, 2초 뒤 B가 UPDATE accounts SET balance = balance + 100 WHERE id = 1;을 보내고, 이어서 A COMMIT;, B COMMIT;이다. 오류가 나도 다음 문장을 그대로 보낸다(오류를 확인하지 않는 앱). A의 셋째 문장과 B의 넷째 문장은 어떻게 끝나고, 잔액은?',
    '04-015': 'InnoDB에서 데드락을 끝내는 두 방법, 데드락 탐지(innodb_deadlock_detect=ON)와 락 대기 시간 초과(innodb_lock_wait_timeout)는 무엇이 다르고, 각각 무엇을 되돌리는가? 앱은 각각 어떻게 대응하는가?',
    '04-016': 'accounts (id INT PRIMARY KEY, balance INT NOT NULL)에 (1, 1000), (2, 1000)이 있다. REPEATABLE READ, 데드락 탐지 켬. A(1번 → 2번으로 100)가 START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1;, B(2번 → 1번으로 100)가 START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 2;, A가 UPDATE accounts SET balance = balance + 100 WHERE id = 2;, 2초 뒤 B가 UPDATE accounts SET balance = balance + 100 WHERE id = 1;을 보내 데드락이 났다. SHOW ENGINE INNODB STATUS의 LATEST DETECTED DEADLOCK을 줄인 보고(카드 문서에 있음)에서 (1)과 (2)는 A와 B 중 누구인가? 데드락의 네 조건(상호 배제, 점유 대기, 비선점, 순환 대기)은 각각 어디에 보이는가? 80000001은 무엇인가?',
    '04-017': 'accounts (id INT PRIMARY KEY, balance INT NOT NULL)에 (1, 1000), (2, 1000)이 있다. REPEATABLE READ, 락 대기 한도 5초. A(1번 → 2번으로 100)와 B(2번 → 1번으로 100)가 둘 다 작은 id부터 고친다. A START TRANSACTION; UPDATE accounts SET balance = balance - 100 WHERE id = 1; → B START TRANSACTION; UPDATE accounts SET balance = balance + 100 WHERE id = 1; → A UPDATE accounts SET balance = balance + 100 WHERE id = 2; → B UPDATE accounts SET balance = balance - 100 WHERE id = 2; → A COMMIT; → B COMMIT;. B가 id 2부터 고치던 판에서는 데드락이 났다. 이 순서는 어떻게 끝나는가? 데드락 탐지를 켜고 끄는 것이 결과를 바꾸는가?',
    '04-018': '격리 수준을 올리면 데드락이 줄어드는가? InnoDB에서 데드락을 줄이는 방법은?',
    '04-019': '빈 표 rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))가 있다. REPEATABLE READ, 데드락 탐지 켬. A가 START TRANSACTION; SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 FOR UPDATE;(0), B가 같은 두 문장(0), A가 INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000);, B가 같은 INSERT, A COMMIT;, B COMMIT;을 차례로 보낸다. 어떻게 끝나는가? 다음 이체 데드락과 같은 점·다른 점은? accounts (id INT PRIMARY KEY, balance INT NOT NULL) (1, 1000), (2, 1000)에서 A가 UPDATE accounts SET balance = balance - 100 WHERE id = 1;, B가 UPDATE accounts SET balance = balance - 100 WHERE id = 2;, A가 UPDATE accounts SET balance = balance + 100 WHERE id = 2;, B가 UPDATE accounts SET balance = balance + 100 WHERE id = 1;을 보내 B가 1213을 받았고, B도 id 1부터 고치게 바꾸자(락 순서 고정) 데드락이 없어졌다. 락 순서 고정으로 rewards의 데드락도 막을 수 있는가?',
    '04-020': 'points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)에 (7, 0, 0)이 있고, rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))는 비어 있다. REPEATABLE READ에서 user 7의 같은 리워드 요청 10건이 같은 순간에 온다. 요청마다 START TRANSACTION; → SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;(0이 아니면 ROLLBACK, 이미 받음) → 50ms → INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); → UPDATE points SET balance = balance + 1000 WHERE user_id = 7; → COMMIT;. 끝난 뒤 rewards 행 수, 잔액, 오류는?',
    '04-021': 'points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)에 (7, 0, 0)이 있고, rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))는 비어 있다. REPEATABLE READ에서 같은 요청 10건이 동시에 START TRANSACTION; → SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1 FOR UPDATE;(0이 아니면 ROLLBACK) → 50ms → INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); → UPDATE points SET balance = balance + 1000 WHERE user_id = 7; → COMMIT;을 한다(비관적 락의 첫 판). 10건의 결과는? 표를 UNIQUE KEY idx_user_event (user_id, event_id)로 바꾸면?',
    '04-022': 'points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)에 (7, 0, 0)이 있고, rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))는 비어 있다. REPEATABLE READ에서 같은 리워드 요청 10건이 동시에 오고, 요청마다 START TRANSACTION; → SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;(0이 아니면 ROLLBACK, 이미 받음) → 50ms → INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); → UPDATE points SET balance = balance + 1000 WHERE user_id = 7; → COMMIT;이다. 이 COUNT를 SELECT COUNT(*) ... FOR UPDATE로 바꾼 첫 판은 10건이 아직 없는 범위의 갭 락을 함께 쥐어 9건이 1213을 받았다. 10건을 데드락 없이 줄 세우려면 무엇을 잠가야 하는가? 그렇게 고친 요청과 10건의 결과는?',
    '04-023': 'points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)에 (7, 0, 0)이 있고, rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))는 비어 있다. REPEATABLE READ에서 같은 요청 10건이 동시에 START TRANSACTION; → SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1; → SELECT balance FROM points WHERE user_id = 7 FOR UPDATE; → (COUNT가 0이 아니면 ROLLBACK) → 50ms → INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); → UPDATE points SET balance = balance + 1000 WHERE user_id = 7; → COMMIT;을 한다. 10건의 결과는? 잠근 뒤 평범한 COUNT를 한 번 더 하면?',
    '04-024': 'points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)에 (7, 0, 0)이 있고, rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))는 비어 있다. REPEATABLE READ에서 같은 요청 10건이 동시에 온다. (가) 요청이 START TRANSACTION; → SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;(0이 아니면 ROLLBACK) → 50ms → INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); → UPDATE points SET balance = balance + 1000 WHERE user_id = 7 AND version = 0; → COMMIT;(0행이어도 커밋)이면? (나) 잔액 UPDATE가 0행이면 ROLLBACK하고, 1행이면 UPDATE points SET version = version + 1 WHERE user_id = 7; 뒤 COMMIT하면? (다) (나)에서 points의 처음 version이 3이면?',
    '04-025': 'points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)에 (7, 0, 0)이 있고, rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))는 비어 있다. REPEATABLE READ에서 같은 리워드 요청 10건이 동시에 오고, 지금 요청은 START TRANSACTION; → SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;(0이 아니면 ROLLBACK, 이미 받음) → 50ms → INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); → UPDATE points SET balance = balance + 1000 WHERE user_id = 7; → COMMIT;이다(10건 모두 지급해 10행, 10000). 이 요청을 version으로 중복 지급을 막는 낙관적 락으로 고쳐 적고, 10건의 결과를 말하라. version 확인이 0행일 때 처음부터 다시 하는 이유는? 확인을 SELECT가 아니라 UPDATE에서 하는 이유는?',
    '04-026': 'points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)에 (7, 0, 0)이 있고, rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, UNIQUE KEY idx_user_event (user_id, event_id))는 비어 있다. REPEATABLE READ에서 같은 요청 10건이 동시에 START TRANSACTION; → SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;(0이 아니면 ROLLBACK, 이미 받음) → 50ms → INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); → UPDATE points SET balance = balance + 1000 WHERE user_id = 7; → COMMIT;을 하고, INSERT가 1062면 ROLLBACK하고 "이미 받음"으로 끝낸다. 10건의 결과는? 2~10번째 INSERT는 어떻게 1062를 받는가?',
    '04-027': 'points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)에 (7, 0, 0)이 있고, rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, KEY idx_user_event (user_id, event_id))는 비어 있다. REPEATABLE READ에서 user 7의 같은 리워드 요청 10건이 동시에 오고, 막지 않은 요청은 START TRANSACTION; → SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1;(0이 아니면 ROLLBACK, 이미 받음) → 50ms → INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000); → UPDATE points SET balance = balance + 1000 WHERE user_id = 7; → COMMIT;이다(10건 모두 지급해 10행, 10000). 중복 지급을 막은 세 방법의 맥 측정 결과(카드 문서의 표)를 보고, 세 방법은 각각 무엇을 대가로 막고 언제 무엇을 고르는가?',
    '04-028': '웹 서버가 SQLAlchemy QueuePool(max_overflow=0, 연결은 미리 다 만듦)로 MySQL에 붙어 있다. 요청 50개가 같은 순간에 오고, 요청마다 풀에서 연결을 빌려 트랜잭션 안에서 SELECT 1 뒤 200ms를 쓰고 커밋한 뒤 돌려준다. pool_size가 5, 10, 50일 때 50건이 다 끝나는 시간과, 가장 오래 기다린 요청이 연결을 받기까지 기다린 시간은?',
    '04-029': 'SQLAlchemy QueuePool(pool_size=5, max_overflow=0, 연결은 미리 다 만듦)에 요청 50개가 같은 순간에 오고, 요청마다 트랜잭션 안에서 200ms를 쓴다. pool_timeout이 0.5초면 몇 건이 성공하고 몇 건이 실패하는가? 왜?',
    '04-030': '한 건씩 차례로 할 때, 요청마다 MySQL에 새로 연결해 SELECT 1을 하는 시간과 미리 연 풀에서 연결을 빌려 SELECT 1을 하는 시간은 얼마나 다른가? 새 연결은 무엇에 시간을 쓰는가?',
    '04-031': '요청 50개가 같은 순간에 오고, 요청마다 트랜잭션 안에서 200ms를 쓴다. 미리 연 연결 5개짜리 풀(SQLAlchemy QueuePool, pool_size=5, max_overflow=0)과, 풀 없이 요청마다 새로 연결하고 끝나면 끊는 NullPool 중 어느 쪽이 먼저 끝나는가? 한 건씩 잴 때 새로 연결하기는 풀에서 빌리기보다 약 30배 느렸는데 왜 그런가?',
    '04-032': '요청 50개가 동시에 오고 요청마다 트랜잭션 안에서 200ms를 쓸 때, 풀 없이 요청마다 새로 연결한 쪽(0.29~0.32초)이 풀 5(2.09~2.10초)보다 빨랐다. 그런데도 커넥션 풀을 쓰는 이유를 잰 숫자로 말하라. MySQL의 max_connections는 151, 한 건씩 잴 때 새로 연결하기는 9.25~9.63ms, 풀에서 빌리기는 0.31~0.32ms였다.',
    '04-033': '커넥션 풀 크기는 어떻게 정하는가? 요청마다 트랜잭션 안에서 외부 API 응답을 200ms 기다리는 서비스에서, 풀을 키우는 것 말고 연결 기다림을 줄이는 방법은?',
  };

  root.LockContent = { EV, TYPE_LABEL, SCENES, ELEMENTS, CARDS };
})(typeof self !== 'undefined' ? self : this);
