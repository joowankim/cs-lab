"""GIL 비교에서 서로 다른 실행 조건이 집계에 섞이지 않는지 확인한다."""

from contextlib import redirect_stderr
from io import StringIO
import unittest

from compare_gil import print_comparison_summary


class GilSummaryTests(unittest.TestCase):
    def test_runtime_and_gil_conditions_are_separate(self):
        rows = [
            {"runtime": runtime, "variant": variant, "task": "cpu", "size": 8,
             "params": {"n": 100}, "model": "threads", "workers": 4,
             "run": run, "wall_s": value, "valid": True}
            for runtime, variant, run, value in [
                ("cpython-3.14.2t", "gil=off", 0, 100),
                ("cpython-3.14.2t", "gil=off", 1, 1),
                ("cpython-3.14.2t", "gil=off", 2, 3),
                ("cpython-3.14.2t", "gil=on", 1, 6),
                ("cpython-3.14.2t", "gil=on", 2, 10),
                ("cpython-3.14.2", "gil=on", 1, 16),
            ]
        ]
        output = StringIO()
        with redirect_stderr(output):
            print_comparison_summary(rows)
        lines = output.getvalue().splitlines()
        self.assertEqual([line for line in lines if line.startswith("cpython-")], [
            "cpython-3.14.2 gil=on", "cpython-3.14.2t gil=off", "cpython-3.14.2t gil=on",
        ])
        data = [line.split() for line in lines if line.startswith("cpu ")]
        self.assertEqual([row[5] for row in data], ["16.000000", "2.000000", "8.000000"])


if __name__ == "__main__":
    unittest.main()
