import { money, type AgentConfig, type Fill, type Ledger, type Position } from './agents'
import { describeSchedule } from './schedule'

/**
 * An agent's track record, computed from its OWN book — the paper ledger or the
 * live sub-ledger, never the shared Robinhood account — and a plain-text
 * scorecard of it that can be pasted anywhere.
 *
 * The maths used to live inside the stats sheet, so nothing could be shared
 * without a screenshot. One pure function, and the sheet renders from it
 * rather than from a second copy that would drift.
 *
 * Everything here is arithmetic over fills the ledger already holds: realized
 * P&L is what `applyFill` recorded at each sell, unrealized marks open
 * positions at the `last` prices passed in (falling back to average cost, i.e.
 * zero unrealized, when there is no quote). Nothing is estimated.
 *
 * Pure and Node-free.
 */

export interface OpenPosition extends Position {
  /** The mark used — the quote passed in, or avg cost when there was none. */
  last: number
  value: number
  unrealized: number
  /** Unrealized as a fraction of cost basis. */
  uPct: number
}

export interface SymbolRow {
  symbol: string
  /** Fills, both sides. */
  trades: number
  volume: number
  realized: number
}

export interface TrackRecord {
  /** Every fill, oldest first. */
  fills: Fill[]
  buys: Fill[]
  sells: Fill[]
  /** Sells that made money / lost money (a flat sell is neither). */
  wins: Fill[]
  losses: Fill[]
  grossWin: number
  grossLoss: number
  /** grossWin / grossLoss; null until there is a losing sell to divide by. */
  profitFactor: number | null
  /** wins / sells; null until the first sell. */
  winRate: number | null
  best: number
  worst: number
  /** Notional traded, both sides. */
  volume: number
  positions: OpenPosition[]
  marketValue: number
  equity: number
  realized: number
  unrealized: number
  totalPnl: number
  /** totalPnl / allocation (0 when the allocation is 0). */
  retPct: number
  /** Cumulative realized P&L, one point per sell, starting at creation. */
  curve: { t: string; v: number }[]
  /** Per-symbol breakdown, best realized first. */
  bySymbol: SymbolRow[]
}

export function trackRecord(cfg: Pick<AgentConfig, 'allocationUsd' | 'createdAt'>, ledger: Ledger, last: Record<string, number> = {}): TrackRecord {
  const fills = [...ledger.fills].sort((a, b) => a.ts.localeCompare(b.ts))
  const sells = fills.filter((f) => f.side === 'sell')
  const buys = fills.filter((f) => f.side === 'buy')
  const wins = sells.filter((f) => f.realized > 0)
  const losses = sells.filter((f) => f.realized < 0)
  const grossWin = wins.reduce((s, f) => s + f.realized, 0)
  const grossLoss = Math.abs(losses.reduce((s, f) => s + f.realized, 0))
  const volume = fills.reduce((s, f) => s + f.qty * f.price, 0)
  let marketValue = 0
  let unrealized = 0
  const positions: OpenPosition[] = ledger.positions.map((p) => {
    const mark = last[p.symbol] ?? p.avgCost
    const value = p.qty * mark
    const u = (mark - p.avgCost) * p.qty
    marketValue += value
    unrealized += u
    return { ...p, last: mark, value, unrealized: u, uPct: p.avgCost > 0 ? (mark - p.avgCost) / p.avgCost : 0 }
  })
  const equity = ledger.cash + marketValue
  const totalPnl = ledger.realizedPnl + unrealized
  let acc = 0
  const curve = [{ t: cfg.createdAt, v: 0 }, ...sells.map((f) => ({ t: f.ts, v: (acc += f.realized) }))]
  const bySymbol = new Map<string, SymbolRow>()
  for (const f of fills) {
    const row = bySymbol.get(f.symbol) ?? { symbol: f.symbol, trades: 0, volume: 0, realized: 0 }
    row.trades++
    row.volume += f.qty * f.price
    if (f.side === 'sell') row.realized += f.realized
    bySymbol.set(f.symbol, row)
  }
  return {
    fills,
    buys,
    sells,
    wins,
    losses,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    winRate: sells.length ? wins.length / sells.length : null,
    best: sells.length ? Math.max(...sells.map((f) => f.realized)) : 0,
    worst: sells.length ? Math.min(...sells.map((f) => f.realized)) : 0,
    volume,
    positions,
    marketValue,
    equity,
    realized: ledger.realizedPnl,
    unrealized,
    totalPnl,
    retPct: cfg.allocationUsd > 0 ? totalPnl / cfg.allocationUsd : 0,
    curve,
    bySymbol: [...bySymbol.values()].sort((a, b) => b.realized - a.realized)
  }
}

/** '+$12.34' / '−$5.00' with a real minus sign. */
export const signedMoney = (n: number, dp = 2): string => `${n >= 0 ? '+' : '−'}${money(Math.abs(n), dp)}`

/** '+1.2%' from a fraction. */
export const signedPct = (n: number, dp = 1): string => `${n >= 0 ? '+' : '−'}${(Math.abs(n) * 100).toFixed(dp)}%`

