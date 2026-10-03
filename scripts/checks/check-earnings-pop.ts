/**
 * The all-in earnings mode ("Earnings All-In" template, `shared/earningsPlaybook.ts`).
 *
 * The operator's ask (2026-09-29): an agent that picks ONE stock right before
 * its earnings, researched properly, buys it with EVERYTHING it has, sells at
 * the next morning's open, and knows to wait a day for the sale to settle
 * before going again. What the engine owns, pinned here:
 *
 *   1. The report window: only a report after today's close or before the next
 *      session's open is buyable (`reportWindow`), weekends and holidays included.
 *   2. The size: all spendable cash less a half-percent buffer — SETTLED cash in
 *      a cash account (`allInSpendable`, `allInNotional`) — whatever size the
 *      model passed. The fixed per-order/per-symbol caps do not freeze a book
 *      that has compounded past its allocation, and settled cash still binds.
 *   3. One name at a time, and the next-session flatten stamped on the buy.
 *   4. When it runs again (`earningsPopGate`): review the morning's sale once,
 *      then SLEEP until the proceeds settle in a cash account; no wait on margin.
 *   5. The research math (`core/research/earnings.ts`): the gap after an
 *      after-close report is the NEXT session's open, a before-open one its own.
 *   6. A playbook config owns its schedule and fence; only it gets the research tools.
 *   7. The whole path through `runOnce`: a scripted model buys with a wrong size
 *      and the engine deploys the book; a second buy in the same run is refused.
 *
 *   npm run check -- earnings-pop
 */
import { EARNINGS_POP, allInNotional, allInSpendable, earningsPopGate, earningsPopGuardrails, earningsPopSchedule, nextTradingDay, reportWindow } from '@shared/earningsPlaybook'
import { configFromCreateRequest } from '@shared/createAgent'
import { DEFAULT_MODEL, initialState, money, type AgentConfig, type AgentState, type Ledger, type Message, type RunRecord } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { checkGuardrails } from '@core/broker/guardrails'
import { reactionFor, reactionStats, financialTrend, reactionDay } from '@core/research/earnings'
import { toolsFor } from '@core/runner/agentTools'
import { runOnce } from '@core/runner/runOnce'
import type { AgentStorage, RuntimeDeps } from '@core/runner/types'
import type { VendorRunRequest, VendorRunResult } from '@core/runner/vendors/types'
import type { PriceFeed } from '@core/market/feed'
import type { Bar, EarningsReport } from '@core/robinhood/api'

let failures = 0
const ok = (cond: boolean, msg: string, detail = ''): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${detail && !cond ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) < eps
/** An ET wall-clock instant. */
const et = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number)
  return etDateTime(date, h * 60 + m)
}

// ── 1. The report window ─────────────────────────────────────────────────────
{
  const tue = '2026-09-29' // a Tuesday
  const fri = '2026-10-02'
  ok(reportWindow({ date: tue, timing: 'pm' }, et(tue, '15:40')) === 'tonight', 'after-close report today, before the bell → tonight')
  ok(reportWindow({ date: '2026-09-30', timing: 'am' }, et(tue, '15:40')) === 'tomorrowMorning', 'before-open report on the next trading day → tomorrow morning')
  ok(reportWindow({ date: '2026-10-05', timing: 'am' }, et(fri, '15:40')) === 'tomorrowMorning', "Friday: Monday's before-open report is the next session's")
  ok(reportWindow({ date: tue, timing: 'pm' }, et(tue, '16:05')) === null, 'after the close the report is no longer buyable into')
  ok(reportWindow({ date: '2026-09-30', timing: 'pm' }, et(tue, '15:40')) === null, "tomorrow's after-close report is a session too early")
  ok(reportWindow({ date: tue, timing: 'am' }, et(tue, '15:40')) === null, "this morning's report is already out")
  ok(reportWindow({ date: tue }, et(tue, '15:40')) === null, 'no published timing → not confirmed')
  ok(nextTradingDay('2026-11-25') === '2026-11-27', 'next trading day skips Thanksgiving')
}

