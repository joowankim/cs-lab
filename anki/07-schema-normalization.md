# 07 스키마 설계와 정규화 — 복습 카드

2026-11-19~23의 실험과 문답을 바탕으로 만든 카드 28개다. MySQL 8.4.13(InnoDB)과 PyMySQL 1.2.3을 기준으로 하고, 측정값은 2026-11-20 맥 본 측정(Docker의 MySQL, 버퍼 풀 128MB, 앱과 DB가 같은 맥)에서 잰 값이다. 시간은 워밍업을 뺀 세 번의 중앙값과 최솟값~최댓값이다. 재지 않고 셈만 한 값은 "셈"으로, 실험에서 다루지 않고 자료로만 확인한 내용은 "자료"로 그 자리에 표시한다. 각 카드의 앞면·뒷면을 나중에 Anki로 옮긴다.

뒷면은 에이전트가 정리한 복습용 답이며, 사람의 독립적인 답변 기록이 아니다. 사람의 실제 예상과 답은 [실험 README의 시작 전 기록][before]과 [완료 후 학습 확인][check]에 남겼다.

우선 복습할 카드는 **07-003, 07-007, 07-009, 07-014, 07-015, 07-021, 07-027, 07-028**이다. 학습 확인에서 다시 확인할 내용으로 남긴 것들이다. 연결 테이블의 중복 막기, 엔터티를 다 찾기, 부분 함수적 종속과 이행적 함수적 종속을 가르는 기준, 잰 숫자로 답하기, 외래 키 검사가 부모 행에 거는 락의 모드를 다룬다.

공통 표(카드 07-010~07-013, 07-015, 07-017): `reservation_flat (reservation_id PK, member_email, member_name, member_plan, car_number, car_type, car_fee, started_at)`, 모든 칼럼 NOT NULL, 행은 (1, kim@a.com, kim, 일반, 12가3456, 모닝, 5000, 11-20 09:00) (2, kim@a.com, kim, 일반, 12가3456, 모닝, 5000, 11-21 09:00) (3, lee@a.com, lee, 골드, 34나5678, 아반떼, 8000, 11-20 13:00). 카드마다 이 표를 다시 적는다.

## 관계와 키

### 07-001

**앞면:** 카셰어링 요구 사항이다. 회원은 차량을 시작·끝 시각을 정해 예약하고, 회원도 차량도 여러 번 예약될 수 있다. 예약 하나에 결제가 여러 번 있을 수 있다. 엔터티와 관계 차수는 무엇이고, 1:N 관계는 테이블로 어떻게 옮기는가? 1:1이면?

**뒷면:** 엔터티(entity)는 회원·차량·예약·결제 넷이다. 관계 차수(cardinality)는 회원:예약 1:N, 차량:예약 1:N, 예약:결제 1:N이다. 1:N은 N쪽 테이블에 1쪽의 기본 키를 가리키는 외래 키를 둔다: `reservations(id PK, member_id FK, car_id FK, started_at, ended_at)`, `payments(id PK, reservation_id FK, amount)`. 1쪽에 N개의 id를 넣지 않는다. 1:1은 한쪽에 외래 키를 두고 그 칼럼에 `UNIQUE`를 걸어 한 번만 가리키게 한다(자료).

**근거:** [묶음 ①][b1], [질문 1][q1]

### 07-002

**앞면:** 예약에 다른 회원을 공동 운전자로 여러 명 더할 수 있고, 한 회원이 여러 예약의 공동 운전자가 될 수 있다. 이를 `drivers.member_ids = '3,5'`처럼 한 칸에 쉼표로 적으면 "회원 5가 공동 운전자인 예약 찾기"는 어떻게 되고 무엇이 어려운가? 어떻게 푸는가?

**뒷면:** `LIKE '%5%'`는 15·25도 걸리고, `FIND_IN_SET('5', member_ids)`는 맞게 찾지만 인덱스를 못 써서 모든 행을 읽는다. 문자열 안의 값에는 외래 키를 걸 수 없어 없는 회원 번호도 들어간다. 한 칸에 값이 여럿이면 원자값(atomic value)이 아니라 제1정규형(1NF)을 어긴다. N:M은 연결 테이블(junction table)로 푼다: `reservation_drivers(reservation_id FK, member_id FK, PRIMARY KEY (reservation_id, member_id))`. 예약 행을 운전자마다 복제하는 안은 시각·차량이 반복돼 갱신 이상이 생긴다.

