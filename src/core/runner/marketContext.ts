import type { Quote } from '@shared/ipc'
import type { RobinhoodMcpClient } from '../robinhood/mcp'
import { getEarningsCalendar, getTradability, lastSessionBars, type Bar, type EarningsEntry } from '../robinhood/api'
import type { PriceFeed } from '../market/feed'
import { analyzeSymbol, type SymbolAnalysis } from './indicators'
import { trailFloorPct } from '@shared/agents'
import { etClock } from '@shared/marketTime'

/**
 * Deterministic per-symbol analysis injected into every run: indicators, day
 * stats, earnings dates, and tradability warnings — computed in code so the
 * model reasons over facts instead of burning turns fetching them.
 *
 * Bars come from whichever feed prices the run (`PriceFeed`), so a paper agent
 * on the market-data feed gets the same technicals as one on Robinhood. Earnings
 * dates and tradability are Robinhood datasets and render only when the
 * operator's grant is there — absent, not zero, and the block simply omits them.
 */
export interface SymbolContext {
  analyses: (SymbolAnalysis & { daysToEarnings?: number | null })[]
  /** e.g. "MU reports earnings Thu 2026-08-28 (after close)" */
  earnings: string[]
  /** Halts / ineligibility warnings. */
  warnings: string[]
}

function fmt(n: number | null, dp = 2): string {
  return n === null ? '—' : n.toFixed(dp)
}

// Earnings move slowly, and the calendar fetch is broad (not per-symbol) —
// one cached payload serves every agent for 6 hours.
let earningsCache: { at: number; entries: EarningsEntry[] } | null = null
const EARNINGS_TTL = 6 * 3600_000

async function cachedEarnings(c: RobinhoodMcpClient): Promise<EarningsEntry[]> {
  if (earningsCache && Date.now() - earningsCache.at < EARNINGS_TTL) return earningsCache.entries
  const entries = await getEarningsCalendar(c, 14)
  earningsCache = { at: Date.now(), entries }
  return entries
}

export async function buildSymbolContext(
  feed: PriceFeed,
  rh: RobinhoodMcpClient | null,
  accountNumber: string | null,
  symbols: string[],
  quotes: Quote[],
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
): Promise<SymbolContext> {
  const syms = symbols.slice(0, 8)
  const out: SymbolContext = { analyses: [], earnings: [], warnings: [] }
  if (!syms.length) return out
  const qmap = new Map(quotes.map((q) => [q.symbol, q]))

  // All four feeds are independent — fetch them concurrently.
  const [dayBars, intraBars, earnings, tradability] = await Promise.all([
    feed.bars(syms, new Date(Date.now() - 90 * 86_400_000).toISOString(), 'day').catch((e) => {
      log('warn', `day bars failed: ${(e as Error).message}`)
      return {} as Record<string, Bar[]>
    }),
    feed.bars(syms, new Date(Date.now() - 4 * 86_400_000).toISOString(), '5minute').catch((e) => {
      log('warn', `intraday bars failed: ${(e as Error).message}`)
      return {} as Record<string, Bar[]>
    }),
    rh
      ? cachedEarnings(rh).catch((e) => {
          log('warn', `earnings calendar failed: ${(e as Error).message}`)
          return [] as EarningsEntry[]
        })
      : Promise.resolve([] as EarningsEntry[]),
    rh && accountNumber ? getTradability(rh, accountNumber, syms).catch(() => [] as Awaited<ReturnType<typeof getTradability>>) : Promise.resolve([] as Awaited<ReturnType<typeof getTradability>>)
  ])
  const today = etClock().date
  for (const s of syms) {
    const day = dayBars[s] ?? []
    const intra = lastSessionBars(intraBars[s] ?? [])
    if (!day.length && !intra.length) continue
    // Days to the next report, on the technicals line itself: a held name two
    // days from earnings is a different position from the same name a month
    // out, and the EARNINGS AHEAD list below only says the date.
    const next = earnings.filter((e) => e.symbol === s && e.date >= today).map((e) => e.date).sort()[0]
    const daysToEarnings = next ? Math.round((Date.parse(next) - Date.parse(today)) / 86_400_000) : null
    out.analyses.push({ ...analyzeSymbol(s, day, intra, qmap.get(s)?.prevClose), daysToEarnings })
  }
  out.earnings = earnings.filter((e) => syms.includes(e.symbol)).map((e) => `${e.symbol} reports earnings ${e.date}${e.timing ? ` (${e.timing === 'am' ? 'before open' : 'after close'})` : ''}`)
  out.warnings = tradability.filter((r) => r.issue).map((r) => `${r.symbol}: ${r.issue}`)
  return out
}

/** The average daily range (%) of one symbol this run computed, for the trail floor. */
export function dailyRangeOf(ctx: SymbolContext | null, symbol: string): number | null {
  return ctx?.analyses.find((a) => a.symbol === symbol)?.dailyRangePct ?? null
}

export function analysisBlock(ctx: SymbolContext): string {
  const lines: string[] = []
  if (ctx.analyses.length) {
    lines.push('TECHNICALS (computed in code — ground truth; VWAP/range are the last session; ADR = average daily range over 14 sessions, the yardstick for any trail width):')
    const signed = (n: number, dp = 2): string => `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`
    for (const a of ctx.analyses) {
      const trend = a.ema9 !== null && a.ema21 !== null ? (a.ema9 > a.ema21 ? 'EMA9>EMA21 (up)' : 'EMA9<EMA21 (down)') : ''
      lines.push(
        `- ${a.symbol}: O ${fmt(a.dayOpen)} · H ${fmt(a.dayHigh)} · L ${fmt(a.dayLow)} · VWAP ${fmt(a.vwap)}` +
          `${a.gapPct !== null ? ` · gap ${signed(a.gapPct)}` : ''}` +
          `${a.fromOpenPct !== null ? ` · ${signed(a.fromOpenPct)} from open` : ''}` +
          `${a.vsVwapPct !== null ? ` · ${signed(a.vsVwapPct)} vs VWAP` : ''}` +
          ` · RSI14 ${fmt(a.rsi14, 0)}${trend ? ` · ${trend}` : ''}` +
          `${a.volVsAvg !== null ? ` · vol ${a.volVsAvg.toFixed(1)}x avg` : ''}` +
          `${a.atr14 !== null ? ` · ATR14 ${fmt(a.atr14)}` : ''}` +
          `${a.dailyRangePct !== null ? ` · ADR ${a.dailyRangePct.toFixed(2)}% (trail floor ${trailFloorPct(a.dailyRangePct)}%)` : ''}` +
          `${a.minutesSinceOpen !== null && a.minutesSinceOpen >= 0 ? ` · ${a.minutesSinceOpen} min since open` : ''}` +
          `${a.openingRange ? ` · first-15-min range ${fmt(a.openingRange.low)}–${fmt(a.openingRange.high)}` : ''}` +
          `${a.daysToEarnings !== null && a.daysToEarnings !== undefined ? ` · earnings in ${a.daysToEarnings} day${a.daysToEarnings === 1 ? '' : 's'}` : ''}`
      )
    }
  }
  if (ctx.earnings.length) {
    lines.push('', 'EARNINGS AHEAD (factor these into any position you hold or open):')
    for (const e of ctx.earnings) lines.push(`- ${e}`)
  }
  if (ctx.warnings.length) {
    lines.push('', 'TRADABILITY WARNINGS:')
    for (const w of ctx.warnings) lines.push(`- ${w}`)
  }
  return lines.join('\n')
}
