/*
 * 동시성 관계도 시험판: 위에는 전체 지도 하나, 아래에는 고른 장면의 관계도.
 * 세 장면 모두 model.js가 만든 단계 기록을 그대로 그린다. 장면마다 그 장면에 필요한 요소만 그리고,
 * 같은 요소는 지도와 장면에서 같은 모양으로 그린다(CPU 칩, 스레드 원, GIL 꼬리표, Task 알약, 객체 상자).
 * 스레드의 실행 여부(채움, CPU 선)는 그 단계 동안의 상태이고, 값과 자원(counter, previous, Lock, GIL,
 * Task가 놓인 칸과 알약 모양, 타이머, Semaphore를 얻은 Task)은 그 단계가 끝난 뒤의 상태다.
 * 연결선은 두 끝에서 세로로 나가고 들어오는 곡선으로 그린다.
 * 그림 요소마다 뜻은 하나다: 테두리 상자는 무엇이 무엇 안에 있는지, 옅은 칸은 Task가 머무는 곳, 모양은 종류, 채움과 점선은 실행 상태.
 * 단계는 이벤트의 순서이고 시간 길이가 아니다.
 */
(function () {
  'use strict';

  const M = window.RuntimeModel;
  const RC = window.RuntimeContent || { SCENES: {}, CODE: {} };
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const motionOff = window.matchMedia('(prefers-reduced-motion: reduce)');

  const SPEEDS = [{ label: '느리게', ms: 2000 }, { label: '보통', ms: 1200 }, { label: '빠르게', ms: 600 }];
  const MOVE_MS = 280;
  const SCENE_KEY = 'runtime-board-scene';

  // 장면마다 고정하는 구성(base), 처음 구성(start), 바꿀 수 있는 범위(range, 모형의 한도보다 좁다),
  // 전체 지도에서 진하게 그릴 부분(parts)을 둔다. 루프 장면은 실험처럼 OS 스레드 하나에서 루프를 돌린다.
  const SCENES = {
    counter: {
      label: '공유 카운터와 Lock',
      base: { scenario: 'counter', processes: 1 },
      start: {},
      range: { threads: [2, 4], cpus: [1, 4] },
      guessKey: 'runtime-board-counter-guess',
      parts: ['cpu', 'gil', 'th0', 'th1', 'th2', 'counter', 'lock'],
    },
    loop: {
      label: '루프 지연',
      base: { scenario: 'loop', processes: 1, threads: 1 },
      start: { cpus: 2, loopAction: 'blocking' },
      range: { cpus: [1, 4] },
      guessKey: 'runtime-board-loop-guess',
      parts: ['cpu', 'gil', 'th0', 'link', 'loop', 'task'],
    },
    sem: {
      label: 'Task와 Semaphore',
      base: { scenario: 'sem', processes: 1, threads: 1 },
      start: { cpus: 2, jobs: 4, semaphore: 2 },
      range: { cpus: [1, 4], jobs: [1, 6], semaphore: [1, 4] },
      guessKey: 'runtime-board-sem-guess',
      parts: ['cpu', 'gil', 'th0', 'link', 'loop', 'task', 'sem'],
    },
  };
  const STEPPERS = { threads: '스레드', cpus: '논리 CPU', jobs: '작업 수' };

  // 띠 칸에 적는 글자: 그 단계에 실행한 연산
  const OP_MARK = { read: '읽', write: '쓰', yield0: '0', lockAcquire: '잠', lockRelease: '풀' };
  const TASK_MARK = { spawn: '생', asleep: '타', record: '기', semAcquire: '얻', exitSem: '반' };
  // 설명 한 문장으로 고를 이벤트의 순서
  const PRIORITY = {
    counter: ['lost', 'write', 'read', 'lock-wait', 'lock-take', 'lock-release', 'gil-request', 'gil-release', 'gil-take', 'done', 'end', 'start'],
    loop: ['late', 'thread-block', 'spawn', 'sem-wait', 'sem-pass', 'task-suspend', 'record', 'sem-enter', 'sem-release', 'task-done',
      'task-ready', 'wake', 'loop-idle', 'loop-run', 'timer', 'done', 'gil-request', 'gil-release', 'gil-take', 'end', 'start'],
  };

  let scene = 'counter';
  const cfgs = {};
  let cfg = null;
  let run = null;
  let track = null;
  let idx = 0;
  let shown = -1;
  let speed = 1;
  let timer = null;
  let geo = null;
  let codeSig = null;

  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 저장하지 못해도 화면은 그대로 쓴다 */ } },
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function short(id) { const m = /^p(\d+)-t(\d+)$/.exec(id); return m ? `${+m[1] + 1}-${+m[2] + 1}` : id; }
  function taskShort(id) {
    const suf = id.split('-')[1];
    if (suf === 'main' || suf === 'A' || suf === 'B') return suf;
    return `작업${+suf.slice(3) + 1}`;
  }
  function taskLabel(id) {
    const s = taskShort(id);
    return s === 'A' || s === 'B' ? `Task ${s}` : `${s} Task`;
  }
  function roleOf(id) { const suf = id.split('-')[1]; return suf.startsWith('job') ? 'job' : suf; }
  function el(tag, attrs, parent, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function isLoop() { return scene !== 'counter'; }
  function view() { return run.views[idx]; }
  function proc() { return run.state.procs[0]; }
  function threadIds() { return proc().threads.map((t) => t.id); }
  function loopThread() { return proc().threads[0]; }
  function lastIdx() { return run.views.length - 1; }

  // 스레드 상태는 넷으로 줄인다. 기다릴 때만 이유를 한 낱말로 붙인다.
  function stateOf(t) {
    switch (t.act) {
      case 'run-py': case 'run-native': return { cls: 'run', name: '실행 중', why: '' };
      case 'gil-wait': return { cls: 'turn', name: '차례 기다림', why: 'GIL 차례' };
      case 'cpu-wait': return { cls: 'turn', name: '차례 기다림', why: 'CPU 차례' };
      case 'start': return { cls: 'turn', name: '차례 기다림', why: '시작 전' };
      case 'lock-wait': return { cls: 'event', name: '이벤트 기다림', why: 'Lock 대기' };
      case 'os-sleep': return { cls: 'event', name: '이벤트 기다림', why: 'sleep 대기' };
      case 'loop-idle': return { cls: 'event', name: '이벤트 기다림', why: '타이머까지 대기' };
      case 'done': return { cls: 'done', name: '끝', why: '끝' };
      default: return { cls: 'turn', name: '차례 기다림', why: '' };
    }
  }

  // 이 단계에 루프 스레드가 이 Task의 코드를 실행했는지
  function ranNow(id, v) {
    const s = v.tasks[id];
    return !!(s && s.current && v.threads[loopThread().id].act === 'run-py');
  }

  // 단계 띠와 낭독 요약에 쓰는 Task 상태. 스레드처럼 네 가지로 나눈다. 이 단계에 실행했으면 채우고,
  // 아니면 단계가 끝난 뒤의 자리로 나눈다. 만료 단계가 지났는데 아직 타이머 줄에 있으면 late를 붙인다.
  function taskState(id, v) {
    if (ranNow(id, v)) return { cls: 'run', name: '실행 중', why: '' };
    const st = pillState(id, v);
    // 실행 중 칸에 남아 있어도 이 단계에 실행하지 않았으면 띠에서는 기다림으로 적는다.
    return st.cls === 'run' ? { cls: 'event', name: '이벤트 기다림', why: '' } : st;
  }

  // 관계도 알약의 상태. 알약이 놓인 칸과 같은 시점(단계가 끝난 뒤)의 상태만 쓴다.
  // 실행 중 칸의 Task는 채우고, 루프 스레드가 time.sleep()으로 멈춰 있으면 점선으로 그린다.
  function pillState(id, v) {
    const a = v.after.tasks[id];
    const th = v.threads[loopThread().id];
    switch (a.status) {
      case 'running': return th.act === 'os-sleep'
        ? { cls: 'event', name: '이벤트 기다림', why: 'sleep 대기' }
        : { cls: 'run', name: '실행 중', why: '' };
      case 'ready': return { cls: 'turn', name: '차례 기다림', why: '준비 큐' };
      case 'wait-timer': {
        const late = a.due != null && a.due < v.step;
        return { cls: 'event', name: '이벤트 기다림', why: late ? '만료 단계 지남' : '타이머 대기', late };
      }
      case 'wait-children': return { cls: 'event', name: '이벤트 기다림', why: 'gather 대기' };
      case 'wait-sem': return { cls: 'event', name: '이벤트 기다림', why: '얻기 대기' };
      case 'done': return { cls: 'done', name: '끝', why: '끝' };
      default: return { cls: 'none', name: '아직 없음', why: '' };
    }
  }

  // 준비 큐 순서, Semaphore를 얻은 Task의 네모, 끝난 순서는 단계 기록에 없으므로 이벤트를 처음부터 차례로 따라가 얻는다.
  // Semaphore를 얻은 Task는 반납할 때까지 같은 네모에 둔다. 반납(release)으로 깨어나 얻은 Task는 반납한 Task의 네모를 그대로 쓴다.
  function buildTrack() {
    if (!isLoop()) return null;
    const pid = proc().id;
    const ready = [];
    const slots = new Array(scene === 'sem' ? cfg.semaphore : 0).fill(null);
    const done = [];
    const per = [];
    const max = { ready: 0, timer: 0, semWait: 0, inside: 0 };
    run.views.forEach((v, k) => {
      if (k === 0) for (const [id, t] of Object.entries(v.after.tasks)) if (t.status === 'ready') ready.push(id);
      for (const e of v.events) {
        if (e.type === 'spawn') ready.push(...e.ids.slice(1));
        else if (e.type === 'timer') ready.push(e.ids[1]);
        else if (e.type === 'task-ready') ready.push(e.ids[0]);
        else if (e.type === 'loop-run') { const i = ready.indexOf(e.ids[1]); if (i >= 0) ready.splice(i, 1); }
        else if (e.type === 'sem-enter') slots[slots.indexOf(null)] = e.ids[0];
        else if (e.type === 'sem-pass') { slots[slots.indexOf(e.ids[0])] = e.ids[1]; ready.push(e.ids[1]); }
        else if (e.type === 'sem-release') slots[slots.indexOf(e.ids[0])] = null;
        else if (e.type === 'task-done') done.push(e.ids[0]);
      }
      per.push({ ready: ready.slice(), slots: slots.slice(), done: done.slice() });
      max.ready = Math.max(max.ready, ready.length);
      max.timer = Math.max(max.timer, (v.after.timers[pid] || []).length);
      max.inside = Math.max(max.inside, slots.filter(Boolean).length);
      if (v.after.sem[pid]) max.semWait = Math.max(max.semWait, v.after.sem[pid].waiters.length);
    });
    return { per, max, tasks: proc().loop.tasks.map((t) => t.id) };
  }

  // ---------- 공통 그림 ----------

  function drawFrame(svg, g) {
    // CPU는 프로세스 바깥 위쪽에 한 줄로 둔다. 스레드와 다른 모양(사각 칩)이다.
    const cpus = el('g', { class: 'cpus' }, svg);
    g.cpuX.forEach((x, i) => {
      const c = el('g', { class: 'cpu', 'data-cpu': i }, cpus);
      el('rect', { x: x - g.chipW / 2, y: g.chipY, width: g.chipW, height: g.chipH, rx: 6 }, c);
      el('text', { x, y: g.chipY + 19, 'text-anchor': 'middle' }, c, `CPU ${i + 1}`);
    });
    // 프로세스는 옅은 바탕, 인터프리터는 그 위에 놓인 흰 바탕이다.
    el('rect', { class: 'box proc', x: g.m, y: g.procY, width: g.W - 2 * g.m, height: g.procB - g.procY, rx: 12 }, svg);
    el('text', { class: 'lbl', x: g.m + 10, y: g.procB - 7 }, svg, '프로세스 1');
    el('rect', { class: 'box interp', x: g.mi, y: g.interpY, width: g.W - 2 * g.mi, height: g.interpB - g.interpY, rx: 10 }, svg);
    el('text', { class: 'lbl', id: 'interpLbl', x: g.mi + 10, y: g.interpB - 7 }, svg, '인터프리터');
    // 스레드마다 테두리 상자 하나에 원과 그 스레드만 쓰는 것(쥔 GIL, 기다리는 이유, 지역 변수)을 담는다.
    // 스레드들이 함께 쓰는 객체(counter, Lock, 이벤트 루프, Semaphore)는 상자 밖, 인터프리터 안에 둔다.
    const boxes = el('g', { class: 'thboxes' }, svg);
    g.thBox.forEach((b, i) => {
      el('rect', { class: 'thbox', 'data-th': i, x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, boxes);
      if (g.thLabel) el('text', { class: 'lbl', x: b.x + 10, y: b.y + 17 }, boxes, '스레드');
    });
    g.laneG = el('g', { class: 'lanes' }, svg);
    g.rowG = el('g', { class: 'rows' }, svg);
  }

  // 옅은 칸 하나와 칸 이름. 옅은 칸은 Task가 머무는 곳에만 쓴다.
  function drawLane(g, key, b, label, textY) {
    el('rect', { class: 'lane', 'data-row': key, x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, g.laneG);
    el('text', { class: 'rl', x: b.x + 6, y: textY }, g.rowG, label);
  }

  function drawCpuLinks(svg, g) {
    // CPU가 지금 실행하는 스레드로 잇는 곡선. 칩 아래에서 나가 원 위로 들어간다.
    const links = el('g', { class: 'cpu-links' }, svg);
    g.cpuX.forEach((x, i) => {
      const ln = el('path', { class: 'cpu-link', 'data-cpu': i }, links);
      ln._from = { x, y: g.chipY + g.chipH };
      setLineEnd(ln, x, g.chipY + g.chipH);
      ln.style.opacity = '0';
    });
  }

  function drawThreads(svg, g, withLocal) {
    const ths = el('g', { class: 'threads' }, svg);
    threadIds().forEach((id, i) => {
      const x = g.thX[i];
      const t = el('g', { class: 'th', 'data-id': id }, ths);
      el('circle', { cx: x, cy: g.thY, r: g.r }, t);
      el('text', { class: 'name', x, y: g.thY + 5, 'text-anchor': 'middle' }, t, short(id));
      if (g.whyX != null) el('text', { class: 'why', x: g.whyX, y: g.thY + 4 }, t, '');
      else el('text', { class: 'why', x, y: g.whyY, 'text-anchor': 'middle' }, t, '');
      if (!withLocal) return;
      const local = el('text', { class: 'local', x, y: g.localY, 'text-anchor': 'middle' }, t);
      el('tspan', { class: 'lname' }, local, '');
      el('tspan', g.localMode === 'stack' ? { class: 'lval', x, dy: 14 } : { class: 'lval' }, local, '');
    });
  }

  // GIL을 쓰는 구성인지. 빌드와 GIL 설정으로 정해지므로 한 구성 안에서는 바뀌지 않는다.
  function gilUsed() { return run.views.some((v) => v.gil[proc().id].active); }

  function drawGil(svg, g) {
    // GIL은 인터프리터마다 꼬리표 하나다. 비어 있으면 인터프리터 왼쪽 위의 GIL 자리(점선 테두리)에, 쥔 스레드가 있으면 그 스레드 상자 안 원 곁에 둔다.
    if (g.gilOn) {
      const home = el('rect', { class: 'gil-home', x: g.home.x - g.bw / 2, y: g.home.y - g.bh / 2, width: g.bw, height: g.bh, rx: 6 }, svg);
      el('title', {}, home, 'GIL 자리: GIL을 쥔 스레드가 없으면 꼬리표가 여기로 돌아온다');
    }
    const gil = el('g', { class: 'gil free', id: 'gilTag' }, svg);
    el('rect', { x: -g.bw / 2, y: -g.bh / 2, width: g.bw, height: g.bh, rx: 6 }, gil);
    el('text', { x: 0, y: 4, 'text-anchor': 'middle' }, gil, 'GIL');
    el('text', { class: 'req', x: g.bw / 2 + 4, y: 4 }, gil, '');
    setPos(gil, g.home, true);
  }

  // 요소를 새 자리로 옮긴다. 여러 단계를 건너뛰거나 처음 보일 때는 옮겨 가는 모습 없이 바로 둔다.
  function setPos(node, p, instant) {
    const tf = `translate(${p.x}px, ${p.y}px)`;
    if (!instant) { node.style.transform = tf; return; }
    node.style.transition = 'none';
    node.style.transform = tf;
    void node.getBoundingClientRect();
    node.style.transition = '';
  }

  // 곡선 연결선: 두 끝에서 세로로 나가고 들어오는 3차 베지에 곡선. 두 끝이 같은 세로줄에 있으면 곧은 선이 된다.
  function curve(x0, y0, x1, y1) {
    const f = (n) => Math.round(n * 10) / 10;
    const dy = (y1 - y0) / 2;
    return `M${f(x0)} ${f(y0)}C${f(x0)} ${f(y0 + dy)} ${f(x1)} ${f(y1 - dy)} ${f(x1)} ${f(y1)}`;
  }

  function setLineEnd(ln, x, y) {
    ln._end = { x, y };
    ln.setAttribute('d', curve(ln._from.x, ln._from.y, x, y));
  }

  // CPU 선의 끝을 새 스레드로 옮긴다. 한 단계 이동일 때만 미끄러지듯 옮긴다.
  function moveLine(ln, to, animate) {
    const from = ln._end;
    const wasOn = ln.style.opacity === '1';
    if (ln._raf) cancelAnimationFrame(ln._raf);
    if (!animate || !wasOn || (from.x === to.x && from.y === to.y)) { setLineEnd(ln, to.x, to.y); return; }
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / MOVE_MS);
      const e = 1 - Math.pow(1 - k, 3);
      setLineEnd(ln, from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      if (k < 1) ln._raf = requestAnimationFrame(tick);
    };
    ln._raf = requestAnimationFrame(tick);
  }

  function renderCpuLinks(v, animate) {
    const g = geo;
    const ids = threadIds();
    $('#board').querySelectorAll('.cpu-link').forEach((ln) => {
      const id = v.cpus[+ln.dataset.cpu];
      if (!id) { ln.style.opacity = '0'; return; }
      const k = ids.indexOf(id);
      moveLine(ln, { x: g.thX[k], y: g.thY - g.r }, animate);
      ln.style.opacity = '1';
    });
  }

  function renderThreadState(v) {
    for (const id of threadIds()) {
      const st = stateOf(v.threads[id]);
      const node = $('#board').querySelector(`.th[data-id="${id}"]`);
      node.setAttribute('class', `th ${st.cls}`);
      node.querySelector('.why').textContent = st.cls === 'run' ? '' : st.why;
    }
  }

  function renderGil(v, animate) {
    const g = geo;
    const pid = proc().id;
    const gv = v.gil[pid];
    const tag = $('#gilTag');
    $('#interpLbl').textContent = gv.active ? '인터프리터' : '인터프리터 · GIL 끔';
    tag.style.display = gv.active ? '' : 'none';
    if (!gv.active) return;
    const holder = v.after.gil[pid];
    const req = holder != null && (v.events.some((e) => e.type === 'gil-request')
      || (holder === gv.holder && v.threads[holder].dropRequested));
    tag.setAttribute('class', `gil${holder ? '' : ' free'}`);
    tag.querySelector('.req').textContent = req ? '요청' : '';
    const k = holder ? threadIds().indexOf(holder) : -1;
    setPos(tag, k < 0 ? g.home : g.gilAt ? g.gilAt : { x: g.thX[k], y: g.gilY }, !animate);
  }

  function buildBoard() {
    geo = isLoop() ? layoutLoop() : layoutCounter();
    const g = geo;
    const svg = $('#board');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
    svg.style.width = g.scroll ? `${g.W}px` : '';
    svg.style.maxWidth = g.scroll ? 'none' : '';
    svg.classList.toggle('compact', g.compact);
    svg.classList.toggle('stack', g.localMode === 'stack');
    if (isLoop()) buildLoop(svg, g); else buildCounter(svg, g);
  }

  function renderBoard(v, animate) {
    $('#board').classList.toggle('instant', !animate);
    renderCpuLinks(v, animate);
    renderThreadState(v);
    if (isLoop()) renderLoop(v, animate); else renderCounter(v, animate);
    renderGil(v, animate);
  }

  // ---------- 공유 카운터 장면 ----------

  // 관계도 좌표. 보이는 너비를 viewBox 너비로 써서 좁은 화면에서도 글자 크기를 유지한다.
  // 스레드 하나에 60px보다 좁아지면 줄이지 않고 관계도 칸 안에서 옆으로 밀어 보게 한다.
  // 프로세스와 인터프리터 이름은 CPU 선이 지나가지 않는 상자 아래쪽에 적는다.
  // 인터프리터 안에는 스레드 상자가 나란히 놓이고(원과 그 아래 GIL, 기다리는 이유, 지역 변수), 그 아래 상자 밖에 counter와 Lock이 놓인다.
  // 빈 GIL은 스레드 상자 위, 인터프리터 왼쪽 위에 둔다.
  function layoutCounter() {
    const T = cfg.threads;
    const C = cfg.cpus;
    const avail = Math.floor($('#boardWrap').clientWidth) || 600;
    const W = Math.max(260, 24 + (T + 1) * 60, Math.min(600, avail));
    const compact = W < 480;
    const m = compact ? 4 : 8;
    const mi = compact ? 12 : 24;
    const g = { W, compact, scroll: W > avail + 1, m, mi, chipY: 12, chipH: 28, procY: 56, interpY: 80, r: compact ? 18 : 22,
      bw: compact ? 36 : 44, bh: 20, cH: 66 };
    // 인터프리터 안에 바로 놓는 것(GIL 자리, 스레드 상자, counter와 Lock)은 왼쪽 끝을 ox에 맞춘다.
    const ox = mi + (compact ? 6 : 12);
    const ow = W - 2 * ox;
    g.gilOn = gilUsed();
    const thTop = g.interpY + (g.gilOn ? 38 : 12);
    g.thY = thTop + 10 + g.r;
    g.gilY = g.thY + g.r + 14;
    g.whyY = g.gilY + 27;
    g.localY = g.whyY + 16;
    // 스레드 상자는 같은 너비로 나란히 둔다. 상자가 좁으면 "previous = 0"을 줄여 적거나 두 줄로 나눈다.
    const sep = compact ? 6 : 10;
    const col = (ow + sep) / T;
    const boxW = Math.min(col - sep, 168);
    g.thX = Array.from({ length: T }, (_, i) => ox + col * i + (col - sep) / 2);
    g.localMode = boxW >= 100 ? 'full' : boxW >= 84 ? 'tight' : 'stack';
    // counter로 가는 곡선은 스레드 상자의 아래 가장자리에서 나간다.
    g.refY = g.localY + 9 + (g.localMode === 'stack' ? 14 : 0);
    g.thBox = g.thX.map((x) => ({ x: x - boxW / 2, y: thTop, w: boxW, h: g.refY - thTop }));
    // 상자 이름 "스레드"는 원 왼쪽에 들어갈 때만 적는다.
    g.thLabel = boxW / 2 - g.r - 14 >= 36;
    // counter로 가는 곡선이 너무 납작하지 않도록 세로 간격을 둔다.
    g.cTop = g.refY + 40;
    g.interpB = g.cTop + g.cH + 26;
    g.procB = g.interpB + 22;
    g.H = g.procB + 6;
    const cpuStep = (W - 2 * m) / (C + 1);
    g.cpuX = Array.from({ length: C }, (_, i) => m + cpuStep * (i + 1));
    g.chipW = Math.min(72, cpuStep - 8);
    // counter와 Lock은 스레드 상자 밖, 인터프리터 안에 둔다. 넓으면 counter를 가운데에 두고, Lock이 넘치면 둘을 함께 왼쪽으로 민다.
    const inL = ox;
    const inR = ox + ow;
    if (compact) {
      const room = inR - inL;
      g.cW = Math.min(160, Math.round(room * 0.56));
      g.lockW = Math.min(124, room - g.cW - 10);
      g.cX = inL + (room - (g.cW + 10 + g.lockW)) / 2;
      g.lockX = g.cX + g.cW + 10;
    } else {
      g.cW = 168;
      g.lockW = 136;
      g.cX = Math.min(W / 2 - g.cW / 2, inR - (g.cW + 20 + g.lockW));
      g.lockX = g.cX + g.cW + 20;
    }
    g.cMid = g.cX + g.cW / 2;
    g.spread = compact ? 16 : 26;
    // 빈 GIL은 인터프리터 왼쪽 위에 둔다. 왼쪽 끝을 스레드 상자와 맞추되, 가장 왼쪽 CPU 선보다 더 왼쪽에 두어 선과 겹치지 않게 한다.
    const lineMin = Math.min(g.cpuX[0], g.thX[0]);
    g.home = { x: Math.max(mi + 4 + g.bw / 2, Math.min(ox + g.bw / 2, lineMin - 6 - g.bw / 2)), y: g.interpY + 20 };
    return g;
  }

  function buildCounter(svg, g) {
    const defs = el('defs', {}, svg);
    for (const [id, cls] of [['ref-arrow-on', 'mk-on'], ['ref-arrow-lost', 'mk-lost']]) {
      const mk = el('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' }, defs);
      el('path', { d: 'M0 0L10 5L0 10z', class: cls }, mk);
    }
    drawFrame(svg, g);

    // 스레드마다 같은 counter로 잇는 곡선. 모든 스레드가 같은 객체를 쓴다는 뜻이다.
    // 이번 단계에 읽으면 스레드 쪽으로, 쓰면 counter 쪽으로 화살촉을 단다.
    const refs = el('g', { class: 'refs' }, svg);
    const T = g.thX.length;
    g.thX.forEach((x, i) => {
      const ex = g.cMid + (i - (T - 1) / 2) * g.spread;
      el('path', { class: 'ref', 'data-th': i, d: curve(x, g.refY, ex, g.cTop - 2) }, refs);
    });
    drawCpuLinks(svg, g);
    drawThreads(svg, g, true);

    const c = el('g', { class: 'counter', id: 'counterNode' }, svg);
    el('rect', { x: g.cX, y: g.cTop, width: g.cW, height: g.cH, rx: 8 }, c);
    el('text', { class: 'lbl', x: g.cX + 10, y: g.cTop + 17 }, c, 'counter.completed');
    el('text', { class: 'value', x: g.cX + g.cW / 2, y: g.cTop + 52, 'text-anchor': 'middle' }, c, '0');
    el('text', { class: 'lbl', x: g.cX + g.cW - 10, y: g.cTop + 56, 'text-anchor': 'end' }, c, `기대 ${cfg.threads}`);

    // Lock은 counter 옆에 둔다. 이름, 쥔 스레드, 기다리는 스레드를 한 줄씩 적는다.
    const lk = el('g', { class: 'lock', id: 'lockNode' }, svg);
    el('rect', { x: g.lockX, y: g.cTop, width: g.lockW, height: g.cH, rx: 8 }, lk);
    el('text', { x: g.lockX + 10, y: g.cTop + 18 }, lk, 'Lock');
    el('text', { class: 'lbl lk-owner', x: g.lockX + 10, y: g.cTop + 38 }, lk, '');
    el('text', { class: 'lbl lk-wait', x: g.lockX + 10, y: g.cTop + 56 }, lk, '');
    drawGil(svg, g);
  }

  function renderCounter(v, animate) {
    const g = geo;
    const pid = proc().id;
    const ids = threadIds();
    const svg = $('#board');

    ids.forEach((id) => {
      // 함수가 끝나면 지역 변수도 없어지므로 끝난 스레드에는 previous를 적지 않는다.
      const node = svg.querySelector(`.th[data-id="${id}"]`);
      const local = v.after.locals[id];
      const has = local != null && stateOf(v.threads[id]).cls !== 'done';
      node.querySelector('.lname').textContent = !has ? '' : { full: 'previous = ', tight: 'previous=', stack: 'previous' }[g.localMode];
      node.querySelector('.lval').textContent = has ? String(local) : '';
    });

    const touched = new Map();
    for (const e of v.events) {
      if (e.type !== 'read' && e.type !== 'write' && e.type !== 'lost') continue;
      const k = ids.indexOf(e.ids[0]);
      if (k >= 0) touched.set(k, e.type);
    }
    svg.querySelectorAll('.ref').forEach((ln) => {
      const ty = touched.get(+ln.dataset.th);
      ln.setAttribute('class', `ref${ty ? ' touch' : ''}${ty === 'lost' ? ' lost' : ''}`);
      ln.removeAttribute('marker-start');
      ln.removeAttribute('marker-end');
      if (ty) ln.setAttribute(ty === 'read' ? 'marker-start' : 'marker-end', `url(#${ty === 'lost' ? 'ref-arrow-lost' : 'ref-arrow-on'})`);
    });

    const prev = idx > 0 ? run.views[idx - 1] : null;
    const c = v.after.counter[pid];
    const before = prev ? prev.after.counter[pid].value : c.value;
    const lost = v.events.some((e) => e.type === 'lost');
    const wrong = idx === lastIdx() && run.finished && c.value !== c.expected;
    const cn = $('#counterNode');
    cn.setAttribute('class', `counter${c.value !== before ? ' changed' : ''}${lost ? ' lost' : ''}${wrong ? ' wrong' : ''}`);
    cn.querySelector('.value').textContent = String(c.value);
    if (animate && c.value !== before) {
      cn.classList.remove('bump');
      void cn.getBoundingClientRect();
      cn.classList.add('bump');
    }

    const lk = v.after.lock[pid];
    const ln = $('#lockNode');
    if (!lk.used) {
      ln.setAttribute('class', 'lock unused');
      ln.querySelector('.lk-owner').textContent = g.lockW >= 120 ? '이 구성은 안 씀' : '안 씀';
      ln.querySelector('.lk-wait').textContent = '';
    } else {
      ln.setAttribute('class', `lock${lk.owner ? ' held' : ''}`);
      ln.querySelector('.lk-owner').textContent = lk.owner ? `${M.josa(short(lk.owner), ['이', '가'])} 쥠` : '비어 있음';
      // 좁은 관계도에서는 기다리는 스레드가 둘 이상이면 수만 적는다. 누가 기다리는지는 스레드 아래 "Lock 대기"로 보인다.
      const names = lk.waiters.map(short);
      ln.querySelector('.lk-wait').textContent = !names.length ? '' : g.compact && names.length > 1 ? `대기 ${names.length}개` : `대기 ${names.join(', ')}`;
    }
  }

  // ---------- 루프 장면 (루프 지연, Task와 Semaphore) ----------

  // 스레드 원 아래에 이벤트 루프 상자를 붙인다. 상자에는 루프가 직접 가진 줄(실행 중, 준비 큐, 타이머)만 넣고,
  // gather나 Semaphore를 기다리는 Task와 끝난 Task는 상자 밖 줄에 둔다.
  // 줄의 높이는 한 구성 안에서 가장 많이 들어가는 수에 맞춰 정한다. 단계마다 줄이 움직이지 않게 하려는 것이다.
  function layoutLoop() {
    const avail = Math.floor($('#boardWrap').clientWidth) || 600;
    const W = Math.max(260, Math.min(600, avail));
    const compact = W < 480;
    const m = compact ? 4 : 8;
    const mi = compact ? 12 : 24;
    const g = { W, compact, scroll: false, m, mi, chipY: 12, chipH: 28, procY: 56, interpY: 80, r: compact ? 18 : 22,
      bw: compact ? 36 : 44, bh: 20 };
    const C = cfg.cpus;
    const cpuStep = (W - 2 * m) / (C + 1);
    g.cpuX = Array.from({ length: C }, (_, i) => m + cpuStep * (i + 1));
    g.chipW = Math.min(72, cpuStep - 8);
    g.thX = [W / 2];
    g.lx = mi + (compact ? 6 : 12);
    g.lw = W - 2 * g.lx;
    // 루프 스레드도 테두리 상자 하나에 담는다. 이벤트 루프는 Task들이 함께 쓰는 객체라서 스레드 상자 밖에 두고,
    // 스레드가 루프를 돌린다는 것은 원에서 실행 중 칸으로 가는 곡선으로 보인다. 빈 GIL은 상자 위, 인터프리터 왼쪽 위에 둔다.
    g.gilOn = gilUsed();
    const thTop = g.interpY + (g.gilOn ? 38 : 12);
    g.thY = thTop + 10 + g.r;
    g.thBox = [{ x: g.lx, y: thTop, w: g.lw, h: 2 * g.r + 20 }];
    g.thLabel = true;
    g.home = { x: g.lx + g.bw / 2, y: g.interpY + 20 };
    // 스레드 원 아래는 루프 상자로 이어지므로 GIL은 원 왼쪽에, 기다리는 이유는 원 오른쪽에 적는다.
    g.gilAt = { x: g.thX[0] - g.r - 10 - g.bw / 2, y: g.thY };
    // 좁은 화면에서는 이유 글자를 조금 작게, 원에 조금 더 붙여 적어 스레드 상자 안에 들어가게 한다.
    g.whyX = g.thX[0] + g.r + (compact ? 6 : 10);
    g.labelW = compact ? 78 : 100;
    g.pw = compact ? 40 : 52;
    g.ph = 22;
    g.gap = compact ? 4 : 8;
    g.lineH = compact ? 28 : 30;
    g.px0 = g.lx + g.labelW;
    const room = g.lx + g.lw - 8 - g.px0;
    const fit = (sp) => Math.max(1, Math.floor((room - g.pw) / sp) + 1);
    const step = g.pw + g.gap;
    // 타이머 알약 아래에는 만료 단계를 적으므로 간격을 더 둔다.
    const tstep = Math.max(step, compact ? 66 : 72);
    const rows = {};
    let y = g.thBox[0].y + g.thBox[0].h + 10;
    g.loopTop = y;
    y += 24;
    const addRow = (key, label, n, opts) => {
      const o = opts || {};
      const spacing = o.spacing || step;
      const per = fit(spacing);
      const lines = Math.max(1, Math.ceil(n / per));
      const lineH = g.lineH + (o.extra || 0);
      rows[key] = { key, label, sub: o.sub || '', y, per, spacing, lineH, lines };
      y += lines * lineH;
    };
    addRow('run', '실행 중', 1);
    addRow('ready', '준비 큐', track.max.ready);
    addRow('timer', '타이머', track.max.timer, { spacing: tstep, extra: 16, sub: '만료 단계' });
    g.loopB = y + 4;
    y = g.loopB + 10;
    addRow('gather', 'gather 대기', 1);
    if (scene === 'sem') {
      y += 6;
      g.semTop = y;
      y += 24;
      addRow('slots', '얻은 Task', cfg.semaphore);
      if (track.max.semWait > 0) addRow('semWait', '얻기 대기', track.max.semWait);
      g.semB = y + 4;
      y = g.semB + 10;
    }
    addRow('done', '끝', track.tasks.length);
    g.rows = rows;
    g.interpB = y + 24;
    g.procB = g.interpB + 22;
    g.H = g.procB + 6;
    return g;
  }

  function cellXY(row, i) {
    const line = Math.floor(i / row.per);
    return { x: geo.px0 + (i % row.per) * row.spacing, y: row.y + line * row.lineH + 4 };
  }

  function buildLoop(svg, g) {
    drawFrame(svg, g);
    el('rect', { class: 'loopbox', x: g.lx, y: g.loopTop, width: g.lw, height: g.loopB - g.loopTop, rx: 10 }, svg);
    el('text', { class: 'lbl', x: g.lx + 10, y: g.loopTop + 17 }, svg, '이벤트 루프');
    if (scene === 'sem') {
      el('rect', { class: 'sembox', x: g.lx, y: g.semTop, width: g.lw, height: g.semB - g.semTop, rx: 8 }, svg);
      el('text', { class: 'lbl', x: g.lx + 10, y: g.semTop + 17 }, svg, `asyncio.Semaphore(${cfg.semaphore})`);
      el('text', { class: 'lbl', id: 'semLeft', x: g.lx + g.lw - 10, y: g.semTop + 17, 'text-anchor': 'end' }, svg, '');
    }
    // Task가 머무는 줄마다 옅은 칸을 깔고 줄 이름을 칸 안에 적는다. 알약은 늘 어느 칸 위에 놓이므로
    // 멈춰 있을 때도 칸 이름으로 상태가 읽힌다. Semaphore를 얻은 Task 줄은 Task가 머무는 곳이 아니라
    // Semaphore의 상태라서 칸 없이 이름만 적는다.
    for (const row of Object.values(g.rows)) {
      const b = { x: g.lx + 6, y: row.y + 2, w: g.lw - 12, h: row.lines * row.lineH - 4 };
      if (row.key === 'slots') el('text', { class: 'rl', x: b.x + 6, y: row.y + 19 }, g.rowG, row.label);
      else drawLane(g, row.key, b, row.label, row.y + 19);
      if (row.sub) el('text', { class: 'rl sub', x: g.lx + 12, y: row.y + 33 }, g.rowG, row.sub);
    }
    // 실행 중 칸은 한 자리뿐이다. 루프 스레드가 실행하는 Task가 이 자리에 앉고, 스레드에서 이 자리로 곡선을 잇는다.
    g.seat = cellXY(g.rows.run, 0);
    el('path', { class: 'loop-link', d: curve(g.thX[0], g.thY + g.r, g.seat.x + g.pw / 2, g.seat.y) }, svg);
    el('rect', { class: 'seat', x: g.seat.x, y: g.seat.y, width: g.pw, height: g.ph, rx: g.ph / 2 }, svg);
    if (scene === 'sem') {
      const slots = el('g', { class: 'slots' }, svg);
      for (let j = 0; j < cfg.semaphore; j++) {
        const p = cellXY(g.rows.slots, j);
        const s = el('g', { class: 'slot', 'data-slot': j }, slots);
        el('rect', { x: p.x, y: p.y, width: g.pw, height: g.ph, rx: 4 }, s);
        el('text', { x: p.x + g.pw / 2, y: p.y + 15, 'text-anchor': 'middle' }, s, '');
      }
    }
    drawCpuLinks(svg, g);
    drawThreads(svg, g, false);
    // Task 알약. 자리는 단계마다 transform으로 옮긴다.
    const tasks = el('g', { class: 'tasks' }, svg);
    for (const id of track.tasks) {
      const t = el('g', { class: 'tk', 'data-id': id }, tasks);
      el('title', {}, t, '');
      el('rect', { x: 0, y: 0, width: g.pw, height: g.ph, rx: g.ph / 2 }, t);
      el('text', { class: 'tn', x: g.pw / 2, y: 15, 'text-anchor': 'middle' }, t, taskShort(id));
      el('text', { class: 'due', x: g.pw / 2, y: g.ph + 12, 'text-anchor': 'middle' }, t, '');
      t.style.display = 'none';
    }
    drawGil(svg, g);
  }

  // 단계가 끝난 뒤 Task가 놓인 줄과 그 줄 안의 순서
  function taskPlace(id, v) {
    const pid = proc().id;
    const tr = track.per[idx];
    const t = v.after.tasks[id];
    const at = (list) => Math.max(0, list.indexOf(id));
    switch (t.status) {
      case 'running': return { row: 'run', i: 0 };
      case 'ready': return { row: 'ready', i: at(tr.ready) };
      case 'wait-timer': return { row: 'timer', i: Math.max(0, (v.after.timers[pid] || []).findIndex((x) => x.task === id)) };
      case 'wait-children': return { row: 'gather', i: 0 };
      case 'wait-sem': return { row: 'semWait', i: at(v.after.sem[pid].waiters) };
      case 'done': return { row: 'done', i: at(tr.done) };
      default: return null;
    }
  }

  function renderLoop(v, animate) {
    const g = geo;
    const svg = $('#board');
    const pid = proc().id;
    // 한 단계 앞으로 갈 때, 이 단계에 실행하고 다른 칸으로 간 Task는 실행 자리를 거쳐 옮겨 간다.
    // 멈춘 뒤의 알약 모양은 놓인 칸의 상태만 따른다.
    const forward = animate && idx === shown + 1;
    for (const id of track.tasks) {
      const pill = svg.querySelector(`.tk[data-id="${id}"]`);
      clearTimeout(pill._hop);
      pill._hopFn = null;
      const place = taskPlace(id, v);
      if (!place) { pill.style.display = 'none'; pill.removeAttribute('data-row'); continue; }
      const st = pillState(id, v);
      const ran = ranNow(id, v);
      const hidden = pill.style.display === 'none';
      const from = pill.dataset.row;
      const cls = `tk ${st.cls}${st.late ? ' late' : ''}`;
      const dest = cellXY(g.rows[place.row], place.i);
      const due = v.after.tasks[id].due;
      const dueText = place.row === 'timer' ? `단계 ${due}${st.late ? ' 지남' : ''}` : '';
      pill.style.display = '';
      pill.dataset.row = place.row;
      pill.toggleAttribute('data-ran', ran);
      // 칸을 옮기는 알약은 다른 알약 위로 지나가도록 맨 위로 올린 뒤 옮긴다.
      if (animate && !hidden && from !== place.row) {
        pill.parentNode.appendChild(pill);
        void pill.getBoundingClientRect();
      }
      if (forward && ran && !hidden && place.row !== 'run' && from !== 'run') {
        pill.setAttribute('class', `${cls} transit`);
        pill.querySelector('.due').textContent = '';
        setPos(pill, g.seat, false);
        pill._hopFn = () => {
          pill._hopFn = null;
          pill.setAttribute('class', cls);
          pill.querySelector('.due').textContent = dueText;
          setPos(pill, dest, false);
        };
        pill._hop = setTimeout(pill._hopFn, MOVE_MS);
      } else {
        pill.setAttribute('class', cls);
        pill.querySelector('.due').textContent = dueText;
        setPos(pill, dest, !animate || hidden);
      }
      pill.querySelector('title').textContent = `${taskLabel(id)} · ${st.name}${st.why ? ` (${st.why})` : ''}${ran ? ' · 이 단계에 실행함' : ''}`;
    }
    if (scene === 'sem') {
      const tr = track.per[idx];
      $('#semLeft').textContent = `내부 카운터 ${v.after.sem[pid].value}`;
      svg.querySelectorAll('.slot').forEach((s, j) => {
        const holder = tr.slots[j];
        s.setAttribute('class', `slot${holder ? ' held' : ''}`);
        s.querySelector('text').textContent = holder ? taskShort(holder) : '';
      });
    }
  }

  function lateTimers(v) {
    return (v.after.timers[proc().id] || []).filter((t) => t.due < v.step);
  }

  // ---------- 전체 지도 ----------
  // 모든 요소를 담는 관계(CPU는 프로세스 밖, 프로세스 ⊃ 인터프리터 ⊃ GIL·OS 스레드·공유 객체, 이벤트 루프는 스레드 하나 위, Task는 루프 안)만 그린다.
  // 단계와 상관없이 그대로이고, 장면을 바꾸면 그 장면이 쓰는 부분만 진하게 바꾼다.

  function buildMap() {
    const avail = Math.floor($('#mapWrap').clientWidth) || 460;
    const W = Math.max(260, Math.min(460, avail));
    const compact = W < 400;
    const mi = compact ? 12 : 18;
    const svg = $('#map');
    svg.innerHTML = '';
    const part = (name) => el('g', { class: 'part', 'data-part': name }, svg);
    const cw = 44;
    const cpu = part('cpu');
    [-1, 0, 1].forEach((d) => {
      const x = W / 2 + d * (cw + 10);
      el('rect', { x: x - cw / 2, y: 4, width: cw, height: 20, rx: 5 }, cpu);
      el('text', { x, y: 18, 'text-anchor': 'middle' }, cpu, 'CPU');
    });
    const procY = 32;
    const interpY = 48;
    const rowY = 74;
    const loopY = 94;
    const objY = 134;
    const interpB = objY + 22 + 22;
    const procB = interpB + 18;
    el('rect', { class: 'box', x: 4, y: procY, width: W - 8, height: procB - procY, rx: 10 }, svg);
    el('text', { class: 'lbl', x: 14, y: procB - 6 }, svg, '프로세스');
    el('rect', { class: 'box', x: mi, y: interpY, width: W - 2 * mi, height: interpB - interpY, rx: 8 }, svg);
    el('text', { class: 'lbl', x: mi + 10, y: interpB - 6 }, svg, '인터프리터');
    const gil = part('gil');
    el('rect', { class: 'gilr', x: mi + 10, y: rowY - 9, width: 36, height: 18, rx: 5 }, gil);
    el('text', { x: mi + 28, y: rowY + 4, 'text-anchor': 'middle' }, gil, 'GIL');
    const x0 = mi + (compact ? 74 : 80);
    [0, 1, 2].forEach((i) => {
      const th = part(`th${i}`);
      el('circle', { cx: x0 + i * 28, cy: rowY, r: 10 }, th);
    });
    el('text', { class: 'lbl', x: x0 + 2 * 28 + 18, y: rowY + 4 }, svg, 'OS 스레드');
    const link = part('link');
    el('line', { x1: x0, y1: rowY + 10, x2: x0, y2: loopY }, link);
    const lx = x0 - 16;
    const lr = W - mi - 10;
    const loop = part('loop');
    el('rect', { x: lx, y: loopY, width: lr - lx, height: 28, rx: 8 }, loop);
    el('text', { x: lx + 10, y: loopY + 18 }, loop, '이벤트 루프');
    const task = part('task');
    const n = compact ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const px = lr - 8 - (n - i) * 44 + 4;
      el('rect', { x: px, y: loopY + 5, width: 40, height: 18, rx: 9 }, task);
      el('text', { x: px + 20, y: loopY + 18, 'text-anchor': 'middle' }, task, 'Task');
    }
    let ox = mi + 10;
    for (const [name, label, w] of [['counter', 'counter', 70], ['lock', 'Lock', 46], ['sem', 'Semaphore', 84]]) {
      const o = part(name);
      el('rect', { x: ox, y: objY, width: w, height: 22, rx: 5 }, o);
      el('text', { x: ox + w / 2, y: objY + 15, 'text-anchor': 'middle' }, o, label);
      ox += w + 8;
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${procB + 4}`);
    svg.style.maxWidth = `${W}px`;
  }

  const PART_NAMES = { cpu: '논리 CPU', gil: 'GIL', th0: 'OS 스레드', link: '', loop: '이벤트 루프', task: 'Task', counter: 'counter', lock: 'Lock', sem: 'Semaphore' };

  function renderMap() {
    const on = new Set(SCENES[scene].parts);
    $('#map').querySelectorAll('.part').forEach((p) => p.classList.toggle('on', on.has(p.dataset.part)));
    const used = [...new Set(SCENES[scene].parts.map((p) => PART_NAMES[p]).filter(Boolean))];
    $('#map').setAttribute('aria-label', '전체 지도. 논리 CPU는 프로세스 밖에 있다. 프로세스 안에 인터프리터가 있고, 인터프리터 안에 GIL, OS 스레드, '
      + '공유 객체 counter·Lock·Semaphore가 있다. 이벤트 루프는 OS 스레드 하나에서 돌고 Task는 루프 안에 있다. '
      + `이 장면에 나오는 부분: 프로세스, 인터프리터, ${used.join(', ')}.`);
  }

  function renderCounts() {
    const gm = M.GIL_MODES[cfg.gil];
    const items = [['논리 CPU', `${cfg.cpus}개`], ['프로세스', '1개'], ['인터프리터', '1개'], ['GIL', gm.active ? '1개 (켬)' : '0개 (끔)']];
    if (scene === 'counter') {
      items.push(['OS 스레드', `${cfg.threads}개`], ['counter', '1개'], ['Lock', cfg.lockScope === 'none' ? '1개 (안 씀)' : '1개']);
    } else {
      items.push(['OS 스레드', '1개'], ['이벤트 루프', '1개']);
      if (scene === 'sem') items.push(['작업', `${cfg.jobs}개`]);
      items.push(['Task', `${track.tasks.length}개 (main 포함)`]);
      if (scene === 'sem') items.push(['Semaphore 상한', String(cfg.semaphore)]);
    }
    $('#counts').innerHTML = items.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('');
  }

  // 화면 낭독기에 읽어 줄 이번 단계 요약
  function describe(v) {
    const pid = proc().id;
    const parts = [`단계 ${v.step}.`];
    const runs = [];
    const waits = [];
    for (const id of threadIds()) {
      const t = v.threads[id];
      const st = stateOf(t);
      if (st.cls === 'run') runs.push(`스레드 ${short(id)}${t.cpu != null ? ` CPU ${t.cpu + 1}` : ''}`);
      else waits.push(`스레드 ${short(id)} ${st.why}`);
    }
    if (runs.length) parts.push(`실행 중: ${runs.join(', ')}.`);
    if (waits.length) parts.push(`${waits.join(', ')}.`);
    if (isLoop()) {
      const ran = track.tasks.filter((id) => taskState(id, v).cls === 'run');
      if (ran.length) parts.push(`이 단계에 실행한 Task: ${ran.map(taskShort).join(', ')}.`);
      const rows = {};
      for (const id of track.tasks) {
        const p = taskPlace(id, v);
        if (!p) continue;
        (rows[p.row] = rows[p.row] || [])[p.i] = id;
      }
      for (const [key, label] of [['run', '실행 중'], ['ready', '준비 큐'], ['timer', '타이머'], ['gather', 'gather 대기'], ['semWait', '얻기 대기'], ['done', '끝']]) {
        const list = (rows[key] || []).filter(Boolean);
        if (!list.length) continue;
        const name = (id) => {
          if (key !== 'timer') return taskShort(id);
          const due = v.after.tasks[id].due;
          return `${taskShort(id)} 단계 ${due}${due < v.step ? ' 지남' : ''}`;
        };
        parts.push(`${label}: ${list.map(name).join(', ')}.`);
      }
      if (scene === 'sem') {
        const inside = track.per[idx].slots.filter(Boolean);
        parts.push(`Semaphore를 얻은 Task ${inside.length}개${inside.length ? ` (${inside.map(taskShort).join(', ')})` : ''}, 내부 카운터 ${v.after.sem[pid].value}.`);
      }
    } else {
      parts.push(`counter.completed ${v.after.counter[pid].value}.`);
    }
    if (v.gil[pid].active) {
      const h = v.after.gil[pid];
      parts.push(h ? `GIL은 스레드 ${short(h)}.` : 'GIL은 비어 있음.');
    }
    return parts.join(' ');
  }

  // ---------- 설명 한 문장 ----------

  function mainEvent(v) {
    for (const type of PRIORITY[isLoop() ? 'loop' : 'counter']) {
      const e = v.events.find((x) => x.type === type);
      if (e) return e;
    }
    return v.events[0] || null;
  }

  // 이벤트가 없는 단계는 루프 스레드가 하고 있는 일을 모형의 연산 이름으로 적는다.
  function quietText(v) {
    const th = loopThread();
    const t = v.threads[th.id];
    let s = t.act === 'loop-idle' ? t.label : `${th.name}: ${t.label}`;
    const late = lateTimers(v);
    if (late.length) s += `. 만료 단계가 지났지만 아직 실행하지 못한 Task: ${late.map((x) => `${taskShort(x.task)}(단계 ${x.due})`).join(', ')}`;
    return `${s}.`;
  }

  function resultHtml(v) {
    if (!isLoop()) {
      const c = v.after.counter[proc().id];
      const gone = c.expected - c.value;
      return `<span class="result${gone > 0 ? ' bad' : ''}">결과: counter.completed = ${c.value}, 기대값 ${c.expected}${gone > 0 ? `. 증가 ${gone}번이 사라졌다` : ''}.</span>`;
    }
    if (scene === 'loop') {
      const beats = v.after.beats[`${proc().id}-B`] || [];
      const late = beats.some((b) => b.lag > 0);
      const list = beats.map((b) => `${M.josa(`예정 ${b.beat}`, ['은', '는'])} ${b.lag > 0 ? `${b.lag}단계 늦음` : '늦지 않음'}`).join(', ');
      return `<span class="result${late ? ' bad' : ''}">결과: B의 재개 기록에서 ${esc(list)} (설명용 단계).</span>`;
    }
    return `<span class="result">결과: 작업 Task ${cfg.jobs}개가 모두 끝났다. Semaphore 안에 동시에 있던 Task는 최대 ${track.max.inside}개였다.</span>`;
  }

  function renderCaption(v) {
    const main = mainEvent(v);
    const rest = v.events.filter((e) => e !== main && e.type !== 'end');
    const text = main ? main.text : isLoop() && idx > 0 ? quietText(v) : '';
    let html = esc(text);
    if (idx === lastIdx() && run.finished) html += resultHtml(v);
    $('#caption').innerHTML = html;
    const more = $('#more');
    more.hidden = rest.length === 0;
    more.querySelector('summary').textContent = `이 단계의 다른 일 ${rest.length}개`;
    more.querySelector('ul').innerHTML = rest.map((e) => `<li>${esc(e.text)}</li>`).join('');
    $('#live').textContent = `단계 ${v.step}. ${text}`;
  }

  // ---------- 코드 ----------
  // 줄마다 on 목록을 둔다. 실행 주체(스레드나 Task)의 지금 연산 종류로 그 줄을 찾는다.
  // 실험 코드는 content.js의 CODE와 같게 둔다. 실험 코드에 없는 줄은 note에 덧붙였다고 적는다.

  function L(t, on) { return { t, on: on || [] }; }

  // content.js의 코드 한 덩어리를 줄로 나누고, 줄 글자가 같은 곳에 on 목록을 붙인다.
  function fromCode(text, marks) { return text.split('\n').map((t) => L(t, marks[t.trim()])); }

  function codeFor() {
    if (scene === 'counter') return counterCode();
    if (scene === 'sem') return semCode();
    return loopCode();
  }

  function counterCode() {
    const unlocked = [
      L('def increment_unlocked(counter, lock, yield_between):'), L('    previous = counter.completed', ['read']),
      L('    if yield_between:'), L('        time.sleep(0)', ['yield0']), L('    counter.completed = previous + 1', ['write'])];
    if (cfg.lockScope === 'none') return { sig: 'none', note: '실험 코드에서 옮겼다.', lines: unlocked };
    if (cfg.lockScope === 'full') {
      return { sig: 'full', note: '실험 코드에서 옮겼다. 마지막 주석 줄은 with 블록을 나갈 때 Lock을 놓는 지점을 보이려고 덧붙였다.', lines: unlocked.concat([
        L(''), L('def increment_candidate(counter, lock, yield_between):'), L('    with lock:', ['lockAcquire']),
        L('        increment_unlocked(counter, lock, yield_between)'), L('    # with 블록을 나가며 Lock을 놓는다', ['lockRelease'])]) };
    }
    return { sig: 'write', note: '실험에서 실행하지 않은 설명용 변형이다. 쓰기만 Lock으로 감쌌을 때를 보이려고 만들었다. 마지막 주석 줄도 덧붙인 줄이다.', lines: [
      L('def increment_write_only(counter, lock, yield_between):'), L('    previous = counter.completed', ['read']),
      L('    if yield_between:'), L('        time.sleep(0)', ['yield0']), L('    with lock:', ['lockAcquire']),
      L('        counter.completed = previous + 1', ['write']), L('    # with 블록을 나가며 Lock을 놓는다', ['lockRelease'])] };
  }

  function semCode() {
    const outer = fromCode(RC.CODE.asyncio, {
      'async with semaphore:': ['job:semAcquire'],
      'return await asyncio.gather(*(limited_job(job) for job in jobs))': ['main:spawn', 'main:awaitChildren', 'main:py'],
    });
    const at = outer.findIndex((ln) => ln.t.trim() === 'return await job_fn(job)');
    outer.splice(at + 1, 0, L(`${outer[at].t.match(/^\s*/)[0]}# 블록을 나가며 세마포어를 반납한다(release)`, ['job:exitSem']));
    const inner = fromCode(RC.CODE.asyncJob, { 'await asyncio.sleep(job.sleep_s)': ['job:asleep'] });
    return { sig: 'sem', note: `실험 코드에서 옮겼다. ${at + 2}번 줄 주석은 async with 블록을 나가며 세마포어를 반납하는 지점을 보이려고 덧붙였다.`,
      lines: outer.concat([L('')], inner) };
  }

  // A가 부르는 함수는 실험 코드(loop_kernels.py)의 세 함수 가운데 고른 것 하나만 보인다.
  function loopCode() {
    const a = cfg.loopAction;
    const blocks = RC.CODE.loop.split('\n\n');
    const fn = { blocking: 0, async: 1, cpu: 2 }[a];
    const action = fn == null ? [] : fromCode(blocks[fn], {
      'time.sleep(work.sleep_s)': ['A:1'], 'await asyncio.sleep(work.sleep_s)': ['A:1'], 'return 1': ['A:2'],
      'return sum(count_primes(work.n) for _ in range(work.cpu_jobs))': ['A:1', 'A:2'],
    });
    if (action.length) action[0].on = ['A:0'];
    const name = action.length ? action[0].t.match(/def (\w+)/)[1] : '';
    const lines = [
      L('async def heartbeat():  # Task B · 설명용 코드'),
      L('    start = loop.time()'),
      L('    for i in range(1, beats + 1):'),
      L('        due = start + i * period'),
      L('        await asyncio.sleep(max(0, due - loop.time()))', ['B:asleep']),
      L('        record(i, loop.time() - due)', ['B:record']),
      L(''),
      ...action, ...(action.length ? [L('')] : []),
      L('async def main():  # 설명용 코드'),
      L('    b = asyncio.create_task(heartbeat())', ['main:spawn']),
      ...(action.length ? [L('    a = asyncio.create_task(run_action())')] : []),
      L(action.length ? '    await asyncio.gather(b, a)' : '    await asyncio.gather(b)', ['main:awaitChildren', 'main:py']),
    ];
    const note = action.length
      ? `heartbeat()와 main()은 모형의 흐름을 보이려고 쓴 설명용 코드이고 실험 코드가 아니다. ${name}()는 실험 코드(loop_kernels.py)에서 옮겼다. 실험에서는 A Task가 run_action()을 실행하고 그 안에서 이 함수를 부른다.`
      : 'heartbeat()와 main()은 모형의 흐름을 보이려고 쓴 설명용 코드이고 실험 코드가 아니다. 이 구성은 A Task를 만들지 않는 대조군이다.';
    return { sig: `loop-${a}`, note, lines };
  }

  // 코드 줄에 붙일 실행 주체: [이름표, 줄 키, 상태]
  function actorsFor(v) {
    const out = [];
    if (!isLoop()) {
      for (const id of threadIds()) {
        const t = v.threads[id];
        if (!t.op || t.act === 'done') continue;
        const st = stateOf(t);
        out.push({ label: short(id), key: t.op.k, cls: st.cls, tip: `스레드 ${short(id)} · ${st.name}${st.why ? ` (${st.why})` : ''}` });
      }
      return out;
    }
    const th = v.threads[loopThread().id];
    for (const task of proc().loop.tasks) {
      const s = v.tasks[task.id];
      if (!s || !s.op || s.status === 'not-created' || s.status === 'done') continue;
      // 타이머를 기다리는 Task는 모형에서 이미 다음 연산으로 넘어가 있으므로 await asyncio.sleep 줄에 붙인다.
      const pc = s.status === 'wait-timer' ? Math.max(0, s.op.pc - 1) : s.op.pc;
      const op = task.ops[pc];
      const role = roleOf(task.id);
      const ran = s.current && th.act === 'run-py';
      const late = s.status === 'wait-timer' && s.due != null && s.due < v.step;
      const cls = ran ? 'run' : s.status === 'ready' ? 'turn' : 'event';
      const why = ran ? '' : { ready: '준비 큐', running: 'sleep 대기', 'wait-timer': late ? '만료 단계 지남' : '타이머 대기',
        'wait-children': 'gather 대기', 'wait-sem': '얻기 대기' }[s.status] || '';
      out.push({ label: taskShort(task.id), key: role === 'A' ? `A:${pc}` : `${role}:${op.k}`, cls: `${cls}${late ? ' late' : ''}`, ran,
        tip: `${taskLabel(task.id)} · ${ran ? '실행 중' : cls === 'turn' ? '차례 기다림' : '이벤트 기다림'}${why ? ` (${why})` : ''}` });
    }
    return out;
  }

  function renderCode(v) {
    const code = codeFor();
    const ol = $('#code');
    const sig = `${scene}|${code.sig}`;
    if (codeSig !== sig) {
      codeSig = sig;
      // Semaphore 장면은 "작업1"과 "+3" 이름표가 한 줄에 들어가도록 이름표 칸을 넓힌다.
      ol.style.setProperty('--marks', scene === 'sem' ? '84px' : '58px');
      ol.innerHTML = code.lines.map((ln, i) => `<li data-line="${i}"><span class="marks"></span><span class="ln">${i + 1}</span><code>${esc(ln.t) || ' '}</code></li>`).join('');
      $('#codeNote').textContent = code.note;
    }
    const byLine = new Map();
    for (const a of actorsFor(v)) {
      const li = code.lines.findIndex((ln) => ln.on.includes(a.key));
      if (li < 0) continue;
      if (!byLine.has(li)) byLine.set(li, []);
      byLine.get(li).push(a);
    }
    ol.querySelectorAll('li').forEach((li) => {
      let as = byLine.get(+li.dataset.line) || [];
      // Task가 많은 장면에서는 한 줄에 이름표를 둘까지만 둔다. 실행한 Task를 먼저 두고 나머지는 수로 적는다.
      let more = null;
      if (isLoop() && as.length > 2) {
        as = as.slice().sort((x, y) => (y.ran ? 1 : 0) - (x.ran ? 1 : 0));
        more = as.slice(1);
        as = as.slice(0, 1);
      }
      li.querySelector('.marks').innerHTML = as.map((a) => `<span class="chip ${a.cls}" title="${esc(a.tip)}">${esc(a.label)}</span>`).join('')
        + (more ? `<span class="chip more" title="${esc(more.map((a) => a.tip).join(' / '))}">+${more.length}</span>` : '');
    });
  }

  // ---------- 단계 띠 ----------

  function stripCell(k, cls, mark, tip) {
    return `<button type="button" tabindex="-1" class="c ${cls}" data-step="${k}" title="${esc(tip)}">${mark}</button>`;
  }

  function buildStrip() {
    const N = lastIdx();
    const pid = proc().id;
    const strip = $('#strip');
    strip.style.gridTemplateColumns = `auto repeat(${N}, 30px)`;
    const out = ['<div class="rh">단계</div>'];
    for (let k = 1; k <= N; k++) out.push(`<div class="ch" data-step="${k}">${k}</div>`);
    for (const id of threadIds()) {
      out.push(`<div class="rh">스레드 ${short(id)}</div>`);
      for (let k = 1; k <= N; k++) {
        const v = run.views[k];
        const t = v.threads[id];
        const st = stateOf(t);
        const lost = v.events.some((e) => e.type === 'lost' && e.ids[0] === id);
        const mark = !isLoop() && st.cls === 'run' && t.op ? OP_MARK[t.op.k] || '' : '';
        const tip = `단계 ${k} · 스레드 ${short(id)} · ${st.name}${st.why && st.cls !== 'done' ? ` (${st.why})` : ''}${st.cls === 'run' && t.label ? ` · ${t.label}` : ''}${lost ? ' · 다른 스레드의 증가를 덮어씀' : ''}`;
        out.push(stripCell(k, `${st.cls}${lost ? ' lost' : ''}`, mark, tip));
      }
    }
    if (isLoop()) {
      for (const id of track.tasks) {
        out.push(`<div class="rh">${esc(taskLabel(id))}</div>`);
        for (let k = 1; k <= N; k++) {
          const v = run.views[k];
          const st = taskState(id, v);
          const s = v.tasks[id];
          const mark = st.cls === 'run' && s.op ? TASK_MARK[s.op.k] || '' : '';
          const tip = st.cls === 'none' ? `단계 ${k} · ${taskLabel(id)} · 아직 없음`
            : `단계 ${k} · ${taskLabel(id)} · ${st.name}${st.why && st.cls !== 'done' ? ` (${st.why})` : ''}${st.cls === 'run' && s.label ? ` · ${s.label}` : ''}`;
          out.push(stripCell(k, `${st.cls}${st.late ? ' late' : ''}`, mark, tip));
        }
      }
      if (scene === 'sem') {
        out.push('<div class="rh">Semaphore 안</div>');
        let before = 0;
        for (let k = 1; k <= N; k++) {
          const n = track.per[k].slots.filter(Boolean).length;
          out.push(stripCell(k, `val${n !== before ? ' changed' : ''}`, String(n), `단계 ${k} 뒤 Semaphore 안의 Task ${n}개`));
          before = n;
        }
      }
    } else {
      out.push('<div class="rh">counter</div>');
      let before = run.views[0].after.counter[pid].value;
      for (let k = 1; k <= N; k++) {
        const v = run.views[k];
        const val = v.after.counter[pid].value;
        const lost = v.events.some((e) => e.type === 'lost');
        out.push(stripCell(k, `val${val !== before ? ' changed' : ''}${lost ? ' bad' : ''}`, String(val), `단계 ${k} 뒤 counter.completed = ${val}`));
        before = val;
      }
    }
    strip.innerHTML = out.join('');
  }

  function renderStripCursor() {
    const strip = $('#strip');
    strip.querySelectorAll('.cur').forEach((c) => c.classList.remove('cur'));
    const cells = strip.querySelectorAll(`[data-step="${idx}"]`);
    cells.forEach((c) => c.classList.add('cur'));
    // 지금 단계 칸이 보이도록 띠를 옆으로 민다. 줄 이름 칸은 왼쪽에 붙어 있으므로 그 너비를 뺀다.
    const head = cells[0];
    const wrap = strip.parentElement;
    if (!head) return;
    const hw = strip.querySelector('.rh').offsetWidth + 4;
    const left = head.offsetLeft;
    if (left < wrap.scrollLeft + hw || left + head.offsetWidth > wrap.scrollLeft + wrap.clientWidth) {
      wrap.scrollLeft = Math.max(0, left - hw - (wrap.clientWidth - hw) / 2);
    }
  }

  function renderLog() {
    const items = [];
    for (let k = 0; k <= idx; k++) {
      for (const e of run.views[k].events) items.push(`<li><span class="muted">${k}</span> ${esc(e.text)}</li>`);
    }
    $('#log').innerHTML = items.join('');
  }

  // ---------- 진행 ----------

  function render(animate) {
    const v = view();
    const anim = animate && !motionOff.matches;
    renderBoard(v, anim);
    renderCaption(v);
    renderCode(v);
    renderStripCursor();
    renderLog();
    $('#board').setAttribute('aria-label', describe(v));
    $('#scrub').value = String(idx);
    $('#stepNum').textContent = String(idx);
    $('#first').disabled = idx === 0;
    $('#prev').disabled = idx === 0;
    $('#next').disabled = idx === lastIdx();
    $('#last').disabled = idx === lastIdx();
    shown = idx;
  }

  function go(k) {
    const n = Math.max(0, Math.min(lastIdx(), k));
    const animate = shown >= 0 && Math.abs(n - shown) === 1;
    idx = n;
    render(animate);
  }

  function setPlaying(on) {
    const b = $('#play');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '❚❚ 멈춤' : '▶ 재생';
  }
  function pause() {
    if (timer) clearTimeout(timer);
    timer = null;
    setPlaying(false);
  }
  function play() {
    if (timer) { pause(); return; }
    if (idx >= lastIdx()) go(0);
    setPlaying(true);
    const tick = () => {
      go(idx + 1);
      if (idx >= lastIdx()) { pause(); return; }
      timer = setTimeout(tick, SPEEDS[speed].ms);
    };
    timer = setTimeout(tick, Math.min(500, SPEEDS[speed].ms));
  }

  function simulate() {
    run = M.simulate(cfg);
    track = buildTrack();
    idx = 0;
    shown = -1;
    codeSig = null;
    buildBoard();
    buildStrip();
    renderCounts();
    $('#scrub').max = String(lastIdx());
    $('#stepMax').textContent = String(lastIdx());
    render(false);
  }

  function makeCfg(key, patch) {
    const d = SCENES[key];
    const next = Object.assign({}, cfgs[key] || d.start, patch || {});
    for (const [k, [lo, hi]] of Object.entries(d.range)) if (next[k] != null) next[k] = Math.min(hi, Math.max(lo, +next[k]));
    return M.normalizeConfig(Object.assign(next, d.base));
  }

  function setConfig(patch) {
    cfg = makeCfg(scene, patch);
    cfgs[scene] = cfg;
    pause();
    simulate();
    syncControls();
  }

  // ---------- 장면 고르기와 장면별 조절 ----------

  const OPTS = {
    counter: { label: 'Lock 범위', key: 'lockScope', items: [['none', '없음'], ['write', '쓰기만'], ['full', '읽기부터 쓰기까지']] },
    loop: { label: 'A가 하는 일', key: 'loopAction', items: [['idle', 'A 없음'], ['blocking', 'time.sleep'], ['async', 'await sleep'], ['cpu', 'CPU 계산']] },
    sem: { label: 'Semaphore 상한', key: 'semaphore', items: [[1, '1'], [2, '2'], [3, '3'], [4, '4']] },
  };
  const CFG_NOTE = {
    counter: '스레드마다 counter를 한 번 늘린다. 이 시험판은 프로세스 하나만 그린다.',
    loop: 'B는 실험의 12번 대신 두 번만 재개한다. 단계 수는 설명용이다. 이 시험판은 프로세스 하나만 그린다.',
    sem: '작업 Task마다 await asyncio.sleep()을 한 번 한다. 이 시험판은 프로세스 하나만 그린다.',
  };
  const STRIP_NOTE = {
    counter: '칸 글자: 읽 counter 읽기 · 쓰 counter 쓰기 · 0 time.sleep(0) · 잠 Lock 잡기 · 풀 Lock 놓기',
    loop: '칸 글자: 생 Task 만들기 · 타 await asyncio.sleep()으로 타이머 등록 · 기 재개 기록. 주황 칸: 만료 단계가 지났는데 아직 실행하지 못한 Task.',
    sem: '칸 글자: 생 Task 만들기 · 얻 세마포어 얻기(acquire) · 타 await asyncio.sleep()으로 타이머 등록 · 반 세마포어 반납(release). 주황 칸: 만료 단계가 지났는데 아직 실행하지 못한 Task.',
  };
  const BOARD_NOTE = '옅은 칸은 Task가 머무는 곳이다. 알약은 그 단계가 끝난 뒤 Task가 있는 칸에 놓이고, 알약 모양도 그 칸의 상태를 따른다. 실행 중 칸은 루프 스레드와 이어진 한 자리라서 Task가 하나만 앉는다. 그 단계에 실행하고 다른 칸으로 간 Task는 한 단계씩 넘길 때 이 자리를 거쳐 옮겨 간다. 이벤트 루프 상자에는 루프가 직접 가진 칸(실행 중, 준비 큐, 타이머)만 넣었고, gather나 Semaphore를 기다리는 Task는 상자 밖 칸에 둔다.';

  function content() { return RC.SCENES[scene] || { questions: [], observe: [], measured: [] }; }

  // 다른 화면의 칸 이름을 가리키는 문장은 이 화면에 맞게 줄인다.
  function observeList() {
    const list = content().observe || [];
    if (scene === 'counter') return list.filter((o) => !o.startsWith('프로세스를 늘리면'));
    if (scene === 'loop') return list.map((o) => o.replace(' 스레드 칸은 하나이고 Task 칸이 둘이다.', ''));
    return list;
  }

  function buildSceneText() {
    const d = SCENES[scene];
    const c = content();
    document.querySelectorAll('[data-scene]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scene === scene)));
    $('#sceneTitle').textContent = d.label;
    $('#questions').innerHTML = (c.questions || []).map((q) => `<li>${esc(q)}</li>`).join('');
    $('#observe').innerHTML = observeList().map((o) => `<li>${esc(o)}</li>`).join('');
    $('#measured').innerHTML = (c.measured || []).map((m) => `<li>${esc(m)}</li>`).join('');
    $('#guess').value = store.get(d.guessKey) || '';
    $('#stripNote').textContent = STRIP_NOTE[scene];
    const states = '<li><i class="sw run"></i>실행 중</li><li><i class="sw turn"></i>차례 기다림</li><li><i class="sw event"></i>이벤트 기다림</li><li><i class="sw done"></i>끝</li>';
    const box = '<li><i class="shape box"></i>상자: 포함 관계</li>';
    $('#legend').innerHTML = isLoop()
      ? `${box}<li><i class="shape lane"></i>옅은 칸: Task가 머무는 곳</li><li><i class="shape circle"></i>OS 스레드</li><li><i class="shape pill"></i>Task</li>${states}<li><i class="sw late"></i>만료 단계 지남</li>`
      : `${box}<li><i class="shape circle"></i>OS 스레드</li>${states}`;
    $('#boardNote').hidden = !isLoop();
    $('#boardNote').textContent = isLoop() ? BOARD_NOTE : '';

    const o = OPTS[scene];
    $('#opts').innerHTML = `<span id="optsLabel">${esc(o.label)}</span>`
      + o.items.map(([val, label]) => `<button type="button" data-opt="${o.key}" data-val="${val}">${esc(label)}</button>`).join('');

    const parts = [`<label>빌드와 GIL <select id="gil">${Object.entries(M.GIL_MODES).map(([k, g]) => `<option value="${k}">${esc(g.label)}</option>`).join('')}</select></label>`];
    if (scene === 'counter') parts.push('<label class="chk"><input type="checkbox" id="yield"> 읽기와 쓰기 사이 time.sleep(0)</label>');
    for (const k of Object.keys(STEPPERS)) {
      if (!d.range[k]) continue;
      parts.push(`<div class="num" data-k="${k}"><span>${STEPPERS[k]}</span><button type="button" data-d="-1" aria-label="${STEPPERS[k]} 줄이기">−</button><output></output><button type="button" data-d="1" aria-label="${STEPPERS[k]} 늘리기">+</button></div>`);
    }
    parts.push(`<p class="note">${esc(CFG_NOTE[scene])}</p>`);
    $('#cfg').innerHTML = parts.join('');
  }

  function syncControls() {
    const o = OPTS[scene];
    document.querySelectorAll('[data-opt]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.val === String(cfg[o.key]))));
    $('#gil').value = cfg.gil;
    if ($('#yield')) $('#yield').checked = cfg.yieldBetween;
    const range = SCENES[scene].range;
    document.querySelectorAll('.num').forEach((row) => {
      const k = row.dataset.k;
      const [lo, hi] = range[k];
      row.querySelector('output').textContent = String(cfg[k]);
      row.querySelector('[data-d="-1"]').disabled = cfg[k] <= lo;
      row.querySelector('[data-d="1"]').disabled = cfg[k] >= hi;
    });
  }

  function setScene(key) {
    if (!SCENES[key]) key = 'counter';
    pause();
    scene = key;
    cfg = cfgs[key] || makeCfg(key);
    cfgs[key] = cfg;
    store.set(SCENE_KEY, key);
    if (location.hash !== `#${key}`) {
      try { history.replaceState(null, '', `#${key}`); } catch (e) { /* 주소를 못 바꿔도 장면은 바뀐다 */ }
    }
    buildSceneText();
    simulate();
    renderMap();
    syncControls();
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowRight') { pause(); go(idx + 1); }
    else if (e.key === 'ArrowLeft') { pause(); go(idx - 1); }
    else if (e.key === 'Home') { pause(); go(0); }
    else if (e.key === 'End') { pause(); go(lastIdx()); }
    else if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'SUMMARY' && tag !== 'A') play();
    else return;
    e.preventDefault();
  }

  function bindControls() {
    $('#speed').innerHTML = SPEEDS.map((s, i) => `<option value="${i}">${s.label}</option>`).join('');
    $('#speed').value = String(speed);
    $('#guess').addEventListener('input', (e) => store.set(SCENES[scene].guessKey, e.target.value));
    $('#first').addEventListener('click', () => { pause(); go(0); });
    $('#prev').addEventListener('click', () => { pause(); go(idx - 1); });
    $('#next').addEventListener('click', () => { pause(); go(idx + 1); });
    $('#last').addEventListener('click', () => { pause(); go(lastIdx()); });
    $('#play').addEventListener('click', play);
    $('#speed').addEventListener('change', (e) => { speed = +e.target.value; });
    $('#scrub').addEventListener('input', (e) => { pause(); go(+e.target.value); });
    $('#strip').addEventListener('click', (e) => {
      const c = e.target.closest('[data-step]');
      if (c) { pause(); go(+c.dataset.step); }
    });
    document.querySelectorAll('[data-scene]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.scene !== scene) setScene(b.dataset.scene); }));
    $('#opts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-opt]');
      if (!b) return;
      const key = b.dataset.opt;
      setConfig({ [key]: key === 'semaphore' ? +b.dataset.val : b.dataset.val });
    });
    $('#cfg').addEventListener('change', (e) => {
      if (e.target.id === 'gil') setConfig({ gil: e.target.value });
      if (e.target.id === 'yield') setConfig({ yieldBetween: e.target.checked });
    });
    $('#cfg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-d]');
      if (!b) return;
      const k = b.closest('.num').dataset.k;
      setConfig({ [k]: cfg[k] + +b.dataset.d });
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', () => {
      const key = location.hash.slice(1);
      if (SCENES[key] && key !== scene) setScene(key);
    });
  }

  bindControls();
  buildMap();
  const fromHash = location.hash.slice(1);
  setScene(SCENES[fromHash] ? fromHash : store.get(SCENE_KEY) || 'counter');

  // 관계도와 지도 칸의 너비가 바뀌면 좌표를 다시 잡는다. 화면 폭과 상관없이 글자 크기를 유지하려는 것이다.
  let boardW = $('#boardWrap').clientWidth;
  let mapW = $('#mapWrap').clientWidth;
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const w = $('#boardWrap').clientWidth;
      if (Math.abs(w - boardW) < 2) return;
      boardW = w;
      buildBoard();
      render(false);
    }).observe($('#boardWrap'));
    new ResizeObserver(() => {
      const w = $('#mapWrap').clientWidth;
      if (Math.abs(w - mapW) < 2) return;
      mapW = w;
      buildMap();
      renderMap();
    }).observe($('#mapWrap'));
  }

  // 브라우저 확인용
  // 확인 스크립트용: 실행 자리를 거쳐 가는 중인 알약을 바로 제 칸에 둔다.
  function settle() { document.querySelectorAll('#board .tk').forEach((p) => { if (p._hopFn) { clearTimeout(p._hop); p._hopFn(); } }); }
  window.__runtimeBoard = { get scene() { return scene; }, get cfg() { return cfg; }, get idx() { return idx; }, get run() { return run; },
    get track() { return track; }, get geo() { return geo; }, go, setConfig, setScene, settle };
})();
