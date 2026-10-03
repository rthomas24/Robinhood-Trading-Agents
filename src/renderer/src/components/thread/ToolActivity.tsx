import type { JSX, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { ArrowLeftRight, Bell, BookMarked, Brain, CalendarClock, Check, ChevronDown, ChevronRight, ClipboardList, Code2, Copy, Globe, Inbox, LineChart, Loader2, MessageCircle, ShieldCheck, TriangleAlert, Wallet, Wrench, XCircle } from 'lucide-react'
import type { ToolCallSummary } from '@shared/agents'
import { Markdown } from '@renderer/components/common/Markdown'
import { EmptyState, TickerChip } from '@renderer/components/common/Primitives'
import { cn } from '@renderer/lib/format'
import {
  activitySummary,
  callVerdict,
  demandsAttention,
  describeToolCall,
  formatDuration,
  formatScalar,
  humanizeKey,
  isScalar,
  KIND_LABEL,
  parseToolResult,
  prettyJson,
  quoteView,
  serverLabel,
  splitToolName,
  tabularRows,
  toolKind,
  type CallStatus,
  type QuoteView,
  type ToolKind
} from '@renderer/lib/toolDisplay'

/**
 * What an agent DID during a run, in full.
 *
 * The thread used to show `get_equity_quotes({"symbols":["NVDA"…` cut at 200
 * characters behind a "1 tool call" toggle — enough to know a tool was used,
 * never enough to know what it saw. This is the whole record: a ruled list where
 * every call is one row that says what it did in words (Quotes · NVDA, MU),
 * carries its verdict (ran, refused by the gate with the rule, failed) and its
 * duration, and opens to the complete input and result — a table when the result
 * is a list, chips when it is prices, a key/value card when it is an object,
 * prose when it is prose, and the raw text one click away.
 *
 * The rows that open THEMSELVES are the ones that demand attention: a refusal
 * and a failure are the only things here an operator must not have to go looking
 * for. Everything that simply worked stays folded, because a run that went to
 * plan should read as one quiet line per step.
 */

const KIND_ICON: Record<ToolKind, JSX.Element> = {
  trade: <ArrowLeftRight size={12} />,
  market: <LineChart size={12} />,
  account: <Wallet size={12} />,
  research: <Globe size={12} />,
  memory: <BookMarked size={12} />,
  plan: <CalendarClock size={12} />,
  exit: <ShieldCheck size={12} />,
  watch: <Bell size={12} />,
  talk: <MessageCircle size={12} />,
  report: <ClipboardList size={12} />,
  other: <Wrench size={12} />
}

/**
 * The category badge repeats what its icon already says, so it is DECORATION —
 * and rule 2 does not let decoration spend the meaning colours. Market was
 * green, exit red and account brass, which is money, loss and real money worn
 * by a glyph that means none of them. The category is drawn on the neutral
 * ladder instead and separated by ink weight: the kinds that put an instruction
 * on the book read at full strength, the ones that only look things up are
 * muted. The only colour in a step row is its VERDICT.
 */
const KIND_BADGE: Record<ToolKind, string> = {
  trade: 'bg-surface-3 text-text',
  exit: 'bg-surface-3 text-text',
  watch: 'bg-surface-3 text-text',
  talk: 'bg-surface-3 text-text',
  plan: 'bg-surface-3 text-text',
  market: 'bg-surface-3 text-muted',
  account: 'bg-surface-3 text-muted',
  research: 'bg-surface-3 text-muted',
  memory: 'bg-surface-3 text-muted',
  report: 'bg-surface-3 text-muted',
  other: 'bg-surface-3 text-muted'
}

/**
 * Refused and failed are the two states the chrome is allowed to colour.
 *
 * `.pill-down` is drawn from the P&L tints, and calm mode drains those to
 * transparent — which is right for a figure and wrong for a failure: the chip
 * vanished and a failed step read like any other line. So a failure keeps its
 * chip from the surface ladder and a ring, and only its INK comes from the
 * money colour. Calm mode drains the colour; it never drains the signal.
 */
const FAIL_PILL = 'bg-surface-3 text-down ring-1 ring-down/45'

const STATUS_PILL: Record<CallStatus, string> = {
  ok: '',
  blocked: 'pill-warn',
  error: FAIL_PILL,
  pending: ''
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="tool-copy"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true)
            window.setTimeout(() => setDone(false), 1200)
          })
          .catch(() => undefined)
      }}
    >
      {done ? <Check size={11} /> : <Copy size={11} />} {done ? 'Copied' : label}
    </button>
  )
}

