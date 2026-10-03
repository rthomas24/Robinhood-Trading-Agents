/**
 * The Claude vendor gates OUR tools inside the in-process MCP server.
 *
 * Why this exists (2026-09-11): the vendor pre-approves `mcp__tb__*` in
 * `allowedTools` so the CLI never prompts, and the SDK auto-approves a bare
 * allowed name BEFORE consulting `canUseTool` — it warns so at startup
 * ("canUseTool will not be invoked for: mcp__tb__trade, …"). The gate for this
 * vendor lived in `canUseTool` and the tool server called each handler
 * directly, so the approval hold, the loop guard and the run-over refusal
 * never applied to our own tools on Claude: an "Ask me first" agent traded
 * without the tap. Now every call goes through `makeRunTool` (gate → validate
 * → dispatch → audit), the same path ChatGPT and Local use, whatever the CLI
 * decides about permissions.
 *
 * The contract, driven against a fake SDK that calls the server's tool
 * handlers the way the CLI would:
 *   1. a call the gate refuses never reaches the host; the model reads the
 *      refusal as the tool result and the thread records it as blocked;
 *   2. a call the gate allows reaches the host ONCE with the gate's (possibly
 *      rewritten) input, and after-tool bookkeeping runs ONCE — the PostToolUse
 *      hook must not run it a second time for our tools;
 *   3. the hook still does the bookkeeping for a REMOTE tool (those are not
 *      pre-approved and are not routed through our server);
 *   4. `allowedTools` names exactly our tools, so nothing else is pre-approved.
 *
 *   npm run check -- claude-gate
 */
import { z } from 'zod'
import { createClaudeRunner } from '@core/runner/vendors/claude'
import type { AgentSdk } from '@core/runner/types'
import type { VendorRunRequest, ToolGate } from '@core/runner/vendors/types'
import type { AgentToolDef, ToolHost } from '@core/runner/agentTools'

let failures = 0
const ok = (cond: boolean, msg: string): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}

/** What the fake CLI will do with the server: call this tool with these args. */
interface Drive {
  tool: string
  args: Record<string, unknown>
}

/**
 * A fake SDK: `tool` and `createSdkMcpServer` keep the handlers; `query` plays
 * the CLI — calls the driven tool's handler, then fires the PostToolUse hook
 * with the response the way the CLI does, then yields a success result.
 */
