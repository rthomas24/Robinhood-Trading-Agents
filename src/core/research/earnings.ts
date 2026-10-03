import { EARNINGS_POP, REPORT_WINDOW_LABEL, nextTradingDay, reportWindow, type ReportWindow } from '@shared/earningsPlaybook'
import { addDays, etClock } from '@shared/marketTime'
import type { Quote } from '@shared/ipc'
import {
  dailyBarDate,
  getAnalystRatings,
  getBarsBatch,
  getEarningsReports,
  getEarningsResults,
  getFinancials,
  getFundamentals,
  getImpliedMove,
  getQuotes,
  type AnalystRatings,
  type Bar,
  type EarningsReport,
  type FinancialPeriod,
  type Fundamentals,
  type ImpliedMove
} from '../robinhood/api'
import type { RobinhoodMcpClient } from '../robinhood/mcp'

/**
 * Earnings research, computed in code and handed to the model as FACTS.
 *
 * The all-in earnings mode (`shared/earningsPlaybook.ts`) lives or dies on one
 * judgment a night, so the agent gets the evidence a careful analyst would
 * assemble before it — not a web search and a hunch:
 *
 *   - how THIS stock has actually traded on its last eight reports (the gap at
 *     the next open, which is exactly the move this mode sells into), against
 *     how much it beat or missed by;
 *   - what the options market is pricing for this report (the at-the-money
 *     straddle), against the moves it has really made — the market's own
 *     estimate is the bar a pick has to clear;
 *   - revenue growth and margin trend from reported financials, analyst
 *     targets, and how the stock has run INTO the print.
 *
 * Every number is computed here, because a model reading two columns of
 * prices will not reliably subtract them. The qualitative side — the news,
 * the guidance chatter, the crowd — is the model's, through the web-research
 * tools; the dossier says which to call.
 *
 * Everything reads Robinhood. With no broker connection there is no earnings
 * data to read, and the tools say so instead of guessing.
 */

// ── Pure: reactions ─────────────────────────────────────────────────────────

export interface EarningsReaction {
  date: string
  timing?: 'am' | 'pm'
  /** Close before the report. */
  before: number
  /** (next open − close before) / close before, %. The gap this mode sells into. */
  gapPct: number
  /** (reaction-day close − close before) / close before, %. */
  dayPct: number
  /** EPS surprise vs the estimate, %; null without both numbers. */
  surprisePct: number | null
  /** % move over the five sessions INTO the report (close five bars earlier → close before). */
  runUpPct: number | null
}

/**
 * The price reaction to one report, from daily bars (dated by their own
 * session — `dailyBarDate`). An after-close report reacts on the NEXT session;
 * a before-open one on its own date. Null when the bars do not reach it.
 */
export function reactionFor(report: EarningsReport, bars: Bar[]): EarningsReaction | null {
  if (report.epsActual === null) return null
  const dated = bars.map((b) => ({ d: dailyBarDate(b), b }))
  let preIdx: number
  let reactIdx: number
  if (report.timing === 'am') {
    reactIdx = dated.findIndex((x) => x.d === report.date)
    preIdx = reactIdx - 1
  } else {
    // pm, or unknown timing: read it as after the close (the common case).
    preIdx = dated.findIndex((x) => x.d === report.date)
    reactIdx = preIdx >= 0 ? preIdx + 1 : -1
  }
  if (preIdx < 0 || reactIdx < 0 || reactIdx >= dated.length) return null
  const before = dated[preIdx].b.c
  const react = dated[reactIdx].b
  if (!(before > 0)) return null
  const five = dated[preIdx - 5]?.b.c
  const surprisePct = report.epsEstimate !== null && report.epsEstimate !== 0 ? ((report.epsActual - report.epsEstimate) / Math.abs(report.epsEstimate)) * 100 : null
  return {
    date: report.date,
    ...(report.timing ? { timing: report.timing } : {}),
    before,
    gapPct: ((react.o - before) / before) * 100,
    dayPct: ((react.c - before) / before) * 100,
    surprisePct,
    runUpPct: five && five > 0 ? ((before - five) / five) * 100 : null
  }
}

export interface ReactionStats {
  n: number
  /** Reports whose next open gapped up. */
  gapUps: number
  avgGapPct: number
  /** Mean absolute gap — the size of move this stock usually makes on a print. */
  avgAbsGapPct: number
  /** Beats (actual > estimate) among the reports with both numbers. */
  beats: number
  withEstimate: number
  /** Of the beats, how many gapped UP — does beating even get paid here? */
  beatsGapUp: number
  bestGapPct: number
  worstGapPct: number
}

