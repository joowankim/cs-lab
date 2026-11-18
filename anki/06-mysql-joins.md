# 06 MySQL 조인과 SQL — 복습 카드

2026-11-16~18의 실험과 문답을 바탕으로 만든 카드 26개다. MySQL 8.4.13(InnoDB)과 PyMySQL 1.2.3을 기준으로 하고, 측정값은 2026-11-17 맥 본 측정(Docker Desktop, 버퍼 풀 128MB, 앱과 DB가 같은 맥)에서 잰 값이다. 시간은 워밍업을 뺀 세 번의 중앙값이나 최솟값~최댓값이다. 학습 확인 중에 맥에서 몇 번만 돌려 본 값은 "추가 확인"으로, 재지 않고 셈만 한 값은 "셈"으로 그 자리에 표시한다. 각 카드의 앞면·뒷면을 나중에 Anki로 옮긴다.

뒷면은 에이전트가 정리한 복습용 답이며, 사람의 독립적인 답변 기록이 아니다. 사람의 실제 예상과 답은 [실험 README의 시작 전 기록][before]과 [완료 후 학습 확인][check]에 남겼다.

우선 복습할 카드는 **06-002, 06-005, 06-008, 06-009, 06-011, 06-013, 06-019, 06-024, 06-025**이다. 학습 확인에서 다시 확인할 내용으로 남긴 것들이다. 결과 행을 먼저 따지기, NULL 비교는 UNKNOWN, NATURAL JOIN이 고르는 칼럼, 세미 조인·안티 조인의 이름, 조인 키 인덱스는 한쪽만 있어도 된다는 것, JOIN과 LIMIT을 다룬다.

공통 표(카드 06-001~06-012): `users (id INT PRIMARY KEY, name VARCHAR(10))`에 (1, kim) (2, lee) (3, park) (4, choi) (5, jung), `orders (id INT PRIMARY KEY, user_id INT NULL, item VARCHAR(10), status VARCHAR(10), KEY idx_user (user_id))`에 (1, 1, book, paid) (2, 1, cup, cancelled) (3, 2, pen, paid) (4, 3, bag, cancelled) (5, NULL, gift, paid). 카드마다 이 표를 다시 적는다.

## 조인의 종류

### 06-001

**앞면:** users (1 kim, 2 lee, 3 park, 4 choi, 5 jung)와 orders (id, user_id) = (1, 1) (2, 1) (3, 2) (4, 3) (5, NULL)를 `ON u.id = o.user_id`로 INNER, LEFT, RIGHT JOIN할 때 결과 (u.id, o.id)는 각각 무엇인가? "왼쪽 테이블"은 무엇을 가리키는가?

**뒷면:** INNER는 조인 조건이 일치하는 행만 결합해 (1,1) (1,2) (2,3) (3,4)의 4행이다. LEFT는 왼쪽(users)의 행을 짝이 없어도 모두 남기고 오른쪽 칼럼을 NULL로 채워 (4,NULL) (5,NULL)이 더해진 6행, RIGHT는 오른쪽(orders)의 행을 모두 남겨 (NULL,5)가 더해진 5행이다. 왼쪽·오른쪽은 쿼리에 쓴 위치다(`users u LEFT JOIN orders o`면 users가 왼쪽). 먼저 읽는 드라이빙 테이블은 옵티마이저가 고르는 것이라 다른 말이다.

**근거:** [문제 상황 1][problem1], [질문 1][q1], [JOIN Clause][join]

### 06-002

**앞면:** 06-001의 users·orders로 쿼리의 왼쪽은 users인데, `EXPLAIN FORMAT=TREE`에서 orders를 먼저 읽는(드라이빙 테이블인) 경우를 실험에서 두 가지 봤다. 무엇이고, 왼쪽 테이블과 드라이빙 테이블은 어떻게 다른가?

**뒷면:** (1) `users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid'`는 외부 조인이 내부 조인으로 바뀌어 orders부터 읽고 users를 기본 키로 찾았다. (2) `WHERE u.id IN (SELECT user_id FROM orders)`와 `EXISTS (…)`는 세미 조인으로 바뀌어 `Remove duplicates from input sorted on idx_user` 뒤 `Nested loop inner join`으로 orders를 먼저 읽었다. 왼쪽·오른쪽은 쿼리의 문법(어느 쪽 행을 남기나)이고, 드라이빙·드리븐은 실행 계획(어느 쪽을 먼저 읽나)이다. 내부 조인이면 옵티마이저가 순서를 자유롭게 고른다.

