# 01 동시성 모델 비교

같은 작업을 순차·스레드·프로세스·asyncio로 돌려 본다. CPU로 계산할 때와 기다리는 시간이 많을 때, 어떤 방식이 얼마나 빠른지 재려 한다. Python의 일반 빌드와 free-threaded 빌드도 비교한다.

2026-10-23에 시작 전 준비를 마치고 진행 결과를 순서대로 기록한다. 이 커밋까지의 측정과 해석은 아래 결과 정리에 남겼다. 학습 확인과 최종 정리는 별도로 이어간다.

## 궁금한 것

- 계산이 많은 작업과 대기가 많은 작업에서 스레드·프로세스·asyncio는 순차 실행보다 얼마나 빠르거나 느릴까?
- GIL을 끄면 스레드 성능은 얼마나 달라질까?
- 한 Python 인터프리터마다 GIL이 하나만 존재하는가? 실제 구현에서 인터프리터·스레드·GIL은 어떻게 연결되는가?
- 락 없는 카운터와 지연 초기화 싱글톤의 경쟁 상태를 재현할 수 있을까? 락은 어디에 걸어야 할까?
- 이벤트 루프에서 블로킹 작업을 돌리면 다른 코루틴은 얼마나 늦게 응답할까?

## 시작 전 기록

### 첫 문제: 같은 스레드 수인데 효과가 다른 이유

Python으로 소수를 계산하는 작업 A와 외부 서버의 응답을 받아 저장하는 작업 B를 순차 실행에서 스레드 4개로 바꿨다고 가정했다. A는 시간이 거의 줄지 않거나 늘고, B는 줄어드는 상황을 제시했다. 실제 측정 결과가 아니다.

처음 제시할 때 GIL이 켜진 일반 CPython이라는 조건을 빠뜨렸다. 사용자가 free-threaded 빌드에서는 A도 빨라질 수 있다고 지적했다. 이 문제는 하나의 인터프리터에서 GIL을 켠 조건으로 보완하고, GIL을 끈 조건은 별도로 비교한다. 1번 실험의 전체 범위는 유지하며 질문별로 진행한다.

### 사람의 최초 설명과 의문 (2026-10-22, 요약)

아래는 피드백을 받기 전의 설명이며, 확인된 사실과 구분해 남긴다.

- free-threading은 Python 3.14t부터 지원하는 것으로 알고 있었다. GIL이 없으면 A도 여러 스레드로 더 빨리 처리할 수 있다고 예상했다.
- GIL이 있는 환경에서는 GIL을 가진 스레드만 CPU를 사용할 수 있고, 다른 스레드는 그 작업이 끝나기를 기다리므로 A가 순차 실행과 비슷하다고 설명했다.
- B는 외부 리소스에 작업을 맡기고 기다리는 동안 GIL을 반납하므로 여러 스레드가 대기 시간을 겹칠 수 있다고 설명했다.
- GIL을 어디에 반납하는지, 대기하던 스레드를 누가 다시 실행시키는지가 불분명했다. `threading`의 스레드와 asyncio 이벤트 루프의 관계도 확인하고 싶어 했다.

### 에이전트 피드백

