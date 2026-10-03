import { randomUUID } from 'node:crypto'
import type { AccountFill, Quote } from '@shared/ipc'
import type { RobinhoodMcpClient } from './mcp'
import { addDays, etClock, etDateTime } from '@shared/marketTime'

/**
 * Typed wrappers + normalizers over the Robinhood MCP tools the ENGINE uses.
 * Every numeric field on the wire is a string; shapes below are verified live.
 */
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Dedupe + uppercase a symbol list for the wire. */
const normSymbols = (symbols: string[]): string[] => [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))]

export interface RhAccount {
  accountNumber: string
  agenticAllowed: boolean
  nickname?: string
  /**
   * `"cash"` or `"margin"` (reported beside `brokerage_account_type`, which is
   * the ownership kind — individual, joint — and not the settlement kind, so it
   * is only a fallback). Decides whether sale
   * proceeds are reusable before they settle (`shared/settlement.ts`).
   */
  type?: string
  /** Sale proceeds not yet settled, account-wide (`unsettled_funds`, verified live). */
  unsettledFunds?: number
}

export async function getAccounts(c: RobinhoodMcpClient): Promise<RhAccount[]> {
  const data = await c.call<{ accounts?: Array<{ account_number?: string; agentic_allowed?: boolean; nickname?: string; type?: string; brokerage_account_type?: string; unsettled_funds?: string }> }>('get_accounts')
  return (data.accounts ?? [])
    .filter((a) => a.account_number)
    .map((a) => ({
      accountNumber: String(a.account_number),
      agenticAllowed: Boolean(a.agentic_allowed),
      nickname: a.nickname,
      type: a.type ?? a.brokerage_account_type,
      ...(a.unsettled_funds !== undefined ? { unsettledFunds: num(a.unsettled_funds) } : {})
    }))
}

export interface RhPortfolio {
  cash: number
  buyingPower: number
  totalValue: number
}

export async function getPortfolio(c: RobinhoodMcpClient, accountNumber: string): Promise<RhPortfolio> {
  const data = await c.call<{ cash?: string; total_value?: string; buying_power?: { buying_power?: string } | string }>('get_portfolio', { account_number: accountNumber })
  const bp = typeof data.buying_power === 'object' && data.buying_power ? data.buying_power.buying_power : data.buying_power
  return { cash: num(data.cash), buyingPower: num(bp), totalValue: num(data.total_value) }
}

export interface RhPosition {
  symbol: string
  qty: number
  avgCost: number
}

export async function getPositions(c: RobinhoodMcpClient, accountNumber: string): Promise<RhPosition[]> {
  const data = await c.call<{ positions?: Array<{ symbol?: string; quantity?: string; average_buy_price?: string }>; results?: Array<{ symbol?: string; quantity?: string; average_buy_price?: string }> }>(
    'get_equity_positions',
    { account_number: accountNumber }
  )
  return (data.positions ?? data.results ?? [])
    .filter((p) => p.symbol)
    .map((p) => ({ symbol: String(p.symbol).toUpperCase(), qty: num(p.quantity), avgCost: num(p.average_buy_price) }))
    .filter((p) => p.qty > 0)
}

interface RawQuoteRow {
  symbol?: string
  quote?: {
    symbol?: string
    last_trade_price?: string
    last_non_reg_trade_price?: string
    venue_last_trade_time?: string
    venue_last_non_reg_trade_time?: string
    adjusted_previous_close?: string
    previous_close?: string
    /** yyyy-mm-dd (ET) of the session `previous_close` is the close of. */
    previous_close_date?: string
    bid_price?: string
    ask_price?: string
    state?: string
  }
  close?: { price?: string; date?: string }
}

/** How many symbols go in one `get_equity_quotes` call. */
const QUOTE_CHUNK = 10

