import { armExitPlan, exitSpecOf, fillEconomics, flattenDue, hasExitSpec, type AgentConfig, type AgentState, type ExitTrigger, type Fill, type PriceWatch, type RunTrigger, type TradeAction, type TradeIntent } from '@shared/agents'
import { etClock, formatEt, isRegularSession, OPEN_MINUTES } from '@shared/marketTime'
import { flattenBackingOff, flattenRefusalRepeats } from '@shared/retirement'
import { robinhoodFeed, type PriceFeed } from '../market/feed'
// `getQuotes` is no longer imported here: every quote a fill needs comes
// through the run's `PriceFeed`, so the broker layer has no direct Robinhood call.
import type { Quote } from '@shared/ipc'
import type { RobinhoodMcpClient } from '../robinhood/mcp'
import { awaitOrder, cancelEquityOrder, getOrders, placeEquityOrder, TERMINAL_OK, TERMINAL_REJECT } from '../robinhood/api'
import { checkGuardrails, ledgerFor, positionQty, recentLossIn } from './guardrails'
import type { DecisionInput, DecisionRule } from '@shared/decisions'
import { applyFill, cancelPaperOrder, execPrice, markToMarket, submitPaperOrder, toPaperQuotes, type PaperQuote, type SettledOrder } from './paper'

/**
 * Execute a validated trade intent for an agent and return the resulting action
 * plus the updated state. The MODEL never reaches this directly — only via the
 * `trade` tool, and only after guardrails pass here.
 */
export interface ExecContext {
  config: AgentConfig
  state: AgentState
  /** Robinhood client (null when not connected — paper still works with stale quotes). */
  rh: RobinhoodMcpClient | null
  accountNumber: string | null
  /** Quotes already fetched this run (used as fallback). */
  quotes: Quote[]
  /**
   * The ACCOUNT's buying power (live) — Robinhood's own number, which in a cash
   * account already excludes unsettled proceeds. The account-wide backstop; the
   * per-agent settlement rule is `settle.unsettled` in guardrails.
   */
  buyingPower?: number | null
  now?: Date
  /** What started the run — only widens the daily order cap for operator-driven exits. */
  trigger?: RunTrigger
  /** Optional run log. Used for conditions an operator would want to see but the model cannot act on. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * Sink for the AUTHORITATIVE guardrail decision — the one every order passes,
   * including the ones no model asked for.
   *
   * The runner audits its own pre-check, which covers the model's `trade` tool
   * and nothing else. `enforceExits`, `executeRetirement` and the desktop watch
   * tick all reach `executeTrade` directly, so a protective sell refused by
   * `price.missing`, `session.closed` or `position.none` was refused in silence
   * — and "why didn't it sell at 3:58?" is the question the decision log exists
   * to answer. It could not answer it about the engine.
   *
   * Optional so hosts adopt it independently; a host that passes nothing logs
   * nothing and behaves exactly as before.
   */
  audit?: (d: DecisionInput) => void
  /** The broker account's type (`"cash"` / `"margin"`) for the settlement rule; unknown = the agent's own setting. */
  brokerAccountType?: string | null
  /** The account-wide halt. `undefined` = could not read it, and the rule does not fire. */
  tradingHalted?: boolean
  /** Is there a broker connection at all? `false` turns "no price" into the real reason. */
  brokerConnected?: boolean
  /**
   * Where a fresh quote comes from when `quotes` lacks the symbol. Robinhood
   * when the operator has it; the market-data feed for a paper agent without one.
   * Absent = derive from `rh` (every caller that predates the feed).
   */
  feed?: PriceFeed | null
  /** This run's technicals for a symbol (VWAP, day open), for the entry-extension rule. */
  technicalsFor?: (symbol: string) => { vwap?: number | null; dayOpen?: number | null } | null
  /** What this run has already bought — kept by the host under its lane, read here by the per-run rules. */
  run?: { newPositions: number; boughtSymbols: readonly string[] }
  /** The run placing this order, stamped on its fills (`Fill.runId`) so outcomes can be scored back to decisions. Engine sweeps pass none. */
  runId?: string
}

export interface ExecResult {
  action: TradeAction
  state: AgentState
  /** Fills produced (paper or live). */
  fills: Fill[]
  /** The guardrail rule that decided (for the decision log). */
  rule?: DecisionRule
  /**
   * Things the caller should tell the model that are not failures — an argument
   * that was accepted but had no effect, for instance. Silently dropping such an
   * argument teaches the model the call worked.
   */
  notes?: string[]
  /**
   * A BUY that changed the effective stop of a plan already on the position
   * (an add re-seeding a trail's high, a new fixed stop on top of an old one).
   * The host posts it as a system note: the card describes the ORDER, and a
   * stop moving is bookkeeping the operator would otherwise never see.
   */
  stopMoved?: { symbol: string; from: number | undefined; to: number | undefined }
}

/**
 * Labels for orders the ENGINE initiated, so the log distinguishes them from a
 * tool call. A protective sell has no tool name — nobody called anything.
 */
export const ENGINE_TRADE = 'engine__trade'
export const ENGINE_PROTECTIVE_EXIT = 'engine__protective_exit'
export const ENGINE_RETIREMENT = 'engine__retirement'

async function freshQuote(ctx: ExecContext, symbol: string): Promise<Quote | null> {
  const feed = ctx.feed ?? (ctx.rh ? robinhoodFeed(ctx.rh) : null)
  if (feed) {
    try {
      const q = (await feed.quotes([symbol])).quotes
      if (q[0]?.last > 0) return q[0]
    } catch {
      /* fall back */
    }
  }
  return ctx.quotes.find((q) => q.symbol === symbol) ?? null
}

