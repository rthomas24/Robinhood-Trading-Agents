import { redactSecrets } from '../../redact'
import { hasStructuralMarker, neutralizeStructuralMarkers } from '@shared/sanitize'
import type { ToolCallSummary } from '@shared/agents'
import type { AgentToolDef } from '../agentTools'
import type { RunDelta } from '@shared/ipc'
import type { ToolGate, VendorRunRequest, VendorRunResult } from './types'

/** The bits every vendor runner repeats: result bookkeeping, tool-call logging, the gate. */

export function short(v: unknown, n = 200): string {
  let s: string
  if (typeof v === 'string') s = v
  else {
    try {
      s = JSON.stringify(v)
    } catch {
      s = String(v)
    }
  }
  s = (s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * Everything an error actually says, once, capped — the text a TOOL FAILURE
 * hands back to the model.
 *
 * `(err as Error).message` alone is often the least informative line in the
 * chain. Node wraps a refused socket as `TypeError: fetch failed` and puts the
 * part worth knowing — `ECONNREFUSED 127.0.0.1:8905` — in `.cause`. A model
 * told only "fetch failed" cannot tell a dead MCP server from a bad URL from a
 * rate limit, so it retries the identical call; told the cause, it can pick a
 * different tool or say what broke.
 *
 * Breadth-first over `cause`, because the outermost wrapper is usually the
 * vaguest and the depth is not known in advance. Three bounds, each for a
 * failure we can actually hit:
 *
 *   - `seen` on the ERROR OBJECTS stops a cycle (`a.cause = b; b.cause = a`)
 *     from looping forever. An `AggregateError`'s children can legitimately
 *     share a cause, so this is not hypothetical.
 *   - a duplicate MESSAGE is dropped: a re-thrown-and-wrapped error repeats
 *     the same sentence at three depths, and paying for it three times teaches
 *     the model nothing.
 *   - each message and the whole string are capped, so one enormous upstream
 *     body cannot dominate the context window through the error path — the
 *     same reason tool OUTPUT is capped, on the path nobody thinks to cap.
 */
const ERROR_PART_MAX = 400
const ERROR_TOTAL_MAX = 1_200
const ERROR_MAX_DEPTH = 8


export function describeError(err: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  const queue: unknown[] = [err]
  while (queue.length > 0 && parts.length < ERROR_MAX_DEPTH) {
    const cur = queue.shift()
    if (cur === undefined || cur === null) continue
    // Objects only: two distinct errors may share a message, and de-duplicating
    // the STRING is the next step, not this one.
    if (typeof cur === 'object') {
      if (seen.has(cur)) continue
      seen.add(cur)
    }
    const msg = short(cur instanceof Error ? cur.message || cur.name : cur, ERROR_PART_MAX)
    if (msg && !parts.includes(msg)) parts.push(msg)
    if (cur instanceof Error) {
      if (cur.cause !== undefined) queue.push(cur.cause)
      // AggregateError (Promise.any, some fetch stacks) carries siblings, not a cause.
      const agg = (cur as { errors?: unknown[] }).errors
      if (Array.isArray(agg)) for (const e of agg) queue.push(e)
    }
  }
  // Redact BEFORE truncating, so a cut cannot leave half a key looking like
  // ordinary text and escape the pattern that would have caught it.
  const joined = redactSecrets(parts.join(' ← '))
  return joined.length > ERROR_TOTAL_MAX ? `${joined.slice(0, ERROR_TOTAL_MAX)}…` : joined || 'unknown error'
}

/**
 * A single tool result must not eat the context window.
 *
 * A `get_equity_quotes` across a 30-symbol watchlist, or an EDGAR filing
 * fetch, can dominate a run in one call. Two of our four vendors already
 * sliced at 24k chars — SILENTLY, which is the failure their notice exists to
 * prevent: a model that cannot tell it got a partial answer retries the
 * identical call, gets the identical truncation, and burns the run. The last
 * clause below is the part that took them two attempts to learn, so it is
 * quoted almost verbatim.
 *
 * BYTES, not characters. A context window is bought in tokens and a 3-byte
 * character costs three times a 1-byte one, so a character cap prices the
 * wrong thing — an all-CJK filing is three times the budget a character count
 * says it is.
 *
 * IDENTITY BELOW THE CAP. `capToolOutput` returns the value it was given,
 * untouched and unstringified, whenever it fits — so the only calls whose
 * shape changes are the ones already too big to send. That matters on the
 * vendors where tool output is a structured MCP result rather than a string:
 * stringifying every result to make truncation simpler would change what the
 * model sees on every call, to fix the rare one.
 */
export const MAX_TOOL_OUTPUT_BYTES = 24_000

export const TRUNCATION_NOTICE =
  '\n\n[Truncated: this result was larger than one tool call may return. The remainder was discarded; do not retry the same call expecting the full output — ask for less (fewer symbols, a shorter range, a narrower query).]'

/**
 * Everything a tool result must survive before the model reads it: forged
 * structural markers neutralised, then cut to a byte budget
 *.
 *
 * ONE function for both because they share every call site — this is the point
 * where untrusted text becomes model input, and splitting them means touching
 * four vendors twice and getting three of them right.
 *
 * THE DIRECT CHANNEL, and it is not the transcript. WebVector headlines, SEC
 * filings and fetched pages never become `messages` rows, so `transcriptBlock`
 * never renders them — within a run they arrive here, as tool results. The
 * laundered channel (the agent quoting a headline into its own reply, which
 * persists and renders next run) is closed separately in `prompts.ts`. Neither
 * half marks the other done.
 *
 * Robinhood too, not just WebVector: `get_watchlists`, `get_scans` and
 * `search` already carry free text. Operator-controlled rather than
 * attacker-controlled, so lower severity — identical shape.
 *
 * Sanitise BEFORE truncating, so the cut cannot itself manufacture a marker by
 * removing the text that made a line benign; and before appending the notice,
 * which is ours and says nothing structural.
 */
export function capText(text: string, max = MAX_TOOL_OUTPUT_BYTES): string {
  text = neutralizeStructuralMarkers(text)
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= max) return text
  // UTF-8 continuation bytes are 10xxxxxx. Walk back to the start of the
  // character we landed inside, or the decoder emits U+FFFD and the model is
  // handed a corrupted last word.
  let end = max
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--
  return new TextDecoder().decode(bytes.subarray(0, end)) + TRUNCATION_NOTICE
}

/**
 * Shape-preserving cap. A string caps to a string; an MCP `{ content: [...] }`
 * result keeps its envelope and caps the text inside it; anything else is
 * measured as JSON and only replaced if it is genuinely oversized.
 */
export function capToolOutput(output: unknown, max = MAX_TOOL_OUTPUT_BYTES): unknown {
  if (typeof output === 'string') return capText(output, max)
  if (output && typeof output === 'object') {
    const content = (output as { content?: unknown }).content
    if (Array.isArray(content)) {
      let budget = max
      let cut = false
      const parts = content.map((c) => {
        const text = (c as { text?: unknown })?.text
        if (typeof text !== 'string') return c
        const capped = capText(text, Math.max(0, budget))
        budget -= new TextEncoder().encode(text).length
        if (capped !== text) cut = true
        return { ...(c as object), text: capped }
      })
      return cut ? { ...(output as object), content: parts } : output
    }
  }
  let json: string
  try {
    json = JSON.stringify(output) ?? ''
  } catch {
    return output
  }
  // A structured result the model still reads as text. Identity is preserved
  // for the overwhelming majority — a quote object has no reason to contain
  // `SYSTEM:` at a line start — and only a result that is oversized OR
  // genuinely carries a marker is flattened. `hasStructuralMarker` exists so
  // this can be asked cheaply instead of transforming every object to defend
  // against the rare one.
  if (new TextEncoder().encode(json).length <= max && !hasStructuralMarker(json)) return output
  return capText(json, max)
}

export function emptyResult(sessionId: string | null = null): VendorRunResult {
  return { texts: [], thinking: [], toolCalls: [], inputTokens: 0, outputTokens: 0, contextTokens: 0, sessionId, stoppedBecause: 'natural' }
}

/* ── Full tool detail on the thread (ToolCallSummary.args / .result) ──────── */

/** Per-call caps for the detail kept on the message. */
export const TOOL_ARGS_MAX_BYTES = 6_000
export const TOOL_RESULT_MAX_BYTES = 12_000
/**
 * Per-RUN budget for that detail. Every message is written to the agent's JSON
 * store and sent to the UI, so a run that quoted forty symbols one call at a
 * time must not become a half-megabyte message. Past the budget a call keeps only its short `output` and is marked
 * `truncated`; the model's own copy (`capToolOutput`) is unaffected.
 */
export const TOOL_DETAIL_BUDGET_BYTES = 96_000

const encoder = new TextEncoder()
export const byteLength = (s: string): number => encoder.encode(s).length

/** Cut to a byte budget on a character boundary. `cut` says whether anything was lost. */
export function truncateBytes(text: string, max: number): { text: string; cut: boolean } {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return { text, cut: false }
  let end = Math.max(0, max)
  // UTF-8 continuation bytes are 10xxxxxx: walk back to the character's start.
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), cut: true }
}

