import { DEFAULT_OPENROUTER_MODEL_ID, OPENROUTER_FALLBACK_MODELS, openRouterModelFor } from '@shared/agents'
import { ROBINHOOD_TOOL_CATALOG } from '@shared/mcps'
import { TB_SERVER_NAME } from '../agentTools'
import { afterToolCall, capText, capToolOutput, describeError, emptyResult, gateToolCall, noteToolBlocked, noteToolCall, noteToolResult, offered } from './shared'
import type { ModelVendorRunner, VendorRunRequest, VendorRunResult } from './types'
import type { TraceMessage } from '../../trace/types'
import { modelStepFromResponse, toolMessageFor } from './openrouterTrace'

/**
 * OpenRouter vendor: the OpenRouter Agent SDK (`@openrouter/agent` callModel)
 * on the operator's own OpenRouter API key (the host resolves it). Our tools
 * are function tools; remote HTTP MCP servers (Robinhood, hosted intel) are
 * discovered with `createMCPTools` and surfaced under the same
 * `mcp__<server>__<tool>` names the other vendors use. The gate runs in
 * PreToolUse/PostToolUse. Stdio MCP servers are not reachable here (HTTP only).
 *
 * COST MODEL — every tick is stateless (system + run prompt + tool loop), so
 * prompt caching is what keeps it cheap. The request is shaped as a stable
 * prefix followed by a dynamic suffix:
 *   instructions  = composeSystemPrompt(cfg)   — changes only when the agent's config changes
 *   tools         = AGENT_TOOLS + MCP tools     — fixed order, deterministic schemas
 *   input         = composeRunPrompt(...)       — clock, book, thread: different every tick
 * The system prompt is sent as input[0] (role system) carrying an explicit
 * `promptCacheBreakpoint` — OpenRouter converts it to Anthropic/Gemini
 * `cache_control` and automatic providers (xAI, OpenAI, DeepSeek) ignore it.
 * Measured at 97–98 % of prompt tokens served from cache per tick (roughly
 * 70–90 % cheaper, depending on the model).
 * Do NOT use the SDK's top-level `cacheControl`: OpenRouter places that
 * breakpoint AFTER the dynamic input, so it writes the cache on every call and
 * never reads it (measured: cache_write_tokens on every request, 0 hits).
 * `promptCacheKey` + `sessionId` pin the agent to one cache shard / backend
 * across ticks; within a run the SDK keeps `tools` in the request on the final
 * turn so the cache survives. Anything that varies per call must go in the
 * user item, never in the system item or tool definitions.
 */
export type OpenRouterAgentModule = typeof import('@openrouter/agent')
export type OpenRouterMcpModule = typeof import('@openrouter/agent/mcp')

export interface OpenRouterRunnerOptions {
  apiKey: () => Promise<string | null>
  modules: () => Promise<{ agent: OpenRouterAgentModule; mcp: OpenRouterMcpModule }>
  appTitle?: string
  httpReferer?: string
}

const EFFORT: Record<string, 'low' | 'medium' | 'high'> = { low: 'low', medium: 'medium', high: 'high' }

/** Hard ceiling on what one run may spend, on top of maxTurns and the loop guard. A normal tick is cents. */
export const MAX_RUN_COST_USD = 1.0

/**
 * What a model call with NO reported cost counts as against the run ceiling.
 *
 * The SDK's own `maxCost` sums `step.usage?.cost ?? 0`, so a provider that
 * omits `cost` makes every step free in the ceiling's eyes and the run can only
 * be stopped by `maxTurns`. Cost is 100 % provider-reported here — there is no
 * price table to fall back on — so the honest reading of "unpriced" is "unknown,
 * and possibly large". $0.25 is several times a normal tick and a quarter of
 * the ceiling: four unpriced calls stop the run, which keeps an unpriced
 * runaway bounded without cutting an ordinary run short over one missing
 * number. Never 0 — that is the silent-runaway shape this replaces.
 */
export const UNPRICED_STEP_COST_USD = 0.25

/** A step as the SDK's stop conditions see it (`StepResult.usage`); only the cost matters here. */
export type CostStep = { readonly usage?: { readonly cost?: number | null } | null }