**근거:** [묶음 ①][b1], [정리한 결론][conclusion]

### 07-003

**앞면:** 학생은 수업을 여러 개 듣고 한 수업에 학생이 여럿이다. 연결 테이블 `students_lectures(id PK, student_id FK, lecture_id FK)`에 같은 (학생, 수업) 짝이 두 줄 들어가는 것을 막으려 `KEY idx (student_id, lecture_id)`를 더했다. 막히는가? 수강 신청 날짜는 어느 테이블에 두는가?

**뒷면:** 막히지 않는다. 보통 인덱스(`KEY`, `INDEX`)는 찾기를 빠르게 할 뿐 같은 값을 허용한다. `UNIQUE (student_id, lecture_id)`를 걸거나, `id`를 빼고 `PRIMARY KEY (student_id, lecture_id)`인 복합 키(composite key)로 둔다. 신청 날짜는 학생·수업 짝마다 다른 값이라 `lectures`가 아니라 연결 테이블에 둔다(`registered_at`). 연결 테이블에는 두 외래 키 말고도 그 짝에 딸린 사실이 들어간다.

**근거:** [질문 1][q1], [처음 보는 문제 1][new1], [Unique Indexes][create-index]

### 07-004

**앞면:** 슈퍼키(superkey), 후보키(candidate key), 기본 키(primary key), 대체키(alternate key), 복합 키는 각각 무엇인가? `members(id, email, name, plan)`에서 id와 email이 모두 회원마다 다르면 어떻게 선언하는가?

**뒷면:** 슈퍼키는 행을 하나로 정하는 칼럼 묶음이다((id, name)도 슈퍼키). 후보키는 그중 하나라도 빼면 행을 못 정하는 최소의 묶음이다(id, email). 기본 키는 후보키 중 하나를 골라 테이블에 하나만 두고, 나머지 후보키는 대체키로 `UNIQUE`를 건다. 복합 키는 칼럼 둘 이상으로 된 키다. 그래서 `id INT PRIMARY KEY, email VARCHAR(50) NOT NULL UNIQUE`다. "email도 PK"처럼 기본 키를 둘 둘 수는 없다.

**근거:** [묶음 ①][b1], [PRIMARY KEY and UNIQUE Index Constraints][pk-unique]

### 07-005

**앞면:** 회원의 기본 키를 자연 키(natural key) `email`로 두고 예약·결제가 외래 키로 가리킨다. kim이 예약 50건·결제 80건이 있는 상태에서 이메일을 바꾸면 몇 행을 고치는가? 인조 키(surrogate key) `id`를 기본 키로 두면?

**뒷면:** 자식 130행과 회원 행까지 131행을 고친다(셈). 외래 키가 걸려 있으면 `ON UPDATE CASCADE` 없이는 부모 키 변경이 오류로 막힌다. 인조 키를 기본 키로 두면 회원 행의 `email` 한 칸만 바꾼다. 그래서 바뀔 수 있는 값(이메일, 휴대폰 번호)은 기본 키가 아니라 `UNIQUE`로 두고 기본 키는 인조 키(auto increment)로 둔다. 이메일 중복 가입을 막는 것은 `UNIQUE`로도 되므로 그것은 기본 키를 고르는 이유가 아니다.

**근거:** [질문 2][q2], [정리한 결론][conclusion]

### 07-006

**앞면:** InnoDB에서 4바이트 INT 대신 약 30바이트 `email`을 기본 키로 두면 보조 인덱스와 자식 테이블은 어떻게 되는가? auto increment 기본 키는 쓰기에 무엇이 좋은가?

**뒷면:** InnoDB 보조 인덱스의 리프는 (인덱스 칼럼, 기본 키)라 항목마다 약 26바이트씩 커지고(셈), 한 페이지에 들어가는 항목이 줄어 인덱스가 커지고 더 많은 페이지를 읽는다. 자식 테이블의 외래 키 칼럼과 그 인덱스도 같이 커진다. 이메일은 순서 없이 들어와 클러스터형 인덱스 리프 중간에 끼어든다. auto increment는 늘 가장 큰 값이라 클러스터형 인덱스의 맨 끝 리프에 붙는다.

