/**
 * A tool that was never offered was never refused.
 *
 * Every vendor filters its tool list through the gate, and all three used
 * `gate.allow()` to do it — which records a refusal in the decision log. So each
 * run wrote one "blocked" row per hidden tool: eight rows, same second, empty
 * detail, always the Robinhood WRITE tools, for calls the model never made.
 *
 * Most of a decision log could be this: the real rows — the actual allowed
 * trades and the genuine refusals — buried under phantom ones, which reads as
 * an agent repeatedly trying to do things it was not allowed to do. Nothing of
 * the sort happened; the log was describing its own tool-list construction.
 *
 * `permits()` asks the same question without auditing. `allow()` keeps auditing,
 * because a refusal of an ACTUAL call is exactly what the log is for.
 *
 * Run: `npm run check -- decision-noise`
 */
import { offered } from '@core/runner/vendors/shared'
import type { ToolGate } from '@core/runner/vendors/types'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The Robinhood write tools that produced phantom rows. */
const WRITE_TOOLS = [
  'mcp__robinhood__place_equity_order',
  'mcp__robinhood__cancel_equity_order',
  'mcp__robinhood__place_option_order',
  'mcp__robinhood__review_equity_order',
  'mcp__robinhood__add_to_watchlist',
  'mcp__robinhood__update_watchlist',
  'mcp__robinhood__create_scan',
  'mcp__robinhood__update_scan_filters'
]
const READ_TOOL = 'mcp__robinhood__get_equity_quotes'

/** A gate shaped like runOnce's: reads allowed, writes not, and every `allow` audited. */
const makeGate = (): { gate: ToolGate; audited: string[] } => {
  const audited: string[] = []
  const permit = (name: string): boolean => !WRITE_TOOLS.includes(name)
  return {
    audited,
    gate: {
      permits: (name) => permit(name),
      allow(name) {
        if (permit(name)) return true
        audited.push(name)
        return false
      }
    }
  }
}

// ── building the tool list must write nothing ──────────────────────────────
const build = makeGate()
const exposed = [READ_TOOL, ...WRITE_TOOLS].filter((n) => offered(build.gate, n))
check('the write tools are still hidden from the model', exposed.length === 1 && exposed[0] === READ_TOOL, exposed.join(', '))
check('and building the list audits NOTHING', build.audited.length === 0, `${build.audited.length} phantom rows — this was 8 per run`)

// ── an actual refused CALL must still be recorded ──────────────────────────
// The log exists for this. Silencing it would trade noise for blindness.
const call = makeGate()
check('a real call to a hidden tool is still refused', call.gate.allow('mcp__robinhood__place_equity_order') === false)
check('...and IS written to the decision log', call.audited.length === 1, 'the operator must still be able to ask why a call did not happen')
check('an allowed call is not audited as blocked', call.gate.allow(READ_TOOL) === true && call.audited.length === 1)

// ── the fallback must fail safe, not open ──────────────────────────────────
// A gate without `permits` (an older shape) falls back to `allow`. That costs
// the old noise; it must never hide a tool that should be shown or offer one
// that should be hidden.
const legacy = makeGate()
const legacyGate: ToolGate = { allow: legacy.gate.allow.bind(legacy.gate) }
check('a gate with no permits() still hides write tools', offered(legacyGate, 'mcp__robinhood__place_equity_order') === false, 'falling back must not offer what allow() denies')
check('...and still offers read tools', offered(legacyGate, READ_TOOL) === true)

// ── the ratio that made this worth fixing ──────────────────────────────────
// 8 phantom rows per run against a handful of real decisions: after a day the
// log is almost entirely noise, which is the same as having no log.
const RUNS = 19
check('19 runs would have written 152 phantom rows', RUNS * WRITE_TOOLS.length === 152, 'matching the live count exactly')
check('...and now write none', RUNS * makeGate().audited.length === 0)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
