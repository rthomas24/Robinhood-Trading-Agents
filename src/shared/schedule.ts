import type { AgentState, AgentStatus, Schedule } from './agents'
import { activeSleep } from './sleep'
import { CLOSE_MINUTES, TRADING_WEEKDAYS, addDays, etClock, etDateTime, formatEt, formatMinutes, isRegularSession, isTradingDay, nextSessionOpen, parseHHMM, sessionCloseMinutes, type Weekday, weekdayOf } from './marketTime'

/**
 * Compute the next wake-up strictly after `now` for a schedule. Returns null for
 * manual schedules and for 'once' schedules already in the past. Pure.
 */
/**
 * A stable 0–89s offset from an agent id. Deterministic, so the same agent lands
 * on the same second every day and its cadence stays predictable.
 */
function openJitterSeconds(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return Math.abs(h) % 90
}

/**
 * `jitterSeed` (an agent id) spreads the market-open wake-up.
 *
 * Every interval agent with marketHoursOnly resolves to nextSessionOpen(), which
 * is an exact instant — so the whole fleet converges on 09:30:00.000. That is
 * both a thundering herd and the worst moment of the day to trade: widest
 * spreads, most volatile prints, and a VWAP that is one bar old. Omitting the
 * seed keeps the old exact-open behaviour, so no caller has to change.
 */
export function nextRunAt(schedule: Schedule, now: Date = new Date(), jitterSeed?: string): Date | null {
  switch (schedule.kind) {
    case 'manual':
      return null
    case 'once': {
      const at = new Date(schedule.at)
      if (!(at.getTime() > now.getTime())) return null
      // Same clamp as `times`. A one-shot is the schedule a "do this one thing"
      // agent gets, and it was the one kind that could still fire into a shut
      // market on an early-close day.
      const c = etClock(at)
      const close = sessionCloseMinutes(c.date)
      return c.minutes >= close && c.minutes < CLOSE_MINUTES ? etDateTime(c.date, close - HALF_DAY_CLAMP_MIN) : at
    }
    case 'interval': {
      const every = Math.max(1, Math.round(schedule.everyMinutes)) * 60_000
      const t = new Date(now.getTime() + every)
      if (!schedule.marketHoursOnly) return t
      if (isRegularSession(t)) return t
      // Outside the session: wake at the next open. If `now` is inside the
      // session but `t` is past the close, that also lands on the next open.
      const open = nextSessionOpen(t)
      return jitterSeed ? new Date(open.getTime() + openJitterSeconds(jitterSeed) * 1000) : open
    }
    case 'times': {
      const mins = schedule.times
        .map(parseHHMM)
        .filter((m): m is number => m !== null)
        .sort((a, b) => a - b)
      if (mins.length === 0) return null
      const days = schedule.days.length ? schedule.days : TRADING_WEEKDAYS
      const c = etClock(now)
      // Scan today + the next 14 days for the first matching (day, time).
      for (let i = 0; i < 15; i++) {
        const date = addDays(c.date, i)
        const wd = weekdayOf(date)
        if (!days.includes(wd)) continue
        if (schedule.tradingDaysOnly && !isTradingDay(date)) continue
        const close = sessionCloseMinutes(date)
        for (const m of mins) {
          // Half days. The bell rings at 13:00, so a "15:58" wake-up would land
          // three hours after it — the operator asked for a moment relative to
          // the close ("two minutes before the bell"), not for a literal clock
          // time that means something different today. Pull it to just before
          // the early close rather than firing into a shut market, or skipping
          // the day the position most needs closing.
          //
          // Only times that WOULD have been inside a normal session are moved.
          // A pre-market 08:30 or an evening 20:00 schedule means exactly what
          // it says on every day, and is left alone.
          const at = m >= close && m < CLOSE_MINUTES ? close - HALF_DAY_CLAMP_MIN : m
          // Strictly after now; compare against seconds so a run at 15:58:00 doesn't re-fire at 15:58:30.
          if (i === 0 && at * 60 <= c.minutes * 60 + c.second) continue
          return etDateTime(date, at)
        }
      }
      return null
    }
  }
}