// ── 2. Size ──────────────────────────────────────────────────────────────────
{
  ok(near(allInNotional(500), 497.5), `everything less the buffer (${allInNotional(500)})`)
  ok(allInNotional(3) === 0, 'below the minimum there is nothing worth buying')
  const tue = et('2026-09-29', '15:40')
  const book = { cash: 612.4, unsettled: [{ amount: 612.4, ts: '2026-09-29T13:31:00Z', settlesOn: '2026-09-30' }] }
  ok(allInSpendable(book, 'cash', tue) === 0, 'cash account: this morning’s proceeds are not spendable today')
  ok(near(allInSpendable(book, 'margin', tue), 612.4), 'limited margin: they are')
  ok(near(allInSpendable(book, 'cash', et('2026-09-30', '15:40')), 612.4), 'the next trading day they have settled')
}

// ── 3. When it runs again ───────────────────────────────────────────────────
{
  const sell = { id: 'f2', ts: et('2026-09-29', '09:31').toISOString(), symbol: 'NKE', side: 'sell' as const, qty: 13.5, price: 45.4, realized: 110 }
  const flatAfterSale: Pick<Ledger, 'cash' | 'positions' | 'fills' | 'unsettled'> = {
    cash: 612.4,
    positions: [],
    fills: [{ id: 'f1', ts: et('2026-09-28', '15:40').toISOString(), symbol: 'NKE', side: 'buy', qty: 13.5, price: 37.2, realized: 0 }, sell],
    unsettled: [{ amount: 612.4, ts: sell.ts, settlesOn: '2026-09-30' }]
  }
  const g1 = earningsPopGate({ ledger: flatAfterSale, lastRunAt: et('2026-09-28', '15:40').toISOString(), settlement: 'cash', now: et('2026-09-29', '09:45'), money })
  ok(g1.kind === 'run', 'the first run after the morning sale reviews it', JSON.stringify(g1))
  const g2 = earningsPopGate({ ledger: flatAfterSale, lastRunAt: et('2026-09-29', '09:46').toISOString(), settlement: 'cash', now: et('2026-09-29', '12:30'), money })
  ok(g2.kind === 'sleep' && g2.until.getTime() === et('2026-09-30', EARNINGS_POP.researchAt).getTime(), `reviewed, cash account → sleep until the settle day's pre-market research`, JSON.stringify(g2))
  ok(g2.kind === 'sleep' && /settles Wed, Sep 30/.test(g2.reason), 'and says when the money is back', g2.kind === 'sleep' ? g2.reason : '')
  const g3 = earningsPopGate({ ledger: flatAfterSale, lastRunAt: et('2026-09-29', '09:46').toISOString(), settlement: 'margin', now: et('2026-09-29', '12:30'), money })
  ok(g3.kind === 'run', 'limited margin → no wait, it hunts the same afternoon')
  const settled = { ...flatAfterSale, unsettled: [] }
  const g4 = earningsPopGate({ ledger: settled, lastRunAt: et('2026-09-30', '08:46').toISOString(), settlement: 'cash', now: et('2026-09-30', '09:45'), money })
  ok(g4.kind === 'skip', 'the review slot with nothing to review → a free skip', JSON.stringify(g4))
  const g6 = earningsPopGate({ ledger: settled, lastRunAt: et('2026-09-29', '15:40').toISOString(), settlement: 'cash', now: et('2026-09-30', '08:45'), money })
  ok(g6.kind === 'run' && /pre-market/.test(g6.why), 'flat and settled at 08:45 → pre-market research runs', JSON.stringify(g6))
  const g7 = earningsPopGate({ ledger: settled, lastRunAt: et('2026-09-30', '08:46').toISOString(), settlement: 'cash', now: et('2026-09-30', '12:30'), money })
  ok(g7.kind === 'run' && /re-check/.test(g7.why), 'midday → the re-check runs', JSON.stringify(g7))
  const holding = { ...flatAfterSale, positions: [{ symbol: 'NKE', qty: 13.5, avgCost: 37.2 }] }
  const g5 = earningsPopGate({ ledger: holding, lastRunAt: null, settlement: 'cash', now: et('2026-09-29', '12:30'), money })
  ok(g5.kind === 'run', 'holding in the session → runs')
  const g8 = earningsPopGate({ ledger: holding, lastRunAt: null, settlement: 'cash', now: et('2026-09-29', '08:45'), money })
  ok(g8.kind === 'skip', 'holding before the open → skip; the engine sells at the open')
  ok(JSON.stringify(earningsPopSchedule().kind === 'times' ? earningsPopSchedule().times : []) === JSON.stringify([EARNINGS_POP.researchAt, EARNINGS_POP.reviewAt, EARNINGS_POP.recheckAt, EARNINGS_POP.entryAt]), 'the schedule: research, review, re-check, decide')
}

