/**
 * A report that says "sleep" while nothing slept is answered, then noted.
 *
 * An agent that buys ahead of an evening earnings report can file
 * `next: "Sleep to Wed 9:35 ET…"` without ever calling `sleep_until`. The card
 * then says Wednesday while the header, reading the schedule, says tomorrow —
 * and the header is right: the agent keeps waking to report "still holding".
 *
 * Pinned here (core/runner/sleepClaim.ts + runOnce):
 *  - the predicate matches the report's own words and nothing else;
 *  - the `report` tool result carries the advice when the claim has no sleep
 *    armed, and NOT when `state.sleep` is already in force;
 *  - the settle pass posts one schedule note only when the claim stands, the
 *    run finished cleanly, and `sleep_until` was never called this run;
 *  - the `next` field's description says writing "sleep" sleeps nothing.
 *
 * Run: `npm run check -- sleep-claim`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reportClaimsSleep, sleepClaimAdvice, sleepClaimNote } from '../../src/core/runner/sleepClaim'
import { AGENT_TOOLS } from '../../src/core/runner/agentTools'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const R = join(import.meta.dirname, '..', '..')
const read = (p: string): string => readFileSync(join(R, p), 'utf8').replace(/\r\n/g, '\n')
const runOnce = read('src/core/runner/runOnce.ts')

// ---------------------------------------------------------- the predicate
check('a report that names a sleep claims one', reportClaimsSleep({ headline: 'Bought 3 KO', next: 'Sleep to Wed 9:35 ET: sell KO at open' }))
check('…and so does one that says it in the headline or details', reportClaimsSleep({ headline: 'Asleep until earnings' }) && reportClaimsSleep({ headline: 'h', details: 'sleeping through the Fed' }))
check('a report about selling at the open does not', !reportClaimsSleep({ headline: 'Holding KO', next: 'Sell KO at open, then research reporters' }))
check('no report, no claim', !reportClaimsSleep(null) && !reportClaimsSleep({ headline: 'x' }))

// ---------------------------------------------------------- the sentences
const wed = new Date('2026-09-15T13:35:00.000Z')
check('the advice names sleep_until and the schedule\'s next tick', /sleep_until/.test(sleepClaimAdvice(wed)) && /(Tue 09\/15|Tomorrow|Today) 9:35 AM ET/.test(sleepClaimAdvice(wed)), sleepClaimAdvice(wed))
check('the note names what the engine will do', /never called sleep_until/.test(sleepClaimNote(wed)) && /as scheduled/.test(sleepClaimNote(wed)))
check('both survive an unknown next tick', /schedule/.test(sleepClaimAdvice(null)) && /unchanged/.test(sleepClaimNote(null)))

// ---------------------------------------------------------- the seams in runOnce
const report = runOnce.slice(runOnce.indexOf('async report(r) {'), runOnce.indexOf('ONE WRITER AT A TIME'))
check('the report result carries the advice only when no sleep is in force', /if \(reportClaimsSleep\(r\) && !activeSleep\(state, now\(\)\)\)/.test(report) && /sleepClaimAdvice\(nextWakeAt\(cfg, state!, at\)\)/.test(report))
check('the report is still filed either way', /pendingReport = r\n/.test(report) && /return filed/.test(report))
check('sleep_until stamps the per-run flag, set or cancel', /async sleepUntil\(args\) \{\n\s+const tool = tbToolName\('sleep_until'\)\n\s+sleepTouched = true/.test(runOnce))
const settle = runOnce.slice(runOnce.indexOf('if (finalText || pendingReport) {'), runOnce.indexOf('The failure note is posted WHETHER OR NOT'))
check('the settle note needs a clean run, a standing claim, no sleep_until call and no sleep', /pendingReport && !error && !cancelled && !sleepTouched && reportClaimsSleep\(pendingReport\) && !activeSleep\(state, now\(\)\)/.test(settle))
check('…is a schedule note under the reply and a trace event', /kind: 'schedule', text: sleepClaimNote\(next\)/.test(settle) && /sleep_claim_unarmed/.test(settle))
check('…and reads the next tick through nextWakeAt, never the raw schedule', /nextWakeAt\(cfg, state, at\)/.test(settle))

// ---------------------------------------------------------- the tool
const reportTool = AGENT_TOOLS.find((t) => t.name === 'report')!
const nextDesc = JSON.stringify((reportTool.schema as unknown as { shape: Record<string, { description?: string; _def?: unknown }> }).shape?.next?.description ?? '') + JSON.stringify(read('src/core/runner/agentTools.ts').match(/next: lenientString\(120[^\n]*/)?.[0] ?? '')
check('the next field says writing "sleep" sleeps nothing', /sleeps nothing/.test(nextDesc) && /sleep_until/.test(nextDesc))

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
