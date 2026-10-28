// 실행 규칙 검사. 실행: node --test model.test.cjs
// 묶음 1·3의 순서표는 실험 원자료(JSONL)의 41개 조건과 모든 문장의 결과·기다림·미룸이 같은지 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('./model.js');

const RESULTS = path.join(__dirname, '../../experiments/03-mysql-isolation-mvcc/results');
const jsonl = (name) => fs.readFileSync(path.join(RESULTS, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const ISOLATION = jsonl('2026-10-28T220156065912-isolation-python-3.14.2.jsonl');
const HISTORY = jsonl('2026-10-28T220300298631-history-python-3.14.2.jsonl');
const DURABILITY = jsonl('2026-10-28T221519136661-durability-python-3.14.2.jsonl');
const LEVEL = { 'READ UNCOMMITTED': 'RU', 'READ COMMITTED': 'RC', 'REPEATABLE READ': 'RR', SERIALIZABLE: 'SER' };

// 장면마다 고를 수 있는 값과 범위를 모두 곱하고, 실험에서 돌리지 않은 조합을 바꾼 뒤 겹치는 것을 뺀 구성
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
  finished: s.finished_after_step, outcome: s.outcome, rows: s.rows, code: s.error ? String(s.error.code) : null });

test('묶음 1·3: 41개 조건의 모든 문장이 원자료와 같다(결과 행, 오류 코드, 기다림, 미룸, 보낸 때, 끝난 때)', () => {
  const conditions = new Set();
  for (const row of ISOLATION) {
    if (row.run === 0) continue;
    const key = `${row.timeline} ${row.db} ${row.isolation}`;
    conditions.add(key);
    assert.equal(row.valid, true, key);
    assert.deepEqual(M.runTimeline(row.timeline, row.db, LEVEL[row.isolation]).map(pick), row.steps.map(pick), `${key} run ${row.run}`);
  }
  assert.equal(conditions.size, 41);
});

test('묶음 1·3의 장면은 41개 조건을 모두 한 번씩 그린다', () => {
  const drawn = new Set(RUNS.filter((x) => x.r.timeline).map((x) => `${x.r.timeline} ${x.r.cfg.db || 'mysql'} ${x.r.cfg.level || 'RR'}`));
  const measured = new Set(ISOLATION.map((row) => `${row.timeline} ${row.db} ${LEVEL[row.isolation]}`));
  assert.deepEqual([...drawn].sort(), [...measured].sort());
});

test('같은 구성은 언제나 같은 단계 기록을 낸다', () => {
  for (const x of RUNS) assert.equal(JSON.stringify(M.simulate(x.scene, x.cfg)), JSON.stringify(x.r), tag(x));
});

test('세션 상태는 넷 중 하나이고, 기다리는 세션의 락은 다른 세션이 쥐고 있다', () => {
  const conflict = (a, b) => (a === 'X' || b === 'X' ? true : a === 'W' || b === 'W');
  for (const x of RUNS) {
    x.r.views.forEach((v, i) => {
      const where = `${tag(x)} step ${v.label}`;
      for (const [id, t] of Object.entries(v.th)) {
        assert.ok(['run', 'turn', 'event', 'done'].includes(t.cls), `${where} ${id}`);
        if (i === 0) assert.equal(t.cls === 'run', false, where);
        if (t.cls === 'run') assert.ok(t.lines.length > 0, `${where} ${id}`);
        else assert.equal(t.lines.length, 0, `${where} ${id}`);
        if (t.waitOn && x.r.timeline) assert.ok(v.locks.some((l) => l.res === t.waitOn && l.sess === t.waitBy && l.sess !== id), `${where} ${id}`);
      }
      // 같은 행에 서로 막는 락을 두 세션이 함께 쥐지 않는다.
      for (const a of v.locks) {
        for (const b of v.locks) {
          if (a === b || a.res !== b.res || a.sess === b.sess) continue;
          if (a.mode.startsWith('G') || b.mode.startsWith('G')) continue;
          assert.equal(conflict(a.mode, b.mode), false, `${where} ${a.res}`);
        }
      }
      // 문장을 미룬 단계(그 세션은 앞 문장을 기다리는 중)와 장애 단계에는 실행한 세션이 없다.
      if (i > 0) assert.ok(v.actors.length > 0 || v.ev.some((e) => ['tail', 'deferred', 'crash'].includes(e.type)), where);
    });
  }
});

