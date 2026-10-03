import type { AgentConfig, Guardrails, Ledger, Schedule } from './agents'
import { OPEN_MINUTES, addDays, etClock, etDateTime, formatMinutes, isTradingDay, parseHHMM, sessionCloseMinutes } from './marketTime'
import { describeSettlesOn, settledCash, unsettledLots, type SettlementMode } from './settlement'

/**
 * The all-in earnings mode ("Earnings Pop").
 *
 * An agent in this mode does ONE thing, on a fixed cycle:
 *   1. RESEARCH (08:45 ET, pre-market): find who reports after today's close
 *      or before tomorrow's open, research them properly, keep a shortlist.
 *      RE-CHECK (12:30 ET): the morning's tape and fresh news against it.
 *   2. ENTER (15:40 ET): buy the ONE name it believes will pop, with the WHOLE
 *      book — every buy is everything this agent has that can be spent today.
 *   3. EXIT (09:31 ET next session): the engine market-sells the position at
 *      the open whether it popped or dropped. Profit is taken, a miss is cut;
 *      the report is the whole thesis, so there is nothing to wait for after it.
 *   4. REVIEW (09:45 ET): one run to score the call and write the lesson down.
 *   5. SETTLE: in a cash account the proceeds come back the next trading day
 *      (T+1), so the agent sleeps until they have and hunts again then. With
 *      limited margin there is no wait and it can go again the same afternoon.
 *
 * What the ENGINE owns, so no sentence the model writes can change it: the
 * size (everything spendable, `allInNotional`), one position at a time, the
 * report window (the name must report tonight or tomorrow before the open —
 * `reportWindow`), the entry window (no buys before 15:30 ET), the exit (the
 * 09:31 flatten stamped on every buy) and the settlement wait (`earningsPopGate`).
 * What the MODEL owns: which name, or none.
 *
 * Pure and Node-free.
 */

export type Playbook = 'earningsPop'

export const PLAYBOOK_LABEL: Record<Playbook, string> = { earningsPop: 'All-in earnings' }

export const EARNINGS_POP = {
  /**
   * Pre-market research: the day's calendar is final, last night's reporters
   * have shown how the sector is being received, and the overnight news is in.
   * This is where the shortlist is built.
   */
  researchAt: '08:45',
  /** After the exit: score the call and write the lesson down. */
  reviewAt: '09:45',
  /** Midday re-check: three hours of tape and fresh news against the morning's shortlist — keep, drop or swap. */
  recheckAt: '12:30',
  /** Decide and buy, close enough to the bell that the tape has shown its hand. */
  entryAt: '15:40',
  /** No buy before this minute — the position is carried into the report, not through a whole session. */
  entryWindow: '15:30',
  /** The engine sells everything at this minute of the next session. */
  exitAt: '09:31',
  /**
   * Left unspent on an all-in buy, as a fraction of the spendable cash: the
   * quote can move between sizing and the fill, and an order a cent over the
   * cash is refused whole. Half a percent of $500 is $2.50.
   */
  sizeBuffer: 0.005,
  /** Below this there is nothing worth buying with. */
  minTradeUsd: 5
} as const

export const isEarningsPop = (cfg: Pick<AgentConfig, 'playbook'> | null | undefined): boolean => cfg?.playbook === 'earningsPop'

/** Research, review, re-check and entry, trading days only. The exit is the engine's, not a run. */
export function earningsPopSchedule(): Schedule {
  return { kind: 'times', times: [EARNINGS_POP.researchAt, EARNINGS_POP.reviewAt, EARNINGS_POP.recheckAt, EARNINGS_POP.entryAt], days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], tradingDaysOnly: true }
}

/**
 * The fence for this mode. The per-order and per-symbol caps are the whole
 * allocation because every order IS the whole book — and the engine does not
 * judge an all-in buy against them at all (`checkGuardrails`), so a book that
 * has compounded past its allocation can still be deployed whole. What bounds
 * it is the book itself: cash, and in a cash account SETTLED cash.
 *
 * The daily loss limit is wide on purpose: one overnight gap on the whole book
 * routinely exceeds a 5% day, and the lock it sets only blocks buys, which the
 * cycle does not make on the morning of an exit anyway.
 */
