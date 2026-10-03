import { app } from 'electron'
import { readJson, writeJson } from './json'
import { join } from 'node:path'
import type { AppSettings } from '@shared/ipc'
import { DEFAULT_MODEL } from '@shared/agents'
import { DEFAULT_PROVIDER, PROVIDERS, providerTarget } from '@shared/provider'
import { DEFAULT_TOOL_POLICY, normalizeToolPolicy } from '@shared/mcps'

const DEFAULTS: AppSettings = {
  theme: 'light',
  defaultProvider: DEFAULT_PROVIDER,
  defaultModel: DEFAULT_MODEL,
  onboardingDone: false,
  tools: DEFAULT_TOOL_POLICY,
  tradingHalted: false,
  localModel: { enabled: false, folder: null, modelId: null }
}

function path(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** App settings, `userData/settings.json`; every read is normalized so the default provider and model agree. */
export const settingsStore = {
  load(): AppSettings {
    const raw = readJson<Partial<AppSettings>>(path()) ?? {}
    return normalize({ ...DEFAULTS, ...raw, tools: normalizeToolPolicy(raw.tools), localModel: { ...DEFAULTS.localModel, ...(raw.localModel ?? {}) } })
  },
  save(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.load(), ...patch }
    next.tools = normalizeToolPolicy(next.tools)
    next.tradingHalted = next.tradingHalted === true
    next.localModel = { enabled: Boolean(next.localModel?.enabled), folder: next.localModel?.folder?.trim() || null, modelId: next.localModel?.modelId ?? null }
    // A patch may move either half of the default: a new provider re-seeds the model,
    // a new model vendor re-seeds the provider — they never disagree on disk.
    if (patch.defaultProvider && !patch.defaultModel) next.defaultModel = providerTarget(next.defaultProvider, next.defaultModel).model
    else if (patch.defaultModel && !patch.defaultProvider) next.defaultProvider = patch.defaultModel.vendor
    const out = normalize(next)
    writeJson(path(), out)
    return out
  }
}

/** Keep the default provider and model coherent, whatever was on disk. */
function normalize(s: AppSettings): AppSettings {
  const provider = PROVIDERS.includes(s.defaultProvider) ? s.defaultProvider : s.localModel?.enabled ? 'local' : (s.defaultModel?.vendor ?? DEFAULT_PROVIDER)
  const model = s.defaultModel?.vendor === provider ? s.defaultModel : providerTarget(provider, s.defaultModel).model
  // `contactEmail` was a setting in earlier builds; drop it from files written by them.
  const { contactEmail: _retired, ...rest } = s as AppSettings & { contactEmail?: unknown }
  void _retired
  return { ...rest, defaultProvider: provider, defaultModel: model }
}