test('문제 이벤트: dirty read, 바뀐 읽기, 갱신 손실, 오류, MyISAM 경고가 나오는 조건', () => {
  const bad = (scene, cfg, type) => M.simulate(scene, cfg).views.some((v) => v.ev.some((e) => e.bad && e.type === type));
  assert.ok(bad('report', { db: 'mysql', level: 'RU' }, 'dirty'));
  assert.ok(!bad('report', { db: 'postgres', level: 'RU' }, 'dirty'));
  assert.ok(bad('report', { db: 'mysql', level: 'RC' }, 'changed'));
  assert.ok(!bad('report', { db: 'mysql', level: 'RR' }, 'changed'));
  assert.ok(bad('count', { tl: 'snap', db: 'mysql', level: 'RR' }, 'changed'));
  for (const level of ['RU', 'RC', 'RR']) assert.ok(bad('deduct', { db: 'mysql', level }, 'lost'), level);
  for (const level of ['RU', 'RC']) assert.ok(bad('deduct', { db: 'postgres', level }, 'lost'), level);
  for (const level of ['RR', 'SER']) assert.ok(!bad('deduct', { db: 'postgres', level }, 'lost') && bad('deduct', { db: 'postgres', level }, 'error'), level);
  assert.ok(bad('deduct', { db: 'mysql', level: 'SER' }, 'error') && !bad('deduct', { db: 'mysql', level: 'SER' }, 'lost'));
  assert.ok(M.simulate('deduct', { db: 'mysql', level: 'SER' }).views.some((v) => v.cycle && v.cycle.length === 2));
  assert.ok(bad('engine', { tl: 'rollback' }, 'warning'));
});

test('묶음 2: 이전 버전이 남는 경우와 읽은 값이 원자료와 같다', () => {
  for (const row of HISTORY) {
    if (row.run === 0) continue;
    const r = M.simulate('hold', { db: row.db, hold: row.hold }).result;
    const N = r.updates;
    const key = `${row.db} ${row.hold} run ${row.run}`;
    const measuredKept = row.db === 'mysql' ? row.after_updates.history_list_length : row.after_updates.vacuum.dead_not_removable;
    // 실험은 1만 번. 거의 다 남았는지(9,000 이상), 거의 지웠는지(1,000 미만)로 견준다.
    assert.ok(measuredKept >= 9000 || measuredKept < 1000, key);
    assert.equal(r.afterUpdates === N, measuredKept >= 9000, key);
    if (measuredKept < 1000) assert.ok(r.afterUpdates <= 1, key);
    assert.equal(r.aRead === 1000, row.reads.holder.values[0] === 1000, key);
    assert.equal(r.cRead, 1000 + N, key);
    assert.deepEqual(row.reads.fresh.values, [11000], key);
    if (row.db === 'postgres') {
      assert.equal(r.afterClose.removed === N, row.after_close.vacuum.removed === 10000, key);
      assert.equal(r.afterClose.notRemovable, 0, key);
      assert.equal(row.after_close.vacuum.dead_not_removable, 0, key);
    } else assert.equal(r.afterClose, 0, key);
  }
});

test('묶음 2: 오래된 스냅숏으로 읽는 MySQL은 남은 이전 버전을 모두 되짚는다', () => {
  for (const hold of ['rr-read', 'rr-read-other']) {
    for (let updates = 2; updates <= 6; updates += 1) {
      const r = M.simulate('hold', { db: 'mysql', hold, updates }).result;
      assert.equal(r.aHops, updates, `${hold} ${updates}`);
      assert.equal(r.cHops, 0, `${hold} ${updates}`);
    }
  }
});

test('묶음 4: 커밋마다 기다리는 fsync 수와, 그 수가 적은 설정의 처리량이 기본값보다 큰 것', () => {
  const waits = { f1b1: 2, f2b1: 1, f1b0: 1, f2b0: 0, on: 1, off: 0 };
  for (const [setting, n] of Object.entries(waits)) {
    const r = M.simulate('commit', { db: M.SETTINGS[setting].db, setting }).result;
    assert.equal(r.waitsPerCommit, n, setting);
  }
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const rate = (name) => median(DURABILITY.filter((r) => r.run > 0 && r.setting === name).map((r) => r.inserts_per_s));
  const NAME = { f1b1: 'flush1-binlog1', f2b1: 'flush2-binlog1', f1b0: 'flush1-binlog0', f2b0: 'flush2-binlog0', on: 'sync-on', off: 'sync-off' };
  for (const s of ['f2b1', 'f1b0', 'f2b0']) assert.ok(rate(NAME[s]) > rate(NAME.f1b1), s);
  assert.ok(rate(NAME.f2b0) > rate(NAME.f1b0) && rate(NAME.f1b0) > rate(NAME.f2b1));
  assert.ok(rate(NAME.off) > rate(NAME.on));
});

test('묶음 4: 장애가 나면 fsync를 기다리지 않은 로그의 기록만 잃는다', () => {
  for (const x of RUNS.filter((y) => y.scene === 'commit')) {
    const set = M.SETTINGS[x.r.cfg.setting];
    const lost = x.r.result.lost;
    const crash = x.r.cfg.crash;
    if (x.r.cfg.db === 'mysql') {
      assert.equal(lost.redo.length > 0, set.flush === 2 && crash === 'os', tag(x));
      assert.equal(lost.binlog.length > 0, set.binlog === 0 && crash === 'os', tag(x));
    } else assert.equal(lost.wal.length > 0, !set.sync && crash !== 'none', tag(x));
    for (const v of Object.values(lost)) for (const c of v) assert.ok(x.r.result.acked.includes(c), tag(x));
  }
});