/** Whole days since `iso`, never below 1 — an agent made this morning has been going for a day, not zero. */
export function daysSince(iso: string, now: number = Date.now()): number {
  const ms = now - Date.parse(iso)
  return Math.max(1, Math.round(ms / 86_400_000))
}

/**
 * The scorecard as plain text — six short lines that survive being pasted into
 * a chat, a tweet or an email with their meaning intact.
 *
 * Two lines are not optional. The mode label: paper and live must never be
 * confusable in something built to travel, and paper says what a paper fill
 * is. And the last line: this is a record of what one agent's own book did,
 * stated so it cannot be read as a promise about what it will do.
 */
export function scorecardText(cfg: Pick<AgentConfig, 'name' | 'mode' | 'allocationUsd' | 'createdAt' | 'schedule'>, t: TrackRecord, now: number = Date.now()): string {
  const days = daysSince(cfg.createdAt, now)
  const mode = cfg.mode === 'live' ? 'LIVE' : 'PAPER'
  const lines: string[] = []
  lines.push(`📊 ${cfg.name} — trading agent · ${mode} · ${days} day${days === 1 ? '' : 's'}`)
  lines.push(`${signedMoney(t.totalPnl)} total (${signedPct(t.retPct)} of ${money(cfg.allocationUsd, 0)}) · realized ${signedMoney(t.realized)} · unrealized ${signedMoney(t.unrealized)}`)
  if (t.sells.length) {
    const wr = t.winRate === null ? '—' : `${Math.round(t.winRate * 100)}%`
    const pf = t.profitFactor === null ? '—' : t.profitFactor.toFixed(2)
    lines.push(`${t.wins.length}W / ${t.losses.length}L · win rate ${wr} · profit factor ${pf} · best ${signedMoney(t.best)} · worst ${signedMoney(t.worst)}`)
  } else {
    lines.push('No closed trades yet.')
  }
  const top = t.bySymbol.slice(0, 4).map((s) => `${s.symbol} ${signedMoney(s.realized, 0)}`)
  lines.push(`${t.fills.length} fill${t.fills.length === 1 ? '' : 's'} · ${money(t.volume, 0)} traded${top.length ? ` · ${top.join(' · ')}` : ''}`)
  if (t.positions.length) {
    lines.push(`Open: ${t.positions.map((p) => `${p.qty} ${p.symbol} @ ${money(p.avgCost)} (${signedMoney(p.unrealized)})`).join(', ')}`)
  } else {
    lines.push('Open: flat')
  }
  lines.push(`Runs: ${describeSchedule(cfg.schedule)}`)
  lines.push(cfg.mode === 'live' ? 'Live fills in the agent’s own sub-ledger. Past results are not a forecast.' : 'Paper: simulated fills at real Robinhood quotes. Past results are not a forecast.')
  return lines.join('\n')
}

/* ── the fleet ─────────────────────────────────────────────────────────── */

/**
 * One side of the portfolio page — every paper book, or every live sub-ledger —
 * as text. Same discipline as the single-agent card: the first line says which
 * side it is, the last says a record is not a forecast, and paper and live are
 * never in one text (the caller passes one side).
 *
 * `unmarked` matters here more than anywhere: a holding with no quote sits at
 * cost, so the total is a floor, and the text says so instead of rounding a
 * partly-priced book to a confident number.
 */
export function fleetScorecardText(
  side: 'paper' | 'live',
  p: { rows: { name: string; retired: boolean; totalPnl: number; realizedPnl: number; trades: number; marked: boolean }[]; totalEquity: number; totalAllocated: number; totalPnl: number; totalPct: number; dayPnl: number; realizedPnl: number; marked: boolean; unmarked: string[] },
  now: number = Date.now()
): string {
  const label = side === 'live' ? 'LIVE' : 'PAPER'
  const active = p.rows.filter((r) => !r.retired).length
  const retired = p.rows.length - active
  const lines: string[] = []
  lines.push(`📊 Robinhood Trading Agents — ${p.rows.length} ${label.toLowerCase()} agent${p.rows.length === 1 ? '' : 's'} (${active} active${retired ? `, ${retired} retired` : ''}) · ${new Date(now).toISOString().slice(0, 10)}`)
  lines.push(`${signedMoney(p.totalPnl)} all-time (${signedPct(p.totalPct)} of ${money(p.totalAllocated, 0)}) · realized ${signedMoney(p.realizedPnl)} · today ${signedMoney(p.dayPnl)}${p.marked ? '' : ` · ${p.unmarked.length} holding${p.unmarked.length === 1 ? '' : 's'} at cost (no quote)`}`)
  const top = [...p.rows].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 5)
  for (const r of top) lines.push(`• ${r.name}${r.retired ? ' (retired)' : ''}: ${signedMoney(r.totalPnl)} · realized ${signedMoney(r.realizedPnl)} · ${r.trades} fill${r.trades === 1 ? '' : 's'}${r.marked ? '' : ' · at cost'}`)
  if (p.rows.length > top.length) lines.push(`• …and ${p.rows.length - top.length} more`)
  lines.push(side === 'live' ? 'Live: each agent’s own fills only, never the whole account. Past results are not a forecast.' : 'Paper: simulated fills at real Robinhood quotes. Past results are not a forecast.')
  return lines.join('\n')
}
