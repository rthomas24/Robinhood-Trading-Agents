import type { JSX, ReactNode } from 'react'
import { memo, useEffect, useState } from 'react'
import { AlertTriangle, Archive, Bell, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronRight, Clock, Eye, Hand, HelpCircle, Info, ListPlus, Pause, Play, ShieldCheck, Sparkles, X, Zap } from 'lucide-react'
import { loosensGuardrails, needsTypedConfirm, planDiffFor, reportFallbackText, riskSummary, TYPED_CONFIRM_WORD, type Guardrails, type ToolCallSummary } from '@shared/agents'
import { ToolActivity } from './ToolActivity'
import type { AgentReport, ApprovalMessage, Message, QuestionMessage, SystemKind, TradeAction } from '@shared/agents'
import { approvalExpired, heldForLabel, heldNotional } from '@shared/approval'
import { describeSchedule } from '@shared/schedule'
import { describeSettlesOn } from '@shared/settlement'
import { formatEt } from '@shared/marketTime'
import { QUEUE_COPY } from '@shared/messageQueue'
import { Markdown } from '@renderer/components/common/Markdown'
import { useApp } from '@renderer/store/appStore'
import { Amount, DepthGauge, LedgerLine, Money, Stamp, type GaugeLevel } from '@renderer/components/common/Primitives'
import { formatDuration } from '@renderer/lib/toolDisplay'
import { cn, clockTime, money } from '@renderer/lib/format'

/**
 * The thread's vocabulary, in four shapes. Which shape a message gets is the
 * first thing the operator reads, before a word of it:
 *
 *   bubble  — the operator's own words, and ONLY theirs. One speaker has a
 *             bubble so the thread never reads like two people chatting.
 *   memo    — an agent's turn: a ruled head (who, when in ET, how long), prose,
 *             and a book line when the turn moved money. Correspondence with a
 *             colleague who reports, not a chat message.
 *   receipt — a fill. A settled fact gets a slip: a side band in ink drawn once
 *             on arrival, mono figures, dotted leaders, an ET stamp. The
 *             economics are the ones FROZEN on the message at the fill, never
 *             recomputed — a receipt has to keep telling the truth about its own
 *             moment after later trades move the position.
 *   card     — anything that asks something of the operator (a question, a held
 *             action, a plan) or files a structured result. A card waiting on an
 *             answer carries `data-pending`, which is the one place the accent
 *             edge is spent in the transcript.
 *
 * Colour is rationed the same way everywhere: up/down are MONEY, warn is a
 * refusal or a deadline, brass is real money, the accent is the action. Nothing
 * here is coloured for emphasis.
 */

/** One card width across the thread — cards that differ in width read as different products. */
const CARD = 'w-[440px] max-w-full'
/** A receipt is a slip, and a slip is narrower than a memo. */
const SLIP = 'w-[380px] max-w-full'

/** "in 7 min" / "overdue" — re-rendered every 30 s so an open card stays honest. */
function useCountdown(deadline: string | undefined): string | null {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!deadline) return
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [deadline])
  if (!deadline) return null
  const ms = new Date(deadline).getTime() - Date.now()
  if (ms <= 0) return 'deadline passed'
  const min = Math.round(ms / 60_000)
  return min < 1 ? 'under a minute left' : `${min} min left`
}

/* ─────────────────────────────── shells ─────────────────────────────── */

/** One message row: side, enter animation, hover timestamp. */
function Row({ side, fresh, ts, children, className }: { side: 'left' | 'right'; fresh?: boolean; ts?: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('msg-row flex flex-col', side === 'right' ? 'items-end' : 'items-start', fresh && 'msg-enter', className)}>
      {children}
      {ts && <span className="msg-time text-2xs text-muted mt-1 px-1.5 select-none nums">{clockTime(ts)}</span>}
    </div>
  )
}

/** The card's first line: what kind of thing this is, and when — in ET, like everything the engine states. */
function CardHead({ icon, label, cls, ts, right }: { icon: ReactNode; label: string; cls?: string; ts?: string; right?: ReactNode }): JSX.Element {
  return (
    <div className={cn('flex items-center gap-1.5 px-3.5 pt-2.5 text-xs font-medium', cls ?? 'text-muted')}>
      {icon}
      <span>{label}</span>
      <span className="ml-auto flex items-center gap-2 font-normal text-muted">
        {right}
        {ts && <span className="text-xs nums">{formatEt(ts)}</span>}
      </span>
    </div>
  )
}

/** The agent asked for this to notify the operator. Tone, never a badge colour. */
function NotifyFlag({ notify }: { notify?: 'fyi' | 'important' }): JSX.Element | null {
  if (!notify) return null
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', notify === 'important' ? 'text-warn' : 'text-muted')} title="The agent flagged this as a notification">
      <Bell size={10} /> {notify === 'important' ? 'Important' : 'Heads-up'}
    </span>
  )
}

/* ───────────────────────────── system notes ─────────────────────────── */

const NOTE_KIND: Record<SystemKind, { icon: JSX.Element; chip: string }> = {
  created: { icon: <Sparkles size={11} />, chip: 'bg-accent/12 text-accent' },
  schedule: { icon: <CalendarClock size={11} />, chip: 'bg-accent/12 text-accent' },
  mode: { icon: <ShieldCheck size={11} />, chip: 'bg-accent/12 text-accent' },
  // Not the money green: an agent resuming is a lifecycle state, and a green
  // that can mean "running again" can no longer mean "made money".
  resumed: { icon: <Play size={11} />, chip: 'bg-accent/12 text-accent' },
  paused: { icon: <Pause size={11} />, chip: 'bg-warn/14 text-warn' },
  error: { icon: <AlertTriangle size={11} />, chip: 'bg-warn/14 text-warn' },
  retired: { icon: <Archive size={11} />, chip: 'bg-surface-3 text-muted' },
  info: { icon: <Info size={11} />, chip: 'bg-surface-3 text-muted' }
}

