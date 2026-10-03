/**
 * The no-model fast path for interval ticks.
 *
 * A tick skips the model ONLY when every signal is absent, and `quietTickReason`
 * names them on the run row. Any one signal — a fired watch, a moved exit, a
 * settled order, an operator message, a due errand, the day's first tick, a
 * price move, a fresh buy lock, a pending approval, a respawn, a first run, a
 * self-review — runs the model. Unpriced counts as moved: "nothing moved" is a
 * claim that needs prices.
 *
 * Run: `npm run check -- fast-path`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { busySignals, priceMoved, quietTickReason, PRICE_MOVE_THRESHOLD, type TickSignals } from '@core/runner/quiet'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const quiet: TickSignals = { watchFired: false, exitMoved: false, orderSettled: false, operatorMessage: false, errandReady: false, firstTickOfDay: false, priceMoved: false, buyLocked: false, approvalPending: false, respawned: false, firstRun: false, selfReview: false, questionTimedOut: false }

console.log('— the condition —')
const reason = quietTickReason(quiet)
check('all-absent → skipped, with a reason that names what was absent', reason !== null && /no watch fired/.test(reason) && /no operator message/.test(reason) && /model was not called/.test(reason), reason ?? 'null')
for (const k of Object.keys(quiet) as (keyof TickSignals)[]) {
  check(`${k} alone runs the model`, quietTickReason({ ...quiet, [k]: true }) === null && busySignals({ ...quiet, [k]: true }).join() === k)
}
// A question's fallback is marked applied at run start, BEFORE this gate; the
// model is what applies it. A tick that skipped here recorded the promise as
// kept and kept nothing.
check('an expired question forces the run (its fallback is applied by the model, not by the mark)', quietTickReason({ ...quiet, questionTimedOut: true }) === null && busySignals({ ...quiet, questionTimedOut: true }).join() === 'questionTimedOut')
console.log('\n— prices —')
check('a 0.31% move counts as moved', priceMoved([{ symbol: 'MU', last: 100.31, ts: 'x' }], { MU: 100 }))
check('a 0.29% move does not', !priceMoved([{ symbol: 'MU', last: 100.29, ts: 'x' }], { MU: 100 }))
check('a symbol with no baseline is moved', priceMoved([{ symbol: 'MU', last: 100, ts: 'x' }], {}))
check('no quotes at all is moved (unpriced is not quiet)', priceMoved([], { MU: 100 }))
check('the threshold is 0.3%', PRICE_MOVE_THRESHOLD === 0.003)

console.log('\n— wiring (source contract) —')
const src = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/runOnce.ts'), 'utf8')
check('interval schedule ticks only', /if \(req\.trigger === 'schedule' && cfg\.schedule\.kind === 'interval'\) \{/.test(src))
check('every signal is set where the engine learns it', ['signals.watchFired = true', 'signals.exitMoved = true', 'signals.orderSettled = true', 'signals.firstTickOfDay = true', 'signals.buyLocked = true', 'signals.errandReady =', 'signals.priceMoved = priceMoved(quotes, state.lastRunQuotes)'].every((s) => src.includes(s)))
check('an operator message since the last run is a signal', /operatorMessage: recent60\.some\(\(m\) => m\.role === 'user'/.test(src))
check('the settled question is a signal, set from the mark itself', /questionTimedOut: Boolean\(timeoutQuestion\)/.test(src))
check('a lock the sweep set arrives as a notice and is consumed at run start (note + signal)', /\?\? \(state\.buyLockNotice\?\.date === today \? state\.buyLockNotice : null\)/.test(src) && /buyLockNotice: null \}\s*await post\(\{ role: 'system', kind: 'error', text: dailyLossLockNote\(lock\.lossPct\) \}\)/.test(src))
check('the run row carries skipped:true and the reason', /skipped: true,\s*skipReason,/.test(src))
check('the exit sweep at run start persists any change, not only sales', /if \(ex\.state !== state\) \{\s*signals\.exitMoved = true/.test(src))
check('the reason is stored on the run record', /skipReason\?: string/.test(readFileSync(resolve(import.meta.dirname, '../../src/shared/agents.ts'), 'utf8')))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