/** One call. Throws if the batch fails — the batching above decides what that means. */
async function quoteChunk(c: RobinhoodMcpClient, syms: string[]): Promise<Quote[]> {
  const data = await c.call<{ results?: RawQuoteRow[] }>('get_equity_quotes', { symbols: syms })
  const out: Quote[] = []
  ;(data.results ?? []).forEach((r, i) => {
    const q = r.quote ?? {}
    const symbol = (q.symbol ?? r.symbol ?? syms[i] ?? '').toUpperCase()
    if (!symbol) return
    const regT = q.venue_last_trade_time ? Date.parse(q.venue_last_trade_time) : 0
    const extT = q.venue_last_non_reg_trade_time ? Date.parse(q.venue_last_non_reg_trade_time) : 0
    let last = num(q.last_trade_price)
    if (extT > regT && num(q.last_non_reg_trade_price) > 0) last = num(q.last_non_reg_trade_price)
    if (!(last > 0)) last = num(q.previous_close)
    const prevClose = num(q.adjusted_previous_close) || num(r.close?.price) || num(q.previous_close) || undefined
    // Which session that close belongs to. `previous_close_date` labels the
    // quote's own fields; the `close` row carries its own `date`. Both roll.
    const prevCloseDate = (num(q.adjusted_previous_close) || num(q.previous_close) ? q.previous_close_date : undefined) ?? r.close?.date ?? q.previous_close_date
    const bid = num(q.bid_price) || undefined
    const ask = num(q.ask_price) || undefined
    out.push({
      symbol,
      last,
      bid,
      ask,
      prevClose,
      ...(prevClose && prevCloseDate ? { prevCloseDate } : {}),
      changePct: prevClose && last ? ((last - prevClose) / prevClose) * 100 : undefined,
      ts: new Date(Math.max(regT, extT) || Date.now()).toISOString()
    })
  })
  return out
}

/** Prior-session closes already looked up, keyed `SYMBOL:<ET day>` — a past session's close never changes. */
const priorCloseCache = new Map<string, { date: string; close: number }>()

/** How far back the daily bars reach when a prior session's close is needed — over any holiday run. */
const PRIOR_CLOSE_LOOKBACK_DAYS = 10

/**
 * The session date of a Robinhood DAILY bar. Day bars are stamped at midnight
 * UTC of their own session (a bar stamped `…-09T00:00:00Z` carries the official
 * close of the 9th, matching the quote's `close` row), so the date is the
 * UTC date — the ET date of that instant is the evening BEFORE.
 */
export const dailyBarDate = (b: Pick<Bar, 't'>): string => new Date(b.t * 1000).toISOString().slice(0, 10)

/**
 * After the regular session ends, Robinhood's quote rolls `previous_close`,
 * `adjusted_previous_close` AND the `close` row to the close of the session
 * that JUST ended — `previous_close_date` says so, and it used to be
 * discarded. Read as "yesterday's close", that anchors every day figure on a
 * print from minutes ago: an account that sold everything that morning read as
 * UP all evening (sale proceeds against tonight's close), while Robinhood's own
 * app showed the real, lower figure.
 *
 * A "previous close" dated TODAY is not a previous close. This swaps in the
 * prior session's close from the daily bars — one batched call per ten rolled
 * symbols, then cached for the day — so `prevClose` means the same thing at
 * 8 PM as at 2 PM. A symbol whose prior close cannot be found drops its
 * `prevClose`/`changePct` rather than keep the rolled one: an absent previous
 * close is the silence every reader already handles, a wrong one is a claim.
 * The next ET day the rolled date is simply "yesterday" and nothing fires.
 */
async function repairRolledPrevClose(c: RobinhoodMcpClient, quotes: Quote[], now: Date): Promise<void> {
  const today = etClock(now).date
  const rolled = quotes.filter((q) => q.prevClose && q.prevCloseDate === today)
  if (!rolled.length) return
  const need = [...new Set(rolled.map((q) => q.symbol))].filter((sym) => !priorCloseCache.has(`${sym}:${today}`))
  if (need.length) {
    let bars: Record<string, Bar[]> = {}
    try {
      bars = await getBarsBatch(c, need, etDateTime(addDays(today, -PRIOR_CLOSE_LOOKBACK_DAYS), 0).toISOString(), 'day')
    } catch {
      /* the fallthrough below drops the rolled closes we could not replace */
    }
    for (const sym of need) {
      const prior = (bars[sym] ?? []).filter((b) => dailyBarDate(b) < today).at(-1)
      if (prior) priorCloseCache.set(`${sym}:${today}`, { date: dailyBarDate(prior), close: prior.c })
    }
  }
  for (const q of rolled) {
    const prior = priorCloseCache.get(`${q.symbol}:${today}`)
    if (prior) {
      q.prevClose = prior.close
      q.prevCloseDate = prior.date
      q.changePct = q.last ? ((q.last - prior.close) / prior.close) * 100 : undefined
    } else {
      delete q.prevClose
      delete q.prevCloseDate
      delete q.changePct
    }
  }
}

