import type { DecisionRecord, DecisionRule } from './decisions'

/**
 * The decision log, read as a sentence.
 *
 * The log answers "why didn't it sell at 3:58?" — but only to someone willing
 * to read sixty rows of rule keys. This groups a window of records by the rule
 * that decided and says it in words: "Held back 6 times in the last 7 days:
 * 4× by the daily order cap, 2× by the market being closed." The stats sheet
 * shows it above the raw rows.
 *
 * `RULE_LABEL` is a `Record` over the CLOSED rule set on purpose: adding a rule
 * to `decisions.ts` without a phrase here fails to compile, so the vocabulary
 * the engine records and the vocabulary the operator reads cannot drift.
 *
 * Pure and Node-free.
 */

/** Each rule as the object of "held back by …" (or "allowed by …"). */
export const RULE_LABEL: Record<DecisionRule, string> = {
  'symbol.invalid': 'an invalid symbol',
  'symbol.notAllowed': 'the symbol allow-list',
  'agent.retired': 'the agent being retired',
  'live.notArmed': 'live trading not being armed',
  'account.tradingHalted': 'the account-wide trading halt',
  'broker.notConnected': 'Robinhood not being connected',
  'limit.missingPrice': 'a limit order with no price',
  'session.marketHoursOnly': 'the market-hours-only rule',
  'session.extendedNotAllowed': 'extended hours not being allowed',
  'session.closed': 'the market being closed',
  'session.limitOnly': 'off-hours orders having to be limits',
  'cap.ordersPerDay': 'the daily order cap',
  'cap.dayTrades': 'the day-trade limit (a rule retired in June 2026)',
  'settle.unsettled': 'unsettled sale proceeds (T+1)',
  'cap.orderNotional': 'the per-order size cap',
  'cap.positionNotional': 'the per-symbol position cap',
  'cap.allocation': 'the agent’s allocation',
  'price.missing': 'no price being available',
  'size.missing': 'a missing order size',
  'size.belowOneShare': 'an order below one share',
  'exit.invalidLevel': 'an invalid stop or target level',
  'lock.dailyLoss': 'the daily-loss buy lock',
  'position.none': 'having no position to sell',
  'entry.beforeWindow': 'the opening window (no buys before the agent’s start time)',
  'entry.extended': 'the entry-extension cap (too far above VWAP or the open)',
  'cap.symbolRun': 'one buy per symbol per run',
  'cap.symbolDay': 'the per-symbol daily buy cap',
  'entry.cooldown': 'the re-entry cooldown after a losing sell',
  'cap.newPositionsPerRun': 'the new-positions-per-run cap',
  'exit.trailTooTight': 'a trail narrower than the name’s daily range allows',
  'exit.cutInsideRange': 'a sell at a loss inside the name’s noise band, with a stop already armed below',
  'retire.cannotFlatten': 'a retirement that could not flatten every position',
  ok: 'the guardrails',
  'ok.operatorExit': 'the operator-exit exemption',
  'approval.granted': 'your approval',
  'approval.outsideScope': 'the approval not covering this order',
  'approval.staleDefinition': 'the tool changing while the card waited',
  'approval.alreadyPending': 'a card already waiting for you',
  'approval.held': 'waiting for your approval',
  'approval.superseded': 'a superseded approval',
  'exec.noQuote': 'no quote to price the fill',
  'exec.noBroker': 'no broker client being attached',
  'live.buyingPower': 'settled buying power',
  'live.zeroShares': 'rounding to zero shares',
  'policy.toolNotAllowed': 'the tool policy',
  'policy.optionsUnsupported': 'options not being supported',
  'loop.repeatedCall': 'the repeated-call guard',
  'checkin.alreadyOpen': 'a question already being open',
  'checkin.budget': 'the daily check-in budget',
  'sleep.notFuture': 'a wake time that had already passed',
  'sleep.tooFar': 'the longest allowed sleep',
  'sleep.notRunning': 'the agent being paused or retired',
  'plan.noChange': 'a plan change that changed nothing',
  'playbook.oneAtATime': 'the one-position rule of all-in earnings mode',
  'playbook.notReporting': 'a name not reporting in the all-in window',
  'playbook.nothingToSpend': 'nothing spendable for an all-in buy',
  'plan.widened': 'the agent widening its own limits',
  'broker.rejected': 'Robinhood rejecting the order',
  'guardrails.rejected': 'the guardrails',
  'ok.unattended': 'the unattended-run rules'
}

/** A rule key the engine has not declared yet (an older/newer client) still reads as something. */
export const ruleLabel = (rule: string): string => (rule in RULE_LABEL ? RULE_LABEL[rule as DecisionRule] : rule)

export interface RuleCount {
  rule: string
  label: string
  count: number
  /** How many of these happened with nobody at the keyboard. */
  unattended: number
  lastAt: string
  /** Up to two distinct detail lines, most recent first. */
  examples: string[]
}

export interface DecisionSummary {
  /** Records inside the window. */
  total: number
  allowed: number
  blocked: number
  /** Blocked with nobody at the keyboard — the ones the operator never saw happen. */
  unattendedBlocked: number
  /** Blocking rules, most frequent first. */
  blockedBy: RuleCount[]
  /** The window's start, or null for "everything given". */
  since: string | null
}

/**
 * Group a set of records. `since` (ms epoch) keeps only records at or after
 * that instant; records are otherwise taken as given, in any order.
 */
export function summarizeDecisions(records: readonly DecisionRecord[], opts: { since?: number } = {}): DecisionSummary {
  const since = opts.since
  const rows = since === undefined ? [...records] : records.filter((r) => Date.parse(r.ts) >= since)
  const by = new Map<string, RuleCount>()
  let allowed = 0
  let blocked = 0
  let unattendedBlocked = 0
  for (const r of rows.sort((a, b) => b.ts.localeCompare(a.ts))) {
    if (r.outcome === 'allowed') {
      allowed++
      continue
    }
    blocked++
    if (!r.attended) unattendedBlocked++
    const row = by.get(r.rule) ?? { rule: r.rule, label: ruleLabel(r.rule), count: 0, unattended: 0, lastAt: r.ts, examples: [] }
    row.count++
    if (!r.attended) row.unattended++
    if (r.detail && row.examples.length < 2 && !row.examples.includes(r.detail)) row.examples.push(r.detail)
    by.set(r.rule, row)
  }
  return {
    total: rows.length,
    allowed,
    blocked,
    unattendedBlocked,
    blockedBy: [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    since: since === undefined ? null : new Date(since).toISOString()
  }
}

const times = (n: number): string => `${n} time${n === 1 ? '' : 's'}`

/**
 * One sentence for the top of the Decisions section. `windowLabel` names the
 * window in words ("in the last 7 days"); omit it when the summary covers
 * everything given.
 */
export function heldBackSentence(s: DecisionSummary, windowLabel?: string): string {
  const w = windowLabel ? ` ${windowLabel}` : ''
  if (s.total === 0) return `No gated tool calls${w}.`
  if (s.blocked === 0) return `Nothing held back${w}: ${s.total} gated call${s.total === 1 ? '' : 's'}, all allowed.`
  const top = s.blockedBy.slice(0, 3).map((r) => `${r.count}× by ${r.label}`)
  const more = s.blockedBy.length - 3
  const tail = more > 0 ? `, and ${more} other rule${more === 1 ? '' : 's'}` : ''
  const quiet = s.unattendedBlocked > 0 ? ` ${s.unattendedBlocked} of those happened with nobody at the keyboard.` : ''
  return `Held back ${times(s.blocked)}${w}: ${top.join(', ')}${tail}.${quiet}`
}
