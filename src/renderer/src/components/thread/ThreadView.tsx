import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Zap, MoreHorizontal, Square, Loader2, RotateCcw, Cpu, ChevronDown, ChevronUp, Hourglass, MessageSquare, Moon } from 'lucide-react'
import { useApp } from '@renderer/store/appStore'
import { isQueuedMessage, orderThread, QUEUE_COPY } from '@shared/messageQueue'
import { describeSchedule } from '@shared/schedule'
import { CLOSE_MINUTES, etClock, formatEt, isTradingDay, OPEN_MINUTES } from '@shared/marketTime'
import { activeSleep, sleepStatusText } from '@shared/sleep'
import { cn, clockTime, countdown, dayLabel, money } from '@renderer/lib/format'
import { MessageItem } from './MessageItem'
import { isOperatorAsk } from '@shared/awaiting'
import { Composer } from './Composer'
import { Markdown } from '@renderer/components/common/Markdown'
import { AgentAvatar } from '@renderer/components/common/AgentAvatar'
import { isLocalVendor } from '@renderer/lib/vendor'
import { PROVIDER_HINT, PROVIDER_LABEL, providerOf } from '@shared/provider'
import { ProviderBadge } from '@renderer/components/common/ProviderPicker'
import { EARNINGS_POP, PLAYBOOK_LABEL } from '@shared/earningsPlaybook'
import { activeTasks, bookPnl, isAutonomous, ledgerFor, previewOf, RETIRED_NO_MESSAGE, tasksOf, type Message, type RunRecord } from '@shared/agents'
import { describeSettlesOn, describeUnsettled, settledCash, settlementModeFor, unsettledCash, unsettledLots } from '@shared/settlement'
import { Amount, EmptyState, Money } from '@renderer/components/common/Primitives'
import { LiveSteps } from './ToolActivity'
import { formatDuration } from '@renderer/lib/toolDisplay'

/** How often the pinned-card memo re-checks the clock. A question deadline passes with no message and no event. */
const PIN_RECHECK_MS = 20_000
/** The reading column — one width for the thread, the desk card above it and the composer below. */
const COLUMN = 'mx-auto w-full max-w-[var(--w-thread)]'
/** 15:50 ET: from here an intraday exit will be judged on tomorrow's opening print (`docs/ARCHITECTURE.md`, exits). */
const EXITS_JUDGED_MINUTES = 15 * 60 + 50
/**
 * The trading day as visible structure in the transcript. A run at 09:31 and a
 * run at 15:58 are different KINDS of run, and a transcript that only carries
 * clock times makes the reader do that arithmetic themselves.
 */
const BELLS: { minutes: number; label: string }[] = [
  { minutes: OPEN_MINUTES, label: 'Market open · 9:30 ET' },
  { minutes: EXITS_JUDGED_MINUTES, label: 'Exits now judged on tomorrow’s print · 15:50 ET' },
  { minutes: CLOSE_MINUTES, label: 'Market close · 16:00 ET' }
]

const etDateOf = (iso: string): string => etClock(new Date(iso)).date

/**
 * A day's messages, folded into RUNS. Everything one run produced — its trade
 * cards, its notes, its final report — carries the same `runId`, and shown as
 * a group on one rail it reads as "this run did these things" instead of a
 * column of unrelated cards. Messages with no run (the operator's, lifecycle
 * notes) stand alone between groups.
 */
type Block = { kind: 'run'; runId: string; items: Message[] } | { kind: 'one'; item: Message } | { kind: 'quiet'; runs: RunRecord[] }

/** A message, or a run that produced none (a quiet tick), in thread order. */
type Entry = { at: string; message?: Message; quiet?: RunRecord }

function blocksOf(entries: Entry[]): Block[] {
  const out: Block[] = []
  for (const e of entries) {
    const last = out[out.length - 1]
    if (e.quiet) {
      // Consecutive quiet ticks fold into one line — six of them between two
      // real runs is one fact ("nothing moved for an hour"), not six rows.
      if (last?.kind === 'quiet') last.runs.push(e.quiet)
      else out.push({ kind: 'quiet', runs: [e.quiet] })
      continue
    }
    const m = e.message!
    if (m.runId && last?.kind === 'run' && last.runId === m.runId) last.items.push(m)
    else if (m.runId) out.push({ kind: 'run', runId: m.runId, items: [m] })
    else out.push({ kind: 'one', item: m })
  }
  return out
}

/** When a block begins and ends — a quiet tick has no message, only its run row. */
const firstAt = (b: Block): string => (b.kind === 'one' ? b.item.ts : b.kind === 'quiet' ? b.runs[0].startedAt : b.items[0].ts)
const lastAt = (b: Block): string => (b.kind === 'one' ? b.item.ts : b.kind === 'quiet' ? b.runs[b.runs.length - 1].startedAt : b.items[b.items.length - 1].ts)

/**
 * A scheduled tick the engine took without calling the model: it enforced the
 * exits, priced the book, found nothing changed and wrote a run row with the
 * reason (`core/runner/quiet.ts`). No message means no card — and a thread
 * that jumped from "next check 11:13" to the 11:23 run read as a run that
 * never happened. It did; this is it.
 */
function QuietHead({ runs }: { runs: RunRecord[] }): JSX.Element {
  const times = runs.map((r) => clockTime(r.startedAt))
  const shown = times.length > 4 ? `${times.slice(0, 3).join(', ')} … ${times[times.length - 1]}` : times.join(', ')
  const reason = runs[runs.length - 1].skipReason ?? 'nothing changed'
  return (
    <div className="run-head quiet" title={reason}>
      <span className="run-dot">
        <Moon size={8} />
      </span>
      <span className="font-medium text-text/60">{runs.length === 1 ? 'Quiet tick' : `${runs.length} quiet ticks`}</span>
      <span className="nums">· {shown} · exits checked, nothing moved, model not called</span>
    </div>
  )
}

/** "Run · 9:31 AM · 41 s · 6 steps · 1 trade" — the facts of a run, from its messages alone. */
function RunHead({ items }: { items: Message[] }): JSX.Element {
  const first = items[0]
  const last = items[items.length - 1]
  const ms = new Date(last.ts).getTime() - new Date(first.ts).getTime()
  let steps = 0
  let trades = 0
  for (const m of items) {
    if (m.role === 'agent') steps += m.toolCalls?.length ?? 0
    if (m.role === 'action' && (m.action.status === 'filled' || m.action.status === 'open')) trades++
  }
  const bits = [clockTime(first.ts)]
  const dur = ms >= 1000 ? formatDuration(ms) : null
  if (dur) bits.push(dur)
  if (steps) bits.push(`${steps} step${steps === 1 ? '' : 's'}`)
  if (trades) bits.push(`${trades} trade${trades === 1 ? '' : 's'}`)
  return (
    <div className="run-head">
      <span className="run-dot">
        <Zap size={8} />
      </span>
      <span className="font-medium text-text/80">Run</span>
      <span className="nums">· {bits.join(' · ')}</span>
    </div>
  )
}

