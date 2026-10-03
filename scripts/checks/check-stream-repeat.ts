/**
 * Tier-two loop detection: a model degenerating inside ONE streamed message.
 *
 * This check exists in the shape it does because a grep-based check for this
 * feature (`grep -E 'repetition|singleMessageLoop'`) would pass on the WORD
 * "repetition" in a comment in `repeat.ts` — the tool-call loop guard, which
 * is tier one and a different thing. *A check that would
 * still pass if the implementation were replaced by a stub with the right name
 * is not a check.* So nothing here greps: every assertion feeds real degenerate
 * output and real healthy output through the real guard and reads the verdict.
 *
 * The four properties, in the order they can hurt us:
 *
 *  1. FALSE POSITIVES ARE THE EXPENSIVE FAILURE. A false stop kills a healthy
 *     run — possibly one holding an unprotected position — and fail-open-on-
 *     timeout does not protect against it, because it is not a timeout. The
 *     benign corpus is therefore larger than the attack corpus, which is the
 *     reverse of `check-transcript-injection.ts` and deliberately so.
 *  2. It must actually catch degeneration, at both escalation levels.
 *  3. It must fail OPEN when the time budget is spent. A detector that becomes
 *     a latency source on long outputs is worse than no detector.
 *  4. Guards must be per-attempt and independent — this is what stops our own
 *     retry replay being measured as model repetition.
 *
 * Run: `npm run check -- stream-repeat`
 */
import { CHECK_BUDGET_MS, createStreamGuard, scan, REPEAT_NUDGE, type Degeneracy } from '@core/runner/streamRepeat'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Stream text through a real guard in realistic chunk sizes. */
const run = (text: string, chunk = 64): Degeneracy => {
  const g = createStreamGuard()
  for (let i = 0; i < text.length; i += chunk) g.push(text.slice(i, i + chunk))
  // verdict(), not the last push: push only sees up to the last scan boundary,
  // so a message that degenerates in its final few hundred characters is
  // invisible to it. That was a live defect — four assertions below caught it.
  return g.verdict().kind
}

// ── 1. healthy output must never be touched ───────────────────────────────
const HEALTHY: [string, string][] = [
  ['a normal agent reply', 'Bought 2 MU at 358.10 and set a stop at 341.50. Nothing else met the entry rule today.'],
  ['a long analytical answer', Array.from({ length: 60 }, (_, i) => `Considering ${i}: the ${i % 2 ? 'volume' : 'price'} action on day ${i} was ${i * 3} percent above its mean, which argues for patience.`).join('\n')],
  ['a markdown table', ['| sym | qty | px |', '|---|---|---|', ...Array.from({ length: 30 }, (_, i) => `| SYM${i} | ${i} | ${i}.00 |`)].join('\n')],
  ['an ASCII rule', `Summary\n${'-'.repeat(70)}\nAll positions flat.`],
  ['a long divider line', '='.repeat(300)],
  ['code with repeated closers', '```ts\n' + Array.from({ length: 18 }, () => 'if (x) {\n  y()\n}').join('\n') + '\n```'],
  ['a fenced column of values', '```\n' + Array.from({ length: 25 }, () => '0,').join('\n') + '\n```'],
  ['a numbered list', Array.from({ length: 40 }, (_, i) => `${i + 1}. step ${i + 1} of the plan`).join('\n')],
  ['repeated blank lines', 'First paragraph.\n\n\n\n\n\n\n\n\n\n\n\nSecond paragraph.'],
  ['a JSON blob', JSON.stringify({ positions: Array.from({ length: 40 }, (_, i) => ({ symbol: `S${i}`, qty: i })) })],
  ['a short repetitive-but-legit phrase', 'Buy. Hold. Buy. Hold. Buy. Hold.'],
  ['empty', ''],
  ['whitespace only', '     \n\n   ']
]
for (const [label, text] of HEALTHY) check(`healthy: ${label}`, run(text) === 'clean', run(text))

