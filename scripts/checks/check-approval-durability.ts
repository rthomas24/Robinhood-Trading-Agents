/**
 * An operator's yes survives until it buys something — and the books tell the
 * truth about what happened to it.
 *
 *   npm run check -- approval-durability
 *
 * Three defects pinned here:
 *
 * 1. APPROVAL EVAPORATION. The approved pass was cleared from state at run
 *    start and lived only in the run it was reviewed in — approve a sell after
 *    the close and the review run could not trade, so the yes evaporated — a
 *    sell could be approved twice and still never execute. The pass now
 *    persists until spent / superseded / withdrawn / expired
 *    (`APPROVAL_TTL_MS`).
 *
 * 2. THE LOG THAT SAID "IT SOLD". `executeTrade` audited `allowed · ok` at the
 *    guardrail verdict, then execution failed (no quote) — so the decision log,
 *    built to answer "why didn't it sell?", answered "it did". The allowed
 *    record now fires only when the order goes somewhere; every post-verdict
 *    failure writes a blocked record with its own rule.
 *
 * 3. THE CAP THAT LEAKED SLIPPAGE. Guardrails checked the raw ask while paper
 *    filled at ask + slippage, so a cap-sized buy landed $2.49 over
 *    maxOrderNotional. The check now uses the exact (rounded) price the fill
 *    uses. Plus: paper cash moves in per-delta cents, so a flat book's cash
 *    equals allocation + realizedPnl to the penny.
 *
 * No credentials, no database, no network.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState } from '@shared/agents'
import { APPROVAL_TTL_MS, approvalExpired, approvalExpiredNote, approvalSupersededNote } from '@shared/approval'
import type { DecisionInput } from '@shared/decisions'
import { executeTrade, type ExecContext } from '@core/broker/execute'
import type { PendingAction } from '@shared/agents'

let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

// ── 1. the pass's clock ─────────────────────────────────────────────────────
const NOW = new Date('2026-08-31T14:30:00Z') // Monday 10:30 ET, regular session
const pass = (approvedAgoMs: number): PendingAction =>
  ({
    id: 'pa_x',
    tool: 'mcp__tb__trade',
    args: {},
    summary: 'Sell 5 KO at market',
    reason: 'r',
    requestedAt: new Date(NOW.getTime() - approvedAgoMs - 60_000).toISOString(),
    approvedAt: new Date(NOW.getTime() - approvedAgoMs).toISOString()
  }) as PendingAction

check('a fresh approval has not expired', !approvalExpired(pass(60_000), NOW))
check('71 hours in, still good (covers approve-Friday → execute-Monday)', !approvalExpired(pass(71 * 3_600_000), NOW))
check('past 72 hours it expires', approvalExpired(pass(APPROVAL_TTL_MS + 60_000), NOW))
check('an unapproved card never "expires" through this predicate', !approvalExpired({ ...pass(0), approvedAt: undefined } as PendingAction, NOW))
check('the expiry note names the action', approvalExpiredNote('Sell 7 RY at market').includes('Sell 7 RY at market'))
check('the supersede note names the action', approvalSupersededNote('Sell 7 RY at market').includes('Sell 7 RY at market'))

// ── executeTrade harness ────────────────────────────────────────────────────
const cfg = (over: Partial<(typeof DEFAULT_GUARDRAILS & { allocationUsd: number })> = {}): AgentConfig =>
  ({
    id: 'ag_test',
    name: 'Test',
    mode: 'paper',
    allocationUsd: over.allocationUsd ?? 25_000,
    guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 12_500, maxPositionNotional: 100_000, maxOrdersPerDay: 100, maxDailyLossPct: 100, ...over },
    liveArmedAt: null
  }) as unknown as AgentConfig

interface Harness {
  ctx: ExecContext
  audits: DecisionInput[]
  state: () => AgentState
}
function harness(config: AgentConfig, quotes: Array<{ symbol: string; last: number; bid?: number; ask?: number }>): Harness {
  let state = initialState({ allocationUsd: (config as { allocationUsd: number }).allocationUsd })
  const audits: DecisionInput[] = []
  const ctx: ExecContext = {
    config,
    get state() {
      return state
    },
    set state(s: AgentState) {
      state = s
    },
    rh: null,
    accountNumber: null,
    quotes: quotes as ExecContext['quotes'],
    buyingPower: null,
    tradingHalted: false,
    brokerConnected: true,
    now: NOW,
    trigger: 'manual',
    audit: (d) => audits.push(d),
    log: () => undefined
  }
  return { ctx, audits, state: () => state }
}

async function main(): Promise<void> {
  // ── 2. the log tells the truth about execution ────────────────────────────
  // A LIMIT order prices its guardrail check off the limit itself, so with no
  // quote it passes the verdict and dies at execution — exactly the failing
  // path ("Placing a limit sell at $60… REJECTED: No quote available"). A
  // market order with no quote correctly dies earlier, at `price.missing`.
  const noQuote = harness(cfg(), [])
  const r1 = await executeTrade(noQuote.ctx, { symbol: 'KO', side: 'buy', qty: 5, type: 'limit', limitPrice: 60, tif: 'day', reason: 'check' })
  check('no quote: the action is rejected', r1.action.status === 'rejected')
  check(
    'no quote: ONE blocked record, rule exec.noQuote',
    noQuote.audits.length === 1 && noQuote.audits[0].outcome === 'blocked' && noQuote.audits[0].rule === 'exec.noQuote',
    JSON.stringify(noQuote.audits.map((a) => `${a.outcome}:${a.rule}`))
  )
  check(
    'no quote: NO allowed record — the old order of events logged `allowed · ok` here',
    !noQuote.audits.some((a) => a.outcome === 'allowed')
  )

  // ── 3. the cap leak ───────────────────────────────────────────────────────
  // qty 49.995 × raw ask $250.00 = $12,498.75 → a raw-ask check passes;
  // the fill at ask + 2bps slippage ($250.05) books $12,501.25 against a $12,500 cap.
  const leak = harness(cfg(), [{ symbol: 'NVDA', last: 249.95, bid: 249.98, ask: 250 }])
  const r2 = await executeTrade(leak.ctx, { symbol: 'NVDA', side: 'buy', qty: 49.995, type: 'market', tif: 'day', reason: 'check' })
  check(
    'the overshoot order is now REFUSED at the cap',
    r2.action.status === 'rejected' && leak.audits[0]?.rule === 'cap.orderNotional',
    `${r2.action.status} · ${String(leak.audits[0]?.rule)}`
  )

  // A notional order AT the cap fills, and its booked notional respects the cap.
  const atCap = harness(cfg(), [{ symbol: 'PLTR', last: 175.7, bid: 175.74, ask: 175.75 }])
  const r3 = await executeTrade(atCap.ctx, { symbol: 'PLTR', side: 'buy', notional: 12_500, type: 'market', tif: 'day', reason: 'check' })
  const booked = (r3.action.fillQty ?? 0) * (r3.action.fillPrice ?? 0)
  check('a $12,500 notional buy fills', r3.action.status === 'filled')
  check('...for at most $12,500 at the ACTUAL fill price', booked <= 12_500 + 1e-6, `$${booked.toFixed(4)}`)
  check(
    '...and audits exactly one allowed record, after execution',
    atCap.audits.filter((a) => a.outcome === 'allowed').length === 1 && atCap.audits[atCap.audits.length - 1].outcome === 'allowed'
  )

  // ── 4. cents-exact books: flat cash equals allocation + realized ─────────
  // Odd lots, round-tripped to flat.
  const cents = harness(cfg({ allocationUsd: 10_000, maxOrderNotional: 100_000 } as never), [
    { symbol: 'SCHD', last: 27.42, bid: 27.41, ask: 27.4268 },
    { symbol: 'ANF', last: 101.42, bid: 101.4, ask: 101.4371 }
  ])
  await executeTrade(cents.ctx, { symbol: 'SCHD', side: 'buy', qty: 37.4219, type: 'market', tif: 'day', reason: 'check' }).then((r) => (cents.ctx as { state: AgentState }).state = r.state)
  await executeTrade(cents.ctx, { symbol: 'ANF', side: 'buy', qty: 9.8765, type: 'market', tif: 'day', reason: 'check' }).then((r) => (cents.ctx as { state: AgentState }).state = r.state)
  await executeTrade(cents.ctx, { symbol: 'SCHD', side: 'sell', qty: 37.4219, type: 'market', tif: 'day', reason: 'check' }).then((r) => (cents.ctx as { state: AgentState }).state = r.state)
  await executeTrade(cents.ctx, { symbol: 'ANF', side: 'sell', qty: 9.8765, type: 'market', tif: 'day', reason: 'check' }).then((r) => (cents.ctx as { state: AgentState }).state = r.state)
  const book = (cents.ctx.state as AgentState).paper
  check('the round trip went flat', book.positions.length === 0)
  const drift = Math.abs(book.cash - (10_000 + book.realizedPnl))
  check('flat cash === allocation + realizedPnl, to the penny and beyond', drift < 1e-9, `drift $${drift}`)
  check(
    "each fill's realized matches the running total",
    Math.abs(book.fills.reduce((s, f) => s + f.realized, 0) - book.realizedPnl) < 1e-9
  )
  check(
    "each fill's realized is EXACT cents, no float dust",
    book.fills.every((f) => Math.abs(f.realized * 100 - Math.round(f.realized * 100)) < 1e-9),
    'a difference of two rounded values must itself be re-rounded (float dust like 0.09000000000000008 must not ship)'
  )
  // The model narrates the ENGINE's realized figure, not its own arithmetic —
  // prose computed from its own rounded prices can disagree with a correct
  // card by cents when the tool result does not carry the number.
  const runOnceSrc = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8').replace(/\r\n/g, '\n')
  check('the FILLED tool result hands the model the realized economics', runOnceSrc.includes('use THIS figure when you report it'))

  // ── 5. the durability wiring in runOnce (source properties, CRLF-safe) ──
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8').replace(/\r\n/g, '\n')
  check('the pass is NOT cleared at run start any more', src.includes('DELIBERATELY NOT CLEARED'))
  check('an expired pass is settled at run start', src.includes('approvalExpired(heldNow, now())'))
  check('a rejected execution hands the pass back', src.includes('if (failed) approvalUsed = false'))
  check('a successful trade spends the pass in state', /approved = null\n\s+await patch\(\{ pendingAction: null \}\)/.test(src))
  check('a different request supersedes rather than stalls', src.includes("rule: 'approval.superseded'"))
  check('non-trade grants spend at run settle', src.includes("The pass's LAST spend point"))

  console.log(failed === 0 ? '\nall passed' : `\n${failed} check(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main()
