# 06 MySQL 조인과 SQL

작은 표 두 개로 INNER·LEFT JOIN의 결과와 "없는 것 찾기"·"있는 것 찾기" 쿼리(세미 조인, 안티 조인)를 비교하고, 1만 × 1만 조인을 조인 키 인덱스와 옵티마이저 힌트에 따라 중첩 루프 조인과 해시 조인으로 돌려 걸린 시간을 잰다. 회원 목록과 회원별 주문을 N+1, JOIN 한 번, IN으로 묶기로 가져오며 쿼리 횟수와 걸린 시간을 잰다. MySQL에서만 한다. 공통 규칙은 [작업 지침](../../AGENTS.md)을 따른다.

2026-11-16에 목표와 범위를 정하고 묶음 ①②의 예상을 받았고, 2026-11-17에 묶음 ③의 예상을 받은 뒤 맥에서 본 측정을 했다. 진행 중 피드백에 쓴 값은 맥의 같은 MySQL에서 한 번 돌린 임시 확인값이고, 판정은 [결과 정리](#결과-정리)의 본 측정값으로 했다. 완료 후 학습 확인은 아직 하지 않았다.

## 목표

실험을 마치면 다음을 할 수 있어야 한다.

1. **예측:** 두 테이블과 인덱스, 조인 쿼리를 보고 결과 행(어떤 행이 남고 어떤 칼럼이 NULL이 되는지)과 `EXPLAIN FORMAT=TREE`에 나올 조인 방식·드라이빙 테이블, 걸린 시간의 크기를 실행 전에 맞힌다.
2. **설명:** 조인 방식(중첩 루프 조인, 해시 조인)을 읽은 행 수와 비교 횟수로, 조인 키 인덱스가 왜 중요한지를 B+Tree로, N+1 문제의 비용을 쿼리 횟수와 왕복 시간으로 설명한다.
3. **고르기:** INNER와 LEFT JOIN, "없는 것 찾기"(LEFT JOIN … IS NULL, NOT EXISTS, NOT IN), "있는 것 찾기"(IN 서브쿼리, EXISTS, JOIN), N+1을 고치는 방법(JOIN, IN으로 묶기)을 결과의 정확성과 직접 잰 숫자로 고른다.

확인 방법은 03~05와 같다. 측정 전에 적은 예상을 실측과 대조해 맞힌 수를 센다. 완료 후에는 아래 질문에 해설 없이 답하고, 직접 잰 숫자를 넣어 답한 수와 "왜?"에 두 번까지 답한 수를 센다. 목표값은 두지 않고 03(예상 31/63, 숫자를 넣어 혼자 답한 질문 1/9)·04(40/57, 3/8)·05(24/50, 2/11)와 나란히 기록한다. 05처럼 질문마다 답하기 전에 맞힐 것 같은지를 한 줄로 먼저 말한다.

### 확인할 질문

1. 조인의 종류(INNER, LEFT, RIGHT, FULL OUTER)는 무엇이 다르고, MySQL에는 없는 FULL OUTER JOIN은 어떻게 만드는가.
2. LEFT JOIN은 언제 쓰고, 오른쪽 테이블의 조건을 WHERE에 두면 어떻게 되는가.
3. CROSS JOIN과 NATURAL JOIN은 언제 쓰고 무엇이 위험한가.
4. IN 서브쿼리, EXISTS, JOIN은 무엇이 다르고, 세미 조인과 안티 조인은 무엇인가. NOT IN은 언제 틀리는가.
5. 조인 방식(중첩 루프 조인, 해시 조인)은 어떻게 동작하고, 옵티마이저는 언제 무엇을 고르는가.
6. 조인 키에 인덱스가 왜 중요한가. 인덱스가 있으면 늘 빠른가.
7. N+1 문제는 무엇이고 어떻게 고치는가.

SQL 작성 연습(GROUP BY·HAVING, 서브쿼리, 윈도 함수)은 이 실험에서 묻지 않고 LeetCode SQL 50으로 따로 한다.

## 다룰 범위

| 묶음 | 볼 것 |
|---|---|
| ① | 회원 5명·주문 5건(user_id에 NULL 한 건)의 작은 표에서 INNER·LEFT JOIN, 오른쪽 테이블 조건을 ON에 둘 때와 WHERE에 둘 때, "주문 없는 회원"과 "주문 있는 회원"을 쿼리 셋씩으로 쓴 결과 행과 트리 형식 계획 |
| ② | 각 1만 행의 회원·주문을 회원 코드로 맞춰 보는 조인을 조인 키 인덱스 없음, 없음 + `NO_BNL` 힌트, 회원 코드 인덱스 있음에서. 주문 10건만 맞춰 볼 때 인덱스 중첩 루프와 해시 조인 |
| ③ | 회원 1만 명·주문 10만 건(회원마다 10건)에서 회원 N명(10, 100, 1000)과 그 주문을 N+1, JOIN 한 번, IN 두 번, IN 서브쿼리 한 번으로 가져오며 쿼리 횟수와 앱이 행을 다 받기까지의 시간, `SELECT 1` 왕복 시간 |

①~③을 MySQL에서만 하고, 계획에 선택으로 있던 서버 쪽 커서(클라이언트 메모리)는 실험 9(메모리)와 겹쳐 뺐다. ①의 "없는 것 찾기"·"있는 것 찾기" 쿼리와 ③의 N+1 고친 판은 사람이 쓰고, ③에서 왕복 시간을 인위로 늘리지 않고 잰 왕복 시간으로 셈만 한다(2026-11-16 사람이 고른 범위).

## 시작 전 기록

아래는 측정 전의 예상과 그 뒤의 문답이다. 사람의 답은 원문 그대로 옮겼다(메시지의 줄 바꿈은 " / "로 적음). 에이전트 피드백에 적은 값은 맥에서 한 번 돌린 임시 확인값이고, 본 측정값과 판정은 [결과 정리](#결과-정리)에 있다. 옵티마이저가 내놓은 숫자는 추정, 에이전트가 확인하지 못한 설명은 추측으로 적는다.

### 지난 실험의 변형 문제 (2026-11-16)

- 문제(에이전트): 05의 orders 표(100만 행, 시간 순서대로 들어감, 고객 1은 5만 건)에 보조 인덱스는 `idx_user (user_id)` 하나뿐이고 인덱스를 더 만들 수 없다. `SELECT * FROM orders WHERE user_id = 1 ORDER BY created_at DESC LIMIT 20;`에 `Using filesort`가 뜬다. (1) 같은 20개를 정렬 없이 가져오는 쿼리 (2) 정렬이 필요 없는 이유를 `idx_user` 리프의 내용과 순서로.
- 사람의 답(원문): "1. 맞힐 것 같아. / `SELECT * FROM orders WHERE user_id = 1 ORDER_BY id LIMIT 20;` / 2. 맞힐 것 같아. / idx_user 인덱스는 (user_id, id) 순으로 리프에 인덱스 행을 저장하기 때문에 특정한 created_at 범위가 아니라면 정렬된 id로도 행의 추가 순서를 알 수 있기 때문에 created_at대신 id를 사용해도 최신순 조회라는 같은 목표를 달성할 수 있어."
- 에이전트 피드백: 2는 맞다. 05에서 두 번 놓친 "보조 인덱스 항목 끝의 기본 키"를 혼자 썼다. 1은 정렬 기준을 id로 바꾼 것은 맞으나 방향(`DESC`)이 빠졌다(`ORDER_BY`는 오타로 봄). 맥에서 `idx_user`만 둔 표 사본으로 `ORDER BY created_at DESC`는 `Using filesort`·5만 행·71ms, `ORDER BY id DESC`는 `Backward index scan`·20행·0.047ms였고 돌려준 id는 같았다.
- 이어서 낸 물음과 답: 오름차순이면 어떤 20개이고, 최신 20개가 되게 고치면 리프의 어디서 시작해 어느 쪽으로 읽는가. 사람(원문): "아 가장 오래된 20행을 반환해. 리프의 가장 앞에서 시작해서 id 기준 오름차순으로 20행 읽고 멈춰." 오름차순 쪽은 맞다(고객 1이 가장 작은 user_id라 그 첫 항목이 리프 맨 앞). 고친 판은 에이전트가 알렸다: user_id = 1의 마지막 항목에서 시작해 뒤로 20개 읽고 멈춘다.
- 셈: 처음 답 1/2, 이어서 낸 물음 1/2. 실험 6의 예상 적중에는 넣지 않았다.

### 문제 상황 1: 사라진 회원들 (2026-11-16)

- 장면: "회원별 결제 완료 주문" 목록에 결제 완료 주문이 없는 회원도 빈칸으로 나와야 하는데 회원 5명 중 일부만 보인다.
- 표와 데이터: `users (id INT PRIMARY KEY, name VARCHAR(10))`에 (1, kim) (2, lee) (3, park) (4, choi) (5, jung), `orders (id INT PRIMARY KEY, user_id INT NULL, item VARCHAR(10), status VARCHAR(10), KEY idx_user (user_id))`에 (1, 1, book, paid) (2, 1, cup, cancelled) (3, 2, pen, paid) (4, 3, bag, cancelled) (5, NULL, gift, paid).
- 쿼리(`SELECT u.id, u.name, o.id, o.status FROM users u ...`): (가) `JOIN orders o ON u.id = o.user_id` (나) `LEFT JOIN orders o ON u.id = o.user_id` (다) (나) + `WHERE o.status = 'paid'` (라) `LEFT JOIN orders o ON u.id = o.user_id AND o.status = 'paid'`. 경우마다 결과 행과, 문의의 원인 쿼리와 까닭.
- 사람의 예상(원문): "맞힐 것 같아. / (가) 4행: (1, 1), (1, 2), (2, 3), (3, 4) / inner 조인으로 양 쪽 테이블에 서로 맵핑된 것만 조인됨 / (나) 6행: (1, 1), (1, 2), (2, 3), (3, 4), (4, NULL), (5, NULL) / left 조인으로 모든 left 테이블 행이 포함되며 right 테이블과 맵핑되지 않는 행은 null이 포함되어 결과가 반환됨 / (다) 2행: (1, 1), (2, 3) / ON u.id = o.user_id로 (나)와 같이 5행이었으나 WHERE o.status = 'paid' 조건으로 인해 'paid' 상태가 아닌 행은 제외됨 / (라) 5행: (1, 1), (2, 3), (3, NULL), (4, NULL), (5, NULL) / ON u.id = o.user_id AND o.status = 'paid' 조건에 해당하는 left 테이블의 행만 right 테이블의 데이터와 맵핑되고 나머지는 NULL과 맵핑됨."
- 에이전트 피드백: 넷 다 맞다((다) 설명의 "5행"은 6행의 착오로 봄). 원인은 (다), 고친 판은 (라)다. (다)의 `EXPLAIN FORMAT=TREE`는 `Nested loop inner join`이고 드라이빙 테이블이 orders였다. 쿼리의 LEFT JOIN이 계획에서 내부 조인으로 바뀐 까닭을 물었다.
- 사람의 답(원문): "반반 / WHERE 조건 절이 포함되어서 o.id가 NULL인 행은 어차피 배제될 것이기 때문에 쿼리 결과가 inner join과 다르지 않다고 판단했을거라 생각해. / 두 행은 o.status가 NULL이었어. 그 이유는 u.id가 o.user_id와 맵핑된 데이터가 없었기 때문이야. 그래서 o.status = 'paid'를 따지면 둘다 결과에서 배제되었어." 맞다. 에이전트는 표준 용어를 보탰다. NULL과의 비교는 참·거짓이 아니라 UNKNOWN이고 WHERE는 TRUE인 행만 남긴다. 오른쪽이 NULL인 행을 늘 버리는 조건(null-rejected 조건)이 있으면 옵티마이저는 외부 조인을 내부 조인으로 바꾸고(MySQL 매뉴얼 "Outer Join Simplification", 원문은 대조하지 않음), 내부 조인이 되면 어느 테이블을 먼저 읽을지 고를 수 있다.
- 예상 적중: 4/4.

### 문제 상황 1-1: 주문이 없는 회원, 주문이 있는 회원 (2026-11-16)

- 장면: 상태와 상관없이 주문이 한 건도 없는 회원에게는 쿠폰을, 한 건이라도 있는 회원에게는 감사 메일을 보낸다. 목록이 틀리면 쿠폰이 엉뚱한 사람에게 가거나 같은 사람에게 메일이 두 번 간다. 표와 데이터는 문제 상황 1과 같다.
- 물은 것: `SELECT u.id FROM users u ...` 꼴로 "주문 없는 회원"을 (A) `LEFT JOIN … IS NULL` (B) `NOT EXISTS` (C) `NOT IN`, "주문 있는 회원"을 (D) `IN` 서브쿼리 (E) `EXISTS` (F) `JOIN`으로 직접 쓰고, 쿼리마다 돌려줄 u.id.
- 사람이 쓴 쿼리(원문): "반반 / (A) `SELECT u.id FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id is NULL;` (B) `SELECT u.id FROM users u NOT EXISTS (SELECT o.user_id FROM orders o);` (C) `SELECT u.id FROM users u NOT IN (SELECT o.user_id FROM orders o);` (D) `SELECT u.id FROM users u IN (SELECT o.user_id FROM orders o);` (E) `SELECT u.id FROM users u EXISTS (SELECT o.user_id FROM orders o);` (F) `SELECT u.id FROM users u JOIN orders o ON u.id = o.user_id;`"
- 에이전트 도움(확인할 지점): (A)(F)는 맞다. (B)~(E)는 `WHERE`가 없어 오류 1064였다. `IN`·`EXISTS`는 WHERE 뒤에 오고, `IN`은 "무엇이" 목록에 있는지를 따지며, (B)(E)의 서브쿼리는 지금 보는 회원과 이어져 있지 않다고 짚었다.
- 사람의 답 2(원문): "예습 퀴즈가 진짜 하나도 도움 안되는데? 거기서는 쿼리 직접 작성하는건 없었잖아. / 작성하라고 해도 못했겠지만, 상관 서브쿼리 용어까지는 기억이 났는데, 그 뜻은 생각이 나진 않네. / (B) `SELECT u.id FROM users u WHERE u.id NOT EXISTS (SELECT u.id FROM users u JOIN orders o ON u.id = o.user_id AND o.status = 'paid');` (C) `SELECT u.id FROM users u WHERE u.id NOT IN (SELECT u.id FROM users u JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid');` (D) `SELECT u.id FROM users u WHERE u.id IN (SELECT u.id FROM users u JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid');` (E) `SELECT u.id FROM users u WHERE u.id EXISTS (SELECT u.id FROM users u JOIN orders ON u.id = o.user_id AND o.status = 'paid');` / * 주문 없는 회원: 3, 4, 5 * 주문 있는 회원: 1, 2"
- 에이전트 도움(예제와 설명): (C)(D)는 문법이 맞고 쓴 대로 3, 4, 5와 1, 2가 나오지만, 물음에 없던 `o.status = 'paid'`를 넣어 "결제 완료 주문" 기준이 됐다. 상관 서브쿼리(바깥 쿼리의 칼럼을 안에서 써서 바깥 행마다 다시 따짐)와 `EXISTS` 꼴(앞에 칼럼을 쓰지 않음)을 예로 보이고, 여섯 쿼리를 바른 꼴로 적어 준 뒤 결과만 물었다. 바른 꼴은 [`python/join_cases.py`](python/join_cases.py)의 `RESULT_QUERIES`다.
- 사람의 예상(원문): "(A) 4, 5 (B) 4, 5 (C) 4, 5 (D) 1, 2, 3 (E) 1, 2, 3 (F) 1, 2, 3 / 모두 답일 것 같아."
- 에이전트 피드백: (C)는 빈 결과, (F)는 1, 1, 2, 3이었다. (F)는 조인이 짝마다 한 행을 만들어 kim이 두 번 나오고, (D)(E)는 짝이 하나라도 있는지만 봐 회원을 한 번만 돌려준다(세미 조인). (C)는 `NOT IN (1, 1, 2, 3, NULL)`이 `u.id <> 1 AND … AND u.id <> NULL`과 같다고 보이고 choi(4)에서 무엇이 되는지 물었다. 사람은 "'이 조건'이 뭐야?", "'<>' 이건 무슨 연산자야?"라고 물었고, 에이전트는 (C)의 WHERE 조건을 그대로 다시 적고 `<>`가 "같지 않다"(`!=`와 같음)라고 설명했다.
- 사람의 답 3(원문): "4와 숫자를 비교한건 다 True이기 때문에 `TRUE AND 4 <> NULL`과 같은 연산이 될테니까 결과는 FALSE 아니면 UNKNOWN이라고 생각해. 조건문 결과가 TRUE인 경우만 반환하기 때문에 choi는 배제됐다고 생각해." 맞다. 정확히는 `4 <> NULL`이 UNKNOWN이고 `TRUE AND UNKNOWN`도 UNKNOWN이다. 서브쿼리 목록에 NULL이 하나라도 있으면 `NOT IN`은 어떤 행에도 TRUE가 되지 못한다. 고치려면 `NOT EXISTS`를 쓰거나 서브쿼리에 `WHERE user_id IS NOT NULL`을 붙인다.
- 예상 적중: 4/6. 쿼리는 (A)(F)를 처음부터 맞게 썼고, (C)(D)는 고친 판의 문법이 맞았으며(조건 하나를 더함), (B)(E)는 설명을 들은 뒤 에이전트 판으로 줄였다.

### 문제 상황 2: 회원 코드로 주문 맞춰 보기, 1만 × 1만 (2026-11-16)

- 표와 데이터: `users (id INT PRIMARY KEY, code INT NOT NULL, name VARCHAR(20) NOT NULL)`, `orders (id INT PRIMARY KEY, user_code INT NOT NULL, amount INT NOT NULL)` 각 1만 행. code는 회원마다 다르고 주문마다 user_code가 같은 회원이 정확히 1명 있다.
- 쿼리: `SELECT COUNT(*), SUM(o.amount) FROM users u JOIN orders o ON u.code = o.user_code;`
- 경우: (가) 조인 키에 인덱스 없음 (나) (가) + `/*+ NO_BNL(u, o) */` (다) `CREATE INDEX idx_code ON users (code);`. 경우마다 조인 방식과 `EXPLAIN ANALYZE` 시간의 크기(1ms 안쪽 / 1~10ms / 10~100ms / 100ms~1초 / 1~10초 / 10초 이상), 가장 빠를 것과 이유.
- 사람의 질문(원문): "중첩 루프 조인과 해시 조인이 뭐야? 용어만 생각나고 뜻은 생각 안 나" 에이전트는 3행 예와 Python 의사코드로 설명했다. 중첩 루프 조인은 이중 for 문이고 드리븐 테이블에서 짝을 찾을 때 인덱스가 없으면 처음부터 끝까지, 있으면 B+Tree로 찾는다. 해시 조인은 한쪽으로 dict를 만들고(빌드) 다른 쪽을 한 번 읽으며 찾는다(프로브). MySQL 8.0.18부터 해시 조인이 있고 `NO_BNL`이 이를 막는다. 어느 쪽이 빠른지는 말하지 않았다.
- 사람의 예상(원문): "못 맞힐 것 같음. / (가) 해시 조인 / 1~10ms / 해시 조인을 사용해서 시간 복잡도가 O(N)이 되어 2만 회만 순회하면 작업을 완료할 수 있어서 1억 회 순회가 1초라는 기준하에 해당 조인은 제시한 시간 정도가 걸릴것이라 어림함 / (나) 중첩 루프 조인 / 1~10s / 인덱스 없이 중첩 루프 조인을 실행해서 시간 복잡도가 O(N^2)인 작업을 수행하기 때문에 1억 회 순회로 1초 정도 걸릴 것이라 생각함. / (다) 중첩 루프 조인 / 1~10ms / 인덱스가 존재해서 users.code를 찾는 시간 복잡도가 O(1)이 되어서 전체적인 시간복잡도는 O(N)으로 (가)와 같은 것이라 생각함."
- 에이전트 피드백: 조인 방식은 셋 다 맞다. 임시 확인의 `EXPLAIN ANALYZE`는 (가) 4.55ms, (나) 12.7초, (다) 10.2ms였다(본 측정에서 쿼리 그대로의 시간으로 판정을 다시 함). 인덱스로 찾는 것은 O(1)이 아니라 루트에서 리프까지 내려가는 O(log N)이다. (다)가 인덱스가 있는데도 (가)보다 느린 까닭을 물었다.
- 사람의 답 2(원문): "(다)는 시간 복잡도가 O(NlogN)이고 (가)는 시간 복잡도가 O(N)이다. 그 이유는 (다)는 주문 한 건의 짝을 찾을 때 B+Tree에 저장된 인덱스를 탐색하기에 주문 한 건당 O(logN)의 시간복잡도를 가지고 (가)는 해시테이블을 사용하기에 시간 복잡도 O(1)을 가지기 때문이다." 맞다. 에이전트는 여기서 log N이 실제로는 페이지 2~3층이라 차이는 상수배이고, 해시 조인은 대신 두 테이블을 끝까지 한 번씩 읽어야 한다고 보탰다.
- 이어서 낸 물음과 답: 주문 10건만 맞춰 보면(`WHERE o.id <= 10`) 무엇이 빠른가. 사람(원문): "인덱스있는 중첩 루프 조인이 더 빨라. 그 이유는 중첩 루프 조인은 조건에 맞는 10건에 대한 인덱스 탐색만 수행하지만 해시 조인은 해시테이블을 만들기 위해 전체 행을 순회하기 때문이야." 맞다. MySQL은 작은 쪽(주문 10건)으로 해시 테이블을 만들고, 끝까지 읽는 것은 프로브 쪽 users 1만 행이다.
- 예상 적중: 6/6(맥 본 측정의 쿼리 그대로 시간 기준, [결과 정리](#결과-정리)).

### 문제 상황 3: 회원 목록 화면과 N+1 (2026-11-17)

- 장면: 회원 목록과 회원별 주문을 함께 보여 주는 화면이 한 페이지 10명일 때는 괜찮았는데 1000명으로 늘리자 느려졌다. 쿼리 하나하나는 인덱스를 타서 빠르다.
- 표와 데이터: `users (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL)` 1만 행, `orders (id INT PRIMARY KEY, user_id INT NOT NULL, amount INT NOT NULL, KEY idx_user (user_id))` 10만 행(회원마다 10건). 앱(Python, PyMySQL)과 DB(Docker MySQL)는 같은 맥.
- 지금 코드: 회원 n명 목록을 한 번 가져오고(`SELECT id, name FROM users ORDER BY id LIMIT %s`), 회원마다 `SELECT id, amount FROM orders WHERE user_id = %s`를 보낸다.
- 물은 것(n = 1000): 지금 코드의 쿼리 횟수와 시간, 쿼리 한 번(JOIN)이나 두 번(IN)으로 고친 판(주문이 없는 회원도 나와야 함), 고친 판의 쿼리 횟수와 시간.
- 사람의 예상(원문): "1. 맞힐 것 같아. / 1001 번의 쿼리를 보내. 1쿼리 처리에 1ms라고 가정하면 1001ms가 걸려서 약 1s일거라 생각해. / 1쿼리 처리에 1ms라는 짧은 시간을 예상한 이유는 orders에는 user_id 인덱스가 있기 때문에 빠르게 해당 user_id를 포함하는 행들을 빠르게 찾을 수 있을거라 생각했기 때문이야. users는 클러스터링 인덱스로 정렬이 따로 필요없을거기 때문에 짧은 처리시간을 가질거라 생각했어. / 2. 못 맞힐 것 같아. / `SELECT u.id, u.name, o.id, o.amount FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id LIMIT 1000;` / 3. 반반 / 쿼리는 한 번 보낼거야. 구체적으로는 잘 모르겠지만 1번의 경우보다는 훨씬 작은 10ms 정도 걸릴거라고 생각해."
- 에이전트 피드백: 시간을 값으로 적어 05처럼 "실제의 10분의 1~10배 안이면 맞음"으로 셌다. 쓴 쿼리는 오류 1055(only_full_group_by: o.id가 GROUP BY에 없음)였고, GROUP BY를 빼도 `LIMIT 1000`이 조인 결과 행에 걸려 회원 100명만 나왔다.
- 사람의 답 2(원문): "`SELECT u.id, u.name, o.id, o.amount FROM users u LEFT JOIN orders o ON u.id = o.user_id LIMIT 1000;` / 잘 모르겠네. group by가 필요할 것 같긴한데, 결과 스키마를 모르겠어서 SELECT 문의 projection을 어떻게 써야할지 모르겠어. 내 생각으로는 FROM 절에서 users와 orders가 left join을 실행한 뒤에 거기서 user id 기준으로 limit을 걸어야할 거 같은데 쿼리는 어떤 형태로 써야할지 모르겠어."
- 에이전트 도움(예제와 설명): 결과는 (회원, 주문) 짝마다 한 행이라 GROUP BY가 없고 묶기는 앱이 한다. 회원 1000명을 FROM 절 안의 파생 테이블로 먼저 고른 뒤 LEFT JOIN하는 판을 보였다. 이어서 IN 두 번 판의 두 번째 쿼리를 물었다.
- 사람의 답 3(원문): "`SELECT o.id, o.user_id, o.amount FROM orders o WHERE o.user_id IN (SELECT id FROM users ORDER BY id LIMIT 1000);`" 뜻(회원 1000명의 주문을 한 쿼리로)은 맞으나 MySQL은 IN 서브쿼리 안의 LIMIT을 지원하지 않아 오류 1235였다. 파생 테이블로 한 번 감싸면 돌아간다. 에이전트는 물음이 뜻한 꼴(앱이 받은 id를 `IN (1, 2, …, 1000)`으로)을 보였다. 본 측정에는 사람의 판을 에이전트가 감싼 것을 "IN 서브쿼리 한 번"으로 넣었다.
- 예상 적중: 4/4(쿼리 횟수 둘, 시간 둘).

### 예상 적중

| 묶음 | 문제 상황 | 맞힌 예상 / 적은 예상 |
|---|---|---|
| ① | 1 사라진 회원들 | 4/4 |
| ① | 1-1 주문이 없는/있는 회원 | 4/6 |
| ② | 2 1만 × 1만 조인 | 6/6 |
| ③ | 3 N+1 | 4/4 |
| | 합 | 18/20 |

03의 31/63(49%), 04의 40/57(70%), 05의 24/50(48%)과 견주면 90%다. 다만 이번에는 결과 행이 데이터로 정해지는 칸이 많았고, 쿼리를 직접 쓰는 칸은 세지 않았다. 직접 쓴 쿼리는 1-1의 (A)(F)와 고친 (C)(D)가 맞았고, 1-1 (B)(E)와 3의 JOIN·IN은 도움을 받아 완성했다.

## 측정 규칙

| 항목 | 규칙 |
|---|---|
| 표와 데이터 | [`python/join_cases.py`](python/join_cases.py)가 만든다. 실행할 때마다 `lab6` 데이터베이스(05의 `lab`과 따로)에 표를 지우고 새로 넣는다. ②의 code·user_code는 100000~109999의 순열(n × 7919, n × 104729를 10000으로 나눈 나머지), ③의 주문 user_id는 1 + (n × 7919) % 10000이라 회원마다 정확히 10건이다. 버퍼 풀은 기본 128MB이고 표가 모두 들어간다. |
| ① 결과 | 쿼리마다 결과 행을 손으로 센 기대값과 순서 없이 견주고 `EXPLAIN FORMAT=TREE`를 남긴다. |
| ② 조인 | 경우마다 `idx_code`를 만들거나 지우고 `ANALYZE TABLE`을 한 뒤, `EXPLAIN ANALYZE`를 한 번 돌려 맨 위 반복자의 실제 시간과 계획의 조인 방식을 읽고, 쿼리 그대로를 한 번 돌려 클라이언트에서 잰 응답 시간과 결과(COUNT, SUM)를 남긴다. |
| ③ N+1 | 같은 연결에서 방법마다 앱이 모든 행을 받기까지(`fetchall` 포함)의 경과 시간, 보낸 쿼리 수, 받은 회원 수와 주문 수를 남긴다. 반복을 마칠 때마다 `SELECT 1`을 1000번 보내 왕복 시간의 중앙값을 남긴다. |
| 제대로 돈 실행 | ①은 결과 행이 기대와 같을 때, ②는 COUNT·SUM이 기대(1만 행이면 10000, 4,995,000, 10건이면 10, 55)와 같고 `EXPLAIN ANALYZE`의 시간을 읽었을 때, ③은 쿼리 수(N+1은 1 + n, JOIN·IN 서브쿼리 1, IN 두 번 2)와 회원 n명, 주문 10n건일 때다. |
| 반복 | 워밍업 1회(`run: 0`)와 본 측정 3회를 ①②③ 순서로 돌고, 반복마다 묶음 안 조건의 순서를 한 칸씩 돌린다. |

## 실행 방법

DB는 저장소 루트의 [`infra/compose.yaml`](../../infra/compose.yaml)로 띄운다(03~05와 같음). MySQL은 `127.0.0.1:13306`에서 받는다.

| 파일 | 역할 |
|---|---|
| [join_cases.py](python/join_cases.py) | 표와 데이터, ①의 쿼리와 기대 결과, ②의 경우, ③의 방법. 사람이 쓴 쿼리는 쓴 문장 그대로 두고 `author`에 밝힘 |
| [join_lab.py](python/join_lab.py) | 측정. 표 만들기와 넣기, 인덱스 바꾸기, 결과 대조, 시간·쿼리 수 기록, 환경·원자료 저장과 요약 |
| [test_join_lab.py](python/test_join_lab.py) | DB 없이 `EXPLAIN ANALYZE` 읽기, 데이터의 순열·회원별 주문 수, 조건 이름, 순서 돌리기를 검사 |
| [lab_env.py](../../tools/lab_env.py) | 측정 환경 기록(공용 코드) |

이 실험 폴더에서 실행한다.

```sh
cd experiments/06-mysql-joins
uv run --python 3.14.2+gil python -m unittest discover -s python -p 'test_*.py' -v
uv run --python 3.14.2+gil python/join_lab.py --smoke
uv run --python 3.14.2+gil python/join_lab.py
```

`--smoke`는 워밍업 1회와 검증 2회만, ②는 `NO_BNL` 경우를 빼고 ③은 n = 10만으로 돌려 `results/validation/`에 저장하며, 가설 판단에 쓰지 않는다. `--parts`(results, algo, n1), `--trials`, `--mysql`, `--password`, `--output-dir`을 받는다. 본 실행은 맥에서 약 2분 걸리고 대부분이 ② `NO_BNL` 경우다. 의존성(PyMySQL 1.2.3)은 스크립트 머리의 PEP 723 블록과 [`join_lab.py.lock`](python/join_lab.py.lock)에 고정했다.

결과는 측정 한 번을 JSON 한 줄로 남긴다. 공통 필드에 더해 `part`(results, algo, n1), `variant`는 쿼리·경우·방법의 이름, `situation`·`label`(문제 상황과 그 안의 이름), `author`, `sql`, `size`는 ①②에서 표의 행 수, ③에서 회원 수 n, `wall_s`는 클라이언트에서 잰 경과 시간이다. ①은 `result`·`expected`·`tree`, ②는 `analyze`(`first_ms`, `last_ms`, `rows`, `join_kinds`)와 `analyze_text`, ③은 `queries`를 더 쓴다. `check`·`expected_check`는 ① 결과 행 수, ② (COUNT, SUM), ③ (쿼리 수, 회원 수, 주문 수)이고 `valid`는 둘이 같은지(①은 행까지 같은지)다.

## 결과 정리

### 측정 환경과 원자료 (2026-11-17)

Apple M2 Pro(성능 코어 8개·효율 코어 4개), macOS 26.5의 Docker Desktop에 MySQL 8.4.13(이미지 `linux/arm64/v8`, ID `a0225d1ea663`, 버퍼 풀 128MB, `join_buffer_size` 256KB)을 띄우고 2026-11-17 16:42(KST)에 돌렸다. Python은 uv 0.12.5가 고른 CPython 3.14.2 일반 빌드(GIL 켜짐)로 03~05와 같다. 맥에서 직접 도는 에이전트 세션이 실행했다. 전원은 연결된 상태였고 배터리는 80%(충전 안 함)였다. 평일 낮이라 다른 앱의 부하는 통제하지 않았다. 코드는 커밋 `efd6142` 위의 커밋하지 않은 상태였다.

| 실행 | 조건 × 반복 | 환경 | 원자료 |
|---|---|---|---|
| `join_lab.py` | ① 12 + ② 5 + ③ 12와 왕복 1 × (워밍업 1 + 3) | [환경](results/2026-11-17T164211743263-join-env.txt) | [JSONL](results/2026-11-17T164211743263-join-python-3.14.2.jsonl) |

본 실행의 기록 120줄과 `--smoke`의 63줄(`results/validation/`)은 모두 검증을 통과했다. 아래 시간은 워밍업을 뺀 세 번의 중앙값과 [최솟값~최댓값]이다.

### 묶음 ①: 결과 행과 계획

| 쿼리 | 결과 | 계획의 조인 |
|---|---|---|
| 1 (가) JOIN | (1,1) (1,2) (2,3) (3,4) | `Nested loop inner join` |
| 1 (나) LEFT JOIN | (가) + (4,NULL) (5,NULL) | `Nested loop left join` |
| 1 (다) LEFT JOIN + WHERE o.status = 'paid' | (1,1) (2,3) | `Nested loop inner join` (외부 조인이 내부 조인으로 바뀜) |
| 1 (라) LEFT JOIN + ON … AND o.status = 'paid' | (1,1) (2,3) (3,NULL) (4,NULL) (5,NULL) | `Nested loop left join` |
| 1-1 (A) LEFT JOIN … IS NULL (사람) | 4, 5 | `Nested loop antijoin` |
| 1-1 (B) NOT EXISTS | 4, 5 | `Nested loop antijoin` |
| 1-1 (C) NOT IN (orders.user_id) | 없음 | 안티 조인으로 바뀌지 않고 회원마다 서브쿼리(`dependent`) |
| 1-1 (C) 사람 판 NOT IN (결제 완료 회원의 u.id) | 3, 4, 5 | `Nested loop antijoin` |
| 1-1 (D) IN | 1, 2, 3 | `Remove duplicates from input sorted on idx_user` 뒤 `Nested loop inner join` (세미 조인) |
| 1-1 (D) 사람 판 IN (결제 완료) | 1, 2 | `Nested loop inner join` |
| 1-1 (E) EXISTS | 1, 2, 3 | (D)와 같음 |
| 1-1 (F) JOIN (사람) | 1, 1, 2, 3 | `Nested loop inner join` |

12개 모두 손으로 센 결과와 같았고 응답 시간은 모두 0.28~1.2ms(왕복 0.277ms가 대부분)였다. 사람이 쓴 (C) 판은 서브쿼리의 칼럼이 기본 키(NULL이 될 수 없음)라 안티 조인으로 바뀌었고, orders.user_id(NULL 가능)를 쓴 (C)는 바뀌지 않았다.

### 묶음 ②: 1만 × 1만 조인 (조건마다 3회)

| 경우 | 조인 방식 | 쿼리 그대로 (ms) | `EXPLAIN ANALYZE` (ms) | 예상 | 판정 |
|---|---|---|---|---|---|
| (가) 인덱스 없음 | `Inner hash join` | 3.70 [3.61~3.90] | 4.74 [4.70~4.77] | 해시 조인, 1~10ms | 맞음, 맞음 |
| (나) 인덱스 없음 + `NO_BNL` | `Nested loop inner join` | 8,519 [8,513~8,530] | 13,237 [13,209~13,239] | 중첩 루프, 1~10초 | 맞음, 맞음 |
| (다) `idx_code` | `Nested loop inner join` (`Covering index lookup … using idx_code`, 1만 번) | 8.57 [7.88~10.05] | 10.0 [9.67~10.3] | 중첩 루프, 1~10ms | 맞음, 맞음 |
| 주문 10건, `idx_code` | `Nested loop inner join` | 0.347 [0.319~0.641] | 0.019 [0.018~0.025] | 인덱스 쪽이 빠름 | 맞음(세지 않음) |
| 주문 10건, `NO_INDEX`로 해시 | `Inner hash join` | 1.42 [1.42~1.43] | 1.54 [1.37~1.83] | | |

시간은 쿼리 그대로의 응답 시간으로 판정했다. (나)에서 `EXPLAIN ANALYZE`는 반복자마다 시간을 재느라 쿼리 그대로보다 1.55배 느렸다. 진행 중 피드백에 쓴 임시 값(12.7초, 10.2ms)은 `EXPLAIN ANALYZE` 값이었다.

### 묶음 ③: 회원 n명과 주문 (조건마다 3회)

앱이 행을 다 받기까지의 시간(ms)이다. `SELECT 1` 왕복은 중앙값 0.277ms(1000번)였다.

| 방법 | 쿼리 수 (n=1000) | n=10 | n=100 | n=1000 |
|---|---|---|---|---|
| (가) N+1 | 1001 | 4.20 [4.20~5.27] | 43.5 [39.3~47.1] | 399 [361~410] |
| (나) JOIN 한 번 | 1 | 0.84 [0.73~4.13] | 7.41 [7.00~8.24] | 36.2 [34.9~41.2] |
| (다) IN 두 번 | 2 | 2.67 [1.13~3.15] | 7.92 [7.22~8.63] | 32.0 [31.6~34.2] |
| (라) IN 서브쿼리 한 번 (사람 판, 감쌈) | 1 | 1.50 [1.30~1.58] | 3.66 [3.52~3.94] | 30.2 [27.8~30.7] |

예상(n = 1000): N+1 1001번·약 1초, 고친 판 1번·약 10ms. 실제 399ms와 36.2ms로 둘 다 10배 안이라 맞음이다.

### 측정하며 본 것

- n = 1000의 JOIN은 `EXPLAIN ANALYZE`로 서버 안 약 8ms인데 앱까지는 36ms였다. 1만 행을 받아 Python 값으로 바꾸는 몫이 크다(나눠 재지는 않음).
- n = 100의 JOIN(7.41ms)이 IN 서브쿼리(3.66ms)와 사전 확인(3.7ms)보다 느린 까닭은 확인하지 못했다. 계획은 n = 1000과 같은 모양(파생 테이블을 만들고 `idx_user`로 회원마다 찾기)이다.
- n = 10에서는 방법 사이 차이가 1~4ms이고 최댓값이 튀는 경우가 있어(JOIN 4.13ms) 순위를 말하기 어렵다.

## 첫 해석

사람의 해석(원문, 2026-11-17, N+1의 399ms를 왕복으로 나누고 왕복이 1ms일 때를 셈): "1. 왕복 시간은 이미 0.277ms로 너가 말한거 아니야? SELECT 1 쿼리는 처리시간도 0에 가까울거잖아. / 전체 처리 시간 중에 얼마를 말하는건가? 그럼 0.277 * 1001이니까 300ms정도가 왕복에 걸린시간일거라 생각해. / 2. N+1은 왕복시간이 약 4배 늘었으니 300*3ms만큼 추가로 왕복 시간에 소요될거라 1.3초 정도 걸릴거라 생각해. / JOIN은 왕복시간 0.277ms * 3만큼 추가되어서 37.1ms 정도로 거의 변화가 없을거라 생각해."

에이전트 피드백: 맞다. 0.277 × 1001 = 277ms로 399ms의 약 70%가 왕복이고, 남은 약 120ms가 DB 안의 일과 Python에서 행을 받는 몫이다. 왕복이 1ms면 N+1은 약 1.1초, JOIN은 약 37ms다(셈이며 재지 않음). 실제 네트워크에서는 JOIN이 받는 1만 행의 전송 시간이 더해질 수 있다(추측). 처음 물음이 모호해 사람이 "질문을 이해 못했어. N+1과 JOIN 한 번이 각각 대략 얼마가 된다는게 무슨 의미야?"라고 물었고, 에이전트가 둘로 나눠 다시 물었다.

②의 해석(인덱스 중첩 루프와 해시 조인의 차이, 드라이빙 쪽이 적을 때)은 [문제 상황 2](#문제-상황-2-회원-코드로-주문-맞춰-보기-1만--1만-2026-11-16)의 문답에 있다.

## 남은 일

- 완료 후 학습 확인(확인할 질문 7개, 질문마다 맞힐 것 같은지 한 줄, "왜?" 두 번), 정리한 결론과 선택 기준, 학습 확인 요약.
- 학습 확인에서 다시 볼 것: 상관 서브쿼리와 `EXISTS` 꼴을 직접 쓰기, `NOT IN`과 NULL, JOIN이 짝마다 행을 만드는 것, 파생 테이블로 LIMIT을 먼저 거는 것, `ORDER BY`의 방향, 인덱스로 찾는 것이 O(log N)이라는 것, `EXPLAIN ANALYZE`와 쿼리 그대로의 시간 차이.
