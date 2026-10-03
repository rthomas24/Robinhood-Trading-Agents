import type { ToolCallSummary } from '@shared/agents'
import { MCP_PROVIDERS, ROBINHOOD_TOOL_CATALOG } from '@shared/mcps'

/**
 * How a tool call READS in the thread — pure, so it is easy to test.
 *
 * A tool call used to render as `get_equity_quotes({"symbols":["NVDA","MU"]})`
 * cut at 200 characters: the wire, not the meaning. What the operator wants to
 * know is "it looked up quotes for NVDA and MU, took 300 ms, and here is what it
 * saw" — so every call gets a KIND (which icon), a TITLE (what it did, in words
 * the args make specific) and, when the result is structured, a shape the view
 * can draw (a table of quotes, a key/value card of a position) instead of a wall
 * of JSON. Nothing here is fed back to the model; it is display only.
 */

export type ToolKind = 'trade' | 'market' | 'account' | 'research' | 'memory' | 'plan' | 'exit' | 'watch' | 'talk' | 'report' | 'other'

const OUR_SERVER = 'tb'

/** `mcp__robinhood__get_equity_quotes` → server `robinhood`, tool `get_equity_quotes`. A bare name has no server. */
export function splitToolName(name: string): { server: string | null; tool: string } {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  return m ? { server: m[1], tool: m[2] } : { server: null, tool: name }
}

