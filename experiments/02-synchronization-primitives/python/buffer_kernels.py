"""문제 상황 2의 버퍼와 take(), 그리고 고친 take()."""

from collections import deque

# 버퍼에 들어갈 수 있는 작업 수다.
CAPACITY = 5
WAKES = ("notify", "notify_all")


class Buffer:
    """문제 상황 2의 jobs와 cond를 시행마다 새로 묶는다. 깨우기는 put()과 take()가 같은 것을 쓴다."""

    def __init__(self, jobs: deque, cond, wake: str):
        if wake not in WAKES:
            raise ValueError(f"알 수 없는 깨우기 방법: {wake}")
        self.jobs = jobs
        self.cond = cond
        # cond.notify 또는 cond.notify_all이다.
        self.wake = getattr(cond, wake)


def put(buf: Buffer, job) -> None:
    # 문제 상황 2의 put()이다. 가득 차 있으면 깨어날 때마다 다시 확인하며 기다린다.
    with buf.cond:
        while len(buf.jobs) >= CAPACITY:
            buf.cond.wait()
        buf.jobs.append(job)
        buf.wake()


def take_if(buf: Buffer):
    # 문제 상황 2의 take()다. 깨어난 뒤 jobs를 다시 확인하지 않는다.
    with buf.cond:
        if not buf.jobs:
            buf.cond.wait()
        job = buf.jobs.popleft()
        buf.wake()
        return job


def take_while(buf: Buffer):
    # 고친 take()다. 깨어날 때마다 jobs를 다시 확인하고, 비어 있으면 또 기다린다.
    with buf.cond:
        while not buf.jobs:
            buf.cond.wait()
        job = buf.jobs.popleft()
        buf.wake()
        return job


TAKES = {"if": take_if, "while": take_while}
