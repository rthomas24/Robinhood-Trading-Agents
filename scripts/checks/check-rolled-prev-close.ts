/**
 * A "previous close" dated today is not a previous close.
 *
 * The failure shape: in the evening, Robinhood's own app says an account is
 * DOWN on the day while the Robinhood panel and an agent's DAY tile both say
 * it is UP — on a day every position was sold that morning. The reason: after
 * 16:00 ET Robinhood's quote rolls `adjusted_previous_close`, `previous_close`
 * AND the `close` row to the close of the session that JUST ended, and
 * `previous_close_date` — which says so — was discarded. So the day figure
 * measured "sale proceeds vs tonight's close".
 *
 * The contract now (`core/robinhood/api.ts`):
 *
 *   1. `Quote.prevCloseDate` carries the session date of `prevClose`.
 *   2. A quote whose previous-close date is TODAY (ET) gets the PRIOR session's
 *      close from the daily bars (`begins_at` = midnight UTC of the bar's own
 *      session — a bar stamped `…T00:00Z` carries that day's close),
 *      `changePct` recomputed, one batched call per ten symbols, cached per day.
 *   3. A rolled close that cannot be replaced is DROPPED, never kept.
 *   4. An in-session quote (dated yesterday) is untouched and costs no call;
 *      the next ET day a close dated yesterday is simply yesterday's.
 *
 *   npm run check -- rolled-prev-close
 */
import { getQuotes } from '@core/robinhood/api'
import type { RobinhoodMcpClient } from '@core/robinhood/mcp'
import { portfolioTotals, type PortfolioDayInput } from '@shared/portfolio'
import type { AccountFill } from '@shared/ipc'

let failures = 0
const ok = (cond: boolean, msg: string): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}
const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) < eps

const TODAY = '2026-09-16'
const PRIOR = '2026-09-15'
/** 8:45 PM ET on the 16th — after the close, still the same ET day. */
const TONIGHT = new Date('2026-09-17T00:45:00Z')
/** 9:00 AM ET on the 17th — before the next open. */
const NEXT_MORNING = new Date('2026-09-17T13:00:00Z')

// Four positions sold this morning (synthetic figures).
const sold: Record<string, { qty: number; price: number; last: number; todayClose: number; priorClose: number }> = {
  AAPL: { qty: 0.5, price: 201, last: 200.8, todayClose: 200.6, priorClose: 205 },
  MSFT: { qty: 2, price: 410, last: 409.4, todayClose: 409.2, priorClose: 413 },
  KO: { qty: 4, price: 60, last: 59.9, todayClose: 59.8, priorClose: 61.25 },
  PEP: { qty: 1, price: 150, last: 150.2, todayClose: 149.9, priorClose: 152 }
}
const fillsToday: AccountFill[] = Object.entries(sold).map(([symbol, s]) => ({ symbol, side: 'sell', qty: s.qty, price: s.price, at: `${TODAY}T14:21:00Z` }))

interface Fake {
  client: RobinhoodMcpClient
  calls: Array<{ name: string; args: Record<string, unknown> }>
}
/** A broker whose quotes carry `previous_close_date = prevDate` and whose daily bars are stamped at midnight UTC. */
function fakeBroker(opts: { prevDate: string; prevClose: (sym: string) => number; bars?: false | 'todayOnly' }): Fake {
  const calls: Fake['calls'] = []
  const client = {
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      if (name === 'get_equity_quotes') {
        const syms = args.symbols as string[]
        return {
          results: syms.map((symbol) => {
            const s = sold[symbol]
            const pc = opts.prevClose(symbol).toFixed(6)
            return {
              symbol,
              quote: {
                symbol,
                last_trade_price: s.todayClose.toFixed(6),
                venue_last_trade_time: `${TODAY}T20:00:00Z`,
                last_non_reg_trade_price: s.last.toFixed(6),
                venue_last_non_reg_trade_time: `${TODAY}T23:59:00Z`,
                adjusted_previous_close: pc,
                previous_close: pc,
                previous_close_date: opts.prevDate,
                bid_price: (s.last - 0.02).toFixed(6),
                ask_price: (s.last + 0.02).toFixed(6),
                state: 'active'
              },
              close: { symbol, date: opts.prevDate, price: pc, interpolated: false, source: 'sip-list-exchange-close' }
            }
          })
        }
      }
      if (name === 'get_equity_historicals') {
        if (opts.bars === false) throw new Error('historicals unavailable')
        const syms = args.symbols as string[]
        const days = opts.bars === 'todayOnly' ? [TODAY] : ['2026-09-14', PRIOR, TODAY]
        return {
          results: syms.map((symbol) => ({
            symbol,
            bars: days.map((d) => {
              const c = d === TODAY ? sold[symbol].todayClose : d === PRIOR ? sold[symbol].priorClose : sold[symbol].priorClose - 1
              return { begins_at: `${d}T00:00:00Z`, open_price: c.toFixed(6), close_price: c.toFixed(6), high_price: (c + 1).toFixed(6), low_price: (c - 1).toFixed(6), volume: 1000, session: 'reg' }
            })
          }))
        }
      }
      throw new Error(`unexpected tool ${name}`)
    }
  } as unknown as RobinhoodMcpClient
  return { client, calls }
}

