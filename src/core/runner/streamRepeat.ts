/**
 * Tier-two loop detection: a model degenerating INSIDE one streamed message
 *.
 *
 * We already have tier one — `repeat.ts` counts identical tool+args calls
 * across a run and refuses at `REPEAT_BLOCK_AT`. It only ever sees *completed
 * tool calls*, so a model that stops calling tools and starts emitting the same
 * line four hundred times is invisible to it: the run looks healthy, burns its
 * whole output budget, and the operator gets a wall of nonsense.
 *
 * We have already seen this signature. Duplicate messages and output that
 * "looks like nonsense" were reported, traced to streaming causes (a shared
 * `emit` across retry attempts, and a renderer that kept text on retry) and
 * fixed. That was the right diagnosis — but a genuinely degenerating model
 * produces the same user-visible symptom, and nothing on our side would tell
 * the two apart.
 *
 * ── Why this is a guard OBJECT and not a `detect(text)` function ──
 *
 * The single largest risk in this feature is measuring OUR OWN retry replay as
 * model repetition. When an attempt is retried, the same text can flow past the
 * emit path twice; a detector fed that concatenation sees perfect repetition and
 * kills a healthy run. That is a false POSITIVE, so the fail-open-on-timeout
 * property below does not save you from it.
 *
 * A free function taking a string cannot defend against being handed the wrong
 * string. So the unit is a guard **created per attempt**: `runAttempt` makes one,
 * and a retry — which re-enters `runAttempt` — necessarily makes another. Reusing
 * a guard across attempts has to be written deliberately, and reads as wrong
 * where it is written. Same move as `composeRunPromptWithin` handing a budgeter
 * only the blocks it may cut: put the constraint in the shape, not in a comment
 * someone has to still be obeying six months from now.
 *
 * ── Fail open, always ──
 *
 * A loop detector that becomes a latency source on long outputs is worse than
 * no detector. Checking is capped at `CHECK_BUDGET_MS` of cumulative wall time
 * per guard; past that the guard returns `clean` forever. It also only runs the
 * scan every `CHECK_EVERY_CHARS`, over a bounded tail — so cost is O(tail) per
 * scan and independent of how long the message grows.
 *
 * Pure: no imports, no Node APIs (`Date.now` only). Lives in `core` so every
 * vendor can use it, and knows nothing about any of them.
 */

/** Cumulative wall-clock a single guard may spend checking before it gives up. */
export const CHECK_BUDGET_MS = 500
/** Scan at most this often — a scan per token would be the latency bug itself. */
const CHECK_EVERY_CHARS = 512
/** Only the tail can be degenerate; bounding it keeps each scan O(1) in message length. */
const TAIL_CHARS = 8_000

/** Consecutive identical lines before we say something is wrong. */
const LINE_WARN = 6
const LINE_STOP = 12
/**
 * Code legitimately repeats lines — closing braces, imports, a column of `0,`.
 * Inside a fence the bar is much higher, exactly as their implementation does.
 */
const LINE_WARN_FENCED = 30
const LINE_STOP_FENCED = 60

/** Shortest cycle we look for, and the widest — beyond this it is prose, not a loop. */
const MAX_PERIOD = 120
/** A cycle must repeat this many times AND span this many chars to count. */
const PERIOD_REPEATS_WARN = 8
const PERIOD_REPEATS_STOP = 16
/**
 * 400 chars of span, so a markdown rule (`---`), a table separator or an ASCII
 * divider can never trip it. Those are short by construction; degenerate output
 * is not.
 */
const PERIOD_SPAN_MIN = 400

export type Degeneracy = 'clean' | 'warn' | 'stop'

export interface Verdict {
  kind: Degeneracy
  /** Human-readable cause, present when kind !== 'clean'. */
  reason?: string
}

const CLEAN: Verdict = { kind: 'clean' }

export interface StreamGuard {
  /**
   * Feed the next streamed chunk. The returned verdict is an EARLY WARNING —
   * it only reflects text up to the last scan boundary, so that a runaway can
   * be cut off mid-stream before it burns the whole output budget.
   */
  push(delta: string): Verdict
  /**
   * The authoritative verdict — scans whatever has arrived since the last
   * boundary. Call this at end of stream; `push` alone cannot see the final
   * partial chunk, and a message that degenerates in its last few hundred
   * characters would otherwise be missed entirely.
   */
  verdict(): Verdict
  /** Everything pushed into THIS guard. */
  text(): string
  /** True once the time budget is spent and the guard has failed open. */
  gaveUp(): boolean
}

/**
 * The nudge a `warn` should put in front of the model — graduated escalation,
 * as theirs is: say something first, stop the run second.
 */
export const REPEAT_NUDGE =
  'You appear to be repeating yourself. Stop, and either say what you actually concluded in one or two sentences, or tell the operator plainly that you are stuck — do not continue the pattern.'

/**
 * A degeneracy guard for ONE streamed attempt.
 *
 * ⚠️ Call site: create this per attempt, and push only text that has already
 * been through whatever de-duplication the emit path does. Feeding it a replayed
 * attempt makes it report repetition that the model never produced.
 */