/**
 * Record/clear engine-enforced exits as fills land. The merge itself is
 * `armExitPlan` (shared): a trail seeds its high at the price actually paid —
 * and on an ADD at `max(previous high, fill)`, so buying a dip can never lower
 * a stop that was already armed — and a level the intent does not mention is a
 * level it is not asking to change.
 */
function applyExitBookkeeping(state: AgentState, mode: AgentConfig['mode'], symbol: string, intent: TradeIntent, now: Date, fillPrice?: number): { state: AgentState; stopMoved?: ExecResult['stopMoved'] } {
  const held = positionQty(ledgerFor({ mode }, state), symbol)
  if (intent.side === 'buy' && hasExitSpec(intent)) {
    const prev = state.exits[symbol]
    const { plan, stopMoved } = armExitPlan(prev, exitSpecOf(intent), fillPrice, now.toISOString())
    return { state: { ...state, exits: { ...state.exits, [symbol]: plan } }, ...(stopMoved ? { stopMoved: { symbol, ...stopMoved } } : {}) }
  }
  if (intent.side === 'sell' && held <= 1e-9 && state.exits[symbol]) {
    const exits = { ...state.exits }
    delete exits[symbol]
    return { state: { ...state, exits } }
  }
  return { state }
}

/**
 * Arm the exits an order was placed with, now that it has actually filled.
 *
 * A stop attached to a buy that fills instantly is armed by
 * `applyExitBookkeeping` on the spot. One that rests — the overnight bid, the
 * order that most needs protection — used to lose its stop entirely, because
 * the exit was only ever written on the immediate-fill path. The exits ride on
 * the order instead, and this arms them when the fill lands.
 *
 * Only buys arm exits, and an order whose position has already gone is skipped:
 * an exit for something you no longer hold is a sell order waiting to happen.
 */
export function applyExitsForFills(state: AgentState, mode: AgentConfig['mode'], settled: SettledOrder[], now: Date): AgentState {
  let next = state
  for (const o of settled) {
    if (o.side !== 'buy') continue
    if (!hasExitSpec(o)) continue
    if (positionQty(ledgerFor({ mode }, next), o.symbol) <= 1e-9) continue
    // The SAME merge as the immediate-fill path: seeded at the price this order
    // actually paid, ratcheting an existing high rather than replacing it.
    const { plan } = armExitPlan(next.exits[o.symbol], exitSpecOf(o), o.fillPrice, now.toISOString())
    next = { ...next, exits: { ...next.exits, [o.symbol]: plan } }
  }
  return next
}

function bumpOrdersToday(state: AgentState, now: Date): AgentState {
  const today = etClock(now).date
  const count = state.ordersToday.date === today ? state.ordersToday.count + 1 : 1
  return { ...state, ordersToday: { date: today, count } }
}

