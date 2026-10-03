/**
 * Two questions a run record must be able to answer on its own — pinned.
 *
 *   npm run check -- observability
 *
 * 1. "What did the book look like after run N?" — `state.json` is one file
 *    overwritten in place, so without a per-run record a lost fill could only
 *    be reconstructed from trade cards. Every RunRecord carries `book`
 *    (runBookSummary).
 * 2. "Which code served this run?" — attributing behavior to a build otherwise
 *    means correlating log timestamps. Every RunRecord carries `build` (the app
 *    version on the desktop).
 *
 * No credentials, no network.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyLedger, runBookSummary } from '@shared/agents'

let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}
const src = (rel: string): string => readFileSync(join(import.meta.dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n')

// ── 1. the book summary ─────────────────────────────────────────────────────
const flat = runBookSummary('paper', emptyLedger(10_000), {})
check('a fresh book summarizes to its cash', flat.equity === 10_000 && flat.cash === 10_000 && flat.positions === 0 && flat.marked)

const held = {
  ...emptyLedger(4_729.12),
  positions: [
    { symbol: 'QQQ', qty: 1.4249, avgCost: 719.42 },
    { symbol: 'GLD', qty: 2.4358, avgCost: 420.87 }
  ],
  realizedPnl: 0
}
const marked = runBookSummary('paper', held, { QQQ: 713.98, GLD: 405.46 })
check(
  'positions mark at the quotes given',
  Math.abs(marked.equity - (4_729.12 + 1.4249 * 713.98 + 2.4358 * 405.46)) < 0.005 && marked.marked,
  `$${marked.equity}`
)
const partial = runBookSummary('paper', held, { QQQ: 713.98 })
check(
  'a missing quote falls back to cost and says so (marked: false)',
  !partial.marked && Math.abs(partial.equity - (4_729.12 + 1.4249 * 713.98 + 2.4358 * 420.87)) < 0.005,
  'the paperPortfolio() convention — a floor, labeled, never a blank'
)
check('summaries are cents', Number.isInteger(Math.round(marked.equity * 100)) && marked.equity === Math.round(marked.equity * 100) / 100)

// ── 2. the wiring (source properties, CRLF-safe) ────────────────────────────
const runOnce = src('src/core/runner/runOnce.ts')
check('every run records its closing book', runOnce.includes('book: runBookSummary('))
check('every run records the code that served it', runOnce.includes('build: deps.build'))
check('the desktop stamps its app version', src('src/main/engine/Engine.ts').includes('build: `desktop-${app.getVersion()}`'))

console.log(failed === 0 ? '\nall passed' : `\n${failed} check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
