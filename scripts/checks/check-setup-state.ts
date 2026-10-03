/**
 * A new agent asked to plan its own schedule, and what happens when that fails.
 *
 * `{ kind: 'manual' }` is BOTH the default a new agent starts on AND a
 * legitimate choice an operator can make. So an agent whose setup run died looks
 * exactly like one someone deliberately set to manual — and on 2026-08-24 two of
 * them sat that way for five minutes looking deliberately configured, because
 * the runner had crashed mid-setup and nothing recorded that a schedule had ever
 * been intended.
 *
 * That is the same defect family as the rest of that day: a state that reads as
 * a decision and is actually a failure nobody wrote down.
 *
 * `setupState()` is the fix and this pins its three answers. The ANSWER is
 * derived from `awaitingPlan` + `runCount` + the schedule rather than stored, so
 * its meaning follows the agent's own history instead of needing to be kept in
 * step. The flag itself is settled whenever a schedule is set — by the operator
 * in Agent settings or by the agent's own plan.
 *
 * Run: `npm run check -- setup-state`
 */
import { setupState, type AgentConfig, type AgentState, type Schedule } from '@shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const cfg = (schedule: Schedule): Pick<AgentConfig, 'schedule'> => ({ schedule })
const st = (awaitingPlan: boolean | undefined, runCount: number): Pick<AgentState, 'awaitingPlan' | 'runCount'> => ({ awaitingPlan, runCount })

const MANUAL: Schedule = { kind: 'manual' }
const EVERY_10: Schedule = { kind: 'interval', everyMinutes: 10, marketHoursOnly: true }
const AT_TIMES: Schedule = { kind: 'times', times: ['09:31', '15:58'], days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], tradingDaysOnly: true }

// ── the three states ───────────────────────────────────────────────────────
check('just created, setup run not yet done → planning', setupState(cfg(MANUAL), st(true, 0)) === 'planning', 'the sheet says "choosing its own schedule", not "Manual"')
check('setup run happened, still no schedule → unplanned', setupState(cfg(MANUAL), st(true, 1)) === 'unplanned', 'the state that used to be invisible')
check('setup run set an interval → ready', setupState(cfg(EVERY_10), st(true, 1)) === 'ready')
check('setup run set times → ready', setupState(cfg(AT_TIMES), st(true, 1)) === 'ready')

// ── the distinction that is the whole point ────────────────────────────────
check(
  'an operator who CHOSE manual is never nagged',
  setupState(cfg(MANUAL), st(undefined, 0)) === 'ready' && setupState(cfg(MANUAL), st(undefined, 44)) === 'ready',
  'no awaitingPlan means nobody promised a schedule, so manual is a decision'
)
check('...and that holds however long it runs', setupState(cfg(MANUAL), st(false, 100)) === 'ready')

// ── it must not resurrect ──────────────────────────────────────────────────
// An operator who sets a schedule and LATER goes back to manual must read as a
// decision, not as a failed setup from months ago. That is why setting a
// schedule clears the flag, rather than it living forever as the name "never
// cleared" would suggest. This asserts the state AFTER that clearing.
check('switching back to manual later is a decision, not a failed setup', setupState(cfg(MANUAL), st(false, 500)) === 'ready', 'rearm() cleared awaitingPlan when the schedule was first set')

// ── the crash case, end to end ─────────────────────────────────────────────
// Exactly the rows a crashed setup run leaves: runCount 0, manual, awaitingPlan set.
// Before the flag existed this was indistinguishable from a deliberate manual
// agent; the run then completed and it must move to `unplanned`, not stay
// `planning` forever.
const crashed = st(true, 0)
check('the observed crash state reads as planning while it is still trying', setupState(cfg(MANUAL), crashed) === 'planning')
check('and becomes unplanned once a run has been recorded', setupState(cfg(MANUAL), st(true, 1)) === 'unplanned', 'so a crashed setup surfaces instead of looking configured')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