/** Sum of the steps' costs, counting an unpriced step as `UNPRICED_STEP_COST_USD`. */
export function runCostSoFar(steps: ReadonlyArray<CostStep>): number {
  return steps.reduce((sum, step) => sum + stepCost(step.usage?.cost), 0)
}

/** One call's contribution to the ceiling: its reported cost, or the unpriced stand-in. */
export function stepCost(cost: number | null | undefined): number {
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : UNPRICED_STEP_COST_USD
}

/** `agent.maxCost` with the unpriced rule — same signature as the SDK's stop conditions. */
export function costCeiling(maxUsd: number): (o: { steps: ReadonlyArray<CostStep> }) => boolean {
  return ({ steps }) => runCostSoFar(steps) >= maxUsd
}

/** Total time a run's settle may spend asking the provider for prices it did not send. */
const RECONCILE_BUDGET_MS = 8_000
const RECONCILE_RETRY_DELAY_MS = 2_000
const GENERATION_URL = 'https://openrouter.ai/api/v1/generation'

/**
 * Price a run the provider did not price. Every model call's `responseId` is
 * an OpenRouter generation id, and `GET /api/v1/generation?id=` returns what
 * that generation cost (`data.total_cost`, USD) once its stats have landed —
 * which can be a beat after the stream ends, hence one retry after a pause.
 * Read with the run's own API key, so only the operator's own generations
 * are visible.
 *
 * Returns the SUM only when EVERY id priced. A partial sum would be recorded
 * as the run's price, the NULL→number roll-up would credit it once, and the
 * understatement would be permanent — unknown is the honest answer then.
 * Bounded by `RECONCILE_BUDGET_MS` in total so a settle never hangs on it.
 */
