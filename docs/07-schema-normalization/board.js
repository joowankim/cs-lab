// 정규화 관계도의 화면. model.js(NormModel)와 content.js(NormContent)를 쓴다.
(function () {
  'use strict';
  const M = window.NormModel;
  const C = window.NormContent;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 칼럼 이름은 밑줄 뒤에서 줄을 바꿀 수 있게 한다(좁은 화면).
  const head = (s) => esc(s).replace(/_/g, '_<wbr>');
  const nul = (v) => (v === null || v === undefined ? '<span class="null">NULL</span>' : esc(v));
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 저장 못 해도 화면은 그대로 */ } },
  };
  const SCENE_ORDER = ['anomaly', 'denorm', 'fk'];
  const CHOICE_LABEL = { op: '하는 일', schema: '표', query: '쿼리', design: '판', mode: '자식 테이블', end: 'B가 기다리는 동안' };

  const state = { scene: 'anomaly', cfg: {}, sim: null, i: 0 };

  function initScene() {
    const h = (location.hash || '').slice(1);
    if (SCENE_ORDER.includes(h)) return h;
    const s = store.get('norm07.scene');
    return SCENE_ORDER.includes(s) ? s : 'anomaly';
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
        b.addEventListener('click', () => { state.cfg[key] = val; store.set(`norm07.cfg.${state.scene}`, JSON.stringify(state.cfg)); rebuild(); });
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
    $('guess').value = store.get(`norm07.guess.${state.scene}`) || '';
  }

  function setScene(id) {
    state.scene = id;
    store.set('norm07.scene', id);
    if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
    let saved = null;
    try { saved = JSON.parse(store.get(`norm07.cfg.${id}`) || 'null'); } catch (e) { saved = null; }
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
  function cell(col, row) {
    const v = row.vals;
    const hot = row.hot || [];
    if (col.parts) {
      const parts = col.parts.map((p) => (hot.includes(p) ? `<span class="hot">${nul(v[p])}</span>` : `<span>${nul(v[p])}</span>`)).join('');
      return `<td><span class="parts">${parts}</span></td>`;
    }
    const inner = nul(v[col.key]);
    return `<td>${hot.includes(col.key) ? `<span class="hot">${inner}</span>` : inner}</td>`;
  }

  function drawTable(t) {
    const heads = t.cols.map((c) => `<th>${head(c.label)}</th>`).join('');
    const body = t.rows.length ? t.rows.map((r) => {
      const cells = t.cols.map((c) => cell(c, r));
      if (r.tag) cells[cells.length - 1] = cells[cells.length - 1].replace(/<\/td>$/, ` <span class="tag ${r.tagCls}">${esc(r.tag)}</span></td>`);
      return `<tr class="${r.cls || ''}">${cells.join('')}</tr>`;
    }).join('') : `<tr><td colspan="${t.cols.length}" class="null">행 없음</td></tr>`;
    const wide = t.cols.length > 4 || t.cols.some((c) => c.parts);
    return `<div class="tblbox${wide ? ' wide' : ''}"><h3>${esc(t.title)} <span class="muted">${esc(t.role)}</span></h3><table><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function drawOut(out) {
    if (!out) return '';
    let heads;
    let body;
    if (out.flat) {
      const cols = M.COLS.flat;
      heads = cols.map((c) => `<th>${head(c.label)}</th>`).join('');
      body = out.rows.map((r) => `<tr class="${r.cls}">${cols.map((c) => cell(c, { vals: r.vals, hot: [] })).join('')}</tr>`).join('');
    } else {
      heads = out.cols.map((c) => `<th>${head(c)}</th>`).join('');
      body = out.rows.map((r) => `<tr class="${r.cls}">${r.vals.map((v) => `<td>${nul(v)}</td>`).join('')}</tr>`).join('');
    }
    return `<div class="tblbox${out.flat ? ' wide' : ''}"><h3>${esc(out.title)} <span class="muted">이 단계 뒤</span></h3><table><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function drawLocks(locks) {
    if (!locks) return '';
    const body = locks.length ? locks.map((l) => `<tr><td class="nw">${esc(l.who)}</td><td>${esc(l.object)}${l.data !== null ? ` id ${esc(l.data)}` : ''} <span class="sub">${l.type === 'TABLE' ? '테이블' : '레코드(PRIMARY)'}</span></td><td>${esc(l.mode).replace(/,/g, ',<wbr>').replace(/_/g, '_<wbr>')}</td><td class="nw ${l.status === 'WAITING' ? 'st-wait' : 'st-ok'}">${esc(l.status)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="null">락 없음</td></tr>';
    return `<div class="tblbox wide locks"><h3>data_locks <span class="muted">이 단계 뒤, 누가 무엇을 어떤 모드로</span></h3><table><thead><tr><th class="nw">누구</th><th>대상</th><th>모드</th><th>상태</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  let lastTally = null;
  function renderTally(pairs) {
    const prev = lastTally || {};
    $('tally').innerHTML = pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="${prev[k] !== undefined && prev[k] !== v ? 'changed' : ''}">${esc(v)}</dd></div>`).join('');
    lastTally = Object.fromEntries(pairs);
  }

  function renderCode(st) {
    const sim = state.sim;
    const on = st.line || [];
    $('code').innerHTML = sim.sql.map((l, k) => `<li class="${on.includes(k) ? 'on' : ''}">${esc(l)}</li>`).join('');
    let plan = '';
    if (state.scene === 'denorm') plan = `인덱스: ${sim.index}.${sim.plan ? ` 실험의 계획: ${sim.plan}` : ''}`;
    $('plan').textContent = plan;
    let ran = '';
    if (state.scene === 'anomaly') ran = sim.ran ? '맥에서 SQL로 돌린 구성이다.' : '실험에서 돌리지 않은 구성이다(모형).';
    if (state.scene === 'denorm') ran = `모형은 회원 5명·예약 ${M.DN_RES.length}건, Q1은 최근 ${M.Q1_LIMIT}건이다. 실험은 회원 10만·예약 100만, Q1은 최근 20건이다.`;
    if (state.scene === 'fk') ran = state.cfg.mode === 'fk' && state.cfg.end === 'timeout' ? 'A의 락과 B의 대기는 실험의 data_locks와 같다.' : 'B가 X 락을 얻는 단계는 실험에서 기록하지 않은 모형이다.';
    $('ran').textContent = ran;
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
    let html = st.tables.map(drawTable).join('') + drawOut(st.out) + drawLocks(st.locks);
    if (st.error) html += `<p class="err wide">${esc(st.error)}</p>`;
    $('board').innerHTML = html;
    $('caption').textContent = st.note;
    renderTally(st.tally || []);
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
  $('guess').addEventListener('input', (e) => store.set(`norm07.guess.${state.scene}`, e.target.value));
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
