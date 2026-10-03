/**
 * `flattenAt` — "flat by close" as a level the sweep enforces, not a sentence
 * the model has to remember at 15:55.
 *
 * The contract: at or after the named ET minute of the regular session
 * `enforceExits` market-sells the WHOLE position with a `flatten` trigger;
 * before it, nothing; a stop that fires on the same tick is reported as the
 * stop. And from 15:50 ET an intraday exit still armed is named as overnight
 * exposure in the prompt, so the agent is told the exit will be judged on the
 * next opening print.
 *
 * Run: `npm run check -- flatten-at`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, OVERNIGHT_WARN_MINUTES, describeExitPlan, emptyLedger, flattenDue, flattenTomorrowNote, initialState, overnightExposure, type AgentConfig, type AgentState, type ExitPlan } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { enforceExits } from '@core/broker/execute'
import { protectionsBlock } from '@core/runner/prompts'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const cfg = { id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null } as unknown as AgentConfig
const holding = (plan: ExitPlan): AgentState => ({ ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(9_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }] }, exits: { MU: plan } })
const q = (last: number): Quote[] => [{ symbol: 'MU', last, bid: last, ask: last, ts: 'x' }]
/** A trading Thursday, at HH:MM ET. */
const at = (hhmm: string): Date => etDateTime('2026-09-03', Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)))

async function main(): Promise<void> {
  console.log('— the level —')
  const before = await enforceExits({ config: cfg, state: holding({ flattenAt: '15:55', setAt: 'x' }), rh: null, accountNumber: null, quotes: q(105), now: at('15:40') })
  check('before the minute nothing sells', before.results.length === 0)
  const on = await enforceExits({ config: cfg, state: holding({ flattenAt: '15:55', setAt: 'x' }), rh: null, accountNumber: null, quotes: q(105), now: at('15:55') })
  check('at the minute the whole position is sold', on.results.length === 1 && on.results[0].action.fillQty === 10, on.results[0]?.action.reason ?? 'nothing sold')
  check('with a flatten trigger on the card', on.results[0]?.action.exitTrigger?.kind === 'flatten')
  check('and the plan is cleared', on.state.exits.MU === undefined)
  const late = await enforceExits({ config: cfg, state: holding({ flattenAt: '15:55', setAt: 'x' }), rh: null, accountNumber: null, quotes: q(105), now: at('15:58') })
  check('after the minute it still sells (a missed sweep is not a reprieve)', late.results.length === 1)
  const both = await enforceExits({ config: cfg, state: holding({ stop: 106, flattenAt: '15:55', setAt: 'x' }), rh: null, accountNumber: null, quotes: q(105), now: at('15:55') })
  check('a stop firing on the same tick is reported as the STOP', both.results[0]?.action.exitTrigger?.kind === 'stop', both.results[0]?.action.reason)
  check('describeExitPlan says it', /flatten at 15:55 ET/.test(describeExitPlan({ flattenAt: '15:55' })))

  console.log('\n— the minute is the first one AFTER the plan was set —')
  const setAt = (hhmm: string, date = '2026-09-03'): string => etDateTime(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString()
  const lateBuy = await enforceExits({ config: cfg, state: holding({ flattenAt: '09:31', setAt: setAt('15:58') }), rh: null, accountNumber: null, quotes: q(105), now: at('15:59') })
  check('a 15:58 buy with flattenAt 09:31 is NOT sold at 15:59', lateBuy.results.length === 0, lateBuy.results[0]?.action.reason)
  const nextOpen = await enforceExits({ config: cfg, state: holding({ flattenAt: '09:31', setAt: setAt('15:58') }), rh: null, accountNumber: null, quotes: q(105), now: etDateTime('2026-09-04', 9 * 60 + 31) })
  check('…and IS sold at 09:31 the next morning', nextOpen.results.length === 1 && nextOpen.results[0].action.exitTrigger?.kind === 'flatten', nextOpen.results[0]?.action.reason ?? 'nothing sold')
  const earlySet = await enforceExits({ config: cfg, state: holding({ flattenAt: '09:31', setAt: setAt('09:20') }), rh: null, accountNumber: null, quotes: q(105), now: at('09:31') })
  check('a plan set before the minute (09:20 for 09:31) fires today', earlySet.results.length === 1)
  const closeBuyLate = await enforceExits({ config: cfg, state: holding({ flattenAt: '15:55', setAt: setAt('15:58') }), rh: null, accountNumber: null, quotes: q(105), now: at('15:59') })
  check('a 15:58 buy with flattenAt 15:55 is held for tomorrow’s 15:55, not dumped a minute later', closeBuyLate.results.length === 0)
  check('flattenDue: the pure rule agrees', !flattenDue({ flattenAt: '09:31', setAt: setAt('15:58') }, { date: '2026-09-03', minutes: 15 * 60 + 59 }) && flattenDue({ flattenAt: '09:31', setAt: setAt('15:58') }, { date: '2026-09-04', minutes: 9 * 60 + 31 }))
  check('an unreadable setAt keeps the old reading', flattenDue({ flattenAt: '15:55', setAt: 'x' }, { date: '2026-09-03', minutes: 15 * 60 + 58 }))
  const note = flattenTomorrowNote('09:31', { minutes: 15 * 60 + 58 })
  check('a BUY after its own minute is told the flatten is tomorrow’s', note !== null && /NEXT session/.test(note) && flattenTomorrowNote('15:55', { minutes: 10 * 60 }) === null)
  const tools = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/agentTools.ts'), 'utf8')
  check('the tool says so', /if it has already passed today it fires TOMORROW/.test(tools))
  const runOnceSrc = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/runOnce.ts'), 'utf8')
  check('a buy result carries the note', /flattenTomorrowNote\(intent\.flattenAt/.test(runOnceSrc))

  console.log('\n— overnight awareness —')
  const positions = [{ symbol: 'MU', qty: 10, avgCost: 100 }]
  check('15:50 ET is the line', OVERNIGHT_WARN_MINUTES === 15 * 60 + 50)
  check('before it, nothing to warn about', overnightExposure({ MU: { trail: { pct: 2, high: 105 }, setAt: 'x' } }, positions, 15 * 60 + 40).length === 0)
  check('at it, a held trail is named', overnightExposure({ MU: { trail: { pct: 2, high: 105 }, setAt: 'x' } }, positions, 15 * 60 + 50).join() === 'MU')
  check('a broker-owned plan is not our exposure', overnightExposure({ MU: { stop: 90, enforcedBy: 'broker', setAt: 'x' } }, positions, 16 * 60).length === 0)
  check('a symbol no longer held is not exposure', overnightExposure({ MU: { stop: 90, setAt: 'x' } }, [], 16 * 60).length === 0)
  const block = protectionsBlock(holding({ trail: { pct: 2, high: 105 }, setAt: 'x' }), true, ['MU'])
  check('the EXITS block says the exit is judged on the next opening print', /OVERNIGHT EXPOSURE/.test(block) && /OPENING PRINT/.test(block))
  const prompts = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/prompts.ts'), 'utf8')
  check('the run prompt computes it from the clock', /overnightExposure\(state\.exits, ledger\.positions, c\.minutes\)/.test(prompts))
  check('the setup prompt tells same-day tasks to attach flattenAt', /same-day, flat by close, or never hold overnight, remember to attach \\`flattenAt\\`/.test(prompts))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
