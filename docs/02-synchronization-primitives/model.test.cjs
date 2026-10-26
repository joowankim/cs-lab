// 실행 규칙 검사. 실행: node --test model.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model.js');

// 장면마다 고를 수 있는 값과 범위를 모두 곱한 구성
function configs(scene) {
  let list = [{}];
  for (const [k, vals] of Object.entries(M.CHOICES[scene] || {})) list = list.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  for (const [k, [lo, hi]] of Object.entries(M.RANGES[scene] || {})) {
    const vals = [];
    for (let n = lo; n <= hi; n += 1) vals.push(n);
    list = list.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  }
  return list;
}

const RUNS = Object.keys(M.SCENARIOS).flatMap((scene) => configs(scene).map((cfg) => ({ scene, cfg, r: M.simulate(scene, cfg) })));
const run = (scene, cfg) => M.simulate(scene, cfg);
const tag = (x) => `${x.scene} ${JSON.stringify(x.r.cfg)}`;
const objs = (v, type) => Object.values(v.obj).filter((o) => o.type === type);

test('구성은 119개이고, 모두 정해진 단계 안에 끝나거나 멈춘 까닭이 정해진다', () => {
  assert.equal(RUNS.length, 119);
  for (const x of RUNS) assert.ok(['finished', 'hang', 'deadlock', 'spin'].includes(x.r.outcome), tag(x));
});

test('같은 구성은 언제나 같은 단계 기록을 낸다', () => {
  for (const x of RUNS) assert.equal(JSON.stringify(run(x.scene, x.cfg)), JSON.stringify(x.r), tag(x));
});

test('한 단계에 실행하는 스레드는 하나이고, 실행할 스레드가 없는 단계는 모두 기다리는 중이다', () => {
  for (const x of RUNS) {
    for (const v of x.r.views.slice(1)) {
      const running = Object.entries(v.th).filter(([, t]) => t.cls === 'run').map(([id]) => id);
      if (v.actor) assert.deepEqual(running, [v.actor], `${tag(x)} step ${v.step}`);
      else {
        assert.deepEqual(running, [], `${tag(x)} step ${v.step}`);
        assert.ok(v.ev.some((e) => e.type === 'idle'), `${tag(x)} step ${v.step}`);
      }
      for (const [id, t] of Object.entries(v.th)) {
        if (id === v.actor) assert.ok(t.after && ['turn', 'event', 'done'].includes(t.after.cls), `${tag(x)} step ${v.step} ${id}`);
        else assert.equal(t.lines.length, 0, `${tag(x)} step ${v.step} ${id}`);
      }
    }
  }
});

test('락은 잠겼을 때만 잡은 스레드가 있고, RLock의 수준은 잠긴 동안 1 이상이다', () => {
  for (const x of RUNS) {
    for (const v of x.r.views) {
      for (const L of [...objs(v, 'lock'), ...objs(v, 'rlock')]) {
        const where = `${tag(x)} step ${v.step} ${L.id}`;
        assert.equal(L.locked, L.holder != null, where);
        if (L.type === 'rlock') assert.equal(L.locked, L.level >= 1, where);
        else assert.ok(L.level === (L.locked ? 1 : 0), where);
        assert.equal(new Set(L.waiters).size, L.waiters.length, where);
      }
    }
  }
});

test('락, 세마포어, 조건 변수, Event의 대기 목록과 스레드가 기다리는 것이 서로 맞는다', () => {
  for (const x of RUNS) {
    for (const v of x.r.views) {
      const lists = {};
      for (const o of Object.values(v.obj)) if (Array.isArray(o.waiters)) lists[o.id] = o.waiters;
      for (const [id, t] of Object.entries(v.th)) {
        const where = `${tag(x)} step ${v.step} ${id}`;
        if (t.waitOn && lists[t.waitOn]) assert.ok(lists[t.waitOn].includes(id), where);
      }
      for (const [oid, ids] of Object.entries(lists)) {
        for (const id of ids) assert.equal(v.th[id].waitOn, oid, `${tag(x)} step ${v.step} ${oid} ${id}`);
      }
    }
  }
});

test('세마포어 카운터는 0 아래로 내려가지 않고, BoundedSemaphore의 카운터는 초깃값을 넘지 않는다', () => {
  for (const x of RUNS) {
    for (const v of x.r.views) {
      for (const s of objs(v, 'sem')) {
        assert.ok(s.value >= 0, tag(x));
        if (s.bounded) assert.ok(s.value <= s.init, tag(x));
      }
    }
  }
});

