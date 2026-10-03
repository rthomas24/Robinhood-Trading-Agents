/**
 * The decision log records the ENGINE's refusals, not just the model's.
 *
 * `src/shared/decisions.ts` says the log exists to answer "why didn't it sell at
 * 3:58?", and that the deciding rule is recorded "at the point it decides, so
 * the log and the engine can never drift apart". It could not answer that about
 * a protective sell: `enforceExits` and `executeRetirement` call `executeTrade`
 * directly, `executeTrade` never audited, and the runner only audits calls the
 * MODEL made. A stop refused by `session.closed` or `price.missing` was refused
 * in silence — the one case the log's own motivating example names.
 *
 * The sink is optional by design, so a host that passes nothing behaves exactly
 * as before. That makes these assertions the only proof it works until the
 * `Engine` and `deps` legs are wired; without them this would be one more guard
 * that is written, documented, and never reached.
 *
 * Run: `npm run check -- decision-audit`
 */
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState } from '@shared/agents'
import { enforceExits, executeTrade, ENGINE_PROTECTIVE_EXIT, ENGINE_TRADE } from '@core/broker/execute'
import type { DecisionInput } from '@shared/decisions'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const NOW = new Date('2026-08-24T14:00:00Z') // Monday 10:00 ET
const CLOSED = new Date('2026-08-24T02:00:00Z') // Monday 22:00 ET — market shut
const MARK = 358

const config = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({ mode: 'paper', allocationUsd: 100_000, liveArmedAt: '2026-01-01T00:00:00Z', guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 100_000, maxPositionNotional: 100_000 }, ...over }) as AgentConfig

const holding = (): AgentState => {
  const s = initialState(config())
  const positions = [{ symbol: 'MU', qty: 100, avgCost: MARK }]
  return { ...s, paper: { ...s.paper, cash: 100_000, positions }, exits: { MU: { stop: 400, setAt: NOW.toISOString() } } }
}
const quotes: Quote[] = [{ symbol: 'MU', last: MARK, bid: MARK - 0.1, ask: MARK + 0.1 } as Quote]

/** Accepts everything except the order itself. */
const refusingBroker = {
  call: async (tool: string) => {
    if (tool === 'place_equity_order') throw new Error('insufficient buying power')
    return {}
  }
} as never

