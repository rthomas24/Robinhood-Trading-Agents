import { MAX_ERRANDS, MAX_TASKS, OVERNIGHT_WARN_MINUTES, armExitPlan, clampGuardrails, cutInsideRange, describeExitPlan, effectiveStop, exitEnforcementNote, flattenTomorrowNote, openRouterModelFor, goalRealism, goalRealismLine, guardrailDiff, loosensGuardrails, money, trailTooTight, type ExitPlan, QUESTION_WAIT_DEFAULT_MIN, QUESTION_WAIT_MAX, QUESTION_WAIT_MIN, UNATTENDED_QUESTIONS_PER_DAY, UNATTENDED_TELLS_PER_DAY, VENDOR_LABEL, WATCH_FIRED_PREFIX, activeTasks, applyPlanToConfig, errandReady, errandStale, fillEconomics, isAutonomous, isOpenQuestion, isWriteTool, newId, previewOf, questionExpired, reportFallbackText, riskSummary, type AgentConfig, type AgentReport, type AgentState, type Errand, type Fill, type Ledger, type ApprovalMessage, type Message, type ModelChoice, type NewMessage, type PendingAction, type PlanProposal, type QuestionMessage, type RunRecord, type TradeIntent, runBookSummary } from '@shared/agents'
import { hasExitSpec } from '@shared/agents'
import { MAX_AGENT_NAME } from '@shared/createAgent'
import { LIFECYCLE } from '@shared/lifecycle'
import {
  approvalCovers,
  approvalExpired,
  approvalExpiredNote,
  approvalExpiredOutcome,
  approvalMootNote,
  approvalMootOutcome,
  approvalPassedNote,
  approvalPassedOutcome,
  approvalReviewNote,
  approvalSupersededNote,
  approvalSupersededOutcome,
  alreadyHeldMessage,
  describeHeldAction,
  heldMessage,
  outsideApprovalMessage
} from '@shared/approval'
import { exclusiveLane } from './serial'
import { describeSchedule, nextWakeAt } from '@shared/schedule'
import { MAX_SLEEP_DAYS, activeSleep } from '@shared/sleep'
import { reportClaimsSleep, sleepClaimAdvice, sleepClaimNote } from './sleepClaim'
import { describeSettlesOn, settlementModeFor } from '@shared/settlement'
import { sessionLabel, formatEt, isExtendedSession, isRegularSession, etClock } from '@shared/marketTime'
import type { Quote } from '@shared/ipc'
import type { RobinhoodMcpClient } from '../robinhood/mcp'
import { createRobinhoodClient } from '../robinhood/client'
import { getAccounts, getPortfolio } from '../robinhood/api'
import { pickFeed, type PriceFeed } from '../market/feed'
import { buildRobinhoodServer, isRobinhoodToolAllowed, robinhoodBareName, robinhoodToolName, robinhoodWriteToolsFor, ROBINHOOD_SERVER_NAME, type RobinhoodToolContext } from '../robinhood/tools'
import { intentFromDirectOrder, orderFromToolResponse } from '../robinhood/directOrders'
import { robinhoodToolGroup, robinhoodToolKind } from '@shared/mcps'
import { DEFAULT_TOOL_ACCESS, isIntelToolAllowed, resolveIntelServers } from '../intel/servers'
import { checkGuardrails, exitLevelProblem } from '../broker/guardrails'
import { applyExitsForFills, cannotFlattenNote, dailyLossLock, dailyLossLockNote, enforceExits, executeCancel, executeRetirement, executeTrade, fireWatches, reconcileLiveOpenOrders, retirementDue, type ExecContext } from '../broker/execute'
import { applyFill, markToMarket, settlePaperOpenOrders, toPaperQuotes } from '../broker/paper'
import { ledgerFor, ordersTodayCount, positionQty } from '../broker/guardrails'
import { composeRunPrompt, composeSystemPrompt, postMortemBlock, runPromptBlocks, transcriptBlock } from './prompts'
import { promptBreakdown } from './promptBreakdown'
import { shouldRotateSession } from './contextWindow'
import { createStreamGuard } from './streamRepeat'
import { busySignals, priceMoved, quietTickReason, type TickSignals } from './quiet'
import { analysisBlock, buildSymbolContext, dailyRangeOf, type SymbolContext } from './marketContext'
import { stripLeakedMarkup } from './markup'
import { TB_SERVER_NAME, tbToolName, toolDefinitionHash, toolsFor, TB_TOOL_NAMES, type ToolHost } from './agentTools'
import { EARNINGS_POP, REPORT_WINDOW_LABEL, allInNotional, allInSpendable, earningsPopGate, earningsPopPhase, isEarningsPop, reportWindow } from '@shared/earningsPlaybook'
import { earningsCandidates, earningsDossier, nextReport } from '../research/earnings'
import type { MarketContext, RunOutcome, RunRequest, RuntimeDeps } from './types'
import type { RemoteMcpServer, ToolGate, VendorRunResult } from './vendors/types'
import { redactSecrets } from '../redact'
import type { RunTrace } from '../trace/types'
import { entryRunsFor, sellsSince } from '../trace/outcomes'
import { describeError, emptyResult, short } from './vendors/shared'
import { RepeatDetector, repeatBlockMessage } from './repeat'
import { classifyRunError, isContextOverflow, MAX_TRANSIENT_RETRIES, retryDelayMs, sleepUnlessAborted } from './retry'
import { decisionRecorder, isAttended, type DecisionRecord, type GuardrailRule } from '@shared/decisions'

/**
 * The run's hard ceiling. Some models spend 60–80 s per step when they reason at
 * length, so a run that verified a pick (two steps) and then fumbled one tool
 * argument needs time left to retry, and a provider silent for the 120 s setup
 * window still leaves the retry a real chance.
 */
export const RUN_TIMEOUT_MS = 300_000
/** What a tool call is told when it arrives after its run has ended (see `runEnded` in runOnce). */
export const RUN_OVER_MSG = 'This run has ended — the call was not carried out. It will be considered again on the next run.'
/** What the thread records for a call the model asked for that never executed (deadline, Stop, vendor failure). */
export const NOT_RUN_MSG = 'Did not run — the run ended before this step could execute.'
/** The live bubble's line while a silent turn is re-asked. */
export const SILENT_TURN_REASON = 'the model planned but did not act — asked once more'
/** Appended to the run prompt for the one re-ask a silent turn gets. */
export const SILENT_TURN_NUDGE =
  'YOUR PREVIOUS ATTEMPT AT THIS RUN ENDED WITHOUT ACTING: you reasoned privately and then stopped without calling a single tool or writing a reply, so nothing you planned happened and the operator saw nothing. Do it now — call the tools you intended (report, remember, trade, set_exit…) and write your reply. Never end a run on reasoning alone.'
/** The engine-executed trade tool, as the decision log names it. */
const TRADE_TOOL = tbToolName('trade')
/**
 * Silence ceiling. Watching ACTIVITY rather than duration is the useful signal:
 * a run streaming text and tool calls is working, but one that has emitted
 * nothing for this long is wedged (a hung socket, a vendor that stopped
 * streaming without closing). Failing at 45s leaves time to retry inside the
 * hard ceiling instead of burning all 180s on a dead connection.
 */
const STALL_TIMEOUT_MS = 45_000
/**
 * The same watchdog, but while a TOOL is running.
 *
 * A tool executing is not the model being silent, and treating it as such
 * kills working runs: a web-research call that fetches and ranks full pages
 * comfortably outlasts 45s, and an attempt aborted mid-tool three times running
 * fails a run that did nothing wrong.
 *
 * A hung tool is still caught — by this, and behind it by `RUN_TIMEOUT_MS`,
 * which bounds the whole attempt regardless. The division of labour: the short
 * window catches a wedged MODEL, this one catches a wedged TOOL, and the run
 * ceiling catches anything neither noticed.
 */
const TOOL_STALL_TIMEOUT_MS = 120_000
/**
 * Research tools get longer. A
 * WebVector `research` call fetches and summarises several pages; a quote
 * returns in under a second. One budget for both means the flat number is
 * either too tight for the first or useless for the second.
 *
 * ONLY RAISED, NEVER LOWERED, and the restraint is the design. Shortening a
 * stall budget does not make a slow tool faster — it kills a tool that was
 * working, mid-run, and the agent loses whatever it was about to do with the
 * answer. Their five tiers were tuned against measured tool durations; we have
 * none yet, so lowering anything here would be
 * guessing with a live agent's run as the stake. When we can measure, the fast
 * tiers become a real question.
 *
 * Bounded by `RUN_TIMEOUT_MS` regardless: a tool starting at t=100s cannot
 * reach 150s of its own budget, and that is correct — the run's ceiling is the
 * ceiling. Their 2-hour tier is meaningless here for the same reason.
 *
 * Keyed on SERVER as well as tool, because `search` is both a WebVector tool
 * and a Robinhood symbol lookup, and only one of them is slow.
 */
const SLOW_TOOL_STALL_TIMEOUT_MS = 150_000
const SLOW_TOOLS: Record<string, ReadonlySet<string>> = {
  webvector: new Set(['research', 'fetch', 'search', 'markets'])
}
/** `mcp__<server>__<tool>` → how long silence inside it is allowed to last. */
export function toolStallBudget(name: string | null): number {
  if (!name) return TOOL_STALL_TIMEOUT_MS
  const parts = name.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp') return TOOL_STALL_TIMEOUT_MS
  return SLOW_TOOLS[parts[1]]?.has(parts.slice(2).join('__')) ? SLOW_TOOL_STALL_TIMEOUT_MS : TOOL_STALL_TIMEOUT_MS
}
/**
 * The same watchdog again, before the model has said ANYTHING.
 *
 * An attempt does not begin by talking to the model. It builds the tool list
 * first, and for remote MCP servers that means a real handshake per server —
 * `createMCPTools` connecting and calling `tools/list` over HTTP. None of that
 * emits, and none of it is a tool CALL, so the tool budget does not apply
 * either: the run looked like a model that had gone silent from the first
 * second.
 *
 * Without this, a slow MCP handshake looks like a stall: an attempt killed
 * 45 s in with zero tool calls, three attempts running, and the run goes red
 * before the agent ever gets as far as a decision.
 *
 * So: until the first delta of an attempt arrives we are waiting on I/O, not on
 * a model. After it, the short window applies again, which is the case the
 * short window was written for.
 */
const SETUP_TIMEOUT_MS = 120_000
const MAX_TURNS = 14
/** Symbols a run prices: one batched quote call; the technicals builder keeps the first eight, so ORDER is priority. */
export const SYMBOLS_MAX = 16
/** How long a BUY of a symbol the run did not pre-compute waits for that symbol's technicals (trail floor, extension cap). */
export const ON_DEMAND_TECHNICALS_MS = 8_000
/** An engine exit is post-mortemed once this much tape has passed since it (or the session has closed on it)… */
export const POST_MORTEM_AFTER_MS = 15 * 60_000
/** …and not at all once it is this old: the lesson has gone stale. */
export const POST_MORTEM_MAX_AGE_MS = 36 * 3_600_000
const POST_MORTEM_SEEN_CAP = 40
const TRANSCRIPT_LIMIT = 24
/** Reasoning kept on the run's thread message. The full chain, within reason: the thread shows it all, so a first page is not enough. */
const THINKING_KEEP_CHARS = 16_000
/**
 * Decision-log rows fetched for the refusals block. Generous, because the
 * store returns ALLOWED entries too and those dominate: one gated call that
 * succeeded is one row, so a busy day of legal trading can bury a handful of
 * refusals. The prompt filters to `blocked`, windows to 36h and collapses by
 * rule, so over-fetching here costs a read and never prompt space.
 */
const DECISION_LOOKBACK = 200
const MEMORY_CAP = 30


/** Symbols the agent cares about: guardrail allow-list + held positions + tickers mentioned in the task. */
/**
 * The symbols a run prices, in PRIORITY order — `buildSymbolContext` keeps the
 * first eight for technicals and `SYMBOLS_MAX` bounds the quote call. With the
 * allowlist first, a held name could fall off the end
 * of a long allowlist, and watches and today's sold names were not here at
 * all: the quiet gate could not skip a flat agent (an unpriced watch symbol
 * reads as "moved"), the prompt's "today" P&L counted a sale's proceeds as a
 * day's gain because the sold symbol had no mark, and a set_exit on a name
 * bought this session had no daily range to judge a trail against.
 */
export function symbolsOfInterest(cfg: AgentConfig, state: AgentState, todayEt: string): string[] {
  const set = new Set<string>()
  const ledger = cfg.mode === 'live' ? state.live : state.paper
  for (const p of ledger.positions) set.add(p.symbol)
  for (const o of ledger.openOrders) set.add(o.symbol)
  for (const w of state.watches) set.add(w.symbol.toUpperCase())
  // Today's fills, newest first — fills are append-ordered, so stop at the first that is not today.
  for (let i = ledger.fills.length - 1; i >= 0; i--) {
    const ms = Date.parse(ledger.fills[i].ts)
    if (!Number.isFinite(ms) || etClock(new Date(ms)).date !== todayEt) break
    set.add(ledger.fills[i].symbol)
  }
  for (const s of cfg.guardrails.allowedSymbols) set.add(s.toUpperCase())
  // Tickers in the task text: $MU, "MU", uppercase words 1–5 chars that look like tickers.
  // Every ACTIVE task, not `cfg.task` — that field is only the goal the agent
  // was created with, so an agent whose operator confirmed a second task was
  // told to serve it on every run while being handed no quotes, no technicals
  // and no earnings dates for anything it named.
  const corpus = activeTasks(cfg)
    .map((t) => t.text)
    .join(' \n ')
  for (const m of corpus.matchAll(/\$([A-Za-z]{1,5})\b/g)) set.add(m[1].toUpperCase())
  for (const m of corpus.matchAll(/\b([A-Z]{2,5})\b/g)) {
    const w = m[1]
    if (!['ET', 'AM', 'PM', 'USD', 'ETF', 'EST', 'EDT', 'GTC', 'DAY', 'BUY', 'SELL', 'ALL', 'THE', 'AND', 'FOR', 'AT', 'TO', 'OF', 'IN', 'ON', 'RSI', 'EMA', 'SMA', 'VWAP', 'MACD'].includes(w)) set.add(w)
  }
  return [...set].slice(0, SYMBOLS_MAX)
}

/**
 * One run of an agent: build context → one model run through the agent's
 * vendor (Claude or OpenRouter) → tools execute live → persist messages/state/
 * run record → compute next run. Host-agnostic and vendor-agnostic.
 */
