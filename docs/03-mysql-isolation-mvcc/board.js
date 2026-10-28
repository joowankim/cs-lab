/*
 * MVCC 관계도: 위에는 전체 지도 하나, 아래에는 고른 장면의 관계도.
 * 모든 장면은 model.js가 만든 단계 기록을 그대로 그린다. 순서표 장면은 실험의 순서표 한 줄이 한 단계다.
 * 세션의 실행 여부(채움, 코드 이름표, 단계 띠 칸)는 그 단계 동안의 상태이고, 트랜잭션·스냅숏·행 버전·락·로그 위치와
 * 쥔 것과 기다리는 것을 잇는 선은 그 단계가 끝난 뒤의 상태다.
 * 연결선은 두 끝에서 세로로 나가고 들어오는 곡선이다. 파란 선은 쥔 락, 회색 점선은 기다림, 회색 실선은 정리나 로그 쓰기,
 * 주황은 문제(오류, 갱신 손실, 지우지 못한 이전 버전, 잃은 커밋, 기다림의 고리)다.
 * 표 상자 안의 칸 하나가 행 하나이고, 칸 안의 작은 상자가 그 행의 버전이다(맨 위가 가장 새 버전).
 * 관계도의 요소를 고르면 설명 칸에 그 요소의 개념, 지금 상태, 근거가 나온다.
 * 단계는 이벤트의 순서이고 시간 길이가 아니다.
 *
 * 장면을 더하려면 model.js에 장면을 만들고, 여기의 SCENES와 장면별 함수(objectList, codeFor, valueRows, resultText,
 * partsFor, renderCounts)에 그 장면을 더하고, content.js의 SCENES에 같은 이름으로 질문, 볼 것, 실측 기록, 근거를 적는다.
 */
