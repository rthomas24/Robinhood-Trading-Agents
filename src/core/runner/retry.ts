/**
 * Which model-run failures are worth another attempt, and which are a waste of
 * the operator's time. The conversation path had no retry at all: a 529 from
 * the vendor at 3:58 PM lost the trade outright, while an invalid key would be
 * retried forever if we were naive about it. Classify, then back off.
 */
export type ErrorClass = 'transient' | 'terminal' | 'overflow' | 'unknown'

/** A resumed session that outgrew the window: never recoverable by resuming. */
const OVERFLOW = /prompt is too long|context.{0,30}(too long|exceed|overflow)|context_length_exceeded/i
/** Auth, entitlement, money, or a model that does not exist — retrying cannot fix any of these. */
const TERMINAL =
  /\b(401|402|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|authentication|not connected|no credits|insufficient (credits|funds|balance|quota)|quota|billing|payment required|invalid model|model[ _-]?not[ _-]?found|does not exist|unsupported model|subscription/i
/** Capacity, rate limits, and the network — the same request may well work in a second. */
const TRANSIENT =
  /\b(408|425|429|500|502|503|504|529)\b|rate.?limit|too many requests|overloaded|capacity|temporarily unavailable|service unavailable|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network error|fetch failed|premature close|stream (ended|closed)|stalled/i

export function classifyRunError(message?: string): ErrorClass {
  if (!message) return 'unknown'
  if (OVERFLOW.test(message)) return 'overflow'
  // Terminal first on purpose: "429 — monthly quota exhausted" is out of money,
  // not busy, and hammering it just burns the window.
  if (TERMINAL.test(message)) return 'terminal'
  if (TRANSIENT.test(message)) return 'transient'
  return 'unknown'
}

export function isContextOverflow(message?: string): boolean {
  return message ? OVERFLOW.test(message) : false
}

/** Small on purpose: a scheduled tick has a deadline, so two extra tries is the budget. */
export const MAX_TRANSIENT_RETRIES = 2
const BASE_DELAY_MS = 1_500

/** Exponential backoff with ±25% jitter so a fleet waking at 09:30 does not retry in lockstep. */
export function retryDelayMs(attempt: number, rand: () => number = Math.random): number {
  const base = BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  return Math.round(base * (0.75 + rand() * 0.5))
}

/** Wait, unless the run is cancelled first. Resolves `false` when it was. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = (): void => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
