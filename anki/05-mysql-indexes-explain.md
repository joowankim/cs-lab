# 05 MySQL 인덱스와 실행 계획 — 복습 카드

2026-11-09~14의 실험과 문답을 바탕으로 만든 카드 32개다. MySQL 8.4.13(InnoDB)과 PyMySQL 1.2.3을 기준으로 하고, 측정값은 2026-11-12 맥 본 측정(Docker Desktop, 버퍼 풀 1GB에 표 전체가 올라간 상태)에서 잰 값이다. 시간은 워밍업을 뺀 세 번의 최솟값~최댓값이다. 클라우드 컨테이너에서만 본 값은 "컨테이너 확인"으로, 재지 않고 셈만 한 값은 "셈"으로 그 자리에 표시한다. 각 카드의 앞면·뒷면을 나중에 Anki로 옮긴다.

뒷면은 에이전트가 정리한 복습용 답이며, 사람의 독립적인 답변 기록이 아니다. 사람의 실제 예상과 답은 [실험 README의 시작 전 기록][before]과 [완료 후 학습 확인][check]에 남겼다.

우선 복습할 카드는 **05-004, 05-007, 05-010, 05-014, 05-016, 05-017, 05-018, 05-020, 05-021, 05-023, 05-031, 05-032**이다. 학습 확인에서 다시 확인할 내용으로 남긴 것들이다. 리프 한 장의 행 수와 행 크기, 보조 인덱스에서 클러스터형 인덱스로 가는 페이지 수, 칼럼 순서와 정렬 생략을 WHERE가 아니라 칼럼의 역할과 `ORDER BY`로 정하기, 칼럼의 값을 바꾸면 인덱스를 못 쓰는 경우, `Using index`가 커버링이라는 것과 rows가 추정이라는 것, 커서 경계, 인덱스가 정하는 락 범위와 순서표에서 락을 보유한 세션 따지기를 다룬다.

## B+Tree 구조와 층 수

### 05-001

**앞면:** 100만 행 `orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, amount INT NOT NULL, created_at DATETIME NOT NULL, …)`에서 고객 4242의 주문은 5건이다(id 51,510·172,436·338,024·553,396·788,746). `SELECT created_at, amount FROM orders WHERE user_id = 4242 AND created_at >= '2026-08-10';`를 (가) 보조 인덱스 없이 (나) `idx_user (user_id)`로 돌린다. (가)는 5건을 찾은 뒤에도 왜 끝까지 읽고, (나)는 어떻게 첫 항목에 닿고 어디서 멈추는가?

**뒷면:** InnoDB 표는 클러스터형 인덱스(`PRIMARY`)이고 리프에 행이 id 순으로 놓인다. 4242의 5건은 id가 흩어져 있어 (가)는 리프를 처음부터 끝까지 읽어야 다 찾았는지 안다(`ALL`, `rnd_next` 1,000,001, 논리적 읽기 7,473, 143~154ms). `idx_user`는 (user_id, id) 순으로 항목이 놓인 B+Tree라, (나)는 루트에서 키를 비교하며 층마다 한 장씩 3장을 내려가 첫 4242 항목에 닿고, 옆 항목을 읽다 user_id가 4243 이상인 항목을 만나면 멈춘다(`ref`, key 1 · next 5, 논리적 읽기 30, 0.006~0.008ms). 인덱스가 빠른 것은 정렬된 순서 덕에 시작 자리를 찾고 끝을 알기 때문이다. created_at 조건은 `idx_user`에 그 칼럼이 없어 행을 읽은 뒤 서버가 걸렀다(`Using where`).

**근거:** [문제 상황 1][problem1], [질문 1][q1], [묶음 ① 결과][batch1]

### 05-002

**앞면:** InnoDB B+Tree의 루트·중간 페이지와 리프 페이지에는 각각 무엇이 있고, 리프끼리는 어떻게 이어져 있는가? 100만 행 orders의 `idx_user (user_id)`(리프 1,078장, 항목 100만 개)로 `user_id = 1`(5만 건)의 항목을 모두 읽을 때 루트로 몇 번 돌아가고 리프는 몇 장쯤 읽는가?

**뒷면:** 페이지(16KB) 하나가 노드 하나다. 루트·중간 페이지의 항목은 키, 자식 페이지 번호(4B), 레코드 머리(5B)뿐이고 행 데이터가 없다. 리프는 키 순서의 항목을 담고, 페이지 머리에 앞뒤 리프의 페이지 번호(`FIL_PAGE_PREV`, `FIL_PAGE_NEXT`)가 있어 같은 층의 리프가 앞뒤로 이어진다. 그래서 범위를 읽을 때는 루트에서 한 번 내려가 첫 항목에 닿은 뒤 리프만 옆으로 읽고, 루트로 돌아가지 않는다. 리프 한 장에 약 928항목(100만 ÷ 1,078)이라 5만 항목은 리프 약 54장이다(셈). `idx_user`만 읽는 `SELECT COUNT(*) FROM orders WHERE user_id = 1`의 논리적 읽기는 77이었다(컨테이너 확인. 내려가는 3장과 리프 54장의 합보다 20쯤 많고, 그 나머지는 확인하지 않음). 거꾸로 읽기(`Backward index scan`)도 이 연결로 한다.

**근거:** [질문 1][q1], [질문 2][q2], [문제 상황 1-1][problem1-1], [The Physical Structure of an InnoDB Index][physical]

### 05-003

**앞면:** 페이지 16KB에서 항목을 담는 공간이 약 15,360B, 리프 항목(행 전체)이 약 100B, 루트·중간 항목(키 id 8B + 자식 페이지 번호 4B + 레코드 머리 5B)이 약 17B다. 100만 행과 1억 행의 클러스터형 인덱스는 루트에서 리프까지 몇 층인가? 리프부터 위로 세어 답하라.

**뒷면:** 리프 한 장에 약 150행(실측 158.7행)이라 100만 행은 리프 약 6,666장(실측 6,303장)이다. 중간 페이지 한 장은 자식을 약 900개(15,360 ÷ 17, 꽉 찬 중간 페이지는 928개) 가리킨다. 2층이면 루트 하나가 리프를 약 900장만 가리켜 6,303장을 담지 못하므로 리프 위에 중간 층이 하나 있어 루트·중간·리프 3층이다. 실제로도 리프 6,303장 위에 중간 8장, 그 위에 루트가 있었다(컨테이너 확인: 페이지 파일을 읽음). 1억 행은 리프 약 66.7만 장, 그 위 중간 약 741장, 그 위 루트로 역시 3층이다(셈). 3층은 약 900 × 900 × 150 ≈ 1.2억 행까지다. 층 수를 로그로 셈할 때 리프 층을 빼먹지 않는다(밑 900 로그 올림 2는 리프 위의 층 수다).

**근거:** [문제 상황 1-2][problem1-2], [질문 3][q3]

### 05-004

**앞면:** `innodb_page_size`를 4KB로 만든다면(항목을 담는 공간 약 4,000B로 셈, 행 약 100B, 중간 항목 약 17B) 중간 페이지의 자식 수, 리프 한 장의 행 수, 100만 행과 1억 행의 층 수는 어떻게 되는가? 16KB일 때(자식 약 900, 리프 약 150행, 둘 다 3층)와 견주라.