**근거:** [문제 상황 1][problem1], [묶음 ① 결과][batch1], [질문 1][q1]

### 06-003

**앞면:** MySQL에는 `FULL OUTER JOIN`이 없다. 06-001의 users·orders로 양쪽의 짝 없는 행을 모두 남기는 결과를 만드는 쿼리 두 가지와 결과는?

**뒷면:** 결과는 (1,1) (1,2) (2,3) (3,4) (4,NULL) (5,NULL) (NULL,5)의 7행이다. (1) `… LEFT JOIN … UNION … RIGHT JOIN …`: `UNION`이 두 결과에 함께 있는 4행을 한 번만 남긴다. (2) `… LEFT JOIN … UNION ALL … RIGHT JOIN … WHERE u.id IS NULL`: 두 번째 쿼리에서 왼쪽(users)이 NULL인 행, 곧 orders 쪽 짝 없는 행만 남겨 중복을 지우는 비교를 피한다. RIGHT JOIN에서 orders는 남기는 쪽이라 `o.id IS NULL`로 거르면 0행이다(추가 확인). 두 결과에 원래 같은 행이 있을 수 있으면 (1)은 그것까지 하나로 합친다.

**근거:** [질문 1][q1], [UNION Clause][union]

### 06-004

**앞면:** `CROSS JOIN`과 OUTER JOIN은 무엇이 다른가? 06-001의 users 5행과 orders 5행을 `CROSS JOIN`하면 몇 행이고, 언제 쓰며 무엇이 위험한가?

**뒷면:** OUTER JOIN은 조인 조건이 있고 짝 없는 행을 NULL로 채워 남긴다. CROSS JOIN은 조인 조건이 없이 한쪽의 모든 행을 다른 쪽의 모든 행과 결합한다(카테시안 곱). 5 × 5 = 25행이었다(추가 확인). 날짜 목록 × 상품 목록처럼 모든 조합이 필요할 때 쓴다. 행 수가 곱으로 커져 1만 × 1만이면 1억 행이고, MySQL에서는 `JOIN`에 ON을 빠뜨려도 CROSS JOIN이 된다.

**근거:** [질문 3][q3], [JOIN Clause][join]

### 06-005

**앞면:** users (id, name)와 orders (id, user_id, item, status)에서 `SELECT * FROM users NATURAL JOIN orders;`의 조인 조건은 무엇인가? 06-001의 데이터에서 lee(id 2)는 어떤 주문과 결합되며, 무엇이 위험한가?

**뒷면:** NATURAL JOIN은 두 테이블에서 칼럼 이름이 같은 칼럼 전부를 조건으로 쓴다. 이름이 같은 칼럼은 `id` 하나라 조건은 `users.id = orders.id`다. lee(회원 2)는 주문 2(cup, user_id 1)와 결합되는데 cup은 kim의 주문이다. 결과 5행이 회원 id와 주문 id를 짝지은 틀린 결과였다(추가 확인). 조건이 쿼리에 드러나지 않아 뜻이 다른 같은 이름 칼럼으로 조용히 틀리고, 나중에 같은 이름 칼럼(예: `created_at`)이 더해지면 조건이 소리 없이 바뀐다. 그래서 조건은 ON으로 직접 쓴다.

**근거:** [질문 3][q3], [JOIN Clause][join]

## LEFT JOIN과 조건의 자리

### 06-006

**앞면:** "회원별 결제 완료 주문" 목록에서 결제 완료 주문이 없는 회원도 빈칸으로 나와야 한다. users (1 kim, 2 lee, 3 park, 4 choi, 5 jung), orders (id, user_id, status) = (1, 1, paid) (2, 1, cancelled) (3, 2, paid) (4, 3, cancelled) (5, NULL, paid)에서 `users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid'`와 `… ON u.id = o.user_id AND o.status = 'paid'`의 결과 (u.id, o.id)는?

**뒷면:** WHERE에 두면 (1,1) (2,3)의 2행이라 park·choi·jung이 사라진다. ON에 두면 (1,1) (2,3) (3,NULL) (4,NULL) (5,NULL)의 5행이다. ON은 오른쪽의 어떤 행이 짝이 될지만 정하고, LEFT JOIN은 왼쪽 행을 짝이 없어도 남긴다(park의 주문은 cancelled뿐이라 짝이 없어 NULL). WHERE는 조인이 끝난 결과 행에 적용된다.