export async function executeTrade(
  ctx: ExecContext,
  intent: TradeIntent,
  opts: { protective?: boolean; auditAs?: string; exitTrigger?: ExitTrigger } = {}
): Promise<ExecResult> {
  const now = ctx.now ?? new Date()
  const symbol = intent.symbol.toUpperCase()
  /**
   * Exits describe how to LEAVE a position, so they only mean anything on the
   * way in. Attached to a sell they were accepted and dropped without a word,
   * which reads to the model as "the protective sell is armed" — the most
   * dangerous thing it could wrongly believe.
   */
  const auditAs = opts.auditAs ?? ENGINE_TRADE
  const exitOnSell = intent.side === 'sell' && hasExitSpec(intent)
  const notes = exitOnSell
    ? ['stopLoss/takeProfit/trailPct (and the other exit levels) were ignored: exits attach to a BUY (or use set_exit on the open position). This sell was placed without them.']
    : undefined
  /**
   * Stamp what the track record and the post-mortem need onto the fill itself
   *: the entry's trail and extension, the reason, and — for an
   * engine sell — which exit fired. The fill object is the one the ledger
   * holds, so the stamp lands in the book.
   */
  const stampFill = (fill: Fill | undefined): void => {
    if (!fill) return
    const tech = intent.side === 'buy' ? ctx.technicalsFor?.(symbol) : null
    const ext = tech?.vwap && tech.vwap > 0 ? Math.round(((fill.price - tech.vwap) / tech.vwap) * 10000) / 100 : undefined
    Object.assign(fill, {
      ...(intent.side === 'buy' && intent.trailPct !== undefined ? { trailPct: intent.trailPct } : {}),
      ...(ext !== undefined ? { extensionPct: ext } : {}),
      ...(intent.reason ? { reason: intent.reason.slice(0, 120) } : {}),
      ...(opts.exitTrigger ? { engineExit: opts.exitTrigger.kind } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {})
    })
  }
  /** Trigger vs fill, frozen onto an engine exit's card: (level − fill) × shares, positive = worse than the level. */
  const withTrigger = (fillPrice: number | undefined, fillQty: number | undefined): { exitTrigger?: ExitTrigger } => {
    if (!opts.exitTrigger) return {}
    const t = opts.exitTrigger
    if (fillPrice === undefined || fillQty === undefined || t.kind === 'flatten') return { exitTrigger: t }
    return { exitTrigger: { ...t, slippageUsd: Math.round((t.level - fillPrice) * fillQty * 100) / 100 } }
  }
  const quote = await freshQuote(ctx, symbol)
  const pq: PaperQuote | null = quote ? { last: quote.last, bid: quote.bid, ask: quote.ask } : null
  // The guardrail checks the price the order will actually use. A paper fill
  // happens at `execPrice` — the quote side PLUS the slippage model — and
  // checking the raw ask while filling slipped let a cap-sized buy land a few
  // dollars over maxOrderNotional. execPrice is deterministic, so check and fill agree
  // to the cent. Live keeps the raw side price: a live fill is the market's
  // answer, and the cap there is honestly a check-time bound.
  // Rounded to 4dp exactly as the paper fill itself is, so check and fill use
  // the SAME number — not merely close ones.
  const sideRef = quote ? (ctx.config.mode === 'paper' && pq ? Math.round(execPrice(pq, intent.side) * 1e4) / 1e4 : intent.side === 'buy' ? (quote.ask ?? quote.last) : (quote.bid ?? quote.last)) : null
  // A buy that re-enters a name just sold at a loss carries that fact onto its
  // card: inside the agent's cooldown window when it has one, else
  // the last hour. Read before the fill, because the fill is what appends.
  const loss = intent.side === 'buy' ? recentLossIn(ledgerFor(ctx.config, ctx.state), symbol, ctx.config.guardrails.reentryCooldownMin || 60, now) : null
  const base: TradeAction = { ...intent, symbol, mode: ctx.config.mode, status: 'rejected', refPrice: sideRef ?? undefined, ...(loss ? { reentry: { minutesAfter: loss.minutesAgo, lossUsd: Math.round(Math.abs(loss.realized) * 100) / 100 } } : {}) }

  const verdict = checkGuardrails({ config: ctx.config, state: ctx.state, intent: { ...intent, symbol }, refPrice: sideRef, now, protective: opts.protective, trigger: ctx.trigger, brokerAccountType: ctx.brokerAccountType, tradingHalted: ctx.tradingHalted, brokerConnected: ctx.brokerConnected, technicals: ctx.technicalsFor?.(symbol) ?? null, run: ctx.run })
  // Recorded HERE, where the decision is actually made, rather than by each
  // caller — a caller that forgets is exactly how the engine's own refusals
  // went unrecorded in the first place.
  if (!verdict.ok) {
    ctx.audit?.({ tool: auditAs, outcome: 'blocked', rule: verdict.rule ?? 'guardrails.rejected', detail: verdict.reason })
    return { action: { ...base, status: 'rejected', error: verdict.reason }, state: ctx.state, fills: [], rule: verdict.rule }
  }
  // The 'allowed' record is written when the order actually goes somewhere —
  // filled, resting, or handed to the broker — never at the verdict. The old
  // order of events logged `allowed · ok` and then execution failed (no quote,
  // no broker, zero whole shares), so the one log built to answer "why didn't
  // it sell?" answered "it did". Every post-verdict rejection writes a blocked
  // record with its own rule instead.
  const auditOk = (): void =>
    ctx.audit?.({ tool: auditAs, outcome: 'allowed', rule: verdict.rule ?? 'ok', detail: `${intent.side} ${intent.qty ?? `$${intent.notional}`} ${symbol} ${intent.type}` })
  const auditExecFail = (rule: DecisionRule, detail: string): void => ctx.audit?.({ tool: auditAs, outcome: 'blocked', rule, detail })
  const qty = verdict.qty!

  // ── Paper ──────────────────────────────────────────────────────────────
  if (ctx.config.mode === 'paper') {
    if (!pq) {
      auditExecFail('exec.noQuote', 'No quote available to simulate the fill.')
      return { action: { ...base, error: 'No quote available to simulate the fill.' }, state: ctx.state, fills: [] }
    }
    const r = submitPaperOrder(
      ctx.state.paper,
      { symbol, side: intent.side, qty, type: intent.type, limitPrice: intent.limitPrice, tif: intent.tif === 'gtc' ? 'gtc' : 'day', ...exitSpecOf(intent) },
      pq
    )
    auditOk()
    stampFill(r.fill)
    let state = bumpOrdersToday({ ...ctx.state, paper: r.ledger }, now)
    let stopMoved: ExecResult['stopMoved']
    if (r.fill) {
      const b = applyExitBookkeeping(state, 'paper', symbol, intent, now, r.fill.price)
      state = b.state
      stopMoved = b.stopMoved
    }
    const action: TradeAction = {
      ...base,
      qty,
      status: r.fill ? 'filled' : 'open',
      fillPrice: r.fill?.price,
      fillQty: r.fill?.qty,
      orderId: r.order.id,
      // Frozen at the fill: the card must keep telling the truth about this
      // moment even after later trades move the position.
      ...(r.fill ? { econ: fillEconomics(ctx.state.paper, r.ledger, r.fill) } : {}),
      ...withTrigger(r.fill?.price, r.fill?.qty)
    }
    return { action, state, fills: r.fill ? [r.fill] : [], notes, ...(stopMoved ? { stopMoved } : {}) }
  }

  // ── Live (Robinhood) ───────────────────────────────────────────────────
  if (!ctx.rh || !ctx.accountNumber) {
    auditExecFail('exec.noBroker', 'Robinhood is not connected (no agentic account).')
    return { action: { ...base, error: 'Robinhood is not connected (no agentic account).' }, state: ctx.state, fills: [] }
  }
  if (intent.side === 'buy' && ctx.buyingPower != null && qty * (sideRef ?? 0) > ctx.buyingPower + 1e-6) {
    const why = `Order ($${(qty * (sideRef ?? 0)).toFixed(2)}) exceeds the Robinhood account's buying power ($${ctx.buyingPower.toFixed(2)}) — the whole account's, shared by every agent, and in a cash account net of unsettled proceeds.`
    auditExecFail('live.buyingPower', why)
    return { action: { ...base, qty, error: why }, state: ctx.state, fills: [] }
  }
  const regular = isRegularSession(now)
  const marketHours = regular ? 'regular_hours' : 'extended_hours'
  // Fractional/dollar orders are regular-hours market only; limit orders whole shares.
  let liveQty = intent.type === 'limit' || !regular ? Math.floor(qty) : Math.floor(qty * 1e6) / 1e6
  if (!(liveQty > 0)) {
    auditExecFail('live.zeroShares', 'Order rounds to zero whole shares for a live limit order.')
    return { action: { ...base, error: 'Order rounds to zero whole shares for a live limit order.' }, state: ctx.state, fills: [] }
  }

  // Execution quality: convert live MARKET orders to MARKETABLE LIMITS when the
  // size is >= 1 share — immediate fill with price protection (per Robinhood's
  // own guidance). Sub-share orders stay market (fractional needs market type).
  let orderType: 'market' | 'limit' = intent.type
  let limitPrice = intent.limitPrice
  const round2 = (n: number): number => Math.round(n * 100) / 100
  // An all-in buy goes as a DOLLAR-amount market order: whole-share rounding
  // (below) would leave part of the book idle, which is the one thing the mode
  // exists not to do. Fractional/dollar orders are regular-session market only,
  // which is when this mode buys. The fill is booked from what executed.
  const dollarAmount = intent.allIn && intent.side === 'buy' && orderType === 'market' && regular && intent.notional && intent.notional > 0 ? round2(intent.notional) : undefined
  if (!dollarAmount && orderType === 'market' && regular && sideRef && Math.floor(liveQty) >= 1) {
    orderType = 'limit'
    limitPrice = intent.side === 'buy' ? round2(sideRef * 1.0015) : round2(sideRef * 0.9985)
    liveQty = Math.floor(liveQty)
  }

  const placed = await placeEquityOrder(ctx.rh, {
    accountNumber: ctx.accountNumber,
    symbol,
    side: intent.side,
    type: orderType,
    ...(dollarAmount ? { dollarAmount } : { qty: liveQty }),
    limitPrice,
    tif: intent.tif === 'gtc' ? 'gtc' : 'gfd',
    marketHours
  })
  const placedBase: TradeAction = { ...base, type: orderType, limitPrice, qty: liveQty }
  // The guardrails ALLOWED this and the broker refused it — a second decision,
  // by someone else, and the sink above fired before the order was ever sent so
  // it cannot see this one. Recorded here rather than by the caller because the
  // engine's own orders have no caller that audits: `host.trade` covers the
  // model's, but `enforceExits` and `executeRetirement` go straight through, and
  // a protective sell Robinhood refuses is the sharpest form of "why didn't it
  // sell at 3:58?" there is.
  if (!placed.ok) {
    ctx.audit?.({ tool: auditAs, outcome: 'blocked', rule: 'broker.rejected', detail: placed.detail })
    return { action: { ...placedBase, status: 'rejected', error: placed.detail, orderId: placed.orderId }, state: ctx.state, fills: [] }
  }
  // The broker accepted the order: that is the moment "allowed" became true in
  // the world, whatever the fill ends up being.
  auditOk()
  let state = bumpOrdersToday(ctx.state, now)
  // Poll briefly for a terminal state; book the fill at the REAL average price.
  const snap = placed.orderId ? await awaitOrder(ctx.rh, ctx.accountNumber, placed.orderId, { timeoutMs: 15_000 }) : null
  if (snap && TERMINAL_REJECT.test(snap.state)) {
    ctx.audit?.({ tool: auditAs, outcome: 'blocked', rule: 'broker.rejected', detail: `Robinhood ${snap.state}` })
    return { action: { ...placedBase, status: 'rejected', orderId: placed.orderId, error: `Robinhood ${snap.state}` }, state, fills: [] }
  }
  if (snap && TERMINAL_OK.test(snap.state)) {
    const px = snap.avgPrice ?? sideRef ?? quote?.last ?? 0
    const fq = snap.filledQty || liveQty
    const r = applyFill(state.live, { symbol, side: intent.side, qty: fq, price: px, orderId: placed.orderId })
    stampFill(r.fill)
    const b = applyExitBookkeeping({ ...state, live: r.ledger }, 'live', symbol, intent, now, px)
    state = b.state
    return { action: { ...placedBase, status: 'filled', fillPrice: px, fillQty: fq, orderId: placed.orderId, econ: fillEconomics(ctx.state.live, r.ledger, r.fill), ...withTrigger(px, fq) }, state, fills: [r.fill], notes, ...(b.stopMoved ? { stopMoved: b.stopMoved } : {}) }
  }
  // Still open (limit resting, or slow fill): record as open; reconcile on later runs.
  state = {
    ...state,
    live: {
      ...state.live,
      openOrders: [
        ...state.live.openOrders,
        { id: placed.orderId ?? `rh_${Date.now().toString(36)}`, ts: now.toISOString(), symbol, side: intent.side, qty: liveQty, type: orderType, limitPrice, ...exitSpecOf(intent), status: 'open' }
      ]
    }
  }
  return { action: { ...placedBase, status: 'open', orderId: placed.orderId }, state, fills: [], notes }
}

