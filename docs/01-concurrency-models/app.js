/* 관계도 화면. 상태는 model.js의 단계별 보기(view) 하나만 읽고, 모든 표현이 같은 단계를 가리킨다. */
(function () {
  'use strict';

  const M = window.RuntimeModel;
  const C = window.RuntimeContent;
  const $ = (sel, el = document) => el.querySelector(sel);

  const ACT = {
    'run-py': { code: 'P', label: 'CPU에서 Python 실행' },
    'run-native': { code: 'N', label: 'CPU에서 네이티브 계산 · GIL 없음' },
    'cpu-wait': { code: 'C', label: '실행 가능 · CPU 배정 대기' },
    'gil-wait': { code: 'G', label: 'GIL 획득 대기' },
    'os-sleep': { code: 'S', label: 'time.sleep() 안에서 OS 대기' },
    'lock-wait': { code: 'L', label: 'Lock 획득 대기' },
    'loop-idle': { code: 'I', label: '이벤트 루프: 다음 타이머까지 OS 대기' },
    done: { code: '·', label: '완료' },
    start: { code: '', label: '시작 전' },
    unused: { code: '', label: '만들지 않음' },
  };
  const TASK = {
    'not-created': { code: '', label: '아직 만들지 않음' },
    ready: { code: 'r', label: '준비됨 · 루프의 실행 차례 대기' },
    running: { code: 'R', label: '실행 중' },
    'wait-timer': { code: 'T', label: '타이머 대기 (Task만 중단)' },
    'timer-due': { code: 'D', label: '예정 지남 · 루프가 아직 처리 못 함' },
    'wait-sem': { code: 'W', label: 'Semaphore 얻기 대기' },
    'wait-children': { code: 'J', label: '만든 Task의 완료 대기' },
    done: { code: '·', label: '완료' },
  };
  const LENSES = { structure: '구조', exec: '실행', wait: '대기', shared: '공유 상태' };
  const UNUSED_REASON = {
    'gil-off': 'free-threaded 빌드를 PYTHON_GIL=0으로 실행해 GIL이 비활성이다. 획득 절차가 바로 반환되므로 어떤 스레드도 GIL을 가지거나 기다리지 않는다. 자료구조가 있다는 것과 활성 여부는 다르다.',
    'no-loop': '이 장면은 asyncio.run()을 호출하지 않는다. 이벤트 루프·Task·Semaphore가 만들어지지 않는다.',
    'no-sem-loop': '이 장면의 Task A·B는 Semaphore를 쓰지 않는다.',
    'no-counter': '이 장면은 공유 카운터와 Lock을 쓰지 않는다.',
    'lock-none': 'Lock 범위가 "없음"이다. 실험의 counter_lab.py는 모든 함수에 같은 Lock 객체를 넘기지만, 락 없는 원본 함수는 그 Lock을 획득하지 않는다.',
    loop: 'asyncio.run()은 호출한 스레드 하나에서 이벤트 루프를 실행한다. 이 장면은 작업자 스레드를 더 만들지 않는다. "프로세스당 작업자 스레드" 설정은 스레드 장면에서 쓴다.',
    nojob: '작업 수가 작업자 수보다 적어 이 작업자에게 줄 작업이 없다. 이 모형은 이런 작업자를 만들지 않은 것으로 표시한다. ThreadPoolExecutor는 작업을 제출할 때 쉬는 스레드가 없으면 상한까지 스레드를 늘린다.',
  };

  const STORE_KEY = 'cs-lab-runtime-map:v1';
  let cfg = M.normalizeConfig(loadStored().cfg);
  let lens = LENSES[loadStored().lens] ? loadStored().lens : 'exec';
  let run = M.simulate(cfg);
  let stepIdx = 0;
  let selected = null;
  let timer = null;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function loadStored() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function store() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ cfg, lens })); } catch (e) { /* 저장하지 못해도 화면은 동작한다 */ }
  }

  const view = () => run.views[stepIdx];
  const lastIdx = () => run.views.length - 1;
  const gilActive = () => M.GIL_MODES[cfg.gil].active;
  const kind = () => M.SCENARIOS[cfg.scenario].kind;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 이름과 상태 ----------

  function threadName(id) {
    const [p, t] = id.split('-');
    return `스레드 ${+p.slice(1) + 1}-${+t.slice(1) + 1}`;
  }
  function shortThread(id) { return threadName(id).replace('스레드 ', ''); }
  function procName(pid) { return `프로세스 ${+pid.slice(1) + 1}`; }
  function taskName(id) {
    const proc = run.state.procs.find((p) => id.startsWith(`${p.id}-`));
    const t = proc && proc.loop && proc.loop.tasks.find((x) => x.id === id);
    return t ? t.name : id;
  }

  function actLabel(t) {
    if (t.act === 'run-py') return gilActive() ? 'CPU에서 Python 실행 · GIL 보유' : 'CPU에서 Python 실행 · GIL 비활성';
    if (t.act === 'cpu-wait' && t.holdsGil) return 'GIL 보유 · CPU 배정 대기';
    return ACT[t.act].label;
  }

  function taskState(id, v) {
    const t = v.tasks[id];
    if (!t) return 'not-created';
    if (t.status === 'wait-timer' && t.due != null && t.due < v.step) return 'timer-due';
    return t.status;
  }
  function taskLabel(id, v) {
    const st = taskState(id, v);
    const t = v.tasks[id];
    if (st === 'running') {
      const pid = id.split('-')[0];
      const lt = v.threads[`${pid}-t0`];
      if (lt.act === 'os-sleep') return '실행 중 · time.sleep()으로 루프 스레드 전체가 대기';
      if (lt.act === 'cpu-wait') return '실행 차례 · 루프 스레드가 CPU 배정 대기';
      if (lt.act === 'gil-wait') return '실행 차례 · 루프 스레드가 GIL 대기';
      return '실행 중 (루프 스레드에서)';
    }
    if (st === 'wait-timer') return `타이머 대기 · 단계 ${t.due} 만료`;
    if (st === 'timer-due') return `예정(단계 ${t.due}) 지남 · 루프가 아직 처리 못 함`;
    return TASK[st].label;
  }

  // ---------- 설정 ----------

  function buildControls() {
    const sc = $('#scenario');
    sc.innerHTML = Object.entries(M.SCENARIOS).map(([k, s]) => `<option value="${k}">${esc(s.label)}</option>`).join('');
    $('#gil').innerHTML = Object.entries(M.GIL_MODES).map(([k, g]) => `<option value="${k}">${esc(g.label)}</option>`).join('');
    $('#loopAction').innerHTML = Object.entries(M.LOOP_ACTIONS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    $('#lockScope').innerHTML = Object.entries(M.LOCK_SCOPES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    for (const key of ['processes', 'threads', 'cpus', 'jobs', 'semaphore']) {
      const [lo, hi] = M.LIMITS[key];
      const input = $(`#${key}`);
      input.min = lo; input.max = hi;
    }
    document.querySelectorAll('[data-cfg]').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.dataset.cfg;
        const value = el.type === 'checkbox' ? el.checked : el.value;
        setConfig({ [key]: value });
      });
    });
    document.querySelectorAll('[data-stepper]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.stepper;
        const delta = +btn.dataset.delta;
        setConfig({ [key]: cfg[key] + delta });
      });
    });
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => setConfig(JSON.parse(btn.dataset.preset), true));
    });
  }

  function syncControls() {
    $('#scenario').value = cfg.scenario;
    $('#gil').value = cfg.gil;
    $('#loopAction').value = cfg.loopAction;
    $('#lockScope').value = cfg.lockScope;
    $('#yieldBetween').checked = cfg.yieldBetween;
    for (const key of ['processes', 'threads', 'cpus', 'jobs', 'semaphore']) {
      $(`#${key}`).value = cfg[key];
      const [lo, hi] = M.LIMITS[key];
      document.querySelectorAll(`[data-stepper="${key}"]`).forEach((b) => {
        b.disabled = (+b.dataset.delta < 0 && cfg[key] <= lo) || (+b.dataset.delta > 0 && cfg[key] >= hi);
      });
    }
    const k = kind();
    toggleField('jobs', k === 'threads' || cfg.scenario === 'sem');
    toggleField('semaphore', cfg.scenario === 'sem');
    toggleField('loopAction', cfg.scenario === 'loop');
    toggleField('lockScope', k === 'counter');
    toggleField('yieldBetween', k === 'counter');
    $('#threadsNote').textContent = k === 'loop'
      ? '이 장면은 프로세스마다 루프 스레드 하나만 쓴다. 나머지는 흐리게 표시한다.'
      : (k === 'counter' ? '스레드마다 카운터를 한 번 증가시킨다.' : '작업은 작업자에게 차례로 나눠 준다.');
  }
  function toggleField(key, show) {
    const f = document.querySelector(`[data-field="${key}"]`);
    if (f) f.hidden = !show;
  }

  function setConfig(patch, fromPreset) {
    const prevStep = stepIdx;
    cfg = M.normalizeConfig(Object.assign({}, fromPreset ? M.DEFAULT_CONFIG : cfg, patch));
    run = M.simulate(cfg);
    stepIdx = fromPreset ? 0 : Math.min(prevStep, lastIdx());
    if (selected && !elementExists(selected)) selected = null;
    store();
    syncControls();
    render();
    announce(`구성을 바꿨다. 단계 ${stepIdx}/${lastIdx()}`);
  }

  function elementExists(id) {
    return Boolean(document.querySelector(`[data-id="${CSS.escape(id)}"]`)) || isKnownId(id);
  }
  function isKnownId(id) {
    if (id === 'sched' || /^cpu-\d+$/.test(id)) return +id.split('-')[1] < cfg.cpus || id === 'sched';
    const p = +((id.match(/^p(\d+)/) || [])[1]);
    if (!(p < cfg.processes)) return false;
    const t = id.match(/^p\d+-t(\d+)$/);
    if (t) return +t[1] < cfg.threads;
    if (/-(job\d+|main|A|B)$/.test(id)) return Boolean(view().tasks[id]);
    return true;
  }

  // ---------- 진행 ----------

  function go(idx) {
    stepIdx = Math.max(0, Math.min(lastIdx(), idx));
    render();
    announce(`단계 ${stepIdx}/${lastIdx()}`);
  }
  function play() {
    if (timer) { pause(); return; }
    if (stepIdx >= lastIdx()) stepIdx = 0;
    const ms = +$('#speed').value;
    timer = setInterval(() => {
      if (stepIdx >= lastIdx()) { pause(); return; }
      stepIdx += 1;
      render();
    }, ms);
    syncPlay();
  }
  function pause() {
    clearInterval(timer);
    timer = null;
    syncPlay();
  }
  function syncPlay() {
    const b = $('#play');
    b.textContent = timer ? '일시정지' : '자동 진행';
    b.setAttribute('aria-pressed', timer ? 'true' : 'false');
  }

  function announce(msg) { $('#live').textContent = msg; }

  // ---------- 관계도 ----------

  function btn(id, cls, inner, extra) {
    const sel = selected === id ? ' is-selected' : '';
    return `<button type="button" class="el ${cls}${sel}" data-id="${id}" ${extra || ''}>${inner}</button>`;
  }

  function renderDiagram() {
    const v = view();
    const elems = M.elements(cfg);
    const byId = Object.fromEntries(elems.map((e) => [e.id, e]));
    const running = v.cpus.filter(Boolean).length;
    const runnable = Object.values(v.threads).filter((t) => t.act === 'run-py' || t.act === 'run-native' || t.act === 'cpu-wait').length;
    let html = '<div class="hw" data-zone="hw">';
    html += '<div class="zone-label">하드웨어와 OS · 모든 프로세스가 함께 쓴다</div><div class="hw-row">';
    html += btn('sched', 'sched', `<span class="el-type">OS 스케줄러</span><span class="el-sub">실행 가능 ${runnable} · CPU 배정 ${running}</span>`);
    html += '<div class="cpu-row">';
    v.cpus.forEach((tid, i) => {
      const t = tid ? v.threads[tid] : null;
      const what = t ? `${shortThread(tid)} · ${t.act === 'run-native' ? '네이티브' : 'Python'}` : '비어 있음';
      html += btn(`cpu-${i}`, `cpu ${t ? 'busy' : 'idle'}`, `<span class="el-type">논리 CPU ${i + 1}</span><span class="el-sub">${esc(what)}</span>`);
    });
    html += '</div></div></div>';
    html += `<div class="procs procs-${cfg.processes}">`;
    for (const proc of run.state.procs) html += renderProcess(proc, v, byId);
    html += '</div>';
    $('#diagram').innerHTML = html;
  }

  function renderProcess(proc, v, byId) {
    const pid = proc.id;
    const g = v.gil[pid];
    const k = kind();
    const used = proc.threads.filter((t) => v.threads[t.id].act !== 'unused');
    let h = `<section class="proc" data-zone="${pid}" aria-label="${procName(pid)}">`;
    h += btn(pid, 'proc-head', `<span class="el-type">${procName(pid)}</span><span class="el-sub">주소 공간·자원 경계 · 인터프리터 1 · 스레드 ${used.length}</span>`);
    h += '<div class="proc-body">';
    // 인터프리터와 GIL
    h += '<div class="runtime-row">';
    h += btn(`${pid}-interp`, 'interp', `<span class="el-type">CPython 인터프리터</span><span class="el-sub">스레드 상태 ${used.length}개 연결</span>`);
    if (g.active) {
      const holder = g.holder ? shortThread(g.holder) : '없음';
      const req = g.holder && v.threads[g.holder].dropRequested ? ' · 해제 요청 받음' : '';
      h += btn(`${pid}-gil`, `gil ${g.holder ? 'held' : 'free'}`, `<span class="el-type">GIL</span><span class="el-sub">보유 ${esc(holder)}${req} · 대기 ${g.queue.length}</span>`);
    } else {
      h += btn(`${pid}-gil`, 'gil ghost', '<span class="el-type">GIL</span><span class="el-sub">비활성 · 사용 안 함</span>', 'aria-describedby="ghost-note"');
    }
    h += '</div>';
    // 스레드
    h += `<div class="threads" data-count="${proc.threads.length}">`;
    for (const th of proc.threads) {
      const t = v.threads[th.id];
      if (t.act === 'unused') {
        h += btn(th.id, 'thread ghost', `<span class="el-type">${esc(th.name)}</span><span class="el-sub">만들지 않음</span>`);
        continue;
      }
      const badges = [];
      if (t.cpu != null) badges.push(`<span class="badge b-cpu">CPU ${t.cpu + 1}</span>`);
      if (t.holdsGil) badges.push('<span class="badge b-gil">GIL</span>');
      if (t.dropRequested) badges.push('<span class="badge b-req">해제 요청</span>');
      if (th.role === 'loop') badges.push('<span class="badge b-loop">루프 실행</span>');
      h += btn(th.id, `thread act-${t.act}`, `<span class="el-type"><span class="code" aria-hidden="true">${ACT[t.act].code}</span>${esc(th.name)}</span>`
        + `<span class="el-state">${esc(actLabel(t))}</span>`
        + (t.label && t.act !== 'done' ? `<span class="el-sub op">${esc(t.label)}</span>` : '')
        + progressBar(th.id, v)
        + (badges.length ? `<span class="badges">${badges.join('')}</span>` : ''));
    }
    h += '</div>';
    // 이벤트 루프와 Task
    if (k === 'loop') {
      const lt = v.threads[`${pid}-t0`];
      const cur = Object.entries(v.tasks).find(([id, t]) => id.startsWith(`${pid}-`) && t.current);
      const loopSub = lt.act === 'done' ? '닫힘' : lt.act === 'loop-idle' ? '준비된 Task 없음 · 타이머 대기'
        : lt.act === 'os-sleep' ? '스레드가 막혀 루프가 돌지 못함' : cur ? `${taskName(cur[0])} 실행` : '다음 Task 고르기';
      h += `<div class="loop-box" data-zone="${pid}-loopzone">`;
      h += btn(`${pid}-loop`, 'loop', `<span class="el-type">asyncio 이벤트 루프</span><span class="el-sub">${shortThread(`${pid}-t0`)}에서 실행 · ${esc(loopSub)}</span>`);
      h += '<div class="tasks">';
      for (const task of proc.loop.tasks) {
        const st = taskState(task.id, v);
        const ghost = st === 'not-created' ? ' pending' : '';
        const tv = v.tasks[task.id];
        h += btn(task.id, `task st-${st}${ghost}`, `<span class="el-type"><span class="code" aria-hidden="true">${TASK[st].code}</span>${esc(task.name)}</span>`
          + `<span class="el-state">${esc(taskLabel(task.id, v))}</span>`
          + (tv.label && st !== 'done' && st !== 'not-created' ? `<span class="el-sub op">${esc(tv.label)}</span>` : '')
          + (v.after.tasks[task.id] && v.after.tasks[task.id].inSem ? '<span class="badges"><span class="badge b-sem">Semaphore 얻음</span></span>' : ''));
      }
      h += '</div>';
      if (cfg.scenario === 'sem') {
        const s = v.after.sem[pid];
        h += btn(`${pid}-sem`, 'sem', `<span class="el-type">asyncio.Semaphore(${s.limit})</span><span class="el-sub">단계 끝: 얻은 Task ${s.inside.length}/${s.limit} · 얻기 대기 ${s.waiters.length}</span>`);
      }
      h += '</div>';
    }
    // 공유 객체와 Lock
    if (k === 'counter') {
      const c = v.after.counter[pid];
      const lk = v.after.lock[pid];
      const locals = proc.threads.map((t) => `${shortThread(t.id)}: ${v.after.locals[t.id] == null ? '—' : v.after.locals[t.id]}`).join(' · ');
      h += `<div class="shared-box" data-zone="${pid}-shared">`;
      h += btn(`${pid}-counter`, `counter${c.value !== c.expected && stepIdx === lastIdx() ? ' wrong' : ''}`,
        `<span class="el-type">공유 객체 counter</span><span class="big-num${forwardChange(pid) ? ' bump' : ''}" aria-hidden="true">completed ${c.value}</span><span class="el-sub">단계 끝 completed = ${c.value} (기대 ${c.expected})</span><span class="el-sub op">지역 previous — ${esc(locals)}</span>`);
      if (lk.used) {
        h += btn(`${pid}-lock`, `lock ${lk.owner ? 'held' : 'free'}`, `<span class="el-type">threading.Lock</span><span class="el-sub">단계 끝 보유 ${lk.owner ? shortThread(lk.owner) : '없음'} · 대기 ${lk.waiters.length}</span>`);
      } else {
        h += btn(`${pid}-lock`, 'lock ghost', '<span class="el-type">threading.Lock</span><span class="el-sub">전달되지만 획득하지 않음</span>');
      }
      h += '</div>';
    }
    // 이 구성에서 쓰지 않는 요소
    const ghosts = ['loop', 'sem', 'counter', 'lock'].map((t) => byId[`${pid}-${t}`]).filter((e) => !e.used && !(k === 'counter' && e.type === 'lock'));
    if (ghosts.length) {
      const names = { loop: '이벤트 루프·Task', sem: 'Semaphore', counter: '공유 카운터', lock: 'Lock' };
      h += '<div class="ghost-row"><span class="ghost-label">이 구성에서 쓰지 않음</span>';
      for (const e of ghosts) h += btn(e.id, 'ghost mini', `<span class="el-type">${names[e.type]}</span>`);
      h += '</div>';
    }
    h += '</div></section>';
    return h;
  }

  // 한 단계 앞으로 왔고 카운터 값이 바뀌었으면 숫자를 튀게 한다.
  function forwardChange(pid) {
    if (stepIdx === 0 || !prevWasForward) return false;
    return run.views[stepIdx - 1].after.counter[pid].value !== view().after.counter[pid].value;
  }
  let prevWasForward = false;

  // 진행 막대는 직전 화면의 폭에서 시작해 이번 단계의 폭으로 자란다(animateBars).
  function progressBar(id, v) {
    const pr = v.after.progress && v.after.progress[id];
    if (!pr || kind() !== 'threads') return '';
    const to = Math.round((pr.done / pr.total) * 100);
    const from = lastBar.has(id) ? lastBar.get(id) : to;
    return `<span class="prog" aria-hidden="true"><i style="width:${from}%" data-to="${to}"></i></span>`
      + `<span class="sr">진행 ${pr.done}/${pr.total} 단위</span>`;
  }
  const lastBar = new Map();
  function animateBars() {
    document.querySelectorAll('#diagram .prog i').forEach((i) => {
      const id = i.closest('[data-id]').dataset.id;
      lastBar.set(id, +i.dataset.to);
      i.style.width = `${i.dataset.to}%`;
    });
  }

  // ---------- 움직이는 토큰 ----------
  // CPU·GIL·Lock·Semaphore 내부 카운터·루프의 실행 차례를 실제 조각으로 그리고, 단계마다 지금 가진 쪽으로 옮긴다.
  // 위치는 같은 단계의 view에서만 정한다. 움직이는 시간은 보기 좋게 정한 값이고 실제 시간이 아니다.

  function tokenSpecs() {
    const v = view();
    const specs = [];
    v.cpus.forEach((tid, i) => {
      specs.push({ key: `tok-cpu-${i}`, cls: 'tk-cpu', text: `CPU ${i + 1}`, target: tid || `cpu-${i}`, home: !tid, slot: 'tl',
        title: tid ? `논리 CPU ${i + 1}이 ${shortThread(tid)}에 배정됨` : `논리 CPU ${i + 1} 비어 있음` });
    });
    for (const proc of run.state.procs) {
      const pid = proc.id;
      const g = v.gil[pid];
      if (g.active) {
        const req = g.holder && v.threads[g.holder].dropRequested;
        specs.push({ key: `tok-${pid}-gil`, cls: `tk-gil${req ? ' tk-req' : ''}`, text: 'GIL', target: g.holder || `${pid}-gil`, home: !g.holder, slot: 'tr',
          title: g.holder ? `${shortThread(g.holder)}이 GIL 보유` : 'GIL 비어 있음' });
      }
      if (proc.lock && v.after.lock[pid].used) {
        const owner = v.after.lock[pid].owner;
        specs.push({ key: `tok-${pid}-lock`, cls: 'tk-lock', text: '🔒 Lock', target: owner || `${pid}-lock`, home: !owner, slot: 'br',
          title: owner ? `${shortThread(owner)}이 Lock 보유` : 'Lock 비어 있음' });
      }
      if (proc.sem) {
        const sm = v.after.sem[pid];
        for (let j = 0; j < sm.limit; j++) {
          const tid = sm.inside[j];
          specs.push({ key: `tok-${pid}-slot${j}`, cls: 'tk-slot', text: `Sem ${j + 1}`, target: tid || `${pid}-sem`, home: !tid, slot: 'br', idx: j,
            title: tid ? `${M.josa(taskName(tid), ['이', '가'])} 세마포어를 얻음` : '내부 카운터 1: 아직 얻은 Task가 없다' });
        }
      }
      if (proc.loop) {
        const cur = Object.entries(v.tasks).find(([id, t]) => id.startsWith(`${pid}-`) && t.current);
        const lt = v.threads[`${pid}-t0`];
        if (lt.act !== 'done') {
          specs.push({ key: `tok-${pid}-turn`, cls: `tk-turn${lt.act === 'os-sleep' ? ' tk-stuck' : ''}`, text: '▶ 실행 차례', target: cur ? cur[0] : `${pid}-loop`, home: !cur, slot: 'tl',
            title: cur ? `루프가 ${taskName(cur[0])}을 실행` : '루프가 다음 Task를 고름' });
        }
      }
    }
    return specs;
  }

  const tokenEls = new Map();
  function placeTokens(instant) {
    const layer = $('#tokens');
    const wrap = $('#diagramWrap').getBoundingClientRect();
    const specs = tokenSpecs();
    const seen = new Set();
    const stack = new Map();
    for (const sp of specs) {
      const target = document.querySelector(`#diagram [data-id="${CSS.escape(sp.target)}"]`);
      if (!target) continue;
      seen.add(sp.key);
      let el = tokenEls.get(sp.key);
      const fresh = !el;
      if (fresh) {
        el = document.createElement('span');
        el.className = 'token';
        layer.appendChild(el);
        tokenEls.set(sp.key, el);
      }
      el.className = `token ${sp.cls}${sp.home ? ' at-home' : ''}`;
      el.textContent = sp.text;
      el.title = sp.title;
      const r = target.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const n = stack.get(sp.target + sp.slot) || 0;
      stack.set(sp.target + sp.slot, n + 1);
      let x;
      let y;
      if (sp.home) {
        // 집 자리: 요소 오른쪽 아래 안에 나란히 둔다.
        x = r.right - wrap.left - w - 6 - n * (w + 4);
        y = r.bottom - wrap.top - h - 5;
      } else if (sp.slot === 'tl') {
        x = r.left - wrap.left - 6 + n * (w + 3);
        y = r.top - wrap.top - h / 2;
      } else if (sp.slot === 'tr') {
        x = r.right - wrap.left - w + 6 - n * (w + 3);
        y = r.top - wrap.top - h / 2;
      } else {
        x = r.right - wrap.left - w + 6 - n * (w + 3);
        y = r.bottom - wrap.top - h / 2;
      }
      if (fresh || instant) {
        el.classList.add('no-move');
        el.style.transform = `translate(${x}px, ${y}px)`;
        void el.offsetWidth;
        el.classList.remove('no-move');
        if (fresh && !instant) el.classList.add('pop');
      } else {
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
    }
    for (const [key, el] of tokenEls) {
      if (!seen.has(key)) { el.remove(); tokenEls.delete(key); }
    }
  }

  // 한 단계 앞으로 갈 때만 그 단계의 이벤트를 날아가는 조각으로 보여 준다(값 읽기·쓰기, GIL 해제 요청).
  function flyEvents(v) {
    if (reduceMotion) return;
    const layer = $('#tokens');
    const wrap = $('#diagramWrap').getBoundingClientRect();
    const at = (id) => {
      const el = document.querySelector(`#diagram [data-id="${CSS.escape(id)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - wrap.left + r.width / 2, y: r.top - wrap.top + r.height / 2 };
    };
    const flights = [];
    for (const e of v.events) {
      const [a, b] = e.ids;
      if (e.type === 'read') flights.push({ from: b, to: a, text: `읽기 ${(e.text.match(/= (\d+)/) || [])[1]}`, cls: 'fl-read' });
      if (e.type === 'write') flights.push({ from: a, to: b, text: `쓰기 ${(e.text.match(/= (\d+)/) || [])[1]}`, cls: 'fl-write' });
      if (e.type === 'lost') flights.push({ from: a, to: b, text: `덮어쓰기 ${(e.text.match(/= (\d+)/) || [])[1]}`, cls: 'fl-lost' });
      if (e.type === 'gil-request') flights.push({ from: a, to: b, text: 'GIL 해제 요청', cls: 'fl-req' });
      if (e.type === 'thread-block') flights.push({ from: b, to: b, text: '스레드 전체 멈춤', cls: 'fl-sleep' });
      if (e.type === 'spawn') for (const child of e.ids.slice(1)) flights.push({ from: a, to: child, text: '생성', cls: 'fl-spawn' });
    }
    const dur = moveMs();
    flights.forEach((f, i) => {
      const p = at(f.from);
      const q = at(f.to);
      if (!p || !q) return;
      const el = document.createElement('span');
      el.className = `flight ${f.cls}`;
      el.textContent = f.text;
      layer.appendChild(el);
      const w = el.offsetWidth / 2;
      const h = el.offsetHeight / 2;
      const lift = f.from === f.to ? -36 : -28;
      const anim = el.animate([
        { transform: `translate(${p.x - w}px, ${p.y - h}px) scale(.6)`, opacity: 0 },
        { transform: `translate(${(p.x + q.x) / 2 - w}px, ${Math.min(p.y, q.y) - h + lift}px) scale(1)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${q.x - w}px, ${q.y - h}px) scale(.9)`, opacity: 0 },
      ], { duration: dur * 1.4, delay: i * 90, easing: 'ease-in-out', fill: 'both' });
      anim.onfinish = () => el.remove();
    });
  }

  function moveMs() {
    const speed = +$('#speed').value || 900;
    return Math.max(260, Math.min(700, speed * 0.6));
  }

  // ---------- 관계선 ----------

  function relations() {
    const v = view();
    const rels = [];
    const add = (from, to, type, label, tag) => rels.push({ from, to, type, label, tag });
    v.cpus.forEach((tid, i) => { if (tid) add(`cpu-${i}`, tid, 'exec', '배정된 CPU에서 실행', 'run'); });
    for (const proc of run.state.procs) {
      const pid = proc.id;
      const g = v.gil[pid];
      for (const th of proc.threads) {
        const t = v.threads[th.id];
        if (t.act === 'unused') continue;
        add(th.id, `${pid}-interp`, 'struct', '스레드 상태로 연결', 'struct');
        if (g.active && t.holdsGil) add(th.id, `${pid}-gil`, 'sync', 'GIL 보유', 'hold');
        if (g.active && t.act === 'gil-wait') add(th.id, `${pid}-gil`, 'sync wait', 'GIL 획득 대기', 'wait');
        if (t.act === 'lock-wait') add(th.id, `${pid}-lock`, 'sync wait', 'Lock 획득 대기', 'wait');
      }
      if (proc.lock && v.after.lock[pid].owner) add(v.after.lock[pid].owner, `${pid}-lock`, 'sync', 'Lock 보유 (단계 끝)', 'hold');
      if (kind() === 'counter') {
        for (const th of proc.threads) add(th.id, `${pid}-counter`, 'access', '같은 객체를 읽고 씀', 'share');
      }
      if (proc.loop) {
        const lt = v.threads[`${pid}-t0`];
        if (lt.act !== 'done') add(`${pid}-t0`, `${pid}-loop`, 'exec', '이 스레드에서 루프 실행', 'struct');
        for (const task of proc.loop.tasks) {
          const st = taskState(task.id, v);
          if (st === 'running') add(`${pid}-loop`, task.id, 'exec', '준비된 Task 실행', 'run');
          if (st === 'ready' || st === 'timer-due') add(task.id, `${pid}-loop`, 'exec wait', st === 'ready' ? '실행 차례 대기' : '루프가 타이머를 처리해야 함', 'wait');
          if (proc.sem) {
            const s = v.after.sem[pid];
            if (s.inside.includes(task.id)) add(task.id, `${pid}-sem`, 'sync', 'Semaphore 얻음 (단계 끝)', 'hold');
            if (s.waiters.includes(task.id)) add(task.id, `${pid}-sem`, 'sync wait', '얻기 대기', 'wait');
          }
        }
      }
    }
    return rels;
  }

  const LENS_TAGS = { structure: ['struct'], exec: ['run'], wait: ['wait'], shared: ['hold', 'share'] };

  function drawLinks() {
    const svg = $('#links');
    const wrap = $('#diagramWrap');
    const box = wrap.getBoundingClientRect();
    svg.setAttribute('width', box.width);
    svg.setAttribute('height', box.height);
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const rels = relations();
    const show = rels.filter((r) => (selected ? (r.from === selected || r.to === selected) : LENS_TAGS[lens].includes(r.tag)));
    const center = (id) => {
      const el = document.querySelector(`#diagram [data-id="${CSS.escape(id)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, r };
    };
    let paths = '';
    for (const rel of show) {
      const a = center(rel.from);
      const b = center(rel.to);
      if (!a || !b) continue;
      const p1 = edgePoint(a, b, box);
      const p2 = edgePoint(b, a, box);
      const mx = (p1.x + p2.x) / 2;
      const d = Math.abs(p1.y - p2.y) > 30
        ? `M${p1.x},${p1.y} C${p1.x},${(p1.y + p2.y) / 2} ${p2.x},${(p1.y + p2.y) / 2} ${p2.x},${p2.y}`
        : `M${p1.x},${p1.y} Q${mx},${Math.min(p1.y, p2.y) - 24} ${p2.x},${p2.y}`;
      paths += `<path class="rel ${rel.type}" d="${d}" marker-end="url(#arrow-${rel.type.split(' ')[0]})"><title>${esc(rel.label)}</title></path>`;
    }
    svg.innerHTML = `<defs>${['exec', 'sync', 'struct', 'access'].map((t) => `<marker id="arrow-${t}" class="mk ${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>`).join('')}</defs>${paths}`;
  }
  function edgePoint(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const hw = a.r.width / 2;
    const hh = a.r.height / 2;
    if (dx === 0 && dy === 0) return { x: a.x, y: a.y };
    const s = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
    return { x: a.x + dx * Math.min(1, s), y: a.y + dy * Math.min(1, s) };
  }

  // ---------- 요소 강조(보기) ----------

  function markLens() {
    const v = view();
    document.body.dataset.lens = lens;
    document.querySelectorAll('#lenses [data-lens]').forEach((t) => {
      t.setAttribute('aria-pressed', t.dataset.lens === lens ? 'true' : 'false');
    });
    const rel = new Set();
    if (selected) for (const r of relations()) { if (r.from === selected) rel.add(r.to); if (r.to === selected) rel.add(r.from); }
    document.querySelectorAll('#diagram .el').forEach((el) => {
      const id = el.dataset.id;
      el.classList.toggle('is-related', rel.has(id));
      let focus = false;
      const t = v.threads[id];
      if (lens === 'exec') focus = (t && (t.act === 'run-py' || t.act === 'run-native')) || el.classList.contains('busy') || el.classList.contains('st-running') || (el.classList.contains('loop') && !el.classList.contains('ghost'));
      if (lens === 'wait') focus = (t && ['gil-wait', 'cpu-wait', 'os-sleep', 'lock-wait', 'loop-idle'].includes(t.act)) || /st-(ready|wait-timer|timer-due|wait-sem|wait-children)/.test(el.className);
      if (lens === 'shared') focus = (t && t.holdsGil) || el.classList.contains('held') || el.classList.contains('counter') || el.classList.contains('sem') || /b-sem/.test(el.innerHTML);
      if (lens === 'structure') focus = /proc-head|interp|gil|loop|sched|cpu/.test(el.className) && !el.classList.contains('ghost');
      el.classList.toggle('lens-focus', focus);
    });
  }

  // ---------- 개수 줄 ----------

  function renderCounts() {
    const v = view();
    const k = kind();
    const threads = Object.values(v.threads);
    const made = threads.filter((t) => t.act !== 'unused').length;
    const runPy = threads.filter((t) => t.act === 'run-py').length;
    const onCpu = v.cpus.filter(Boolean).length;
    const holders = Object.values(v.gil).filter((g) => g.active && g.holder).length;
    const tasks = Object.keys(v.tasks).length;
    const items = [];
    if (k === 'threads') items.push(['전체 작업', `${cfg.jobs}개`]);
    if (cfg.scenario === 'sem') items.push(['전체 작업', `${cfg.jobs}개`]);
    if (k === 'counter') items.push(['증가 호출', `${cfg.threads}회 × 프로세스 ${cfg.processes}`]);
    items.push(['작업자 스레드 설정', `${cfg.processes} × ${cfg.threads}`]);
    items.push(['만든 OS 스레드', `${made}개`]);
    items.push(['논리 CPU', `${cfg.cpus}개 · 이 단계 실행 ${onCpu}`]);
    items.push(['Python 실행 중', `${runPy}개`]);
    items.push(['인터프리터', `${cfg.processes}개`]);
    items.push(['활성 GIL', gilActive() ? `${cfg.processes}개 · 보유 ${holders}` : '0개 (비활성)']);
    items.push(['Task', k === 'loop' ? `${tasks}개 (main ${cfg.processes} 포함)` : '없음']);
    items.push(['Semaphore 상한', cfg.scenario === 'sem' ? `${cfg.semaphore} (프로세스마다)` : '없음']);
    $('#counts').innerHTML = items.map(([a, b]) => `<div class="count"><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('');
  }

  // ---------- 이번 단계의 이벤트 ----------

  function renderEvents() {
    const v = view();
    $('#stepNum').textContent = `${stepIdx}`;
    $('#stepMax').textContent = `${lastIdx()}`;
    $('#prev').disabled = stepIdx === 0;
    $('#first').disabled = stepIdx === 0;
    $('#next').disabled = stepIdx === lastIdx();
    $('#last').disabled = stepIdx === lastIdx();
    const head = stepIdx === 0 ? '시작 전' : `단계 ${stepIdx}에서 일어난 일`;
    $('#eventsHead').textContent = head;
    const list = v.events.length ? v.events : [{ text: '상태가 이어진다. 새로 일어난 이벤트는 없다.', ids: [], type: 'none' }];
    $('#events').innerHTML = list.map((e) => `<li class="ev ev-${e.type}">${esc(e.text)}${e.ids.length ? ` <span class="ev-links">${e.ids.filter((id) => !id.startsWith('cpu')).slice(0, 3).map((id) => `<button type="button" class="link-btn" data-select="${id}">${esc(nameOf(id))}</button>`).join('')}</span>` : ''}</li>`).join('');
    if (stepIdx === lastIdx() && run.finished) {
      $('#endNote').textContent = endSummary();
      $('#endNote').hidden = false;
    } else {
      $('#endNote').hidden = true;
    }
  }

  function endSummary() {
    const a = view().after;
    if (kind() === 'counter') {
      return Object.entries(a.counter).map(([pid, c]) => `${procName(pid)}: completed = ${c.value} (기대 ${c.expected})`).join(' · ')
        + ' — 이 모형이 보여 준 순서 하나의 결과다. 발생 빈도를 뜻하지 않는다.';
    }
    if (cfg.scenario === 'loop') {
      return Object.entries(a.beats).map(([id, bs]) => `${taskName(id)} (${procName(id.split('-')[0])}): ${bs.map((b) => `예정 ${b.beat} 지연 ${b.lag}단계`).join(', ')}`).join(' · ')
        + ' — 설명용 단계이며 초 단위 실측과 비례하지 않는다.';
    }
    return `모든 작업이 단계 ${lastIdx()}에서 끝났다. 단계 수는 설명용이며 실제 시간이나 속도 비율이 아니다.`;
  }

  function nameOf(id) {
    if (id === 'sched') return 'OS 스케줄러';
    if (/^cpu-/.test(id)) return `논리 CPU ${+id.split('-')[1] + 1}`;
    if (/^p\d+$/.test(id)) return procName(id);
    if (/^p\d+-t\d+$/.test(id)) return threadName(id);
    const pid = id.split('-')[0];
    const suffix = id.slice(pid.length + 1);
    const map = { interp: 'CPython 인터프리터', gil: 'GIL', loop: '이벤트 루프', sem: 'Semaphore', counter: '공유 카운터', lock: 'Lock' };
    if (map[suffix]) return `${map[suffix]}${cfg.processes > 1 ? ` (${procName(pid)})` : ''}`;
    return taskName(id);
  }

  // ---------- 타임라인 ----------

  function renderTimeline() {
    const views = run.views.slice(1, stepIdx + 1);
    const rows = [];
    for (const proc of run.state.procs) {
      const pid = proc.id;
      if (gilActive()) {
        rows.push({ id: `${pid}-gil`, name: `GIL 보유${cfg.processes > 1 ? ` · ${procName(pid)}` : ''}`, cells: views.map((v) => {
          const h = v.gil[pid].holder;
          return { code: h ? shortThread(h) : '', title: h ? `${threadName(h)}이(가) 보유` : '보유 없음', cls: h ? 'c-gil' : 'c-empty' };
        }) });
      }
      for (const th of proc.threads) {
        if (run.views[1] && run.views[1].threads[th.id].act === 'unused') continue;
        rows.push({ id: th.id, name: th.name, cells: views.map((v) => {
          const t = v.threads[th.id];
          return { code: ACT[t.act].code, title: actLabel(t), cls: `c-${t.act}${t.holdsGil ? ' c-holds' : ''}` };
        }) });
      }
      if (proc.loop) {
        for (const task of proc.loop.tasks) {
          rows.push({ id: task.id, name: task.name, task: true, cells: views.map((v) => {
            const st = taskState(task.id, v);
            return { code: TASK[st].code, title: taskLabel(task.id, v), cls: `c-t-${st}` };
          }) });
        }
      }
    }
    const head = views.map((v) => `<th scope="col" class="${v.step === stepIdx ? 'now' : ''}"><button type="button" class="col-btn" data-step="${v.step}" aria-label="단계 ${v.step}로 이동">${v.step}</button></th>`).join('');
    const body = rows.map((r) => `<tr class="${selected === r.id ? 'sel' : ''}${r.task ? ' task-row' : ''}"><th scope="row"><button type="button" class="link-btn" data-select="${r.id}">${esc(r.name)}</button></th>${r.cells.map((c, i) => `<td class="${c.cls}${i + 1 === stepIdx ? ' now' : ''}" title="단계 ${i + 1}: ${esc(c.title)}"><span class="sr">${esc(c.title)}</span><span aria-hidden="true">${esc(c.code)}</span></td>`).join('')}</tr>`).join('');
    $('#timeline').innerHTML = stepIdx === 0
      ? '<p class="muted">단계를 진행하면 지나간 단계가 여기에 쌓인다. 앞으로의 단계는 보여 주지 않는다.</p>'
      : `<table><thead><tr><th scope="col">요소</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
    const wrap = $('#timeline');
    wrap.scrollLeft = wrap.scrollWidth;
  }

  // ---------- 장면 안내 ----------

  function renderGuide() {
    const g = C.SCENES[cfg.scenario];
    const ev = (key) => {
      const e = C.EV[key];
      return `<li><span class="tag t-${e.type}">${C.TYPE_LABEL[e.type]}</span> <a href="${esc(e.href)}" target="_blank" rel="noopener">${esc(e.label)}</a></li>`;
    };
    $('#guide').innerHTML = `
      <h2>${esc(M.SCENARIOS[cfg.scenario].label)}</h2>
      <h3>관찰할 것</h3><ul>${g.observe.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
      <h3>먼저 스스로 답할 질문</h3><ul class="questions">${g.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>
      <p class="muted">이 화면은 답을 쓰지 않는다. 답과 피드백은 실험 README의 학습 확인과 복습 카드에서 확인한다.</p>
      <div class="measured"><h3><span class="tag t-measured">실측 기록</span> 실험에서 잰 값</h3>
        <ul>${g.measured.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
        <p class="muted">이 관계도의 단계 수는 이 값과 비례하지 않는다. 단계는 이벤트의 순서를 보기 위한 설명용 구간이다.</p></div>
      <h3>근거</h3><ul class="evidence">${g.evidence.map(ev).join('')}</ul>
      <h3>관련 복습 카드 (앞면)</h3><ul class="cards">${g.cards.map((id) => `<li><b>${id}</b> ${esc(C.CARDS[id] || '')}</li>`).join('')}</ul>
      <p class="muted"><a href="${esc(C.EV.anki.href)}" target="_blank" rel="noopener">카드 파일</a>의 뒷면은 에이전트가 정리한 복습용 답이다.</p>`;
  }

  // ---------- 설명 창 ----------

  function describe(id) {
    const v = view();
    const a = v.after;
    const elems = Object.fromEntries(M.elements(cfg).map((e) => [e.id, e]));
    const out = { title: nameOf(id), kind: '', used: true, why: null, concept: '', props: [], now: [], links: [], code: [], ev: [] };
    const pid = (id.match(/^p\d+/) || [])[0];
    const link = (to, label) => out.links.push({ id: to, label });

    if (id === 'sched') {
      out.kind = 'OS의 실행 관리';
      out.concept = '실행 가능한 OS 스레드에 논리 CPU의 실행 기회를 배정한다. 실행 중인 스레드를 멈추고 다른 스레드를 실행하는 문맥 교환도 맡는다.';
      out.props = ['GIL과 별개다. OS가 스레드를 CPU에서 내리는 것과 CPython이 GIL을 놓는 것은 다른 이벤트다.', 'GIL이나 Lock, time.sleep()을 기다리는 스레드는 실행 가능 상태가 아니므로 CPU에 배정하지 않는다.', '이 모형의 배정은 가장 오래 실행하지 않은 스레드부터 고르는 설명용 순환 규칙이다. 실제 OS 정책을 재현하지 않는다.'];
      const runnable = Object.entries(v.threads).filter(([, t]) => ['run-py', 'run-native', 'cpu-wait'].includes(t.act));
      out.now = [`실행 가능 ${runnable.length}개, 논리 CPU ${cfg.cpus}개, 이번 단계 배정 ${v.cpus.filter(Boolean).length}개.`];
      v.cpus.forEach((tid, i) => link(`cpu-${i}`, `논리 CPU ${i + 1}${tid ? ` → ${threadName(tid)}` : ' (비어 있음)'}`));
      out.ev = ['readmeThreads'];
    } else if (/^cpu-/.test(id)) {
      const i = +id.split('-')[1];
      const tid = v.cpus[i];
      out.kind = '하드웨어 실행 자원';
      out.concept = 'OS 스레드를 실제로 실행하는 자원이다. 같은 순간에 실행할 수 있는 스레드 수의 한도이지, 만들 수 있는 스레드 수의 한도가 아니다.';
      out.props = ['논리 CPU는 물리 코어 수와 같지 않을 수 있다.', `실험 장비(Apple M2 Pro)는 논리 CPU 12개였다. 이 화면의 ${cfg.cpus}개는 설명용 설정이다.`, 'CPU를 쓰는지와 GIL을 가졌는지는 따로 본다. GIL을 놓은 네이티브 계산도 CPU를 쓴다.'];
      out.now = [tid ? `${threadName(tid)}을(를) 실행한다 · ${v.threads[tid].act === 'run-native' ? '네이티브 계산 (GIL 없음)' : `Python 실행${gilActive() ? ' (GIL 보유)' : ' (GIL 비활성)'}`}.` : '이번 단계에 실행하는 스레드가 없다.'];
      link('sched', 'OS 스케줄러가 배정');
      if (tid) link(tid, `${threadName(tid)} 실행`);
      out.ev = ['readmeEnv', 'readmeThreads'];
      out.cards = ['01-003'];
    } else if (/^p\d+$/.test(id)) {
      out.kind = '실행 환경의 자원 경계';
      out.concept = 'OS가 관리하는 실행 환경이다. 주소 공간과 자원을 가지며, 그 안에 OS 스레드와 CPython 인터프리터가 있다.';
      out.props = ['이 화면은 프로세스마다 인터프리터 하나와 그 인터프리터의 GIL을 둔다. 실험의 ProcessPoolExecutor 구성과 같다.', '한 프로세스의 GIL은 다른 프로세스의 Python 실행을 막지 않는다.', '일반 Python 객체는 프로세스끼리 자동으로 공유되지 않는다. 주고받으려면 전달·공유 메모리 같은 명시적인 수단이 필요하다.', '프로세스·풀의 생성, 작업 전달, 결과 수집, 종료는 이 모형에 넣지 않았다. 실험은 이 비용을 따로 재지 않았다.'];
      const proc = run.state.procs.find((p) => p.id === id);
      const made = proc.threads.filter((t) => v.threads[t.id].act !== 'unused');
      out.now = [`OS 스레드 ${made.length}개 · 그중 CPU 실행 ${made.filter((t) => v.threads[t.id].cpu != null).length}개.`];
      link(`${id}-interp`, '안에 있는 인터프리터');
      if (gilActive()) link(`${id}-gil`, '이 인터프리터의 GIL');
      made.forEach((t) => link(t.id, `안에 있는 ${t.name}`));
      if (kind() === 'counter') link(`${id}-counter`, '이 프로세스만의 카운터 객체');
      out.code = ['processes'];
      out.ev = ['readmeCpu48', 'cpuData', 'docMp'];
      out.cards = ['01-006'];
    } else if (/-interp$/.test(id)) {
      out.kind = 'Python의 실행 문맥과 상태';
      out.concept = 'Python 실행 상태(모듈·객체 등)를 관리하는 런타임 단위다. OS 스레드는 스레드 상태(PyThreadState)를 통해 인터프리터에 연결되어 Python 코드를 실행한다.';
      out.props = ['프로세스와 같은 것이 아니다. 한 프로세스에 인터프리터를 여러 개 둘 수 있고, 각자 GIL을 쓰거나 메인 인터프리터의 GIL을 공유할 수 있다. 이 화면은 그 구성을 실행하지 않는다.', '스레드가 인터프리터 안에 고정 소속된 것이 아니라, 스레드 상태의 interp 포인터로 연결된다.', '인터프리터가 쓰는 GIL 참조는 하나다. 같은 인터프리터의 스레드들은 그 GIL을 공유한다.'];
      const proc = run.state.procs.find((p) => p.id === pid);
      const made = proc.threads.filter((t) => v.threads[t.id].act !== 'unused');
      out.now = [`연결된 스레드 상태 ${made.length}개. 그중 이번 단계에 Python을 실행하는 스레드 ${made.filter((t) => v.threads[t.id].act === 'run-py').length}개.`];
      if (gilActive()) link(`${pid}-gil`, '이 인터프리터가 쓰는 GIL');
      made.forEach((t) => link(t.id, `${t.name} (스레드 상태로 연결)`));
      link(pid, '이 인터프리터가 있는 프로세스');
      out.ev = ['readmeGilSource', 'srcPystate', 'docSubinterp'];
      out.cards = ['01-005', '01-007'];
    } else if (/-gil$/.test(id)) {
      out.kind = 'Python 실행에 대한 제약';
      const g = v.gil[pid];
      out.concept = '활성 구성에서 그 인터프리터의 Python 바이트코드를 실행하려면 필요한 잠금이다. CPU 사용 권한이 아니다.';
      out.props = [
        '같은 인터프리터에서 Python을 실행하는 스레드를 한 번에 하나로 제한한다. 다른 프로세스나 GIL을 놓은 네이티브 계산은 막지 않는다.',
        '계산 도중에도 교대한다. 기다리는 스레드가 간격 동안 교대를 보지 못하면 보유 스레드에 해제 요청을 표시하고, 보유 스레드가 확인 지점에서 요청을 처리해 GIL을 놓는다.',
        `요청 간격은 이 모형에서 "${M.SWITCH_WAIT}단계"로 줄였다. 실험 환경에서 읽은 sys.getswitchinterval() 0.005초는 설정값이며 실제 교대 시각을 잰 값이 아니다.`,
        'time.sleep(), GIL을 놓는 네이티브 계산, Lock 대기, 이벤트 루프의 OS 대기에서는 명시적으로 놓는다.',
        '사용자가 공유 값을 보호하는 Lock과 다르다. GIL은 읽기·계산·쓰기 묶음을 하나로 보호하지 않는다.',
      ];
      if (!g.active) {
        out.used = false;
        out.why = UNUSED_REASON['gil-off'];
        out.now = ['비활성: 보유·대기가 없다.'];
      } else {
        const holder = g.holder ? threadName(g.holder) : '없음';
        out.now = [`이 단계 동안 보유: ${holder}${g.holder && v.threads[g.holder].dropRequested ? ' · 해제 요청을 받았지만 아직 놓지 않음' : ''}.`, `획득 대기: ${g.queue.length ? g.queue.map(threadName).join(', ') : '없음'}.`];
        if (g.holder) {
          const t = v.threads[g.holder];
          if (t.cpu == null) out.now.push('보유 스레드가 이번 단계에 CPU를 받지 못했다. GIL을 가졌다고 실행 중인 것은 아니다.');
          link(g.holder, `${threadName(g.holder)} · 보유`);
        }
        g.queue.forEach((w) => link(w, `${threadName(w)} · 대기`));
      }
      link(`${pid}-interp`, '이 GIL을 쓰는 인터프리터');
      out.ev = ['readmeSwitch', 'srcGil', 'srcBytecodes', 'docSwitch', 'docFree'];
      out.cards = ['01-008', '01-009', '01-010', '01-011'];
    } else if (/^p\d+-t\d+$/.test(id)) {
      const t = v.threads[id];
      const proc = run.state.procs.find((p) => p.id === pid);
      const th = proc.threads.find((x) => x.id === id);
      out.kind = 'OS가 실행하는 단위';
      out.concept = 'OS가 CPU에서 실행시키는 단위다. CPython의 threading.Thread는 OS 스레드 하나에 대응하며, CPython은 그 스레드가 Python을 실행하기 위한 스레드 상태를 함께 관리한다.';
      out.props = ['논리 CPU 수보다 많이 만들 수 있다. 같은 순간에 실행되는 수만 CPU 수로 제한된다.', 'CPU에서 실행 중인지, GIL을 가졌는지, 무엇을 기다리는지를 따로 본다.', '이벤트 루프 장면에서는 이 스레드 하나가 루프와 모든 Task의 코드를 실행한다.'];
      if (t.act === 'unused') {
        out.used = false;
        out.why = UNUSED_REASON[t.reason];
        out.now = ['만들지 않음.'];
      } else {
        out.now = [`이 단계 동안: ${actLabel(t)}.`];
        if (t.label && t.act !== 'done') out.now.push(`실행 위치: ${t.label}.`);
        if (t.dropRequested) out.now.push('GIL 해제 요청을 받았다. CPU에서 실행해 확인 지점에 닿아야 실제로 놓는다.');
        if (th.jobs.length) out.now.push(`맡은 작업: ${th.jobs.map((j) => `작업 ${j + 1}`).join(', ')} (설명용 고정 배분).`);
        if (a.locals[id] !== undefined) out.now.push(`단계 끝 지역 변수 previous = ${a.locals[id] == null ? '아직 읽지 않음' : a.locals[id]}.`);
        if (t.cpu != null) link(`cpu-${t.cpu}`, `논리 CPU ${t.cpu + 1}에서 실행`);
        link(`${pid}-interp`, '스레드 상태로 연결된 인터프리터');
        if (gilActive()) link(`${pid}-gil`, t.holdsGil ? 'GIL 보유' : t.act === 'gil-wait' ? 'GIL 획득 대기' : 'GIL (지금은 관계 없음)');
        if (th.role === 'loop') link(`${pid}-loop`, '이 스레드에서 도는 이벤트 루프');
        if (kind() === 'counter') { link(`${pid}-counter`, '읽고 쓰는 공유 객체'); if (cfg.lockScope !== 'none') link(`${pid}-lock`, 'Lock'); }
      }
      link(pid, `${procName(pid)} 안에 있음`);
      out.code = kind() === 'counter' ? (cfg.lockScope === 'full' ? ['counterLocked', 'counterUnlocked'] : cfg.lockScope === 'write' ? ['counterWriteOnly'] : ['counterUnlocked'])
        : kind() === 'loop' ? ['asyncio'] : cfg.scenario === 'native' ? ['native'] : cfg.scenario === 'tsleep' ? ['runJob', 'threads'] : ['countPrimes', 'threads'];
      out.ev = ['readmeThreads', 'srcThread', 'docThreads'];
      if (t.reason === 'nojob') out.ev.push('docExecutor');
      out.cards = ['01-002', '01-003'];
    } else if (/-loop$/.test(id)) {
      out.kind = '프로그램 수준의 비동기 실행 관리';
      out.concept = '자신이 실행되는 OS 스레드에서 준비된 Task와 콜백을 실행하는 코드다. 스레드 풀의 관리자가 아니다.';
      out.props = ['실행 중인 Task를 강제로 멈추지 않는다. Task가 미완료 대기에서 실행을 중단하거나 끝나야 실행 흐름이 루프로 돌아온다.', '루프로 돌아오면 만료된 타이머를 처리해 해당 Task를 준비 상태로 바꾸고, 준비된 Task를 차례로 실행한다.', '실행할 Task가 없으면 다음 타이머까지 OS 대기에 들어간다.', 'GIL을 꺼도 루프 스레드는 하나다. GIL 교대와 Task 교대는 다른 규칙이다.'];
      const e = elems[id];
      if (!e.used) { out.used = false; out.why = UNUSED_REASON[e.reason]; out.now = ['없음.']; }
      else {
        const lt = v.threads[`${pid}-t0`];
        const timers = a.timers[pid] || [];
        out.now = [`루프 스레드(${threadName(`${pid}-t0`)}): ${actLabel(lt)}.`, `단계 끝 대기 중 타이머: ${timers.length ? timers.map((tm) => `${taskName(tm.task)} 단계 ${tm.due}`).join(', ') : '없음'}.`];
        link(`${pid}-t0`, `${threadName(`${pid}-t0`)}에서 실행`);
        Object.keys(v.tasks).filter((tid) => tid.startsWith(`${pid}-`)).forEach((tid) => link(tid, `${taskName(tid)} · ${taskLabel(tid, v)}`));
      }
      out.code = ['asyncio'];
      out.ev = ['docAsyncioThreads', 'srcBase', 'readmeAsyncioCpu', 'readmeTrace'];
      out.cards = ['01-015', '01-018', '01-019'];
    } else if (/-sem$/.test(id)) {
      out.kind = '프로그램이 거는 진입 제한';
      out.concept = 'async with 블록에 들어가 아직 나오지 않은 Task 수의 상한이다. Task 총개수나 OS 스레드 수가 아니다.';
      out.props = ['내부 카운터가 0보다 크면 진입(acquire)의 await가 중단 없이 바로 이어진다. 카운터가 0일 때만 Task가 중단하고 기다린다.', '블록을 나가며 세마포어를 반납하면(release) 기다리던 Task 하나가 깨어나 세마포어를 얻고 준비 상태가 된다.', '기다리는 것은 Task 하나다. 루프 스레드는 다른 준비된 Task를 실행한다.'];
      const e = elems[id];
      if (!e.used) { out.used = false; out.why = UNUSED_REASON[e.reason]; out.now = ['없음.']; }
      else {
        const s = a.sem[pid];
        out.now = [`단계 끝: 얻은 Task ${s.inside.length}/${s.limit}, 내부 카운터 ${s.value}, 얻기 대기 ${s.waiters.length}.`, `같은 프로세스의 Task ${Object.keys(v.tasks).filter((t) => t.startsWith(`${pid}-`)).length}개 · 루프 스레드 1개.`];
        s.inside.forEach((t) => link(t, `${taskName(t)} · 얻음`));
        s.waiters.forEach((t) => link(t, `${taskName(t)} · 얻기 대기`));
        link(`${pid}-loop`, '이 Semaphore를 쓰는 루프');
      }
      out.code = ['asyncio'];
      out.ev = ['docSemaphore', 'srcLocks', 'readmeTrace'];
      out.cards = ['01-016', '01-021', '01-022'];
    } else if (/-counter$/.test(id)) {
      out.kind = '프로그램이 보호할 대상';
      out.concept = '같은 프로세스의 스레드들이 함께 읽고 쓰는 공유 객체다. 스레드마다 읽어 둔 지역 변수 previous는 따로 있다.';
      out.props = ['두 스레드가 같은 이전 값을 읽으면, 쓰기가 차례로 일어나도 증가가 유실된다. Python 코드를 동시에 실행하지 않아도 생긴다.', '다른 프로세스의 카운터는 별개 객체다. 프로세스를 늘려도 자동으로 공유되지 않는다.', '이 모형이 보여 주는 순서는 가능한 순서 하나다. 발생 확률을 뜻하지 않는다.'];
      const e = elems[id];
      if (!e.used) { out.used = false; out.why = UNUSED_REASON[e.reason]; out.now = ['없음.']; }
      else {
        const c = a.counter[pid];
        out.now = [`단계 끝 completed = ${c.value} (기대 ${c.expected}).`];
        run.state.procs.find((p) => p.id === pid).threads.forEach((t) => {
          out.now.push(`${t.name}의 previous = ${a.locals[t.id] == null ? '아직 읽지 않음' : a.locals[t.id]}`);
          link(t.id, `${t.name} · 읽고 씀`);
        });
        if (cfg.lockScope !== 'none') link(`${pid}-lock`, '보호에 쓰는 Lock');
      }
      out.code = ['counterUnlocked', 'counterLocked'];
      out.ev = ['readmeCounter', 'counterData', 'counterCode'];
      out.cards = ['01-023', '01-024', '01-027'];
    } else if (/-lock$/.test(id)) {
      out.kind = '사용자가 거는 동기화';
      out.concept = '코드에서 정한 구간을 한 번에 한 스레드만 실행하게 하는 threading.Lock이다. GIL과 별개다.';
      out.props = ['보호 범위는 코드가 정한다. 읽기부터 쓰기까지 같은 Lock으로 감싸야 그 사이에 다른 증가가 끼어들지 못한다.', 'Lock을 기다리는 스레드는 GIL을 놓고 기다린다.', 'with 블록은 정상 반환이나 예외에서도 Lock을 해제한다.', '이 모형은 해제 때 기다리던 첫 스레드가 넘겨받게 했다. 실제 Lock은 어느 스레드가 먼저 진행할지 정하지 않는다.'];
      const e = elems[id];
      if (!e.used) { out.used = false; out.why = UNUSED_REASON[e.reason]; out.now = ['획득하지 않음.']; }
      else {
        const lk = a.lock[pid];
        out.now = [`범위: ${M.LOCK_SCOPES[cfg.lockScope]}.`, `단계 끝 보유: ${lk.owner ? threadName(lk.owner) : '없음'} · 대기: ${lk.waiters.length ? lk.waiters.map(threadName).join(', ') : '없음'}.`];
        if (lk.owner) link(lk.owner, `${threadName(lk.owner)} · 보유`);
        lk.waiters.forEach((w) => link(w, `${threadName(w)} · 대기`));
        link(`${pid}-counter`, '보호하는 공유 객체');
      }
      out.code = cfg.lockScope === 'write' ? ['counterWriteOnly'] : ['counterLocked'];
      out.ev = ['readmeLockApi', 'docLock', 'docLockWith'];
      out.cards = ['01-024', '01-025'];
    } else {
      // Task
      const st = taskState(id, v);
      const proc = run.state.procs.find((p) => p.id === pid);
      const task = proc.loop.tasks.find((t) => t.id === id);
      out.kind = '코루틴의 실행·중단·재개를 관리하는 객체';
      out.concept = 'Task는 OS 스레드가 아니다. GIL을 얻는 것은 루프 스레드이고, Task끼리 GIL을 넘겨받지 않는다.';
      out.props = ['await asyncio.sleep()은 타이머를 등록하고 이 Task만 중단한다. 다른 작업자 스레드에 대기를 맡기지 않는다.', 'await가 항상 중단하는 것은 아니다. 기다릴 대상이 이미 준비돼 있으면 중단 없이 이어진다.', '타이머가 만료돼도 루프가 그 타이머를 처리하고 이 Task를 실행해야 재개된다.'];
      if (st === 'not-created') { out.now = ['아직 만들지 않음: main Task가 이 Task를 만들기 전이다.']; }
      else {
        out.now = [`이 단계 동안: ${taskLabel(id, v)}.`];
        if (v.tasks[id].label && st !== 'done') out.now.push(`다음 연산: ${v.tasks[id].label}.`);
        const bs = a.beats[id];
        if (bs) bs.forEach((b) => out.now.push(`예정 ${b.beat}: 실행 가능 예정 단계 ${b.scheduled}, 재개 단계 ${b.resumed}, 지연 ${b.lag}단계 (설명용).`));
      }
      link(`${pid}-loop`, st === 'running' ? '이 Task를 실행하는 루프' : '이 Task를 관리하는 루프');
      link(`${pid}-t0`, '코드가 실행되는 OS 스레드');
      if (cfg.scenario === 'sem' && task.role === 'job') link(`${pid}-sem`, 'Semaphore');
      if (task.parent) link(task.parent, '이 Task를 만든 main Task');
      task.children.forEach((c) => link(c, `만든 Task: ${taskName(c)}`));
      out.code = task.role === 'job' ? ['asyncJob', 'asyncio'] : task.role === 'main' ? ['asyncio'] : ['loop'];
      out.ev = ['srcTasks', 'readmeLoopExplain', 'docAsyncioThreads'];
      out.cards = ['01-015', '01-016', '01-017'];
    }
    return out;
  }

  function renderDetails() {
    const panel = $('#details');
    if (!selected) {
      panel.innerHTML = `<div class="details-empty"><h2>요소를 고르면 설명이 나온다</h2><p>관계도의 상자나 타임라인의 이름을 누른다. 키보드는 Tab으로 이동하고 Enter로 고른다.</p>
        <p class="muted">관계선은 지금 보기(${LENSES[lens]})에 맞는 것만 그린다. 요소를 고르면 그 요소의 관계만 그린다.</p></div>`;
      document.body.classList.remove('sheet-open');
      return;
    }
    const d = describe(selected);
    const code = (d.code || []).map((k) => `<pre><code>${esc(C.CODE[k])}</code></pre>`).join('');
    const ev = (d.ev || []).map((k) => { const e = C.EV[k]; return `<li><span class="tag t-${e.type}">${C.TYPE_LABEL[e.type]}</span> <a href="${esc(e.href)}" target="_blank" rel="noopener">${esc(e.label)}</a></li>`; }).join('');
    const cards = (d.cards || []).map((id) => `<li><b>${id}</b> ${esc(C.CARDS[id] || '')}</li>`).join('');
    panel.innerHTML = `
      <div class="details-head">
        <div><p class="kind">${esc(d.kind)}</p><h2 id="detailsTitle" tabindex="-1">${esc(d.title)}</h2>
        <p class="use ${d.used ? 'on' : 'off'}">${d.used ? '이 구성에서 사용' : '이 구성에서 사용 안 함'}</p></div>
        <div class="sheet-nav"><button type="button" class="close" data-nav="-1" aria-label="이전 단계" ${stepIdx === 0 ? 'disabled' : ''}>◀</button><button type="button" class="close" data-nav="1" aria-label="다음 단계" ${stepIdx === lastIdx() ? 'disabled' : ''}>▶</button><button type="button" class="close" id="closeDetails" aria-label="설명 닫기">닫기</button></div>
      </div>
      ${d.why ? `<section class="why"><h3>왜 쓰지 않나</h3><p>${esc(d.why)}</p></section>` : ''}
      <section><h3>개념</h3><p>${esc(d.concept)}</p></section>
      <section><h3>주요 특성</h3><ul>${d.props.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></section>
      <section class="nowbox"><h3>현재 상태 · 단계 ${stepIdx}</h3><ul>${d.now.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        <p class="muted">"이 단계 동안"은 구간 안의 실행·대기, "단계 끝"은 구간을 마친 뒤의 값이다.</p></section>
      ${d.links.length ? `<section><h3>연결된 요소</h3><ul class="conn">${d.links.map((l) => `<li><button type="button" class="link-btn" data-select="${l.id}">${esc(l.label)}</button></li>`).join('')}</ul></section>` : ''}
      ${code ? `<section><h3>관련 코드</h3>${code}</section>` : ''}
      <section><h3>근거</h3><ul class="evidence">${ev}</ul></section>
      ${cards ? `<section><h3>관련 복습 카드 (앞면)</h3><ul class="cards">${cards}</ul></section>` : ''}`;
    document.body.classList.add('sheet-open');
  }

  // ---------- 전체 그리기 ----------

  let guideFor = '';
  let shownStep = -1;
  let shownRun = null;
  function render() {
    if (guideFor !== cfg.scenario) { renderGuide(); guideFor = cfg.scenario; }
    const forward = shownRun === run && stepIdx === shownStep + 1;
    if (shownRun !== run) lastBar.clear();
    else if (stepIdx < shownStep) for (const k of lastBar.keys()) lastBar.delete(k);
    const sameRun = shownRun === run;
    prevWasForward = forward;
    shownStep = stepIdx;
    shownRun = run;
    document.documentElement.style.setProperty('--move', `${moveMs()}ms`);
    renderDiagram();
    renderCounts();
    renderEvents();
    renderTimeline();
    renderDetails();
    markLens();
    placeTokens(!sameRun);
    requestAnimationFrame(() => {
      drawLinks();
      animateBars();
      if (forward) flyEvents(view());
    });
  }

  function setLens(next) {
    lens = next;
    store();
    markLens();
    drawLinks();
    renderDetails();
    announce(`보기: ${LENSES[lens]}`);
  }

  function select(id, focusPanel) {
    selected = selected === id && !focusPanel ? null : id;
    render();
    if (selected) {
      announce(`${nameOf(selected)} 선택`);
      if (focusPanel) { const t = $('#detailsTitle'); if (t) t.focus({ preventScroll: false }); }
      const el = document.querySelector(`#diagram [data-id="${CSS.escape(selected)}"]`);
      if (el && !focusPanel) el.focus({ preventScroll: true });
    }
  }

  function bind() {
    $('#diagram').addEventListener('click', (e) => {
      const el = e.target.closest('.el');
      if (el) select(el.dataset.id, false);
    });
    document.addEventListener('click', (e) => {
      const s = e.target.closest('[data-select]');
      if (s) { select(s.dataset.select, true); return; }
      const nav = e.target.closest('[data-nav]');
      if (nav) { pause(); go(stepIdx + +nav.dataset.nav); return; }
      const col = e.target.closest('[data-step]');
      if (col) go(+col.dataset.step);
      if (e.target.closest('#closeDetails')) { const prev = selected; selected = null; render(); const el = document.querySelector(`#diagram [data-id="${CSS.escape(prev)}"]`); if (el) el.focus(); }
    });
    $('#first').addEventListener('click', () => { pause(); go(0); });
    $('#prev').addEventListener('click', () => { pause(); go(stepIdx - 1); });
    $('#next').addEventListener('click', () => { pause(); go(stepIdx + 1); });
    $('#last').addEventListener('click', () => { pause(); go(lastIdx()); });
    $('#play').addEventListener('click', play);
    $('#speed').addEventListener('change', () => { if (timer) { pause(); play(); } });
    document.querySelectorAll('#lenses [data-lens]').forEach((t) => {
      t.addEventListener('click', () => setLens(t.dataset.lens));
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === '.' || e.key === 'n' || (e.key === 'ArrowRight' && !e.target.closest('.el'))) { e.preventDefault(); pause(); go(stepIdx + 1); }
      else if (e.key === ',' || e.key === 'b' || (e.key === 'ArrowLeft' && !e.target.closest('.el'))) { e.preventDefault(); pause(); go(stepIdx - 1); }
      else if (e.key === 'Home') { e.preventDefault(); pause(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); pause(); go(lastIdx()); }
      else if (e.key === 'p') { e.preventDefault(); play(); }
      else if (['1', '2', '3', '4'].includes(e.key)) setLens(Object.keys(LENSES)[+e.key - 1]);
      else if (e.key === 'Escape' && selected) { const prev = selected; selected = null; render(); const el = document.querySelector(`#diagram [data-id="${CSS.escape(prev)}"]`); if (el) el.focus(); }
    });
    let raf = 0;
    const redraw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { drawLinks(); placeTokens(true); }); };
    window.addEventListener('resize', redraw);
    if (window.ResizeObserver) new ResizeObserver(redraw).observe($('#diagramWrap'));
    if (reduceMotion) document.body.classList.add('reduce-motion');
  }

  buildControls();
  syncControls();
  bind();
  render();
  window.__runtimeMap = { get cfg() { return cfg; }, get step() { return stepIdx; }, get selected() { return selected; }, get lens() { return lens; } };
})();