/**
 * A lifecycle event as one line on the timeline. Deliberately the quietest
 * shape in the thread: it is context for the messages around it, not an event
 * competing with them — except when the SENDER marked it important, which is
 * the engine stopping an agent and has to be legible at a glance.
 */
function SystemNote({ kind, text, ts, fresh, notify }: { kind: SystemKind; text: string; ts: string; fresh?: boolean; notify?: 'fyi' | 'important' }): JSX.Element {
  const k = NOTE_KIND[kind] ?? NOTE_KIND.info
  return (
    <div className={cn('msg-row flex items-start gap-2.5 py-1 pl-1 pr-2 max-w-[82%]', fresh && 'msg-enter')}>
      <span className={cn('mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-xs', k.chip)} aria-hidden>
        {k.icon}
      </span>
      <span className={cn('text-sm leading-relaxed min-w-0', kind === 'error' ? 'text-warn' : 'text-muted')}>
        {text}
        {notify === 'important' && (
          <span className="ml-1.5 inline-flex translate-y-px items-center gap-1 text-xs text-warn" title="Sent as a notification">
            <Bell size={10} />
          </span>
        )}
      </span>
      <span className="msg-time shrink-0 text-2xs text-muted mt-1 select-none nums">{clockTime(ts)}</span>
    </div>
  )
}

/* ──────────────────────────────── memos ─────────────────────────────── */

// A run's status is not a P&L. `done` used to be the money green, which spends
// the one colour that means "this made money" on "the turn finished" — so it is
// full-strength text against a muted `held`, and the accent stays reserved for
// the turn that actually did something.
const REPORT_STATUS: Record<AgentReport['status'], { label: string; icon: JSX.Element; cls: string }> = {
  acted: { label: 'Acted', icon: <Zap size={11} />, cls: 'text-accent' },
  held: { label: 'Held', icon: <Eye size={11} />, cls: 'text-muted' },
  blocked: { label: 'Blocked', icon: <AlertTriangle size={11} />, cls: 'text-warn' },
  done: { label: 'Done', icon: <CheckCircle2 size={11} />, cls: 'text-text' }
}
const FACT_TONE: Record<NonNullable<AgentReport['facts']>[number]['tone'] & string, string> = { up: 'text-up', down: 'text-down', flat: 'text-muted' }

/**
 * The engine's refusals are ordinary tool RESULTS, not errors — a guardrail
 * rejection, a sell of something the agent does not hold, the trail-floor and
 * cut-inside-the-noise advisories. All of them open with a stable marker
 * (`core/runner/runOnce.ts`, `shared/agents.ts`), and `result` is the full text
 * while `output` is its first 300 characters, so either one carries it.
 */
const NOT_PLACED = /^\s*(REJECTED:|NOT PLACED)/

/**
 * Orders this turn actually placed: a `trade` call the gate let through, the
 * tool answered, and the answer was not one of the engine's non-placements.
 *
 * `null` means the record cannot say — a `trade` call whose result never landed
 * (the run was cut off mid-work, or the detail budget ran out). The footer
 * renders nothing on a `null`: on a surface that states what happened to real
 * money, silence is the only honest form of "we do not know".
 */
function ordersPlaced(calls: ToolCallSummary[] | undefined): number | null {
  if (!calls) return 0
  let placed = 0
  for (const c of calls) {
    if (!/(^|__)trade$/.test(c.name)) continue
    if (c.blocked || c.error) continue
    const answers = [c.result, c.output].filter((t): t is string => typeof t === 'string')
    if (answers.length === 0) return null
    if (answers.some((t) => NOT_PLACED.test(t))) continue
    placed++
  }
  return placed
}

/**
 * Time spent INSIDE tools this turn, when the rows carry timings. Not the
 * turn's elapsed time and never labelled as one: a vendor runs a turn's calls
 * concurrently, so this sum can exceed the wall clock it sat beside.
 */
function toolTime(calls: ToolCallSummary[] | undefined): string | null {
  if (!calls?.length) return null
  let ms = 0
  let seen = false
  for (const c of calls) {
    if (c.durationMs !== undefined && Number.isFinite(c.durationMs)) {
      ms += c.durationMs
      seen = true
    }
  }
  return seen ? formatDuration(ms) : null
}

/**
 * The memo's ruled head: who spoke, when in ET, and how long it spent in tools.
 * `name` is optional and the slot is DROPPED when we have none — a head that
 * printed the kind of message ("Update") where the speaker belongs named
 * nothing at all, which is worse than a head that only carries a time.
 */