// ── 4. The research math ────────────────────────────────────────────────────
{
  // Daily bars are stamped at midnight UTC of their own session.
  const bar = (d: string, o: number, c: number): Bar => ({ t: Date.parse(`${d}T00:00:00Z`) / 1000, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1e6 })
  const bars = [bar('2026-06-22', 40, 40), bar('2026-06-23', 40, 40), bar('2026-06-24', 40, 40), bar('2026-06-25', 40, 40), bar('2026-06-26', 40, 41), bar('2026-06-29', 41, 42), bar('2026-06-30', 42, 44), bar('2026-07-01', 48.4, 47), bar('2026-07-02', 47, 47)]
  const pm: EarningsReport = { symbol: 'NKE', epsEstimate: 0.12, epsActual: 0.2, date: '2026-06-30', timing: 'pm', verified: true }
  const r = reactionFor(pm, bars)!
  ok(r !== null && near(r.gapPct, 10), `after-close report: gap = next open vs that day's close (${r?.gapPct.toFixed(2)}%)`)
  ok(near(r.dayPct, ((47 - 44) / 44) * 100), 'day = reaction-day close vs the close before')
  ok(near(r.surprisePct ?? 0, 66.67, 0.1), `surprise vs estimate (${r.surprisePct?.toFixed(1)}%)`)
  ok(near(r.runUpPct ?? 0, 10), `run-up over the five sessions into it (${r.runUpPct?.toFixed(2)}%)`)
  const am: EarningsReport = { symbol: 'NKE', epsEstimate: 0.5, epsActual: 0.4, date: '2026-07-01', timing: 'am', verified: true }
  const r2 = reactionFor(am, bars)!
  ok(near(r2.gapPct, 10) && (r2.surprisePct ?? 0) < 0, 'before-open report: its own session is the reaction')
  ok(reactionFor({ ...pm, epsActual: null }, bars) === null, 'an unreported quarter has no reaction')
  const st = reactionStats([r, r2, { ...r, gapPct: -4, surprisePct: 5 }])!
  ok(st.n === 3 && st.gapUps === 2 && st.beats === 2 && st.beatsGapUp === 1, 'stats: gap-ups, beats, and whether beats got paid')
  ok(reactionDay({ date: '2026-10-02', timing: 'pm' }) === '2026-10-05' && reactionDay({ date: '2026-10-02', timing: 'am' }) === '2026-10-02', 'the reaction day an option expiry must reach')
  const tr = financialTrend([110, 105, 100, 95, 100].map((rev, i) => ({ fiscalYear: 2026, periodEnd: `q${i}`, revenue: rev, grossProfit: null, netIncome: null, netMargin: 10 - i })))
  ok(near(tr.revYoYPct ?? 0, 10) && near(tr.revQoQPct ?? 0, 4.76, 0.01), 'revenue growth YoY and QoQ from newest-first quarters')
}

// ── 5. The config owns its cycle; only it gets the research tools ──────────
const cfg: AgentConfig = {
  ...configFromCreateRequest(
    { name: 'Earnings All-In', icon: 'diamond', color: 'orange', task: 'all in on earnings', mode: 'paper', allocationUsd: 500, playbook: 'earningsPop', schedule: { kind: 'interval', everyMinutes: 5, marketHoursOnly: true }, guardrails: { maxOrderNotional: 50 } },
    { ...DEFAULT_MODEL, vendor: 'openrouter', id: 'stub' }
  ),
  id: 'ag_eap',
  autonomous: true
}
{
  ok(cfg.playbook === 'earningsPop', 'the playbook is stored on the config')
  ok(JSON.stringify(cfg.schedule) === JSON.stringify(earningsPopSchedule()), 'the mode’s schedule wins over the form’s')
  ok(cfg.guardrails.maxOrderNotional === 500 && cfg.guardrails.noEntriesBeforeEt === EARNINGS_POP.entryWindow && cfg.guardrails.settlement === 'cash', 'and so does its fence', JSON.stringify(earningsPopGuardrails(500)))
  ok(toolsFor(cfg).some((t) => t.name === 'earnings_dossier') && !toolsFor({}).some((t) => t.name === 'earnings_dossier'), 'research tools for this mode only')
}

