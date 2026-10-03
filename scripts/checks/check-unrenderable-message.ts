/**
 * One malformed message must not brick an agent forever.
 *
 * NOT a security check. This was called `check-transcript-poison` until a
 * reviewer scanning for prompt-injection coverage read the name as exactly
 * that — and both concern the SAME function, `transcriptBlock`, which makes
 * the mistake likelier rather than less likely. Structural-tag escaping is
 * unstarted and nothing here tests it. "Poison" meant a row that cannot be
 * RENDERED, not one that lies.
 *
 * A message stored without a `ts` (a row of just `{kind, text}`) is enough.
 * `transcriptBlock` calls `formatEt(m.ts)` on every message in the window,
 * `formatEt` fed `new Date(undefined)` to `Intl.DateTimeFormat`, and that
 * throws `RangeError: Invalid time value`.
 *
 * The throw happens while COMPOSING THE PROMPT, before the model is reached.
 * So every subsequent run of that agent fails, forever, on a row that has
 * nothing to do with the work — and the thread that would explain it is the
 * exact thing that cannot be rendered.
 *
 * A timestamp is a LABEL. The worst honest outcome is a line that cannot say
 * when; it is never worth a failed run, and never worth a permanently dead
 * agent. `formatEt` now returns "unknown time" for an unreadable instant.
 *
 * Run: `npm run check -- unrenderable-message`
 */
import { formatEt } from '@shared/marketTime'
import { transcriptBlock } from '@core/runner/prompts'
import type { Message } from '@shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const survives = (label: string, fn: () => unknown): unknown => {
  try {
    return fn()
  } catch (e) {
    check(label, false, (e as Error).message)
    return undefined
  }
}

// ── formatEt on every shape of nonsense a row can carry ────────────────────
for (const [label, value] of [
  ['undefined', undefined],
  ['null', null],
  ['empty string', ''],
  ['garbage text', 'not-a-date'],
  ['NaN', Number.NaN],
  ['an Invalid Date', new Date('nope')]
] as [string, unknown][]) {
  const out = survives(`formatEt(${label}) does not throw`, () => formatEt(value as never, true))
  if (out !== undefined) check(`formatEt(${label}) says it does not know`, out === 'unknown time', String(out))
}

// A real instant must still render normally — a fallback that swallowed the
// good case would be worse than the throw it replaced.
const good = formatEt('2026-08-24T16:09:00.008Z', true)
check('a valid instant still renders a real label', good !== 'unknown time' && /ET/.test(good), good)

// ── the actual poison row, as it was stored ────────────────────────────────
// `body` was `{kind, text}`: no ts, no id, no role. This is that row after
// mapping, which is what reached transcriptBlock.
const poison = { kind: 'info', text: 'The run crashed on the server before it finished.', role: 'system' } as unknown as Message
const healthy = { id: 'm1', agentId: 'ag_x', role: 'user', ts: '2026-08-24T16:09:00.008Z', text: 'what is your status?' } as unknown as Message

const block = survives('transcriptBlock survives a message with no ts', () => transcriptBlock([healthy, poison]))
if (typeof block === 'string') {
  check('the poisoned line is still rendered, not dropped', block.includes('crashed on the server'), 'silently dropping it would hide the note from the model')
  check('and the healthy line either side is intact', block.includes('what is your status?'))
}

// The whole window is what a run actually passes; one bad row must not take the
// rest of the thread with it.
const many = survives('a window that is ALL poison still composes', () => transcriptBlock([poison, poison, poison]))
check('...and returns something usable', typeof many === 'string' && many.length > 0)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
