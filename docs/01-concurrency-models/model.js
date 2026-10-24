/*
 * 동시성 관계도의 설명용 실행 모형.
 *
 * 한 단계는 "관찰 구간" 하나다. 단계 수는 실제 시간·비율이 아니며 실측값과 비교하지 않는다.
 * 규칙은 CPython 3.14.2 소스·공식 문서와 실험 README의 기록에 근거해 단순화했다.
 * 브라우저에서는 window.RuntimeModel, Node.js에서는 require()로 쓴다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RuntimeModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2026-10-24.2';

  const SCENARIOS = {
    py: { kind: 'threads', label: '스레드: 순수 Python 계산' },
    native: { kind: 'threads', label: '스레드: GIL을 해제하는 네이티브 계산' },
    tsleep: { kind: 'threads', label: '스레드: time.sleep() 대기' },
    sem: { kind: 'loop', label: 'asyncio: 작업 Task 여러 개와 Semaphore' },
    loop: { kind: 'loop', label: 'asyncio: 같은 루프의 Task A·B' },
    counter: { kind: 'counter', label: '스레드: 공유 카운터와 Lock' },
  };

  const GIL_MODES = {
    'default-on': { label: '일반 빌드 3.14.2 · GIL 켬', build: 'default', active: true },
    'ft-on': { label: 'free-threaded 3.14.2t · GIL 켬 (PYTHON_GIL=1)', build: 'free-threaded', active: true },
    'ft-off': { label: 'free-threaded 3.14.2t · GIL 끔 (PYTHON_GIL=0)', build: 'free-threaded', active: false },
  };

  const LOOP_ACTIONS = {
    idle: 'A 없음 (대조군)',
    blocking: 'A: time.sleep(1)',
    async: 'A: await asyncio.sleep(1)',
    cpu: 'A: 중단 없는 CPU 계산',
  };

  const LOCK_SCOPES = {
    none: 'Lock 없음',
    write: '쓰기만 Lock으로 감쌈',
    full: '읽기부터 쓰기까지 Lock으로 감쌈',
  };

  // 설명용 길이(단계 수). 실제 처리 시간과 비례하지 않는다.
  // time.sleep() 대기는 작업자 4개가 하나씩 대기에 들어가도 네 대기가 모두 겹치도록 Python 구간(1단계)보다 길게 둔다.
  const UNITS = { pyJob: 4, native: 3, sleep: 5, asyncSleep: 3, loopWait: 4, loopCpu: 5, beatPeriod: 2, beats: 2 };
  // GIL을 기다린 스레드가 이 단계 수만큼 교대를 보지 못하면 보유 스레드에 해제 요청을 표시한다.
  // CPython의 switch interval(기본 0.005초)을 시간으로 재현한 값이 아니다.
  const SWITCH_WAIT = 2;
  const MAX_STEPS = 400;

  const LIMITS = { processes: [1, 4], threads: [1, 8], cpus: [1, 8], jobs: [1, 12], semaphore: [1, 4] };

  const DEFAULT_CONFIG = {
    scenario: 'py',
    gil: 'default-on',
    processes: 1,
    threads: 2,
    cpus: 4,
    jobs: 4,
    semaphore: 2,
    loopAction: 'blocking',
    lockScope: 'none',
    yieldBetween: true,
  };

  function clampInt(value, [lo, hi], fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function normalizeConfig(input) {
    const c = Object.assign({}, DEFAULT_CONFIG, input || {});
    return {
      scenario: SCENARIOS[c.scenario] ? c.scenario : DEFAULT_CONFIG.scenario,
      gil: GIL_MODES[c.gil] ? c.gil : DEFAULT_CONFIG.gil,
      processes: clampInt(c.processes, LIMITS.processes, DEFAULT_CONFIG.processes),
      threads: clampInt(c.threads, LIMITS.threads, DEFAULT_CONFIG.threads),
      cpus: clampInt(c.cpus, LIMITS.cpus, DEFAULT_CONFIG.cpus),
      jobs: clampInt(c.jobs, LIMITS.jobs, DEFAULT_CONFIG.jobs),
      semaphore: clampInt(c.semaphore, LIMITS.semaphore, DEFAULT_CONFIG.semaphore),
      loopAction: LOOP_ACTIONS[c.loopAction] ? c.loopAction : DEFAULT_CONFIG.loopAction,
      lockScope: LOCK_SCOPES[c.lockScope] ? c.lockScope : DEFAULT_CONFIG.lockScope,
      yieldBetween: c.yieldBetween === true || c.yieldBetween === 'true',
    };
  }

  // ---------- 프로그램(작업자가 실행할 연산 목록) ----------

  const PY_KINDS = new Set(['py', 'read', 'write', 'yield0', 'lockAcquire', 'lockRelease',
    'spawn', 'semAcquire', 'asleep', 'exitSem', 'record']);

  function jobOps(scenario, j) {
    const name = `작업 ${j + 1}`;
    const idx = (ops) => ops.map((op, i) => Object.assign(op, { i }));
    if (scenario === 'py') {
      return idx([{ k: 'py', n: UNITS.pyJob, job: j, label: `${name}: 소수 계산 (Python 바이트코드)` }]);
    }
    if (scenario === 'native') {
      return idx([
        { k: 'py', n: 1, job: j, label: `${name}: 네이티브 함수 호출 준비 (Python)` },
        { k: 'native', n: UNITS.native, job: j, label: `${name}: 네이티브 계산 (GIL을 놓은 구간)` },
        { k: 'py', n: 1, job: j, label: `${name}: 결과를 Python 객체로 받기` },
      ]);
    }
    return idx([
      { k: 'py', n: 1, job: j, label: `${name}: time.sleep(0.1) 호출 (Python)` },
      { k: 'sleep', n: UNITS.sleep, job: j, label: `${name}: time.sleep() 안에서 OS 대기` },
      { k: 'py', n: 1, job: j, label: `${name}: return 1` },
    ]);
  }

  function counterOps(scope, yieldBetween) {
    const acq = { k: 'lockAcquire', label: 'with lock: Lock 획득 시도' };
    const rel = { k: 'lockRelease', label: 'with 블록 종료: Lock 해제' };
    const read = { k: 'read', label: 'previous = counter.completed' };
    const y = { k: 'yield0', label: 'time.sleep(0)' };
    const write = { k: 'write', label: 'counter.completed = previous + 1' };
    const mid = yieldBetween ? [y] : [];
    if (scope === 'full') return [acq, read, ...mid, write, rel];
    if (scope === 'write') return [read, ...mid, acq, write, rel];
    return [read, ...mid, write];
  }

  function makeTask(proc, id, name, ops, extra) {
    const task = Object.assign({ id, name, ops, pc: 0, rem: 0, status: 'not-created', due: null,
      inSem: false, parent: null, children: [], beats: [], proc: proc.idx }, extra || {});
    proc.loop.tasks.push(task);
    return task;
  }

  function buildLoop(cfg, proc, jobIds) {
    proc.loop = { tasks: [], ready: [], timers: [], current: null, closed: false, beatStart: null };
    const pre = `p${proc.idx}`;
    if (cfg.scenario === 'sem') {
      proc.sem = { value: cfg.semaphore, limit: cfg.semaphore, waiters: [] };
      const main = makeTask(proc, `${pre}-main`, 'main Task', [
        { k: 'spawn', label: 'Semaphore 생성, gather()로 작업 Task 예약' },
        { k: 'awaitChildren', label: 'await gather(...)' },
        { k: 'py', n: 1, label: '결과 목록 반환' },
      ], { role: 'main' });
      for (const j of jobIds) {
        const t = makeTask(proc, `${pre}-job${j}`, `작업${j + 1} Task`, [
          { k: 'semAcquire', label: 'async with semaphore: 세마포어 얻기' },
          { k: 'asleep', n: UNITS.asyncSleep, label: 'await asyncio.sleep(0.1)' },
          { k: 'exitSem', label: 'async with 종료: 세마포어 반납, return 1' },
        ], { role: 'job', job: j, parent: main.id });
        main.children.push(t.id);
      }
      main.status = 'ready';
      proc.loop.ready.push(main.id);
      return;
    }
    // loop: 실험의 loop_lab.py처럼 B-heartbeat를 먼저, A-work를 다음에 만든다.
    const main = makeTask(proc, `${pre}-main`, 'main Task', [
      { k: 'spawn', label: 'B·A Task 생성' },
      { k: 'awaitChildren', label: 'B·A 완료 대기' },
      { k: 'py', n: 1, label: '결과 정리 후 반환' },
    ], { role: 'main' });
    const beatOps = [];
    for (let i = 1; i <= UNITS.beats; i++) {
      beatOps.push({ k: 'asleep', beat: i, label: `await asyncio.sleep(주기) — 예정 ${i}` });
      beatOps.push({ k: 'record', beat: i, label: `재개 기록 ${i} (지연 = 재개 − 예정)` });
    }
    const b = makeTask(proc, `${pre}-B`, 'Task B (heartbeat)', beatOps, { role: 'B', parent: main.id });
    main.children.push(b.id);
    const a = cfg.loopAction;
    if (a !== 'idle') {
      let ops;
      if (a === 'blocking') {
        ops = [{ k: 'py', n: 1, label: 'run_action() 시작' },
          { k: 'tsleep', n: UNITS.loopWait, label: 'time.sleep(1) — 루프 스레드가 OS 대기' },
          { k: 'py', n: 1, label: 'return 1' }];
      } else if (a === 'async') {
        ops = [{ k: 'py', n: 1, label: 'run_action() 시작' },
          { k: 'asleep', n: UNITS.loopWait, label: 'await asyncio.sleep(1)' },
          { k: 'py', n: 1, label: 'return 1' }];
      } else {
        ops = [{ k: 'py', n: 1, label: 'run_action() 시작' },
          { k: 'py', n: UNITS.loopCpu, label: 'count_primes() 계산 — 중간에 await 없음' },
          { k: 'py', n: 1, label: 'return sum(...)' }];
      }
      const at = makeTask(proc, `${pre}-A`, 'Task A (work)', ops, { role: 'A', parent: main.id });
      main.children.push(at.id);
    }
    main.status = 'ready';
    proc.loop.ready.push(main.id);
  }

  // ---------- 상태 생성 ----------

  function createState(input) {
    const cfg = normalizeConfig(input);
    const gm = GIL_MODES[cfg.gil];
    const kind = SCENARIOS[cfg.scenario].kind;
    const s = { version: VERSION, cfg, step: 0, done: false, procs: [], cpus: cfg.cpus, finishedAt: null };
    const P = cfg.processes;
    const T = cfg.threads;
    const W = P * T;
    const jobsByWorker = new Map();
    const jobsByProc = new Map();
    if (kind === 'threads') {
      for (let j = 0; j < cfg.jobs; j++) {
        const w = j % W;
        const key = `p${w % P}-t${Math.floor(w / P)}`;
        if (!jobsByWorker.has(key)) jobsByWorker.set(key, []);
        jobsByWorker.get(key).push(j);
      }
    } else if (cfg.scenario === 'sem') {
      for (let j = 0; j < cfg.jobs; j++) {
        const key = j % P;
        if (!jobsByProc.has(key)) jobsByProc.set(key, []);
        jobsByProc.get(key).push(j);
      }
    }
    for (let p = 0; p < P; p++) {
      const proc = { idx: p, id: `p${p}`, gil: { active: gm.active, holder: null, queue: [] },
        threads: [], loop: null, counter: null, lock: null, sem: null };
      for (let t = 0; t < T; t++) {
        const th = { id: `p${p}-t${t}`, p, t, name: `스레드 ${p + 1}-${t + 1}`, role: 'unused', reason: null,
          ops: [], pc: 0, rem: 0, status: 'unused', holdsGil: false, gilWait: 0, dropRequested: false,
          local: {}, lastRun: -1, order: p * T + t, jobs: [] };
        if (kind === 'threads') {
          const js = jobsByWorker.get(th.id) || [];
          if (js.length) {
            th.role = 'worker';
            th.jobs = js;
            th.ops = js.flatMap((j) => jobOps(cfg.scenario, j));
          } else {
            th.reason = 'nojob';
          }
        } else if (kind === 'counter') {
          th.role = 'worker';
          th.ops = counterOps(cfg.lockScope, cfg.yieldBetween);
          th.local = { previous: null };
        } else if (t === 0) {
          th.role = 'loop';
        } else {
          th.reason = 'loop';
        }
        proc.threads.push(th);
      }
      if (kind === 'counter') {
        proc.counter = { value: 0, expected: T };
        proc.lock = { owner: null, waiters: [], used: cfg.lockScope !== 'none' };
      }
      if (kind === 'loop') buildLoop(cfg, proc, jobsByProc.get(p) || []);
      s.procs.push(proc);
    }
    // 첫 연산에 들어간다. 작업자 스레드·풀·프로세스의 생성 비용은 모형에 넣지 않는다.
    for (const proc of s.procs) {
      for (const th of proc.threads) {
        if (th.role === 'worker') { th.rem = th.ops[0].n || 1; enterWorkerOp(s, proc, th, null); }
        if (th.role === 'loop') th.status = 'loop-free';
      }
    }
    return s;
  }

  // ---------- 보조 함수 ----------

  function findThread(proc, id) { return proc.threads.find((t) => t.id === id); }
  function findTask(proc, id) { return proc.loop.tasks.find((t) => t.id === id); }
  function loopThread(proc) { return proc.threads[0]; }

  function emit(ev, type, text, ids) { if (ev) ev.push({ type, text, ids: ids || [] }); }

  // 이름 끝소리에 맞춰 조사를 고른다. pair는 [받침 있을 때, 없을 때]다.
  function josa(word, pair) {
    const ch = String(word).trim().slice(-1);
    const code = ch.charCodeAt(0);
    let batchim;
    if (code >= 0xac00 && code <= 0xd7a3) batchim = (code - 0xac00) % 28 !== 0;
    else if (/[0-9]/.test(ch)) batchim = '013678'.includes(ch);
    else batchim = false;
    return word + (batchim ? pair[0] : pair[1]);
  }

  function needPython(proc, th) {
    if (!proc.gil.active || th.holdsGil) { th.status = 'ready'; return; }
    th.status = 'needs-gil';
    if (!proc.gil.queue.includes(th.id)) proc.gil.queue.push(th.id);
  }

  function releaseGil(proc, th, reason, ev) {
    if (!th.holdsGil) return;
    th.holdsGil = false;
    th.dropRequested = false;
    proc.gil.holder = null;
    const why = {
      request: '확인 지점에서 해제 요청을 처리해 GIL을 놓는다 (계산은 아직 남음)',
      native: '네이티브 계산에 들어가며 GIL을 명시적으로 놓는다',
      sleep: 'time.sleep()에 들어가며 GIL을 놓는다',
      sleep0: 'time.sleep(0) 호출로 GIL을 놓고 다시 기다린다',
      lock: 'Lock이 잠겨 있어 GIL을 놓고 Lock을 기다린다',
      select: '이벤트 루프가 준비된 Task가 없어 OS 대기에 들어가며 GIL을 놓는다',
      exit: '할 일을 마치고 GIL을 놓는다',
    }[reason];
    emit(ev, 'gil-release', `${th.name}: ${why}`, [th.id, `${proc.id}-gil`]);
  }

  function workerOp(th) { return th.ops[th.pc] || null; }

  function enterWorkerOp(s, proc, th, ev) {
    const op = workerOp(th);
    if (!op) {
      releaseGil(proc, th, 'exit', ev);
      th.status = 'done';
      emit(ev, 'done', `${th.name}: 맡은 일을 모두 마쳤다`, [th.id]);
      return;
    }
    if (op.k === 'native') {
      releaseGil(proc, th, 'native', ev);
      th.status = 'ready';
    } else if (op.k === 'sleep') {
      releaseGil(proc, th, 'sleep', ev);
      th.status = 'os-sleep';
    } else {
      needPython(proc, th);
    }
  }

  function advanceWorker(s, proc, th, ev) {
    th.pc += 1;
    const op = workerOp(th);
    th.rem = op ? op.n || 1 : 0;
    enterWorkerOp(s, proc, th, ev);
  }

  function taskOp(task) { return task.ops[task.pc] || null; }

  function finishTask(s, proc, task, ev) {
    task.status = 'done';
    proc.loop.current = proc.loop.current === task.id ? null : proc.loop.current;
    emit(ev, 'task-done', `${task.name}: 완료한다`, [task.id]);
    if (task.parent) {
      const parent = findTask(proc, task.parent);
      const allDone = parent.children.every((id) => findTask(proc, id).status === 'done');
      if (allDone && parent.status === 'wait-children') {
        parent.status = 'ready';
        parent.pc += 1;
        parent.rem = (taskOp(parent) || {}).n || 1;
        proc.loop.ready.push(parent.id);
        emit(ev, 'task-ready', `${parent.name}: 기다리던 Task가 모두 끝나 준비 상태가 된다`, [parent.id]);
      }
    }
  }

  // Task가 다음 연산으로 넘어간다. 중단 지점이 아니면 같은 Task가 계속 실행된다.
  function advanceTask(s, proc, task, ev) {
    task.pc += 1;
    const op = taskOp(task);
    const th = loopThread(proc);
    if (!op) { finishTask(s, proc, task, ev); needPythonOrFree(proc, th); return; }
    task.rem = op.n || 1;
    if (op.k === 'awaitChildren') {
      const allDone = task.children.every((id) => findTask(proc, id).status === 'done');
      if (allDone) { advanceTask(s, proc, task, ev); return; }
      task.status = 'wait-children';
      proc.loop.current = null;
      emit(ev, 'task-suspend', `${task.name}: 만든 Task를 기다리며 실행을 중단한다`, [task.id]);
      needPythonOrFree(proc, th);
      return;
    }
    if (op.k === 'tsleep') {
      releaseGil(proc, th, 'sleep', ev);
      th.status = 'os-sleep';
      emit(ev, 'thread-block', `${task.name}: time.sleep()을 직접 호출해 ${th.name} 전체가 대기한다. 루프도 이 스레드에서 돌기 때문에 다른 Task를 실행할 수 없다`, [task.id, th.id]);
      return;
    }
    needPython(proc, th);
  }

  // 현재 Task가 중단·완료된 뒤의 루프 스레드 상태. 다음 단계에 루프가 할 일을 고른다.
  function needPythonOrFree(proc, th) {
    if (!proc.loop.current) th.status = 'loop-free';
  }

  // ---------- 한 단계 진행 ----------

  function decideLoop(s, proc, ev) {
    const L = proc.loop;
    const th = loopThread(proc);
    const k = s.step;
    if (th.status === 'done' || th.status === 'os-sleep') return;
    if (L.current) return;
    // 루프가 실행 흐름을 돌려받은 상태: 만료된 타이머를 처리하고 준비된 Task를 고른다.
    const due = L.timers.filter((t) => t.due < k);
    L.timers = L.timers.filter((t) => t.due >= k);
    for (const tm of due) {
      const task = findTask(proc, tm.task);
      task.status = 'ready';
      L.ready.push(task.id);
      emit(ev, 'timer', `이벤트 루프: 만료된 타이머를 처리해 ${josa(task.name, ['을', '를'])} 준비 상태로 바꾼다 (아직 실행 전)`, [`${proc.id}-loop`, task.id]);
    }
    if (L.ready.length) {
      const id = L.ready.shift();
      const task = findTask(proc, id);
      L.current = id;
      task.status = 'running';
      if (!task.rem) task.rem = (taskOp(task) || {}).n || 1;
      emit(ev, 'loop-run', `이벤트 루프: 준비된 ${josa(task.name, ['을', '를'])} ${th.name}에서 실행한다`, [`${proc.id}-loop`, task.id]);
      needPython(proc, th);
      return;
    }
    if (L.tasks.every((t) => t.status === 'done')) {
      L.closed = true;
      releaseGil(proc, th, 'exit', ev);
      th.status = 'done';
      emit(ev, 'done', `이벤트 루프: 모든 Task가 끝나 asyncio.run()이 루프를 닫는다`, [`${proc.id}-loop`, th.id]);
      return;
    }
    if (th.status !== 'loop-idle') {
      releaseGil(proc, th, 'select', ev);
      emit(ev, 'loop-idle', `이벤트 루프: 준비된 Task가 없어 다음 타이머까지 기다린다`, [`${proc.id}-loop`]);
    }
    th.status = 'loop-idle';
  }

  function arbitrateGil(s, proc, ev) {
    const g = proc.gil;
    if (!g.active || g.holder || !g.queue.length) return;
    const id = g.queue.shift();
    const th = findThread(proc, id);
    th.holdsGil = true;
    th.status = 'ready';
    g.holder = id;
    for (const w of g.queue) findThread(proc, w).gilWait = 0;
    th.gilWait = 0;
    emit(ev, 'gil-take', `${th.name}: GIL을 획득한다`, [th.id, `${proc.id}-gil`]);
  }

  function assignCpus(s) {
    const runnable = [];
    for (const proc of s.procs) for (const th of proc.threads) if (th.status === 'ready') runnable.push(th);
    runnable.sort((a, b) => (a.lastRun - b.lastRun) || (a.order - b.order));
    const chosen = runnable.slice(0, s.cpus);
    const cpus = new Array(s.cpus).fill(null);
    // 설명용 배정: 고른 스레드가 직전에 쓴 CPU가 비어 있으면 그 CPU를 다시 쓴다.
    const rest = [];
    for (const th of chosen) {
      if (th.lastCpu != null && th.lastCpu < s.cpus && cpus[th.lastCpu] == null) cpus[th.lastCpu] = th.id;
      else rest.push(th);
    }
    for (const th of rest) {
      const free = cpus.indexOf(null);
      cpus[free] = th.id;
    }
    for (const proc of s.procs) for (const th of proc.threads) {
      const i = cpus.indexOf(th.id);
      if (i >= 0) th.lastCpu = i;
    }
    return cpus;
  }

  function currentOpOf(s, proc, th) {
    if (th.role === 'loop') {
      if (!proc.loop.current) return null;
      return taskOp(findTask(proc, proc.loop.current));
    }
    return workerOp(th);
  }

  function opLabel(s, proc, th) {
    if (th.role === 'unused') return '';
    if (th.status === 'done') return '완료';
    if (th.role === 'loop') {
      if (th.status === 'loop-idle') return '이벤트 루프: 다음 타이머까지 OS 대기';
      if (th.status === 'loop-free') return '이벤트 루프: 다음에 실행할 Task 고르기';
      const task = proc.loop.current ? findTask(proc, proc.loop.current) : null;
      if (!task) return '이벤트 루프';
      const op = taskOp(task);
      return `${task.name} · ${op ? op.label : ''}`;
    }
    const op = workerOp(th);
    return op ? op.label : '';
  }

  function activityOf(s, proc, th, cpuOf) {
    if (th.role === 'unused') return 'unused';
    switch (th.status) {
      case 'done': return 'done';
      case 'os-sleep': return 'os-sleep';
      case 'lock-wait': return 'lock-wait';
      case 'loop-idle': return 'loop-idle';
      case 'needs-gil': return 'gil-wait';
      case 'ready': {
        if (cpuOf[th.id] == null) return 'cpu-wait';
        const op = currentOpOf(s, proc, th);
        return op && op.k === 'native' ? 'run-native' : 'run-py';
      }
      default: return 'start';
    }
  }

  function snapshot(s, cpus, ev) {
    const cpuOf = {};
    cpus.forEach((id, i) => { if (id) cpuOf[id] = i; });
    const view = { step: s.step, cpus: cpus.slice(), threads: {}, gil: {}, tasks: {}, events: ev, after: null };
    for (const proc of s.procs) {
      view.gil[proc.id] = { active: proc.gil.active, holder: proc.gil.holder, queue: proc.gil.queue.slice() };
      for (const th of proc.threads) {
        view.threads[th.id] = {
          act: activityOf(s, proc, th, cpuOf),
          cpu: cpuOf[th.id] == null ? null : cpuOf[th.id],
          holdsGil: th.holdsGil,
          dropRequested: th.dropRequested,
          label: opLabel(s, proc, th),
          // 코드 줄 표시용: 지금 연산의 종류, 작업 안 순서, 남은 단위
          op: th.ops[th.pc] ? { k: th.ops[th.pc].k, i: th.ops[th.pc].i == null ? null : th.ops[th.pc].i, n: th.ops[th.pc].n || 1, rem: th.rem, job: th.ops[th.pc].job } : null,
          role: th.role,
          reason: th.reason,
        };
      }
      if (proc.loop) {
        for (const task of proc.loop.tasks) {
          const op = taskOp(task);
          view.tasks[task.id] = { status: task.status, label: op ? op.label : '', op: op ? { k: op.k, beat: op.beat || null, pc: task.pc } : null, due: task.due,
            current: proc.loop.current === task.id, inSem: task.inSem };
        }
      }
    }
    return view;
  }

  function afterSnapshot(s) {
    const a = { counter: {}, locals: {}, lock: {}, sem: {}, tasks: {}, timers: {}, gil: {}, beats: {}, progress: {} };
    for (const proc of s.procs) {
      a.gil[proc.id] = proc.gil.holder;
      for (const th of proc.threads) {
        if (th.role !== 'worker') continue;
        // 작업 진행률: 끝낸 단위 / 전체 단위. 단위는 모형의 단계 수이고 실제 시간이 아니다.
        const unit = (op) => op.n || 1;
        const total = th.ops.reduce((n, op) => n + unit(op), 0);
        let done = th.ops.slice(0, th.pc).reduce((n, op) => n + unit(op), 0);
        if (th.ops[th.pc]) done += Math.max(0, unit(th.ops[th.pc]) - th.rem);
        a.progress[th.id] = { done: th.status === 'done' ? total : Math.min(done, total), total };
      }
      if (proc.counter) a.counter[proc.id] = { value: proc.counter.value, expected: proc.counter.expected };
      if (proc.lock) a.lock[proc.id] = { owner: proc.lock.owner, waiters: proc.lock.waiters.slice(), used: proc.lock.used };
      for (const th of proc.threads) if ('previous' in th.local) a.locals[th.id] = th.local.previous;
      if (proc.sem) {
        a.sem[proc.id] = { value: proc.sem.value, limit: proc.sem.limit, waiters: proc.sem.waiters.slice(),
          inside: proc.loop.tasks.filter((t) => t.inSem).map((t) => t.id) };
      }
      if (proc.loop) {
        a.timers[proc.id] = proc.loop.timers.map((t) => ({ task: t.task, due: t.due }));
        for (const task of proc.loop.tasks) {
          a.tasks[task.id] = { status: task.status, due: task.due, inSem: task.inSem, label: (taskOp(task) || {}).label || '' };
          if (task.beats.length) a.beats[task.id] = task.beats.map((b) => Object.assign({}, b));
        }
      }
    }
    return a;
  }

  function execWorkerUnit(s, proc, th, ev) {
    const op = workerOp(th);
    const k = s.step;
    let completed = false;
    if (op.k === 'py' || op.k === 'native') {
      th.rem -= 1;
      completed = th.rem <= 0;
      if (completed && op.k === 'native') {
        emit(ev, 'native-done', `${th.name}: 네이티브 계산을 마쳤다. Python 객체를 다루려면 GIL을 다시 얻어야 한다`, [th.id]);
      }
    } else if (op.k === 'read') {
      th.local.previous = proc.counter.value;
      emit(ev, 'read', `${th.name}: 공유 카운터를 읽어 지역 변수 previous = ${th.local.previous}`, [th.id, `${proc.id}-counter`]);
      completed = true;
    } else if (op.k === 'write') {
      const before = proc.counter.value;
      proc.counter.value = th.local.previous + 1;
      const lost = before >= proc.counter.value;
      emit(ev, lost ? 'lost' : 'write',
        `${th.name}: previous + 1 = ${josa(String(proc.counter.value), ['을', '를'])} 저장한다 (저장 전 값 ${before})${lost ? ' — 다른 스레드의 증가를 덮어썼다' : ''}`,
        [th.id, `${proc.id}-counter`]);
      completed = true;
    } else if (op.k === 'yield0') {
      completed = true;
      th.yielded = true;
    } else if (op.k === 'lockAcquire') {
      const lock = proc.lock;
      if (lock.owner == null) {
        lock.owner = th.id;
        emit(ev, 'lock-take', `${th.name}: Lock을 획득한다`, [th.id, `${proc.id}-lock`]);
        completed = true;
      } else {
        lock.waiters.push(th.id);
        th.status = 'lock-wait';
        emit(ev, 'lock-wait', `${th.name}: Lock을 ${josa(findThread(proc, lock.owner).name, ['이', '가'])} 가지고 있어 기다린다`, [th.id, `${proc.id}-lock`]);
        releaseGil(proc, th, 'lock', ev);
        return;
      }
    } else if (op.k === 'lockRelease') {
      const lock = proc.lock;
      lock.owner = null;
      emit(ev, 'lock-release', `${th.name}: Lock을 해제한다`, [th.id, `${proc.id}-lock`]);
      if (lock.waiters.length) {
        const nextId = lock.waiters.shift();
        const nt = findThread(proc, nextId);
        lock.owner = nextId;
        emit(ev, 'lock-take', `${nt.name}: 기다리던 Lock을 획득한다. Python으로 돌아가려면 GIL도 다시 필요하다`, [nextId, `${proc.id}-lock`]);
        advanceWorker(s, proc, nt, ev);
      }
      completed = true;
    }
    th.lastRun = k;
    if (completed) {
      const wasYield = th.yielded;
      th.yielded = false;
      advanceWorker(s, proc, th, ev);
      if (wasYield && th.holdsGil) {
        releaseGil(proc, th, 'sleep0', ev);
        needPython(proc, th);
      }
    }
    handleDropRequest(proc, th, ev);
  }

  function handleDropRequest(proc, th, ev) {
    if (th.holdsGil && th.dropRequested) {
      releaseGil(proc, th, 'request', ev);
      if (th.status === 'ready') needPython(proc, th);
    }
  }

  function execLoopUnit(s, proc, th, ev) {
    const L = proc.loop;
    const task = findTask(proc, L.current);
    const op = taskOp(task);
    const k = s.step;
    th.lastRun = k;
    if (op.k === 'py') {
      task.rem -= 1;
      if (task.rem <= 0) advanceTask(s, proc, task, ev);
    } else if (op.k === 'spawn') {
      for (const id of task.children) {
        const c = findTask(proc, id);
        c.status = 'ready';
        c.rem = (taskOp(c) || {}).n || 1;
        L.ready.push(id);
      }
      emit(ev, 'spawn', `${task.name}: Task ${task.children.length}개를 만들어 준비 큐에 넣는다`, [task.id, ...task.children]);
      advanceTask(s, proc, task, ev);
    } else if (op.k === 'semAcquire') {
      const sem = proc.sem;
      if (sem.value > 0) {
        sem.value -= 1;
        task.inSem = true;
        emit(ev, 'sem-enter', `${task.name}: 내부 카운터가 0보다 커서 세마포어를 바로 얻는다. await가 중단 없이 반환된다 (내부 카운터 ${sem.value})`, [task.id, `${proc.id}-sem`]);
        advanceTask(s, proc, task, ev);
      } else {
        sem.waiters.push(task.id);
        task.status = 'wait-sem';
        L.current = null;
        emit(ev, 'sem-wait', `${task.name}: 내부 카운터가 0이라 세마포어를 얻지 못하고, release()를 기다리며 실행을 중단한다`, [task.id, `${proc.id}-sem`]);
        needPythonOrFree(proc, th);
      }
    } else if (op.k === 'asleep') {
      let due;
      if (op.beat) {
        if (L.beatStart == null) L.beatStart = k;
        // 실험처럼 예정 시각을 시작 시각에 고정한다. 이미 지났으면 바로 다시 실행될 수 있게 한다.
        task.schedDue = L.beatStart + op.beat * UNITS.beatPeriod;
        due = Math.max(task.schedDue, k);
      } else {
        due = k + op.n;
      }
      task.due = due;
      task.status = 'wait-timer';
      L.timers.push({ task: task.id, due });
      L.current = null;
      task.pc += 1;
      task.rem = (taskOp(task) || {}).n || 1;
      emit(ev, 'task-suspend', `${task.name}: 타이머를 등록하고(단계 ${due} 만료) 실행을 중단한다. 실행 흐름이 루프로 돌아간다`, [task.id, `${proc.id}-loop`]);
      needPythonOrFree(proc, th);
    } else if (op.k === 'record') {
      const scheduled = (task.schedDue == null ? task.due : task.schedDue) + 1;
      const lag = k - scheduled;
      task.beats.push({ beat: op.beat, scheduled, resumed: k, lag });
      emit(ev, lag > 0 ? 'late' : 'record',
        `${task.name}: ${josa(`예정 ${op.beat}`, ['을', '를'])} 기록한다. 실행 가능 예정 단계 ${scheduled}, 실제 재개 단계 ${k}${lag > 0 ? ` — ${lag}단계 늦음 (설명용 단계)` : ' — 늦지 않음'}`,
        [task.id]);
      advanceTask(s, proc, task, ev);
    } else if (op.k === 'exitSem') {
      const sem = proc.sem;
      sem.value += 1;
      task.inSem = false;
      if (sem.waiters.length) {
        const wid = sem.waiters.shift();
        const w = findTask(proc, wid);
        sem.value -= 1;
        w.inSem = true;
        w.status = 'ready';
        w.pc += 1;
        w.rem = (taskOp(w) || {}).n || 1;
        L.ready.push(wid);
        emit(ev, 'sem-pass', `${task.name}: 블록을 나가며 세마포어를 반납한다. 기다리던 ${josa(w.name, ['이', '가'])} 깨어나 세마포어를 얻고 준비 상태가 된다 (내부 카운터 ${sem.value})`, [task.id, wid, `${proc.id}-sem`]);
      } else {
        emit(ev, 'sem-release', `${task.name}: 블록을 나가며 세마포어를 반납한다 (내부 카운터 ${sem.value})`, [task.id, `${proc.id}-sem`]);
      }
      advanceTask(s, proc, task, ev);
    }
    handleDropRequest(proc, th, ev);
  }

  function progressSleep(s, proc, th, ev) {
    if (th.role === 'loop') {
      const task = findTask(proc, proc.loop.current);
      task.rem -= 1;
      if (task.rem <= 0) {
        emit(ev, 'wake', `${th.name}: time.sleep()이 끝났다. Python으로 돌아가려면 GIL이 필요하다`, [th.id]);
        task.pc += 1;
        const op = taskOp(task);
        task.rem = op ? op.n || 1 : 0;
        if (!op) { finishTask(s, proc, task, ev); needPythonOrFree(proc, th); } else needPython(proc, th);
      }
      return;
    }
    th.rem -= 1;
    if (th.rem <= 0) {
      emit(ev, 'wake', `${th.name}: time.sleep() 대기가 끝났다. Python 코드로 돌아가려면 GIL이 필요하다`, [th.id]);
      advanceWorker(s, proc, th, ev);
    }
  }

  function step(s) {
    if (s.done) return null;
    s.step += 1;
    const ev = [];
    for (const proc of s.procs) if (proc.loop) decideLoop(s, proc, ev);
    for (const proc of s.procs) arbitrateGil(s, proc, ev);
    const cpus = assignCpus(s);
    const view = snapshot(s, cpus, ev);
    // 실행: CPU를 배정받은 스레드만 한 단위 진행한다. time.sleep() 대기는 CPU 없이 진행한다.
    const running = new Set(cpus.filter(Boolean));
    const sleepers = [];
    for (const proc of s.procs) {
      for (const th of proc.threads) if (th.status === 'os-sleep') sleepers.push([proc, th]);
    }
    for (const proc of s.procs) {
      for (const th of proc.threads) {
        if (!running.has(th.id)) continue;
        if (th.role === 'loop') execLoopUnit(s, proc, th, ev);
        else execWorkerUnit(s, proc, th, ev);
      }
    }
    for (const [proc, th] of sleepers) progressSleep(s, proc, th, ev);
    // GIL을 기다린 시간이 길어지면 보유 스레드에 해제 요청을 표시한다. 실제 해제는 보유 스레드가 확인 지점에 도달해야 한다.
    for (const proc of s.procs) {
      const g = proc.gil;
      if (!g.active) continue;
      for (const id of g.queue) findThread(proc, id).gilWait += 1;
      if (g.holder && g.queue.length) {
        const head = findThread(proc, g.queue[0]);
        const holder = findThread(proc, g.holder);
        if (head.gilWait >= SWITCH_WAIT && !holder.dropRequested) {
          holder.dropRequested = true;
          emit(ev, 'gil-request', `${head.name}: 기다려도 교대가 없어 ${holder.name}에 GIL 해제 요청을 표시한다 (아직 해제 전)`, [head.id, holder.id, `${proc.id}-gil`]);
        }
      }
    }
    view.after = afterSnapshot(s);
    const allDone = s.procs.every((p) => p.threads.every((t) => t.status === 'done' || t.role === 'unused'));
    if (allDone) {
      s.done = true;
      s.finishedAt = s.step;
      emit(ev, 'end', '모든 작업이 끝났다', []);
    }
    return view;
  }

  function initialView(s) {
    const cpus = new Array(s.cpus).fill(null);
    const v = snapshot(s, cpus, [{ type: 'start', text: '시작 전: 작업자들이 첫 연산을 기다린다. 풀·스레드·프로세스 생성 비용은 이 모형에 넣지 않았다', ids: [] }]);
    for (const id of Object.keys(v.threads)) {
      const t = v.threads[id];
      if (t.act !== 'unused') t.act = 'start';
    }
    v.after = afterSnapshot(s);
    return v;
  }

  // 구성 하나를 끝까지 실행해 단계별 보기를 만든다. 같은 구성은 언제나 같은 순서를 낸다.
  function simulate(input) {
    const s = createState(input);
    const views = [initialView(s)];
    while (!s.done && s.step < MAX_STEPS) views.push(step(s));
    return { cfg: s.cfg, views, finished: s.done, state: s };
  }

  return { VERSION, SCENARIOS, GIL_MODES, LOOP_ACTIONS, LOCK_SCOPES, UNITS, SWITCH_WAIT, LIMITS, DEFAULT_CONFIG,
    normalizeConfig, createState, simulate, josa };
});
