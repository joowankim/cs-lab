"""이벤트 루프에서 실행할 A 작업과 사람이 수정할 대기 함수."""

from dataclasses import dataclass
import time
import asyncio

from workloads import count_primes


@dataclass(frozen=True)
class LoopWork:
    sleep_s: float = 1.0
    n: int = 200_000
    cpu_jobs: int = 8


async def blocking_wait(work: LoopWork) -> int:
    time.sleep(work.sleep_s)
    return 1


async def candidate_wait(work: LoopWork) -> int:
    # 대기 중에는 이벤트 루프가 다른 준비된 Task를 실행할 수 있다.
    await asyncio.sleep(work.sleep_s)
    return 1


async def compute(work: LoopWork) -> int:
    # 계산 중 await가 없다. 앞선 CPU 비교와 같은 입력·알고리즘을 쓴다.
    return sum(count_primes(work.n) for _ in range(work.cpu_jobs))


ACTIONS = {"idle": None, "blocking": blocking_wait, "candidate": candidate_wait, "cpu": compute}