- free-threaded 빌드는 3.13부터 도입됐다. 버전·빌드와 실제 GIL 활성 상태를 구분한다. GIL을 끄면 CPU 작업도 병렬 실행할 수 있지만, 속도 향상은 측정으로 확인한다. [free-threading 문서](https://docs.python.org/3.14/howto/free-threading-python.html)
- GIL은 CPU 전체의 사용 권한이 아니다. GIL이 켜진 같은 인터프리터에서 Python 코드를 실행하는 스레드를 제한한다. 다른 작업의 완료 전에도 교대할 수 있고, GIL을 해제하는 네이티브 코드는 별도로 CPU 연산을 수행할 수 있다. [스레드와 GIL](https://docs.python.org/3.14/c-api/threads.html)
- 블로킹 I/O를 감싼 CPython의 C 코드가 GIL을 해제한다. I/O 대기와 스레드 재개는 OS가 담당하며, Python 코드로 돌아오기 전에는 GIL을 다시 획득한다. 잠금 해제는 CPython이 공유하는 잠금 상태를 바꾸고 대기 중인 스레드에 신호를 보내는 동작이다. [소켓 구현](https://github.com/python/cpython/blob/3.14/Modules/socketmodule.c), [GIL 구현](https://github.com/python/cpython/blob/3.14/Python/ceval_gil.c)
- `threading`은 OS 스레드를 만들고 관리하는 API이고, asyncio 이벤트 루프는 그 루프가 실행되는 스레드에서 Task와 콜백을 실행한다. 일반적인 `threading` 기반 I/O에 asyncio 이벤트 루프는 필요하지 않다. [threading](https://docs.python.org/3.14/library/threading.html), [asyncio](https://docs.python.org/3.14/library/asyncio-dev.html#concurrency-and-multithreading)

### 이해 확인: I/O가 끝난 스레드의 재개

- 사람의 답(요약): 스레드 A의 I/O가 끝나도 같은 인터프리터의 B가 GIL을 가지고 있으면 A는 해제를 기다려야 한다. 다른 인터프리터라면 바로 Python 코드를 실행할 수 있다고 답했다.
- 에이전트 피드백: GIL이 켜진 환경에서 첫 설명은 맞다. 두 번째는 서로 독립적인 GIL을 쓰는 경우로 한정한다. 다른 인터프리터도 GIL을 공유할 수 있으며, 독립적인 GIL을 쓰더라도 실제 실행 시점은 OS 스케줄링에 달려 있다. [인터프리터의 GIL 설정](https://docs.python.org/3.14/c-api/subinterpreters.html#c.PyInterpreterConfig.gil)
- 현재 확인한 부분: I/O 완료 뒤에도 공유 GIL의 재획득을 기다릴 수 있다는 점을 설명했다. 계산 중 스레드 교대와 이벤트 루프의 역할은 추가로 확인한다.

### 보충 학습: Python 스레드·OS 스레드·하드웨어 스레드

- 사람의 현재 이해(요약): Python에서는 작성자가 스레드 수를 정할 수 있지만 OS 스레드 수는 CPU 사양에 제한되므로, 둘은 다른 종류라고 생각했다. B가 I/O 없이 Python 계산을 계속하면 A는 B의 전체 계산이 끝나야 GIL을 얻는다고 답했다.
- 에이전트 피드백: CPython의 `threading.Thread`로 시작한 스레드는 OS 스레드에 1:1로 대응한다. POSIX 구현은 `pthread_create()`를 호출한다. CPU 사양의 하드웨어 스레드(논리 CPU)는 실행 자원이며, OS 스레드는 그 자원에 스케줄링되는 실행 단위다. 자원이 허용하면 논리 CPU 수보다 많은 OS 스레드를 만들 수 있다. [CPython 스레드 구현](https://github.com/python/cpython/blob/3.14/Python/thread_pthread.h), [OS의 스레드 스케줄링](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Multithreading/AboutThreads/AboutThreads.html)
- 에이전트 피드백: 순수 Python 계산 중에도 CPython이 GIL 교대 요청을 처리하므로 다른 스레드가 작업 완료 전에 실행할 수 있다. OS가 실행 중인 스레드를 중단하는 것과 GIL을 해제하는 것은 별개다. 교대 간격은 엄밀한 시간 보장이 아니며, GIL을 유지하는 긴 네이티브 호출은 교대를 지연시킬 수 있다. [교대 간격](https://docs.python.org/3.14/library/sys.html#sys.setswitchinterval), [GIL 구현](https://github.com/python/cpython/blob/3.14/Python/ceval_gil.c)
- 사람의 재설명(요약): 스레드 10개를 두는 것은 가능하지만 논리 CPU가 4개이므로 10개 작업을 동시에 병렬 실행할 수는 없다고 답했다. OS가 여러 스레드를 동시에 실행되는 것처럼 스케줄링할 수 있다고 예상했지만, 그 근거는 모르겠다고 밝혔다.
- 추가 피드백: 자원이 허용하면 작업자 스레드 10개를 실제로 생성해 시작할 수 있다. 논리 CPU 4개는 OS 스레드의 동시 실행 한도이고, GIL이 켜진 같은 인터프리터에서 순수 Python 계산을 동시에 실행하는 작업자는 최대 1개다. OS는 스레드의 실행 문맥을 저장·복원해 중단한 지점부터 이어서 실행한다. 이것을 문맥 교환이라고 한다. [OS의 문맥 교환](https://learn.microsoft.com/en-us/windows/win32/procthread/multitasking), [GIL의 실행 제한](https://docs.python.org/3.14/library/threading.html#gil-and-performance-considerations)
- 사람의 추가 답(요약): GIL을 실제로 끄면 같은 인터프리터에서도 여러 스레드가 Python 코드를 동시에 실행할 수 있고, 논리 CPU가 4개이므로 작업자 10개의 동시 실행 상한은 4개라고 답했다. 설명 중에는 이를 "물리적인 CPU의 개수"라고도 표현했다.
- 추가 피드백: 상한 4개라는 판단은 맞다. 다만 이 조건에서 주어진 것은 논리 CPU 4개이며, 반드시 물리 코어 4개라는 뜻은 아니다. [하드웨어 스레드와 논리 프로세서](https://www.intel.com/content/dam/doc/manual/64-ia-32-architectures-optimization-manual.pdf)
- 현재 확인한 부분: 스레드 생성 수와 하드웨어의 병렬 실행 한도를 구분했고, GIL을 끈 뒤의 동시 실행 상한을 이유와 함께 설명했다. 문맥 교환과 계산 중 GIL 교대는 설명을 보충했으며, 사람의 재설명은 아직 확인하지 않았다.

### CPU 작업의 예상: 스레드 4개와 프로세스 4개

- 문답의 조건: 논리 CPU 4개, GIL이 켜진 일반 CPython, 서로 독립적인 소수 계산 작업을 가정했다. 실제 측정 환경을 확인한 결과는 아니다.
- 사람의 예상과 이유(요약): 프로세스 4개가 더 빨리 끝날 것으로 예상했다. 한 프로세스의 스레드 4개는 GIL을 공유하므로 한 번에 하나가 Python 계산을 실행하지만, 프로세스 4개는 각각의 GIL로 CPU 작업을 병렬 실행할 수 있다고 설명했다.
- 에이전트 피드백: 이번처럼 각 프로세스에 일반 인터프리터 하나를 두는 조건에서 병렬 실행에 대한 설명은 맞다. 처리 시간이 실제로 더 짧은지는 아직 측정하지 않았다. 현재 설계는 풀 생성·종료 시간까지 포함하므로, 작업 크기에 따라 예상이 달라질 수 있는지도 확인한다.
- 사람의 추가 예상(요약): 프로세스 생성·결과 전달·종료 비용이 크면 프로세스 4개가 항상 더 빠르지는 않을 것이라고 답했다. 검증하려던 전제는 후속 정정에 따라 "한 Python 인터프리터마다 GIL이 하나만 존재한다"로 기록한다. 처음 표현의 "프로세스"는 원래 의도한 단위가 아니었다고 밝혔다.
- 추가 피드백: 부대비용을 고려한 방향은 맞다. 비교할 기준은 부대비용과 병렬 계산시간 자체의 크기가 아니라, 프로세스로 바꾸면서 늘어난 비용과 병렬 계산으로 절약한 시간이다. 실제 판단은 같은 작업을 처리한 전체 경과 시간으로 한다. 풀은 작업들을 처리하고 결과를 받은 뒤 종료한다.

### 기본 CPU 작업의 가설 정리

- 조건: GIL이 켜진 일반 CPython에서 N=200,000인 소수 계산을 8번 수행한다. 순차 실행, 스레드 4개, 프로세스 4개의 전체 시간을 작업자 생성부터 결과 수집·종료까지 비교한다.
- 사람의 최초 예상: 처리 시간은 `프로세스 4개 < 순차 실행 < 스레드 4개` 순일 것으로 예상했다.
- 사람의 이유(요약): 프로세스 4개는 병렬로 계산할 수 있다. 순차 실행에는 문맥 교환이 없고, 스레드 4개는 순차 실행에 문맥 교환 비용만 추가된다고 설명했다.
- 에이전트 피드백: 순차 실행도 OS에 의해 다른 스레드와 문맥 교환할 수 있다. 이 실험의 추가 작업자 사이에서 교대할 필요가 없다는 점과 구분한다. 스레드 방식에는 문맥 교환 외에 작업자 생성·종료와 GIL 경합 등의 비용도 있다. [OS 스케줄링](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Multithreading/AboutThreads/AboutThreads.html), [GIL 구현](https://github.com/python/cpython/blob/3.14/Python/ceval_gil.c)
- 사람의 최초 판단 기준: 반복 측정한 전체 처리 시간의 중앙값을 비교해, 크기 순서가 예상과 다르면 예상이 틀렸다고 판단한다.
- 사람의 추가 생각(요약): 작업자 생성·종료와 GIL 경합 시간을 빼는 비교를 생각하다가, 환경에 따른 오차를 감안하면 프로세스 4개와 나머지 방식을 비교하는 것이 적절할 것 같다고 말했다.
- 에이전트 피드백: 실행 방식 자체의 부대비용은 현재 비교하려는 전체 시간에 포함한다. 환경 부하 등에 따른 변동은 반복 측정과 실행 조건 점검으로 확인한다. 비교 대상을 프로세스와 나머지로 묶어도 변동이 사라지는 것은 아니다. [벤치마크 환경과 변동](https://pyperf.readthedocs.io/en/latest/system.html)
- 사람이 확정한 현재 가설: 전체 처리 시간은 `프로세스 4개 < 순차 실행`이고 `프로세스 4개 < 스레드 4개`일 것으로 예상한다. 순차 실행과 스레드 4개 사이의 순서는 미리 정하지 않고 관찰한다.
- 사람이 정한 판단 보류 기준: 프로세스 4개와 비교 대상의 시간 차이가 작고, 반복할 때마다 빠른 쪽이 바뀌면 판단을 보류한다. 이 경우 속도 우위를 확인하지 못한 것으로 남기며, 두 방식이 같다고 확정하지 않는다.

### 작은 CPU 작업의 가설 정리 (2026-10-23)

- 조건: GIL이 켜진 일반 CPython에서 N=20,000인 소수 계산을 8번 수행한다. 작업자 생성부터 결과 수집·종료까지 포함하는 측정 구간과 비교 방식은 기본 작업량과 같다.
- 사람의 예상: 이 작은 작업에서도 프로세스 4개가 순차 실행과 스레드 4개보다 빠를 것으로 예상했다.
- 사람의 이유: N=20,000도 계산량이 충분히 크다고 생각했다.
- 에이전트 피드백: 계산량이 충분한지는 실제 계산시간과 병렬화에 추가되는 비용을 비교해 확인한다. N=20,000에서 프로세스의 이점이 유지될 것이라는 예상으로 남긴다.

### 구현 준비와 환경 점검 (2026-10-23)

- 사람은 `ThreadPoolExecutor`와 `ProcessPoolExecutor` 사용 경험이 있으며, 준비된 코드를 검토한 뒤 실행 방식과 작업자 수를 직접 수정하는 방식을 선택했다. [models.py](python/models.py)의 `MODELS`, `WORKERS`와 실행 함수를 살펴본다. 소수 계산·검증·측정·저장은 에이전트가 준비한다.
- 실제 장비는 Apple M2 Pro이며 물리 코어와 논리 CPU가 각각 12개다. 성능 코어 8개와 효율 코어 4개로 구성된다. 앞선 문답의 논리 CPU 4개는 가정이었으며 실제 환경과 구분한다.
- uv 0.12.5와 일반 CPython 3.14.2를 확인했다. 해당 Python에서 `sys._is_gil_enabled()`는 `True`, free-threaded 빌드 여부는 `False`였다. `InterpreterPoolExecutor` API의 존재도 확인했으나 실행 검증은 아직 하지 않았다.
- 최초 환경 점검 당시 uv가 찾은 설치 목록에는 free-threaded 빌드가 없었다. 이후 3.14.2t를 설치하고 아래 free-threaded 환경 준비에 기록했다. 본 측정 시점의 환경은 별도로 다시 기록한다.
- 정답 경계값, 검증용 소수 개수, GIL 불일치 거부, 워밍업·실패 제외 집계를 확인하는 검사 4개를 통과했다. N=100인 검증 실행에서는 세 방식이 각각 워밍업과 검증을 마쳤고, 6개 기록 모두 `check: 200`과 GIL 상태 확인을 통과했다. [검증 환경](results/validation/2026-10-23T002847377299-smoke-env.txt)과 [검증 원자료](results/validation/2026-10-23T002847377299-smoke-python-3.14.2-gil-on.jsonl)를 남겼다. 이 값으로 본 실험의 성능 가설을 판단하지 않는다.

### 코드 검토에서 확인한 작업량

- 사람은 `jobs`에 값을 할당하는 코드가 보이지 않는다고 지적했다. 에이전트는 `bench.py`의 `measure()`에서 입력을 만든 뒤 실행 함수의 인자로 전달하는 흐름을 설명했다.
- 사람은 순차 실행 외에는 작업을 나눠 처리한다고 답했다. 에이전트는 모든 방식이 같은 작업 8개를 수행하며, 각 작업은 2부터 N까지 전체 범위를 계산한다고 보충했다. 소수를 검사할 범위를 작업자 수만큼 쪼개는 구성은 아니다.
- 작업자 수를 4개에서 8개로 바꾸면 총작업량도 바뀌는지 물었고, 사람은 총작업량은 같다고 답했다. 첫 본 측정에는 기존 설정인 작업자 4개를 사용했다. 사람이 코드를 직접 바꿔 실행하는 단계는 남아 있다.

### I/O 준비: 동기 sleep과 비동기 sleep

- 사람의 최초 예상과 이유(요약): sleep을 동기·비동기로 호출할 수 있다고 짚었다. 동기 방식에서는 순차와 멀티스레드의 시간이 거의 같고, 비동기 방식에서는 대기 중 스레드가 GIL을 해제하므로 멀티스레드가 더 빠를 것으로 예상했다.
- 에이전트 피드백: `time.sleep()`은 호출한 스레드가 반환을 기다리는 동기 호출이지만, GIL을 켠 CPython에서도 대기 중 GIL을 해제한다. 따라서 여러 스레드가 각각 `time.sleep()`을 호출하면 대기 시간을 겹칠 수 있다. 스레드 하나가 기다리는 것과 프로세스 전체의 진행이 멈추는 것은 구분한다. [time.sleep 문서](https://docs.python.org/3.14/library/time.html#time.sleep), [CPython 3.14.2 구현](https://github.com/python/cpython/blob/v3.14.2/Modules/timemodule.c)
- 에이전트 피드백: `await asyncio.sleep()`은 현재 Task를 중단하고 이벤트 루프가 다른 Task를 실행할 수 있게 한다. 이 전환에 여러 OS 스레드가 필요한 것은 아니며, `await` 자체를 GIL 해제와 동일시하지 않는다. [asyncio.sleep 문서](https://docs.python.org/3.14/library/asyncio-task.html#asyncio.sleep)
- 먼저 비교할 순차 실행과 스레드 4개 조건은 모두 `time.sleep(0.1)`을 사용하고 총작업 수는 40개다.
- 설명 후 사람의 예상과 이유(요약): 스레드 4개가 각각 작업 10개를 처리하므로 1초가 걸릴 것으로 예상했다. 이를 스레드에서 작업을 병렬 처리한다고 표현했다.
- 에이전트 피드백: 부대비용과 스케줄링 지연을 제외하고 작업을 균등하게 나눈다면 `40 ÷ 4 × 0.1 = 1초`로 계산할 수 있다. 실제 측정값은 아직 없다. 여기서는 여러 작업의 대기 시간을 겹치는 동시성으로 설명한다. GIL이 켜진 같은 인터프리터에서 여러 스레드가 순수 Python 계산을 동시에 실행한다는 뜻은 아니다.
- asyncio에 대한 사람의 예상과 이유(요약): 스레드 하나의 이벤트 루프에서도 동시에 대기하는 작업을 4개로 제한하면 1초가 걸릴 것으로 예상했다. 이 제한을 코드에서 구현하는 방법을 질문했다.
- 에이전트 피드백: 모든 작업이 공유하는 `asyncio.Semaphore(4)`를 만들고, `async with semaphore:` 안에서 `await asyncio.sleep(0.1)`을 실행한다. 블록 진입 시 허용 수를 하나 사용하고, 블록을 나올 때 반환한다. 자리가 없으면 해당 Task가 기다리며 이벤트 루프의 스레드 자체를 막지 않는다. [Semaphore 문서](https://docs.python.org/3.14/library/asyncio-sync.html#asyncio.Semaphore)
- 표현 보완: 제한 대상은 `sleep`을 진행하는 작업 수다. 작업용 Task 40개를 만들어도 블록 안에는 최대 4개만 들어가며, 나머지는 세마포어 획득을 기다릴 수 있다. 전체 대기 Task 수가 4개로 제한되는 것은 아니다.
- 프로세스에 대한 사람의 예상과 이유(요약): 생성·결과 수집·종료를 포함하면 프로세스 4개의 전체 시간이 스레드 4개보다 길 것으로 예상했다. 프로세스 생성 비용이 더 크다는 것을 이유로 들었으며, 실제 차이가 얼마인지는 직접 측정한 적이 없다고 밝혔다.
- 에이전트 피드백: 전체 시간의 예상과 원인에 대한 설명을 구분해 기록한다. 이번 측정으로 직접 비교하는 값은 전체 시간이며, 그 차이를 생성 비용만의 차이로 해석하지 않는다. I/O 본 측정은 아직 하지 않았다.

### CPU 계산의 asyncio 실행과 이벤트 루프

- 사람의 최초 예상과 이유(요약): CPU 계산을 이벤트 루프의 스레드에서 직접 처리하므로 순차 실행과 시간이 거의 같을 것으로 예상했다. I/O에서는 이벤트 루프가 여러 스레드의 작업 위임과 대기를 가능하게 한다고 설명했으며, 여러 스레드가 비동기로 실행되는 메커니즘을 정확히 알지 못하는 것 같다고 밝혔다.
- 에이전트 피드백: 이번 구성에서는 이벤트 루프가 스레드 하나에서 여러 Task를 관리한다. Task는 코루틴의 실행과 재개를 관리하는 객체다. Task가 미완료 작업을 기다리며 제어권을 돌려주면 같은 스레드에서 다른 Task를 실행한다. 이 교대와 OS 스레드 사이의 교대·GIL 획득은 구분한다. [이벤트 루프의 실행 방식](https://docs.python.org/3.14/library/asyncio-dev.html#concurrency-and-multithreading)
- 에이전트 설명: `asyncio.sleep(0.1)`은 타이머를 등록하고 Task를 대기시킨다. 이벤트 루프는 그동안 준비된 다른 Task를 실행하며, 실행할 일이 없으면 다음 타이머나 I/O 이벤트를 기다린다. 대기 조건이 충족되면 해당 Task를 재개할 수 있도록 예약하고, 차례가 오면 멈췄던 지점부터 이어간다. 네트워크 I/O에서는 OS가 제공하는 소켓 준비 상태를 이용한다. [sleep 구현](https://github.com/python/cpython/blob/v3.14.2/Lib/asyncio/tasks.py), [이벤트 루프 구현](https://github.com/python/cpython/blob/v3.14.2/Lib/asyncio/base_events.py)
- 에이전트 피드백: 이번 소수 계산은 중간에 제어권을 양보하지 않으므로, 한 Task가 계산하는 동안 같은 이벤트 루프의 다른 Task는 실행할 수 없다. Task 수나 세마포어 상한을 늘려도 이 계산이 여러 CPU에서 실행되는 구성으로 바뀌지 않는다. 순차와의 실제 시간 차이는 아직 본 측정하지 않았다.
- 사람의 추가 답과 질문(요약): A가 2초 동안 계산하는 중 B의 타이머가 만료돼도 B는 즉시 재개할 수 없다고 답했다. 이유는 A가 CPU를 점유하기 위해 GIL을 소유하고 있기 때문이라고 설명하며, 제어권과 GIL의 차이를 질문했다.
- 에이전트 피드백: 여기서 제어권은 별도의 잠금이나 자원이 아니라 실행 흐름을 뜻한다. GIL을 획득하는 단위는 Task가 아니라 OS 스레드다. 같은 이벤트 루프의 A와 B는 같은 스레드에서 실행하므로 서로 GIL을 넘겨받는 관계가 아니다. A가 양보하거나 끝나야 그 스레드가 이벤트 루프의 코드를 실행하고 B를 재개할 수 있다. CPU에 스레드를 실행시키는 OS 스케줄링과 Python 객체 접근을 제한하는 GIL도 구분한다. [GIL과 스레드 상태](https://docs.python.org/3.14/c-api/threads.html)
- 보충 예: 이벤트 루프의 스레드에서 `time.sleep(2)`를 직접 호출하면 GIL은 해제하지만 그 스레드가 기다리므로 같은 루프의 B는 실행하지 못한다. `await asyncio.sleep(2)`는 Task를 중단하고 실행 흐름을 루프로 돌려주므로 다른 준비된 Task가 실행될 수 있다. GIL 해제만으로 같은 이벤트 루프의 Task가 교대하는 것은 아니다.
- 설명 후 사람의 답(요약): GIL만 끈 상태가 free-threaded 실행인지 확인했다. 그 경우에도 B는 즉시 재개할 수 없으며, A가 양보 없이 계산하는 조건에서는 A의 작업이 끝나야 이벤트 루프가 다시 실행 기회를 얻는다고 설명했다. 이를 이벤트 루프가 제어권을 "회수"한다고 표현했다.
- 에이전트 피드백: free-threaded 빌드에서 실제 GIL을 끈 조건을 뜻한다. free-threaded 빌드도 GIL을 켜서 실행할 수 있으므로 빌드와 실행 상태를 구분한다. 이벤트 루프가 실행 중인 Task를 강제로 중단해 제어권을 회수하는 것은 아니다. A가 완료되거나 스스로 양보해야 실행 흐름이 루프로 돌아오며, 이번 조건에서는 중간 양보가 없으므로 A의 완료를 기다린다. [free-threaded 빌드의 GIL 설정](https://docs.python.org/3.14/howto/free-threading-python.html#the-global-interpreter-lock-in-free-threaded-python)
- 현재 확인한 부분: 설명을 보충한 뒤, GIL이 없어도 같은 이벤트 루프의 Task가 CPU 계산 때문에 지연될 수 있음을 이유와 함께 답했다. 도움받아 구분한 내용으로 남기며, 실험 완료 후 해설 없이 설명하는 확인은 별도로 한다.

## 현재 준비 상태

### CPU 작업과 작업자 수 비교: 준비 완료

이번 비교에서는 작업자 수와 총작업량을 구분하고, 병렬 계산으로 절약한 시간과 추가 비용을 근거로 실행 방식을 선택하는 것을 목표로 한다.

| 준비 항목 | 확인한 내용 |
|---|---|
| 문제 상황과 현재 이해 | GIL이 켜진 CPU 작업의 스레드·프로세스 차이, 작업자 수를 바꿔도 총작업량은 같다는 사람의 답을 기록했다. |
| 예상과 이유 | 두 N 모두 프로세스 8개가 4개보다 빠를 것이라는 예상과 이유를 받았다. N=200,000에서 순차·스레드 시간은 거의 같을 것이라는 예상도 남겼다. |
| 조건과 판단 기준 | 작업 8개, N=200,000과 20,000, GIL 켜짐, 생성·수집·종료를 포함한 전체 시간을 비교한다. 기존 중앙값 비교와 판단 보류 기준을 적용한다. |
| 사람이 수정할 범위 | 진행 단계에서 `models.py`의 `WORKERS`를 4에서 8로 수정한다. 현재 값은 4다. |
| 실행 점검 | 전체 자동 검사 12개가 통과했다. N=100의 기존 검증 14개에 이어 GIL 교차 실행도 작은 입력으로 검증했다. CPU 계산의 asyncio 실행에 대한 예상과, 설명을 보충한 뒤 GIL과 Task 전환을 구분한 답을 기록했다. |

작업자 수 비교는 같은 프로그램 실행 안에서 순차 1개, 스레드 4·8개, 프로세스 4·8개를 함께 재측정한다. N별로 5개 조건이며, 두 N에 워밍업 1회와 본 측정 3회를 적용하면 총 40개 기록이 된다. 조건 순서를 반복마다 뒤집는다. 앞서 실행한 작업자 4개 결과는 보존하되 새 비교의 기준값은 같은 코드로 다시 잰 4개 조건을 쓴다.

주가설은 각 N에서 프로세스 8개의 중앙값이 4개보다 작다는 것이다. 순서가 반대면 가설과 어긋난 결과로 기록한다. 차이가 작고 반복마다 빠른 쪽이 바뀌면 기존 기준대로 판단을 보류한다. 순차·스레드의 변화도 관찰하되, 차이를 확인하지 못했다는 이유로 두 시간이 같다고 확정하지 않는다.

준비 단계의 검증에는 명령줄로 작업자 수를 지정했다. [앞선 검증](results/validation/2026-10-23T074349332399-smoke-python-3.14.2-gil-on.jsonl)을 보존하고, 공통 코드 변경 뒤 [새 검증 환경](results/validation/2026-10-23T093149569102-smoke-env.txt)과 [새 검증 원자료](results/validation/2026-10-23T093149569102-smoke-python-3.14.2-gil-on.jsonl)를 남겼다. 검증 시간은 성능 가설의 판단에 사용하지 않는다.

진행 단계에서는 사람의 코드 수정과 설명을 받은 뒤 작은 입력 검증을 다시 확인한다. 본 측정 직전에는 전원과 다른 앱의 부하를 점검하고, 실행 중에는 다른 무거운 작업을 함께 돌리지 않는다. 측정 후에는 표를 먼저 보여 주고 사람의 첫 해석을 받는다.

### I/O 네 방식 비교: 준비 완료

스레드의 대기와 Task의 대기를 구분하고, 같은 작업 수와 동시 실행 상한에서 실행 방식을 비교한다. 일반 CPython 3.14.2의 GIL을 켠 조건이며, 작업당 대기 0.1초와 작업 40개를 유지한다. 순차는 작업자 1개, 스레드·프로세스는 4개, asyncio는 이벤트 루프 하나에서 세마포어 상한 4개를 사용한다.

사람은 부대비용을 제외한 스레드·asyncio의 시간을 각각 약 1초로 예상했고, 전체 시간은 프로세스가 스레드보다 길 것으로 예상했다. 전체 시간의 중앙값으로 이 순서를 대조하고, 차이가 작고 반복마다 순서가 바뀌면 기존 기준대로 판단을 보류한다. 약 1초라는 계산을 실제 전체 시간과 정확히 같아야 하는 기준으로 쓰지 않는다.

사람이 직접 다룰 범위는 기존에 정한 `models.py`의 실행 방식·작업자 수 설정이다. 진행 단계에서 `run_asyncio()`의 세마포어 적용 범위와 `await` 위치도 검토하고 설명한다. 에이전트는 공통 작업 함수, 측정·검증·저장을 맡는다.

검증은 작업 8개, 작업당 대기 0.001초로 실행했다. 네 방식의 워밍업과 검증을 합친 8개 기록 모두 `check: 8`과 GIL 확인을 통과했다. 공통 코드 변경 뒤의 [검증 환경](results/validation/2026-10-23T093152104188-smoke-env.txt)과 [검증 원자료](results/validation/2026-10-23T093152104188-smoke-python-3.14.2-gil-on.jsonl)를 남겼다. 자동 검사에서는 세마포어 상한을 넘지 않으면서 모든 작업이 끝나는지와 작업 종류·대기 시간·작업 수별 집계가 섞이지 않는지도 확인했다.

### 같은 free-threaded 빌드의 GIL 비교: 준비 완료

일반 빌드와 패치 버전을 맞춘 CPython 3.14.2t를 `uv python install --no-bin 3.14.2t`로 설치했다. `Py_GIL_DISABLED`가 1인 빌드이며, 같은 실제 실행 파일에서 `PYTHON_GIL=0`과 `1`을 각각 검증했다. 런타임 버전과 실제 경로는 아래 환경 파일에 남겼다.

GIL을 켠 조건과 끈 조건에서 각각 자동 검사 11개가 통과했다. 환경 기록을 보완한 뒤 CPU·I/O 네 방식의 작은 입력 기록 32개가 정답과 GIL 상태 확인을 통과했다. CPU는 N=100·작업 8개, I/O는 대기 0.001초·작업 8개이며 성능 가설을 판단하는 본 측정은 아니다.

| 작업 | GIL | 환경 | 검증 원자료 |
|---|---|---|---|
| CPU | 끔 | [환경](results/validation/2026-10-23T094844046575-smoke-env.txt) | [JSONL](results/validation/2026-10-23T094844046575-smoke-python-3.14.2t-gil-off.jsonl) |
| CPU | 켬 | [환경](results/validation/2026-10-23T094846365660-smoke-env.txt) | [JSONL](results/validation/2026-10-23T094846365660-smoke-python-3.14.2t-gil-on.jsonl) |
| I/O | 끔 | [환경](results/validation/2026-10-23T094849547078-smoke-env.txt) | [JSONL](results/validation/2026-10-23T094849547078-smoke-python-3.14.2t-gil-off.jsonl) |
| I/O | 켬 | [환경](results/validation/2026-10-23T094851756037-smoke-env.txt) | [JSONL](results/validation/2026-10-23T094851756037-smoke-python-3.14.2t-gil-on.jsonl) |

일반 빌드와의 비교에는 빌드 차이도 포함된다. GIL 설정의 영향을 따로 보기 위한 같은 free-threaded 빌드의 켜짐·꺼짐 조건도 준비했다.

- 조건: 같은 3.14.2t에서 N=200,000·작업 8개·스레드 4개를 유지하고 GIL 설정만 바꾼다. 생성·결과 수집·종료를 포함한 전체 시간의 중앙값을 비교한다.
- 사람의 예상과 이유(요약): GIL을 켜면 스레드 4개도 순차 실행과 시간이 거의 같을 것으로 예상했다. GIL을 끄면 동시에 CPU 계산을 진행할 수 있는 스레드가 1개에서 4개가 되므로 작업 시간이 "약 1/4배 감소"할 것으로 예상했다.
- 에이전트의 해석과 피드백: 문맥상 GIL을 끈 시간이 켠 시간의 약 1/4로 줄어든다는 예상으로 이해한다. 이는 시간의 약 75% 단축이다. 4개 스레드가 계산을 고르게 나누고 추가 비용을 무시하면 기대할 수 있는 비율이며, 생성·수집·종료 등을 포함한 실제 전체 시간의 비율은 측정으로 확인한다.
- 판단 범위에 대한 사람의 요청: "약 1/4"로 인정할 범위는 에이전트가 제안해 달라고 했다.
- 에이전트의 제안 기준: 시간 비율 `GIL 끔 중앙값 ÷ GIL 켬 중앙값`이 0.20~0.30이면 수치 예상과 부합한 것으로 판단한다. 25%를 중심으로 ±5퍼센트포인트를 둔 사전 허용 범위이며, 측정에서 얻은 오차 범위나 통계적 신뢰구간은 아니다.
- 범위 밖이면 "약 1/4"라는 수치 예상에는 맞지 않은 것으로 기록한다. 0.20 미만은 예상보다 큰 단축, 0.30 초과는 예상보다 작은 단축 또는 단축 없음으로 구분한다. 실제로 빨라졌는지는 비율이 1보다 작은지도 따로 본다. 예를 들어 0.40이면 더 빨라졌지만 약 1/4라는 예상에는 부합하지 않는다. 두 GIL 조건의 차이가 작고 반복마다 빠른 쪽이 바뀌면 기존 기준대로 속도 우위 판단을 보류한다.
- N=20,000에 대한 사람의 예상과 이유(요약): GIL을 꺼도 전체 시간에 거의 변화가 없을 것으로 예상했다. 앞서 N=200,000과 20,000을 비교한 결과에서, 작업이 충분히 작으면 순차와 병렬 처리의 시간이 크게 다르지 않다고 이해한 것을 근거로 들었다.
- 에이전트 피드백: 앞선 본 측정은 일반 CPython 3.14.2에서 GIL을 켠 채 실행 방식을 바꾼 비교였다. N=20,000의 중앙값은 순차 0.068357초, 스레드 0.065934초, 프로세스 0.095484초였으며 프로세스는 순차보다 약 40% 느렸다. 작은 작업에서 프로세스의 속도 이점을 얻지 못한 결과를, free-threaded 빌드에서 스레드의 GIL을 꺼도 변화가 없다는 직접 근거로 쓰지는 않는다. 그 예상은 새 조건에서 확인할 가설로 보존한다.
- 작은 작업에 대한 에이전트의 제안 기준: 같은 시간 비율이 0.90~1.10이면 "거의 변화 없음"이라는 예상에 부합한 것으로 판단한다. 사전에 정하는 ±10% 허용 범위이며, 두 조건의 시간이 정확히 같다는 증명이나 통계적 신뢰구간은 아니다. 범위 밖이면 실제 변화 방향과 크기를 기록하고, 속도 우위가 반복마다 바뀌는 경우의 기존 보류 기준도 유지한다.
- I/O에 대한 사람의 최초 예상과 의문(요약): 같은 free-threaded 빌드에서 `time.sleep(0.1)` 작업 40개를 스레드 4개로 처리할 때, GIL을 끄면 4초에서 1초로 줄 것으로 예상했다. 동시에 대기할 수 있는 스레드가 1개에서 4개로 늘어난다고 설명했다. 이어 `time.sleep()`이 CPU를 점유하지 않는다면 GIL을 켜도 스레드 4개가 동시에 기다릴 수 있는 것 아닌지 질문했다.
- 에이전트 피드백: `time.sleep()`은 CPython 구현에서 대기 전에 GIL을 해제한다. GIL이 켜져 있어도 여러 스레드가 차례로 sleep에 들어가 대기 시간을 겹칠 수 있다. CPU를 사용하지 않는다는 사실만으로 GIL이 자동 해제되는 것은 아니며, 호출 구현을 확인해야 한다. [CPython 3.14.2 sleep 구현](https://github.com/python/cpython/blob/v3.14.2/Modules/timemodule.c)
- 에이전트 설명: 이번 비교에서는 GIL을 켜거나 꺼도 작업자 수가 4개로 고정된다. 부대비용과 스케줄링 지연을 제외하면 두 조건 모두 `40 ÷ 4 × 0.1 = 1초`로 계산한다. 4초에서 1초로 줄어드는 계산은 작업자 1개와 4개를 비교할 때 해당한다. 이는 설명을 위한 계산이며 실제 측정값이나 사람의 수정한 예상은 아니다.
- 설명 후 사람의 I/O 예상과 이유(요약): 두 조건 모두 동시에 대기할 수 있는 스레드가 4개이므로 GIL 켜짐·꺼짐의 전체 시간 차이는 거의 없을 것으로 예상했다.
- 에이전트 피드백과 기준: 이번 `time.sleep()` 중심의 조건에 대한 예상으로 기록한다. 다른 I/O 작업이나 CPU 처리가 섞인 작업 전체에 일반화하지 않는다. "거의 변화 없음"의 사전 허용 범위는 앞서 제안한 시간 비율 0.90~1.10을 적용한다. 실제 전체 시간은 측정으로 확인하며 본 측정은 아직 하지 않았다.

GIL 상태별 측정용 Python 프로세스를 하나씩 유지하고 `compare_gil.py`에서 한 번에 한 조건만 요청한다. 워밍업과 본 측정은 같은 측정용 프로세스에서 이어가며, 반복마다 전체 조건 순서를 뒤집어 두 GIL 상태의 선후 관계도 바꾼다. 각 요청은 기존 `bench.measure()`를 사용한다. 결과의 작업자 수는 그 안에서 만드는 실험 대상 풀이나 세마포어의 상한이다.

측정용 프로그램의 시작과 제어용 통신은 측정 구간 밖에서 수행한다. 비교 대상 풀·이벤트 루프의 생성부터 결과 수집·종료까지는 매번 전체 시간에 포함한다. 환경 파일의 `measurement_runtimes`에 두 조건의 실제 실행 파일·빌드·GIL 상태·PID를 각각 기록한다.

자동 검사 12개가 통과했고, 교차 실행의 작은 입력 검증은 CPU·I/O 각각 16개 기록이 통과했다. 정답, 실제 GIL 상태, 같은 빌드 사용, 워밍업부터 반복까지의 측정 프로세스 유지, 조건 순서 반전과 환경·소스 해시를 확인했다. 일반 빌드의 [기존 검증 명령](results/validation/2026-10-23T110910442825-smoke-python-3.14.2-gil-on.jsonl)도 다시 확인했다.

| 교차 실행 검증 | 환경 | 원자료 |
|---|---|---|
| CPU: N=100, 작업 8개 | [환경](results/validation/2026-10-23T110904329069-gil-compare-smoke-env.txt) | [JSONL](results/validation/2026-10-23T110904329069-gil-compare-smoke-python-3.14.2t.jsonl) |
| I/O: 대기 0.001초, 작업 8개 | [환경](results/validation/2026-10-23T110907435776-gil-compare-smoke-env.txt) | [JSONL](results/validation/2026-10-23T110907435776-gil-compare-smoke-python-3.14.2t.jsonl) |

수치 가설의 판단 대상은 스레드 4개의 GIL 켜짐·꺼짐 비교다. 다른 실행 방식도 함께 기록해 관찰하되, 받지 않은 사람의 수치 예상을 대신 채우지 않는다. 진행 단계에서는 기존에 정한 실행 방식·작업자 수 설정을 사람이 검토·수정하고, 에이전트가 교차 실행과 집계를 맡는다.

### 시작 전 준비 완료 (2026-10-23)

사람의 예상과 이유를 기록하고, 마지막으로 비동기 대기의 지연 허용치를 대조군 대비 10ms로 합의했다. 사람이 수정할 범위와 비교 조건을 정했으며, 모든 실행 틀을 작은 입력으로 검증했다. 인터프리터당 GIL의 전제는 소스로 확인했고, 그 전제를 검증하려고 확장했던 여러 인터프리터의 성능 비교 계획은 이 조사로 대체했다.

다음은 진행 단계의 CPU 작업자 수 비교다. 사람은 `models.py`의 `WORKERS`를 4에서 8로 바꾸고 이유를 설명한다. 에이전트는 수정본을 검증한 뒤 같은 실행 안에서 작업자 4개·8개를 반복 측정하고, 결과를 먼저 제시해 사람의 첫 해석을 받는다. 이후 I/O·GIL 비교·경쟁 상태·이벤트 루프 블로킹을 질문별로 이어간다. 준비 완료는 실험 완료나 최종 학습 확인을 뜻하지 않는다.

## 작업 규칙

### 입력과 검증값

| 작업 | 한 작업의 내용 | 전체 작업 수 (`size`) | 검증값 (`check`) |
|---|---|---|---|
| `cpu` | 2부터 N까지 소수 개수 세기 | 8 | 작업별 소수 개수의 합. N=200,000이면 17,984 × 8 = 143,872 |
| `io` | 0.1초 대기 | 40 | 정상 완료한 작업 수 40 |

소수는 각 후보 수를 2부터 정수 제곱근까지 나눠서 찾는다. 중간에 약수가 나오면 그 수의 검사는 끝낸다. N은 우선 200,000으로 잡는다.

첫 본 측정에서는 예상과 비교할 수 있도록 N=200,000과 20,000을 유지했다. 같은 N을 비교하는 동안에는 모든 조건과 언어에서 같은 알고리즘과 작업 수를 쓴다. `params.n`에 N을, `params.algorithm`에 `"trial_division"`을 기록한다. N을 바꾸면 예상과 정답을 다시 확인한다.

부대비용의 영향을 보기 위해 기본 N과 그 1/10인 작은 N을 별도 조건으로 비교한다. 각 조건에서 작업 수는 8로 유지하고, 서로 다른 N의 결과를 한 집계에 섞지 않는다. 작은 작업에서도 프로세스가 빠를지는 측정 전 예상으로 남긴다.

`io`에서는 여러 작업이 기다리는 시간을 얼마나 겹칠 수 있는지 본다. 순차·스레드·프로세스는 `time.sleep(0.1)`, asyncio는 `await asyncio.sleep(0.1)`을 쓴다. 실제 네트워크나 디스크의 처리량은 이 실험으로 알 수 없다. `params.sleep_s`에는 `0.1`을 기록한다.

### 실행 방식과 동시 실행 수

| `model` | `workers` | 실행 규칙 |
|---|---|---|
| `sequential` | 1 | 모든 작업을 하나씩 실행 |
| `threads` | 4 | 스레드 풀의 작업자 4개에 분배 |
| `processes` | 4 | 프로세스 풀의 작업자 4개에 분배 |
| `asyncio` | 4 | 이벤트 루프 하나에서 실행. 세마포어로 동시에 진행하는 코루틴을 최대 4개로 제한 |

asyncio의 `workers: 4`는 코루틴의 동시 실행 상한이다. OS 스레드가 4개라는 뜻은 아니다. CPU 계산도 이벤트 루프 안에서 직접 한다. 스레드나 프로세스에 넘겨 실행하는 경우는 별도 조건으로 기록한다.

CPU 계산을 코루틴으로 감싸도 이벤트 루프를 점유할 수 있다는 점을 여기서 확인한다. 관련 설명은 [asyncio 문서](https://docs.python.org/3.14/library/asyncio-dev.html#running-blocking-code)를 참고한다.

### 측정 조건

반복 횟수와 집계 방법은 [공통 측정 규칙](../../AGENTS.md#측정검증)을 따른다. 여기서는 런타임·GIL 상태·작업·실행 방식의 각 조합을 하나의 조건으로 본다.

- `wall_s`는 `time.perf_counter()`로 잰다. 입력 준비를 끝낸 뒤, 풀이나 이벤트 루프를 만들기 직전부터 모든 작업을 마치고 풀이나 루프가 종료될 때까지 잰다. 측정 프로그램 자체의 시작과 측정 전 모듈 로딩, 결과 출력 시간은 뺀다. 작업자 생성에 따른 인터프리터 시작과 모듈 로딩은 포함한다. 매번 풀과 루프를 새로 만들고 `params.timing`에는 `"end_to_end"`를 넣는다.
- 프로세스는 `spawn`으로 시작하고 `params.start_method`에 기록한다. 진입점에는 `if __name__ == "__main__":`를 둔다. 시작 방식에 대한 설명은 [multiprocessing 문서](https://docs.python.org/3.14/library/multiprocessing.html#contexts-and-start-methods)에 있다.
- 작업별 결과와 전체 `check`가 모두 맞는지 확인한다. 속도 향상 배수는 **같은 런타임·GIL 상태의 순차 중앙값 ÷ 비교 방식의 중앙값**으로 계산한다.

일반 빌드와 free-threaded 빌드를 비교하면 GIL뿐 아니라 빌드 자체의 차이도 결과에 들어간다. 그래서 같은 free-threaded 빌드에서 GIL만 켠 조건도 선택 실험으로 둔다. 빌드 차이는 [Python의 free-threading 문서](https://docs.python.org/3.14/howto/free-threading-python.html)를 참고한다.

## Python 실행 방법

CPU와 I/O 작업을 순차·스레드·프로세스·asyncio로 실행할 수 있다. macOS, uv, 일반 CPython 3.14.2에서 작은 입력으로 검증했다. 외부 패키지는 없으며 `bench.py`의 PEP 723 메타데이터에 Python 버전 범위를 선언한다.

| 파일 | 역할 |
|---|---|
| [models.py](python/models.py) | 직접 바꿔 볼 `MODELS`·`WORKERS`, 측정과 추적이 함께 사용하는 각 실행 방식 |
| [workloads.py](python/workloads.py) | 공통 입력 `Job`, 소수 계산과 정답, 동기·비동기 대기, 작업자 GIL 확인 |
| [bench.py](python/bench.py) | 입력과 반복 순서, 전체 시간 측정, 검증, 환경·원자료 저장과 집계 |
| [compare_gil.py](python/compare_gil.py) | 같은 free-threaded 빌드에서 GIL 켜짐·꺼짐 조건을 번갈아 실행 |
| [test_bench.py](python/test_bench.py) | 소수 개수와 집계 규칙 등의 동작 검사 |
| [test_compare_gil.py](python/test_compare_gil.py) | 런타임·GIL 조건별 집계가 섞이지 않는지 검사 |
| [trace_execution.py](python/trace_execution.py) | 작업 시작·종료 시점의 프로세스·스레드·Task 식별과 대응표 저장 |
| [test_trace_execution.py](python/test_trace_execution.py) | 실행 위치, asyncio 대기 전후 식별자, 동시 실행 상한과 오류 기록 검사 |
| [counter_kernels.py](python/counter_kernels.py) | 락 없는 카운터 증가와 진행 단계에서 직접 수정할 함수 |
| [counter_lab.py](python/counter_lab.py) | 카운터의 반복 실행, 기대값 불일치·실행 오류 구분, 환경·원자료 저장 |
| [test_counter_lab.py](python/test_counter_lab.py) | 기준 락 함수, 갱신 유실, 실행 오류와 집계 검증 |
| [singleton_kernels.py](python/singleton_kernels.py) | 락 없는 지연 초기화와 진행 단계에서 직접 수정할 함수 |
| [singleton_lab.py](python/singleton_lab.py) | 생성 횟수·객체 동일성 검증, 반복 실행과 환경·원자료 저장 |
| [test_singleton_lab.py](python/test_singleton_lab.py) | 중복 생성, 잘못된 반환값, 실행 오류와 집계 검증 |
| [loop_kernels.py](python/loop_kernels.py) | 이벤트 루프에서 실행할 A 작업과 진행 단계에서 수정할 대기 함수 |
| [loop_lab.py](python/loop_lab.py) | B의 예정·재개 시각, A 실행 구간, 스레드·Task 식별과 지연 집계 |
| [test_loop_lab.py](python/test_loop_lab.py) | 고정된 예정 시각, 재개 순서, 대조군, 결과 검증과 집계 검사 |

### 작은 입력으로 동작 확인

저장소 루트에서 시작한다. 이후 명령도 이 실험 폴더에서 실행한다.

```sh
cd experiments/01-concurrency-models
uv run --python 3.14.2+gil python/bench.py --smoke
```

`--smoke`는 CPU의 N을 100으로 고정한다. I/O에서는 작업 수를 8개, 대기 시간을 0.001초로 고정한다. 조건마다 워밍업 1회와 검증 1회만 실행하며, `purpose: "smoke"`로 표시한 결과와 환경을 `results/validation/`에 저장한다. 검증 실행은 성능 비교나 가설 판단에 사용하지 않는다.

파일의 `WORKERS`를 바꾸지 않고 작업자 4개·8개를 함께 검증하려면 다음 명령을 쓴다. 순차 실행은 중복하지 않아 총 5개 조건을 검증한다.

```sh
uv run --python 3.14.2+gil python/bench.py --smoke --workers 8 --compare-workers 4
```

I/O 네 방식의 기능 검증은 다음 명령으로 실행한다. CPU에 asyncio까지 포함해 검증하려면 `--task cpu`와 같은 `--models` 목록을 사용한다.

```sh
uv run --python 3.14.2+gil python/bench.py --smoke --task io --models sequential threads processes asyncio --workers 4
```

자동 검사만 실행하려면 다음 명령을 쓴다.

```sh
uv run --python 3.14.2+gil python -m unittest discover -s python -p 'test_*.py' -v
```

### 본 측정 — 코드 검토 후 실행

```sh
uv run --python 3.14.2+gil python/bench.py
```

기본 설정은 N=200,000과 20,000, 작업 8개, 스레드·프로세스의 작업자 상한 4개다. 조건마다 워밍업 1회와 본 측정 3회를 수행한다. 순차 실행의 `workers`는 항상 1이며, 풀의 `workers`는 설정한 상한을 뜻한다. 실제 작업에 참여한 스레드와 프로세스는 별도의 작업 추적으로 확인한다.

방식과 작업자 수는 `models.py`에서 수정한다. 다음처럼 명령줄로 지정할 수도 있으며, 이때는 명령줄 값이 파일의 기본 설정보다 우선한다. 조건을 바꾸기 전에는 예상도 먼저 남긴다.

```sh
uv run --python 3.14.2+gil python/bench.py --models sequential threads processes --workers 4 --sizes 200000 20000
```

`--compare-workers`는 기본 작업자 수에 비교 대상을 추가한다. 진행 단계에서 사람이 `WORKERS = 8`로 수정한 뒤 아래 명령을 실행하면 4개와 8개를 함께 비교한다. 이 본 측정은 아직 실행하지 않았다.

```sh
uv run --python 3.14.2+gil python/bench.py --compare-workers 4
```

I/O 본 측정의 예정 명령은 다음과 같다. 기본값은 작업 40개와 대기 0.1초이며 `--tasks`, `--sleep-s`로 바꿀 수 있다. 네 조건에 워밍업 1회와 본 측정 3회를 적용하면 총 16개 기록이 된다. 아직 본 측정하지 않았다.

```sh
uv run --python 3.14.2+gil python/bench.py --task io --models sequential threads processes asyncio --workers 4
```

`--sizes`는 CPU에만, `--sleep-s`는 I/O에만 사용한다. 같은 작업자 수는 중복하지 않고 순차 실행은 입력 조건마다 한 번만 구성한다. 첫 실행 순서는 `--seed`로 섞고, 반복마다 전체 순서를 뒤집는다. CPU 정답은 시간 측정 밖에서 체 알고리즘으로 구하고, I/O는 각 작업의 반환값 1과 완료한 작업 수를 확인한다. 틀린 결과는 `valid: false`와 오류를 남긴 뒤 실행을 중단한다. GIL 상태는 측정 전과 각 작업자에서 확인하며, 기본값인 `--expect-gil on`과 다르면 실행하지 않는다. 이 옵션은 GIL을 켜거나 끄는 설정이 아니다.

### 작업·스레드·Task 추적

어떤 스레드가 어떤 작업을 실제로 실행했는지 확인하기 위한 별도 진단이다. `trace_execution.py`는 `bench.py`와 같은 `models.py`의 실행 함수를 사용한다. 원래 작업 함수를 호출하기 전과 반환한 뒤에 실행 위치를 기록하는 함수를 전달한다. 성능 측정에서는 원래 작업 함수를 직접 전달하므로 추적 기록을 수집하지 않는다.

아래 명령은 준비 단계의 작은 입력만 실행한다. `--smoke`는 작업 8개, CPU의 N=100, I/O 대기 0.001초로 고정한다. 네 방식은 각각 한 번만 실행한다. 성능 측정의 워밍업·반복 집계에 포함하지 않는다.

```sh
uv run --python 3.14.2+gil python/trace_execution.py --smoke --task io
uv run --python 3.14.2+gil python/trace_execution.py --smoke --task cpu
```

특정 방식만 보려면 `--models asyncio` 또는 `--models threads`를 지정한다. `--workers`는 기본 4이며 순차 실행은 항상 1이다. `--smoke`를 빼도 기본 입력은 작업 8개·N=100·대기 0.001초다. 필요하면 `--tasks`, `--n`, `--sleep-s`로 관찰할 입력을 정한다.

작업 하나의 기록을 JSON 한 줄로 저장한다. `purpose: "trace"`로 구분하고, 작은 입력 검증에는 `validation: true`를 남긴다. 각 조건은 `run: 1`이며 `wall_s`와 성능 집계는 만들지 않는다. 순차·스레드·프로세스에서 말하는 일반 작업과 `asyncio.Task` 객체를 구분한다.

| 필드 | 의미 |
|---|---|
| `job_id` | 조건 안에서 0부터 붙인 실험 작업 번호 |
| `events[].event` | `work_start`, `work_end`. 예외로 끝나면 `work_error` |
| `events[].pid`, `native_thread_id`, `thread_name` | 그 지점의 프로세스 ID, OS 스레드 ID, 스레드 이름 |
| `events[].loop_id`, `asyncio_task_id`, `asyncio_task_name` | 실행 중인 이벤트 루프와 Task의 식별자·이름. 해당 객체가 없으면 `null` |
| `origin_ns`, `events[].at_ns`, `elapsed_s` | 조건 시작과 각 기록 지점의 `perf_counter_ns()` 값, 조건 시작 이후 경과 시간 |
| `events[].gil_enabled` | 런타임의 GIL 활성 여부. GIL 소유자를 추적하는 값이 아니다. |
| `check`, `expected_check`, `valid` | 개별 작업의 반환값·기대값·검증 결과. 성능 기록의 작업 전체 합계와 구분한다. |

`task`, `size`, `params`는 각각 CPU/I/O 종류, 해당 조건의 총작업 수, 입력 조건이다. 스레드는 PID와 OS 스레드 ID를 함께 보고, Task와 루프의 객체 ID는 같은 실행·조건·프로세스 안에서만 비교한다. ID는 수명이 끝난 뒤 재사용될 수 있다. [OS 스레드 ID](https://docs.python.org/3.14/library/threading.html#threading.get_native_id), [현재 Task 확인](https://docs.python.org/3.14/library/asyncio-task.html#asyncio.current_task)

JSONL의 행은 입력 작업 순서다. 실행 순서를 볼 때는 `events[].at_ns`를 사용한다. asyncio의 시작 기록은 세마포어를 획득한 뒤이며, I/O 종료 기록은 `await`에서 돌아온 뒤다. 두 지점의 스레드·Task ID를 대조할 수 있지만, 모든 실행 중단·재개 지점이나 세마포어를 기다리는 구간을 기록한 것은 아니다.

작은 입력 추적은 `results/validation/`, 그 밖의 추적은 `results/traces/`에 환경·JSONL·`mapping.txt` 대응표를 새 파일로 저장한다. 대응표에는 스레드별 작업 번호와 Task 이름, 실제 관찰한 스레드 수를 표시한다. 환경에는 추적 코드까지 포함한 소스 해시와 실행을 시작한 스레드 정보도 남긴다.

2026-10-23 검증에서는 CPU와 I/O 각각 32개 작업, 64개 시작·종료 지점이 기록됐으며 결과와 식별자 검사를 통과했다. 두 검증의 asyncio 조건에서 작업용 Task 8개가 같은 이벤트 루프·OS 스레드에서 시작하고 종료했다. 본 성능 측정은 실행하지 않았다.

| 입력 | 환경 | 원자료 | 대응표 |
|---|---|---|---|
| I/O: 작업 8개, 대기 0.001초 | [환경](results/validation/2026-10-23T093144868975-trace-smoke-env.txt) | [JSONL](results/validation/2026-10-23T093144868975-trace-smoke-python-3.14.2-gil-on.jsonl) | [스레드별 작업](results/validation/2026-10-23T093144868975-trace-smoke-mapping.txt) |
| CPU: 작업 8개, N=100 | [환경](results/validation/2026-10-23T093147306762-trace-smoke-env.txt) | [JSONL](results/validation/2026-10-23T093147306762-trace-smoke-python-3.14.2-gil-on.jsonl) | [스레드별 작업](results/validation/2026-10-23T093147306762-trace-smoke-mapping.txt) |

이 기록은 해당 실행에서 관찰한 배치다. 설정한 작업자 수만큼 모두 작업에 참여한다고 가정하지 않으며, 관찰되지 않은 다른 배치가 불가능하다고 결론 내리지 않는다. 추적 자체가 실행 순서와 비용에 영향을 줄 수 있으므로 성능 비교 자료로 쓰지 않는다. 시작·종료 구간이 겹친다는 사실만으로 Python 계산의 병렬 실행이나 GIL 소유 관계를 판단하지 않는다.

### 환경과 원자료

프로그램이 새 파일을 만들므로 별도의 출력 리다이렉션은 필요하지 않다. 본 측정은 `results/`에 `날짜T시각-benchmark-env.txt`와 같은 접두사의 JSONL 파일을 저장한다. 기존 파일은 덮어쓰지 않는다. JSONL은 표준 출력에도 보내고, 저장 경로와 중앙값·최솟값·최댓값 표는 표준 오류로 보낸다. 집계에서 워밍업과 검증 실패는 제외하고, 작업 종류·N 또는 대기 시간·작업 수·방식·작업자 수를 구분한다.

환경 파일에는 한국 시간의 시각·시간대, 실행 명령, 런타임과 GIL 상태, CPU·OS·전원 정보, 코드 커밋·미커밋 변경 여부와 소스 파일 해시를 기록한다. Free-threaded 준비부터는 `gil_configuration`에 `PYTHON_GIL`과 `-X gil` 설정도 기록한다. uv가 임시 환경을 만들 수 있으므로 `resolved_executable`과 `base_prefix`로 실제 런타임 경로를 함께 남긴다. 정보를 읽지 못하면 오류를 그대로 남긴다. 본 측정 전에 환경 파일을 확인한다.

결과에는 공통 키 외에 `purpose`, `valid`, `expected_check`, `gil_enabled`, `run_id`, `environment_file`, `order_index`, `seed`를 남긴다. 검증 실패에는 `error`도 기록한다.

GIL 교차 실행은 결과에 `comparison: "gil_same_build"`와 `measurement_pid`를 추가한다. 환경 파일의 최상위 런타임 정보는 제어 프로그램이며, 실제 측정 런타임은 `measurement_runtimes`에 GIL 상태별로 기록한다. 집계는 런타임·GIL 상태별로 먼저 나눈다.

작업자 수 비교를 준비하면서 CPU 사용량 기록을 추가했다. 측정 전후 `resource.getrusage()`의 사용자·시스템 CPU 시간 차이를 구해, 부모 프로세스의 모든 스레드 합계를 `cpu_parent_s`, 종료와 회수를 마친 자식 프로세스 합계를 `cpu_children_s`에 기록한다. [resource 문서](https://docs.python.org/3.14/library/resource.html#resource.getrusage)

`cpu_percent`는 두 CPU 시간의 합을 `wall_s`로 나누고 100을 곱한 값이다. 논리 CPU 하나를 측정 구간 내내 사용하면 약 100%인 기준이며, 시스템 전체 사용률이나 특정 순간의 병렬 실행 수는 아니다. 경과 시간 측정 바로 바깥에서 누적값을 읽으므로 경계에 작은 차이가 있다. 다른 앱과 아직 실행 중인 보조 자식 프로세스는 포함하지 않는다. `params.cpu_accounting`에는 `"getrusage_self_and_reaped_children"`를 기록하며, 앞선 첫 본 측정에는 이 필드들이 없다.

### Free-threaded 빌드의 작은 입력 검증

같은 3.14.2t에서 GIL 상태만 바꿔 검증한다. `PYTHON_GIL`이 실제 설정이고 `--expect-gil`은 설정이 맞는지 확인하는 옵션이다. 작업자에서도 같은 상태인지 검사한다. [빌드 선택](https://docs.astral.sh/uv/concepts/python-versions/#free-threaded-python), [GIL 설정](https://docs.python.org/3.14/howto/free-threading-python.html#the-global-interpreter-lock-in-free-threaded-python)

```sh
env PYTHON_GIL=0 uv run --python 3.14.2t python/bench.py --smoke --task cpu --models sequential threads processes asyncio --workers 4 --expect-gil off
env PYTHON_GIL=1 uv run --python 3.14.2t python/bench.py --smoke --task cpu --models sequential threads processes asyncio --workers 4 --expect-gil on
```

I/O 기능 검증은 `--task cpu`를 `--task io`로 바꾼다.

### GIL 켜짐·꺼짐 교차 실행

다음 명령으로 두 GIL 상태를 섞어 실행하는 절차를 작은 입력에서 확인한다. 스크립트가 같은 실행 파일로 두 측정 프로세스를 만들고 각각의 `PYTHON_GIL`을 설정·검사한다.

```sh
uv run --python 3.14.2t python/compare_gil.py --smoke --task cpu --models sequential threads processes asyncio --workers 4
uv run --python 3.14.2t python/compare_gil.py --smoke --task io --models sequential threads processes asyncio --workers 4
```

진행 단계의 본 측정 예정 명령은 아래와 같다. 아직 실행하지 않았다. 기본 CPU 입력은 N=200,000과 20,000에 작업 8개, I/O 입력은 대기 0.1초에 작업 40개다. 각 입력·방식·GIL 조합에 워밍업 1회와 본 측정 3회를 적용하므로 CPU는 64개, I/O는 32개 기록이 된다.

```sh
uv run --python 3.14.2t python/compare_gil.py --task cpu --models sequential threads processes asyncio --workers 4
uv run --python 3.14.2t python/compare_gil.py --task io --models sequential threads processes asyncio --workers 4
```

`--sizes`, `--sleep-s`, `--tasks`, `--compare-workers`, `--repeats`, `--seed`, `--output-dir`의 의미는 `bench.py`와 같다. 결과는 `gil-compare`가 들어간 새 파일로 저장하며 GIL 켜짐·꺼짐을 별도로 집계한다.

## 소스 조사: 한 인터프리터마다 GIL이 하나만 존재하는가

사람은 원래 의도가 "한 Python 인터프리터마다 한 개의 GIL만 존재한다"는 문장을 확인하는 것이었다고 정정하고, 실제 코드 조사를 요청했다. 기존의 여러 인터프리터 성능 비교 계획을 이 조사로 대체한다. 아래는 실험 런타임과 버전을 맞춘 상류 CPython `v3.14.2` 소스에서 확인한 내용이다.

정확히 정리하면 **GIL이 활성화된 CPython에서는, 같은 인터프리터에 속한 스레드들이 그 인터프리터에 연결된 GIL 하나를 공유한다.** 인터프리터마다 반드시 서로 다른 GIL을 하나씩 소유한다는 뜻은 아니다.

| 확인할 내용 | 소스 근거 | 확인 결과 |
|---|---|---|
| 스레드와 인터프리터의 연결 | [pystate.h:66–74](https://github.com/python/cpython/blob/v3.14.2/Include/cpython/pystate.h#L66-L74) | 스레드 상태는 `interp`로 현재 인터프리터를 가리킨다. |
| 인터프리터의 GIL 참조 | [pycore_interp_structs.h:104–113](https://github.com/python/cpython/blob/v3.14.2/Include/internal/pycore_interp_structs.h#L104-L113), [764–769](https://github.com/python/cpython/blob/v3.14.2/Include/internal/pycore_interp_structs.h#L764-L769) | 인터프리터의 `ceval` 안에 GIL을 가리키는 포인터가 하나 있다. |
| 자체 GIL의 저장 공간 | [pycore_interp_structs.h:844–845](https://github.com/python/cpython/blob/v3.14.2/Include/internal/pycore_interp_structs.h#L844-L845) | 자체 GIL 상태를 담는 `_gil`이 있으며, 사용하지 않을 수도 있다고 명시한다. |
| 스레드의 잠금 획득 경로 | [ceval_gil.c:310–324](https://github.com/python/cpython/blob/v3.14.2/Python/ceval_gil.c#L310-L324) | `take_gil()`은 스레드 상태의 인터프리터를 거쳐 그 GIL 참조를 사용한다. 같은 인터프리터의 스레드마다 새 GIL을 만들지 않는다. |
| 자체 GIL과 공유 GIL의 선택 | [pylifecycle.c:583–596](https://github.com/python/cpython/blob/v3.14.2/Python/pylifecycle.c#L583-L596), [ceval_gil.c:476–516](https://github.com/python/cpython/blob/v3.14.2/Python/ceval_gil.c#L476-L516) | 자체 GIL이면 그 인터프리터의 저장 공간을 연결하고, 공유 설정이면 메인 인터프리터의 GIL을 연결한다. |
| Free-threaded 실행 | [ceval_gil.c:312–316](https://github.com/python/cpython/blob/v3.14.2/Python/ceval_gil.c#L312-L316), [488–490](https://github.com/python/cpython/blob/v3.14.2/Python/ceval_gil.c#L488-L490) | 활성 값이 0이면 획득 절차에서 바로 반환한다. 자료구조의 존재와 GIL의 활성 여부는 다르다. |

즉, 한 인터프리터가 사용하는 GIL 참조는 하나지만 여러 인터프리터의 참조가 같은 GIL을 가리킬 수 있다. 공개 C API도 자체 GIL과 메인 인터프리터의 GIL 공유를 선택하게 한다. [공식 설정 문서](https://docs.python.org/3.14/c-api/subinterpreters.html#c.PyInterpreterConfig.gil)

이 결론은 자료구조·초기화·획득 경로를 읽어 확인한 것이다. 실행 시간으로 GIL 개수를 추정한 결과나 사람이 해설 없이 설명한 답으로 기록하지 않는다. 추가 본 측정은 하지 않았다.

## 경쟁 상태와 이벤트 루프 블로킹

다음 사례는 성능 비교와 따로 돌린다. 세 사례의 예상·판정 기준·수정 범위를 정하고 실행 틀을 작은 입력으로 검증했다.

| 시나리오 | 비교와 확인 방법 |
|---|---|
| 공유 카운터 | 락 없음/있음을 비교하고, 기대값·실제값·실패 횟수/시도 횟수를 기록 |
| 지연 초기화 싱글톤 | 여러 스레드가 동시에 초기화를 시도하게 하고, 생성 횟수와 반환 객체의 동일성을 확인 |
| 이벤트 루프 블로킹 | 주기적으로 깨어나는 코루틴과 블로킹 작업을 함께 실행하고, 예정 시각 대비 지연을 기록. `time.sleep`과 `await asyncio.sleep`을 비교하고 CPU 계산도 별도로 확인 |

재현하려고 읽기와 쓰기 사이에 대기나 동기화 지점을 넣었다면 무엇을 넣었는지 적는다. 수정한 뒤에는 같은 조건에서 기대값과 객체 동일성을 다시 확인한다.

### 공유 카운터의 문제 상황과 원인 예상

- 문제 상황: GIL이 켜진 같은 인터프리터에서 스레드 2개가 완료 건수를 한 번씩 늘린다. 초기 `completed`는 0이며 원하는 최종값은 2다. `previous = completed`와 `completed = previous + 1` 사이에 의도적으로 `time.sleep(0)`을 넣은 예제를 제시하고, 최종값이 1이 될 수 있는 실행 순서를 물었다. 실제 재현 결과가 아닌 준비 문답이다.
- 사람의 설명(요약): A가 실행되고 sleep을 호출하기 전에 B가 실행되면, 두 스레드가 모두 `completed`의 0을 각자의 지역변수 `previous`에 저장하므로 최종값이 1이 될 것이라고 설명했다.
- 에이전트 피드백: 두 스레드가 모두 0을 읽고 각각 1을 쓴다는 원인 설명은 맞다. B가 A의 sleep 호출 전에 실행되어야 하는 것은 아니다. A가 0을 읽고 sleep에서 GIL을 해제한 뒤, B도 0을 읽고 sleep에 들어가고, 이후 A와 B가 차례로 1을 쓰는 순서로도 발생한다. Python 코드를 동시에 실행하지 않아도 읽기·수정·쓰기 사이에 실행이 끼어들면 갱신이 유실될 수 있다.
- 락 범위에 대한 사람의 답(요약): `completed`를 최신화하는 코드까지 보호해야 하며, 그래야 오류가 있는 데이터를 읽지 않을 것이라고 설명했다.
- 에이전트 피드백: 쓰기를 마칠 때까지 보호한다는 끝점은 맞다. 읽은 0 자체는 그 시점의 정상값이다. 다른 스레드의 갱신이 끼어든 뒤에도 이전에 읽은 값으로 쓰는 것이 문제이며, 쓰기만 순서대로 실행해도 두 스레드가 이미 0을 읽었다면 갱신 유실이 남는다.
- 힌트 후 사람의 답(요약): `previous = completed`를 실행하기 전에 락을 잡아야 한다고 답했다. 같은 리소스에 두 스레드가 동시에 접근하는 것을 방지해야 하기 때문이라고 설명했다.
- 에이전트 피드백: 보호 범위는 읽기 직전부터 쓰기 직후까지이며, 이 예제의 `sleep(0)`도 그 사이에 포함된다. 여기서 겹치지 않게 하는 것은 읽기·수정·쓰기 전체 구간이다. GIL이 켜져 있어 Python 명령을 동시에 실행하지 않더라도 이 구간 사이에 다른 스레드의 작업이 끼어들 수 있다. 힌트를 받은 뒤 보호 범위의 시작과 끝을 답한 것으로 기록한다.
- 반복 실행에 대한 사람의 예상과 이유(요약): 최종값이 2가 나오는 경우도 있다고 답했다. 한 스레드의 갱신이 끝난 뒤 다른 스레드가 그 값을 읽는 순서로 실행될 수 있기 때문이라고 설명했다.
- 에이전트 피드백: 최종값은 실행 순서에 따라 달라질 수 있다. 정상값이 나온 시도가 있다는 사실이나 몇 번 오류가 재현되지 않았다는 사실만으로 경쟁 상태가 없다고 판단하지 않는다.

### 공유 카운터의 준비 조건과 실행법

기본 조건은 스레드 2개가 각각 한 번 증가시키는 시도 100회다. 각 시도마다 공유 카운터를 0으로 초기화하고 모든 작업자가 같은 락 하나를 받는다. 기대값은 2다. 읽기와 쓰기 사이의 `time.sleep(0)`은 재현을 돕기 위해 넣은 조건으로 기록한다. 시작 장벽은 읽기·쓰기와 락 바깥에서 작업자들이 준비됐는지 맞출 뿐, 같은 값을 읽게 강제하지 않는다.

사람은 진행 단계에서 `counter_kernels.py`의 `increment_candidate()`에 공유 락을 적용한다. 현재 이 함수는 락 없는 기본 함수를 그대로 호출한다. `candidate`라는 이름만으로 락이 적용됐다고 판단하지 않는다. 에이전트는 반복 실행·검증·환경·결과 저장을 맡는다.

작은 입력의 실행 틀 검증은 다음 명령으로 한다. 현재는 기본 함수인 `unlocked`만 검증했다.

```sh
uv run --python 3.14.2+gil python/counter_lab.py --smoke
env PYTHON_GIL=0 uv run --python 3.14.2t python/counter_lab.py --smoke --expect-gil off
```

`--smoke`는 스레드 2개·각 1회 증가·검증 3회로 고정하고 워밍업 `run: 0`도 저장한다. 전체 자동 검사 16개가 통과했고, 새 카운터 검사 4개는 GIL을 끈 빌드에서도 통과했다. 실행 틀의 락 검사는 테스트 안의 별도 기준 함수를 사용했으며, 사람이 수정할 `candidate`를 대신 구현하거나 검증한 것은 아니다.

| 작은 입력 검증 | 환경 | 원자료 |
|---|---|---|
| 일반 3.14.2, GIL 켜짐 | [환경](results/validation/2026-10-23T124901741997-counter-smoke-env.txt) | [JSONL](results/validation/2026-10-23T124901741997-counter-smoke-python-3.14.2.jsonl) |
| 3.14.2t, GIL 꺼짐 | [환경](results/validation/2026-10-23T124903889502-counter-smoke-env.txt) | [JSONL](results/validation/2026-10-23T124903889502-counter-smoke-python-3.14.2t.jsonl) |

각 파일의 4개 기록에서 요청한 증가 함수 호출이 모두 끝났고, 결과 판정·실제 GIL 상태·참여 스레드·환경·소스 해시를 확인했다. 기대값 불일치는 실행 틀의 오류와 구분한다. 이 검증으로 본 실행의 재현 빈도나 수정 완료를 판단하지 않는다.

수정한 뒤에는 다음 순서로 같은 조건의 기본 함수와 수정 대상을 비교한다. 아래 `candidate` 포함 명령과 본 실행 100회는 아직 수행하지 않았다.

```sh
uv run --python 3.14.2+gil python/counter_lab.py --smoke --cases unlocked candidate
uv run --python 3.14.2+gil python/counter_lab.py --cases unlocked candidate
```

조건마다 워밍업 1회와 본 실행 100회를 저장하므로 두 함수를 비교하면 총 202개 기록이 된다. 반복마다 함수의 실행 순서를 뒤집고 집계에서는 워밍업을 제외한다. `--workers`, `--increments`, `--trials`로 입력을 바꿀 수 있고, `--no-yield-between`은 인위적인 sleep을 제거한다. 조건을 바꿀 때는 결과 예상도 다시 남긴다.

### 카운터 결과의 판정과 보존

한 시도의 결과를 JSON 한 줄로 저장하며 `purpose: "race"`, `scenario: "counter"`로 구분한다. 작은 입력 검증에는 `validation: true`를 표시한다. 성능 비교에 섞지 않으며 `wall_s`를 기록하지 않는다. 원자료와 환경은 같은 시각 접두사의 새 파일에 저장하고, 검증 파일은 `results/validation/`에 둔다.

| 필드 | 의미 |
|---|---|
| `case`, `variant` | 실행한 증가 함수와 GIL·sleep 조건 |
| `size`, `params.increments_per_worker` | 전체 증가 호출 수와 스레드당 호출 수 |
| `params.yield_between`, `params.start_barrier` | 인위적 대기와 시작 장벽의 사용 여부 |
| `check`, `expected_check` | 최종 카운터와 기대값 |
| `finished_calls` | 예외 없이 끝난 증가 함수 호출 수 |
| `valid` | 모든 요청 호출이 예외 없이 끝났는지 |
| `correct` | 실행이 유효하고 최종 카운터가 기대값과 같은지 |
| `worker_results` | 스레드별 OS ID·이름·실제 GIL 상태·완료 호출 수·예외 |

`valid: true`인데 `correct: false`이면 기대값 불일치가 관찰된 것이다. `valid: false`인 실행 오류는 불일치 횟수에 섞지 않고 원인부터 해결한다. 기본 함수가 모든 시도에서 정상값을 내더라도 경쟁 상태가 없다고 결론 내리지 않는다. 수정 대상은 기대값이 모두 맞는지와 실제 락의 공유·적용 범위를 함께 확인한다. 수정 대상에서 불일치가 나오면 원자료를 보존하고 종료 코드 1로 알린다.

### 지연 초기화 싱글톤의 문제 상황과 원인 예상

- 문제 상황: GIL이 켜진 같은 인터프리터에서 스레드 2개가 처음 공유 객체를 요청한다. 초기 `instance`는 `None`이며, `None`이면 객체를 생성해 저장하고 반환한다. 생성 함수는 `time.sleep(0)`으로 대기할 수 있다. 목표는 객체가 한 번만 생성되는 것이다. 아래 예상은 실행 결과를 보기 전의 답이다.
- 사람의 예상과 이유(요약): 객체가 두 개 생성될 수 있다고 답했다. 앞선 카운터 문제처럼 두 스레드가 모두 `None`인 상태에 접근할 수 있기 때문이라고 설명했다.
- 에이전트 피드백: 객체가 공유 변수에 저장되기 전에 두 스레드가 모두 `None`이라고 판단하고 각자 생성 함수를 호출할 수 있다는 설명으로 구체화한다. 확인과 생성·저장 사이의 실행 교대가 문제다.
- 락 위치에 대한 사람의 답: `None` 확인이 한 번뿐인 코드에서 검사 전에 락을 잡아야 한다고 답했다.
- 에이전트 피드백: 모든 요청 스레드가 같은 락을 사용하고, 검사부터 생성·저장까지 보호한다. 그러면 다음 스레드는 앞선 스레드가 저장한 객체를 확인할 수 있다. 생성 직전에만 락을 잡으면 이미 통과한 `None` 검사의 판단이 남는다. 이 조건의 락 시작 위치를 답한 것으로 기록하며, 실제 수정과 최종 설명은 진행·정리 단계에서 확인한다. [Lock 문서](https://docs.python.org/3.14/library/threading.html#lock-objects)

### 지연 초기화 싱글톤의 준비 조건과 실행법

기본 조건은 스레드 2개가 각각 한 번 객체를 요청하는 시도 100회다. 각 시도마다 `instance = None`과 공유 락 하나를 새로 만든다. 시작 장벽은 함수 호출 전에 작업자들의 준비를 맞추며, 두 스레드가 모두 `None`을 읽도록 강제하지 않는다. 생성 함수 안의 `time.sleep(0)`은 실행 교대가 일어나기 쉽게 넣은 조건이다. 이 조건의 재현 빈도를 실제 서비스의 발생 확률로 해석하지 않는다.

사람은 진행 단계에서 `singleton_kernels.py`의 `get_candidate()`에 공유 락을 적용한다. 현재는 락 없는 `get_unlocked()`를 호출하는 기본 동작이다. 에이전트는 반복 실행·검증·환경·결과 저장을 맡는다.

에이전트가 제안한 판정 기준은 생성 횟수가 1이고 모든 호출이 공유 변수에 저장된 그 객체를 반환하는 것이다. 두 개를 생성했어도 마지막에 저장된 객체를 모두 반환할 수 있으므로 두 조건을 함께 검사한다. 생성·반환 객체의 참조를 판정 끝까지 유지하며, 객체 ID는 같은 시도 안에서만 비교한다. 생성 기록용 별도 락은 기록 목록만 보호하며 `None` 검사나 공유 변수 저장을 보호하지 않는다. [객체 ID 문서](https://docs.python.org/3.14/library/functions.html#id)

작은 입력의 실행 틀 검증은 다음 명령으로 한다.

```sh
uv run --python 3.14.2+gil python/singleton_lab.py --smoke
env PYTHON_GIL=0 uv run --python 3.14.2t python/singleton_lab.py --smoke --expect-gil off
```

`--smoke`는 스레드 2개·각 1회 요청·검증 3회로 고정하고 워밍업 `run: 0`도 저장한다. 2026-10-23에는 기본 함수인 `unlocked`만 아래 두 조건에서 검증했다. 각 파일의 4개 기록에서 요청 완료·객체 판정·스레드·GIL 상태·환경·소스 해시를 확인했다. 본 실행의 재현 빈도나 수정 완료를 판단하는 결과는 아니다.

| 작은 입력 검증 | 환경 | 원자료 |
|---|---|---|
| 일반 3.14.2, GIL 켜짐 | [환경](results/validation/2026-10-23T132249104268-singleton-smoke-env.txt) | [JSONL](results/validation/2026-10-23T132249104268-singleton-smoke-python-3.14.2.jsonl) |
| 3.14.2t, GIL 꺼짐 | [환경](results/validation/2026-10-23T132256145844-singleton-smoke-env.txt) | [JSONL](results/validation/2026-10-23T132256145844-singleton-smoke-python-3.14.2t.jsonl) |

싱글톤 준비 시점의 전체 자동 검사 21개가 통과했고, 새 싱글톤 검사 5개는 GIL을 끈 빌드에서도 통과했다. 두 번 생성하고도 같은 객체를 반환하는 경우, 한 번 생성하고 다른 객체를 반환하는 경우를 별도 검사로 확인했다. 테스트 안의 락 기준 함수는 실행 틀 검증용이며, 사람이 수정할 `candidate`를 대신 구현한 것은 아니다.

수정 대상과 비교하는 아래 명령은 진행 단계에서 코드를 고친 뒤 실행한다. `candidate` 비교와 본 실행 100회는 아직 하지 않았다.

```sh
uv run --python 3.14.2+gil python/singleton_lab.py --smoke --cases unlocked candidate
uv run --python 3.14.2+gil python/singleton_lab.py --cases unlocked candidate
```

두 함수를 비교하면 조건마다 워밍업 1회와 본 실행 100회, 총 202개 기록이 된다. 반복마다 함수의 실행 순서를 뒤집고 집계에서는 워밍업을 제외한다. `--workers`, `--trials`로 조건을 바꿀 수 있고 `--no-yield-in-factory`는 인위적인 sleep을 제거한다. 조건 변경 전에는 결과를 다시 예상한다.

### 싱글톤 결과의 판정과 보존

한 시도를 JSON 한 줄에 저장하며 `purpose: "race"`, `scenario: "singleton"`으로 구분한다. `size`는 전체 요청 수이고 `params.requests_per_worker`는 1이다. `params`에는 생성 중 대기·시작 장벽·생성 기록용 락의 사용 여부도 남긴다. 작은 입력 검증은 `validation: true`와 함께 `results/validation/`에 저장한다. 성능 비교에 섞지 않으며 `wall_s`는 기록하지 않는다.

| 필드 | 의미 |
|---|---|
| `check.created_count` | 생성 함수가 만들어 기록한 객체 수. 기대값은 1 |
| `check.returned_unique` | 완료한 호출들이 반환한 서로 다른 객체 수. 기대값은 1 |
| `check.all_returned_published` | 모든 요청이 끝났고, 반환값이 모두 최종 저장 객체와 동일하며 `None`이 아닌지 |
| `check.published_was_created` | 최종 저장 객체가 생성 함수에서 만든 객체인지 |
| `expected_check` | 생성 수·반환 객체 수·동일성의 기대값 |
| `created_ids`, `published_id` | 생성된 객체들의 ID와 최종 저장 객체 ID |
| `finished_calls`, `valid` | 예외 없이 완료한 요청 수와 모든 요청이 완료됐는지 |
| `correct` | 실행이 유효하고 `check` 전체가 기대값과 같은지 |
| `worker_results` | 스레드별 OS ID·이름·GIL 상태·반환 객체 ID·완료 호출 수·예외 |

`valid: true`인데 `correct: false`이면 생성·반환 조건의 불일치다. 실행 오류는 따로 집계하고 원인을 확인한다. 수정 대상에서 불일치가 나오면 기록을 보존한 뒤 종료 코드 1로 알린다. 반복 실행에서 모두 정상이어도 경쟁 상태가 없다는 증명으로 삼지 않으며, 실제 락의 공유·적용 범위를 함께 검토한다.

### 이벤트 루프 블로킹의 지연 예상

- 문제 상황: 같은 이벤트 루프에서 B가 `await asyncio.sleep(0.1)`로 기다리기 시작한 직후 A가 `time.sleep(1)`을 호출한다. 예정 시각에 처리해야 할 상태 갱신이 밀리는 상황이다. 스케줄링 오차를 무시한 예상부터 정하며, 실제 지연은 아직 측정하지 않았다.
- 사람의 예상(요약): B는 0.1초 뒤 재개되기를 기대하지만 실제로는 약 1초 뒤 재개되므로, 예정 시각보다 약 0.9초 늦어진다고 답했다.
- 에이전트 피드백: 시작부터 재개까지의 시간과 예정 시각을 넘긴 지연을 구분한 답이다. 지연은 `실제 재개 시각 - 예정 시각`으로 기록한다. 약 0.9초라는 예상은 A가 B의 대기 시작 직후 실행되고 다른 지연은 무시한 조건에 해당한다.
- 비동기 대기에 대한 사람의 예상과 이유(요약): 지연이 없을 것으로 예상했다. A가 타이머를 시작한 직후 실행 흐름이 이벤트 루프로 돌아오므로 B를 재개할 수 있기 때문이라고 설명했다.
- 에이전트 피드백: A가 `await asyncio.sleep(1)`에서 대기하면 루프가 다른 작업을 실행할 수 있고, B는 자신의 0.1초 대기가 끝난 뒤 재개할 수 있다. 수치 예상은 A 때문에 추가되는 지연이 거의 없다는 뜻으로 구체화한다. 실제 지연이 정확히 0이라는 보장은 아니므로 대조군의 타이머·스케줄링 오차와 비교한다. [asyncio.sleep 문서](https://docs.python.org/3.14/library/asyncio-task.html#asyncio.sleep)
- 합의한 판정 기준(2026-10-23): 에이전트가 제안한 10ms 허용치를 사람이 사용하기로 동의했다. A가 없는 대조군과 비동기 대기의 첫 재개 지연 중앙값 차이의 절댓값이 0.01초 이내이면, A 때문에 추가되는 지연이 거의 없다는 예상과 맞는 것으로 본다. 이 범위를 벗어나면 정한 수치 기준과 맞지 않는 것으로 기록하고 실행 순서·부하·원자료를 확인한다. 10ms는 측정 전에 정한 허용치이며 실측 오차나 신뢰구간이 아니다. 이 동의를 사람이 판정 기준을 독립적으로 설계했거나 최종 이해 확인을 마친 근거로 기록하지 않는다.

### 이벤트 루프 블로킹의 준비 조건과 실행법

같은 이벤트 루프의 B는 시작 시각을 기준으로 0.1초 간격의 예정 시각 12개를 갖는다. B가 첫 대기에 들어간 뒤 A를 실행한다. 아래 네 조건을 비교하며, 모두 같은 B 설정과 런타임을 사용한다. A의 시작·종료 시각과 각 B의 재개 시각도 남겨 실제 실행 순서를 확인한다.

| 조건 | A의 작업 | 예상 또는 역할 |
|---|---|---|
| `idle` | A Task를 만들지 않음 | 타이머·스케줄링 지연을 관찰하는 대조군 |
| `blocking` | `time.sleep(1)` | 사람은 B의 첫 재개가 예정 시각보다 약 0.9초 늦을 것으로 예상 |
| `candidate` | 사람이 비동기 대기로 수정할 함수 | 수정 후 A 때문에 추가되는 지연이 거의 없을 것이라는 사람의 예상과 비교 |
| `cpu` | N=200,000의 소수 계산을 8회, 중간 양보 없이 실행 | 앞선 문답에서 답한 대로, 계산이 B의 예정 시각을 넘겨 계속되면 계산이 끝나야 B를 재개할 수 있는지 확인 |

사람은 진행 단계에서 `loop_kernels.py`의 `candidate_wait()`를 같은 대기 시간을 유지하는 비동기 대기로 수정하고, 다른 Task가 실행될 수 있는 지점을 설명한다. 현재 이 함수는 블로킹 대기를 호출한다. 함수에 `async def`나 `await`가 있다는 사실만으로 내부의 `time.sleep()`이 비동기 대기가 되지는 않는다. 에이전트는 B의 주기 실행·검증·환경·원자료 저장·집계를 맡는다.

CPU 조건의 입력·알고리즘은 앞선 CPU 비교에서 가져온다. CPU 작업을 정확히 1초 동안 실행한다고 가정하지 않고 A의 실제 실행 구간을 기록한다. 서로 다른 작업인 CPU와 sleep의 전체 소요시간으로 방식의 우열을 정하지 않는다.

작은 입력 검증은 다음과 같다. 기본 조건은 `idle blocking cpu`이며, 사람이 수정할 `candidate`는 포함하지 않는다.

```sh
uv run --python 3.14.2+gil python/loop_lab.py --smoke
env PYTHON_GIL=0 uv run --python 3.14.2t python/loop_lab.py --smoke --expect-gil off
```

`--smoke`는 B 주기 0.001초·4회, A의 sleep 0.002초, CPU N=100·1회로 줄인다. 조건마다 워밍업 1회와 검증 1회, 총 6개 기록을 남긴다. 이 값으로 0.9초 지연이나 비동기 대기의 수치 가설을 판단하지 않는다.

2026-10-23에 다음 두 조건의 검증을 마쳤다. 각 파일의 6개 기록에서 반환값·B 기록 수·예정 시각·지연 계산·A/B 실행 위치·GIL 상태·조건 순서·환경·소스 해시를 확인했다. A가 있는 조건에서는 작업용 Task 2개가 같은 루프·OS 스레드에서 실행됐고, 대조군에는 B만 있었다.

| 작은 입력 검증 | 환경 | 원자료 |
|---|---|---|
| 일반 3.14.2, GIL 켜짐 | [환경](results/validation/2026-10-23T133714366280-loop-smoke-env.txt) | [JSONL](results/validation/2026-10-23T133714366280-loop-smoke-python-3.14.2.jsonl) |
| 3.14.2t, GIL 꺼짐 | [환경](results/validation/2026-10-23T133721718318-loop-smoke-env.txt) | [JSONL](results/validation/2026-10-23T133721718318-loop-smoke-python-3.14.2t.jsonl) |

이벤트 루프 준비 시점의 전체 자동 검사 27개가 통과했다. 새 검사 6개는 GIL을 끈 빌드에서도 통과했다. 비동기 대기의 동작 검사는 테스트 안의 별도 기준 함수를 사용했으며, 사람이 수정할 `candidate`는 기본 블로킹 동작으로 남겼다.

진행 단계에서 사람이 대기 함수를 수정한 뒤 작은 입력 검증과 본 측정을 수행한다. 아래 명령은 아직 실행하지 않았다.

```sh
uv run --python 3.14.2+gil python/loop_lab.py --smoke --cases idle blocking candidate cpu
uv run --python 3.14.2+gil python/loop_lab.py --cases idle blocking candidate cpu
```

본 측정은 조건마다 워밍업 1회와 본 실행 3회, 총 16개 기록이다. 첫 조건 순서는 `--seed`로 섞고 이후 반복마다 뒤집는다. `--period-s`, `--ticks`, `--sleep-s`, `--n`, `--cpu-jobs`, `--repeats`로 입력을 바꿀 수 있으며 변경 전에는 결과를 다시 예상한다. 이 준비가 끝나도 사람의 코드 수정·첫 결과 해석·최종 설명은 진행·정리 단계의 할 일로 남는다.

### 이벤트 루프 지연의 측정과 보존

B의 예정 시각은 `시작 시각 + 순번 × 주기`로 고정한다. 늦게 깨어났다고 다음 예정 시각을 뒤로 옮기지 않는다. 밀린 순번은 `await asyncio.sleep(0)`으로 실행 흐름을 양보하며 차례로 기록한다. 따라서 블로킹 뒤의 여러 큰 지연은 그때마다 새로 블로킹됐다는 뜻이 아니라, 기존 예정 시각들을 넘긴 기록일 수 있다.

예정·실제 시각에는 같은 이벤트 루프의 단조 시계인 `loop.time()`을 사용한다. 단조 시계는 시각 차이를 재기 위한 시계이며 날짜·벽시계 시각과 구분한다. `lag_s = resumed_s - due_s`로 계산하고 원래 값을 그대로 보존한다. 시계 해상도 때문에 작은 음수가 관찰되더라도 임의로 0으로 바꾸지 않는다. [이벤트 루프 시계와 타이머](https://docs.python.org/3.14/library/asyncio-eventloop.html#asyncio.loop.time)

한 번 실행한 A·B 전체를 JSON 한 줄에 기록한다. `purpose: "latency"`, `scenario: "event_loop"`로 구분하며 작은 입력에는 `validation: true`를 남긴다. 검증 파일은 `results/validation/`, 본 측정은 `results/`에 환경 파일과 같은 시각 접두사로 새로 저장한다.

| 필드 | 의미 |
|---|---|
| `case`, `variant` | 대조군·블로킹·수정 대상·CPU 조건과 GIL 상태 |
| `workers`, `params.loop_threads` | 관찰 대상 Task 수의 상한(A·B 2개, 대조군은 B 1개)과 이벤트 루프 OS 스레드 1개 |
| `size`, `params` | B의 예정 실행 횟수와 주기·A 작업 입력·측정 조건 |
| `heartbeats[].due_s`, `resumed_s`, `lag_s` | B의 시작을 기준으로 한 예정 시각·실제 재개 시각·그 차이 |
| `action_events` | A의 시작·종료 시각. 예외로 끝난 경우도 종료 지점을 남김 |
| `pid`, `native_thread_id`, `loop_id`, `task_id`, `task_name` | 각 기록 지점의 프로세스·OS 스레드·이벤트 루프·Task. 같은 JSON 행 안에서 비교 |
| `first_lag_s`, `max_lag_s` | 첫 번째 B의 지연과 해당 실행에서 관찰한 최대 지연 |
| `action_wall_s`, `wall_s` | A의 실제 실행 구간과 루프 생성·A/B 완료·루프 종료를 포함한 전체 시간 |
| `check`, `expected_check`, `valid`, `errors` | A의 반환값·B 기록 수의 검증, 실행 위치·예외 확인 결과 |
| `phase_ok`, `comparison_valid` | A가 B의 첫 예정 시각 전에 시작했는지, 실행 검증과 이 조건을 모두 만족했는지 |
| `cpu_parent_s`, `cpu_children_s`, `cpu_percent` | 기존 성능 측정과 같은 `getrusage` 방식의 CPU 관찰값 |

`valid`는 지연이 예상과 맞는지를 뜻하지 않는다. 함수 반환값·기록 수·같은 이벤트 루프와 스레드에서 실행됐는지를 확인한 값이다. 작업 오류는 보존한 뒤 중단한다. A의 시작이 첫 예정 시각을 넘긴 기록도 보존하되 지연 비교에서 제외하고, 같은 조건을 새 파일로 다시 측정한다.

워밍업과 비교 조건을 만족하지 않은 실행을 제외하고, 같은 런타임·GIL·작업·입력끼리 `first_lag_s`와 실행별 `max_lag_s`의 중앙값·최솟값·최댓값을 구한다. 모든 재개 시각을 한데 모아 서로 독립적인 반복처럼 취급하지 않는다. 전체 `wall_s`에는 B의 관찰 구간도 들어가므로 지연 가설은 `first_lag_s`와 실행 순서로 판단한다.

## 결과 정리

### 첫 CPU 측정 (2026-10-23)

일반 CPython 3.14.2, GIL 켜짐, Apple M2 Pro, macOS 26.5에서 실행했다. 전원은 AC 연결 상태였다. 각 방식은 같은 소수 계산 작업 8개를 수행했으며, 풀 생성·결과 수집·종료까지 포함했다. 조건마다 워밍업 1회와 본 측정 3회를 실행하고 순서를 바꿨다.

- [환경 기록](results/2026-10-23T070246879341-benchmark-env.txt)
- [측정 원자료](results/2026-10-23T070246879341-benchmark-python-3.14.2-gil-on.jsonl)
- [CPU 사용률 관찰](results/2026-10-23T070246879341-benchmark-cpu-observation.txt)

워밍업을 포함한 24개 기록 모두 검증을 통과했다. N=200,000의 `check`는 143,872, N=20,000은 18,096이었다. 아래 표는 워밍업을 제외한 집계이며, 배수는 같은 N의 순차 중앙값을 해당 방식의 중앙값으로 나눈 값이다.

| N | 방식 | 작업자 상한 | 중앙값(초) | 최솟값~최댓값(초) | 순차 대비 배수 |
|---|---|---:|---:|---:|---:|
| 200,000 | 순차 | 1 | 1.473241 | 1.469964~1.485752 | 1.000 |
| 200,000 | 스레드 | 4 | 1.493515 | 1.481439~1.502863 | 0.986 |
| 200,000 | 프로세스 | 4 | 0.464923 | 0.463852~0.469657 | 3.169 |
| 20,000 | 순차 | 1 | 0.068357 | 0.065260~0.069657 | 1.000 |
| 20,000 | 스레드 | 4 | 0.065934 | 0.065854~0.070596 | 1.037 |
| 20,000 | 프로세스 | 4 | 0.095484 | 0.094376~0.098604 | 0.716 |

측정 중 `top -l 3 -s 1 -n 0`으로 전체 시스템의 CPU 사용률을 세 번 관찰했다. 개별 방식의 실행 구간과 연결하지 않았고 다른 앱의 사용량도 포함하므로, 방식별 코어 사용량이나 배경 부하가 일정했다는 근거로 쓰지 않는다. 관찰 명령 자체의 부하도 포함된다.

코드는 커밋 `84680f5` 이후의 미커밋 상태였으며, 측정에 사용한 소스 해시를 환경 파일에 남겼다. 작은 입력 검증 때의 소스와 일치함을 확인했다.

### 작은 CPU 작업의 가설 판단

- 사람의 첫 판단(요약): 판단 기준을 바꾸는 것이 아니라, N=20,000에서도 프로세스 4개가 더 빠를 것이라는 가설이 틀렸다고 기록하는 것이 맞다고 지적했다.
- 에이전트 피드백: 기존 판단 기준을 그대로 적용한다. 프로세스의 중앙값은 0.095484초로 순차 0.068357초와 스레드 0.065934초보다 컸다. 프로세스의 최솟값도 나머지 두 방식의 최댓값보다 컸으므로, 반복마다 빠른 쪽이 바뀌면 보류한다는 조건에 해당하지 않는다. 이번 환경과 작업량에서 작은 작업에 대한 가설은 틀렸다. 최초 예상과 판단 기준은 그대로 남긴다.
- 사람의 첫 원인 해석: 프로세스 생성에 소요되는 시간이 순차 실행 시간보다 길었기 때문이라고 답했다.
- 에이전트 피드백: 이번 측정은 생성·작업 전달·계산·결과 수집·종료를 포함한 전체 시간이며, 생성 시간만 따로 재지 않았다. 따라서 생성 시간이 순차 실행 시간보다 길었다고 확정할 수 없다. 검토할 설명은 프로세스 방식의 추가 비용이 병렬 계산으로 절약한 시간보다 컸다는 것이다. 추가 비용이 순차 실행 전체 시간보다 작아도 프로세스 방식이 더 느릴 수 있다. 각 비용의 크기와 기여는 아직 확인하지 않았다.

- 변형 질문: 순차 계산이 70ms, 병렬 계산이 20ms인 가상의 조건에서 추가 비용이 얼마를 넘으면 프로세스 방식이 더 느려지는지 물었다. 사람은 50ms를 넘어야 한다고 답했다.
- 에이전트 피드백: 절약한 계산시간은 70−20=50ms다. 추가 비용이 50ms면 전체 시간이 같고, 이를 넘으면 더 느리다. 설명을 보충한 뒤 가상의 조건에서 비교 기준을 적용하는 답을 확인했다. 실제 측정의 추가 비용을 분리해 확인한 것은 아니다.

### 기본 CPU 작업의 해석

- 사람의 첫 원인 해석(요약): 작업 8개를 순차 처리하는 시간이 프로세스를 생성하고 작업 2개를 순차 처리하는 시간보다 길었기 때문이라고 설명했다.
- 에이전트 피드백: 작업이 균등하게 분배되면 프로세스 4개가 각각 작업 2개를 처리한다는 설명이다. 이 경우 병렬 계산으로 절약한 시간과 프로세스 방식의 추가 비용을 비교할 수 있다. 전체 측정에는 생성뿐 아니라 작업 전달·결과 수집·종료도 포함된다. 작업자별 처리 개수는 기록하지 않았으므로, 실제로 정확히 2개씩 처리했는지는 미확인이다.
- 에이전트의 가설 대조: N=200,000에서는 프로세스 중앙값 0.464923초가 순차 1.473241초와 스레드 1.493515초보다 작았다. 프로세스가 두 방식보다 빠를 것이라는 최초 가설은 이번 측정과 일치한다. 각 비용을 분리해 확인한 결과나 다른 작업량에서도 성립한다는 결론은 아니다.

### 다음 비교 준비: 작업자 4개에서 8개로 늘리기

- 사람은 다음에 바꿀 조건으로 작업자 수 증가를 선택했다.
- 비교할 조건은 스레드·프로세스의 작업자 상한 4개와 8개다. 총작업 수는 8개, N은 200,000과 20,000으로 유지한다. GIL 상태·알고리즘·측정 구간도 유지하며 순차 실행의 작업자 수는 1이다.
- N=200,000에 대한 사람의 예상과 이유(요약): 작업이 8개이므로 프로세스를 4개에서 8개로 늘리면 처리 시간이 줄어들 것으로 예상했다. 순차 실행과 스레드 방식의 처리 시간은 거의 달라지지 않을 것으로 예상했다. 처음 말한 "나머지"는 이 두 방식의 처리 시간을 뜻하며, 프로세스 생성·전달·종료 비용을 뜻한 것은 아니라고 확인했다.
- N=20,000에 대한 사람의 예상과 이유(요약): 동시에 실행할 수 있는 작업 수가 4개에서 8개로 늘어나므로, 프로세스 8개가 전체 작업 8개를 이전보다 빨리 처리할 것으로 예상했다.
- 진행 단계에서 사람이 수정할 범위는 `models.py`의 `WORKERS`를 4에서 8로 바꾸는 것이다. 이후 작은 입력으로 검증하고, 생성·결과 수집·종료를 포함한 전체 시간으로 예상과 비교한다. 현재 코드는 4이며, 작업자 8개의 본 측정은 아직 실행하지 않았다.
- 사람은 현재 시작 전 준비를 하는 중이 아니었는지 확인했다. 에이전트가 준비 완료로 판단해 첫 본 측정을 실행하고 다음 코드 수정까지 요청하며 단계를 앞서간 점을 정정했다. 현재는 준비를 이어가며, 추가 코드 수정과 본 측정은 진행 단계의 할 일로 남긴다. 이미 실행한 첫 본 측정은 실제 기록으로 보존한다.

전체 범위의 시작 전 준비를 마쳤다. 다음은 사람이 맡은 코드 수정과 추가 본 측정이며, 전체 실험과 최종 학습 확인은 진행 중이다.

### CPU 작업자 4개·8개 비교 (2026-10-23)

- 사람의 변경 설명: `WORKERS`를 8로 수정했다고 알리며, 총작업량은 유지하면서 작업자 수를 4개에서 8개로 늘리면 처리 시간이 줄어드는지 비교하려는 것이라고 설명했다.
- 저장 확인: 에이전트가 읽은 디스크 파일은 `WORKERS = 4`였고 Git 변경도 없었다. 이 차이를 알린 뒤 사람이 지정한 값 8을 에이전트가 저장했다. 사람의 수정 의도·설명과 에이전트의 저장 작업을 구분한다.
- 검증: `test_bench.py`의 자동 검사 7개와 작은 입력 실행 10개가 통과했다. `--compare-workers 4`가 두 N에 각각 순차 1개·스레드 4개/8개·프로세스 4개/8개를 만들고, 각 조건의 총작업 수는 8개임을 확인했다.
- 실행: 일반 CPython 3.14.2, GIL 켜짐, Apple M2 Pro의 물리·논리 CPU 각 12개(성능 8개·효율 4개), macOS 26.5, AC 전원에서 측정했다. 기준 커밋은 `17b6317`이며 `models.py`가 미커밋 상태였다. 작은 입력과 본 측정의 실행 소스 해시는 일치했다.

실행 명령은 `uv run --offline --no-cache --python 3.14.2+gil python/bench.py --compare-workers 4`다. 작은 입력에는 `--smoke`를 추가했다. 각 조건의 풀 생성·작업 전달·계산·결과 수집·종료를 포함하며, 개별 비용은 분리해 측정하지 않았다.

- 작은 입력: [환경](results/validation/2026-10-23T194730696419-smoke-env.txt), [원자료](results/validation/2026-10-23T194730696419-smoke-python-3.14.2-gil-on.jsonl)
- 본 측정: [환경](results/2026-10-23T194814493154-benchmark-env.txt), [원자료](results/2026-10-23T194814493154-benchmark-python-3.14.2-gil-on.jsonl), [측정 전후 CPU·전원·열 상태](results/2026-10-23T194814493154-benchmark-cpu-context.txt)

워밍업 10개와 본 측정 30개를 합친 40개 기록 모두 검증을 통과했다. N=200,000의 `check`는 143,872, N=20,000은 18,096이다. 아래는 워밍업을 제외한 조건별 3회의 집계다.

| N | 방식 | 작업자 상한 | 중앙값(초) | 최솟값~최댓값(초) | CPU 사용량 중앙값(%) |
|---|---|---:|---:|---:|---:|
| 200,000 | 순차 | 1 | 1.619155 | 1.596569~1.652642 | 99.8 |
| 200,000 | 스레드 | 4 | 1.610381 | 1.602352~1.634811 | 100.1 |
| 200,000 | 스레드 | 8 | 1.607350 | 1.590827~1.639660 | 100.5 |
| 200,000 | 프로세스 | 4 | 0.495228 | 0.494925~0.495264 | 393.6 |
| 200,000 | 프로세스 | 8 | 0.347412 | 0.343377~0.357727 | 721.4 |
| 20,000 | 순차 | 1 | 0.075601 | 0.068381~0.081071 | 99.8 |
| 20,000 | 스레드 | 4 | 0.073670 | 0.072139~0.076167 | 100.3 |
| 20,000 | 스레드 | 8 | 0.077312 | 0.076493~0.078507 | 100.3 |
| 20,000 | 프로세스 | 4 | 0.118923 | 0.117920~0.119483 | 377.6 |
| 20,000 | 프로세스 | 8 | 0.133203 | 0.131420~0.141810 | 698.2 |

CPU 사용량은 부모와 회수된 자식 프로세스의 CPU 시간 합계를 경과 시간으로 나눈 값이며, 논리 CPU 하나를 계속 사용하면 약 100%인 기준이다. 특정 순간에 실제로 실행한 코어 수나 시스템 전체 사용률을 직접 센 값은 아니다.

측정 한계: 다른 앱의 배경 부하를 통제하지 못했다. 배치 전후 `top`의 두 번째 스냅샷에서 시스템 CPU 유휴 비율은 각각 82.52%, 84.12%였다. 두 시점의 관찰로 측정 중 부하가 일정했다고 판단하지 않는다. 전후 모두 AC 연결 상태였고 열·성능 경고 기록은 없었다. 이전 첫 측정과 이번 측정의 시간을 합쳐 집계하지 않는다.

### 작업자 수 비교의 첫 해석: 프로세스

- 사람의 가설 판단: N=200,000에서는 예상이 맞았지만 N=20,000에서는 틀렸다고 답했다.
- 사람의 첫 원인 해석(요약): 작은 작업에서는 프로세스를 늘리면서 생긴 추가 비용이 병렬 처리로 절약한 시간보다 컸던 것 같다고 설명했다.
- 에이전트의 측정 대조: N=200,000의 프로세스 중앙값은 4개 0.495228초에서 8개 0.347412초로 약 29.8% 줄었다. N=20,000은 0.118923초에서 0.133203초로 약 12.0% 늘었다. 각 N에서 본 측정 3회 모두 같은 순서였고 두 조건의 시간 범위도 겹치지 않았다. 따라서 반복마다 빠른 쪽이 바뀌는 경우의 판단 보류 기준에 해당하지 않으며, 사람의 가설 판단은 이번 결과와 맞는다.
- 에이전트 피드백: 추가 비용을 병렬 처리로 절약한 시간과 비교한 설명은 타당한 원인 가설이다. 다만 전체 시간만 측정했으므로 생성·전달·종료 비용과 계산시간의 기여를 각각 확인한 것은 아니다. 배경 부하의 영향도 분리하지 못했다. 작업자 수를 늘렸을 때 관찰한 변화와 그 원인에 대한 추론을 구분해 남긴다.

### 작업자 수 비교의 첫 해석: 스레드와 GIL의 적용 범위

- 사람의 첫 해석(요약): 같은 Python 인터프리터의 스레드들은 GIL 하나를 공유하므로, 여러 스레드가 있어도 동시에 CPU를 점유할 수 있는 스레드는 하나라고 설명했다. 따라서 GIL을 켠 상태에서 스레드 수를 늘려도 순차 실행과 비슷한 결과가 나온다고 이해했다.
- 사람의 추가 질문: CPU를 점유하는 작업의 스레드는 항상 GIL을 소유해야 하는지 물었다.
- 에이전트 피드백: 이번처럼 Python 루프에서 소수 계산을 수행하는 조건의 핵심 설명은 맞다. 다만 GIL이 켜진 같은 인터프리터에서 한 번에 하나로 제한되는 것은 Python 바이트코드를 실행하는 스레드다. 모든 CPU 연산을 GIL이 제한한다고 일반화하지 않는다. Python 객체나 C API에 접근할 필요가 없는 네이티브 계산 구간에서는 확장 모듈이 GIL을 해제하고 계속 CPU를 사용할 수 있다. 모든 C 함수가 자동으로 GIL을 해제하는 것은 아니다. [CPython 스레드와 GIL 문서](https://docs.python.org/3.14/c-api/threads.html#detaching-the-thread-state-from-extension-code)
- 자료로 확인한 예: `hashlib`는 생성자나 `update()`에 한 번에 2,047바이트를 넘는 데이터를 전달하면 해시 계산 중 GIL을 해제한다고 명시한다. 이 구간은 CPU 계산이면서 GIL을 놓는 경우다. 네이티브 계산을 마치고 Python 실행으로 돌아올 때는 GIL을 다시 획득한다. 이는 문서로 확인한 보충 예이며 이번에 해시 성능을 측정한 것은 아니다. [hashlib 문서](https://docs.python.org/3.14/library/hashlib.html#hash-algorithms)
- 측정과의 연결: N=200,000의 스레드 4개·8개 중앙값은 각각 1.610381초·1.607350초이며 범위가 겹친다. CPU 사용량 중앙값도 각각 약 100.1%·100.5%로, 논리 CPU 하나를 계속 사용하는 기준에 가깝다. 이번 작업에서 스레드를 늘려 계산을 병렬화하지 못했다는 설명과 부합하지만, 모든 CPU 작업에서 스레드가 효과 없다는 결론으로 확장하지 않는다.

- 추가 보충: 사람은 "GIL을 해제한 C 해시 계산"의 뜻을 물었다. 에이전트는 같은 A 스레드가 Python에서 C 구현으로 들어가고, 내부 코드가 GIL을 해제한 채 CPU 계산을 계속한 뒤 GIL을 다시 획득해 Python 실행으로 돌아오는 흐름을 설명했다. 그동안 다른 스레드가 GIL을 획득할 수 있으며, 실행 자원이 충분하면 두 계산이 병렬로 진행될 수 있다는 점도 설명했다.
- 현재 이해 기록: 설명 후 사람은 "그래"라고 응답했다. 이번 순수 Python 계산에서 스레드를 늘려도 시간이 비슷한 이유는 사람이 설명했고, 네이티브 계산의 GIL 해제는 에이전트의 설명을 통해 접한 내용이다. 이 보충 내용을 사람의 독립적인 재설명으로 기록하지 않는다.

### I/O 네 방식 비교: 설정 변경과 실행 위치 확인 (2026-10-23)

- 사람의 수정: `MODELS = ("sequential", "threads", "processes", "asyncio")`, `WORKERS = 4`로 변경했고, 에이전트가 파일에 저장된 두 값을 확인했다.
- 사람의 최초 설명: asyncio의 `WORKERS = 4`는 이벤트 루프가 동시에 작업을 할당할 수 있는 스레드의 개수라고 답했다.
- 에이전트 피드백: 이번 코드에서 이벤트 루프를 실행하는 OS 스레드는 하나다. `run_asyncio()`는 작업용 Task 40개를 만들며, `asyncio.Semaphore(4)`는 `async with semaphore:` 안에 들어가 아직 완료하지 않은 작업을 최대 4개로 제한한다. 그 안에서 `await asyncio.sleep(0.1)`로 기다리므로 대기 구간이 겹칠 수 있다. 자리를 얻지 못한 Task는 세마포어 획득을 기다린다. Task의 총개수·작업 구간의 동시 실행 상한·OS 스레드 수를 구분한다. [이벤트 루프의 실행 스레드](https://docs.python.org/3.14/library/asyncio-dev.html#concurrency-and-multithreading), [Semaphore](https://docs.python.org/3.14/library/asyncio-sync.html#asyncio.Semaphore)
- 검증: `test_bench.py` 검사 7개가 통과했고, 수정된 기본 설정이 I/O 작업 40개·각 0.1초 대기와 순차 1개·나머지 세 방식 상한 4개를 만드는지 확인했다. 작은 입력의 새 기록 8개도 모두 검증을 통과했다.

작업용 Task와 스레드를 확인하기 위해 성능 측정과 별도로 아래 진단을 실행했다.

```sh
uv run --offline --no-cache --python 3.14.2+gil python/trace_execution.py --task io --models asyncio --workers 4 --tasks 40 --sleep-s 0.1
```

40개 작업의 80개 시작·종료 기록에서 같은 PID·OS 스레드·이벤트 루프를 확인했다. 작업용 Task ID는 서로 다른 40개였고, 작업 함수의 시작~종료 구간이 겹친 개수의 최댓값은 4였다. 시작 기록은 세마포어를 획득한 뒤 남기므로 이 값은 그 안에서 진행 중인 작업의 관찰값이다. CPU 명령이 4개 스레드에서 병렬 실행됐다는 뜻은 아니다. 이 진단의 시간은 성능 비교에 섞지 않는다.

- 작은 입력: [환경](results/validation/2026-10-23T201901825518-smoke-env.txt), [원자료](results/validation/2026-10-23T201901825518-smoke-python-3.14.2-gil-on.jsonl)
- 실행 위치 추적: [환경](results/traces/2026-10-23T201902326090-trace-env.txt), [원자료](results/traces/2026-10-23T201902326090-trace-python-3.14.2-gil-on.jsonl), [스레드·Task 대응표](results/traces/2026-10-23T201902326090-trace-mapping.txt)

### I/O 네 방식 비교: 측정 결과 (2026-10-23)

일반 CPython 3.14.2, GIL 켜짐, Apple M2 Pro(성능 코어 8개·효율 코어 4개, 논리 CPU 12개), macOS 26.5, AC 전원에서 실행했다. 저장된 설정을 사용해 `uv run --offline --no-cache --python 3.14.2+gil python/bench.py --task io`로 측정했다. 기준 커밋은 `17b6317`이며 문서와 `models.py`가 미커밋 상태였다. 작은 입력 검증·실행 위치 추적·본 측정 사이의 공통 실행 소스 해시는 일치했다.

총작업 수는 40개, 작업당 대기는 0.1초다. 순차·스레드·프로세스는 `time.sleep()`, asyncio는 `await asyncio.sleep()`을 사용했다. 워밍업 1회와 본 측정 3회를 조건별로 실행하고 매 반복의 조건 순서를 뒤집었다. 추적을 포함하지 않는 성능 측정 코드로 풀·이벤트 루프 생성부터 결과 수집·종료까지 쟀다. 16개 기록 모두 `check: 40`과 GIL·입력·반복 조건 검증을 통과했다.

- 본 측정: [환경](results/2026-10-23T202015603142-benchmark-env.txt), [원자료](results/2026-10-23T202015603142-benchmark-python-3.14.2-gil-on.jsonl), [측정 전후 CPU·전원·열 상태](results/2026-10-23T202015603142-benchmark-cpu-context.txt)

아래는 워밍업을 제외한 각 3회의 집계다. CPU 사용량은 앞선 CPU 비교와 같은 기준이며, 논리 CPU 하나를 계속 사용하면 약 100%에 해당한다.

| 방식 | 작업자 또는 동시 실행 상한 | 중앙값(초) | 최솟값~최댓값(초) | CPU 사용량 중앙값(%) |
|---|---:|---:|---:|---:|
| 순차 | 1 | 4.145660 | 4.143963~4.149026 | 0.04 |
| 스레드 | 4 | 1.036234 | 1.035176~1.046711 | 0.43 |
| 프로세스 | 4 | 1.167388 | 1.152407~1.178043 | 39.42 |
| asyncio | 4 | 1.012820 | 1.011923~1.012833 | 0.31 |

측정 한계: sleep으로 대기를 흉내 낸 실험이며 실제 네트워크·디스크 처리량을 재지는 않았다. 다른 앱의 배경 부하도 통제하지 못했다. 측정 전후 `top` 두 번째 스냅샷의 CPU 유휴 비율은 85.90%, 85.28%였지만, 측정 중 부하가 일정했다는 근거로 쓰지 않는다. 전후 AC 연결 상태와 열·성능 경고 기록 없음을 확인했다. 작업자 생성·전달·종료 비용이나 타이머 지연을 따로 분리해 측정하지 않았다.

### I/O 결과의 첫 해석: asyncio의 동시 대기

- 사람의 설명(요약): 동시에 대기할 수 있는 비동기 작업 4개로 0.1초 대기 작업 40개를 처리하므로, 0.1초짜리 작업 10개를 순차 처리하는 시간과 같아 약 1초에 완료된다고 설명했다. 더 명확한 용어로 표현하는 방법도 질문했다.
- 에이전트가 다듬은 설명: 하나의 OS 스레드에서 이벤트 루프가 작업용 Task 40개를 관리하고, 세마포어가 작업 구간의 동시 진행 상한을 4개로 제한한다. 각 Task가 `await asyncio.sleep(0.1)`에서 실행을 중단하면 이벤트 루프가 다른 준비된 Task를 실행하므로 대기 시간이 겹친다. 추가 비용과 스케줄링 지연을 무시하고 대기 자리가 계속 채워진다면 `40 ÷ 4 × 0.1초 = 1초`로 예상한다.
- 실행 순서 보완: 각 Task는 대기 작업 하나를 맡는다. 한 작업이 끝나 세마포어 자리를 반환하면 다음 Task가 진입할 수 있다. "0.1초짜리 작업 10개를 순차 처리하는 시간"은 전체 시간을 계산하는 비유이며, 실제 코드는 네 작업이 모두 끝날 때까지 기다리는 묶음 처리로 작성하지 않았다.
- 측정 대조: asyncio 중앙값은 1.012820초로, 부대비용을 제외한 약 1초라는 예상과 부합한다. 1초를 초과한 시간을 타이머 지연·이벤트 루프 관리·생성·종료 등으로 분리해 측정하지는 않았다.
- 이해 기록: 세마포어와 OS 스레드를 구분하는 피드백을 받은 뒤, 사람은 동시 대기 상한으로 전체 시간을 계산했다. Task 총개수·동시성 상한·작업 완료 후 자리 반환의 표현은 에이전트가 보완했다.
- 용어 보완: 사람은 "제어권"과 "실행 흐름"을 번갈아 쓰는 이유를 물었다. 에이전트는 이 문맥에서 같은 실행 전환을 설명하려고 쓴 표현이며, GIL처럼 획득·반납하는 별도의 제어권 객체가 있는 것은 아니라고 설명했다. 이후에는 "Task가 실행을 중단한다", "이벤트 루프가 다른 준비된 Task를 실행한다", "Task가 실행을 재개한다"로 구체적으로 표현한다.

### I/O 결과의 첫 해석: 스레드의 동시 대기

- 사람의 설명(요약): CPU를 점유하지 않는 작업을 수행하는 스레드는 GIL 제약을 받지 않으므로, 스레드 4개가 I/O 대기를 동시에 진행해 순차 실행 시간의 약 1/4이 걸릴 수 있다고 설명했다.
- 에이전트 피드백: 네 작업의 대기 시간을 겹쳐 전체 시간을 줄인다는 핵심은 맞다. 이 실험에서는 CPython의 `time.sleep()` 구현이 OS의 대기 호출 전후를 `Py_BEGIN_ALLOW_THREADS`와 `Py_END_ALLOW_THREADS`로 감싼다. 대기 중 GIL을 해제하므로 다른 스레드도 Python 코드를 실행해 sleep에 진입할 수 있다. 대기를 마치고 Python 코드 실행으로 돌아올 때는 GIL을 다시 획득한다. CPU를 사용하지 않는다는 사실만으로 GIL이 자동 해제되는 것은 아니며, 호출 구현이 GIL을 해제하는지 확인해야 한다. [CPython 3.14.2 sleep 구현](https://github.com/python/cpython/blob/v3.14.2/Modules/timemodule.c), [GIL 해제와 재획득](https://docs.python.org/3.14/c-api/threads.html#detaching-the-thread-state-from-extension-code)
- 측정 대조: 스레드 중앙값 1.036234초를 순차 중앙값 4.145660초로 나눈 비율은 약 0.2500이다. 부대비용을 제외한 약 1초라는 예상과 순차 대비 약 1/4이라는 사람의 설명에 부합한다. 각 스레드가 정확히 10개씩 처리했는지는 이번 성능 기록으로 확인하지 않았다.
- 이해 기록: 사람은 대기 중첩과 동시 대기 상한으로 시간 차이를 설명했다. GIL 해제를 CPU 비사용의 자동 효과로 일반화한 표현은 함수 구현의 명시적인 동작으로 보완했다.

### I/O 결과의 첫 해석: 프로세스의 추가 비용

- 사람의 첫 원인 해석: 프로세스를 생성하는 시간이 스레드보다 오래 걸려 프로세스 4개를 사용한 작업이 더 오래 걸렸다고 설명했다.
- 에이전트의 측정 대조: 프로세스 중앙값은 1.167388초, 스레드는 1.036234초로 프로세스가 약 0.131154초(12.7%) 길었다. 본 측정 3회 모두 프로세스가 더 오래 걸렸고 시간 범위도 겹치지 않았다. 준비 때 남긴 전체 시간의 순서 예상과 일치한다.
- 에이전트 피드백: 프로세스 생성 비용은 가능한 원인이다. 이번 측정 구간에는 풀 생성뿐 아니라 작업 전달·대기·결과 수집·종료가 함께 들어가며, 타이머·스케줄링 지연과 배경 부하의 영향도 분리하지 못했다. 따라서 관찰된 전체 시간 차이를 생성 시간의 차이로 확정하거나, 생성에만 약 0.131초가 더 걸렸다고 해석하지 않는다.
- 근거의 범위: 직접 확인한 것은 이 조건에서 프로세스 방식의 전체 시간이 더 길었다는 사실이다. 생성·전달·수집·종료 등의 부대비용이 영향을 주었을 수 있다는 설명은 원인 가설로 남긴다. 사람의 최초 설명을 이 보완된 설명으로 바꿔 기록하지 않는다.

### I/O 작업의 실행 방식 선택

- 사람의 선택과 이유: 시간과 리소스 면에서 스레드를 선택하는 쪽이 자원을 더 효율적으로 활용할 수 있다고 답했다.
- 에이전트가 연결한 측정 근거: 이번 조건에서 스레드 4개의 경과 시간 중앙값은 1.036234초, 프로세스 4개는 1.167388초였다. 부모와 회수된 자식 프로세스의 CPU 시간 합계 중앙값은 각각 0.004445초·0.460158초였다. 처리 시간과 측정한 CPU 사용량을 기준으로는 스레드를 고르는 판단을 뒷받침한다.
- 적용 범위: 실행마다 풀을 생성·종료하고 `time.sleep(0.1)` 작업 40개를 처리한 조건에 대한 선택이다. 메모리 사용량은 측정하지 않았으므로 리소스 전반이나 모든 I/O 작업에서의 효율로 일반화하지 않는다. asyncio까지 포함한 선택 기준과 해설 없이 다시 설명하는 확인은 최종 정리에서 다룬다.

I/O의 측정과 첫 해석·선택 기준을 기록했다. 준비 때 정한 스레드 4개의 수치 예상과 판단 기준을 유지해 GIL CPU 비교로 이어갔다. 전체 실험과 최종 학습 확인은 진행 중이다.

### 같은 free-threaded 빌드의 GIL CPU 비교 (2026-10-23)

I/O에서 사람이 설정한 네 실행 방식과 작업자 상한 4개를 사용했다. 이번에 바꾼 조건은 같은 CPython 3.14.2t 실행 파일의 GIL 활성 상태다. 입력은 N=200,000과 20,000, 각 8개 작업이며 순차 실행의 작업자는 1개다. 준비 때 기록한 큰 작업의 시간 비율 0.20~0.30, 작은 작업의 비율 0.90~1.10을 판정 기준으로 유지한다. 비율은 `GIL 끔 중앙값 ÷ GIL 켬 중앙값`이다.

실행 명령은 다음과 같다. 작은 입력에는 `--smoke`를 추가했다.

```sh
uv run --offline --no-cache --python 3.14.2t python/compare_gil.py --task cpu --models sequential threads processes asyncio --workers 4
```

- 실행 준비: free-threaded 빌드에서 관련 자동 검사 8개와 작은 입력 기록 16개를 검증했다. 두 조건의 실제 GIL 상태·실행 파일·빌드가 의도대로 설정됐는지 확인했다.
- 환경: `3.14.2 free-threading build (main, Jan 27 2026, 23:31:54) [Clang 21.1.4 ]`, Apple M2 Pro(성능 코어 8개·효율 코어 4개, 논리 CPU 12개), macOS 26.5, AC 전원이다.
- 반복 조건: 입력 2개 × 방식 4개 × GIL 상태 2개의 16개 조건에 워밍업 1회와 본 측정 3회를 적용해 64개를 기록했다. 한 번에 한 조건만 실행하고, 매 반복마다 전체 조건 순서를 뒤집었다.
- 측정 범위: 풀·이벤트 루프 생성부터 작업·결과 수집·종료까지다. GIL 상태별 측정 프로세스 두 개는 워밍업부터 본 측정까지 유지하며, 제어 프로그램의 통신과 측정 프로세스 자체의 시작·종료는 측정 구간 밖이다.
- 검증: 64개 모두 정답과 실제 GIL 상태·반복 조건 검증을 통과했다. N=200,000의 `check`는 143,872, N=20,000은 18,096이다. 두 조건은 같은 실제 실행 파일과 빌드를 사용했고, 작은 입력과 본 측정의 실행 소스 해시도 일치했다. 기준 커밋은 `17b6317`이며 문서와 `models.py`가 미커밋 상태였다.

- 작은 입력: [환경](results/validation/2026-10-23T205416949854-gil-compare-smoke-env.txt), [원자료](results/validation/2026-10-23T205416949854-gil-compare-smoke-python-3.14.2t.jsonl)
- 본 측정: [환경](results/2026-10-23T205541738504-gil-compare-benchmark-env.txt), [원자료](results/2026-10-23T205541738504-gil-compare-benchmark-python-3.14.2t.jsonl), [측정 전후 CPU·전원·열 상태](results/2026-10-23T205541738504-gil-compare-benchmark-cpu-context.txt)

아래는 워밍업을 제외한 조건별 3회의 집계다. CPU 사용량은 논리 CPU 하나를 계속 사용하면 약 100%인 기존 기준이다.

| N | 방식 | 작업자 상한 | GIL | 중앙값(초) | 최솟값~최댓값(초) | CPU 사용량 중앙값(%) |
|---|---|---:|---|---:|---:|---:|
| 200,000 | 순차 | 1 | 켬 | 1.202620 | 1.192909~1.215912 | 99.8 |
| 200,000 | 순차 | 1 | 끔 | 1.200756 | 1.198875~1.238274 | 99.9 |
| 200,000 | 스레드 | 4 | 켬 | 1.239875 | 1.204646~1.240967 | 100.0 |
| 200,000 | 스레드 | 4 | 끔 | 0.445464 | 0.434570~0.479134 | 389.1 |
| 200,000 | 프로세스 | 4 | 켬 | 0.396169 | 0.382734~0.412716 | 383.6 |
| 200,000 | 프로세스 | 4 | 끔 | 0.392139 | 0.384515~0.392342 | 391.7 |
| 200,000 | asyncio | 4 | 켬 | 1.192222 | 1.183443~1.214638 | 99.9 |
| 200,000 | asyncio | 4 | 끔 | 1.248052 | 1.227169~1.250567 | 98.9 |
| 20,000 | 순차 | 1 | 켬 | 0.056163 | 0.053323~0.057989 | 99.9 |
| 20,000 | 순차 | 1 | 끔 | 0.055448 | 0.054888~0.059284 | 99.8 |
| 20,000 | 스레드 | 4 | 켬 | 0.060199 | 0.054948~0.061667 | 100.3 |
| 20,000 | 스레드 | 4 | 끔 | 0.040622 | 0.025284~0.040657 | 347.3 |
| 20,000 | 프로세스 | 4 | 켬 | 0.102430 | 0.099903~0.102434 | 366.5 |
| 20,000 | 프로세스 | 4 | 끔 | 0.102618 | 0.101282~0.104007 | 371.7 |
| 20,000 | asyncio | 4 | 켬 | 0.058810 | 0.058641~0.059286 | 99.6 |
| 20,000 | asyncio | 4 | 끔 | 0.059845 | 0.057650~0.061416 | 99.5 |

수치 가설의 대상인 스레드 4개의 시간 비율은 다음과 같다.

| N | GIL 끔 / 켬 중앙값 비율 | 준비 때 정한 판정 범위 |
|---|---:|---|
| 200,000 | 0.359281 | 0.20~0.30: 약 1/4 |
| 20,000 | 0.674802 | 0.90~1.10: 거의 변화 없음 |

측정상의 관찰: N=20,000·스레드 4개·GIL 꺼짐의 본 측정값은 순서대로 0.040622초, 0.025284초, 0.040657초로 편차가 있었다. 기록을 제외하거나 기준을 바꾸지 않고 중앙값과 범위를 함께 남긴다. 다른 앱의 배경 부하는 통제하지 못했다. 배치 전후 `top` 두 번째 스냅샷의 시스템 CPU 유휴 비율은 84.79%, 82.76%였으며, 이 두 시점으로 측정 중 부하가 일정했다고 판단하지 않는다. 전후 AC 연결과 열·성능 경고 기록 없음을 확인했다.

이 비교는 같은 free-threaded 빌드 안의 GIL 설정 차이다. 앞선 일반 CPython 빌드의 측정과 합쳐 집계하지 않는다. 작은 입력의 변동 원인이나 시간 단축을 제한한 비용은 따로 분리해 측정하지 않았다. 표와 측정 한계를 제시했고, 아래에 사람의 가설 판단과 피드백을 구분해 기록한다. 같은 빌드의 GIL I/O 결과는 아래에 따로 기록한다.


### GIL CPU 비교의 첫 판단: N=200,000

- 사람의 첫 판단(요약): 미리 정한 범위보다는 덜 줄었지만 근접했다고 생각한다고 답했다. N이 충분히 큰 작업에서는 유의미한 소요시간 감축을 확인할 수 있었다고 설명했다.
- 에이전트의 수치 가설 대조: GIL 꺼짐·켜짐 중앙값 비율 0.359281은 사전에 정한 0.20~0.30 범위 밖이다. 따라서 이번 조건의 "약 1/4" 수치 예상에는 부합하지 않는다. 근접했다고 느낀다는 사람의 평가와 사전 기준에 따른 판정을 구분하며, 측정 뒤 허용 범위를 넓히지 않는다.
- 에이전트의 단축 효과 대조: 중앙값은 1.239875초에서 0.445464초로 약 64.1% 줄었으며, 같은 작업량의 처리 속도는 약 2.78배다. 꺼짐 조건의 최댓값도 켜짐 조건의 최솟값보다 작았다. 이번 N=200,000에서 큰 시간 단축을 관찰했다는 설명은 측정값으로 뒷받침한다. 이 관찰을 모든 큰 입력에 대한 보장이나 "충분히 큰 N"의 일반적인 경계값으로 확장하지 않는다.

### GIL CPU 비교의 첫 판단: N=20,000

- 사람의 첫 판단(요약): 예상 범위보다 시간이 많이 줄었다고 판단했다. N이 어느 정도 커서 스레드 생성 시간보다 작업 자체의 시간이 더 크다는 것을 알 수 있었다고 설명했다.
- 에이전트의 수치 대조: 중앙값은 GIL 켜짐 0.060199초에서 꺼짐 0.040622초로 약 32.5% 줄었다. 시간 비율 0.674802는 사전 범위 0.90~1.10 밖이므로, "거의 변화 없음"이라는 예상에는 부합하지 않는다. 꺼짐 조건의 반복 간 편차는 있었지만 그 최댓값도 켜짐 조건의 최솟값보다 작았다.
- 에이전트 피드백: 이 입력에서도 전체 시간이 줄었다는 판단은 맞다. 다만 스레드 생성 시간과 계산시간을 각각 측정하지 않았으므로 둘의 크기 관계까지 확인한 것은 아니다. 병렬화의 이득이 관찰됐다는 사실과, 비용 항목별 크기를 알고 있다는 주장은 구분한다.
- 설명을 위한 반례: 생성 시간이 50ms이고 계산이 40ms라면 전체는 90ms다. 생성 시간은 그대로이고 계산만 10ms로 줄어도 전체는 60ms가 되어 약 33% 단축된다. 이때 생성 시간은 여전히 원래 계산시간보다 길다. 이는 시간 단축만으로 두 비용의 크기를 비교할 수 없음을 보이는 가상의 예이며, 이번 측정의 비용을 추정한 값이 아니다.

이어 준비 때 "GIL 상태와 관계없이 동시에 대기할 수 있는 스레드는 4개이므로 거의 변화가 없을 것"이라고 예상한 I/O 비교를 측정했다. 같은 빌드·작업 40개·대기 0.1초·스레드 4개를 유지하고, 시간 비율 0.90~1.10의 기존 기준을 사용한다. 전체 실험과 최종 학습 확인은 진행 중이다.

### 같은 free-threaded 빌드의 GIL I/O 비교 (2026-10-23)

CPU 비교와 같은 CPython 3.14.2t 빌드와 실행 소스를 사용했다. GIL 상태만 바꾸며 `time.sleep(0.1)` 또는 `await asyncio.sleep(0.1)` 작업 40개를 처리한다. 순차는 작업자 1개, 스레드·프로세스·asyncio는 작업자 또는 동시 진행 상한 4개다. 수치 가설의 대상은 스레드 4개이며, "거의 변화 없음"의 사전 시간 비율 범위 0.90~1.10을 유지한다.

```sh
uv run --offline --no-cache --python 3.14.2t python/compare_gil.py --task io --models sequential threads processes asyncio --workers 4
```

- 작은 입력: 위 명령에 `--smoke`를 추가해 16개 기록의 정답·GIL 상태·같은 실행 파일·실행 순서를 검증했다. 실행 소스는 앞선 GIL CPU 측정 이후 바뀌지 않았다.
- 환경: `3.14.2 free-threading build (main, Jan 27 2026, 23:31:54) [Clang 21.1.4 ]`, Apple M2 Pro(성능 코어 8개·효율 코어 4개, 논리 CPU 12개), macOS 26.5, AC 전원이다.
- 반복과 검증: 네 방식 × 두 GIL 상태의 8개 조건에 워밍업 1회와 본 측정 3회를 적용해 32개를 기록했다. 모두 `check: 40`과 실제 GIL 상태·입력·반복 조건 검증을 통과했다. 조건 순서를 반복마다 뒤집었으며 한 번에 한 조건만 실행했다.
- 측정 범위: 각 조건의 풀·이벤트 루프 생성부터 작업·결과 수집·종료까지다. GIL 상태별 측정 프로세스는 워밍업부터 본 측정까지 유지했고, 제어 프로그램의 통신과 측정 프로세스 자체의 시작·종료는 측정 구간 밖이다.
- 소스와 빌드: 두 GIL 조건은 같은 실제 실행 파일·빌드를 사용했다. 작은 입력과 본 측정의 실행 소스 해시도 일치했다. 기준 커밋은 `17b6317`이며 문서와 `models.py`가 미커밋 상태였다.

- 작은 입력: [환경](results/validation/2026-10-23T211241055451-gil-compare-smoke-env.txt), [원자료](results/validation/2026-10-23T211241055451-gil-compare-smoke-python-3.14.2t.jsonl)
- 본 측정: [환경](results/2026-10-23T211420698267-gil-compare-benchmark-env.txt), [원자료](results/2026-10-23T211420698267-gil-compare-benchmark-python-3.14.2t.jsonl), [측정 전후 CPU·전원·열 상태](results/2026-10-23T211420698267-gil-compare-benchmark-cpu-context.txt)

아래는 워밍업을 제외한 조건별 3회의 집계다. CPU 사용량은 기존과 같이 논리 CPU 하나를 계속 사용하면 약 100%인 기준이다.

| 방식 | 작업자 또는 동시 진행 상한 | GIL | 중앙값(초) | 최솟값~최댓값(초) | CPU 사용량 중앙값(%) |
|---|---:|---|---:|---:|---:|
| 순차 | 1 | 켬 | 4.140863 | 4.136334~4.141151 | 0.03 |
| 순차 | 1 | 끔 | 4.144583 | 4.140900~4.151607 | 0.03 |
| 스레드 | 4 | 켬 | 1.043754 | 1.041896~1.046172 | 0.75 |
| 스레드 | 4 | 끔 | 1.045442 | 1.040383~1.047343 | 0.81 |
| 프로세스 | 4 | 켬 | 1.148420 | 1.146293~1.157938 | 34.73 |
| 프로세스 | 4 | 끔 | 1.151315 | 1.144054~1.156394 | 36.41 |
| asyncio | 4 | 켬 | 1.012631 | 1.012385~1.013360 | 0.33 |
| asyncio | 4 | 끔 | 1.013961 | 1.011847~1.014159 | 0.39 |

스레드 4개의 `GIL 끔 중앙값 ÷ GIL 켬 중앙값`은 1.001617이다. 사전 판정 범위는 0.90~1.10이다.

측정 한계: 실제 네트워크·디스크 I/O 대신 sleep 대기를 비교했다. 다른 앱의 배경 부하는 통제하지 못했다. 배치 전후 `top` 두 번째 스냅샷의 시스템 CPU 유휴 비율은 86.82%, 80.19%였으며, 두 시점의 관찰로 측정 중 부하가 일정했다고 판단하지 않는다. 전후 AC 연결과 열·성능 경고 기록 없음을 확인했다. 앞선 일반 CPython 빌드의 I/O 측정과 합쳐 집계하지 않는다.

### GIL I/O 비교의 첫 해석

- 사람의 첫 해석(요약): I/O 작업에서는 GIL의 영향이 없었다고 답했다. I/O에 들어가 C 함수를 호출하면 GIL이 해제돼 다른 스레드도 작업할 수 있으므로 병목이 생기지 않는다고 설명했다. 반면 CPU 작업에서는 "Python 바이너리"를 실행하려는 스레드가 GIL을 소유해야 하므로 병렬 처리의 병목이 될 수 있다고 설명했다.
- 에이전트의 수치 대조: 스레드 4개의 시간 비율은 1.001617로 사전 허용 범위 0.90~1.10 안이다. 이번 대기 중심 작업에서 "거의 변화 없음"이라는 예상에 부합한다. 첫 반복은 GIL 꺼짐이 더 짧고 나머지 두 반복은 켜짐이 더 짧았으며 시간 범위도 겹쳤다. 기존 기준에 따라 어느 쪽이 더 빠른지에 대한 판단은 보류한다. 두 조건의 시간이 정확히 같다는 증명으로 기록하지 않는다.
- 적용 범위 보완: 이번 `time.sleep()` 구현은 대기 중 GIL을 명시적으로 해제하므로, 두 GIL 상태 모두 스레드 4개가 대기를 겹칠 수 있다. C 함수를 호출한다는 사실만으로 GIL이 자동 해제되는 것은 아니다. 대기를 마친 뒤 GIL을 켠 인터프리터에서 Python 코드를 재개하려면 다시 GIL을 획득해야 한다. 이 결과를 모든 I/O 작업에서 GIL의 영향이 없다는 주장으로 확장하지 않는다. [sleep 구현](https://github.com/python/cpython/blob/v3.14.2/Modules/timemodule.c), [GIL과 스레드 상태](https://docs.python.org/3.14/c-api/threads.html)
- CPU 용어 보완: 이 문맥에서는 "Python 바이너리"보다 "Python 바이트코드"가 정확하다. GIL을 켠 같은 인터프리터의 순수 Python 계산은 한 번에 하나의 스레드가 실행하므로 병렬화에 제약이 생긴다. 앞서 확인한 GIL을 해제하는 네이티브 계산은 별도로 구분한다.
- 이해 기록: 사람은 계산과 대기에서 GIL의 효과가 다를 수 있음을 연결해 설명했다. 함수 구현에 따른 GIL 해제, 결론의 적용 범위, 바이트코드라는 용어는 에이전트가 보완했다. 해설 없이 조건별 선택과 변형 문제를 설명하는 최종 확인은 남겨 둔다.

공유 카운터 단계에서는 [counter_kernels.py](python/counter_kernels.py)의 `increment_candidate()`에 인자로 받은 공유 `lock`을 적용하고 보호 범위와 이유를 설명한다. 두 스레드가 각각 한 번 증가시켰을 때 기대값은 2다. 아래 첫 수정안의 API 검토를 거쳐 수정본 검증과 준비한 100회 비교를 이어간다.
