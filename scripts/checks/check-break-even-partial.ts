/**
 * Break-even ratchet and partial targets.
 *
 * `breakEvenAfterPct` moves the stop UP to the average cost once the position
 * is up that much — one-way, persisted on the tick it happens. `targetPct`
 * sells a fraction at the target; the remainder keeps every other level and
 * the target is spent. Deliberately `targetPct` beside the existing numeric
 * `target` rather than changing `target`'s type: every renderer
 * read `target` as a number today, and a new optional field is compatible by
 * construction.
 *
 * Run: `npm run check -- break-even-partial`
 */
import { DEFAULT_GUARDRAILS, describeExitPlan, emptyLedger, initialState, type AgentConfig, type AgentState, type ExitPlan } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { enforceExits } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const cfg = { id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null } as unknown as AgentConfig
const holding = (plan: ExitPlan): AgentState => ({ ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(9_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }] }, exits: { MU: plan } })
const q = (last: number): Quote[] => [{ symbol: 'MU', last, bid: last, ask: last, ts: 'x' }]
const now = etDateTime('2026-09-03', 11 * 60)

async function main(): Promise<void> {
  console.log('— break-even —')
  const notYet = await enforceExits({ config: cfg, state: holding({ stop: 95, breakEvenAfterPct: 3, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(102), now })
  check('below the threshold the stop stays where it was', notYet.state.exits.MU?.stop === 95)
  const be = await enforceExits({ config: cfg, state: holding({ stop: 95, breakEvenAfterPct: 3, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(103), now })
  check('at +3% the stop moves to the average cost', be.state.exits.MU?.stop === 100, `got ${be.state.exits.MU?.stop}`)
  check('nothing sells doing it', be.results.length === 0)
  check('and it is a new state object, so the sweep persists it', be.state !== holding({ stop: 95, breakEvenAfterPct: 3, setAt: 'x' }))
  const higher = await enforceExits({ config: cfg, state: holding({ stop: 101, breakEvenAfterPct: 3, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(103), now })
  check('a stop already above cost is never moved DOWN', higher.state.exits.MU?.stop === 101)
  const then = await enforceExits({ config: cfg, state: be.state, rh: null, accountNumber: null, quotes: q(99.5), now })
  check('the ratcheted stop then fires as a stop', then.results.length === 1 && then.results[0].action.exitTrigger?.kind === 'stop' && then.results[0].action.exitTrigger?.level === 100)

  console.log('\n— partial target —')
  const half = await enforceExits({ config: cfg, state: holding({ stop: 95, target: 110, targetPct: 50, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(111), now })
  check('the target sells half', half.results.length === 1 && half.results[0].action.fillQty === 5, `sold ${half.results[0]?.action.fillQty}`)
  check('the remainder keeps the stop', half.state.exits.MU?.stop === 95)
  check('and the target is spent so it cannot fire again on the rest', half.state.exits.MU?.target === undefined && half.state.exits.MU?.targetPct === undefined)
  check('the reason says it was partial', /selling 50%/.test(half.results[0]?.action.reason ?? ''))
  const full = await enforceExits({ config: cfg, state: holding({ target: 110, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(111), now })
  check('absent targetPct = sell everything, plan cleared (old behaviour)', full.results[0]?.action.fillQty === 10 && full.state.exits.MU === undefined)
  check('describeExitPlan reads both', /target \$110\.00 \(sell 50%\)/.test(describeExitPlan({ target: 110, targetPct: 50 })) && /stop to break-even once up 3%/.test(describeExitPlan({ breakEvenAfterPct: 3 })))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
