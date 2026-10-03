/**
 * A silent turn is asked once more — the model does not get to plan and stop.
 *
 * The failure shape: a live agent holding a position takes one model step —
 * 148 output tokens, role `reasoning`, "Save one lesson note, then report." —
 * and the turn ends. No tool call, no reply; the thread says "Run finished
 * with no reply." and the lesson is never saved. Models do this often enough
 * to matter.
 *
 * The rule in `runOnce`: a completed attempt with NO tool calls, NO reply text
 * and SOME reasoning is re-run once with `SILENT_TURN_NUDGE` appended to the
 * run prompt. It is not a transient retry (no backoff, does not spend
 * MAX_TRANSIENT_RETRIES), and a second silence is reported exactly as before.
 * A run that produced text, or called a tool, or errored, is never re-asked.
 *
 * Also pinned here: the vendor's per-step output ceiling (a runaway reasoning
 * step ends at STEP_MAX_OUTPUT_TOKENS instead of at the run ceiling), and the
 * two tool-shape repairs that ride along — a size-less SELL closes the
 * position, and `remember({ notes: "…" })` is one note.
 *
 * Run: `npm run check -- silent-turn`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SILENT_TURN_NUDGE, SILENT_TURN_REASON } from '../../src/core/runner/runOnce'
import { STEP_MAX_OUTPUT_TOKENS } from '../../src/core/runner/vendors/openrouter'
import { AGENT_TOOLS } from '../../src/core/runner/agentTools'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const R = join(import.meta.dirname, '..', '..')
const read = (p: string): string => readFileSync(join(R, p), 'utf8').replace(/\r\n/g, '\n')
const runOnce = read('src/core/runner/runOnce.ts')

// ---------------------------------------------------------- the silent turn
const loop = runOnce.slice(runOnce.indexOf('const attempt = await runAttempt(resumable)'), runOnce.indexOf('const klass = attempt.degenerate'))
check('a completed attempt with no tools, no text and some reasoning is re-asked', /!nudged && result\.toolCalls\.length === 0 && !result\.texts\.join\(''\)\.trim\(\) && result\.thinking\.join\(''\)\.trim\(\)/.test(loop))
check('...exactly once', /let nudged = false/.test(runOnce) && /nudged = true/.test(loop))
check('...with the nudge appended to the run prompt, which is therefore mutable', /runPrompt = `\$\{runPrompt\}\\n\\n\$\{SILENT_TURN_NUDGE\}`/.test(loop) && /let runPrompt = composeRunPrompt\(promptArgs\)/.test(runOnce))
check('...without a backoff and without spending a transient retry', /emit\(\{ kind: 'retry', attempt: 1, delayMs: 0, reason: SILENT_TURN_REASON \}\)/.test(loop) && !/retries\+\+[\s\S]{0,200}SILENT_TURN/.test(loop))
check('a run that errored is never re-asked here (the transient path decides)', /if \(!result\.error\) \{/.test(loop))
check('an aborted run is never re-asked', /if \(outer\.signal\.aborted\) break/.test(loop))
check('the nudge names what happened and what to do', /ENDED WITHOUT ACTING/.test(SILENT_TURN_NUDGE) && /Never end a run on reasoning alone/.test(SILENT_TURN_NUDGE))
check('the live bubble says why it is trying again', /did not act/.test(SILENT_TURN_REASON))
check('the "no reply" note still follows a second silence', /else if \(!finalText && !pendingReport && result\.toolCalls\.length === 0\)/.test(runOnce))

// ---------------------------------------------------------- the step ceiling
const vendor = read('src/core/runner/vendors/openrouter.ts')
check('every OpenRouter step carries the output ceiling', /maxOutputTokens: STEP_MAX_OUTPUT_TOKENS/.test(vendor))
check('the ceiling is far above a healthy step (p95 580 tokens) and below a runaway (8,700)', STEP_MAX_OUTPUT_TOKENS >= 4_000 && STEP_MAX_OUTPUT_TOKENS <= 8_000, String(STEP_MAX_OUTPUT_TOKENS))

// ---------------------------------------------------------- the shapes
const parse = (tool: string, args: unknown) => AGENT_TOOLS.find((t) => t.name === tool)!.schema.safeParse(args)
check('a size-less SELL is accepted by the schema (the host closes the position)', parse('trade', { side: 'sell', symbol: 'META', reason: 'early cut' }).success)
check('a size-less BUY is still refused', !parse('trade', { side: 'buy', symbol: 'META', reason: 'r' }).success)
check('the host fills the held quantity for a size-less sell, and refuses when nothing is held', /if \(intent\.side === 'sell' && !\(intent\.qty && intent\.qty > 0\) && !\(intent\.notional && intent\.notional > 0\)\) \{[\s\S]{0,200}if \(heldBefore <= 1e-9\) return[\s\S]{0,200}intent = \{ \.\.\.intent, qty: heldBefore \}/.test(runOnce))
const notes = parse('remember', { notes: 'one note as a string' })
check('remember({ notes: "…" }) is one note, not a shape error', notes.success && Array.isArray((notes.data as { notes?: unknown }).notes) && ((notes.data as { notes: string[] }).notes[0] === 'one note as a string'))

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exitCode = failures ? 1 : 0