/**
 * Real-time quotes, batched, with the misses named.
 *
 * Every symbol used to go in ONE call, so a single unresolvable ticker took the
 * whole run's quotes down with it — and `symbolsOfInterest` derives tickers from
 * prose, so junk in that list is routine rather than exceptional. Losing every
 * quote costs the day-loss anchor, the triage movement test and paper
 * settlement, and the prompt then says "QUOTES: none requested", which reads to
 * the model as *nothing was asked for* rather than *everything failed*.
 *
 * Chunked, and a failed chunk is retried one symbol at a time: a bad ticker
 * should cost its own quote and nothing else. That retry only runs on failure,
 * so the happy path is still one call per ten symbols.
 *
 * `failed` is the difference between "no symbols" and "we asked and could not
 * get them", which the caller needs in order to say so.
 *
 * `prevClose` is always the PRIOR session's close, whatever hour it is — see
 * `repairRolledPrevClose`. `now` exists for the checks; callers omit it.
 */
export async function getQuotesDetailed(c: RobinhoodMcpClient, symbols: string[], now: Date = new Date()): Promise<{ quotes: Quote[]; failed: string[] }> {
  const syms = normSymbols(symbols)
  if (syms.length === 0) return { quotes: [], failed: [] }
  const quotes: Quote[] = []
  const failed: string[] = []
  for (let i = 0; i < syms.length; i += QUOTE_CHUNK) {
    const chunk = syms.slice(i, i + QUOTE_CHUNK)
    try {
      quotes.push(...(await quoteChunk(c, chunk)))
    } catch {
      for (const sym of chunk) {
        try {
          quotes.push(...(await quoteChunk(c, [sym])))
        } catch {
          failed.push(sym)
        }
      }
    }
  }
  await repairRolledPrevClose(c, quotes, now)
  // A symbol the broker simply had nothing for is also a miss, not a silence.
  const got = new Set(quotes.map((q) => q.symbol))
  for (const sym of syms) if (!got.has(sym) && !failed.includes(sym)) failed.push(sym)
  return { quotes, failed }
}

/** Real-time quotes. Uses the more recent of regular vs non-regular last trade. */
export async function getQuotes(c: RobinhoodMcpClient, symbols: string[], now?: Date): Promise<Quote[]> {
  return (await getQuotesDetailed(c, symbols, now)).quotes
}

export interface RhOrder {
  id: string
  symbol: string
  side: 'buy' | 'sell' | string
  state: string
  type?: string
  qty: number
  filledQty: number
  avgPrice?: number
  limitPrice?: number
  createdAt?: string
  /** Last change (the fill, for a filled order) — a GTC limit placed yesterday fills today. */
  updatedAt?: string
}

interface RawOrder {
  id?: string
  order_id?: string
  symbol?: string
  chain_symbol?: string
  side?: string
  state?: string
  status?: string
  type?: string
  quantity?: string
  cumulative_quantity?: string
  average_price?: string
  price?: string
  created_at?: string
  updated_at?: string
  last_transaction_at?: string
  executions?: Array<{ price?: string; quantity?: string; timestamp?: string }>
}

function normOrder(o: RawOrder): RhOrder {
  const execs = o.executions ?? []
  let avg = num(o.average_price)
  const filled = num(o.cumulative_quantity)
  if (!avg && execs.length) {
    const q = execs.reduce((s, e) => s + num(e.quantity), 0)
    const v = execs.reduce((s, e) => s + num(e.quantity) * num(e.price), 0)
    if (q > 0) avg = v / q
  }
  return {
    id: String(o.id ?? o.order_id ?? ''),
    symbol: String(o.symbol ?? o.chain_symbol ?? '').toUpperCase(),
    side: String(o.side ?? ''),
    state: String(o.state ?? o.status ?? ''),
    type: o.type,
    qty: num(o.quantity),
    filledQty: filled,
    avgPrice: avg || undefined,
    limitPrice: num(o.price) || undefined,
    createdAt: o.created_at,
    updatedAt: o.last_transaction_at ?? o.updated_at ?? execs.find((e) => e.timestamp)?.timestamp ?? o.created_at
  }
}

/**
 * Every fill at the broker on the current ET day, whoever placed it. Feeds the
 * portfolio's day figure: an account's "today" is its equity against
 * yesterday's close, which the shares held right now cannot tell you once
 * something was bought or sold since the open. Asks for orders created over
 * the last few days (a resting limit fills on a later day than it was placed)
 * and keeps those whose last change is today with something executed.
 */
