/**
 * The thread keeps the WHOLE tool call, bounded — and reads it back in words.
 *
 * Before 2026-09-07 a tool call reached the thread as 200 characters of input
 * and 300 of output, cut mid-word, behind a "1 tool call" toggle. This pins the
 * new record (`ToolCallSummary.args` / `.result` / `.blocked` / `.durationMs`)
 * and its caps, the shared recorder's behaviour at every vendor seam, and the
 * pure display helpers that turn `mcp__robinhood__get_equity_quotes` into
 * "Quotes · NVDA, MU".
 *
 * Run: `npm run check -- tool-detail`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RunDelta } from '@shared/ipc'
import { emptyResult, noteToolBlocked, noteToolCall, noteToolResult, resultText, TOOL_ARGS_MAX_BYTES, TOOL_DETAIL_BUDGET_BYTES, TOOL_RESULT_MAX_BYTES, truncateBytes } from '@core/runner/vendors/shared'
import { describeToolCall, formatDuration, parseToolResult, serverLabel, splitToolName, tabularRows, toolKind } from '../../src/renderer/src/lib/toolDisplay'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ── the recorder ─────────────────────────────────────────────────────────── */

const deltas: RunDelta[] = []
const emit = (d: RunDelta): void => void deltas.push(d)
const out = emptyResult()

const entry = noteToolCall(out, emit, 'mcp__robinhood__get_equity_quotes', { symbols: ['NVDA', 'MU'] })
check('a call keeps its full arguments as the object itself', JSON.stringify(entry.args) === JSON.stringify({ symbols: ['NVDA', 'MU'] }) && typeof entry.startedAt === 'string')
check('the short input still streams for older clients', deltas[0]?.kind === 'tool' && entry.input.includes('NVDA'))

const quotes = { content: [{ type: 'text', text: JSON.stringify({ results: [{ symbol: 'NVDA', last: '187.52' }, { symbol: 'MU', last: '121.10' }] }) }] }
noteToolResult(out, emit, 'mcp__robinhood__get_equity_quotes', quotes)
check('an MCP content envelope is unwrapped to its text', entry.result !== undefined && entry.result.startsWith('{"results"') && !entry.result.includes('"content"'))
check('the duration is measured from the call', typeof entry.durationMs === 'number' && entry.durationMs >= 0)
check('a normal result is neither blocked nor an error', !entry.blocked && !entry.error && !entry.truncated)
check('the short output still streams', deltas.some((d) => d.kind === 'tool_result'))

const big = noteToolCall(out, emit, 'mcp__webvector__fetch', { url: 'https://example.com/x?apikey=SECRET123' })
noteToolResult(out, emit, 'mcp__webvector__fetch', 'a'.repeat(TOOL_RESULT_MAX_BYTES + 5_000))
check('a result past the per-call cap is cut and marked truncated', big.result !== undefined && big.result.length === TOOL_RESULT_MAX_BYTES && big.truncated === true)

const errCall = noteToolCall(out, emit, 'mcp__tb__trade', { side: 'buy', symbol: 'NVDA', qty: 10 })
noteToolResult(out, emit, 'mcp__tb__trade', 'ERROR: fetch failed (ECONNREFUSED)')
check('an ERROR: result is flagged as an error', errCall.error === true && errCall.result?.startsWith('ERROR:') === true)

const mcpErr = noteToolCall(out, emit, 'mcp__robinhood__get_equity_orders', {})
noteToolResult(out, emit, 'mcp__robinhood__get_equity_orders', { isError: true, content: [{ type: 'text', text: 'unauthorized' }] })
check('an MCP isError result is flagged as an error', mcpErr.error === true && mcpErr.result === 'unauthorized')

const before = out.toolCalls.length
const streamed = deltas.length
noteToolBlocked(out, emit, 'mcp__tb__trade', { side: 'buy', symbol: 'TSLA', qty: 1 }, 'Held back by the daily order cap (6/6).')
const blocked = out.toolCalls[out.toolCalls.length - 1]
check('a gate refusal is recorded as a call with the verdict where the result would be', out.toolCalls.length === before + 1 && blocked.blocked === 'Held back by the daily order cap (6/6).' && blocked.output !== undefined && !blocked.error)
check('the refusal streams once (a tool and a tool_result delta), not twice', deltas.length === streamed + 2)
const after = deltas.length
noteToolResult(out, emit, 'mcp__tb__trade', 'Held back by the daily order cap (6/6).')
check("the tool loop's own note of the same refusal is a no-op (no second row, no second delta)", out.toolCalls.length === before + 1 && deltas.length === after)

const hugeArgs = noteToolCall(out, emit, 'mcp__tb__remember', { note: 'x'.repeat(TOOL_ARGS_MAX_BYTES * 2) })
check('oversized arguments are kept as cut JSON and marked truncated', typeof hugeArgs.args === 'string' && hugeArgs.truncated === true && Buffer.byteLength(hugeArgs.args) <= TOOL_ARGS_MAX_BYTES)

// The per-run budget: past it, later calls keep only the short output.
const budgetOut = emptyResult()
const perCall = TOOL_RESULT_MAX_BYTES
const n = Math.ceil(TOOL_DETAIL_BUDGET_BYTES / perCall) + 2
for (let i = 0; i < n; i++) {
  noteToolCall(budgetOut, () => undefined, 'mcp__robinhood__get_equity_quotes', { i })
  noteToolResult(budgetOut, () => undefined, 'mcp__robinhood__get_equity_quotes', 'q'.repeat(perCall))
}
const kept = budgetOut.toolCalls.reduce((s, c) => s + (c.result ? Buffer.byteLength(c.result) : 0), 0)
const lastCall = budgetOut.toolCalls[budgetOut.toolCalls.length - 1]
check('the run-wide detail budget holds', kept <= TOOL_DETAIL_BUDGET_BYTES && (budgetOut.toolDetailBytes ?? 0) <= TOOL_DETAIL_BUDGET_BYTES, `${kept} bytes over ${n} calls`)
check('a call past the budget keeps its short output and says it was cut', lastCall.result === undefined && lastCall.output !== undefined && lastCall.truncated === true)

