/**
 * Where the degeneracy guard is placed — which is the whole risk.
 *
 * The detector itself is lane A's (`streamRepeat.ts`, its own check). This one
 * is about the CALL SITE, because the way this feature hurts you is not a
 * missed loop — it is a false positive that kills a healthy run.
 *
 * THE HAZARD. When an attempt stalls we abort it and retry, and a retry
 * REGENERATES the reply from scratch. A guard that spanned attempts would see
 * the abandoned partial followed by the new attempt saying much the same
 * thing, and call a perfectly healthy retried run degenerate. Fail-open on the
 * time budget does not protect against that — it is a false positive, not a
 * timeout.
 *
 * So the guard is created per attempt and fed from inside `attemptEmit`, the
 * one place where a superseded attempt's deltas have already been dropped by
 * the `gen !== liveAttempt` check.
 *
 * These are source assertions. They cannot prove the detector's behaviour —
 * that is `check-stream-repeat.ts`'s job — but placement is not observable
 * from the detector's own tests at all, and it is the half that would be
 * wrong.
 *
 * Run: `npm run check -- repeat-wiring`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStreamGuard, REPEAT_NUDGE } from '@core/runner/streamRepeat'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8')
const attemptFn = src.slice(src.indexOf('const runAttempt = async'), src.indexOf('const runWithRetries') > 0 ? src.indexOf('const runWithRetries') : src.length)

// ── one guard per attempt ──────────────────────────────────────────────────
check('a guard is created inside runAttempt', attemptFn.includes('createStreamGuard()'), 'outside it, one guard would span retries')
check('exactly one is created', (src.match(/createStreamGuard\(/g) ?? []).length === 1, String((src.match(/createStreamGuard\(/g) ?? []).length))

// ── fed downstream of the de-duplication ───────────────────────────────────
const emitFn = attemptFn.slice(attemptFn.indexOf('const attemptEmit'), attemptFn.indexOf('if (!runner)'))
check('it is fed from attemptEmit', emitFn.includes('guard.push('), 'the only place a superseded attempt has already been dropped')
check(
  '...AFTER the superseded-attempt check',
  emitFn.indexOf('gen !== liveAttempt') < emitFn.indexOf('guard.push('),
  'before it, a dying attempt’s replayed tail is measured as repetition'
)
check('only model-authored text is fed', emitFn.includes("delta.kind === 'text'") && emitFn.includes("delta.kind === 'thinking'"), 'a quote table repeats by nature; that is not the model losing its place')
check('tool results are NOT fed', emitFn.includes("delta.kind === 'tool_result'") === false)

// ── the end-of-stream verdict ──────────────────────────────────────────────
// push() scans on a 512-char boundary, so the final partial chunk is invisible
// to it. Reading only push()'s return misses a reply that degenerates in its
// last few hundred characters — a live defect lane A's own check caught.
check('verdict() is called at end of stream', attemptFn.includes('guard.verdict()'), 'push alone never sees the final partial chunk')

// ── a degenerate run is terminal, not transient ────────────────────────────
check(
  'degeneracy is classified terminal',
  /attempt\.degenerate \? 'terminal'/.test(src),
  'retrying identical input after the model looped on it is expecting a different result from the same thing'
)
check('...and a stall is still transient', /attempt\.stalled \? 'transient'/.test(src))
check('the reason reaches the run record', src.includes('`Stopped: ${degenerate}`'), 'an aborted attempt leaves a bare "aborted" otherwise')

// ── the module contract the wiring depends on ──────────────────────────────
const g = createStreamGuard()
check('a fresh guard is clean', g.verdict().kind === 'clean')
check('benign prose stays clean', (() => { const q = createStreamGuard(); q.push('Reviewed MU. Thesis intact, holding. '.repeat(3)); return q.verdict().kind !== 'stop' })())
check('the nudge exists for a warn', REPEAT_NUDGE.length > 0)
check('two guards do not share state', (() => { const a = createStreamGuard(); const b = createStreamGuard(); a.push('x'.repeat(4000)); return b.verdict().kind === 'clean' })(), 'per-attempt isolation is the entire safety argument')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
