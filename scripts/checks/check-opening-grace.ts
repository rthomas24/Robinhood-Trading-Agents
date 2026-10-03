/**
 * `armAfterMin` — the trail is not judged until N minutes after the open; the
 * hard stop and target still are.
 *
 * Run: `npm run check -- opening-grace`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, describeExitPlan, emptyLedger, initialState, type AgentConfig, type AgentState, type ExitPlan } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { enforceExits } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const cfg = { id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null } as unknown as AgentConfig
const holding = (plan: ExitPlan): AgentState => ({ ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(9_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }] }, exits: { MU: plan } })
const q = (last: number): Quote[] => [{ symbol: 'MU', last, bid: last, ask: last, ts: 'x' }]
const at = (hhmm: string): Date => etDateTime('2026-09-03', Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)))

async function main(): Promise<void> {
  // Trail 5% off a 110 high sells at 104.5; 103 is through it.
  const graced = await enforceExits({ config: cfg, state: holding({ trail: { pct: 5, high: 110 }, armAfterMin: 30, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(103), now: at('09:45') })
  check('inside the grace the trail does NOT sell', graced.results.length === 0)
  check('but it still ratchets (the high is engine truth either way)', (await enforceExits({ config: cfg, state: holding({ trail: { pct: 5, high: 110 }, armAfterMin: 30, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(120), now: at('09:45') })).state.exits.MU?.trail?.high === 120)
  const armed = await enforceExits({ config: cfg, state: holding({ trail: { pct: 5, high: 110 }, armAfterMin: 30, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(103), now: at('10:00') })
  check('at armAfterMin the trail is live', armed.results.length === 1 && armed.results[0].action.exitTrigger?.kind === 'trail', armed.results[0]?.action.reason)
  const hard = await enforceExits({ config: cfg, state: holding({ stop: 104, trail: { pct: 5, high: 110 }, armAfterMin: 30, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(103), now: at('09:45') })
  check('the HARD stop still fires inside the grace', hard.results.length === 1 && hard.results[0].action.exitTrigger?.kind === 'stop')
  const target = await enforceExits({ config: cfg, state: holding({ target: 112, trail: { pct: 5, high: 110 }, armAfterMin: 30, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(113), now: at('09:45') })
  check('and so does the target', target.results.length === 1 && target.results[0].action.exitTrigger?.kind === 'target')
  const zero = await enforceExits({ config: cfg, state: holding({ trail: { pct: 5, high: 110 }, armAfterMin: 0, setAt: 'x' }), rh: null, accountNumber: null, quotes: q(103), now: at('09:31') })
  check('0 / absent = the old behaviour (live from the first sweep)', zero.results.length === 1)
  check('describeExitPlan names the grace', /live 30 min after the open/.test(describeExitPlan({ trailPct: 5, armAfterMin: 30 })))
  const tools = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/agentTools.ts'), 'utf8')
  check('trade and set_exit expose armAfterMin (one shared field set)', /armAfterMin: lenientNumber/.test(tools) && (tools.match(/\.\.\.exitLevelFields/g) ?? []).length === 2)
  const prompts = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/prompts.ts'), 'utf8')
  check('the system prompt explains it once', (prompts.match(/\\`armAfterMin\\`/g) ?? []).length === 1)
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
