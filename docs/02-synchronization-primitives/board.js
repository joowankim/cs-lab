/*
 * 동기화 관계도: 위에는 전체 지도 하나, 아래에는 고른 장면의 관계도.
 * 모든 장면은 model.js가 만든 단계 기록을 그대로 그린다. 장면마다 그 장면에 필요한 요소만 그리고,
 * 같은 요소는 지도와 장면에서 같은 모양으로 그린다(스레드 원, GIL 꼬리표, 객체 상자).
 * 스레드의 실행 여부(채움, 코드 이름표, 단계 띠 칸)는 그 단계 동안의 상태이고, 값과 자원(락의 잠금, 세마포어 카운터,
 * 대기 목록, jobs, 잔액, 쥔 것과 기다리는 것을 잇는 선, GIL)은 그 단계가 끝난 뒤의 상태다.
 * 연결선은 두 끝에서 세로로 나가고 들어오는 곡선으로 그린다. 식사하는 철학자의 둥근 식탁에서만 곧은 선을 쓴다.
 * 그림 요소마다 뜻은 하나다: 테두리 상자는 무엇이 무엇 안에 있는지, 모양은 종류, 채움과 점선은 실행 상태,
 * 파란 선은 쥔 것, 회색 점선은 기다리는 것, 주황은 문제(상한 초과, 오류, 기다림의 고리)다.
 * 관계도의 요소를 고르면 설명 칸에 그 요소의 개념, 지금 상태, 근거가 나온다.
 * 단계는 이벤트의 순서이고 시간 길이가 아니다.
 *
 * 장면을 더하려면 model.js에 장면을 만들고, 여기의 SCENES와 장면별 함수(objectList, codeFor, valueRows, resultText,
 * objSummary, partsFor, renderCounts)에 그 장면을 더하고, content.js의 SCENES에 같은 이름으로 질문, 볼 것, 실측 기록, 근거를 적는다.
 */