/**
 * The text a tool result IS, whatever envelope it arrived in: a string as is,
 * an MCP `{ content: [...] }` as its text parts joined, anything else as compact
 * JSON (the view pretty-prints; compact keeps the row small).
 */
export function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const content = (output as { content?: unknown }).content
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          const item = c as { type?: string; text?: unknown }
          if (typeof item.text === 'string') return item.text
          return item.type ? `[${item.type}]` : ''
        })
        .filter(Boolean)
        .join('\n')
    }
  }
  try {
    return JSON.stringify(output) ?? String(output)
  } catch {
    return String(output)
  }
}

/** An error result, by the shapes our tools and MCP servers use. */
function isErrorOutput(output: unknown, text: string): boolean {
  if (output && typeof output === 'object' && (output as { isError?: unknown }).isError === true) return true
  return /^(ERROR:|Error:|Invalid arguments for |Unknown tool )/.test(text.trimStart())
}

/** `args` as stored: the object itself when it fits, else its JSON cut to size. */
function capArgs(input: unknown): { args: unknown; cut: boolean } {
  if (input === undefined) return { args: undefined, cut: false }
  let json: string
  try {
    json = JSON.stringify(input) ?? ''
  } catch {
    return { args: String(input), cut: false }
  }
  if (byteLength(json) <= TOOL_ARGS_MAX_BYTES) return { args: input, cut: false }
  return { args: truncateBytes(json, TOOL_ARGS_MAX_BYTES).text, cut: true }
}