export async function reconcileRunCost(
  ids: readonly string[],
  apiKey: string,
  log: (level: 'info' | 'warn', msg: string) => void,
  fetchImpl: typeof fetch = fetch,
  budgetMs = RECONCILE_BUDGET_MS
): Promise<number | undefined> {
  if (ids.length === 0) return undefined
  const deadline = Date.now() + budgetMs
  const priced = new Map<string, number>()
  let loggedShape = false
  const priceOne = async (id: string): Promise<void> => {
    const left = deadline - Date.now()
    if (left <= 0) return
    const res = await fetchImpl(`${GENERATION_URL}?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(Math.min(4_000, left)) })
    if (!res.ok) throw new Error(`generation ${id} → ${res.status}`)
    const body = (await res.json()) as { data?: Record<string, unknown> }
    const cost = body?.data?.total_cost
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      priced.set(id, cost)
      return
    }
    if (!loggedShape) {
      loggedShape = true
      log('warn', `openrouter generation ${id}: no numeric data.total_cost — keys: ${Object.keys(body?.data ?? body ?? {}).join(',') || '(none)'}`)
    }
    throw new Error(`generation ${id}: unpriced response`)
  }
  // The budget is enforced here as well as through the abort signal: a fetch
  // that ignores its signal must still not hold the settle past the deadline.
  const withinBudget = (work: Promise<void>): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reconcile budget exhausted')), Math.max(0, deadline - Date.now()))
      work.then(resolve, reject).finally(() => clearTimeout(timer))
    })
  const attempt = async (pending: readonly string[]): Promise<string[]> => {
    const failed: string[] = []
    await Promise.all(pending.map((id) => withinBudget(priceOne(id)).catch(() => failed.push(id))))
    return failed
  }
  let failed = await attempt(ids)
  if (failed.length && deadline - Date.now() > RECONCILE_RETRY_DELAY_MS) {
    await new Promise((r) => setTimeout(r, RECONCILE_RETRY_DELAY_MS))
    failed = await attempt(failed)
  }
  if (failed.length) {
    log('warn', `openrouter: run still unpriced after reconciliation — ${failed.length} of ${ids.length} generation(s) returned no cost`)
    return undefined
  }
  let total = 0
  for (const v of priced.values()) total += v
  log('info', `openrouter: priced an unpriced run from the provider — ${ids.length} generation(s), $${total.toFixed(4)}`)
  return total
}

/** Per-call HTTP timeout; the run-level watchdog (stall 45 s / hard 300 s) lives in runOnce. */
const CALL_TIMEOUT_MS = 120_000
/**
 * Hard ceiling on ONE model step's output, reasoning included.
 *
 * Measured over ~1,300 steps: p50 148 output tokens, p95 580, p99 3,361 — and a
 * small tail of steps over 5,000 tokens that ran for minutes. Those are the runs
 * that hit `RUN_TIMEOUT_MS` with nothing to show: the model reasons without ever
 * finishing the step, the stall watchdog sees a live stream, and the ceiling is
 * the only thing that ends it. A step cut at this bound ends in ~2 minutes, the
 * run settles, the next tick is on time. Ten times the p95 so nothing healthy
 * is touched; the runaways are the only thing this bites.
 */
export const STEP_MAX_OUTPUT_TOKENS = 6_000

/** What `run()` throws when the run's abort fired mid-stream; runOnce names the real cause (deadline, stall, Stop). */
export const STREAM_ABORTED_MSG = 'Run aborted before the model finished'

/**
 * The SDK's event stream, read no further than the run's abort.
 *
 * `callModel` is handed the run signal and composes it into every HTTP
 * request, and its loop checks it between turns — but an in-flight RESPONSE
 * is not cut when it fires. A run aborted at its ceiling was seen to keep
 * streaming for another two minutes, until the model finished a long turn on
 * its own; only then did the SDK look at the signal, refuse that turn's tool
 * calls, and throw. Everything waiting on that run — the reply queued behind
 * it, the operator watching the bubble — waited the extra minutes for
 * nothing.
 *
 * So the abort is raced against every `next()`, and on abort we simply stop
 * reading: the iterator is released without being awaited (a stream that will
 * not end is the reason we are leaving), and whatever the SDK's loop does
 * afterwards is refused by runOnce's gate (`runEnded`).
 */
export async function* untilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T, void, undefined> {
  const it = source[Symbol.asyncIterator]()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(STREAM_ABORTED_MSG))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  // Observed through the race below; this only keeps a rejection that fires
  // after we have already left the loop from being reported as unhandled.
  aborted.catch(() => undefined)
  try {
    for (;;) {
      const r = await Promise.race([it.next(), aborted])
      if (r.done) return
      yield r.value
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    try {
      void Promise.resolve(it.return?.()).catch(() => undefined)
    } catch {
      /* a synchronous throw from return() is as ignorable as a rejection */
    }
  }
}
/** A tool result as kept in the TRACE transcript (the model itself sees the capped result; this bounds the trace's copy). */
const TRACE_TOOL_CHARS = 20_000

/** SDK usage: `inputTokens` is the TOTAL prompt (cached tokens included); `cachedTokens` is the subset served from cache. */
type Usage = { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cost?: number }

/** Function-tool name as the SDK shapes it (`tool.function.name`); '' for server tools, which we never receive from MCP. */
const toolName = (t: unknown): string => (t as { function?: { name?: string } }).function?.name ?? ''

export function createOpenRouterRunner(opts: OpenRouterRunnerOptions): ModelVendorRunner {
  return {
    vendor: 'openrouter',
    async run(req: VendorRunRequest): Promise<VendorRunResult> {
      const out = emptyResult()
      const apiKey = await opts.apiKey()
      if (!apiKey) {
        out.error = 'No OpenRouter API key is set — add yours under Settings → Connections, or switch this agent to another provider.'
        return out
      }
      const { agent, mcp } = await opts.modules()
      // App attribution is optional and off by default: OpenRouter only ranks
      // apps that send these headers, and a local app has no reason to.
      const client = new agent.OpenRouter({ apiKey, ...(opts.appTitle ? { appTitle: opts.appTitle } : {}), ...(opts.httpReferer ? { httpReferer: opts.httpReferer } : {}) })
      const modelId = openRouterModelFor(req.model.id)
      // What was ASKED FOR, from the first moment, so a run that fails before
      // its first response is still filed under the right model. The response's
      // own `model` overwrites this once it arrives, so a fallback model is
      // still reported as what ran.
      out.modelUsed = modelId

      // Our tools → function tools with the canonical mcp__tb__ names. Order is AGENT_TOOLS order — stable.
      const tools: unknown[] = req.tools.map((t) =>
        agent.tool({
          name: `mcp__${TB_SERVER_NAME}__${t.name}`,
          description: t.description,
          inputSchema: t.schema,
          execute: async (args: unknown) => capText(await t.run(t.schema.parse(args), req.host))
        })
      )

      // Remote HTTP MCP servers → discovered tools, prefixed to match the other vendors.
      const handles: Array<{ close(): Promise<void> }> = []
      for (const r of req.remote) {
        if (r.spec.type !== 'http') {
          req.log('warn', `intel source ${r.name} is stdio — not reachable from the OpenRouter vendor, skipped`)
          continue
        }
        try {
          const prefix = `mcp__${r.name}__`
          const includeTools = r.name === 'robinhood' ? ROBINHOOD_TOOL_CATALOG.map((t) => t.name).filter((n) => offered(req.gate, prefix + n)) : undefined
          const h = await mcp.createMCPTools({
            url: r.spec.url,
            ...(r.spec.headers ? { auth: { kind: 'headers', headers: r.spec.headers } } : {}),
            toolNamePrefix: prefix,
            ...(includeTools ? { includeTools } : {}),
            clientInfo: { name: 'robinhood-trading-agents', version: '0.1.0' },
            resources: false,
            signal: req.abort.signal
          })
          handles.push(h)
          // Discovery order can vary between a server's restarts; sort so the cached prefix is byte-stable.
          const discovered = [...h.tools].sort((a, b) => toolName(a).localeCompare(toolName(b)))
          // Cap what a REMOTE server can put in the context window. The SDK
          // owns this loop and its PostToolUse hook has no return channel
          // (`PostToolUsePayloadSchema` takes `toolOutput` as input only), so
          // the only seam is the tool's own `execute`. Mutated in place rather
          // than spread into a copy: `tool-executor.js` branches on
          // `isMcpTool(tool)`, and rebuilding the object risks dropping
          // whatever that reads. These are per-run objects, so mutation is
          // contained to this run.
          //
          // ⚠️ TWO KINDS OF `execute`, and getting this wrong took every remote
          // tool down. `isGeneratorTool` is `'eventSchema' in tool.function`,
          // and MCP tools HAVE one — so the SDK calls `execute(...)` and then
          // `iterator.next()` on what comes back. Wrapping a generator in a
          // plain `async` function returns a Promise, and every WebVector and
          // Robinhood call died with "iterator.next is not a function".
          //
          // The generator wrapper delegates rather than collecting: events are
          // yielded straight through, and the RETURN value — which is what the
          // SDK hands the model as `result` — is capped. Yielded values are
          // capped too, because when a generator returns nothing the SDK
          // promotes the LAST EMITTED value to the result, so that path
          // reaches the model as well. `capToolOutput` is identity below the
          // budget, so an ordinary small event passes through untouched and
          // cannot fail the SDK's `eventSchema` validation.
          for (const d of discovered) {
            const fn = (d as { function?: { execute?: (...a: unknown[]) => unknown; eventSchema?: unknown } }).function
            if (!fn || typeof fn.execute !== 'function') continue
            const inner = fn.execute.bind(fn) as (...a: unknown[]) => unknown
            if ('eventSchema' in fn) {
              fn.execute = async function* (...a: unknown[]): AsyncGenerator<unknown, unknown, unknown> {
                const it = inner(...a) as AsyncIterator<unknown, unknown, unknown>
                let r = await it.next()
                while (!r.done) {
                  yield capToolOutput(r.value)
                  r = await it.next()
                }
                return r.value === undefined ? undefined : capToolOutput(r.value)
              }
            } else {
              fn.execute = async (...a: unknown[]): Promise<unknown> => capToolOutput(await inner(...a))
            }
          }
          tools.push(...discovered)
        } catch (err) {
          req.log('warn', `MCP server ${r.name} unavailable for this run: ${(err as Error).message}`)
        }
      }

      // ── Run trace (core/trace/types.ts) ─────────────────────────────────
      // `history` is the transcript as the model sees it — system, prompt, then
      // each step's output and each tool's answer — so every model step can be
      // reported with the messages that were in front of it. Reset per `run()`.
      let history: TraceMessage[] = []
      /** PostModelCall's view of a generation, keyed by response id, for the step report. */
      const postModel = new Map<string, { turnType?: string; durationMs?: number }>()
      const pushToolMessage = (name: string, output: unknown): void => {
        if (!req.onModelStep) return
        history.push(toolMessageFor(history, name, output, TRACE_TOOL_CHARS))
      }

      let current = ''
      let currentReasoning = ''
      const flushTurn = (): void => {
        if (current.trim()) out.texts.push(current)
        if (currentReasoning.trim()) out.thinking.push(currentReasoning)
        current = ''
        currentReasoning = ''
      }

      // Per-call usage → running cache totals so the run record (and the log) show what caching saved.
      let calls = 0
      let cachedTotal = 0
      let inputTotal = 0
      // Output and cost are summed too, because a run that THROWS — the run
      // deadline aborting a model call mid-stream is the common case — never
      // reaches `getUsage()`, and would otherwise be recorded with zero tokens
      // and no cost. Every model call before the abort was real and was billed.
      let outputTotal = 0
      let costTotal = 0
      let costReported = false
      /** What the ceiling counted, with unpriced calls at the stand-in — the same rule `costCeiling` stops on. */
      let countedCost = 0
      /** Every model call's generation id, so an unpriced run can be priced from the provider afterwards. */
      const responseIds: string[] = []
      const hooks = {
        PreToolUse: [
          {
            handler: async ({ toolName, toolInput }: { toolName: string; toolInput: Record<string, unknown> }) => {
              const v = await gateToolCall(req.gate, toolName, toolInput)
              if (!v.ok) {
                // Never runs, so nothing downstream would record it — the thread
                // still shows what was asked and why it was refused.
                noteToolBlocked(out, req.emit, toolName, toolInput, v.message)
                pushToolMessage(toolName, v.message)
                return { block: v.message }
              }
              noteToolCall(out, req.emit, toolName, v.input)
              return v.input !== toolInput ? { mutatedInput: v.input } : undefined
            }
          }
        ],
        PostToolUse: [
          {
            handler: async ({ toolName, toolInput, toolOutput }: { toolName: string; toolInput: Record<string, unknown>; toolOutput: unknown }) => {
              noteToolResult(out, req.emit, toolName, toolOutput)
              pushToolMessage(toolName, toolOutput)
              await afterToolCall(req.gate, req.log, toolName, toolInput, toolOutput)
            }
          }
        ],
        PostToolUseFailure: [
          {
            handler: ({ toolName, error }: { toolName: string; error: unknown }) => {
              const msg = `ERROR: ${describeError(error)}`
              noteToolResult(out, req.emit, toolName, msg)
              pushToolMessage(toolName, msg)
            }
          }
        ],
        PostModelCall: [
          {
            handler: ({ usage, responseId, turnType, durationMs }: { usage?: Usage; responseId?: string; turnType?: string; durationMs?: number }) => {
              if (typeof responseId === 'string' && responseId) {
                responseIds.push(responseId)
                postModel.set(responseId, { turnType, durationMs })
              }
              calls++
              countedCost += stepCost(usage?.cost)
              if (!usage) return
              cachedTotal += usage.cachedTokens ?? 0
              inputTotal += usage.inputTokens ?? 0
              outputTotal += usage.outputTokens ?? 0
              if (typeof usage.cost === 'number') {
                costTotal += usage.cost
                costReported = true
              }
              out.contextTokens = usage.inputTokens ?? 0
            }
          }
        ]
      }

      const run = async (withReasoning: boolean): Promise<void> => {
        history = [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.prompt }
        ]
        let stepIdx = 0
        let stepStartedAt = new Date().toISOString()
        /** One completed generation → one model step in the trace (openrouterTrace.ts is the pure mapping). */
        const reportStep = (ev: unknown): void => {
          if (!req.onModelStep) return
          try {
            const r = ((ev as { response?: Record<string, unknown> }).response ?? {}) as Record<string, unknown>
            const responseId = typeof r.id === 'string' ? r.id : undefined
            const endedAt = new Date().toISOString()
            const step = modelStepFromResponse(r, { index: ++stepIdx, modelId, history, startedAt: stepStartedAt, endedAt, turnType: responseId ? postModel.get(responseId)?.turnType : undefined })
            req.onModelStep(step)
            history.push(...step.output)
            stepStartedAt = endedAt
          } catch (err) {
            req.log('warn', `trace: model step not reported: ${(err as Error).message}`)
          }
        }
        const result = client.callModel(
          {
            model: modelId,
            // Fallbacks are OpenRouter's, not ours: it walks this list once if the
            // primary's providers are down, rate-limited, or refuse on moderation.
            // `model` stays a single id — `models` is a separate parameter, and the
            // response reports whichever one answered (read back below).
            models: modelId === DEFAULT_OPENROUTER_MODEL_ID ? [modelId, ...OPENROUTER_FALLBACK_MODELS] : [modelId],
            // Stable prefix (system + tools) with an explicit cache breakpoint, then the dynamic run prompt.
            input: [
              { role: 'system', content: [{ type: 'input_text', text: req.systemPrompt, promptCacheBreakpoint: { mode: 'explicit' } }] },
              { role: 'user', content: [{ type: 'input_text', text: req.prompt }] }
            ],
            tools: tools as never,
            // Bounded by turns AND dollars: a runaway tool loop cannot burn through the operator's credits.
            // Not the SDK's `maxCost`: that counts an unpriced step as $0 (see UNPRICED_STEP_COST_USD).
            stopWhen: [agent.stepCountIs(req.maxTurns), costCeiling(MAX_RUN_COST_USD)],
            ...(withReasoning ? { reasoning: { effort: EFFORT[req.model.effort] ?? 'medium' } } : {}),
            // One step may not reason forever (see STEP_MAX_OUTPUT_TOKENS).
            maxOutputTokens: STEP_MAX_OUTPUT_TOKENS,
            // Only route to providers that honour tools/reasoning/etc. (no silent parameter drops).
            provider: { requireParameters: true },
            // Key + session pin this agent to one cache shard / backend across ticks.
            ...(req.agentId ? { promptCacheKey: req.agentId, sessionId: req.agentId } : {}),
            // Never persist the response server-side — the thread is ours.
            store: false,
            hooks: hooks as never,
            signal: req.abort.signal
          } as never,
          { timeoutMs: CALL_TIMEOUT_MS }
        )
        let cut = false
        try {
          for await (const ev of untilAborted(result.getFullResponsesStream(), req.abort.signal)) {
            const e = ev as { type?: string; delta?: string }
            if (e.type === 'response.output_text.delta' && e.delta) {
              current += e.delta
              req.emit({ kind: 'text', text: e.delta })
            } else if (e.type === 'response.reasoning_text.delta' && e.delta) {
              currentReasoning += e.delta
              req.emit({ kind: 'thinking', text: e.delta })
            } else if (e.type === 'response.completed' || e.type === 'response.incomplete') {
              // `incomplete` is a step cut at STEP_MAX_OUTPUT_TOKENS: the SDK
              // materializes it like any other, so it is a step for the trace
              // and its text is the turn's text — a runaway that ended, not
              // a failure.
              flushTurn()
              reportStep(ev)
            }
          }
        } catch (err) {
          if (!req.abort.signal.aborted) throw err
          cut = true
        }
        // Whatever the model had said so far survives the cut — the thread
        // shows it under the failure note, which says where it stopped.
        flushTurn()
        // Nothing below may wait on the SDK once we have walked away from its
        // stream: `getUsage()`/`getResponse()` resolve when ITS loop ends, and
        // that loop is exactly what we no longer trust to end. The per-call
        // hook totals are recorded by the catch in the caller.
        if (cut) throw new Error(STREAM_ABORTED_MSG)
        // stopWhen fired rather than the model finishing. The SDK does not tell
        // us which, so infer it: a run that used every step it was allowed was
        // cut off, and one that stopped short of the cap with a cost near the
        // ceiling hit the money bound instead. Either way the model had more to
        // do, which is the part the operator needs to know.
        const stepsUsed = calls
        const cost = (await result.getUsage()) as Usage
        if (stepsUsed >= req.maxTurns) out.stoppedBecause = 'turns'
        else if (countedCost >= MAX_RUN_COST_USD) out.stoppedBecause = 'cost'
        else out.stoppedBecause = 'natural'
        // Which model actually answered. OpenRouter may have fallen back, and the
        // host must record what RAN rather than what we asked for. `getResponse()`
        // reports the FINAL round, which is the right one: fallback is decided per
        // request, so the last round is the state the run ended in. Best-effort —
        // if we cannot read it, leave it undefined so the host keeps the requested
        // id rather than inventing one.
        try {
          const resp = (await result.getResponse()) as { model?: unknown }
          if (typeof resp?.model === 'string' && resp.model) {
            out.modelUsed = resp.model
            if (resp.model !== modelId) req.log('warn', `openrouter fell back: asked ${modelId}, answered by ${resp.model}`)
          }
        } catch {
          // Never fatal: a run that produced output must not be failed for a bookkeeping read.
        }
        const usage = cost
        out.inputTokens = usage.inputTokens ?? 0
        out.outputTokens = usage.outputTokens ?? 0
        out.cachedTokens = usage.cachedTokens ?? cachedTotal
        if (!out.contextTokens) out.contextTokens = usage.inputTokens ?? 0
        if (typeof usage.cost === 'number') {
          out.costUsd = usage.cost
        } else if (calls > 0) {
          // Never fall through to 0: an unpriced run that records $0 hides what
          // the operator's key actually spent. Ask the provider what each
          // generation cost instead; still unknown if it cannot say.
          req.log('warn', `openrouter ${modelId}: provider returned no cost for this run — asking the generation endpoint`)
          const reconciled = await reconcileRunCost(responseIds, apiKey, (level, msg) => req.log(level, `${msg} (${modelId})`))
          if (reconciled !== undefined) out.costUsd = reconciled
        }
        if (inputTotal > 0) {
          const pct = Math.round((100 * cachedTotal) / inputTotal)
          req.log('info', `openrouter ${modelId}: ${calls} call(s), ${cachedTotal}/${inputTotal} prompt tokens cached (${pct}%)${typeof out.costUsd === 'number' ? `, $${out.costUsd.toFixed(4)}${typeof usage.cost === 'number' ? '' : ' (reconciled)'}` : ', unpriced'}`)
        }
      }

      try {
        try {
          await run(true)
        } catch (err) {
          const msg = (err as Error).message ?? String(err)
          // Models without reasoning support may reject the parameter — retry once without it.
          if (!/reasoning/i.test(msg) || req.abort.signal.aborted) throw err
          req.log('warn', `retrying without reasoning: ${msg}`)
          out.texts.length = 0
          out.thinking.length = 0
          await run(false)
        }
      } catch (err) {
        out.error = (err as Error).message || String(err)
        // What the run spent BEFORE it died, from the per-call hook. Only fills
        // in what `getUsage()` never got to: a call that completed reported its
        // usage and was paid for whether or not the run survived it. Cost is
        // set only when every call priced itself — a partial sum would read as
        // the whole and under-state the run by exactly the calls that were
        // missing.
        if (calls > 0 && out.inputTokens === 0) {
          out.inputTokens = inputTotal
          out.outputTokens = outputTotal
          out.cachedTokens = cachedTotal
          if (!out.contextTokens) out.contextTokens = inputTotal
          if (costReported && out.costUsd === undefined) out.costUsd = costTotal
          req.log('warn', `openrouter ${modelId}: run failed after ${calls} call(s) — recording ${inputTotal} prompt tokens${costReported ? ` and $${costTotal.toFixed(4)}` : ' (unpriced)'} it had already spent`)
        }
      } finally {
        await Promise.all(handles.map((h) => h.close().catch(() => undefined)))
      }
      return out
    }
  }
}
