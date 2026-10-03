import type { ModelChoice } from '@shared/agents'

/**
 * How much context a model actually has, and when a resumable session is close
 * enough to full to be worth rotating.
 *
 * Replaces `SESSION_ROTATE_TOKENS = 150_000` — one hard-coded absolute, chosen
 * against one model's window, applied to every model we run. It was wrong in
 * BOTH directions and silently: too low for a 1M-token model (rotating a
 * session that had two thirds of its room left, throwing away the prompt cache
 * for nothing), and too high for a 200k one (a rotation that fires only after
 * the overflow it was meant to prevent).
 *
 * Other harnesses trigger at ~0.9 of the model's real window, from the
 * provider's REPORTED usage rather than an estimate. We take the shape; we take
 * a lower fraction, for a reason that is ours — see below.
 *
 * INTERIM BY DESIGN, and the table is the interim part. The real version reads
 * `contextLength` from the OpenRouter models API (typed at
 * `@openrouter/sdk` esm/models/model.d.ts) and a separate source for Claude,
 * fetched and cached. That is worth doing and is not worth blocking on: a
 * constant that is approximately right per model strictly dominates one
 * constant that is exactly wrong for three vendors out of four. When the fetch
 * lands, it replaces `lookup` and nothing else here moves.
 */

/**
 * Published context windows, in tokens. Deliberately CONSERVATIVE where a
 * model's advertised window is only reachable under conditions we do not
 * control (beta headers, tier limits): under-stating rotates a little early,
 * which costs some cache reuse, while over-stating overflows the run, which
 * costs the run. Those are not comparable, so the table leans one way.
 */
const WINDOWS: Record<string, number> = {
  'claude-sonnet-5-5': 200_000,
  'claude-opus-5-5': 200_000,
  'claude-fable-5-1': 200_000,
  'claude-sonnet-5': 200_000,
  'claude-opus-4-8': 200_000,
  'claude-opus-5': 200_000,
  'claude-fable-5': 200_000,
  // The Codex backend's windows (its models.json `context_window`), not the
  // public API's: every model it serves is 272k there, including GPT-5.5.
  'gpt-6.1-sol': 272_000,
  'gpt-6-astra': 272_000,
  'gpt-6-sol': 272_000,
  'gpt-6-luna': 272_000,
  'gpt-5.6-sol': 272_000,
  'gpt-5.6-terra': 272_000,
  'gpt-5.6-luna': 272_000,
  'gpt-5.5': 272_000,
  // No longer listed by Codex; kept so an agent still set to one sizes its prompt sanely.
  'gpt-5.4-mini': 272_000,
  'gpt-5.4-codex': 272_000,
  // 500k, from OpenRouter's own /api/v1/models. This read 2_000_000 for months,
  // which is the OVER-statement this table's header calls the costly direction:
  // at ROTATE_AT_FRACTION 0.75 it budgeted 1.5M tokens against a 500k window.
  'x-ai/grok-4.6': 500_000,
  // Advertised 1M. Entered exactly rather than rounded up: the table's stated bias
  // is to under-state, and without a row at all this model would take
  // UNKNOWN_MODEL_WINDOW (128k) — an 8x under-estimate that shrinks the transcript
  // budget and rotates sessions that did not need rotating.
  'google/gemini-3.7-flash': 1_048_576,
  'z-ai/glm-5.3-flash': 1_048_576,
  // The OpenRouter routes to the same models the subscriptions serve.
  'anthropic/claude-sonnet-5': 200_000,
  'openai/gpt-5.5': 400_000
}

/**
 * The floor for a model we have never heard of — a new Claude id, an
 * operator's local GGUF, a custom OpenRouter id.
 *
 * 128k is smaller than anything in the table on purpose. An unknown model
 * treated as small rotates early and works; an unknown model assumed large
 * overflows, and the failure surfaces as a run that dies mid-tool rather than
 * as anything legible.
 */
export const UNKNOWN_MODEL_WINDOW = 128_000

/**
 * Rotate at 75% rather than their 90%.
 *
 * Their number is tuned for compaction — summarise, then keep going in the
 * same conversation, so overshooting costs one extra summarisation. Ours is
 * tuned for ROTATION: we drop the session and rebuild from durable state, and
 * because `contextTokens` is measured at the END of a run, the next run starts
 * from that figure and adds a whole tick's worth of prompt, tool results and
 * output before anyone looks again. At 90% that headroom is not enough to hold
 * one more run of a research-heavy agent, and the rotation that was supposed
 * to prevent an overflow happens after it.
 */
export const ROTATE_AT_FRACTION = 0.75

/** The model's window, or the conservative floor if we do not know it. */
export function contextWindowFor(model: Pick<ModelChoice, 'id'>): number {
  return WINDOWS[model.id] ?? UNKNOWN_MODEL_WINDOW
}

/**
 * Is this model in the table at all — as opposed to falling back to the floor?
 *
 * Needed because the two are indistinguishable from `contextWindowFor` alone,
 * and that ambiguity is what hid a real defect: `claude-opus-5` works on the
 * Claude subscription and was simply missing here, so it took the 128k floor
 * and got a transcript budget **12× smaller** than Sonnet 5's. The safe default
 * is exactly what hides the omission — a model we forgot is indistinguishable
 * from one we have never seen, and it degrades quietly in the direction nobody
 * investigates.
 *
 * Callers that need "known vs assumed" must ask this rather than comparing
 * against `UNKNOWN_MODEL_WINDOW`, which would also be true of a real model
 * whose window happens to be 128k.
 */
export function hasKnownWindow(model: Pick<ModelChoice, 'id'>): boolean {
  return model.id in WINDOWS
}

/** Tokens at which a resumable session should be dropped and rebuilt. */
export function rotateThresholdFor(model: Pick<ModelChoice, 'id'>): number {
  return Math.floor(contextWindowFor(model) * ROTATE_AT_FRACTION)
}

/**
 * Should we drop the session after a run that reported `contextTokens`?
 *
 * ZERO MEANS UNMEASURED, NOT EMPTY. `VendorRunResult.contextTokens` is
 * required and seeded to 0, and a real prompt is never 0 tokens — so a 0 here
 * is a vendor that reported nothing, and rotating on it would throw away a
 * healthy session's prompt cache every run for want of a number. Keep the
 * session and find out next time.
 */
export function shouldRotateSession(contextTokens: number | undefined, model: Pick<ModelChoice, 'id'>): boolean {
  if (!contextTokens) return false
  return contextTokens > rotateThresholdFor(model)
}