(function () {
  'use strict';

  const M = window.MvccModel;
  const RC = window.MvccContent || { SCENES: {}, ELEMENTS: {}, EV: {}, CARDS: {}, TYPE_LABEL: {} };
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const motionOff = window.matchMedia('(prefers-reduced-motion: reduce)');

  const SPEEDS = [{ label: '느리게', ms: 2000 }, { label: '보통', ms: 1200 }, { label: '빠르게', ms: 600 }];
  const SCENE_KEY = 'mvcc-board-scene';
  const DEFAULT_SCENE = 'count';
  // 세션 상자의 가장 좁은 너비. 관계도가 이보다 좁아지면 줄이지 않고 관계도 칸 안에서 옆으로 밀어 보게 한다.
  const BOX_MIN = 64;
  const CHIP_H = 20;
  const CHIP_GAP = 4;

  const SCENES = {
    count: { group: 'snap', label: '스냅숏을 만드는 때' },
    report: { group: 'snap', label: '잔액 세 번 읽기' },
    locking: { group: 'lock', label: '잠그며 읽기' },
    deduct: { group: 'lock', label: '동시 차감' },
    hold: { group: 'old', label: '열어 둔 트랜잭션' },
    engine: { group: 'durable', label: 'InnoDB와 MyISAM' },
    commit: { group: 'durable', label: '커밋을 디스크에' },
  };
  const GROUPS = [['snap', '스냅숏과 읽기'], ['lock', '잠금과 쓰기'], ['old', '이전 버전'], ['durable', '엔진과 지속성']];
  const TIMELINE_SCENES = ['count', 'report', 'locking', 'deduct', 'engine'];

  // 설명 한 문장으로 고를 이벤트. 문제를 알리는 이벤트(bad)를 먼저 고르고, 없으면 그 단계에 보낸 문장의 결과(첫 이벤트)를 고른다.
  // 커밋 장면은 한 단계에 로그 여러 개의 일이 겹치므로 아래 순서로 고른다.
  const BAD_ORDER = ['error', 'lost', 'dirty', 'changed', 'warning', 'kept', 'crash'];
  const COMMIT_ORDER = ['fsync', 'ack', 'bg', 'write', 'fsync-done', 'os', 'start'];
  // 단계 띠 칸에 적는 글자: 그 단계에 그 세션이 한 일. 여러 개면 앞의 것을 적는다.
  const MARKS = [
    ['!', ['error']],
    ['확', ['commit']],
    ['되', ['rollback', 'warning']],
    ['쓰', ['write', 'lost']],
    ['잠', ['lockread']],
    ['읽', ['read', 'dirty', 'long', 'long-end']],
    ['시', ['begin', 'snap']],
    ['정', ['prune', 'purge', 'vacuum', 'kept']],
    ['내', ['fsync', 'bg']],
    ['완', ['ack']],
  ];
  const STATE_NAME = { run: '실행 중', turn: '차례 기다림', event: '기다림', done: '끝' };
  const LOCK_NAME = { S: '공유 락', X: '배타 락', GS: '범위 공유 락', GX: '범위 배타 락', R: '표 읽기 락', W: '표 쓰기 락' };
  const LEVEL_SQL = { mysql: 'SET SESSION TRANSACTION ISOLATION LEVEL', postgres: 'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL' };

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
  // 설명 칸에 보이는 요소(th:세션, tb:표, row:표:키, gap:표, cnt, log:로그)와, 고정된 설명을 마지막으로 채운 요소
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
    const k = s.lastIndexOf(' ');
    return k < 0 ? [s, ''] : [s.slice(0, k), s.slice(k + 1)];
  }
  const josa = (w, pair) => M.josa(w, pair);

  function view() { return run.views[idx]; }
  function lastIdx() { return run.views.length - 1; }
  function threads() { return run.threads; }
  function thread(id) { return run.threads.find((t) => t.id === id); }
  function tIndex(id) { return run.threads.findIndex((t) => t.id === id); }
  function isTimeline() { return TIMELINE_SCENES.includes(scene); }
  function dbOf() { return cfg.db || 'mysql'; }
  function stateText(s) { return `${STATE_NAME[s.cls]}${s.why && s.why !== STATE_NAME[s.cls] ? ` (${s.why})` : ''}`; }
  function tables(v) { return Object.values(v.obj).filter((o) => o.type === 'table'); }
  function logs(v) { return Object.values(v.obj).filter((o) => o.type === 'log'); }
  function resWord(res) {
    const [t, k] = res.split(':');
    if (k === 'gap') return `${t}의 행 사이 범위`;
    if (k === 'table') return `${t} 표`;
    if (!t || k == null) return logName(res);
    return `${t}의 행 ${k}`;
  }
  function logName(id) { return { redo: 'redo log', binlog: 'binary log', wal: 'WAL' }[id] || id; }
  function locksOn(v, res) { return v.locks.filter((l) => l.res === res); }
  function lockText(list) {
    const by = {};
    for (const l of list) (by[l.mode] = by[l.mode] || []).push(l.sess);
    return Object.entries(by).map(([m, ss]) => `${m} ${ss.join('·')}`).join(' ');
  }

  // ---------- 요소 이름과 고르기 ----------

  function typeOf(sel) {
    if (sel.startsWith('th:')) {
      const id = sel.slice(3);
      return { P: 'purge', V: 'vacuum', app: 'app', W: 'writer' }[id] || 'session';
    }
    if (sel.startsWith('tb:')) {
      const t = run.views[0].obj[sel.slice(3)];
      return t.engine === 'myisam' ? 'table-myisam' : dbOf() === 'postgres' ? 'table-pg' : 'table-innodb';
    }
    if (sel.startsWith('row:')) return 'row';
    if (sel.startsWith('gap:')) return 'gap';
    if (sel === 'cnt') return dbOf() === 'postgres' ? 'counter-pg' : 'counter-mysql';
    return `log-${sel.slice(4)}`;
  }

  function threadTitle(t) {
    if (t.id === 'P') return 'purge 스레드';
    if (t.id === 'V') return 'VACUUM';
    if (t.id === 'app') return '앱';
    if (t.id === 'W') return t.name;
    if (scene === 'hold') return { A: '세션 A (열어 둔 트랜잭션)', B: '세션 B (고치는 쪽)', C: '세션 C (새로 읽는 쪽)' }[t.id];
    return `세션 ${t.name}`;
  }
  // 세션 원 안에 적는 글자
  function circleText(t) { return t.id === 'app' ? '앱' : t.id; }
  // 단계 띠 줄 이름
  function rowName(t) {
    if (t.id === 'P') return 'purge';
    if (t.id === 'V') return 'VACUUM';
    if (t.id === 'app') return '앱';
    if (t.id === 'W') return t.name;
    return `세션 ${t.name}`;
  }
  // 트랜잭션 줄이 비는 상자(백그라운드 스레드, 앱)에 적는 맡은 일
  function roleText(t) {
    if (t.id === 'P') return 'purge 스레드';
    if (t.id === 'V') return 'VACUUM';
    if (t.id === 'app') return '자동 커밋 INSERT';
    if (t.id === 'W') return t.name;
    return '';
  }
  function tableTitle(o) { return `${o.name} · ${o.engine === 'myisam' ? 'MyISAM' : dbOf() === 'postgres' ? 'PostgreSQL' : 'InnoDB'}`; }
  function nameOf(sel) {
    const v = view() || run.views[0];
    if (sel.startsWith('th:')) return threadTitle(thread(sel.slice(3)));
    if (sel.startsWith('tb:')) return `표 ${tableTitle(run.views[0].obj[sel.slice(3)])}`;
    if (sel.startsWith('row:')) { const [, t, k] = sel.split(':'); return `${t}의 행 ${geo && geo.keyName ? geo.keyName[t] : 'id'} ${k}`; }
    if (sel.startsWith('gap:')) return `${sel.slice(4)}의 행 사이 범위`;
    if (sel === 'cnt') return dbOf() === 'postgres' ? 'dead tuple' : 'History list length';
    const o = v.obj[sel.slice(4)];
    return o ? o.name : sel;
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
    geo = layoutRow();
    const g = geo;
    const svg = $('#board');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
    svg.style.width = g.scroll ? `${g.W}px` : '';
    svg.style.maxWidth = g.scroll ? 'none' : '';
    svg.classList.toggle('compact', g.compact);
    g.nodes = {};
    drawThreadBoxes(svg, g);
    drawObjects(svg, g);
    // 연결선은 표 상자 위에 그린다. 표 안의 행 칸으로 가는 선이 표 상자의 테두리를 지나 보이게 하려는 것이다.
    g.cnG = el('g', { class: 'cns' }, svg);
    drawThreads(svg, g);
  }

  function renderBoard(v) {
    renderThreads(v);
    renderObjects(v);
    renderLinks(v);
    markSelected();
  }

  // ---------- 배치 ----------
  // 위에 세션 상자를 한 줄로 두고, 아래에 표, 정리 상자, 로그 상자를 둔다. 세션 상자에는 원과 그 세션만의 것
  // (상태, 트랜잭션, 스냅숏, 마지막 결과)만 담는다. 선이 들어오는 상자는 한 줄에 둔다.

  // 세션 상자의 글줄. 커밋 장면에는 트랜잭션과 스냅숏이 없으므로 맡은 일만 적는다.
  function slotsFor() { return scene === 'commit' ? ['why', 'trx', 'local'] : ['why', 'trx', 'snap', 'local']; }
  function slotText(slot, s, t) {
    if (slot === 'why') return s.cls === 'run' ? '' : s.why;
    if (slot === 'trx') return s.trx || roleText(t);
    if (slot === 'snap') return s.snap || '';
    return s.err || s.local || '';
  }

  function layoutRow() {
    const ths = threads();
    const T = ths.length;
    const avail = Math.floor($('#boardWrap').clientWidth) || 600;
    const compact0 = avail < 480;
    const linked = objectList(compact0).filter((b) => b.link);
    const rowNeed = 12 + linked.reduce((sum, b) => sum + b.w, 0) + 8 * (linked.length - 1);
    const W = Math.ceil(Math.max(260, 12 + T * BOX_MIN + (T - 1) * 4, rowNeed, Math.min(680, avail)));
    const compact = W < 480;
    const m = compact ? 6 : 12;
    const sep = compact ? 4 : 10;
    const r = compact ? 15 : 17;
    const g = { W, compact, scroll: W > avail + 1, m, sep, r, gap: compact ? 8 : 14, fs: compact ? 11 : 12, lh: compact ? 14 : 15 };
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
      g.stack[slot] = run.views.some((v) => ths.some((t) => textW(slotText(slot, v.th[t.id], t), g.fs, slot === 'local' ? 600 : 400) > g.fit));
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

  // 표 하나의 칸. 모든 단계에 나오는 행을 미리 모아 칸 자리를 정해 둔다. 아직 없는 행의 칸은 비워 둔다.
  function tableShape(id, c) {
    const fs = c ? 11 : 12;
    const pad = c ? 4 : 6;
    const V = run.views;
    const o0 = V[0].obj[id];
    const keys = [...new Set(V.flatMap((v) => v.obj[id].rows.map((r) => r.k)))].sort((a, b) => a - b);
    const keyName = o0.key === 'user_id' ? 'user_id' : 'id';
    const cols = keys.map((k) => {
      let chips = 1;
      let chipW = 30;
      let markW = 0;
      let lockW = 0;
      for (const v of V) {
        const row = v.obj[id].rows.find((r) => r.k === k);
        lockW = Math.max(lockW, textW(lockText(locksOn(v, `${id}:${k}`)), fs, 600));
        if (!row) continue;
        chips = Math.max(chips, row.vers.length);
        for (const ver of row.vers) {
          chipW = Math.max(chipW, textW(ver.text, fs) + 14);
          if (ver.seen.length) markW = Math.max(markW, textW(`←${ver.seen.join('')}`, fs, 600) + 3);
        }
      }
      const w = Math.ceil(Math.max(chipW + markW, textW(`${keyName} ${k}`, fs) + 8, lockW + 8) + 2 * pad);
      return { k, kind: 'row', w, chips, chipW, markW };
    });
    if (o0.gap) {
      let lockW = 0;
      for (const v of V) lockW = Math.max(lockW, textW(lockText(locksOn(v, `${id}:gap`)), fs, 600));
      cols.push({ k: 'gap', kind: 'gap', w: Math.ceil(Math.max(textW('행 사이', fs) + 8, lockW + 8) + 2 * pad), chips: 0 });
    }
    const chips = Math.max(1, ...cols.map((x) => x.chips));
    const colGap = c ? 4 : 6;
    const inner = cols.reduce((sum, x) => sum + x.w, 0) + colGap * Math.max(0, cols.length - 1);
    const tl = o0.engine === 'myisam';
    const title = tableTitle(o0);
    const w = Math.ceil(Math.max(inner, textW(title, fs) + 4, tl ? textW('표 락 R A · 기다림 W B', fs, 600) : 0, c ? 70 : 90) + 16);
    const colH = 30 + chips * (CHIP_H + CHIP_GAP) + 2;
    const top = tl ? 22 : 8;
    return { id, kind: 'table', w, h: top + colH + 24, cols, colGap, top, colH, keyName, myisam: tl, link: true, fs, pad };
  }

  function logShape(o, c) {
    const fs = c ? 11 : 12;
    const n = cfg.commits;
    const chipW = c ? 22 : 50;
    const bands = cfg.crash === 'none' ? ['mem', 'os', 'disk'] : ['mem', 'os', 'disk', 'lost'];
    const bandW = Math.max(textW('OS 페이지 캐시', fs) + 12, n * (chipW + 4) + 8);
    const sync = syncText(o);
    const w = Math.ceil(Math.max(bandW, textW(o.name, fs), textW(sync, fs)) + 16);
    return { id: o.id, kind: 'log', w, h: 44 + bands.length * 44, bands, chipW, link: true, fs };
  }
  function syncText(o) {
    if (o.id === 'binlog') return o.sync ? 'sync_binlog=1: 커밋마다 fsync' : 'sync_binlog=0: OS에 맡김';
    if (o.id === 'redo') return o.sync ? '커밋마다 fsync' : '커밋마다 OS에 쓰기만';
    return o.sync ? '커밋마다 fsync' : '커밋이 기다리지 않음';
  }

  // 장면마다 상자와 크기. link는 세션에서 선이 들어오는 상자다.
  function objectList(c) {
    const v0 = run.views[0];
    const out = [];
    for (const o of tables(v0)) out.push(tableShape(o.id, c));
    if (scene === 'hold') {
      const fs = c ? 11 : 12;
      const name = dbOf() === 'postgres' ? 'dead tuple' : 'History list length';
      out.push({ id: 'cleanup', kind: 'counter', w: Math.ceil(Math.max(textW(name, fs) + 20, textW('A의 스냅숏이 붙잡음', fs, 600) + 20, 110)), h: 72, link: false });
    }
    for (const o of logs(v0)) out.push(logShape(o, c));
    return out;
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
    g.keyName = {};
    let y = g.objTop;
    rows.forEach((row, k) => {
      const total = row.reduce((sum, b) => sum + b.w, 0) + gap * (row.length - 1);
      let x = (g.W - total) / 2;
      for (const b of row) {
        b.x = x;
        b.y = y;
        x += b.w + gap;
        g.objs[b.id] = b;
      }
      y += Math.max(...row.map((b) => b.h)) + (k < rows.length - 1 ? 14 : 0);
    });
    g.H = y + 8;
    // 선이 들어오는 자리: 행 칸과 범위 칸은 그 칸의 위쪽 가장자리, 표 락과 정리는 표 상자의 위쪽 가장자리, 로그는 로그 상자의 위쪽 가장자리.
    for (const b of Object.values(g.objs)) {
      if (b.kind === 'table') {
        g.keyName[b.id] = b.keyName;
        g.anchor[`${b.id}:table`] = { x: b.x, y: b.y, w: b.w };
        let cx = b.x + (b.w - (b.cols.reduce((s, c) => s + c.w, 0) + b.colGap * Math.max(0, b.cols.length - 1))) / 2;
        for (const c of b.cols) {
          c.x = cx;
          c.y = b.y + b.top;
          cx += c.w + b.colGap;
          g.anchor[`${b.id}:${c.k}`] = { x: c.x, y: c.y, w: c.w };
        }
      } else if (b.kind === 'log') {
        g.anchor[b.id] = { x: b.x, y: b.y, w: b.w };
      }
    }
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
    for (const b of Object.values(g.objs)) {
      if (b.kind === 'table') drawTable(layer, g, b);
      else if (b.kind === 'counter') {
        const n = objGroup(layer, 'cnt', 'obj counter');
        el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, n);
        el('text', { class: 'lbl', x: b.x + 10, y: b.y + 18 }, n, dbOf() === 'postgres' ? 'dead tuple' : 'History list length');
        el('text', { class: 'state s1', x: b.x + 10, y: b.y + 42 }, n, '');
        el('text', { class: 'sub s2', x: b.x + 10, y: b.y + 60 }, n, '');
        g.nodes.cnt = n;
      } else if (b.kind === 'log') drawLog(layer, g, b);
    }
  }

  // 표 상자: 이름은 아래쪽 왼편에 적는다(안의 칸을 가리지 않게). MyISAM 표는 위쪽에 표 락 줄을 둔다.
  function drawTable(layer, g, b) {
    const n = objGroup(layer, `tb:${b.id}`, 'obj table');
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, n);
    el('text', { class: 'lbl', x: b.x + 8, y: b.y + b.h - 8 }, n, tableTitle(run.views[0].obj[b.id]));
    if (b.myisam) el('text', { class: 'tlock', x: b.x + 8, y: b.y + 16 }, n, '');
    el('text', { class: 'empty-note', x: b.x + b.w / 2, y: b.y + b.top + b.colH / 2 + 4, 'text-anchor': 'middle' }, n, '');
    g.nodes[`tb:${b.id}`] = n;
    for (const c of b.cols) {
      const sel = c.kind === 'gap' ? `gap:${b.id}` : `row:${b.id}:${c.k}`;
      const cn = objGroup(layer, sel, `col ${c.kind}`);
      cn.dataset.k = String(c.k);
      el('rect', { x: c.x, y: c.y, width: c.w, height: b.colH, rx: 6 }, cn);
      el('text', { class: 'head', x: c.x + c.w / 2, y: c.y + 14, 'text-anchor': 'middle' }, cn, c.kind === 'gap' ? '행 사이' : `${b.keyName} ${c.k}`);
      el('text', { class: 'lk', x: c.x + c.w / 2, y: c.y + 28, 'text-anchor': 'middle' }, cn, '');
      for (let i = 0; i < c.chips; i++) {
        const cy = c.y + 34 + i * (CHIP_H + CHIP_GAP);
        const chip = el('g', { class: 'ver', 'data-i': String(i) }, cn);
        el('rect', { x: c.x + b.pad, y: cy, width: c.chipW, height: CHIP_H, rx: 4 }, chip);
        el('text', { class: 'vt', x: c.x + b.pad + c.chipW / 2, y: cy + 14, 'text-anchor': 'middle' }, chip, '');
        el('text', { class: 'seen', x: c.x + b.pad + c.chipW + 3, y: cy + 14 }, chip, '');
      }
      g.nodes[sel] = cn;
    }
  }

  const BAND_NAME = { mem: 'DB 메모리', os: 'OS 페이지 캐시', disk: '디스크', lost: '사라짐' };
  function drawLog(layer, g, b) {
    const n = objGroup(layer, `log:${b.id}`, 'obj log');
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8 }, n);
    el('text', { class: 'title', x: b.x + 8, y: b.y + 17 }, n, logName(b.id));
    el('text', { class: 'lbl sync', x: b.x + 8, y: b.y + 33 }, n, syncText(run.views[0].obj[b.id]));
    b.bands.forEach((band, i) => {
      const y = b.y + 42 + i * 44;
      const bg = el('g', { class: `band ${band}`, 'data-band': band }, n);
      el('rect', { x: b.x + 6, y, width: b.w - 12, height: 40, rx: 5 }, bg);
      el('text', { class: 'lbl', x: b.x + 12, y: y + 14 }, bg, BAND_NAME[band]);
      for (let k = 0; k < cfg.commits; k++) {
        const cg = el('g', { class: 'lchip', 'data-k': String(k) }, bg);
        el('rect', { x: b.x + 12 + k * (b.chipW + 4), y: y + 19, width: b.chipW, height: 17, rx: 4 }, cg);
        el('text', { x: b.x + 12 + k * (b.chipW + 4) + b.chipW / 2, y: y + 32, 'text-anchor': 'middle' }, cg, '');
      }
    });
    g.nodes[`log:${b.id}`] = n;
  }

  function renderThreads(v) {
    const svg = $('#board');
    for (const t of threads()) {
      const s = v.th[t.id];
      const node = svg.querySelector(`.th[data-id="${t.id}"]`);
      setCls(node, `th ${s.cls}${s.err ? ' has-err' : ''}`);
      for (const slot of geo.slots) {
        const tx = node.querySelector(`[data-slot="${slot}"]`);
        const text = slotText(slot, s, t);
        const [a, b] = geo.stack[slot] ? fitLines(text, geo.fs, slot === 'local' ? 600 : 400, geo.fit) : [text, ''];
        tx.querySelector('.a').textContent = a;
        tx.querySelector('.b').textContent = b;
        if (slot === 'local') tx.classList.toggle('err', !!s.err);
      }
    }
  }

  function badIds(v) { return new Set(v.ev.filter((e) => e.bad).flatMap((e) => e.ids)); }

  function renderObjects(v) {
    const prev = idx > 0 ? run.views[idx - 1] : v;
    const flag = (on, c) => (on ? ` ${c}` : '');
    for (const b of Object.values(geo.objs)) {
      if (b.kind === 'table') renderTable(v, prev, b, flag);
      else if (b.kind === 'counter') {
        const o = v.obj.cleanup;
        const n = geo.nodes.cnt;
        const kept = v.ev.some((e) => e.type === 'kept');
        setCls(n, `obj counter${flag(o.old !== prev.obj.cleanup.old, 'changed')}${flag(kept, 'bad')}`);
        n.querySelector('.s1').textContent = `이전 버전 ${o.old}개`;
        n.querySelector('.s2').textContent = o.held && o.old ? 'A의 스냅숏이 붙잡음' : '';
      } else if (b.kind === 'log') renderLogBox(v, prev, b, flag);
    }
  }

  function renderTable(v, prev, b, flag) {
    const o = v.obj[b.id];
    const n = geo.nodes[`tb:${b.id}`];
    const tl = locksOn(v, `${b.id}:table`);
    const tw8 = v.th && Object.entries(v.th).filter(([, s]) => s.waitOn === `${b.id}:table`).map(([id, s]) => `${s.waitMode} ${id}`);
    setCls(n, `obj table${flag(tl.length, 'held')}`);
    if (b.myisam) n.querySelector('.tlock').textContent = `표 락 ${tl.length ? lockText(tl) : '없음'}${tw8.length ? ` · 기다림 ${tw8.join(', ')}` : ''}`;
    n.querySelector('.empty-note').textContent = o.rows.length ? '' : '행 없음';
    for (const c of b.cols) {
      const sel = c.kind === 'gap' ? `gap:${b.id}` : `row:${b.id}:${c.k}`;
      const cn = geo.nodes[sel];
      const res = `${b.id}:${c.k}`;
      const ls = locksOn(v, res);
      const waited = Object.values(v.th).some((s) => s.waitOn === res);
      cn.querySelector('.lk').textContent = lockText(ls);
      if (c.kind === 'gap') {
        setCls(cn, `col gap${flag(ls.length, 'held')}${flag(waited, 'waited')}`);
        continue;
      }
      const row = o.rows.find((r) => r.k === c.k);
      const prow = prev.obj[b.id].rows.find((r) => r.k === c.k);
      const sig = (r) => (r ? r.vers.map((x) => `${x.id}${x.state}`).join() : '');
      setCls(cn, `col row${flag(!row, 'gone')}${flag(ls.length, 'held')}${flag(waited, 'waited')}${flag(sig(row) !== sig(prow), 'changed')}`);
      cn.querySelectorAll('.ver').forEach((chip) => {
        const ver = row ? row.vers[+chip.dataset.i] : null;
        if (!ver) { chip.setAttribute('class', 'ver none'); return; }
        // 커밋하지 않은 버전은 점선, 더 새 버전이 있는 이전 버전은 회색이다. 표가 MyISAM이면 버전이 늘 하나다.
        const old = !ver.newest && !(ver.state === 'active');
        const committedNewest = row.vers.find((x) => x.state === 'committed');
        const cls = `ver${ver.state === 'active' ? ' active' : ''}${old && ver !== committedNewest ? ' old' : ''}`;
        chip.setAttribute('class', cls);
        chip.querySelector('.vt').textContent = ver.text;
        chip.querySelector('.seen').textContent = ver.seen.length ? `←${ver.seen.join('')}` : '';
      });
    }
  }

  function renderLogBox(v, prev, b, flag) {
    const o = v.obj[b.id];
    const p = prev.obj[b.id];
    const n = geo.nodes[`log:${b.id}`];
    const waited = Object.values(v.th).some((s) => s.waitOn === b.id);
    setCls(n, `obj log${flag(waited, 'waited')}${flag(o.lost.length, 'bad')}`);
    n.querySelectorAll('.band').forEach((bg) => {
      const band = bg.dataset.band;
      const items = o[band].slice().sort();
      bg.setAttribute('class', `band ${band}${items.join() !== p[band].slice().sort().join() ? ' changed' : ''}`);
      bg.querySelectorAll('.lchip').forEach((cg) => {
        const it = items[+cg.dataset.k];
        cg.setAttribute('class', `lchip${it ? '' : ' none'}${band === 'lost' ? ' bad' : ''}`);
        cg.querySelector('text').textContent = it ? (geo.compact ? it.replace('커밋 ', '') : it) : '';
      });
    });
  }

  // 단계 끝의 연결: 쥔 락(held), 기다리는 락이나 fsync(wait), 정리하거나 로그를 내리는 백그라운드 일(call).
  // 이 단계에 기다림의 고리가 생겼으면 고리를 이룬 기다림을 주황으로 그린다. 고리는 그 단계 안에서 오류로 풀리므로 단계 끝에는 남지 않는다.
  function linksOf(v) {
    const out = [];
    const seen = new Set();
    const push = (l) => { const k = `${l.from}|${l.to}`; if (seen.has(k) || !geo.anchor[l.to]) return; seen.add(k); out.push(l); };
    for (const c of v.cycle || []) push({ from: c.from, to: c.res, kind: 'wait cycle' });
    for (const l of v.locks) push({ from: l.sess, to: l.res, kind: 'held' });
    for (const [id, s] of Object.entries(v.th)) if (s.waitOn) push({ from: id, to: s.waitOn, kind: 'wait' });
    if (scene === 'hold') {
      for (const id of ['P', 'V']) if (v.th[id] && v.th[id].cls === 'run') push({ from: id, to: 'accounts:table', kind: 'call' });
    }
    if (scene === 'commit' && v.th.W.cls === 'run') {
      for (const o of logs(v)) if (!o.sync && o.id !== 'binlog') push({ from: 'W', to: o.id, kind: 'call' });
    }
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
      const a = g.anchor[l.to];
      const k = tIndex(l.from);
      const step = T > 1 ? Math.min(12, (a.w - 12) / (T - 1)) : 0;
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

  // ---------- 전체 지도 ----------
  // 모든 요소를 담는 관계(DB 서버 ⊃ 세션·트랜잭션·스냅숏·락·표·이전 버전·정리·로그 버퍼, 운영체제 ⊃ 페이지 캐시, 디스크)만 그린다.
  // 단계와 상관없이 그대로이고, 장면과 구성을 바꾸면 그 구성이 쓰는 부분만 진하게 바꾼다.

  const MAP_DB = [['session', '세션'], ['trx', '트랜잭션'], ['snap', '스냅숏'], ['lock', '락'], ['innodb', 'InnoDB 표'], ['myisam', 'MyISAM 표'],
    ['old', '이전 버전'], ['clean', 'purge · VACUUM'], ['logbuf', '로그 버퍼']];
  const PART_NAMES = Object.assign(Object.fromEntries(MAP_DB), { cache: '페이지 캐시', disk: '디스크' });

  function buildMap() {
    const avail = Math.floor($('#mapWrap').clientWidth) || 460;
    const W = Math.max(260, Math.min(460, avail));
    const svg = $('#map');
    svg.innerHTML = '';
    const part = (name) => el('g', { class: 'part', 'data-part': name }, svg);
    const left = 14;
    const right = W - 14;
    let y = 12;
    let x = left;
    for (const [name, text] of MAP_DB) {
      const w = Math.ceil(textW(text, 11)) + 14;
      if (x > left && x + w > right) { x = left; y += 28; }
      const o = part(name);
      el('rect', { x, y, width: w, height: 22, rx: 5 }, o);
      el('text', { x: x + w / 2, y: y + 15, 'text-anchor': 'middle' }, o, text);
      x += w + 8;
    }
    const dbB = y + 22 + 22;
    el('rect', { class: 'box', x: 4, y: 4, width: W - 8, height: dbB - 4, rx: 10 }, svg);
    svg.insertBefore(svg.lastChild, svg.firstChild);
    el('text', { class: 'lbl', x: 14, y: dbB - 7 }, svg, 'DB 서버 (mysqld · postgres)');
    const osY = dbB + 10;
    const cache = part('cache');
    const cw = Math.ceil(textW('페이지 캐시', 11)) + 14;
    el('rect', { x: left, y: osY + 8, width: cw, height: 22, rx: 5 }, cache);
    el('text', { x: left + cw / 2, y: osY + 23, 'text-anchor': 'middle' }, cache, '페이지 캐시');
    el('text', { class: 'lbl', x: left + cw + 10, y: osY + 23 }, svg, '운영체제');
    el('rect', { class: 'box', x: 4, y: osY, width: W - 8, height: 38, rx: 10 }, svg);
    svg.insertBefore(svg.lastChild, svg.firstChild);
    const dY = osY + 38 + 10;
    const disk = part('disk');
    const dw = Math.ceil(textW('디스크', 11)) + 14;
    el('rect', { x: left, y: dY, width: dw, height: 22, rx: 5 }, disk);
    el('text', { x: left + dw / 2, y: dY + 15, 'text-anchor': 'middle' }, disk, '디스크');
    svg.setAttribute('viewBox', `0 0 ${W} ${dY + 26}`);
    svg.style.maxWidth = `${W}px`;
  }

  // 이 구성이 쓰는 지도 부분. 장면에 그린 요소와 같다.
  function partsFor() {
    if (scene === 'commit') return ['session', 'logbuf', 'cache', 'disk'];
    if (scene === 'hold') return ['session', 'trx', 'snap', 'innodb', 'old', 'clean'];
    const V = run.views;
    const out = ['session', 'trx'];
    const tbls = tables(V[0]);
    if (tbls.some((t) => t.engine === 'innodb')) out.push('innodb');
    if (tbls.some((t) => t.engine === 'myisam')) out.push('myisam');
    if (V.some((v) => v.locks.length || Object.values(v.th).some((s) => s.waitOn))) out.push('lock');
    if (V.some((v) => v.ev.some((e) => ['read', 'snap', 'long', 'changed'].includes(e.type)) || Object.values(v.th).some((s) => s.snapAt))) out.push('snap');
    if (V.some((v) => tables(v).some((t) => t.rows.some((r) => r.vers.length > 1)))) out.push('old');
    return out;
  }

  function renderMap() {
    const on = new Set(partsFor());
    $('#map').querySelectorAll('.part').forEach((p) => p.classList.toggle('on', on.has(p.dataset.part)));
    const used = [...on].map((p) => PART_NAMES[p]);
    $('#map').setAttribute('aria-label', '전체 지도. DB 서버 안에 세션, 트랜잭션, 스냅숏, 락, InnoDB 표, MyISAM 표, 이전 버전, purge·VACUUM, 로그 버퍼가 있고, '
      + `그 아래 운영체제의 페이지 캐시, 그 아래 디스크가 있다. 이 구성에 나오는 부분: ${used.join(', ')}.`);
  }

  function renderCounts() {
    const items = [];
    const db = M.DB_NAME[dbOf()];
    if (isTimeline()) {
      const tbl = tables(run.views[0]).map((t) => `${t.name} (${t.engine === 'myisam' ? 'MyISAM' : dbOf() === 'postgres' ? 'heap' : 'InnoDB'})`).join(', ');
      items.push(['DB', db], ['세션', `${threads().length}개 (${threads().map((t) => t.id).join(', ')})`], ['격리 수준', M.LEVEL_NAME[cfg.level || 'RR']],
        ['표', tbl], ['순서표 줄', `${run.steps.length}줄`]);
    } else if (scene === 'hold') {
      items.push(['DB', db], ['세션', `3개 (A, B, C)${dbOf() === 'mysql' ? ' + purge 스레드' : ' + VACUUM'}`], ['A의 경우', M.HOLDS[cfg.hold].label],
        ['B의 UPDATE', `${cfg.updates}번 (실험 1만 번)`], ['표', 'accounts, visits']);
    } else {
      items.push(['DB', db], ['설정', M.SETTINGS[cfg.setting].label], ['자동 커밋 INSERT', `${cfg.commits}번 (실험 3,000번)`],
        ['로그', logs(run.views[0]).map((o) => o.name).join(', ')], ['장애', { none: '없음', db: 'DB 프로세스만 죽음', os: 'OS까지 죽음' }[cfg.crash]]);
    }
    $('#counts').innerHTML = items.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('');
  }

  // ---------- 화면 낭독기용 요약 ----------

  function objSummary(v) {
    const parts = [];
    for (const t of tables(v)) {
      const rows = t.rows.map((r) => {
        const vers = r.vers.map((x) => `${x.text}${x.state === 'active' ? '(커밋 전)' : ''}${x.seen.length ? `(${x.seen.join('·')}의 스냅숏이 봄)` : ''}`);
        const ls = locksOn(v, `${t.name}:${r.k}`);
        return `행 ${r.k}: ${vers.join(' ← ')}${ls.length ? `, 락 ${lockText(ls)}` : ''}`;
      });
      const gl = locksOn(v, `${t.name}:gap`);
      const tl = locksOn(v, `${t.name}:table`);
      parts.push(`${t.name} 표 ${rows.length ? rows.join('; ') : '행 없음'}${gl.length ? `; 행 사이 범위 락 ${lockText(gl)}` : ''}${tl.length ? `; 표 락 ${lockText(tl)}` : ''}.`);
    }
    if (v.obj.cleanup) parts.push(`이전 버전 ${v.obj.cleanup.old}개.`);
    for (const o of logs(v)) parts.push(`${o.name}: DB 메모리 ${o.mem.join(', ') || '없음'}, OS 페이지 캐시 ${o.os.join(', ') || '없음'}, 디스크 ${o.disk.join(', ') || '없음'}${o.lost.length ? `, 사라짐 ${o.lost.join(', ')}` : ''}.`);
    return parts.join(' ');
  }

  function describe(v) {
    const parts = [`단계 ${v.label}.`];
    if (v.actors.length) parts.push(`실행: ${v.actors.map((id) => threadTitle(thread(id))).join(', ')}.`);
    const rest = threads().filter((t) => !v.actors.includes(t.id)).map((t) => `${t.name} ${stateText(v.th[t.id])}`);
    if (rest.length) parts.push(`${rest.join(', ')}.`);
    parts.push(`단계 끝: ${objSummary(v)}`);
    return parts.join(' ');
  }

  // ---------- 설명 한 문장 ----------

  function mainEvent(v) {
    for (const type of BAD_ORDER) {
      const e = v.ev.find((x) => x.type === type && x.bad);
      if (e) return e;
    }
    if (scene === 'commit') {
      for (const type of COMMIT_ORDER) {
        const e = v.ev.find((x) => x.type === type);
        if (e) return e;
      }
    }
    return v.ev[0] || null;
  }

  // 원자료의 rows를 글로 적는다. 두 표를 한 번에 센 SELECT는 열 두 개짜리 한 행이다.
  function rowsText(rows, sql) {
    if (rows == null) return '';
    if (!rows.length) return '없음';
    if (rows[0][0] === 'Warning') return `경고 ${rows[0][1]}`;
    if (/^SELECT \(SELECT/.test(sql || '')) return `(${rows[0].join(', ')})`;
    if (rows.length === 1 && rows[0].length === 1) return String(rows[0][0]);
    if (rows.every((r) => r.length === 1)) return rows.map((r) => r[0]).join(', ');
    return rows.map((r) => r.join(':')).join(', ');
  }

  // 마지막 단계에 붙이는 결과. 순서표 장면은 읽은 값, 기다린 문장, 오류를 원자료와 같은 모양으로 모은다.
  function resultText() {
    const r = run.result;
    const anyBad = run.views.some((v) => v.ev.some((e) => e.bad));
    if (isTimeline()) {
      const reads = run.records.filter((x) => x.rows != null && !/^SHOW/.test(x.sql)).map((x) => `${x.step}번 ${x.session} ${rowsText(x.rows, x.sql)}`);
      const waits = run.records.filter((x) => x.blocked && !/SLEEP/.test(x.sql)).map((x) => `${x.step}번 ${x.session}`);
      const errs = run.records.filter((x) => x.error).map((x) => `${x.step}번 ${x.session} ${x.error.code}`);
      const deferred = run.records.filter((x) => x.deferred).map((x) => `${x.step}번 ${x.session}`);
      const parts = [`결과: 읽은 값 ${reads.join(' · ') || '없음'}.`];
      if (waits.length) parts.push(`기다린 문장 ${waits.join(', ')}.`);
      if (deferred.length) parts.push(`미룬 문장 ${deferred.join(', ')}.`);
      if (errs.length) parts.push(`오류 ${errs.join(', ')}.`);
      return { bad: anyBad, text: parts.join(' ') };
    }
    if (scene === 'hold') {
      const keptAll = r.afterUpdates === r.updates;
      const hops = dbOf() === 'mysql' ? ` (undo log ${r.aHops}단계 되짚음)` : '';
      const close = dbOf() === 'mysql' ? `A가 끝난 뒤 purge가 지우고 ${r.afterClose}개 남음` : `A가 끝난 뒤 VACUUM이 ${r.afterClose.removed}개 지움`;
      return { bad: keptAll, text: `결과: B가 ${r.updates}번 고친 직후 남은 이전 버전 ${r.afterUpdates}개. A가 읽은 값 ${r.aRead}${hops}, C가 읽은 값 ${r.cRead}. ${close}.` };
    }
    const lostList = Object.entries(r.lost).filter(([, l]) => l.length).map(([id, l]) => `${logName(id)}의 ${l.join(', ')}`);
    return { bad: lostList.length > 0,
      text: `결과: 커밋마다 기다린 fsync ${r.waitsPerCommit}번. 앱이 끝났다고 받은 커밋 ${r.acked.length}개${lostList.length ? ` 중 사라진 기록: ${lostList.join(', ')}` : cfg.crash === 'none' ? '' : ', 사라진 기록 없음'}.` };
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

  // ---------- 코드 ----------
  // 줄마다 그 줄을 가리키는 키(on)를 둔다. 키는 model.js가 세션마다 적는 줄 이름이다(순서표 sN, 열어 둔 트랜잭션 a1·b·ar 등, 커밋 iN·bg).

  function L(t, on) { return { t, on: on || [] }; }

  function levelLine(sessions) {
    return L(`-- ${sessions}: ${LEVEL_SQL[dbOf()]} ${M.LEVEL_NAME[cfg.level || 'RR']};`);
  }

  function timelineCode() {
    const lines = [L('-- 준비')];
    for (const s of run.setup) lines.push(L(`${s};`));
    lines.push(levelLine(threads().map((t) => t.id).join(', ')));
    lines.push(L(''));
    for (const s of run.steps) lines.push(L(`${s.s}: ${s.sql};${s.note ? `  -- ${s.note}` : ''}`, [s.key]));
    return { sig: run.timeline, lines, note: `isolation_timelines.py의 순서표 ${run.timeline}과 같은 SQL, 같은 순서다. 줄 앞의 A:, B:는 그 문장을 보내는 세션이다. 실험은 줄 하나를 보낸 뒤 0.5초 기다리고 다음 줄로 갔다.` };
  }

  function holdCode() {
    const H = run.hold;
    const my = dbOf() === 'mysql';
    const lines = [L('-- 준비')];
    for (const s of M.HOLD_SETUP) lines.push(L(`${s};`));
    if (!my) lines.push(L('ALTER TABLE accounts SET (autovacuum_enabled = false);'));
    lines.push(L(''));
    lines.push(L(`-- A: ${H.label}`));
    if (H.iso) lines.push(L(`A: ${LEVEL_SQL[dbOf()]} ${M.LEVEL_NAME[H.iso]};`));
    H.steps.forEach((s, i) => lines.push(L(`A: ${s.sql};`, [`a${i + 1}`])));
    lines.push(L(`B: ${M.UPDATE_BALANCE};  -- 자동 커밋 ${cfg.updates}번, 실험은 1만 번`, ['b']));
    if (my) lines.push(L('-- purge 스레드: B가 커밋할 때마다 지울 수 있는 이전 버전을 지운다', ['p1']));
    lines.push(L(`A: ${M.READ_BALANCE};`, ['ar']));
    lines.push(L(`C: ${M.READ_BALANCE};  -- 새 세션`, ['cr']));
    if (!my) lines.push(L('VACUUM (VERBOSE) accounts;  -- 관찰 세션', ['v1']));
    if (H.steps.length) lines.push(L('A: COMMIT;', ['ac']));
    lines.push(my ? L('-- purge 스레드: A가 끝난 뒤 다시 돈다', ['p2']) : L('VACUUM (VERBOSE) accounts;  -- A가 끝난 뒤', ['v2']));
    return { sig: `hold|${cfg.hold}|${cfg.updates}|${dbOf()}`, lines,
      note: 'history_lab.py의 경우와 같은 SQL이다. 실험은 읽기 시간과 History list length, VACUUM 보고를 재는 줄이 더 있다. 주석 줄(purge 스레드)은 DB가 스스로 하는 일이라 실험 코드에 없다.' };
  }

  function commitCode() {
    const set = M.SETTINGS[cfg.setting];
    const lines = [L('-- 준비')];
    if (dbOf() === 'mysql') {
      lines.push(L('CREATE TABLE events (id BIGINT AUTO_INCREMENT PRIMARY KEY, payload VARCHAR(64) NOT NULL);'));
      lines.push(L(`SET GLOBAL innodb_flush_log_at_trx_commit = ${set.flush};`));
      lines.push(L(`SET GLOBAL sync_binlog = ${set.binlog};`));
    } else {
      lines.push(L('CREATE TABLE events (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payload VARCHAR(64) NOT NULL);'));
      lines.push(L(`SET synchronous_commit = ${set.sync ? 'on' : 'off'};`));
    }
    lines.push(L(''));
    for (let c = 1; c <= cfg.commits; c++) lines.push(L(`앱: INSERT INTO events (payload) VALUES ('order paid');  -- 자동 커밋 ${c}`, [`i${c}`]));
    lines.push(L(dbOf() === 'mysql' ? '-- 로그 스레드: 약 1초마다 redo log를 fsync한다(innodb_flush_log_at_trx_commit=2일 때)' : '-- WAL writer: wal_writer_delay마다 WAL을 쓰고 fsync한다', ['bg']));
    return { sig: `commit|${cfg.setting}|${cfg.commits}`, lines,
      note: 'durability_lab.py의 설정과 INSERT다. 실험은 같은 INSERT를 3,000번 보내 시간을 쟀다. 마지막 주석 줄은 DB가 스스로 하는 일이라 실험 코드에 없다.' };
  }

  function codeFor() {
    if (isTimeline()) return timelineCode();
    if (scene === 'hold') return holdCode();
    return commitCode();
  }

  function linesOfKey(key) { return code.lines.map((ln, i) => (ln.on.includes(key) ? i : -1)).filter((i) => i >= 0); }
  function lastLine(key) { const ls = linesOfKey(key); return ls.length ? ls[ls.length - 1] : -1; }
  function firstLine(key) { const ls = linesOfKey(key); return ls.length ? ls[0] : -1; }

  // 코드 줄에 붙일 이름표: 실행한 세션은 이 단계에 실행한 마지막 줄에 채운 이름표를, 나머지는 다음에 실행할 줄(at)에 상태 이름표를 단다.
  function chipsFor(v) {
    const out = [];
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

  function renderCode(v) {
    const ol = $('#code');
    const fresh = codeFor();
    const sig = `${scene}|${fresh.sig}|${cfg.level || ''}|${dbOf()}`;
    if (codeSig !== sig) {
      codeSig = sig;
      code = fresh;
      ol.innerHTML = code.lines.map((ln, i) => `<li data-line="${i}"><span class="marks"></span><span class="ln">${i + 1}</span><code>${esc(ln.t) || ' '}</code></li>`).join('');
      $('#codeNote').textContent = code.note;
    }
    const ran = new Set();
    for (const id of v.actors) for (const k of v.th[id].lines) linesOfKey(k).forEach((i) => ran.add(i));
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

  // 커밋된 가장 새 버전의 값(표, 행 키)
  function committedText(v, t, k) {
    const row = v.obj[t].rows.find((r) => r.k === k);
    const ver = row && row.vers.find((x) => x.state === 'committed');
    return ver ? ver.text.replace(/^qty /, '') : '';
  }
  // 이 단계에 그 세션이 끝낸 읽기의 결과(없으면 빈칸). 그 단계에 실행한 줄 중 그 단계에 끝난 SELECT를 고른다.
  // 끝 단계(꼬리)에 끝난 문장은 원자료처럼 순서표 마지막 줄 번호로 기록되어 있다.
  function readAt(k, sess) {
    const v = run.views[k];
    const keys = v.th[sess].lines;
    const rec = run.records.filter((x) => x.session === sess && keys.includes(`s${x.step}`) && x.rows != null
      && x.finished_after_step === Math.min(k, run.steps.length) && !/^SHOW/.test(x.sql));
    return rec.length ? rec[rec.length - 1] : null;
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
    const readRow = (label, sess, short) => row(label, (v, p, k) => {
      const rec = readAt(k, sess);
      const bad = v.ev.some((e) => e.type === 'changed' || e.type === 'dirty');
      if (!rec) return { text: '', cls: 'val', tip: `단계 ${v.label}: ${sess}가 끝낸 읽기 없음` };
      const full = rowsText(rec.rows, rec.sql);
      return { text: short ? short(rec.rows) : full, cls: `val changed${bad ? ' bad' : ''}`, tip: `단계 ${v.label}: ${sess}의 ${rec.step}번 줄 결과 ${full}` };
    });
    if (scene === 'count' || scene === 'report') readRow(scene === 'count' ? 'A가 센 수' : 'A가 읽은 잔액', 'A');
    else if (scene === 'locking') readRow('A가 읽은 행', 'A', (r) => r.map((x) => x[0]).join(''));
    else if (scene === 'deduct') {
      row('커밋된 잔액', (v, p, k) => {
        const a = committedText(v, 'points', 7);
        const changed = a !== committedText(p, 'points', 7);
        const lost = v.ev.some((e) => e.type === 'lost');
        return { text: a, cls: `val${changed ? ' changed' : ''}${lost ? ' bad' : ''}`, tip: `단계 ${v.label} 뒤 커밋된 잔액 ${a}` };
      });
    } else if (scene === 'engine') {
      if (cfg.tl === 'rollback') readRow('B가 센 수', 'B', (r) => r[0].join(','));
      else {
        row('id 2 재고', (v, p, k) => {
          const a = committedText(v, 'stock', 2);
          return { text: a, cls: `val${a !== committedText(p, 'stock', 2) ? ' changed' : ''}`, tip: `단계 ${v.label} 뒤 stock의 id 2 qty ${a}` };
        });
      }
    } else if (scene === 'hold') {
      row('이전 버전', (v, p, k) => {
        const n = v.obj.cleanup.old;
        const kept = v.ev.some((e) => e.type === 'kept');
        return { text: String(n), cls: `val${n !== p.obj.cleanup.old ? ' changed' : ''}${kept ? ' bad' : ''}`, tip: `단계 ${k} 뒤 남은 이전 버전 ${n}개${kept ? '. 지우지 못했다' : ''}` };
      });
    } else {
      row('fsync 끝', (v, p, k) => ({ text: v.fsyncs ? String(v.fsyncs) : '', cls: `val${v.fsyncs ? ' changed' : ''}`, tip: `단계 ${k}에 끝난 fsync ${v.fsyncs}번` }));
      row('디스크', (v, p, k) => {
        const n = Math.min(...logs(v).map((o) => o.disk.length));
        const lost = v.ev.some((e) => e.type === 'lost');
        return { text: String(n), cls: `val${n !== Math.min(...logs(p).map((o) => o.disk.length)) ? ' changed' : ''}${lost ? ' bad' : ''}`, tip: `단계 ${k} 뒤 모든 로그가 디스크에 내려간 커밋 ${n}개` };
      });
    }
    return rows;
  }

  const STRIP_NOTE = {
    timeline: '칸 글자: 시 트랜잭션 시작 · 읽 읽기 · 잠 잠그며 읽기 · 쓰 쓰기 · 확 커밋 · 되 ROLLBACK · ! 오류. 점선 칸은 락을 기다리는 단계, 주황 칸은 오류가 났거나 같은 조건의 읽기 결과가 바뀐 단계다.',
    hold: '칸 글자: 시 트랜잭션 시작 · 읽 읽기 · 쓰 쓰기 · 확 커밋 · 정 이전 버전 정리. 주황 칸: 이전 버전을 지우지 못한 단계.',
    commit: '칸 글자: 쓰 INSERT · 내 fsync · 완 커밋 완료 응답. "fsync 끝"은 그 단계에 끝난 fsync 수, "디스크"는 모든 로그가 디스크에 내려간 커밋 수다.',
  };

  function buildStrip() {
    const N = lastIdx();
    const strip = $('#strip');
    const values = valueRows();
    // 값 줄에 네 자리 수(잔액 1000)가 있으면 칸을 넓힌다.
    const longest = Math.max(0, ...values.flatMap((r) => r.cells.map((c) => String(c.text).length)));
    const cw = longest > 3 ? 40 : 30;
    strip.style.setProperty('--cw', `${cw}px`);
    strip.style.gridTemplateColumns = `auto repeat(${N}, ${cw}px)`;
    const out = ['<div class="rh">단계</div>'];
    for (let k = 1; k <= N; k++) out.push(`<div class="ch" data-step="${k}">${esc(run.views[k].label)}</div>`);
    for (const t of threads()) {
      out.push(`<div class="rh">${esc(rowName(t))}</div>`);
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
    $('#stripNote').textContent = STRIP_NOTE[isTimeline() ? 'timeline' : scene];
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

  function nowLines(sel, type, v) {
    const out = [];
    if (sel.startsWith('th:')) {
      const t = thread(sel.slice(3));
      const s = v.th[t.id];
      const after = s.cls === 'run' ? s.after : s;
      if (s.cls === 'run') out.push(`이 단계 동안 실행했다. 실행한 줄: ${lineList(s.lines) || '없음'}.`);
      else out.push('이 단계 동안 실행하지 않았다.');
      if (s.err) out.push(`이 단계에 ${s.err}로 끝났다. 트랜잭션은 되돌려졌다.`);
      out.push(`단계 끝: ${stateText(after)}${s.waitOn ? ` · ${resWord(s.waitOn)}${s.waitMode ? `의 ${LOCK_NAME[s.waitMode] || s.waitMode}` : ''}${s.waitBy ? `(${josa(s.waitBy, ['이', '가'])} 쥠)` : ''}을 기다린다` : ''}${s.sleeping ? ' · SLEEP으로 오래 걸리는 SELECT를 실행 중이다' : ''}.`);
      if (s.deferred && s.deferred.length) out.push(`앞 문장이 끝나지 않아 미뤄 둔 줄: ${s.deferred.join(', ')}번(순서표 기준).`);
      if (s.trx) out.push(`트랜잭션: ${s.trx}${s.iso && isTimeline() ? ` · 격리 수준 ${M.LEVEL_NAME[s.iso]}` : ''}.`);
      if (s.snap) out.push(s.snapAt ? `스냅숏: 단계 ${s.snapAt}에 만들었다. 그때 커밋을 마친 트랜잭션의 변경과 자기 변경만 보인다. 관계도의 "←${t.id}" 표시가 이 스냅숏이 보는 버전이다.` : '스냅숏: 아직 없다. 첫 읽기에서 만든다.');
      const held = v.locks.filter((l) => l.sess === t.id);
      if (held.length) out.push(`단계 끝에 쥔 락: ${held.map((l) => `${resWord(l.res)}의 ${LOCK_NAME[l.mode]}`).join(', ')}.`);
      if (s.local && !s.err) out.push(`마지막 결과: ${s.local.replace(/^→ /, '')}.`);
      const nl = s.at ? firstLine(s.at) : -1;
      if (after.cls !== 'done' && nl >= 0) out.push(`다음에 실행할 줄: ${nl + 1}번.`);
    } else if (sel.startsWith('tb:')) {
      const o = v.obj[sel.slice(3)];
      out.push(`단계 끝 행 ${o.rows.length}개${o.rows.length ? `: ${o.rows.map((r) => `${o.key} ${r.k}`).join(', ')}` : ''}.`);
      const tl = locksOn(v, `${o.name}:table`);
      if (o.engine === 'myisam') out.push(`표 락: ${tl.length ? tl.map((l) => `${l.sess}의 ${LOCK_NAME[l.mode]}`).join(', ') : '없음'}. 문장이 끝나면 놓는다.`);
      if (o.where) out.push(o.where === 'undo' ? '이 표에는 최신 버전만 있고, 회색 이전 버전은 undo log에 있다.' : '회색 이전 버전(dead tuple)도 이 표 안에 있다.');
    } else if (sel.startsWith('row:')) {
      const [, tn, kk] = sel.split(':');
      const o = v.obj[tn];
      const row = o.rows.find((r) => String(r.k) === kk);
      if (!row) out.push('단계 끝: 아직 없는 행이다.');
      else {
        out.push(`버전(새것부터): ${row.vers.map((x) => `${x.text}${x.state === 'active' ? ` (${x.by}가 쓰고 커밋 전)` : x.by ? ` (${x.by}가 씀)` : ' (처음 값)'}`).join(' ← ')}.`);
        const seen = row.vers.filter((x) => x.seen.length).map((x) => `${x.seen.join('·')}의 스냅숏은 ${x.text}`);
        if (seen.length) out.push(`스냅숏이 보는 버전: ${seen.join(', ')}.`);
        else if (Object.values(v.th).some((s) => s.snapAt)) out.push('이 행의 버전 중 열린 스냅숏에 보이는 것이 없다.');
      }
      const ls = locksOn(v, `${tn}:${kk}`);
      out.push(`락: ${ls.length ? ls.map((l) => `${l.sess}의 ${LOCK_NAME[l.mode]}`).join(', ') : '없음'}.`);
      const ws = Object.entries(v.th).filter(([, s]) => s.waitOn === `${tn}:${kk}`);
      if (ws.length) out.push(`기다리는 세션: ${ws.map(([id, s]) => `${id}(${LOCK_NAME[s.waitMode] || s.waitMode})`).join(', ')}.`);
    } else if (sel.startsWith('gap:')) {
      const tn = sel.slice(4);
      const ls = locksOn(v, `${tn}:gap`);
      out.push(`범위 락: ${ls.length ? ls.map((l) => `${l.sess}의 ${LOCK_NAME[l.mode]}`).join(', ') : '없음'}.`);
      const ws = Object.entries(v.th).filter(([, s]) => s.waitOn === `${tn}:gap`);
      if (ws.length) out.push(`이 범위에 행을 넣으려고 기다리는 세션: ${ws.map(([id]) => id).join(', ')}. 넣기 전에 범위 락이 없는지 확인한다(넣기 의도 락).`);
    } else if (sel === 'cnt') {
      const o = v.obj.cleanup;
      out.push(`단계 끝 이전 버전 ${o.old}개(accounts와 visits).`);
      out.push(o.held ? 'A에게 스냅숏이 있다. 그 스냅숏보다 뒤에 덮인 이전 버전은 지우지 못한다.' : 'A에게 스냅숏이 없다. 커밋된 이전 버전은 정리할 때 지운다.');
    } else if (sel.startsWith('log:')) {
      const o = v.obj[sel.slice(4)];
      out.push(`${syncText(o)}.`);
      out.push(`DB 메모리: ${o.mem.join(', ') || '없음'}. OS 페이지 캐시: ${o.os.join(', ') || '없음'}. 디스크: ${o.disk.join(', ') || '없음'}.`);
      if (o.lost.length) out.push(`사라진 기록: ${o.lost.join(', ')}. 앱은 이 커밋들이 끝났다는 응답을 이미 받았다.`);
      const ws = Object.entries(v.th).filter(([, s]) => s.waitOn === o.id);
      if (ws.length) out.push('단계 끝에 앱이 이 로그의 fsync가 끝나기를 기다린다.');
    }
    return out;
  }

  function renderDetails() {
    const pane = $('#details');
    if (!selected) { pane.hidden = true; detailsFor = null; return; }
    const type = typeOf(selected);
    const d = RC.ELEMENTS[type];
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
    $('#detailsNow').innerHTML = nowLines(selected, type, view()).map((s) => `<li>${esc(s)}</li>`).join('');
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

  const DBS = { label: 'DB', key: 'db', items: [['mysql', 'MySQL'], ['postgres', 'PostgreSQL']] };
  const lv = (list) => ({ label: '격리 수준', key: 'level', items: list.map((l) => [l, M.LEVEL_NAME[l]]) });
  const OPTS = {
    count: [{ label: '순서표', key: 'tl', items: [['snap', '2, 3, 2 (FOR UPDATE)'], ['total', '처음 쓰는 조건'], ['late', '연 뒤 처음 세기'], ['consistent', 'WITH CONSISTENT SNAPSHOT'], ['update', '다른 표 UPDATE 먼저']] },
      DBS, lv(['RR', 'RC'])],
    report: [DBS, lv(M.LEVELS)],
    locking: [DBS, lv(['RC', 'RR', 'SER'])],
    deduct: [DBS, lv(M.LEVELS)],
    hold: [DBS, { label: 'A가 해 둔 일', key: 'hold', items: [['none', '(가) 열지 않음'], ['rr-read', '(나) 읽고 둠 · RR'], ['rc-read', '(다) 읽고 둠 · RC'],
      ['rr-begin', '(라) 열기만 함 · RR'], ['rr-update', '(마) 다른 표 고침 · RR'], ['rr-read-other', '(바) 다른 표 읽음 · RR']] }],
    engine: [{ label: '순서표', key: 'tl', items: [['rollback', '되돌린 주문'], ['stock', '재고 리포트 중 차감']] }, { label: '엔진', key: 'engine', items: [['myisam', 'MyISAM'], ['innodb', 'InnoDB']] }],
    commit: [DBS, { label: '설정', key: 'setting', items: [['f1b1', '1 · 1 (기본값)'], ['f2b1', '2 · 1'], ['f1b0', '1 · 0'], ['f2b0', '2 · 0'], ['on', 'on (기본값)'], ['off', 'off']] }],
  };
  const EXTRAS = {
    hold: [{ type: 'num', key: 'updates', label: 'B의 UPDATE' }],
    commit: [{ type: 'num', key: 'commits', label: '커밋' }, { type: 'select', key: 'crash', label: '마지막에', items: [['none', '장애 없음'], ['db', 'DB 프로세스만 죽음'], ['os', 'OS까지 죽음 (전원)']] }],
  };
  function cfgNote() {
    if (isTimeline()) return '실험은 순서표 조건마다 워밍업 1회와 3회를 돌렸고, 이 화면은 그중 한 번의 순서를 그린다. 실험에서 돌리지 않은 DB와 격리 수준의 조합은 고를 수 없다.';
    if (scene === 'hold') return '실험은 B가 1만 번 고치고 경우마다 3회 돌렸다. 이 장면은 B의 UPDATE를 2~6번으로 줄였다. PostgreSQL의 HOT pruning은 그 페이지를 읽거나 고치는 문장 앞에 한 번 도는 것으로 줄였다.';
    return '설정의 두 숫자는 MySQL의 innodb_flush_log_at_trx_commit과 sync_binlog다. 장애는 마지막 커밋 응답 직후, 백그라운드 fsync 전에 난 것으로 둔다. OS가 스스로 페이지 캐시를 디스크에 내리는 것은 그리지 않는다.';
  }
  const BOARD_NOTE = {
    timeline: '표 상자 안의 칸 하나가 행 하나이고, 칸 안 작은 상자가 그 행의 버전이다(맨 위가 가장 새 버전). 점선 상자는 커밋하지 않은 버전, 회색 상자는 더 새 버전이 있는 이전 버전이다. MySQL은 이전 버전을 undo log에, PostgreSQL은 표 안에 두지만 여기서는 같은 칸에 그린다. "←A"는 A의 스냅숏(트랜잭션 끝까지 쓰는 것)이 보는 버전이다. 칸 위의 "X A"는 A가 쥔 배타 락, "S"는 공유 락, "GX"·"GS"는 행 사이 범위의 락이다.',
    hold: '표 상자 안의 작은 상자가 행 1의 버전이다(맨 위가 가장 새 버전). 회색 상자는 이전 버전이다. MySQL은 이전 버전을 undo log에 두고, PostgreSQL은 표 안에 dead tuple로 둔다. "←A"는 A의 스냅숏이 보는 버전이다. purge나 VACUUM에서 표로 가는 회색 선은 그 단계에 이전 버전을 정리한 것이다.',
    commit: '로그 상자 안의 세 칸은 기록이 있는 곳이다(DB 메모리, OS 페이지 캐시, 디스크). 칸 안의 상자는 커밋 번호다. 앱에서 로그로 가는 점선은 fsync가 끝나기를 기다리는 것이고, 로그 스레드나 WAL writer에서 가는 회색 선은 백그라운드로 내리는 것이다. 장애를 고르면 사라진 기록을 "사라짐" 칸에 주황으로 옮긴다.',
  };

  function content() { return RC.SCENES[scene] || { questions: [], observe: [], measured: [], evidence: [], cards: [] }; }
  function guessKey() { return `mvcc-board-${scene}-guess`; }

  function buildSceneButtons() {
    $('#scenes').innerHTML = GROUPS.map(([key, label]) => `<div class="scene-group" role="group" aria-label="${esc(label)}">`
      + `<span class="group-label" aria-hidden="true">${esc(label)}</span>`
      + Object.entries(SCENES).filter(([, d]) => d.group === key).map(([k, d]) => `<button type="button" data-scene="${k}">${esc(d.label)}</button>`).join('')
      + '</div>').join('');
  }

  function legendHtml() {
    const states = '<li><i class="sw run"></i>실행 중</li><li><i class="sw turn"></i>차례 기다림</li><li><i class="sw event"></i>락·fsync 기다림</li><li><i class="sw done"></i>끝</li>';
    const shapes = scene === 'commit'
      ? '<li><i class="shape box"></i>로그 상자</li><li><i class="shape circle"></i>앱·백그라운드 스레드</li>'
      : '<li><i class="shape box"></i>표와 행 칸</li><li><i class="shape circle"></i>세션</li><li><i class="ver-sw"></i>커밋된 버전</li><li><i class="ver-sw active"></i>커밋 전 버전</li><li><i class="ver-sw old"></i>이전 버전</li>';
    const lines = [];
    if (scene !== 'commit' && scene !== 'hold') lines.push('<li><i class="cnl held"></i>쥔 락</li>');
    lines.push(`<li><i class="cnl wait"></i>${scene === 'commit' ? 'fsync 기다림' : '락 기다림'}</li>`);
    if (scene === 'hold') lines.push('<li><i class="cnl held"></i>쥔 락</li><li><i class="cnl call"></i>이전 버전 정리</li>');
    if (scene === 'commit') lines.push('<li><i class="cnl call"></i>백그라운드 fsync</li>');
    if (scene === 'deduct') lines.push('<li><i class="cnl cycle"></i>기다림의 고리</li>');
    const bad = '<li><i class="sw bad"></i>문제 (오류, 손실, 지우지 못함)</li>';
    return `${shapes}${states}${lines.join('')}${bad}`;
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
    $('#boardNote').textContent = BOARD_NOTE[isTimeline() ? 'timeline' : scene];
    const parts = (EXTRAS[scene] || []).map((x) => (x.type === 'num'
      ? `<div class="num" data-k="${x.key}"><span>${esc(x.label)}</span><button type="button" data-d="-1" aria-label="${esc(x.label)} 줄이기">−</button><output></output><button type="button" data-d="1" aria-label="${esc(x.label)} 늘리기">+</button></div>`
      : `<label>${esc(x.label)} <select data-k="${x.key}">${x.items.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>`));
    parts.push(`<p class="note">${esc(cfgNote())}</p>`);
    $('#cfg').innerHTML = parts.join('');
  }

  // 장면별 조절 단추. 실험에서 돌리지 않은 조합은 누를 수 없게 하고, 다른 DB의 설정은 숨긴다.
  function buildOpts() {
    $('#opts').innerHTML = OPTS[scene].map((o, i) => {
      const items = o.items.filter(([val]) => o.key !== 'setting' || M.SETTINGS[val].db === dbOf());
      return `<div class="scope" role="group" aria-labelledby="opt${i}"><span id="opt${i}">${esc(o.label)}</span>`
        + items.map(([val, label]) => {
          const ok = M.normalizeConfig(scene, Object.assign({}, cfg, { [o.key]: val }))[o.key] === val;
          return `<button type="button" data-opt="${o.key}" data-val="${val}" aria-pressed="${String(cfg[o.key] === val)}"${ok ? '' : ' disabled title="실험에서 돌리지 않은 조합"'}>${esc(label)}</button>`;
        }).join('') + '</div>';
    }).join('');
  }

  function syncControls() {
    buildOpts();
    $('#sceneTitle').textContent = isTimeline() ? run.title : scene === 'hold' ? `열어 둔 트랜잭션 · ${M.HOLDS[cfg.hold].label}` : `커밋을 디스크에 · ${M.DB_NAME[dbOf()]}`;
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
    // 행 칸은 표 상자 안에 있다. 칸을 누르면 칸을, 칸 밖의 표 상자를 누르면 표를 고른다.
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
  window.__mvccBoard = { get scene() { return scene; }, get cfg() { return cfg; }, get idx() { return idx; }, get run() { return run; },
    get geo() { return geo; }, get code() { return code; }, get selected() { return selected; }, go, setConfig, setScene, select,
    linesOfKey, firstLine, lastLine };
})();