**뒷면:** 자식 수는 약 235(4,000 ÷ 17), 리프 한 장은 약 40행(4,000 ÷ 100)이다. 100만 행은 리프 약 2.5만 장이고 235² ≈ 5.5만 장까지 담는 3층(루트, 중간, 리프)이다. 1억 행은 리프 약 250만 장이라 3층으로는 모자라고 235³ ≈ 1,300만 장까지 담는 4층이다(셈, 재지 않음). 페이지가 4분의 1이면 팬아웃과 리프 행 수가 함께 줄어, 16KB에서 3층이던 1억 행에 층이 하나 더 생긴다. 리프 한 장의 행 수는 페이지 크기 ÷ 행 크기다. 16KB 리프의 행 수(약 150)를 4KB에 그대로 쓰지 않는다.

**근거:** [질문 3][q3]

### 05-005

**앞면:** B-Tree, B+Tree, 해시 인덱스는 무엇이 다른가? 등치 조회는 해시가 O(1)인데도 InnoDB가 등치에도 B+Tree를 쓰고 해시 인덱스를 따로 두지 않아도 되는 까닭을 숫자로 설명하라(100만 행 `idx_user`로 `user_id = 4242` 5건을 찾는 쿼리: 3층, 논리적 읽기 30, 0.006~0.008ms).

**뒷면:** B-Tree는 중간 노드에도 행을 두고, B+Tree는 행을 리프에만 두며 중간에는 키와 자식 페이지 번호만 둔다. 그래서 B+Tree는 팬아웃이 커 층이 낮고(16KB에서 약 900, 1억 행도 3층. 같은 숫자로 B-Tree는 자식 약 148이라 1억 행이 4층, 셈), 범위와 정렬은 한 번 내려간 뒤 리프만 옆으로 읽는다. 해시 인덱스는 같은 키를 한 번에 찾지만 해시값이 키 순서를 잃어 범위·정렬·앞부분 일치(`LIKE 'x%'`)를 못 한다. 등치도 B+Tree로 3장을 내려가면 되고, 논리적 읽기 30번에 0.006~0.008ms라 페이지 한 장에 1µs가 안 걸린다. 해시가 아낄 몫은 내려가는 3장 중 두어 장뿐이다. 범위·정렬에는 B+Tree가 어차피 있어야 하고, 해시를 따로 두면 쓸 때마다 고칠 구조가 하나 는다. InnoDB가 자주 찾는 키에 스스로 만드는 적응형 해시 인덱스는 MySQL 8.4에서 기본으로 꺼져 있다(컨테이너 확인).

**근거:** [질문 2][q2], [Adaptive Hash Index][ahi]

## 클러스터형 인덱스, 보조 인덱스, 커버링

### 05-006

**앞면:** 100만 행 orders(`id BIGINT` 기본 키, `user_id INT`, 행 약 100B)에서 `PRIMARY` 리프는 6,303장, `idx_user (user_id)` 리프는 1,078장이다. 두 인덱스의 리프 항목에는 각각 무엇이 있는가? 보조 인덱스 항목이 행의 자리(페이지 번호) 대신 기본 키를 갖는 까닭은?

**뒷면:** 클러스터형 인덱스(`PRIMARY`)가 곧 표이고, 리프에 행 전체가 기본 키 순으로 있다(장당 158.7행). 보조 인덱스의 리프 항목은 (user_id, id)뿐이다. 1,078장이면 장당 약 928항목이라 항목 하나가 약 17B(user_id 4B + id 8B + 레코드 머리 5B)여서 행의 자리를 가리킬 공간이 없다. 보조 인덱스 리프에 100B 행이 있었다면 리프가 `PRIMARY`처럼 약 6,666장이어야 한다. 행의 자리 대신 기본 키를 두기 때문에, 페이지 분할로 행이 다른 페이지로 옮겨도 보조 인덱스를 고치지 않아도 된다. 대신 다른 칼럼이 필요하면 그 기본 키로 `PRIMARY`를 다시 찾는다(두 번 읽기).

**근거:** [질문 5][q5], [묶음 ① 결과][batch1], [Clustered and Secondary Indexes][index-types]

### 05-007

**앞면:** 100만 행 orders에 보조 인덱스 `idx_user (user_id)`만 있다. 고객 1은 주문 5만 건이고 id가 1년치에 흩어져 있다. `SELECT created_at, amount FROM orders WHERE user_id = 1 AND created_at >= '2026-08-10';`는 `idx_user` 항목 5만 개를 읽으며 논리적 읽기가 200,073번이었고, 보조 인덱스 없이 100만 행을 다 읽으면 7,473번이었다. 항목 하나에 약 4번은 어느 인덱스의 어느 페이지인가? 항목마다 6장(두 인덱스에서 3장씩)이 아닌 까닭은?

**뒷면:** 처음 한 번 `idx_user`의 루트·중간·리프를 내려가 첫 user_id = 1 항목에 닿고, 그 뒤로는 같은 리프의 옆 항목으로 넘어가므로 `idx_user`를 다시 내려가지 않는다. 항목마다 created_at·amount를 얻으려고 그 id로 `PRIMARY`를 루트부터 리프까지 3장 내려간다(두 번 읽기). 나머지 약 1번은 `PRIMARY`에 다녀온 뒤 `idx_user` 리프를 다시 여는 몫으로 봤다(추측). 항목마다 6장이면 30만인데 잰 값은 200,073(항목당 약 4)이다. 항목을 20분의 1만 읽고도 페이지는 27배를 읽었고, 시간은 35.2~36.0ms로 전체 읽기(144~151ms)의 4분의 1에 그쳤다. `idx_user`만 읽는 `COUNT(*)`는 같은 5만 항목에 77번이었다(컨테이너 확인).

**근거:** [문제 상황 1-1][problem1-1], [문제 상황 1-2][problem1-2], [질문 4][q4], [질문 5][q5]

### 05-008

**앞면:** 100만 행 orders에서 `SELECT created_at, amount FROM orders WHERE user_id = 1 AND created_at >= '2026-08-10';`(12,656행)를 (다) `idx_user_created (user_id, created_at)` (마) `idx_user_created_amount (user_id, created_at, amount)`로 돌린다. 둘 다 항목 12,656개를 읽는데 논리적 읽기와 시간은 어떻게 다르고, `Extra`에는 무엇이 붙는가? 커버링 인덱스는 인덱스의 한 종류인가?

**뒷면:** (다)는 리프에 amount가 없어 항목마다 `PRIMARY`를 다시 찾는다(`range`, `Using index condition`, 논리적 읽기 50,661 ≈ 12,656 × 4, 9.90~10.2ms). (마)는 쿼리가 쓰는 칼럼(WHERE의 user_id·created_at, `SELECT`의 created_at·amount)이 인덱스에 다 있어 리프 약 21장을 옆으로 읽고 끝난다(`range`, `Using where; Using index`, 논리적 읽기 54, 2.37~2.39ms). 이것을 커버링 인덱스라고 하고, 인덱스의 종류가 아니라 인덱스와 쿼리의 관계다((마)도 보통의 복합 인덱스다). `Extra`의 `Using index`가 커버링이라는 표시다. 대가는 인덱스 크기(리프 1,632장 대 1,386장)와 쓰기다. 자주 도는 쿼리를 덮으려고 일부러 칼럼을 붙이기도 한다.

**근거:** [문제 상황 1][problem1], [문제 상황 1-1][problem1-1], [질문 7][q7], [묶음 ① 결과][batch1]