export function createStreamGuard(now: () => number = Date.now): StreamGuard {
  let buf = ''
  let sinceCheck = 0
  let spentMs = 0
  let verdict: Verdict = CLEAN

  const rescan = (): Verdict => {
    // A `stop` is terminal: once degenerate, later chunks cannot redeem it, and
    // re-scanning after the caller has decided is wasted budget.
    if (verdict.kind === 'stop' || spentMs >= CHECK_BUDGET_MS || sinceCheck === 0) return verdict
    sinceCheck = 0
    const started = now()
    const next = scan(buf.length > TAIL_CHARS ? buf.slice(-TAIL_CHARS) : buf)
    spentMs += Math.max(0, now() - started)
    // Never downgrade: a message that warned stays warned even if it then
    // produces a clean tail.
    if (rank(next.kind) > rank(verdict.kind)) verdict = next
    return verdict
  }

  return {
    text: () => buf,
    gaveUp: () => spentMs >= CHECK_BUDGET_MS,
    verdict: rescan,
    push(delta: string): Verdict {
      if (typeof delta !== 'string' || delta === '') return verdict
      buf += delta
      sinceCheck += delta.length
      return sinceCheck < CHECK_EVERY_CHARS ? verdict : rescan()
    }
  }
}

const rank = (k: Degeneracy): number => (k === 'stop' ? 2 : k === 'warn' ? 1 : 0)

/** Both detectors over one bounded tail. Exported for the check, not for callers. */
export function scan(tail: string): Verdict {
  return worst(repeatedLines(tail), repeatedPeriod(tail))
}

const worst = (a: Verdict, b: Verdict): Verdict => (rank(b.kind) > rank(a.kind) ? b : a)

/**
 * The same line, over and over.
 *
 * Blank lines are skipped rather than counted: a model emitting whitespace is a
 * different (and harmless) problem, and counting them turns ordinary paragraph
 * spacing into a false positive.
 */
function repeatedLines(tail: string): Verdict {
  // Fence state is tracked PER LINE, not by parity over the whole tail. A
  // complete ```…``` block has an even number of fence markers, so a parity
  // test reports "not fenced" for exactly the case the higher threshold exists
  // for — and a 25-line column of `0,` inside a code block got the prose
  // thresholds and was killed as degenerate. The repeating region's own context
  // is what decides, not the end of the buffer.
  let inFence = false
  let run = 1
  let prev = ''
  // Best run seen in each context, evaluated once at the end. Flagging the
  // instant a threshold is crossed would report "12 times" for a line that went
  // on to repeat 40 — accurate at the moment, useless in the log.
  const best = { fenced: { run: 0, line: '' }, prose: { run: 0, line: '' } }
  for (const raw of tail.split('\n')) {
    const cur = raw.trim()
    if (cur.startsWith('```')) {
      inFence = !inFence
      run = 1
      prev = ''
      continue
    }
    // Blank lines are skipped rather than counted: a model emitting whitespace
    // is a different and harmless problem, and counting them turns ordinary
    // paragraph spacing into a false positive.
    if (cur === '') continue
    run = cur === prev ? run + 1 : 1
    prev = cur
    const slot = inFence ? best.fenced : best.prose
    if (run > slot.run) {
      slot.run = run
      slot.line = cur
    }
  }
  const verdictFor = (b: { run: number; line: string }, warnAt: number, stopAt: number): Verdict =>
    b.run >= warnAt ? { kind: b.run >= stopAt ? 'stop' : 'warn', reason: `the same line ${b.run} times in a row: ${short(b.line)}` } : CLEAN
  return worst(verdictFor(best.prose, LINE_WARN, LINE_STOP), verdictFor(best.fenced, LINE_WARN_FENCED, LINE_STOP_FENCED))
}

/**
 * A repeating character cycle — "abcabcabc…", the shape a model falls into when
 * it degenerates mid-token rather than mid-line.
 *
 * Anchored at the END of the tail, because that is where a live degeneration is:
 * the message may begin perfectly well and come apart later, and scanning the
 * whole buffer for any repeat anywhere is both slower and likelier to fire on
 * legitimately repetitive prose.
 */
function repeatedPeriod(tail: string): Verdict {
  const s = tail.trimEnd()
  if (s.length < PERIOD_SPAN_MIN) return CLEAN
  for (let p = 1; p <= MAX_PERIOD; p++) {
    if (s.length < p * PERIOD_REPEATS_WARN) break
    const unit = s.slice(-p)
    let reps = 1
    while (reps < 4096 && s.length >= p * (reps + 1) && s.slice(-p * (reps + 1), -p * reps) === unit) reps++
    const span = p * reps
    if (span < PERIOD_SPAN_MIN) continue
    if (reps >= PERIOD_REPEATS_STOP) return { kind: 'stop', reason: `a ${p}-character sequence repeated ${reps} times: ${short(unit)}` }
    if (reps >= PERIOD_REPEATS_WARN) return { kind: 'warn', reason: `a ${p}-character sequence repeated ${reps} times: ${short(unit)}` }
  }
  return CLEAN
}

const short = (s: string): string => (s.length <= 40 ? JSON.stringify(s) : JSON.stringify(s.slice(0, 40) + '…'))
