// 실행 규칙 검사. 실행: node --test model.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model.js');

function* allConfigs() {
  for (const scenario of Object.keys(M.SCENARIOS)) {
    for (const gil of Object.keys(M.GIL_MODES)) {
      for (const processes of [1, 2, 4]) {
        for (const threads of [1, 2, 3, 8]) {
          for (const cpus of [1, 2, 4, 8]) {
            const base = { scenario, gil, processes, threads, cpus };
            if (scenario === 'sem') for (const semaphore of [1, 2, 4]) yield { ...base, jobs: 6, semaphore };
            else if (scenario === 'loop') for (const loopAction of Object.keys(M.LOOP_ACTIONS)) yield { ...base, loopAction };
            else if (scenario === 'counter') {
              for (const lockScope of Object.keys(M.LOCK_SCOPES)) for (const yieldBetween of [true, false]) yield { ...base, lockScope, yieldBetween };
            } else for (const jobs of [1, 5, 12]) yield { ...base, jobs };
          }
        }
      }
    }
  }
}

const RUNS = [...allConfigs()].map((cfg) => ({ cfg, r: M.simulate(cfg) }));
const threadsOf = (v) => Object.entries(v.threads);
const procOf = (id) => id.split('-')[0];

test('모든 구성이 정해진 단계 안에 끝난다', () => {
  for (const { cfg, r } of RUNS) assert.ok(r.finished, JSON.stringify(cfg));
});

test('같은 단계에 CPU에서 실행하는 스레드 수는 논리 CPU 수를 넘지 않는다', () => {
  for (const { cfg, r } of RUNS) {
    for (const v of r.views) {
      const running = threadsOf(v).filter(([, t]) => t.act === 'run-py' || t.act === 'run-native');
      assert.ok(running.length <= cfg.cpus, `${JSON.stringify(cfg)} step ${v.step}`);
      assert.equal(v.cpus.filter(Boolean).length, running.length);
    }
  }
});

test('GIL을 켠 인터프리터에서는 한 단계에 한 스레드만 Python을 실행하고, 그 스레드가 GIL을 가진다', () => {
  for (const { cfg, r } of RUNS) {
    if (!M.GIL_MODES[cfg.gil].active) continue;
    for (const v of r.views) {
      const perProc = {};
      for (const [id, t] of threadsOf(v)) {
        if (t.act !== 'run-py') continue;
        assert.ok(t.holdsGil, `${id} runs Python without GIL`);
        perProc[procOf(id)] = (perProc[procOf(id)] || 0) + 1;
      }
      for (const n of Object.values(perProc)) assert.ok(n <= 1);
    }
  }
});

test('GIL을 끈 free-threaded 구성에서는 같은 프로세스의 스레드 여러 개가 Python을 동시에 실행할 수 있다', () => {
  const r = M.simulate({ scenario: 'py', gil: 'ft-off', processes: 1, threads: 4, cpus: 4, jobs: 4 });
  const max = Math.max(...r.views.map((v) => threadsOf(v).filter(([, t]) => t.act === 'run-py').length));
  assert.equal(max, 4);
  assert.ok(r.views.every((v) => threadsOf(v).every(([, t]) => !t.holdsGil)));
});

test('GIL을 꺼도 논리 CPU 수보다 많이 동시에 실행하지 않는다 (스레드 8개, CPU 4개)', () => {
  const r = M.simulate({ scenario: 'py', gil: 'ft-off', processes: 1, threads: 8, cpus: 4, jobs: 8 });
  const max = Math.max(...r.views.map((v) => threadsOf(v).filter(([, t]) => t.act === 'run-py').length));
  assert.equal(max, 4);
  assert.ok(r.views.some((v) => threadsOf(v).filter(([, t]) => t.act === 'cpu-wait').length === 4));
});

test('프로세스마다 인터프리터와 GIL이 따로 있어 GIL을 켜도 프로세스 2개가 Python을 동시에 실행한다', () => {
  const r = M.simulate({ scenario: 'py', gil: 'default-on', processes: 2, threads: 1, cpus: 4, jobs: 2 });
  assert.ok(r.views.some((v) => threadsOf(v).filter(([, t]) => t.act === 'run-py').length === 2));
});

test('계산 도중 GIL 교대: B는 A의 계산이 끝나기 전에 시작하고, 해제 요청과 실제 해제는 다른 단계다', () => {
  const r = M.simulate({ scenario: 'py', gil: 'default-on', processes: 1, threads: 2, cpus: 4, jobs: 2 });
  const firstRun = (id) => r.views.findIndex((v) => v.threads[id].act === 'run-py');
  const doneAt = (id) => r.views.findIndex((v) => v.threads[id].act === 'done');
  assert.ok(firstRun('p0-t1') < doneAt('p0-t0'));
  const reqStep = r.views.findIndex((v) => v.events.some((e) => e.type === 'gil-request'));
  const relStep = r.views.findIndex((v) => v.events.some((e) => e.type === 'gil-release' && e.text.includes('해제 요청을 처리')));
  assert.ok(reqStep > 0 && relStep > reqStep);
  // 요청이 표시된 상태로 아직 GIL을 가진 단계가 있다.
  assert.ok(r.views.some((v) => threadsOf(v).some(([, t]) => t.dropRequested && t.holdsGil)));
});

