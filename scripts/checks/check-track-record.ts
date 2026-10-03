/**
 * The track record the agent is shown is split by what tends to decide an
 * outcome — entry time, hold, trail width, extension at entry — and every
 * engine exit gets a post-mortem.
 *
 *   roundTrips        fills → FIFO lots per symbol, with the entry's trail,
 *                     extension and reason and the exit's reason/kind
 *   trackRecordBuckets  win rate + avg P&L by entry-time bucket, hold
 *                     duration, trail width, extension at entry
 *   stampFill         executeTrade writes those fields onto the fill itself
 *   postMortemBlock   entry reason → exit reason → high/low/close after
 *
 * Run: `npm run check -- track-record`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, emptyLedger, entryBucket, initialState, renderTrackRecordRows, roundTrips, trackRecordBuckets, type AgentConfig, type AgentState, type Fill } from '@shared/agents'
import { etClock, etDateTime } from '@shared/marketTime'
import { enforceExits, executeTrade } from '@core/broker/execute'
import { postMortemBlock, trackRecordBlock } from '@core/runner/prompts'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const at = (hhmm: string, day = '2026-09-03'): string => etDateTime(day, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString()
const f = (side: 'buy' | 'sell', symbol: string, qty: number, price: number, ts: string, extra: Partial<Fill> = {}): Fill => ({ id: `${symbol}${ts}${side}`, ts, symbol, side, qty, price, realized: 0, ...extra })

console.log('— round trips —')
const fills: Fill[] = [
  f('buy', 'MU', 10, 100, at('09:35'), { trailPct: 1, extensionPct: 1.8, reason: 'breakout over the open' }),
  f('sell', 'MU', 10, 98, at('09:50'), { engineExit: 'trail', reason: 'Trailing stop hit' }),
  f('buy', 'MU', 5, 99, at('10:30'), { trailPct: 3, extensionPct: -0.4, reason: 'pullback to VWAP' }),
  f('buy', 'MU', 5, 100, at('10:40'), { trailPct: 3, extensionPct: 0.2, reason: 'add' }),
  f('sell', 'MU', 10, 104, at('14:00'), { reason: 'target' }),
  f('buy', 'AMD', 4, 50, at('15:10'), { extensionPct: 2.5, reason: 'late chase' }),
  f('sell', 'AMD', 4, 49, at('15:40'), { engineExit: 'stop', reason: 'Protective stop hit' })
]
const trips = roundTrips(fills)
check('7 fills → 4 closed lots (FIFO splits the 10-share sell across two buys)', trips.length === 4, `${trips.length}`)
check('the first trip carries its entry trail, extension, reason and the exit kind', trips[0].trailPct === 1 && trips[0].extensionPct === 1.8 && trips[0].entryReason === 'breakout over the open' && trips[0].engineExit === 'trail' && trips[0].pnl === -20)
check('hold duration is in minutes', trips[0].holdMin === 15)
console.log('\n— buckets —')
const rows = trackRecordBuckets(trips, (iso) => etClock(new Date(iso)).minutes)
const et = rows.filter((r) => r.dimension === 'entry time')
check('entry-time buckets: pre-09:45 loses, 09:45–11:00 wins, last hour loses', et.find((r) => r.label === 'pre-09:45')?.winRate === 0 && et.find((r) => r.label === '09:45–11:00')?.winRate === 100 && et.find((r) => r.label === 'last hour')?.winRate === 0, JSON.stringify(et))
check('trail buckets split <1.5% from ≥3%', rows.some((r) => r.label === 'trail <1.5%' && r.winRate === 0) && rows.some((r) => r.label === 'trail ≥3%' && r.winRate === 100))
check('extension buckets split below VWAP from >1% above', rows.some((r) => r.label === 'below VWAP') && rows.some((r) => r.label === '>1% above VWAP' && r.winRate === 0))
check('hold buckets', rows.some((r) => r.dimension === 'hold' && r.label === '15–60 min'))
check('entryBucket boundaries', entryBucket(9 * 60 + 44) === 'pre-09:45' && entryBucket(9 * 60 + 45) === '09:45–11:00' && entryBucket(12 * 60) === 'midday' && entryBucket(15 * 60) === 'last hour')
const lines = renderTrackRecordRows(rows)
check('rendered as one line per dimension', lines.length === 4 && lines[0].startsWith('- by entry time:'), lines[0])
const block = trackRecordBlock({ ...emptyLedger(0), fills, realizedPnl: 0 })
check('the TRACK RECORD block carries the table', /by entry time/.test(block) && /by trail/.test(block))

console.log('\n— the fills are stamped at execution —')
const cfg = { id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 }, liveArmedAt: null } as unknown as AgentConfig
const now = etDateTime('2026-09-03', 11 * 60)
async function main(): Promise<void> {
  const q: Quote[] = [{ symbol: 'MU', last: 100, bid: 99.9, ask: 100, ts: 'x' }]
  const r = await executeTrade({ config: cfg, state: initialState({ allocationUsd: 10_000 }), rh: null, accountNumber: null, quotes: q, now, technicalsFor: () => ({ vwap: 98, dayOpen: 97 }) }, { side: 'buy', symbol: 'MU', qty: 5, type: 'market', tif: 'day', trailPct: 2.5, reason: 'VWAP reclaim' })
  const fill = r.state.paper.fills[0]
  check('a buy fill carries trailPct, extension vs VWAP and the reason', fill.trailPct === 2.5 && fill.extensionPct !== undefined && fill.extensionPct > 2 && fill.reason === 'VWAP reclaim', JSON.stringify({ t: fill.trailPct, e: fill.extensionPct, r: fill.reason }))
  const st: AgentState = { ...r.state, exits: { MU: { stop: 101, setAt: 'x' } } }
  const ex = await enforceExits({ config: cfg, state: st, rh: null, accountNumber: null, quotes: q, now })
  const sell = ex.state.paper.fills[ex.state.paper.fills.length - 1]
  check('an engine sell carries engineExit and its reason', sell.side === 'sell' && sell.engineExit === 'stop' && /Protective stop/.test(sell.reason ?? ''))

  console.log('\n— post-mortem —')
  const pm = postMortemBlock([{ symbol: 'MU', exitTs: at('09:50'), exitPrice: 98, kind: 'trailing stop', entryReason: 'breakout over the open', exitReason: 'Trailing stop hit', after: { high: 101, low: 97.5, close: 100.5, minutes: 60 } }])
  check('entry reason → exit reason → the hour after, with % from the exit', /entered because “breakout over the open”/.test(pm) && /exited because “Trailing stop hit”/.test(pm) && /high \$101\.00 \(\+3\.06%\)/.test(pm), pm)
  check('no bars → the line still renders without the window', !/next/.test(postMortemBlock([{ symbol: 'MU', exitTs: at('09:50'), exitPrice: 98, kind: 'stop' }])))
  check('nothing → empty block', postMortemBlock([]) === '')
  const runOnce = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/runOnce.ts'), 'utf8')
  check('runOnce builds it from unseen engine sells, with bars from the run\'s feed, and logs a failure without failing the run', /f\.side === 'sell' && f\.engineExit && !seen\.has\(f\.id\)/.test(runOnce) && /feed\.bars\(\[\.\.\.new Set\(exits\.map/.test(runOnce) && /post-mortem bars failed/.test(runOnce))
  const prompts = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/prompts.ts'), 'utf8')
  check('it is a cuttable block in the registry', /b\('postMortem', 'cuttable'/.test(prompts))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
