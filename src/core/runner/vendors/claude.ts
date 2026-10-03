import { TB_SERVER_NAME, type AgentToolDef } from '../agentTools'
import type { AgentSdk } from '../types'
import { afterToolCall, capToolOutput, emptyResult, gateToolCall, makeRunTool, MAX_TOOL_OUTPUT_BYTES, noteToolBlocked, noteToolResult, noteToolCall } from './shared'
import type { ModelVendorRunner, VendorRunRequest, VendorRunResult } from './types'

/**
 * Claude vendor: the Claude Agent SDK (the user's own Claude subscription via
 * Claude Code's login). Our tools become an in-process MCP server built from
 * the SAME SDK instance `query()` runs on; remote MCP servers pass straight
 * through; the gate runs in `canUseTool` + the PostToolUse hook. Sessions are
 * resumed for prompt-cache reuse.
 */
export interface ClaudeRunnerOptions {
  sdk: AgentSdk
  /** Extra env for the SDK subprocess (e.g. CLAUDE_CONFIG_DIR). */
  env?: () => Record<string, string | undefined> | undefined
  /** Override the bundled CLI path (dev). */
  cliPath?: string
}

/**
 * Our tools as an in-process MCP server. Every call goes through `runTool` —
 * the ONE gate → validate → dispatch → audit path (`makeRunTool`), the same
 * one the ChatGPT and Local vendors use — NOT straight to the handler.
 *
 * It used to call `t.run()` directly and rely on `canUseTool` for the gate.
 * But these names are in `allowedTools` (so the CLI never prompts), and the
 * SDK auto-approves a bare allowed name BEFORE consulting `canUseTool` — it
 * says so itself, at startup: "canUseTool will not be invoked for:
 * mcp__tb__trade, …". So on this vendor the approval hold, the loop guard and
 * the run-over refusal never applied to our own tools; an "Ask me first"
 * agent on Claude would have traded without the tap. Gating
 * inside the tool is immune to how the CLI resolves permissions.
 */
function buildTbServer(sdk: AgentSdk, tools: AgentToolDef[], runTool: (name: string, args: Record<string, unknown>) => Promise<string>): ReturnType<AgentSdk['createSdkMcpServer']> {
  const ok = (text: string): { content: Array<{ type: 'text'; text: string }> } => ({ content: [{ type: 'text' as const, text }] })
  const sdkTools = tools.map((t) =>
    sdk.tool(t.name, t.description, t.schema.shape, async (args: unknown) => ok(await runTool(`mcp__${TB_SERVER_NAME}__${t.name}`, (args && typeof args === 'object' ? args : {}) as Record<string, unknown>)))
  )
  return sdk.createSdkMcpServer({ name: TB_SERVER_NAME, version: '0.1.0', tools: sdkTools })
}

