/**
 * A refused flatten backs off; it does not loop.
 *
 * A timer armed at `retirement.at` on every `arm()` loops once the deadline is
 * in the past and the agent holds a position it cannot sell (market closed, no
 * quote): each wake-up fetches quotes, refuses, posts an IMPORTANT note and
 * re-arms at delay 0 — a tight loop of broker calls and notifications all
 * night, per agent.
 *
 *   one rule       `shared/retirement.ts`: `nextFlattenAttempt` (in-session a
 *                  bounded wait, otherwise the next open), `retirementWakeAt`
 *                  (the instant the engine wakes on), `flattenBackingOff` (what
 *                  `retirementDue` consults), `flattenRefusalRepeats` (one
 *                  important note per ET day).
 *   stamped        `executeRetirement` writes `flattenRefusedAt` on refusal, so
 *                  every caller that saves the state records the back-off.
 *   the timer      the engine's timer arms on `retirementWakeAt` and never
 *                  issues the same instant twice.
 *
 * Run: `npm run check -- retirement-backoff`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, emptyLedger, initialState, type AgentConfig, type AgentState } from '@shared/agents'
import { etClock, etDateTime, isRegularSession, isTradingDay, addDays } from '@shared/marketTime'
import { FLATTEN_RETRY_MS, flattenBackingOff, flattenRefusalRepeats, nextFlattenAttempt, retirementWakeAt } from '@shared/retirement'
import { executeRetirement, retirementDue } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const src = (p: string): string => readFileSync(resolve(import.meta.dirname, '../../', p), 'utf8')
const cfg = (retirement: AgentConfig['retirement']): AgentConfig => ({ id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null, retirement }) as unknown as AgentConfig
const holding = (extra: Partial<AgentState> = {}): AgentState => ({ ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(9_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }] }, exits: { MU: { stop: 95, setAt: 'x' } }, ...extra })

// Thursday 2026-09-03 is a trading day; the next open after its close is Friday 09:30 ET.
const DAY = '2026-09-03'
const nextDay = ((): string => {
  let d = addDays(DAY, 1)
  while (!isTradingDay(d)) d = addDays(d, 1)
  return d
})()
const at = (minutes: number, date = DAY): Date => etDateTime(date, minutes)
const deadline = at(15 * 60 + 45) // 15:45 ET — the audit's "flatten before the close" agent
const evening = at(20 * 60)
const midday = at(11 * 60)
const lateSession = at(15 * 60 + 55)
const nextOpen = at(9 * 60 + 30, nextDay)

async function main(): Promise<void> {
  console.log('— when may a refused flatten be tried again —')
  check('the session is where we think it is', isRegularSession(midday) && !isRegularSession(evening))
  check('refused after the close → the next session open, not a minute later', nextFlattenAttempt(evening).getTime() === nextOpen.getTime(), nextFlattenAttempt(evening).toISOString())
  check('refused mid-session → a bounded wait', nextFlattenAttempt(midday).getTime() === midday.getTime() + FLATTEN_RETRY_MS)
  check('refused with less than the wait left in the session → the next open (a sell cannot go anywhere sooner)', nextFlattenAttempt(lateSession).getTime() === nextOpen.getTime())
  check('FLATTEN_RETRY_MS is 15 minutes', FLATTEN_RETRY_MS === 15 * 60_000)

  console.log('\n— backing off —')
  check('an evening refusal is still backing off at 22:00', flattenBackingOff({ flattenRefusedAt: evening.toISOString() }, at(22 * 60)))
  check('and at 03:00 the next morning', flattenBackingOff({ flattenRefusedAt: evening.toISOString() }, at(3 * 60, nextDay)))
  check('and no longer at the next open', !flattenBackingOff({ flattenRefusedAt: evening.toISOString() }, nextOpen))
  check('no refusal → not backing off', !flattenBackingOff({ flattenRefusedAt: null }, evening) && !flattenBackingOff({}, evening))
  check('a garbage timestamp is ignored rather than trusted', !flattenBackingOff({ flattenRefusedAt: 'not a date' }, evening))

  console.log('\n— the wake instant the engine arms on —')
  const c = cfg({ at: deadline.toISOString() })
  check('a future deadline wakes AT the deadline', retirementWakeAt(c, holding(), midday)?.getTime() === deadline.getTime())
  check('a passed deadline never refused wakes now (the deadline): one attempt', retirementWakeAt(c, holding(), evening)?.getTime() === deadline.getTime())
  const refusedTonight = holding({ flattenRefusedAt: evening.toISOString() })
  const wake = retirementWakeAt(c, refusedTonight, at(20 * 60 + 1))
  check('a passed deadline REFUSED since wakes at the next open — not at the deadline again', wake?.getTime() === nextOpen.getTime(), wake?.toISOString())
  check('so the desktop delay is hours, not zero', (wake?.getTime() ?? 0) - at(20 * 60 + 1).getTime() > 12 * 3_600_000)
  const refusedMidday = holding({ flattenRefusedAt: midday.toISOString() })
  check('an in-session refusal (deadline 10:00, refused 11:00) wakes fifteen minutes on', retirementWakeAt(cfg({ at: at(10 * 60).toISOString() }), refusedMidday, at(11 * 60 + 1))?.getTime() === midday.getTime() + FLATTEN_RETRY_MS)
  check('a refusal from BEFORE the deadline (deadline moved out after a refused manual Retire) does not count', retirementWakeAt(cfg({ at: at(23 * 60).toISOString() }), refusedTonight, at(23 * 60 + 1))?.getTime() === at(23 * 60).getTime())
  check('paused → nothing to wake for', retirementWakeAt(c, holding({ status: 'paused' }), evening) === null)
  check('retired → nothing to wake for', retirementWakeAt(c, holding({ status: 'retired' }), evening) === null)
  check('stalled on an unapproved action → nothing to wake for (a timeout wake-up is a no-op for it)', retirementWakeAt(c, holding({ pendingAction: { id: 'a', tool: 'mcp__tb__trade', args: {}, summary: 's', reason: 'r', requestedAt: 'x' } as unknown as AgentState['pendingAction'] }), evening) === null)
  check('an approved action no longer stalls it', retirementWakeAt(c, holding({ pendingAction: { id: 'a', approvedAt: 'x' } as unknown as AgentState['pendingAction'] }), evening)?.getTime() === deadline.getTime())
  check('no deadline → null', retirementWakeAt(cfg({ profitTargetUsd: 100 }), holding(), evening) === null && retirementWakeAt(cfg(null), holding(), evening) === null)

  console.log('\n— the refusal is stamped, and the note rings once a day —')
  const first = await executeRetirement({ config: c, state: holding(), rh: null, accountNumber: null, quotes: [], now: evening }, 'Deadline reached', evening)
  check('refused after hours → not retired, flattenRefusedAt = now', first.retired === false && first.state.flattenRefusedAt === evening.toISOString(), first.state.flattenRefusedAt ?? 'unset')
  check('the first refusal of the day is not a repeat (important note)', first.repeat === false)
  const again = await executeRetirement({ config: c, state: first.state, rh: null, accountNumber: null, quotes: [], now: at(22 * 60) }, 'Deadline reached', at(22 * 60))
  check('a second refusal the same ET day IS a repeat (quiet note)', again.repeat === true && again.state.flattenRefusedAt === at(22 * 60).toISOString())
  const nextMorning = await executeRetirement({ config: c, state: again.state, rh: null, accountNumber: null, quotes: [], now: nextOpen }, 'Deadline reached', nextOpen)
  check('a refusal the next day (no quote at the open) rings again', nextMorning.retired === false && nextMorning.repeat === false)
  check('flattenRefusalRepeats is the ET-day rule', flattenRefusalRepeats(evening.toISOString(), at(23 * 60 + 59)) && !flattenRefusalRepeats(evening.toISOString(), at(0, nextDay)) && !flattenRefusalRepeats(null, evening))
  const inSession = await executeRetirement({ config: c, state: holding(), rh: null, accountNumber: null, quotes: [{ symbol: 'MU', last: 100, bid: 100, ask: 100, ts: 'x' } as Quote], now: at(9 * 60 + 40, nextDay) }, 'Deadline reached', at(9 * 60 + 40, nextDay))
  check('with a quote in session it flattens and retires; a retired state carries no refusal stamp from THIS attempt', inSession.retired === true && inSession.state.flattenRefusedAt === undefined)

  console.log('\n— retirementDue honours the back-off, on any trigger —')
  check('due once the deadline passes', retirementDue(c, holding(), [], evening) !== null)
  check('NOT due while a refusal is backing off — a schedule tick at 22:00 does not re-attempt', retirementDue(c, first.state, [], at(22 * 60)) === null)
  check('due again at the next open', retirementDue(c, first.state, [], nextOpen) !== null)
  check('a profit-target retirement backs off the same way', retirementDue(cfg({ profitTargetUsd: 1 }), { ...holding({ flattenRefusedAt: evening.toISOString() }), paper: { ...emptyLedger(20_000), positions: [] } }, [], at(22 * 60)) === null)

  console.log('\n— the loop, replayed —')
  // Deadline 15:45, position held, app running through the evening. Each arm()
  // reads the wake instant; each wake-up attempts; each refusal moves the instant.
  let state = holding()
  let now = evening
  let attempts = 0
  for (let i = 0; i < 50; i++) {
    const w = retirementWakeAt(c, state, now)
    if (!w || w.getTime() > at(6 * 60, nextDay).getTime()) break // nothing to do before morning
    now = new Date(Math.max(now.getTime(), w.getTime()))
    attempts++
    const r = await executeRetirement({ config: c, state, rh: null, accountNumber: null, quotes: [], now }, 'Deadline reached', now)
    state = r.state
    if (r.retired) break
  }
  check(`the evening costs ONE attempt, then the next wake is the open (was: unbounded)`, attempts === 1 && retirementWakeAt(c, state, now)?.getTime() === nextOpen.getTime(), `${attempts} attempt(s), next ${retirementWakeAt(c, state, now)?.toISOString()}`)
  check('the day the check runs on is what the fixtures assume', etClock(deadline).date === DAY)

  console.log('\n— the engine reads the rule (source contracts) —')
  const engine = src('src/main/engine/Engine.ts')
  check('the engine timer arms on retirementWakeAt', /const wake = retirementWakeAt\(cfg, st, new Date\(\)\)\s*if \(!wake\) return/.test(engine))
  check('and never issues the same wake instant twice', /if \(this\.retireWakeIssued === key\) return/.test(engine) && /this\.retireWakeIssued = key\s*this\.request\(\{ trigger: 'timeout' \}\)/.test(engine))
  const execute = src('src/core/broker/execute.ts')
  check('retirementDue consults flattenBackingOff', /if \(flattenBackingOff\(state, now\)\) return null/.test(execute))
  check('the refusal stamp is written by executeRetirement itself', /state: \{ \.\.\.state, flattenRefusedAt: now\.toISOString\(\) \}/.test(execute))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
