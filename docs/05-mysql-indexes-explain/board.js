/*
 * 인덱스 관계도: 위에는 전체 지도 하나, 아래에는 고른 장면의 관계도.
 * 모든 장면은 model.js가 만든 단계 기록을 그대로 그린다.
 * 읽기 장면은 쿼리 하나를 InnoDB가 읽는 순서대로 나눈 단계다. 보조 인덱스(있으면 위)와 PRIMARY(아래)를 루트, 중간, 리프의 3층으로 그린다.
 *   이 단계에 읽은 페이지는 굵은 파랑 테두리, 따라간 포인터는 굵은 파랑 곡선, 읽은 항목은 파랑 테두리, 쓰인 항목은 옅은 파랑, 버린 항목은 회색이다.
 *   페이지 위 숫자는 이 단계까지 그 페이지를 읽은 횟수(논리적 읽기)다.
 * 쓰기 장면은 행 하나를 넣는 것이 한 단계다. 루트, 리프, 버퍼 풀의 페이지(최근에 쓴 순서), 디스크를 그린다.
 * 락 장면은 실험 README의 04 변형 순서표 한 줄이 한 단계다. 리프의 레코드에 걸린 락을 테두리(레코드)와 왼편 막대(갭)로 그린다.
 * 관계도의 요소를 고르면 설명 칸에 그 요소의 개념, 지금 상태, 근거가 나온다.
 * 단계는 이벤트의 순서이고 시간 길이가 아니다.
 *
 * 장면을 더하려면 model.js의 SCENARIOS와 장면 함수에 장면을 만들고, 여기의 SCENES, OPTS, PAIRS와 코드 줄(readCode 등)에 그 장면을 더하고,
 * content.js의 SCENES에 같은 이름으로 질문, 볼 것, 실측 기록, 근거를 적는다.
 */