/* ─────────────────────────── the desk card ────────────────────────────── */

/** One of the two headline figures on the desk card: a label over a tabular figure. */
function DeskFigure({ label, value, title }: { label: string; value: ReactNode; title?: string }): JSX.Element {
  return (
    <div className="text-right" title={title}>
      <div className="eyebrow">{label}</div>
      <div className="text-md font-medium money mt-0.5">{value}</div>
    </div>
  )
}

/** One cell of the ledger strip. Cells are hairline-separated, never boxed. */
function StripCell({ label, value, sub, title, className }: { label: string; value: ReactNode; sub?: ReactNode; title?: string; className?: string }): JSX.Element {
  return (
    // `.hair-l` is the vocabulary's vertical hairline — an inset shadow, so the
    // cells keep their widths instead of each paying a pixel for its rule. The
    // leading cell cancels it: a line at x=0 would ride the strip's own edge.
    <div className={cn('min-w-0 px-3 py-1 hair-l first:shadow-none', className)} title={title}>
      <div className="eyebrow truncate">{label}</div>
      <div className="text-sm money truncate">{value}</div>
      {sub !== undefined && <div className="text-2xs text-text-3 truncate -mt-px">{sub}</div>}
    </div>
  )
}

/* ─────────────────────────── run heartbeat ────────────────────────────── */

/** How many runs the heartbeat shows — about a day of a 15-minute agent. */
const HEARTBEAT_RUNS = 24
/** On a desk card too narrow for a day: the last couple of hours, rather than nothing. */
const HEARTBEAT_RUNS_COMPACT = 12
/** Run rows read for the thread's quiet-tick lines — a few sessions of 10-minute ticks. */
const QUIET_RUNS = 400
/** How long a heartbeat jump's smooth scroll owns the scroll position before the stick-to-bottom rule reads it again. */
const JUMP_SETTLE_MS = 900

/**
 * One row per run id, keeping the newest. The store dedupes its own log, but
 * this list becomes React keys (the heartbeat's marks, the quiet lines), and
 * a duplicate key duplicates DOM — so the last line of defence is here, at
 * the point the ids become keys, whatever the host handed over.
 */
function uniqueRuns(rs: RunRecord[]): RunRecord[] {
  const seen = new Set<string>()
  return rs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
}
const MARK_W = 4
const MARK_GAP = 3
const MARK_H = 14

/**
 * What a run left behind, as one mark:
 *   ran    — it called the model and finished
 *   quiet  — the triage gate skipped the tick (no model call), with its reason
 *   failed — it did not finish
 *   held   — it stopped to ask the operator for approval
 */
type MarkKind = 'ran' | 'quiet' | 'failed' | 'held'

function markKind(r: RunRecord, held: boolean): MarkKind {
  if (!r.ok) return 'failed'
  if (held) return 'held'
  if (r.skipped) return 'quiet'
  return 'ran'
}

function markTitle(r: RunRecord, kind: MarkKind): string {
  const bits = [formatEt(r.startedAt, true), r.trigger]
  if (kind === 'failed') bits.push(r.error ? `failed — ${r.error.slice(0, 120)}` : r.stopReason ? `failed — ${r.stopReason}` : 'failed')
  else if (kind === 'held') bits.push('held for approval')
  else if (kind === 'quiet') bits.push(r.skipReason ? `quiet tick — ${r.skipReason}` : 'quiet tick')
  else {
    if (r.actions) bits.push(`${r.actions} action${r.actions === 1 ? '' : 's'}`)
    if (r.toolCalls) bits.push(`${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'}`)
    const dur = r.durationMs >= 1000 ? formatDuration(r.durationMs) : null
    if (dur) bits.push(dur)
  }
  return bits.join(' · ')
}

/**
 * The run log behind the heartbeat — asked for narrowly, remembered, and read
 * off the paint.
 *
 * The answer is not cheap on the other side: `agentStore.runs` opens
 * `runs.jsonl` and JSON-parses EVERY line before slicing the tail, in the MAIN
 * process, synchronously. On an agent with months of runs that is a stall the
 * engine shares, not just this view — and both opening a thread and every run
 * that settles on it ask for it. Bounding our half of that:
 *
 *  · ask for exactly the marks the strip draws, never a round 50;
 *  · remember the answer under the key that decides it, so re-opening a thread
 *    or flipping between two agents costs nothing at all;
 *  · and go on IDLE, so a burst of settles collapses into one read and the read
 *    never competes with the thread's own first paint.
 *
 * Capping what is PARSED needs the store to read the file's tail instead of all
 * of it — `src/main/store/agentStore.ts`, tracked separately.
 */
const RUNS_CACHE_MAX = 12
/** Long enough to stay out of the paint, short enough that the strip is not stale while someone reads it. */
const RUNS_IDLE_TIMEOUT_MS = 400
const runsCache = new Map<string, RunRecord[]>()

/** What decides the answer: the agent, and the two counters a settle moves. */
const runsKeyOf = (agentId: string, runCount: number | undefined, lastRunAt: string | null | undefined): string => `${agentId}|${runCount ?? 0}|${lastRunAt ?? ''}`

function rememberRuns(key: string, rs: RunRecord[]): void {
  runsCache.delete(key)
  runsCache.set(key, rs)
  // A Map iterates in insertion order, so the first key out is the oldest.
  while (runsCache.size > RUNS_CACHE_MAX) {
    const oldest = runsCache.keys().next().value
    if (oldest === undefined) break
    runsCache.delete(oldest)
  }
}

/** Run once the frame is done. Falls back to a task where idle scheduling is unavailable. */
function onIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(fn, { timeout: RUNS_IDLE_TIMEOUT_MS })
    return () => cancelIdleCallback(handle)
  }
  const handle = window.setTimeout(fn, 0)
  return () => window.clearTimeout(handle)
}

/**
 * The agent's recent working rhythm, at a glance: gaps, quiet stretches and
 * failures are shapes long before they are numbers. Drawn from the run log the
 * host already keeps — if there is none, this renders nothing rather than an
 * invented one.
 */
