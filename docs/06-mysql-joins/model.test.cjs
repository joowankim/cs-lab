'use strict';
// 조인 관계도의 점검. 이 폴더에서 node --test model.test.cjs 로 돌린다(Node.js 18 이상, 따로 설치할 것 없음).
// 1. 모형의 작은 표와 장면 1·2의 결과가 맥 본 측정(2026-11-17)의 묶음 ① 결과 행과 같다.
// 2. 장면 3의 읽은 수·비교 수가 셈 규칙과 같고, 실험의 계획 모양(드라이빙·드리븐)과 같다.
// 3. 장면 4의 쿼리 수가 원자료 묶음 ③의 쿼리 수 규칙과 같다.
// 4. "실험에서 잰 값" 칸의 숫자가 원자료에서 다시 계산한 값과 같다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const M = require('./model.js');
const C = require('./content.js');

const RESULTS = path.join(__dirname, '..', '..', 'experiments', '06-mysql-joins', 'results', '2026-11-17T164211743263-join-python-3.14.2.jsonl');
const RAW = fs.readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const measured = (part, variant, size) => RAW.filter((r) => r.part === part && r.variant === variant && r.run > 0 && (size === undefined || r.size === size));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[(s.length - 1) / 2]; };
const sortRows = (rows) => rows.map((r) => JSON.stringify(r)).sort();

test('원자료는 모두 검증을 통과했다', () => {
  assert.ok(RAW.length > 0);
  for (const r of RAW) assert.equal(r.valid, true, `${r.part} ${r.variant} run ${r.run}`);
});

const LEFT_TO_RAW = { inner: '1-ga-inner', left: '1-na-left', 'left-where': '1-da-left-where', 'left-on': '1-ra-left-on' };
test('장면 1의 결과가 원자료 묶음 ①의 결과 행과 같다', () => {
  for (const [way, variant] of Object.entries(LEFT_TO_RAW)) {
    const sim = M.simulate('left', { way });
    const got = sim.result.map((r) => [r.u, r.o]);
    for (const r of measured('results', variant)) assert.deepEqual(sortRows(got), sortRows(r.result), way);
  }
});

const SEMI_TO_RAW = { in: '1-1-D-in', exists: '1-1-E-exists', join: '1-1-F-join', 'not-exists': '1-1-B-not-exists', 'not-in': '1-1-C-not-in' };
test('장면 2의 결과가 원자료 묶음 ①의 결과 행과 같다', () => {
  for (const [way, variant] of Object.entries(SEMI_TO_RAW)) {
    const sim = M.simulate('semi', { way });
    const got = sim.result.map((r) => [r.u]);
    for (const r of measured('results', variant)) assert.deepEqual(sortRows(got), sortRows(r.result), way);
  }
  assert.deepEqual(M.simulate('semi', { way: 'not-in-fixed' }).result.map((r) => r.u), [4, 5]);
});

test('장면 1의 RIGHT·FULL은 손으로 센 결과와 같다', () => {
  assert.deepEqual(M.simulate('left', { way: 'right' }).result.map((r) => [r.u, r.o]), [[1, 1], [1, 2], [2, 3], [3, 4], [null, 5]]);
  assert.deepEqual(sortRows(M.simulate('left', { way: 'full' }).result.map((r) => [r.u, r.o])),
    sortRows([[1, 1], [1, 2], [2, 3], [3, 4], [4, null], [5, null], [null, 5]]));
});

test('3값 논리: NOT IN 목록에 NULL이 있으면 UNKNOWN', () => {
  assert.equal(M.eq(4, null), null);
  assert.equal(M.and(true, null), null);
  assert.equal(M.and(false, null), false);
  const st = M.simulate('semi', { way: 'not-in' }).steps.find((s) => s.cur === 4);
  assert.equal(st.value, null);
});

