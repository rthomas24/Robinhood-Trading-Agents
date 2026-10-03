/**
 * Three ways a run prompt can tell the agent something false, and the fixes
 * pinned.
 *
 *   1. CLOCK used to say "your next run Today 3:41 PM ET" at 3:41 PM —
 *      `state.nextRunAt` is the instant the current run was due and is re-armed
 *      only at settle. The line names the schedule's next tick from now.
 *   2. REFUSED SINCE YOUR LAST RUNS could list a refusal from a day and a half
 *      earlier — dozens of runs later, for a rule since fixed. The window is
 *      the previous run (its end minus the run ceiling), never longer.
 *   3. THREAD SO FAR could carry dozens of near-identical "holding" paragraphs
 *      from one session. Consecutive held reports fold to one line after the
 *      first, keeping the first and last.
 *
 * Run: `npm run check -- prompt-hygiene`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clockLine, foldHeldTicks, HELD_FOLD_MIN, refusalsBlock, transcriptBlock } from '../../src/core/runner/prompts'
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type Message } from '../../src/shared/agents'
import type { DecisionRecord } from '../../src/shared/decisions'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const R = join(import.meta.dirname, '..', '..')
const read = (p: string): string => readFileSync(join(R, p), 'utf8').replace(/\r\n/g, '\n')

// ------------------------------------------------------------------ 1. clock
const cfg = {
  id: 'ag_x',
  name: 'Momentum Sprint',
  icon: 'plasma',
  color: 'pink',
  task: 't',
  schedule: { kind: 'interval', everyMinutes: 10, marketHoursOnly: true },
  guardrails: DEFAULT_GUARDRAILS,
  mode: 'live',
  model: { vendor: 'openrouter', id: 'x', effort: 'medium' },
  allocationUsd: 400,
  liveArmedAt: null,
  retirement: null,
  createdAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:00Z'
} as unknown as AgentConfig
/** Thu 2026-09-10 15:41 ET, a tick due at that same instant. */
const at341 = new Date('2026-09-10T19:41:29.000Z')
const state = { ...initialState(cfg), nextRunAt: '2026-09-10T19:41:29.000Z', lastRunAt: '2026-09-10T19:31:40.000Z' }
const clock = clockLine(cfg, state, 3, undefined, at341)
// formatEt labels the day relative to the REAL clock and puts a narrow no-break space before AM/PM, so only the time is asserted, with \s.
check('the clock names the NEXT tick, not the one that is running', /your next run [^·]*3:51\sPM ET/.test(clock), clock.match(/your next run [^·]+/)?.[0] ?? clock)
const dueLater = clockLine(cfg, { ...state, nextRunAt: '2026-09-10T20:30:00.000Z' }, 3, undefined, at341)
check('a due instant still in the future (a manual run between ticks) is reported as it stands', /your next run [^·]*4:30\sPM ET/.test(dueLater))
const asleep = clockLine(cfg, { ...state, sleep: { until: '2026-09-11T13:35:00.000Z', reason: 'r', setAt: '2026-09-10T19:00:00.000Z' } }, 3, undefined, at341)
check('a sleeping agent’s next run is the wake', /your next run [^·]*9:35\sAM ET/.test(asleep), asleep.match(/your next run [^·]+/)?.[0] ?? '')

// -------------------------------------------------------------- 2. refusals
const refusal = (ts: string): DecisionRecord => ({ agentId: 'ag_x', runId: 'run_1', ts, tool: 'mcp__tb__trade', outcome: 'blocked', rule: 'size.belowOneShare', attended: false, trigger: 'schedule', detail: 'Notional $100 is less than one share of META at $648.85.' }) as DecisionRecord
const now = new Date('2026-09-10T19:41:29.000Z')
const wed = refusal('2026-09-09T13:52:15.000Z')
check('a refusal from a run 30 hours and 40 runs ago is NOT re-shown', refusalsBlock([wed], now, '2026-09-10T19:31:40.000Z') === '')
check('...but was, under the old 36 h window (the regression this pins)', refusalsBlock([wed], now) !== '')
const prevRun = refusal('2026-09-10T19:31:20.000Z')
check('a refusal from the previous run IS shown', /size\.belowOneShare/.test(refusalsBlock([prevRun], now, '2026-09-10T19:31:40.000Z')))
check('with no previous run (first run) the wide window applies', /size\.belowOneShare/.test(refusalsBlock([wed], now, null)))

// ------------------------------------------------------------------ 3. fold
const held = (i: number, text = `Tape check ${i}: holding, exits armed.`): Message => ({ id: `m${i}`, agentId: 'ag_x', ts: new Date(Date.parse('2026-09-10T15:00:00Z') + i * 600_000).toISOString(), role: 'agent', text, report: { headline: 'holding', status: 'held', facts: [] } }) as unknown as Message
const acted: Message = { id: 'a1', agentId: 'ag_x', ts: '2026-09-10T17:40:00.000Z', role: 'agent', text: 'Bought MSTR.', report: { headline: 'bought', status: 'acted', facts: [] } } as unknown as Message
const op: Message = { id: 'u1', agentId: 'ag_x', ts: '2026-09-10T17:50:00.000Z', role: 'user', text: 'how is it going?' }
const seq = [held(0), held(1), held(2), held(3), held(4), held(5), acted, held(20), held(21), op, held(30), held(31), held(32), held(33)]
const f = foldHeldTicks(seq, seq.map((m) => `[${m.ts}] ${m.role}: ${'text' in m ? m.text : ''}`))
check('six consecutive held ticks become first + one fold line + last', f.rendered.filter((l) => /Tape check [0-5]:/.test(l)).length === 2 && f.rendered.some((l) => /4 routine checks \(folded\)/.test(l)))
check('the fold keeps the FIRST and the LAST of the run verbatim', /Tape check 0:/.test(f.rendered[0]) && /Tape check 5:/.test(f.rendered[2]))
check('an acted report breaks the run and is never folded', f.rendered.some((l) => /Bought MSTR/.test(l)))
check('a run shorter than HELD_FOLD_MIN stays verbatim', HELD_FOLD_MIN === 4 && f.rendered.filter((l) => /Tape check 2[01]:/.test(l)).length === 2)
check('the operator’s message is untouched and still splits runs', f.rendered.some((l) => /how is it going/.test(l)) && f.rendered.filter((l) => /Tape check 3[0-3]:/.test(l)).length === 2 && f.rendered.filter((l) => /routine checks \(folded\)/.test(l)).length === 2)
check('the fold line points the model at the live blocks, not its own paragraphs', f.rendered.some((l) => /read those, not your earlier paragraphs/.test(l)))
check('the folded arrays stay aligned', f.messages.length === f.rendered.length)
const block = transcriptBlock(seq)
check('the transcript block renders through the fold', /routine checks \(folded\)/.test(block) && !/Tape check 3:/.test(block))
check('without enough consecutive held ticks nothing folds', !/folded/.test(transcriptBlock([held(0), held(1), acted, held(2)])))

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exitCode = failures ? 1 : 0
