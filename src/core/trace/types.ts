import type { AgentConfig, RunTrigger, ToolCallSummary } from '@shared/agents'
import type { DecisionRecord } from '@shared/decisions'

/**
 * Run tracing — the seam between the runner and an observability backend.
 *
 * `runOnce` describes a run as it happens: the prompts it composed, each
 * attempt at the model, every model step inside an attempt (the messages that
 * went in, the text / reasoning / tool calls that came out, the tokens), every
 * tool call with its full arguments and result, every guardrail decision, the
 * events between (retries, stalls, exits fired, approvals held) and how the
 * run ended. A host plugs in a `TraceSink` that turns that into whatever its
 * backend understands (LangSmith, OpenTelemetry, a local JSONL file…). The
 * desktop app passes none by default, so nothing leaves the machine.
 *
 * Vendor-neutral on purpose: the tool-call detail comes from the SAME
 * `ToolCallSummary` list every vendor already fills (`vendors/shared.ts`), and
 * a vendor that can see its model steps reports them through
 * `VendorRunRequest.onModelStep`. A vendor that cannot still produces a
 * complete trace minus the per-step messages.
 *
 * Nothing here may throw into the run. A sink that fails logs and stays
 * silent — the run it is describing is real money, and a tracing outage must
 * cost visibility, never a trade.
 */

/** A message as the model saw or produced it, in a chat-shaped form most tracing backends render. */
export interface TraceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'reasoning'
  content: string
  /** Assistant messages: the calls the model made in this step. */
  toolCalls?: Array<{ id: string; name: string; args: unknown }>
  /** Tool messages: which call this answers. */
  toolCallId?: string
  /** Tool messages: the tool's name, for the reader. */
  name?: string
}

export interface ModelStepUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
  costUsd?: number
}

/** One call to the model inside an attempt: what went in, what came out, what it cost. */
export interface ModelStep {
  /** 1-based, within the attempt. */
  index: number
  /** The model that answered (a fallback may differ from the one asked for). */
  model: string
  provider: string
  /** Everything the model was given for this step — the transcript so far. */
  input: TraceMessage[]
  /** What it produced: reasoning, text, tool calls. */
  output: TraceMessage[]
  usage?: ModelStepUsage
  startedAt: string
  endedAt: string
  /** The provider's id for this generation, when it has one. */
  responseId?: string
  /** The vendor's own label for the turn (`initial`, `tool_round`, `final`…). */
  turnType?: string
}

export interface TraceStart {
  runId: string
  agentId: string
  agentName: string
  trigger: RunTrigger
  userText?: string
  mode: AgentConfig['mode']
  vendor: string
  model: string
  effort?: string
  autonomous: boolean
  liveArmed: boolean
  schedule: string
  build?: string
  startedAt: string
}

export interface TracePrompts {
  systemPrompt: string
  prompt: string
  /** Named context blocks and their size — the prompt's anatomy, for "what did it cost to say that". */
  blocks?: Array<{ name: string; chars: number }>
  /** Tool names offered to the model this run. */
  tools: string[]
  /** Which session it resumed (Claude), when any. */
  resumeSessionId?: string | null
}

export interface TraceEnd {
  ok: boolean
  error?: string
  stopReason?: string
  skipped?: boolean
  skipReason?: string
  /** The model's final reply, and the reasoning it produced along the way. */
  texts?: string[]
  thinking?: string[]
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  contextTokens?: number
  costUsd?: number
  toolCalls?: number
  /** Orders that went somewhere (filled, resting, or handed to the broker). */
  actions?: number
  /** The book as the run leaves it — cash, positions, realized (`RunBookSummary`). */
  book?: unknown
  nextRunAt?: string | null
  attempts?: number
  durationMs: number
}

export interface AttemptEnd {
  error?: string
  stalled?: boolean
  degenerate?: string
  stoppedBecause?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  costUsd?: number
  modelUsed?: string
}

/** One attempt at the model (a transient failure is retried as a NEW attempt). */
export interface AttemptTrace {
  /** A model step, as it completes — from the vendor's own view of the loop. */
  modelStep(step: ModelStep): void
  /**
   * Every tool call of the attempt, with full args and results, as the vendor
   * recorded them (`ToolCallSummary` carries `startedAt`/`durationMs`, so the
   * spans keep their real timing even though they are reported at the end).
   */
  toolCalls(calls: ToolCallSummary[]): void
  end(o: AttemptEnd): void
}

export interface RunTrace {
  /** The backend's id for this trace — stored on the RunRecord (`traceId`) so the row joins to it. */
  readonly id: string
  /** The prompts, once composed — the skip path never reaches this. */
  prompts(p: TracePrompts): void
  attempt(n: number): AttemptTrace
  /** A guardrail / policy decision (allowed or blocked), as it is recorded. */
  decision(rec: DecisionRecord): void
  /** Something that happened between the model's steps: a retry, an exit fired, a watch hit, an approval held. */
  event(name: string, data?: Record<string, unknown>): void
  /**
   * The run is settled. Resolves once the trace has been handed to the
   * backend; the host decides whether to wait for that.
   */
  end(o: TraceEnd): Promise<void>
}

/** An outcome attributed to earlier runs — a sell's realized P&L on the runs that opened the position. */
export interface TraceOutcome {
  /** The runs that made the decision being scored — our run ids, not the backend's. */
  runIds: string[]
  /** Feedback key, e.g. `realized_pnl_usd`. */
  key: string
  score: number
  comment?: string
}

export interface TraceSink {
  start(info: TraceStart): RunTrace
  /** Score earlier runs by what their decisions turned out to be worth. Fire-and-forget. */
  outcome(o: TraceOutcome): void
}
