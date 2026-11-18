// 조인 관계도의 화면. model.js(JoinModel)와 content.js(JoinContent)를 쓴다.
(function () {
  'use strict';
  const M = window.JoinModel;
  const C = window.JoinContent;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nul = (v) => (v === null || v === undefined ? '<span class="null">NULL</span>' : esc(v));
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 저장 못 해도 화면은 그대로 */ } },
  };
  const SCENE_ORDER = ['left', 'semi', 'algo', 'n1'];
  const CHOICE_LABEL = { way: '쿼리·방법', scope: '맞출 주문', n: '회원 수(모형)', rtt: '왕복 시간' };

  const state = { scene: 'left', cfg: {}, sim: null, i: 0 };

  function initScene() {
    const h = (location.hash || '').slice(1);
    if (SCENE_ORDER.includes(h)) return h;
    const s = store.get('join06.scene');
    return SCENE_ORDER.includes(s) ? s : 'left';
  }

  function renderScenes() {
    const box = $('scenes');
    box.innerHTML = '';
    for (const id of SCENE_ORDER) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = M.SCENES[id].title;
      b.setAttribute('aria-pressed', String(id === state.scene));
      b.addEventListener('click', () => setScene(id));
      box.appendChild(b);
    }
  }

  function renderChoices() {
    const box = $('choices');
    box.innerHTML = '';
    const sc = M.SCENES[state.scene];
    for (const key of Object.keys(sc.choices)) {
      const fs = document.createElement('fieldset');
      fs.innerHTML = `<legend>${esc(CHOICE_LABEL[key] || key)}</legend>`;
      const opts = document.createElement('div');
      opts.className = 'opts';
      for (const [val, def] of Object.entries(sc.choices[key])) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = def.label;
        b.setAttribute('aria-pressed', String(state.cfg[key] === val));
        b.addEventListener('click', () => { state.cfg[key] = val; store.set(`join06.cfg.${state.scene}`, JSON.stringify(state.cfg)); rebuild(); });
        opts.appendChild(b);
      }
      fs.appendChild(opts);
      box.appendChild(fs);
    }
  }

  function renderText() {
    const t = C.SCENES[state.scene];
    $('questions').innerHTML = t.questions.map((q) => `<li>${esc(q)}</li>`).join('');
    $('observe').innerHTML = t.observe.map((q) => `<li>${esc(q)}</li>`).join('');
    $('measured').innerHTML = t.measured.map((q) => `<li>${esc(q)}</li>`).join('');
    $('evidence').innerHTML = t.evidence.map((e) => `<li><a href="${e.href}">${esc(e.text)}</a></li>`).join('');
    $('cards').innerHTML = t.cards.map((e) => `<li><a href="${e.href}">${esc(e.text)}</a></li>`).join('');
    const g = $('guess');
    g.value = store.get(`join06.guess.${state.scene}`) || '';
  }

  function setScene(id) {
    state.scene = id;
    store.set('join06.scene', id);
    if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
    let saved = null;
    try { saved = JSON.parse(store.get(`join06.cfg.${id}`) || 'null'); } catch (e) { saved = null; }
    state.cfg = M.normalize(id, saved || {});
    renderScenes();
    renderText();
    rebuild();
  }

  function rebuild() {
    state.cfg = M.normalize(state.scene, state.cfg);
    state.sim = M.simulate(state.scene, state.cfg);
    state.i = 0;
    renderChoices();
    renderStrip();
    go(0);
  }

  // ---------- 관계도 ----------
  function upTo(i) { return state.sim.steps.slice(0, i + 1); }

  function tableUsers(st, extraCols) {
    const rows = M.USERS.map((u) => {
      const cls = st && st.side === 'users' && st.cur === u.id ? 'cur' : '';
      return `<tr class="${cls}"><td>${u.id}</td><td>${esc(u.name)}</td>${extraCols ? extraCols(u) : ''}</tr>`;
    }).join('');
    return `<div class="tblbox"><h3>users <span class="muted">왼쪽(쿼리에 먼저 쓴 테이블)</span></h3><table><thead><tr><th>id</th><th>name</th>${extraCols ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function tableOrders(st, opts) {
    const o = opts || {};
    const rows = M.ORDERS.map((r) => {
      let cls = '';
      let tag = '';
      if (st && st.side === 'orders' && st.cur === r.id) cls = 'cur';
      else if (st && st.matches && st.matches.includes(r.id)) { cls = 'hit'; tag = '<span class="tag t-true">TRUE</span>'; }
      else if (st && st.unknown && st.unknown.includes(r.id)) { cls = 'unk'; tag = '<span class="tag t-unk">UNKNOWN</span>'; }
      else if (st && st.reads && st.reads.includes(r.id) && st.side === 'users') { cls = 'read'; tag = o.hideFalse ? '' : '<span class="tag">FALSE</span>'; }
      else if (st && st.side === 'users' && o.stopped) cls = 'dim';
      return `<tr class="${cls}"><td>${r.id}</td><td>${nul(r.user_id)}</td><td>${esc(r.item)}</td><td>${esc(r.status)}${tag}</td></tr>`;
    }).join('');
    return `<div class="tblbox"><h3>orders <span class="muted">오른쪽</span></h3><table><thead><tr><th>id</th><th>user_id</th><th>item</th><th>status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function resultBox(rows, newRows, dropped, cols) {
    const isNew = (r) => newRows.some((x) => x === r);
    const isDrop = (r) => dropped.some((x) => x === r);
    const body = rows.length ? rows.map((r) => `<tr class="${isDrop(r) ? 'dropped' : isNew(r) ? 'new' : ''}">${cols.map((c) => `<td>${nul(r[c])}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="null">아직 없음</td></tr>`;
    return `<div class="tblbox"><h3>결과 <span class="muted">이 단계 뒤</span></h3><table><thead><tr>${cols.map((c) => `<th>${c === 'u' ? 'u.id' : 'o.id'}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function drawLeft(i) {
    const st = state.sim.steps[i];
    const done = upTo(i);
    let rows = [];
    for (const s of done) rows = rows.concat(s.emit || []);
    const way = M.LEFT_WAYS[state.cfg.way];
    if (way.keep === 'full' && st.side !== 'union') {
      // 왼쪽 결과를 만드는 동안
    }
    let dropped = [];
    let html = '';
    if (st.side === 'where') {
      dropped = st.drop;
      const checks = st.checks.map((c) => `<span class="c ${c.value === true ? 't-true' : c.value === null ? 't-unk' : ''}">(${c.row.u}, ${c.row.o === null ? 'NULL' : c.row.o}) ${M.tv(c.value)}</span>`).join('');
      html += tableUsers(null) + tableOrders(null);
      html += resultBox(rows, [], dropped, ['u', 'o']);
      html += `<div class="tblbox" style="flex-basis:100%"><h3>WHERE o.status = 'paid'를 결과 행마다</h3><div class="chain">${checks}</div></div>`;
    } else {
      html += tableUsers(st) + tableOrders(st) + resultBox(rows, st.emit || [], [], ['u', 'o']);
      if (st.side === 'union' && st.dup.length) html += `<div class="tblbox" style="flex-basis:100%"><h3>UNION이 지운 같은 행</h3><div class="chain">${st.dup.map((r) => `<span class="c">(${r.u}, ${r.o})</span>`).join('')}</div></div>`;
    }
    $('board').innerHTML = html;
    const kept = st.side === 'where' ? rows.length - dropped.length : rows.length;
    return [['따진 행', done.filter((s) => s.side !== 'where' && s.side !== 'union').length], ['결과 행', kept]];
  }

  function drawSemi(i) {
    const st = state.sim.steps[i];
    const done = upTo(i);
    let rows = [];
    for (const s of done) rows = rows.concat(s.emit || []);
    const way = M.SEMI_WAYS[state.cfg.way];
    let html = tableUsers(st, (u) => {
      const s = done.find((x) => x.cur === u.id);
      if (!s || s.value === undefined) return '<td></td>';
      return `<td><span class="tag ${s.value === true ? 't-true' : s.value === null ? 't-unk' : ''}">${M.tv(s.value)}</span></td>`;
    });
    if (way.kind === 'in' || way.kind === 'not-in') {
      const list = state.sim.list.map((v) => `<span class="c">${v === null ? 'NULL' : v}</span>`).join('');
      html += `<div class="tblbox"><h3>서브쿼리가 돌려준 목록 <span class="muted">SELECT user_id FROM orders${way.skipNull ? ' WHERE user_id IS NOT NULL' : ''}</span></h3><div class="chain">${list}</div>`;
      const ch = st.chain.map((c) => `<span class="c ${c.e === true ? 't-true' : c.e === null ? 't-unk' : ''}">${st.cur} ${way.kind === 'in' ? '=' : '&lt;&gt;'} ${c.x === null ? 'NULL' : c.x} → ${M.tv(c.e)}</span>`).join(way.kind === 'in' ? ' OR ' : ' AND ');
      html += `<h3 style="margin-top:10px">회원 ${st.cur}의 조건</h3><div class="chain">${ch} <b>= ${M.tv(st.value)}</b></div></div>`;
    } else {
      html += tableOrders(st, { hideFalse: false, stopped: way.kind !== 'join' && st.matches.length > 0 });
    }
    html += resultBox(rows, st.emit || [], [], way.kind === 'join' ? ['u', 'o'] : ['u']);
    $('board').innerHTML = html;
    return [['따진 회원', done.length], ['결과 행', rows.length]];
  }

  function drawAlgo(i) {
    const st = state.sim.steps[i];
    const way = state.cfg.way;
    const orders = state.sim.orders;
    const urows = M.ALGO_USERS.map((u) => {
      let cls = '';
      if (st.cur.t === 'u' && st.cur.id === u.id) cls = 'cur';
      else if (st.hit === u.id && st.cur.t === 'o') cls = 'hit';
      return `<tr class="${cls}"><td>${u.id}</td><td>${u.code}</td></tr>`;
    }).join('');
    const orows = M.ALGO_ORDERS.map((o) => {
      const inScope = orders.some((x) => x.id === o.id);
      let cls = inScope ? '' : 'dim';
      if (st.cur.t === 'o' && st.cur.id === o.id) cls = 'cur';
      else if (st.phase === 'scan' && st.scanned.includes(o.id)) cls = st.hit === o.id ? 'hit' : 'read';
      else if (st.phase === 'probe' && st.cur.t === 'u' && st.hit === o.id) cls = 'hit';
      return `<tr class="${cls}"><td>${o.id}</td><td>${o.user_code}</td></tr>`;
    }).join('');
    const bo = st.buildSide === 'o';
    const drvU = way === 'nl-scan' ? ' <span class="muted">드라이빙</span>' : way === 'hash' ? ` <span class="muted">${bo ? '프로브 입력' : '빌드 입력'}</span>` : ' <span class="muted">드리븐(idx_code로 찾음)</span>';
    const drvO = way === 'nl-scan' ? ' <span class="muted">드리븐(끝까지 읽음)</span>' : way === 'hash' ? ` <span class="muted">${bo ? '빌드 입력' : '프로브 입력'}</span>` : ' <span class="muted">드라이빙</span>';
    let html = `<div class="tblbox"><h3>users${drvU}</h3><table><thead><tr><th>id</th><th>code</th></tr></thead><tbody>${urows}</tbody></table></div>`;
    html += `<div class="tblbox"><h3>orders${drvO}</h3><table><thead><tr><th>id</th><th>user_code</th></tr></thead><tbody>${orows}</tbody></table></div>`;
    if (way === 'hash') {
      const hitCode = st.phase === 'probe' ? st.key : null;
      html += `<div class="tblbox"><h3>해시 테이블 <span class="muted">${st.buildSide === 'o' ? 'orders.user_code' : 'users.code'}</span></h3><div class="hash">${st.hash.map((c) => `<span class="${c === hitCode && st.hit ? 'hit' : ''}">${c}</span>`).join('')}</div></div>`;
    } else if (way === 'nl-index') {
      const codes = M.ALGO_USERS.map((u) => u.code).sort((a, b) => a - b);
      const leaves = [codes.slice(0, 3), codes.slice(3)];
      const which = leaves.findIndex((l) => l.includes(st.key));
      const leafHtml = leaves.map((l, k) => `<span class="pg ${k === which ? 'on' : ''}">리프 ${k + 1}: ${l.map((c) => `<span class="e ${c === st.key ? 'on' : ''}">${c}</span>`).join(' ')}</span>`).join(' ');
      html += `<div class="tblbox tree"><h3>idx_code (code, id) <span class="muted">B+트리, 모형은 2층</span></h3><div><span class="pg on">루트: ${leaves.map((l) => l[0]).join(' | ')}</span></div><div>${leafHtml}</div></div>`;
    }
    $('board').innerHTML = html;
    const t = st.tally;
    const out = [['읽은 행', t.rows]];
    if (way === 'nl-scan') out.push(['비교', t.compares]);
    if (way === 'nl-index') out.push(['내려간 페이지', t.pages]);
    if (way === 'hash') { out.push(['빌드', t.builds]); out.push(['프로브', t.probes]); }
    out.push(['짝', t.matches]);
    return out;
  }

  function drawN1(i) {
    const steps = state.sim.steps;
    const items = steps.map((s, k) => `<li class="${k === i ? 'now' : k > i ? 'future' : ''}"><span>#${k + 1}</span><code>${esc(s.sql)}</code><span>${s.got}행</span></li>`).join('');
    $('board').innerHTML = `<div class="tblbox" style="flex-basis:100%"><h3>앱 → DB 왕복 <span class="muted">한 줄이 쿼리 하나, 왕복 하나</span></h3><ol class="trip">${items}</ol></div>`;
    const st = steps[i];
    return [['쿼리', st.queries], ['받은 행', st.rows], [`왕복 합(셈, ${M.RTTS[state.cfg.rtt].ms}ms × 쿼리)`, `${st.rttSum}ms`]];
  }

  let lastTally = null;
  function renderTally(pairs) {
    const prev = lastTally || {};
    $('tally').innerHTML = pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="${prev[k] !== undefined && prev[k] !== v ? 'changed' : ''}">${esc(v)}</dd></div>`).join('');
    lastTally = Object.fromEntries(pairs);
  }

  function renderCode(st) {
    const sim = state.sim;
    let lines = sim.sql;
    let on = st.line || [];
    if (state.scene === 'n1') {
      const steps = sim.steps;
      if (state.cfg.way === 'n-plus-1') {
        lines = [steps[0].sql, 'SELECT id, amount FROM orders WHERE user_id = ?   -- 받은 회원마다 1번'];
        on = [state.i === 0 ? 0 : 1];
      } else {
        lines = steps.map((s) => s.sql);
        on = [state.i];
      }
    }
    $('code').innerHTML = lines.map((l, k) => `<li class="${on.includes(k) ? 'on' : ''}">${esc(l)}</li>`).join('');
    $('plan').textContent = sim.plan ? `실험의 계획: ${sim.plan}` : (state.scene === 'left' && state.cfg.way === 'left-where' ? '실험의 계획: Nested loop inner join (외부 조인이 내부 조인으로 바뀌어 orders를 먼저 읽음). 관계도는 쿼리의 뜻대로 회원부터 따진다.' : '');
  }

  function renderStrip() {
    $('strip').innerHTML = state.sim.steps.map((s, k) => `<li><button type="button" data-i="${k}">${k + 1}. ${esc(s.note)}</button></li>`).join('');
    for (const b of $('strip').querySelectorAll('button')) b.addEventListener('click', () => go(Number(b.dataset.i)));
  }

  function go(i) {
    const n = state.sim.steps.length;
    state.i = Math.max(0, Math.min(n - 1, i));
    const st = state.sim.steps[state.i];
    if (state.i === 0) lastTally = null;
    const draw = { left: drawLeft, semi: drawSemi, algo: drawAlgo, n1: drawN1 }[state.scene];
    const pairs = draw(state.i);
    let cap = st.note;
    if (state.i === n - 1) {
      const sim = state.sim;
      if (state.scene === 'left' || state.scene === 'semi') cap += ` · 끝: 결과 ${sim.result.length}행`;
      if (state.scene === 'algo') cap += ` · 끝: 짝 ${sim.result}개`;
      if (state.scene === 'n1') cap += ` · 끝: 쿼리 ${sim.queries}번`;
    }
    $('caption').textContent = cap;
    renderTally(pairs);
    renderCode(st);
    $('pos').textContent = `단계 ${state.i + 1} / ${n}`;
    $('first').disabled = $('prev').disabled = state.i === 0;
    $('last').disabled = $('next').disabled = state.i === n - 1;
    for (const b of $('strip').querySelectorAll('button')) {
      if (Number(b.dataset.i) === state.i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    }
  }

  $('first').addEventListener('click', () => go(0));
  $('prev').addEventListener('click', () => go(state.i - 1));
  $('next').addEventListener('click', () => go(state.i + 1));
  $('last').addEventListener('click', () => go(state.sim.steps.length - 1));
  $('guess').addEventListener('input', (e) => store.set(`join06.guess.${state.scene}`, e.target.value));
  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
    if (e.key === 'ArrowRight') { go(state.i + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { go(state.i - 1); e.preventDefault(); }
    else if (e.key === 'Home') { go(0); e.preventDefault(); }
    else if (e.key === 'End') { go(state.sim.steps.length - 1); e.preventDefault(); }
  });
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (SCENE_ORDER.includes(h) && h !== state.scene) setScene(h); });

  setScene(initScene());
})();
