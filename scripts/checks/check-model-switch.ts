/**
 * An agent moved to another model must be told that the reasoning above it is
 * not its own — and must NOT be told that when nothing changed.
 *
 * `agents:setProvider` moves an agent between Claude / ChatGPT / OpenRouter /
 * Local GPU at any time; a desktop→desktop move is a straight model swap. The next
 * run reads the previous model's thinking in the transcript as `[..] YOU: …`,
 * which is the one line in the whole prompt that claims first-person
 * authorship, and continues in that voice on those assumptions.
 *
 * The three properties asserted here are the ones that are easy to get wrong:
 *
 *  1. It fires on a real vendor change, and names BOTH models.
 *  2. It does NOT fire when the vendor is unchanged — a change of model id
 *     within one vendor keeps the same family of reasoning, and a notice would
 *     be a lie. The trigger is keyed on `ModelChoice.vendor`.
 *  3. It sits immediately BEFORE the transcript. Everything above that point is
 *     engine state (book, memory, theses, exits, watches) which survives the
 *     move untouched; a notice placed higher would read as casting doubt on all
 *     of it, which is a worse failure than the one being fixed.
 *
 * Run: `npm run check -- model-switch`
 */
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState, type Message, type ModelVendor } from '@shared/agents'
import { composeRunPrompt, modelSwitchBlock } from '@core/runner/prompts'
import type { MarketContext } from '@core/runner/types'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const cfg = (vendor: ModelVendor): AgentConfig =>
  ({
    id: 'a1',
    name: 'Tester',
    mode: 'paper',
    allocationUsd: 10_000,
    guardrails: DEFAULT_GUARDRAILS,
    model: { vendor, id: 'm', effort: 'medium' },
    schedule: { kind: 'manual' }
  }) as AgentConfig

const state = (vendor: ModelVendor): AgentState => ({ ...initialState(cfg(vendor)), runCount: 4, memory: ['never trade biotech'] })

const market: MarketContext = { quotes: [], account: null, session: 'open', etNow: '2026-08-24T10:00:00-04:00', analysis: '' }

const messages: Message[] = [{ id: 'm1', agentId: 'a1', role: 'agent', ts: '2026-08-24T13:50:00Z', text: 'Holding MU into the close per the gap thesis.' } as Message]

const prompt = (previousVendor: ModelVendor | undefined, vendor: ModelVendor): string =>
  composeRunPrompt({ cfg: cfg(vendor), state: state(vendor), trigger: 'schedule', market, messages, ordersToday: 0, previousVendor })

// ── 1. a real vendor change fires, and names both sides ────────────────────
const switched = prompt('claude', 'openrouter')
check('a vendor change renders the notice', switched.includes('MODEL CHANGE'))
check('it names the model that wrote the thread', switched.includes('(Claude)'), 'expected the FROM label')
check('it names the model reading it now', switched.includes('You are OpenRouter.'), 'expected the TO label')
check('it says the engine state still belongs to this agent', /book, performance, memory notes, theses, exits and watches/.test(switched))
check('it does not lead with tool availability', switched.indexOf('handover') < switched.indexOf('Tools are named the same'))

// ── 1b. the wiring: state.lastRunVendor drives it with no argument ─────────
// The host writes the field at end-of-run; nothing has to remember to pass it
// back in. That halves the cross-lane surface — one write, no plumbing.
const fromState = (last: ModelVendor | undefined, vendor: ModelVendor): string =>
  composeRunPrompt({ cfg: cfg(vendor), state: { ...state(vendor), lastRunVendor: last }, trigger: 'schedule', market, messages, ordersToday: 0 })
check('state.lastRunVendor alone fires it', fromState('claude', 'openrouter').includes('MODEL CHANGE'))
check('...naming the same two models', fromState('claude', 'openrouter').includes('(Claude)') && fromState('claude', 'openrouter').includes('You are OpenRouter.'))
check('state.lastRunVendor equal to current → silent', !fromState('openrouter', 'openrouter').includes('MODEL CHANGE'))
check('absent field → silent, never "assume a change"', !fromState(undefined, 'openrouter').includes('MODEL CHANGE'))
check('the explicit arg overrides the field', composeRunPrompt({ cfg: cfg('openrouter'), state: { ...state('openrouter'), lastRunVendor: 'openrouter' }, trigger: 'schedule', market, messages, ordersToday: 0, previousVendor: 'claude' }).includes('MODEL CHANGE'))

// ── 2. the cases that must stay silent ─────────────────────────────────────
check('no previous vendor recorded → silent', !prompt(undefined, 'claude').includes('MODEL CHANGE'))
check('same vendor → silent', !prompt('claude', 'claude').includes('MODEL CHANGE'))
// A different OpenRouter model id is still vendor 'openrouter': same family of
// reasoning, so the prior reasoning is genuinely the agent's own.
check('openrouter → openrouter stays silent', !prompt('openrouter', 'openrouter').includes('MODEL CHANGE'))

// ── 3. placement: after the engine state, immediately before the thread ─────
const at = switched.indexOf('MODEL CHANGE')
check('the notice sits before the transcript', at < switched.indexOf('THREAD SO FAR'), `notice ${at}`)
check('...and after the book', at > switched.indexOf('YOUR BOOK'))
check('...and after the memory notes it explicitly exempts', at > switched.indexOf('YOUR MEMORY NOTES'))
check('nothing separates it from the thread but a blank line', /MODEL CHANGE[^\n]*\n\nTHREAD SO FAR/.test(switched))

// Every vendor pair must produce a legible sentence — a missing label would
// render "(undefined)" to the model rather than throwing.
for (const from of ['claude', 'chatgpt', 'openrouter', 'local'] as ModelVendor[])
  for (const to of ['claude', 'chatgpt', 'openrouter', 'local'] as ModelVendor[])
    if (from !== to) check(`${from} → ${to} names both models`, !modelSwitchBlock(from, to).includes('undefined'))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
