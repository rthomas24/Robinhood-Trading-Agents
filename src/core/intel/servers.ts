import { DEFAULT_TOOL_POLICY, mcpProvider, type McpProviderId, type McpRuntimeNeed, type ToolPolicy } from '@shared/mcps'

/**
 * Resolve the operator's tool policy into what one run needs: extra SDK
 * `mcpServers` entries for the enabled intel providers (secrets injected), a
 * tool-name predicate for `canUseTool`, and the prompt lines that tell the
 * agent what each source is for. Host-agnostic: the host supplies keys and
 * what runtimes exist on the machine.
 */
export interface ToolAccess {
  policy: ToolPolicy
  /** Provider id → API key/token (only for enabled, keyed providers). */
  keys: Record<string, string>
  /** Runtimes available on this host for stdio servers. */
  runtimes: Record<McpRuntimeNeed, boolean>
  platform: NodeJS.Platform
}

export const DEFAULT_TOOL_ACCESS: ToolAccess = { policy: DEFAULT_TOOL_POLICY, keys: {}, runtimes: { uv: false, node: false }, platform: 'linux' }

export type McpServerSpec = { type: 'http'; url: string; headers?: Record<string, string> } | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }

export interface ResolvedIntel {
  servers: Record<string, McpServerSpec>
  /** Providers that are on but cannot run here (missing key / runtime) — surfaced in logs. */
  skipped: { id: McpProviderId; reason: string }[]
  /** `PROVIDER (mcp__id__*): hint` lines for the prompt. */
  promptLines: string[]
}

export function resolveIntelServers(access: ToolAccess): ResolvedIntel {
  const out: ResolvedIntel = { servers: {}, skipped: [], promptLines: [] }
  for (const id of access.policy.mcpEnabled) {
    const p = mcpProvider(id)
    if (!p) continue
    const key = access.keys[id]?.trim()
    if (p.keyed && !key) {
      out.skipped.push({ id, reason: `${p.keyLabel ?? 'API key'} not set` })
      continue
    }
    const t = p.transport
    if (t.kind === 'http') {
      let url = t.url
      if (t.keyQueryParam && key) {
        const u = new URL(url)
        u.searchParams.set(t.keyQueryParam, key)
        url = u.toString()
      }
      const headers = t.headers ? Object.fromEntries(Object.entries(t.headers).map(([k, v]) => [k, v.replace('${KEY}', key ?? '')])) : undefined
      out.servers[id] = { type: 'http', url, ...(headers ? { headers } : {}) }
    } else {
      if (!access.runtimes[t.needs]) {
        // The runtime (uv / Node) is not installed on this machine.
        out.skipped.push({ id, reason: `${t.needs === 'uv' ? 'uv (Python)' : 'Node.js / npx'} is not available where this agent runs` })
        continue
      }
      // Windows: `npx` is a .cmd shim that cannot be spawned directly — run it
      // through the command interpreter. `uvx` is a real executable.
      const viaCmd = access.platform === 'win32' && t.command === 'npx'
      const env: Record<string, string> = {}
      if (t.keyEnv && key) env[t.keyEnv] = key
      out.servers[id] = {
        type: 'stdio',
        command: viaCmd ? 'cmd' : t.command,
        args: viaCmd ? ['/c', t.command, ...t.args] : t.args,
        ...(Object.keys(env).length ? { env } : {})
      }
    }
    out.promptLines.push(`- ${p.name} (tools mcp__${id}__*): ${p.promptHint}`)
  }
  return out
}

/** Tools on an enabled intel server are read-only data sources — allow by server prefix. */
export function isIntelToolAllowed(name: string, servers: Record<string, unknown>): boolean {
  const m = /^mcp__([a-z0-9_]+)__/.exec(name)
  return Boolean(m && m[1] in servers)
}