const syms = Object.keys(sold)
const totalsWith = (quotes: Awaited<ReturnType<typeof getQuotes>>): ReturnType<typeof portfolioTotals> => {
  const input: PortfolioDayInput = { cash: 600, equity: 600, positions: [], fillsToday, quotes: Object.fromEntries(quotes.map((q) => [q.symbol, q])) }
  return portfolioTotals(input)
}

async function main(): Promise<void> {
  // ── 1. Tonight: the rolled close is replaced by the prior session's ──────
  {
    const b = fakeBroker({ prevDate: TODAY, prevClose: (s) => sold[s].todayClose })
    const quotes = await getQuotes(b.client, syms, TONIGHT)
    const aapl = quotes.find((q) => q.symbol === 'AAPL')!
    ok(near(aapl.prevClose ?? 0, 205), `AAPL prevClose is the prior session's close, not tonight's (${aapl.prevClose})`)
    ok(aapl.prevCloseDate === PRIOR, `and says which session it is (${aapl.prevCloseDate})`)
    ok(near(aapl.changePct ?? 0, ((200.8 - 205) / 205) * 100), 'changePct is recomputed against it')
    ok(quotes.every((q) => q.prevCloseDate === PRIOR), 'every rolled symbol was repaired')
    const hist = b.calls.filter((c) => c.name === 'get_equity_historicals')
    ok(hist.length === 1 && (hist[0].args.symbols as string[]).length === 4 && hist[0].args.interval === 'day', 'one batched daily-bars call for the four rolled symbols')
    const t = totalsWith(quotes)
    ok(near(t.dayChange, -15), `the account's day reads −$15.00, what the broker shows (${t.dayChange.toFixed(2)})`)
    ok(near(t.equity, 600), 'equity is the cash, the book being flat')

    // The cache: the panel polls every 30 s all evening.
    const before = b.calls.length
    await getQuotes(b.client, syms, TONIGHT)
    ok(b.calls.slice(before).every((c) => c.name === 'get_equity_quotes'), 'a second fetch the same evening reads the cache, not the bars')
  }

  // ── 2. The old reading, for the record: unrepaired, the figure is +$2.70 ──
  {
    // Ask on the NEXT ET day: a close dated the 16th is then simply "yesterday's", so nothing fires —
    // and that unrepaired value is exactly what tonight's panel printed.
    const b = fakeBroker({ prevDate: TODAY, prevClose: (s) => sold[s].todayClose })
    const quotes = await getQuotes(b.client, syms, NEXT_MORNING)
    ok(!b.calls.some((c) => c.name === 'get_equity_historicals'), 'the next morning a close dated yesterday needs no repair')
    const t = totalsWith(quotes)
    ok(near(t.dayChange, 2.7, 0.02), `and the unrepaired figure is the +$2.70 an unrepaired panel would show (${t.dayChange.toFixed(2)})`)
  }

  // ── 3. In session: a close dated yesterday is untouched and costs nothing ──
  {
    const b = fakeBroker({ prevDate: PRIOR, prevClose: (s) => sold[s].priorClose })
    const quotes = await getQuotes(b.client, syms, new Date('2026-09-16T15:00:00Z'))
    ok(!b.calls.some((c) => c.name === 'get_equity_historicals'), 'in session: no daily-bars call')
    ok(quotes.every((q) => q.prevCloseDate === PRIOR && near(q.prevClose ?? 0, sold[q.symbol].priorClose)), 'quotes pass through as they came')
  }

  // ── 4. Bars unavailable: the rolled close is dropped, not kept ──────────
  {
    // Fresh symbols so the day cache from case 1 cannot answer.
    const alt = { ZZA: sold.AAPL, ZZB: sold.MSFT }
    Object.assign(sold, alt)
    const b = fakeBroker({ prevDate: TODAY, prevClose: (s) => sold[s].todayClose, bars: false })
    const quotes = await getQuotes(b.client, Object.keys(alt), TONIGHT)
    ok(quotes.length === 2 && quotes.every((q) => q.prevClose === undefined && q.changePct === undefined && q.prevCloseDate === undefined), 'no prior close to be had → no previous close claimed')
    ok(quotes.every((q) => near(q.last, sold[q.symbol].last)), 'the price itself still stands')
  }

  // ── 5. Bars that only reach today: today's own bar is never the "prior" close ──
  {
    Object.assign(sold, { ZZC: sold.KO })
    const b = fakeBroker({ prevDate: TODAY, prevClose: (s) => sold[s].todayClose, bars: 'todayOnly' })
    const [q] = await getQuotes(b.client, ['ZZC'], TONIGHT)
    ok(q.prevClose === undefined, 'a bar dated today is not a previous close either')
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

void main()
