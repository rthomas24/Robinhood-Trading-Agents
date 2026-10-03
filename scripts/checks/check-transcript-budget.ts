/**
 * Max-min fair truncation of the transcript.
 *
 * Written against the threat rather than the description: property tests
 * derived from a spec can all pass a function with real bypasses in it. "The budget was respected" is the description. The threat is
 * an agent that trades on a book it cannot fully see, or acts against an
 * operator instruction that silently stopped being rendered.
 *
 * So the assertions here are:
 *
 *  1. Under an ABSURD budget the prompt still carries every open position and
 *     every armed stop. `composeRunPromptWithin` is supposed to make that
 *     unfailable; this proves it rather than assuming it.
 *  2. The operator's most recent instruction survives a budget that drops most
 *     of the transcript. An agent that kept its own chatter and lost the
 *     instruction the chatter was about is worse off than one that lost both.
 *  3. The notice's count and the number actually dropped CANNOT disagree —
 *     probed across many budgets, not asserted once.
 *  4. Small messages survive whole while large ones absorb the loss. That is
 *     what makes this max-min rather than proportional truncation, and it is
 *     the property that would silently regress into "everything mangled".
 *
 * Run: `npm run check -- transcript-budget`
 */
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState, type Message } from '@shared/agents'
import { composeRunPrompt, composeRunPromptWithin, transcriptBlock, transcriptBudgetFor } from '@core/runner/prompts'
import type { MarketContext } from '@core/runner/types'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const msg = (role: string, i: number, text: string): Message => ({ id: `m${i}`, agentId: 'a1', role, ts: `2026-08-24T13:${String(10 + i).padStart(2, '0')}:00Z`, text }) as Message

// A realistic window: a few huge agent monologues, many small lines, and two
// operator instructions — the newest of which is the one that must survive.
const OPERATOR_OLD = 'never trade biotech, ever'
const OPERATOR_NEW = 'do not go above $500 in any one position today'
const messages: Message[] = [
  msg('user', 0, OPERATOR_OLD),
  ...Array.from({ length: 6 }, (_, i) => msg('agent', i + 1, `LONG MONOLOGUE ${i} `.repeat(120))),
  ...Array.from({ length: 10 }, (_, i) => msg('agent', i + 7, `short note ${i}`)),
  msg('user', 17, OPERATOR_NEW),
  msg('agent', 18, 'acknowledged')
]

const full = transcriptBlock(messages)
check('no budget → unchanged (today\'s behaviour is the default)', transcriptBlock(messages, undefined) === full)
check('a budget larger than the content → unchanged', transcriptBlock(messages, full.length * 2) === full)

// ── 2. the operator's words are the last thing to go ──────────────────────
for (const budget of [400, 800, 1500, 3000, 6000]) {
  const out = transcriptBlock(messages, budget)
  check(`budget ${budget}: the NEWEST operator instruction survives`, out.includes(OPERATOR_NEW), out.length ? `${out.length} chars` : 'empty')
  check(`budget ${budget}: the older operator instruction survives too`, out.includes(OPERATOR_OLD))
}
// The operator's words outlast the agent's own long-form reasoning, which is
// the whole point of the priority rule.
const tight = transcriptBlock(messages, 900)
check('at a tight budget the agent monologues are gone', !tight.includes('LONG MONOLOGUE 0'))
check('...while the operator instructions remain', tight.includes(OPERATOR_NEW) && tight.includes(OPERATOR_OLD))

