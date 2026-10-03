import { effectiveStop, ledgerFor, money, type AgentConfig, type AgentState, type Ledger, type RunTrigger, type TradeIntent } from '@shared/agents'
import { etClock, formatMinutes, isExtendedSession, isRegularSession, parseHHMM } from '@shared/marketTime'
import { isAttended, type GuardrailRule } from './../../shared/decisions'
import { describeUnsettled, settledCash, settlementModeFor, unsettledCash } from '@shared/settlement'
import { isEarningsPop } from '@shared/earningsPlaybook'

/**
 * Deterministic, engine-side validation of a trade intent against the agent's
 * guardrails and its OWN book. The model proposes; this decides. Pure.
 */
export interface GuardrailVerdict {
  ok: boolean
  reason?: string
  /**
   * Stable machine key for the rule that decided — what the audit log records.
   * A closed union, so a renamed or invented key fails the build rather than
   * silently changing the log's vocabulary.
   */
  rule?: GuardrailRule
  /** Resolved share quantity (after notional → qty conversion). */
  qty?: number
}

export interface GuardrailInput {
  config: AgentConfig
  state: AgentState
  intent: TradeIntent
  /** Current price for the symbol (ask for buys / bid for sells preferred). */
  refPrice: number | null
  now?: Date
  /** Engine-initiated protective exit (stop/target): skips the daily order cap. */
  protective?: boolean
  /**
   * What started the run. The daily ORDER cap exists to bound a runaway
   * autonomous agent, not to trap the operator: when a person is driving
   * (manual/reply) an exit is always allowed to go through. Buys are never
   * exempt, and no other limit moves.
   */
  trigger?: RunTrigger
  /**
   * The trading halt (`AppSettings.tradingHalted`) — the operator's panic
   * switch, spanning every agent.
   *
   * `undefined` means the HOST DOES NOT IMPLEMENT this control — not that a read
   * failed. The rule then does not fire, because a host with no such switch has
   * no halt to honour.
   *
   * A host that DOES implement it decides for itself what an unreadable flag
   * means, and should answer `true`: since this refuses buys only, failing
   * closed costs a missed buy — recoverable, with sells and stops still
   * working — while failing open means the panic button is silently ignored,
   * and that one is not recoverable because the money has already moved.
   */
  tradingHalted?: boolean
  /**
   * Is there a broker connection at all for this run?
   *
   * `false` is a different fact from "the quote did not arrive", and the two
   * used to produce the same sentence. An agent with no Robinhood connection
   * (and no market-data feed) gets no client, so the whole quote block is
   * skipped and EVERY order is refused with "No price available for TSLA" —
   * which blames the price feed and sends the operator to look at market data,
   * when the cause is that this agent has no broker. Undefined = the host does not distinguish, and the old message
   * stands.
   */
  brokerConnected?: boolean
  /**
   * The broker account's type as `get_accounts` reports it (`"cash"` /
   * `"margin"`), for the settlement rule. A LIVE agent follows this when it is
   * known — the broker's truth beats the agent's setting — and falls back to
   * `guardrails.settlement` when it is not. Ignored for paper, whose book
   * simulates whichever mode the agent is set to.
   */
  brokerAccountType?: string | null
  /**
   * This run's computed technicals for the intent's symbol, for the entry-
   * extension rule. Absent or null = not computed this run, and the rule does
   * not fire: refusing a buy on a number we do not have is a guess.
   */
  technicals?: { vwap?: number | null; dayOpen?: number | null } | null
  /**
   * What THIS RUN has already bought, for the per-run rules. Kept by the host
   * under the run's exclusive lane, so concurrent tool calls cannot race past
   * `maxNewPositionsPerRun`. Absent = a host with no run scope (the sweeps).
   */
  run?: { newPositions: number; boughtSymbols: readonly string[] }
}

export { ledgerFor }

/** The most recent LOSING sell in a symbol inside the cooldown window, if any. */
export function recentLossIn(ledger: Ledger, symbol: string, cooldownMin: number, now: Date): { realized: number; ts: string; minutesAgo: number } | null {
  const since = now.getTime() - cooldownMin * 60_000
  for (let i = ledger.fills.length - 1; i >= 0; i--) {
    const f = ledger.fills[i]
    const t = Date.parse(f.ts)
    if (t < since) break
    if (f.symbol === symbol && f.side === 'sell' && f.realized < 0) return { realized: f.realized, ts: f.ts, minutesAgo: Math.round((now.getTime() - t) / 60_000) }
  }
  return null
}