### 05-009

**앞면:** 100만 행 orders에 보조 인덱스 `(user_id, created_at)`만 있다. (ㄱ) `SELECT id, created_at FROM orders WHERE user_id = 1 AND created_at >= '2026-08-10';` (ㄴ) 같은 조건의 `SELECT COUNT(*)`는 클러스터형 인덱스를 다시 읽는가? 보조 인덱스 `(user_id)`만 있을 때 (ㄷ) `SELECT COUNT(*) FROM orders WHERE user_id = 1;`(5만 건)은? 논리적 읽기는 수십인가, 수만~수십만인가?

**뒷면:** 셋 다 다시 읽지 않는다. 보조 인덱스 항목 끝에 기본 키가 붙어 있어 (ㄱ)의 id는 인덱스에 있다. `COUNT(*)`의 `*`는 모든 칼럼이 아니라 행 수를 세라는 뜻이라, 조건 칼럼이 인덱스에 다 있으면 항목만 센다. 컨테이너 확인에서 (ㄱ)(ㄴ)은 `range` · `Using where; Using index`, 논리적 읽기 51이었고(같은 인덱스로 amount까지 읽으면 50,661), (ㄷ)은 `ref` · `Using index`, 항목 5만 개에 논리적 읽기 77이었다. `COUNT(*)`를 `SELECT *`처럼 보면 항목마다 클러스터형 인덱스를 다시 찾는다고 잘못 셈하게 된다.

**근거:** [문제 상황 1-1][problem1-1], [질문 7][q7]

## 복합 인덱스의 칼럼 순서

### 05-010

**앞면:** 100만 행 orders(created_at은 1년에 고르게)에서 고객 4242의 주문은 5건, 2026-08-10 이후 주문은 전체 251,352건이다. `SELECT created_at, amount FROM orders WHERE user_id = 4242 AND created_at >= '2026-08-10';`에 복합 인덱스 (다) `(user_id, created_at)` (라) `(created_at, user_id)` 중 무엇을 두는가? 두 리프에서 4242의 08-10 이후 항목은 어떻게 놓이고, 칼럼 순서를 정하는 기준은 무엇인가?

**뒷면:** (다)를 둔다. 리프는 앞 칼럼부터, 같으면 다음 칼럼 순으로 놓인다. (다)는 4242의 항목이 한데 모이고 그 안이 created_at 순이라 (4242, 2026-08-10) 자리로 내려가 1개를 읽고 멈췄다(`range`, `Using index condition`, 논리적 읽기 13, 0.003~0.005ms). (라)는 08-10 이후 251,352항목 곳곳에 4242가 흩어져 그 범위를 다 읽어야 하고, 옵티마이저는 항목마다 클러스터형 인덱스를 다시 읽는 비용을 셈해 인덱스 대신 표 전체 읽기를 골랐다(`ALL`, 142~149ms. 인덱스를 강제하면 15.0~15.9ms, 컨테이너 확인). 기준은 칼럼의 역할이다. 같은 값으로 찾는 칼럼(등치)을 앞에, 범위 칼럼을 뒤에 둔다. WHERE에 조건을 적은 순서는 기준이 아니다.

**근거:** [문제 상황 1][problem1], [질문 6][q6], [Multiple-Column Indexes][multi-col]

### 05-011

**앞면:** 여섯 행 (user_id, created_at) = (4242, 07-01) (4243, 08-12) (4242, 08-24) (17, 09-03) (4242, 05-10) (17, 08-15)(날짜는 2026년)가 있다. (1) `(user_id, created_at)`와 `(created_at, user_id)` 인덱스의 리프 순서 (2) `user_id = 4242 AND created_at >= '2026-08-10'`을 각 인덱스에서 어디서 시작해 어디서 멈추고 몇 개 읽는가 (3) WHERE를 `created_at >= '2026-08-10' AND user_id = 4242`로 바꿔 쓰면 읽는 수나 고르는 인덱스가 달라지는가?

**뒷면:** (1) `(user_id, created_at)`는 (17, 08-15) (17, 09-03) (4242, 05-10) (4242, 07-01) (4242, 08-24) (4243, 08-12), `(created_at, user_id)`는 (05-10, 4242) (07-01, 4242) (08-12, 4243) (08-15, 17) (08-24, 4242) (09-03, 17)이다. (2) 앞 인덱스는 (4242, 08-24)에서 시작해 다음 항목 (4243, 08-12)에서 멈추며 2개를 읽는다(맞는 항목 1개와 멈출 자리를 확인한 1개). 뒤 인덱스는 08-10 이후 첫 항목 (08-12, 4243)부터 끝까지 4개를 읽고 그중 4242는 1개다. (3) 달라지지 않는다. 옵티마이저는 AND로 이은 조건을 순서와 상관없이 함께 보고, 인덱스의 맨 앞 칼럼부터 조건이 있는지 본다. 컨테이너 확인에서 조건의 순서만 바꾼 두 쿼리의 계획이 같았다.

**근거:** [질문 6][q6]

### 05-012

**앞면:** 100만 행 orders(status는 paid 약 90%, cancelled 약 7%, refunded 약 3%)에서 고객이 상태를 골라 최신순 20개를 본다. `SELECT id, amount, created_at FROM orders WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 20;` 고객 대부분은 주문이 10건 안팎이고 고객 1은 5만 건이다. 보조 인덱스를 하나만 둔다면 칼럼을 어떤 순서로 두는가? amount까지 붙이면 무엇을 얻고 잃는가?

**뒷면:** `(user_id, status, created_at)`이다. 등치 칼럼 둘을 앞에 두면 한 고객의 한 상태 항목이 한데 모이고 그 안이 created_at 순이라, 구간 끝에서 거꾸로 20개를 읽고 정렬 없이 멈춘다. 컨테이너 확인에서 고객 1의 취소 주문 최신 20개는 `ref` · `Backward index scan`으로 20항목, 0.613~0.723ms였고, `(user_id)`만 있으면 5만 항목을 읽고 정렬해(`Using filesort`) 79.1~92.3ms였다. amount를 붙이면 커버링이 되어 20행의 클러스터형 인덱스 다시 읽기 20번쯤을 아끼고, 대가는 인덱스 크기와 쓰기다. 20행만 돌려주는 쿼리라 얻는 몫이 작다.

**근거:** [목표 3 확인][goal3], [질문 6][q6], [질문 7][q7]

## 인덱스가 있어도 쓰이지 않는 경우

### 05-013

**앞면:** 100만 행 orders에 `idx_created (created_at)`가 있다(created_at은 DATETIME). `SELECT id, amount FROM orders WHERE DATE(created_at) = '2026-08-10';`(2,831건)는 인덱스로 범위를 좁히는가? 인덱스를 쓰게 고쳐 쓰고, 쿼리를 고칠 수 없을 때의 방법도 적어라. `WHERE created_at = DATE('2026-08-10')`은 같은 결과인가?

