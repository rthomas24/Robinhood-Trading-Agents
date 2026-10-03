/**
 * Paper and live books are added up separately, and never together.
 *
 * `paperPortfolio` has always ignored live agents, so an account running
 * agents with real money had no cross-agent view of what they did. `livePortfolio`
 * is the same aggregation over each live agent's OWN sub-ledger. This pins
 * that each side sees only its own mode, that a retired agent still counts,
 * that an unmarked holding sits at cost with `marked` false, and that nothing
 * about the two sides is summed by the shared code.
 *
 * Run: `npm run check -- book-portfolio`
 */
import { emptyLedger, initialState, livePortfolio, paperPortfolio, DEFAULT_GUARDRAILS, type AgentConfig, type AgentState } from '@shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

const TODAY = '2026-09-04'
const etDateOf = (iso: string): string => iso.slice(0, 10)
const cfg = (id: string, mode: 'paper' | 'live', alloc: number): AgentConfig => ({
  id,
  name: id,
  icon: 'donut',
  color: 'blue',
  task: 'x',
  schedule: { kind: 'manual' },
  guardrails: DEFAULT_GUARDRAILS,
  mode,
  model: { vendor: 'claude', id: 'm', effort: 'low' },
  allocationUsd: alloc,
  liveArmedAt: null,
  retirement: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
})

// Paper agent: bought 10 MU at 100 yesterday, holds it. Live agent: bought 2 SPY at 500 yesterday, sold 1 at 520 today.
const paper: AgentState = { ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(9_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }], fills: [{ id: 'f1', ts: '2026-09-03T15:00:00.000Z', symbol: 'MU', side: 'buy', qty: 10, price: 100, realized: 0 }] } }
const live: AgentState = {
  ...initialState({ allocationUsd: 2_000 }),
  live: {
    ...emptyLedger(1_520),
    realizedPnl: 20,
    positions: [{ symbol: 'SPY', qty: 1, avgCost: 500 }],
    fills: [
      { id: 'f2', ts: '2026-09-03T15:00:00.000Z', symbol: 'SPY', side: 'buy', qty: 2, price: 500, realized: 0 },
      { id: 'f3', ts: '2026-09-04T15:00:00.000Z', symbol: 'SPY', side: 'sell', qty: 1, price: 520, realized: 20 }
    ]
  }
}
const retiredLive: AgentState = { ...initialState({ allocationUsd: 1_000 }), status: 'retired', retiredAt: '2026-09-01T00:00:00.000Z', live: { ...emptyLedger(1_050), realizedPnl: 50 } }
const agents = [
  { config: cfg('p1', 'paper', 10_000), state: paper },
  { config: cfg('l1', 'live', 2_000), state: live },
  { config: cfg('l2', 'live', 1_000), state: retiredLive }
]
const marks = { MU: { last: 110, prevClose: 105 }, SPY: { last: 530, prevClose: 510 } }

const pp = paperPortfolio(agents, marks, TODAY, etDateOf)
check('paper side sees only the paper agent', pp.rows.length === 1 && pp.rows[0].id === 'p1')
check('paper equity = cash + marked position', near(pp.totalEquity, 9_000 + 1_100) && near(pp.totalPnl, 100))
check('paper side has no live realized in it', near(pp.realizedPnl, 0))

const lp = livePortfolio(agents, marks, TODAY, etDateOf)
check('live side sees both live agents, retired included', lp.rows.length === 2 && lp.rows.some((r) => r.id === 'l2' && r.retired))
check('live equity = both sub-ledgers at marks', near(lp.totalEquity, 1_520 + 530 + 1_050), String(lp.totalEquity))
check('live realized is the sum of closed trades', near(lp.realizedPnl, 70))
check('live all-time P/L vs allocation', near(lp.totalPnl, 2_050 + 1_050 - 3_000) && near(lp.totalPct, 100 / 3_000))
// Today for l1: equity now 2,050; day-start = cash − sells + buys + open-at-prev-close = 1,520 − 520 + 0 + 2×510 = 2,020 → +30.
check("today's live P&L follows the cash-flow identity", near(lp.dayPnl, 30), String(lp.dayPnl))
check('rows carry each agent’s own all-time P&L (both +50 here)', lp.rows.map((r) => r.totalPnl).join() === '50,50')
check('positions are per side', lp.positions.length === 1 && lp.positions[0].symbol === 'SPY' && pp.positions[0].symbol === 'MU')

const unmarkedLive = livePortfolio(agents, { MU: { last: 110 } }, TODAY, etDateOf)
check('an unmarked live holding sits at cost and says so', !unmarkedLive.marked && unmarkedLive.unmarked.join() === 'SPY' && near(unmarkedLive.totalEquity, 1_520 + 500 + 1_050))
check('realized is unaffected by marks', near(unmarkedLive.realizedPnl, 70))

check('no live agents → empty live side with sane zeros', livePortfolio([agents[0]], marks, TODAY, etDateOf).rows.length === 0 && livePortfolio([agents[0]], marks, TODAY, etDateOf).totalPct === 0)

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