**근거:** [문제 상황 1][problem1], [질문 2][q2]

### 06-007

**앞면:** 06-006의 WHERE 판(`LEFT JOIN … WHERE o.status = 'paid'`)에서 choi·jung 행이 빠지는 까닭을 NULL 비교로 말하라. 옵티마이저는 이 쿼리의 계획을 어떻게 바꿨는가?

**뒷면:** choi·jung 행의 `o.status`는 NULL이고 `NULL = 'paid'`는 TRUE도 FALSE도 아닌 UNKNOWN이다. WHERE는 TRUE인 행만 남겨 빠진다. 오른쪽이 NULL인 행을 늘 버리는 조건(null-rejected 조건)이 있으면 결과가 내부 조인과 같아, 옵티마이저는 외부 조인을 내부 조인으로 바꿨다(`Nested loop inner join`, 드라이빙 orders). 내부 조인이 되면 어느 쪽을 먼저 읽을지 고를 수 있다.

**근거:** [문제 상황 1][problem1], [질문 2][q2], [Outer Join Simplification][outer-simplify]

## 세미 조인과 안티 조인

### 06-008

**앞면:** users (1 kim, 2 lee, 3 park, 4 choi, 5 jung), orders.user_id = 1, 1, 2, 3, NULL에서 "주문 있는 회원"을 `WHERE u.id IN (SELECT user_id FROM orders)`, `WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)`, `JOIN orders o ON u.id = o.user_id`로 구하면 결과 u.id는 각각? 차이는 무엇이고 이름은?

**뒷면:** IN과 EXISTS는 1, 2, 3, JOIN은 1, 1, 2, 3이다. JOIN은 조건이 일치하는 짝마다 행을 만들어 주문이 두 건인 kim이 두 번 나온다(이 목록으로 메일을 보내면 kim은 두 번 받음). IN·EXISTS는 오른쪽에 일치하는 행이 하나 이상 있는 왼쪽 행을 한 번씩만 돌려주고 오른쪽 칼럼은 돌려주지 않는다. 이것이 세미 조인(semi-join)이다. 계획에서는 `Remove duplicates from input sorted on idx_user` 뒤 `Nested loop inner join`으로 나왔다.

**근거:** [문제 상황 1-1][problem1-1], [질문 4][q4], [묶음 ① 결과][batch1], [Semijoin and Antijoin][semijoin]

### 06-009

**앞면:** 06-008의 표에서 "주문 없는 회원"을 `LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL`, `WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)`, `WHERE u.id NOT IN (SELECT user_id FROM orders)`로 구하면 결과는? 계획의 이름은?

**뒷면:** 앞의 둘은 4, 5이고 계획에 `Nested loop antijoin`으로 나왔다. 오른쪽에 일치하는 행이 하나도 없는 왼쪽 행만 돌려주는 안티 조인(anti-join)이다. `NOT IN`은 빈 결과였고, 안티 조인으로 바뀌지 않고 회원마다 서브쿼리를 따로 따지는 꼴이었다. NOT EXISTS는 "있는 것 찾기"의 EXISTS와 반대라, 결과를 셀 때 세미 조인의 답(1, 2, 3)과 섞지 않는다.

**근거:** [문제 상황 1-1][problem1-1], [질문 4][q4], [묶음 ① 결과][batch1]

### 06-010

**앞면:** orders.user_id가 1, 1, 2, 3, NULL일 때 `WHERE u.id NOT IN (SELECT user_id FROM orders)`가 choi(u.id = 4)까지 빼고 빈 결과를 돌려주는 까닭을 조건을 풀어 써서 말하라. NOT IN을 그대로 두고 고치는 법은?

**뒷면:** `4 NOT IN (1, 1, 2, 3, NULL)`은 `4 <> 1 AND 4 <> 1 AND 4 <> 2 AND 4 <> 3 AND 4 <> NULL`이다. 앞의 넷은 TRUE이고 `4 <> NULL`은 UNKNOWN이라 `TRUE AND UNKNOWN` = UNKNOWN이다. WHERE는 TRUE인 행만 남기므로, 목록에 NULL이 하나라도 있으면 어느 회원도 남지 못한다. 서브쿼리에 `WHERE user_id IS NOT NULL`을 붙이면 4, 5가 나온다.

**근거:** [문제 상황 1-1][problem1-1], [질문 4][q4]

### 06-011

**앞면:** `NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)`에서 user_id가 NULL인 주문은 `o.user_id = u.id`를 무엇으로 따지고, 회원의 결과에 영향을 주는가?