(function () {
  'use strict';

  const M = window.SyncModel;
  const RC = window.SyncContent || { SCENES: {}, CODE: {}, ELEMENTS: {}, UNUSED: {}, EV: {}, CARDS: {}, TYPE_LABEL: {} };
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const motionOff = window.matchMedia('(prefers-reduced-motion: reduce)');

  const SPEEDS = [{ label: '느리게', ms: 2000 }, { label: '보통', ms: 1200 }, { label: '빠르게', ms: 600 }];
  const SCENE_KEY = 'sync-board-scene';
  const DEFAULT_SCENE = 'release';
  // 스레드 상자의 가장 좁은 너비. 관계도가 이보다 좁아지면 줄이지 않고 관계도 칸 안에서 옆으로 밀어 보게 한다.
  const BOX_MIN = 58;
  // 둥근 식탁의 가장 좁은 너비. 이보다 좁으면 철학자와 포크 상자가 겹치므로 옆으로 밀어 보게 한다.
  const TABLE_MIN = 320;

  const SCENES = {
    release: { group: 'locks', label: '이중 release()' },
    buffer: { group: 'cond', label: '조건 변수 버퍼' },
    onecond: { group: 'cond', label: '버퍼 크기 1' },
    wait: { group: 'cond', label: '기다리는 방법' },
    transfer: { group: 'deadlock', label: '이체' },
    phil: { group: 'deadlock', label: '식사하는 철학자' },
  };
  const GROUPS = [['locks', '락과 세마포어'], ['cond', '조건 변수와 기다리기'], ['deadlock', '교착 상태']];

  // 설명 한 문장으로 고를 이벤트의 순서. 문제를 알리는 이벤트(bad)를 먼저 고르고, 그다음 실행한 스레드가 한 일을 고른다.
  const BAD_ORDER = ['stuck', 'spin', 'thread-error', 'error', 'foreign', 'extra', 'over', 'self-wait', 'settled'];
  const PRIORITY = ['timeout', 'barge', 'handoff', 'empty-wake', 'pop', 'append', 'notify', 'notify-none', 'event-set', 'flag-set',
    'try-fail', 'retry', 'move', 'eat', 'cond-wait', 'lock-wait', 'sem-wait', 'event-wait', 'reenter', 'lock-got', 'cond-back',
    'lock-take', 'sem-acquire', 'lock-wake', 'sem-wake', 'lock-release', 'sem-release', 'api-enter', 'later', 'woke',
    'transfer-done', 'job-done', 'settled', 'busy', 'load', 'sleep', 'settle-wait', 'done', 'gil-switch', 'gil-take',
    'timer', 'until', 'idle', 'end', 'start'];
  // 단계 띠 칸에 적는 글자: 그 단계에 실행한 스레드가 한 동기화 연산. 여러 개면 앞의 것을 적는다.
  const MARKS = [
    ['!', ['thread-error', 'error']],
    ['풀', ['lock-release', 'foreign', 'sem-release', 'extra']],
    ['깨', ['notify', 'notify-none', 'event-set']],
    ['꺼', ['pop']],
    ['넣', ['append']],
    ['잡', ['lock-take', 'lock-got', 'reenter', 'sem-acquire']],
    ['호', ['api-enter', 'over']],
    ['이', ['move']],
    ['먹', ['eat']],
    ['다', ['retry']],
  ];
  const STATE_NAME = { run: '실행 중', turn: '차례 기다림', event: '이벤트 기다림', done: '끝' };

  let scene = DEFAULT_SCENE;
  const cfgs = {};
  let cfg = null;
  let run = null;
  let idx = 0;
  let shown = -1;
  let speed = 1;
  let timer = null;
  let geo = null;
  let code = null;
  let codeSig = null;
  // 설명 칸에 보이는 요소(th:스레드, obj:객체, gil)와, 고정된 설명을 마지막으로 채운 요소
  let selected = null;
  let detailsFor = null;

  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 저장하지 못해도 화면은 그대로 쓴다 */ } },
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function el(tag, attrs, parent, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  // 글자 너비 어림값(px). 상자에 글자가 들어가는지 미리 볼 때 쓴다. 한글은 글자 크기만큼, 영문과 숫자는 그보다 좁게 잡는다.
  function tw(text, fs) {
    let w = 0;
    for (const ch of String(text || '')) {
      const c = ch.codePointAt(0);
      if (c >= 0xac00 && c <= 0xd7a3) w += fs * 0.96;
      else if (/[A-Z]/.test(ch)) w += fs * 0.68;
      else if (/[a-z0-9_]/.test(ch)) w += fs * 0.57;
      else if (ch === ' ') w += fs * 0.3;
      else w += fs * 0.45;
    }
    return w;
  }
  // 글자 너비(px). 화면의 글꼴로 직접 잰다. 글꼴이 기기마다 달라도 상자 크기와 줄 나눔이 그 글꼴에 맞는다. 잴 수 없으면 어림값을 쓴다.
  const widths = new Map();
  let ruler = null;
  function textW(text, size, weight) {
    const s = String(text || '');
    if (!s) return 0;
    const key = `${size}|${weight || 400}|${s}`;
    if (widths.has(key)) return widths.get(key);
    if (!ruler) {
      const svg = el('svg', { class: 'ruler', 'aria-hidden': 'true' });
      ruler = el('text', {}, svg);
      document.body.appendChild(svg);
    }
    ruler.style.fontSize = `${size}px`;
    ruler.style.fontWeight = String(weight || 400);
    ruler.textContent = s;
    const w = ruler.getComputedTextLength() || tw(s, size);
    widths.set(key, w);
    return w;
  }
  // 한 줄에 들어가지 않으면 마지막 빈칸에서 두 줄로 나눈다.
  function fitLines(text, size, weight, maxW) {
    const s = text || '';
    if (textW(s, size, weight) <= maxW) return [s, ''];
    const k = s.lastIndexOf(' ');
    return k < 0 ? [s, ''] : [s.slice(0, k), s.slice(k + 1)];
  }
  const josa = (w, pair) => M.josa(w, pair);

  function view() { return run.views[idx]; }
  function lastIdx() { return run.views.length - 1; }
  function threads() { return run.threads; }
  function thread(id) { return run.threads.find((t) => t.id === id); }
  function tIndex(id) { return run.threads.findIndex((t) => t.id === id); }
  function gilOn() { return run.views[0].gil != null; }
  function stateText(s) {
    const why = whyText(s.why);
    return `${STATE_NAME[s.cls]}${why && why !== STATE_NAME[s.cls] ? ` (${why})` : ''}`;
  }

  // 단계 끝의 객체. 기다리는 방법 장면의 pass·sleep 구성에는 모형에 Event가 없다. 실험의 Ready는 Event를 늘 만들고
  // set()에서 flag와 함께 올리므로, 관계도에는 flag를 따라 그린다.
  function objOf(id, v) {
    const o = v.obj[id];
    if (o) return o;
    if (scene === 'wait' && id === 'event') return { id: 'event', type: 'event', name: 'ready.event', flag: v.obj.ready.flag, waiters: [], unused: true };
    return null;
  }
  function eventUnused() { return scene === 'wait' && cfg.how !== 'event'; }
  function twoConds() { return scene === 'onecond' && cfg.fix === 'two'; }

  // ---------- 요소 이름과 고르기 ----------

  function typeOf(sel) {
    if (sel === 'gil') return 'gil';
    if (sel.startsWith('th:')) return 'thread';
    const o = objOf(sel.slice(4), run.views[0]);
    if (o.type === 'lock') return scene === 'phil' ? 'fork' : 'lock';
    if (o.type === 'sem') return scene === 'phil' ? 'waiter' : o.bounded ? 'bsem' : 'sem';
    return o.type;
  }

  function threadTitle(t) {
    if (scene === 'buffer' || scene === 'onecond') return t.role === 'producer' ? `업로드 스레드 ${t.name}` : `작업자 ${t.name}`;
    if (scene === 'wait') return t.role === 'loader' ? `로더 ${t.name}` : `요청 처리 스레드 ${t.name}`;
    if (scene === 'phil') return `철학자 ${t.name}`;
    if (scene === 'transfer') return `스레드 ${t.name} (${t.src}→${t.dst})`;
    return `스레드 ${t.name}`;
  }
  // 단계 띠 줄 이름
  function rowName(t) {
    if (scene === 'buffer' || scene === 'onecond') return t.role === 'producer' ? `업로드 ${t.name}` : `작업자 ${t.name}`;
    if (scene === 'wait') return t.role === 'loader' ? `로더 ${t.name}` : `요청 ${t.name}`;
    if (scene === 'transfer') return `${t.name} ${t.src}→${t.dst}`;
    if (scene === 'phil') return `철학자 ${t.name}`;
    return `스레드 ${t.name}`;
  }
  function objTitle(o) {
    if (o.type === 'api') return '가짜 API';
    if (o.type === 'account') return `계좌 ${o.name}`;
    if (o.type === 'flag') return 'ready.flag';
    if (o.type === 'cond') return `조건 변수 ${o.name}`;
    if (scene === 'phil' && o.type === 'sem') return '웨이터 Semaphore(4)';
    if ((scene === 'buffer' || scene === 'onecond') && o.id === 'lock') return o.type === 'rlock' ? 'cond 안의 RLock' : 'lock (Lock)';
    return o.name;
  }
  function nameOf(sel) {
    if (sel === 'gil') return 'GIL';
    if (sel.startsWith('th:')) return threadTitle(thread(sel.slice(3)));
    return objTitle(objOf(sel.slice(4), view() || run.views[0]));
  }

  // 고를 수 있는 요소. 누르거나 Tab으로 옮겨 Enter를 누르면 설명 칸에 그 요소의 설명이 나온다.
  // 한 요소를 도형 여러 개로 그리면(스레드 상자와 원, GIL 자리와 꼬리표) 하나만 Tab으로 옮겨 갈 수 있게 한다.
  function selAttrs(id, focus) {
    const a = { 'data-sel': id };
    if (focus !== false) Object.assign(a, { tabindex: '0', role: 'button', 'aria-label': nameOf(id) });
    return a;
  }
  // 상태에 따라 class를 바꿔도 고른 요소 표시(sel)는 남긴다.
  function setCls(node, cls) {
    node.setAttribute('class', node.dataset.sel != null && node.dataset.sel === selected ? `${cls} sel` : cls);
  }
  function markSelected() {
    const svg = $('#board');
    svg.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel'));
    if (selected) svg.querySelectorAll(`[data-sel="${selected}"]`).forEach((n) => n.classList.add('sel'));
  }

  // ---------- 공통 그림 ----------

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

  // 이름 목록을 너비에 맞춰 여러 줄로 나눈다. 앞의 이름이 대기 목록의 맨 앞이다.
  function wrapNames(names, width, fs) {
    const lines = [];
    let cur = '';
    names.forEach((n, i) => {
      const piece = i < names.length - 1 ? `${n},` : n;
      const next = cur ? `${cur} ${piece}` : piece;
      if (cur && textW(next, fs) > width) { lines.push(cur); cur = piece; } else cur = next;
    });
    if (cur) lines.push(cur);
    return lines;
  }

  function buildBoard() {
    geo = scene === 'phil' ? layoutTable() : layoutRow();
    const g = geo;
    const svg = $('#board');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
    svg.style.width = g.scroll ? `${g.W}px` : '';
    svg.style.maxWidth = g.scroll ? 'none' : '';
    svg.classList.toggle('compact', g.compact);
    g.nodes = {};
    if (scene === 'phil') buildTable(svg, g); else buildRow(svg, g);
  }

  function renderBoard(v, animate) {
    $('#board').classList.toggle('instant', !animate);
    renderThreads(v);
    renderObjects(v);
    renderLinks(v);
    renderGil(v, animate);
    markSelected();
  }

  // ---------- 한 줄 배치 (이중 release(), 버퍼, 기다리는 방법, 이체) ----------
  // 위에 스레드 상자를 한 줄로 두고, 아래에 스레드들이 함께 쓰는 객체를 둔다. 스레드 상자에는 원과 그 스레드만 쓰는 것
  // (쥔 GIL, 기다리는 이유, 맡은 일)만 담는다. 스레드 하나가 BOX_MIN보다 좁아지면 줄이지 않고 옆으로 밀어 보게 한다.

  function layoutRow() {
    const ths = threads();
    const T = ths.length;
    const avail = Math.floor($('#boardWrap').clientWidth) || 600;
    // 선이 들어오는 상자는 한 줄에 둔다. 좁은 화면의 크기로도 한 줄에 들어가지 않으면 관계도를 줄이지 않고 옆으로 밀어 보게 한다.
    const linked = objectList(true).filter((b) => b.link);
    const rowNeed = 12 + linked.reduce((sum, b) => sum + b.w, 0) + 8 * (linked.length - 1);
    const W = Math.ceil(Math.max(260, 12 + T * BOX_MIN + (T - 1) * 4, rowNeed, Math.min(640, avail)));
    const compact = W < 480;
    const m = compact ? 6 : 12;
    const sep = compact ? 4 : 10;
    const r = compact ? 16 : 18;
    const g = { W, compact, scroll: W > avail + 1, m, sep, r, gap: compact ? 8 : 14, bw: compact ? 36 : 44, bh: 20, fs: compact ? 11 : 12 };
    g.gilOn = gilOn();
    let y = 8;
    // 빈 GIL 자리는 스레드 줄 위, 왼쪽 끝에 둔다.
    if (g.gilOn) { g.home = { x: m + 2 + g.bw / 2, y: y + g.bh / 2 }; y += g.bh + 12; }
    const thTop = y;
    const cy = thTop + 8 + r;
    const gilY = cy + r + 14;
    const whyY = g.gilOn ? gilY + 26 : cy + r + 18;
    const col = (W - 2 * m + sep) / T;
    const boxW = Math.min(col - sep, 150);
    const x0 = (W - (T * boxW + (T - 1) * sep)) / 2;
    g.boxW = boxW;
    g.fit = boxW - 8;
    // 기다리는 이유와 맡은 일이 상자에 들어가지 않으면 마지막 빈칸에서 두 줄로 나눈다. 단계마다 상자 높이가 바뀌지 않도록 모든 단계를 미리 본다.
    const states = run.views.flatMap((v) => Object.values(v.th)).filter((s) => !(s.cls === 'done' && s.dead));
    g.whyStack = states.some((s) => textW(whyText(s.why), g.fs) > g.fit);
    g.stack = states.some((s) => textW(s.local, g.fs) > g.fit);
    const localY = whyY + 16 + (g.whyStack ? 14 : 0);
    g.thB = localY + 8 + (g.stack ? 15 : 0);
    g.thPos = ths.map((_, i) => ({ x: x0 + i * (boxW + sep) + boxW / 2, cy, gilY, whyY, localY }));
    g.thBox = g.thPos.map((p) => ({ x: p.x - boxW / 2, y: thTop, w: boxW, h: g.thB - thTop }));
    g.objTop = g.thB + (compact ? 40 : 48);
    placeObjects(g);
    return g;
  }

  // 장면마다 객체 상자와 크기. link는 스레드에서 선이 들어오는 상자다. 이름이 긴 상자는 이름 너비에 맞춰 넓힌다.
  function objectList(c) {
    const v0 = run.views[0];
    const lbl = c ? 11 : 12;
    const st = c ? 12 : 13;
    if (scene === 'release') {
      const o = v0.obj.slots;
      const api = v0.obj.api;
      // 좁은 화면에서는 가짜 API 상자의 셋째 줄을 둘로 나눠 상자를 좁힌다(호출 수, 나중 큐).
      const apiText = c ? ['호출 4번', '나중 큐 4'] : ['호출 4번 · 나중 큐 4'];
      const slotsW = Math.max(c ? 104 : 160, textW(o.name, lbl) + 20, textW(o.type === 'rlock' ? '주인 A · 수준 1' : '잠금 해제', st, 600) + 20);
      const apiW = Math.max(c ? 96 : 170, textW(`가짜 API · 상한 ${api.limit}`, lbl) + 20, textW('동시 호출 3개', st, 600) + 20,
        ...apiText.map((x) => textW(x, lbl) + 20));
      return [{ id: 'slots', kind: 'slots', w: slotsW, h: 60, link: true }, { id: 'api', kind: 'api', w: apiW, h: c ? 90 : 76, link: true }];
    }
    if (scene === 'buffer' || scene === 'onecond') {
      const cap = v0.obj.jobs.cap;
      const cell = c ? 20 : 26;
      const jobs = { id: 'jobs', kind: 'jobs', w: Math.max(cap * cell + (cap - 1) * 3 + 16, c ? 88 : 104), h: cell + 38, cap, cell, link: false };
      if (twoConds()) {
        return [{ id: 'lock', kind: 'lockbox', w: c ? 64 : 96, h: 52, link: true },
          { id: 'notFull', kind: 'condTwo', w: c ? 78 : 110, h: 62, link: true }, { id: 'notEmpty', kind: 'condTwo', w: c ? 78 : 110, h: 62, link: true }, jobs];
      }
      return [{ id: 'cond', kind: 'cond', w: c ? 168 : 220, h: 92, link: true }, jobs];
    }
    if (scene === 'wait') return [{ id: 'ready', kind: 'ready', w: c ? 200 : 240, h: 102, link: true }];
    return Object.values(v0.obj).filter((o) => o.type === 'account').map((o) => ({ id: o.id, kind: 'account', w: c ? 118 : 150, h: 98, link: true }));
  }

  // 선이 들어오는 상자는 모두 첫 줄에 둔다(관계도 너비가 그만큼은 되도록 layoutRow에서 정했다). 나머지 상자는 첫 줄에 들어가면 붙이고,
  // 넘치면 다음 줄로 넘긴다. 줄마다 가운데에 모은다. 그래서 선이 다른 상자를 지나가지 않는다.
  function placeObjects(g) {
    const inner = g.W - 2 * g.m;
    const gap = g.gap;
    const list = objectList(g.compact);
    const rows = [list.filter((b) => b.link)];
    let w = rows[0].reduce((sum, b) => sum + b.w, 0) + gap * (rows[0].length - 1);
    for (const b of list.filter((x) => !x.link)) {
      const cur = rows[rows.length - 1];
      if (cur.length && w + gap + b.w > inner) { rows.push([b]); w = b.w; } else { w += (cur.length ? gap : 0) + b.w; cur.push(b); }
    }
    g.objs = {};
    g.anchor = {};
    let y = g.objTop;
    rows.forEach((row, k) => {
      const total = row.reduce((sum, b) => sum + b.w, 0) + gap * (row.length - 1);
      let x = (g.W - total) / 2;
      // 이체의 두 계좌는 보내는 스레드 아래에 하나씩 둔다. 두 선이 엇갈리는 모양이 서로 기다리는 모양이다.
      const under = scene === 'transfer' && row.length === threads().length && row.length > 1;
      for (const [i, b] of row.entries()) {
        b.x = under ? Math.max(g.m, Math.min(g.W - g.m - b.w, g.thPos[i].x - b.w / 2)) : x;
        b.y = y;
        x += b.w + gap;
        g.objs[b.id] = b;
      }
      y += Math.max(...row.map((b) => b.h)) + (k < rows.length - 1 ? 14 : 0);
    });
    g.H = y + 8;
    // 선이 들어오는 자리. 상자 안의 작은 상자(조건 변수 안의 락, 계좌의 락, Ready의 Event)로 가는 선은 그 작은 상자의 위쪽 가장자리에서 끝난다.
    for (const b of Object.values(g.objs)) {
      if (b.kind === 'cond') {
        b.sub = { x: b.x + 8, y: b.y + 8, w: g.compact ? 80 : 100, h: 56 };
        b.listX = b.sub.x + b.sub.w + 10;
        g.anchor.lock = { x: b.sub.x, y: b.sub.y, w: b.sub.w };
        g.anchor.cond = { x: b.listX - 4, y: b.y, w: b.x + b.w - 6 - (b.listX - 4) };
      } else if (b.kind === 'ready') {
        b.sub = { x: b.x + 8, y: b.y + 8, w: b.w - 16, h: 44 };
        g.anchor.event = { x: b.sub.x, y: b.sub.y, w: b.sub.w };
      } else if (b.kind === 'account') {
        b.sub = { x: b.x + 8, y: b.y + 8, w: b.w - 16, h: 44 };
        g.anchor[run.views[0].obj[b.id].lock] = { x: b.sub.x, y: b.sub.y, w: b.sub.w };
      } else if (b.kind !== 'jobs') {
        g.anchor[b.id] = { x: b.x, y: b.y, w: b.w };
      }
    }
  }

  function buildRow(svg, g) {
    if (g.gilOn) {
      const home = el('rect', Object.assign({ class: 'gil-home', x: g.home.x - g.bw / 2, y: g.home.y - g.bh / 2, width: g.bw, height: g.bh, rx: 6 }, selAttrs('gil', false)), svg);
      el('title', {}, home, 'GIL 자리: GIL을 쥔 스레드가 없으면 꼬리표가 여기로 돌아온다');
    }
    drawThreadBoxes(svg, g);
    drawObjects(svg, g);
    // 연결선은 객체 상자 위에 그린다. 상자 안의 작은 상자로 가는 선이 바깥 상자의 테두리를 지나 보이게 하려는 것이다.
    g.cnG = el('g', { class: 'cns' }, svg);
    drawThreads(svg, g);
    if (g.gilOn) drawGil(svg, g);
  }

  function drawThreadBoxes(svg, g) {
    const boxes = el('g', { class: 'thboxes' }, svg);
    threads().forEach((t, i) => {
      const b = g.thBox[i];
      el('rect', Object.assign({ class: 'thbox', x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, selAttrs(`th:${t.id}`, false)), boxes);
    });
  }

  // 스레드 원, 이름, 기다리는 이유, 맡은 일. 오류 이름은 끝난 스레드를 흐리게 그려도 흐려지지 않도록 원 무리 밖에 둔다.
  function drawThreads(svg, g) {
    const ths = el('g', { class: 'threads' }, svg);
    const errs = el('g', { class: 'errs' }, svg);
    threads().forEach((t, i) => {
      const p = g.thPos[i];
      const node = el('g', Object.assign({ class: 'th', 'data-id': t.id }, selAttrs(`th:${t.id}`)), ths);
      el('circle', { cx: p.x, cy: p.cy, r: g.r }, node);
      el('text', { class: 'name', x: p.x, y: p.cy + 5, 'text-anchor': 'middle' }, node, t.name);
      const why = el('text', { class: 'why', x: p.x, y: p.whyY, 'text-anchor': 'middle' }, node);
      el('tspan', { class: 'w1' }, why, '');
      el('tspan', { class: 'w2', x: p.x, dy: 14 }, why, '');
      const local = el('text', { class: 'local', x: p.x, y: p.localY, 'text-anchor': 'middle' }, node);
      el('tspan', { class: 'l1' }, local, '');
      el('tspan', { class: 'l2', x: p.x, dy: 15 }, local, '');
      el('text', { class: 'err', 'data-id': t.id, x: p.x, y: p.whyY, 'text-anchor': 'middle' }, errs, '');
    });
  }

  function drawGil(svg, g) {
    const gil = el('g', Object.assign({ class: 'gil free' }, selAttrs('gil')), svg);
    el('rect', { x: -g.bw / 2, y: -g.bh / 2, width: g.bw, height: g.bh, rx: 6 }, gil);
    el('text', { x: 0, y: 4, 'text-anchor': 'middle' }, gil, 'GIL');
    setPos(gil, g.home, true);
  }

  // 객체 상자. 이름은 상자 위쪽 왼편에 적고, 다른 상자를 담는 상자는 담긴 상자를 가리지 않도록 이름을 아래쪽 왼편에 적는다.
  function objGroup(parent, id, cls) { return el('g', Object.assign({ class: cls }, selAttrs(`obj:${id}`)), parent); }

  function drawObjects(svg, g) {
    const layer = el('g', { class: 'objs' }, svg);
    const v0 = run.views[0];
    for (const b of Object.values(g.objs)) {
      if (b.kind === 'slots' || b.kind === 'lockbox') {
        const o = v0.obj[b.id];
        const n = objGroup(layer, b.id, `obj ${o.type}`);
        el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, n);
        el('text', { class: 'lbl', x: b.x + 10, y: b.y + 18 }, n, o.name);
        el('text', { class: 'state s1', x: b.x + b.w / 2, y: b.y + (b.kind === 'slots' ? 45 : 40), 'text-anchor': 'middle' }, n, '');
        g.nodes[b.id] = n;
      } else if (b.kind === 'api') {
        const o = v0.obj.api;
        const n = objGroup(layer, 'api', 'obj api');
        el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, n);
        el('text', { class: 'lbl', x: b.x + 10, y: b.y + 18 }, n, `가짜 API · 상한 ${o.limit}`);
        el('text', { class: 'state s1', x: b.x + b.w / 2, y: b.y + (g.compact ? 42 : 44), 'text-anchor': 'middle' }, n, '');
        el('text', { class: 'lbl s2', x: b.x + b.w / 2, y: b.y + (g.compact ? 61 : 64), 'text-anchor': 'middle' }, n, '');
        if (g.compact) el('text', { class: 'lbl s3', x: b.x + b.w / 2, y: b.y + 77, 'text-anchor': 'middle' }, n, '');
        g.nodes.api = n;
      } else if (b.kind === 'cond') {
        const n = objGroup(layer, 'cond', 'obj cond box-in');
        el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10 }, n);
        el('text', { class: 'lbl', x: b.x + 10, y: b.y + b.h - 8 }, n, 'cond · Condition()');
        el('text', { class: 'lbl', x: b.listX, y: b.y + 22 }, n, '대기 목록');
        el('text', { class: 'wl', x: b.listX, y: b.y + 40 }, n);
        g.nodes.cond = n;
        const lk = objGroup(layer, 'lock', 'obj rlock sub');
        el('rect', { x: b.sub.x, y: b.sub.y, width: b.sub.w, height: b.sub.h, rx: 6 }, lk);
        el('text', { class: 'lbl', x: b.sub.x + 8, y: b.sub.y + 17 }, lk, 'RLock');
        el('text', { class: 'state s1', x: b.sub.x + 8, y: b.sub.y + 35 }, lk, '');
        el('text', { class: 'state s2', x: b.sub.x + 8, y: b.sub.y + 51 }, lk, '');
        g.nodes.lock = lk;
      } else if (b.kind === 'condTwo') {
        const o = v0.obj[b.id];
        const n = objGroup(layer, b.id, 'obj cond');
        el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, n);
        el('text', { class: 'lbl', x: b.x + 8, y: b.y + 17 }, n, o.name);
        el('text', { class: 'lbl', x: b.x + 8, y: b.y + 36 }, n, '대기 목록');
        el('text', { class: 'wl', x: b.x + 8, y: b.y + 53 }, n);
        g.nodes[b.id] = n;
      } else if (b.kind === 'jobs') {
        const n = objGroup(layer, 'jobs', 'obj jobs');
        el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, n);
        const x0 = b.x + (b.w - (b.cap * b.cell + (b.cap - 1) * 3)) / 2;
        for (let k = 0; k < b.cap; k++) {
          const cg = el('g', { class: 'cell', 'data-k': k }, n);
          el('rect', { x: x0 + k * (b.cell + 3), y: b.y + 8, width: b.cell, height: b.cell, rx: 4 }, cg);
          el('text', { x: x0 + k * (b.cell + 3) + b.cell / 2, y: b.y + 8 + b.cell / 2 + 4, 'text-anchor': 'middle' }, cg, '');
        }
        el('text', { class: 'lbl', x: b.x + 8, y: b.y + b.h - 8 }, n, `jobs · 최대 ${b.cap}`);
        g.nodes.jobs = n;
      } else if (b.kind === 'ready') {
        const n = objGroup(layer, 'ready', 'obj flag box-in');
        el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10 }, n);
        el('text', { class: 'code-text', x: b.x + 12, y: b.sub.y + b.sub.h + 21 }, n, '');
        el('text', { class: 'lbl', x: b.x + 10, y: b.y + b.h - 8 }, n, 'ready · Ready()');
        g.nodes.ready = n;
        const ev = objGroup(layer, 'event', 'obj event sub');
        el('rect', { x: b.sub.x, y: b.sub.y, width: b.sub.w, height: b.sub.h, rx: 6 }, ev);
        el('text', { class: 'lbl', x: b.sub.x + 8, y: b.sub.y + 17 }, ev, 'event · Event()');
        el('text', { class: 'state s1', x: b.sub.x + 8, y: b.sub.y + 35 }, ev, '');
        g.nodes.event = ev;
      } else if (b.kind === 'account') {
        const o = v0.obj[b.id];
        const L = v0.obj[o.lock];
        const n = objGroup(layer, b.id, 'obj account box-in');
        el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10 }, n);
        el('text', { class: 'bal', x: b.x + 12, y: b.sub.y + b.sub.h + 21 }, n, '');
        el('text', { class: 'lbl', x: b.x + 10, y: b.y + b.h - 8 }, n, `계좌 ${o.name}`);
        g.nodes[b.id] = n;
        const lk = objGroup(layer, L.id, `obj ${L.type} sub`);
        el('rect', { x: b.sub.x, y: b.sub.y, width: b.sub.w, height: b.sub.h, rx: 6 }, lk);
        el('text', { class: 'lbl', x: b.sub.x + 8, y: b.sub.y + 17 }, lk, L.name);
        el('text', { class: 'state s1', x: b.sub.x + 8, y: b.sub.y + 35 }, lk, '');
        g.nodes[L.id] = lk;
      }
    }
  }

  // ---------- 둥근 식탁 (식사하는 철학자) ----------
  // 철학자 i를 위에서부터 시계 방향으로 72°씩 앉히고, 포크 i를 철학자 i-1과 i 사이 안쪽에 둔다. 웨이터는 식탁 가운데에 둔다.
  // 연결선은 곧은 선으로 상자 중심끼리 잇고 상자 아래에 그린다. 곡선으로 그리면 식탁 둘레에서 선이 상자를 지나간다.

  function layoutTable() {
    const avail = Math.floor($('#boardWrap').clientWidth) || 600;
    const W = Math.max(TABLE_MIN, Math.min(600, avail));
    const compact = W < 440;
    const r = compact ? 16 : 18;
    const g = { W, compact, scroll: W > avail + 1, table: true, r, fs: compact ? 11 : 12, gilOn: false, stack: false };
    g.pw = compact ? 70 : 84;
    g.ph = 2 * r + 46;
    g.fw = compact ? 50 : 56;
    g.fh = 24;
    g.ww = compact ? 76 : 88;
    g.wh = 46;
    const Rx = Math.min(W / 2 - g.pw / 2 - 4, 170);
    const Ry = Rx * 1.1;
    g.cx = W / 2;
    g.cy = 4 + g.ph / 2 + Ry;
    const at = (deg, k) => ({ x: g.cx + Rx * k * Math.cos(deg * Math.PI / 180), y: g.cy + Ry * k * Math.sin(deg * Math.PI / 180) });
    g.seats = threads().map((t) => at(-90 + 72 * t.idx, 1));
    g.forks = [0, 1, 2, 3, 4].map((j) => at(-90 + 72 * j - 36, 0.65));
    g.thBox = g.seats.map((p) => ({ x: p.x - g.pw / 2, y: p.y - g.ph / 2, w: g.pw, h: g.ph }));
    g.thPos = g.seats.map((p) => {
      const cy = p.y - g.ph / 2 + 8 + r;
      return { x: p.x, cy, whyY: cy + r + 17, localY: cy + r + 33 };
    });
    g.H = g.cy + Ry + g.ph / 2 + 6;
    return g;
  }

  function buildTable(svg, g) {
    g.cnG = el('g', { class: 'cns' }, svg);
    const v0 = run.views[0];
    const layer = el('g', { class: 'objs' }, svg);
    g.forks.forEach((p, j) => {
      const n = objGroup(layer, `F${j}`, 'obj lock fork');
      el('rect', { x: p.x - g.fw / 2, y: p.y - g.fh / 2, width: g.fw, height: g.fh, rx: 6 }, n);
      el('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle' }, n, `포크 ${j}`);
      g.nodes[`F${j}`] = n;
    });
    if (v0.obj.waiter) {
      const n = objGroup(layer, 'waiter', 'obj sem waiter');
      el('rect', { x: g.cx - g.ww / 2, y: g.cy - g.wh / 2, width: g.ww, height: g.wh, rx: 8 }, n);
      el('text', { class: 'lbl', x: g.cx, y: g.cy - 5, 'text-anchor': 'middle' }, n, '웨이터');
      el('text', { class: 'state s1', x: g.cx, y: g.cy + 14, 'text-anchor': 'middle' }, n, '');
      g.nodes.waiter = n;
    }
    drawThreadBoxes(svg, g);
    drawThreads(svg, g);
  }

  // ---------- 단계마다 바뀌는 그림 ----------


  function whyText(why) { return scene === 'phil' && why === 'Semaphore 대기' ? '웨이터 대기' : why; }

  function renderThreads(v) {
    const svg = $('#board');
    for (const t of threads()) {
      const s = v.th[t.id];
      const node = svg.querySelector(`.th[data-id="${t.id}"]`);
      setCls(node, `th ${s.cls}`);
      const deadErr = s.cls === 'done' && s.dead;
      // 둥근 식탁의 상자는 이유와 맡은 일이 늘 한 줄에 들어간다(layoutTable).
      const why = s.cls === 'run' || deadErr ? '' : whyText(s.why);
      const [w1, w2] = geo.whyStack ? fitLines(why, geo.fs, 400, geo.fit) : [why, ''];
      node.querySelector('.w1').textContent = w1;
      node.querySelector('.w2').textContent = w2;
      const [l1, l2] = geo.stack ? fitLines(s.local, geo.fs, 400, geo.fit) : [s.local || '', ''];
      node.querySelector('.l1').textContent = l1;
      node.querySelector('.l2').textContent = l2;
      // 이 단계에 난 오류와, 오류로 끝난 스레드의 오류 이름은 주황으로 적는다.
      svg.querySelector(`.err[data-id="${t.id}"]`).textContent = s.err || (deadErr ? s.dead : '');
    }
  }

  // 이 단계의 문제 이벤트가 가리키는 객체
  function badIds(v) { return new Set(v.ev.filter((e) => e.bad).flatMap((e) => e.ids)); }
  function cycleLocks(v) { return new Set((v.cycle || []).map((e) => e.lock)); }

  function lockState(o) {
    if (!o.locked) return ['잠금 해제', ''];
    return o.type === 'rlock' ? [`주인 ${o.holder}`, `수준 ${o.level}`] : ['잠금', ''];
  }

  function renderObjects(v) {
    const prev = idx > 0 ? run.views[idx - 1] : v;
    const bad = badIds(v);
    const cyc = cycleLocks(v);
    for (const [id, n] of Object.entries(geo.nodes)) {
      const o = objOf(id, v);
      const p = objOf(id, prev);
      const flag = (on, c) => (on ? ` ${c}` : '');
      if (o.type === 'lock' || o.type === 'rlock') {
        const [a, b] = lockState(o);
        const sub = n.classList.contains('sub') ? ' sub' : '';
        const fork = scene === 'phil' ? ' fork' : '';
        setCls(n, `obj ${o.type}${sub}${fork}${flag(o.locked, 'held')}${flag(cyc.has(id), 'cycle')}${flag(bad.has(id), 'bad')}`);
        if (scene === 'phil') continue;
        const s1 = n.querySelector('.s1');
        const s2 = n.querySelector('.s2');
        // 두 줄 칸이 없는 상자에는 RLock의 주인과 수준을 한 줄에 적는다.
        s1.textContent = s2 ? a : (b ? `${a} · ${b}` : a);
        if (s2) s2.textContent = b;
      } else if (o.type === 'sem') {
        const over = o.value + o.holders.length > o.init;
        setCls(n, `obj sem${scene === 'phil' ? ' waiter' : ''}${flag(o.holders.length, 'held')}${flag(o.value !== p.value, 'changed')}${flag(over || bad.has(id), 'bad')}`);
        n.querySelector('.s1').textContent = `카운터 ${o.value}`;
      } else if (o.type === 'api') {
        setCls(n, `obj api${flag(o.inflight.length > o.limit || bad.has(id), 'bad')}`);
        n.querySelector('.s1').textContent = `동시 호출 ${o.inflight.length}개`;
        const s3 = n.querySelector('.s3');
        n.querySelector('.s2').textContent = s3 ? `호출 ${o.calls}번` : `호출 ${o.calls}번 · 나중 큐 ${o.queued.length}`;
        if (s3) s3.textContent = `나중 큐 ${o.queued.length}`;
      } else if (o.type === 'cond') {
        setCls(n, `obj cond${n.classList.contains('box-in') ? ' box-in' : ''}${flag(bad.has(id), 'bad')}`);
        const b = geo.objs[id] || geo.objs.cond;
        const width = id === 'cond' && geo.objs.cond ? b.x + b.w - 8 - b.listX : b.w - 16;
        const lines = o.waiters.length ? wrapNames(o.waiters, width, geo.fs) : ['비어 있음'];
        const wl = n.querySelector('.wl');
        wl.innerHTML = '';
        wl.classList.toggle('empty', !o.waiters.length);
        lines.forEach((s, k) => el('tspan', { x: wl.getAttribute('x'), dy: k ? 15 : 0 }, wl, s));
      } else if (o.type === 'jobs') {
        setCls(n, `obj jobs${flag(o.items.join() !== p.items.join(), 'changed')}`);
        n.querySelectorAll('.cell').forEach((c) => {
          const item = o.items[+c.dataset.k];
          c.setAttribute('class', `cell${item != null ? ' full' : ''}`);
          c.querySelector('text').textContent = item != null ? String(item) : '';
        });
      } else if (o.type === 'flag') {
        setCls(n, `obj flag box-in${flag(o.flag !== p.flag, 'changed')}`);
        n.querySelector('.code-text').textContent = `flag = ${o.flag ? 'True' : 'False'}`;
      } else if (o.type === 'event') {
        setCls(n, `obj event sub${flag(o.unused, 'unused')}${flag(o.flag !== p.flag, 'changed')}`);
        n.querySelector('.s1').textContent = o.unused ? `깃발 ${o.flag ? 'True' : 'False'} · wait() 안 씀` : `깃발 ${o.flag ? 'True' : 'False'}`;
      } else if (o.type === 'account') {
        setCls(n, `obj account box-in${flag(o.balance !== p.balance, 'changed')}`);
        n.querySelector('.bal').textContent = `잔액 ${o.balance}`;
      }
    }
  }

  // 단계 끝의 연결: 쥔 락과 얻은 세마포어(held), 기다리는 객체(wait), 호출 중인 API(call). 기다림의 고리에 든 선에는 cycle을 더한다.
  // Lock과 세마포어는 누가 쥐었는지 기억하지 않는다. 쥔 쪽 선은 모형이 따로 적은 값(holder, holders)으로 그린다.
  function linksOf(v) {
    const out = [];
    const cyc = v.cycle || [];
    for (const o of Object.values(v.obj)) {
      if ((o.type === 'lock' || o.type === 'rlock') && o.locked && o.holder) {
        out.push({ from: o.holder, to: o.id, kind: cyc.some((e) => e.lock === o.id && e.to === o.holder) ? 'held cycle' : 'held' });
      } else if (o.type === 'sem') {
        for (const h of o.holders) out.push({ from: h, to: o.id, kind: 'held' });
      } else if (o.type === 'api') {
        for (const h of o.inflight) out.push({ from: h, to: o.id, kind: 'call' });
      }
    }
    for (const [tid, t] of Object.entries(v.th)) {
      if (!t.waitOn) continue;
      out.push({ from: tid, to: t.waitOn, kind: cyc.some((e) => e.lock === t.waitOn && e.from === tid) ? 'wait cycle' : 'wait' });
    }
    return out;
  }

  function renderLinks(v) {
    const g = geo;
    const layer = g.cnG;
    layer.innerHTML = '';
    const links = linksOf(v);
    if (g.table) {
      for (const l of links) {
        const s = g.seats[tIndex(l.from)];
        const e = l.to === 'waiter' ? { x: g.cx, y: g.cy } : g.forks[+l.to.slice(1)];
        el('line', { class: `cn ${l.kind}`, x1: s.x, y1: s.y, x2: e.x, y2: e.y }, layer);
      }
      return;
    }
    const T = threads().length;
    // 끝점: 받는 상자의 위쪽 가장자리에서 스레드 순서대로 자리를 정해 둔다. 단계마다 선 끝이 옮겨 다니지 않게 하려는 것이다.
    const ends = links.map((l) => {
      const a = g.anchor[l.to];
      const k = tIndex(l.from);
      const step = T > 1 ? Math.min(14, (a.w - 16) / (T - 1)) : 0;
      return { l, x: a.x + a.w / 2 + (k - (T - 1) / 2) * step, y: a.y };
    });
    // 시작점: 스레드 상자 아래 가장자리. 선이 둘이면 끝점 순서대로 조금씩 떼어 놓는다.
    const byFrom = {};
    for (const e of ends) (byFrom[e.l.from] = byFrom[e.l.from] || []).push(e);
    for (const [tid, list] of Object.entries(byFrom)) {
      list.sort((a, b) => a.x - b.x);
      const p = g.thPos[tIndex(tid)];
      list.forEach((e, j) => {
        const sx = p.x + (j - (list.length - 1) / 2) * 12;
        el('path', { class: `cn ${e.l.kind}`, d: curve(sx, g.thB, e.x, e.y) }, layer);
      });
    }
  }

  function renderGil(v, animate) {
    if (!geo.gilOn) return;
    const tag = $('#board .gil');
    const holder = v.gil.after;
    setCls(tag, `gil${holder ? '' : ' free'}`);
    const k = holder ? tIndex(holder) : -1;
    setPos(tag, k < 0 ? geo.home : { x: geo.thPos[k].x, y: geo.thPos[k].gilY }, !animate);
  }

  // ---------- 전체 지도 ----------
  // 모든 요소를 담는 관계(프로세스 ⊃ 인터프리터 ⊃ GIL·OS 스레드·동기화 도구·공유 자료)만 그린다.
  // 단계와 상관없이 그대로이고, 장면과 구성을 바꾸면 그 구성이 쓰는 부분만 진하게 바꾼다.

  const MAP_TOOLS = [['lock', 'Lock'], ['rlock', 'RLock'], ['sem', 'Semaphore'], ['bsem', 'BoundedSemaphore'], ['cond', 'Condition'], ['event', 'Event']];
  const MAP_DATA = [['jobs', 'jobs'], ['account', '계좌'], ['flag', 'ready.flag'], ['api', '가짜 API']];
  const PART_NAMES = { gil: 'GIL', th: 'OS 스레드', lock: 'Lock', rlock: 'RLock', sem: 'Semaphore', bsem: 'BoundedSemaphore',
    cond: 'Condition', event: 'Event', jobs: 'jobs', account: '계좌', flag: 'ready.flag', api: '가짜 API' };

  function buildMap() {
    const avail = Math.floor($('#mapWrap').clientWidth) || 460;
    const W = Math.max(260, Math.min(460, avail));
    const mi = W < 400 ? 12 : 18;
    const svg = $('#map');
    svg.innerHTML = '';
    const part = (name) => el('g', { class: 'part', 'data-part': name }, svg);
    const procY = 4;
    const interpY = 18;
    const rowY = 44;
    const gil = part('gil');
    el('rect', { x: mi + 10, y: rowY - 9, width: 36, height: 18, rx: 5 }, gil);
    el('text', { x: mi + 28, y: rowY + 4, 'text-anchor': 'middle' }, gil, 'GIL');
    const th = part('th');
    const x0 = mi + 70;
    for (let i = 0; i < 3; i++) el('circle', { cx: x0 + i * 28, cy: rowY, r: 10 }, th);
    el('text', { class: 'lbl', x: x0 + 2 * 28 + 18, y: rowY + 4 }, svg, 'OS 스레드');
    // 상자는 줄 끝에 닿으면 다음 줄로 넘긴다.
    const left = mi + 10;
    const right = W - mi - 10;
    let y = rowY + 26;
    const flow = (items, label) => {
      el('text', { class: 'lbl', x: left, y: y + 4 }, svg, label);
      y += 10;
      let x = left;
      for (const [name, text] of items) {
        const w = Math.ceil(tw(text, 11)) + 14;
        if (x > left && x + w > right) { x = left; y += 28; }
        const o = part(name);
        el('rect', { x, y, width: w, height: 22, rx: 5 }, o);
        el('text', { x: x + w / 2, y: y + 15, 'text-anchor': 'middle' }, o, text);
        x += w + 8;
      }
      y += 22 + 16;
    };
    flow(MAP_TOOLS, '동기화 도구');
    flow(MAP_DATA, '공유 자료');
    const interpB = y + 4;
    const procB = interpB + 18;
    el('rect', { class: 'box', x: 4, y: procY, width: W - 8, height: procB - procY, rx: 10 }, svg).parentNode.insertBefore(svg.lastChild, svg.firstChild);
    el('rect', { class: 'box', x: mi, y: interpY, width: W - 2 * mi, height: interpB - interpY, rx: 8 }, svg).parentNode.insertBefore(svg.lastChild, svg.firstChild.nextSibling);
    el('text', { class: 'lbl', x: 14, y: procB - 6 }, svg, '프로세스');
    el('text', { class: 'lbl', x: mi + 10, y: interpB - 6 }, svg, '인터프리터');
    svg.setAttribute('viewBox', `0 0 ${W} ${procB + 4}`);
    svg.style.maxWidth = `${W}px`;
  }

  // 이 구성이 쓰는 지도 부분. 장면에 그린 요소와 같다.
  function partsFor() {
    switch (scene) {
      case 'release': return ['th', { semaphore: 'sem', bounded: 'bsem', lock: 'lock', rlock: 'rlock' }[cfg.tool], 'api'];
      case 'buffer': return ['th', 'cond', 'rlock', 'jobs'];
      case 'onecond': return ['th', 'cond', cfg.fix === 'two' ? 'lock' : 'rlock', 'jobs'];
      case 'wait': return ['gil', 'th', 'event', 'flag'];
      case 'transfer': return ['gil', 'th', cfg.lock === 'rlock' ? 'rlock' : 'lock', 'account'];
      default: return ['th', 'lock'].concat(cfg.pick === 'waiter' ? ['sem'] : []);
    }
  }

  function renderMap() {
    const on = new Set(partsFor());
    $('#map').querySelectorAll('.part').forEach((p) => p.classList.toggle('on', on.has(p.dataset.part)));
    const used = [...on].map((p) => PART_NAMES[p]);
    $('#map').setAttribute('aria-label', '전체 지도. 프로세스 안에 인터프리터가 있고, 인터프리터 안에 GIL, OS 스레드, '
      + '동기화 도구(Lock, RLock, Semaphore, BoundedSemaphore, Condition, Event), 공유 자료가 있다. '
      + `이 구성에 나오는 부분: ${used.join(', ')}.`);
  }

  function renderCounts() {
    const v0 = run.views[0];
    const T = threads().length;
    const items = [];
    if (scene === 'release') {
      items.push(['OS 스레드', `${T}개`], ['요청', '4개'], ['상한 도구', v0.obj.slots.name], ['가짜 API 상한', `${v0.obj.api.limit}`]);
    } else if (scene === 'buffer') {
      items.push(['OS 스레드', `${T}개 (업로드 1, 작업자 ${cfg.workers})`], ['조건 변수', '1개'], ['RLock', '1개 (조건 변수 안)'], ['jobs 크기', '5'], ['업로드', '3번']);
    } else if (scene === 'onecond') {
      items.push(['OS 스레드', '3개 (업로드 1, 작업자 2)'], ['조건 변수', twoConds() ? '2개' : '1개'],
        twoConds() ? ['Lock', '1개 (둘이 함께 씀)'] : ['RLock', '1개 (조건 변수 안)'], ['jobs 크기', '1'], ['넣는 작업', '2개']);
    } else if (scene === 'wait') {
      items.push(['OS 스레드', `${T}개 (로더 1, 요청 처리 ${cfg.waiters})`], ['GIL', '1개'], ['Event', eventUnused() ? '1개 (기다림에 안 씀)' : '1개']);
    } else if (scene === 'transfer') {
      const n = cfg.accounts === 'self' ? 1 : 2;
      items.push(['OS 스레드', `${T}개`], ['계좌', `${n}개`], [cfg.lock === 'rlock' ? 'RLock' : 'Lock', `${n}개 (계좌마다)`], ['스레드마다 이체', `${cfg.per}번`], ['GIL', '1개']);
    } else {
      items.push(['OS 스레드', '5개 (철학자)'], ['포크 (Lock)', '5개'], ['웨이터 Semaphore(4)', cfg.pick === 'waiter' ? '1개' : '없음'], ['끼니', `${cfg.meals}번씩`]);
    }
    $('#counts').innerHTML = items.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('');
  }

  // ---------- 화면 낭독기용 요약 ----------

  function objSummary(v) {
    const o = v.obj;
    const names = (ids) => (ids.length ? ids.join(', ') : '없음');
    const lockText = (L) => `${L.name} ${lockState(L).filter(Boolean).join(' ')}`;
    if (scene === 'release') {
      const s = o.slots;
      const slot = s.type === 'sem' ? `${s.name} 카운터 ${s.value}` : lockText(s);
      return `${slot}. 가짜 API 동시 호출 ${o.api.inflight.length}개(상한 ${o.api.limit}).`;
    }
    if (scene === 'buffer' || scene === 'onecond') {
      const conds = Object.values(o).filter((x) => x.type === 'cond').map((c) => `${c.name} 대기 목록 ${names(c.waiters)}`);
      return `${lockText(o.lock)}. ${conds.join('. ')}. jobs ${o.jobs.items.length ? o.jobs.items.join(', ') : '비어 있음'}.`;
    }
    if (scene === 'wait') {
      const ev = objOf('event', v);
      return `ready.flag ${o.ready.flag ? 'True' : 'False'}. Event 깃발 ${ev.flag ? 'True' : 'False'}${ev.unused ? '' : `, 블록된 스레드 ${names(ev.waiters)}`}.`;
    }
    if (scene === 'transfer') {
      return Object.values(o).filter((x) => x.type === 'account').map((a) => `계좌 ${a.name} 잔액 ${a.balance}, ${lockText(o[a.lock])}${o[a.lock].locked && o[a.lock].type === 'lock' ? `(${josa(o[a.lock].holder, ['이', '가'])} 잡음)` : ''}`).join('. ') + '.';
    }
    const forks = [0, 1, 2, 3, 4].map((j) => o[`F${j}`]).filter((f) => f.locked).map((f) => `${f.name} ${f.holder}`);
    return `쥔 포크: ${forks.length ? forks.join(', ') : '없음'}.${o.waiter ? ` 웨이터 카운터 ${o.waiter.value}.` : ''}`;
  }

  function describe(v) {
    const parts = [`단계 ${v.step}.`];
    if (v.actor) parts.push(`실행: ${threadTitle(thread(v.actor))}.`);
    const rest = threads().filter((t) => t.id !== v.actor).map((t) => `${t.name} ${stateText(v.th[t.id])}`);
    if (rest.length) parts.push(`${rest.join(', ')}.`);
    parts.push(`단계 끝: ${objSummary(v)}`);
    if (v.gil) parts.push(v.gil.after ? `GIL은 ${v.gil.after}.` : 'GIL은 비어 있음.');
    return parts.join(' ');
  }

  // ---------- 설명 한 문장 ----------

  function mainEvent(v) {
    for (const type of BAD_ORDER) {
      const e = v.ev.find((x) => x.type === type && x.bad);
      if (e) return e;
    }
    for (const type of PRIORITY) {
      const e = v.ev.find((x) => x.type === type);
      if (e) return e;
    }
    return v.ev[0] || null;
  }

  // 마지막 단계에 붙이는 결과. 단계 번호는 기다리는 방법에서 같은 장면의 구성끼리 순서를 견줄 때만 적고, 실측 시간과 견주지 않는다.
  function resultText() {
    const r = run.result;
    const out = run.outcome;
    if (scene === 'release') {
      const errs = r.errors.map((e) => `${e.thread}의 요청 ${e.req}에서 ${e.type}${e.timeout ? '(타임아웃 난 호출)' : ''}`);
      const fin = typeof r.final === 'number' ? `카운터 ${r.final}` : r.final;
      return { bad: r.max > r.limit || r.errors.length > 0,
        text: `결과: 동시 호출 최대 ${r.max}개(상한 ${r.limit}). 오류 ${r.errors.length}번${errs.length ? `: ${errs.join(', ')}` : ''}. 끝난 뒤 ${fin}.` };
    }
    if (scene === 'buffer') {
      return { bad: r.aliveAfter.some((n) => n < r.workers),
        text: `결과: 업로드 1·2·3번째 뒤 남은 작업자 ${r.aliveAfter.join('·')}개(처음 ${r.workers}개). IndexError ${r.indexErrors}번, 빈 jobs에서 깨어남 ${r.emptyWakeups}번.` };
    }
    if (scene === 'onecond') {
      if (out === 'finished') return { bad: false, text: `결과: 작업 ${r.done.join(', ')}를 모두 처리했다. 빈 jobs에서 깨어남 ${r.emptyWakeups}번.` };
      return { bad: true, text: `결과: 작업 ${r.done.length}개(${r.done.join(', ') || '없음'})만 처리하고 멈췄다. 빈 jobs에서 깨어남 ${r.emptyWakeups}번.` };
    }
    if (scene === 'wait') {
      return { bad: r.waiterSteps > 0,
        text: `결과: 로더가 단계 ${r.loadStart}에 계산을 시작해 단계 ${r.loadedAt}에 set()을 불렀다. 그 사이 요청 처리 스레드가 실행한 단계 ${r.waiterSteps}개. 마지막 요청 처리 스레드는 단계 ${r.lastWake}에 기다림을 빠져나왔다.` };
    }
    if (scene === 'transfer') {
      const done = Object.entries(r.done).map(([id, n]) => `${id} ${n}번`).join(', ');
      const bal = Object.entries(r.balances).map(([n, b]) => `${n} ${b}`).join(', ');
      if (out === 'finished') return { bad: false, text: `결과: 이체를 모두 마쳤다(${done}). 다시 시도 ${r.retries}번. 잔액 ${bal}.` };
      if (out === 'spin') return { bad: true, text: `결과: 마친 이체 ${done}. 잡을 수 없는 락을 두고 다시 시도를 끝없이 되풀이한다.` };
      return { bad: true, text: `결과: 마친 이체 ${done}. 기다리기만 하는 채로 멈췄다.` };
    }
    if (out === 'finished') return { bad: false, text: `결과: 다섯 명이 모두 ${r.meals}번씩 먹었다.` };
    return { bad: true, text: `결과: 먹은 횟수 ${r.eaten.join('·')}. 기다리기만 하는 채로 멈췄다.` };
  }

  function renderCaption(v) {
    const main = mainEvent(v);
    const rest = v.ev.filter((e) => e !== main && e.type !== 'end');
    const text = main ? main.text : '';
    let html = `<span${main && main.bad ? ' class="bad"' : ''}>${esc(text)}</span>`;
    if (idx === lastIdx() && run.outcome !== 'limit') {
      const r = resultText();
      html += `<span class="result${r.bad ? ' bad' : ''}">${esc(r.text)}</span>`;
    }
    $('#caption').innerHTML = html;
    const more = $('#more');
    more.hidden = rest.length === 0;
    more.querySelector('summary').textContent = `이 단계의 다른 일 ${rest.length}개`;
    more.querySelector('ul').innerHTML = rest.map((e) => `<li>${esc(e.text)}</li>`).join('');
    $('#live').textContent = `단계 ${v.step}. ${text}`;
  }

  // ---------- 코드 ----------
  // 줄마다 그 줄을 가리키는 이름표 키(on)를 둔다. 키는 model.js가 스레드마다 적는 줄 이름이다.
  // 실험 코드는 content.js의 CODE와 같게 둔다. 실험 코드에 없는 줄은 note에 덧붙였다고 적는다.

  function L(t, on) { return { t, on: on || [] }; }

  // content.js의 코드 한 덩어리를 줄로 나누고, 줄 글자가 같은 곳에 키 목록을 붙인다.
  // 같은 글자의 줄이 여럿이면 [[첫 줄의 키], [둘째 줄의 키]]처럼 나오는 차례대로 준다.
  function fromCode(text, marks) {
    const seen = {};
    return text.split('\n').map((t) => {
      const k = t.trim();
      const m = marks[k];
      if (!m) return L(t);
      if (!Array.isArray(m[0])) return L(t, m);
      const n = seen[k] || 0;
      seen[k] = n + 1;
      return L(t, m[n] || []);
    });
  }
  const BLANK = '\n\n';

  function releaseCode() {
    const buggy = cfg.code === 'buggy';
    const fn = buggy
      ? fromCode(RC.CODE.releaseBuggy, { 'slots.acquire()': ['acq'], 'return api.send(req)': ['send'], 'except TimeoutError:': ['except'],
        'slots.release()': [['relExcept'], ['fin']], 'return api.send_later(req)': ['later'], 'finally:': ['fin'] })
      : fromCode(RC.CODE.releaseFixed, { 'with slots:': ['acq'], 'return api.send(req)': ['send'], 'except TimeoutError:': ['except'],
        'return api.send_later(req)': ['later'] }).concat([L('    # with 블록을 나가며 release()를 부른다', ['exit'])]);
    const handle = fromCode(RC.CODE.handle, { 'def handle(req: int) -> dict:': ['h.def'],
      'return {"req": req, "result": call_api(slots, api, req), "error": None}': ['h.call'], 'except Exception as exc:': ['h.except'],
      'return {"req": req, "result": None, "error": f"{type(exc).__name__}: {exc}"}': ['h.except'] });
    const name = buggy ? 'call_api_buggy' : 'call_api_candidate';
    const note = `실험 코드(release_kernels.py의 ${name}, release_lab.py의 handle)에서 옮겼다. handle()의 call_api는 ${name}()다. 실행 틀의 기록 줄은 뺐다.`
      + (buggy ? '' : ` ${fn.length}번 줄 주석은 with 블록을 나가며 release()를 부르는 지점을 보이려고 덧붙였다.`);
    return { sig: `release-${cfg.code}`, note, lines: fn.concat([L('')], handle) };
  }

  const PUT_MARKS = { 'while len(buf.jobs) >= CAPACITY:': ['p.check'], 'buf.jobs.append(job)': ['p.append'] };
  const TAKE_MARKS = { 'if not buf.jobs:': ['t.check'], 'while not buf.jobs:': ['t.check'], 'job = buf.jobs.popleft()': ['t.pop'], 'return job': ['t.ret'] };
  const WORK_MARKS = { 'def work() -> None:': ['w.def'], 'while True:': ['w.loop'], 'job = take(buf)': ['w.take'], 'job = take()': ['w.take'],
    'if job is STOP:': ['w.stop'], 'sleep(job_s)': ['w.sleep'] };
  const EXIT_COMMENT = '    # with 블록을 나가며 락을 놓는다';

  function bufferCode() {
    const take = scene === 'buffer' && cfg.take === 'if' ? RC.CODE.takeIf : RC.CODE.takeWhile;
    const head = scene === 'onecond' ? `CAPACITY = 1${BLANK}` : '';
    const tail = scene === 'onecond' ? 'put(buf, 1)\nput(buf, 2)' : RC.CODE.uploads;
    const text = `${head}${RC.CODE.put}\n${EXIT_COMMENT}${BLANK}${take}${BLANK}${RC.CODE.work}${BLANK}${tail}`;
    const lines = fromCode(text, Object.assign({
      'with buf.cond:': [['p.with'], ['t.with']], 'buf.cond.wait()': [['p.wait'], ['t.wait']], 'buf.wake()': [['p.wake'], ['t.wake']],
      [EXIT_COMMENT.trim()]: ['p.exit'], 'alive_at_start = settle(0)': ['m.settle0'], 'for job in range(1, uploads + 1):': ['m.for'],
      'put(buf, job)': ['m.put'], 'alive_after_uploads.append(settle(job))': ['m.settle'], 'put(buf, 1)': ['u.put1'], 'put(buf, 2)': ['u.put2'],
    }, PUT_MARKS, TAKE_MARKS, WORK_MARKS));
    const at = lines.findIndex((ln) => ln.t === EXIT_COMMENT) + 1;
    const wakeWord = scene === 'buffer' ? cfg.wake : cfg.fix === 'all' ? 'notify_all' : 'notify';
    const note = scene === 'buffer'
      ? `실험 코드(buffer_kernels.py의 put과 take_${cfg.take}, buffer_lab.py의 work와 업로드 부분)에서 옮겼다. buf.wake()는 cond.${wakeWord}()다. 작업자의 take는 take_${cfg.take}()다. 실행 틀의 기록 줄은 뺐다. ${at}번 줄 주석은 with 블록을 나가며 락을 놓는 지점을 보이려고 덧붙였다.`
      : `실험 코드(buffer_kernels.py의 put과 take_while, buffer_lab.py의 work)에서 CAPACITY만 1로 바꿨다(변형 문제 1). buf.wake()는 cond.${wakeWord}()다. 마지막 두 줄은 P가 하는 일을 보이려고 쓴 설명용 코드다. ${at}번 줄 주석은 덧붙였다.`;
    return { sig: `${scene}-${scene === 'buffer' ? cfg.take : cfg.fix}`, note, lines };
  }

  function twoCode() {
    const work = RC.CODE.work.replace('job = take(buf)', 'job = take()');
    const two = RC.CODE.two.replace(/(\n {8}not_empty\.notify\(\))\n/, `$1\n${EXIT_COMMENT}\n`);
    const text = `${two}${BLANK}${work}${BLANK}put(1)\nput(2)`;
    const lines = fromCode(text, Object.assign({
      'with not_full:': ['p.with'], 'while len(jobs) >= CAPACITY:': ['p.check'], 'not_full.wait()': ['p.wait'], 'jobs.append(job)': ['p.append'],
      'not_empty.notify()': ['p.wake'], [EXIT_COMMENT.trim()]: ['p.exit'], 'with not_empty:': ['t.with'], 'while not jobs:': ['t.check'],
      'not_empty.wait()': ['t.wait'], 'job = jobs.popleft()': ['t.pop'], 'not_full.notify()': ['t.wake'], 'return job': ['t.ret'],
      'put(1)': ['u.put1'], 'put(2)': ['u.put2'],
    }, WORK_MARKS));
    const at = lines.findIndex((ln) => ln.t === EXIT_COMMENT) + 1;
    return { sig: 'onecond-two', lines,
      note: `README의 고친 모양(에이전트 작성)에서 버퍼 크기를 CAPACITY = 1로 바꾸고, 실험의 work()와 P가 하는 일을 붙였다. 실험에서 실행하지 않은 설명용 코드다. ${at}번 줄 주석은 덧붙였다.` };
  }

  function waitCode() {
    const fn = { pass: RC.CODE.waitPass, sleep: RC.CODE.waitSleep, event: RC.CODE.waitEvent }[cfg.how];
    const text = `${RC.CODE.ready}${BLANK}${fn}${BLANK}${RC.CODE.load}${BLANK}${RC.CODE.serve}`;
    const lines = fromCode(text, {
      'self.flag = True': ['r.flag'], 'self.event.set()': ['r.event'], 'pass': ['w.body'], 'time.sleep(POLL_S)': ['w.sleep'],
      'ready.event.wait()': ['w.event'], 'def load() -> None:': ['l.def'], 'value = build_index(n)': ['l.loop'], 'ready.set()': ['l.set'],
      'def serve() -> None:': ['v.def'], 'wait(ready)': ['v.call'],
      'while not ready.flag:': [cfg.how === 'pass' ? 'w.pass' : 'w.check'],
    });
    const name = { pass: 'wait_pass', sleep: 'wait_sleep', event: 'wait_event' }[cfg.how];
    return { sig: `wait-${cfg.how}`, lines,
      note: `실험 코드(wait_kernels.py의 Ready와 ${name}, wait_lab.py의 load와 serve)에서 옮겼다. serve()의 wait는 ${name}()다. 실행 틀의 시간 기록 줄은 뺐다.` };
  }

  function transferCode() {
    const fn = RC.CODE[cfg.how];
    const exit = { opposite: '    # 두 with 블록을 나가며 dst.lock, src.lock 순서로 놓는다', ordered: '    # 두 with 블록을 나가며 second.lock, first.lock 순서로 놓는다' }[cfg.how];
    const body = exit ? fn.replace(/\n {4}return 0$/, `\n${exit}\n    return 0`) : fn;
    const account = cfg.lock === 'rlock' ? RC.CODE.account.replace('threading.Lock()', 'threading.RLock()') : RC.CODE.account;
    const check = cfg.check === 'db' ? RC.CODE.checkDb : RC.CODE.checkMemory;
    const text = `${account}${BLANK}${check}${BLANK}${body}${BLANK}${RC.CODE.move}`;
    const marks = {
      'time.sleep(DB_S)': ['c.sleep'], 'if amount > DAILY_LIMIT:': ['c.if'],
      'src.balance -= amount': [cfg.how === 'opposite' ? 'o.move' : cfg.how === 'ordered' ? 'r.move' : 'y.move'],
      'dst.balance += amount': [cfg.how === 'opposite' ? 'o.move' : cfg.how === 'ordered' ? 'r.move' : 'y.move'],
      'def move(name: str, src: Account, dst: Account) -> None:': ['m.def'], 'for _ in range(per_thread):': ['m.for'],
      'retries[name] += transfer(src, dst, 1, check)': ['m.call'], 'done[name] += 1': ['m.done'],
    };
    if (cfg.how === 'opposite') {
      Object.assign(marks, { 'with src.lock:': ['o.src'], 'check_limit(src, amount)': ['o.check'], 'with dst.lock:': ['o.dst'], [exit.trim()]: ['o.exit'] });
    } else if (cfg.how === 'ordered') {
      Object.assign(marks, { 'first, second = sorted((src, dst), key=lambda acc: acc.name)': ['r.sort'], 'with first.lock:': ['r.first'],
        'with second.lock:': ['r.second'], 'check_limit(src, amount)': ['r.check'], [exit.trim()]: ['r.exit'] });
    } else {
      Object.assign(marks, { 'retries = 0': ['y.init'], 'while True:': ['y.loop'], 'src.lock.acquire()': ['y.src'],
        'if dst.lock.acquire(blocking=False):': ['y.try'], 'break': ['y.break'], 'src.lock.release()': [['y.rel'], ['y.exit2']],
        'retries += 1': ['y.count'], 'time.sleep(random.uniform(0, BACKOFF_S))': ['y.sleep'], 'try:': ['y.check'],
        'check_limit(src, amount)': ['y.check'], 'finally:': ['y.exit'], 'dst.lock.release()': ['y.exit'] });
    }
    const lines = fromCode(text, marks);
    const extra = exit ? ` ${lines.findIndex((ln) => ln.t === exit) + 1}번 줄 주석은 with 블록을 나가며 락을 놓는 지점을 보이려고 덧붙였다.` : '';
    const lockNote = cfg.lock === 'rlock' ? ' RLock 구성은 Account의 락 줄만 threading.RLock()으로 바꾼 것이다.' : '';
    const selfNote = cfg.accounts === 'self' ? ' 자기 계좌 이체는 move()에 같은 계좌를 src와 dst로 넘긴다(변형 문제 2).' : '';
    return { sig: `transfer-${cfg.how}-${cfg.check}-${cfg.lock}`, lines,
      note: `실험 코드(deadlock_kernels.py, deadlock_lab.py의 move)에서 옮겼다. move()의 transfer와 check는 고른 이체 함수와 한도 확인 함수다. 실행 틀의 오류 기록 줄은 뺐다.${extra}${lockNote}${selfNote}` };
  }

  function philCode() {
    const pick = cfg.pick === 'larger' ? RC.CODE.pickLarger : RC.CODE.pickLeft;
    const exit = '            # 두 with 블록을 나가며 둘째 포크, 첫 포크 순서로 놓는다';
    const body = RC.CODE.philosopher.replace(/(\n {20}time\.sleep\(EAT_S\) {12}# 먹는다)\n/, `$1\n${exit}\n`);
    const lines = fromCode(`${pick}${BLANK}${body}`, {
      'indices = [i, (i + 1) % len(forks)]': ['k.idx'], 'return forks[i], forks[(i + 1) % len(forks)]': ['k.ret'],
      'return forks[max(indices)], forks[min(indices)]': ['k.ret'],
      'def philosopher(forks: list, i: int, pick, meals: int, eaten: list[int], waiter=None) -> None:': ['f.def'],
      'first, second = pick(forks, i)': ['f.pick'], 'for _ in range(meals):': ['f.for'],
      'time.sleep(random.uniform(0, THINK_S))   # 생각한다': ['f.think'], 'if waiter is not None:': [['f.ifw'], ['f.ifw2']],
      'waiter.acquire()': ['f.wacq'], 'with first:                          # 첫 포크를 집는다': ['f.first'],
      'time.sleep(PICK_S)               # 포크를 집는 데 1ms': ['f.pick1'], 'with second:                     # 둘째 포크를 집는다': ['f.second'],
      'time.sleep(EAT_S)            # 먹는다': ['f.eat'], [exit.trim()]: ['f.exit'], 'finally:': ['f.ifw2'], 'waiter.release()': ['f.wrel'],
      'eaten[i] += 1': ['f.eaten'],
    });
    const at = lines.findIndex((ln) => ln.t === exit) + 1;
    const name = cfg.pick === 'larger' ? 'pick_larger_first' : 'pick_left_first';
    return { sig: `phil-${cfg.pick}`, lines,
      note: `실험 코드(deadlock_kernels.py의 ${name}와 philosopher)에서 옮겼다. philosopher()의 pick은 ${name}()다.${cfg.pick === 'waiter' ? ' 웨이터 구성은 waiter에 Semaphore(4)를 넘긴다.' : ' 이 구성은 waiter를 넘기지 않는다(None).'} ${at}번 줄 주석은 with 블록을 나가며 포크를 놓는 지점을 보이려고 덧붙였다. 생각 시간은 무작위 대신 구성에서 고른 고정 단계 수로 줄였다.` };
  }

  function codeFor() {
    if (scene === 'release') return releaseCode();
    if (scene === 'buffer' || (scene === 'onecond' && !twoConds())) return bufferCode();
    if (scene === 'onecond') return twoCode();
    if (scene === 'wait') return waitCode();
    if (scene === 'transfer') return transferCode();
    return philCode();
  }

  // 키가 붙은 줄. 실행한 줄은 그 키의 마지막 줄(예: finally:와 release()에 같은 키를 붙이면 release() 줄),
  // 다음에 실행할 줄은 그 키의 첫 줄에 이름표를 단다.
  function linesOfKey(key) { return code.lines.map((ln, i) => (ln.on.includes(key) ? i : -1)).filter((i) => i >= 0); }
  function lastLine(key) { const ls = linesOfKey(key); return ls.length ? ls[ls.length - 1] : -1; }
  function firstLine(key) { const ls = linesOfKey(key); return ls.length ? ls[0] : -1; }

  // 코드 줄에 붙일 이름표: 실행한 스레드는 이 단계에 실행한 마지막 줄에 채운 이름표를, 나머지는 다음에 실행할 줄(at)에 상태 이름표를 단다.
  function chipsFor(v) {
    const out = [];
    for (const t of threads()) {
      const s = v.th[t.id];
      if (s.cls === 'done') continue;
      if (s.cls === 'run') {
        const key = s.lines[s.lines.length - 1];
        out.push({ line: lastLine(key), label: t.name, cls: `run${s.err ? ' bad' : ''}`, ran: true, tip: `${threadTitle(t)} · 이 단계에 실행함${s.err ? ` · ${s.err}` : ''}` });
      } else {
        out.push({ line: firstLine(s.at), label: t.name, cls: s.cls, ran: false, tip: `${threadTitle(t)} · ${stateText(s)} · 다음에 실행할 줄` });
      }
    }
    return out;
  }

  function renderCode(v) {
    const ol = $('#code');
    const sig = `${scene}|${codeFor().sig}`;
    if (codeSig !== sig) {
      codeSig = sig;
      code = codeFor();
      ol.innerHTML = code.lines.map((ln, i) => `<li data-line="${i}"><span class="marks"></span><span class="ln">${i + 1}</span><code>${esc(ln.t) || ' '}</code></li>`).join('');
      $('#codeNote').textContent = code.note;
    }
    const ran = new Set();
    const actor = v.actor ? v.th[v.actor] : null;
    if (actor) for (const k of actor.lines) linesOfKey(k).forEach((i) => ran.add(i));
    const byLine = new Map();
    for (const c of chipsFor(v)) {
      if (c.line < 0) continue;
      if (!byLine.has(c.line)) byLine.set(c.line, []);
      byLine.get(c.line).push(c);
    }
    ol.querySelectorAll('li').forEach((li) => {
      const i = +li.dataset.line;
      li.classList.toggle('ran', ran.has(i));
      let as = (byLine.get(i) || []).slice().sort((x, y) => (y.ran ? 1 : 0) - (x.ran ? 1 : 0));
      // 한 줄에 이름표는 둘까지만 둔다. 실행한 스레드를 먼저 두고 나머지는 수로 적는다.
      let more = null;
      if (as.length > 2) { more = as.slice(1); as = as.slice(0, 1); }
      li.querySelector('.marks').innerHTML = as.map((a) => `<span class="chip ${a.cls}" title="${esc(a.tip)}">${esc(a.label)}</span>`).join('')
        + (more ? `<span class="chip more" title="${esc(more.map((a) => a.tip).join(' / '))}">+${more.length}</span>` : '');
    });
  }

  // ---------- 단계 띠 ----------

  function stripCell(k, cls, mark, tip) {
    return `<button type="button" tabindex="-1" class="c ${cls}" data-step="${k}" title="${esc(tip)}">${esc(mark)}</button>`;
  }

  function stepMark(v, id) {
    const mine = v.ev.filter((e) => e.ids[0] === id);
    for (const [mark, types] of MARKS) if (mine.some((e) => types.includes(e.type))) return mark;
    return '';
  }

  // 장면마다 값 줄: 그 단계가 끝난 뒤의 값이다(관계도의 상자와 같은 시점).
  function valueRows() {
    const rows = [];
    const V = run.views;
    const row = (label, fn) => {
      const cells = [];
      for (let k = 1; k < V.length; k++) cells.push(fn(V[k], V[k - 1], k));
      rows.push({ label, cells });
    };
    if (scene === 'release') {
      row('동시 호출', (v, p, k) => {
        const n = v.obj.api.inflight.length;
        return { text: String(n), cls: `val${n !== p.obj.api.inflight.length ? ' changed' : ''}${n > v.obj.api.limit ? ' bad' : ''}`, tip: `단계 ${k} 뒤 동시 호출 ${n}개(상한 ${v.obj.api.limit})` };
      });
      const s0 = V[0].obj.slots;
      if (s0.type === 'sem') {
        row('카운터', (v, p, k) => {
          const s = v.obj.slots;
          const over = s.value + s.holders.length > s.init;
          return { text: String(s.value), cls: `val${s.value !== p.obj.slots.value ? ' changed' : ''}${over ? ' bad' : ''}`,
            tip: `단계 ${k} 뒤 ${s.name}의 카운터 ${s.value}${over ? '. 카운터와 반납하지 않은 수의 합이 초깃값보다 크다' : ''}` };
        });
      } else {
        row(s0.name, (v, p, k) => {
          const s = v.obj.slots;
          return { text: s.locked ? '잠' : '', cls: `val${s.locked !== p.obj.slots.locked ? ' changed' : ''}`, tip: `단계 ${k} 뒤 ${s.name} ${lockState(s).filter(Boolean).join(' ')}` };
        });
      }
    } else if (scene === 'buffer' || scene === 'onecond') {
      row('jobs', (v, p, k) => {
        const n = v.obj.jobs.items.length;
        return { text: String(n), cls: `val${n !== p.obj.jobs.items.length ? ' changed' : ''}`, tip: `단계 ${k} 뒤 jobs의 작업 ${n}개` };
      });
      if (scene === 'buffer') {
        const alive = (v) => threads().filter((t) => t.role === 'worker' && !(v.th[t.id].cls === 'done' || (v.th[t.id].after && v.th[t.id].after.cls === 'done'))).length;
        row('작업자', (v, p, k) => {
          const n = alive(v);
          return { text: String(n), cls: `val${n !== alive(p) ? ' changed' : ''}${n < cfg.workers ? ' bad' : ''}`, tip: `단계 ${k} 뒤 남은 작업자 ${n}개(처음 ${cfg.workers}개)` };
        });
      }
    } else if (scene === 'wait' || scene === 'transfer') {
      row('GIL', (v, p, k) => {
        const h = v.gil.after;
        return { text: h || '', cls: `val${h !== p.gil.after ? ' changed' : ''}`, tip: `단계 ${k} 뒤 GIL: ${h ? `${josa(h, ['이', '가'])} 쥠` : '비어 있음'}` };
      });
      if (scene === 'wait') {
        row('flag', (v, p, k) => ({ text: v.obj.ready.flag ? 'T' : 'F', cls: `val${v.obj.ready.flag !== p.obj.ready.flag ? ' changed' : ''}`, tip: `단계 ${k} 뒤 ready.flag = ${v.obj.ready.flag ? 'True' : 'False'}` }));
      } else {
        let total = 0;
        row('마친 이체', (v, p, k) => {
          const add = v.ev.filter((e) => e.type === 'transfer-done').length;
          total += add;
          return { text: String(total), cls: `val${add ? ' changed' : ''}`, tip: `단계 ${k}까지 마친 이체 ${total}번` };
        });
      }
    } else {
      let total = 0;
      row('먹기 시작', (v, p, k) => {
        const add = v.ev.filter((e) => e.type === 'eat').length;
        total += add;
        return { text: String(total), cls: `val${add ? ' changed' : ''}`, tip: `단계 ${k}까지 먹기 시작한 횟수 ${total}번` };
      });
    }
    return rows;
  }

  const STRIP_NOTE = {
    release: '칸 글자: 잡 acquire() · 호 API 호출 · 풀 release() · ! 오류. 주황 칸: 상한을 넘었거나 오류가 난 단계.',
    buffer: '칸 글자: 잡 락 얻기 · 넣 jobs에 넣기 · 꺼 jobs에서 꺼내기 · 깨 notify() · 풀 락 놓기 · ! 오류. 주황 칸: 오류가 났거나 작업자가 줄어든 단계.',
    onecond: '칸 글자: 잡 락 얻기 · 넣 jobs에 넣기 · 꺼 jobs에서 꺼내기 · 깨 notify() · 풀 락 놓기.',
    wait: '칸 글자: 깨 set()으로 깨우기. GIL 줄은 그 단계가 끝난 뒤 GIL을 쥔 스레드, flag 줄은 ready.flag(T는 True, F는 False)다.',
    transfer: '칸 글자: 잡 락 얻기 · 이 잔액 옮기기 · 풀 락 놓기 · 다 쥔 락을 놓고 다시 시도. GIL 줄은 그 단계가 끝난 뒤 GIL을 쥔 스레드다.',
    phil: '칸 글자: 잡 포크(락)나 웨이터 자리 얻기 · 먹 먹기 시작 · 풀 놓기.',
  };

  function buildStrip() {
    const N = lastIdx();
    const strip = $('#strip');
    strip.style.gridTemplateColumns = `auto repeat(${N}, 30px)`;
    const out = ['<div class="rh">단계</div>'];
    for (let k = 1; k <= N; k++) out.push(`<div class="ch" data-step="${k}">${k}</div>`);
    for (const t of threads()) {
      out.push(`<div class="rh">${esc(rowName(t))}</div>`);
      for (let k = 1; k <= N; k++) {
        const s = run.views[k].th[t.id];
        const err = s.cls === 'run' && s.err;
        const mark = s.cls === 'run' ? stepMark(run.views[k], t.id) : '';
        const tip = `단계 ${k} · ${threadTitle(t)} · ${stateText(s)}${err ? ` · ${s.err}` : ''}`;
        out.push(stripCell(k, `${s.cls}${err ? ' bad' : ''}`, mark, tip));
      }
    }
    for (const r of valueRows()) {
      out.push(`<div class="rh">${esc(r.label)}</div>`);
      r.cells.forEach((c, i) => out.push(stripCell(i + 1, c.cls, c.text, c.tip)));
    }
    strip.innerHTML = out.join('');
    $('#stripNote').textContent = STRIP_NOTE[scene];
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
      for (const e of run.views[k].ev) items.push(`<li><span class="muted">${k}</span> ${esc(e.text)}</li>`);
    }
    $('#log').innerHTML = items.join('');
  }

  // ---------- 요소 설명 ----------
  // 개념, 주요 특성, 근거, 복습 카드는 content.js의 ELEMENTS에서 가져오고, 지금 상태는 단계마다 여기서 만든다.
  // "이 단계 동안"은 그 단계에 일어난 실행과 대기이고, "단계 끝"은 그 단계를 마친 뒤의 값이다.

  function evHtml(keys) {
    return keys.map((k) => RC.EV[k]).filter(Boolean)
      .map((e) => `<li><span class="tag t-${e.type}">${esc(RC.TYPE_LABEL[e.type])}</span> <a href="${esc(e.href)}" target="_blank" rel="noopener">${esc(e.label)}</a></li>`).join('');
  }
  function cardsHtml(ids) { return ids.map((c) => `<li><b>${esc(c)}</b> ${esc(RC.CARDS[c] || '')}</li>`).join(''); }

  function unusedReason(sel) { return sel === 'obj:event' && eventUnused() ? RC.UNUSED['event-unused'] : null; }

  function lineList(keys) {
    const ls = [...new Set(keys.flatMap(linesOfKey))].sort((a, b) => a - b).map((i) => i + 1);
    return ls.length ? `${ls.join(', ')}번` : '';
  }

  function waitTarget(id, v) {
    const o = objOf(id, v);
    return o ? objTitle(o) : id;
  }

  function nowLines(sel, type, v) {
    const out = [];
    const list = (ids) => (ids.length ? ids.join(', ') : '없음');
    if (type === 'thread') {
      const t = thread(sel.slice(3));
      const s = v.th[t.id];
      const after = s.cls === 'run' ? s.after : s;
      if (s.cls === 'run') out.push(`이 단계 동안 실행했다. 실행한 줄: ${lineList(s.lines) || '없음'}.`);
      else out.push('이 단계 동안 실행하지 않았다.');
      // dead는 잡지 않은 예외로 끝난 스레드다. 이중 release()의 오류는 handle()이 잡아 그 요청의 오류로 기록한다.
      if (s.err) out.push(`이 단계에 ${s.err}가 났다. ${s.dead ? '잡지 않은 예외라 이 스레드가 끝났다.' : 'handle()이 잡아 이 요청의 오류로 기록했다.'}`);
      if (after.cls === 'done') {
        if (!s.err) out.push(s.dead ? `잡지 않은 ${s.dead}로 끝났다.` : '단계 끝: 끝났다.');
        else if (!s.dead) out.push('단계 끝: 맡은 요청을 다 처리해 끝났다.');
      } else {
        out.push(`단계 끝: ${stateText(after)}${s.waitOn ? ` · ${josa(waitTarget(s.waitOn, v), ['을', '를'])} 기다린다` : ''}${s.due != null ? ` · 단계 ${s.due}에 깬다` : ''}.`);
        const nl = firstLine(s.at);
        if (nl >= 0) out.push(`다음에 실행할 줄: ${nl + 1}번.`);
      }
      const held = Object.values(v.obj).filter((o) => ((o.type === 'lock' || o.type === 'rlock') && o.locked && o.holder === t.id) || (o.type === 'sem' && o.holders.includes(t.id)));
      if (held.length) out.push(`단계 끝에 쥔 것: ${held.map(objTitle).join(', ')}.`);
      if (s.local) out.push(`맡은 일: ${s.local}.`);
      if (v.gil && v.gil.after === t.id) out.push('단계 끝에 GIL을 쥐고 있다.');
    } else if (type === 'gil') {
      out.push(`단계 끝에 쥔 스레드: ${v.gil.after || '없음'}.`);
      if (v.gil.during && v.gil.during !== v.gil.after) out.push(`이 단계 동안에는 ${josa(v.gil.during, ['이', '가'])} 쥐고 실행했다.`);
      out.push(`이 화면의 전환 간격: ${M.SWITCH[scene]}단계. 실행 중인 스레드가 이만큼 이어서 실행하면 기다리던 스레드에 GIL을 넘긴다(설명용).`);
    } else if (type === 'lock' || type === 'rlock' || type === 'fork') {
      const o = objOf(sel.slice(4), v);
      out.push(`단계 끝: ${lockState(o).filter(Boolean).join(', ')}.`);
      if (o.type === 'lock' && o.locked) out.push(`마지막으로 잡은 스레드: ${o.holder}. Lock은 이것을 기억하지 않는다. 모형이 관계도를 그리려고 따로 적은 값이다.`);
      out.push(`기다리는 스레드(앞부터): ${list(o.waiters)}.`);
      if (o.woken) out.push(`깨웠지만 아직 실행하지 않은 스레드: ${o.woken}. 락을 넘겨받지 않았으므로 먼저 실행한 다른 스레드가 잡을 수 있다.`);
      if (cycleLocks(v).has(o.id)) out.push('이 락이 기다림의 고리에 들어 있다.');
    } else if (type === 'sem' || type === 'bsem' || type === 'waiter') {
      const o = objOf(sel.slice(4), v);
      out.push(`단계 끝 카운터 ${o.value}(초깃값 ${o.init}).`);
      out.push(`얻고 아직 반납하지 않은 스레드(모형이 따로 셈): ${list(o.holders)}. 기다리는 스레드: ${list(o.waiters)}.`);
      if (o.woken.length) out.push(`깨웠지만 아직 실행하지 않은 스레드: ${o.woken.join(', ')}.`);
      if (o.value + o.holders.length > o.init) out.push(`카운터와 반납하지 않은 수의 합 ${o.value + o.holders.length}이 초깃값 ${o.init}보다 크다. 남는 release()가 상한을 늘렸다.`);
    } else if (type === 'cond') {
      const o = objOf(sel.slice(4), v);
      const L = v.obj[o.lock];
      out.push(`대기 목록(앞부터): ${list(o.waiters)}. notify()는 맨 앞 스레드를 깨운다.`);
      out.push(`연관된 락: ${L.type === 'rlock' ? 'RLock (Condition()이 안에서 만든 것)' : `${L.name} (밖에서 만들어 넘긴 Lock, 두 조건 변수가 함께 씀)`}. ${lockState(L).filter(Boolean).join(', ')}.`);
    } else if (type === 'event') {
      const o = objOf(sel.slice(4), v);
      out.push(`단계 끝 깃발: ${o.flag ? 'True' : 'False'}.`);
      out.push(o.unused ? 'event.wait()로 기다리는 스레드가 없다.' : `wait()로 블록된 스레드: ${list(o.waiters)}.`);
    } else if (type === 'flag') {
      out.push(`단계 끝: ready.flag = ${v.obj.ready.flag ? 'True' : 'False'}.`);
    } else if (type === 'api') {
      const o = v.obj.api;
      out.push(`단계 끝 동시 호출 ${o.inflight.length}개(상한 ${o.limit}): ${list(o.inflight)}.`);
      out.push(`지금까지 호출 ${o.calls}번, 가장 많을 때 동시 호출 ${o.max}개. 나중에 보낼 큐: ${o.queued.length ? o.queued.map((q) => `요청 ${q}`).join(', ') : '비어 있음'}.`);
    } else if (type === 'jobs') {
      const o = v.obj.jobs;
      out.push(`단계 끝: jobs = [${o.items.join(', ')}] (최대 ${o.cap}).`);
    } else if (type === 'account') {
      const o = v.obj[sel.slice(4)];
      const L = v.obj[o.lock];
      out.push(`단계 끝 잔액 ${o.balance}.`);
      out.push(`계좌의 락 ${L.name}: ${lockState(L).filter(Boolean).join(', ')}${L.type === 'lock' && L.locked ? `(${josa(L.holder, ['이', '가'])} 잡음)` : ''}.`);
    }
    return out;
  }

  // 고정된 설명은 고른 요소가 바뀔 때만 다시 채운다. 그래서 단계를 옮겨도 펼친 근거 칸이 닫히지 않는다.
  function renderDetails() {
    const pane = $('#details');
    if (!selected) { pane.hidden = true; detailsFor = null; return; }
    const type = typeOf(selected);
    const d = RC.ELEMENTS[type];
    if (detailsFor !== selected) {
      detailsFor = selected;
      const why = unusedReason(selected);
      $('#detailsKind').textContent = d.kind;
      $('#detailsTitle').textContent = nameOf(selected);
      $('#detailsWhy').hidden = !why;
      $('#detailsWhy').querySelector('p').textContent = why ? why.text : '';
      $('#detailsConcept').textContent = d.concept;
      $('#detailsProps').innerHTML = d.props.map((p) => `<li>${esc(p.replace('{FAIR}', M.FAIR))}</li>`).join('');
      $('#detailsEv').innerHTML = evHtml(d.ev.concat(why ? why.ev : []));
      $('#detailsCards').innerHTML = cardsHtml(d.cards);
    }
    $('#detailsNowHead').textContent = `지금 · 단계 ${idx}`;
    $('#detailsNow').innerHTML = nowLines(selected, type, view()).map((s) => `<li>${esc(s)}</li>`).join('');
    pane.hidden = false;
  }

  function select(id) {
    selected = id;
    detailsFor = null;
    markSelected();
    renderDetails();
    $('#live').textContent = `${nameOf(id)} 설명을 열었다.`;
    // 좁은 화면에서는 설명 칸이 관계도 아래에 있다. 화면 밖에 있으면 보이는 곳까지 민다.
    const r = $('#details').getBoundingClientRect();
    if (r.top > window.innerHeight || r.bottom < 0) $('#details').scrollIntoView({ block: 'nearest', behavior: motionOff.matches ? 'auto' : 'smooth' });
  }

  function closeDetails() {
    const was = selected;
    const inside = $('#details').contains(document.activeElement);
    selected = null;
    markSelected();
    renderDetails();
    // 설명 칸 안에서 닫았으면 그 요소로 초점을 돌려준다.
    const back = was && $('#board').querySelector(`[data-sel="${was}"][tabindex]`);
    if (inside && back) back.focus();
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
    renderDetails();
    $('#boardSummary').textContent = describe(v);
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
    run = M.simulate(scene, cfg);
    idx = 0;
    shown = -1;
    codeSig = null;
    buildBoard();
    // 구성을 바꿔 고른 요소가 없어졌으면 설명 칸을 닫는다. 남아 있으면 설명을 새 구성으로 다시 채운다.
    if (selected && !$('#board').querySelector(`[data-sel="${selected}"]`)) selected = null;
    detailsFor = null;
    buildStrip();
    renderCounts();
    $('#scrub').max = String(lastIdx());
    $('#stepMax').textContent = String(lastIdx());
    render(false);
  }

  function setConfig(patch) {
    cfg = M.normalizeConfig(scene, Object.assign({}, cfg, patch));
    cfgs[scene] = cfg;
    pause();
    simulate();
    syncControls();
    renderMap();
  }

  // ---------- 장면 고르기와 장면별 조절 ----------

  const OPTS = {
    release: [{ label: '상한 도구', key: 'tool', items: [['semaphore', 'Semaphore'], ['bounded', 'BoundedSemaphore'], ['lock', 'Lock'], ['rlock', 'RLock']] },
      { label: '코드', key: 'code', items: [['buggy', 'release() 두 번'], ['fixed', 'with 문']] }],
    buffer: [{ label: 'take()의 확인', key: 'take', items: [['if', 'if'], ['while', 'while']] },
      { label: '깨우기', key: 'wake', items: [['notify', 'notify()'], ['notify_all', 'notify_all()']] }],
    onecond: [{ label: '깨우는 방법', key: 'fix', items: [['one', '조건 변수 하나 · notify()'], ['all', '조건 변수 하나 · notify_all()'], ['two', '조건 변수 둘']] }],
    wait: [{ label: '기다리는 방법', key: 'how', items: [['pass', 'pass로 돌기'], ['sleep', 'sleep으로 쉬기'], ['event', 'Event.wait()']] }],
    transfer: [{ label: '락 잡는 방법', key: 'how', items: [['opposite', '보내는 계좌부터'], ['ordered', '락 순서 고정'], ['retry', '내려놓고 다시']] },
      { label: '계좌', key: 'accounts', items: [['pair', 'A→B와 B→A'], ['self', 'A→A']] }],
    phil: [{ label: '포크 집기', key: 'pick', items: [['left', '모두 왼쪽 먼저'], ['larger', '큰 번호 먼저'], ['waiter', '웨이터 · 왼쪽 먼저']] }],
  };
  const EXTRAS = {
    buffer: [{ type: 'num', key: 'workers', label: '작업자' }],
    wait: [{ type: 'num', key: 'waiters', label: '요청 처리 스레드' }],
    transfer: [{ type: 'select', key: 'lock', label: '계좌의 락', items: [['lock', 'threading.Lock()'], ['rlock', 'threading.RLock()']] },
      { type: 'select', key: 'check', label: '한도 확인', items: [['db', 'DB 확인(sleep)'], ['memory', '메모리 캐시 확인']] },
      { type: 'num', key: 'per', label: '스레드마다 이체' }],
    phil: [{ type: 'select', key: 'think', label: '생각 시간', items: [['same', '모두 같게'], ['spread', '서로 다르게']] },
      { type: 'num', key: 'meals', label: '끼니' }],
  };
  function cfgNote() {
    const U = M.UNITS;
    return {
      release: '실험은 요청 40개, 작업자 8개, 상한 4(락은 1), 5·15·25번째 호출 타임아웃이었다. 이 장면은 요청 4개, 스레드 3개, 상한 2(락은 1), 1번째 호출 타임아웃으로 줄였다. 이 장면에는 더 바꿀 구성이 없다.',
      buffer: `실험은 업로드 3번 뒤 작업 20개를 더 넣어 처리 시간을 쟀다. 이 장면은 업로드 3번까지만 그린다. 썸네일 작업(sleep)은 ${U.thumb}단계로 줄였다.`,
      onecond: '변형 문제 1의 구성이다. 버퍼 크기 1, 작업자 t1·t2가 먼저 take()에서 기다리고, P가 put(1)과 put(2)를 연달아 부른다. 이 장면에는 더 바꿀 구성이 없다.',
      wait: `실험은 기다리는 스레드 4·8개였다. 로더 계산은 ${U.load}단계, sleep 확인 간격은 ${U.poll}단계, GIL 전환 간격은 ${M.SWITCH.wait}단계로 줄였다(설명용).`,
      transfer: `실험은 스레드마다 이체 1,000번(3번 조건은 10만 번)이었다. DB 확인은 ${U.db}단계, 내려놓고 다시의 쉬는 시간은 t1 ${U.backoff[0]}단계·t2 ${U.backoff[1]}단계, GIL 전환 간격은 ${M.SWITCH.transfer}단계로 줄였다(설명용).`,
      phil: `실험은 끼니 100번, 생각 시간 0~2ms 무작위였다. 이 장면은 생각 시간을 고정 단계(모두 같게: 1단계씩, 서로 다르게: 철학자 0~4가 ${U.think.spread.join('·')}단계)로 두었다. 첫 포크를 집고 쉬는 시간과 먹는 시간은 ${U.pick}단계다.`,
    }[scene];
  }
  const BOARD_NOTE = {
    release: '상자 안 글자는 그 도구가 기억하는 것만 적는다. Lock은 잠금과 잠금 해제만, RLock은 주인과 수준을, 세마포어는 카운터를 기억한다. 스레드에서 도구로 가는 파란 선은 잡거나 얻은 스레드를 모형이 따로 적어 그린 것이다. 가짜 API로 가는 회색 선은 호출 중인 스레드다.',
    buffer: '조건 변수 상자 안의 작은 상자는 Condition()이 안에서 만든 RLock이다. 대기 목록은 먼저 기다린 스레드부터 적는다. 통지를 받은 스레드는 대기 목록에서 빠져 락을 기다리고, 락을 얻어야 wait()에서 돌아온다. 업로드 스레드 P가 작업자들이 모두 다시 기다리기를 기다리는 동안은 sleep 대기로 그린다.',
    onecond: '대기 목록은 먼저 기다린 스레드부터 적는다. 통지를 받은 스레드는 대기 목록에서 빠져 락을 기다리고, 락을 얻어야 wait()에서 돌아온다. "조건 변수 둘"의 lock은 밖에서 만들어 두 조건 변수에 넘긴 것이라 따로 그린다.',
    wait: 'GIL 꼬리표는 그 단계가 끝난 뒤 GIL을 쥔 스레드의 상자에 놓인다. 쥔 스레드가 없으면 왼쪽 위 GIL 자리로 돌아간다. Ready 상자 안에 flag와 Event가 있다. Event 안의 락과 조건 변수는 그리지 않는다.',
    transfer: '계좌 상자 안에 그 계좌의 락과 잔액이 있다. 기다림이 고리를 이루면 고리에 든 선과 락을 주황으로 그린다. GIL 꼬리표는 그 단계가 끝난 뒤 GIL을 쥔 스레드의 상자에 놓인다.',
    phil: '철학자 i는 양옆의 포크 i와 포크 i+1을 쓴다. 기다림이 고리를 이루면 고리에 든 선과 포크를 주황으로 그린다. 둥근 식탁에서는 곡선이 상자를 지나가므로 연결선만 곧은 선으로 그렸다.',
  };

  function content() { return RC.SCENES[scene] || { questions: [], observe: [], measured: [], evidence: [], cards: [] }; }
  function guessKey() { return `sync-board-${scene}-guess`; }

  function buildSceneButtons() {
    $('#scenes').innerHTML = GROUPS.map(([key, label]) => `<div class="scene-group" role="group" aria-label="${esc(label)}">`
      + `<span class="group-label" aria-hidden="true">${esc(label)}</span>`
      + Object.entries(SCENES).filter(([, d]) => d.group === key).map(([k, d]) => `<button type="button" data-scene="${k}">${esc(d.label)}</button>`).join('')
      + '</div>').join('');
  }

  // 주황 상자나 칸이 나오는 장면에만 그 뜻을 적는다. 교착 상태 장면의 주황은 "기다림의 고리" 선 견본이 설명한다.
  const BAD_LEGEND = { release: '상한 초과, 오류', buffer: '오류' };

  function legendHtml() {
    const states = '<li><i class="sw run"></i>실행 중</li><li><i class="sw turn"></i>차례 기다림</li><li><i class="sw event"></i>이벤트 기다림</li><li><i class="sw done"></i>끝</li>';
    const shapes = '<li><i class="shape box"></i>상자: 포함 관계</li><li><i class="shape circle"></i>OS 스레드</li>';
    const lines = ['<li><i class="cnl held"></i>쥠·얻음</li>', '<li><i class="cnl wait"></i>기다림</li>'];
    if (scene === 'release') lines.push('<li><i class="cnl call"></i>API 호출 중</li>');
    if (scene === 'transfer' || scene === 'phil') lines.push('<li><i class="cnl cycle"></i>기다림의 고리</li>');
    const gil = gilOn() ? '<li><i class="shape tag"></i>GIL</li>' : '';
    const bad = BAD_LEGEND[scene] ? `<li><i class="sw bad"></i>${BAD_LEGEND[scene]}</li>` : '';
    return `${shapes}${gil}${states}${lines.join('')}${bad}`;
  }

  function buildSceneText() {
    const c = content();
    document.querySelectorAll('[data-scene]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scene === scene)));
    $('#sceneTitle').textContent = SCENES[scene].label;
    $('#questions').innerHTML = (c.questions || []).map((q) => `<li>${esc(q)}</li>`).join('');
    $('#observe').innerHTML = (c.observe || []).map((o) => `<li>${esc(o)}</li>`).join('');
    $('#measured').innerHTML = (c.measured || []).map((m) => `<li>${esc(m)}</li>`).join('');
    $('#sceneEv').innerHTML = evHtml(c.evidence || []);
    $('#sceneCards').innerHTML = cardsHtml(c.cards || []);
    $('#guess').value = store.get(guessKey()) || '';
    $('#boardNote').textContent = BOARD_NOTE[scene];
    $('#opts').innerHTML = OPTS[scene].map((o, i) => `<div class="scope" role="group" aria-labelledby="opt${i}"><span id="opt${i}">${esc(o.label)}</span>`
      + o.items.map(([val, label]) => `<button type="button" data-opt="${o.key}" data-val="${val}">${esc(label)}</button>`).join('') + '</div>').join('');
    const parts = (EXTRAS[scene] || []).map((x) => (x.type === 'num'
      ? `<div class="num" data-k="${x.key}"><span>${esc(x.label)}</span><button type="button" data-d="-1" aria-label="${esc(x.label)} 줄이기">−</button><output></output><button type="button" data-d="1" aria-label="${esc(x.label)} 늘리기">+</button></div>`
      : `<label>${esc(x.label)} <select data-k="${x.key}">${x.items.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>`));
    parts.push(`<p class="note">${esc(cfgNote())}</p>`);
    $('#cfg').innerHTML = parts.join('');
  }

  function syncControls() {
    document.querySelectorAll('[data-opt]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.val === String(cfg[b.dataset.opt]))));
    document.querySelectorAll('#cfg select').forEach((s) => { s.value = cfg[s.dataset.k]; });
    const range = M.RANGES[scene] || {};
    document.querySelectorAll('#cfg .num').forEach((row) => {
      const k = row.dataset.k;
      const [lo, hi] = range[k];
      row.querySelector('output').textContent = String(cfg[k]);
      row.querySelector('[data-d="-1"]').disabled = cfg[k] <= lo;
      row.querySelector('[data-d="1"]').disabled = cfg[k] >= hi;
    });
    $('#legend').innerHTML = legendHtml();
  }

  function setScene(key) {
    if (!SCENES[key]) key = DEFAULT_SCENE;
    pause();
    scene = key;
    selected = null;
    cfg = cfgs[key] || M.normalizeConfig(key, {});
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
    const sel = e.target.closest && e.target.closest('#board [data-sel]');
    if (sel && (e.key === 'Enter' || e.key === ' ')) { select(sel.dataset.sel); e.preventDefault(); return; }
    if (e.key === 'Escape') {
      if (!selected) return;
      closeDetails();
    } else if (e.key === 'ArrowRight') { pause(); go(idx + 1); }
    else if (e.key === 'ArrowLeft') { pause(); go(idx - 1); }
    else if (e.key === 'Home') { pause(); go(0); }
    else if (e.key === 'End') { pause(); go(lastIdx()); }
    else if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'SUMMARY' && tag !== 'A') play();
    else return;
    e.preventDefault();
  }

  function bindControls() {
    buildSceneButtons();
    $('#speed').innerHTML = SPEEDS.map((s, i) => `<option value="${i}">${s.label}</option>`).join('');
    $('#speed').value = String(speed);
    $('#ankiLink').href = RC.EV.anki.href;
    $('#guess').addEventListener('input', (e) => store.set(guessKey(), e.target.value));
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
    $('#board').addEventListener('click', (e) => {
      const n = e.target.closest('[data-sel]');
      if (n) select(n.dataset.sel);
    });
    $('#detailsClose').addEventListener('click', closeDetails);
    document.querySelectorAll('[data-scene]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.scene !== scene) setScene(b.dataset.scene); }));
    $('#opts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-opt]');
      if (b) setConfig({ [b.dataset.opt]: b.dataset.val });
    });
    $('#cfg').addEventListener('change', (e) => {
      if (e.target.matches('select[data-k]')) setConfig({ [e.target.dataset.k]: e.target.value });
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
  const stored = store.get(SCENE_KEY);
  setScene(SCENES[fromHash] ? fromHash : SCENES[stored] ? stored : DEFAULT_SCENE);

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

  // 브라우저 확인 스크립트용
  window.__syncBoard = { get scene() { return scene; }, get cfg() { return cfg; }, get idx() { return idx; }, get run() { return run; },
    get geo() { return geo; }, get code() { return code; }, get selected() { return selected; }, go, setConfig, setScene, select,
    linesOfKey, firstLine, lastLine };
})();
