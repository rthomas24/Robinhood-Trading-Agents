import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeAuthStatus } from '@shared/ipc'
import { getStoredToken } from './tokenStore'

/**
 * Accurate, no-network Claude auth detection.
 *
 * Reads the real Claude credential file (`~/.claude/.credentials.json`) written by
 * `claude auth login` / Claude Code and validates the OAuth block. The SDK refreshes
 * the access token itself using the refresh token, so access OR refresh token
 * present = authenticated. Also honors `CLAUDE_CODE_OAUTH_TOKEN` (env or the in-app
 * stored setup token). `ANTHROPIC_API_KEY` is surfaced loudly as a billing override.
 */
interface OAuthBlock {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  subscriptionType?: string
}

export const CLAUDE_CRED_PATH = join(homedir(), '.claude', '.credentials.json')

function readOAuth(): OAuthBlock | null {
  try {
    if (!existsSync(CLAUDE_CRED_PATH)) return null
    const raw = JSON.parse(readFileSync(CLAUDE_CRED_PATH, 'utf8')) as { claudeAiOauth?: OAuthBlock }
    const o = raw.claudeAiOauth
    if (!o || (!o.accessToken && !o.refreshToken)) return null
    return o
  } catch {
    return null
  }
}

export interface CredFingerprint {
  present: boolean
  expiresAt: number
  accessTokenTail: string
}

export function credentialFingerprint(): CredFingerprint {
  const o = readOAuth()
  return { present: Boolean(o), expiresAt: o?.expiresAt ?? 0, accessTokenTail: (o?.accessToken ?? '').slice(-6) }
}

export function hasValidLocalCredential(): boolean {
  if (readOAuth()) return true
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) || Boolean(getStoredToken())
}

export function isFresherCredential(before: CredFingerprint, after: CredFingerprint): boolean {
  if (!after.present) return false
  if (!before.present) return true
  if (after.expiresAt > before.expiresAt) return true
  return after.accessTokenTail !== before.accessTokenTail
}

function subscriptionLabel(type?: string): string {
  if (!type) return 'your Claude subscription'
  const t = type.toLowerCase()
  if (t === 'max') return 'Claude Max'
  if (t === 'pro') return 'Claude Pro'
  return `Claude (${type})`
}

export function checkClaudeAuth(): ClaudeAuthStatus {
  const apiKeyOverrideDetected = Boolean(process.env.ANTHROPIC_API_KEY)
  const oauth = readOAuth()
  const tokenPresent = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) || Boolean(getStoredToken())
  const hasCredentials = Boolean(oauth) || tokenPresent
  const subscriptionType = oauth?.subscriptionType
  if (apiKeyOverrideDetected) {
    return {
      vendor: 'claude',
      authenticated: hasCredentials,
      apiKeyOverrideDetected: true,
      subscriptionType,
      detail:
        'ANTHROPIC_API_KEY is set — it overrides your subscription and bills per token. Unset it to stay on flat subscription pricing.'
    }
  }
  if (hasCredentials) {
    return {
      vendor: 'claude',
      authenticated: true,
      apiKeyOverrideDetected: false,
      subscriptionType,
      detail: oauth ? `Connected to ${subscriptionLabel(subscriptionType)}.` : 'Connected with a Claude setup token.'
    }
  }
  return {
    vendor: 'claude',
    authenticated: false,
    apiKeyOverrideDetected: false,
    detail: 'Not connected. Sign in with your Claude subscription to run agents.'
  }
}
