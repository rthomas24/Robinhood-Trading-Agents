/**
 * What the engine REFUSED is the one thing an agent cannot reconstruct.
 *
 * Every other part of a run prompt is either current state (the book, open
 * protections, memory, track record) or the agent's own words (the transcript).
 * A blocked tool call is in neither: `checkGuardrails` refuses, the model reads
 * the refusal as a tool result inside that run, the run ends, and the next run
 * starts with no idea it happened. So an agent held by a rule it cannot see
 * re-proposes the same order tomorrow, and the day after, spending a wake-up
 * and an allowance each time to rediscover a limit that has not moved.
 *
 * This is deliberately NOT "show the agent its tool calls" — that was
 * considered and rejected. Successful calls are already visible in their
 * consequences: a fill is an ACTION line and a position, an armed watch is in
 * PROTECTIONS. Only refusals are invisible, so only refusals are rendered.
 *
 * Guards the three bounds, because each of them fails silently:
 *   - collapse by rule+tool, or a stuck agent floods its own prompt with the
 *     evidence that it is stuck
 *   - a time window, or a three-week-old refusal reads as a live constraint
 *   - `blocked` only, or the far more numerous `allowed` rows bury it
 *
 * And the seam: `recentDecisions` is OPTIONAL, so a host without a decision
 * store renders nothing rather than an empty section, and a read that fails
 * must cost a hint rather than the run.
 *
 * Run: `npm run check -- refusals-block`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refusalsBlock, runPromptBlocks } from '@core/runner/prompts'
import type { DecisionRecord } from '@shared/decisions'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Anchored to the REAL clock, not a fixed date. `formatEt` renders relative
// labels ("Today", "Yesterday") against the actual current day, so a pinned
// future NOW made every past refusal print as "Tomorrow" — a fixture that
// produced correct passes and misleading output. A check nobody can read is
// most of the way to a check nobody trusts.
const NOW = new Date()
const ago = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

const rec = (over: Partial<DecisionRecord>): DecisionRecord => ({
  id: Math.random().toString(36).slice(2),
  ts: ago(1),
  agentId: 'ag_x',
  runId: 'run_x',
  trigger: 'schedule',
  attended: false,
  tool: 'mcp__tb__trade',
  outcome: 'blocked',
  rule: 'cap.orderNotional',
  ...over
})

// ------------------------------------------------------------------ rendering

check('no decisions renders nothing at all', refusalsBlock([], NOW) === '', JSON.stringify(refusalsBlock([], NOW)))

check(
  'an ALLOWED decision renders nothing',
  refusalsBlock([rec({ outcome: 'allowed', rule: 'ok.operatorExit' })], NOW) === '',
  'allowed rows are logged for every successful gated call and would bury the block'
)

const one = refusalsBlock([rec({ detail: 'order $900 exceeds the $500 cap' })], NOW)
check('a blocked decision renders', one.includes('cap.orderNotional') && one.includes('mcp__tb__trade'))
check('the detail is carried', one.includes('exceeds the $500 cap'))
check('it tells the agent not to just retry', /do not simply retry/i.test(one))

// ------------------------------------------------------------------- collapse

const stuck = refusalsBlock(
  Array.from({ length: 12 }, (_, i) => rec({ ts: ago(i + 1), detail: `attempt ${i}` })),
  NOW
)
check('12 identical refusals collapse to one line', stuck.split('\n').filter((l) => l.startsWith('- ')).length === 1, stuck)
check('…and the count is shown', stuck.includes('×12'))
check('…keeping the NEWEST detail, not whichever came first', stuck.includes('attempt 0'))

// --------------------------------------------------------------------- window

check(
  'a refusal older than the window is dropped',
  refusalsBlock([rec({ ts: ago(40) })], NOW) === '',
  'a three-week-old refusal is history, not a live constraint'
)
check(
  'Friday afternoon still reaches Monday morning',
  refusalsBlock([rec({ ts: ago(30) })], NOW) !== '',
  'the window is >24h on purpose so a weekend does not silently clear the board'
)

// ------------------------------------------------------------------- bounding

const many = refusalsBlock(
  ['cap.orderNotional', 'lock.dailyLoss', 'live.notArmed', 'policy.toolNotAllowed', 'account.tradingHalted', 'cap.maxOrdersPerDay'].map((rule, i) =>
    rec({ rule: rule as DecisionRecord['rule'], ts: ago(i + 1) })
  ),
  NOW
)
const lines = many.split('\n').filter((l) => l.startsWith('- ')).length
check(`distinct kinds are bounded (${lines} rendered of 6)`, lines <= 4 && lines > 0)
check('…and the shortfall is stated rather than silently dropped', /other refusal kind/.test(many))

// ----------------------------------------------------------------- the seam

const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'types.ts'), 'utf8')
check('recentDecisions is OPTIONAL on RuntimeDeps', /recentDecisions\?:/.test(src), 'a host with no decision store must render nothing, not an empty block')

const runOnce = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8')
check('a failed decision read cannot fail the run', /recentDecisions\?\.\([\s\S]{0,120}\.catch\(/.test(runOnce), 'advisory block; losing it costs a hint, not the wake-up')
check('…and the failure is logged rather than swallowed silently', /could not read the decision log/.test(runOnce))

// -------------------------------------------------- it actually reaches a prompt

check('refusals is a real block id', /\|\s*'refusals'/.test(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'prompts.ts'), 'utf8')))
check('runPromptBlocks is exported and callable', typeof runPromptBlocks === 'function')

// ------------------------------------------------- the omission notice's fix

const prompts = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'prompts.ts'), 'utf8')
const notice = prompts.slice(prompts.indexOf('const omissionNotice'), prompts.indexOf('const omissionNotice') + 1200)
check('the omission notice points at search_thread', /mcp__tb__search_thread/.test(notice), 'we built the retrieval tool and then told the agent to ask the operator instead')
check('…in BOTH the terse and full forms', (notice.match(/mcp__tb__search_thread/g) ?? []).length >= 2, 'the terse form is what renders at a tight budget — the case where the window is shortest')
check('…and asking is still offered as the fallback', /ask/i.test(notice))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
