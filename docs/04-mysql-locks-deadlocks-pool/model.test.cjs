// 실행 규칙 검사. 실행: node --test model.test.cjs
// 묶음 ①②와 ③의 두 요청 순서표는 실험 원자료(JSONL)의 22개 조건과 모든 문장의 결과·기다림·미룸, 기다리는 동안 읽은 락(data_locks)과
// 기다림(data_lock_waits), 끝난 뒤 행, 데드락 보고가 같은지 본다. 동시 요청 13개 판과 커넥션 풀 다섯 경우는 결과 수와 끝난 뒤 값을 견준다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('./model.js');

const RESULTS = path.join(__dirname, '../../experiments/04-mysql-locks-deadlocks-pool/results');
const jsonl = (name) => fs.readFileSync(path.join(RESULTS, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const LOCKS = jsonl('2026-11-04T170113049668-locks-python-3.14.2.jsonl');
const BURST = jsonl('2026-11-04T170237309105-burst-python-3.14.2.jsonl');
const POOL = jsonl('2026-11-04T164215794556-pool-python-3.14.2.jsonl');
const LEVEL = { 'READ COMMITTED': 'RC', 'REPEATABLE READ': 'RR', SERIALIZABLE: 'SER' };

// 장면마다 고를 수 있는 값과 범위를 모두 곱하고 겹치는 것을 뺀 구성
function configs(scene) {
  let list = [{}];
  for (const [k, vals] of Object.entries(M.CHOICES[scene] || {})) list = list.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  for (const [k, [lo, hi]] of Object.entries(M.RANGES[scene] || {})) {
    const vals = [];
    for (let n = lo; n <= hi; n += 1) vals.push(n);
    list = list.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  }
  const seen = new Map();
  for (const c of list) {
    const n = M.normalizeConfig(scene, c);
    seen.set(JSON.stringify(n), n);
  }
  return [...seen.values()];
}

const RUNS = Object.keys(M.SCENARIOS).flatMap((scene) => configs(scene).map((cfg) => ({ scene, cfg, r: M.simulate(scene, cfg) })));
const tag = (x) => `${x.scene} ${JSON.stringify(x.r.cfg)}`;
const pick = (s) => ({ step: s.step, session: s.session, sql: s.sql, blocked: s.blocked, deferred: s.deferred, sent: s.sent_after_step,
  finished: s.finished_after_step, outcome: s.outcome, rows: s.rows, rowcount: s.rowcount, code: s.error ? String(s.error.code) : null });
const lockKey = (l) => [l.session, l.table, l.index, l.type, l.mode, l.status, l.data].join('|');
const waitKey = (w) => [w.waiting, w.waiting_lock, w.blocking, w.blocking_lock].join('|');
const sorted = (list, f) => list.map(f).sort();
const report = (d) => (d ? { victim: d.rolled_back_session, txns: Object.keys(d.transactions).sort().map((k) => {
  const t = d.transactions[k];
  const part = (h) => ({ index: h.index, mode: h.mode, records: h.records });
  return { session: t.session, holds: t.holds.map(part), waiting: t.waiting.map(part) };
}) } : null);

test('순서표 22개 조건의 모든 문장이 원자료와 같다(결과 행, 행 수, 오류 코드, 기다림, 미룸, 보낸 때, 끝난 때)', () => {
  const conditions = new Set();
  for (const row of LOCKS) {
    if (row.run === 0) continue;
    const key = `${row.timeline} ${row.isolation} ${row.deadlock_detect}`;
    conditions.add(key);
    assert.equal(row.valid, true, key);
    const r = M.runTimeline(row.timeline, LEVEL[row.isolation], row.deadlock_detect);
    assert.deepEqual(r.records.map(pick), row.steps.map(pick), `${key} run ${row.run}`);
  }
  assert.equal(conditions.size, 22);
});

test('기다리는 동안 읽은 data_locks와 data_lock_waits가 그 단계의 모형 상태와 같다(표 락 포함)', () => {
  let snaps = 0;
  for (const row of LOCKS) {
    if (row.run === 0) continue;
    const r = M.runTimeline(row.timeline, LEVEL[row.isolation], row.deadlock_detect);
    for (const s of row.steps) {
      if (!s.locks) continue;
      snaps += 1;
      const v = r.views[s.step];
      const where = `${row.timeline} ${row.isolation} ${row.deadlock_detect} run ${row.run} step ${s.step}`;
      assert.deepEqual(sorted(v.dataLocks, lockKey), sorted(s.locks.locks, lockKey), where);
      assert.deepEqual(sorted(v.waits, waitKey), sorted(s.locks.waits, waitKey), where);
    }
  }
  assert.equal(snaps, 26 * 3);
});

test('끝난 뒤 행과 데드락 보고(되돌린 쪽, 보유한 락, 기다린 락)가 원자료와 같다', () => {
  for (const row of LOCKS) {
    if (row.run === 0) continue;
    const key = `${row.timeline} ${row.isolation} ${row.deadlock_detect} run ${row.run}`;
    const r = M.runTimeline(row.timeline, LEVEL[row.isolation], row.deadlock_detect);
    assert.deepEqual(r.final, row.final_rows, key);
    assert.deepEqual(r.deadlocks.length ? r.deadlocks[0] : null, report(row.deadlock), key);
    assert.ok(r.deadlocks.length <= 1, key);
  }
});

test('순서표 장면은 22개 조건을 모두 한 번씩 그린다', () => {
  const drawn = new Set(RUNS.filter((x) => x.r.kind === 'timeline').map((x) => `${x.r.timeline} ${x.r.level} ${x.r.detect}`));
  const measured = new Set(LOCKS.map((row) => `${row.timeline} ${LEVEL[row.isolation]} ${row.deadlock_detect}`));
  assert.deepEqual([...drawn].sort(), [...measured].sort());
});

const WAY_OF = Object.fromEntries(Object.entries(M.WAYS).map(([k, w]) => [w.scene, k]));
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort());
const burstPick = (s) => ({ results: sortObj(s.results), errors: sortObj(s.errors), retries: s.retries, balance: s.balance, rewards: s.rewards, version: s.version });

test('동시 요청 13개 판(요청 10개)의 결과 수, 오류, 다시 시도 수, 끝난 뒤 값이 원자료와 같다', () => {
  const scenes = new Set();
  for (const row of BURST) {
    if (row.run === 0) continue;
    const key = `${row.scene} ${row.isolation} run ${row.run}`;
    scenes.add(`${row.scene} ${row.isolation}`);
    assert.equal(row.valid, true, key);
    const cfg = row.scene === 'deduct' ? { level: LEVEL[row.isolation], n: row.size } : { way: WAY_OF[row.scene], n: row.size };
    const r = M.simulate(row.scene === 'deduct' ? 'deduct' : 'reward', cfg);
    assert.deepEqual(burstPick(r.summary), burstPick(row.summary), key);
    assert.deepEqual(r.final, row.final_rows, key);
  }
  assert.equal(scenes.size, 13);
});

test('동시 요청은 요청 2~10개 모두 끝나고, 지급 행 수·잔액·차감이 실험의 검사 규칙을 지킨다', () => {
  for (const x of RUNS.filter((y) => y.r.kind === 'burst')) {
    const s = x.r.summary;
    const n = x.r.cfg.n;
    const total = Object.values(s.results).reduce((a, b) => a + b, 0);
    assert.equal(total, n, tag(x));
    assert.ok(x.r.reqs.every((q) => q.result), tag(x));
    if (x.scene === 'reward') {
      assert.equal(s.rewards, (s.results.granted || 0) + (s.results.unpaid || 0), tag(x));
      assert.equal(s.balance, 1000 * (s.results.granted || 0), tag(x));
      assert.ok(s.retries <= 3 * n, tag(x));
    } else {
      // 모두 1000을 읽고 900을 쓰므로 RC·RR은 갱신 손실로 900, SERIALIZABLE은 한 요청만 끝나 900이다.
      assert.equal(s.balance, 900, tag(x));
      assert.equal(s.results.done, x.r.cfg.level === 'SER' ? 1 : n, tag(x));
    }
  }
});

test('막는 방법마다 요청 수와 상관없이 지급이 정해진 대로 나온다', () => {
  const granted = (way, n) => M.simulate('reward', { way, n }).summary.results.granted || 0;
  for (let n = 2; n <= 10; n += 1) {
    for (const way of ['plain', 'lock-after-count', 'version-first']) assert.equal(granted(way, n), n, `${way} ${n}`);
    for (const way of ['count-lock', 'parent-lock', 'version', 'unique', 'count-lock-unique', 'version-const']) assert.equal(granted(way, n), 1, `${way} ${n}`);
    assert.equal(granted('version-const-v3', n), 0, n);
    const cl = M.simulate('reward', { way: 'count-lock', n }).summary;
    assert.equal(cl.errors['1213'], n - 1, `count-lock ${n}`);
    assert.equal(M.simulate('reward', { way: 'unique', n }).summary.errors['1062'], n - 1, `unique ${n}`);
  }
});

// 요청이 끝난 단계: 그 단계 동안 실행했으면 단계 끝 상태, 아니면 그 단계의 상태가 '끝'인 첫 단계
const endStep = (r, id) => r.views.findIndex((v) => { const s = v.th[id]; return (s.cls === 'run' ? s.after.cls : s.cls) === 'done'; });

test('동시 요청: 지급하지 못한 요청이 모두 지급한 요청보다 늦게 끝나는지(그 커밋을 기다렸는지)가 원자료와 같다', () => {
  // 원자료는 요청마다 걸린 시간(elapsed_s)이 있다. 세 번 모두 나머지 요청이 이긴 요청보다 늦게 끝난 판만 "늦게"로 본다.
  const later = new Map();
  for (const row of BURST) {
    if (row.run === 0 || row.scene === 'deduct') continue;
    const win = row.requests.filter((q) => q.result === 'granted');
    const rest = row.requests.filter((q) => q.result !== 'granted');
    if (win.length !== 1 || !rest.length) continue;
    const isLater = rest.every((q) => q.elapsed_s > win[0].elapsed_s);
    later.set(row.scene, (later.get(row.scene) ?? true) && isLater);
  }
  let checked = 0;
  for (const [sceneName, wantLater] of later) {
    const r = M.simulate('reward', { way: WAY_OF[sceneName], n: 10 });
    const win = r.reqs.filter((q) => q.result === 'granted');
    const winEnd = endStep(r, win[0].id);
    const gotLater = r.reqs.filter((q) => q.result !== 'granted').every((q) => endStep(r, q.id) > winEnd);
    assert.equal(gotLater, wantLater, sceneName);
    checked += 1;
  }
  // 이긴 요청이 하나인 판 여섯: count-lock, parent-lock, version-const, version, unique, count-lock-unique.
  // 그중 나머지가 이긴 요청의 커밋 뒤에 끝난 판은 넷이고, 1213으로 끝난 두 판은 먼저 되돌려진다.
  assert.equal(checked, 6);
  assert.deepEqual([...later].filter(([, v]) => v).map(([k]) => k).sort(), ['reward-parent-lock', 'reward-unique', 'reward-version', 'reward-version-const']);
});

test('락 규칙(InnoDB 소스): 충돌 판정이 lock_rec_has_to_wait와 같고, 기다리는 락은 먼저 기다린 락에도 막힌다', () => {
  const L = (trx, mode, type, rec = '7') => ({ trx, mode, type, rec });
  const cases = [
    // [요청, 보유한 락, 기다려야 하는가, 까닭]
    [L('B', 'X', 'NK'), L('B', 'X', 'NK'), false, '같은 트랜잭션'],
    [L('B', 'S', 'NK'), L('A', 'S', 'NK'), false, 'S끼리'],
    [L('B', 'X', 'GAP'), L('A', 'X', 'GAP'), false, '갭 락은 아무것도 기다리지 않는다'],
    [L('B', 'X', 'NK', 'sup'), L('A', 'X', 'NK', 'sup'), false, 'supremum의 락끼리(빈 표의 COUNT ... FOR UPDATE 둘)'],
    [L('B', 'X', 'NK'), L('A', 'X', 'GAP'), false, '레코드를 잠그는 요청은 갭 락을 기다리지 않는다'],
    [L('B', 'X', 'REC'), L('A', 'S', 'GAP'), false, '레코드 락 요청과 갭 락'],
    [L('B', 'X', 'II'), L('A', 'X', 'REC'), false, '삽입 의도 락은 레코드 락을 기다리지 않는다'],
    [L('B', 'X', 'NK'), L('A', 'X', 'II'), false, '삽입 의도 락은 아무것도 막지 않는다'],
    [L('B', 'X', 'II'), L('A', 'X', 'GAP'), true, '삽입 의도 락은 갭 락을 기다린다'],
    [L('B', 'X', 'II'), L('A', 'S', 'NK'), true, '삽입 의도 락은 넥스트 키 락의 갭 부분을 기다린다'],
    [L('B', 'X', 'II', 'sup'), L('A', 'X', 'NK', 'sup'), true, 'supremum에 넣으려면 supremum의 락을 기다린다'],
    [L('B', 'X', 'REC'), L('A', 'S', 'NK'), true, 'X 레코드 락과 S 넥스트 키 락'],
    [L('B', 'S', 'NK'), L('A', 'X', 'REC'), true, 'S 넥스트 키 락과 X 레코드 락(유니크 중복 확인)'],
  ];
  for (const [req, held, want, why] of cases) assert.equal(M.hasToWait(req, held), want, why);
  // 요청 3개가 points 행을 FOR UPDATE로 잠그는 판: 요청 3은 요청 1이 보유한 락과, 먼저 기다린 요청 2의 락에 함께 막힌다.
  const r = M.simulate('reward', { way: 'parent-lock', n: 3 });
  const both = r.views.find((v) => v.waits.some((w) => w.waiting === '3' && w.blocking === '2'));
  assert.ok(both, '요청 3이 요청 2의 기다리는 락에 막히는 단계가 없다');
  assert.ok(both.waits.some((w) => w.waiting === '3' && w.blocking === '1'));
});

test('같은 구성은 언제나 같은 단계 기록을 낸다', () => {
  for (const x of RUNS) assert.equal(JSON.stringify(M.simulate(x.scene, x.cfg)), JSON.stringify(x.r), tag(x));
});

// 같은 레코드에 다른 트랜잭션이 함께 보유할 수 없는 락이 둘 다 GRANTED로 있는지. 갭 쪽 락(GAP, supremum)끼리는 늘 함께 보유할 수 있고,
// 삽입 의도 락(GRANTED로 남은 것)은 아무것도 막지 않는다.
function conflictingGranted(locks) {
  const recLocks = locks.filter((l) => l.type === 'RECORD' && l.status === 'GRANTED' && !/INSERT_INTENTION/.test(l.mode));
  for (const a of recLocks) {
    for (const b of recLocks) {
      if (a === b || a.session === b.session || a.index !== b.index || a.data !== b.data || a.table !== b.table) continue;
      if (a.data === 'supremum pseudo-record' || /GAP/.test(a.mode) || /GAP/.test(b.mode)) continue;
      if (a.mode.startsWith('S') && b.mode.startsWith('S')) continue;
      return `${a.session} ${a.mode} · ${b.session} ${b.mode} on ${a.index} ${a.data}`;
    }
  }
  return null;
}

test('세션 상태는 넷 중 하나이고, 기다리는 세션의 칸과 막는 세션이 있으며, 서로 막는 락을 함께 보유하지 않는다', () => {
  for (const x of RUNS.filter((y) => y.r.kind !== 'pool')) {
    x.r.views.forEach((v, i) => {
      const where = `${tag(x)} step ${v.label}`;
      for (const [id, t] of Object.entries(v.th)) {
        assert.ok(['run', 'turn', 'event', 'done'].includes(t.cls), `${where} ${id}`);
        if (i === 0) assert.equal(t.cls === 'run', false, where);
        if (t.cls === 'run') assert.ok(t.lines.length > 0, `${where} ${id}`);
        else assert.equal(t.lines.length, 0, `${where} ${id}`);
        const waiting = v.dataLocks.filter((l) => l.session === id && l.status === 'WAITING');
        assert.ok(waiting.length <= 1, `${where} ${id}`);
        if (t.waitOn) {
          assert.equal(waiting.length, 1, `${where} ${id}`);
          assert.ok(waiting[0].cells.includes(t.waitOn), `${where} ${id}`);
          assert.ok(t.waitBy.length > 0 && !t.waitBy.includes(id), `${where} ${id}`);
        } else assert.equal(waiting.length, 0, `${where} ${id}`);
      }
      assert.equal(conflictingGranted(v.dataLocks), null, where);
      if (i > 0) assert.ok(v.actors.length > 0 || v.ev.some((e) => ['tail', 'deferred'].includes(e.type)), where);
    });
  }
});

test('관계도 칸: 락과 기다림이 가리키는 칸은 그 단계의 인덱스 레코드나 갭이다', () => {
  for (const x of RUNS.filter((y) => y.r.kind !== 'pool')) {
    for (const v of x.r.views) {
      const cells = new Set();
      for (const t of Object.values(v.obj)) {
        for (const ix of t.indexes) {
          cells.add(`${t.id}/${ix.name}/sup`);
          for (const r of ix.recs) { cells.add(`${t.id}/${ix.name}/${r.data}`); cells.add(`${t.id}/${ix.name}/${r.data}/gap`); }
        }
      }
      for (const l of v.dataLocks) for (const c of l.cells) assert.ok(cells.has(c), `${tag(x)} step ${v.label} ${c}`);
      for (const c of v.cycle || []) assert.ok(cells.has(c.to), `${tag(x)} step ${v.label} cycle ${c.to}`);
    }
  }
});

test('데드락: 탐지를 켜면 고리를 닫은 쪽이 1213을 받고, 끄면 고리가 남다가 1205로 문장만 되돌린다', () => {
  const on = M.simulate('transfer', { order: 'reverse', detect: 'ON' });
  assert.ok(on.views.some((v) => v.cycleDetected && v.cycle.length === 2));
  assert.equal(on.deadlocks[0].victim, 'B');
  const off = M.simulate('transfer', { order: 'reverse', detect: 'OFF' });
  assert.ok(off.views.filter((v) => v.cycle && !v.cycleDetected).length >= 3);
  assert.equal(off.deadlocks.length, 0);
  assert.deepEqual(off.views.filter((v) => v.tail).map((v) => v.label), ['끝1', '끝2']);
  const after = off.views.find((v) => v.label === '끝1');
  assert.ok(after.dataLocks.some((l) => l.session === 'A' && l.status === 'GRANTED' && l.data === '1'), '1205 뒤에도 A가 id 1의 락을 보유한다');
  for (const order of ['reverse', 'ordered']) {
    for (const detect of ['ON', 'OFF']) {
      const r = M.simulate('transfer', { order, detect });
      const sum = r.final.reduce((s, row) => s + row[1], 0);
      assert.equal(sum, order === 'reverse' && detect === 'OFF' ? 1900 : 2000, `${order} ${detect}`);
    }
  }
  const pair = M.simulate('pair', {});
  assert.equal(pair.deadlocks[0].victim, 'B');
});

const poolSummary = (row) => (typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary);

test('커넥션 풀: 성공·타임아웃 수가 원자료와 같고, 잰 시간은 모형의 차례 수 × 0.2초보다 차례마다 25ms 안에서 길다', () => {
  const RAW = Object.fromEntries(Object.entries(M.POOL_CASES).map(([k, c]) => [c.raw, k]));
  let n = 0;
  for (const row of POOL) {
    if (row.run === 0 || !RAW[row.case]) continue;
    n += 1;
    const key = `${row.case} run ${row.run}`;
    const sum = poolSummary(row);
    const r = M.simulate('pool', { pool: RAW[row.case] }).summary;
    assert.equal(r.ok, sum.ok, key);
    assert.equal(r.timeout, sum.timeout, key);
    if (row.case === 'null') continue;
    const turns = r.endMs / M.HOLD_MS;
    assert.ok(row.wall_s * 1000 > r.endMs && row.wall_s * 1000 - r.endMs < 25 * turns, `${key} wall ${row.wall_s}`);
    const waitTurns = r.waitMaxMs / M.HOLD_MS;
    const measuredWait = sum.wait_s.max * 1000;
    if (waitTurns) assert.ok(measuredWait > r.waitMaxMs && measuredWait - r.waitMaxMs < 25 * waitTurns, `${key} wait ${measuredWait}`);
    else assert.ok(measuredWait < 1, key);
  }
  assert.equal(n, 15);
});

test('커넥션 풀: 빌린 연결 수는 풀 크기를 넘지 않고, 요청은 모두 끝나거나 타임아웃으로 끝난다', () => {
  for (const x of RUNS.filter((y) => y.r.kind === 'pool')) {
    const C = M.POOL_CASES[x.r.cfg.pool];
    for (const v of x.r.views) {
      const using = v.reqs.filter((q) => q.state === 'use').length;
      if (C.pool === 'queue') {
        assert.ok(using <= C.size, tag(x));
        assert.equal(v.slots.filter((s) => s.holder).length, using, tag(x));
      }
    }
    const last = x.r.views[x.r.views.length - 1];
    assert.ok(last.reqs.every((q) => q.state === 'done' || q.state === 'timeout'), tag(x));
  }
});
