import type { Mode, RunRecord } from './agents'
import { addDays, etClock } from './marketTime'

/**
 * The portfolio as a TIME SERIES — the one thing the book alone cannot show.
 *
 * Every run already leaves `RunRecord.book` (equity, cash, realized as the run
 * ended). `dailyRowsFromRuns` keeps the LAST such book per agent per ET day,
 * plus the agent's allocation; this module turns those rows into a portfolio
 * line and the numbers around it.
 *
 * THE SERIES IS P&L, NOT EQUITY. Summed equity registers creating a $10,000
 * paper agent as a +$10,000 day and deleting one as a crash; allocation is a
 * flow, not performance. So the default metric is `equity − allocation`, per
 * agent, summed. Equity is still carried for the secondary number.
 *
 * ABSENT IS NOT ZERO. A day with no row for any agent is a GAP (no point),
 * never a flat $0. An agent counts from its first row on — retired agents
 * included, because "all time" means the ones you stopped, too — and is
 * carried forward across days it did not run, with the point saying how many
 * of its agents were carried rather than measured.
 *
 * Pure and Node-free. Geometry included on purpose: the chart is drawn from
 * these path strings, so there is no charting dependency to keep in step.
 */

/** One agent's book at the end of one ET day. */
export interface TimelineRow {
  agentId: string
  /** yyyy-mm-dd, ET. */
  day: string
  /** ISO instant of the run that produced this value (the day's last). */
  at: string
  mode: Mode
  equity: number
  cash: number
  realized: number
  /** The agent's allocation that day. Null when unknown (an agent deleted before the history existed): it then counts in `equity` and not in `pnl`. */
  allocation: number | null
  /** False when part of `equity` is cost basis (a symbol had no quote). */
  marked: boolean
}

export type TimelineRange = '1W' | '1M' | '3M' | '1Y' | 'ALL'
export const TIMELINE_RANGES: TimelineRange[] = ['1W', '1M', '3M', '1Y', 'ALL']
export const TIMELINE_RANGE_LABEL: Record<TimelineRange, string> = { '1W': '1W', '1M': '1M', '3M': '3M', '1Y': '1Y', ALL: 'All' }
export type TimelineMetric = 'pnl' | 'equity'

/** One day of the whole portfolio: every agent's last known book that day, carried forward. */
export interface TimelinePoint {
  day: string
  /** Σ (equity − allocation) over agents with a known allocation. The number the line draws. */
  pnl: number
  equity: number
  cash: number
  realized: number
  /** Σ allocation over the agents counted in `pnl`. */
  allocation: number
  /** Agents contributing (from each one's first row on). */
  agents: number
  /** How many of those had NO row this day and were carried forward from an earlier one. 0 = every contributor was measured today. */
  carried: number
  /** Contributors with a null allocation — in `equity`, not in `pnl`. */
  unallocated: number
  /** False when any contributing book was partly at cost that day. */
  marked: boolean
}

/** Change over one window, from the last point on or before its start to the newest point. */
export interface PeriodStat {
  /** The baseline point's day, or null when there are no points at all. */
  fromDay: string | null
  start: number
  end: number
  change: number
  /** Fraction of the allocation at the END (0.012 = +1.2%). Null when there is no allocation to measure against. */
  changePct: number | null
}

export interface TimelineStats {
  /** Since the previous point (the last trading day before the newest). */
  day: PeriodStat
  week: PeriodStat
  month: PeriodStat
  year: PeriodStat
  all: PeriodStat
  high: { day: string; value: number } | null
  low: { day: string; value: number } | null
  /** Largest one-day gain / loss inside the range, in dollars. */
  bestDay: { day: string; change: number } | null
  worstDay: { day: string; change: number } | null
}

export interface Timeline {
  range: TimelineRange
  metric: TimelineMetric
  /** Points inside the range (plus the baseline point before it), oldest first. */
  points: TimelinePoint[]
  /** The whole series (the stats look further back than the range). */
  all: TimelinePoint[]
  stats: TimelineStats
  /** True when there is nothing to draw (fewer than two points in the range). */
  empty: boolean
  /** True when any point in the range was partly at cost — the chart footnotes it. */
  partlyAtCost: boolean
}

