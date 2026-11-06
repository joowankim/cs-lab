/*
 * 락 관계도: 위에는 전체 지도 하나, 아래에는 고른 장면의 관계도.
 * 모든 장면은 model.js가 만든 단계 기록을 그대로 그린다. 순서표 장면은 실험의 순서표 한 줄이 한 단계이고,
 * 동시 요청 장면은 요청마다 문장을 하나씩 보내는 한 차례가 한 단계, 커넥션 풀 장면은 모형의 0.2초가 한 단계다.
 * 세션의 실행 여부(채움, 코드 이름표, 단계 띠 칸)는 그 단계 동안의 상태이고, 락·기다림·레코드·값은 그 단계가 끝난 뒤의 상태다.
 * 표 상자 안에는 인덱스마다 한 줄이 있다. 줄 안의 실선 칸이 인덱스 레코드(키 순서), 그 앞 점선 칸이 갭, 맨 끝 칸이 supremum
 * (마지막 레코드 뒤 갭)이다. 레코드가 없는 단계에는 그 칸과 앞 갭 칸을 숨기고, 다음 갭 칸이 그 자리까지 넓어진다.
 * 보유한 락은 칸의 이름표("X A")와 파란 테두리로, 기다림은 세션에서 칸으로 가는 회색 점선으로, 기다림의 고리는 주황 선으로 그린다.
 * 관계도의 요소를 고르면 설명 칸에 그 요소의 개념, 지금 상태, 근거가 나온다.
 * 단계는 이벤트의 순서이고 시간 길이가 아니다(커넥션 풀 장면만 모형의 시각을 붙인다).
 *
 * 장면을 더하려면 model.js에 장면을 만들고, 여기의 SCENES와 장면별 함수(codeFor, valueRows, resultText, partsFor, renderCounts)에
 * 그 장면을 더하고, content.js의 SCENES에 같은 이름으로 질문, 볼 것, 실측 기록, 근거를 적는다.
 */