export function earningsPopGuardrails(allocationUsd: number): Partial<Guardrails> {
  const alloc = Math.max(1, Math.round(allocationUsd))
  return {
    allowedSymbols: [],
    maxOrderNotional: alloc,
    maxPositionNotional: alloc,
    maxOrdersPerDay: 4,
    marketHoursOnly: true,
    allowExtendedHours: false,
    maxDailyLossPct: 25,
    noEntriesBeforeEt: EARNINGS_POP.entryWindow,
    maxNewPositionsPerRun: 1,
    settlement: 'cash'
  }
}

/** The next trading day after `date` (ET "YYYY-MM-DD"). */
export function nextTradingDay(date: string): string {
  let d = addDays(date, 1)
  while (!isTradingDay(d)) d = addDays(d, 1)
  return d
}

export interface ReportDate {
  /** ET "YYYY-MM-DD" */
  date: string
  timing?: 'am' | 'pm'
}

export type ReportWindow = 'tonight' | 'tomorrowMorning'

/**
 * Does this report land between today's close and the next open — the only
 * reports this mode may buy into? Tonight = today after the close (the session
 * must still be open to buy into it); tomorrow morning = the next trading day
 * before the open. A report with no stated timing cannot be placed on either
 * side of the close, so it is not confirmed.
 */
export function reportWindow(report: ReportDate, now: Date): ReportWindow | null {
  const c = etClock(now)
  if (!isTradingDay(c.date)) return null
  if (report.timing === 'pm' && report.date === c.date && c.minutes < sessionCloseMinutes(c.date)) return 'tonight'
  if (report.timing === 'am' && report.date === nextTradingDay(c.date)) return 'tomorrowMorning'
  return null
}

export const REPORT_WINDOW_LABEL: Record<ReportWindow, string> = { tonight: 'after today’s close', tomorrowMorning: 'before tomorrow’s open' }

/** What an all-in buy may spend right now: settled cash in a cash account, all cash otherwise. */
export function allInSpendable(ledger: Pick<Ledger, 'cash' | 'unsettled'>, settlement: SettlementMode | null, now: Date): number {
  return settlement === 'cash' ? settledCash(ledger, etClock(now).date) : Math.max(0, Math.round(ledger.cash * 100) / 100)
}

/** The dollar size of an all-in buy: everything spendable, less the small buffer, in cents. Zero when there is nothing worth buying with. */
export function allInNotional(spendable: number): number {
  const n = Math.floor(spendable * (1 - EARNINGS_POP.sizeBuffer) * 100) / 100
  return n >= EARNINGS_POP.minTradeUsd ? n : 0
}

export type EarningsPopGate = { kind: 'run'; why: string } | { kind: 'skip'; reason: string } | { kind: 'sleep'; until: Date; reason: string }

/**
 * Should a SCHEDULED wake-up of an all-in agent reach the model? The mode's
 * answer to "when do I run again":
 *
 *   - holding before the open → skip: the report is out, the engine sells at
 *     the open, and nothing can be done pre-market but watch;
 *   - holding in the session → run (a run is how anything odd is seen);
 *   - the book was sold this morning and no run has looked at it since → run
 *     (the review: score the call, keep the lesson — and on limited margin,
 *     do the day's research the held pre-market slot could not);
 *   - cash account with proceeds still settling → SLEEP until the day the last
 *     of them settles, waking for that morning's pre-market research —
 *     nothing can be bought before then, so every tick in between would be a
 *     model call that can only conclude "not yet";
 *   - the review slot with nothing to review → skip (the research already ran
 *     pre-market and the re-check is at midday);
 *   - otherwise → run: pre-market research, the midday re-check, the decision.
 *
 * Only scheduled wake-ups are gated: the operator's messages always reach the
 * model, and the settlement guardrail still refuses a buy made in one.
 */
