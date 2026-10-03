/**
 * A resting paper order either fills, expires, or is refused — never rots.
 *
 *   npm run check -- paper-orders
 *
 * The failure shape: a model places a "limit" buy narrating
 * "@ $188.25" but never passes limitPrice. Guardrails accepted it, the
 * marketable test requires a limitPrice, and the order rests UNFILLABLE
 * FOREVER while the agent believes it is riding a breakout. Two rules fix
 * the class:
 *
 *   1. `limit.missingPrice` — a limit order without a positive limitPrice is
 *      refused at the guardrail (and bounced at the tool with no thread card).
 *   2. TIF is now real — every card always printed "day" or "gtc", but the
 *      ledger never stored it, so day orders rested forever. The settle pass
 *      drops day orders on a later ET date, and drops price-less limit debris
 *      from before rule 1 shipped.
 *
 * No credentials, no database, no network.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_GUARDRAILS, emptyLedger } from '@shared/agents'
import { checkGuardrails } from '@core/broker/guardrails'
import { settlePaperOpenOrders, submitPaperOrder } from '@core/broker/paper'
import type { AgentConfig, AgentState } from '@shared/agents'

let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

const NOW = new Date('2026-08-31T14:30:00Z') // Monday 10:30 ET
const cfg = { id: 'ag_t', mode: 'paper', allocationUsd: 25_000, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 50_000, maxPositionNotional: 100_000 } } as unknown as AgentConfig
const state = { paper: emptyLedger(25_000), live: emptyLedger(0), exits: {}, ordersToday: { date: '', count: 0 }, buyLockDate: null, dayAnchor: null } as unknown as AgentState

// ── 1. the guardrail refuses a price-less limit ─────────────────────────────
const v = checkGuardrails({ config: cfg, state, intent: { symbol: 'PLTR', side: 'buy', qty: 18.6271, type: 'limit', tif: 'day', reason: 'r' }, refPrice: 187.9, now: NOW })
check('a limit order with no limitPrice is refused', !v.ok && v.rule === 'limit.missingPrice', String(v.rule))
const v2 = checkGuardrails({ config: cfg, state, intent: { symbol: 'PLTR', side: 'buy', qty: 10, type: 'limit', limitPrice: 185, tif: 'day', reason: 'r' }, refPrice: 187.9, now: NOW })
check('one WITH a price still passes', v2.ok, v2.ok ? '' : String(v2.rule))

// ── 2. the tool bounces the fumble without a thread card ───────────────────
const tools = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'agentTools.ts'), 'utf8').replace(/\r\n/g, '\n')
check('missing size bounces at the tool, cardlessly', tools.includes('give qty OR notional (USD) > 0. No card was posted'))
check('missing limitPrice bounces at the tool, cardlessly', tools.includes('retry WITH limitPrice, or use type "market"'))

// ── 3. TIF is stored and honoured ───────────────────────────────────────────
const q = { last: 187.9, bid: 187.85, ask: 187.95 }
const rest = submitPaperOrder(emptyLedger(25_000), { symbol: 'PLTR', side: 'buy', qty: 10, type: 'limit', limitPrice: 180, tif: 'day' }, q)
check('a non-marketable limit rests with its tif stored', rest.order.status === 'open' && rest.order.tif === 'day')

const yesterday = { ...rest.order, ts: '2026-08-28T15:00:00.000Z' } // Friday
const gtc = { ...rest.order, id: 'po_gtc', tif: 'gtc' as const, ts: '2026-08-28T15:00:00.000Z' }
const debris = { ...rest.order, id: 'po_debris', limitPrice: undefined, ts: NOW.toISOString() } // the failing shape
const today = { ...rest.order, id: 'po_today', ts: NOW.toISOString() }
const ledger = { ...emptyLedger(25_000), openOrders: [yesterday, gtc, debris, today] }

const s = settlePaperOpenOrders(ledger, {}, NOW)
const droppedIds = s.dropped.map((o) => o.id).sort()
check("a Friday DAY order is dropped on Monday", droppedIds.includes(rest.order.id))
check('a price-less limit is dropped as debris — it could never fill', droppedIds.includes('po_debris'))
check('a GTC order from Friday survives', s.ledger.openOrders.some((o) => o.id === 'po_gtc'))
check("today's DAY order survives", s.ledger.openOrders.some((o) => o.id === 'po_today'))
check('dropped orders come back marked cancelled, for the note', s.dropped.every((o) => o.status === 'cancelled'))
check('nothing filled from an empty quote map', s.fills.length === 0)

// A marketable day order from today still fills on settle.
const fillable = { ...rest.order, id: 'po_fill', limitPrice: 190, ts: NOW.toISOString() }
const s2 = settlePaperOpenOrders({ ...emptyLedger(25_000), openOrders: [fillable] }, { PLTR: q }, NOW)
check('a marketable resting order still fills', s2.fills.length === 1 && s2.settled[0]?.id === 'po_fill')

// ── 4. the tif reaches the ledger from a real intent ────────────────────────
const exec = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'broker', 'execute.ts'), 'utf8').replace(/\r\n/g, '\n')
check('executeTrade passes tif into the paper order', exec.includes("tif: intent.tif === 'gtc' ? 'gtc' : 'day'"))
const runOnce = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8').replace(/\r\n/g, '\n')
check('runOnce settles with the clock and posts drop notes', runOnce.includes('settlePaperOpenOrders(state.paper, toPaperQuotes(quotes), now())') && runOnce.includes('Cancelled resting order'))

console.log(failed === 0 ? '\nall passed' : `\n${failed} check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