/** The service a call went to, as the UI names it. */
export function serverLabel(server: string | null): string {
  if (!server || server === OUR_SERVER) return 'Engine'
  if (server === 'robinhood') return 'Robinhood'
  const p = MCP_PROVIDERS.find((x) => x.id === server)
  if (p) return p.name
  return server.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** `get_equity_quotes` → "Get equity quotes". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/^webvector_/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const KIND_BY_TOOL: Record<string, ToolKind> = {
  trade: 'trade',
  cancel_order: 'trade',
  place_equity_order: 'trade',
  place_option_order: 'trade',
  cancel_equity_order: 'trade',
  review_equity_order: 'trade',
  set_exit: 'exit',
  watch_price: 'watch',
  change_plan: 'plan',
  propose_task: 'plan',
  propose_agent: 'plan',
  set_name: 'plan',
  retire: 'plan',
  sleep_until: 'plan',
  remember: 'memory',
  forget: 'memory',
  errand_done: 'memory',
  set_thesis: 'memory',
  search_thread: 'memory',
  ask_operator: 'talk',
  tell_operator: 'talk',
  report: 'report',
  get_accounts: 'account',
  get_portfolio: 'account',
  get_equity_positions: 'account',
  get_option_positions: 'account',
  get_equity_orders: 'account',
  get_equity_tax_lots: 'account',
  get_realized_pnl: 'account',
  get_pnl_trade_history: 'account',
  get_watchlists: 'account',
  get_scans: 'account',
  add_to_watchlist: 'account',
  update_watchlist: 'account',
  create_scan: 'account',
  update_scan_filters: 'account'
}

export function toolKind(name: string): ToolKind {
  const { server, tool } = splitToolName(name)
  const known = KIND_BY_TOOL[tool]
  if (known) return known
  if (server === 'robinhood') return 'market'
  if (server && server !== OUR_SERVER) return 'research'
  if (/search|fetch|news|research|filing|calendar|sentiment|pulse/i.test(tool)) return 'research'
  if (/quote|price|bar|historical|fundamental|indicator|technical|earnings|financial|index|option/i.test(tool)) return 'market'
  return 'other'
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean) : [])
const clip = (s: string, n = 72): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`
const symbols = (a: Record<string, unknown>): string[] => list(a.symbols).length ? list(a.symbols) : list(a.symbol)

/**
 * The one line that says what a call did. Falls back to the catalog label
 * (Robinhood), the provider name, or the humanized tool name — never the raw
 * wire name unless nothing better exists.
 */
export function describeToolCall(call: Pick<ToolCallSummary, 'name' | 'args' | 'input'>): { title: string; detail?: string } {
  const { server, tool } = splitToolName(call.name)
  const a = asRecord(call.args) ?? {}
  const syms = symbols(a)
  const symText = syms.slice(0, 8).join(', ') + (syms.length > 8 ? ` +${syms.length - 8}` : '')

  if (!server || server === OUR_SERVER) {
    switch (tool) {
      case 'trade': {
        const side = str(a.side) === 'sell' ? 'Sell' : 'Buy'
        const qty = num(a.qty) ?? num(a.quantity)
        const notional = num(a.notional) ?? num(a.notionalUsd)
        const size = qty !== undefined ? `${qty} ` : notional !== undefined ? `${usd(notional)} of ` : ''
        const limit = num(a.limitPrice)
        const bits = [limit !== undefined ? `limit ${usd(limit)}` : str(a.orderType) === 'limit' ? 'limit' : 'market']
        if (num(a.stopLoss) !== undefined) bits.push(`stop ${usd(num(a.stopLoss)!)}`)
        if (num(a.takeProfit) !== undefined) bits.push(`target ${usd(num(a.takeProfit)!)}`)
        return { title: `${side} ${size}${str(a.symbol) ?? ''}`.trim(), detail: bits.join(' · ') }
      }
      case 'cancel_order':
        return { title: `Cancel order${str(a.orderId) ? ` ${clip(str(a.orderId)!, 14)}` : ''}` }
      case 'set_exit': {
        const bits: string[] = []
        if (num(a.stop) !== undefined) bits.push(`stop ${usd(num(a.stop)!)}`)
        if (num(a.target) !== undefined) bits.push(`target ${usd(num(a.target)!)}`)
        const trail = asRecord(a.trail)
        if (trail && num(trail.pct) !== undefined) bits.push(`${num(trail.pct)}% trail`)
        if (num(a.trailPct) !== undefined) bits.push(`${num(a.trailPct)}% trail`)
        if (num(a.stopIfBelow) !== undefined) bits.push(`invalidate below ${usd(num(a.stopIfBelow)!)}`)
        if (num(a.stopIfAbove) !== undefined) bits.push(`invalidate above ${usd(num(a.stopIfAbove)!)}`)
        if (str(a.flattenAt)) bits.push(`flatten at ${str(a.flattenAt)}`)
        return { title: `Exit plan${symText ? ` · ${symText}` : ''}`, detail: bits.join(' · ') || undefined }
      }
      case 'watch_price': {
        const watches = Array.isArray(a.watches) ? a.watches.map(asRecord).filter((w): w is Record<string, unknown> => !!w) : [a]
        const one = (w: Record<string, unknown>): string => {
          const cond = str(w.condition) ?? ''
          const level = num(w.level)
          const pct = num(w.pct) ?? num(w.movePct)
          const op = /above|over|gte|>=/.test(cond) ? '≥' : /below|under|lte|<=/.test(cond) ? '≤' : cond ? `${cond} ` : ''
          const at = level !== undefined ? usd(level) : pct !== undefined ? `${pct}%` : ''
          return `${str(w.symbol) ?? ''} ${op}${at}`.trim()
        }
        if (str(a.cancel) || a.cancel === true) return { title: `Cancel watch${symText ? ` · ${symText}` : ''}` }
        return { title: watches.length > 1 ? `Watch ${watches.length} prices` : `Watch ${one(watches[0] ?? {})}`, detail: watches.length > 1 ? watches.map(one).join(' · ') : str(a.note) }
      }
      case 'set_thesis': {
        const theses = Array.isArray(a.theses) ? a.theses.length : 0
        return { title: theses > 1 ? `Thesis · ${theses} symbols` : `Thesis${symText ? ` · ${symText}` : ''}`, detail: str(a.thesis) ? clip(str(a.thesis)!, 120) : undefined }
      }
      case 'remember': {
        const notes = Array.isArray(a.notes) ? (a.notes as unknown[]).filter((n) => typeof n === 'string') : []
        const note = str(a.note) ?? (notes[0] as string | undefined)
        const defer = str(a.defer)
        return { title: notes.length > 1 ? `Remember ${notes.length} notes` : defer ? `Errand · ${defer === 'market_open' ? 'at the open' : 'next run'}` : 'Remember', detail: note ? clip(note, 120) : undefined }
      }
      case 'forget':
        return { title: 'Forget', detail: str(a.match) ?? list(a.matches).join(' · ') }
      case 'errand_done':
        return { title: 'Errand done', detail: str(a.outcome) ? clip(str(a.outcome)!, 120) : undefined }
      case 'change_plan':
        return { title: 'Change plan', detail: str(a.summary) ? clip(str(a.summary)!, 120) : undefined }
      case 'propose_task':
        return { title: 'Propose a task', detail: str(a.task) ? clip(str(a.task)!, 120) : undefined }
      case 'propose_agent':
        return { title: `Propose agent${str(a.name) ? ` “${str(a.name)}”` : ''}`, detail: str(a.task) ? clip(str(a.task)!, 120) : undefined }
      case 'set_name':
        return { title: `Rename${str(a.name) ? ` to “${str(a.name)}”` : ''}` }
      case 'retire':
        return { title: 'Retire', detail: str(a.reason) ? clip(str(a.reason)!, 120) : undefined }
      case 'search_thread':
        return { title: 'Search the thread', detail: str(a.query) ? `“${clip(str(a.query)!, 80)}”` : undefined }
      case 'quotes':
        return { title: `Quotes${symText ? ` · ${symText}` : ''}` }
      case 'bars': {
        const interval = str(a.interval)
        const days = num(a.days)
        const bits = [interval === 'day' ? 'daily' : interval === '5minute' || interval === '5min' ? '5-minute' : interval, days !== undefined ? `${days}d` : undefined].filter(Boolean)
        return { title: `Bars${symText ? ` · ${symText}` : ''}`, detail: bits.join(' · ') || undefined }
      }
      case 'sleep_until':
        return { title: `Sleep until ${str(a.until) ?? '—'}`, detail: str(a.cancel) || a.cancel === true ? 'cancel the sleep' : str(a.reason) ? clip(str(a.reason)!, 120) : undefined }
      case 'ask_operator':
        return { title: 'Ask you', detail: str(a.question) ? clip(str(a.question)!, 120) : undefined }
      case 'tell_operator':
        return { title: str(a.urgency) === 'important' ? 'Tell you · important' : 'Tell you', detail: str(a.message) ? clip(str(a.message)!, 120) : undefined }
      case 'report':
        return { title: 'File the run report', detail: str(a.headline) ? clip(str(a.headline)!, 120) : undefined }
      default:
        return { title: humanizeKey(tool) }
    }
  }

  if (server === 'robinhood') {
    const known = ROBINHOOD_TOOL_CATALOG.find((t) => t.name === tool)
    const label = known?.label ?? humanizeKey(tool)
    const detail = [symText || undefined, str(a.interval) ?? str(a.span), str(a.query) ? `“${clip(str(a.query)!, 60)}”` : undefined].filter(Boolean).join(' · ')
    return { title: symText ? `${label} · ${symText}` : label, detail: detail && detail !== symText ? detail.replace(new RegExp(`^${symText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · `), '') : undefined }
  }

  // Intel servers: WebVector and friends. The query or URL is the whole story.
  const q = str(a.query) ?? str(a.q) ?? str(a.question)
  const url = str(a.url)
  const label = humanizeKey(tool)
  if (url) return { title: `${label} · ${clip(url.replace(/^https?:\/\//, ''), 60)}` }
  if (q) return { title: label, detail: `“${clip(q, 100)}”` }
  if (symText) return { title: `${label} · ${symText}` }
  return { title: label }
}

/* ── Result shapes ─────────────────────────────────────────────────────────── */

export type ParsedResult = { kind: 'json'; value: unknown } | { kind: 'text'; text: string }

/**
 * A result is JSON if the whole thing parses — a tool that answered with prose
 * (or JSON followed by our truncation notice) is text, and rendered as such.
 */
export function parseToolResult(text: string): ParsedResult {
  const t = text.trim()
  if (!t) return { kind: 'text', text: '' }
  if (/^[[{]/.test(t)) {
    try {
      return { kind: 'json', value: JSON.parse(t) }
    } catch {
      /* not JSON after all */
    }
  }
  return { kind: 'text', text }
}

export type Scalar = string | number | boolean | null

export const isScalar = (v: unknown): v is Scalar => v === null || ['string', 'number', 'boolean'].includes(typeof v)

/** Rows a table can draw: a list of flat objects with a shared, modest key set. */
export function tabularRows(value: unknown): { columns: string[]; rows: Record<string, unknown>[] } | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 500) return null
  const rows = value.map(asRecord)
  if (rows.some((r) => !r)) return null
  const cols = new Map<string, number>()
  for (const r of rows as Record<string, unknown>[]) for (const k of Object.keys(r)) cols.set(k, (cols.get(k) ?? 0) + 1)
  if (cols.size === 0 || cols.size > 14) return null
  // Every row must be mostly scalar, or a table hides more than it shows.
  const scalarShare = (rows as Record<string, unknown>[]).map((r) => Object.values(r).filter(isScalar).length / Math.max(1, Object.keys(r).length))
  if (scalarShare.some((s) => s < 0.6)) return null
  return { columns: [...cols.keys()], rows: rows as Record<string, unknown>[] }
}

/** A short scalar for a table cell or key/value row. Numbers keep their precision; long strings are clipped by the view. */
export function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 6 })
  if (typeof v === 'string') {
    // Robinhood's wire numerics are strings; show them as numbers when they are.
    if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 20) {
      const n = Number(v)
      return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 6 })
    }
    return v
  }
  return JSON.stringify(v)
}

