/*
 * 인덱스 관계도의 설명용 실행 모형.
 *
 * 행 16개짜리 작은 orders 표로 B+Tree를 만든다. 리프 한 장에 항목 4개, 루트·중간 한 장에 자식 2개를 둬(실제는 리프 한 장에 약 159행이나
 * 약 928항목, 루트·중간 한 장에 약 900개) 클러스터형 인덱스(PRIMARY)와 보조 인덱스가 모두 루트, 중간, 리프의 3층이 된다. 100만 행의 실제 층 수와 같다.
 * 읽기 장면은 쿼리 하나를 InnoDB가 읽는 순서대로 나눈다. 한 단계는 인덱스 항목이나 행 하나를 읽는 것, 또는 보조 인덱스 항목의 기본 키로
 * PRIMARY를 루트부터 다시 찾는 것이다. 페이지를 한 장 들여다볼 때마다 논리적 읽기 1로 센다. Handler_read_*는 원자료에 남은 꼴대로 센다.
 * 쓰기 장면은 빈 표에 키 16개를 넣으며 페이지 분할과 버퍼 풀(LRU, 더티 페이지, 플러시, 축출)을 그린다. 한 단계는 행 하나다.
 * 락 장면은 실험 README의 04 변형 순서표 9줄을 한 줄씩 그린다.
 * 단계는 이벤트의 순서이고 시간 길이가 아니다.
 * 브라우저에서는 window.IndexModel, Node.js에서는 require()로 쓴다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IndexModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2026-11-14.1';

  function josa(word, pair) {
    const w = String(word).trim().replace(/[)\]'`]+$/, '');
    const ch = w.slice(-1);
    const code = ch.charCodeAt(0);
    let batchim;
    if (code >= 0xac00 && code <= 0xd7a3) batchim = (code - 0xac00) % 28 !== 0;
    else if (/[0-9]/.test(ch)) batchim = '013678'.includes(ch);
    // 영문은 읽는 소리의 끝으로 정한다: l, m, n, ng과 그 뒤에 소리 없는 e(phone, file), 짧은 모음 뒤 t(created_at, OFFSET, LIMIT)는 받침이 있다.
    else batchim = /[lmn]e?$/i.test(w) || /ng$/i.test(w) || /[aeiou]t$/i.test(w);
    return word + (batchim ? pair[0] : pair[1]);
  }
  const I = (w) => josa(w, ['이', '가']);
  const N = (w) => josa(w, ['은', '는']);
  const R = (w) => josa(w, ['을', '를']);
  const W = (w) => josa(w, ['과', '와']);
  const IRA = (w) => josa(w, ['이라', '라']);
  const IDA = (w) => josa(w, ['이다', '다']);
  // 로/으로: 받침이 없거나 ㄹ 받침이면 '로'
  function RO(word) {
    const w = String(word).trim().replace(/[)\]'`]+$/, '');
    const ch = w.slice(-1);
    const code = ch.charCodeAt(0);
    let ro;
    if (code >= 0xac00 && code <= 0xd7a3) { const b = (code - 0xac00) % 28; ro = b === 0 || b === 8; }
    else if (/[0-9]/.test(ch)) ro = !'036'.includes(ch);
    else ro = !(/[mn]e?$/i.test(w) || /ng$/i.test(w) || /[aeiou]t$/i.test(w));
    return word + (ro ? '로' : '으로');
  }
  const num = (n) => Number(n).toLocaleString('en-US');

  // ---------- 작은 표 ----------
  // 실험의 orders와 칼럼이 같다(status, memo는 그리지 않음). id 순서가 곧 시간 순서이고, id 10과 11은 같은 초에 들어온 주문이다.
  // user_id 1은 주문이 많은 고객(6건), 42는 2건, 9는 1건이다. 2026-08-10 이후 주문은 id 13~16이다.
  const ROWS = [
    [1, 7, '2026-01-03 09:12:05', 15000, '01045170921'],
    [2, 1, '2026-01-21 21:40:12', 8500, '01009234282'],
    [3, 23, '2026-02-08 08:05:47', 22000, '01077304282'],
    [4, 15, '2026-02-26 13:31:09', 9900, '01031828890'],
    [5, 1, '2026-03-16 19:58:33', 31000, '01060015533'],
    [6, 42, '2026-04-03 11:24:50', 12000, '01009237710'],
    [7, 9, '2026-04-21 07:46:18', 8000, '01088120347'],
    [8, 1, '2026-05-09 16:03:41', 27500, '01024904282'],
    [9, 36, '2026-05-27 22:17:26', 5400, '01052279164'],
    [10, 31, '2026-06-20 15:36:55', 18000, '01013376021'],
    [11, 1, '2026-06-20 15:36:55', 14200, '01071140988'],
    [12, 50, '2026-07-20 12:09:14', 6700, '01095503316'],
    [13, 1, '2026-08-17 14:20:31', 25000, '01036612875'],
    [14, 12, '2026-09-02 10:05:48', 11300, '01082296450'],
    [15, 42, '2026-09-24 18:44:07', 30400, '01019047730'],
    [16, 1, '2026-10-25 20:15:39', 19800, '01064438502'],
  ].map(([id, user_id, created_at, amount, phone]) => ({ id, user_id, created_at, amount, phone }));
  const ROW = Object.fromEntries(ROWS.map((r) => [r.id, r]));
  const LEAF_CAP = 4;
  const FAN = 2;
  const SINCE = '2026-08-10 00:00:00';
  const mmdd = (t) => t.slice(5, 10);
  const mdhms = (t) => t.slice(5);

  // ---------- 키 비교 ----------
  // LO, HI는 어떤 값보다 작고 큰 값이다. 칼럼 일부만으로 찾을 때 나머지 칼럼을 이것으로 채운다.
  const LO = Object.freeze({ edge: 'lo' });
  const HI = Object.freeze({ edge: 'hi' });
  function cmpVal(a, b) {
    if (a === b) return 0;
    if (a === LO || b === HI) return -1;
    if (a === HI || b === LO) return 1;
    return a < b ? -1 : 1;
  }
  function cmpKey(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmpVal(a[i] === undefined ? LO : a[i], b[i] === undefined ? LO : b[i]);
      if (c) return c;
    }
    return 0;
  }

  // ---------- 인덱스와 B+Tree ----------
  const INDEXES = {
    PRIMARY: { cols: ['id'], ddl: null },
    idx_user: { cols: ['user_id'], ddl: 'CREATE INDEX idx_user ON orders (user_id);' },
    idx_user_created: { cols: ['user_id', 'created_at'], ddl: 'CREATE INDEX idx_user_created ON orders (user_id, created_at);' },
    idx_created_user: { cols: ['created_at', 'user_id'], ddl: 'CREATE INDEX idx_created_user ON orders (created_at, user_id);' },
    idx_user_created_amount: { cols: ['user_id', 'created_at', 'amount'], ddl: 'CREATE INDEX idx_user_created_amount ON orders (user_id, created_at, amount);' },
    idx_created: { cols: ['created_at'], ddl: 'CREATE INDEX idx_created ON orders (created_at);' },
    idx_phone: { cols: ['phone'], ddl: 'CREATE INDEX idx_phone ON orders (phone);' },
  };
  // 리프 항목의 칼럼: 보조 인덱스는 인덱스 칼럼 뒤에 기본 키(id)가 붙는다. PRIMARY 리프는 행 전체다.
  const keyCols = (name) => (name === 'PRIMARY' ? ['id'] : [...INDEXES[name].cols, 'id']);
  const keyOf = (name, row) => keyCols(name).map((c) => row[c]);

  function chunk(list, n) {
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  // 리프는 키 순서로 4개씩, 위층은 아래층 페이지를 2장씩 묶는다. 위층 항목(노드 포인터)의 키는 자식 페이지의 첫 키다.
  function buildTree(name) {
    const entries = ROWS.map((r) => ({ id: `${name}:e${r.id}`, key: keyOf(name, r), row: r.id }))
      .sort((a, b) => cmpKey(a.key, b.key));
    const pages = {};
    let level = chunk(entries, LEAF_CAP).map((list, i) => ({ id: `${name}:L${i + 1}`, tree: name, level: 0, no: i + 1, entries: list }));
    level.forEach((p, i) => {
      p.prev = i ? level[i - 1].id : null;
      p.next = i < level.length - 1 ? level[i + 1].id : null;
      p.entries.forEach((e, j) => { e.page = p.id; e.slot = j; });
    });
    const levels = [level];
    while (level.length > 1) {
      const lv = levels.length;
      level = chunk(level, FAN).map((kids, i) => {
        const id = `${name}:M${lv}-${i + 1}`;
        return { id, tree: name, level: lv, no: i + 1, entries: kids.map((k, j) => ({ id: `${id}#${j}`, key: k.entries[0].key, child: k.id, page: id, slot: j })) };
      });
      levels.push(level);
    }
    const root = level[0];
    // 맨 위 한 장이 루트다. 이름을 루트로 바꾸고 포인터 id도 맞춘다.
    const rid = `${name}:R`;
    root.entries.forEach((e, j) => { e.id = `${rid}#${j}`; e.page = rid; });
    root.id = rid;
    for (const lv of levels) for (const p of lv) pages[p.id] = p;
    for (const lv of levels.slice(1)) for (const p of lv) for (const e of p.entries) pages[e.child].parent = p.id;
    const height = levels.length;
    for (const p of Object.values(pages)) p.name = pageName(p, height);
    const byRow = {};
    for (const e of entries) byRow[e.row] = e;
    return { name, cols: keyCols(name), pages, levels: levels.map((l) => l.map((p) => p.id)).reverse(), root, height, byRow };
  }
  function pageName(p, height) {
    if (p.level === height - 1) return '루트';
    if (p.level === 0) return `리프 ${p.no}`;
    return `중간 ${p.no}`;
  }
  const TREES = {};
  function tree(name) { return TREES[name] || (TREES[name] = buildTree(name)); }

  // ---------- 찾아 내려가기와 옆으로 읽기 ----------
  // ge: key 이상인 첫 항목을 찾는다. 위층에서는 key보다 작은 마지막 포인터를 따라간다(같은 값이 앞 리프 끝에 있을 수 있어서다).
  //     닿은 리프에 key 이상인 항목이 없으면 다음 리프로 넘어간다(페이지 하나 더 읽음).
  // le: key 이하인 마지막 항목을 찾는다. 위층에서는 key 이하인 마지막 포인터를 따라간다. 기본 키로 행 하나를 찾을 때도 이것이다.
  function descend(T, key, mode) {
    const pages = [];
    const ptrs = [];
    let p = T.root;
    while (p.level > 0) {
      pages.push(p.id);
      let k = 0;
      p.entries.forEach((e, i) => { const c = cmpKey(e.key, key); if (mode === 'ge' ? c < 0 : c <= 0) k = i; });
      ptrs.push(p.entries[k].id);
      p = T.pages[p.entries[k].child];
    }
    pages.push(p.id);
    let slot;
    let moved = null;
    if (mode === 'ge') {
      slot = p.entries.findIndex((e) => cmpKey(e.key, key) >= 0);
      if (slot < 0) {
        if (!p.next) return { pages, ptrs, page: p.id, slot: p.entries.length, entry: null, moved };
        moved = { from: p.id, to: p.next };
        p = T.pages[p.next];
        pages.push(p.id);
        slot = 0;
      }
    } else {
      slot = -1;
      p.entries.forEach((e, i) => { if (cmpKey(e.key, key) <= 0) slot = i; });
      if (slot < 0) return { pages, ptrs, page: p.id, slot: -1, entry: null, moved };
    }
    return { pages, ptrs, page: p.id, slot, entry: p.entries[slot], moved };
  }
  // 같은 리프 안의 옆 항목은 페이지를 새로 읽지 않는다. 리프 끝을 넘으면 앞뒤 페이지 번호로 옆 리프를 읽는다.
  function move(T, pos, dir) {
    let p = T.pages[pos.page];
    let slot = pos.slot + (dir === 'desc' ? -1 : 1);
    const pages = [];
    let moved = null;
    if (slot >= p.entries.length) {
      if (!p.next) return { pages, page: p.id, slot, entry: null, moved };
      moved = { from: p.id, to: p.next };
      p = T.pages[p.next];
      pages.push(p.id);
      slot = 0;
    } else if (slot < 0) {
      if (!p.prev) return { pages, page: p.id, slot, entry: null, moved };
      moved = { from: p.id, to: p.prev };
      p = T.pages[p.prev];
      pages.push(p.id);
      slot = p.entries.length - 1;
    }
    return { pages, page: p.id, slot, entry: p.entries[slot], moved };
  }

  // ---------- 글자 ----------
  function colText(col, v, long) {
    if (v === LO) return '−∞';
    if (v === HI) return '+∞';
    if (col === 'created_at') return long ? mdhms(v) : mmdd(v);
    if (col === 'phone') return `'${v}'`;
    if (col === 'amount') return String(v);
    return String(v);
  }
  function entryText(name, e, long) {
    if (name === 'PRIMARY') return `id ${e.key[0]}`;
    const cols = keyCols(name);
    return `(${e.key.map((v, i) => colText(cols[i], v, long)).join(', ')})`;
  }
  function pageLabel(T, id) { return `${T.name} ${T.pages[id].name}`; }
  function pathText(T, pages) { return pages.map((id) => T.pages[id].name).join(', '); }
  const won = (n) => `${num(n)}원`;

  // ---------- 읽기 실행 ----------
  // spec: index(쓰는 인덱스, 없으면 표 전체 읽기), ranges(읽을 구간: from, mode, inRange, start, label), dir, icp(인덱스 안에서 거르는 조건),
  //       covering, where(서버가 거르는 조건), sort(filesort), limit, offset, explain, why(행의 값 설명).
  function runRead(spec) {
    const PK = tree('PRIMARY');
    const IX = spec.index ? tree(spec.index) : null;
    const H = { first: 0, key: 0, last: 0, next: 0, prev: 0, rnd_next: 0 };
    const S = { visits: {}, logical: 0, entries: 0, rows: 0, lookups: 0, results: [], skipped: [], buffer: [], state: {}, done: false };
    const cellsOf = {};
    const views = [];
    const topN = (spec.limit || 0) + (spec.offset || 0);
    const inc = (k) => { H[k] += 1; };

    function visit(pages) {
      for (const id of pages) { S.visits[id] = (S.visits[id] || 0) + 1; S.logical += 1; }
    }
    function mark(rowId, st) { for (const c of cellsOf[rowId] || []) S.state[c] = st; }
    function touch(rowId, cell) { (cellsOf[rowId] = cellsOf[rowId] || []).push(cell); }
    function push(o) {
      visit(o.pages || []);
      views.push({
        label: String(views.length), kind: o.kind, tree: o.tree || null, pages: o.pages || [], ptrs: o.ptrs || [], cells: o.cells || [],
        outcome: o.outcome || null, text: o.text, code: o.code || [], ev: [{ text: o.log || o.text, bad: !!o.bad }],
        visits: { ...S.visits }, logical: S.logical, handler: { ...H }, entries: S.entries, rows: S.rows, lookups: S.lookups,
        results: [...S.results], skipped: [...S.skipped], buffer: [...S.buffer], state: { ...S.state }, done: S.done, call: o.call || null,
      });
    }
    // 서버까지 올라온 행 하나를 처리한다. 조건(Using where), 정렬 버퍼(filesort), OFFSET, LIMIT 순서다.
    // why(row)는 그 행에서 볼 값(예: user_id 1, created_at 08-17)이다.
    function emit(row) {
      const who = N(`id ${row.id}`);
      const desc = spec.why(row);
      const keep = spec.where ? spec.where(row) : true;
      if (!keep) { mark(row.id, 'waste'); return { kind: 'drop', text: `${who} ${IRA(desc)} 조건에 맞지 않아 서버가 버린다(Using where).`, code: ['where'] }; }
      const lead = spec.where ? `${who} ${IRA(desc)} 조건에 맞는다.` : `${who} ${IDA(desc)}.`;
      if (spec.sort) {
        S.buffer.push(row.id);
        S.buffer.sort((a, b) => spec.sort(ROW[a], ROW[b]));
        let out = null;
        if (S.buffer.length > topN) { out = S.buffer.pop(); mark(out, 'waste'); }
        if (out === row.id) return { kind: 'sortout', text: `${lead} 정렬 버퍼에 든 ${topN}행보다 순서가 뒤라 넣지 않는다.`, code: ['order'] };
        mark(row.id, 'used');
        return { kind: 'buf', text: `${lead} 정렬 버퍼(위에서 ${topN}행)에 넣는다.${out ? ` 순서가 가장 뒤인 ${N(`id ${out}`)} 밀려난다.` : ''}`, code: ['order'] };
      }
      if (S.skipped.length < (spec.offset || 0)) {
        S.skipped.push(row.id);
        mark(row.id, 'waste');
        return { kind: 'skip', text: `${lead} OFFSET ${spec.offset}이라 ${S.skipped.length}번째로 세고 버린다(건너뛸 행도 읽는다).`, code: ['limit'] };
      }
      S.results.push(row.id);
      mark(row.id, 'used');
      if (spec.limit && S.results.length >= spec.limit) {
        S.done = true;
        return { kind: 'keep', text: `${lead} 결과에 넣는다. 결과가 ${spec.limit}행이 되어 LIMIT ${spec.limit}에서 멈춘다.`, code: ['limit'] };
      }
      return { kind: 'keep', text: `${lead} 결과에 넣는다.`, code: spec.where ? ['where'] : ['select'] };
    }

    const plan = [`type ${spec.explain.type}`, spec.explain.key ? `key ${spec.explain.key}` : null, spec.explain.extra ? `Extra ${spec.explain.extra}` : null].filter(Boolean).join(', ');
    push({ kind: 'start', text: `시작 전. 옵티마이저가 고른 계획은 ${IDA(plan)}.`, code: [] });

    if (!IX) {
      // 표 전체 읽기: PRIMARY의 맨 앞 리프로 내려가 행을 id 순서로 끝까지 읽는다.
      inc('first'); inc('key'); inc('rnd_next');
      let pos = descend(PK, [LO], 'ge');
      let first = true;
      for (;;) {
        if (!pos.entry) {
          if (!spec.sort) S.done = true;
          push({ kind: 'eof', tree: 'PRIMARY', pages: pos.pages, text: '마지막 행 다음은 표 끝이다. rnd_next 한 번이 끝을 알린다.', code: ['from'] });
          break;
        }
        const row = ROW[pos.entry.row];
        S.rows += 1;
        touch(row.id, pos.entry.id);
        const r = emit(row);
        const head = first
          ? `표 전체 읽기다. PRIMARY를 ${pathText(PK, pos.pages)} 순서로 내려가 맨 앞 행 ${R(`id ${row.id}`)} 읽는다(Handler_read_first, rnd_next).`
          : `다음 행 ${R(`id ${row.id}`)} 읽는다(rnd_next).${pos.moved ? ` ${R(PK.pages[pos.moved.from].name)} 다 읽어 옆 ${RO(PK.pages[pos.moved.to].name)} 넘어갔다.` : ''}`;
        push({ kind: first ? 'first' : 'rnd', tree: 'PRIMARY', pages: pos.pages, ptrs: pos.ptrs || [], cells: [pos.entry.id], outcome: r.kind, text: `${head} ${r.text}`, code: ['from', ...r.code] });
        if (S.done) break;
        inc('rnd_next');
        pos = move(PK, pos, 'asc');
        first = false;
      }
    } else {
      const dir = spec.dir || 'asc';
      const ixName = spec.index;
      outer: for (const [ri, rg] of spec.ranges.entries()) {
        for (const c of rg.start) inc(c);
        let pos = descend(IX, rg.from, rg.mode);
        let kind = 'seek';
        const callName = rg.start.includes('last') ? 'Handler_read_last' : rg.start.includes('first') ? 'Handler_read_first' : 'Handler_read_key';
        const step = dir === 'desc' ? 'prev' : 'next';
        let inCall = true;
        for (;;) {
          let head;
          if (kind === 'seek') {
            const where = rg.start.includes('last') ? '맨 끝 항목' : rg.start.includes('first') ? '맨 앞 항목' : `${rg.label} 자리`;
            head = `${spec.ranges.length > 1 ? `구간 ${ri + 1}. ` : ''}${R(ixName)} ${pathText(IX, pos.moved ? pos.pages.slice(0, -1) : pos.pages)} 순서로 내려가 ${R(where)} 찾는다(${callName}).`;
            if (pos.moved) head += ` ${IX.pages[pos.moved.from].name}에는 찾는 키 이상인 항목이 없어 옆 ${RO(IX.pages[pos.moved.to].name)} 넘어간다.`;
          } else {
            const moved = pos.moved ? ` ${IX.pages[pos.moved.from].name}의 ${dir === 'desc' ? '맨 앞' : '끝'}이라 ${dir === 'desc' ? '앞' : '옆'} ${RO(IX.pages[pos.moved.to].name)} 넘어갔다.` : '';
            head = inCall ? `같은 호출 안에서 ${dir === 'desc' ? '앞' : '다음'} 항목을 읽는다.${moved}` : `${dir === 'desc' ? '앞' : '다음'} 항목을 읽는다(Handler_read_${step}).${moved}`;
          }
          if (!pos.entry) {
            push({ kind: 'eof', tree: ixName, pages: pos.pages, ptrs: pos.ptrs || [], text: `${head} 인덱스의 끝이라 더 읽을 항목이 없다.`, code: ['where'], call: kind === 'seek' ? callName : null });
            break;
          }
          const e = pos.entry;
          const row = ROW[e.row];
          const et = entryText(ixName, e, spec.longKeys);
          S.entries += 1;
          if (!rg.inRange(e.key)) {
            S.state[e.id] = 'waste';
            push({ kind: 'out', tree: ixName, pages: pos.pages, ptrs: pos.ptrs || [], cells: [e.id], outcome: 'out', text: `${head} ${N(et)} ${rg.label}에 들지 않아 이 구간을 끝낸다.`, code: ['where'] });
            break;
          }
          touch(row.id, e.id);
          if (spec.icp && !spec.icp(row)) {
            S.state[e.id] = 'waste';
            push({ kind: 'icp', tree: ixName, pages: pos.pages, ptrs: pos.ptrs || [], cells: [e.id], outcome: 'icp', text: `${head} ${N(et)} ${IRA(spec.icpText(row))} 인덱스 안에서 거른다(Using index condition). 서버로 돌려주지 않고 다음 항목을 읽는다.`, code: ['where'] });
            pos = move(IX, pos, dir);
            kind = 'scan';
            inCall = true;
            continue;
          }
          if (spec.covering) {
            const r = emit(row);
            push({ kind, tree: ixName, pages: pos.pages, ptrs: pos.ptrs || [], cells: [e.id], outcome: r.kind, text: `${head} ${IDA(et)}. 필요한 칼럼이 이 항목에 다 있어 PRIMARY로 가지 않는다(Using index). ${r.text}`, code: ['where', ...r.code] });
          } else {
            push({ kind, tree: ixName, pages: pos.pages, ptrs: pos.ptrs || [], cells: [e.id], outcome: 'entry', text: `${head} ${IDA(et)}. ${spec.needText} 이 항목에 없어 기본 키 ${RO(String(row.id))} PRIMARY를 다시 찾아야 한다.`, code: ['where'] });
            S.lookups += 1;
            const d = descend(PK, [row.id], 'le');
            S.rows += 1;
            touch(row.id, d.entry.id);
            const r = emit(row);
            push({ kind: 'lookup', tree: 'PRIMARY', pages: d.pages, ptrs: d.ptrs, cells: [d.entry.id], outcome: r.kind, text: `기본 키 ${RO(String(row.id))} PRIMARY를 ${pathText(PK, d.pages)} 순서로 다시 찾아 행을 읽는다(두 번 읽기). ${r.text}`, code: ['select', ...r.code] });
          }
          if (S.done) break outer;
          inc(step);
          inCall = false;
          pos = move(IX, pos, dir);
          kind = 'scan';
        }
      }
    }
    if (spec.sort) {
      const sorted = [...S.buffer];
      const out = sorted.slice(spec.offset || 0, (spec.offset || 0) + spec.limit);
      for (const id of sorted.slice(0, spec.offset || 0)) mark(id, 'waste');
      S.results = out;
      S.done = true;
      push({ kind: 'sort', text: `끝까지 읽은 뒤 정렬 버퍼의 ${sorted.length}행을 ${RO(spec.sortText)} 내보낸다(Using filesort).${spec.offset ? ` 앞 ${spec.offset}행은 OFFSET으로 버린다.` : ''}`, code: ['order', 'limit'] });
    } else if (!S.done) {
      S.done = true;
      views[views.length - 1].done = true;
    }
    return { views, handler: { ...H }, logical: S.logical, entries: S.entries, rows: S.rows, lookups: S.lookups, results: [...S.results] };
  }

  // ---------- 읽기 장면 ----------
  const created = (r) => `created_at ${mmdd(r.created_at)}`;
  const sortDesc = (a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1);

  // 문제 상황 1, 1-1: 고객 하나의 최근 3개월 주문. 고객과 인덱스를 고른다.
  const FIND_IX = {
    none: { label: '(가) 없음' },
    user: { label: '(나) (user_id)', index: 'idx_user' },
    user_created: { label: '(다) (user_id, created_at)', index: 'idx_user_created' },
    covering: { label: '(마) (user_id, created_at, amount)', index: 'idx_user_created_amount' },
  };
  function findSpec(cfg) {
    const u = Number(cfg.user);
    const where = (r) => r.user_id === u && r.created_at >= SINCE;
    const base = {
      where, why: (r) => `user_id ${r.user_id}, ${created(r)}`,
      needText: 'amount가', longKeys: false,
    };
    const ix = FIND_IX[cfg.ix];
    if (!ix.index) return { ...base, explain: { type: 'ALL', key: null, extra: 'Using where' } };
    if (cfg.ix === 'user') {
      return { ...base, index: 'idx_user', explain: { type: 'ref', key: 'idx_user', extra: 'Using where' }, needText: 'created_at과 amount가',
        ranges: [{ from: [u, LO], mode: 'ge', inRange: (k) => k[0] === u, start: ['key'], label: `user_id = ${u}` }] };
    }
    const rg = { from: [u, SINCE, LO, LO].slice(0, keyCols(ix.index).length), mode: 'ge', inRange: (k) => k[0] === u && k[1] >= SINCE, start: ['key'], label: `user_id = ${u}, created_at ≥ 08-10` };
    if (cfg.ix === 'user_created') return { ...base, where: null, index: ix.index, explain: { type: 'range', key: ix.index, extra: 'Using index condition' }, ranges: [rg] };
    return { ...base, index: ix.index, covering: true, explain: { type: 'range', key: ix.index, extra: 'Using where; Using index' }, ranges: [rg] };
  }

  // 문제 상황 1의 (다)와 (라): 같은 두 칼럼의 순서만 바꾼 인덱스. (라)는 옵티마이저가 쓰지 않아 FORCE INDEX로 쓰게 한 판도 둔다.
  const ORDER_IX = {
    user_created: { label: '(다) (user_id, created_at)', index: 'idx_user_created' },
    created_user: { label: '(라) (created_at, user_id)', index: 'idx_created_user' },
    force: { label: '(라)에 FORCE INDEX', index: 'idx_created_user' },
  };
  function orderSpec(cfg) {
    const base = findSpec({ user: '42', ix: 'none' });
    if (cfg.ix === 'user_created') return { ...findSpec({ user: '42', ix: 'user_created' }), drawIndex: 'idx_user_created' };
    if (cfg.ix === 'created_user') return { ...base, drawIndex: 'idx_created_user' };
    return { ...base, index: 'idx_created_user', where: null, explain: { type: 'range', key: 'idx_created_user', extra: 'Using index condition' }, needText: 'amount가',
      icp: (r) => r.user_id === 42, icpText: (r) => `user_id가 ${r.user_id}`,
      ranges: [{ from: [SINCE, LO, LO], mode: 'ge', inRange: (k) => k[0] >= SINCE, start: ['key'], label: 'created_at ≥ 08-10' }] };
  }

  // 문제 상황 1-3: 인덱스가 있는데도 범위를 정하지 못하는 쿼리와 견줄 쿼리. 보조 인덱스는 idx_created, idx_phone, idx_user 셋이다.
  const DAY = '2026-06-20';
  const UNUSED_Q = {
    'day-func': { label: "(가) DATE(created_at) = '2026-06-20'", where: `DATE(created_at) = '${DAY}'`, draw: 'idx_created' },
    'day-fix': { label: "(가) 고쳐 쓴 판 created_at = DATE('2026-06-20')", where: `created_at = DATE('${DAY}')`, draw: 'idx_created' },
    'day-range': { label: '(가) 다시 고쳐 쓴 판: 하루 구간', where: `created_at >= '${DAY}' AND created_at < '2026-06-21'`, draw: 'idx_created' },
    'phone-number': { label: '(나) phone = 01009234282 (숫자)', where: 'phone = 01009234282', draw: 'idx_phone' },
    'phone-string': { label: "(나) 고쳐 쓴 판 phone = '01009234282'", where: "phone = '01009234282'", draw: 'idx_phone' },
    'phone-suffix': { label: "(다) phone LIKE '%4282'", where: "phone LIKE '%4282'", draw: 'idx_phone' },
    'phone-prefix': { label: "(다) 견줄 쿼리 phone LIKE '0100923%'", where: "phone LIKE '0100923%'", draw: 'idx_phone' },
    'user-string': { label: "(라) user_id = '42' (문자열)", where: "user_id = '42'", draw: 'idx_user' },
    'user-int': { label: '(라) 견줄 쿼리 user_id = 42', where: 'user_id = 42', draw: 'idx_user' },
  };
  function unusedSpec(cfg) {
    const q = cfg.q;
    const base = { needText: 'amount가', longKeys: q.startsWith('day'), drawIndex: UNUSED_Q[q].draw };
    const whyDay = (r) => `created_at ${mdhms(r.created_at)}`;
    const whyPhone = (r) => `phone '${r.phone}'`;
    const whyUser = (r) => `user_id ${r.user_id}`;
    const all = { type: 'ALL', key: null, extra: 'Using where' };
    switch (q) {
      case 'day-func':
        return { ...base, explain: all, where: (r) => r.created_at.slice(0, 10) === DAY, why: (r) => `${whyDay(r)}, DATE(created_at) 값은 ${r.created_at.slice(0, 10)}` };
      case 'day-fix':
        return { ...base, index: 'idx_created', explain: { type: 'ref', key: 'idx_created', extra: null }, why: whyDay,
          ranges: [{ from: [`${DAY} 00:00:00`, LO], mode: 'ge', inRange: (k) => k[0] === `${DAY} 00:00:00`, start: ['key'], label: `created_at = '${DAY} 00:00:00'` }] };
      case 'day-range':
        return { ...base, index: 'idx_created', explain: { type: 'range', key: 'idx_created', extra: 'Using index condition' }, why: whyDay,
          ranges: [{ from: [`${DAY} 00:00:00`, LO], mode: 'ge', inRange: (k) => k[0] >= `${DAY} 00:00:00` && k[0] < '2026-06-21 00:00:00', start: ['key'], label: '하루 구간' }] };
      case 'phone-number':
        return { ...base, explain: all, where: (r) => Number(r.phone) === 1009234282, why: (r) => `${whyPhone(r)}, 숫자로 바꾸면 ${Number(r.phone)}` };
      case 'phone-string':
        return { ...base, index: 'idx_phone', explain: { type: 'ref', key: 'idx_phone', extra: null }, why: whyPhone,
          ranges: [{ from: ['01009234282', LO], mode: 'ge', inRange: (k) => k[0] === '01009234282', start: ['key'], label: "phone = '01009234282'" }] };
      case 'phone-suffix':
        return { ...base, explain: all, where: (r) => r.phone.endsWith('4282'), why: whyPhone };
      case 'phone-prefix':
        return { ...base, index: 'idx_phone', explain: { type: 'range', key: 'idx_phone', extra: 'Using index condition' }, why: whyPhone,
          ranges: [{ from: ['0100923', LO], mode: 'ge', inRange: (k) => k[0].startsWith('0100923'), start: ['key'], label: "'0100923'으로 시작하는 구간" }] };
      default:
        return { ...base, index: 'idx_user', explain: { type: 'ref', key: 'idx_user', extra: null }, why: whyUser,
          ranges: [{ from: [42, LO], mode: 'ge', inRange: (k) => k[0] === 42, start: ['key'], label: 'user_id = 42' }] };
    }
  }

  // 문제 상황 2: 최신순 목록. 목록 크기는 LIMIT 3(실험은 20)이다. (바)는 목표 1 확인의 쿼리 2(BETWEEN)를 작은 표로 옮긴 것이다.
  const SORT_IX = {
    none: { label: '(가) 없음' },
    created: { label: '(나) (created_at)' },
    user: { label: '(다) (user_id)' },
    user_created: { label: '(라) (user_id, created_at)' },
    between: { label: '(바) BETWEEN과 (user_id, created_at)' },
  };
  function sortSpec(cfg) {
    const why = (r) => created(r);
    const base = { limit: 3, why, needText: 'amount가', sortText: 'created_at 내림차순' };
    switch (cfg.ix) {
      case 'none':
        return { ...base, sort: sortDesc, explain: { type: 'ALL', key: null, extra: 'Using filesort' }, needText: 'user_id와 amount가' };
      case 'created':
        return { ...base, index: 'idx_created', dir: 'desc', explain: { type: 'index', key: 'idx_created', extra: 'Backward index scan' }, needText: 'user_id와 amount가',
          ranges: [{ from: [HI, HI], mode: 'le', inRange: () => true, start: ['last', 'key'], label: '맨 끝' }] };
      case 'user':
        return { ...base, index: 'idx_user', sort: sortDesc, needText: 'created_at과 amount가', explain: { type: 'ref', key: 'idx_user', extra: 'Using filesort' },
          ranges: [{ from: [1, LO], mode: 'ge', inRange: (k) => k[0] === 1, start: ['key'], label: 'user_id = 1' }] };
      case 'user_created':
        return { ...base, index: 'idx_user_created', dir: 'desc', explain: { type: 'ref', key: 'idx_user_created', extra: 'Backward index scan' },
          ranges: [{ from: [1, HI, HI], mode: 'le', inRange: (k) => k[0] === 1, start: ['key'], label: 'user_id = 1의 맨 끝' }] };
      default:
        return { ...base, index: 'idx_user_created', sort: sortDesc, explain: { type: 'range', key: 'idx_user_created', extra: 'Using index condition; Using filesort' },
          why: (r) => `user_id ${r.user_id}, ${created(r)}`,
          ranges: [{ from: [7, LO, LO], mode: 'ge', inRange: (k) => k[0] >= 7 && k[0] <= 15, start: ['key'], label: 'user_id 7~15' }] };
    }
  }

  // 문제 상황 2-1: 목록 페이지(3행씩). 2번째 페이지는 경계에 같은 초가 없고(실험의 5,001번째), 3번째 페이지는 경계 행 id 11과 같은 초인
  // id 10이 다음 페이지 첫 행이다(실험의 170번째).
  const PAGE_WAYS = {
    offset: { label: 'OFFSET' },
    asc: { label: '처음 쓴 커서 (오름차순)' },
    lt: { label: 'created_at만 기억한 커서 <' },
    le: { label: 'created_at만 기억한 커서 <=' },
    or: { label: '(created_at, id) 커서, OR 꼴' },
    row: { label: '(created_at, id) 커서, 행 생성자' },
  };
  const PAGE_EDGE = { 2: 14, 3: 11 };
  function pageSpec(cfg) {
    const n = Number(cfg.page);
    const edge = ROW[PAGE_EDGE[n]];
    const c = edge.created_at;
    const why = (r) => `created_at ${mdhms(r.created_at)}`;
    const base = { limit: 3, why, needText: 'user_id와 amount가', longKeys: true, edge: edge.id };
    const asc = { type: 'range', key: 'idx_created', extra: 'Using index condition' };
    const desc = { type: 'range', key: 'idx_created', extra: 'Using index condition; Backward index scan' };
    switch (cfg.way) {
      case 'offset':
        return { ...base, offset: (n - 1) * 3, index: 'idx_created', dir: 'desc', explain: { type: 'index', key: 'idx_created', extra: 'Backward index scan' },
          ranges: [{ from: [HI, HI], mode: 'le', inRange: () => true, start: ['last', 'key'], label: '맨 끝' }] };
      case 'asc':
        return { ...base, index: 'idx_created', explain: asc,
          ranges: [{ from: [LO, LO], mode: 'ge', inRange: (k) => k[0] < c, start: ['first', 'key'], label: `created_at < '${mdhms(c)}'` }] };
      case 'lt':
        return { ...base, index: 'idx_created', dir: 'desc', explain: desc,
          ranges: [{ from: [c, LO], mode: 'le', inRange: (k) => k[0] < c, start: ['key'], label: `created_at < '${mdhms(c)}'` }] };
      case 'le':
        return { ...base, index: 'idx_created', dir: 'desc', explain: desc,
          ranges: [{ from: [c, HI], mode: 'le', inRange: (k) => k[0] <= c, start: ['key'], label: `created_at <= '${mdhms(c)}'` }] };
      case 'or':
        return { ...base, index: 'idx_created', dir: 'desc', explain: desc,
          ranges: [
            { from: [c, edge.id - 0.5], mode: 'le', inRange: (k) => k[0] === c && k[1] < edge.id, start: ['key'], label: `created_at = '${mdhms(c)}' AND id < ${edge.id}` },
            { from: [c, LO], mode: 'le', inRange: (k) => k[0] < c, start: ['key'], label: `created_at < '${mdhms(c)}'` },
          ] };
      default:
        return { ...base, index: 'idx_created', dir: 'desc', explain: { type: 'index', key: 'idx_created', extra: 'Using where; Backward index scan' },
          where: (r) => r.created_at < c || (r.created_at === c && r.id < edge.id),
          ranges: [{ from: [HI, HI], mode: 'le', inRange: () => true, start: ['last', 'key'], label: '맨 끝' }] };
    }
  }

  // ---------- 쓰기 장면: 페이지 분할과 버퍼 풀 ----------
  // 빈 표에 키 16개를 차례로 넣는다. 처음부터 루트 한 장과 빈 리프 한 장이 있다(루트 올림은 그리지 않음). 리프 한 장에 행 4개다.
  // 꽉 찬 리프에 넣을 때, 그 리프가 맨 끝 리프이고 새 키가 가장 크면 끝 분할(새 리프에 새 행만), 아니면 가운데 분할(뒤의 반을 새 리프로)이다.
  // 버퍼 풀은 페이지 8장(넉넉함) 또는 4장(모자람)이고 LRU다. 행 하나를 넣을 때 루트와 넣을 리프를 읽고(논리적 읽기 2),
  // 넣을 리프가 버퍼 풀에 없으면 디스크에서 읽는다(물리적 읽기, 미스). 자리가 없으면 가장 오래 쓰지 않은 페이지를 내보내고(축출),
  // 더티 페이지면 먼저 디스크에 쓴다(플러시). 가운데 분할은 옆 리프의 앞 페이지 번호도 고쳐 그 리프를 읽는다.
  const PK_KEYS = {
    auto: { label: '(라) BIGINT AUTO_INCREMENT', keys: Array.from({ length: 16 }, (_, i) => i + 1) },
    uuid4: { label: '(마) UUIDv4', keys: ['41', 'e3', '48', '3a', 'c3', 'd9', 'be', '52', '84', '2e', '34', '4c', '28', 'da', 'cd', '80'] },
    uuid7: { label: '(바) UUIDv7', keys: ['1a', '1f', '1c', '1e', '2b', '2e', '2c', '2d', '3a', '3d', '3b', '3f', '4c', '4f', '4d', '4e'] },
  };
  const POOLS = { big: { label: '8페이지 (표가 다 들어감)', frames: 8 }, small: { label: '4페이지 (모자람)', frames: 4 } };

  function runSplit(cfg) {
    const keys = PK_KEYS[cfg.pk].keys;
    const frames = POOLS[cfg.pool].frames;
    let leafNo = 1;
    const leaves = { L1: { id: 'L1', keys: [], next: null, prev: null } };
    const order = ['L1'];     // 키 순서의 리프 목록
    const lru = ['R', 'L1'];  // 앞이 가장 최근에 쓴 페이지
    const dirty = { R: true, L1: true };
    const C = { logical: 0, physical: 0, splits: 0, endSplits: 0, midSplits: 0, flushes: 0, evictions: 0 };
    const views = [];
    const pname = (id) => (id === 'R' ? '루트' : `리프 ${id.slice(1)}`);
    function snap(o) {
      views.push({
        label: String(views.length), key: o.key === undefined ? null : o.key, text: o.ev.map((e) => e.text).join(' '), ev: o.ev,
        code: o.code || [], visit: o.visit || [], miss: o.miss || [], made: o.made || null, split: o.split || null, evicted: o.evicted || [], flushed: o.flushed || [],
        target: o.target || null, sibling: o.sibling || null,
        leaves: order.map((id) => ({ id, keys: [...leaves[id].keys] })), lru: [...lru], dirty: Object.keys(dirty).filter((k) => dirty[k]),
        counts: { ...C, leaves: order.length, rows: order.reduce((a, id) => a + leaves[id].keys.length, 0) }, done: !!o.done,
      });
    }
    // 자리를 하나 만든다. 지금 쓰는 페이지(pin)는 내보내지 않는다.
    function makeRoom(pin, log) {
      while (lru.length >= frames) {
        let k = lru.length - 1;
        while (k >= 0 && pin.includes(lru[k])) k -= 1;
        if (k < 0) break;
        const victim = lru[k];
        lru.splice(k, 1);
        C.evictions += 1;
        log.evicted.push(victim);
        if (dirty[victim]) {
          C.flushes += 1;
          delete dirty[victim];
          log.flushed.push(victim);
          log.ev.push({ text: `버퍼 풀이 꽉 차 가장 오래 쓰지 않은 ${R(pname(victim))} 축출한다. 더티 페이지라 먼저 디스크에 쓴다(플러시).` });
        } else {
          log.ev.push({ text: `버퍼 풀이 꽉 차 가장 오래 쓰지 않은 ${R(pname(victim))} 축출한다. 바뀐 것이 없어 쓰지 않는다.` });
        }
      }
    }
    // 페이지 하나를 들여다본다(논리적 읽기). 버퍼 풀에 있으면 적중, 없으면 자리를 만들고 디스크에서 읽는다(미스, 물리적 읽기).
    function use(id, pin, log) {
      C.logical += 1;
      log.visit.push(id);
      const at = lru.indexOf(id);
      if (at >= 0) { lru.splice(at, 1); lru.unshift(id); return true; }
      log.ev.push({ text: `${I(pname(id))} 버퍼 풀에 없다(미스).` });
      makeRoom(pin, log);
      C.physical += 1;
      log.miss.push(id);
      lru.unshift(id);
      log.ev.push({ text: `${R(pname(id))} 디스크에서 읽어 온다(물리적 읽기).`, bad: true });
      return false;
    }
    const fmt = (k) => String(k);
    snap({ ev: [{ text: `시작 전. 빈 표에 루트와 빈 리프 1이 있다. 버퍼 풀은 ${frames}페이지다.` }] });
    keys.forEach((key, i) => {
      const log = { visit: [], miss: [], evicted: [], flushed: [], ev: [] };
      // 루트에서 넣을 리프를 고른다(키 이하인 마지막 포인터).
      let t = order[0];
      for (const id of order) if (leaves[id].keys.length && cmpVal(leaves[id].keys[0], key) <= 0) t = id;
      log.ev.push({ text: `키 ${R(fmt(key))} 넣는다. 루트에서 찾은 자리는 ${IDA(pname(t))}.` });
      use('R', ['R'], log);
      use(t, ['R', t], log);
      const L = leaves[t];
      let split = null;
      let made = null;
      let sibling = null;
      if (L.keys.length < LEAF_CAP) {
        L.keys.push(key);
        L.keys.sort((a, b) => cmpVal(a, b));
        dirty[t] = true;
        log.ev.push({ text: `${pname(t)}에 자리가 있어 그대로 넣는다. ${N(pname(t))} 더티 페이지가 된다.` });
      } else {
        leafNo += 1;
        made = `L${leafNo}`;
        const rightmost = order[order.length - 1] === t;
        const last = L.keys[L.keys.length - 1];
        const N2 = { id: made, keys: [], next: L.next, prev: t };
        C.splits += 1;
        if (rightmost && cmpVal(key, last) > 0) {
          split = 'end';
          C.endSplits += 1;
          N2.keys = [key];
          log.ev.push({ text: `${N(pname(t))} 꽉 찼고 맨 끝 리프이며, 새 키가 가장 크다. ${N(pname(t))} 그대로 두고 새 ${pname(made)}에 새 행만 넣는다(끝 분할). 루트에 포인터를 더한다.` });
        } else {
          split = 'mid';
          C.midSplits += 1;
          const all = [...L.keys];
          L.keys = all.slice(0, LEAF_CAP / 2);
          N2.keys = all.slice(LEAF_CAP / 2);
          const moved = N2.keys.map(fmt).join(', ');
          if (cmpVal(key, N2.keys[0]) < 0) L.keys.push(key); else N2.keys.push(key);
          L.keys.sort((a, b) => cmpVal(a, b));
          N2.keys.sort((a, b) => cmpVal(a, b));
          log.ev.push({ text: `${N(pname(t))} 꽉 찼고 키가 가운데로 들어간다. 뒤의 반(${moved})을 새 ${RO(pname(made))} 옮기고 키를 넣는다(가운데 분할). 두 리프가 반쯤 찬다. 루트에 포인터를 더한다.` });
        }
        makeRoom(['R', t], log);
        lru.unshift(made);
        dirty[made] = true;
        dirty[t] = true;
        dirty.R = true;
        if (N2.next) {
          // 가운데 분할: 새 리프의 다음 리프는 원래 리프의 다음 리프다. 그 리프의 앞 페이지 번호를 새 리프로 고친다.
          sibling = N2.next;
          log.ev.push({ text: `옆 ${pname(N2.next)}의 앞 페이지 번호를 ${RO(pname(made))} 고치려고 ${R(pname(N2.next))} 읽는다.` });
          use(N2.next, ['R', t, made, N2.next], log);
          dirty[N2.next] = true;
          leaves[N2.next].prev = made;
        }
        leaves[made] = N2;
        L.next = made;
        order.splice(order.indexOf(t) + 1, 0, made);
      }
      snap({ key, target: t, ev: log.ev, code: ['insert'], visit: log.visit, miss: log.miss, made, split, sibling, evicted: log.evicted, flushed: log.flushed, done: i === keys.length - 1 });
    });
    return { views, counts: { ...C, leaves: order.length }, keys, frames };
  }

  // ---------- 락 장면: 04 변형 순서표 ----------
  // REPEATABLE READ, 세션 A와 B. 고객 42는 주문 2건(id 6, 15, amount 합 42,400), 고객 9는 1건(id 7, 8,000)이다.
  const LOCK_STEPS = [
    { s: 'A', sql: 'START TRANSACTION;' },
    { s: 'A', sql: 'UPDATE orders SET amount = amount + 100 WHERE user_id = 42;' },
    { s: 'B', sql: 'START TRANSACTION;' },
    { s: 'B', sql: 'SELECT SUM(amount) FROM orders WHERE user_id = 42;' },
    { s: 'B', sql: 'SELECT SUM(amount) FROM orders WHERE user_id = 9 FOR UPDATE;' },
    { s: 'A', sql: 'COMMIT;' },
    { s: 'B', sql: 'SELECT SUM(amount) FROM orders WHERE user_id = 42;' },
    { s: 'B', sql: 'SELECT SUM(amount) FROM orders WHERE user_id = 42 FOR SHARE;' },
    { s: 'B', sql: 'COMMIT;' },
  ];
  function runLock(cfg) {
    const withIx = cfg.ix === 'user';
    const PK = tree('PRIMARY');
    const IX = tree('idx_user');
    const pkCell = (id) => `PRIMARY:e${id}`;
    const ixCell = (id) => `idx_user:e${id}`;
    const sup = (T, leaf) => `${T.name}:L${leaf}:sup`;
    let locks = [];   // { s, index, cell, data, mode, status }
    const amount = Object.fromEntries(ROWS.map((r) => [r.id, r.amount]));
    const pending = {};   // A가 고쳤지만 커밋하지 않은 값
    const sess = { A: { state: 'turn', trx: '', last: '' }, B: { state: 'turn', trx: '', last: '' } };
    let snapshot = null;  // B의 스냅숏(4번에서 만듦)
    let waiting = null;   // { s, cell, blocking }
    const views = [];
    const lockData = (T, id) => (T.name === 'PRIMARY' ? String(id) : `${ROW[id].user_id}, ${id}`);
    function add(s, T, id, mode, status) { locks.push({ s, index: T.name, cell: T.name === 'PRIMARY' ? pkCell(id) : ixCell(id), data: lockData(T, id), mode, status: status || 'GRANTED' }); }
    function addSup(s, T, leaf, mode) { locks.push({ s, index: T.name, cell: sup(T, leaf), data: 'supremum pseudo-record', mode, status: 'GRANTED' }); }
    // 인덱스 없이 잠그며 읽기: PRIMARY를 처음부터 끝까지 훑으며 모든 레코드와 리프마다 supremum에 넥스트 키 락을 건다.
    function lockAll(s, mode) {
      for (const leafId of PK.levels[PK.levels.length - 1]) {
        const leaf = PK.pages[leafId];
        for (const e of leaf.entries) add(s, PK, e.row, mode);
        addSup(s, PK, leaf.no, mode);
      }
    }
    // idx_user로 잠그며 읽기: 그 user_id의 항목에 넥스트 키 락, 다음 항목에 갭 락, PRIMARY의 그 행에 레코드 락.
    function lockUser(s, user, mode) {
      const list = ROWS.filter((r) => r.user_id === user).map((r) => IX.byRow[r.id]);
      for (const e of list) add(s, IX, e.row, mode);
      const last = list[list.length - 1];
      const nx = move(IX, { page: last.page, slot: last.slot }, 'asc');
      if (nx.entry) add(s, IX, nx.entry.row, `${mode},GAP`);
      for (const e of list) add(s, PK, e.row, `${mode},REC_NOT_GAP`);
    }
    const sum = (user, view) => ROWS.filter((r) => r.user_id === user).reduce((a, r) => a + (view === 'latest' ? (pending[r.id] !== undefined ? pending[r.id] : amount[r.id]) : view[r.id]), 0);
    function snap(i, text, extra) {
      views.push({
        label: String(views.length), step: i, text, ev: [{ text, bad: false }], code: i ? [`s${i}`] : [],
        sess: JSON.parse(JSON.stringify(sess)), locks: locks.map((l) => ({ ...l })), wait: waiting ? { ...waiting } : null,
        amount: { ...amount }, pending: { ...pending }, snapshot: snapshot ? { ...snapshot } : null, ...(extra || {}),
      });
    }
    snap(0, `시작 전. 두 세션 A와 B가 연결되어 있고 격리 수준은 REPEATABLE READ다. ${withIx ? 'idx_user가 있다.' : '보조 인덱스가 없다.'}`);
    const setRun = (s) => { for (const k of ['A', 'B']) if (sess[k].state === 'run') sess[k].state = 'turn'; if (sess[s].state !== 'done') sess[s].state = 'run'; };
    LOCK_STEPS.forEach((st, k) => {
      const i = k + 1;
      setRun(st.s);
      let text = '';
      let rowsLocked = null;
      if (i === 1) { sess.A.trx = '트랜잭션 진행'; sess.A.last = ''; text = 'A가 트랜잭션을 시작한다.'; }
      if (i === 2) {
        for (const r of ROWS.filter((x) => x.user_id === 42)) pending[r.id] = amount[r.id] + 100;
        if (withIx) {
          lockUser('A', 42, 'X');
          text = 'A가 idx_user로 user_id = 42 항목 2개만 읽어 고친다. idx_user의 (42, 6), (42, 15)에 넥스트 키 락, 다음 항목 (50, 12) 앞 갭에 갭 락, PRIMARY의 id 6, 15에 레코드 락을 건다(락 5개).';
        } else {
          lockAll('A', 'X');
          text = 'A가 보조 인덱스 없이 user_id = 42를 찾으려고 PRIMARY를 처음부터 끝까지 훑는다. 훑은 행 16개와 리프마다 supremum 4개에 X 락을 걸고, 조건에 맞지 않은 행의 락도 풀지 않는다(락 20개).';
        }
        rowsLocked = locks.filter((l) => l.s === 'A').length;
        sess.A.last = '2행 고침';
      }
      if (i === 3) { sess.B.trx = '트랜잭션 진행'; text = 'B가 트랜잭션을 시작한다.'; }
      if (i === 4) {
        snapshot = { ...amount };
        const v = sum(42, snapshot);
        sess.B.last = `합 ${num(v)}`;
        text = `B의 평범한 SELECT는 락을 걸지 않는 일관된 읽기다. 이 트랜잭션의 첫 평범한 SELECT라 여기서 스냅숏을 만든다. A가 고친 id 6, 15는 커밋 전이라 스냅숏에 없고, undo 로그로 되돌린 옛 값을 읽어 ${num(v)}이다. A의 X 락을 기다리지 않는다.`;
      }
      if (i === 5) {
        if (withIx) {
          lockUser('B', 9, 'X');
          sess.B.last = `합 ${num(sum(9, 'latest'))}`;
          text = 'B가 idx_user로 user_id = 9 항목만 잠근다. (9, 7)에 넥스트 키 락, (12, 14) 앞 갭에 갭 락, PRIMARY id 7에 레코드 락이다. A가 잠근 항목과 겹치지 않아 바로 끝나 8,000을 돌려준다.';
        } else {
          add('B', PK, 1, 'X', 'WAITING');
          waiting = { s: 'B', cell: pkCell(1), blocking: 'A' };
          sess.B.state = 'event';
          sess.B.last = '';
          text = 'B도 인덱스가 없어 user_id = 9를 찾으려고 PRIMARY를 처음부터 잠그며 훑는다. 첫 행 id 1의 X 락을 요청했는데 A가 X 락을 보유하고 있어 기다린다. 다른 고객인데도 막힌다.';
        }
      }
      if (i === 6) {
        Object.assign(amount, pending);
        for (const id of Object.keys(pending)) delete pending[id];
        locks = locks.filter((l) => l.s !== 'A');
        sess.A.trx = '';
        sess.A.last = '커밋';
        text = 'A가 커밋한다. id 6, 15의 새 값(12,100, 30,500)이 커밋되고 A의 락이 모두 해제된다.';
        if (waiting) {
          locks = locks.filter((l) => l.status !== 'WAITING');
          lockAll('B', 'X');
          waiting = null;
          sess.B.state = 'run';
          sess.B.last = `합 ${num(sum(9, 'latest'))}`;
          text += ' 기다리던 B의 5번이 id 1의 락을 얻고 이어서 PRIMARY 전체를 잠그며 훑어 끝난다. 8,000을 돌려준다(B의 락 20개).';
        }
        sess.A.state = 'done';
      }
      if (i === 7) {
        const v = sum(42, snapshot);
        sess.B.last = `합 ${num(v)}`;
        text = `B의 평범한 SELECT는 4번에 만든 스냅숏을 다시 읽는다. A의 커밋은 스냅숏을 만든 뒤라 보이지 않아 ${num(v)}이다.`;
      }
      if (i === 8) {
        const v = sum(42, 'latest');
        if (withIx) {
          lockUser('B', 42, 'S');
          text = `B의 FOR SHARE는 잠그며 읽기라 스냅숏이 아니라 최신 커밋 값을 읽는다. (42, 6), (42, 15)에 S 넥스트 키 락, (50, 12) 앞 갭에 S 갭 락, PRIMARY id 6, 15에 S 레코드 락을 건다. A는 이미 커밋해 막는 락이 없다. ${num(v)}이다.`;
        } else {
          text = `B의 FOR SHARE는 잠그며 읽기라 최신 커밋 값을 읽는다. B가 5번에서 PRIMARY 전체에 X 락을 이미 보유해 새 락은 생기지 않는다. A는 이미 커밋해 막는 락이 없다. ${num(v)}이다.`;
        }
        sess.B.last = `합 ${num(v)}`;
      }
      if (i === 9) {
        locks = locks.filter((l) => l.s !== 'B');
        sess.B.trx = '';
        sess.B.last = '커밋';
        sess.B.state = 'done';
        text = 'B가 커밋해 B의 락이 모두 해제된다.';
      }
      snap(i, text, rowsLocked !== null ? { rowsLocked } : null);
    });
    return { views, steps: LOCK_STEPS };
  }

  // ---------- 장면 ----------
  const SCENARIOS = {
    find: { title: '찾기와 두 번 읽기', kind: 'read' },
    order: { title: '복합 인덱스의 칼럼 순서', kind: 'read' },
    unused: { title: '인덱스가 쓰이지 않는 경우', kind: 'read' },
    sort: { title: '정렬 생략', kind: 'read' },
    page: { title: 'OFFSET과 커서', kind: 'read' },
    split: { title: '페이지 분할과 버퍼 풀', kind: 'split' },
    lock: { title: '인덱스와 락 범위', kind: 'lock' },
  };
  const CHOICES = {
    find: { user: ['42', '1'], ix: Object.keys(FIND_IX) },
    order: { ix: Object.keys(ORDER_IX), cond: ['user_first', 'created_first'] },
    unused: { q: Object.keys(UNUSED_Q) },
    sort: { ix: Object.keys(SORT_IX) },
    page: { way: Object.keys(PAGE_WAYS), page: ['2', '3'] },
    split: { pk: Object.keys(PK_KEYS), pool: Object.keys(POOLS) },
    lock: { ix: ['none', 'user'] },
  };
  const DEFAULTS = {
    find: { user: '42', ix: 'user' },
    order: { ix: 'user_created', cond: 'user_first' },
    unused: { q: 'day-func' },
    sort: { ix: 'created' },
    page: { way: 'offset', page: '3' },
    split: { pk: 'uuid4', pool: 'small' },
    lock: { ix: 'none' },
  };
  function normalizeConfig(scene, input) {
    const src = input || {};
    const out = { ...DEFAULTS[scene] };
    for (const [k, list] of Object.entries(CHOICES[scene] || {})) if (list.includes(src[k])) out[k] = src[k];
    return out;
  }

  // 원자료(results/*-index-*.jsonl)의 case와 query. 모형의 계획(type, key, Extra)과 Handler_read_*의 꼴을 이 기록과 견준다.
  // 짝이 없는 구성은 컨테이너에서만 확인했거나(예: 고객 42의 커버링 인덱스) 실험에서 돌리지 않은 것이다.
  const RAW = {
    find: {
      '42|none': ['s1-none', 'recent-4242'], '42|user': ['s1-user', 'recent-4242'], '42|user_created': ['s1-user-created', 'recent-4242'],
      '1|none': ['s1-1-none', 'recent-1'], '1|user': ['s1-1-user', 'recent-1'], '1|user_created': ['s1-1-user-created', 'recent-1'], '1|covering': ['s1-1-covering', 'recent-1'],
    },
    order: {
      // WHERE 조건의 순서만 바꾼 판(created_first)은 컨테이너에서만 확인해 원자료가 없다.
      'user_created|user_first': ['s1-user-created', 'recent-4242'], 'created_user|user_first': ['s1-created-user', 'recent-4242'],
    },
    unused: {
      'day-func': ['s1-3-indexes', 'day-func'], 'day-fix': ['s1-3-fix', 'day-fix-person'], 'day-range': ['s1-3-indexes', 'day-range'],
      'phone-number': ['s1-3-indexes', 'phone-number'], 'phone-string': ['s1-3-indexes', 'phone-string'], 'phone-suffix': ['s1-3-indexes', 'phone-suffix'],
      'phone-prefix': ['s1-3-indexes', 'phone-prefix'], 'user-string': ['s1-3-indexes', 'user-string'], 'user-int': ['s1-3-indexes', 'user-int'],
    },
    sort: { none: ['s2-none', 'latest-20'], created: ['s2-created', 'latest-20'], user: ['s2-user', 'user1-latest-20'], user_created: ['s2-user-created', 'user1-latest-20'] },
    page: {
      'offset|2': ['s2-created', 'latest-offset-100k-force'], 'offset|3': ['s2-created', 'latest-offset-p170'], 'asc|2': ['s2-created', 'latest-cursor-person-hyphen-fixed'],
      'lt|2': ['s2-created', 'latest-cursor-person-2'], 'lt|3': ['s2-created', 'latest-cursor-person-2-p170'],
      'or|2': ['s2-created', 'latest-cursor-or'], 'or|3': ['s2-created', 'latest-cursor-or-p170'], 'row|2': ['s2-created', 'latest-cursor-row'],
    },
  };
  function rawKey(scene, cfg) { return Object.values(cfg).join('|'); }

  const SPEC = { find: findSpec, order: orderSpec, unused: unusedSpec, sort: sortSpec, page: pageSpec };
  function specOf(scene, cfg) { return SPEC[scene](cfg); }

  function simulate(scene, input) {
    const cfg = normalizeConfig(scene, input);
    const kind = SCENARIOS[scene].kind;
    if (kind === 'split') {
      const r = runSplit(cfg);
      return { scene, cfg, kind, title: `${SCENARIOS[scene].title} · ${PK_KEYS[cfg.pk].label} · 버퍼 풀 ${POOLS[cfg.pool].label}`, ...r };
    }
    if (kind === 'lock') {
      const r = runLock(cfg);
      return { scene, cfg, kind, title: `${SCENARIOS[scene].title} · ${cfg.ix === 'user' ? '(나) idx_user' : '(가) 보조 인덱스 없음'}`, ...r };
    }
    const spec = specOf(scene, cfg);
    const r = runRead(spec);
    const drawIndex = spec.index || spec.drawIndex || null;
    return { scene, cfg, kind, spec, explain: spec.explain, index: spec.index || null, drawIndex, trees: drawIndex ? [drawIndex, 'PRIMARY'] : ['PRIMARY'], raw: (RAW[scene] || {})[rawKey(scene, cfg)] || null, ...r };
  }

  return { VERSION, ROWS, ROW, LEAF_CAP, FAN, SINCE, INDEXES, SCENARIOS, CHOICES, DEFAULTS, FIND_IX, ORDER_IX, UNUSED_Q, SORT_IX, PAGE_WAYS, PAGE_EDGE, PK_KEYS, POOLS, LOCK_STEPS, RAW,
    LO, HI, cmpKey, keyCols, tree, descend, move, entryText, colText, mmdd, mdhms, num, normalizeConfig, specOf, runRead, runSplit, runLock, simulate, josa };
});