**뒷면:** `NULL = u.id`는 FALSE가 아니라 UNKNOWN이다. EXISTS 안의 WHERE도 TRUE인 행만 남기므로 그 주문은 "짝이 아님"으로 처리되고 결과에 영향을 주지 않는다. 그래서 NOT EXISTS는 `IS NOT NULL` 없이도 결과가 맞는다. NOT IN이 틀리는 까닭은 NULL이 "목록의 값"으로 들어가 비교 전체를 UNKNOWN으로 만들기 때문이고, NOT EXISTS에서는 NULL이 한 행의 조건을 UNKNOWN으로 만들 뿐이다.

**근거:** [처음 보는 문제 2][new2], [질문 4][q4]

### 06-012

**앞면:** 탈퇴한 회원의 주문을 지우지 않고 `orders.user_id`를 NULL로 바꾸기로 했다. 회원 1만 명, 주문 10만 건(5%가 NULL), `KEY idx_user (user_id)`에서 "한 번도 주문하지 않은 회원" 쿼리로 (가) `NOT IN (SELECT user_id FROM orders)` (나) `NOT IN (SELECT user_id FROM orders WHERE user_id IS NOT NULL)` (다) `NOT EXISTS (…)` 중 무엇을 고르는가?

**뒷면:** (다)다. (가)는 0행으로 틀린다. (나)는 2400행으로 맞지만 계획이 안티 조인이 아니라 서브쿼리 결과를 따로 만들어 회원마다 대 보는 꼴이라 27.6~31.0ms였고, (다)는 2400행·`Nested loop antijoin`·9.67~11.2ms였다(추가 확인, 4번). (다)는 누가 `IS NOT NULL`을 빠뜨려도 결과가 틀리지 않고 빠르다. NULL 가능 칼럼의 NOT IN이 안티 조인으로 바뀌지 않는 까닭을 칼럼 정의로 보는 것은 매뉴얼과 대조하지 않은 추측이다(기본 키를 돌려주는 NOT IN 서브쿼리는 안티 조인으로 바뀌었음).

**근거:** [처음 보는 문제 2][new2], [정리한 결론과 선택 기준][conclusion]

## 조인 방식

### 06-013

**앞면:** 중첩 루프 조인과 해시 조인은 어떻게 동작하는가? 해시 조인에서 해시 테이블을 만드는 쪽과 찾아보는 쪽의 이름은? MySQL은 언제 해시 조인을 쓰는가?

**뒷면:** 중첩 루프 조인은 이중 for 문처럼 드라이빙 테이블의 행을 하나씩 꺼내고 그 행마다 드리븐 테이블에서 짝을 찾는다(조인 키에 인덱스가 있으면 B+Tree로, 없으면 처음부터 끝까지 읽음). 해시 조인은 한쪽을 한 번 읽어 조인 키로 해시 테이블을 만들고(빌드 입력, build input), 다른 쪽을 한 번 읽으며 행마다 해시 테이블에서 찾는다(프로브 입력, probe input). 해시값이 같으면 실제 키 값도 비교한다. MySQL 8.4 매뉴얼은 조인마다 같다(=) 조건이 있고 조인 조건에 쓸 수 있는 인덱스가 없는 쿼리에 해시 조인을 쓴다고 적는다. 인덱스가 있으면 비용 추정으로 인덱스 중첩 루프를 고른다.

**근거:** [질문 5][q5], [Hash Join Optimization][hash-join], [Nested-Loop Join Algorithms][nested-loop]

### 06-014

**앞면:** `users (id PK, code INT, name)`·`orders (id PK, user_code INT, amount)` 각 1만 행, 주문마다 user_code가 같은 회원이 정확히 1명이다. `SELECT COUNT(*), SUM(o.amount) FROM users u JOIN orders o ON u.code = o.user_code;`를 (가) 조인 키에 인덱스 없이 (나) (가) + `/*+ NO_BNL(u, o) */` (다) `CREATE INDEX idx_code ON users (code)` 뒤에 돌리면 조인 방식과 시간의 크기는?

**뒷면:** (가) 해시 조인 3.70ms, (나) 중첩 루프 조인 8.52초, (다) 중첩 루프 조인(`Covering index lookup on u using idx_code`) 8.57ms였다(쿼리 그대로의 시간). `NO_BNL`은 해시 조인을 막는 힌트이고(매뉴얼: `BNL`·`NO_BNL` 힌트나 `optimizer_switch`의 `block_nested_loop`로 조절), 인덱스도 없으니 1만 × 1만 = 1억 번 비교했다. 해시 조인과 인덱스 중 하나만 있어도 몇 ms 안에 끝난다.

