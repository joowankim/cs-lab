# 01 동시성 모델 비교

같은 작업을 순차·스레드·프로세스·asyncio로 돌려 본다. CPU로 계산할 때와 기다리는 시간이 많을 때, 어떤 방식이 얼마나 빠른지 재려 한다. Python의 일반 빌드와 free-threaded 빌드도 비교한다.

2026-10-22 현재 시작 전 준비를 진행하고 있다. 아직 `python/bench.py`나 측정 결과는 없다. 아래는 구현할 내용과 코드가 준비되면 쓸 명령이다. 공통 측정 규칙과 결과 형식은 [작업 지침](../../AGENTS.md)에 적어 두었다.

## 궁금한 것

- 계산이 많은 작업과 대기가 많은 작업에서 스레드·프로세스·asyncio는 순차 실행보다 얼마나 빠르거나 느릴까?
- GIL을 끄면 스레드 성능은 얼마나 달라질까?
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
- 사람의 추가 예상(요약): 프로세스 생성·결과 전달·종료 비용이 크면 프로세스 4개가 항상 더 빠르지는 않을 것이라고 답했다. "GIL은 프로세스마다 하나씩만 가질 수 있다"는 전제도 실험으로 확인하자고 제안했다.
- 추가 피드백: 부대비용을 고려한 방향은 맞다. 비교할 기준은 부대비용과 병렬 계산시간 자체의 크기가 아니라, 프로세스로 바꾸면서 늘어난 비용과 병렬 계산으로 절약한 시간이다. 실제 판단은 같은 작업을 처리한 전체 경과 시간으로 한다. 풀은 작업들을 처리하고 결과를 받은 뒤 종료한다.

## 작업 규칙

### 입력과 검증값

| 작업 | 한 작업의 내용 | 전체 작업 수 (`size`) | 검증값 (`check`) |
|---|---|---|---|
| `cpu` | 2부터 N까지 소수 개수 세기 | 8 | 작업별 소수 개수의 합. N=200,000이면 17,984 × 8 = 143,872 |
| `io` | 0.1초 대기 | 40 | 정상 완료한 작업 수 40 |

소수는 각 후보 수를 2부터 정수 제곱근까지 나눠서 찾는다. 중간에 약수가 나오면 그 수의 검사는 끝낸다. N은 우선 200,000으로 잡는다.

한 작업이 너무 빨리 끝나거나 오래 걸리면, 일반 빌드에서 순차로 돌렸을 때 약 0.3~0.5초가 걸리도록 기본 N을 한 번 조정한다. 같은 N을 비교하는 동안에는 모든 조건과 언어에서 같은 알고리즘과 작업 수를 쓴다. `params.n`에 N을, `params.algorithm`에 `"trial_division"`을 기록한다. N을 바꾸면 정답도 다시 확인해야 한다.

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

