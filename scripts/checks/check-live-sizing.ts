/**
 * Live sizing, lenient free-text arguments, and the stale approved pass — the
 * three ways a live agent can end up buying nothing, pinned.
 *
 *   1. A regular-session MARKET order for $100 of a $650 name is placed
 *      fractionally by the executor (Robinhood accepts dollar/fractional market
 *      orders in the regular session — docs/ARCHITECTURE.md), so the guardrail
 *      must not refuse it as "less than one share". An agent that reads that
 *      refusal concludes "no fractional fills" and never buys anything.
 *   2. Free-text tool arguments are clipped, never refused: a `report` or
 *      `remember` call thrown away for a string a few characters over its bound
 *      costs the run its card and an extra model turn.
 *   3. An approved pass is spent by a decision, not only by an execution, and an
 *      agent made fully autonomous drops any open card at run start.
 *
 * Run: `npm run check -- live-sizing`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkGuardrails } from '../../src/core/broker/guardrails'
import { headroomBlock } from '../../src/core/runner/prompts'
import { AGENT_TOOLS } from '../../src/core/runner/agentTools'
import { RUN_TIMEOUT_MS } from '../../src/core/runner/runOnce'
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig } from '../../src/shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const R = join(import.meta.dirname, '..', '..')
const read = (p: string): string => readFileSync(join(R, p), 'utf8').replace(/\r\n/g, '\n')

// ------------------------------------------------ 1. live sizing = the executor's
const live: AgentConfig = {
  id: 'ag_live',
  name: 'Momentum Sprint',
  icon: 'plasma',
  color: 'pink',
  task: 'press momentum',
  schedule: { kind: 'interval', everyMinutes: 10, marketHoursOnly: true },
  guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 100, maxPositionNotional: 200, allowedSymbols: [] },
  mode: 'live',
  model: { vendor: 'openrouter', id: 'x', effort: 'medium' },
  allocationUsd: 400,
  liveArmedAt: '2026-09-08T21:39:05Z',
  retirement: null,
  autonomous: true,
  createdAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:00Z'
} as unknown as AgentConfig
const state = initialState(live)
/** Wed 2026-09-09 10:00 ET — regular session. */
const OPEN = new Date('2026-09-09T14:00:00Z')
/** Same day, 17:30 ET — extended hours. */
const AFTER = new Date('2026-09-09T21:30:00Z')

const meta = (intent: Record<string, unknown>, now = OPEN) => checkGuardrails({ config: live, state, intent: { symbol: 'META', side: 'buy', tif: 'day', reason: 'check', ...intent } as never, refPrice: 650.1, now })
const m1 = meta({ type: 'market', notional: 100 })
check('a $100 regular-session MARKET buy of a $650 name is ALLOWED for a live agent (fractional)', m1.ok, m1.ok ? '' : `${m1.rule}: ${m1.reason}`)
const l1 = meta({ type: 'limit', notional: 100, limitPrice: 650 })
check('the same size as a LIMIT order is refused — whole shares', !l1.ok && l1.rule === 'size.belowOneShare')
check('...and the refusal says what to do instead (a market order)', !l1.ok && /MARKET order in the regular session may be fractional/.test(l1.reason ?? ''))
const ext = checkGuardrails({ config: { ...live, guardrails: { ...live.guardrails, marketHoursOnly: false, allowExtendedHours: true } }, state, intent: { symbol: 'META', side: 'buy', tif: 'day', reason: 'check', type: 'limit', limitPrice: 650, notional: 100 } as never, refPrice: 650.1, now: AFTER })
check('outside the regular session it is whole shares whatever the type', !ext.ok && ext.rule === 'size.belowOneShare')
const paper = checkGuardrails({ config: { ...live, mode: 'paper' }, state: initialState(live), intent: { symbol: 'META', side: 'buy', tif: 'day', reason: 'check', type: 'limit', limitPrice: 650, notional: 100 } as never, refPrice: 650.1, now: OPEN })
check('paper is unchanged: fractional either way', paper.ok, paper.ok ? '' : `${paper.rule}`)
const whole = meta({ type: 'limit', qty: 1, limitPrice: 650 })
check('a whole-share live limit order is refused only by caps, never by sizing', !whole.ok ? whole.rule !== 'size.belowOneShare' : true, whole.ok ? 'ok' : whole.rule)