/** "1.2 s" / "340 ms". */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** Pretty JSON, bounded so one 12 KB blob cannot lock the thread while it lays out. */
export function prettyJson(value: unknown, maxChars = 40_000): string {
  let s: string
  try {
    s = JSON.stringify(value, null, 2) ?? ''
  } catch {
    s = String(value)
  }
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n…` : s
}

/* ── Verdicts ──────────────────────────────────────────────────────────────── */

/** What each glyph MEANS, in one word — an icon on its own is not a name. */
export const KIND_LABEL: Record<ToolKind, string> = {
  trade: 'Order',
  market: 'Market data',
  account: 'Account',
  research: 'Research',
  memory: 'Memory',
  plan: 'Plan',
  exit: 'Exit plan',
  watch: 'Price watch',
  talk: 'Message',
  report: 'Report',
  other: 'Tool'
}

export type CallStatus = 'ok' | 'blocked' | 'error' | 'pending'

export interface CallVerdict {
  status: CallStatus
  /** Two words at most, for the row's badge. */
  label: string
  /**
   * The refusal's family, as the thread names it. The decision log
   * (`agents:decisions`) holds the canonical `DecisionRule`; the engine hands
   * the MODEL a sentence rather than a key, so this is derived from that
   * sentence's own distinctive opening and never guessed at.
   */
  rule: string | null
  /** The exact sentence the agent was given instead of a result. */
  sentence?: string
}

/** The literal openings `core/runner` uses, mapped to the rule they belong to. */
const BLOCK_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^HELD FOR APPROVAL/, 'approval.held'],
  [/^You already have an action waiting/, 'approval.alreadyPending'],
  [/^NOT DONE —/, 'approval.outsideScope'],
  [/^Loop guard:/, 'loop.repeatedCall'],
  [/^Blocked by your guardrails:/, 'guardrails.rejected'],
  [/^This run has ended/, 'run.ended']
]

/** A step the run never got to — `NOT_RUN_MSG` in `core/runner/runOnce.ts`. */
const NEVER_RAN = /^Did not run — the run ended/

/**
 * Ran, refused, failed, or never answered — decided once, so the row badge,
 * the pane heading and the auto-open rule can never disagree about a call.
 */
export function callVerdict(call: Pick<ToolCallSummary, 'blocked' | 'error' | 'output' | 'result'>): CallVerdict {
  if (call.blocked) {
    const rule = BLOCK_RULES.find(([re]) => re.test(call.blocked!))?.[1] ?? null
    return { status: 'blocked', label: 'held back', rule, sentence: call.blocked }
  }
  const text = call.result ?? call.output
  if (call.error) {
    const never = !!text && NEVER_RAN.test(text.trim())
    return { status: 'error', label: never ? 'never ran' : 'failed', rule: never ? 'run.notRun' : null, sentence: text }
  }
  if (text === undefined) return { status: 'pending', label: 'no result', rule: null }
  return { status: 'ok', label: 'ok', rule: null }
}

/** Rows the operator should not have to go looking for: open these, collapse the rest. */
export const demandsAttention = (call: Pick<ToolCallSummary, 'blocked' | 'error' | 'output' | 'result'>): boolean => {
  const s = callVerdict(call).status
  return s === 'blocked' || s === 'error'
}

/* ── Quotes ────────────────────────────────────────────────────────────────── */

export interface QuoteChip {
  symbol: string
  price?: number
  changePct?: number
  /**
   * Bid, ask and the previous close, currency symbol and wording intact, as the
   * engine wrote them. The view renders this as TEXT beside the chip and never
   * as a tooltip: the spread is how an operator judges whether a fill will land
   * anywhere near the price the model decided against, and a figure that can
   * only be reached by hovering is a figure the app did not state.
   */
  detail?: string
}

/**
 * A price list is the one result that reads better as chips than as a grid: the
 * same `TickerChip` the sidebar, the receipts and the portfolio panel use, so a
 * symbol looks the same everywhere it appears.
 *
 * `caption` and `rest` exist so nothing is dropped on the way — the engine's
 * "QUOTES (market CLOSED …)" heading and its "Could not price: X." tail are the
 * two sentences an operator most needs beside the numbers.
 */
export interface QuoteView {
  chips: QuoteChip[]
  caption?: string
  /**
   * The caption says these prices are not live. It is a warning about every
   * number under it, not a label for them, so the view gives it the warn
   * treatment rather than caption styling.
   */
  captionStale: boolean
  rest: string[]
}

/** `NVDA: last $118.20 · bid $118.18 · ask $118.22 · +0.63% vs prev close` */
const QUOTE_LINE = /^([A-Z][A-Z.\-]{0,6}):\s+last\s+\$?([\d,]+(?:\.\d+)?)\b(.*)$/
const QUOTE_MOVE = /([+-]?\d+(?:\.\d+)?)%\s*vs prev close/

/**
 * The engine's own heading when the tape is not live — `runOnce.ts` writes
 * "QUOTES (market CLOSED — last trades, not live prices)" and `prompts.ts`
 * "treat them as stale". Recognised by what it SAYS, because a heading earns
 * the warn treatment by warning, not by ending in a colon.
 */
const STALE_QUOTES = /\bstale\b|not live prices|last trades|market (?:closed|pre|after)/i

/** The tools whose whole answer IS a price list. Anything else has to look like one. */
const QUOTE_TOOL = /^(?:quotes|get_(?:equity|index|option|crypto)_quotes)$/

export const isQuoteTool = (name: string): boolean => QUOTE_TOOL.test(splitToolName(name).tool)

/** A price, with its currency, at the precision a quote is quoted in. */
const priceText = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`

const toNum = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
const firstNum = (...vs: unknown[]): number | undefined => {
  for (const v of vs) {
    const n = toNum(v)
    if (n !== undefined) return n
  }
  return undefined
}

/** More than this and a grid is the honest shape — chips stop being scannable. */
const MAX_CHIPS = 40

function quoteRowsFromJson(value: unknown): QuoteChip[] | null {
  const arr = Array.isArray(value) ? value : (asRecord(value)?.results ?? asRecord(value)?.quotes)
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > MAX_CHIPS) return null
  const chips: QuoteChip[] = []
  for (const row of arr) {
    const r = asRecord(row)
    if (!r) return null
    const q = asRecord(r.quote) ?? r
    const symbol = str(r.symbol) ?? str(q.symbol) ?? str(r.ticker)
    if (!symbol) return null
    const price = firstNum(q.last_trade_price, q.last_non_reg_trade_price, r.last, r.price, r.last_price, q.previous_close)
    if (price === undefined) return null
    const prev = firstNum(q.adjusted_previous_close, q.previous_close, asRecord(r.close)?.price, r.prevClose, r.previous_close)
    const given = firstNum(r.changePct, r.change_pct, r.change_percent)
    const bid = firstNum(q.bid_price, r.bid)
    const ask = firstNum(q.ask_price, r.ask)
    chips.push({
      symbol: symbol.toUpperCase(),
      price,
      changePct: given ?? (prev && price ? ((price - prev) / prev) * 100 : undefined),
      detail:
        [bid !== undefined ? `bid ${priceText(bid)}` : undefined, ask !== undefined ? `ask ${priceText(ask)}` : undefined, prev !== undefined ? `prev close ${priceText(prev)}` : undefined]
          .filter(Boolean)
          .join(' · ') || undefined
    })
  }
  return chips.length ? chips : null
}