**뒷면:** 좁히지 못한다. 리프는 created_at의 원래 값 순서로 놓여 있는데, 칼럼에 함수를 씌우면 행마다 바꾼 값과 비교해야 해 시작 자리를 찾지 못한다(`ALL`, possible_keys 없음, 153~159ms). 옵티마이저는 "칼럼 그대로 대 상수" 꼴만 범위로 바꾼다. 바꾸는 일을 상수로 옮겨 `created_at >= '2026-08-10' AND created_at < '2026-08-11'`로 쓰면 `range`, 2,831항목, 1.69~1.70ms다(`DATE('2026-08-10')`처럼 상수에 함수를 씌우는 것은 괜찮다). 고칠 수 없으면 함수 인덱스 `((DATE(created_at)))`로 원래 쿼리가 `ref`, 1.72~1.76ms였고, 쓰기마다 고칠 인덱스가 하나 는다. `created_at = DATE('2026-08-10')`은 그날 0시 정각과만 같아 결과가 0행이었다.

**근거:** [문제 상황 1-3][problem1-3], [질문 8][q8], [묶음 ① 결과][batch1]

### 05-014

**앞면:** 100만 행 orders에 `idx_phone (phone)`(phone은 VARCHAR(20), 예 '01009234282')과 `idx_user (user_id)`(user_id는 INT)가 있다. (나) `WHERE phone = 01009234282`(따옴표 없는 숫자) (라) `WHERE user_id = '4242'`(따옴표 있는 문자열)는 둘 다 다른 타입의 값과 비교한다. 각각 인덱스를 쓰는가? 무엇이 둘을 가르는가?

**뒷면:** (나)는 쓰지 못하고(`ALL`, Note 1739, 161~165ms) (라)는 쓴다(`ref`, 5항목, 0.005~0.006ms). MySQL은 문자열과 숫자를 비교할 때 둘 다 숫자로 바꾼다. (나)는 칼럼의 값 phone을 행마다 숫자로 바꿔야 하고, 같은 숫자가 되는 다른 문자열('1009234282' 등)이 문자열 순서에서 떨어져 있어 범위를 정하지 못한다. (라)는 상수 '4242'를 한 번 정수로 바꿀 뿐이라 칼럼 그대로 대 상수 꼴이 된다. 가르는 것은 바뀌는 값이 칼럼의 값인지 상수인지다. 칼럼의 값이 바뀌면(함수, 형변환) 인덱스를 못 쓰고, 상수가 바뀌는 것은 괜찮다. (나)는 `phone = '01009234282'`로 쓰면 `ref`, 0.003~0.004ms다.

**근거:** [문제 상황 1-3][problem1-3], [질문 8][q8], [Type Conversion in Expression Evaluation][type-conv]

### 05-015

**앞면:** 100만 행 orders의 `idx_phone (phone)` 리프에 '01009230001' '01009234282' '01011114282' '01055554282'처럼 번호가 사전 순으로 놓여 있다. `LIKE '0100923%'`(96건)와 `LIKE '%4282'`(95건)는 리프에서 어디서 시작해 어디서 멈추는가? TEXT 칼럼 memo에 `CREATE INDEX idx_memo ON orders (memo);`를 하면 어떻게 되고, `memo(20)` 인덱스가 있을 때 `LIKE '%포장%'`는 어떻게 읽는가?

**뒷면:** '0100923'으로 시작하는 번호는 사전 순 리프에 한데 모여 있어, '0100923' 자리로 내려가 '01009230001'부터 읽고 '0100923'으로 시작하지 않는 첫 항목('01011114282')에서 멈춘다(`range`, 96항목, 0.080~0.081ms). '%4282'는 4282로 끝나는 번호가 리프 곳곳에 흩어져 시작 자리가 없어 다 읽는다(`ALL`, 190~199ms). 와일드카드가 앞에 오면 범위가 되지 못한다. TEXT 칼럼은 앞부분 길이 없이 인덱스를 만들 수 없다(오류 1170). `memo(20)`이 있어도 `LIKE '%포장%'`는 앞이 정해지지 않아 `ALL`(285~290ms)이었다. `LIKE`는 정규식이 아니라 `%`·`_` 패턴 비교이고, 정규식은 `REGEXP`다.

**근거:** [문제 상황 1-3][problem1-3], [질문 8][q8], [Column Indexes][column-indexes]

### 05-016

**앞면:** 100만 행 orders에 `idx_created (created_at)`만 있다(created_at은 DATETIME). 2026-11-01 하루의 주문 수를 `SELECT COUNT(*) FROM orders WHERE created_at LIKE '2026-11-01%';`로 센다. `EXPLAIN`의 `type`과 `Extra`, 읽는 항목 수, 시간의 크기는? VARCHAR 칼럼 phone의 `LIKE '0100923%'`는 범위로 읽었는데 무엇이 다른가?

**뒷면:** 컨테이너 확인에서 `index` · `idx_created`, `Using where; Using index`, 항목 100만 개(next 1,000,000), 248~255ms였다. 칼럼이 DATETIME이라 LIKE로 비교하려면 행마다 created_at을 문자열로 바꿔야 해(칼럼 값의 변환) 범위로 읽지 못한다. phone은 원래 문자열이라 리프 순서가 곧 문자열 순서였다. 필요한 칼럼이 `idx_created`에 다 있어 표 대신 인덱스 전체를 읽었다(`index`, 커버링). 하루 구간 `created_at >= '2026-11-01' AND created_at < '2026-11-02'`로 쓰면 `range`, 2,720항목, 0.807~0.857ms였다(컨테이너 확인).

**근거:** [목표 1 확인][goal1], [문제 상황 1-3][problem1-3]

## `EXPLAIN`과 옵티마이저

### 05-017

**앞면:** `EXPLAIN`의 `type` 값 `ALL`, `index`, `range`, `ref`, `const`는 각각 어떤 읽기인가? `Extra`의 `Using where`, `Using index`, `Using index condition`, `Using filesort`, `Backward index scan`은 무슨 뜻인가?

**뒷면:** `ALL`은 표(클러스터형 인덱스) 전체를, `index`는 인덱스 전체를 읽는다. `range`는 인덱스의 한 구간(범위 조건)을, `ref`는 같은 값의 항목들(등치 조건)을, `const`는 기본 키나 유일 인덱스로 한 행을 읽는다. `Using where`는 읽은 행을 서버가 조건으로 거른 것이다. `Using index`는 인덱스만 읽고 끝나 클러스터형 인덱스를 다시 읽지 않은 것(커버링)이고, 인덱스를 쓴다는 뜻이 아니다. `Using index condition`은 인덱스 안의 칼럼으로 조건을 먼저 거른 것(인덱스 조건 푸시다운)이고, 거르고 남은 항목은 클러스터형 인덱스를 다시 읽는다. `Using filesort`는 인덱스 순서를 쓰지 못해 읽은 행을 따로 정렬한 것(메모리 안에서 끝나기도 함), `Backward index scan`은 인덱스를 거꾸로 읽은 것이다. 실제로 읽은 수는 `EXPLAIN ANALYZE`와 `Handler_read_*`로 본다.

**근거:** [질문 9][q9], [목표 1 확인][goal1], [EXPLAIN Output Format][explain-output], [Index Condition Pushdown Optimization][icp]

### 05-018

**앞면:** 100만 행 orders에서 `idx_user (user_id)`로 고객 1(5만 건)의 행을 읽는 쿼리의 `EXPLAIN` rows는 104,988이었다. 또 `idx_status_created (status, created_at)`로 `SELECT id, created_at FROM orders WHERE status = 'refunded' ORDER BY created_at DESC LIMIT 20;`을 하면 rows는 20 근처인가? rows는 무엇이고, 실제로 읽은 수는 어디서 보는가?