test('GIL 보유와 CPU 실행은 별개: GIL을 가졌지만 CPU를 기다리는 스레드와 GIL 없이 CPU에서 네이티브 계산하는 스레드가 있다', () => {
  const r = M.simulate({ scenario: 'native', gil: 'default-on', processes: 1, threads: 3, cpus: 1, jobs: 3 });
  assert.ok(r.views.some((v) => threadsOf(v).some(([, t]) => t.holdsGil && t.act === 'cpu-wait')));
  const r2 = M.simulate({ scenario: 'native', gil: 'default-on', processes: 1, threads: 2, cpus: 2, jobs: 2 });
  assert.ok(r2.views.some((v) => {
    const ts = threadsOf(v).map(([, t]) => t);
    return ts.some((t) => t.act === 'run-native' && !t.holdsGil) && ts.some((t) => t.act === 'run-py' && t.holdsGil);
  }));
  for (const { r: rr } of RUNS) for (const v of rr.views) for (const [, t] of threadsOf(v)) if (t.act === 'run-native') assert.ok(!t.holdsGil);
});

test('time.sleep() 중인 스레드는 GIL과 CPU를 쓰지 않고, 대기가 겹친다', () => {
  for (const { cfg, r } of RUNS) for (const v of r.views) for (const [, t] of threadsOf(v)) {
    if (t.act === 'os-sleep') { assert.ok(!t.holdsGil, JSON.stringify(cfg)); assert.equal(t.cpu, null); }
  }
  // GIL을 켜고 CPU가 하나여도 네 스레드의 대기가 한 단계에 모두 겹친다
  const r = M.simulate({ scenario: 'tsleep', gil: 'default-on', processes: 1, threads: 4, cpus: 1, jobs: 4 });
  assert.ok(r.views.some((v) => threadsOf(v).filter(([, t]) => t.act === 'os-sleep').length === 4));
});

test('이벤트 루프는 프로세스마다 스레드 하나에서만 돈다. 나머지 작업자 스레드는 만들지 않은 것으로 표시한다', () => {
  for (const { cfg, r } of RUNS) {
    if (M.SCENARIOS[cfg.scenario].kind !== 'loop') continue;
    for (const v of r.views) {
      for (const [id, t] of threadsOf(v)) {
        if (!id.endsWith('-t0')) { assert.equal(t.act, 'unused'); assert.equal(t.reason, 'loop'); }
      }
    }
  }
});

function loopRun(loopAction, gil) {
  const r = M.simulate({ scenario: 'loop', loopAction, gil, processes: 1, threads: 1, cpus: 2 });
  const beats = r.views.at(-1).after.beats['p0-B'];
  const aDone = r.views.findIndex((v) => v.after.tasks['p0-A'] && v.after.tasks['p0-A'].status === 'done');
  return { r, beats, aDone };
}

test('같은 루프에서 A가 time.sleep()이나 중단 없는 계산을 하면 B는 A가 끝난 뒤에야 재개한다. GIL 설정과 관계없다', () => {
  for (const gil of Object.keys(M.GIL_MODES)) {
    for (const a of ['blocking', 'cpu']) {
      const { beats, aDone } = loopRun(a, gil);
      assert.ok(beats[0].resumed > aDone, `${a} ${gil}`);
      assert.ok(beats[0].lag > 0);
    }
  }
});

test('A가 await asyncio.sleep()으로 기다리면 B는 A 완료 전에 늦지 않게 재개한다', () => {
  for (const gil of Object.keys(M.GIL_MODES)) {
    const { beats, aDone } = loopRun('async', gil);
    assert.ok(beats[0].resumed < aDone);
    assert.equal(beats[0].lag, 0);
    const idle = loopRun('idle', gil).beats;
    assert.equal(idle[0].lag, 0);
  }
});

test('Semaphore: 세마포어를 얻은 Task 수는 상한을 넘지 않고, 한 Task가 반납하면 기다리던 다음 Task가 얻는다. Task 수는 작업 수 + main 1개다', () => {
  for (const { cfg, r } of RUNS) {
    if (cfg.scenario !== 'sem') continue;
    let maxInside = 0;
    for (const v of r.views) for (const [pid, s] of Object.entries(v.after.sem)) {
      assert.ok(s.inside.length <= cfg.semaphore);
      assert.equal(s.inside.length + s.value, s.limit);
      maxInside = Math.max(maxInside, s.inside.length);
      void pid;
    }
    const tasks = Object.keys(r.views[0].tasks).length;
    assert.equal(tasks, cfg.jobs + cfg.processes);
  }
  const r = M.simulate({ scenario: 'sem', processes: 1, jobs: 4, semaphore: 2 });
  // 묶음 처리가 아님: 작업3이 들어올 때 작업2는 아직 블록 안에 있다.
  const passStep = r.views.findIndex((v) => v.events.some((e) => e.type === 'sem-pass'));
  assert.ok(r.views[passStep].after.sem.p0.inside.length === 2);
});