**근거:** [문제 상황 2][problem2], [묶음 ② 결과][batch2], [Optimizer Hints][hints]

### 06-015

**앞면:** 06-014의 (나)와 (다)는 둘 다 중첩 루프 조인인데 시간이 1000배 다르다. 계획의 드리븐 테이블 줄은 (나) `Table scan on o (rows=10000 loops=10000)`, (다) `Covering index lookup on u using idx_code (rows=1 loops=10000)`이다. 드리븐 테이블을 모두 몇 행 읽었고, 왜 1만 배가 아니라 1000배인가?

**뒷면:** (나)는 1만 × 1만 = 1억 행, (다)는 1만 × 1 = 1만 행이다. 행 수는 1만 배 차이지만 한 행의 비용이 다르다. 8.52초 ÷ 1억 ≈ 85ns는 한 페이지 안에서 다음 레코드로 넘어가는 이어 읽기, 8.57ms ÷ 1만 ≈ 857ns는 찾을 때마다 루트에서 리프까지 페이지 2~3장을 내려가며 페이지 안에서 자리를 찾는 값이다(셈). 그래서 약 10배씩 비싸 1000배가 남는다. (나)의 `Table scan`도 클러스터형 인덱스의 리프를 옆으로 읽은 것이라, 견준 것은 인덱스 종류가 아니라 "이어 읽기 대 매번 찾아 내려가기"다.

**근거:** [질문 6][q6], [묶음 ② 결과][batch2]

### 06-016

**앞면:** 06-014의 표에서 users.code에 인덱스가 있을 때 1만 행을 전부 조인하면 인덱스 중첩 루프 8.57ms, 해시 조인 3.70ms(인덱스 없는 (가))였다. 인덱스가 있으면 늘 빠른가? `WHERE o.id <= 10`으로 주문 10건만 맞추면 어떻게 되는가?

**뒷면:** 늘 빠르지는 않다. 양쪽을 다 맞출 때는 해시 조인이 메모리의 해시 테이블을 한 번씩 조회해 B+Tree를 1만 번 내려가는 것보다 빨랐다. 주문 10건만이면 인덱스 중첩 루프는 0.347ms(조회 10번), 인덱스를 끈(`NO_INDEX`) 해시 조인은 1.42ms였다. 해시 테이블은 작은 쪽(주문 10건)으로 만들어 그 비용은 작고, 큰 비용은 프로브 쪽 users 1만 행을 끝까지 읽는 데서 나온다. 드라이빙 쪽 행이 적으면 인덱스 중첩 루프, 양쪽을 다 맞추면 해시 조인이 유리하다.

**근거:** [문제 상황 2][problem2], [질문 6][q6], [묶음 ② 결과][batch2]

### 06-017

**앞면:** 06-014의 (다)(users.code 인덱스, 1만 행 전부)에서 옵티마이저는 해시 조인이 아니라 인덱스 중첩 루프를 골랐다. 계획의 추정 비용은 해시 약 1,110만, 인덱스 중첩 루프 약 1.2만이었다. 인덱스를 끄고(`/*+ NO_INDEX(u idx_code) */`) 해시 조인으로 돌리면 어땠는가? 여기서 얻는 교훈은?

**뒷면:** `EXPLAIN ANALYZE`로 해시 조인이 5.85~7.68ms, 인덱스 중첩 루프가 10.0ms였다(추가 확인 4번, 본 측정 3번). 비용 추정은 해시 조인을 실제보다 훨씬 비싸게 봤다. 인덱스가 있으면 MySQL은 해시 조인을 쓰지 않고 비용 추정으로 고르며, 그 추정은 틀릴 수 있다(05에서 `(created_at, user_id)` 인덱스를 추정 때문에 쓰지 않은 것과 같은 줄기). 옵티마이저의 선택을 믿되 중요한 쿼리는 재서 확인한다.

**근거:** [질문 5][q5], [정리한 결론과 선택 기준][conclusion]

### 06-018