**뒷면:** rows는 옵티마이저가 계획을 세울 때 추정한, 고른 읽기 방법으로 훑을 행 수다. 쿼리를 실행하지 않고 나오고 `LIMIT`을 반영하지 않는다. 104,988은 user_id = 1 범위의 양 끝을 인덱스에서 찾아 어림한 값(index dive)이고 실제는 50,000이었다(컨테이너 확인: 통계만으로는 약 10이고, 옵티마이저 trace에 `index_dives_for_eq_ranges`가 있었음). refunded 쿼리는 refunded 전체를 추정해 rows 55,906이었고, 실제로는 20항목만 읽었다(`Backward index scan; Using index`, prev 19, 0.285~0.364ms, 컨테이너 확인). 실제 수는 `EXPLAIN ANALYZE`의 actual rows와 `Handler_read_*`로 본다. rows는 페이지를 읽은 수(논리적 읽기)도 아니다.

**근거:** [질문 9][q9], [목표 1 확인][goal1], [문제 상황 1-1][problem1-1]

### 05-019

**앞면:** 100만 행 orders에 `(created_at, user_id)` 인덱스만 있을 때 `WHERE user_id = 4242 AND created_at >= '2026-08-10'`(08-10 이후 실제 251,352항목)을, `idx_created (created_at)`만 있을 때 `ORDER BY created_at DESC LIMIT 20 OFFSET 100000`을 옵티마이저는 어떻게 실행했고, 인덱스를 강제하면 어땠는가? 옵티마이저는 무엇으로 계획을 고르는가?

**뒷면:** 옵티마이저는 계획마다 추정 rows로 비용을 셈해 가장 싼 것을 고른다(비용 기반). 첫 쿼리는 범위를 rows 458,872로 추정하고 항목마다 클러스터형 인덱스를 다시 읽는 비용을 붙여(cost 160,605) 표 전체 읽기(100,695)보다 비싸다고 보고 `ALL`(142~149ms)을 골랐다. 실제로는 user_id를 인덱스 안에서 먼저 걸러 클러스터형 인덱스를 한 번만 읽어, `FORCE INDEX`로 15.0~15.9ms였다(컨테이너 확인. 거르는 몫을 비용에 넣지 않은 것으로 보는 것은 추측). OFFSET 쿼리는 `ALL`과 정렬(233~234ms)을 골랐지만 `FORCE INDEX (idx_created)`로는 58.4~61.5ms였다. 추정이 빗나가면 더 느린 계획을 고른다.

**근거:** [문제 상황 1][problem1], [질문 9][q9], [묶음 ② 결과][batch2]

## 정렬과 페이지네이션

### 05-020

**앞면:** 100만 행 orders(id 순서가 곧 시간 순서)에서 `SELECT id, user_id, amount, created_at FROM orders ORDER BY created_at DESC LIMIT 20;`을 (가) 보조 인덱스 없이 (나) `idx_created (created_at)`로, `SELECT id, amount, created_at FROM orders WHERE user_id = 1 ORDER BY created_at DESC LIMIT 20;`(고객 1은 5만 건)을 (다) `idx_user (user_id)` (라) `idx_user_created (user_id, created_at)`로 돌린다. 어느 것이 정렬을 따로 하고, 인덱스로 정렬을 생략하는 규칙은 무엇인가?

**뒷면:** (가)(다)가 정렬을 따로 한다(`Using filesort`). (가)는 100만 행을 읽어 192~199ms, (다)는 user_id = 1 항목 5만 개를 읽고 항목마다 클러스터형 인덱스에서 created_at을 가져와 34.1~34.9ms였다. (나)는 `idx_created`의 끝에서 거꾸로 20개(0.020~0.031ms), (라)는 user_id = 1 구간의 끝에서 거꾸로 20개(0.504~0.510ms)를 읽고 멈췄다(`Backward index scan`). 정렬 생략을 정하는 것은 `ORDER BY`다. `ORDER BY`의 칼럼이 인덱스 칼럼 순서와 같을 때, 또는 앞 칼럼을 등치 조건으로 하나로 고정하고 그다음 칼럼부터 같을 때 리프 순서대로 읽고 `LIMIT`에서 멈춘다. WHERE는 앞 칼럼을 고정할 뿐이다. (다)의 user_id = 1 항목은 id 순이고, 이 데이터에서 id 순이 시간 순이어도 MySQL은 인덱스 정의로만 판단한다.

**근거:** [문제 상황 2][problem2], [질문 10][q10], [ORDER BY Optimization][order-by]

### 05-021

**앞면:** 100만 행 orders(user_id 2 ~ 100,000은 고객마다 평균 9.5건)에 `(user_id, created_at)` 인덱스가 있다. `SELECT id, amount, created_at FROM orders WHERE user_id BETWEEN 100 AND 199 ORDER BY created_at DESC LIMIT 20;`은 정렬을 따로 하는가? 같은 인덱스로 `WHERE user_id = 1 ORDER BY created_at DESC LIMIT 20`은 20개만 읽었는데 무엇이 다른가?

**뒷면:** 따로 한다. 컨테이너 확인에서 `range` · `Using index condition; Using filesort`, 967항목, 1.89~2.75ms였다. 리프는 (100, 1월) (100, 5월) (101, 2월) (101, 11월) …처럼 고객 하나 안에서만 created_at 순이라, 범위를 리프 순서대로 읽어도 전체로는 created_at 순이 아니다. 그래서 967항목을 다 읽고 정렬한다(항목마다 amount를 얻으려고 클러스터형 인덱스도 다시 읽어 논리적 읽기 3,878). `user_id = 1`은 앞 칼럼을 하나의 값으로 고정해 구간 전체가 created_at 순이라, 끝에서 20개를 읽고 멈춘다. 앞 칼럼을 고정하는 것은 등치뿐이고 범위(`BETWEEN`, `<`, `>`)는 고정하지 못한다. 리프 순서는 WHERE의 시작 자리 찾기와 멈추기에도, `ORDER BY`의 정렬 생략에도 쓰인다.

**근거:** [목표 1 확인][goal1], [질문 10][q10], [ORDER BY Optimization][order-by]

### 05-022

**앞면:** 100만 행 orders에 `idx_created (created_at)`가 있다. 페이지 번호로 넘기는 관리자 목록에서 5,001번째 페이지를 `SELECT id, user_id, amount, created_at FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 100000;`으로 읽는다. 인덱스로 10만 번째 자리에 바로 갈 수 있는가? 커서 방식은 그 자리에 어떻게 닿고, 페이지 번호가 커지면 시간이 어떻게 되는가?

**뒷면:** 바로 가지 못한다. OFFSET은 값이 아니라 개수인데, 인덱스 페이지에는 그 아래 항목 수가 없어 N번째로 가는 길이 없다. 그래서 최근부터 세며 10만 개를 읽고 버린다. 옵티마이저는 `ALL`과 정렬(233~234ms)을 골랐고, `FORCE INDEX`로는 `Backward index scan`으로 100,020항목을 읽으며 버릴 항목도 클러스터형 인덱스를 다시 읽어 논리적 읽기 401,307, 58.4~61.5ms였다. 커서는 앞 페이지 마지막 행의 값(created_at, id)으로 루트부터 내려가 바로 닿고 20개를 읽어(prev 19), 5,001번째 페이지 0.479~0.492ms, 170번째 0.468~0.478ms로 페이지 번호와 상관없었다. 페이지 번호로 바로 가야 하는 화면이 아니면 커서를 고른다.