function RunHeartbeat({ runs, heldRunIds, onSelect, count = HEARTBEAT_RUNS }: { runs: RunRecord[]; heldRunIds: ReadonlySet<string>; onSelect?: (run: RunRecord) => void; /** How many of the newest runs to draw — fewer on a narrow desk card. */ count?: number }): JSX.Element | null {
  if (!runs.length) return null
  // The store hands them back newest-first; the strip reads left (oldest) to
  // right (now), the way a chart of time does.
  const shown = runs.slice(0, count).reverse()
  const width = shown.length * (MARK_W + MARK_GAP) - MARK_GAP
  const counts: Record<MarkKind, number> = { ran: 0, quiet: 0, failed: 0, held: 0 }
  const marks = shown.map((r) => {
    const kind = markKind(r, heldRunIds.has(r.id))
    counts[kind] += 1
    return { run: r, kind }
  })
  const label = [
    counts.ran ? `${counts.ran} ran` : '',
    counts.quiet ? `${counts.quiet} quiet` : '',
    counts.failed ? `${counts.failed} failed` : '',
    counts.held ? `${counts.held} held for approval` : ''
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <svg width={width} height={MARK_H} viewBox={`0 0 ${width} ${MARK_H}`} role="img" aria-label={`Last ${shown.length} runs: ${label}`} className="shrink-0 overflow-visible">
      {marks.map(({ run, kind }, i) => {
        const x = i * (MARK_W + MARK_GAP)
        const select = (): void => onSelect?.(run)
        return (
          // Each mark is a button: hovering lifts it, clicking scrolls the
          // thread to that run (`jumpToRun`), so the strip is a map of the
          // transcript and not only a summary of it.
          <g key={run.id} className="run-mark" role="button" tabIndex={0} aria-label={markTitle(run, kind)} onClick={select} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select())}>
            <title>{markTitle(run, kind)}</title>
            {/* A transparent hit box covers the gap too, so the tooltip does not
                depend on landing inside a 4px mark; on hover it tints. */}
            <rect className="run-hit" x={x - MARK_GAP / 2} y={-2} width={MARK_W + MARK_GAP} height={MARK_H + 4} rx={2} fill="transparent" />
            {kind === 'failed' ? (
              <g stroke="var(--color-down)" strokeWidth={1.3} strokeLinecap="round">
                <line x1={x} y1={4} x2={x + MARK_W} y2={MARK_H - 4} />
                <line x1={x} y1={MARK_H - 4} x2={x + MARK_W} y2={4} />
              </g>
            ) : kind === 'quiet' ? (
              <rect x={x + 0.5} y={0.5} width={MARK_W - 1} height={MARK_H - 1} rx={1.5} fill="none" stroke="var(--color-hairline-strong)" />
            ) : (
              <rect x={x} y={0} width={MARK_W} height={MARK_H} rx={1.5} fill={kind === 'held' ? 'var(--color-accent)' : 'var(--color-text-2)'} />
            )}
          </g>
        )
      })}
    </svg>
  )
}

