import http from 'node:http'
import crypto from 'node:crypto'
import { credentialsPath, encryptionAvailable, readSecretJson, writeSecretJson } from '../lib/secureFile'
import { sendLoopbackPage } from '../lib/loopbackPage'
import { openExternalSafely } from '../lib/openExternal'

/**
 * ChatGPT-subscription sign-in (the Codex OAuth flow), verified against
 * OpenAI's `codex` Rust source and the community libraries (7shi/codex-oauth,
 * EvanZhouDev/openai-oauth, numman-ali/opencode-openai-codex-auth).
 *
 * ⚠️ UNOFFICIAL / FRAGILE: this reuses the Codex CLI's *public* OAuth client id
 * and an undocumented internal backend (`chatgpt.com/backend-api/codex`). The
 * endpoints, headers, scopes and model slugs are reverse-engineered and can
 * change without notice. Everything that depends on them lives in this file and
 * `core/runner/vendors/chatgpt.ts`, so a break is local and loud.
 *
 * Three flows, one encrypted token bundle (safeStorage at rest, like Claude's
 * setup token and the Robinhood grant); the renderer only ever sees a derived
 * status: PKCE browser login on the FIXED loopback port 1455 (baked into
 * OpenAI's redirect allow-list), device-code login when that port is busy, and
 * refresh (tokens rotate — the new refresh token is always kept).
 */
export const CHATGPT_OAUTH = {
  /** Codex CLI's public PKCE client id (reused; no third-party registration exists). */
  CLIENT_ID: 'app_EMoamEEZ73f0CkXaXp7hrann',
  AUTHORIZE_URL: 'https://auth.openai.com/oauth/authorize',
  TOKEN_URL: 'https://auth.openai.com/oauth/token',
  /** Port 1455 is baked into OpenAI's redirect allow-list — not configurable. */
  REDIRECT_URI: 'http://localhost:1455/auth/callback',
  REDIRECT_PORT: 1455,
  SCOPE: 'openid profile email offline_access',
  /** Sent as an authorize param AND as a header on model calls — a wrong originator is a known 403. */
  ORIGINATOR: 'codex_cli_rs',
  AUTHORIZE_EXTRA: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true' } as Record<string, string>,
  DEVICE_USERCODE_URL: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  DEVICE_TOKEN_URL: 'https://auth.openai.com/api/accounts/deviceauth/token',
  DEVICE_VERIFY_URL: 'https://auth.openai.com/codex/device',
  DEVICE_REDIRECT_URI: 'https://auth.openai.com/deviceauth/callback',
  /** The Codex model endpoint (stateless Responses API behind an allow-listing gateway). */
  RESPONSES_URL: 'https://chatgpt.com/backend-api/codex/responses',
  /** JWT claim namespaces holding `chatgpt_account_id` / `chatgpt_plan_type` and the profile email. */
  JWT_AUTH_CLAIM: 'https://api.openai.com/auth',
  JWT_PROFILE_CLAIM: 'https://api.openai.com/profile',
  HEADER_BETA: 'responses=experimental',
  USER_AGENT: 'codex_cli_rs/0.0.1'
} as const

/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 60_000

export interface ChatGptTokens {
  accessToken: string
  refreshToken: string
  idToken?: string
  /** ChatGPT account id — a header on every model call. */
  accountId?: string
  /** Epoch ms. */
  expiresAt?: number
  /** "plus" | "pro" | "team" | "free" … informational. */
  planType?: string
  email?: string
  lastRefresh?: number
}

