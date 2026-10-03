import type { OpenRouterStatus } from '@shared/ipc'
import { credentialsPath, readSecretJson, writeSecretJson } from '../lib/secureFile'

/**
 * The operator's own OpenRouter API key — what agents on the OpenRouter
 * provider think with. Encrypted at rest like every other secret on this
 * computer; only `OpenRouterStatus` crosses to the renderer, never the value.
 */
const file = (): string => credentialsPath('openrouter.bin')

interface Stored {
  key: string
  label?: string
  usageUsd?: number
  limitUsd?: number | null
  testedAt?: string
  error?: string
}

/** OpenRouter's "who am I" endpoint for an API key: label, usage, limit. */
const KEY_INFO_URL = 'https://openrouter.ai/api/v1/key'

let cache: Stored | null | undefined
const listeners = new Set<() => void>()

function load(): Stored | null {
  if (cache === undefined) cache = readSecretJson<Stored>(file())
  return cache
}
function persist(next: Stored | null): void {
  cache = next
  writeSecretJson(file(), next)
  for (const l of listeners) l()
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export const openrouterKey = {
  /** The secret itself — for the engine only. */
  value(): string | null {
    return load()?.key ?? null
  },
  status(): OpenRouterStatus {
    const s = load()
    if (!s?.key) return { hasKey: false, detail: 'No API key yet. Create one at openrouter.ai/keys and paste it here.' }
    const detail = s.error
      ? `The last check failed: ${s.error}`
      : s.testedAt
        ? `Key works${s.label ? ` (“${s.label}”)` : ''}${s.usageUsd !== undefined ? ` · $${s.usageUsd.toFixed(2)} used` : ''}${s.limitUsd ? ` of $${s.limitUsd.toFixed(2)}` : ''}.`
        : 'Key saved. Test it to confirm it works.'
    return { hasKey: true, detail, label: s.label, usageUsd: s.usageUsd, limitUsd: s.limitUsd, testedAt: s.testedAt, error: s.error }
  },
  set(key: string): OpenRouterStatus {
    const k = key.trim()
    persist(k ? { key: k } : null)
    return this.status()
  },
  clear(): OpenRouterStatus {
    return this.set('')
  },
  /** Ask openrouter.ai about the stored key. Records the answer (or the failure) and returns the new status. */
  async test(): Promise<OpenRouterStatus> {
    const s = load()
    if (!s?.key) return this.status()
    try {
      const res = await fetch(KEY_INFO_URL, { headers: { Authorization: `Bearer ${s.key}` }, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) {
        persist({ key: s.key, testedAt: new Date().toISOString(), error: res.status === 401 ? 'OpenRouter did not accept this key.' : `OpenRouter answered ${res.status}.` })
        return this.status()
      }
      const body = (await res.json().catch(() => ({}))) as { data?: { label?: unknown; usage?: unknown; limit?: unknown } }
      const d = body.data ?? {}
      persist({
        key: s.key,
        label: typeof d.label === 'string' ? d.label : undefined,
        usageUsd: num(d.usage),
        limitUsd: d.limit === null ? null : num(d.limit),
        testedAt: new Date().toISOString()
      })
    } catch (err) {
      persist({ key: s.key, testedAt: new Date().toISOString(), error: /abort|timeout|fetch failed|ENOTFOUND|ECONN/i.test((err as Error).message) ? 'Could not reach openrouter.ai.' : (err as Error).message })
    }
    return this.status()
  },
  onChange(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
}
