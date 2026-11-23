-- 07 묶음 ②: 한 표(reservation_flat)에 모두 넣었을 때 생기는 갱신·삽입·삭제 이상을 재현한다.
DROP DATABASE IF EXISTS lab7;
CREATE DATABASE lab7;
USE lab7;

CREATE TABLE reservation_flat (
  reservation_id INT PRIMARY KEY,
  member_email VARCHAR(50) NOT NULL,
  member_name VARCHAR(20) NOT NULL,
  member_plan VARCHAR(10) NOT NULL,
  car_number VARCHAR(20) NOT NULL,
  car_type VARCHAR(20) NOT NULL,
  car_fee INT NOT NULL,
  started_at DATETIME NOT NULL
);

INSERT INTO reservation_flat VALUES
  (1, 'kim@a.com', 'kim', '일반', '12가3456', '모닝', 5000, '2026-11-20 09:00'),
  (2, 'kim@a.com', 'kim', '일반', '12가3456', '모닝', 5000, '2026-11-21 09:00'),
  (3, 'lee@a.com', 'lee', '골드', '34나5678', '아반떼', 8000, '2026-11-20 13:00');

-- 시작 상태를 보존한다(02에서 무손실 비교에 쓴다).
CREATE TABLE flat_original AS SELECT * FROM reservation_flat;

-- (A) 갱신 이상: 한 행만 고치면 같은 회원의 등급이 두 값으로 갈린다.
SELECT '(A) update anomaly' AS step;
UPDATE reservation_flat SET member_plan = '골드' WHERE reservation_id = 1;
SELECT DISTINCT member_email, member_plan FROM reservation_flat WHERE member_email = 'kim@a.com';

-- (B) 삽입 이상: 예약 없이 차만 넣을 수 없다. 아래 두 문장은 오류가 나야 한다(--force로 계속 진행).
SELECT '(B) insert anomaly' AS step;
INSERT INTO reservation_flat VALUES
  (NULL, '', '', '', '56다7890', '레이', 4000, '2026-11-20 00:00');
INSERT INTO reservation_flat (member_email, member_name, member_plan, car_number, car_type, car_fee, started_at)
  VALUES ('', '', '', '56다7890', '레이', 4000, '2026-11-20 00:00');
SELECT COUNT(*) AS ray_rows FROM reservation_flat WHERE car_number = '56다7890';

-- (C) 삭제 이상: 차의 유일한 예약을 지우면 차 정보도 사라진다.
SELECT '(C) delete anomaly' AS step;
DELETE FROM reservation_flat WHERE reservation_id = 3;
SELECT COUNT(*) FROM reservation_flat WHERE car_number = '34나5678';