// ── JWT claims (read-only; we never verify — these came over TLS from OpenAI) ──
function jwtPayload(jwt?: string): Record<string, unknown> | null {
  if (!jwt) return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
const authClaim = (p: Record<string, unknown> | null): Record<string, unknown> | undefined => {
  const ns = p?.[CHATGPT_OAUTH.JWT_AUTH_CLAIM]
  return ns && typeof ns === 'object' ? (ns as Record<string, unknown>) : undefined
}
/** Account id: namespaced claim → top-level → first organization (location varies by token). */
function accountIdOf(idToken?: string, accessToken?: string): string | undefined {
  for (const tok of [idToken, accessToken]) {
    const p = jwtPayload(tok)
    if (!p) continue
    const ns = authClaim(p)?.chatgpt_account_id
    if (typeof ns === 'string' && ns) return ns
    if (typeof p.chatgpt_account_id === 'string' && p.chatgpt_account_id) return p.chatgpt_account_id
    const orgs = p.organizations
    if (Array.isArray(orgs) && orgs[0] && typeof orgs[0] === 'object') {
      const id = (orgs[0] as Record<string, unknown>).id
      if (typeof id === 'string' && id) return id
    }
  }
  return undefined
}
function planTypeOf(idToken?: string, accessToken?: string): string | undefined {
  for (const tok of [idToken, accessToken]) {
    const plan = authClaim(jwtPayload(tok))?.chatgpt_plan_type
    if (typeof plan === 'string' && plan) return plan
  }
  return undefined
}
function emailOf(idToken?: string): string | undefined {
  const p = jwtPayload(idToken)
  if (typeof p?.email === 'string' && p.email) return p.email
  const prof = p?.[CHATGPT_OAUTH.JWT_PROFILE_CLAIM]
  const e = prof && typeof prof === 'object' ? (prof as Record<string, unknown>).email : undefined
  return typeof e === 'string' && e ? e : undefined
}
function expiryOf(accessToken?: string): number | undefined {
  const exp = jwtPayload(accessToken)?.exp
  return typeof exp === 'number' ? exp * 1000 : undefined
}

// ── Encrypted token store ─────────────────────────────────────────────────────
const file = (): string => credentialsPath('chatgpt.bin')
let cache: ChatGptTokens | null | undefined
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

export function getTokens(): ChatGptTokens | null {
  if (cache !== undefined) return cache
  const t = readSecretJson<ChatGptTokens>(file())
  cache = t && (t.accessToken || t.refreshToken) ? t : null
  return cache
}
function saveTokens(t: ChatGptTokens): void {
  cache = t
  writeSecretJson(file(), t)
  notify()
}
export function clearTokens(): void {
  cache = null
  writeSecretJson(file(), null)
  notify()
}
export function onTokensChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export { encryptionAvailable }

// ── Token endpoint ────────────────────────────────────────────────────────────
interface RawTokens {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}
async function postForm(url: string, body: Record<string, string>): Promise<RawTokens> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  return (await res.json()) as RawTokens
}
/** Raw response → stored bundle; refresh tokens rotate, so keep the new one and fall back to the prior. */
function toTokens(raw: RawTokens, prev?: ChatGptTokens): ChatGptTokens {
  const accessToken = raw.access_token ?? prev?.accessToken ?? ''
  const idToken = raw.id_token ?? prev?.idToken
  return {
    accessToken,
    refreshToken: raw.refresh_token ?? prev?.refreshToken ?? '',
    idToken,
    accountId: accountIdOf(idToken, accessToken) ?? prev?.accountId,
    expiresAt: expiryOf(accessToken) ?? (raw.expires_in ? Date.now() + raw.expires_in * 1000 : prev?.expiresAt),
    planType: planTypeOf(idToken, accessToken) ?? prev?.planType,
    email: emailOf(idToken) ?? prev?.email,
    lastRefresh: Date.now()
  }
}

// ── PKCE browser flow ─────────────────────────────────────────────────────────
const b64url = (b: Buffer): string => b.toString('base64url')

function authorizeUrl(challenge: string, state: string): string {
  const u = new URL(CHATGPT_OAUTH.AUTHORIZE_URL)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', CHATGPT_OAUTH.CLIENT_ID)
  u.searchParams.set('redirect_uri', CHATGPT_OAUTH.REDIRECT_URI)
  u.searchParams.set('scope', CHATGPT_OAUTH.SCOPE)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  for (const [k, v] of Object.entries(CHATGPT_OAUTH.AUTHORIZE_EXTRA)) u.searchParams.set(k, v)
  u.searchParams.set('state', state)
  u.searchParams.set('originator', CHATGPT_OAUTH.ORIGINATOR)
  return u.toString()
}

let inFlight: Promise<ChatGptTokens> | null = null

