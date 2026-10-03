import { spawn } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import type { AuthLoginResult } from '@shared/ipc'
import {
  CLAUDE_CRED_PATH,
  checkClaudeAuth,
  credentialFingerprint,
  hasValidLocalCredential,
  isFresherCredential,
  type CredFingerprint
} from './auth'
import { saveStoredToken, clearStoredToken } from './tokenStore'

/**
 * In-app Claude subscription sign-in.
 *
 * We drive the real subscription login — `claude auth login --claudeai` — which
 * opens the browser and writes `~/.claude/.credentials.json` on success, and
 * detect completion by WATCHING that file for a fresh valid `claudeAiOauth` block.
 * (`claude setup-token` is the wrong primitive: an interactive TUI that only prints
 * a token and never writes the credential file.)
 */
const TOKEN_RE = /sk-ant-oat[0-9A-Za-z_-]+/
const CAPTURE_TIMEOUT_MS = 180_000
const POLL_MS = 1000

function resolveCli(): string {
  return process.env.TB_CLAUDE_CLI_PATH || process.env.CLAUDE_CODE_EXECPATH || 'claude'
}

const manualHint = 'As a fallback, run `claude setup-token` in a terminal and paste the token here.'

let signInSuccess: () => void = () => {}
export function setSignInSuccessHandler(fn: () => void): void {
  signInSuccess = fn
}

interface Capture {
  ok: boolean
  message: string
}

function captureLogin(): Promise<Capture> {
  return new Promise<Capture>((resolve) => {
    const before: CredFingerprint = credentialFingerprint()
    let settled = false
    let child: ReturnType<typeof spawn> | undefined
    let watcher: ReturnType<typeof watch> | undefined
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      try {
        if (child?.pid) {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          else child.kill()
        }
      } catch {
        /* ignore */
      }
      try {
        watcher?.close()
      } catch {
        /* ignore */
      }
      if (pollTimer) clearInterval(pollTimer)
      if (deadline) clearTimeout(deadline)
    }
    const finish = (r: Capture): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(r)
    }
    const checkFile = (): void => {
      try {
        if (!existsSync(CLAUDE_CRED_PATH)) return
        const after = credentialFingerprint()
        if (isFresherCredential(before, after) && hasValidLocalCredential()) {
          finish({ ok: true, message: 'Connected to your Claude subscription.' })
        }
      } catch {
        /* retry next tick */
      }
    }

    try {
      const cli = resolveCli()
      child =
        process.platform === 'win32'
          ? spawn(`"${cli}" auth login --claudeai`, { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
          : spawn(cli, ['auth', 'login', '--claudeai'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    } catch (err) {
      console.warn('[login] CLI launch failed:', (err as Error).message)
    }

    let out = ''
    const onData = (buf: Buffer): void => {
      out += buf.toString()
      const t = out.match(TOKEN_RE)
      if (t) {
        saveStoredToken(t[0])
        finish({ ok: true, message: 'Connected to your Claude subscription.' })
      }
    }
    child?.stdout?.on('data', onData)
    child?.stderr?.on('data', onData)
    child?.on('error', (e) => console.warn('[login] CLI error:', e.message))

    try {
      const dir = dirname(CLAUDE_CRED_PATH)
      if (existsSync(dir)) {
        watcher = watch(dir, (_e, fname) => {
          if (!fname || fname.toString().includes('.credentials.json')) checkFile()
        })
      }
    } catch {
      /* polling covers us */
    }
    pollTimer = setInterval(checkFile, POLL_MS)
    checkFile()
    deadline = setTimeout(() => finish({ ok: false, message: `Sign-in didn’t complete. ${manualHint}` }), CAPTURE_TIMEOUT_MS)
  })
}

export async function runClaudeLogin(): Promise<AuthLoginResult> {
  if (hasValidLocalCredential()) {
    signInSuccess()
    return { ok: true, status: checkClaudeAuth(), message: 'Already connected to your Claude subscription.' }
  }
  const cap = await captureLogin()
  if (cap.ok) signInSuccess()
  return { ok: cap.ok, status: checkClaudeAuth(), message: cap.message }
}

export function saveToken(token: string): AuthLoginResult {
  const t = token.trim()
  if (!t) return { ok: false, status: checkClaudeAuth(), message: 'Paste a valid token first.' }
  saveStoredToken(t)
  const status = checkClaudeAuth()
  if (status.authenticated) signInSuccess()
  return {
    ok: status.authenticated,
    status,
    message: status.authenticated ? 'Token saved — you’re connected.' : 'Token saved, but it wasn’t recognized.'
  }
}

export function logoutClaude(): AuthLoginResult {
  clearStoredToken()
  const status = checkClaudeAuth()
  return {
    ok: true,
    status,
    message: status.authenticated
      ? 'Cleared the in-app token, but you’re still signed in through Claude Code (~/.claude). Run `claude logout` in a terminal to fully disconnect.'
      : 'Signed out.'
  }
}