export async function getFillsToday(c: RobinhoodMcpClient, accountNumber: string, now: Date = new Date()): Promise<AccountFill[]> {
  const today = etClock(now).date
  const since = etDateTime(addDays(today, -4), 0).toISOString()
  const orders = await getOrders(c, accountNumber, { since })
  const out: AccountFill[] = []
  for (const o of orders) {
    if (!(o.filledQty > 0) || !o.avgPrice) continue
    const at = o.updatedAt ?? o.createdAt
    if (!at || etClock(new Date(at)).date !== today) continue
    const side = o.side.toLowerCase()
    if (side !== 'buy' && side !== 'sell') continue
    out.push({ symbol: o.symbol, side, qty: o.filledQty, price: o.avgPrice, at })
  }
  return out
}

export async function getOrders(c: RobinhoodMcpClient, accountNumber: string, opts: { symbol?: string; orderId?: string; state?: string; since?: string } = {}): Promise<RhOrder[]> {
  const args: Record<string, unknown> = { account_number: accountNumber }
  if (opts.symbol) args.symbol = opts.symbol
  if (opts.orderId) args.order_id = opts.orderId
  if (opts.state) args.state = opts.state
  if (opts.since) args.created_at_gte = opts.since
  const data = await c.call<{ orders?: RawOrder[]; results?: RawOrder[] }>('get_equity_orders', args)
  return (data.orders ?? data.results ?? []).map(normOrder).filter((o) => o.id)
}

export const TERMINAL_REJECT = /reject|cancel|fail|denied|void/i
export const TERMINAL_OK = /^filled$/i

export interface PlaceEquityOrderParams {
  accountNumber: string
  symbol: string
  side: 'buy' | 'sell'
  /**
   * `stop` and `stop_limit` are expressible so the order can be REVIEWED, not
   * placed — `placeEquityOrder` refuses them. Whether Robinhood accepts an
   * equity stop at all, and whether it takes GTC on one, is the open question
   * blocking broker-side stops (#8b), and a dry run is the only way to ask
   * without arming anything.
   */
  type: 'market' | 'limit' | 'stop' | 'stop_limit'
  qty?: number
  /** Market orders only. */
  dollarAmount?: number
  limitPrice?: number
  /** Trigger price for `stop` / `stop_limit`. */
  stopPrice?: number
  tif?: 'gfd' | 'gtc'
  marketHours?: 'regular_hours' | 'extended_hours' | 'all_day_hours'
  refId?: string
}

export interface PlaceResult {
  ok: boolean
  orderId?: string
  state?: string
  detail: string
}

function orderMeta(result: unknown): { orderId?: string; state?: string } {
  if (!result || typeof result !== 'object') return {}
  const wrapped = (result as { order?: unknown }).order ?? result
  const r = wrapped as { id?: string; order_id?: string; state?: string; status?: string }
  return { orderId: r.id ?? r.order_id, state: r.state ?? r.status }
}

function detailOf(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result).slice(0, 400)
  } catch {
    return 'ok'
  }
}

function buildOrderArgs(p: PlaceEquityOrderParams): Record<string, unknown> {
  const args: Record<string, unknown> = {
    account_number: p.accountNumber,
    symbol: p.symbol.toUpperCase(),
    side: p.side,
    type: p.type,
    market_hours: p.marketHours ?? 'regular_hours',
    time_in_force: p.tif ?? 'gfd'
  }
  if (p.type === 'market' && p.dollarAmount != null) args.dollar_amount = p.dollarAmount.toFixed(2)
  else if (p.qty != null) args.quantity = String(p.qty)
  // A stop_limit carries BOTH: the trigger and the limit the triggered order
  // then works at. Emitting only one of them is how a probe comes back clean
  // having tested something other than what it meant to.
  if ((p.type === 'limit' || p.type === 'stop_limit') && p.limitPrice != null) args.limit_price = p.limitPrice.toFixed(2)
  if ((p.type === 'stop' || p.type === 'stop_limit') && p.stopPrice != null) args.stop_price = p.stopPrice.toFixed(2)
  return args
}

/** Order types whose wire format Robinhood has not yet confirmed to us. */
const UNVERIFIED_TYPES: readonly string[] = ['stop', 'stop_limit']

