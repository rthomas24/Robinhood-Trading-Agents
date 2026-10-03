import { newId, type RunTrigger } from './agents'

/**
 * The authorization DECISION log: which tool call was allowed or blocked, by
 * which rule, for which agent, on which run.
 *
 * The thread already shows what an agent DID. This answers the question a
 * trader actually asks afterwards — "why didn't it sell at 3:58?" — which the
 * thread cannot, because a blocked call is a moment that leaves no trace once
 * the run ends. The rule that decided is recorded at the point it decides, so
 * the log and the engine can never drift apart.
 *
 * Pure data; the host persists it (`decisions.jsonl` per agent). Never load-bearing — an audit write must not be able to
 * take down the decision it is auditing.
 */
export type DecisionOutcome = 'allowed' | 'blocked'

/**
 * Every rule key the engine can record, as a closed set.
 *
 * `string` was too weak for what this field is FOR. The log's whole value is
 * that a key means the same thing in `guardrails.ts`, in the thread and in a
 * query six months from now — and with a bare `string`, renaming
 * a rule or mistyping one silently changed the vocabulary and no consumer
 * failed. A closed union is what makes "these keys cannot drift from
 * `checkGuardrails`" true of the types.
 *
 * Adding a rule means adding it here first. That is the point, not friction:
 * a key nobody declared is a key nobody can query.
 */
export type GuardrailRule =
  | 'symbol.invalid'
  | 'symbol.notAllowed'
  | 'agent.retired'
  | 'live.notArmed'
  | 'account.tradingHalted'
  | 'broker.notConnected'
  /** A limit order with no positive limitPrice — it could rest forever and never fill, so it is refused outright. */
  | 'limit.missingPrice'
  | 'session.marketHoursOnly'
  | 'session.extendedNotAllowed'
  | 'session.closed'
  | 'session.limitOnly'
  | 'cap.ordersPerDay'
  /**
   * RETIRED. The pattern-day-trader rule (FINRA 4210's $25k floor and the
   * four-in-five-days count) was abolished on 2026-06-04 (SEC approval
   * 2026-04-14, FINRA Regulatory Notice 26-10; Robinhood implemented it that
   * day). Nothing records this key any more; it stays declared so decision
   * rows written before then still read as a sentence.
   */
  | 'cap.dayTrades'
  /** A cash-account buy larger than the book's SETTLED cash — sale proceeds come back T+1 (`shared/settlement.ts`). */
  | 'settle.unsettled'
  | 'cap.orderNotional'
  | 'cap.positionNotional'
  | 'cap.allocation'
  | 'price.missing'
  | 'size.missing'
  | 'size.belowOneShare'
  | 'exit.invalidLevel'
  | 'lock.dailyLoss'
  | 'position.none'
  // Entry discipline. Buys only, every one.
  /** A buy before the agent's opening window (`noEntriesBeforeEt`) — the first minutes carry the widest, least tradeable range. */
  | 'entry.beforeWindow'
  /** A buy too far above VWAP or the day's open (`maxEntryExtensionPct`) — chasing. */
  | 'entry.extended'
  /** A second buy of the same symbol in one run — one decision per name per wake-up. */
  | 'cap.symbolRun'
  /** Today's buys in this symbol would pass `maxSymbolDayPct` of the allocation. */
  | 'cap.symbolDay'
  /** A re-entry inside `reentryCooldownMin` of a losing sell in the same symbol. */
  | 'entry.cooldown'
  /** The run has already opened `maxNewPositionsPerRun` new positions. */
  | 'cap.newPositionsPerRun'
  // Success is a decision too, and the log records allows as well as blocks.
  // Neither of these appeared in a grep for `rule: '...'` — they are returned
  // from a ternary on the success path, which is exactly the kind of key that
  // drifts unnoticed while the field is typed `string`.
  | 'ok'
  | 'ok.operatorExit'

