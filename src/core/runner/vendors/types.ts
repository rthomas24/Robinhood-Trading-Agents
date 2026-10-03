import type { ModelChoice, ModelVendor, ToolCallSummary } from '@shared/agents'
import type { RunDelta } from '@shared/ipc'
import type { McpServerSpec } from '../../intel/servers'
import type { AgentToolDef, ToolHost } from '../agentTools'
import type { ModelStep } from '../../trace/types'

/**
 * The vendor seam. `runOnce` builds ONE request (prompts, tools, remote MCP
 * servers, the tool gate) and hands it to whichever `ModelVendorRunner` the
 * agent's `model.vendor` selects. Vendors differ only in how they talk to a
 * model; everything trading-related stays in the host tools and the gate.
 */
export interface ToolGate {
  /**
   * Deny-by-default: may the model call this (full `mcp__server__tool`) name?
   *
   * This is for an ACTUAL CALL, and a refusal is recorded in the decision log.
   * To decide what to put in the tool list, use `permits` — see why there.
   */
  allow(name: string): boolean
  /**
   * The same question, asked while BUILDING the tool list. No audit.
   *
   * Every vendor filters its tool list through the gate, and when that used
   * `allow()` each omission was written to the decision log as a blocked call.
   * The result: eight rows per run — every Robinhood write tool, same second,
   * empty detail — for calls the model never made. 152 of 175 decisions on one
   * account were this, drowning the 16 real ones, and the operator reasonably
   * read it as their agent repeatedly trying to do forbidden things.
   *
   * A tool that is not offered was never refused. Only a call can be refused.
   */
  permits?(name: string): boolean
  /** Extra per-call vetting (e.g. direct Robinhood orders against guardrails). */
  vet?(name: string, input: Record<string, unknown>): Promise<{ ok: true; input?: Record<string, unknown> } | { ok: false; message: string }>
  /** Bookkeeping after a tool ran (e.g. record a directly placed order). */
  afterTool?(name: string, input: Record<string, unknown>, output: unknown): Promise<void>
}

/** A remote MCP server the model may use; tools surface as `mcp__<name>__<tool>`. */
export interface RemoteMcpServer {
  name: string
  spec: McpServerSpec
}

export interface VendorRunRequest {
  model: ModelChoice
  /**
   * Stable per-agent id. Stateless vendors use it as the prompt-cache key /
   * sticky-routing session so every tick of the same agent lands on the same
   * cache shard (OpenRouter `prompt_cache_key` + `session_id`).
   */
  agentId?: string
  systemPrompt: string
  prompt: string
  tools: AgentToolDef[]
  host: ToolHost
  remote: RemoteMcpServer[]
  gate: ToolGate
  maxTurns: number
  /** Vendor session to resume (Claude); null = fresh. */
  resumeSessionId: string | null
  cwd: string
  abort: AbortController
  emit: (delta: RunDelta) => void
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void
  /**
   * Each completed model call, with the messages it saw and produced — for
   * the run trace (`core/trace/types.ts`). Optional on both sides: a vendor
   * that cannot see its own loop reports nothing and the trace is still
   * complete minus the per-step messages. Must never throw into the run.
   */
  onModelStep?: (step: ModelStep) => void
}

export interface VendorRunResult {
  texts: string[]
  thinking: string[]
  toolCalls: ToolCallSummary[]
  /** Bytes of full tool detail kept on `toolCalls` so far — the run's budget (`TOOL_DETAIL_BUDGET_BYTES`). */
  toolDetailBytes?: number
  inputTokens: number
  outputTokens: number
  /** Full context footprint of the last model call (fresh + cached input). */
  contextTokens: number
  /** Prompt tokens served from the provider's cache across the run (cost visibility; 0 when the vendor has no cache). */
  cachedTokens?: number
  /**
   * What the run cost, when the provider priced it. `undefined` means UNKNOWN,
   * never zero — a host that persists it as 0 records a free run that was not
   * free. Store it as unknown.
   */
  costUsd?: number
  /**
   * The model that ACTUALLY served the run, when the vendor can tell us.
   * Undefined means "we cannot know" — the host must then fall back to the model
   * it asked for, never assume the two are the same.
   *
   * This exists because OpenRouter may answer on a fallback model. Recording the
   * REQUESTED id in `runs.model` would make the usage table state, confidently,
   * that money was spent on a model that never ran.
   */
  modelUsed?: string
  /** Resumable vendor session id (null when the vendor has no sessions). */
  sessionId: string | null
  /**
   * Why the loop ended. `turns` and `cost` are CUT-OFFS, not completions: the
   * model had more to do and was stopped. That used to be invisible — a run
   * that placed a trade and then ran out of turns produced no thread message at
   * all (runOnce only speaks up when there were no tool calls), so the operator
   * saw an order card with no explanation and `ok: true`. If it was cut between
   * the buy and the set_exit, the position was unprotected and nothing said so.
   */
  stoppedBecause: 'natural' | 'turns' | 'cost'
  error?: string
}

export interface ModelVendorRunner {
  readonly vendor: ModelVendor
  run(req: VendorRunRequest): Promise<VendorRunResult>
}

export type VendorRunners = Partial<Record<ModelVendor, ModelVendorRunner>>
