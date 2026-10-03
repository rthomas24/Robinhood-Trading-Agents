import { z } from 'zod'
import { McpHttpClient } from '../../mcp/httpClient'
import { TB_SERVER_NAME, type AgentToolDef } from '../agentTools'
import { capText, describeError, emptyResult, noteToolBlocked, noteToolCall, makeRunTool, noteToolResult, offered } from './shared'
import type { ModelVendorRunner, VendorRunRequest, VendorRunResult } from './types'

/**
 * ChatGPT vendor: the operator's own ChatGPT subscription (Plus / Pro / Team)
 * through the Codex backend — the same stateless Responses endpoint the Codex
 * CLI uses, authenticated with the OAuth bundle `main/chatgpt/oauth.ts` holds.
 *
 * Same discipline as the other vendors: `runOnce` builds ONE request, tool
 * names stay `mcp__<server>__<tool>`, the gate runs before/after every call,
 * remote HTTP MCP servers are bridged through `McpHttpClient` (stdio skipped).
 *
 * ⚠️ Unofficial surface — what is known about it, and why the loop is explicit
 * rather than an SDK's agent runner:
 *   - the edge gateway validates the body against a strict allowlist and
 *     answers a bare 400 for any extra field — so we build the exact body
 *     ourselves instead of letting a client library add fields;
 *   - it is stateless: `store: false`, no `previous_response_id`, and the
 *     model's message/function-call items must be threaded back as input on
 *     the next turn (reasoning items are NOT — they lack the encrypted content
 *     the stateless backend would require);
 *   - `response.completed` arrives with an EMPTY `output`, so function calls
 *     only exist as streamed `response.output_item.done` events (arguments may
 *     stream separately) — hence "no function_call items this turn" = final.
 */
export interface ChatGptSession {
  accessToken: string
  accountId: string
}
export interface ChatGptRunnerOptions {
  /** Current bundle (refreshed proactively); `force` after a 401. Null = not signed in. */
  session: (force?: boolean) => Promise<ChatGptSession | null>
  /** Codex responses endpoint + the identity headers it requires. */
  endpoint: { url: string; originator: string; beta: string; userAgent: string }
}

const EFFORT: Record<string, 'low' | 'medium' | 'high'> = { low: 'low', medium: 'medium', high: 'high' }

/** zod → JSON schema the way the Responses API expects it (no $schema, object root). */
function jsonSchemaOf(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  delete js.$schema
  return js.type === 'object' ? js : { type: 'object', properties: {} }
}

type ToolDef = { type: 'function'; name: string; description: string; parameters: Record<string, unknown>; strict: false }
type InputItem = Record<string, unknown>
interface TurnResult {
  text: string
  reasoning: string
  items: InputItem[]
  calls: { call_id: string; name: string; arguments: string }[]
  inputTokens?: number
  outputTokens?: number
  status: number
  errorText?: string
}

