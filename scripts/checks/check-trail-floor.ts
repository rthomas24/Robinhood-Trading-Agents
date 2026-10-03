/**
 * A trail narrower than the name's ordinary daily swing is answered with the
 * numbers, never placed silently.
 *
 * The contract: `trailTooTight()` is null at or above `TRAIL_FLOOR_FACTOR × ADR`
 * and an advisory below it; the advisory names the trail, the range and the
 * floor and asks for `acknowledgeTight`; `analyzeSymbol` computes ATR-14 and
 * the average daily range from bars; and the run host consults the rule on
 * `trade` AND `set_exit`, auditing it as `exit.trailTooTight`.
 *
 * Run: `npm run check -- trail-floor`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TRAIL_FLOOR_FACTOR, trailFloorPct, trailTooTight } from '@shared/agents'
import { analyzeSymbol, atr, averageDailyRangePct } from '@core/runner/indicators'
import type { Bar } from '@core/robinhood/api'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('— the rule —')
check('the factor is 0.75 to start', TRAIL_FLOOR_FACTOR === 0.75)
check('a 3.2% ADR name floors at 2.4%', trailFloorPct(3.2) === 2.4, `got ${trailFloorPct(3.2)}`)
const tight = trailTooTight('MU', 1.5, 3.2)
check('1.5% on a 3.2% ADR name is too tight', tight !== null)
check('the advisory names the trail, the range and the floor', /1\.5%/.test(tight ?? '') && /3\.20%/.test(tight ?? '') && /2\.4%/.test(tight ?? ''), (tight ?? '').slice(0, 120))
check('and asks for acknowledgeTight rather than refusing outright', /acknowledgeTight: true/.test(tight ?? ''))
check('2.4% (exactly the floor) passes', trailTooTight('MU', 2.4, 3.2) === null)
check('no trail → nothing to say', trailTooTight('MU', undefined, 3.2) === null)
check('unknown range → never held up', trailTooTight('MU', 0.5, null) === null && trailTooTight('MU', 0.5, 0) === null)

console.log('\n— the technicals —')
// 20 daily bars stepping up 1/day with a 3-point range on a ~100 base.
const day: Bar[] = Array.from({ length: 20 }, (_, i) => ({ t: 1_700_000_000 + i * 86_400, o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i, v: 1_000 }))
const a = atr(day)
check('ATR-14 over daily bars is the true range (3 here)', a !== null && Math.abs(a - 3) < 1e-9, `got ${a}`)
const adr = averageDailyRangePct(day)
check('ADR% is mean (h−l)/c over the last 14', adr !== null && adr > 2.5 && adr < 3.1, `got ${adr?.toFixed(3)}%`)
check('too few bars → null, not a guess', atr(day.slice(0, 5)) === null)
const s = analyzeSymbol('MU', day, [])
check('analyzeSymbol carries atr14 and dailyRangePct', s.atr14 !== null && s.dailyRangePct !== null)

console.log('\n— the host consults it (source contract) —')
const runOnce = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/runOnce.ts'), 'utf8')
check('runOnce audits exit.trailTooTight', /rule: 'exit\.trailTooTight'/.test(runOnce))
// The all-in playbook may resize the intent first; the floor is checked on what will actually be sent.
check('the trade host checks the floor before executing', /async trade\(intent\) \{[\s\S]{0,400}?if \(intent\.side === 'buy'\) \{\s*(await ensureTechnicals\(intent\.symbol\)\s*)?const tight = trailFloorAdvisory/.test(runOnce))
check('set_exit checks it too', /trailFloorAdvisory\(tbToolName\('set_exit'\)/.test(runOnce))
const tools = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/agentTools.ts'), 'utf8')
check('both tools expose acknowledgeTight', (tools.match(/acknowledgeTight: lenientBoolean/g) ?? []).length === 2)
const mc = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/marketContext.ts'), 'utf8')
check('TECHNICALS renders ATR14 and the ADR with its floor', /ATR14/.test(mc) && /trail floor/.test(mc))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
