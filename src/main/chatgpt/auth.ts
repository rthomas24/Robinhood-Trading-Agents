import { openExternalSafely } from '../lib/openExternal'
import type { ChatGptAuthStatus, ChatGptDeviceStart, ChatGptLoginResult } from '@shared/ipc'
import { clearTokens, encryptionAvailable, getTokens, loginWithBrowser, startDeviceLogin } from './oauth'

/**
 * ChatGPT-subscription auth status + sign-in/out — the same shape as the Claude
 * pair (`claude/auth.ts` + `claude/login.ts`) so the renderer treats the two
 * subscription vendors uniformly. Tokens never leave this process.
 */
function planLabel(plan?: string): string {
  const p = (plan ?? '').toLowerCase()
  if (p.includes('pro')) return 'ChatGPT Pro'
  if (p.includes('plus')) return 'ChatGPT Plus'
  if (p.includes('team')) return 'ChatGPT Team'
  if (p.includes('enterprise') || p.includes('business')) return 'ChatGPT Business'
  if (p.includes('free')) return 'ChatGPT (Free)'
  return plan ? `ChatGPT (${plan})` : 'your ChatGPT subscription'
}

export function chatgptStatus(): ChatGptAuthStatus {
  const apiKeyOverrideDetected = Boolean(process.env.OPENAI_API_KEY)
  const t = getTokens()
  const secureStorage = encryptionAvailable()
  if (!t) {
    return { authenticated: false, apiKeyOverrideDetected, detail: 'Not connected. Sign in with your ChatGPT subscription to run agents on GPT models.', secureStorage }
  }
  const plan = planLabel(t.planType)
  return {
    authenticated: true,
    apiKeyOverrideDetected,
    subscriptionType: plan,
    email: t.email,
    expiresAt: t.expiresAt,
    detail: `Connected to ${plan}${t.email ? ` (${t.email})` : ''}.`,
    secureStorage
  }
}

/** Browser PKCE sign-in; resolves when the OAuth round-trip completes. */
export async function chatgptLogin(): Promise<ChatGptLoginResult> {
  try {
    await loginWithBrowser()
    return { ok: true, status: chatgptStatus(), message: 'Connected to your ChatGPT subscription.' }
  } catch (err) {
    return { ok: false, status: chatgptStatus(), message: `ChatGPT sign-in didn't complete: ${(err as Error).message}` }
  }
}

/**
 * Device-code sign-in (the fallback when port 1455 is taken). Returns the code
 * to show at once; completion lands as a token-store change → auth event.
 */
export async function chatgptLoginDevice(): Promise<ChatGptDeviceStart> {
  try {
    const d = await startDeviceLogin()
    void openExternalSafely(d.verificationUrl)
    // Completion (or failure) is reported through the token store's change listeners.
    void d.completed.catch(() => undefined)
    return { ok: true, userCode: d.userCode, verificationUrl: d.verificationUrl, message: `Enter code ${d.userCode} at ${d.verificationUrl}` }
  } catch (err) {
    return { ok: false, message: `Couldn't start device sign-in: ${(err as Error).message}` }
  }
}

export function chatgptLogout(): ChatGptLoginResult {
  clearTokens()
  return { ok: true, status: chatgptStatus(), message: 'Disconnected from ChatGPT. Your Codex CLI login (if any) is untouched.' }
}
