/**
 * The stats sheet's Risk panel and the failed-retirement card.
 *
 * `riskPanel` is pure and shared: largest position as % of allocation, cash %,
 * the symbols that would carry an intraday exit overnight, each trail's width
 * and distance to its stop, and opening-window buys this week. The stats sheet
 * renders it.
 *
 * Run: `npm run check -- risk-panel`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { emptyLedger, initialState, riskPanel, type AgentState } from '@shared/agents'
import { etClock, etDateTime } from '@shared/marketTime'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const now = etDateTime('2026-09-03', 14 * 60).getTime()
const state: AgentState = {
  ...initialState({ allocationUsd: 10_000 }),
  paper: {
    ...emptyLedger(4_000),
    positions: [{ symbol: 'MU', qty: 30, avgCost: 100 }, { symbol: 'AMD', qty: 40, avgCost: 50 }],
    fills: [
      { id: 'a', ts: etDateTime('2026-09-01', 9 * 60 + 35).toISOString(), symbol: 'MU', side: 'buy', qty: 10, price: 100, realized: 0 },
      { id: 'b', ts: etDateTime('2026-09-02', 9 * 60 + 40).toISOString(), symbol: 'MU', side: 'buy', qty: 10, price: 100, realized: 0 },
      { id: 'c', ts: etDateTime('2026-09-02', 10 * 60 + 40).toISOString(), symbol: 'MU', side: 'buy', qty: 10, price: 100, realized: 0 },
      { id: 'd', ts: etDateTime('2026-08-20', 9 * 60 + 35).toISOString(), symbol: 'AMD', side: 'buy', qty: 40, price: 50, realized: 0 }
    ]
  },
  exits: { MU: { trail: { pct: 2, high: 110 }, setAt: 'x' }, AMD: { stop: 45, flattenAt: '15:55', setAt: 'x' } }
}
const r = riskPanel({ mode: 'paper', allocationUsd: 10_000 }, state, { MU: 110, AMD: 50 }, (iso) => etClock(new Date(iso)).minutes, now)
check('largest position is MU at 33% of allocation', r.largestSymbol === 'MU' && r.largestPositionPct === 33, `${r.largestSymbol} ${r.largestPositionPct}`)
check('cash % of allocation', r.cashPct === 40)
check('MU (trail, no flatten) would carry overnight; AMD (flattenAt) would not', r.overnightCarry.join() === 'MU')
check('the trail row says its width and distance to the stop', r.trails[0]?.symbol === 'MU' && r.trails[0].trailPct === 2 && r.trails[0].stopDistancePct === 2, JSON.stringify(r.trails))
check('opening-window buys this week: two (the 08-20 one is older)', r.openingWindowBuysThisWeek === 2, `${r.openingWindowBuysThisWeek}`)
const sheet = readFileSync(resolve(import.meta.dirname, '../../src/renderer/src/components/sheets/AgentStatsSheet.tsx'), 'utf8')
check('the stats sheet renders a Risk section from riskPanel', /<Section title="Risk"[\s>]/.test(sheet) && /riskPanel\(cfg, state/.test(sheet))
const thread = readFileSync(resolve(import.meta.dirname, '../../src/renderer/src/components/thread/ThreadView.tsx'), 'utf8')
check('a failed retirement pins a red card that is not an ask', /Could not retire — positions still open/.test(thread) && /var\(--tint-down\)[\s\S]{0,200}var\(--color-down\)/.test(thread) && /startsWith\('⚠️ Retirement due'\)/.test(thread))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
