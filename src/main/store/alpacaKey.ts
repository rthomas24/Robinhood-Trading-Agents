import { normMarketDataFeed, type MarketDataFeed, type MarketDataStatus } from '@shared/marketData'
import { credentialsPath, readSecretJson, writeSecretJson } from '../lib/secureFile'

/**
 * The operator's own market-data key (Alpaca): the polled feed that prices
 * paper agents without Robinhood (`main/market/feed.ts`). Encrypted at rest
 * like every other secret on this computer; only "configured" and the chosen
 * feed cross to the renderer. The file keeps its original name so a key saved
 * by an earlier build is still found.
 */
const file = (): string => credentialsPath('market-stream.bin')

export interface StoredMarketKey {
  keyId: string
  secret: string
  feed: MarketDataFeed
}

let cache: StoredMarketKey | null | undefined

export const alpacaKey = {
  get(): StoredMarketKey | null {
    if (cache === undefined) {
      const raw = readSecretJson<StoredMarketKey>(file())
      cache = raw ? { ...raw, feed: normMarketDataFeed(raw.feed) } : null
    }
    return cache
  },
  set(next: StoredMarketKey | null): void {
    cache = next
    writeSecretJson(file(), next)
  },
  status(): MarketDataStatus {
    const k = this.get()
    return { configured: Boolean(k?.keyId && k.secret), feed: k?.feed ?? 'iex' }
  }
}
