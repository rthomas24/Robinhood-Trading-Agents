import { app, net } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { WATCH_FIRED_PREFIX, activeTasks, agentCapacity, applyPlanToConfig, countActiveAgents, emptyLedger, isAutonomous, isOpenQuestion, newId, previewOf, type AgentConfig, type AgentSummary, type Message, type NewMessage, type RunTrigger } from '@shared/agents'
import { armBlockedReason } from '@shared/brokerConnection'
import { armedState, catchUpDecision, missedRunMessage, skippedRunsMessage } from '@shared/schedule'
import type { AgentEvent, RunDelta } from '@shared/ipc'
import { runOnce } from '@core/runner/runOnce'
import { cannotFlattenNote, enforceExits, executeRetirement, fireWatches } from '@core/broker/execute'
import { getQuotes } from '@core/robinhood/api'
import { pickFeed } from '@core/market/feed'
import { desktopMarketFeed } from '../market/feed'
import { formatEt, isExtendedSession, isRegularSession } from '@shared/marketTime'
import { retirementWakeAt } from '@shared/retirement'
import type { RuntimeDeps } from '@core/runner/types'
import { loadSdk } from '../claude/sdk'
import { createClaudeRunner } from '@core/runner/vendors/claude'
import { createOpenRouterRunner } from '@core/runner/vendors/openrouter'
import { createLocalRunner } from '@core/runner/vendors/local'
import { createChatGptRunner } from '@core/runner/vendors/chatgpt'
import { CHATGPT_OAUTH, freshTokens } from '../chatgpt/oauth'
import { loadOpenRouter } from '../openrouter/sdk'
import { localEngine } from '../local/engine'
import { openrouterKey } from '../store/openrouterKey'
import { agentStore, localStorageAdapter } from '../store/agentStore'
import { localCredentialSource, rhCreds } from '../robinhood/credStore'
import { usageService } from '../claude/usage'
import { settingsStore } from '../store/settingsStore'
import { mcpKeys } from '../store/mcpKeys'
import { LIFECYCLE } from '@shared/lifecycle'
import { queuedBehindNow } from '@shared/messageQueue'
import { configFromCreateRequest } from '@shared/createAgent'
import { PROVIDER_LABEL, needsNetwork, providerOf, providerTarget, type Provider } from '@shared/provider'
import { DESKTOP_EXIT_WATCH_MS, RETIRED_NO_MESSAGE } from '@shared/agents'

/** `setTimeout` overflows past this and fires IMMEDIATELY — a 25-day delay silently became a 0 ms one. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1
/** A timer that fires this far ahead of its instant did not arrive — it was clamped, and is re-armed. */
const TIMER_EARLY_MS = 2_000

/**
 * A timer for an instant that may be further off than `setTimeout` can count.
 *
 * Node clamps a delay above 2^31-1 ms (~24.8 days) to 1 ms and warns, so
 * `Math.min(MAX_TIMEOUT_MS, …)` was the right clamp — but nothing then checked
 * whether the clamped timer's instant had ARRIVED when it fired. Before
 * `sleep_until` no wake-up was that far out; a 60-day sleep would have woken the
 * agent at once, cleared nothing (the sleep was still in force), no-oped, and
 * re-armed for the same instant. `fire` runs only when the instant is within
 * `TIMER_EARLY_MS`; otherwise `again` re-arms — the same rule for the schedule,
 * the question deadline and the retirement deadline.
 */
function timerFor(atMs: number, fire: () => void, again: () => void): ReturnType<typeof setTimeout> {
  const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, atMs - Date.now()))
  return setTimeout(() => (atMs - Date.now() > TIMER_EARLY_MS ? again() : fire()), delay)
}

/**
 * The engine: one `AgentRunner` per agent. A self-rearming setTimeout fires
 * scheduled runs at `nextRunAt`; manual/reply runs queue behind an in-flight
 * run. Pause cancels the timer and aborts the run. Events are pushed to the UI.
 */
type Listener = (e: AgentEvent) => void

interface QueuedRun {
  trigger: RunTrigger
  userText?: string
}

