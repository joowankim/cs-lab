'use strict';
// 인덱스 관계도의 점검. 이 폴더에서 node --test model.test.cjs 로 돌린다(Node.js 18 이상, 따로 설치할 것 없음).
// 1. 맥 본 측정(2026-11-12)에 같은 쿼리가 있는 구성은 모형의 계획(type, key, Extra)이 원자료와 같고, Handler_read_*의 꼴이 같다.
// 2. "실험에서 잰 값" 칸의 숫자는 원자료에서 다시 계산한 값과 같다(시간 표기 규칙도 같다).
// 3. 모형의 불변식: 같은 입력에 같은 단계, 페이지 분할의 키 순서와 개수, 락 장면의 합과 락 개수.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const M = require('./model.js');
const C = require('./content.js').IndexContent;

const RESULTS = path.join(__dirname, '..', '..', 'experiments', '05-mysql-indexes-explain', 'results');
const INDEX_FILE = '2026-11-12T065847399314-index-python-3.14.2.jsonl';
const WRITE_FILES = { big: '2026-11-12T070016205934-write-python-3.14.2.jsonl', small: '2026-11-12T070448294044-write-python-3.14.2.jsonl' };
const readJsonl = (name) => fs.readFileSync(path.join(RESULTS, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const INDEX = readJsonl(INDEX_FILE);
const WRITE = { big: readJsonl(WRITE_FILES.big), small: readJsonl(WRITE_FILES.small) };
const MEASURED_RUNS = [1, 2, 3]; // 0번은 워밍업

// ---------- 원자료 읽기 ----------

function runsOf(c, q) {
  const rs = INDEX.filter((r) => r.case === c && r.query === q && MEASURED_RUNS.includes(r.run));
  assert.equal(rs.length, 3, `${c} / ${q}: 본 측정 3회가 있어야 한다`);
  for (const r of rs) assert.equal(r.valid, true, `${c} / ${q} run ${r.run}: 결과 검증을 통과해야 한다`);
  return rs;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[(s.length - 1) / 2]; };
const HANDLER_ORDER = ['first', 'last', 'key', 'next', 'prev', 'rnd_next'];
function rawHandler(r) {
  const h = {};
  for (const k of HANDLER_ORDER) h[k] = r.measure.handler_reads[`Handler_read_${k}`] || 0;
  return h;
}
const nfmt = (n) => Number(n).toLocaleString('en-US');
function handlerText(h) { return HANDLER_ORDER.filter((k) => h[k]).map((k) => `${k} ${nfmt(h[k])}`).join(' · '); }

// 시간 표기 규칙(실험 README와 같다): 1 미만은 소수 셋째 자리, 1 이상 100 미만은 유효 숫자 세 자리, 100 이상은 정수.
// 최솟값과 최댓값의 표기가 같으면 하나만 쓴다.
function fmtMs(v) {
  if (v < 1) return v.toFixed(3);
  if (v < 100) return v.toPrecision(3);
  return String(Math.round(v));
}
function msRange(xs) {
  const a = fmtMs(Math.min(...xs));
  const b = fmtMs(Math.max(...xs));
  return a === b ? a : `${a}~${b}`;
}
// 논리적 읽기: 한 번 돌릴 때 EXPLAIN ANALYZE와 결과 받기로 쿼리를 두 번 실행해, 늘어난 Innodb_buffer_pool_read_requests의 절반을 쿼리 한 번의 값으로 본다(세 번의 중앙값).
function logical(rs) {
  const v = median(rs.map((r) => r.measure.pool_read_requests)) / 2;
  assert.ok(Number.isInteger(v), `논리적 읽기는 정수여야 한다: ${v}`);
  return v;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 숫자 앞뒤에 다른 숫자가 붙어 있으면 다른 값이다(예: 13과 3,413).
function assertMentions(text, expected, what) {
  const re = new RegExp(`(?<![\\d.,])${escRe(expected)}(?![\\d]|[.,]\\d)`);
  assert.match(text, re, `${what}: "${expected}"가 실험에서 잰 값 칸에 있어야 한다`);
}
const measuredText = (scene) => C.SCENES[scene].measured.join('\n');

// ---------- 1. 원자료와 짝인 구성 ----------

function cfgOf(scene, key) {
  const names = Object.keys(M.CHOICES[scene]);
  const vals = key.split('|');
  assert.equal(vals.length, names.length, `${scene} ${key}: 구성 칸의 수`);
  return Object.fromEntries(names.map((n, i) => [n, vals[i]]));
}
const PAIRED = Object.entries(M.RAW).flatMap(([scene, map]) => Object.entries(map).map(([key, [c, q]]) => ({ scene, key, c, q })));

test('짝인 구성이 원자료에 있다', () => {
  assert.ok(PAIRED.length >= 30, `짝인 구성 ${PAIRED.length}개`);
  for (const p of PAIRED) runsOf(p.c, p.q);
});

test('짝인 구성의 계획(type, key, Extra)이 원자료의 EXPLAIN과 같다', () => {
  for (const p of PAIRED) {
    const run = M.simulate(p.scene, cfgOf(p.scene, p.key));
    assert.deepEqual(run.raw, [p.c, p.q], `${p.scene} ${p.key}: run.raw`);
    for (const r of runsOf(p.c, p.q)) {
      const e = r.explain[0];
      const what = `${p.scene} ${p.key} (${p.c} / ${p.q})`;
      assert.equal(run.explain.type, e.type, `${what}: type`);
      assert.equal(run.explain.key || null, e.key || null, `${what}: key`);
      assert.equal(run.explain.extra || '', e.Extra || '', `${what}: Extra`);
    }
  }
});

test('짝인 구성의 Handler_read_* 꼴이 원자료와 같다', () => {
  for (const p of PAIRED) {
    const run = M.simulate(p.scene, cfgOf(p.scene, p.key));
    const rs = runsOf(p.c, p.q);
    const raw = rawHandler(rs[0]);
    const what = `${p.scene} ${p.key} (${p.c} / ${p.q})`;
    // 실험 README: Handler_read_*는 세 번 모두 같았다
    for (const r of rs) assert.deepEqual(rawHandler(r), raw, `${what}: 세 번의 Handler_read_*`);
    const model = Object.fromEntries(HANDLER_ORDER.map((k) => [k, run.handler[k] || 0]));
    // first, last, key는 한 번 찾을 때마다 1이라 표 크기와 상관없이 같아야 한다.
    for (const k of ['first', 'last', 'key']) assert.equal(model[k], raw[k], `${what}: Handler_read_${k}`);
    // next, prev, rnd_next는 읽은 행 수라 표 크기에 따라 다르다. 0인지 아닌지가 같아야 한다.
    for (const k of ['next', 'prev', 'rnd_next']) assert.equal(model[k] > 0, raw[k] > 0, `${what}: Handler_read_${k}가 0인지`);
    // 표 전체 읽기는 행 수보다 1 많다(마지막에 표 끝을 알리는 한 번).
    if (raw.rnd_next) {
      assert.equal(raw.rnd_next, rs[0].size + 1, `${what}: 원자료 rnd_next`);
      assert.equal(model.rnd_next, M.ROWS.length + 1, `${what}: 모형 rnd_next`);
    }
  }
});

test('WHERE의 값 꼴만 다른 user_id = 4242는 문자열 판과 계획과 읽기가 같다', () => {
  const a = runsOf('s1-3-indexes', 'user-string');
  const b = runsOf('s1-3-indexes', 'user-int');
  assert.equal(a[0].explain[0].type, b[0].explain[0].type);
  assert.equal(a[0].explain[0].key, b[0].explain[0].key);
  assert.deepEqual(rawHandler(a[0]), rawHandler(b[0]));
  assert.equal(logical(a), logical(b));
});

// ---------- 2. 실험에서 잰 값 칸 ----------

const MEASURED = [
  ['find', 's1-none', 'recent-4242', ['handler', 'time', 'logical', 'rows']],
  ['find', 's1-user', 'recent-4242', ['handler', 'time', 'logical', 'rows']],
  ['find', 's1-user-created', 'recent-4242', ['handler', 'time', 'logical', 'rows']],
  ['find', 's1-1-none', 'recent-1', ['time', 'logical', 'rows']],
  ['find', 's1-1-user', 'recent-1', ['handler', 'time', 'logical', 'rows']],
  ['find', 's1-1-user-created', 'recent-1', ['handler', 'time', 'logical', 'rows']],
  ['find', 's1-1-covering', 'recent-1', ['handler', 'time', 'logical', 'rows']],
  ['order', 's1-user-created', 'recent-4242', ['handler', 'time', 'logical', 'rows']],
  ['order', 's1-covering', 'recent-4242', ['time', 'logical']],
  ['order', 's1-created-user', 'recent-4242', ['handler', 'time', 'logical', 'rows']],
  ['unused', 's1-3-indexes', 'day-func', ['handler', 'time', 'logical', 'result']],
  ['unused', 's1-3-indexes', 'day-range', ['handler', 'time', 'logical']],
  ['unused', 's1-3-indexes', 'phone-number', ['time', 'logical']],
  ['unused', 's1-3-indexes', 'phone-string', ['handler', 'time', 'logical']],
  ['unused', 's1-3-indexes', 'phone-suffix', ['time', 'logical', 'result']],
  ['unused', 's1-3-indexes', 'phone-prefix', ['handler', 'time', 'logical']],
  ['unused', 's1-3-indexes', 'user-string', ['handler', 'time', 'logical']],
  ['unused', 's1-3-memo-prefix', 'memo-like', ['time', 'logical', 'result']],
  ['unused', 's1-3-memo', 'memo-like', ['time']],
  ['unused', 's1-3-fix', 'day-fix-person', ['handler', 'time', 'logical', 'result']],
  ['unused', 's1-3-fix', 'phone-fix-person', ['time', 'logical']],
  ['unused', 's1-3-fix', 'day-fix-person-2', ['time', 'logical']],
  ['unused', 's1-3-func-index', 'day-func', ['time', 'logical']],
  ['sort', 's2-none', 'latest-20', ['handler', 'time', 'logical']],
  ['sort', 's2-created', 'latest-20', ['handler', 'time', 'logical', 'rows']],
  ['sort', 's2-user', 'user1-latest-20', ['handler', 'time', 'logical', 'rows']],
  ['sort', 's2-user-created', 'user1-latest-20', ['handler', 'time', 'logical', 'rows']],
  ['page', 's2-created', 'latest-offset-100k', ['handler', 'time', 'logical']],
  ['page', 's2-created', 'latest-offset-100k-force', ['handler', 'time', 'logical']],
  ['page', 's2-created', 'latest-offset-p170', ['handler', 'time', 'logical']],
  ['page', 's2-created', 'latest-cursor-person-hyphen-fixed', ['handler', 'time', 'logical']],
  ['page', 's2-created', 'latest-cursor-created-only', ['handler', 'time']],
  ['page', 's2-created', 'latest-cursor-person-2', ['handler', 'time']],
  ['page', 's2-created', 'latest-cursor-person-2-p170', ['handler', 'time', 'logical']],
  ['page', 's2-created', 'latest-cursor-or', ['handler', 'time', 'logical']],
  ['page', 's2-created', 'latest-cursor-or-p170', ['handler', 'time', 'logical']],
  ['page', 's2-created', 'latest-cursor-row', ['handler', 'time', 'logical']],
];

test('시간 표기 규칙', () => {
  assert.equal(fmtMs(0.00625), '0.006');
  assert.equal(fmtMs(9.9), '9.90');
  assert.equal(fmtMs(10.2), '10.2');
  assert.equal(fmtMs(143), '143');
  assert.equal(msRange([0.00129, 0.00138]), '0.001');
  assert.equal(msRange([35.2, 36.0]), '35.2~36.0');
});

test('실험에서 잰 값 칸의 조회 숫자가 원자료와 같다', () => {
  for (const [scene, c, q, fields] of MEASURED) {
    const rs = runsOf(c, q);
    const text = measuredText(scene);
    const what = `${scene} ${c} / ${q}`;
    if (fields.includes('time')) assertMentions(text, `${msRange(rs.map((r) => r.measure.analyze.last_ms))}ms`, `${what} 시간`);
    if (fields.includes('logical')) assertMentions(text, nfmt(logical(rs)), `${what} 논리적 읽기`);
    if (fields.includes('handler')) assertMentions(text, handlerText(rawHandler(rs[0])), `${what} Handler_read_*`);
    if (fields.includes('rows')) assertMentions(text, nfmt(rs[0].explain[0].rows), `${what} 추정 rows`);
    if (fields.includes('result')) {
      for (const r of rs) assert.equal(r.measure.result_rows, rs[0].measure.result_rows, `${what}: 세 번의 결과 행 수`);
      assertMentions(text, `${nfmt(rs[0].measure.result_rows)}행`, `${what} 결과 행 수`);
    }
  }
});

function writeRuns(pool, variant) {
  const rs = WRITE[pool].filter((r) => r.variant === variant && MEASURED_RUNS.includes(r.run));
  assert.equal(rs.length, 3, `${pool} ${variant}: 본 측정 3회`);
  for (const r of rs) assert.equal(r.valid, true, `${pool} ${variant} run ${r.run}: 결과 검증`);
  return rs;
}
const secs = (rs) => rs.map((r) => r.wall_s);
const counter = (rs, k) => rs.map((r) => r.measure.counters[k]);
const mib = (b) => nfmt(Math.round(b / 1048576));
const intRange = (xs, f = nfmt) => { const a = f(Math.min(...xs)); const b = f(Math.max(...xs)); return a === b ? a : `${a}~${b}`; };

test('실험에서 잰 값 칸의 쓰기 숫자가 원자료와 같다', () => {
  const text = measuredText('split');
  for (const [pool, w] of Object.entries(WRITE)) {
    // 버퍼 풀 크기는 측정 환경 파일에 적혀 있다
    const env = fs.readFileSync(path.join(RESULTS, w[0].environment_file), 'utf8');
    assert.match(env, new RegExp(`"innodb_buffer_pool_size": ${pool === 'big' ? 1073741824 : 134217728}`), `${pool}: 버퍼 풀 크기`);
    const base = median(secs(writeRuns(pool, 'pk-auto')));
    for (const v of ['pk-auto', 'pk-uuid4', 'pk-uuid7']) {
      const rs = writeRuns(pool, v);
      const s = secs(rs);
      const what = `${pool} ${v}`;
      assertMentions(text, `${median(s).toFixed(2)}초(${Math.min(...s).toFixed(2)}~${Math.max(...s).toFixed(2)})`, `${what} 넣는 시간`);
      if (v !== 'pk-auto') assertMentions(text, `${(median(s) / base).toFixed(2)}배`, `${what} AUTO_INCREMENT 대비`);
      // 분할 수는 세 번 모두 같다
      const splits = counter(rs, 'index_page_splits');
      assert.ok(splits.every((x) => x === splits[0]), `${what}: 세 번의 분할 수`);
      if (pool === 'big') assertMentions(text, nfmt(splits[0]), `${what} 분할 수`);
      if (pool === 'small') assertMentions(text, `${intRange(counter(rs, 'Innodb_buffer_pool_reads'))}페이지`, `${what} 물리적 읽기`);
    }
  }
  const big = (v) => writeRuns('big', v);
  assertMentions(text, `${intRange(counter(big('pk-auto'), 'Innodb_data_written'), mib)}MiB`, 'big auto 쓰기');
  assertMentions(text, `${intRange(counter(big('pk-uuid4'), 'Innodb_data_written'), mib)}MiB`, 'big uuid4 쓰기');
  assertMentions(text, `${intRange(counter(big('pk-uuid7'), 'Innodb_data_written'), mib)}MiB`, 'big uuid7 쓰기');
  assertMentions(text, `${intRange(counter(writeRuns('small', 'pk-uuid4'), 'Innodb_data_written'), mib)}MiB`, 'small uuid4 쓰기');
  assertMentions(text, nfmt(counter(big('pk-uuid4'), 'index_page_reorg_attempts')[0]), 'big uuid4 페이지 재구성');
  const reads = ['pk-auto', 'pk-uuid4', 'pk-uuid7'].flatMap((v) => counter(big(v), 'Innodb_buffer_pool_reads'));
  assertMentions(text, `${intRange(reads)}페이지`, 'big 물리적 읽기');
  // ③ 보조 인덱스 수
  const idx0 = median(secs(big('idx-0')));
  assertMentions(text, `${idx0.toFixed(2)}초`, '③ 0개');
  for (const v of ['idx-3', 'idx-6']) {
    const m = median(secs(big(v)));
    assertMentions(text, `${m.toFixed(2)}초(${(m / idx0).toFixed(2)}배)`, `③ ${v}`);
  }
  for (const v of ['idx-0', 'idx-3', 'idx-6']) assertMentions(text, nfmt(counter(big(v), 'index_page_splits')[0]), `③ ${v} 분할 수`);
});

// ---------- 3. 모형의 불변식 ----------

function allConfigs() {
  const out = [];
  for (const scene of Object.keys(M.SCENARIOS)) {
    let list = [{}];
    for (const [k, vals] of Object.entries(M.CHOICES[scene])) list = list.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
    for (const cfg of list) out.push({ scene, cfg });
  }
  return out;
}

test('모든 구성이 돌고, 같은 입력에 같은 단계를 낸다', () => {
  const list = allConfigs();
  assert.equal(list.length, 48);
  for (const { scene, cfg } of list) {
    const a = M.simulate(scene, cfg);
    const b = M.simulate(scene, cfg);
    assert.ok(a.views.length >= 2, `${scene} ${JSON.stringify(cfg)}: 단계 수`);
    assert.equal(JSON.stringify(a), JSON.stringify(b), `${scene} ${JSON.stringify(cfg)}: 같은 결과`);
  }
});

test('읽기 장면: 논리적 읽기는 읽은 페이지 수의 합이고, 결과는 LIMIT을 넘지 않는다', () => {
  for (const { scene, cfg } of allConfigs()) {
    const run = M.simulate(scene, cfg);
    if (run.kind !== 'read') continue;
    const what = `${scene} ${JSON.stringify(cfg)}`;
    let sum = 0;
    for (const v of run.views) {
      sum += v.pages.length;
      assert.equal(v.logical, sum, `${what} 단계 ${v.label}: 논리적 읽기`);
      const visits = Object.values(v.visits).reduce((a, b) => a + b, 0);
      assert.equal(visits, sum, `${what} 단계 ${v.label}: 페이지별 횟수의 합`);
    }
    const last = run.views[run.views.length - 1];
    assert.ok(last.done, `${what}: 마지막 단계에서 끝난다`);
    if (run.spec.limit) assert.ok(last.results.length <= run.spec.limit, `${what}: LIMIT`);
    // 두 번 읽기는 보조 인덱스로 찾고 커버링이 아닐 때만 있다
    if (!run.index || run.spec.covering) assert.equal(last.lookups, 0, `${what}: 두 번 읽기`);
  }
});

test('쓰기 장면: 키 순서, 리프 개수, 버퍼 풀', () => {
  const finals = {};
  for (const pk of Object.keys(M.PK_KEYS)) {
    for (const pool of Object.keys(M.POOLS)) {
      const run = M.simulate('split', { pk, pool });
      const what = `${pk} ${pool}`;
      run.views.forEach((v, k) => {
        const keys = v.leaves.flatMap((l) => l.keys);
        assert.equal(keys.length, k, `${what} 단계 ${k}: 넣은 키 수`);
        assert.equal(v.counts.rows, k, `${what} 단계 ${k}: counts.rows`);
        for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i], `${what} 단계 ${k}: 리프의 키가 순서대로다`);
        for (const l of v.leaves) assert.ok(l.keys.length <= M.LEAF_CAP, `${what} 단계 ${k}: 리프 한 장의 칸`);
        assert.equal(v.counts.leaves, v.leaves.length, `${what} 단계 ${k}: 리프 수`);
        assert.ok(v.lru.length <= run.frames, `${what} 단계 ${k}: 버퍼 풀 크기`);
        for (const id of v.dirty) assert.ok(v.lru.includes(id), `${what} 단계 ${k}: 더티 페이지는 버퍼 풀에 있다`);
        assert.ok(v.counts.flushes <= v.counts.evictions, `${what} 단계 ${k}: 플러시는 축출된 더티 페이지만`);
        assert.equal(v.counts.splits, v.counts.endSplits + v.counts.midSplits, `${what} 단계 ${k}: 분할 수`);
      });
      finals[`${pk}|${pool}`] = run.views[run.views.length - 1].counts;
    }
  }
  // 차례로 커지는 키는 끝 분할만, 무작위 키는 가운데 분할만 한다
  for (const pool of Object.keys(M.POOLS)) {
    assert.equal(finals[`auto|${pool}`].midSplits, 0);
    assert.equal(finals[`uuid7|${pool}`].midSplits, 0);
    assert.equal(finals[`uuid4|${pool}`].endSplits, 0);
    assert.ok(finals[`uuid4|${pool}`].leaves > finals[`auto|${pool}`].leaves, `${pool}: UUIDv4의 리프가 더 많다`);
  }
  // 표가 버퍼 풀에 다 들어가면(8페이지) 디스크에서 읽지 않는다. 작은 버퍼 풀에서는 UUIDv4만 디스크에서 읽는다.
  for (const pk of Object.keys(M.PK_KEYS)) assert.equal(finals[`${pk}|big`].physical, 0, `${pk} big: 물리적 읽기`);
  assert.equal(finals['auto|small'].physical, 0);
  assert.ok(finals['uuid4|small'].physical > 0);
});

test('락 장면: 합과 락 개수', () => {
  const rowsOf = (u) => M.ROWS.filter((r) => r.user_id === u);
  const sumOf = (u, plus = 0) => rowsOf(u).reduce((a, r) => a + r.amount + plus, 0);
  const lastSum = (v) => { const s = v.sess.B.last; return s && s.startsWith('합 ') ? Number(s.slice(2).replace(/,/g, '')) : null; };
  const leaves = M.tree('PRIMARY').levels[M.tree('PRIMARY').levels.length - 1].length;
  for (const ix of ['none', 'user']) {
    const run = M.simulate('lock', { ix });
    const at = (step) => run.views.find((v) => v.step === step);
    // 4번과 7번은 같은 스냅숏을 읽고, 8번(FOR SHARE)은 A가 커밋한 최신 값을 읽는다
    assert.equal(lastSum(at(4)), sumOf(42), `${ix}: 4번`);
    assert.equal(lastSum(at(7)), sumOf(42), `${ix}: 7번`);
    assert.equal(lastSum(at(8)), sumOf(42, 100), `${ix}: 8번`);
    const aLocks = at(2).locks.filter((l) => l.s === 'A').length;
    if (ix === 'none') {
      // 인덱스가 없으면 A가 PRIMARY의 모든 레코드와 리프마다 supremum을 잠근다
      assert.equal(aLocks, M.ROWS.length + leaves, 'none: A의 락 수');
      assert.ok(at(5).wait, 'none: 5번은 기다린다');
      assert.equal(at(5).wait.blocking, 'A');
      assert.equal(lastSum(at(6)), sumOf(9), 'none: 6번 COMMIT 뒤 5번의 합');
    } else {
      // idx_user가 있으면 고객 42의 항목, 그다음 항목 하나(갭), PRIMARY의 행만 잠근다
      assert.equal(aLocks, 2 * rowsOf(42).length + 1, 'user: A의 락 수');
      assert.ok(run.views.every((v) => !v.wait), 'user: 기다리지 않는다');
      assert.equal(lastSum(at(5)), sumOf(9), 'user: 5번의 합');
    }
  }
});