**근거:** [문제 상황 2-1][problem2-1], [질문 10][q10], [묶음 ② 결과][batch2]

### 05-023

**앞면:** 100만 행 orders에 같은 초의 주문이 여럿 있다(같은 초 묶음 15,629개, 31,408행). 최신순 20개씩 넘기는 목록에서 앞 페이지의 마지막 행이 (created_at, id) = ('2026-10-04 10:09:05', 900001)이다. created_at만 기억해 `WHERE created_at < '2026-10-04 10:09:05'`나 `<=`로 다음 페이지를 읽으면 무엇이 잘못되는가? `idx_created (created_at)`로 범위를 읽는 다음 페이지 쿼리를 써라.

**뒷면:** `<`는 경계와 같은 초의 남은 행을 빠뜨린다. 처음부터 끝까지 49,962페이지를 넘기면 770행을 빠뜨렸다(첫 빠뜨림은 169번째 페이지 끝 (2026-11-08 18:56:53, 996621) 다음의 996620). `<=`는 앞 페이지 마지막 행이 다시 나온다(컨테이너 확인). 같은 초 안의 순서를 정하려고 기본 키 id를 더해 `SELECT id, user_id, amount, created_at FROM orders WHERE created_at < '2026-10-04 10:09:05' OR (created_at = '2026-10-04 10:09:05' AND id < 900001) ORDER BY created_at DESC, id DESC LIMIT 20;`으로 쓴다. 보조 인덱스 리프가 (created_at, id) 순이라 이 조건이 한 구간이 된다(`range`, 20항목, 0.479~0.492ms). 행 생성자 꼴 `(created_at, id) < ('2026-10-04 10:09:05', 900001)`는 MySQL 8.4에서 범위로 쓰이지 않아 인덱스를 끝부터 걸러 10만 항목을 읽었다(62.3~64.4ms).

**근거:** [문제 상황 2-1][problem2-1], [질문 10][q10], [목표 3 확인][goal3], [묶음 ② 결과][batch2]

### 05-024

**앞면:** 100만 행 orders에서 환불된 주문(약 3만 건)을 최신순 20개씩 끝까지 넘기며 id, user_id, amount, created_at을 보여 준다. 다음 페이지는 앞 페이지 마지막 행의 (created_at, id)로 `WHERE status = 'refunded' AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 20`을 쓴다. 커버링 인덱스로 (ㄱ) `(status, created_at, user_id, amount)` (ㄴ) `(status, created_at, id, user_id, amount)` 중 무엇을 두는가?

**뒷면:** (ㄴ)이다. 보조 인덱스 항목 끝에 기본 키가 붙지만, (ㄱ)은 같은 (status, created_at) 안이 user_id 순이라 `ORDER BY created_at DESC, id DESC`와 순서가 맞지 않는다. 컨테이너 확인에서 (ㄱ)은 `Using where; Using index; Using filesort`로 경계보다 오래된 항목 10,283개를 읽고 정렬해 4.78~7.63ms였고(앞 페이지일수록 더 많이 읽음), (ㄴ)은 id를 created_at 바로 뒤에 둬 `Backward index scan`으로 20항목, 0.188~0.245ms였다. 커버링 칼럼을 붙일 때도 등치 칼럼(status), 정렬과 커서에 쓰는 칼럼(created_at, id)을 먼저 둔다.

**근거:** [목표 3 확인][goal3]

## 쓰기 비용과 기본 키

### 05-025

**앞면:** 버퍼 풀 1GB에서 100만 행 orders의 복사본에 새 주문 10만 건을 5,000건씩 넣는다. 보조 인덱스가 (가) 0개 (나) 3개 (다) 6개일 때 넣는 시간은 몇 배가 되는가? "인덱스마다 루트·중간·리프 3장을 더 읽으니 (나)는 9배, (다)는 18배"라는 셈에서 빠진 것은?

**뒷면:** 1.12 / 1.74 / 2.41초로 1.55배, 2.14배였다(페이지 분할 630 / 3,355 / 5,894, 데이터 파일 쓰기 29~60 / 67~105 / 167~181MiB). 9배·18배 셈에서 빠진 것은 둘이다. (가)도 행마다 클러스터형 인덱스에 자리를 찾아 넣으므로, 논리적 읽기로 세면 (3 + 9) ÷ 3 = 4배, (3 + 18) ÷ 3 = 7배다. 그리고 인덱스 수와 상관없는 일(파이썬이 INSERT 문을 만들고, 서버가 문장을 읽고, 커밋하고 오가는 시간)이 (가) 2.00초 중 약 1.4초였다(컨테이너 확인). 그래도 인덱스마다 쓰기가 붙으니 자주 도는 조회에 필요한 인덱스만 둔다.

**근거:** [문제 상황 3][problem3], [묶음 ③④ 결과][batch34]

### 05-026

**앞면:** 빈 표에 100만 행을 넣을 때 기본 키가 (라) `BIGINT AUTO_INCREMENT` (마) 무작위 UUIDv4(`BINARY(16)`) (바) UUIDv7(`BINARY(16)`, 앞 48비트가 밀리초 시각)이면, 새 행은 `PRIMARY` B+Tree의 어디로 들어가고 꽉 찬 페이지는 어떻게 나뉘는가? 다 넣은 뒤 `PRIMARY` 리프 수(6,303 / 9,664 / 6,832)가 이렇게 다른 까닭은?

**뒷면:** (라)(바)는 새 키가 늘 가장 커 맨 끝 리프에 붙는다. 끝 리프가 꽉 차면 그 페이지는 그대로 두고 새 페이지에 새 행부터 넣어(끝에서 나뉨) 페이지가 거의 꽉 찬다. (마)는 새 키가 곳곳의 리프 가운데로 끼어들어, 꽉 찬 페이지를 반씩 나누고(가운데서 나뉨) 뒤에 행이 더 들어와 평균 3분의 2쯤 찬다(채움 비율). (바)의 1.08배는 행이 8B 커진 몫(약 108B ÷ 100B)이고, (마)의 1.53배는 그 1.08배에 채움 비율의 몫 약 1.4배를 곱한 값이다. 페이지 분할은 8,025 / 11,799 / 8,955번으로 새로 생긴 페이지 수와 거의 같아, (바)에도 분할이 있다. 크기를 정하는 것은 몇 번 나뉘었나가 아니라 어디서 나뉘나다.

**근거:** [문제 상황 3][problem3], [질문 11][q11], [묶음 ③④ 결과][batch34]

### 05-027

**앞면:** 버퍼 풀 1GB(표 전체가 들어감)에서 빈 표에 100만 행을 넣을 때 기본 키별 넣는 시간과 데이터 파일 쓰기는 AUTO_INCREMENT 11.78초·422~442MiB, UUIDv4 14.98초·1,179~1,195MiB, UUIDv7 12.91초·533~564MiB였다(다 넣은 파일은 140 / 224 / 172MiB). 바뀐 페이지는 언제 디스크에 쓰이고, UUIDv4가 파일 크기보다 훨씬 많이 쓰는 까닭은?

