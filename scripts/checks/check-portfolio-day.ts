/**
 * The portfolio's "today" is the account's equity against yesterday's close,
 * not the day move of whatever is held right now.
 *
 * The failure shape: the Robinhood panel reads UP on the day while the account
 * is DOWN, because every position was bought that morning by a live agent and
 * the panel priced each one as `(last − prevClose) × qty` — the whole day's
 * move on shares that did not exist at yesterday's close.
 *
 * The contract now (`shared/portfolio.ts`, one function for every view):
 *
 *   1. dayChange = equity now − equity at the close, rebuilt from today's
 *      fills: shares held at the close move from prevClose, shares bought
 *      today move from their fill, shares sold today realize against the close.
 *   2. A symbol sold out entirely today still counts (no position row can
 *      carry it).
 *   3. No fill list (`fillsToday` absent) is UNKNOWN, not "no trades": the
 *      figure falls back to the old one and `fillsKnown` is false so the client
 *      says so.
 *   4. `getFillsToday` keeps orders whose LAST CHANGE is today — a GTC limit
 *      placed yesterday and filled today counts; yesterday's fills do not.
 *
 *   npm run check -- portfolio-day
 */
import { portfolioRows, portfolioTotals, type PortfolioDayInput } from '@shared/portfolio'
import type { Quote } from '@shared/ipc'
import { getFillsToday } from '@core/robinhood/api'
import type { RobinhoodMcpClient } from '@core/robinhood/mcp'
import { etClock, etDateTime } from '@shared/marketTime'

let failures = 0
const ok = (cond: boolean, msg: string): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}
const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) < eps
const q = (symbol: string, last: number, prevClose: number): Quote => ({ symbol, last, prevClose, changePct: ((last - prevClose) / prevClose) * 100, ts: 'now' })

// ── 1. A morning where everything held was bought today ─────────────────────
// Three names bought after the open, each up 2–5% on the day but within ±1% of
// its fill. The account is roughly flat minus fees; the old formula credits the
// whole day move.
const bought: PortfolioDayInput = {
  cash: 200,
  equity: 600,
  positions: [
    { symbol: 'SHOP', qty: 1.5, avgCost: 140, marketValue: 1.5 * 140.6 },
    { symbol: 'UBER', qty: 0.5, avgCost: 180, marketValue: 0.5 * 180.8 },
    { symbol: 'CRM', qty: 0.2, avgCost: 520, marketValue: 0.2 * 516 }
  ],
  quotes: { SHOP: q('SHOP', 140.6, 133), UBER: q('UBER', 180.8, 173), CRM: q('CRM', 516, 506) },
  fillsToday: [
    { symbol: 'SHOP', side: 'buy', qty: 1.5, price: 140, at: 'today' },
    { symbol: 'UBER', side: 'buy', qty: 0.5, price: 180, at: 'today' },
    { symbol: 'CRM', side: 'buy', qty: 0.2, price: 520, at: 'today' }
  ]
}
{
  const old = bought.positions.reduce((s, p) => s + (bought.quotes[p.symbol].last - bought.quotes[p.symbol].prevClose!) * p.qty, 0)
  const t = portfolioTotals(bought)
  const expected = (140.6 - 140) * 1.5 + (180.8 - 180) * 0.5 + (516 - 520) * 0.2
  console.log(`old formula ${old.toFixed(2)} · fill-aware ${t.dayChange.toFixed(2)} · expected ${expected.toFixed(2)}`)
  ok(old > 15, `the old formula reads the day as +$${old.toFixed(2)} (the bug)`)
  ok(near(t.dayChange, expected), `bought-today shares move from their FILL, not from the previous close (${t.dayChange.toFixed(2)})`)
  ok(t.fillsKnown, 'fills known → the figure is the day')
  const crm = portfolioRows(bought).find((r) => r.symbol === 'CRM')!
  ok(near(crm.dayMove, (516 - 520) * 0.2), 'a row bought today carries its move since the fill')
  ok(near(crm.changePct ?? 0, ((516 - 506) / 506) * 100), "the row's % is still the STOCK's day move (that is what the row shows)")
}

// ── 2. Held overnight + added today: two references in one row ───────────
{
  const s: PortfolioDayInput = {
    cash: 0,
    equity: 0,
    positions: [{ symbol: 'NVDA', qty: 30, avgCost: 220, marketValue: 30 * 226 }],
    quotes: { NVDA: q('NVDA', 226, 224) },
    fillsToday: [{ symbol: 'NVDA', side: 'buy', qty: 10, price: 228, at: 'today' }]
  }
  const t = portfolioTotals(s)
  // 20 sh from the close: +2 each · 10 sh from a 228 fill: −2 each
  ok(near(t.dayChange, 20 * 2 + 10 * -2), `overnight shares move from prevClose, today's from the fill (${t.dayChange.toFixed(2)})`)
}