**근거:** [묶음 ①][b1], [질문 2][q2], [Clustered and Secondary Indexes][innodb-index]

### 07-007

**앞면:** 도서관 요구 사항이다. 책은 ISBN과 제목이 있고 같은 책을 여러 권 갖추며 권마다 바코드가 있다. 회원은 실물 한 권을 빌리고 반납하며 같은 권을 여러 번 빌릴 수 있다. `books(isbn PK, title)`와 `loans(id PK, member_id FK, book_id FK, borrowed_at, returned_at)`로 두면 무엇을 알 수 없는가? 어떻게 나누는가?

**뒷면:** 대출이 책 종류(ISBN)를 가리켜 3권 중 어느 권이 대출 중인지 알 수 없다. 책 종류와 실물 권은 다른 엔터티다: `book_titles(id PK, isbn UNIQUE, title)`, `book_copies(id PK, title_id FK, barcode UNIQUE)`, `loans(id PK, member_id FK, copy_id FK, borrowed_at, returned_at)`. 대출을 `id` 기본 키로 두면 같은 권을 여러 번 빌린 기록이 따로 남는다. 요구 사항의 명사("권마다", "실물 한 권")마다 엔터티인지 따진다.

**근거:** [처음 보는 문제 1][new1]

### 07-008

**앞면:** 07-007의 도서관에서 실물 권을 `book_copies(id PK, isbn, title, barcode)` 하나로 두고 같은 책 3권이 있다. 제목 오타를 고치면 몇 행을 고치는가? 이 문제의 이름과, 어떤 정규형을 어겨서 생기는가?

**뒷면:** 3행을 함께 고쳐야 하고 하나라도 빠뜨리면 같은 책의 제목이 둘이 된다. 갱신 이상(update anomaly)이다. 기본 키가 `id` 하나라 "키의 일부"는 없고, `id → isbn → title`로 키가 아닌 칼럼(isbn)을 거쳐 정해지므로 이행적 함수적 종속이고 제3정규형(3NF) 위반이다(제2정규형이 아님). `isbn, title`을 `book_titles`로 빼고 실물 권이 그것을 가리키게 나눈다.

**근거:** [처음 보는 문제 1][new1], [질문 4][q4]

### 07-009

**앞면:** 요구 사항 "회원은 휴대폰 번호로 가입하고 이름을 가진다(번호는 바뀔 수 있다). 책 한 종에 저자 여럿, 저자도 여러 책을 쓴다."를 테이블로 옮기면? 키를 고른 이유는?

**뒷면:** `members(id PK, phone UNIQUE, name)`: 번호는 바뀔 수 있으니 기본 키가 아니라 대체키로 둔다. `authors(id PK, name)`. 책:저자는 N:M이라 연결 테이블 `book_authors(book_title_id FK, author_id FK, PRIMARY KEY (book_title_id, author_id))`로 푼다. 연결 테이블에 `id PK`만 두면 같은 짝이 두 번 들어가므로 짝에 복합 기본 키나 `UNIQUE`를 건다.

**근거:** [처음 보는 문제 1][new1], [질문 1][q1]

## 이상과 정규화

### 07-010

**앞면:** `reservation_flat(reservation_id PK, member_email, member_name, member_plan, car_number, car_type, car_fee, started_at)`에 (1, kim@a.com, kim, 일반, …) (2, kim@a.com, kim, 일반, …) (3, lee@a.com, lee, 골드, …)가 있다. kim을 골드로 올리며 `UPDATE … SET member_plan = '골드' WHERE reservation_id = 1`만 했다. kim의 등급은? 이 문제의 이름과 까닭은?

**뒷면:** `SELECT DISTINCT member_email, member_plan … WHERE member_email = 'kim@a.com'`이 `일반`·`골드` 두 줄을 돌려줬다(맥에서 확인). 갱신 이상(update anomaly)이다. 회원 등급이라는 한 사실이 예약 행마다 반복돼 있어, 사실 하나를 바꾸려면 kim의 예약 행 전부를 고쳐야 하고 하나라도 빠뜨리면 값이 갈린다.

**근거:** [묶음 ② 결과][r2], [묶음 ②][b2]

### 07-011

