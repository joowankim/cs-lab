/*
 * 동기화 관계도의 설명용 실행 모형.
 *
 * 한 단계에는 스레드 하나만 실행한다(실험은 GIL을 켠 CPython 3.14.2였다). 단계는 이벤트의 순서이고 시간 길이가 아니다.
 * 락, 세마포어, 조건 변수, Event의 규칙은 CPython 3.14.2의 Lib/threading.py와 Python/lock.c를 단순화했다.
 * 스레드가 실행하는 코드는 실험 코드를 생성기로 옮겼다. yield 한 번이 그 스레드가 실행한 단계 하나의 끝이고,
 * yield로 내는 값은 그 스레드가 다음에 실행할(또는 기다리는) 줄의 이름이다.
 * 브라우저에서는 window.SyncModel, Node.js에서는 require()로 쓴다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2026-10-26.1';

  // 락을 놓을 때 첫 대기 스레드가 이 단계 수 이상 기다렸으면 락을 그 스레드에 바로 넘긴다. 아니면 깨우기만 하므로
  // 깨운 스레드가 실행되기 전에 다른 스레드가 락을 잡을 수 있다. CPython 3.14.2의 PyMutex가 1ms 넘게 기다린 스레드에
  // 넘기는 규칙(lock.c의 TIME_TO_BE_FAIR_NS)을 단계로 옮겼다. 2단계는 1ms를 뜻하지 않는다.
  const FAIR = 2;
  const MAX_STEPS = 400;
  // 설명용 길이(단계 수). 실제 시간과 비례하지 않는다.
  const UNITS = {
    api: 4, // 가짜 API 호출 하나
    thumb: 2, // 썸네일 작업 하나(sleep(job_s))
    load: 4, // build_index() 계산
    poll: 10, // wait_sleep()의 time.sleep(POLL_S)
    db: 2, // check_limit_db()의 time.sleep(DB_S)
    backoff: [1, 2], // 내려놓고 다시의 무작위 쉬기. 스레드마다 다르게 고정했다.
    pick: 2, // 철학자가 첫 포크를 집고 쉬는 시간(PICK_S)
    eat: 2, // 먹는 시간(EAT_S)
    think: { same: [1, 1, 1, 1, 1], spread: [1, 5, 2, 6, 3] }, // 생각하는 시간(철학자 0~4)
  };
  // GIL 전환 간격: 실행 중인 스레드가 이 단계 수만큼 이어서 실행하면 다음 단계에 기다리던 스레드에 GIL을 넘긴다. 0이면 넘기지 않는다.
  // CPython의 sys.getswitchinterval()(0.005초)을 시간으로 재현한 값이 아니다.
  const SWITCH = { release: 0, buffer: 0, onecond: 0, wait: 1, transfer: 7, phil: 0 };

  const SCENARIOS = {
    release: { label: '이중 release()', gil: false },
    buffer: { label: '조건 변수 버퍼', gil: false },
    onecond: { label: '버퍼 크기 1', gil: false },
    wait: { label: '기다리는 방법', gil: true },
    transfer: { label: '이체', gil: true },
    phil: { label: '식사하는 철학자', gil: false },
  };

  // 장면마다 바꿀 수 있는 구성. 배열은 고를 수 있는 값, [최소, 최대]는 범위다.
  const CHOICES = {
    release: { tool: ['semaphore', 'bounded', 'lock', 'rlock'], code: ['buggy', 'fixed'] },
    buffer: { take: ['if', 'while'], wake: ['notify', 'notify_all'] },
    onecond: { fix: ['one', 'all', 'two'] },
    wait: { how: ['pass', 'sleep', 'event'] },
    transfer: { how: ['opposite', 'ordered', 'retry'], accounts: ['pair', 'self'], lock: ['lock', 'rlock'], check: ['db', 'memory'] },
    phil: { pick: ['left', 'larger', 'waiter'], think: ['same', 'spread'] },
  };
  const RANGES = {
    buffer: { workers: [2, 4] },
    wait: { waiters: [1, 4] },
    transfer: { per: [1, 3] },
    phil: { meals: [1, 2] },
  };
  const DEFAULTS = {
    release: { tool: 'semaphore', code: 'buggy' },
    buffer: { take: 'if', wake: 'notify', workers: 4 },
    onecond: { fix: 'one' },
    wait: { how: 'pass', waiters: 4 },
    transfer: { how: 'opposite', accounts: 'pair', lock: 'lock', check: 'db', per: 1 },
    phil: { pick: 'left', think: 'same', meals: 1 },
  };

  function normalizeConfig(scene, input) {
    const out = Object.assign({}, DEFAULTS[scene]);
    const src = input || {};
    for (const [k, list] of Object.entries(CHOICES[scene] || {})) if (list.includes(src[k])) out[k] = src[k];
    for (const [k, [lo, hi]] of Object.entries(RANGES[scene] || {})) {
      const n = Number(src[k]);
      if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, Math.round(n)));
    }
    return out;
  }

  // 받침 유무로 조사를 고른다. 영어 낱말은 읽는 소리로 받침을 정한다(Lock은 락, Event는 이벤트).
  function josa(word, pair) {
    const w = String(word).trim().replace(/[)\]]+$/, '');
    const ch = w.slice(-1);
    const code = ch.charCodeAt(0);
    let batchim;
    if (code >= 0xac00 && code <= 0xd7a3) batchim = (code - 0xac00) % 28 !== 0;
    else if (/[0-9]/.test(ch)) batchim = '013678'.includes(ch);
    else if (/lock$/i.test(w)) batchim = true;
    else batchim = /[lmn]$/i.test(w) || /ng$/i.test(w);
    return word + (batchim ? pair[0] : pair[1]);
  }
  const I = (w) => josa(w, ['이', '가']);
  const N = (w) => josa(w, ['은', '는']);
  const R = (w) => josa(w, ['을', '를']);
  const E = (w) => josa(w, ['과', '와']);

  // 파이썬 예외. 스레드 코드가 잡지 않으면 그 스레드가 끝난다.
  function PyErr(type, msg) { this.type = type; this.msg = msg; }

  // ---------- 실행 틀 ----------

  function makeSim(scene, opts) {
    const o = opts || {};
    return {
      scene, step: 0, gilOn: !!SCENARIOS[scene].gil, switchAfter: SWITCH[scene] || 0,
      threads: [], byId: {}, q: [], cur: null, ran: 0, objs: {}, timers: [], ev: [],
      done: false, outcome: null, stopReason: null,
      finishedWhen: o.finishedWhen || null, localOf: o.localOf || null, startText: o.startText || '',
      result: null, hook: null,
    };
  }

  function emit(S, type, text, ids, extra) { S.ev.push(Object.assign({ type, text, ids: ids || [] }, extra || {})); }
  function mark(S, t, key) { if (t.lines[t.lines.length - 1] !== key) t.lines.push(key); }

  function addThread(S, id, name, make, extra) {
    const t = Object.assign({ id, name, st: 'new', why: '', waitOn: null, waitSince: null, due: null, until: null,
      at: null, lines: [], err: null, errNow: null, gen: null }, extra || {});
    S.threads.push(t);
    S.byId[id] = t;
    S.q.push(id);
    t.gen = make(t);
    return t;
  }

  function addObj(S, o) { S.objs[o.id] = o; return o; }

  function block(S, t, why, on) {
    t.st = 'block';
    t.why = why;
    t.waitOn = on || null;
    t.waitSince = S.step;
  }

  function makeReady(S, t) {
    t.st = 'ready';
    t.why = '';
    t.waitOn = null;
    t.until = null;
    if (!S.q.includes(t.id) && S.cur !== t.id) S.q.push(t.id);
  }

  function unready(S, t) { S.q = S.q.filter((id) => id !== t.id); }

  // 막혔다가 깨어난 단계면 같은 단계에 다음 줄을 이어 실행하고, 막히지 않았으면 이 단계를 끝낸다.
  function* cont(waited, key) { if (!waited) yield key; }

  // 시간을 재는 대기(sleep, API 호출, DB 확인). n단계 뒤 그 단계가 끝날 때 깨어나고, 다음에 실행되는 단계에 다음 줄을 이어 실행한다.
  function* sleep(S, t, n, key, why, text) {
    mark(S, t, key);
    block(S, t, why || 'sleep 대기', null);
    t.due = S.step + n;
    S.timers.push({ id: t.id, due: t.due });
    if (text) emit(S, 'sleep', text, [t.id]);
    yield key;
    mark(S, t, key);
    return true;
  }

  // 조건이 맞을 때까지 기다린다. 실험의 settle()처럼 짧게 자며 확인하는 것을 단계 끝마다 확인하는 것으로 줄였다.
  function* waitUntil(S, t, pred, key, why, text) {
    mark(S, t, key);
    if (pred()) return false;
    block(S, t, why || 'sleep 대기', null);
    t.until = pred;
    if (text) emit(S, 'settle-wait', text, [t.id]);
    yield key;
    mark(S, t, key);
    return true;
  }

  // ---------- 락(Lock, RLock) ----------
  // locked는 잠금 여부, holder는 마지막으로 잡은 스레드다. RLock은 holder를 주인으로 기억하고 수준(level)을 센다.
  // Lock은 주인을 기억하지 않는다. holder는 관계도에 누가 잡았는지 보이려고 모형이 따로 적는 값이다.

  function makeLock(S, id, name, kind) {
    return addObj(S, { id, name, type: kind === 'rlock' ? 'rlock' : 'lock', locked: false, holder: null, level: 0, waiters: [], woken: null });
  }

  function grab(S, t, L) {
    L.locked = true;
    L.holder = t.id;
    L.level = 1;
    if (L.woken && L.woken !== t.id) {
      // 깨웠지만 아직 실행하지 못한 스레드는 락을 놓쳤으므로 대기 줄 끝으로 돌아간다. 기다리기 시작한 단계는 그대로 둔다.
      const w = S.byId[L.woken];
      unready(S, w);
      w.st = 'block';
      w.why = 'Lock 대기';
      w.waitOn = L.id;
      L.waiters.push(w.id);
      emit(S, 'barge', `${I(t.name)} 먼저 ${R(L.name)} 잡아, 깨어 있던 ${N(w.name)} 다시 기다린다`, [t.id, w.id, L.id]);
    }
    L.woken = null;
  }

  // 락을 놓은 뒤 기다리던 첫 스레드를 깨운다. FAIR 단계 이상 기다렸으면 락을 넘기고, 아니면 깨우기만 한다.
  function wakeLockWaiter(S, L) {
    if (!L.waiters.length) return;
    const w = S.byId[L.waiters.shift()];
    if (S.step - w.waitSince >= FAIR) {
      L.locked = true;
      L.holder = w.id;
      L.level = 1;
      makeReady(S, w);
      emit(S, 'handoff', `${R(L.name)} 오래 기다린 ${w.name}에게 바로 넘긴다`, [w.id, L.id]);
    } else {
      L.woken = w.id;
      makeReady(S, w);
      emit(S, 'lock-wake', `${R(L.name)} 기다리던 ${R(w.name)} 깨운다(락은 넘기지 않는다)`, [w.id, L.id]);
    }
  }

  // with lock:이나 lock.acquire(). 막혔다가 깨어나 이어서 실행하면 true를 돌려준다.
  function* acquire(S, t, L, key) {
    mark(S, t, key);
    if (L.type === 'rlock' && L.locked && L.holder === t.id) {
      L.level += 1;
      emit(S, 'reenter', `${t.name}: 이미 쥔 ${R(L.name)} 다시 잡는다(수준 ${L.level})`, [t.id, L.id]);
      return false;
    }
    if (!L.locked) {
      emit(S, 'lock-take', `${t.name}: ${R(L.name)} 잡는다`, [t.id, L.id]);
      grab(S, t, L);
      return false;
    }
    L.waiters.push(t.id);
    block(S, t, 'Lock 대기', L.id);
    const self = L.holder === t.id;
    emit(S, self ? 'self-wait' : 'lock-wait', self ? `${t.name}: 자기가 잡은 ${R(L.name)} 다시 잡으려고 기다린다. Lock은 같은 스레드도 기다리게 한다`
      : `${t.name}: ${I(L.name)} 잠겨 있어 기다린다`, [t.id, L.id], self ? { bad: true } : null);
    yield key;
    mark(S, t, key);
    if (!(L.locked && L.holder === t.id)) grab(S, t, L);
    emit(S, 'lock-got', `${t.name}: ${R(L.name)} 얻고 이어서 실행한다`, [t.id, L.id]);
    return true;
  }

  // lock.acquire(blocking=False). 잡지 못하면 기다리지 않고 False를 돌려준다.
  function tryAcquire(S, t, L, key) {
    mark(S, t, key);
    if (L.type === 'rlock' && L.locked && L.holder === t.id) {
      L.level += 1;
      emit(S, 'reenter', `${t.name}: 이미 쥔 ${R(L.name)} 다시 잡는다(수준 ${L.level})`, [t.id, L.id]);
      return true;
    }
    if (!L.locked) {
      emit(S, 'lock-take', `${t.name}: ${R(L.name)} 바로 잡는다`, [t.id, L.id]);
      grab(S, t, L);
      return true;
    }
    emit(S, 'try-fail', `${t.name}: ${I(L.name)} 잠겨 있어 acquire(blocking=False)가 False를 돌려준다`, [t.id, L.id]);
    return false;
  }

  function release(S, t, L, key) {
    mark(S, t, key);
    if (L.type === 'rlock') {
      if (!L.locked || L.holder !== t.id) throw new PyErr('RuntimeError', 'cannot release un-acquired lock');
      L.level -= 1;
      if (L.level > 0) {
        emit(S, 'lock-release', `${t.name}: ${R(L.name)} 한 번 놓는다(수준 ${L.level})`, [t.id, L.id]);
        return;
      }
    } else if (!L.locked) {
      throw new PyErr('RuntimeError', 'release unlocked lock');
    }
    const prev = L.holder;
    L.locked = false;
    L.holder = null;
    L.level = 0;
    if (prev && prev !== t.id) {
      emit(S, 'foreign', `${I(t.name)} ${I(S.byId[prev].name)} 잡은 ${R(L.name)} 풀었다. Lock은 누가 잡았는지 기억하지 않는다`, [t.id, prev, L.id], { bad: true });
    } else {
      emit(S, 'lock-release', `${t.name}: ${R(L.name)} 놓는다`, [t.id, L.id]);
    }
    wakeLockWaiter(S, L);
  }

  // ---------- 세마포어(Semaphore, BoundedSemaphore) ----------
  // CPython 3.14.2처럼 release()는 카운터를 1 늘리고 기다리던 첫 스레드를 깨운다. 깨운 스레드는 실행될 때 카운터를 줄인다.
  // 그 전에 다른 스레드가 카운터를 0으로 만들면 깨운 스레드는 다시 기다린다(대기 목록 끝으로).
  // holders는 얻고 아직 반납하지 않은 스레드다. 세마포어는 누가 얻었는지 기억하지 않으며, 모형이 관계도를 그리려고 적는다.

  function makeSem(S, id, name, value, bounded) {
    return addObj(S, { id, name, type: 'sem', value, init: value, bounded: !!bounded, waiters: [], woken: [], holders: [] });
  }

  function* semAcquire(S, t, M, key) {
    mark(S, t, key);
    let waited = false;
    if (M.value === 0) {
      M.waiters.push(t.id);
      block(S, t, 'Semaphore 대기', M.id);
      emit(S, 'sem-wait', `${t.name}: ${M.name}의 카운터가 0이라 기다린다`, [t.id, M.id]);
      yield key;
      mark(S, t, key);
      M.woken = M.woken.filter((id) => id !== t.id);
      waited = true;
    }
    M.value -= 1;
    M.holders.push(t.id);
    emit(S, 'sem-acquire', `${t.name}: ${M.name}의 카운터를 1 줄이고 들어간다(카운터 ${M.value})`, [t.id, M.id]);
    if (M.value === 0 && M.woken.length) {
      for (const id of M.woken) {
        const w = S.byId[id];
        unready(S, w);
        w.st = 'block';
        w.why = 'Semaphore 대기';
        w.waitOn = M.id;
        M.waiters.push(id);
        emit(S, 'barge', `${I(t.name)} 먼저 들어가 카운터가 0이 되어, 깨어 있던 ${N(w.name)} 다시 기다린다`, [t.id, w.id, M.id]);
      }
      M.woken = [];
    }
    return waited;
  }

  function semRelease(S, t, M, key) {
    mark(S, t, key);
    if (M.bounded && M.value + 1 > M.init) throw new PyErr('ValueError', 'Semaphore released too many times');
    M.value += 1;
    const i = M.holders.indexOf(t.id);
    if (i >= 0) {
      M.holders.splice(i, 1);
      emit(S, 'sem-release', `${t.name}: ${M.name}에 반납해 카운터가 ${I(M.value)} 된다`, [t.id, M.id]);
    } else {
      emit(S, 'extra', `${t.name}: 이미 반납한 자리를 한 번 더 반납해 카운터가 ${I(M.value)} 된다. 세마포어는 오류를 내지 않는다`, [t.id, M.id], { bad: true });
    }
    if (M.waiters.length) {
      const w = S.byId[M.waiters.shift()];
      M.woken.push(w.id);
      makeReady(S, w);
      emit(S, 'sem-wake', `${M.name}: 기다리던 ${R(w.name)} 깨운다`, [w.id, M.id]);
    }
  }

  // ---------- 조건 변수(Condition)와 Event ----------

  function makeCond(S, id, name, lock) {
    return addObj(S, { id, name, type: 'cond', lock: lock.id, waiters: [] });
  }

  function owns(S, t, L) { return L.locked && (L.type === 'lock' || L.holder === t.id); }

  // cond.wait(): 대기 목록 끝에 들어가고 연관된 락을 놓은 뒤 통지를 기다린다. 통지를 받으면 락을 다시 기다리고,
  // 락을 얻어 실행되는 단계에 wait()에서 돌아와 다음 줄을 이어 실행한다.
  function* condWait(S, t, C, key) {
    mark(S, t, key);
    const L = S.objs[C.lock];
    if (!owns(S, t, L)) throw new PyErr('RuntimeError', 'cannot wait on un-acquired lock');
    C.waiters.push(t.id);
    const saved = L.level;
    L.locked = false;
    L.holder = null;
    L.level = 0;
    block(S, t, '통지 대기', C.id);
    emit(S, 'cond-wait', `${t.name}: wait()로 ${C.name}의 대기 목록에 들어가고 락을 놓는다`, [t.id, C.id]);
    wakeLockWaiter(S, L);
    yield key;
    mark(S, t, key);
    if (!(L.locked && L.holder === t.id)) grab(S, t, L);
    L.level = saved;
    emit(S, 'cond-back', `${t.name}: 락을 다시 얻어 wait()에서 돌아온다`, [t.id, C.id]);
    return true;
  }

  function moveToLock(S, C, ids) {
    const L = S.objs[C.lock];
    for (const id of ids) {
      const w = S.byId[id];
      w.st = 'block';
      w.why = 'Lock 대기';
      w.waitOn = L.id;
      w.waitSince = S.step;
      L.waiters.push(id);
    }
  }

  function notify(S, t, C, key) {
    mark(S, t, key);
    if (!owns(S, t, S.objs[C.lock])) throw new PyErr('RuntimeError', 'cannot notify on un-acquired lock');
    if (!C.waiters.length) {
      emit(S, 'notify-none', `${t.name}: ${C.name}.notify(), 기다리는 스레드가 없어 아무 일도 하지 않는다`, [t.id, C.id]);
      return;
    }
    const id = C.waiters.shift();
    moveToLock(S, C, [id]);
    emit(S, 'notify', `${t.name}: ${C.name}.notify(), 대기 목록 맨 앞의 ${R(S.byId[id].name)} 깨운다. 깨어난 스레드는 락을 기다린다`, [t.id, id, C.id]);
  }

  function notifyAll(S, t, C, key) {
    mark(S, t, key);
    if (!owns(S, t, S.objs[C.lock])) throw new PyErr('RuntimeError', 'cannot notify on un-acquired lock');
    const ids = C.waiters.splice(0);
    if (!ids.length) {
      emit(S, 'notify-none', `${t.name}: ${C.name}.notify_all(), 기다리는 스레드가 없어 아무 일도 하지 않는다`, [t.id, C.id]);
      return;
    }
    moveToLock(S, C, ids);
    emit(S, 'notify', `${t.name}: ${C.name}.notify_all(), 기다리던 ${R(ids.map((id) => S.byId[id].name).join('·'))} 모두 깨운다. 모두 락을 기다린다`, [t.id, ...ids, C.id]);
  }

  // Event는 깃발과 조건 변수로 만들어진다(threading.py). 이 모형은 Event 안의 락과 조건 변수를 따로 다루지 않고,
  // set()이 깃발을 올리며 기다리던 스레드를 모두 깨우는 것만 둔다.
  function makeEvent(S, id, name) { return addObj(S, { id, name, type: 'event', flag: false, waiters: [] }); }

  function* eventWait(S, t, ev, key) {
    mark(S, t, key);
    if (ev.flag) return false;
    ev.waiters.push(t.id);
    block(S, t, 'Event 대기', ev.id);
    emit(S, 'event-wait', `${t.name}: 깃발이 False라 ${ev.name}.wait()에서 블록된다`, [t.id, ev.id]);
    yield key;
    mark(S, t, key);
    return true;
  }

  function eventSet(S, t, ev, key) {
    mark(S, t, key);
    ev.flag = true;
    const ids = ev.waiters.splice(0);
    for (const id of ids) makeReady(S, S.byId[id]);
    emit(S, 'event-set', ids.length ? `${t.name}: set()으로 깃발을 True로 바꾸고 기다리던 ${ids.length}개를 모두 깨운다` : `${t.name}: set()으로 깃발을 True로 바꾼다`, [t.id, ev.id, ...ids]);
  }

  // ---------- 단계 진행 ----------

  function runActor(S, t) {
    t.lines = [];
    t.st = 'run';
    let r;
    try {
      r = t.gen.next();
    } catch (e) {
      if (!(e instanceof PyErr)) throw e;
      t.err = e;
      t.errNow = e;
      emit(S, 'thread-error', `${t.name}: ${e.type}: ${e.msg}. 잡지 않은 예외라 이 스레드가 끝난다`, [t.id], { bad: true });
      r = { done: true };
    }
    if (r.done) {
      t.st = 'done';
      t.why = '';
      t.waitOn = null;
      if (!t.err) emit(S, 'done', `${t.name}: 끝난다`, [t.id]);
    } else {
      t.at = r.value;
      if (t.st === 'run') t.st = 'ready';
    }
  }

  function expireTimers(S) {
    const due = S.timers.filter((x) => x.due <= S.step);
    if (!due.length) return;
    S.timers = S.timers.filter((x) => x.due > S.step);
    for (const x of due) {
      const t = S.byId[x.id];
      const why = t.why;
      t.due = null;
      makeReady(S, t);
      emit(S, 'timer', `${t.name}: ${why === 'API 대기' ? 'API 호출이' : why === 'sleep 대기' ? 'sleep이' : '기다림이'} 끝나 실행 차례를 기다린다`, [t.id]);
    }
  }

  function checkUntil(S) {
    for (const t of S.threads) {
      if (t.st === 'block' && t.until && t.until()) {
        makeReady(S, t);
        emit(S, 'until', `${t.name}: 기다리던 조건이 맞아 실행 차례를 기다린다`, [t.id]);
      }
    }
  }

  // 기다림 관계: 락을 기다리는 스레드에서 그 락을 잡은 스레드로. 이 관계가 돌아오면 교착 상태다.
  function waitEdge(S, t) {
    if (t.st !== 'block' || !t.waitOn) return null;
    const o = S.objs[t.waitOn];
    if (!o || (o.type !== 'lock' && o.type !== 'rlock') || !o.locked || !o.holder) return null;
    return { from: t.id, lock: o.id, to: o.holder };
  }

  function findCycle(S) {
    for (const start of S.threads) {
      const path = [];
      const seen = new Set();
      let t = start;
      while (t) {
        if (seen.has(t.id)) {
          const i = path.findIndex((e) => e.from === t.id);
          return i >= 0 ? path.slice(i) : null;
        }
        seen.add(t.id);
        const e = waitEdge(S, t);
        if (!e) break;
        path.push(e);
        t = S.byId[e.to];
      }
    }
    return null;
  }

  // 멈춘 까닭. 기다림이 고리를 이루면 교착 상태, 자기가 쥔 락을 기다리면 혼자 멈춘 것, 고리가 없으면 깨워 줄 스레드가 없는 것이다.
  function stuckText(S, cyc, names) {
    if (!cyc) return `멈춤: ${names} 모두 기다리기만 하고, 깨워 줄 스레드가 없다`;
    if (cyc.length === 1) {
      const e = cyc[0];
      return `멈춤: ${I(S.byId[e.from].name)} 자기가 쥔 ${R(S.objs[e.lock].name)} 다시 기다린다. 풀어 줄 스레드가 자기 자신뿐이라 영원히 기다린다`;
    }
    const parts = cyc.map((e) => `${N(S.byId[e.from].name)} ${I(S.byId[e.to].name)} 쥔 ${R(S.objs[e.lock].name)}`);
    return `교착 상태: ${parts.join(', ')} 기다린다. 기다림이 고리가 되어 아무도 진행하지 못한다`;
  }

  function stepOnce(S) {
    S.step += 1;
    S.ev = [];
    for (const t of S.threads) t.errNow = null;
    let actor = null;
    const cur = S.cur ? S.byId[S.cur] : null;
    if (cur && cur.st === 'ready') {
      if (S.switchAfter > 0 && S.ran >= S.switchAfter && S.q.length) {
        S.q.push(cur.id);
        actor = S.byId[S.q.shift()];
        S.ran = 0;
        emit(S, 'gil-switch', `${I(cur.name)} 전환 간격(${S.switchAfter}단계)만큼 실행해 GIL을 놓고, ${I(actor.name)} GIL을 얻는다`, [cur.id, actor.id, 'gil']);
      } else {
        actor = cur;
      }
    } else if (S.q.length) {
      actor = S.byId[S.q.shift()];
      S.ran = 0;
      if (S.gilOn) emit(S, 'gil-take', `${I(actor.name)} GIL을 얻어 실행한다`, [actor.id, 'gil']);
    }
    S.cur = actor ? actor.id : null;
    if (actor) {
      S.ran += 1;
      runActor(S, actor);
      if (actor.st !== 'ready') S.cur = null;
    } else {
      emit(S, 'idle', '이 단계에는 실행할 수 있는 스레드가 없다. 모두 기다리는 중이다', []);
    }
    expireTimers(S);
    checkUntil(S);
    if (S.hook) S.hook(S, actor);
    const alive = S.threads.filter((t) => t.st !== 'done');
    if (S.finishedWhen ? S.finishedWhen() : alive.length === 0) {
      S.done = true;
      S.outcome = 'finished';
      emit(S, 'end', '끝까지 갔다', []);
    } else if (S.stopReason) {
      S.done = true;
      S.outcome = S.stopReason;
    } else if (!S.cur && !S.q.length && !S.timers.length) {
      S.done = true;
      const cyc = findCycle(S);
      S.outcome = cyc ? 'deadlock' : 'hang';
      const names = alive.map((t) => t.name).join('·');
      emit(S, 'stuck', stuckText(S, cyc, names), alive.map((t) => t.id), { bad: true });
    }
    return snapshot(S, actor);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // 스레드 모양: 이 단계에 실행했으면 채운 원이다. 실행하지 않은 스레드는 단계가 끝난 뒤의 상태로 나눈다(락 선, 값 상자와 같은 시점).
  // 실행한 스레드의 단계 끝 상태는 after에 따로 둔다.
  function dispState(S, t, actor) {
    if (t === actor) return { cls: 'run', why: '' };
    switch (t.st) {
      case 'new': return { cls: 'turn', why: '시작 전' };
      case 'ready': return { cls: 'turn', why: S.gilOn ? 'GIL 차례' : '실행 차례' };
      case 'block': return { cls: 'event', why: t.why };
      default: return { cls: 'done', why: t.err ? t.err.type : '끝' };
    }
  }

  function snapshot(S, actor) {
    const v = { step: S.step, actor: actor ? actor.id : null, ev: S.ev, th: {}, obj: {}, gil: null, cycle: findCycle(S) };
    for (const t of S.threads) {
      const d = dispState(S, t, actor);
      v.th[t.id] = {
        cls: d.cls, why: d.why, after: t === actor ? dispState(S, t, null) : null, at: t.at, lines: t === actor ? t.lines.slice() : [],
        local: S.localOf ? S.localOf(t) : '', err: t.errNow ? t.errNow.type : null, dead: t.err ? t.err.type : null,
        waitOn: t.st === 'block' ? t.waitOn : null, due: t.st === 'block' ? t.due : null,
      };
    }
    for (const [id, o] of Object.entries(S.objs)) v.obj[id] = clone(o);
    if (S.gilOn) v.gil = { during: actor ? actor.id : null, after: actor && actor.st === 'ready' ? actor.id : null };
    return v;
  }

  // 시작 전에 미리 대기에 들어가 있는 스레드(버퍼 크기 1의 t1·t2, 버퍼의 업로드 스레드)는 단계 0 전에 그 대기까지 실행해 둔다.
  function prerun(S, ids) {
    for (const id of ids) {
      const t = S.byId[id];
      unready(S, t);
      runActor(S, t);
      t.lines = [];
      if (t.st === 'ready') S.q.push(t.id);
    }
    S.ev = [];
  }

  // ---------- 장면 1: 이중 release() ----------
  // 실험의 release_lab.py처럼 작업자 스레드가 요청 번호를 하나씩 맡아 call_api()를 부르고, 요청 하나의 예외는 잡아 기록한 뒤
  // 다음 요청으로 넘어간다(handle()). 실험은 요청 40개·작업자 8개·상한 4였고, 여기서는 요청 4개·작업자 3개·상한 2(락은 1)로 줄였다.

  function buildRelease(cfg) {
    const S = makeSim('release', { startText: '시작 전: 스레드 A·B·C가 요청 1~4를 하나씩 맡는다. 가짜 API의 1번째 호출은 타임아웃(TimeoutError)으로 끝난다.' });
    const sem = cfg.tool === 'semaphore' || cfg.tool === 'bounded';
    const limit = sem ? 2 : 1;
    const slots = sem
      ? makeSem(S, 'slots', cfg.tool === 'bounded' ? 'BoundedSemaphore(2)' : 'Semaphore(2)', 2, cfg.tool === 'bounded')
      : makeLock(S, 'slots', cfg.tool === 'rlock' ? 'RLock' : 'Lock', cfg.tool);
    const api = addObj(S, { id: 'api', type: 'api', name: '가짜 API', limit, inflight: [], max: 0, calls: 0, timeout: [1], queued: [] });
    const total = 4;
    let nextReq = 1;
    const errors = [];
    const slotAcquire = (t) => (sem ? semAcquire(S, t, slots, 'acq') : acquire(S, t, slots, 'acq'));
    const slotRelease = (t, key) => (sem ? semRelease(S, t, slots, key) : release(S, t, slots, key));

    // FakeApi.send(): 들어온 호출 수를 세고 API_STEPS 동안 기다린 뒤 나간다. 정해 둔 번째 호출은 TimeoutError를 낸다.
    function* send(t, req) {
      api.calls += 1;
      const no = api.calls;
      t.call = no;
      api.inflight.push(t.id);
      api.max = Math.max(api.max, api.inflight.length);
      if (api.inflight.length > limit) {
        emit(S, 'over', `${t.name}: ${R(`요청 ${req}`)} 보내 동시 호출이 ${api.inflight.length}개가 됐다. 상한 ${limit}개를 넘었다`, [t.id, 'api'], { bad: true });
      } else {
        emit(S, 'api-enter', `${t.name}: ${R(`요청 ${req}`)} API에 보낸다(${no}번째 호출, 동시 호출 ${api.inflight.length}개)`, [t.id, 'api']);
      }
      yield* sleep(S, t, UNITS.api, 'send', 'API 대기');
      api.inflight.splice(api.inflight.indexOf(t.id), 1);
      if (api.timeout.includes(no)) {
        emit(S, 'timeout', `${t.name}: ${no}번째 호출이 TimeoutError로 끝난다`, [t.id, 'api']);
        throw new PyErr('TimeoutError', `가짜 API 타임아웃: ${no}번째 호출`);
      }
      return 'ok';
    }

    // call_api_buggy(): TimeoutError가 나면 except와 finally에서 release()가 두 번 불린다.
    function* buggy(t, req) {
      yield* cont(yield* slotAcquire(t), 'send');
      try {
        return yield* send(t, req);
      } catch (e) {
        if (!(e instanceof PyErr) || e.type !== 'TimeoutError') throw e;
        mark(S, t, 'except');
        slotRelease(t, 'relExcept');
        yield 'later';
        mark(S, t, 'later');
        api.queued.push(req);
        emit(S, 'later', `${t.name}: ${R(`요청 ${req}`)} 나중에 보낼 큐에 넣는다`, [t.id, 'api']);
        yield 'fin';
        return 'queued';
      } finally {
        slotRelease(t, 'fin');
      }
    }

    // call_api_candidate(): with 문이 acquire()와 release()를 한 번씩 짝지어 부른다.
    function* fixed(t, req) {
      yield* cont(yield* slotAcquire(t), 'send');
      try {
        try {
          return yield* send(t, req);
        } catch (e) {
          if (!(e instanceof PyErr) || e.type !== 'TimeoutError') throw e;
          mark(S, t, 'except');
          mark(S, t, 'later');
          api.queued.push(req);
          emit(S, 'later', `${t.name}: ${R(`요청 ${req}`)} 나중에 보낼 큐에 넣는다`, [t.id, 'api']);
          yield 'exit';
          return 'queued';
        }
      } finally {
        slotRelease(t, 'exit');
      }
    }

    // handle(): 요청 하나의 예외는 잡아 기록하고 다음 요청으로 간다.
    function* worker(t) {
      while (nextReq <= total) {
        const req = nextReq;
        nextReq += 1;
        t.req = req;
        mark(S, t, 'h.call');
        try {
          yield* (cfg.code === 'buggy' ? buggy(t, req) : fixed(t, req));
        } catch (e) {
          if (!(e instanceof PyErr)) throw e;
          mark(S, t, 'h.except');
          t.errNow = e;
          errors.push({ thread: t.id, req, call: t.call, type: e.type, msg: e.msg, step: S.step, timeout: api.timeout.includes(t.call) });
          emit(S, 'error', `${t.name}: 요청 ${req}의 release()가 ${e.type}(${e.msg})를 낸다. 이 요청만 오류로 끝난다${nextReq <= total ? '. 스레드는 다음 요청으로 간다' : ''}`,
            [t.id, slots.id], { bad: true });
        }
        t.req = null;
        if (nextReq <= total) yield 'h.call';
      }
    }

    for (const name of ['A', 'B', 'C']) addThread(S, name, name, worker, { at: 'h.def' });
    S.localOf = (t) => (t.req ? `요청 ${t.req}` : '');
    S.result = () => ({ max: api.max, limit, errors: errors.slice(), queued: api.queued.slice(), calls: api.calls,
      final: sem ? slots.value : (slots.locked ? '잠금' : '잠금 해제') });
    return S;
  }

  // ---------- 장면 2: 조건 변수 버퍼 ----------
  // 실험의 buffer_lab.py처럼 작업자들이 모두 take()에서 기다리면 업로드 스레드 P가 작업 하나를 put()한다. 이것을 세 번 한다.
  // 실험의 업로드 뒤 작업 20개(처리 시간 측정 구간)는 그리지 않는다.

  function buildBuffer(cfg) {
    const S = makeSim('buffer', { startText: `시작 전: 작업자 ${cfg.workers}개가 take()로 작업을 기다리기를, 업로드 스레드 P가 기다린다.` });
    const CAP = 5;
    const lock = makeLock(S, 'lock', 'RLock', 'rlock');
    const cond = makeCond(S, 'cond', 'cond', lock);
    const jobs = addObj(S, { id: 'jobs', type: 'jobs', name: 'jobs', items: [], cap: CAP });
    const done = [];
    const aliveAfter = [];
    let indexErrors = 0;
    let emptyWakeups = 0;
    const workers = [];
    const wake = (t, key) => (cfg.wake === 'notify' ? notify(S, t, cond, key) : notifyAll(S, t, cond, key));
    const aliveCount = () => workers.filter((w) => w.st !== 'done').length;

    function* put(t, job) {
      yield* acquire(S, t, lock, 'p.with');
      try {
        mark(S, t, 'p.check');
        while (jobs.items.length >= CAP) {
          yield* condWait(S, t, cond, 'p.wait');
          mark(S, t, 'p.check');
        }
        mark(S, t, 'p.append');
        jobs.items.push(job);
        emit(S, 'append', `${t.name}: ${R(`작업 ${job}`)} jobs에 넣는다`, [t.id, 'jobs']);
        yield 'p.wake';
        wake(t, 'p.wake');
        yield 'p.exit';
      } finally {
        release(S, t, lock, 'p.exit');
      }
    }

    function* take(t) {
      yield* acquire(S, t, lock, 't.with');
      let ok = false;
      try {
        mark(S, t, 't.check');
        if (cfg.take === 'if') {
          if (!jobs.items.length) {
            yield* condWait(S, t, cond, 't.wait');
            if (!jobs.items.length) emptyWakeups += 1;
          }
        } else {
          while (!jobs.items.length) {
            yield* condWait(S, t, cond, 't.wait');
            mark(S, t, 't.check');
            if (!jobs.items.length) {
              emptyWakeups += 1;
              emit(S, 'empty-wake', `${t.name}: 깨어났지만 jobs가 비어 있어 다시 wait()에 들어간다`, [t.id, 'cond']);
            }
          }
        }
        mark(S, t, 't.pop');
        if (!jobs.items.length) {
          indexErrors += 1;
          throw new PyErr('IndexError', 'pop from an empty deque');
        }
        const job = jobs.items.shift();
        t.job = job;
        emit(S, 'pop', `${t.name}: jobs에서 ${R(`작업 ${job}`)} 꺼낸다`, [t.id, 'jobs']);
        yield 't.wake';
        wake(t, 't.wake');
        yield 't.ret';
        mark(S, t, 't.ret');
        ok = true;
        return job;
      } finally {
        release(S, t, lock, ok ? 't.ret' : 't.pop');
      }
    }

    // 작업자는 꺼낸 작업의 썸네일을 만드는 동안(sleep) 락 밖에서 잔다. 끝나면 다시 take()로 간다.
    function* worker(t) {
      for (;;) {
        mark(S, t, 'w.loop');
        mark(S, t, 'w.take');
        const job = yield* take(t);
        mark(S, t, 'w.take');
        mark(S, t, 'w.stop');
        yield* sleep(S, t, UNITS.thumb, 'w.sleep', 'sleep 대기', `${t.name}: 작업 ${job}의 썸네일을 만든다(sleep)`);
        done.push(job);
        emit(S, 'job-done', `${t.name}: 작업 ${job}의 썸네일을 다 만들었다`, [t.id]);
        t.job = null;
      }
    }

    // 실험의 settle(): jobs가 비고, 살아 있는 작업자가 모두 대기 목록에 있고, 꺼낸 작업이 다 끝났는지 본다.
    // 맞는 순간 살아 있는 작업자 수를 적는다(alive_after_uploads).
    const settled = (k) => () => {
      const ok = !jobs.items.length && done.length === k && workers.filter((w) => w.st !== 'done').every((w) => cond.waiters.includes(w.id));
      if (ok && k > 0 && aliveAfter[k - 1] == null) {
        aliveAfter[k - 1] = aliveCount();
        emit(S, 'settled', `업로드 ${k}번째 뒤 남은 작업자 ${aliveAfter[k - 1]}개가 모두 다시 기다린다`, ['P'], { bad: aliveAfter[k - 1] < cfg.workers });
      }
      return ok;
    };

    function* producer(t) {
      yield* waitUntil(S, t, settled(0), 'm.settle0', 'sleep 대기');
      for (let job = 1; job <= 3; job += 1) {
        t.job = job;
        mark(S, t, 'm.for');
        mark(S, t, 'm.put');
        yield* put(t, job);
        mark(S, t, 'm.put');
        t.job = null;
        yield* waitUntil(S, t, settled(job), 'm.settle', 'sleep 대기', `${t.name}: 작업자들이 모두 다시 기다릴 때까지 settle()로 기다린다`);
      }
    }

    addThread(S, 'P', 'P', producer, { role: 'producer', at: 'm.settle0' });
    for (let i = 1; i <= cfg.workers; i += 1) workers.push(addThread(S, `t${i}`, `t${i}`, worker, { role: 'worker', at: 'w.def' }));
    prerun(S, ['P']);
    S.finishedWhen = () => aliveAfter.length === 3;
    S.localOf = (t) => (t.job ? (t.role === 'producer' ? `업로드 ${t.job}` : `작업 ${t.job}`) : '');
    S.result = () => ({ aliveAfter: aliveAfter.slice(), indexErrors, emptyWakeups, done: done.slice(), workers: cfg.workers });
    return S;
  }

  // ---------- 장면 3: 버퍼 크기 1 (변형 문제 1) ----------
  // while로 고친 take()와 put()에서 버퍼 크기를 1로 줄였다. 작업자 t1·t2가 take()에서 기다리는 중에 P가 put(1), put(2)를 연달아 부른다.

  function buildOnecond(cfg) {
    const S = makeSim('onecond', { startText: '시작 전: t1·t2는 take()에서 기다리는 중이다(대기 목록 t1, t2). 업로드 스레드 P가 put(1), put(2)를 연달아 부른다. 버퍼 크기는 1이다.' });
    const CAP = 1;
    const two = cfg.fix === 'two';
    const lock = two ? makeLock(S, 'lock', 'lock', 'lock') : makeLock(S, 'lock', 'RLock', 'rlock');
    const notFull = two ? makeCond(S, 'notFull', 'not_full', lock) : makeCond(S, 'cond', 'cond', lock);
    const notEmpty = two ? makeCond(S, 'notEmpty', 'not_empty', lock) : notFull;
    const jobs = addObj(S, { id: 'jobs', type: 'jobs', name: 'jobs', items: [], cap: CAP });
    const done = [];
    const workers = [];
    let producer = null;
    let emptyWakeups = 0;
    const wake = (t, C, key) => (cfg.fix === 'all' ? notifyAll(S, t, C, key) : notify(S, t, C, key));

    function* put(t, job) {
      yield* acquire(S, t, lock, 'p.with');
      try {
        mark(S, t, 'p.check');
        while (jobs.items.length >= CAP) {
          yield* condWait(S, t, notFull, 'p.wait');
          mark(S, t, 'p.check');
        }
        mark(S, t, 'p.append');
        jobs.items.push(job);
        emit(S, 'append', `${t.name}: ${R(`작업 ${job}`)} jobs에 넣는다`, [t.id, 'jobs']);
        yield 'p.wake';
        wake(t, notEmpty, 'p.wake');
        yield 'p.exit';
      } finally {
        release(S, t, lock, 'p.exit');
      }
    }

    function* take(t) {
      yield* acquire(S, t, lock, 't.with');
      let ok = false;
      try {
        mark(S, t, 't.check');
        while (!jobs.items.length) {
          yield* condWait(S, t, notEmpty, 't.wait');
          mark(S, t, 't.check');
          if (!jobs.items.length) {
            emptyWakeups += 1;
            emit(S, 'empty-wake', `${t.name}: 깨어났지만 jobs가 비어 있어 다시 wait()에 들어간다`, [t.id, notEmpty.id]);
          }
        }
        mark(S, t, 't.pop');
        const job = jobs.items.shift();
        t.job = job;
        emit(S, 'pop', `${t.name}: jobs에서 ${R(`작업 ${job}`)} 꺼낸다`, [t.id, 'jobs']);
        yield 't.wake';
        wake(t, notFull, 't.wake');
        yield 't.ret';
        mark(S, t, 't.ret');
        ok = true;
        return job;
      } finally {
        release(S, t, lock, ok ? 't.ret' : 't.pop');
      }
    }

    function* worker(t) {
      for (;;) {
        mark(S, t, 'w.loop');
        mark(S, t, 'w.take');
        const job = yield* take(t);
        mark(S, t, 'w.take');
        mark(S, t, 'w.stop');
        yield* sleep(S, t, UNITS.thumb, 'w.sleep', 'sleep 대기', `${t.name}: 작업 ${job}의 썸네일을 만든다(sleep)`);
        done.push(job);
        emit(S, 'job-done', `${t.name}: 작업 ${job}의 썸네일을 다 만들었다`, [t.id]);
        t.job = null;
      }
    }

    function* produce(t) {
      for (const job of [1, 2]) {
        t.job = job;
        mark(S, t, `u.put${job}`);
        yield* put(t, job);
        mark(S, t, `u.put${job}`);
        t.job = null;
        if (job === 1) yield 'u.put2';
      }
    }

    producer = addThread(S, 'P', 'P', produce, { role: 'producer', at: 'u.put1' });
    for (const id of ['t1', 't2']) workers.push(addThread(S, id, id, worker, { role: 'worker', at: 'w.def' }));
    prerun(S, ['t1', 't2']);
    S.finishedWhen = () => done.length === 2 && producer.st === 'done' && workers.every((w) => notEmpty.waiters.includes(w.id));
    S.localOf = (t) => (t.job ? (t.role === 'producer' ? `put(${t.job})` : `작업 ${t.job}`) : '');
    S.result = () => ({ done: done.slice(), emptyWakeups });
    return S;
  }

  // ---------- 장면 4: 기다리는 방법 ----------
  // 실험의 wait_lab.py처럼 로더 L을 먼저 띄우고 요청 처리 스레드를 띄운다. GIL 전환 간격을 1단계로 두어 실행할 수 있는 스레드가
  // 한 단계씩 돌아가며 GIL을 쓴다.

  function buildWait(cfg) {
    const S = makeSim('wait', { startText: `시작 전: 로더 L을 먼저 띄우고 요청 처리 스레드 ${cfg.waiters}개를 띄운다. L은 계산 ${UNITS.load}단계 뒤 set()을 부른다.` });
    const ready = addObj(S, { id: 'ready', type: 'flag', name: 'ready.flag', flag: false });
    const ev = cfg.how === 'event' ? makeEvent(S, 'event', 'ready.event') : null;
    let loadedAt = null;
    let loadStart = null;
    const woke = {};
    let waiterSteps = 0;

    function* load(t) {
      for (let i = 1; i <= UNITS.load; i += 1) {
        if (loadStart == null) loadStart = S.step;
        mark(S, t, 'l.loop');
        t.prog = i;
        emit(S, 'load', `${t.name}: build_index() 계산 ${i}/${UNITS.load}`, [t.id]);
        yield i < UNITS.load ? 'l.loop' : 'l.set';
      }
      mark(S, t, 'l.set');
      mark(S, t, 'r.flag');
      ready.flag = true;
      if (ev) eventSet(S, t, ev, 'r.event');
      else emit(S, 'flag-set', `${t.name}: 계산을 마치고 ready.set()으로 ready.flag를 True로 바꾼다`, [t.id, 'ready']);
      mark(S, t, 'r.event');
      loadedAt = S.step;
    }

    // serve()는 고른 기다리는 방법 하나를 부른다(wait_pass, wait_sleep, wait_event).
    function* serve(t) {
      mark(S, t, 'v.call');
      if (cfg.how === 'pass') {
        for (;;) {
          mark(S, t, 'w.pass');
          if (ready.flag) break;
          mark(S, t, 'w.body');
          emit(S, 'busy', `${t.name}: ready.flag가 아직 False라 pass로 돌며 다시 확인한다`, [t.id, 'ready']);
          yield 'w.pass';
        }
      } else if (cfg.how === 'sleep') {
        for (;;) {
          mark(S, t, 'w.check');
          if (ready.flag) break;
          yield* sleep(S, t, UNITS.poll, 'w.sleep', 'sleep 대기', `${t.name}: ready.flag가 아직 False라 time.sleep(POLL_S)으로 쉰다`);
        }
      } else {
        yield* eventWait(S, t, ev, 'w.event');
      }
      mark(S, t, 'v.call');
      woke[t.id] = S.step;
      emit(S, 'woke', `${t.name}: 준비를 확인하고 기다림을 빠져나온다`, [t.id]);
    }

    addThread(S, 'L', 'L', load, { role: 'loader', at: 'l.def' });
    for (let i = 1; i <= cfg.waiters; i += 1) addThread(S, `s${i}`, `s${i}`, serve, { role: 'waiter', at: 'v.def' });
    S.hook = (S2, actor) => { if (actor && actor.role === 'waiter' && loadedAt == null) waiterSteps += 1; };
    S.localOf = (t) => {
      if (t.role === 'loader') return t.prog && loadedAt == null ? `계산 ${t.prog}/${UNITS.load}` : '';
      return t.st === 'block' && t.due != null ? `깨는 단계 ${t.due}` : '';
    };
    S.result = () => ({ loadStart, loadedAt, woke: Object.assign({}, woke), lastWake: Math.max(...Object.values(woke)), waiterSteps });
    return S;
  }

  // ---------- 장면 5: 이체 ----------
  // 실험의 deadlock_lab.py처럼 t1은 A→B, t2는 B→A로 1씩 보낸다. 자기 계좌 이체(변형 문제 2)는 t1 하나가 A→A로 보낸다.

  function buildTransfer(cfg) {
    const self = cfg.accounts === 'self';
    const names = self ? ['A'] : ['A', 'B'];
    const pairs = self ? [['t1', 'A', 'A']] : [['t1', 'A', 'B'], ['t2', 'B', 'A']];
    const S = makeSim('transfer', { startText: self ? `시작 전: t1이 A에서 A로 ${cfg.per}번 보낸다(자기 계좌 이체).` : `시작 전: t1은 A→B, t2는 B→A로 ${cfg.per}번씩 보낸다.` });
    const locks = {};
    const accts = {};
    for (const n of names) {
      locks[n] = makeLock(S, `lock${n}`, `${n}.lock`, cfg.lock);
      accts[n] = addObj(S, { id: `acct${n}`, type: 'account', name: n, balance: 100, lock: `lock${n}` });
    }
    let retriesTotal = 0;

    // 한도 확인. DB 확인은 실험처럼 sleep으로 대신한다. 메모리 캐시 확인은 비교 한 줄이다.
    function* check(t, key) {
      mark(S, t, key);
      if (cfg.check === 'db') {
        const held = Object.values(locks).filter((L) => L.locked && L.holder === t.id).map((L) => L.name);
        yield* sleep(S, t, UNITS.db, 'c.sleep', 'sleep 대기', `${t.name}: ${held.length ? `${R(held.join('와 '))} 쥔 채 ` : ''}DB에서 이체 한도를 확인한다(sleep)`);
        mark(S, t, key);
        return true;
      }
      mark(S, t, 'c.if');
      mark(S, t, key);
      return false;
    }

    function move(t, src, dst, key) {
      mark(S, t, key);
      accts[src].balance -= 1;
      accts[dst].balance += 1;
      emit(S, 'move', `${t.name}: ${src}에서 1을 빼 ${dst}에 더한다`, [t.id, `acct${src}`, `acct${dst}`]);
    }

    // transfer_opposite(): 보내는 계좌부터 잠근다. 반대 방향 이체끼리 반대 순서로 잡는다.
    function* opposite(t, src, dst) {
      yield* cont(yield* acquire(S, t, locks[src], 'o.src'), 'o.check');
      try {
        yield* cont(yield* check(t, 'o.check'), 'o.dst');
        yield* cont(yield* acquire(S, t, locks[dst], 'o.dst'), 'o.move');
        try {
          move(t, src, dst, 'o.move');
          yield 'o.exit';
        } finally {
          release(S, t, locks[dst], 'o.exit');
        }
      } finally {
        release(S, t, locks[src], 'o.exit');
      }
      return 0;
    }

    // transfer_ordered(): 모든 스레드가 계좌 이름 순서로 잡는다.
    function* ordered(t, src, dst) {
      mark(S, t, 'r.sort');
      const [first, second] = [src, dst].sort();
      yield* cont(yield* acquire(S, t, locks[first], 'r.first'), 'r.second');
      try {
        yield* cont(yield* acquire(S, t, locks[second], 'r.second'), 'r.check');
        try {
          yield* cont(yield* check(t, 'r.check'), 'r.move');
          move(t, src, dst, 'r.move');
          yield 'r.exit';
        } finally {
          release(S, t, locks[second], 'r.exit');
        }
      } finally {
        release(S, t, locks[first], 'r.exit');
      }
      return 0;
    }

    // transfer_retry(): 받는 계좌를 바로 잡지 못하면 쥔 락을 풀고 쉬었다가 처음부터 다시 한다.
    function* retry(t, src, dst, idx) {
      let retries = 0;
      mark(S, t, 'y.init');
      for (;;) {
        mark(S, t, 'y.loop');
        yield* cont(yield* acquire(S, t, locks[src], 'y.src'), 'y.try');
        if (tryAcquire(S, t, locks[dst], 'y.try')) {
          mark(S, t, 'y.break');
          break;
        }
        yield 'y.rel';
        release(S, t, locks[src], 'y.rel');
        retries += 1;
        t.retries += 1;
        retriesTotal += 1;
        mark(S, t, 'y.count');
        emit(S, 'retry', `${t.name}: 쥔 ${R(locks[src].name)} 풀고 쉬었다가 다시 한다(다시 시도 ${t.retries}번째)`, [t.id, locks[src].id]);
        if (self && t.retries >= 3) {
          S.stopReason = 'spin';
          emit(S, 'spin', `${t.name}: 받는 계좌도 자기가 쥔 ${I(locks[dst].name)}라 몇 번을 다시 해도 잡지 못한다. 끝없이 되풀이하므로 여기서 멈춘다`, [t.id, locks[src].id], { bad: true });
        }
        yield* sleep(S, t, UNITS.backoff[idx], 'y.sleep', 'sleep 대기');
      }
      yield 'y.check';
      try {
        yield* cont(yield* check(t, 'y.check'), 'y.move');
        move(t, src, dst, 'y.move');
        yield 'y.exit';
      } finally {
        release(S, t, locks[dst], 'y.exit');
        release(S, t, locks[src], 'y.exit2');
      }
      return retries;
    }

    const fn = { opposite, ordered, retry }[cfg.how];
    // 실험의 move(): 이체를 per번 부르고 마친 수를 센다.
    function* mover(t) {
      for (let k = 1; k <= cfg.per; k += 1) {
        t.k = k;
        mark(S, t, 'm.for');
        mark(S, t, 'm.call');
        yield* fn(t, t.src, t.dst, t.idx);
        mark(S, t, 'm.call');
        mark(S, t, 'm.done');
        t.done = k;
        emit(S, 'transfer-done', `${t.name}: ${t.src}→${t.dst} 이체 ${k}번째를 마쳤다`, [t.id]);
        if (k < cfg.per) yield 'm.for';
      }
    }

    pairs.forEach(([id, src, dst], idx) => addThread(S, id, id, mover, { src, dst, idx, k: 0, done: 0, retries: 0, at: 'm.def' }));
    S.localOf = (t) => `${t.src}→${t.dst} ${Math.min(t.done + (t.st === 'done' ? 0 : 1), cfg.per)}/${cfg.per}${t.retries ? ` · 다시 ${t.retries}` : ''}`;
    S.result = () => ({ done: Object.fromEntries(S.threads.map((t) => [t.id, t.done])), retries: retriesTotal,
      balances: Object.fromEntries(names.map((n) => [n, accts[n].balance])) });
    return S;
  }

  // ---------- 장면 6: 식사하는 철학자 ----------
  // 실험의 philosopher()를 그대로 옮겼다. 철학자는 기다리는 줄(sleep, 포크, 웨이터)에 닿을 때까지 한 단계에 실행한다.

  function buildPhil(cfg) {
    const S = makeSim('phil', { startText: '시작 전: 철학자 다섯이 둥근 식탁에 앉는다. 철학자 i는 양옆의 포크 i와 포크 i+1을 쓰고, 철학자 4는 포크 4와 포크 0을 쓴다.' });
    const n = 5;
    const forks = [];
    for (let i = 0; i < n; i += 1) forks.push(makeLock(S, `F${i}`, `포크 ${i}`, 'lock'));
    const waiter = cfg.pick === 'waiter' ? makeSem(S, 'waiter', '웨이터', n - 1, false) : null;
    const think = UNITS.think[cfg.think];
    const eaten = new Array(n).fill(0);
    const pick = (i) => {
      const a = i;
      const b = (i + 1) % n;
      return cfg.pick === 'larger' ? [Math.max(a, b), Math.min(a, b)] : [a, b];
    };

    function* philosopher(t) {
      const i = t.idx;
      const [a, b] = pick(i);
      const first = forks[a];
      const second = forks[b];
      t.forks = [a, b];
      mark(S, t, 'f.pick');
      if (cfg.pick === 'larger') mark(S, t, 'k.idx');
      mark(S, t, 'k.ret');
      mark(S, t, 'f.pick');
      for (let m = 0; m < cfg.meals; m += 1) {
        mark(S, t, 'f.for');
        yield* sleep(S, t, think[i], 'f.think', 'sleep 대기', `${t.name}: 생각한다(sleep)`);
        mark(S, t, 'f.ifw');
        if (waiter) yield* semAcquire(S, t, waiter, 'f.wacq');
        try {
          yield* acquire(S, t, first, 'f.first');
          try {
            yield* sleep(S, t, UNITS.pick, 'f.pick1', 'sleep 대기', `${t.name}: 첫 포크 ${R(a)} 쥔 채 잠깐 쉰다(sleep)`);
            yield* acquire(S, t, second, 'f.second');
            try {
              t.eating = true;
              emit(S, 'eat', `${t.name}: 포크 ${E(a)} 포크 ${R(b)} 쥐고 먹는다`, [t.id, first.id, second.id]);
              yield* sleep(S, t, UNITS.eat, 'f.eat', 'sleep 대기');
              t.eating = false;
            } finally {
              release(S, t, second, 'f.exit');
            }
          } finally {
            release(S, t, first, 'f.exit');
          }
        } finally {
          mark(S, t, 'f.ifw2');
          if (waiter) semRelease(S, t, waiter, 'f.wrel');
        }
        eaten[i] += 1;
        mark(S, t, 'f.eaten');
      }
    }

    for (let i = 0; i < n; i += 1) addThread(S, `P${i}`, `P${i}`, philosopher, { idx: i, forks: pick(i), at: 'f.def' });
    S.localOf = (t) => (t.eating ? '먹는 중' : `먹음 ${eaten[t.idx]}/${cfg.meals}`);
    S.result = () => ({ eaten: eaten.slice(), meals: cfg.meals });
    return S;
  }

  const BUILD = { release: buildRelease, buffer: buildBuffer, onecond: buildOnecond, wait: buildWait, transfer: buildTransfer, phil: buildPhil };

  function initialView(S) {
    const v = snapshot(S, null);
    v.ev = [{ type: 'start', text: S.startText, ids: [] }];
    return v;
  }

  // 구성 하나를 끝까지 실행해 단계별 보기를 만든다. 같은 구성은 언제나 같은 순서를 낸다.
  function simulate(scene, input) {
    const cfg = normalizeConfig(scene, input);
    const S = BUILD[scene](cfg);
    S.ev = [];
    const views = [initialView(S)];
    while (!S.done && S.step < MAX_STEPS) views.push(stepOnce(S));
    if (!S.done) S.outcome = 'limit';
    const threads = S.threads.map((t) => ({ id: t.id, name: t.name, role: t.role || null, idx: t.idx, src: t.src, dst: t.dst, forks: t.forks }));
    return { scene, cfg, views, finished: S.outcome === 'finished', outcome: S.outcome, result: S.result ? S.result() : {}, threads };
  }

  return { VERSION, FAIR, UNITS, SWITCH, SCENARIOS, CHOICES, RANGES, DEFAULTS, MAX_STEPS, normalizeConfig, simulate, josa };
});
