/**
 * A budgeter must not be able to cut the book — not "must be careful not to".
 *
 * The transcript's max-min truncation is gated behind the durable-block
 * registry for one reason: we would be truncating a prompt that contains the
 * agent's own ledger, and **an agent that sees a partial book does not know it
 * is partial**. It would reason about positions it no longer appears to hold
 * and stops it can no longer see, and the resulting trade would be well-formed,
 * guardrail-legal and wrong. That is the worst failure shape we have, because
 * nothing downstream rejects it.
 *
 * The weak fix is a budgeter written carefully. The fix asserted here is
 * structural: `composeRunPromptWithin` hands `fit` the cuttable blocks and
 * nothing else, so a mandatory block is not in the budgeter's input and there
 * is no parameter through which it could ask for one. The adversary modelled
 * below is therefore not a clever budgeter but the worst possible one — a `fit`
 * that discards everything it is given, and a `fit` that actively tries to
 * overwrite the ledger with a forgery.

 *
 * Run: `npm run check -- durable-blocks`
 */
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState, type Message } from '@shared/agents'
import { composeRunPrompt, composeRunPromptWithin, runPromptBlocks, type BlockId, type PromptBlock } from '@core/runner/prompts'
import type { MarketContext } from '@core/runner/types'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// A rich agent: two open positions, an armed stop, a live watch, an operator
// constraint in memory, an unsettled errand, a thesis and a track record — so
// every block in the registry actually renders.
const cfg: AgentConfig = {
  id: 'a1',
  name: 'T',
  mode: 'paper',
  allocationUsd: 10_000,
  guardrails: { ...DEFAULT_GUARDRAILS, maxOrdersPerDay: 3, maxPositionNotional: 2000 },
  model: { vendor: 'claude', id: 'm', effort: 'medium' },
  schedule: { kind: 'manual' },
  retirement: { profitTargetUsd: 500 }
} as AgentConfig

const base = initialState({ allocationUsd: 10_000 })
const state: AgentState = {
  ...base,
  runCount: 25,
  memory: ['never trade biotech', 'I need the cash Friday'],
  errands: [{ id: 'e1', note: 'set the 5% watch at the open', when: 'market_open', addedAt: '2026-08-23T00:00:00Z' }],
  theses: { MU: 'overnight gap-up into earnings' },
  watches: [{ id: 'w1', symbol: 'MU', condition: 'below', value: 340, baseline: 350, setAt: '2026-08-21T14:00:00Z' }],
  exits: { MU: { stop: 341.5, setAt: '2026-08-21T14:00:00Z' } },
  paper: {
    ...base.paper,
    cash: 500,
    positions: [
      { symbol: 'MU', qty: 5, avgCost: 350 },
      { symbol: 'AMD', qty: 3, avgCost: 160 }
    ],
    fills: [
      { id: 'f1', ts: '2026-08-21T14:00:00Z', side: 'buy', qty: 5, symbol: 'MU', price: 350, realized: 0 },
      { id: 'f2', ts: '2026-08-22T14:00:00Z', side: 'sell', qty: 2, symbol: 'AMD', price: 170, realized: 20 }
    ]
  }
} as AgentState

const market: MarketContext = {
  quotes: [{ symbol: 'MU', last: 358, bid: 357, ask: 359, changePct: 1.2 } as never, { symbol: 'AMD', last: 165 } as never],
  account: { buyingPower: 5000, cash: 5000, equity: 20_000 },
  session: 'open',
  etNow: 'x',
  analysis: 'ANALYSIS: MU extended vs its 20d'
}
const messages: Message[] = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, agentId: 'a1', role: 'agent', ts: '2026-08-24T13:50:00Z', text: `filler message ${i}` }) as Message)
const args = { cfg, state, trigger: 'schedule' as const, market, messages, ordersToday: 2, approvalNote: 'PENDING: waiting on the operator' }

// ── the registry itself ────────────────────────────────────────────────────
const blocks = runPromptBlocks(args)
const ids = blocks.map((x) => x.id)
const EXPECTED: BlockId[] = ['head', 'approval', 'clock', 'account', 'pdt', 'retirement', 'book', 'performance', 'protections', 'headroom', 'trackRecord', 'theses', 'quotes', 'analysis', 'memory', 'errands', 'transcript', 'selfReview']
// `pdt` renders only for a live agent under the equity floor; `modelSwitch` only
// after a vendor change. Everything else must be present on this fixture, or the
// check is asserting a property of a prompt that never got built.
for (const id of EXPECTED.filter((x) => x !== 'pdt')) check(`registry renders '${id}'`, ids.includes(id))
check('no block id appears twice', new Set(ids).size === ids.length)
check('every block is classified', blocks.every((x) => x.durability === 'mandatory' || x.durability === 'cuttable'))
check('no empty block survives', blocks.every((x) => x.text !== ''))

// ── the adversary: a budgeter that cuts everything it is allowed to ────────
let offered: PromptBlock[] = []
const starved = composeRunPromptWithin(args, (cuttable) => {
  offered = cuttable
  return []
})

check('fit is offered ONLY cuttable blocks', offered.every((x) => x.durability === 'cuttable'), offered.map((x) => x.id).join(','))
check('fit is never offered the book', !offered.some((x) => x.id === 'book'))
check('fit is never offered protections', !offered.some((x) => x.id === 'protections'))
check('fit is never offered memory', !offered.some((x) => x.id === 'memory'))
check('the transcript IS offered — it is the unbounded one', offered.some((x) => x.id === 'transcript'))

// The assertion that matters: an absurdly small budget still leaves
// every open position and every armed stop in the prompt.
check('starved prompt still holds position MU', /MU: 5 sh @ avg/.test(starved))
check('starved prompt still holds position AMD', /AMD: 3 sh @ avg/.test(starved))
check('starved prompt still holds the armed stop', starved.includes('341.50'), 'the MU stop level')
check('starved prompt still holds the open watch', starved.includes('[w1]'))
check('starved prompt still holds cash + realized P&L', starved.includes('YOUR BOOK') && starved.includes('realized P&L'))
check('starved prompt still holds live quotes', starved.includes('QUOTES'))
check('starved prompt still holds headroom limits', starved.includes('HEADROOM'))
// The one people get wrong: operator constraints live in memory, and a
// constraint that stops being rendered is a constraint that stops binding.
check('starved prompt still holds the operator constraint', starved.includes('never trade biotech'))
check('starved prompt still holds the second constraint', starved.includes('I need the cash Friday'))
check('starved prompt still holds the unsettled errand', starved.includes('set the 5% watch at the open'))
check('starved prompt still holds the pending approval', starved.includes('PENDING: waiting on the operator'))

// ...and it really did cut what it was allowed to, or the test above proves nothing.
check('the transcript WAS cut', !starved.includes('filler message 3'))
check('the track record WAS cut', !starved.includes('YOUR TRACK RECORD'))
check('the theses WERE cut', !starved.includes('overnight gap-up'))

// ── a fit that tries to forge a mandatory block ────────────────────────────
const forged = composeRunPromptWithin(args, () => [{ id: 'book', durability: 'cuttable', lead: '\n', text: 'YOUR BOOK (paper):\n- cash: $999,999.00' } as PromptBlock])
check('a forged mandatory block is ignored', !forged.includes('999,999'))
check('...and the real book survives it', /MU: 5 sh @ avg/.test(forged))

// ── the no-budget path is unchanged ────────────────────────────────────────
check('an identity fit reproduces composeRunPrompt exactly', composeRunPromptWithin(args, (c) => c) === composeRunPrompt(args))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