**앞면:** `products (id INT PRIMARY KEY, name)` 1만 행, `reviews (id INT PRIMARY KEY, product_id INT NOT NULL, rating INT NOT NULL)` 4만 행(상품 1~8000에 5건씩, rating 1~5 고르게)이고 reviews에는 보조 인덱스가 없다. `SELECT COUNT(*) FROM products p JOIN reviews r ON r.product_id = p.id WHERE r.rating = 5;`의 조인 방식과 결과는?

**뒷면:** 결과는 8000이고 해시 조인이 아니라 중첩 루프 조인(`Nested loop inner join`)이었다(9.67~10.4ms, 추가 확인). 조인 키의 한쪽인 p.id가 기본 키라 클러스터형 인덱스가 곧 조인 키 인덱스다. 옵티마이저는 reviews를 드라이빙 테이블로 두고 `rating = 5`로 8000행만 남긴 뒤, 그 행마다 products를 `PRIMARY`로 찾았다. 조인 키 인덱스는 한쪽만 있어도 되고, 그쪽을 드리븐 테이블로 둔다.

**근거:** [처음 보는 문제 1][new1]

### 06-019

**앞면:** 06-018의 products·reviews에서 (1) `SELECT COUNT(*) FROM products p WHERE NOT EXISTS (SELECT 1 FROM reviews r WHERE r.product_id = p.id);` (2) `reviews (product_id)` 인덱스를 만든 뒤 `SELECT p.id, p.name, r.rating FROM products p LEFT JOIN reviews r ON r.product_id = p.id WHERE p.id = 9000;`의 결과와 계획은?

**뒷면:** (1)은 리뷰가 **없는** 상품(8001~10000)을 세어 2000이고 `Nested loop antijoin`이다(12.0~12.3ms, 추가 확인). 8000은 EXISTS의 답이다. (2)는 상품 9000에 리뷰가 없지만 LEFT JOIN이라 상품 행이 남아 (9000, p9000, NULL) 1행이고, 기본 키로 상품을 찾고 인덱스로 리뷰를 한 번 찾아 0.001~0.004ms였다. 결과 행을 먼저 따진다. NOT EXISTS는 "없는 것", LEFT JOIN은 "왼쪽 행은 남는다".

**근거:** [처음 보는 문제 1][new1]

### 06-020

**앞면:** `EXPLAIN ANALYZE`와 쿼리를 그대로 돌린 시간은 늘 같은가? 06-014의 (나)(인덱스 없음 + `NO_BNL`, 1억 번 비교)에서 둘은 얼마였는가?

**뒷면:** 같지 않다. `EXPLAIN ANALYZE`는 반복자(iterator)마다 시간을 재느라 행을 아주 많이 도는 쿼리에서 더 느리다. (나)는 `EXPLAIN ANALYZE` 13.2초, 쿼리 그대로 8.52초로 1.55배였다. 몇 ms짜리 쿼리에서는 차이가 작았다((가) 4.74ms 대 3.70ms). 시간을 판정할 때는 쿼리 그대로의 시간을 쓰고, `EXPLAIN ANALYZE`는 계획과 단계별 행 수를 보는 데 쓴다.

**근거:** [묶음 ② 결과][batch2], [EXPLAIN ANALYZE][explain-analyze]

## N+1 문제

### 06-021

**앞면:** users 1만 행, orders 10만 행(회원마다 10건, `KEY idx_user (user_id)`), 앱(PyMySQL)과 DB가 같은 맥이다. 회원 n명 목록을 한 번 가져오고 회원마다 `SELECT id, amount FROM orders WHERE user_id = %s`를 보내는 코드는 n = 10, 100, 1000에서 쿼리를 몇 번 보내고 시간이 얼마였는가? JOIN 한 번은?

**뒷면:** N+1은 11·101·1001번, 4.20 / 43.5 / 399ms, JOIN 한 번은 0.836 / 7.41 / 36.2ms였다(앱이 행을 다 받기까지). 쿼리 하나는 인덱스를 타서 빠르지만 횟수가 n에 비례해 늘었다. 이것이 N+1 문제다. 목록 1번 + 행마다 1번씩 n번, 모두 n + 1번 쿼리를 보낸다. ORM의 지연 로딩(lazy loading)이 흔한 원인이다.

**근거:** [문제 상황 3][problem3], [묶음 ③ 결과][batch3], [질문 7][q7]

### 06-022

**앞면:** 06-021의 n = 1000에서 N+1은 1001번·399ms, JOIN 한 번은 1번·36.2ms였고 `SELECT 1` 왕복은 0.277ms였다. 쿼리 수는 1001배인데 시간이 약 11배뿐인 까닭은? 399ms 가운데 JOIN에 없는 몫은 얼마인가?

