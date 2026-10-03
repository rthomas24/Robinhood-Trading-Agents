/**
 * Every time the ENGINE writes into a thread, a prompt or a notification, the
 * time is in ET — never the host's locale.
 *
 * On a machine whose clock is not ET (UTC, Europe, anywhere), strings built
 * with `toLocaleString()` / `toLocaleTimeString()` and no zone read —
 *
 *   "⏭ Missed the Aug 28, 7:40 PM run"      — for a 3:40 PM ET wake-up
 *   "🏁 Retired: Deadline reached (8/29/2026, 12:00:00 AM)" — Fri 8 PM ET
 *   "Once at 8/28/2026, 7:58:00 PM"          — in the SYSTEM PROMPT the model reads
 *   "needs a decision · answer by 7:55 PM"   — the notification
 *   "⏭ 78 wake-ups skipped …"                — and the COUNT must respect
 *                                              marketHoursOnly (39 real)
 *
 * Product time is ET everywhere else (schedules, the clock line, the
 * transcript), so a UTC figure in the same thread is not merely ugly: an
 * operator reading "7:40 PM" checks a run that never existed, and a model
 * reading "runs at 7:58 PM" plans around the wrong hour.
 *
 * Run: `npm run check -- et-notes`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeSchedule, missedRunMessage, skippedRunsMessage } from '../../src/shared/schedule'
import { retirementDue } from '../../src/core/broker/execute'
import type { AgentConfig, AgentState } from '../../src/shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 2026-08-28T19:40Z is 3:40 PM EDT. Every assertion below is independent of the
// machine's own zone — that is the property being checked.
const DUE = '2026-08-28T19:40:00.000Z'
const LATER = new Date('2026-08-29T00:28:00.000Z')

const missed = missedRunMessage(DUE, LATER)
check('missed-run note names the ET hour', /3:40 PM ET/.test(missed), missed)
check('missed-run note never shows the UTC hour', !/7:40/.test(missed), missed)

const once = describeSchedule({ kind: 'once', at: DUE })
check('"Once at" in the system prompt is ET', /3:40 PM ET/.test(once) && !/7:40/.test(once), once)

const cfg = { retirement: { at: '2026-08-29T00:00:00.000Z' } } as AgentConfig
const state = { status: 'scheduled' } as AgentState
const reason = retirementDue(cfg, state, [], new Date('2026-08-29T00:00:01.000Z'))
check('retirement deadline reason is ET (Fri 8:00 PM, not 12:00 AM)', reason !== null && /8:00 PM ET/.test(reason) && !/12:00/.test(reason), reason ?? 'null')

// A 10-minute market-hours agent, nothing running from Thu 09:30 ET until
// 22:28 ET: the session had 39 slots (09:30 … 15:50). The clock had 78.
const marketHours = { kind: 'interval' as const, everyMinutes: 10, marketHoursOnly: true }
const skipped = skippedRunsMessage(marketHours, '2026-09-03T13:30:00.000Z', new Date('2026-09-04T02:28:00.000Z'))
check('skipped count on a market-hours agent counts session slots only (39, not 78)', skipped !== null && /^⏭ 39 wake-ups/.test(skipped), skipped ?? 'null')
check('skipped note names the ET start', skipped !== null && /9:30 AM ET/.test(skipped), skipped ?? 'null')

const allHours = { kind: 'interval' as const, everyMinutes: 10, marketHoursOnly: false }
const skippedAll = skippedRunsMessage(allHours, '2026-09-03T13:30:00.000Z', new Date('2026-09-04T02:28:00.000Z'))
check('an all-hours agent still counts the clock (78)', skippedAll !== null && /^⏭ 78 wake-ups/.test(skippedAll), skippedAll ?? 'null')

// Two sessions lost (Tue 09:30 → Wed 17:50 ET) = 39 + 39.
const twoDays = skippedRunsMessage(marketHours, '2026-09-01T13:30:00.000Z', new Date('2026-09-02T21:50:00.000Z'))
check('two lost sessions count 78, not 194', twoDays !== null && /^⏭ 78 wake-ups/.test(twoDays), twoDays ?? 'null')

// Overnight only (Thu 16:10 → Fri 08:00 ET): no session slot was ever due, so nothing was lost and nothing is said.
const overnight = skippedRunsMessage(marketHours, '2026-09-03T20:10:00.000Z', new Date('2026-09-04T12:00:00.000Z'))
check('an absence entirely outside the session posts nothing', overnight === null, overnight ?? 'null')

// The guard is at the source because `notificationFor` needs a full message
// row to reach the branch.
const notes = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'shared', 'notifications.ts'), 'utf8')
check('notification "answer by" uses formatEt, not toLocaleTimeString', /answer by \$\{formatEt\(m\.deadline\)\}/.test(notes) && !/toLocaleTimeString/.test(notes))

// Nothing product-facing in shared/core formats a Date through the host locale
// any more. `agents.ts` money formatting (`toLocaleString('en-US', …)` on a
// NUMBER) is the allowed remainder.
const root = join(import.meta.dirname, '..', '..', 'src')
const offenders: string[] = []
for (const rel of ['shared/schedule.ts', 'shared/notifications.ts', 'core/broker/execute.ts', 'core/runner/prompts.ts', 'core/runner/runOnce.ts', 'core/broker/guardrails.ts']) {
  const src = readFileSync(join(root, rel), 'utf8')
  for (const m of src.matchAll(/new Date\([^)]*\)\.toLocale(?:Date|Time)?String\(/g)) offenders.push(`${rel}: ${m[0]}`)
}
check('no engine-facing Date is rendered through the host locale', offenders.length === 0, offenders.join('; '))

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exitCode = failures ? 1 : 0