/** Open the browser, catch the redirect on 127.0.0.1:1455, exchange the code. Rejects on cancel / timeout / port busy. */
export function loginWithBrowser(timeoutMs = 300_000): Promise<ChatGptTokens> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const verifier = b64url(crypto.randomBytes(72))
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
    const state = crypto.randomBytes(16).toString('hex')
    const code = await new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url ?? '/', `http://localhost:${CHATGPT_OAUTH.REDIRECT_PORT}`)
        if (u.pathname !== '/auth/callback') {
          res.statusCode = 404
          res.end()
          return
        }
        const err = u.searchParams.get('error')
        const c = u.searchParams.get('code')
        if (err || !c) {
          sendLoopbackPage(res, 400, 'Sign-in failed', err ?? 'No code returned — try again from Robinhood Trading Agents.')
          done(() => reject(new Error(err ?? 'no authorization code returned')))
          return
        }
        if (u.searchParams.get('state') !== state) {
          sendLoopbackPage(res, 400, 'Sign-in rejected', 'State mismatch — start again from Robinhood Trading Agents.')
          done(() => reject(new Error('state mismatch (possible CSRF)')))
          return
        }
        sendLoopbackPage(res, 200, 'Connected to ChatGPT ✓', 'You can close this tab and return to Robinhood Trading Agents.')
        done(() => resolve(c))
      })
      const timer = setTimeout(() => done(() => reject(new Error('Sign-in timed out. Please try again.'))), timeoutMs)
      const done = (settle: () => void): void => {
        clearTimeout(timer)
        setTimeout(() => server.close(), 500)
        settle()
      }
      server.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(e.code === 'EADDRINUSE' ? new Error('Port 1455 is in use (another app is signing in to ChatGPT, or the Codex CLI is running). Close it, or use "Sign in with a code".') : e)
      })
      server.listen(CHATGPT_OAUTH.REDIRECT_PORT, '127.0.0.1', () => void openExternalSafely(authorizeUrl(challenge, state)))
    })
    const raw = await postForm(CHATGPT_OAUTH.TOKEN_URL, { grant_type: 'authorization_code', client_id: CHATGPT_OAUTH.CLIENT_ID, code, code_verifier: verifier, redirect_uri: CHATGPT_OAUTH.REDIRECT_URI })
    const tokens = toTokens(raw)
    saveTokens(tokens)
    return tokens
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

// ── Device-code flow (port-1455-busy / headless fallback) ─────────────────────
export interface DeviceLogin {
  userCode: string
  verificationUrl: string
  /** Resolves with the stored bundle once the user finishes in the browser (15 min timeout). */
  completed: Promise<ChatGptTokens>
}
async function postJson<T>(url: string, body: unknown): Promise<{ status: number; json: T | null }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  return { status: res.status, json: (await res.json().catch(() => null)) as T | null }
}
export async function startDeviceLogin(): Promise<DeviceLogin> {
  const { json: uc } = await postJson<{ device_auth_id?: string; user_code?: string; usercode?: string; interval?: number | string }>(CHATGPT_OAUTH.DEVICE_USERCODE_URL, { client_id: CHATGPT_OAUTH.CLIENT_ID })
  const deviceAuthId = uc?.device_auth_id
  const userCode = uc?.user_code ?? uc?.usercode
  if (!deviceAuthId || !userCode) throw new Error('Device-code sign-in is not available (enable it at chatgpt.com → Settings → Security).')
  const intervalMs = Math.max(2_000, Number(uc?.interval ?? 5) * 1000)
  const completed = (async (): Promise<ChatGptTokens> => {
    const deadline = Date.now() + 15 * 60_000
    for (;;) {
      if (Date.now() > deadline) throw new Error('Device-code sign-in timed out.')
      await new Promise((r) => setTimeout(r, intervalMs))
      const { status, json } = await postJson<{ authorization_code?: string; code_verifier?: string }>(CHATGPT_OAUTH.DEVICE_TOKEN_URL, { device_auth_id: deviceAuthId, user_code: userCode })
      if (status === 403 || status === 404) continue // still pending
      if (status !== 200 || !json?.authorization_code || !json.code_verifier) throw new Error(`Device-code poll failed (${status}).`)
      const raw = await postForm(CHATGPT_OAUTH.TOKEN_URL, { grant_type: 'authorization_code', client_id: CHATGPT_OAUTH.CLIENT_ID, code: json.authorization_code, code_verifier: json.code_verifier, redirect_uri: CHATGPT_OAUTH.DEVICE_REDIRECT_URI })
      const tokens = toTokens(raw)
      saveTokens(tokens)
      return tokens
    }
  })()
  return { userCode, verificationUrl: CHATGPT_OAUTH.DEVICE_VERIFY_URL, completed }
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function refresh(prev: ChatGptTokens): Promise<ChatGptTokens> {
  if (!prev.refreshToken) throw new Error('no refresh token')
  const tokens = toTokens(await postForm(CHATGPT_OAUTH.TOKEN_URL, { grant_type: 'refresh_token', refresh_token: prev.refreshToken, client_id: CHATGPT_OAUTH.CLIENT_ID }), prev)
  saveTokens(tokens)
  return tokens
}
/**
 * A valid bundle for a model call, refreshing proactively inside the skew
 * window (or when `force`d after a 401). Null = not signed in. A failed refresh
 * returns what we have — the call may 401 and the runner retries once forced.
 */
export async function freshTokens(force = false): Promise<ChatGptTokens | null> {
  const t = getTokens()
  if (!t) return null
  const soon = typeof t.expiresAt === 'number' && t.expiresAt - Date.now() < REFRESH_SKEW_MS
  if ((!force && !soon) || !t.refreshToken) return t
  try {
    return await refresh(t)
  } catch {
    return t
  }
}
