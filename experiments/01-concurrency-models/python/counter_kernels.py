"""진행 단계에서 공유 락을 직접 적용할 카운터 함수."""

from dataclasses import dataclass
from threading import Lock
import time


@dataclass
class Counter:
    completed: int = 0


def increment_unlocked(counter: Counter, lock: Lock, yield_between: bool) -> None:
    previous = counter.completed
    if yield_between:
        time.sleep(0)
    counter.completed = previous + 1


def increment_candidate(counter: Counter, lock: Lock, yield_between: bool) -> None:
    # 공유 락으로 읽기부터 갱신까지 전체 구간을 보호한다.
    with lock:
        increment_unlocked(counter, lock, yield_between)


UPDATERS = {"unlocked": increment_unlocked, "candidate": increment_candidate}