**뒷면:** 바뀐 페이지는 버퍼 풀에서 더티 페이지가 되고, 페이지 클리너(백그라운드 스레드)가 나중에 디스크에 쓴다(플러시). UUIDv4는 새 행이 표 전체에 흩어진 리프로 들어가, 플러시한 페이지가 또 바뀌어 같은 페이지가 여러 번 다시 쓰인다. 그래서 데이터 파일 쓰기가 AUTO_INCREMENT의 약 2.7배였다. AUTO_INCREMENT·UUIDv7은 `PRIMARY`에서 바뀌는 페이지가 끝 근처에 모여 있다. AUTO_INCREMENT도 파일 140MiB에 422~442MiB를 써, 페이지마다 한 번씩만 쓰는 것은 아니다. 플러시가 백그라운드에서 일어나고 물리적 읽기가 0~2페이지였기 때문에 넣는 시간은 1.27배에 그쳤다.

**근거:** [문제 상황 3][problem3], [질문 11][q11], [묶음 ③④ 결과][batch34], [Buffer Pool][buffer-pool]

## 버퍼 풀

### 05-028

**앞면:** 페이지, 버퍼 풀, 논리적 읽기, 물리적 읽기, 적중과 미스, 더티 페이지, 플러시, 축출(LRU)을 설명하라. 버퍼 풀 1GB와 128MB는 각각 몇 페이지인가? "인덱스를 쓰려면 트리 전체를 늘 메모리에 올려 둬야 한다"는 맞는가?

**뒷면:** 페이지는 InnoDB가 읽고 쓰는 단위(16KB)이고, 버퍼 풀은 페이지를 담아 두는 메모리 영역이다(1GB = 65,536페이지, 128MB = 8,192페이지). 쿼리가 페이지를 들여다보는 것이 논리적 읽기(`Innodb_buffer_pool_read_requests`)이고, 그 페이지가 버퍼 풀에 있으면 적중, 없으면 미스라 디스크에서 읽어 온다(물리적 읽기, `Innodb_buffer_pool_reads`). 버퍼 풀에서 바뀐 페이지는 더티 페이지가 되어 나중에 디스크에 쓰이고(플러시), 자리가 모자라면 오래 쓰지 않은 페이지부터 내보낸다(축출, LRU). 더티 페이지는 내보내기 전에 먼저 쓴다. 그래서 트리를 늘 다 올려 둘 필요는 없고, 필요한 페이지를 그때 읽는다. 표가 버퍼 풀보다 커도 돌아간다.

**근거:** [문제 상황 3-1][problem3-1], [질문 11][q11], [Buffer Pool][buffer-pool]

### 05-029

**앞면:** 버퍼 풀을 128MB(8,192페이지)로 줄여 빈 표에 100만 행을 다시 넣었다. 다 넣은 파일은 AUTO_INCREMENT 140MiB, UUIDv4 224MiB, UUIDv7 172MiB로 셋 다 버퍼 풀보다 크고, 넣는 시간은 버퍼 풀 1GB 때 11.78 / 14.98 / 12.91초였다. 128MB에서는 시간이 어떻게 되고, 왜 그런가?

**뒷면:** 11.82 / 21.55 / 12.99초로 UUIDv4만 느려졌고, 물리적 읽기도 298~397 / 87,573~87,963 / 320~456이었다. 느려지는지는 표 크기가 아니라 자주 건드리는 페이지가 버퍼 풀에 들어가는지로 정해진다. AUTO_INCREMENT·UUIDv7은 새 행이 늘 맨 끝 리프(UUIDv7은 그 바로 근처)에 들어가 방금 쓴 페이지가 버퍼 풀에 있고(적중), 무작위로 들어가는 `idx_user`(2천여 페이지)도 8,192페이지에 다 들어간다. UUIDv4는 새 행이 `PRIMARY` 리프 9,664장 곳곳에 들어가 `idx_user`와 합치면 버퍼 풀보다 많아, 고른 리프가 축출돼 있으면 디스크에서 읽는다(행 100개에 약 9번). 자리를 만들려고 더티 페이지를 써서 내보내 데이터 파일 쓰기도 1,179~1,195MiB에서 3,006~3,070MiB로 늘었다.

**근거:** [문제 상황 3-1][problem3-1], [질문 11][q11], [묶음 ③④ 결과][batch34]

### 05-030

**앞면:** 새 표 payments(결제 번호, user_id, amount, created_at)에 하루 수백만 건이 들어오고 표는 곧 버퍼 풀보다 커진다. 결제 번호는 영수증 주소로 밖에 보이는데, 번호로 전체 결제 건수를 짐작할 수 없어야 한다. 조회는 결제 번호로 한 건 찾기와 고객별 최신순 목록이다. 기본 키(AUTO_INCREMENT, UUIDv4, UUIDv7 중)와 보조 인덱스를 무엇으로 하는가?

**뒷면:** 기본 키는 UUIDv7, 보조 인덱스는 `(user_id, created_at)`이다(목록 칼럼을 덮으려면 amount를 붙인다). AUTO_INCREMENT는 페이지가 순서대로 채워지지만 번호로 건수를 짐작할 수 있다. UUIDv4는 건수를 숨기지만 새 행이 곳곳에 끼어들어 표가 커지고(`PRIMARY` 리프 1.53배), 버퍼 풀보다 커지면 넣기가 크게 느려진다(128MB에서 21.55초 대 AUTO_INCREMENT 11.82초). UUIDv7은 넣는 순서가 곧 키 순서라 AUTO_INCREMENT에 가깝게 넣는다(12.99초). 대가는 16B 키라 보조 인덱스 항목마다 8B가 더 붙는 것(`idx_user` 리프 2,110 대 1,713)과, 번호에 만든 시각과 순서가 드러나는 것이다(건수는 드러나지 않음). UUIDv4로 잰 비용은 넣기뿐이고 조회는 재지 않았다.

**근거:** [목표 3 확인][goal3], [질문 11][q11], [묶음 ③④ 결과][batch34]

## 인덱스와 락

### 05-031

**앞면:** 100만 행 orders, REPEATABLE READ, 세션 A와 B다. 고객 4242는 주문 5건, 고객 17은 3건이다. A가 `START TRANSACTION; UPDATE orders SET amount = amount + 100 WHERE user_id = 4242;`를 하고 커밋하지 않은 채, B가 `START TRANSACTION; SELECT SUM(amount) FROM orders WHERE user_id = 17 FOR UPDATE;`를 보낸다. (가) 보조 인덱스 없음 (나) `idx_user (user_id)`에서 B는 기다리는가? A가 잠그는 범위를 정하는 것은 무엇인가?

**뒷면:** (가)는 A의 `COMMIT`까지 기다리고 (나)는 바로 끝난다(컨테이너 확인, 한 번). 락은 조건에 맞는 행이 아니라 읽으면서 훑은 인덱스 항목에 걸린다. 인덱스가 없으면 A의 `UPDATE`가 user_id = 4242를 찾으려고 `PRIMARY`를 처음부터 끝까지 훑으며 훑은 행마다 X 락을 걸고, REPEATABLE READ는 조건에 맞지 않은 행의 락도 해제하지 않는다(A가 잠근 행 1,006,303, 635.85ms). B의 `FOR UPDATE`도 인덱스가 없어 `PRIMARY`를 처음부터 훑다가 첫 행(id 1)에서 A의 X 락에 막힌다. (나)는 A가 `idx_user`의 4242 항목과 그 행들만 잠가(11개, 1.39ms) 17을 찾는 B와 겹치지 않아 B가 0.8ms에 끝났다. 인덱스가 읽는 범위가 곧 락 범위라, 쓰기와 잠금 읽기의 조건 칼럼에 인덱스를 두면 잠기는 범위도 준다.

