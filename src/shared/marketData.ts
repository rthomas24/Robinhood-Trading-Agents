import type { Mode } from './agents'

/**
 * Where an agent's PRICES come from — the one rule every surface states the same way.
 *
 * Two sources exist. The operator's own Robinhood connection prices everything
 * and is the only thing that can place a live order. A market-data feed on the
 * operator's own Alpaca key (`MARKET_FEED_LABEL`, set in Settings → Connections)
 * prices PAPER agents for anyone who has not connected a broker. Live agents
 * never use it: a live order needs the broker, and pricing it from anywhere else
 * would be a fill the broker did not give.
 *
 * Pure and Node-free.
 */
export type PriceSource = 'robinhood' | 'feed' | 'none'

export const MARKET_FEED_LABEL = 'your Alpaca market-data key'

/**
 * Which source prices this agent. `broker` is whether the Robinhood connection
 * is usable, `feed` whether a market-data key is configured.
 */
export function priceSourceFor(mode: Mode, broker: boolean, feed: boolean): PriceSource {
  if (broker) return 'robinhood'
  if (mode === 'paper' && feed) return 'feed'
  return 'none'
}

/** One sentence per source, for hints, banners and the agent's own context. */
export const PRICE_SOURCE_NOTE: Record<PriceSource, string> = {
  robinhood: 'Prices come from your Robinhood connection.',
  feed: `Prices come from ${MARKET_FEED_LABEL} — paper trading works without a Robinhood account. Connect Robinhood when you want to trade live.`,
  none: 'No prices are available: connect Robinhood, or add an Alpaca market-data key (Settings → Connections) so paper agents can price.'
}

/** The Mode field's hint on the create sheet. */
export function paperModeHint(feedAvailable: boolean): string {
  return feedAvailable
    ? `Paper simulates fills at real quotes — from Robinhood when it is connected, otherwise from ${MARKET_FEED_LABEL}. Switch to live later in settings.`
    : 'Paper simulates fills at real Robinhood quotes (or add an Alpaca market-data key to paper trade without Robinhood). Switch to live later in settings.'
}

/** Onboarding: what connecting Robinhood is FOR when paper can run on a market-data key. */
export const ROBINHOOD_OPTIONAL_HINT = 'Optional for paper trading if you add an Alpaca market-data key instead. Connect Robinhood when you want an agent to trade real money.'

/** The create sheet's allocation field when there is no broker balance to size against. */
export const ALLOCATION_NO_BROKER_HINT = 'Paper agents size against the allocation you type here — no Robinhood needed. Connect Robinhood to see your real balance and to trade live.'

