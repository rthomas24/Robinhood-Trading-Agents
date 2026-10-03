import { alpacaFeed } from '@core/market/alpaca'
import type { PriceFeed } from '@core/market/feed'
import { alpacaKey, type StoredMarketKey } from '../store/alpacaKey'

/**
 * The market-data feed for PAPER agents on this computer: Alpaca Market Data on
 * the operator's OWN key (entered in Settings → Connections). Prices paper
 * agents when Robinhood is not connected; never used for a live agent.
 *
 * Null when no key is stored. One instance per key, so its short quote cache is
 * shared by every agent and the watch sweep.
 */
let feed: { stored: StoredMarketKey; value: PriceFeed } | null = null

export function desktopMarketFeed(): PriceFeed | null {
  const k = alpacaKey.get()
  if (!k?.keyId || !k.secret) {
    feed = null
    return null
  }
  // `alpacaKey.get()` returns the same object until the key is saved again, so
  // a corrected secret under the same key id gets a fresh client.
  if (feed?.stored === k) return feed.value
  feed = {
    stored: k,
    value: alpacaFeed({
      keyId: k.keyId,
      secretKey: k.secret,
      feed: k.feed,
      log: (level, msg) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[market-feed] ${msg}`)
    })
  }
  return feed.value
}
