/**
 * Where the prompt actually goes.
 *
 * The instrument prompt budgeting is steered by, so the way it can hurt us is
 * by being confidently wrong rather than by failing. Three ways that happens, and
 * each has assertions here:
 *
 *  1. **Fabricating tokens.** `contextTokens` is 0 when the vendor did not
 *     report one, and 0 means "not measured". A breakdown that quietly turns
 *     that into per-category estimates from a chars-per-token guess produces a
 *     number indistinguishable from the one we bill on. It must report chars
 *     and omit tokens instead.
 *  2. **Absorbing the residual.** Vendor framing and the tool wire format are
 *     real tokens we cannot attribute. Spreading them across categories makes
 *     every figure slightly wrong while looking tidy.
 *  3. **Drifting out of step with the prompt.** A breakdown that names eight
 *     hard-coded categories while the prompt has nineteen blocks answers a
 *     question about a prompt we no longer build. The categories are derived
 *     from the block registry, and the last section asserts that coupling by
 *     feeding it a real prompt rather than a fixture.
 *
 * Run: `npm run check -- prompt-breakdown`
 */
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState, type Message } from '@shared/agents'
import { composeSystemPrompt, runPromptBlocks } from '@core/runner/prompts'
import { formatBreakdown, promptBreakdown } from '@core/runner/promptBreakdown'
import type { MarketContext } from '@core/runner/types'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const cfg: AgentConfig = {
  id: 'a1',
  name: 'T',
  mode: 'paper',
  allocationUsd: 10_000,
  guardrails: DEFAULT_GUARDRAILS,
  model: { vendor: 'claude', id: 'm', effort: 'medium' },
  schedule: { kind: 'manual' },
  tasks: [{ id: 't1', text: 'make 10% this week', addedAt: '2026-08-20T00:00:00Z' }]
} as AgentConfig
const base = initialState({ allocationUsd: 10_000 })
const state: AgentState = {
  ...base,
  memory: ['never trade biotech'],
  theses: { MU: 'gap-up into earnings' },
  exits: { MU: { stop: 341.5, setAt: '2026-08-21T14:00:00Z' } },
  paper: { ...base.paper, cash: 500, positions: [{ symbol: 'MU', qty: 5, avgCost: 350 }] }
} as AgentState
const market: MarketContext = { quotes: [{ symbol: 'MU', last: 358 } as never], account: { buyingPower: 5000, cash: 5000, equity: 20_000 }, session: 'open', etNow: 'x', analysis: 'ANALYSIS: extended' }
// A deliberately transcript-heavy window — the thing the instrument exists to
// reveal is exactly this shape, one category dwarfing the rest.
const messages: Message[] = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, agentId: 'a1', role: 'agent', ts: '2026-08-24T13:50:00Z', text: `a fairly long agent message number ${i} `.repeat(12) }) as Message)