// ── 3. Sold out entirely today: the row is gone, the day is not ──────────
{
  const s: PortfolioDayInput = {
    cash: 1000,
    equity: 1000,
    positions: [],
    quotes: { ETSY: q('ETSY', 36.5, 37.4) },
    fillsToday: [{ symbol: 'ETSY', side: 'sell', qty: 2, price: 36.8, at: 'today' }]
  }
  const t = portfolioTotals(s)
  ok(portfolioRows(s).length === 0, 'no row for a symbol no longer held')
  ok(near(t.dayChange, 2 * (36.8 - 37.4)), `a symbol sold out today counts its proceeds against the close (${t.dayChange.toFixed(2)})`)
  // Same sale with no quote for it at all: the close is unknown, so only the
  // round trip counts — never the whole proceeds as gain.
  const blind = { ...s, quotes: {} }
  ok(near(portfolioTotals(blind).dayChange, 0), 'sold out with no quote: no overnight move is invented')
}

// ── 4. Round trip today ─────────────────────────────────────────────────
{
  const s: PortfolioDayInput = {
    cash: 500,
    equity: 500,
    positions: [],
    quotes: { PLTR: q('PLTR', 170, 172) },
    fillsToday: [
      { symbol: 'PLTR', side: 'buy', qty: 3, price: 168, at: 'today' },
      { symbol: 'PLTR', side: 'sell', qty: 3, price: 171, at: 'today' }
    ]
  }
  ok(near(portfolioTotals(s).dayChange, 9), 'a round trip today is its realized P&L, whatever the stock did vs the close')
}

// ── 5. Unknown fills: the old figure, flagged ───────────────────────────
{
  const { fillsToday: _drop, ...noFills } = bought
  void _drop
  const t = portfolioTotals(noFills)
  ok(!t.fillsKnown, 'no fill list → fillsKnown false (the client must say the figure excludes today\'s trades)')
  ok(t.dayChange > 15, 'and the figure is the old one, not zero')
  ok(near(t.equity, 200 + bought.positions.reduce((s, p) => s + p.marketValue, 0)), 'equity is unaffected either way')
}

// ── 6. getFillsToday keeps only orders whose LAST CHANGE is today ───────
{
  const now = new Date()
  const today = etClock(now).date
  const yesterday = new Date(etDateTime(today, 0).getTime() - 3_600_000).toISOString() // 23:00 ET the day before
  const thisMorning = etDateTime(today, 10 * 60).toISOString()
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = {
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return {
        results: [
          // filled yesterday
          { id: 'a', symbol: 'ETSY', side: 'buy', state: 'filled', quantity: '2', cumulative_quantity: '2', average_price: '37.20', created_at: yesterday, updated_at: yesterday },
          // GTC limit placed yesterday, filled this morning
          { id: 'b', symbol: 'SHOP', side: 'buy', state: 'filled', quantity: '1.5', cumulative_quantity: '1.5', average_price: '140.00', created_at: yesterday, last_transaction_at: thisMorning },
          // placed and filled today
          { id: 'c', symbol: 'UBER', side: 'buy', state: 'filled', quantity: '0.5', cumulative_quantity: '0.4997', average_price: '180.00', created_at: thisMorning },
          // cancelled today, nothing executed
          { id: 'd', symbol: 'CRM', side: 'buy', state: 'cancelled', quantity: '1', cumulative_quantity: '0', created_at: thisMorning },
          // partial fill today, priced from executions
          { id: 'e', symbol: 'CRM', side: 'buy', state: 'partially_filled', quantity: '1', cumulative_quantity: '0.2', created_at: thisMorning, executions: [{ price: '520.00', quantity: '0.2', timestamp: thisMorning }] }
        ]
      }
    }
  } as unknown as RobinhoodMcpClient
  const fills = await getFillsToday(client, 'ACC1', now)
  ok(calls.length === 1 && calls[0].name === 'get_equity_orders' && typeof calls[0].args.created_at_gte === 'string', 'one get_equity_orders call, bounded by created_at_gte')
  ok(new Date(String(calls[0].args.created_at_gte)).getTime() < new Date(yesterday).getTime(), 'the window reaches back past yesterday (a resting limit fills later than it was placed)')
  const syms = fills.map((f) => `${f.side} ${f.symbol} ${f.qty}@${f.price}`).sort()
  console.log(`  fills today: ${syms.join(' · ')}`)
  ok(!fills.some((f) => f.symbol === 'ETSY'), "yesterday's fill is not today's")
  ok(fills.some((f) => f.symbol === 'SHOP' && near(f.price, 140)), 'a GTC limit placed yesterday and filled today counts')
  ok(fills.some((f) => f.symbol === 'UBER' && near(f.qty, 0.4997, 1e-6)), 'quantity is what EXECUTED, not what was asked')
  ok(fills.filter((f) => f.symbol === 'CRM').length === 1 && near(fills.find((f) => f.symbol === 'CRM')!.price, 520), 'a cancelled order is skipped; a partial fill is priced from its executions')
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