export function ThreadView({ agentId }: { agentId: string }): JSX.Element {
  const agent = useApp((s) => s.agents[agentId])
  const local = useApp((s) => s.local)
  const messages = useApp((s) => s.messages[agentId])
  const hasMore = useApp((s) => s.hasMore[agentId])
  const live = useApp((s) => s.live[agentId])
  const marks = useApp((s) => s.marks)
  const runNow = useApp((s) => s.runNow)
  const msgStatus = useApp((s) => s.msgStatus)
  const stopping = useApp((s) => Boolean(s.stopping[agentId]))
  const sendMessage = useApp((s) => s.send)
  const resend = useApp((s) => s.resend)
  const discardMessage = useApp((s) => s.discardMessage)
  const stopRun = useApp((s) => s.stopRun)
  const openSheet = useApp((s) => s.openSheet)
  const portfolioOpen = useApp((s) => s.portfolioOpen)
  const loadMessages = useApp((s) => s.loadMessages)
  const scroller = useRef<HTMLDivElement>(null)
  const [stickBottom, setStickBottom] = useState(true)
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (stickBottom && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [messages, live, stickBottom])

  /**
   * Only messages that ARRIVE while this thread is open animate in. History
   * paints in place — animating forty rows on open is noise, and it is the
   * one thing a person opening a thread twice a minute would learn to hate.
   * Re-based per agent, since this component is reused across selections.
   */
  const openedAt = useMemo(() => Date.now(), [agentId])
  const isFresh = useCallback((m: Message): boolean => Date.parse(m.ts) > openedAt, [openedAt])

  /**
   * Respawn progress. A respawn is a multi-write network round trip and the
   * header only changes when the store flips — several seconds in which a
   * plain button gave no sign the click landed. Spin until the status leaves
   * 'retired'; revert only on failure so the button stays honest.
   *
   * ABOVE the `!agent` early return on purpose: hooks after a conditional
   * return render conditionally, which is the one thing hooks must never do.
   */
  const [respawning, setRespawning] = useState(false)
  const isRetired = agent?.state.status === 'retired'
  useEffect(() => {
    if (!isRetired) setRespawning(false)
  }, [isRetired])
  const respawnNow = useCallback((): void => {
    setRespawning(true)
    window.tb.agents.respawn(agentId).catch(() => setRespawning(false))
  }, [agentId])

  /**
   * The run log behind the heartbeat (see `runsCache` above). Read-only, and
   * NULL until it answers — an agent with no runs recorded gets no strip rather
   * than an empty one that reads as "it never ran". Re-read when a run settles
   * (`runCount` / `lastRunAt` move), which is the only thing that can add a
   * mark.
   */
  const [runs, setRuns] = useState<RunRecord[] | null>(null)
  const runCount = agent?.state.runCount
  const lastRunAt = agent?.state.lastRunAt
  const runsKey = runsKeyOf(agentId, runCount, lastRunAt)
  useEffect(() => {
    // A different colleague: drop the strip rather than draw the previous
    // agent's rhythm for a beat under this one's name. A SETTLE does not clear
    // it — the marks that are already right stay while the new answer lands.
    setRuns(null)
  }, [agentId])
  useEffect(() => {
    const cached = runsCache.get(runsKey)
    if (cached) {
      setRuns(cached)
      return
    }
    let cancelled = false
    const cancelIdle = onIdle(() => {
      void window.tb.agents
        .runs(agentId, HEARTBEAT_RUNS)
        .then((rs) => {
          // Cache whatever came back, even for a run that settled while the
          // operator was elsewhere: the key names the state it answers for.
          const unique = uniqueRuns(rs)
          rememberRuns(runsKey, unique)
          if (!cancelled) setRuns(unique)
        })
        .catch(() => {
          // Not cached: a failed read is not an answer about this agent, and
          // the next settle should be free to ask again.
          if (!cancelled) setRuns([])
        })
    })
    return () => {
      cancelled = true
      cancelIdle()
    }
  }, [agentId, runsKey])

  /**
   * Cards still waiting on an answer are pinned below the thread instead of
   * sitting where they were posted. A plan proposed at 4:01 scrolls away like
   * any other message, and an agent that has STOPPED until you answer then
   * looks like one that simply said something a while ago. Pinning keeps the
   * ask in front of you for as long as it is actually blocking, and it leaves
   * on its own the moment it stops — `isOperatorAsk` is derived from the
   * message, not a flag. `nowMs` re-evaluates so a deadline passing (no
   * message, no event) still un-pins the card.
   */
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), PIN_RECHECK_MS)
    return () => clearInterval(t)
  }, [])

  /**
   * Three piles. `pinned`: open asks, docked below the thread. `tail`: the
   * operator's own messages that nothing is answering yet — in flight to the
   * engine, refused by it, or QUEUED behind the run in progress
   * (shared/messageQueue.ts) — drawn after the live bubble, because a message
   * typed under a run that is answering something else belongs below that
   * run, not above it. Everything else is `history`.
   */
  /**
   * "A run is in flight" has two sources, and the live stream is the earlier
   * one: its `start` lands the instant a run begins, while the row's `running`
   * follows later (after the context is built). Reading the row alone showed a
   * streaming bubble over a
   * composer that said the agent was idle, and a message sent in that gap
   * flipped from sent to queued once the row caught up.
   */
  const streaming = Boolean(live && !live.pending)
  const running = Boolean(agent?.state.running)
  const working = running || streaming
  const runStartedAt = agent?.state.runStartedAt
  const liveStartedAt = streaming ? new Date(live!.startedAt).toISOString() : undefined
  const liveRunId = streaming ? live!.runId : undefined
  const rowRunId = agent?.state.runId
  const agentStatus = agent?.state.status
  const { history, pinned, tail } = useMemo(() => {
    // A message that waited behind a run sits after that run's reply, not at
    // its own timestamp (the reply answered what came before it).
    const all = orderThread(messages ?? [])
    const now = new Date(nowMs)
    const open = all.filter((m) => isOperatorAsk(m, now))
    const openIds = new Set(open.map((m) => m.id))
    const status = agentStatus ?? 'idle'
    // The row's start only counts while the row says running — a stale start
    // from the previous run would otherwise queue everything after it.
    const byRow = { running, runStartedAt, status, runId: rowRunId }
    const byStream = { running: streaming, runStartedAt: liveStartedAt, status, runId: liveRunId }
    // Only while a run is in flight do the operator's newest messages move
    // below its bubble. Sent to an idle agent, a message stays where it was
    // written and the reply's placeholder opens under it.
    const isTail = (m: Message): boolean => m.role === 'user' && working && (Boolean(msgStatus[m.id]) || isQueuedMessage(m, byRow) || isQueuedMessage(m, byStream))
    return { history: all.filter((m) => !openIds.has(m.id) && !isTail(m)), pinned: open, tail: all.filter(isTail) }
  }, [messages, nowMs, msgStatus, running, runStartedAt, streaming, liveStartedAt, liveRunId, rowRunId, agentStatus, working])

  /**
   * Quiet ticks come from the run log, not the thread: the fast path writes a
   * run row and no message. Re-read on the same key as the heartbeat strip
   * (a settle moves it) but with its own, wider bound: the strip wants the last 24 runs, while a busy
   * day is 39 ticks and the morning's quiet ones must not vanish by afternoon.
   */
  const [quietRuns, setQuietRuns] = useState<RunRecord[]>([])
  useEffect(() => {
    let alive = true
    void window.tb.agents
      .runs(agentId, QUIET_RUNS)
      .then((rs) => alive && setQuietRuns(uniqueRuns(rs).filter((r) => r.skipped)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [agentId, runsKey])

  /**
   * A click on a heartbeat mark scrolls the thread to that run's block — the
   * run group (its messages share the run id) or the quiet line that folds it.
   * Every row carries `data-run-ids`, so the lookup is one DOM query and the
   * strip needs no knowledge of how the thread is grouped. A run older than the
   * loaded page is fetched (one more page) and the jump retried once the rows
   * land; a run with no row at all (a failed run that posted nothing) does
   * nothing, which the tooltip already explains.
   */
  const jumpTarget = useRef<string | null>(null)
  /**
   * While a jump's smooth scroll is in flight the scroll handler must not
   * re-derive "stick to bottom" from where the view happens to be: a jump that
   * STARTS at the bottom (old run → latest → old run again) fires its first
   * scroll events within the stick threshold, the handler re-armed the stick,
   * and the stick effect snapped the view back down mid-animation — the
   * "glitch" instead of a scroll.
   */
  const jumpingUntil = useRef(0)
  const scrollToRun = useCallback((runId: string): boolean => {
    const sc = scroller.current
    const el = sc?.querySelector<HTMLElement>(`[data-run-ids~="${CSS.escape(runId)}"]`)
    if (!sc || !el) return false
    jumpingUntil.current = Date.now() + JUMP_SETTLE_MS
    setStickBottom(false)
    // Scroll the thread's own container, centred on the block — not
    // `scrollIntoView`, which may also move an ancestor and fights the layout.
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - Math.max(0, (sc.clientHeight - el.clientHeight) / 2)
    sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    // Once the jump has settled, read the position once more: a jump to the
    // latest run lands at the bottom, and the thread should follow new
    // messages again from there without waiting for the operator to scroll.
    window.setTimeout(() => {
      const s = scroller.current
      if (s) setStickBottom(s.scrollHeight - s.scrollTop - s.clientHeight < 80)
    }, JUMP_SETTLE_MS)
    el.classList.remove('run-flash')
    // Restart the animation on a second click of the same mark.
    void el.offsetWidth
    el.classList.add('run-flash')
    window.setTimeout(() => el.classList.remove('run-flash'), 1600)
    return true
  }, [])
  const jumpToRun = useCallback(
    (run: RunRecord): void => {
      if (scrollToRun(run.id)) return
      if (!hasMore) return
      jumpTarget.current = run.id
      void loadMessages(agentId, true)
    },
    [scrollToRun, hasMore, loadMessages, agentId]
  )

  /**
   * Days of run-blocks, with the session bells that fall BETWEEN blocks. A bell
   * inside a run group would cut the rail in half, and a run that straddles the
   * open is one event, not two. Quiet ticks are blocks too, merged in by time.
   */
  const grouped = useMemo(() => {
    // Only quiet ticks inside the loaded window: an older one would sit at the
    // top under a day rule of its own, ahead of history that is not shown.
    // A stable merge, not a sort: `history` is already in THREAD order
    // (`orderThread` places a queued message after the run it waited for,
    // whatever its timestamp), and re-sorting by time would undo that.
    const oldest = history[0]?.ts
    const quiet = quietRuns.filter((r) => !oldest || r.startedAt >= oldest).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    const entries: Entry[] = []
    let qi = 0
    for (const m of history) {
      while (qi < quiet.length && quiet[qi].startedAt <= m.ts) entries.push({ at: quiet[qi].startedAt, quiet: quiet[qi++] })
      entries.push({ at: m.ts, message: m })
    }
    while (qi < quiet.length) entries.push({ at: quiet[qi].startedAt, quiet: quiet[qi++] })
    const days: { day: string; items: Entry[] }[] = []
    for (const e of entries) {
      const day = dayLabel(e.at)
      const last = days[days.length - 1]
      if (last && last.day === day) last.items.push(e)
      else days.push({ day, items: [e] })
    }
    return days.map((d) => {
      const rows: { bells: string[]; block: Block }[] = []
      let prev: { date: string; minutes: number } | null = null
      for (const block of blocksOf(d.items)) {
        const at = etClock(new Date(firstAt(block)))
        const bells: string[] = []
        if (prev && prev.date === at.date && isTradingDay(at.date)) {
          for (const b of BELLS) if (prev.minutes < b.minutes && at.minutes >= b.minutes) bells.push(b.label)
        }
        rows.push({ bells, block })
        const end = etClock(new Date(lastAt(block)))
        prev = { date: end.date, minutes: end.minutes }
      }
      return { day: d.day, rows }
    })
  }, [history, quietRuns])
  useEffect(() => {
    const id = jumpTarget.current
    if (!id) return
    jumpTarget.current = null
    // Rows are on screen once `grouped` has settled; try once, then let it go.
    window.requestAnimationFrame(() => void scrollToRun(id))
  }, [grouped, scrollToRun])

  /**
   * Runs that stopped to ask for the operator's word. `RunRecord` carries no
   * such flag — the approval card in the thread IS the record — so the
   * heartbeat reads it from the messages it already has.
   */
  const heldRunIds = useMemo(() => {
    const ids = new Set<string>()
    for (const m of messages ?? []) if (m.role === 'approval' && m.runId) ids.add(m.runId)
    return ids
  }, [messages])

  const [stackExpanded, setStackExpanded] = useState(false)
  /** The dock folds to its one-line header so the thread gets the room back; the ask stays in the sidebar and header either way. */
  const [dockOpen, setDockOpen] = useState(true)
  useEffect(() => {
    setStackExpanded(false)
    setDockOpen(true)
  }, [agentId])

  const send = useCallback(
    (text: string): void => {
      void sendMessage(agentId, text)
      setStickBottom(true)
    },
    [agentId, sendMessage]
  )
  const onRetry = useCallback((mid: string) => void resend(agentId, mid), [agentId, resend])
  const onDiscard = useCallback((mid: string) => discardMessage(agentId, mid), [agentId, discardMessage])
  const stop = useCallback(() => void stopRun(agentId), [agentId, stopRun])
  const onApplyPlan = useCallback((mid: string) => void window.tb.agents.applyPlan(agentId, mid), [agentId])
  const onDismissPlan = useCallback((mid: string) => void window.tb.agents.dismissPlan(agentId, mid), [agentId])
  const onAnswerApproval = useCallback((mid: string, approve: boolean) => void window.tb.agents.answerApproval(agentId, mid, approve), [agentId])

  if (!agent) return <div className="flex-1" />
  const { config, state } = agent
  const paused = state.status === 'paused'
  const retired = state.status === 'retired'
  // A retirement the engine could not carry out: the newest such
  // note, pinned red until the agent is retired or a later run settles it. Not
  // an ask — it does not stall the agent — so it sits above the composer and
  // never in the waiting-on-you dock.
  const failedRetirement = retired
    ? null
    : [...(messages ?? [])].reverse().find((m) => m.role === 'system' && m.kind === 'error' && m.text.startsWith('⚠️ Retirement due') && (!state.lastRunAt || m.ts >= state.lastRunAt))
  const onLocal = isLocalVendor(config)
  // A sleep in force outranks the countdown: "Next run in 41 days" is true and
  // says nothing, while the reason the agent chose that is the whole story.
  const sleep = activeSleep(state)
  const statusText = state.running
    ? 'Working…'
    : retired
      ? `Retired${state.retireReason ? ` · ${state.retireReason}` : ''}`
      : paused
        ? 'Paused'
        : sleep
          ? `${sleepStatusText(sleep.until)} · ${sleep.reason}`
        : state.nextRunAt
          ? `Next run in ${countdown(state.nextRunAt)} · ${formatEt(state.nextRunAt, true)}`
          : state.status === 'error'
            ? `Error · ${state.lastError?.slice(0, 80) ?? ''}`
            : state.status === 'done'
              ? 'Done'
              : 'Idle'
  // The live stream knows a run started before the row does (see `working`), so
  // the sentence follows it rather than saying "Idle" over a streaming bubble.
  const statusLine = working ? 'Working…' : statusText

  /* The desk card's money, all of it already on the agent. `ledgerFor` is the
     paper/live branch — never both, never summed. */
  const ledger = ledgerFor(config, state)
  const todayEt = etClock().date
  const pnl = bookPnl(config, state, marks, todayEt, etDateOf)
  const unsettled = unsettledCash(ledger, todayEt)
  const lots = unsettledLots(ledger, todayEt)
  const nextSettlement = lots.length ? lots.map((l) => l.settlesOn).sort()[0] : null
  // Absent settlement means NOT SIMULATED (shared/settlement.ts) — the strip
  // then says "Cash", because calling it "settled" would claim a rule this
  // agent is not being held to.
  const settlement = settlementModeFor(config)
  const cashLabel = settlement === 'cash' ? 'Settled' : 'Cash'
  const cashValue = settlement === 'cash' ? settledCash(ledger, todayEt) : ledger.cash
  // The one-line role. Tasks are a LIST and every run serves all of them, so
  // the header names them all; an agent whose tasks are all finished says so
  // rather than showing the goal it has already discharged.
  const open = activeTasks(config)
  const roleLine = open.length ? open.map((t) => t.text).join(' · ') : tasksOf(config).length ? 'Every task is marked done' : config.task
  const provider = providerOf(config)

  const card = (m: Message): JSX.Element => <MessageItem key={m.id} m={m} guardrails={config.guardrails} allocationUsd={config.allocationUsd} fresh={isFresh(m)} onApplyPlan={onApplyPlan} onDismissPlan={onDismissPlan} onAnswer={send} onAnswerApproval={onAnswerApproval} />

  return (
    <section className="flex-1 min-w-0 h-full flex flex-col bg-bg">
      {/* THE DESK CARD — who this colleague is, what they were asked to do,
          where they run, what they are doing now and what they are holding.
          Everything on it is read from the agent; nothing is computed that the
          book does not already answer. */}
      <header className="@container drag shrink-0 px-5 pt-2.5 pb-2.5 hair-b bg-bg">
        <div className={cn(COLUMN, 'flex flex-col gap-2')}>
          <div className="flex items-start gap-3">
            {/* The avatar IS the stats button: pointer, a hover ring and a small
                lift say "this opens something". */}
            <button
              className={cn('no-drag mt-0.5 rounded-full ring-offset-2 ring-offset-bg hover:ring-2 hover:ring-[var(--ring)] hover:scale-[1.04] active:scale-100', onLocal && state.running && 'local-glow')}
              style={{ transition: 'transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)' }}
              title="Stats & performance"
              aria-label="Open agent stats"
              onClick={() => openSheet({ kind: 'stats', agentId })}
            >
              <AgentAvatar icon={config.icon} color={config.color} size={36} active={state.running} />
            </button>
            <div className="min-w-0 flex-1 no-drag">
              <div className="flex items-center gap-2">
                {/* A floor, so the pills beside it give up their space before
                    the agent's own name does. */}
                <button className="font-semibold text-lg tracking-[-0.01em] truncate min-w-[7rem] hover:underline decoration-hairline-strong underline-offset-[3px]" title="Stats & performance" onClick={() => openSheet({ kind: 'stats', agentId })}>
                  {config.name}
                </button>
                {config.mode === 'live' ? (
                  <span className={cn('pill', config.liveArmedAt ? 'pill-armed' : 'pill-live')} title={config.liveArmedAt ? 'Armed — this agent can place real orders' : 'Real money, not armed: it cannot place an order until you arm it'}>
                    {config.liveArmedAt ? 'Armed' : 'Live'}
                  </span>
                ) : (
                  <span className="pill pill-paper" title="Simulated money — the same rules, no orders leave the app">
                    Paper
                  </span>
                )}
                {!isAutonomous(config) && (
                  <span className="pill" title="Asks first: every trade, exit and retirement waits for your word — there is no deadline">
                    Asks first
                  </span>
                )}
              </div>
              {/* The role: what this colleague is standing instructed to do. */}
              <p className="text-sm text-muted truncate mt-0.5" title={roleLine || undefined}>
                {roleLine || 'No task set — tell it what to do below.'}
              </p>
            </div>
            <div className="no-drag flex items-center gap-1.5 shrink-0">
              {retired ? (
                <button className="btn btn-accent disabled:opacity-60" disabled={respawning} onClick={respawnNow}>
                  {respawning ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} {respawning ? 'Respawning…' : 'Respawn'}
                </button>
              ) : working ? (
                <button className="btn btn-outline disabled:opacity-60" disabled={stopping} onClick={stop} title={stopping ? 'Stopping the current run…' : `Stop the current run${tail.length ? ' — your queued message goes out right after' : ''}`}>
                  {stopping ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />} {stopping ? QUEUE_COPY.stopping : 'Stop'}
                </button>
              ) : live?.pending ? (
                <button className="btn btn-outline disabled:opacity-60" disabled title="Starting…">
                  <Loader2 size={13} className="animate-spin" /> Starting…
                </button>
              ) : (
                <button className="btn btn-outline" onClick={() => void runNow(agentId)} title="Run now">
                  <Zap size={13} /> Run now
                </button>
              )}
              {!retired &&
                (paused ? (
                  <button className="btn btn-accent" onClick={() => void window.tb.agents.resume(agentId)}>
                    <Play size={13} /> Resume
                  </button>
                ) : (
                  <button className="btn btn-ghost" onClick={() => void window.tb.agents.pause(agentId)}>
                    <Pause size={13} /> Pause
                  </button>
                ))}
              <button className="btn-icon" onClick={() => openSheet({ kind: 'settings', agentId })} title="Agent settings">
                <MoreHorizontal size={18} />
              </button>
            </div>
            {/* Keep the action buttons clear of the native window controls (the
                portfolio panel owns that corner when open). */}
            <div aria-hidden className="shrink-0" style={{ width: portfolioOpen ? 0 : 'var(--wco-pad, 0px)' }} />
          </div>

          {/* Where it runs, what it is doing now, and the two figures that say
              how much of the operator's money is in its hands. */}
          <div className="no-drag flex items-end gap-4">
            <div className="min-w-0 flex-1 flex flex-col gap-1">
              <div className="flex items-center gap-1.5 min-w-0">
                {onLocal ? (
                  <button className={cn('pill pill-local', state.running && 'working')} title={`Runs on the local GPU model${local?.active ? ` · ${local.active.modelName}` : ''} — change in Agent settings`} onClick={() => openSheet({ kind: 'settings', agentId })}>
                    <Cpu size={11} /> Local GPU{local?.active ? ` · ${local.active.modelName}` : ''}
                  </button>
                ) : (
                  <button className="pill hover:text-text transition-colors" title={`${state.running ? 'Running now on' : 'Runs on'} ${PROVIDER_LABEL[provider]} — ${PROVIDER_HINT[provider]} Change in Agent settings.`} onClick={() => openSheet({ kind: 'settings', agentId })}>
                    <ProviderBadge provider={provider} title="" />
                  </button>
                )}
                {config.playbook ? (
                  // A special mode owns the schedule, so the mode — not the
                  // times — is what this chip has to say.
                  <span className="pill text-accent max-w-[240px]" title={`${PLAYBOOK_LABEL[config.playbook]} mode — every buy is the whole book on one name reporting tonight or before tomorrow's open, sold by the engine at ${EARNINGS_POP.exitAt} ET next session; waits for settlement between trades. ${describeSchedule(config.schedule)}.`}>
                    <span className="truncate">{PLAYBOOK_LABEL[config.playbook]}</span>
                  </span>
                ) : (
                  <span className="pill max-w-[220px] hidden @xl:inline-flex" title={describeSchedule(config.schedule)}>
                    <span className="truncate">{describeSchedule(config.schedule)}</span>
                  </span>
                )}
              </div>
              <div className={cn('flex items-center gap-1.5 text-sm nums min-w-0', state.status === 'error' ? 'text-down' : 'text-muted')} title={statusLine}>
                <span className={cn('dot shrink-0', working ? 'bg-accent pulse' : state.status === 'error' ? 'bg-down' : 'bg-text-3')} />
                <span className="truncate">{statusLine}</span>
              </div>
            </div>
            {/* The two figures that say how much is in this colleague's hands.
                They live here and NOT in the strip below: the same number
                printed twice, twelve pixels apart, at two weights, reads as
                two different numbers. */}
            <div className="flex items-start gap-6 shrink-0">
              <DeskFigure label="Allocation" value={<Amount value={config.allocationUsd} />} title={`What this agent may put to work (${config.mode === 'live' ? 'real money' : 'simulated'})`} />
              <DeskFigure label="Realized" value={<Money value={ledger.realizedPnl} />} title="Profit and loss this agent has actually booked — closed positions only" />
            </div>
          </div>

          {/* THE LEDGER STRIP — the book as a statement line, and the working
              rhythm beside it. Every figure comes off the agent's own ledger;
              anything the book cannot answer is left out rather than guessed. */}
          {/* `no-drag` because every cell explains itself in a tooltip, and a
              window-drag region never receives the pointer that would show one. */}
          {/* `w-fit`: the strip is as wide as its cells. Stretched to the column,
              the empty width after the last cell read as a giant DAY cell
              whenever the heartbeat beside it did not fit (2026-09-11). */}
          <div className="no-drag inset flex items-stretch overflow-x-auto w-fit max-w-full">
            <StripCell
              className="shrink-0"
              label={cashLabel}
              value={<Amount value={cashValue} />}
              sub={settlement === 'cash' ? 'spendable today' : undefined}
              title={settlement === 'cash' ? 'Sale proceeds settle T+1 — this is what a buy may spend today' : 'Uninvested cash in this agent’s book'}
            />
            {unsettled > 0 && (
              <StripCell
                className="shrink-0"
                label="Unsettled"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="hatched inline-block h-3 w-3 rounded-xs shrink-0" />
                    <Amount value={unsettled} />
                  </span>
                }
                sub={nextSettlement ? `settles ${describeSettlesOn(nextSettlement)}` : undefined}
                title={describeUnsettled(ledger, todayEt, money)}
              />
            )}
            <StripCell className="shrink-0" label="Positions" value={String(ledger.positions.length)} sub={ledger.positions.length ? ledger.positions.map((p) => p.symbol).join(' ') : 'flat'} title={ledger.positions.length ? ledger.positions.map((p) => `${p.symbol} ×${p.qty} @ ${money(p.avgCost)}`).join('\n') : 'Nothing held'} />
            {/* An unmarked book is priced at COST, so its day figure is exactly
                zero by construction — not "flat", unknown. Say which symbol is
                unpriced instead of printing a confident number. */}
            <StripCell
              className="shrink-0"
              label="Day"
              value={pnl.marked ? <Money value={pnl.dayPnl} /> : <span className="text-text-3">—</span>}
              sub={pnl.marked ? undefined : 'no price yet'}
              title={pnl.marked ? 'Today’s change in this agent’s book' : `No price yet for ${pnl.unmarked.join(', ')} — this agent's P&L can't be computed until a quote arrives.`}
            />
            {/* The heartbeat is never dropped for want of width: a narrow desk
                card gets the newest HEARTBEAT_RUNS_COMPACT marks, a wide one the
                full day. Two elements, one visible at a time by container width. */}
            {runs !== null && runs.length > 0 && (
              <>
                <div className="flex @2xl:hidden flex-col justify-center gap-1 px-3 py-1 hair-l shrink-0">
                  <div className="eyebrow">Last {Math.min(runs.length, HEARTBEAT_RUNS_COMPACT)} runs</div>
                  <RunHeartbeat runs={runs} heldRunIds={heldRunIds} onSelect={jumpToRun} count={HEARTBEAT_RUNS_COMPACT} />
                </div>
                <div className="hidden @2xl:flex flex-col justify-center gap-1 px-3 py-1 hair-l shrink-0">
                  <div className="eyebrow">Last {Math.min(runs.length, HEARTBEAT_RUNS)} runs</div>
                  <RunHeartbeat runs={runs} heldRunIds={heldRunIds} onSelect={jumpToRun} />
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div
        ref={scroller}
        className="flex-1 overflow-y-auto px-5"
        onScroll={(e) => {
          const el = e.currentTarget
          // A heartbeat jump is scrolling on its own; where the view is mid-flight says nothing about the operator's intent.
          if (Date.now() < jumpingUntil.current) return
          setStickBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
        }}
      >
        {/* Vertical padding lives INSIDE the scrolled content, not on the scroller:
            a sticky child sticks to the scroller's content edge, so padding on the
            scroller left a 20px slot above the day marker where the row scrolling
            under it stayed visible. */}
        <div className={cn(COLUMN, 'flex flex-col gap-2.5 py-5')}>
          {hasMore && (
            <div className="flex justify-center">
              <button className="btn btn-ghost btn-sm text-muted" onClick={() => void loadMessages(agentId, true)}>
                Load earlier
              </button>
            </div>
          )}
          {!messages && (
            <div className="flex flex-col gap-3 py-6 fade-in" aria-label="Loading the conversation" aria-busy="true">
              <div className="skeleton h-9 w-[46%]" />
              <div className="skeleton h-9 w-[38%] self-end" />
              <div className="skeleton h-24 w-[52%]" />
            </div>
          )}
          {messages && messages.length === 0 && (
            <EmptyState
              className="py-14"
              icon={<AgentAvatar icon={config.icon} color={config.color} size={36} active={state.running} />}
              title={config.name}
              body={config.task || 'Tell this agent what to do — e.g. "Buy $500 of MU at 3:58pm every day and sell it at 9:31am the next morning."'}
              action={
                <span className="hint inline-flex items-center gap-1.5">
                  <MessageSquare size={12} /> Anything you write here goes into its next run.
                </span>
              }
            />
          )}
          {grouped.map((g) => (
            <div key={g.day} className="flex flex-col gap-2.5">
              {/* Sticky, so a long session never loses "when am I". Left-aligned
                  with a rule after it — the way a journal marks a day. */}
              <div className="sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-bg/95 backdrop-blur-sm">
                <div className="day-rule">{g.day}</div>
              </div>
              {/* Everything one run produced hangs off one rail (`.run-group`), so
                  the eye reads "this run did these things"; a message with no
                  run — the operator's, a lifecycle note — stands alone. The
                  session bells fall between blocks, never inside one. A quiet
                  tick (a run row with no message) is one muted line. */}
              {g.rows.map(({ bells, block: b }) => (
                <div
                  // Keyed by the block's FIRST item, never by run id alone: one
                  // run's messages can form two blocks (a queued reply placed
                  // between them), and React warned "two children with the same
                  // key" on every render of such a thread.
                  key={b.kind === 'one' ? b.item.id : b.kind === 'quiet' ? `q_${b.runs[0].id}` : `r_${b.items[0].id}`}
                  className="flex flex-col gap-2.5"
                  // The run ids this row answers for — what a heartbeat click looks up.
                  data-run-ids={b.kind === 'run' ? b.runId : b.kind === 'quiet' ? b.runs.map((r) => r.id).join(' ') : undefined}
                >
                  {bells.map((label) => (
                    <div key={label} className="bell mt-1">
                      <span>{label}</span>
                    </div>
                  ))}
                  {b.kind === 'one' ? (
                    card(b.item)
                  ) : b.kind === 'quiet' ? (
                    <QuietHead runs={b.runs} />
                  ) : (
                    <div className="run-group flex flex-col gap-2.5">
                      <RunHead items={b.items} />
                      {b.items.map(card)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {live && (
            <div className="msg-row flex flex-col items-start msg-enter">
              <div className="memo w-[460px] max-w-full">
                <div className="memo-head">
                  <span className="run-dot">
                    <Zap size={8} />
                  </span>
                  <span className="font-medium text-text/80">Run</span>
                  <span className="nums">· {formatEt(live.startedAt)}</span>
                  <span className="ml-auto flex items-center gap-1.5 truncate">
                    {live.pending ? (
                      <span className="shimmer-text font-medium">Starting…</span>
                    ) : live.retry ? (
                      <span className="text-warn truncate">
                        Retrying (attempt {live.retry.attempt}) — {live.retry.reason}
                      </span>
                    ) : live.tool ? (
                      <>
                        <span className="shimmer-text font-medium">Using</span>
                        <span className="mono text-2xs text-muted truncate">{live.tool.replace(/^mcp__\w+__/, '')}</span>
                      </>
                    ) : (
                      <span className="shimmer-text font-medium">{live.thinking ? 'Thinking…' : 'Working…'}</span>
                    )}
                  </span>
                </div>
                <div className="memo-body">
                  {live.text ? (
                    <Markdown text={live.text} />
                  ) : (
                    <span className="typing text-muted">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                  <LiveSteps steps={live.steps} />
                </div>
              </div>
            </div>
          )}
          {/* The operator's messages nothing is answering yet — queued behind the
              run above, in flight, or refused. Below the live bubble on purpose:
              that bubble is answering something earlier. The header names what
              they wait for and offers the way out (Stop → they go next). */}
          {tail.length > 0 && (
            <div className="flex flex-col gap-2.5 msg-enter">
              {working && tail.some((m) => msgStatus[m.id] !== 'failed') && (
                <div className="queue-head">
                  <Hourglass size={11} className="shrink-0" />
                  <span className="truncate">{QUEUE_COPY.header(config.name)}</span>
                  <button className="ml-auto shrink-0 text-accent font-medium hover:underline disabled:opacity-60 disabled:no-underline" disabled={stopping} onClick={stop}>
                    {stopping ? QUEUE_COPY.stopping : QUEUE_COPY.sendNow}
                  </button>
                </div>
              )}
              {tail.map((m) => (
                <MessageItem key={m.id} m={m} fresh={isFresh(m)} status={msgStatus[m.id] ?? 'queued'} onApplyPlan={onApplyPlan} onDismissPlan={onDismissPlan} onAnswer={send} onAnswerApproval={onAnswerApproval} onRetry={onRetry} onDiscard={onDiscard} />
              ))}
            </div>
          )}
        </div>
      </div>

      {failedRetirement && failedRetirement.role === 'system' && (
        <div className="shrink-0 px-5 pt-2.5 pb-1 bg-bg">
          <div className={cn(COLUMN, 'card px-3.5 py-2.5')} style={{ background: 'var(--tint-down)', boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--color-down) 40%, transparent)' }}>
            <div className="flex items-center gap-1.5">
              <span className="dot bg-down pulse" />
              <span className="eyebrow text-down">Could not retire — positions still open</span>
            </div>
            <div className="mt-1 text-sm text-text">{failedRetirement.text}</div>
          </div>
        </div>
      )}
      {pinned.length > 0 && (
        <div className="shrink-0 px-5 pt-2 pb-1 bg-bg">
          <div className={COLUMN}>
            <div className="flex items-center gap-2 mb-2 px-1">
              <button className="flex items-center gap-2 min-w-0 text-sm font-medium text-live hover:opacity-80 transition-opacity" onClick={() => setDockOpen((v) => !v)} aria-expanded={dockOpen} title={dockOpen ? 'Fold away — the ask stays in the sidebar' : 'Show the card'}>
                <span className="dot bg-live pulse shrink-0" />
                <span className="shrink-0">{pinned.length === 1 ? 'Waiting on you' : `${pinned.length} waiting on you`}</span>
                {!dockOpen && <span className="text-muted font-normal truncate">· {previewOf(pinned[0])}</span>}
                <ChevronDown size={12} className="text-muted shrink-0 transition-transform duration-[var(--dur)]" style={{ transform: dockOpen ? undefined : 'rotate(-90deg)', transitionTimingFunction: 'var(--ease-out)' }} />
              </button>
              {dockOpen && pinned.length > 1 && (
                <button className="ml-auto flex items-center gap-1 text-sm text-muted hover:text-text transition-colors" onClick={() => setStackExpanded((v) => !v)}>
                  {stackExpanded ? 'Stack' : 'Show all'}
                  {stackExpanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                </button>
              )}
            </div>
            {/* One card at a time, the oldest in front — it has waited longest.
                The rest peek out behind it the way a stack of toasts does:
                each one 10px higher and 4% smaller, ghosts only, so the
                front card keeps the whole width for its buttons. "Show all"
                lays them out in a column. Same MessageItem as the thread, so
                the pinned copy can never drift from the inline one. */}
            {!dockOpen ? null : stackExpanded || pinned.length === 1 ? (
              <div className="space-y-2 max-h-[40vh] overflow-y-auto pb-1 [&_.msg-row]:max-w-none">{pinned.map(card)}</div>
            ) : (
              <div className="relative isolate w-fit max-w-full pt-3 [&_.msg-row]:max-w-none">
                {pinned.slice(1, 4).map((m, i) => (
                  <div
                    key={m.id}
                    aria-hidden
                    className="absolute inset-x-0 top-3 bottom-0 pointer-events-none"
                    style={{ transform: `translateY(-${10 * (i + 1)}px) scale(${1 - 0.04 * (i + 1)})`, zIndex: -(i + 1), opacity: 1 - 0.2 * (i + 1), transition: 'transform var(--dur-slow) var(--ease-out), opacity var(--dur-slow) var(--ease-out)' }}
                  >
                    <div className="msg-card h-full w-full" />
                  </div>
                ))}
                <div className="relative">{card(pinned[0])}</div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* The refusal and the remedy travel together: Respawn sits IN the row, not
          only in the header — on a narrow window the header is the far end of the
          screen from where someone just tried to type. */}
      <Composer
        name={config.name}
        onSend={send}
        chips={['Change the plan: ', 'What’s your status?']}
        placeholder={working ? QUEUE_COPY.placeholder(config.name) : undefined}
        sendTitle={working ? QUEUE_COPY.sendTitle : undefined}
        queued={working}
        readOnlyReason={retired ? RETIRED_NO_MESSAGE : undefined}
        readOnlyIcon={retired ? <RotateCcw size={14} className="text-muted shrink-0" /> : undefined}
        readOnlyAction={
          retired ? (
            <button className="btn btn-accent disabled:opacity-60" disabled={respawning} onClick={respawnNow}>
              {respawning ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Respawning…
                </>
              ) : (
                'Respawn'
              )}
            </button>
          ) : undefined
        }
      />
    </section>
  )
}