(function () {
  'use strict';

  const M = window.IndexModel;
  const RC = window.IndexContent || { SCENES: {}, ELEMENTS: {}, EV: {}, CARDS: {}, TYPE_LABEL: {} };
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const motionOff = window.matchMedia('(prefers-reduced-motion: reduce)');

  const SPEEDS = [{ label: '느리게', ms: 2000 }, { label: '보통', ms: 1200 }, { label: '빠르게', ms: 600 }];
  const SCENE_KEY = 'index-board-scene';
  const DEFAULT_SCENE = 'find';
  const SCENES = {
    find: { group: 'read' },
    order: { group: 'read' },
    unused: { group: 'read' },
    sort: { group: 'list' },
    page: { group: 'list' },
    split: { group: 'write' },
    lock: { group: 'lock' },
  };
  for (const [k, d] of Object.entries(SCENES)) d.label = M.SCENARIOS[k].title;
  const GROUPS = [['read', '찾기와 읽기'], ['list', '정렬과 목록'], ['write', '쓰기와 버퍼 풀'], ['lock', '락 범위']];

  // 크기(px). 좁은 화면에서도 글자를 줄이지 않는다. 관계도가 칸보다 넓으면 관계도 칸 안에서 옆으로 밀어 본다.
  const FS = 12;        // 칸 글자
  const FS_S = 11;      // 이름표와 횟수
  const ROW_H = 18;     // 리프 항목 한 줄
  const ROW_H2 = 32;    // 두 줄짜리 항목(락 장면의 PRIMARY). 둘째 줄은 첫 줄의 락 이름표 아래로 지나간다.
  const PAD = 5;        // 페이지 안 여백
  const COL_GAP = 7;    // 항목 칼럼 사이
  const UP_H = 22;      // 루트·중간 페이지 높이
  const LV_GAP = 26;    // 층 사이(포인터 곡선)
  const LBL_H = 15;     // 페이지 위 이름표
  const LEAF_GAP = 14;  // 리프 사이(리프를 잇는 선)
  const MARGIN = 10;
  const CHIP_W = 26;
  const CHIP_GAP = 4;

  const STATE_NAME = { run: '실행 중', turn: '차례 기다림', event: '락 기다림', done: '끝' };
  const HANDLER_ORDER = ['first', 'last', 'key', 'next', 'prev', 'rnd_next'];

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
  // 글자 너비 어림값(px). 화면의 글꼴로 잴 수 없을 때 쓴다.
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
  // 글자 너비(px). 화면의 글꼴로 직접 잰다. 글꼴이 기기마다 달라도 칸 크기가 그 글꼴에 맞는다.
  const widths = new Map();
  let ruler = null;
  function textW(text, size, weight) {
    const s = String(text == null ? '' : text);
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
  const num = (n) => M.num(n);
  const josa = (w, pair) => M.josa(w, pair);
  // 곡선 연결선: 두 끝에서 세로로 나가고 들어오는 3차 베지에 곡선.
  function curve(x0, y0, x1, y1) {
    const f = (n) => Math.round(n * 10) / 10;
    const dy = (y1 - y0) / 2;
    return `M${f(x0)} ${f(y0)}C${f(x0)} ${f(y0 + dy)} ${f(x1)} ${f(y1 - dy)} ${f(x1)} ${f(y1)}`;
  }

  function view() { return run.views[idx]; }
  function lastIdx() { return run.views.length - 1; }
  const isRead = () => run.kind === 'read';
  const isSplit = () => run.kind === 'split';
  const isLock = () => run.kind === 'lock';
  function avail() { return Math.floor($('#boardWrap').clientWidth) || 640; }

  // ---------- 읽기 장면의 글자 ----------

  // PRIMARY 리프 칸에 적을 칼럼: id와 이 장면에서 볼 칼럼
  function pkCols() {
    if (scene === 'unused') {
      if (cfg.q.startsWith('day')) return ['id', 'created_at'];
      if (cfg.q.startsWith('phone')) return ['id', 'phone'];
      return ['id', 'user_id'];
    }
    if (scene === 'sort') return ['none', 'created'].includes(cfg.ix) ? ['id', 'created_at'] : ['id', 'user_id', 'created_at'];
    if (scene === 'page') return ['id', 'created_at'];
    return ['id', 'user_id', 'created_at'];
  }
  function longKeys() { return !!(run.spec && run.spec.longKeys); }
  function treeCols(name) { return name === 'PRIMARY' ? pkCols() : M.keyCols(name); }
  function valText(col, v) { return M.colText(col, v, longKeys()); }
  function entryCells(name, e) {
    const row = M.ROW[e.row];
    if (name === 'PRIMARY') return pkCols().map((c) => ({ col: c, text: valText(c, row[c]), cls: c === 'id' ? 'idv' : '' }));
    const cols = M.keyCols(name);
    return cols.map((c, i) => ({ col: c, text: valText(c, e.key[i]), cls: c === 'id' ? 'pk' : '' }));
  }
  function ptrText(name, e) {
    const cols = M.keyCols(name);
    return e.key.map((v, i) => valText(cols[i], v)).join(', ');
  }
  function treeOf(id) { return M.tree(id.split(':')[0]); }
  function pageOf(id) { return treeOf(id).pages[id]; }
  function entryOf(id) {
    const T = treeOf(id);
    if (id.includes('#')) { const [pid, j] = id.split('#'); return T.pages[pid].entries[+j]; }
    return T.byRow[+id.split(':e')[1]];
  }
  function rowIdOf(cellId) { return +cellId.split(':e')[1]; }
  function entryName(id) {
    const tname = id.split(':')[0];
    const e = entryOf(id);
    return tname === 'PRIMARY' ? `id ${e.row}` : M.entryText(tname, e, longKeys());
  }
  function pagesText(v) { return v.pages.map((id) => `${id.split(':')[0]} ${pageOf(id).name}`).join(', '); }
  function handlerText(h) { return HANDLER_ORDER.filter((k) => h[k]).map((k) => `${k} ${num(h[k])}`).join(' · '); }

  // ---------- 요소 이름과 고르기 ----------

  function typeOf(sel) {
    if (sel === 'q') return 'query';
    if (sel === 'res') return 'result';
    if (sel === 'buf') return 'sortbuf';
    if (sel.startsWith('tree:')) return sel.slice(5) === 'PRIMARY' ? 'tree-primary' : 'tree-secondary';
    if (sel.startsWith('page:')) {
      const p = pageOf(sel.slice(5));
      if (p.level > 0) return p.parent ? 'page-inner' : 'page-root';
      return p.tree === 'PRIMARY' ? 'page-leaf-primary' : 'page-leaf-secondary';
    }
    if (sel.startsWith('ent:')) {
      const id = sel.slice(4);
      if (id.includes('#')) return 'pointer';
      return id.startsWith('PRIMARY:') ? 'entry-primary' : 'entry-secondary';
    }
    if (sel === 'ins') return 'insert';
    if (sel === 'sp:R') return 'split-root';
    if (sel.startsWith('sp:')) return 'split-leaf';
    if (sel === 'pool') return 'pool';
    if (sel.startsWith('fr:')) return 'frame';
    if (sel === 'disk') return 'disk';
    if (sel.startsWith('th:')) return 'session';
    if (sel.startsWith('rec:')) {
      const c = sel.slice(4);
      if (c.endsWith(':sup')) return 'supremum';
      return c.startsWith('PRIMARY:') ? 'record-primary' : 'record-secondary';
    }
    return '';
  }
  const pname = (id) => (id === 'R' ? '루트' : `리프 ${id.slice(1)}`);
  function nameOf(sel) {
    if (sel === 'q') return '쿼리';
    if (sel === 'res') return '결과';
    if (sel === 'buf') return '정렬 버퍼';
    if (sel.startsWith('tree:')) return sel.slice(5) === 'PRIMARY' ? 'PRIMARY (클러스터형 인덱스)' : `${sel.slice(5)} (보조 인덱스)`;
    if (sel.startsWith('page:')) { const id = sel.slice(5); return `${id.split(':')[0]} ${pageOf(id).name}`; }
    if (sel.startsWith('ent:')) {
      const id = sel.slice(4);
      const tname = id.split(':')[0];
      if (id.includes('#')) { const p = pageOf(id.split('#')[0]); return `${tname} ${p.name}의 포인터 ${ptrText(tname, entryOf(id))}`; }
      return tname === 'PRIMARY' ? `PRIMARY 행 id ${rowIdOf(id)}` : `${tname} 항목 ${entryName(id)}`;
    }
    if (sel === 'ins') return '넣는 행 (INSERT)';
    if (sel.startsWith('sp:')) return `PRIMARY ${pname(sel.slice(3))}`;
    if (sel === 'pool') return '버퍼 풀';
    if (sel.startsWith('fr:')) return `버퍼 풀의 ${pname(sel.slice(3))}`;
    if (sel === 'disk') return '디스크 (데이터 파일)';
    if (sel.startsWith('th:')) return `세션 ${sel.slice(3)}`;
    if (sel.startsWith('rec:')) {
      const c = sel.slice(4);
      const tname = c.split(':')[0];
      if (c.endsWith(':sup')) return `${tname} 리프 ${c.split(':')[1].slice(1)}의 supremum`;
      return tname === 'PRIMARY' ? `PRIMARY 레코드 id ${rowIdOf(c)}` : `idx_user 레코드 ${M.entryText('idx_user', M.tree('idx_user').byRow[rowIdOf(c)])}`;
    }
    return sel;
  }

  // 고를 수 있는 요소. 누르거나 Tab으로 옮겨 Enter를 누르면 설명 칸에 그 요소의 설명이 나온다.
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

  // ---------- 관계도 ----------

  function buildBoard() {
    const svg = $('#board');
    svg.innerHTML = '';
    $('#boardWrap').scrollLeft = 0;
    geo = isRead() ? layoutRead() : isSplit() ? layoutSplit() : layoutLock();
    svg.setAttribute('viewBox', `0 0 ${geo.W} ${geo.H}`);
    // 관계도는 늘 제 크기로 그린다. 칸보다 넓으면 칸 안에서 옆으로 밀어 본다.
    svg.style.width = `${geo.W}px`;
    svg.classList.toggle('compact', geo.compact);
    if (isRead()) drawRead(svg, geo);
    else if (isSplit()) drawSplit(svg, geo);
    else drawLock(svg, geo);
  }

  function renderBoard(v) {
    if (isRead()) renderRead(v);
    else if (isSplit()) renderSplit(v);
    else renderLock(v);
    markSelected();
  }

  // 결과 칩 줄: 칸을 미리 만들어 두고 단계마다 글자와 모양만 바꾼다.
  function chipRow(parent, x, y, n) {
    const chips = [];
    for (let i = 0; i < n; i++) {
      const c = el('g', { class: 'rchip none' }, parent);
      el('rect', { x: x + i * (CHIP_W + CHIP_GAP), y, width: CHIP_W, height: 20, rx: 5 }, c);
      c.t = el('text', { x: x + i * (CHIP_W + CHIP_GAP) + CHIP_W / 2, y: y + 14, 'text-anchor': 'middle' }, c, '');
      chips.push(c);
    }
    return chips;
  }
  function fillChips(chips, items) {
    chips.forEach((c, i) => {
      const it = items[i];
      c.setAttribute('class', it ? `rchip ${it.cls}` : 'rchip none');
      c.t.textContent = it ? it.text : '';
    });
  }

  // ---------- 읽기 장면 ----------

  function layoutRead() {
    const A = avail();
    const g = { compact: A < 480, trees: [], pos: {} };
    // 위 줄: 쿼리 원, 정렬 버퍼, 결과
    const limit = run.spec.limit || 0;
    const offset = run.spec.offset || 0;
    const maxRes = Math.max(1, ...run.views.map((v) => v.results.length + v.skipped.length));
    g.resN = Math.max(maxRes, limit ? limit + offset : 0);
    g.resLabel = `결과${limit ? ` (LIMIT ${limit}${offset ? `, OFFSET ${offset}` : ''})` : ''}`;
    g.resW = Math.max(textW(g.resLabel, FS_S, 600) + 14, g.resN * (CHIP_W + CHIP_GAP) + 10);
    if (run.spec.sort) {
      g.bufN = limit + offset;
      g.bufLabel = `정렬 버퍼 (위 ${g.bufN}행)`;
      g.bufW = Math.max(textW(g.bufLabel, FS_S, 600) + 14, g.bufN * (CHIP_W + CHIP_GAP) + 10);
    }
    const topW = 44 + (g.bufW ? g.bufW + 10 : 0) + g.resW;
    let y = MARGIN + 50 + 18;
    let maxW = 0;
    for (const name of run.trees) {
      const T = M.tree(name);
      const cols = treeCols(name);
      const leafIds = T.levels[T.levels.length - 1];
      const entries = leafIds.flatMap((id) => T.pages[id].entries);
      const colW = cols.map((c, i) => Math.ceil(Math.max(...entries.map((e) => textW(entryCells(name, e)[i].text, FS, name === 'PRIMARY' && i === 0 ? 700 : 400)))));
      const leafW = PAD * 2 + colW.reduce((a, b) => a + b, 0) + COL_GAP * (cols.length - 1) + 4;
      const nRows = Math.max(...leafIds.map((id) => T.pages[id].entries.length));
      const leafH = PAD * 2 + nRows * ROW_H;
      const ptrs = T.levels.slice(0, -1).flat().flatMap((id) => T.pages[id].entries);
      const cellW = Math.ceil(Math.max(...ptrs.map((e) => textW(ptrText(name, e), FS_S)))) + 12;
      const upW = PAD * 2 + cellW * M.FAN + 3 * (M.FAN - 1);
      let gap = LEAF_GAP;
      // 중간 페이지 둘이 겹치지 않게 리프 사이를 넓힌다.
      if (upW + 12 > 2 * (leafW + gap)) gap = Math.ceil((upW + 12) / 2 - leafW);
      const width = leafIds.length * leafW + (leafIds.length - 1) * gap;
      const titleText = treeTitle(name);
      const levelTops = [];
      let ly = y + 20;
      T.levels.forEach((lv, i) => {
        levelTops.push(ly + LBL_H);
        ly += LBL_H + (i < T.levels.length - 1 ? UP_H + LV_GAP : leafH);
      });
      g.trees.push({ name, T, cols, colW, leafW, leafH, cellW, upW, gap, width: Math.max(width, textW(titleText, FS, 600)), rowW: width, y, levelTops, bottom: ly, titleText });
      maxW = Math.max(maxW, width, textW(titleText, FS, 600));
      y = ly + 36;
    }
    const W = Math.ceil(Math.max(maxW + MARGIN * 2, topW + MARGIN * 2, 300));
    for (const t of g.trees) {
      const x0 = (W - t.rowW) / 2;
      t.x0 = x0;
      const leafIds = t.T.levels[t.T.levels.length - 1];
      leafIds.forEach((id, i) => { g.pos[id] = { x: x0 + i * (t.leafW + t.gap), y: t.levelTops[t.levelTops.length - 1], w: t.leafW, h: t.leafH }; });
      for (let lv = t.T.levels.length - 2; lv >= 0; lv--) {
        for (const id of t.T.levels[lv]) {
          const kids = t.T.pages[id].entries.map((e) => g.pos[e.child]);
          const cx = (kids[0].x + kids[kids.length - 1].x + kids[kids.length - 1].w) / 2;
          g.pos[id] = { x: cx - t.upW / 2, y: t.levelTops[lv], w: t.upW, h: UP_H };
        }
      }
    }
    g.W = W;
    g.H = Math.ceil(y - 36 + MARGIN + 4);
    g.q = { x: MARGIN + 18, y: MARGIN + 25 };
    let bx = MARGIN + 44;
    if (g.bufW) { g.bufX = bx; bx += g.bufW + 10; }
    g.resX = bx;
    g.boxY = MARGIN + 2;
    return g;
  }

  function treeTitle(name) {
    const used = name === 'PRIMARY' ? run.views.some((v) => v.tree === 'PRIMARY') : run.index === name;
    const cols = name === 'PRIMARY' ? `${pkCols().join(', ')} …` : M.keyCols(name).join(', ');
    return `${name} (${cols})${used ? '' : ' · 이 쿼리는 읽지 않음'}`;
  }

  function drawRead(svg, g) {
    g.pageNodes = {};
    g.ptrNodes = {};
    g.entNodes = {};
    g.edges = {};
    g.links = {};
    // 위 줄
    const q = el('g', Object.assign({ class: 'qnode' }, selAttrs('q')), svg);
    el('circle', { cx: g.q.x, cy: g.q.y, r: 19 }, q);
    el('text', { x: g.q.x, y: g.q.y + 4, 'text-anchor': 'middle', class: 'name' }, q, '쿼리');
    g.qNode = q;
    if (g.bufW) {
      const b = el('g', Object.assign({ class: 'box' }, selAttrs('buf')), svg);
      el('rect', { x: g.bufX, y: g.boxY, width: g.bufW, height: 48, rx: 8 }, b);
      el('text', { x: g.bufX + 7, y: g.boxY + 14, class: 'blbl' }, b, g.bufLabel);
      g.bufChips = chipRow(b, g.bufX + 6, g.boxY + 21, g.bufN);
    }
    const r = el('g', Object.assign({ class: 'box' }, selAttrs('res')), svg);
    el('rect', { x: g.resX, y: g.boxY, width: g.resW, height: 48, rx: 8 }, r);
    el('text', { x: g.resX + 7, y: g.boxY + 14, class: 'blbl' }, r, g.resLabel);
    g.resChips = chipRow(r, g.resX + 6, g.boxY + 21, g.resN);

    for (const t of g.trees) {
      const grp = el('g', { class: 'tree' }, svg);
      // 두 번 읽기 선은 보조 인덱스와 PRIMARY 사이에 그린다(PRIMARY의 제목과 페이지가 선 위에 온다).
      if (t.name === 'PRIMARY') g.look = el('path', { class: 'look', d: '' }, el('g', { class: 'cns' }, svg));
      const tg = el('g', Object.assign({ class: 'ttl' }, selAttrs(`tree:${t.name}`)), grp);
      el('text', { class: 'tree-title', x: t.x0, y: t.y + 12 }, tg, t.titleText);
      const lines = el('g', { class: 'cns' }, grp);
      // 포인터 곡선
      for (const id of t.T.levels.slice(0, -1).flat()) {
        const p = g.pos[id];
        t.T.pages[id].entries.forEach((e, j) => {
          const cx = p.x + PAD + j * (t.cellW + 3) + t.cellW / 2;
          const c = g.pos[e.child];
          g.edges[e.id] = el('path', { class: 'edge', d: curve(cx, p.y + UP_H - 2, c.x + c.w / 2, c.y) }, lines);
        });
      }
      // 리프를 잇는 선(앞뒤 페이지 번호)
      const leafIds = t.T.levels[t.T.levels.length - 1];
      for (let i = 1; i < leafIds.length; i++) {
        const a = g.pos[leafIds[i - 1]];
        const b = g.pos[leafIds[i]];
        const ly = a.y + a.h / 2;
        g.links[linkKey(leafIds[i - 1], leafIds[i])] = el('line', { class: 'link', x1: a.x + a.w, y1: ly, x2: b.x, y2: ly }, lines);
      }
      // 페이지
      for (const id of t.T.levels.flat()) {
        const P = t.T.pages[id];
        const p = g.pos[id];
        const pg = el('g', Object.assign({ class: 'page' }, selAttrs(`page:${id}`)), grp);
        el('rect', { class: 'pbox', x: p.x, y: p.y, width: p.w, height: p.h, rx: 5 }, pg);
        const lbl = el('text', { class: 'plbl', x: p.x + 1, y: p.y - 4 }, pg);
        el('tspan', {}, lbl, P.name);
        pg.vc = el('tspan', { class: 'vc' }, lbl, '');
        g.pageNodes[id] = pg;
        if (P.level > 0) {
          P.entries.forEach((e, j) => {
            const x = p.x + PAD + j * (t.cellW + 3);
            const c = el('g', Object.assign({ class: 'ptr' }, selAttrs(`ent:${e.id}`)), grp);
            el('rect', { x, y: p.y + 3, width: t.cellW, height: UP_H - 6, rx: 3 }, c);
            el('text', { x: x + t.cellW / 2, y: p.y + UP_H / 2 + 4, 'text-anchor': 'middle' }, c, ptrText(t.name, e));
            g.ptrNodes[e.id] = c;
          });
        } else {
          P.entries.forEach((e, j) => {
            const ry = p.y + PAD + j * ROW_H;
            const c = el('g', Object.assign({ class: 'ent' }, selAttrs(`ent:${e.id}`)), grp);
            el('rect', { x: p.x + 2, y: ry, width: p.w - 4, height: ROW_H - 1, rx: 3 }, c);
            let x = p.x + PAD + 2;
            entryCells(t.name, e).forEach((cell, i) => {
              el('text', { x, y: ry + 13, class: cell.cls }, c, cell.text);
              x += t.colW[i] + COL_GAP;
            });
            g.entNodes[e.id] = c;
          });
        }
      }
    }
  }

  function linkKey(a, b) { return [a, b].sort().join('|'); }
  // 이 단계에 지나간 리프 사이 선: 찾다가 옆 리프로 넘어간 경우와, 옆으로 읽다 리프 끝을 넘은 경우
  function linksOf(k) {
    const v = run.views[k];
    const out = new Set();
    if (!v.tree || v.kind === 'lookup') return out;
    const T = M.tree(v.tree);
    const leaves = v.pages.filter((id) => T.pages[id].level === 0);
    for (let i = 1; i < leaves.length; i++) out.add(linkKey(leaves[i - 1], leaves[i]));
    if (v.pages.length === 1 && leaves.length === 1) {
      for (let j = k - 1; j > 0; j--) {
        const p = run.views[j];
        if (p.tree === v.tree && p.cells.length) {
          const prevLeaf = entryOf(p.cells[0]).page;
          if (prevLeaf !== leaves[0]) out.add(linkKey(prevLeaf, leaves[0]));
          break;
        }
      }
    }
    return out;
  }
  // 두 번 읽기 선: 보조 인덱스 항목(그 항목의 id로 찾음)에서 PRIMARY 루트로
  function lookOf(k) {
    const v = run.views[k];
    if (v.kind === 'entry') return { cell: v.cells[0], on: false };
    if (v.kind === 'lookup') { const p = run.views[k - 1]; return p && p.kind === 'entry' ? { cell: p.cells[0], on: true } : null; }
    return null;
  }

  function resultItems(v, p) {
    const items = v.skipped.map((id) => ({ text: String(id), cls: 'skip' }));
    for (const id of v.results) items.push({ text: String(id), cls: p && !p.results.includes(id) ? 'res new' : 'res' });
    return items;
  }

  function renderRead(v) {
    const g = geo;
    const p = run.views[idx - 1];
    setCls(g.qNode, `qnode${idx === 0 ? '' : v.done ? ' done' : ' run'}`);
    fillChips(g.resChips, resultItems(v, p));
    if (g.bufChips) {
      fillChips(g.bufChips, v.buffer.map((id) => ({ text: String(id), cls: p && !p.buffer.includes(id) ? 'res new' : 'res' })));
    }
    const now = new Set(v.pages);
    for (const [id, node] of Object.entries(g.pageNodes)) {
      const n = v.visits[id] || 0;
      setCls(node, `page${now.has(id) ? ' hit' : ''}${n ? ' seen' : ''}`);
      node.vc.textContent = n ? ` · ${n}회` : '';
    }
    const ptrs = new Set(v.ptrs);
    for (const [id, node] of Object.entries(g.ptrNodes)) {
      setCls(node, `ptr${ptrs.has(id) ? ' on' : ''}`);
      g.edges[id].setAttribute('class', `edge${ptrs.has(id) ? ' on' : ''}`);
    }
    const cur = new Set(v.cells);
    for (const [id, node] of Object.entries(g.entNodes)) {
      const st = v.state[id];
      setCls(node, `ent${cur.has(id) ? ' cur' : ''}${st ? ` ${st}` : ''}`);
    }
    const on = linksOf(idx);
    for (const [k, line] of Object.entries(g.links)) line.setAttribute('class', `link${on.has(k) ? ' on' : ''}`);
    const lk = lookOf(idx);
    if (lk && g.look) {
      const leaf = g.pos[entryOf(lk.cell).page];
      const root = g.pos[M.tree('PRIMARY').root.id];
      g.look.setAttribute('d', curve(leaf.x + leaf.w / 2, leaf.y + leaf.h, root.x + root.w / 2, root.y - LBL_H + 2));
      g.look.setAttribute('class', `look${lk.on ? ' on' : ''}`);
    } else if (g.look) {
      g.look.setAttribute('d', '');
    }
  }

  // ---------- 쓰기 장면 ----------

  function layoutSplit() {
    const A = avail();
    const g = { compact: A < 480 };
    const maxLeaves = Math.max(...run.views.map((v) => v.leaves.length));
    const keyW = Math.ceil(Math.max(...run.keys.map((k) => textW(String(k), FS, 600))));
    g.leafW = Math.max(keyW + PAD * 2 + 10, 40);
    g.leafH = PAD * 2 + M.LEAF_CAP * ROW_H;
    g.gap = 12;
    g.maxLeaves = maxLeaves;
    g.rowW = maxLeaves * g.leafW + (maxLeaves - 1) * g.gap;
    g.cellW = Math.max(keyW + 10, 26);
    g.rootW = PAD * 2 + maxLeaves * g.cellW + (maxLeaves - 1) * 3;
    g.frameW = Math.ceil(textW('리프 6', FS_S, 600)) + 16;
    g.frames = run.frames;
    g.diskW = Math.ceil(Math.max(textW('물리적 읽기 99', FS_S), textW('디스크', FS, 600))) + 18;
    const inner = Math.max(A - MARGIN * 2, 260);
    const allFrames = g.frames * (g.frameW + 4) - 4;
    g.perRow = allFrames + 14 + g.diskW <= inner ? g.frames : Math.max(2, Math.floor((inner + 4) / (g.frameW + 4)));
    if (g.perRow > g.frames) g.perRow = g.frames;
    const poolW = g.perRow * (g.frameW + 4) - 4;
    const diskBeside = poolW + 14 + g.diskW <= inner;
    g.insW = 130;
    const W = Math.ceil(Math.max(g.rowW, g.rootW, poolW + (diskBeside ? 14 + g.diskW : 0), g.insW) + MARGIN * 2);
    g.W = Math.max(W, 280);
    g.ins = { x: MARGIN, y: MARGIN, w: g.insW, h: 44 };
    g.rootY = MARGIN + 44 + 18 + LBL_H;
    g.rootX = (g.W - g.rootW) / 2;
    g.leafY = g.rootY + UP_H + LV_GAP + LBL_H;
    g.x0 = (g.W - g.rowW) / 2;
    g.poolY = g.leafY + g.leafH + 34;
    const rows = Math.ceil(g.frames / g.perRow);
    g.poolX = (g.W - (poolW + (diskBeside ? 14 + g.diskW : 0))) / 2;
    g.poolH = rows * 30 - 4;
    g.disk = diskBeside ? { x: g.poolX + poolW + 14, y: g.poolY, w: g.diskW, h: Math.max(g.poolH, 52) } : { x: g.poolX, y: g.poolY + g.poolH + 12, w: g.diskW, h: 52 };
    // 축출 글줄은 버퍼 풀과 디스크 상자 아래에 둔다.
    g.evY = Math.max(g.poolY + g.poolH + 6, g.disk.y + g.disk.h) + 18;
    g.H = Math.ceil(g.evY + 8);
    return g;
  }

  function leafX(g, i) { return g.x0 + i * (g.leafW + g.gap); }

  function drawSplit(svg, g) {
    const ins = el('g', Object.assign({ class: 'box ins' }, selAttrs('ins')), svg);
    el('rect', { x: g.ins.x, y: g.ins.y, width: g.ins.w, height: g.ins.h, rx: 8 }, ins);
    el('text', { x: g.ins.x + 8, y: g.ins.y + 15, class: 'blbl' }, ins, 'INSERT 할 키');
    g.insKey = el('text', { x: g.ins.x + 8, y: g.ins.y + 36, class: 'big' }, ins, '');
    const lines = el('g', { class: 'cns' }, svg);
    g.edges = [];
    g.links = [];
    for (let i = 0; i < g.maxLeaves; i++) g.edges.push(el('path', { class: 'edge', d: '' }, lines));
    for (let i = 1; i < g.maxLeaves; i++) g.links.push(el('line', { class: 'link' }, lines));
    // 루트
    const root = el('g', Object.assign({ class: 'page' }, selAttrs('sp:R')), svg);
    el('rect', { class: 'pbox', x: g.rootX, y: g.rootY, width: g.rootW, height: UP_H, rx: 5 }, root);
    el('text', { class: 'plbl', x: g.rootX + 1, y: g.rootY - 4 }, root, '루트');
    g.rootNode = root;
    g.rootCells = [];
    for (let i = 0; i < g.maxLeaves; i++) {
      const x = g.rootX + PAD + i * (g.cellW + 3);
      const c = el('g', { class: 'ptr none' }, root);
      el('rect', { x, y: g.rootY + 3, width: g.cellW, height: UP_H - 6, rx: 3 }, c);
      c.t = el('text', { x: x + g.cellW / 2, y: g.rootY + UP_H / 2 + 4, 'text-anchor': 'middle' }, c, '');
      g.rootCells.push(c);
    }
    // 리프: 끝까지 생기는 리프를 모두 만들어 두고, 단계마다 자리를 옮긴다.
    const ids = [...new Set(run.views.flatMap((v) => v.leaves.map((l) => l.id)))];
    g.leafNodes = {};
    for (const id of ids) {
      const lg = el('g', Object.assign({ class: 'leafp' }, selAttrs(`sp:${id}`)), svg);
      el('rect', { class: 'pbox', x: 0, y: 0, width: g.leafW, height: g.leafH, rx: 5 }, lg);
      el('text', { class: 'plbl', x: 1, y: -4 }, lg, pname(id));
      lg.slots = [];
      for (let j = 0; j < M.LEAF_CAP; j++) {
        const s = el('g', { class: 'slot' }, lg);
        el('rect', { x: 3, y: PAD + j * ROW_H, width: g.leafW - 6, height: ROW_H - 2, rx: 3 }, s);
        s.t = el('text', { x: g.leafW / 2, y: PAD + j * ROW_H + 12, 'text-anchor': 'middle' }, s, '');
        lg.slots.push(s);
      }
      g.leafNodes[id] = lg;
    }
    // 버퍼 풀
    const pool = el('g', Object.assign({ class: 'poolbox' }, selAttrs('pool')), svg);
    const poolW = g.perRow * (g.frameW + 4) - 4;
    el('rect', { class: 'area', x: g.poolX - 6, y: g.poolY - 6, width: poolW + 12, height: g.poolH + 12, rx: 8 }, pool);
    el('text', { class: 'plbl', x: g.poolX - 5, y: g.poolY - 10 }, pool, `버퍼 풀 ${g.frames}페이지 · 왼편이 가장 최근`);
    g.frameNodes = [];
    for (let j = 0; j < g.frames; j++) {
      const x = g.poolX + (j % g.perRow) * (g.frameW + 4);
      const y = g.poolY + Math.floor(j / g.perRow) * 30;
      const f = el('g', { class: 'frame empty', 'data-sel': '', tabindex: '-1', role: 'button' }, svg);
      el('rect', { x, y, width: g.frameW, height: 26, rx: 4 }, f);
      f.t = el('text', { x: x + g.frameW / 2, y: y + 17, 'text-anchor': 'middle' }, f, '');
      g.frameNodes.push(f);
    }
    const disk = el('g', Object.assign({ class: 'box disk' }, selAttrs('disk')), svg);
    el('rect', { x: g.disk.x, y: g.disk.y, width: g.disk.w, height: g.disk.h, rx: 8 }, disk);
    el('text', { x: g.disk.x + 8, y: g.disk.y + 15, class: 'blbl' }, disk, '디스크');
    g.diskRead = el('text', { x: g.disk.x + 8, y: g.disk.y + 31, class: 'dsub' }, disk, '');
    g.diskFlush = el('text', { x: g.disk.x + 8, y: g.disk.y + 45, class: 'dsub' }, disk, '');
    g.evText = el('text', { x: g.poolX - 5, y: g.evY, class: 'evtext' }, svg, '');
  }

  function renderSplit(v) {
    const g = geo;
    g.insKey.textContent = v.key == null ? '' : String(v.key);
    setCls(g.insKey.parentNode, `box ins${v.key == null ? '' : ' run'}`);
    const visit = new Set(v.visit);
    setCls(g.rootNode, `page${visit.has('R') ? ' hit' : ''}${v.dirty.includes('R') ? ' dirty' : ''}`);
    const order = v.leaves.map((l) => l.id);
    g.rootCells.forEach((c, i) => {
      const leaf = v.leaves[i];
      c.setAttribute('class', leaf ? `ptr${leaf.id === v.target ? ' on' : ''}` : 'ptr none');
      c.t.textContent = leaf && leaf.keys.length ? String(leaf.keys[0]) : '';
      const e = g.edges[i];
      if (leaf) {
        const cx = g.rootX + PAD + i * (g.cellW + 3) + g.cellW / 2;
        e.setAttribute('d', curve(cx, g.rootY + UP_H - 2, leafX(g, i) + g.leafW / 2, g.leafY));
        e.setAttribute('class', `edge${leaf.id === v.target ? ' on' : ''}`);
      } else e.setAttribute('d', '');
    });
    g.links.forEach((ln, i) => {
      if (i + 1 < order.length) {
        const y = g.leafY + g.leafH / 2;
        ln.setAttribute('x1', leafX(g, i) + g.leafW);
        ln.setAttribute('x2', leafX(g, i + 1));
        ln.setAttribute('y1', y);
        ln.setAttribute('y2', y);
        const isSib = v.sibling && ((order[i + 1] === v.sibling && order[i] === v.made));
        ln.setAttribute('class', `link${isSib ? ' on' : ''}`);
        ln.style.display = '';
      } else ln.style.display = 'none';
    });
    for (const [id, lg] of Object.entries(g.leafNodes)) {
      const i = order.indexOf(id);
      if (i < 0) { lg.style.display = 'none'; continue; }
      lg.style.display = '';
      lg.setAttribute('transform', `translate(${leafX(g, i)} ${g.leafY})`);
      const inPool = v.lru.includes(id);
      const cls = ['leafp'];
      if (visit.has(id)) cls.push('hit');
      if (v.dirty.includes(id)) cls.push('dirty');
      if (!inPool) cls.push('absent');
      if (v.miss.includes(id)) cls.push('miss');
      if (v.made === id) cls.push('made');
      setCls(lg, cls.join(' '));
      const keys = v.leaves[i].keys;
      lg.slots.forEach((s, j) => {
        const k = keys[j];
        let sc = 'slot';
        if (k == null) sc += ' empty';
        else if (k === v.key) sc += ' cur';
        else if (v.split === 'mid' && v.made === id) sc += ' moved';
        s.setAttribute('class', sc);
        s.t.textContent = k == null ? '' : String(k);
      });
    }
    g.frameNodes.forEach((f, j) => {
      const id = v.lru[j];
      if (!id) {
        f.setAttribute('class', 'frame empty');
        f.dataset.sel = '';
        f.removeAttribute('aria-label');
        f.setAttribute('tabindex', '-1');
        f.t.textContent = '';
        return;
      }
      f.dataset.sel = `fr:${id}`;
      f.setAttribute('aria-label', nameOf(`fr:${id}`));
      f.setAttribute('tabindex', '0');
      f.t.textContent = pname(id);
      setCls(f, `frame${v.dirty.includes(id) ? ' dirty' : ''}${v.miss.includes(id) ? ' miss' : ''}${visit.has(id) ? ' hit' : ''}`);
    });
    g.diskRead.textContent = `물리적 읽기 ${v.counts.physical}`;
    g.diskFlush.textContent = `플러시 ${v.counts.flushes}`;
    setCls(g.diskRead.parentNode, `box disk${v.miss.length || v.flushed.length ? ' on' : ''}`);
    g.evText.textContent = v.evicted.length ? `이 단계에 축출: ${v.evicted.map((id) => `${pname(id)}${v.flushed.includes(id) ? '(플러시 뒤)' : ''}`).join(', ')}` : '';
  }

  // ---------- 락 장면 ----------

  function lockTrees() { return cfg.ix === 'user' ? ['idx_user', 'PRIMARY'] : ['PRIMARY']; }
  function lockRows(name) {
    const T = M.tree(name);
    return T.levels[T.levels.length - 1].map((id) => {
      const P = T.pages[id];
      return { id, no: P.no, cells: [...P.entries.map((e) => ({ id: `${name}:e${e.row}`, row: e.row, e })), { id: `${name}:L${P.no}:sup`, sup: true }] };
    });
  }

  function layoutLock() {
    const A = avail();
    const g = { compact: A < 480, trees: [], cellPos: {} };
    const chipsW = 2 * CHIP_W + CHIP_GAP;
    // 락 장면은 리프를 줄 바꿈해 칸 폭에 맞춘다(옆으로 밀지 않는다). 그래서 양옆 여백을 줄인다.
    const SIDE = 4;
    const inner = Math.max(A - SIDE * 2, 260);
    const specs = lockTrees().map((name) => {
      const leaves = lockRows(name);
      const two = name === 'PRIMARY';
      // 락 이름표는 첫 줄의 오른편에 둔다. PRIMARY의 둘째 줄(amount)은 이름표 아래까지 쓸 수 있다.
      let inner1 = textW('supremum', FS_S) + 8 + chipsW;
      for (const l of leaves) {
        for (const c of l.cells) {
          if (c.sup) continue;
          const r = M.ROW[c.row];
          if (two) inner1 = Math.max(inner1, textW(`${r.id}  ${r.user_id}`, FS, 600) + 8 + chipsW, textW(num(r.amount), FS) + textW(` ${num(r.amount + 100)}`, FS, 700));
          else inner1 = Math.max(inner1, textW(M.entryText(name, c.e), FS) + 8 + chipsW);
        }
      }
      // 글자는 리프 왼편에서 13px, 이름표는 오른편에서 5px 떨어진다.
      const leafW = Math.ceil(13 + inner1 + 6);
      const rowH = two ? ROW_H2 : ROW_H;
      const leafH = PAD * 2 + 5 * rowH;
      const title = two ? 'PRIMARY의 리프 (id user_id / amount)' : 'idx_user의 리프 (user_id, id)';
      return { name, leaves, leafW, rowH, leafH, title, titleW: textW(title, FS, 600) };
    });
    const leafW = Math.max(...specs.map((s) => s.leafW));
    let perRow = Math.floor((inner + LEAF_GAP) / (leafW + LEAF_GAP));
    perRow = Math.max(1, Math.min(4, perRow));
    if (perRow === 3) perRow = 2;
    g.perRow = perRow;
    const rowW = perRow * leafW + (perRow - 1) * LEAF_GAP;
    const W = Math.ceil(Math.max(rowW + SIDE * 2, 250, ...specs.map((sp) => sp.titleW + SIDE * 2)));
    g.W = W;
    g.sess = { A: { x: Math.round(W * 0.3), y: MARGIN + 21 }, B: { x: Math.round(W * 0.7), y: MARGIN + 21 } };
    let y = MARGIN + 21 + 21 + 3 * 15 + 18;
    for (const s of specs) {
      const t = Object.assign({}, s, { leafW, y });
      t.x0 = (W - rowW) / 2;
      let ly = y + 20;
      t.pos = {};
      t.leaves.forEach((l, i) => {
        const col = i % perRow;
        const r = Math.floor(i / perRow);
        const top = ly + LBL_H + r * (t.leafH + LBL_H + 14);
        t.pos[l.id] = { x: t.x0 + col * (leafW + LEAF_GAP), y: top, w: leafW, h: t.leafH, col, row: r };
        l.cells.forEach((c, j) => { g.cellPos[c.id] = { x: t.pos[l.id].x + 3, y: top + PAD + j * t.rowH, w: leafW - 6, h: t.rowH - 2 }; });
      });
      const rows = Math.ceil(t.leaves.length / perRow);
      t.bottom = ly + rows * (t.leafH + LBL_H + 14) - 14;
      g.trees.push(t);
      y = t.bottom + 26;
    }
    g.H = Math.ceil(y - 26 + MARGIN + 4);
    return g;
  }

  function drawLock(svg, g) {
    g.recNodes = {};
    g.sessNodes = {};
    g.waitLine = el('path', { class: 'cn wait', d: '' }, el('g', { class: 'cns' }, svg));
    for (const s of ['A', 'B']) {
      const p = g.sess[s];
      const th = el('g', Object.assign({ class: 'th' }, selAttrs(`th:${s}`)), svg);
      el('circle', { cx: p.x, cy: p.y, r: 19 }, th);
      el('text', { x: p.x, y: p.y + 5, 'text-anchor': 'middle', class: 'name' }, th, s);
      th.lines = [0, 1, 2].map((i) => el('text', { x: p.x, y: p.y + 37 + i * 15, 'text-anchor': 'middle', class: `slot s${i}` }, th, ''));
      g.sessNodes[s] = th;
    }
    for (const t of g.trees) {
      const grp = el('g', { class: 'tree' }, svg);
      // 제목은 리프 줄의 왼편 끝에 맞추되, 그림 밖으로 나가지 않게 한다.
      el('text', { class: 'tree-title', x: Math.max(4, Math.min(t.x0, g.W - t.titleW - 4)), y: t.y + 12 }, grp, t.title);
      const lines = el('g', { class: 'cns' }, grp);
      t.leaves.forEach((l, i) => {
        const p = t.pos[l.id];
        const nx = t.leaves[i + 1] && t.pos[t.leaves[i + 1].id];
        if (nx && nx.row === p.row) el('line', { class: 'link', x1: p.x + p.w, y1: p.y + p.h / 2, x2: nx.x, y2: nx.y + nx.h / 2 }, lines);
        const pg = el('g', { class: 'page' }, grp);
        el('rect', { class: 'pbox', x: p.x, y: p.y, width: p.w, height: p.h, rx: 5 }, pg);
        el('text', { class: 'plbl', x: p.x + 1, y: p.y - 4 }, pg, `리프 ${l.no}`);
        for (const c of l.cells) {
          const cp = g.cellPos[c.id];
          const rg = el('g', Object.assign({ class: `rec${c.sup ? ' sup' : ''}` }, selAttrs(`rec:${c.id}`)), grp);
          el('rect', { class: 'rbox', x: cp.x, y: cp.y, width: cp.w, height: cp.h, rx: 3 }, rg);
          el('rect', { class: 'gapbar', x: cp.x - 1, y: cp.y + 1, width: 5, height: cp.h - 2, rx: 1.5 }, rg);
          const tx = cp.x + 10;
          if (c.sup) el('text', { x: tx, y: cp.y + 12, class: 'supt' }, rg, 'supremum');
          else if (t.name === 'PRIMARY') {
            const r = M.ROW[c.row];
            const l1 = el('text', { x: tx, y: cp.y + 12 }, rg);
            el('tspan', { class: 'idv' }, l1, String(r.id));
            el('tspan', { class: 'uid' }, l1, `  ${r.user_id}`);
            rg.amt = el('text', { x: tx, y: cp.y + 28, class: 'amt' }, rg);
          } else {
            el('text', { x: tx, y: cp.y + 12 }, rg, M.entryText('idx_user', c.e));
          }
          rg.chips = [0, 1].map((k) => {
            const cx = cp.x + cp.w - (2 - k) * (CHIP_W + CHIP_GAP) + CHIP_GAP - 2;
            const ch = el('g', { class: 'lkchip none' }, rg);
            el('rect', { x: cx, y: cp.y + 2, width: CHIP_W, height: 13, rx: 6.5 }, ch);
            ch.t = el('text', { x: cx + CHIP_W / 2, y: cp.y + 12.5, 'text-anchor': 'middle' }, ch, '');
            return ch;
          });
          g.recNodes[c.id] = rg;
        }
      });
    }
  }

  function lockParts(l) {
    const m = l.mode;
    const sup = l.cell.endsWith(':sup');
    const gap = sup || m === 'X' || m === 'S' || m.includes(',GAP');
    const rec = !sup && !m.includes(',GAP');
    return { gap, rec };
  }

  function renderLock(v) {
    const g = geo;
    for (const s of ['A', 'B']) {
      const st = v.sess[s];
      const th = g.sessNodes[s];
      setCls(th, `th ${st.state}`);
      th.lines[0].textContent = STATE_NAME[st.state];
      th.lines[1].textContent = st.trx || (st.state === 'done' ? '' : '트랜잭션 없음');
      th.lines[2].textContent = st.last || '';
      th.lines[2].setAttribute('class', `slot s2${st.last ? ' local' : ''}`);
    }
    for (const [id, rg] of Object.entries(g.recNodes)) {
      const ls = v.locks.filter((l) => l.cell === id);
      const held = ls.filter((l) => l.status === 'GRANTED');
      const parts = held.map(lockParts);
      const cls = ['rec'];
      if (id.endsWith(':sup')) cls.push('sup');
      if (parts.some((p) => p.rec)) cls.push('rl');
      if (parts.some((p) => p.gap)) cls.push('gl');
      if (ls.some((l) => l.status === 'WAITING')) cls.push('wait');
      setCls(rg, cls.join(' '));
      rg.chips.forEach((ch, k) => {
        const l = ls[k];
        ch.setAttribute('class', l ? `lkchip${l.status === 'WAITING' ? ' waiting' : ''}` : 'lkchip none');
        ch.t.textContent = l ? `${l.mode.split(',')[0]} ${l.s}` : '';
      });
      if (rg.amt) {
        const rid = rowIdOf(id);
        rg.amt.textContent = '';
        const pend = v.pending[rid];
        el('tspan', { class: pend !== undefined ? 'old' : '' }, rg.amt, num(v.amount[rid]));
        if (pend !== undefined) el('tspan', { class: 'new' }, rg.amt, ` ${num(pend)}`);
      }
    }
    if (v.wait) {
      const s = g.sess[v.wait.s];
      const c = g.cellPos[v.wait.cell];
      // 세션 원 아래 글줄 세 개를 지나 레코드 칸으로 간다.
      g.waitLine.setAttribute('d', curve(s.x, s.y + 19 + 3 * 15 + 2, c.x + c.w / 2, c.y));
    } else g.waitLine.setAttribute('d', '');
  }

  // ---------- 전체 지도 ----------
  // 쿼리 하나가 지나가는 부분(서버의 SQL 계층과 InnoDB)만 그린다. 장면과 구성을 바꾸면 그 구성이 쓰는 부분만 진하게 바꾼다.

  const MAP_SQL = [['query', '쿼리'], ['optimizer', '옵티마이저 (실행 계획)'], ['where', '서버의 거르기 (Using where)'], ['sortbuf', '정렬 버퍼 (filesort)'], ['result', '결과']];
  const MAP_INNODB = [['secondary', '보조 인덱스'], ['icp', '인덱스 안 거르기 (ICP)'], ['primary', '클러스터형 인덱스 (PRIMARY)'], ['split', '페이지 분할'],
    ['lock', '레코드·갭 락'], ['snapshot', '스냅숏 (일관된 읽기)'], ['pool', '버퍼 풀'], ['disk', '디스크 (데이터 파일)']];
  const PART_NAMES = Object.fromEntries([...MAP_SQL, ...MAP_INNODB]);

  function buildMap() {
    const A = Math.floor($('#mapWrap').clientWidth) || 460;
    const W = Math.max(260, Math.min(460, A));
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
    const sqlB = flow(MAP_SQL, 12) + 22;
    el('rect', { class: 'box', x: 4, y: 4, width: W - 8, height: sqlB - 4, rx: 10 }, svg);
    svg.insertBefore(svg.lastChild, svg.firstChild);
    el('text', { class: 'lbl', x: 14, y: sqlB - 7 }, svg, 'MySQL 서버 (SQL 계층)');
    const top = sqlB + 10;
    const inB = flow(MAP_INNODB, top + 8) + 22;
    el('rect', { class: 'box', x: 4, y: top, width: W - 8, height: inB - top, rx: 10 }, svg);
    svg.insertBefore(svg.lastChild, svg.firstChild);
    el('text', { class: 'lbl', x: 14, y: inB - 7 }, svg, 'InnoDB (저장 엔진)');
    svg.setAttribute('viewBox', `0 0 ${W} ${inB + 4}`);
    svg.style.maxWidth = `${W}px`;
  }

  // 이 구성이 쓰는 지도 부분. 장면에 그린 요소와 같다.
  function partsFor() {
    if (isSplit()) return ['query', 'primary', 'split', 'pool', 'disk'];
    if (isLock()) return ['query', 'primary', 'lock', 'snapshot', ...(cfg.ix === 'user' ? ['secondary'] : [])];
    const ex = run.explain.extra || '';
    const out = ['query', 'optimizer', 'result', 'pool'];
    if (run.views.some((v) => v.tree === 'PRIMARY')) out.push('primary');
    if (run.index) out.push('secondary');
    if (/Using where/.test(ex)) out.push('where');
    if (/Using index condition/.test(ex)) out.push('icp');
    if (/filesort/.test(ex)) out.push('sortbuf');
    return out;
  }

  function renderMap() {
    const on = new Set(partsFor());
    $('#map').querySelectorAll('.part').forEach((p) => p.classList.toggle('on', on.has(p.dataset.part)));
    const used = [...MAP_SQL, ...MAP_INNODB].map(([k]) => k).filter((k) => on.has(k)).map((k) => PART_NAMES[k]);
    $('#map').setAttribute('aria-label', '전체 지도. MySQL 서버의 SQL 계층 안에 쿼리, 옵티마이저, 서버의 거르기, 정렬 버퍼, 결과가 있고, 그 아래 InnoDB 안에 보조 인덱스, '
      + `인덱스 안 거르기, 클러스터형 인덱스, 페이지 분할, 레코드·갭 락, 스냅숏, 버퍼 풀, 디스크가 있다. 이 구성에 나오는 부분: ${used.join(', ')}.`);
  }

  function renderCounts() {
    const items = [];
    if (isRead()) {
      const ixs = ['PRIMARY', ...(run.drawIndex ? [run.drawIndex] : [])];
      items.push(['표', 'orders 16행 (실험 100만 행)'], ['인덱스', ixs.join(', ')], ['나무마다', '3층: 루트 1장, 중간 2장, 리프 4장'],
        ['리프 한 장', '항목 4개 (실험 PRIMARY 약 159행)'], ['위층 한 장', '포인터 2개 (실험 약 900개)']);
      if (run.spec.limit) items.push(['LIMIT', `${run.spec.limit} (실험 20)`]);
    } else if (isSplit()) {
      items.push(['넣는 행', `${run.keys.length}개 (실험 100만 행)`], ['기본 키', M.PK_KEYS[cfg.pk].label], ['리프 한 장', `행 ${M.LEAF_CAP}개 (실험 약 159행)`],
        ['버퍼 풀', `${run.frames}페이지`], ['보조 인덱스', '그리지 않음 (실험은 idx_user 하나)']);
    } else {
      items.push(['세션', '2개 (A, B)'], ['격리 수준', 'REPEATABLE READ'], ['표', 'orders 16행 (실험 100만 행)'],
        ['인덱스', cfg.ix === 'user' ? 'PRIMARY, idx_user' : 'PRIMARY'], ['순서표 줄', `${run.steps.length}줄`]);
    }
    $('#counts').innerHTML = items.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('');
  }

  // ---------- 개수 칸 ----------

  function tallyItems(v) {
    if (isRead()) {
      // 긴 값(Handler_read_*, 결과)은 한 줄을 다 쓴다. 단계마다 줄 배치가 바뀌지 않게 항목마다 정해 둔다.
      const items = [['논리적 읽기', num(v.logical)]];
      if (run.index) items.push(['읽은 인덱스 항목', String(v.entries)]);
      items.push(['읽은 행', String(v.rows)]);
      if (run.index && !run.spec.covering) items.push(['두 번 읽기', `${v.lookups}번`]);
      if (run.spec.offset) items.push(['건너뛴 행', String(v.skipped.length)]);
      items.push(['Handler_read_*', handlerText(v.handler) || '없음', true]);
      items.push(['결과', v.results.length ? `${v.results.length}행 (id ${v.results.join(', ')})` : '없음', true]);
      return items;
    }
    if (isSplit()) {
      const c = v.counts;
      const fill = c.leaves ? Math.round((100 * c.rows) / (c.leaves * M.LEAF_CAP)) : 0;
      return [['넣은 행', String(c.rows)], ['리프', `${c.leaves}장 (채움 비율 ${fill}%)`], ['분할', `끝 ${c.endSplits} · 가운데 ${c.midSplits}`],
        ['논리적 읽기', String(c.logical)], ['물리적 읽기', String(c.physical)], ['축출', String(c.evictions)], ['플러시', String(c.flushes)]];
    }
    const cnt = (s, st) => v.locks.filter((l) => l.s === s && l.status === st).length;
    return [['A가 보유한 락', String(cnt('A', 'GRANTED'))], ['B가 보유한 락', String(cnt('B', 'GRANTED'))], ['기다리는 락', String(v.locks.filter((l) => l.status === 'WAITING').length)]];
  }
  function renderTally(v) {
    const prev = idx > 0 ? new Map(tallyItems(run.views[idx - 1])) : new Map();
    $('#tally').innerHTML = tallyItems(v).map(([a, b, wide]) => {
      const cls = [wide ? 'wide' : '', prev.size && prev.get(a) !== b ? 'changed' : ''].filter(Boolean).join(' ');
      return `<div${cls ? ` class="${cls}"` : ''}><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`;
    }).join('');
  }

  // ---------- 화면 낭독기용 요약 ----------

  function describe(v) {
    const parts = [`단계 ${v.label}.`];
    if (isRead()) {
      parts.push(v.pages.length ? `이 단계에 읽은 페이지: ${pagesText(v)}.` : '이 단계에 읽은 페이지 없음.');
      if (v.cells.length) parts.push(`읽은 항목: ${v.cells.map((c) => `${c.split(':')[0]} ${entryName(c)}`).join(', ')}.`);
      parts.push(`결과 ${v.results.length}행${v.results.length ? `(id ${v.results.join(', ')})` : ''}. 논리적 읽기 ${v.logical}.`);
    } else if (isSplit()) {
      parts.push(`리프: ${v.leaves.map((l) => `${pname(l.id)} ${l.keys.join(' ') || '빈'}`).join(', ')}.`);
      parts.push(`버퍼 풀(최근 순): ${v.lru.map(pname).join(', ')}. 더티 페이지: ${v.dirty.map(pname).join(', ') || '없음'}.`);
    } else {
      parts.push(`세션 A ${STATE_NAME[v.sess.A.state]}, 세션 B ${STATE_NAME[v.sess.B.state]}.`);
      parts.push(`락 ${v.locks.length}개${v.wait ? `, ${v.wait.s}가 기다림` : ''}.`);
    }
    return parts.join(' ');
  }

  // ---------- 설명 한 문장 ----------

  function lockReads() {
    const at = (k) => { const s = run.views[k].sess.B.last; return s && s.startsWith('합') ? s.slice(2) : '없음'; };
    const waited = run.views.some((v) => v.wait);
    return { r4: at(4), r5: waited ? at(6) : at(5), r7: at(7), r8: at(8), waited };
  }
  function resultText() {
    if (isRead()) {
      const v = view();
      return `결과: ${v.results.length ? `id ${v.results.join(', ')}` : '행 없음'}. 논리적 읽기 ${v.logical}, ${handlerText(v.handler)}${run.index && !run.spec.covering ? `, 두 번 읽기 ${v.lookups}번` : ''}.`;
    }
    if (isSplit()) {
      const c = view().counts;
      const fill = Math.round((100 * c.rows) / (c.leaves * M.LEAF_CAP));
      return `결과: 행 ${c.rows}개에 리프 ${c.leaves}장(채움 비율 ${fill}%), 끝 분할 ${c.endSplits}, 가운데 분할 ${c.midSplits}. 논리적 읽기 ${c.logical}, 물리적 읽기 ${c.physical}, 축출 ${c.evictions}, 플러시 ${c.flushes}.`;
    }
    const r = lockReads();
    return `결과: B가 읽은 합은 4번 ${r.r4}, 5번 ${r.r5}, 7번 ${r.r7}, 8번 ${r.r8}. 5번은 ${r.waited ? 'A의 COMMIT까지 기다렸다' : '바로 끝났다'}.`;
  }

  function renderCaption(v) {
    const main = v.ev[0] || { text: v.text };
    const rest = v.ev.slice(1);
    let html = `<span${main.bad ? ' class="bad"' : ''}>${esc(main.text)}</span>`;
    if (idx === lastIdx()) html += `<span class="result">${esc(resultText())}</span>`;
    $('#caption').innerHTML = html;
    const more = $('#more');
    more.hidden = rest.length === 0;
    more.querySelector('summary').textContent = `이 단계의 다른 일 ${rest.length}개`;
    more.querySelector('ul').innerHTML = rest.map((e) => `<li${e.bad ? ' class="bad"' : ''}>${esc(e.text)}</li>`).join('');
    $('#live').textContent = `단계 ${v.label}. ${main.text}`;
  }

  // ---------- performance_schema.data_locks ----------
  // 락 장면만. 모형이 단계 끝에 만든 락 목록을 data_locks처럼 적는다(표 락 IX·IS는 뺐다). 앞 단계에 없던 줄은 옅은 파랑, 기다리는 줄은 굵게 적는다.

  function lockSig(l) { return `${l.s}|${l.index}|${l.mode}|${l.status}|${l.data}`; }
  function renderLocks(v) {
    const box = $('#locksBox');
    box.hidden = !isLock();
    if (!isLock()) return;
    const prev = idx > 0 ? new Set(run.views[idx - 1].locks.map(lockSig)) : new Set();
    const rows = v.locks.map((l) => `<tr class="${prev.has(lockSig(l)) ? '' : 'new'}${l.status === 'WAITING' ? ' waiting' : ''}"><td>${esc(l.s)}</td><td><code>${esc(l.index)}</code></td>`
      + `<td><code>${esc(l.mode)}</code></td><td class="st"><code>${esc(l.status)}</code></td><td><code>${esc(l.data)}</code></td></tr>`);
    box.querySelector('tbody').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="5" class="none">락 없음</td></tr>';
    const w = v.wait;
    let wait = '';
    if (w) {
      const req = v.locks.find((l) => l.status === 'WAITING');
      const blk = v.locks.find((l) => l.cell === w.cell && l.s === w.blocking && l.status === 'GRANTED');
      wait = `<li>${esc(w.s)}의 <code>${esc(req.mode)}</code>(${esc(req.index)} ${esc(req.data)})가 ${esc(w.blocking)}의 <code>${esc(blk ? blk.mode : '')}</code>에 막혀 기다린다</li>`;
    }
    $('#waits').innerHTML = wait || '<li class="none">기다리는 락 없음</li>';
  }

  // ---------- 코드 ----------

  function L(t, on) { return { t, on: on || [] }; }
  const SINCE_Q = "'2026-08-10'";

  function readCode() {
    const lines = [];
    let note = '';
    const ddl = (name) => lines.push(L(M.INDEXES[name].ddl, ['ddl']));
    const sel = (cols) => lines.push(L(`SELECT ${cols}`, ['select']));
    const from = (force) => lines.push(L(`FROM orders${force ? ` FORCE INDEX (${force})` : ''}`, ['from']));
    const where = (w) => lines.push(L(`WHERE ${w}`, ['where']));
    const order = (o) => lines.push(L(`ORDER BY ${o}`, ['order']));
    const limit = (n, off) => lines.push(L(`LIMIT ${n}${off ? ` OFFSET ${off}` : ''}`, ['limit']));
    if (scene === 'find') {
      const ix = M.FIND_IX[cfg.ix].index;
      if (ix) ddl(ix); else lines.push(L('-- 보조 인덱스 없음 (PRIMARY만)', ['ddl']));
      sel('created_at, amount');
      from();
      where(`user_id = ${cfg.user} AND created_at >= ${SINCE_Q}`);
      note = '작은 표에 맞춰 고객 4242는 42로 바꿨다. 고객 1은 실험처럼 주문이 가장 많은 고객이다.';
    } else if (scene === 'order') {
      ddl(M.ORDER_IX[cfg.ix].index);
      sel('created_at, amount');
      from(cfg.ix === 'force' ? 'idx_created_user' : null);
      where(cfg.cond === 'user_first' ? `user_id = 42 AND created_at >= ${SINCE_Q}` : `created_at >= ${SINCE_Q} AND user_id = 42`);
      note = '작은 표에 맞춰 고객 4242는 42로 바꿨다.';
    } else if (scene === 'unused') {
      ['idx_created', 'idx_phone', 'idx_user'].forEach(ddl);
      sel('id, amount');
      from();
      where(M.UNUSED_Q[cfg.q].where);
      note = "작은 표에 맞춰 날짜 '2026-08-10'은 '2026-06-20'으로, 고객 4242는 42로 바꿨다. 전화번호는 실험과 같은 값이다.";
    } else if (scene === 'sort') {
      const ix = { created: 'idx_created', user: 'idx_user', user_created: 'idx_user_created', between: 'idx_user_created' }[cfg.ix];
      if (ix) ddl(ix); else lines.push(L('-- 보조 인덱스 없음 (PRIMARY만)', ['ddl']));
      const all = ['none', 'created'].includes(cfg.ix);
      sel(all ? 'id, user_id, amount, created_at' : 'id, amount, created_at');
      from();
      if (cfg.ix === 'between') where('user_id BETWEEN 7 AND 15');
      else if (!all) where('user_id = 1');
      order('created_at DESC');
      limit(3);
      note = cfg.ix === 'between' ? '목표 1 확인의 쿼리 2(user_id BETWEEN 100 AND 199)를 작은 표의 고객 7~15로 옮겼다. LIMIT 20은 3으로 바꿨다.' : 'LIMIT 20은 작은 표에 맞춰 3으로 바꿨다.';
    } else {
      const n = Number(cfg.page);
      const edge = M.ROW[M.PAGE_EDGE[n]];
      const c = `'${edge.created_at}'`;
      ddl('idx_created');
      sel('id, user_id, amount, created_at');
      from(cfg.way === 'offset' && n === 2 ? 'idx_created' : null);
      const way = cfg.way;
      if (way === 'asc' || way === 'lt') where(`created_at < ${c}`);
      else if (way === 'le') where(`created_at <= ${c}`);
      else if (way === 'or') where(`created_at < ${c} OR (created_at = ${c} AND id < ${edge.id})`);
      else if (way === 'row') where(`(created_at, id) < (${c}, ${edge.id})`);
      if (way === 'asc') order('created_at');
      else if (way === 'offset' && n === 2) order('created_at DESC');
      else order('created_at DESC, id DESC');
      limit(3, way === 'offset' ? (n - 1) * 3 : 0);
      note = `한 페이지는 3행이다(실험 20행). ${n}번째 페이지의 앞 페이지 마지막 행은 id ${edge.id}(${edge.created_at})다.`
        + (way === 'offset' && n === 2 ? ' 실험의 OFFSET 100000은 옵티마이저가 표 전체 읽기와 정렬을 골라, FORCE INDEX로 인덱스를 쓰게 한 판과 견줬다.' : '');
    }
    lines[lines.length - 1].t += ';';
    return { lines, note, sig: JSON.stringify(cfg) };
  }

  function splitCode() {
    const pk = cfg.pk === 'auto' ? 'BIGINT PRIMARY KEY AUTO_INCREMENT' : 'BINARY(16) PRIMARY KEY';
    const lines = [L('CREATE TABLE orders_pk ('), L(`  id ${pk},`), L('  user_id INT NOT NULL, status VARCHAR(10) NOT NULL, amount INT NOT NULL,'),
      L('  phone VARCHAR(20) NOT NULL, memo TEXT NOT NULL, created_at DATETIME NOT NULL,'), L('  KEY idx_user (user_id)'), L(') ENGINE=InnoDB;'),
      L(cfg.pk === 'auto' ? 'INSERT INTO orders_pk (user_id, status, amount, phone, memo, created_at) VALUES (...);' : 'INSERT INTO orders_pk (id, user_id, status, amount, phone, memo, created_at) VALUES (...);', ['insert'])];
    return { lines, note: '실험은 5,000행씩 묶어 넣고 묶음마다 커밋했다. 이 모형은 행 하나씩 PRIMARY에만 넣는다(idx_user는 그리지 않음).', sig: JSON.stringify(cfg) };
  }

  function lockCode() {
    const lines = [L('-- 두 세션 모두 REPEATABLE READ')];
    if (cfg.ix === 'user') lines.push(L(M.INDEXES.idx_user.ddl));
    else lines.push(L('-- 보조 인덱스 없음 (PRIMARY만)'));
    M.LOCK_STEPS.forEach((st, i) => lines.push(Object.assign(L(`${st.s}  ${st.sql.replace('= 42', '= 42').replace('= 9 ', '= 9 ')}`, [`s${i + 1}`]), { sess: st.s })));
    return { lines, note: '줄 앞 글자가 그 문장을 보내는 세션이다. 작은 표에 맞춰 고객 4242는 42로, 17은 9로 바꿨다.', sig: JSON.stringify(cfg) };
  }

  function codeFor() { return isRead() ? readCode() : isSplit() ? splitCode() : lockCode(); }
  function linesOfKey(key) { return code.lines.map((ln, i) => (ln.on.includes(key) ? i : -1)).filter((i) => i >= 0); }

  function renderExplain() {
    const box = $('#explain');
    if (!isRead()) { box.hidden = true; return; }
    box.hidden = false;
    const e = run.explain;
    box.querySelector('dl').innerHTML = [['type', e.type], ['key', e.key || 'NULL'], ['Extra', e.extra || '(없음)']]
      .map(([a, b]) => `<div><dt>${a}</dt><dd><code>${esc(b)}</code></dd></div>`).join('');
  }

  function renderCode(v) {
    const ol = $('#code');
    const fresh = codeFor();
    const sig = `${scene}|${fresh.sig}`;
    if (codeSig !== sig) {
      codeSig = sig;
      code = fresh;
      ol.classList.toggle('with-marks', isLock());
      ol.innerHTML = code.lines.map((ln, i) => `<li data-line="${i}"><span class="marks"></span><span class="ln">${i + 1}</span><code>${esc(ln.t) || ' '}</code></li>`).join('');
      $('#codeNote').textContent = code.note;
      renderExplain();
    }
    const ran = new Set();
    for (const k of v.code) linesOfKey(k).forEach((i) => ran.add(i));
    ol.querySelectorAll('li').forEach((li) => {
      const i = +li.dataset.line;
      li.classList.toggle('ran', ran.has(i));
      const ln = code.lines[i];
      li.querySelector('.marks').innerHTML = isLock() && ln.sess && ran.has(i) ? `<span class="chip run" title="세션 ${ln.sess} · 이 단계에 실행함">${ln.sess}</span>` : '';
    });
  }

  // ---------- 단계 띠 ----------

  function stripCell(k, cls, mark, tip) {
    return `<button type="button" tabindex="-1" class="c ${cls}" data-step="${k}" title="${esc(tip)}">${esc(mark)}</button>`;
  }
  const WASTE = ['drop', 'out', 'icp', 'skip', 'sortout'];
  function readCell(v) {
    const tip = `단계 ${v.label}: `;
    if (v.kind === 'eof') return { text: '끝', cls: 'val', tip: `${tip}더 읽을 것이 없다` };
    if (v.kind === 'sort') return { text: '정렬', cls: 'val changed', tip: `${tip}정렬 버퍼를 정렬해 내보낸다` };
    if (!v.cells.length) return { text: '', cls: 'val', tip: `${tip}읽은 항목 없음` };
    const cell = v.cells[0];
    const pk = cell.startsWith('PRIMARY:');
    const waste = WASTE.includes(v.outcome);
    const keep = v.outcome === 'keep' || v.outcome === 'buf';
    const what = pk ? `PRIMARY 행 id ${rowIdOf(cell)}` : `${cell.split(':')[0]} 항목 ${entryName(cell)}`;
    const how = waste ? '버림' : keep ? (v.outcome === 'buf' ? '정렬 버퍼에 넣음' : '결과에 넣음') : v.kind === 'entry' ? 'PRIMARY로 다시 찾으러 감' : '';
    return { text: String(rowIdOf(cell)), cls: `${pk ? 'pk' : 'ix'}${waste ? ' waste' : ''}${keep ? ' keep' : ''}`, tip: `${tip}${what}${how ? ` · ${how}` : ''}` };
  }
  const LOCK_MARK = (sql) => (/^START/.test(sql) ? '시' : /^COMMIT/.test(sql) ? '확' : /^UPDATE/.test(sql) ? '쓰' : /FOR (UPDATE|SHARE)/.test(sql) ? '잠' : '읽');

  function stripRows() {
    const V = run.views;
    const rows = [];
    const row = (label, fn) => {
      const cells = [];
      for (let k = 1; k < V.length; k++) cells.push(fn(V[k], V[k - 1], k));
      rows.push({ label, cells });
    };
    const val = (v, a, b, tip, bad) => ({ text: String(a), cls: `val${a !== b ? ' changed' : ''}${bad ? ' bad' : ''}`, tip: `단계 ${v.label}: ${tip}` });
    if (isRead()) {
      row('읽은 페이지', (v) => ({ text: v.pages.length ? String(v.pages.length) : '', cls: `val${v.pages.length ? ' changed' : ''}`, tip: `단계 ${v.label}: 읽은 페이지 ${v.pages.length}장${v.pages.length ? ` (${pagesText(v)})` : ''}` }));
      row('읽은 것', (v) => readCell(v));
      row('결과 행', (v, p) => val(v, v.results.length, p.results.length, `결과 ${v.results.length}행`));
      row('논리적 읽기', (v, p) => val(v, v.logical, p.logical, `지금까지 논리적 읽기 ${v.logical}`));
    } else if (isSplit()) {
      row('넣은 키', (v) => ({ text: String(v.key), cls: 'run', tip: `단계 ${v.label}: 키 ${josa(String(v.key), ['을', '를'])} ${pname(v.target)}에 넣음` }));
      row('분할', (v) => ({ text: v.split === 'end' ? '끝' : v.split === 'mid' ? '가운데' : '', cls: v.split === 'mid' ? 'event' : v.split ? 'turn' : 'val', tip: `단계 ${v.label}: ${v.split === 'end' ? '끝 분할' : v.split === 'mid' ? '가운데 분할' : '분할 없음'}` }));
      row('미스', (v) => ({ text: v.miss.length ? String(v.miss.length) : '', cls: `val${v.miss.length ? ' bad' : ''}`, tip: `단계 ${v.label}: 미스 ${v.miss.length ? v.miss.map(pname).join(', ') : '없음'}` }));
      row('축출', (v) => ({ text: v.evicted.length ? String(v.evicted.length) : '', cls: `val${v.evicted.length ? ' changed' : ''}`, tip: `단계 ${v.label}: 축출 ${v.evicted.length ? v.evicted.map((id) => `${pname(id)}${v.flushed.includes(id) ? '(플러시)' : ''}`).join(', ') : '없음'}` }));
      row('리프 수', (v, p) => val(v, v.counts.leaves, p.counts.leaves, `리프 ${v.counts.leaves}장`));
    } else {
      for (const s of ['A', 'B']) {
        row(`세션 ${s}`, (v) => {
          const st = v.sess[s];
          const mine = M.LOCK_STEPS[v.step - 1].s === s;
          const mark = st.state === 'event' ? '기' : mine ? LOCK_MARK(M.LOCK_STEPS[v.step - 1].sql) : '';
          return { text: mark, cls: st.state === 'run' && !mine ? 'turn' : st.state, tip: `단계 ${v.label} · 세션 ${s} · ${STATE_NAME[st.state]}${mine ? ` · ${M.LOCK_STEPS[v.step - 1].sql}` : ''}` };
        });
      }
      row('B가 읽은 합', (v, p) => {
        const a = v.sess.B.last;
        const fresh = a && a.startsWith('합') && a !== p.sess.B.last;
        return { text: fresh ? a.slice(2) : '', cls: `val${fresh ? ' changed' : ''}`, tip: `단계 ${v.label}: ${fresh ? `B가 ${josa(a.slice(2), ['을', '를'])} 읽음` : 'B가 새로 읽은 값 없음'}` };
      });
    }
    return rows;
  }

  const STRIP_NOTE = {
    read: '읽은 것: 칸의 수는 그 항목이나 행의 id다. 테두리 칸은 보조 인덱스 항목, 옅은 파랑 칸은 PRIMARY의 행, 회색 칸은 읽었지만 버린 것, 굵은 글자는 결과나 정렬 버퍼에 넣은 행이다. 논리적 읽기는 그 단계까지의 합이다.',
    split: '분할: 끝은 끝 분할, 가운데는 가운데 분할이다. 미스는 그 단계에 디스크에서 읽어 온 페이지 수, 축출은 버퍼 풀에서 내보낸 페이지 수다(플러시한 것은 굵게).',
    lock: '칸 글자: 시 트랜잭션 시작 · 쓰 UPDATE · 읽 평범한 SELECT · 잠 FOR UPDATE·FOR SHARE · 기 락 기다림 · 확 COMMIT. 채운 칸이 그 단계에 문장을 보낸 세션이다.',
  };

  function buildStrip() {
    const N = lastIdx();
    const strip = $('#strip');
    const values = stripRows();
    const longest = Math.max(0, ...values.flatMap((r) => r.cells.map((c) => textW(String(c.text), 13, 700))));
    const cw = Math.max(30, Math.ceil(longest) + 12);
    strip.style.setProperty('--cw', `${cw}px`);
    strip.style.gridTemplateColumns = `auto repeat(${N}, ${cw}px)`;
    const out = ['<div class="rh">단계</div>'];
    for (let k = 1; k <= N; k++) out.push(`<div class="ch" data-step="${k}">${esc(run.views[k].label)}</div>`);
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

  const STATE_WORD = { used: '결과나 정렬 버퍼에 쓰였다', waste: '읽었지만 버렸다' };
  function readNow(sel, v) {
    const out = [];
    if (sel === 'q') {
      out.push(`계획: type ${run.explain.type}, key ${run.explain.key || 'NULL'}, Extra ${run.explain.extra || '없음'}.`);
      out.push(`지금까지 Handler_read_* ${handlerText(v.handler) || '없음'}, 논리적 읽기 ${v.logical}.`);
      out.push(idx === 0 ? '아직 읽기 전이다.' : v.done ? '쿼리가 끝났다.' : '읽는 중이다.');
    } else if (sel === 'res') {
      out.push(`결과: ${v.results.length ? `id ${v.results.join(', ')}` : '아직 없음'}.`);
      if (run.spec.offset) out.push(`OFFSET으로 세고 버린 행: ${v.skipped.length ? `id ${v.skipped.join(', ')}` : '아직 없음'}.`);
      if (run.spec.limit) out.push(`LIMIT ${run.spec.limit}${v.done && !run.spec.sort ? '을 채워 멈췄다' : ''}.`);
    } else if (sel === 'buf') {
      out.push(`정렬 버퍼: ${v.buffer.length ? `id ${v.buffer.join(', ')}` : '비었다'} (created_at 내림차순, 위 ${(run.spec.limit || 0) + (run.spec.offset || 0)}행).`);
      if (v.kind === 'sort') out.push('끝까지 읽어 정렬을 마치고 결과로 내보냈다.');
    } else if (sel.startsWith('tree:')) {
      const name = sel.slice(5);
      const T = M.tree(name);
      const ids = Object.keys(T.pages);
      const total = ids.reduce((a, id) => a + (v.visits[id] || 0), 0);
      out.push(`이 단계까지 이 인덱스의 페이지를 읽은 횟수: ${total}.`);
      const now = v.pages.filter((id) => id.startsWith(`${name}:`));
      out.push(now.length ? `이 단계에 읽은 페이지: ${now.map((id) => T.pages[id].name).join(', ')}.` : '이 단계에는 이 인덱스를 읽지 않았다.');
      if (name !== 'PRIMARY' && run.index !== name) out.push('이 쿼리는 이 인덱스를 읽지 않는다. 리프의 순서를 보여 주려고 그렸다.');
    } else if (sel.startsWith('page:')) {
      const id = sel.slice(5);
      const P = pageOf(id);
      const tname = id.split(':')[0];
      out.push(`이 단계까지 읽은 횟수: ${v.visits[id] || 0}${v.pages.includes(id) ? ' (이 단계에 읽었다)' : ''}.`);
      if (P.level > 0) out.push(`포인터(자식 페이지의 첫 키): ${P.entries.map((e) => `${ptrText(tname, e)}부터 ${pageOf(e.child).name}`).join(', ')}.`);
      else {
        out.push(`항목(키 순서): ${P.entries.map((e) => (tname === 'PRIMARY' ? `id ${e.row}` : M.entryText(tname, e, longKeys()))).join(', ')}.`);
        out.push(`앞 리프: ${P.prev ? pageOf(P.prev).name : '없음'} · 다음 리프: ${P.next ? pageOf(P.next).name : '없음'}.`);
      }
    } else if (sel.startsWith('ent:')) {
      const id = sel.slice(4);
      const tname = id.split(':')[0];
      const e = entryOf(id);
      if (id.includes('#')) {
        out.push(`자식 페이지: ${pageOf(e.child).name}, 그 페이지의 첫 키 ${ptrText(tname, e)}.`);
        out.push(v.ptrs.includes(id) ? '이 단계에 이 포인터를 따라 내려갔다.' : '이 단계에는 따라가지 않았다.');
      } else {
        const r = M.ROW[e.row];
        if (tname === 'PRIMARY') out.push(`행: id ${r.id}, user_id ${r.user_id}, created_at ${r.created_at}, amount ${num(r.amount)}, phone '${r.phone}'.`);
        else out.push(`키: ${M.keyCols(tname).map((c, i) => `${c} ${valText(c, e.key[i])}`).join(', ')}. 행의 나머지 칼럼은 PRIMARY의 id ${e.row}에 있다.`);
        out.push(`이 단계: ${v.cells.includes(id) ? '읽었다' : '읽지 않았다'}${v.state[id] ? ` · ${STATE_WORD[v.state[id]]}` : ''}.`);
      }
    }
    return out;
  }

  function splitNow(sel, v) {
    const out = [];
    const c = v.counts;
    if (sel === 'ins') {
      if (v.key == null) out.push('아직 넣기 전이다.');
      else out.push(`이 단계에 키 ${josa(String(v.key), ['을', '를'])} ${pname(v.target)}에 넣었다${v.split ? `(${v.split === 'end' ? '끝 분할' : '가운데 분할'}, 새 ${pname(v.made)})` : ''}.`);
      out.push(`넣을 키 순서: ${run.keys.join(', ')}.`);
    } else if (sel === 'sp:R') {
      out.push(`포인터 ${v.leaves.length}개: ${v.leaves.map((l) => (l.keys.length ? `${l.keys[0]}부터 ${pname(l.id)}` : `${pname(l.id)}(빈 리프)`)).join(', ')}.`);
      out.push(`버퍼 풀에서의 상태: ${v.dirty.includes('R') ? '더티 페이지' : '깨끗한 페이지'}.`);
    } else if (sel.startsWith('sp:')) {
      const id = sel.slice(3);
      const l = v.leaves.find((x) => x.id === id);
      if (!l) out.push('이 단계에는 아직 없는 리프다.');
      else {
        out.push(`키: ${l.keys.join(', ') || '없음'} (칸 ${M.LEAF_CAP}개 중 ${l.keys.length}개).`);
        out.push(`버퍼 풀: ${v.lru.includes(id) ? `있다(${v.dirty.includes(id) ? '더티 페이지' : '깨끗한 페이지'})` : '없다(디스크에만 있음)'}.`);
        if (v.made === id) out.push(`이 단계에 ${v.split === 'end' ? '끝 분할' : '가운데 분할'}로 새로 생겼다.`);
        if (v.miss.includes(id)) out.push('이 단계에 디스크에서 읽어 왔다(미스).');
      }
    } else if (sel === 'pool') {
      out.push(`페이지 ${v.lru.length}/${run.frames}장(최근 순): ${v.lru.map(pname).join(', ')}.`);
      out.push(`더티 페이지: ${v.dirty.map(pname).join(', ') || '없음'}.`);
      out.push(`지금까지 논리적 읽기 ${c.logical}, 물리적 읽기 ${c.physical}, 축출 ${c.evictions}, 플러시 ${c.flushes}.`);
    } else if (sel.startsWith('fr:')) {
      const id = sel.slice(3);
      const at = v.lru.indexOf(id);
      if (at < 0) out.push(`${josa(pname(id), ['은', '는'])} 이 단계에 버퍼 풀에 없다.`);
      else {
        out.push(`최근에 쓴 순서로 ${at + 1}번째다(${run.frames}장 중).`);
        out.push(`${v.dirty.includes(id) ? '더티 페이지다. 축출되기 전에 디스크에 쓴다(플러시).' : '깨끗한 페이지다. 축출될 때 쓰지 않는다.'}`);
      }
    } else if (sel === 'disk') {
      out.push(`지금까지 디스크에서 읽은 페이지(물리적 읽기) ${c.physical}, 쓴 페이지(플러시) ${c.flushes}.`);
      if (v.miss.length) out.push(`이 단계에 읽어 온 페이지: ${v.miss.map(pname).join(', ')}.`);
      if (v.flushed.length) out.push(`이 단계에 쓴 페이지: ${v.flushed.map(pname).join(', ')}.`);
    }
    return out;
  }

  function lockNow(sel, v) {
    const out = [];
    if (sel.startsWith('th:')) {
      const s = sel.slice(3);
      const st = v.sess[s];
      const step = M.LOCK_STEPS[v.step - 1];
      if (step && step.s === s) out.push(`이 단계에 ${v.step}번 줄(${step.sql})을 보냈다.`);
      out.push(`단계 끝: ${STATE_NAME[st.state]}${st.trx ? ` · ${st.trx}` : ''}${st.last ? ` · 마지막 결과 ${st.last}` : ''}.`);
      const held = v.locks.filter((l) => l.s === s && l.status === 'GRANTED');
      out.push(`보유한 락 ${held.length}개${held.length ? `: ${held.slice(0, 6).map((l) => `${l.index} ${l.data} ${l.mode}`).join(', ')}${held.length > 6 ? ' 등' : ''}` : ''}.`);
      if (v.wait && v.wait.s === s) out.push(`${v.wait.blocking}의 락에 막혀 기다린다.`);
      if (s === 'B' && v.snapshot) out.push('스냅숏: 4번의 평범한 SELECT 때 만들었다. 평범한 SELECT는 이 스냅숏을 읽는다.');
    } else if (sel.startsWith('rec:')) {
      const id = sel.slice(4);
      const ls = v.locks.filter((l) => l.cell === id);
      if (!id.endsWith(':sup')) {
        const rid = rowIdOf(id);
        const r = M.ROW[rid];
        out.push(`행: id ${rid}, user_id ${r.user_id}, 커밋된 amount ${num(v.amount[rid])}${v.pending[rid] !== undefined ? `, A가 쓰고 커밋 전인 값 ${num(v.pending[rid])}` : ''}.`);
        if (v.snapshot) out.push(`B의 스냅숏에서 이 행의 amount: ${num(v.snapshot[rid])}.`);
      }
      out.push(`락: ${ls.length ? ls.map((l) => `${l.s}의 ${l.mode} (${lockParts(l).rec && lockParts(l).gap ? '넥스트 키 락' : lockParts(l).gap ? '갭 락' : '레코드 락'})${l.status === 'WAITING' ? ' 기다림' : ''}`).join(', ') : '없음'}.`);
    }
    return out;
  }

  function nowLines(sel, v) { return isRead() ? readNow(sel, v) : isSplit() ? splitNow(sel, v) : lockNow(sel, v); }

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
    if (!id) return;
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
    const back = was && $('#board').querySelector(`[data-sel="${was}"][tabindex="0"]`);
    if (inside && back) back.focus();
  }

  // ---------- 진행 ----------

  // 관계도가 칸보다 넓으면(휴대폰 등) 이 단계의 일이 보이도록 관계도 칸을 옆으로 민다.
  // 이 단계에 읽은 페이지가 칸에 다 들어가면 그 범위를, 아니면 마지막에 읽은 페이지를 가운데에 둔다.
  function focusRange(v) {
    const g = geo;
    const span = (list) => (list.length ? [Math.min(...list.map((b) => b[0])), Math.max(...list.map((b) => b[1]))] : null);
    if (isRead()) {
      const ids = v.pages.length ? v.pages : v.cells.map((c) => entryOf(c).page).filter(Boolean);
      const boxes = ids.map((id) => g.pos[id]).filter(Boolean).map((p) => [p.x, p.x + p.w]);
      return { all: span(boxes), last: boxes.length ? boxes[boxes.length - 1] : null };
    }
    if (isSplit()) {
      const order = v.leaves.map((l) => l.id);
      const boxes = [v.target, v.made].filter(Boolean).map((id) => order.indexOf(id)).filter((i) => i >= 0).map((i) => [leafX(g, i), leafX(g, i) + g.leafW]);
      return { all: span(boxes), last: boxes.length ? boxes[0] : null };
    }
    const c = v.wait && g.cellPos[v.wait.cell];
    return c ? { all: [c.x, c.x + c.w], last: [c.x, c.x + c.w] } : { all: null, last: null };
  }
  function focusBoard(v, smooth) {
    const wrap = $('#boardWrap');
    const room = wrap.clientWidth;
    if (wrap.scrollWidth <= room + 1) return;
    const r = focusRange(v);
    const box = r.all && r.all[1] - r.all[0] <= room - 16 ? r.all : r.last;
    if (!box) return;
    if (box[0] >= wrap.scrollLeft + 4 && box[1] <= wrap.scrollLeft + room - 4) return;
    const left = Math.max(0, Math.min(wrap.scrollWidth - room, (box[0] + box[1]) / 2 - room / 2));
    wrap.scrollTo({ left, behavior: smooth && !motionOff.matches ? 'smooth' : 'auto' });
  }

  function render(animate) {
    const v = view();
    $('#board').classList.toggle('instant', !(animate && !motionOff.matches));
    renderBoard(v);
    focusBoard(v, animate);
    renderCaption(v);
    renderTally(v);
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

  const items = (obj) => Object.entries(obj).map(([k, d]) => [k, d.label]);
  const OPTS = {
    find: [{ label: '고객', key: 'user', items: [['42', '42 (주문 2건)'], ['1', '1 (주문 6건)']] }, { label: '인덱스', key: 'ix', items: items(M.FIND_IX) }],
    order: [{ label: '인덱스', key: 'ix', items: items(M.ORDER_IX) }, { label: 'WHERE 순서', key: 'cond', items: [['user_first', 'user_id 먼저'], ['created_first', 'created_at 먼저']] }],
    unused: [{ label: '쿼리', key: 'q', select: true, items: items(M.UNUSED_Q) }],
    sort: [{ label: '인덱스', key: 'ix', items: items(M.SORT_IX) }],
    page: [{ label: '다음 페이지를 읽는 방법', key: 'way', select: true, items: items(M.PAGE_WAYS) }, { label: '페이지', key: 'page', items: [['2', '2번째'], ['3', '3번째']] }],
    split: [{ label: '기본 키', key: 'pk', items: items(M.PK_KEYS) }, { label: '버퍼 풀', key: 'pool', items: items(M.POOLS) }],
    lock: [{ label: '경우', key: 'ix', items: [['none', '(가) 보조 인덱스 없음'], ['user', '(나) idx_user']] }],
  };

  // 구성마다 실험에서 짝이 되는 경우. 맥 본 측정에 같은 쿼리가 있으면 그 경우를, 컨테이너에서만 봤으면 그 사실을 적는다.
  const PAIRS = {
    find: { '42|none': '문제 상황 1 (가)', '42|user': '문제 상황 1 (나)', '42|user_created': '문제 상황 1 (다)', '1|none': '문제 상황 1-1 (가)', '1|user': '문제 상황 1-1 (나)',
      '1|user_created': '문제 상황 1-1 (다)', '1|covering': '문제 상황 1-1 (마)' },
    order: { 'user_created|user_first': '문제 상황 1 (다)', 'created_user|user_first': '문제 상황 1 (라)' },
    unused: { 'day-func': '문제 상황 1-3 (가)', 'day-fix': '1-3 고쳐 쓴 (가)', 'day-range': '1-3 견줄 쿼리: 하루 구간', 'phone-number': '문제 상황 1-3 (나)',
      'phone-string': "1-3 견줄 쿼리: phone = '01009234282'", 'phone-suffix': '문제 상황 1-3 (다)', 'phone-prefix': "1-3 견줄 쿼리: LIKE '0100923%'",
      'user-string': '문제 상황 1-3 (라)', 'user-int': '1-3 견줄 쿼리: user_id = 4242' },
    sort: { none: '문제 상황 2 (가)', created: '문제 상황 2 (나)', user: '문제 상황 2 (다)', user_created: '문제 상황 2 (라)' },
    page: { 'offset|2': '2-1 FORCE INDEX + OFFSET 100000', 'offset|3': '2-1 OFFSET 3380(170번째 페이지)', 'asc|2': '2-1 (나) 사람이 쓴 커서, 하이픈만 고침',
      'lt|2': '2-1 다시 쓴 커서(5,001번째)', 'lt|3': '2-1 다시 쓴 커서(170번째)', 'or|2': '2-1 OR 꼴 커서(5,001번째)', 'or|3': '2-1 OR 꼴 커서(170번째)', 'row|2': '2-1 행 생성자 커서' },
  };
  const CONTAINER = {
    find: { '42|covering': '고객 4242를 (user_id, created_at, amount)로 읽은 판(0.007~0.008ms)' },
    order: { force: '(라)에 FORCE INDEX를 붙인 판(15.0~15.9ms)', created_first: 'WHERE 조건의 순서만 바꾼 판(질문 6, 계획이 같았다)' },
    sort: { between: '목표 1 확인의 쿼리 2(1.89~2.75ms)' },
    page: { le: '<=로 쓴 커서(경계 행이 다시 나옴)' },
  };
  function pairNote() {
    if (isSplit()) {
      const pool = cfg.pool === 'big' ? '1GB' : '128MB';
      return `이 구성은 맥 본 측정 ④ ${M.PK_KEYS[cfg.pk].label}의 버퍼 풀 ${pool}에 해당한다. 버퍼 풀 8페이지는 표가 다 들어가는 1GB의 경우를, 4페이지는 표가 버퍼 풀보다 큰 128MB의 경우를 줄여 그린 것이다.`;
    }
    if (isLock()) return '이 장면은 컨테이너 확인(판정용 아님)의 04 변형 순서표를 그린다. 맥에서는 재지 않았다.';
    const key = Object.values(cfg).join('|');
    const c = CONTAINER[scene] || {};
    const cont = c[key] || c[cfg.ix] || c[cfg.cond] || c[cfg.way];
    if (cont) return `이 구성은 컨테이너 확인(판정용 아님)만 있다: ${cont}.`;
    const pair = (PAIRS[scene] || {})[key];
    if (pair && run.raw) return `이 구성은 맥 본 측정의 ${josa(pair, ['과', '와'])} 짝이다. 계획(type, key, Extra)과 Handler_read_*의 꼴이 원자료와 같은지 model.test.cjs로 확인했다.`;
    return '이 구성은 실험에서 돌리지 않았다. 모형으로만 그린 것이다.';
  }

  const BOARD_NOTE = {
    read: '위 줄은 쿼리, 정렬 버퍼, 결과다. 그 아래에 보조 인덱스(있으면)와 PRIMARY를 루트, 중간, 리프의 3층으로 그렸다. 루트·중간 페이지의 칸은 노드 포인터(자식 페이지의 첫 키)이고, 리프의 줄 하나가 항목 하나다. 보조 인덱스 항목의 옅은 글자는 끝에 붙은 기본 키 id다. 페이지 이름 옆 숫자는 이 단계까지 그 페이지를 읽은 횟수(논리적 읽기)다. 리프 사이의 짧은 선은 앞뒤 리프의 페이지 번호이고, 점선 곡선은 보조 인덱스 항목의 id로 PRIMARY를 루트부터 다시 찾는 두 번 읽기다.',
    split: '위의 INSERT 상자가 이 단계에 넣는 키다. 루트의 칸은 리프마다 하나인 노드 포인터이고, 리프는 키 순서로 놓았다. 아래 줄은 버퍼 풀의 페이지를 최근에 쓴 순서로 늘어놓은 것이다(왼편이 가장 최근). 파랑 테두리는 더티 페이지, 점선 테두리는 버퍼 풀에 없는 페이지, 주황 테두리는 이 단계에 디스크에서 읽어 온 페이지다.',
    lock: '세션 원 아래 글줄은 위에서부터 상태, 트랜잭션, 마지막 결과다. 그 아래에는 락이 걸리는 리프만 그렸다(루트와 중간 페이지는 뺐다). 레코드 칸의 테두리는 레코드 락, 왼편 막대는 그 레코드 앞 갭의 락이고, 둘 다 있으면 넥스트 키 락이다. 이름표 "X A"는 A가 보유한 배타 락, "S B"는 B의 공유 락이다. 점선 테두리와 회색 점선은 기다리는 락이다. PRIMARY 칸의 아래 줄은 amount이고, A가 쓰고 커밋하기 전이면 새 값을 파랑으로 함께 적는다.',
  };

  function legendHtml() {
    if (isRead()) {
      return '<li><i class="pg-sw hit"></i>이 단계에 읽은 페이지</li><li><i class="pg-sw seen"></i>읽은 적 있는 페이지</li><li><i class="ent-sw cur"></i>이 단계에 읽은 항목</li>'
        + '<li><i class="ent-sw used"></i>쓰인 항목</li><li><i class="ent-sw waste"></i>버린 항목</li><li><i class="cnl"></i>따라간 포인터</li><li><i class="cnl look"></i>두 번 읽기</li>'
        + '<li><i class="chip-sw"></i>결과 행 (글자는 id)</li>';
    }
    if (isSplit()) {
      return '<li><i class="pg-sw dirty"></i>더티 페이지</li><li><i class="pg-sw absent"></i>버퍼 풀에 없는 페이지</li><li><i class="pg-sw miss"></i>디스크에서 읽어 온 페이지(미스)</li>'
        + '<li><i class="ent-sw cur"></i>이 단계에 넣은 키</li><li><i class="ent-sw used"></i>가운데 분할로 옮긴 키</li>';
    }
    return '<li><i class="shape circle"></i>세션</li><li><i class="sw run"></i>실행 중</li><li><i class="sw"></i>차례 기다림</li><li><i class="sw event"></i>락 기다림</li><li><i class="sw done"></i>끝</li>'
      + '<li><i class="lk-sw nk"></i>넥스트 키 락</li><li><i class="lk-sw gap"></i>갭 락</li><li><i class="lk-sw rec"></i>레코드 락</li><li><i class="lk-sw wait"></i>기다리는 락</li>';
  }

  function content() { return RC.SCENES[scene] || { questions: [], observe: [], measured: [], evidence: [], cards: [] }; }
  function guessKey() { return `index-board-${scene}-guess`; }

  function buildSceneButtons() {
    $('#scenes').innerHTML = GROUPS.map(([key, label]) => `<div class="scene-group" role="group" aria-label="${esc(label)}">`
      + `<span class="group-label" aria-hidden="true">${esc(label)}</span>`
      + Object.entries(SCENES).filter(([, d]) => d.group === key).map(([k, d]) => `<button type="button" data-scene="${k}">${esc(d.label)}</button>`).join('')
      + '</div>').join('');
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

  // 장면별 조절. 고를 것이 많으면 목록 상자로 둔다.
  function buildOpts() {
    const list = OPTS[scene];
    $('#opts').innerHTML = list.map((o, i) => {
      if (o.select) {
        return `<div class="scope"><label for="opt${i}">${esc(o.label)}</label><select id="opt${i}" data-opt-sel="${o.key}">`
          + o.items.map(([val, label]) => `<option value="${val}"${cfg[o.key] === val ? ' selected' : ''}>${esc(label)}</option>`).join('') + '</select></div>';
      }
      return `<div class="scope" role="group" aria-labelledby="opt${i}"><span id="opt${i}">${esc(o.label)}</span>`
        + o.items.map(([val, label]) => `<button type="button" data-opt="${o.key}" data-val="${val}" aria-pressed="${String(cfg[o.key] === val)}">${esc(label)}</button>`).join('') + '</div>';
    }).join('') + `<p id="pairNote" class="note">${esc(pairNote())}</p>`;
  }

  function cfgNote() {
    if (isSplit()) return '실험은 조건마다 워밍업 1회와 3회를 돌렸다. 이 모형은 행 16개와 버퍼 풀 몇 페이지로 줄여 분할과 축출의 순서만 그린다. 시간은 그리지 않는다.';
    if (isLock()) return '실험(컨테이너 확인)은 한 번 돌렸고, 5번을 보낸 뒤 약 2초 뒤에 6번을 보냈다. 이 화면은 그 순서를 그린다.';
    return '실험은 쿼리마다 워밍업 1회와 3회를 돌렸고 Handler_read_*는 세 번 모두 같았다. 이 화면은 행 16개짜리 작은 표로 같은 계획을 그린다. 작은 표에서 읽은 수는 실험의 수와 비례하지 않는다.';
  }
  function buildCfg() {
    $('#cfg').innerHTML = `<p class="note">${esc(cfgNote())}</p>`;
    $('#boardNote').textContent = BOARD_NOTE[run.kind];
  }

  function sceneTitle() {
    if (!isRead()) return run.title;
    const labelOf = (obj, k) => (obj[k] ? obj[k].label : k);
    const sub = {
      find: () => `고객 ${cfg.user} · ${labelOf(M.FIND_IX, cfg.ix)}`,
      order: () => `${labelOf(M.ORDER_IX, cfg.ix)}${cfg.cond === 'created_first' ? ' · WHERE 순서 바꿈' : ''}`,
      unused: () => labelOf(M.UNUSED_Q, cfg.q),
      sort: () => labelOf(M.SORT_IX, cfg.ix),
      page: () => `${labelOf(M.PAGE_WAYS, cfg.way)} · ${cfg.page}번째 페이지`,
    }[scene]();
    return `${M.SCENARIOS[scene].title} · ${sub}`;
  }

  function syncControls() {
    buildOpts();
    buildCfg();
    $('#sceneTitle').textContent = sceneTitle();
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
    if (sel && sel.dataset.sel && (e.key === 'Enter' || e.key === ' ')) { select(sel.dataset.sel); e.preventDefault(); return; }
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
    $('#board').addEventListener('click', (e) => {
      const n = e.target.closest('[data-sel]');
      if (n && n.dataset.sel) select(n.dataset.sel);
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
  window.__indexBoard = { get scene() { return scene; }, get cfg() { return cfg; }, get idx() { return idx; }, get run() { return run; },
    get geo() { return geo; }, get code() { return code; }, get selected() { return selected; }, go, setConfig, setScene, select, linesOfKey, typeOf, nameOf };
})();