**근거:** [04 변형][var04], [Locks Set by Different SQL Statements in InnoDB][locks-set]

### 05-032

**앞면:** REPEATABLE READ에서 고객 4242의 주문 amount 합은 445,400이고, 보조 인덱스 `idx_user (user_id)`가 있다. 순서는 1 A `START TRANSACTION;` 2 A `UPDATE orders SET amount = amount + 100 WHERE user_id = 4242;` 3 B `START TRANSACTION;` 4 B `SELECT SUM(amount) FROM orders WHERE user_id = 4242;` 5 A `COMMIT;` 6 B 4번과 같은 평범한 `SELECT` 7 B `SELECT SUM(amount) FROM orders WHERE user_id = 4242 FOR SHARE;` 8 B `COMMIT;`이다. 4·6·7번은 각각 기다리는가, 어떤 값을 돌려주는가?

**뒷면:** 셋 다 기다리지 않는다. 4번은 평범한 `SELECT`라 락 없이 스냅숏을 읽는 일관된 읽기다. REPEATABLE READ는 트랜잭션의 첫 평범한 `SELECT` 때 스냅숏을 만들고, 스냅숏에는 그 순간까지 커밋된 것만 들어간다. A의 변경은 커밋 전이라, B는 A가 X 락을 보유한 행을 undo log로 되돌린 옛 버전으로 읽어 445,400을 돌려준다. 6번도 4번의 스냅숏을 써서, A가 커밋한 뒤인데도 445,400이다. 7번 `FOR SHARE`는 S 락을 거는 잠금 읽기라 최신 커밋 값 445,900을 읽는다. 이때 A는 5번 `COMMIT`으로 X 락을 이미 해제해 7번을 막을 락이 없다(컨테이너 확인, 한 번: 4번 0.57ms, 6번 0.58ms, 7번 0.3ms. 잰 순서표에는 B가 다른 고객을 잠그는 문장이 4번과 5번 사이에 더 있었다). 7번이 5번보다 앞이었다면 A의 `COMMIT`까지 기다렸을 것이다(재지 않음). 순서표에서는 그 문장 때 누가 아직 락을 보유하고 있는지(락은 `COMMIT`이나 `ROLLBACK` 때 해제)부터 따진다.

**근거:** [04 변형][var04], [시작 전 기록의 변형 문제][before-variant], [Consistent Nonlocking Reads][consistent-read], [Locking Reads][locking-reads]

[before]: ../experiments/05-mysql-indexes-explain/README.md#시작-전-기록
[before-variant]: ../experiments/05-mysql-indexes-explain/README.md#지난-실험의-변형-문제-2026-11-09
[check]: ../experiments/05-mysql-indexes-explain/README.md#완료-후-학습-확인
[problem1]: ../experiments/05-mysql-indexes-explain/README.md#문제-상황-1-느려진-내-최근-주문-화면-2026-11-09
[problem1-1]: ../experiments/05-mysql-indexes-explain/README.md#문제-상황-1-1-주문이-아주-많은-고객의-내-최근-주문-2026-11-10
[problem1-2]: ../experiments/05-mysql-indexes-explain/README.md#문제-상황-1-2-100만-행의-클러스터형-인덱스는-몇-층일까-2026-11-10
[problem1-3]: ../experiments/05-mysql-indexes-explain/README.md#문제-상황-1-3-인덱스를-만들었는데도-느린-쿼리-2026-11-10
[problem2]: ../experiments/05-mysql-indexes-explain/README.md#문제-상황-2-최신순-주문-목록-20개-2026-11-11
[problem2-1]: ../experiments/05-mysql-indexes-explain/README.md#문제-상황-2-1-5001번째-목록-페이지-offset과-커서-2026-11-11
[problem3]: ../experiments/05-mysql-indexes-explain/README.md#문제-상황-3-쓰기-비용-를-숫자-표-하나로-2026-11-11
[problem3-1]: ../experiments/05-mysql-indexes-explain/README.md#문제-상황-3-1-버퍼-풀이-표보다-작을-때-2026-11-11
[batch1]: ../experiments/05-mysql-indexes-explain/README.md#묶음--같은-조회-다른-인덱스-조건마다-3회
[batch2]: ../experiments/05-mysql-indexes-explain/README.md#묶음--최신순-목록과-페이지네이션-조건마다-3회
[batch34]: ../experiments/05-mysql-indexes-explain/README.md#묶음--쓰기-비용-조건마다-3회
[q1]: ../experiments/05-mysql-indexes-explain/README.md#질문-1-인덱스란-무엇이고-왜-빠른가
[q2]: ../experiments/05-mysql-indexes-explain/README.md#질문-2-b-tree-btree-해시-인덱스
[q3]: ../experiments/05-mysql-indexes-explain/README.md#질문-3-트리의-층-수페이지-크기와-팬아웃
[q4]: ../experiments/05-mysql-indexes-explain/README.md#질문-4-인덱스의-비용
[q5]: ../experiments/05-mysql-indexes-explain/README.md#질문-5-클러스터형-인덱스와-보조-인덱스
[q6]: ../experiments/05-mysql-indexes-explain/README.md#질문-6-복합-인덱스의-칼럼-순서
[q7]: ../experiments/05-mysql-indexes-explain/README.md#질문-7-커버링-인덱스
[q8]: ../experiments/05-mysql-indexes-explain/README.md#질문-8-인덱스가-있어도-쓰이지-않는-경우
[q9]: ../experiments/05-mysql-indexes-explain/README.md#질문-9-explain-읽기
[q10]: ../experiments/05-mysql-indexes-explain/README.md#질문-10-정렬-생략-offset과-커서
[q11]: ../experiments/05-mysql-indexes-explain/README.md#질문-11-uuid-기본-키
[goal1]: ../experiments/05-mysql-indexes-explain/README.md#목표-1-확인-처음-보는-쿼리-3개
[goal3]: ../experiments/05-mysql-indexes-explain/README.md#목표-3-확인-처음-보는-상황-3개
[var04]: ../experiments/05-mysql-indexes-explain/README.md#04-변형-인덱스와-락-범위-일관된-읽기와-잠금-읽기
[physical]: https://dev.mysql.com/doc/refman/8.4/en/innodb-physical-structure.html
[index-types]: https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html
[ahi]: https://dev.mysql.com/doc/refman/8.4/en/innodb-adaptive-hash.html
[multi-col]: https://dev.mysql.com/doc/refman/8.4/en/multiple-column-indexes.html
[type-conv]: https://dev.mysql.com/doc/refman/8.4/en/type-conversion.html
[column-indexes]: https://dev.mysql.com/doc/refman/8.4/en/column-indexes.html
[explain-output]: https://dev.mysql.com/doc/refman/8.4/en/explain-output.html
[icp]: https://dev.mysql.com/doc/refman/8.4/en/index-condition-pushdown-optimization.html
[order-by]: https://dev.mysql.com/doc/refman/8.4/en/order-by-optimization.html
[buffer-pool]: https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool.html
[locks-set]: https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html
[consistent-read]: https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html
[locking-reads]: https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html
