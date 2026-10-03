import type { ModelStep, TraceMessage } from '../../trace/types'

/**
 * A Responses-API `response.completed` payload → one `ModelStep` for the run
 * trace: what the model produced (reasoning, text, tool calls) and what it
 * cost, beside the transcript it had in front of it. Pure, so the mapping is
 * testable without a model; the vendor feeds it the event and the history.
 *
 * Read defensively: camelCase from the SDK's models, snake_case if a raw event
 * ever reaches us, and an item shape we have not seen is skipped rather than
 * thrown on — a step with an incomplete output is still a step.
 */
export function modelStepFromResponse(
  response: unknown,
  ctx: { index: number; modelId: string; history: readonly TraceMessage[]; startedAt: string; endedAt: string; turnType?: string }
): ModelStep {
  const r = ((response ?? {}) as Record<string, unknown>) ?? {}
  const items = Array.isArray(r.output) ? (r.output as Array<Record<string, unknown>>) : []
  const reasoning: string[] = []
  const text: string[] = []
  const calls: NonNullable<TraceMessage['toolCalls']> = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const type = String(it.type ?? '')
    if (type === 'reasoning') {
      for (const s of (it.summary as Array<{ text?: string }> | null | undefined) ?? []) if (s?.text) reasoning.push(s.text)
      for (const c of (it.content as Array<{ text?: string }> | null | undefined) ?? []) if (c?.text) reasoning.push(c.text)
    } else if (type === 'message') {
      for (const c of (it.content as Array<{ text?: string; refusal?: string }> | null | undefined) ?? []) {
        if (c?.text) text.push(c.text)
        else if (c?.refusal) text.push(`[refusal] ${c.refusal}`)
      }
    } else if (type === 'function_call') {
      let args: unknown = it.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          /* keep the raw string — the model's own bytes are the evidence */
        }
      }
      calls.push({ id: String(it.callId ?? it.call_id ?? it.id ?? `call_${calls.length + 1}`), name: String(it.name ?? ''), args })
    }
  }
  const output: TraceMessage[] = []
  if (reasoning.length) output.push({ role: 'reasoning', content: reasoning.join('\n') })
  if (text.length || calls.length) output.push({ role: 'assistant', content: text.join('\n'), ...(calls.length ? { toolCalls: calls } : {}) })
  const u = ((r.usage ?? {}) as Record<string, unknown>) ?? {}
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const inDetails = ((u.inputTokensDetails ?? u.input_tokens_details ?? {}) as Record<string, unknown>) ?? {}
  const outDetails = ((u.outputTokensDetails ?? u.output_tokens_details ?? {}) as Record<string, unknown>) ?? {}
  return {
    index: ctx.index,
    model: typeof r.model === 'string' && r.model ? r.model : ctx.modelId,
    provider: 'openrouter',
    input: [...ctx.history],
    output,
    usage: {
      inputTokens: num(u.inputTokens ?? u.input_tokens),
      outputTokens: num(u.outputTokens ?? u.output_tokens),
      totalTokens: num(u.totalTokens ?? u.total_tokens),
      cachedTokens: num(inDetails.cachedTokens ?? inDetails.cached_tokens),
      reasoningTokens: num(outDetails.reasoningTokens ?? outDetails.reasoning_tokens),
      costUsd: num(u.cost)
    },
    startedAt: ctx.startedAt,
    endedAt: ctx.endedAt,
    ...(typeof r.id === 'string' && r.id ? { responseId: r.id } : {}),
    ...(ctx.turnType ? { turnType: ctx.turnType } : {})
  }
}

/**
 * A tool's answer, appended to the trace transcript against the call it
 * answers. The SDK's PostToolUse hook carries the tool's NAME but not the call
 * id, so the first unanswered call of that name is the one — which is also
 * the order the SDK executes them in.
 */
export function toolMessageFor(history: readonly TraceMessage[], name: string, output: unknown, maxChars: number): TraceMessage {
  const answered = new Set(history.filter((m) => m.role === 'tool').map((m) => m.toolCallId))
  let call: { id: string } | undefined
  for (const m of history) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    const hit = m.toolCalls.find((c) => c.name === name && !answered.has(c.id))
    if (hit) {
      call = hit
      break
    }
  }
  const raw = typeof output === 'string' ? output : (JSON.stringify(output) ?? '')
  const content = raw.length > maxChars ? `${raw.slice(0, maxChars)}…[${raw.length - maxChars} more chars cut]` : raw
  return { role: 'tool', name, content, ...(call ? { toolCallId: call.id } : {}) }
}