class AgentRunner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private queue: QueuedRun[] = []
  /** Trigger of the run in flight, so a repeat of it can be refused rather than queued. */
  private current: QueuedRun['trigger'] | null = null
  private abort: AbortController | null = null
  private replyDebounce: ReturnType<typeof setTimeout> | null = null
  private pendingReply: string[] = []
  /** Hold we already announced in the thread (one note per hold, not per tick). */
  private holdNotifiedAt = 0
  /** "No OpenRouter key" note already posted (once per stretch without a key). */
  private keyMissingNotified = false
  /** Offline note already posted (once per offline stretch); a skipped wake-up is replayed when we're back. */
  private offlineNotified = false
  private missedOffline = false
  /** Wakes the agent with trigger 'timeout' when its earliest open question's deadline passes. */
  private questionTimer: ReturnType<typeof setTimeout> | null = null
  /** Wakes the agent at `retirement.at` so a deadline retirement fires ON TIME, not at the next scheduled run. */
  private retireTimer: ReturnType<typeof setTimeout> | null = null
  /** The wake instant the retirement timer last fired for — never issued twice (see `armRetirementTimer`). */
  private retireWakeIssued: string | null = null

  constructor(
    readonly id: string,
    private readonly engine: Engine
  ) {}

  summary(): AgentSummary | null {
    const config = agentStore.getConfig(this.id)
    const state = agentStore.getState(this.id)
    if (!config || !state) return null
    return { config, state: { ...state, running: this.running } }
  }

  /**
   * An open question with a deadline is a promise: "if nobody answers by then,
   * I do the fallback". One timer per agent for the EARLIEST such deadline;
   * past-due fires at once (the app may have been closed), and the `timeout`
   * run is a no-op if the operator answered in the meantime.
   */
  armQuestionTimer(): void {
    if (this.questionTimer) clearTimeout(this.questionTimer)
    this.questionTimer = null
    const st = agentStore.getState(this.id)
    if (!st || st.status === 'paused' || st.status === 'retired') return
    const deadlines = agentStore
      .recentMessages(this.id, 60)
      .filter(isOpenQuestion)
      .map((q) => (q.deadline ? new Date(q.deadline).getTime() : NaN))
      .filter((t) => Number.isFinite(t))
    if (deadlines.length === 0) return
    this.questionTimer = timerFor(
      Math.min(...deadlines),
      () => {
        this.questionTimer = null
        this.request({ trigger: 'timeout' })
      },
      () => this.armQuestionTimer()
    )
  }

  /**
   * A deadline retirement is a promise about a TIME, and a schedule is not a
   * clock: an agent on a 30-minute interval with `retirement.at` 15:45 used to
   * retire whenever its next wake-up happened to land — up to half an hour of
   * open book past the moment the operator named. The wake-up carries trigger
   * `timeout`, which `runOnce` lets through to the retirement check when a
   * deadline is due and treats as a free no-op otherwise.
   */
  armRetirementTimer(): void {
    if (this.retireTimer) clearTimeout(this.retireTimer)
    this.retireTimer = null
    const cfg = agentStore.getConfig(this.id)
    const st = agentStore.getState(this.id)
    if (!cfg || !st) return
    // `retirementWakeAt` (shared/retirement.ts) is the ONE rule for when to wake: the deadline while it is ahead, and after a refused
    // flatten the retry instant — the next open when the market is closed — never
    // the passed deadline again. The first version armed at `retirement.at`
    // regardless, and `arm()` runs at the end of every run: with a deadline in
    // the past and a position it could not sell, that was a zero-delay timer →
    // run → refusal → important note → arm → zero-delay timer, all night.
    const wake = retirementWakeAt(cfg, st, new Date())
    if (!wake) return
    // One wake-up per instant. A run that could not act (offline, a queued
    // no-op) leaves the state — and so the instant — unchanged, and re-arming
    // it would be the same loop with an extra step; the instant moves when a
    // refusal is recorded, and any ordinary run does the retirement check anyway.
    const key = wake.toISOString()
    if (this.retireWakeIssued === key) return
    this.retireTimer = timerFor(
      wake.getTime(),
      () => {
        this.retireTimer = null
        this.retireWakeIssued = key
        this.request({ trigger: 'timeout' })
      },
      () => this.armRetirementTimer()
    )
  }

  /** (Re)compute nextRunAt from the schedule and arm the timer. */
  /**
   * Set the timer for the next wake-up.
   *
   * `reschedule` recomputes `nextRunAt` from the schedule; the DEFAULT keeps a
   * wake-up that is already pending. That default is load-bearing, because
   * `nextRunAt` for an `interval` schedule is relative — always
   * `now + everyMinutes` — so a recompute does not re-derive the pending
   * wake-up, it MOVES it.
   *
   * There are a dozen callers, most incidental (a status write, a provider
   * switch, a resume). One was the Claude usage meter, which polls every 2
   * MINUTES and re-armed every runner on each poll. A 10-minute agent had its
   * next run pushed 10 minutes into the future every 2 minutes and could never
   * fire: runCount stuck at 1, nextRunAt always about 10 minutes out,
   * state.json rewritten constantly. Silent, because nothing was skipped or
   * refused — the wake-up simply never arrived.
   *
   * Only a caller that CHANGED the schedule needs the recompute, and it asks.
   */
  arm(opts: { reschedule?: boolean } = {}): void {
    this.clearTimer()
    this.armQuestionTimer()
    this.armRetirementTimer()
    const cfg = agentStore.getConfig(this.id)
    const st = agentStore.getState(this.id)
    if (!cfg || !st) return
    if (st.status === 'paused' || st.status === 'retired') return
    // A wake-up already in the past means nothing was watching it (app closed,
    // laptop asleep). Re-arming silently would tell the operator nothing, and
    // firing a 3:58 PM trade at 11 PM would be a different trade entirely.
    const due = st.nextRunAt && new Date(st.nextRunAt).getTime() <= Date.now() ? st.nextRunAt : null
    const catchUp = due ? catchUpDecision(cfg.schedule, due, new Date(), st) : 'skip'
    if (catchUp === 'missed') this.engine.postSystem(this.id, 'schedule', missedRunMessage(due!))
    // An interval agent used to lose an entire evening of wake-ups in silence
    // and then show a fresh countdown. arm() runs once per agent at startup, so
    // this is one receipt per absence rather than one per lost tick.
    if (catchUp === 'skip' && due) {
      const note = skippedRunsMessage(cfg.schedule, due)
      if (note) this.engine.postSystem(this.id, 'schedule', note)
    }
    const fresh = armedState(cfg, st.status, new Date(), st)
    // Keep a pending wake-up unless the caller changed the schedule. `catchUp`
    // above has already dealt with anything in the PAST, so a future value here
    // is a live appointment rather than a stale one.
    const pending = !opts.reschedule && st.nextRunAt && new Date(st.nextRunAt).getTime() > Date.now() ? st.nextRunAt : null
    const armed = pending && fresh.nextRunAt ? { ...fresh, nextRunAt: pending } : fresh
    agentStore.saveState(this.id, { ...st, ...armed })
    if (catchUp === 'run') {
      this.request({ trigger: 'schedule' })
      this.engine.emitUpdated(this.id)
      return
    }
    if (armed.nextRunAt) {
      // `again` is a plain re-arm: the pending wake-up is kept (no reschedule),
      // so the far-off instant is simply counted down in another leg.
      this.timer = timerFor(
        new Date(armed.nextRunAt).getTime(),
        () => {
          this.timer = null
          this.request({ trigger: 'schedule' })
        },
        () => this.arm()
      )
    }
    this.engine.emitUpdated(this.id)
  }

  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  request(q: QueuedRun): void {
    // Run now pressed three times is ONE wish, not three runs in a row. The
    // first press queued a run whose bubble took a moment to appear; every
    // further press used to queue another full run behind it, so the agent
    // then thought, traded and reported three times for one click.
    if (q.trigger === 'manual' && (this.current === 'manual' || this.queue.some((x) => x.trigger === 'manual'))) return
    this.queue.push(q)
    void this.drain()
  }

  /** Coalesce rapid operator messages into one reply run. */
  requestReply(text: string): void {
    this.pendingReply.push(text)
    if (this.replyDebounce) clearTimeout(this.replyDebounce)
    this.replyDebounce = setTimeout(() => {
      this.replyDebounce = null
      const userText = this.pendingReply.join('\n')
      this.pendingReply = []
      this.request({ trigger: 'reply', userText })
    }, 1200)
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        // One queued reply per run, in order: every message the operator sent
        // during a run gets its own answer under it (the run answering one
        // stamps the rest as queued behind it and leaves them out of its
        // transcript — runOnce). Only messages typed within 1.2 s of each
        // other share a run (`requestReply`).
        const q = this.queue.shift()!
        const st = agentStore.getState(this.id)
        if (!st) break
        if (st.status === 'paused' && (q.trigger === 'schedule' || q.trigger === 'timeout')) continue
        // Retired means retired, for every trigger. `reply` used to be exempt,
        // which made a queued reply able to wake and RUN a stopped agent.
        if (st.status === 'retired') continue
        // Stalled on the operator. A held action is not a delay the agent can
        // wait out — everything it meant to do next follows from an answer it
        // has not had. Autonomous wake-ups do nothing until then; the operator's
        // own runs still go through, because talking to it IS a response.
        if (st.pendingAction && !st.pendingAction.approvedAt && (q.trigger === 'schedule' || q.trigger === 'watch' || q.trigger === 'timeout')) continue
        // Claude usage hold: the 5-hour window is spent, so autonomous runs of
        // CLAUDE agents wait for the reset (or an operator override). Manual/reply
        // runs still try — the operator explicitly asked for those. Other vendors
        // are unaffected (they have no 5-hour window).
        const holdAt = usageService.holdStartedAt()
        // Each agent runs on ITS OWN provider — there is no fleet-wide override.
        const cfg = agentStore.getConfig(this.id)
        const vendor = cfg?.model.vendor ?? 'claude'
        const autonomousWake = q.trigger === 'schedule' || q.trigger === 'watch' || q.trigger === 'timeout'
        // Offline: providers that think over the network can't run; Local GPU
        // keeps going. Autonomous wake-ups are skipped and replayed once when
        // we're back online (Engine.netTick); operator-driven runs still try so
        // the error is visible in the thread.
        if (cfg && needsNetwork(providerOf(cfg)) && !net.isOnline() && autonomousWake) {
          this.missedOffline = true
          if (!this.offlineNotified) {
            this.offlineNotified = true
            this.engine.postSystem(this.id, 'info', `⏸ Offline — this agent runs on ${PROVIDER_LABEL[providerOf(cfg)]} and will pick up when the connection is back.`)
          }
          continue
        }
        this.offlineNotified = false
        // No OpenRouter key: scheduled wake-ups would only fail one by one. Skip
        // them with one note; an operator-driven run still tries, so the vendor's
        // own error ("add your key under Settings → Connections") is visible.
        if (vendor === 'openrouter' && !openrouterKey.value() && autonomousWake) {
          if (!this.keyMissingNotified) {
            this.keyMissingNotified = true
            this.engine.postSystem(this.id, 'error', '⏸ No OpenRouter API key is set, so scheduled runs are skipped. Add your key under Settings → Connections, or switch this agent to another provider.', 'important')
          }
          continue
        }
        this.keyMissingNotified = false
        if (holdAt && vendor === 'claude' && (q.trigger === 'schedule' || q.trigger === 'watch')) {
          if (this.holdNotifiedAt !== holdAt) {
            this.holdNotifiedAt = holdAt
            const resetsAt = usageService.get().fiveHour?.resetsAt
            this.engine.postSystem(
              this.id,
              'info',
              `⏸ Claude usage limit reached — scheduled runs are on hold${resetsAt ? ` until it resets (${formatEt(resetsAt)})` : ''}. "Resume anyway" in the status bar overrides.`
            )
          }
          continue
        }
        this.abort = new AbortController()
        this.current = q.trigger
        this.engine.emitUpdated(this.id, true)
        try {
          const outcome = await runOnce(this.engine.deps, { agentId: this.id, trigger: q.trigger, userText: q.userText, abort: this.abort.signal })
          // A limit error mid-run means our cached reading is stale — re-probe.
          if (outcome.error && /usage limit|rate.?limit|exceeded.{0,24}limit/i.test(outcome.error)) usageService.noteLimitError()
        } catch (err) {
          console.error('[engine] run failed', this.id, err)
          const st2 = agentStore.getState(this.id)
          if (st2) agentStore.saveState(this.id, { ...st2, lastError: (err as Error).message, status: 'error' })
          this.engine.postSystem(this.id, 'error', `Run crashed: ${(err as Error).message}`)
        } finally {
          this.abort = null
          this.current = null
        }
      }
    } finally {
      this.running = false
      this.arm()
    }
  }

  pause(): void {
    this.clearTimer()
    if (this.questionTimer) clearTimeout(this.questionTimer)
    this.questionTimer = null
    if (this.retireTimer) clearTimeout(this.retireTimer)
    this.retireTimer = null
    if (this.replyDebounce) clearTimeout(this.replyDebounce)
    this.queue = this.queue.filter((q) => q.trigger === 'reply')
    this.abort?.abort(new Error('Paused'))
    const st = agentStore.getState(this.id)
    if (st) agentStore.saveState(this.id, { ...st, status: 'paused', nextRunAt: null })
    this.engine.postSystem(this.id, 'paused', LIFECYCLE.paused)
    this.engine.emitUpdated(this.id)
  }

  resume(): void {
    const st = agentStore.getState(this.id)
    if (st) agentStore.saveState(this.id, { ...st, status: 'idle', lastError: null })
    this.engine.postSystem(this.id, 'resumed', LIFECYCLE.resumed)
    this.arm()
  }

  stop(): void {
    this.abort?.abort(new Error('Stopped by operator'))
  }

  /** The connection is back: replay the one wake-up we skipped while offline. */
  backOnline(): void {
    if (!this.missedOffline) return
    this.missedOffline = false
    this.request({ trigger: 'schedule' })
  }

  dispose(): void {
    this.clearTimer()
    if (this.questionTimer) clearTimeout(this.questionTimer)
    this.questionTimer = null
    if (this.retireTimer) clearTimeout(this.retireTimer)
    this.retireTimer = null
    if (this.replyDebounce) clearTimeout(this.replyDebounce)
    this.abort?.abort(new Error('Shutting down'))
  }

  get isRunning(): boolean {
    return this.running
  }
}