/** Dollars of buys in this symbol on the ET date of `now`. */
export function boughtTodayIn(ledger: Ledger, symbol: string, now: Date): number {
  const today = etClock(now).date
  let sum = 0
  for (let i = ledger.fills.length - 1; i >= 0; i--) {
    const f = ledger.fills[i]
    if (etClock(new Date(f.ts)).date !== today) break
    if (f.symbol === symbol && f.side === 'buy') sum += f.qty * f.price
  }
  return sum
}

/**
 * An exit level that is ALREADY BREACHED at entry is not protection — it is an
 * instruction to liquidate, wearing protection's clothes.
 *
 * This is the engine-side half of a real approval bypass. A stop above the
 * market fires on the very next sweep, and that sale is a protective exit: it
 * skips the daily order cap, sells the WHOLE position at
 * market, and is never held for approval because the engine initiated it. So a
 * one-share buy the operator approved could arm a stop above the market and
 * liquidate everything, with no card for the part that mattered.
 *
 * Refusing the ORDER rather than dropping the level is deliberate. Opening a
 * position whose protection we know cannot work is the worse of the two
 * outcomes, and a rejection the model can read and correct beats a silent
 * downgrade it will believe worked.
 *
 * Returns a reason, or null when the plan is coherent. Exported so every path
 * that can arm an exit checks the same rule — `set_exit` writes `state.exits`
 * directly and never reaches `checkGuardrails`.
 */
export function exitLevelProblem(levels: { stop?: number; target?: number }, entry: number): string | null {
  if (!(entry > 0)) return null
  if (levels.stop !== undefined && levels.stop >= entry) {
    return `A stop at $${levels.stop} is at or above the $${entry.toFixed(2)} price — it would fire immediately and market-sell the whole position. A stop has to sit BELOW the price to protect anything.`
  }
  if (levels.target !== undefined && levels.target <= entry) {
    return `A profit target at $${levels.target} is at or below the $${entry.toFixed(2)} price — it would fire immediately. A target has to sit ABOVE the price.`
  }
  if (levels.stop !== undefined && levels.target !== undefined && levels.target <= levels.stop) {
    return `A target of $${levels.target} at or below the stop of $${levels.stop} cannot work — whichever fires first, the other never can.`
  }
  return null
}

export function positionQty(ledger: Ledger, symbol: string): number {
  return ledger.positions.find((p) => p.symbol === symbol)?.qty ?? 0
}

export function ordersTodayCount(state: AgentState, now: Date = new Date()): number {
  const today = etClock(now).date
  return state.ordersToday.date === today ? state.ordersToday.count : 0
}

