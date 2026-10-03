import type { AgentSleep, AgentState } from './agents'
import { etDateTime, formatEt } from './marketTime'

/**
 * Sleeping until a dated event.
 *
 * An agent whose task waits on a date it can look up — earnings, a scheduled
 * announcement — used to wake on every tick to re-read a calendar and conclude
 * "not yet". `sleep_until` lets it park itself: the sleep instant becomes the
 * next wake-up (see `armedState`), the schedule is left exactly as it was, and
 * the operator's messages, price watches and question deadlines still wake it.
 * Pure and Node-free.
 */

/** The longest an agent may put itself to sleep for. Beyond this the operator should be the one deciding. */
export const MAX_SLEEP_DAYS = 120

/** A bare "YYYY-MM-DD" means this many minutes past midnight ET — five minutes into the session, past the opening prints. */
export const SLEEP_DEFAULT_MINUTES = 9 * 60 + 35

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/
/** "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM[:SS]" with NO zone — read as ET, never as the host's clock (which may be UTC or anywhere else). */
const DATE_TIME_ET = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/
/** A full ISO 8601 instant carrying its own zone (`Z` or `±HH:MM`). */
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * Parse what the model wrote for `until`. Accepts a zoned ISO 8601 instant, an
 * ET wall-clock "YYYY-MM-DD HH:MM", or a bare date (→ 09:35 ET that day).
 * Returns null for anything else — the caller says what shapes are accepted.
 */
export function parseSleepUntil(raw: string): Date | null {
  const s = raw.trim()
  const dateOnly = DATE_ONLY.exec(s)
  if (dateOnly) return validDate(etDateTime(dateOnly[1], SLEEP_DEFAULT_MINUTES))
  const wall = DATE_TIME_ET.exec(s)
  if (wall) {
    const h = Number(wall[2])
    const m = Number(wall[3])
    if (h > 23 || m > 59) return null
    return validDate(etDateTime(wall[1], h * 60 + m))
  }
  if (ISO_ZONED.test(s)) return validDate(new Date(s))
  return null
}

const validDate = (d: Date): Date | null => (Number.isNaN(d.getTime()) ? null : d)

/** The sleep that is still in force at `now`, or null: an expired one is a wake-up that has arrived, not a sleep. */
export function activeSleep(state: Pick<AgentState, 'sleep'> | null | undefined, now: Date | number = Date.now()): AgentSleep | null {
  const s = state?.sleep
  if (!s) return null
  const until = Date.parse(s.until)
  const at = typeof now === 'number' ? now : now.getTime()
  return until > at ? s : null
}

/** Header/status line: "Sleeping until Oct 30, 9:35 AM ET". */
export function sleepStatusText(until: string): string {
  return `Sleeping until ${formatEt(until, true)}`
}
