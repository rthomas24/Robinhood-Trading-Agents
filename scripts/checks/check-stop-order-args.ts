/**
 * The wire format for a broker-side stop, and the guard that keeps it a DRY RUN.
 *
 * #8b is blocked on two questions nobody can answer from the docs: does the
 * Robinhood MCP's `place_equity_order` accept `type: 'stop'` / `'stop_limit'`
 * with a `stop_price`, and does it take GTC on an equity stop. `review_equity_order`
 * can ask — it is described as "Dry-run an equity order: pre-trade warnings and
 * collar checks. Places nothing." — but only if the payload it sends actually
 * contains the stop.
 *
 * It did not. `PlaceEquityOrderParams.type` was `'market' | 'limit'` and
 * `buildOrderArgs` had no `stop_price` branch, so a probe would have dry-run a
 * plain market order, come back clean, and been read as "Robinhood accepts
 * stops". A probe that tests the wrong thing is worse than no probe, because
 * its answer is trusted.
 *
 * So these assertions are about the payload, not the response: what goes on the
 * wire is what we think goes on the wire. And the last two are the important
 * ones — expressing a stop must not make it placeable, because the whole point
 * is that we do not yet know what the broker does with it.
 *
 * Run: `npm run check -- stop-order-args`
 */
import { placeEquityOrder, reviewEquityOrder, type PlaceEquityOrderParams } from '@core/robinhood/api'
import type { RobinhoodMcpClient } from '@core/robinhood/mcp'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Records what would have gone to the broker; answers nothing real. */
function spy(): { calls: Array<{ tool: string; args: Record<string, unknown> }>; client: RobinhoodMcpClient } {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const client = {
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args })
      return { ok: true }
    }
  } as unknown as RobinhoodMcpClient
  return { calls, client }
}

const base: PlaceEquityOrderParams = { accountNumber: 'ACC1', symbol: 'mu', side: 'sell', type: 'stop', qty: 10, stopPrice: 340, tif: 'gtc' }

async function main(): Promise<void> {
  console.log('\n— the payload a stop probe actually sends —')
  const s = spy()
  await reviewEquityOrder(s.client, base)
  const args = s.calls[0]?.args ?? {}
  check('it goes to review_equity_order, not place', s.calls[0]?.tool === 'review_equity_order')
  check('type survives as `stop`', args.type === 'stop')
  check('stop_price is on the wire', args.stop_price === '340.00', `got ${JSON.stringify(args.stop_price)}`)
  check('time_in_force carries the GTC half of the question', args.time_in_force === 'gtc')
  check('symbol is upper-cased like every other order', args.symbol === 'MU')

  console.log('\n— stop_limit carries BOTH prices —')
  const sl = spy()
  await reviewEquityOrder(sl.client, { ...base, type: 'stop_limit', limitPrice: 338 })
  const a2 = sl.calls[0]?.args ?? {}
  check('stop_price is the trigger', a2.stop_price === '340.00')
  check('limit_price is what the triggered order works at', a2.limit_price === '338.00')

  console.log('\n— and a plain order is unchanged —')
  const m = spy()
  await reviewEquityOrder(m.client, { accountNumber: 'ACC1', symbol: 'MU', side: 'buy', type: 'market', qty: 1 })
  const a3 = m.calls[0]?.args ?? {}
  check('no stop_price leaks onto a market order', a3.stop_price === undefined)
  check('no limit_price either', a3.limit_price === undefined)

  console.log('\n— expressing a stop must NOT make it placeable —')
  const p = spy()
  const r = await placeEquityOrder(p.client, base)
  check('placeEquityOrder refuses a stop', !r.ok, r.detail)
  check('and never reached the broker at all', p.calls.length === 0, 'refused before the call, not by the broker')
  const pl = spy()
  const r2 = await placeEquityOrder(pl.client, { ...base, type: 'stop_limit', limitPrice: 338 })
  check('stop_limit is refused the same way', !r2.ok && pl.calls.length === 0)
  const ok = spy()
  const r3 = await placeEquityOrder(ok.client, { accountNumber: 'ACC1', symbol: 'MU', side: 'buy', type: 'market', qty: 1 })
  check('an ordinary market order still places', r3.ok && ok.calls[0]?.tool === 'place_equity_order')

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

void main()
