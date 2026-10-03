/**
 * Why a run stopped, on the row — and which vendor ran it.
 *
 * Two halves that live in `runOnce.ts`.
 *
 * WHY IT STOPPED. The distinction is NOT lost in memory. `cancelled`, `stalled`, `abortReason` and `stoppedBecause`
 * all exist and are all used during the run. What was missing is PERSISTENCE —
 * an operator-cancelled run reached `runs` as `ok: true, error: undefined`,
 * byte for byte a clean run, and `stoppedBecause` was used for a thread note
 * and then dropped at the row.
 *
 * One discriminant rather than a set of booleans, so "cancelled AND timed out"
 * cannot be represented. The ORDER is the part that would be wrong silently:
 * more than one condition is true at once on almost every abnormal stop.
 *
 * WHICH VENDOR RAN IT is one write. The rule that matters is what must NOT happen —
 * defaulting the vendor for an agent that has never recorded one. Backfilling
 * to the current vendor silences every pre-existing agent forever; backfilling
 * to anything else fires all of them once, wrongly.
 *
 * Run: `npm run check -- stop-reason`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunRecord } from '@shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The classifier exactly as `runOnce.ts` spells it — kept in step by the source assertion below. */
const classify = (i: {
  cancelled: boolean
  stalled: boolean
  abortReason: string | null
  error?: string
  stoppedBecause?: string
}): RunRecord['stopReason'] =>
  i.cancelled
    ? 'cancelled'
    : i.stalled
      ? 'stalled'
      : i.abortReason === 'Run exceeded the time limit'
        ? 'timeout'
        : i.error
          ? 'error'
          : i.stoppedBecause === 'turns' || i.stoppedBecause === 'cost'
            ? (i.stoppedBecause as 'turns' | 'cost')
            : 'natural'

const base = { cancelled: false, stalled: false, abortReason: null as string | null }

// ── each cause, alone ──────────────────────────────────────────────────────
check('a clean run is natural', classify({ ...base }) === 'natural')
check('the operator pressing Stop is cancelled', classify({ ...base, cancelled: true }) === 'cancelled')
check('the stall watchdog is stalled', classify({ ...base, stalled: true }) === 'stalled')
check('the run ceiling is timeout', classify({ ...base, abortReason: 'Run exceeded the time limit' }) === 'timeout')
check('a vendor failure is error', classify({ ...base, error: 'model returned 500' }) === 'error')
check('the step limit passes through', classify({ ...base, stoppedBecause: 'turns' }) === 'turns')
check('the money bound passes through', classify({ ...base, stoppedBecause: 'cost' }) === 'cost')

// ── the overlaps, which is where an order gets silently wrong ──────────────
// On almost every abnormal stop more than one of these is true at once.
check(
  'Stop during a stall reads as CANCELLED',
  classify({ ...base, cancelled: true, stalled: true }) === 'cancelled',
  'the person is the reason, whatever else was in flight'
)
check(
  'Stop while the ceiling fires reads as CANCELLED',
  classify({ ...base, cancelled: true, abortReason: 'Run exceeded the time limit' }) === 'cancelled'
)
check(
  'a stall outranks the run ceiling',
  classify({ ...base, stalled: true, abortReason: 'Run exceeded the time limit' }) === 'stalled',
  'a stall aborts the ATTEMPT; the run-level timeout can fire moments later on the way out, and would mis-name the cause'
)
check(
  'a stall outranks the error it produces',
  classify({ ...base, stalled: true, error: 'Stalled: the model sent nothing for 45s' }) === 'stalled'
)
check(
  'a real error outranks a turns/cost stop',
  classify({ ...base, error: 'boom', stoppedBecause: 'turns' }) === 'error',
  'a run that failed did not stop because it ran out of steps'
)
check('cancelled is not overridden by a stoppedBecause', classify({ ...base, cancelled: true, stoppedBecause: 'cost' }) === 'cancelled')

// ── the row must not lie about success ─────────────────────────────────────
const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8')
check(
  'ok is derived from error, so a cancellation stays ok:true',
  /ok:\s*!error/.test(src),
  'an operator stopping a run is not a failure — stopReason is what makes it distinguishable without calling it one'
)
check('stopReason reaches the row', /stopReason,/.test(src))
check('contextTokens reaches the row', /contextTokens:\s*result\.contextTokens/.test(src))
check('the classifier in the source still leads with cancelled', src.indexOf("? 'cancelled'") < src.indexOf("? 'stalled'"))
check('...and still puts stalled before timeout', src.indexOf("? 'stalled'") < src.indexOf("? 'timeout'"))
check('nothing defaults stopReason for historical rows', /stopReason\s*[:?]?[^\n]*\?\?\s*'natural'/.test(src) === false, "a run we never measured must not be handed 'natural'")

// ── which vendor ran it ─────────────────────────────────────────────────────
check('lastRunVendor is written from the model that ran', /lastRunVendor:\s*model\.vendor/.test(src), 'not cfg.model — a provider switch can land mid-run')
check('it is never defaulted', /lastRunVendor[^\n]*\?\?/.test(src) === false, 'absent means "do not fire"; backfilling silences every existing agent or fires them all once')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