async function main(): Promise<void> {
  console.log('\n— a refused protective exit is no longer silent —')
  const rec: DecisionInput[] = []
  // Market shut: a protective sell is a market order, so the session rule refuses
  // it. Exactly the "why didn't it sell?" case, and previously unrecorded.
  await enforceExits({ config: config(), state: holding(), rh: null, accountNumber: null, quotes, now: CLOSED, audit: (d: DecisionInput) => rec.push(d) } as never)
  check('the refusal is recorded at all', rec.length > 0, `${rec.length} record(s)`)
  check('it is marked blocked', rec[0]?.outcome === 'blocked')
  check('it names the rule that decided', rec[0]?.rule?.startsWith('session.') === true, rec[0]?.rule)
  check('it is attributed to the ENGINE, not a tool', rec[0]?.tool === ENGINE_PROTECTIVE_EXIT, rec[0]?.tool)
  check('the detail says why, for a human reading it later', !!rec[0]?.detail, (rec[0]?.detail ?? '').slice(0, 48) + '...')

  console.log('\n— allows are decisions too —')
  const ok: DecisionInput[] = []
  await executeTrade({ config: config(), state: holding(), rh: null, accountNumber: null, quotes, now: NOW, audit: (d: DecisionInput) => ok.push(d) } as never,
    { side: 'buy', symbol: 'MU', qty: 1, type: 'market', tif: 'day', reason: 'x' } as never)
  check('an allowed order is recorded', ok.length === 1 && ok[0].outcome === 'allowed')
  check('with a real rule key, not a placeholder', ok[0]?.rule === 'ok' || ok[0]?.rule === 'ok.operatorExit', ok[0]?.rule)
  check('and a default engine label when the caller names none', ok[0]?.tool === ENGINE_TRADE)

  console.log('\n— a caller that passes no sink behaves exactly as before —')
  const r = await executeTrade({ config: config(), state: holding(), rh: null, accountNumber: null, quotes, now: NOW } as never,
    { side: 'buy', symbol: 'MU', qty: 1, type: 'market', tif: 'day', reason: 'x' } as never)
  check('no sink, no throw, order still fills', r.action.status === 'filled')

  console.log()
  console.log('— the broker refusing an ENGINE order is recorded too —')
  // The guardrails allow it and Robinhood refuses it: a second decision, by
  // someone else, that the pre-placement sink fires too early to see. host.trade
  // covers this for the MODEL's orders; enforceExits has no caller that audits.
  const brk: DecisionInput[] = []
  const rh = refusingBroker
  await enforceExits({
    config: config({ mode: 'live' }),
    // LIVE reads state.live, so the position has to be there — a paper-only
    // fixture makes enforceExits see no position and skip the symbol entirely.
    state: { ...holding(), live: { ...holding().paper } },
    rh,
    accountNumber: 'ACC1',
    quotes,
    now: NOW,
    audit: (d: DecisionInput) => brk.push(d)
  } as never)
  const refusal = brk.find((d) => d.rule === 'broker.rejected')
  check('the broker refusal is recorded', !!refusal, `${brk.length} record(s): ${brk.map((d) => d.rule).join(', ')}`)
  check('as blocked, not lost behind the earlier allow', refusal?.outcome === 'blocked')
  check('still attributed to the engine', refusal?.tool === ENGINE_PROTECTIVE_EXIT, refusal?.tool)
  check('with what the broker actually said', /buying power/.test(refusal?.detail ?? ''), refusal?.detail)
  // Changed 2026-08-31: `allowed` is written when the order actually goes
  // somewhere, never at the verdict. The old order of events audited
  // `allowed · ok` and then execution failed (a no-quote paper sell, a refused
  // placement), so the log built to answer "why didn't it sell?" answered "it
  // did". An order the broker never took gets ONE truthful blocked row —
  // `broker.rejected` already names who refused — while an order that was
  // ACCEPTED and later killed still gets both rows (accepted = it went
  // somewhere). Execution-truth cases live in check-approval-durability.ts.
  check('and NO phantom allow for an order the broker never took', !brk.some((d) => d.outcome === 'allowed'), 'allowed is recorded at acceptance, not at the verdict')

  console.log()
  console.log('— and for a MODEL trade, which used to have its own net —')
  // runOnce:491 recorded `broker.rejected` for host.trade until 5d626f5 deleted
  // it as redundant with this sink. Asserted here because that deletion made
  // THIS the only thing covering the case: an order the guardrails allowed and
  // the broker refused, asked for by the model rather than the engine.
  const model: DecisionInput[] = []
  await executeTrade({
    config: config({ mode: 'live' }),
    state: { ...holding(), live: { ...holding().paper } },
    rh: refusingBroker,
    accountNumber: 'ACC1',
    quotes,
    now: NOW,
    audit: (d: DecisionInput) => model.push(d)
  } as never, { side: 'buy', symbol: 'MU', qty: 1, type: 'market', tif: 'day', reason: 'x' } as never, { auditAs: 'mcp__tb__trade' } as never)
  const mrej = model.find((d) => d.rule === 'broker.rejected')
  check('a model trade refused by the broker is recorded', !!mrej, model.map((d) => d.rule).join(', '))
  check('attributed to the TOOL, not the engine', mrej?.tool === 'mcp__tb__trade', mrej?.tool)

  console.log('\n— the rule vocabulary is a closed set —')
  // Not a runtime assertion: `GuardrailVerdict.rule` and `DecisionRecord.rule`
  // are typed `GuardrailRule`/`DecisionRule`, so an invented key fails the BUILD.
  // Recorded here so the guarantee is discoverable from the tests too.
  check('enforced by the compiler, not at runtime', true, 'see GuardrailRule in src/shared/decisions.ts')

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

void main()
