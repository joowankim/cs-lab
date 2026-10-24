/* 동시성 실행 애니메이션. model.js가 만든 단계별 상태(view)만 읽어 코드 줄·그래프·공유 상태·로그를 같은 단계로 그린다. */
(function () {
  'use strict';

  const M = window.RuntimeModel;
  const $ = (s, el = document) => el.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const STORE_KEY = 'cs-lab-runtime-viz:v1';
  const SPEEDS = [
    { label: '아주 느리게', ms: 2600 },
    { label: '느리게', ms: 1800 },
    { label: '보통', ms: 1200 },
    { label: '빠르게', ms: 700 },
    { label: '아주 빠르게', ms: 380 },
  ];

  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { stored = {}; }
  let cfg = M.normalizeConfig(stored.cfg);
  let speed = Number.isInteger(stored.speed) && SPEEDS[stored.speed] ? stored.speed : 2;
  let run = M.simulate(cfg);
  let idx = 0;
  let shown = -1;
  let timer = null;
  let selected = null;
  let lay = null;

  const view = () => run.views[idx];
  const last = () => run.views.length - 1;
  const kind = () => M.SCENARIOS[cfg.scenario].kind;
  const gilOn = () => M.GIL_MODES[cfg.gil].active;
  const moveMs = () => Math.max(160, Math.min(900, SPEEDS[speed].ms * 0.55));

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ cfg, speed })); } catch (e) { /* 저장 못 해도 동작한다 */ }
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ---------- 이름 ----------

  const shortThread = (id) => { const [p, t] = id.split('-'); return `${+p.slice(1) + 1}-${+t.slice(1) + 1}`; };
  const procName = (pid) => `프로세스 ${+pid.slice(1) + 1}`;
  function findTask(id) {
    for (const p of run.state.procs) if (p.loop) { const t = p.loop.tasks.find((x) => x.id === id); if (t) return t; }
    return null;
  }
  function taskShort(id) {
    const suf = id.split('-')[1];
    if (suf === 'main') return 'main';
    if (suf === 'A' || suf === 'B') return suf;
    return `작업${+suf.slice(3) + 1}`;
  }
  function nameOf(id) {
    if (id === 'sched') return 'OS 스케줄러';
    if (/^cpu-/.test(id)) return `논리 CPU ${+id.slice(4) + 1}`;
    if (/^p\d+$/.test(id)) return procName(id);
    if (/-t\d+$/.test(id)) return `스레드 ${shortThread(id)}`;
    const suf = id.split('-')[1];
    const map = { interp: '인터프리터', gil: 'GIL', loop: '이벤트 루프', sem: 'Semaphore', counter: '공유 counter', lock: 'threading.Lock' };
    if (map[suf]) return `${map[suf]}${cfg.processes > 1 ? ` (${procName(id.split('-')[0])})` : ''}`;
    const t = findTask(id);
    return t ? t.name : id;
  }

  // ---------- 상태 글 ----------

  const ACT = {
    'run-py': ['run', 'Python 실행'], 'run-native': ['native', '네이티브 계산'], 'cpu-wait': ['cpuwait', 'CPU 대기'],
    'gil-wait': ['gilwait', 'GIL 대기'], 'os-sleep': ['sleep', 'OS 대기'], 'lock-wait': ['lockwait', 'Lock 대기'],
    'loop-idle': ['sleep', '루프 OS 대기'], done: ['done', '완료'], start: ['start', '시작 전'], unused: ['unused', '만들지 않음'],
  };
  const TASK = {
    'not-created': ['unused', '아직 없음'], ready: ['ready', '준비됨'], running: ['run', '실행 중'], 'wait-timer': ['timer', '타이머 대기'],
    'timer-due': ['due', '예정 지남'], 'wait-sem': ['semwait', '얻기 대기'], 'wait-children': ['children', '자식 대기'], done: ['done', '완료'],
  };
  function taskState(id, v) {
    const t = v.tasks[id];
    if (!t) return 'not-created';
    if (t.status === 'wait-timer' && t.due != null && t.due < v.step) return 'timer-due';
    return t.status;
  }
  function threadText(t) {
    if (t.act === 'cpu-wait' && t.holdsGil) return 'GIL 보유 · CPU 대기';
    if (t.act === 'run-py' && !gilOn()) return 'Python 실행 · GIL 없음';
    return ACT[t.act][1];
  }

  // ---------- 배치 ----------
  // 노드 좌표는 구성마다 한 번 정한다. 단계가 바뀌어도 노드는 제자리에 있고, 간선과 조각만 바뀐다.

  function layout() {
    const P = cfg.processes;
    const T = cfg.threads;
    const k = kind();
    const pad = 18;
    const gap = 22;
    const tasksMax = Math.max(0, ...run.state.procs.map((p) => (p.loop ? p.loop.tasks.length : 0)));
    const colW = Math.max(250, T * 66 + 30, k === 'loop' ? tasksMax * 70 + 30 : 0);
    const cpuW = 76;
    const cpuGap = 12;
    const cpuSpan = 116 + cfg.cpus * (cpuW + cpuGap);
    const procSpan = P * colW + (P - 1) * gap;
    const W = Math.max(cpuSpan, procSpan) + pad * 2;
    const nodes = {};
    const boxes = [];
    // 하드웨어·OS 구역
    boxes.push({ id: 'hw', x: pad, y: 8, w: W - pad * 2, h: 82, label: '하드웨어와 OS · 모든 프로세스가 함께 쓴다' });
    const hx = pad + (W - pad * 2 - cpuSpan) / 2;
    nodes.sched = { id: 'sched', type: 'sched', shape: 'rect', x: hx + 56, y: 56, w: 96, h: 40 };
    for (let i = 0; i < cfg.cpus; i++) {
      nodes[`cpu-${i}`] = { id: `cpu-${i}`, type: 'cpu', shape: 'rect', x: hx + 116 + i * (cpuW + cpuGap) + cpuW / 2, y: 56, w: cpuW, h: 40 };
    }
    const top = 116;
    const ox = pad + (W - pad * 2 - procSpan) / 2;
    let H = 0;
    run.state.procs.forEach((proc, p) => {
      const x0 = ox + p * (colW + gap);
      const pid = proc.id;
      nodes[pid] = { id: pid, type: 'proc', shape: 'label', x: x0 + 14, y: top + 20 };
      nodes[`${pid}-interp`] = { id: `${pid}-interp`, type: 'interp', shape: 'rect', x: x0 + colW * 0.34, y: top + 62, w: 136, h: 38 };
      nodes[`${pid}-gil`] = { id: `${pid}-gil`, type: 'gil', shape: 'circle', x: x0 + colW * 0.8, y: top + 62, r: 24 };
      const ty = top + 160;
      const sp = colW / T;
      proc.threads.forEach((th, t) => {
        nodes[th.id] = { id: th.id, type: 'thread', shape: 'circle', x: x0 + sp * (t + 0.5), y: ty, r: 24 };
      });
      let bottom = ty + 60;
      if (k === 'counter') {
        nodes[`${pid}-counter`] = { id: `${pid}-counter`, type: 'counter', shape: 'rect', x: x0 + colW * 0.3, y: ty + 116, w: 134, h: 56 };
        nodes[`${pid}-lock`] = { id: `${pid}-lock`, type: 'lock', shape: 'rect', x: x0 + colW * 0.8, y: ty + 116, w: 84, h: 42 };
        bottom = ty + 160;
      }
      if (k === 'loop') {
        nodes[`${pid}-loop`] = { id: `${pid}-loop`, type: 'loop', shape: 'rect', x: x0 + colW / 2, y: ty + 104, w: 156, h: 40 };
        const n = proc.loop.tasks.length;
        const tsp = colW / n;
        proc.loop.tasks.forEach((task, j) => {
          nodes[task.id] = { id: task.id, type: 'task', shape: 'circle', x: x0 + tsp * (j + 0.5), y: ty + 206, r: 21 };
        });
        bottom = ty + 262;
        if (proc.sem) {
          nodes[`${pid}-sem`] = { id: `${pid}-sem`, type: 'sem', shape: 'rect', x: x0 + colW / 2, y: ty + 310, w: Math.max(170, cfg.semaphore * 34 + 30), h: 70 };
          bottom = ty + 350;
        }
      }
      boxes.push({ id: pid, x: x0, y: top, w: colW, h: bottom - top + 12, label: '' });
      H = Math.max(H, bottom + 24);
    });
    return { W, H, nodes, boxes };
  }

  // ---------- 그래프 만들기 (구성마다 한 번) ----------

  const nodeEls = new Map();
  const edgeEls = new Map();
  const tokEls = new Map();
  let gEdges;
  let gTokens;
  let gFx;

  function buildGraph() {
    lay = layout();
    const svg = $('#graph');
    svg.innerHTML = '';
    nodeEls.clear(); edgeEls.clear(); tokEls.clear();
    svg.setAttribute('viewBox', `0 0 ${lay.W} ${lay.H}`);
    svg.style.minWidth = `${Math.round(lay.W * 0.9)}px`;
    svg.style.maxWidth = `${Math.round(lay.W * 1.25)}px`;
    const defs = el('defs', {}, svg);
    for (const t of ['run', 'hold', 'wait', 'access', 'struct']) {
      const m = el('marker', { id: `ar-${t}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse', class: `mk mk-${t}` }, defs);
      el('path', { d: 'M0,0 L10,5 L0,10 z' }, m);
    }
    const gBoxes = el('g', { class: 'boxes' }, svg);
    for (const b of lay.boxes) {
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 12, class: `box box-${b.id === 'hw' ? 'hw' : 'proc'}` }, gBoxes);
      if (b.label) { const t = el('text', { x: b.x + 12, y: b.y + 17, class: 'box-label' }, gBoxes); t.textContent = b.label; }
    }
    gEdges = el('g', { class: 'edges' }, svg);
    const gNodes = el('g', { class: 'nodes' }, svg);
    for (const n of Object.values(lay.nodes)) {
      const g = el('g', { class: `node n-${n.type}`, 'data-id': n.id, tabindex: n.shape === 'label' ? -1 : 0, role: 'button' }, gNodes);
      if (n.shape === 'label') {
        const t = el('text', { x: n.x, y: n.y, class: 'proc-label' }, g);
        t.textContent = `${procName(n.id)} · 인터프리터 1`;
        g.setAttribute('tabindex', 0);
      } else if (n.shape === 'rect') {
        el('rect', { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: n.type === 'cpu' ? 6 : 9, class: 'shape' }, g);
        const dy = { counter: [-10, 18], sem: [-20, -5] }[n.type] || [-2, 12];
        const t = el('text', { x: n.x, y: n.y + dy[0], class: 'nl' }, g);
        t.textContent = labelFor(n);
        const s = el('text', { x: n.x, y: n.y + dy[1], class: n.type === 'counter' ? 'big' : 'ns' }, g);
        s.textContent = '';
      } else {
        el('circle', { cx: n.x, cy: n.y, r: n.r, class: 'shape' }, g);
        const t = el('text', { x: n.x, y: n.y + 4, class: 'nl' }, g);
        t.textContent = labelFor(n);
        el('text', { x: n.x, y: n.y + n.r + 15, class: 'ns' }, g);
        el('text', { x: n.x, y: n.y + n.r + 27, class: 'ns ns2' }, g);
      }
      nodeEls.set(n.id, g);
    }
    // Semaphore 내부 카운터: 초깃값만큼 상자 안에 빈 홈을 두고, 얻은 Task가 하나씩 채운다
    for (const proc of run.state.procs) {
      if (!proc.sem) continue;
      const n = lay.nodes[`${proc.id}-sem`];
      for (let j = 0; j < proc.sem.limit; j++) {
        el('circle', { cx: slotHome(n, j).x, cy: slotHome(n, j).y, r: 11, class: 'slot-home' }, nodeEls.get(n.id));
      }
    }
    gTokens = el('g', { class: 'tokens' }, svg);
    gFx = el('g', { class: 'fx' }, svg);
  }

  function labelFor(n) {
    switch (n.type) {
      case 'sched': return 'OS 스케줄러';
      case 'cpu': return `CPU ${+n.id.slice(4) + 1}`;
      case 'interp': return 'CPython 인터프리터';
      case 'gil': return 'GIL';
      case 'thread': return shortThread(n.id);
      case 'loop': return 'asyncio 이벤트 루프';
      case 'task': return taskShort(n.id);
      case 'sem': return `Semaphore(${cfg.semaphore})`;
      case 'counter': return 'counter.completed';
      case 'lock': return 'Lock';
      default: return n.id;
    }
  }
  function slotHome(n, j) {
    const span = (cfg.semaphore - 1) * 30;
    return { x: n.x - span / 2 + j * 30, y: n.y + 18 };
  }

  // ---------- 간선 ----------

  function edgesFor(v) {
    const out = [];
    const add = (from, to, type, label) => out.push({ key: `${from}>${to}>${type}`, from, to, type, label });
    const evIds = new Map();
    for (const e of v.events) for (const id of e.ids) evIds.set(`${e.type}:${id}`, true);
    v.cpus.forEach((tid, i) => { if (tid) add(`cpu-${i}`, tid, 'run', 'CPU에서 실행'); });
    for (const proc of run.state.procs) {
      const pid = proc.id;
      const g = v.gil[pid];
      for (const th of proc.threads) {
        const t = v.threads[th.id];
        if (t.act === 'unused') continue;
        if (t.act !== 'done') add(th.id, `${pid}-interp`, 'struct', '스레드 상태로 연결');
        if (g.active && t.holdsGil) add(th.id, `${pid}-gil`, 'hold', 'GIL 보유');
        if (g.active && t.act === 'gil-wait') add(th.id, `${pid}-gil`, 'wait', 'GIL 대기');
        if (t.act === 'lock-wait') add(th.id, `${pid}-lock`, 'wait', 'Lock 대기');
        if (proc.counter) {
          const touched = evIds.has(`read:${th.id}`) || evIds.has(`write:${th.id}`) || evIds.has(`lost:${th.id}`);
          add(th.id, `${pid}-counter`, touched ? 'access' : 'struct', touched ? '이번 단계에 읽거나 씀' : '같은 객체를 참조');
        }
      }
      if (proc.lock && v.after.lock[pid].owner) add(v.after.lock[pid].owner, `${pid}-lock`, 'hold', 'Lock 보유');
      if (proc.loop) {
        const lt = v.threads[`${pid}-t0`];
        if (lt.act !== 'done') add(`${pid}-t0`, `${pid}-loop`, lt.act === 'run-py' ? 'run' : 'struct', '이 스레드가 루프를 돌린다');
        for (const task of proc.loop.tasks) {
          const st = taskState(task.id, v);
          if (st === 'running') add(`${pid}-loop`, task.id, lt.act === 'run-py' ? 'run' : 'wait', '루프가 실행');
          if (st === 'ready' || st === 'timer-due') add(task.id, `${pid}-loop`, 'wait', st === 'ready' ? '실행 차례 대기' : '루프가 아직 타이머를 처리 못 함');
          if (proc.sem) {
            const s = v.after.sem[pid];
            if (s.inside.includes(task.id)) add(task.id, `${pid}-sem`, 'hold', '얻음');
            if (s.waiters.includes(task.id)) add(task.id, `${pid}-sem`, 'wait', '얻기 대기');
          }
        }
      }
    }
    return out;
  }

  function anchor(n, toward) {
    if (n.shape === 'circle') {
      const dx = toward.x - n.x;
      const dy = toward.y - n.y;
      const d = Math.hypot(dx, dy) || 1;
      return { x: n.x + (dx / d) * (n.r + 2), y: n.y + (dy / d) * (n.r + 2) };
    }
    const dx = toward.x - n.x;
    const dy = toward.y - n.y;
    const hw = n.w / 2 + 2;
    const hh = n.h / 2 + 2;
    const s = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
    return { x: n.x + dx * Math.min(1, s), y: n.y + dy * Math.min(1, s) };
  }
  function pathBetween(a, b) {
    const p = anchor(a, b);
    const q = anchor(b, a);
    if (Math.abs(p.y - q.y) > 40) {
      const my = (p.y + q.y) / 2;
      return `M${p.x},${p.y} C${p.x},${my} ${q.x},${my} ${q.x},${q.y}`;
    }
    const mx = (p.x + q.x) / 2;
    return `M${p.x},${p.y} Q${mx},${Math.min(p.y, q.y) - 34} ${q.x},${q.y}`;
  }

  function drawEdges(v, animate) {
    const list = edgesFor(v);
    const keep = new Set();
    for (const e of list) {
      const a = lay.nodes[e.from];
      const b = lay.nodes[e.to];
      if (!a || !b) continue;
      keep.add(e.key);
      let p = edgeEls.get(e.key);
      if (!p) {
        p = el('path', { class: `edge e-${e.type}`, 'marker-end': `url(#ar-${e.type})`, 'data-from': e.from, 'data-to': e.to }, gEdges);
        const t = el('title', {}, p);
        t.textContent = `${nameOf(e.from)} → ${nameOf(e.to)}: ${e.label}`;
        edgeEls.set(e.key, p);
        if (animate && e.type !== 'struct') {
          p.classList.add('enter');
          p.addEventListener('animationend', () => p.classList.remove('enter'), { once: true });
        }
      }
      p.setAttribute('d', pathBetween(a, b));
      if (e.type === 'struct') gEdges.insertBefore(p, gEdges.firstChild);
    }
    for (const [k, p] of edgeEls) if (!keep.has(k)) { p.remove(); edgeEls.delete(k); }
    markSelection();
  }

  // ---------- 노드 상태 ----------

  function setNode(id, cls, s1, s2, aria) {
    const g = nodeEls.get(id);
    if (!g) return;
    const base = g.getAttribute('class').split(' ').filter((c) => !c.startsWith('s-') && c !== 'changed').join(' ');
    const prevCls = g.dataset.state;
    g.setAttribute('class', `${base} s-${cls}`);
    if (prevCls && prevCls !== cls && !reduceMotion) {
      g.classList.add('changed');
      setTimeout(() => g.classList.remove('changed'), 650);
    }
    g.dataset.state = cls;
    const ns = g.querySelectorAll('.ns, .big');
    if (ns[0]) ns[0].textContent = s1 || '';
    if (ns[1]) ns[1].textContent = s2 || '';
    g.setAttribute('aria-label', `${nameOf(id)}: ${aria || s1 || ''}`);
  }

  function updateNodes(v) {
    const busy = v.cpus.filter(Boolean).length;
    const runnable = Object.values(v.threads).filter((t) => ['run-py', 'run-native', 'cpu-wait'].includes(t.act)).length;
    setNode('sched', 'plain', `실행 가능 ${runnable} · 배정 ${busy}`);
    v.cpus.forEach((tid, i) => setNode(`cpu-${i}`, tid ? (v.threads[tid].act === 'run-native' ? 'native' : 'run') : 'idle', tid ? `${shortThread(tid)} 실행` : '비어 있음'));
    for (const proc of run.state.procs) {
      const pid = proc.id;
      const g = v.gil[pid];
      const used = proc.threads.filter((t) => v.threads[t.id].act !== 'unused').length;
      setNode(pid, 'plain', '', '', `스레드 ${used}개`);
      setNode(`${pid}-interp`, 'plain', `스레드 상태 ${used}개`);
      // 보유자는 GIL 조각이, 대기열은 공유 상태 표가 보여 준다. 노드 아래 글은 비었을 때만 쓴다.
      if (g.active) setNode(`${pid}-gil`, g.holder ? 'held' : 'free', g.holder ? '' : '비어 있음', '', g.holder ? `${shortThread(g.holder)} 보유, 대기 ${g.queue.length}` : '비어 있음');
      else setNode(`${pid}-gil`, 'off', '꺼짐 (PYTHON_GIL=0)', '아무도 갖지 않음');
      for (const th of proc.threads) {
        const t = v.threads[th.id];
        const pr = v.after.progress && v.after.progress[th.id];
        let s2 = '';
        if (t.act === 'unused') s2 = th.reason === 'loop' ? '루프 장면' : '줄 작업 없음';
        else if (pr && kind() === 'threads') s2 = `진행 ${pr.done}/${pr.total}`;
        else if (th.role === 'loop') s2 = '루프 스레드';
        setNode(th.id, ACT[t.act][0], threadText(t), s2);
      }
      if (proc.counter) {
        const c = v.after.counter[pid];
        setNode(`${pid}-counter`, last() === idx && c.value !== c.expected ? 'wrong' : 'plain', String(c.value));
        const lk = v.after.lock[pid];
        if (lk.used) setNode(`${pid}-lock`, lk.owner ? 'held' : 'free', lk.owner ? `${shortThread(lk.owner)} 보유` : '비어 있음');
        else setNode(`${pid}-lock`, 'off', '획득하지 않음');
      }
      if (proc.loop) {
        const lt = v.threads[`${pid}-t0`];
        const cur = proc.loop.tasks.find((t) => v.tasks[t.id] && v.tasks[t.id].current);
        const s = lt.act === 'done' ? '닫힘' : lt.act === 'loop-idle' ? '타이머까지 OS 대기' : lt.act === 'os-sleep' ? '스레드가 막혀 멈춤' : cur ? `${taskShort(cur.id)} 실행` : '다음 Task 고르기';
        setNode(`${pid}-loop`, lt.act === 'os-sleep' ? 'stuck' : lt.act === 'run-py' ? 'run' : 'plain', s);
        for (const task of proc.loop.tasks) {
          const st = taskState(task.id, v);
          const tv = v.tasks[task.id];
          let s1 = TASK[st][1];
          let s2 = '';
          if (st === 'running' && lt.act === 'os-sleep') s2 = '스레드 막힘';
          if (st === 'wait-timer') s2 = `만료 @${tv.due}`;
          if (st === 'timer-due') s2 = `@${tv.due} 지남`;
          setNode(task.id, TASK[st][0], s1, s2, `${s1} ${s2}`);
        }
        if (proc.sem) {
          const s = v.after.sem[pid];
          setNode(`${pid}-sem`, 'plain', '');
          const g2 = nodeEls.get(`${pid}-sem`);
          g2.querySelector('.ns').textContent = `내부 카운터 ${s.value} · 얻기 대기 ${s.waiters.length}`;
        }
      }
    }
  }

  // ---------- 움직이는 조각 ----------

  function tokenSpecs(v) {
    const specs = [];
    v.cpus.forEach((tid, i) => specs.push({ key: `cpu${i}`, cls: 'tk-cpu', text: `C${i + 1}`, at: tid, home: `cpu-${i}`, slot: 'tl' }));
    for (const proc of run.state.procs) {
      const pid = proc.id;
      const g = v.gil[pid];
      if (g.active) specs.push({ key: `${pid}gil`, cls: `tk-gil${g.holder && v.threads[g.holder].dropRequested ? ' req' : ''}`, text: 'GIL', at: g.holder, home: `${pid}-gil`, slot: 'tr', round: true });
      if (proc.lock && v.after.lock[pid].used) specs.push({ key: `${pid}lock`, cls: 'tk-lock', text: 'Lock', at: v.after.lock[pid].owner, home: `${pid}-lock`, slot: 'br' });
      if (proc.sem) {
        const s = v.after.sem[pid];
        for (let j = 0; j < s.limit; j++) specs.push({ key: `${pid}slot${j}`, cls: 'tk-slot', text: `${j + 1}`, at: s.inside[j] || null, home: `${pid}-sem`, slot: 'br', slotIdx: j, round: true });
      }
      if (proc.loop) {
        const lt = v.threads[`${pid}-t0`];
        const cur = proc.loop.tasks.find((t) => v.tasks[t.id] && v.tasks[t.id].current);
        if (lt.act !== 'done') specs.push({ key: `${pid}turn`, cls: `tk-turn${lt.act === 'os-sleep' ? ' stuck' : ''}`, text: '▶', at: cur ? cur.id : null, home: `${pid}-loop`, slot: 'tl', round: true });
      }
    }
    return specs;
  }

  function tokenPos(sp, stackN) {
    if (!sp.at) {
      const n = lay.nodes[sp.home];
      if (sp.slotIdx != null) return slotHome(n, sp.slotIdx);
      if (n.type === 'cpu') return { x: n.x + n.w / 2 - 14, y: n.y - n.h / 2 + 2 };
      if (n.type === 'loop') return { x: n.x - n.w / 2 + 2, y: n.y - n.h / 2 };
      return { x: n.x, y: n.y };
    }
    const n = lay.nodes[sp.at];
    const r = n.r || 20;
    const k = stackN * 15;
    if (sp.slot === 'tl') return { x: n.x - r * 0.95 - k, y: n.y - r * 0.95 };
    if (sp.slot === 'tr') return { x: n.x + r * 0.95 + k, y: n.y - r * 0.95 };
    return { x: n.x + r * 0.95 + k, y: n.y + r * 0.85 };
  }

  function placeTokens(v, instant) {
    const seen = new Set();
    const stack = new Map();
    for (const sp of tokenSpecs(v)) {
      seen.add(sp.key);
      const anchorKey = `${sp.at}:${sp.slot}`;
      const n = sp.at ? stack.get(anchorKey) || 0 : 0;
      if (sp.at) stack.set(anchorKey, n + 1);
      const pos = tokenPos(sp, n);
      let g = tokEls.get(sp.key);
      const fresh = !g;
      if (fresh) {
        g = el('g', { class: 'tok' }, gTokens);
        if (sp.round) el('circle', { r: sp.cls.startsWith('tk-gil') ? 15 : 10, class: 'tk-shape' }, g);
        else el('rect', { x: -15, y: -9, width: 30, height: 18, rx: 4, class: 'tk-shape' }, g);
        el('text', { y: 4, class: 'tk-text' }, g);
        tokEls.set(sp.key, g);
      }
      g.setAttribute('class', `tok ${sp.cls}${sp.at ? '' : ' home'}`);
      g.querySelector('text').textContent = sp.text;
      if (fresh || instant || reduceMotion) {
        g.style.transition = 'none';
        g.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        void g.getBoundingClientRect();
        g.style.transition = '';
      } else {
        g.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      }
    }
    for (const [k, g] of tokEls) if (!seen.has(k)) { g.remove(); tokEls.delete(k); }
  }

  // 한 단계 앞으로 갈 때 이번 단계의 이벤트를 노드 사이를 오가는 조각으로 보낸다.
  function flyEvents(v) {
    if (reduceMotion) return;
    const flights = [];
    const num = (t) => (t.match(/= (\d+)/) || [])[1] || '';
    for (const e of v.events) {
      const [a, b] = e.ids;
      if (e.type === 'read') flights.push([b, a, `읽기 ${num(e.text)}`, 'read']);
      else if (e.type === 'write') flights.push([a, b, `쓰기 ${num(e.text)}`, 'write']);
      else if (e.type === 'lost') flights.push([a, b, `쓰기 ${num(e.text)} · 덮어씀`, 'lost']);
      else if (e.type === 'gil-request') flights.push([a, b, '해제 요청', 'req']);
      else if (e.type === 'spawn') for (const ch of e.ids.slice(1)) flights.push([a, ch, '생성', 'spawn']);
      else if (e.type === 'sem-pass') flights.push([a, b, '반납 후 깨움', 'pass']);
      else if (e.type === 'timer') flights.push([a, b, '타이머 만료', 'timer']);
      else if (e.type === 'thread-block') flights.push([a, b, '스레드 전체 멈춤', 'block']);
    }
    const dur = moveMs() * 1.5;
    flights.forEach(([from, to, text, cls], i) => {
      const a = lay.nodes[from];
      const b = lay.nodes[to];
      if (!a || !b) return;
      const path = el('path', { d: pathBetween(a, b), class: 'fx-path' }, gFx);
      const len = path.getTotalLength();
      const g = el('g', { class: `pkt pkt-${cls}` }, gFx);
      const r = el('rect', { y: -10, height: 20, rx: 10, class: 'pkt-bg' }, g);
      const t = el('text', { y: 4, class: 'pkt-text' }, g);
      t.textContent = text;
      const w = t.getComputedTextLength() + 16;
      r.setAttribute('x', -w / 2);
      r.setAttribute('width', w);
      const frames = [];
      for (let s = 0; s <= 12; s++) {
        const p = path.getPointAtLength((len * s) / 12);
        frames.push({ transform: `translate(${p.x}px, ${p.y}px)`, opacity: s === 0 || s === 12 ? 0.2 : 1 });
      }
      path.remove();
      const anim = g.animate(frames, { duration: dur, delay: i * 120, easing: 'ease-in-out', fill: 'both' });
      anim.onfinish = () => g.remove();
      anim.oncancel = () => g.remove();
    });
  }

  // ---------- 코드 ----------
  // 줄마다 on 목록을 둔다. 실행 주체(스레드·Task)의 지금 연산을 키로 바꿔 그 줄을 찾는다.

  function L(t, on) { return { t, on: on || [] }; }
  function codeFor() {
    const sc = cfg.scenario;
    if (sc === 'py') {
      const pool = cfg.processes > 1
        ? [L('def run_processes(jobs, workers, job_fn):'), L('    with ProcessPoolExecutor(max_workers=workers,'), L('                             mp_context=get_context("spawn")) as executor:'), L('        return list(executor.map(job_fn, jobs, chunksize=1))')]
        : [L('def run_threads(jobs, workers, job_fn):'), L('    with ThreadPoolExecutor(max_workers=workers) as executor:'), L('        return list(executor.map(job_fn, jobs))')];
      return {
        title: 'count_primes · 작업 나누기',
        note: '실험 코드에서 옮겼다. 계산 줄의 강조는 단계마다 루프 안을 도는 모습을 보이려고 돌린 것이다. 실제 반복 횟수와 맞지 않는다.',
        lines: [
          L('def count_primes(n: int) -> int:'), L('    count = 0'),
          L('    for candidate in range(2, n + 1):', ['py0']), L('        for divisor in range(2, isqrt(candidate) + 1):', ['py1']),
          L('            if candidate % divisor == 0:', ['py2']), L('                break'), L('        else:'),
          L('            count += 1', ['py3']), L('    return count'), L(''), ...pool,
        ],
      };
    }
    if (sc === 'native') {
      return {
        title: '네이티브 계산 (문서의 예)',
        note: '이 실험 코드에는 없고 측정하지도 않았다. hashlib 문서의 GIL 해제 설명을 바탕으로 만든 설명용 예다.',
        lines: [L('import hashlib'), L(''), L('def job(data):'), L('    h = hashlib.sha256()', ['n0']), L('    h.update(data)  # 큰 data면 계산 중 GIL을 놓는다', ['n1']), L('    return h.hexdigest()', ['n2'])],
      };
    }
    if (sc === 'tsleep') {
      return {
        title: 'run_job (io 작업)',
        note: '실험 코드에서 옮겼다.',
        lines: [L('def run_job(job: Job) -> int:'), L('    require_gil(job.expected_gil)'), L('    if job.task == "cpu":'), L('        return count_primes(job.n)'), L('    if job.task == "io":'), L('        time.sleep(job.sleep_s)', ['s0', 's1']), L('        return 1', ['s2'])],
      };
    }
    if (sc === 'counter') {
      const sc2 = cfg.lockScope;
      if (sc2 === 'none') {
        return { title: 'increment_unlocked', note: '실험 코드에서 옮겼다.', lines: [
          L('def increment_unlocked(counter, lock, yield_between):'), L('    previous = counter.completed', ['read']), L('    if yield_between:'), L('        time.sleep(0)', ['yield0']), L('    counter.completed = previous + 1', ['write'])] };
      }
      if (sc2 === 'full') {
        return { title: 'increment_candidate', note: '실험 코드에서 옮겼다. 마지막 주석 줄은 with 블록을 나갈 때 Lock을 해제하는 지점을 표시한다.', lines: [
          L('def increment_candidate(counter, lock, yield_between):'), L('    with lock:', ['lockAcquire']), L('        previous = counter.completed', ['read']), L('        if yield_between:'),
          L('            time.sleep(0)', ['yield0']), L('        counter.completed = previous + 1', ['write']), L('    # with 블록을 나가며 lock 해제', ['lockRelease'])] };
      }
      return { title: 'increment_write_only (설명용 변형)', note: '실험에서 실행하지 않은 변형이다. 쓰기만 Lock으로 감쌌을 때를 보이려고 만들었다.', lines: [
        L('def increment_write_only(counter, lock, yield_between):'), L('    previous = counter.completed', ['read']), L('    if yield_between:'), L('        time.sleep(0)', ['yield0']),
        L('    with lock:', ['lockAcquire']), L('        counter.completed = previous + 1', ['write']), L('    # with 블록을 나가며 lock 해제', ['lockRelease'])] };
    }
    if (sc === 'sem') {
      return { title: 'run_asyncio · run_async_job', note: '실험 코드에서 옮겼다. 바깥 함수 이름 줄은 줄였다.', lines: [
        L('async def run_all():'), L('    semaphore = asyncio.Semaphore(workers)'), L(''), L('    async def limited_job(job):'),
        L('        async with semaphore:', ['job:semAcquire']), L('            return await job_fn(job)'), L(''),
        L('    return await asyncio.gather(*(limited_job(job) for job in jobs))', ['main:spawn', 'main:awaitChildren', 'main:py']), L(''),
        L('async def run_async_job(job: Job) -> int:'), L('    if job.task == "io":'), L('        require_gil(job.expected_gil)'),
        L('        await asyncio.sleep(job.sleep_s)', ['job:asleep']), L('        return 1', ['job:exitSem'])] };
    }
    // loop
    const a = cfg.loopAction;
    const action = {
      blocking: [L('async def blocking_wait(work: LoopWork) -> int:', ['A:0']), L('    time.sleep(work.sleep_s)', ['A:1']), L('    return 1', ['A:2'])],
      async: [L('async def candidate_wait(work: LoopWork) -> int:', ['A:0']), L('    await asyncio.sleep(work.sleep_s)', ['A:1']), L('    return 1', ['A:2'])],
      cpu: [L('async def compute(work: LoopWork) -> int:', ['A:0']), L('    # 계산 중 await가 없다.'), L('    return sum(count_primes(work.n) for _ in range(work.cpu_jobs))', ['A:1', 'A:2'])],
      idle: [],
    }[a];
    return { title: a === 'idle' ? '루프 지연 · B만' : '루프 지연 · A와 B', note: 'A의 함수는 실험 코드에서 옮겼다. heartbeat와 main은 실험의 흐름을 줄인 설명용 코드다.', lines: [
      L('async def heartbeat():  # B'), L('    for i in range(beats):'), L('        await asyncio.sleep(period)', ['B:asleep']), L('        record(now() - scheduled)', ['B:record']), L(''),
      ...action, ...(action.length ? [L('')] : []),
      L('async def main():'), L('    b = asyncio.create_task(heartbeat())', ['main:spawn']), ...(a === 'idle' ? [] : [L('    a = asyncio.create_task(action(work))', ['main:spawn'])]),
      L(a === 'idle' ? '    await asyncio.gather(b)' : '    await asyncio.gather(b, a)', ['main:awaitChildren', 'main:py'])] };
  }

  // 실행 주체마다 [줄 키, 상태]를 정한다.
  function actors(v) {
    const out = [];
    const sc = cfg.scenario;
    const k = kind();
    for (const proc of run.state.procs) {
      if (k !== 'loop') {
        for (const th of proc.threads) {
          const t = v.threads[th.id];
          if (!t.op || t.act === 'done' || t.act === 'unused') continue;
          let key = t.op.k;
          if (sc === 'py') key = `py${Math.min(3, (t.op.n - t.op.rem) % 4)}`;
          if (sc === 'native') key = `n${t.op.i}`;
          if (sc === 'tsleep') key = `s${t.op.i}`;
          const mode = t.act === 'run-py' || t.act === 'run-native' ? 'run' : t.act === 'os-sleep' ? 'sleep' : 'wait';
          out.push({ id: th.id, label: shortThread(th.id), key, mode, why: threadText(t) });
        }
        continue;
      }
      const lt = v.threads[`${proc.id}-t0`];
      for (const task of proc.loop.tasks) {
        const st = taskState(task.id, v);
        if (st === 'not-created' || st === 'done') continue;
        const tv = v.tasks[task.id];
        const role = task.id.split('-')[1].startsWith('job') ? 'job' : task.id.split('-')[1];
        let pc = tv.op ? tv.op.pc : 0;
        if (st === 'wait-timer' || st === 'timer-due') pc = Math.max(0, pc - 1);
        const op = task.ops[pc];
        let key = role === 'A' ? `A:${pc}` : `${role}:${op ? op.k : ''}`;
        if (role === 'B' && (st === 'wait-timer' || st === 'timer-due')) key = 'B:asleep';
        let mode = 'wait';
        if (st === 'running') mode = lt.act === 'run-py' ? 'run' : lt.act === 'os-sleep' ? 'sleep' : 'wait';
        out.push({ id: task.id, label: taskShort(task.id) + (cfg.processes > 1 ? `·P${+proc.id.slice(1) + 1}` : ''), key, mode, why: TASK[st][1] });
      }
    }
    return out;
  }

  let codeCache = null;
  function renderCode(v) {
    const code = codeFor();
    const sig = JSON.stringify(code);
    const ol = $('#codeLines');
    if (sig !== codeCache) {
      codeCache = sig;
      $('#codeTitle').textContent = code.title;
      $('#codeNote').textContent = code.note;
      ol.innerHTML = code.lines.map((ln, i) => `<li data-line="${i}"><span class="ln">${i + 1}</span><code>${esc(ln.t) || ' '}</code><span class="marks"></span></li>`).join('');
    }
    const byLine = new Map();
    for (const a of actors(v)) {
      const li = code.lines.findIndex((ln) => ln.on.includes(a.key));
      if (li < 0) continue;
      if (!byLine.has(li)) byLine.set(li, []);
      byLine.get(li).push(a);
    }
    ol.querySelectorAll('li').forEach((li) => {
      const i = +li.dataset.line;
      const as = byLine.get(i) || [];
      li.className = as.some((a) => a.mode === 'run') ? 'hl-run' : as.length ? 'hl-wait' : '';
      li.querySelector('.marks').innerHTML = as.map((a) => `<span class="chip ${a.mode}" title="${esc(a.why)}">${esc(a.label)}</span>`).join('');
    });
    const firstRun = ol.querySelector('.hl-run') || ol.querySelector('.hl-wait');
    if (firstRun && timer) {
      const box = ol.getBoundingClientRect();
      const r = firstRun.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) ol.scrollTop += r.top - box.top - 40;
    }
  }

  // ---------- 공유 상태 배열 ----------

  function arrayRows(v) {
    const rows = [];
    rows.push({ key: 'cpu', label: '논리 CPU', cells: v.cpus.map((tid, i) => ({ head: `CPU ${i + 1}`, val: tid ? shortThread(tid) : '—' })) });
    for (const proc of run.state.procs) {
      const pid = proc.id;
      const pre = cfg.processes > 1 ? `${procName(pid)} · ` : '';
      const g = v.gil[pid];
      if (g.active) rows.push({ key: `${pid}gil`, label: `${pre}GIL`, cells: [{ head: '보유', val: g.holder ? shortThread(g.holder) : '—' }, ...g.queue.map((q, i) => ({ head: `대기 ${i + 1}`, val: shortThread(q) }))] });
      else rows.push({ key: `${pid}gil`, label: `${pre}GIL`, cells: [{ head: '상태', val: '꺼짐' }] });
      if (kind() === 'threads') {
        rows.push({ key: `${pid}prog`, label: `${pre}작업 진행 (단위)`, cells: proc.threads.filter((t) => v.after.progress[t.id]).map((t) => ({ head: shortThread(t.id), val: `${v.after.progress[t.id].done}/${v.after.progress[t.id].total}` })) });
      }
      if (proc.counter) {
        const c = v.after.counter[pid];
        rows.push({ key: `${pid}cnt`, label: `${pre}공유 객체`, cells: [{ head: 'completed', val: String(c.value), big: true }, { head: '기대', val: String(c.expected) }] });
        rows.push({ key: `${pid}loc`, label: `${pre}지역 변수 previous`, cells: proc.threads.map((t) => ({ head: shortThread(t.id), val: v.after.locals[t.id] == null ? '—' : String(v.after.locals[t.id]) })) });
        const lk = v.after.lock[pid];
        if (lk.used) rows.push({ key: `${pid}lock`, label: `${pre}Lock`, cells: [{ head: '보유', val: lk.owner ? shortThread(lk.owner) : '—' }, ...lk.waiters.map((w, i) => ({ head: `대기 ${i + 1}`, val: shortThread(w) }))] });
      }
      if (proc.loop) {
        const ready = proc.loop.tasks.filter((t) => taskState(t.id, v) === 'ready').map((t) => taskShort(t.id));
        rows.push({ key: `${pid}ready`, label: `${pre}준비된 Task`, cells: ready.length ? ready.map((r, i) => ({ head: `${i + 1}`, val: r })) : [{ head: '', val: '없음' }] });
        const tm = v.after.timers[pid] || [];
        rows.push({ key: `${pid}timer`, label: `${pre}타이머 (만료 단계)`, cells: tm.length ? tm.map((t, i) => ({ head: `${i + 1}`, val: `${taskShort(t.task)} @${t.due}` })) : [{ head: '', val: '없음' }] });
        if (proc.sem) {
          const s = v.after.sem[pid];
          rows.push({ key: `${pid}sem`, label: `${pre}Semaphore 얻은 Task`, cells: Array.from({ length: s.limit }, (_, j) => ({ head: `${j + 1}`, val: s.inside[j] ? taskShort(s.inside[j]) : '—' })) });
          rows.push({ key: `${pid}semw`, label: `${pre}얻기 대기`, cells: s.waiters.length ? s.waiters.map((w, i) => ({ head: `${i + 1}`, val: taskShort(w) })) : [{ head: '', val: '없음' }] });
        }
        const bt = v.after.beats[`${pid}-B`] || [];
        if (bt.length) rows.push({ key: `${pid}beat`, label: `${pre}B 재개 기록 (모형 단계)`, cells: bt.map((b) => ({ head: `예정 ${b.scheduled}`, val: `재개 ${b.resumed} · 늦음 ${b.lag}` })) });
      }
    }
    return rows;
  }

  function renderArrays(v) {
    const now = arrayRows(v);
    const prev = idx > 0 ? arrayRows(run.views[idx - 1]) : [];
    const prevMap = new Map();
    for (const r of prev) r.cells.forEach((c, i) => prevMap.set(`${r.key}:${i}`, c.val));
    $('#arrays').innerHTML = now.map((r) => `<div class="arow"><span class="alabel">${esc(r.label)}</span><span class="acells">${
      r.cells.map((c, i) => {
        const changed = idx > 0 && prevMap.get(`${r.key}:${i}`) !== c.val;
        return `<span class="cell${changed ? ' changed' : ''}${c.val === '—' || c.val === '없음' ? ' empty' : ''}${c.big ? ' big' : ''}"><small>${esc(c.head)}</small><b>${esc(c.val)}</b></span>`;
      }).join('')}</span></div>`).join('');
  }

  // ---------- 로그 ----------

  function renderLog() {
    const items = [];
    for (let s = 0; s <= idx; s++) {
      for (const e of run.views[s].events) items.push(`<li class="${s === idx ? 'now' : ''}"><span class="lstep">${s}</span>${esc(e.text)}</li>`);
    }
    const ol = $('#log');
    ol.innerHTML = items.join('');
    ol.scrollTop = ol.scrollHeight;
    const v = view();
    $('#caption').innerHTML = `<b>단계 ${idx}</b> ${v.events.length ? esc(v.events.map((e) => e.text).join(' · ')) : '이 단계에 새 이벤트 없음 (진행 중인 일을 계속한다)'}`;
  }

  // ---------- 노드 설명 ----------

  const CONCEPT = {
    sched: 'OS 스케줄러는 실행 가능한 OS 스레드에 논리 CPU를 배정한다. GIL은 모른다.',
    cpu: '논리 CPU 하나는 한 순간에 OS 스레드 하나를 실행한다. 스레드 수와 CPU 수는 다른 값이다.',
    proc: '프로세스는 주소 공간 경계다. 인터프리터, GIL, Python 객체를 따로 가진다. 일반 객체는 다른 프로세스와 자동으로 공유되지 않는다.',
    interp: '이 모형에서는 프로세스마다 인터프리터 하나다. 스레드는 스레드 상태로 이 인터프리터에 연결된다.',
    gil: 'GIL은 인터프리터마다 하나인 락이다. 이 인터프리터에서 Python 바이트코드를 실행하려면 가져야 한다. CPU를 주는 권한이 아니다.',
    thread: 'OS 스레드는 OS가 스케줄하는 실행 단위다. CPU를 배정받아야 실행하고, GIL이 켜져 있으면 Python 실행에 GIL도 필요하다.',
    loop: '이벤트 루프는 한 OS 스레드에서 준비된 Task를 하나씩 실행한다. 실행 중인 Task가 중단해야 다음 Task로 넘어간다.',
    task: 'Task는 코루틴을 감싼 asyncio 객체다. 자기 OS 스레드가 없고, 루프가 실행해 준다.',
    sem: 'asyncio.Semaphore는 동시에 안에 들어갈 수 있는 Task 수를 제한한다. 작업 수, Task 수, 스레드 수와 다른 값이다.',
    counter: '같은 프로세스의 스레드가 함께 읽고 쓰는 Python 객체다. 읽기와 쓰기 사이에 다른 스레드가 끼면 증가가 사라질 수 있다.',
    lock: 'threading.Lock은 사용자 코드가 감싼 구간만 보호한다. GIL과 다른 락이다.',
  };

  function renderInfo(v) {
    const box = $('#nodeInfo');
    if (!selected || !lay.nodes[selected]) { box.hidden = true; return; }
    const n = lay.nodes[selected];
    const g = nodeEls.get(selected);
    const st = [...g.querySelectorAll('.ns, .big')].map((t) => t.textContent).filter(Boolean).join(' · ');
    const rel = edgesFor(v).filter((e) => e.from === selected || e.to === selected)
      .map((e) => `<li><button type="button" data-pick="${esc(e.from === selected ? e.to : e.from)}">${esc(nameOf(e.from === selected ? e.to : e.from))}</button> — ${esc(e.label)}</li>`).join('');
    box.hidden = false;
    box.innerHTML = `<div class="ni-head"><b>${esc(nameOf(selected))}</b><button type="button" class="ni-close" aria-label="설명 닫기">✕</button></div>`
      + `<p class="ni-state">이 단계: ${esc(st || '—')}</p><p>${esc(CONCEPT[n.type] || '')}</p>`
      + (rel ? `<p class="ni-sub">지금 연결</p><ul>${rel}</ul>` : '<p class="ni-sub">이 단계에 연결 없음</p>');
  }

  function markSelection() {
    for (const [id, g] of nodeEls) g.classList.toggle('sel', id === selected);
    for (const p of edgeEls.values()) {
      const on = selected && (p.dataset.from === selected || p.dataset.to === selected);
      p.classList.toggle('sel', Boolean(on));
      p.classList.toggle('dim', Boolean(selected && !on));
    }
  }

  // ---------- 그리기 ----------

  function render(opts = {}) {
    const forward = !opts.rebuild && idx === shown + 1;
    document.documentElement.style.setProperty('--move', `${moveMs()}ms`);
    if (opts.rebuild) buildGraph();
    const v = view();
    updateNodes(v);
    drawEdges(v, !opts.rebuild && idx !== shown);
    placeTokens(v, opts.rebuild || Math.abs(idx - shown) > 1);
    if (forward) flyEvents(v);
    renderCode(v);
    renderArrays(v);
    renderLog();
    renderInfo(v);
    markSelection();
    $('#stepNum').textContent = idx;
    $('#stepMax').textContent = last();
    const sc = $('#scrub');
    sc.max = last();
    sc.value = idx;
    $('#first').disabled = $('#prev').disabled = idx === 0;
    $('#next').disabled = $('#last').disabled = idx === last();
    shown = idx;
  }

  function go(i) {
    idx = Math.max(0, Math.min(last(), i));
    render();
    $('#live').textContent = `단계 ${idx} / ${last()}`;
  }
  function play() {
    if (timer) { pause(); return; }
    if (idx >= last()) { idx = 0; render(); }
    const tick = () => {
      if (idx >= last()) { pause(); return; }
      idx += 1;
      render();
      timer = setTimeout(tick, SPEEDS[speed].ms);
    };
    timer = setTimeout(tick, Math.min(400, SPEEDS[speed].ms));
    syncPlay();
  }
  function pause() {
    clearTimeout(timer);
    timer = null;
    syncPlay();
  }
  function syncPlay() {
    const b = $('#play');
    b.textContent = timer ? '❚❚ 일시정지' : '▶ 재생';
    b.setAttribute('aria-pressed', timer ? 'true' : 'false');
  }

  // ---------- 설정 ----------

  function setConfig(patch) {
    pause();
    cfg = M.normalizeConfig(Object.assign({}, cfg, patch));
    run = M.simulate(cfg);
    idx = 0;
    shown = -1;
    if (selected && !document.querySelector(`#graph [data-id="${CSS.escape(selected)}"]`)) selected = null;
    save();
    syncControls();
    render({ rebuild: true });
    if (selected && !lay.nodes[selected]) { selected = null; renderInfo(view()); }
  }

  function buildControls() {
    $('#scenes').innerHTML = Object.entries(M.SCENARIOS).map(([k, s]) => `<li><button type="button" data-scene="${k}">${esc(s.label)}</button></li>`).join('');
    $('#gil').innerHTML = Object.entries(M.GIL_MODES).map(([k, g]) => `<option value="${k}">${esc(g.label)}</option>`).join('');
    $('#loopAction').innerHTML = Object.entries(M.LOOP_ACTIONS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    $('#lockScope').innerHTML = Object.entries(M.LOCK_SCOPES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    $('#scenes').addEventListener('click', (e) => { const b = e.target.closest('[data-scene]'); if (b) setConfig({ scenario: b.dataset.scene }); });
    document.querySelectorAll('[data-cfg]').forEach((c) => c.addEventListener('change', () => setConfig({ [c.dataset.cfg]: c.type === 'checkbox' ? c.checked : c.value })));
    document.querySelectorAll('.num').forEach((row) => row.addEventListener('click', (e) => {
      const b = e.target.closest('[data-d]');
      if (b) setConfig({ [row.dataset.k]: cfg[row.dataset.k] + +b.dataset.d });
    }));
  }
  function syncControls() {
    document.querySelectorAll('[data-scene]').forEach((b) => b.setAttribute('aria-current', b.dataset.scene === cfg.scenario ? 'true' : 'false'));
    $('#gil').value = cfg.gil;
    $('#loopAction').value = cfg.loopAction;
    $('#lockScope').value = cfg.lockScope;
    $('#yieldBetween').checked = cfg.yieldBetween;
    const k = kind();
    document.querySelectorAll('.num').forEach((row) => {
      const key = row.dataset.k;
      const [lo, hi] = M.LIMITS[key];
      row.querySelector('output').textContent = cfg[key];
      row.querySelector('[data-d="-1"]').disabled = cfg[key] <= lo;
      row.querySelector('[data-d="1"]').disabled = cfg[key] >= hi;
      row.hidden = (key === 'jobs' && !(k === 'threads' || cfg.scenario === 'sem')) || (key === 'semaphore' && cfg.scenario !== 'sem');
    });
    document.querySelectorAll('[data-only]').forEach((x) => { x.hidden = x.dataset.only !== (k === 'loop' ? 'loop' : k) || (x.dataset.only === 'loop' && cfg.scenario !== 'loop'); });
    $('#cfgNote').textContent = k === 'loop' ? '이 장면은 프로세스마다 루프 스레드 하나만 쓴다. 나머지 스레드는 만들지 않은 것으로 흐리게 그린다.'
      : k === 'counter' ? '스레드마다 카운터를 한 번 증가시킨다. 프로세스마다 카운터가 따로 있다.' : '작업은 작업자에게 차례로 나눠 준다.';
    const s = $('#speed');
    s.value = speed;
    s.setAttribute('aria-valuetext', SPEEDS[speed].label);
    $('#speedLabel').textContent = SPEEDS[speed].label;
  }

  function select(id) {
    selected = selected === id ? null : id;
    renderInfo(view());
    markSelection();
  }

  function bind() {
    $('#first').addEventListener('click', () => { pause(); go(0); });
    $('#prev').addEventListener('click', () => { pause(); go(idx - 1); });
    $('#next').addEventListener('click', () => { pause(); go(idx + 1); });
    $('#last').addEventListener('click', () => { pause(); go(last()); });
    $('#play').addEventListener('click', play);
    $('#scrub').addEventListener('input', (e) => { pause(); go(+e.target.value); });
    $('#speed').addEventListener('input', (e) => { speed = +e.target.value; save(); syncControls(); document.documentElement.style.setProperty('--move', `${moveMs()}ms`); });
    $('#graph').addEventListener('click', (e) => { const g = e.target.closest('[data-id]'); if (g) select(g.dataset.id); });
    $('#graph').addEventListener('keydown', (e) => {
      const g = e.target.closest('[data-id]');
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); select(g.dataset.id); }
    });
    $('#nodeInfo').addEventListener('click', (e) => {
      const p = e.target.closest('[data-pick]');
      if (p) { selected = null; select(p.dataset.pick); const g = nodeEls.get(p.dataset.pick); if (g) g.focus(); }
      if (e.target.closest('.ni-close')) { const prev = selected; selected = null; renderInfo(view()); markSelection(); const g = nodeEls.get(prev); if (g) g.focus(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight' || e.key === '.') { e.preventDefault(); pause(); go(idx + 1); }
      else if (e.key === 'ArrowLeft' || e.key === ',') { e.preventDefault(); pause(); go(idx - 1); }
      else if (e.key === 'Home') { e.preventDefault(); pause(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); pause(); go(last()); }
      else if ((e.key === ' ' && !e.target.closest('button, [data-id]')) || e.key === 'p') { e.preventDefault(); play(); }
      else if (e.key === 'Escape' && selected) { selected = null; renderInfo(view()); markSelection(); }
    });
  }

  buildControls();
  syncControls();
  bind();
  render({ rebuild: true });
  window.__runtimeViz = { get cfg() { return cfg; }, get step() { return idx; }, get selected() { return selected; }, get playing() { return Boolean(timer); } };
})();
