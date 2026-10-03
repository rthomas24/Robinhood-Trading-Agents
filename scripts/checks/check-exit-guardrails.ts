/**
 * An exit level already breached at entry is not protection — it is a market
 * order to liquidate, wearing protection's clothes.
 *
 * This asserts the engine-side gate against a real approval bypass. The chain
 * it closes, end to end:
 *
 *   1. Agent holds 100 MU @ ~$358 with an operator-visible stop at $340.
 *   2. Model calls trade{buy, qty 1, market}. The card reads "buy 1 share at
 *      market, no stop". The operator approves a ~$358 order.
 *   3. On the approval run it re-issues the same shape with stopLoss: 400.
 *      undefined → 400 reads as "added protection", so the approval covers it.
 *   4. The fill arms exits.MU = { stop: 400 }, REPLACING the $340 plan.
 *   5. Next sweep: 358 <= 400, so the engine market-sells all 101 shares —
 *      exempt from the daily order cap, exempt from the PDT check, and never
 *      held for approval because the engine initiated it.
 *
 * A one-share yes became an unapproved liquidation of the whole position.
 *
 * Step 5 is what makes this severe rather than untidy, so the gate belongs at
 * step 3, in `checkGuardrails`, where every caller passes — not on the approval
 * path, which is one door of several.
 *
 * Run: `npm run check -- exit-guardrails`
 */
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState } from '@shared/agents'
import { checkGuardrails, exitLevelProblem } from '@core/broker/guardrails'
import { executeTrade } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Monday 10:00 ET: inside the regular session, so session gating never decides. */
const NOW = new Date('2026-08-24T14:00:00Z')
const MARK = 358

const config = (mode: 'paper' | 'live' = 'paper'): AgentConfig =>
  ({ mode, allocationUsd: 100_000, liveArmedAt: '2026-01-01T00:00:00Z', guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 100_000, maxPositionNotional: 100_000 } }) as AgentConfig

/** 100 MU already held, protected by the stop the operator can see. */
const holding = (): AgentState => {
  const s = initialState(config())
  const positions = [{ symbol: 'MU', qty: 100, avgCost: MARK }]
  return {
    ...s,
    paper: { ...s.paper, cash: 100_000, positions },
    live: { ...s.live, cash: 100_000, positions },
    exits: { MU: { stop: 340, setAt: NOW.toISOString() } }
  }
}

const quotes: Quote[] = [{ symbol: 'MU', last: MARK, bid: MARK - 0.1, ask: MARK + 0.1 } as Quote]

const guard = (intent: Record<string, unknown>) =>
  checkGuardrails({ config: config(), state: holding(), intent: intent as never, refPrice: MARK, now: NOW })

const buy = (extra: Record<string, unknown>) => ({ side: 'buy', symbol: 'MU', qty: 1, type: 'market', tif: 'day', reason: 'x', ...extra })