**뒷면:** 둘 다 받는 주문 행은 1만 개로 같고, 그 행을 받아 Python 값으로 바꾸는 시간이 양쪽에 다 있다. JOIN 36.2ms 가운데 DB 안은 약 8ms(`EXPLAIN ANALYZE`), 왕복은 0.28ms이고, 나머지 약 28ms는 행을 받는 몫이다(나눠 재지 않은 추측). N+1에만 있는 몫은 399 − 36 = 363ms이고 그중 약 277ms(0.277 × 1000)가 왕복 1000번, 약 86ms가 쿼리 1000번을 더 해석·실행하고 받는 몫이다(셈). N+1의 비용은 "쿼리가 느려서"가 아니라 "횟수 × (왕복 + 쿼리 하나의 고정 비용)"이다.

**근거:** [첫 해석][first], [질문 7][q7]

### 06-023

**앞면:** 06-021과 같은 일을 앱과 DB가 다른 서버라 왕복이 1ms인 환경에서 하면, n = 1000의 N+1과 JOIN 한 번은 대략 얼마가 되는가? DB 안의 일은 그대로라고 본다.

**뒷면:** N+1은 1001 × 1ms + 약 120ms(DB 안의 일과 행 받기) ≈ 1.1초, JOIN은 36ms + 1ms ≈ 37ms다(셈, 재지 않음). 왕복이 길수록 N+1의 손해가 커진다. 실제 네트워크에서는 JOIN이 받는 1만 행의 전송 시간이 더해질 수 있다(재지 않은 추측).

**근거:** [첫 해석][first]

### 06-024

**앞면:** 회원 n명과 그 주문(없으면 NULL)을 한 번에 가져오려고 `SELECT u.id, u.name, o.id, o.amount FROM users u LEFT JOIN orders o ON u.id = o.user_id LIMIT 1000;`을 썼다. 회원마다 주문이 10건일 때 회원은 몇 명 나오는가? `GROUP BY u.id`를 붙이면? 바르게 쓰면?

**뒷면:** `LIMIT`은 조인한 뒤의 결과 행을 세어 1000행, 곧 회원 100명만 나온다. `GROUP BY u.id`를 붙이면 회원 하나에 o.id가 10개라 무엇을 보일지 정할 수 없어 오류 1055(only_full_group_by)다. 결과는 (회원, 주문) 짝마다 한 행이라 GROUP BY가 필요 없고(묶기는 앱이 함), 회원을 먼저 고른다: `SELECT … FROM (SELECT id, name FROM users ORDER BY id LIMIT 1000) u LEFT JOIN orders o ON o.user_id = u.id;`(파생 테이블, derived table). 1000명·1만 행이 나왔다.

**근거:** [문제 상황 3][problem3], [GROUP BY Handling][group-by]

### 06-025

**앞면:** 최근 주문 50건과 주문마다 회원 이름·상품들(평균 3개)을 한 번에 가져오려고 `… FROM orders o JOIN users u ON o.user_id = u.id JOIN order_items oi ON o.id = oi.order_id ORDER BY o.created_at DESC LIMIT 50;`을 썼다. 주문은 몇 건 나오는가? 바르게 고치면? 왕복 1ms일 때 지연 로딩(주문 1번 + 주문마다 회원 1번 + 주문마다 상품 1번)과 견주면?

**뒷면:** 결과가 상품 하나에 한 행이라 `LIMIT 50`은 상품 50행을 세어 주문은 약 17건이다. 주문 50건을 파생 테이블로 먼저 고르고(`FROM (SELECT id, user_id, created_at FROM orders ORDER BY created_at DESC LIMIT 50) o`) 그다음 조인한다. 파생 테이블 안의 `ORDER BY`는 바깥 순서를 보장하지 않아 바깥에도 `ORDER BY o.created_at DESC`를 붙이고, 상품이 없는 주문도 보이려면 order_items는 `LEFT JOIN`이다. 지연 로딩은 1 + 50 + 50 = 101번 × 약 1.1ms ≈ 111ms, 고친 판은 한 번에 결과 약 150행으로 몇 ms다(셈, 재지 않음). IN으로 두세 번에 묶는 것도 해법이다.

**근거:** [처음 보는 문제 3][new3]

### 06-026

**앞면:** MySQL에서 `WHERE o.user_id IN (SELECT id FROM users ORDER BY id LIMIT 1000)`은 왜 돌지 않고, 어떻게 고치는가? N+1을 IN으로 묶는 다른 꼴(쿼리 두 번)은?

