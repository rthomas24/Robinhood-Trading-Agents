import type { RealtimeStreamFeed } from '@shared/realtimeAgents'
import { credentialsPath, readSecretJson, writeSecretJson } from '../lib/secureFile'

/**
 * The operator's own market-data key (Alpaca): the real-time agents'
 * one-second tape, and the polled feed that prices paper agents without
 * Robinhood (`main/market/feed.ts`). Encrypted at rest like every other secret
 * on this computer; only "configured" and the chosen feed cross to the renderer.
 */
const file = (): string => credentialsPath('market-stream.bin')

export interface StoredStreamKey {
  keyId: string
  secret: string
  feed: RealtimeStreamFeed
}

let cache: StoredStreamKey | null | undefined

export const alpacaKey = {
  get(): StoredStreamKey | null {
    if (cache === undefined) cache = readSecretJson<StoredStreamKey>(file())
    return cache
  },
  set(next: StoredStreamKey | null): void {
    cache = next
    writeSecretJson(file(), next)
  }
}
