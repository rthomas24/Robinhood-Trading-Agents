import type { AgentConfig } from '@shared/agents'
import type { AppSettings } from '@shared/ipc'

/** Whether an agent runs on the Local GPU — its own model's vendor; there is no fleet-wide override. */
export const isLocalVendor = (cfg: Pick<AgentConfig, 'model'>): boolean => cfg.model.vendor === 'local'

/**
 * The Local GPU's default model id — the single answer three surfaces need.
 *
 * `settings` is the stored choice and `local.defaultModelId` is main's live
 * view of the same field, and they can disagree for one tick after the engine
 * writes it (starting a model makes it the default). Reading either alone is
 * what produced a model wearing a "default" pill beside a toggle that said to
 * pick a default, and a provider picker offering "Set up" for a GPU that was
 * already set up.
 *
 * PRESENCE of `local` decides, not truthiness of its value — `??` would be
 * wrong here and was. `engine.ts` CLEARS `modelId` when the folder changes
 * (`modelId: next === cur.folder ? cur.modelId : null`), so `defaultModelId:
 * null` is a real answer meaning "there is no default any more". Falling
 * through on it would let a stale settings copy resurrect a model the operator
 * had just pointed away from, and the picker would offer a default that is not
 * in the folder.
 *
 * So: engine status present → it is authoritative, null included. Absent (no
 * `refreshLocal` yet) → settings answer.
 */
export function localDefaultModelId(settings: AppSettings | null | undefined, local: { defaultModelId: string | null } | null | undefined): string | null {
  if (local) return local.defaultModelId
  return settings?.localModel?.modelId ?? null
}
