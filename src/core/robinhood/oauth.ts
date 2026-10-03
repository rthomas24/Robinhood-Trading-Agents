import { createHash, randomBytes } from 'node:crypto'
import type { RobinhoodToken } from '../runner/types'

/**
 * Robinhood Agentic Trading OAuth 2.1 — pure helpers (no Electron). Verified
 * against the live server (discovery chain):
 *   resource metadata : /.well-known/oauth-protected-resource/mcp/trading
 *   auth-server meta  : /.well-known/oauth-authorization-server
 *     → authorize  https://robinhood.com/oauth            (PKCE S256)
 *     → token      https://api.robinhood.com/oauth2/token/ (public client, no secret)
 *     → register   https://agent.robinhood.com/oauth/trading/register (dynamic registration)
 * Scope is literally `internal`. Redirect is a LOOPBACK http://127.0.0.1:<port>/callback
 * (the host binds the port first, then registers a client bound to that URI).
 */
export const ROBINHOOD_MCP_URL = 'https://agent.robinhood.com/mcp/trading'
const DISCOVERY_URL = 'https://agent.robinhood.com/.well-known/oauth-authorization-server'

const FALLBACK = {
  authorization_endpoint: 'https://robinhood.com/oauth',
  token_endpoint: 'https://api.robinhood.com/oauth2/token/',
  registration_endpoint: 'https://agent.robinhood.com/oauth/trading/register',
  scopes_supported: ['internal']
}

export interface OAuthEndpoints {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
  scope: string
}

export async function discoverEndpoints(): Promise<OAuthEndpoints> {
  let meta: Partial<typeof FALLBACK> = {}
  try {
    const res = await fetch(DISCOVERY_URL, { headers: { Accept: 'application/json' } })
    if (res.ok) meta = (await res.json()) as Partial<typeof FALLBACK>
  } catch {
    /* use fallbacks */
  }
  return {
    authorization_endpoint: meta.authorization_endpoint ?? FALLBACK.authorization_endpoint,
    token_endpoint: meta.token_endpoint ?? FALLBACK.token_endpoint,
    registration_endpoint: meta.registration_endpoint ?? FALLBACK.registration_endpoint,
    scope: (meta.scopes_supported ?? FALLBACK.scopes_supported).join(' ')
  }
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface Pkce {
  state: string
  verifier: string
  challenge: string
}

export function makePkce(): Pkce {
  const state = base64url(randomBytes(16))
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { state, verifier, challenge }
}

/** Dynamic client registration (public client). Returns the client_id. */
export async function registerClient(ep: OAuthEndpoints, redirectUri: string, clientName = 'Trading Agents'): Promise<string> {
  const res = await fetch(ep.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: ep.scope
    })
  })
  if (!res.ok) throw new Error(`Client registration failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`)
  const json = (await res.json()) as { client_id?: string }
  if (!json.client_id) throw new Error('Client registration returned no client_id')
  return json.client_id
}

export function buildAuthorizeUrl(ep: OAuthEndpoints, clientId: string, redirectUri: string, pkce: Pkce): string {
  const url = new URL(ep.authorization_endpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    scope: ep.scope,
    resource: ROBINHOOD_MCP_URL
  }).toString()
  return url.toString()
}

interface TokenJson {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
}

async function tokenRequest(tokenEndpoint: string, params: Record<string, string>): Promise<TokenJson> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString()
  })
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`)
  const json = (await res.json()) as TokenJson
  if (!json.access_token) throw new Error('Token response had no access_token')
  return json
}

function toToken(json: TokenJson, prevRefresh?: string): RobinhoodToken {
  return {
    accessToken: json.access_token!,
    // Some servers don't rotate the refresh token — keep the old one if absent.
    refreshToken: json.refresh_token ?? prevRefresh,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    tokenType: json.token_type,
    scope: json.scope
  }
}

export async function exchangeCode(ep: OAuthEndpoints, args: { code: string; redirectUri: string; clientId: string; verifier: string }): Promise<RobinhoodToken> {
  const json = await tokenRequest(ep.token_endpoint, {
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.verifier,
    resource: ROBINHOOD_MCP_URL
  })
  return toToken(json)
}

export async function refreshToken(tokenEndpoint: string, refresh: string, clientId: string): Promise<RobinhoodToken> {
  const json = await tokenRequest(tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: clientId,
    resource: ROBINHOOD_MCP_URL
  })
  return toToken(json, refresh)
}

/** True when the token should be refreshed before use (60s skew). */
/**
 * Is a failed token refresh the END of this grant, or just a bad minute?
 *
 * One rule for every refresher — the lazy refresh before a call and the
 * 401-driven forced refresh — because copies disagree, and an eager one that
 * marks the grant dead on a socket hiccup silently stops renewing it for good.
 *
 * Only a 4xx from the token endpoint means the grant is gone (revoked in the
 * app, refresh token expired). A 5xx or a socket error is the network having a
 * bad minute. 408/425/429 are 4xx that are explicitly NOT fatal — 429 above
 * all: a clustered renewal pass can draw `Too Many Requests`, and reading that
 * as "revoked" pauses live agents over our own rate limit.
 *
 * The pattern is ANCHORED to the message `tokenRequest` produces (which is why
 * this lives beside it). Scanning loosely would match a `(404)` appearing
 * anywhere in 300 characters of untrusted response body from an error page.
 */
const RETRYABLE_4XX = new Set([408, 425, 429])
export function refreshFailureIsFatal(message: string): boolean {
  const code = Number(/^Token exchange failed \((\d{3})\)/.exec(message)?.[1] ?? 0)
  return code >= 400 && code < 500 && !RETRYABLE_4XX.has(code)
}

export function needsRefresh(t: { expiresAt?: number | null }, now = Date.now()): boolean {
  return t.expiresAt != null && now >= t.expiresAt - 60_000
}
