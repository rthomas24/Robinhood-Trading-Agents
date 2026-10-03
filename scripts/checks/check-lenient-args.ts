/**
 * A model that types `"5"` instead of `5` must not lose its tool call — and
 * must never be guessed at when the guess could be a wrong trade.
 *
 * Every vendor validates arguments against `AgentToolDef.schema`: the Claude
 * runner through `t.schema.shape`, the OpenRouter SDK through `inputSchema`
 * (`tool-executor.js` validates BEFORE `execute`), the ChatGPT and Local
 * runners through `safeParse`. So the coercion lives in the schema itself and
 * is enforced once for all four.
 *
 * Three things here would each silently undo the fix, and none is visible by
 * reading the schema:
 *
 *   1. `side` coercing. Repairing `qty` is unambiguous; guessing buy-vs-sell is
 *      a wrong trade. The rule is by FIELD TYPE, not by tool kind, so that a
 *      write tool added later cannot quietly opt into something looser.
 *   2. The advertised JSON Schema widening. If `z.preprocess` erased the
 *      `type`/`enum`/bounds the model is shown, we would be *causing* the
 *      sloppiness we set out to absorb. Asserted against a plain schema.
 *   3. `.shape` disappearing. `vendors/claude.ts:23` passes `t.schema.shape`,
 *      and a `ZodPipe` has none — wrapping the OBJECT rather than the FIELD
 *      would break that vendor at construction, before any argument is parsed.
 *
 * Run: `npm run check -- lenient-args`
 */
import { z } from 'zod'
import { AGENT_TOOLS } from '@core/runner/agentTools'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const tool = (n: string): (typeof AGENT_TOOLS)[number] => {
  const t = AGENT_TOOLS.find((x) => x.name === n)
  if (!t) throw new Error(`no tool "${n}"`)
  return t
}
const trade = tool('trade')
const parse = (n: string, args: Record<string, unknown>): z.ZodSafeParseResult<unknown> => tool(n).schema.safeParse(args)

// ── the representation is repaired ─────────────────────────────────────────
const q = parse('trade', { symbol: 'MU', side: 'buy', qty: '5', reason: 'r' })
check('qty "5" is accepted', q.success, q.success ? '' : q.error.issues[0].message)
check('...and arrives as the number 5', q.success && (q.data as { qty: number }).qty === 5, q.success ? String((q.data as { qty: number }).qty) : '')

const money = parse('trade', { symbol: 'MU', side: 'sell', notional: '$1,250.50', reason: 'r' })
check('a model formatting money as prose ("$1,250.50") is understood', money.success && (money.data as { notional: number }).notional === 1250.5, money.success ? String((money.data as { notional: number }).notional) : '')

const up = parse('trade', { symbol: 'MU', side: 'buy', qty: 1, type: 'LIMIT', limitPrice: 10, reason: 'r' })
check('an enum in the wrong case is matched', up.success && (up.data as { type: string }).type === 'limit', up.success ? (up.data as { type: string }).type : '')

const b = parse('set_exit', { symbol: 'MU', clear: 'true' })
check('a boolean sent as "true" is a boolean', b.success && (b.data as { clear: boolean }).clear === true)
check('...and as 1', (() => { const r = parse('set_exit', { symbol: 'MU', clear: 1 }); return r.success && (r.data as { clear: boolean }).clear === true })())

// ── leniency is not permissiveness ─────────────────────────────────────────
// Only the REPRESENTATION is repaired. The inner schema still decides.
check('"abc" is still not a number', parse('trade', { symbol: 'MU', side: 'buy', qty: 'abc', reason: 'r' }).success === false)
check('"-5" is still not a positive quantity', parse('trade', { symbol: 'MU', side: 'buy', qty: '-5', reason: 'r' }).success === false)
check('an unknown enum value is still refused', parse('trade', { symbol: 'MU', side: 'buy', qty: 1, type: 'iceberg', reason: 'r' }).success === false)
check('an empty string is not zero', parse('trade', { symbol: 'MU', side: 'buy', qty: '', reason: 'r' }).success === false)

// ── the one field that must never be guessed ───────────────────────────────
// This is the whole safety argument for the feature. If it ever goes green on
// a coerced value, the rule has been widened by someone who did not read it.
// The first draft of this loop omitted the required `reason`, so every case
// failed validation for THAT reason and the assertions passed green while
// proving nothing about `side` at all. Assert the failing PATH, not just that
// something failed.
for (const bad of ['BUY', 'Buy', ' buy', 'buy ', 'b']) {
  const r = parse('trade', { symbol: 'MU', side: bad, qty: 1, reason: 'r' })
  check(`side "${bad}" is REFUSED, never guessed`, r.success === false)
  check(`...and it is SIDE that refused it`, r.success === false && r.error.issues.some((i) => i.path[0] === 'side'), r.success ? '' : JSON.stringify(r.error.issues.map((i) => i.path.join('.'))))
}
check('side "buy" exactly is of course fine', parse('trade', { symbol: 'MU', side: 'buy', qty: 1, reason: 'r' }).success)
check('side "sell" exactly is fine', parse('trade', { symbol: 'MU', side: 'sell', qty: 1, reason: 'r' }).success)

// ── the model must still be TOLD what to send ──────────────────────────────
// A coercion that widened the advertised schema to `any` would cause the very
// sloppiness it absorbs. Compare against a hand-written plain equivalent.
const shown = z.toJSONSchema(trade.schema, { target: 'draft-7', io: 'input' }) as {
  properties: Record<string, { type?: string; enum?: string[]; description?: string; exclusiveMinimum?: number }>
}
check('qty is still advertised as a number', shown.properties.qty?.type === 'number', JSON.stringify(shown.properties.qty))
check('...with its bound intact', shown.properties.qty?.exclusiveMinimum === 0)
check('...and its description intact', typeof shown.properties.qty?.description === 'string' && shown.properties.qty.description.length > 0)
check('type still advertises its enum list', JSON.stringify(shown.properties.type?.enum) === JSON.stringify(['market', 'limit']), JSON.stringify(shown.properties.type))
check('side still advertises its enum list', JSON.stringify(shown.properties.side?.enum) === JSON.stringify(['buy', 'sell']))

// ── every vendor must still be able to BUILD its tools ─────────────────────
// `vendors/claude.ts:23` reads `t.schema.shape`. Wrapping the object rather
// than the field removes it, and the failure is at construction — every Claude
// run, before a single argument is seen.
for (const t of AGENT_TOOLS) {
  const shape = (t.schema as { shape?: Record<string, unknown> }).shape
  check(`${t.name}: .shape survives (claude.ts reads it)`, !!shape && Object.keys(shape).length > 0)
}
// And the JSON-Schema conversion the other three vendors do must not throw.
for (const t of AGENT_TOOLS) {
  let ok = true
  try {
    z.toJSONSchema(t.schema, { target: 'draft-7', io: 'input' })
  } catch {
    ok = false
  }
  check(`${t.name}: converts to JSON Schema (chatgpt/local/openrouter)`, ok)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
