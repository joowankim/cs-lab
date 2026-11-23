"""DB 없이 데이터 생성과 조건 목록을 검사한다."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fk_lab  # noqa: E402


class DataTest(unittest.TestCase):
    def test_reservations_refer_to_existing_parents(self):
        for scale in (fk_lab.SMALL, fk_lab.FULL):
            rows = fk_lab.make_reservations(scale)
            members, cars = fk_lab.make_parents(scale)
            self.assertEqual(len(rows), scale.reservations)
            self.assertEqual([row[0] for row in rows], list(range(1, scale.reservations + 1)))
            self.assertTrue(all(1 <= row[1] <= len(members) and 1 <= row[2] <= len(cars) for row in rows))

    def test_seed_is_fixed(self):
        self.assertEqual(fk_lab.make_reservations(fk_lab.SMALL), fk_lab.make_reservations(fk_lab.SMALL))

    def test_batches_divide_evenly(self):
        for scale in (fk_lab.SMALL, fk_lab.FULL):
            self.assertEqual(scale.reservations % scale.batch, 0)


class TablesTest(unittest.TestCase):
    def test_only_fk_variant_has_foreign_keys(self):
        self.assertIn("FOREIGN KEY", fk_lab.CHILD_TABLES["res_fk"])
        self.assertNotIn("FOREIGN KEY", fk_lab.CHILD_TABLES["res_nofk"])
        for sql in fk_lab.CHILD_TABLES.values():
            self.assertIn("KEY idx_member (member_id)", sql)
            self.assertIn("KEY idx_car (car_id)", sql)

    def test_auto_table_has_no_secondary_key(self):
        self.assertNotIn("KEY idx", fk_lab.AUTO_TABLE)
        self.assertIn("FOREIGN KEY", fk_lab.AUTO_TABLE)

    def test_rotate_keeps_items(self):
        for run in range(4):
            self.assertEqual(sorted(fk_lab.rotate(list(fk_lab.VARIANTS), run)), sorted(fk_lab.VARIANTS))
        self.assertEqual(fk_lab.rotate(list(fk_lab.VARIANTS), 1)[0], "res_nofk")


if __name__ == "__main__":
    unittest.main()
