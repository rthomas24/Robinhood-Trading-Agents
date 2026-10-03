/**
 * Two bounds on what a failing or slow tool costs a run.
 *
 * PER-TOOL STALL BUDGET. A WebVector
 * `research` call fetches and summarises several pages; a quote returns in
 * under a second. One flat budget is either too tight for the first or useless
 * for the second — so research is RAISED, and nothing is lowered. Shortening a
 * budget does not make a slow tool faster, it kills a tool that was working,
 * and we have no measured durations yet to lower it against.
 *
 * The collision is the part worth pinning: `search` is BOTH a WebVector tool
 * and a Robinhood symbol lookup. A budget keyed on the bare tool name would
 * hand Robinhood's fast lookup the slow tool's budget — harmless here because
 * this only ever raises, but the same mistake on a table that lowers would
 * abort a working call, and nothing in a name says which server it came from.
 *
 * ERROR TEXT. `(err as Error).message` is often the least
 * informative line in the chain: Node reports a refused socket as `fetch
 * failed` and hides `ECONNREFUSED` in `.cause`. A model told only "fetch
 * failed" retries the identical call.
 *
 * Run: `npm run check -- tool-budgets`
 */
import { toolStallBudget, RUN_TIMEOUT_MS } from '@core/runner/runOnce'
import { describeError } from '@core/runner/vendors/shared'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const DEFAULT = toolStallBudget('mcp__tb__trade')

// ── the slow ones are raised ───────────────────────────────────────────────
for (const t of ['research', 'fetch', 'search', 'markets']) {
  check(`webvector ${t} gets the long budget`, toolStallBudget(`mcp__webvector__${t}`) > DEFAULT, `${toolStallBudget(`mcp__webvector__${t}`)}ms vs ${DEFAULT}ms`)
}

// ── and nothing else is ────────────────────────────────────────────────────
// `search` is the collision: same bare name, different server, different speed.
check('robinhood search keeps the DEFAULT budget', toolStallBudget('mcp__robinhood__search') === DEFAULT, `${toolStallBudget('mcp__robinhood__search')}ms — keyed on server, not bare name`)
check('robinhood get_equity_quotes keeps the default', toolStallBudget('mcp__robinhood__get_equity_quotes') === DEFAULT)
check('our own tools keep the default', toolStallBudget('mcp__tb__set_exit') === DEFAULT)
check('an unknown server keeps the default', toolStallBudget('mcp__whatever__research') === DEFAULT, 'a server we have never heard of is not assumed slow')
check('a malformed name keeps the default', toolStallBudget('not_a_tool') === DEFAULT)
check('no tool at all keeps the default', toolStallBudget(null) === DEFAULT && toolStallBudget('') === DEFAULT, 'the watchdog must never get NaN')

// ── nothing may outlive the run itself ─────────────────────────────────────
// A tool budget above the run ceiling is a number that can never be reached.
for (const n of ['mcp__webvector__research', 'mcp__robinhood__search', 'mcp__tb__trade']) {
  check(`${n} stays under the run ceiling`, toolStallBudget(n) < RUN_TIMEOUT_MS, `${toolStallBudget(n)}ms < ${RUN_TIMEOUT_MS}ms`)
}

// ── the error text a tool failure hands the model ──────────────────────────
const wrapped = new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8905') })
const d = describeError(wrapped)
check('the wrapper is reported', d.includes('fetch failed'), d)
check('...AND the cause, which is the useful half', d.includes('ECONNREFUSED'), d)

const repeated = new Error('boom', { cause: new Error('boom', { cause: new Error('boom') }) })
check('a message repeated down the chain is said ONCE', describeError(repeated) === 'boom', describeError(repeated))

// A cycle must not hang the run. `a.cause = b; b.cause = a` is reachable
// through AggregateError children that share a cause.
const a = new Error('a') as Error & { cause?: unknown }
const b = new Error('b') as Error & { cause?: unknown }
a.cause = b
b.cause = a
const cyc = describeError(a)
check('a cause CYCLE terminates', cyc.includes('a') && cyc.includes('b'), cyc)

const agg = new AggregateError([new Error('first'), new Error('second')], 'all failed')
const da = describeError(agg)
check('AggregateError siblings are included', da.includes('first') && da.includes('second'), da)

const huge = describeError(new Error('x'.repeat(50_000)))
check('one enormous message cannot dominate the context', huge.length < 2_000, `${huge.length} chars`)
check('...and says it was cut', huge.endsWith('…'))

check('a non-Error throw still says something', describeError('just a string') === 'just a string')
check('an empty throw degrades rather than reading oddly', describeError(undefined) === 'unknown error', describeError(undefined))
check('an Error with no message falls back to its name', describeError(new TypeError()) === 'TypeError', describeError(new TypeError()))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