export async function runOnce(deps: RuntimeDeps, req: RunRequest): Promise<RunOutcome> {
  const runId = newId('run_')
  const startedAt = new Date()
  const now = deps.now ?? (() => new Date())
  const log = deps.log
  const cfg = await deps.storage.getConfig(req.agentId)
  let state = await deps.storage.getState(req.agentId)
  if (!cfg || !state) throw new Error(`agent ${req.agentId} not found`)
  /** When the previous run ended — what "a sell since the last run" is measured from (outcome scoring, below). */
  const prevLastRunAt = state.lastRunAt

  // Every delta also resets the stall watchdog: activity is what proves a run is alive.
  let lastActivityAt = Date.now()
  /** When the tool currently running started; older than `lastActivityAt` means none is. */
  let toolPendingSince = 0
  let pendingToolName = ''
  /**
   * The model loop is over — by finishing, by the deadline, or by the operator's
   * Stop. After this instant nothing the vendor still has in flight may act:
   * the OpenRouter SDK runs its own loop and does not stop an in-progress
   * response when the run signal fires, so a run aborted at the ceiling can
   * keep streaming for minutes and then present tool calls (a retirement, an
   * errand, a memory note, a thesis). Those would not be executed, but only
   * because the SDK checks the signal first; nothing on OUR
   * side would have refused them, and a `trade` landing after the state was
   * settled would have been written into a run that had already ended. The
   * gate and the host below refuse, and the emitter goes quiet, once this is set.
   */
  let runEnded = false
  const emit = (delta: Parameters<RuntimeDeps['emit']>[2]): void => {
    if (runEnded && delta.kind !== 'end') return
    lastActivityAt = Date.now()
    deps.emit(cfg.id, runId, delta)
  }
  emit({ kind: 'start', trigger: req.trigger })
  // ── The run's trace (core/trace/types.ts) ────────────────────────────────
  // The host's sink (if it supplies one) describes this run to its backend:
  // prompts, every model step, every tool call, every decision, the outcome.
  // Every call is wrapped — a tracing failure logs and the run goes on, because
  // the run is real money and the trace is not.
  const trace: RunTrace | null = (() => {
    try {
      return (
        deps.trace?.start({
          runId,
          agentId: cfg.id,
          agentName: cfg.name,
          trigger: req.trigger,
          userText: req.userText,
          mode: cfg.mode,
          vendor: cfg.model.vendor,
          model: cfg.model.id,
          effort: cfg.model.effort,
          autonomous: isAutonomous(cfg),
          liveArmed: Boolean(cfg.liveArmedAt),
          schedule: describeSchedule(cfg.schedule),
          build: deps.build,
          startedAt: startedAt.toISOString()
        }) ?? null
      )
    } catch (err) {
      log('warn', `trace start failed: ${(err as Error).message}`)
      return null
    }
  })()
  const traced = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      log('warn', `trace ${what} failed: ${(err as Error).message}`)
    }
  }
  /** Settle the trace. Fire-and-forget here; the host decides whether to wait for the send. */
  const endTrace = (o: Parameters<RunTrace['end']>[0]): void => {
    if (!trace) return
    try {
      void trace.end(o).catch((err: Error) => log('warn', `trace end failed: ${err.message}`))
    } catch (err) {
      log('warn', `trace end failed: ${(err as Error).message}`)
    }
  }
  /** A run that ended before the model was called, and why. */
  const endEarly = (skipReason: string): void => endTrace({ ok: true, skipped: true, skipReason, durationMs: now().getTime() - startedAt.getTime() })
  /** Which tool call was allowed or blocked, by which rule (shared/decisions.ts) — and the trace sees every one. */
  const audit = decisionRecorder({ agentId: cfg.id, runId, trigger: req.trigger, now }, (rec) => {
    deps.audit?.(rec)
    if (trace) traced('decision', () => trace.decision(rec))
  })

  // ── Check-in resolution (the ONE place a question gets answered) ──────────
  // reply  → the newest open question is answered by the operator's words, even
  //          past its deadline: if the timeout has not EXECUTED yet, the human wins.
  // timeout→ the oldest EXPIRED open question is answered by its own fallback;
  //          nothing expired (the operator got there first) → a free no-op.
  const attended = isAttended(req.trigger)
  const recent60 = await deps.storage.recentMessages(cfg.id, 60)
  const openQuestions = recent60.filter(isOpenQuestion)
  let timeoutQuestion: QuestionMessage | undefined

  // ── Messages that arrived behind the one this run answers ────────────────
  // A reply run answers ONE operator turn: the message(s) in `userText`.
  // Anything the operator sent after that — in the seconds between pressing
  // send and this run starting, when no client could yet know which run it
  // would wait behind — is stamped `queuedBehind: this run` here, at the one
  // moment that is knowable, and kept OUT of this run's transcript: each gets
  // its own turn, oldest first (the hosts drain one waiting request per run),
  // and the thread places it under this run's reply (shared/messageQueue.ts).
  // Before this, the second of two quick questions was answered by both runs
  // and drawn above the first answer. Question, answer, question, answer —
  // for any number of them.
  const queuedAfter = new Set<string>()
  if (req.trigger === 'reply' && req.userText?.trim()) {
    const segments = req.userText.split('\n').map((s) => s.trim()).filter(Boolean)
    const lastSegment = segments[segments.length - 1]
    const users = recent60.filter((m): m is Extract<Message, { role: 'user' }> => m.role === 'user')
    const trigger = [...users].reverse().find((m) => m.text.trim() === lastSegment)
    if (trigger) {
      for (const m of users) {
        if (m.id === trigger.id || m.ts <= trigger.ts) continue
        queuedAfter.add(m.id)
        if (m.queuedBehind !== runId) await deps.storage.updateMessage({ ...m, queuedBehind: runId })
      }
    }
  }
  if (req.trigger === 'reply' && req.userText?.trim()) {
    // SUPERSEDED, not answered. We cannot tell whether the operator's message is
    // a reply to the card, and assuming it is has a real cost: an unrelated
    // "what's my P&L?" used to cancel the promised fallback AND come back to the
    // agent as `OPERATOR ANSWERED: what's my P&L?`, which reads as an
    // instruction. Closing it without claiming it was answered keeps the
    // fallback from firing on a message nobody aimed at it, and the agent still
    // has their actual words at the top of this very prompt — so a message that
    // DOES answer the question is acted on regardless. The approval path
    // already settled this the same way ('withdrawn'); this is the question
    // side catching up.
    const q = openQuestions[openQuestions.length - 1]
    if (q) await deps.storage.updateMessage({ ...q, answeredBy: req.userText.trim(), answeredVia: 'superseded', answeredAt: now().toISOString() })
  } else {
    // ANY run settles an overdue question, not only a dedicated `timeout` one.
    //
    // The fallback used to depend on a single wake-up arriving; if that one
    // wake-up is lost, an agent can sit an hour past its own deadline, run ten
    // more times on schedule, and never do the thing it had promised. Each of
    // those ten runs could have settled it.
    //
    // The deadline is the promise; which wake-up happens to notice it is an
    // implementation detail, and making the promise depend on that detail is what
    // broke it. The `timeout` trigger is now a BACKSTOP that guarantees a run
    // happens when nothing else would — not the only path that can act.
    //
    // `reply` is handled above and still wins outright: while the fallback has
    // not been applied, a human answering beats the default.
    const expired = openQuestions.find((q) => questionExpired(q, now()))
    if (expired) {
      // Re-read before writing. `updateMessage` overwrites the whole row, so if
      // the operator answered between our transcript read and this line we would
      // clobber their answer with the default they were trying to pre-empt —
      // and the design is explicit that a human beats the fallback right up to
      // the moment it executes.
      //
      // The window is small (the per-agent lock keeps runs from overlapping) but
      // it is not empty: an answer arrives as a client message insert, which no
      // lock covers. This guard mattered less when only a rare `timeout` run
      // could apply the fallback; now that any run can, the race got commoner
      // and the cost of losing it is someone's explicit instruction.
      const fresh = (await deps.storage.recentMessages(cfg.id, 60)).find((m) => m.id === expired.id)
      if (fresh && isOpenQuestion(fresh) && questionExpired(fresh, now())) {
        timeoutQuestion = { ...fresh, answeredBy: fresh.fallback ?? 'the fallback I proposed', answeredVia: 'timeout', answeredAt: now().toISOString() }
        await deps.storage.updateMessage(timeoutQuestion)
        if (req.trigger !== 'timeout') log('info', `settled an overdue question on a ${req.trigger} run (${cfg.id})`)
      } else {
        log('info', `overdue question was answered while this run started — leaving it (${cfg.id})`)
      }
    } else if (req.trigger === 'timeout' && !retirementDue(cfg, state, [], now())) {
      // Nothing expired: the operator got there first. Free no-op, as before —
      // and still a no-op rather than a run, so it costs nothing. A `timeout`
      // wake-up is ALSO how the engine delivers a retirement deadline,
      // so one with a deadline due falls through to the retirement check below.
      log('info', `timeout run with nothing expired — no-op (${cfg.id})`)
      endEarly('timeout wake-up with nothing expired')
      emit({ kind: 'end', ok: true })
      return { runId, ok: true, actions: 0, state }
    }
  }
  // Unattended check-in budget (ET day): a run nobody started may only interrupt so often.
  const todayEt = etClock(now()).date
  if (state.checkIns.date !== todayEt) state = { ...state, checkIns: { date: todayEt, questions: 0, tells: 0 } }
  const checkInsLeft = (): { questions: number; tells: number } => ({
    questions: Math.max(0, UNATTENDED_QUESTIONS_PER_DAY - state!.checkIns.questions),
    tells: Math.max(0, UNATTENDED_TELLS_PER_DAY - state!.checkIns.tells)
  })
  let toldThisRun = false
  /** The structured end-of-run summary, if the model filed one — attached to the run's final message. */
  let pendingReport: AgentReport | null = null
  /** Whether `sleep_until` was called this run (set OR cancel) — see core/runner/sleepClaim.ts. */
  let sleepTouched = false

  const post = async (m: NewMessage): Promise<Message> => {
    const full = { id: newId('m_'), agentId: cfg.id, ts: m.ts ?? now().toISOString(), runId, ...m } as Message
    await deps.storage.appendMessage(full)
    state = { ...state!, lastMessageAt: full.ts, lastMessagePreview: previewOf(full), unread: full.role === 'user' ? state!.unread : state!.unread + 1 }
    return full
  }
  const saveState = async (): Promise<void> => {
    await deps.storage.saveState(cfg.id, state!)
  }
  /** The one way host tools mutate agent state: merge + persist. */
  const patch = async (p: Partial<AgentState>): Promise<void> => {
    state = { ...state!, ...p }
    await saveState()
  }

  // ── Sleep (`sleep_until`) ────────────────────────────────────────────────
  // The wake-up that ends a sleep is any run at or after `until`: the moment
  // has come, so the agent is awake whatever started this run. A run that
  // arrives EARLIER — the operator's message, a fired watch, a question deadline
  // — leaves the sleep in place: the agent answers and goes back to sleep unless
  // it cancels. A `schedule` wake-up while asleep is a stale one (a task minted
  // before the sleep was set, a timer that fired early): a free no-op, because
  // running it would be exactly the tick-and-check the agent slept to avoid.
  if (state.sleep) {
    const sleep = state.sleep
    if (!activeSleep(state, now())) {
      state = { ...state, sleep: undefined }
      await saveState()
      await post({ role: 'system', kind: 'schedule', text: LIFECYCLE.awake(sleep.reason) })
    } else if (req.trigger === 'schedule') {
      log('info', `schedule wake-up while asleep until ${sleep.until} — no-op (${cfg.id})`)
      endEarly(`asleep until ${sleep.until}`)
      emit({ kind: 'end', ok: true })
      return { runId, ok: true, actions: 0, state }
    }
  }

  // ── Held actions (agents that are not autonomous) ────────────────────────
  // A stall ends here, one way or the other:
  //   approved → carried into this run as a ONE-TIME pass, and the agent is
  //              shown the elapsed time and today's price so it re-decides
  //              rather than replaying a decision the market has moved past.
  //   a reply  → withdrawn. The operator moved the conversation on instead of
  //              answering the card, so the request is stale; the agent is free
  //              to ask again against what is true now.
  // A decline is settled by the host before the agent is ever woken.
  //
  // LOAD-BEARING: the pass keys on the STAMP (`approvedAt`), never on
  // `req.trigger === 'approval'`. Clients may mint an `approval` run request —
  // that is why widening `ClientTrigger` was safe — and it is only safe because
  // a run with that trigger and no stamped request holds every write tool
  // exactly as a `manual` one would. Trusting the trigger here would turn a
  // client-writable field into permission to trade.
  const autonomous = isAutonomous(cfg)
  let approved: PendingAction | null = null
  let approvalUsed = false
  const heldNow = state.pendingAction ?? null
  const approvalCard = (id: string): ApprovalMessage | undefined => recent60.find((m): m is ApprovalMessage => m.role === 'approval' && m.action.id === id)
  if (heldNow && autonomous) {
    // The operator flipped the agent to fully autonomous with a card still
    // open (or approved). The hold's whole purpose was to route the decision
    // through them; it is moot now, and left in place it would be re-presented
    // and re-declined on every run for days.
    const card = approvalCard(heldNow.id)
    if (card) await deps.storage.updateMessage({ ...card, status: 'withdrawn', answeredAt: now().toISOString(), outcome: approvalMootOutcome() })
    await post({ role: 'system', kind: 'info', text: approvalMootNote(heldNow.summary) })
    await patch({ pendingAction: null })
  } else if (heldNow?.approvedAt) {
    if (approvalExpired(heldNow, now())) {
      // A yes from three days ago is not a yes about today's prices. The card
      // says what happened, the thread says it out loud, and if the operator
      // still wants it they ask and get a FRESH card.
      const card = approvalCard(heldNow.id)
      if (card) await deps.storage.updateMessage({ ...card, status: 'withdrawn', answeredAt: now().toISOString(), outcome: approvalExpiredOutcome() })
      await post({ role: 'system', kind: 'info', text: approvalExpiredNote(heldNow.summary) })
      await patch({ pendingAction: null })
    } else {
      approved = heldNow
      // DELIBERATELY NOT CLEARED. The pass used to be wiped from state here and
      // live only in this run — so an approval granted after the close was
      // reviewed by a run that could not trade, and the operator's yes
      // evaporated. A sell approved on Wednesday was re-proposed, re-approved,
      // and still unexecuted the following Monday. The pass now survives in
      // `state.pendingAction` until it is spent by a SUCCESSFUL execution
      // (`host.trade`), superseded by a different request (`holdForApproval`),
      // withdrawn by an operator reply below, or expires above. Autonomous
      // wake-ups are not stalled by an approved pass — the engine already
      // gates on `!approvedAt`.
    }
  } else if (heldNow && req.trigger === 'reply') {
    const card = approvalCard(heldNow.id)
    if (card) await deps.storage.updateMessage({ ...card, status: 'withdrawn', answeredAt: now().toISOString(), outcome: 'Withdrawn — you sent a new message, so the agent is deciding again.' })
    await patch({ pendingAction: null })
  }

  // ── Robinhood client (token refreshed by the host) ──────────────────────
  const rhClient = await createRobinhoodClient(deps.creds)
  const rh: RobinhoodMcpClient | null = rhClient?.rh ?? null
  const bearer: string | null = rhClient?.accessToken ?? null
  // ── Prices ──────────────────────────────────────────────────────────────
  // Robinhood when the operator has it; their market-data key for a PAPER
  // agent without one; nothing otherwise. One decision, made here, that the quote
  // fetch, the technicals, the watch baseline, the trade reference price and
  // the paper fill all inherit — so "where do prices come from" is never
  // re-decided at a call site. `shared/marketData.ts` is the rule.
  const platform = cfg.mode === 'paper' ? ((await deps.marketFeed?.().catch(() => null)) ?? null) : null
  const feed: PriceFeed | null = pickFeed(cfg.mode, rh, platform)
  if (feed && !rh) log('info', `pricing from the market-data feed (${cfg.id})`)

  // ── Context ─────────────────────────────────────────────────────────────
  let accountNumber: string | null = null
  let account: MarketContext['account'] = null
  let quotes: Quote[] = []
  let quotesFailed: string[] = []
  let accountError: string | undefined
  const syms = symbolsOfInterest(cfg, state, etClock(now()).date)
  // Account resolution (Robinhood only) and quotes (any feed) are independent —
  // fetch concurrently.
  const [, priced] = await Promise.all([
    (async () => {
      if (!rh) return
      try {
        const accts = await getAccounts(rh)
        const acct = accts.find((a) => a.agenticAllowed) ?? accts[0]
        accountNumber = acct?.accountNumber ?? null
        if (accountNumber) {
          const p = await getPortfolio(rh, accountNumber)
          account = { buyingPower: p.buyingPower, cash: p.cash, equity: p.totalValue, type: acct?.type, unsettledFunds: acct?.unsettledFunds }
        }
      } catch (err) {
        // Distinguished from "not connected" downstream: telling a LIVE agent
        // it is paper-only because one call timed out is worse than silence.
        accountError = (err as Error).message
        log('warn', `account context failed: ${accountError}`)
      }
    })(),
    feed && syms.length
      ? feed.quotes(syms).catch((err) => {
          log('warn', `quotes failed: ${(err as Error).message}`)
          return { quotes: [] as Quote[], failed: syms }
        })
      : Promise.resolve({ quotes: [] as Quote[], failed: [] as string[] })
  ])
  quotes = priced.quotes
  quotesFailed = priced.failed
  if (quotesFailed.length) log('warn', `no quote for: ${quotesFailed.join(', ')}`)

  // Settle paper limit orders / reconcile live open orders with fresh quotes.
  /**
   * A fill that landed between runs (a resting limit, or a live order that
   * settled later). It gets the same card as an immediate fill — `before` is the
   * book as it stood ahead of these fills, so the economics are the ones that
   * were true at the fill, not after everything since.
   */
  /** What this tick found before the model would be called — the fast path's evidence. */
  const signals: TickSignals = {
    watchFired: false,
    exitMoved: false,
    orderSettled: false,
    operatorMessage: recent60.some((m) => m.role === 'user' && (!state!.lastRunAt || m.ts > state!.lastRunAt!)),
    errandReady: false,
    firstTickOfDay: false,
    priceMoved: false,
    buyLocked: false,
    approvalPending: Boolean(state.pendingAction),
    respawned: Boolean(state.respawnedAt),
    firstRun: state.runCount === 0,
    selfReview: state.runCount > 0 && state.runCount % 25 === 0,
    // Settled above: the question's fallback was just marked applied, and the
    // model is the only thing that can actually DO it. Without this an interval
    // tick after the deadline recorded the fallback as done and skipped the run.
    questionTimedOut: Boolean(timeoutQuestion)
  }
  const postFills = async (fills: Fill[], reason: string, before: Ledger, after: Ledger): Promise<void> => {
    let book = before
    for (const f of fills) {
      const { ledger: next } = applyFill(book, { symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, orderId: f.orderId, ts: f.ts })
      await post({
        role: 'action',
        action: { side: f.side, symbol: f.symbol, qty: f.qty, type: 'limit', limitPrice: f.price, tif: 'day', reason, mode: cfg.mode, status: 'filled', fillPrice: f.price, fillQty: f.qty, orderId: f.orderId, econ: fillEconomics(book, next, f) }
      })
      book = next
    }
    void after
  }
  if (cfg.mode === 'paper' && state.paper.openOrders.length) {
    const r = settlePaperOpenOrders(state.paper, toPaperQuotes(quotes), now())
    if (r.fills.length || r.dropped.length) {
      signals.orderSettled = true
      const before = state.paper
      state = { ...state, paper: r.ledger }
      // A resting buy carried its stop/target on the order; now that it has
      // filled there is finally a position to protect, so arm them. The live
      // path does this inside reconcileLiveOpenOrders — only paper settles
      // against a bare Ledger, and the exits live on the state above it.
      if (r.fills.length) {
        state = applyExitsForFills(state, 'paper', r.settled, now())
        await postFills(r.fills, 'Resting limit order filled', before, r.ledger)
      }
      // Said out loud, because the model otherwise keeps believing it holds a
      // working order: 'day' orders expire on a later ET date, and a limit with
      // no price (possible before `limit.missingPrice` shipped) can never fill.
      for (const o of r.dropped) {
        const why = o.type === 'limit' && !(o.limitPrice && o.limitPrice > 0) ? 'it has no limit price and can never fill' : 'it was a DAY order and its day is over'
        await post({ role: 'system', kind: 'info', text: `🗑 Cancelled resting order ${o.id} (${o.side} ${o.qty} ${o.symbol}${o.limitPrice ? ` @ $${o.limitPrice}` : ''}) — ${why}. Place it again if it is still wanted.` })
      }
      await saveState()
    }
  }
  if (cfg.mode === 'live' && rh && accountNumber) {
    const r = await reconcileLiveOpenOrders({ config: cfg, state, rh, feed, accountNumber, quotes })
    if (r.fills.length) {
      signals.orderSettled = true
      const before = state.live
      state = r.state
      await postFills(r.fills, 'Open order filled', before, r.state.live)
    }
  }

  // Fire price watches at tick time (the engine's watcher additionally checks
  // every ~15s between runs).
  if (state.watches.length && quotes.length) {
    const fw = fireWatches(state, quotes)
    if (fw.fired.length) {
      signals.watchFired = true
      state = fw.state
      traced('watch', () => trace?.event('watch_fired', { watches: fw.fired.map((f) => f.description) }))
      for (const f of fw.fired) await post({ role: 'system', kind: 'info', text: `${WATCH_FIRED_PREFIX}${f.description}` })
      await saveState()
    }
  }
  // Enforce stop/target exit plans (regular session only — protective market sells).
  if (Object.keys(state.exits).length && isRegularSession(now()) && rh) {
    const ex = await enforceExits({ config: cfg, state, rh, feed, accountNumber, quotes, now: now(), audit })
    // Persist whenever ANYTHING changed — a trail ratchet, a break-even stop,
    // a plan dropped from a closed position — not only when something sold;
    // the run-start sweep used to throw those away and only the between-runs
    // sweeps kept them. A moved level is also a busy tick for the fast path.
    if (ex.state !== state) {
      signals.exitMoved = true
      state = ex.state
      traced('exits', () => trace?.event('exits_enforced', { results: ex.results.map((r) => ({ symbol: r.action.symbol, side: r.action.side, status: r.action.status, trigger: r.action.exitTrigger?.kind, error: r.action.error })) }))
      for (const r of ex.results) await post({ role: 'action', action: r.action })
      await saveState()
    }
  }

  // Daily loss circuit breaker: anchor equity at the first tick of each ET day;
  // if today's drawdown exceeds the guardrail, lock BUYS for the rest of the day
  // (sells and protective exits keep working — never trap a position).
  // A flat book needs no quote to be anchored (equity = cash): an agent with no
  // allowlist and nothing held priced nothing, so its day never began — no
  // anchor, no `firstTickOfDay`, and its first look of the day could be
  // skipped as quiet.
  const ledger0 = ledgerFor(cfg, state)
  if (quotes.length || ledger0.positions.length === 0) {
    const { equity } = markToMarket(ledger0, toPaperQuotes(quotes))
    const today = etClock(now()).date
    if (!state.dayAnchor || state.dayAnchor.date !== today) {
      signals.firstTickOfDay = true
      state = { ...state, dayAnchor: { date: today, equity } }
      await saveState()
    } else {
      // The SAME rule the exit sweep applies between runs (`dailyLossLock`),
      // so the two cannot disagree about what "down 5% today" means. A lock the
      // sweep set since the last run arrives as `buyLockNotice` — `dailyLossLock`
      // returns null for it (today's `buyLockDate` is already set), so the note
      // and the busy signal come from the notice instead. Either way the thread
      // is told ONCE and the fast path sees it, whichever path set the lock.
      const lock = dailyLossLock(cfg, state, quotes, now()) ?? (state.buyLockNotice?.date === today ? state.buyLockNotice : null)
      if (lock) {
        signals.buyLocked = true
        state = { ...state, buyLockDate: lock.date, buyLockNotice: null }
        await post({ role: 'system', kind: 'error', text: dailyLossLockNote(lock.lossPct) })
        await saveState()
      } else if (state.buyLockNotice) {
        // A notice from an earlier day: its lock has expired with the day, and so has the news.
        state = { ...state, buyLockNotice: null }
      }
    }
    void equity
  }

  // Self-retirement: when a policy condition is already met, retire instead of
  // running (flatten per policy, keep exit plans on anything that remains).
  const dueReason = retirementDue(cfg, state, quotes, now())
  if (dueReason) {
    const ret = await executeRetirement({ config: cfg, state, rh, feed, accountNumber, quotes, now: now(), audit }, dueReason, now())
    state = ret.state
    for (const r of ret.results) await post({ role: 'action', action: r.action })
    if (!ret.retired) {
      // Not retired: the book could not be flattened. Said out loud — as an
      // important note the first time today, quietly on a repeat (the operator
      // was already rung once for this stretch) — exits kept armed, the retry
      // instant stamped on the state, and the run ENDS here: there is nothing
      // for the model to decide about a retirement the engine owes.
      await post({ role: 'system', kind: 'error', ...(ret.repeat ? {} : { notify: 'important' as const }), text: cannotFlattenNote(dueReason, ret.open ?? []) })
      state = { ...state, running: false, lastRunAt: now().toISOString() }
      await saveState()
      endEarly(`retirement due (${dueReason}) but the book could not be flattened`)
      emit({ kind: 'end', ok: true })
      log('warn', `retirement due but could not flatten — kept alive (${cfg.id})`)
      return { runId, ok: true, actions: ret.results.filter((r) => r.action.status === 'filled' || r.action.status === 'open').length, state }
    }
    await post({ role: 'system', kind: 'retired', text: `🏁 Retired: ${dueReason}.${ret.note ? ` ${ret.note}` : ''}` })
    await saveState()
    endEarly(`retired: ${dueReason}`)
    emit({ kind: 'end', ok: true })
    log('info', `agent retired — ${dueReason} (${cfg.id})`)
    return { runId, ok: true, actions: ret.results.length, state }
  }

  /**
   * A wake-up that ends here without the model: a skipped run row (so a quiet
   * week is a query, not a guess), the schedule re-armed, the trace closed.
   * Shared by the quiet-tick fast path and the all-in earnings gate.
   */
  const skipTick = async (skipReason: string): Promise<RunOutcome> => {
    const endedAt = now()
    const next = nextWakeAt(cfg, state!, endedAt)
    await deps.storage
      .appendRun({
        id: runId,
        agentId: cfg.id,
        trigger: req.trigger,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        ok: true,
        skipped: true,
        skipReason,
        ...(trace ? { traceId: trace.id } : {}),
        // `vendor:model`, matching the settled path below, so a skipped tick is
        // filed under the model that would have served it.
        model: `${cfg.model.vendor}:${cfg.model.vendor === 'openrouter' ? openRouterModelFor(cfg.model.id) : cfg.model.id}`,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        actions: 0,
        durationMs: endedAt.getTime() - startedAt.getTime()
      })
      // The tick still settles — but a run record that failed to land is a run
      // the history and the stats never see, so it is said at error level, never swallowed.
      .catch((err: Error) => log('error', `run record not stored for skipped run ${runId} (${cfg.id}): ${err.message}`))
    state = { ...state!, running: false, lastRunAt: endedAt.toISOString(), nextRunAt: next ? next.toISOString() : null, status: next ? 'scheduled' : 'idle' }
    await saveState()
    endEarly(skipReason)
    emit({ kind: 'end', ok: true })
    log('info', `tick skipped — ${skipReason} (${cfg.id})`)
    return { runId, ok: true, actions: 0, state: state! }
  }

  // ── All-in earnings mode: when does it run again? ────────────────────────
  // Scheduled wake-ups only; the operator always reaches the model. Holding →
  // run; sold this morning and not yet reviewed → run; proceeds still settling
  // in a cash account → sleep until they have (nothing can be bought all-in
  // before then, so every tick in between would be a model call that can only
  // say "not yet"); before the hunt with nothing to review → skip.
  if (isEarningsPop(cfg) && req.trigger === 'schedule') {
    // Read through a widened alias: TS cannot see the assignment inside the Promise.all closure above.
    const acctNow = account as MarketContext['account']
    const settlement = settlementModeFor(cfg, cfg.mode === 'live' ? acctNow?.type : null)
    const g = earningsPopGate({ ledger: ledgerFor(cfg, state), lastRunAt: prevLastRunAt, settlement, now: now(), money })
    if (g.kind === 'sleep') {
      state = { ...state, sleep: { until: g.until.toISOString(), reason: g.reason, setAt: now().toISOString() } }
      await post({ role: 'system', kind: 'schedule', text: LIFECYCLE.sleeping(g.until.toISOString(), g.reason) })
      return await skipTick(`all-in earnings mode: settling until ${g.until.toISOString()}`)
    }
    if (g.kind === 'skip') return await skipTick(g.reason)
    log('info', `all-in earnings tick runs the model — ${g.why} (${cfg.id})`)
  }

  // The no-model fast path. Interval ticks only — a `times` wake-up
  // is a deliberate appointment and never skips — and only when EVERY signal
  // the engine established above is absent: nothing fired, nothing moved,
  // nothing settled, nobody wrote, nothing is owed. The signals are explicit
  // and the default is to run; `quietTickReason` names what was absent on the
  // run row so a quiet week is a query, not a guess. The old gate required a
  // FLAT book and so never fired on the ticks that cost the most: an agent
  // holding an unchanged position re-reading it every fifteen minutes.
  if (req.trigger === 'schedule' && cfg.schedule.kind === 'interval') {
    // A ready errand is work outstanding, so the tick is not quiet. The
    // canonical errand — "set the 5% watch when the market opens" — is filed by
    // an agent that by construction holds nothing and watches nothing, so
    // without this the tick it was waiting for is exactly the tick that gets
    // skipped, and it can be dropped as stale seven days later having never run.
    const marketOpenNow = isRegularSession(now()) || isExtendedSession(now())
    signals.errandReady = (state.errands ?? []).some((e) => errandReady(e, marketOpenNow))
    signals.priceMoved = priceMoved(quotes, state.lastRunQuotes)
    const skipReason = quietTickReason(signals)
    if (!skipReason) log('info', `tick runs the model — ${busySignals(signals).join(', ')} (${cfg.id})`)
    if (skipReason) return await skipTick(skipReason)
  }

  // Computed technicals / earnings / tradability (deterministic, injected as
  // fact). Built AFTER the triage/retirement gates so quiet ticks never pay
  // for the ~4 Robinhood calls involved.
  let analysis = ''
  /** Kept as data, not only as the rendered block: the trail floor reads a symbol's daily range from it. */
  let symbolCtx: SymbolContext | null = null
  if (feed && syms.length) {
    try {
      symbolCtx = await buildSymbolContext(feed, rh, accountNumber, syms, quotes, (l, m) => log(l, m))
      analysis = analysisBlock(symbolCtx)
    } catch (err) {
      log('warn', `symbol context failed: ${(err as Error).message}`)
    }
  }

  // Operator tool policy: Robinhood tools switched off globally + the intel MCP
  // servers switched on (keys/runtimes come from the host).
  const access = (await deps.tools?.().catch(() => null)) ?? DEFAULT_TOOL_ACCESS
  // The account-wide halt, read ONCE per run rather than per order: it is one
  // operator's switch, it cannot change mid-run in any way we would want to act
  // on halfway through, and re-reading it per tool call would put a network hop
  // in front of every trade. A failed read is `false` — see
  // `GuardrailInput.tradingHalted` for why this fails open.
  const tradingHalted = (await deps.accountControls?.().catch(() => null))?.tradingHalted ?? false
  if (tradingHalted && cfg.mode === 'live') log('info', 'account trading halt is on — live buys will be refused', { agentId: cfg.id })
  const intel = resolveIntelServers(access)
  for (const s of intel.skipped) log('warn', `intel source ${s.id} skipped — ${s.reason}`)

  // Minus the operator messages queued behind this turn — they are the NEXT run's to answer.
  const recent = (await deps.storage.recentMessages(cfg.id, TRANSCRIPT_LIMIT)).filter((m) => !queuedAfter.has(m.id))
  // What the engine refused last time — the one thing the agent cannot
  // reconstruct from its own state, because a blocked call leaves no fill, no
  // position and no thread message. Swallowed on failure ON PURPOSE and this is
  // the rare place that is right: the block is advisory, so a decision store
  // that is down should cost the agent a hint, not the run. Logged so the
  // silence is still visible to us.
  const recentDecisions = await (deps.recentDecisions?.(cfg.id, DECISION_LOOKBACK) ?? Promise.resolve([])).catch((err) => {
    log('warn', 'could not read the decision log for the refusals block', { agentId: cfg.id, err: describeError(err) })
    return [] as DecisionRecord[]
  })
  // Errands are debts, and a debt nobody paid in a week was not going to be
  // paid. Dropping them here keeps the list something the agent reads as work to
  // do, rather than an ever-growing wall it learns to skim past.
  const stale = (state.errands ?? []).filter((e) => errandStale(e, now().getTime()))
  if (stale.length) {
    state = { ...state, errands: (state.errands ?? []).filter((e) => !errandStale(e, now().getTime())) }
    await saveState()
    for (const e of stale) await post({ role: 'system', kind: 'info', text: `🗑 Dropped a stale errand (${Math.round((now().getTime() - Date.parse(e.addedAt)) / 86_400_000)} days old, never done): ${e.note}` })
  }

  const market: MarketContext = { quotes, quotesFailed, account, accountError, session: sessionLabel(now()), etNow: formatEt(now()), analysis, brokerConnected: rh !== null, priceSource: feed?.id ?? 'none' }
  const ordersToday = ordersTodayCount(state, now())
  // Robinhood tool context: reads per policy; writes only when the policy enables
  // them AND this agent is live + armed (paper agents never reach a mutating tool).
  const rhCtx: RobinhoodToolContext = { policy: access.policy, liveArmed: cfg.mode === 'live' && Boolean(cfg.liveArmedAt) }
  const systemPrompt = composeSystemPrompt(cfg, intel.promptLines, robinhoodWriteToolsFor(rhCtx))
  // Composed here, not at resolution time: the "and it is $X now" half of the
  // note needs the quotes this run just fetched.
  const approvalNote = approved
    ? approvalReviewNote(approved, approved.symbol ? quotes.find((q) => q.symbol === approved!.symbol)?.last : undefined, now())
    : state.pendingAction
      ? `STILL WAITING ON THE OPERATOR: "${state.pendingAction.summary}". You cannot act on it until they answer the card — do not try again, and do not reach for another way to do the same thing. Anything else your task needs is still open to you.`
      : undefined
  // Post-mortem on engine exits: entry reason → exit reason → the
  // tape after, from 5-minute bars. An exit is shown once it has
  // POST_MORTEM_AFTER_MS of tape behind it or the session closed on it: the
  // run the sale itself woke arrived thirty seconds later with nothing to
  // report and consumed it, so most exits were never post-mortemed. `state.postMortemSeen` makes it exactly once, and
  // the FEED serves the bars so paper agents on the market-data feed get one too
  // (it needed a broker before). Skipped silently when bars are unavailable;
  // an advisory block must never cost the run.
  let postMortem = ''
  if (feed) {
    const ledgerPm = ledgerFor(cfg, state)
    const seen = new Set(state.postMortemSeen ?? [])
    const nowMs = now().getTime()
    const todayPm = etClock(now()).date
    const ripe = (f: Fill): boolean => nowMs - Date.parse(f.ts) >= POST_MORTEM_AFTER_MS || etClock(new Date(Date.parse(f.ts))).date !== todayPm
    const exits = ledgerPm.fills
      .filter((f) => f.side === 'sell' && f.engineExit && !seen.has(f.id) && nowMs - Date.parse(f.ts) <= POST_MORTEM_MAX_AGE_MS && ripe(f))
      .slice(-6)
    if (exits.length) {
      try {
        const earliest = exits.reduce((a, f) => Math.min(a, Date.parse(f.ts)), Infinity)
        const bars = await feed.bars([...new Set(exits.map((f) => f.symbol))], new Date(earliest).toISOString(), '5minute')
        const items = exits.map((f) => {
          const t0 = Date.parse(f.ts)
          const window = (bars[f.symbol] ?? []).filter((b) => b.t * 1000 >= t0 && b.t * 1000 <= t0 + 60 * 60_000)
          const entry = [...ledgerPm.fills].reverse().find((b) => b.symbol === f.symbol && b.side === 'buy' && Date.parse(b.ts) <= t0)
          return {
            symbol: f.symbol,
            exitTs: f.ts,
            exitPrice: f.price,
            kind: f.engineExit === 'trail' ? 'trailing stop' : f.engineExit === 'stop' ? 'stop' : f.engineExit === 'target' ? 'target' : f.engineExit === 'invalidation' ? 'invalidation' : 'flatten',
            entryReason: entry?.reason,
            exitReason: f.reason,
            ...(window.length ? { after: { high: Math.max(...window.map((b) => b.h)), low: Math.min(...window.map((b) => b.l)), close: window[window.length - 1].c, minutes: Math.round(((window[window.length - 1].t * 1000 - t0) / 60_000) + 5) } } : {})
          }
        })
        postMortem = postMortemBlock(items)
        state = { ...state, postMortemSeen: [...(state.postMortemSeen ?? []), ...exits.map((f) => f.id)].slice(-POST_MORTEM_SEEN_CAP) }
      } catch (err) {
        log('warn', `post-mortem bars failed: ${(err as Error).message}`)
      }
    }
  }
  const promptArgs = { cfg, state, trigger: req.trigger, userText: req.userText, market, messages: recent, recentDecisions, lastRunEndedAt: prevLastRunAt, ordersToday, timeoutQuestion, checkInsLeft: attended ? undefined : checkInsLeft(), approvalNote, postMortem }
  let runPrompt = composeRunPrompt(promptArgs)
  /**
   * `promptBreakdown`'s call site. A module that is tested but has no caller
   * never runs — so the call is pinned here, where the run prompt is built.
   *
   * The blocks are re-derived rather than threaded out of `composeRunPrompt`.
   * `runPromptBlocks` is pure over data already computed, so the cost is a few
   * string lengths, and the alternative is changing a signature in
   * `prompts.ts` — another lane's file, mid-write. Category ids come from the
   * registry either way, so a block added to the prompt appears here without
   * anyone remembering to add it.
   */
  // Goal realism on the FIRST run: a target the watchlist's daily
  // range cannot deliver is pinned as a note now, not discovered as a
  // shortfall in a week. The New-agent sheet says the same sentence.
  if (state.runCount === 0 && (req.trigger === 'plan' || req.trigger === 'schedule')) {
    const realism = goalRealism(cfg.task, cfg.allocationUsd, now().toISOString())
    const ranges = (symbolCtx?.analyses ?? []).map((a) => a.dailyRangePct).filter((n): n is number => typeof n === 'number' && n > 0)
    const range = ranges.length ? Math.max(...ranges) : null
    if (realism && range !== null && realism.impliedDailyPct > range) {
      await post({ role: 'system', kind: 'info', notify: 'important', text: `📌 Goal check: ${goalRealismLine(realism, range)}` })
    }
  }
  const promptBlocks = runPromptBlocks(promptArgs)
  /** The tools THIS agent is offered — a playbook adds its own research tools. */
  const agentTools = toolsFor(cfg)
  const toolsJson = JSON.stringify(agentTools.map((t) => ({ name: t.name, description: t.description })))
  // The whole prompt, as sent — the one thing a post-mortem always wants and
  // the run row never carried. Remote tool names are the vendor's discovery;
  // ours are listed here.
  traced('prompts', () =>
    trace?.prompts({
      systemPrompt,
      prompt: runPrompt,
      blocks: promptBlocks.filter((b) => b.text).map((b) => ({ name: b.id, chars: b.text.length })),
      tools: agentTools.map((t) => tbToolName(t.name)),
      resumeSessionId: cfg.model.vendor === 'claude' ? state!.sessionId : null
    })
  )

  // ── Tool host (engine side of the agent's tools) ────────────────────────
  let actions = 0
  /**
   * What THIS RUN has bought, for `maxNewPositionsPerRun` and the one-buy-per-
   * symbol-per-run rule. Mutated only inside `host.trade`, which rides the
   * run's exclusive lane, so a turn's concurrent buys are counted one after
   * another — the second sees the first's count, never a shared snapshot.
   */
  const runBuys = { newPositions: 0, boughtSymbols: [] as string[] }
  const execCtx = (): ExecContext => ({
    config: cfg,
    state: state!,
    rh,
    feed,
    accountNumber,
    quotes,
    // Stamped on every fill this run places, so a later sell can be scored
    // back to the run whose decision opened the position.
    runId,
    technicalsFor: (symbol) => {
      const a = symbolCtx?.analyses.find((x) => x.symbol === symbol)
      return a ? { vwap: a.vwap, dayOpen: a.dayOpen } : null
    },
    run: runBuys,
    buyingPower: cfg.mode === 'live' ? account?.buyingPower : null,
    // The broker's real account type (cash / margin) decides a live agent's
    // settlement rule; unknown falls back to the agent's own setting.
    brokerAccountType: cfg.mode === 'live' ? account?.type ?? null : null,
    tradingHalted,
    // No PRICE SOURCE at all — a different fact from "the quote did not
    // arrive", and the guardrail says so instead of blaming the feed per
    // symbol. A paper agent on the market-data feed has prices, so it is
    // "connected" for this purpose; a live agent is only ever priced by Robinhood.
    brokerConnected: feed !== null,
    now: now(),
    trigger: req.trigger,
    // Without this the sink in `executeTrade` is inert and the engine's own
    // refusals stay unrecorded — the very gap it was added to close.
    audit,
    log
  })
  /**
   * A trail narrower than the name's ordinary daily swing is answered with the
   * numbers rather than placed. Advisory, not a refusal:
   * `acknowledgeTight` lets it through, and a symbol with no computed range is
   * never held up by it. Logged so "why didn't it buy at 09:35?" has an answer.
   */
  const trailFloorAdvisory = (tool: string, symbol: string, trailPct: number | undefined, acknowledged: boolean | undefined): string | null => {
    if (acknowledged) return null
    const tight = trailTooTight(symbol, trailPct, dailyRangeOf(symbolCtx, symbol))
    if (tight) audit({ tool, outcome: 'blocked', rule: 'exit.trailTooTight', detail: `${symbol} trail ${trailPct}% under the floor` })
    return tight
  }
  /**
   * Technicals for a symbol this run did not pre-compute — a BUY of a name from
   * research rather than the allowlist, which is most discretionary entries.
   * The trail floor and the entry-extension cap both read `symbolCtx` and were
   * silently inert for exactly the entries they exist for (a name bought from
   * research on a flat book had no daily range anywhere). One bounded bars fetch,
   * merged into the run's context so every later reader sees it; a fetch that
   * fails or runs long leaves the rules un-judged, as before.
   */
  const ensureTechnicals = async (symbol: string): Promise<void> => {
    if (!feed || symbolCtx?.analyses.some((a) => a.symbol === symbol)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const extra = await Promise.race([
        buildSymbolContext(feed, rh, accountNumber, [symbol], quotes, (l, m) => log(l, m)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ON_DEMAND_TECHNICALS_MS)
        })
      ])
      if (!extra) {
        log('warn', `technicals for ${symbol} not ready in ${ON_DEMAND_TECHNICALS_MS} ms — trail floor and extension cap not judged`)
        return
      }
      symbolCtx = symbolCtx
        ? { ...symbolCtx, analyses: [...symbolCtx.analyses, ...extra.analyses], earnings: [...symbolCtx.earnings, ...extra.earnings], warnings: [...symbolCtx.warnings, ...extra.warnings] }
        : extra
    } catch (err) {
      log('warn', `technicals for ${symbol} failed: ${(err as Error).message}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  /**
   * The sell-side twin of the trail floor: an UNATTENDED
   * sell at a loss inside the noise band, above an armed engine stop, is
   * answered with the numbers once (`cutInsideRange`). Operator-driven sells
   * (`manual`/`reply`) are never held up, nor is anything from 15:50 ET — the
   * close is not noise — nor a broker-owned plan, whose stop we do not judge.
   */
  const earlyCutAdvisory = (symbol: string): string | null => {
    if (etClock(now()).minutes >= OVERNIGHT_WARN_MINUTES) return null
    const pos = ledgerFor(cfg, state!).positions.find((p) => p.symbol === symbol)
    const last = quotes.find((q) => q.symbol === symbol)?.last ?? state!.lastRunQuotes[symbol]
    const plan = state!.exits[symbol]
    if (!pos || !last || !plan || plan.enforcedBy === 'broker') return null
    const stop = effectiveStop(plan)
    const advisory = cutInsideRange(symbol, pos.avgCost, last, dailyRangeOf(symbolCtx, symbol), stop)
    if (advisory) audit({ tool: TRADE_TOOL, outcome: 'blocked', rule: 'exit.cutInsideRange', detail: `${symbol} cut ${(((pos.avgCost - last) / pos.avgCost) * 100).toFixed(2)}% under cost with a stop armed at ${stop}` })
    return advisory
  }
  /**
   * The all-in earnings mode's half of a BUY: one name at a time, only a report
   * in the window, and the SIZE is the engine's — everything spendable — with
   * the next-session flatten stamped on. Returns the rewritten intent and the
   * sentence that says so, or a refusal. Runs inside the trade lane.
   */
  const allInBuy = async (intent: TradeIntent): Promise<{ intent: TradeIntent; note: string } | { refused: string }> => {
    const book = ledgerFor(cfg, state!)
    const held = book.positions.filter((p) => p.qty > 1e-9)
    if (held.length) {
      audit({ tool: TRADE_TOOL, outcome: 'blocked', rule: 'playbook.oneAtATime', detail: `holding ${held.map((p) => p.symbol).join(', ')}` })
      return { refused: `NOT PLACED: all-in earnings mode holds ONE name at a time, and you hold ${held.map((p) => p.symbol).join(', ')}. The engine sells it at ${EARNINGS_POP.exitAt} ET next session; nothing else is bought before then. No card was posted.` }
    }
    // The report window is the thesis: a report already out is a coin flip on
    // the drift, one a day away is a session of risk for nothing. Refused only
    // on data we READ; a broker that could not answer lets the buy through with
    // a note, because refusing on a guess is worse.
    let windowNote = ''
    if (rh) {
      try {
        const rep = await nextReport(rh, intent.symbol, now())
        const w = rep ? reportWindow(rep, now()) : null
        if (!w) {
          const what = rep ? `reports ${rep.date} ${rep.timing === 'am' ? 'before the open' : rep.timing === 'pm' ? 'after the close' : '(timing not published)'}` : 'has no upcoming report in the broker’s data'
          audit({ tool: TRADE_TOOL, outcome: 'blocked', rule: 'playbook.notReporting', detail: `${intent.symbol} ${what}` })
          return { refused: `NOT PLACED: ${intent.symbol} ${what}. All-in earnings mode buys only a company reporting ${REPORT_WINDOW_LABEL.tonight} or ${REPORT_WINDOW_LABEL.tomorrowMorning} — earnings_candidates lists the ones that qualify. No card was posted.` }
        }
        windowNote = ` It reports ${REPORT_WINDOW_LABEL[w]}.`
      } catch (err) {
        log('warn', `all-in: could not read ${intent.symbol}'s next report (${(err as Error).message}) — letting the buy through unconfirmed (${cfg.id})`)
        windowNote = ` (The report date could not be confirmed with the broker just now.)`
      }
    }
    const settlement = settlementModeFor(cfg, cfg.mode === 'live' ? account?.type : null)
    const size = allInNotional(allInSpendable(book, settlement, now()))
    if (!size) {
      audit({ tool: TRADE_TOOL, outcome: 'blocked', rule: 'playbook.nothingToSpend', detail: `cash ${book.cash}` })
      return { refused: `NOT PLACED: ${earningsPopPhase({ ledger: book, settlement, now: now(), money })} No card was posted.` }
    }
    return {
      intent: { ...intent, qty: undefined, notional: size, type: 'market', limitPrice: undefined, tif: 'day', flattenAt: EARNINGS_POP.exitAt, allIn: true },
      note: ` ALL-IN: the engine sized this to ${money(size)} — ${settlement === 'cash' ? 'all of your SETTLED cash' : 'all of your cash'} (any size you passed is ignored in this mode) — and the whole position sells at ${EARNINGS_POP.exitAt} ET next session, gap up or down.${windowNote}`
    }
  }
  const allInMode = isEarningsPop(cfg)
  const hostImpl: ToolHost = {
    async trade(intent) {
      let allInNote = ''
      if (allInMode && intent.side === 'buy') {
        const r = await allInBuy(intent)
        if ('refused' in r) return r.refused
        intent = r.intent
        allInNote = r.note
      }
      if (intent.side === 'buy') {
        await ensureTechnicals(intent.symbol)
        const tight = trailFloorAdvisory(TRADE_TOOL, intent.symbol, intent.trailPct, intent.acknowledgeTight)
        if (tight) return tight
      }
      const heldBefore = positionQty(ledgerFor(cfg, state!), intent.symbol)
      if (intent.side === 'sell' && heldBefore > 1e-9 && !intent.acknowledgeTight && !attended) {
        const cut = earlyCutAdvisory(intent.symbol)
        if (cut) return cut
      }
      // A sell with no size closes the whole position. Models often send a
      // size-less sell when they mean "get out" ("early-cut rule on carried
      // META position"); refusing it costs a turn, and sometimes the exit
      // itself. A buy with no size is still refused at the tool.
      if (intent.side === 'sell' && !(intent.qty && intent.qty > 0) && !(intent.notional && intent.notional > 0)) {
        if (heldBefore <= 1e-9) return `NOT PLACED: you hold no ${intent.symbol}, so there is nothing to sell. No card was posted.`
        intent = { ...intent, qty: heldBefore }
      }
      // `auditAs` matters: without it this records as `engine__trade`, and the
      // decision log's whole job is separating what the MODEL asked for from
      // what the engine did on its own.
      const r = await executeTrade(execCtx(), intent, { auditAs: TRADE_TOOL })
      state = r.state
      if (intent.side === 'buy' && (r.action.status === 'filled' || r.action.status === 'open')) {
        runBuys.boughtSymbols.push(intent.symbol)
        if (heldBefore <= 1e-9) runBuys.newPositions++
      }
      // A buy that moved the stop already protecting the position says so in
      // the thread: the card describes the order, and a stop moving is
      // bookkeeping nobody would otherwise see.
      if (r.stopMoved) await post({ role: 'system', kind: 'info', text: `🛡 ${r.stopMoved.symbol} stop moved by this buy: ${r.stopMoved.from !== undefined ? money(r.stopMoved.from) : 'none'} → ${r.stopMoved.to !== undefined ? money(r.stopMoved.to) : 'none'} (the trail's high re-seeds at the higher of the old high and this fill).` })
      const failed = r.action.status === 'rejected' || r.action.status === 'error'
      // A rejected attempt is a card in the thread, not an action taken —
      // counting it inflated `runs.actions` (and the usage page's "trades")
      // with orders that moved nothing.
      if (!failed) actions++
      // The one-time pass: spent by an order that went SOMEWHERE (filled,
      // resting, or accepted by the broker). An execution failure hands the
      // pass back — the operator's yes is still owed an order, which is the
      // whole reason the pass now survives in state — while a success clears
      // `state.pendingAction` so a second order needs a second card.
      if (approvalUsed && approved) {
        if (failed) approvalUsed = false
        else {
          approved = null
          await patch({ pendingAction: null })
        }
      }
      await post({ role: 'action', action: r.action })
      await saveState()
      const a = r.action
      // Arguments the engine accepted but did not act on (an exit attached to a
      // sell, say). Dropping them silently teaches the model the call did what
      // it asked for, which is the one thing it must never wrongly believe.
      const notes = r.notes?.length ? ` ${r.notes.join(' ')}` : ''
      // A flatten minute already behind us today is TOMORROW's: said in the
      // result, so the agent does not end the day believing it is flat.
      const flatNote = a.side === 'buy' && intent.flattenAt && (a.status === 'filled' || a.status === 'open') ? flattenTomorrowNote(intent.flattenAt, etClock(now())) : null
      const flat = flatNote ? ` ${flatNote}` : ''
      if (a.status === 'rejected' || a.status === 'error') return `REJECTED: ${a.error ?? 'unknown'}. Do not retry with the same parameters.${notes}`
      if (a.status === 'filled') {
        let slip = ''
        if (a.refPrice && a.fillPrice) {
          const bps = ((a.fillPrice - a.refPrice) / a.refPrice) * 10_000 * (a.side === 'buy' ? 1 : -1)
          slip = ` Slippage ${bps >= 0 ? '+' : ''}${bps.toFixed(1)}bps vs the quote you saw${bps > 20 ? ' — that is a lot; consider limit orders or calmer moments' : ''}.`
        }
        const armed = describeExitPlan({ stop: a.stopLoss, target: a.takeProfit, trailPct: a.trailPct })
        const prot = armed ? ` Exit plan armed (${armed}).` : ''
        // The ENGINE's economics, handed to the model so it narrates the book's
        // number instead of doing its own arithmetic. A model that recomputes
        // from prices it rounded in prose announces a figure cents away from
        // the card — the card is right, the sentence beside it is not, and the
        // sentence is what gets read.
        const e = a.econ
        const money2 = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
        const econLine =
          e && a.side === 'sell' && e.realized !== undefined
            ? ` Realized ${money2(e.realized)}${e.realizedPct !== undefined ? ` (${e.realizedPct >= 0 ? '+' : ''}${e.realizedPct.toFixed(2)}%)` : ''} on this close — use THIS figure when you report it; book total ${money2(e.bookRealized)}.`
            : ''
        // When the money comes back. A sell that reads as "+$200 cash" invites
        // the model to spend it this run; in a cash account it cannot.
        let settleLine = ''
        if (a.side === 'sell' && e?.settlesOn) {
          const sm = settlementModeFor(cfg, cfg.mode === 'live' ? account?.type : null)
          settleLine = ` Proceeds ${money2(e.notional)} settle ${describeSettlesOn(e.settlesOn)} (T+1)${sm === 'cash' ? ' — NOT spendable on buys before then (cash account); your settled cash is what you can redeploy today' : sm === 'margin' ? ' — spendable now (limited margin)' : ''}.`
        }
        return `FILLED ${a.side.toUpperCase()} ${a.fillQty} ${a.symbol} @ $${a.fillPrice?.toFixed(2)} (${a.mode}${a.orderId ? `, order ${a.orderId}` : ''}).${econLine}${settleLine}${slip}${prot}${flat}${allInNote}${notes}`
      }
      return `SUBMITTED ${a.side.toUpperCase()} ${a.qty} ${a.symbol} ${a.type}${a.limitPrice ? ` @ $${a.limitPrice}` : ''} — order ${a.orderId ?? '?'} is OPEN (not filled yet).${flat}${allInNote}${notes}`
    },
    async cancelOrder(orderId) {
      const r = await executeCancel(execCtx(), orderId)
      state = r.state
      await saveState()
      return r.detail
    },
    async changePlan(rawPlan: PlanProposal, pct) {
      // Operators say "10%", the policy stores dollars, and only the host knows
      // the allocation to convert against. Doing it here means the model never
      // has to do arithmetic it can get silently wrong — and a model that set
      // profitTargetUsd: 10 for "10%" would retire on the first ten dollars.
      if (pct && (pct.profitTargetPct !== undefined || pct.maxLossPct !== undefined)) {
        const alloc = Math.max(1, cfg.allocationUsd)
        rawPlan = {
          ...rawPlan,
          retirement: {
            ...(rawPlan.retirement ?? {}),
            ...(pct.profitTargetPct !== undefined ? { profitTargetUsd: Math.round((pct.profitTargetPct / 100) * alloc * 100) / 100 } : {}),
            ...(pct.maxLossPct !== undefined ? { maxLossUsd: Math.round((pct.maxLossPct / 100) * alloc * 100) / 100 } : {})
          }
        }
      }
      // A profit target with no max loss gets one of the same size, and the
      // card says so. This is the ONLY place the floor is added:
      // `applyPlanToConfig` applies a plan as written, because it is also the
      // apply-card path, which has no sentence to attach to it.
      if (rawPlan.retirement && rawPlan.retirement.profitTargetUsd !== undefined && rawPlan.retirement.maxLossUsd === undefined) {
        rawPlan = { ...rawPlan, retirement: { ...rawPlan.retirement, maxLossUsd: rawPlan.retirement.profitTargetUsd }, summary: `${rawPlan.summary} (max loss set to ${money(rawPlan.retirement.profitTargetUsd, 0)} to match the profit target — a goal needs a floor)` }
      }
      // Clamp at the moment it is PROPOSED, not when it is applied, so the card
      // the operator reads is the change they will actually get.
      const clamped = clampGuardrails(rawPlan.guardrails, cfg.allocationUsd)
      // Frozen here, against the guardrails as they stand RIGHT NOW. Once this
      // applies, today's config is the new values and the card could no longer
      // work out what it changed — an applied card is the audit trail, so it
      // has to carry its own before-and-after.
      const diff = guardrailDiff(cfg.guardrails, clamped)
      const plan: PlanProposal = { ...rawPlan, guardrails: clamped, ...(diff.length ? { diff } : {}) }
      // A plan that changes NOTHING is not a plan. The model sometimes calls this
      // to "confirm" settings it already has — and that posted a card asking the
      // operator to approve a no-op, on an agent whose plan had been finalised
      // hours earlier — e.g. `{schedule: null, guardrails: {}, task: null}` under
      // "confirming 30-min market-hours swing clock already set". There is
      // nothing to confirm and nothing to apply; the operator must not be asked.
      //
      // Compared by RESULT rather than by whether fields were supplied, so
      // "set the interval to 30" when it is already 30 is caught too. Task and
      // spawn proposals are exempt — those are additive by nature and are judged
      // by their own tools.
      if (!plan.spawnAgent && !plan.addTask && !plan.completeTaskId) {
        const would = applyPlanToConfig(cfg, plan, cfg.updatedAt)
        if (JSON.stringify(would) === JSON.stringify(cfg)) {
          audit({ tool: tbToolName('change_plan'), outcome: 'blocked', rule: 'plan.noChange', detail: short(plan.summary, 120) })
          return 'That is already your plan — nothing would change, so nothing was proposed and the operator was not asked. Your current schedule, guardrails and task are in the context above; read them there rather than calling change_plan to confirm them.'
        }
      }
      // The Acting switch decides who applies a plan change.
      //
      // An "On its own" agent applies what it proposes — schedule, task,
      // limits, a widening included — and the thread says what changed. The
      // switch is the operator's one answer to "does this agent need my tap";
      // before this, a fully autonomous agent that widened its own daily loss
      // limit still stalled on a card with a typed word, on top of "On its
      // own", and the operator asked why they were being asked. The fence
      // still has an outer wall the agent cannot move: `clampGuardrails` caps
      // every limit at the allocation / MAX_MODEL_DAILY_LOSS_PCT, the daily
      // loss lock and the account halt stay the operator's, and a widening
      // posts an `important` note with the money it now stands to lose plus a
      // `plan.widened` row in the decision log.
      //
      // An "Ask me first" agent keeps the old rule: changes the operator asked
      // for (reply runs) and first-time setup apply at once, a change the
      // agent invents on a scheduled/manual run posts as a pending card — and
      // a widening ALWAYS waits for the tap (past 10% daily loss / 25% per
      // order, the typed word), because that operator said every consequential
      // move is theirs to make.
      //
      // First setup is exempt for both: there is no established fence to widen,
      // only the generic defaults, and the operator is standing there creating
      // the agent.
      const loosens = req.trigger !== 'plan' && loosensGuardrails(diff)
      // The respawn-revision window auto-applies too: the operator just pressed
      // Respawn and the block's whole instruction is "roll your own deadlines
      // forward" — posting that as a pending card would re-create the stall the
      // block exists to remove. For an ask-first agent the loosening fence is
      // unchanged: even a revision run cannot widen its own limits without a tap.
      const respawnRevision = Boolean(state!.respawnedAt)
      const selfApplies = isAutonomous(cfg)
      const autoApply = selfApplies || ((req.trigger === 'reply' || req.trigger === 'plan' || respawnRevision) && !loosens)
      const widened = diff
        .filter((c) => c.looser)
        .map((c) => `${c.label} ${c.from} → ${c.to}`)
        .join('; ')
      const msg = await post({ role: 'plan', plan, status: autoApply ? 'applied' : 'pending' })
      if (autoApply) {
        const next = applyPlanToConfig(cfg, plan, now().toISOString())
        Object.assign(cfg, next)
        await deps.storage.saveConfig(next)
        if (loosens) {
          // The one place an agent moves its own fence outward: say so loudly
          // enough to notify the operator, in the money the new limits mean.
          audit({ tool: tbToolName('change_plan'), outcome: 'allowed', rule: 'plan.widened', detail: short(widened, 200) })
          await post({ role: 'system', kind: 'schedule', notify: 'important', text: `Plan updated by the agent — limits widened: ${widened}. ${riskSummary(next.guardrails, next.allocationUsd)}` })
        } else {
          await post({ role: 'system', kind: 'schedule', text: `Plan updated: ${plan.summary}` })
        }
        // A chosen schedule settles `awaitingPlan`, the same way an operator's
        // schedule change does. Without this, every agent that picked its own
        // schedule on the setup run would keep the flag for good — harmless while
        // the schedule is not manual (`setupState()` only reads the flag then),
        // and "still setting up", forever, the moment it chooses manual.
        if (plan.schedule && state!.awaitingPlan) await patch({ awaitingPlan: false })
        if (loosens) return `Plan applied (message ${msg.id}). Your limits are WIDER now (${widened}) and the operator has been notified — say plainly in your reply why you widened them. The new schedule is active.`
        return `Plan applied (message ${msg.id}). The new schedule is active.`
      }
      if (loosens) {
        return `Posted for the operator to confirm (message ${msg.id}) — NOT applied. It would widen your limits (${widened}), and this agent is set to ask first, so only they can do that. Everything else you proposed is waiting on the same card. Tell them plainly what you want and why; keep working inside your current limits until they tap it.`
      }
      return `Plan proposed (message ${msg.id}); the operator must approve it in the thread.`
    },
    async remember(note, defer) {
      const text = note.trim()
      if (!defer) {
        const memory = [text, ...state!.memory.filter((m) => m !== text)].slice(0, MEMORY_CAP)
        await patch({ memory })
        return `Remembered (${memory.length}/${MEMORY_CAP}).`
      }
      // A deferred note is a debt, not a fact: it goes on the errand list, is
      // handed back when its moment comes, and clears itself once settled.
      const open = (state!.errands ?? []).filter((e) => e.note !== text)
      if (open.length >= MAX_ERRANDS) return `You already have ${open.length} pending errands — settle one with errand_done before deferring another.`
      const errand: Errand = { id: newId('e_'), note: text, addedAt: now().toISOString(), when: defer }
      await patch({ errands: [...open, errand] })
      return `Deferred as errand ${errand.id} (${defer === 'market_open' ? 'when the market next opens' : 'next run'}). You will be reminded; call errand_done once you have acted on it.`
    },
    async errandDone(id, outcome) {
      const open = state!.errands ?? []
      const hit = open.find((e) => e.id === id)
      if (!hit) return `No pending errand ${id}. Open: ${open.map((e) => e.id).join(', ') || 'none'}.`
      await patch({ errands: open.filter((e) => e.id !== id) })
      await post({ role: 'system', kind: 'info', text: `✅ Errand settled — ${hit.note} (${outcome.trim()})` })
      return `Errand ${id} cleared.`
    },
    async sleepUntil(args) {
      const tool = tbToolName('sleep_until')
      sleepTouched = true
      if (args.cancel) {
        const cur = state!.sleep
        if (!cur) return 'You are not asleep — nothing to cancel.'
        await patch({ sleep: undefined })
        await post({ role: 'system', kind: 'schedule', text: LIFECYCLE.sleepCancelled(cur.reason) })
        return `Awake. Back on your normal schedule (${describeSchedule(cfg.schedule)}).`
      }
      // The host, not the prompt, decides what a sleep may be — the tool has
      // only parsed the words into an instant by the time it gets here.
      if (state!.status === 'paused' || state!.status === 'retired') {
        audit({ tool, outcome: 'blocked', rule: 'sleep.notRunning', detail: state!.status })
        return `You are ${state!.status}; sleeping is for a running agent. The operator decides when a ${state!.status} agent wakes.`
      }
      const until = args.until
      if (!until) return 'Nothing to do — pass `until` and `reason`, or `cancel: true`.'
      const nowMs = now().getTime()
      if (!(until.getTime() > nowMs)) {
        audit({ tool, outcome: 'blocked', rule: 'sleep.notFuture', detail: until.toISOString() })
        return `${formatEt(until, true)} is not in the future (it is ${formatEt(now(), true)} now). If the event has already happened, act on it; otherwise pick a later wake time.`
      }
      const days = (until.getTime() - nowMs) / 86_400_000
      if (days > MAX_SLEEP_DAYS) {
        audit({ tool, outcome: 'blocked', rule: 'sleep.tooFar', detail: `${Math.round(days)}d` })
        return `That is ${Math.round(days)} days away; the longest sleep is ${MAX_SLEEP_DAYS} days. Sleep until something inside that window (you can extend it when you wake), or ask the operator whether an agent this idle should exist yet.`
      }
      const reason = (args.reason ?? '').trim() || 'waiting for a dated event'
      const moving = Boolean(activeSleep(state, now()))
      await patch({ sleep: { until: until.toISOString(), reason, setAt: now().toISOString() } })
      await post({ role: 'system', kind: 'schedule', text: LIFECYCLE.sleeping(until.toISOString(), reason) })
      return `${moving ? 'Sleep moved' : 'Sleeping'} until ${formatEt(until, true)} (${Math.round(days * 10) / 10} days). Your schedule (${describeSchedule(cfg.schedule)}) resumes after that. Messages, price watches and question deadlines still wake you; a run they start does not cancel the sleep. Finish this run now — there is nothing more to do until then.`
    },
    async proposeAgent(spec) {
      // Ask the HOST whether the account can take another agent before asking
      // the operator. A card the plan would refuse is worse than no card: it
      // reads as a decision they get to make, and then fails when they make it.
      if (!deps.capacity) return 'I cannot create agents from here — tell the operator to add it themselves from the app.'
      const cap = await deps.capacity()
      if (!cap.ok) {
        return `Cannot create another agent: ${cap.reason ?? `this plan allows ${cap.max} and ${cap.used} are active.`} Do NOT propose it — tell the operator this in your own words, and offer to take the work on as one of your own tasks instead if it fits.`
      }
      const msg = await post({ role: 'plan', plan: { spawnAgent: spec, guardrails: {}, summary: `Create a new agent: ${spec.name}` }, status: 'pending' })
      return `Proposed a new agent "${spec.name}" (message ${msg.id}) — it does NOT exist until the operator confirms. Carry on with your own tasks; do not do its work in the meantime, and do not propose it again.`
    },
    async proposeTask(task, why) {
      const current = activeTasks(cfg)
      if (current.length >= MAX_TASKS) return `This agent already has ${current.length} standing tasks (max ${MAX_TASKS}). Ask the operator to drop one first.`
      const dupe = current.find((t) => t.text.toLowerCase() === task.toLowerCase())
      if (dupe) return `That is already one of your tasks (${dupe.id}) — nothing to propose.`
      // NEVER auto-applied, whatever the trigger: a second task changes what the
      // agent is for, and that is the operator's call even when they asked for it.
      const msg = await post({ role: 'plan', plan: { addTask: task, guardrails: {}, summary: `Add a task: ${task}` }, status: 'pending' })
      return `Proposed as a new task (message ${msg.id}) — it is NOT active until the operator confirms it in the thread. Do not start on it yet, and do not propose it again.`
    },
    async forget(match) {
      const before = state!.memory.length
      const memory = state!.memory.filter((m) => !m.toLowerCase().includes(match.toLowerCase()))
      await patch({ memory })
      return `Removed ${before - memory.length} note(s).`
    },
    // Prices for ANY symbol, from whichever feed prices this run. Before this
    // the only way to price a symbol outside the context block was a Robinhood
    // tool — so a paper agent without a broker could not size a single new
    // idea. Read-only; never audited as a decision.
    async quotes(symbols) {
      if (!feed) return 'No price source this run: no Robinhood connection and no market feed. Nothing can be priced; say so to the operator.'
      const syms = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 20)
      if (!syms.length) return 'Give at least one symbol.'
      const r = await feed.quotes(syms)
      const lines = r.quotes.map((q) => `${q.symbol}: last ${money(q.last)}${q.bid ? ` · bid ${money(q.bid)}` : ''}${q.ask ? ` · ask ${money(q.ask)}` : ''}${q.changePct !== undefined ? ` · ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}% vs prev close` : ''}`)
      if (r.failed.length) lines.push(`Could not price: ${r.failed.join(', ')}.`)
      const session = sessionLabel(now())
      return `${session === 'open' ? 'QUOTES (real-time)' : `QUOTES (market ${session.toUpperCase()} — last trades, not live prices)`}${feed.id === 'feed' ? ' via the market-data feed' : ''}:\n${lines.join('\n')}`
    },
    async bars(symbol, interval, days) {
      if (!feed) return 'No price source this run: no Robinhood connection and no market feed.'
      const sym = symbol.trim().toUpperCase()
      const span = Math.min(Math.max(1, Math.round(days)), interval === 'day' ? 365 : 10)
      const bars = (await feed.bars([sym], new Date(now().getTime() - span * 86_400_000).toISOString(), interval))[sym] ?? []
      if (!bars.length) return `No ${interval === 'day' ? 'daily' : '5-minute'} bars for ${sym} in the last ${span} day(s).`
      // The tail, bounded: a run is a decision, not a data export.
      const tail = bars.slice(-(interval === 'day' ? 60 : 120))
      const rows = tail.map((b) => `${formatEt(b.t * 1000, true)} O ${b.o.toFixed(2)} H ${b.h.toFixed(2)} L ${b.l.toFixed(2)} C ${b.c.toFixed(2)} V ${Math.round(b.v)}`)
      return `${sym} ${interval === 'day' ? 'daily' : '5-minute'} bars (${tail.length} of ${bars.length}, oldest first):\n${rows.join('\n')}`
    },
    // All-in earnings research (`core/research/earnings.ts`). Read-only, never
    // audited as a decision; both need the broker, whose data is the only
    // source of the calendar, the results and the option quotes.
    async earningsCandidates() {
      if (!rh) return 'Earnings research needs the Robinhood connection (it is the source of the calendar, past results and option quotes), and this run has none. Say so to the operator and do not trade — there is no way to confirm a report window without it.'
      return await earningsCandidates(rh, now())
    },
    async earningsDossier(symbol) {
      if (!rh) return 'Earnings research needs the Robinhood connection, and this run has none.'
      return await earningsDossier(rh, symbol, now())
    },
    async searchThread(query, limit) {
      const { messages: hits, scannedAll } = await deps.storage.searchMessages(cfg.id, query, limit)
      const terms = query.split(/\s+/).filter(Boolean).join(', ')
      // A bounded search that reports nothing would tell the agent something
      // false about the operator's history. Say which it is.
      const partial = scannedAll ? '' : ' (this search did not reach the oldest messages — a miss here is not proof it was never said)'
      // Name the words searched. A bare 'no matches' reads as 'it never
      // happened' and the agent stops looking; naming them lets it try
      // different ones, which is what a miss usually means.
      if (hits.length === 0) return `No message contains all of: ${terms}.${partial} Try fewer or different words.`
      // Rendered by the SAME function that renders the prompt's thread window,
      // so a searched message reads exactly like one the agent can already
      // see. That is also why the search path needs no escaping of its own:
      // `transcriptBlock` neutralises structural markers (prompts.ts:249), so
      // a forgery cannot re-enter through here. Its header line is dropped —
      // these are search results, not the thread.
      const rendered = transcriptBlock(hits).split('\n').slice(1).join('\n')
      return `${hits.length} match(es) for ${terms}, oldest first:\n${rendered}`
    },
    async setExit({ symbol, clear, acknowledgeTight, ...spec }) {
      if (clear) {
        if (!state!.exits[symbol]) return `No exit plan on ${symbol}.`
        const exits = { ...state!.exits }
        delete exits[symbol]
        await patch({ exits })
        return `Exit plan on ${symbol} cleared.`
      }
      const { stopLoss: stop, takeProfit: target, trailPct } = spec
      const held = positionQty(ledgerFor(cfg, state!), symbol)
      if (held <= 0) return `You hold no ${symbol} — attach stopLoss/takeProfit/trailPct to the buy instead, or set the exit after the fill.`
      if (!hasExitSpec(spec)) return 'Provide stop, target, trailPct, stopIfBelow/stopIfAbove, breakEvenAfterPct, armAfterMin or flattenAt (or clear: true).'
      if (trailPct !== undefined) await ensureTechnicals(symbol)
      const tight = trailFloorAdvisory(tbToolName('set_exit'), symbol, trailPct, acknowledgeTight)
      if (tight) return tight
      // The high is seeded from the best price we can currently justify and is
      // ENGINE state from then on. The model never supplies it: given the
      // chance it could name a high and put the stop wherever it liked.
      const mark = quotes.find((q) => q.symbol === symbol)?.last ?? state!.lastRunQuotes[symbol] ?? ledgerFor(cfg, state!).positions.find((p) => p.symbol === symbol)?.avgCost ?? 0
      // The same rule checkGuardrails applies to an exit attached to a BUY. It
      // has to be applied here too, because set_exit writes state.exits
      // directly and never passes through the guardrail path — and a stop above
      // the market fires on the very next sweep, market-selling the whole
      // position as a protective exit: no order cap, no PDT check, no approval.
      // That is the same liquidation the approval-side fix closes, reached by a
      // shorter route.
      //
      // MERGE, matching what this tool's own schema promises ("omit to leave
      // unchanged"). Replacing meant set_exit(symbol, target: X) DELETED the
      // stop protecting the position while the description told the model the
      // omitted field would survive — so it had every reason to believe its
      // stop was still there. `clear: true` is how a plan is removed; an
      // omitted field is not a request to remove anything.
      const prev = state!.exits[symbol]
      const nextStop = stop ?? prev?.stop
      const nextTarget = target ?? prev?.target
      // Judge the MERGED plan, not just the fields this call named: a target
      // that is fine alone can still be inverted against a stop already set.
      //
      // And read the EFFECTIVE stop, because a trail set earlier is a stop too
      // — a 5% trail off a $400 high sells at $380, so merging a target into it
      // at $300 is the same mistake wearing a different field name.
      // The SAME merge a buy uses (`armExitPlan`), seeded at the best price we
      // can justify — so a trail set here and a trail set on the fill agree.
      const { plan: merged } = armExitPlan(prev, spec, mark, now().toISOString())
      const problem = mark > 0 ? exitLevelProblem({ stop: effectiveStop(merged), target: nextTarget }, mark) : null
      if (problem) return `${problem} Nothing was changed on ${symbol}.`
      if (mark > 0 && merged.stopIf?.above !== undefined && merged.stopIf.above <= mark) return `An invalidation level ABOVE at $${merged.stopIf.above} is at or below the $${mark.toFixed(2)} price — it would fire immediately. Nothing was changed on ${symbol}.`
      const plan: ExitPlan = merged
      void nextStop
      await patch({ exits: { ...state!.exits, [symbol]: plan } })
      const eff = effectiveStop(plan)
      return `Exit plan set on ${symbol}: ${describeExitPlan(plan)}.${eff !== undefined ? ` Selling at ${money(eff)} or below right now.` : ''} ${exitEnforcementNote()}`
    },
    async watchPrice(w) {
      if (w.cancel) {
        const beforeN = state!.watches.length
        // By id when given: an agent watching MU for a stop level AND a target
        // could only ever drop both, which with a six-watch limit was a real
        // constraint. Same shape as errand_done(id), which this codebase
        // already settled on.
        await patch({ watches: state!.watches.filter((x) => (w.id ? x.id !== w.id : x.symbol !== w.symbol)) })
        const gone = beforeN - state!.watches.length
        if (!gone) return w.id ? `No watch ${w.id}. Open: ${state!.watches.map((x) => x.id).join(', ') || 'none'}.` : `No watches on ${w.symbol}.`
        return `Cancelled ${gone} watch(es)${w.id ? ` (${w.id})` : ` on ${w.symbol}`}.`
      }
      // Same symbol AND same condition replaces, rather than stacking: watches
      // are one-shot, so re-arming after a fire is normal and must not pile up
      // six copies of "MU -5%" until the limit refuses the seventh.
      const others = state!.watches.filter((x) => !(x.symbol === w.symbol && x.condition === w.condition))
      const replacing = others.length !== state!.watches.length
      if (others.length >= 6) return 'Watch limit reached (6). Cancel one first.'
      let baseline = quotes.find((q) => q.symbol === w.symbol)?.last ?? 0
      if (!(baseline > 0) && feed) {
        try {
          baseline = (await feed.quotes([w.symbol])).quotes[0]?.last ?? 0
        } catch {
          /* below/above still work without baseline */
        }
      }
      if ((w.condition === 'move_up_pct' || w.condition === 'move_down_pct') && !(baseline > 0)) {
        // No live quote (market shut, or no broker). Refusing alone leaves the
        // model with nothing to do but defer, so hand it the arithmetic: any
        // recent price we already hold is enough to express the same intent as
        // an absolute watch, which needs no baseline at all.
        const ref = state!.lastRunQuotes[w.symbol] ?? ledgerFor(cfg, state!).positions.find((pos) => pos.symbol === w.symbol)?.avgCost ?? 0
        const dir = w.condition === 'move_down_pct' ? 'below' : 'above'
        if (ref > 0) {
          const level = w.condition === 'move_down_pct' ? ref * (1 - w.value / 100) : ref * (1 + w.value / 100)
          return `No live price for ${w.symbol} right now (the market is likely closed). Use an absolute watch instead — call watch_price again with condition "${dir}" and value ${level.toFixed(2)} (that is ${w.value}% ${dir} $${ref.toFixed(2)}, the last price I have). Do that now rather than deferring it.`
        }
        return `No price for ${w.symbol} at all — I have no recent quote to measure from. Use an absolute "${dir}" watch with a level you can justify, or defer this with remember(defer: "market_open") and set it when the market opens.`
      }
      const watch = { id: newId('w_'), symbol: w.symbol, condition: w.condition, value: w.value, baseline, note: w.note, setAt: now().toISOString() }
      await patch({ watches: [...others, watch] })
      return `Watch ${replacing ? 'replaced' : 'set'}: ${w.symbol} ${w.condition} ${w.value}${w.condition.startsWith('move') ? `% from $${baseline.toFixed(2)}` : ''}. One-shot — you will be woken once when it fires.`
    },
    async setThesis(symbol, thesis) {
      const theses = { ...state!.theses }
      if (!thesis) {
        if (!theses[symbol]) return `No thesis on ${symbol}.`
        delete theses[symbol]
        await patch({ theses })
        return `Thesis on ${symbol} cleared.`
      }
      theses[symbol] = thesis.trim()
      await patch({ theses })
      return `Thesis on ${symbol} recorded.`
    },
    /**
     * Name yourself once, and only if the operator left it blank.
     *
     * The refusal is the interesting half. Without it this is a tool that lets
     * an agent rename itself whenever it likes — so an operator who named their
     * agent could find it called something else after a run, which is the kind
     * of change nobody looks for because nobody expects it. `nameAuto` is set
     * ONLY by `configFromCreateRequest` when the create form's name was empty,
     * and cleared here, so the grant is exactly one use and cannot be re-earned.
     *
     * A name-comparison against the placeholder would have been the obvious
     * implementation and is wrong: "New agent" is a name an operator may
     * legitimately type, and it would then be silently overwritten.
     */
    async setName(name) {
      if (!cfg.nameAuto) return `Your name was set by the operator (“${cfg.name}”) and only they can change it. Carry on with your task.`
      const clean = name.trim().replace(/\s+/g, ' ').slice(0, MAX_AGENT_NAME)
      if (clean.length < 2) return 'That name is too short — give yourself something specific to what you do.'
      const previous = cfg.name
      // Mutated in place and then saved, the same shape `changePlan` uses — the
      // rest of the run holds this same `cfg` object and must see the new name.
      //
      // `nameAuto` is DELETED rather than set to false: absent already means
      // "the operator's name, not ours", so the flag should exist only while
      // the grant does. Leaving a `false` behind would be a second way to spell
      // the same thing, and the next reader would have to know they agree.
      Object.assign(cfg, { name: clean, updatedAt: now().toISOString() })
      delete cfg.nameAuto
      await deps.storage.saveConfig(cfg)
      await post({ role: 'system', kind: 'info', text: LIFECYCLE.namedItself(clean) })
      log('info', 'agent named itself', { agentId: cfg.id, from: previous, to: clean })
      return `Done — you are now “${clean}”. This was one-time; only the operator can rename you from here.`
    },
    async retire(reason) {
      const ret = await executeRetirement(execCtx(), reason, now())
      state = ret.state
      for (const r of ret.results) await post({ role: 'action', action: r.action })
      if (!ret.retired) {
        await post({ role: 'system', kind: 'error', ...(ret.repeat ? {} : { notify: 'important' as const }), text: cannotFlattenNote(reason, ret.open ?? []) })
        await saveState()
        return `NOT retired: the book could not be flattened — ${(ret.open ?? []).map((o) => `${o.qty} ${o.symbol} (${o.why})`).join('; ')}. Your exits stay armed. Sell what you can with trade, or wait for the next session and retire then; do not call retire again this run.`
      }
      await post({ role: 'system', kind: 'retired', text: `🏁 Retired: ${reason}.${ret.note ? ` ${ret.note}` : ''}` })
      await saveState()
      return `You are retired (${reason}). ${ret.results.length ? `Flattened ${ret.results.length} position(s). ` : ''}Say a short goodbye — this thread stays available and the operator can respawn you.`
    },
    async askOperator(args) {
      // One open question at a time — a second one would just pile onto an unanswered card.
      const open = (await deps.storage.recentMessages(cfg.id, 60)).filter(isOpenQuestion)
      if (open.length) {
        audit({ tool: tbToolName('ask_operator'), outcome: 'blocked', rule: 'checkin.alreadyOpen', detail: short(args.question, 120) })
        return `You already have an open question ("${short(open[open.length - 1].text, 120)}"). Wait for its answer or timeout, or decide this yourself from your task.`
      }
      if (!attended && checkInsLeft().questions <= 0) {
        audit({ tool: tbToolName('ask_operator'), outcome: 'blocked', rule: 'checkin.budget', detail: short(args.question, 120) })
        return `Unattended question budget for today is spent (${UNATTENDED_QUESTIONS_PER_DAY}/day). Decide this yourself using your task and guardrails — do the conservative thing and report it.`
      }
      const wait = Math.min(QUESTION_WAIT_MAX, Math.max(QUESTION_WAIT_MIN, Math.round(args.waitMinutes ?? QUESTION_WAIT_DEFAULT_MIN)))
      const deadline = new Date(now().getTime() + wait * 60_000).toISOString()
      await post({ role: 'question', text: args.question, options: args.options, stakes: args.stakes, fallback: args.fallback, deadline })
      if (!attended) state = { ...state!, checkIns: { ...state!.checkIns, date: todayEt, questions: state!.checkIns.questions + 1 } }
      await saveState()
      audit({ tool: tbToolName('ask_operator'), outcome: 'allowed', rule: attended ? 'ok' : 'ok.unattended', detail: `${short(args.question, 100)} · ${wait}m · fallback: ${short(args.fallback, 80)}` })
      const left = attended ? '' : ` You have ${checkInsLeft().questions} unattended question(s) left today.`
      return `Posted. The operator has ${wait} min (until ${formatEt(deadline)}). If they don't answer, you will be woken with trigger "timeout" — do your fallback ("${args.fallback}") unless the context changed. Finish this run now without acting on the undecided thing.${left}`
    },
    async tellOperator(message, urgency) {
      if (toldThisRun) return 'You already told the operator something this run — put anything else in your end-of-run reply.'
      if (!attended && checkInsLeft().tells <= 0) {
        audit({ tool: tbToolName('tell_operator'), outcome: 'blocked', rule: 'checkin.budget', detail: short(message, 120) })
        return `Unattended tell budget for today is spent (${UNATTENDED_TELLS_PER_DAY}/day). Put it in your end-of-run reply instead.`
      }
      toldThisRun = true
      await post({ role: 'agent', text: message, notify: urgency })
      if (!attended) state = { ...state!, checkIns: { ...state!.checkIns, date: todayEt, tells: state!.checkIns.tells + 1 } }
      await saveState()
      return `Sent (${urgency}). Continue; your end-of-run reply still summarizes the run.`
    },
    /**
     * Held, not posted: the report becomes the run's FINAL message, and only
     * the end-of-run settle knows when that is. Posting here would put the
     * summary above whatever the model does next; last call wins for the same
     * reason change_plan takes the newest fields.
     */
    async report(r) {
      pendingReport = r
      const filed = 'Report filed — it will be the run summary. End your run now; do NOT also write a closing summary message.'
      // A report that promises a sleep no `sleep_until` has armed is answered
      // in the result the model reads THIS turn — the cheapest place to make
      // the words and the schedule agree (core/runner/sleepClaim.ts). The
      // lane runs a turn's calls in order, so a `sleep_until` filed before the
      // report is already on `state` here and draws no advice.
      if (reportClaimsSleep(r) && !activeSleep(state, now())) {
        const at = now()
        return `${filed}

${sleepClaimAdvice(nextWakeAt(cfg, state!, at))}`
      }
      return filed
    }
  }

  /**
   * ONE WRITER AT A TIME. Every handler above follows snapshot → await →
   * assign on the shared `state`, and the OpenRouter SDK executes a turn's
   * tool calls CONCURRENTLY — six buys in one turn meant six handlers racing
   * the same base snapshot, and only the LAST fill survived, in memory and in
   * the store (positions "vanished" while their trade cards said filled). The
   * lane makes each host call start only after the previous one settled; the
   * gate's `vet`/`afterTool` ride the same lane below because they mutate the
   * same `state` (pendingAction, direct-order bookkeeping). See serial.ts.
   *
   * The cast is the price of wrapping 16 methods generically; `ToolHost` is
   * all promise-returning methods, which is exactly what the lane preserves.
   */
  const exclusive = exclusiveLane()
  const host: ToolHost = Object.fromEntries(
    Object.entries(hostImpl).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        // A host call after the run settled would write into a state the run
        // has already saved (see `runEnded`). The gate refuses first; this is
        // the second lock on the same door.
        if (runEnded) return Promise.reject(new Error(RUN_OVER_MSG))
        return exclusive(() => (fn as (...a: unknown[]) => Promise<unknown>).apply(hostImpl, args))
      }
    ])
  ) as unknown as ToolHost

  // ── Tool gate + remote MCP servers (vendor-neutral) ─────────────────────
  const remote: RemoteMcpServer[] = []
  if (bearer) remote.push({ name: ROBINHOOD_SERVER_NAME, spec: buildRobinhoodServer(bearer) })
  for (const [name, spec] of Object.entries(intel.servers)) remote.push({ name, spec })
  const allow = (name: string): boolean => TB_TOOL_NAMES.includes(name) || (bearer !== null && isRobinhoodToolAllowed(name, rhCtx)) || isIntelToolAllowed(name, intel.servers)
  const repeats = new RepeatDetector()

  // Direct order tools (when the operator exposed them): the SAME guardrails the
  // `trade` tool uses vet every place_equity_order before it reaches Robinhood,
  // and the after-tool hook books what was placed so the sub-ledger stays true.
  const PLACE_TOOL = robinhoodToolName('place_equity_order')
  const CANCEL_TOOL = robinhoodToolName('cancel_equity_order')
  const vetDirectOrder = async (input: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; rule?: GuardrailRule }> => {
    const intent = intentFromDirectOrder(input)
    let ref = quotes.find((q) => q.symbol === intent.symbol)?.last ?? null
    if (!ref && feed && intent.symbol) {
      try {
        ref = (await feed.quotes([intent.symbol])).quotes[0]?.last ?? null
      } catch {
        /* limit price still sizes the check */
      }
    }
    // Direct orders are Robinhood tools, so `rh` is what "connected" means here.
    const v = checkGuardrails({ config: cfg, state: state!, intent, refPrice: ref, now: now(), trigger: req.trigger, brokerAccountType: cfg.mode === 'live' ? account?.type ?? null : null, tradingHalted, brokerConnected: rh !== null })
    return v.ok ? { ok: true, rule: v.rule } : { ok: false, reason: v.reason, rule: v.rule }
  }
  const bookDirectOrder = async (input: Record<string, unknown>, response: unknown): Promise<void> => {
    const intent = intentFromDirectOrder(input)
    const { orderId, state: ordState } = orderFromToolResponse(response)
    const rejected = !!ordState && /reject|fail|cancel/i.test(ordState)
    const ref = quotes.find((q) => q.symbol === intent.symbol)?.last
    const qty = intent.qty ?? (intent.notional && ref ? Math.floor((intent.notional / ref) * 1e6) / 1e6 : 0)
    const today = etClock(now()).date
    if (!rejected) {
      const ordersToday = state!.ordersToday.date === today ? { date: today, count: state!.ordersToday.count + 1 } : { date: today, count: 1 }
      const openOrders = orderId
        ? [...state!.live.openOrders, { id: orderId, ts: now().toISOString(), symbol: intent.symbol, side: intent.side, qty, type: intent.type, limitPrice: intent.limitPrice, status: 'open' as const }]
        : state!.live.openOrders
      state = { ...state!, ordersToday, live: { ...state!.live, openOrders } }
      // Counted only when the broker took it — a rejected direct order is a
      // card, not an action, same rule as `host.trade`.
      actions++
    }
    await post({ role: 'action', action: { ...intent, qty, mode: 'live', status: rejected ? 'rejected' : 'open', orderId, refPrice: ref, error: rejected ? `Robinhood ${ordState}` : undefined } })
    await saveState()
  }
  const bookDirectCancel = async (input: Record<string, unknown>): Promise<void> => {
    const id = String(input.order_id ?? input.orderId ?? '')
    if (!id || !state!.live.openOrders.some((o) => o.id === id)) return
    state = { ...state!, live: { ...state!.live, openOrders: state!.live.openOrders.filter((o) => o.id !== id) } }
    await saveState()
  }
  /**
   * Money-moving tools. The tb ones are named outright; Robinhood's are matched
   * by SHAPE, so a write tool we have never heard of is held rather than waved
   * through on the strength of not being in a list.
   */
  /**
   * Option writes the engine cannot stand behind. `checkGuardrails`, the
   * sub-ledger, the daily-loss lock and the exit watcher all speak equities: an
   * option order placed directly would be bounded by nothing, would never
   * appear in the agent's book, and could not be protected by a stop. Matched by
   * GROUP rather than by name, so a contract tool we have never heard of is
   * refused on the same reasoning.
   */
  const movesMoney = (name: string): boolean => {
    const bare = robinhoodBareName(name)
    if (bare !== null) return robinhoodToolKind(bare) === 'write'
    return TB_TOOL_NAMES.includes(name) && isWriteTool(name.slice(`mcp__${TB_SERVER_NAME}__`.length))
  }

  /**
   * Option writes the engine cannot stand behind. `checkGuardrails`, the
   * sub-ledger, the daily-loss lock and the exit watcher all speak equities: an
   * option order placed directly would be bounded by nothing, would never
   * appear in the agent's book, and could not be protected by a stop. Matched by
   * GROUP rather than by name, so a contract tool we have never heard of is
   * refused on the same reasoning.
   */
  const isOptionWrite = (name: string): boolean => {
    const bare = robinhoodBareName(name)
    if (bare === null) return false
    const kind = robinhoodToolKind(bare)
    return kind === 'write' && robinhoodToolGroup(bare, kind) === 'options'
  }

  /**
   * The stall. A non-autonomous agent that reaches for money either spends the
   * approval it was woken with, or posts a card and stops. Returns null to let
   * the call through, or the refusal the model reads as its tool result.
   *
   * The one-time pass is spent on first use: a second order in the same run is a
   * second decision, and gets its own card.
   */
  const holdForApproval = async (name: string, input: Record<string, unknown>): Promise<{ ok: false; message: string } | null> => {
    if (approved && !approvalUsed) {
      // The definition may have changed while the card sat pending —
      // approvals have no deadline by design, so "pending across an app
      // update" is a supported state, not an edge case. Checked HERE rather
      // than inside `approvalCovers` because that function lives in
      // `src/shared`, which holds no tool definitions to hash; a second
      // implementation is exactly what shared exists to prevent.
      //
      // Only a MISMATCH refuses. An absent hash on either side means "no
      // opinion" — a card written before this shipped, or a Robinhood write
      // tool discovered from the live server — and treating absence as a
      // mismatch would invalidate every approval in flight the day this
      // deployed.
      const nowHash = toolDefinitionHash(name)
      if (approved.toolHash && nowHash && approved.toolHash !== nowHash) {
        const why = `the ${name.replace(/^mcp__[a-z]+__/, '')} tool changed after the operator approved this, so their yes was for a different action`
        audit({ tool: name, outcome: 'blocked', rule: 'approval.staleDefinition', detail: why })
        return { ok: false, message: outsideApprovalMessage(why) }
      }
      const covers = approvalCovers(approved, name, input)
      if (covers.ok) {
        approvalUsed = true
        audit({ tool: name, outcome: 'allowed', rule: 'approval.granted', detail: approved.summary })
        return null
      }
      // Not what was approved. Now that a pass PERSISTS across runs, a plain
      // block here would stall every other write for up to three days on a yes
      // the agent no longer intends to use — so the old pass is set aside (its
      // card says so) and this request falls through to get its own card. The
      // operator's yes is only kept alive while the agent still wants exactly
      // that action.
      audit({ tool: name, outcome: 'blocked', rule: 'approval.superseded', detail: covers.why })
      const oldCard = approvalCard(approved.id)
      if (oldCard) await deps.storage.updateMessage({ ...oldCard, status: 'withdrawn', answeredAt: now().toISOString(), outcome: approvalSupersededOutcome() })
      await post({ role: 'system', kind: 'info', text: approvalSupersededNote(approved.summary) })
      approved = null
      await patch({ pendingAction: null })
    }
    const open = state!.pendingAction
    if (open) {
      audit({ tool: name, outcome: 'blocked', rule: 'approval.alreadyPending', detail: open.summary })
      return { ok: false, message: alreadyHeldMessage(open.summary) }
    }
    const symbol = typeof input.symbol === 'string' ? input.symbol.toUpperCase() : undefined
    const pending: PendingAction = {
      id: newId('pa_'),
      tool: name,
      args: input,
      summary: describeHeldAction(name, input),
      reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'No reason given.',
      symbol,
      side: input.side === 'buy' || input.side === 'sell' ? input.side : undefined,
      // The price it decided against. Without this, an answer hours later has
      // nothing to be measured against and approval is just a rubber stamp.
      quote: symbol ? quotes.find((q) => q.symbol === symbol)?.last : undefined,
      toolHash: toolDefinitionHash(name),
      requestedAt: now().toISOString()
    }
    await post({ role: 'approval', action: pending, status: 'pending' })
    await patch({ pendingAction: pending })
    audit({ tool: name, outcome: 'blocked', rule: 'approval.held', detail: pending.summary })
    traced('approval', () => trace?.event('approval_held', { tool: name, summary: pending.summary }))
    log('info', `held for approval: ${pending.summary} (${cfg.id})`)
    return { ok: false, message: heldMessage(pending.summary) }
  }

  const gateImpl: ToolGate = {
    // Asked while assembling the tool list — never audited, because a tool that
    // is not offered was never refused.
    permits: (name) => allow(name),
    allow(name) {
      if (allow(name)) return true
      audit({ tool: name, outcome: 'blocked', rule: 'policy.toolNotAllowed' })
      return false
    },
    async vet(name, input) {
      // A tool is genuinely about to RUN. `vet` is reached only from
      // `gateToolCall`, i.e. per actual call — unlike `allow`, which every
      // vendor also calls while building its tool list. Stamping there gave the
      // long tool budget to the model's first-token wait on every run.
      toolPendingSince = Date.now()
      pendingToolName = name
      // Loop guard first: it applies to every tool, and a run going in circles
      // should be stopped before its 6th identical Robinhood call, not after.
      const rep = repeats.note(name, input)
      if (rep.action === 'block') {
        audit({ tool: name, outcome: 'blocked', rule: 'loop.repeatedCall', detail: `identical call ×${rep.count}` })
        log('warn', `loop guard: ${name} ×${rep.count} (${cfg.id})`)
        return { ok: false, message: repeatBlockMessage(name, rep.count) }
      }
      if (rep.action === 'warn' && rep.count === 3) log('info', `repeated tool call: ${name} ×${rep.count} (${cfg.id})`)

      // Options never reach the broker. Refused outright rather than held for
      // approval, because an operator saying yes would not make the order any
      // more bounded — there is no guardrail, no book entry and no exit for it.
      if (isOptionWrite(name)) {
        audit({ tool: name, outcome: 'blocked', rule: 'policy.optionsUnsupported' })
        return {
          ok: false,
          message:
            'This engine places US equity orders only — it cannot place, cancel or exercise option orders. None of your guardrails, your book, or your stop/target watcher would apply to one, so it is refused even though the operator enabled the tool. If options are genuinely what your task needs, say so plainly and let the operator place it themselves.'
        }
      }

      // Guardrails BEFORE approval: an order the engine would refuse anyway is
      // not worth waking the operator for.
      let pinned: Record<string, unknown> | null = null
      if (name === PLACE_TOOL) {
        const v = await vetDirectOrder(input)
        if (!v.ok) {
          audit({ tool: name, outcome: 'blocked', rule: v.rule ?? 'guardrails.rejected', detail: v.reason })
          return { ok: false, message: `Blocked by your guardrails: ${v.reason} Use the trade tool or adjust the order.` }
        }
        audit({ tool: name, outcome: 'allowed', rule: v.rule ?? 'ok', detail: short(input, 160) })
        // Pin the order to the agentic account the engine resolved.
        if (accountNumber && !input.account_number) pinned = { ...input, account_number: accountNumber }
      }
      // Nothing this agent does with money happens without the operator, unless
      // they set it loose.
      if (!autonomous && movesMoney(name)) {
        const held = await holdForApproval(name, input)
        if (held) return held
      }
      return pinned ? { ok: true, input: pinned } : { ok: true }
    },
    async afterTool(name, input, output) {
      if (name === PLACE_TOOL) await bookDirectOrder(input, output)
      else if (name === CANCEL_TOOL) await bookDirectCancel(input)
    }
  }
  // `vet` and `afterTool` mutate the same `state` the host does (pendingAction
  // cards, direct-order bookkeeping), so they share the host's lane. Serializing
  // them also keeps hold-for-approval single-slot under parallel calls: the
  // second call's vet runs after the first's card is in state, and reads it.
  // The literal above defines both, so the assertions hold by construction.
  const vetImpl = gateImpl.vet!
  const afterToolImpl = gateImpl.afterTool!
  const gate: ToolGate = {
    ...gateImpl,
    // Refused, not audited: a call that arrives after the run ended is not a
    // policy decision about the agent, it is a vendor loop outliving its run.
    vet: (name, input) => (runEnded ? Promise.resolve({ ok: false as const, message: RUN_OVER_MSG }) : exclusive(() => vetImpl(name, input))),
    afterTool: (name, input, output) => (runEnded ? Promise.resolve() : exclusive(() => afterToolImpl(name, input, output)))
  }

  // ── Vendor run ──────────────────────────────────────────────────────────
  // The host decides which vendors exist; the agent's own model picks one.
  const vendorId = cfg.model.vendor
  const runner = deps.vendors[vendorId]
  const model: ModelChoice = cfg.model

  // The run's own deadline and the operator's Stop. Each ATTEMPT gets its own
  // controller underneath, so a stalled attempt can be killed and retried
  // without the retry inheriting an already-aborted signal.
  //
  // ABORT WITH NO REASON, DELIBERATELY. Passing `new Error(...)` makes that
  // Error the signal's reason, and libraries that special-case the standard
  // AbortError — swallowing it as "the caller asked me to stop" — see a
  // foreign Error instead and treat it as a genuine failure. One of them
  // rejected a promise nobody was awaiting, which crashed the whole runner
  // process and left every in-flight agent locked until its TTL expired.
  // The human-readable cause is carried in `stalled` / `abortReason` instead,
  // where it belongs: on our side, not in a value we hand to third-party code.
  const outer = new AbortController()
  let abortReason: string | null = null
  const onAbort = (): void => {
    abortReason = 'Run cancelled'
    runEnded = true
    outer.abort()
  }
  req.abort?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => {
    abortReason = 'Run exceeded the time limit'
    runEnded = true
    outer.abort()
  }, RUN_TIMEOUT_MS)

  const STALL_MSG = `Stalled: the model sent nothing for ${Math.round(STALL_TIMEOUT_MS / 1000)}s`
  /**
   * Which attempt is allowed to speak. Aborting a stalled attempt does not stop
   * it instantly — an in-flight stream can keep yielding for a moment after the
   * signal fires — so without this the dying attempt's tokens interleave,
   * character by character, with the replacement's. Both carry the same runId,
   * so no consumer downstream can tell them apart; it has to be settled here.
   */
  let liveAttempt = 0
  const runAttempt = async (resumeId: string | null): Promise<{ result: VendorRunResult; stalled: boolean; degenerate?: string }> => {
    const gen = ++liveAttempt
    // One span per attempt in the trace: a retry regenerates from scratch, so
    // each attempt keeps its own model steps and tool calls.
    const at = trace
      ? (() => {
          try {
            return trace.attempt(gen)
          } catch (err) {
            log('warn', `trace attempt failed: ${(err as Error).message}`)
            return null
          }
        })()
      : null
    const finishAttempt = (r: VendorRunResult, stalledNow: boolean, degenerateNow?: string): void => {
      if (!at) return
      traced('attempt end', () => {
        at.toolCalls(r.toolCalls)
        at.end({ error: r.error, stalled: stalledNow, degenerate: degenerateNow, stoppedBecause: r.stoppedBecause, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens, costUsd: r.costUsd, modelUsed: r.modelUsed })
      })
    }
    /**
     * ONE guard per attempt, created here rather than outside, and fed
     * from inside `attemptEmit` — which is the only place in the codebase where
     * a superseded attempt's deltas have already been dropped.
     *
     * That placement is the whole correctness argument. A retry REGENERATES the
     * reply from scratch, so a guard spanning attempts would see the abandoned
     * partial followed by the new attempt saying much the same thing and call
     * a healthy retried run degenerate. That is a false POSITIVE — it kills
     * good runs — so failing open on the time budget does not protect against
     * it. Per-attempt, downstream of the `gen` check, is what does.
     */
    const guard = createStreamGuard()
    let degenerate: string | undefined
    /** Deltas from a superseded attempt are dropped, including for the stall clock: a dead attempt must not keep the watchdog alive. */
    const attemptEmit = (delta: Parameters<typeof emit>[0]): void => {
      if (gen !== liveAttempt) return
      // A killed attempt's stragglers — the SDK loop noticing its refused tool
      // calls after we stopped reading its stream — would otherwise reopen a
      // live bubble on a run the thread has already closed.
      if (attempt.signal.aborted) return
      // The first delta is the moment setup ended and the model started
      // talking; from here the short window is the right one.
      heardFromModel = true
      // Only what the model WROTE. Tool results are other people's text — a
      // quote table repeats by nature and is not the model losing its place.
      if (delta.kind === 'text' || delta.kind === 'thinking') {
        const v = guard.push(delta.text)
        if (v.kind === 'stop' && !degenerate) {
          degenerate = v.reason ?? 'the model repeated itself without progressing'
          log('warn', `run cut off — degenerate output: ${degenerate} (${cfg.id})`)
          attempt.abort()
        }
      }
      emit(delta)
    }
    if (!runner) {
      return {
        result: {
          texts: [],
          thinking: [],
          toolCalls: [],
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          sessionId: null,
          stoppedBecause: 'natural',
          error: `${VENDOR_LABEL[vendorId]} is not connected on this host — open Connections and connect it, or switch the agent's model.`
        },
        stalled: false
      }
    }
    const attempt = new AbortController()
    // Forward the cancellation, not a reason — same rule as above. The cause is
    // already in `abortReason`; handing a foreign value to third-party code is
    // what started this.
    const linkOuter = (): void => attempt.abort()
    outer.signal.addEventListener('abort', linkOuter, { once: true })
    // Watch ACTIVITY, not duration: a run streaming tool calls is working, a run
    // that has emitted nothing at all is wedged.
    lastActivityAt = Date.now()
    let stalled = false
    // Nothing has been heard from this attempt yet, so the clock is measuring
    // setup (tool discovery, MCP handshakes) rather than the model.
    let heardFromModel = false
    const stallTimer = setInterval(() => {
      if (attempt.signal.aborted) return
      // A tool that is RUNNING gets the longer budget. `toolPendingSince` is a
      // timestamp rather than a counter precisely so it cannot leak: a refused
      // vet, a throwing tool or a vendor that skips its bookkeeping all leave a
      // stale timestamp that the next emit overwrites, where a stuck counter
      // would disable the watchdog for the rest of the run.
      // `>=`, not `>`. The tool-call delta and the allow() that follows it land
      // in the same millisecond often enough that a strict comparison made the
      // longer budget unreachable — the fix would have been a no-op most of the
      // time, and only intermittently, which is the worst way for it to fail.
      const inTool = toolPendingSince >= lastActivityAt
      const budget = !heardFromModel ? SETUP_TIMEOUT_MS : inTool ? toolStallBudget(pendingToolName) : STALL_TIMEOUT_MS
      const silentFor = Date.now() - Math.max(lastActivityAt, toolPendingSince)
      if (silentFor < budget) return
      stalled = true
      // Say WHICH kind of silence. "the model sent nothing" was printed for a
      // run sitting in a tool, and again for one still building its tool list —
      // both times the wrong thing to go looking for.
      const what = !heardFromModel ? 'still starting up (tool discovery) after' : inTool ? `tool "${pendingToolName}" has run for` : 'no activity for'
      log('warn', `run stalled — ${what} ${Math.round(silentFor / 1000)}s (${cfg.id})`)
      attempt.abort()
    }, 5_000)
    try {
      const result = await runner.run({
        model,
        agentId: cfg.id,
        systemPrompt,
        prompt: runPrompt,
        tools: agentTools,
        host,
        remote,
        gate,
        maxTurns: MAX_TURNS,
        resumeSessionId: resumeId,
        cwd: deps.cwd,
        abort: attempt,
        emit: attemptEmit,
        log,
        ...(at
          ? {
              onModelStep: (step) => {
                // The attempt's span is closed once it is aborted; a step the
                // SDK finishes afterwards belongs to no run the trace knows.
                if (attempt.signal.aborted) return
                traced('model step', () => at.modelStep(step))
              }
            }
          : {})
      })
      // `push` scans only on a 512-char boundary, so the final partial chunk is
      // never seen by it — a reply that degenerates in its last few hundred
      // characters would be missed entirely. The end-of-stream verdict is the
      // authoritative one.
      if (!degenerate) {
        const v = guard.verdict()
        if (v.kind === 'stop') degenerate = v.reason ?? 'the model repeated itself without progressing'
      }
      // A stalled attempt may return a bare "aborted" — name the real cause.
      // A degenerate one likewise: aborting it leaves whatever the vendor had,
      // which is usually nothing or a bare "aborted", and the operator needs to
      // know the run was cut for looping rather than for failing.
      // The run-level deadline is the third case, and it was the one left
      // unnamed: a vendor cut off by `RUN_TIMEOUT_MS` returns its own abort
      // text ("This operation was aborted", "Request aborted by client:
      // AbortError: …"), which would be persisted as `error` while
      // `stopReason` said `timeout`. The cause is ours and is
      // already in `abortReason`; the vendor's wording is about a signal, not a
      // reason, and the operator reading it cannot tell a timeout from a crash.
      const named = stalled ? STALL_MSG : degenerate ? `Stopped: ${degenerate}` : result.error && outer.signal.aborted && abortReason ? abortReason : undefined
      const settled = named ? { ...result, error: named } : result
      finishAttempt(settled, stalled, degenerate)
      return { result: settled, stalled, degenerate }
    } catch (err) {
      // A vendor is supposed to fold its failures into `out.error`. If one ever
      // rejects instead, this run fails — the other agents must not. An escaping
      // rejection would propagate out of runOnce and take the engine with it.
      const message = stalled ? STALL_MSG : degenerate ? `Stopped: ${degenerate}` : abortReason ?? (err as Error)?.message ?? String(err)
      log('warn', `vendor threw instead of returning an error: ${short(message, 160)} (${cfg.id})`)
      const failed = { ...emptyResult(), error: message }
      finishAttempt(failed, stalled, degenerate)
      return { result: failed, stalled, degenerate }
    } finally {
      clearInterval(stallTimer)
      outer.signal.removeEventListener('abort', linkOuter)
    }
  }

  let result: VendorRunResult
  /** Whether the attempt we ENDED on was killed by the stall watchdog — see stopReason. */
  let stalledRun = false
  try {
    // `runStartedAt` is the run's ENTRY instant, not this save: an operator
    // message stamped while the context was still being built is just as
    // unanswered by this run as one sent mid-stream, and both should read as
    // queued (shared/messageQueue.ts).
    state = { ...state, running: true, runStartedAt: startedAt.toISOString(), runId, status: state.status === 'paused' ? 'paused' : 'running' }
    await saveState()
    let resumable = vendorId === 'claude' ? state.sessionId : null
    let retries = 0
    /** The one re-ask a silent turn gets (see the loop). */
    let nudged = false
    for (;;) {
      const attempt = await runAttempt(resumable)
      result = attempt.result
      stalledRun = attempt.stalled
      if (outer.signal.aborted) break
      if (!result.error) {
        // A SILENT TURN: the model reasoned ("save one lesson, then report")
        // and ended its turn without a tool call or a word of reply, so
        // nothing it planned happened and the thread got "Run finished with
        // no reply." It happens — occasionally on a live agent mid-position.
        // It is asked ONCE more, with the run prompt carrying the reason; a
        // second silence is reported as before. Not a transient retry — it
        // does not count against MAX_TRANSIENT_RETRIES and waits for nothing.
        if (!nudged && result.toolCalls.length === 0 && !result.texts.join('').trim() && result.thinking.join('').trim()) {
          nudged = true
          log('warn', `silent turn — the model reasoned and stopped without acting; asking once more (${cfg.id})`)
          emit({ kind: 'retry', attempt: 1, delayMs: 0, reason: SILENT_TURN_REASON })
          traced('retry', () => trace?.event('retry', { attempt: 1, delayMs: 0, reason: SILENT_TURN_REASON }))
          runPrompt = `${runPrompt}\n\n${SILENT_TURN_NUDGE}`
          continue
        }
        break
      }
      // Context-overflow self-heal: a resumed session that outgrew the window
      // can NEVER recover by resuming — retry immediately on a fresh session.
      if (resumable && isContextOverflow(result.error)) {
        log('warn', `session overflow — retrying fresh (${cfg.id})`)
        state = { ...state, sessionId: null }
        resumable = null
        continue
      }
      // Capacity, rate limits and dead sockets deserve another try; bad
      // credentials and unknown models do not (core/runner/retry.ts).
      // A stall is transient — the same prompt may well succeed. Degeneracy is
      // NOT: the model looped on this input, and handing it the identical input
      // again is the definition of expecting a different result.
      const klass = attempt.degenerate ? 'terminal' : attempt.stalled ? 'transient' : classifyRunError(result.error)
      if (klass !== 'transient' || retries >= MAX_TRANSIENT_RETRIES) break
      retries++
      const delayMs = retryDelayMs(retries)
      const reason = short(result.error, 120)
      log('warn', `transient failure — retry ${retries}/${MAX_TRANSIENT_RETRIES} in ${delayMs}ms: ${reason}`)
      emit({ kind: 'retry', attempt: retries, delayMs, reason })
      traced('retry', () => trace?.event('retry', { attempt: retries, delayMs, reason }))
      if (!(await sleepUnlessAborted(delayMs, outer.signal))) break
      // Never resume into whatever a wedged attempt left behind.
      if (attempt.stalled && resumable) {
        state = { ...state, sessionId: null }
        resumable = null
      }
    }
  } finally {
    clearTimeout(timeout)
    req.abort?.removeEventListener('abort', onAbort)
    runEnded = true
  }

  const cancelled = req.abort?.aborted === true
  /**
   * Calls the vendor announced and never finished — the model asked for them,
   * the run ended (deadline, Stop, a vendor failure) before they could execute,
   * and until now they sat in the thread as "4 steps" with no verdict at all.
   * A timeout is the case: the reply says "setting the Friday-close
   * retirement", the change_plan behind it never runs, and nothing on screen
   * disagrees with the reply. They are marked failed here, and the failure
   * note below names them.
   */
  const unfinished = result.toolCalls.filter((t) => t.output === undefined && !t.blocked)
  for (const t of unfinished) {
    t.output = NOT_RUN_MSG
    t.result = NOT_RUN_MSG
    t.error = true
  }
  const notRunNote = unfinished.length ? ` ${unfinished.length === 1 ? 'One step it had started' : `${unfinished.length} steps it had started`} (${unfinished.map((t) => t.name.replace(/^mcp__\w+__/, '')).join(', ')}) never ran.` : ''
  // REDACTED ONCE, HERE. A vendor's error text reaches places that outlive
  // the run — a thread message, `RunRecord.error`, notifications — and
  // an intel MCP failure carries its request URL, which carries the operator's
  // API key (`?apikey=…`). Redacting at the single point where the run's error
  // is settled covers all three; redacting at each display would eventually
  // miss one.
  const error = cancelled ? undefined : result.error ? redactSecrets(result.error) : undefined
  // Tool-call markup written as prose is removed from what the operator reads
  // (the trace keeps the raw turn).
  const stripped = stripLeakedMarkup(result.texts.join('\n'))
  if (stripped.leaked) {
    log('warn', `reply carried tool-call markup as text — ${stripped.removed} chars removed (${cfg.id})`)
    traced('markup_leak', () => trace?.event('markup_leak', { removed: stripped.removed }))
  }
  const finalText = stripped.text.trim()

  if (finalText || pendingReport) {
    // ONE message per run stays the invariant: a filed report RIDES the final
    // message rather than adding a second. `text` always carries a readable
    // twin — the model's own prose when it wrote any, else the report's
    // composed fallback — so the transcript block, previews, notifications and
    // records that predate reports never see a blank message.
    const text = finalText || (pendingReport ? reportFallbackText(pendingReport) : '')
    // The operator asked → the answer notifies them. Other runs stay quiet unless the agent used tell_operator.
    await post({
      role: 'agent',
      text,
      ...(pendingReport ? { report: pendingReport } : {}),
      // The whole chain of thought the thread can show, not its first page: 4,000
      // characters ended mid-sentence on most runs that reasoned at all.
      thinking: result.thinking.length ? result.thinking.join('\n\n').slice(0, THINKING_KEEP_CHARS) : undefined,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      notify: req.trigger === 'reply' ? 'fyi' : undefined
    })
  }
  // The report still says "sleep" and nothing slept: the header will count
  // down to the schedule's tick while the card names a later date. Say which
  // one the engine will do, under the reply, so the thread tells one story
  // (see core/runner/sleepClaim.ts).
  if (pendingReport && !error && !cancelled && !sleepTouched && reportClaimsSleep(pendingReport) && !activeSleep(state, now())) {
    const at = now()
    const next = state.status === 'paused' || state.status === 'retired' ? null : nextWakeAt(cfg, state, at)
    log('warn', `report claimed a sleep but sleep_until was never called (${cfg.id})`)
    traced('sleep_claim', () => trace?.event('sleep_claim_unarmed', { next: next?.toISOString() ?? null, claim: pendingReport?.next ?? pendingReport?.headline }))
    await post({ role: 'system', kind: 'schedule', text: sleepClaimNote(next) })
  }
  // The failure note is posted WHETHER OR NOT the model got some text out.
  // It used to be the `else` of the branch above, so a run that timed out
  // mid-work — the model had already streamed a paragraph, then the deadline
  // killed it between a buy and its `set_exit` — posted that paragraph as an
  // ordinary reply and nothing else. The thread read as a finished run; the row
  // said `ok: false`; the operator had no way to know from the thread that the
  // agent was cut off (every timed-out run looked like this).
  if (error) {
    await post({
      role: 'system',
      kind: 'error',
      text: `Run failed: ${short(error, 300)}${finalText && actions > 0 ? ' — it was cut off after acting, so check any position it opened has the protection it intended.' : finalText ? ' — the reply above is where it got to before it stopped.' : ''}${notRunNote}`
    })
  } else if (cancelled) {
    // The operator's Stop leaves a mark — otherwise the thread shows a reply
    // that simply trails off, or nothing at all.
    await post({ role: 'system', kind: 'info', text: `${LIFECYCLE.runStopped(Boolean(finalText))}${notRunNote}` })
  } else if (!finalText && !pendingReport && result.toolCalls.length === 0) {
    // Only when the model produced NOTHING. This used to fire on `toolCalls`
    // alone, so a run that answered in prose without touching a tool posted its
    // reply and then "Run finished with no reply." under it.
    await post({ role: 'system', kind: 'info', text: 'Run finished with no reply.' })
  }
  // A run that was CUT OFF is not a run that finished. Until now this was
  // silent: the loop simply ended, no vendor set an error, and because there
  // WERE tool calls nothing was posted — so the operator saw an order card with
  // no explanation and a run recorded as ok. If the cut landed between a buy and
  // its set_exit, the position was unprotected and nothing said so.
  //
  // The note names the LIMIT, never the number: what a run costs us is our cost
  // structure, not the operator's business. The log
  // line and `stoppedBecause` stay free to carry the detail.
  if (!cancelled && !error && (result.stoppedBecause === 'turns' || result.stoppedBecause === 'cost')) {
    const limit = result.stoppedBecause === 'turns' ? 'step limit' : 'budget limit'
    await post({
      role: 'system',
      kind: 'info',
      text: `⚠️ This run hit its ${limit} and stopped early, so the agent may not have finished what it started${actions > 0 ? ' — check any position it opened has the protection it intended' : ''}.`
    })
    log('warn', `run cut off by ${result.stoppedBecause} after ${result.toolCalls.length} tool call(s) (${cfg.id})`)
  }

  /**
   * WHY the run stopped, on the row.
   *
   * The distinction was never lost in memory — `cancelled`, `stalled`,
   * `abortReason` and `stoppedBecause` all exist and are all used — it was
   * discarded at the row. An operator-cancelled run persisted as
   * `ok: true, error: undefined`: byte for byte a clean run.
   *
   * One discriminant rather than flags, so "cancelled AND timed out" is
   * unrepresentable. Order matters: `cancelled` wins over everything because
   * an operator pressing Stop is the reason, whatever else was in flight, and
   * `stalled` outranks `timeout` because a stall aborts the ATTEMPT and the
   * run-level timeout may fire moments later on the way out.
   *
   * `ok` stays TRUE for a cancellation: a person stopping a run is not a
   * failure, and the discriminant is what makes it distinguishable without
   * lying about success.
   *
   * Undefined is never defaulted — a historical row we never measured must not
   * be handed `'natural'`, which would invent a fact about the past.
   */
  const stopReason: RunRecord['stopReason'] = cancelled
    ? 'cancelled'
    : stalledRun
      ? 'stalled'
      : abortReason === 'Run exceeded the time limit'
        ? 'timeout'
        : error
          ? 'error'
          : result.stoppedBecause === 'turns' || result.stoppedBecause === 'cost'
            ? result.stoppedBecause
            : 'natural'

  const endedAt = now()
  const run: RunRecord = {
    id: runId,
    agentId: cfg.id,
    trigger: req.trigger,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    ok: !error,
    error,
    // What RAN, not what we asked for: OpenRouter may answer on a fallback model,
    // and the run record's `model` is what says which model the operator paid for.
    // `modelUsed` is undefined for vendors that cannot report it — then the
    // requested id is the honest best answer, not a guess.
    model: `${model.vendor}:${result.modelUsed ?? (model.vendor === 'openrouter' ? openRouterModelFor(model.id) : model.id)}`,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cachedTokens: result.cachedTokens,
    costUsd: result.costUsd,
    toolCalls: result.toolCalls.length,
    actions,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    // The book as this run leaves it and the code that served it — the two
    // facts that otherwise have to be reconstructed from trade cards and
    // timestamps. See RunRecord.book / RunRecord.build.
    book: runBookSummary(cfg.mode, cfg.mode === 'live' ? state.live : state.paper, Object.fromEntries(quotes.map((q) => [q.symbol, q.last]))),
    build: deps.build,
    // The trace this row joins to — the prompts, steps, calls and decisions
    // behind these numbers live there (core/trace/types.ts).
    ...(trace ? { traceId: trace.id } : {}),
    stopReason,
    // Computed AFTER the run, because the apportionment anchors on the
    // vendor's reported total and that is only known once it has answered.
    ...(() => {
      const b = promptBreakdown({ systemPrompt, toolsJson, blocks: promptBlocks, contextTokens: result.contextTokens })
      return {
        promptCategories: b.categories,
        // Absence stays absence: when the vendor reported no total there is
        // nothing to leave unaccounted, and a persisted 0 would read as
        // "everything was attributed" — which is the opposite of the truth.
        ...(b.unaccountedTokens === undefined ? {} : { promptUnaccountedTokens: b.unaccountedTokens })
      }
    })(),
    // The FULL footprint of the last model call, fresh + cached. The prompt
    // breakdown cannot anchor on `inputTokens`: the vendors do not agree on whether it includes
    // cache reads, and the residual goes negative on Claude.
    //
    // `|| undefined`, because `VendorRunResult.contextTokens` is REQUIRED and
    // seeded to 0 (`vendors/shared.ts` emptyResult). A real prompt is never 0
    // tokens, so a persisted 0 always means "no usage reported" — storing it
    // as a number would make a missing measurement indistinguishable from a
    // measured one, and force every reader to re-derive that. Absent and zero
    // are different facts.
    contextTokens: result.contextTokens || undefined
  }
  // The run must still settle (state, next wake-up, thread) whatever happens
  // to its record — but the record is what the stats and the run history read,
  // so its absence is an error in the log, not a silence.
  await deps.storage.appendRun(run).catch((err: Error) => log('error', `run record not stored for run ${runId} (${cfg.id}): ${err.message}`))

  // `nextWakeAt`, not the schedule: an agent that put itself to sleep this run
  // wakes at the sleep, and the schedule waits behind it.
  const next = state.status === 'paused' || state.status === 'retired' ? null : nextWakeAt(cfg, state, endedAt)
  // Session hygiene (Claude only): drop a poisoned (overflowed) session; rotate
  // proactively past the token threshold — continuity lives in the re-injected
  // state blocks, so other vendors simply never keep a session.
  // The vendor that actually RAN, not a computed delta — the delta
  // is the reader's job (`composeRunPrompt` defaults `previousVendor` from
  // this). Taken from `model.vendor`, the choice this run really used, so a
  // provider switch landing mid-run cannot make us record the wrong one.
  // Never defaulted when absent: backfilling it would either silence every
  // pre-existing agent forever or fire all of them once, wrongly.
  const nextSession = vendorId !== 'claude' ? null : error && isContextOverflow(error) ? null : shouldRotateSession(result.contextTokens, model) ? null : (result.sessionId ?? state.sessionId)
  // The pass's LAST spend point. `host.trade` settles its own grants (spend on
  // success, hand back on rejection); every other grantable write — set_exit,
  // cancel_order, retire, a direct Robinhood order — spends here at run end,
  // where "the granted call ran and was not handed back" is finally known.
  // Without this, a pass covering a non-trade tool would re-grant the same call
  // run after run until it expired.
  if (approvalUsed && approved) {
    approved = null
    state = { ...state, pendingAction: null }
  } else if (approved && !approvalUsed && !error && !cancelled && attended && req.trigger !== 'reply' && isRegularSession(endedAt) && state.pendingAction?.id === approved.id) {
    // The review run: the agent was handed its pass with the market OPEN and
    // asked to decide again against the price now — and did not act. That is
    // a decision, and the pass is spent by it. Kept only when the review could
    // not act (market closed, a failed or stopped run) or the operator was
    // merely talking (`reply`) — the Friday-approve → Monday-execute case the
    // persistence exists for. Left parked, a declined pass came back on every
    // run until it expired three days later.
    const card = approvalCard(approved.id)
    if (card) await deps.storage.updateMessage({ ...card, status: 'withdrawn', answeredAt: endedAt.toISOString(), outcome: approvalPassedOutcome() })
    await post({ role: 'system', kind: 'info', text: approvalPassedNote(approved.summary) })
    approved = null
    state = { ...state, pendingAction: null }
  }
  state = {
    ...state,
    running: false,
    lastRunAt: endedAt.toISOString(),
    lastError: error ?? null,
    runCount: state.runCount + 1,
    lastRunVendor: model.vendor,
    sessionId: nextSession,
    lastRunQuotes: quotes.length ? Object.fromEntries(quotes.map((q) => [q.symbol, q.last])) : state.lastRunQuotes,
    // The respawn-revision window closes with the first run that COMPLETES —
    // error keeps the flag, so a failed attempt retries with the same
    // instructions instead of silently dropping the revision.
    ...(state.respawnedAt && !error ? { respawnedAt: null } : {}),
    nextRunAt: next ? next.toISOString() : null,
    status:
      state.status === 'retired' ? 'retired' : state.status === 'paused' ? 'paused' : error ? 'error' : next ? 'scheduled' : cfg.schedule.kind === 'once' ? 'done' : 'idle'
  }
  await saveState()
  // Outcomes → the runs that made the decisions (core/trace/outcomes.ts). A
  // sell's realized P&L is scored against the runs that OPENED the position
  // (and the run that closed it), including engine sells that landed between
  // runs — those carry no run id themselves but close positions that do.
  if (deps.trace) {
    traced('outcomes', () => {
      const book = ledgerFor(cfg, state!)
      for (const sell of sellsSince(book.fills, prevLastRunAt)) {
        const runIds = entryRunsFor(book.fills, sell)
        if (!runIds.length) continue
        deps.trace!.outcome({
          runIds,
          key: 'realized_pnl_usd',
          score: sell.realized,
          comment: `sold ${sell.qty} ${sell.symbol} @ ${sell.price}${sell.engineExit ? ` (${sell.engineExit})` : ''} → ${sell.realized >= 0 ? '+' : ''}${sell.realized.toFixed(2)}`
        })
      }
    })
  }
  endTrace({
    ok: !error,
    error,
    stopReason,
    texts: result.texts,
    thinking: result.thinking,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cachedTokens: result.cachedTokens,
    contextTokens: result.contextTokens || undefined,
    costUsd: result.costUsd,
    toolCalls: result.toolCalls.length,
    actions,
    book: run.book,
    nextRunAt: next ? next.toISOString() : null,
    attempts: liveAttempt,
    durationMs: run.durationMs
  })
  emit({ kind: 'end', ok: !error, error })
  return { runId, ok: !error, error, actions, state }
}
