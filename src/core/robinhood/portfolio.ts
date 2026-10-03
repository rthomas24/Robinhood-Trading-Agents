import type { PortfolioSnapshot } from '@shared/portfolio'
import type { RobinhoodMcpClient } from './mcp'
import { getAccounts, getFillsToday, getPortfolio, getPositions, getQuotes, getSparkSeries, type RhAccount } from './api'

/** The account agents trade through: the agentic-enabled one, else the first. */
export function pickAccountNumber(accounts: RhAccount[]): string | null {
  return accounts.find((a) => a.agenticAllowed)?.accountNumber ?? accounts[0]?.accountNumber ?? null
}

export async function resolveAccountNumber(rh: RobinhoodMcpClient): Promise<string | null> {
  return pickAccountNumber(await getAccounts(rh))
}

/**
 * The operator's account as one snapshot: balances, positions marked at the
 * latest quote, the quotes themselves and (optionally) intraday sparklines.
 * One builder so every reader computes the same numbers. `sparks`: `null` = fetch, an object = reuse
 * (they change slowly), `false` = skip.
 */
export async function buildPortfolioSnapshot(
  rh: RobinhoodMcpClient,
  accountNumber: string,
  opts: { sparks: Record<string, number[]> | null | false; source: PortfolioSnapshot['source']; extraSymbols?: string[] }
): Promise<PortfolioSnapshot> {
  // Today's fills ride along so the day figure can be measured from the
  // account's equity at yesterday's close. Failing to read them is NOT "no
  // trades today": the field stays absent and every reader says the figure
  // excludes today's trades (otherwise names bought that morning are counted
  // from the previous close, and a down day prints as up).
  const [p, positions, fillsToday] = await Promise.all([getPortfolio(rh, accountNumber), getPositions(rh, accountNumber), getFillsToday(rh, accountNumber).catch(() => undefined)])
  // The broker's positions PLUS whatever the agents need priced. A paper agent
  // holds nothing at the broker, so without this its symbols are never quoted
  // and every client computing P&L from this snapshot falls back to cost basis
  // — which reads as a confident 0.00% rather than as a missing price.
  // Symbols sold out today are quoted too: their previous close is what the
  // day figure values them at.
  const held = positions.map((x) => x.symbol)
  const syms = [...new Set([...held, ...(fillsToday ?? []).map((f) => f.symbol), ...(opts.extraSymbols ?? [])])]
  // QUOTES for the superset, SPARKS only for what the broker holds. Sparklines
  // are the portfolio panel's, and it draws the broker's rows; fetching a series
  // per agent-held symbol would multiply the calls on every publish for a chart
  // nothing renders.
  const [quotes, sparks] = syms.length
    ? await Promise.all([
        getQuotes(rh, syms).catch(() => []),
        opts.sparks === null ? (held.length ? getSparkSeries(rh, held).catch(() => ({})) : Promise.resolve({})) : Promise.resolve(opts.sparks || {})
      ])
    : [[], {}]
  const qmap = new Map(quotes.map((q) => [q.symbol, q]))
  return {
    accountNumber,
    buyingPower: p.buyingPower,
    cash: p.cash,
    equity: p.totalValue,
    positions: positions.map((x) => ({ ...x, marketValue: (qmap.get(x.symbol)?.last ?? x.avgCost) * x.qty })),
    ...(fillsToday ? { fillsToday } : {}),
    quotes: Object.fromEntries(qmap),
    sparks,
    fetchedAt: new Date().toISOString(),
    source: opts.source
  }
}