export function earningsPopGate(input: { ledger: Pick<Ledger, 'cash' | 'positions' | 'fills' | 'unsettled'>; lastRunAt: string | null; settlement: SettlementMode | null; now: Date; money: (n: number) => string }): EarningsPopGate {
  const { ledger, lastRunAt, settlement, now, money } = input
  const c = etClock(now)
  const min = (hhmm: string): number => parseHHMM(hhmm) ?? 0
  if (ledger.positions.some((p) => p.qty > 1e-9)) {
    if (c.minutes < OPEN_MINUTES) return { kind: 'skip', reason: `all-in earnings mode: holding into the open — the engine sells at ${EARNINGS_POP.exitAt} ET and nothing can be done pre-market` }
    return { kind: 'run', why: 'holding the position into its exit' }
  }
  let lastSell: { ts: string; symbol: string } | null = null
  for (let i = ledger.fills.length - 1; i >= 0; i--) {
    const f = ledger.fills[i]
    if (f.side === 'sell') {
      lastSell = f
      break
    }
  }
  const soldToday = lastSell !== null && etClock(new Date(lastSell.ts)).date === c.date
  const unreviewed = soldToday && lastSell !== null && (!lastRunAt || Date.parse(lastRunAt) < Date.parse(lastSell.ts))
  if (unreviewed) return { kind: 'run', why: `review the ${lastSell!.symbol} exit` }
  if (settlement === 'cash') {
    const lots = unsettledLots(ledger, c.date)
    if (lots.length) {
      const day = lots.map((l) => l.settlesOn).sort().at(-1)!
      const until = etDateTime(day, min(EARNINGS_POP.researchAt))
      const pending = lots.reduce((s, l) => s + l.amount, 0)
      if (until.getTime() > now.getTime()) {
        return { kind: 'sleep', until, reason: `${money(pending)} of sale proceeds settles ${describeSettlesOn(day)} (T+1, cash account) — nothing can be bought all-in before then, so the next research is ${describeSettlesOn(day)} at ${formatMinutes(min(EARNINGS_POP.researchAt))} ET, before the open` }
      }
    }
  }
  if (c.minutes >= min(EARNINGS_POP.reviewAt) && c.minutes < min(EARNINGS_POP.recheckAt)) {
    return { kind: 'skip', reason: `all-in earnings mode: nothing to review — the research ran pre-market and the re-check is at ${formatMinutes(min(EARNINGS_POP.recheckAt))} ET` }
  }
  return { kind: 'run', why: c.minutes < OPEN_MINUTES ? 'pre-market research' : c.minutes < min(EARNINGS_POP.entryWindow) ? 'midday re-check' : 'entry window' }
}

/** The one-line status of the cycle, for the prompt and the UI. */
export function earningsPopPhase(input: { ledger: Pick<Ledger, 'cash' | 'positions' | 'unsettled'>; settlement: SettlementMode | null; now: Date; money: (n: number) => string }): string {
  const { ledger, settlement, now, money } = input
  const held = ledger.positions.filter((p) => p.qty > 1e-9)
  if (held.length) return `HOLDING ${held.map((p) => p.symbol).join(', ')} into the report — the engine sells it all at ${EARNINGS_POP.exitAt} ET next session.`
  const spend = allInSpendable(ledger, settlement, now)
  const size = allInNotional(spend)
  const c = etClock(now)
  const lots = settlement === 'cash' ? unsettledLots(ledger, c.date) : []
  if (!size && lots.length) {
    const day = lots.map((l) => l.settlesOn).sort().at(-1)!
    return `SETTLING — ${money(lots.reduce((s, l) => s + l.amount, 0))} comes back ${describeSettlesOn(day)}; nothing can be bought all-in until then.`
  }
  if (!size) return 'NOTHING TO SPEND — the book has less than the minimum an all-in trade needs.'
  return `FLAT — next all-in buy would be ${money(size)}${settlement === 'cash' ? ' of settled cash' : ''}.`
}
