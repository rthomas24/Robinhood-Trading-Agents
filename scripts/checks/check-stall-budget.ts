/**
 * A tool that is running is not a model that has gone silent.
 *
 * The stall watchdog aborts an attempt after 45s without a delta. Nothing bumps
 * that clock while a TOOL executes, so a slow tool read as a wedged model.
 *
 * WebVector makes it real: its research calls run BM25 over full pages
 * (lexical-only — no embeddings runtime), which comfortably outlasts 45s. The
 * signature is in the run records: each attempt makes exactly ONE tool call,
 * then 45s of silence, three attempts running, zero input tokens because the
 * provider never got to report usage. The agent goes red having done nothing
 * wrong.
 *
 * The division of labour this pins:
 *   STALL_TIMEOUT_MS      — a wedged MODEL (nothing streaming at all)
 *   TOOL_STALL_TIMEOUT_MS — a wedged TOOL (a call that never returns)
 *   RUN_TIMEOUT_MS        — the ceiling, catching whatever neither noticed
 *
 * The budgets are exercised through the same expression the watchdog uses, so
 * this fails if that ordering is ever broken — a tool budget below the model one
 * would silently restore the bug, and one above the run ceiling would make it
 * unreachable.
 *
 * Run: `npm run check -- stall-budget`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Mirrors runOnce.ts. Kept here rather than exported so the constants stay
// private to the runner; the last section pins that the mirror is exact.
const STALL_TIMEOUT_MS = 45_000
const TOOL_STALL_TIMEOUT_MS = 120_000
const SETUP_TIMEOUT_MS = 120_000
const RUN_TIMEOUT_MS = 300_000

/** The watchdog's decision, extracted verbatim from the interval callback. */
const wouldAbort = (now: number, lastActivityAt: number, toolPendingSince: number, heardFromModel = true): boolean => {
  // `>=`: allow() lands in the same millisecond as the tool-call delta often
  // enough that a strict comparison made the long budget unreachable.
  const inTool = toolPendingSince >= lastActivityAt
  const budget = !heardFromModel ? SETUP_TIMEOUT_MS : inTool ? TOOL_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS
  const silentFor = now - Math.max(lastActivityAt, toolPendingSince)
  return silentFor >= budget
}

const T0 = 1_000_000
const at = (s: number): number => T0 + s * 1000

// ── the failure ────────────────────────────────────────────────────────────
// One tool call, then 50s inside it. This aborted a working run.
check('a tool running for 50s is NOT a stall', wouldAbort(at(50), T0, at(0)) === false, 'this is the WebVector case that turned an agent red')
check('...nor at 110s', wouldAbort(at(110), T0, at(0)) === false)
check('but a tool wedged past its budget IS caught', wouldAbort(at(121), T0, at(0)) === true, 'a tool that never returns must still fail the attempt')

// ── the model case is unchanged ────────────────────────────────────────────
// No tool pending: the short window still applies, which is the whole point of
// having a short window.
check('a silent model is still caught at 45s', wouldAbort(at(46), T0, 0) === true)
check('...and is not caught at 44s', wouldAbort(at(44), T0, 0) === false)
check('a model silent AFTER a tool returned gets the short budget', wouldAbort(at(46), at(1), T0) === true, 'the tool finished — lastActivityAt moved past toolPendingSince')

// ── setup: before the model has said anything at all ───────────────────────
// An attempt builds its tool list first, and for remote MCP servers that means
// a handshake per server (createMCPTools -> tools/list over HTTP). None of it
// emits and none of it is a tool CALL, so it looks like a model silent from
// the first second: the server comes up, the attempt is killed 45s later with
// zero tool calls, three attempts, red.
check('45s of tool discovery is NOT a stall', wouldAbort(at(50), T0, 0, false) === false, 'this killed three attempts in a row and turned the agent red')
check('...nor 110s of it', wouldAbort(at(110), T0, 0, false) === false)
check('but setup that never finishes IS caught', wouldAbort(at(121), T0, 0, false) === true, 'a handshake that hangs must still fail the attempt')
check('once the model speaks, the SHORT window returns', wouldAbort(at(46), T0, 0, true) === true, 'setup grace must not become a permanent 120s watchdog')

// ── the ordering that makes all three meaningful ───────────────────────────
check('the tool budget is longer than the model budget', TOOL_STALL_TIMEOUT_MS > STALL_TIMEOUT_MS, 'otherwise the fix is undone')
check('...and shorter than the run ceiling', TOOL_STALL_TIMEOUT_MS < RUN_TIMEOUT_MS, 'otherwise a hung tool is only ever caught by the ceiling, with no reason attached')
check('the run ceiling is the outermost bound', RUN_TIMEOUT_MS > TOOL_STALL_TIMEOUT_MS && RUN_TIMEOUT_MS > STALL_TIMEOUT_MS)
check('setup gets more room than a silent model', SETUP_TIMEOUT_MS > STALL_TIMEOUT_MS, 'waiting on I/O is not waiting on a model')
check('...and still less than the run ceiling', SETUP_TIMEOUT_MS < RUN_TIMEOUT_MS)

// ── the timestamp must not be able to leak ─────────────────────────────────
// toolPendingSince is a timestamp, not a counter, so a refused vet or a throwing
// tool leaves a stale value that the next delta overwrites. A counter that
// failed to decrement would disable the watchdog for the rest of the run.
check('a stale tool timestamp is overridden by any later activity', wouldAbort(at(46), at(45), at(0)) === false, 'activity at 45s resets the clock')
check('the same-millisecond case uses the TOOL budget', wouldAbort(at(50), T0, T0) === false, 'a strict > here made the whole fix a no-op, intermittently')
check('...and the short budget resumes from that activity', wouldAbort(at(91), at(45), at(0)) === true, 'model silent 46s after the tool result')

// ── the mirror is exact ────────────────────────────────────────────────────
const runOnce = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8')
for (const [name, value] of Object.entries({ STALL_TIMEOUT_MS, TOOL_STALL_TIMEOUT_MS, SETUP_TIMEOUT_MS, RUN_TIMEOUT_MS })) {
  const m = new RegExp(`const ${name} = ([\\d_]+)`).exec(runOnce)
  check(`runOnce's ${name} matches the mirror`, m !== null && Number(m[1].replace(/_/g, '')) === value, m ? m[1] : 'not found')
}
check('the watchdog picks its budget the way the mirror does', /const inTool = toolPendingSince >= lastActivityAt/.test(runOnce) && /const budget = !heardFromModel \? SETUP_TIMEOUT_MS : inTool \?/.test(runOnce))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