function fakeSdk(drive: Drive, captured: { result?: string; options?: Record<string, unknown> }): AgentSdk {
  return {
    tool: (name: string, description: string, shape: unknown, handler: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>) => ({ name, description, shape, handler }),
    createSdkMcpServer: (spec: { name: string; version: string; tools: Array<{ name: string; handler: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }> }> }) => spec,
    query: ({ options }: { options: Record<string, unknown> }) => {
      captured.options = options
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's1' }
        const servers = options.mcpServers as Record<string, { tools: Array<{ name: string; handler: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }> }> }>
        const server = servers.tb
        const t = server.tools.find((x) => x.name === drive.tool)!
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__tb__${drive.tool}`, input: drive.args }] } }
        const res = await t.handler(drive.args)
        captured.result = res.content[0].text
        const hooks = (options.hooks as { PostToolUse: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> }).PostToolUse
        for (const h of hooks) for (const fn of h.hooks) await fn({ tool_name: `mcp__tb__${drive.tool}`, tool_input: drive.args, tool_response: captured.result })
        yield { type: 'result', subtype: 'success', result: 'done', session_id: 's1', usage: { input_tokens: 10, output_tokens: 5 } }
      })()
    }
  } as unknown as AgentSdk
}

function makeReq(gate: ToolGate, tools: AgentToolDef[]): VendorRunRequest {
  return {
    model: { vendor: 'claude', id: 'claude-sonnet-5', effort: 'medium' },
    systemPrompt: 'sys',
    prompt: 'go',
    tools,
    host: {} as ToolHost,
    remote: [],
    gate,
    maxTurns: 4,
    resumeSessionId: null,
    cwd: process.cwd(),
    abort: new AbortController(),
    emit: () => undefined,
    log: () => undefined
  } as unknown as VendorRunRequest
}

async function main(): Promise<void> {
  let hostCalls = 0
  let hostArgs: unknown = null
  const trade: AgentToolDef = {
    name: 'trade',
    description: 'buy or sell',
    schema: z.object({ symbol: z.string(), qty: z.number().optional() }),
    run: async (args) => {
      hostCalls++
      hostArgs = args
      return 'FILLED BUY 1 MU'
    }
  } as unknown as AgentToolDef

  // ── 1. The gate refuses: nothing reaches the host, the refusal is the result ──
  {
    hostCalls = 0
    const vets: string[] = []
    const gate: ToolGate = {
      allow: () => true,
      vet: async (name) => {
        vets.push(name)
        return { ok: false, message: 'HELD: this agent asks first — the order is waiting for your tap.' }
      },
      afterTool: async () => undefined
    }
    const captured: { result?: string; options?: Record<string, unknown> } = {}
    const req = makeReq(gate, [trade])
    const out = await createClaudeRunner({ sdk: fakeSdk({ tool: 'trade', args: { symbol: 'MU', qty: 1 } }, captured) }).run(req)
    ok(vets.includes('mcp__tb__trade'), 'the gate is consulted for our tool by its full name')
    ok(hostCalls === 0, 'a refused call never reaches the host')
    ok((captured.result ?? '').startsWith('HELD:'), `the model reads the refusal as the tool result (${JSON.stringify(captured.result)})`)
    ok(out.toolCalls.some((c) => c.name === 'mcp__tb__trade' && Boolean(c.blocked)), 'the thread records the call as blocked')
    ok(!out.error, `the run itself is fine (${out.error ?? 'no error'})`)
  }

  // ── 2. The gate allows (and rewrites): host once, bookkeeping once ─────────
  {
    hostCalls = 0
    hostArgs = null
    const after: string[] = []
    const gate: ToolGate = {
      allow: () => true,
      vet: async (_name, input) => ({ ok: true, input: { ...input, qty: 2 } }),
      afterTool: async (name) => {
        after.push(name)
      }
    }
    const captured: { result?: string; options?: Record<string, unknown> } = {}
    const req = makeReq(gate, [trade])
    const out = await createClaudeRunner({ sdk: fakeSdk({ tool: 'trade', args: { symbol: 'MU', qty: 1 } }, captured) }).run(req)
    ok(hostCalls === 1, `an allowed call reaches the host exactly once (${hostCalls})`)
    ok((hostArgs as { qty?: number } | null)?.qty === 2, "the host receives the gate's rewritten input, not the model's")
    ok(captured.result === 'FILLED BUY 1 MU', 'the model reads the host result')
    ok(after.filter((n) => n === 'mcp__tb__trade').length === 1, `after-tool bookkeeping runs ONCE for our tool, not again in the PostToolUse hook (${after.length})`)
    ok(out.toolCalls.some((c) => c.name === 'mcp__tb__trade' && !c.blocked), 'the thread records the call as run')
    const allowed = (captured.options?.allowedTools as string[]) ?? []
    ok(allowed.length === 1 && allowed[0] === 'mcp__tb__trade', `allowedTools names exactly our tools (${JSON.stringify(allowed)})`)
  }

  // ── 3. A remote tool still gets its bookkeeping from the hook ───────────────
  {
    const after: string[] = []
    const gate: ToolGate = { allow: () => true, vet: async (_n, input) => ({ ok: true, input }), afterTool: async (name) => void after.push(name) }
    const captured: { result?: string; options?: Record<string, unknown> } = {}
    const req = makeReq(gate, [trade])
    await createClaudeRunner({ sdk: fakeSdk({ tool: 'trade', args: { symbol: 'MU' } }, captured) }).run(req)
    const hooks = (captured.options?.hooks as { PostToolUse: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> }).PostToolUse
    for (const h of hooks) for (const fn of h.hooks) await fn({ tool_name: 'mcp__robinhood__get_equity_quotes', tool_input: { symbols: ['MU'] }, tool_response: 'MU 100' })
    ok(after.includes('mcp__robinhood__get_equity_quotes'), 'a remote tool (not pre-approved, not ours) is book-kept by the PostToolUse hook')
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall good')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
