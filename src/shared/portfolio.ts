import type { AccountFill, AccountSnapshot, Quote } from './ipc'

/**
 * The operator's Robinhood account as last seen through their Robinhood
 * connection, for the portfolio panel — with an honest "as of".
 */
export interface PortfolioSnapshot extends AccountSnapshot {
  /**
   * Latest quotes for every symbol this ACCOUNT needs priced — the broker's own
   * positions AND anything an agent holds or traded today.
   *
   * A superset of the positions, deliberately. It used to be exactly the broker
   * account's holdings, which is wrong for the thing that reads it: a PAPER
   * agent holds META in its own ledger and nothing at the broker, so its mark
   * was absent by construction and every P&L collapsed to cost basis — a
   * confident, wrong 0.00% for the day on every paper agent.
   *
   * `portfolioRows` still looks up only its own positions, so the extra entries
   * cost a few bytes and change nothing there.
   */
  quotes: Record<string, Quote>
  /** Intraday close series per symbol (last session) for sparklines. */
  sparks: Record<string, number[]>
  source: 'desktop'
}

/**
 * The inputs the day figure needs. `AccountSnapshot` carries them all; the
 * portfolio panel assembles them from its own polls (account, then quotes).
 */
export type PortfolioDayInput = Pick<AccountSnapshot, 'positions' | 'cash' | 'equity' | 'fillsToday'> & { quotes: Record<string, Quote>; sparks?: Record<string, number[]> }

export interface PortfolioRow {
  symbol: string
  qty: number
  last: number
  changePct?: number
  prevClose?: number
  value: number
  /**
   * This symbol's contribution to the ACCOUNT's day change: what the shares
   * held at yesterday's close moved, plus what today's buys made or lost since
   * their fill, plus what today's sells realized against yesterday's close.
   * NOT `(last − prevClose) × qty`: shares bought this morning did not exist
   * at yesterday's close, so counting their whole day move made an account
   * that was down for the day read as up.
   */
  dayMove: number
  closes: number[]
}

/** Per-symbol tally of today's executions. */
function fillsBySymbol(fills: AccountFill[] | undefined): Map<string, { bought: number; boughtCost: number; sold: number; soldProceeds: number }> {
  const m = new Map<string, { bought: number; boughtCost: number; sold: number; soldProceeds: number }>()
  for (const f of fills ?? []) {
    const t = m.get(f.symbol) ?? { bought: 0, boughtCost: 0, sold: 0, soldProceeds: 0 }
    if (f.side === 'buy') {
      t.bought += f.qty
      t.boughtCost += f.qty * f.price
    } else {
      t.sold += f.qty
      t.soldProceeds += f.qty * f.price
    }
    m.set(f.symbol, t)
  }
  return m
}

/**
 * Day move of one symbol: `qty·last − qty0·prevClose − boughtCost + soldProceeds`,
 * where `qty0 = qty − bought + sold` is what was held at yesterday's close.
 * Algebraically the symbol's share of (equity now − equity at the close).
 * With no prevClose the overnight part is unknown and counts as zero — the
 * same silence the old figure had — while today's fills still count: the
 * day-start shares are valued at the last price, or, for a symbol with no
 * quote at all (sold out today, never re-priced), at today's own sell price.
 */
function symbolDayMove(qty: number, last: number, prevClose: number | undefined, t: { bought: number; boughtCost: number; sold: number; soldProceeds: number } | undefined): number {
  const bought = t?.bought ?? 0
  const sold = t?.sold ?? 0
  const qty0 = Math.max(0, qty - bought + sold)
  const sellAvg = sold > 0 ? (t?.soldProceeds ?? 0) / sold : 0
  const ref = prevClose ?? (last > 0 ? last : sellAvg)
  return qty * last - qty0 * ref - (t?.boughtCost ?? 0) + (t?.soldProceeds ?? 0)
}

/** Positions enriched with the snapshot's quotes — one computation for every client. */
export function portfolioRows(s: PortfolioDayInput): PortfolioRow[] {
  const fills = fillsBySymbol(s.fillsToday)
  return s.positions
    .map((p) => {
      const q = s.quotes[p.symbol]
      const last = q?.last ?? (p.qty > 0 ? p.marketValue / p.qty : 0)
      return {
        symbol: p.symbol,
        qty: p.qty,
        last,
        changePct: q?.changePct,
        prevClose: q?.prevClose,
        value: last * p.qty,
        dayMove: symbolDayMove(p.qty, last, q?.prevClose, fills.get(p.symbol)),
        closes: s.sparks?.[p.symbol] ?? []
      }
    })
    .sort((a, b) => b.value - a.value)
}

/**
 * Equity + day move from a snapshot. `dayChange` is the account's equity now
 * minus its equity at yesterday's close, rebuilt from today's fills: a symbol
 * sold out entirely today still counts (its proceeds against what it was
 * worth at the close), which no position row can carry. `fillsKnown` is false
 * when the snapshot has no fill list — the figure then ignores today's
 * trades, and a client must say so rather than print it as the day.
 */
export function portfolioTotals(s: PortfolioDayInput): { equity: number; dayChange: number; dayPct: number; fillsKnown: boolean } {
  const rows = portfolioRows(s)
  const held = new Set(rows.map((r) => r.symbol))
  let dayChange = rows.reduce((acc, r) => acc + r.dayMove, 0)
  for (const [sym, t] of fillsBySymbol(s.fillsToday)) {
    if (held.has(sym)) continue
    // Flat now, traded today: what was held at the close was `sold − bought`
    // shares, valued at the previous close if a quote for it was fetched.
    dayChange += symbolDayMove(0, s.quotes[sym]?.last ?? 0, s.quotes[sym]?.prevClose, t)
  }
  const marketValue = rows.reduce((acc, r) => acc + r.value, 0)
  const equity = marketValue > 0 ? marketValue + s.cash : s.equity
  const dayPct = equity - dayChange > 0 ? (dayChange / (equity - dayChange)) * 100 : 0
  return { equity, dayChange, dayPct, fillsKnown: s.fillsToday !== undefined }
}