export async function executeCancel(ctx: ExecContext, orderId: string): Promise<{ ok: boolean; detail: string; state: AgentState }> {
  if (ctx.config.mode === 'paper') {
    const r = cancelPaperOrder(ctx.state.paper, orderId)
    return { ok: r.cancelled, detail: r.cancelled ? `Cancelled paper order ${orderId}.` : `No open paper order ${orderId}.`, state: { ...ctx.state, paper: r.ledger } }
  }
  if (!ctx.rh || !ctx.accountNumber) return { ok: false, detail: 'Robinhood not connected.', state: ctx.state }
  const own = ctx.state.live.openOrders.some((o) => o.id === orderId)
  if (!own) return { ok: false, detail: `Order ${orderId} is not one of this agent's open orders.`, state: ctx.state }
  const r = await cancelEquityOrder(ctx.rh, ctx.accountNumber, orderId)
  const state = r.ok ? { ...ctx.state, live: { ...ctx.state.live, openOrders: ctx.state.live.openOrders.filter((o) => o.id !== orderId) } } : ctx.state
  return { ok: r.ok, detail: r.detail, state }
}

/**
 * Cancel any broker-side protective order that has outlived its position.
 *
 * This is the safety property of broker-side stops, not their housekeeping. A
 * resting sell for shares nobody holds will, if it fills, open a SHORT in an
 * account that cannot short — days later, with nobody watching. That is a worse
 * outcome than the overnight gap the resting order exists to close, so every
 * path that takes a position to zero has to cancel it, and this is the net that
 * catches the paths nobody thought of: the operator selling in the Robinhood
 * app, a retirement liquidation, a target firing before the stop.
 *
 * Called from `reconcileLiveOpenOrders` so it runs on every live run, rather
 * than being a call each new code path has to remember. It was a bare export
 * for a while and nothing ever called it, which is the precise failure this
 * function exists to prevent.
 *
 * A failed cancel deliberately KEEPS the plan. Dropping it would forget the
 * order exists and leave it resting and unkillable; keeping it means the next
 * run tries again.
 */