/** How far before an early close a clamped wake-up lands. */
const HALF_DAY_CLAMP_MIN = 2

const DAY_ORDER: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function describeDays(days: Weekday[]): string {
  const sorted = DAY_ORDER.filter((d) => days.includes(d))
  if (sorted.length === 0 || sorted.length === 5 && sorted.every((d) => TRADING_WEEKDAYS.includes(d))) return 'Weekdays'
  if (sorted.length === 7) return 'Every day'
  return sorted.join(', ')
}

/** Human summary, e.g. "Weekdays at 3:58 PM & 9:31 AM ET". */
export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case 'manual':
      return 'Manual — runs only when you say so'
    case 'once':
      // ET, explicitly. This string is read by the MODEL (it is in the system
      // prompt's "you wake up on a schedule" line) and by the operator; on a
      // host whose clock is UTC, `toLocaleString()` would tell an agent
      // scheduled for 3:58 PM ET that it runs at "7:58 PM".
      return `Once at ${formatEt(s.at, true)}`
    case 'interval': {
      const m = s.everyMinutes
      const every = m % 60 === 0 ? `${m / 60} h` : `${m} min`
      return `Every ${every}${s.marketHoursOnly ? ' during market hours' : ''}`
    }
    case 'times': {
      const ts = s.times.map(parseHHMM).filter((x): x is number => x !== null).sort((a, b) => a - b).map(formatMinutes)
      const when = ts.length === 0 ? '—' : ts.length <= 3 ? ts.join(' & ') : `${ts.length} times`
      return `${describeDays(s.days)} at ${when} ET${s.tradingDaysOnly ? '' : ' (incl. holidays)'}`
    }
  }
}

/** Validate a schedule coming from the UI or the model; returns an error string or null. */
export function validateSchedule(s: Schedule): string | null {
  switch (s.kind) {
    case 'manual':
      return null
    case 'once':
      return Number.isNaN(new Date(s.at).getTime()) ? 'Invalid date' : null
    case 'interval':
      if (!Number.isFinite(s.everyMinutes) || s.everyMinutes < 1) return 'Interval must be ≥ 1 minute'
      if (s.everyMinutes > 24 * 60) return 'Interval must be ≤ 24 hours'
      return null
    case 'times':
      if (s.times.length === 0) return 'Add at least one time'
      for (const t of s.times) if (parseHHMM(t) === null) return `Bad time "${t}" — use HH:MM (24h, ET)`
      return null
  }
}

/**
 * What (re)arming a schedule does to an agent's state: the next wake-up and the
 * status it implies. One rule for every writer — `error` sticks until something
 * clears it, a spent `once` is `done`.
 */
/**
 * The instant an agent wakes next: its sleep, while one is in force, else the
 * schedule's next tick. ONE rule for `armedState`, the desktop engine and both
 * settle paths in `runOnce`, so a sleeping agent's `nextRunAt` can never be
 * recomputed from the schedule by a caller that forgot about the sleep.
 */
export function nextWakeAt(cfg: { schedule: Schedule; id?: string }, state: Pick<AgentState, 'sleep'> | null | undefined, now: Date = new Date()): Date | null {
  const sleep = activeSleep(state, now)
  if (sleep) return new Date(sleep.until)
  return nextRunAt(cfg.schedule, now, cfg.id)
}

/**
 * `state` is optional so callers that have no state at hand still compile;
 * without it the schedule alone decides. Pass it wherever the state is at hand — every
 * writer that does not is a writer that can wake a sleeping agent early.
 */
