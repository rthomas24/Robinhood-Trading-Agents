import { DEFAULT_TOOL_POLICY, robinhoodToolKind, robinhoodToolOn, type ToolPolicy } from '@shared/mcps'
import { ROBINHOOD_MCP_URL } from './oauth'

/**
 * What the MODEL may touch on the Robinhood MCP. The catalog (read + write,
 * with descriptions) lives in shared/mcps.ts so the settings page can offer a
 * per-tool switch; the operator's `ToolPolicy` decides:
 *  - READ tools: on unless switched off;
 *  - WRITE tools (place/cancel/review orders, watchlists, scans): off unless
 *    switched on — and even then only for LIVE, ARMED agents. A paper agent
 *    never reaches a mutating tool; its trades are simulated by the engine.
 * Direct `place_equity_order` calls are additionally guardrail-checked and
 * booked by the runner (see runOnce).
 */
export const ROBINHOOD_SERVER_NAME = 'robinhood'
const PREFIX = `mcp__${ROBINHOOD_SERVER_NAME}__`

export function robinhoodToolName(bare: string): string {
  return `${PREFIX}${bare}`
}
export function robinhoodBareName(full: string): string | null {
  return full.startsWith(PREFIX) ? full.slice(PREFIX.length) : null
}

export interface RobinhoodToolContext {
  policy: ToolPolicy
  /** The agent is in live mode and the operator armed it. */
  liveArmed: boolean
}

export const ROBINHOOD_DEFAULT_CONTEXT: RobinhoodToolContext = { policy: DEFAULT_TOOL_POLICY, liveArmed: false }

export function isRobinhoodToolAllowed(name: string, ctx: RobinhoodToolContext = ROBINHOOD_DEFAULT_CONTEXT): boolean {
  const bare = robinhoodBareName(name)
  if (!bare) return false
  if (!robinhoodToolOn(bare, ctx.policy)) return false
  return robinhoodToolKind(bare) === 'read' || ctx.liveArmed
}

/** Write tools the policy exposes to THIS agent (for the prompt). */
export function robinhoodWriteToolsFor(ctx: RobinhoodToolContext): string[] {
  if (!ctx.liveArmed) return []
  return ctx.policy.robinhoodWriteEnabled
}

/** SDK mcpServers entry: the remote HTTP MCP with the user's bearer token. */
export function buildRobinhoodServer(token: string): { type: 'http'; url: string; headers: Record<string, string> } {
  return { type: 'http', url: ROBINHOOD_MCP_URL, headers: { Authorization: `Bearer ${token}` } }
}
