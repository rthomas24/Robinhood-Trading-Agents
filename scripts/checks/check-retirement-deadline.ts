/**
 * A deadline retirement fires AT the deadline, and a retirement that cannot
 * flatten does not retire (and every time it names is ET).
 *
 *   on time      `armRetirementTimer` wakes the agent at the deadline with
 *                trigger `timeout`; `runOnce` lets a `timeout` through to the
 *                retirement check when a deadline is due.
 *   refuse       `executeRetirement` returns `retired: false` + the open
 *                positions when any flatten sell is refused or the market is
 *                closed; the engine posts an important note and keeps exits
 *                armed.
 *
 * Run: `npm run check -- retirement-deadline`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, emptyLedger, initialState, type AgentConfig, type AgentState } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { cannotFlattenNote, executeRetirement, retirementDue } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'
import type { DecisionInput } from '@shared/decisions'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const src = (p: string): string => readFileSync(resolve(import.meta.dirname, '../../', p), 'utf8')
const cfg = (retirement: AgentConfig['retirement']): AgentConfig => ({ id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null, retirement }) as unknown as AgentConfig
const holding = (): AgentState => ({ ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(9_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }] }, exits: { MU: { stop: 95, setAt: 'x' } } })
const open = etDateTime('2026-09-03', 11 * 60)
const closed = etDateTime('2026-09-03', 20 * 60)

async function main(): Promise<void> {
  console.log('— the deadline is judged in ET —')
  const due = retirementDue(cfg({ at: '2026-09-03T15:00:00Z' }), holding(), [], open)
  check('a passed deadline is due, and the reason reads in ET', due !== null && / ET\)/.test(due) && !/GMT|UTC/.test(due), due ?? 'null')
  check('a future deadline is not', retirementDue(cfg({ at: '2026-09-03T20:00:00Z' }), holding(), [], open) === null)

  console.log('\n— refuse to retire when the book cannot be flattened —')
  const audits: DecisionInput[] = []
  const noQuote = await executeRetirement({ config: cfg({ at: 'x' }), state: holding(), rh: null, accountNumber: null, quotes: [], now: open, audit: (d) => audits.push(d) }, 'Deadline reached', open)
  check('no quote → the flatten is refused and the agent is NOT retired', noQuote.retired === false && noQuote.state.status !== 'retired')
  check('it says which positions are open and why', noQuote.open?.length === 1 && noQuote.open[0].symbol === 'MU' && /price|quote/i.test(noQuote.open[0].why), JSON.stringify(noQuote.open))
  check('exits stay armed', noQuote.state.exits.MU?.stop === 95)
  check('and it is audited as retire.cannotFlatten', audits.some((a) => a.rule === 'retire.cannotFlatten'))
  const shut = await executeRetirement({ config: cfg({ at: 'x' }), state: holding(), rh: null, accountNumber: null, quotes: [{ symbol: 'MU', last: 100, bid: 100, ask: 100, ts: 'x' } as Quote], now: closed }, 'Deadline reached', closed)
  check('a paper book after hours is refused by the session guardrail and NOT retired (it used to retire open)', shut.retired === false && /regular session/i.test(shut.open?.[0]?.why ?? ''), JSON.stringify(shut.open))
  const liveShut = await executeRetirement({ config: { ...cfg({ at: 'x' }), mode: 'live', liveArmedAt: 'x' } as AgentConfig, state: { ...holding(), live: holding().paper }, rh: null, accountNumber: null, quotes: [], now: closed }, 'Deadline reached', closed)
  check('a LIVE book after hours is kept alive, not retired open', liveShut.retired === false && /market is closed/.test(liveShut.open?.[0]?.why ?? ''))
  const ok = await executeRetirement({ config: cfg({ at: 'x' }), state: holding(), rh: null, accountNumber: null, quotes: [{ symbol: 'MU', last: 100, bid: 100, ask: 100, ts: 'x' } as Quote], now: open }, 'Deadline reached', open)
  check('with a price it flattens and retires', ok.retired === true && ok.state.status === 'retired' && ok.results[0]?.action.status === 'filled')
  const flat = await executeRetirement({ config: cfg({ at: 'x' }), state: initialState({ allocationUsd: 10_000 }), rh: null, accountNumber: null, quotes: [], now: closed }, 'Deadline reached', closed)
  check('a flat book retires whenever', flat.retired === true)
  const noFlatten = await executeRetirement({ config: cfg({ at: 'x', flatten: false }), state: holding(), rh: null, accountNumber: null, quotes: [], now: open }, 'Deadline reached', open)
  check('flatten:false retires holding, as before', noFlatten.retired === true)
  check('the note names the positions and says exits stay armed', /10 MU/.test(cannotFlattenNote('r', noQuote.open ?? [])) && /Exits stay armed/.test(cannotFlattenNote('r', noQuote.open ?? [])))

  console.log('\n— on time (source contracts) —')
  const runOnce = src('src/core/runner/runOnce.ts')
  check('runOnce lets a timeout wake-up through when a deadline is due', /req\.trigger === 'timeout' && !retirementDue\(cfg, state, \[\], now\(\)\)/.test(runOnce))
  check('runOnce posts the note (important unless a repeat) and keeps the agent alive', /if \(!ret\.retired\) \{[\s\S]{0,600}\.\.\.\(ret\.repeat \? \{\} : \{ notify: 'important' as const \}\), text: cannotFlattenNote\(dueReason/.test(runOnce))
  check('the retire tool tells the model it is NOT retired', /NOT retired: the book could not be flattened/.test(runOnce))
  const engine = src('src/main/engine/Engine.ts')
  check('the engine arms a timer at the shared wake instant (retirementWakeAt), not at retirement.at', /armRetirementTimer\(\): void/.test(engine) && /retirementWakeAt\(cfg, st, new Date\(\)\)/.test(engine) && !/Date\.parse\(cfg\.retirement\.at\)/.test(engine) && /this\.request\(\{ trigger: 'timeout' \}\)/.test(engine))
  check('re-armed with the schedule and cleared on pause/dispose', /this\.armQuestionTimer\(\)\s*this\.armRetirementTimer\(\)/.test(engine) && (engine.match(/clearTimeout\(this\.retireTimer\)/g) ?? []).length >= 3)
  check('the operator\'s own Retire also refuses honestly', /cannotFlattenNote\(reason, ret\.open \?\? \[\]\), ret\.repeat \? undefined : 'important'\)/.test(engine))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
