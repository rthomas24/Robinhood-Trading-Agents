/**
 * The scorecard tells the truth about one agent's own book, and says which
 * kind of book it is.
 *
 * `trackRecord` is the ONE place the stats sheet and the scorecard get win
 * rate, profit factor and P&L from. Before it, the maths lived in the stats
 * sheet and nothing else could show or share it. So this pins the
 * arithmetic against a hand-computed ledger — fills fed out of order, an open
 * position marked with and without a quote — and the two lines of the text
 * that are not allowed to go missing: the PAPER/LIVE label, and the sentence
 * that says a record is not a forecast.
 *
 * Run: `npm run check -- scorecard`
 */
import { emptyLedger, type Fill, type Ledger, type Schedule } from '@shared/agents'
import { daysSince, fleetScorecardText, scorecardText, trackRecord } from '@shared/scorecard'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

const t0 = Date.UTC(2026, 8, 1, 14, 0)
const at = (min: number): string => new Date(t0 + min * 60_000).toISOString()
const fill = (id: string, min: number, symbol: string, side: 'buy' | 'sell', qty: number, price: number, realized = 0): Fill => ({ id, ts: at(min), symbol, side, qty, price, realized })

// 10 MU bought at 100 and sold at 110 (+100); 5 NVDA bought at 200 and sold at 190 (−50); 2 SPY at 500 still open.
// Cash: 10,000 − 1,000 + 1,100 − 1,000 + 950 − 1,000 = 9,050. Realized: +50.
const ledger: Ledger = {
  ...emptyLedger(9_050),
  realizedPnl: 50,
  positions: [{ symbol: 'SPY', qty: 2, avgCost: 500 }],
  // Deliberately out of order: the record must sort by time itself.
  fills: [fill('f4', 40, 'NVDA', 'sell', 5, 190, -50), fill('f1', 10, 'MU', 'buy', 10, 100), fill('f5', 50, 'SPY', 'buy', 2, 500), fill('f2', 20, 'MU', 'sell', 10, 110, 100), fill('f3', 30, 'NVDA', 'buy', 5, 200)]
}
const schedule: Schedule = { kind: 'times', times: ['15:58', '09:31'], days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], tradingDaysOnly: true }
const cfg = { name: 'MU Overnight', mode: 'paper' as const, allocationUsd: 10_000, createdAt: at(0), schedule }

const marked = trackRecord(cfg, ledger, { SPY: 510 })
check('fills come back oldest first whatever order the ledger held them', marked.fills.map((f) => f.id).join() === 'f1,f2,f3,f4,f5')
check('two sells, one win, one loss', marked.sells.length === 2 && marked.wins.length === 1 && marked.losses.length === 1)
check('win rate 50%, profit factor 2.0', marked.winRate === 0.5 && marked.profitFactor === 2)
check('best +100, worst −50', marked.best === 100 && marked.worst === -50)
check('volume is notional on both sides', near(marked.volume, 5_050), String(marked.volume))
check('open SPY marked at the quote: +20 unrealized, value 1,020', marked.positions.length === 1 && near(marked.positions[0].unrealized, 20) && near(marked.positions[0].value, 1_020))
check('equity = cash + market value', near(marked.equity, 10_070), String(marked.equity))
check('total = realized + unrealized, return over allocation', near(marked.totalPnl, 70) && near(marked.retPct, 0.007))
check('curve starts at creation and steps once per sell', marked.curve.length === 3 && marked.curve[0].v === 0 && marked.curve[1].v === 100 && marked.curve[2].v === 50)
check('by symbol: best realized first, flat symbol before the loser', marked.bySymbol.map((r) => r.symbol).join() === 'MU,SPY,NVDA')

const unmarked = trackRecord(cfg, ledger)
check('no quote → marked at cost, zero unrealized, equity = cash + cost', near(unmarked.unrealized, 0) && near(unmarked.equity, 10_050))

const now = t0 + 14 * 86_400_000 + 3_600_000
const text = scorecardText(cfg, marked, now)
const lines = text.split('\n')
check('seven lines', lines.length === 7, String(lines.length))
check('names the agent and says PAPER on the first line', lines[0].includes('MU Overnight') && lines[0].includes('PAPER') && lines[0].includes('14 days'))
check('headline P&L line carries total, percent and allocation', lines[1].includes('+$70.00') && lines[1].includes('+0.7%') && lines[1].includes('$10,000'))
check('record line: 1W / 1L, 50%, PF 2.00', lines[2].includes('1W / 1L') && lines[2].includes('50%') && lines[2].includes('2.00'))
check('open position line shows qty, symbol, cost and unrealized', lines[4].includes('2 SPY @ $500.00 (+$20.00)'))
check('schedule line is the shared description', lines[5].startsWith('Runs: ') && lines[5].includes('3:58 PM'))
check('paper footer says what a paper fill is and that the past is not a forecast', /simulated fills/.test(lines[6]) && /not a forecast/.test(lines[6]))

const live = scorecardText({ ...cfg, mode: 'live' }, marked, now)
check('live scorecard says LIVE and names the sub-ledger', live.includes('LIVE') && /own sub-ledger/.test(live) && !/PAPER/.test(live))

const empty = trackRecord(cfg, emptyLedger(10_000))
check('empty book: no win rate, no profit factor, zero everything', empty.winRate === null && empty.profitFactor === null && empty.totalPnl === 0 && empty.curve.length === 1)
const emptyText = scorecardText(cfg, empty, t0 + 60_000)
check('empty book text: no closed trades, flat, and a day old at most', emptyText.includes('No closed trades yet.') && emptyText.includes('Open: flat') && emptyText.includes('1 day'))
check('daysSince never reports zero', daysSince(at(0), t0 + 1_000) === 1 && daysSince(at(0), t0 + 3 * 86_400_000) === 3)

// ------------------------------------------------------------- the fleet
const fleet = {
  rows: [
    { name: 'A', retired: false, totalPnl: 120, realizedPnl: 100, trades: 8, marked: true },
    { name: 'B', retired: true, totalPnl: -40, realizedPnl: -40, trades: 3, marked: true },
    { name: 'C', retired: false, totalPnl: 5, realizedPnl: 0, trades: 1, marked: false }
  ],
  totalEquity: 30_085,
  totalAllocated: 30_000,
  totalPnl: 85,
  totalPct: 85 / 30_000,
  dayPnl: 12,
  realizedPnl: 60,
  marked: false,
  unmarked: ['SPY']
}
const ft = fleetScorecardText('paper', fleet, now).split('\n')
check('fleet text: header counts active and retired and says PAPER', ft[0].includes('3 paper agents') && ft[0].includes('2 active, 1 retired'))
check('fleet text: totals line carries all-time, realized, today and the at-cost caveat', ft[1].includes('+$85.00') && ft[1].includes('+$60.00') && ft[1].includes('+$12.00') && ft[1].includes('1 holding at cost'))
check('fleet text: agents best first, retired and at-cost flagged', ft[2].startsWith('• A:') && ft[3].includes('C') && ft[3].includes('at cost') && ft[4].includes('B (retired)'))
check('fleet text: paper footer', /simulated fills/.test(ft[ft.length - 1]) && /not a forecast/.test(ft[ft.length - 1]))
const flt = fleetScorecardText('live', { ...fleet, rows: fleet.rows.map((r) => ({ ...r, marked: true })), marked: true, unmarked: [] }, now)
check('fleet text (live): says LIVE, own fills only, no at-cost caveat', /live agents/.test(flt) && /own fills only/.test(flt) && !/at cost/.test(flt))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