const r2 = (n: number): number => Math.round(n * 100) / 100
export const metricOf = (p: TimelinePoint, metric: TimelineMetric): number => (metric === 'pnl' ? p.pnl : p.equity)

/**
 * The daily reduction: the LAST run of each ET day per agent, from run
 * records. Runs without a book (skipped ticks, older records) contribute
 * nothing — a gap, not a zero. `allocationOf` supplies the agent's allocation.
 */
export function dailyRowsFromRuns(runs: readonly RunRecord[], allocationOf: (agentId: string) => number | null): TimelineRow[] {
  const best = new Map<string, TimelineRow>()
  for (const r of runs) {
    if (!r.book) continue
    const at = r.endedAt || r.startedAt
    const day = etClock(new Date(at)).date
    const key = `${r.agentId}|${day}`
    const cur = best.get(key)
    if (cur && cur.at >= at) continue
    best.set(key, { agentId: r.agentId, day, at, mode: r.book.mode, equity: r.book.equity, cash: r.book.cash, realized: r.book.realizedPnl, allocation: allocationOf(r.agentId), marked: r.book.marked })
  }
  return [...best.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.agentId < b.agentId ? -1 : 1))
}

/** Calendar arithmetic on yyyy-mm-dd without a timezone (the day is already ET). */
export function shiftMonths(day: string, months: number): string {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7)) - 1 + months
  const d = Number(day.slice(8, 10))
  const t = new Date(Date.UTC(y, m, 1))
  // Clamp the day to the target month's length (Mar 31 − 1 month = Feb 28).
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  t.setUTCDate(Math.min(d, last))
  return t.toISOString().slice(0, 10)
}

export function rangeStart(range: TimelineRange, today: string): string | null {
  switch (range) {
    case '1W':
      return addDays(today, -7)
    case '1M':
      return shiftMonths(today, -1)
    case '3M':
      return shiftMonths(today, -3)
    case '1Y':
      return shiftMonths(today, -12)
    case 'ALL':
      return null
  }
}

export interface SeriesOptions {
  /** Which books to fold. NEVER 'all' on a surface that separates paper from live. */
  mode: Mode | 'all'
  /** Restrict to these agents (a per-agent curve later, for free). */
  agentIds?: readonly string[]
}

/**
 * Fold per-agent rows into one portfolio point per day, carrying each agent's
 * last known book forward across days it did not run. Only days that have at
 * least one row become points; everything else is a gap.
 */
export function portfolioSeries(rows: readonly TimelineRow[], opts: SeriesOptions): TimelinePoint[] {
  const keep = (r: TimelineRow): boolean => (opts.mode === 'all' || r.mode === opts.mode) && (!opts.agentIds || opts.agentIds.includes(r.agentId))
  const byAgent = new Map<string, TimelineRow[]>()
  const days = new Set<string>()
  for (const r of rows) {
    if (!keep(r)) continue
    days.add(r.day)
    const list = byAgent.get(r.agentId)
    if (list) list.push(r)
    else byAgent.set(r.agentId, [r])
  }
  for (const list of byAgent.values()) list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.at < b.at ? -1 : 1))
  const cursors = new Map<string, number>()
  const points: TimelinePoint[] = []
  for (const day of [...days].sort()) {
    let pnl = 0
    let equity = 0
    let cash = 0
    let realized = 0
    let allocation = 0
    let agents = 0
    let carried = 0
    let unallocated = 0
    let marked = true
    for (const [id, list] of byAgent) {
      let i = cursors.get(id) ?? -1
      while (i + 1 < list.length && list[i + 1].day <= day) i++
      cursors.set(id, i)
      if (i < 0) continue
      const row = list[i]
      agents++
      if (row.day !== day) carried++
      equity += row.equity
      cash += row.cash
      realized += row.realized
      if (row.allocation !== null) {
        pnl += row.equity - row.allocation
        allocation += row.allocation
      } else unallocated++
      if (!row.marked) marked = false
    }
    points.push({ day, pnl: r2(pnl), equity: r2(equity), cash: r2(cash), realized: r2(realized), allocation: r2(allocation), agents, carried, unallocated, marked })
  }
  return points
}

