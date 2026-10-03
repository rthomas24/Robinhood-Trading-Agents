/**
 * `sleep_until` — an agent parks itself until a dated event it looked up.
 *
 * Three rules, each with a failure mode nobody would see in the happy path:
 *
 *   1. A sleep in force IS the next wake-up (`armedState` / `nextWakeAt`), and
 *      every writer passes the state — one that does not wakes a sleeping agent
 *      on its old cadence. An expired sleep is ignored: it is a wake-up that has
 *      arrived, and the run clears it. Paused/retired never arm, sleep or not.
 *   2. The wake-up that ends a sleep is "at or after", so a late one RUNS
 *      (`catchUpDecision`) rather than posting "Missed the 9:35 AM run".
 *   3. The engine's clamped timers re-arm when they fire early; without that a
 *      wake-up past ~24.8 days fires at once, forever.
 *
 * Run: `npm run check -- sleep-until`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { initialState, type AgentConfig, type AgentState, type Schedule } from '@shared/agents'
import { LIFECYCLE, sleepNote } from '@shared/lifecycle'
import { etClock, formatEt } from '@shared/marketTime'
import { CATCH_UP_GRACE_MS, armedState, catchUpDecision, nextRunAt, nextWakeAt } from '@shared/schedule'
import { MAX_SLEEP_DAYS, SLEEP_DEFAULT_MINUTES, activeSleep, parseSleepUntil, sleepStatusText } from '@shared/sleep'
import { AGENT_TOOLS, tbToolName } from '@core/runner/agentTools'
import { sleepBlock } from '@core/runner/prompts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const root = resolve(import.meta.dirname, '../..')
const src = (p: string): string => readFileSync(resolve(root, p), 'utf8')

// A Tuesday 10:00 ET in summer (EDT, UTC-4).
const now = new Date('2026-09-08T14:00:00.000Z')
const schedule: Schedule = { kind: 'interval', everyMinutes: 15, marketHoursOnly: true }
const cfg = { id: 'a_sleep', schedule } as Pick<AgentConfig, 'id' | 'schedule'>
const base: AgentState = initialState({ allocationUsd: 1000 })
const future = new Date(now.getTime() + 20 * 86_400_000).toISOString()
const past = new Date(now.getTime() - 60_000).toISOString()
const asleep: AgentState = { ...base, sleep: { until: future, reason: 'AAPL reports Oct 30', setAt: now.toISOString() } }
const overslept: AgentState = { ...base, sleep: { until: past, reason: 'AAPL reports Oct 30', setAt: now.toISOString() } }

console.log('— the re-arm rule —')
check('a future sleep is the next wake-up', armedState(cfg, 'idle', now, asleep).nextRunAt === future)
check('...and the status is scheduled', armedState(cfg, 'idle', now, asleep).status === 'scheduled')
check('nextWakeAt agrees', nextWakeAt(cfg, asleep, now)?.toISOString() === future)
const tick = nextRunAt(schedule, now, cfg.id)?.toISOString() ?? null
check('a past sleep is ignored — the schedule decides', armedState(cfg, 'idle', now, overslept).nextRunAt === tick && tick !== null)
check('no state at all behaves as before', armedState(cfg, 'idle', now).nextRunAt === tick)
check('an awake agent is unchanged', armedState(cfg, 'idle', now, base).nextRunAt === tick)
check('a paused agent never arms, asleep or not', armedState(cfg, 'paused', now, asleep).nextRunAt === null && armedState(cfg, 'paused', now, asleep).status === 'paused')
check('a retired agent never arms, asleep or not', armedState(cfg, 'retired', now, asleep).nextRunAt === null)
check('activeSleep: in force', activeSleep(asleep, now)?.until === future)
check('activeSleep: expired is null', activeSleep(overslept, now) === null)
check('activeSleep: absent is null', activeSleep(base, now) === null && activeSleep(null, now) === null)

console.log('\n— late wake-ups —')
const late = new Date(Date.parse(future) + CATCH_UP_GRACE_MS + 30 * 60_000)
check('a sleep wake-up 33 minutes late still RUNS', catchUpDecision({ kind: 'times', times: ['09:35'], days: [], tradingDaysOnly: true }, future, late, asleep) === 'run')
check('...where the same lateness on a plain times schedule is missed', catchUpDecision({ kind: 'times', times: ['09:35'], days: [], tradingDaysOnly: true }, future, late) === 'missed')
const staleDue = new Date(now.getTime() - 10 * 60_000)
check('a late wake-up that is NOT the sleep is still judged by the schedule', catchUpDecision({ kind: 'times', times: ['09:35'], days: [], tradingDaysOnly: true }, staleDue, now, asleep) === 'missed')

console.log('\n— parsing —')
const bare = parseSleepUntil('2026-10-29')
check('a bare date is 09:35 ET that day', bare !== null && etClock(bare).date === '2026-10-29' && etClock(bare).minutes === SLEEP_DEFAULT_MINUTES, bare ? formatEt(bare, true) : 'null')
check('SLEEP_DEFAULT_MINUTES is 09:35', SLEEP_DEFAULT_MINUTES === 9 * 60 + 35)
const wall = parseSleepUntil('2026-10-29 15:50')
check('"YYYY-MM-DD HH:MM" is ET wall-clock', wall !== null && etClock(wall).date === '2026-10-29' && etClock(wall).minutes === 15 * 60 + 50)
const tIso = parseSleepUntil('2026-10-29T15:50')
check('an unzoned ISO time is ET too, never the host clock', tIso !== null && etClock(tIso).minutes === 15 * 60 + 50)
check('a zoned ISO instant is taken as written', parseSleepUntil('2026-10-29T13:50:00Z')?.toISOString() === '2026-10-29T13:50:00.000Z')
check('garbage is null, not "now"', parseSleepUntil('next thursday') === null && parseSleepUntil('') === null)
check('an impossible wall-clock is null', parseSleepUntil('2026-10-29 25:00') === null)

console.log('\n— the tool —')
const tool = AGENT_TOOLS.find((t) => t.name === 'sleep_until')
check('sleep_until is an agent tool', Boolean(tool))
check('...named mcp__tb__sleep_until', tbToolName('sleep_until') === 'mcp__tb__sleep_until')
check('...and not a write tool (no approval card)', !src('src/shared/agents.ts').match(/WRITE_TOOLS[^\n]*sleep_until/))
const long = 'x'.repeat(130)
const parsed = tool!.schema.safeParse({ until: '2026-10-29', reason: long })
check('a 130-char reason is clipped to 120, not refused', parsed.success && (parsed.data as { reason: string }).reason.length === 120, parsed.success ? '' : parsed.error.issues[0].message)
const shown = z.toJSONSchema(tool!.schema, { target: 'draft-7', io: 'input' }) as { properties: Record<string, { maxLength?: number; type?: string }> }
check('...and the advertised schema still carries maxLength 120', shown.properties.reason?.maxLength === 120, JSON.stringify(shown.properties.reason))
check('.shape survives (claude.ts reads it)', Object.keys((tool!.schema as { shape: Record<string, unknown> }).shape).length === 3)
check('cancel "true" is a boolean', (() => { const r = tool!.schema.safeParse({ cancel: 'true' }); return r.success && (r.data as { cancel: boolean }).cancel === true })())
check('the description tells it to wake BEFORE an event it must act ahead of', /BEFORE/.test(tool!.description) && /day before/.test(tool!.description))
check('...that messages and watches still wake it', /messages/.test(tool!.description) && /price watches/.test(tool!.description))
check('...and how to cancel', /cancel: true/.test(tool!.description))
check(`...and the cap (${MAX_SLEEP_DAYS} days)`, tool!.description.includes(`${MAX_SLEEP_DAYS} days`) && MAX_SLEEP_DAYS === 120)
// The tool's own parse step: what it hands the host, and what it refuses before the host.
const handed: unknown[] = []
const fakeHost = { sleepUntil: async (a: unknown) => { handed.push(a); return 'ok' } } as unknown as Parameters<NonNullable<typeof tool>['run']>[1]
await tool!.run({ until: 'whenever', cancel: false }, fakeHost)
check('an unparseable `until` is answered with the accepted shapes and never reaches the host', handed.length === 0)
await tool!.run({ until: '2026-10-29', reason: 'r', cancel: false }, fakeHost)
check('a parsed `until` reaches the host as a Date', handed.length === 1 && (handed[0] as { until: Date }).until instanceof Date)
await tool!.run({ cancel: true }, fakeHost)
check('cancel reaches the host as cancel', handed.length === 2 && (handed[1] as { cancel: boolean }).cancel === true)

console.log('\n— the host (source contract on runOnce) —')
const run = src('src/core/runner/runOnce.ts')
check('refuses a wake time that is not in the future', /rule: 'sleep\.notFuture'/.test(run) && /!\(until\.getTime\(\) > nowMs\)/.test(run))
check('refuses more than MAX_SLEEP_DAYS and says the cap', /rule: 'sleep\.tooFar'/.test(run) && /days > MAX_SLEEP_DAYS/.test(run) && /the longest sleep is \$\{MAX_SLEEP_DAYS\} days/.test(run))
check('refuses a paused/retired agent', /rule: 'sleep\.notRunning'/.test(run))
check('a sleep is stored with until/reason/setAt and the LIFECYCLE note is posted as a schedule note', /patch\(\{ sleep: \{ until: until\.toISOString\(\), reason, setAt: now\(\)\.toISOString\(\) \} \}\)/.test(run) && /kind: 'schedule', text: LIFECYCLE\.sleeping\(/.test(run))
check('cancel clears it and posts the back-on-schedule note', /await patch\(\{ sleep: undefined \}\)\s*await post\(\{ role: 'system', kind: 'schedule', text: LIFECYCLE\.sleepCancelled\(/.test(run))
check('run START: an expired sleep is cleared with the awake note, whatever the trigger', /if \(!activeSleep\(state, now\(\)\)\) \{\s*state = \{ \.\.\.state, sleep: undefined \}\s*await saveState\(\)\s*await post\(\{ role: 'system', kind: 'schedule', text: LIFECYCLE\.awake\(/.test(run))
check('run START: a schedule wake-up while still asleep is a no-op', /\} else if \(req\.trigger === 'schedule'\) \{\s*log\('info', `schedule wake-up while asleep/.test(run))
check('...and nothing clears a sleep in force on reply/manual/approval/plan/watch/timeout runs', (run.match(/sleep: undefined/g) ?? []).length === 2)
check('both settle paths take the next instant from nextWakeAt', (run.match(/nextWakeAt\(cfg, state!?, endedAt\)/g) ?? []).length === 2 && !/nextRunAt\(cfg\.schedule/.test(run))

console.log('\n— the prompt —')
check('the rules block says to sleep_until a dated event', /`sleep_until` it/.test(src('src/core/runner/prompts.ts')))
// sleepBlock reads the real clock, so this sleep is dated from it rather than from the fixture's `now`.
const asleepNow: AgentState = { ...base, sleep: { until: new Date(Date.now() + 20 * 86_400_000).toISOString(), reason: 'AAPL reports Oct 30', setAt: new Date().toISOString() } }
const block = sleepBlock(asleepNow, 'reply')
check('a reply run while asleep is told so, with the reason', /YOU ARE ASLEEP/.test(block) && /AAPL reports Oct 30/.test(block) && /the operator/.test(block))
check('an awake agent gets no block', sleepBlock(base, 'reply') === '')

console.log('\n— notes and headers —')
check('sleepNote names the ET time and the reason', sleepNote(future, 'why') === `💤 Sleeping until ${formatEt(future, true)} — why. Messages and price watches still wake it.` && LIFECYCLE.sleeping === sleepNote)
check('sleepStatusText', sleepStatusText(future) === `Sleeping until ${formatEt(future, true)}`)
check('the shared modules are Node-free', !/from 'node:/.test(src('src/shared/sleep.ts')) && !/from 'node:/.test(src('src/shared/schedule.ts')))

console.log('\n— every writer passes the state (source contract) —')
for (const [file, n, bare] of [
  ['src/main/engine/Engine.ts', 1, 0]
] as const) {
  const text = src(file)
  // One level of nested parens, for the `new Date()` argument.
  const calls = text.match(/armedState\((?:[^()]|\([^()]*\))*\)/g) ?? []
  const withState = calls.filter((c) => /new Date\(\), (st|s|state|a\.state)\)$/.test(c))
  check(`${file}: ${n} armedState call(s), ${n - bare} with state`, calls.length === n && withState.length === n - bare, calls.join(' | '))
}
check('Engine.arm judges lateness with the state', /catchUpDecision\(cfg\.schedule, due, new Date\(\), st\)/.test(src('src/main/engine/Engine.ts')))

console.log('\n— the engine timer guard (source contract) —')
const eng = src('src/main/engine/Engine.ts')
check('one timer helper re-arms when it fires early', /function timerFor\(atMs: number, fire: \(\) => void, again: \(\) => void\)/.test(eng) && /atMs - Date\.now\(\) > TIMER_EARLY_MS \? again\(\) : fire\(\)/.test(eng))
check('...clamped to MAX_TIMEOUT_MS', /Math\.min\(MAX_TIMEOUT_MS, atMs - Date\.now\(\)\)/.test(eng) && /const MAX_TIMEOUT_MS = 2 \*\* 31 - 1/.test(eng))
check('all three far-future timers use it (schedule, question, retirement)', (eng.match(/= timerFor\(/g) ?? []).length === 3 && !/Math\.min\(2 \*\* 31 - 1/.test(eng))
check('the schedule timer re-arms through arm() (keeps the pending wake-up)', /\(\) => this\.arm\(\)\s*\)/.test(eng))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