**뒷면:** MySQL은 IN 서브쿼리 안의 `LIMIT`을 지원하지 않아 오류 1235("doesn't yet support 'LIMIT & IN/ALL/ANY/SOME subquery'")다. 파생 테이블로 한 번 감싸면 돈다: `IN (SELECT id FROM (SELECT id FROM users ORDER BY id LIMIT 1000) x)`(n = 1000에서 30.2ms). 두 번 꼴은 첫 쿼리로 회원 id를 받은 뒤 `SELECT id, user_id, amount FROM orders WHERE user_id IN (1, 2, …, 1000)`을 보내는 것으로, ORM의 즉시 로딩(eager loading)이 흔히 쓴다(32.0ms).

**근거:** [문제 상황 3][problem3], [묶음 ③ 결과][batch3], [Restrictions on Subqueries][subquery-restrictions]

[before]: ../experiments/06-mysql-joins/README.md#시작-전-기록
[check]: ../experiments/06-mysql-joins/README.md#완료-후-학습-확인
[problem1]: ../experiments/06-mysql-joins/README.md#문제-상황-1-사라진-회원들-2026-11-16
[problem1-1]: ../experiments/06-mysql-joins/README.md#문제-상황-1-1-주문이-없는-회원-주문이-있는-회원-2026-11-16
[problem2]: ../experiments/06-mysql-joins/README.md#문제-상황-2-회원-코드로-주문-맞춰-보기-1만--1만-2026-11-16
[problem3]: ../experiments/06-mysql-joins/README.md#문제-상황-3-회원-목록-화면과-n1-2026-11-17
[batch1]: ../experiments/06-mysql-joins/README.md#묶음--결과-행과-계획
[batch2]: ../experiments/06-mysql-joins/README.md#묶음--1만--1만-조인-조건마다-3회
[batch3]: ../experiments/06-mysql-joins/README.md#묶음--회원-n명과-주문-조건마다-3회
[first]: ../experiments/06-mysql-joins/README.md#첫-해석
[q1]: ../experiments/06-mysql-joins/README.md#질문-1-조인의-종류와-full-outer-join
[q2]: ../experiments/06-mysql-joins/README.md#질문-2-left-join을-쓸-때와-where의-오른쪽-조건
[q3]: ../experiments/06-mysql-joins/README.md#질문-3-cross-join과-natural-join
[q4]: ../experiments/06-mysql-joins/README.md#질문-4-in-exists-join과-세미-조인안티-조인-not-in
[q5]: ../experiments/06-mysql-joins/README.md#질문-5-조인-방식과-옵티마이저의-선택
[q6]: ../experiments/06-mysql-joins/README.md#질문-6-조인-키-인덱스가-중요한-까닭과-늘-빠른지
[q7]: ../experiments/06-mysql-joins/README.md#질문-7-n1-문제와-고치는-법
[new1]: ../experiments/06-mysql-joins/README.md#처음-보는-문제-1-목표-1-상품과-리뷰
[new2]: ../experiments/06-mysql-joins/README.md#처음-보는-문제-2-목표-3-탈퇴-회원과-주문-없는-회원
[new3]: ../experiments/06-mysql-joins/README.md#처음-보는-문제-3-목표-3-최근-주문-50건-화면의-n1
[conclusion]: ../experiments/06-mysql-joins/README.md#정리한-결론과-선택-기준
[join]: https://dev.mysql.com/doc/refman/8.4/en/join.html
[union]: https://dev.mysql.com/doc/refman/8.4/en/union.html
[outer-simplify]: https://dev.mysql.com/doc/refman/8.4/en/outer-join-simplification.html
[semijoin]: https://dev.mysql.com/doc/refman/8.4/en/semijoins-antijoins.html
[hash-join]: https://dev.mysql.com/doc/refman/8.4/en/hash-joins.html
[nested-loop]: https://dev.mysql.com/doc/refman/8.4/en/nested-loop-joins.html
[hints]: https://dev.mysql.com/doc/refman/8.4/en/optimizer-hints.html
[explain-analyze]: https://dev.mysql.com/doc/refman/8.4/en/explain.html
[group-by]: https://dev.mysql.com/doc/refman/8.4/en/group-by-handling.html
[subquery-restrictions]: https://dev.mysql.com/doc/refman/8.4/en/subquery-restrictions.html