/**
 * Chips, but only for a result that really IS a price list.
 *
 * The first cut captured any text containing one `SYM: last $N` line, so a news
 * summary or a filing that happened to quote a price was re-emitted as a chip
 * plus every other line flattened into unstyled prose. A result now has to come
 * from a quotes tool, or be MOSTLY quote lines, to be drawn as one.
 */
export function quoteView(parsed: ParsedResult, toolName?: string): QuoteView | null {
  const fromQuoteTool = toolName !== undefined && isQuoteTool(toolName)
  if (parsed.kind === 'json') {
    const chips = quoteRowsFromJson(parsed.value)
    return chips ? { chips, captionStale: false, rest: [] } : null
  }
  const lines = parsed.text.split('\n')
  const chips: QuoteChip[] = []
  const rest: string[] = []
  let caption: string | undefined
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const m = QUOTE_LINE.exec(line)
    if (m) {
      const price = Number(m[2].replace(/,/g, ''))
      const move = QUOTE_MOVE.exec(m[3])
      // The rest of the line verbatim — bid, ask and "vs prev close", with the
      // currency the engine printed. Kept as text, not folded into a tooltip.
      const detail = m[3].replace(/^\s*·\s*/, '').trim()
      chips.push({ symbol: m[1], price: Number.isFinite(price) ? price : undefined, changePct: move ? Number(move[1]) : undefined, detail: detail || undefined })
      continue
    }
    // The heading sits above the numbers and is about all of them. Recognised by
    // POSITION rather than by a trailing colon, so a staleness warning that ends
    // in a full stop is still read as the heading it is.
    if (caption === undefined && !chips.length) caption = line.replace(/:\s*$/, '')
    else rest.push(line)
  }
  if (!chips.length || chips.length > MAX_CHIPS) return null
  if (!fromQuoteTool && chips.length <= rest.length) return null
  return { chips, caption, captionStale: caption !== undefined && STALE_QUOTES.test(caption), rest }
}

/** The totals for the collapsed header: how many, how long, how many refused/failed. */
export function activitySummary(calls: readonly ToolCallSummary[]): { count: number; blocked: number; failed: number; durationMs: number | null; kinds: ToolKind[] } {
  let blocked = 0
  let failed = 0
  let duration = 0
  let timed = false
  const kinds: ToolKind[] = []
  for (const c of calls) {
    if (c.blocked) blocked++
    else if (c.error) failed++
    if (c.durationMs !== undefined) {
      duration += c.durationMs
      timed = true
    }
    const k = toolKind(c.name)
    if (!kinds.includes(k)) kinds.push(k)
  }
  return { count: calls.length, blocked, failed, durationMs: timed ? duration : null, kinds }
}
