/**
 * What the model is told about a symbol, computed in code: minutes since the
 * open, the first-15-minute
 * range, % from the open, % vs VWAP, ATR-14, the average daily range with its
 * trail floor, and days to the next earnings report for held names.
 *
 * Run: `npm run check -- technicals-context`
 */
import { analyzeSymbol } from '@core/runner/indicators'
import { analysisBlock, dailyRangeOf, type SymbolContext } from '@core/runner/marketContext'
import { etDateTime } from '@shared/marketTime'
import type { Bar } from '@core/robinhood/api'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const day: Bar[] = Array.from({ length: 30 }, (_, i) => ({ t: Math.floor(etDateTime('2026-08-03', 16 * 60).getTime() / 1000) + i * 86_400, o: 100, h: 103, l: 99, c: 101, v: 1_000 }))
// Five-minute bars from 09:30 to 10:25 ET on the session day: the first three (15 min) span 100–104, then a run to 110.
const open = Math.floor(etDateTime('2026-09-03', 9 * 60 + 30).getTime() / 1000)
const intra: Bar[] = Array.from({ length: 12 }, (_, i) => ({ t: open + i * 300, o: 100 + i, h: i < 3 ? 104 : 100 + i + 1, l: i < 3 ? 100 : 100 + i, c: 100 + i + 0.5, v: 500 }))
const a = analyzeSymbol('MU', day, intra, 100)
check('minutes since the open come from the last bar', a.minutesSinceOpen === 55, `${a.minutesSinceOpen}`)
check('the first-15-minute range is the opening range', a.openingRange?.high === 104 && a.openingRange?.low === 100, JSON.stringify(a.openingRange))
check('% from the open is measured from the day open', a.fromOpenPct !== null && Math.abs(a.fromOpenPct - 11.5) < 1e-9, `${a.fromOpenPct}`)
check('% vs VWAP is measured against VWAP', a.vsVwapPct !== null && a.vwap !== null && Math.abs(a.vsVwapPct - ((a.last! - a.vwap) / a.vwap) * 100) < 1e-9)
check('ATR-14 and ADR% exclude the session in progress', a.atr14 !== null && a.dailyRangePct !== null && Math.abs(a.dailyRangePct - (4 / 101) * 100) < 1e-9, `${a.dailyRangePct}`)
const ctx: SymbolContext = { analyses: [{ ...a, daysToEarnings: 2 }], earnings: [], warnings: [] }
const block = analysisBlock(ctx)
check('the block renders every new figure', ['from open', 'vs VWAP', 'ATR14', 'ADR', 'trail floor', 'min since open', 'first-15-min range', 'earnings in 2 days'].every((s) => block.includes(s)), block)
check('dailyRangeOf reads a symbol\'s range for the trail floor', dailyRangeOf(ctx, 'MU') === a.dailyRangePct && dailyRangeOf(ctx, 'AMD') === null)
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