**앞면:** 07-010의 `reservation_flat`(기본 키 `reservation_id`, 모든 칼럼 NOT NULL)에 아직 예약이 없는 새 차 56다7890(레이, 4000원)을 넣으려 한다. `reservation_id`를 NULL로 넣으면, 빼고 넣으면 어떻게 되는가? 이 문제의 이름과 까닭은?

**뒷면:** NULL로 넣으면 `ERROR 1048 Column 'reservation_id' cannot be null`, 빼고 넣으면 `ERROR 1364 Field 'reservation_id' doesn't have a default value`였다(맥에서 확인). 삽입 이상(insertion anomaly)이다. 행 하나가 "예약"이라 기본 키가 `reservation_id`이고 기본 키는 NULL일 수 없어, 예약이 없으면 차 정보를 넣을 자리가 없다. 칼럼끼리의 순환 의존이 아니다. 나눈 뒤에는 새 차를 `cars`에만 넣을 수 있었다.

**근거:** [묶음 ② 결과][r2], [묶음 ②][b2]

### 07-012

**앞면:** 07-010의 `reservation_flat`에서 34나5678(아반떼)은 예약 3에만 나온다. `DELETE FROM reservation_flat WHERE reservation_id = 3` 뒤 34나5678의 차 정보는? 이 문제의 이름은? 주문 내역 `order_lines`에서 상품 9가 팔린 유일한 주문을 취소하는 것은 "그냥 행을 지우는 요구"인데 왜 이상인가?

**뒷면:** 34나5678 행이 0개가 되어 차종·요금까지 사라졌다(맥에서 확인). 삭제 이상(deletion anomaly)이다. 이상은 요구 자체가 아니라 그 요구를 처리할 때 원하지 않은 일이 같이 일어나는 부작용이다. 지우려던 것은 주문(예약) 하나인데, 상품 9(차)가 있다는 별개의 사실까지 함께 사라진다. 한 행에 서로 다른 사실이 섞여 있어서 생긴다.

**근거:** [묶음 ② 결과][r2], [질문 3][q3]

### 07-013

**앞면:** 함수적 종속(functional dependency)과 결정자(determinant)는 무엇인가? 07-010의 `reservation_flat`에서 `member_email`을 알면 정해지는 칼럼과 `car_number`를 알면 정해지는 칼럼은?

**뒷면:** X의 값이 같으면 Y의 값도 늘 같을 때 "Y는 X에 함수적으로 종속한다(X → Y)"고 하고 X를 결정자라 한다. `member_email → member_name, member_plan`, `car_number → car_type, car_fee`다. 그런데 이 테이블의 키는 `reservation_id`라 결정자인 `member_email`·`car_number`가 키가 아니다. 키가 아닌 결정자가 있으면 그 사실이 행마다 반복되고 07-010~012의 이상이 생긴다. 나눌 때는 결정자마다 테이블을 만든다(members, cars).

**근거:** [묶음 ②][b2], [정리한 결론][conclusion]

### 07-014

**앞면:** `enrollments(student_id, lecture_id, student_name, grade)`, 기본 키 `(student_id, lecture_id)`다. `student_name`과 `grade`는 각각 무엇에 종속하는가? 어떤 종속이 어떤 정규형을 어기고, 어떻게 고치는가?

**뒷면:** `grade`는 학생과 수업을 둘 다 알아야 정해지므로 키 전체에 종속한다. `student_name`은 `student_id`만 알면 정해지므로 키의 일부에 종속한다. 이것이 부분 함수적 종속(partial dependency)이고 제2정규형(2NF)을 어긴다. 학생 이름이 수강 행마다 반복돼 갱신 이상이 생긴다. `students(student_id PK, student_name)`로 빼면 된다. 부분 종속은 기본 키가 복합 키일 때만 생길 수 있다.

**근거:** [질문 4][q4]

### 07-015

**앞면:** 07-010의 `reservation_flat`(기본 키 `reservation_id` 하나)에서 `reservation_id → member_email → member_plan`이다. 이것은 부분 함수적 종속인가 이행적 함수적 종속인가? 어느 정규형을 어기는가? 둘을 가르는 기준은?