function periodStat(all: readonly TimelinePoint[], sinceDay: string | null, metric: TimelineMetric): PeriodStat {
  if (!all.length) return { fromDay: null, start: 0, end: 0, change: 0, changePct: null }
  const end = all[all.length - 1]
  let base: TimelinePoint | undefined
  if (sinceDay === null) base = all[0]
  else {
    // The last point ON OR BEFORE the window's start is the baseline: the
    // portfolio when the window began. Nothing that old yet → the first point
    // we have, which understates nothing and invents nothing.
    for (const p of all) if (p.day <= sinceDay) base = p
    base ??= all[0]
  }
  const start = metricOf(base, metric)
  const finish = metricOf(end, metric)
  const change = r2(finish - start)
  // Percent against the CAPITAL AT WORK, not against a P&L figure — a move
  // from −$50 to +$50 is not "+200%", it is $100 on whatever was allocated.
  const denom = metric === 'pnl' ? end.allocation : start
  return { fromDay: base.day, start, end: finish, change, changePct: denom > 0 ? change / denom : null }
}

export function buildTimeline(rows: readonly TimelineRow[], opts: { range: TimelineRange; today: string; mode: Mode | 'all'; metric?: TimelineMetric; agentIds?: readonly string[] }): Timeline {
  const metric = opts.metric ?? 'pnl'
  const all = portfolioSeries(rows, { mode: opts.mode, agentIds: opts.agentIds })
  const from = rangeStart(opts.range, opts.today)
  // Include the baseline point (the last one before the range) so the line
  // starts where the window began rather than at the first day inside it.
  let startIdx = 0
  if (from !== null) {
    startIdx = all.findIndex((p) => p.day >= from)
    if (startIdx === -1) startIdx = Math.max(0, all.length - 1)
    else if (startIdx > 0) startIdx--
  }
  const points = all.slice(startIdx)
  const prev = all.length >= 2 ? all[all.length - 2].day : null
  let high: TimelineStats['high'] = null
  let low: TimelineStats['low'] = null
  let bestDay: TimelineStats['bestDay'] = null
  let worstDay: TimelineStats['worstDay'] = null
  points.forEach((p, i) => {
    const v = metricOf(p, metric)
    if (!high || v > high.value) high = { day: p.day, value: v }
    if (!low || v < low.value) low = { day: p.day, value: v }
    if (i > 0) {
      const change = r2(v - metricOf(points[i - 1], metric))
      if (!bestDay || change > bestDay.change) bestDay = { day: p.day, change }
      if (!worstDay || change < worstDay.change) worstDay = { day: p.day, change }
    }
  })
  return {
    range: opts.range,
    metric,
    points,
    all,
    stats: {
      day: periodStat(all, prev, metric),
      week: periodStat(all, addDays(opts.today, -7), metric),
      month: periodStat(all, shiftMonths(opts.today, -1), metric),
      year: periodStat(all, shiftMonths(opts.today, -12), metric),
      all: periodStat(all, null, metric),
      high,
      low,
      bestDay,
      worstDay
    },
    empty: points.length < 2,
    partlyAtCost: points.some((p) => !p.marked)
  }
}

// ── Geometry ────────────────────────────────────────────────────────────────

