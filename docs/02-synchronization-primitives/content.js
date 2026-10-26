/*
 * 요소 설명·장면 안내·근거 링크. 실행 상태는 model.js가 만들고 여기서는 고정된 설명만 둔다.
 * 근거 종류: measured(실측 기록), source(소스·공식 문서), record(실험 문답 기록), model(설명용 가정).
 */
(function (root) {
  'use strict';

  // 근거 파일은 GitHub의 main 브랜치 판을 연다. 화면을 Pages에서 열든 내려받은 폴더에서 열든 같은 곳으로 간다.
  const REPO = 'https://github.com/joowankim/cs-lab/blob/main/';
  const TREE = 'https://github.com/joowankim/cs-lab/tree/main/';
  const EXP = `${REPO}experiments/02-synchronization-primitives/`;
  const README = `${EXP}README.md`;
  const ANKI = `${REPO}anki/02-synchronization-primitives.md`;
  const SRC = 'https://github.com/python/cpython/blob/v3.14.2/';
  const DOCS = 'https://docs.python.org/3.14/';
  const RUN = '2026-10-26T';

  const EV = {
    readmeProblem1: { type: 'record', label: '실험 README · 문제 상황 1: 상한 4개인데 동시 호출이 늘어난 서버', href: `${README}#문제-상황-1-상한-4개인데-동시-호출이-늘어난-서버` },
    readmeProblem2: { type: 'record', label: '실험 README · 문제 상황 2: 첫 업로드 뒤 작업자 하나가 사라진 썸네일 서버', href: `${README}#문제-상황-2-첫-업로드-뒤-작업자-하나가-사라진-썸네일-서버` },
    readmeBatch2Setup: { type: 'record', label: '실험 README · 묶음 2 측정 조건 (모니터, 세마포어 둘로 만든 버퍼)', href: `${README}#묶음-2-측정-조건-에이전트-제안-2026-10-25` },
    readmeProblem3: { type: 'record', label: '실험 README · 문제 상황 3: 기다리는 스레드가 늘수록 느려진 서버 시작', href: `${README}#문제-상황-3-기다리는-스레드가-늘수록-느려진-서버-시작` },
    readmeBatch3Setup: { type: 'record', label: '실험 README · 묶음 3 측정 조건 (스핀락이 나은 경우)', href: `${README}#묶음-3-측정-조건` },
    readmeProblem4: { type: 'record', label: '실험 README · 문제 상황 4: 서로에게 송금하면 멈추는 이체', href: `${README}#문제-상황-4-서로에게-송금하면-멈추는-이체` },
    readmeProblem5: { type: 'record', label: '실험 README · 문제 상황 5: 식사하는 철학자', href: `${README}#문제-상황-5-식사하는-철학자` },
    readmeQ10: { type: 'record', label: '실험 README · 질문 10: 임계 영역 문제를 푸는 세 조건', href: `${README}#질문-10-임계-영역-문제를-푸는-세-조건` },
    readmeEnv: { type: 'measured', label: '실험 README · 측정 환경과 원자료 (Apple M2 Pro, CPython 3.14.2)', href: `${README}#측정-환경과-원자료-2026-10-26` },
    readmeBatch1: { type: 'measured', label: '실험 README · 묶음 1 결과: 이중 release() (조건마다 100회)', href: `${README}#묶음-1-이중-release-조건마다-100회` },
    readmeBatch2: { type: 'measured', label: '실험 README · 묶음 2 결과: 조건 변수 버퍼 (조건마다 30회)', href: `${README}#묶음-2-조건-변수-버퍼-조건마다-30회` },
    readmeBatch3: { type: 'measured', label: '실험 README · 묶음 3 결과: 바쁜 대기와 Event (조건마다 10회)', href: `${README}#묶음-3-바쁜-대기와-event-조건마다-10회` },
    readmeBatch4: { type: 'measured', label: '실험 README · 묶음 4 결과: 이체 (조건마다 10회)', href: `${README}#묶음-4-이체-조건마다-10회-10초-안에-안-끝나면-멈춤` },
    readmePhil: { type: 'measured', label: '실험 README · 묶음 4 결과: 식사하는 철학자 (조건마다 10회)', href: `${README}#묶음-4-식사하는-철학자-조건마다-10회` },
    readmeInterp: { type: 'record', label: '실험 README · 이체 2·3번의 첫 해석 (GIL이 넘어갈 기회)', href: `${README}#이체-23번의-첫-해석` },
    readmeCheck1: { type: 'record', label: '실험 README · 마무리 문답: 같은 이중 release(), 다른 결과', href: `${README}#묶음-1-같은-이중-release-다른-결과` },
    readmeCheck2: { type: 'record', label: '실험 README · 마무리 문답: if·while과 notify·notify_all', href: `${README}#묶음-2-ifwhile과-notifynotify_all` },
    readmeCheck3: { type: 'record', label: '실험 README · 마무리 문답: 바쁜 대기, sleep, Event', href: `${README}#묶음-3-바쁜-대기-sleep-event` },
    readmeCheck4: { type: 'record', label: '실험 README · 마무리 문답: 고친 코드가 깬 조건', href: `${README}#묶음-4-고친-코드가-깬-조건` },
    readmeVariant1: { type: 'record', label: '실험 README · 변형 문제 1: 버퍼 크기 1과 조건 변수 하나', href: `${README}#변형-문제-1-버퍼-크기-1과-조건-변수-하나` },
    readmeVariant2: { type: 'record', label: '실험 README · 변형 문제 2: 자기 계좌로 이체', href: `${README}#변형-문제-2-자기-계좌로-이체` },
    readmeChoice: { type: 'record', label: '실험 README · 상황별 도구 선택', href: `${README}#상황별-도구-선택` },
    readmeConclusion: { type: 'record', label: '실험 README · 정리한 결론과 선택 기준', href: `${README}#정리한-결론과-선택-기준` },
    releaseKernels: { type: 'source', label: 'python/release_kernels.py', href: `${EXP}python/release_kernels.py` },
    releaseLab: { type: 'source', label: 'python/release_lab.py (handle, FakeApi)', href: `${EXP}python/release_lab.py` },
    bufferKernels: { type: 'source', label: 'python/buffer_kernels.py', href: `${EXP}python/buffer_kernels.py` },
    bufferLab: { type: 'source', label: 'python/buffer_lab.py (work, settle)', href: `${EXP}python/buffer_lab.py` },
    waitKernels: { type: 'source', label: 'python/wait_kernels.py', href: `${EXP}python/wait_kernels.py` },
    waitLab: { type: 'source', label: 'python/wait_lab.py (load, serve)', href: `${EXP}python/wait_lab.py` },
    deadlockKernels: { type: 'source', label: 'python/deadlock_kernels.py', href: `${EXP}python/deadlock_kernels.py` },
    deadlockLab: { type: 'source', label: 'python/deadlock_lab.py (move, 멈춤 판단)', href: `${EXP}python/deadlock_lab.py` },
    releaseData: { type: 'measured', label: '원자료 · 묶음 1 이중 release()', href: `${EXP}results/${RUN}191017564448-release-python-3.14.2.jsonl` },
    bufferData: { type: 'measured', label: '원자료 · 묶음 2 조건 변수 버퍼', href: `${EXP}results/${RUN}192632878236-buffer-python-3.14.2.jsonl` },
    waitData: { type: 'measured', label: '원자료 · 묶음 3 바쁜 대기와 Event', href: `${EXP}results/${RUN}192812343352-wait-python-3.14.2.jsonl` },
    deadlockData: { type: 'measured', label: '원자료 · 묶음 4 이체와 식사하는 철학자', href: `${EXP}results/${RUN}193139713666-deadlock-python-3.14.2.jsonl` },
    deadlockStacks: { type: 'measured', label: '원자료 · 멈춘 실행의 스택 27개', href: `${TREE}experiments/02-synchronization-primitives/results/${RUN}193139713666-deadlock-stacks` },
    srcCondInit: { type: 'source', label: 'CPython v3.14.2 · Condition.__init__ (기본 락은 RLock)', href: `${SRC}Lib/threading.py#L290-L307` },
    srcCondWait: { type: 'source', label: 'CPython v3.14.2 · Condition.wait', href: `${SRC}Lib/threading.py#L337-L383` },
    srcNotify: { type: 'source', label: 'CPython v3.14.2 · Condition.notify, notify_all', href: `${SRC}Lib/threading.py#L408-L445` },
    srcSemaphore: { type: 'source', label: 'CPython v3.14.2 · Semaphore', href: `${SRC}Lib/threading.py#L459-L543` },
    srcBounded: { type: 'source', label: 'CPython v3.14.2 · BoundedSemaphore', href: `${SRC}Lib/threading.py#L546-L588` },
    srcEvent: { type: 'source', label: 'CPython v3.14.2 · Event', href: `${SRC}Lib/threading.py#L591-L671` },
    srcLockRelease: { type: 'source', label: 'CPython v3.14.2 · Lock.release (release unlocked lock)', href: `${SRC}Modules/_threadmodule.c#L858-L869` },
    srcRlockRelease: { type: 'source', label: 'CPython v3.14.2 · RLock.release (cannot release un-acquired lock)', href: `${SRC}Modules/_threadmodule.c#L1082-L1092` },
    srcFair: { type: 'source', label: 'CPython v3.14.2 · Python/lock.c (1ms 넘게 기다린 스레드에 넘김)', href: `${SRC}Python/lock.c#L19-L22` },
    srcQueue: { type: 'source', label: 'CPython v3.14.2 · Lib/queue.py', href: `${SRC}Lib/queue.py` },
    docLock: { type: 'source', label: 'Python 3.14 문서 · Lock', href: `${DOCS}library/threading.html#lock-objects` },
    docRlock: { type: 'source', label: 'Python 3.14 문서 · RLock', href: `${DOCS}library/threading.html#rlock-objects` },
    docCondition: { type: 'source', label: 'Python 3.14 문서 · Condition', href: `${DOCS}library/threading.html#condition-objects` },
    docSemaphore: { type: 'source', label: 'Python 3.14 문서 · Semaphore, BoundedSemaphore', href: `${DOCS}library/threading.html#semaphore-objects` },
    docEvent: { type: 'source', label: 'Python 3.14 문서 · Event', href: `${DOCS}library/threading.html#event-objects` },
    docWith: { type: 'source', label: 'Python 3.14 문서 · with 문으로 쓰는 락, 조건 변수, 세마포어', href: `${DOCS}library/threading.html#using-locks-conditions-and-semaphores-in-the-with-statement` },
    docQueue: { type: 'source', label: 'Python 3.14 문서 · queue', href: `${DOCS}library/queue.html` },
    docSwitch: { type: 'source', label: 'Python 3.14 문서 · sys.setswitchinterval', href: `${DOCS}library/sys.html#sys.setswitchinterval` },
    modelOrder: { type: 'model', label: '화면 README · 모형의 가정 (한 단계에 스레드 하나, 깨우는 순서)', href: `${REPO}docs/02-synchronization-primitives/README.md#모형의-가정` },
    anki: { type: 'record', label: '복습 카드 (anki/02-synchronization-primitives.md)', href: ANKI },
  };

  const TYPE_LABEL = { measured: '실측 기록', source: '소스·공식 문서', record: '실험 기록', model: '설명용 가정' };

  // 실험 코드에서 옮긴 부분. 문서 문자열과 일부 주석, 실행 틀의 기록 줄은 뺐다.
  // two는 README의 고친 모양(에이전트 작성)에서 버퍼 크기만 CAPACITY = 1로 바꾼 것이다.
  const CODE = {
    releaseBuggy: `def call_api_buggy(slots, api, req: int) -> str:
    slots.acquire()
    try:
        return api.send(req)
    except TimeoutError:
        slots.release()
        return api.send_later(req)
    finally:
        slots.release()`,
    releaseFixed: `def call_api_candidate(slots, api, req: int) -> str:
    with slots:
        try:
            return api.send(req)
        except TimeoutError:
            return api.send_later(req)`,
    handle: `def handle(req: int) -> dict:
    try:
        return {"req": req, "result": call_api(slots, api, req), "error": None}
    except Exception as exc:
        return {"req": req, "result": None, "error": f"{type(exc).__name__}: {exc}"}

with ThreadPoolExecutor(max_workers=workers) as executor:
    outcomes = list(executor.map(handle, range(1, requests + 1)))`,
    put: `def put(buf: Buffer, job) -> None:
    with buf.cond:
        while len(buf.jobs) >= CAPACITY:
            buf.cond.wait()
        buf.jobs.append(job)
        buf.wake()`,
    takeIf: `def take_if(buf: Buffer):
    with buf.cond:
        if not buf.jobs:
            buf.cond.wait()
        job = buf.jobs.popleft()
        buf.wake()
        return job`,
    takeWhile: `def take_while(buf: Buffer):
    with buf.cond:
        while not buf.jobs:
            buf.cond.wait()
        job = buf.jobs.popleft()
        buf.wake()
        return job`,
    work: `def work() -> None:
    while True:
        job = take(buf)
        if job is STOP:
            return
        sleep(job_s)`,
    uploads: `alive_at_start = settle(0)
for job in range(1, uploads + 1):
    put(buf, job)
    alive_after_uploads.append(settle(job))`,
    two: `CAPACITY = 1
lock = threading.Lock()
not_full = threading.Condition(lock)   # 업로드 요청 스레드가 기다리는 곳
not_empty = threading.Condition(lock)  # 작업자가 기다리는 곳

def put(job):
    with not_full:
        while len(jobs) >= CAPACITY:
            not_full.wait()
        jobs.append(job)
        not_empty.notify()

def take():
    with not_empty:
        while not jobs:
            not_empty.wait()
        job = jobs.popleft()
        not_full.notify()
        return job`,
    ready: `class Ready:
    def __init__(self):
        self.flag = False
        self.event = threading.Event()

    def set(self) -> None:
        self.flag = True
        self.event.set()`,
    waitPass: `def wait_pass(ready: Ready) -> None:
    while not ready.flag:
        pass`,
    waitSleep: `def wait_sleep(ready: Ready) -> None:
    while not ready.flag:
        time.sleep(POLL_S)`,
    waitEvent: `def wait_event(ready: Ready) -> None:
    ready.event.wait()`,
    load: `def load() -> None:
    value = build_index(n)
    ready.set()`,
    serve: `def serve() -> None:
    wait(ready)`,
    account: `class Account:
    def __init__(self, name: str, balance: int):
        self.name = name
        self.balance = balance
        self.lock = threading.Lock()`,
    checkDb: `def check_limit_db(src: Account, amount: int) -> None:
    time.sleep(DB_S)`,
    checkMemory: `def check_limit_memory(src: Account, amount: int) -> None:
    if amount > DAILY_LIMIT:
        raise ValueError("이체 한도 초과")`,
    opposite: `def transfer_opposite(src: Account, dst: Account, amount: int, check_limit) -> int:
    with src.lock:
        check_limit(src, amount)
        with dst.lock:
            src.balance -= amount
            dst.balance += amount
    return 0`,
    ordered: `def transfer_ordered(src: Account, dst: Account, amount: int, check_limit) -> int:
    first, second = sorted((src, dst), key=lambda acc: acc.name)
    with first.lock:
        with second.lock:
            check_limit(src, amount)
            src.balance -= amount
            dst.balance += amount
    return 0`,
    retry: `def transfer_retry(src: Account, dst: Account, amount: int, check_limit) -> int:
    retries = 0
    while True:
        src.lock.acquire()
        if dst.lock.acquire(blocking=False):
            break
        src.lock.release()
        retries += 1
        time.sleep(random.uniform(0, BACKOFF_S))
    try:
        check_limit(src, amount)
        src.balance -= amount
        dst.balance += amount
    finally:
        dst.lock.release()
        src.lock.release()
    return retries`,
    move: `def move(name: str, src: Account, dst: Account) -> None:
    for _ in range(per_thread):
        retries[name] += transfer(src, dst, 1, check)
        done[name] += 1`,
    pickLeft: `def pick_left_first(forks: list, i: int) -> tuple:
    return forks[i], forks[(i + 1) % len(forks)]`,
    pickLarger: `def pick_larger_first(forks: list, i: int) -> tuple:
    indices = [i, (i + 1) % len(forks)]
    return forks[max(indices)], forks[min(indices)]`,
    philosopher: `def philosopher(forks: list, i: int, pick, meals: int, eaten: list[int], waiter=None) -> None:
    first, second = pick(forks, i)
    for _ in range(meals):
        time.sleep(random.uniform(0, THINK_S))   # 생각한다
        if waiter is not None:
            waiter.acquire()
        try:
            with first:                          # 첫 포크를 집는다
                time.sleep(PICK_S)               # 포크를 집는 데 1ms
                with second:                     # 둘째 포크를 집는다
                    time.sleep(EAT_S)            # 먹는다
        finally:
            if waiter is not None:
                waiter.release()
        eaten[i] += 1`,
  };

  // 장면 안내. 볼 것과 질문만 두고 질문의 답은 쓰지 않는다. 답은 복습 카드와 실험 README에서 확인한다.
  const SCENES = {
    release: {
      questions: [
        'Semaphore 구성에서 동시 호출이 상한 2를 처음 넘는 단계는 언제일까? 그 전에 카운터는 몇이 될까?',
        '같은 코드에서 Lock이나 RLock으로 바꾸면 오류는 어느 스레드의 어느 release()에서 날까?',
      ],
      observe: [
        '타임아웃 난 호출 하나가 release()를 두 번 부른다. 세마포어 상자의 카운터와, 얻고 아직 반납하지 않은 스레드(파란 선)의 수를 더해 초깃값 2와 비교한다.',
        'BoundedSemaphore는 남는 release()를 바로 막지 못한다. 카운터를 초깃값보다 크게 만드는 그 release()에서만 ValueError를 낸다.',
        'Lock 상자에는 잠금과 잠금 해제만 있다. 두 번째 release()가 누구의 잠금을 풀었는지 본다.',
        'RLock은 주인과 수준을 기억한다. 두 번째 release()가 바로 오류가 되는 이유를 본다.',
        '코드를 "with 문"으로 바꾸면 acquire()와 release()가 한 번씩 짝지어진다.',
      ],
      measured: [
        '실험: Apple M2 Pro, CPython 3.14.2(GIL 켬), 요청 40개, 작업자 8개, 상한 4(락은 1), 5·15·25번째 호출이 타임아웃, 조건마다 100회.',
        '고치지 않은 코드의 최대 동시 호출(100회 모두): Semaphore 7, BoundedSemaphore 7, Lock 4, RLock 1.',
        '고치지 않은 코드의 오류: Semaphore 0번(끝난 뒤 카운터 7). BoundedSemaphore 회마다 ValueError 3번, 300번 모두 34~40번째의 타임아웃이 아닌 호출. Lock 회마다 RuntimeError 3번, 300번 모두 36~40번째의 타임아웃이 아닌 호출. RLock 회마다 RuntimeError 3번, 300번 모두 타임아웃 난 5·15·25번째 호출.',
        '고친 코드(with 문) 넷: 최대 동시 호출 4·4·1·1(100회 모두), 오류 0번.',
      ],
      evidence: ['readmeProblem1', 'readmeBatch1', 'readmeEnv', 'releaseData', 'readmeCheck1', 'readmeChoice', 'readmeConclusion', 'releaseKernels', 'releaseLab', 'srcSemaphore', 'srcBounded', 'srcLockRelease', 'srcRlockRelease'],
      cards: ['02-001', '02-002', '02-003', '02-004', '02-005', '02-006', '02-007', '02-009'],
    },
    buffer: {
      questions: [
        'take()가 if로 기다리고 notify()로 깨우면, 작업자 4개 가운데 업로드 세 번 뒤 남는 작업자는 몇 개일까?',
        'while로 바꾸면 빈 jobs에서 깨어난 작업자는 무엇을 할까?',
      ],
      observe: [
        '조건 변수 상자의 대기 목록 순서를 본다. notify()는 맨 앞 스레드 하나를, notify_all()은 모두를 깨운다.',
        '깨어난 스레드는 바로 실행되지 않는다. 락(RLock)을 다시 얻어야 wait()에서 돌아온다. 그 사이에 다른 스레드가 jobs를 비울 수 있다.',
        '작업을 꺼낸 작업자도 take() 안에서 다른 작업자를 깨운다. 깨어난 작업자가 jobs를 다시 확인하는지(if, while) 본다.',
        '업로드 스레드 P는 작업자가 모두 다시 기다릴 때까지 기다렸다가 다음 작업을 넣는다(실험의 settle()).',
      ],
      measured: [
        '실험: 작업자 2·4개, 업로드 3번 뒤 작업 20개, 조건마다 30회.',
        '업로드 1·2·3번째 뒤 남은 작업자(30회 모두): if·notify()·2개 1·1·1, if·notify_all()·2개 1·1·1, if·notify()·4개 3·2·1, if·notify_all()·4개 1·1·1, while·2개 2·2·2, while·4개 4·4·4.',
        '회마다 IndexError: if·2개 1번, if·4개 3번, while 0번.',
        '20개 처리 시간 중앙값: if 0.472~0.477초, while·2개 0.237~0.239초, while·4개 0.120~0.121초.',
        '빈 jobs에서 깨어난 횟수(30회 모두 같음): if·2개 1번, if·4개와 while·notify()·2개·4개와 while·notify_all()·2개 3번, while·notify_all()·4개 9번.',
      ],
      evidence: ['readmeProblem2', 'readmeBatch2Setup', 'readmeBatch2', 'readmeEnv', 'bufferData', 'readmeCheck2', 'readmeChoice', 'readmeConclusion', 'bufferKernels', 'bufferLab', 'srcCondWait', 'srcNotify', 'docCondition'],
      cards: ['02-010', '02-012', '02-013', '02-017'],
    },
    onecond: {
      questions: [
        '조건 변수 하나와 notify()만 쓰면 P의 두 번째 put()은 끝날 수 있을까? 대기 목록에 누가 어떤 순서로 서는지 따라가 본다.',
        'notify_all()로 바꾸거나 조건 변수를 둘로 나누면 무엇이 달라질까?',
      ],
      observe: [
        '처음 대기 목록은 t1, t2다. put(1)의 notify()가 누구를 깨우는지, put(2)에서 P가 대기 목록의 어디에 서는지 본다.',
        'P에게 가야 할 통지를 앞에 선 작업자가 받으면, 그 작업자는 빈 jobs를 보고 다시 기다린다. 통지는 쌓이지 않는다.',
        '"조건 변수 둘"은 두 조건 변수가 lock 하나를 함께 쓴다. P는 not_full에서, 작업자는 not_empty에서 기다린다.',
      ],
      measured: [
        '본 측정이 아니다. 컨테이너(CPython 3.13·3.14.2)에서 실험 코드의 put()·take_while()을 버퍼 크기 1로 20번 돌려 20번 모두 작업 1만 처리하고 세 스레드가 대기 목록에 남은 채 멈췄다.',
        'Condition()을 따로 두 개 만들면 put() 안에서 not_empty.notify()를 부를 때 RuntimeError(cannot notify on un-acquired lock)가 났다(컨테이너 임시 확인).',
        'notify_all() 구성과 lock 하나를 함께 쓰는 조건 변수 둘 구성은 실행해 재지 않았다.',
      ],
      evidence: ['readmeVariant1', 'readmeCheck2', 'readmeChoice', 'readmeConclusion', 'srcNotify', 'srcCondInit', 'srcQueue', 'docQueue'],
      cards: ['02-011', '02-014', '02-015'],
    },
    wait: {
      questions: [
        '로더 L이 계산하는 동안 요청 처리 스레드들이 pass로 돌며 GIL을 나눠 쓰면, L이 set()을 부르는 단계는 얼마나 늦어질까?',
        'sleep으로 쉬며 확인하면 L이 set()을 부른 뒤 스레드들은 언제 알아챌까? Event.wait()이면?',
      ],
      observe: [
        'GIL 꼬리표가 어느 스레드 상자에 있는지 본다. 바쁜 대기도 파이썬 코드라서 GIL을 쥐고 실행한다.',
        'sleep으로 쉬는 스레드와 Event.wait()로 블록된 스레드는 GIL을 요청하지 않는다. 그동안 L이 GIL을 혼자 쓴다.',
        'sleep으로 쉬는 스레드는 L이 set()을 불러도 정해 둔 단계까지 잔다. Event.wait()로 기다리는 스레드는 set()이 바로 깨운다.',
      ],
      measured: [
        '실험: 로더 혼자 약 1초 걸리는 계산, 기다리는 스레드 4·8개, 조건마다 10회.',
        '로딩 시간 중앙값: 로더만 1.000초, pass 4개 4.84초·8개 8.71초, time.sleep(0.01) 4개 0.996초·8개 0.993초, Event.wait() 4개 1.000초·8개 1.003초.',
        '로더가 계산을 마친 뒤 마지막 스레드가 빠져나오기까지 중앙값: pass 0.11ms·0.16ms, sleep 8.73ms·8.74ms, Event 0.12ms·0.31ms.',
        '기다리는 스레드의 CPU 시간 중앙값: pass 3.87초·7.79초, sleep 0.003초·0.010초, Event 0.000초.',
      ],
      evidence: ['readmeProblem3', 'readmeBatch3', 'readmeEnv', 'waitData', 'readmeCheck3', 'readmeBatch3Setup', 'readmeChoice', 'readmeConclusion', 'waitKernels', 'waitLab', 'srcEvent', 'docEvent', 'docSwitch'],
      cards: ['02-018', '02-019', '02-020', '02-021', '02-022'],
    },
    transfer: {
      questions: [
        '보내는 계좌부터 잠그는 이체에서 t1과 t2는 각각 무엇을 쥐고 무엇을 기다리게 될까?',
        '락 순서 고정과 내려놓고 다시는 교착 상태의 네 조건 가운데 각각 무엇을 깰까?',
        '자기 계좌로 이체하면(A→A) Lock과 RLock에서 각각 어떻게 될까?',
      ],
      observe: [
        '파란 선은 쥔 락, 회색 점선은 기다리는 락이다. 기다림이 고리를 이루면 고리의 선을 주황으로 그린다.',
        '한도 확인을 "메모리 캐시 확인"으로 바꾸면 첫 락만 쥔 구간이 짧아진다. 이체 수를 늘리며 GIL이 넘어가는 순간 어디에 있는지 본다.',
        '락 순서 고정은 두 스레드가 같은 순서(A, B)로 잡는다. 내려놓고 다시는 받는 계좌를 바로 잡지 못하면 쥔 락을 놓는다.',
        '내려놓고 다시의 "다시 시도"는 스레드마다 이체가 1번이면 나오지 않는다. "구성 더 바꾸기"에서 2번 이상(메모리 캐시 확인이면 3번)으로 늘려 본다.',
        '"A→A"는 자기 계좌 이체다. 스레드 하나만으로도 멈출 수 있는지 본다.',
      ],
      measured: [
        '실험: 두 스레드가 A→B, B→A로 1씩 보낸다. 조건마다 10회, 10초 안에 안 끝나면 멈춤으로 본다.',
        '1번 보내는 계좌부터·DB 확인 1ms: 10회 모두 첫 이체에서 멈춤. 2번 메모리 캐시·스레드마다 1,000번: 멈춤 0회, 0.91ms. 3번 메모리 캐시·10만 번: 9회 멈춤(멈춘 9회의 마친 이체 16,041~149,281번), 끝난 1회 69.6ms.',
        '4번 락 순서 고정: 멈춤 0회, 2.79초. 5번 내려놓고 다시: 멈춤 0회, 2.78초, 다시 시도 중앙값 1,147번.',
        '멈춘 동안 쓴 CPU 시간 중앙값: 1번 0.004초, 3번 0.023초.',
        '자기 계좌 이체는 컨테이너 임시 확인이다: Lock이면 락 순서 고정과 내려놓고 다시 모두 끝나지 않았고, RLock이면 둘 다 끝났다(다시 시도 0번).',
      ],
      evidence: ['readmeProblem4', 'readmeBatch4', 'readmeEnv', 'deadlockData', 'deadlockStacks', 'readmeInterp', 'readmeCheck4', 'readmeVariant2', 'readmeChoice', 'readmeConclusion', 'deadlockKernels', 'deadlockLab', 'docLock', 'docRlock'],
      cards: ['02-008', '02-023', '02-024', '02-025', '02-026', '02-028', '02-030', '02-031'],
    },
    phil: {
      questions: [
        '다섯 명이 같은 시간 동안 생각하고 모두 왼쪽 포크부터 집으면 몇 명이 먹을 수 있을까?',
        '번호가 큰 포크부터 집기와 웨이터는 교착 상태의 네 조건 가운데 각각 무엇을 깰까?',
      ],
      observe: [
        '철학자 i는 양옆의 포크 i와 포크 i+1을 쓴다. 철학자 4는 포크 4와 포크 0을 쓴다.',
        '생각 시간을 "서로 다르게"로 바꾸면 누군가 이웃보다 먼저 두 포크를 집어 고리가 생기지 않는지 본다.',
        '"큰 번호 먼저"에서 철학자 3과 철학자 4가 처음 집으려는 포크를 본다. 웨이터는 한 번에 넷만 포크를 집으러 보낸다.',
      ],
      measured: [
        '실험: 철학자 다섯, 끼니 100번, 생각 시간 0~2ms 무작위, 조건마다 10회, 10초 안에 안 끝나면 멈춤으로 본다.',
        '모두 왼쪽 먼저: 10회 중 6회 멈춤(멈춘 6회 모두 먹은 횟수 0), 끝난 4회 0.69초.',
        '번호가 큰 포크 먼저: 멈춤 0회, 0.70초. 웨이터 Semaphore(4)와 왼쪽 먼저: 멈춤 0회, 0.75초.',
        '멈춘 동안 쓴 CPU 시간 중앙값 0.004초.',
      ],
      evidence: ['readmeProblem5', 'readmePhil', 'readmeEnv', 'deadlockData', 'deadlockStacks', 'readmeCheck4', 'readmeQ10', 'readmeChoice', 'readmeConclusion', 'deadlockKernels'],
      cards: ['02-023', '02-025', '02-027', '02-029', '02-032', '02-033'],
    },
  };

  // 관계도 요소의 설명. 요소를 고르면 설명 칸에 나온다. 지금 상태는 board.js가 단계마다 만든다.
  const ELEMENTS = {
    thread: {
      kind: 'OS가 실행하는 단위',
      concept: '코드를 실행하는 OS 스레드다. 실험은 GIL을 켠 CPython이라 한 번에 한 스레드만 파이썬 코드를 실행한다. 이 화면도 한 단계에 스레드 하나만 실행한다.',
      props: [
        '락, 세마포어, 조건 변수, Event에서 기다리는 동안에는 블록되어 실행하지 않고 GIL도 요청하지 않는다.',
        '기다리던 것이 풀려도 바로 실행되지 않는다. 실행 차례(GIL 차례)를 기다린 뒤에 다음 줄을 이어 실행한다.',
        '잡지 않은 예외가 나면 그 스레드만 끝난다. 다른 스레드와 그 스레드가 쥔 락은 그대로 남는다.',
      ],
      ev: ['modelOrder', 'docWith'],
      cards: ['02-010'],
    },
    gil: {
      kind: 'Python 실행에 대한 제약',
      concept: '같은 인터프리터에서 파이썬 바이트코드를 실행하는 스레드를 한 번에 하나로 제한하는 락이다. 코드에서 거는 락과 다르다.',
      props: [
        '기다리는 스레드가 전환 간격(실험 환경 0.005초)만큼 기다리면 쥔 스레드에 놓기를 요청한다. 이 화면은 간격을 장면마다 정한 단계 수로 줄였다.',
        'sleep, 락 대기, Event.wait()처럼 블록되는 동안에는 GIL을 놓는다. 바쁜 대기(pass로 돌기)는 GIL을 쥐고 계속 실행한다.',
        '이체 장면에서는 GIL이 넘어가는 순간 스레드가 첫 락만 쥐고 있으면 교착 상태로 이어질 수 있다.',
      ],
      ev: ['readmeBatch3', 'readmeInterp', 'docSwitch'],
      cards: ['02-018', '02-028'],
    },
    lock: {
      kind: '상호 배제 락',
      concept: 'threading.Lock은 잠금과 잠금 해제 두 상태만 있다. 누가 잠갔는지 기억하지 않는다.',
      props: [
        '잠금 상태에서 acquire()를 부르면 오류 없이 기다린다. 이미 쥔 스레드가 다시 불러도 기다린다.',
        '잡지 않은 스레드도 release()를 부를 수 있다. 잠금 해제 상태에서 release()를 부르면 RuntimeError(release unlocked lock)가 난다.',
        '관계도의 파란 선은 마지막으로 잡은 스레드를 모형이 따로 적어 그린 것이다. Lock 자체에는 그 정보가 없다.',
        '이 모형은 놓을 때 첫 대기 스레드를 깨우고, 그 스레드가 {FAIR}단계 이상 기다렸으면 락을 바로 넘긴다. CPython 3.14.2가 1ms 넘게 기다린 스레드에 넘기는 규칙을 단계로 옮긴 것이다.',
      ],
      ev: ['docLock', 'srcLockRelease', 'srcFair', 'readmeBatch1'],
      cards: ['02-005', '02-006', '02-008'],
    },
    rlock: {
      kind: '재진입 락',
      concept: 'threading.RLock은 주인 스레드와 수준(잡은 횟수)을 기억한다. 주인은 이미 쥔 RLock을 다시 잡을 수 있고, 잡은 횟수만큼 풀어야 잠금이 풀린다.',
      props: [
        '주인이 아닌 스레드의 release()나 다 푼 뒤의 release()는 RuntimeError(cannot release un-acquired lock)를 낸다.',
        'Condition()을 락 없이 만들면 안에서 RLock을 하나 만든다. 버퍼 장면의 RLock이 그것이다.',
        '재진입은 같은 스레드가 같은 락을 다시 잡을 때만 해당한다. 다른 스레드 사이의 순환 대기는 막지 못한다.',
      ],
      ev: ['docRlock', 'srcRlockRelease', 'srcCondInit', 'readmeVariant2'],
      cards: ['02-007', '02-008', '02-030'],
    },
    sem: {
      kind: '개수를 세는 동기화',
      concept: 'threading.Semaphore는 카운터 하나다. acquire()는 카운터가 0이면 기다리고, 아니면 1 줄인다. release()는 1 늘리고 기다리던 스레드 하나를 깨운다.',
      props: [
        '누가 얻었는지 기억하지 않는다. 관계도의 파란 선은 얻고 아직 반납하지 않은 스레드를 모형이 따로 적어 그린 것이다.',
        'release()가 카운터를 초깃값보다 크게 만들어도 오류를 내지 않는다. 개수 세기와 신호로도 쓰기 때문이다.',
        '카운터와 얻은 스레드 수의 합이 초깃값보다 크면 남는 release()가 상한을 늘린 것이다. 이때 상자를 주황으로 그린다.',
        '깨운 스레드는 실행될 때 카운터를 줄인다. 그 전에 다른 스레드가 먼저 얻어 카운터가 0이 되면 다시 기다린다.',
      ],
      ev: ['docSemaphore', 'srcSemaphore', 'readmeBatch1', 'readmeCheck1'],
      cards: ['02-001', '02-002', '02-004', '02-009'],
    },
    bsem: {
      kind: '상한을 검사하는 세마포어',
      concept: 'threading.BoundedSemaphore는 release()가 카운터를 초깃값보다 크게 만들려 하면 ValueError를 낸다. 나머지는 Semaphore와 같다.',
      props: [
        '검사는 그 release() 한 번이 초깃값을 넘기는지만 본다. 다른 스레드가 얻고 있으면 남는 release()도 통과한다.',
        '그래서 상한을 지켜 주지 못하고, 짝이 어긋난 것을 늦게라도 드러낸다. 오류는 원인이 된 호출이 아니라 나중에 반납하는 다른 호출에서 난다.',
      ],
      ev: ['docSemaphore', 'srcBounded', 'readmeBatch1', 'readmeCheck1'],
      cards: ['02-003', '02-009'],
    },
    cond: {
      kind: '조건을 기다리는 자리',
      concept: 'threading.Condition은 락 하나와 대기 목록이다. wait()는 대기 목록 끝에 서고 락을 놓은 뒤 통지를 기다린다. 통지를 받으면 락을 다시 얻어야 돌아온다.',
      props: [
        'notify()는 대기 목록 맨 앞 하나를, notify_all()은 모두를 깨운다. 기다리는 스레드가 없으면 아무 일도 하지 않고, 통지는 쌓이지 않는다.',
        '누가 무엇을 기다리는지 가리지 않는다. 그래서 깨어난 뒤 조건(jobs가 비었는지)을 while로 다시 확인한다.',
        '락을 넘기지 않고 Condition()으로 만들면 안에서 RLock을 만든다. 조건 변수 둘이 같은 자료를 지키려면 같은 락을 넘겨 만든다.',
        'wait()와 notify()는 그 조건 변수의 락을 쥔 스레드만 부를 수 있다.',
      ],
      ev: ['docCondition', 'srcCondInit', 'srcCondWait', 'srcNotify', 'readmeCheck2', 'readmeVariant1'],
      cards: ['02-010', '02-011', '02-012', '02-014', '02-015'],
    },
    event: {
      kind: '한 번 올리는 신호',
      concept: 'threading.Event는 깃발 하나다. wait()는 깃발이 내려가 있으면 블록되고, set()은 깃발을 올리며 기다리던 스레드를 모두 깨운다.',
      props: [
        'CPython에서는 깃발과 조건 변수 하나(Condition(Lock()))로 만든다. set()은 notify_all()을 부른다. 이 화면은 그 안의 락과 조건 변수를 따로 그리지 않는다.',
        '블록된 동안 GIL을 요청하지 않으므로 CPU를 쓰지 않는다.',
        '깃발은 올라간 채로 남는다. set() 뒤에 wait()를 부르면 바로 돌아온다.',
      ],
      ev: ['docEvent', 'srcEvent', 'readmeBatch3'],
      cards: ['02-020', '02-021'],
    },
    flag: {
      kind: '공유 자료',
      concept: 'Ready의 flag는 그냥 bool 속성이다. 누군가 기다리고 있다는 것을 모르므로, 바꿔도 아무도 깨우지 않는다.',
      props: [
        '바쁜 대기(pass)와 sleep 확인은 이 값을 되풀이해 읽는다. 바뀐 것을 언제 알아채는지는 읽는 쪽이 다시 읽는 때에 달렸다.',
        'Ready.set()은 flag를 True로 바꾸고 event.set()도 부른다.',
      ],
      ev: ['waitKernels', 'readmeBatch3'],
      cards: ['02-018', '02-019'],
    },
    api: {
      kind: '상한을 지켜야 하는 외부 자원',
      concept: '실험의 가짜 API(FakeApi)다. 들어온 호출 수를 세고 잠시 기다린 뒤 돌려준다. 정해 둔 번째 호출은 TimeoutError로 끝난다.',
      props: [
        '동시 호출이 상한을 넘은 단계에는 상자를 주황으로 그린다.',
        'send_later()는 요청을 나중에 보낼 큐에 넣기만 한다.',
        '이 장면은 실험의 요청 40개, 작업자 8개, 상한 4를 요청 4개, 스레드 3개, 상한 2(락은 1)로 줄였다.',
      ],
      ev: ['releaseLab', 'readmeProblem1'],
      cards: ['02-002', '02-009'],
    },
    jobs: {
      kind: '공유 자료',
      concept: '작업을 담는 deque다. put()이 끝에 넣고 take()가 앞에서 꺼낸다. 비어 있을 때 popleft()를 부르면 IndexError가 난다.',
      props: [
        '조건 변수의 락을 쥔 동안에만 보고 바꾼다.',
        '통지는 쌓이지 않으므로, 바뀐 사실은 jobs에 남고 깨어난 쪽이 jobs를 다시 확인한다.',
      ],
      ev: ['bufferKernels', 'readmeBatch2'],
      cards: ['02-011', '02-012'],
    },
    account: {
      kind: '공유 자료와 그 락',
      concept: '계좌마다 잔액과 락 하나를 둔다. 이체는 두 계좌의 락을 모두 쥔 뒤에 잔액을 바꾼다.',
      props: [
        '두 락을 잡는 순서가 스레드마다 다르면 서로 상대가 쥔 락을 기다리는 고리가 생길 수 있다.',
        '락을 RLock으로 바꾸면 같은 스레드가 같은 계좌의 락을 다시 잡을 수 있다(자기 계좌 이체).',
      ],
      ev: ['deadlockKernels', 'readmeProblem4', 'readmeBatch4'],
      cards: ['02-023', '02-024', '02-025'],
    },
    fork: {
      kind: '상호 배제 락',
      concept: '포크 하나는 threading.Lock 하나다. 이웃한 두 철학자가 함께 쓴다.',
      props: [
        '철학자는 첫 포크를 쥔 채 둘째 포크를 기다린다(점유 대기). 남이 쥔 포크를 빼앗지 않는다(비선점).',
        '다섯 명이 모두 첫 포크를 쥐고 둘째 포크를 기다리면 기다림이 고리를 이룬다(순환 대기).',
      ],
      ev: ['deadlockKernels', 'readmeProblem5', 'readmePhil'],
      cards: ['02-023', '02-025', '02-029'],
    },
    waiter: {
      kind: '자리 수를 세는 세마포어',
      concept: '웨이터는 Semaphore(4)다. 한 번에 넷만 포크를 집으러 가게 한다.',
      props: [
        '넷이 각자 첫 포크를 쥐어도 포크가 하나 남으므로, 그 포크를 둘째로 쓰는 철학자는 먹을 수 있다. 순환 대기가 생기지 않는다.',
        '쥔 채 기다리는 점유 대기는 그대로 남는다.',
      ],
      ev: ['deadlockKernels', 'readmePhil', 'readmeCheck4'],
      cards: ['02-027'],
    },
  };

  // 요소를 그렸지만 이 구성에서 쓰지 않는 이유
  const UNUSED = {
    'event-unused': { text: '이 구성의 요청 처리 스레드는 ready.flag만 확인한다. Ready.set()은 event.set()도 부르지만 event.wait()로 기다리는 스레드가 없다.', ev: ['waitKernels'] },
  };

  const CARDS = {
    '02-001': '세마포어의 카운터는 무엇을 세고, acquire()와 release()는 카운터를 어떻게 바꾸는가?',
    '02-002': 'Semaphore(4)에서 타임아웃이 나면 release()가 두 번 불린다. 타임아웃이 세 번 나면 무엇이 달라지는가?',
    '02-003': '같은 이중 release() 코드에서 BoundedSemaphore(4)로 바꾸면 첫 타임아웃에서 바로 ValueError가 나는가?',
    '02-004': 'Semaphore는 왜 카운터가 초깃값을 넘게 만드는 release()를 오류로 보지 않는가?',
    '02-005': 'threading.Lock을 잡지 않은 다른 스레드가 release()를 부르면? 이미 잠금 해제된 Lock에 release()를 부르면?',
    '02-006': '상한 1인 Lock으로 이중 release() 코드를 돌리자 동시 호출이 4까지 늘고, 오류는 36~40번째의 다른 호출에서 났다. 왜 그런가?',
    '02-007': 'RLock은 무엇을 기억하고, 이중 release()에서 Lock과 어떻게 달랐는가?',
    '02-008': '한 스레드가 이미 쥔 threading.Lock을 다시 acquire()하면 어떻게 되는가? RLock이면?',
    '02-009': '상한이 있는 자원을 여러 스레드가 쓸 때, 상한을 실제로 지키는 것은 도구의 종류인가 코드의 모양인가?',
    '02-010': '조건 변수의 wait()는 무엇을 하고, 시간 제한 없이 불렀을 때 언제 돌아오는가?',
    '02-011': '기다리는 스레드가 없을 때 notify()를 부르면 어떻게 되는가? 세마포어의 release()와 무엇이 다른가?',
    '02-012': '조건 변수의 기다림을 if가 아니라 while로 쓰는 이유는?',
    '02-013': 'if로 기다리는 버퍼에서 작업자 4개는 notify()일 때 3·2·1개로 줄고, notify_all()일 때 첫 업로드에서 바로 1개가 됐다. 왜 다른가?',
    '02-014': '생산자와 소비자가 조건 변수 하나를 함께 쓰고 notify()로 깨운다. 버퍼 크기 1에서 생산자가 작업 둘을 연달아 넣으면 어떻게 될 수 있는가?',
    '02-015': '생산자·소비자 버퍼를 조건 변수로 직접 짤 때 어떤 모양으로 쓰는가? 실제로는 무엇을 먼저 고르는가?',
    '02-017': '운영체제에서 말하는 모니터는 무엇인가?',
    '02-018': '로더가 혼자 1초 걸리는 계산을 하는 동안 스레드 4개가 while not ready: pass로 기다리면 로딩은 대략 얼마가 되는가?',
    '02-019': '바쁜 대기를 time.sleep(0.01)로 확인하는 방식으로 바꾸면 로딩 시간과 깨어나는 시각은 어떻게 되는가?',
    '02-020': 'Event.wait()로 기다리는 스레드는 왜 CPU를 쓰지 않고, 로딩이 끝나자마자 깨어나는가?',
    '02-021': 'CPython의 threading.Event는 무엇으로 만들어져 있고, set()은 왜 notify_all()을 부르는가?',
    '02-022': '블록하는 락 대신 돌면서 기다리는 스핀락이 나은 경우는 언제인가? 문제 상황 3에서는 왜 손해였는가?',
    '02-023': '교착 상태가 생기는 네 조건은 무엇인가?',
    '02-024': '보내는 계좌부터 잠그는 이체를 두 스레드가 A→B, B→A로 동시에 돌렸다. 왜 멈추고, 멈춘 동안 CPU를 거의 쓰지 않는가?',
    '02-025': '락 순서 고정은 어떻게 교착 상태를 막는가? 이체에서는 무엇으로 순서를 정하는가?',
    '02-026': '둘째 락을 acquire(blocking=False)로 시도하고 실패하면 쥔 락을 놓고 무작위로 쉬었다 다시 하는 방법은 네 조건 중 무엇을 깨는가?',
    '02-027': '식사하는 철학자에서 한 번에 4명까지만 포크를 집으러 가게 하는 웨이터(Semaphore(4))는 네 조건 중 무엇을 깨는가?',
    '02-028': '락 안의 느린 I/O를 빼서 첫 락만 쥔 구간을 1µs 아래로 줄이면, 반대 순서로 잡는 이체를 20만 번 돌려도 거의 멈추지 않는가?',
    '02-029': '모두 왼쪽 포크부터 집는 코드는 10번 중 6번 멈췄고, 멈춘 6번은 모두 아무도 먹기 전이었다. 왜 그런가?',
    '02-030': '계좌 락이 Lock일 때 락 순서 고정과 내려놓고 다시로 자기 계좌에 이체하면 각각 어떻게 되는가?',
    '02-031': '교착 상태를 다루는 네 가지 방식은 무엇인가?',
    '02-032': '임계 영역 문제를 풀었다고 하려면 진입 구역과 퇴출 구역이 만족해야 하는 세 조건은 무엇인가?',
    '02-033': '이중 release(), 서로 기다리는 이체, 매번 밀리는 내려놓고 다시는 임계 영역 문제의 세 조건 중 각각 무엇을 깨는가?',
  };

  root.SyncContent = { EV, TYPE_LABEL, CODE, SCENES, ELEMENTS, UNUSED, CARDS };
})(typeof self !== 'undefined' ? self : this);
