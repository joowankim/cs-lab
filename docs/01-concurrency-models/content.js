/*
 * 요소 설명·장면 안내·근거 링크. 실행 상태는 model.js가 만들고 여기서는 고정된 설명만 둔다.
 * 근거 종류: measured(실측 기록), source(소스·공식 문서), record(실험 문답 기록), model(설명용 가정).
 */
(function (root) {
  'use strict';

  // 근거 파일은 GitHub의 main 브랜치 판을 연다. 화면을 Pages에서 열든 내려받은 폴더에서 열든 같은 곳으로 간다.
  const REPO = 'https://github.com/joowankim/cs-lab/blob/main/';
  const EXP = `${REPO}experiments/01-concurrency-models/`;
  const README = `${EXP}README.md`;
  const ANKI = `${REPO}anki/01-concurrency-models.md`;
  const SRC = 'https://github.com/python/cpython/blob/v3.14.2/';
  const DOCS = 'https://docs.python.org/3.14/';

  const EV = {
    readmeThreads: { type: 'record', label: '실험 README · Python 스레드·OS 스레드·하드웨어 스레드', href: `${README}#보충-학습-python-스레드os-스레드하드웨어-스레드` },
    readmeEnv: { type: 'record', label: '실험 README · 구현 준비와 환경 점검 (Apple M2 Pro, 논리 CPU 12개)', href: `${README}#구현-준비와-환경-점검-2026-10-23` },
    readmeGilSource: { type: 'source', label: '실험 README · 소스 조사: 한 인터프리터마다 GIL이 하나만 존재하는가', href: `${README}#소스-조사-한-인터프리터마다-gil이-하나만-존재하는가` },
    readmeSwitch: { type: 'source', label: '실험 README · 계산 도중 GIL을 해제하는 계기', href: `${README}#추가-소스-확인-계산-도중-gil을-해제하는-계기` },
    readmeNative: { type: 'record', label: '실험 README · 스레드와 GIL의 적용 범위 (hashlib 예)', href: `${README}#작업자-수-비교의-첫-해석-스레드와-gil의-적용-범위` },
    readmeCpu48: { type: 'measured', label: '실험 README · CPU 작업자 4개·8개 비교', href: `${README}#cpu-작업자-4개8개-비교-2026-10-23` },
    readmeGilCpu: { type: 'measured', label: '실험 README · 같은 free-threaded 빌드의 GIL CPU 비교', href: `${README}#같은-free-threaded-빌드의-gil-cpu-비교-2026-10-23` },
    readmeIo: { type: 'measured', label: '실험 README · I/O 네 방식 비교: 측정 결과', href: `${README}#io-네-방식-비교-측정-결과-2026-10-23` },
    readmeGilIo: { type: 'measured', label: '실험 README · 같은 free-threaded 빌드의 GIL I/O 비교', href: `${README}#같은-free-threaded-빌드의-gil-io-비교-2026-10-23` },
    readmeTrace: { type: 'measured', label: '실험 README · I/O 실행 위치 확인 (Task 40개, 루프 스레드 1개)', href: `${README}#io-네-방식-비교-설정-변경과-실행-위치-확인-2026-10-23` },
    readmeAsyncioCpu: { type: 'record', label: '실험 README · CPU 계산의 asyncio 실행과 이벤트 루프', href: `${README}#cpu-계산의-asyncio-실행과-이벤트-루프` },
    readmeLoop: { type: 'measured', label: '실험 README · 이벤트 루프: 네 조건의 재개 지연 측정', href: `${README}#이벤트-루프-네-조건의-재개-지연-측정-2026-10-23` },
    readmeLoopExplain: { type: 'source', label: '실험 README · 이벤트 루프 설명에서 확인할 부분 (sleep 구현)', href: `${README}#이벤트-루프-설명에서-확인할-부분` },
    readmeLoopGil: { type: 'record', label: '실험 README · 이벤트 루프의 GIL 조건 변형', href: `${README}#이벤트-루프의-gil-조건-변형` },
    readmeCounter: { type: 'measured', label: '실험 README · 공유 카운터: 보호 범위 설명과 100회 비교', href: `${README}#공유-카운터-보호-범위-설명과-100회-비교-2026-10-23` },
    readmeLockApi: { type: 'record', label: '실험 README · 공유 카운터의 첫 수정안: 락 API 검토', href: `${README}#공유-카운터의-첫-수정안-락-api-검토` },
    readmeSummary: { type: 'record', label: '실험 README · 학습 확인 요약', href: `${README}#학습-확인-요약` },
    models: { type: 'source', label: 'python/models.py', href: `${EXP}python/models.py` },
    workloads: { type: 'source', label: 'python/workloads.py', href: `${EXP}python/workloads.py` },
    counterCode: { type: 'source', label: 'python/counter_kernels.py', href: `${EXP}python/counter_kernels.py` },
    loopCode: { type: 'source', label: 'python/loop_kernels.py', href: `${EXP}python/loop_kernels.py` },
    loopLab: { type: 'source', label: 'python/loop_lab.py', href: `${EXP}python/loop_lab.py` },
    cpuData: { type: 'measured', label: '원자료 · CPU 작업자 4·8개 (일반 3.14.2)', href: `${EXP}results/2026-10-23T194814493154-benchmark-python-3.14.2-gil-on.jsonl` },
    gilCpuData: { type: 'measured', label: '원자료 · 같은 빌드 GIL CPU 비교 (3.14.2t)', href: `${EXP}results/2026-10-23T205541738504-gil-compare-benchmark-python-3.14.2t.jsonl` },
    ioData: { type: 'measured', label: '원자료 · I/O 네 방식 (일반 3.14.2)', href: `${EXP}results/2026-10-23T202015603142-benchmark-python-3.14.2-gil-on.jsonl` },
    gilIoData: { type: 'measured', label: '원자료 · 같은 빌드 GIL I/O 비교 (3.14.2t)', href: `${EXP}results/2026-10-23T211420698267-gil-compare-benchmark-python-3.14.2t.jsonl` },
    traceData: { type: 'measured', label: '원자료 · 작업·스레드·Task 추적', href: `${EXP}results/traces/2026-10-23T201902326090-trace-python-3.14.2-gil-on.jsonl` },
    loopData: { type: 'measured', label: '원자료 · 이벤트 루프 지연', href: `${EXP}results/2026-10-23T223743651724-loop-python-3.14.2.jsonl` },
    counterData: { type: 'measured', label: '원자료 · 공유 카운터 100회 비교', href: `${EXP}results/2026-10-23T214820271638-counter-python-3.14.2.jsonl` },
    srcGil: { type: 'source', label: 'CPython v3.14.2 · Python/ceval_gil.c', href: `${SRC}Python/ceval_gil.c` },
    srcBytecodes: { type: 'source', label: 'CPython v3.14.2 · Python/bytecodes.c (확인 지점)', href: `${SRC}Python/bytecodes.c` },
    srcPystate: { type: 'source', label: 'CPython v3.14.2 · pystate.h:66–74 (스레드 상태의 interp)', href: `${SRC}Include/cpython/pystate.h#L66-L74` },
    srcThread: { type: 'source', label: 'CPython 3.14 · Python/thread_pthread.h', href: 'https://github.com/python/cpython/blob/3.14/Python/thread_pthread.h' },
    srcSleep: { type: 'source', label: 'CPython v3.14.2 · Modules/timemodule.c (sleep)', href: `${SRC}Modules/timemodule.c` },
    srcTasks: { type: 'source', label: 'CPython v3.14.2 · Lib/asyncio/tasks.py (sleep)', href: `${SRC}Lib/asyncio/tasks.py` },
    srcLocks: { type: 'source', label: 'CPython v3.14.2 · Lib/asyncio/locks.py (Semaphore)', href: `${SRC}Lib/asyncio/locks.py` },
    srcBase: { type: 'source', label: 'CPython v3.14.2 · Lib/asyncio/base_events.py', href: `${SRC}Lib/asyncio/base_events.py` },
    docThreads: { type: 'source', label: 'Python 3.14 문서 · 스레드 상태와 GIL', href: `${DOCS}c-api/threads.html` },
    docDetach: { type: 'source', label: 'Python 3.14 문서 · 확장 코드에서 스레드 상태 분리', href: `${DOCS}c-api/threads.html#detaching-the-thread-state-from-extension-code` },
    docSubinterp: { type: 'source', label: 'Python 3.14 문서 · 인터프리터의 GIL 설정', href: `${DOCS}c-api/subinterpreters.html#c.PyInterpreterConfig.gil` },
    docFree: { type: 'source', label: 'Python 3.14 문서 · free-threading의 GIL 설정', href: `${DOCS}howto/free-threading-python.html#the-global-interpreter-lock-in-free-threaded-python` },
    docSwitch: { type: 'source', label: 'Python 3.14 문서 · sys.setswitchinterval', href: `${DOCS}library/sys.html#sys.setswitchinterval` },
    docAsyncioThreads: { type: 'source', label: 'Python 3.14 문서 · asyncio와 스레드', href: `${DOCS}library/asyncio-dev.html#concurrency-and-multithreading` },
    docSemaphore: { type: 'source', label: 'Python 3.14 문서 · asyncio.Semaphore', href: `${DOCS}library/asyncio-sync.html#asyncio.Semaphore` },
    docLock: { type: 'source', label: 'Python 3.14 문서 · threading.Lock', href: `${DOCS}library/threading.html#lock-objects` },
    docLockWith: { type: 'source', label: 'Python 3.14 문서 · with 문으로 쓰는 Lock', href: `${DOCS}library/threading.html#using-locks-conditions-and-semaphores-in-the-with-statement` },
    docMp: { type: 'source', label: 'Python 3.14 문서 · 프로세스 사이의 객체 교환', href: `${DOCS}library/multiprocessing.html#exchanging-objects-between-processes` },
    docExecutor: { type: 'source', label: 'Python 3.14 문서 · ThreadPoolExecutor', href: `${DOCS}library/concurrent.futures.html#threadpoolexecutor` },
    docHashlib: { type: 'source', label: 'Python 3.14 문서 · hashlib (GIL 해제 조건)', href: `${DOCS}library/hashlib.html#hash-algorithms` },
    anki: { type: 'record', label: '복습 카드 (anki/01-concurrency-models.md)', href: ANKI },
  };

  const TYPE_LABEL = { measured: '실측 기록', source: '소스·공식 문서', record: '실험 기록', model: '설명용 가정' };

  const CODE = {
    threads: `def run_threads(jobs, workers, job_fn):
    with ThreadPoolExecutor(max_workers=workers) as executor:
        return list(executor.map(job_fn, jobs))`,
    processes: `def run_processes(jobs, workers, job_fn):
    with ProcessPoolExecutor(
        max_workers=workers,
        mp_context=get_context("spawn"),
    ) as executor:
        return list(executor.map(job_fn, jobs, chunksize=1))`,
    countPrimes: `def count_primes(n: int) -> int:
    count = 0
    for candidate in range(2, n + 1):
        for divisor in range(2, isqrt(candidate) + 1):
            if candidate % divisor == 0:
                break
        else:
            count += 1
    return count`,
    runJob: `def run_job(job: Job) -> int:
    require_gil(job.expected_gil)
    if job.task == "cpu":
        return count_primes(job.n)
    if job.task == "io":
        time.sleep(job.sleep_s)
        return 1`,
    native: `# 문서의 예 — 이 실험 코드에는 없고 측정하지도 않았다.
import hashlib
h = hashlib.sha256()
h.update(data)  # 2,047바이트를 넘는 data면 계산 중 GIL을 놓는다`,
    asyncio: `def run_asyncio(jobs, workers, job_fn):
    async def run_all():
        semaphore = asyncio.Semaphore(workers)

        async def limited_job(job):
            async with semaphore:
                return await job_fn(job)

        return await asyncio.gather(*(limited_job(job) for job in jobs))

    return asyncio.run(run_all())`,
    asyncJob: `async def run_async_job(job: Job) -> int:
    if job.task == "io":
        require_gil(job.expected_gil)
        await asyncio.sleep(job.sleep_s)
        return 1`,
    loop: `async def blocking_wait(work: LoopWork) -> int:
    time.sleep(work.sleep_s)
    return 1

async def candidate_wait(work: LoopWork) -> int:
    await asyncio.sleep(work.sleep_s)
    return 1

async def compute(work: LoopWork) -> int:
    # 계산 중 await가 없다.
    return sum(count_primes(work.n) for _ in range(work.cpu_jobs))`,
    counterUnlocked: `def increment_unlocked(counter, lock, yield_between):
    previous = counter.completed
    if yield_between:
        time.sleep(0)
    counter.completed = previous + 1`,
    counterLocked: `def increment_candidate(counter, lock, yield_between):
    with lock:
        increment_unlocked(counter, lock, yield_between)`,
    counterWriteOnly: `# 실험에서 실행하지 않은 변형(설명용)
def increment_write_only(counter, lock, yield_between):
    previous = counter.completed
    if yield_between:
        time.sleep(0)
    with lock:
        counter.completed = previous + 1`,
  };

  // 장면 안내. "관찰할 것"과 질문만 두고 답은 쓰지 않는다. 답은 복습 카드와 실험 README에서 확인한다.
  const SCENES = {
    py: {
      observe: [
        'GIL을 켠 같은 인터프리터에서는 한 단계에 Python을 실행하는 스레드가 하나다. 다른 스레드의 상태 이름을 본다.',
        '해제 요청이 표시된 단계와 실제로 GIL을 놓는 단계가 다르다. 요청을 받은 스레드가 CPU에서 실행해야 확인 지점에 닿는다.',
        '같은 구성에서 GIL만 "free-threaded · 끔"으로 바꾸면 무엇이 동시 실행 수를 제한하는지 본다.',
        '프로세스 수를 늘리면 인터프리터와 GIL도 프로세스마다 생긴다.',
      ],
      questions: ['스레드 1-2는 스레드 1-1의 계산이 끝나기 전에 Python 계산을 시작할까?', '논리 CPU를 1개로 줄이고 GIL을 끄면 같은 단계에 몇 개가 실행될까?'],
      measured: [
        '일반 3.14.2 · GIL 켬 · N=200,000 작업 8개 · 워밍업 제외 3회 중앙값: 순차 1.619155초, 스레드 4개 1.610381초, 스레드 8개 1.607350초, 프로세스 4개 0.495228초, 프로세스 8개 0.347412초.',
        '같은 기록의 CPU 사용량 중앙값: 스레드 4개 100.1%, 프로세스 4개 393.6% (논리 CPU 하나를 계속 쓰면 약 100%).',
        '같은 free-threaded 3.14.2t · 스레드 4개: GIL 켬 1.239875초, 끔 0.445464초 (끔/켬 0.359).',
      ],
      evidence: ['readmeCpu48', 'cpuData', 'readmeGilCpu', 'gilCpuData', 'readmeSwitch'],
      cards: ['01-003', '01-004', '01-006', '01-008', '01-009', '01-010', '01-011', '01-020'],
      code: ['countPrimes', 'threads'],
    },
    native: {
      observe: [
        '네이티브 계산 구간의 스레드는 GIL 없이 CPU에서 실행한다. 그동안 다른 스레드가 GIL을 얻어 Python을 실행할 수 있다.',
        '네이티브 계산이 끝나면 Python으로 돌아가기 위해 GIL을 다시 기다린다.',
        '논리 CPU를 스레드 수보다 적게 두면 GIL을 가졌지만 CPU를 기다리는 스레드가 나온다. GIL 보유와 CPU 실행은 다른 상태다.',
      ],
      questions: ['GIL을 켠 같은 인터프리터에서 두 스레드가 같은 단계에 CPU를 쓰는 경우는 언제일까?'],
      measured: ['이 실험은 GIL을 해제하는 네이티브 계산을 측정하지 않았다. hashlib 예는 문서로 확인한 내용이다.'],
      evidence: ['readmeNative', 'docDetach', 'docHashlib'],
      cards: ['01-012'],
      code: ['native'],
    },
    tsleep: {
      observe: [
        'time.sleep()에 들어간 스레드는 GIL을 놓고 OS 대기에 들어간다. CPU도 쓰지 않는다.',
        '대기가 끝나도 Python으로 돌아가려면 GIL을 다시 얻어야 한다.',
        '대기를 겹칠 수 있는 수는 작업자 스레드 수가 정한다. GIL 설정을 바꿔도 이 수는 그대로다.',
      ],
      questions: ['GIL을 켠 상태에서도 네 스레드의 대기가 겹칠 수 있는 이유는?', 'GIL을 끄면 이 장면에서 바뀌는 요소는 무엇일까?'],
      measured: [
        '일반 3.14.2 · GIL 켬 · time.sleep(0.1) 작업 40개 중앙값: 순차 4.145660초, 스레드 4개 1.036234초, 프로세스 4개 1.167388초.',
        '같은 free-threaded 3.14.2t · 스레드 4개: GIL 켬 1.043754초, 끔 1.045442초 (끔/켬 1.001617).',
      ],
      evidence: ['readmeIo', 'ioData', 'readmeGilIo', 'gilIoData', 'srcSleep'],
      cards: ['01-013', '01-014', '01-034'],
      code: ['runJob', 'threads'],
    },
    sem: {
      observe: [
        '작업 수, Task 수(작업 Task + main Task), Semaphore 상한, OS 스레드 수를 따로 센다. 위 "개수" 줄을 본다.',
        '내부 카운터가 0보다 크면 async with 진입(acquire)의 await가 중단 없이 이어진다. 카운터가 0일 때만 Task가 중단한다.',
        'await asyncio.sleep()은 타이머를 등록하고 Task 하나만 중단한다. 같은 루프 스레드가 다른 준비된 Task를 실행한다.',
        '한 Task가 세마포어를 반납하면(release) 기다리던 Task 하나가 바로 깨어나 세마포어를 얻는다. 상한만큼 모두 끝나기를 기다리지 않는다.',
      ],
      questions: ['작업 6개·상한 2개라면 Semaphore 안에 동시에 들어간 Task는 최대 몇 개이고, 그때 OS 스레드는 몇 개일까?'],
      measured: [
        '일반 3.14.2 · await asyncio.sleep(0.1) 작업 40개 · 상한 4개 중앙값 1.012820초.',
        '추적 기록: 작업 Task 40개가 같은 PID·OS 스레드·이벤트 루프에서 시작·종료했고, 작업 구간이 겹친 수의 최댓값은 4였다.',
      ],
      evidence: ['readmeTrace', 'traceData', 'readmeIo', 'srcLocks', 'docSemaphore'],
      cards: ['01-016', '01-017', '01-021', '01-022'],
      code: ['asyncio', 'asyncJob'],
    },
    loop: {
      observe: [
        'A와 B는 같은 OS 스레드에서 돈다. 스레드 칸은 하나이고 Task 칸이 둘이다.',
        'A가 time.sleep()을 부르면 스레드 전체가 대기한다. B의 예정이 지나도 루프가 확인하지 못한다.',
        'A가 await asyncio.sleep()으로 기다리면 A만 중단하고 루프가 B를 실행한다.',
        'A가 중단 없이 계산하면 GIL을 꺼도 B는 A가 끝난 뒤에 재개한다. GIL 교대와 Task 교대는 다른 규칙이다.',
      ],
      questions: ['A가 time.sleep()을 부르면 GIL은 풀리는데 B는 왜 실행되지 못할까?', 'GIL만 끄면 A의 계산 도중 B가 재개할까?'],
      measured: [
        '일반 3.14.2 · GIL 켬 · B의 첫 재개 지연 중앙값: A 없음 0.000494초, time.sleep(1) 0.902615초, await asyncio.sleep(1) 0.001157초, CPU 계산 1.488489초 (A 실행 구간 1.588400초).',
        'A 없음과 비동기 대기의 차이는 약 0.663ms였고, 미리 정한 허용치는 10ms였다.',
        'GIL을 끈 이벤트 루프 지연은 측정하지 않았다. 학습 문답으로 다뤘다.',
      ],
      evidence: ['readmeLoop', 'loopData', 'readmeLoopExplain', 'readmeLoopGil', 'loopLab'],
      cards: ['01-015', '01-017', '01-018', '01-019', '01-020', '01-037', '01-038'],
      code: ['loop'],
    },
    counter: {
      observe: [
        '공유 값과 스레드마다의 지역 변수 previous를 따로 본다. 두 스레드가 같은 이전 값을 읽으면 쓰기가 차례로 일어나도 증가가 유실된다.',
        'Lock 범위를 "쓰기만"과 "읽기부터 쓰기까지"로 바꿔 결과를 비교한다.',
        'GIL은 읽기·쓰기 묶음을 보호하지 않는다. GIL을 꺼도, sleep(0)을 빼도 결과가 어떻게 되는지 본다.',
        '프로세스를 늘리면 카운터와 Lock이 프로세스마다 따로 생긴다. 일반 Python 객체는 자동으로 공유되지 않는다.',
      ],
      questions: ['"쓰기만 Lock" 구성에서도 최종값이 기대값보다 작아지는 순서는?', '이 순서가 1,000번 실행에서 한 번도 나오지 않았다면 안전하다고 할 수 있을까?'],
      measured: [
        '일반 3.14.2 · GIL 켬 · 스레드 2개 × 1회 증가 · 읽기와 쓰기 사이 sleep(0) · 본 시도 100회: 락 없는 원본은 최종값 2가 90회, 1이 10회. 공유 락 수정본은 100회 모두 2.',
        '"쓰기만 Lock", GIL 끔, 프로세스 여러 개 조건은 측정하지 않았다.',
      ],
      evidence: ['readmeCounter', 'counterData', 'counterCode', 'readmeLockApi', 'docLockWith'],
      cards: ['01-023', '01-024', '01-025', '01-027'],
      code: ['counterUnlocked', 'counterLocked'],
    },
  };

  const CARDS = {
    '01-002': 'CPython의 threading.Thread로 시작한 스레드는 OS 스레드와 별개의 실행 단위인가?',
    '01-003': '논리 CPU가 4개이면 OS 스레드를 10개 생성할 수 없는가?',
    '01-004': 'GIL을 켠 같은 CPython 인터프리터의 스레드 4개는 순수 Python 계산을 동시에 실행할 수 있는가?',
    '01-005': 'CPython에서 서로 다른 인터프리터는 반드시 서로 다른 GIL을 사용하는가?',
    '01-006': 'GIL을 켠 일반 CPython에서 프로세스 4개가 각각 인터프리터 하나를 실행하면, 순수 Python 계산을 병렬 실행할 수 있는 이유는 무엇인가?',
    '01-007': 'free-threaded CPython 빌드로 실행했다는 사실만으로 GIL이 꺼져 있다고 판단할 수 있는가?',
    '01-008': 'GIL을 켠 같은 인터프리터에서 스레드 A가 긴 순수 Python 계산을 하면, B는 A의 계산 전체가 끝나야 Python 계산을 시작할 수 있는가?',
    '01-009': 'CPython 3.14.2에서 GIL을 기다리는 B는 어떤 조건에서 보유 스레드 A에게 해제 요청을 표시하는가?',
    '01-010': 'GIL을 가진 스레드가 해제 요청을 받으면 CPython은 계산을 어떻게 교대시키는가?',
    '01-011': 'sys.getswitchinterval()이 0.005이면 스레드가 정확히 5ms마다 교대하는가?',
    '01-012': 'GIL을 켠 CPython에서 CPU 계산을 하는 스레드는 항상 GIL을 가지고 있어야 하는가?',
    '01-013': 'GIL을 켠 같은 인터프리터에서 여러 스레드의 time.sleep() 대기가 겹칠 수 있는 이유는 무엇인가?',
    '01-014': 'GIL을 켠 CPython에서 time.sleep()의 대기 시간이 끝나면 해당 스레드는 곧바로 Python 코드를 실행할 수 있는가?',
    '01-015': '이벤트 루프 스레드에서 실행하는 함수를 async def로 선언하면, 그 안의 긴 순수 Python 계산도 다른 Task와 자동으로 교대하는가?',
    '01-016': 'await 표현식은 항상 현재 Task의 실행을 중단시키는가?',
    '01-017': 'CPython 3.14.2에서 await asyncio.sleep(1)은 별도 작업자 스레드에 대기를 맡기는가?',
    '01-018': '같은 이벤트 루프의 Task A가 time.sleep(1)을 호출하면, GIL을 해제하는데도 Task B가 지연되는 이유는 무엇인가?',
    '01-019': 'GIL을 끈 CPython에서도, 단일 이벤트 루프의 Task A가 중단 없이 긴 CPU 계산을 하면 Task B가 지연되는가?',
    '01-020': 'A가 먼저 긴 순수 Python 계산을 시작했다. B가 A 완료 전에 시작할 수 있는 것은 ① OS 스레드 2개 ② 단일 루프 스레드의 Task 2개 중 어느 경우인가?',
    '01-021': 'Task 40개가 async with asyncio.Semaphore(4) 안에서 작업한다. 여기서 4는 무엇의 상한인가?',
    '01-022': '각각 0.1초 기다리는 독립 작업 40개를 최대 4개씩 겹쳐 실행하면, 부대비용을 무시한 전체 시간은 얼마인가?',
    '01-023': '두 스레드가 모두 0을 읽어 둔 뒤 각각 읽은 값 + 1을 저장했다. 최종값이 1인 이유는?',
    '01-024': '공유 카운터의 증가가 읽기·계산·저장으로 나뉘어 있다. 저장 부분에만 락을 걸면 충분한가?',
    '01-025': 'with lock: 안에서 return하거나 예외가 발생하면 락은 어떻게 되는가?',
    '01-027': '경쟁 상태가 의심되는 코드를 1,000회 실행했지만 모두 정상이었다. 이것만으로 안전성을 보장할 수 있는가?',
    '01-034': 'time.sleep(0.1) 작업 40개에서 스레드 4개는 1.036234초, 프로세스 4개는 1.167388초였다. 전체 시간 기준으로 무엇을 고를까?',
    '01-035': '일반 빌드와 free-threaded 빌드의 시간을 바로 비교하면 무엇이 섞이는가?',
    '01-037': 'B는 시작 0.1초 뒤 재개할 예정이었지만 1.0초 뒤 재개됐다. 예정 대비 지연은 얼마인가?',
    '01-038': 'B의 첫 재개 지연 중앙값이 A 없음 0.49ms, 비동기 대기 1.16ms였다. 10ms 기준을 만족하는가?',
  };

  root.RuntimeContent = { EV, TYPE_LABEL, CODE, SCENES, CARDS };
})(typeof self !== 'undefined' ? self : this);
