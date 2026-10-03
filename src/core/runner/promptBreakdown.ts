/**
 * Where the prompt actually goes.
 *
 * We know a run used N input tokens. We cannot say whether that was the book,
 * the transcript, the tool definitions or one enormous WebVector result — so
 * every prompt-budgeting decision was guesswork until this existed. It
 * changes no behaviour on its own; it is the instrument budgeting is steered by.
 *
 * ── Chars are measured, tokens are CALIBRATED, and the difference is stated ──
 *
 * `core` holds no tokenizer, and inventing one would produce a number that
 * looks like the figure we bill on and is not. So each category is measured
 * exactly in characters, and tokens are apportioned from the vendor's OWN
 * reported total (`RunRecord.contextTokens`) in proportion to those characters.
 * That is what "calibrates against real totals" means: the total is
 * ground truth, and only the split between categories is estimated.
 *
 * Two consequences worth being explicit about, because both are the kind of
 * thing that silently turns a diagnostic into a lie:
 *
 *  - **No total, no token figures.** `contextTokens` is 0 when the vendor did
 *    not report it, and 0 means "not measured", never "measured zero". With no
 *    total the breakdown reports characters and percentages and omits tokens
 *    entirely, rather than fabricating a per-category estimate from a
 *    chars-per-token guess.
 *  - **`unaccounted` is reported, not absorbed.** Vendor framing, the tool wire
 *    format and chat scaffolding are real tokens we cannot attribute. Spreading
 *    them across the categories would make every number slightly wrong while
 *    looking tidy; naming the residual is what makes the rest trustworthy, and
 *    a residual that grows is itself the finding.
 *
 * Nothing here is ever used to report or gate spend. `RunRecord.inputTokens`
 * and the usage meter keep coming from `getUsage()`. A measurement computed
 * here must never become a number we bill on.
 *
 * Pure: no imports beyond the block type, no Node APIs.
 */
import type { PromptBlock } from './prompts'

export interface CategorySize {
  /** Block id, or one of the synthetic categories below. */
  id: string
  chars: number
  /** Share of the measured prompt, 0..1. */
  share: number
  /** Apportioned from the vendor's reported total — absent when there is none. */
  tokens?: number
}

export interface PromptBreakdown {
  categories: CategorySize[]
  totalChars: number
  /** The vendor's own figure, when it reported one. */
  totalTokens?: number
  /**
   * Tokens the vendor counted that we could not attribute to any category —
   * chat framing, the tool wire format, per-message overhead. Named rather
   * than spread, so the categories stay honest and growth here is visible.
   */
  unaccountedTokens?: number
}

export interface BreakdownInput {
  systemPrompt: string
  /** Serialized tool definitions, if the caller has them. */
  toolsJson?: string
  /** The run prompt, already split — `runPromptBlocks(args)`. */
  blocks: readonly PromptBlock[]
  /** `VendorRunResult.contextTokens`; 0 or absent means the vendor did not report. */
  contextTokens?: number
}

export function promptBreakdown(input: BreakdownInput): PromptBreakdown {
  const raw: { id: string; chars: number }[] = [
    { id: 'system', chars: input.systemPrompt.length },
    ...(input.toolsJson ? [{ id: 'tools', chars: input.toolsJson.length }] : []),
    // Block ids come straight from the registry, so a block added to the prompt
    // appears here without anyone remembering to add it — the same coupling that
    // keeps the sanitizer from drifting out of step with `transcriptBlock`.
    ...input.blocks.map((b) => ({ id: b.id, chars: b.lead.length + b.text.length }))
  ].filter((c) => c.chars > 0)

  const totalChars = raw.reduce((s, c) => s + c.chars, 0)
  // A total of 0 is not "measured zero" here either — it means there was
  // nothing to measure, and dividing by it would produce NaN shares.
  const total = input.contextTokens && input.contextTokens > 0 ? input.contextTokens : undefined

  const categories: CategorySize[] = raw
    .map((c) => ({
      id: c.id,
      chars: c.chars,
      share: totalChars > 0 ? c.chars / totalChars : 0,
      // FLOOR, not round. Rounding each category independently can sum to MORE
      // than the vendor's total (up to n/2 over), which made `unaccountedTokens`
      // negative; it was then clamped to 0, so `attributed + unaccounted` came
      // out ABOVE the total and the categories claimed more of the window than
      // existed. Content-dependent, so it appeared without this module being
      // touched — adding one tool to AGENT_TOOLS was enough to trip it.
      //
      // Flooring can only ever under-attribute, by at most one token per
      // category, and that dust falls into `unaccountedTokens` where it
      // belongs: that field already means "counted by the vendor, not
      // attributable to anything we measured". The invariant now holds by
      // construction rather than by luck, and the error direction is the
      // honest one — we never claim to have attributed more than we did.
      ...(total !== undefined ? { tokens: Math.floor(total * (c.chars / Math.max(1, totalChars))) } : {})
    }))
    // Largest first: the point of the instrument is to answer "what is eating
    // the context", and that question is always about the top of the list.
    .sort((a, b) => b.chars - a.chars)

  const attributed = categories.reduce((s, c) => s + (c.tokens ?? 0), 0)
  return {
    categories,
    totalChars,
    // `Math.max` is now unreachable — flooring guarantees `attributed <= total`.
    // Kept as a floor on the invariant rather than removed: if the
    // apportionment is ever changed back to rounding, a wrong number is worse
    // than a clamped one, and `check-prompt-breakdown.ts` asserts the equality
    // that would catch it.
    ...(total !== undefined ? { totalTokens: total, unaccountedTokens: Math.max(0, total - attributed) } : {})
  }
}

/**
 * One log line per category, biggest first. Deliberately plain text rather than
 * a tree: this is read in a log next to a run id, and the 653-line tree renderer
 * their version ships is a UI for a different problem.
 */
export function formatBreakdown(b: PromptBreakdown): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`
  const head = b.totalTokens !== undefined ? `PROMPT BREAKDOWN — ${b.totalChars} chars, ${b.totalTokens} tokens reported` : `PROMPT BREAKDOWN — ${b.totalChars} chars (the vendor reported no token total, so tokens are not estimated)`
  const rows = b.categories.map((c) => `  ${c.id.padEnd(14)} ${String(c.chars).padStart(7)} chars  ${pct(c.share).padStart(6)}${c.tokens !== undefined ? `  ~${c.tokens} tok` : ''}`)
  const tail = b.unaccountedTokens ? [`  ${'(unattributed)'.padEnd(14)} ${''.padStart(7)}       ~${b.unaccountedTokens} tok — vendor framing and tool wire format`] : []
  return [head, ...rows, ...tail].join('\n')
}
