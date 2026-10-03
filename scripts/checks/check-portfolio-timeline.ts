/**
 * The portfolio timeline: P&L not equity, gaps not zeros, carried not invented.
 *
 * Rules pinned (shared/timeline.ts):
 *   1. The series is Σ (equity − allocation): creating a $10k agent is NOT a
 *      +$10,000 day, and an agent with a null allocation is in equity only.
 *   2. A day with no row for any agent is a GAP — no point, never $0.
 *   3. An agent is carried forward across days it did not run, and the point
 *      says how many were carried; an agent never counts before its first row.
 *   4. Modes never sum: 'paper' excludes live rows.
 *   5. Period stats measure from the last point on or before the window start;
 *      percent is against allocation, not against a P&L figure.
 *   6. `dailyRowsFromRuns` is the daily reduction: last run of the ET day.
 *   7. Geometry: explicit width/height, $0 in view for P&L, the area closes to
 *      the baseline, ticks are round, nearest-point snapping works.
 *
 * Run: `npm run check -- portfolio-timeline`
 */
import { buildTimeline, dailyRowsFromRuns, formatChange, nearestPointIndex, portfolioSeries, rangeStart, timelineGeometry, type TimelineRow } from '../../src/shared/timeline'
import type { RunRecord } from '../../src/shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const row = (agentId: string, day: string, equity: number, extra: Partial<TimelineRow> = {}): TimelineRow => ({
  agentId,
  day,
  at: `${day}T20:00:00.000Z`,
  mode: 'paper',
  equity,
  cash: equity,
  realized: 0,
  allocation: 10_000,
  marked: true,
  ...extra
})

// ------------------------------------------------------------- 1–4. the series
const rows: TimelineRow[] = [
  row('a', '2026-09-01', 10_000),
  row('a', '2026-09-02', 10_100),
  // 09-03: A did not run (carried), B is created with a fresh $10k
  row('b', '2026-09-03', 10_000),
  row('a', '2026-09-04', 10_200),
  row('b', '2026-09-04', 9_900, { marked: false }),
  // a LIVE row that must never mix into paper
  row('c', '2026-09-04', 5_000, { mode: 'live', allocation: 5_000 }),
  // an agent with no known allocation: equity only
  row('d', '2026-09-04', 1_000, { allocation: null })
]
const s = portfolioSeries(rows, { mode: 'paper' })
check('one point per day that has a row; weekends/no-run days are gaps', s.map((p) => p.day).join(',') === '2026-09-01,2026-09-02,2026-09-03,2026-09-04')
check('creating a $10k agent is a +$0 day in P&L (equity jumps, pnl does not)', s[2].pnl === 100 && s[2].equity === 20_100)
check('the day A did not run carries A forward and says so', s[2].agents === 2 && s[2].carried === 1)
check('an agent never counts before its first row', s[0].agents === 1 && s[1].agents === 1)
check('live rows never sum into paper', s[3].equity === 10_200 + 9_900 + 1_000 && !s.some((p) => p.equity > 30_000))
check('a null-allocation agent is in equity, not P&L, and is counted as unallocated', s[3].pnl === 100 && s[3].unallocated === 1)
check('a partly-at-cost book marks the whole day', s[3].marked === false && s[2].marked === true)

// ------------------------------------------------------------- 5. the stats
const tl = buildTimeline(rows, { range: '1W', today: '2026-09-04', mode: 'paper' })
check('day stat measures from the previous point', tl.stats.day.change === 0 && tl.stats.day.fromDay === '2026-09-03', JSON.stringify(tl.stats.day))
check('all-time stat measures from the first point', tl.stats.all.change === 100 && tl.stats.all.fromDay === '2026-09-01')
check('percent is against allocation at the end (100 / 20,000 = 0.5%)', tl.stats.all.changePct !== null && Math.abs(tl.stats.all.changePct - 0.005) < 1e-9)
check('best/worst day inside the range', tl.stats.bestDay?.change === 100 && tl.stats.worstDay?.change === 0, JSON.stringify([tl.stats.bestDay, tl.stats.worstDay]))
check('range start arithmetic (1M from Mar 31 clamps to Feb 28)', rangeStart('1M', '2026-03-31') === '2026-02-28' && rangeStart('1W', '2026-09-04') === '2026-08-28' && rangeStart('ALL', '2026-09-04') === null)
const wide = buildTimeline(rows, { range: '1M', today: '2026-10-01', mode: 'paper' })
check('a range includes the baseline point before its start', wide.points[0].day === '2026-09-01' || wide.points.length === 4)
check('formatChange signs the change and its percent', formatChange({ fromDay: '2026-09-01', start: 0, end: 100, change: 100, changePct: 0.005 }) === '+$100.00 (+0.50%)' && formatChange({ fromDay: 'x', start: 0, end: -12, change: -12, changePct: -0.001 }) === '−$12.00 (−0.10%)')

// ------------------------------------------------------------- 6. the reduction
const run = (agentId: string, endedAt: string, equity: number): RunRecord =>
  ({ id: `r${endedAt}`, agentId, trigger: 'schedule', startedAt: endedAt, endedAt, ok: true, model: 'x', inputTokens: 0, outputTokens: 0, toolCalls: 0, actions: 0, durationMs: 1, book: { mode: 'paper', cash: equity, realizedPnl: 0, positions: 0, fills: 0, openOrders: 0, equity, marked: true } }) as RunRecord
const daily = dailyRowsFromRuns(
  [run('a', '2026-09-03T13:31:00Z', 1), run('a', '2026-09-03T19:58:00Z', 2), run('a', '2026-09-04T01:30:00Z', 3), { ...run('a', '2026-09-04T14:00:00Z', 9), book: undefined } as RunRecord],
  () => 10_000
)
check('last run of the ET day wins (21:30 ET is still Sep 3; a bookless run adds nothing)', daily.length === 1 && daily[0].day === '2026-09-03' && daily[0].equity === 3, JSON.stringify(daily))

// ------------------------------------------------------------- 7. geometry
const g = timelineGeometry(tl.points, 600, 200, 'pnl')
check('geometry uses the caller\'s width/height', g.width === 600 && g.height === 200 && g.xs.length === tl.points.length)
check('$0 stays in view for P&L and the area closes to it', g.yMin < 0 && g.yMax > 0 && g.areaPath.endsWith(`${g.baselineY} Z`))
check('the line path has one segment per point', g.linePath.split(' L').length === tl.points.length)
check('nearest-point snapping', nearestPointIndex(g, g.xs[2] + 1) === 2 && nearestPointIndex(g, -100) === 0)
check('y ticks are round numbers', g.yTicks.every((t) => Number.isInteger(t.value * 100) && t.value % 1 === 0 || Math.abs(t.value) < 1))

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exitCode = failures ? 1 : 0