function JsonBlock({ value }: { value: unknown }): JSX.Element {
  return <pre className="tool-pre">{prettyJson(value)}</pre>
}

function JsonInline({ value }: { value: unknown }): JSX.Element {
  const s = prettyJson(value, 400).replace(/\s+/g, ' ')
  return (
    <code className="mono text-2xs text-muted" title={s}>
      {s.length > 60 ? `${s.slice(0, 59)}…` : s}
    </code>
  )
}

const numeric = (v: unknown): boolean => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))

function DataTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }): JSX.Element {
  const cols = columns.slice(0, 10)
  const more = columns.length - cols.length
  const shown = rows.slice(0, 200)
  return (
    <div className="overflow-x-auto rounded-md bg-surface ring-1 ring-hairline">
      <table className="tool-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className={cn(numeric(rows[0]?.[c]) && 'text-right')}>
                {humanizeKey(c)}
              </th>
            ))}
            {more > 0 && <th>+{more} more</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const v = r[c]
                return (
                  <td key={c} className={cn(numeric(v) && 'nums text-right')}>
                    {isScalar(v) ? formatScalar(v) : <JsonInline value={v} />}
                  </td>
                )
              })}
              {more > 0 && <td className="text-muted">…</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <div className="px-2 py-1 text-2xs text-muted">{rows.length - shown.length} more rows — Raw shows everything</div>}
    </div>
  )
}

/** Structured data as the operator would draw it: tables for lists, key/value for objects, chips for scalar lists. */
function DataView({ value, depth = 0 }: { value: unknown; depth?: number }): JSX.Element {
  if (isScalar(value)) return <span className={cn('break-words', typeof value !== 'string' && 'nums')}>{formatScalar(value)}</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted">empty list</span>
    const table = depth < 2 ? tabularRows(value) : null
    if (table) return <DataTable columns={table.columns} rows={table.rows} />
    if (value.every(isScalar)) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.slice(0, 120).map((v, i) => (
            <span key={i} className="pill h-5 font-medium text-text">
              {formatScalar(v)}
            </span>
          ))}
          {value.length > 120 && <span className="pill h-5">+{value.length - 120}</span>}
        </div>
      )
    }
    if (depth >= 2) return <JsonBlock value={value} />
    return (
      <div className="flex flex-col gap-1.5">
        {value.slice(0, 50).map((v, i) => (
          <div key={i} className="tool-nested">
            <div className="mb-0.5 text-2xs text-text-3 nums">#{i + 1}</div>
            <DataView value={v} depth={depth + 1} />
          </div>
        ))}
        {value.length > 50 && <div className="text-2xs text-muted">{value.length - 50} more — Raw shows everything</div>}
      </div>
    )
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <span className="text-muted">empty</span>
    if (depth >= 2) return <JsonBlock value={value} />
    return (
      <div className="tool-kv">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <div className="tool-kv-key" title={k}>
              {humanizeKey(k)}
            </div>
            <div className="tool-kv-val">{isScalar(v) ? <span className={cn(typeof v !== 'string' && 'nums')}>{formatScalar(v)}</span> : <DataView value={v} depth={depth + 1} />}</div>
          </div>
        ))}
      </div>
    )
  }
  return <span className="text-muted">—</span>
}