**뒷면:** 이행적 함수적 종속(transitive dependency)이고 제3정규형(3NF)을 어긴다. 기본 키가 칼럼 하나라 "키의 일부"가 없으므로 부분 종속일 수 없다. `member_plan`은 키가 아닌 칼럼 `member_email`을 거쳐 정해진다. 기준: 결정자가 **키의 일부**면 부분 종속(2NF), 결정자가 **키가 아닌 칼럼**이면 이행적 종속(3NF)이다. 먼저 기본 키가 몇 칼럼인지 본다.

**근거:** [질문 4][q4], [묶음 ②][b2]

### 07-016

**앞면:** 제1정규형(1NF), 제2정규형(2NF), 제3정규형(3NF), BCNF(Boyce-Codd normal form)는 각각 무엇을 없애는가? 앞의 것을 만족해야 뒤의 것인가?

**뒷면:** 1NF: 한 칸에 값 여럿(`'3,5'`)이나 반복 칼럼을 없애 모든 칸을 원자값으로 둔다. 2NF: 1NF이면서 키의 일부에 종속하는 칼럼(부분 함수적 종속)을 없앤다. 3NF: 2NF이면서 키가 아닌 칼럼을 거쳐 종속하는 칼럼(이행적 함수적 종속)을 없앤다. BCNF: 모든 결정자가 후보키여야 한다(3NF에서 키가 아닌 칼럼이 키의 일부를 결정하는 경우까지 없앰). 순서대로 앞의 것을 포함한다. 목적은 하나의 사실을 한 곳에만 두는 것이다.

**근거:** [질문 4][q4]

### 07-017

**앞면:** 07-010의 `reservation_flat`을 `members(id, email, name, plan)`, `cars(id, number, type, fee)`, `reservations(id, member_id, car_id, started_at)`로 나눴다. 원래 3행이 그대로 나오는지(무손실 분해) 어떻게 확인하는가? LEFT JOIN을 INNER JOIN으로 바꿔도 같은가?

**뒷면:** `SELECT r.id, m.email, m.name, m.plan, c.number, c.type, c.fee, r.started_at FROM reservations r JOIN members m ON m.id = r.member_id JOIN cars c ON c.id = r.car_id`로 되살리고, 원래 행과 양쪽으로 `EXCEPT`해 두 차이가 모두 0행이면 무손실 분해(lossless decomposition)다. 맥에서 3행, 차이 0행·0행이었다. INNER와 LEFT는 모든 예약의 `member_id`·`car_id`가 NOT NULL이고 외래 키로 부모가 있다고 보장될 때만 같다. 고아 행이 있으면 INNER는 그 예약을 빼고 LEFT는 NULL로 남긴다.

**근거:** [묶음 ② 결과][r2], [묶음 ②][b2], [EXCEPT Clause][except]

## 정규화와 비정규화

### 07-018

**앞면:** 회원 10만·예약 100만에서 정규화 판(`reservations_n` + `members`)과 비정규화 판(`reservations_d`에 `member_plan` 복사), 두 판 모두 `idx_member (member_id, started_at)`이다. Q1 "회원 1의 최근 예약 20건과 등급"은 어느 판이 빨랐고 왜인가?

**뒷면:** JOIN이 있는 정규화 판이 빨랐다: 0.892 [0.789~1.057] 대 3.038 [2.856~3.283]ms. 정규화 판에서 `reservations_n`이 쓰는 칼럼(id, member_id, started_at)은 모두 `idx_member` 리프에 있어(기본 키가 리프에 붙음) 테이블로 다시 가지 않는 커버링 인덱스(covering index) 조회였고, `members`는 `m.id = 1`인 상수 조회 1행이었다. 비정규화 판은 `member_plan`이 인덱스에 없어 20건마다 클러스터형 인덱스로 다시 갔다. 커버링은 O(1)이 아니라 "다시 가지 않음"이다.

**근거:** [묶음 ③ 결과][r3], [첫 해석][first], [EXPLAIN Output Format][explain]

### 07-019

**앞면:** 07-018의 비정규화 판 Q1(`WHERE member_id = 1 ORDER BY started_at DESC LIMIT 20`, `member_plan`을 읽음)을 커버링 인덱스로 만들려면 인덱스를 어떻게 두는가? `(member_id, member_plan)`은 왜 안 되는가? 바꾼 뒤 두 판의 Q1은?

