/**
 * An engine exit's card carries the level that fired, the fill, and the dollars
 * between them — frozen at the fill.
 *
 * "The stop was at $340 and it filled at $338.20" is the question the operator
 * asks afterwards, and nothing on the card recorded it: `reason` is prose and
 * `refPrice` is the quote side, not the level. `TradeAction.exitTrigger` is
 * set ONLY on engine-initiated sells, by `enforceExits` → `executeTrade`, and
 * the desktop ActionCard renders it.
 *
 * Run: `npm run check -- exit-trigger`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, emptyLedger, initialState, type AgentConfig, type AgentState, type ExitPlan } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { enforceExits, executeTrade } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const cfg = { id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null } as unknown as AgentConfig
const holding = (plan: ExitPlan): AgentState => ({ ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(9_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }] }, exits: { MU: plan } })
const now = etDateTime('2026-09-03', 11 * 60)

async function main(): Promise<void> {
  // The stop is 95; the market has gapped through it: bid 93.80. The paper fill
  // is the bid less 2 bps of slippage — a fill WORSE than the level.
  const q: Quote[] = [{ symbol: 'MU', last: 93.9, bid: 93.8, ask: 94, ts: 'x' }]
  const ex = await enforceExits({ config: cfg, state: holding({ stop: 95, setAt: 'x' }), rh: null, accountNumber: null, quotes: q, now })
  const a = ex.results[0]?.action
  check('the sell fired', a?.status === 'filled')
  check('the card carries the trigger kind and level', a?.exitTrigger?.kind === 'stop' && a?.exitTrigger?.level === 95, JSON.stringify(a?.exitTrigger))
  const expected = Math.round((95 - (a?.fillPrice ?? 0)) * 10 * 100) / 100
  check('slippage is (level − fill) × shares, in dollars, positive = worse', a?.exitTrigger?.slippageUsd === expected && expected > 0, `fill ${a?.fillPrice} → $${a?.exitTrigger?.slippageUsd}`)
  check('a trail names itself', (await enforceExits({ config: cfg, state: holding({ trail: { pct: 5, high: 110 }, setAt: 'x' }), rh: null, accountNumber: null, quotes: q, now })).results[0]?.action.exitTrigger?.kind === 'trail')
  const target = await enforceExits({ config: cfg, state: holding({ target: 93, setAt: 'x' }), rh: null, accountNumber: null, quotes: q, now })
  check('a target that fills BETTER than its level shows negative slippage', (target.results[0]?.action.exitTrigger?.slippageUsd ?? 1) < 0)
  const plain = await executeTrade({ config: cfg, state: holding({ stop: 95, setAt: 'x' }), rh: null, accountNumber: null, quotes: q, now }, { side: 'sell', symbol: 'MU', qty: 10, type: 'market', tif: 'day', reason: 'x' })
  check('a MODEL sell carries no trigger — the field means "the engine did this"', plain.action.exitTrigger === undefined)

  const card = readFileSync(resolve(import.meta.dirname, '../../src/renderer/src/components/thread/MessageItem.tsx'), 'utf8')
  check('the desktop ActionCard renders trigger, fill and slippage', /a\.exitTrigger/.test(card) && /triggered at/.test(card) && /slippage/.test(card))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