// ── 6. Guardrails: the book, not the fixed caps ─────────────────────────────
{
  const state = initialState(cfg)
  const grown: AgentState = { ...state, paper: { ...state.paper, cash: 740 } }
  const now = et('2026-09-29', '15:40')
  const buy = { side: 'buy' as const, symbol: 'NKE', notional: 736, type: 'market' as const, tif: 'day' as const, reason: 't', allIn: true }
  ok(checkGuardrails({ config: cfg, state: grown, intent: buy, refPrice: 37, now }).ok, 'a compounded book ($740 on a $500 allocation) deploys whole')
  ok(!checkGuardrails({ config: { ...cfg, playbook: undefined }, state: grown, intent: buy, refPrice: 37, now }).ok, 'an ordinary agent is still held to its cap')
  const settling: AgentState = { ...grown, paper: { ...grown.paper, unsettled: [{ amount: 740, ts: now.toISOString(), settlesOn: '2026-09-30' }] } }
  const v = checkGuardrails({ config: cfg, state: settling, intent: buy, refPrice: 37, now })
  ok(!v.ok && v.rule === 'settle.unsettled', 'settled cash still binds')
  ok(checkGuardrails({ config: cfg, state: grown, intent: buy, refPrice: 37, now: et('2026-09-29', '14:00') }).rule === 'entry.beforeWindow', `no buys before ${EARNINGS_POP.entryWindow} ET`)
}

// ── 7. Through runOnce: the model asks small, the engine deploys the book ───
{
  const NOW = et('2026-09-29', '15:41')
  let state: AgentState = initialState(cfg)
  const messages: Message[] = []
  const runs: RunRecord[] = []
  const storage: AgentStorage = {
    getConfig: async () => cfg,
    getState: async () => state,
    saveState: async (_id, s) => {
      state = s
    },
    saveConfig: async () => {},
    appendMessage: async (m) => {
      messages.push(m)
    },
    updateMessage: async () => {},
    recentMessages: async () => messages,
    searchMessages: async () => ({ messages: [], scannedAll: true }),
    appendRun: async (r) => {
      runs.push(r)
    }
  }
  const feed: PriceFeed = {
    id: 'feed',
    quotes: async (syms) => ({ quotes: syms.map((symbol) => ({ symbol, last: 37, bid: 36.98, ask: 37.02, prevClose: 36.4, changePct: 1.6, ts: NOW.toISOString() })), failed: [] }),
    bars: async () => ({})
  }
  const results: string[] = []
  const vendor = {
    vendor: 'openrouter' as const,
    async run(req: VendorRunRequest): Promise<VendorRunResult> {
      const trade = req.tools.find((t) => t.name === 'trade')!
      results.push(await trade.run({ side: 'buy', symbol: 'NKE', notional: 20, type: 'market', tif: 'day', reason: 'beats and gaps up' } as never, req.host))
      results.push(await trade.run({ side: 'buy', symbol: 'MU', notional: 20, type: 'market', tif: 'day', reason: 'second name' } as never, req.host))
      return { texts: ['bought NKE all-in'], thinking: [], toolCalls: [], inputTokens: 10, outputTokens: 10, contextTokens: 10, sessionId: null, stoppedBecause: 'natural' }
    }
  }
  const deps = {
    vendors: { openrouter: vendor },
    storage,
    creds: { robinhoodToken: async () => null },
    marketFeed: async () => feed,
    cwd: process.cwd(),
    now: () => NOW,
    emit: () => {},
    log: () => {}
  } as unknown as RuntimeDeps
  await runOnce(deps, { agentId: cfg.id, trigger: 'manual' })
  const pos = state.paper.positions.find((p) => p.symbol === 'NKE')
  ok(/^FILLED BUY/.test(results[0] ?? '') && /ALL-IN/.test(results[0] ?? ''), 'the buy fills, and the result says the engine sized it', results[0])
  ok(pos !== undefined && pos.qty * 37.02 > 480, `the whole book went in, not the $20 asked for (${pos ? money(pos.qty * pos.avgCost) : 'none'})`, JSON.stringify(state.paper))
  ok(state.paper.cash >= 0 && state.paper.cash < 5, `a few dollars of buffer left, never negative (${money(state.paper.cash)})`)
  ok(state.exits.NKE?.flattenAt === EARNINGS_POP.exitAt, `the next-session flatten is armed at ${EARNINGS_POP.exitAt}`, JSON.stringify(state.exits))
  ok(/NOT PLACED: all-in earnings mode holds ONE name/.test(results[1] ?? ''), 'a second buy in the same run is refused', results[1])
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