export async function reconcileBrokerStops(ctx: ExecContext): Promise<AgentState> {
  let state = ctx.state
  for (const [symbol, plan] of Object.entries(state.exits)) {
    if (plan.enforcedBy !== 'broker') continue
    if (positionQty(ledgerFor(ctx.config, state), symbol) > 1e-9) continue
    if (plan.brokerOrderId && ctx.rh && ctx.accountNumber) {
      const r = await cancelEquityOrder(ctx.rh, ctx.accountNumber, plan.brokerOrderId)
      if (!r.ok) {
        ctx.log?.('error', `could not cancel the resting ${symbol} stop ${plan.brokerOrderId} after the position closed — it is still working at the broker: ${r.detail}`)
        continue
      }
      ctx.log?.('info', `cancelled the resting ${symbol} stop ${plan.brokerOrderId}; the position is closed`)
    }
    const exits = { ...state.exits }
    delete exits[symbol]
    state = { ...state, exits }
  }
  return state
}

/**
 * Reconcile this agent's LIVE open orders against Robinhood: book fills that
 * completed since last run, drop cancelled/rejected ones. Never mirrors the
 * whole account.
 */
export async function reconcileLiveOpenOrders(ctx: ExecContext): Promise<{ state: AgentState; fills: Fill[]; settled: SettledOrder[] }> {
  if (ctx.config.mode !== 'live' || !ctx.rh || !ctx.accountNumber) return { state: ctx.state, fills: [], settled: [] }
  const open = ctx.state.live.openOrders
  // No open orders still needs the orphan sweep: the paths that strand a resting
  // stop (a sale in the Robinhood app, a retirement, a target that already fired)
  // leave nothing open behind them, so returning early here would skip the one
  // check that catches them.
  if (open.length === 0) return { state: await reconcileBrokerStops(ctx), fills: [], settled: [] }
  let ledger = ctx.state.live
  const fills: Fill[] = []
  const settled: SettledOrder[] = []
  const remaining: typeof open = []
  for (const o of open) {
    try {
      const snap = (await getOrders(ctx.rh, ctx.accountNumber, { orderId: o.id }))[0]
      if (snap && TERMINAL_OK.test(snap.state)) {
        // `?? 0` here booked shares at ZERO when Robinhood reported a filled
        // order without an average price and the order carried no limit — free
        // stock, a corrupted average cost, and every realized P&L after it
        // wrong, permanently and silently. An unresolvable price is a reason to
        // wait for the next reconcile, not to invent one.
        const price = snap.avgPrice ?? o.limitPrice
        if (typeof price !== 'number' || !(price > 0)) {
          ctx.log?.('warn', `order ${o.id} (${o.side} ${o.qty} ${o.symbol}) reported ${snap.state} with no usable price — left open rather than booked at 0`)
          remaining.push(o)
          continue
        }
        const r = applyFill(ledger, { symbol: o.symbol, side: o.side, qty: snap.filledQty || o.qty, price, orderId: o.id })
        ledger = r.ledger
        fills.push(r.fill)
        settled.push({ ...o, status: 'filled', fillPrice: price })
      } else if (snap && TERMINAL_REJECT.test(snap.state)) {
        // dropped
      } else {
        remaining.push(o)
      }
    } catch {
      remaining.push(o)
    }
  }
  // Exits ride on the order, so a resting buy that fills here gets the stop it
  // was placed with — the whole point of #2.
  const state = applyExitsForFills({ ...ctx.state, live: { ...ledger, openOrders: remaining } }, 'live', settled, ctx.now ?? new Date())
  // After the fills, not before: a sell booked above is exactly what takes a
  // position to zero and strands its resting stop.
  return { state: await reconcileBrokerStops({ ...ctx, state }), fills, settled }
}

/* ── Watches & engine-enforced exits ─────────────────────────────────── */

export interface FiredWatch {
  watch: PriceWatch
  price: number
  description: string
}

/**
 * Does this watch fire at this price? Pure and exported so a sweep can test
 * many watches against a quote WITHOUT loading each agent's full state — it
 * only needs to touch the agents that actually fired.
 */
export function watchHit(w: PriceWatch, last: number): boolean {
  if (!(last > 0)) return false
  switch (w.condition) {
    case 'above':
      return last >= w.value
    case 'below':
      return last <= w.value
    case 'move_up_pct':
      return w.baseline > 0 && last >= w.baseline * (1 + w.value / 100)
    case 'move_down_pct':
      return w.baseline > 0 && last <= w.baseline * (1 - w.value / 100)
  }
}

/** What the operator reads in the thread when a watch fires. */
export function describeWatch(w: PriceWatch, last: number): string {
  const cond =
    w.condition === 'above'
      ? `>= $${w.value}`
      : w.condition === 'below'
        ? `<= $${w.value}`
        : `${w.condition === 'move_up_pct' ? '+' : '-'}${w.value}% from $${w.baseline.toFixed(2)}`
  return `${w.symbol} hit ${cond} — now $${last.toFixed(2)}${w.note ? ` (${w.note})` : ''}`
}