(function () {
  'use strict';

  const M = window.LockModel;
  const RC = window.LockContent || { SCENES: {}, ELEMENTS: {}, EV: {}, CARDS: {}, TYPE_LABEL: {} };
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const motionOff = window.matchMedia('(prefers-reduced-motion: reduce)');

  const SPEEDS = [{ label: '느리게', ms: 2000 }, { label: '보통', ms: 1200 }, { label: '빠르게', ms: 600 }];
  const SCENE_KEY = 'lock-board-scene';
  const DEFAULT_SCENE = 'gap';
  // 세션 상자의 가장 좁은 너비. 관계도가 이보다 좁아지면 줄이지 않고 관계도 칸 안에서 옆으로 밀어 보게 한다.
  const BOX_MIN = 64;
  const CHIP_H = 20;
  const CHIP_GAP = 4;

  const SCENES = {
    gap: { group: 'range' },
    noidx: { group: 'range' },
    serial: { group: 'range' },
    transfer: { group: 'dead' },
    pair: { group: 'dead' },
    deduct: { group: 'burst' },
    reward: { group: 'burst' },
    pool: { group: 'pool' },
  };
  for (const [k, d] of Object.entries(SCENES)) d.label = M.SCENARIOS[k].label;
  const GROUPS = [['range', '범위를 잠그는 락'], ['dead', '데드락'], ['burst', '동시 요청'], ['pool', '커넥션 풀']];
  // 갭이 이야기의 중심인 장면. 락이 걸리지 않은 조건(READ COMMITTED 등)에서도 첫 인덱스의 갭 칸을 그려 견줄 수 있게 한다.
  const FORCE_GAPS = ['gap', 'noidx', 'serial', 'pair'];

  // 설명 한 문장으로 고를 이벤트. 문제를 알리는 이벤트(bad)를 먼저 고르고, 없으면 그 단계의 첫 이벤트를 고른다.
  const BAD_ORDER = ['error', 'lost', 'dup', 'none', 'timeout', 'wait'];
  // 단계 띠 칸에 적는 글자: 그 단계에 그 세션이 한 일. 여러 개면 앞의 것을 적는다.
  const MARKS = [
    ['!', ['error']],
    ['확', ['commit']],
    ['되', ['rollback']],
    ['기', ['wait']],
    ['쓰', ['write']],
    ['잠', ['lockread']],
    ['읽', ['read']],
    ['시', ['begin']],
    ['일', ['pause']],
  ];
  const STATE_NAME = { run: '실행 중', turn: '차례 기다림', event: '락 기다림', done: '끝' };
  const KIND_WORD = { NK: '넥스트 키 락', REC: '레코드 락', GAP: '갭 락', II: '삽입 의도 락' };
  const RESULT_WORD = { granted: '지급', already: '이미 받음', error: '오류', 'gave-up': '포기', done: '차감 끝', unpaid: '잔액 없이 커밋' };
  const POOL_STATE = { new: '출발 전', wait: '연결 기다림', connect: '새 연결 여는 중', use: '연결을 쓰는 중', done: '끝', timeout: '풀 타임아웃' };
  const SUP = 'supremum pseudo-record';

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
  // 설명 칸에 보이는 요소(th:세션, tb:표, ix:표/인덱스, cell:칸, pool:부분)와, 고정된 설명을 마지막으로 채운 요소
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
  // 글자 너비 어림값(px). 화면의 글꼴로 잴 수 없을 때 쓴다. 한글은 글자 크기만큼, 영문과 숫자는 그보다 좁게 잡는다.
  function tw(text, fs) {
    let w = 0;
    for (const ch of String(text || '')) {
      const c = ch.codePointAt(0);
      if (c >= 0xac00 && c <= 0xd7a3) w += fs * 0.96;
      else if (/[A-Z]/.test(ch)) w += fs * 0.68;
      else if (/[a-z0-9_]/.test(ch)) w += fs * 0.57;
      else if (ch === ' ') w += fs * 0.3;
      else w += fs * 0.6;
    }
    return w;
  }
  // 글자 너비(px). 화면의 글꼴로 직접 잰다. 글꼴이 기기마다 달라도 상자 크기와 줄 나눔이 그 글꼴에 맞는다.
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
    let k = s.lastIndexOf(' ');
    while (k > 0 && textW(s.slice(0, k), size, weight) > maxW) k = s.lastIndexOf(' ', k - 1);
    if (k <= 0) k = s.lastIndexOf(' ');
    return k < 0 ? [s, ''] : [s.slice(0, k), s.slice(k + 1)];
  }
  // 빈칸에서 나눠 필요한 만큼 여러 줄로 쓴다. 빈칸 없이 긴 낱말은 그대로 한 줄에 둔다.
  function wrapLines(text, size, weight, maxW) {
    const out = [];
    let line = '';
    for (const word of String(text || '').split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && textW(next, size, weight) > maxW) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out;
  }
  const josa = (w, pair) => M.josa(w, pair);
  function cmpKey(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] == null) return -1;
      if (b[i] == null) return 1;
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  function view() { return run.views[idx]; }
  function lastIdx() { return run.views.length - 1; }
  function threads() { return run.threads; }
  function thread(id) { return run.threads.find((t) => t.id === id); }
  function tIndex(id) { return run.threads.findIndex((t) => t.id === id); }
  function isPool() { return run.kind === 'pool'; }
  function isBurst() { return run.kind === 'burst'; }
  function multiTable() { return !isPool() && run.views[0] && Object.keys(run.views[0].obj).length > 1; }
  // 세션 이름: 순서표는 A, B, 동시 요청은 요청 번호
  function who(id) { return isBurst() ? `요청 ${id}` : id; }
  function whoList(ids) { return isBurst() ? `요청 ${M.rangeText(ids.map(Number))}` : ids.join('·'); }
  function stateText(s) {
    if (s.cls === 'done') return `끝${s.why && s.why !== '끝' ? ` (${s.why})` : ''}`;
    return STATE_NAME[s.cls];
  }
  function tablesOf(v) { return Object.values(v.obj); }
  function ixOf(v, t, name) { return v.obj[t].indexes.find((x) => x.name === name); }
  // 칸 id: 표/인덱스/레코드(LOCK_DATA 값), 표/인덱스/레코드/gap(그 레코드 앞 갭), 표/인덱스/sup
  function cellParts(id) {
    const [t, ix, ...rest] = id.split('/');
    const tail = rest.join('/');
    if (tail === 'sup') return { t, ix, kind: 'sup', rec: null };
    if (tail.endsWith('/gap')) return { t, ix, kind: 'gap', rec: tail.slice(0, -4) };
    return { t, ix, kind: 'rec', rec: tail };
  }
  function recName(ix, data) { return ix === 'PRIMARY' ? data : `(${data})`; }
  function supWord(c) { return c ? 'sup' : 'supremum'; }

  // ---------- 락 글자 ----------

  function lockKind(r) {
    if (r.type === 'TABLE') return r.mode === 'IX' ? '의도 배타 락' : '의도 공유 락';
    if (r.data === SUP && r.kind !== 'II') return '마지막 레코드 뒤 갭';
    return KIND_WORD[r.kind];
  }
  function lockAt(r) {
    const t = multiTable() ? `${r.table} ` : '';
    if (r.type === 'TABLE') return `${r.table} 표`;
    if (r.data === SUP) return `${t}${r.index} supremum`;
    return `${t}${r.index} ${recName(r.index, r.data)}`;
  }
  function lockLine(r) { return `${lockAt(r)}의 ${r.mode}(${lockKind(r)})`; }
  const MODE_ORDER = { X: 0, S: 1, II: 2 };
  // 칸마다 보유한 락의 이름표: "X A·B", 동시 요청은 "X 1~3". 기다리는 락은 이름표 대신 칸의 점선 테두리와 선으로 그린다.
  function labelsOf(v) {
    const by = new Map();
    for (const r of v.dataLocks) {
      if (r.type === 'TABLE' || r.status !== 'GRANTED') continue;
      const mode = r.kind === 'II' ? 'II' : r.mode.split(',')[0];
      for (const cell of r.cells) {
        if (!by.has(cell)) by.set(cell, new Map());
        const mm = by.get(cell);
        if (!mm.has(mode)) mm.set(mode, []);
        if (!mm.get(mode).includes(r.session)) mm.get(mode).push(r.session);
      }
    }
    const out = new Map();
    for (const [cell, mm] of by) {
      const parts = [...mm].sort((a, b) => MODE_ORDER[a[0]] - MODE_ORDER[b[0]]).map(([mode, ss]) => `${mode} ${isBurst() ? M.rangeText(ss.map(Number)) : ss.join('·')}`);
      out.set(cell, parts.join(' · '));
    }
    return out;
  }
  // 이 단계 끝에 있는 레코드 칸
  function presentOf(v) {
    const out = new Set();
    for (const t of tablesOf(v)) for (const ix of t.indexes) for (const r of ix.recs) out.add(`${t.name}/${ix.name}/${r.data}`);
    return out;
  }
  function recOf(v, cellId) {
    const p = cellParts(cellId);
    const ix = v.obj[p.t] && ixOf(v, p.t, p.ix);
    return ix ? ix.recs.find((r) => r.data === p.rec) || null : null;
  }
  // PRIMARY 칸 안의 값 상자: 가장 새 버전, 그것이 커밋 전이면 그 아래 커밋된 값
  function shownVers(r) {
    if (!r || !r.vers || !r.vers.length) return [];
    const top = r.vers[0];
    const out = [top];
    if (top.state === 'active') {
      const c = r.vers.find((x) => x.state === 'committed');
      if (c) out.push(c);
    }
    return out;
  }

  // ---------- 요소 이름과 고르기 ----------

  function typeOf(sel) {
    if (sel.startsWith('th:')) return isBurst() ? 'request' : 'session';
    if (sel.startsWith('tb:')) return 'table';
    if (sel.startsWith('ix:')) {
      const [t, ix] = sel.slice(3).split('/');
      const x = ixOf(run.views[0], t, ix);
      return x.primary ? 'index-primary' : x.unique ? 'index-unique' : 'index-secondary';
    }
    if (sel.startsWith('cell:')) {
      const p = cellParts(sel.slice(5));
      if (p.kind !== 'rec') return p.kind;
      return p.ix === 'PRIMARY' ? 'record-primary' : 'record-secondary';
    }
    const part = sel.slice(5);
    if (part === 'pool') return run.kase.pool === 'null' ? 'pool-null' : 'pool-queue';
    return `pool-${part}`;
  }

  function threadTitle(t) { return isBurst() ? `요청 ${t.id}` : `세션 ${t.name}`; }
  function circleText(t) { return t.id; }
  function nameOf(sel) {
    if (sel.startsWith('th:')) return threadTitle(thread(sel.slice(3)));
    if (sel.startsWith('tb:')) return `표 ${sel.slice(3)}`;
    if (sel.startsWith('ix:')) { const [t, ix] = sel.slice(3).split('/'); return `${multiTable() ? `${t}의 ` : ''}${ix} 인덱스`; }
    if (sel.startsWith('cell:')) {
      const p = cellParts(sel.slice(5));
      const t = multiTable() ? `${p.t} ` : '';
      if (p.kind === 'sup') return `${t}${p.ix} supremum (마지막 레코드 뒤 갭)`;
      if (p.kind === 'gap') return `${t}${p.ix}의 ${recName(p.ix, p.rec)} 앞 갭`;
      return `${t}${p.ix} 레코드 ${recName(p.ix, p.rec)}`;
    }
    return { 'pool:app': `앱 프로세스의 요청 ${M.POOL_REQUESTS}개`, 'pool:pool': run.kase.pool === 'null' ? 'NullPool (풀 없음)' : '커넥션 풀 (QueuePool)', 'pool:db': 'MySQL 서버의 연결' }[sel] || sel;
  }

  // 고를 수 있는 요소. 누르거나 Tab으로 옮겨 Enter를 누르면 설명 칸에 그 요소의 설명이 나온다.
  // 한 요소를 도형 여러 개로 그리면(세션 상자와 원) 하나만 Tab으로 옮겨 갈 수 있게 한다.
  function selAttrs(id, focus) {
    const a = { 'data-sel': id };
    if (focus !== false) Object.assign(a, { tabindex: '0', role: 'button', 'aria-label': nameOf(id) });
    return a;
  }
  function setCls(node, cls) {
    node.setAttribute('class', node.dataset.sel != null && node.dataset.sel === selected ? `${cls} sel` : cls);
  }
  function markSelected() {
    const svg = $('#board');
    svg.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel'));
    if (selected) svg.querySelectorAll(`[data-sel="${selected}"]`).forEach((n) => n.classList.add('sel'));
  }

  // ---------- 공통 그림 ----------

  // 곡선 연결선: 두 끝에서 세로로 나가고 들어오는 3차 베지에 곡선.
  function curve(x0, y0, x1, y1) {
    const f = (n) => Math.round(n * 10) / 10;
    const dy = (y1 - y0) / 2;
    return `M${f(x0)} ${f(y0)}C${f(x0)} ${f(y0 + dy)} ${f(x1)} ${f(y1 - dy)} ${f(x1)} ${f(y1)}`;
  }

  function buildBoard() {
    const svg = $('#board');
    svg.innerHTML = '';
    geo = isPool() ? layoutPool() : layoutRow();
    const g = geo;
    svg.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
    // 관계도가 칸보다 넓으면 줄이지 않고 옆으로 밀어 본다. 기본 최대 너비(700px)보다 넓을 때도 글자를 줄이지 않는다.
    const fixed = g.scroll || g.W > 700;
    svg.style.width = fixed ? `${g.W}px` : '';
    svg.style.maxWidth = fixed ? 'none' : '';
    svg.classList.toggle('compact', g.compact);
    g.nodes = {};
    if (isPool()) { drawPool(svg, g); return; }
    drawThreadBoxes(svg, g);
    drawObjects(svg, g);
    // 연결선은 표 상자 위에 그린다. 표 안의 칸으로 가는 선이 표 상자의 테두리를 지나 보이게 하려는 것이다.
    g.cnG = el('g', { class: 'cns' }, svg);
    // 인덱스 이름은 연결선 위에 바탕색 테두리를 둘러 그린다. 위 줄의 칸으로 가는 선이 이름 위를 지나가도 이름이 읽힌다.
    const names = el('g', { class: 'ixlbls' }, svg);
    for (const b of Object.values(g.objs)) {
      for (const row of b.rows) el('text', { class: 'ixlbl', x: row.x0, y: row.lblY }, el('g', selAttrs(`ix:${b.id}/${row.name}`, false), names), row.label);
    }
    drawThreads(svg, g);
  }

  function renderBoard(v) {
    if (isPool()) renderPool(v);
    else {
      renderThreads(v);
      renderObjects(v);
      renderLinks(v);
    }
    markSelected();
  }

  // ---------- 배치 ----------
  // 위에 세션 상자를 한 줄로 두고, 아래에 표 상자를 한 줄로 둔다. 세션 상자에는 원과 그 세션만의 것(상태, 트랜잭션, 마지막 결과)만 담는다.
  // 세션에서 선이 들어오는 표는 모두 한 줄에 둔다. 그래서 선이 다른 표 상자를 지나가지 않는다.

  function slotsFor() { return isBurst() ? ['why', 'local'] : ['why', 'trx', 'local']; }
  // 실행 중인 세션은 상태 줄을 비운다. 다만 동시 요청이 이 단계에 마지막 문장을 실행했으면 요청의 결과(지급, 이미 받음, 오류 등)를 적는다.
  function slotText(slot, s) {
    if (slot === 'why') return s.cls !== 'run' ? s.why : isBurst() && s.after && s.after.cls === 'done' ? s.after.why : '';
    if (slot === 'trx') return s.trx;
    return s.err || s.local || '';
  }

  function layoutRow() {
    const ths = threads();
    const T = ths.length;
    const avail = Math.floor($('#boardWrap').clientWidth) || 600;
    const compact = avail < 480;
    const m = compact ? 6 : 12;
    const sep = compact ? 4 : 10;
    const gap = compact ? 8 : 14;
    const list = objectList(compact);
    const rowNeed = 2 * m + list.reduce((sum, b) => sum + b.w, 0) + gap * Math.max(0, list.length - 1);
    const W = Math.ceil(Math.max(260, 2 * m + T * BOX_MIN + (T - 1) * sep, rowNeed, Math.min(680, avail)));
    const r = compact ? 15 : 17;
    const g = { W, compact, scroll: W > avail + 1, m, sep, r, gap, fs: compact ? 11 : 12, lh: compact ? 14 : 15, list };
    const thTop = 8;
    const cy = thTop + 8 + r;
    const col = (W - 2 * m + sep) / T;
    const boxW = Math.min(col - sep, 180);
    const x0 = (W - (T * boxW + (T - 1) * sep)) / 2;
    g.boxW = boxW;
    g.fit = boxW - 8;
    // 글줄마다 모든 단계를 미리 본다. 한 단계라도 상자에 들어가지 않으면 그 줄은 두 줄 자리를 잡는다. 단계마다 상자 높이가 바뀌지 않게 하려는 것이다.
    const slots = slotsFor();
    g.slots = slots;
    g.stack = {};
    for (const slot of slots) {
      g.stack[slot] = run.views.some((v) => ths.some((t) => textW(slotText(slot, v.th[t.id]), g.fs, slot === 'local' ? 600 : 400) > g.fit));
    }
    let y = cy + r + 16;
    g.slotY = {};
    for (const slot of slots) { g.slotY[slot] = y; y += g.lh * (g.stack[slot] ? 2 : 1) + 1; }
    g.thB = y - 6;
    g.thPos = ths.map((_, i) => ({ x: x0 + i * (boxW + sep) + boxW / 2, cy }));
    g.thBox = g.thPos.map((p) => ({ x: p.x - boxW / 2, y: thTop, w: boxW, h: g.thB - thTop }));
    g.objTop = g.thB + (compact ? 40 : 48);
    placeObjects(g);
    return g;
  }

  // 인덱스 줄의 이름: 보조 인덱스는 레코드 키(보조 키 + 기본 키), PRIMARY는 기본 키와 행 데이터
  function ixLabel(t, ix) {
    if (ix.primary) return `PRIMARY (${t.pk}) · 행 데이터`;
    return `${ix.name} (${[...ix.cols, t.pk].join(', ')})${ix.unique ? ' UNIQUE' : ''}`;
  }

  // 표 하나의 모양. 모든 단계에 나오는 인덱스 레코드를 미리 모아 칸 자리를 정해 둔다. 칸 너비는 모든 단계의 이름표가 들어가게 잡는다.
  function tableShape(id, c) {
    const fs = c ? 11 : 12;
    const pad = c ? 4 : 6;
    const colGap = c ? 3 : 4;
    const V = run.views;
    const t0 = V[0].obj[id];
    const lw = (cell) => Math.max(0, ...run.labels.map((m) => (m.has(cell) ? textW(m.get(cell), fs, 700) : 0)));
    const rows = t0.indexes.map((ix0, i) => {
      const name = ix0.name;
      const base = `${id}/${name}`;
      const all = new Map();
      for (const v of V) for (const r of ixOf(v, id, name).recs) if (!all.has(r.data)) all.set(r.data, r.key);
      const recs = [...all].map(([data, key]) => ({ data, key })).sort((a, b) => cmpKey(a.key, b.key));
      const gapCell = (cell) => cell.startsWith(`${base}/`) && (cell.endsWith('/gap') || cell.endsWith('/sup'));
      const used = run.labels.some((m) => [...m.keys()].some(gapCell)) || V.some((v) => Object.values(v.th).some((s) => s.waitOn && gapCell(s.waitOn)));
      const showGaps = used || (FORCE_GAPS.includes(scene) && i === 0);
      let chips = 0;
      let chipW = 0;
      if (ix0.primary) {
        for (const v of V) {
          for (const r of ixOf(v, id, name).recs) {
            const vs = shownVers(r);
            chips = Math.max(chips, vs.length);
            for (const x of vs) chipW = Math.max(chipW, textW(x.text, fs, 600) + 12);
          }
        }
      }
      const cells = [];
      for (const r of recs) {
        if (showGaps) {
          const cid = `${base}/${r.data}/gap`;
          cells.push({ id: cid, kind: 'gap', rec: r.data, w: Math.ceil(Math.max(c ? 10 : 12, lw(cid)) + 2 * pad) });
        }
        const cid = `${base}/${r.data}`;
        cells.push({ id: cid, kind: 'rec', rec: r.data, w: Math.ceil(Math.max(textW(r.data, fs, 600), lw(cid), chipW) + 2 * pad) });
      }
      if (showGaps) {
        const cid = `${base}/sup`;
        cells.push({ id: cid, kind: 'sup', rec: null, w: Math.ceil(Math.max(textW(supWord(c), fs), lw(cid)) + 2 * pad) });
      }
      const label = ixLabel(t0, ix0);
      const cw = cells.reduce((sum, x) => sum + x.w, 0) + colGap * Math.max(0, cells.length - 1);
      return { name, primary: ix0.primary, base, cells, chips, h: 35 + chips * (CHIP_H + CHIP_GAP), label, labelW: textW(label, fs),
        w: Math.max(cw, textW('레코드 없음', fs) + 8), cw, showGaps };
    });
    const title = `${id} · InnoDB`;
    const w = Math.ceil(Math.max(...rows.map((r) => Math.max(r.w, r.labelW)), textW(title, fs) + 4, c ? 70 : 90) + 16);
    const h = 8 + rows.reduce((sum, r) => sum + 18 + r.h + 10, 0) + 16;
    return { id, kind: 'table', w, h, rows, colGap, pad, fs, title };
  }

  function objectList(c) { return tablesOf(run.views[0]).map((t) => tableShape(t.name, c)); }

  function placeObjects(g) {
    const list = g.list;
    const total = list.reduce((sum, b) => sum + b.w, 0) + g.gap * Math.max(0, list.length - 1);
    let x = (g.W - total) / 2;
    g.objs = {};
    g.rowOf = {};
    for (const b of list) {
      b.x = x;
      b.y = g.objTop;
      x += b.w + g.gap;
      g.objs[b.id] = b;
      let y = b.y + 8;
      for (const row of b.rows) {
        row.lblY = y + 12;
        row.y = y + 18;
        row.x0 = b.x + 8;
        let cx = row.x0;
        for (const cell of row.cells) {
          cell.x = cx;
          cx += cell.w + b.colGap;
          g.rowOf[cell.id] = { b, row, cell };
        }
        y = row.y + row.h + 10;
      }
    }
    g.H = g.objTop + Math.max(...list.map((b) => b.h)) + 8;
  }

  function drawThreadBoxes(svg, g) {
    const boxes = el('g', { class: 'thboxes' }, svg);
    threads().forEach((t, i) => {
      const b = g.thBox[i];
      el('rect', Object.assign({ class: 'thbox', x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, selAttrs(`th:${t.id}`, false)), boxes);
    });
  }

  // 세션 원과 글줄. 글줄은 줄마다 두 칸(tspan)을 두고, 상자에 들어가지 않는 줄만 두 줄로 쓴다.
  function drawThreads(svg, g) {
    const ths = el('g', { class: 'threads' }, svg);
    threads().forEach((t, i) => {
      const p = g.thPos[i];
      const node = el('g', Object.assign({ class: 'th', 'data-id': t.id }, selAttrs(`th:${t.id}`)), ths);
      el('circle', { cx: p.x, cy: p.cy, r: g.r }, node);
      el('text', { class: 'name', x: p.x, y: p.cy + 5, 'text-anchor': 'middle' }, node, circleText(t));
      for (const slot of g.slots) {
        const tx = el('text', { class: `slot ${slot}`, 'data-slot': slot, x: p.x, y: g.slotY[slot], 'text-anchor': 'middle' }, node);
        el('tspan', { class: 'a' }, tx, '');
        el('tspan', { class: 'b', x: p.x, dy: g.lh }, tx, '');
      }
    });
  }

  function objGroup(parent, sel, cls) { return el('g', Object.assign({ class: cls }, selAttrs(sel)), parent); }

  function drawObjects(svg, g) {
    const layer = el('g', { class: 'objs' }, svg);
    for (const b of Object.values(g.objs)) drawTable(layer, g, b);
  }

  // 표 상자: 이름은 아래쪽 왼편에 적는다. 인덱스마다 이름 줄과 칸 줄을 둔다(보조 인덱스가 위, PRIMARY가 아래).
  function drawTable(layer, g, b) {
    const n = objGroup(layer, `tb:${b.id}`, 'obj table');
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, n);
    el('text', { class: 'lbl', x: b.x + 8, y: b.y + b.h - 8 }, n, b.title);
    g.nodes[`tb:${b.id}`] = n;
    for (const row of b.rows) {
      const rg = objGroup(layer, `ix:${b.id}/${row.name}`, 'ixrow');
      el('rect', { x: row.x0 - 4, y: row.lblY - 14, width: Math.max(row.w, row.labelW) + 8, height: row.y + row.h - row.lblY + 18, rx: 5 }, rg);
      el('text', { class: 'empty-note', x: row.x0 + 4, y: row.y + 21 }, rg, '');
      g.nodes[`ix:${b.id}/${row.name}`] = rg;
      for (const c of row.cells) {
        const cn = objGroup(layer, `cell:${c.id}`, `cell ${c.kind}`);
        el('rect', { x: c.x, y: row.y, width: c.w, height: row.h, rx: 5 }, cn);
        if (c.kind !== 'gap') el('text', { class: 'head', x: c.x + c.w / 2, y: row.y + 13, 'text-anchor': 'middle' }, cn, c.kind === 'sup' ? supWord(g.compact) : c.rec);
        el('text', { class: 'lk', x: c.x + c.w / 2, y: row.y + 29, 'text-anchor': 'middle' }, cn, '');
        if (row.primary && c.kind === 'rec') {
          for (let i = 0; i < row.chips; i++) {
            const cy = row.y + 35 + i * (CHIP_H + CHIP_GAP);
            const chip = el('g', { class: 'ver', 'data-i': String(i) }, cn);
            el('rect', { x: c.x + b.pad, y: cy, width: c.w - 2 * b.pad, height: CHIP_H, rx: 4 }, chip);
            el('text', { class: 'vt', x: c.x + c.w / 2, y: cy + 14, 'text-anchor': 'middle' }, chip, '');
          }
        }
        g.nodes[c.id] = cn;
      }
    }
  }

  function renderThreads(v) {
    const svg = $('#board');
    for (const t of threads()) {
      const s = v.th[t.id];
      const node = svg.querySelector(`.th[data-id="${t.id}"]`);
      setCls(node, `th ${s.cls}${s.err ? ' has-err' : ''}`);
      for (const slot of geo.slots) {
        const tx = node.querySelector(`[data-slot="${slot}"]`);
        const text = slotText(slot, s);
        const [a, b] = geo.stack[slot] ? fitLines(text, geo.fs, slot === 'local' ? 600 : 400, geo.fit) : [text, ''];
        tx.querySelector('.a').textContent = a;
        tx.querySelector('.b').textContent = b;
        if (slot === 'local') tx.classList.toggle('err', !!s.err);
      }
    }
  }

  // 이 단계의 칸 자리. 없는 레코드의 칸과 그 앞 갭 칸은 숨기고, 다음에 보이는 갭 칸(또는 supremum 칸)이 그 자리까지 넓어진다.
  // 레코드가 들어오면 넓던 갭이 둘로 나뉘고, 레코드가 빠지면 두 갭이 하나로 합쳐진다.
  function cellBoxes(v) {
    const present = run.present[idx];
    const out = {};
    for (const b of Object.values(geo.objs)) {
      for (const row of b.rows) {
        let left = row.x0;
        let any = false;
        for (const c of row.cells) {
          const vis = c.kind === 'sup' || present.has(c.kind === 'gap' ? `${row.base}/${c.rec}` : c.id);
          if (!vis) { out[c.id] = { x: c.x, w: c.w, y: row.y, vis: false }; continue; }
          any = true;
          const x = c.kind === 'rec' ? c.x : Math.min(c.x, left);
          out[c.id] = { x, w: c.x + c.w - x, y: row.y, vis: true };
          left = c.x + c.w + b.colGap;
        }
        out[`row:${row.base}`] = { any };
      }
    }
    return out;
  }

  function renderObjects(v) {
    const labels = run.labels[idx];
    const boxes = cellBoxes(v);
    geo.boxes = boxes;
    const waited = new Set(Object.values(v.th).map((s) => s.waitOn).filter(Boolean));
    const flag = (on, c) => (on ? ` ${c}` : '');
    for (const b of Object.values(geo.objs)) {
      setCls(geo.nodes[`tb:${b.id}`], 'obj table');
      for (const row of b.rows) {
        const rg = geo.nodes[`ix:${b.id}/${row.name}`];
        setCls(rg, 'ixrow');
        rg.querySelector('.empty-note').textContent = boxes[`row:${row.base}`].any ? '' : '레코드 없음';
        for (const c of row.cells) {
          const cn = geo.nodes[c.id];
          const bx = boxes[c.id];
          const rect = cn.querySelector('rect');
          rect.setAttribute('x', bx.x);
          rect.setAttribute('width', bx.w);
          cn.querySelectorAll('.head, .lk').forEach((t) => t.setAttribute('x', bx.x + bx.w / 2));
          const lab = labels.get(c.id) || '';
          cn.querySelector('.lk').textContent = bx.vis ? lab : '';
          const rec = c.kind === 'rec' ? recOf(v, c.id) : null;
          setCls(cn, `cell ${c.kind}${flag(!bx.vis, 'gone')}${flag(bx.vis && lab, 'held')}${flag(bx.vis && waited.has(c.id), 'waited')}${flag(rec && rec.ins, 'ins')}${flag(rec && rec.del, 'del')}`);
          if (row.primary && c.kind === 'rec') {
            const vs = shownVers(rec);
            cn.querySelectorAll('.ver').forEach((chip) => {
              const ver = vs[+chip.dataset.i];
              if (!ver) { chip.setAttribute('class', 'ver none'); return; }
              chip.setAttribute('class', `ver${ver.state === 'active' ? ' active' : ''}${+chip.dataset.i > 0 ? ' old' : ''}`);
              chip.querySelector('.vt').textContent = ver.text;
            });
          }
        }
      }
    }
  }

  // 단계 끝의 기다림: 기다리는 세션에서 그 락의 칸으로. 이 단계에 기다림의 고리가 생겼으면(데드락) 고리를 이룬 기다림을 주황으로 그린다.
  // 탐지가 켜져 있으면 고리는 그 단계 안에서 1213으로 풀리므로, 되돌려진 쪽의 기다림은 그 단계의 주황 선으로만 남는다.
  function linksOf(v) {
    const out = [];
    const seen = new Set();
    const push = (l) => { const k = `${l.from}|${l.to}`; if (seen.has(k) || !geo.boxes[l.to] || !geo.boxes[l.to].vis) return; seen.add(k); out.push(l); };
    for (const c of v.cycle || []) if (c.to) push({ from: c.from, to: c.to, kind: 'wait cycle' });
    for (const [id, s] of Object.entries(v.th)) if (s.waitOn) push({ from: id, to: s.waitOn, kind: 'wait' });
    return out;
  }

  function renderLinks(v) {
    const g = geo;
    const layer = g.cnG;
    layer.innerHTML = '';
    const links = linksOf(v);
    const T = threads().length;
    // 끝점: 받는 칸의 위쪽 가장자리에서 세션 순서대로 자리를 정해 둔다. 단계마다 선 끝이 옮겨 다니지 않게 하려는 것이다.
    const ends = links.map((l) => {
      const a = g.boxes[l.to];
      const k = tIndex(l.from);
      const step = T > 1 ? Math.max(0, Math.min(12, (a.w - 12) / (T - 1))) : 0;
      return { l, x: a.x + a.w / 2 + (k - (T - 1) / 2) * step, y: a.y };
    });
    // 시작점: 세션 상자 아래 가장자리. 선이 여럿이면 끝점 순서대로 조금씩 떼어 놓는다.
    const byFrom = {};
    for (const e of ends) (byFrom[e.l.from] = byFrom[e.l.from] || []).push(e);
    for (const [tid, list] of Object.entries(byFrom)) {
      list.sort((a, b) => a.x - b.x);
      const p = g.thPos[tIndex(tid)];
      const spread = Math.min(10, (g.boxW - 16) / Math.max(1, list.length - 1));
      list.forEach((e, j) => {
        const sx = p.x + (j - (list.length - 1) / 2) * spread;
        el('path', { class: `cn ${e.l.kind}`, d: curve(sx, g.thB, e.x, e.y) }, layer);
      });
    }
  }

  // ---------- 커넥션 풀 그림 ----------
  // 위에 앱 프로세스(요청 50개의 점과 그 안의 커넥션 풀), 아래에 MySQL 서버의 연결 수를 둔다.

  function poolTitle(C) {
    return C.pool === 'null' ? '풀 없음 (NullPool)' : `커넥션 풀 · QueuePool (pool_size=${C.size}, max_overflow=0, pool_timeout=${C.timeout}초)`;
  }

  function layoutPool() {
    const avail = Math.floor($('#boardWrap').clientWidth) || 600;
    const compact = avail < 480;
    const W = Math.max(260, Math.min(680, avail));
    const m = compact ? 6 : 12;
    const fs = compact ? 11 : 12;
    const C = run.kase;
    // 상자 이름(.title)은 13px 굵은 글자다. 상자에 들어가지 않으면 여러 줄로 쓰고 줄 사이를 17px 둔다.
    const g = { W, compact, scroll: W > avail + 1, m, fs, lh: compact ? 14 : 15, tlh: 17 };
    const app = { x: m, y: 8, w: W - 2 * m };
    g.appTitle = wrapLines(`앱 프로세스 · 요청 ${M.POOL_REQUESTS}개 (스레드 ${M.POOL_REQUESTS}개가 같은 순간에 출발)`, 13, 600, app.w - 20);
    let y = app.y + 20 + (g.appTitle.length - 1) * g.tlh;
    g.stateY = y + 4 + g.lh;
    y = g.stateY + 10;
    const dr = compact ? 5 : 6;
    const dstep = dr * 2 + (compact ? 4 : 5);
    const fitN = Math.floor((app.w - 24) / dstep);
    const cols = fitN >= 25 ? 25 : fitN >= 10 ? 10 : Math.max(5, fitN);
    g.dots = Array.from({ length: M.POOL_REQUESTS }, (_, i) => ({ x: app.x + 12 + dr + (i % cols) * dstep, y: y + dr + Math.floor(i / cols) * dstep, r: dr }));
    y += Math.ceil(M.POOL_REQUESTS / cols) * dstep + 10;
    const pool = { x: app.x + 10, y, w: app.w - 20 };
    g.poolTitle = wrapLines(poolTitle(C), 13, 600, pool.w - 16);
    let py = pool.y + 18 + (g.poolTitle.length - 1) * g.tlh + 8;
    g.slots = [];
    if (C.size) {
      const sw = Math.ceil(textW(`요청 ${M.POOL_REQUESTS}`, fs, 600) + 14);
      const sh = compact ? 32 : 34;
      const per = Math.max(1, Math.floor((pool.w - 16 + 6) / (sw + 6)));
      for (let i = 0; i < C.size; i++) g.slots.push({ x: pool.x + 8 + (i % per) * (sw + 6), y: py + Math.floor(i / per) * (sh + 6), w: sw, h: sh });
      py += Math.ceil(C.size / per) * (sh + 6) + 2;
    } else {
      g.poolNote = wrapLines('요청마다 새 연결을 열고(TCP 연결, 핸드셰이크, 인증), 돌려줄 때 끊는다.', fs, 400, pool.w - 16);
      py += g.lh * g.poolNote.length + 4;
    }
    pool.h = py - pool.y + 4;
    app.h = pool.y + pool.h + 10 - app.y;
    const dbw = Math.min(app.w, Math.ceil(Math.max(textW('새로 만든 연결 50 · 동시 최대 50 (모형)', fs, 600), 200) + 24));
    const db = { x: (W - dbw) / 2, y: app.y + app.h + 44, w: dbw, h: 74 };
    Object.assign(g, { app, pool, db, H: db.y + db.h + 8 });
    return g;
  }

  function drawPool(svg, g) {
    const defs = el('defs', {}, svg);
    const mk = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M0 0L10 5L0 10z' }, mk);
    const C = run.kase;
    const app = objGroup(svg, 'pool:app', 'obj pool-app');
    el('rect', { x: g.app.x, y: g.app.y, width: g.app.w, height: g.app.h, rx: 10 }, app);
    g.appTitle.forEach((t, i) => el('text', { class: 'title', x: g.app.x + 10, y: g.app.y + 20 + i * g.tlh }, app, t));
    el('text', { class: 'lbl state-line', x: g.app.x + 10, y: g.stateY }, app, '');
    g.nodes.dots = g.dots.map((d, i) => {
      const c = el('circle', { class: 'dot new', cx: d.x, cy: d.y, r: d.r }, app);
      el('title', {}, c, `요청 ${i + 1}`);
      return c;
    });
    g.nodes.app = app;
    const pool = objGroup(svg, 'pool:pool', 'obj pool-box');
    el('rect', { x: g.pool.x, y: g.pool.y, width: g.pool.w, height: g.pool.h, rx: 8 }, pool);
    g.poolTitle.forEach((t, i) => el('text', { class: 'title', x: g.pool.x + 8, y: g.pool.y + 18 + i * g.tlh }, pool, t));
    g.nodes.slots = g.slots.map((s, i) => {
      const sg = el('g', { class: 'slotc' }, pool);
      el('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: 5 }, sg);
      el('text', { class: 'sub', x: s.x + s.w / 2, y: s.y + (g.compact ? 12 : 13), 'text-anchor': 'middle' }, sg, `연결 ${i + 1}`);
      el('text', { class: 'who', x: s.x + s.w / 2, y: s.y + (g.compact ? 28 : 29), 'text-anchor': 'middle' }, sg, '');
      return sg;
    });
    if (g.poolNote) {
      const ny = g.pool.y + 18 + (g.poolTitle.length - 1) * g.tlh + 8 + g.lh - 4;
      g.poolNote.forEach((t, i) => el('text', { class: 'lbl', x: g.pool.x + 8, y: ny + i * g.lh }, pool, t));
    }
    g.nodes.pool = pool;
    const ax = g.W / 2;
    g.nodes.flow = el('path', { class: 'flow', d: `M${ax} ${g.app.y + g.app.h + 4}L${ax} ${g.db.y - 4}` }, svg);
    el('text', { class: 'lbl', x: ax + 8, y: g.app.y + g.app.h + 26 }, svg, C.pool === 'null' ? '요청마다 새 연결' : `연결 ${C.size}개로 쿼리`);
    const db = objGroup(svg, 'pool:db', 'obj pool-db');
    el('rect', { x: g.db.x, y: g.db.y, width: g.db.w, height: g.db.h, rx: 10 }, db);
    el('text', { class: 'title', x: g.db.x + 12, y: g.db.y + 20 }, db, 'MySQL 서버 · 열린 연결');
    el('text', { class: 'big', x: g.db.x + 12, y: g.db.y + 46 }, db, '');
    el('text', { class: 'lbl db-sub', x: g.db.x + 12, y: g.db.y + 64 }, db, '');
    g.nodes.db = db;
  }

  function poolCounts(v) {
    const c = { new: 0, wait: 0, connect: 0, use: 0, done: 0, timeout: 0 };
    for (const r of v.reqs) c[r.state] += 1;
    return c;
  }

  function renderPool(v) {
    const g = geo;
    const c = poolCounts(v);
    setCls(g.nodes.app, `obj pool-app${c.timeout ? ' bad' : ''}`);
    g.nodes.app.querySelector('.state-line').textContent = `쓰는 중 ${c.use} · 기다림 ${c.wait + c.connect} · 끝 ${c.done} · 타임아웃 ${c.timeout}`;
    v.reqs.forEach((r, i) => {
      const d = g.nodes.dots[i];
      d.setAttribute('class', `dot ${r.state}`);
      d.querySelector('title').textContent = `요청 ${r.id} · ${POOL_STATE[r.state]}${r.slot ? ` · 연결 ${r.slot}` : ''}`;
    });
    setCls(g.nodes.pool, 'obj pool-box');
    v.slots.forEach((s, i) => {
      const sg = g.nodes.slots[i];
      sg.setAttribute('class', `slotc${s.holder ? ' busy' : ''}`);
      sg.querySelector('.who').textContent = s.holder ? `요청 ${s.holder}` : '쉼';
    });
    g.nodes.flow.setAttribute('class', `flow${c.use ? ' on' : ''}`);
    setCls(g.nodes.db, 'obj pool-db');
    g.nodes.db.querySelector('.big').textContent = String(v.db.open);
    g.nodes.db.querySelector('.db-sub').textContent = `새로 만든 연결 ${v.db.created} · 동시 최대 ${v.db.peak} (모형)`;
  }

  // ---------- 전체 지도 ----------
  // 모든 요소를 담는 관계(앱 프로세스 ⊃ 요청·커넥션 풀, MySQL 서버 ⊃ 연결·트랜잭션·락·인덱스)만 그린다.
  // 단계와 상관없이 그대로이고, 장면과 구성을 바꾸면 그 구성이 쓰는 부분만 진하게 바꾼다.

  const MAP_APP = [['req', '요청'], ['pool', '커넥션 풀']];
  const MAP_DB = [['session', '연결·세션'], ['trx', '트랜잭션'], ['snap', '스냅숏'], ['rec', '레코드 락'], ['gap', '갭·넥스트 키 락'], ['ii', '삽입 의도 락'],
    ['detect', '데드락 탐지'], ['timeout', '락 대기 한도'], ['primary', '클러스터형 인덱스 (PRIMARY)'], ['secondary', '보조 인덱스'], ['unique', '유니크 제약']];
  const PART_NAMES = Object.fromEntries([...MAP_APP, ...MAP_DB]);

  function buildMap() {
    const avail = Math.floor($('#mapWrap').clientWidth) || 460;
    const W = Math.max(260, Math.min(460, avail));
    const svg = $('#map');
    svg.innerHTML = '';
    const left = 14;
    const right = W - 14;
    const flow = (list, top) => {
      let x = left;
      let y = top;
      for (const [name, text] of list) {
        const w = Math.ceil(textW(text, 11)) + 14;
        if (x > left && x + w > right) { x = left; y += 28; }
        const o = el('g', { class: 'part', 'data-part': name }, svg);
        el('rect', { x, y, width: w, height: 22, rx: 5 }, o);
        el('text', { x: x + w / 2, y: y + 15, 'text-anchor': 'middle' }, o, text);
        x += w + 8;
      }
      return y + 22;
    };
    const appB = flow(MAP_APP, 12) + 22;
    el('rect', { class: 'box', x: 4, y: 4, width: W - 8, height: appB - 4, rx: 10 }, svg);
    svg.insertBefore(svg.lastChild, svg.firstChild);
    el('text', { class: 'lbl', x: 14, y: appB - 7 }, svg, '앱 프로세스 (웹 서버 · SQLAlchemy)');
    const dbTop = appB + 10;
    const dbB = flow(MAP_DB, dbTop + 8) + 22;
    el('rect', { class: 'box', x: 4, y: dbTop, width: W - 8, height: dbB - dbTop, rx: 10 }, svg);
    svg.insertBefore(svg.lastChild, svg.firstChild);
    el('text', { class: 'lbl', x: 14, y: dbB - 7 }, svg, 'MySQL 서버 (mysqld · InnoDB)');
    svg.setAttribute('viewBox', `0 0 ${W} ${dbB + 4}`);
    svg.style.maxWidth = `${W}px`;
  }

  // 이 구성이 쓰는 지도 부분. 장면에 그린 요소와 같다.
  function partsFor() {
    if (isPool()) return run.kase.pool === 'null' ? ['req', 'session'] : ['req', 'pool', 'session'];
    const V = run.views;
    const out = ['session', 'trx', 'primary'];
    if (isBurst()) out.push('req');
    const locks = V.flatMap((v) => v.dataLocks);
    if (V.some((v) => Object.values(v.th).some((s) => s.snapAt))) out.push('snap');
    if (locks.some((l) => l.kind === 'REC' || (l.kind === 'NK' && l.data !== SUP))) out.push('rec');
    if (locks.some((l) => l.kind === 'GAP' || (l.kind === 'NK'))) out.push('gap');
    if (locks.some((l) => l.kind === 'II')) out.push('ii');
    if (run.deadlocks && run.deadlocks.length) out.push('detect');
    if (V.some((v) => v.ev.some((e) => e.type === 'error' && /1205/.test(e.text)))) out.push('timeout');
    const ixs = tablesOf(V[0]).flatMap((t) => t.indexes);
    if (ixs.some((x) => !x.primary)) out.push('secondary');
    if (ixs.some((x) => !x.primary && x.unique)) out.push('unique');
    return out;
  }

  function renderMap() {
    const on = new Set(partsFor());
    $('#map').querySelectorAll('.part').forEach((p) => p.classList.toggle('on', on.has(p.dataset.part)));
    const used = [...on].map((p) => PART_NAMES[p]);
    $('#map').setAttribute('aria-label', '전체 지도. 앱 프로세스 안에 요청과 커넥션 풀이 있고, 그 아래 MySQL 서버 안에 연결·세션, 트랜잭션, 스냅숏, 레코드 락, 갭·넥스트 키 락, '
      + `삽입 의도 락, 데드락 탐지, 락 대기 한도, 클러스터형 인덱스, 보조 인덱스, 유니크 제약이 있다. 이 구성에 나오는 부분: ${used.join(', ')}.`);
  }

  function ixWord(t) { return t.indexes.map((x) => (x.primary ? 'PRIMARY' : `${x.name}${x.unique ? ' (UNIQUE)' : ''}`)).join(', '); }

  function renderCounts() {
    const items = [];
    if (isPool()) {
      const C = run.kase;
      items.push(['요청', `${M.POOL_REQUESTS}개 (같은 순간에 출발)`], ['풀', C.pool === 'null' ? 'NullPool (풀 없음)' : 'QueuePool']);
      if (C.pool !== 'null') items.push(['pool_size', String(C.size)], ['max_overflow', '0'], ['pool_timeout', `${C.timeout}초`]);
      items.push(['연결을 쓰는 시간', '0.2초 (트랜잭션 안)']);
    } else if (isBurst()) {
      items.push(['요청', `${cfg.n}개 (실험 10개)`], ['격리 수준', M.LEVEL_NAME[run.level]]);
      if (run.way) items.push(['막는 방법', run.way.label], ['다시 시도', run.way.retries ? `${run.way.retries}번까지` : '없음']);
      items.push(['표', tablesOf(run.views[0]).map((t) => `${t.name} (${ixWord(t)})`).join(', ')], ['데드락 탐지', '켬 (ON)'], ['락 대기 한도', '5초']);
    } else {
      items.push(['세션', `${threads().length}개 (${threads().map((t) => t.id).join(', ')})`], ['격리 수준', M.LEVEL_NAME[run.level]],
        ['데드락 탐지', run.detect === 'ON' ? '켬 (ON)' : '끔 (OFF)'], ['락 대기 한도', '5초'],
        ['표', tablesOf(run.views[0]).map((t) => `${t.name} (${ixWord(t)})`).join(', ')], ['순서표 줄', `${run.steps.length}줄`]);
    }
    $('#counts').innerHTML = items.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('');
  }

  // ---------- 화면 낭독기용 요약 ----------

  function objSummary(v) {
    if (isPool()) {
      const c = poolCounts(v);
      return `연결을 쓰는 요청 ${c.use}개, 기다리는 요청 ${c.wait + c.connect}개, 끝난 요청 ${c.done}개, 풀 타임아웃 ${c.timeout}개. MySQL에 열린 연결 ${v.db.open}개.`;
    }
    const parts = [];
    for (const t of tablesOf(v)) {
      const ixs = t.indexes.map((x) => `${x.name} 레코드 ${x.recs.length ? x.recs.map((r) => recName(x.name, r.data)).join(', ') : '없음'}`);
      parts.push(`${t.name} 표: ${ixs.join('; ')}.`);
    }
    const locks = v.dataLocks.filter((r) => r.type !== 'TABLE').map((r) => `${who(r.session)} ${lockLine(r)}${r.status === 'WAITING' ? ' 기다림' : ''}`);
    parts.push(`락: ${locks.length ? locks.join('; ') : '없음'}.`);
    return parts.join(' ');
  }

  function describe(v) {
    const parts = [`단계 ${v.label}${isPool() ? ` (${v.phase})` : ''}.`];
    if (!isPool()) {
      if (v.actors.length) parts.push(`실행: ${v.actors.map((id) => threadTitle(thread(id))).join(', ')}.`);
      const rest = threads().filter((t) => !v.actors.includes(t.id)).map((t) => `${threadTitle(t)} ${stateText(v.th[t.id])}`);
      if (rest.length) parts.push(`${rest.join(', ')}.`);
    }
    parts.push(`단계 끝: ${objSummary(v)}`);
    return parts.join(' ');
  }

  // ---------- 설명 한 문장 ----------

  function mainEvent(v) {
    for (const type of BAD_ORDER) {
      const e = v.ev.find((x) => x.type === type && x.bad);
      if (e) return e;
    }
    return v.ev[0] || null;
  }

  function rowsText(rows) {
    if (rows == null) return '';
    if (!rows.length) return '없음';
    if (rows.every((r) => r.length === 1)) return rows.map((r) => r[0]).join(', ');
    return rows.map((r) => `(${r.join(', ')})`).join(', ');
  }
  function finalText(spec, rows) { return `${spec.name} (${spec.cols.join(', ')}) = ${rows.length ? rows.map((r) => `(${r.join(', ')})`).join(', ') : '행 없음'}`; }

  // 마지막 단계에 붙이는 결과. 순서표 장면은 읽은 값, 기다린 문장, 오류, 끝난 뒤 표를 원자료와 같은 모양으로 모은다.
  function resultText() {
    const anyBad = run.views.some((v) => v.ev.some((e) => e.bad));
    if (isPool()) {
      const s = run.summary;
      if (run.kase.pool === 'null') return { bad: false, text: `결과: 성공 ${s.ok}, 풀 타임아웃 ${s.timeout}. 새로 만든 연결 ${s.created}개, 동시 최대 ${s.peak}개(모형). 다 끝나는 시각은 새 연결을 여는 시간 c에 0.2초를 더한 것이다.` };
      return { bad: s.timeout > 0, text: `결과: 성공 ${s.ok}, 풀 타임아웃 ${s.timeout}. 다 끝난 시각 ${s.endMs / 1000}초, 가장 오래 기다린 요청이 연결을 받은 시각 ${s.waitMaxMs / 1000}초(모형).` };
    }
    if (isBurst()) {
      const s = run.summary;
      const res = Object.entries(s.results).map(([k, n]) => `${RESULT_WORD[k]} ${n}`).join(', ');
      const errs = Object.entries(s.errors).map(([c, n]) => `${c} ×${n}`).join(', ');
      const tail = scene === 'deduct' ? `잔액 ${s.balance}(다 반영되었다면 ${1000 - 100 * cfg.n})` : `rewards ${s.rewards}행, 잔액 ${s.balance}, version ${s.version}`;
      return { bad: anyBad, text: `결과: 요청 ${cfg.n}개 중 ${res}. 오류 ${errs || '없음'}. 다시 시도 ${s.retries}번. 끝난 뒤 ${tail}.` };
    }
    const reads = run.records.filter((x) => x.rows != null).map((x) => `${x.step}번 ${x.session} ${rowsText(x.rows)}`);
    const waits = run.records.filter((x) => x.blocked).map((x) => `${x.step}번 ${x.session}`);
    const errs = run.records.filter((x) => x.error).map((x) => `${x.step}번 ${x.session} ${x.error.code}`);
    const deferred = run.records.filter((x) => x.deferred).map((x) => `${x.step}번 ${x.session}`);
    const parts = [];
    if (reads.length) parts.push(`읽은 값 ${reads.join(' · ')}.`);
    parts.push(`기다린 문장 ${waits.join(', ') || '없음'}.`);
    if (deferred.length) parts.push(`미룬 문장 ${deferred.join(', ')}.`);
    parts.push(`오류 ${errs.join(', ') || '없음'}.`);
    if (run.deadlocks.length) parts.push(`데드락 ${run.deadlocks.length}번, 되돌린 쪽 ${run.deadlocks.map((d) => d.victim).join(', ')}.`);
    parts.push(`끝난 뒤 ${finalText(run.specs[0], run.final)}.`);
    return { bad: anyBad, text: `결과: ${parts.join(' ')}` };
  }

  function renderCaption(v) {
    const main = mainEvent(v);
    const rest = v.ev.filter((e) => e !== main);
    const text = main ? main.text : '';
    let html = `<span${main && main.bad ? ' class="bad"' : ''}>${esc(text)}</span>`;
    if (idx === lastIdx()) {
      const r = resultText();
      html += `<span class="result${r.bad ? ' bad' : ''}">${esc(r.text)}</span>`;
    }
    $('#caption').innerHTML = html;
    const more = $('#more');
    more.hidden = rest.length === 0;
    more.querySelector('summary').textContent = `이 단계의 다른 일 ${rest.length}개`;
    more.querySelector('ul').innerHTML = rest.map((e) => `<li${e.bad ? ' class="bad"' : ''}>${esc(e.text)}</li>`).join('');
    $('#live').textContent = `단계 ${v.label}. ${text}`;
  }

  // ---------- performance_schema.data_locks ----------
  // 모형이 단계 끝에 만든 락 목록을 data_locks처럼 적는다. 앞 단계에 없던 줄은 옅은 파랑, 기다리는 줄은 굵게 적는다.

  function lockSig(r) { return `${r.session}|${r.table}|${r.index}|${r.mode}|${r.status}|${r.data}`; }
  function renderLocks(v) {
    const box = $('#locksBox');
    if (isPool()) { box.hidden = true; return; }
    box.hidden = false;
    const prev = idx > 0 ? run.views[idx - 1] : null;
    const before = new Set(prev ? prev.dataLocks.map(lockSig) : v.dataLocks.map(lockSig));
    const td = (s) => `<td><code>${esc(s)}</code></td>`;
    $('#locks tbody').innerHTML = v.dataLocks.length ? v.dataLocks.map((r) => {
      const cls = [before.has(lockSig(r)) ? '' : 'new', r.status === 'WAITING' ? 'waiting' : ''].filter(Boolean).join(' ');
      return `<tr${cls ? ` class="${cls}"` : ''}><td>${esc(who(r.session))}</td>${td(r.table)}${td(r.index || 'NULL')}<td>${r.type}</td>${td(r.mode)}<td class="st">${r.status}</td>${td(r.data == null ? 'NULL' : r.data)}</tr>`;
    }).join('') : '<tr><td colspan="7" class="none">락 없음</td></tr>';
    $('#waits').innerHTML = v.waits.length
      ? v.waits.map((w) => `<li>${esc(josa(who(w.waiting), ['이', '가']))} 기다리는 <code>${esc(w.waiting_lock)}</code> ← ${esc(who(w.blocking))}의 <code>${esc(w.blocking_lock)}</code></li>`).join('')
      : '<li class="none">기다림 없음</li>';
  }

  // ---------- 코드 ----------
  // 줄마다 그 줄을 가리키는 키(on)를 둔다. 키는 model.js가 세션마다 적는 줄 이름이다(순서표 sN, 동시 요청 start·count·insert 등).

  function L(t, on) { return { t, on: on || [] }; }

  function setupLines(sessions) {
    const lines = [L('-- 준비')];
    for (const spec of run.specs) for (const s of spec.sql) lines.push(L(`${s};`));
    lines.push(L(`-- 관찰용 연결: SET GLOBAL innodb_deadlock_detect = ${run.detect || 'ON'};`));
    lines.push(L(`-- ${sessions}: SET SESSION innodb_lock_wait_timeout = 5;`));
    lines.push(L(`-- ${sessions}: SET SESSION TRANSACTION ISOLATION LEVEL ${M.LEVEL_NAME[run.level]};`));
    lines.push(L(''));
    return lines;
  }

  function timelineCode() {
    const lines = setupLines('A, B');
    for (const s of run.steps) lines.push(L(`${s.s}: ${s.sql};${s.note ? `  -- ${s.note}` : ''}`, [s.key]));
    const delay = scene === 'transfer' ? ' 문제의 4번은 3번을 보내고 2초 뒤에 보냈다.' : '';
    return { sig: `${run.timeline}|${run.level}|${run.detect}`, lines,
      note: `lock_timelines.py의 순서표 ${run.timeline}과 같은 SQL, 같은 순서다. 줄 앞의 A:, B:는 그 문장을 보내는 세션이고, 줄 끝 주석의 번호는 문제 상황의 번호다. 실험은 줄 하나를 보내고 0.5초 안에 끝나지 않으면 기다림으로 적고 다음 줄로 갔다.${delay}` };
  }

  function burstCode() {
    const lines = setupLines('요청마다');
    lines.push(L(`-- 요청 ${cfg.n}개가 같은 순간에 출발해, 요청마다 연결 하나로 아래를 실행한다`));
    lines.push(L('START TRANSACTION;', ['start']));
    if (scene === 'deduct') {
      lines.push(L('SELECT balance FROM points WHERE user_id = 7;  -- 읽은 값을 balance로', ['read']));
      lines.push(L('-- 앱: balance - 100을 계산하며 50ms 일한다', ['pause']));
      lines.push(L('UPDATE points SET balance = <balance - 100> WHERE user_id = 7;', ['write']));
      lines.push(L('COMMIT;', ['commit']));
      lines.push(L('-- DB 오류를 받으면: ROLLBACK; 요청은 실패로 끝나고 다시 하지 않는다', ['err']));
      return { sig: `deduct|${cfg.level}|${cfg.n}`, lines, note: 'burst_lab.py의 deduct와 같은 SQL이다. <> 안은 앱이 앞 문장의 결과로 채우는 값이다. 모형은 한 단계에 요청마다 문장을 하나씩 요청 번호 순으로 보낸다.' };
    }
    const o = run.way.o;
    if (o.parentLock) lines.push(L(`${M.LOCK_POINTS};`, ['lockp']));
    if (o.version) lines.push(L('SELECT version FROM points WHERE user_id = 7;  -- 읽은 값을 v로', ['ver']));
    lines.push(L(`${M.COUNT}${o.countLock ? ' FOR UPDATE' : ''};`, ['count']));
    if (o.lockAfterCount) lines.push(L(`${M.LOCK_POINTS};`, ['lockac']));
    lines.push(L('-- COUNT가 0이 아니면: ROLLBACK; "이미 받음"으로 끝낸다', ['already']));
    lines.push(L('-- 앱: 50ms 일한다', ['pause']));
    lines.push(L(`${M.INSERT_REWARD};`, ['insert']));
    if (o.unique) lines.push(L('-- INSERT가 1062(중복 키)면: ROLLBACK; "이미 받음"으로 끝낸다', ['dup']));
    if (o.version) {
      lines.push(L('UPDATE points SET version = version + 1 WHERE user_id = 7 AND version = <v>;', ['bump']));
      lines.push(L('-- 바꾼 행이 0이면: ROLLBACK; 처음부터 다시 한다(최대 3번)', ['conflict']));
    }
    if (o.zero) {
      lines.push(L(`${M.PAY_IF_ZERO};`, ['payz']));
      if (o.zero === 'first') lines.push(L('-- 바꾼 행 수를 보지 않고 COMMIT한다'));
      else {
        lines.push(L('-- 바꾼 행이 0이면: ROLLBACK; 다시 하지 않는다', ['conflict']));
        lines.push(L(`${M.VERSION_UP};`, ['vup']));
      }
    } else lines.push(L(`${M.PAY};`, ['pay']));
    lines.push(L('COMMIT;', ['commit']));
    lines.push(L('-- DB 오류(1213, 1205 등)를 받으면: ROLLBACK; 요청은 실패로 끝나고 다시 하지 않는다', ['err']));
    return { sig: `reward|${cfg.way}|${cfg.n}`, lines, note: `burst_lab.py의 ${run.way.scene}과 같은 SQL이다. <> 안은 앱이 앞 문장의 결과로 채우는 값이다. 모형은 한 단계에 요청마다 문장을 하나씩 요청 번호 순으로 보내고, 앱이 50ms 일하는 것도 한 단계로 센다.` };
  }

  function poolCode() {
    const C = run.kase;
    const lines = [L('# pool_lab.py에서 요청 하나가 하는 일')];
    if (C.pool === 'null') {
      lines.push(L('engine = create_engine(url, poolclass=NullPool)'));
      lines.push(L('warm(engine, 1)  # 엔진의 첫 연결 초기화만 미리 끝낸다'));
    } else {
      lines.push(L(`engine = create_engine(url, poolclass=QueuePool, pool_size=${C.size}, max_overflow=0, pool_timeout=${C.timeout})`));
      lines.push(L(`warm(engine, ${C.size})  # 연결 ${C.size}개를 미리 만들어 풀에 둔다`));
    }
    lines.push(L(''));
    lines.push(L(`def worker(index):  # 스레드 ${M.POOL_REQUESTS}개가 하나씩 맡는다`));
    lines.push(L('    barrier.wait()  # 모두 같은 순간에 출발'));
    lines.push(L('    try:'));
    lines.push(L(C.pool === 'null' ? '        with engine.connect() as connection:  # 새 연결을 연다' : '        with engine.connect() as connection:  # 풀에서 연결을 빌린다(없으면 기다린다)', ['connect']));
    lines.push(L('            with connection.begin():', ['begin']));
    lines.push(L('                connection.execute(text("SELECT 1"))', ['exec']));
    lines.push(L('                sleep(0.2)  # 트랜잭션 안에서 200ms', ['sleep']));
    lines.push(L(C.pool === 'null' ? '        # with를 나오며 커밋하고 연결을 끊는다' : '        # with를 나오며 커밋하고 연결을 풀에 돌려준다', ['back']));
    lines.push(L('    except exc.TimeoutError:  # pool_timeout을 넘게 기다림', ['timeout']));
    lines.push(L('        ...  # 풀 타임아웃으로 센다'));
    return { sig: `pool|${cfg.pool}`, lines, note: 'pool_lab.py의 burst()를 줄여 옮겼다. 실험은 요청마다 연결을 기다린 시간과 다 끝난 시간을 재는 줄이 더 있다. 이름표의 숫자는 그 줄에 있는 요청 수다.' };
  }

  function codeFor() {
    if (isPool()) return poolCode();
    if (isBurst()) return burstCode();
    return timelineCode();
  }

  function linesOfKey(key) { return code.lines.map((ln, i) => (ln.on.includes(key) ? i : -1)).filter((i) => i >= 0); }
  function lastLine(key) { const ls = linesOfKey(key); return ls.length ? ls[ls.length - 1] : -1; }
  function firstLine(key) { const ls = linesOfKey(key); return ls.length ? ls[0] : -1; }

  // 코드 줄에 붙일 이름표: 실행한 세션은 이 단계에 실행한 마지막 줄에 채운 이름표를, 나머지는 다음에 실행할 줄(at)에 상태 이름표를 단다.
  function chipsFor(v) {
    const out = [];
    if (isPool()) {
      const c = poolCounts(v);
      const add = (key, n, cls, tip) => { if (n) out.push({ line: firstLine(key), label: String(n), cls, ran: cls.startsWith('run'), tip }); };
      add('connect', c.wait + c.connect, 'event', `${run.kase.pool === 'null' ? '새 연결을 여는' : '연결을 기다리는'} 요청 ${c.wait + c.connect}개`);
      add('sleep', c.use, 'run', `연결을 쓰는 요청 ${c.use}개`);
      add('back', c.done, 'done', `끝난 요청 ${c.done}개`);
      add('timeout', c.timeout, 'run bad', `풀 타임아웃으로 끝난 요청 ${c.timeout}개`);
      return out;
    }
    for (const t of threads()) {
      const s = v.th[t.id];
      if (s.cls === 'done') continue;
      if (s.cls === 'run' && s.lines.length) {
        const key = s.lines[s.lines.length - 1];
        out.push({ line: lastLine(key), label: circleText(t), cls: `run${s.err ? ' bad' : ''}`, ran: true, tip: `${threadTitle(t)} · 이 단계에 실행함${s.err ? ` · ${s.err}` : ''}` });
      } else if (s.at) {
        out.push({ line: firstLine(s.at), label: circleText(t), cls: s.cls === 'run' ? 'turn' : s.cls, ran: false, tip: `${threadTitle(t)} · ${stateText(s)} · 다음에 실행할 줄` });
      }
    }
    return out;
  }

  const POOL_RAN = { checkout: ['connect', 'begin', 'exec', 'sleep'], connect: ['connect'], use: ['begin', 'exec', 'sleep'], return: ['back'], done: ['back'], timeout: ['timeout'] };

  function renderCode(v) {
    const ol = $('#code');
    const fresh = codeFor();
    const sig = `${scene}|${fresh.sig}`;
    if (codeSig !== sig) {
      codeSig = sig;
      code = fresh;
      ol.innerHTML = code.lines.map((ln, i) => `<li data-line="${i}"><span class="marks"></span><span class="ln">${i + 1}</span><code>${esc(ln.t) || ' '}</code></li>`).join('');
      $('#codeNote').textContent = code.note;
    }
    const ran = new Set();
    if (isPool()) {
      for (const e of v.ev) for (const k of POOL_RAN[e.type] || []) linesOfKey(k).forEach((i) => ran.add(i));
    } else {
      for (const id of v.actors) for (const k of v.th[id].lines) linesOfKey(k).forEach((i) => ran.add(i));
    }
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
      // 한 줄에 이름표는 둘까지만 둔다. 실행한 세션을 먼저 두고 나머지는 수로 적는다.
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

  // 이 단계에 그 세션이 끝낸 읽기의 결과(없으면 빈칸). 끝 단계(꼬리)에 끝난 문장은 원자료처럼 순서표 마지막 줄 번호로 기록되어 있다.
  function readAt(k, sess) {
    const v = run.views[k];
    const keys = v.th[sess].lines;
    const rec = run.records.filter((x) => x.session === sess && keys.includes(`s${x.step}`) && x.rows != null && x.finished_after_step === Math.min(k, run.steps.length));
    return rec.length ? rec[rec.length - 1] : null;
  }
  function committed(v, t) { return v.obj[t] ? v.obj[t].committed : []; }
  function rewardCount(v) { return committed(v, 'rewards').filter((r) => r[1] === 7 && r[2] === 1).length; }
  function badAt(v, types) { return v.ev.some((e) => e.bad && types.includes(e.type)); }

  // 장면마다 값 줄: 그 단계가 끝난 뒤의 값이다(관계도의 상자와 같은 시점).
  function valueRows() {
    const rows = [];
    const V = run.views;
    const row = (label, fn) => {
      const cells = [];
      for (let k = 1; k < V.length; k++) cells.push(fn(V[k], V[k - 1], k));
      rows.push({ label, cells });
    };
    const val = (v, a, b, tip, bad) => ({ text: String(a), cls: `val${a !== b ? ' changed' : ''}${bad ? ' bad' : ''}`, tip: `단계 ${v.label}: ${tip}` });
    if (isPool()) {
      const tText = (t) => (t == null ? '' : typeof t === 'number' ? String(t / 1000) : t.replace('+200', '+0.2'));
      row('시각(초)', (v) => ({ text: tText(v.t), cls: 'val', tip: `단계 ${v.label}: 모형의 시각 ${tText(v.t)}초 (${v.phase})` }));
      const cnt = (label, key, bad) => row(label, (v, p) => {
        const a = key === 'wait' ? poolCounts(v).wait + poolCounts(v).connect : poolCounts(v)[key];
        const b = key === 'wait' ? poolCounts(p).wait + poolCounts(p).connect : poolCounts(p)[key];
        return val(v, a, b, `${label} ${a}개`, bad && a > 0);
      });
      cnt('쓰는 요청', 'use');
      cnt('기다리는 요청', 'wait');
      cnt('끝난 요청', 'done');
      cnt('타임아웃', 'timeout', true);
      row('열린 연결', (v, p) => val(v, v.db.open, p.db.open, `MySQL에 열린 연결 ${v.db.open}개`));
      return rows;
    }
    if (scene === 'gap' || scene === 'noidx') {
      row('커밋된 행 수', (v, p) => val(v, committed(v, 'entries').length, committed(p, 'entries').length, `entries에 커밋된 행 ${committed(v, 'entries').length}개`));
    } else if (scene === 'serial') {
      row('A가 읽은 id', (v, p, k) => {
        const rec = readAt(k, 'A');
        if (!rec) return { text: '', cls: 'val', tip: `단계 ${v.label}: A가 끝낸 읽기 없음` };
        const ids = rec.rows.map((r) => r[0]).join(',');
        return { text: ids, cls: 'val changed', tip: `단계 ${v.label}: A의 ${rec.step}번 줄 결과 id ${ids}` };
      });
    } else if (scene === 'transfer') {
      const bal = (v, id) => { const r = committed(v, 'accounts').find((x) => x[0] === id); return r ? r[1] : ''; };
      row('계좌 1', (v, p) => val(v, bal(v, 1), bal(p, 1), `커밋된 id 1 잔액 ${bal(v, 1)}`));
      row('계좌 2', (v, p) => val(v, bal(v, 2), bal(p, 2), `커밋된 id 2 잔액 ${bal(v, 2)}`));
      row('두 계좌 합', (v, p) => { const a = bal(v, 1) + bal(v, 2); return val(v, a, bal(p, 1) + bal(p, 2), `커밋된 두 잔액의 합 ${a}`, a !== 2000); });
    } else if (scene === 'pair') {
      row('rewards 행 수', (v, p) => val(v, committed(v, 'rewards').length, committed(p, 'rewards').length, `rewards에 커밋된 행 ${committed(v, 'rewards').length}개`));
    } else if (scene === 'deduct') {
      const b = (v) => committed(v, 'points')[0][1];
      row('잔액', (v, p) => val(v, b(v), b(p), `커밋된 잔액 ${b(v)}`, badAt(v, ['lost'])));
    } else {
      const pt = (v, i) => committed(v, 'points')[0][i];
      row('지급 행', (v, p) => val(v, rewardCount(v), rewardCount(p), `커밋된 rewards 행(user 7, event 1) ${rewardCount(v)}개`, badAt(v, ['dup', 'none'])));
      row('잔액', (v, p) => val(v, pt(v, 1), pt(p, 1), `커밋된 잔액 ${pt(v, 1)}`));
      row('version', (v, p) => val(v, pt(v, 2), pt(p, 2), `커밋된 version ${pt(v, 2)}`));
    }
    return rows;
  }

  const STRIP_NOTE = {
    timeline: '칸 글자: 시 트랜잭션 시작 · 읽 락 없이 읽기 · 잠 잠그며 읽기 · 쓰 쓰기 · 기 락을 기다리기 시작 · 확 커밋 · 되 ROLLBACK · ! 오류. 점선 칸은 락을 기다리는 단계, 주황 칸은 오류가 난 단계다. 값 줄은 그 단계가 끝난 뒤의 값이다.',
    burst: '칸 글자: 시 트랜잭션 시작 · 읽 락 없이 읽기 · 잠 잠그며 읽기 · 일 앱이 50ms 일함 · 쓰 쓰기 · 기 락을 기다리기 시작 · 확 커밋 · 되 ROLLBACK · ! 오류. 점선 칸은 락을 기다리는 단계다. 값 줄은 그 단계가 끝난 뒤 커밋된 값이다.',
    pool: '한 단계가 모형의 0.2초다(풀 타임아웃 시각은 따로 한 단계로 둔다). 값 줄은 그 시각의 요청 수와 MySQL에 열린 연결 수다. NullPool의 c는 새 연결을 여는 시간이다.',
  };

  function buildStrip() {
    const N = lastIdx();
    const strip = $('#strip');
    const values = valueRows();
    // 값 줄에 네 자리 수(잔액 1000)가 있으면 칸을 넓힌다.
    const longest = Math.max(0, ...values.flatMap((r) => r.cells.map((c) => String(c.text).length)));
    const cw = longest > 4 ? 48 : longest > 3 ? 40 : 30;
    strip.style.setProperty('--cw', `${cw}px`);
    strip.style.gridTemplateColumns = `auto repeat(${N}, ${cw}px)`;
    const out = ['<div class="rh">단계</div>'];
    for (let k = 1; k <= N; k++) out.push(`<div class="ch" data-step="${k}">${esc(run.views[k].label)}</div>`);
    for (const t of threads()) {
      out.push(`<div class="rh">${esc(threadTitle(t))}</div>`);
      for (let k = 1; k <= N; k++) {
        const v = run.views[k];
        const s = v.th[t.id];
        const bad = s.cls === 'run' && (s.err || v.ev.some((e) => e.bad && e.ids[0] === t.id));
        const mark = s.cls === 'run' ? stepMark(v, t.id) : '';
        const tip = `단계 ${v.label} · ${threadTitle(t)} · ${stateText(s)}${s.err ? ` · ${s.err}` : ''}`;
        out.push(stripCell(k, `${s.cls}${bad ? ' bad' : ''}`, mark, tip));
      }
    }
    for (const r of values) {
      out.push(`<div class="rh">${esc(r.label)}</div>`);
      r.cells.forEach((c, i) => out.push(stripCell(i + 1, c.cls, c.text, c.tip)));
    }
    strip.innerHTML = out.join('');
    $('#stripNote').textContent = STRIP_NOTE[run.kind];
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
      for (const e of run.views[k].ev) items.push(`<li${e.bad ? ' class="bad"' : ''}><span class="muted">${esc(run.views[k].label)}</span> ${esc(e.text)}</li>`);
    }
    $('#log').innerHTML = items.join('');
  }

  // ---------- 요소 설명 ----------
  // 개념, 주요 특성, 근거, 복습 카드는 content.js의 ELEMENTS에서 가져오고, 지금 상태는 단계마다 여기서 만든다.

  function evHtml(keys) {
    return keys.map((k) => RC.EV[k]).filter(Boolean)
      .map((e) => `<li><span class="tag t-${e.type}">${esc(RC.TYPE_LABEL[e.type])}</span> <a href="${esc(e.href)}" target="_blank" rel="noopener">${esc(e.label)}</a></li>`).join('');
  }
  function cardsHtml(ids) { return ids.map((c) => `<li><b>${esc(c)}</b> ${esc(RC.CARDS[c] || '')}</li>`).join(''); }

  function lineList(keys) {
    const ls = [...new Set(keys.flatMap(linesOfKey))].sort((a, b) => a - b).map((i) => i + 1);
    return ls.length ? `${ls.join(', ')}번` : '';
  }

  // 칸에 걸린 락을 그 칸의 뜻으로 적는다.
  function cellLockText(r, kind) {
    const whoS = who(r.session);
    const wait = r.status === 'WAITING' ? ' · 기다림' : '';
    let what;
    if (r.kind === 'II') what = '삽입 의도 락: 이 갭에 레코드를 넣으려 한다';
    else if (kind === 'sup') what = 'supremum의 락: 마지막 레코드 뒤 갭만 잠근다';
    else if (r.kind === 'NK') what = kind === 'gap' ? `넥스트 키 락: 레코드 ${josa(recName(r.index, r.data), ['과', '와'])} 이 갭을 함께 잠근다` : '넥스트 키 락: 이 레코드와 그 앞 갭을 함께 잠근다';
    else if (r.kind === 'GAP') what = '갭 락: 이 갭만 잠근다';
    else what = '레코드 락: 이 레코드만 잠근다';
    return `${whoS}의 ${r.mode} (${what})${wait}`;
  }

  // 요청한 락: "삽입 의도 락(X,GAP,INSERT_INTENTION)을". 조사는 괄호 앞의 말에 맞춘다.
  function askText(s) {
    const kw = KIND_WORD[s.waitType] || s.waitType;
    return `${kw}(${s.waitMode})${josa(kw, ['을', '를']).slice(kw.length)}`;
  }
  function waitersOf(v, cellId) {
    return Object.entries(v.th).filter(([, s]) => s.waitOn === cellId)
      .map(([id, s]) => `${josa(who(id), ['이', '가'])} ${askText(s)} 요청해 ${s.waitBy.length ? `${whoList(s.waitBy)}의 락에 막혀` : ''} 기다린다`);
  }

  // 갭 칸의 범위: 이 단계에 있는 바로 앞 레코드와 이 칸의 레코드(또는 supremum) 사이
  function gapRange(cellId) {
    const p = cellParts(cellId);
    const info = geo.rowOf[cellId];
    const present = run.present[idx];
    let prev = null;
    for (const c of info.row.cells) {
      if (c.id === cellId) break;
      if (c.kind === 'rec' && present.has(c.id)) prev = c.rec;
    }
    const name = (d) => recName(p.ix, d);
    if (p.kind === 'sup') return prev == null ? `레코드가 하나도 없는 ${p.ix}의 하나뿐인 갭(supremum 앞)` : `${p.ix}의 마지막 레코드 ${name(prev)} 뒤 갭(supremum 앞)`;
    if (prev == null) return `${p.ix}의 첫 레코드 ${name(p.rec)} 앞 갭`;
    return `${p.ix}의 ${josa(name(prev), ['과', '와'])} ${name(p.rec)} 사이 갭`;
  }

  function nowLines(sel, v) {
    const out = [];
    if (sel.startsWith('pool:')) {
      const c = poolCounts(v);
      const C = run.kase;
      if (sel === 'pool:app') {
        out.push(`${v.phase}: 연결을 쓰는 요청 ${c.use}개, ${C.pool === 'null' ? '새 연결을 여는' : '연결을 기다리는'} 요청 ${c.wait + c.connect}개, 끝난 요청 ${c.done}개, 풀 타임아웃 ${c.timeout}개.`);
        const got = v.reqs.filter((r) => typeof r.got === 'number');
        if (got.length && C.pool !== 'null') out.push(`지금까지 연결을 받은 요청 중 가장 오래 기다린 것: ${Math.max(...got.map((r) => r.got)) / 1000}초.`);
        if (C.pool !== 'null' && c.wait) out.push('기다리는 요청은 연결이 돌아오는 대로 하나씩 받는다(모형은 요청 번호 순).');
      } else if (sel === 'pool:pool') {
        if (C.pool === 'null') out.push('풀이 없다. 요청마다 연결을 새로 열고, 끝나면 끊는다. 동시에 열리는 연결 수를 막는 것은 MySQL의 max_connections(151)뿐이다.');
        else {
          out.push(`연결 ${C.size}개: ${v.slots.map((s) => `연결 ${s.id} ${s.holder ? `요청 ${s.holder}` : '쉼'}`).join(', ')}.`);
          out.push(`연결마다 지금까지 빌려준 횟수: ${v.slots.map((s) => s.uses).join(', ')}번.`);
          out.push(`max_overflow=0이라 ${C.size}개보다 더 만들지 않는다. 연결을 ${C.timeout}초 넘게 기다린 요청은 풀 타임아웃 오류로 끝난다.`);
        }
      } else {
        out.push(`열린 연결 ${v.db.open}개, 새로 만든 연결 ${v.db.created}개, 동시 최대 ${v.db.peak}개(모형).`);
        out.push('실측에는 관찰용 연결 1개가 늘 더해졌고, Docker 상태 검사 연결이 섞인 실행도 있었다(실험 README의 측정하며 본 것).');
      }
      return out;
    }
    if (sel.startsWith('th:')) {
      const t = thread(sel.slice(3));
      const s = v.th[t.id];
      const after = s.cls === 'run' ? s.after : s;
      if (s.cls === 'run') out.push(`이 단계 동안 실행했다. 실행한 줄: ${lineList(s.lines) || '없음'}.`);
      else out.push('이 단계 동안 실행하지 않았다.');
      if (s.err) {
        const why = { '오류 1213': '트랜잭션 전체가 되돌려지고 보유한 락을 모두 해제했다', '오류 1205': '그 문장만 되돌렸고, 트랜잭션과 앞서 획득한 락은 남았다', '오류 1062': '그 문장만 되돌렸고, 트랜잭션과 확인에 쓴 공유 락은 남았다' }[s.err];
        out.push(`마지막 문장이 ${s.err}로 끝났다${why ? `. ${why}` : ''}.`);
      }
      let w = '';
      if (s.waitOn) w = ` · ${nameOf(`cell:${s.waitOn}`)}에 ${askText(s)} 요청해${s.waitBy.length ? ` ${whoList(s.waitBy)}의 락에 막혀` : ''} 기다린다`;
      out.push(`단계 끝: ${stateText(after)}${w}.`);
      if (s.deferred && s.deferred.length) out.push(`앞 문장이 끝나지 않아 미뤄 둔 줄: ${s.deferred.join(', ')}번(순서표 기준).`);
      out.push(`트랜잭션: ${s.trx} · 격리 수준 ${M.LEVEL_NAME[s.iso]}${s.attempt > 1 ? ` · ${s.attempt}번째 시도` : ''}.`);
      if (s.snapAt) out.push(`스냅숏: 단계 ${s.snapAt}에 만들었다. 락 없이 읽는 SELECT는 이 스냅숏을 읽고, 잠그며 읽기와 UPDATE는 커밋된 최신 행을 읽는다.`);
      const held = v.dataLocks.filter((r) => r.session === t.id && r.status === 'GRANTED' && r.type !== 'TABLE');
      out.push(`단계 끝에 보유 중인 락: ${held.length ? held.map(lockLine).join(', ') : '없음'}.`);
      if (s.local && !s.err) out.push(`마지막 결과: ${s.local.replace(/^→ /, '')}.`);
      const nl = s.at ? firstLine(s.at) : -1;
      if (after.cls !== 'done' && nl >= 0) out.push(`다음에 실행할 줄: ${nl + 1}번.`);
    } else if (sel.startsWith('tb:')) {
      const name = sel.slice(3);
      const o = v.obj[name];
      const spec = run.specs.find((x) => x.name === name);
      out.push(`단계 끝에 커밋된 행: ${o.committed.length ? o.committed.map((r) => `(${r.join(', ')})`).join(', ') : '없음'}${spec ? ` · 열 (${spec.cols.join(', ')})` : ''}.`);
      out.push(`인덱스: ${o.indexes.map((x) => (x.primary ? `PRIMARY (${o.pk}, 클러스터형)` : `${x.name} (${[...x.cols, o.pk].join(', ')}${x.unique ? ', UNIQUE' : ''})`)).join(', ')}.`);
      const tl = v.dataLocks.filter((r) => r.type === 'TABLE' && r.table === name);
      out.push(`표 락: ${tl.length ? tl.map((r) => `${who(r.session)}의 ${r.mode}(${lockKind(r)})`).join(', ') : '없음'}. 행 락을 걸기 전에 표에 거는 의도 락으로, 표 전체를 잠그는 락(LOCK TABLES 등)과만 충돌한다.`);
    } else if (sel.startsWith('ix:')) {
      const [t, name] = sel.slice(3).split('/');
      const x = ixOf(v, t, name);
      out.push(`단계 끝 레코드 ${x.recs.length}개(키 순서): ${x.recs.length ? x.recs.map((r) => recName(name, r.data)).join(', ') : '없음'}, 그 뒤 supremum.`);
      const ls = v.dataLocks.filter((r) => r.type !== 'TABLE' && r.table === t && r.index === name);
      out.push(`이 인덱스의 락: ${ls.length ? ls.map((r) => `${who(r.session)} ${r.mode} ${r.data === SUP ? 'supremum' : recName(name, r.data)}${r.status === 'WAITING' ? ' (기다림)' : ''}`).join(', ') : '없음'}.`);
    } else if (sel.startsWith('cell:')) {
      const id = sel.slice(5);
      const p = cellParts(id);
      const bx = geo.boxes[id];
      if (p.kind === 'rec') {
        const r = recOf(v, id);
        if (!r) out.push('단계 끝: 이 단계에는 없는 레코드다(아직 넣기 전이거나, 지워져 사라졌거나, 되돌려졌다).');
        else {
          if (p.ix === 'PRIMARY') {
            const vs = shownVers(r);
            out.push(`행 데이터: ${vs.map((x) => `${x.text}${x.state === 'active' ? ` (${josa(who(x.by), ['이', '가'])} 쓰고 커밋 전)` : ' (커밋됨)'}`).join(' ← ')}.`);
          } else {
            const ix = ixOf(v, p.t, p.ix);
            const cols = [...ix.cols, v.obj[p.t].pk];
            out.push(`키: ${cols.map((c, i) => `${c} ${r.key[i]}`).join(', ')}. 행 데이터는 PRIMARY의 ${r.key[r.key.length - 1]}에 있다.`);
          }
          if (r.ins) out.push(`${josa(who(r.by), ['이', '가'])} 넣고 아직 커밋하지 않은 레코드다.`);
          if (r.del) out.push(`${josa(who(r.by), ['이', '가'])} 지웠고 커밋하기 전이다(지움 표시).`);
        }
      } else if (bx && bx.vis) out.push(`범위: ${gapRange(id)}.`);
      else out.push('단계 끝: 이 갭은 이 단계에 따로 없다(뒤의 레코드가 아직 없거나 사라져, 바로 다음 갭과 하나다).');
      const ls = v.dataLocks.filter((r) => r.cells.includes(id));
      out.push(`락: ${ls.length ? ls.map((r) => cellLockText(r, p.kind)).join(', ') : '없음'}.`);
      const ws = waitersOf(v, id);
      if (ws.length) out.push(`${ws.join('. ')}.`);
      if (p.kind !== 'rec' && ls.some((r) => r.status === 'GRANTED' && r.kind !== 'II')) out.push('갭을 잠그는 락은 S든 X든 서로 충돌하지 않고, 이 갭에 레코드를 넣는 삽입 의도 락만 막는다.');
    }
    return out;
  }

  function renderDetails() {
    const pane = $('#details');
    if (!selected) { pane.hidden = true; detailsFor = null; return; }
    const type = typeOf(selected);
    const d = RC.ELEMENTS[type] || { kind: '', concept: '', props: [], ev: [], cards: [] };
    if (detailsFor !== selected) {
      detailsFor = selected;
      $('#detailsKind').textContent = d.kind;
      $('#detailsTitle').textContent = nameOf(selected);
      $('#detailsConcept').textContent = d.concept;
      $('#detailsProps').innerHTML = d.props.map((p) => `<li>${esc(p)}</li>`).join('');
      $('#detailsEv').innerHTML = evHtml(d.ev);
      $('#detailsCards').innerHTML = cardsHtml(d.cards);
    }
    $('#detailsNowHead').textContent = `지금 · 단계 ${view().label}`;
    $('#detailsNow').innerHTML = nowLines(selected, view()).map((s) => `<li>${esc(s)}</li>`).join('');
    pane.hidden = false;
  }

  function select(id) {
    selected = id;
    detailsFor = null;
    markSelected();
    renderDetails();
    $('#live').textContent = `${nameOf(id)} 설명을 열었다.`;
    const r = $('#details').getBoundingClientRect();
    if (r.top > window.innerHeight || r.bottom < 0) $('#details').scrollIntoView({ block: 'nearest', behavior: motionOff.matches ? 'auto' : 'smooth' });
  }

  function closeDetails() {
    const was = selected;
    const inside = $('#details').contains(document.activeElement);
    selected = null;
    markSelected();
    renderDetails();
    const back = was && $('#board').querySelector(`[data-sel="${was}"][tabindex]`);
    if (inside && back) back.focus();
  }

  // ---------- 진행 ----------

  function render(animate) {
    const v = view();
    $('#board').classList.toggle('instant', !(animate && !motionOff.matches));
    renderBoard(v);
    renderCaption(v);
    renderLocks(v);
    renderCode(v);
    renderStripCursor();
    renderLog();
    renderDetails();
    $('#boardSummary').textContent = describe(v);
    $('#scrub').value = String(idx);
    $('#stepNum').textContent = v.label;
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
    if (!isPool()) {
      run.labels = run.views.map(labelsOf);
      run.present = run.views.map(presentOf);
    }
    idx = 0;
    shown = -1;
    codeSig = null;
    buildBoard();
    if (selected && !$('#board').querySelector(`[data-sel="${selected}"]`)) selected = null;
    detailsFor = null;
    buildStrip();
    renderCounts();
    $('#scrub').max = String(lastIdx());
    $('#stepMax').textContent = run.views[lastIdx()].label;
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

  const LV = (list) => ({ label: '격리 수준', key: 'level', items: list.map((l) => [l, M.LEVEL_NAME[l]]) });
  const OPTS = {
    gap: [LV(['RR', 'RC']), { label: 'B의 INSERT', key: 'b', items: Object.entries(M.GAP_CASES).map(([k, [mark, id, user]]) => [k, `${mark} (${id}, ${user})`]) }],
    noidx: [LV(['RR', 'RC']), { label: 'B의 문장', key: 'b', items: [['user7', '(가) INSERT (10, 7)'], ['user15', '(나) INSERT (13, 15)'], ['delete1', '(다) DELETE id 1']] }],
    serial: [],
    transfer: [{ label: '고치는 순서', key: 'order', items: [['reverse', '서로 반대로'], ['ordered', '둘 다 작은 id부터']] },
      { label: '데드락 탐지', key: 'detect', items: [['ON', '켬 (ON)'], ['OFF', '끔 (OFF)']] }],
    pair: [],
    deduct: [LV(['RC', 'RR', 'SER'])],
    reward: [{ label: '막는 방법', key: 'way', select: true, items: Object.entries(M.WAYS).map(([k, w]) => [k, w.label]) }],
    pool: [{ label: '풀', key: 'pool', items: [['q5', '풀 5 · 30초'], ['q10', '풀 10 · 30초'], ['q50', '풀 50 · 30초'], ['q5t', '풀 5 · 0.5초'], ['null', 'NullPool']] }],
  };
  const FIXED = { serial: '조건: SERIALIZABLE, 데드락 탐지 켬 (실험의 조건 하나)', pair: '조건: REPEATABLE READ, 데드락 탐지 켬 (실험의 조건 하나)' };
  const EXTRAS = {
    deduct: [{ type: 'num', key: 'n', label: '요청 수' }],
    reward: [{ type: 'num', key: 'n', label: '요청 수' }],
  };
  function cfgNote() {
    if (isPool()) return '실험은 경우마다 워밍업 1회와 3회를 돌렸다. 모형은 0.2초 단위로 나눠 그려 실측보다 짧다(실측은 차례마다 약 0.216초를 썼다). NullPool의 새 연결 시간 c는 이 맥에서 50개를 동시에 열 때 요청마다 약 19~76ms였다.';
    if (isBurst()) return '실험은 요청 10개로 판마다 워밍업 1회와 3회를 돌렸다. 이 장면은 요청 수를 2~10개로 바꿀 수 있고(기본 3개), 한 단계에 요청마다 문장을 하나씩 요청 번호 순으로 보낸다. 실제 요청은 거의 같은 때 문장을 보내 누가 먼저 락을 얻는지가 실행마다 다를 수 있다. 요청 10개일 때 결과별 수, 오류, 끝난 뒤 값은 실험과 같다.';
    return '실험은 순서표 조건마다 워밍업 1회와 3회를 돌렸고, 네 번 모두 같은 행·기다림·오류·락·끝난 뒤 값을 돌려줬다. 이 화면은 그 순서를 그린다. 실험에서 돌리지 않은 조합은 고를 수 없다.';
  }
  const BOARD_NOTE = {
    timeline: '표 상자 안에 인덱스마다 한 줄이 있다. 위가 보조 인덱스, 아래가 행 데이터를 담은 PRIMARY(클러스터형 인덱스)다. 줄 안의 실선 칸이 인덱스 레코드(키 순서), 그 앞 점선 칸이 갭, 맨 끝 칸이 supremum(마지막 레코드 뒤 갭)이다. 레코드가 들어오면 그 자리의 갭이 둘로 나뉜다. 칸의 "X A"는 A가 보유한 배타 락, "S"는 공유 락, "II"는 삽입 의도 락이다. 넥스트 키 락은 레코드 칸과 그 앞 갭 칸에 함께, 갭 락은 갭 칸에만, 레코드 락은 레코드 칸에만 적는다. 세션에서 칸으로 가는 회색 점선은 그 칸의 락을 기다리는 것이고, 주황 선은 기다림의 고리(데드락)다. PRIMARY 칸 안 작은 상자는 행의 값이다.',
    burst: '요청 상자 하나가 연결 하나다. 표 상자 안에 인덱스마다 한 줄이 있고, 실선 칸이 인덱스 레코드, 점선 칸이 갭, 맨 끝 칸이 supremum(마지막 레코드 뒤 갭)이다. 칸의 "X 1~3"은 요청 1~3이 보유한 배타 락, "S"는 공유 락, "II"는 삽입 의도 락이다. 요청에서 칸으로 가는 회색 점선은 그 칸의 락을 기다리는 것이고, 주황 선은 기다림의 고리(데드락)다. PRIMARY 칸 안 작은 상자는 행의 값이다(점선은 커밋 전 값, 그 아래 회색은 커밋된 값).',
    pool: '앱 상자의 점 하나가 요청 하나다. 풀 상자의 칸 하나가 미리 만든 연결 하나이고, 칸 안 글자는 그 연결을 빌린 요청이다. MySQL 상자는 서버에 열린 연결 수다. 풀에서 MySQL로 가는 화살표는 연결을 쓰는 요청이 있을 때 파랗다.',
  };

  function content() { return RC.SCENES[scene] || { questions: [], observe: [], measured: [], evidence: [], cards: [] }; }
  function guessKey() { return `lock-board-${scene}-guess`; }

  function buildSceneButtons() {
    $('#scenes').innerHTML = GROUPS.map(([key, label]) => `<div class="scene-group" role="group" aria-label="${esc(label)}">`
      + `<span class="group-label" aria-hidden="true">${esc(label)}</span>`
      + Object.entries(SCENES).filter(([, d]) => d.group === key).map(([k, d]) => `<button type="button" data-scene="${k}">${esc(d.label)}</button>`).join('')
      + '</div>').join('');
  }

  function legendHtml() {
    if (isPool()) {
      return '<li><i class="dot-sw"></i>연결 기다림</li><li><i class="dot-sw connect"></i>새 연결 여는 중</li><li><i class="dot-sw use"></i>연결을 쓰는 중</li>'
        + '<li><i class="dot-sw done"></i>끝</li><li><i class="dot-sw timeout"></i>풀 타임아웃</li><li><i class="shape box"></i>풀의 연결 (빌려 간 연결은 파랑)</li>';
    }
    const shapes = `<li><i class="shape circle"></i>${isBurst() ? '요청 (연결 하나)' : '세션'}</li><li><i class="cell-sw"></i>인덱스 레코드</li><li><i class="cell-sw gap"></i>갭 · supremum</li>`
      + '<li><i class="cell-sw held"></i>보유한 락이 걸린 칸</li><li><i class="cell-sw waited"></i>기다리는 칸</li><li><i class="cell-sw ins"></i>커밋 전에 넣은 레코드</li>'
      + '<li><i class="ver-sw"></i>커밋된 값</li><li><i class="ver-sw active"></i>커밋 전 값</li>';
    const states = '<li><i class="sw run"></i>실행 중</li><li><i class="sw turn"></i>차례 기다림</li><li><i class="sw event"></i>락 기다림</li><li><i class="sw done"></i>끝</li>';
    const lines = '<li><i class="cnl wait"></i>락 기다림</li><li><i class="cnl cycle"></i>기다림의 고리</li>';
    return `${shapes}${states}${lines}<li><i class="sw bad"></i>문제 (오류, 손실, 중복)</li>`;
  }

  function buildSceneText() {
    const c = content();
    document.querySelectorAll('[data-scene]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scene === scene)));
    $('#questions').innerHTML = (c.questions || []).map((q) => `<li>${esc(q)}</li>`).join('');
    $('#observe').innerHTML = (c.observe || []).map((o) => `<li>${esc(o)}</li>`).join('');
    $('#measured').innerHTML = (c.measured || []).map((m) => `<li>${esc(m)}</li>`).join('');
    $('#sceneEv').innerHTML = evHtml(c.evidence || []);
    $('#sceneCards').innerHTML = cardsHtml(c.cards || []);
    $('#guess').value = store.get(guessKey()) || '';
  }

  // 구성 칸은 장면을 고르거나 구성을 바꿀 때 다시 만든다. 설명은 이 구성이 순서표인지, 동시 요청인지, 풀인지에 따라 다르다.
  function buildCfg() {
    const parts = (EXTRAS[scene] || []).map((x) => `<div class="num" data-k="${x.key}"><span>${esc(x.label)}</span><button type="button" data-d="-1" aria-label="${esc(x.label)} 줄이기">−</button><output></output><button type="button" data-d="1" aria-label="${esc(x.label)} 늘리기">+</button></div>`);
    parts.push(`<p class="note">${esc(cfgNote())}</p>`);
    $('#cfg').innerHTML = parts.join('');
    $('#boardNote').textContent = BOARD_NOTE[run.kind];
  }

  // 장면별 조절 단추. 실험에서 돌리지 않은 조합은 누를 수 없게 한다. 막는 방법처럼 고를 것이 많으면 목록 상자로 둔다.
  function buildOpts() {
    const list = OPTS[scene];
    if (!list.length) { $('#opts').innerHTML = `<p class="note">${esc(FIXED[scene] || '')}</p>`; return; }
    $('#opts').innerHTML = list.map((o, i) => {
      if (o.select) {
        return `<div class="scope"><label for="opt${i}">${esc(o.label)}</label><select id="opt${i}" data-opt-sel="${o.key}">`
          + o.items.map(([val, label]) => `<option value="${val}"${cfg[o.key] === val ? ' selected' : ''}>${esc(label)}</option>`).join('') + '</select></div>';
      }
      return `<div class="scope" role="group" aria-labelledby="opt${i}"><span id="opt${i}">${esc(o.label)}</span>`
        + o.items.map(([val, label]) => {
          const ok = M.normalizeConfig(scene, Object.assign({}, cfg, { [o.key]: val }))[o.key] === val;
          return `<button type="button" data-opt="${o.key}" data-val="${val}" aria-pressed="${String(cfg[o.key] === val)}"${ok ? '' : ' disabled title="실험에서 돌리지 않은 조합"'}>${esc(label)}</button>`;
        }).join('') + '</div>';
    }).join('');
  }

  function sceneTitle() {
    if (isPool() || isBurst()) return run.title;
    const extra = scene === 'transfer' ? ` · 데드락 탐지 ${run.detect}` : '';
    return `${run.title} · ${M.LEVEL_NAME[run.level]}${extra}`;
  }

  function syncControls() {
    buildOpts();
    buildCfg();
    $('#sceneTitle').textContent = sceneTitle();
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
    if (RC.EV.anki) $('#ankiLink').href = RC.EV.anki.href;
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
    // 칸은 표 상자 안에 있다. 칸을 누르면 칸을, 인덱스 이름을 누르면 인덱스를, 그 밖의 표 상자를 누르면 표를 고른다.
    $('#board').addEventListener('click', (e) => {
      const n = e.target.closest('[data-sel]');
      if (n) select(n.dataset.sel);
    });
    $('#detailsClose').addEventListener('click', closeDetails);
    document.querySelectorAll('[data-scene]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.scene !== scene) setScene(b.dataset.scene); }));
    $('#opts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-opt]');
      if (b && !b.disabled) setConfig({ [b.dataset.opt]: b.dataset.val });
    });
    $('#opts').addEventListener('change', (e) => {
      if (e.target.matches('select[data-opt-sel]')) setConfig({ [e.target.dataset.optSel]: e.target.value });
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
  window.__lockBoard = { get scene() { return scene; }, get cfg() { return cfg; }, get idx() { return idx; }, get run() { return run; },
    get geo() { return geo; }, get code() { return code; }, get selected() { return selected; }, go, setConfig, setScene, select,
    linesOfKey, firstLine, lastLine };
})();