/**
 * The prompt tells every local agent how often its stops are checked and takes
 * the number from here (shared/agents.ts), so changing the cadence changes what
 * the agent is told. The interlock has to run BOTH ways: `null` means "nothing
 * sweeps between runs", which is what the prompt then says, so the sweep must
 * actually not run. A `?? 15_000` fallback here would have kept sweeping while
 * the prompt claimed nothing was watching — the same drift the constant exists
 * to prevent, pointing the other way.
 */
const WATCH_TICK_MS = DESKTOP_EXIT_WATCH_MS
/** How often the desktop samples connectivity (Electron has no main-process online event). */
const NET_TICK_MS = 20_000

export class Engine {
  private runners = new Map<string, AgentRunner>()
  private listeners = new Set<Listener>()
  private watchTimer: ReturnType<typeof setInterval> | null = null
  private netTimer: ReturnType<typeof setInterval> | null = null
  private online = true
  private watcherBusy = false
  deps!: RuntimeDeps

  async init(): Promise<void> {
    const sdk = await loadSdk()
    const cwd = join(app.getPath('userData'), 'agent-cwd')
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
    this.deps = {
      // Every vendor runs on the operator's own account or hardware: Claude (via
      // Claude Code's own login), ChatGPT (Codex OAuth), OpenRouter (their API
      // key) and Local GPU.
      vendors: {
        claude: createClaudeRunner({ sdk, cliPath: process.env.TB_CLAUDE_CLI_PATH }),
        // The operator's ChatGPT subscription (Codex OAuth).
        chatgpt: createChatGptRunner({
          session: async (force) => {
            const t = await freshTokens(force)
            return t?.accessToken && t.accountId ? { accessToken: t.accessToken, accountId: t.accountId } : null
          },
          endpoint: { url: CHATGPT_OAUTH.RESPONSES_URL, originator: CHATGPT_OAUTH.ORIGINATOR, beta: CHATGPT_OAUTH.HEADER_BETA, userAgent: CHATGPT_OAUTH.USER_AGENT }
        }),
        openrouter: createOpenRouterRunner({ apiKey: async () => openrouterKey.value(), modules: loadOpenRouter }),
        // Local GPU (the @elyxndra/engine llama.cpp runtime).
        local: createLocalRunner({
          endpoint: () => localEngine.endpoint(),
          modules: () => import('@elyxndra/agent') as never,
          unavailableReason: () => localEngine.unavailableReason()
        })
      },
      // Can this computer take another agent? Same rule the New-agent sheet and
      // the IPC gate use — asked here so `propose_agent` explains a refusal
      // rather than posting a card the create would then reject.
      capacity: async () => agentCapacity(countActiveAgents(agentStore.list())),
      // Why a tool call was allowed or blocked, per agent (decisions.jsonl).
      audit: (rec) => agentStore.appendDecision(rec),
      // The read half, so the next run can be told what was refused. Local file,
      // already newest-first, so no async work — wrapped only to satisfy the seam.
      recentDecisions: async (agentId, limit) => agentStore.decisions(agentId, { limit }),
      storage: {
        ...localStorageAdapter,
        appendMessage: async (m: Message) => {
          agentStore.appendMessage(m)
          this.emit({ type: 'message:new', message: m })
        },
        updateMessage: async (m: Message) => {
          agentStore.updateMessage(m)
          this.emit({ type: 'message:updated', message: m })
        },
        saveState: async (id, state) => {
          agentStore.saveState(id, state)
          this.emitUpdated(id)
        },
        appendRun: async (r) => agentStore.appendRun(r)
      },
      creds: localCredentialSource,
      // Paper agents without Robinhood price from the operator's own Alpaca
      // market-data key, when one is set (`main/market/feed.ts`).
      marketFeed: async () => desktopMarketFeed(),
      cwd,
      // Which build ran this, stamped on every run record.
      build: `desktop-${app.getVersion()}`,
      tools: () => mcpKeys.toolAccess(),
      // The trading halt, from settings — a local read, so it holds with the
      // network down too, the case where an operator most wants everything to stop.
      accountControls: async () => ({ tradingHalted: settingsStore.load().tradingHalted }),
      emit: (agentId: string, runId: string, delta: RunDelta) => this.emit({ type: 'run:delta', agentId, runId, delta }),
      log: (level, msg, extra) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[runner] ${msg}`, extra ?? '')
    }
    for (const s of agentStore.list()) {
      // Downtime honesty lives in arm(): catchUpDecision() runs a wake-up that is
      // only a little late and posts a "missed" receipt for one that expired.
      const r = new AgentRunner(s.config.id, this)
      this.runners.set(s.config.id, r)
      r.arm()
    }
    if (WATCH_TICK_MS !== null) this.watchTimer = setInterval(() => void this.watchTick(), WATCH_TICK_MS)
    this.online = net.isOnline()
    this.netTimer = setInterval(() => this.netTick(), NET_TICK_MS)
    this.warmLocalEngine()

    // Claude usage meter: poll the 5-hour window, and when a hold lifts (reset
    // passed, usage recovered, or operator override) re-arm every runner so the
    // next scheduled wake-ups fire normally.
    // ...when a hold LIFTS — on the EDGE, not on every poll. This fires every 2
    // minutes in the ordinary case where no hold is active, and re-arming there
    // is what froze every local agent (see AgentRunner.arm).
    let wasHeld = false
    usageService.onChange((u) => {
      if (wasHeld && !u.holdActive) for (const r of this.runners.values()) r.arm({ reschedule: true })
      wasHeld = u.holdActive
    })
    usageService.start()
  }

  /** Any Local GPU agent on the books → attach the engine now so its first tick doesn't pay the cold start. */
  warmLocalEngine(): void {
    const any = agentStore.list().some((s) => s.state.status !== 'retired' && providerOf(s.config) === 'local')
    if (any) void localEngine.ensure().catch((err) => console.warn('[local-engine]', (err as Error).message))
  }

  /** Offline ↔ online transitions: when the connection returns, skipped wake-ups replay once. */
  private netTick(): void {
    const now = net.isOnline()
    if (now === this.online) return
    this.online = now
    if (now) for (const r of this.runners.values()) r.backOnline()
  }

  /**
   * Stop working on one standing task. Kept on the list with a `doneAt` rather
   * than deleted: the agent's history should still show what it was asked to do
   * and when that stopped, and `activeTasks` is what the model is given.
   */
  async completeTask(id: string, taskId: string, reason = 'Removed by the operator'): Promise<AgentSummary> {
    const cfg = agentStore.getConfig(id)
    if (!cfg) throw new Error('agent not found')
    const task = activeTasks(cfg).find((t) => t.id === taskId)
    if (!task) throw new Error('that task is not active on this agent')
    const next = applyPlanToConfig(cfg, { guardrails: {}, summary: `Stopped: ${task.text}`, completeTaskId: taskId, completeReason: reason }, new Date().toISOString())
    const note = LIFECYCLE.taskRemoved(task.text)
    agentStore.saveConfig(next)
    this.postSystem(id, 'info', note)
    this.emitUpdated(id)
    return this.get(id)!
  }

  /**
   * Confirming a `spawnAgent` card creates a SEPARATE agent — it does not touch
   * the proposing one. The new agent inherits everything that is a safety
   * decision (provider, mode, guardrails, allocation) and differs only in what
   * it watches, which is the whole point of splitting the work.
   *
   * Gates run here, not only when the card was proposed: the fleet may have
   * filled up in between, and the card is a request, not a promise.
   */
  private async spawnFromPlan(parentId: string, m: Extract<Message, { role: 'plan' }>, parent: AgentConfig): Promise<AgentSummary> {
    const spec = m.plan.spawnAgent!
    const cap = await this.deps.capacity?.()
    if (cap && !cap.ok) throw new Error(`Can't create it: ${cap.reason ?? 'there is no room for another agent.'}`)
    const child = configFromCreateRequest(
      {
        name: spec.name,
        icon: parent.icon,
        color: parent.color,
        task: spec.task,
        mode: parent.mode,
        model: parent.model,
        allocationUsd: parent.allocationUsd,
        guardrails: parent.guardrails,
        // Autonomy is inherited like the guardrails are: an operator who wants
        // to be asked before money moves wants to be asked by the offspring too.
        autonomous: isAutonomous(parent),
        schedule: spec.schedule,
        planNow: false
      },
      parent.model
    )
    const created = await this.create(child, false)
    const done: Message = { ...m, status: 'applied' }
    agentStore.updateMessage(done)
    this.postSystem(parentId, 'info', LIFECYCLE.spawned(spec.name))
    this.postSystem(created.config.id, 'created', LIFECYCLE.spawnedFrom(parent.name))
    this.emit({ type: 'message:updated', message: done })
    this.emitUpdated(parentId)
    return this.get(parentId)!
  }

  /**
   * Move an agent to another provider. A model swap: the next run uses the new
   * service, and an in-flight run finishes on the old one.
   */
  async setProvider(id: string, to: Provider): Promise<AgentSummary> {
    const cfg = agentStore.getConfig(id)
    if (!cfg) throw new Error('agent not found')
    const from = providerOf(cfg)
    if (from === to) return this.get(id)!
    const next: AgentConfig = { ...cfg, ...providerTarget(to, cfg.model), updatedAt: new Date().toISOString() }
    agentStore.saveConfig(next)
    this.postSystem(id, 'mode', LIFECYCLE.providerSwitched(from, to))
    this.warmLocalEngine()
    this.emitUpdated(id)
    return this.get(id)!
  }

  /** Re-broadcast every agent summary (e.g. after a usage-hold change). */
  emitAll(): void {
    for (const id of this.runners.keys()) this.emitUpdated(id)
  }

  /**
   * The between-runs guardian: every ~15s during the session, evaluate price
   * watches (fire -> system message + immediate 'watch' run) and enforce
   * stop/target exit plans (protective market sells) for idle agents.
   * Agents mid-run are skipped — their tick does the same checks itself.
   */
  private async watchTick(): Promise<void> {
    if (this.watcherBusy) return
    if (!isRegularSession() && !isExtendedSession()) return
    const candidates: { id: string; cfg: AgentConfig; st: ReturnType<typeof agentStore.getState> & object }[] = []
    for (const [id, r] of this.runners) {
      if (r.isRunning) continue
      const cfg = agentStore.getConfig(id)
      const st = agentStore.getState(id)
      if (!cfg || !st || st.status === 'paused') continue
      if (st.status === 'retired' && Object.keys(st.exits).length === 0) continue
      if (st.status !== 'retired' && Object.keys(st.exits).length === 0 && st.watches.length === 0) continue
      candidates.push({ id, cfg, st })
    }
    if (!candidates.length) return
    const creds = await rhCreds.fresh().catch(() => null)
    const rh = creds?.accessToken ? rhCreds.client() : null
    // No Robinhood: a market-data key still serves PAPER agents' watches and
    // trails. Live agents need the broker to sell and are skipped.
    const feed = rh ? null : desktopMarketFeed()
    if (!rh && !feed) return
    const served = rh ? candidates : candidates.filter(({ cfg }) => cfg.mode === 'paper')
    if (!served.length) return
    this.watcherBusy = true
    try {
      const syms = [...new Set(served.flatMap(({ st }) => [...Object.keys(st.exits), ...st.watches.map((w) => w.symbol)]))]
      if (!syms.length) return
      const quotes = rh ? await getQuotes(rh, syms) : (await feed!.quotes(syms)).quotes
      for (const { id, cfg } of served) {
        const runner = this.runners.get(id)
        if (!runner || runner.isRunning) continue
        let state = agentStore.getState(id)
        if (!state || state.status === 'paused') continue
        // Price watches → wake the agent (never for retired agents).
        const fw = state.status === 'retired' ? { state, fired: [] } : fireWatches(state, quotes)
        if (fw.fired.length) {
          state = fw.state
          agentStore.saveState(id, state)
          for (const f of fw.fired) {
            this.postSystem(id, 'info', `${WATCH_FIRED_PREFIX}${f.description}`)
            runner.request({ trigger: 'watch', userText: f.description })
          }
        }
        // Stop/target exits → protective sells (regular session; market orders).
        if (isRegularSession() && Object.keys(state.exits).length && !runner.isRunning) {
          const ex = await enforceExits({ config: cfg, state, rh, feed, accountNumber: creds?.accountNumber ?? null, quotes })
          // Persist whenever ANYTHING changed — a trail ratchet, a dropped plan,
          // a daily-loss lock — not only when something sold: writing only on a
          // sale would throw the lock away. `enforceExits` returns the same
          // object when nothing changed (`check-exit-sweep.ts` pins it).
          if (ex.state !== state) {
            agentStore.saveState(id, ex.state)
            for (const r of ex.results) this.postAction(id, r.action)
            this.emitUpdated(id)
          }
        }
      }
    } catch (err) {
      console.warn('[watcher]', (err as Error).message)
    } finally {
      this.watcherBusy = false
    }
  }

  /** The one message-append path: rolls up preview/lastMessageAt (+unread) and emits. */
  private append(agentId: string, msg: Message, bumpUnread: boolean): void {
    agentStore.appendMessage(msg)
    const st = agentStore.getState(agentId)
    if (st) agentStore.saveState(agentId, { ...st, lastMessageAt: msg.ts, lastMessagePreview: previewOf(msg), unread: bumpUnread ? st.unread + 1 : st.unread })
    this.emit({ type: 'message:new', message: msg })
  }

  postAction(agentId: string, action: Extract<Message, { role: 'action' }>['action']): void {
    this.append(agentId, { id: newId('m_'), agentId, ts: new Date().toISOString(), role: 'action', action }, true)
  }

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  /**
   * Runs in flight, by agent, from the delta stream itself. The `start` delta
   * is emitted the instant a run begins — the saved `running` flag follows
   * after context is built — so this is the earliest answer to "which run
   * would a message sent NOW wait behind".
   */
  private inFlight = new Map<string, string>()
  emit(e: AgentEvent): void {
    if (e.type === 'run:delta') {
      if (e.delta.kind === 'start') this.inFlight.set(e.agentId, e.runId)
      else if (e.delta.kind === 'end' && this.inFlight.get(e.agentId) === e.runId) this.inFlight.delete(e.agentId)
    }
    for (const l of this.listeners) {
      try {
        l(e)
      } catch {
        /* ignore */
      }
    }
  }
  emitUpdated(id: string, running?: boolean): void {
    const s = this.get(id)
    if (!s) return
    if (running !== undefined) s.state.running = running
    this.emit({ type: 'agent:updated', summary: s })
  }

  /**
   * `notify: 'important'` is for a note the operator must see wherever they are
   * — the engine stopping their agent. Their OWN tap on Pause posts the same
   * kind and stays quiet, and nothing derived from the message can tell those
   * two apart, so the sender says which it is.
   */
  postSystem(agentId: string, kind: Extract<NewMessage, { role: 'system' }>['kind'], text: string, notify?: 'fyi' | 'important'): void {
    this.append(agentId, { id: newId('m_'), agentId, ts: new Date().toISOString(), role: 'system', kind, text, ...(notify ? { notify } : {}) }, false)
  }

  list(): AgentSummary[] {
    return agentStore.list().map((s) => ({ ...s, state: { ...s.state, running: this.runners.get(s.config.id)?.isRunning ?? false } }))
  }
  get(id: string): AgentSummary | null {
    const s = this.runners.get(id)?.summary()
    if (s) return s
    const config = agentStore.getConfig(id)
    const state = agentStore.getState(id)
    return config && state ? { config, state } : null
  }

  async create(cfg: AgentConfig, planNow: boolean): Promise<AgentSummary> {
    const s = agentStore.create(cfg)
    // Intent marker: a setup run that never lands must not look like an
    // operator who chose manual (see setupState()).
    if (planNow && cfg.task.trim()) {
      const st = agentStore.getState(cfg.id)
      if (st) agentStore.saveState(cfg.id, { ...st, awaitingPlan: true })
    }
    this.postSystem(cfg.id, 'created', LIFECYCLE.created(cfg.mode))
    if (cfg.mode === 'live' && !cfg.liveArmedAt) this.postSystem(cfg.id, 'info', LIFECYCLE.createdLiveUnarmed)
    const r = new AgentRunner(cfg.id, this)
    this.runners.set(cfg.id, r)
    if (planNow && cfg.task.trim()) r.request({ trigger: 'plan' })
    else {
      r.arm()
      // The introduction run (prompts.introBlock): the operator hears from the
      // agent now rather than at its first scheduled tick.
      if (cfg.task.trim()) r.request({ trigger: 'manual' })
    }
    this.warmLocalEngine()
    return this.get(cfg.id) ?? s
  }

  async update(id: string, patch: Partial<AgentConfig>): Promise<AgentSummary> {
    const cfg = agentStore.getConfig(id)
    if (!cfg) throw new Error('agent not found')
    const next: AgentConfig = { ...cfg, ...patch, updatedAt: new Date().toISOString() }
    if (patch.mode && patch.mode !== cfg.mode) next.liveArmedAt = null
    const modeNote = patch.mode && patch.mode !== cfg.mode ? LIFECYCLE.modeSwitched(next.mode) : null
    // Autonomy is a safety setting, so the thread records the change like one.
    const autonomyNote = patch.autonomous !== undefined && isAutonomous(patch) !== isAutonomous(cfg) ? LIFECYCLE.autonomyChanged(isAutonomous(next)) : null
    agentStore.saveConfig(next)
    // A schedule the operator set themselves answers the setup question, however
    // the agent's own plan run went (see setupState).
    if (patch.schedule) {
      const st = agentStore.getState(id)
      if (st?.awaitingPlan) agentStore.saveState(id, { ...st, awaitingPlan: false })
    }
    if (patch.schedule) this.postSystem(id, 'schedule', LIFECYCLE.scheduleUpdated)
    if (modeNote) this.postSystem(id, 'mode', modeNote)
    if (autonomyNote) this.postSystem(id, 'mode', autonomyNote)
    // A NEW schedule must re-derive the next wake-up; everything else in this
    // patch leaves the pending one alone.
    this.runners.get(id)?.arm({ reschedule: Boolean(patch.schedule) })
    this.emitUpdated(id)
    return this.get(id)!
  }

  async delete(id: string): Promise<void> {
    this.runners.get(id)?.dispose()
    this.runners.delete(id)
    agentStore.delete(id)
    this.emit({ type: 'agent:deleted', agentId: id })
  }

  async pause(id: string): Promise<AgentSummary> {
    this.runners.get(id)?.pause()
    return this.get(id)!
  }
  async resume(id: string): Promise<AgentSummary> {
    this.runners.get(id)?.resume()
    return this.get(id)!
  }
  async runNow(id: string): Promise<void> {
    this.runners.get(id)?.request({ trigger: 'manual' })
  }
  /** Stop the run in flight (aborted here). Queued messages go out as soon as it stops. */
  async stop(id: string): Promise<void> {
    this.runners.get(id)?.stop()
  }

  /** Operator message → stored + reply run. */
  async send(id: string, text: string): Promise<Message> {
    // Refused BEFORE the message row is written. Appending it and then declining
    // to run would leave the operator's words in the thread with nothing ever
    // answering them, which reads as the agent ignoring them.
    if (agentStore.getState(id)?.status === 'retired') throw new Error(RETIRED_NO_MESSAGE)
    // Sent mid-run: record the run it waits behind so the thread places it
    // after that run's reply (shared/messageQueue.ts). The live stream knows
    // first (`inFlight`); the saved state is the fallback for a run whose
    // start delta this process never saw.
    const st = agentStore.getState(id)
    const queuedBehind = this.inFlight.get(id) ?? (st && this.runners.get(id)?.isRunning ? queuedBehindNow({ running: true, runId: st.runId }) : undefined)
    const m: Message = { id: newId('m_'), agentId: id, ts: new Date().toISOString(), role: 'user', text, ...(queuedBehind ? { queuedBehind } : {}) }
    this.append(id, m, false)
    this.runners.get(id)?.requestReply(text)
    return m
  }

  markRead(id: string): void {
    const st = agentStore.getState(id)
    if (!st?.unread) return
    agentStore.saveState(id, { ...st, unread: 0 })
    this.emitUpdated(id)
  }

  async applyPlan(id: string, messageId: string): Promise<AgentSummary> {
    const m = agentStore.getMessage(id, messageId)
    if (!m || m.role !== 'plan') throw new Error('plan not found')
    const cfg = agentStore.getConfig(id)!
    if (m.plan.spawnAgent) return this.spawnFromPlan(id, m, cfg)
    const updated: Message = { ...m, status: 'applied' }
    agentStore.saveConfig(applyPlanToConfig(cfg, m.plan, new Date().toISOString()))
    agentStore.updateMessage(updated)
    this.emit({ type: 'message:updated', message: updated })
    this.postSystem(id, m.plan.addTask ? 'info' : 'schedule', LIFECYCLE.planConfirmed(m.plan))
    const runner = this.runners.get(id)
    // Recompute: a plan can carry a new schedule.
    runner?.arm({ reschedule: true })
    // Confirming is the operator saying yes — act on it now rather than at the
    // next scheduled wake-up.
    runner?.request({ trigger: 'manual' })
    this.emitUpdated(id)
    return this.get(id)!
  }
  /**
   * The operator answers a held action. Approving does NOT execute it — it marks
   * the request approved and wakes the agent to decide again with fresh prices,
   * which is the whole reason the wait is safe to allow at any length.
   */
  async answerApproval(id: string, messageId: string, approve: boolean): Promise<AgentSummary> {
    const m = agentStore.getMessage(id, messageId)
    if (!m || m.role !== 'approval') throw new Error('request not found')
    if (m.status !== 'pending') return this.get(id)!
    // The card and the agent's own state must still agree. They stop agreeing
    // when the request was withdrawn (the operator messaged instead of
    // answering) and the card scrolled out of the run's transcript window, so it
    // was never marked. Approving it here would revive an intention the agent
    // has already moved past — mark it withdrawn instead and change nothing.
    const state = agentStore.getState(id)!
    if (state.pendingAction?.id !== m.action.id) {
      const stale: Message = { ...m, status: 'withdrawn', answeredAt: new Date().toISOString(), outcome: 'No longer waiting on this — the agent moved on.' }
      agentStore.updateMessage(stale)
      this.emit({ type: 'message:updated', message: stale })
      return this.get(id)!
    }
    const at = new Date().toISOString()
    const updated: Message = { ...m, status: approve ? 'approved' : 'rejected', answeredAt: at }
    agentStore.updateMessage(updated)
    this.emit({ type: 'message:updated', message: updated })
    agentStore.saveState(id, { ...state, pendingAction: approve ? { ...m.action, approvedAt: at } : null })
    this.postSystem(id, 'info', LIFECYCLE.approvalAnswered(m.action.summary, approve))
    const runner = this.runners.get(id)
    if (approve) runner?.request({ trigger: 'approval' })
    else runner?.arm()
    this.emitUpdated(id)
    return this.get(id)!
  }

  async dismissPlan(id: string, messageId: string): Promise<void> {
    const m = agentStore.getMessage(id, messageId)
    if (!m || m.role !== 'plan') return
    const updated: Message = { ...m, status: 'dismissed' }
    agentStore.updateMessage(updated)
    this.emit({ type: 'message:updated', message: updated })
  }

  async resetPaper(id: string): Promise<AgentSummary> {
    const cfg = agentStore.getConfig(id)!
    agentStore.saveState(id, { ...agentStore.getState(id)!, paper: emptyLedger(cfg.allocationUsd) })
    this.postSystem(id, 'info', LIFECYCLE.paperReset(cfg.allocationUsd))
    this.emitUpdated(id)
    return this.get(id)!
  }

  async armLive(id: string, armed: boolean): Promise<AgentSummary> {
    const cfg = agentStore.getConfig(id)!
    // Arming against a broker that is not connected would leave an agent that
    // reads as "armed, real money" and discovers at 09:31 that it has nowhere
    // to send an order.
    if (armed) {
      const blocked = armBlockedReason(rhCreds.status())
      if (blocked) throw new Error(blocked)
    }
    agentStore.saveConfig({ ...cfg, liveArmedAt: armed ? new Date().toISOString() : null, updatedAt: new Date().toISOString() })
    this.postSystem(id, 'mode', armed ? LIFECYCLE.armed : LIFECYCLE.disarmed)
    this.emitUpdated(id)
    return this.get(id)!
  }

  /** Manual retirement from the UI: flatten (per policy), stop, keep everything. */
  async retire(id: string, reason = 'Retired by operator'): Promise<AgentSummary> {
    const runner = this.runners.get(id)
    runner?.stop()
    runner?.clearTimer()
    const cfg = agentStore.getConfig(id)
    let state = agentStore.getState(id)
    if (!cfg || !state) throw new Error('agent not found')
    if (state.status === 'retired') return this.get(id)!
    const creds = await rhCreds.fresh().catch(() => null)
    const rh = rhCreds.client()
    const syms = (cfg.mode === 'live' ? state.live : state.paper).positions.map((p) => p.symbol)
    // Flattening a paper book needs prices, not a broker — a market-data key serves it.
    const feed = pickFeed(cfg.mode, rh, desktopMarketFeed())
    const quotes = feed && syms.length ? (await feed.quotes(syms).catch(() => ({ quotes: [] }))).quotes : []
    const ret = await executeRetirement({ config: cfg, state, rh, feed, accountNumber: creds?.accountNumber ?? null, quotes }, reason, new Date())
    agentStore.saveState(id, ret.state)
    for (const r of ret.results) this.postAction(id, r.action)
    if (!ret.retired) {
      // The operator pressed Retire and the book could not be flattened: say
      // so (rung once a day — a repeat stays in the thread), keep it alive with
      // its exits armed, and let them decide. `arm()` reads the
      // refusal just saved and waits for the retry instant, not the deadline.
      this.postSystem(id, 'error', cannotFlattenNote(reason, ret.open ?? []), ret.repeat ? undefined : 'important')
      runner?.arm()
      this.emitUpdated(id)
      return this.get(id)!
    }
    this.postSystem(id, 'retired', LIFECYCLE.retired(reason, ret.note ?? undefined))
    this.emitUpdated(id)
    return this.get(id)!
  }

  /** Bring a retired agent back: schedule re-arms; the retirement policy is
   *  cleared (it was already satisfied — set a new one via chat if wanted). */
  async respawn(id: string): Promise<AgentSummary> {
    const cfg = agentStore.getConfig(id)
    const st = agentStore.getState(id)
    if (!cfg || !st) throw new Error('agent not found')
    if (st.status !== 'retired') return this.get(id)!
    agentStore.saveConfig({ ...cfg, retirement: null, updatedAt: new Date().toISOString() })
    // `respawnedAt` makes the next run a REVISION run (prompts.respawnBlock):
    // update the plan for today, then tell the operator what changed.
    agentStore.saveState(id, { ...st, status: 'idle', retiredAt: null, retireReason: null, lastError: null, respawnedAt: new Date().toISOString() })
    this.postSystem(id, 'resumed', LIFECYCLE.respawned)
    let runner = this.runners.get(id)
    if (!runner) {
      runner = new AgentRunner(id, this)
      this.runners.set(id, runner)
    }
    // Recompute: a respawned agent re-derives its schedule from scratch.
    runner?.arm({ reschedule: true })
    // The revision runs NOW — a manual-schedule agent has no next tick, and the
    // operator who just pressed Respawn is watching.
    runner?.request({ trigger: 'manual' })
    return this.get(id)!
  }

  disposeAll(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    if (this.netTimer) clearInterval(this.netTimer)
    for (const r of this.runners.values()) r.dispose()
  }
}

export const engine = new Engine()