const looksLikeMarkdown = (t: string): boolean => /(^|\n)\s{0,3}(#{1,6}\s|[-*]\s|\d+\.\s|\|.*\|)|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\//.test(t)

function TextView({ text }: { text: string }): JSX.Element {
  if (looksLikeMarkdown(text)) return <Markdown text={text} className="text-sm" />
  return <pre className="tool-pre">{text}</pre>
}

/** One labelled pane — Input, Result, Reasoning — with Raw and Copy. */
function Pane({ title, raw, extra, children }: { title: string; raw: string; extra?: ReactNode; children: ReactNode }): JSX.Element {
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-2">
        <span className="eyebrow">{title}</span>
        {extra}
        <span className="flex-1" />
        <button type="button" className={cn('tool-copy', showRaw && 'bg-surface-3 text-text')} onClick={() => setShowRaw((v) => !v)} aria-pressed={showRaw} title="Exactly what was sent or received">
          <Code2 size={11} /> Raw
        </button>
        <CopyButton text={raw} />
      </div>
      <div className="tool-pane">{showRaw ? <pre className="tool-pre">{raw}</pre> : children}</div>
    </div>
  )
}

/**
 * A price list reads as chips, not as a grid — the same chip the rest of the
 * app uses. Everything the engine printed BESIDE the last trade (the bid, the
 * ask, the previous close, the "vs prev close" wording, the currency) stays
 * visible text next to its chip: a spread decides whether a fill lands where
 * the model thinks it will, and a figure only a hover reveals is one this app
 * never actually stated.
 */
