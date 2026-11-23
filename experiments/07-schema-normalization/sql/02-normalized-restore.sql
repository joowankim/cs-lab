-- 07 묶음 ②: 회원·차·예약으로 나눈 뒤 조인으로 원래 표를 되살릴 수 있는지(무손실) 확인한다.
-- 01-flat-anomalies.sql을 먼저 실행해 lab7.flat_original이 있어야 한다.
USE lab7;
DROP TABLE IF EXISTS reservations, members, cars;

CREATE TABLE members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(20) NOT NULL,
  plan VARCHAR(10) NOT NULL
);
CREATE TABLE cars (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(20) NOT NULL UNIQUE,
  type VARCHAR(20) NOT NULL,
  fee INT NOT NULL
);
CREATE TABLE reservations (
  id INT PRIMARY KEY,
  member_id INT NOT NULL,
  car_id INT NOT NULL,
  started_at DATETIME NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id),
  FOREIGN KEY (car_id) REFERENCES cars(id)
);

INSERT INTO members (id, email, name, plan) VALUES
  (1, 'kim@a.com', 'kim', '일반'),
  (2, 'lee@a.com', 'lee', '골드');
INSERT INTO cars (id, number, type, fee) VALUES
  (1, '12가3456', '모닝', 5000),
  (2, '34나5678', '아반떼', 8000);
INSERT INTO reservations (id, member_id, car_id, started_at) VALUES
  (1, 1, 1, '2026-11-20 09:00'),
  (2, 1, 1, '2026-11-21 09:00'),
  (3, 2, 2, '2026-11-20 13:00');

-- 사용자가 쓴 복원 쿼리(별칭 c만 고침)
SELECT '(D) restore join' AS step;
SELECT r.id, m.email, m.name, m.plan, c.number, c.type, c.fee, r.started_at
FROM (reservations r LEFT JOIN members m ON r.member_id = m.id)
     LEFT JOIN cars c ON r.car_id = c.id;

-- 양쪽 방향 EXCEPT: 둘 다 0이면 무손실
SELECT '(E) lossless check' AS step;
SELECT COUNT(*) AS restored_minus_original FROM (
  SELECT r.id, m.email, m.name, m.plan, c.number, c.type, c.fee, r.started_at
  FROM (reservations r LEFT JOIN members m ON r.member_id = m.id)
       LEFT JOIN cars c ON r.car_id = c.id
  EXCEPT
  SELECT * FROM flat_original
) d;
SELECT COUNT(*) AS original_minus_restored FROM (
  SELECT * FROM flat_original
  EXCEPT
  SELECT r.id, m.email, m.name, m.plan, c.number, c.type, c.fee, r.started_at
  FROM (reservations r LEFT JOIN members m ON r.member_id = m.id)
       LEFT JOIN cars c ON r.car_id = c.id
) d;

-- 예약 없이 차만 넣기
SELECT '(F) insert car only' AS step;
INSERT INTO cars (number, type, fee) VALUES ('56다7890', '레이', 4000);
SELECT * FROM cars;
SELECT COUNT(*) AS restore_rows FROM (
  SELECT r.id, m.email, m.name, m.plan, c.number, c.type, c.fee, r.started_at
  FROM (reservations r LEFT JOIN members m ON r.member_id = m.id)
       LEFT JOIN cars c ON r.car_id = c.id
) t;
