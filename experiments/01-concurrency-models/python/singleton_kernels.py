"""진행 단계에서 공유 락을 적용할 지연 초기화 함수."""

from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock


@dataclass
class SingletonState:
    instance: object | None = None


def get_unlocked(state: SingletonState, lock: Lock, factory: Callable[[], object]) -> object:
    if state.instance is None:
        state.instance = factory()
    return state.instance


def get_candidate(state: SingletonState, lock: Lock, factory: Callable[[], object]) -> object:
    # 진행 단계에서 이 함수에 공유 lock을 적용한다. 현재는 락 없는 기본 동작이다.
    return get_unlocked(state, lock, factory)


GETTERS = {"unlocked": get_unlocked, "candidate": get_candidate}
