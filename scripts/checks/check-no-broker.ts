/**
 * An agent with NO broker connection must say so, once, instead of blaming the
 * price feed once per symbol.
 *
 * An agent with no Robinhood connection (and no market-data key) gets no client,
 * so `runOnce` skips the whole quote block and every order is refused by
 * `price.missing` — "No price available for TSLA to size the order." That reads
 * as a market-data hiccup. It sent the operator to look at quotes, and it sent
 * the MODEL to try the next symbol, and the next, producing a column of
 * identical rejected cards for TSLA, META, NFLX, NVDA... when the cause was one
 * structural fact that applied to all of them.
 *
 * The prompt made it worse: with no connection it said "ACCOUNT: Robinhood not
 * connected (paper only)", which reads as "paper still works". It does not —
 * paper fills are simulated at REAL quotes, so no price source means no prices
 * in either mode.
 *
 * Run: `npm run check -- no-broker`
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
const cfg = (mode: 'paper' | 'live'): AgentConfig =>
  ({ mode, allocationUsd: 100_000, liveArmedAt: '2026-01-01T00:00:00Z', guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 100_000, maxPositionNotional: 100_000 } }) as AgentConfig
const state = (mode: 'paper' | 'live'): AgentState => {
  const s = initialState(cfg(mode))
  return { ...s, paper: { ...s.paper, cash: 100_000 }, live: { ...s.live, cash: 100_000 } }
}
const buy = (symbol: string): TradeIntent => ({ symbol, side: 'buy', notional: 3750, type: 'market' }) as TradeIntent

const verdict = (mode: 'paper' | 'live', symbol: string, brokerConnected?: boolean): ReturnType<typeof checkGuardrails> =>
  checkGuardrails({ config: cfg(mode), state: state(mode), intent: buy(symbol), refPrice: null, now: NOW, brokerConnected })

// ── the real reason, not the symptom ───────────────────────────────────────
const v = verdict('paper', 'TSLA', false)
check('a no-broker order is refused', v.ok === false)
check('with a rule that names the CAUSE', v.rule === 'broker.notConnected', v.rule)
check('and does not blame the price feed', !/no price available/i.test(v.reason ?? ''), v.reason?.slice(0, 50))
check('it says paper is affected too', /paper/i.test(v.reason ?? ''), 'the old prompt said "paper only", which read as "paper works"')
check('it says where to fix it', /Settings → Connections/.test(v.reason ?? ''))
check('…and names the paper alternative', /market-data key/i.test(v.reason ?? ''))
check('and it tells the model to stop trying other symbols', /do not retry/i.test(v.reason ?? ''), 'this is what produced a column of identical cards')

// Live is refused the same way — not with a different story.
check('live gets the same diagnosis', verdict('live', 'TSLA', false).rule === 'broker.notConnected')

// ── a genuinely missing price still reads as one ───────────────────────────
// Broker present, one symbol unpriced: that IS a market-data problem and must
// not be relabelled, or a transient gap starts telling people to reconnect.
const priced = verdict('paper', 'TSLA', true)
check('with a broker, a missing price is still price.missing', priced.rule === 'price.missing', priced.rule)
check('and a host that does not distinguish keeps the old message', verdict('paper', 'TSLA', undefined).rule === 'price.missing')

// ── every symbol gives the same answer ─────────────────────────────────────
// The point of naming the cause is that it is not per-symbol.
const symbols = ['TSLA', 'META', 'NFLX', 'NVDA', 'AAPL']
check(
  'every symbol reports the same structural cause',
  symbols.every((s) => verdict('paper', s, false).rule === 'broker.notConnected'),
  'one fact, not five coincidences'
)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
