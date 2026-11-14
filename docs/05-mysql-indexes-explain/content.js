/*
 * 요소 설명·장면 안내·근거 링크. 실행 상태는 model.js가 만들고 여기서는 고정된 설명만 둔다.
 * 근거 종류: measured(실측 기록), source(소스·공식 문서), record(실험 문답 기록), model(설명용 가정).
 * 장면의 "먼저 생각해 볼 질문"은 실험 README의 문제 상황을 표, 데이터, 쿼리, 경우, 물은 것까지 처음 낸 그대로 다시 적는다. 답은 적지 않는다.
 * 실험에서 잰 값(measured)은 실험 README의 결과 표에서 옮겼고, model.test.cjs가 원자료(JSONL)로 다시 셈해 견준다.
 */
(function (root) {
  'use strict';

  // 근거 파일은 GitHub의 main 브랜치 판을 연다. 화면을 Pages에서 열든 내려받은 폴더에서 열든 같은 곳으로 간다.
  const REPO = 'https://github.com/joowankim/cs-lab/blob/main/';
  const EXP = `${REPO}experiments/05-mysql-indexes-explain/`;
  const README = `${EXP}README.md`;
  const ANKI = `${REPO}anki/05-mysql-indexes-explain.md`;
  const EXP04 = `${REPO}experiments/04-mysql-locks-deadlocks-pool/README.md`;
  const MYSQL = 'https://dev.mysql.com/doc/refman/8.4/en/';

  const EV = {
    readmeProblem1: { type: 'record', label: '실험 README · 문제 상황 1: 느려진 "내 최근 주문" 화면', href: `${README}#문제-상황-1-느려진-내-최근-주문-화면-2026-11-09` },
    readmeProblem1_1: { type: 'record', label: '실험 README · 문제 상황 1-1: 주문이 아주 많은 고객의 "내 최근 주문"', href: `${README}#문제-상황-1-1-주문이-아주-많은-고객의-내-최근-주문-2026-11-10` },
    readmeProblem1_2: { type: 'record', label: '실험 README · 문제 상황 1-2: 100만 행의 클러스터형 인덱스는 몇 층일까', href: `${README}#문제-상황-1-2-100만-행의-클러스터형-인덱스는-몇-층일까-2026-11-10` },
    readmeProblem1_3: { type: 'record', label: '실험 README · 문제 상황 1-3: 인덱스를 만들었는데도 느린 쿼리', href: `${README}#문제-상황-1-3-인덱스를-만들었는데도-느린-쿼리-2026-11-10` },
    readmeProblem2: { type: 'record', label: '실험 README · 문제 상황 2: 최신순 주문 목록 20개', href: `${README}#문제-상황-2-최신순-주문-목록-20개-2026-11-11` },
    readmeProblem2_1: { type: 'record', label: '실험 README · 문제 상황 2-1: 5,001번째 목록 페이지, OFFSET과 커서', href: `${README}#문제-상황-2-1-5001번째-목록-페이지-offset과-커서-2026-11-11` },
    readmeProblem3: { type: 'record', label: '실험 README · 문제 상황 3: 쓰기 비용, ③④를 숫자 표 하나로', href: `${README}#문제-상황-3-쓰기-비용-를-숫자-표-하나로-2026-11-11` },
    readmeProblem3_1: { type: 'record', label: '실험 README · 문제 상황 3-1: 버퍼 풀이 표보다 작을 때', href: `${README}#문제-상황-3-1-버퍼-풀이-표보다-작을-때-2026-11-11` },
    readmeVariant04: { type: 'record', label: '실험 README · 04 변형: 인덱스와 락 범위, 일관된 읽기와 잠금 읽기 (컨테이너 확인)', href: `${README}#04-변형-인덱스와-락-범위-일관된-읽기와-잠금-읽기` },
    readmeQ6: { type: 'record', label: '실험 README · 질문 6: 복합 인덱스의 칼럼 순서 (WHERE 조건 순서의 컨테이너 확인)', href: `${README}#질문-6-복합-인덱스의-칼럼-순서` },
    readmeQ8: { type: 'record', label: '실험 README · 질문 8: 인덱스가 있어도 쓰이지 않는 경우', href: `${README}#질문-8-인덱스가-있어도-쓰이지-않는-경우` },
    readmeQ10: { type: 'record', label: '실험 README · 질문 10: 정렬 생략, OFFSET과 커서', href: `${README}#질문-10-정렬-생략-offset과-커서` },
    readmeQ11: { type: 'record', label: '실험 README · 질문 11: UUID 기본 키', href: `${README}#질문-11-uuid-기본-키` },
    readmeGoal1: { type: 'record', label: '실험 README · 목표 1 확인: 처음 보는 쿼리 3개 (BETWEEN 쿼리의 컨테이너 확인)', href: `${README}#목표-1-확인-처음-보는-쿼리-3개` },
    readmeQueryRules: { type: 'record', label: '실험 README · 조회 측정 규칙 (Handler_read_*, 논리적 읽기, 시간)', href: `${README}#조회-측정-규칙` },
    readmeWriteRules: { type: 'record', label: '실험 README · 쓰기 측정 규칙 (넣는 시간, 페이지 분할, 버퍼 풀)', href: `${README}#쓰기-측정-규칙` },
    readmeEnv: { type: 'measured', label: '실험 README · 측정 환경과 원자료 (Apple M2 Pro, Docker Desktop, MySQL 8.4.13)', href: `${README}#측정-환경과-원자료-2026-11-12` },
    readmeBatch1: { type: 'measured', label: '실험 README · 묶음 ① 결과: 같은 조회, 다른 인덱스 (조건마다 3회)', href: `${README}#묶음--같은-조회-다른-인덱스-조건마다-3회` },
    readmeBatch2: { type: 'measured', label: '실험 README · 묶음 ② 결과: 최신순 목록과 페이지네이션 (조건마다 3회)', href: `${README}#묶음--최신순-목록과-페이지네이션-조건마다-3회` },
    readmeBatch34: { type: 'measured', label: '실험 README · 묶음 ③④ 결과: 쓰기 비용 (조건마다 3회)', href: `${README}#묶음--쓰기-비용-조건마다-3회` },
    readmeObserved: { type: 'measured', label: '실험 README · 측정하며 본 것', href: `${README}#측정하며-본-것` },
    exp04NoIndex: { type: 'record', label: '04 실험 README · 문제 상황 1-1: 인덱스가 없을 때', href: `${EXP04}#문제-상황-1-1-인덱스가-없을-때-2026-11-03` },
    indexCases: { type: 'source', label: 'python/index_cases.py (조건과 쿼리)', href: `${EXP}python/index_cases.py` },
    indexLab: { type: 'source', label: 'python/index_lab.py (EXPLAIN, EXPLAIN ANALYZE, Handler_read_*, 논리적 읽기)', href: `${EXP}python/index_lab.py` },
    writeLab: { type: 'source', label: 'python/write_lab.py (③④ 넣기, 페이지 분할 카운터)', href: `${EXP}python/write_lab.py` },
    indexData: { type: 'measured', label: '원자료 · 묶음 ①② 조회', href: `${EXP}results/2026-11-12T065847399314-index-python-3.14.2.jsonl` },
    writeData: { type: 'measured', label: '원자료 · ③과 ④ 버퍼 풀 1GB', href: `${EXP}results/2026-11-12T070016205934-write-python-3.14.2.jsonl` },
    writeData128: { type: 'measured', label: '원자료 · ④ 버퍼 풀 128MB', href: `${EXP}results/2026-11-12T070448294044-write-python-3.14.2.jsonl` },
    docPhysical: { type: 'source', label: 'MySQL 8.4 문서 · The Physical Structure of an InnoDB Index', href: `${MYSQL}innodb-physical-structure.html` },
    docIndexTypes: { type: 'source', label: 'MySQL 8.4 문서 · Clustered and Secondary Indexes', href: `${MYSQL}innodb-index-types.html` },
    docMultiCol: { type: 'source', label: 'MySQL 8.4 문서 · Multiple-Column Indexes', href: `${MYSQL}multiple-column-indexes.html` },
    docColumnIndexes: { type: 'source', label: 'MySQL 8.4 문서 · Column Indexes (앞부분 길이 인덱스)', href: `${MYSQL}column-indexes.html` },
    docBtreeHash: { type: 'source', label: 'MySQL 8.4 문서 · Comparison of B-Tree and Hash Indexes (LIKE)', href: `${MYSQL}index-btree-hash.html` },
    docTypeConv: { type: 'source', label: 'MySQL 8.4 문서 · Type Conversion in Expression Evaluation', href: `${MYSQL}type-conversion.html` },
    docCreateIndex: { type: 'source', label: 'MySQL 8.4 문서 · CREATE INDEX (함수 인덱스)', href: `${MYSQL}create-index.html` },
    docExplain: { type: 'source', label: 'MySQL 8.4 문서 · EXPLAIN Output Format (type, rows, Extra)', href: `${MYSQL}explain-output.html` },
    docRange: { type: 'source', label: 'MySQL 8.4 문서 · Range Optimization', href: `${MYSQL}range-optimization.html` },
    docIcp: { type: 'source', label: 'MySQL 8.4 문서 · Index Condition Pushdown Optimization', href: `${MYSQL}index-condition-pushdown-optimization.html` },
    docOrderBy: { type: 'source', label: 'MySQL 8.4 문서 · ORDER BY Optimization', href: `${MYSQL}order-by-optimization.html` },
    docLimit: { type: 'source', label: 'MySQL 8.4 문서 · LIMIT Query Optimization', href: `${MYSQL}limit-optimization.html` },
    docStatus: { type: 'source', label: 'MySQL 8.4 문서 · Server Status Variables (Handler_read_*)', href: `${MYSQL}server-status-variables.html` },
    docBufferPool: { type: 'source', label: 'MySQL 8.4 문서 · Buffer Pool (LRU, 더티 페이지)', href: `${MYSQL}innodb-buffer-pool.html` },
    docMetrics: { type: 'source', label: 'MySQL 8.4 문서 · InnoDB INFORMATION_SCHEMA Metrics Table (index_page_splits)', href: `${MYSQL}innodb-information-schema-metrics-table.html` },
    docLocksSet: { type: 'source', label: 'MySQL 8.4 문서 · Locks Set by Different SQL Statements in InnoDB', href: `${MYSQL}innodb-locks-set.html` },
    docLocking: { type: 'source', label: 'MySQL 8.4 문서 · InnoDB Locking (레코드·갭·넥스트 키 락)', href: `${MYSQL}innodb-locking.html` },
    docConsistentRead: { type: 'source', label: 'MySQL 8.4 문서 · Consistent Nonlocking Reads', href: `${MYSQL}innodb-consistent-read.html` },
    docLockingReads: { type: 'source', label: 'MySQL 8.4 문서 · Locking Reads (FOR SHARE, FOR UPDATE)', href: `${MYSQL}innodb-locking-reads.html` },
    modelRules: { type: 'model', label: '화면 README · 모형의 가정 (작은 표, 찾기 규칙, 분할, 버퍼 풀)', href: `${REPO}docs/05-mysql-indexes-explain/README.md#모형의-가정` },
    anki: { type: 'record', label: '복습 카드 (anki/05-mysql-indexes-explain.md)', href: ANKI },
  };

  const TYPE_LABEL = { measured: '실측 기록', source: '소스·공식 문서', record: '실험 기록', model: '설명용 가정' };

  // 문제 상황의 표와 데이터. 질문마다 처음 낸 그대로 다시 적는다.
  const ORDERS = 'orders (id BIGINT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, status VARCHAR(10) NOT NULL, amount INT NOT NULL, phone VARCHAR(20) NOT NULL, memo TEXT NOT NULL, created_at DATETIME NOT NULL)';
  const DATA = '100만 행이 시간 순서대로 들어 있다(id 1이 가장 오래됨). created_at은 2025-11-10 ~ 2026-11-09에 고르게, user_id 1은 기업 고객이라 5만 건, 나머지 95만 건은 user_id 2 ~ 100,000에 고르게(평균 9.5건) 있다. status는 paid 90%, cancelled 7%, refunded 3%다. 버퍼 풀은 1GB이고 표 전체가 메모리에 올라간 상태다.';
  const Q1 = "SELECT created_at, amount FROM orders WHERE user_id = 4242 AND created_at >= '2026-08-10';";
  const MEASURED_ENV = '실험: Apple M2 Pro의 Docker Desktop, MySQL 8.4.13, 100만 행, 버퍼 풀 1GB에 표 전체가 올라간 상태(2026-11-12). 쿼리마다 워밍업 1회와 3회를 돌렸다. 시간은 EXPLAIN ANALYZE의 서버 안 시간(세 번의 최솟값~최댓값), 논리적 읽기는 세 번의 중앙값이다. Handler_read_*는 세 번 모두 같았고 물리적 읽기는 모든 쿼리에서 0이었다.';
  const WRITE_ENV = '실험: 같은 맥(2026-11-12). 조건마다 워밍업 1회와 3회를 돌렸고, 넣는 시간은 세 번의 중앙값과 범위다. 카운터는 넣는 구간의 증가분이다.';

  const SCENES = {
    find: {
      questions: [
        `표 ${ORDERS}에 ${DATA} 쿼리 ${Q1}("최근 3개월 내 주문")를 PRIMARY 말고는 인덱스 하나만 두고 (가) 없음 (나) CREATE INDEX idx_user ON orders (user_id); (다) user_id 앞 복합 (라) created_at 앞 복합 (마) 이 쿼리가 클러스터형 인덱스를 다시 읽지 않고 끝나게 하는 인덱스로 돌린다. 경우마다 읽는 행 수의 크기와 걸린 시간의 크기는?`,
        "같은 표·데이터·버퍼 풀에서 SELECT created_at, amount FROM orders WHERE user_id = 1 AND created_at >= '2026-08-10';(user_id 1은 5만 건, 1년에 고르게)를 (가) 없음 (나) (user_id) (다) (user_id, created_at) (마) (user_id, created_at, amount)로 돌린다. 경우마다 읽는 행(항목) 수의 크기(1·10·100·1천·1만·10만·100만)와 걸린 시간의 크기(1ms 안쪽 / 1~10ms / 10~100ms / 100ms~1초 / 1초 이상)는? 이유는?",
        '페이지는 16KB이고 항목을 담는 공간은 약 15KB(15,360바이트)다. 리프 항목은 행 전체로 머리말까지 약 100바이트, 루트·중간 항목은 키 id 8 + 자식 페이지 번호 4 + 항목 머리말 5 = 약 17바이트다. 루트는 한 장이고, 루트가 가리킬 수 있는 수보다 리프가 많으면 중간 층이 생긴다. (1) 리프 한 장의 행 수와 100만 행의 리프 수 (2) 루트·중간 한 장이 가리킬 수 있는 자식 수 (3) 층 수(100만 행, 1억 행) (4) 1-1의 "항목 하나에 약 4번"을 층 수로 설명하면?',
      ],
      observe: [
        '단계 1에서 보조 인덱스를 루트, 중간, 리프 순서로 한 장씩 내려가는 길(파란 포인터와 굵은 곡선)을 본다. 보조 인덱스가 없으면 PRIMARY의 맨 앞 리프로 내려가 모든 행을 차례로 읽는다.',
        '(나)에서는 보조 인덱스 항목을 하나 읽을 때마다 PRIMARY를 루트부터 다시 찾는 단계(두 번 읽기)가 붙는다. 페이지 위 읽은 횟수와 단계 띠의 논리적 읽기가 어떻게 느는지 본다.',
        '(다)는 created_at 조건을 인덱스 항목에서 확인하고, (마)는 필요한 칼럼이 항목에 다 있어 PRIMARY로 가지 않는다. 같은 고객으로 (나)(다)(마)의 논리적 읽기를 견준다.',
        '고객을 1로 바꾸면 항목이 두 리프에 걸친다. 리프 끝에서 루트로 돌아가지 않고 옆 리프로 넘어가는 단계를 본다.',
        '작은 표는 리프 한 장에 항목 4개, 위층 한 장에 포인터 2개라 행 16개로 3층이다. 실제 리프 한 장에는 행 약 159개(PRIMARY)나 항목 약 928개(idx_user)가 들어간다.',
      ],
      measured: [
        MEASURED_ENV,
        '문제 상황 1(고객 4242, 5건 중 2026-08-10 이후 1건): (가) 없음 ALL, Using where, first 1 · key 1 · rnd_next 1,000,001, 143~154ms, 논리적 읽기 7,473. (나) (user_id) ref, Using where, key 1 · next 5, 0.006~0.008ms, 30. (다) (user_id, created_at) range, Using index condition, key 1 · next 1, 0.003~0.005ms, 13.',
        '문제 상황 1-1(고객 1, 5만 건 중 2026-08-10 이후 12,656건): (가) ALL, 144~151ms, 7,473. (나) ref, key 1 · next 50,000, 35.2~36.0ms, 200,073. (다) range, Using index condition, key 1 · next 12,656, 9.90~10.2ms, 50,661. (마) (user_id, created_at, amount) range, Using where; Using index, key 1 · next 12,656, 2.37~2.39ms, 54.',
        'EXPLAIN의 추정 rows: 문제 상황 1은 (가) 993,352, (나) 5, (다) 1. 1-1은 (가) 990,201, (나) 104,988, (다) 23,388, (마) 23,648.',
        '고객 4242를 (user_id, created_at, amount)로 읽은 판은 컨테이너 확인(판정용 아님)만 했다: Using where; Using index, 0.007~0.008ms.',
        '문제 상황 1-2: PRIMARY 리프 6,303페이지(할당 6,313), idx_user 리프 1,078페이지(할당 1,251). 컨테이너 확인(판정용 아님)에서 페이지 파일을 읽어 보니 PRIMARY는 루트 1장, 중간 8장(꽉 찬 장의 포인터 928개), 리프 6,303장(한 장 평균 158.7행)의 3층이었다.',
      ],
      evidence: ['readmeProblem1', 'readmeProblem1_1', 'readmeProblem1_2', 'readmeBatch1', 'readmeQueryRules', 'readmeEnv', 'indexData', 'indexCases', 'indexLab', 'docPhysical', 'docIndexTypes', 'docExplain', 'docIcp', 'docStatus'],
      cards: ['05-001', '05-002', '05-003', '05-004', '05-005', '05-006', '05-007', '05-008', '05-009', '05-017', '05-018'],
    },
    order: {
      questions: [
        `표 ${ORDERS}에 ${DATA} 쿼리 ${Q1}를 PRIMARY 말고는 인덱스 하나만 두고 (다) user_id 앞 복합 (user_id, created_at)와 (라) created_at 앞 복합 (created_at, user_id)로 돌린다. 경우마다 읽는 행 수의 크기와 걸린 시간의 크기는?`,
        '(라)의 리프 순서로 4242의 최근 주문을 찾으려면 어디부터 어디까지 읽어야 할까? 두 인덱스의 리프에서 4242의 2026-08-10 이후 항목은 어떻게 놓일까?',
        "WHERE 조건의 순서만 바꿔 WHERE created_at >= '2026-08-10' AND user_id = 4242로 쓰면 읽는 수나 고를 인덱스가 달라질까?",
      ],
      observe: [
        '두 인덱스의 리프에서 항목이 줄 선 순서를 견준다. (user_id, created_at)는 같은 고객의 항목이 한데 모이고, (created_at, user_id)는 날짜 순이라 고객 42의 항목이 흩어진다.',
        '(라)는 옵티마이저가 인덱스를 쓰지 않고 표 전체를 읽는다. "(라)에 FORCE INDEX"로 바꾸면 08-10 이후 항목을 끝까지 읽으며 user_id를 인덱스 안에서 거르는(Using index condition) 단계를 본다.',
        'WHERE 조건의 순서를 바꿔도 계획과 단계가 같은지 본다.',
      ],
      measured: [
        MEASURED_ENV,
        '(다) (user_id, created_at): range, Using index condition, 추정 rows 1, key 1 · next 1, 0.003~0.005ms, 논리적 읽기 13. 사람이 쓴 (마) idx_user_id_created_at (user_id, created_at)도 같은 계획이었다(0.003~0.004ms, 13).',
        '(라) (created_at, user_id): 옵티마이저가 ALL을 골랐다. 추정 rows 996,189, first 1 · key 1 · rnd_next 1,000,001, 142~149ms, 논리적 읽기 7,490.',
        '같은 두 칼럼을 담은 복합 인덱스 셋은 칼럼 순서와 상관없이 크기가 같았다: 리프 1,386페이지, 할당 1,636페이지.',
        '컨테이너 확인(판정용 아님): (라)를 FORCE INDEX (idx_created_user)로 쓰게 하면 15.0~15.9ms였다. 옵티마이저는 그 범위를 rows 458,872(실제 251,352)로 추정했다. WHERE 조건의 순서만 바꾼 두 쿼리는 계획이 같았다((user_id, created_at)에서 둘 다 range · rows 1 · Using index condition, (created_at, user_id)에서 둘 다 ALL · rows 989,886).',
      ],
      evidence: ['readmeProblem1', 'readmeBatch1', 'readmeQ6', 'readmeEnv', 'indexData', 'indexCases', 'docMultiCol', 'docIcp', 'docRange', 'docExplain'],
      cards: ['05-010', '05-011', '05-012', '05-019'],
    },
    unused: {
      questions: [
        "같은 표·데이터에 보조 인덱스 셋 idx_created (created_at), idx_phone (phone), idx_user (user_id)만 둔다. 인덱스가 있는데도 100ms 넘게 걸리는 쿼리가 있다는 제보다. 쿼리는 모두 SELECT id, amount FROM orders이고 (가) WHERE DATE(created_at) = '2026-08-10'(2,831건) (나) WHERE phone = 01009234282(따옴표 없는 숫자, 1건, id 777777 행의 번호) (다) WHERE phone LIKE '%4282'(약 100건) (라) WHERE user_id = '4242'(따옴표 있는 문자열, 5건)이다. (가)~(라)는 인덱스로 읽을 범위를 좁힐까, 100만 행을 다 읽을까? 이유는?",
        '(마) TEXT 칼럼에 CREATE INDEX idx_memo ON orders (memo);("포장"이 들어간 메모 찾기용)를 하면 성공할까? 이유는?',
        '(가)(나)를 같은 결과로 인덱스를 쓰게 고쳐 쓰면?',
      ],
      observe: [
        '작은 표에는 2026-08-10 주문이 없어 (가)의 꼴을 2026-06-20(주문 2건)으로 그린다. 고객 4242 대신 고객 42다.',
        '(가)(나)(다)는 인덱스가 있어도 PRIMARY를 처음부터 끝까지 읽는다. 위의 보조 인덱스는 그 인덱스의 리프 순서를 보여 주려고 그렸고, 이 쿼리는 읽지 않는다.',
        '견줄 쿼리와 고쳐 쓴 판으로 바꿔, 같은 인덱스에서 찾는 자리가 정해지는지와 어디서 멈추는지 본다. LIKE의 앞부분 일치는 리프에 붙어 있고, 뒷부분 일치는 흩어져 있다.',
        "고쳐 쓴 판 created_at = DATE('2026-06-20')는 인덱스를 쓰지만 그날 0시의 항목만 찾는다.",
      ],
      measured: [
        MEASURED_ENV,
        "(가) DATE(created_at) = '2026-08-10': ALL, first 1 · key 1 · rnd_next 1,000,001, 결과 2,831행, 153~159ms, 논리적 읽기 7,473. 견줄 쿼리 하루 구간: range idx_created, Using index condition, key 1 · next 2,831, 1.69~1.70ms, 11,339.",
        "(나) phone = 01009234282(숫자): ALL, 161~165ms, 7,359. 견줄 쿼리 phone = '01009234282': ref idx_phone, key 1 · next 1, 0.003~0.004ms, 14.",
        "(다) phone LIKE '%4282': ALL, 결과 95행, 190~199ms, 7,359. 견줄 쿼리 LIKE '0100923%': range idx_phone, Using index condition, key 1 · next 96, 0.080~0.081ms, 394.",
        "(라) user_id = '4242'(문자열): ref idx_user, key 1 · next 5, 0.005~0.006ms, 30. 견줄 쿼리 user_id = 4242도 같았다.",
        "(마) CREATE INDEX idx_memo ON orders (memo);는 오류 1170으로 실패했다. memo(20) 인덱스를 만들어도 LIKE '%포장%'는 ALL, 결과 99,663행, 285~290ms, 논리적 읽기 1,006,306이었다(인덱스 없이 285~294ms).",
        "고쳐 쓴 판: created_at = DATE('2026-08-10')는 ref idx_created, key 1, 결과 0행, 0.001ms, 9. phone = '01009234282'는 0.003~0.005ms, 14. 다시 고쳐 쓴 하루 구간은 1.73~1.76ms, 11,339. 함수 인덱스 ((DATE(created_at)))로 (가)를 그대로 돌리면 ref idx_created_date, 1.72~1.76ms, 11,340.",
      ],
      evidence: ['readmeProblem1_3', 'readmeBatch1', 'readmeQ8', 'readmeEnv', 'indexData', 'indexCases', 'docTypeConv', 'docBtreeHash', 'docColumnIndexes', 'docCreateIndex', 'docRange', 'docExplain'],
      cards: ['05-013', '05-014', '05-015', '05-016'],
    },
    sort: {
      questions: [
        '같은 표·데이터·버퍼 풀에서 경우마다 보조 인덱스는 하나만 둔다. 관리자 전체 목록 SELECT id, user_id, amount, created_at FROM orders ORDER BY created_at DESC LIMIT 20;을 (가) 보조 인덱스 없음 (나) idx_created (created_at)로, 고객 1의 내 주문 SELECT id, amount, created_at FROM orders WHERE user_id = 1 ORDER BY created_at DESC LIMIT 20;을 (다) idx_user (user_id) (라) idx_user_created (user_id, created_at)로 돌린다. 경우마다 실제로 읽는 행(인덱스 항목) 수는? 정렬을 따로 할까(Using filesort)? 이유는?',
        '표와 데이터는 같고 보조 인덱스는 CREATE INDEX idx_user_created ON orders (user_id, created_at); 하나다. SELECT id, amount, created_at FROM orders WHERE user_id BETWEEN 100 AND 199 ORDER BY created_at DESC LIMIT 20;의 EXPLAIN type, key, Extra는? 정렬을 따로 할까?',
      ],
      observe: [
        '작은 표에서는 20개 대신 3개를 보여 준다(LIMIT 3).',
        '인덱스 순서가 ORDER BY와 같으면 인덱스를 끝에서부터 거꾸로 읽다가 3행을 채우면 멈춘다(Backward index scan). 정렬 버퍼가 나오지 않는다.',
        '(가)(다)는 조건에 맞는 행을 다 읽어 정렬 버퍼에 넣고 끝에 정렬한다(Using filesort). 정렬 버퍼는 위에서 3행만 남긴다.',
        '(바)는 user_id가 여럿이라 (user_id, created_at)의 리프가 고객 안에서만 created_at 순이다. 범위 안 항목을 다 읽고 정렬한다.',
      ],
      measured: [
        MEASURED_ENV,
        '(가) 없음, 최신순 20개: ALL, Using filesort, first 1 · key 1 · rnd_next 1,000,001, 192~199ms, 논리적 읽기 7,473.',
        '(나) (created_at): index idx_created, Backward index scan, 추정 rows 20, last 1 · key 1 · prev 19, 0.020~0.031ms, 87.',
        '(다) (user_id), 고객 1의 20개: ref idx_user, Using filesort, 추정 rows 104,988, key 1 · next 50,000, 34.1~34.9ms, 200,073.',
        '(라) (user_id, created_at): ref idx_user_created, Backward index scan, 추정 rows 100,652, key 1 · prev 19, 0.504~0.510ms, 논리적 읽기 3,448. 20행을 읽었는데 약 3,450인 것은 레코드 버퍼로 미리 읽은 것으로 봤다(추측). 이 화면의 모형은 이 미리 읽기를 그리지 않는다.',
        '(바) BETWEEN 100 AND 199는 컨테이너 확인(판정용 아님)만 했다: range idx_user_created, Using index condition; Using filesort, 추정 rows 967, key 1 · next 967, 1.89~2.75ms.',
      ],
      evidence: ['readmeProblem2', 'readmeBatch2', 'readmeGoal1', 'readmeObserved', 'readmeEnv', 'indexData', 'indexCases', 'docOrderBy', 'docLimit', 'docExplain'],
      cards: ['05-020', '05-021', '05-017'],
    },
    page: {
      questions: [
        '페이지 번호로 넘기는 관리자 화면이다(여기서 페이지는 20행씩 보여 주는 목록 페이지다). n번째 페이지는 OFFSET (n-1) × 20이고, 보조 인덱스는 idx_created (created_at) 하나다. (가) SELECT id, user_id, amount, created_at FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 100000; (나) 커서 방식(어디까지 봤는지 기억해 그다음부터). 5,000번째 페이지의 마지막 행은 created_at = \'2026-10-04 10:09:05\', id = 900001이다. (1) (가)가 실제로 읽는 행 수와 정렬을 따로 하는지, 이유 (2) (가)와 같은 20행을 같은 순서로 돌려주는 (나) 쿼리 (3) (나)가 읽는 행 수는?',
        '앞 페이지 마지막 행의 (created_at, id)로 다음 20행을 빠짐없이 같은 순서로 돌려주는 커서를 쓰면? 읽는 행 수는?',
        "커서 조건을 행 생성자 WHERE (created_at, id) < ('2026-10-04 10:09:05', 900001)로 쓰면 읽는 행 수는 대략 몇 행일까? 까닭은?",
      ],
      observe: [
        '작은 표에서는 한 페이지가 3행이다. 2번째 페이지의 경계 행은 id 14이고, 3번째 페이지의 경계 행 id 11은 id 10과 같은 초(06-20 15:36:55)에 들어왔다.',
        'OFFSET은 건너뛸 행도 인덱스를 거꾸로 읽고 PRIMARY까지 찾아간 뒤 버린다. 페이지 번호를 바꿔 읽는 수가 어떻게 느는지 본다.',
        '커서는 경계 바로 앞 자리를 찾아 그 자리부터 3행만 읽는다. created_at만 기억한 커서는 3번째 페이지에서 같은 초의 id 10을 빠뜨리거나(<) 경계 행을 다시 돌려준다(<=).',
        'OR 꼴은 두 구간을 차례로 찾는다(Handler_read_key 2). 행 생성자는 범위를 만들지 못해 인덱스 끝부터 읽으며 거른다.',
      ],
      measured: [
        MEASURED_ENV,
        '(가) OFFSET 100000(5,001번째 페이지): 옵티마이저가 ALL, Using filesort를 골랐다. first 1 · key 1 · rnd_next 1,000,001, 233~234ms, 논리적 읽기 7,473. FORCE INDEX (idx_created)로 쓰게 하면 index, Backward index scan, last 1 · key 1 · prev 100,019, 58.4~61.5ms, 401,307.',
        'OFFSET 3380(170번째 페이지)은 옵티마이저가 idx_created를 거꾸로 읽었다: index, Backward index scan, last 1 · key 1 · prev 3,399, 2.02~2.06ms, 13,689.',
        '사람이 쓴 커서(하이픈만 고침, 오름차순): range, Using index condition, first 1 · key 1 · next 19, 0.435~0.444ms, 3,461. 가장 오래된 20행을 돌려준다.',
        'created_at만 기억한 커서 <: range, Using index condition; Backward index scan, key 1 · prev 19. created_at만 쓴 판 0.477~0.483ms, 사람이 다시 쓴 판은 5,001번째 0.478~0.505ms, 170번째 0.469~0.470ms(논리적 읽기 3,462). 170번째 페이지에서 한 행 밀린 것(996619~996600)은 컨테이너 확인(판정용 아님)이다.',
        'OR 꼴 커서: range, Using index condition; Backward index scan, key 2 · prev 19. 5,001번째 0.479~0.492ms(3,477), 170번째 0.468~0.478ms(3,481).',
        '행 생성자 커서: index, Using where; Backward index scan, last 1 · key 1 · prev 100,019, 62.3~64.4ms, 400,321.',
        '컨테이너 확인(판정용 아님): created_at만 기억해 <=로 쓴 커서는 앞 페이지 마지막 행을 다음 페이지 첫 행으로 다시 돌려줬다(1,000번째 페이지 경계 343439).',
      ],
      evidence: ['readmeProblem2_1', 'readmeBatch2', 'readmeObserved', 'readmeQ10', 'readmeEnv', 'indexData', 'indexCases', 'docLimit', 'docOrderBy', 'docRange', 'docExplain'],
      cards: ['05-022', '05-023', '05-024', '05-019'],
    },
    split: {
      questions: [
        '조회를 빠르게 하려고 인덱스를 늘리자는 의견과, 여러 서버에서 id를 따로 만들려고 기본 키를 UUID로 바꾸자는 의견이 있다. 둘 다 쓰기 비용이 붙는다. ④ 빈 표에 100만 건을 5,000건씩 묶어 넣고 묶음마다 커밋한다. 보조 인덱스는 (user_id) 하나다. 기본 키는 (라) BIGINT AUTO_INCREMENT (마) BINARY(16) 무작위 UUID 버전 4 (바) BINARY(16) UUIDv7(앞 48비트가 밀리초 시각, created_at에서 만들어 같은 초 안은 무작위)이다. (마)(바)의 넣는 시간·PRIMARY 크기·idx_user 크기는 (라)의 몇 배일까? 이유는?',
        '버퍼 풀을 128MB로 줄여 ④를 다시 재면 (마)(바)의 넣는 시간은 (라)의 몇 배일까? 다 넣은 뒤 파일 크기는 (라) 140MiB, (마) 224MiB, (바) 172MiB다. 이유는?',
      ],
      observe: [
        '작은 표의 키는 UUID의 앞 두 자리처럼 줄여 적었다. 리프 한 장에 행 4개다.',
        'AUTO_INCREMENT와 UUIDv7은 늘 맨 끝 리프에 넣고, 꽉 차면 끝 분할로 새 리프에 새 행만 넣는다. UUIDv4는 키가 무작위라 가운데 분할이 나고 리프가 반쯤 찬 채로 남는다. 끝난 뒤 리프 수와 채움 비율을 견준다.',
        '버퍼 풀을 4페이지로 줄이면, UUIDv4는 이미 축출한 리프에 다시 넣어야 해서 미스(주황)와 물리적 읽기, 더티 페이지의 플러시가 난다. AUTO_INCREMENT는 늘 같은 끝 리프를 써서 미스가 없다.',
      ],
      measured: [
        WRITE_ENV,
        '④ 버퍼 풀 1GB: (라) AUTO_INCREMENT 11.78초(11.76~11.80), 페이지 분할 8,025, 데이터 파일 쓰기 422~442MiB. (마) UUIDv4 14.98초(14.83~15.08), 1.27배, 분할 11,799, 페이지 재구성 9,199, 쓰기 1,179~1,195MiB. (바) UUIDv7 12.91초(12.86~12.93), 1.10배, 분할 8,955, 쓰기 533~564MiB. 물리적 읽기는 셋 다 0~2페이지였다.',
        '④ 버퍼 풀 128MB: (라) 11.82초(11.78~11.92), 물리적 읽기 298~397페이지. (마) 21.55초(21.52~21.86), 1.82배, 물리적 읽기 87,573~87,963페이지, 데이터 파일 쓰기 3,006~3,070MiB. (바) 12.99초(12.96~13.09), 1.10배, 물리적 읽기 320~456페이지.',
        '다 넣은 뒤 PRIMARY 리프 / 할당: (라) 6,303 / 6,313, (마) 9,664 / 11,122, (바) 6,832 / 7,853페이지. idx_user 리프: 1,713, 2,114, 2,110페이지. 파일 140 / 224 / 172MiB.',
        '③ 보조 인덱스 수(이 화면의 모형은 그리지 않음): 100만 행 복사본에 새 주문 10만 건을 넣는 시간이 (가) 0개 1.12초, (나) 3개 1.74초(1.55배), (다) 6개 2.41초(2.14배)였다. 페이지 분할 630, 3,355, 5,894.',
        '페이지 재구성은 분할로 행을 옮겨 낸 페이지에 빈 공간이 조각나 남고, 무작위로 들어오는 새 행이 그 페이지에 들어갈 때 페이지를 다시 짜는 것으로 봤다(추측, 확인하지 않음).',
      ],
      evidence: ['readmeProblem3', 'readmeProblem3_1', 'readmeBatch34', 'readmeObserved', 'readmeQ11', 'readmeWriteRules', 'writeData', 'writeData128', 'writeLab', 'docBufferPool', 'docMetrics', 'docPhysical'],
      cards: ['05-025', '05-026', '05-027', '05-028', '05-029', '05-030'],
    },
    lock: {
      questions: [
        'orders 100만 행, REPEATABLE READ, 두 세션 A와 B다. 고객 4242는 주문 5건(amount 합 445,400), 고객 17은 3건(합 381,900)이다. 경우는 (가) 보조 인덱스 없음 (나) CREATE INDEX idx_user ON orders (user_id);다. 순서표는 1 A START TRANSACTION; 2 A UPDATE orders SET amount = amount + 100 WHERE user_id = 4242; 3 B START TRANSACTION; 4 B SELECT SUM(amount) FROM orders WHERE user_id = 4242; 5 B SELECT SUM(amount) FROM orders WHERE user_id = 17 FOR UPDATE; 6 A COMMIT; 7 B SELECT SUM(amount) FROM orders WHERE user_id = 4242; 8 B SELECT SUM(amount) FROM orders WHERE user_id = 4242 FOR SHARE; 9 B COMMIT;이다. 경우마다 5번은 바로 끝날까, 기다릴까(기다리면 언제 끝날까)? 4·7·8번은 어떤 값을 돌려줄까? 까닭을 락과 읽기 종류로 답하면?',
        '평범한 SELECT(4번, 7번)와 FOR SHARE(8번)는 각각 무엇을 읽을까? 각각 A가 건 락을 기다릴까?',
      ],
      observe: [
        '작은 표에서는 고객 42(주문 2건, 합 42,400)가 4242, 고객 9(주문 1건, 8,000)가 17의 역할이다. 락이 걸리는 리프만 그리고 루트와 중간 페이지는 뺐다.',
        '2번 A의 UPDATE 뒤 락이 걸린 레코드를 본다. 보조 인덱스가 없으면 PRIMARY의 모든 레코드와 리프마다 supremum이 잠긴다.',
        '5번 B의 FOR UPDATE가 어느 레코드에서 막히는지(회색 점선) 본다. (나)로 바꾸면 B가 잠그는 항목이 A와 겹치지 않는다.',
        '4번과 7번은 스냅숏을, 8번은 커밋된 최신 값을 읽는다. 세션 원 아래의 합과 PRIMARY 칸의 값을 견준다.',
      ],
      measured: [
        '컨테이너 확인(판정용 아님, 한 번 돌림. 5번을 보낸 뒤 약 2초 뒤에 6번을 보냄). 이 확인은 이 값으로 판정했다.',
        '(가) 보조 인덱스 없음: 2번 UPDATE 635.85ms, A가 잠근 행 1,006,303(trx_rows_locked). 4번 바로 끝남(125.83ms), 445,400. 5번은 B가 PRIMARY id 1의 X를 요청해 A의 X에 막혀 기다렸고, 6번 COMMIT 뒤 381,900(2,715.63ms). 7번 445,400(123.53ms). 8번 445,900(413.76ms).',
        '(나) idx_user: 2번 1.39ms, A가 잠근 행 11. 4번 바로 끝남(0.57ms), 445,400. 5번 바로 끝남(0.8ms), 381,900. 7번 445,400(0.58ms). 8번 445,900(0.3ms).',
        '1,006,303은 행 100만 개와 PRIMARY 리프 6,303장의 수를 더한 값과 같고, 11은 4242의 idx_user 항목 5개와 그다음 항목 하나, PRIMARY의 행 5개를 더한 값과 같다(셈).',
      ],
      evidence: ['readmeVariant04', 'exp04NoIndex', 'docLocksSet', 'docLocking', 'docConsistentRead', 'docLockingReads', 'docIndexTypes'],
      cards: ['05-031', '05-032'],
    },
  };

  // 관계도 요소의 설명. 개념, 주요 특성, 근거, 복습 카드. 지금 상태는 board.js가 단계마다 만든다.
  const ELEMENTS = {
    query: {
      kind: '쿼리 (서버의 SQL 계층)',
      concept: 'MySQL 서버가 쿼리 하나를 실행한다. 옵티마이저가 고른 계획(EXPLAIN의 type, key, Extra)대로 InnoDB에 행을 하나씩 달라고 부르고(핸들러 호출), 돌아온 행을 WHERE로 거르고, 정렬하고, LIMIT만큼 결과에 담는다.',
      props: [
        'Handler_read_key는 인덱스에서 찾을 자리를 정하는 호출, Handler_read_next와 Handler_read_prev는 그다음 항목을 앞뒤로 읽는 호출, Handler_read_first와 Handler_read_last는 인덱스의 맨 앞과 맨 끝으로 가는 호출, Handler_read_rnd_next는 표 전체 읽기에서 다음 행을 읽는 호출이다.',
        'Using where는 InnoDB가 돌려준 행을 서버가 거른다는 뜻이고, Using index condition은 인덱스 항목에 있는 칼럼으로 InnoDB가 먼저 거른다는 뜻이다(인덱스 조건 푸시다운). 인덱스 안에서 거른 항목은 Handler_read_next를 늘리지 않는다.',
        'Using index는 필요한 칼럼이 인덱스 항목에 다 있어 PRIMARY를 다시 읽지 않는다는 뜻이다(커버링 인덱스). 인덱스를 쓴다는 뜻이 아니다.',
        'EXPLAIN의 rows는 옵티마이저의 추정이고 LIMIT을 반영하지 않는다. 실제로 읽은 수는 Handler_read_*와 EXPLAIN ANALYZE로 본다.',
      ],
      ev: ['docExplain', 'docStatus', 'docIcp', 'indexLab', 'readmeQueryRules'],
      cards: ['05-017', '05-018'],
    },
    result: {
      kind: '결과',
      concept: '쿼리가 클라이언트에 돌려줄 행이다. 칩 하나가 행 하나이고 글자는 그 행의 id다.',
      props: [
        '인덱스 순서가 ORDER BY와 같고 LIMIT이 있으면, 결과가 LIMIT만큼 차는 순간 더 읽지 않고 멈춘다.',
        'OFFSET은 건너뛸 행도 읽고 센 뒤 버린다. 건너뛴 행의 id는 결과 상자 아래에 회색으로 적는다.',
        '정렬 버퍼를 쓰면(Using filesort) 끝까지 읽어 정렬한 뒤에야 결과가 정해진다.',
      ],
      ev: ['docLimit', 'docOrderBy', 'readmeBatch2'],
      cards: ['05-020', '05-022'],
    },
    sortbuf: {
      kind: '정렬 버퍼 (filesort)',
      concept: '인덱스 순서로 ORDER BY를 채울 수 없을 때 서버가 읽은 행을 모아 직접 정렬하는 곳이다. EXPLAIN의 Extra에 Using filesort가 붙는다. 이름과 달리 메모리 안에서 끝나기도 한다.',
      props: [
        'LIMIT N이 있으면 위에서 N행(OFFSET이 있으면 OFFSET + N행)만 남기며 정렬한다. 그래도 조건에 맞는 행은 끝까지 다 읽어야 어느 행이 위인지 안다.',
        '이 화면의 정렬 버퍼는 created_at 내림차순(같으면 id 내림차순)으로 위 3행을 남긴다. 밀려난 행은 회색이다.',
      ],
      ev: ['docOrderBy', 'docLimit', 'readmeBatch2'],
      cards: ['05-020', '05-021'],
    },
    'tree-primary': {
      kind: '클러스터형 인덱스 (PRIMARY)',
      concept: 'InnoDB 표는 기본 키 순서로 정렬된 B+Tree이고, 이것을 클러스터형 인덱스라 한다. 리프 페이지에 행 전체가 기본 키(id) 순서로 놓인다.',
      props: [
        '루트와 중간 페이지에는 노드 포인터(자식 페이지의 첫 키와 페이지 번호)만 있다. 기본 키로 행 하나를 찾으면 루트에서 리프까지 층마다 한 장씩 읽는다.',
        '실험의 100만 행 PRIMARY는 리프 6,303장(한 장 평균 158.7행), 그 위 중간 8장, 루트 1장의 3층이었다(층 구성은 컨테이너 확인). 이 화면의 작은 표는 리프 한 장에 4행이라 행 16개로 3층이다.',
        '보조 인덱스 없이 읽으면(type ALL) 맨 앞 리프로 한 번 내려가 리프를 옆으로 넘기며 모든 행을 읽는다.',
      ],
      ev: ['docIndexTypes', 'docPhysical', 'readmeProblem1_2', 'readmeBatch1'],
      cards: ['05-002', '05-003', '05-006'],
    },
    'tree-secondary': {
      kind: '보조 인덱스',
      concept: 'CREATE INDEX로 만든 B+Tree다. 리프 항목은 인덱스 칼럼 값과 그 행의 기본 키(id)이고, 인덱스 칼럼 순서(앞 칼럼, 같으면 다음 칼럼, 마지막에 id)로 정렬되어 있다.',
      props: [
        '행의 나머지 칼럼은 없다. 항목에 없는 칼럼이 필요하면 항목의 id로 PRIMARY를 루트부터 다시 찾는다(이 화면의 두 번 읽기).',
        '앞 칼럼이 같은 값으로 고정될 때만 다음 칼럼의 순서를 범위와 정렬에 쓸 수 있다. 그래서 같은 값으로 찾는 칼럼(등치)을 앞에, 범위나 정렬 칼럼을 뒤에 둔다.',
        '실험의 idx_user는 100만 항목에 리프 1,078장(한 장 약 928항목)이었다. 항목이 작아 PRIMARY보다 리프가 훨씬 적다.',
      ],
      ev: ['docIndexTypes', 'docMultiCol', 'readmeBatch1'],
      cards: ['05-006', '05-010', '05-011'],
    },
    'page-root': {
      kind: '루트 페이지',
      concept: 'B+Tree의 맨 위 페이지 한 장이다. 모든 찾기가 여기서 시작한다. 노드 포인터마다 자식 페이지의 첫 키가 있어, 찾는 키와 견주어 내려갈 자식을 고른다.',
      props: [
        '페이지는 InnoDB가 읽고 쓰는 가장 작은 단위(기본 16KB)다. 행 하나가 필요해도 그 페이지를 통째로 버퍼 풀에 올린다.',
        '한 장에 노드 포인터가 약 900개 들어가(실험의 꽉 찬 중간 페이지 928, 컨테이너 확인) 3층이면 리프 수십만 장을 가리킬 수 있다.',
        '페이지 위 숫자는 이 단계까지 그 페이지를 읽은 횟수(논리적 읽기)다.',
      ],
      ev: ['docPhysical', 'readmeProblem1_2'],
      cards: ['05-002', '05-003'],
    },
    'page-inner': {
      kind: '중간 페이지',
      concept: '루트와 리프 사이 층의 페이지다. 루트처럼 노드 포인터만 담는다.',
      props: [
        '찾을 때 층마다 한 장만 읽는다. 층 수가 곧 찾기 한 번에 읽는 페이지 수다.',
        '페이지 위 숫자는 이 단계까지 그 페이지를 읽은 횟수다.',
      ],
      ev: ['docPhysical', 'readmeProblem1_2'],
      cards: ['05-003', '05-004'],
    },
    'page-leaf-primary': {
      kind: 'PRIMARY 리프 페이지',
      concept: '클러스터형 인덱스의 맨 아래 페이지다. 행 전체가 id 순서로 들어 있고, 앞뒤 리프의 페이지 번호로 옆 리프와 이어져 있다(리프 사이의 짧은 선).',
      props: [
        '옆으로 읽다 리프 끝에 닿으면 루트로 돌아가지 않고 다음 리프의 페이지 번호로 넘어간다. 넘어갈 때 그 리프를 한 번 읽는다.',
        '이 화면은 리프 한 장에 행 4개를 둔다. 실험의 리프는 한 장에 행 약 159개였다.',
      ],
      ev: ['docPhysical', 'docIndexTypes'],
      cards: ['05-002', '05-006'],
    },
    'page-leaf-secondary': {
      kind: '보조 인덱스 리프 페이지',
      concept: '보조 인덱스의 맨 아래 페이지다. (인덱스 칼럼, id) 항목이 키 순서로 들어 있고 옆 리프와 이어져 있다.',
      props: [
        '같은 키 값의 항목은 이웃해 있다. 그래서 찾은 자리에서 시작해 조건을 벗어나는 첫 항목에서 멈출 수 있다.',
        '실험의 idx_user 리프는 한 장에 항목 약 928개였다. 고객 1의 항목 5만 개는 리프 약 54장에 이어져 있다.',
      ],
      ev: ['docPhysical', 'readmeBatch1'],
      cards: ['05-002', '05-007'],
    },
    'entry-primary': {
      kind: 'PRIMARY 리프 항목 (행)',
      concept: '클러스터형 인덱스 리프의 항목 하나가 행 하나다. 키는 id이고 나머지 칼럼이 함께 있다. 칸에는 id와 이 장면에서 볼 칼럼만 적었다.',
      props: [
        '파랑 테두리는 이 단계에 읽은 항목, 옅은 파랑은 결과나 정렬 버퍼에 쓰인 행, 회색은 읽었지만 버린 행이다.',
        '보조 인덱스 항목의 id로 찾아온 행이면, 그 쿼리는 이 행을 위해 페이지를 두 번 찾아 읽은 것이다(보조 인덱스에서 한 번, PRIMARY에서 한 번).',
      ],
      ev: ['docIndexTypes'],
      cards: ['05-006', '05-007'],
    },
    'entry-secondary': {
      kind: '보조 인덱스 항목',
      concept: '보조 인덱스 리프의 항목 하나다. 인덱스 칼럼 값 뒤에 그 행의 기본 키 id가 붙는다(옅은 글자). 행의 나머지 칼럼은 없다.',
      props: [
        '쿼리가 쓰는 칼럼이 항목에 다 있으면 PRIMARY로 가지 않는다(Using index). 하나라도 없으면 id로 PRIMARY를 루트부터 다시 찾는다.',
        'Using index condition이면 항목에 있는 칼럼으로 조건을 먼저 확인해, 맞지 않는 항목은 PRIMARY로 가지 않고 넘긴다.',
        '파랑 테두리는 이 단계에 읽은 항목, 옅은 파랑은 쓰인 항목, 회색은 읽었지만 조건에 맞지 않거나 범위 밖이라 버린 항목이다.',
      ],
      ev: ['docIndexTypes', 'docIcp'],
      cards: ['05-007', '05-008', '05-009'],
    },
    pointer: {
      kind: '노드 포인터',
      concept: '루트와 중간 페이지의 항목이다. 자식 페이지의 첫 키와 그 페이지 번호를 담는다. 찾는 키와 견주어 따라 내려갈 포인터 하나를 고른다.',
      props: [
        '파랑 칸과 굵은 곡선은 이 단계에 따라간 포인터다.',
        '기본 키 하나나 끝에서부터 찾을 때는 찾는 키보다 작거나 같은 마지막 포인터를 따라간다. 어떤 값 이상을 처음부터 찾을 때는 그 값보다 작은 마지막 포인터를 따라간다. 같은 값이 앞 리프 끝에 있을 수 있어서이고, 닿은 리프에 그 값 이상인 항목이 없으면 옆 리프로 넘어간다.',
        '보조 인덱스의 포인터 키에도 id가 붙어 있어 같은 값의 항목이 여러 리프에 걸쳐도 자리가 하나로 정해진다.',
      ],
      ev: ['docPhysical', 'modelRules'],
      cards: ['05-002'],
    },
    insert: {
      kind: 'INSERT (넣는 행)',
      concept: '빈 표에 행을 하나씩 넣는다. 상자 안 글자는 이 단계에 넣는 행의 기본 키다. 작은 표의 UUID 키는 앞 두 자리처럼 줄여 적었다.',
      props: [
        'AUTO_INCREMENT와 UUIDv7은 새 키가 늘 가장 커서 맨 끝 리프에만 들어간다. UUIDv4는 키가 무작위라 아무 리프에나 들어간다.',
        '행 하나를 넣을 때 루트와 넣을 리프를 읽는다(논리적 읽기 2). 넣을 리프가 버퍼 풀에 없으면 디스크에서 읽는다.',
      ],
      ev: ['readmeProblem3', 'writeLab', 'readmeBatch34'],
      cards: ['05-026'],
    },
    'split-root': {
      kind: '루트 페이지 (쓰기 장면)',
      concept: 'PRIMARY의 루트다. 리프마다 노드 포인터 하나(그 리프의 첫 키)를 둔다. 리프가 나뉘면 새 리프의 포인터가 더해진다.',
      props: [
        '이 모형은 루트가 넘치지 않는 만큼(리프 6장까지)만 그린다. 실제로는 루트가 꽉 차면 루트도 나뉘어 층이 하나 는다.',
        '모든 넣기가 루트를 읽어, 버퍼 풀에서 늘 가장 최근에 쓴 페이지다.',
      ],
      ev: ['docPhysical', 'modelRules'],
      cards: ['05-026'],
    },
    'split-leaf': {
      kind: '리프 페이지 (쓰기 장면)',
      concept: 'PRIMARY의 리프다. 칸 4개에 키를 순서대로 담는다(실험의 리프는 행 약 159개).',
      props: [
        '끝 분할: 꽉 찬 맨 끝 리프에 가장 큰 키가 오면 그 리프는 그대로 두고 새 리프에 새 행만 넣는다. 앞 리프는 꽉 찬 채로 남는다.',
        '가운데 분할: 꽉 찬 리프의 가운데로 키가 오면 뒤의 반을 새 리프로 옮긴다. 두 리프가 반쯤 차 같은 행 수에 리프가 늘고, 옆 리프의 앞 페이지 번호도 고친다.',
        '파랑 테두리는 버퍼 풀에서 바뀌었지만 아직 디스크에 쓰지 않은 더티 페이지, 점선 테두리는 버퍼 풀에 없는 페이지다.',
      ],
      ev: ['docPhysical', 'docMetrics', 'readmeBatch34', 'readmeObserved'],
      cards: ['05-026', '05-027'],
    },
    pool: {
      kind: '버퍼 풀',
      concept: 'InnoDB가 페이지를 올려 두는 메모리다. 페이지를 읽을 때마다 논리적 읽기 1이고, 버퍼 풀에 있으면 적중, 없으면 미스로 디스크에서 읽는다(물리적 읽기).',
      props: [
        '바뀐 페이지는 바로 디스크에 쓰지 않고 더티 페이지로 버퍼 풀에 둔다. 나중에 디스크에 쓰거나(플러시), 자리를 비울 때 먼저 쓴다.',
        '자리가 없으면 가장 오래 쓰지 않은 페이지를 내보낸다(축출, LRU). 이 모형은 단순 LRU이고, 실제 InnoDB는 목록을 새 부분과 옛 부분으로 나눠 처음 읽은 페이지를 가운데에 넣는다.',
        '버퍼 풀 1GB는 페이지 65,536장, 128MB는 8,192장이다. 실험에서 128MB일 때 UUIDv4만 물리적 읽기가 87,573~87,963페이지로 크게 늘었다.',
      ],
      ev: ['docBufferPool', 'readmeProblem3_1', 'readmeBatch34', 'writeData128'],
      cards: ['05-028', '05-029'],
    },
    frame: {
      kind: '버퍼 풀의 페이지',
      concept: '버퍼 풀에 올라와 있는 페이지 한 장이다. 왼편일수록 최근에 썼다(LRU 순서).',
      props: [
        '파랑 테두리는 더티 페이지(바뀌고 아직 디스크에 쓰지 않음), 주황 테두리는 이 단계에 디스크에서 읽어 온 페이지(미스)다.',
        '맨 오른편 페이지가 다음에 자리가 필요할 때 먼저 축출된다. 지금 쓰는 페이지는 축출하지 않는다.',
      ],
      ev: ['docBufferPool', 'modelRules'],
      cards: ['05-028'],
    },
    disk: {
      kind: '디스크 (데이터 파일)',
      concept: '표의 페이지가 저장된 파일(.ibd)이다. 미스면 여기서 페이지를 읽고, 더티 페이지를 플러시하면 여기에 쓴다.',
      props: [
        '실험의 데이터 파일 쓰기는 버퍼 풀 1GB에서 AUTO_INCREMENT 422~442MiB, UUIDv4 1,179~1,195MiB였다(다 넣은 파일은 140MiB, 224MiB). 같은 페이지를 여러 번 고쳐 쓴 것이 들어 있다.',
        '이 모형은 축출할 때만 플러시한다. 실제 InnoDB는 백그라운드에서도 더티 페이지를 디스크에 쓴다.',
      ],
      ev: ['readmeBatch34', 'docBufferPool'],
      cards: ['05-027'],
    },
    session: {
      kind: '세션 (연결 하나)',
      concept: '순서표의 문장을 차례로 보내는 연결이다. 격리 수준은 REPEATABLE READ이고, START TRANSACTION과 COMMIT으로 트랜잭션을 열고 닫는다.',
      props: [
        '평범한 SELECT는 락 없이 스냅숏을 읽는다(일관된 읽기). REPEATABLE READ는 트랜잭션의 첫 평범한 SELECT 때 스냅숏을 만들고 끝까지 쓴다.',
        'UPDATE, FOR UPDATE, FOR SHARE는 잠금 읽기라 커밋된 최신 행을 읽고, 읽으며 훑은 인덱스 항목에 락을 건다. 락은 COMMIT이나 ROLLBACK 때 해제된다.',
      ],
      ev: ['docConsistentRead', 'docLockingReads', 'readmeVariant04'],
      cards: ['05-031', '05-032'],
    },
    'record-primary': {
      kind: 'PRIMARY 레코드',
      concept: '클러스터형 인덱스의 행이다. 칸에는 id와 amount를 적었다. A가 고치고 커밋하기 전이면 새 값 아래에 커밋된 값을 함께 적는다.',
      props: [
        '테두리는 레코드 락, 왼편 막대는 그 레코드 앞 갭의 락이다. 둘 다 있으면 넥스트 키 락이다.',
        '보조 인덱스 없이 잠그며 읽으면 PRIMARY를 처음부터 끝까지 훑으며 모든 레코드에 넥스트 키 락을 걸고, REPEATABLE READ는 조건에 맞지 않은 행의 락도 해제하지 않는다.',
      ],
      ev: ['docLocking', 'docLocksSet', 'exp04NoIndex', 'readmeVariant04'],
      cards: ['05-031'],
    },
    'record-secondary': {
      kind: 'idx_user 레코드',
      concept: '보조 인덱스 idx_user의 항목 (user_id, id)이다.',
      props: [
        'idx_user로 잠그며 읽으면 조건에 맞는 항목에 넥스트 키 락, 조건을 벗어난 첫 항목에 갭 락, PRIMARY의 그 행에 레코드 락만 건다.',
        '실험에서 A의 UPDATE가 잠근 행은 idx_user가 있을 때 11개, 없을 때 1,006,303개였다(컨테이너 확인).',
      ],
      ev: ['docLocksSet', 'docLocking', 'readmeVariant04'],
      cards: ['05-031'],
    },
    supremum: {
      kind: 'supremum 레코드',
      concept: '리프 페이지마다 마지막 항목 뒤에 있는 가짜 레코드다. 그 리프의 마지막 항목 뒤 갭을 잠글 때 이 레코드에 락을 건다.',
      props: [
        'performance_schema.data_locks의 LOCK_DATA에는 supremum pseudo-record로 나온다.',
        '인덱스 없이 PRIMARY를 끝까지 잠그며 읽으면 리프마다 supremum에도 락이 걸린다.',
      ],
      ev: ['docLocking', 'exp04NoIndex'],
      cards: ['05-031'],
    },
  };

  // 복습 카드의 앞면(anki/05-mysql-indexes-explain.md). 뒷면은 카드 문서에서 본다.
  const CARDS = {
    '05-001': '100만 행 orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, amount INT NOT NULL, created_at DATETIME NOT NULL, …)에서 고객 4242의 주문은 5건이다(id 51,510·172,436·338,024·553,396·788,746). SELECT created_at, amount FROM orders WHERE user_id = 4242 AND created_at >= \'2026-08-10\';를 (가) 보조 인덱스 없이 (나) idx_user (user_id)로 돌린다. (가)는 5건을 찾은 뒤에도 왜 끝까지 읽고, (나)는 어떻게 첫 항목에 닿고 어디서 멈추는가?',
    '05-002': 'InnoDB B+Tree의 루트·중간 페이지와 리프 페이지에는 각각 무엇이 있고, 리프끼리는 어떻게 이어져 있는가? 100만 행 orders의 idx_user (user_id)(리프 1,078장, 항목 100만 개)로 user_id = 1(5만 건)의 항목을 모두 읽을 때 루트로 몇 번 돌아가고 리프는 몇 장쯤 읽는가?',
    '05-003': '페이지 16KB에서 항목을 담는 공간이 약 15,360B, 리프 항목(행 전체)이 약 100B, 루트·중간 항목(키 id 8B + 자식 페이지 번호 4B + 레코드 머리 5B)이 약 17B다. 100만 행과 1억 행의 클러스터형 인덱스는 루트에서 리프까지 몇 층인가? 리프부터 위로 세어 답하라.',
    '05-004': 'innodb_page_size를 4KB로 만든다면(항목을 담는 공간 약 4,000B로 셈, 행 약 100B, 중간 항목 약 17B) 중간 페이지의 자식 수, 리프 한 장의 행 수, 100만 행과 1억 행의 층 수는 어떻게 되는가? 16KB일 때(자식 약 900, 리프 약 150행, 둘 다 3층)와 견주라.',
    '05-005': 'B-Tree, B+Tree, 해시 인덱스는 무엇이 다른가? 등치 조회는 해시가 O(1)인데도 InnoDB가 등치에도 B+Tree를 쓰고 해시 인덱스를 따로 두지 않아도 되는 까닭을 숫자로 설명하라(100만 행 idx_user로 user_id = 4242 5건을 찾는 쿼리: 3층, 논리적 읽기 30, 0.006~0.008ms).',
    '05-006': '100만 행 orders(id BIGINT 기본 키, user_id INT, 행 약 100B)에서 PRIMARY 리프는 6,303장, idx_user (user_id) 리프는 1,078장이다. 두 인덱스의 리프 항목에는 각각 무엇이 있는가? 보조 인덱스 항목이 행의 자리(페이지 번호) 대신 기본 키를 갖는 까닭은?',
    '05-007': '100만 행 orders에 보조 인덱스 idx_user (user_id)만 있다. 고객 1은 주문 5만 건이고 id가 1년치에 흩어져 있다. SELECT created_at, amount FROM orders WHERE user_id = 1 AND created_at >= \'2026-08-10\';는 idx_user 항목 5만 개를 읽으며 논리적 읽기가 200,073번이었고, 보조 인덱스 없이 100만 행을 다 읽으면 7,473번이었다. 항목 하나에 약 4번은 어느 인덱스의 어느 페이지인가? 항목마다 6장(두 인덱스에서 3장씩)이 아닌 까닭은?',
    '05-008': '100만 행 orders에서 SELECT created_at, amount FROM orders WHERE user_id = 1 AND created_at >= \'2026-08-10\';(12,656행)를 (다) idx_user_created (user_id, created_at) (마) idx_user_created_amount (user_id, created_at, amount)로 돌린다. 둘 다 항목 12,656개를 읽는데 논리적 읽기와 시간은 어떻게 다르고, Extra에는 무엇이 붙는가? 커버링 인덱스는 인덱스의 한 종류인가?',
    '05-009': '100만 행 orders에 보조 인덱스 (user_id, created_at)만 있다. (ㄱ) SELECT id, created_at FROM orders WHERE user_id = 1 AND created_at >= \'2026-08-10\'; (ㄴ) 같은 조건의 SELECT COUNT(*)는 클러스터형 인덱스를 다시 읽는가? 보조 인덱스 (user_id)만 있을 때 (ㄷ) SELECT COUNT(*) FROM orders WHERE user_id = 1;(5만 건)은? 논리적 읽기는 수십인가, 수만~수십만인가?',
    '05-010': '100만 행 orders(created_at은 1년에 고르게)에서 고객 4242의 주문은 5건, 2026-08-10 이후 주문은 전체 251,352건이다. SELECT created_at, amount FROM orders WHERE user_id = 4242 AND created_at >= \'2026-08-10\';에 복합 인덱스 (다) (user_id, created_at) (라) (created_at, user_id) 중 무엇을 두는가? 두 리프에서 4242의 08-10 이후 항목은 어떻게 놓이고, 칼럼 순서를 정하는 기준은 무엇인가?',
    '05-011': '여섯 행 (user_id, created_at) = (4242, 07-01) (4243, 08-12) (4242, 08-24) (17, 09-03) (4242, 05-10) (17, 08-15)(날짜는 2026년)가 있다. (1) (user_id, created_at)와 (created_at, user_id) 인덱스의 리프 순서 (2) user_id = 4242 AND created_at >= \'2026-08-10\'을 각 인덱스에서 어디서 시작해 어디서 멈추고 몇 개 읽는가 (3) WHERE를 created_at >= \'2026-08-10\' AND user_id = 4242로 바꿔 쓰면 읽는 수나 고르는 인덱스가 달라지는가?',
    '05-012': '100만 행 orders(status는 paid 약 90%, cancelled 약 7%, refunded 약 3%)에서 고객이 상태를 골라 최신순 20개를 본다. SELECT id, amount, created_at FROM orders WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 20; 고객 대부분은 주문이 10건 안팎이고 고객 1은 5만 건이다. 보조 인덱스를 하나만 둔다면 칼럼을 어떤 순서로 두는가? amount까지 붙이면 무엇을 얻고 잃는가?',
    '05-013': '100만 행 orders에 idx_created (created_at)가 있다(created_at은 DATETIME). SELECT id, amount FROM orders WHERE DATE(created_at) = \'2026-08-10\';(2,831건)는 인덱스로 범위를 좁히는가? 인덱스를 쓰게 고쳐 쓰고, 쿼리를 고칠 수 없을 때의 방법도 적어라. WHERE created_at = DATE(\'2026-08-10\')은 같은 결과인가?',
    '05-014': '100만 행 orders에 idx_phone (phone)(phone은 VARCHAR(20), 예 \'01009234282\')과 idx_user (user_id)(user_id는 INT)가 있다. (나) WHERE phone = 01009234282(따옴표 없는 숫자) (라) WHERE user_id = \'4242\'(따옴표 있는 문자열)는 둘 다 다른 타입의 값과 비교한다. 각각 인덱스를 쓰는가? 무엇이 둘을 가르는가?',
    '05-015': '100만 행 orders의 idx_phone (phone) 리프에 \'01009230001\' \'01009234282\' \'01011114282\' \'01055554282\'처럼 번호가 사전 순으로 놓여 있다. LIKE \'0100923%\'(96건)와 LIKE \'%4282\'(95건)는 리프에서 어디서 시작해 어디서 멈추는가? TEXT 칼럼 memo에 CREATE INDEX idx_memo ON orders (memo);를 하면 어떻게 되고, memo(20) 인덱스가 있을 때 LIKE \'%포장%\'는 어떻게 읽는가?',
    '05-016': '100만 행 orders에 idx_created (created_at)만 있다(created_at은 DATETIME). 2026-11-01 하루의 주문 수를 SELECT COUNT(*) FROM orders WHERE created_at LIKE \'2026-11-01%\';로 센다. EXPLAIN의 type과 Extra, 읽는 항목 수, 시간의 크기는? VARCHAR 칼럼 phone의 LIKE \'0100923%\'는 범위로 읽었는데 무엇이 다른가?',
    '05-017': 'EXPLAIN의 type 값 ALL, index, range, ref, const는 각각 어떤 읽기인가? Extra의 Using where, Using index, Using index condition, Using filesort, Backward index scan은 무슨 뜻인가?',
    '05-018': '100만 행 orders에서 idx_user (user_id)로 고객 1(5만 건)의 행을 읽는 쿼리의 EXPLAIN rows는 104,988이었다. 또 idx_status_created (status, created_at)로 SELECT id, created_at FROM orders WHERE status = \'refunded\' ORDER BY created_at DESC LIMIT 20;을 하면 rows는 20 근처인가? rows는 무엇이고, 실제로 읽은 수는 어디서 보는가?',
    '05-019': '100만 행 orders에 (created_at, user_id) 인덱스만 있을 때 WHERE user_id = 4242 AND created_at >= \'2026-08-10\'(08-10 이후 실제 251,352항목)을, idx_created (created_at)만 있을 때 ORDER BY created_at DESC LIMIT 20 OFFSET 100000을 옵티마이저는 어떻게 실행했고, 인덱스를 강제하면 어땠는가? 옵티마이저는 무엇으로 계획을 고르는가?',
    '05-020': '100만 행 orders(id 순서가 곧 시간 순서)에서 SELECT id, user_id, amount, created_at FROM orders ORDER BY created_at DESC LIMIT 20;을 (가) 보조 인덱스 없이 (나) idx_created (created_at)로, SELECT id, amount, created_at FROM orders WHERE user_id = 1 ORDER BY created_at DESC LIMIT 20;(고객 1은 5만 건)을 (다) idx_user (user_id) (라) idx_user_created (user_id, created_at)로 돌린다. 어느 것이 정렬을 따로 하고, 인덱스로 정렬을 생략하는 규칙은 무엇인가?',
    '05-021': '100만 행 orders(user_id 2 ~ 100,000은 고객마다 평균 9.5건)에 (user_id, created_at) 인덱스가 있다. SELECT id, amount, created_at FROM orders WHERE user_id BETWEEN 100 AND 199 ORDER BY created_at DESC LIMIT 20;은 정렬을 따로 하는가? 같은 인덱스로 WHERE user_id = 1 ORDER BY created_at DESC LIMIT 20은 20개만 읽었는데 무엇이 다른가?',
    '05-022': '100만 행 orders에 idx_created (created_at)가 있다. 페이지 번호로 넘기는 관리자 목록에서 5,001번째 페이지를 SELECT id, user_id, amount, created_at FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 100000;으로 읽는다. 인덱스로 10만 번째 자리에 바로 갈 수 있는가? 커서 방식은 그 자리에 어떻게 닿고, 페이지 번호가 커지면 시간이 어떻게 되는가?',
    '05-023': '100만 행 orders에 같은 초의 주문이 여럿 있다(같은 초 묶음 15,629개, 31,408행). 최신순 20개씩 넘기는 목록에서 앞 페이지의 마지막 행이 (created_at, id) = (\'2026-10-04 10:09:05\', 900001)이다. created_at만 기억해 WHERE created_at < \'2026-10-04 10:09:05\'나 <=로 다음 페이지를 읽으면 무엇이 잘못되는가? idx_created (created_at)로 범위를 읽는 다음 페이지 쿼리를 써라.',
    '05-024': '100만 행 orders에서 환불된 주문(약 3만 건)을 최신순 20개씩 끝까지 넘기며 id, user_id, amount, created_at을 보여 준다. 다음 페이지는 앞 페이지 마지막 행의 (created_at, id)로 WHERE status = \'refunded\' AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 20을 쓴다. 커버링 인덱스로 (ㄱ) (status, created_at, user_id, amount) (ㄴ) (status, created_at, id, user_id, amount) 중 무엇을 두는가?',
    '05-025': '버퍼 풀 1GB에서 100만 행 orders의 복사본에 새 주문 10만 건을 5,000건씩 넣는다. 보조 인덱스가 (가) 0개 (나) 3개 (다) 6개일 때 넣는 시간은 몇 배가 되는가? "인덱스마다 루트·중간·리프 3장을 더 읽으니 (나)는 9배, (다)는 18배"라는 셈에서 빠진 것은?',
    '05-026': '빈 표에 100만 행을 넣을 때 기본 키가 (라) BIGINT AUTO_INCREMENT (마) 무작위 UUIDv4(BINARY(16)) (바) UUIDv7(BINARY(16), 앞 48비트가 밀리초 시각)이면, 새 행은 PRIMARY B+Tree의 어디로 들어가고 꽉 찬 페이지는 어떻게 나뉘는가? 다 넣은 뒤 PRIMARY 리프 수(6,303 / 9,664 / 6,832)가 이렇게 다른 까닭은?',
    '05-027': '버퍼 풀 1GB(표 전체가 들어감)에서 빈 표에 100만 행을 넣을 때 기본 키별 넣는 시간과 데이터 파일 쓰기는 AUTO_INCREMENT 11.78초·422~442MiB, UUIDv4 14.98초·1,179~1,195MiB, UUIDv7 12.91초·533~564MiB였다(다 넣은 파일은 140 / 224 / 172MiB). 바뀐 페이지는 언제 디스크에 쓰이고, UUIDv4가 파일 크기보다 훨씬 많이 쓰는 까닭은?',
    '05-028': '페이지, 버퍼 풀, 논리적 읽기, 물리적 읽기, 적중과 미스, 더티 페이지, 플러시, 축출(LRU)을 설명하라. 버퍼 풀 1GB와 128MB는 각각 몇 페이지인가? "인덱스를 쓰려면 트리 전체를 늘 메모리에 올려 둬야 한다"는 맞는가?',
    '05-029': '버퍼 풀을 128MB(8,192페이지)로 줄여 빈 표에 100만 행을 다시 넣었다. 다 넣은 파일은 AUTO_INCREMENT 140MiB, UUIDv4 224MiB, UUIDv7 172MiB로 셋 다 버퍼 풀보다 크고, 넣는 시간은 버퍼 풀 1GB 때 11.78 / 14.98 / 12.91초였다. 128MB에서는 시간이 어떻게 되고, 왜 그런가?',
    '05-030': '새 표 payments(결제 번호, user_id, amount, created_at)에 하루 수백만 건이 들어오고 표는 곧 버퍼 풀보다 커진다. 결제 번호는 영수증 주소로 밖에 보이는데, 번호로 전체 결제 건수를 짐작할 수 없어야 한다. 조회는 결제 번호로 한 건 찾기와 고객별 최신순 목록이다. 기본 키(AUTO_INCREMENT, UUIDv4, UUIDv7 중)와 보조 인덱스를 무엇으로 하는가?',
    '05-031': '100만 행 orders, REPEATABLE READ, 세션 A와 B다. 고객 4242는 주문 5건, 고객 17은 3건이다. A가 START TRANSACTION; UPDATE orders SET amount = amount + 100 WHERE user_id = 4242;를 하고 커밋하지 않은 채, B가 START TRANSACTION; SELECT SUM(amount) FROM orders WHERE user_id = 17 FOR UPDATE;를 보낸다. (가) 보조 인덱스 없음 (나) idx_user (user_id)에서 B는 기다리는가? A가 잠그는 범위를 정하는 것은 무엇인가?',
    '05-032': 'REPEATABLE READ에서 고객 4242의 주문 amount 합은 445,400이고, 보조 인덱스 idx_user (user_id)가 있다. 순서는 1 A START TRANSACTION; 2 A UPDATE orders SET amount = amount + 100 WHERE user_id = 4242; 3 B START TRANSACTION; 4 B SELECT SUM(amount) FROM orders WHERE user_id = 4242; 5 A COMMIT; 6 B 4번과 같은 평범한 SELECT 7 B SELECT SUM(amount) FROM orders WHERE user_id = 4242 FOR SHARE; 8 B COMMIT;이다. 4·6·7번은 각각 기다리는가, 어떤 값을 돌려주는가?',
  };

  root.IndexContent = { EV, TYPE_LABEL, SCENES, ELEMENTS, CARDS };
})(typeof self !== 'undefined' ? self : this);
