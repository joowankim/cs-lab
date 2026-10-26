"""문제 상황 3의 로더 계산과 기다리는 방법 세 가지."""

import threading
import time

# (가)에서 깃발을 다시 확인하기 전에 쉬는 시간이다.
POLL_S = 0.01


class Ready:
    """로더가 준비를 알리는 자리다. 문제 상황 3의 ready 변수와 (나)의 Event를 함께 둔다."""

    def __init__(self):
        self.flag = False
        self.event = threading.Event()

    def set(self) -> None:
        # pass·sleep은 flag만, event는 event만 본다.
        self.flag = True
        self.event.set()


def build_index(n: int) -> int:
    # 순수 Python 계산이다. 실행 틀이 혼자 돌 때 약 1초가 되도록 n을 맞춘다.
    total = 0
    for i in range(n):
        total += i * i % 7
    return total


def wait_pass(ready: Ready) -> None:
    # 문제 상황 3의 코드다. 깃발이 바뀔 때까지 쉬지 않고 확인한다.
    while not ready.flag:
        pass


def wait_sleep(ready: Ready) -> None:
    # (가) 확인 사이에 POLL_S초 쉰다. 쉬는 동안은 GIL을 내놓는다.
    while not ready.flag:
        time.sleep(POLL_S)


def wait_event(ready: Ready) -> None:
    # (나) set()이 불릴 때까지 블록된다.
    ready.event.wait()


WAITS = {"pass": wait_pass, "sleep": wait_sleep, "event": wait_event}
