"""멈춤 판단·멈춘 줄 기록·실행 오류를 구분해 기록하는지 검증한다."""

from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
import tempfile
import threading
import unittest

from deadlock_kernels import CHECKS, PHILOSOPHERS, PICKS, TRANSFERS, Account, check_limit_memory, philosopher
from deadlock_lab import print_deadlock_summary, run_in_child, run_philosopher_trial, run_transfer_trial


def forced_opposite(both_hold):
    # 실행 틀 검증용 기준 함수다. 두 스레드가 각자 첫 락을 쥔 뒤에야 둘째 락으로 가므로 첫 이체에서 반드시 멈춘다.
    def transfer(src, dst, amount, check_limit):
        with src.lock:
            both_hold.wait(timeout=5)
            with dst.lock:
                src.balance -= amount
                dst.balance += amount
        return 0

    return transfer


def forced_dine(all_hold):
    # 실행 틀 검증용 기준 함수다. 다섯 명이 모두 첫 포크를 쥔 뒤에야 둘째 포크로 가므로 첫 식사에서 반드시 멈춘다.
    def dine(forks, i, pick, meals, eaten, waiter=None):
        first, second = pick(forks, i)
        for _ in range(meals):
            with first:
                all_hold.wait(timeout=5)
                with second:
                    pass
            eaten[i] += 1

    return dine


class DeadlockLabTests(unittest.TestCase):
    def test_each_transfer_keeps_balances_in_one_thread(self):
        for name, transfer in TRANSFERS.items():
            for check in CHECKS:
                with self.subTest(transfer=name, check=check):
                    a, b = Account("A", 100), Account("B", 100)
                    retries = sum(transfer(a, b, 1, CHECKS[check]) for _ in range(5))
                    retries += sum(transfer(b, a, 1, CHECKS[check]) for _ in range(3))
                    self.assertEqual((a.balance, b.balance, retries), (98, 102, 0))
                    self.assertFalse(a.lock.locked() or b.lock.locked())

    def test_fixed_transfers_finish_with_two_threads(self):
        for name, check, per_thread in [("ordered", "memory", 2000), ("retry", "memory", 2000),
                                        ("ordered", "db", 20), ("retry", "db", 20)]:
            with self.subTest(transfer=name, check=check):
                row = run_transfer_trial(TRANSFERS[name], CHECKS[check], per_thread, hang_s=10)
                self.assertTrue(row["valid"])
                self.assertFalse(row["hung"])
                self.assertEqual(row["done"], {"a_to_b": per_thread, "b_to_a": per_thread})
                self.assertTrue(row["sum_ok"])
                self.assertGreater(row["elapsed_s"], 0)
                self.assertIsNone(row["stack_file"])

    def test_forced_deadlock_is_recorded_as_hung_with_stacks(self):
        with tempfile.TemporaryDirectory() as directory:
            stack_path = Path(directory) / "transfer.txt"
            row = run_transfer_trial(forced_opposite(threading.Barrier(2)), check_limit_memory, 5,
                                     hang_s=0.3, stack_path=stack_path)
            self.assertTrue(row["valid"])
            self.assertTrue(row["hung"])
            self.assertIsNone(row["elapsed_s"])
            self.assertEqual((row["done"], row["done_total"]), ({"a_to_b": 0, "b_to_a": 0}, 0))
            self.assertIsNone(row["sum_ok"])
            self.assertEqual(row["stack_file"], "transfer.txt")
            # 두 스레드가 모두 기준 함수의 둘째 락에서 멈춘 줄이 남는다.
            self.assertEqual(stack_path.read_text(encoding="utf-8").count(" in transfer"), 2)

    def test_thread_error_marks_the_trial_invalid(self):
        def unfinished(src, dst, amount, check_limit):
            raise NotImplementedError("작성 중")

        row = run_transfer_trial(unfinished, check_limit_memory, 3, hang_s=5)
        self.assertFalse(row["valid"])
        self.assertFalse(row["hung"])
        self.assertEqual(sorted(row["errors"]), ["a_to_b: NotImplementedError: 작성 중",
                                                 "b_to_a: NotImplementedError: 작성 중"])

    def test_wrong_balance_marks_the_trial_invalid(self):
        def leaking(src, dst, amount, check_limit):
            with src.lock:
                src.balance -= amount
            return 0

        row = run_transfer_trial(leaking, check_limit_memory, 3, hang_s=5)
        self.assertFalse(row["valid"])
        self.assertFalse(row["sum_ok"])

    def test_fixed_philosophers_eat_every_meal(self):
        for pick, waiter in [("larger", 0), ("left", PHILOSOPHERS - 1)]:
            with self.subTest(pick=pick, waiter=waiter):
                row = run_philosopher_trial(philosopher, PICKS[pick], waiter, 5, hang_s=10)
                self.assertTrue(row["valid"])
                self.assertFalse(row["hung"])
                self.assertEqual(row["eaten"], [5] * PHILOSOPHERS)

    def test_forced_philosopher_deadlock_is_recorded_as_hung(self):
        row = run_philosopher_trial(forced_dine(threading.Barrier(PHILOSOPHERS)), PICKS["left"], 0, 3, hang_s=0.3)
        self.assertTrue(row["valid"])
        self.assertTrue(row["hung"])
        self.assertEqual((row["eaten"], row["eaten_total"]), ([0] * PHILOSOPHERS, 0))

    def test_child_process_returns_one_row(self):
        transfer = run_in_child({"task": "transfer", "transfer": "ordered", "check": "memory",
                                 "per_thread": 100, "hang_s": 10, "stack_path": None})
        self.assertTrue(transfer["valid"])
        self.assertEqual(transfer["done_total"], 200)
        self.assertTrue(transfer["gil_enabled"])
        dining = run_in_child({"task": "philosophers", "pick": "larger", "waiter": 0,
                               "meals": 3, "hang_s": 10, "stack_path": None})
        self.assertTrue(dining["valid"])
        self.assertEqual(dining["eaten_total"], 3 * PHILOSOPHERS)

    def test_child_failure_is_an_invalid_row(self):
        row = run_in_child({"task": "transfer", "transfer": "missing", "check": "memory",
                            "per_thread": 1, "hang_s": 1, "stack_path": None})
        self.assertFalse(row["valid"])
        self.assertIn("KeyError", row["child_error"])

    def test_summary_excludes_warmup(self):
        def transfer(case, run, hung, done_total=0, elapsed_s=None, retries=0):
            return {"task": "transfer", "case": case, "run": run, "hung": hung, "done_total": done_total,
                    "elapsed_s": elapsed_s, "retries": retries, "cpu_s": 0.001}

        rows = [transfer(1, 0, False, elapsed_s=0.5), transfer(1, 1, True), transfer(1, 2, True, done_total=3),
                transfer(1, 3, True), transfer(5, 0, True, done_total=7), transfer(5, 1, False, elapsed_s=2.0, retries=10),
                transfer(5, 2, False, elapsed_s=2.4, retries=30)]
        output = StringIO()
        with redirect_stderr(output):
            print_deadlock_summary(rows)
        lines = output.getvalue().splitlines()
        self.assertEqual(lines[1].split(),
                         ["transfer", "1", "3", "3", "2", "0", "[0~3]", "-", "-", "0.001"])
        self.assertEqual(lines[2].split(),
                         ["transfer", "5", "2", "0", "0", "-", "2200.00", "[2000.00~2400.00]", "20", "-"])
        self.assertEqual(len(lines), 3)


if __name__ == "__main__":
    unittest.main()
