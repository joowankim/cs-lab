"""모든 실행 방식이 공유하는 작업 입력과 검증 함수."""

import asyncio
from dataclasses import dataclass
from math import isqrt
import sys
import time


@dataclass(frozen=True)
class Job:
    task: str
    expected_gil: bool
    n: int = 0
    sleep_s: float = 0.0


def count_primes(n: int) -> int:
    """2부터 n까지 각 수를 시험 나눗셈으로 검사한다."""
    count = 0
    for candidate in range(2, n + 1):
        for divisor in range(2, isqrt(candidate) + 1):
            if candidate % divisor == 0:
                break
        else:
            count += 1
    return count


def reference_count(n: int) -> int:
    """정답은 별도 알고리즘인 에라토스테네스의 체로 구한다. 측정에는 쓰지 않는다."""
    if n < 2:
        return 0
    prime = bytearray(b"\x01") * (n + 1)
    prime[:2] = b"\x00\x00"
    for divisor in range(2, isqrt(n) + 1):
        if prime[divisor]:
            start = divisor * divisor
            prime[start::divisor] = b"\x00" * ((n - start) // divisor + 1)
    return sum(prime)


def require_gil(expected: bool) -> bool:
    actual = sys._is_gil_enabled()
    if actual != expected:
        raise RuntimeError(f"GIL 상태 불일치: expected={expected}, actual={actual}")
    return actual


def run_job(job: Job) -> int:
    """프로세스 작업자에서도 같은 함수와 GIL 확인을 사용한다."""
    require_gil(job.expected_gil)
    if job.task == "cpu":
        return count_primes(job.n)
    if job.task == "io":
        time.sleep(job.sleep_s)
        return 1
    raise ValueError(f"알 수 없는 작업: {job.task}")


async def run_async_job(job: Job) -> int:
    if job.task == "io":
        require_gil(job.expected_gil)
        await asyncio.sleep(job.sleep_s)
        return 1
    # CPU 작업은 이벤트 루프 안에서 직접 계산한다.
    return run_job(job)
