import { app } from 'electron'
import { readSecret, writeSecret } from '../lib/secureFile'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Stores a Claude OAuth "setup token" (`claude setup-token`) for users who sign
 * in via the paste fallback. Encrypted at rest via `safeStorage`. On startup it is
 * loaded into `CLAUDE_CODE_OAUTH_TOKEN` so the Agent SDK's bundled CLI uses it.
 */
function tokenPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'claude-token.bin')
}

export function getStoredToken(): string | undefined {
  return readSecret(tokenPath()) ?? undefined
}

export function saveStoredToken(token: string): void {
  const trimmed = token.trim()
  writeSecret(tokenPath(), trimmed)
  process.env.CLAUDE_CODE_OAUTH_TOKEN = trimmed
}

export function clearStoredToken(): void {
  writeSecret(tokenPath(), null)
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
}

export function loadStoredTokenIntoEnv(): void {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return
  const token = getStoredToken()
  if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token
}
