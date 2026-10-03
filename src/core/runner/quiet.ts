import type { Quote } from '@shared/ipc'

/**
 * The no-model fast path for interval ticks.
 *
 * Most scheduled interval runs take no action — an agent re-reading an
 * unchanged book to say "holding" — and each one is a full model call.
 * The old triage gate never fired on those: it required a FLAT book with no
 * exits and no watches, which is to say it skipped only agents with nothing
 * to skip for.
 *
 * A tick is quiet when NONE of these happened, and every one is a fact the
 * engine already established before the model would be called. The list is
 * deliberately explicit and conservative: a signal we are not sure about
 * counts as busy, and an unpriced tick is busy, because "nothing moved" is a
 * claim that needs prices to make.
 */
export interface TickSignals {
  /** A price watch fired on this tick. */
  watchFired: boolean
  /** An exit level moved (a trail ratcheted, a break-even armed, a lock set) or an exit sold. */
  exitMoved: boolean
  /** A resting order settled (paper or live) since the last run. */
  orderSettled: boolean
  /** The operator wrote in the thread since the last run. */
  operatorMessage: boolean
  /** A deferred errand's moment has arrived. */
  errandReady: boolean
  /** The first tick of a new ET day — the day anchor was just set. */
  firstTickOfDay: boolean
  /** Some symbol of interest moved more than `PRICE_MOVE_THRESHOLD` since the last run, or could not be priced. */
  priceMoved: boolean
  /** The daily-loss lock was set on this tick. */
  buyLocked: boolean
  /** An approved pass is waiting to be re-decided. */
  approvalPending: boolean
  /** A respawn revision is owed. */
  respawned: boolean
  /** The agent has never run (its setup or first look). */
  firstRun: boolean
  /** A periodic self-review is due this run. */
  selfReview: boolean
  /**
   * An open question expired and this run just marked its fallback applied.
   * The model is what applies it — a skipped tick would record the promise as
   * kept and keep nothing.
   */
  questionTimedOut: boolean
}

/** Fraction of price change since the last run that counts as "moved". */
export const PRICE_MOVE_THRESHOLD = 0.003

/** True when any quoted symbol moved past the threshold — or when nothing could be priced. */
export function priceMoved(quotes: readonly Quote[], prev: Record<string, number>): boolean {
  if (quotes.length === 0) return true
  return quotes.some((q) => {
    const p = prev[q.symbol]
    return !p || Math.abs(q.last - p) / p > PRICE_MOVE_THRESHOLD
  })
}

/** The reason to record on the skipped run row, or null when the tick is not quiet. */
export function quietTickReason(s: TickSignals): string | null {
  const busy = (Object.keys(s) as (keyof TickSignals)[]).filter((k) => s[k])
  if (busy.length) return null
  return `quiet interval tick — no watch fired, no exit level moved, no order settled, no operator message, no errand due, no symbol moved more than ${PRICE_MOVE_THRESHOLD * 100}% since the last run; the model was not called`
}

/** Which signal(s) made a tick busy — for the log line, so a skipped-nothing week is explainable. */
export function busySignals(s: TickSignals): string[] {
  return (Object.keys(s) as (keyof TickSignals)[]).filter((k) => s[k])
}