/** A tool call started: remember it (with its full arguments) and stream it to the thread. */
export function noteToolCall(out: VendorRunResult, emit: (d: RunDelta) => void, name: string, input: unknown): ToolCallSummary {
  const summary = short(input, 200)
  const { args, cut } = capArgs(input)
  const entry: ToolCallSummary = { name, input: summary, startedAt: new Date().toISOString(), ...(args !== undefined ? { args } : {}), ...(cut ? { truncated: true } : {}) }
  out.toolCalls.push(entry)
  emit({ kind: 'tool', name, input: summary })
  return entry
}

/**
 * A tool call finished: attach the output to its (latest unresolved) entry and
 * stream it. The short `output` is what streams and what older clients read;
 * the full text lands in `result`, redacted and within the run's byte budget.
 */
export function noteToolResult(out: VendorRunResult, emit: (d: RunDelta) => void, name: string, output: unknown, opts: { blocked?: string } = {}): string {
  const text = short(output, 300)
  const last = [...out.toolCalls].reverse().find((t) => t.name === name && t.output === undefined)
  // No open entry: the call was already settled — a refusal recorded by
  // `noteToolBlocked`, then the tool loop's own note of the same message.
  // Saying it twice would stream a second tool_result for one call.
  if (!last) return text
  emit({ kind: 'tool_result', name, output: text })
  last.output = text
  if (last.startedAt) last.durationMs = Math.max(0, Date.now() - Date.parse(last.startedAt))
  if (opts.blocked) last.blocked = opts.blocked
  const full = redactSecrets(resultText(output))
  if (!opts.blocked && isErrorOutput(output, full)) last.error = true
  const spent = out.toolDetailBytes ?? 0
  const room = Math.min(TOOL_RESULT_MAX_BYTES, TOOL_DETAIL_BUDGET_BYTES - spent)
  if (room > 0) {
    const cut = truncateBytes(full, room)
    last.result = cut.text
    if (cut.cut) last.truncated = true
    out.toolDetailBytes = spent + byteLength(cut.text)
  } else last.truncated = true
  return text
}