/** Pure: evaluate price watches against quotes; fired watches are removed. */
export function fireWatches(state: AgentState, quotes: Quote[]): { state: AgentState; fired: FiredWatch[] } {
  if (!state.watches.length) return { state, fired: [] }
  const qmap = new Map(quotes.map((q) => [q.symbol, q.last]))
  const fired: FiredWatch[] = []
  const remaining: PriceWatch[] = []
  for (const w of state.watches) {
    const last = qmap.get(w.symbol)
    if (last === undefined || !watchHit(w, last)) {
      remaining.push(w)
      continue
    }
    fired.push({ watch: w, price: last, description: describeWatch(w, last) })
  }
  return fired.length ? { state: { ...state, watches: remaining }, fired } : { state, fired: [] }
}

/**
 * Enforce stop/target exit plans: market-sell the agent's whole position when a
 * quote breaches its stop or target. Deterministic engine code — no model.
 * Caller gates on the regular session (protective sells are market orders).
 *
 * RETURNS A NEW `state` OBJECT IFF SOMETHING CHANGED, and the caller's own
 * object otherwise. This is a contract, not an implementation detail: the
 * watch sweep decides whether to write the state on `ex.state !== state`,
 * because the common case is many ticks that change nothing and must not each
 * cost a write. Returning `{ ...state }` unconditionally would write on every tick
 * for every agent; mutating in place would never write at all. Both fail
 * silently. Note that selling is NOT the only change — the trail ratchet and
 * dropping a plan whose position is gone both change state while selling
 * nothing, and this is the only place either happens.
 *
 * `scripts/checks/check-exit-sweep.ts` asserts this identity behaviour; run it
 * if you touch this function.
 */
export async function enforceExits(ctx: ExecContext): Promise<{ state: AgentState; results: ExecResult[] }> {
  let state = ctx.state
  const now = ctx.now ?? new Date()
  const results: ExecResult[] = []
  const qmap = new Map(ctx.quotes.map((q) => [q.symbol, q.last]))
  // The daily-loss lock, judged on the SWEEP as well as at run start. The lock used to be computed only when the agent ran;
  // an interval agent could carry an open position through a −8% morning and
  // only find out at its next wake-up, having already bought more. Mark-to-
  // market from the day's opening anchor — realized AND unrealized — and the
  // anchor itself is set only at run start, so a day nobody ran has no anchor
  // and no lock, which is the honest reading.
  //
  // A lock set here is set OUTSIDE a run, so the thread has not been told and
  // the fast path has not seen it: `buyLockNotice` carries both until `runOnce`
  // consumes it at the next run start. Without it the sweep's lock landed
  // silently — the run-start check saw `buyLockDate` already set and said
  // nothing, and a quiet interval tick could skip the model right past it.
  const lock = dailyLossLock(ctx.config, state, ctx.quotes, now)
  if (lock) state = { ...state, buyLockDate: lock.date, buyLockNotice: lock }
  for (const [symbol, plan0] of Object.entries(state.exits)) {
    const ledger = ledgerFor(ctx.config, state)
    const held = positionQty(ledger, symbol)
    if (held <= 1e-9) {
      // A dead position's plan is dropped here — and this is the ONLY thing that
      // ever cleans one up, which is why the broker check below sits AFTER it
      // rather than before. Skipping broker-owned symbols first would remove the
      // one cleanup path and leak the exit forever: nothing errors, nothing
      // logs, and the agent goes on being told it is protected on a position it
      // no longer holds.
      //
      // The exception is a broker-owned plan, which is left standing on purpose:
      // dropping it would forget the resting order and orphan it. reconcileBrokerStops
      // cancels the order FIRST and only then drops the plan.
      if (plan0.enforcedBy === 'broker') continue
      const exits = { ...state.exits }
      delete exits[symbol]
      state = { ...state, exits }
      continue
    }
    // A resting order at the broker owns this symbol. Enforcing it here too
    // would sell twice on one dip, and the second sale is a naked short in an
    // account that cannot short.
    if (plan0.enforcedBy === 'broker') continue
    const last = qmap.get(symbol)
    if (last === undefined || !(last > 0)) continue

    // Ratchet the trail BEFORE deciding, and write it back even on the runs
    // where nothing sells — that persistence IS the feature. `high` only ever
    // rises, so a bad tick can lower the stop but never raise it into a healthy
    // position. An unseeded trail starts at the first price the engine sees.
    let plan = plan0
    if (plan.trail) {
      const high = Math.max(plan.trail.high || 0, last)
      if (high !== plan.trail.high) {
        plan = { ...plan, trail: { ...plan.trail, high } }
        state = { ...state, exits: { ...state.exits, [symbol]: plan } }
      }
    }

    // Break-even ratchet: once the position is up `breakEvenAfterPct` from its
    // average cost, the fixed stop moves UP to that cost. One-way, like the
    // trail's high — a stop already above cost is left alone. Persisted on the
    // tick it happens, whether or not anything sells.
    if (plan.breakEvenAfterPct !== undefined && plan.breakEvenAfterPct > 0) {
      const entry = ledger.positions.find((p) => p.symbol === symbol)?.avgCost ?? 0
      if (entry > 0 && last >= entry * (1 + plan.breakEvenAfterPct / 100) && (plan.stop === undefined || plan.stop < entry)) {
        plan = { ...plan, stop: entry }
        state = { ...state, exits: { ...state.exits, [symbol]: plan } }
      }
    }

    const clock = etClock(now)
    // Opening-range grace: the TRAIL is not judged until `armAfterMin` minutes
    // into the session. It still ratchets above; only its verdict waits. The
    // hard stop, the invalidation levels, the target and the flatten time are
    // unaffected — a grace period for noise is not a grace period for a thesis
    // that is already wrong.
    const trailArmed = !(plan.armAfterMin && plan.armAfterMin > 0) || clock.minutes - OPEN_MINUTES >= plan.armAfterMin
    const trailStop = plan.trail && plan.trail.high > 0 && trailArmed ? plan.trail.high * (1 - plan.trail.pct / 100) : undefined
    const invalidation = plan.stopIf?.below
    // The binding stop is the TIGHTEST of the three, and the reason names which
    // one it was: "trailing", "protective" and "invalidation" mean different
    // things to whoever reads the thread afterwards.
    const candidates: { level: number; kind: ExitTrigger['kind'] }[] = []
    if (plan.stop !== undefined) candidates.push({ level: plan.stop, kind: 'stop' })
    if (trailStop !== undefined) candidates.push({ level: trailStop, kind: 'trail' })
    if (invalidation !== undefined && invalidation > 0) candidates.push({ level: invalidation, kind: 'invalidation' })
    const binding = candidates.length ? candidates.reduce((a, b) => (b.level > a.level ? b : a)) : null
    let reason: string | null = null
    let trigger: ExitTrigger | null = null
    let sellQty = held
    let partial = false
    if (binding && last <= binding.level) {
      trigger = { kind: binding.kind, level: binding.level }
      reason =
        binding.kind === 'trail'
          ? `Trailing stop hit: $${last.toFixed(2)} <= $${binding.level.toFixed(2)} (${plan.trail!.pct}% below the $${plan.trail!.high.toFixed(2)} high)`
          : binding.kind === 'invalidation'
            ? `Invalidation: ${plan.stopIf!.reason} — $${last.toFixed(2)} <= $${binding.level}`
            : `Protective stop hit: $${last.toFixed(2)} <= stop $${binding.level}`
    } else if (plan.stopIf?.above !== undefined && plan.stopIf.above > 0 && last >= plan.stopIf.above) {
      trigger = { kind: 'invalidation', level: plan.stopIf.above }
      reason = `Invalidation: ${plan.stopIf.reason} — $${last.toFixed(2)} >= $${plan.stopIf.above}`
    } else if (plan.target !== undefined && last >= plan.target) {
      trigger = { kind: 'target', level: plan.target }
      const pct = plan.targetPct !== undefined && plan.targetPct > 0 && plan.targetPct < 100 ? plan.targetPct : 100
      partial = pct < 100
      sellQty = partial ? Math.round(held * (pct / 100) * 1e6) / 1e6 : held
      reason = `Profit target hit: $${last.toFixed(2)} >= target $${plan.target}${partial ? ` (selling ${pct}% of the position)` : ''}`
    } else if (plan.flattenAt) {
      // Flatten time: at or after the named ET minute, out at market whatever
      // the price is doing. Judged last so a stop or target that fires on the
      // same tick is reported as what it was. `flattenDue` reads the minute as
      // the first one AFTER the plan was set — a plan armed at 15:58 for
      // "09:31" means the next open, not a minute already gone.
      if (flattenDue(plan, clock)) {
        trigger = { kind: 'flatten', level: last }
        reason = `Flatten time reached (${plan.flattenAt} ET): closing the position at $${last.toFixed(2)}`
      }
    }
    if (!reason || !trigger || !(sellQty > 0)) continue
    const r = await executeTrade({ ...ctx, state }, { side: 'sell', symbol, qty: sellQty, type: 'market', tif: 'day', reason }, { protective: true, auditAs: ENGINE_PROTECTIVE_EXIT, exitTrigger: trigger })
    state = r.state
    if (r.action.status === 'filled' || r.action.status === 'open') {
      const exits = { ...state.exits }
      if (partial) {
        // The remainder keeps every other level; only the target that just
        // fired is spent, so it cannot fire again on the shares that stay.
        const rest = { ...exits[symbol] }
        delete rest.target
        delete rest.targetPct
        exits[symbol] = rest
      } else delete exits[symbol]
      state = { ...state, exits }
    }
    results.push(r)
  }
  return { state, results }
}

