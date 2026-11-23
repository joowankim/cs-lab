// 정규화 관계도의 설명용 모형. 브라우저에서는 window.NormModel, Node.js에서는 require로 쓴다.
// 작은 표로 이상(갱신·삽입·삭제), 나누기와 되살리기, 정규화 대 비정규화의 읽기·쓰기, 외래 키 검사의 락을 한 단계씩 따라간다.
// 단계마다 표의 행(그 단계가 끝난 뒤의 값)과 표시(지금 행, 짝, 경고, 지운 행), 결과, 개수를 돌려준다.
// 단계는 이벤트의 순서이고 시간 길이가 아니다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NormModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2026-11-23';
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // 단계마다 그때의 값을 남긴다(뒤 단계에서 행을 고쳐도 앞 단계의 그림은 그대로).
  const push = (steps, s) => steps.push(clone(s));

  // ---------- 장면 1: 이상과 나누기 ----------
  // experiments/07-schema-normalization/sql/01-flat-anomalies.sql, 02-normalized-restore.sql의 행과 같다.
  const FLAT = [
    { id: 1, email: 'kim@a.com', name: 'kim', plan: '일반', number: '12가3456', type: '모닝', fee: 5000, at: '2026-11-20 09:00' },
    { id: 2, email: 'kim@a.com', name: 'kim', plan: '일반', number: '12가3456', type: '모닝', fee: 5000, at: '2026-11-21 09:00' },
    { id: 3, email: 'lee@a.com', name: 'lee', plan: '골드', number: '34나5678', type: '아반떼', fee: 8000, at: '2026-11-20 13:00' },
  ];
  const MEMBERS = [
    { id: 1, email: 'kim@a.com', name: 'kim', plan: '일반' },
    { id: 2, email: 'lee@a.com', name: 'lee', plan: '골드' },
  ];
  const CARS = [
    { id: 1, number: '12가3456', type: '모닝', fee: 5000 },
    { id: 2, number: '34나5678', type: '아반떼', fee: 8000 },
  ];
  const RESERVATIONS = [
    { id: 1, member_id: 1, car_id: 1, at: '2026-11-20 09:00' },
    { id: 2, member_id: 1, car_id: 1, at: '2026-11-21 09:00' },
    { id: 3, member_id: 2, car_id: 2, at: '2026-11-20 13:00' },
  ];
  const NEW_CAR = { number: '56다7890', type: '레이', fee: 4000 };

  const COLS = {
    flat: [{ key: 'id', label: 'reservation_id' }, { key: 'member', label: 'member_email · name · plan', parts: ['email', 'name', 'plan'] },
      { key: 'car', label: 'car_number · type · fee', parts: ['number', 'type', 'fee'] }, { key: 'at', label: 'started_at' }],
    members: [{ key: 'id', label: 'id' }, { key: 'email', label: 'email' }, { key: 'name', label: 'name' }, { key: 'plan', label: 'plan' }],
    cars: [{ key: 'id', label: 'id' }, { key: 'number', label: 'number' }, { key: 'type', label: 'type' }, { key: 'fee', label: 'fee' }],
    reservations: [{ key: 'id', label: 'id' }, { key: 'member_id', label: 'member_id' }, { key: 'car_id', label: 'car_id' }, { key: 'at', label: 'started_at' }],
  };

  const ANOMALY_OPS = {
    update: { label: '(A) 등급 바꾸기' },
    insert: { label: '(B) 예약 없는 새 차 넣기' },
    delete: { label: '(C) 예약 3 지우기' },
    split: { label: '나누기·되살리기' },
  };
  const SCHEMAS = {
    flat: { label: '한 표 reservation_flat' },
    split: { label: '나눈 표 members·cars·reservations' },
  };
  // 맥에서 실제로 돌린 구성(01·02 SQL). 나머지는 모형으로만 보인다.
  const RAN = { 'update/flat': true, 'insert/flat': true, 'delete/flat': true, 'insert/split': true, 'split/split': true };

  // 표 하나를 그리는 데 필요한 것: 이름, 역할, 칼럼, 행(값과 표시)
  function table(id, title, role, cols, rows, marks) {
    const m = marks || {};
    return {
      id, title, role, cols,
      rows: rows.map((r) => {
        const mk = m[r.id] || {};
        return { key: r.id, vals: r, cls: mk.cls || '', tag: mk.tag || '', tagCls: mk.tagCls || '', hot: mk.hot || [] };
      }).concat((m.extra || [])),
    };
  }
  const splitTables = (st, marks) => [
    table('members', 'members', '회원', COLS.members, st.members, marks.members),
    table('cars', 'cars', '차', COLS.cars, st.cars, marks.cars),
    table('reservations', 'reservations', '예약', COLS.reservations, st.reservations, marks.reservations),
  ];

  function restoreRow(st, r) {
    const m = st.members.find((x) => x.id === r.member_id);
    const c = st.cars.find((x) => x.id === r.car_id);
    return { id: r.id, email: m.email, name: m.name, plan: m.plan, number: c.number, type: c.type, fee: c.fee, at: r.at };
  }
  const flatKey = (r) => [r.id, r.email, r.name, r.plan, r.number, r.type, r.fee, r.at].join('|');
  function except(a, b) { const keys = new Set(b.map(flatKey)); return a.filter((r) => !keys.has(flatKey(r))); }

  function runAnomaly(op, schema) {
    const steps = [];
    let sql;
    let result = null;
    if (schema === 'flat') {
      const flat = clone(FLAT);
      const tbl = (marks, extra) => [table('flat', 'reservation_flat', '예약 행에 회원·차를 함께', COLS.flat, flat, Object.assign({}, marks, extra ? { extra } : {}))];
      if (op === 'update') {
        sql = ["UPDATE reservation_flat SET member_plan = '골드'", ' WHERE reservation_id = 1;', 'SELECT DISTINCT member_email, member_plan FROM reservation_flat', " WHERE member_email = 'kim@a.com';"];
        flat[0].plan = '골드';
        push(steps, { note: '예약 1의 행만 찾아 member_plan을 골드로 바꾼다. 같은 kim의 예약 2는 그대로 일반이다.', line: [0, 1],
          tables: tbl({ 1: { cls: 'cur', hot: ['plan'] }, 2: { cls: 'warn', tag: '일반 그대로', tagCls: 't-warn', hot: ['plan'] } }),
          tally: [['고친 행', 1]] });
        result = [{ email: 'kim@a.com', plan: '골드' }, { email: 'kim@a.com', plan: '일반' }];
        push(steps, { note: 'kim의 등급을 물으니 두 줄이 나온다. 회원 등급이라는 사실 하나가 예약 행마다 반복돼 있어서다. 갱신 이상이다.', line: [2, 3],
          tables: tbl({ 1: { hot: ['plan'] }, 2: { cls: 'warn', hot: ['plan'] } }),
          out: { title: 'kim의 등급', cols: ['member_email', 'member_plan'], rows: result.map((r) => ({ vals: [r.email, r.plan], cls: 'warn' })) },
          tally: [['고친 행', 1], ['kim의 등급 값', 2]], warn: true });
      } else if (op === 'insert') {
        sql = ['INSERT INTO reservation_flat VALUES', "  (NULL, '', '', '', '56다7890', '레이', 4000, '2026-11-20 00:00');",
          'INSERT INTO reservation_flat (member_email, member_name, member_plan, car_number, car_type, car_fee, started_at)', "  VALUES ('', '', '', '56다7890', '레이', 4000, '2026-11-20 00:00');",
          "SELECT COUNT(*) FROM reservation_flat WHERE car_number = '56다7890';"];
        const ghost = (id, err) => ({ key: 'ghost', vals: { id, email: '', name: '', plan: '', number: NEW_CAR.number, type: NEW_CAR.type, fee: NEW_CAR.fee, at: '2026-11-20 00:00' }, cls: 'warn ghost', tag: err, tagCls: 't-warn', hot: ['id'] });
        push(steps, { note: '예약이 없으니 reservation_id를 NULL로 넣어 본다. 기본 키는 NULL일 수 없어 거부된다.', line: [0, 1],
          tables: tbl({}, [ghost(null, 'ERROR 1048')]), error: "ERROR 1048 Column 'reservation_id' cannot be null", tally: [['들어간 행', 0]], warn: true });
        push(steps, { note: 'reservation_id를 빼고 넣어도 기본값이 없어 거부된다.', line: [2, 3],
          tables: tbl({}, [ghost('(없음)', 'ERROR 1364')]), error: "ERROR 1364 Field 'reservation_id' doesn't have a default value", tally: [['들어간 행', 0]], warn: true });
        result = 0;
        push(steps, { note: '새 차 56다7890은 어디에도 없다. 행 하나가 "예약"이라 예약 없이는 차를 적을 자리가 없다. 삽입 이상이다.', line: [4],
          tables: tbl({}), out: { title: '56다7890 행 수', cols: ['COUNT(*)'], rows: [{ vals: [0], cls: 'warn' }] }, tally: [['들어간 행', 0], ['56다7890 행', 0]], warn: true });
      } else if (op === 'delete') {
        sql = ['DELETE FROM reservation_flat WHERE reservation_id = 3;', "SELECT COUNT(*) FROM reservation_flat WHERE car_number = '34나5678';"];
        push(steps, { note: '예약 3을 지운다. 34나5678의 차종·요금은 이 행에만 있었다.', line: [0],
          tables: tbl({ 3: { cls: 'dropped warn', hot: ['number', 'type', 'fee'], tag: '함께 지워짐', tagCls: 't-warn' } }), tally: [['지운 행', 1]] });
        result = 0;
        push(steps, { note: '34나5678(아반떼, 8000원)이 있다는 사실까지 사라졌다. 삭제 이상이다.', line: [1],
          tables: [table('flat', 'reservation_flat', '예약 행에 회원·차를 함께', COLS.flat, flat.filter((r) => r.id !== 3), {})],
          out: { title: '34나5678 행 수', cols: ['COUNT(*)'], rows: [{ vals: [0], cls: 'warn' }] }, tally: [['지운 행', 1], ['34나5678 행', 0]], warn: true });
      } else {
        // 나누기: 결정자마다 표를 만든다(모형).
        sql = ['-- member_email → member_name, member_plan', 'INSERT INTO members (email, name, plan) SELECT DISTINCT member_email, member_name, member_plan FROM reservation_flat;',
          '-- car_number → car_type, car_fee', 'INSERT INTO cars (number, type, fee) SELECT DISTINCT car_number, car_type, car_fee FROM reservation_flat;',
          '-- 예약에는 id와 두 외래 키, 시각만', 'INSERT INTO reservations SELECT f.reservation_id, m.id, c.id, f.started_at FROM reservation_flat f JOIN members m ON m.email = f.member_email JOIN cars c ON c.number = f.car_number;'];
        const st = { members: [], cars: [], reservations: [] };
        const flatT = (hot, cur) => table('flat', 'reservation_flat', '나누기 전', COLS.flat, flat, Object.fromEntries(flat.map((r) => [r.id, { hot, cls: cur ? 'hit' : '' }])));
        st.members = clone(MEMBERS);
        push(steps, { note: 'member_email이 같으면 이름·등급이 같다(member_email → member_name, member_plan). 이 결정자로 회원 2명을 뗀다.', line: [0, 1],
          tables: [flatT(['email', 'name', 'plan'], true), table('members', 'members', '새로 만듦', COLS.members, st.members, Object.fromEntries(st.members.map((r) => [r.id, { cls: 'new' }])))],
          tally: [['members', 2], ['cars', 0], ['reservations', 0]] });
        st.cars = clone(CARS);
        push(steps, { note: 'car_number가 같으면 차종·요금이 같다(car_number → car_type, car_fee). 차 2대를 뗀다.', line: [2, 3],
          tables: [flatT(['number', 'type', 'fee'], true), table('members', 'members', '회원', COLS.members, st.members, {}), table('cars', 'cars', '새로 만듦', COLS.cars, st.cars, Object.fromEntries(st.cars.map((r) => [r.id, { cls: 'new' }])))],
          tally: [['members', 2], ['cars', 2], ['reservations', 0]] });
        st.reservations = clone(RESERVATIONS);
        result = st;
        push(steps, { note: '예약 행에는 기본 키, 회원·차를 가리키는 외래 키, 시각만 남긴다. 등급은 members 한 곳에만 있다.', line: [4, 5],
          tables: [flatT(['id', 'at'], false)].concat(splitTables(st, { reservations: Object.fromEntries(st.reservations.map((r) => [r.id, { cls: 'new' }])) })),
          tally: [['members', 2], ['cars', 2], ['reservations', 3]] });
      }
    } else {
      const st = { members: clone(MEMBERS), cars: clone(CARS), reservations: clone(RESERVATIONS) };
      if (op === 'update') {
        sql = ["UPDATE members SET plan = '골드' WHERE email = 'kim@a.com';", 'SELECT r.id, m.plan FROM reservations r', "  JOIN members m ON m.id = r.member_id WHERE m.email = 'kim@a.com';"];
        st.members[0].plan = '골드';
        push(steps, { note: '등급은 members에 한 번만 있다. kim의 행 하나를 고친다.', line: [0], tables: splitTables(st, { members: { 1: { cls: 'cur', hot: ['plan'] } } }), tally: [['고친 행', 1]] });
        result = [{ id: 1, plan: '골드' }, { id: 2, plan: '골드' }];
        push(steps, { note: 'kim의 예약 1·2를 회원과 이어 보면 모두 골드다. 값이 갈릴 곳이 없다.', line: [1, 2],
          tables: splitTables(st, { members: { 1: { cls: 'hit', hot: ['plan'] } }, reservations: { 1: { cls: 'hit' }, 2: { cls: 'hit' } } }),
          out: { title: 'kim의 예약과 등급', cols: ['r.id', 'm.plan'], rows: result.map((r) => ({ vals: [r.id, r.plan], cls: 'new' })) },
          tally: [['고친 행', 1], ['kim의 등급 값', 1]] });
      } else if (op === 'insert') {
        sql = ['INSERT INTO cars (id, number, type, fee)', "  VALUES (3, '56다7890', '레이', 4000);", 'SELECT COUNT(*) FROM (되살리기 JOIN) t;'];
        st.cars.push(Object.assign({ id: 3 }, NEW_CAR));
        push(steps, { note: '차는 cars에 따로 있으니 예약 없이도 넣을 수 있다.', line: [0, 1], tables: splitTables(st, { cars: { 3: { cls: 'new' } } }), tally: [['들어간 행', 1]] });
        result = st.reservations.map((r) => restoreRow(st, r)).length;
        push(steps, { note: '예약은 3건 그대로라 되살리기 JOIN도 3행 그대로다. 새 차는 예약이 생기면 그때 나온다.', line: [2],
          tables: splitTables(st, { cars: { 3: { cls: 'read', tag: '예약 없음', tagCls: '' } } }),
          out: { title: '되살리기 JOIN 행 수', cols: ['COUNT(*)'], rows: [{ vals: [result], cls: 'new' }] }, tally: [['들어간 행', 1], ['되살린 행', 3]] });
      } else if (op === 'delete') {
        sql = ['DELETE FROM reservations WHERE id = 3;', "SELECT COUNT(*) FROM cars WHERE number = '34나5678';"];
        st.reservations = st.reservations.filter((r) => r.id !== 3);
        push(steps, { note: '예약 3만 지운다. 예약 행에는 차를 가리키는 car_id만 있었다.', line: [0],
          tables: splitTables(st, { reservations: { extra: [{ key: 3, vals: RESERVATIONS[2], cls: 'dropped', tag: '지움', tagCls: '', hot: [] }] } }), tally: [['지운 행', 1]] });
        result = 1;
        push(steps, { note: '34나5678은 cars에 그대로 있다.', line: [1], tables: splitTables(st, { cars: { 2: { cls: 'hit' } } }),
          out: { title: '34나5678 행 수', cols: ['COUNT(*)'], rows: [{ vals: [1], cls: 'new' }] }, tally: [['지운 행', 1], ['34나5678 행', 1]] });
      } else {
        sql = ['SELECT r.id, m.email, m.name, m.plan, c.number, c.type, c.fee, r.started_at', 'FROM reservations r', '  JOIN members m ON m.id = r.member_id', '  JOIN cars c ON c.id = r.car_id;',
          '-- 원래 행과 양쪽으로 비교', '(되살린 행) EXCEPT (원래 행);  (원래 행) EXCEPT (되살린 행);'];
        const out = [];
        for (const r of st.reservations) {
          const row = restoreRow(st, r);
          out.push(row);
          push(steps, { note: `예약 ${r.id}: member_id ${r.member_id}로 회원을, car_id ${r.car_id}로 차를 찾아 원래 한 행으로 잇는다.`, line: [0, 1, 2, 3],
            tables: splitTables(st, { reservations: { [r.id]: { cls: 'cur' } }, members: { [r.member_id]: { cls: 'hit' } }, cars: { [r.car_id]: { cls: 'hit' } } }),
            out: { title: '되살린 행', cols: COLS.flat.map((c) => c.label), flat: true, rows: out.map((x) => ({ vals: x, cls: x === row ? 'new' : '' })) },
            tally: [['되살린 행', out.length]] });
        }
        const a = except(out, FLAT).length, b = except(FLAT, out).length;
        result = { rows: out, restoredMinusOriginal: a, originalMinusRestored: b };
        push(steps, { note: `원래 3행과 양쪽으로 EXCEPT하면 ${a}행·${b}행이다. 나눠도 잃은 행도 생긴 행도 없다(무손실 분해).`, line: [4, 5],
          tables: splitTables(st, {}), out: { title: '되살린 행', cols: COLS.flat.map((c) => c.label), flat: true, rows: out.map((x) => ({ vals: x, cls: '' })) },
          tally: [['되살린 행', out.length], ['되살림 − 원래', a], ['원래 − 되살림', b]] });
      }
    }
    return { steps, sql, result, ran: !!RAN[`${op}/${schema}`] };
  }

  // ---------- 장면 2: 정규화 대 비정규화 ----------
  // 실험: 회원 10만(골드 2만), 예약 100만(회원 1은 1만 건, 회원 2~99001은 10건씩), Q1은 최근 20건.
  // 모형: 회원 5명(골드 2명), 예약 13건(회원 1은 5건, 나머지는 2건씩), Q1은 최근 3건.
  const DN_MEMBERS = [
    { id: 1, plan: '일반' }, { id: 2, plan: '일반' }, { id: 3, plan: '골드' }, { id: 4, plan: '일반' }, { id: 5, plan: '골드' },
  ];
  const DN_RES = (() => {
    const per = { 1: 5, 2: 2, 3: 2, 4: 2, 5: 2 };
    const out = [];
    let id = 1;
    for (const m of DN_MEMBERS) for (let d = 1; d <= per[m.id]; d += 1) out.push({ id: id++, member_id: m.id, day: d });
    return out;
  })();
  const Q1_LIMIT = 3;
  const DN_QUERIES = {
    q1: { label: 'Q1 회원 1의 최근 예약' },
    q2: { label: 'Q2 골드 회원 예약 수' },
    u1: { label: 'U1 회원 1(예약 많음) 등급 변경' },
    u2: { label: 'U2 회원 2(예약 2건) 등급 변경' },
  };
  const DN_DESIGNS = {
    norm: { label: '정규화(JOIN)', index: 'idx_member (member_id, started_at)', variant: 'norm' },
    denorm: { label: '비정규화(등급 복사)', index: 'idx_member (member_id, started_at)', variant: 'denorm' },
    cov: { label: '비정규화 + 새 인덱스', index: 'idx_member_cov (member_id, started_at, member_plan)', variant: 'denorm_cov' },
  };
  const DN_SQL = {
    norm: {
      q1: ['SELECT r.id, r.started_at, m.plan FROM reservations_n r', '  JOIN members m ON m.id = r.member_id', ` WHERE r.member_id = 1 ORDER BY r.started_at DESC LIMIT ${Q1_LIMIT};`],
      q2: ['SELECT COUNT(*) FROM reservations_n r', '  JOIN members m ON m.id = r.member_id', " WHERE m.plan = '골드';"],
      u: (id) => [`UPDATE members SET plan = '골드' WHERE id = ${id};`],
    },
    denorm: {
      q1: ['SELECT id, started_at, member_plan FROM reservations_d', ` WHERE member_id = 1 ORDER BY started_at DESC LIMIT ${Q1_LIMIT};`],
      q2: ["SELECT COUNT(*) FROM reservations_d WHERE member_plan = '골드';"],
      u: (id) => [`UPDATE members SET plan = '골드' WHERE id = ${id};`, `UPDATE reservations_d SET member_plan = '골드' WHERE member_id = ${id};`],
    },
  };
  // 실험 원자료의 EXPLAIN FORMAT=TREE에 나온 접근 방식(model.test.cjs가 원자료와 대조한다).
  const DN_PLAN = {
    'q1/norm': 'Covering index lookup on r using idx_member (reverse) · m은 const 1행',
    'q1/denorm': 'Index lookup on reservations_d using idx_member (reverse) · 커버링 아님',
    'q1/cov': 'Covering index lookup on reservations_d using idx_member_cov (reverse)',
    'q2/norm': 'Table scan on m → Filter 골드 → 회원마다 Covering index lookup on r using idx_member',
    'q2/denorm': 'Table scan on reservations_d (100만 행) → Filter member_plan',
    'q2/cov': 'Covering index scan on reservations_d using idx_member_cov (100만 항목) → Filter member_plan',
  };
  // 고친 행 수의 규칙: 정규화는 회원 1행, 비정규화는 회원 1행 + 그 회원의 예약 행.
  function rowsChanged(design, reservationsOfMember) { return design === 'norm' ? 1 : 1 + reservationsOfMember; }

  function runDenorm(query, design) {
    const members = clone(DN_MEMBERS);
    const res = DN_RES.map((r) => (design === 'norm' ? Object.assign({}, r) : Object.assign({ plan: members.find((m) => m.id === r.member_id).plan }, r)));
    const cov = design === 'cov';
    const idxEntries = () => res.slice().sort((a, b) => a.member_id - b.member_id || a.day - b.day || a.id - b.id)
      .map((r) => ({ key: `i${r.id}`, member_id: r.member_id, day: r.day, plan: r.plan, id: r.id }));
    const kind = design === 'norm' ? 'norm' : 'denorm';
    const u = query === 'u1' ? 1 : 2;
    const sql = query.startsWith('u') ? DN_SQL[kind].u(u) : DN_SQL[kind][query];
    const steps = [];
    const t = { idx: 0, back: 0, rowsRead: 0, changed: 0, moved: 0, membersRead: 0 };
    const out = [];

    const view = (marks) => {
      const mk = marks || {};
      const tables = [];
      tables.push({ id: 'members', title: 'members', role: '회원', cols: [{ key: 'id', label: 'id' }, { key: 'plan', label: 'plan' }],
        rows: members.map((m) => Object.assign({ key: m.id, vals: m, cls: '', tag: '', tagCls: '', hot: [] }, (mk.members || {})[m.id] || {})) });
      const rcols = [{ key: 'id', label: 'id' }, { key: 'member_id', label: 'member_id' }, { key: 'day', label: 'started_at(일)' }];
      if (design !== 'norm') rcols.push({ key: 'plan', label: 'member_plan' });
      tables.push({ id: 'res', title: design === 'norm' ? 'reservations_n' : 'reservations_d', role: '클러스터형 인덱스(행)', cols: rcols,
        rows: res.map((r) => Object.assign({ key: r.id, vals: r, cls: '', tag: '', tagCls: '', hot: [] }, (mk.res || {})[r.id] || {})).concat(mk.resExtra || []) });
      const icols = [{ key: 'member_id', label: 'member_id' }, { key: 'day', label: 'started_at' }];
      if (cov) icols.push({ key: 'plan', label: 'member_plan' });
      icols.push({ key: 'id', label: 'id(기본 키)' });
      tables.push({ id: 'idx', title: cov ? 'idx_member_cov' : 'idx_member', role: '보조 인덱스 리프', cols: icols,
        rows: (() => {
          const rows = idxEntries().map((e) => Object.assign({ key: e.key, vals: e, cls: '', tag: '', tagCls: '', hot: [] }, (mk.idx || {})[e.id] || {}));
          // 지운 옛 항목은 새 항목 바로 위에 보인다.
          for (const x of mk.idxExtra || []) rows.splice(rows.findIndex((r) => r.vals.id === x.vals.id), 0, x);
          return rows;
        })() });
      return tables;
    };
    const tally = (pairs) => pairs.filter((p) => p !== null);

    if (query === 'q1') {
      const mine = idxEntries().filter((e) => e.member_id === 1).reverse().slice(0, Q1_LIMIT);
      if (design === 'norm') {
        t.membersRead = 1;
        push(steps, { note: 'm.id = 1은 기본 키 상수 조회라 회원 1행을 먼저 읽어 둔다(const).', line: [1, 2], tables: view({ members: { 1: { cls: 'cur' } } }),
          tally: [['읽은 회원 행', 1], ['인덱스 항목', 0], ['테이블로 다시 간 행', 0], ['결과 행', 0]] });
      }
      for (const e of mine) {
        t.idx += 1;
        const row = res.find((r) => r.id === e.id);
        let marks;
        if (design === 'denorm') {
          t.back += 1;
          marks = { idx: { [e.id]: { cls: 'cur' } }, res: { [e.id]: { cls: 'warn', tag: '다시 감', tagCls: 't-warn', hot: ['plan'] } } };
        } else {
          marks = { idx: { [e.id]: { cls: 'cur', hot: cov ? ['plan'] : [] } } };
          if (design === 'norm') marks.members = { 1: { cls: 'hit' } };
        }
        out.push({ id: e.id, day: e.day, plan: design === 'norm' ? members[0].plan : row.plan });
        const why = design === 'denorm' ? 'member_plan이 인덱스에 없어 기본 키로 클러스터형 인덱스(행)에 다시 가서 읽는다.'
          : design === 'cov' ? 'member_plan까지 인덱스 리프에 있어 행으로 가지 않는다(커버링 인덱스).'
            : '쓰는 칼럼(id, member_id, started_at)이 모두 리프에 있어 행으로 가지 않고, 등급은 읽어 둔 회원 행에서 붙인다.';
        push(steps, { note: `인덱스를 회원 1의 끝에서 거꾸로 읽어 예약 ${e.id}(${e.day}일). ${why}`, line: design === 'norm' ? [0, 2] : [0, 1], tables: view(marks),
          out: { title: '결과', cols: ['id', 'started_at', 'plan'], rows: out.map((x) => ({ vals: [x.id, x.day, x.plan], cls: x.id === e.id ? 'new' : '' })) },
          tally: tally([design === 'norm' ? ['읽은 회원 행', 1] : null, ['인덱스 항목', t.idx], ['테이블로 다시 간 행', t.back], ['결과 행', out.length]]) });
      }
    } else if (query === 'q2') {
      let count = 0;
      if (design === 'norm') {
        for (const m of members) {
          t.membersRead += 1;
          const gold = m.plan === '골드';
          const hits = gold ? idxEntries().filter((e) => e.member_id === m.id) : [];
          t.idx += hits.length;
          count += hits.length;
          push(steps, { note: gold ? `회원 ${m.id}은 골드다. idx_member에서 member_id = ${m.id}인 항목 ${hits.length}개를 센다(커버링).` : `회원 ${m.id}은 ${m.plan}이라 예약을 찾지 않는다.`, line: [0, 1, 2],
            tables: view({ members: { [m.id]: { cls: gold ? 'cur' : 'read' } }, idx: Object.fromEntries(hits.map((e) => [e.id, { cls: 'hit' }])) }),
            out: { title: 'COUNT(*)', cols: ['COUNT(*)'], rows: [{ vals: [count], cls: hits.length ? 'new' : '' }] },
            tally: [['읽은 회원 행', t.membersRead], ['인덱스 항목', t.idx], ['셈', count]] });
        }
      } else {
        const list = cov ? idxEntries() : res.slice();
        for (const r of list) {
          const gold = r.plan === '골드';
          if (gold) count += 1;
          if (cov) t.idx += 1; else t.rowsRead += 1;
          const marks = cov ? { idx: { [r.id]: { cls: gold ? 'hit' : 'read', hot: ['plan'] } } } : { res: { [r.id]: { cls: gold ? 'hit' : 'read', hot: ['plan'] } } };
          push(steps, { note: `${cov ? '인덱스 항목' : '행'} 예약 ${r.id}: member_plan ${r.plan}${gold ? ' → 센다' : ''}. 등급으로 찾을 인덱스가 없어 ${cov ? '인덱스 전체를' : '테이블 전체를'} 훑는다.`, line: [0],
            tables: view(marks), out: { title: 'COUNT(*)', cols: ['COUNT(*)'], rows: [{ vals: [count], cls: gold ? 'new' : '' }] },
            tally: [[cov ? '인덱스 항목' : '읽은 행', cov ? t.idx : t.rowsRead], ['셈', count]] });
        }
      }
    } else {
      const target = members.find((m) => m.id === u);
      target.plan = '골드';
      t.changed = 1;
      const mineRes = res.filter((r) => r.member_id === u);
      push(steps, { note: `회원 ${u}의 행 하나를 기본 키로 찾아 골드로 바꾼다.`, line: [0], tables: view({ members: { [u]: { cls: 'cur', hot: ['plan'] } } }),
        tally: tally([['고친 행', 1], design === 'cov' ? ['옮긴 인덱스 항목', 0] : null]) });
      if (design !== 'norm') {
        for (const r of mineRes) {
          const oldEntry = { key: `old${r.id}`, vals: { member_id: r.member_id, day: r.day, plan: r.plan, id: r.id }, cls: 'dropped', tag: '지움', tagCls: '', hot: ['plan'] };
          r.plan = '골드';
          t.changed += 1;
          const marks = { members: { [u]: { cls: 'hit' } }, res: { [r.id]: { cls: 'cur', hot: ['plan'] } } };
          if (cov) {
            t.moved += 1;
            marks.idx = { [r.id]: { cls: 'new', tag: '새로 넣음', tagCls: 't-true', hot: ['plan'] } };
            marks.idxExtra = [oldEntry];
          }
          push(steps, { note: `복사해 둔 등급도 고친다: 예약 ${r.id}.${cov ? ' member_plan이 인덱스 키에도 있어 옛 항목을 지우고 새 항목을 넣는다.' : ' member_plan은 행에만 있어 행만 고친다.'}`, line: [1],
            tables: view(marks), tally: tally([['고친 행', t.changed], cov ? ['옮긴 인덱스 항목', t.moved] : null]) });
        }
      } else {
        push(steps, { note: `예약 ${mineRes.length}건은 member_id만 가리키므로 고칠 것이 없다. 읽을 때 JOIN으로 새 등급이 붙는다.`, line: [0],
          tables: view({ members: { [u]: { cls: 'hit' } }, res: Object.fromEntries(mineRes.map((r) => [r.id, { cls: 'read' }])) }), tally: [['고친 행', 1]] });
      }
    }
    const last = steps[steps.length - 1];
    return { steps, sql, plan: DN_PLAN[`${query}/${design}`] || null, index: DN_DESIGNS[design].index,
      result: query === 'q1' ? out : query === 'q2' ? last.out.rows[0].vals[0] : t.changed, tally: t };
  }

  // ---------- 장면 3: 외래 키 검사와 락 ----------
  const FK_MODES = {
    fk: { label: '외래 키 있음 res_fk', table: 'res_fk' },
    nofk: { label: '외래 키 없음 res_nofk', table: 'res_nofk' },
  };
  const FK_ENDS = {
    timeout: { label: 'A가 커밋하지 않음(실험)' },
    commit: { label: 'A가 커밋함(모형)' },
  };
  const lockKey = (l) => [l.object, l.type, l.mode, l.data === null ? '' : l.data, l.status].join('|');

  function runFk(mode, end) {
    const tbl = FK_MODES[mode].table;
    const fk = mode === 'fk';
    const members = [{ id: 1, name: 'kim', plan: '일반' }, { id: 2, name: 'lee', plan: '골드' }];
    const cars = [{ id: 1, number: '12가3456' }];
    const child = [];
    let locks = [];
    const steps = [];
    const sql = [`-- A`, 'BEGIN;', `INSERT INTO ${tbl} (id, member_id, car_id, started_at) VALUES (1, 1, 1, NOW());`, '-- B (A가 커밋하기 전)',
      "UPDATE members SET plan = '골드' WHERE id = 1;", '-- A', 'COMMIT;'];
    const L = (who, object, type, mode2, data, status) => ({ who, object, type, mode: mode2, data, status });
    const view = (marks) => {
      const mk = marks || {};
      const rowsOf = (list, id) => list.map((r) => Object.assign({ key: r.id, vals: r, cls: '', tag: '', tagCls: '', hot: [] }, (mk[id] || {})[r.id] || {}));
      return [
        { id: 'members', title: 'members', role: '부모', cols: [{ key: 'id', label: 'id' }, { key: 'name', label: 'name' }, { key: 'plan', label: 'plan' }], rows: rowsOf(members, 'members') },
        { id: 'cars', title: 'cars', role: '부모', cols: [{ key: 'id', label: 'id' }, { key: 'number', label: 'number' }], rows: rowsOf(cars, 'cars') },
        { id: 'child', title: tbl, role: fk ? '자식, 외래 키 member_id·car_id' : '자식, 외래 키 없음', cols: [{ key: 'id', label: 'id' }, { key: 'member_id', label: 'member_id' }, { key: 'car_id', label: 'car_id' }],
          rows: rowsOf(child, 'child') },
      ];
    };
    const snap = (note, line, marks, extra) => {
      const bState = locks.find((l) => l.who === 'B');
      push(steps, Object.assign({ note, line, tables: view(marks), locks: clone(locks),
        tally: [['A의 락', locks.filter((l) => l.who === 'A').length], ['B', extra && extra.b ? extra.b : bState ? (bState.status === 'WAITING' ? '대기' : '진행') : '시작 전']] }, extra || {}));
    };

    child.push({ id: 1, member_id: 1, car_id: 1 });
    locks.push(L('A', tbl, 'TABLE', 'IX', null, 'GRANTED'));
    snap(`A가 ${tbl}에 예약을 넣는다. 테이블에 IX(행을 고칠 뜻)를 걸고 새 행은 커밋 전이다.`, [1, 2], { child: { 1: { cls: 'new', tag: '커밋 전', tagCls: '' } } });
    if (fk) {
      locks.push(L('A', 'members', 'TABLE', 'IS', null, 'GRANTED'), L('A', 'members', 'RECORD', 'S,REC_NOT_GAP', '1', 'GRANTED'));
      snap('외래 키 검사: members의 기본 키에서 id 1을 찾고, 커밋까지 지워지지 않게 그 레코드에 S 모드 레코드 락을 건다.', [2],
        { members: { 1: { cls: 'hit', tag: 'S 락', tagCls: 't-true' } }, child: { 1: { cls: 'cur', hot: ['member_id'] } } });
      locks.push(L('A', 'cars', 'TABLE', 'IS', null, 'GRANTED'), L('A', 'cars', 'RECORD', 'S,REC_NOT_GAP', '1', 'GRANTED'));
      snap('car_id도 같다: cars id 1에 S 모드 레코드 락.', [2],
        { members: { 1: { cls: 'hit', tag: 'S 락', tagCls: 't-true' } }, cars: { 1: { cls: 'hit', tag: 'S 락', tagCls: 't-true' } }, child: { 1: { cls: 'cur', hot: ['car_id'] } } });
      locks.push(L('B', 'members', 'RECORD', 'X,REC_NOT_GAP', '1', 'WAITING'));
      snap('B가 members id 1의 plan을 바꾸려 X 모드 레코드 락을 원한다. A의 S와 함께 가질 수 없어 기다린다. 바꾸는 칼럼이 외래 키와 상관없는 plan이어도 락은 행 단위다.', [3, 4],
        { members: { 1: { cls: 'warn', tag: 'S 쥠 · X 대기', tagCls: 't-warn' } }, cars: { 1: { cls: 'hit', tag: 'S 락', tagCls: 't-true' } }, child: { 1: { cls: 'new', tag: '커밋 전', tagCls: '' } } }, { warn: true });
      if (end === 'timeout') {
        locks = locks.filter((l) => l.who !== 'B');
        snap('A가 커밋하지 않는 동안 B는 대기 한도(innodb_lock_wait_timeout, 실험은 3초)를 넘겨 ERROR 1205로 끝난다. 이 시간은 B가 기다린 길이가 아니라 한도다.', [4],
          { members: { 1: { cls: 'hit', tag: 'S 락', tagCls: 't-true' } }, cars: { 1: { cls: 'hit', tag: 'S 락', tagCls: 't-true' } }, child: { 1: { cls: 'new', tag: '커밋 전', tagCls: '' } } },
          { error: 'ERROR 1205 Lock wait timeout exceeded', b: '오류 1205', warn: true });
      } else {
        locks = locks.filter((l) => l.who !== 'A');
        child[0] = Object.assign({}, child[0]);
        snap('A가 커밋하면 A의 락이 모두 풀린다.', [5, 6], { child: { 1: { cls: '' } }, members: { 1: { cls: 'warn', tag: 'X 대기', tagCls: 't-warn' } } });
        locks = locks.map((l) => Object.assign({}, l, { status: 'GRANTED' }));
        members[0].plan = '골드';
        snap('기다리던 B가 X 락을 얻어 plan을 고친다. B가 기다린 시간은 A의 트랜잭션 길이에 달렸다.', [4],
          { members: { 1: { cls: 'cur', tag: 'X 락', tagCls: 't-true', hot: ['plan'] } } }, { b: '1행 고침' });
      }
    } else {
      locks.push(L('B', 'members', 'RECORD', 'X,REC_NOT_GAP', '1', 'GRANTED'));
      members[0].plan = '골드';
      snap('외래 키가 없으니 A는 members를 확인하지도 잠그지도 않는다. B는 기다리지 않고 X 락을 얻어 바로 고친다.', [3, 4],
        { members: { 1: { cls: 'cur', tag: 'X 락', tagCls: 't-true', hot: ['plan'] } }, child: { 1: { cls: 'new', tag: '커밋 전', tagCls: '' } } }, { b: '1행 고침' });
      locks = [];
      snap('A와 B가 커밋하면 락이 모두 풀린다. 그사이 누군가 회원 1을 지웠다면 예약은 없는 회원을 가리키는 고아 행이 된다.', [5, 6], {});
    }
    return { steps, sql, result: { bWaited: fk, members: clone(members) } };
  }

  // ---------- 장면과 구성 ----------
  const SCENES = {
    anomaly: { title: '이상과 나누기', choices: { op: ANOMALY_OPS, schema: SCHEMAS }, defaults: { op: 'update', schema: 'flat' } },
    denorm: { title: '정규화와 비정규화', choices: { query: DN_QUERIES, design: DN_DESIGNS }, defaults: { query: 'q1', design: 'norm' } },
    fk: { title: '외래 키와 락', choices: { mode: FK_MODES, end: FK_ENDS }, defaults: { mode: 'fk', end: 'timeout' } },
  };

  function normalize(scene, cfg) {
    const s = SCENES[scene];
    const out = {};
    for (const k of Object.keys(s.choices)) out[k] = cfg && Object.prototype.hasOwnProperty.call(s.choices[k], cfg[k]) ? cfg[k] : s.defaults[k];
    return out;
  }

  function simulate(scene, input) {
    const cfg = normalize(scene, input);
    if (scene === 'anomaly') return Object.assign({ scene, cfg }, runAnomaly(cfg.op, cfg.schema));
    if (scene === 'denorm') return Object.assign({ scene, cfg }, runDenorm(cfg.query, cfg.design));
    return Object.assign({ scene, cfg }, runFk(cfg.mode, cfg.end));
  }

  return { VERSION, FLAT, MEMBERS, CARS, RESERVATIONS, NEW_CAR, COLS, DN_MEMBERS, DN_RES, Q1_LIMIT, DN_QUERIES, DN_DESIGNS, DN_PLAN, FK_MODES, FK_ENDS, ANOMALY_OPS, SCHEMAS, RAN,
    SCENES, normalize, simulate, runAnomaly, runDenorm, runFk, rowsChanged, except, lockKey };
});