async function main(): Promise<void> {
  console.log('\n— the bypass itself —')
  const evil = guard(buy({ stopLoss: 400 }))
  check('a stop ABOVE the market is refused', !evil.ok && evil.rule === 'exit.invalidLevel', `rule ${evil.rule}`)

  const atMark = guard(buy({ stopLoss: MARK }))
  check('a stop exactly AT the market is refused', !atMark.ok && atMark.rule === 'exit.invalidLevel', 'the sweep fires on <=, so equality is already breached')

  const tgt = guard(buy({ takeProfit: 300 }))
  check('a target BELOW the market is refused', !tgt.ok && tgt.rule === 'exit.invalidLevel', 'same trick, other direction')

  const cross = guard(buy({ stopLoss: 340, takeProfit: 330 }))
  check('a target at or below the stop is refused', !cross.ok && cross.rule === 'exit.invalidLevel', 'whichever fires first, the other never can')

  // A limit buy fills at or BELOW its limit, so the ask is the wrong reference:
  // a stop under today's ask can still sit above the price this order can pay.
  const lim = guard({ ...buy({ stopLoss: 350 }), type: 'limit', limitPrice: 340 })
  check('limit buy: a stop under the ASK but over the LIMIT is refused', !lim.ok && lim.rule === 'exit.invalidLevel', 'entry is bounded by min(ask, limit)')

  console.log('\n— what must still work —')
  check('a normal stop-below / target-above plan passes', guard(buy({ stopLoss: 340, takeProfit: 400 })).ok)
  check('even a very tight trail passes', guard(buy({ trailPct: 0.1 })).ok, 'the engine seeds the high from the FILL, so a trail cannot start breached')
  check('an ordinary sell is untouched', guard({ side: 'sell', symbol: 'MU', qty: 10, type: 'market', tif: 'day', reason: 'x' }).ok)
  check('no exit levels at all is not an exit problem', guard(buy({})).ok)

  console.log('\n— the pure rule, shared so every path can use it —')
  check('exitLevelProblem flags a breached stop', exitLevelProblem({ stop: 400 }, MARK) !== null)
  check('exitLevelProblem passes a coherent plan', exitLevelProblem({ stop: 340, target: 400 }, MARK) === null)
  check('exitLevelProblem is inert without a reference', exitLevelProblem({ stop: 400 }, 0) === null, 'callers reject a priceless order before reaching it')

  console.log()
  console.log('— the plan that will EXIST, not the half this call names —')
  // Price gapped to $300 overnight, so the $340 stop is stale and above the market.
  const gapped = (intent: Record<string, unknown>) =>
    checkGuardrails({ config: config(), state: holding(), intent: intent as never, refPrice: 300, now: NOW })
  check('the FRAGMENT alone looks fine', exitLevelProblem({ target: 310 }, 300) === null, 'a 310 target is above the 300 entry')
  const merged = gapped(buy({ takeProfit: 310 }))
  check('but the MERGED plan is refused', !merged.ok && merged.rule === 'exit.invalidLevel', 'the inherited 340 stop is above 300 and inverts the 310 target')
  check('and the message says it is about the inherited plan', /AFTER merging/.test(merged.reason ?? ''), (merged.reason ?? '').slice(0, 60) + '...')

  // A trail set earlier is a stop too: a 400 high at 5% sells at 380.
  const stale = checkGuardrails({
    config: config(),
    state: { ...holding(), exits: { MU: { trail: { pct: 5, high: 400 }, setAt: NOW.toISOString() } } },
    intent: buy({ takeProfit: 420 }) as never,
    refPrice: 300,
    now: NOW
  })
  check('a stale TRAIL blocks it the same way', !stale.ok && stale.rule === 'exit.invalidLevel', 'effectiveStop is 380, above the 300 price')

  check('a plain buy naming no exits is NOT gated on the old plan', gapped({ side: 'buy', symbol: 'MU', qty: 1, type: 'market', tif: 'day', reason: 'x' }).ok, 'only a call that touches the plan must leave it coherent')
  check('a coherent merge still passes', gapped(buy({ stopLoss: 290, takeProfit: 310 })).ok)

  console.log()
  console.log('\n— step 4: a new order must not silently discard the old plan —')
  const ctx = { config: config(), state: holding(), rh: null, accountNumber: null, quotes, now: NOW }
  const added = await executeTrade(ctx as never, buy({ takeProfit: 400 }) as never)
  check('a buy adding only a target fills', added.action.status === 'filled')
  check('the existing $340 stop SURVIVES it', added.state.exits.MU?.stop === 340, `got ${added.state.exits.MU?.stop}`)
  check('and the new target is recorded alongside it', added.state.exits.MU?.target === 400)

  console.log('\n— an ignored argument must never be silent —')
  const sold = await executeTrade(ctx as never, { side: 'sell', symbol: 'MU', qty: 10, type: 'market', tif: 'day', reason: 'x', trailPct: 3 } as never)
  check('trailPct on a SELL tells the model it was dropped', !!sold.notes?.length && /trailPct/.test(sold.notes[0]), 'exits attach to buys; dropping this silently reads as "armed"')

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

void main()
