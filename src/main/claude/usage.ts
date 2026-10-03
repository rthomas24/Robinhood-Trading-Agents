import { app } from 'electron'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeUsage } from '@shared/ipc'
import { loadSdk } from './sdk'
import { checkClaudeAuth } from './auth'

/**
 * Claude subscription usage meter + exhaustion hold.
 *
 * Polls the SDK's control-plane usage endpoint with a ZERO-TOKEN probe:
 * streaming-input mode with an input that never yields a message runs no model
 * turn at all — we only issue the usage control request, then release the gate
 * so the query closes. (Proven pattern; the method name is explicitly marked
 * experimental, so every access is defensive.)
 *
 * When the 5-hour window is exhausted the engine holds scheduled/watch runs
 * until utilization recovers, the reset time passes, or the operator overrides.
 */
const POLL_MS = 120_000
const EXHAUSTED_AT = 99 // utilization ≥ this % counts as "out"

interface RawWindow {
  utilization?: number | null
  resets_at?: string | null
}
interface RawUsage {
  rate_limits_available?: boolean
  rate_limits?: { five_hour?: RawWindow; seven_day?: RawWindow }
}

type Listener = (u: ClaudeUsage) => void

class UsageService {
  private usage: ClaudeUsage = { available: false, exhausted: false, holdActive: false, overridden: false, fetchedAt: 0 }
  private overridden = false
  private holdStartedAtMs = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private listeners = new Set<Listener>()

  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get(): ClaudeUsage {
    return this.usage
  }

  /** Milliseconds timestamp of when the current hold began (0 = no hold). */
  holdStartedAt(): number {
    return this.usage.holdActive ? this.holdStartedAtMs : 0
  }

  /** Operator override: run agents even though the window reads exhausted. */
  override(): ClaudeUsage {
    this.overridden = true
    this.recompute()
    return this.usage
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Called by the engine when a run fails with a rate/usage-limit error. */
  noteLimitError(): void {
    void this.refresh()
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l(this.usage)
      } catch {
        /* ignore */
      }
    }
  }

  private recompute(): void {
    const fh = this.usage.fiveHour
    const resetPassed = fh?.resetsAt ? Date.now() >= new Date(fh.resetsAt).getTime() : false
    const exhausted = Boolean(this.usage.available && fh && fh.utilization >= EXHAUSTED_AT && !resetPassed)
    if (!exhausted) this.overridden = false // clears naturally once usage recovers
    const holdActive = exhausted && !this.overridden
    if (holdActive && !this.usage.holdActive) this.holdStartedAtMs = Date.now()
    this.usage = { ...this.usage, exhausted, holdActive, overridden: this.overridden }
    this.emit()
  }

  async refresh(): Promise<void> {
    if (this.polling) return
    if (!checkClaudeAuth().authenticated) {
      if (this.usage.available) {
        this.usage = { available: false, exhausted: false, holdActive: false, overridden: false, fetchedAt: Date.now() }
        this.emit()
      }
      return
    }
    this.polling = true
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* emptyInput(): AsyncGenerator<SDKUserMessage> {
      await gate
    }
    try {
      const sdk = await loadSdk()
      const cliPath = process.env.TB_CLAUDE_CLI_PATH
      const q = sdk.query({
        prompt: emptyInput(),
        options: { cwd: app.getPath('userData'), ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}) }
      }) as unknown as {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<RawUsage>
        return?: (v?: unknown) => Promise<unknown>
      }
      try {
        const raw = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.()
        const fh = raw?.rate_limits?.five_hour
        const sd = raw?.rate_limits?.seven_day
        this.usage = {
          ...this.usage,
          available: Boolean(raw?.rate_limits_available && fh && fh.utilization != null),
          fiveHour: fh && fh.utilization != null ? { utilization: fh.utilization, resetsAt: fh.resets_at ?? null } : undefined,
          sevenDay: sd && sd.utilization != null ? { utilization: sd.utilization, resetsAt: sd.resets_at ?? null } : undefined,
          fetchedAt: Date.now()
        }
      } finally {
        release()
        await q.return?.(undefined).catch(() => undefined)
      }
      this.recompute()
    } catch {
      // Probe failure is not exhaustion — keep the last known reading.
    } finally {
      this.polling = false
    }
  }
}

export const usageService = new UsageService()
