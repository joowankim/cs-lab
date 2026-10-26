"""문제 상황 4의 이체와 문제 상황 5의 식사하는 철학자, 그리고 고친 코드."""

import random
import threading
import time

# 문제 상황 4: DB에서 이체 한도를 확인하는 데 걸리는 시간이다.
DB_S = 0.001
# 내려놓고 다시: 받는 계좌를 잡지 못하면 0~BACKOFF_S초 사이에서 무작위로 쉰다.
BACKOFF_S = 0.001
DAILY_LIMIT = 10**9
# 문제 상황 5: 생각하는 시간은 0~THINK_S초에서 무작위로 고르고, 첫 포크를 집고 PICK_S초 뒤 둘째 포크를 집는다.
PHILOSOPHERS = 5
THINK_S = 0.002
PICK_S = 0.001
EAT_S = 0.001


class Account:
    def __init__(self, name: str, balance: int):
        self.name = name
        self.balance = balance
        self.lock = threading.Lock()


def check_limit_db(src: Account, amount: int) -> None:
    # 문제 상황 4의 check_limit()이다. DB 조회는 DB_S초 쉬는 것으로 대신한다.
    time.sleep(DB_S)


def check_limit_memory(src: Account, amount: int) -> None:
    # 2·3번: 한도를 메모리에서 확인한다. 락 안에 I/O가 없다.
    if amount > DAILY_LIMIT:
        raise ValueError("이체 한도 초과")


def transfer_opposite(src: Account, dst: Account, amount: int, check_limit) -> int:
    # 문제 상황 4의 transfer()다. 보내는 계좌부터 잠그므로 반대 방향 이체끼리 반대 순서로 잡는다.
    with src.lock:
        check_limit(src, amount)
        with dst.lock:
            src.balance -= amount
            dst.balance += amount
    # 다시 시도한 횟수다. 실행 틀이 세 판을 같은 방식으로 부르려고 돌려준다.
    return 0


def transfer_ordered(src: Account, dst: Account, amount: int, check_limit) -> int:
    # 락 순서 고정. 모든 스레드가 계좌 이름 순서로 잡고, 한도 확인은 두 락을 잡은 뒤에 한다.
    first, second = sorted((src, dst), key=lambda acc: acc.name)
    with first.lock:
        with second.lock:
            check_limit(src, amount)
            src.balance -= amount
            dst.balance += amount
    return 0


def transfer_retry(src: Account, dst: Account, amount: int, check_limit) -> int:
    # 내려놓고 다시. 받는 계좌를 바로 잡지 못하면 쥔 락도 풀고 무작위로 쉬었다가 처음부터 다시 한다.
    retries = 0
    while True:
        src.lock.acquire()
        if dst.lock.acquire(blocking=False):
            break
        src.lock.release()
        retries += 1
        time.sleep(random.uniform(0, BACKOFF_S))
    try:
        check_limit(src, amount)
        src.balance -= amount
        dst.balance += amount
    finally:
        dst.lock.release()
        src.lock.release()
    return retries


TRANSFERS = {"opposite": transfer_opposite, "ordered": transfer_ordered, "retry": transfer_retry}
CHECKS = {"db": check_limit_db, "memory": check_limit_memory}


def pick_left_first(forks: list, i: int) -> tuple:
    # 문제 상황 5. 모두 왼쪽 포크부터 집는다.
    return forks[i], forks[(i + 1) % len(forks)]


def pick_larger_first(forks: list, i: int) -> tuple:
    # 사람이 고친 코드. 모두 번호가 큰 포크부터 집는다.
    indices = [i, (i + 1) % len(forks)]
    return forks[max(indices)], forks[min(indices)]


PICKS = {"left": pick_left_first, "larger": pick_larger_first}


def philosopher(forks: list, i: int, pick, meals: int, eaten: list[int], waiter=None) -> None:
    # 문제 상황 5의 philosopher()다. waiter가 있으면 자리를 받은 뒤에 포크를 집는다.
    first, second = pick(forks, i)
    for _ in range(meals):
        time.sleep(random.uniform(0, THINK_S))   # 생각한다
        if waiter is not None:
            waiter.acquire()
        try:
            with first:                          # 첫 포크를 집는다
                time.sleep(PICK_S)               # 포크를 집는 데 1ms
                with second:                     # 둘째 포크를 집는다
                    time.sleep(EAT_S)            # 먹는다
        finally:
            if waiter is not None:
                waiter.release()
        # 철학자마다 자기 칸만 바꾸므로 따로 잠그지 않는다.
        eaten[i] += 1