export function checkGuardrails(input: GuardrailInput): GuardrailVerdict {
  const { config, state, intent } = input
  const now = input.now ?? new Date()
  const g = config.guardrails
  const symbol = intent.symbol.trim().toUpperCase()

  if (!symbol || !/^[A-Z.\-]{1,10}$/.test(symbol)) return { ok: false, rule: 'symbol.invalid', reason: `Invalid symbol "${intent.symbol}".` }
  if (g.allowedSymbols.length && !g.allowedSymbols.map((s) => s.toUpperCase()).includes(symbol)) {
    return { ok: false, rule: 'symbol.notAllowed', reason: `${symbol} is not in this agent's allowed symbols (${g.allowedSymbols.join(', ')}).` }
  }

  if (state.status === 'retired' && !input.protective) {
    return { ok: false, rule: 'agent.retired', reason: 'This agent is retired — respawn it before trading.' }
  }

  if (config.mode === 'live' && !config.liveArmedAt) {
    return { ok: false, rule: 'live.notArmed', reason: 'Live trading is not armed for this agent. The operator must arm it in Settings.' }
  }

  // The account-wide halt. BUYS ONLY, and live only — the same shape as the
  // daily-loss breaker below, for the same reason.
  //
  // A halt that also blocked sells would trap every open position at the moment
  // its owner reached for the panic switch: the stop could not fire, the target
  // could not fire, and "sell everything" would be refused by the control they
  // pressed to make themselves safer. Being unable to get out is worse than the
  // thing this guards against. So it stops the direction that adds risk and
  // leaves every exit open, and the UI says exactly that rather than letting
  // "halt trading" imply more than it does.
  //
  // Paper is untouched: it moves no money, and taking away the one safe place to
  // keep working would be a cost with no matching benefit.
  if (input.tradingHalted && config.mode === 'live' && intent.side === 'buy') {
    return {
      ok: false,
      rule: 'account.tradingHalted',
      reason: 'Live trading is halted — the operator turned it off in Settings → Trading safety. No new positions can be opened on any agent until they turn it back on. Selling, stops and take-profits still work. Do not retry; say what you would have done and why.'
    }
  }

  // Session gating.
  const regular = isRegularSession(now)
  if (!regular) {
    if (g.marketHoursOnly) return { ok: false, rule: 'session.marketHoursOnly', reason: 'Outside the regular session (09:30–16:00 ET) and this agent is market-hours only.' }
    if (!g.allowExtendedHours) return { ok: false, rule: 'session.extendedNotAllowed', reason: 'Outside the regular session and extended-hours trading is not allowed for this agent.' }
    if (!isExtendedSession(now)) return { ok: false, rule: 'session.closed', reason: 'Market is closed (not even extended hours).' }
    if (intent.type !== 'limit') return { ok: false, rule: 'session.limitOnly', reason: 'Only limit orders are allowed in extended hours.' }
  }

  // Daily order cap. Protective engine exits are exempt — never trap a position —
  // and so is an operator-driven SELL: the cap bounds an autonomous agent, and a
  // person asking to get out should not be told the agent has traded enough today.
  const operatorExit = intent.side === 'sell' && input.trigger !== undefined && isAttended(input.trigger)
  if (!input.protective && !operatorExit && ordersTodayCount(state, now) >= g.maxOrdersPerDay) {
    return { ok: false, rule: 'cap.ordersPerDay', reason: `Daily order cap reached (${g.maxOrdersPerDay}/day).` }
  }

  // The pattern-day-trader rule used to be checked here (`cap.dayTrades`). It
  // was abolished on 2026-06-04 — see the retired key in `shared/decisions.ts`
  // — and a sell is no longer refused for being a fourth round trip.

  // Sizing.
  const ref = input.refPrice ?? intent.limitPrice ?? null
  if (!ref || !(ref > 0)) {
    // Name the CAUSE, not the symptom. Without a broker there are no quotes for
    // any symbol, so reporting a missing price per symbol turns one structural
    // problem into a stream of identical rejections that each look transient.
    if (input.brokerConnected === false) {
      return {
        ok: false,
        rule: 'broker.notConnected',
        reason: `This agent has no Robinhood connection, so it cannot price ${symbol} or place anything — in paper OR live. Tell the operator to connect Robinhood under Settings → Connections (or, for paper trading, to add an Alpaca market-data key there). Do not retry other symbols; none of them will work either.`
      }
    }
    return { ok: false, rule: 'price.missing', reason: `No price available for ${symbol} to size the order.` }
  }
  // A limit order with no price is not a market order — it is an order that can
  // NEVER fill. `submitPaperOrder`'s marketable test requires a limitPrice, so
  // one that slipped through would rest as unfillable forever while the model
  // believed it was riding a breakout it had never actually entered.
  if (intent.type === 'limit' && !(intent.limitPrice && intent.limitPrice > 0)) {
    return { ok: false, rule: 'limit.missingPrice', reason: 'A limit order needs limitPrice > 0 — without one it can never fill. Give limitPrice, or use type "market".' }
  }
  let qty = intent.qty ?? 0
  if (!(qty > 0)) {
    if (!(intent.notional && intent.notional > 0)) return { ok: false, rule: 'size.missing', reason: 'Provide qty or notional > 0.' }
    qty = intent.notional / ref
    // Round the way the EXECUTOR will (core/broker/execute.ts): Robinhood takes
    // fractional/dollar orders as regular-session MARKET orders; a limit order,
    // or anything outside the regular session, is whole shares. This used to
    // floor every live order to whole shares, so a $100 market buy of a $650
    // name was refused here as "less than one share" while the engine two
    // files over would have placed it — and an agent that reads that refusal
    // as "no fractional fills" asks the operator to raise its cap and never
    // buys anything.
    const wholeSharesOnly = config.mode === 'live' && (intent.type === 'limit' || !regular)
    qty = wholeSharesOnly ? Math.floor(qty) : config.mode === 'live' ? Math.floor(qty * 1e6) / 1e6 : Math.floor(qty * 10_000) / 10_000
    if (!(qty > 0)) {
      return {
        ok: false,
        rule: 'size.belowOneShare',
        reason: `Notional $${intent.notional} is less than one share of ${symbol} at $${ref.toFixed(2)}, and a live ${intent.type === 'limit' ? 'LIMIT order' : 'order outside the regular session'} must be whole shares. A MARKET order in the regular session may be fractional — use that, or a size of at least one share.`
      }
    }
  }
  /**
   * Exit levels, against a LIVE reference. A limit buy fills at or below its
   * limit, so the tightest defensible entry is the lower of the two — a stop
   * below today's ask but above the limit price would still be breached the
   * moment the order actually fills.
   *
   * Trails are exempt by construction, not by omission: the engine seeds the
   * high from the fill price and the model cannot supply it, so a trail's stop
   * always starts strictly below the entry.
   */
  // An invalidation level below is a stop by another name, and is judged as
  // one here: the tightest of the two is what the sweep will hit first.
  const stopLevels = [intent.stopLoss, intent.stopIf?.below].filter((n): n is number => typeof n === 'number' && n > 0)
  const intentStop = stopLevels.length ? Math.max(...stopLevels) : undefined
  if (intent.side === 'buy' && (intentStop !== undefined || intent.takeProfit !== undefined || intent.stopIf?.above !== undefined)) {
    const entry = intent.type === 'limit' && intent.limitPrice ? Math.min(ref, intent.limitPrice) : ref
    const problem = exitLevelProblem({ stop: intentStop, target: intent.takeProfit }, entry)
    if (problem) return { ok: false, rule: 'exit.invalidLevel', reason: problem }
    if (intent.stopIf?.above !== undefined && intent.stopIf.above <= entry) {
      return { ok: false, rule: 'exit.invalidLevel', reason: `An invalidation level ABOVE at $${intent.stopIf.above} is at or below the $${entry.toFixed(2)} price — it would fire immediately. It has to sit ABOVE the price.` }
    }

    /**
     * Judge the plan that will actually EXIST, not the half this call names.
     * The fill merges into any plan already on the position, so a target that
     * is fine on its own can still invert against a stop set earlier, and a
     * stop set at a higher price can already be breached at today's. Checking
     * only the fragment misses both.
     *
     * `effectiveStop` rather than `prev.stop`, because a trail set earlier is a
     * stop too — buying into a position the engine is about to liquidate is the
     * same mistake whichever field says so.
     */
    const prev = state.exits[symbol]
    if (prev) {
      const merged = { stop: intentStop ?? effectiveStop(prev), target: intent.takeProfit ?? prev.target }
      const after = exitLevelProblem(merged, entry)
      if (after) {
        return {
          ok: false,
          rule: 'exit.invalidLevel',
          reason: `${after} That is ${symbol}'s exit plan AFTER merging with the one already on the position — this buy would inherit it. Fix or clear that plan with set_exit first.`
        }
      }
    }
  }

  const notional = qty * ref
  // BUYS only. The per-order cap bounds how much new exposure one order may
  // take on; a sell reduces exposure and can never be the thing it guards
  // against. Same shape as `lock.dailyLoss` and `cap.positionNotional` below,
  // both of which are already buy-only for the same reason.
  //
  // Applying it to sells did not merely restrict them, it TRAPPED positions.
  // `maxPositionNotional` may exceed `maxOrderNotional` — it does by default
  // ($12,500 vs $3,750) — so an agent can build a position over several orders
  // that it then cannot exit in one — e.g. $7,500 of one name against a
  // $3,750 order cap, trying to flatten before the close and refused every run.
  //
  // Worse than the refusals, and the reason this is a correctness fix rather
  // than an ergonomic one: `enforceExits` places protective sells through this
  // same function, and there is no `protective` exemption here. Both of those
  // positions carried an ARMED trailing stop that the operator could see on the
  // card. Neither could ever have fired. A stop that cannot execute is not a
  // stop, and nothing anywhere said so.
  //
  // Safe because a sell is clamped to the held position a few lines below, so
  // exempting it can never sell more than the agent owns.
  // An all-in earnings agent's every buy IS its whole book (`shared/earningsPlaybook.ts`):
  // the fixed per-order and per-symbol caps would freeze it at its first
  // allocation after a winning trade. Its bound is the book itself — the cash
  // and settled-cash checks below still apply in full.
  const allInBook = isEarningsPop(config)
  if (intent.side === 'buy' && !allInBook && notional > g.maxOrderNotional + 1e-6) {
    return { ok: false, rule: 'cap.orderNotional', reason: `Order notional $${notional.toFixed(2)} exceeds the per-order cap of $${g.maxOrderNotional}.` }
  }

  // Daily loss circuit breaker: no new buys for the rest of the ET day.
  if (intent.side === 'buy' && state.buyLockDate === etClock(now).date) {
    return { ok: false, rule: 'lock.dailyLoss', reason: `Daily loss limit (${g.maxDailyLossPct}% of allocation) was hit today — buying is disabled until the next trading day. Sells and protective exits remain allowed.` }
  }

  const ledger = ledgerFor(config, state)
  const held = positionQty(ledger, symbol)

  // ── Entry discipline: BUYS ONLY. ──
  // Every one of these bounds how a position is OPENED; none can ever trap
  // one. Absent field = no rule, so an agent made before they existed is
  // untouched. Each is checked before the sizing caps because each is a
  // reason the order should not exist at all, whatever its size.
  if (intent.side === 'buy') {
    const clock = etClock(now)
    const windowMin = g.noEntriesBeforeEt ? parseHHMM(g.noEntriesBeforeEt) : null
    if (windowMin !== null && clock.minutes < windowMin) {
      return { ok: false, rule: 'entry.beforeWindow', reason: `No buys before ${formatMinutes(windowMin)} ET on this agent — the opening minutes carry the widest, least tradeable range. It is ${formatMinutes(clock.minutes)} ET now; ${windowMin - clock.minutes} min to go. Sells and exits are unaffected.` }
    }
    if (g.maxEntryExtensionPct !== undefined && input.technicals) {
      const { vwap, dayOpen } = input.technicals
      const overVwap = vwap && vwap > 0 ? ((ref - vwap) / vwap) * 100 : null
      const overOpen = dayOpen && dayOpen > 0 ? ((ref - dayOpen) / dayOpen) * 100 : null
      const worst = Math.max(overVwap ?? -Infinity, overOpen ?? -Infinity)
      if (Number.isFinite(worst) && worst > g.maxEntryExtensionPct) {
        const parts = [overVwap !== null ? `${overVwap >= 0 ? '+' : ''}${overVwap.toFixed(2)}% vs VWAP` : '', overOpen !== null ? `${overOpen >= 0 ? '+' : ''}${overOpen.toFixed(2)}% vs the open` : ''].filter(Boolean).join(', ')
        return { ok: false, rule: 'entry.extended', reason: `${symbol} at $${ref.toFixed(2)} is extended (${parts}) — past this agent's ${g.maxEntryExtensionPct}% entry-extension cap. Chasing an extended print is how most losing entries are made: wait for a pullback toward VWAP, or rest a limit at or below it.` }
      }
    }
    if (g.maxSymbolDayPct !== undefined) {
      if (input.run?.boughtSymbols.includes(symbol)) {
        return { ok: false, rule: 'cap.symbolRun', reason: `Already bought ${symbol} on this run — one buy decision per symbol per wake-up. If the thesis still holds, add on a later run.` }
      }
      const already = boughtTodayIn(ledger, symbol, now)
      const budget = (g.maxSymbolDayPct / 100) * Math.max(1, config.allocationUsd)
      const thisOrder = (intent.qty ?? 0) > 0 ? (intent.qty ?? 0) * ref : (intent.notional ?? 0)
      if (already + thisOrder > budget + 1e-6) {
        return { ok: false, rule: 'cap.symbolDay', reason: `Today's buys in ${symbol} (${money(already)}) plus this order (${money(thisOrder)}) would pass ${g.maxSymbolDayPct}% of your allocation (${money(budget, 0)}) — the per-symbol day budget. ${money(Math.max(0, budget - already))} of it is left.` }
      }
    }
    if (g.reentryCooldownMin !== undefined && g.reentryCooldownMin > 0) {
      const loss = recentLossIn(ledger, symbol, g.reentryCooldownMin, now)
      if (loss) {
        return { ok: false, rule: 'entry.cooldown', reason: `${symbol} was sold at a loss of -$${Math.abs(loss.realized).toFixed(2)} ${loss.minutesAgo} min ago (${formatMinutes(etClock(new Date(loss.ts)).minutes)} ET). This agent waits ${g.reentryCooldownMin} min before re-entering a name it just lost on — ${Math.max(1, g.reentryCooldownMin - loss.minutesAgo)} min to go. Re-entering higher after a stop-out is the most common way agents lose money; if the setup is genuinely new, say so and wait it out.` }
      }
    }
    if (g.maxNewPositionsPerRun !== undefined && input.run && held <= 1e-9 && input.run.newPositions >= g.maxNewPositionsPerRun) {
      return { ok: false, rule: 'cap.newPositionsPerRun', reason: `This run has already opened ${input.run.newPositions} new position${input.run.newPositions === 1 ? '' : 's'} — the cap is ${g.maxNewPositionsPerRun} per run. Adding to a name you already hold is still allowed; a new name waits for the next run.` }
    }
  }
  if (intent.side === 'sell') {
    if (held <= 0) return { ok: false, rule: 'position.none', reason: `This agent holds no ${symbol} (its own book). It can only sell what it bought.` }
    if (qty > held + 1e-9) {
      // Clamp to own position rather than reject — selling "everything" is the common intent.
      qty = held
    }
  } else {
    const exposure = held * ref + notional
    if (!allInBook && exposure > g.maxPositionNotional + 1e-6) {
      return { ok: false, rule: 'cap.positionNotional', reason: `Buying would push ${symbol} exposure to $${exposure.toFixed(0)}, above the cap of $${g.maxPositionNotional}.` }
    }
    // The agent may only deploy its OWN remaining allocation — never the whole
    // account. Applies to paper and live alike (the live sub-ledger's cash is
    // the un-deployed slice of `allocationUsd`).
    if (notional > ledger.cash + 1e-6) {
      return { ok: false, rule: 'cap.allocation', reason: `Insufficient remaining allocation (${money(ledger.cash)} of ${money(config.allocationUsd, 0)}) for a $${notional.toFixed(2)} buy.` }
    }
    // Settlement (T+1). In a cash account only SETTLED cash may buy: the
    // proceeds of a sale come back the next trading day, so "sell MU, buy AMD"
    // inside one session is refused for the part funded by the sale. The
    // sentence names the settled figure and the day the rest arrives, because
    // the agent's next move is to size down or wait — not to retry.
    if (settlementModeFor(config, input.brokerAccountType) === 'cash') {
      const today = etClock(now).date
      const settled = settledCash(ledger, today)
      if (notional > settled + 1e-6) {
        const pending = unsettledCash(ledger, today)
        const where =
          config.mode === 'live'
            ? 'The Robinhood Agentic account is a CASH account: it cannot trade with unsettled funds, and the operator can upgrade it to limited margin in Robinhood\u2019s investing settings if they want proceeds reusable at once.'
            : 'This paper book mirrors a cash account so the rehearsal is honest; the operator can switch this agent to limited margin under Settings \u2192 Settlement.'
        return {
          ok: false,
          rule: 'settle.unsettled',
          reason: `Only ${money(settled)} of your ${money(ledger.cash)} cash is SETTLED — ${money(pending)} is sale proceeds still settling (${describeUnsettled(ledger, today, money)}; T+1). Size this buy to ${money(settled)} or less, or wait until it settles; selling is unaffected. ${where}`
        }
      }
    }
  }

  return { ok: true, qty, rule: operatorExit ? 'ok.operatorExit' : 'ok' }
}
