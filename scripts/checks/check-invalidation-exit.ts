/**
 * `stopIf` — "cut it if it loses X" as a level the sweep enforces like a hard
 * stop, reported with the agent's own reason.
 * It replaces the watch → run → sell pattern, which spent a wake-up and a model
 * call to do what a stop does in code, and often did it late.
 *
 * Run: `npm run check -- invalidation-exit`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, describeExitPlan, effectiveStop, emptyLedger, initialState, type AgentConfig, type AgentState, type ExitPlan } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { enforceExits } from '@core/broker/execute'
import { checkGuardrails } from '@core/broker/guardrails'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const cfg = { id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null } as unknown as AgentConfig
const holding = (plan: ExitPlan): AgentState => ({ ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(9_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }] }, exits: { MU: plan } })
const q = (last: number): Quote[] => [{ symbol: 'MU', last, bid: last, ask: last, ts: 'x' }]
const now = etDateTime('2026-09-03', 11 * 60)

async function main(): Promise<void> {
  const plan: ExitPlan = { stopIf: { below: 97, reason: 'thesis needs the 97 breakout level to hold' }, setAt: 'x' }
  check('the invalidation level IS the effective stop', effectiveStop(plan) === 97)
  const hit = await enforceExits({ config: cfg, state: holding(plan), rh: null, accountNumber: null, quotes: q(96.5), now })
  check('breaching it sells the whole position', hit.results.length === 1 && hit.results[0].action.fillQty === 10)
  check('the reason is the agent\'s, not "stop hit"', /Invalidation: thesis needs the 97 breakout level to hold/.test(hit.results[0]?.action.reason ?? ''), hit.results[0]?.action.reason)
  check('the trigger kind says invalidation', hit.results[0]?.action.exitTrigger?.kind === 'invalidation' && hit.results[0]?.action.exitTrigger?.level === 97)
  check('above the level nothing happens', (await enforceExits({ config: cfg, state: holding(plan), rh: null, accountNumber: null, quotes: q(98), now })).results.length === 0)
  const tighter = await enforceExits({ config: cfg, state: holding({ stop: 95, stopIf: { below: 97, reason: 'r' }, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(96.5), now })
  check('the TIGHTER of stop and invalidation binds, and is named', tighter.results[0]?.action.exitTrigger?.kind === 'invalidation')
  const above = await enforceExits({ config: cfg, state: holding({ stopIf: { above: 104, reason: 'a break above 104 means the short-squeeze thesis is wrong' }, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(104.5), now })
  check('the symmetric `above` level sells too', above.results.length === 1 && />= \$104/.test(above.results[0].action.reason))
  check('describeExitPlan reads it', /cut below \$97\.00 \(thesis needs/.test(describeExitPlan(plan)))

  console.log('\n— entry-time coherence —')
  const buy = (extra: Record<string, unknown>) => checkGuardrails({ config: cfg, state: initialState({ allocationUsd: 10_000 }), intent: { side: 'buy', symbol: 'MU', qty: 1, type: 'market', tif: 'day', reason: 'x', ...extra } as never, refPrice: 100, now })
  check('an invalidation ABOVE the market is refused like a breached stop', buy({ stopIf: { below: 101, reason: 'r' } }).rule === 'exit.invalidLevel')
  check('an `above` level BELOW the market is refused', buy({ stopIf: { above: 99, reason: 'r' } }).rule === 'exit.invalidLevel')
  check('a coherent one passes', buy({ stopIf: { below: 97, reason: 'r' } }).ok)
  const tools = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/agentTools.ts'), 'utf8')
  check('trade and set_exit expose stopIfBelow/stopIfAbove/stopIfReason', /stopIfBelow: lenientNumber/.test(tools) && /stopIfAbove: lenientNumber/.test(tools) && /stopIfReason: (?:z|lenientString)/.test(tools))
  const prompts = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/prompts.ts'), 'utf8')
  check('the prompt says it replaces the watch → run → sell pattern', /NOT a price watch that wakes you to sell/.test(prompts))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
