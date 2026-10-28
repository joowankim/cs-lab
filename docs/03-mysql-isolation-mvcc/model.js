/*
 * MVCC 관계도의 설명용 실행 모형.
 *
 * 묶음 1·3의 순서표는 실험(isolation_timelines.py)과 같은 SQL을 같은 순서로 보낸다. 한 단계는 순서표의 한 줄이다.
 * 실험의 실행 틀처럼 한 세션은 앞 문장이 끝나야 다음 문장을 보내고, 끝나지 않은 문장은 "기다림"으로 남긴다.
 * 행 버전, 스냅숏, 락의 규칙은 MySQL 8.4 InnoDB와 PostgreSQL 18 문서를 이 순서표에 필요한 만큼만 단순화했다.
 * 묶음 2(열어 둔 트랜잭션)와 묶음 4(지속성 설정)는 실험의 순서를 줄인 설명용 순서다.
 * 단계는 이벤트의 순서이고 시간 길이가 아니다.
 * 브라우저에서는 window.MvccModel, Node.js에서는 require()로 쓴다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MvccModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2026-10-28.1';
  const LEVELS = ['RU', 'RC', 'RR', 'SER'];
  const LEVEL_NAME = { RU: 'READ UNCOMMITTED', RC: 'READ COMMITTED', RR: 'REPEATABLE READ', SER: 'SERIALIZABLE' };
  const DB_NAME = { mysql: 'MySQL', postgres: 'PostgreSQL' };
  const DEFAULT_LEVEL = { mysql: 'RR', postgres: 'RC' };
  const WARN_1196 = "Some non-transactional changed tables couldn't be rolled back";

  function josa(word, pair) {
    const w = String(word).trim().replace(/[)\]]+$/, '');
    const ch = w.slice(-1);
    const code = ch.charCodeAt(0);
    let batchim;
    if (code >= 0xac00 && code <= 0xd7a3) batchim = (code - 0xac00) % 28 !== 0;
    else if (/[0-9]/.test(ch)) batchim = '013678'.includes(ch);
    else batchim = /[lmn]$/i.test(w) || /ng$/i.test(w);
    return word + (batchim ? pair[0] : pair[1]);
  }
  const I = (w) => josa(w, ['이', '가']);
  const N = (w) => josa(w, ['은', '는']);
  const R = (w) => josa(w, ['을', '를']);

  // ---------- 표와 순서표 ----------
  // 표마다 기본 키, 열, 처음 행, 관계도에 적을 값 글자. 순서표의 준비 SQL과 같다.

  const TABLES = {
    entries: { key: 'id', cols: ['id', 'user_id'], rows: [[1, 7], [2, 7], [3, 8]], text: (r) => `user ${r.user_id}` },
    visits: { key: 'id', cols: ['id', 'n'], rows: [[1, 0]], text: (r) => `n ${r.n}` },
    accounts: { key: 'id', cols: ['id', 'balance'], rows: [[1, 1000]], text: (r) => String(r.balance) },
    points: { key: 'user_id', cols: ['user_id', 'balance'], rows: [[7, 1000]], text: (r) => String(r.balance) },
    orders: { key: 'id', cols: ['id', 'amount'], rows: [], text: (r) => String(r.amount) },
    order_logs: { key: 'id', cols: ['id', 'order_id'], rows: [], text: (r) => `order ${r.order_id}` },
    stock: { key: 'id', cols: ['id', 'qty'], rows: [[1, 10], [2, 10]], text: (r) => `qty ${r.qty}` },
  };

  const W7 = { text: 'user_id = 7', fn: (r) => r.user_id === 7 };
  const PK = (v, col) => ({ text: `${col || 'id'} = ${v}`, fn: (r) => r[col || 'id'] === v, pk: v });
  const st = (s, sql, op, note) => ({ s, sql, op, note: note || '' });
  const BEGIN = (s, note) => st(s, 'START TRANSACTION', { k: 'begin' }, note);
  const COMMIT = (s, note) => st(s, 'COMMIT', { k: 'commit' }, note);
  const COUNT7 = 'SELECT COUNT(*) FROM entries WHERE user_id = 7';
  const ROWS7 = 'SELECT id FROM entries WHERE user_id = 7 ORDER BY id';
  const sel = (t, where, out, extra) => Object.assign({ k: 'select', parts: [{ t, where, out }] }, extra || {});
  const INSERT4 = (note) => st('B', 'INSERT INTO entries (id, user_id) VALUES (4, 7)', { k: 'insert', t: 'entries', row: { id: 4, user_id: 7 } }, note);
  const ENTRIES_SETUP = ['CREATE TABLE entries (id INT PRIMARY KEY, user_id INT NOT NULL)', 'INSERT INTO entries (id, user_id) VALUES (1, 7), (2, 7), (3, 8)'];
  const B_INSERTS = (note) => [BEGIN('B', note), INSERT4(note), COMMIT('B', note)];

  // 실험의 순서표(isolation_timelines.py)와 같은 SQL, 같은 순서다. dbs와 levels는 실험에서 돌린 조건이다.
  const TIMELINES = {
    'entries-count': {
      title: '문제 상황 1: 같은 트랜잭션에서 개수가 2, 3, 2로 바뀐 응모 확인', dbs: ['mysql'], levels: ['RR', 'RC'],
      tables: { entries: 'innodb' }, setup: ENTRIES_SETUP,
      steps: [BEGIN('A'), st('A', COUNT7, sel('entries', W7, 'count'), '1번'), ...B_INSERTS('2번: 다른 요청'),
        st('A', `${COUNT7} FOR UPDATE`, sel('entries', W7, 'count', { lock: 'X' }), '3번'), st('A', COUNT7, sel('entries', W7, 'count'), '4번'), COMMIT('A')],
    },
    'entries-total': {
      title: '문제 상황 1-1: 처음 쓰는 조건으로 다시 세기', dbs: ['mysql', 'postgres'], levels: ['RR', 'RC'],
      tables: { entries: 'innodb' }, setup: ENTRIES_SETUP,
      steps: [BEGIN('A'), st('A', COUNT7, sel('entries', W7, 'count'), '1번'), ...B_INSERTS('2번: 다른 요청'),
        st('A', 'SELECT COUNT(*) FROM entries', sel('entries', null, 'count'), '3번: 이 트랜잭션에서 처음 쓰는 조건'), COMMIT('A')],
    },
    'entries-late': {
      title: '문제 상황 1-2: 트랜잭션을 연 뒤 처음 세기', dbs: ['mysql', 'postgres'], levels: ['RR', 'RC'],
      tables: { entries: 'innodb' }, setup: ENTRIES_SETUP,
      steps: [BEGIN('A', '1번: 아직 아무것도 읽지 않음'), ...B_INSERTS('2번: 다른 요청'),
        st('A', COUNT7, sel('entries', W7, 'count'), '3번: 이 트랜잭션의 첫 읽기'), COMMIT('A')],
    },
    'entries-late-snapshot': {
      title: '문제 상황 1-2 피드백: 트랜잭션을 열 때 스냅숏 만들기', dbs: ['mysql'], levels: ['RR', 'RC'],
      tables: { entries: 'innodb' }, setup: ENTRIES_SETUP,
      steps: [st('A', 'START TRANSACTION WITH CONSISTENT SNAPSHOT', { k: 'begin', snap: true }, '1번'), ...B_INSERTS('2번: 다른 요청'),
        st('A', COUNT7, sel('entries', W7, 'count'), '3번: 이 트랜잭션의 첫 읽기'), COMMIT('A')],
    },
    'entries-late-update': {
      title: '문제 상황 1-2 변형: 첫 문장이 다른 표의 UPDATE', dbs: ['mysql', 'postgres'], levels: ['RR', 'RC'],
      tables: { entries: 'innodb', visits: 'innodb' },
      setup: ENTRIES_SETUP.concat(['CREATE TABLE visits (id INT PRIMARY KEY, n INT NOT NULL)', 'INSERT INTO visits (id, n) VALUES (1, 0)']),
      steps: [BEGIN('A', '1번'), st('A', 'UPDATE visits SET n = n + 1 WHERE id = 1', { k: 'update', t: 'visits', where: PK(1), set: (r) => ({ ...r, n: r.n + 1 }) }, '1번: 방문 수를 먼저 고침'),
        ...B_INSERTS('2번: 다른 요청'), st('A', COUNT7, sel('entries', W7, 'count'), '3번'), COMMIT('A')],
    },
    'entries-rows': {
      title: '문제 상황 1-3: 응모 행을 잠그며 읽기', dbs: ['mysql', 'postgres'], levels: ['RC', 'RR', 'SER'],
      tables: { entries: 'innodb' }, setup: ENTRIES_SETUP,
      steps: [BEGIN('A'), st('A', ROWS7, sel('entries', W7, 'ids'), '1번'), ...B_INSERTS('2번: 다른 요청'),
        st('A', `${ROWS7} FOR UPDATE`, sel('entries', W7, 'ids', { lock: 'X' }), '3번'), st('A', ROWS7, sel('entries', W7, 'ids'), '4번'), COMMIT('A')],
    },
    'balance-reads': {
      title: '문제 상황 2: 리포트가 읽은 잔액', dbs: ['mysql', 'postgres'], levels: LEVELS,
      tables: { accounts: 'innodb' }, setup: ['CREATE TABLE accounts (id INT PRIMARY KEY, balance INT NOT NULL)', 'INSERT INTO accounts (id, balance) VALUES (1, 1000)'],
      steps: [BEGIN('A', '1번: 리포트'), st('A', 'SELECT balance FROM accounts WHERE id = 1', sel('accounts', PK(1), 'balance'), '1번: (가)'),
        BEGIN('B', '2번: 결제'), st('B', 'UPDATE accounts SET balance = 700 WHERE id = 1', { k: 'update', t: 'accounts', where: PK(1), set: (r) => ({ ...r, balance: 700 }) }, '2번: 결제'),
        st('A', 'SELECT balance FROM accounts WHERE id = 1', sel('accounts', PK(1), 'balance'), '3번: (나)'), COMMIT('B', '4번: 결제'),
        st('A', 'SELECT balance FROM accounts WHERE id = 1', sel('accounts', PK(1), 'balance'), '5번: (다)'), COMMIT('A')],
    },
    'points-deduct': {
      title: '문제 상황 3: 동시에 차감한 포인트', dbs: ['mysql', 'postgres'], levels: LEVELS,
      tables: { points: 'innodb' }, setup: ['CREATE TABLE points (user_id INT PRIMARY KEY, balance INT NOT NULL)', 'INSERT INTO points (user_id, balance) VALUES (7, 1000)'],
      steps: [BEGIN('A', '1번: 300 차감 요청'), st('A', 'SELECT balance FROM points WHERE user_id = 7', sel('points', PK(7, 'user_id'), 'balance'), '1번: 읽은 값에서 300을 빼 계산'),
        BEGIN('B', '2번: 500 차감 요청'), st('B', 'SELECT balance FROM points WHERE user_id = 7', sel('points', PK(7, 'user_id'), 'balance'), '2번: 읽은 값에서 500을 빼 계산'),
        st('A', 'UPDATE points SET balance = 700 WHERE user_id = 7', { k: 'update', t: 'points', where: PK(7, 'user_id'), set: (r) => ({ ...r, balance: 700 }) }, '3번: 1000 - 300'),
        st('B', 'UPDATE points SET balance = 500 WHERE user_id = 7', { k: 'update', t: 'points', where: PK(7, 'user_id'), set: (r) => ({ ...r, balance: 500 }) }, '4번: 1000 - 500'),
        COMMIT('A', '5번'), COMMIT('B', '6번'), st('A', 'SELECT balance FROM points WHERE user_id = 7', sel('points', PK(7, 'user_id'), 'balance'), '7번: 최종 잔액')],
    },
    'order-rollback': {
      title: '문제 상황 5: 되돌린 주문과 남은 기록', dbs: ['mysql'], levels: ['RR'],
      tables: { orders: 'innodb', order_logs: 'myisam' },
      setup: ['CREATE TABLE orders (id INT PRIMARY KEY, amount INT NOT NULL) ENGINE=InnoDB', 'CREATE TABLE order_logs (id INT PRIMARY KEY, order_id INT NOT NULL) ENGINE=MyISAM'],
      steps: [BEGIN('A', '1번: 주문 요청'), st('A', 'INSERT INTO orders (id, amount) VALUES (1, 5000)', { k: 'insert', t: 'orders', row: { id: 1, amount: 5000 } }, '1번: 주문 (InnoDB)'),
        st('A', 'INSERT INTO order_logs (id, order_id) VALUES (1, 1)', { k: 'insert', t: 'order_logs', row: { id: 1, order_id: 1 } }, '1번: 주문 기록 (MyISAM)'),
        st('B', 'SELECT (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM order_logs)', { k: 'select', parts: [{ t: 'orders', out: 'count' }, { t: 'order_logs', out: 'count' }] }, '2번: (가)'),
        st('A', 'ROLLBACK', { k: 'rollback' }, '3번: 결제 실패, (나)'), st('A', 'SHOW WARNINGS', { k: 'warnings' }, '3번: (나)의 경고 목록'),
        st('B', 'SELECT (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM order_logs)', { k: 'select', parts: [{ t: 'orders', out: 'count' }, { t: 'order_logs', out: 'count' }] }, '4번: (다)')],
    },
  };
  for (const engine of ['MyISAM', 'InnoDB']) {
    TIMELINES[`stock-read-${engine.toLowerCase()}`] = {
      title: `문제 상황 5-1: 재고 리포트가 도는 중에 들어온 차감 (${engine})`, dbs: ['mysql'], levels: ['RR'],
      tables: { stock: engine.toLowerCase() },
      setup: [`CREATE TABLE stock (id INT PRIMARY KEY, qty INT NOT NULL) ENGINE=${engine}`, 'INSERT INTO stock (id, qty) VALUES (1, 10), (2, 10)'],
      steps: [st('A', 'SELECT id, qty FROM stock WHERE SLEEP(1) = 0', sel('stock', null, 'rows', { long: true }), '1번: 재고 리포트, 행마다 1초, (나)'),
        st('B', 'UPDATE stock SET qty = qty - 1 WHERE id = 2', { k: 'update', t: 'stock', where: PK(2), set: (r) => ({ ...r, qty: r.qty - 1 }) }, '2번: 재고 차감, (가)'),
        st('B', 'SELECT id, qty FROM stock ORDER BY id', sel('stock', null, 'rows'), '3번')],
    };
  }

  // ---------- 실행 상태 ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function makeState(db, opts) {
    const S = { db, step: 0, label: '0', nextTrx: 1, nextVer: 1, tables: {}, trx: {}, committed: [0], locks: [], sess: {}, order: [], ev: [], cycle: null, opts: opts || {} };
    return S;
  }

  function addTable(S, name, engine) {
    const spec = TABLES[name];
    const t = { name, engine, key: spec.key, rows: [] };
    for (const vals of spec.rows) {
      const r = Object.fromEntries(spec.cols.map((c, i) => [c, vals[i]]));
      t.rows.push({ k: r[spec.key], vers: [{ id: S.nextVer++, vals: r, trx: 0 }] });
    }
    S.tables[name] = t;
    return t;
  }

  function addSession(S, id, opts) {
    S.sess[id] = Object.assign({ id, name: id, iso: DEFAULT_LEVEL[S.db], trx: null, pending: null, deferred: [], warnings: [], last: '', err: '', lines: [], ran: false, script: [] }, opts || {});
    S.order.push(id);
    return S.sess[id];
  }

  function emit(S, type, text, ids, extra) { S.ev.push(Object.assign({ type, text, ids: ids || [] }, extra || {})); }

  function trxOf(S, sess) { return sess.trx != null ? S.trx[sess.trx] : null; }
  function sessName(S, trxId) { const t = S.trx[trxId]; return t ? t.sess : '?'; }
  function isCommitted(S, trxId) { return S.committed.includes(trxId); }

  function newTrx(S, sess, auto) {
    const id = S.nextTrx++;
    S.trx[id] = { id, sess: sess.id, iso: sess.iso, state: 'active', auto: !!auto, snap: null, stmtSnap: null, reads: {}, lastRead: {}, myisam: false, wrote: false };
    sess.trx = id;
    return S.trx[id];
  }

  function newSnap(S, trx) {
    return { at: S.label, seen: S.committed.slice(), own: trx.id };
  }

  // 스냅숏으로 본 행 버전: 자기 트랜잭션이 쓴 것과, 스냅숏을 만들 때 커밋을 마친 트랜잭션이 쓴 것 중 가장 새것.
  function visibleVer(row, snap, trx) {
    return row.vers.find((v) => v.trx === trx.id || snap.seen.includes(v.trx)) || null;
  }
  // 커밋된 가장 새 버전(자기 것 포함). 잠금 읽기와 MySQL의 UPDATE가 고치는 기준이다.
  function latestVer(S, row, trx) {
    return row.vers.find((v) => v.trx === trx.id || isCommitted(S, v.trx)) || null;
  }
  // READ UNCOMMITTED(MySQL)의 읽기: 커밋하지 않은 것까지 가장 새 버전.
  function dirtyVer(row) { return row.vers[0] || null; }

  // ---------- 락 ----------
  // res: '표:키'는 행, '표:gap'은 행 사이 범위(이 표의 모든 범위를 하나로 그린다), '표:table'은 MyISAM의 표 락.
  // 모드: S·X(행), GS·GX(범위), II(넣기 의도, 쥐지 않고 확인만 한다), R·W(MyISAM 표 읽기·쓰기 락).

  function conflicts(held, want) {
    if (want === 'II') return held === 'GS' || held === 'GX';
    if (want === 'GS' || want === 'GX') return false;
    if (want === 'R') return held === 'W';
    if (want === 'W') return held === 'R' || held === 'W';
    if (want === 'S') return held === 'X';
    if (want === 'X') return held === 'S' || held === 'X';
    return false;
  }

  // 원하는 락을 모두 줄 수 있으면 주고 null을, 아니면 막는 락 하나를 돌려준다(그때는 하나도 주지 않는다).
  function acquire(S, trx, wants) {
    for (const w of wants) {
      const block = S.locks.find((l) => l.res === w.res && l.trx !== trx.id && conflicts(l.mode, w.mode));
      if (block) return { res: w.res, mode: w.mode, by: block.trx };
    }
    for (const w of wants) {
      if (w.mode === 'II') continue;
      const mine = S.locks.find((l) => l.res === w.res && l.trx === trx.id);
      if (!mine) S.locks.push({ trx: trx.id, res: w.res, mode: w.mode, stmt: !!w.stmt });
      else if (mine.mode === 'S' && w.mode === 'X') mine.mode = 'X';
      else if (mine.mode === 'GS' && w.mode === 'GX') mine.mode = 'GX';
    }
    return null;
  }
  function releaseAll(S, trxId) { S.locks = S.locks.filter((l) => l.trx !== trxId); }
  function releaseStmt(S, trxId) { S.locks = S.locks.filter((l) => !(l.trx === trxId && l.stmt)); }

  // 기다림의 고리: 기다리는 트랜잭션에서 그 락을 쥔 트랜잭션으로 가는 선이 고리를 이루는지.
  function waitCycle(S, start) {
    const edges = {};
    for (const s of Object.values(S.sess)) if (s.pending && s.pending.by != null && s.trx != null) edges[s.trx] = s.pending.by;
    const seen = [start];
    let cur = edges[start];
    while (cur != null) {
      if (cur === start) return seen;
      if (seen.includes(cur)) return null;
      seen.push(cur);
      cur = edges[cur];
    }
    return null;
  }

  // ---------- 문장 실행 ----------

  function finishTrx(S, trx, how) {
    trx.state = how;
    if (how === 'committed') S.committed.push(trx.id);
    if (how === 'aborted') {
      for (const t of Object.values(S.tables)) {
        if (t.engine === 'myisam') continue;
        for (const row of t.rows) row.vers = row.vers.filter((v) => v.trx !== trx.id);
        t.rows = t.rows.filter((row) => row.vers.length);
      }
    }
    releaseAll(S, trx.id);
    trx.snap = null;
    trx.stmtSnap = null;
    const sess = S.sess[trx.sess];
    if (sess.trx === trx.id) sess.trx = null;
  }

  // 이 문장이 읽을 스냅숏. MySQL은 consistent read에서만, PostgreSQL은 트랜잭션 제어문이 아닌 모든 문장에서 쓴다.
  function snapFor(S, trx, ctx) {
    const iso = trx.iso;
    if (S.db === 'mysql' && iso === 'RU') return null;
    const perStmt = trx.auto || iso === 'RC' || iso === 'RU' || (S.db === 'mysql' && iso === 'SER');
    if (perStmt) {
      if (!ctx.snap) {
        ctx.snap = newSnap(S, trx);
        trx.stmtSnap = ctx.snap;
        ctx.snapNew = true;
      }
      return ctx.snap;
    }
    if (!trx.snap) {
      trx.snap = newSnap(S, trx);
      ctx.snapNew = true;
      ctx.snapTrx = true;
    }
    return trx.snap;
  }

  function rowsOf(t) { return t.rows.slice().sort((a, b) => a.k - b.k); }

  function outRows(part, found, spec) {
    if (part.out === 'count') return found.length;
    if (part.out === 'ids') return found.map((f) => [f.vals.id]);
    if (part.out === 'balance') return found.map((f) => [f.vals.balance]);
    return found.map((f) => spec.cols.map((c) => f.vals[c]));
  }

  // SELECT. 잠그며 읽기(FOR UPDATE, MySQL SERIALIZABLE의 평범한 SELECT)와 MyISAM 표의 읽기는 락을 먼저 얻는다.
  function execSelect(S, sess, trx, op, ctx) {
    const mysqlLock = S.db === 'mysql' && (op.lock || (trx.iso === 'SER' && !trx.auto)) ? (op.lock || 'S') : null;
    const wants = [];
    const plan = op.parts.map((part) => {
      const t = S.tables[part.t];
      if (t.engine === 'myisam') {
        wants.push({ res: `${t.name}:table`, mode: 'R', stmt: true });
        return { part, t, how: 'myisam' };
      }
      if (mysqlLock) {
        const where = part.where;
        const scan = where && where.pk != null ? t.rows.filter((r) => r.k === where.pk) : t.rows;
        for (const row of scan) {
          const v = latestVer(S, row, trx) || row.vers[0];
          // READ COMMITTED는 조건에 맞지 않는 행의 락을 바로 놓으므로, 조건에 맞는 행만 잠근 것으로 그린다.
          if (trx.iso === 'RC' && where && !where.fn(v.vals)) continue;
          wants.push({ res: `${t.name}:${row.k}`, mode: mysqlLock });
        }
        // REPEATABLE READ 이상에서 기본 키가 아닌 조건으로 훑으면 행 사이 범위도 잠근다(next-key lock).
        if (trx.iso !== 'RC' && trx.iso !== 'RU' && !(where && where.pk != null)) wants.push({ res: `${t.name}:gap`, mode: `G${mysqlLock}` });
        return { part, t, how: 'latest' };
      }
      return { part, t, how: S.db === 'mysql' && trx.iso === 'RU' ? 'dirty' : 'snap' };
    });
    const pgLock = S.db === 'postgres' && op.lock;
    if (wants.length) {
      const block = acquire(S, trx, wants);
      if (block) return { block };
    }
    let snap = null;
    const results = [];
    const used = [];
    for (const p of plan) {
      const spec = TABLES[p.t.name];
      let found = [];
      if (p.how === 'myisam') found = rowsOf(p.t).map((r) => r.vers[0]);
      else {
        for (const row of rowsOf(p.t)) {
          let v;
          if (p.how === 'latest') v = latestVer(S, row, trx);
          else if (p.how === 'dirty') v = dirtyVer(row);
          else { snap = snapFor(S, trx, ctx); v = visibleVer(row, snap, trx); }
          if (v && (!p.part.where || p.part.where.fn(v.vals))) { found.push(v); used.push({ t: p.t, row, v }); }
        }
      }
      if (pgLock) {
        // PostgreSQL의 FOR UPDATE는 스냅숏으로 찾은 행을 잠근다. 이 순서표에서는 그 행을 고친 트랜잭션이 없다.
        const block = acquire(S, trx, used.map((u) => ({ res: `${u.t.name}:${u.row.k}`, mode: 'X' })));
        if (block) return { block };
      }
      results.push(outRows(p.part, found, spec));
    }
    const rows = op.parts.length > 1 ? [results] : op.parts[0].out === 'count' ? [[results[0]]] : results[0];
    for (const u of used) trx.reads[`${u.t.name}:${u.row.k}`] = u.v.id;
    return { rows, used, snap, how: plan.map((p) => p.how), locking: !!(mysqlLock || pgLock) };
  }

  // UPDATE. MySQL은 최신 행을 잠가 고친다. PostgreSQL은 스냅숏으로 대상 행을 찾고, 그 행을 다른 트랜잭션이 이미 고쳤으면
  // READ COMMITTED는 최신 버전으로 다시 확인해 고치고, REPEATABLE READ 이상은 직렬화 실패(40001)로 끝낸다.
  function execUpdate(S, sess, trx, op, ctx) {
    const t = S.tables[op.t];
    const row = t.rows.find((r) => r.k === op.where.pk);
    if (t.engine === 'myisam') {
      const block = acquire(S, trx, [{ res: `${t.name}:table`, mode: 'W', stmt: true }]);
      if (block) return { block };
      const v = row.vers[0];
      v.vals = op.set(v.vals);
      if (!trx.auto) trx.myisam = true;
      return { rows: null, row, v, myisam: true };
    }
    let target = null;
    if (S.db === 'postgres') {
      const snap = snapFor(S, trx, ctx);
      target = row ? visibleVer(row, snap, trx) : null;
      if (!target) return { rows: null, none: true };
    }
    const block = acquire(S, trx, [{ res: `${t.name}:${row.k}`, mode: 'X' }]);
    if (block) return { block };
    let base = row.vers[0];
    let recheck = false;
    if (S.db === 'postgres' && base.id !== target.id && base.trx !== trx.id) {
      if (trx.iso === 'RR' || trx.iso === 'SER') return { error: { code: '40001', message: 'could not serialize access due to concurrent update' }, row, base };
      recheck = true;
    }
    if (S.db === 'mysql') base = latestVer(S, row, trx);
    const read = trx.reads[`${t.name}:${row.k}`];
    const lost = read != null && base.id !== read && base.trx !== trx.id && base.trx !== 0 ? base : null;
    const v = { id: S.nextVer++, vals: op.set(base.vals), trx: trx.id };
    row.vers.unshift(v);
    trx.wrote = true;
    return { rows: null, row, v, base, lost, recheck };
  }

  function execInsert(S, sess, trx, op) {
    const t = S.tables[op.t];
    const k = op.row[TABLES[op.t].key];
    if (t.engine === 'myisam') {
      const block = acquire(S, trx, [{ res: `${t.name}:table`, mode: 'W', stmt: true }]);
      if (block) return { block };
      t.rows.push({ k, vers: [{ id: S.nextVer++, vals: { ...op.row }, trx: 0 }] });
      if (!trx.auto) trx.myisam = true;
      return { rows: null, myisam: true, k };
    }
    if (S.db === 'postgres' && (trx.iso === 'RR' || trx.iso === 'SER')) snapFor(S, trx, {});
    const wants = [{ res: `${t.name}:${k}`, mode: 'X' }];
    if (S.db === 'mysql') wants.unshift({ res: `${t.name}:gap`, mode: 'II' });
    const block = acquire(S, trx, wants);
    if (block) return { block };
    t.rows.push({ k, vers: [{ id: S.nextVer++, vals: { ...op.row }, trx: trx.id }] });
    trx.wrote = true;
    return { rows: null, k };
  }

  function lockWord(mode) {
    return { S: '공유 락', X: '배타 락', GS: '범위 공유 락', GX: '범위 배타 락', II: '넣기 의도 락', R: '표 읽기 락', W: '표 쓰기 락' }[mode];
  }
  function resWord(res) {
    const [t, k] = res.split(':');
    if (k === 'gap') return `${t}의 행 사이 범위`;
    if (k === 'table') return `${t} 표`;
    return `${t}의 행 ${k}`;
  }

  function resultText(rows, op) {
    if (rows == null) return '';
    if (op.k === 'warnings') return rows.length ? `→ 경고 ${rows[0][1]}` : '→ 경고 없음';
    if (op.parts && op.parts.length > 1) return `→ (${rows[0].join(', ')})`;
    const out = op.parts[0].out;
    if (out === 'count' || out === 'balance') return `→ ${rows.length ? rows[0][0] : '없음'}`;
    if (out === 'ids') return `→ id ${rows.map((r) => r[0]).join(', ')}`;
    return `→ ${rows.map((r) => r.join(':')).join(', ')}`;
  }

  // 같은 트랜잭션에서 같은 조건으로 읽은 바로 앞 결과와 비교한다. 달라졌으면 문제 이벤트로 남긴다.
  function readChange(S, sess, trx, rec, res) {
    const op = rec.op;
    if (op.parts.length > 1) return null;
    const part = op.parts[0];
    const key = `${part.t}|${part.where ? part.where.text : '*'}|${part.out}`;
    const prev = trx.lastRead[key];
    const now = JSON.stringify(res.rows);
    trx.lastRead[key] = { rows: now, step: S.label };
    if (!prev || prev.rows === now) return null;
    const a = resultText(JSON.parse(prev.rows), op).replace('→ ', '');
    const b = resultText(res.rows, op).replace('→ ', '');
    const kind = part.out === 'balance' ? 'non-repeatable read' : '팬텀';
    return { a, b, kind, from: prev.step };
  }

  // 문장 하나를 실행한다. 락을 얻지 못하면 { block }을 돌려주고, 같은 문장을 나중에 다시 실행한다.
  function runStatement(S, sess, rec, ctx) {
    const op = rec.op;
    sess.err = '';
    if (op.k === 'begin') {
      const trx = newTrx(S, sess, false);
      if (op.snap && S.db === 'mysql' && trx.iso === 'RR') {
        trx.snap = newSnap(S, trx);
        return { ok: true, text: `${I(sess.id)} 트랜잭션을 열며 스냅숏을 만들었다(WITH CONSISTENT SNAPSHOT). 이 시점에 커밋된 것만 보인다.`, type: 'snap' };
      }
      const extra = op.snap ? ` ${trx.iso === 'RR' ? '' : `WITH CONSISTENT SNAPSHOT은 REPEATABLE READ에서만 스냅숏을 만든다. ${LEVEL_NAME[trx.iso]}에서는 무시한다.`}` : ' 스냅숏은 아직 없다.';
      return { ok: true, text: `${I(sess.id)} 트랜잭션을 열었다.${extra}`, type: 'begin' };
    }
    if (op.k === 'warnings') {
      const rows = sess.warnings.map((w) => w.slice());
      return { ok: true, rows, text: rows.length ? `${I(sess.id)} 바로 앞 문장의 경고를 읽었다: ${rows[0][1]} "${rows[0][2]}".` : `${I(sess.id)} 경고를 읽었다. 없다.`, type: 'read', keepWarnings: true };
    }
    let trx = trxOf(S, sess);
    if (op.k === 'commit' || op.k === 'rollback') {
      if (!trx) return { ok: true, text: `${I(sess.id)} ${op.k === 'commit' ? 'COMMIT' : 'ROLLBACK'}을 보냈다. 앞의 오류로 트랜잭션이 이미 되돌려져 끝낼 것이 없다.`, type: op.k };
      if (trx.state === 'failed') {
        finishTrx(S, trx, 'aborted');
        return { ok: true, status: 'ROLLBACK', text: `${I(sess.id)} COMMIT을 보냈지만 오류가 난 트랜잭션이라 ROLLBACK으로 끝났다. ${I(sess.id)} 고친 것은 남지 않는다.`, type: 'rollback' };
      }
      if (op.k === 'commit') {
        const wrote = trx.wrote;
        finishTrx(S, trx, 'committed');
        return { ok: true, text: `${I(sess.id)} 커밋했다.${wrote ? ` ${I(sess.id)} 쓴 버전이 이제 다른 트랜잭션에 보이고, 쥔 락을 모두 놓았다.` : ' 쥔 락이 있으면 모두 놓았다.'}`, type: 'commit' };
      }
      const myisam = trx.myisam;
      finishTrx(S, trx, 'aborted');
      if (myisam) {
        sess.warnings = [['Warning', 1196, WARN_1196]];
        return { ok: true, bad: true, text: `${I(sess.id)} ROLLBACK했다. InnoDB 표(orders)의 행은 되돌렸지만 MyISAM 표(order_logs)의 행은 되돌리지 못해 경고 1196만 남겼다. 오류는 아니다.`, type: 'warning', keepWarnings: true };
      }
      return { ok: true, text: `${I(sess.id)} ROLLBACK했다. ${I(sess.id)} 쓴 버전을 지우고 락을 놓았다.`, type: 'rollback' };
    }
    if (!trx) { trx = newTrx(S, sess, true); ctx.auto = true; }
    let res;
    if (op.k === 'select') res = execSelect(S, sess, trx, op, ctx);
    else if (op.k === 'update') res = execUpdate(S, sess, trx, op, ctx);
    else res = execInsert(S, sess, trx, op);
    if (res.block) return { block: res.block, trx };
    if (res.error) {
      trx.state = 'failed';
      releaseAll(S, trx.id);
      return { ok: false, error: res.error, bad: true, type: 'error',
        text: `${I(sess.id)} 기다리던 행을 ${I(sessName(S, res.base.trx))} 고치고 커밋했다. ${sess.id}의 스냅숏 뒤에 바뀐 행이라 오류 ${res.error.code}(${res.error.message})로 끝났다.` };
    }
    return { ok: true, res, trx };
  }

  function describeDone(S, sess, rec, out, ctx) {
    const op = rec.op;
    const id = sess.id;
    const res = out.res;
    const trx = out.trx;
    const snapWord = () => {
      if (!ctx.snap && !ctx.snapTrx && !(trx && trx.snap)) return '';
      if (ctx.snapTrx) return ` 이 트랜잭션의 첫 ${S.db === 'mysql' ? 'consistent read' : '문장'}라 여기서 스냅숏을 만들었다.`;
      if (ctx.snap) return ` 이 문장만 쓰는 스냅숏을 만들어 읽고 버렸다.`;
      return ` 단계 ${trx.snap.at}에 만든 스냅숏으로 읽었다.`;
    };
    if (op.k === 'select') {
      const how = res.how[0];
      let text;
      if (how === 'myisam' && op.parts.length === 1) text = `${I(id)} 표 읽기 락을 걸고 MyISAM 표를 읽었다 ${resultText(res.rows, op)}.`;
      else if (op.parts.length > 1) text = `${I(id)} 두 표의 행 수를 셌다 ${resultText(res.rows, op)}. orders는 스냅숏으로, MyISAM인 order_logs는 지금 있는 행을 센다.`;
      else if (res.locking) text = `${I(id)} 잠그며 읽었다 ${resultText(res.rows, op)}. 스냅숏이 아니라 지금 커밋된 최신 행을 읽고 ${S.db === 'mysql' && !op.lock ? '공유 락' : '배타 락'}을 걸었다.`;
      else if (how === 'dirty') text = `${I(id)} 읽었다 ${resultText(res.rows, op)}. READ UNCOMMITTED라 커밋하지 않은 버전까지 가장 새것을 읽는다.`;
      else text = `${I(id)} 읽었다 ${resultText(res.rows, op)}.${snapWord()}`;
      if (S.db === 'mysql' && trx.iso === 'SER' && !trx.auto && !op.lock) text = `${I(id)} 읽었다 ${resultText(res.rows, op)}. SERIALIZABLE이라 평범한 SELECT도 공유 락을 거는 읽기(FOR SHARE)가 되어, 스냅숏이 아니라 최신 행을 읽고 공유 락을 걸었다.`;
      if (op.long) text = `${I(id)} 재고 표 전체를 읽기 시작했다. 행마다 SLEEP(1)이라 약 2초 걸린다. ${S.tables.stock.engine === 'myisam' ? '읽는 동안 표 읽기 락을 쥔다.' : '시작할 때의 스냅숏으로 읽고 락은 걸지 않는다.'}`;
      const dirty = how === 'dirty' && res.used.some((u) => u.v.trx !== trx.id && !isCommitted(S, u.v.trx));
      if (dirty) return { text: `${text} ${I(sessName(S, res.used[0].v.trx))} 커밋하지 않은 값을 읽었다(dirty read).`, bad: true, type: 'dirty' };
      return { text, type: res.locking ? 'lockread' : op.long ? 'long' : 'read' };
    }
    if (op.k === 'update') {
      if (res.none) return { text: `${I(id)} 고칠 행을 찾지 못했다.`, type: 'write' };
      if (res.myisam) return { text: `${I(id)} 표 쓰기 락을 얻어 MyISAM 표의 행을 바로 고쳤다(${TABLES[op.t ? op.t : 'stock'].text(res.v.vals)}). 문장이 끝나며 락을 놓았다.`, type: 'write' };
      const tname = op.t;
      let text = `${I(id)} ${tname}의 행 ${res.row.k}을 ${TABLES[tname].text(res.v.vals)}(으)로 고쳤다. 배타 락을 걸고 새 버전을 썼다${trx.auto ? '(자동 커밋)' : ''}.`;
      if (S.db === 'mysql') text = `${I(id)} ${tname}의 행 ${res.row.k}에 배타 락을 걸고 최신 버전(${TABLES[tname].text(res.base.vals)}) 위에 새 버전 ${TABLES[tname].text(res.v.vals)}을 썼다${trx.auto ? '(자동 커밋)' : ''}.`;
      if (res.recheck) text = `${I(id)} 기다리던 행을 ${I(sessName(S, res.base.trx))} 고치고 커밋했다. READ COMMITTED라 최신 버전(${TABLES[tname].text(res.base.vals)})으로 조건을 다시 확인하고 ${TABLES[tname].text(res.v.vals)}으로 고쳤다.`;
      if (res.lost) return { text: `${text} ${I(id)} 읽은 뒤 ${I(sessName(S, res.lost.trx))} 커밋한 ${TABLES[tname].text(res.lost.vals)}을 보지 않고 덮어써, ${sessName(S, res.lost.trx)}의 변경이 사라진다(갱신 손실).`, bad: true, type: 'lost' };
      return { text, type: 'write' };
    }
    if (res.myisam) return { text: `${I(id)} MyISAM 표 ${op.t}에 행을 넣었다. 트랜잭션과 상관없이 문장이 끝나는 순간 반영되어 다른 세션에 바로 보인다.`, type: 'write' };
    return { text: `${I(id)} ${op.t}에 행 ${res.k}을 넣었다. 커밋하기 전이라 다른 트랜잭션의 스냅숏에는 보이지 않는다.${S.db === 'mysql' ? ' 넣기 전에 행 사이 범위에 다른 트랜잭션의 범위 락이 없는지 확인했다.' : ''}`, type: 'write' };
  }

  // ---------- 순서표 실행 ----------

  function jsonStep(S, total) { return Math.min(S.step, total); }

  function simulateTimeline(name, db, level, engineScene) {
    const T = TIMELINES[name];
    const S = makeState(db);
    for (const [t, engine] of Object.entries(T.tables)) addTable(S, t, engine);
    const ids = [...new Set(T.steps.map((s) => s.s))].sort();
    for (const id of ids) addSession(S, id, { iso: level });
    T.steps.forEach((s, i) => S.sess[s.s].script.push(i));
    const total = T.steps.length;
    const records = T.steps.map((s, i) => ({ step: i + 1, session: s.s, sql: s.sql, note: s.note, op: s.op, key: `s${i + 1}`, blocked: false, deferred: false,
      sent_after_step: null, finished_after_step: null, outcome: null, rows: null, error: null, status: null }));
    const views = [];
    const lineDone = {};
    const markRan = (sess, rec) => { sess.ran = true; sess.lines.push(rec.key); lineDone[rec.step] = true; };

    function finish(sess, rec, out) {
      const ctx = sess.pending ? sess.pending.ctx : rec.ctx;
      rec.finished_after_step = jsonStep(S, total);
      sess.pending = null;
      markRan(sess, rec);
      if (!out.keepWarnings) sess.warnings = [];
      if (out.error) {
        rec.outcome = 'error';
        rec.error = { code: out.error.code, message: out.error.message };
        sess.err = `오류 ${out.error.code}`;
        sess.last = '';
        emit(S, 'error', out.text, [sess.id], { bad: true });
        return;
      }
      rec.outcome = 'ok';
      rec.rows = out.rows !== undefined ? out.rows : out.res && out.res.rows !== undefined ? out.res.rows : null;
      rec.status = out.status || null;
      if (out.res) {
        const d = describeDone(S, sess, rec, out, ctx);
        emit(S, d.type, d.text, [sess.id], d.bad ? { bad: true } : null);
        if (rec.op.k === 'select' && out.trx && !out.trx.auto) {
          const ch = readChange(S, sess, out.trx, rec, out.res);
          if (ch) emit(S, 'changed', `같은 트랜잭션에서 같은 조건으로 읽은 결과가 단계 ${ch.from}의 ${ch.a}에서 ${ch.b}(으)로 바뀌었다(${ch.kind}).`, [sess.id], { bad: true });
        }
        if (out.trx && out.trx.auto) {
          finishTrx(S, out.trx, 'committed');
        } else if (out.trx) releaseStmt(S, out.trx.id);
        if (out.trx && out.trx.stmtSnap) out.trx.stmtSnap = null;
      } else {
        emit(S, out.type, out.text, [sess.id], out.bad ? { bad: true } : null);
      }
      sess.last = resultText(rec.rows, rec.op);
    }

    function send(sess, rec) {
      rec.sent_after_step = jsonStep(S, total);
      rec.ctx = {};
      const out = runStatement(S, sess, rec, rec.ctx);
      if (out.block) {
        rec.blocked = true;
        sess.pending = { rec, ctx: rec.ctx, res: out.block.res, mode: out.block.mode, by: out.block.by };
        markRan(sess, rec);
        sess.lines.pop();
        sess.sentNow = rec.key;
        const cyc = waitCycle(S, out.trx.id);
        if (cyc && cyc.length > 1) {
          // 기다림의 고리. MySQL은 바로 알아채 한쪽을 되돌린다. 실험에서 되돌려진 쪽은 고리를 닫은 B였다.
          S.cycle = cyc.map((tid) => { const s = S.sess[S.trx[tid].sess]; return { from: s.id, res: s.pending.res }; });
          emit(S, 'wait', `${I(sess.id)} ${resWord(out.block.res)}에 ${lockWord(out.block.mode)}이 필요한데 ${I(sessName(S, out.block.by))} 락을 쥐고 있다.`, [sess.id]);
          const trx = out.trx;
          trx.state = 'failed';
          finishTrx(S, trx, 'aborted');
          sess.pending = null;
          rec.blocked = false;
          finish(sess, rec, { error: { code: '1213', message: 'Deadlock found when trying to get lock; try restarting transaction' }, text: `서로 기다리는 고리가 생겼다(${cyc.map((t) => sessName(S, t)).join(' → ')} → ${sessName(S, cyc[0])}). InnoDB가 이를 알아채 ${R(sess.id)} 오류 1213(데드락)으로 되돌리고 ${sess.id}의 락을 모두 놓았다.` });
          return;
        }
        if (rec.op.long) return;
        emit(S, 'wait', `${I(sess.id)} ${resWord(out.block.res)}에 ${lockWord(out.block.mode)}이 필요한데 ${I(sessName(S, out.block.by))} 쥐고 있어 기다린다.`, [sess.id]);
        return;
      }
      if (rec.op.long) {
        // SLEEP으로 오래 걸리는 읽기. 결과는 시작할 때 정해지고, 다른 단계를 다 보낸 뒤에 끝난다.
        rec.blocked = true;
        sess.pending = { rec, ctx: rec.ctx, long: true, out, res: rec.op.parts[0].t === 'stock' && S.tables.stock.engine === 'myisam' ? 'stock:table' : null };
        markRan(sess, rec);
        sess.lines.pop();
        sess.sentNow = rec.key;
        const d = describeDone(S, sess, rec, out, rec.ctx);
        emit(S, 'long', d.text, [sess.id]);
        return;
      }
      finish(sess, rec, out);
    }

    // 기다리던 문장을 다시 실행해 보고, 앞 문장이 끝난 세션의 미뤄 둔 문장을 보낸다. 더 바뀌는 것이 없을 때까지 한다.
    function advance(tail) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of S.order) {
          const sess = S.sess[id];
          const p = sess.pending;
          if (!p) continue;
          if (p.long) {
            if (!tail) continue;
            const trx = p.out.trx;
            p.rec.rows = p.out.res.rows;
            finish(sess, p.rec, p.out);
            emit(S, 'long-end', `${I(id)} 재고 표 읽기를 마쳤다 ${resultText(p.rec.rows, p.rec.op)}.${S.tables.stock.engine === 'myisam' ? ' 표 읽기 락을 놓았다.' : ''}`, [id]);
            if (trx && trx.state === 'active') finishTrx(S, trx, 'committed');
            changed = true;
            continue;
          }
          const out = runStatement(S, sess, p.rec, p.ctx);
          if (out.block) { p.by = out.block.by; p.res = out.block.res; continue; }
          emit(S, 'granted', `${I(sessName(S, p.by))} 락을 놓아 ${sess.id}의 기다리던 문장이 이어서 실행된다.`, [id]);
          finish(sess, p.rec, out);
          changed = true;
        }
        for (const id of S.order) {
          const sess = S.sess[id];
          if (sess.pending || !sess.deferred.length) continue;
          const rec = sess.deferred.shift();
          emit(S, 'sent-later', `${I(id)} 앞 문장이 끝나 미뤄 둔 ${rec.step}번 줄(${rec.sql})을 이제 보낸다.`, [id]);
          send(sess, rec);
          changed = true;
        }
      }
    }

    views.push(timelineView(S, T, records, null, true));
    for (let i = 0; i < total; i += 1) {
      S.step = i + 1;
      S.label = String(i + 1);
      S.ev = [];
      S.cycle = null;
      for (const s of Object.values(S.sess)) { s.lines = []; s.ran = false; s.sentNow = null; }
      const rec = records[i];
      const sess = S.sess[rec.session];
      if (sess.pending || sess.deferred.length) {
        rec.deferred = true;
        sess.deferred.push(rec);
        emit(S, 'deferred', `${I(sess.id)} ${rec.step}번 줄(${rec.sql})을 보낼 차례지만, 앞 문장이 아직 끝나지 않아 미룬다. 한 연결은 앞 문장이 돌아와야 다음 문장을 보낸다.`, [sess.id]);
      } else send(sess, rec);
      advance(false);
      views.push(timelineView(S, T, records, rec, false));
    }
    if (Object.values(S.sess).some((s) => s.pending || s.deferred.length)) {
      S.step = total + 1;
      S.label = '끝';
      S.ev = [];
      S.cycle = null;
      for (const s of Object.values(S.sess)) { s.lines = []; s.ran = false; s.sentNow = null; }
      emit(S, 'tail', '순서표의 문장을 모두 보냈다. 끝나지 않은 문장이 끝나기를 기다린다.', []);
      advance(true);
      views.push(timelineView(S, T, records, null, false));
    }
    const out = records.map((r) => ({ step: r.step, session: r.session, sql: r.sql, blocked: r.blocked, deferred: r.deferred,
      sent_after_step: r.sent_after_step, finished_after_step: r.finished_after_step, outcome: r.outcome, rows: r.rows, error: r.error, status: r.status }));
    return { S, views, records: out };
  }

  // 한 단계 끝의 보기. 실행 여부(cls run, lines)는 그 단계 동안, 나머지는 단계가 끝난 뒤의 상태다.
  function timelineView(S, T, records, rec, initial) {
    const th = {};
    for (const id of S.order) {
      const s = S.sess[id];
      const trx = trxOf(S, s);
      const left = s.script.filter((i) => records[i].outcome == null);
      const nextIdx = s.pending ? s.pending.rec.step - 1 : left.length ? left[0] : null;
      let cls;
      let why = '';
      if (s.ran) cls = 'run';
      else if (s.pending) cls = 'event';
      else if (nextIdx == null) cls = 'done';
      else cls = 'turn';
      if (s.pending) why = s.pending.long ? 'SLEEP 실행 중' : '락 대기';
      else if (cls === 'turn') why = '다음 문장 전';
      else if (cls === 'done') why = '끝';
      const after = s.pending ? { cls: 'event', why } : nextIdx == null ? { cls: 'done', why: '끝' } : { cls: 'turn', why: '다음 문장 전' };
      let trxText = '트랜잭션 없음';
      let snapText = '';
      if (trx && trx.state === 'failed') trxText = '오류로 멈춘 트랜잭션';
      else if (trx && trx.auto) trxText = '자동 커밋 문장';
      else if (trx) trxText = '트랜잭션 중';
      if (trx && trx.snap) snapText = `스냅숏 단계 ${trx.snap.at}`;
      else if (trx && !trx.auto && trx.state === 'active') snapText = '스냅숏 없음';
      th[id] = { cls, why, after, trx: trxText, snap: snapText, snapAt: trx && trx.snap ? trx.snap.at : null, local: s.last, err: s.err,
        lines: s.lines.slice().concat(s.sentNow ? [s.sentNow] : []), at: nextIdx != null ? `s${nextIdx + 1}` : null,
        waitOn: s.pending && !s.pending.long ? s.pending.res : null, waitBy: s.pending && s.pending.by != null ? sessName(S, s.pending.by) : null,
        waitMode: s.pending && !s.pending.long ? s.pending.mode : null, sleeping: !!(s.pending && s.pending.long), iso: s.iso,
        trxState: trx ? trx.state : null, deferred: s.deferred.map((r) => r.step) };
      if (initial) { th[id].cls = 'turn'; th[id].why = '다음 문장 전'; th[id].lines = []; }
    }
    const obj = {};
    for (const t of Object.values(S.tables)) obj[t.name] = tableView(S, t);
    const locks = S.locks.filter((l) => l.mode !== 'II').map((l) => ({ sess: sessName(S, l.trx), res: l.res, mode: l.mode }));
    // 오래 걸리는 MyISAM 읽기가 쥔 표 읽기 락
    const actors = S.order.filter((id) => S.sess[id].ran);
    const ev = initial ? [{ type: 'start', text: `준비: ${Object.keys(S.tables).join(', ')} 표를 만들었다. 두 세션의 격리 수준은 ${LEVEL_NAME[S.sess[S.order[0]].iso]}다.`, ids: [] }] : S.ev.slice();
    return { step: S.step, label: initial ? '0' : S.label, tail: S.label === '끝', sent: rec ? rec.step : null, actors, th, obj: clone(obj), locks, ev, cycle: S.cycle ? clone(S.cycle) : null };
  }

  // 트랜잭션 끝까지 쓰는 스냅숏(REPEATABLE READ 이상)마다 이 행에서 보는 버전. 관계도의 "←A" 표시다.
  function seenBy(S, row) {
    const out = {};
    for (const trx of Object.values(S.trx)) {
      if (trx.state !== 'active' || !trx.snap) continue;
      const v = visibleVer(row, trx.snap, trx);
      if (v) (out[v.id] = out[v.id] || []).push(trx.sess);
    }
    return out;
  }

  function tableView(S, t) {
    const spec = TABLES[t.name];
    return {
      id: t.name, type: 'table', name: t.name, engine: t.engine, key: spec.key, gap: S.db === 'mysql' && t.engine === 'innodb' && t.name === 'entries',
      rows: rowsOf(t).map((row) => {
        const seen = t.engine === 'myisam' ? {} : seenBy(S, row);
        return {
          k: row.k,
          vers: row.vers.map((v, i) => ({ id: v.id, text: spec.text(v.vals), by: v.trx ? S.trx[v.trx].sess : null,
            state: v.trx === 0 || isCommitted(S, v.trx) ? 'committed' : 'active', newest: i === 0, dead: !!v.dead, seen: (seen[v.id] || []).sort() })),
        };
      }),
    };
  }

  // ---------- 장면 ----------
  // 묶음 1·3의 장면은 순서표 하나와 DB, 격리 수준을 고른다.

  const SCENE_TIMELINES = {
    count: { snap: 'entries-count', total: 'entries-total', late: 'entries-late', consistent: 'entries-late-snapshot', update: 'entries-late-update' },
    report: { reads: 'balance-reads' },
    locking: { rows: 'entries-rows' },
    deduct: { deduct: 'points-deduct' },
    engine: { rollback: 'order-rollback', stock: null },
  };

  const SCENARIOS = {
    count: { label: '스냅숏을 만드는 때' },
    report: { label: '잔액 세 번 읽기' },
    locking: { label: '잠그며 읽기' },
    deduct: { label: '동시 차감' },
    hold: { label: '열어 둔 트랜잭션' },
    engine: { label: 'InnoDB와 MyISAM' },
    commit: { label: '커밋을 디스크에' },
  };

  const CHOICES = {
    count: { tl: ['snap', 'total', 'late', 'consistent', 'update'], db: ['mysql', 'postgres'], level: ['RR', 'RC'] },
    report: { db: ['mysql', 'postgres'], level: LEVELS },
    locking: { db: ['mysql', 'postgres'], level: ['RC', 'RR', 'SER'] },
    deduct: { db: ['mysql', 'postgres'], level: LEVELS },
    hold: { db: ['mysql', 'postgres'], hold: ['none', 'rr-read', 'rc-read', 'rr-begin', 'rr-update', 'rr-read-other'] },
    engine: { tl: ['rollback', 'stock'], engine: ['myisam', 'innodb'] },
    commit: { db: ['mysql', 'postgres'], setting: ['f1b1', 'f2b1', 'f1b0', 'f2b0', 'on', 'off'], crash: ['none', 'db', 'os'] },
  };
  const RANGES = { hold: { updates: [2, 6] }, commit: { commits: [1, 3] } };
  const DEFAULTS = {
    count: { tl: 'snap', db: 'mysql', level: 'RR' },
    report: { db: 'mysql', level: 'RR' },
    locking: { db: 'mysql', level: 'RR' },
    deduct: { db: 'mysql', level: 'RR' },
    hold: { db: 'mysql', hold: 'rr-read', updates: 4 },
    engine: { tl: 'rollback', engine: 'myisam' },
    commit: { db: 'mysql', setting: 'f1b1', crash: 'none', commits: 2 },
  };
  const SETTINGS = {
    f1b1: { db: 'mysql', flush: 1, binlog: 1, label: 'innodb_flush_log_at_trx_commit=1, sync_binlog=1 (기본값)' },
    f2b1: { db: 'mysql', flush: 2, binlog: 1, label: 'innodb_flush_log_at_trx_commit=2, sync_binlog=1' },
    f1b0: { db: 'mysql', flush: 1, binlog: 0, label: 'innodb_flush_log_at_trx_commit=1, sync_binlog=0' },
    f2b0: { db: 'mysql', flush: 2, binlog: 0, label: 'innodb_flush_log_at_trx_commit=2, sync_binlog=0' },
    on: { db: 'postgres', sync: true, label: 'synchronous_commit=on (기본값)' },
    off: { db: 'postgres', sync: false, label: 'synchronous_commit=off' },
  };

  // 실험에서 돌리지 않은 조합(MySQL에만 있는 순서표의 PostgreSQL, 다른 DB의 설정)은 돌린 쪽으로 바꾼다.
  function normalizeConfig(scene, input) {
    const out = Object.assign({}, DEFAULTS[scene]);
    const src = input || {};
    for (const [k, list] of Object.entries(CHOICES[scene] || {})) if (list.includes(src[k])) out[k] = src[k];
    for (const [k, [lo, hi]] of Object.entries(RANGES[scene] || {})) {
      const n = Number(src[k]);
      if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, Math.round(n)));
    }
    const name = timelineName(scene, out);
    if (name) {
      const T = TIMELINES[name];
      if (!T.dbs.includes(out.db)) out.db = T.dbs[0];
      if (!T.levels.includes(out.level)) out.level = T.levels[0];
    }
    if (scene === 'engine' && out.tl === 'rollback') out.engine = 'myisam';
    if (scene === 'commit' && SETTINGS[out.setting].db !== out.db) out.setting = out.db === 'mysql' ? 'f1b1' : 'on';
    return out;
  }

  function timelineName(scene, cfg) {
    if (scene === 'engine') return cfg.tl === 'rollback' ? 'order-rollback' : `stock-read-${cfg.engine}`;
    const map = SCENE_TIMELINES[scene];
    if (!map) return null;
    return map[cfg.tl] || Object.values(map)[0];
  }

  // 실험의 원자료와 견줄 수 있게 순서표 하나를 실행한다. 테스트가 쓴다.
  function runTimeline(name, db, level) {
    const r = simulateTimeline(name, db, level);
    return r.records;
  }

  // ---------- 열어 둔 트랜잭션 (묶음 2) ----------
  // A가 해 둔 일(경우)에 따라 B가 한 행을 고치는 동안 이전 버전을 지울 수 있는지 본다. 실험의 1만 번을 updates번으로 줄였다.
  // MySQL의 purge와 PostgreSQL의 HOT pruning은 그 버전을 볼 수 있는 스냅숏이 없을 때만 지운다.

  const HOLDS = {
    none: { label: '(가) 트랜잭션을 열지 않음', iso: null, steps: [] },
    'rr-read': { label: '(나) REPEATABLE READ, 읽고 그대로 둠', iso: 'RR', steps: [BEGIN('A'), st('A', 'SELECT balance FROM accounts WHERE id = 1', sel('accounts', PK(1), 'balance'))] },
    'rc-read': { label: '(다) READ COMMITTED, 읽고 그대로 둠', iso: 'RC', steps: [BEGIN('A'), st('A', 'SELECT balance FROM accounts WHERE id = 1', sel('accounts', PK(1), 'balance'))] },
    'rr-begin': { label: '(라) REPEATABLE READ, 열기만 함', iso: 'RR', steps: [BEGIN('A')] },
    'rr-update': { label: '(마) REPEATABLE READ, 다른 표를 고치고 그대로 둠', iso: 'RR', steps: [BEGIN('A'), st('A', 'UPDATE visits SET n = n + 1 WHERE id = 1', { k: 'update', t: 'visits', where: PK(1), set: (r) => ({ ...r, n: r.n + 1 }) })] },
    'rr-read-other': { label: '(바) REPEATABLE READ, 다른 표를 읽고 그대로 둠', iso: 'RR', steps: [BEGIN('A'), st('A', 'SELECT n FROM visits WHERE id = 1', sel('visits', PK(1), 'n'))] },
  };
  const HOLD_SETUP = ['CREATE TABLE accounts (id INT PRIMARY KEY, balance INT NOT NULL)', 'INSERT INTO accounts (id, balance) VALUES (1, 1000)',
    'CREATE TABLE visits (id INT PRIMARY KEY, n INT NOT NULL)', 'INSERT INTO visits (id, n) VALUES (1, 0)'];
  const UPDATE_BALANCE = 'UPDATE accounts SET balance = balance + 1 WHERE id = 1';
  const READ_BALANCE = 'SELECT balance FROM accounts WHERE id = 1';

  // 남길 버전. 이전 버전은 그 버전을 덮은 트랜잭션(바로 위 버전을 쓴 트랜잭션)이 열린 스냅숏 하나에라도 보이지 않으면 남긴다.
  // 버전마다 누가 보는지 따지지 않고, 가장 오래된 스냅숏보다 뒤에 덮인 버전을 모두 남긴다. InnoDB purge가 가장 오래된
  // read view보다 뒤의 undo log를 지우지 않고, PostgreSQL이 xmin horizon 뒤의 dead tuple을 지우지 않는 것과 같다.
  function neededVers(S, row) {
    const keep = new Set();
    const snaps = [];
    for (const trx of Object.values(S.trx)) {
      if (trx.state !== 'active') continue;
      for (const snap of [trx.snap, trx.stmtSnap]) if (snap) snaps.push(snap);
    }
    row.vers.forEach((v, i) => {
      if (i === 0) { keep.add(v.id); return; }
      const over = row.vers[i - 1].trx;
      // 덮은 쪽이 아직 커밋하지 않았으면 되돌릴 때 쓸 버전이고, 커밋했어도 그 커밋이 보이지 않는 스냅숏이 있으면 그 스냅숏이 볼 수 있다.
      if (!isCommitted(S, over) || snaps.some((s) => !s.seen.includes(over))) keep.add(v.id);
    });
    return keep;
  }

  // 지울 수 있는 이전 버전을 지운다. 지운 수와, 지우지 못한 수(볼 수 있는 스냅숏이 있어서)를 돌려준다.
  function cleanup(S, tname) {
    const t = S.tables[tname];
    let removed = 0;
    let kept = 0;
    for (const row of t.rows) {
      const keep = neededVers(S, row);
      const before = row.vers.length;
      const newest = row.vers.find((v) => isCommitted(S, v.trx) || v.trx === 0);
      row.vers = row.vers.filter((v) => keep.has(v.id));
      removed += before - row.vers.length;
      kept += row.vers.filter((v) => v !== newest && (isCommitted(S, v.trx) || v.trx === 0)).length;
    }
    return { removed, kept };
  }
  function oldCount(S, tname) {
    let n = 0;
    for (const row of S.tables[tname].rows) {
      const newest = row.vers.find((v) => isCommitted(S, v.trx) || v.trx === 0);
      n += row.vers.filter((v) => v !== newest && (isCommitted(S, v.trx) || v.trx === 0)).length;
    }
    return n;
  }

  function simulateHold(cfg) {
    const db = cfg.db;
    const H = HOLDS[cfg.hold];
    const S = makeState(db);
    addTable(S, 'accounts', 'innodb');
    addTable(S, 'visits', 'innodb');
    const A = addSession(S, 'A', { iso: H.iso || DEFAULT_LEVEL[db] });
    const B = addSession(S, 'B');
    const C = addSession(S, 'C');
    const cleanerId = db === 'mysql' ? 'P' : 'V';
    const P = addSession(S, cleanerId, { name: db === 'mysql' ? 'purge' : 'VACUUM' });
    const steps = [];
    H.steps.forEach((s, i) => steps.push({ who: 'A', key: `a${i + 1}`, op: s.op, sql: s.sql }));
    for (let k = 1; k <= cfg.updates; k += 1) steps.push({ who: 'B', key: 'b', k, op: { k: 'update', t: 'accounts', where: PK(1), set: (r) => ({ ...r, balance: r.balance + 1 }) }, sql: UPDATE_BALANCE });
    steps.push({ who: 'A', key: 'ar', op: sel('accounts', PK(1), 'balance'), sql: READ_BALANCE, read: true });
    steps.push({ who: 'C', key: 'cr', op: sel('accounts', PK(1), 'balance'), sql: READ_BALANCE, read: true });
    if (db === 'postgres') steps.push({ who: cleanerId, key: 'v1', vacuum: true });
    if (H.steps.length) steps.push({ who: 'A', key: 'ac', op: { k: 'commit' }, sql: 'COMMIT' });
    steps.push({ who: cleanerId, key: db === 'mysql' ? 'p2' : 'v2', vacuum: true, final: true });
    const keysOf = { A: steps.filter((s) => s.who === 'A').map((s) => s.key), B: ['b'], C: ['cr'], [cleanerId]: steps.filter((s) => s.who === cleanerId).map((s) => s.key) };
    if (db === 'mysql') keysOf[cleanerId] = ['p1', 'p2'];
    const result = { db, hold: cfg.hold, updates: cfg.updates, afterUpdates: null, aRead: null, cRead: null, aHops: null, cHops: null, beforeCommit: null, afterClose: null, maxOld: 0 };
    const views = [];
    let seq = 0;
    const doneKeys = new Set();

    function view(initial) {
      const th = {};
      for (const id of S.order) {
        const s = S.sess[id];
        const trx = trxOf(S, s);
        const left = keysOf[id].filter((k) => !doneKeys.has(k));
        const cls = initial ? 'turn' : s.ran ? 'run' : left.length ? 'turn' : 'done';
        const why = cls === 'turn' ? (id === 'P' ? '다음 purge 전' : '다음 문장 전') : cls === 'done' ? '끝' : '';
        let trxText = '';
        let snapText = '';
        if (id === 'A' || id === 'B' || id === 'C') {
          trxText = trx && trx.state === 'active' ? (trx.auto ? '자동 커밋 문장' : `트랜잭션 중 · ${trx.iso}`) : '트랜잭션 없음';
          if (trx && trx.snap) snapText = `스냅숏 단계 ${trx.snap.at}`;
          else if (trx && trx.state === 'active' && !trx.auto) snapText = '스냅숏 없음';
        }
        th[id] = { cls, why, after: left.length ? { cls: 'turn', why: '다음 문장 전' } : { cls: 'done', why: '끝' }, trx: trxText, snap: snapText,
          snapAt: trx && trx.snap ? trx.snap.at : null, local: s.last, err: '', lines: initial ? [] : s.lines.slice(), at: left[0] || null,
          waitOn: null, waitBy: null, sleeping: false, iso: s.iso, trxState: trx ? trx.state : null, deferred: [] };
      }
      const obj = { accounts: tableView(S, S.tables.accounts), visits: tableView(S, S.tables.visits) };
      // 이전 버전의 자리: MySQL은 표에는 최신 버전만 두고 이전 버전을 undo log에, PostgreSQL은 표 안에 둔다.
      const old = oldCount(S, 'accounts') + oldCount(S, 'visits');
      obj.accounts.where = db === 'mysql' ? 'undo' : 'heap';
      obj.visits.where = obj.accounts.where;
      obj.cleanup = { id: 'cleanup', type: 'counter', db, old, held: !!(A.trx != null && (S.trx[A.trx].snap)) };
      const locks = S.locks.filter((l) => l.mode !== 'II').map((l) => ({ sess: sessName(S, l.trx), res: l.res, mode: l.mode }));
      return { step: S.step, label: initial ? '0' : S.label, tail: false, sent: null, actors: S.order.filter((id) => S.sess[id].ran), th, obj: clone(obj), locks,
        ev: initial ? [{ type: 'start', text: `준비: accounts의 행 1(잔액 1000)과 visits의 행 1을 만들었다. ${H.label}.`, ids: [] }] : S.ev.slice(), cycle: null };
    }

    // 지우는 쪽: MySQL은 B가 커밋할 때마다 purge 스레드가, PostgreSQL은 그 페이지를 다음에 읽거나 고치는 문장이 HOT pruning으로 지운다.
    function prune(byId, when) {
      const before = oldCount(S, 'accounts');
      const r = cleanup(S, 'accounts');
      if (r.removed) emit(S, 'prune', `${byId === 'P' ? 'purge 스레드가' : `${I(byId)} 페이지를 ${when} HOT pruning으로`} 아무 스냅숏도 볼 수 없는 이전 버전 ${r.removed}개를 지웠다.`, [byId]);
      else if (before && r.kept) emit(S, 'kept', `${I(byId === 'P' ? 'purge 스레드' : byId)} 이전 버전 ${r.kept}개를 지우지 못했다. A의 스냅숏이 그 버전을 볼 수 있다.`, [byId], { bad: true });
      return r;
    }

    views.push(view(true));
    for (const s of steps) {
      seq += 1;
      S.step = seq;
      S.label = String(seq);
      S.ev = [];
      for (const x of Object.values(S.sess)) { x.lines = []; x.ran = false; }
      const sess = S.sess[s.who];
      sess.ran = true;
      sess.lines.push(s.key);
      if (s.vacuum) {
        if (db === 'mysql') {
          const r = cleanup(S, 'accounts');
          cleanup(S, 'visits');
          emit(S, 'purge', r.removed ? `A가 끝나 이전 버전을 볼 수 있는 스냅숏이 없다. purge 스레드가 이전 버전 ${r.removed}개를 지웠다.` : 'purge 스레드가 지울 이전 버전을 찾았지만 남은 것이 없다.', [s.who]);
          result.afterClose = oldCount(S, 'accounts');
        } else {
          const before = oldCount(S, 'accounts');
          const r = cleanup(S, 'accounts');
          cleanup(S, 'visits');
          if (!s.final) {
            result.beforeCommit = { removed: r.removed, notRemovable: r.kept };
            emit(S, r.kept ? 'kept' : 'vacuum', r.kept ? `VACUUM (VERBOSE)가 dead tuple ${r.kept}개를 아직 지울 수 없다고 보고했다(dead but not yet removable). A의 스냅숏이 볼 수 있다.` : `VACUUM (VERBOSE)가 지운 dead tuple ${r.removed}개, 아직 지울 수 없는 것 0개를 보고했다.`, [s.who], r.kept ? { bad: true } : null);
          } else {
            result.afterClose = { removed: r.removed, notRemovable: r.kept, before };
            emit(S, 'vacuum', `VACUUM이 dead tuple ${r.removed}개를 지웠다. 비운 자리는 표 안에서 다시 쓰게 표시할 뿐 파일 크기는 줄이지 않는다.`, [s.who]);
          }
        }
        doneKeys.add(s.key);
        views.push(view(false));
        continue;
      }
      if (db === 'postgres' && s.op.k !== 'begin' && s.op.k !== 'commit' && (s.op.t === 'accounts' || (s.op.parts && s.op.parts[0].t === 'accounts'))) prune(s.who, s.op.k === 'update' ? '고치기 전에' : '읽으며');
      const rec = { op: s.op, sql: s.sql };
      const ctx = {};
      const out = runStatement(S, sess, rec, ctx);
      if (out.res) {
        const d = describeDone(S, sess, rec, out, ctx);
        let text = d.text;
        if (s.read && out.res.used.length) {
          const row = S.tables.accounts.rows[0];
          const hops = row.vers.indexOf(out.res.used[0].v);
          const scanned = row.vers.length;
          if (s.who === 'A') { result.aRead = out.res.rows[0][0]; result.aHops = hops; } else { result.cRead = out.res.rows[0][0]; result.cHops = hops; }
          text += db === 'mysql'
            ? (hops ? ` 표의 최신 버전은 이 스냅숏에 보이지 않아, undo log의 이전 버전 ${hops}개를 한 단계씩 되짚어 ${out.res.rows[0][0]}에 닿았다.` : ' 표의 최신 버전이 바로 보인다.')
            : ` 표 안의 튜플 ${scanned}개를 확인했다${scanned > 1 ? '. 보이지 않는 버전도 xmin·xmax를 비교하며 지나간다' : ''}.`;
        }
        if (s.who === 'B') text = `B가 잔액을 1 늘리고 바로 커밋했다(자동 커밋, ${s.k}/${cfg.updates}번째). 고치기 전 값은 ${db === 'mysql' ? 'undo log' : '표 안의 이전 튜플'}에 남는다.`;
        emit(S, d.type, text, [s.who], d.bad ? { bad: true } : null);
        sess.last = resultText(out.res.rows, s.op) || sess.last;
        if (out.trx && out.trx.auto) finishTrx(S, out.trx, 'committed');
        if (out.trx && out.trx.stmtSnap) out.trx.stmtSnap = null;
      } else emit(S, out.type, out.text, [s.who]);
      if (s.who === 'B') {
        if (db === 'mysql') {
          P.ran = true;
          P.lines.push('p1');
          prune('P');
          if (s.k === cfg.updates) doneKeys.add('p1');
        }
        if (s.k === cfg.updates) { result.afterUpdates = oldCount(S, 'accounts'); doneKeys.add('b'); }
      } else doneKeys.add(s.key);
      result.maxOld = Math.max(result.maxOld, oldCount(S, 'accounts'));
      views.push(view(false));
    }
    const threads = S.order.map((id) => ({ id, name: S.sess[id].name, role: id }));
    return { views, threads, result, hold: H, keys: keysOf };
  }

  // ---------- 커밋을 디스크에 (묶음 4) ----------
  // 자동 커밋 INSERT 하나가 커밋될 때 로그가 DB 메모리, OS 페이지 캐시, 디스크 중 어디까지 가는지와 fsync를 몇 번 기다리는지 본다.

  function simulateCommit(cfg) {
    const set = SETTINGS[cfg.setting];
    const db = cfg.db;
    const logs = db === 'mysql' ? [{ id: 'redo', name: 'redo log', sync: set.flush === 1 }, { id: 'binlog', name: 'binary log', sync: set.binlog === 1 }] : [{ id: 'wal', name: 'WAL', sync: set.sync }];
    const L = {};
    for (const l of logs) L[l.id] = { id: l.id, type: 'log', name: l.name, sync: l.sync, mem: [], os: [], disk: [], lost: [] };
    const sessions = [{ id: 'app', name: '앱' }, { id: 'W', name: db === 'mysql' ? '로그 스레드' : 'WAL writer' }];
    const views = [];
    const acked = [];
    let fsyncs = 0;
    let step = 0;
    let ev = [];
    const st0 = { app: { cls: 'turn', why: '다음 문장 전', wait: null, lines: [], local: '' }, W: { cls: 'turn', why: '쉬는 중', wait: null, lines: [], local: '' } };
    let ths = clone(st0);
    const fsyncByStep = [];
    function view(initial, extra) {
      const th = {};
      for (const s of sessions) {
        const x = ths[s.id];
        th[s.id] = { cls: x.cls, why: x.why, after: { cls: x.cls === 'run' ? (x.wait ? 'event' : 'turn') : x.cls, why: x.why }, trx: '', snap: '', snapAt: null, local: x.local, err: '',
          lines: x.lines.slice(), at: x.at || null, waitOn: x.wait, waitBy: null, sleeping: false, deferred: [] };
      }
      views.push(Object.assign({ step, label: String(step), tail: false, sent: null, actors: sessions.filter((s) => ths[s.id].cls === 'run').map((s) => s.id),
        th, obj: clone(L), locks: [], ev: initial ? [{ type: 'start', text: `준비: ${set.label}. 앱이 자동 커밋 INSERT를 ${cfg.commits}번 보낸다.`, ids: [] }] : ev, cycle: null, fsyncs }, extra || {}));
    }
    function begin(label) {
      step += 1;
      ev = [];
      fsyncs = 0;
      for (const s of sessions) { ths[s.id].lines = []; if (ths[s.id].cls === 'run') ths[s.id].cls = ths[s.id].wait ? 'event' : 'turn'; }
      return label;
    }
    function move(log, id, from, to) { L[log][from] = L[log][from].filter((x) => x !== id); L[log][to].push(id); }
    view(true);
    for (let c = 1; c <= cfg.commits; c += 1) {
      const id = `커밋 ${c}`;
      // INSERT를 실행하며 로그 기록을 DB 메모리에 쓴다.
      begin();
      ths.app = { cls: 'run', why: '', wait: null, lines: [`i${c}`], local: `INSERT ${c}`, at: `i${c}` };
      for (const l of logs) L[l.id].mem.push(id);
      emit({ ev }, 'write', `앱이 INSERT ${c}을 보냈다(자동 커밋). 변경을 ${logs.map((l) => (l.id === 'binlog' ? 'binary log 캐시' : `${l.name} 버퍼`)).join('와 ')}(DB 메모리)에 적었다.`, ['app']);
      fsyncByStep.push(0);
      view(false);
      // 커밋: 로그마다 OS에 쓰고, 설정이 1(on)인 로그는 fsync가 끝나기를 기다린다.
      const waits = logs.filter((l) => l.sync);
      let i = 0;
      for (const l of logs) {
        if (!l.sync) continue;
        begin();
        ths.app = { cls: 'run', why: '', wait: l.id, lines: [`i${c}`], local: `INSERT ${c}`, at: `i${c}` };
        for (const pre of logs.slice(0, logs.indexOf(l))) if (L[pre.id].mem.includes(id)) { move(pre.id, id, 'mem', 'os'); emit({ ev }, 'os', `${pre.name}를 OS 페이지 캐시에 썼다. fsync는 부르지 않는다.`, ['app']); }
        if (i > 0) { const prev = waits[i - 1]; move(prev.id, id, 'os', 'disk'); fsyncs += 1; emit({ ev }, 'fsync-done', `${prev.name}의 fsync가 끝나 디스크에 내려갔다.`, ['app']); }
        move(l.id, id, 'mem', 'os');
        emit({ ev }, 'fsync', `${l.name}를 OS 페이지 캐시에 쓰고 fsync를 불렀다. 디스크에 실제로 쓰고 끝날 때까지 앱의 커밋이 기다린다.`, ['app']);
        fsyncByStep.push(fsyncs);
        view(false);
        i += 1;
      }
      begin();
      ths.app = { cls: 'run', why: '', wait: null, lines: [`i${c}`], local: `커밋 ${c} 완료`, at: c < cfg.commits ? `i${c + 1}` : null };
      if (waits.length) { move(waits[waits.length - 1].id, id, 'os', 'disk'); fsyncs += 1; emit({ ev }, 'fsync-done', `${waits[waits.length - 1].name}의 fsync가 끝나 디스크에 내려갔다.`, ['app']); }
      for (const l of logs) {
        if (l.sync || !L[l.id].mem.includes(id)) continue;
        if (db === 'postgres') continue;
        move(l.id, id, 'mem', 'os');
        emit({ ev }, 'os', `${l.name}를 OS 페이지 캐시에 썼다. fsync는 ${l.id === 'redo' ? '로그 스레드가 약 1초마다' : 'OS가 정한 때에'} 한다.`, ['app']);
      }
      acked.push(id);
      emit({ ev }, 'ack', `커밋 ${c}이 끝났다고 앱에 알렸다. 이 커밋에서 기다린 fsync는 ${waits.length}번이다.${db === 'postgres' && !set.sync ? ' WAL은 아직 DB 메모리에 있다.' : ''}`, ['app']);
      fsyncByStep.push(fsyncs);
      if (c === cfg.commits) ths.app.at = null;
      view(false);
    }
    ths.app.cls = 'done';
    ths.app.why = '끝';
    if (cfg.crash !== 'none') {
      begin();
      ths.app.cls = 'done';
      const lostDb = [];
      for (const l of logs) {
        lostDb.push(...L[l.id].mem.map((x) => [l.id, x]));
        L[l.id].lost.push(...L[l.id].mem);
        L[l.id].mem = [];
        if (cfg.crash === 'os') { L[l.id].lost.push(...L[l.id].os); L[l.id].os = []; }
      }
      emit({ ev }, 'crash', cfg.crash === 'db' ? 'DB 프로세스가 죽었다. DB 메모리의 로그 기록은 사라지고, OS 페이지 캐시에 쓴 것은 OS가 디스크에 내린다.' : 'OS가 죽었다(전원이 꺼짐과 같다). DB 메모리와 OS 페이지 캐시의 로그 기록이 사라지고 디스크에 내린 것만 남는다.', [], { bad: logs.some((l) => L[l.id].lost.length) });
      if (cfg.crash === 'db') for (const l of logs) { L[l.id].disk.push(...L[l.id].os); L[l.id].os = []; }
      for (const l of logs) if (L[l.id].lost.length) emit({ ev }, 'lost', `${l.name}에서 앱이 끝났다고 받은 ${L[l.id].lost.join(', ')}의 기록이 사라졌다.`, [], { bad: true });
      fsyncByStep.push(0);
      view(false);
    } else {
      const bg = logs.filter((l) => !l.sync && (l.id !== 'binlog'));
      if (bg.length) {
        begin();
        ths.W = { cls: 'run', why: '', wait: null, lines: ['bg'], local: 'fsync' };
        for (const l of bg) {
          const items = L[l.id].mem.concat(L[l.id].os);
          L[l.id].disk.push(...items);
          L[l.id].mem = [];
          L[l.id].os = [];
          fsyncs += 1;
          emit({ ev }, 'bg', db === 'mysql' ? `약 1초 뒤 로그 스레드가 redo log를 fsync해 ${items.join(', ')}의 기록이 디스크에 내려갔다.` : `WAL writer가 WAL을 쓰고 fsync해 ${items.join(', ')}의 기록이 디스크에 내려갔다(최대 wal_writer_delay의 3배 안).`, ['W']);
        }
        fsyncByStep.push(fsyncs);
        view(false);
        ths.W.cls = 'done';
      }
    }
    const lost = Object.fromEntries(logs.map((l) => [l.id, L[l.id].lost.slice()]));
    const waitsPerCommit = logs.filter((l) => l.sync).length;
    const threads = sessions.map((s) => ({ id: s.id, name: s.name, role: s.id }));
    return { views, threads, result: { db, setting: cfg.setting, waitsPerCommit, acked, lost, onDisk: Object.fromEntries(logs.map((l) => [l.id, L[l.id].disk.slice()])), binlogInOs: db === 'mysql' ? L.binlog.os.slice() : [] }, logs, fsyncByStep };
  }

  // ---------- 하나로 묶기 ----------

  function simulate(scene, input) {
    const cfg = normalizeConfig(scene, input);
    if (scene === 'hold') {
      const r = simulateHold(cfg);
      return { scene, cfg, views: r.views, threads: r.threads, result: r.result, outcome: 'finished', keys: r.keys, hold: r.hold };
    }
    if (scene === 'commit') {
      const r = simulateCommit(cfg);
      return { scene, cfg, views: r.views, threads: r.threads, result: r.result, outcome: cfg.crash === 'none' ? 'finished' : 'crash', logs: r.logs };
    }
    const name = timelineName(scene, cfg);
    const T = TIMELINES[name];
    const r = simulateTimeline(name, cfg.db, cfg.level);
    const threads = r.S.order.map((id) => ({ id, name: id, role: id }));
    return { scene, cfg, timeline: name, title: T.title, setup: T.setup, steps: T.steps.map((s, i) => ({ s: s.s, sql: s.sql, note: s.note, key: `s${i + 1}` })),
      views: r.views, threads, records: r.records, outcome: 'finished', result: { records: r.records } };
  }

  return { VERSION, LEVELS, LEVEL_NAME, DB_NAME, DEFAULT_LEVEL, TIMELINES, HOLDS, HOLD_SETUP, SETTINGS, SCENARIOS, CHOICES, RANGES, DEFAULTS,
    UPDATE_BALANCE, READ_BALANCE, normalizeConfig, timelineName, simulate, runTimeline, josa };
});