export interface TimelineGeometry {
  width: number
  height: number
  metric: TimelineMetric
  /** Pixel x / y of every point, in order. */
  xs: number[]
  ys: number[]
  yMin: number
  yMax: number
  /** SVG path for the line. */
  linePath: string
  /** SVG path for the filled area between the line and the zero/baseline. */
  areaPath: string
  /** Pixel y of the reference the line is judged against: $0 for P&L (when in view), else the range's first value. */
  baselineY: number
  yTicks: { y: number; value: number }[]
  xTicks: { x: number; label: string }[]
  /** Whether the range ended above where it began. */
  up: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Sep 3" — the axis label for a yyyy-mm-dd day. */
export const dayLabel = (day: string): string => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`
/** "Sep 3, 2026" — for the crosshair pill. */
export const dayLabelLong = (day: string): string => `${dayLabel(day)}, ${day.slice(0, 4)}`

/** A round step for ~4 y ticks across a span. */
function niceStep(span: number): number {
  if (span <= 0) return 1
  const raw = span / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag
}

const r1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Pixel geometry for a `Timeline`. Width and height are the CALLER's (it
 * measures its container), and nothing here depends on a DOM. `pad` keeps the line off the edges so the crosshair pill
 * and the end dot have room.
 */
export function timelineGeometry(points: readonly TimelinePoint[], width: number, height: number, metric: TimelineMetric = 'pnl', pad = { top: 12, right: 12, bottom: 22, left: 8 }): TimelineGeometry {
  const n = points.length
  const innerW = Math.max(1, width - pad.left - pad.right)
  const innerH = Math.max(1, height - pad.top - pad.bottom)
  const values = points.map((p) => metricOf(p, metric))
  let lo = values.length ? Math.min(...values) : 0
  let hi = values.length ? Math.max(...values) : 0
  // P&L is read against zero, so zero stays in view when it is anywhere near.
  if (metric === 'pnl') {
    lo = Math.min(lo, 0)
    hi = Math.max(hi, 0)
  }
  if (!(hi > lo)) {
    const bump = Math.max(1, Math.abs(hi) * 0.01)
    lo -= bump
    hi += bump
  }
  const margin = (hi - lo) * 0.08
  const yMin = lo - margin
  const yMax = hi + margin
  const xOf = (i: number): number => pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const yOf = (v: number): number => pad.top + (1 - (v - yMin) / (yMax - yMin)) * innerH
  const xs = points.map((_, i) => r1(xOf(i)))
  const ys = values.map((v) => r1(yOf(v)))
  const linePath = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x} ${ys[i]}`).join(' ')
  const baselineY = r1(yOf(metric === 'pnl' ? 0 : n ? values[0] : 0))
  const areaPath = n ? `${linePath} L${xs[n - 1]} ${baselineY} L${xs[0]} ${baselineY} Z` : ''
  const step = niceStep(yMax - yMin)
  const yTicks: TimelineGeometry['yTicks'] = []
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) yTicks.push({ y: r1(yOf(v)), value: r2(v) })
  // X ticks: first, last, and up to three evenly spaced between, never crowding.
  const xTicks: TimelineGeometry['xTicks'] = []
  if (n) {
    const want = Math.min(5, n)
    const idxs = new Set<number>()
    for (let k = 0; k < want; k++) idxs.add(Math.round((k / Math.max(1, want - 1)) * (n - 1)))
    for (const i of [...idxs].sort((a, b) => a - b)) xTicks.push({ x: xs[i], label: dayLabel(points[i].day) })
  }
  return { width, height, metric, xs, ys, yMin, yMax, linePath, areaPath, baselineY, yTicks, xTicks, up: n >= 2 ? values[n - 1] >= values[0] : true }
}

/** Index of the point nearest a pixel x — the crosshair's snap. */
export function nearestPointIndex(geometry: Pick<TimelineGeometry, 'xs'>, x: number): number {
  const { xs } = geometry
  if (!xs.length) return -1
  let best = 0
  let dist = Math.abs(xs[0] - x)
  for (let i = 1; i < xs.length; i++) {
    const d = Math.abs(xs[i] - x)
    if (d < dist) {
      dist = d
      best = i
    }
  }
  return best
}

/** "+$1,234.56 (+1.23%)" / "−$12.00 (−0.10%)" — the stat strip's value. */
export function formatChange(stat: PeriodStat): string {
  return `${signedMoney(stat.change)}${stat.changePct === null ? '' : ` (${signedPct(stat.changePct)})`}`
}

export function signedMoney(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function signedPct(fraction: number): string {
  return `${fraction > 0 ? '+' : fraction < 0 ? '−' : ''}${(Math.abs(fraction) * 100).toFixed(2)}%`
}