/**
 * Dry-run an order: Robinhood's own pre-trade warnings and collar checks, and it
 * PLACES NOTHING. Built from the same `buildOrderArgs` as placement, so what it
 * exercises is the real wire format rather than a description of it.
 *
 * This is how the stop question gets answered without arming a stop: send the
 * shape, read the rejection. The rejection text is the answer, so record it
 * next to `buildOrderArgs` rather than leaving it in a session transcript.
 */
export async function reviewEquityOrder(c: RobinhoodMcpClient, p: PlaceEquityOrderParams): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await c.call('review_equity_order', buildOrderArgs(p))
    return { ok: true, detail: detailOf(r) }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

/**
 * Place an equity order. Response arrives as `{ order: { id, state: 'unconfirmed', … } }`
 * (after `data` unwrap) or a plain confirmation string. A terminal-reject state in
 * the response counts as failure even though the transport succeeded.
 */
export async function placeEquityOrder(c: RobinhoodMcpClient, p: PlaceEquityOrderParams): Promise<PlaceResult> {
  if (p.dollarAmount == null && p.qty == null) return { ok: false, detail: 'order needs qty or dollarAmount' }
  // Widening the TYPE must not quietly widen what can be PLACED. Nothing in the
  // engine can build a stop today — `TradeIntent.type` is market|limit — but the
  // parameter now admits one, and an unverified wire format reaching a live
  // order is exactly the shape of failure this codebase keeps having. Review it
  // first; delete this guard when the probe says what Robinhood accepts.
  if (UNVERIFIED_TYPES.includes(p.type)) {
    return { ok: false, detail: `${p.type} orders are not placeable yet: the wire format is unverified. Use reviewEquityOrder to probe it (#8b).` }
  }
  const args = { ...buildOrderArgs(p), ref_id: p.refId ?? randomUUID() }
  try {
    const result = await c.call('place_equity_order', args)
    const { orderId, state } = orderMeta(result)
    const rejected = !!state && TERMINAL_REJECT.test(state)
    return { ok: !rejected, orderId, state, detail: detailOf(result) }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

export async function cancelEquityOrder(c: RobinhoodMcpClient, accountNumber: string, orderId: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await c.call('cancel_equity_order', { account_number: accountNumber, order_id: orderId })
    return { ok: true, detail: detailOf(r) }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

/**
 * Poll an order until terminal (filled / rejected / cancelled) or the deadline.
 * Returns the latest snapshot (may still be open).
 */
export async function awaitOrder(c: RobinhoodMcpClient, accountNumber: string, orderId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<RhOrder | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 12_000)
  let last: RhOrder | null = null
  while (Date.now() < deadline) {
    try {
      const rows = await getOrders(c, accountNumber, { orderId })
      last = rows[0] ?? last
      if (last && (TERMINAL_OK.test(last.state) || TERMINAL_REJECT.test(last.state))) return last
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1500))
  }
  return last
}

export interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}


/** Batched OHLCV bars for up to N symbols (10 per MCP call), keyed by symbol. */
export async function getBarsBatch(c: RobinhoodMcpClient, symbols: string[], startIso: string, interval: string): Promise<Record<string, Bar[]>> {
  const syms = normSymbols(symbols)
  const out: Record<string, Bar[]> = {}
  for (let i = 0; i < syms.length; i += 10) {
    const batch = syms.slice(i, i + 10)
    const data = await c.call<{ results?: Array<{ symbol?: string; bars?: Array<{ begins_at?: string; open_price?: string; high_price?: string; low_price?: string; close_price?: string; volume?: number | string }> }> }>(
      'get_equity_historicals',
      { symbols: batch, start_time: startIso, interval }
    )
    ;(data.results ?? []).forEach((r, idx) => {
      const symbol = (r.symbol ?? batch[idx] ?? '').toUpperCase()
      if (!symbol) return
      out[symbol] = (r.bars ?? [])
        .filter((b) => b.begins_at)
        .map((b) => ({ t: Math.floor(new Date(b.begins_at!).getTime() / 1000), o: num(b.open_price), h: num(b.high_price), l: num(b.low_price), c: num(b.close_price), v: num(b.volume) }))
        .filter((b) => b.c > 0)
    })
  }
  return out
}

export interface EarningsEntry {
  symbol: string
  /** yyyy-mm-dd */
  date: string
  timing?: 'am' | 'pm'
}

