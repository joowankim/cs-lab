// 조인 관계도의 장면별 글: 질문, 볼 것, 실험에서 잰 값, 근거, 복습 카드.
// 실험에서 잰 값은 experiments/06-mysql-joins/README.md의 결과 정리에서 옮겼다(model.test.cjs가 원자료와 대조한다).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JoinContent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const README = 'https://github.com/joowankim/cs-lab/blob/main/experiments/06-mysql-joins/README.md';
  const ANKI = 'https://github.com/joowankim/cs-lab/blob/main/anki/06-mysql-joins.md';
  const r = (anchor, text) => ({ href: `${README}#${anchor}`, text });
  const card = (id) => ({ href: `${ANKI}#${id}`, text: id });

  const SCENES = {
    left: {
      questions: [
        'LEFT JOIN에 WHERE o.status = \'paid\'를 붙이면 choi·jung 행은 어떻게 되고, 왜 그런가?',
        '같은 조건을 ON으로 옮기면 결과는 몇 행이고, park은 어떻게 나오는가?',
        'MySQL에 없는 FULL OUTER JOIN은 어떻게 만드는가?',
      ],
      observe: [
        '짝을 찾는 기준은 ON이다. LEFT JOIN은 왼쪽 행을 짝이 없어도 남기고 오른쪽 칼럼을 NULL로 채운다.',
        'WHERE는 조인이 끝난 결과 행에 적용된다. NULL과의 비교는 UNKNOWN이고 WHERE는 TRUE만 남긴다.',
        '(다)는 결과가 내부 조인과 같아, 실제 계획은 Nested loop inner join이고 orders를 먼저 읽었다. 관계도는 계획이 아니라 쿼리의 뜻대로 회원부터 따진다.',
      ],
      measured: [
        '(가) JOIN 4행, (나) LEFT JOIN 6행, (다) LEFT JOIN + WHERE 2행, (라) LEFT JOIN + ON 5행 (맥 본 측정, 결과 행이 손으로 센 값과 같음)',
        '(다)의 EXPLAIN FORMAT=TREE: Nested loop inner join (외부 조인이 내부 조인으로 바뀜)',
        'FULL OUTER: LEFT UNION RIGHT 7행 (학습 확인 중 추가 확인)',
      ],
      evidence: [r('문제-상황-1-사라진-회원들-2026-11-16', '문제 상황 1'), r('질문-1-조인의-종류와-full-outer-join', '질문 1'), r('질문-2-left-join을-쓸-때와-where의-오른쪽-조건', '질문 2'), r('묶음--결과-행과-계획', '묶음 ① 결과 (실측 기록)')],
      cards: ['06-001', '06-002', '06-003', '06-006', '06-007'].map(card),
    },
    semi: {
      questions: [
        '"주문 있는 회원"을 IN·EXISTS로 구할 때와 JOIN으로 구할 때 kim은 몇 번 나오는가?',
        'orders.user_id에 NULL이 있을 때 NOT IN과 NOT EXISTS의 결과는 어떻게 다른가?',
      ],
      observe: [
        'JOIN은 짝마다 한 행, IN·EXISTS(세미 조인)는 짝이 하나라도 있는 왼쪽 행을 한 번.',
        'EXISTS·NOT EXISTS는 짝을 하나 찾으면 그 회원에 대해 멈춘다. NULL인 주문은 UNKNOWN이라 짝이 아니다.',
        'NOT IN은 목록의 값마다 <>를 AND로 묶는다. 목록에 NULL이 있으면 어느 회원도 TRUE가 되지 못한다.',
      ],
      measured: [
        '(D) IN 1, 2, 3 · (E) EXISTS 1, 2, 3 · (F) JOIN 1, 1, 2, 3 (맥 본 측정)',
        '(A) LEFT JOIN … IS NULL 4, 5 · (B) NOT EXISTS 4, 5 · (C) NOT IN 결과 없음 (맥 본 측정)',
        '회원 1만·주문 10만(5% NULL): 고친 NOT IN 2400행 27.6~31.0ms, NOT EXISTS 2400행 9.67~11.2ms (학습 확인 중 추가 확인, 4번)',
      ],
      evidence: [r('문제-상황-1-1-주문이-없는-회원-주문이-있는-회원-2026-11-16', '문제 상황 1-1'), r('질문-4-in-exists-join과-세미-조인안티-조인-not-in', '질문 4'), r('처음-보는-문제-2-목표-3-탈퇴-회원과-주문-없는-회원', '처음 보는 문제 2'), r('묶음--결과-행과-계획', '묶음 ① 결과 (실측 기록)')],
      cards: ['06-008', '06-009', '06-010', '06-011', '06-012'].map(card),
    },
    algo: {
      questions: [
        '조인 키에 인덱스가 없을 때 MySQL은 어떤 조인 방식을 쓰고, 해시 조인을 막으면 비교를 몇 번 하는가?',
        '인덱스가 있으면 늘 해시 조인보다 빠른가? 주문을 조금만 맞출 때는?',
      ],
      observe: [
        '중첩 루프는 드라이빙 행마다 드리븐 테이블에서 짝을 찾는다. 인덱스가 없으면 끝까지 읽고, 있으면 B+트리를 내려가 한 항목만 읽는다.',
        '해시 조인은 작은 쪽으로 해시 테이블을 만들고(빌드) 다른 쪽을 한 번 읽으며 찾는다(프로브). 프로브 쪽은 끝까지 읽는다.',
        '"주문 2건만"으로 바꾸면 인덱스 중첩 루프는 2번만 찾고, 해시 조인은 여전히 users를 끝까지 읽는다.',
      ],
      measured: [
        '각 1만 행: (가) 해시 조인 3.70ms · (나) NO_BNL 중첩 루프 8.52초 · (다) idx_code 중첩 루프 8.57ms (쿼리 그대로, 중앙값)',
        '주문 10건: 인덱스 중첩 루프 0.347ms · 해시 조인 1.42ms',
        '(나)의 드리븐 줄: Table scan on o rows=10000 loops=10000 → 1억 행 · (다): Covering index lookup on u using idx_code rows=1 loops=10000 → 1만 행',
        '(나)의 EXPLAIN ANALYZE는 13.2초로 쿼리 그대로보다 1.55배 느렸다',
      ],
      evidence: [r('문제-상황-2-회원-코드로-주문-맞춰-보기-1만--1만-2026-11-16', '문제 상황 2'), r('질문-5-조인-방식과-옵티마이저의-선택', '질문 5'), r('질문-6-조인-키-인덱스가-중요한-까닭과-늘-빠른지', '질문 6'), r('묶음--1만--1만-조인-조건마다-3회', '묶음 ② 결과 (실측 기록)')],
      cards: ['06-013', '06-014', '06-015', '06-016', '06-017', '06-018', '06-020'].map(card),
    },
    n1: {
      questions: [
        '회원 n명과 그 주문을 가져올 때 N+1은 쿼리를 몇 번 보내는가?',
        '왕복이 0.277ms에서 1ms로 늘면 N+1과 JOIN 한 번은 각각 얼마나 늘어나는가?',
      ],
      observe: [
        '쿼리 하나는 인덱스를 타서 빠르다. N+1의 비용은 횟수 × (왕복 + 쿼리 하나의 고정 비용)이다.',
        '받는 주문 행 수는 세 방법이 같다. 다른 것은 쿼리 수와 왕복 수다.',
        '"왕복 합"은 쿼리 수 × 왕복 시간으로 셈한 값이고, DB 안의 일과 행을 받는 시간은 넣지 않았다.',
      ],
      measured: [
        'n = 10 / 100 / 1000: N+1 4.20 / 43.5 / 399ms (11 / 101 / 1001번)',
        'JOIN 한 번 0.836 / 7.41 / 36.2ms · IN 두 번 2.67 / 7.92 / 32.0ms · IN 서브쿼리 한 번 1.50 / 3.66 / 30.2ms',
        'SELECT 1 왕복 0.277ms(1000번 중앙값). n = 1000에서 N+1의 399ms 중 왕복 약 277ms(셈)',
      ],
      evidence: [r('문제-상황-3-회원-목록-화면과-n1-2026-11-17', '문제 상황 3'), r('묶음--회원-n명과-주문-조건마다-3회', '묶음 ③ 결과 (실측 기록)'), r('첫-해석', '첫 해석'), r('질문-7-n1-문제와-고치는-법', '질문 7')],
      cards: ['06-021', '06-022', '06-023', '06-024', '06-025', '06-026'].map(card),
    },
  };
  return { README, ANKI, SCENES };
});
