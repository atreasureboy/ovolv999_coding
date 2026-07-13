/**
 * Turn Deadline — race an in-flight async task against a wall-clock cap.
 *
 * The bug this module exists to prevent: cancelling a `setTimeout`
 * via `setImmediate(() => clearTimeout(t))` inside the racer Promise.
 * That `setImmediate` fires on the very next event-loop tick — long
 * before any real turn would exceed 10 minutes — so the deadline was
 * effectively a no-op in production.
 *
 * The fix: the timer handle is owned by the OUTER scope. `runWithDeadline`
 * returns a handle to the active timer so the caller can `clearTimeout`
 * in their own `finally` block, AFTER the inner Promise.race has
 * settled. This is the only correct lifecycle.
 *
 * Usage:
 *   const handle = runWithDeadline(
 *     () => engine.runTurn(prompt, history),
 *     { deadlineMs: 10 * 60 * 1000, onDeadline: () => engine.abort() }
 *   )
 *   try {
 *     const result = await handle.promise
 *   } catch (err) {
 *     if (handle.didExpire) { /* deadline fired *\/ }
 *     throw err
 *   } finally {
 *     handle.clear()  // belt-and-suspenders; safe to call multiple times
 *   }
 */

export interface DeadlineOptions {
  /** Wall-clock cap in milliseconds. */
  deadlineMs: number
  /** Invoked synchronously when the deadline fires, before the rejection.
   *  Use this to abort the underlying work (e.g. `engine.abort()`). */
  onDeadline: () => void
}

export interface DeadlineHandle<T> {
  /**
   * Resolves with the task result on success, OR rejects with a
   * `TurnDeadlineError` if the deadline fired first.
   *
   * If the deadline fires, the underlying task is STILL in flight
   * (the engine's `runTurn` has not returned yet — it observed the
   * abort signal and is cleaning up via its own `finally`). To wait
   * for the original task to fully converge (e.g. before starting a
   * new runTurn on the same engine), await `taskSettled`.
   */
  promise: Promise<T>
  /**
   * A never-rejecting promise that resolves to a `PromiseSettledResult`
   * describing the underlying task's terminal state — `{ status:
   * 'fulfilled', value }` on success or `{ status: 'rejected', reason
   * }` on failure. This is critical for the reentrancy contract:
   *
   *   `ExecutionEngine.runTurn` sets `_turnInFlight = true` for the
   *   duration of the call and clears it in a `finally`. A second
   *   `runTurn` while the flag is still set throws. So when the
   *   deadline fires, the engine is mid-runTurn with the flag set.
   *   If the caller catches the deadline rejection and immediately
   *   starts another runTurn, that second call hits the reentrancy
   *   guard. Awaiting `taskSettled` waits for the original runTurn's
   *   `finally` to clear the flag.
   */
  taskSettled: Promise<PromiseSettledResult<T>>
  /** True iff the deadline fired (vs. the task completing first). */
  didExpire: boolean
  /**
   * Idempotent. Safe to call from a `finally` block even if the timer
   * already fired (clearTimeout on a fired timer is a no-op).
   */
  clear(): void
}

export class TurnDeadlineError extends Error {
  constructor(public readonly deadlineMs: number) {
    super(`Turn exceeded hard deadline of ${deadlineMs}ms — aborted`)
    this.name = 'TurnDeadlineError'
  }
}

export function runWithDeadline<T>(
  task: () => Promise<T>,
  opts: DeadlineOptions,
): DeadlineHandle<T> {
  // The underlying task is a sibling of the race promise. We expose
  // its terminal state via `taskSettled` so callers can wait for the
  // task's own `finally` to converge (clearing the engine's
  // `_turnInFlight` guard, releasing other locks, etc.) before issuing
  // the next operation. We do NOT swallow the task's rejection — both
  // observers see the same outcome.
  let resolveTask!: (v: T) => void
  let rejectTask!: (e: unknown) => void
  const taskPromise = new Promise<T>((res, rej) => {
    resolveTask = res
    rejectTask = rej
  })
  // Kick off the task. .then/.catch routes to BOTH the race-resolver
  // and the settled-state observer.
  task().then(resolveTask, rejectTask)

  // `taskSettled` is a never-rejecting promise that resolves to a
  // PromiseSettledResult — { status, value } or { status, reason }.
  // We never want callers of `taskSettled` to need a `.catch` just to
  // observe the original task's terminal state. The types are
  // preserved directly without an intermediate `unknown` cast.
  const taskSettled: Promise<PromiseSettledResult<T>> = taskPromise.then(
    (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
  )

  let timer: ReturnType<typeof setTimeout> | null = null
  let didExpire = false
  // The race: whoever settles first wins. The promise alias is what
  // consumers await; taskSettled is a separate observation.
  const promise = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      didExpire = true
      try { opts.onDeadline() } catch { /* best-effort */ }
      reject(new TurnDeadlineError(opts.deadlineMs))
    }, opts.deadlineMs)
    taskPromise.then(resolve, reject)
  })

  const handle: DeadlineHandle<T> = {
    promise,
    taskSettled,
    get didExpire(): boolean { return didExpire },
    clear: (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
  return handle
}
