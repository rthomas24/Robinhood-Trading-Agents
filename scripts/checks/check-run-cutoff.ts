/**
 * A run that was cut off says so, is filed under its real cause, and is paid for.
 *
 * Three things a cut-off run can lose on the way to its record:
 *
 *   1. ITS CAUSE. A run killed by the deadline would store the vendor's wording
 *      for a signal ("This operation was aborted", "Request aborted by client:
 *      AbortError…") as `error`, not the run's reason, which `runOnce` already
 *      holds in `abortReason`.
 *   2. ITS NOTE. If the "Run failed" line is the `else` of "the model wrote some
 *      text", a run killed mid-work AFTER it streamed a paragraph posts the
 *      paragraph as an ordinary reply and nothing else — even one that placed
 *      an order seconds before it died.
 *   3. ITS COST. If the OpenRouter runner reads usage only at the end, an
 *      attempt that throws records 0 tokens and no cost, though every model
 *      call before the abort was billed.
 *
 * Plus one bookkeeping flag: `awaitingPlan` must be cleared when the agent
 * chooses its own schedule on the setup run — which is what the setup run is
 * for — or it keeps the flag for good.
 *
 * These are source-level assertions on purpose: `runOnce` needs a full
 * `RuntimeDeps` and a live vendor to reach any of these lines, and the property
 * each one pins is a single expression that a refactor could quietly revert.
 *
 * Run: `npm run check -- run-cutoff`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeSystemPrompt } from '../../src/core/runner/prompts'
import { DEFAULT_GUARDRAILS, QUESTION_WAIT_MAX, type AgentConfig } from '../../src/shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const root = join(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

// ------------------------------------------------------------- 1. the cause
const runOnce = read('src/core/runner/runOnce.ts')
check('a run-level abort names abortReason, not the vendor\'s abort text', /result\.error && outer\.signal\.aborted && abortReason \? abortReason/.test(runOnce))

// ------------------------------------------------------------- 2. the note
// The failure note must be an independent `if (error)`, not an `else if`
// hanging off the "model wrote text" branch.
const noteIdx = runOnce.indexOf("text: `Run failed: ${short(error, 300)}")
check('the "Run failed" note exists', noteIdx > 0)
const before = runOnce.slice(Math.max(0, noteIdx - 400), noteIdx)
check('the failure note is posted even when the model produced text', /\n\s*if \(error\) \{/.test(before) && !/else if \(error\)/.test(before))
check('a cut-off run that ACTED tells the operator to check its protection', /cut off after acting, so check any position/.test(runOnce))

// ------------------------------------------------------------- 3. the cost
const openrouter = read('src/core/runner/vendors/openrouter.ts')
check('per-call output tokens and cost are accumulated', /outputTotal \+= usage\.outputTokens/.test(openrouter) && /costTotal \+= usage\.cost/.test(openrouter))
const catchIdx = openrouter.indexOf('out.error = (err as Error).message || String(err)')
const catchBody = openrouter.slice(catchIdx, catchIdx + 900)
check('a failed attempt records the tokens it already spent', /out\.inputTokens = inputTotal/.test(catchBody) && /out\.outputTokens = outputTotal/.test(catchBody))
check('cost is recorded only when every call priced itself', /costReported && out\.costUsd === undefined\) out\.costUsd = costTotal/.test(catchBody))

// ------------------------------------------------------------- awaitingPlan
check('the runner settles awaitingPlan when it applies a schedule', /if \(plan\.schedule && state!\.awaitingPlan\) await patch\(\{ awaitingPlan: false \}\)/.test(runOnce))

// ------------------------------------------------------------- the prompt
// An autonomous agent whose task demands approval is told the right mechanism
// once; a non-autonomous agent has that mechanism and must not be told to use
// ask_operator for it.
const base = {
  id: 'ag_check',
  name: 'Earnings',
  icon: 'bot',
  color: 'blue',
  task: 'Find a big-name stock with earnings this week and take a long position the day before. Always show the plan and wait for approval before putting it on.',
  schedule: { kind: 'times', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], times: ['09:40', '15:40'], tradingDaysOnly: true },
  guardrails: DEFAULT_GUARDRAILS,
  mode: 'paper',
  model: { vendor: 'openrouter', id: 'x', effort: 'medium' },
  allocationUsd: 10_000,
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z'
} as unknown as AgentConfig
const autonomous = composeSystemPrompt({ ...base, autonomous: true })
const held = composeSystemPrompt({ ...base, autonomous: false })
check('autonomous agents are told a short-deadline question is the wrong approval gate', new RegExp(`waitMinutes ${QUESTION_WAIT_MAX}`).test(autonomous) && /non-autonomous in its settings/.test(autonomous))
check('non-autonomous agents are not (they already have approval cards)', !/short-deadline question is the WRONG tool/.test(held) && /APPROVAL REQUIRED/.test(held))

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exitCode = failures ? 1 : 0