export function reactionStats(rs: EarningsReaction[]): ReactionStats | null {
  if (!rs.length) return null
  const beats = rs.filter((r) => r.surprisePct !== null && r.surprisePct > 0)
  return {
    n: rs.length,
    gapUps: rs.filter((r) => r.gapPct > 0).length,
    avgGapPct: rs.reduce((s, r) => s + r.gapPct, 0) / rs.length,
    avgAbsGapPct: rs.reduce((s, r) => s + Math.abs(r.gapPct), 0) / rs.length,
    beats: beats.length,
    withEstimate: rs.filter((r) => r.surprisePct !== null).length,
    beatsGapUp: beats.filter((r) => r.gapPct > 0).length,
    bestGapPct: Math.max(...rs.map((r) => r.gapPct)),
    worstGapPct: Math.min(...rs.map((r) => r.gapPct))
  }
}

export interface SetupStats {
  ret5Pct: number | null
  ret20Pct: number | null
  vsSma20Pct: number | null
  vsSma50Pct: number | null
  fromHigh52Pct: number | null
}

/** How the stock is trading into the report, from daily closes and the live price. */
export function setupStats(bars: Bar[], price: number, high52: number | null): SetupStats {
  const closes = bars.map((b) => b.c)
  const back = (n: number): number | null => (closes.length > n ? closes[closes.length - 1 - n] : null)
  const pct = (a: number, b: number | null): number | null => (b && b > 0 ? ((a - b) / b) * 100 : null)
  const sma = (n: number): number | null => (closes.length >= n ? closes.slice(-n).reduce((s, c) => s + c, 0) / n : null)
  return { ret5Pct: pct(price, back(5)), ret20Pct: pct(price, back(20)), vsSma20Pct: pct(price, sma(20)), vsSma50Pct: pct(price, sma(50)), fromHigh52Pct: pct(price, high52) }
}

/** Revenue growth and margin trend from quarterly financials (newest first, as the tool returns them). */
export function financialTrend(q: FinancialPeriod[]): { revYoYPct: number | null; revQoQPct: number | null; marginNow: number | null; marginYearAgo: number | null } {
  const rev = (i: number): number | null => q[i]?.revenue ?? null
  const g = (a: number | null, b: number | null): number | null => (a !== null && b !== null && b > 0 ? ((a - b) / b) * 100 : null)
  return { revYoYPct: g(rev(0), rev(4)), revQoQPct: g(rev(0), rev(1)), marginNow: q[0]?.netMargin ?? null, marginYearAgo: q[4]?.netMargin ?? null }
}

/** The session a report's price reaction happens in: the next trading day for an after-close report, its own date before the open. */
export function reactionDay(report: Pick<EarningsReport, 'date' | 'timing'>): string {
  return report.timing === 'am' ? report.date : nextTradingDay(report.date)
}

// ── Formatting ──────────────────────────────────────────────────────────────

