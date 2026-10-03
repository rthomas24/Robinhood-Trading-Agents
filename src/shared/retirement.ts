import type { AgentConfig, AgentState } from './agents'
import { etClock, isRegularSession, nextSessionOpen } from './marketTime'

/**
 * When may a refused flatten be tried again? ONE rule.
 *
 * A deadline retirement that cannot flatten (market closed, no quote, a
 * guardrail) keeps the agent alive and tries again later — and "later" used to
 * mean "the very next wake-up", produced immediately: a timer re-armed at the
 * already-passed `retirement.at` (delay 0) at the end of every run. That is a
 * tight loop of broker calls and one important notification per iteration, all
 * night, for any agent whose deadline passed while it held a position. The
 * retry instant lives here so the engine's timer and `retirementDue` itself
 * cannot disagree about it.
 */

/** How long a flatten refused DURING the session waits before the next attempt (a quote may appear; a guardrail may clear). */
export const FLATTEN_RETRY_MS = 15 * 60_000

/**
 * The instant a flatten refused at `refusedAt` may be tried again: a bounded
 * interval inside the regular session, otherwise the next session open — a
 * market sell cannot go anywhere before then, so nothing is learned by asking.
 */
export function nextFlattenAttempt(refusedAt: Date): Date {
  if (isRegularSession(refusedAt)) {
    const retry = new Date(refusedAt.getTime() + FLATTEN_RETRY_MS)
    if (isRegularSession(retry)) return retry
  }
  return nextSessionOpen(refusedAt)
}

/** True while a refused flatten is still waiting for its retry instant — nothing about retirement is due until then. */
export function flattenBackingOff(state: Pick<AgentState, 'flattenRefusedAt'>, now: Date): boolean {
  const refused = state.flattenRefusedAt ? Date.parse(state.flattenRefusedAt) : NaN
  if (!Number.isFinite(refused)) return false
  return now.getTime() < nextFlattenAttempt(new Date(refused)).getTime()
}

/**
 * Is this refusal a repeat inside the same stretch? The important note (the one
 * that raises a notification) is posted once per ET day per agent; later
 * refusals that day still land in the thread, quietly.
 */
export function flattenRefusalRepeats(prevRefusedAt: string | null | undefined, now: Date): boolean {
  const prev = prevRefusedAt ? Date.parse(prevRefusedAt) : NaN
  if (!Number.isFinite(prev)) return false
  return etClock(new Date(prev)).date === etClock(now).date
}

/**
 * The instant the engine should wake this agent for its deadline retirement,
 * or null when there is nothing to wake for. The engine arms a timer at it.
 *
 *   future deadline            → the deadline
 *   passed, never refused      → the deadline (due now: one attempt)
 *   passed, refused since      → `nextFlattenAttempt(refusal)` — never the deadline again
 *   paused / retired / stalled → null (a timeout wake-up is a no-op for these)
 *
 * A refusal recorded BEFORE the deadline (the operator moved the deadline out
 * after a refused manual Retire) does not count against the new deadline.
 */
export function retirementWakeAt(cfg: Pick<AgentConfig, 'retirement'>, state: Pick<AgentState, 'status' | 'flattenRefusedAt' | 'pendingAction'>, now: Date): Date | null {
  if (state.status === 'paused' || state.status === 'retired') return null
  if (state.pendingAction && !state.pendingAction.approvedAt) return null
  const at = cfg.retirement?.at ? Date.parse(cfg.retirement.at) : NaN
  if (!Number.isFinite(at)) return null
  if (at > now.getTime()) return new Date(at)
  const refused = state.flattenRefusedAt ? Date.parse(state.flattenRefusedAt) : NaN
  if (Number.isFinite(refused) && refused >= at) return nextFlattenAttempt(new Date(refused))
  return new Date(at)
}
