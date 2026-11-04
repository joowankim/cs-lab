/*
 * 락 관계도의 설명용 실행 모형.
 *
 * 순서표 장면(묶음 ①②, ③의 두 요청)은 실험(lock_timelines.py)과 같은 SQL을 같은 순서로 보낸다. 한 단계는 순서표의 한 줄이다.
 * 실험의 실행 틀처럼 한 세션은 앞 문장이 끝나야 다음 문장을 보내고, 끝나지 않은 문장은 "기다림"으로 남긴다.
 * 동시 요청 장면(문제 상황 2-1, 묶음 ③)은 burst_lab.py의 요청 코드와 같은 SQL을 보낸다. 한 단계에 요청마다 문장을 하나씩
 * 요청 번호 순으로 보내고, 앱이 50ms 일하는 것도 한 단계로 센다.
 * 커넥션 풀 장면(묶음 ④)은 pool_lab.py의 요청 50개를 0.2초 단위로 나눠 그린다. 이 장면만 단계에 모형의 시각을 붙인다.
 * 락은 MySQL 8.4 InnoDB의 레코드 락, 갭 락, 넥스트 키 락, 삽입 의도 락과 그 충돌 규칙을 이 장면들에 필요한 만큼 옮겼다.
 * 단계는 이벤트의 순서이고 시간 길이가 아니다.
 * 브라우저에서는 window.LockModel, Node.js에서는 require()로 쓴다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LockModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2026-11-04.1';
  const LEVEL_NAME = { RC: 'READ COMMITTED', RR: 'REPEATABLE READ', SER: 'SERIALIZABLE' };

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
  const W = (w) => josa(w, ['과', '와']);
  // 로/으로: 받침이 없거나 ㄹ 받침이면 '로'
  function RO(word) {
    const w = String(word).trim().replace(/[)\]]+$/, '');
    const ch = w.slice(-1);
    const code = ch.charCodeAt(0);
    let ro;
    if (code >= 0xac00 && code <= 0xd7a3) { const b = (code - 0xac00) % 28; ro = b === 0 || b === 8; }
    else if (/[0-9]/.test(ch)) ro = !'036'.includes(ch);
    else ro = !(/[mn]$/i.test(w) || /ng$/i.test(w));
    return word + (ro ? '로' : '으로');
  }

  // ---------- 표 ----------
  // 표마다 기본 키, 열, 보조 인덱스, 처음 행, 관계도에 적을 값 글자. 실험의 준비 SQL과 같다.

  const ENTRIES_ROWS = [[1, 3], [2, 7], [3, 7], [4, 12]];
  const entries = (index, rows) => ({
    name: 'entries', pk: 'id', cols: ['id', 'user_id'], rows: rows || ENTRIES_ROWS,
    indexes: index ? [{ name: 'idx_user', cols: ['user_id'], unique: false }] : [],
    text: (r) => `user ${r.user_id}`,
    sql: [`CREATE TABLE entries (id INT PRIMARY KEY, user_id INT NOT NULL${index ? ', KEY idx_user (user_id)' : ''})`,
      `INSERT INTO entries (id, user_id) VALUES ${(rows || ENTRIES_ROWS).map((r) => `(${r.join(', ')})`).join(', ')}`],
  });
  const ACCOUNTS = {
    name: 'accounts', pk: 'id', cols: ['id', 'balance'], rows: [[1, 1000], [2, 1000]], indexes: [], text: (r) => String(r.balance),
    sql: ['CREATE TABLE accounts (id INT PRIMARY KEY, balance INT NOT NULL)', 'INSERT INTO accounts (id, balance) VALUES (1, 1000), (2, 1000)'],
  };
  const rewards = (unique) => ({
    name: 'rewards', pk: 'id', autoinc: true, cols: ['id', 'user_id', 'event_id', 'amount'], rows: [],
    indexes: [{ name: 'idx_user_event', cols: ['user_id', 'event_id'], unique }], text: (r) => String(r.amount),
    sql: [`CREATE TABLE rewards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_id INT NOT NULL, amount INT NOT NULL, ${unique ? 'UNIQUE KEY' : 'KEY'} idx_user_event (user_id, event_id))`],
  });
  const POINTS_ONLY = {
    name: 'points', pk: 'user_id', cols: ['user_id', 'balance'], rows: [[7, 1000]], indexes: [], text: (r) => String(r.balance),
    sql: ['CREATE TABLE points (user_id INT PRIMARY KEY, balance INT NOT NULL)', 'INSERT INTO points (user_id, balance) VALUES (7, 1000)'],
  };
  const points = (version) => ({
    name: 'points', pk: 'user_id', cols: ['user_id', 'balance', 'version'], rows: [[7, 0, version]], indexes: [], text: (r) => `${r.balance} · v${r.version}`,
    sql: ['CREATE TABLE points (user_id INT PRIMARY KEY, balance INT NOT NULL, version INT NOT NULL DEFAULT 0)', `INSERT INTO points (user_id, balance, version) VALUES (7, 0, ${version})`],
  });

  // ---------- 문장 ----------

  const st = (s, sql, op, note) => ({ s, sql, op, note: note || '' });
  const BEGIN = { k: 'begin' };
  const COMMIT = { k: 'commit' };
  const ROLLBACK = { k: 'rollback' };
  const sel = (t, eq, out, lock, col) => ({ k: 'select', t, eq, out, lock: lock || null, col: col || null });
  const add = (t, row) => ({ k: 'insert', t, row });
  const upd = (t, pk, set, cond, what) => ({ k: 'update', t, pk, set, cond: cond || null, what });
  const del = (t, pk) => ({ k: 'delete', t, pk });
  const plus = (col, n) => (r) => ({ ...r, [col]: r[col] + n });
  const setTo = (col, n) => (r) => ({ ...r, [col]: n });

  const FOR_UPDATE_7 = 'SELECT id FROM entries WHERE user_id = 7 FOR UPDATE';
  const ROWS7 = 'SELECT id FROM entries WHERE user_id = 7 ORDER BY id';
  const COUNT = 'SELECT COUNT(*) FROM rewards WHERE user_id = 7 AND event_id = 1';
  const INSERT_REWARD = 'INSERT INTO rewards (user_id, event_id, amount) VALUES (7, 1, 1000)';
  const PAY = 'UPDATE points SET balance = balance + 1000 WHERE user_id = 7';
  const LOCK_POINTS = 'SELECT balance FROM points WHERE user_id = 7 FOR UPDATE';
  const PAY_IF_ZERO = 'UPDATE points SET balance = balance + 1000 WHERE user_id = 7 AND version = 0';
  const VERSION_UP = 'UPDATE points SET version = version + 1 WHERE user_id = 7';
  const EQ7 = { user_id: 7 };
  const EQ71 = { user_id: 7, event_id: 1 };

  // ---------- 순서표 (lock_timelines.py와 같은 SQL, 같은 순서) ----------

  function lockedRange(title, index, sql, op, note) {
    return {
      title, tables: [entries(index)], levels: ['RR', 'RC'], detects: ['ON'],
      steps: [st('A', 'START TRANSACTION', BEGIN), st('A', FOR_UPDATE_7, sel('entries', EQ7, 'ids', 'X'), 'A: user 7의 응모를 잠그며 읽음'),
        st('B', sql, op, note), st('A', 'COMMIT', COMMIT)],
    };
  }
  const ins = (id, user) => [`INSERT INTO entries (id, user_id) VALUES (${id}, ${user})`, add('entries', { id, user_id: user })];
  const GAP_CASES = {
    user7: ['(가)', 10, 7, 'B: user 7(잠근 값과 같음)'],
    user5: ['(나)', 11, 5, 'B: user 5(3과 7 사이)'],
    user10: ['(다)', 12, 10, 'B: user 10(7과 12 사이)'],
    user15: ['(라)', 13, 15, 'B: user 15(12보다 큼)'],
    user1: ['(마)', 14, 1, 'B: user 1(3보다 작음)'],
  };
  const NO_INDEX_CASES = {
    user7: ['(가)', 'noidx-insert-user7', ...ins(10, 7), 'B: user 7'],
    user15: ['(나)', 'noidx-insert-user15', ...ins(13, 15), 'B: user 15'],
    delete1: ['(다)', 'noidx-delete-id1', 'DELETE FROM entries WHERE id = 1', del('entries', 1), 'B: user 3의 응모(id 1) 취소'],
  };

  const TIMELINES = {};
  for (const [key, [mark, id, user, note]] of Object.entries(GAP_CASES)) {
    TIMELINES[`idx-insert-${key}`] = lockedRange(`문제 상황 1 ${mark}: 잠근 응모 사이로 들어오는 새 응모`, true, ...ins(id, user), note);
  }
  for (const [mark, name, sql, op, note] of Object.values(NO_INDEX_CASES)) {
    TIMELINES[name] = lockedRange(`문제 상황 1-1 ${mark}: 인덱스가 없을 때`, false, sql, op, note);
  }
  TIMELINES['serializable-insert'] = {
    title: '문제 상황 1-2: 실험 3에서 미뤄 둔 1.74초', tables: [entries(false, [[1, 7], [2, 7], [3, 8]])], levels: ['SER'], detects: ['ON'],
    steps: [st('A', 'START TRANSACTION', BEGIN), st('A', ROWS7, sel('entries', EQ7, 'ids'), '1번'), st('B', 'START TRANSACTION', BEGIN, '2번: 다른 요청'),
      st('B', 'INSERT INTO entries (id, user_id) VALUES (4, 7)', add('entries', { id: 4, user_id: 7 }), '2번: 다른 요청'), st('B', 'COMMIT', COMMIT, '2번: 다른 요청'),
      st('A', `${ROWS7} FOR UPDATE`, sel('entries', EQ7, 'ids', 'X'), '3번'), st('A', ROWS7, sel('entries', EQ7, 'ids'), '4번'), st('A', 'COMMIT', COMMIT)],
  };
  const acc = (sign, id) => [`UPDATE accounts SET balance = balance ${sign} 100 WHERE id = ${id}`, upd('accounts', id, plus('balance', sign === '-' ? -100 : 100), null, `${sign}100`)];
  TIMELINES['transfer-reverse'] = {
    title: '문제 상황 2: 서로 반대로 보낸 두 이체', tables: [ACCOUNTS], levels: ['RR'], detects: ['ON', 'OFF'],
    steps: [st('A', 'START TRANSACTION', BEGIN, 'A: 1번 계좌 → 2번 계좌로 100'), st('A', ...acc('-', 1), '1번'), st('B', 'START TRANSACTION', BEGIN, 'B: 2번 계좌 → 1번 계좌로 100'),
      st('B', ...acc('-', 2), '2번'), st('A', ...acc('+', 2), '3번'), st('B', ...acc('+', 1), '4번: 3번 2초 뒤'), st('A', 'COMMIT', COMMIT, '5번'), st('B', 'COMMIT', COMMIT, '6번')],
  };
  TIMELINES['transfer-ordered'] = {
    title: '문제 상황 2 이어서: 두 이체가 작은 id부터 고칠 때', tables: [ACCOUNTS], levels: ['RR'], detects: ['ON', 'OFF'],
    steps: [st('A', 'START TRANSACTION', BEGIN, 'A: 1번 계좌 → 2번 계좌로 100'), st('A', ...acc('-', 1), '1번'), st('B', 'START TRANSACTION', BEGIN, 'B: 2번 계좌 → 1번 계좌로 100, 작은 id부터'),
      st('B', ...acc('+', 1), '2번'), st('A', ...acc('+', 2), '3번'), st('B', ...acc('-', 2), '4번'), st('A', 'COMMIT', COMMIT, '5번'), st('B', 'COMMIT', COMMIT, '6번')],
  };
  TIMELINES['reward-count-lock-pair'] = {
    title: '문제 상황 3 (가) 처음 판을 두 요청으로 줄임', tables: [rewards(false)], levels: ['RR'], detects: ['ON'],
    steps: [st('A', 'START TRANSACTION', BEGIN, 'A: 첫 지급 요청'), st('A', `${COUNT} FOR UPDATE`, sel('rewards', EQ71, 'count', 'X'), 'A: 받았는지 확인하며 잠금'),
      st('B', 'START TRANSACTION', BEGIN, 'B: 같은 지급 요청'), st('B', `${COUNT} FOR UPDATE`, sel('rewards', EQ71, 'count', 'X'), 'B: 받았는지 확인하며 잠금'),
      st('A', INSERT_REWARD, add('rewards', { user_id: 7, event_id: 1, amount: 1000 }), 'A: 0이라 지급 기록'),
      st('B', INSERT_REWARD, add('rewards', { user_id: 7, event_id: 1, amount: 1000 }), 'B: 0이라 지급 기록'), st('A', 'COMMIT', COMMIT), st('B', 'COMMIT', COMMIT)],
  };
  for (const [name, T] of Object.entries(TIMELINES)) T.name = name;

  // ---------- 실행 상태 ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function makeState(opts) {
    return Object.assign({ step: 0, label: '0', nextTrx: 1, nextVer: 1, seq: 1, tables: {}, trx: {}, committed: [0], locks: [], sess: {}, order: [], ev: [], cycle: null, detect: true, deadlocks: [] }, opts || {});
  }

  function addTable(S, spec) {
    const t = { name: spec.name, spec, rows: [], autoinc: 1 };
    for (const vals of spec.rows) {
      const r = Object.fromEntries(spec.cols.map((c, i) => [c, vals[i]]));
      t.rows.push({ k: r[spec.pk], vers: [{ id: S.nextVer++, vals: r, trx: 0 }], inIdx: Object.fromEntries(spec.indexes.map((x) => [x.name, true])) });
    }
    if (spec.autoinc) t.autoinc = t.rows.reduce((m, r) => Math.max(m, r.k), 0) + 1;
    S.tables[spec.name] = t;
    return t;
  }

  function addSession(S, id, opts) {
    S.sess[id] = Object.assign({ id, name: id, iso: 'RR', trx: null, pending: null, deferred: [], last: '', err: '', lines: [], ran: false, script: [] }, opts || {});
    S.order.push(id);
    return S.sess[id];
  }

  function emit(S, type, text, ids, extra) { S.ev.push(Object.assign({ type, text, ids: ids || [] }, extra || {})); }
  function trxOf(S, sess) { return sess.trx != null ? S.trx[sess.trx] : null; }
  function sessName(S, trxId) { const t = S.trx[trxId]; return t ? t.sess : '?'; }
  // 글에 쓰는 이름: 순서표는 A·B, 동시 요청은 '요청 1'
  function who(S, trxId) { const id = sessName(S, trxId); return S.sess[id] ? S.sess[id].name : id; }
  function isCommitted(S, trxId) { return S.committed.includes(trxId); }

  function newTrx(S, sess, auto) {
    const id = S.nextTrx++;
    S.trx[id] = { id, sess: sess.id, iso: sess.iso, state: 'active', auto: !!auto, snap: null, wrote: false };
    sess.trx = id;
    return S.trx[id];
  }

  // ---------- 스냅숏 (03 화면과 같은 규칙) ----------

  function newSnap(S, trx) { return { at: S.label, seen: S.committed.slice(), own: trx.id }; }
  function visibleVer(row, snap, trx) { return row.vers.find((v) => v.trx === trx.id || snap.seen.includes(v.trx)) || null; }
  function latestVer(S, row, trx) { return row.vers.find((v) => v.trx === trx.id || isCommitted(S, v.trx)) || null; }
  // REPEATABLE READ는 트랜잭션의 첫 consistent read에서 만든 스냅숏을 끝까지 쓰고, READ COMMITTED와 자동 커밋 문장은 문장마다 만든다.
  function snapFor(S, trx, ctx) {
    if (trx.auto || trx.iso === 'RC') {
      if (!ctx.snap) ctx.snap = newSnap(S, trx);
      return ctx.snap;
    }
    if (!trx.snap) { trx.snap = newSnap(S, trx); ctx.snapNew = true; }
    return trx.snap;
  }

  // ---------- 인덱스 ----------
  // 인덱스 레코드는 키 순서로 정렬된다. PRIMARY(클러스터형 인덱스)의 키는 기본 키, 보조 인덱스의 키는 (인덱스 열…, 기본 키)다.
  // 레코드 이름(data)은 performance_schema.data_locks의 LOCK_DATA와 같은 꼴이다('2', '7, 2', '7, 1, 1').

  function cmpKey(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === undefined) return -1;
      if (b[i] === undefined) return 1;
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }
  function cmpPrefix(key, prefix) {
    for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return key[i] < prefix[i] ? -1 : 1;
    return 0;
  }
  function ixSpec(t, name) { return name === 'PRIMARY' ? { name, cols: [t.spec.pk], unique: true, primary: true } : t.spec.indexes.find((x) => x.name === name); }
  function ixNames(t) { return [...t.spec.indexes.map((x) => x.name), 'PRIMARY']; }
  function keyOf(t, ix, vals) { return ix === 'PRIMARY' ? [vals[t.spec.pk]] : [...ixSpec(t, ix).cols.map((c) => vals[c]), vals[t.spec.pk]]; }
  function records(t, ix) {
    const out = [];
    for (const row of t.rows) {
      if (!row.vers.length || (ix !== 'PRIMARY' && !row.inIdx[ix])) continue;
      const key = keyOf(t, ix, row.vers[0].vals);
      out.push({ key, data: key.join(', '), row });
    }
    return out.sort((a, b) => cmpKey(a.key, b.key));
  }
  // 키 뒤의 첫 레코드. 없으면 마지막 레코드 뒤의 자리(supremum pseudo-record)다.
  function successor(t, ix, key, except) {
    const r = records(t, ix).find((x) => x.row !== except && cmpKey(x.key, key) > 0);
    return r ? { rec: r.data, key: r.key } : { rec: 'sup', key: null };
  }
  function predecessor(t, ix, key, except) {
    const list = records(t, ix).filter((x) => x.row !== except && cmpKey(x.key, key) < 0);
    return list.length ? list[list.length - 1].data : null;
  }

  // ---------- 락 ----------
  // 락 하나: 트랜잭션, 표, 인덱스, 레코드(data 또는 'sup'), 모드 S·X, 종류 NK(넥스트 키: 레코드와 그 앞 갭), REC(레코드만),
  // GAP(레코드 앞 갭만), II(삽입 의도), TABLE(표의 의도 락 IS·IX), 기다림 여부. seq는 락 대기열에 들어온 순서다.
  // supremum의 락은 늘 갭(마지막 레코드 뒤)을 잠근다.

  const compatible = (a, b) => a === 'S' && b === 'S';
  // InnoDB lock_rec_has_to_wait와 같은 규칙: 요청(req)이 다른 트랜잭션의 락 l 때문에 기다려야 하는가.
  function hasToWait(req, l) {
    if (l.trx === req.trx || l.type === 'TABLE') return false;
    if (compatible(req.mode, l.mode)) return false;
    const ii = req.type === 'II';
    if ((req.rec === 'sup' || req.type === 'GAP') && !ii) return false; // 삽입 의도가 아닌 갭 락은 아무것도 기다리지 않는다
    if (!ii && l.type === 'GAP') return false; // 레코드를 잠그는 요청은 갭 락을 기다리지 않는다
    if ((req.type === 'GAP' || ii) && l.type === 'REC') return false; // 갭(삽입 의도 포함)은 레코드 락을 기다리지 않는다
    if (l.type === 'II') return false; // 삽입 의도 락은 아무것도 막지 않는다
    return true;
  }
  const onRec = (l, t, ix, rec) => l.type !== 'TABLE' && l.table === t && l.index === ix && l.rec === rec;
  function covers(l, mode, type, rec) {
    if (l.wait || l.type === 'II' || l.type === 'TABLE' || !(l.mode === mode || l.mode === 'X')) return false;
    if (rec === 'sup') return true;
    return l.type === type || l.type === 'NK';
  }

  function tableLock(S, trx, t, mode) {
    if (S.locks.some((l) => l.type === 'TABLE' && l.trx === trx.id && l.table === t && (l.mode === mode || l.mode === 'IX'))) return;
    S.locks.push({ seq: S.seq++, trx: trx.id, table: t, index: null, rec: null, key: null, mode, type: 'TABLE', wait: false });
  }

  // 락을 청한다. 이미 그만큼 쥐었으면 그대로, 부딪히는 락이 없으면 준다. 부딪히면 기다리는 락으로 대기열에 넣는다.
  // 삽입 의도 락은 부딪힐 때만 락으로 남는다(부딪히지 않으면 확인만 하고 끝난다).
  function request(S, trx, t, ix, rec, key, mode, type) {
    if (type !== 'II' && S.locks.some((l) => l.trx === trx.id && onRec(l, t, ix, rec) && covers(l, mode, type, rec))) return { ok: true };
    const req = { trx: trx.id, mode, type, rec };
    const block = S.locks.some((l) => onRec(l, t, ix, rec) && hasToWait(req, l));
    if (type === 'II' && !block) return { ok: true };
    const lock = { seq: S.seq++, trx: trx.id, table: t, index: ix, rec, key, mode, type, wait: block };
    S.locks.push(lock);
    return block ? { wait: lock } : { ok: true, lock };
  }

  // 다른 트랜잭션이 넣고 아직 커밋하지 않은 레코드는 그 트랜잭션이 락 구조 없이 잠근 것이다(암묵적 락).
  // 다른 트랜잭션이 그 레코드에 락을 청하면 InnoDB가 먼저 주인의 명시적인 X 레코드 락으로 바꾼다.
  function convertImplicit(S, trx, t, ix, r) {
    if (!r) return;
    const v = r.row.vers[0];
    const owner = v && v.trx ? S.trx[v.trx] : null;
    if (!owner || owner.state !== 'active' || owner.id === trx.id) return;
    if (ix !== 'PRIMARY' && !(v.ins || v.del)) return;
    if (S.locks.some((l) => l.trx === owner.id && onRec(l, t, ix, r.data) && !l.wait && l.mode === 'X' && (l.type === 'REC' || l.type === 'NK'))) return;
    S.locks.push({ seq: S.seq++, trx: owner.id, table: t, index: ix, rec: r.data, key: r.key, mode: 'X', type: 'REC', wait: false, implicit: true });
  }

  // 기다리는 락 w를 막는 락: 같은 레코드에서 w와 부딪히는 쥔 락 전부와, w보다 먼저 대기열에 든 기다리는 락.
  // MySQL 8의 레코드 락 대기열은 쥔 락을 앞에, 기다리는 락을 들어온 순서대로 뒤에 둔다. 그래서 w가 기다리는 동안
  // 다른 트랜잭션이 기다림 없이 얻은 갭 락도 w를 막는다.
  function blockingLocks(S, w) {
    return S.locks.filter((l) => l !== w && onRec(l, w.table, w.index, w.rec) && !(l.wait && l.seq > w.seq) && hasToWait(w, l));
  }
  function blockersOf(S, w) { return [...new Set(blockingLocks(S, w).map((l) => l.trx))]; }
  function waitingLock(S, trxId) { return S.locks.find((l) => l.trx === trxId && l.wait) || null; }

  // 기다림의 고리: start에서 기다림을 따라가 start로 돌아오는 길. 데드락 탐지가 켜져 있으면 락을 기다리게 될 때마다 찾는다.
  function findCycle(S, start) {
    const path = [start];
    const seen = new Set([start]);
    function dfs(tid) {
      const w = waitingLock(S, tid);
      if (!w) return false;
      for (const b of blockersOf(S, w)) {
        if (b === start) return true;
        if (seen.has(b)) continue;
        seen.add(b);
        path.push(b);
        if (dfs(b)) return true;
        path.pop();
      }
      return false;
    }
    return dfs(start) ? path : null;
  }

  // 락을 놓은 뒤, 대기열 앞에서부터 이제 막는 락이 없는 기다림을 준다.
  function grantWaiting(S) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const w of S.locks.filter((l) => l.wait).sort((a, b) => a.seq - b.seq)) {
        if (blockersOf(S, w).length) continue;
        w.wait = false;
        changed = true;
      }
    }
  }

  // 레코드를 지울 때(넣은 행을 되돌리거나 지운 행을 정리할 때) 그 레코드에 걸린 다른 트랜잭션의 락은 다음 레코드의 갭 락으로 옮긴다.
  function removeRow(S, t, row, vals, owner) {
    for (const ix of ixNames(t)) {
      if (ix !== 'PRIMARY' && !row.inIdx[ix]) continue;
      const key = keyOf(t, ix, vals);
      const data = key.join(', ');
      const succ = successor(t, ix, key, row);
      for (const l of S.locks.filter((x) => onRec(x, t.name, ix, data) && x.trx !== owner && !x.wait && x.type !== 'II')) {
        if (!S.locks.some((x) => x.trx === l.trx && onRec(x, t.name, ix, succ.rec) && covers(x, l.mode, 'GAP', succ.rec))) {
          S.locks.push({ seq: S.seq++, trx: l.trx, table: t.name, index: ix, rec: succ.rec, key: succ.key, mode: l.mode, type: succ.rec === 'sup' ? 'NK' : 'GAP', wait: false });
        }
      }
      S.locks = S.locks.filter((x) => !onRec(x, t.name, ix, data));
    }
    t.rows = t.rows.filter((r) => r !== row);
  }

  function endTrx(S, trx) {
    S.locks = S.locks.filter((l) => l.trx !== trx.id);
    trx.snap = null;
    const sess = S.sess[trx.sess];
    if (sess && sess.trx === trx.id) sess.trx = null;
    grantWaiting(S);
  }
  // 커밋: 지운 행은 바로 정리한다(purge를 줄임). 쥔 락을 모두 놓는다.
  function commitTrx(S, trx) {
    trx.state = 'committed';
    S.committed.push(trx.id);
    for (const t of Object.values(S.tables)) {
      for (const row of t.rows.slice()) {
        const v = row.vers[0];
        if (v && v.trx === trx.id && v.del) removeRow(S, t, row, v.vals, trx.id);
      }
    }
    endTrx(S, trx);
  }
  // 되돌리기: 이 트랜잭션이 쓴 버전을 지우고, 넣은 행은 인덱스에서 뺀다. 쥔 락을 모두 놓는다.
  function rollbackTrx(S, trx) {
    trx.state = 'aborted';
    for (const t of Object.values(S.tables)) {
      for (const row of t.rows.slice()) {
        if (!row.vers.some((v) => v.trx === trx.id)) continue;
        const vals = row.vers[0].vals;
        row.vers = row.vers.filter((v) => v.trx !== trx.id);
        if (!row.vers.length) removeRow(S, t, row, vals, trx.id);
      }
    }
    endTrx(S, trx);
  }
  // 문장만 되돌리기(1062, 1205): 이 문장이 넣은 행을 지운다. 문장이 얻은 락과 트랜잭션은 그대로 둔다.
  function rollbackStatement(S, trx, ctx) {
    if (ctx.row && S.tables[ctx.t].rows.includes(ctx.row)) {
      const vals = ctx.row.vers[0].vals;
      ctx.row.vers = ctx.row.vers.filter((v) => v.trx !== trx.id);
      if (!ctx.row.vers.length) removeRow(S, S.tables[ctx.t], ctx.row, vals, trx.id);
    }
    grantWaiting(S);
  }

  // ---------- 문장 실행 ----------

  function matchEq(vals, eq) { return Object.entries(eq || {}).every(([c, v]) => vals[c] === v); }

  // 조건으로 쓸 인덱스: 기본 키 하나와 같으면 PRIMARY, 보조 인덱스의 앞 열과 같으면 그 인덱스, 아니면 PRIMARY 전체를 훑는다.
  function pathFor(t, eq) {
    const cols = Object.keys(eq || {});
    if (cols.length === 1 && cols[0] === t.spec.pk) return { index: 'PRIMARY', primary: true, vals: [eq[t.spec.pk]] };
    for (const ix of t.spec.indexes) {
      let n = 0;
      while (n < ix.cols.length && cols.includes(ix.cols[n])) n += 1;
      if (n > 0) return { index: ix.name, vals: ix.cols.slice(0, n).map((c) => eq[c]), unique: ix.unique && n === ix.cols.length };
    }
    return { index: 'PRIMARY', full: true };
  }

  // 잠그며 읽기: 훑은 인덱스 레코드마다 락을 건다. REPEATABLE READ 이상은 넥스트 키 락과 갭 락으로 범위를 잠그고,
  // READ COMMITTED는 조건에 맞는 레코드만 레코드 락으로 잠근다. 보조 인덱스로 찾으면 PRIMARY의 그 행에도 레코드 락을 건다.
  function lockingScan(S, trx, t, eq, m) {
    const gaps = trx.iso !== 'RC';
    const path = pathFor(t, eq);
    const take = (ix, r, type) => { if (r && r.row) convertImplicit(S, trx, t.name, ix, r); return request(S, trx, t.name, ix, r ? r.data : 'sup', r ? r.key : null, m, type); };
    tableLock(S, trx, t.name, m === 'S' ? 'IS' : 'IX');
    const rows = [];
    const keep = (row) => { const v = latestVer(S, row, trx); if (v && !v.del && matchEq(v.vals, eq)) rows.push({ row, v }); };
    if (path.full) {
      for (const r of records(t, 'PRIMARY')) {
        const v = latestVer(S, r.row, trx);
        const match = v && !v.del && matchEq(v.vals, eq);
        if (!gaps && !match) continue;
        const g = take('PRIMARY', r, gaps ? 'NK' : 'REC');
        if (g.wait) return g;
        keep(r.row);
      }
      if (gaps) { const g = take('PRIMARY', null, 'NK'); if (g.wait) return g; }
      return { rows, path };
    }
    if (path.primary) {
      const r = records(t, 'PRIMARY').find((x) => x.row.k === path.vals[0]);
      if (r) { const g = take('PRIMARY', r, 'REC'); if (g.wait) return g; keep(r.row); }
      else if (gaps) {
        const s = successor(t, 'PRIMARY', path.vals);
        const g = request(S, trx, t.name, 'PRIMARY', s.rec, s.key, m, s.rec === 'sup' ? 'NK' : 'GAP');
        if (g.wait) return g;
      }
      return { rows, path };
    }
    const recs = records(t, path.index);
    let i = recs.findIndex((x) => cmpPrefix(x.key, path.vals) >= 0);
    if (i < 0) i = recs.length;
    for (; i < recs.length; i++) {
      const r = recs[i];
      if (cmpPrefix(r.key, path.vals) !== 0) {
        if (gaps) { const g = take(path.index, r, 'GAP'); if (g.wait) return g; }
        return { rows, path };
      }
      const g = take(path.index, r, path.unique || !gaps ? 'REC' : 'NK');
      if (g.wait) return g;
      const pr = records(t, 'PRIMARY').find((x) => x.row === r.row);
      const g2 = take('PRIMARY', pr, 'REC');
      if (g2.wait) return g2;
      keep(r.row);
      if (path.unique) return { rows, path };
    }
    if (gaps) { const g = take(path.index, null, 'NK'); if (g.wait) return g; }
    return { rows, path };
  }

  function outRows(op, found) {
    found.sort((a, b) => a.row.k - b.row.k);
    if (op.out === 'count') return [[found.length]];
    if (op.out === 'ids') return found.map((f) => [f.v.vals.id]);
    return found.map((f) => [f.v.vals[op.col]]);
  }

  function execSelect(S, trx, op, ctx) {
    const t = S.tables[op.t];
    // SERIALIZABLE은 트랜잭션 안의 평범한 SELECT를 공유 락을 거는 읽기(FOR SHARE)로 바꾼다.
    const m = op.lock || (trx.iso === 'SER' && !trx.auto ? 'S' : null);
    if (m) {
      const r = lockingScan(S, trx, t, op.eq, m);
      if (r.wait) return r;
      const rows = outRows(op, r.rows);
      return { ok: true, rows, rowcount: rows.length, locking: m, implicitS: !op.lock, path: r.path };
    }
    const snap = snapFor(S, trx, ctx);
    const found = [];
    for (const row of t.rows) {
      const v = visibleVer(row, snap, trx);
      if (v && !v.del && matchEq(v.vals, op.eq)) found.push({ row, v });
    }
    const rows = outRows(op, found);
    return { ok: true, rows, rowcount: rows.length, locking: null, snap, snapNew: !!ctx.snapNew };
  }

  // 삽입 의도 락: 넣을 자리(갭)의 다음 레코드에 청한다. 앞서 기다리다 받은 것이 있으면 그대로 쓴다.
  function insertIntention(S, trx, t, ix, succ) {
    const mine = S.locks.find((l) => l.trx === trx.id && onRec(l, t, ix, succ.rec) && l.type === 'II');
    if (mine) return mine.wait ? { wait: mine } : { ok: true };
    return request(S, trx, t, ix, succ.rec, succ.key, 'X', 'II');
  }
  // 새 레코드는 다음 레코드에 걸린 갭 쪽 락(넥스트 키, 갭, supremum의 락)을 같은 주인의 갭 락으로 물려받는다.
  function inheritOnInsert(S, t, ix, succ, data, key) {
    for (const l of S.locks.filter((x) => onRec(x, t, ix, succ.rec) && !x.wait && x.type !== 'II' && (succ.rec === 'sup' || x.type !== 'REC'))) {
      if (S.locks.some((x) => x.trx === l.trx && onRec(x, t, ix, data) && x.type === 'GAP' && x.mode === l.mode)) continue;
      S.locks.push({ seq: S.seq++, trx: l.trx, table: t, index: ix, rec: data, key, mode: l.mode, type: 'GAP', wait: false, inherited: true });
    }
  }

  // INSERT: 표에 IX → PRIMARY에 넣을 자리의 삽입 의도 확인 → PRIMARY 레코드 → 보조 인덱스마다 (유니크면 중복 확인) 삽입 의도 확인 → 레코드.
  // 기다리면 그 자리에서 멈췄다가 락을 받은 뒤 이어서 한다. 기다리는 동안 앞서 넣은 PRIMARY 레코드는 그대로 있다.
  function execInsert(S, trx, op, ctx) {
    const t = S.tables[op.t];
    if (!ctx.stage) {
      tableLock(S, trx, t.name, 'IX');
      const vals = { ...op.row };
      if (t.spec.autoinc && vals[t.spec.pk] == null) vals[t.spec.pk] = t.autoinc++;
      Object.assign(ctx, { stage: 'pk', si: 0, vals, t: t.name, steps: [] });
    }
    const k = ctx.vals[t.spec.pk];
    if (ctx.stage === 'pk') {
      const succ = successor(t, 'PRIMARY', [k]);
      const g = insertIntention(S, trx, t.name, 'PRIMARY', succ);
      if (g.wait) return Object.assign(g, { at: { index: 'PRIMARY', succ, prev: predecessor(t, 'PRIMARY', [k]), data: String(k) } });
      const row = { k, vers: [{ id: S.nextVer++, vals: ctx.vals, trx: trx.id, ins: true }], inIdx: {} };
      t.rows.push(row);
      inheritOnInsert(S, t.name, 'PRIMARY', succ, String(k), [k]);
      ctx.row = row;
      ctx.stage = 'sec';
      ctx.steps.push(`PRIMARY에 ${k}`);
    }
    const ixs = t.spec.indexes;
    while (ctx.si < ixs.length) {
      const ix = ixs[ctx.si];
      const key = keyOf(t, ix.name, ctx.vals);
      const data = key.join(', ');
      if (ix.unique && !ctx.dupChecked) {
        // 같은 유니크 값의 레코드가 있으면 공유 락(RR은 넥스트 키)을 걸고 확인한다. 주인이 커밋하지 않았으면 그 락을 기다린다.
        const prefix = ix.cols.map((c) => ctx.vals[c]);
        for (const d of records(t, ix.name).filter((r) => r.row !== ctx.row && cmpPrefix(r.key, prefix) === 0)) {
          convertImplicit(S, trx, t.name, ix.name, d);
          const g = request(S, trx, t.name, ix.name, d.data, d.key, 'S', trx.iso === 'RC' ? 'REC' : 'NK');
          if (g.wait) return Object.assign(g, { at: { index: ix.name, dup: d.data } });
          if (!d.row.vers[0].del) {
            rollbackStatement(S, trx, ctx);
            return { error: { code: 1062, message: `Duplicate entry '${prefix.join('-')}' for key '${t.name}.${ix.name}'` }, dup: d.data, index: ix.name, owner: d.row.vers[0].trx, steps: ctx.steps.slice(), waited: !!ctx.waited };
          }
        }
        ctx.dupChecked = true;
      }
      const succ = successor(t, ix.name, key, ctx.row);
      const g = insertIntention(S, trx, t.name, ix.name, succ);
      if (g.wait) return Object.assign(g, { at: { index: ix.name, succ, prev: predecessor(t, ix.name, key, ctx.row), data } });
      ctx.row.inIdx[ix.name] = true;
      inheritOnInsert(S, t.name, ix.name, succ, data, key);
      ctx.steps.push(`${ix.name}에 (${data})`);
      ctx.si += 1;
      ctx.dupChecked = false;
    }
    trx.wrote = true;
    return { ok: true, rows: null, rowcount: 1, row: ctx.row, k, steps: ctx.steps.slice() };
  }

  // UPDATE·DELETE: 기본 키로 찾은 PRIMARY 레코드에 X 레코드 락을 걸고, 커밋된 최신 버전(또는 자기 버전) 위에 쓴다.
  function execUpdate(S, trx, op) {
    const t = S.tables[op.t];
    tableLock(S, trx, t.name, 'IX');
    const r = records(t, 'PRIMARY').find((x) => x.row.k === op.pk);
    if (!r) return { ok: true, rows: null, rowcount: 0, matched: 0 };
    convertImplicit(S, trx, t.name, 'PRIMARY', r);
    const g = request(S, trx, t.name, 'PRIMARY', r.data, r.key, 'X', 'REC');
    if (g.wait) return g;
    const base = latestVer(S, r.row, trx);
    if (op.k === 'delete') {
      r.row.vers.unshift({ id: S.nextVer++, vals: base.vals, trx: trx.id, del: true });
      trx.wrote = true;
      return { ok: true, rows: null, rowcount: 1, matched: 1, row: r.row, base };
    }
    if (op.cond && !op.cond(base.vals)) return { ok: true, rows: null, rowcount: 0, matched: 0, row: r.row, base };
    const vals = op.set(base.vals);
    if (JSON.stringify(vals) === JSON.stringify(base.vals)) return { ok: true, rows: null, rowcount: 0, matched: 1, row: r.row, base, same: true };
    const v = { id: S.nextVer++, vals, trx: trx.id };
    r.row.vers.unshift(v);
    trx.wrote = true;
    return { ok: true, rows: null, rowcount: 1, matched: 1, row: r.row, base, v };
  }

  // 문장 하나를 실행한다. 돌려주는 것: { ok, rows, rowcount } · { wait: 기다리는 락 } · { error }.
  // 트랜잭션 밖의 문장은 문장 하나짜리 트랜잭션(자동 커밋)으로 돈다. 커밋은 실행 틀이 문장이 끝난 뒤에 한다.
  function exec(S, sess, op, ctx) {
    if (op.k === 'begin') { const trx = newTrx(S, sess, false); return { ok: true, rows: null, rowcount: 0, trx }; }
    if (op.k === 'commit' || op.k === 'rollback') {
      const trx = trxOf(S, sess);
      if (!trx) return { ok: true, rows: null, rowcount: 0, none: true };
      const wrote = trx.wrote;
      if (op.k === 'commit') commitTrx(S, trx); else rollbackTrx(S, trx);
      return { ok: true, rows: null, rowcount: 0, trx, wrote };
    }
    let trx = trxOf(S, sess);
    if (!trx) trx = newTrx(S, sess, true);
    ctx.trx = trx;
    if (op.k === 'select') return execSelect(S, trx, op, ctx);
    if (op.k === 'insert') return execInsert(S, trx, op, ctx);
    return execUpdate(S, trx, op);
  }

  // ---------- 글로 적기 ----------

  const TYPE_WORD = { NK: '넥스트 키 락', REC: '레코드 락', GAP: '갭 락', II: '삽입 의도 락' };
  // performance_schema.data_locks의 LOCK_MODE 꼴
  function modeStr(l) {
    if (l.type === 'TABLE') return l.mode;
    if (l.type === 'NK') return l.mode;
    if (l.type === 'REC') return `${l.mode},REC_NOT_GAP`;
    if (l.type === 'GAP') return `${l.mode},GAP`;
    return l.rec === 'sup' ? `${l.mode},INSERT_INTENTION` : `${l.mode},GAP,INSERT_INTENTION`;
  }
  // SHOW ENGINE INNODB STATUS의 데드락 보고 꼴
  function reportMode(l) {
    let s = l.mode === 'S' ? 'lock mode S' : 'lock_mode X';
    if (l.type === 'GAP') s += ' locks gap before rec';
    else if (l.type === 'REC') s += ' locks rec but not gap';
    else if (l.type === 'II') s += ' insert intention';
    return l.wait ? `${s} waiting` : s;
  }
  // 락의 종류. supremum에 걸린 락은 넥스트 키 락 꼴(X, S)이어도 마지막 레코드 뒤 갭만 잠근다.
  function kindWord(l) { return l.rec === 'sup' && l.type !== 'II' ? '마지막 레코드 뒤 갭' : TYPE_WORD[l.type]; }
  const multiTable = (S) => Object.keys(S.tables).length > 1;
  // 락이 걸린 자리. 표가 둘 이상인 장면만 표 이름을 앞에 붙인다.
  function recWord(S, l) {
    const t = multiTable(S) ? `${l.table} ` : '';
    if (l.rec === 'sup') return `${t}${l.index} supremum`;
    return l.index === 'PRIMARY' ? `${t}PRIMARY ${l.rec}` : `${t}${l.index} (${l.rec})`;
  }
  function lockWord(S, l) { return `${recWord(S, l)}의 ${modeStr(l)}(${kindWord(l)})`; }
  // 락 목록을 표·인덱스·모드별로 묶어 적는다: "idx_user (7, 2)·(7, 3)에 X(넥스트 키 락)"
  function locksText(S, list) {
    const groups = new Map();
    for (const l of list) {
      if (l.type === 'TABLE') continue;
      const k = `${l.table}|${l.index}|${modeStr(l)}|${l.rec === 'sup'}`;
      if (!groups.has(k)) groups.set(k, { l, recs: [] });
      groups.get(k).recs.push(l.rec === 'sup' ? 'supremum' : l.index === 'PRIMARY' ? l.rec : `(${l.rec})`);
    }
    return [...groups.values()].map(({ l, recs }) => `${multiTable(S) ? `${l.table} ` : ''}${l.index} ${recs.join('·')}에 ${modeStr(l)}(${kindWord(l)})`).join(', ');
  }
  // 새 레코드가 들어갈 갭
  function gapWord(ix, prev, succ) {
    const name = (d) => (ix === 'PRIMARY' ? d : `(${d})`);
    if (succ.rec === 'sup') return prev == null ? `레코드가 하나도 없는 ${ix}의 하나뿐인 갭(supremum 앞)` : `${ix}의 마지막 레코드 ${name(prev)} 뒤 갭(supremum 앞)`;
    if (prev == null) return `${ix}의 첫 레코드 ${name(succ.rec)} 앞 갭`;
    return `${ix}의 ${W(name(prev))} ${name(succ.rec)} 사이 갭`;
  }
  // 기다리는 락 l을 막는 락들: "A가 쥔 X,GAP(갭 락)"
  function blockText(S, l) {
    const list = blockingLocks(S, l).map((x) => `${I(who(S, x.trx))} ${x.wait ? '먼저 청해 기다리는' : '쥔'} ${modeStr(x)}(${kindWord(x)})`);
    return [...new Set(list)].join(', ');
  }
  // 행의 값: "balance 1000, version 1"
  function valsText(t, vals) { return t.spec.cols.filter((c) => c !== t.spec.pk).map((c) => `${c} ${vals[c]}`).join(', '); }
  function rowsWord(rows, op) {
    if (rows == null) return '';
    if (op.out === 'count') return String(rows[0][0]);
    if (op.out === 'ids') return rows.length ? `id ${rows.map((r) => r[0]).join(', ')}` : '없음';
    return rows.length ? rows.map((r) => r[0]).join(', ') : '없음';
  }
  function resultText(out, op) {
    if (out.error) return '';
    if (op.k === 'select') return `→ ${rowsWord(out.rows, op)}`;
    if (op.k === 'insert') return `→ id ${out.k} 넣음`;
    if (op.k === 'update' || op.k === 'delete') return `→ ${out.rowcount}행`;
    return '';
  }

  // 기다림의 고리를 이룬 트랜잭션마다 쥔 락(고리에서 앞 트랜잭션이 기다린 것)과 기다린 락. InnoDB 데드락 보고의 (1), (2)와 같은 내용이다.
  function deadlockReport(S, cyc, victim) {
    const order = cyc.slice(1).concat(cyc.slice(0, 1)); // 되돌릴 쪽(고리를 닫은 요청)을 마지막에
    const txns = order.map((tid, i) => {
      const w = waitingLock(S, tid);
      const pw = waitingLock(S, order[(i - 1 + order.length) % order.length]);
      const holds = pw ? blockingLocks(S, pw).filter((l) => l.trx === tid && !l.wait) : [];
      const rec = (l) => (l.rec === 'sup' ? 'supremum' : l.key[0]);
      return { session: sessName(S, tid), name: who(S, tid), holds: holds.map((l) => ({ index: l.index, mode: reportMode(l), records: [rec(l)], lock: l })), waiting: w ? [{ index: w.index, mode: reportMode(w), records: [rec(w)], lock: w }] : [] };
    });
    const part = (x, i) => `(${i + 1}) ${x.name}: 쥔 락 ${x.holds.map((h) => lockWord(S, h.lock)).join(', ')}, 기다린 락 ${x.waiting.map((h) => lockWord(S, h.lock)).join(', ')}`;
    return {
      victim: sessName(S, victim),
      txns: txns.map((x) => ({ session: x.session, holds: x.holds.map(({ lock, ...r }) => r), waiting: x.waiting.map(({ lock, ...r }) => r) })),
      text: `${txns.map(part).join('. ')}. 마지막 줄은 WE ROLL BACK TRANSACTION (${txns.length})이다.`,
      cells: txns.map((x) => ({ from: x.session, to: x.waiting.length ? cellOf(x.waiting[0].lock) : null })),
    };
  }
  // 고리를 말로: "B는 A를, A는 B를"
  function ringText(S, cyc) { return cyc.map((t, i) => `${N(who(S, t))} ${R(who(S, cyc[(i + 1) % cyc.length]))}`).join(', '); }

  // 락이 그려지는 칸. 넥스트 키 락은 레코드 칸과 그 앞 갭 칸, 갭 락과 삽입 의도 락은 갭 칸, 레코드 락은 레코드 칸, supremum의 락은 supremum 칸이다.
  function cellOf(l) {
    if (l.rec === 'sup') return `${l.table}/${l.index}/sup`;
    if (l.type === 'II' || l.type === 'GAP') return `${l.table}/${l.index}/${l.rec}/gap`;
    return `${l.table}/${l.index}/${l.rec}`;
  }
  function cellsOf(l) {
    if (l.rec === 'sup') return [`${l.table}/${l.index}/sup`];
    if (l.type === 'NK') return [`${l.table}/${l.index}/${l.rec}/gap`, `${l.table}/${l.index}/${l.rec}`];
    return [cellOf(l)];
  }

  // ---------- 단계마다의 보기 ----------

  // performance_schema.data_locks처럼 세션, 표 락 먼저, 인덱스, 레코드 순으로 적는다.
  function dataKey(l) {
    if (l.type === 'TABLE') return [0];
    if (l.rec === 'sup') return [2];
    return [1, ...l.key];
  }
  function dataLocks(S) {
    const rows = S.locks.map((l) => ({ session: sessName(S, l.trx), table: l.table, index: l.index, type: l.type === 'TABLE' ? 'TABLE' : 'RECORD', mode: modeStr(l),
      status: l.wait ? 'WAITING' : 'GRANTED', data: l.type === 'TABLE' ? null : l.rec === 'sup' ? 'supremum pseudo-record' : l.rec, kind: l.type, cells: l.type === 'TABLE' ? [] : cellsOf(l), _k: dataKey(l) }));
    rows.sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0) || (a.type === 'TABLE' ? 0 : 1) - (b.type === 'TABLE' ? 0 : 1)
      || String(a.index || '').localeCompare(String(b.index || '')) || cmpKey(a._k, b._k) || a.status.localeCompare(b.status));
    return rows.map(({ _k, ...r }) => r);
  }
  // performance_schema.data_lock_waits처럼 기다리는 락과 그 락을 막는 락의 쌍. 막는 락은 blockingLocks와 같다:
  // 대기열 앞쪽의 쥔 락(기다리기 시작한 뒤에 얻은 것 포함)과 먼저 기다린 락 가운데 부딪히는 것.
  function lockWaits(S) {
    const out = [];
    const label = (l) => `${l.index} ${modeStr(l)} ${l.rec === 'sup' ? 'supremum pseudo-record' : l.rec}`;
    for (const w of S.locks.filter((l) => l.wait)) {
      for (const l of blockingLocks(S, w)) {
        out.push({ waiting: sessName(S, w.trx), waiting_lock: label(w), blocking: sessName(S, l.trx), blocking_lock: label(l) });
      }
    }
    return out;
  }

  function recView(S, t, ix, r, maxVers) {
    const v0 = r.row.vers[0];
    const mine = v0.trx && !isCommitted(S, v0.trx);
    const out = { data: r.data, key: r.key, k: r.row.k, ins: !!(mine && r.row.vers.length === 1 && v0.ins), del: !!(mine && v0.del), by: mine ? sessName(S, v0.trx) : null };
    if (ix === 'PRIMARY') {
      let vers = r.row.vers.map((v, i) => ({ v, i }));
      if (maxVers) {
        const committed = vers.find((x) => x.v.trx === 0 || isCommitted(S, x.v.trx));
        vers = vers.filter((x) => x.i === 0 || x === committed).slice(0, maxVers);
      }
      out.vers = vers.map(({ v, i }) => ({ id: v.id, text: v.del ? '지움' : t.spec.text(v.vals), by: v.trx ? sessName(S, v.trx) : null,
        state: v.trx === 0 || isCommitted(S, v.trx) ? 'committed' : 'active', newest: i === 0, del: !!v.del }));
      out.hidden = maxVers ? Math.max(0, r.row.vers.length - out.vers.length) : 0;
    }
    return out;
  }
  function committedRows(S, t) {
    const out = [];
    for (const row of t.rows) {
      const v = row.vers.find((x) => x.trx === 0 || isCommitted(S, x.trx));
      if (v && !v.del) out.push(t.spec.cols.map((c) => v.vals[c]));
    }
    return out.sort((a, b) => a[0] - b[0]);
  }
  function tableView(S, t, maxVers) {
    return {
      id: t.name, type: 'table', name: t.name, pk: t.spec.pk,
      indexes: ixNames(t).map((ix) => ({ name: ix, primary: ix === 'PRIMARY', unique: !!ixSpec(t, ix).unique, cols: ixSpec(t, ix).cols, recs: records(t, ix).map((r) => recView(S, t, ix, r, maxVers)) })),
      committed: committedRows(S, t),
    };
  }

  // 세션 하나의 보기. 실행 여부(cls run, lines)는 그 단계 동안, 나머지는 단계가 끝난 뒤의 상태다.
  function threadView(S, s, nextKey, doneWhy) {
    const trx = trxOf(S, s);
    const p = s.pending;
    let cls;
    if (s.ran) cls = 'run';
    else if (p) cls = 'event';
    else if (nextKey == null) cls = 'done';
    else cls = 'turn';
    const why = p ? '락 대기' : nextKey == null ? (doneWhy || '끝') : '다음 문장 전';
    const after = p ? { cls: 'event', why } : nextKey == null ? { cls: 'done', why } : { cls: 'turn', why };
    let trxText = '트랜잭션 없음';
    if (trx && trx.auto) trxText = '자동 커밋 문장';
    else if (trx) trxText = '트랜잭션 중';
    let snapText = '';
    if (trx && !trx.auto && trx.snap) snapText = `스냅숏 단계 ${trx.snap.at}`;
    else if (trx && !trx.auto) snapText = '스냅숏 없음';
    const w = p ? p.lock : null;
    return { cls, why: cls === 'run' ? '' : why, after, trx: trxText, snap: snapText, snapAt: trx && trx.snap ? trx.snap.at : null, local: s.last, err: s.err,
      lines: s.lines.slice(), at: nextKey, waitOn: w ? cellOf(w) : null, waitBy: w ? blockersOf(S, w).map((id) => sessName(S, id)) : [], waitMode: w ? modeStr(w) : null,
      waitType: w ? w.type : null, iso: s.iso, deferred: s.deferred.map((r) => r.step) };
  }

  function lockState(S, maxVers) {
    const obj = {};
    for (const t of Object.values(S.tables)) obj[t.name] = tableView(S, t, maxVers);
    const held = [];
    for (const l of S.locks) {
      if (l.wait || l.type === 'TABLE' || l.type === 'II') continue;
      for (const cell of cellsOf(l)) held.push({ sess: sessName(S, l.trx), cell, mode: l.mode, type: l.type });
    }
    return { obj, held, dataLocks: dataLocks(S), waits: lockWaits(S) };
  }

  // ---------- 순서표 실행 ----------

  function simulateTimeline(name, level, detect) {
    const T = TIMELINES[name];
    const S = makeState({ detect: detect !== 'OFF' });
    for (const spec of T.tables) addTable(S, spec);
    for (const id of ['A', 'B']) addSession(S, id, { iso: level });
    T.steps.forEach((s, i) => S.sess[s.s].script.push(i));
    const total = T.steps.length;
    const records_ = T.steps.map((s, i) => ({ step: i + 1, session: s.s, sql: s.sql, note: s.note, op: s.op, key: `s${i + 1}`, blocked: false, deferred: false,
      sent_after_step: null, finished_after_step: null, outcome: null, rows: null, rowcount: null, error: null }));
    const views = [];
    const at = () => Math.min(S.step, total);
    const mark = (sess, rec) => { sess.ran = true; if (!sess.lines.includes(rec.key)) sess.lines.push(rec.key); };
    const heldBy = (sess) => { const trx = trxOf(S, sess); return trx ? S.locks.filter((l) => l.trx === trx.id && !l.wait) : []; };

    function finish(sess, rec, out, gained) {
      rec.finished_after_step = at();
      sess.pending = null;
      mark(sess, rec);
      const trx = out.ctxTrx || trxOf(S, sess);
      if (out.error) {
        rec.outcome = 'error';
        rec.error = { code: out.error.code, message: out.error.message };
        sess.err = `오류 ${out.error.code}`;
        sess.last = '';
        emit(S, 'error', out.text, [sess.id], { bad: true });
        if (trx && trx.state === 'active' && !trx.auto && out.error.code !== 1213) (trx.failed = trx.failed || []).push(rec.step);
        if (trx && trx.auto && trx.state === 'active') rollbackTrx(S, trx);
        if (out.report) emit(S, 'report', `데드락 보고(SHOW ENGINE INNODB STATUS의 LATEST DETECTED DEADLOCK): ${out.report}`, [sess.id]);
        return;
      }
      rec.outcome = 'ok';
      rec.rows = out.rows;
      rec.rowcount = out.rowcount;
      sess.err = '';
      sess.last = resultText(out, rec.op);
      const d = describe(S, sess, rec.op, out, gained);
      emit(S, d.type, d.text, [sess.id], d.bad ? { bad: true } : null);
      if (trx && trx.auto && trx.state === 'active') commitTrx(S, trx);
    }

    // 문장을 실행해 본다. 락을 얻지 못하면 기다림으로 남기고, 데드락 탐지가 켜져 있으면 기다림의 고리를 찾는다.
    function attempt(sess, rec, ctx, first) {
      const before = new Set(heldBy(sess));
      const out = exec(S, sess, rec.op, ctx);
      const trx = ctx.trx || trxOf(S, sess);
      const gained = trx ? S.locks.filter((l) => l.trx === trx.id && !l.wait && !before.has(l)) : [];
      if (out.wait) {
        if (first) rec.blocked = true;
        ctx.waited = true;
        sess.pending = { rec, ctx, lock: out.wait, since: S.step, at: out.at };
        mark(sess, rec);
        const cyc = findCycle(S, trx.id);
        const off = cyc && !S.detect ? ` 이제 ${ringText(S, cyc)} 기다리는 고리가 생겼지만, 데드락 탐지가 꺼져 있어(innodb_deadlock_detect=OFF) 아무도 알아채지 않는다. 락 대기 한도 5초가 지나야 풀린다.` : '';
        emit(S, 'wait', waitText(S, sess, rec.op, out, ctx) + off, [sess.id], off ? { bad: true } : null);
        if (cyc && S.detect) {
          const rep = deadlockReport(S, cyc, trx.id);
          S.deadlocks.push(rep);
          S.cycle = rep.cells;
          rollbackTrx(S, trx);
          rec.blocked = false;
          finish(sess, rec, { error: { code: 1213, message: 'Deadlock found when trying to get lock; try restarting transaction' }, ctxTrx: trx, report: rep.text,
            text: `서로 기다리는 고리가 생겼다: ${ringText(S, cyc)} 기다린다. InnoDB가 이를 바로 찾아 고리를 닫은 ${R(sess.name)} 오류 1213(데드락)으로 되돌렸다. ${sess.name}의 트랜잭션 전체가 되돌려져 쥔 락을 모두 놓았다.` });
        }
        return;
      }
      if (out.error) {
        finish(sess, rec, Object.assign(out, { ctxTrx: trx, text: errorText(S, sess, out) }));
        return;
      }
      finish(sess, rec, Object.assign(out, { ctxTrx: trx }), gained);
    }

    function send(sess, rec) {
      rec.sent_after_step = at();
      rec.ctx = {};
      attempt(sess, rec, rec.ctx, true);
    }

    // 락을 받은 기다림을 이어서 실행하고, 앞 문장이 끝난 세션의 미뤄 둔 문장을 보낸다. 더 바뀌는 것이 없을 때까지 한다.
    function advance() {
      let changed = true;
      let moved = false;
      while (changed) {
        changed = false;
        for (const id of S.order) {
          const sess = S.sess[id];
          const p = sess.pending;
          if (!p || p.lock.wait) continue;
          emit(S, 'granted', `${I(sess.name)} 기다리던 ${R(lockWord(S, p.lock))} 받아 ${p.rec.step}번 줄을 이어서 실행한다.`, [id]);
          sess.pending = null;
          attempt(sess, p.rec, p.ctx, false);
          changed = true;
          moved = true;
        }
        for (const id of S.order) {
          const sess = S.sess[id];
          if (sess.pending || !sess.deferred.length) continue;
          const rec = sess.deferred.shift();
          emit(S, 'sent-later', `${I(sess.name)} 앞 문장이 끝나 미뤄 둔 ${rec.step}번 줄(${rec.sql})을 이제 보낸다.`, [id]);
          send(sess, rec);
          changed = true;
          moved = true;
        }
      }
      return moved;
    }

    // 꼬리: 순서표를 다 보낸 뒤에도 기다리는 문장이 있고 풀어 줄 일이 없으면, 가장 먼저 기다리기 시작한 문장이 락 대기 한도(5초)에 닿는다.
    // 오류 1205는 그 문장만 되돌리고 트랜잭션과 앞서 얻은 락은 그대로 둔다(innodb_rollback_on_timeout=OFF).
    function timeoutOne() {
      const waiting = S.order.map((id) => S.sess[id]).filter((s) => s.pending && s.pending.lock.wait);
      if (!waiting.length) return false;
      waiting.sort((a, b) => a.pending.since - b.pending.since);
      const s = waiting[0];
      const p = s.pending;
      const trx = trxOf(S, s);
      S.locks = S.locks.filter((l) => l !== p.lock);
      rollbackStatement(S, trx, p.ctx);
      finish(s, p.rec, { error: { code: 1205, message: 'Lock wait timeout exceeded; try restarting transaction' }, ctxTrx: trx,
        text: `${I(s.name)} ${p.rec.step}번 줄에서 ${R(lockWord(S, p.lock))} 기다린 지 5초(innodb_lock_wait_timeout)가 지나 오류 1205(락 대기 시간 초과)를 받았다. 이 문장만 되돌리고, 트랜잭션과 앞서 쥔 락(${locksText(S, S.locks.filter((l) => l.trx === trx.id && !l.wait)) || '없음'})은 그대로 남는다(innodb_rollback_on_timeout=OFF).` });
      return true;
    }

    views.push(timelineView(S, T, records_, true));
    for (let i = 0; i < total; i += 1) {
      S.step = i + 1;
      S.label = String(i + 1);
      S.ev = [];
      S.cycle = null;
      for (const s of Object.values(S.sess)) { s.lines = []; s.ran = false; }
      const rec = records_[i];
      const sess = S.sess[rec.session];
      if (sess.pending || sess.deferred.length) {
        rec.deferred = true;
        sess.deferred.push(rec);
        emit(S, 'deferred', `${I(sess.name)} ${rec.step}번 줄(${rec.sql})을 보낼 차례지만, 앞 문장이 아직 끝나지 않아 미룬다. 한 연결은 앞 문장이 돌아와야 다음 문장을 보낸다.`, [sess.id]);
      } else send(sess, rec);
      advance();
      views.push(timelineView(S, T, records_, false));
    }
    const tails = [];
    let guard = 0;
    while (Object.values(S.sess).some((s) => s.pending || s.deferred.length) && guard < 6) {
      guard += 1;
      S.step = total + guard;
      S.label = `끝${guard}`;
      S.ev = [];
      S.cycle = null;
      for (const s of Object.values(S.sess)) { s.lines = []; s.ran = false; }
      if (guard === 1) emit(S, 'tail', '순서표의 문장을 모두 보냈다. 끝나지 않은 문장이 끝나기를 기다린다.', []);
      // 풀어 줄 일이 없으면 이 단계에서는 시간 초과만 보이고, 그 뒤의 일은 다음 단계에서 보인다.
      if (!advance()) timeoutOne();
      tails.push(S.ev.slice());
      views.push(timelineView(S, T, records_, false));
    }
    tails.forEach((_, k) => {
      const v = views[total + 1 + k];
      v.label = tails.length === 1 ? '끝' : `끝${k + 1}`;
      v.tail = true;
    });
    // 이체는 두 계좌의 합이 2000이어야 한다. 한쪽만 커밋된 이체를 끝 단계에 알린다.
    const finalRows = committedRows(S, Object.values(S.tables)[0]);
    if (T.tables[0].name === 'accounts') {
      const sum = finalRows.reduce((a, r) => a + r[1], 0);
      if (sum !== 2000) {
        views[views.length - 1].ev.push({ type: 'lost', bad: true, ids: [], text: `끝난 뒤 두 계좌의 합이 ${sum}이다. 1205는 A의 3번 줄(id 2에 +100)만 되돌렸고, A는 오류를 확인하지 않고 커밋해 1번 줄(id 1에서 −100)만 남았다. 이체 하나가 반만 반영되어 100이 사라졌다.` });
      }
    }
    const out = records_.map((r) => ({ step: r.step, session: r.session, sql: r.sql, blocked: r.blocked, deferred: r.deferred, sent_after_step: r.sent_after_step,
      finished_after_step: r.finished_after_step, outcome: r.outcome, rows: r.rows, rowcount: r.rowcount, error: r.error }));
    return { S, views, records: out, deadlocks: S.deadlocks.map((d) => ({ victim: d.victim, txns: d.txns })), final: finalRows };
  }

  function timelineView(S, T, records_, initial) {
    const th = {};
    for (const id of S.order) {
      const s = S.sess[id];
      const left = s.script.filter((i) => records_[i].outcome == null && !(s.pending && s.pending.rec.step - 1 === i));
      const nextIdx = s.pending ? s.pending.rec.step - 1 : left.length ? left[0] : null;
      th[id] = threadView(S, s, nextIdx != null ? `s${nextIdx + 1}` : null);
      if (initial) Object.assign(th[id], { cls: 'turn', why: '다음 문장 전', lines: [] });
    }
    const st_ = lockState(S, 0);
    const actors = S.order.filter((id) => S.sess[id].ran);
    const ev = initial ? [{ type: 'start', text: `준비: ${T.tables.map((t) => t.name).join(', ')} 표를 만들었다. 두 세션의 격리 수준은 ${LEVEL_NAME[S.sess.A.iso]}, 데드락 탐지는 ${S.detect ? '켬(ON)' : '끔(OFF)'}, 락 대기 한도는 5초다.`, ids: [] }] : S.ev.slice();
    return Object.assign({ step: S.step, label: initial ? '0' : S.label, tail: false, actors, th, ev, cycle: S.cycle ? clone(S.cycle) : currentRing(S), cycleDetected: !!S.cycle }, clone(st_));
  }

  // 아직 풀리지 않은 기다림의 고리(데드락 탐지가 꺼져 있을 때 남는다)
  function currentRing(S) {
    for (const l of S.locks.filter((x) => x.wait)) {
      const cyc = findCycle(S, l.trx);
      if (cyc) return cyc.map((tid) => ({ from: sessName(S, tid), to: cellOf(waitingLock(S, tid)) }));
    }
    return null;
  }

  // ---------- 단계 설명 ----------

  const AUTO_DONE = '자동 커밋 문장이라 끝나자마자 커밋하고 락을 놓았다';

  function describe(S, sess, op, out, gained) {
    const name = sess.name;
    const trx = out.ctxTrx;
    const gl = (gained || []).filter((l) => l.type !== 'TABLE' && l.type !== 'II');
    if (op.k === 'begin') return { type: 'begin', text: `${I(name)} 트랜잭션을 열었다.` };
    if (op.k === 'commit' || op.k === 'rollback') {
      if (out.none) return { type: op.k, text: `${I(name)} ${op.k === 'commit' ? 'COMMIT' : 'ROLLBACK'}을 보냈다. 앞의 오류로 트랜잭션이 이미 통째로 되돌려져 끝낼 것이 없다.` };
      if (op.k === 'rollback') return { type: op.k, text: `${I(name)} ROLLBACK했다. 쓴 것을 되돌리고 쥔 락을 모두 놓았다.` };
      const failed = (out.trx && out.trx.failed) || [];
      const lost = failed.length ? ` 오류로 되돌린 ${failed.map((n) => `${n}번 줄`).join(', ')}의 변경은 빠지고, 나머지 문장의 변경만 커밋된다.` : '';
      return { type: op.k, text: `${I(name)} 커밋했다. 쓴 것이 다른 트랜잭션에 보이고, 쥔 락을 모두 놓았다.${lost}` };
    }
    if (op.k === 'select') {
      const res = rowsWord(out.rows, op);
      if (out.locking) {
        const p = out.path;
        const parts = [];
        if (out.implicitS) parts.push('SERIALIZABLE이라 트랜잭션 안의 평범한 SELECT도 공유 락을 거는 읽기(FOR SHARE)가 된다.');
        if (p.full) parts.push('조건에 쓸 인덱스가 없어 PRIMARY를 처음부터 끝까지 훑었다.');
        else if (!p.primary) parts.push(`${p.index}로 찾았다.`);
        if (gl.length) parts.push(`${R(locksText(S, gl))} 걸었다.`);
        else parts.push('새로 건 락은 없다(같은 락을 이미 쥐었다).');
        if (gl.some((l) => l.mode === 'X' && S.locks.some((x) => x.trx === l.trx && x.mode === 'S' && onRec(x, l.table, l.index, l.rec)))) parts.push('같은 레코드에 쥔 S 락은 그대로 두고 X 락을 하나 더 얻었다.');
        if (sess.iso === 'RC') parts.push(p.full ? 'READ COMMITTED는 갭을 잠그지 않고, 조건에 맞지 않는 행의 락은 조건을 확인한 뒤 바로 놓는다.' : 'READ COMMITTED는 갭을 잠그지 않는다.');
        else if (p.full) parts.push('REPEATABLE READ 이상은 훑은 레코드마다 넥스트 키 락을 걸고, 조건에 맞지 않는 행의 락도 트랜잭션이 끝날 때까지 쥔다.');
        else if (gl.some((l) => l.type === 'GAP')) parts.push('맞는 레코드 다음의 첫 레코드까지 읽어야 끝을 알 수 있어, 그 레코드 앞 갭도 잠갔다.');
        else if (!p.primary && gl.some((l) => l.rec === 'sup')) parts.push(`맞는 레코드 뒤에 레코드가 없어 마지막 갭(supremum 앞)까지 잠갔다.`);
        return { type: 'lockread', text: `${I(name)} 잠그며 읽었다. 결과: ${res}. ${parts.join(' ')}` };
      }
      let how;
      if (out.snapNew) how = '이 트랜잭션의 첫 consistent read라 여기서 스냅숏을 만들었다.';
      else if (trx && trx.auto) how = '자동 커밋 문장이라 이 문장만 쓰는 스냅숏으로 읽었다.';
      else if (sess.iso === 'RC') how = 'READ COMMITTED라 문장마다 스냅숏을 새로 만든다.';
      else how = `단계 ${out.snap.at}에 만든 스냅숏으로 읽었다.`;
      return { type: 'read', text: `${I(name)} 락 없이 읽었다. 결과: ${res}. ${how}` };
    }
    if (op.k === 'insert') {
      const inh = gl.filter((l) => l.inherited);
      const where = out.steps && out.steps.length > 1 ? ` 인덱스마다 레코드가 하나씩 들어갔다: ${out.steps.join(', ')}.` : '';
      const ii = !trx.auto && S.locks.some((l) => l.trx === trx.id && l.type === 'II' && !l.wait && l.table === op.t);
      return { type: 'write', text: `${I(name)} ${op.t}에 행(id ${out.k})을 넣었다(${trx.auto ? AUTO_DONE : '커밋 전'}).${where} 넣을 자리마다 그 갭을 다른 트랜잭션이 잠갔는지 확인했다(삽입 의도 락).${ii ? ' 기다리다 받은 삽입 의도 락은 GRANTED로 남지만 아무것도 막지 않는다.' : ''}${inh.length ? ` 새 레코드는 다음 레코드에 걸린 갭 쪽 락을 같은 주인의 갭 락으로 물려받았다: ${locksText(S, inh)}.` : ''}` };
    }
    const t = S.tables[op.t];
    const where = `${op.t}의 ${t.spec.pk} ${op.pk} 행`;
    if (op.k === 'delete') return { type: 'write', text: `${I(name)} ${R(where)} 지웠다(${trx.auto ? AUTO_DONE : '커밋 전에는 지움 표시만 남긴다'}).${gl.length ? ` ${R(locksText(S, gl))} 걸었다.` : ''}` };
    if (!out.matched) return { type: 'write', text: `${I(name)} ${R(where)} 잠그고 커밋된 최신 값(${valsText(t, out.base.vals)})을 봤지만 WHERE 조건이 맞지 않아 바꾼 행이 0이다. 건 락은 트랜잭션이 끝날 때까지 쥔다.` };
    if (out.same) return { type: 'write', text: `${I(name)} ${R(where)} 고쳤지만 값이 그대로라 바뀐 행이 0이다.` };
    const changes = t.spec.cols.filter((c) => c !== t.spec.pk && out.base.vals[c] !== out.v.vals[c]).map((c) => `${R(c)} ${out.base.vals[c]}에서 ${RO(out.v.vals[c])}`);
    return { type: 'write', text: `${I(name)} ${where}에서 ${changes.join(', ')} 고쳤다(${trx.auto ? AUTO_DONE : '커밋 전'}).${gl.length ? ` ${R(locksText(S, gl))} 걸었다.` : ''}` };
  }

  function waitText(S, sess, op, out, ctx) {
    const l = out.wait;
    const name = sess.name;
    const blocks = blockText(S, l);
    if (op.k === 'insert') {
      const first = ctx.steps && ctx.steps.length ? ` ${R(ctx.steps.join(', '))} 먼저 넣었다.` : '';
      const head = `${I(name)} ${op.t}에 행(id ${ctx.vals[S.tables[op.t].spec.pk]})을 넣는 중이다.${first}`;
      const a = out.at;
      if (l.type === 'II') return `${head} ${a.index}에 ${R(a.index === 'PRIMARY' ? a.data : `(${a.data})`)} 넣을 자리는 ${gapWord(a.index, a.prev, a.succ)}인데, ${blocks}에 막혀 삽입 의도 락(${modeStr(l)})이 기다린다.`;
      const owners = blockersOf(S, l).map((tid) => who(S, tid)).join('·');
      return `${head} ${N(a.index)} 유니크 인덱스라, 같은 값의 레코드 ${I(`(${a.dup})`)} 정말 있는지 공유 락(${modeStr(l)}, ${TYPE_WORD[l.type]})을 걸고 확인해야 한다. 그 레코드는 ${I(owners)} 넣고 아직 커밋하지 않았다. 넣은 쪽은 새 레코드를 락 구조 없이 잠그는데(암묵적 락), InnoDB가 이때 그것을 ${owners}의 X,REC_NOT_GAP(레코드 락)으로 바꿔 적고 ${I(name)} 그 락에 막혀 기다린다.`;
    }
    return `${I(name)} ${R(lockWord(S, l))} 청했지만 ${blocks}에 막혀 기다린다.`;
  }

  function errorText(S, sess, out) {
    if (out.error.code === 1062) {
      const owner = out.owner ? who(S, out.owner) : null;
      const rec = `(${out.dup})`;
      return `${I(sess.name)} ${out.waited ? '기다리던 공유 락을 받고 확인해 보니' : '확인해 보니'} ${owner ? `${I(owner)} 넣은 ` : ''}같은 값의 레코드 ${I(rec)} 커밋되어 있다. 오류 1062(중복 키)로 이 문장만 되돌렸다(먼저 넣은 PRIMARY 레코드도 지웠다). 트랜잭션과 확인에 쓴 공유 락은 남는다.`;
    }
    return `${I(sess.name)} 오류 ${out.error.code}로 끝났다.`;
  }

  // ---------- 동시 요청 (burst_lab.py) ----------
  // 요청마다 같은 순간에 출발해 아래 코드를 실행한다. 생성기(function*)가 다음 문장을 내놓고, 실행 틀이 결과를 돌려준다.

  const Q = (sql, op, key) => ({ sql, op, key });
  const PAUSE = (key) => ({ pause: true, key });
  const pointsPk = (set, cond, what) => upd('points', 7, set, cond, what);

  function* dbError(r) { yield Q('ROLLBACK', ROLLBACK, 'err'); return { out: 'error', error: r.error }; }

  function* deductAttempt() {
    yield Q('START TRANSACTION', BEGIN, 'start');
    let r = yield Q('SELECT balance FROM points WHERE user_id = 7', sel('points', EQ7, 'col', null, 'balance'), 'read');
    if (r.error) return yield* dbError(r);
    const bal = r.rows[0][0];
    yield PAUSE('pause');
    r = yield Q(`UPDATE points SET balance = ${bal - 100} WHERE user_id = 7`, pointsPk(setTo('balance', bal - 100), null, `${bal - 100}`), 'write');
    if (r.error) return yield* dbError(r);
    yield Q('COMMIT', COMMIT, 'commit');
    return { out: 'done' };
  }

  function* rewardAttempt(o) {
    yield Q('START TRANSACTION', BEGIN, 'start');
    let r;
    if (o.parentLock) { r = yield Q(LOCK_POINTS, sel('points', EQ7, 'col', 'X', 'balance'), 'lockp'); if (r.error) return yield* dbError(r); }
    let seen = null;
    if (o.version) { r = yield Q('SELECT version FROM points WHERE user_id = 7', sel('points', EQ7, 'col', null, 'version'), 'ver'); if (r.error) return yield* dbError(r); seen = r.rows[0][0]; }
    r = yield Q(`${COUNT}${o.countLock ? ' FOR UPDATE' : ''}`, sel('rewards', EQ71, 'count', o.countLock ? 'X' : null), 'count');
    if (r.error) return yield* dbError(r);
    const count = r.rows[0][0];
    if (o.lockAfterCount) { r = yield Q(LOCK_POINTS, sel('points', EQ7, 'col', 'X', 'balance'), 'lockac'); if (r.error) return yield* dbError(r); }
    if (count > 0) { yield Q('ROLLBACK', ROLLBACK, 'already'); return { out: 'already' }; }
    yield PAUSE('pause');
    r = yield Q(INSERT_REWARD, add('rewards', { user_id: 7, event_id: 1, amount: 1000 }), 'insert');
    if (r.error) {
      if (o.unique && r.error.code === 1062) { yield Q('ROLLBACK', ROLLBACK, 'dup'); return { out: 'already', handled: r.error }; }
      return yield* dbError(r);
    }
    if (o.version) {
      r = yield Q(`UPDATE points SET version = version + 1 WHERE user_id = 7 AND version = ${seen}`, pointsPk(plus('version', 1), (v) => v.version === seen, 'version + 1'), 'bump');
      if (r.error) return yield* dbError(r);
      if (r.rowcount === 0) { yield Q('ROLLBACK', ROLLBACK, 'conflict'); return { out: 'conflict' }; }
    }
    if (o.zero) {
      r = yield Q(PAY_IF_ZERO, pointsPk(plus('balance', 1000), (v) => v.version === 0, 'balance + 1000'), 'payz');
      if (r.error) return yield* dbError(r);
      if (o.zero === 'first') { yield Q('COMMIT', COMMIT, 'commit'); return { out: r.rowcount ? 'granted' : 'unpaid' }; }
      if (r.rowcount === 0) { yield Q('ROLLBACK', ROLLBACK, 'conflict'); return { out: 'conflict' }; }
      r = yield Q(VERSION_UP, pointsPk(plus('version', 1), null, 'version + 1'), 'vup');
      if (r.error) return yield* dbError(r);
      yield Q('COMMIT', COMMIT, 'commit');
      return { out: 'granted' };
    }
    r = yield Q(PAY, pointsPk(plus('balance', 1000), null, 'balance + 1000'), 'pay');
    if (r.error) return yield* dbError(r);
    yield Q('COMMIT', COMMIT, 'commit');
    return { out: 'granted' };
  }

  // burst_lab.py의 serve: conflict면 정한 횟수까지 처음부터 다시 하고, DB 오류는 다시 하지 않는다.
  function* serve(attemptFn, retries) {
    for (let a = 0; a <= retries; a += 1) {
      const r = yield* attemptFn();
      if (r.out !== 'conflict') return { result: r.out, retries: a, handled: r.handled || null };
      if (a < retries) yield { retry: a + 1 };
    }
    return { result: 'gave-up', retries };
  }

  // 막는 방법(판). 표, 요청 코드의 선택, 다시 시도 수. 이름은 burst_lab.py의 장면 이름이다.
  const WAYS = {
    plain: { scene: 'reward-plain', label: '막지 않음', o: {}, version: 0, unique: false },
    'count-lock': { scene: 'reward-count-lock', label: '(가) 처음 판: COUNT를 FOR UPDATE로', o: { countLock: true }, version: 0, unique: false },
    'parent-lock': { scene: 'reward-parent-lock', label: '(가) 고친 판: points 행을 먼저 잠금', o: { parentLock: true }, version: 0, unique: false },
    'lock-after-count': { scene: 'reward-lock-after-count', label: '(가) 고친 판에서 FOR UPDATE를 COUNT 다음으로', o: { lockAfterCount: true }, version: 0, unique: false },
    'version-first': { scene: 'reward-version-first', label: '(나) 첫 판: version = 0일 때만 잔액 UPDATE', o: { zero: 'first' }, version: 0, unique: false },
    'version-const': { scene: 'reward-version-const', label: '(나) 고친 판: version = 0 확인 뒤 version + 1', o: { zero: 'fixed' }, version: 0, unique: false },
    'version-const-v3': { scene: 'reward-version-const-v3', label: '(나) 고친 판, points의 처음 version이 3', o: { zero: 'fixed' }, version: 3, unique: false },
    version: { scene: 'reward-version', label: '(나) 최종판: 처음 읽은 version으로 확인', o: { version: true }, version: 0, unique: false, retries: 3 },
    unique: { scene: 'reward-unique', label: '(다) 유니크 제약', o: { unique: true }, version: 0, unique: true },
    'count-lock-unique': { scene: 'reward-count-lock-unique', label: '(가)+(다): COUNT FOR UPDATE와 유니크 제약', o: { countLock: true, unique: true }, version: 0, unique: true },
  };
  const RESULT_WORD = { granted: '지급', already: '이미 받음', error: '오류', 'gave-up': '포기', done: '차감 끝', unpaid: '잔액 없이 커밋' };

  function simulateBurst(scene, cfg) {
    const deduct = scene === 'deduct';
    const way = deduct ? null : WAYS[cfg.way];
    const level = deduct ? cfg.level : 'RR';
    const S = makeState({ detect: true });
    const specs = deduct ? [POINTS_ONLY] : [points(way.version), rewards(way.unique)];
    for (const spec of specs) addTable(S, spec);
    const n = cfg.n;
    const reqs = [];
    for (let i = 1; i <= n; i += 1) {
      const sess = addSession(S, String(i), { iso: level, name: `요청 ${i}` });
      const gen = deduct ? serve(deductAttempt, 0) : serve(() => rewardAttempt(way.o), way.retries || 0);
      const q = { id: String(i), sess, gen, cur: null, pending: null, doneRound: -1, result: null, retries: 0, errors: [], attempt: 1 };
      q.cur = gen.next().value;
      reqs.push(q);
    }
    const views = [];
    let round = 0;
    const heldBy = (q) => { const trx = trxOf(S, q.sess); return trx ? S.locks.filter((l) => l.trx === trx.id && !l.wait) : []; };

    function next(q, res) {
      let r = q.gen.next(res);
      while (!r.done && r.value.retry) {
        q.attempt += 1;
        emit(S, 'retry', `${I(q.sess.name)} 요청을 처음부터 다시 한다(${r.value.retry}번째 다시 시도). 새 트랜잭션이라 스냅숏도 새로 만든다.`, [q.id]);
        r = q.gen.next();
      }
      if (r.done) {
        q.result = r.value.result;
        q.retries = r.value.retries;
        q.cur = null;
        q.sess.done = RESULT_WORD[q.result];
      } else q.cur = r.value;
    }

    function finished(q, ins, out, gained) {
      const trx = out.ctxTrx;
      if (out.error) {
        q.errors.push(out.error.code);
        q.sess.err = `오류 ${out.error.code}`;
        q.sess.last = '';
        emit(S, 'error', out.text, [q.id], { bad: out.error.code !== 1062 || !way || !way.unique ? true : undefined, handled: out.error.code === 1062 });
        next(q, { error: out.error });
        return;
      }
      q.sess.err = '';
      q.sess.last = resultText(out, ins.op);
      const d = describe(S, q.sess, ins.op, out, gained);
      let text = d.text;
      const nm = q.sess.name;
      if (ins.key === 'already') text = `${I(nm)} 센 수가 0이 아니라 "이미 받음"으로 보고 ROLLBACK했다.`;
      if (ins.key === 'dup') text = `${I(nm)} 1062를 "이미 받음"으로 처리하고 ROLLBACK했다. 확인에 쓴 공유 락도 이제 놓는다.`;
      if (ins.key === 'conflict') text = `${I(nm)} 바꾼 행이 0이라(다른 요청이 먼저 version을 바꿈) ROLLBACK했다. 넣었던 지급 행도 함께 되돌렸다.`;
      if (ins.key === 'err') text = `${I(nm)} DB 오류를 받아 ROLLBACK을 보냈다. 트랜잭션은 이미 되돌려져 할 일이 없고, 요청은 실패로 끝난다.`;
      emit(S, d.type, text, [q.id], d.bad ? { bad: true } : null);
      next(q, { rows: out.rows, rowcount: out.rowcount });
    }

    function attempt(q, ins, ctx) {
      const before = new Set(heldBy(q));
      const out = exec(S, q.sess, ins.op, ctx);
      const trx = ctx.trx || trxOf(S, q.sess);
      const gained = trx ? S.locks.filter((l) => l.trx === trx.id && !l.wait && !before.has(l)) : [];
      if (out.wait) {
        ctx.waited = true;
        q.pending = { ins, ctx, lock: out.wait };
        q.sess.pending = q.pending;
        emit(S, 'wait', waitText(S, q.sess, ins.op, out, ctx), [q.id]);
        const cyc = findCycle(S, trx.id);
        if (cyc) {
          const rep = deadlockReport(S, cyc, trx.id);
          S.deadlocks.push(rep);
          S.cycle = (S.cycle || []).concat(rep.cells);
          rollbackTrx(S, trx);
          q.pending = null;
          q.sess.pending = null;
          finished(q, ins, { error: { code: 1213, message: 'Deadlock found when trying to get lock; try restarting transaction' }, ctxTrx: trx,
            text: `서로 기다리는 고리가 생겼다: ${ringText(S, cyc)} 기다린다. InnoDB가 이를 바로 찾아 고리를 닫은 ${R(q.sess.name)} 오류 1213(데드락)으로 되돌렸다. ${q.sess.name}의 트랜잭션 전체가 되돌려져 쥔 락을 모두 놓았다.` });
        }
        return;
      }
      if (out.error) { finished(q, ins, Object.assign(out, { ctxTrx: trx, text: errorText(S, q.sess, out) })); return; }
      finished(q, ins, Object.assign(out, { ctxTrx: trx }), gained);
    }

    function resume() {
      let changed = true;
      while (changed) {
        changed = false;
        for (const q of reqs) {
          const p = q.pending;
          if (!p || p.lock.wait) continue;
          q.pending = null;
          q.sess.pending = null;
          q.doneRound = round;
          q.sess.ran = true;
          if (!q.sess.lines.includes(p.ins.key)) q.sess.lines.push(p.ins.key);
          emit(S, 'granted', `${I(q.sess.name)} 기다리던 ${R(lockWord(S, p.lock))} 받아 문장을 이어서 실행한다.`, [q.id]);
          attempt(q, p.ins, p.ctx);
          changed = true;
        }
      }
    }

    views.push(burstView(true));
    while (reqs.some((q) => !q.result) && round < 400) {
      round += 1;
      S.step = round;
      S.label = String(round);
      S.ev = [];
      S.cycle = null;
      for (const s of Object.values(S.sess)) { s.lines = []; s.ran = false; }
      for (const q of reqs) {
        if (q.result || q.pending || q.doneRound === round) continue;
        const ins = q.cur;
        q.sess.ran = true;
        q.sess.lines.push(ins.key);
        if (ins.pause) {
          emit(S, 'pause', `${I(q.sess.name)} 읽은 값으로 앱에서 50ms 일한다. 이 동안 DB에 문장을 보내지 않는다.`, [q.id]);
          q.sess.last = '50ms 일함';
          next(q, {});
        } else attempt(q, ins, {});
        resume();
      }
      views.push(burstView(false));
    }

    function burstView(initial) {
      const th = {};
      for (const q of reqs) {
        th[q.id] = threadView(S, q.sess, q.cur ? q.cur.key : null, q.result ? RESULT_WORD[q.result] : null);
        th[q.id].attempt = q.attempt;
        if (initial) Object.assign(th[q.id], { cls: 'turn', why: '다음 문장 전', lines: [] });
      }
      const st_ = lockState(S, 2);
      const actors = reqs.filter((q) => q.sess.ran).map((q) => q.id);
      const ev = initial ? [{ type: 'start', text: `준비: ${specs.map((t) => t.name).join(', ')} 표를 만들었다. 요청 ${n}개가 같은 순간에 출발한다. 격리 수준 ${LEVEL_NAME[level]}, 데드락 탐지 켬, 락 대기 한도 5초.`, ids: [] }] : S.ev.slice();
      return Object.assign({ step: S.step, label: initial ? '0' : S.label, tail: false, actors, th, ev, cycle: S.cycle ? clone(S.cycle) : null, cycleDetected: !!S.cycle }, clone(st_));
    }

    const results = {};
    const errors = {};
    for (const q of reqs) {
      results[q.result] = (results[q.result] || 0) + 1;
      for (const c of q.errors) errors[String(c)] = (errors[String(c)] || 0) + 1;
    }
    const pts = committedRows(S, S.tables.points)[0];
    const summary = { results, errors, retries: reqs.reduce((s, q) => s + q.retries, 0), balance: pts[1] };
    let final;
    const lastEv = views[views.length - 1].ev;
    if (deduct) {
      final = [[[pts[1]]]];
      const done = results.done || 0;
      if (done > 1) lastEv.push({ type: 'lost', bad: true, ids: [], text: `요청 ${n}개가 모두 차감을 마쳤지만 잔액은 ${pts[1]}이다. 모두 처음에 커밋된 1000을 읽고 900을 써서, 앞 요청의 차감을 뒤 요청이 덮어썼다(갱신 손실). 다 반영되었다면 ${1000 - 100 * n}이다.` });
    } else {
      const count = committedRows(S, S.tables.rewards).filter((r) => r[1] === 7 && r[2] === 1).length;
      Object.assign(summary, { rewards: count, version: pts[2] });
      final = [[[count]], [[pts[1], pts[2]]]];
      if (count > 1) lastEv.push({ type: 'dup', bad: true, ids: [], text: `user 7이 event 1의 리워드를 ${count}번 받았다(rewards ${count}행, 잔액 ${pts[1]}). 한 번만 받아야 한다.` });
      if (count === 0) lastEv.push({ type: 'none', bad: true, ids: [], text: `아무도 리워드를 받지 못했다(rewards 0행, 잔액 ${pts[1]}). 한 번은 받아야 한다.` });
    }
    return { S, views, reqs: reqs.map((q) => ({ id: q.id, result: q.result, retries: q.retries, errors: q.errors })), summary, final, deadlocks: S.deadlocks.map((d) => ({ victim: d.victim, txns: d.txns })), specs, level };
  }

  // ---------- 커넥션 풀 (pool_lab.py) ----------
  // 요청 50개가 같은 순간에 출발해 연결을 빌리고 트랜잭션 안에서 SELECT 1 뒤 0.2초를 쓰고 돌려준다.
  // QueuePool은 미리 만들어 둔 연결 pool_size개를 빌려주고, 모자라면 돌려받을 때까지(최대 pool_timeout) 기다리게 한다.
  // NullPool은 요청마다 새로 연결하고 돌려줄 때 끊는다. 모형은 0.2초 단위로 나눠 그리며, 새 연결에 드는 시간은 따로 둔다.

  const POOL_CASES = {
    q5: { pool: 'queue', size: 5, timeout: 30, raw: 'queue-5-30', label: 'QueuePool, pool_size=5, pool_timeout=30초' },
    q10: { pool: 'queue', size: 10, timeout: 30, raw: 'queue-10-30', label: 'QueuePool, pool_size=10, pool_timeout=30초' },
    q50: { pool: 'queue', size: 50, timeout: 30, raw: 'queue-50-30', label: 'QueuePool, pool_size=50, pool_timeout=30초' },
    q5t: { pool: 'queue', size: 5, timeout: 0.5, raw: 'queue-5-0.5', label: 'QueuePool, pool_size=5, pool_timeout=0.5초' },
    null: { pool: 'null', size: 0, timeout: null, raw: 'null', label: 'NullPool (요청마다 새 연결)' },
  };
  const POOL_REQUESTS = 50;
  const HOLD_MS = 200;

  function simulatePool(cfg) {
    const C = POOL_CASES[cfg.pool];
    const reqs = Array.from({ length: POOL_REQUESTS }, (_, i) => ({ id: i + 1, state: 'new', slot: null, since: null, got: null, end: null }));
    const slots = Array.from({ length: C.size }, (_, i) => ({ id: i + 1, holder: null, uses: 0 }));
    const db = { open: C.size, created: 0, peak: C.size };
    const views = [];
    let ev = [];
    const snapshot = (label, t, phase, initial) => views.push({ step: views.length, label, t, phase, reqs: reqs.map((r) => ({ ...r })), slots: slots.map((s) => ({ ...s })),
      db: { ...db }, ev: initial ? [{ type: 'start', text: `준비: ${C.label}. ${C.pool === 'queue' ? `연결 ${C.size}개를 미리 만들어 풀에 두었다.` : '엔진의 첫 연결 초기화는 미리 끝냈다.'} 요청 50개가 같은 순간에 출발한다.`, ids: [] }] : ev });
    snapshot('0', null, '출발 전', true);
    if (C.pool === 'null') {
      ev = [];
      for (const r of reqs) { r.state = 'connect'; r.since = 0; }
      db.open = 0;
      ev.push({ type: 'connect', text: '요청 50개가 동시에 새 연결을 연다(TCP 연결, 핸드셰이크, 인증). 풀이 없으니 기다릴 연결이 없고 모두 바로 시작한다.', ids: [] });
      snapshot('1', 0, '새 연결을 여는 중', false);
      ev = [];
      for (const r of reqs) { r.state = 'use'; r.got = 'c'; }
      db.open = POOL_REQUESTS;
      db.created = POOL_REQUESTS;
      db.peak = POOL_REQUESTS;
      ev.push({ type: 'use', text: '연결 50개가 열렸다. 요청마다 자기 연결로 SELECT 1을 하고 0.2초를 쓴다. 새 연결에 드는 시간은 이 맥에서 동시에 열 때 수십 ms였다(실험에서 잰 값).', ids: [] });
      snapshot('2', 'c', '연결이 열린 뒤', false);
      ev = [];
      for (const r of reqs) { r.state = 'done'; r.end = 'c+200'; }
      db.open = 0;
      ev.push({ type: 'done', text: '요청 50개가 끝나 연결을 끊었다. 다음 요청이 오면 다시 새로 연다.', ids: [] });
      snapshot('3', 'c+200', '0.2초 뒤', false);
      return { views, summary: { ok: POOL_REQUESTS, timeout: 0, endMs: null, waitMaxMs: 0, created: POOL_REQUESTS, peak: POOL_REQUESTS }, kase: C };
    }
    // QueuePool: 0.2초마다 돌려받은 연결을 기다리는 요청에 차례로 빌려준다. pool_timeout이 되면 아직 못 받은 요청은 오류로 끝난다.
    const times = [];
    for (let t = 0; t <= 60000; t += HOLD_MS) times.push(t);
    if (C.timeout < 30) times.push(C.timeout * 1000);
    times.sort((a, b) => a - b);
    for (const r of reqs) { r.state = 'wait'; r.since = 0; }
    for (const t of times) {
      if (reqs.every((r) => r.state === 'done' || r.state === 'timeout')) break;
      ev = [];
      const back = [];
      for (const r of reqs) {
        if (r.state === 'use' && r.got + HOLD_MS <= t) { r.state = 'done'; r.end = t; slots[r.slot - 1].holder = null; back.push(r.id); }
      }
      if (back.length) ev.push({ type: 'return', text: `요청 ${I(rangeText(back))} 0.2초를 쓰고 연결을 풀에 돌려줬다.`, ids: [] });
      const timedOut = [];
      if (t >= C.timeout * 1000) {
        for (const r of reqs) if (r.state === 'wait') { r.state = 'timeout'; r.end = t; timedOut.push(r.id); }
      }
      if (timedOut.length) ev.push({ type: 'timeout', bad: true, text: `pool_timeout ${C.timeout}초가 지났다. 아직 연결을 받지 못한 요청 ${rangeText(timedOut)}, 모두 ${timedOut.length}개가 풀 타임아웃 오류(sqlalchemy.exc.TimeoutError)로 끝났다. 쿼리는 한 번도 보내지 못했다.`, ids: [] });
      const got = [];
      for (const s of slots) {
        if (s.holder) continue;
        const r = reqs.find((x) => x.state === 'wait');
        if (!r) break;
        r.state = 'use';
        r.slot = s.id;
        r.got = t;
        s.holder = r.id;
        s.uses += 1;
        got.push(r.id);
      }
      const left = reqs.filter((x) => x.state === 'wait').length;
      if (got.length) ev.push({ type: 'checkout', text: `요청 ${I(rangeText(got))} 풀에서 연결을 빌렸다${t ? `(출발부터 ${t / 1000}초 기다림)` : '(기다림 없음)'}.${left ? ` 나머지 ${left}개는 연결이 돌아오기를 기다린다.` : ' 이제 기다리는 요청이 없다.'}`, ids: [] });
      snapshot(String(views.length), t, `${t / 1000}초`, false);
    }
    const ok = reqs.filter((r) => r.state === 'done').length;
    const endMs = Math.max(...reqs.map((r) => r.end));
    const waitMaxMs = Math.max(...reqs.filter((r) => r.got != null).map((r) => r.got));
    return { views, summary: { ok, timeout: reqs.filter((r) => r.state === 'timeout').length, endMs, waitMaxMs, created: 0, peak: C.size }, kase: C };
  }

  // 1, 2, 3, 5 → "1~3, 5"
  function rangeText(ids) {
    const s = ids.slice().sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < s.length; i += 1) {
      let j = i;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j += 1;
      out.push(j > i + 1 ? `${s[i]}~${s[j]}` : j === i + 1 ? `${s[i]}, ${s[j]}` : String(s[i]));
      i = j;
    }
    return out.join(', ');
  }

  // ---------- 장면 ----------

  const SCENARIOS = {
    gap: { label: '잠근 응모 사이' },
    noidx: { label: '인덱스가 없을 때' },
    serial: { label: 'SERIALIZABLE의 1.74초' },
    transfer: { label: '반대로 보낸 두 이체' },
    pair: { label: '두 지급 요청' },
    deduct: { label: '동시 차감' },
    reward: { label: '중복 지급 막기' },
    pool: { label: '커넥션 풀' },
  };
  const CHOICES = {
    gap: { level: ['RR', 'RC'], b: Object.keys(GAP_CASES) },
    noidx: { level: ['RR', 'RC'], b: Object.keys(NO_INDEX_CASES) },
    serial: {},
    transfer: { order: ['reverse', 'ordered'], detect: ['ON', 'OFF'] },
    pair: {},
    deduct: { level: ['RC', 'RR', 'SER'] },
    reward: { way: Object.keys(WAYS) },
    pool: { pool: Object.keys(POOL_CASES) },
  };
  const RANGES = { deduct: { n: [2, 10] }, reward: { n: [2, 10] } };
  const DEFAULTS = {
    gap: { level: 'RR', b: 'user7' },
    noidx: { level: 'RR', b: 'user7' },
    serial: {},
    transfer: { order: 'reverse', detect: 'ON' },
    pair: {},
    deduct: { level: 'RR', n: 3 },
    reward: { way: 'plain', n: 3 },
    pool: { pool: 'q5' },
  };
  const TIMELINE_SCENES = ['gap', 'noidx', 'serial', 'transfer', 'pair'];

  function normalizeConfig(scene, input) {
    const out = Object.assign({}, DEFAULTS[scene]);
    const src = input || {};
    for (const [k, list] of Object.entries(CHOICES[scene] || {})) if (list.includes(src[k])) out[k] = src[k];
    for (const [k, [lo, hi]] of Object.entries(RANGES[scene] || {})) {
      const n = Number(src[k]);
      if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, Math.round(n)));
    }
    return out;
  }

  function timelineOf(scene, cfg) {
    if (scene === 'gap') return { name: `idx-insert-${cfg.b}`, level: cfg.level, detect: 'ON' };
    if (scene === 'noidx') return { name: NO_INDEX_CASES[cfg.b][1], level: cfg.level, detect: 'ON' };
    if (scene === 'serial') return { name: 'serializable-insert', level: 'SER', detect: 'ON' };
    if (scene === 'transfer') return { name: `transfer-${cfg.order}`, level: 'RR', detect: cfg.detect };
    if (scene === 'pair') return { name: 'reward-count-lock-pair', level: 'RR', detect: 'ON' };
    return null;
  }

  // 실험의 원자료와 견줄 수 있게 순서표 하나를 실행한다. 테스트가 쓴다.
  function runTimeline(name, level, detect) { return simulateTimeline(name, level, detect); }
  function runBurst(scene, cfg) { return simulateBurst(scene, cfg); }

  function simulate(scene, input) {
    const cfg = normalizeConfig(scene, input);
    if (scene === 'pool') {
      const r = simulatePool(cfg);
      return { scene, cfg, kind: 'pool', views: r.views, threads: [], summary: r.summary, kase: r.kase, title: `커넥션 풀 · ${r.kase.label}` };
    }
    if (scene === 'deduct' || scene === 'reward') {
      const r = simulateBurst(scene, cfg);
      const threads = r.S.order.map((id) => ({ id, name: `요청 ${id}` }));
      const title = scene === 'deduct' ? `문제 상황 2-1: 동시에 몰린 포인트 차감 · ${LEVEL_NAME[cfg.level]}` : `문제 상황 3: ${WAYS[cfg.way].label}`;
      return { scene, cfg, kind: 'burst', title, views: r.views, threads, summary: r.summary, final: r.final, reqs: r.reqs, specs: r.specs, level: r.level, way: scene === 'reward' ? WAYS[cfg.way] : null, deadlocks: r.deadlocks };
    }
    const tl = timelineOf(scene, cfg);
    const T = TIMELINES[tl.name];
    const r = simulateTimeline(tl.name, tl.level, tl.detect);
    const threads = r.S.order.map((id) => ({ id, name: id }));
    return { scene, cfg, kind: 'timeline', timeline: tl.name, level: tl.level, detect: tl.detect, title: T.title, specs: T.tables,
      steps: T.steps.map((s, i) => ({ s: s.s, sql: s.sql, note: s.note, key: `s${i + 1}` })), views: r.views, threads, records: r.records, deadlocks: r.deadlocks, final: r.final };
  }

  // hasToWait는 테스트가 충돌 규칙을 직접 견줄 때 쓴다.
  return { VERSION, LEVEL_NAME, TIMELINES, WAYS, POOL_CASES, POOL_REQUESTS, HOLD_MS, SCENARIOS, CHOICES, RANGES, DEFAULTS, TIMELINE_SCENES, GAP_CASES, NO_INDEX_CASES,
    COUNT, INSERT_REWARD, PAY, LOCK_POINTS, PAY_IF_ZERO, VERSION_UP, normalizeConfig, timelineOf, simulate, runTimeline, runBurst, rangeText, josa, modeStr, hasToWait };
});