/** Minimal SSE reader over fetch (the backend always streams). */
async function* sseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      if (signal.aborted) return
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n')
        if (!data || data === '[DONE]') continue
        try {
          yield JSON.parse(data) as Record<string, unknown>
        } catch {
          /* keep-alive / partial frame */
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function createChatGptRunner(opts: ChatGptRunnerOptions): ModelVendorRunner {
  return {
    vendor: 'chatgpt',
    async run(req: VendorRunRequest): Promise<VendorRunResult> {
      const out = emptyResult()
      out.costUsd = 0 // subscription — flat
      let session = await opts.session()
      if (!session) {
        out.error = 'ChatGPT is not connected — sign in with your ChatGPT subscription in Connections, or switch this agent\'s model.'
        return out
      }

      // ── Tool surface: ours + remote HTTP MCP servers ──
      const ours = new Map<string, AgentToolDef>()
      const tools: ToolDef[] = []
      for (const t of req.tools) {
        const name = `mcp__${TB_SERVER_NAME}__${t.name}`
        ours.set(name, t)
        tools.push({ type: 'function', name, description: t.description, parameters: jsonSchemaOf(t.schema), strict: false })
      }
      const remoteTools = new Map<string, { client: McpHttpClient; tool: string }>()
      for (const r of req.remote) {
        if (r.spec.type !== 'http') {
          req.log('warn', `intel source ${r.name} is stdio — not reachable from the ChatGPT vendor, skipped`)
          continue
        }
        const headers = r.spec.headers ?? {}
        const client = new McpHttpClient({ url: r.spec.url, headers: () => headers, clientName: 'robinhood-trading-agents' })
        try {
          for (const t of await client.listTools()) {
            const name = `mcp__${r.name}__${t.name}`
            if (!offered(req.gate, name)) continue
            remoteTools.set(name, { client, tool: t.name })
            tools.push({ type: 'function', name, description: t.description ?? t.name, parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }, strict: false })
          }
        } catch (err) {
          req.log('warn', `MCP server ${r.name} unavailable for this run: ${(err as Error).message}`)
        }
      }

      const runTool = makeRunTool(req, ours, remoteTools, (name, args, message) => noteToolBlocked(out, req.emit, name, args, message))

      // ── One model turn: POST the exact allow-listed body, stream it back ──
      const signal = req.abort.signal
      const sessionId = crypto.randomUUID()
      const effort = EFFORT[req.model.effort] ?? 'medium'
      const turn = async (input: InputItem[]): Promise<TurnResult> => {
        const body = {
          model: req.model.id,
          instructions: req.systemPrompt,
          input,
          tools: tools.length ? tools : undefined,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          reasoning: { effort, summary: 'auto' },
          include: ['reasoning.encrypted_content'],
          store: false,
          stream: true,
          text: { verbosity: 'medium' }
        }
        const res = await fetch(opts.endpoint.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session!.accessToken}`,
            'chatgpt-account-id': session!.accountId,
            'OpenAI-Beta': opts.endpoint.beta,
            originator: opts.endpoint.originator,
            session_id: sessionId,
            'User-Agent': opts.endpoint.userAgent,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream'
          },
          body: JSON.stringify(body),
          signal
        })
        const r: TurnResult = { text: '', reasoning: '', items: [], calls: [], status: res.status }
        if (!res.ok || !res.body) {
          r.errorText = (await res.text().catch(() => '')).slice(0, 300)
          return r
        }
        const argsByItem = new Map<string, string>()
        for await (const ev of sseEvents(res.body, signal)) {
          const t = ev.type as string | undefined
          if (t === 'response.output_text.delta' && typeof ev.delta === 'string') {
            r.text += ev.delta
            req.emit({ kind: 'text', text: ev.delta })
          } else if (t === 'response.reasoning_summary_text.delta' && typeof ev.delta === 'string') {
            r.reasoning += ev.delta
            req.emit({ kind: 'thinking', text: ev.delta })
          } else if (t === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
            const key = String(ev.item_id ?? ev.output_index ?? '')
            argsByItem.set(key, (argsByItem.get(key) ?? '') + ev.delta)
          } else if (t === 'response.output_item.done' && ev.item && typeof ev.item === 'object') {
            const item = ev.item as Record<string, unknown>
            if (item.type === 'function_call') {
              const key = String(item.id ?? ev.output_index ?? '')
              const args = (typeof item.arguments === 'string' && item.arguments) || argsByItem.get(key) || '{}'
              r.calls.push({ call_id: String(item.call_id ?? item.id ?? key), name: String(item.name), arguments: args })
              r.items.push({ ...item, arguments: args })
            } else if (item.type !== 'reasoning') {
              r.items.push(item)
            }
          } else if (t === 'response.completed' || t === 'response.incomplete' || t === 'response.failed') {
            const resp = ev.response as Record<string, unknown> | undefined
            const usage = resp?.usage as Record<string, unknown> | undefined
            if (typeof usage?.input_tokens === 'number') r.inputTokens = usage.input_tokens
            if (typeof usage?.output_tokens === 'number') r.outputTokens = usage.output_tokens
            if (t === 'response.failed') {
              const e = resp?.error as Record<string, unknown> | undefined
              r.errorText = String(e?.message ?? 'response.failed')
            }
          }
        }
        return r
      }

      // ── The tool loop ──
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: req.prompt }] }]
      let retriedAuth = false
      try {
        for (let i = 0; i < req.maxTurns; i++) {
          if (signal.aborted) break
          const t = await turn(input)
          // Expired/revoked token → one forced refresh and retry; anything else is the vendor's answer.
          if (t.status === 401 && !retriedAuth) {
            retriedAuth = true
            session = await opts.session(true)
            if (!session) {
              out.error = 'ChatGPT session expired — sign in again in Connections.'
              return out
            }
            i--
            continue
          }
          if (t.status === 401 || t.status === 403) {
            out.error = `ChatGPT rejected the request (${t.status})${t.errorText ? `: ${t.errorText}` : ''} — sign in again in Connections.`
            return out
          }
          if (t.errorText !== undefined && t.status >= 400) {
            out.error = `ChatGPT ${t.status}${t.errorText ? `: ${t.errorText}` : ''}`
            return out
          }
          if (t.errorText) {
            out.error = t.errorText
            return out
          }
          if (t.text.trim()) out.texts.push(t.text)
          if (t.reasoning.trim()) out.thinking.push(t.reasoning)
          out.inputTokens += t.inputTokens ?? 0
          out.outputTokens += t.outputTokens ?? 0
          out.contextTokens = t.inputTokens ?? out.contextTokens
          if (!t.calls.length) {
            out.stoppedBecause = 'natural'
            break
          }

          // Thread the model's own items back (messages + function calls; never reasoning), then each tool's output.
          input.push(...t.items.map(({ id: _id, ...rest }) => rest))
          for (const c of t.calls) {
            let args: Record<string, unknown> = {}
            try {
              args = c.arguments ? (JSON.parse(c.arguments) as Record<string, unknown>) : {}
            } catch {
              /* malformed args → the tool reports it */
            }
            noteToolCall(out, req.emit, c.name, args)
            let result: string
            try {
              result = await runTool(c.name, args)
            } catch (err) {
              result = `ERROR: ${describeError(err)}`
            }
            noteToolResult(out, req.emit, c.name, result)
            input.push({ type: 'function_call_output', call_id: c.call_id, output: capText(result) })
          }
        }
      } catch (err) {
        if (!signal.aborted) out.error = (err as Error).message || String(err)
      }
      // Fell out of the loop with tool calls still pending: the model was cut
      // off mid-plan, not finished.
      if (!out.stoppedBecause && !out.error) out.stoppedBecause = 'turns'
      return out
    }
  }
}