**뒷면:** `(member_id, started_at, member_plan)`이다. 같은 값으로 찾고(member_id), 그 안에서 정렬된 순서로 읽고(started_at), 읽을 칼럼까지 리프에 있어야 한다. `(member_id, member_plan)`은 `started_at`이 없어 커버링이 아니고 정렬이 필요하다(맥에서 옵티마이저가 쓰지 않았고 `FORCE INDEX`로 쓰게 하면 `Using filesort`). 바꾼 뒤 1.167 [0.956~1.269] 대 1.198 [1.135~1.452]ms로 같은 수준이 됐다. 읽기가 느릴 때 비정규화보다 인덱스 모양을 먼저 본다.

**근거:** [묶음 ③ 결과][r3], [첫 해석][first]

### 07-020

**앞면:** 07-018의 두 판에서 Q2 "골드 회원의 예약 수"(정답 197,880)는 어느 판이 빨랐고, 계획은 어떻게 달랐는가?

**뒷면:** 정규화 판이 빨랐다: 49.838 [44.595~49.934] 대 122.960 [118.362~124.516]ms. 정규화 판은 `members` 10만 행을 스캔해 골드 2만 명을 고른 뒤 회원마다 `reservations_n`의 커버링 인덱스를 조회했다. 비정규화 판은 `member_plan`으로 거를 인덱스가 없어 `reservations_d` 100만 행을 테이블 스캔했다. `(member_id, started_at, member_plan)` 인덱스를 둔 뒤에도 커버링 인덱스 100만 항목을 훑어 109.648ms였다. 등급을 예약 행에 복사했다고 등급으로 거르는 읽기가 빨라지지는 않는다.

**근거:** [묶음 ③ 결과][r3]

### 07-021

**앞면:** 07-018의 두 판에서 U1 "예약 1만 건인 회원 1의 등급 변경"과 U2 "예약 10건인 회원 2의 등급 변경"은 각각 몇 행을 고치고 시간은 어땠는가? 무엇으로 비정규화를 판단하는가?

**뒷면:** U1: 정규화 1행 2.874 [2.731~20.338]ms, 비정규화 10,001행(회원 1 + 예약 1만) 41.893 [38.575~42.578]ms. U2: 정규화 1행 2.152 [1.937~2.331]ms, 비정규화 11행 2.063 [1.971~2.533]ms로 차이가 없었다(같은 정규화 판이 두 측정 사이에 1ms쯤 흔들려 1ms 안쪽 차이는 어느 쪽이 빠르다고 하지 않음). 복사본의 쓰기 비용은 복사본 수 × 원본이 바뀌는 빈도에 비례한다. 고칠 행 수가 판단 근거다.

**근거:** [묶음 ③ 결과][r3], [측정하며 본 것][seen], [질문 7][q7]

### 07-022

**앞면:** 07-021의 비정규화 판에 Q1을 위해 `idx_member_cov (member_id, started_at, member_plan)`을 두었더니 U1(회원 1의 예약 1만 행 `member_plan` 변경)이 41.893ms에서 몇 ms가 됐고, 왜인가?

**뒷면:** 74.395 [72.180~81.554]ms로 느려졌다. 앞 판에서 `member_plan`은 행(클러스터형 인덱스)에만 있어 행만 고쳤지만, 새 판에서는 보조 인덱스의 키에도 있어 1만 1행마다 인덱스 항목을 지우고 새 자리에 넣는 일이 더해진다. 계획은 `range idx_member_cov`, `Using where; Using temporary`였다(`Using temporary`의 까닭은 확인하지 않음). 복사한 칼럼을 인덱스에 넣으면 읽기는 빨라지지만 그 칼럼의 쓰기가 늘어난다.

**근거:** [묶음 ③ 결과][r3], [첫 해석][first]

### 07-023

**앞면:** `order_lines(order_id, product_id, qty, price)`에 주문할 때의 가격을 적고, `products(id, price)`에도 지금 가격이 있다. 이것은 비정규화(denormalization)인가? 회원 등급을 예약 행에 복사하는 것과 무엇이 다른가?

