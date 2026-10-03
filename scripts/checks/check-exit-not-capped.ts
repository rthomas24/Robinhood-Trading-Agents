/**
 * An agent must always be able to get out.
 *
 * `maxOrderNotional` bounded EVERY order, buy and sell alike. But
 * `maxPositionNotional` may exceed it — it does by default ($12,500 against
 * $3,750) — so an agent can build a position over several orders that it then
 * cannot exit in one.
 *
 * The failure shape: an agent holding two positions of about $7,500 each
 * against a $3,750 per-order cap, trying to flatten before the close and
 * refused four times a run. It then thrashes — retrying, growing its context,
 * and finally hitting the run ceiling and going red.
 *
 * The refusals were not the serious part. `enforceExits` places PROTECTIVE
 * sells through this same function and there is no `protective` exemption on
 * the notional cap, so both positions carried an armed trailing stop — visible
 * to the operator on the card — that could never have fired. A stop that cannot
 * execute is not a stop, and nothing said so.
 *
 * Run: `npm run check -- exit-not-capped`
 */
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState, type TradeIntent } from '@shared/agents'
import { checkGuardrails } from '@core/broker/guardrails'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Monday 10:00 ET — inside the session, so session gating never decides. */
const NOW = new Date('2026-08-24T14:00:00Z')
const CAP = 3_750
const PRICE = 600.08

/** The failing shape: caps as they ship, a position built past the per-order cap. */
const config = (): AgentConfig =>
  ({
    mode: 'paper',
    allocationUsd: 50_000,
    liveArmedAt: '2026-01-01T00:00:00Z',
    guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: CAP, maxPositionNotional: 12_500, maxOrdersPerDay: 50 }
  }) as AgentConfig

/** 12.5 shares at $600.08 — $7,501, twice the per-order cap. */
const holding = (): AgentState => {
  const s = initialState(config())
  const positions = [{ symbol: 'NFLX', qty: 12.5, avgCost: PRICE }]
  return { ...s, paper: { ...s.paper, cash: 20_000, positions }, live: { ...s.live, cash: 20_000, positions } }
}

const sellAll: TradeIntent = { symbol: 'NFLX', side: 'sell', qty: 12.5, type: 'market' } as TradeIntent
const bigBuy: TradeIntent = { symbol: 'NFLX', side: 'buy', qty: 12.5, type: 'market' } as TradeIntent

const verdict = (intent: TradeIntent, protective = false): ReturnType<typeof checkGuardrails> =>
  checkGuardrails({ config: config(), state: holding(), intent, refPrice: PRICE, now: NOW, protective, brokerConnected: true })

// ── the agent can get out ──────────────────────────────────────────────────
const exit = verdict(sellAll)
check('a sell larger than the per-order cap is ALLOWED', exit.ok === true, exit.rule ?? '')
check('...and sells the whole position', Math.abs((exit.qty ?? 0) - 12.5) < 1e-6, String(exit.qty))
check('the notional really does exceed the cap', 12.5 * PRICE > CAP, `$${(12.5 * PRICE).toFixed(0)} vs $${CAP}`)

// ── the protective exit, which is the one that mattered ────────────────────
const stop = verdict(sellAll, true)
check('a PROTECTIVE exit of that position is allowed', stop.ok === true, stop.rule ?? '')
check('...which it was not before — the armed stop could never fire', stop.ok === true, 'a stop that cannot execute is not a stop')

// ── buys are still capped ──────────────────────────────────────────────────
// The cap exists to bound new exposure. Removing it for buys would be the
// opposite mistake, and a much more expensive one.
const buy = verdict(bigBuy)
check('a BUY over the cap is still refused', buy.ok === false && buy.rule === 'cap.orderNotional', buy.rule ?? '')
check('...with the cap named in the reason', /per-order cap/.test(buy.reason ?? ''))

// ── exempting sells must not let one oversell ──────────────────────────────
// The clamp to the held position runs after the cap check, so a sell can never
// exceed what the agent owns however large the request.
const over = verdict({ symbol: 'NFLX', side: 'sell', qty: 999, type: 'market' } as TradeIntent)
check('an oversized sell is clamped to the position, not refused', over.ok === true && Math.abs((over.qty ?? 0) - 12.5) < 1e-6, String(over.qty))
const none = verdict({ symbol: 'TSLA', side: 'sell', qty: 5, type: 'market' } as TradeIntent)
check('selling something not held is still refused', none.ok === false && none.rule === 'position.none', none.rule ?? '')

// ── the incoherence that made this reachable ───────────────────────────────
// Nothing stops maxPositionNotional exceeding maxOrderNotional, and the
// defaults do exactly that — so any position built past the per-order cap was
// unexitable in one order. Pinned so the relationship is visible rather than
// discovered again.
check(
  'the shipped defaults really do allow an unexitable position',
  DEFAULT_GUARDRAILS.maxPositionNotional > DEFAULT_GUARDRAILS.maxOrderNotional,
  `position $${DEFAULT_GUARDRAILS.maxPositionNotional} > order $${DEFAULT_GUARDRAILS.maxOrderNotional} — which is fine now that exits are exempt`
)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
