/**
 * A paper position has no price unless we go and get one.
 *
 * If `PortfolioSnapshot.quotes` is exactly the BROKER account's holdings, a
 * view that prices agents from that map gives a paper agent — which holds META
 * in its own ledger and nothing at the broker — no mark by construction. Its
 * P&L falls back to cost basis, and cost basis against cost basis is exactly
 * 0.00%: a confident green zero for a number the app had no basis for.
 *
 * `symbolsToMark` is the one rule for which symbols need a price — the agents'
 * holdings plus recent fills — shared so the snapshot and the renderer's marks
 * carry the same set and nothing has to guess.
 *
 * Run: `npm run check -- mark-symbols`
 */
import { bookPnl, symbolsToMark, type AgentConfig, type AgentState, type Fill, type Position } from '@shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const pos = (symbol: string): Position => ({ symbol, qty: 1, avgCost: 100 }) as Position
const fill = (symbol: string): Fill => ({ symbol, side: 'buy', qty: 1, price: 100, ts: '2026-08-24T14:00:00Z' }) as Fill

const agent = (mode: 'paper' | 'live', positions: Position[], fills: Fill[], status = 'scheduled'): { config: AgentConfig; state: AgentState } => ({
  config: { mode, allocationUsd: 10_000 } as AgentConfig,
  state: {
    status,
    paper: { cash: 0, positions: mode === 'paper' ? positions : [], fills: mode === 'paper' ? fills : [], openOrders: [] },
    live: { cash: 0, positions: mode === 'live' ? positions : [], fills: mode === 'live' ? fills : [], openOrders: [] }
  } as unknown as AgentState
})

// ── the reported bug ───────────────────────────────────────────────────────
const paper = agent('paper', [pos('META')], [fill('META')])
check('a PAPER holding is marked', symbolsToMark([paper]).includes('META'), 'this was absent, and its day P&L read 0.00%')

const live = agent('live', [pos('MU')], [fill('MU')])
check('a LIVE holding is marked', symbolsToMark([live]).includes('MU'))
check('each agent reads its OWN ledger', symbolsToMark([paper]).includes('MU') === false, 'a paper agent must not be priced from the live book')

// ── the case that is easy to forget ────────────────────────────────────────
// Bought and sold the same day: flat by the close, but today's move still needs
// a previous close. Dropping it makes the number silently wrong, not absent.
const closed = agent('paper', [], [fill('NFLX')])
check('a symbol traded today but no longer held is still marked', symbolsToMark([closed]).includes('NFLX'), 'otherwise today’s P&L is wrong rather than missing')

// ── what must NOT be dragged in ────────────────────────────────────────────
const retired = agent('paper', [pos('TSLA')], [fill('TSLA')], 'retired')
check('a retired agent contributes nothing', symbolsToMark([retired]).length === 0, 'it holds nothing that is still moving')

// ── the set is a union, deduped ────────────────────────────────────────────
const many = symbolsToMark([paper, live, closed])
check('symbols across agents are unioned', ['META', 'MU', 'NFLX'].every((s) => many.includes(s)), many.join(','))
check('...and deduped', symbolsToMark([paper, paper, paper]).length === 1, 'three agents holding META must ask for one quote')

// ── the fill window is bounded ─────────────────────────────────────────────
// An agent with a long history must not make the quote request unbounded.
const busy = agent(
  'paper',
  [],
  Array.from({ length: 200 }, (_, i) => fill(`S${i}`))
)
check('only the recent fills count', symbolsToMark([busy]).length === 40, `${symbolsToMark([busy]).length} — the window, not the whole history`)
check('...and the window is adjustable', symbolsToMark([busy], 5).length === 5)
check('the newest fills are the ones kept', symbolsToMark([busy], 3).includes('S199'), 'slice(-n) — the tail, not the head')

// ── an unmarked book must not report a number ──────────────────────────────
// On a REALISTIC ledger both figures collapse to exactly 0.00%, and that is the
// whole reason this went unnoticed.
//
// A paper ledger starts with cash = allocation (emptyLedger) and deducts it on
// buys. Unmarked, a position is valued at cost, so cash + positions-at-cost is
// still the allocation: equity == allocation, totalPct == 0. And today's move
// compares equity now against equity at the open, both the same cost basis, so
// dayPct == 0 as well. Two different routes, one silent green zero.
//
// My first version of this seeded cash: 0 and observed totalPct = -99%, then
// described that as the code's behaviour. It is a property of the fixture. The
// distinction matters to anyone reading this later to judge whether a user
// could have SEEN the bug: a screaming -99% would have been reported years ago.
// Nobody reported zeros.
const cfg2 = { mode: 'paper', allocationUsd: 10_000 } as AgentConfig
const etDate = (iso: string): string => iso.slice(0, 10)
/** Bought 1 MU at $100 out of a $10,000 allocation — cash deducted, as the engine does. */
const realistic = {
  status: 'scheduled',
  paper: { cash: 9_900, positions: [pos('MU')], fills: [fill('MU')], openOrders: [], realizedPnl: 0 },
  live: { cash: 10_000, positions: [], fills: [], openOrders: [], realizedPnl: 0 }
} as unknown as AgentState

const noMarks = bookPnl(cfg2, realistic, {}, '2026-08-24', etDate)
check('an unmarked book reports marked=false', noMarks.marked === false)
check('...names the symbol that has no price', noMarks.unmarked.join() === 'MU', noMarks.unmarked.join())
check("...today's move is a silent exact 0", noMarks.dayPct === 0, 'cost against cost')
check('...and SO IS the total on a normal ledger', noMarks.totalPct === 0, 'cash + positions-at-cost == allocation — this is what users actually saw')

// ...and it is not reliably zero. A ledger whose cash does not offset the
// position (a transfer, a corrected book, a partially-synced state) makes the
// same unmarked figure arbitrarily wrong instead of merely flat. Both failures
// argue for hiding it rather than rendering it.
const skewed = { ...realistic, paper: { ...(realistic as never as { paper: { cash: number } }).paper, cash: 0 } } as unknown as AgentState
check('an unusual ledger makes the SAME figure wildly wrong', bookPnl(cfg2, skewed, {}, '2026-08-24', etDate).totalPct < -0.9, 'silent when normal, alarming when not — never a fact about the market')

const withMark = bookPnl(cfg2, realistic, { MU: { last: 110, prevClose: 100 } }, '2026-08-24', etDate)
check('a marked book reports marked=true', withMark.marked === true)
check('...with nothing unmarked', withMark.unmarked.length === 0)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
