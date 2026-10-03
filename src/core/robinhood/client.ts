import type { CredentialSource } from '../runner/types'
import { RobinhoodMcpClient } from './mcp'

/**
 * A Robinhood MCP client whose bearer token always comes from the host's
 * credential source (refreshed by the host; re-read on 401). Null when the
 * operator has no Robinhood token. Used by the runner.
 */
export async function createRobinhoodClient(creds: CredentialSource): Promise<{ rh: RobinhoodMcpClient; accessToken: string } | null> {
  const tok = await creds.robinhoodToken().catch(() => null)
  if (!tok?.accessToken) return null
  const rh = new RobinhoodMcpClient({
    token: async () => (await creds.robinhoodToken())?.accessToken ?? tok.accessToken,
    // Forced: the broker rejected a token whose own clock says it is fine, so
    // the host must not short-circuit on "not expiring yet". Null back from a forced
    // call means the grant is bad, and the client escalates via onAuthFailure.
    onUnauthorized: async () => (await creds.robinhoodToken({ forceRefresh: true }))?.accessToken ?? null,
    onAuthFailure: async (detail) => {
      await creds.brokerAuthFailed?.(detail)
    }
  })
  return { rh, accessToken: tok.accessToken }
}
