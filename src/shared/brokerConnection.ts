/**
 * The operator's Robinhood connection, as the app describes it.
 *
 * One connection, held on this computer (OAuth tokens encrypted in the OS
 * keychain). Pure and Node-free so every surface that shows it — the
 * Connections sheet, Settings, the live-arm gate — says the same sentence.
 */

export interface RobinhoodConnectionSummary {
  connected: boolean
  warn: boolean
  detail: string
  action: 'connect' | 'reconnect' | 'disconnect'
  actionLabel: string
  accountHint?: string
}

export function robinhoodConnectionSummary(local: { connected: boolean; accountHint?: string } | null | undefined): RobinhoodConnectionSummary {
  const hint = local?.accountHint
  const acct = hint ? ` · agentic account ${hint}` : ''
  if (local?.connected) {
    // Signed in, but no account agents may trade in: say what to do about it.
    if (!hint) return { connected: true, warn: true, detail: 'Connected, but no agentic-enabled account was found. Enable Agentic Trading in the Robinhood app, then reconnect.', action: 'disconnect', actionLabel: 'Disconnect' }
    return { connected: true, warn: false, detail: `Connected${acct}. Tokens stay on this computer.`, action: 'disconnect', actionLabel: 'Disconnect', accountHint: hint }
  }
  // `accountHint` without `connected` is how the status reports a grant the broker rejected.
  if (hint) {
    return { connected: false, warn: true, detail: 'Robinhood rejected the connection — it was revoked or expired on their side. Sign in again to restore it.', action: 'reconnect', actionLabel: 'Reconnect', accountHint: hint }
  }
  return { connected: false, warn: false, detail: 'Not connected. Sign in with Robinhood to trade live; paper agents do not need it when a market-data key is set.', action: 'connect', actionLabel: 'Connect' }
}

/** Why arming live trading is refused, or null when the broker is ready. */
export function armBlockedReason(local: { connected?: boolean } | null | undefined): string | null {
  return local?.connected ? null : 'Connect Robinhood on this computer before arming live trading.'
}
