/**
 * An ADD with a trail re-seeds the high at max(previous high, fill) — never at
 * the fill alone — and a buy that moves the plan's effective stop says so.
 *
 * The fixture is the failure case: an agent adds on a DIP. The old bookkeeping
 * replaced the trail with `{ high: fill }`, which moved an already-armed stop
 * DOWN and loosened the protection on the shares bought earlier — silently,
 * because the card describes the order and this is bookkeeping.
 *
 * Run: `npm run check -- trail-reseed`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { armExitPlan, DEFAULT_GUARDRAILS, effectiveStop, emptyLedger, initialState, type AgentConfig, type AgentState } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { executeTrade } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const cfg = { id: 'ag', name: 'T', mode: 'paper', allocationUsd: 100_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null } as unknown as AgentConfig
const now = etDateTime('2026-09-03', 11 * 60)
// Holding 10 MU bought at 100; the price ran to 120 and the 5% trail's high followed (stop 114).
const holding = (): AgentState => ({ ...initialState({ allocationUsd: 100_000 }), paper: { ...emptyLedger(90_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }] }, exits: { MU: { trail: { pct: 5, high: 120 }, setAt: 'x' } } })

async function main(): Promise<void> {
  console.log('— the pure rule —')
  const dip = armExitPlan({ trail: { pct: 5, high: 120 }, setAt: 'x' }, { trailPct: 5 }, 110, 'now')
  check('an add on a dip keeps the 120 high', dip.plan.trail?.high === 120, `got ${dip.plan.trail?.high}`)
  check('so the effective stop does not move, and nothing is announced', effectiveStop(dip.plan) === 114 && dip.stopMoved === undefined)
  const up = armExitPlan({ trail: { pct: 5, high: 120 }, setAt: 'x' }, { trailPct: 5 }, 130, 'now')
  check('an add above the high raises it', up.plan.trail?.high === 130)
  check('and reports the stop moving 114 → 123.5', up.stopMoved?.from === 114 && up.stopMoved?.to === 123.5, JSON.stringify(up.stopMoved))
  const first = armExitPlan(undefined, { trailPct: 5 }, 110, 'now')
  check('a first buy seeds from the fill and reports nothing', first.plan.trail?.high === 110 && first.stopMoved === undefined)
  const fixed = armExitPlan({ stop: 105, setAt: 'x' }, { stopLoss: 108 }, 110, 'now')
  check('a new fixed stop on an old one is reported too', fixed.stopMoved?.from === 105 && fixed.stopMoved?.to === 108)
  const keep = armExitPlan({ stop: 105, target: 130, setAt: 'x' }, { trailPct: 5 }, 110, 'now')
  check('levels the add does not mention survive (merge, not replace)', keep.plan.stop === 105 && keep.plan.target === 130)

  console.log('\n— through executeTrade —')
  const q: Quote[] = [{ symbol: 'MU', last: 110, bid: 109.9, ask: 110, ts: 'x' }]
  const r = await executeTrade({ config: cfg, state: holding(), rh: null, accountNumber: null, quotes: q, now }, { side: 'buy', symbol: 'MU', qty: 5, type: 'market', tif: 'day', trailPct: 5, reason: 'add on the dip' })
  check('the add fills', r.action.status === 'filled')
  check('the trail high is still 120 after the dip add', r.state.exits.MU?.trail?.high === 120, `got ${r.state.exits.MU?.trail?.high}`)
  check('no stop-moved note for a stop that did not move', r.stopMoved === undefined)
  const q2: Quote[] = [{ symbol: 'MU', last: 130, bid: 129.9, ask: 130, ts: 'x' }]
  const r2 = await executeTrade({ config: cfg, state: holding(), rh: null, accountNumber: null, quotes: q2, now }, { side: 'buy', symbol: 'MU', qty: 5, type: 'market', tif: 'day', trailPct: 5, reason: 'add on strength' })
  check('an add on strength raises the high and reports the move', (r2.state.exits.MU?.trail?.high ?? 0) > 120 && r2.stopMoved !== undefined && r2.stopMoved.from === 114, JSON.stringify(r2.stopMoved))
  const runOnce = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/runOnce.ts'), 'utf8')
  check('the host posts the old → new note', /if \(r\.stopMoved\) await post\(\{ role: 'system'/.test(runOnce))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