test('장면 3: 읽은 수와 비교 수, 계획 모양', () => {
  const nU = M.ALGO_USERS.length, nO = M.ALGO_ORDERS.length;
  // 코드는 양쪽 다 순열이라 짝은 정확히 하나씩
  assert.deepEqual([...M.ALGO_USERS.map((u) => u.code)].sort(), [...M.ALGO_ORDERS.map((o) => o.user_code)].sort());
  const scan = M.simulate('algo', { way: 'nl-scan', scope: 'all' });
  assert.equal(scan.tally.compares, nU * nO);
  assert.equal(scan.result, nO);
  const idx = M.simulate('algo', { way: 'nl-index', scope: 'all' });
  assert.equal(idx.tally.pages, nO * M.IDX_CODE_LEVELS);
  assert.equal(idx.steps.length, nO);
  const hash = M.simulate('algo', { way: 'hash', scope: 'all' });
  assert.equal(hash.tally.builds + hash.tally.probes, nU + nO);
  const fewIdx = M.simulate('algo', { way: 'nl-index', scope: 'few' });
  const fewHash = M.simulate('algo', { way: 'hash', scope: 'few' });
  assert.equal(fewIdx.steps.length, 2);
  assert.equal(fewHash.tally.probes, nU, '해시 조인은 주문이 적어도 프로브 쪽을 끝까지 읽는다');
  // 실험 계획의 모양: (나) 드라이빙 users·안쪽 Table scan on o, (다) 드라이빙 orders·idx_code로 users를 찾음
  const na = measured('algo', '2-na-no-index-no-bnl')[0].analyze_text;
  assert.match(na, /Table scan on u[\s\S]*Table scan on o .*loops=10000/);
  const da = measured('algo', '2-da-index')[0].analyze_text;
  assert.match(da, /Table scan on o[\s\S]*index lookup on u using idx_code.*loops=10000/);
  const ga = measured('algo', '2-ga-no-index')[0].analyze_text;
  assert.match(ga, /Inner hash join[\s\S]*Hash\n\s*-> Table scan on u/);
  assert.equal(hash.steps[0].buildSide, 'u');
  const sh = measured('algo', '2-da-small-hash')[0].analyze_text;
  assert.match(sh, /Table scan on u[\s\S]*Hash\n[\s\S]*Index range scan on o/);
  assert.equal(fewHash.steps[0].buildSide, 'o');
});

test('장면 4: 쿼리 수가 원자료 묶음 ③과 같은 규칙', () => {
  for (const way of Object.keys(M.N1_WAYS)) {
    for (const size of [10, 100, 1000]) {
      for (const r of measured('n1', way, size)) assert.equal(r.queries, M.expectedQueries(way, size), `${way} n=${size}`);
    }
    for (const n of M.N1_SIZES) {
      const sim = M.simulate('n1', { way, n: String(n), rtt: 'local' });
      assert.equal(sim.queries, M.expectedQueries(way, n));
      assert.equal(sim.steps.at(-1).queries, sim.queries);
    }
  }
});

function fmt(ms) {
  if (ms < 1) return ms.toFixed(3);
  if (ms < 100) return ms.toPrecision(3);
  return String(Math.round(ms));
}
test('"실험에서 잰 값" 칸의 숫자가 원자료의 중앙값과 같다', () => {
  const text = Object.values(C.SCENES).map((s) => s.measured.join('\n')).join('\n');
  const wall = (part, variant, size) => fmt(median(measured(part, variant, size).map((r) => r.wall_s * 1000)));
  const n1 = (variant) => [10, 100, 1000].map((n) => wall('n1', variant, n)).join(' / ');
  assert.ok(text.includes(`N+1 ${n1('n-plus-1')}ms`), n1('n-plus-1'));
  assert.ok(text.includes(`JOIN 한 번 ${n1('join')}ms`), n1('join'));
  assert.ok(text.includes(`IN 두 번 ${n1('in-list')}ms`), n1('in-list'));
  assert.ok(text.includes(`IN 서브쿼리 한 번 ${n1('in-subquery')}ms`), n1('in-subquery'));
  assert.ok(text.includes(`해시 조인 ${wall('algo', '2-ga-no-index')}ms`));
  assert.ok(text.includes(`idx_code 중첩 루프 ${wall('algo', '2-da-index')}ms`));
  const nb = median(measured('algo', '2-na-no-index-no-bnl').map((r) => r.wall_s));
  assert.ok(text.includes(`NO_BNL 중첩 루프 ${nb.toFixed(2)}초`), nb.toFixed(2));
  assert.ok(text.includes(`인덱스 중첩 루프 ${wall('algo', '2-da-small-index')}ms`));
  assert.ok(text.includes(`해시 조인 ${wall('algo', '2-da-small-hash')}ms`));
  const rtt = measured('n1', 'select-1').map((r) => r.wall_s * 1000);
  assert.ok(text.includes(`SELECT 1 왕복 ${fmt(median(rtt))}ms`), fmt(median(rtt)));
});
