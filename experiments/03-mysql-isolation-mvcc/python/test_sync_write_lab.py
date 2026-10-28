"""덮어쓰기·이어 쓰기 동기 쓰기 측정이 명령을 바르게 만들고 dd 보고를 읽는지 확인한다. DB 없이 돈다."""

import unittest

from sync_write_lab import BLOCK_BYTES, MODES, dd_bytes, mode_commands

# 맥의 MySQL 8.4.13 볼륨에서 dd가 돌려준 보고(durability_lab.py 환경 파일)
DD_OUTPUT = "500+0 records in\n500+0 records out\n4096000 bytes (4.1 MB, 3.9 MiB) copied, 0.306153 s, 13.4 MB/s"


class CommandTest(unittest.TestCase):
    def test_append_writes_a_new_file(self):
        prepare, measure = mode_commands("/var/lib/mysql", "append", 500)
        self.assertEqual(prepare, "rm -f /var/lib/mysql/sync-write-append")
        self.assertIn("oflag=dsync", measure)
        self.assertNotIn("notrunc", measure)

    def test_overwrite_keeps_the_prepared_file(self):
        # 덮어쓰기는 같은 크기의 파일을 먼저 디스크에 내려 두고, 자르지 않고(notrunc) 처음부터 다시 쓴다.
        prepare, measure = mode_commands("/data", "overwrite", 500)
        self.assertIn("count=500 conv=fsync", prepare)
        self.assertIn("oflag=dsync conv=notrunc", measure)
        self.assertIn("count=500", measure)

    def test_modes_write_the_same_amount(self):
        for mode in MODES:
            self.assertIn("bs=8k count=500", mode_commands("/data", mode, 500)[1])
        self.assertEqual(BLOCK_BYTES, 8 * 1024)

    def test_unknown_mode_fails(self):
        with self.assertRaises(ValueError):
            mode_commands("/data", "truncate", 500)


class ReportTest(unittest.TestCase):
    def test_reads_written_bytes(self):
        self.assertEqual(dd_bytes(DD_OUTPUT), 500 * BLOCK_BYTES)

    def test_missing_report_fails(self):
        with self.assertRaises(ValueError):
            dd_bytes("dd: failed to open")


if __name__ == "__main__":
    unittest.main()