function QuoteStrip({ view }: { view: QuoteView }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {view.caption &&
        (view.captionStale ? (
          /* Not a caption: a warning that every number below it is a last trade
             and not a live price. It gets the weight that claim deserves. */
          <div className="flex items-start gap-1.5 text-sm text-warn">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span>{view.caption}</span>
          </div>
        ) : (
          <div className="text-xs text-muted">{view.caption}</div>
        ))}
      <div className="flex flex-col gap-1">
        {/* Keyed by index as well as symbol: a payload may quote one symbol
            twice, and a symbol key would drop the second chip silently. */}
        {view.chips.map((q, i) => (
          <div key={`${i}-${q.symbol}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <TickerChip symbol={q.symbol} price={q.price} changePct={q.changePct} />
            {q.detail && <span className="text-xs text-muted nums">{q.detail}</span>}
          </div>
        ))}
      </div>
      {view.rest.map((line, i) => (
        <div key={i} className="text-sm text-muted">
          {line}
        </div>
      ))}
    </div>
  )
}

/** What the agent was given back — or the sentence it was given instead. */
function ResultBody({ call }: { call: ToolCallSummary }): JSX.Element {
  const verdict = callVerdict(call)
  const text = call.result ?? call.output ?? ''
  const parsed = useMemo(() => parseToolResult(text), [text])
  const quotes = useMemo(() => (verdict.status === 'ok' ? quoteView(parsed, call.name) : null), [parsed, verdict.status, call.name])
  if (verdict.status === 'blocked' && verdict.sentence) {
    // A refusal must LOOK like a refusal: the gate's own glyph, the rule key it
    // was refused under, and the sentence in the warn colour. This is the one
    // thing in a step list an operator must never mistake for a result.
    return (
      <div className="flex items-start gap-2 text-warn">
        <XCircle size={14} className="mt-0.5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          {verdict.rule && <span className="mono text-2xs">{verdict.rule}</span>}
          {/* The refusal verbatim: this is the sentence the model was given, and the operator is owed the same one. */}
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{verdict.sentence}</p>
        </div>
      </div>
    )
  }
  if (!text) return <EmptyState icon={<Inbox size={18} />} title="No result was recorded." body="The call was streamed without one — Raw shows what the thread kept." className="px-2 py-5" />
  if (quotes) return <QuoteStrip view={quotes} />
  if (parsed.kind === 'json') return <DataView value={parsed.value} />
  return <TextView text={parsed.text} />
}

function CallDetail({ call }: { call: ToolCallSummary }): JSX.Element {
  // A row written before full detail was kept has only the abridged strings.
  const legacy = call.args === undefined && call.result === undefined && !call.blocked
  const argsRaw = useMemo(() => (call.args === undefined ? call.input : typeof call.args === 'string' ? call.args : prettyJson(call.args)), [call])
  const resultText = call.result ?? call.output ?? ''
  const verdict = callVerdict(call)
  const { server, tool } = splitToolName(call.name)
  const wire = (
    <div className="flex items-center gap-1.5 text-2xs text-muted">
      <span>{serverLabel(server)}</span>
      <span className="text-text-3">·</span>
      <span className="mono">{tool}</span>
    </div>
  )
  if (legacy) {
    return (
      <div className="tool-detail">
        {wire}
        <div className="text-xs text-muted">Recorded before full detail was kept — abridged to what the thread had.</div>
        <pre className="tool-pre">{call.input}</pre>
        {call.output && <pre className="tool-pre opacity-80">→ {call.output}</pre>}
      </div>
    )
  }
  return (
    <div className="tool-detail">
      {wire}
      <Pane title="Input" raw={argsRaw} extra={call.truncated && call.result === undefined ? <span className="pill">cut to size</span> : undefined}>
        {call.args === undefined ? <pre className="tool-pre">{call.input || '(no arguments)'}</pre> : typeof call.args === 'string' ? <TextView text={call.args} /> : <DataView value={call.args} />}
      </Pane>
      <Pane
        title={verdict.status === 'blocked' ? 'Held back' : verdict.status === 'error' ? 'Error' : 'Result'}
        raw={resultText}
        extra={call.truncated && call.result !== undefined ? <span className="pill">cut to size</span> : undefined}
      >
        <ResultBody call={call} />
      </Pane>
    </div>
  )
}

function ToolRow({ call, index }: { call: ToolCallSummary; index: number }): JSX.Element {
  // Refusals and failures open themselves; a step that simply worked stays a line.
  const [open, setOpen] = useState(() => demandsAttention(call))
  const kind = toolKind(call.name)
  const { server, tool } = splitToolName(call.name)
  const d = describeToolCall(call)
  const dur = formatDuration(call.durationMs)
  const verdict = callVerdict(call)
  const blocked = verdict.status === 'blocked'
  const secondary = blocked ? verdict.sentence : d.detail
  return (
    <div className={cn('tool-row', open && 'open')}>
      <button type="button" className="tool-row-head min-h-8" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="w-4 shrink-0 text-right text-2xs text-text-3 nums">{index + 1}</span>
        {/* A refusal takes the badge slot: the category is what the call WOULD
            have been, and the operator needs the row that never happened to be
            unmistakable at a glance. */}
        <span className={cn('tool-kind', blocked ? 'bg-warn/12 text-warn' : KIND_BADGE[kind])} title={blocked ? verdict.label : KIND_LABEL[kind]} aria-hidden>
          {blocked ? <XCircle size={12} /> : KIND_ICON[kind]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-sm font-medium">{d.title}</span>
            {/* Which service answered is part of the audit trail, so it is text
                on the row and not a tooltip. */}
            <span className="truncate text-2xs text-muted" title={`${serverLabel(server)} · ${tool}`}>
              {serverLabel(server)} · <span className="mono">{tool}</span>
            </span>
          </span>
          {secondary && (
            <span className={cn('block truncate text-xs', blocked ? 'text-warn' : 'text-muted')} title={secondary}>
              {secondary}
            </span>
          )}
        </span>
        {verdict.rule && <span className={cn('mono shrink-0 text-2xs', blocked ? 'text-warn' : 'text-muted')}>{verdict.rule}</span>}
        {verdict.status !== 'ok' && <span className={cn('pill shrink-0', STATUS_PILL[verdict.status])}>{verdict.label}</span>}
        {dur && <span className="w-12 shrink-0 text-right text-2xs text-muted nums">{dur}</span>}
        <span className="shrink-0 text-muted">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
      </button>
      {open && <CallDetail call={call} />}
    </div>
  )
}

export function ToolActivity({ calls, thinking, defaultOpen = false, className }: { calls: ToolCallSummary[]; thinking?: string; defaultOpen?: boolean; className?: string }): JSX.Element | null {
  const s = useMemo(() => activitySummary(calls), [calls])
  // A run with something to answer for is not hidden behind a toggle.
  const [open, setOpen] = useState(() => defaultOpen || calls.some(demandsAttention))
  const [showThinking, setShowThinking] = useState(false)
  if (!calls.length && !thinking) return null
  const dur = formatDuration(s.durationMs ?? undefined)
  return (
    <div className={cn('tool-activity', open && 'open', className)}>
      <button type="button" className="tool-activity-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="text-muted">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="font-medium">{calls.length ? `${calls.length} step${calls.length === 1 ? '' : 's'}` : 'Reasoning'}</span>
        {dur && <span className="text-xs text-muted nums">· {dur}</span>}
        {s.blocked > 0 && <span className="pill pill-warn">{s.blocked} held back</span>}
        {s.failed > 0 && <span className={cn('pill', FAIL_PILL)}>{s.failed} failed</span>}
        {thinking && calls.length > 0 && (
          <span className="pill">
            <Brain size={10} /> reasoning
          </span>
        )}
        <span className="flex-1" />
        {!open && (
          <span className="flex items-center gap-1">
            {s.kinds.slice(0, 6).map((k) => (
              <span key={k} className={cn('tool-kind', KIND_BADGE[k])} title={KIND_LABEL[k]}>
                {KIND_ICON[k]}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="tool-activity-body">
          {thinking && (
            <div className="tool-row">
              <button type="button" className="tool-row-head min-h-8" onClick={() => setShowThinking((v) => !v)} aria-expanded={showThinking}>
                <span className="w-4 shrink-0" />
                <span className="tool-kind bg-surface-3 text-muted" aria-hidden>
                  <Brain size={12} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">Reasoning</span>
                <span className="text-2xs text-muted nums">{thinking.length.toLocaleString()} chars</span>
                <span className="shrink-0 text-muted">{showThinking ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
              </button>
              {showThinking && (
                <div className="tool-detail">
                  <Pane title="Reasoning" raw={thinking}>
                    <div className="whitespace-pre-wrap text-sm italic leading-relaxed">{thinking}</div>
                  </Pane>
                </div>
              )}
            </div>
          )}
          {calls.map((c, i) => (
            <ToolRow key={i} call={c} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The live bubble's version: every tool the running agent has called so far, ticked as results land. */
export function LiveSteps({ steps }: { steps: { name: string; done: boolean }[] }): JSX.Element | null {
  if (!steps.length) return null
  const shown = steps.slice(-6)
  const hidden = steps.length - shown.length
  return (
    <div className="mt-2 flex flex-col gap-1">
      {hidden > 0 && (
        <div className="text-2xs text-muted">
          {hidden} earlier step{hidden === 1 ? '' : 's'}
        </div>
      )}
      {shown.map((s, i) => {
        const kind = toolKind(s.name)
        const d = describeToolCall({ name: s.name, input: '' })
        return (
          <div key={`${s.name}-${i}`} className="flex items-center gap-1.5 text-xs">
            <span className={cn('tool-kind', KIND_BADGE[kind])} title={KIND_LABEL[kind]} aria-hidden>
              {KIND_ICON[kind]}
            </span>
            <span className={cn('truncate', s.done ? 'text-muted' : 'text-text')}>{d.title}</span>
            <span className="truncate text-2xs text-text-3">{serverLabel(splitToolName(s.name).server)}</span>
            {s.done ? <Check size={11} className="ml-auto shrink-0 text-up" aria-label="done" /> : <Loader2 size={11} className="ml-auto shrink-0 animate-spin text-muted" aria-label="running" />}
          </div>
        )
      })}
    </div>
  )
}