test('GIL을 쓰는 장면에서는 실행한 스레드가 GIL을 쥐고, 단계가 끝나면 실행을 이어 갈 스레드만 GIL을 남긴다', () => {
  for (const x of RUNS) {
    const gil = M.SCENARIOS[x.scene].gil;
    for (const v of x.r.views.slice(1)) {
      if (!gil) { assert.equal(v.gil, null); continue; }
      assert.equal(v.gil.during, v.actor, tag(x));
      const keeps = v.actor && v.th[v.actor].after.cls === 'turn';
      assert.equal(v.gil.after, keeps ? v.actor : null, `${tag(x)} step ${v.step}`);
    }
  }
});

test('교착 상태로 멈춘 기록의 마지막 단계에는 기다림의 고리가 있고, 끝까지 간 기록에는 고리가 없다', () => {
  for (const x of RUNS) {
    const last = x.r.views[x.r.views.length - 1];
    if (x.r.outcome === 'deadlock') assert.ok(last.cycle && last.cycle.length >= 1, tag(x));
    if (x.r.outcome === 'finished' || x.r.outcome === 'hang') for (const v of x.r.views) assert.equal(v.cycle, null, tag(x));
  }
});

// 실험 결과와 같은 쪽으로 움직이는지 본다. 크기는 줄였으므로 값이 아니라 방향과 위치를 본다.

test('이중 release(): 세마포어는 상한을 넘기고, BoundedSemaphore와 Lock은 타임아웃이 아닌 호출에서, RLock은 타임아웃 난 호출에서 오류를 낸다', () => {
  const r = (tool, code) => run('release', { tool, code }).result;
  const sem = r('semaphore', 'buggy');
  assert.ok(sem.max > sem.limit);
  assert.equal(sem.errors.length, 0);
  assert.ok(sem.final > 2);
  const bounded = r('bounded', 'buggy');
  assert.ok(bounded.max > bounded.limit);
  assert.deepEqual(bounded.errors.map((e) => [e.type, e.timeout]), [['ValueError', false]]);
  const lock = r('lock', 'buggy');
  assert.ok(lock.max > lock.limit);
  assert.deepEqual(lock.errors.map((e) => [e.type, e.timeout]), [['RuntimeError', false]]);
  const rlock = r('rlock', 'buggy');
  assert.equal(rlock.max, rlock.limit);
  assert.deepEqual(rlock.errors.map((e) => [e.type, e.timeout]), [['RuntimeError', true]]);
  for (const tool of ['semaphore', 'bounded', 'lock', 'rlock']) {
    const f = r(tool, 'fixed');
    assert.ok(f.max <= f.limit, tool);
    assert.equal(f.errors.length, 0, tool);
  }
});

test('조건 변수 버퍼: 업로드 뒤 남은 작업자, IndexError, 빈 jobs에서 깨어난 횟수가 실험의 2개·4개 구성과 같다', () => {
  const r = (take, wake, workers) => run('buffer', { take, wake, workers }).result;
  const cases = [
    ['if', 'notify', 2, [1, 1, 1], 1, 1], ['if', 'notify_all', 2, [1, 1, 1], 1, 1],
    ['if', 'notify', 4, [3, 2, 1], 3, 3], ['if', 'notify_all', 4, [1, 1, 1], 3, 3],
    ['while', 'notify', 2, [2, 2, 2], 0, 3], ['while', 'notify_all', 2, [2, 2, 2], 0, 3],
    ['while', 'notify', 4, [4, 4, 4], 0, 3], ['while', 'notify_all', 4, [4, 4, 4], 0, 9],
  ];
  for (const [take, wake, workers, alive, idx, empty] of cases) {
    const x = r(take, wake, workers);
    const where = `${take} ${wake} ${workers}`;
    assert.deepEqual(x.aliveAfter, alive, where);
    assert.equal(x.indexErrors, idx, where);
    assert.equal(x.emptyWakeups, empty, where);
  }
});

test('버퍼 크기 1: 조건 변수 하나와 notify()는 작업 1만 처리하고 모두 기다린 채 멈춘다. notify_all()과 조건 변수 둘은 끝난다', () => {
  const one = run('onecond', { fix: 'one' });
  assert.equal(one.outcome, 'hang');
  assert.deepEqual(one.result.done, [1]);
  const last = one.views[one.views.length - 1];
  assert.ok(Object.values(last.th).every((t) => t.cls === 'run' ? t.after.cls === 'event' : t.cls === 'event'));
  for (const fix of ['all', 'two']) {
    const r = run('onecond', { fix });
    assert.equal(r.outcome, 'finished', fix);
    assert.deepEqual(r.result.done, [1, 2], fix);
  }
});

