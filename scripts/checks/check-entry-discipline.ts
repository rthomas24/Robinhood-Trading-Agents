/**
 * Entry discipline: five BUY-ONLY guardrails, each with its own rule key, each
 * absent on every agent made before it existed.
 *
 *   noEntriesBeforeEt      entry.beforeWindow    (default 09:45, interval agents)
 *   maxEntryExtensionPct   entry.extended        (above VWAP or the day open)
 *   maxSymbolDayPct        cap.symbolDay + cap.symbolRun (one buy per symbol per run)
 *   reentryCooldownMin     entry.cooldown        (default 30; names the prior loss)
 *   maxNewPositionsPerRun  cap.newPositionsPerRun (default 1; counted under the lane)
 *
 * Run: `npm run check -- entry-discipline`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, applyPlanToConfig, clampGuardrails, entryDefaultsFor, guardrailDiff, initialState, type AgentConfig, type AgentState, type Guardrails } from '@shared/agents'
import { configFromCreateRequest } from '@shared/createAgent'
import { etDateTime } from '@shared/marketTime'
import { checkGuardrails } from '@core/broker/guardrails'
import { entryRuleLines } from '@core/runner/prompts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const AT = (hhmm: string): Date => etDateTime('2026-09-03', Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)))
const config = (g: Partial<Guardrails>): AgentConfig => ({ id: 'ag', mode: 'paper', allocationUsd: 10_000, liveArmedAt: null, schedule: { kind: 'interval', everyMinutes: 5, marketHoursOnly: true }, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 10_000, maxPositionNotional: 10_000, ...g }, createdAt: 'x', updatedAt: 'x', task: 't' }) as AgentConfig
const state = (): AgentState => initialState({ allocationUsd: 10_000 })
const buy = (extra: Record<string, unknown> = {}) => ({ side: 'buy', symbol: 'MU', qty: 5, type: 'market', tif: 'day', reason: 'x', ...extra })
const guard = (g: Partial<Guardrails>, intent: Record<string, unknown>, opts: Record<string, unknown> = {}, st: AgentState = state()) =>
  checkGuardrails({ config: config(g), state: st, intent: intent as never, refPrice: 100, now: AT('10:00'), ...opts })

console.log('— 8. opening window —')
check('a buy at 09:35 is refused before 09:45', guard({ noEntriesBeforeEt: '09:45' }, buy(), { now: AT('09:35') }).rule === 'entry.beforeWindow')
check('the reason says how long to wait', /10 min to go/.test(guard({ noEntriesBeforeEt: '09:45' }, buy(), { now: AT('09:35') }).reason ?? ''))
check('at 09:45 it passes', guard({ noEntriesBeforeEt: '09:45' }, buy(), { now: AT('09:45') }).ok)
check('a SELL at 09:35 is untouched', guard({ noEntriesBeforeEt: '09:45' }, { ...buy({ side: 'sell' }) }, { now: AT('09:35') }, { ...state(), paper: { ...state().paper, positions: [{ symbol: 'MU', qty: 5, avgCost: 90 }] } }).ok)
check('absent = no rule (an old agent buys at 09:31)', guard({}, buy(), { now: AT('09:31') }).ok)

console.log('\n— 9. extension —')
check('3% above VWAP with a 2% cap is refused', guard({ maxEntryExtensionPct: 2 }, buy(), { technicals: { vwap: 97, dayOpen: 99 } }).rule === 'entry.extended')
check('the reason quotes both distances', /vs VWAP/.test(guard({ maxEntryExtensionPct: 2 }, buy(), { technicals: { vwap: 97, dayOpen: 99 } }).reason ?? ''))
check('3% above the OPEN alone is enough', guard({ maxEntryExtensionPct: 2 }, buy(), { technicals: { vwap: 100, dayOpen: 97 } }).rule === 'entry.extended')
check('inside the cap it passes', guard({ maxEntryExtensionPct: 2 }, buy(), { technicals: { vwap: 99, dayOpen: 99.5 } }).ok)
check('no technicals this run → the rule does not fire (never refuse on a guess)', guard({ maxEntryExtensionPct: 2 }, buy(), { technicals: null }).ok)

console.log('\n— 10. per-symbol day budget + one buy per symbol per run —')
const bought = (): AgentState => ({ ...state(), paper: { ...state().paper, fills: [{ id: 'f1', ts: AT('09:50').toISOString(), symbol: 'MU', side: 'buy', qty: 15, price: 100, realized: 0 }] } })
check('$1,500 bought + $500 more passes a 20% ($2,000) budget', guard({ maxSymbolDayPct: 20 }, buy(), {}, bought()).ok)
check('$1,500 + $600 is refused', guard({ maxSymbolDayPct: 20 }, buy({ qty: 6 }), {}, bought()).rule === 'cap.symbolDay')
check('the reason says what is left', /\$500\.00 of it is left/.test(guard({ maxSymbolDayPct: 20 }, buy({ qty: 6 }), {}, bought()).reason ?? ''))
check('a second buy of the same symbol in one run is refused', guard({ maxSymbolDayPct: 20 }, buy(), { run: { newPositions: 1, boughtSymbols: ['MU'] } }).rule === 'cap.symbolRun')
check('a different symbol this run is fine', guard({ maxSymbolDayPct: 20 }, buy({ symbol: 'AMD' }), { run: { newPositions: 1, boughtSymbols: ['MU'] } }).ok)

console.log('\n— 11. re-entry cooldown —')
const lost = (): AgentState => ({ ...state(), paper: { ...state().paper, fills: [{ id: 'f1', ts: AT('09:50').toISOString(), symbol: 'MU', side: 'sell', qty: 5, price: 95, realized: -25 }] } })
const cool = guard({ reentryCooldownMin: 30 }, buy(), {}, lost())
check('a buy 10 min after a losing sell is refused', cool.rule === 'entry.cooldown')
check('the refusal names the prior loss and the wait', /-\$25\.00/.test(cool.reason ?? '') && /20 min to go/.test(cool.reason ?? ''), cool.reason)
check('31 min later it passes', guard({ reentryCooldownMin: 30 }, buy(), { now: AT('10:21') }, lost()).ok)
const won = (): AgentState => ({ ...state(), paper: { ...state().paper, fills: [{ id: 'f1', ts: AT('09:50').toISOString(), symbol: 'MU', side: 'sell', qty: 5, price: 105, realized: 25 }] } })
check('a WINNING sell starts no cooldown', guard({ reentryCooldownMin: 30 }, buy(), {}, won()).ok)

console.log('\n— 12. new positions per run —')
check('the second NEW name in a run is refused at cap 1', guard({ maxNewPositionsPerRun: 1 }, buy({ symbol: 'AMD' }), { run: { newPositions: 1, boughtSymbols: ['MU'] } }).rule === 'cap.newPositionsPerRun')
check('an ADD to a held name is not a new position', guard({ maxNewPositionsPerRun: 1 }, buy(), { run: { newPositions: 1, boughtSymbols: ['AMD'] } }, { ...state(), paper: { ...state().paper, positions: [{ symbol: 'MU', qty: 5, avgCost: 90 }] } }).ok)
check('no run scope (a sweep) → the rule does not fire', guard({ maxNewPositionsPerRun: 1 }, buy()).ok)
const runOnce = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/runOnce.ts'), 'utf8')
check('the host counts under the lane, after the fill', /const runBuys = \{ newPositions: 0, boughtSymbols: \[\] as string\[\] \}/.test(runOnce) && /if \(heldBefore <= 1e-9\) runBuys\.newPositions\+\+/.test(runOnce))
check('and hands the counters to every trade', /run: runBuys,/.test(runOnce))

console.log('\n— defaults, clamp, diff, prompt, settings —')
const fresh = configFromCreateRequest({ name: 'a', icon: 'cube', color: 'blue', task: 'buy MU dips', mode: 'paper', allocationUsd: 5_000 } as never, { vendor: 'claude', id: 'x', effort: 'low' })
check('a new agent gets cooldown 30 and 1 new position per run', fresh.guardrails.reentryCooldownMin === 30 && fresh.guardrails.maxNewPositionsPerRun === 1)
check('but no opening window until it is an interval agent', fresh.guardrails.noEntriesBeforeEt === undefined)
const planned = applyPlanToConfig(fresh, { schedule: { kind: 'interval', everyMinutes: 5, marketHoursOnly: true }, guardrails: {}, summary: 's' }, 'now')
check('the setup run choosing interval adds 09:45', planned.guardrails.noEntriesBeforeEt === '09:45')
const times = applyPlanToConfig(fresh, { schedule: { kind: 'times', times: ['09:31'], days: ['Mon'], tradingDaysOnly: true }, guardrails: {}, summary: 's' }, 'now')
check('a times agent gets none (09:31 was asked for)', times.guardrails.noEntriesBeforeEt === undefined)
const old = { ...fresh, guardrails: { ...DEFAULT_GUARDRAILS } }
const oldPlanned = applyPlanToConfig(old, { schedule: { kind: 'interval', everyMinutes: 5, marketHoursOnly: true }, guardrails: {}, summary: 's' }, 'now')
check('an agent from before the rules never acquires the window', oldPlanned.guardrails.noEntriesBeforeEt === undefined)
check('entryDefaultsFor(interval) carries all three', entryDefaultsFor({ kind: 'interval', everyMinutes: 5, marketHoursOnly: true }).noEntriesBeforeEt === '09:45')
const clamped = clampGuardrails({ maxSymbolDayPct: 400, reentryCooldownMin: -5, maxNewPositionsPerRun: 0, noEntriesBeforeEt: 'nine' }, 10_000)
check('clampGuardrails bounds them to meaningful values', clamped.maxSymbolDayPct === 100 && clamped.reentryCooldownMin === 0 && clamped.maxNewPositionsPerRun === 1 && clamped.noEntriesBeforeEt === undefined)
const diff = guardrailDiff({ ...DEFAULT_GUARDRAILS, reentryCooldownMin: 30, maxNewPositionsPerRun: 1 }, { reentryCooldownMin: 10, maxNewPositionsPerRun: 3, noEntriesBeforeEt: undefined })
check('shortening the cooldown and raising the per-run cap read as LOOSER', diff.find((d) => d.key === 'reentryCooldownMin')?.looser === true && diff.find((d) => d.key === 'maxNewPositionsPerRun')?.looser === true)
check('removing a rule that did not exist is not a change', !diff.some((d) => d.key === 'noEntriesBeforeEt'))
const lines = entryRuleLines(config({ noEntriesBeforeEt: '09:45', reentryCooldownMin: 30, maxNewPositionsPerRun: 1, maxSymbolDayPct: 20, maxEntryExtensionPct: 2 }), lost().paper, AT('09:40'))
check('HEADROOM states every rule before the agent tries', lines.length === 5 && /NO BUYS before 09:45 ET \(5 min from now\)/.test(lines[0]) && /blocked now: MU until/.test(lines.join('\n')), lines.join(' | ').slice(0, 200))
const sheet = readFileSync(resolve(import.meta.dirname, '../../src/renderer/src/components/sheets/AgentSettingsSheet.tsx'), 'utf8')
check('the settings sheet edits all five', ['noEntriesBeforeEt', 'maxEntryExtensionPct', 'maxSymbolDayPct', 'reentryCooldownMin', 'maxNewPositionsPerRun'].every((k) => sheet.includes(`${k}:`)))
const tools = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/agentTools.ts'), 'utf8')
check('change_plan exposes all five (nullable = remove)', ['noEntriesBeforeEt', 'maxEntryExtensionPct', 'maxSymbolDayPct', 'reentryCooldownMin', 'maxNewPositionsPerRun'].every((k) => new RegExp(`${k}: (lenientNumber\\()?z\\.[\\s\\S]{0,120}nullable\\(\\)`).test(tools)))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
