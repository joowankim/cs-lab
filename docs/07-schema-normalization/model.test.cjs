'use strict';
// 정규화 관계도의 점검. 이 폴더에서 node --test model.test.cjs 로 돌린다(Node.js 18 이상, 따로 설치할 것 없음).
// 1. 원자료의 모든 기록이 검증을 통과했다.
// 2. 장면 1의 표가 실험 SQL의 행과 같고, 이상·되살리기의 결과가 실험 README의 묶음 ② 결과와 같다.
// 3. 장면 2의 고친 행 수 규칙이 원자료의 check와 같고, 계획 문구가 원자료 EXPLAIN과 같다.
// 4. 장면 3의 A·B 락이 원자료 data_locks와 같다.
// 5. "실험에서 잰 값" 칸의 숫자가 원자료에서 다시 계산한 값과 같다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const M = require('./model.js');
const C = require('./content.js');

const EXP = path.join(__dirname, '..', '..', 'experiments', '07-schema-normalization');
const RES = path.join(EXP, 'results');
const jsonl = (f) => fs.readFileSync(path.join(RES, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const json = (f) => JSON.parse(fs.readFileSync(path.join(RES, f), 'utf8'));
const NORM = jsonl('2026-11-20T210942023292-norm-python-3.14.2.jsonl');
const COV = jsonl('2026-11-20T212601895675-norm-cov-python-3.14.2.jsonl');
const FK = jsonl('2026-11-20T214449560144-fk-python-3.14.2.jsonl');
const NORM_EXPLAIN = json('2026-11-20T210942023292-norm-explain.json');
const COV_EXPLAIN = json('2026-11-20T212601895675-norm-cov-explain.json');
const LOCKS = json('2026-11-20T214503524808-fk-locks.json');
const README = fs.readFileSync(path.join(EXP, 'README.md'), 'utf8');

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[(s.length - 1) / 2]; };
const runs = (raw, task, variant) => raw.filter((r) => r.task === task && r.variant === variant && r.run > 0);
const ms3 = (raw, task, variant) => {
  const v = runs(raw, task, variant).map((r) => r.wall_s * 1000);
  assert.equal(v.length, 3, `${task} ${variant}`);
  return `${median(v).toFixed(3)} [${Math.min(...v).toFixed(3)}~${Math.max(...v).toFixed(3)}]ms`;
};
const measuredText = (scene) => C.SCENES[scene].measured.join('\n');

test('원자료는 모두 검증을 통과했다', () => {
  for (const raw of [NORM, COV, FK]) {
    assert.ok(raw.length > 0);
    for (const r of raw) assert.equal(r.valid, true, `${r.run_id} ${r.task} ${r.variant} run ${r.run}`);
  }
});

test('장면 1의 표가 실험 SQL의 행과 같다', () => {
  const sql1 = fs.readFileSync(path.join(EXP, 'sql', '01-flat-anomalies.sql'), 'utf8');
  for (const r of M.FLAT) assert.ok(sql1.includes(`(${r.id}, '${r.email}', '${r.name}', '${r.plan}', '${r.number}', '${r.type}', ${r.fee}, '${r.at}')`), `flat ${r.id}`);
  const sql2 = fs.readFileSync(path.join(EXP, 'sql', '02-normalized-restore.sql'), 'utf8');
  for (const m of M.MEMBERS) assert.ok(sql2.includes(`(${m.id}, '${m.email}', '${m.name}', '${m.plan}')`), `member ${m.id}`);
  for (const c of M.CARS) assert.ok(sql2.includes(`(${c.id}, '${c.number}', '${c.type}', ${c.fee})`), `car ${c.id}`);
  for (const r of M.RESERVATIONS) assert.ok(sql2.includes(`(${r.id}, ${r.member_id}, ${r.car_id}, '${r.at}')`), `reservation ${r.id}`);
  assert.ok(sql1.includes(`'${M.NEW_CAR.number}', '${M.NEW_CAR.type}', ${M.NEW_CAR.fee}`));
});

test('장면 1의 결과가 묶음 ② 결과와 같다', () => {
  // (A) kim이 일반·골드 두 줄
  const a = M.simulate('anomaly', { op: 'update', schema: 'flat' }).result.map((r) => r.plan).sort();
  assert.deepEqual(a, ['골드', '일반'].sort());
  assert.ok(README.includes('kim이 `일반`·`골드` 두 줄'));
  // (B) 두 오류와 0행
  const b = M.simulate('anomaly', { op: 'insert', schema: 'flat' });
  assert.equal(b.result, 0);
  for (const e of b.steps.filter((s) => s.error)) assert.ok(README.includes(e.error), e.error);
  assert.deepEqual(b.steps.filter((s) => s.error).map((s) => s.error.slice(0, 10)), ['ERROR 1048', 'ERROR 1364']);
  // (C) 0행
  assert.equal(M.simulate('anomaly', { op: 'delete', schema: 'flat' }).result, 0);
  assert.ok(README.includes('34나5678 행 0개'));
  // 되살리기 3행, EXCEPT 0·0, 새 차를 넣어도 3행
  const d = M.simulate('anomaly', { op: 'split', schema: 'split' }).result;
  assert.equal(d.rows.length, 3);
  assert.equal(d.restoredMinusOriginal, 0);
  assert.equal(d.originalMinusRestored, 0);
  assert.equal(M.simulate('anomaly', { op: 'insert', schema: 'split' }).result, 3);
  assert.ok(README.includes('`EXCEPT` 차이 0행·0행'));
  // 나누기: 결정자마다 표. 나눈 표가 02 SQL의 표와 같다.
  const s = M.simulate('anomaly', { op: 'split', schema: 'flat' }).result;
  assert.deepEqual(s.members, M.MEMBERS);
  assert.deepEqual(s.cars, M.CARS);
  assert.deepEqual(s.reservations, M.RESERVATIONS);
  // 맥에서 돌린 구성 표시
  assert.equal(M.simulate('anomaly', { op: 'update', schema: 'split' }).ran, false);
  assert.equal(M.simulate('anomaly', { op: 'update', schema: 'flat' }).ran, true);
});

test('장면 2: 앞 단계의 그림은 뒤 단계의 변경에 영향받지 않는다', () => {
  const u = M.simulate('denorm', { query: 'u1', design: 'denorm' });
  const plans = u.steps.map((st) => st.tables.find((t) => t.id === 'res').rows.filter((r) => r.vals.member_id === 1 && r.vals.plan === '골드').length);
  assert.deepEqual(plans, [0, 1, 2, 3, 4, 5]);
});

test('장면 2: 고친 행 수의 규칙이 원자료의 check와 같다', () => {
  const p = NORM[0].params;
  const heavy = p.heavy_member_reservations;
  const perOther = (p.reservations - heavy) / 99000; // 회원 2~99001은 10건씩(실험 README)
  assert.equal(perOther, 10);
  for (const raw of [NORM, COV]) {
    for (const r of raw.filter((x) => x.task.startsWith('u') && x.run > 0)) {
      const design = r.variant === 'norm' ? 'norm' : 'denorm';
      const n = r.task === 'u1' ? heavy : perOther;
      assert.equal(r.check, M.rowsChanged(design, n), `${r.task} ${r.variant}`);
    }
  }
  // 모형도 같은 규칙
  const per = (id) => M.DN_RES.filter((r) => r.member_id === id).length;
  for (const design of ['norm', 'denorm', 'cov']) {
    assert.equal(M.simulate('denorm', { query: 'u1', design }).result, M.rowsChanged(design === 'norm' ? 'norm' : 'denorm', per(1)));
    assert.equal(M.simulate('denorm', { query: 'u2', design }).result, M.rowsChanged(design === 'norm' ? 'norm' : 'denorm', per(2)));
  }
  assert.equal(M.simulate('denorm', { query: 'u1', design: 'cov' }).tally.moved, per(1));
});

test('장면 2: 읽기 결과와 계획 모양', () => {
  const gold = M.DN_MEMBERS.filter((m) => m.plan === '골드').map((m) => m.id);
  const expected = M.DN_RES.filter((r) => gold.includes(r.member_id)).length;
  for (const design of ['norm', 'denorm', 'cov']) assert.equal(M.simulate('denorm', { query: 'q2', design }).result, expected);
  const q1 = ['norm', 'denorm', 'cov'].map((design) => M.simulate('denorm', { query: 'q1', design }));
  for (const s of q1) assert.deepEqual(s.result.map((r) => r.id), q1[0].result.map((r) => r.id));
  assert.equal(q1[0].tally.back, 0);
  assert.equal(q1[1].tally.back, M.Q1_LIMIT);
  assert.equal(q1[2].tally.back, 0);
  // 원자료의 EXPLAIN FORMAT=TREE
  assert.match(NORM_EXPLAIN['q1-norm'].tree_0, /Covering index lookup on r using idx_member \(member_id=1\) \(reverse\)/);
  assert.match(NORM_EXPLAIN['q1-denorm'].tree_0, /-> Index lookup on reservations_d using idx_member \(member_id=1\) \(reverse\)/);
  assert.match(COV_EXPLAIN['q1-denorm_cov'].tree_0, /Covering index lookup on reservations_d using idx_member_cov/);
  assert.match(NORM_EXPLAIN['q2-norm'].tree_0, /Filter: \(m\.plan = '골드'\)[\s\S]*Table scan on m/);
  assert.match(NORM_EXPLAIN['q2-norm'].tree_0, /Covering index lookup on r using idx_member \(member_id=m\.id\)/);
  assert.match(NORM_EXPLAIN['q2-denorm'].tree_0, /Table scan on reservations_d/);
  assert.match(COV_EXPLAIN['q2-denorm_cov'].tree_0, /Covering index scan on reservations_d using idx_member_cov/);
  assert.ok(M.DN_PLAN['q1/denorm'].includes('커버링 아님'));
  assert.ok(M.DN_PLAN['q2/cov'].startsWith('Covering index scan on reservations_d using idx_member_cov'));
});

test('장면 3: A·B의 락이 원자료 data_locks와 같다', () => {
  const raw = (list) => list.map((l) => M.lockKey({ object: l.OBJECT_NAME, type: l.LOCK_TYPE, mode: l.LOCK_MODE, data: l.LOCK_DATA, status: l.LOCK_STATUS })).sort();
  const fk = M.simulate('fk', { mode: 'fk', end: 'timeout' });
  const beforeB = fk.steps[2].locks.filter((l) => l.who === 'A');
  assert.deepEqual(beforeB.map(M.lockKey).sort(), raw(LOCKS.res_fk.locks_held_before_update));
  const waiting = fk.steps[3].locks.filter((l) => l.who === 'B');
  assert.deepEqual(waiting.map(M.lockKey).sort(), raw(LOCKS.res_fk.waiting_during_update));
  assert.equal(LOCKS.res_fk.error[0], 1205);
  assert.ok(fk.steps.at(-1).error.startsWith('ERROR 1205'));
  const nofk = M.simulate('fk', { mode: 'nofk', end: 'timeout' });
  assert.deepEqual(nofk.steps[0].locks.filter((l) => l.who === 'A').map(M.lockKey).sort(), raw(LOCKS.res_nofk.locks_held_before_update));
  assert.equal(LOCKS.res_nofk.rows_affected, 1);
  assert.equal(nofk.result.members[0].plan, '골드');
  assert.equal(nofk.result.bWaited, false);
});

test('"실험에서 잰 값" 칸의 숫자가 원자료와 같다', () => {
  const text = measuredText('denorm');
  const Q = { q1: 'Q1', q2: 'Q2', u1: 'U1', u2: 'U2' };
  for (const task of Object.keys(Q)) {
    assert.ok(text.includes(`${Q[task]} 정규화 ${ms3(NORM, task, 'norm')} · 비정규화 ${ms3(NORM, task, 'denorm')}`), `${task} 첫 측정`);
    assert.ok(text.includes(`재측정 ${Q[task]} 정규화 ${ms3(COV, task, 'norm')} · 비정규화 + 새 인덱스 ${ms3(COV, task, 'denorm_cov')}`), `${task} 재측정`);
  }
  const u1 = runs(NORM, 'u1', 'denorm')[0].check.toLocaleString('en-US');
  assert.ok(text.includes(`고친 행 1 / ${u1}`));
  assert.ok(text.includes(`고친 행 1 / ${runs(NORM, 'u2', 'denorm')[0].check}`));

  const fk = measuredText('fk');
  const sec = (variant) => {
    const v = runs(FK, 'insert', variant).map((r) => r.wall_s);
    const rps = Math.round(median(runs(FK, 'insert', variant).map((r) => r.rows_per_s))).toLocaleString('en-US');
    return `${median(v).toFixed(3)} [${Math.min(...v).toFixed(3)}~${Math.max(...v).toFixed(3)}]초(초당 ${rps}행)`;
  };
  assert.ok(fk.includes(`외래 키 있음 ${sec('res_fk')}`), sec('res_fk'));
  assert.ok(fk.includes(`없음 ${sec('res_nofk')}`), sec('res_nofk'));
  const ratio = median(runs(FK, 'insert', 'res_fk').map((r) => r.wall_s)) / median(runs(FK, 'insert', 'res_nofk').map((r) => r.wall_s));
  assert.ok(fk.includes(`약 ${Math.round((ratio - 1) * 100)}% 느림`), String(ratio));
  assert.ok(fk.includes(`${LOCKS.res_fk.waited_s.toFixed(3)}초 뒤 ERROR 1205`));
  assert.ok(fk.includes(`B는 ${LOCKS.res_nofk.waited_s.toPrecision(3)}초에 1행`));
});