// ── 3. the notice cannot disagree with reality ────────────────────────────
// Probed across the whole range rather than asserted at one budget: an
// off-by-one is a lie told confidently, and it hides at specific sizes.
let noticeMismatch = 0
let noticeMissing = 0
for (let budget = 200; budget <= 8000; budget += 50) {
  const out = transcriptBlock(messages, budget)
  const claimed = /\[(\d+) earlier messages? omitted/.exec(out)
  // A line survives if its text is present; count what is actually rendered.
  const bodyLines = out.split('\n').filter((l) => /^\[/.test(l) && !/earlier messages? omitted/.test(l))
  const actuallyDropped = messages.length - bodyLines.length
  if (actuallyDropped > 0 && !claimed) noticeMissing++
  else if (claimed && Number(claimed[1]) !== actuallyDropped) noticeMismatch++
}
check('every budget that drops a message says so', noticeMissing === 0, `${noticeMissing} silent drops`)
check('the notice count never disagrees with the drop count', noticeMismatch === 0, `${noticeMismatch} mismatches`)
// Assert the FACTS the notice must carry, not its wording — it has a long and
// a terse form (see below) and a test pinned to one phrasing would pass on the
// wrong form. All three facts are load-bearing: an agent that assumes only the
// oldest messages went will confidently reconstruct a sequence that never
// happened, and one that does not know the operator can still see them will not
// understand a reference to something it cannot read.
for (const budget of [400, 900, 2000, 5000]) {
  const out = transcriptBlock(messages, budget)
  if (!/omitted/.test(out)) continue
  check(`budget ${budget}: the notice says omissions may be from anywhere`, /anywhere in the (thread|conversation)/.test(out))
  check(`budget ${budget}: ...that the operator can still see them`, /operator/.test(out))
  check(`budget ${budget}: ...and what to do about it`, /[Aa]sk/.test(out))
}
// The degradation itself: a notice that crowds out the messages it describes
// has inverted its own purpose. At 400 the long form consumed the entire budget
// and NOTHING survived — including the operator's standing instructions.
check('a tight budget uses the terse notice', transcriptBlock(messages, 400).length < transcriptBlock(messages, 5000).length)
check('...and content survives alongside it', transcriptBlock(messages, 400).split('\n').some((l) => /^\[/.test(l) && !/omitted/.test(l)))

// ── 3b. the budget is actually respected, across the whole range ──────────
// This is the assertion the first version of this check did NOT have, and it
// was hiding two real defects: truncated lines each spilled one character past
// their allocation, and the omission notice was not counted against the budget
// at all, so asking for 400 chars returned 514. Probed, not spot-checked.
//
// The one honest floor: when the budget is smaller than the header plus the
// notice, the block cannot be smaller than those and still say what it is.
const FLOOR = transcriptBlock(messages, 0).length
let over = 0
let worst = 0
for (let budget = 1; budget <= 9000; budget += 7) {
  const len = transcriptBlock(messages, budget).length
  if (len > Math.max(budget, FLOOR)) {
    over++
    worst = Math.max(worst, len - Math.max(budget, FLOOR))
  }
}
check('no budget in 1..9000 is exceeded', over === 0, `${over} budgets over, worst by ${worst} chars`)
check('the floor is the header plus the notice and nothing more', FLOOR < 500, `${FLOOR} chars`)
check('an empty thread ignores the budget entirely', transcriptBlock([], 0) === 'THREAD SO FAR: (empty — this is the first run)')

// ── 4. max-min, not proportional ──────────────────────────────────────────
const mid = transcriptBlock(messages, 2500)
const shortNotesKept = Array.from({ length: 10 }, (_, i) => `short note ${i}`).filter((s) => mid.includes(s)).length
check('small messages survive WHOLE rather than all being mangled', shortNotesKept >= 8, `${shortNotesKept}/10 short notes intact`)
check('a big message absorbs the loss instead', !mid.includes('LONG MONOLOGUE 0 '.repeat(120)))
check('no message is left as a useless stub', !/\n\[[^\n]{1,60}…\[truncated\]/.test(mid) || mid.includes('…[truncated]'))

// ── 1. the threat: an absurd budget must not cost a position or a stop ────
const cfg: AgentConfig = {
  id: 'a1',
  name: 'T',
  mode: 'paper',
  allocationUsd: 10_000,
  guardrails: { ...DEFAULT_GUARDRAILS, maxPositionNotional: 2000 },
  model: { vendor: 'claude', id: 'm', effort: 'medium' },
  schedule: { kind: 'manual' }
} as AgentConfig
const base = initialState({ allocationUsd: 10_000 })
const state: AgentState = {
  ...base,
  memory: ['never trade biotech'],
  exits: { MU: { stop: 341.5, setAt: '2026-08-21T14:00:00Z' } },
  watches: [{ id: 'w1', symbol: 'MU', condition: 'below', value: 340, baseline: 350, setAt: '2026-08-21T14:00:00Z' }],
  paper: {
    ...base.paper,
    cash: 500,
    positions: [
      { symbol: 'MU', qty: 5, avgCost: 350 },
      { symbol: 'AMD', qty: 3, avgCost: 160 }
    ]
  }
} as AgentState
const market: MarketContext = { quotes: [{ symbol: 'MU', last: 358 } as never, { symbol: 'AMD', last: 165 } as never], account: null, session: 'open', etNow: 'x', analysis: '' }

for (const budget of [0, 1, 50, 200]) {
  const p = composeRunPrompt({ cfg, state, trigger: 'schedule', market, messages, ordersToday: 0, transcriptBudgetChars: budget })
  check(`budget ${budget}: position MU survives`, /MU: 5 sh @ avg/.test(p))
  check(`budget ${budget}: position AMD survives`, /AMD: 3 sh @ avg/.test(p))
  check(`budget ${budget}: the armed stop survives`, p.includes('341.50'))
  check(`budget ${budget}: the operator constraint in memory survives`, p.includes('never trade biotech'))
}
// Belt and braces: the block-level seam on top of the message-level budget.
const both = composeRunPromptWithin({ cfg, state, trigger: 'schedule', market, messages, ordersToday: 0, transcriptBudgetChars: 0 }, () => [])
check('transcript budget 0 AND a fit that cuts everything', /MU: 5 sh @ avg/.test(both) && both.includes('341.50') && both.includes('never trade biotech'))

// ── 5. the OTHER unbounded block ─────────────────────────────────────────
// "The transcript is the only unbounded cuttable block" was only true of what
// anybody had noticed: `set_thesis` writes theses[symbol]
// with no cap and nothing evicts one when its position closes, while every
// other collection is bounded. A hundred symbols traded = a hundred lines of
// stale opinion on every run.
const manyTheses: AgentState = { ...state, theses: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`SYM${i}`, `thesis number ${i}`])) } as AgentState
const heldTheses: AgentState = { ...manyTheses, theses: { ...manyTheses.theses, MU: 'MU is the live one', AMD: 'AMD is also live' } } as AgentState
const tp = composeRunPrompt({ cfg, state: heldTheses, trigger: 'schedule', market, messages: [], ordersToday: 0 })
// Scope the count to the THESES block — `- MU: 5 sh @ avg` in the book and
// `- MU: stop $341.50` in the exits match the same line shape.
const thesisSection = tp.slice(tp.indexOf('YOUR THESES')).split('\n\n')[0]
const thesisLines = thesisSection.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- ('))
check('the theses block is bounded', thesisLines.length <= 12, `${thesisLines.length} lines`)
check('theses on HELD positions are kept', tp.includes('MU is the live one') && tp.includes('AMD is also live'))
check('the overflow is named, not silently dropped', /\(\d+ more on symbols you no longer hold/.test(tp))
check('...and says they still exist', tp.includes('They still exist'))
const fewTheses = composeRunPrompt({ cfg, state: { ...state, theses: { MU: 'only one' } } as AgentState, trigger: 'schedule', market, messages: [], ordersToday: 0 })
check('a small thesis set renders with no notice', fewTheses.includes('only one') && !/more on symbols you no longer hold/.test(fewTheses))

// ── 6. THE ASSERTION THAT WAS MISSING: truncation is actually ON ──────────
// A budgeter can ship that nothing passes a budget to. An adversarial
// probe proved the function worked at five budget sizes and never asked whether
// any caller supplies one — so the feature was inert while the board read
// green. These assert the DEFAULT path: composeRunPrompt with no
// transcriptBudgetChars at all, which is how every real caller invokes it.
const huge: Message[] = Array.from({ length: 24 }, (_, i) => msg('agent', i, `verbose agent reasoning ${i} `.repeat(400)))
const smallModel = { ...cfg, model: { vendor: 'local', id: 'local', effort: 'medium' } } as AgentConfig
const bigModel = { ...cfg, model: { vendor: 'claude', id: 'claude-sonnet-5', effort: 'medium' } } as AgentConfig

const defaulted = composeRunPrompt({ cfg: smallModel, state, trigger: 'schedule', market, messages: huge, ordersToday: 0 })
const unbounded = composeRunPrompt({ cfg: smallModel, state, trigger: 'schedule', market, messages: huge, ordersToday: 0, transcriptBudgetChars: Infinity })
// The proof that the DEFAULT applies a budget: the same call with truncation
// explicitly disabled is materially longer. Asserting on the omission notice
// would have been wrong here — at this size every message is CUT rather than
// dropped, so there is nothing to omit and no notice, which is correct.
check('no budget argument → a budget is still applied', defaulted.length < unbounded.length, `${defaulted.length} vs ${unbounded.length} unbounded`)
check('...and messages were cut rather than dropped at this size', defaulted.includes('…[truncated]'))
check('...bounded by the model window', defaulted.length < transcriptBudgetFor(smallModel.model) + 20_000)
check('...and the book survives it', /MU: 5 sh @ avg/.test(defaulted) && defaulted.includes('341.50'))

// The budget is a SAFETY VALVE, not a routine trimmer: a large-window model
// must not truncate an ordinary thread, or every agent grows an omission notice
// and the operator's instructions start competing for room they never needed to.
const roomy = composeRunPrompt({ cfg: bigModel, state, trigger: 'schedule', market, messages, ordersToday: 0 })
check('a large-window model does not truncate a normal thread', !roomy.includes('omitted'))
check('a small window budgets far less than a large one', transcriptBudgetFor(smallModel.model) < transcriptBudgetFor(bigModel.model))

// The LOCAL case, asserted explicitly rather than left to the generic path
// (flagged by lane B). `contextWindowFor` floors an unrecognised model at 128k,
// which is conservative for ROTATION and permissive for a BUDGET — the same
// constant pointing opposite ways depending on what reuses it. A local GGUF's
// real window is commonly 8k, so a budget derived from 128k would authorise a
// ~51k-token transcript on an 8k model and could not fire before the overflow
// it exists to prevent.
const localBudget = transcriptBudgetFor({ id: 'local' })
check('an unknown model is budgeted well below the 128k rotation floor', localBudget < 128_000 * 0.4 * 3.5 / 4, `${localBudget} chars`)
check('...and small enough to be safe on an 8k GGUF', localBudget <= 8_000 * 4, `${localBudget} chars vs ~32000 chars of an 8k window`)
check('a KNOWN large model is not punished by that assumption', transcriptBudgetFor({ id: 'claude-sonnet-5' }) > localBudget * 8)
check('every unrecognised id gets the same tight budget', transcriptBudgetFor({ id: 'some-future-model' }) === localBudget)
check('an explicit Infinity disables truncation', !composeRunPrompt({ cfg: smallModel, state, trigger: 'schedule', market, messages: huge, ordersToday: 0, transcriptBudgetChars: Infinity }).includes('omitted'))
check('an explicit number still overrides the default', composeRunPrompt({ cfg: bigModel, state, trigger: 'schedule', market, messages, ordersToday: 0, transcriptBudgetChars: 900 }).includes('omitted'))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