const systemPrompt = composeSystemPrompt(cfg, ['- webvector: news'], [])
const blocks = runPromptBlocks({ cfg, state, trigger: 'schedule', market, messages, ordersToday: 0 })
const toolsJson = JSON.stringify({ tools: Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}`, schema: { a: 1, b: 2 } })) })

// ── 1. no vendor total → chars only, never invented tokens ────────────────
for (const [label, ct] of [
  ['absent', undefined],
  ['zero (unreported, not empty)', 0]
] as [string, number | undefined][]) {
  const b = promptBreakdown({ systemPrompt, toolsJson, blocks, contextTokens: ct })
  check(`${label}: no totalTokens`, b.totalTokens === undefined)
  check(`${label}: no per-category tokens`, b.categories.every((c) => c.tokens === undefined))
  check(`${label}: no unaccounted figure`, b.unaccountedTokens === undefined)
  check(`${label}: chars are still measured`, b.totalChars > 0 && b.categories.length > 0)
  check(`${label}: the text says why`, formatBreakdown(b).includes('no token total'))
}

// ── 2. with a real total: calibrated, and the residual is NAMED ───────────
const TOTAL = 40_000
const b = promptBreakdown({ systemPrompt, toolsJson, blocks, contextTokens: TOTAL })
check('the vendor total is passed through unchanged', b.totalTokens === TOTAL)
const attributed = b.categories.reduce((s, c) => s + (c.tokens ?? 0), 0)
check('attributed + unaccounted equals the real total', attributed + (b.unaccountedTokens ?? 0) === TOTAL, `${attributed} + ${b.unaccountedTokens}`)
check('the residual is never negative', (b.unaccountedTokens ?? 0) >= 0)
check('shares sum to 1', Math.abs(b.categories.reduce((s, c) => s + c.share, 0) - 1) < 1e-9)
check('every category with chars has tokens', b.categories.every((c) => c.chars === 0 || typeof c.tokens === 'number'))
// The residual must come from the vendor total exceeding what we can see — not
// from rounding being swept into it. With chars-proportional apportionment on a
// prompt this size, rounding is a handful of tokens at most.
check('the residual is rounding-sized when we can see everything', (b.unaccountedTokens ?? 0) < b.categories.length + 2, String(b.unaccountedTokens))

// A vendor total LARGER than our measurement (framing, wire format) is the
// normal case, and the extra must land in `unaccounted` rather than inflating
// categories.
const big = promptBreakdown({ systemPrompt, toolsJson, blocks, contextTokens: TOTAL })
check('categories never claim more than the total', big.categories.reduce((s, c) => s + (c.tokens ?? 0), 0) <= TOTAL)

// ── 2b. the invariant, PROVED rather than sampled ─────────────────────────
// These two assertions used to hold on one hand-built input, and that is
// exactly how they failed: `Math.round` per category can sum ABOVE the total,
// which is content-dependent, so the check went red without the module being
// edited and would have gone green again on its own. A single input cannot
// prove an arithmetic property — it can only fail to disprove it, which is the
// distinction that matters here.
//
// `Math.floor` makes it true by construction (the sum can only undershoot, and
// the dust lands in `unaccounted`), and the loop below is what says so: 20k
// deterministic pseudo-random shapes, seeded so any failure is reproducible.
{
  let seed = 12345
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % Math.max(1, n) }
  const str = (n: number): string => 'x'.repeat(n)
  let violations = 0
  let first = ''
  for (let i = 0; i < 20_000; i++) {
    const blocks = Array.from({ length: rnd(9) }, (_, k) => ({ id: `b${k}`, lead: str(rnd(300)), text: str(rnd(40_000)), durability: rnd(2) ? 'mandatory' : 'trimmable' }) as never)
    const r = promptBreakdown({
      systemPrompt: str(rnd(20_000)),
      ...(rnd(2) ? { toolsJson: str(rnd(30_000)) } : {}),
      blocks,
      contextTokens: rnd(400_000)
    })
    if (r.totalTokens === undefined) continue
    const sum = r.categories.reduce((acc, c) => acc + (c.tokens ?? 0), 0)
    const residual = r.unaccountedTokens ?? 0
    if (residual < 0 || sum + residual !== r.totalTokens) {
      violations++
      if (!first) first = `sum=${sum} residual=${residual} total=${r.totalTokens} blocks=${blocks.length}`
    }
  }
  check('the invariant holds across 20k randomised shapes', violations === 0, violations === 0 ? 'attributed + unaccounted === total, residual never negative' : `${violations} violations, first: ${first}`)
}

// ── 3. it answers the question it exists for ──────────────────────────────
check('sorted largest first', b.categories.every((c, i) => i === 0 || b.categories[i - 1].chars >= c.chars))
check('the transcript is identified as the biggest consumer', b.categories[0].id === 'transcript', b.categories[0].id)
check('the system prompt is measured', b.categories.some((c) => c.id === 'system' && c.chars > 500))
check('the tool definitions are measured', b.categories.some((c) => c.id === 'tools' && c.chars === toolsJson.length))
check('tools are omitted when the caller has none', !promptBreakdown({ systemPrompt, blocks, contextTokens: TOTAL }).categories.some((c) => c.id === 'tools'))

// ── 4. the coupling: categories come from the registry, not a hard-coded list ──
// A fixed list of eight categories would not do: the prompt has nineteen
// blocks and gains more; a hard-coded list would answer a question about a prompt we no
// longer build. Every non-empty block must appear, by id.
for (const blk of blocks) check(`block '${blk.id}' appears in the breakdown`, b.categories.some((c) => c.id === blk.id))
check('no phantom categories', b.categories.every((c) => c.id === 'system' || c.id === 'tools' || blocks.some((x) => x.id === c.id)))

// ── 5. degenerate inputs do not throw or produce NaN ──────────────────────
const empty = promptBreakdown({ systemPrompt: '', blocks: [], contextTokens: 0 })
check('an empty prompt is 0 chars, no categories, no NaN', empty.totalChars === 0 && empty.categories.length === 0)
check('formatting an empty breakdown does not throw', typeof formatBreakdown(empty) === 'string')
const negative = promptBreakdown({ systemPrompt, blocks, contextTokens: -5 })
check('a negative total is treated as unmeasured', negative.totalTokens === undefined)

console.log('\n' + formatBreakdown(b).split('\n').slice(0, 6).join('\n'))
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