test('기다리는 방법: pass는 로더의 set()을 늦추고, sleep은 set() 뒤 알아채는 때를 늦추고, Event.wait()은 둘 다 늦추지 않는다', () => {
  for (let n = 1; n <= 4; n += 1) {
    const [pass, sleep, event] = ['pass', 'sleep', 'event'].map((how) => run('wait', { how, waiters: n }).result);
    assert.ok(pass.loadedAt > event.loadedAt, `pass ${n}`);
    assert.equal(sleep.loadedAt, event.loadedAt, `sleep ${n}`);
    assert.ok(sleep.lastWake - sleep.loadedAt > event.lastWake - event.loadedAt, `sleep wake ${n}`);
    assert.ok(pass.waiterSteps > event.waiterSteps, `steps ${n}`);
  }
  const loads = [1, 2, 3, 4].map((n) => run('wait', { how: 'pass', waiters: n }).result.loadedAt);
  assert.deepEqual([...loads].sort((a, b) => a - b), loads);
});

test('이체: 보내는 계좌부터 잠그면 DB 확인에서 첫 이체에 멈추고, 락 순서 고정과 내려놓고 다시는 끝난다. 잔액 합은 그대로다', () => {
  for (const x of RUNS.filter((y) => y.scene === 'transfer')) {
    const c = x.r.cfg;
    const total = Object.values(x.r.result.balances).reduce((a, b) => a + b, 0);
    assert.equal(total, c.accounts === 'self' ? 100 : 200, tag(x));
    if (c.accounts !== 'pair') continue;
    if (c.how === 'opposite' && c.check === 'db') {
      assert.equal(x.r.outcome, 'deadlock', tag(x));
      assert.deepEqual(Object.values(x.r.result.done), [0, 0], tag(x));
      assert.equal(x.r.views[x.r.views.length - 1].cycle.length, 2, tag(x));
    }
    if (c.how !== 'opposite') assert.equal(x.r.outcome, 'finished', tag(x));
  }
  assert.equal(run('transfer', { how: 'opposite', check: 'memory', per: 1 }).outcome, 'finished');
  assert.equal(run('transfer', { how: 'opposite', check: 'memory', per: 3 }).outcome, 'deadlock');
  assert.ok(run('transfer', { how: 'retry', per: 3 }).result.retries > 0);
});

test('자기 계좌 이체: Lock이면 멈추거나(고리 하나) 다시 시도를 되풀이하고, RLock이면 다시 시도 없이 끝난다', () => {
  for (const how of ['opposite', 'ordered', 'retry']) {
    const lock = run('transfer', { how, accounts: 'self', lock: 'lock' });
    if (how === 'retry') assert.equal(lock.outcome, 'spin');
    else {
      assert.equal(lock.outcome, 'deadlock', how);
      assert.equal(lock.views[lock.views.length - 1].cycle.length, 1, how);
    }
    const rlock = run('transfer', { how, accounts: 'self', lock: 'rlock' });
    assert.equal(rlock.outcome, 'finished', how);
    assert.equal(rlock.result.retries, 0, how);
  }
});

test('식사하는 철학자: 모두 왼쪽 먼저와 같은 생각 시간은 아무도 먹지 못한 채 다섯이 고리를 이룬다. 큰 번호 먼저와 웨이터는 끝난다', () => {
  const left = run('phil', { pick: 'left', think: 'same' });
  assert.equal(left.outcome, 'deadlock');
  assert.deepEqual(left.result.eaten, [0, 0, 0, 0, 0]);
  assert.equal(left.views[left.views.length - 1].cycle.length, 5);
  for (const x of RUNS.filter((y) => y.scene === 'phil' && y.r.cfg.pick !== 'left')) {
    assert.equal(x.r.outcome, 'finished', tag(x));
    assert.ok(x.r.result.eaten.every((n) => n === x.r.cfg.meals), tag(x));
  }
  // 큰 번호 먼저에서 철학자 3과 4는 같은 포크(4)를 먼저 집으려 한다
  const larger = run('phil', { pick: 'larger' });
  assert.deepEqual(larger.threads[3].forks, [4, 3]);
  assert.deepEqual(larger.threads[4].forks, [4, 0]);
});