**뒷면:** 비정규화가 아니다. `상품 → 지금 가격`과 `주문 줄 → 그때 낸 가격`은 결정자가 다른 별개의 사실이다. 지금 가격이 바뀌어도 이미 낸 가격은 바뀌면 안 되므로 주문 줄의 칼럼이다. 회원 등급 복사는 `회원 → 등급`이라는 한 사실을 예약 행에 되풀이한 것이라 회원 등급이 바뀌면 복사본을 다 고쳐야 한다(07-021). "원본이 바뀔 때 복사본도 바뀌어야 하나"로 가른다.

**근거:** [질문 3][q3], [질문 7][q7], [정리한 결론][conclusion]

### 07-024

**앞면:** 비정규화는 언제 하는가? 하기 전에 무엇을 먼저 보는가?

**뒷면:** 먼저 인덱스 모양(커버링)으로 풀리는지 본다(07-019). 그래도 JOIN·집계를 인덱스로 못 풀고, 복사본이 적으며 원본이 드물게 바뀔 때 한다. 예: 화면 하나를 위한 조회용 테이블(원본은 정규화로 두고 따로 채움), 게시글의 댓글 수 같은 집계값 칼럼, 다른 테이블 칼럼으로 거르고 정렬해야 해 인덱스 하나로 못 풀 때, DB가 나뉘어 JOIN을 못 할 때. 대가는 복사본을 맞추는 쓰기(07-021의 10,001행)와 어긋날 위험이다.

**근거:** [질문 7][q7], [정리한 결론][conclusion]

## 외래 키

### 07-025

**앞면:** 예약이 있는 회원 kim을 `DELETE FROM members WHERE id = 1`로 지운다. `reservations.member_id`에 외래 키가 없을 때, 기본값의 외래 키일 때, `ON DELETE CASCADE`일 때 각각 어떻게 되는가? 외래 키가 지키는 것의 이름은?

**뒷면:** 외래 키가 없으면 회원만 지워지고 예약은 없는 회원을 가리키는 고아 행으로 남는다. 기본값(`RESTRICT`/`NO ACTION`)이면 DELETE가 `ERROR 1451 Cannot delete or update a parent row`로 막힌다. `ON DELETE CASCADE`면 kim의 예약도 함께 지워진다. 외래 키(foreign key)가 지키는 것은 참조 무결성(referential integrity)이다: 자식이 가리키는 부모가 늘 있다(자료).

**근거:** [묶음 ②][b2], [FOREIGN KEY Constraints][fk]

### 07-026

**앞면:** 보조 인덱스 없이 `FOREIGN KEY (member_id) REFERENCES members(id)`, `FOREIGN KEY (car_id) REFERENCES cars(id)`만 건 `reservations_auto`의 `SHOW INDEX`에는 무엇이 나오는가? 외래 키 칼럼에 인덱스가 필요한 까닭은? 예약 100만 행에 인덱스가 없으면?

**뒷면:** InnoDB가 `KEY member_id (member_id)`, `KEY car_id (car_id)`를 자동으로 만들었다(이름은 칼럼 이름, 제약 이름은 `reservations_auto_ibfk_1`·`_2`). 부모를 지우거나 키를 바꿀 때 CASCADE가 없어도 "이 부모를 가리키는 자식이 있나"를 확인해야 하는데, 인덱스가 없으면 자식 100만 행을 모두 읽어야 한다. 인덱스가 있으면 정렬된 인덱스에서 그 값이 있는 곳만 본다. 자식 INSERT의 검사는 부모 기본 키로 한다.

**근거:** [묶음 ④ 결과][r4], [질문 5][q5], [FOREIGN KEY Constraints][fk]

### 07-027

**앞면:** 같은 인덱스(`idx_member`, `idx_car`)를 둔 외래 키 있음/없음 테이블에 예약 10만 건을 1000건마다 COMMIT하며 넣었다. 시간은 얼마였고 몇 % 차이인가? 이 차이를 외래 키 검사 몫으로만 볼 수 있는가?

**뒷면:** 외래 키 있음 1.292 [1.289~1.308]초(초당 77,391행), 없음 1.132 [1.103~1.200]초(초당 88,350행)로 약 14% 느렸다(셈, 1.292 / 1.132). 행마다 부모 `members`·`cars`의 기본 키를 찾아 확인하고 락을 건다. 다만 두 시간 모두 COMMIT 100번의 디스크 동기화(`innodb_flush_log_at_trx_commit=1`)를 포함해 외래 키 검사 몫만 뗀 값이 아니고, 부모 테이블이 버퍼 풀에 없을 때는 재지 않았다. 3회 모두 행 100,000, 고아 행 0이었다.