export function armedState(cfg: { schedule: Schedule; id?: string }, prevStatus: AgentStatus, now: Date = new Date(), state?: Pick<AgentState, 'sleep'> | null): Pick<AgentState, 'status' | 'nextRunAt'> {
  // A RETIRED agent is never armed. This is the one place that decides what
  // arming means, and without the guard any caller that re-armed a retired
  // agent silently RESURRECTED it: `status` came back as 'scheduled', a next
  // wake-up appeared, and the scheduler started waking it again. It then posted
  // messages and showed up in the active list, while `retiredAt` sat there
  // proving the operator had stopped it.
  //
  // Paused is left alone for the same reason. This used to say so while only
  // guarding `retired` — a comment asserting an invariant the code did not have.
  // Every caller happened to guard paused itself, so nothing was broken, but the
  // retired guard exists precisely because a caller once forgot; the same
  // argument applies here. Callers that must re-arm on resume pass a non-paused
  // `prevStatus` ('idle'), which is what makes this safe.
  if (prevStatus === 'retired' || prevStatus === 'paused') return { status: prevStatus, nextRunAt: null }
  const schedule = cfg.schedule
  // A sleep in force IS the next wake-up; the schedule waits behind it. An
  // expired sleep is ignored here — the run that arrives clears it.
  const next = nextWakeAt(cfg, state, now)
  const status: AgentStatus = next ? 'scheduled' : prevStatus === 'error' ? 'error' : schedule.kind === 'once' ? 'done' : 'idle'
  return { status, nextRunAt: next ? next.toISOString() : null }
}

/* ─────────────────────── Late wake-ups (catch-up vs missed) ─────────────────────── */

/** How late a wake-up may be and still be the run you asked for. */
export const CATCH_UP_GRACE_MS = 3 * 60_000

export type CatchUp = 'run' | 'missed' | 'skip'

/**
 * A wake-up that arrives late — the laptop slept, the app was closed.
 * Running it blindly is wrong: "3:58 PM" means two minutes
 * before the close, and firing that trade at 11 PM is a different trade than
 * the operator asked for. Re-arming silently is also wrong: the operator
 * believes the run happened.
 *
 *   run    — still the run you asked for (inside the grace window)
 *   missed — an appointment (`times` / `once`) that expired: say so, re-arm
 *   skip   — a cadence (`interval`) that simply ticks again shortly; no receipt
 */
export function catchUpDecision(schedule: Schedule, dueAt: Date | string, now: Date = new Date(), state?: Pick<AgentState, 'sleep'> | null): CatchUp {
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt
  if (Number.isNaN(due.getTime())) return 'skip'
  if (now.getTime() - due.getTime() <= CATCH_UP_GRACE_MS) return 'run'
  // The wake-up that ends a sleep is not an appointment with the clock: the
  // agent asked to be woken "at or after" the event's date, not "at 09:35 or
  // not at all". Late is fine — run it, and let the run clear the sleep. Without
  // this, a laptop opened at 10:00 posted "Missed the 9:35 AM run" for a wake-up
  // whose whole point was still ahead of it.
  if (state?.sleep && Math.abs(Date.parse(state.sleep.until) - due.getTime()) < 60_000) return 'run'
  return schedule.kind === 'interval' ? 'skip' : 'missed'
}

/**
 * How long a gap is worth explaining. Below this, silence is correct: a laptop
 * that slept for ten minutes is not something an operator noticed.
 *
 * Time alone is not enough, though — see `SKIPPED_REPORT_AFTER_RUNS`.
 */
export const SKIPPED_REPORT_AFTER_MS = 30 * 60_000

/**
 * ...or this many wake-ups lost, whichever comes first.
 *
 * "How long was it away" and "how much did this agent lose" are different
 * questions, and the note answers the second — so gating it on the first alone
 * reported the wrong things. A 60-minute agent shut for 31 minutes loses ONE
 * tick and spoke; a 1-minute agent shut for 29 minutes loses TWENTY-NINE and
 * said nothing, which is precisely the operator who chose a fast cadence
 * because they wanted it watching closely.
 *
 * Five is comfortably above the floor: `CATCH_UP_GRACE_MS` is 3 minutes, so a
 * one-minute agent must already have lost about four before this can apply.
 */
