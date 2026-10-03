import type { Quote } from '@shared/ipc'
import type { Mode } from '@shared/agents'
import { priceSourceFor, type PriceSource } from '@shared/marketData'
import type { RobinhoodMcpClient } from '../robinhood/mcp'
import { getBarsBatch, getQuotesDetailed, type Bar } from '../robinhood/api'

export type { Bar }

/** Bar interval the runner asks for; each feed maps it to its own vocabulary. */
export type BarInterval = 'day' | '5minute'

/**
 * A source of prices. Robinhood is one (through the operator's grant); a
 * market-data feed on the operator's own key is the other. The runner, the
 * watch sweeps and the paper broker are written against THIS, so where a quote comes from is a
 * host decision made once per run rather than a branch at every call site.
 *
 * `quotes` answers `failed` separately, because "no symbols" and "asked and
 * could not get them" call for different behaviour downstream (the prompt's
 * `COULD NOT PRICE` line) — the same contract `getQuotesDetailed` already had.
 */
export interface PriceFeed {
  readonly id: Exclude<PriceSource, 'none'>
  quotes(symbols: string[]): Promise<{ quotes: Quote[]; failed: string[] }>
  bars(symbols: string[], startIso: string, interval: BarInterval): Promise<Record<string, Bar[]>>
}

/** Robinhood, seen as a feed. */
export function robinhoodFeed(rh: RobinhoodMcpClient): PriceFeed {
  return {
    id: 'robinhood',
    quotes: (symbols) => getQuotesDetailed(rh, symbols),
    bars: (symbols, startIso, interval) => getBarsBatch(rh, symbols, startIso, interval)
  }
}

/**
 * The feed an agent prices from this run. The rule is `priceSourceFor` from
 * shared — the same one the apps' copy is written against — applied to what
 * the host actually has: a broker client, and (for paper) a market-data feed.
 */
export function pickFeed(mode: Mode, rh: RobinhoodMcpClient | null, platform: PriceFeed | null): PriceFeed | null {
  const source = priceSourceFor(mode, rh !== null, platform !== null)
  if (source === 'robinhood') return robinhoodFeed(rh!)
  if (source === 'feed') return platform
  return null
}

/** Normalise the way every feed does: upper-case, de-duplicated, empties dropped. */
export function normSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))]
}
