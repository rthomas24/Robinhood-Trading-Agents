import { Notification } from 'electron'
import type { RobinhoodStatus } from '@shared/ipc'
import type { CredentialSource, RobinhoodToken } from '@core/runner/types'
import { RobinhoodMcpClient } from '@core/robinhood/mcp'
import { discoverEndpoints, needsRefresh, refreshFailureIsFatal, refreshToken } from '@core/robinhood/oauth'
import { credentialsPath, encryptionAvailable as encAvailable, readSecretJson, writeSecretJson } from '../lib/secureFile'

/**
 * Robinhood credentials, encrypted at rest with Electron `safeStorage` (DPAPI /
 * Keychain / libsecret). Secrets never cross to the renderer — only `status()`.
 */
export interface RobinhoodCreds extends RobinhoodToken {
  clientId: string
  accountNumber?: string
  /**
   * The broker rejected this grant at USE even after a forced refresh — dead in
   * a way its own expiry cannot see (revoked, client registration gone). Set by
   * `noteAuthFailure`, cleared the moment the connect flow saves a fresh grant
   * (which simply never carries the flag).
   */
  needsReauth?: boolean
}

const file = (): string => credentialsPath('robinhood.bin')

let cache: RobinhoodCreds | null | undefined
let refreshing: Promise<RobinhoodCreds | null> | null = null
const listeners = new Set<() => void>()
/**
 * The last FORCED (401-driven) refresh and how it went. The cooldown stops a
 * stream of 401s spending a rotation each (Robinhood rotates refresh tokens,
 * so every spend is irreversible), and the outcome gates escalation:
 * `noteAuthFailure` concludes "dead grant" only when the token endpoint
 * actually answered — a transient endpoint error during a 401 is the network
 * having a bad minute, not proof of death.
 */
let lastForced: { at: number; outcome: 'minted' | 'transient' | 'fatal' } | null = null
const FORCED_REFRESH_COOLDOWN_MS = 60_000

let sharedClient: RobinhoodMcpClient | null = null

export const rhCreds = {
  /** One shared MCP client (session reused across calls); reset on cred change. */
  client(): RobinhoodMcpClient | null {
    const c = this.get()
    if (!c?.accessToken || c.needsReauth) return null
    if (!sharedClient) {
      sharedClient = new RobinhoodMcpClient({
        token: async () => (await this.fresh())?.accessToken ?? '',
        // Null when the forced refresh produced nothing NEW: retrying the same
        // token cannot succeed, and null is what makes the client escalate.
        onUnauthorized: async () => {
          const before = this.get()?.accessToken
          const next = await this.fresh(true)
          return next?.accessToken && next.accessToken !== before ? next.accessToken : null
        },
        onAuthFailure: async (detail) => this.noteAuthFailure(detail)
      })
    }
    return sharedClient
  },
  get(): RobinhoodCreds | null {
    if (cache === undefined) cache = readSecretJson<RobinhoodCreds>(file())
    return cache
  },
  save(c: RobinhoodCreds): void {
    cache = c
    sharedClient?.reset()
    writeSecretJson(file(), c)
    for (const l of listeners) l()
  },
  clear(): void {
    cache = null
    sharedClient = null
    writeSecretJson(file(), null)
    for (const l of listeners) l()
  },
  onChange(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  status(): RobinhoodStatus {
    const c = this.get()
    if (!c?.accessToken) return { connected: false, detail: 'Not connected. Sign in with Robinhood to trade.', secureStorage: encAvailable() }
    if (c.needsReauth) {
      return {
        connected: false,
        accountHint: c.accountNumber ? `••••${c.accountNumber.slice(-4)}` : undefined,
        detail: 'Robinhood rejected this connection — it was revoked or expired on their side. Sign in with Robinhood again.',
        secureStorage: encAvailable()
      }
    }
    return {
      connected: true,
      accountHint: c.accountNumber ? `••••${c.accountNumber.slice(-4)}` : undefined,
      expiresAt: c.expiresAt,
      detail: c.accountNumber ? `Connected · agentic account ••••${c.accountNumber.slice(-4)}` : 'Connected, but no agentic-enabled account was found. Enable Agentic Trading in the Robinhood app and reconnect.',
      secureStorage: encAvailable()
    }
  },
  /** Return creds with a fresh access token (refreshing when within 60s of expiry; `force` is the 401 path). */
  async fresh(force = false): Promise<RobinhoodCreds | null> {
    const c = this.get()
    if (!c) return null
    if (!force && !needsRefresh(c)) return c
    if (!c.refreshToken || !c.clientId) return c
    // One forced rotation per cooldown: returning the unchanged creds tells the
    // caller "nothing better exists", which is what makes it escalate instead
    // of spending another irreversible refresh-token rotation per 401.
    if (force && lastForced && Date.now() - lastForced.at < FORCED_REFRESH_COOLDOWN_MS) return c
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const ep = await discoverEndpoints()
          const t = await refreshToken(ep.token_endpoint, c.refreshToken!, c.clientId)
          const next: RobinhoodCreds = { ...c, ...t }
          if (force) lastForced = { at: Date.now(), outcome: 'minted' }
          this.save(next)
          return next
        } catch (err) {
          const msg = (err as Error).message
          if (force) lastForced = { at: Date.now(), outcome: refreshFailureIsFatal(msg) ? 'fatal' : 'transient' }
          console.warn('[robinhood] token refresh failed:', msg)
          return c
        } finally {
          refreshing = null
        }
      })()
    }
    return refreshing
  },

  /**
   * The broker refused a token that survived a forced refresh — the grant is
   * dead in a way `expiresAt` cannot see. Flag it (so status(), the picker's
   * readiness dot and the runner all stop claiming a connection exists), tell
   * the operator with a system notification, and leave the rest to the normal
   * reconnect flow. Skipped when the forced refresh never actually ran
   * (transient token-endpoint error): a bad minute is not a dead grant.
   */
  noteAuthFailure(detail: string): void {
    if (lastForced?.outcome === 'transient') {
      console.warn('[robinhood] 401 persists but the forced refresh could not run — leaving the grant intact:', detail)
      return
    }
    const c = this.get()
    if (!c || c.needsReauth) return
    console.warn('[robinhood] broker rejected the connection after a forced refresh — marking for reauth:', detail)
    this.save({ ...c, needsReauth: true })
    // Dropped, not just reset: the dead client carries its once-per-client
    // escalation flag, and the next connect must start with a clean one.
    sharedClient = null
    if (Notification.isSupported()) {
      new Notification({
        title: 'Robinhood needs to be reconnected',
        body: 'Robinhood rejected this computer’s connection. Agents can’t get quotes or trade until you sign in with Robinhood again (Settings → Connections).'
      }).show()
    }
  }
}

/** The `CredentialSource` the core runner needs. */
export const localCredentialSource: CredentialSource = {
  async robinhoodToken(opts) {
    const force = opts?.forceRefresh === true
    const before = force ? rhCreds.get()?.accessToken : undefined
    const c = await rhCreds.fresh(force)
    // A grant flagged needsReauth is NOT a connection: handing it out replays
    // the same 401 into every run, while "not connected" is a truth the
    // guardrails can explain to the agent.
    if (!c?.accessToken || c.needsReauth) return null
    // Forced and unchanged means "cannot do better" — null makes the MCP
    // client escalate instead of retrying the token the broker just rejected.
    if (force && c.accessToken === before) return null
    return c
  },
  async brokerAuthFailed(detail) {
    rhCreds.noteAuthFailure(detail)
  }
}