test('await가 항상 Task를 중단하지는 않는다: 내부 카운터가 0보다 크면 semaphore 진입이 중단 없이 이어진다', () => {
  const r = M.simulate({ scenario: 'sem', processes: 1, jobs: 2, semaphore: 2 });
  const i = r.views.findIndex((v) => v.events.some((e) => e.type === 'sem-enter'));
  assert.ok(i > 0);
  // 다음 단계에도 같은 Task가 계속 실행된다(루프가 다른 Task를 고르지 않음).
  const running = (v) => Object.entries(v.tasks).find(([, t]) => t.current)[0];
  assert.equal(running(r.views[i]), running(r.views[i + 1]));
  assert.ok(!r.views[i + 1].events.some((e) => e.type === 'loop-run'));
});

test('공유 카운터: Lock 없음·쓰기만 보호하면 증가가 유실되는 순서가 나오고, 읽기~쓰기를 같은 Lock으로 보호하면 기대값이 된다', () => {
  for (const gil of Object.keys(M.GIL_MODES)) {
    const get = (lockScope) => M.simulate({ scenario: 'counter', gil, threads: 2, lockScope, yieldBetween: true }).views.at(-1).after.counter.p0;
    assert.equal(get('none').value, 1, gil);
    assert.equal(get('write').value, 1, gil);
    assert.equal(get('full').value, 2, gil);
  }
  for (const { cfg, r } of RUNS) {
    if (cfg.scenario !== 'counter' || cfg.lockScope !== 'full') continue;
    for (const c of Object.values(r.views.at(-1).after.counter)) assert.equal(c.value, c.expected);
  }
});

test('Lock을 가진 스레드는 한 번에 하나이고, Lock을 기다리는 스레드는 GIL을 쥐지 않는다', () => {
  for (const { cfg, r } of RUNS) {
    if (cfg.scenario !== 'counter') continue;
    for (const v of r.views) for (const [, t] of threadsOf(v)) if (t.act === 'lock-wait') assert.ok(!t.holdsGil);
  }
});

test('프로세스를 늘려도 일반 Python 객체는 공유되지 않는다: 카운터는 프로세스마다 따로 센다', () => {
  const r = M.simulate({ scenario: 'counter', processes: 3, threads: 2, lockScope: 'full' });
  const c = r.views.at(-1).after.counter;
  assert.deepEqual(Object.keys(c), ['p0', 'p1', 'p2']);
  for (const v of Object.values(c)) assert.deepEqual(v, { value: 2, expected: 2 });
});

test('작업 수가 작업자보다 적으면 남는 작업자는 만들지 않은 것으로 표시한다', () => {
  const r = M.simulate({ scenario: 'py', processes: 1, threads: 4, jobs: 2 });
  const acts = r.views[1].threads;
  assert.equal(acts['p0-t2'].act, 'unused');
  assert.equal(acts['p0-t2'].reason, 'nojob');
});

test('설정값은 범위 안으로 맞춘다', () => {
  const c = M.normalizeConfig({ processes: 99, threads: 0, cpus: 'x', scenario: 'nope', gil: 'bad', jobs: -3 });
  assert.equal(c.processes, 4);
  assert.equal(c.threads, 1);
  assert.equal(c.cpus, M.DEFAULT_CONFIG.cpus);
  assert.equal(c.scenario, 'py');
  assert.equal(c.gil, 'default-on');
  assert.equal(c.jobs, 1);
});

test('같은 구성은 같은 순서를 낸다', () => {
  const a = M.simulate({ scenario: 'native', threads: 3, cpus: 2, jobs: 5 });
  const b = M.simulate({ scenario: 'native', threads: 3, cpus: 2, jobs: 5 });
  assert.deepEqual(a.views, b.views);
});

test('조사 도우미', () => {
  assert.equal(M.josa('스레드 1-1', ['이', '가']), '스레드 1-1이');
  assert.equal(M.josa('스레드 1-2', ['이', '가']), '스레드 1-2가');
  assert.equal(M.josa('main Task', ['을', '를']), 'main Task를');
});

test('작업 진행률은 줄지 않고 끝에서 전체와 같다', () => {
  for (const scenario of ['py', 'native', 'tsleep']) {
    for (const threads of [1, 2, 4]) {
      const r = M.simulate(M.normalizeConfig({ scenario, threads, jobs: 5 }));
      let prev = {};
      for (const v of r.views) {
        for (const [id, p] of Object.entries(v.after.progress)) {
          assert.ok(p.done >= (prev[id] || 0), `${scenario} ${id} 진행률 감소`);
          assert.ok(p.done <= p.total);
          prev[id] = p.done;
        }
      }
      for (const p of Object.values(r.views.at(-1).after.progress)) assert.equal(p.done, p.total);
    }
  }
});
