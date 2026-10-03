/**
 * Re-arming an interval agent must not move its next wake-up.
 *
 * `nextRunAt` for an `interval` schedule is RELATIVE — always
 * `now + everyMinutes`. So recomputing it does not re-derive the pending
 * wake-up, it pushes it. Anything that re-arms more often than the interval
 * therefore prevents the agent from ever running.
 *
 * That is not hypothetical. The Claude usage meter polls every 2 MINUTES and
 * re-armed every runner on each poll (`usageService.onChange`, intended to fire
 * when a hold LIFTS but written to fire whenever no hold was active). A
 * 10-minute agent had its next run pushed 10 minutes into the future every 2
 * minutes: `runCount` stuck at 1 after its setup run, `nextRunAt` always ~10
 * minutes out, `state.json` rewritten constantly, and NOTHING in the thread —
 * no skip, no refusal, no error. The wake-up simply never arrived, for hours,
 * while the UI said "Next run in 9m".
 *
 * Two independent guards, and both are needed:
 *   - `arm()` keeps a pending future wake-up unless the caller says the
 *     schedule changed. Protects against every incidental caller (a dozen of
 *     them: status writes, provider switches, resumes).
 *   - the usage listener fires on the hold EDGE, not on every poll.
 *
 * Run: `npm run check -- arm-drift`
 */
import { armedState, nextRunAt } from '@shared/schedule'
import type { AgentState, Schedule } from '@shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const every10: Schedule = { kind: 'interval', everyMinutes: 10, marketHoursOnly: false }
const every2: Schedule = { kind: 'interval', everyMinutes: 2, marketHoursOnly: false }
const at0931: Schedule = { kind: 'times', times: ['09:31'], days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], tradingDaysOnly: true }

/** `AgentRunner.arm()`'s decision, extracted verbatim. */
const armedNextRunAt = (schedule: Schedule, state: Pick<AgentState, 'nextRunAt' | 'status'>, reschedule: boolean, now: Date): string | null => {
  const fresh = armedState({ schedule }, state.status, now)
  const pending = !reschedule && state.nextRunAt && new Date(state.nextRunAt).getTime() > now.getTime() ? state.nextRunAt : null
  return pending && fresh.nextRunAt ? pending : fresh.nextRunAt
}

const T0 = new Date('2026-08-24T16:00:00Z')
const plus = (min: number): Date => new Date(T0.getTime() + min * 60_000)
const armed = (nextRunAtIso: string | null): Pick<AgentState, 'nextRunAt' | 'status'> => ({ nextRunAt: nextRunAtIso, status: 'scheduled' })

// ── the failure ────────────────────────────────────────────────────────────
const due = nextRunAt(every10, T0)!.toISOString() // armed at T0 for T0+10
check('a fresh arm schedules 10 minutes out', new Date(due).getTime() === plus(10).getTime(), due)

// The usage meter re-arms at +2, +4, +6, +8. Under the old behaviour each of
// those pushed the wake-up to now+10 and it never arrived.
let state = armed(due)
for (const m of [2, 4, 6, 8]) state = armed(armedNextRunAt(every10, state, false, plus(m)))
check('four incidental re-arms do NOT move the wake-up', state.nextRunAt === due, `${state.nextRunAt} — this used to walk forward forever`)
check('...so it is still due at the original time', new Date(state.nextRunAt!).getTime() === plus(10).getTime())

// What the old code did, for contrast — the bug, reproduced.
let drifting = armed(due)
for (const m of [2, 4, 6, 8]) drifting = armed(armedNextRunAt(every10, drifting, true, plus(m)))
check('recomputing on every poll DOES push it away', new Date(drifting.nextRunAt!).getTime() === plus(18).getTime(), `${drifting.nextRunAt} — 8 minutes later than when it started, and climbing`)

// ── a real schedule change must still take effect ──────────────────────────
// The preserve behaviour must not make the agent deaf to an edit.
const shortened = armedNextRunAt(every2, armed(due), true, plus(1))
check('changing the schedule re-derives the wake-up', new Date(shortened!).getTime() === plus(3).getTime(), `${shortened} — 2 minutes from the edit, not the old +10`)
check('...and without reschedule the old one would have stuck', armedNextRunAt(every2, armed(due), false, plus(1)) === due, 'which is why update() passes reschedule when the schedule changed')

// ── a wake-up in the PAST is not preserved ─────────────────────────────────
// catchUpDecision handles those before this point; preserving one would leave
// an agent armed for a moment that has gone.
const stale = armedNextRunAt(every10, armed(plus(-5).toISOString()), false, T0)
check('a past wake-up is replaced, not kept', stale !== plus(-5).toISOString(), stale ?? 'null')
check('...with a future one', new Date(stale!).getTime() > T0.getTime())

// ── clock schedules were never affected, and must stay unaffected ──────────
// `times` is absolute, so recomputing is idempotent — this had no bug, and the
// fix must not introduce one.
const t1 = armedNextRunAt(at0931, armed(null), true, T0)
const t2 = armedNextRunAt(at0931, armed(t1), false, plus(3))
check('a times schedule is stable across re-arms', t1 === t2, `${t1} vs ${t2}`)

// ── paused and retired stay unarmed ────────────────────────────────────────
check('a paused agent is not armed by this', armedNextRunAt(every10, { nextRunAt: null, status: 'paused' }, true, T0) === null)
check('a retired agent is not armed by this', armedNextRunAt(every10, { nextRunAt: null, status: 'retired' }, true, T0) === null)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