/**
 * Is today's mark-to-market drawdown from the day's opening equity past the
 * guardrail? Returns the lock to write, or null. Pure; `runOnce` and
 * `enforceExits` both use it, so the run-start check and the sweep cannot
 * disagree about what "down 5% today" means.
 */
export function dailyLossLock(cfg: AgentConfig, state: AgentState, quotes: Quote[], now: Date): { date: string; lossPct: number } | null {
  const today = etClock(now).date
  if (!state.dayAnchor || state.dayAnchor.date !== today || state.buyLockDate === today || !quotes.length) return null
  const ledger = ledgerFor(cfg, state)
  // Judged only on a COMPLETE mark. `markToMarket` prices an unquoted position
  // at its cost, so a book half-priced reads as half-flat: the sweep quotes only
  // the symbols with exits or watches, and a lock set from that would be a
  // verdict on a book it never saw. No quote for a held name → no verdict.
  const quoted = new Set(quotes.map((q) => q.symbol))
  if (ledger.positions.some((p) => p.qty > 1e-9 && !quoted.has(p.symbol))) return null
  const { equity } = markToMarket(ledger, toPaperQuotes(quotes))
  const lossPct = ((state.dayAnchor.equity - equity) / Math.max(1, cfg.allocationUsd)) * 100
  return lossPct >= cfg.guardrails.maxDailyLossPct ? { date: today, lossPct } : null
}

/** The thread note for a daily-loss lock — one sentence whichever path set the lock. */
export function dailyLossLockNote(lossPct: number): string {
  return `⛔ Daily loss limit hit (−${lossPct.toFixed(1)}% of allocation today, marked to market). Buying is disabled until the next trading day; sells and protective exits still work.`
}

/* ── Retirement ──────────────────────────────────────────────────────── */