const pct = (n: number | null | undefined, d = 1): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`)
const usd = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`)
const big = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  return a >= 1e12 ? `$${(n / 1e12).toFixed(2)}T` : a >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${n.toFixed(0)}`
}
const timingWord = (t?: 'am' | 'pm'): string => (t === 'am' ? 'before open' : t === 'pm' ? 'after close' : 'timing unknown')

// ── Caches: a past report, a past bar and a day's calendar do not change ─────

const TTL_MS = 30 * 60_000
const cache = new Map<string, { at: number; value: unknown }>()
async function cached<T>(key: string, load: () => Promise<T>, ttl = TTL_MS): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.value as T
  const value = await load()
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 2000) for (const k of [...cache.keys()].slice(0, 500)) cache.delete(k)
  return value
}

const HISTORY_DAYS = 800

const resultsFor = (rh: RobinhoodMcpClient, symbol: string, today: string): Promise<EarningsReport[]> => cached(`results:${symbol}:${today}`, () => getEarningsResults(rh, symbol))

async function barsFor(rh: RobinhoodMcpClient, symbols: string[], today: string): Promise<Record<string, Bar[]>> {
  const out: Record<string, Bar[]> = {}
  const need: string[] = []
  for (const s of symbols) {
    const hit = cache.get(`bars:${s}:${today}`)
    if (hit) out[s] = hit.value as Bar[]
    else need.push(s)
  }
  if (need.length) {
    const got = await getBarsBatch(rh, need, new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString(), 'day')
    for (const s of need) {
      out[s] = got[s] ?? []
      cache.set(`bars:${s}:${today}`, { at: Date.now(), value: out[s] })
    }
  }
  return out
}

/** At most `n` promises in flight. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    })
  )
  return out
}

/**
 * The symbol's next report (the first with no actual yet, on or after today),
 * or null. Cached for the day. Used by the trade gate to confirm a buy lands
 * in the report window, so a failure is thrown for the caller to decide on.
 */
export async function nextReport(rh: RobinhoodMcpClient, symbol: string, now: Date): Promise<EarningsReport | null> {
  const today = etClock(now).date
  const rows = await resultsFor(rh, symbol.toUpperCase(), today)
  return rows.find((r) => r.epsActual === null && r.date >= today) ?? null
}

// ── The two tools ────────────────────────────────────────────────────────────

/** How many reporters the screen researches in full. */
const CANDIDATES_MAX = 14
/** Below this average dollar volume a name is flagged: an all-in market order and an opening sell both pay the spread. */
const THIN_DOLLAR_VOLUME = 25_000_000

/**
 * The screen: every $1B+ company reporting after today's close or before
 * tomorrow's open, each with its reaction history, sorted by size. Researches
 * at most `CANDIDATES_MAX` in full so one call stays inside a run's budget.
 */
export async function earningsCandidates(rh: RobinhoodMcpClient, now: Date): Promise<string> {
  const c = etClock(now)
  const today = c.date
  const next = nextTradingDay(today)
  const reports = await cached(`calendar:${today}`, () => getEarningsReports(rh, { days: Math.max(2, Math.round((Date.parse(next) - Date.parse(today)) / 86_400_000) + 1), startDate: today, highMarketCap: true }), 10 * 60_000)
  const seen = new Set<string>()
  const inWindow: (EarningsReport & { window: ReportWindow })[] = []
  for (const r of reports) {
    const w = reportWindow(r, now)
    if (!w || seen.has(r.symbol) || !/^[A-Z.]{1,6}$/.test(r.symbol)) continue
    seen.add(r.symbol)
    inWindow.push({ ...r, window: w })
  }
  if (!inWindow.length) {
    const ahead = await cached(`calendar-ahead:${today}`, () => getEarningsReports(rh, { days: 10, startDate: addDays(today, 1), highMarketCap: true }), 60 * 60_000).catch(() => [] as EarningsReport[])
    const days = [...new Set(ahead.filter((r) => r.timing).map((r) => r.date))].sort().slice(0, 4)
    const tail = days.length ? ` Upcoming $1B+ report days: ${days.map((d) => `${d} (${ahead.filter((r) => r.date === d).length})`).join(', ')}.` : ''
    return `NO $1B+ company reports ${REPORT_WINDOW_LABEL.tonight} (${today}) or ${REPORT_WINDOW_LABEL.tomorrowMorning} (${next}) with a confirmed timing. Nothing to buy into today — say so and end the run.${tail}`
  }
  const syms = inWindow.map((r) => r.symbol)
  const [fund, quotes] = await Promise.all([getFundamentals(rh, syms).catch(() => [] as Fundamentals[]), getQuotes(rh, syms, now).catch(() => [] as Quote[])])
  const fmap = new Map(fund.map((f) => [f.symbol, f]))
  const qmap = new Map(quotes.map((q) => [q.symbol, q]))
  const ranked = [...inWindow].sort((a, b) => (fmap.get(b.symbol)?.marketCap ?? 0) - (fmap.get(a.symbol)?.marketCap ?? 0))
  const top = ranked.slice(0, CANDIDATES_MAX)
  const bars = await barsFor(
    rh,
    top.map((r) => r.symbol),
    today
  ).catch(() => ({}) as Record<string, Bar[]>)
  const histories = await pool(top, 5, (r) => resultsFor(rh, r.symbol, today).catch(() => [] as EarningsReport[]))
  const lines = top.map((r, i) => {
    const f = fmap.get(r.symbol)
    const q = qmap.get(r.symbol)
    const price = q?.last ?? null
    const reactions = histories[i].map((h) => reactionFor(h, bars[r.symbol] ?? [])).filter((x): x is EarningsReaction => x !== null)
    const st = reactionStats(reactions)
    const dollarVol = f?.avgVolume && price ? f.avgVolume * price : null
    const thin = dollarVol !== null && dollarVol < THIN_DOLLAR_VOLUME ? ' ⚠ THIN' : ''
    const hist = st
      ? `last ${st.n}: gapped up ${st.gapUps}/${st.n}, avg gap ${pct(st.avgGapPct)}, typical move ±${st.avgAbsGapPct.toFixed(1)}%, beat ${st.beats}/${st.withEstimate}${st.beats ? ` (beats gapped up ${st.beatsGapUp}/${st.beats})` : ''}`
      : 'no reaction history in the bars'
    return `- ${r.symbol} · ${REPORT_WINDOW_LABEL[r.window]}${r.verified ? '' : ' (date UNCONFIRMED)'} · ${big(f?.marketCap)} cap · ${usd(price)}${q?.changePct !== undefined ? ` ${pct(q.changePct)} today` : ''} · $vol ${big(dollarVol)}/day${thin} · EPS est ${r.epsEstimate ?? '—'} · ${hist}${f?.sector ? ` · ${f.sector}` : ''}`
  })
  const more = ranked.length > top.length ? `\n(+${ranked.length - top.length} smaller reporters not researched: ${ranked.slice(top.length).map((r) => r.symbol).join(', ')})` : ''
  return [
    `EARNINGS IN THE WINDOW — ${inWindow.length} $1B+ reporter${inWindow.length === 1 ? '' : 's'} ${REPORT_WINDOW_LABEL.tonight} (${today}) or ${REPORT_WINDOW_LABEL.tomorrowMorning} (${next}), largest first. "gap" = next open vs the close before the report — the exact move this mode sells into at ${EARNINGS_POP.exitAt} ET.`,
    ...lines,
    more,
    'NEXT: pick the 2–3 most promising and call earnings_dossier on each (it adds the options-implied move, financials, analysts and the setup), then read their news/sentiment. A stock that does not usually gap up after a beat is a poor bet even if it beats.'
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Everything the engine can assemble about one name's coming report, in one
 * call: profile, the report and its window, the options-implied move against
 * the real historical moves, eight quarters of surprises and reactions,
 * financial trend, analysts and the setup into the print.
 */
export async function earningsDossier(rh: RobinhoodMcpClient, symbolRaw: string, now: Date): Promise<string> {
  const symbol = symbolRaw.trim().toUpperCase()
  const today = etClock(now).date
  const settle = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null)
  const [history, fundArr, quote, fin, ratingsArr, barsMap] = await Promise.all([
    settle(resultsFor(rh, symbol, today)),
    settle(getFundamentals(rh, [symbol])),
    settle(getQuotes(rh, [symbol], now).then((q) => q[0] ?? null)),
    settle(cached(`fin:${symbol}:${today}`, () => getFinancials(rh, symbol, { limit: 8 }), 6 * 60 * 60_000)),
    settle(cached(`ratings:${symbol}:${today}`, () => getAnalystRatings(rh, [symbol]), 6 * 60 * 60_000)),
    settle(barsFor(rh, [symbol], today))
  ])
  const f: Fundamentals | undefined = fundArr?.[0]
  const ratings: AnalystRatings | undefined = ratingsArr?.[0]
  const bars = barsMap?.[symbol] ?? []
  const price = quote?.last ?? bars.at(-1)?.c ?? null
  if (!history && !f && !price) return `No data for ${symbol} — the broker returned nothing for it (a typo, a delisted name, or the connection failed). Check the ticker.`
  const upcoming = (history ?? []).find((r) => r.epsActual === null && r.date >= today) ?? null
  const reactions = (history ?? []).map((h) => reactionFor(h, bars)).filter((x): x is EarningsReaction => x !== null)
  const st = reactionStats(reactions)
  const window = upcoming ? reportWindow(upcoming, now) : null
  const implied: ImpliedMove | null = upcoming && price ? await settle(cached(`iv:${symbol}:${today}:${Math.round(price)}`, () => getImpliedMove(rh, symbol, reactionDay(upcoming), price), 20 * 60_000)) : null
  const trend = fin ? financialTrend(fin) : null
  const setup = price ? setupStats(bars, price, f?.high52 ?? null) : null

  const out: string[] = []
  out.push(`EARNINGS DOSSIER — ${symbol}${f?.industry ? ` · ${f.industry}` : ''}${f?.sector ? ` (${f.sector})` : ''}`)
  if (f?.description) out.push(f.description.length > 280 ? `${f.description.slice(0, 280)}…` : f.description)
  out.push(`Price ${usd(price)}${quote?.changePct !== undefined ? ` (${pct(quote.changePct)} today)` : ''} · cap ${big(f?.marketCap)} · P/E ${f?.peRatio?.toFixed(1) ?? '—'} · 52w ${usd(f?.low52)}–${usd(f?.high52)} · avg $vol ${big(f?.avgVolume && price ? f.avgVolume * price : null)}/day`)

  out.push('')
  if (upcoming) {
    out.push(
      `NEXT REPORT: ${upcoming.date} ${timingWord(upcoming.timing)}${upcoming.verified ? '' : ' — date NOT confirmed by the company'} · EPS estimate ${upcoming.epsEstimate ?? '—'}. ${
        window ? `IN THE WINDOW (${REPORT_WINDOW_LABEL[window]}) — buyable in this mode.` : 'NOT in the window (the mode buys only a report after today’s close or before tomorrow’s open) — the engine will refuse an all-in buy of it today.'
      }`
    )
  } else out.push('NEXT REPORT: none scheduled in the broker’s data.')
  if (implied) {
    const vs = st ? ` vs a typical ±${st.avgAbsGapPct.toFixed(1)}% gap over the last ${st.n} reports` : ''
    const read = st ? (implied.pct > st.avgAbsGapPct * 1.15 ? ' → options price MORE than it usually moves (a beat may already be paid for)' : implied.pct < st.avgAbsGapPct * 0.85 ? ' → options price LESS than it usually moves' : ' → in line with history') : ''
    out.push(`OPTIONS-IMPLIED MOVE: ±${implied.pct.toFixed(1)}% (the ${implied.expiration} ${implied.strike} straddle, ${usd(implied.straddle)})${vs}${read}. The straddle includes some ordinary time value, so the report-only move is a little smaller.`)
  } else if (upcoming) out.push('OPTIONS-IMPLIED MOVE: unavailable (no listed options or no mark).')

  if (reactions.length) {
    out.push('')
    out.push('PAST REPORTS (oldest first) — surprise vs estimate → next-open gap / reaction-day close, and the run-up into it:')
    for (const r of reactions) out.push(`- ${r.date} ${timingWord(r.timing)}: EPS surprise ${pct(r.surprisePct)} → gap ${pct(r.gapPct)}, day ${pct(r.dayPct)} · run-up ${pct(r.runUpPct)}`)
    if (st) {
      out.push(
        `SUMMARY: gapped up ${st.gapUps}/${st.n} · avg gap ${pct(st.avgGapPct)} · typical ±${st.avgAbsGapPct.toFixed(1)}% · best ${pct(st.bestGapPct)} · worst ${pct(st.worstGapPct)} · beat ${st.beats}/${st.withEstimate}${st.beats ? `, and beats gapped UP ${st.beatsGapUp}/${st.beats} times` : ''}.`
      )
    }
  } else out.push('PAST REPORTS: none readable from the bars.')

  if (fin?.length) {
    out.push('')
    out.push(`FINANCIALS (quarterly, newest first): ${fin.slice(0, 5).map((q) => `${q.periodEnd || `FY${q.fiscalYear}Q${q.fiscalQuarter ?? '?'}`} rev ${big(q.revenue)} margin ${q.netMargin !== null ? `${q.netMargin.toFixed(1)}%` : '—'}`).join(' · ')}`)
    if (trend) out.push(`TREND: revenue ${pct(trend.revYoYPct)} YoY, ${pct(trend.revQoQPct)} QoQ · net margin ${trend.marginNow?.toFixed(1) ?? '—'}% vs ${trend.marginYearAgo?.toFixed(1) ?? '—'}% a year ago.`)
  }
  if (ratings) {
    const up = ratings.mean && price ? ((ratings.mean - price) / price) * 100 : null
    out.push(`ANALYSTS: ${ratings.buy} buy / ${ratings.hold} hold / ${ratings.sell} sell · mean target ${usd(ratings.mean)} (${pct(up)} from here), range ${usd(ratings.low)}–${usd(ratings.high)}.`)
  }
  if (setup) {
    out.push(`SETUP INTO THE PRINT: ${pct(setup.ret5Pct)} over 5 sessions, ${pct(setup.ret20Pct)} over 20 · ${pct(setup.vsSma20Pct)} vs the 20-day avg, ${pct(setup.vsSma50Pct)} vs the 50-day · ${pct(setup.fromHigh52Pct)} from the 52-week high. A big run-up into the report raises the bar a beat has to clear.`)
  }
  out.push('')
  out.push(`READ NEXT: the qualitative side — webvector_news for ${symbol} (guidance chatter, preannouncements, sector peers that already reported), webvector_sentiment for ${symbol} (crowd skew and short volume), and webvector_filings if something material was filed. Then decide: one name all-in, or none.`)
  return out.join('\n')
}
