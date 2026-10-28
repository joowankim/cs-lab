/*
 * 요소 설명·장면 안내·근거 링크. 실행 상태는 model.js가 만들고 여기서는 고정된 설명만 둔다.
 * 근거 종류: measured(실측 기록), source(소스·공식 문서), record(실험 문답 기록), model(설명용 가정).
 */
(function (root) {
  'use strict';

  // 근거 파일은 GitHub의 main 브랜치 판을 연다. 화면을 Pages에서 열든 내려받은 폴더에서 열든 같은 곳으로 간다.
  const REPO = 'https://github.com/joowankim/cs-lab/blob/main/';
  const EXP = `${REPO}experiments/03-mysql-isolation-mvcc/`;
  const README = `${EXP}README.md`;
  const ANKI = `${REPO}anki/03-mysql-isolation-mvcc.md`;
  const MYSQL = 'https://dev.mysql.com/doc/refman/8.4/en/';
  const PG = 'https://www.postgresql.org/docs/18/';
  const RUN = '2026-10-28T';

  const EV = {
    readmeProblem1: { type: 'record', label: '실험 README · 문제 상황 1: 같은 트랜잭션에서 개수가 2, 3, 2로 바뀐 응모 확인', href: `${README}#문제-상황-1-같은-트랜잭션에서-개수가-2-3-2로-바뀐-응모-확인` },
    readmeProblem1_1: { type: 'record', label: '실험 README · 문제 상황 1-1: 처음 쓰는 조건으로 다시 세기', href: `${README}#문제-상황-1-1-처음-쓰는-조건으로-다시-세기` },
    readmeProblem1_2: { type: 'record', label: '실험 README · 문제 상황 1-2: 트랜잭션을 연 뒤 처음 세기', href: `${README}#문제-상황-1-2-트랜잭션을-연-뒤-처음-세기` },
    readmeProblem1_2v: { type: 'record', label: '실험 README · 문제 상황 1-2 변형: 첫 문장이 다른 표의 UPDATE일 때', href: `${README}#문제-상황-1-2-변형-첫-문장이-다른-표의-update일-때` },
    readmeProblem2: { type: 'record', label: '실험 README · 문제 상황 2: 정산 리포트가 세 번 읽은 잔액', href: `${README}#문제-상황-2-정산-리포트가-세-번-읽은-잔액` },
    readmeProblem1_3: { type: 'record', label: '실험 README · 문제 상황 1-3: 응모 행을 잠그며 읽기', href: `${README}#문제-상황-1-3-응모-행을-잠그며-읽기` },
    readmeProblem3: { type: 'record', label: '실험 README · 문제 상황 3: 동시에 차감한 포인트', href: `${README}#문제-상황-3-동시에-차감한-포인트` },
    readmeProblem4: { type: 'record', label: '실험 README · 문제 상황 4: 열어 둔 정산 트랜잭션', href: `${README}#문제-상황-4-열어-둔-정산-트랜잭션` },
    readmeProblem4v: { type: 'record', label: '실험 README · 문제 상황 4 변형: 다른 표만 읽고 둔 트랜잭션 (스냅숏의 크기와 생애주기)', href: `${README}#문제-상황-4-변형-다른-표만-읽고-둔-트랜잭션` },
    readmeProblem4_1: { type: 'record', label: '실험 README · 문제 상황 4-1: 열어 둔 트랜잭션이 있을 때의 읽기 시간', href: `${README}#문제-상황-4-1-열어-둔-트랜잭션이-있을-때의-읽기-시간` },
    readmeProblem4_2: { type: 'record', label: '실험 README · 문제 상황 4-2: writer B의 UPDATE latency', href: `${README}#문제-상황-4-2-long-running-transaction이-있을-때-writer-b의-update-latency` },
    readmeProblem4_3: { type: 'record', label: '실험 README · 문제 상황 4-3: long-running transaction이 끝난 뒤', href: `${README}#문제-상황-4-3-long-running-transaction이-끝난-뒤` },
    readmeProblem5: { type: 'record', label: '실험 README · 문제 상황 5: 되돌린 주문과 남은 기록', href: `${README}#문제-상황-5-되돌린-주문과-남은-기록` },
    readmeProblem5_1: { type: 'record', label: '실험 README · 문제 상황 5-1: 재고 리포트가 도는 중에 들어온 차감', href: `${README}#문제-상황-5-1-재고-리포트가-도는-중에-들어온-차감` },
    readmeProblem6: { type: 'record', label: '실험 README · 문제 상황 6: 커밋을 디스크에 언제 내릴까', href: `${README}#문제-상황-6-커밋을-디스크에-언제-내릴까` },
    readmeTimelineRules: { type: 'record', label: '실험 README · 순서표 실행 규칙 (0.5초 기다림, 미룸)', href: `${README}#순서표-실행-규칙` },
    readmeHoldRules: { type: 'record', label: '실험 README · 열어 둔 트랜잭션 측정 규칙', href: `${README}#열어-둔-트랜잭션-측정-규칙` },
    readmeDurabilityRules: { type: 'record', label: '실험 README · 지속성 설정 측정 규칙', href: `${README}#지속성-설정-측정-규칙` },
    readmeEnv: { type: 'measured', label: '실험 README · 측정 환경과 원자료 (Apple M2 Pro, Docker Desktop, MySQL 8.4.13, PostgreSQL 18.6)', href: `${README}#측정-환경과-원자료-2026-10-28` },
    readmeBatch13: { type: 'measured', label: '실험 README · 묶음 1·3 결과: 순서표 (조건마다 3회)', href: `${README}#묶음-13-순서표-조건마다-3회` },
    readmeBatch2: { type: 'measured', label: '실험 README · 묶음 2 결과: 열어 둔 트랜잭션 (경우마다 3회)', href: `${README}#묶음-2-열어-둔-트랜잭션-경우마다-3회` },
    readmeBatch4: { type: 'measured', label: '실험 README · 묶음 4 결과: 지속성 설정 (설정마다 3회)', href: `${README}#묶음-4-지속성-설정-설정마다-3회` },
    readmeSyncWrite: { type: 'measured', label: '실험 README · 해석 중 더한 측정: 이어 쓰기와 덮어쓰기', href: `${README}#해석-중-더한-측정-이어-쓰기와-덮어쓰기-방식마다-3회` },
    readmeObserved: { type: 'measured', label: '실험 README · 측정하며 본 것', href: `${README}#측정하며-본-것` },
    readmeContainer: { type: 'measured', label: '실험 README · 참고: 컨테이너 임시 확인 값과 맥 본 측정', href: `${README}#참고-컨테이너-임시-확인-값과-맥-본-측정` },
    readmeFsync: { type: 'record', label: '실험 README · 첫 해석: 커밋마다 기다리는 두 fsync의 몫', href: `${README}#묶음-4-커밋마다-기다리는-두-fsync의-몫` },
    readmeAppend: { type: 'record', label: '실험 README · 첫 해석: 이어 쓰기와 덮어쓰기', href: `${README}#이어-쓰기와-덮어쓰기` },
    readmeHistory: { type: 'record', label: '실험 README · 첫 해석: History list length가 줄지 않고 머문 실행', href: `${README}#묶음-2-history-list-length가-줄지-않고-머문-실행` },
    timelines: { type: 'source', label: 'python/isolation_timelines.py (순서표의 SQL)', href: `${EXP}python/isolation_timelines.py` },
    isolationLab: { type: 'source', label: 'python/isolation_lab.py (세션마다 한 문장씩, 기다림과 미룸)', href: `${EXP}python/isolation_lab.py` },
    historyLab: { type: 'source', label: 'python/history_lab.py (경우 (가)~(바))', href: `${EXP}python/history_lab.py` },
    durabilityLab: { type: 'source', label: 'python/durability_lab.py (설정과 자동 커밋 INSERT)', href: `${EXP}python/durability_lab.py` },
    syncWriteLab: { type: 'source', label: 'python/sync_write_lab.py (이어 쓰기와 덮어쓰기)', href: `${EXP}python/sync_write_lab.py` },
    isolationData: { type: 'measured', label: '원자료 · 묶음 1·3 순서표', href: `${EXP}results/${RUN}220156065912-isolation-python-3.14.2.jsonl` },
    historyData: { type: 'measured', label: '원자료 · 묶음 2 열어 둔 트랜잭션', href: `${EXP}results/${RUN}220300298631-history-python-3.14.2.jsonl` },
    durabilityData: { type: 'measured', label: '원자료 · 묶음 4 지속성 설정', href: `${EXP}results/${RUN}221519136661-durability-python-3.14.2.jsonl` },
    syncWriteData: { type: 'measured', label: '원자료 · 이어 쓰기와 덮어쓰기', href: `${EXP}results/${RUN}225717392478-sync-write-python-3.14.2.jsonl` },
    docConsistent: { type: 'source', label: 'MySQL 8.4 문서 · Consistent Nonlocking Reads', href: `${MYSQL}innodb-consistent-read.html` },
    docLockingReads: { type: 'source', label: 'MySQL 8.4 문서 · Locking Reads', href: `${MYSQL}innodb-locking-reads.html` },
    docIsoMysql: { type: 'source', label: 'MySQL 8.4 문서 · Transaction Isolation Levels', href: `${MYSQL}innodb-transaction-isolation-levels.html` },
    docInnodbLocking: { type: 'source', label: 'MySQL 8.4 문서 · InnoDB Locking (공유·배타 락, gap lock)', href: `${MYSQL}innodb-locking.html` },
    docMultiVersion: { type: 'source', label: 'MySQL 8.4 문서 · InnoDB Multi-Versioning', href: `${MYSQL}innodb-multi-versioning.html` },
    docUndo: { type: 'source', label: 'MySQL 8.4 문서 · Undo Logs', href: `${MYSQL}innodb-undo-logs.html` },
    docPurge: { type: 'source', label: 'MySQL 8.4 문서 · Purge Configuration', href: `${MYSQL}innodb-purge-configuration.html` },
    docDeadlock: { type: 'source', label: 'MySQL 8.4 문서 · Deadlocks in InnoDB', href: `${MYSQL}innodb-deadlocks.html` },
    docMyisam: { type: 'source', label: 'MySQL 8.4 문서 · The MyISAM Storage Engine', href: `${MYSQL}myisam-storage-engine.html` },
    docCommit: { type: 'source', label: 'MySQL 8.4 문서 · START TRANSACTION, COMMIT, and ROLLBACK', href: `${MYSQL}commit.html` },
    docInternalLocking: { type: 'source', label: 'MySQL 8.4 문서 · Internal Locking Methods (표 락)', href: `${MYSQL}internal-locking.html` },
    docFlush: { type: 'source', label: 'MySQL 8.4 문서 · innodb_flush_log_at_trx_commit', href: `${MYSQL}innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit` },
    docBinlog: { type: 'source', label: 'MySQL 8.4 문서 · The Binary Log (sync_binlog)', href: `${MYSQL}binary-log.html` },
    docRedo: { type: 'source', label: 'MySQL 8.4 문서 · Redo Log', href: `${MYSQL}innodb-redo-log.html` },
    pgIso: { type: 'source', label: 'PostgreSQL 18 문서 · Transaction Isolation', href: `${PG}transaction-iso.html` },
    pgLocking: { type: 'source', label: 'PostgreSQL 18 문서 · Explicit Locking (행 락)', href: `${PG}explicit-locking.html` },
    pgVacuum: { type: 'source', label: 'PostgreSQL 18 문서 · Routine Vacuuming', href: `${PG}routine-vacuuming.html` },
    pgHot: { type: 'source', label: 'PostgreSQL 18 문서 · Heap-Only Tuples (HOT)', href: `${PG}storage-hot.html` },
    pgSnapshot: { type: 'source', label: 'PostgreSQL 18 문서 · System Information Functions (pg_snapshot)', href: `${PG}functions-info.html` },
    pgWalConfig: { type: 'source', label: 'PostgreSQL 18 문서 · WAL 설정 (synchronous_commit, wal_writer_delay)', href: `${PG}runtime-config-wal.html` },
    pgAsync: { type: 'source', label: 'PostgreSQL 18 문서 · Asynchronous Commit', href: `${PG}wal-async-commit.html` },
    fsyncMan: { type: 'source', label: 'Linux man page · fsync(2), fdatasync(2)', href: 'https://man7.org/linux/man-pages/man2/fsync.2.html' },
    modelRules: { type: 'model', label: '화면 README · 모형의 가정 (스냅숏, 락, 정리, 로그)', href: `${REPO}docs/03-mysql-isolation-mvcc/README.md#모형의-가정` },
    anki: { type: 'record', label: '복습 카드 (anki/03-mysql-isolation-mvcc.md)', href: ANKI },
  };

  const TYPE_LABEL = { measured: '실측 기록', source: '소스·공식 문서', record: '실험 기록', model: '설명용 가정' };

  const SCENES = {
    count: {
      questions: [
        'A가 처음 2를 센 뒤 B가 같은 조건의 행을 넣고 커밋했다. A가 다시 셀 때 3이 나오는 읽기와 2가 나오는 읽기는 무엇이 다를까?',
        '스냅숏은 START TRANSACTION에서 만들어질까, 첫 읽기에서 만들어질까? MySQL과 PostgreSQL이 같을까?',
      ],
      observe: [
        '세션 상자의 "스냅숏 단계 k"는 그 스냅숏이 단계 k에 커밋을 마친 것까지만 본다는 뜻이다. 행 칸의 "←A"는 A의 스냅숏이 보는 버전이다.',
        'B가 넣은 id 4는 B가 커밋하기 전에는 점선 칸이다. 커밋한 뒤에도 A의 스냅숏에는 ←A가 붙지 않는다.',
        '"잠그며 세기"에서 FOR UPDATE는 스냅숏이 아니라 지금 커밋된 최신 행을 읽고 잠근다. 파란 선이 어느 행까지 가는지 본다.',
        '"연 뒤 처음 세기"와 "WITH CONSISTENT SNAPSHOT"을 견줘 스냅숏을 만드는 단계를 본다.',
        '"다른 표 UPDATE 먼저"에서 DB를 바꿔 A의 스냅숏이 만들어지는 단계가 달라지는지 본다.',
      ],
      measured: [
        '실험: Apple M2 Pro의 Docker Desktop, MySQL 8.4.13·PostgreSQL 18.6, 순서표 조건마다 워밍업 1회와 3회. 41개 조건이 네 번 모두 단계마다 같은 행·기다림·오류를 돌려줬다.',
        '문제 상황 1(MySQL): REPEATABLE READ 2, 3, 2. READ COMMITTED 2, 3, 3.',
        '1-1 처음 쓰는 조건(표 전체): REPEATABLE READ 3, READ COMMITTED 4(두 DB 같음).',
        '1-2 연 뒤 처음 세기: 두 DB, 두 격리 수준 모두 3. WITH CONSISTENT SNAPSHOT(MySQL): REPEATABLE READ 2, READ COMMITTED 3.',
        '1-2 변형 다른 표 UPDATE 먼저: REPEATABLE READ에서 MySQL 3, PostgreSQL 2. READ COMMITTED는 두 DB 모두 3.',
      ],
      evidence: ['readmeProblem1', 'readmeProblem1_1', 'readmeProblem1_2', 'readmeProblem1_2v', 'readmeBatch13', 'readmeTimelineRules', 'readmeEnv', 'isolationData', 'timelines', 'isolationLab', 'docConsistent', 'docLockingReads', 'pgIso'],
      cards: ['03-007', '03-008', '03-009', '03-010', '03-011', '03-012', '03-013'],
    },
    report: {
      questions: [
        'A가 잔액을 세 번 읽는 사이 B가 1000을 700으로 고치고 커밋한다. 격리 수준 네 단계에서 A의 둘째·셋째 읽기는 각각 무엇일까?',
        'MySQL SERIALIZABLE에서는 누가 누구를 기다릴까? PostgreSQL SERIALIZABLE은 같을까?',
      ],
      observe: [
        'READ UNCOMMITTED에서 A의 둘째 읽기가 B의 점선 칸(커밋하기 전 버전)을 읽는지 본다.',
        'READ COMMITTED는 문장마다 스냅숏을 만들고 버린다. 세션 상자에 남는 스냅숏이 없는 것을 REPEATABLE READ와 견준다.',
        'MySQL SERIALIZABLE은 A의 평범한 SELECT가 공유 락(S)을 건다. B의 UPDATE가 그 행에 점선으로 기다리고, B의 COMMIT이 미뤄지는 것을 본다.',
        'PostgreSQL의 READ UNCOMMITTED는 READ COMMITTED처럼 동작한다.',
      ],
      measured: [
        'MySQL: READ UNCOMMITTED 700, 700. READ COMMITTED 1000, 700. REPEATABLE READ 1000, 1000. SERIALIZABLE 1000, 1000이고 B의 UPDATE가 A의 COMMIT까지 1.74초 기다렸으며 B의 COMMIT은 그 뒤에 나갔다.',
        'PostgreSQL: READ UNCOMMITTED·READ COMMITTED 1000, 700. REPEATABLE READ·SERIALIZABLE 1000, 1000. 기다림 없음.',
        '기다림은 0.5초 안에 끝나지 않은 문장을 기다림으로 기록하는 실험 규칙으로 판정했다.',
      ],
      evidence: ['readmeProblem2', 'readmeBatch13', 'readmeTimelineRules', 'readmeEnv', 'isolationData', 'timelines', 'docIsoMysql', 'docConsistent', 'pgIso'],
      cards: ['03-003', '03-004', '03-005', '03-006', '03-012', '03-017'],
    },
    locking: {
      questions: [
        'A가 행 1, 2를 읽은 뒤 B가 id 4를 넣고 커밋했다. A가 같은 조건을 FOR UPDATE로 읽으면 MySQL과 PostgreSQL은 각각 어떤 행을 돌려줄까?',
        'SERIALIZABLE에서 B의 INSERT는 바로 끝날까? 두 DB가 같을까?',
      ],
      observe: [
        'MySQL에서 잠그며 읽을 때 파란 선이 어느 행과 "행 사이" 칸까지 가는지 본다. REPEATABLE READ 이상에서 기본 키가 아닌 조건으로 훑으면 행 사이 범위도 잠근다.',
        'MySQL SERIALIZABLE은 A의 평범한 SELECT부터 공유 락을 건다. B의 INSERT가 "행 사이" 칸에서 기다린다.',
        'PostgreSQL의 FOR UPDATE는 스냅숏으로 찾은 행을 잠근다. REPEATABLE READ에서 B의 id 4가 결과에 들어가는지 본다.',
      ],
      measured: [
        'MySQL: READ COMMITTED 1,2,4 · 1,2,4. REPEATABLE READ 1,2,4 · 1,2. SERIALIZABLE 1,2 · 1,2이고 B의 INSERT가 A의 COMMIT까지 1.74~1.75초 기다렸다.',
        'PostgreSQL: READ COMMITTED 1,2,4 · 1,2,4. REPEATABLE READ와 SERIALIZABLE 1,2 · 1,2이고 기다림도 오류도 없었다.',
      ],
      evidence: ['readmeProblem1_3', 'readmeBatch13', 'readmeEnv', 'isolationData', 'timelines', 'docLockingReads', 'docInnodbLocking', 'docIsoMysql', 'pgIso', 'pgLocking'],
      cards: ['03-014', '03-015', '03-016', '03-017', '03-021'],
    },
    deduct: {
      questions: [
        '두 요청이 각각 1000을 읽고 700과 500으로 고친 뒤 커밋한다. 격리 수준마다 최종 잔액은 얼마일까? 둘 다 반영된 200이 나오는 조건이 있을까?',
        'B의 UPDATE는 기다릴까? 기다린 뒤에는 그대로 고칠까, 오류로 끝날까?',
      ],
      observe: [
        'A의 UPDATE가 행에 배타 락(X)을 쥔 동안 B의 UPDATE가 점선으로 기다린다. A가 커밋하면 B가 무엇을 기준으로 고치는지 본다.',
        'MySQL은 B가 읽은 뒤 A가 커밋한 700을 보지 않고 500으로 덮어쓴다(주황 문장). PostgreSQL REPEATABLE READ 이상은 오류 40001로 끝낸다.',
        'MySQL SERIALIZABLE은 두 SELECT가 모두 공유 락을 쥐어 두 UPDATE가 서로 기다리는 고리가 된다. 주황 선이 고리다.',
      ],
      measured: [
        'MySQL READ UNCOMMITTED·READ COMMITTED·REPEATABLE READ: B의 UPDATE가 A의 COMMIT까지 0.81~0.82초 기다린 뒤 고쳐 최종 500.',
        'PostgreSQL READ UNCOMMITTED·READ COMMITTED: 같은 기다림 뒤 고쳐 최종 500. REPEATABLE READ·SERIALIZABLE: 0.81~0.82초 기다린 뒤 오류 40001, 최종 700.',
        'MySQL SERIALIZABLE: A의 UPDATE가 기다리는 중 B의 UPDATE에서 오류 1213(데드락), A의 UPDATE가 이어서 끝남(0.82초), 최종 700.',
        '200은 어느 조건에서도 나오지 않았다.',
      ],
      evidence: ['readmeProblem3', 'readmeBatch13', 'readmeEnv', 'isolationData', 'timelines', 'docIsoMysql', 'docDeadlock', 'pgIso'],
      cards: ['03-018', '03-019', '03-020', '03-021'],
    },
    hold: {
      questions: [
        'A가 트랜잭션을 열어 둔 채 B가 한 행을 계속 고친다. 경우 (가)~(바) 중 이전 버전이 지워지지 않고 남는 것은 어느 경우일까? 두 DB가 같을까?',
        'B가 다 고친 뒤 A가 그 행을 처음 읽으면 무슨 값을 받을까? 그 읽기는 C의 읽기보다 오래 걸릴까?',
      ],
      observe: [
        'MySQL은 표에 최신 버전만 두고 이전 버전을 undo log에 남긴다. 회색 칸이 그 이전 버전이다. purge가 지우는지, 지우지 못하는지(주황 문장) 본다.',
        'PostgreSQL은 이전 버전(dead tuple)도 표 안에 남는다. 그 페이지를 읽거나 고치는 문장이 HOT pruning으로 지운다.',
        '이전 버전을 지우지 못하는 원인은 A가 그 행을 읽었는지가 아니라 A에게 스냅숏이 있는지다. (마)와 (바)에서 DB를 바꿔 본다.',
        'A의 읽기 문장에서 MySQL이 undo log를 몇 단계 되짚는지, PostgreSQL이 튜플 몇 개를 확인하는지 본다.',
      ],
      measured: [
        '실험은 B가 1만 번 고쳤다. 이 장면은 구성에서 고른 횟수(기본 4번)로 줄였다.',
        'B가 끝난 직후 MySQL History list length: (가) 271·276·304, (나) 10002, (다) 92·59·259, (라) 64·80·301, (마) 39·119·310, (바) 10002. PostgreSQL dead but not yet removable: (나)(마)(바) 10000, 나머지 0.',
        'A가 B 뒤에 처음 읽은 값: (나)(바)와 PostgreSQL (마)는 1000, 나머지는 11000. 새 세션 C는 모두 11000.',
        '(나)의 읽기 시간: MySQL A 9.3배(약 0.3 → 2.9ms), C 0.89배. PostgreSQL A 1.33배, C 1.62배. B의 UPDATE 한 번은 MySQL 평평(1.03~1.09배), PostgreSQL 1.36·1.13·1.34배.',
        'A가 COMMIT한 뒤: PostgreSQL VACUUM이 1만 개를 지웠지만 표 크기는 368,640바이트(시작 8,192) 그대로. MySQL History list length는 3초 뒤 2203·0·0.',
      ],
      evidence: ['readmeProblem4', 'readmeProblem4v', 'readmeProblem4_1', 'readmeProblem4_2', 'readmeProblem4_3', 'readmeBatch2', 'readmeHoldRules', 'readmeObserved', 'readmeHistory', 'historyData', 'historyLab', 'docMultiVersion', 'docUndo', 'docPurge', 'pgVacuum', 'pgHot', 'pgSnapshot'],
      cards: ['03-022', '03-023', '03-024', '03-025', '03-026', '03-027', '03-028', '03-029', '03-030'],
    },
    engine: {
      questions: [
        '한 트랜잭션에서 InnoDB 표와 MyISAM 표에 한 줄씩 넣고 ROLLBACK하면 두 표에는 각각 몇 줄이 남을까? ROLLBACK은 오류를 낼까?',
        '재고 리포트가 표 전체를 오래 읽는 중에 차감 UPDATE가 들어오면, MyISAM과 InnoDB에서 UPDATE는 기다릴까?',
      ],
      observe: [
        'MyISAM 표의 행은 넣는 순간 실선 칸(다른 세션에 보임)이다. ROLLBACK 뒤에 InnoDB 쪽만 사라지는 것을 본다.',
        'MyISAM은 문장이 도는 동안 표 전체에 락을 건다. 재고 표에서 A의 읽기가 쥔 표 읽기 락과 B의 점선을 본다.',
        'InnoDB의 평범한 SELECT는 락을 걸지 않고 시작할 때의 스냅숏으로 읽는다.',
      ],
      measured: [
        '문제 상황 5: B가 센 행 수는 ROLLBACK 전과 뒤 모두 orders 0, order_logs 1. ROLLBACK은 오류 없이 끝나고 SHOW WARNINGS에 경고 1196 "Some non-transactional changed tables couldn\'t be rolled back".',
        '문제 상황 5-1: MyISAM에서 B의 UPDATE가 A의 SELECT가 끝날 때까지 1.20~1.21초 기다렸고, A는 id 2의 qty 10을 읽었다. InnoDB에서 B의 UPDATE는 0.005~0.007초에 끝났고 A는 역시 10을 읽었다. A의 SELECT는 두 엔진 모두 2.01~2.02초.',
      ],
      evidence: ['readmeProblem5', 'readmeProblem5_1', 'readmeBatch13', 'readmeObserved', 'readmeEnv', 'isolationData', 'timelines', 'docMyisam', 'docCommit', 'docInternalLocking', 'docConsistent'],
      cards: ['03-001', '03-002', '03-031', '03-032', '03-033'],
    },
    commit: {
      questions: [
        'MySQL 기본 설정에서 커밋 한 번은 fsync를 몇 번 기다릴까? 하나만 빼면 처리량이 크게 늘까?',
        '설정을 바꾼 뒤 DB 프로세스만 죽을 때와 OS까지 죽을 때, 앱이 끝났다고 받은 커밋 중 무엇을 잃을 수 있을까?',
      ],
      observe: [
        '로그 상자는 기록이 있는 곳을 DB 메모리, OS 페이지 캐시, 디스크로 나눠 보인다. fsync가 끝나야 디스크 칸으로 내려간다.',
        '앱에서 로그 상자로 가는 점선은 fsync가 끝나기를 기다리는 것이다. 커밋 하나에 점선이 몇 번 나오는지 센다.',
        '"구성 더 바꾸기"에서 장애를 고르면 마지막 단계에 무엇이 사라지는지 본다. 장애는 마지막 커밋 직후, 백그라운드 fsync 전에 난 것으로 둔다.',
      ],
      measured: [
        '실험: 자동 커밋 INSERT 3,000번, 설정마다 3회. MySQL 기본값(1, 1) 초당 899, p50 0.82ms. (2, 1) 1.11배, (1, 0) 2.50배, (2, 0) 2.77배.',
        'PostgreSQL 기본값(on) 초당 2482, p50 0.32ms. off 1.26배.',
        '지연 p50으로 본 몫: redo log fsync 약 0.09ms, binary log fsync 약 0.46ms(약 5배). 같은 디스크의 8KB 동기 쓰기는 이어 쓰기 0.739·0.658ms, 미리 만든 파일 덮어쓰기 0.088·0.087ms(0.12·0.13배).',
        '컨테이너에서 임시로 잰 배수는 (2, 1) 1.37배, PostgreSQL off 3.65배로 맥과 달랐다. 숫자는 그 환경의 값이다.',
      ],
      evidence: ['readmeProblem6', 'readmeBatch4', 'readmeDurabilityRules', 'readmeFsync', 'readmeAppend', 'readmeSyncWrite', 'readmeContainer', 'durabilityData', 'syncWriteData', 'durabilityLab', 'syncWriteLab', 'docFlush', 'docBinlog', 'docRedo', 'pgWalConfig', 'pgAsync', 'fsyncMan'],
      cards: ['03-034', '03-035', '03-036', '03-037', '03-038'],
    },
  };

  const ELEMENTS = {
    session: {
      kind: 'DB 세션(연결)',
      concept: '클라이언트가 DB에 연 연결 하나다. 한 세션은 앞 문장이 돌아와야 다음 문장을 보내고, 그 세션의 트랜잭션과 스냅숏을 가진다.',
      props: [
        '트랜잭션은 START TRANSACTION부터 COMMIT이나 ROLLBACK까지다. 트랜잭션 밖의 문장은 문장 하나가 트랜잭션이다(자동 커밋).',
        '스냅숏은 "이 시점에 커밋을 마친 트랜잭션의 변경만 보인다"를 판정하는 정보다. MySQL은 REPEATABLE READ의 첫 consistent read에서, PostgreSQL은 REPEATABLE READ 이상의 첫 문장에서 만들고 트랜잭션 끝까지 쓴다. READ COMMITTED는 문장마다 만들고 버린다.',
        '잠그며 읽기(FOR UPDATE, MySQL SERIALIZABLE의 평범한 SELECT)와 MySQL의 UPDATE는 스냅숏이 아니라 지금 커밋된 최신 행을 읽는다.',
        '다른 트랜잭션이 쥔 락과 부딪히면 그 락이 풀릴 때까지 기다린다. 기다리는 동안 이 세션의 다음 문장은 보내지 못하고 미룬다.',
      ],
      ev: ['readmeTimelineRules', 'docConsistent', 'pgIso', 'modelRules'],
      cards: ['03-007', '03-010', '03-012'],
    },
    purge: {
      kind: 'InnoDB 백그라운드 스레드',
      concept: 'purge 스레드는 더는 필요 없는 undo log(이전 버전)를 백그라운드에서 지운다. 가장 오래된 read view보다 뒤에 생긴 이전 버전은 지우지 않는다.',
      props: [
        '실제로는 주기적으로 돌아, 실험의 (가)에서도 B가 끝난 직후 수십~300여 개가 남아 있었다. 이 화면은 B가 커밋할 때마다 돈다고 줄였다.',
        'History list length는 커밋했지만 purge가 아직 처리하지 못한 트랜잭션 수다.',
        'MySQL 8.4.13 소스로 보면 History list length가 5000보다 작고 줄지 않으면 쉬러 들어가고, 행을 바꾸는 새 DML이 올 때까지 다시 일어나지 않는다(소스로 한 추론, 실험에서 확인하지 않음).',
      ],
      ev: ['docPurge', 'docMultiVersion', 'readmeHistory', 'readmeObserved'],
      cards: ['03-022', '03-029'],
    },
    vacuum: {
      kind: 'PostgreSQL VACUUM (관찰 세션이 돌림)',
      concept: 'VACUUM은 표 전체를 훑어 아무 스냅숏도 볼 수 없는 dead tuple을 지운다. 실험은 이 표의 자동 VACUUM을 끄고 직접 돌려 보고를 읽었다.',
      props: [
        'xmin horizon(가장 오래된 스냅숏)보다 뒤에 죽은 튜플은 "dead but not yet removable"로 남긴다.',
        '비운 공간은 표 안에서 다시 쓰게 표시할 뿐 파일을 줄이지 않는다. 끝쪽 페이지가 통째로 빈 경우만 운영체제에 돌려준다. 파일까지 줄이려면 VACUUM FULL이 표를 새로 쓴다.',
      ],
      ev: ['pgVacuum', 'readmeProblem4_3', 'readmeHoldRules'],
      cards: ['03-022', '03-028'],
    },
    app: {
      kind: '앱의 연결',
      concept: '자동 커밋 INSERT를 하나씩 보내는 연결이다. 커밋이 끝났다는 응답을 받아야 다음 INSERT를 보낸다.',
      props: [
        '커밋 응답을 받은 앱은 그 변경이 남는다고 믿고 다음 일을 한다(예: 영수증 보내기). 응답 뒤에 잃을 수 있는 설정은 이 믿음을 깬다.',
        '실험은 연결 하나로 3,000번 넣어 초당 수와 지연을 쟀다.',
      ],
      ev: ['durabilityLab', 'readmeDurabilityRules'],
      cards: ['03-034', '03-035'],
    },
    writer: {
      kind: '백그라운드 로그 쓰기',
      concept: '커밋과 따로, 정해진 간격으로 로그를 디스크에 내리는 스레드다. MySQL은 innodb_flush_log_at_trx_commit=2일 때 약 1초마다 redo log를 fsync하고, PostgreSQL은 WAL writer가 synchronous_commit=off인 커밋의 WAL을 내린다.',
      props: [
        'PostgreSQL에서 잃을 수 있는 최근 커밋은 최대 wal_writer_delay(기본 200ms)의 3배다.',
        'sync_binlog=0이면 binary log는 OS가 정한 때에 디스크에 내린다. 이 화면은 그 때를 그리지 않는다.',
      ],
      ev: ['docFlush', 'docBinlog', 'pgWalConfig', 'pgAsync'],
      cards: ['03-034', '03-035'],
    },
    'table-innodb': {
      kind: '표 · InnoDB',
      concept: '트랜잭션과 MVCC를 지원하는 storage engine의 표다. 행마다 최신 버전을 표(클러스터드 인덱스)에 두고, 고치기 전 값은 undo log에 남긴다.',
      props: [
        '커밋하기 전의 변경은 다른 트랜잭션의 스냅숏에 보이지 않는다. ROLLBACK하면 undo log로 되돌린다.',
        '행 단위로 락을 건다. 평범한 SELECT는 락을 걸지 않는다(MySQL SERIALIZABLE의 트랜잭션 안은 예외).',
        'MySQL 5.5부터 기본 storage engine이다.',
      ],
      ev: ['docMultiVersion', 'docInnodbLocking', 'docConsistent'],
      cards: ['03-022', '03-031'],
    },
    'table-pg': {
      kind: '표 · PostgreSQL',
      concept: 'UPDATE가 표 안에 새 튜플을 쓰고, 이전 튜플(dead tuple)도 표에 남긴다. 각 튜플의 xmin·xmax를 스냅숏과 비교해 보이는지 판정한다.',
      props: [
        '이전 튜플은 VACUUM이 표 전체에서, HOT pruning이 페이지 하나 안에서 지운다.',
        '행 락은 UPDATE, DELETE, FOR UPDATE가 건다. 평범한 SELECT는 어느 격리 수준에서도 락을 걸지 않는다.',
      ],
      ev: ['pgIso', 'pgVacuum', 'pgHot', 'pgLocking'],
      cards: ['03-013', '03-022'],
    },
    'table-myisam': {
      kind: '표 · MyISAM',
      concept: '트랜잭션을 지원하지 않는 storage engine의 표다. 문장이 끝나는 순간 반영되어 다른 세션에 바로 보이고, ROLLBACK으로 되돌릴 수 없다.',
      props: [
        '문장이 도는 동안 표 전체에 락을 건다. 읽기 락끼리는 함께 쥘 수 있고, 쓰기 락은 읽기 락이 풀릴 때까지 기다린다.',
        '트랜잭션 안에서 이 표를 고친 뒤 ROLLBACK하면 오류 없이 경고 1196만 남긴다.',
      ],
      ev: ['docMyisam', 'docInternalLocking', 'docCommit'],
      cards: ['03-031', '03-032', '03-033'],
    },
    row: {
      kind: '행과 행 버전',
      concept: '칸 하나가 행 하나이고, 칸 안의 작은 상자는 그 행의 버전이다. 맨 위가 가장 새 버전이고 아래로 갈수록 오래된 버전이다.',
      props: [
        '실선 상자는 커밋된 버전, 점선 상자는 아직 커밋하지 않은 트랜잭션이 쓴 버전, 회색 상자는 더 새 버전이 있는 이전 버전이다(MySQL은 undo log에, PostgreSQL은 표 안에 있다).',
        '"←A"는 A의 스냅숏이 이 행에서 보는 버전이다. 표시가 없는 행은 A의 스냅숏에 보이지 않는다.',
        '칸 위의 "X A"·"S A"는 그 행에 쥔 락(배타·공유)과 쥔 세션이다. 락은 트랜잭션이 끝날 때 놓는다.',
      ],
      ev: ['docMultiVersion', 'docInnodbLocking', 'pgIso', 'modelRules'],
      cards: ['03-013', '03-014'],
    },
    gap: {
      kind: '행 사이 범위 (InnoDB)',
      concept: '인덱스의 행과 행 사이 빈자리다. REPEATABLE READ 이상에서 기본 키가 아닌 조건으로 잠그며 읽으면 InnoDB는 훑은 행과 그 사이 범위를 함께 잠근다(next-key lock).',
      props: [
        '범위 락은 다른 트랜잭션이 그 범위에 새 행을 넣지 못하게 한다. 범위 락끼리는 부딪히지 않는다.',
        '이 화면은 표의 모든 범위를 칸 하나로 그린다. 범위를 나누는 자세한 규칙은 04 실험에서 다룬다.',
        'READ COMMITTED는 범위를 잠그지 않는다.',
      ],
      ev: ['docInnodbLocking', 'docIsoMysql', 'modelRules'],
      cards: ['03-016'],
    },
    'counter-mysql': {
      kind: 'MySQL History list length',
      concept: 'purge가 아직 처리하지 못한 커밋된 트랜잭션 수다. 이 화면에서는 남은 이전 버전 수와 같다(트랜잭션마다 한 행을 한 번 고쳤다).',
      props: [
        '실험은 SHOW ENGINE INNODB STATUS의 TRANSACTIONS 부분에서 읽었다. 이 표만이 아니라 서버 전체의 값이다.',
        '줄지 않는 동안 오래된 스냅숏으로 읽는 쪽은 undo log를 되짚는 데 시간이 든다.',
      ],
      ev: ['readmeBatch2', 'docPurge', 'historyLab'],
      cards: ['03-023', '03-026', '03-029'],
    },
    'counter-pg': {
      kind: 'PostgreSQL dead tuple',
      concept: '표 안에 남은 이전 튜플 수다. 열린 스냅숏이 볼 수 있으면 VACUUM이 "dead but not yet removable"로 보고하고 지우지 않는다.',
      props: [
        '실험은 VACUUM (VERBOSE)의 보고에서 읽었다. 남은 튜플만큼 표가 커져, 1만 개가 남은 경우 페이지 1개에서 45개(368,640바이트)가 되었다.',
        '남은 튜플은 그 행을 읽는 모든 쪽이 지나가며 확인한다. A뿐 아니라 새 세션 C의 읽기도 느려진다.',
      ],
      ev: ['readmeBatch2', 'pgVacuum', 'historyLab'],
      cards: ['03-023', '03-026', '03-028'],
    },
    'log-redo': {
      kind: 'InnoDB redo log',
      concept: '장애 뒤 InnoDB가 커밋한 변경을 다시 적용하는 로그다. 미리 만든 고정 크기 파일(#innodb_redo)을 돌려 쓴다.',
      props: [
        'innodb_flush_log_at_trx_commit=1(기본)이면 커밋마다 쓰고 fsync한다. 2면 커밋마다 OS에 쓰기만 하고 fsync는 약 1초마다 한다. 2에서 mysqld만 죽으면 남고, OS가 죽거나 전원이 꺼지면 마지막 약 1초의 커밋을 잃을 수 있다.',
        '이 맥에서 redo log fsync의 몫은 지연 p50으로 약 0.09ms였다.',
      ],
      ev: ['docFlush', 'docRedo', 'readmeFsync'],
      cards: ['03-034', '03-035', '03-036'],
    },
    'log-binlog': {
      kind: 'MySQL binary log',
      concept: '복제와 시점 복구에 쓰는 로그다. MySQL 8.4에서 기본으로 켜져 있고, 커밋마다 파일 끝에 바이트가 붙어 파일이 커진다.',
      props: [
        'sync_binlog=1(기본)이면 커밋마다 fsync한다. 0이면 OS에 맡겨, OS나 기계가 죽으면 마지막 문장을 잃을 수 있다.',
        '이 맥에서 binary log fsync의 몫은 약 0.46ms로 redo log의 약 5배였다. 파일 크기가 바뀌면 fdatasync가 metadata도 내려야 하기 때문으로 추론했다.',
      ],
      ev: ['docBinlog', 'readmeFsync', 'readmeAppend', 'fsyncMan'],
      cards: ['03-034', '03-035', '03-036', '03-037'],
    },
    'log-wal': {
      kind: 'PostgreSQL WAL',
      concept: '장애 뒤 커밋한 변경을 다시 적용하는 로그다. 16MB 세그먼트를 미리 만들어 그 자리를 채워 쓴다.',
      props: [
        'synchronous_commit=on(기본)이면 WAL을 디스크에 내린 뒤 커밋 완료를 알린다. off면 내리기 전에 알려, 최근 커밋(최대 wal_writer_delay의 3배)을 잃을 수 있지만 DB가 깨지지는 않는다.',
        'off에서는 WAL이 아직 DB 메모리에 있을 수 있어 DB만 죽어도 잃을 수 있다.',
      ],
      ev: ['pgWalConfig', 'pgAsync', 'readmeBatch4'],
      cards: ['03-034', '03-035', '03-038'],
    },
  };

  const CARDS = {
    '03-001': '트랜잭션에서 COMMIT과 ROLLBACK은 각각 무엇을 확정하고 무엇을 되돌리는가? MyISAM 표가 섞이면 무엇이 달라지는가?',
    '03-002': 'ACID의 네 성질(원자성, 일관성, 격리성, 지속성)을 이번 실험에서 무엇이 지켰는지, 또는 어디서 깨졌는지로 말하라.',
    '03-003': 'dirty read, non-repeatable read, phantom read는 각각 무엇인가?',
    '03-004': 'SQL 표준의 격리 수준 네 단계는 세 이상현상 중 무엇을 막는가? 실제 DB가 표와 다르게 동작할 수 있는 이유는?',
    '03-005': '리포트(A)가 트랜잭션 안에서 잔액을 세 번 읽는 사이 결제(B)가 1000을 700으로 고치고 커밋한다. A의 둘째 읽기는 B가 커밋하기 전, 셋째는 뒤다. MySQL에서 격리 수준 네 단계별로 둘째·셋째 값과 기다림은?',
    '03-006': '세션 하나의 격리 수준은 MySQL과 PostgreSQL에서 각각 어떻게 바꾸는가? 실험은 어떤 범위로 걸었는가?',
    '03-007': 'MVCC의 스냅숏(MySQL에서는 read view)은 무엇을 담는가? 트랜잭션마다 만들면 DB 크기만큼 메모리를 쓰는가?',
    '03-008': 'MySQL 기본 설정(REPEATABLE READ)에서 A가 트랜잭션 안에서 user_id = 7의 응모 수를 세어 2를 얻은 뒤, B가 응모 한 줄을 넣고 커밋했다. A가 같은 조건을 FOR UPDATE로 세면 3, 다시 평범한 SELECT로 세면 2다. 왜 그런가?',
    '03-009': '"REPEATABLE READ는 같은 조건의 조회 결과를 캐시해 두었다가 돌려준다"는 가설을 실험은 어떻게 가렸는가?',
    '03-010': 'REPEATABLE READ에서 스냅숏은 언제 만들어지는가? A가 START TRANSACTION만 하고 아무것도 읽지 않았을 때 B가 행을 넣고 커밋하면, A의 첫 SELECT에 B의 행이 보이는가?',
    '03-011': 'REPEATABLE READ에서 A가 트랜잭션을 열고 먼저 다른 표를 UPDATE한 뒤, B가 응모 한 줄을 넣고 커밋했다. 그다음 A가 응모 수를 세면 MySQL과 PostgreSQL에서 각각 몇인가(처음 2줄)?',
    '03-012': 'READ COMMITTED에서 스냅숏은 언제 만들어지고 언제 버려지는가? 응모 수를 2로 센 뒤 B가 한 줄을 넣고 커밋했을 때, 같은 트랜잭션의 FOR UPDATE 세기와 평범한 다시 세기는 몇인가?',
    '03-013': 'InnoDB의 consistent read는 행 하나를 읽을 때 스냅숏(read view)으로 무엇을 따지고, 보이지 않으면 어떻게 하는가?',
    '03-014': '공유 락(S)과 배타 락(X)은 각각 무엇을 허락하고 무엇과 충돌하는가? 평범한 SELECT는 어느 락을 거는가?',
    '03-015': 'REPEATABLE READ에서 A가 user_id = 7의 행(1, 2)을 읽은 뒤 B가 id 4를 넣고 커밋했다. A가 같은 조건을 FOR UPDATE로 읽고, 다시 평범하게 읽는다. MySQL과 PostgreSQL의 결과는? InnoDB REPEATABLE READ에서 팬텀이 보이는가?',
    '03-016': 'MySQL SERIALIZABLE에서 A가 user_id = 7의 행을 평범하게 읽은 뒤, B가 A가 읽지 않은 새 행(id 4)을 넣으려 한다. B는 어떻게 되는가? 같은 순서표의 PostgreSQL SERIALIZABLE은?',
    '03-017': 'SERIALIZABLE은 무엇을 보장하는 수준인가? MySQL과 PostgreSQL은 각각 어떤 방법으로 지키는가?',
    '03-018': '잔액 1000을 A(300 차감)와 B(500 차감)가 각각 읽고, 앱에서 계산한 700과 500으로 UPDATE한 뒤 커밋한다. A의 UPDATE와 COMMIT이 B의 UPDATE보다 먼저 보내졌다. MySQL READ COMMITTED·REPEATABLE READ에서 무슨 일이 생기는가?',
    '03-019': '같은 차감 순서표를 PostgreSQL에서 돌리면 READ COMMITTED와 REPEATABLE READ의 결과가 어떻게 다른가?',
    '03-020': 'MySQL SERIALIZABLE에서 차감 순서표(둘 다 읽은 뒤 각자 UPDATE)를 돌리면 어떻게 되는가?',
    '03-021': 'UPDATE, DELETE, FOR UPDATE가 고치거나 잠글 행을 찾는 기준은 MySQL과 PostgreSQL(READ COMMITTED, REPEATABLE READ)에서 각각 무엇인가?',
    '03-022': '행을 고친 뒤 고치기 전 버전은 InnoDB와 PostgreSQL에서 각각 어디에 남는가? 필요 없어진 버전은 누가 지우는가?',
    '03-023': 'A가 REPEATABLE READ 트랜잭션에서 visits 표만 읽고 커밋하지 않은 채, B가 accounts의 한 행을 1만 번 고쳤다(자동 커밋). A는 accounts를 한 번도 읽지 않았다. 이전 버전은 얼마나 남고, 그 뒤 A가 accounts를 처음 읽으면 무슨 값을 받는가?',
    '03-024': 'B가 한 행을 1만 번 고치는 동안 A가 해 둔 일만 다르다: (가) 트랜잭션 없음, (나) REPEATABLE READ로 그 행을 읽고 둠, (다) READ COMMITTED로 읽고 둠, (라) REPEATABLE READ로 열기만 함, (마) REPEATABLE READ로 다른 표를 UPDATE함. B가 끝난 직후 이전 버전이 1만 근처로 남는 경우는(MySQL, PostgreSQL)?',
    '03-025': 'PostgreSQL에서 이 표의 자동 VACUUM을 꺼 두었는데, 열린 스냅숏 없이 B가 한 행을 1만 번 고친 뒤 dead tuple이 0이고 표 크기도 8,192바이트 그대로였다. 무엇이 지웠는가?',
    '03-026': 'A가 REPEATABLE READ로 한 행을 읽어 스냅숏을 만든 채 두고 B가 그 행을 1만 번 고쳤다. 그 뒤 A와 새 세션 C가 그 행을 읽는 시간은 A가 없을 때와 비교해 MySQL과 PostgreSQL에서 어떻게 달라졌는가? 왜 그런가?',
    '03-027': '같은 상황(오래 열린 스냅숏이 있는 동안 B가 한 행을 1만 번 고침)에서 B의 UPDATE 한 번의 시간은 뒤로 갈수록 늘어나는가? MySQL과 PostgreSQL 각각.',
    '03-028': '오래 열린 트랜잭션 때문에 PostgreSQL 표가 8,192바이트에서 368,640바이트로 커졌다. 그 트랜잭션이 커밋한 뒤 VACUUM을 돌리면 dead tuple과 표 크기는 어떻게 되는가?',
    '03-029': '오래 열린 트랜잭션이 커밋한 뒤 MySQL History list length(10002)는 세 번 중 두 번 3초 안에 0이 되었는데, 한 번은 2203에서 10초 동안 그대로였다. 소스로 보면 어떻게 설명되는가?',
    '03-030': '읽기만 하는 트랜잭션도 오래 열어 두면 안 되는 이유는? 실험에서 무엇이 커졌는가?',
    '03-031': 'InnoDB와 MyISAM은 트랜잭션, 다른 세션에 보이는 때, 락의 범위에서 어떻게 다른가?',
    '03-032': '주문 요청이 트랜잭션 안에서 InnoDB 표 orders와 MyISAM 표 order_logs에 한 행씩 넣은 뒤 결제 실패로 ROLLBACK했다. 그사이와 그 뒤 다른 세션이 센 두 표의 행 수는? ROLLBACK은 어떻게 끝났는가?',
    '03-033': '재고 리포트(A, 자동 커밋)가 stock 표 전체를 약 2초 동안 읽는 중에 B가 상품 2의 재고를 1 줄인다. MyISAM과 InnoDB에서 B는 기다리는가? A가 읽은 상품 2의 재고는?',
    '03-034': '커밋할 때 MySQL과 PostgreSQL은 어떤 로그를 디스크에 내리는가? 그 시점을 정하는 설정과 값은?',
    '03-035': 'innodb_flush_log_at_trx_commit=2, sync_binlog=0, PostgreSQL synchronous_commit=off는 장애가 나면 각각 무엇을 잃을 수 있는가?',
    '03-036': '맥에서 자동 커밋 INSERT의 초당 수는 MySQL 기본값(1, 1)에 비해 redo log fsync만 뺀 설정(2, 1)이 1.11배, binary log fsync만 뺀 설정(1, 0)이 2.50배, 둘 다 뺀 설정(2, 0)이 2.77배였다. 무엇을 알 수 있는가?',
    '03-037': '같은 디스크, 같은 fdatasync인데 MySQL binary log의 fsync가 redo log나 PostgreSQL WAL보다 훨씬 비쌌다. 파일이 어떻게 변하는지로 설명하라. 실험은 이를 어떻게 확인했는가?',
    '03-038': '같은 실험 코드와 DB 버전으로 컨테이너(클라우드 Linux VM)와 맥(Docker Desktop)에서 잰 결과는 무엇이 같고 무엇이 달랐는가? 숫자를 어떻게 읽어야 하는가?',
  };

  root.MvccContent = { EV, TYPE_LABEL, SCENES, ELEMENTS, CARDS };
})(typeof self !== 'undefined' ? self : this);
