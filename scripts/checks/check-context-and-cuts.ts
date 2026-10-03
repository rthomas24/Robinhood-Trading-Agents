/**
 * What a run prices, what it tells the model about today, and the sell it
 * answers instead of placing.
 *
 *   1. `symbolsOfInterest` puts held names first (a long allowlist used to
 *      push them off the end), and includes watches and today's fills.
 *   2. `bookPnl`: a symbol sold today with no mark is valued at what it traded
 *      for, not $0 — the whole sale used to read as a day's gain (thousands
 *      on a day that made a few dollars).
 *   3. `cutInsideRange`: an unattended sell at a loss inside the trail floor,
 *      above an armed stop, is answered once with the numbers; acknowledged,
 *      at a profit, past the floor, without a stop, or without a range it is
 *      placed.
 *   4. `stripLeakedMarkup`: tool-call pseudo-XML written as prose is cut from
 *      the reply; words survive a dangling tag.
 *   5. Failed and skipped runs are filed under the model that RAN
 *      (`openRouterModelFor`), not a stale id.
 *   6. Technicals are fetched on demand for a BUY of a name the run did not
 *      pre-compute, the post-mortem is served by the feed and shown once ripe,
 *      and a flat unpriced book still anchors its day.
 *
 * Run: `npm run check -- context-and-cuts`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_GUARDRAILS, DEFAULT_OPENROUTER_MODEL_ID, bookPnl, cutInsideRange, emptyLedger, openRouterModelFor, initialState, trailFloorPct, type AgentConfig, type AgentState } from '@shared/agents'
import { stripLeakedMarkup } from '@core/runner/markup'
import { SYMBOLS_MAX, symbolsOfInterest } from '@core/runner/runOnce'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const R = join(import.meta.dirname, '..', '..')
const read = (p: string): string => readFileSync(join(R, p), 'utf8').replace(/\r\n/g, '\n')

// ------------------------------------------------------- 1. symbolsOfInterest
console.log('— what a run prices —')
const many = Array.from({ length: 20 }, (_, i) => `S${String(i).padStart(2, '0')}`)
const cfg = { id: 'ag', name: 'T', mode: 'paper', task: 'trade $NVDA momentum', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS, allowedSymbols: many }, liveArmedAt: null } as unknown as AgentConfig
const today = '2026-09-11'
const state: AgentState = {
  ...initialState({ allocationUsd: 10_000 }),
  paper: {
    ...emptyLedger(9_000),
    positions: [{ symbol: 'HELD', qty: 1, avgCost: 100 }],
    fills: [
      { id: 'f0', ts: '2026-09-10T15:00:00.000Z', symbol: 'OLD', side: 'sell', qty: 1, price: 10, realized: 0 },
      { id: 'f1', ts: '2026-09-11T14:00:00.000Z', symbol: 'SOLD', side: 'sell', qty: 1, price: 10, realized: 0 }
    ]
  },
  watches: [{ id: 'w1', symbol: 'wtch', condition: 'above', value: 1, baseline: 1, setAt: 'x' }]
}
const syms = symbolsOfInterest(cfg, state, today)
check('the held name comes FIRST, ahead of a long allowlist', syms[0] === 'HELD', syms.join(','))
check('a watched symbol is priced (upper-cased)', syms.includes('WTCH'))
check("today's sold symbol is priced, yesterday's is not", syms.includes('SOLD') && !syms.includes('OLD'))
check(`the list is capped at ${SYMBOLS_MAX}`, syms.length === SYMBOLS_MAX && SYMBOLS_MAX >= 12)
check('the allowlist still fills the rest', syms.includes('S00'))
check('a task ticker is only reached when there is room (allowlist of 20 fills the cap)', !syms.includes('NVDA'))

// ---------------------------------------------------------------- 2. bookPnl
console.log('\n— "today" in the prompt —')
// Held 10 X from yesterday, sold them today at $101 for $1,010; nothing marks X now.
const soldToday = { ...emptyLedger(10_010), fills: [{ id: 's1', ts: `${today}T15:00:00.000Z`, symbol: 'X', side: 'sell' as const, qty: 10, price: 101, realized: 10 }] }
const etDateOf = (iso: string): string => iso.slice(0, 10)
const pnl = bookPnl({ mode: 'paper', allocationUsd: 10_000 }, { paper: soldToday, live: emptyLedger(0) }, {}, today, etDateOf)
check('an unmarked sale is valued at its own price: day P&L 0, not the whole $1,010', Math.abs(pnl.dayPnl) < 0.005, `dayPnl ${pnl.dayPnl.toFixed(2)}`)
const marked = bookPnl({ mode: 'paper', allocationUsd: 10_000 }, { paper: soldToday, live: emptyLedger(0) }, { X: { last: 101, prevClose: 100 } }, today, etDateOf)
check('with a mark, prevClose still wins (+$10 on the day)', Math.abs(marked.dayPnl - 10) < 0.005, `dayPnl ${marked.dayPnl.toFixed(2)}`)

// ------------------------------------------------------- 3. cutInsideRange
console.log('\n— the early cut —')
const adr = 4 // floor 3%
check('floor is 0.75× ADR', trailFloorPct(adr) === 3)
const cut = cutInsideRange('META', 100, 99, adr, 95)
check('−1% with a stop at −5% is answered, with the numbers', cut !== null && /1\.00% under your cost/.test(cut) && /\$95\.00/.test(cut) && /acknowledgeTight/.test(cut), cut ?? 'null')
check('a loss past the floor is placed', cutInsideRange('META', 100, 96.5, adr, 95) === null)
check('a profit is placed', cutInsideRange('META', 100, 101, adr, 95) === null)
check('no stop armed → placed (nothing bounds the downside)', cutInsideRange('META', 100, 99, adr, undefined) === null)
check('a stop above the price (already breached) → placed', cutInsideRange('META', 100, 99, adr, 99.5) === null)
check('no range computed → placed (never refuse on a guess)', cutInsideRange('META', 100, 99, null, 95) === null)
const runOnceSrc = read('src/core/runner/runOnce.ts')
check('runOnce answers it only for UNATTENDED sells of a held name, not acknowledged', /intent\.side === 'sell' && heldBefore > 1e-9 && !intent\.acknowledgeTight && !attended/.test(runOnceSrc))
check('…never from 15:50 ET, never on a broker-owned plan', /minutes >= OVERNIGHT_WARN_MINUTES\) return null/.test(runOnceSrc) && /plan\.enforcedBy === 'broker'\) return null/.test(runOnceSrc))
check('…and audits it under its own rule', /rule: 'exit\.cutInsideRange'/.test(runOnceSrc) && /'exit\.cutInsideRange'/.test(read('src/shared/decisions.ts')) && /'exit\.cutInsideRange':/.test(read('src/shared/decisionSummary.ts')))
check('the tool flag covers the sell case', /or a SELL at a loss inside the noise band/.test(read('src/core/runner/agentTools.ts')))

// ---------------------------------------------------------- 4. markup leak
console.log('\n— markup in the reply —')
const glm = 'Holding QCOM.\n<tool_call>mcp__tb__report<arg_key>headline</arg_key><arg_value>holding</arg_value></tool_call>\nExits armed.'
const s1 = stripLeakedMarkup(glm)
check('a GLM-shaped tool call written as prose is removed whole', s1.leaked && s1.text === 'Holding QCOM.\n\nExits armed.', JSON.stringify(s1.text))
const s2 = stripLeakedMarkup('Sold at $101.\n<function_results>\n{"ok":true}\n</function_results>\nDone.')
check('a replayed function_results block is removed', s2.leaked && !/ok":true/.test(s2.text) && /Done\./.test(s2.text))
const s3 = stripLeakedMarkup('I will file the report now <invoke name="mcp__tb__report"> and hold.')
check('a dangling tag goes alone; the words stay', s3.leaked && s3.text === 'I will file the report now  and hold.')
check('plain prose is untouched (and cheap)', !stripLeakedMarkup('Price < $100 and > $90; a<b.').leaked)
check('runOnce cleans the reply and traces the leak', /stripLeakedMarkup\(result\.texts\.join/.test(runOnceSrc) && /trace\?\.event\('markup_leak'/.test(runOnceSrc))

// ------------------------------------------------------- 5. the model that ran
console.log('\n— the model on the run row —')
check('a stored OpenRouter id runs as itself; an empty one runs the default', openRouterModelFor('x-ai/grok-4.6') === 'x-ai/grok-4.6' && openRouterModelFor('') === DEFAULT_OPENROUTER_MODEL_ID)
const or = read('src/core/runner/vendors/openrouter.ts')
check('the vendor stamps modelUsed before the first response', /out\.modelUsed = modelId/.test(or) && or.indexOf('out.modelUsed = modelId') < or.indexOf('out.modelUsed = resp.model'))
check('the skipped row and the record fallback resolve it too', (runOnceSrc.match(/openRouterModelFor\(/g) ?? []).length >= 2)

// ------------------------------------------------------------ 6. the rest
console.log('\n— technicals on demand, post-mortem, day anchor —')
check('a BUY fetches technicals for a symbol the run did not pre-compute, before the trail floor', /await ensureTechnicals\(intent\.symbol\)\s+const tight = trailFloorAdvisory\(TRADE_TOOL/.test(runOnceSrc))
check('…bounded, and merged into the run context', /ON_DEMAND_TECHNICALS_MS/.test(runOnceSrc) && /analyses: \[\.\.\.symbolCtx\.analyses, \.\.\.extra\.analyses\]/.test(runOnceSrc))
check('the post-mortem is served by the feed, shown once ripe, remembered', /feed\.bars\(\[\.\.\.new Set\(exits/.test(runOnceSrc) && /POST_MORTEM_AFTER_MS/.test(runOnceSrc) && /postMortemSeen: \[/.test(runOnceSrc))
check('a flat book anchors its day without a quote', /if \(quotes\.length \|\| ledger0\.positions\.length === 0\)/.test(runOnceSrc))

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exitCode = failures ? 1 : 0
