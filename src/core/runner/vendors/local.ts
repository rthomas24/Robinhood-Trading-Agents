import { z } from 'zod'
import { McpHttpClient } from '../../mcp/httpClient'
import { TB_SERVER_NAME, type AgentToolDef } from '../agentTools'
import { capText, describeError, emptyResult, noteToolBlocked, noteToolCall, makeRunTool, noteToolResult, offered } from './shared'
import type { ModelVendorRunner, VendorRunRequest, VendorRunResult } from './types'

/**
 * Local-GPU vendor: an OpenAI-compatible model served on this machine by the
 * local engine (llama.cpp behind 127.0.0.1/v1 — see
 * main/local/engine.ts). The tool loop lives here: our tools become function
 * tools (zod → JSON schema), remote HTTP MCP servers are bridged through
 * `McpHttpClient`, names stay `mcp__<server>__<tool>` like every other vendor,
 * and the gate runs before/after each call. Streaming + thinking + tool-call
 * assembly come from `@elyxndra/agent`'s `streamChat` (battle-tested against
 * llama.cpp's quirks). No network, no cost, no sessions.
 */
export interface LocalEndpoint {
  /** OpenAI-compatible base URL ending in /v1. */
  baseUrl: string
  headers: Record<string, string>
  /** Model id to send (the engine serves one model; 'local' is accepted). */
  model: string
  modelLabel: string
  reasoning: { supported: boolean; effortLevels: string[] } | null
  contextWindow: number | null
}

export type LocalAgentModule = Pick<typeof import('@elyxndra/agent'), 'streamChat' | 'parseArguments' | 'toolCallsWire'>

export interface LocalRunnerOptions {
  /** Resolve (and if needed start) the live local model; null = nothing available. */
  endpoint: () => Promise<LocalEndpoint | null>
  modules: () => Promise<LocalAgentModule>
  /** Why `endpoint()` returned null, for the thread (e.g. "no model installed"). */
  unavailableReason?: () => string
}

/** zod → JSON schema the way OpenAI-compatible servers expect it (no $schema, object root). */
function jsonSchemaOf(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  delete js.$schema
  return js.type === 'object' ? js : { type: 'object', properties: {} }
}

/** `@elyxndra/agent`'s ToolDefinition shape (its extra fields are UI metadata this app does not use). */
interface ToolDefinitionLike {
  name: string
  description: string
  summary: string
  displayName: string
  icon: string
  mutates: boolean
  reachesInternet: boolean
  parameters: Record<string, unknown>
}

const toolDef = (name: string, description: string, parameters: Record<string, unknown>): ToolDefinitionLike => ({
  name,
  description,
  summary: description.split('. ')[0].slice(0, 120),
  displayName: name.replace(/^mcp__\w+__/, ''),
  icon: 'wrench',
  mutates: false,
  reachesInternet: false,
  parameters
})

const EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high' }

type Wire = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: unknown; tool_call_id?: string }

export function createLocalRunner(opts: LocalRunnerOptions): ModelVendorRunner {
  return {
    vendor: 'local',
    async run(req: VendorRunRequest): Promise<VendorRunResult> {
      const out = emptyResult()
      out.costUsd = 0
      let ep: LocalEndpoint | null = null
      try {
        ep = await opts.endpoint()
      } catch (err) {
        out.error = `Local model unavailable: ${(err as Error).message}`
        return out
      }
      if (!ep) {
        out.error = opts.unavailableReason?.() ?? 'No local model is running — start one in Settings → Local models.'
        return out
      }
      const { streamChat, parseArguments, toolCallsWire } = await opts.modules()

      // Tool surface: ours + remote HTTP MCP servers (stdio is unreachable here).
      const ours = new Map<string, AgentToolDef>()
      const tools: ToolDefinitionLike[] = []
      for (const t of req.tools) {
        const name = `mcp__${TB_SERVER_NAME}__${t.name}`
        ours.set(name, t)
        tools.push(toolDef(name, t.description, jsonSchemaOf(t.schema)))
      }
      const remoteTools = new Map<string, { client: McpHttpClient; tool: string }>()
      for (const r of req.remote) {
        if (r.spec.type !== 'http') {
          req.log('warn', `intel source ${r.name} is stdio — not reachable from the local vendor, skipped`)
          continue
        }
        const headers = r.spec.headers ?? {}
        const client = new McpHttpClient({ url: r.spec.url, headers: () => headers, clientName: 'robinhood-trading-agents' })
        try {
          for (const t of await client.listTools()) {
            const name = `mcp__${r.name}__${t.name}`
            if (!offered(req.gate, name)) continue
            remoteTools.set(name, { client, tool: t.name })
            tools.push(toolDef(name, t.description ?? t.name, t.inputSchema))
          }
        } catch (err) {
          req.log('warn', `MCP server ${r.name} unavailable for this run: ${(err as Error).message}`)
        }
      }
      // Local models handle a focused tool list far better than a 40-tool dump.
      if (tools.length > 48) req.log('warn', `local model sees ${tools.length} tools — consider switching Robinhood tools off in Settings`)

      const runTool = makeRunTool(req, ours, remoteTools, (name, args, message) => noteToolBlocked(out, req.emit, name, args, message))

      const messages: Wire[] = [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.prompt }
      ]
      const signal = req.abort.signal
      const effort = ep.reasoning?.supported ? EFFORT[req.model.effort] : undefined

      try {
        for (let turn = 0; turn < req.maxTurns; turn++) {
          let content = ''
          let reasoning = ''
          let calls: { id: string; name: string; arguments: string }[] = []
          let stats: { promptTokens?: number; completionTokens?: number } | undefined
          await streamChat(
            { baseUrl: ep.baseUrl, headers: ep.headers },
            messages as never,
            { model: ep.model, thinking: 'auto', ...(effort ? { reasoningEffort: effort } : {}), maxTokens: 4096 },
            tools as never,
            (e) => {
              if (e.type === 'content') {
                content += e.delta
                req.emit({ kind: 'text', text: e.delta })
              } else if (e.type === 'reasoning') {
                reasoning += e.delta
                req.emit({ kind: 'thinking', text: e.delta })
              } else if (e.type === 'toolCalls') calls = e.calls
              else if (e.type === 'finished') stats = e.stats
            },
            signal
          )
          if (content.trim()) out.texts.push(content)
          if (reasoning.trim()) out.thinking.push(reasoning)
          out.inputTokens += stats?.promptTokens ?? 0
          out.outputTokens += stats?.completionTokens ?? 0
          out.contextTokens = stats?.promptTokens ?? out.contextTokens
          if (!calls.length) {
            out.stoppedBecause = 'natural'
            break
          }

          messages.push({ role: 'assistant', content: content || null, tool_calls: toolCallsWire(calls as never) })
          for (const c of calls) {
            const args = parseArguments(c as never)
            noteToolCall(out, req.emit, c.name, args)
            let result: string
            try {
              result = await runTool(c.name, args)
            } catch (err) {
              result = `ERROR: ${describeError(err)}`
            }
            noteToolResult(out, req.emit, c.name, result)
            messages.push({ role: 'tool', tool_call_id: c.id, content: capText(result) })
          }
        }
      } catch (err) {
        if (!signal.aborted) out.error = (err as Error).message || String(err)
      }
      if (!out.stoppedBecause && !out.error) out.stoppedBecause = 'turns'
      return out
    }
  }
}
