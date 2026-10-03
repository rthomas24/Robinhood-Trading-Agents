/**
 * The trading halt (`AppSettings.tradingHalted`) — the operator's panic switch,
 * spanning every agent on this computer.
 *
 * This asserts the control exists and — more importantly — that it does
 * exactly what its UI claims and no more.
 *
 * The shape under test is deliberately not "block everything":
 *
 *   BUYS are refused. That is the direction that adds exposure, and it is the
 *   whole point of the switch.
 *
 *   SELLS are not, including stops and take-profits. A halt that also blocked
 *   selling would trap every open position at the moment its owner reached for
 *   the panic button — their stops would quietly stop being stops. Being unable
 *   to get out is worse than the thing this guards against. Identical reasoning
 *   to the daily-loss breaker (`lock.dailyLoss`), which has always been
 *   buys-only for the same reason.
 *
 *   PAPER is untouched: it moves no money, and taking away the one safe place to
 *   keep working would be a cost with no matching benefit.
 *
 *   `undefined` means the HOST HAS NO SUCH CONTROL, not that a read failed, and
 *   the rule then does not fire. A host that cannot read its own flag should
 *   answer `true`: because this refuses buys only, failing closed costs a missed
 *   buy — recoverable, sells and stops still work — while failing open ignores
 *   the panic button, and that is not recoverable because the money has moved.
 *
 * Run: `npm run check -- trading-halt`
 */
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState, type TradeIntent } from '@shared/agents'
import { checkGuardrails } from '@core/broker/guardrails'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Monday 10:00 ET — inside the regular session, so session gating never decides. */
const NOW = new Date('2026-08-24T14:00:00Z')
const MARK = 100

const config = (mode: 'paper' | 'live'): AgentConfig =>
  ({ mode, allocationUsd: 100_000, liveArmedAt: '2026-01-01T00:00:00Z', guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 100_000, maxPositionNotional: 100_000 } }) as AgentConfig

const holding = (mode: 'paper' | 'live'): AgentState => {
  const s = initialState(config(mode))
  const positions = [{ symbol: 'AAPL', qty: 50, avgCost: MARK }]
  return { ...s, paper: { ...s.paper, cash: 100_000, positions }, live: { ...s.live, cash: 100_000, positions } }
}

const buy: TradeIntent = { symbol: 'AAPL', side: 'buy', qty: 1, type: 'market' } as TradeIntent
const sell: TradeIntent = { symbol: 'AAPL', side: 'sell', qty: 1, type: 'market' } as TradeIntent

const verdict = (mode: 'paper' | 'live', intent: TradeIntent, tradingHalted: boolean | undefined, protective = false): ReturnType<typeof checkGuardrails> =>
  checkGuardrails({ config: config(mode), state: holding(mode), intent, refPrice: MARK, now: NOW, tradingHalted, protective })

// ── the switch does its job ────────────────────────────────────────────────
const blocked = verdict('live', buy, true)
check('a live BUY is refused while halted', blocked.ok === false, blocked.rule)
check('and the decision log gets a stable rule key', blocked.rule === 'account.tradingHalted', blocked.rule)
check('and the reason tells the model not to retry', /do not retry/i.test(blocked.reason ?? ''), blocked.reason?.slice(0, 60))
check('and it names where to turn it off', /Settings → Trading safety/.test(blocked.reason ?? ''), blocked.reason?.slice(0, 120))

// ── and nothing more than its job ──────────────────────────────────────────
check('a live SELL still goes through while halted', verdict('live', sell, true).ok === true, verdict('live', sell, true).rule)
check('a PROTECTIVE exit still goes through while halted', verdict('live', sell, true, true).ok === true, 'a stop that cannot fire is not a stop')
check('a PAPER buy is untouched', verdict('paper', buy, true).ok === true, verdict('paper', buy, true).rule)

// ── off, and unknown ───────────────────────────────────────────────────────
check('a live BUY is fine when not halted', verdict('live', buy, false).ok === true, verdict('live', buy, false).rule)
check('a host with no account controls does not halt', verdict('live', buy, undefined).ok === true, verdict('live', buy, undefined).rule)

// ── it is a second line, not the only one ──────────────────────────────────
// Turning the halt off must not resurrect an agent that some other rule stops.
const unarmed = checkGuardrails({ config: { ...config('live'), liveArmedAt: null } as AgentConfig, state: holding('live'), intent: buy, refPrice: MARK, now: NOW, tradingHalted: false })
check('an unarmed agent is still refused with the halt off', unarmed.ok === false && unarmed.rule === 'live.notArmed', unarmed.rule)
// ...and the halt must not mask a rule that would have refused anyway: whichever
// fires, the operator sees a true reason.
const retired = checkGuardrails({ config: config('live'), state: { ...holding('live'), status: 'retired' } as AgentState, intent: buy, refPrice: MARK, now: NOW, tradingHalted: true })
check('a retired agent reports being retired, not halted', retired.ok === false && retired.rule === 'agent.retired', retired.rule)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