**근거:** [묶음 ④ 결과][r4], [측정하며 본 것][seen], [질문 6][q6]

### 07-028

**앞면:** 외래 키가 있는 `res_fk`에 A가 회원 1·차 1의 예약을 INSERT하고 커밋하기 전, B가 `UPDATE members SET plan = '골드' WHERE id = 1`을 한다. `performance_schema.data_locks`에서 A와 B의 락은? B는 어떻게 되는가? 외래 키가 없으면?

**뒷면:** A는 `res_fk` 테이블 IX, `members`·`cars` 테이블 IS, 그리고 `members` id 1과 `cars` id 1에 레코드 락(record lock)을 S 모드(`S,REC_NOT_GAP`)로 가졌다. 외래 키 검사가 확인한 부모가 커밋 전에 지워지지 않게 커밋까지 쥔다. B는 같은 `members` id 1 레코드 락을 X 모드로 원해(`X,REC_NOT_GAP`, WAITING) 기다렸고 3.018초 뒤 `ERROR 1205`였다. 3초는 `innodb_lock_wait_timeout`으로 둔 한도라 실제 대기는 A의 트랜잭션 길이에 달린다. 외래 키와 상관없는 `plan`을 바꿔도 락이 행 단위라 막힌다. 격리 수준과도 상관없다. 외래 키가 없으면 A는 `res_nofk` IX 하나뿐이었고 B는 0.00146초에 1행을 고쳤다. 레코드·갭·넥스트 키·삽입 의도 락은 락의 종류, S(공유, shared)·X(배타, exclusive)는 모드다.

**근거:** [묶음 ④ 결과][r4], [첫 해석][first], [질문 6][q6], [Locks Set by Different SQL Statements][locks-set], [InnoDB Locking][innodb-locking]

[before]: ../experiments/07-schema-normalization/README.md#시작-전-기록
[check]: ../experiments/07-schema-normalization/README.md#완료-후-학습-확인
[b1]: ../experiments/07-schema-normalization/README.md#묶음--요구-사항을-테이블로-2026-11-19
[b2]: ../experiments/07-schema-normalization/README.md#묶음--한-테이블에-몰아넣은-예약-2026-11-19
[r2]: ../experiments/07-schema-normalization/README.md#묶음--이상과-무손실-분해-2026-11-20-한-번-실행
[r3]: ../experiments/07-schema-normalization/README.md#묶음--정규화-대-비정규화-조건마다-3회-ms-중앙값-최솟값최댓값
[r4]: ../experiments/07-schema-normalization/README.md#묶음--외래-키
[seen]: ../experiments/07-schema-normalization/README.md#측정하며-본-것
[first]: ../experiments/07-schema-normalization/README.md#첫-해석
[q1]: ../experiments/07-schema-normalization/README.md#질문-1-nm과-연결-테이블
[q2]: ../experiments/07-schema-normalization/README.md#질문-2-자연-키와-인조-키
[q3]: ../experiments/07-schema-normalization/README.md#질문-3-삽입갱신삭제-이상
[q4]: ../experiments/07-schema-normalization/README.md#질문-4-함수적-종속과-정규형
[q5]: ../experiments/07-schema-normalization/README.md#질문-5-외래-키-칼럼의-인덱스
[q6]: ../experiments/07-schema-normalization/README.md#질문-6-외래-키를-거나
[q7]: ../experiments/07-schema-normalization/README.md#질문-7-비정규화는-언제
[new1]: ../experiments/07-schema-normalization/README.md#처음-보는-문제-1-목표-1-도서관
[conclusion]: ../experiments/07-schema-normalization/README.md#정리한-결론과-선택-기준
[create-index]: https://dev.mysql.com/doc/refman/8.4/en/create-index.html
[pk-unique]: https://dev.mysql.com/doc/refman/8.4/en/constraint-primary-key.html
[innodb-index]: https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html
[except]: https://dev.mysql.com/doc/refman/8.4/en/except.html
[explain]: https://dev.mysql.com/doc/refman/8.4/en/explain-output.html
[fk]: https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html
[locks-set]: https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html
[innodb-locking]: https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html
