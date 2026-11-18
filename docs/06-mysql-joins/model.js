// 조인 관계도의 설명용 모형. 브라우저에서는 window.JoinModel, Node.js에서는 require로 쓴다.
// 작은 표로 조인·서브쿼리를 한 행씩 따지고, 단계마다 무엇을 읽고 비교했는지와 그 단계 뒤의 결과를 돌려준다.
// 단계는 이벤트의 순서이고 시간 길이가 아니다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JoinModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2026-11-18';

  // 실험의 묶음 ① 표(experiments/06-mysql-joins/python/join_cases.py SMALL_TABLES)와 같다.
  const USERS = [
    { id: 1, name: 'kim' }, { id: 2, name: 'lee' }, { id: 3, name: 'park' }, { id: 4, name: 'choi' }, { id: 5, name: 'jung' },
  ];
  const ORDERS = [
    { id: 1, user_id: 1, item: 'book', status: 'paid' },
    { id: 2, user_id: 1, item: 'cup', status: 'cancelled' },
    { id: 3, user_id: 2, item: 'pen', status: 'paid' },
    { id: 4, user_id: 3, item: 'bag', status: 'cancelled' },
    { id: 5, user_id: null, item: 'gift', status: 'paid' },
  ];

  // 3값 논리: true, false, null(UNKNOWN)
  const T = true, F = false, U = null;
  function eq(a, b) { return a === null || b === null ? U : a === b; }
  function ne(a, b) { const r = eq(a, b); return r === U ? U : !r; }
  function and(a, b) { if (a === F || b === F) return F; if (a === U || b === U) return U; return T; }
  function tv(v) { return v === T ? 'TRUE' : v === F ? 'FALSE' : 'UNKNOWN'; }
  function show(v) { return v === null ? 'NULL' : String(v); }

  const LEFT_WAYS = {
    inner: { label: '(가) JOIN', sql: ['SELECT u.id, o.id', 'FROM users u', 'JOIN orders o ON u.id = o.user_id;'], keep: 'none' },
    left: { label: '(나) LEFT JOIN', sql: ['SELECT u.id, o.id', 'FROM users u', 'LEFT JOIN orders o ON u.id = o.user_id;'], keep: 'left' },
    'left-where': { label: '(다) LEFT JOIN + WHERE', sql: ['SELECT u.id, o.id', 'FROM users u', 'LEFT JOIN orders o ON u.id = o.user_id', "WHERE o.status = 'paid';"], keep: 'left', where: true },
    'left-on': { label: '(라) LEFT JOIN + ON', sql: ['SELECT u.id, o.id', 'FROM users u', "LEFT JOIN orders o ON u.id = o.user_id AND o.status = 'paid';"], keep: 'left', onPaid: true },
    right: { label: 'RIGHT JOIN', sql: ['SELECT u.id, o.id', 'FROM users u', 'RIGHT JOIN orders o ON u.id = o.user_id;'], keep: 'right' },
    full: { label: 'FULL OUTER (UNION)', sql: ['SELECT u.id, o.id FROM users u LEFT JOIN orders o ON u.id = o.user_id', 'UNION', 'SELECT u.id, o.id FROM users u RIGHT JOIN orders o ON u.id = o.user_id;'], keep: 'full' },
  };

  const SEMI_WAYS = {
    in: { label: '(D) IN', sql: ['SELECT u.id FROM users u', 'WHERE u.id IN (SELECT user_id FROM orders);'], kind: 'in', plan: 'Remove duplicates … → Nested loop inner join (세미 조인)' },
    exists: { label: '(E) EXISTS', sql: ['SELECT u.id FROM users u', 'WHERE EXISTS (SELECT 1 FROM orders o', '              WHERE o.user_id = u.id);'], kind: 'exists', plan: 'Remove duplicates … → Nested loop inner join (세미 조인)' },
    join: { label: '(F) JOIN', sql: ['SELECT u.id FROM users u', 'JOIN orders o ON u.id = o.user_id;'], kind: 'join', plan: 'Nested loop inner join' },
    'not-exists': { label: '(B) NOT EXISTS', sql: ['SELECT u.id FROM users u', 'WHERE NOT EXISTS (SELECT 1 FROM orders o', '                  WHERE o.user_id = u.id);'], kind: 'not-exists', plan: 'Nested loop antijoin (안티 조인)' },
    'not-in': { label: '(C) NOT IN', sql: ['SELECT u.id FROM users u', 'WHERE u.id NOT IN (SELECT user_id FROM orders);'], kind: 'not-in', plan: '안티 조인으로 바뀌지 않음, 회원마다 서브쿼리(dependent)' },
    'not-in-fixed': { label: 'NOT IN + IS NOT NULL', sql: ['SELECT u.id FROM users u', 'WHERE u.id NOT IN (SELECT user_id FROM orders', '                   WHERE user_id IS NOT NULL);'], kind: 'not-in', skipNull: true, plan: '결과는 맞음, 계획은 안티 조인이 아님' },
  };

  function step(o) { return Object.assign({ reads: [], matches: [], unknown: [], emit: [], drop: [], note: '', line: [] }, o); }

  // ---------- 장면 1: 조인의 종류와 조건의 자리 ----------
  function runLeft(way) {
    const w = LEFT_WAYS[way];
    const steps = [];
    const result = [];
    const pushRow = (row) => { result.push(row); return row; };
    const joinMatch = (u, o) => {
      const c = eq(u.id, o.user_id);
      if (!w.onPaid) return c;
      return and(c, eq(o.status, 'paid'));
    };
    if (w.keep === 'right') {
      for (const o of ORDERS) {
        const matches = [], unknown = [], reads = USERS.map((u) => u.id), emit = [];
        for (const u of USERS) { const m = eq(u.id, o.user_id); if (m === T) matches.push(u.id); else if (m === U) unknown.push(u.id); }
        if (matches.length) for (const uid of matches) emit.push(pushRow({ u: uid, o: o.id }));
        else emit.push(pushRow({ u: null, o: o.id, filled: 'left' }));
        steps.push(step({ side: 'orders', cur: o.id, reads, matches, unknown, emit, line: [2],
          note: matches.length ? `주문 ${o.id}의 짝은 회원 ${matches.join(', ')}` : `주문 ${o.id}는 짝이 없어 users 칼럼을 NULL로 채운다` + (o.user_id === null ? '(user_id가 NULL이라 모든 비교가 UNKNOWN)' : '') }));
      }
      return { steps, result };
    }
    for (const u of USERS) {
      const matches = [], unknown = [], reads = ORDERS.map((o) => o.id), emit = [];
      for (const o of ORDERS) { const m = joinMatch(u, o); if (m === T) matches.push(o.id); else if (m === U) unknown.push(o.id); }
      for (const oid of matches) emit.push(pushRow({ u: u.id, o: oid }));
      if (!matches.length && w.keep !== 'none') emit.push(pushRow({ u: u.id, o: null, filled: 'right' }));
      let note;
      if (matches.length) note = `회원 ${u.id}(${u.name})의 짝은 주문 ${matches.join(', ')}`;
      else if (w.keep === 'none') note = `회원 ${u.id}(${u.name})는 짝이 없어 결과에 넣지 않는다`;
      else note = `회원 ${u.id}(${u.name})는 짝이 없어 orders 칼럼을 NULL로 채워 남긴다`;
      if (w.onPaid && u.id === 1) note += ' (주문 2는 status가 cancelled라 ON 조건이 FALSE)';
      if (w.onPaid && u.id === 3) note += ' (주문 4가 cancelled라 짝이 아니다)';
      steps.push(step({ side: 'users', cur: u.id, reads, matches, unknown, emit, line: [2], note }));
    }
    if (w.where) {
      const drop = [], keepRows = [];
      const checks = result.map((r) => {
        const o = ORDERS.find((x) => x.id === r.o);
        const v = eq(o ? o.status : null, 'paid');
        (v === T ? keepRows : drop).push(r);
        return { row: r, value: v };
      });
      steps.push(step({ side: 'where', cur: null, checks, drop, line: [3],
        note: `WHERE를 조인 결과 ${result.length}행에 적용한다. o.status가 NULL인 행은 NULL = 'paid'가 UNKNOWN이라 빠진다` }));
      return { steps, result: keepRows, before: result };
    }
    if (w.keep === 'full') {
      const extra = [];
      for (const o of ORDERS) {
        if (!USERS.some((u) => eq(u.id, o.user_id) === T)) extra.push({ u: null, o: o.id, filled: 'left' });
      }
      const rightRows = [];
      for (const o of ORDERS) {
        const ms = USERS.filter((u) => eq(u.id, o.user_id) === T);
        if (ms.length) for (const u of ms) rightRows.push({ u: u.id, o: o.id }); else rightRows.push({ u: null, o: o.id, filled: 'left' });
      }
      const dup = rightRows.filter((r) => result.some((x) => x.u === r.u && x.o === r.o));
      for (const r of extra) result.push(r);
      steps.push(step({ side: 'union', cur: null, emit: extra, dup, line: [1, 2],
        note: `RIGHT JOIN 결과 ${rightRows.length}행 중 ${dup.length}행은 LEFT 결과와 같아 UNION이 한 번만 남기고, 짝 없는 주문 ${extra.map((r) => r.o).join(', ')}만 더해진다` }));
    }
    return { steps, result };
  }

  // ---------- 장면 2: 세미 조인, 안티 조인, NOT IN ----------
  function runSemi(way) {
    const w = SEMI_WAYS[way];
    const steps = [];
    const result = [];
    const list = ORDERS.map((o) => o.user_id).filter((v) => !(w.skipNull && v === null));
    for (const u of USERS) {
      const s = { side: 'users', cur: u.id, reads: [], matches: [], unknown: [], emit: [], line: [1] };
      if (w.kind === 'exists' || w.kind === 'not-exists' || w.kind === 'join') {
        let found = false;
        for (const o of ORDERS) {
          s.reads.push(o.id);
          const m = eq(o.user_id, u.id);
          if (m === T) { s.matches.push(o.id); found = true; if (w.kind !== 'join') break; }
          else if (m === U) s.unknown.push(o.id);
        }
        if (w.kind === 'join') { for (const oid of s.matches) { const r = { u: u.id, o: oid }; result.push(r); s.emit.push(r); } }
        else {
          const keep = w.kind === 'exists' ? found : !found;
          if (keep) { const r = { u: u.id }; result.push(r); s.emit.push(r); }
          s.value = w.kind === 'exists' ? found : !found;
        }
        if (w.kind === 'join') s.note = s.matches.length ? `회원 ${u.id}: 짝 ${s.matches.length}개라 ${s.matches.length}행을 만든다` : `회원 ${u.id}: 짝이 없어 행이 없다`;
        else if (found) s.note = `회원 ${u.id}: 주문 ${s.matches[0]}에서 짝을 찾아 바로 멈춘다 → ${w.kind === 'exists' ? '남긴다(세미 조인)' : '뺀다'}`;
        else s.note = `회원 ${u.id}: 끝까지 짝이 없다` + (s.unknown.length ? `(주문 ${s.unknown.join(', ')}의 user_id는 NULL이라 UNKNOWN, 짝이 아님)` : '') + ` → ${w.kind === 'exists' ? '뺀다' : '남긴다(안티 조인)'}`;
        if (w.kind !== 'join') s.line = w.kind === 'exists' ? [1, 2] : [1, 2];
      } else if (w.kind === 'in') {
        let v = F;
        s.chain = list.map((x) => { const e = eq(u.id, x); v = v === T || e === T ? T : (v === U || e === U ? U : F); return { x, e }; });
        s.value = v;
        if (v === T) { const r = { u: u.id }; result.push(r); s.emit.push(r); }
        s.note = `회원 ${u.id}: u.id = 목록의 값 하나라도 TRUE면 남긴다 → ${tv(v)}`;
      } else {
        let v = T;
        s.chain = list.map((x) => { const e = ne(u.id, x); v = and(v, e); return { x, e }; });
        s.value = v;
        if (v === T) { const r = { u: u.id }; result.push(r); s.emit.push(r); }
        s.note = `회원 ${u.id}: ${list.map((x) => `${u.id} <> ${show(x)}`).join(' AND ')} → ${tv(v)}` + (v === U ? ', TRUE가 아니라 빠진다' : v === T ? ', 남긴다' : ', 빠진다');
      }
      steps.push(step(s));
    }
    return { steps, result, list };
  }

  // ---------- 장면 3: 조인 방식 ----------
  // 모형 표: users 6행(code 101~106), orders 6행. 실험은 각 1만 행이다.
  const ALGO_USERS = [
    { id: 1, code: 104 }, { id: 2, code: 101 }, { id: 3, code: 106 }, { id: 4, code: 102 }, { id: 5, code: 105 }, { id: 6, code: 103 },
  ];
  const ALGO_ORDERS = [
    { id: 1, user_code: 103 }, { id: 2, user_code: 106 }, { id: 3, user_code: 101 }, { id: 4, user_code: 105 }, { id: 5, user_code: 102 }, { id: 6, user_code: 104 },
  ];
  const IDX_CODE_LEVELS = 2; // 모형의 idx_code: 루트 1장 + 리프 2장(실험 1만 행은 2~3장을 내려감)
  const ALGO_WAYS = {
    hash: { label: '(가) 인덱스 없음 → 해시 조인', plan: 'Inner hash join', sql: ['SELECT COUNT(*), SUM(o.amount)', 'FROM users u JOIN orders o', 'ON u.code = o.user_code;'] },
    'nl-scan': { label: '(나) + NO_BNL → 중첩 루프, 인덱스 없음', plan: 'Nested loop inner join · Table scan on o', sql: ['SELECT /*+ NO_BNL(u, o) */', '  COUNT(*), SUM(o.amount)', 'FROM users u JOIN orders o', 'ON u.code = o.user_code;'] },
    'nl-index': { label: '(다) idx_code → 중첩 루프, 인덱스로 찾기', plan: 'Nested loop inner join · Covering index lookup on u using idx_code', sql: ['-- CREATE INDEX idx_code ON users (code);', 'SELECT COUNT(*), SUM(o.amount)', 'FROM users u JOIN orders o', 'ON u.code = o.user_code;'] },
  };
  const ALGO_SCOPES = { all: { label: '주문 전부', where: null }, few: { label: '주문 2건만 (o.id <= 2)', where: 2 } };

  function runAlgo(way, scope) {
    const lim = ALGO_SCOPES[scope].where;
    const orders = lim ? ALGO_ORDERS.filter((o) => o.id <= lim) : ALGO_ORDERS;
    const steps = [];
    const tally = { rows: 0, compares: 0, pages: 0, probes: 0, builds: 0, matches: 0 };
    const snap = () => Object.assign({}, tally);
    if (way === 'hash') {
      // 실험 계획: 1만 대 1만은 users로 빌드하고 orders로 프로브, 주문 10건은 작은 orders로 빌드하고 users로 프로브했다.
      const buildSide = lim ? 'o' : 'u';
      const build = buildSide === 'o' ? orders.map((o) => ({ t: 'o', id: o.id, key: o.user_code })) : ALGO_USERS.map((u) => ({ t: 'u', id: u.id, key: u.code }));
      const probe = buildSide === 'o' ? ALGO_USERS.map((u) => ({ t: 'u', id: u.id, key: u.code })) : orders.map((o) => ({ t: 'o', id: o.id, key: o.user_code }));
      const hashTable = [];
      for (const b of build) {
        tally.rows += 1; tally.builds += 1;
        hashTable.push(b.key);
        steps.push(step({ phase: 'build', buildSide, cur: { t: b.t, id: b.id }, hash: hashTable.slice(), tally: snap(),
          note: `빌드: ${b.t === 'o' ? '주문' : '회원'} ${b.id}의 ${b.t === 'o' ? 'user_code' : 'code'}(${b.key})를 해시 테이블에 넣는다` }));
      }
      for (const p of probe) {
        tally.rows += 1; tally.probes += 1;
        const hitB = build.find((b) => b.key === p.key);
        if (hitB) tally.matches += 1;
        steps.push(step({ phase: 'probe', buildSide, cur: { t: p.t, id: p.id }, key: p.key, hit: hitB ? hitB.id : null, hash: hashTable.slice(), tally: snap(),
          note: `프로브: ${p.t === 'o' ? '주문' : '회원'} ${p.id}의 ${p.t === 'o' ? 'user_code' : 'code'}(${p.key})를 해시 테이블에서 한 번 찾는다 → ${hitB ? `${hitB.t === 'o' ? '주문' : '회원'} ${hitB.id}` : '없음'}` }));
      }
    } else if (way === 'nl-scan') {
      // 실험 (나)의 계획: 드라이빙 users, 안쪽 Table scan on o
      for (const u of ALGO_USERS) {
        const scanned = orders.map((o) => o.id);
        tally.rows += 1 + orders.length; tally.compares += orders.length;
        const hit = orders.find((o) => o.user_code === u.code);
        if (hit) tally.matches += 1;
        steps.push(step({ phase: 'scan', cur: { t: 'u', id: u.id }, scanned, hit: hit ? hit.id : null, tally: snap(),
          note: `회원 ${u.id}(code ${u.code})마다 orders ${orders.length}행을 처음부터 끝까지 읽고 비교한다` + (hit ? `, 짝은 주문 ${hit.id}` : ', 짝 없음') }));
      }
    } else {
      // 실험 (다)의 계획: 드라이빙 orders, idx_code로 users를 찾는다
      for (const o of orders) {
        tally.rows += 2; tally.pages += IDX_CODE_LEVELS;
        const hit = ALGO_USERS.find((u) => u.code === o.user_code);
        if (hit) tally.matches += 1;
        steps.push(step({ phase: 'lookup', cur: { t: 'o', id: o.id }, key: o.user_code, hit: hit ? hit.id : null, tally: snap(),
          note: `주문 ${o.id}: idx_code에서 code = ${o.user_code}인 항목을 루트부터 리프까지 ${IDX_CODE_LEVELS}장 내려가 찾고, 그 항목 하나만 읽는다 → 회원 ${hit.id}` }));
      }
    }
    return { steps, result: tally.matches, tally, orders };
  }

  // ---------- 장면 4: N+1 ----------
  const N1_SIZES = [3, 5, 10];
  const N1_WAYS = {
    'n-plus-1': { label: 'N+1', author: '' },
    join: { label: 'JOIN 한 번', author: '' },
    'in-list': { label: 'IN 두 번', author: '' },
  };
  const RTTS = { local: { label: '같은 맥 0.277ms', ms: 0.277 }, remote: { label: '다른 서버 1ms(셈)', ms: 1 } };
  const ORDERS_PER_USER = 10; // 실험과 같다

  function runN1(way, n, rtt) {
    const ms = RTTS[rtt].ms;
    const steps = [];
    let queries = 0, rows = 0;
    const push = (sql, got, note) => {
      queries += 1; rows += got;
      steps.push(step({ sql, got, queries, rows, rttSum: Math.round(queries * ms * 1000) / 1000, note }));
    };
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    if (way === 'n-plus-1') {
      push(`SELECT id, name FROM users ORDER BY id LIMIT ${n}`, n, `목록 쿼리 1번: 회원 ${n}명을 받는다`);
      for (const id of ids) push(`SELECT id, amount FROM orders WHERE user_id = ${id}`, ORDERS_PER_USER, `회원 ${id}의 주문을 따로 묻는다(왕복 1번 더)`);
    } else if (way === 'join') {
      push(`SELECT … FROM (SELECT id, name FROM users ORDER BY id LIMIT ${n}) u LEFT JOIN orders o ON o.user_id = u.id`, n * ORDERS_PER_USER, `쿼리 1번으로 회원 ${n}명 × 주문 ${ORDERS_PER_USER}건 = ${n * ORDERS_PER_USER}행을 받는다`);
    } else {
      push(`SELECT id, name FROM users ORDER BY id LIMIT ${n}`, n, `목록 쿼리 1번: 회원 ${n}명을 받는다`);
      push(`SELECT id, user_id, amount FROM orders WHERE user_id IN (${ids.join(', ')})`, n * ORDERS_PER_USER, `받은 id를 IN에 넣어 주문을 한 번에 받는다`);
    }
    return { steps, queries, rows, rttSum: Math.round(queries * ms * 1000) / 1000 };
  }

  function expectedQueries(way, n) { return way === 'n-plus-1' ? n + 1 : way === 'join' ? 1 : 2; }

  const SCENES = {
    left: { title: '조인의 종류와 조건의 자리', choices: { way: LEFT_WAYS }, defaults: { way: 'left-where' } },
    semi: { title: '세미 조인·안티 조인과 NOT IN', choices: { way: SEMI_WAYS }, defaults: { way: 'not-in' } },
    algo: { title: '조인 방식', choices: { way: ALGO_WAYS, scope: ALGO_SCOPES }, defaults: { way: 'nl-scan', scope: 'all' } },
    n1: { title: 'N+1', choices: { way: N1_WAYS, n: Object.fromEntries(N1_SIZES.map((x) => [String(x), { label: `회원 ${x}명` }])), rtt: RTTS }, defaults: { way: 'n-plus-1', n: '5', rtt: 'local' } },
  };

  function normalize(scene, cfg) {
    const s = SCENES[scene];
    const out = {};
    for (const k of Object.keys(s.choices)) out[k] = cfg && Object.prototype.hasOwnProperty.call(s.choices[k], cfg[k]) ? cfg[k] : s.defaults[k];
    return out;
  }

  function simulate(scene, input) {
    const cfg = normalize(scene, input);
    if (scene === 'left') return Object.assign({ scene, cfg, sql: LEFT_WAYS[cfg.way].sql }, runLeft(cfg.way));
    if (scene === 'semi') return Object.assign({ scene, cfg, sql: SEMI_WAYS[cfg.way].sql, plan: SEMI_WAYS[cfg.way].plan }, runSemi(cfg.way));
    if (scene === 'algo') return Object.assign({ scene, cfg, sql: ALGO_WAYS[cfg.way].sql.concat(cfg.scope === 'few' ? ['WHERE o.id <= 2;'] : []), plan: ALGO_WAYS[cfg.way].plan }, runAlgo(cfg.way, cfg.scope));
    const n = Number(cfg.n);
    return Object.assign({ scene, cfg, sql: null }, runN1(cfg.way, n, cfg.rtt));
  }

  return { VERSION, USERS, ORDERS, ALGO_USERS, ALGO_ORDERS, IDX_CODE_LEVELS, LEFT_WAYS, SEMI_WAYS, ALGO_WAYS, ALGO_SCOPES, N1_WAYS, N1_SIZES, RTTS, ORDERS_PER_USER,
    SCENES, eq, ne, and, tv, show, normalize, simulate, runLeft, runSemi, runAlgo, runN1, expectedQueries };
});