function MemoHead({ icon, name, ts, toolMs, right }: { icon: ReactNode; name?: string; ts: string; toolMs?: string | null; right?: ReactNode }): JSX.Element {
  return (
    <div className="memo-head">
      <span className="text-muted" aria-hidden>
        {icon}
      </span>
      {name && <span className="font-medium text-text">{name}</span>}
      <span className="nums">
        {name ? '· ' : ''}
        {formatEt(ts)}
      </span>
      {/* Said for what it is. A turn's tool calls can run concurrently, so this
          sum is often larger than the turn's elapsed time — beside an ET
          timestamp, an unlabelled duration reads as the latter. */}
      {toolMs && (
        <span className="nums" title="Time spent inside tools this turn — calls can overlap, so this is not how long the turn took">
          · {toolMs} in tools
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">{right}</span>
    </div>
  )
}

/** The statement footer under a turn that moved money. */
function BookLine({ orders }: { orders: number }): JSX.Element {
  return (
    <div className="book-line">
      <span className="inline-flex items-center gap-1.5 text-text">
        <Zap size={11} />
        <span className="font-medium">
          {orders} order{orders === 1 ? '' : 's'} placed this turn
        </span>
      </span>
      <span>the receipts carry the money</span>
    </div>
  )
}

/**
 * A plain agent turn — prose without a report — is a MEMO, the same shape its
 * reports get. Two looks for one speaker read as two products: a paper agent's
 * scheduled runs ended in cards while its replies came back as bubbles with a
 * mono tool dump under them. One head, one body, the full activity record
 * (`ToolActivity`) under the text on every turn.
 */
function TurnMemo({ m, ts, agentName }: { m: Extract<Message, { role: 'agent' }>; ts: string; agentName?: string }): JSX.Element {
  const orders = ordersPlaced(m.toolCalls)
  const said = m.text.trim()
  return (
    // An update the agent ESCALATED to a notification keeps the edge the
    // design system spends on "this wants you" — without it a deliberate
    // escalation reads exactly like the scheduled tick before it.
    <article className={cn('memo', CARD, m.notify === 'important' && 'ring-1 ring-accent/45')} aria-label="Agent update">
      <MemoHead icon={<Zap size={11} />} name={agentName} ts={ts} toolMs={toolTime(m.toolCalls)} right={<NotifyFlag notify={m.notify} />} />
      <div className="memo-body break-words">
        {said ? <Markdown text={m.text} /> : <p className="text-sm text-muted">It ended the turn without writing anything.</p>}
        <ToolActivity calls={m.toolCalls ?? []} thinking={m.thinking} className="mt-2.5" />
      </div>
      {orders !== null && orders > 0 && <BookLine orders={orders} />}
    </article>
  )
}

/**
 * The structured end-of-run summary. The status and the headline answer the
 * thread's real question ("did anything happen?") before a word is read; the
 * facts are a statement of figures set with dotted leaders; `next` is the book
 * line. `prose` is the model's own closing text when it wrote one anyway and it
 * differs from the composed fallback — shown under the facts, never dropped.
 */
function ReportMemo({ report, prose, ts, notify, tools, agentName }: { report: AgentReport; prose?: string; ts: string; notify?: 'fyi' | 'important'; tools?: ReactNode; agentName?: string }): JSX.Element {
  const s = REPORT_STATUS[report.status] ?? REPORT_STATUS.held
  return (
    <article className={cn('memo', CARD, notify === 'important' && 'ring-1 ring-accent/45')} aria-label={`Run report — ${s.label}`}>
      <MemoHead
        icon={s.icon}
        name={agentName}
        ts={ts}
        right={
          <>
            <NotifyFlag notify={notify} />
            <span className={cn('inline-flex items-center gap-1 font-medium', s.cls)}>{s.label}</span>
          </>
        }
      />
      <div className="memo-body">
        <h3 className="text-lg font-medium leading-snug tracking-[-0.01em]">{report.headline}</h3>
        {report.facts && report.facts.length > 0 && (
          <dl className="mt-3 flex flex-col gap-1.5">
            {report.facts.map((f, i) => (
              <div key={i} className="leader text-sm">
                <dt className="min-w-0 truncate">{f.label}</dt>
                <dd className={cn('nums', f.tone ? FACT_TONE[f.tone] : 'text-text')}>
                  {f.value}
                  {f.delta && <span className="ml-1.5 text-xs text-muted">{f.delta}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {report.details && <p className="mt-3 text-sm text-muted leading-relaxed whitespace-pre-wrap">{report.details}</p>}
        {prose && (
          <div className="mt-3 pt-3 hair-t text-base">
            <Markdown text={prose} />
          </div>
        )}
        {tools}
      </div>
      {report.next && (
        <div className="book-line">
          <span className="inline-flex items-start gap-1.5">
            <Clock size={11} className="mt-[3px] shrink-0" />
            <span className="leading-relaxed">
              <span className="font-medium text-text">Next</span> · {report.next}
            </span>
          </span>
        </div>
      )}
    </article>
  )
}

/* ─────────────────────────────── questions ──────────────────────────── */

/**
 * A check-in. Stakes first, because the operator decides how much attention to
 * spend before they read the question; then the choices; then, plainly, what
 * happens if they say nothing and by when. The fallback is the promise the
 * engine keeps on their behalf, so it is never a footnote.
 */
function QuestionCard({ m, onAnswer }: { m: QuestionMessage; onAnswer: (text: string) => void }): JSX.Element {
  const open = !m.answeredBy
  const left = useCountdown(open ? m.deadline : undefined)
  // Unanswered AND past the deadline: the fallback is now what happens, but it
  // has NOT happened — the engine still owes this a 'timeout' run. So the card
  // stops offering choices and says what is about to be done, in the future
  // tense. The operator can still beat the timeout by replying.
  const expiring = open && !!m.deadline && Date.parse(m.deadline) <= Date.now()
  return (
    <section className={cn('msg-card', CARD)} data-pending={open && !expiring ? 'true' : undefined} aria-label="Question from the agent">
      <CardHead
        icon={<HelpCircle size={12} />}
        label="Question"
        cls="text-accent"
        ts={open ? undefined : m.ts}
        right={
          open && left ? (
            <span className={cn('inline-flex items-center gap-1 text-xs nums', left === 'deadline passed' ? 'text-warn' : 'text-muted')}>
              <Clock size={11} /> {left}
            </span>
          ) : undefined
        }
      />
      <div className="px-3.5 pt-1.5 pb-3">
        {/* Stakes first: it is what tells the operator how much attention to spend before they read the question. */}
        {m.stakes && <p className="text-sm text-muted leading-relaxed">{m.stakes}</p>}
        <h3 className={cn('text-lg font-medium leading-snug tracking-[-0.01em]', m.stakes && 'mt-1')}>{m.text}</h3>
        {m.fallback && open && !expiring && (
          <p className="mt-3 inset rounded-md px-3 py-2 text-sm leading-relaxed">
            If no answer{m.deadline ? ` by ${formatEt(m.deadline)}` : ''}: <span className="font-medium text-text">{m.fallback}</span>
          </p>
        )}
        {expiring ? (
          <p className="mt-3 text-sm text-warn flex items-start gap-1.5 leading-relaxed">
            <Clock size={12} className="mt-[3px] shrink-0" />
            <span>
              No answer by {m.deadline ? formatEt(m.deadline) : 'the deadline'} — taking the fallback: <span className="font-medium">{m.fallback ?? 'its stated default'}</span>
            </span>
          </p>
        ) : open ? (
          m.options?.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {m.options.map((o) => (
                <button key={o} type="button" className="btn btn-outline btn-sm" onClick={() => onAnswer(o)}>
                  {o}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">Reply in the thread to answer.</p>
          )
        ) : m.answeredVia === 'timeout' ? (
          <p className="mt-3 text-sm text-warn flex items-start gap-1.5 leading-relaxed">
            <Clock size={12} className="mt-[3px] shrink-0" />
            <span>
              No answer by {m.deadline ? formatEt(m.deadline) : 'the deadline'} — did the fallback: <span className="font-medium">{m.answeredBy}</span>
            </span>
          </p>
        ) : (
          <p className="mt-3 text-sm text-up flex items-start gap-1.5">
            <Check size={12} className="mt-[3px] shrink-0" />
            <span>
              You: <span className="font-medium">{m.answeredBy}</span>
            </span>
          </p>
        )}
      </div>
    </section>
  )
}

/* ─────────────────────────────── approvals ──────────────────────────── */

const APPROVAL_LABEL: Record<ApprovalMessage['status'], string> = { pending: 'Needs your OK', approved: 'Approved', rejected: 'Declined', withdrawn: 'Withdrawn' }

/**
 * A held action. The agent is stopped until this is answered, so the card leads
 * with the two prices — what it decided against, and what is true now — because
 * that gap is the whole reason approving re-opens the decision instead of firing
 * it. Then what it wants to do, then its reasoning, then the two buttons.
 */
function ApprovalCard({ m, onAnswer, quoteNow }: { m: ApprovalMessage; onAnswer: (messageId: string, approve: boolean) => void; quoteNow?: number }): JSX.Element {
  const [, tick] = useState(0)
  const pending = m.status === 'pending'
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [pending])
  const a = m.action
  const [why, setWhy] = useState(pending)
  const held = heldForLabel(Date.now() - new Date(a.requestedAt).getTime())
  const sell = a.side === 'sell'
  const notional = heldNotional(a)
  const label = APPROVAL_LABEL[m.status]
  // A yes that was never spent stops being a yes after 72 hours (APPROVAL_TTL_MS).
  // A card that still says "Approved" days later is the one thing an audit trail
  // must not do, so an expired pass is stamped as what it now is.
  const expired = m.status === 'approved' && approvalExpired(a, new Date())
  const delta = a.quote !== undefined && a.quote > 0 && quoteNow !== undefined ? ((quoteNow - a.quote) / a.quote) * 100 : null
  return (
    <section className={cn('msg-card', CARD, !pending && m.status !== 'approved' && 'opacity-70')} data-pending={pending ? 'true' : undefined} aria-label="Action held for your approval">
      <CardHead
        icon={<Hand size={12} />}
        label={label}
        cls={pending ? 'text-accent' : m.status === 'approved' ? 'text-up' : 'text-muted'}
        ts={pending ? undefined : m.ts}
        right={
          pending ? (
            <span className="text-xs nums">waiting {held}</span>
          ) : expired ? (
            <Stamp tone="warn">Expired</Stamp>
          ) : (
            <Stamp tone={m.status === 'approved' ? 'accent' : 'muted'}>{m.status === 'approved' ? 'Spent' : label}</Stamp>
          )
        }
      />
      <div className="px-3.5 pt-1.5 pb-3">
        {/* The price it decided against, beside the price now. */}
        {a.quote !== undefined && (
          <p className="text-xs text-muted nums">
            {quoteNow !== undefined && delta !== null ? (
              <>
                Decided at <span className="text-text">{money(a.quote)}</span> · now <span className="text-text">{money(quoteNow)}</span> ({delta >= 0 ? '+' : '−'}
                {Math.abs(delta).toFixed(2)}%)
              </>
            ) : (
              <>
                {a.symbol ?? 'It'} was {money(a.quote)} when it asked
              </>
            )}
          </p>
        )}
        <h3 className={cn('text-lg font-medium tracking-[-0.01em] leading-snug', a.quote !== undefined && 'mt-1', sell ? 'text-down' : 'text-up')}>{a.summary}</h3>
        {/* What it is worth. An order we cannot value says nothing rather than
            "$0", and an estimate is labelled as one — this is the screen where
            the operator's judgement IS the safety mechanism. */}
        {notional && (
          <p className="mt-1 text-base font-medium">
            <span className="money">
              {notional.basis === 'quote' ? '≈' : ''}
              {money(notional.amount)}
            </span>
            <span className="ml-1.5 text-xs font-normal text-muted">{notional.basis === 'limit' ? 'at your limit' : notional.basis === 'quote' ? 'at the price it saw' : ''}</span>
          </p>
        )}

        {/* The reason an order for real money was proposed. While the card is
            PENDING it folds away, because the space above it — the two prices,
            the size, the two buttons — is what the operator is answering. Once
            the card is answered it is the audit trail for that decision, and an
            audit trail does not live behind a disclosure: it is set out in
            full, in the past tense. */}
        <div className="mt-3 hair-t pt-2">
          {pending ? (
            <>
              <button type="button" className="flex w-full items-center gap-1.5 text-xs font-medium text-muted hover:text-text transition-colors" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
                {why ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>Why it wants this</span>
              </button>
              {/* `inert` while folded: the fold clips its content with a grid
                  row rather than `display:none`, so without this a screen
                  reader read text the toggle had just called hidden. */}
              <div className="fold" data-open={why ? 'true' : 'false'} inert={!why}>
                <div>
                  <p className="pt-1.5 text-sm leading-relaxed">{a.reason}</p>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs font-medium text-muted">Why it wanted this</p>
              <p className="pt-1.5 text-sm leading-relaxed">{a.reason}</p>
            </>
          )}
        </div>

        {pending ? (
          <>
            <p className="mt-3 text-xs text-muted leading-relaxed">Nothing happens until you answer — the agent is holding. When you approve, it checks the price again before acting.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn btn-accent h-8" onClick={() => onAnswer(m.id, true)}>
                <Check size={14} /> Approve
              </button>
              <button type="button" className="btn btn-outline h-8" onClick={() => onAnswer(m.id, false)}>
                <X size={14} /> Decline
              </button>
            </div>
          </>
        ) : (
          m.outcome && <p className="mt-3 text-sm text-muted leading-relaxed">{m.outcome}</p>
        )}
      </div>
    </section>
  )
}

/* ──────────────────────────────── receipts ──────────────────────────── */

const EXIT_LABEL: Record<NonNullable<TradeAction['exitTrigger']>['kind'], string> = {
  trail: 'Trailing stop',
  stop: 'Stop',
  target: 'Target',
  invalidation: 'Invalidation',
  flatten: 'Flatten time'
}
/** The gauge colours by ROLE; a flatten is a clock, not a level, so it has no tick. */
const EXIT_ROLE: Partial<Record<NonNullable<TradeAction['exitTrigger']>['kind'], GaugeLevel['role']>> = {
  trail: 'trail',
  stop: 'stop',
  target: 'target',
  invalidation: 'invalidation'
}

/**
 * A fill, as a receipt. Everything on it comes from the economics FROZEN onto
 * the message at the moment of the fill (`TradeAction.econ`) — never recomputed
 * from the book as it stands now, because a later trade moving the position must
 * not change what this slip says about its own moment.
 */
function Receipt({ a, ts, fresh }: { a: TradeAction; ts: string; fresh?: boolean }): JSX.Element {
  const filled = a.status === 'filled'
  const bad = a.status === 'rejected' || a.status === 'error'
  const qty = a.fillQty ?? a.qty
  const px = a.fillPrice ?? a.limitPrice ?? a.refPrice
  const e = a.econ
  const buy = a.side === 'buy'
  const realized = e?.realized
  const win = (realized ?? 0) >= 0
  const trig = a.exitTrigger
  const gaugeRole = trig ? EXIT_ROLE[trig.kind] : undefined
  // Only worth drawing when the level and the fill are two different places on
  // one price line — otherwise the sentence above already said everything.
  const levels: GaugeLevel[] = trig && gaugeRole && Number.isFinite(trig.level) ? [{ price: trig.level, label: EXIT_LABEL[trig.kind], role: gaugeRole }] : []
  if (e?.costBasis !== undefined && levels.length) levels.push({ price: e.costBasis, label: 'cost', role: 'cost' })
  return (
    <article className={cn('receipt', SLIP)} aria-label={`${buy ? 'Buy' : 'Sell'} ${a.symbol} — ${a.status}`}>
      {/* The band draws itself once on arrival — the app's one signature motion. */}
      <div className={cn('receipt-band', bad ? 'text-warn' : filled ? 'text-text' : 'text-text-3')} data-fresh={fresh ? 'true' : undefined} aria-hidden>
        <span />
      </div>

      <div className="flex items-baseline gap-2 px-3.5 pt-3">
        <span className={cn('inline-flex h-5 items-center rounded-xs px-1.5 text-xs font-medium', buy ? 'bg-up/12 text-up' : 'bg-down/12 text-down')}>{buy ? 'Buy' : 'Sell'}</span>
        <span className="receipt-fig text-lg font-medium">
          {qty ? `${qty} ` : a.notional ? `$${a.notional} ` : ''}
          {a.symbol}
        </span>
        {filled && px !== undefined && <span className="receipt-fig text-sm text-muted">@ {money(px)}</span>}
        <span className="ml-auto flex items-center gap-2">
          {filled ? <Stamp tone="muted">Filled</Stamp> : a.status === 'open' ? <Stamp tone="accent">Working</Stamp> : bad ? <Stamp tone="warn">{a.status === 'rejected' ? 'Rejected' : 'Error'}</Stamp> : <Stamp tone="muted">Cancelled</Stamp>}
        </span>
      </div>
      <div className="px-3.5 pt-0.5 text-2xs text-muted nums">{formatEt(ts)}</div>

      <div className="px-3.5 pt-2.5 pb-3">
        {!filled && <p className={cn('text-sm leading-relaxed', bad ? 'text-warn' : 'text-muted')}>{bad ? (a.error ?? 'Rejected') : a.status === 'open' ? `Working order${a.limitPrice ? ` · limit ${money(a.limitPrice)}` : ''}` : 'Cancelled before it filled.'}</p>}

        {/* The statement: what the money did, as leaders. */}
        {filled && (
          <div className="flex flex-col gap-1">
            {/* A fill we cannot value says nothing rather than "$0.00". */}
            {(e?.notional !== undefined || (qty !== undefined && px !== undefined)) && <LedgerLine label="Notional" value={<Amount value={e?.notional ?? (qty ?? 0) * (px ?? 0)} />} />}
            {e?.costBasis !== undefined && <LedgerLine label="Cost basis" value={<span className="money">{money(e.costBasis)}/sh</span>} />}
            {e && <LedgerLine label="Position" value={e.positionQty > 0 ? <span className="money">{`${e.positionQty} @ ${money(e.positionAvgCost)}`}</span> : <span className="text-muted">closed</span>} />}
            {e && <LedgerLine label="Book realized" value={<Money value={e.bookRealized} />} />}
            {/* When the money is back: T+1, the day a cash account can spend it again. */}
            {!buy && e?.settlesOn && <LedgerLine label="Settles" value={<span className="text-text">{describeSettlesOn(e.settlesOn)}</span>} />}
          </div>
        )}

        {/* The result. The only place this thread ever states one, so it leads
            with the signed figure and says what percentage that was. */}
        {filled && realized !== undefined && (
          <div className={cn('mt-3 rounded-md px-3 py-2.5', win ? 'bg-up/8' : 'bg-down/8')}>
            <div className="flex items-baseline gap-2">
              <Money value={realized} pct={e?.realizedPct} className="hero-num" />
              <span className="ml-auto text-xs text-muted">realized</span>
            </div>
          </div>
        )}

        {/* A re-entry after a stop-out — the commonest losing pattern, named as it recurs. */}
        {a.reentry && buy && (
          <p className="mt-2.5 text-xs text-warn nums">
            Re-entering {a.symbol}, {a.reentry.minutesAfter} min after a −{money(a.reentry.lossUsd)} stop-out
          </p>
        )}

        {/* An ENGINE exit: which level fired, what it filled at, and the dollars between. */}
        {trig && (
          <div className="mt-2.5 inset rounded-md px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted nums" title="Trigger level vs the fill the market gave">
              <span className="font-medium text-text">{EXIT_LABEL[trig.kind]}</span>
              {trig.kind !== 'flatten' && <span>triggered at {money(trig.level)}</span>}
              {filled && px !== undefined && <span>· filled {money(px)}</span>}
              {trig.slippageUsd !== undefined && trig.kind !== 'flatten' && (
                <span className={cn('font-medium', trig.slippageUsd > 0 ? 'text-down' : 'text-up')}>
                  · slippage {trig.slippageUsd > 0 ? '−' : '+'}
                  {money(Math.abs(trig.slippageUsd))}
                </span>
              )}
            </div>
            {filled && px !== undefined && levels.length > 0 && <DepthGauge price={px} levels={levels} className="mt-2" />}
          </div>
        )}

        {a.reason && <p className="mt-2.5 text-sm leading-relaxed">{a.reason}</p>}

        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          {/* The broker's order id is not for reading — it stays on the stamp's
              tooltip for anyone matching a fill against Robinhood's history. */}
          {a.mode === 'live' ? (
            <Stamp tone="muted" className="text-live" title={a.orderId ? `Robinhood order ${a.orderId}` : undefined}>
              Live
            </Stamp>
          ) : (
            <Stamp tone="muted" className="text-paper" title={a.orderId ? `Paper order ${a.orderId}` : undefined}>
              Paper
            </Stamp>
          )}
        </div>
      </div>
    </article>
  )
}

/* ─────────────────────────────── plans ──────────────────────────────── */

function PlanCard({ m, guardrails, allocationUsd, onApplyPlan, onDismissPlan }: { m: Extract<Message, { role: 'plan' }>; guardrails?: Guardrails; allocationUsd?: number; onApplyPlan: (id: string) => void; onDismissPlan: (id: string) => void }): JSX.Element {
  // A pending card re-derives against the guardrails as they stand now; an
  // applied or dismissed one keeps the diff frozen when it was proposed.
  const planRows = guardrails ? planDiffFor(m.plan, m.status, guardrails) : (m.plan.diff ?? [])
  const pending = m.status === 'pending'
  const [typed, setTyped] = useState('')
  // What the fence would MEAN after this plan, in money, and whether a tap is
  // enough: widening the daily loss past 10% or one
  // order past 25% of the allocation needs the word typed.
  const nextGuardrails = guardrails ? { ...guardrails, ...m.plan.guardrails } : null
  const widens = planRows.length > 0 && loosensGuardrails(planRows)
  const risk = widens && nextGuardrails && allocationUsd ? riskSummary(nextGuardrails, allocationUsd) : null
  const mustType = pending && widens && nextGuardrails && allocationUsd ? needsTypedConfirm(nextGuardrails, allocationUsd) : false
  const typedOk = !mustType || typed.trim().toLowerCase() === TYPED_CONFIRM_WORD
  const label = m.plan.spawnAgent
    ? `New agent ${pending ? 'proposed' : m.status === 'applied' ? 'created' : m.status}`
    : m.plan.addTask
      ? `New task ${pending ? 'proposed' : m.status}`
      : `Plan ${pending ? 'proposed' : m.status}`
  const confirmId = `confirm-${m.id}`
  return (
    <section className={cn('msg-card', CARD, m.status === 'dismissed' && 'opacity-60')} data-pending={pending ? 'true' : undefined} aria-label={label}>
      <CardHead icon={m.plan.spawnAgent ? <Sparkles size={12} /> : m.plan.addTask ? <ListPlus size={12} /> : <CalendarClock size={12} />} label={label} cls={pending ? 'text-accent' : m.status === 'applied' ? 'text-up' : 'text-muted'} ts={m.ts} />
      <div className="px-3.5 pt-1.5 pb-3">
        {m.plan.spawnAgent ? (
          <>
            <h3 className="text-lg font-medium tracking-[-0.01em]">{m.plan.spawnAgent.name}</h3>
            <p className="mt-1 text-sm leading-relaxed">“{m.plan.spawnAgent.task}”</p>
            <p className="mt-1.5 text-sm text-muted leading-relaxed">{m.plan.spawnAgent.why}</p>
            {m.plan.spawnAgent.schedule && <p className="mt-1 text-sm text-muted">{describeSchedule(m.plan.spawnAgent.schedule)}</p>}
            <p className="mt-2 text-xs text-muted leading-relaxed">
              {pending
                ? 'A separate agent, focused only on this. It inherits this one’s mode, guardrails and allocation, and counts against your plan’s agent limit.'
                : m.status === 'applied'
                  ? 'Created — it runs on its own from here.'
                  : 'Not created.'}
            </p>
          </>
        ) : m.plan.addTask ? (
          <>
            <h3 className="text-lg font-medium tracking-[-0.01em] leading-snug">“{m.plan.addTask}”</h3>
            <p className="mt-1.5 text-sm text-muted leading-relaxed">
              {pending ? 'Adding this gives the agent a second standing job — it works on this every run, alongside what it already does.' : m.status === 'applied' ? 'Added — the agent works on this every run now.' : 'Not added.'}
            </p>
          </>
        ) : (
          <h3 className="text-lg font-medium tracking-[-0.01em] leading-snug">{m.plan.summary}</h3>
        )}
        {m.plan.name && <p className="mt-1.5 text-sm">Renamed to “{m.plan.name}”</p>}
        {m.plan.task && !m.plan.addTask && <p className="mt-1.5 text-sm leading-relaxed">{m.plan.task}</p>}
        {m.plan.schedule && <p className="mt-1.5 text-sm text-muted">{describeSchedule(m.plan.schedule)}</p>}
        {/* The frozen diff — a widening and a tightening are opposite events and
            must not look alike. Older plans carry no diff; fall back to the values. */}
        {planRows.length ? (
          <div className="mt-3 -mx-1">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Limit</th>
                  <th scope="col" className="num">
                    Now
                  </th>
                  <th scope="col" className="num">
                    After
                  </th>
                </tr>
              </thead>
              <tbody>
                {planRows.map((d) => (
                  <tr key={d.key}>
                    <td className="text-muted">{d.label}</td>
                    <td className="num text-muted">{d.from}</td>
                    <td className={cn('num', d.looser ? 'font-medium text-warn' : 'text-text')}>
                      {d.to}
                      {d.looser && <span className="sr-only"> (looser)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          Object.keys(m.plan.guardrails).length > 0 && (
            <p className="mt-1.5 text-xs text-muted">
              {Object.entries(m.plan.guardrails)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
                .join(' · ')}
            </p>
          )
        )}
        {risk && <p className="mt-2.5 text-xs text-warn leading-relaxed">{risk}</p>}
        {mustType && (
          <div className="mt-3 inset rounded-md px-3 py-2.5">
            <label className="label text-xs text-muted leading-relaxed" htmlFor={confirmId}>
              This widens the fence past the line a tap can cross. Type <b className="text-text">{TYPED_CONFIRM_WORD}</b> to confirm:
            </label>
            <input id={confirmId} className="input h-7" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={TYPED_CONFIRM_WORD} autoComplete="off" spellCheck={false} aria-invalid={typed.length > 0 && !typedOk} />
          </div>
        )}
        {pending && (
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn btn-accent h-8" disabled={!typedOk} title={typedOk ? undefined : `Type ${TYPED_CONFIRM_WORD} above first`} onClick={() => typedOk && onApplyPlan(m.id)}>
              <Check size={14} /> {m.plan.spawnAgent ? 'Create agent' : m.plan.addTask ? 'Add task' : 'Apply'}
            </button>
            <button type="button" className="btn btn-ghost h-8" onClick={() => onDismissPlan(m.id)}>
              <X size={14} /> {m.plan.spawnAgent || m.plan.addTask ? 'No thanks' : 'Dismiss'}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

/* ─────────────────────────────── dispatch ───────────────────────────── */

/**
 * Who is speaking on a memo head. Every place a message row is rendered — the
 * thread, the pinned "waiting on you" dock — is ONE agent's transcript, so the
 * selected agent is the speaker. Read here rather than threaded through as a
 * prop because the selector returns a string: the memo re-renders when the
 * agent is renamed, and not once for every run delta.
 */
function useSpeakerName(): string | undefined {
  return useApp((s) => (s.selectedId ? s.agents[s.selectedId]?.config.name : undefined))
}

/** Memoized: thread re-renders on every run:delta/state event; message rows only change when their message does. */
export const MessageItem = memo(function MessageItem({
  m,
  guardrails,
  fresh,
  allocationUsd,
  agentName,
  quoteNow,
  onApplyPlan,
  onDismissPlan,
  onAnswer,
  onAnswerApproval,
  status,
  onRetry,
  onDiscard
}: {
  m: Message
  /** The agent's guardrails as they stand now — a PENDING plan card re-derives its diff against these, so the "from" cannot go stale while the card waits. */
  guardrails?: Guardrails
  /** Arrived after the thread was opened → animates in. History paints in place. */
  fresh?: boolean
  /** The agent's allocation, for the risk sentence a widening plan carries. */
  allocationUsd?: number
  /** Names the speaker on a memo head. Optional: absent, the speaker is taken from the open thread's agent, and the slot is dropped if there is none. */
  agentName?: string
  /** The held symbol's price NOW, when the caller has one — an approval card leads with the gap between it and the price the agent decided against. */
  quoteNow?: number
  onApplyPlan: (id: string) => void
  onDismissPlan: (id: string) => void
  onAnswer: (text: string) => void
  onAnswerApproval: (messageId: string, approve: boolean) => void
  /**
   * The operator's own message, by where it is: `sending` (in flight to the
   * engine), `failed` (the engine refused it — kept on screen with a retry),
   * `queued` (sent to an agent mid-run; goes out when that run ends —
   * shared/messageQueue.ts). Absent = an ordinary sent message.
   */
  status?: 'sending' | 'failed' | 'queued'
  onRetry?: (id: string) => void
  onDiscard?: (id: string) => void
}): JSX.Element {
  // Unconditional: `??` would short-circuit the hook away on the calls that
  // pass a name, and a hook that runs on some renders and not others is the
  // one thing React cannot survive.
  const threadName = useSpeakerName()
  const speaker = agentName ?? threadName
  switch (m.role) {
    case 'user': {
      const failed = status === 'failed'
      return (
        <Row side="right" fresh={fresh} ts={status ? undefined : m.ts}>
          <div className={cn('bubble-user px-3.5 py-2 max-w-[72%] text-md leading-[1.45] whitespace-pre-wrap break-words', status === 'sending' && 'opacity-70', status === 'queued' && 'bubble-queued', failed && 'bubble-failed')}>{m.text}</div>
          {failed ? (
            <div className="flex items-center gap-2.5 mt-1 px-1.5 text-xs select-none">
              <span className="text-down font-medium">{QUEUE_COPY.notSent}</span>
              <button type="button" className="text-accent font-medium hover:underline" onClick={() => onRetry?.(m.id)}>
                {QUEUE_COPY.retry}
              </button>
              <button type="button" className="text-muted hover:text-text transition-colors" onClick={() => onDiscard?.(m.id)}>
                {QUEUE_COPY.discard}
              </button>
            </div>
          ) : status === 'sending' ? (
            <span className="text-2xs text-muted mt-1 px-1.5 select-none">{QUEUE_COPY.sending}</span>
          ) : status === 'queued' ? (
            <span className="flex items-center gap-1 text-2xs text-muted mt-1 px-1.5 select-none nums" title="Sent while the agent was mid-run — it goes out the moment that run finishes">
              <Clock size={10} /> {QUEUE_COPY.caption} · {clockTime(m.ts)}
            </span>
          ) : null}
        </Row>
      )
    }
    case 'agent':
      if (m.report) {
        return (
          <Row side="left" fresh={fresh}>
            <ReportMemo
              report={m.report}
              prose={m.text && m.text !== reportFallbackText(m.report) ? m.text : undefined}
              ts={m.ts}
              notify={m.notify}
              agentName={speaker}
              tools={<ToolActivity calls={m.toolCalls ?? []} thinking={m.thinking} className="mt-3" />}
            />
          </Row>
        )
      }
      return (
        <Row side="left" fresh={fresh}>
          <TurnMemo m={m} ts={m.ts} agentName={speaker} />
        </Row>
      )
    case 'system':
      return <SystemNote kind={m.kind} text={m.text} ts={m.ts} fresh={fresh} notify={m.notify} />
    case 'action':
      return (
        <Row side="left" fresh={fresh} className="max-w-[82%]">
          <Receipt a={m.action} ts={m.ts} fresh={fresh} />
        </Row>
      )
    case 'plan':
      return (
        <Row side="left" fresh={fresh} className="max-w-[82%]">
          <PlanCard m={m} guardrails={guardrails} allocationUsd={allocationUsd} onApplyPlan={onApplyPlan} onDismissPlan={onDismissPlan} />
        </Row>
      )
    case 'question':
      return (
        <Row side="left" fresh={fresh} className="max-w-[82%]">
          <QuestionCard m={m} onAnswer={onAnswer} />
        </Row>
      )
    case 'approval':
      return (
        <Row side="left" fresh={fresh} className="max-w-[82%]">
          <ApprovalCard m={m} onAnswer={onAnswerApproval} quoteNow={quoteNow} />
        </Row>
      )
  }
})
