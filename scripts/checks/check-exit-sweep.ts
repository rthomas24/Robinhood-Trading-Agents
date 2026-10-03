/**
 * Three things that can go silently wrong about exits in a price sweep, each
 * asserted directly rather than reasoned about.
 *
 * All of them share one root: exits pre-filtered like watches, on "has a
 * price level been touched?". That is right for a watch, which IS a price
 * condition, and wrong for an exit, which carries state that has to move on
 * ticks where nothing fires.
 *
 * Run: `npm run check -- exit-sweep`
 */
import { DEFAULT_GUARDRAILS, emptyLedger, initialState, type AgentConfig, type AgentState, type ExitPlan } from '@shared/agents'
import { enforceExits } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// A paper agent with real guardrails: a protective sell still goes through
// checkGuardrails, and a stub without them fails inside the thing under test.
const cfg = {
  id: 'ag_test',
  name: 'Test',
  mode: 'paper',
  allocationUsd: 10_000,
  guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 100_000, maxPositionNotional: 100_000 },
  liveArmedAt: null
} as unknown as AgentConfig

/** An agent holding 10 MU at $100, with the given exit plan. */
function agentHolding(plan: ExitPlan): AgentState {
  const base = initialState({ allocationUsd: 10_000 })
  return {
    ...base,
    paper: { ...emptyLedger(9_000), positions: [{ symbol: 'MU', qty: 10, avgCost: 100 }] },
    exits: { MU: plan }
  }
}
const quote = (last: number): Quote[] => [{ symbol: 'MU', last, ts: new Date().toISOString() }]

// ── 1. The trail must RATCHET on a tick where nothing sells ───────────────
// This is the one that would make a trailing stop silently a FIXED stop: `high`
// only rises inside enforceExits, so if the sweep only ran it on a breach, the
// high would never advance — while the prompt says the engine keeps watching.
{
  const state = agentHolding({ trail: { pct: 5, high: 100 }, setAt: 'x' })
  const ex = await enforceExits({ config: cfg, state, rh: null, accountNumber: null, quotes: quote(120) })
  const high = ex.state.exits.MU?.trail?.high
  check('a rising price ratchets the trail', high === 120, `high 100 → ${high}`)
  check('nothing was sold doing it', ex.results.length === 0)
  // The sweep persists on this — it used to write only when something sold, so
  // even once served, the new high was computed and thrown away.
  check('the ratchet is a NEW state object, so the sweep can detect it', ex.state !== state, 'identity is what `ex.state !== state` keys on')
}

// ── 2. A trail-only plan must actually fire ───────────────────────────────
// The old pre-filter read plan.stop directly and never consulted plan.trail, so
// a trail-only plan read as untouched always and was never even served.
{
  const state = agentHolding({ trail: { pct: 5, high: 120 }, setAt: 'x' })
  // 5% below a 120 high is 114; 113 is through it.
  const ex = await enforceExits({ config: cfg, state, rh: null, accountNumber: null, quotes: quote(113) })
  check('a breached trail-only plan sells', ex.results.length === 1, ex.results[0]?.action.reason ?? 'nothing sold')
  check('and says it was the TRAILING stop', /Trailing stop/.test(ex.results[0]?.action.reason ?? ''), ex.results[0]?.action.reason ?? '')
}

// ── 3. A plan on a position that is gone must be cleaned up ───────────────
// enforceExits is the ONLY thing that ever drops one. Price-gating meant a dead
// plan leaked forever and the agent went on being told it was protected.
{
  const base = agentHolding({ stop: 90, setAt: 'x' })
  const state: AgentState = { ...base, paper: { ...base.paper, positions: [] } }
  const ex = await enforceExits({ config: cfg, state, rh: null, accountNumber: null, quotes: quote(150) })
  check('a plan on a closed position is dropped', ex.state.exits.MU === undefined, 'price nowhere near the stop, so only the cleanup path can do this')
  check('the cleanup is a new state object too', ex.state !== state)
}

// ── 4. A quiet tick must NOT churn the row ────────────────────────────────
// The sweep now serves every exits-bearing agent each pass, so "nothing changed"
// has to be detectable or it would write on every agent every minute.
{
  const state = agentHolding({ stop: 90, setAt: 'x' })
  const ex = await enforceExits({ config: cfg, state, rh: null, accountNumber: null, quotes: quote(100) })
  check('an untouched fixed stop leaves state identical', ex.state === state, 'so the sweep skips the write')
}

// ── 5. Broker-owned plans are not ours to enforce ─────────────────────────
{
  const state = agentHolding({ stop: 120, enforcedBy: 'broker', setAt: 'x' } as ExitPlan)
  const ex = await enforceExits({ config: cfg, state, rh: null, accountNumber: null, quotes: quote(100) })
  check('a broker-owned stop is never double-sold', ex.results.length === 0, 'a resting order owns it; selling here too would naked-short')
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
