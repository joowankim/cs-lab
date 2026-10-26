"""문제 상황 1의 상한 도구와 API 호출 함수, 그리고 고친 호출 함수."""

import threading

# semaphore·bounded는 동시 호출 4개, lock·rlock은 1개까지 허용한다.
LIMITS = {"semaphore": 4, "bounded": 4, "lock": 1, "rlock": 1}


def make_slots(kind: str):
    # 문제 상황 1의 threading.Semaphore(4) 자리에 넣을 상한 도구를 kind마다 하나 만든다.
    if kind == "semaphore":
        return threading.Semaphore(LIMITS[kind])
    if kind == "bounded":
        return threading.BoundedSemaphore(LIMITS[kind])
    if kind == "lock":
        return threading.Lock()
    if kind == "rlock":
        return threading.RLock()
    raise ValueError(f"알 수 없는 상한 도구: {kind}")


def call_api_buggy(slots, api, req: int) -> str:
    # 문제 상황 1의 코드다. TimeoutError가 나면 release()가 두 번 불린다.
    slots.acquire()
    try:
        return api.send(req)
    except TimeoutError:
        slots.release()
        return api.send_later(req)
    finally:
        slots.release()


def call_api_candidate(slots, api, req: int) -> str:
    # with 문이 acquire()와 release()를 한 번씩 짝지어 부른다. send_later()는 큐에 넣기만 하므로 자리를 쥔 채 부른다.
    with slots:
        try:
            return api.send(req)
        except TimeoutError:
            return api.send_later(req)


CALLERS = {"buggy": call_api_buggy, "candidate": call_api_candidate}
