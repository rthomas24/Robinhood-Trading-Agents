/**
 * Paper agents can price without Robinhood, on the operator's own Alpaca
 * market-data key, and every surface says so the same way.
 *
 * The contract:
 *
 *   1. `priceSourceFor` is THE rule: Robinhood when connected, the market-data
 *      feed for PAPER only, nothing otherwise. A live agent is never priced by
 *      the feed, however available it is.
 *   2. The Alpaca adapter maps a snapshot to our `Quote` (last, bid/ask,
 *      prevClose, changePct), batches symbols into one request, caches for a
 *      few seconds, and retries stale/missing symbols on the delayed tape.
 *   3. The prompt tells a feed-priced agent it HAS prices and lacks only the
 *      broker; the protections block does not call its exits unenforced.
 *   4. `quotes` / `bars` exist as agent tools, so an agent with no broker can
 *      price a symbol outside its context.
 *
 * Run: `npm run check -- market-feed`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { priceSourceFor, PRICE_SOURCE_NOTE, paperModeHint, MARKET_FEED_LABEL } from '../../src/shared/marketData'
import { alpacaFeed } from '../../src/core/market/alpaca'
import { pickFeed } from '../../src/core/market/feed'
import { AGENT_TOOLS } from '../../src/core/runner/agentTools'
import { protectionsBlock } from '../../src/core/runner/prompts'
import type { AgentState } from '../../src/shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ------------------------------------------------------------- 1. the rule
check('paper + no broker + feed → feed', priceSourceFor('paper', false, true) === 'feed')
check('paper + broker → robinhood (the broker always wins)', priceSourceFor('paper', true, true) === 'robinhood')
check('live + no broker + feed → none (a live agent is never priced by the feed)', priceSourceFor('live', false, true) === 'none')
check('paper + nothing → none', priceSourceFor('paper', false, false) === 'none')
check('pickFeed hands a live agent nothing without Robinhood', pickFeed('live', null, alpacaFeed({ keyId: 'k', secretKey: 's' })) === null)
check('the label says whose key prices the run', /your alpaca/i.test(MARKET_FEED_LABEL) && PRICE_SOURCE_NOTE.feed.includes(MARKET_FEED_LABEL) && paperModeHint(true).includes(MARKET_FEED_LABEL))
check('with no source at all, the note says how to get one', /connect Robinhood/i.test(PRICE_SOURCE_NOTE.none) && /market-data key/i.test(PRICE_SOURCE_NOTE.none))

// ------------------------------------------------------------- 2. the adapter
const calls: string[] = []
const NOW = Date.parse('2026-09-03T15:00:00Z') // 11:00 ET, session open
const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input))
  calls.push(url.pathname + '?' + url.searchParams.toString())
  const feed = url.searchParams.get('feed')
  const syms = (url.searchParams.get('symbols') ?? '').split(',')
  if (url.pathname.endsWith('/snapshots')) {
    const body: Record<string, unknown> = {}
    for (const s of syms) {
      if (s === 'AAPL') body[s] = { latestTrade: { p: 231.5, t: '2026-09-03T14:59:50Z' }, latestQuote: { bp: 231.4, ap: 231.6 }, prevDailyBar: { c: 230 } }
      // THIN prints on IEX only in the morning; the delayed tape has it now.
      if (s === 'THIN' && feed === 'iex') body[s] = { latestTrade: { p: 10, t: '2026-09-03T13:35:00Z' }, prevDailyBar: { c: 9.5 } }
      if (s === 'THIN' && feed === 'delayed_sip') body[s] = { latestTrade: { p: 10.2, t: '2026-09-03T14:44:00Z' }, prevDailyBar: { c: 9.5 } }
      // NOPE exists nowhere.
    }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  if (url.pathname.endsWith('/bars')) {
    const page = url.searchParams.get('page_token')
    const bars = { AAPL: [{ t: page ? '2026-09-02T04:00:00Z' : '2026-09-01T04:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }] }
    return new Response(JSON.stringify({ bars, next_page_token: page ? null : 'p2' }), { status: 200 })
  }
  return new Response('not found', { status: 404 })
}) as unknown as typeof fetch

const feed = alpacaFeed({ keyId: 'k', secretKey: 's', fetch: fakeFetch, now: () => NOW })
const r = await feed.quotes(['aapl', 'THIN', 'NOPE', 'AAPL'])
const aapl = r.quotes.find((q) => q.symbol === 'AAPL')
const thin = r.quotes.find((q) => q.symbol === 'THIN')
check('snapshot → Quote (last, bid, ask, prevClose, changePct)', aapl?.last === 231.5 && aapl.bid === 231.4 && aapl.ask === 231.6 && aapl.prevClose === 230 && aapl.changePct === 0.65, JSON.stringify(aapl))
check('one batched request for the primary feed, symbols normalised', calls.filter((c) => c.includes('feed=iex')).length === 1 && calls[0].includes('symbols=AAPL%2CTHIN%2CNOPE'), calls.join(' | '))
check('a stale IEX print is retried on the delayed tape and takes the fresher price', thin?.last === 10.2 && calls.some((c) => c.includes('feed=delayed_sip') && c.includes('THIN')), JSON.stringify(thin))
check('a symbol no feed knows is reported failed, not silently dropped', r.failed.length === 1 && r.failed[0] === 'NOPE')
const before = calls.length
await feed.quotes(['AAPL'])
check('a second ask inside the cache window costs no request', calls.length === before)
const bars = await feed.bars(['AAPL'], '2026-08-01T00:00:00Z', 'day')
check('bars follow next_page_token and map to our Bar', bars.AAPL?.length === 2 && bars.AAPL[0].c === 1.5 && typeof bars.AAPL[0].t === 'number')

// ------------------------------------------------------------- 3. the prompt
const state = { exits: { AAPL: { stop: 200, setAt: '2026-09-03T14:00:00Z' } }, watches: [] } as unknown as AgentState
check('protections are NOT called unenforced when the feed prices the run', !/NO BROKER CONNECTION THIS RUN/.test(protectionsBlock(state, true)) && /NO BROKER CONNECTION THIS RUN/.test(protectionsBlock(state, false)))
const prompts = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'prompts.ts'), 'utf8')
check('the account block has a feed branch that says prices are real and only the broker is missing', /market\.priceSource === 'feed'/.test(prompts) && /PRICE_SOURCE_NOTE\.feed/.test(prompts))
check('the protections block keys on priceSource, not on Robinhood alone', /market\.priceSource !== 'none'/.test(prompts))

// ------------------------------------------------------------- 4. the tools
const names = AGENT_TOOLS.map((t) => t.name)
check('quotes and bars are agent tools', names.includes('quotes') && names.includes('bars'))
const runOnce = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8')
check('runOnce picks the feed once and prices from it', /pickFeed\(cfg\.mode, rh, platform\)/.test(runOnce) && /feed\.quotes\(syms\)/.test(runOnce))
check('guardrails see "no price source", not "no Robinhood", for the trade tool', /brokerConnected: feed !== null/.test(runOnce))

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exitCode = failures ? 1 : 0
