import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { McpStatus } from '@shared/ipc'
import { MCP_PROVIDER_IDS, type McpProviderId, type McpRuntimeNeed } from '@shared/mcps'
import type { ToolAccess } from '@core/intel/servers'
import { credentialsPath, readSecretJson, writeSecretJson } from '../lib/secureFile'
import { settingsStore } from './settingsStore'

/**
 * API keys/tokens for the intel MCP providers, encrypted at rest like the
 * Robinhood credentials. Only "is a key stored" crosses to the renderer; the
 * values are injected into MCP server configs at run time (`toolAccess()`).
 */
const file = (): string => credentialsPath('mcp-keys.bin')

let cache: Partial<Record<McpProviderId, string>> | undefined

function load(): Partial<Record<McpProviderId, string>> {
  if (!cache) cache = readSecretJson<Partial<Record<McpProviderId, string>>>(file()) ?? {}
  return cache
}
function persist(next: Partial<Record<McpProviderId, string>>): void {
  cache = next
  writeSecretJson(file(), Object.keys(next).length === 0 ? null : next)
}

/** Is `cmd` on PATH? Pure filesystem probe — nothing is spawned. */
function onPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) if (existsSync(join(dir, cmd + ext))) return true
  }
  return false
}

let runtimeCache: { at: number; value: Record<McpRuntimeNeed, boolean> } | null = null
function runtimes(): Record<McpRuntimeNeed, boolean> {
  // PATH rarely changes while the app runs; re-probe at most once a minute.
  if (runtimeCache && Date.now() - runtimeCache.at < 60_000) return runtimeCache.value
  const value = { uv: onPath('uvx'), node: onPath('npx') }
  runtimeCache = { at: Date.now(), value }
  return value
}

export const mcpKeys = {
  status(): McpStatus {
    const keys = load()
    return {
      keys: Object.fromEntries(MCP_PROVIDER_IDS.map((id) => [id, Boolean(keys[id])])) as McpStatus['keys'],
      runtimes: runtimes(),
      platform: process.platform
    }
  },
  set(id: McpProviderId, key: string): McpStatus {
    const k = key.trim()
    if (!MCP_PROVIDER_IDS.includes(id)) throw new Error(`unknown provider ${id}`)
    const next = { ...load() }
    if (k) next[id] = k
    else delete next[id]
    persist(next)
    return this.status()
  },
  clear(id: McpProviderId): McpStatus {
    return this.set(id, '')
  },
  /** The `RuntimeDeps.tools` resolver: policy from settings + secrets from here. */
  async toolAccess(): Promise<ToolAccess> {
    const policy = settingsStore.load().tools
    const all = load()
    const keys: Record<string, string> = {}
    for (const id of policy.mcpEnabled) if (all[id]) keys[id] = all[id]!
    return { policy, keys, runtimes: runtimes(), platform: process.platform }
  }
}