check('resultText: a plain string is itself', resultText('hello') === 'hello')
check('resultText: an object is compact JSON', resultText({ a: 1 }) === '{"a":1}')
const cut = truncateBytes('héllo wörld', 3)
check('truncateBytes never splits a character', cut.cut && cut.text === 'hé')

/* ── the vendor seams (source contracts) ──────────────────────────────────── */

const src = (p: string): string => readFileSync(resolve(import.meta.dirname, '../../', p), 'utf8')
check('OpenRouter records a gate refusal (the SDK never runs a blocked tool)', /noteToolBlocked\(out, req\.emit, toolName, toolInput, v\.message\)/.test(src('src/core/runner/vendors/openrouter.ts')))
check('Claude records a gate refusal in canUseTool (a denied tool never reaches PostToolUse)', /noteToolBlocked\(out, req\.emit, toolName, input, v\.message\)/.test(src('src/core/runner/vendors/claude.ts')))
check('ChatGPT and Local route refusals through makeRunTool’s onBlocked', /makeRunTool\(req, ours, remoteTools, \(name, args, message\) => noteToolBlocked/.test(src('src/core/runner/vendors/chatgpt.ts')) && /makeRunTool\(req, ours, remoteTools, \(name, args, message\) => noteToolBlocked/.test(src('src/core/runner/vendors/local.ts')))
check('the thread keeps more than a page of reasoning', /THINKING_KEEP_CHARS = 16_000/.test(src('src/core/runner/runOnce.ts')))
check('ToolCallSummary’s new fields are all optional (older rows and clients keep working)', /args\?: unknown\s+result\?: string\s+truncated\?: boolean/.test(src('src/shared/agents.ts')) && /blocked\?: string/.test(src('src/shared/agents.ts')))

/* ── the display helpers ──────────────────────────────────────────────────── */

check('splitToolName: mcp__robinhood__get_equity_quotes', JSON.stringify(splitToolName('mcp__robinhood__get_equity_quotes')) === JSON.stringify({ server: 'robinhood', tool: 'get_equity_quotes' }))
check('splitToolName: a bare name has no server', splitToolName('report').server === null)
check('serverLabel: tb is Engine, robinhood is Robinhood, providers by name', serverLabel('tb') === 'Engine' && serverLabel('robinhood') === 'Robinhood' && serverLabel('webvector') === 'WebVector')
check('toolKind: trades, quotes, research, memory, report', toolKind('mcp__tb__trade') === 'trade' && toolKind('mcp__robinhood__get_equity_quotes') === 'market' && toolKind('mcp__webvector__webvector_search') === 'research' && toolKind('mcp__tb__remember') === 'memory' && toolKind('mcp__tb__report') === 'report')

const q = describeToolCall({ name: 'mcp__robinhood__get_equity_quotes', input: '', args: { symbols: ['NVDA', 'MU', 'AMD'] } })
check('a quotes call reads as "Quotes · NVDA, MU, AMD"', q.title === 'Quotes · NVDA, MU, AMD', q.title)
const t = describeToolCall({ name: 'mcp__tb__trade', input: '', args: { side: 'buy', symbol: 'NVDA', qty: 10, orderType: 'limit', limitPrice: 180, stopLoss: 170 } })
check('a trade reads as the order it is', t.title === 'Buy 10 NVDA' && t.detail === 'limit $180 · stop $170', `${t.title} / ${t.detail}`)
const w = describeToolCall({ name: 'mcp__tb__watch_price', input: '', args: { symbol: 'MU', condition: 'above', level: 125 } })
check('a watch reads as its level', w.title === 'Watch MU ≥$125', w.title)
const r = describeToolCall({ name: 'mcp__tb__report', input: '', args: { headline: 'Closed — book carried over' } })
check('a report call names its headline', r.title === 'File the run report' && r.detail === 'Closed — book carried over')
const s = describeToolCall({ name: 'mcp__webvector__webvector_search', input: '', args: { query: 'NVDA earnings date' } })
check('a web search shows its query', s.title === 'Search' && s.detail === '“NVDA earnings date”', `${s.title} / ${s.detail}`)
const legacy = describeToolCall({ name: 'mcp__robinhood__get_equity_quotes', input: '{"symbols":["NVDA"]}' })
check('a row with no args still gets a label, never the wire name', legacy.title === 'Quotes')

check('parseToolResult: JSON parses, prose stays prose, JSON + truncation notice stays text', parseToolResult('{"a":1}').kind === 'json' && parseToolResult('Filled 10 NVDA').kind === 'text' && parseToolResult('{"a":1}\n\n[Truncated: …]').kind === 'text')
const table = tabularRows([
  { symbol: 'NVDA', last: '187.52', bid: '187.50' },
  { symbol: 'MU', last: '121.10', bid: '121.05' }
])
check('a list of flat objects becomes a table with the union of keys', table !== null && table.columns.join() === 'symbol,last,bid' && table.rows.length === 2)
check('a list of nested objects is not forced into a table', tabularRows([{ a: { b: 1 }, c: { d: 2 } }, { a: { b: 3 }, c: { d: 4 } }]) === null)
check('formatDuration: ms, s, min', formatDuration(340) === '340 ms' && formatDuration(4_200) === '4.2 s' && formatDuration(61_000) === '1m 1s')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