macOS에서 uv로 실행한다. uv가 없다면 [설치 안내](https://docs.astral.sh/uv/getting-started/installation/)를 참고한다. `bench.py`는 표준 라이브러리만 쓰고, PEP 723 메타데이터에 `requires-python = ">=3.14,<3.15"`, `dependencies = []`를 적는다.

아래 명령은 같은 셸에서 순서대로 실행한다. 처음에 실험 폴더로 이동한 뒤에는 그 위치에서 계속 진행하면 된다.

```sh
# 저장소 루트에서 시작
cd experiments/01-concurrency-models
uv python install 3.14+gil 3.14t

# 한 비교 세트에 같은 접두사를 쓴다. 다시 잴 때는 새로 설정한다.
experiment_stamp="$(date +%Y-%m-%dT%H%M%S)"

# 같은 이름의 파일이 있으면 덮어쓰지 않는다.
set -C
```

`3.14+gil`은 일반 빌드, `3.14t`는 free-threaded 빌드를 고르는 표기다. 두 빌드의 패치 버전이 같은지 확인한다. 나중에 다시 돌릴 때는 환경 파일에 남긴 패치 버전까지 지정한다. 표기법은 [uv 문서](https://docs.astral.sh/uv/concepts/python-versions/#free-threaded-python)에서 확인할 수 있다.

### 환경 기록

측정하기 전에 환경부터 저장한다. 첫 커밋 전이라면 `commit: none`이 남는다. Mac에 따라 P·E 코어 정보를 읽는 명령에서 오류가 날 수 있다. 그때는 확인할 수 있는 코어 정보를 따로 적어 둔다.

```sh
{
  date '+%Y-%m-%dT%H:%M:%S%z'
  git rev-parse --verify HEAD 2>/dev/null || printf 'commit: none\n'
  git status --short
  sysctl -n machdep.cpu.brand_string
  sysctl hw.physicalcpu hw.logicalcpu
  sysctl hw.perflevel0.name hw.perflevel0.physicalcpu hw.perflevel1.name hw.perflevel1.physicalcpu
  sw_vers -productVersion
  pmset -g batt
  uv --version
  uv run --python 3.14+gil python -VV
  uv run --python 3.14t python -VV
} > "results/${experiment_stamp}-env.txt" 2>&1
```

### 성능 측정 (`python/bench.py`를 만든 뒤)

`bench.py` 한 번으로 위의 작업·방식 조합을 모두 반복 측정하고 출력하도록 만든다. 결과의 `runtime`에는 실제 패치 버전과 빌드를 적고, `variant`에는 `gil=on` 또는 `gil=off`를 넣는다.

```sh
# 일반 빌드, GIL 켜짐
PYTHON_GIL=1 uv run --python 3.14+gil python/bench.py > "results/${experiment_stamp}-python-3.14-gil.jsonl"

# Free-threaded 빌드, GIL 꺼짐
PYTHON_GIL=0 uv run --python 3.14t python/bench.py > "results/${experiment_stamp}-python-3.14t.jsonl"

# 선택: 같은 free-threaded 빌드에서 GIL만 켜기
PYTHON_GIL=1 uv run --python 3.14t python/bench.py > "results/${experiment_stamp}-python-3.14t-gil1.jsonl"
```

필요한 모듈을 불러온 뒤 `sys._is_gil_enabled()`로 GIL 상태를 확인한다. 원하는 설정과 다르면 측정을 멈춘다. 자식 프로세스에서도 확인하고, 실제 상태를 각 결과의 `gil_enabled`에 남긴다.

Free-threaded 빌드도 GIL을 켜고 실행할 수 있다. 빌드 이름만 보고 GIL이 꺼졌다고 생각하면 안 된다. 설정과 확인 방법은 [Python 문서](https://docs.python.org/3.14/howto/free-threading-python.html#the-global-interpreter-lock-in-free-threaded-python)에 나와 있다.

## 경쟁 상태와 이벤트 루프 블로킹

다음 실험은 성능 비교와 따로 돌린다. 코드를 만들면 여기에 파일 이름과 실행 명령을 추가한다.

| 시나리오 | 비교와 확인 방법 |
|---|---|
| 공유 카운터 | 락 없음/있음을 비교하고, 기대값·실제값·실패 횟수/시도 횟수를 기록 |
| 지연 초기화 싱글톤 | 여러 스레드가 동시에 초기화를 시도하게 하고, 생성 횟수와 반환 객체의 동일성을 확인 |
| 이벤트 루프 블로킹 | 주기적으로 깨어나는 코루틴과 블로킹 작업을 함께 실행하고, 예정 시각 대비 지연을 기록. `time.sleep`과 `await asyncio.sleep`을 비교하고 CPU 계산도 별도로 확인 |

재현하려고 읽기와 쓰기 사이에 대기나 동기화 지점을 넣었다면 무엇을 넣었는지 적는다. 수정한 뒤에는 같은 조건에서 기대값과 객체 동일성을 다시 확인한다.

## 결과 정리

아직 측정 전이다. 실험을 마치면 이 절에 결과를 정리한다.

- `results/`에서 같은 접두사를 쓰는 환경 파일과 JSONL 파일의 경로
- 런타임·GIL 상태·작업·방식별 중앙값, 최솟값~최댓값, 순차 대비 속도 향상 배수
- 예상과 달랐던 점, 위 질문에 대한 답
- 측정값과 실험 조건을 넣어 쓴 한 줄 결론