/** Total P&L in USD = book equity (marked at these quotes) − allocation. */
export function totalPnlUsd(cfg: AgentConfig, state: AgentState, quotes: Quote[]): number {
  const ledger = ledgerFor(cfg, state)
  let mv = 0
  const qmap = new Map(quotes.map((q) => [q.symbol, q.last]))
  for (const p of ledger.positions) mv += p.qty * (qmap.get(p.symbol) ?? p.avgCost)
  return ledger.cash + mv - cfg.allocationUsd
}

/** The retirement reason when a policy condition is met right now, else null. */
export function retirementDue(cfg: AgentConfig, state: AgentState, quotes: Quote[], now: Date): string | null {
  const r = cfg.retirement
  if (!r || state.status === 'retired') return null
  // A flatten refused a moment ago is not due again until its retry instant
  // (`shared/retirement.ts`): in-session a bounded wait, otherwise the next
  // open. Asking sooner learns nothing and, in the loop this replaced, cost a
  // broker call and an important notification per wake-up all night.
  if (flattenBackingOff(state, now)) return null
  // ET, like every other time a person reads in a thread. `toLocaleString()`
  // would render whatever zone the host happens to be in — the same deadline,
  // two different sentences on two machines.
  if (r.at && now.getTime() >= new Date(r.at).getTime()) return `Deadline reached (${formatEt(r.at, true)})`
  if (r.profitTargetUsd !== undefined || r.maxLossUsd !== undefined) {
    const pnl = totalPnlUsd(cfg, state, quotes)
    if (r.profitTargetUsd !== undefined && pnl >= r.profitTargetUsd) return `Profit target reached (+$${pnl.toFixed(2)} >= $${r.profitTargetUsd})`
    if (r.maxLossUsd !== undefined && pnl <= -r.maxLossUsd) return `Max loss reached (−$${Math.abs(pnl).toFixed(2)})`
  }
  return null
}

/** Sell every position in the agent's book (protective market sells). */
export async function flattenAll(ctx: ExecContext): Promise<{ state: AgentState; results: ExecResult[] }> {
  let state = ctx.state
  const results: ExecResult[] = []
  for (const p of [...ledgerFor(ctx.config, state).positions]) {
    const r = await executeTrade({ ...ctx, state }, { side: 'sell', symbol: p.symbol, qty: p.qty, type: 'market', tif: 'day', reason: 'Flattened for retirement' }, { protective: true, auditAs: ENGINE_RETIREMENT })
    state = r.state
    results.push(r)
  }
  return { state, results }
}

/**
 * Retire the agent: optionally flatten (session permitting), clear watches, and
 * mark the state. Exit plans on any REMAINING position are kept — the watcher
 * still enforces stops for retired agents so nothing is left unprotected.
 *
 * A retirement that WANTS to flatten and cannot does not retire. "Retired" with an open position used to be an agent that had
 * stopped deciding while its book was still moving; now it stays alive, says
 * which positions are open and why, keeps every exit armed, and is tried
 * again when `shared/retirement.ts` says it may be. `retired: false` + `open`
 * is that outcome; the host posts `open` as a note — important the first time
 * that day (`repeat: false`), quiet on later refusals in the same stretch.
 * The refusal is stamped on the returned state (`flattenRefusedAt`) so every
 * caller that saves the state also records the back-off.
 */
export async function executeRetirement(ctx: ExecContext, reason: string, now: Date): Promise<{ state: AgentState; results: ExecResult[]; note: string | null; retired: boolean; open?: { symbol: string; qty: number; why: string }[]; repeat?: boolean }> {
  let state = ctx.state
  let results: ExecResult[] = []
  let note: string | null = null
  const wantFlatten = ctx.config.retirement?.flatten !== false
  const ledger = ledgerFor(ctx.config, state)
  const refused = (open: { symbol: string; qty: number; why: string }[]): { state: AgentState; results: ExecResult[]; note: null; retired: false; open: typeof open; repeat: boolean } => ({
    state: { ...state, flattenRefusedAt: now.toISOString() },
    results,
    note: null,
    retired: false,
    open,
    repeat: flattenRefusalRepeats(ctx.state.flattenRefusedAt, now)
  })
  if (wantFlatten && ledger.positions.length) {
    if (isRegularSession(now) || ctx.config.mode === 'paper') {
      const f = await flattenAll({ ...ctx, state })
      state = f.state
      results = f.results
      const open = f.results.filter((r) => r.action.status !== 'filled' && r.action.status !== 'open').map((r) => ({ symbol: r.action.symbol, qty: r.action.qty ?? 0, why: r.action.error ?? 'refused' }))
      if (open.length) {
        ctx.audit?.({ tool: ENGINE_RETIREMENT, outcome: 'blocked', rule: 'retire.cannotFlatten', detail: open.map((o) => `${o.symbol}: ${o.why}`).join('; ').slice(0, 200) })
        return refused(open)
      }
    } else {
      const open = ledger.positions.map((p) => ({ symbol: p.symbol, qty: p.qty, why: 'the market is closed — a market sell cannot be placed until the regular session' }))
      ctx.audit?.({ tool: ENGINE_RETIREMENT, outcome: 'blocked', rule: 'retire.cannotFlatten', detail: 'market closed' })
      return refused(open)
    }
  }
  state = {
    ...state,
    status: 'retired',
    retiredAt: now.toISOString(),
    retireReason: reason,
    nextRunAt: null,
    watches: [],
    running: false
  }
  return { state, results, note, retired: true }
}

/** The important note a refused retirement posts: which positions are open and why, and what happens next. */
export function cannotFlattenNote(reason: string, open: { symbol: string; qty: number; why: string }[]): string {
  return `⚠️ Retirement due (${reason}) but NOT retired: ${open.map((o) => `${o.qty} ${o.symbol} (${o.why})`).join('; ')}. Exits stay armed and the agent stays alive; it will try to flatten again when the session allows (at the next open if the market is closed). Sell from the thread or Robinhood if you want it flat sooner.`
}
