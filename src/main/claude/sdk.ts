import type { AgentSdk } from '@core/runner/types'

/**
 * Single cached loader for the ESM-only Claude Agent SDK.
 *
 * The SDK is marked external in electron.vite.config.ts and loaded via dynamic
 * import. Every part of the app must share ONE module instance — in-process MCP
 * servers built by `tool()`/`createSdkMcpServer()` must come from the same
 * instance `query()` is called on, or they won't connect.
 */
let sdkPromise: Promise<AgentSdk> | null = null

export function loadSdk(): Promise<AgentSdk> {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk') as unknown as Promise<AgentSdk>
  return sdkPromise
}