// The prompt states the rule before the agent tries.
const head = headroomBlock(live, state, [{ symbol: 'META', last: 650.1, prevClose: 640, changePct: 1.4, ts: OPEN.toISOString() }, { symbol: 'AMD', last: 524, prevClose: 500, changePct: 4.8, ts: OPEN.toISOString() }] as never, 0, OPEN, 'cash')
check('HEADROOM tells a live agent that regular-session market orders may be fractional', /MARKET order in the regular session may be a FRACTIONAL share/.test(head))
check('...names the symbols a limit order could not buy under the cap', /META \$650, AMD \$524/.test(head), head.split('\n').find((l) => /LIVE sizing/.test(l)) ?? '')
check('...and tells it not to ask for a cap raise for this', /do not ask the operator to raise the cap/.test(head))
const paperHead = headroomBlock({ ...live, mode: 'paper' }, state, [], 0, OPEN, 'cash')
check('a paper agent is not told about live sizing', !/LIVE sizing/.test(paperHead))

// ------------------------------------------------ 2. free text is clipped, never refused
const parse = (tool: string, args: unknown) => AGENT_TOOLS.find((t) => t.name === tool)!.schema.safeParse(args)
const long = (n: number): string => 'x'.repeat(n)
const rep = parse('report', { headline: long(150), status: 'held', facts: [{ label: long(30), value: long(60), delta: long(40) }], next: long(200), details: long(700) })
check('a report with every string over its bound is ACCEPTED', rep.success, rep.success ? '' : rep.error.issues.map((i) => i.path.join('.')).join(','))
check('...clipped to the advertised bounds', rep.success && (rep.data as { headline: string; next: string; details: string; facts: { label: string; value: string; delta: string }[] }).headline.length === 100 && (rep.data as { next: string }).next.length === 120 && (rep.data as { details: string }).details.length === 500 && (rep.data as { facts: { value: string }[] }).facts[0].value.length === 48)
check('a 250-character memory note is kept (clipped), in both forms', parse('remember', { note: long(250) }).success && parse('remember', { notes: [long(250), long(10)] }).success)
check('a long thesis is kept', parse('set_thesis', { symbol: 'META', thesis: long(300) }).success && parse('set_thesis', { theses: [{ symbol: 'META', thesis: long(300) }] }).success)
check('a long watch note is kept', parse('watch_price', { symbol: 'ODD', condition: 'above', value: 18.45, note: long(200) }).success)
check('a long stakes line on ask_operator is kept', parse('ask_operator', { question: 'Raise the cap?', stakes: long(300), fallback: long(300) }).success)
check('a long errand outcome / retire reason / proposal is kept', parse('errand_done', { id: 'e1', outcome: long(300) }).success && parse('retire', { reason: long(300) }).success && parse('propose_task', { task: long(400), why: long(300) }).success)
check('a size-less trade is still refused (that one is not a length problem)', !parse('trade', { symbol: 'TEN', side: 'buy', type: 'market', reason: 'r' }).success)

// ------------------------------------------------ 3. the stale approved pass
const runOnce = read('src/core/runner/runOnce.ts')
check('an agent made fully autonomous drops its open/approved card at run start', /if \(heldNow && autonomous\) \{[\s\S]{0,700}approvalMootOutcome\(\)[\s\S]{0,300}await patch\(\{ pendingAction: null \}\)/.test(runOnce))
check('a review run that could act (market open) and did not, spends the pass', /else if \(approved && !approvalUsed && !error && !cancelled && attended && req\.trigger !== 'reply' && isRegularSession\(endedAt\)/.test(runOnce) && /approvalPassedOutcome\(\)/.test(runOnce))
check('...but a reply run, a failed run or a closed market keeps it (Friday-approve → Monday-execute)', /req\.trigger !== 'reply' && isRegularSession\(endedAt\)/.test(runOnce))

// ------------------------------------------------ 4. the run ceiling and what scales with it
check('the run ceiling is 300 s', RUN_TIMEOUT_MS === 300_000, String(RUN_TIMEOUT_MS))

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exitCode = failures ? 1 : 0