export function createClaudeRunner(opts: ClaudeRunnerOptions): ModelVendorRunner {
  const { sdk } = opts
  return {
    vendor: 'claude',
    async run(req: VendorRunRequest): Promise<VendorRunResult> {
      const out = emptyResult(req.resumeSessionId)
      // Our tools, keyed by the name the model calls them by — the gate and the
      // audit speak that name on every vendor.
      const ours = new Map<string, AgentToolDef>()
      for (const t of req.tools) ours.set(`mcp__${TB_SERVER_NAME}__${t.name}`, t)
      const runTool = makeRunTool(req, ours, new Map(), (name, args, message) => noteToolBlocked(out, req.emit, name, args, message))
      const tbServer = buildTbServer(sdk, req.tools, runTool)
      const mcpServers: Record<string, unknown> = { [tbServer.name]: tbServer }
      for (const r of req.remote) mcpServers[r.name] = r.spec
      // Pre-approved so the CLI never prompts for them; the SDK then skips
      // `canUseTool` for these names, which is why they are gated INSIDE the
      // server (`buildTbServer`). Everything else (Robinhood, intel MCPs) is
      // not pre-approved and still comes through `canUseTool` below.
      const allowedTools = [...ours.keys()]

      // The ONLY seam on this vendor. Remote MCP servers are handed to the SDK
      // as specs (`mcpServers[r.name] = r.spec`) and it owns the call, so an
      // unbounded WebVector or EDGAR result would otherwise reach the model
      // with nothing of ours in between. `updatedToolOutput` — "replaces the
      // tool output before it is sent to the model" — is that in-between.
      //
      // Returned ONLY when the cap actually bit. The SDK documents parallel
      // hooks racing last-write-wins on the original output, so an identity
      // rewrite returned on every call is not free: it is a write that can
      // clobber another hook's real one. Nothing else rewrites today; saying
      // nothing when there is nothing to say keeps it that way.
      const postToolUse = [
        {
          hooks: [
            async (input: unknown): Promise<Record<string, unknown>> => {
              const i = input as { tool_name?: string; tool_input?: unknown; tool_response?: unknown }
              if (!i.tool_name) return {}
              noteToolResult(out, req.emit, i.tool_name, i.tool_response)
              const inp = (i.tool_input && typeof i.tool_input === 'object' ? i.tool_input : {}) as Record<string, unknown>
              // Our own tools already ran the after-tool bookkeeping inside
              // `runTool`; running it again here would count every call twice.
              if (!ours.has(i.tool_name)) await afterToolCall(req.gate, req.log, i.tool_name, inp, i.tool_response)
              const capped = capToolOutput(i.tool_response)
              if (capped === i.tool_response) return {}
              req.log('info', `tool ${i.tool_name}: result capped at ${MAX_TOOL_OUTPUT_BYTES} bytes`)
              return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: capped } }
            }
          ]
        }
      ]
      const env = opts.env?.()
      try {
        const stream = sdk.query({
          prompt: req.prompt,
          options: {
            model: req.model.id,
            systemPrompt: req.systemPrompt,
            mcpServers: mcpServers as never,
            allowedTools,
            tools: [],
            permissionMode: 'default',
            maxTurns: req.maxTurns,
            effort: req.model.effort,
            ...(req.resumeSessionId ? { resume: req.resumeSessionId } : {}),
            settingSources: [],
            cwd: req.cwd,
            ...(env ? { env } : {}),
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              const v = await gateToolCall(req.gate, toolName, input)
              if (v.ok) return { behavior: 'allow' as const, updatedInput: v.input }
              // A denied tool never reaches PostToolUse, so this is the only
              // place the thread can learn the call was refused, and why.
              noteToolBlocked(out, req.emit, toolName, input, v.message)
              return { behavior: 'deny' as const, message: v.message }
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            hooks: { PostToolUse: postToolUse } as any,
            abortController: req.abort,
            ...(opts.cliPath ? { pathToClaudeCodeExecutable: opts.cliPath } : {})
          }
        })
        for await (const message of stream) {
          const msg = message as { type?: string; subtype?: string }
          if (msg.type === 'system' && msg.subtype === 'init') {
            const sid = (message as { session_id?: string }).session_id
            if (sid) out.sessionId = sid
            continue
          }
          if (msg.type === 'assistant') {
            const blocks = (message as { message?: { content?: unknown[] } }).message?.content ?? []
            for (const block of blocks) {
              const b = block as { type?: string; text?: string; thinking?: string; name?: string; input?: unknown }
              if (b.type === 'text' && b.text) {
                out.texts.push(b.text)
                req.emit({ kind: 'text', text: b.text })
              } else if (b.type === 'thinking' && b.thinking) {
                out.thinking.push(b.thinking)
                req.emit({ kind: 'thinking', text: b.thinking })
              } else if (b.type === 'tool_use' && b.name) noteToolCall(out, req.emit, b.name, b.input)
            }
            continue
          }
          if (msg.type === 'result') {
            const r = message as {
              subtype?: string
              is_error?: boolean
              result?: string
              session_id?: string
              total_cost_usd?: number
              usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
            }
            if (r.session_id) out.sessionId = r.session_id
            if (typeof r.total_cost_usd === 'number') out.costUsd = r.total_cost_usd
            out.inputTokens = r.usage?.input_tokens ?? 0
            out.outputTokens = r.usage?.output_tokens ?? 0
            out.contextTokens = (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0)
            // A turn limit is a CUT-OFF, not a failure. The SDK reports it as
            // `error_max_turns`, which used to land in `out.error` and be
            // indistinguishable from a crash — so the desktop's flagship vendor
            // was the one that never produced the "this run stopped early,
            // check the position it opened is protected" note, and nothing said
            // so because the field was optional.
            if (r.subtype === 'error_max_turns') out.stoppedBecause = 'turns'
            else if ((r.subtype && r.subtype !== 'success') || r.is_error) out.error = (typeof r.result === 'string' && r.result.trim()) || r.subtype || 'run failed'
          }
        }
      } catch (err) {
        out.error = (err as Error).message || String(err)
      }
      return out
    }
  }
}
