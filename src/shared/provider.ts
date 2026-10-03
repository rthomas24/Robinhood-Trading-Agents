import { defaultModelFor, type AgentConfig, type ModelChoice, type ModelVendor } from './agents'

/**
 * A **provider** is the one thing the operator picks: *which service thinks for
 * this agent*. Every provider runs on the operator's own account or hardware —
 * there is no service in between. Nothing extra is stored: a provider is
 * *derived* from the agent's model (`providerOf`) and *applied* as a model patch
 * (`providerTarget`). Every agent keeps its own provider — the default only
 * seeds new agents.
 *
 *   claude      — the operator's Claude login (Claude Agent SDK)
 *   chatgpt     — the operator's ChatGPT subscription (Codex OAuth)
 *   openrouter  — any OpenRouter model, on the operator's own API key
 *   local       — a GGUF model on this computer's GPU (no network needed)
 */
export type Provider = ModelVendor

/** What the operator may choose, in picker order. */
export const PROVIDERS: readonly Provider[] = ['claude', 'chatgpt', 'openrouter', 'local']
export const DEFAULT_PROVIDER: Provider = 'claude'

export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', openrouter: 'OpenRouter', local: 'Local GPU' }
export const PROVIDER_HINT: Record<Provider, string> = {
  claude: 'Your Claude account — runs while this computer is on.',
  chatgpt: 'Your ChatGPT subscription — runs while this computer is on.',
  openrouter: 'Any OpenRouter model on your own API key — runs while this computer is on.',
  local: 'A GGUF model on this GPU — no internet needed, runs while this computer is on.'
}

/** Which service thinks for this agent — derived, never stored. */
export function providerOf(cfg: Pick<AgentConfig, 'model'>): Provider {
  return cfg.model.vendor
}

/** Providers that need the internet to think (Local GPU is the exception). */
export const needsNetwork = (p: Provider): boolean => p !== 'local'

/**
 * The model an agent gets when moved to `p`. Keeps the operator's model id /
 * effort when the vendor does not change, otherwise falls back to the vendor's
 * default (keeping the effort they chose).
 */
export function providerTarget(p: Provider, prev?: ModelChoice): { model: ModelChoice } {
  const base = defaultModelFor(p)
  const model: ModelChoice = prev?.vendor === p ? prev : { ...base, effort: prev?.effort ?? base.effort }
  return { model }
}
