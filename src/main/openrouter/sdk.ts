import type { OpenRouterAgentModule, OpenRouterMcpModule } from '@core/runner/vendors/openrouter'

/**
 * Single cached loader for the ESM-only OpenRouter Agent SDK (+ its MCP
 * bridge). Kept external in electron.vite.config.ts and loaded via dynamic
 * import, like the Claude SDK.
 */
let p: Promise<{ agent: OpenRouterAgentModule; mcp: OpenRouterMcpModule }> | null = null

export function loadOpenRouter(): Promise<{ agent: OpenRouterAgentModule; mcp: OpenRouterMcpModule }> {
  if (!p) {
    p = Promise.all([import('@openrouter/agent'), import('@openrouter/agent/mcp')]).then(([agent, mcp]) => ({ agent: agent as unknown as OpenRouterAgentModule, mcp: mcp as unknown as OpenRouterMcpModule }))
  }
  return p
}