export const SKIPPED_REPORT_AFTER_RUNS = 5

/**
 * Receipt for interval wake-ups lost while nothing was running — `null` when the
 * gap is too small to be worth saying.
 *
 * `catchUpDecision` returns `skip` for an interval past the grace window and
 * NOTHING was posted, on the reasoning that a cadence just ticks again shortly.
 * That holds for a four-minute sleep and fails badly for an evening: close the
 * laptop at six and an interval agent loses every wake-up until morning, in
 * total silence, then shows a fresh countdown as though nothing happened. The
 * `times` case has always posted `missedRunMessage` — this is the same
 * information for the other kind of schedule, and its absence is a large part of
 * why nobody noticed the wake-ups were being lost rather than deferred.
 *
 * ONE note per absence, not per skip. It is emitted from `arm()`, which runs
 * once per agent when the engine starts, so an overnight gap produces a single
 * line rather than two hundred.
 */
export function skippedRunsMessage(schedule: Schedule, dueAt: Date | string, now: Date = new Date()): string | null {
  if (schedule.kind !== 'interval') return null
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt
  if (Number.isNaN(due.getTime())) return null
  const elapsed = now.getTime() - due.getTime()
  if (elapsed < 0) return null
  const every = Math.max(1, Math.round(schedule.everyMinutes)) * 60_000
  // `dueAt` is the FIRST wake-up nothing was there for; the rest would have
  // fallen every `every` after it — but only the ones that would actually have
  // FIRED count. A market-hours agent never wakes at 2 AM, so an overnight
  // absence loses the session's slots and no others. Counting the clock
  // instead of the session reported "78 wake-ups skipped" for a 13-hour
  // absence on a 10-minute market-hours agent, when 39 was the true number;
  // an operator reading that doubles their idea of what a closed laptop costs.
  let skipped: number
  if (schedule.marketHoursOnly) {
    skipped = 0
    // Bounded walk: a one-minute agent over a fortnight is ~20k steps, cheap;
    // the cap only guards against a corrupt `dueAt` years in the past.
    const MAX_STEPS = 100_000
    for (let t = due.getTime(), i = 0; t <= now.getTime() && i < MAX_STEPS; t += every, i++) if (isRegularSession(new Date(t))) skipped++
    if (skipped === 0) return null
  } else {
    skipped = 1 + Math.floor(elapsed / every)
  }
  // Either a stretch long enough to notice, or enough lost checks to matter.
  // Count is computed FIRST because it is what the sentence below reports.
  if (elapsed < SKIPPED_REPORT_AFTER_MS && skipped < SKIPPED_REPORT_AFTER_RUNS) return null
  const hours = elapsed / 3_600_000
  const forHow = hours >= 1.5 ? `${Math.round(hours)} hours` : `${Math.round(elapsed / 60_000)} min`
  // ET, never the host's locale: on a UTC clock the same note would name the wrong hour.
  const since = formatEt(due, true)
  return `⏭ ${skipped} wake-up${skipped === 1 ? '' : 's'} skipped — nothing was running this agent for ${forHow} (since ${since}), so they were dropped rather than fired late all at once. Re-armed for the next one.`
}

/** Thread receipt for a wake-up that expired before anything could run it. */
export function missedRunMessage(dueAt: Date | string, now: Date = new Date()): string {
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt
  const lateMin = Math.max(1, Math.round((now.getTime() - due.getTime()) / 60_000))
  const late = lateMin >= 120 ? `${Math.round(lateMin / 60)} hours` : `${lateMin} min`
  // ET, explicitly, never the host's locale: on a UTC clock a 3:40 PM ET
  // wake-up would read "Missed the 7:40 PM run" — a time the agent was never
  // scheduled for, in a thread where every other time is ET.
  const when = formatEt(due, true)
  return `⏭ Missed the ${when} run — nothing was watching it (${late} late), so it was skipped rather than run at the wrong time. Re-armed for the next one.`
}
