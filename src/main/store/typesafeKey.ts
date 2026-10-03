import type { RealtimeKeyStatus } from '@shared/realtimeAgents'
import { credentialsPath, readSecretJson, writeSecretJson } from '../lib/secureFile'

/**
 * The operator's TypeSafe API key — what the real-time agents decide with.
 * Encrypted at rest like the intel MCP keys (`mcpKeys.ts`); only `hasKey`
 * and the last test's result cross to the renderer, never the value.
 */
const file = (): string => credentialsPath('typesafe.bin')

interface Stored {
  key: string
  models?: string[]
  testedAt?: string
  error?: string
}

let cache: Stored | null | undefined

function load(): Stored | null {
  if (cache === undefined) cache = readSecretJson<Stored>(file())
  return cache
}
function persist(next: Stored | null): void {
  cache = next
  writeSecretJson(file(), next)
}

export const typesafeKey = {
  /** The secret itself — for the engine only. */
  value(): string | null {
    return load()?.key ?? null
  },
  status(): RealtimeKeyStatus {
    const s = load()
    return { hasKey: Boolean(s?.key), models: s?.models, testedAt: s?.testedAt, error: s?.error }
  },
  set(key: string): RealtimeKeyStatus {
    const k = key.trim()
    persist(k ? { key: k } : null)
    return this.status()
  },
  clear(): RealtimeKeyStatus {
    return this.set('')
  },
  /** Record what the service said when the key was tried. */
  noteTest(result: { models?: string[]; error?: string }): RealtimeKeyStatus {
    const s = load()
    if (s) persist({ key: s.key, models: result.models, error: result.error, testedAt: new Date().toISOString() })
    return this.status()
  }
}
