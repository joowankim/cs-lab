"""직접 읽고 바꿔 볼 실행 방식과 작업자 수."""

import asyncio
from collections.abc import Awaitable, Callable
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from multiprocessing import get_context
from typing import TypeVar


T = TypeVar("T")
R = TypeVar("R")


# 여기서 비교할 방식과 작업자 수를 바꾼다. 변경 전에는 예상을 먼저 기록한다.
MODELS = ("sequential", "threads", "processes")
WORKERS = 8


def run_sequential(jobs: list[T], workers: int, job_fn: Callable[[T], R]) -> list[R]:
    # 순차 실행에서는 workers와 관계없이 하나씩 처리한다.
    return [job_fn(job) for job in jobs]


def run_threads(jobs: list[T], workers: int, job_fn: Callable[[T], R]) -> list[R]:
    with ThreadPoolExecutor(max_workers=workers) as executor:
        # list()로 모든 결과를 받은 뒤 풀을 종료한다.
        return list(executor.map(job_fn, jobs))


def run_processes(jobs: list[T], workers: int, job_fn: Callable[[T], R]) -> list[R]:
    with ProcessPoolExecutor(
        max_workers=workers,
        mp_context=get_context("spawn"),
    ) as executor:
        # 작업 하나씩 제출한다. 작업 함수는 import 가능한 모듈에 둔다.
        return list(executor.map(job_fn, jobs, chunksize=1))


def run_asyncio(jobs: list[T], workers: int, job_fn: Callable[[T], Awaitable[R]]) -> list[R]:
    async def run_all() -> list[R]:
        semaphore = asyncio.Semaphore(workers)

        async def limited_job(job: T) -> R:
            async with semaphore:
                return await job_fn(job)

        return await asyncio.gather(*(limited_job(job) for job in jobs))

    # 이벤트 루프의 생성·종료도 전체 시간에 포함한다.
    return asyncio.run(run_all())


RUNNERS = {
    "sequential": run_sequential,
    "threads": run_threads,
    "processes": run_processes,
    "asyncio": run_asyncio,
}