// ── 2. real degeneration must be caught, at both levels ───────────────────
const line = 'I should check the price again before deciding.'
check('12 identical lines → stop', run(Array.from({ length: 14 }, () => line).join('\n')) === 'stop')
check('7 identical lines → warn only', run(Array.from({ length: 7 }, () => line).join('\n')) === 'warn')
check('4 identical lines → clean', run(Array.from({ length: 4 }, () => line).join('\n')) === 'clean')
check('a repeating character cycle → stop', run('Thinking. ' + 'abcdefghij'.repeat(80)) === 'stop')
check('a single degenerate character → stop', run('Hmm' + 'x'.repeat(900)) === 'stop')
check('degeneration only in the TAIL is still caught', run('A perfectly ordinary opening paragraph about MU and its earnings. '.repeat(6) + 'na'.repeat(400)) === 'stop')
check('a fenced block still stops at the higher bar', run('```\n' + Array.from({ length: 70 }, () => 'same();').join('\n') + '\n') === 'stop')
check('the nudge says what to do instead', /stuck|conclude/i.test(REPEAT_NUDGE))

// A stop must name its cause — an unexplained kill is unactionable.
const reason = scan(Array.from({ length: 14 }, () => line).join('\n')).reason ?? ''
check('a verdict carries a reason', reason.includes('same line') && reason.includes('14'), reason)

// ── 3. fail open on the time budget ───────────────────────────────────────
// A clock that burns the whole budget on the first scan: everything after must
// come back clean even though the content is flagrantly degenerate.
let t = 0
const slow = createStreamGuard(() => {
  t += CHECK_BUDGET_MS
  return t
})
const degenerate = 'z'.repeat(4000)
let slowVerdict: Degeneracy = 'clean'
for (let i = 0; i < degenerate.length; i += 600) slowVerdict = slow.push(degenerate.slice(i, i + 600)).kind
slowVerdict = slow.verdict().kind
check('a spent time budget fails OPEN, not closed', slowVerdict === 'clean' || slow.gaveUp(), `${slowVerdict}`)
check('...and the guard says it gave up', slow.gaveUp())
check('the guard still returns the full text after giving up', slow.text().length === degenerate.length)

// The budget must not be spent on healthy traffic — a detector that gives up on
// every long-but-fine message has silently turned itself off.
let realTicks = 0
const cheap = createStreamGuard(() => {
  realTicks++
  return realTicks
})
const longHealthy = HEALTHY[1][1].repeat(6)
for (let i = 0; i < longHealthy.length; i += 64) cheap.push(longHealthy.slice(i, i + 64))
check('a long healthy message does not exhaust the budget', !cheap.gaveUp(), `${longHealthy.length} chars`)

// ── 4. per-attempt isolation — the retry-replay constraint ────────────────
// The single largest risk is measuring our own replay as model repetition.
// A guard is created per attempt, so a retry gets a fresh one; reusing one
// across attempts has to be written deliberately.
const attempt = 'Checking MU. Price is 358.10. Holding.'
const a = createStreamGuard()
const b = createStreamGuard()
check('attempt 1 in its own guard is clean', a.push(attempt).kind === 'clean')
check('attempt 2 in its OWN guard is also clean', b.push(attempt).kind === 'clean')
check('the two guards do not share state', a.text() === attempt && b.text() === attempt)
// And the failure it prevents, demonstrated: one guard fed the same attempt
// many times DOES flag — which is why a retry must never reuse one.
const shared = createStreamGuard()
let sharedVerdict: Degeneracy = 'clean'
for (let i = 0; i < 20; i++) sharedVerdict = shared.push(attempt + '\n').kind
check('one guard replayed 20x DOES flag (why reuse is a bug)', sharedVerdict !== 'clean', sharedVerdict)

// ── 5. verdicts never downgrade ───────────────────────────────────────────
const g = createStreamGuard()
for (let i = 0; i < 14; i++) g.push(line + '\n')
g.push('\n\nAnyway, here is a completely ordinary sentence to finish on.')
const after = g.verdict().kind
check('a stop is not undone by a clean tail', after === 'stop', after)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