/** Keys the RUNNER decides, outside the guardrail layer. */
export type RunnerRule =
  | 'approval.granted'
  | 'approval.outsideScope'
  /** The tool definition changed while the card sat pending, so the operator's yes was for a different action. */
  | 'approval.staleDefinition'
  | 'approval.alreadyPending'
  | 'approval.held'
  /** A persisted approved pass was set aside because the agent asked for something different. */
  | 'approval.superseded'
  /** Guardrails said yes and then execution could not price the order (paper needs a quote to simulate a fill). */
  | 'exec.noQuote'
  /** Guardrails said yes with no broker client attached (mode/live plumbing, not the operator's guardrails). */
  | 'exec.noBroker'
  /** Live buy refused for exceeding settled buying power — the account's number, not a guardrail's. */
  | 'live.buyingPower'
  /** Live limit order rounded to zero whole shares. */
  | 'live.zeroShares'
  | 'policy.toolNotAllowed'
  | 'policy.optionsUnsupported'
  /** A trail narrower than the floor for the name's daily range — answered with the numbers, not placed. */
  | 'exit.trailTooTight'
  | 'exit.cutInsideRange'
  /** A deadline retirement that could not flatten every position: the agent is NOT retired, and says which are still open. */
  | 'retire.cannotFlatten'
  | 'loop.repeatedCall'
  | 'checkin.alreadyOpen'
  | 'checkin.budget'
  /** `sleep_until` refused: the wake time is not ahead of now. */
  | 'sleep.notFuture'
  /** `sleep_until` refused: further out than MAX_SLEEP_DAYS. */
  | 'sleep.tooFar'
  /** `sleep_until` refused: a paused/retired agent does not decide when it wakes. */
  | 'sleep.notRunning'
  | 'plan.noChange'
  /** All-in earnings mode: a buy while a position is still held (one name at a time). */
  | 'playbook.oneAtATime'
  /** All-in earnings mode: a buy of a name that does not report after today's close or before tomorrow's open. */
  | 'playbook.notReporting'
  /** All-in earnings mode: nothing spendable (proceeds settling, or below the minimum). */
  | 'playbook.nothingToSpend'
  /** An autonomous agent applied a plan that WIDENED its own limits (outcome `allowed`; detail = the changes). */
  | 'plan.widened'
  | 'broker.rejected'
  | 'guardrails.rejected'
  | 'ok.unattended'

export type DecisionRule = GuardrailRule | RunnerRule

export interface DecisionRecord {
  /** Stable id, so a record written twice dedupes. */
  id: string
  ts: string
  agentId: string
  runId: string
  trigger: RunTrigger
  /** A person started this run, rather than the schedule or a price watch. */
  attended: boolean
  /** Canonical tool name (`mcp__tb__trade`, `mcp__robinhood__place_equity_order`…). */
  tool: string
  outcome: DecisionOutcome
  /** Stable machine key for the deciding rule, e.g. `cap.orderNotional`. */
  rule: DecisionRule
  /** One short, redacted human line. */
  detail?: string
}

/**
 * Triggers a human is behind. `schedule` and `watch` run with nobody watching.
 *
 * `approval` belongs here: the run exists *because* a person read a card and
 * tapped Approve, seconds ago. Leaving it out had a sharp edge — the
 * `maxOrdersPerDay` cap exempts an operator-driven sell precisely so you can
 * always tell an agent to get out, and an approved sell at the cap was being
 * refused by the one rule written to never refuse it.
 *
 * `timeout` stays unattended: nobody answered, which is the opposite of a
 * person being present.
 */
const ATTENDED: readonly RunTrigger[] = ['manual', 'reply', 'plan', 'approval']
export function isAttended(trigger: RunTrigger): boolean {
  return ATTENDED.includes(trigger)
}

const SECRET_ASSIGNMENT = /("?[\w-]*(?:token|secret|password|api[_-]?key|authorization|bearer)[\w-]*"?\s*[:=]\s*)("[^"]*"|\S+)/gi
const LONG_DIGITS = /\b\d{6,}\b/g

/**
 * Audit rows quote tool arguments, which is exactly where an account number or
 * a credential would sit. Keep the SHAPE, lose the VALUE: a redacted row still
 * says a token was passed and which account was targeted.
 */
export function redactAudit(text: string): string {
  return text.replace(SECRET_ASSIGNMENT, '$1«redacted»').replace(LONG_DIGITS, (m) => `••••${m.slice(-4)}`)
}

/**
 * What a caller passes to record one decision: the record minus the fields the
 * recorder already knows (agent, run, trigger, time, id).
 *
 * Named because two layers now emit — the runner for the tools it gates, and
 * `executeTrade` for the authoritative verdict every order passes — and they
 * must speak the same shape.
 */
export type DecisionInput = Pick<DecisionRecord, 'tool' | 'outcome' | 'rule'> & { detail?: string }

/** Build a record with the fixed fields filled in; `emit` is the host's sink. */
export function decisionRecorder(
  base: { agentId: string; runId: string; trigger: RunTrigger; now: () => Date },
  emit: ((rec: DecisionRecord) => void) | undefined
): (d: DecisionInput) => void {
  if (!emit) return () => undefined
  const attended = isAttended(base.trigger)
  return (d) => {
    try {
      emit({
        id: newId('dec_'),
        ts: base.now().toISOString(),
        agentId: base.agentId,
        runId: base.runId,
        trigger: base.trigger,
        attended,
        tool: d.tool,
        outcome: d.outcome,
        rule: d.rule,
        detail: d.detail ? redactAudit(d.detail).slice(0, 300) : undefined
      })
    } catch {
      /* auditing must never break the decision */
    }
  }
}