/**
 * The gate refused a call. Recorded where its result would be, so the thread
 * shows "asked for X — held back by the daily order cap" instead of a call that
 * seems to have vanished (OpenRouter and Claude never ran it, so nothing else
 * would have written a row). Notes the call first when the vendor has not.
 */
export function noteToolBlocked(out: VendorRunResult, emit: (d: RunDelta) => void, name: string, input: unknown, message: string): void {
  if (!out.toolCalls.some((t) => t.name === name && t.output === undefined)) noteToolCall(out, emit, name, input)
  noteToolResult(out, emit, name, message, { blocked: message })
}

export type GateVerdict = { ok: true; input: Record<string, unknown> } | { ok: false; message: string }

/**
 * May this tool be OFFERED to the model? Used when building the tool list.
 *
 * Deliberately not `gate.allow`: that records a refusal in the decision log, and
 * omitting a tool from the list is not a refusal — nothing was called. Falls
 * back to `allow` for a gate that predates `permits`, which costs the old noisy
 * behaviour rather than accidentally offering a tool that should be hidden.
 */
/**
 * Run one tool call: gate it, validate it, dispatch it, audit it.
 *
 * This was byte-identical in `chatgpt.ts` and `local.ts` — the two vendors
 * whose tool loop we own rather than delegate to an SDK. Two copies of the
 * function that enforces the gate, validates arguments and records the
 * decision is how one of them quietly stops doing one of those things; the
 * whole reason `vendors/shared.ts` exists is that a rule implemented twice
 * diverges, and this is the most consequential rule in the file.
 *
 * Returns a STRING in every case, including refusals and bad arguments. Those
 * are answers to the model, not exceptions: it can read "Invalid arguments for
 * trade: qty: expected number" and correct itself, where a throw would cost
 * the call and teach it nothing.
 */
export function makeRunTool(
  req: Pick<VendorRunRequest, 'gate' | 'log' | 'host'>,
  ours: Map<string, AgentToolDef>,
  remoteTools: Map<string, { client: { call(tool: string, input: unknown): Promise<string> }; tool: string }>,
  /** The gate refused the call; the thread records the verdict (see `noteToolBlocked`). */
  onBlocked?: (name: string, args: Record<string, unknown>, message: string) => void
): (name: string, args: Record<string, unknown>) => Promise<string> {
  return async (name, args) => {
    const v = await gateToolCall(req.gate, name, args)
    if (!v.ok) {
      onBlocked?.(name, args, v.message)
      return v.message
    }
    let output: string
    const mine = ours.get(name)
    if (mine) {
      const parsed = mine.schema.safeParse(v.input)
      if (!parsed.success) return `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
      output = await mine.run(parsed.data, req.host)
    } else {
      const remote = remoteTools.get(name)
      if (!remote) return `Unknown tool "${name}".`
      output = await remote.client.call(remote.tool, v.input)
    }
    await afterToolCall(req.gate, req.log, name, v.input, output)
    return output
  }
}

export const offered = (gate: ToolGate, name: string): boolean => (gate.permits ? gate.permits(name) : gate.allow(name))

/** allow() + vet() in one step; vendors only differ in how they act on the verdict. */
export async function gateToolCall(gate: ToolGate, name: string, input: Record<string, unknown>): Promise<GateVerdict> {
  if (!gate.allow(name)) return { ok: false, message: `Tool "${name}" is not available to this agent.` }
  if (!gate.vet) return { ok: true, input }
  const v = await gate.vet(name, input)
  if (!v.ok) return { ok: false, message: v.message }
  return { ok: true, input: v.input ?? input }
}

/** Bookkeeping after a tool ran; never lets a bookkeeping bug kill the run. */
export async function afterToolCall(gate: ToolGate, log: (level: 'warn', msg: string) => void, name: string, input: Record<string, unknown>, output: unknown): Promise<void> {
  try {
    await gate.afterTool?.(name, input, output)
  } catch (err) {
    log('warn', `tool bookkeeping failed: ${(err as Error).message}`)
  }
}
