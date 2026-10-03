/**
 * A buy that re-enters a name just sold at a loss says so on its card:
 * "re-entering MU, N min after a −$Y stop-out". Frozen onto the action at the
 * fill, rendered by the ActionCard.
 *
 * Run: `npm run check -- reentry-card`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, emptyLedger, initialState, type AgentConfig, type AgentState } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { executeTrade } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const now = etDateTime('2026-09-03', 11 * 60)
const cfg = { id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null } as unknown as AgentConfig
const lostAt = (minutesAgo: number): AgentState => ({ ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(10_000), fills: [{ id: 'f1', ts: new Date(now.getTime() - minutesAgo * 60_000).toISOString(), symbol: 'MU', side: 'sell', qty: 5, price: 95, realized: -41.2 }] } })
const q: Quote[] = [{ symbol: 'MU', last: 100, bid: 99.9, ask: 100, ts: 'x' }]
async function main(): Promise<void> {
  const r = await executeTrade({ config: cfg, state: lostAt(12), rh: null, accountNumber: null, quotes: q, now }, { side: 'buy', symbol: 'MU', qty: 5, type: 'market', tif: 'day', reason: 'x' })
  check('a buy 12 min after a −$41.20 sell carries the re-entry', r.action.reentry?.minutesAfter === 12 && r.action.reentry?.lossUsd === 41.2, JSON.stringify(r.action.reentry))
  const late = await executeTrade({ config: cfg, state: lostAt(90), rh: null, accountNumber: null, quotes: q, now }, { side: 'buy', symbol: 'MU', qty: 5, type: 'market', tif: 'day', reason: 'x' })
  check('90 min later (no cooldown set → last hour) it does not', late.action.reentry === undefined)
  const cool = await executeTrade({ config: { ...cfg, guardrails: { ...cfg.guardrails, reentryCooldownMin: 120 } }, state: lostAt(90), rh: null, accountNumber: null, quotes: q, now }, { side: 'buy', symbol: 'MU', qty: 5, type: 'market', tif: 'day', reason: 'x' })
  check('with a 120-min cooldown the window follows it (and the buy is refused by it)', cool.action.reentry?.minutesAfter === 90 && cool.action.status === 'rejected' && cool.rule === 'entry.cooldown')
  const card = readFileSync(resolve(import.meta.dirname, '../../src/renderer/src/components/thread/MessageItem.tsx'), 'utf8')
  check('the desktop card says it', /Re-entering \{a\.symbol\}, \{a\.reentry\.minutesAfter\} min after a −\{money\(a\.reentry\.lossUsd\)\} stop-out/.test(card))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