/** Upcoming earnings within `days` (broad calendar; caller filters symbols). */
export async function getEarningsCalendar(c: RobinhoodMcpClient, days = 14): Promise<EarningsEntry[]> {
  return (await getEarningsReports(c, { days })).map((r) => ({ symbol: r.symbol, date: r.date, timing: r.timing }))
}

/** One report event as `get_earnings_calendar` / `get_earnings_results` return it (verified live 2026-09-29). */
export interface EarningsReport {
  symbol: string
  year?: number
  quarter?: number
  epsEstimate: number | null
  /** null = not reported yet. */
  epsActual: number | null
  /** ET "YYYY-MM-DD" */
  date: string
  timing?: 'am' | 'pm'
  /** false = the company has not confirmed the date; treat it as tentative. */
  verified: boolean
}

interface RawEarningsRow {
  symbol?: string
  year?: number
  quarter?: number
  eps?: { estimate?: string | null; actual?: string | null }
  report?: { date?: string; timing?: string; verified?: boolean }
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

function normReports(rows: RawEarningsRow[]): EarningsReport[] {
  return rows
    .filter((r) => r.symbol && r.report?.date)
    .map((r) => ({
      symbol: String(r.symbol).toUpperCase(),
      ...(typeof r.year === 'number' ? { year: r.year } : {}),
      ...(typeof r.quarter === 'number' ? { quarter: r.quarter } : {}),
      epsEstimate: numOrNull(r.eps?.estimate),
      epsActual: numOrNull(r.eps?.actual),
      date: String(r.report!.date),
      timing: r.report!.timing === 'am' ? ('am' as const) : r.report!.timing === 'pm' ? ('pm' as const) : undefined,
      verified: r.report!.verified !== false
    }))
}

/**
 * The market-wide calendar with estimates. `highMarketCap` = Robinhood's own
 * filter (market cap over $1B). `startDate` anchors the window (ET date);
 * `days` ≤ 31.
 */
export async function getEarningsReports(c: RobinhoodMcpClient, opts: { days: number; startDate?: string; highMarketCap?: boolean }): Promise<EarningsReport[]> {
  const args: Record<string, unknown> = { days: Math.max(-31, Math.min(31, Math.round(opts.days))) }
  if (opts.startDate) args.start_date = opts.startDate
  if (opts.highMarketCap) args.filter = 'high_market_cap'
  const data = await c.call<{ results?: RawEarningsRow[]; earnings?: RawEarningsRow[] }>('get_earnings_calendar', args)
  return normReports(data.results ?? data.earnings ?? [])
}

/** One symbol's trailing (up to 8) quarters plus the upcoming one(s), oldest first. */
export async function getEarningsResults(c: RobinhoodMcpClient, symbol: string): Promise<EarningsReport[]> {
  const data = await c.call<{ results?: RawEarningsRow[] }>('get_earnings_results', { symbol: symbol.trim().toUpperCase() })
  return normReports(data.results ?? []).sort((a, b) => a.date.localeCompare(b.date))
}

export interface Fundamentals {
  symbol: string
  marketCap: number | null
  peRatio: number | null
  pbRatio: number | null
  /** Shares/day, trailing. */
  avgVolume: number | null
  high52: number | null
  low52: number | null
  sector?: string
  industry?: string
  description?: string
  dividendYield: number | null
}

export async function getFundamentals(c: RobinhoodMcpClient, symbols: string[]): Promise<Fundamentals[]> {
  const syms = normSymbols(symbols).slice(0, 75)
  if (!syms.length) return []
  const data = await c.call<{ results?: Array<Record<string, unknown>> }>('get_equity_fundamentals', { symbols: syms })
  return (data.results ?? [])
    .filter((r) => r.symbol)
    .map((r) => ({
      symbol: String(r.symbol).toUpperCase(),
      marketCap: numOrNull(r.market_cap),
      peRatio: numOrNull(r.pe_ratio),
      pbRatio: numOrNull(r.pb_ratio),
      avgVolume: numOrNull(r.average_volume_30_days) ?? numOrNull(r.average_volume),
      high52: numOrNull(r.high_52_weeks),
      low52: numOrNull(r.low_52_weeks),
      ...(typeof r.sector === 'string' ? { sector: r.sector } : {}),
      ...(typeof r.industry === 'string' ? { industry: r.industry } : {}),
      ...(typeof r.description === 'string' ? { description: r.description } : {}),
      dividendYield: numOrNull(r.dividend_yield)
    }))
}

export interface FinancialPeriod {
  fiscalYear: number
  fiscalQuarter?: number
  periodEnd: string
  revenue: number | null
  grossProfit: number | null
  netIncome: number | null
  /** Percent. */
  netMargin: number | null
}

/** Reported revenue / gross profit / net income by period, NEWEST first (as the tool returns them). */
export async function getFinancials(c: RobinhoodMcpClient, symbol: string, opts: { period?: 'quarterly' | 'annual'; limit?: number } = {}): Promise<FinancialPeriod[]> {
  const data = await c.call<{ results?: Array<{ symbol?: string; financials?: Array<Record<string, unknown>> }> }>('get_financials', {
    symbols: [symbol.trim().toUpperCase()],
    period: opts.period ?? 'quarterly',
    limit: opts.limit ?? 8
  })
  return (data.results?.[0]?.financials ?? []).map((f) => ({
    fiscalYear: Number(f.fiscal_year),
    ...(f.fiscal_quarter !== undefined && f.fiscal_quarter !== null ? { fiscalQuarter: Number(f.fiscal_quarter) } : {}),
    periodEnd: String(f.period_end_date ?? ''),
    revenue: numOrNull(f.revenue),
    grossProfit: numOrNull(f.gross_profit),
    netIncome: numOrNull(f.net_income),
    netMargin: numOrNull(f.net_margin)
  }))
}

export interface AnalystRatings {
  symbol: string
  buy: number
  hold: number
  sell: number
  high: number | null
  low: number | null
  mean: number | null
  updatedAt?: string
}

export async function getAnalystRatings(c: RobinhoodMcpClient, symbols: string[]): Promise<AnalystRatings[]> {
  const syms = normSymbols(symbols).slice(0, 75)
  if (!syms.length) return []
  const data = await c.call<{ results?: Array<{ symbol?: string; ratings?: Record<string, unknown> }> }>('get_equity_analyst_ratings', { symbols: syms })
  return (data.results ?? [])
    .filter((r) => r.symbol && r.ratings)
    .map((r) => ({
      symbol: String(r.symbol).toUpperCase(),
      buy: num(r.ratings!.num_buy_ratings),
      hold: num(r.ratings!.num_hold_ratings),
      sell: num(r.ratings!.num_sell_ratings),
      high: numOrNull(r.ratings!.high_price_target),
      low: numOrNull(r.ratings!.low_price_target),
      mean: numOrNull(r.ratings!.mean_price_target),
      ...(typeof r.ratings!.updated_at === 'string' ? { updatedAt: r.ratings!.updated_at } : {})
    }))
}

/** What the options market prices for a symbol's move through a date: the at-the-money straddle. */
export interface ImpliedMove {
  expiration: string
  strike: number
  callMark: number
  putMark: number
  /** callMark + putMark, per share. */
  straddle: number
  /** straddle / price × 100 — the ± move the options price in by `expiration`. */
  pct: number
  /** Mean of the two legs' implied volatility, annualized, as a fraction. */
  iv?: number
}

/**
 * The at-the-money straddle on the first expiration on or after `onOrAfter`
 * (ET date): three read calls — chain, the expiry's contracts, their quotes.
 * Shapes verified live 2026-09-29 (`chains[]`, `instruments[]`,
 * `results[].quote.mark_price`). Null when the symbol has no listed options or
 * the legs have no mark. The straddle also carries the days of ordinary time
 * value up to that expiry, so it slightly OVERSTATES the move priced for the
 * report alone.
 */
export async function getImpliedMove(c: RobinhoodMcpClient, symbol: string, onOrAfter: string, price: number): Promise<ImpliedMove | null> {
  if (!(price > 0)) return null
  const sym = symbol.trim().toUpperCase()
  const chains = await c.call<{ chains?: Array<{ symbol?: string; expiration_dates?: string[] }>; results?: Array<{ symbol?: string; expiration_dates?: string[] }> }>('get_option_chains', { underlying_symbol: sym })
  const chain = (chains.chains ?? chains.results ?? []).find((ch) => (ch.symbol ?? '').toUpperCase() === sym) ?? (chains.chains ?? chains.results ?? [])[0]
  const expiration = [...(chain?.expiration_dates ?? [])].sort().find((d) => d >= onOrAfter)
  if (!expiration) return null
  const inst = await c.call<{ instruments?: Array<{ id?: string; strike_price?: string; type?: string }>; results?: Array<{ id?: string; strike_price?: string; type?: string }> }>('get_option_instruments', {
    chain_symbol: sym,
    expiration_dates: expiration,
    state: 'active'
  })
  const rows = (inst.instruments ?? inst.results ?? []).filter((i) => i.id && Number(i.strike_price) > 0)
  const strikes = [...new Set(rows.map((i) => Number(i.strike_price)))]
    .filter((k) => rows.some((i) => Number(i.strike_price) === k && i.type === 'call') && rows.some((i) => Number(i.strike_price) === k && i.type === 'put'))
    .sort((a, b) => Math.abs(a - price) - Math.abs(b - price))
  const strike = strikes[0]
  if (strike === undefined) return null
  const call = rows.find((i) => Number(i.strike_price) === strike && i.type === 'call')!
  const put = rows.find((i) => Number(i.strike_price) === strike && i.type === 'put')!
  const q = await c.call<{ results?: Array<{ quote?: { instrument_id?: string; mark_price?: string; adjusted_mark_price?: string; implied_volatility?: string } }> }>('get_option_quotes', { instrument_ids: [call.id, put.id] })
  const byId = new Map((q.results ?? []).map((r) => [r.quote?.instrument_id, r.quote]))
  const mark = (id?: string): number => num(byId.get(id)?.mark_price) || num(byId.get(id)?.adjusted_mark_price)
  const callMark = mark(call.id)
  const putMark = mark(put.id)
  if (!(callMark > 0) || !(putMark > 0)) return null
  const ivs = [num(byId.get(call.id)?.implied_volatility), num(byId.get(put.id)?.implied_volatility)].filter((v) => v > 0)
  const straddle = callMark + putMark
  return { expiration, strike, callMark, putMark, straddle, pct: (straddle / price) * 100, ...(ivs.length ? { iv: ivs.reduce((a, b) => a + b, 0) / ivs.length } : {}) }
}

export interface TradabilityRow {
  symbol: string
  /** Human-readable problem, or null when fully tradable. */
  issue: string | null
}

/**
 * Per-symbol tradability (halts / ineligibility). The response shape is not
 * fully documented, so extraction is defensive: any boolean-ish field whose key
 * suggests eligibility that reads false becomes an issue.
 */
export async function getTradability(c: RobinhoodMcpClient, accountNumber: string, symbols: string[]): Promise<TradabilityRow[]> {
  const syms = normSymbols(symbols).slice(0, 10)
  if (!syms.length) return []
  const data = await c.call<{ results?: Array<Record<string, unknown>>; tradability?: Array<Record<string, unknown>> }>('get_equity_tradability', { account_number: accountNumber, symbols: syms })
  const rows = data.results ?? data.tradability ?? []
  return rows.map((r, i) => {
    const symbol = String((r.symbol as string) ?? syms[i] ?? '').toUpperCase()
    const issues: string[] = []
    for (const [k, v] of Object.entries(r)) {
      const key = k.toLowerCase()
      if (v === false && /tradab|eligib|enabled|allowed/.test(key) && !/fraction/.test(key)) issues.push(`${k} = false`)
      if (typeof v === 'string' && /halt/.test(key) && v && v !== 'none') issues.push(`${k}: ${v}`)
    }
    return { symbol, issue: issues.length ? issues.join(', ') : null }
  })
}

/** Keep only bars from the LAST ET session present in the series. */
export function lastSessionBars(bars: Bar[]): Bar[] {
  if (!bars.length) return bars
  const lastDay = etClock(new Date(bars[bars.length - 1].t * 1000)).date
  return bars.filter((b) => etClock(new Date(b.t * 1000)).date === lastDay)
}

/**
 * Batched intraday close series for sparklines: last session's 5-minute closes
 * per symbol. Per-batch failures are skipped — sparklines are decorative.
 */
export async function getSparkSeries(c: RobinhoodMcpClient, symbols: string[]): Promise<Record<string, number[]>> {
  const syms = normSymbols(symbols)
  const out: Record<string, number[]> = {}
  const start = new Date(Date.now() - 4 * 86_400_000).toISOString()
  for (let i = 0; i < syms.length; i += 10) {
    try {
      const batch = await getBarsBatch(c, syms.slice(i, i + 10), start, '5minute')
      for (const [symbol, bars] of Object.entries(batch)) out[symbol] = lastSessionBars(bars).map((b) => b.c).filter((v) => v > 0)
    } catch {
      /* skip failed batch */
    }
  }
  return out
}

