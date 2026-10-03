import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Cpu, Play, Square, RefreshCw, Check, AlertTriangle, ExternalLink, Copy, ScrollText, FolderOpen, Folder, HardDrive } from 'lucide-react'
import { useApp } from '@renderer/store/appStore'
import { localDefaultModelId } from '@renderer/lib/vendor'
import { Switch } from '@renderer/components/common/Switch'
import { EmptyState } from '@renderer/components/common/Primitives'
import { Group, Row } from '@renderer/components/common/Settings'
import { cn, ipcErrorText } from '@renderer/lib/format'
import { SectionTitle } from './SectionTitle'
import { providerOf } from '@shared/provider'

/**
 * Settings → Local models: run agents on a GGUF model from a folder you
 * choose, on this GPU, via a local llama.cpp engine. A master
 * switch forces every local agent onto it; the rest is engine/hardware status,
 * the folder picker, the models found, and the live model with start/stop.
 */
const LLAMA_RELEASES = 'https://github.com/ggml-org/llama.cpp/releases'

export function LocalModelsSection(): JSX.Element {
  const local = useApp((s) => s.local)
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const refreshLocal = useApp((s) => s.refreshLocal)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[] | null>(null)
  // "Enabled" now means: Local GPU is the default provider for NEW agents (the status-bar switcher). Existing agents keep their own provider.
  const enabled = settings?.defaultProvider === 'local'
  const localAgents = useApp((s) => Object.values(s.agents).filter((a) => a.state.status !== 'retired' && providerOf(a.config) === 'local').length)

  useEffect(() => {
    void refreshLocal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const act = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setErr(null)
    try {
      await fn()
      void refreshLocal()
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(null)
    }
  }

  const engineInstalled = local?.engines.some((e) => e.installed) ?? false
  const working = Boolean(local?.active)
  const defaultId = localDefaultModelId(settings, local)
  const CONTEXT_CHOICES = [8192, 12288, 16384, 24576, 32768, 65536]

  return (
    <>
      <SectionTitle
        title="Local models"
        blurb="Run agents on a model that lives on this GPU — private, free, offline. Point the app at the folder where you keep your GGUF files; llama.cpp runs the one you pick."
      />

      {/* Master switch. Local is the one identity that gets its own colour here,
          because a run on this computer looks different everywhere else too. */}
      <div className={cn('card p-4 mb-6 flex items-center gap-4', enabled && 'ring-1 ring-local/45')}>
        <div className={cn('h-10 w-10 rounded-md flex items-center justify-center shrink-0', enabled ? 'bg-local/12 text-local local-glow' : 'bg-surface-2 text-muted')}>
          <Cpu size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-md font-semibold">New agents run on the Local GPU</div>
          <div className="text-sm text-muted mt-0.5 leading-relaxed">
            {enabled ? 'On — new agents default to the GPU model below. ' : 'Off — new agents default to the provider picked in the status bar. '}
            {localAgents ? `${localAgents} agent${localAgents === 1 ? '' : 's'} run${localAgents === 1 ? 's' : ''} here now` : 'No agent runs here yet'} — each agent keeps its own provider (Agent settings → Runs on).
            {!defaultId && ' Pick a default model below to enable the Local GPU as a provider.'}
          </div>
        </div>
        <Switch checked={enabled} disabled={!enabled && !defaultId} onChange={(next) => void updateSettings({ defaultProvider: next ? 'local' : 'claude' })} label="Default new agents to Local GPU" />
      </div>

      <p className={cn('text-xs text-down flex items-start gap-1.5', err && 'mb-3')} role="alert">
        {err && <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
        {err}
      </p>

      {!local ? (
        <div className="card">
          <EmptyState icon={<RefreshCw size={18} className="animate-spin" />} title="Starting the local engine…" body="Probing this computer's hardware and looking for an installed llama.cpp." />
        </div>
      ) : (
        <>
          {/* Engine + hardware */}
          <Group title="Engine" hint={local.hardware ? undefined : 'The runtime that loads a model onto your GPU.'}>
            {!local.available && (
              <Row
                title={<span className="text-down">The engine runtime could not start</span>}
                hint={local.lastError ?? 'No further detail was reported.'}
              >
                <button className="btn btn-outline" onClick={() => void refreshLocal()}>
                  Retry
                </button>
              </Row>
            )}
            {local.hardware && (
              <Row
                title={
                  <span className="flex items-center gap-2">
                    <HardDrive size={14} className="text-muted shrink-0" />
                    {local.hardware.chip}
                  </span>
                }
                hint={
                  <>
                    <span className="nums">{local.hardware.memoryGiB.toFixed(0)}</span> GiB RAM
                    {local.hardware.gpus.map((g) => (
                      <span key={g.name}>
                        {' · '}
                        {g.name}
                        {g.vramGiB ? ` (${g.vramGiB.toFixed(0)} GiB VRAM)` : ''}
                      </span>
                    ))}
                  </>
                }
              />
            )}
            {local.engines
              .filter((e) => e.availableOnThisPlatform)
              .map((e) => (
                <Row
                  key={e.id}
                  title={
                    <span className="flex items-center gap-2">
                      {e.installed ? <Check size={14} className="text-up shrink-0" /> : <AlertTriangle size={14} className="text-warn shrink-0" />}
                      {e.displayName}
                      <span className={cn('pill', e.installed ? 'pill-up' : 'pill-warn')}>{e.installed ? 'installed' : 'not installed'}</span>
                    </span>
                  }
                  hint={
                    e.installed ? (
                      e.executable ? (
                        <span className="mono">{e.executable}</span>
                      ) : undefined
                    ) : (
                      <>
                        {e.installHint}
                        {e.installCommand && (
                          <span className="mt-1.5 flex items-center gap-2">
                            <code className="mono text-2xs inset px-1.5 py-0.5">{e.installCommand}</code>
                            <button className="btn-icon h-6 w-6" title="Copy install command" aria-label="Copy install command" onClick={() => void navigator.clipboard.writeText(e.installCommand!)}>
                              <Copy size={12} />
                            </button>
                          </span>
                        )}
                        {e.id === 'llamacpp' && (
                          <button className="mt-1 flex items-center gap-1 hover:text-text text-left" onClick={() => void window.tb.openExternal(LLAMA_RELEASES)}>
                            llama.cpp releases (CUDA / Vulkan / CPU) — put llama-server on your PATH <ExternalLink size={11} className="shrink-0" />
                          </button>
                        )}
                      </>
                    )
                  }
                />
              ))}
            {local.available && local.engines.length === 0 && <Row title="No engines registered." />}
          </Group>

          {/* Folder */}
          <Group title="Models folder" hint="Scanned recursively for .gguf files. Nothing is downloaded — the app only runs what is already there.">
            <Row
              title={
                <span className="flex items-center gap-2 min-w-0">
                  <Folder size={14} className="text-muted shrink-0" />
                  <span className="truncate" title={local.folder ?? undefined}>
                    {local.folder ?? 'No folder chosen'}
                  </span>
                </span>
              }
              hint={
                local.folder ? (
                  local.folderError ? (
                    <span className="text-down">{local.folderError}</span>
                  ) : (
                    `${local.models.length} GGUF model${local.models.length === 1 ? '' : 's'} found (subfolders included)`
                  )
                ) : (
                  'Pick the folder where your .gguf files live (LM Studio, Hugging Face cache, or any folder).'
                )
              }
            >
              <div className="flex items-center gap-2">
                <button className="btn btn-outline" disabled={busy !== null} onClick={() => void act('pick', () => window.tb.local.pickFolder())}>
                  <FolderOpen size={13} /> {local.folder ? 'Change…' : 'Choose folder…'}
                </button>
                {local.folder && (
                  <button className="btn-icon h-8 w-8" title="Rescan" aria-label="Rescan the models folder" disabled={busy !== null} onClick={() => void act('rescan', () => window.tb.local.rescan())}>
                    <RefreshCw size={14} className={busy === 'rescan' ? 'animate-spin' : ''} />
                  </button>
                )}
              </div>
            </Row>
          </Group>

          {/* Live model */}
          <div className="mb-8">
            <div className="mb-2.5 px-0.5 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h4 className="text-base font-semibold tracking-[-0.01em]">Running now</h4>
                <p className="hint mt-0.5">One model is loaded at a time. With the switch on, the default boots automatically when an agent wakes.</p>
              </div>
            </div>
            <div className={cn('card p-4', working && 'ring-1 ring-local/45')}>
              {local.active ? (
                <div className="flex items-center gap-3">
                  <span className="pill pill-local working">
                    <Cpu size={11} /> Local GPU
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-md font-semibold truncate">{local.active.modelName}</div>
                    <div className="text-xs text-muted">
                      {local.active.engine}
                      {local.active.contextWindow ? ` · ${(local.active.contextWindow / 1024).toFixed(0)}k context` : ''}
                      {local.active.reasoning ? ' · thinking' : ''}
                    </div>
                  </div>
                  <button className="btn btn-outline" disabled={busy === 'stop'} onClick={() => void act('stop', () => window.tb.local.stop())}>
                    <Square size={13} /> Stop
                  </button>
                </div>
              ) : local.activating ? (
                <div className="flex items-center gap-2 text-sm">
                  <RefreshCw size={13} className="animate-spin text-local" /> Loading {local.activating.modelName} onto the GPU…
                </div>
              ) : (
                <div className="text-sm text-muted">
                  {local.models.length ? 'No model running. Start one below — with the switch on, the default model boots automatically when an agent wakes.' : local.folder ? 'No models to run yet.' : engineInstalled ? 'Choose a models folder first.' : 'Install llama.cpp, then choose a models folder.'}
                </div>
              )}
              <div className="mt-3 pt-3 hair-t flex items-center gap-3 text-xs text-muted flex-wrap">
                {local.options && (
                  <>
                    <label className="flex items-center gap-1.5">
                      Context
                      <select className="select w-auto h-7 py-0 text-xs" value={local.options.contextTokens} onChange={(e) => void act('opts', () => window.tb.local.setOptions({ contextTokens: Number(e.target.value) }))}>
                        {CONTEXT_CHOICES.map((n) => (
                          <option key={n} value={n}>
                            {n / 1024}k tokens
                          </option>
                        ))}
                        {!CONTEXT_CHOICES.includes(local.options.contextTokens) && <option value={local.options.contextTokens}>{local.options.contextTokens} tokens</option>}
                      </select>
                    </label>
                    <label className="flex items-center gap-1.5">
                      KV cache
                      <select className="select w-auto h-7 py-0 text-xs" value={local.options.kvCacheType} onChange={(e) => void act('opts', () => window.tb.local.setOptions({ kvCacheType: e.target.value }))}>
                        <option value="f16">f16 (best quality)</option>
                        <option value="q8_0">q8_0 (half the memory)</option>
                        <option value="q4_0">q4_0 (quarter)</option>
                      </select>
                    </label>
                    <span className="text-text-3">applies on the next start · smaller = fits more on the GPU</span>
                  </>
                )}
                <span className="flex-1" />
                <button
                  className="inline-flex items-center gap-1 hover:text-text"
                  onClick={async () => {
                    if (logs) setLogs(null)
                    else setLogs(await window.tb.local.logs(80))
                  }}
                >
                  <ScrollText size={12} /> {logs ? 'Hide engine log' : 'Engine log'}
                </button>
              </div>
              {logs && <pre className="mt-2 max-h-48 overflow-auto text-2xs mono inset p-2 whitespace-pre-wrap">{logs.join('\n') || '(empty)'}</pre>}
            </div>
          </div>

          {/* Models in the folder */}
          <Group title={`Models in folder (${local.models.length})`}>
            {local.models.length === 0 ? (
              <EmptyState
                icon={<Folder size={18} />}
                title={local.folder ? 'No .gguf files found here' : 'No folder chosen yet'}
                body={local.folder ? 'Subfolders are scanned too. Add a model to the folder and hit Rescan.' : 'Choose a folder to list its models.'}
                action={
                  <button className="btn btn-outline" disabled={busy !== null} onClick={() => void act('pick', () => window.tb.local.pickFolder())}>
                    <FolderOpen size={13} /> {local.folder ? 'Change folder…' : 'Choose folder…'}
                  </button>
                }
              />
            ) : (
              local.models.map((m) => {
                const isActive = local.active?.modelId === m.id
                const isDefault = defaultId === m.id
                return (
                  <Row
                    key={m.id}
                    title={
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="truncate">{m.name}</span>
                        {isActive && <span className="pill pill-local working">running</span>}
                        {isDefault && <span className="pill">default</span>}
                        {m.fit && <span className={cn('pill', m.fit === 'good' ? 'pill-up' : m.fit === 'tight' ? 'pill-warn' : 'pill-down')}>{m.fit === 'good' ? 'fits GPU' : m.fit === 'tight' ? 'tight fit' : 'too big for VRAM'}</span>}
                        {m.sharded && <span className="pill">sharded</span>}
                      </span>
                    }
                    hint={
                      <span className="truncate block" title={m.id}>
                        {m.relPath} · <span className="nums">{m.sizeGiB}</span> GiB
                      </span>
                    }
                  >
                    <div className="flex items-center gap-2">
                      {!isDefault && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => void updateSettings({ localModel: { enabled: Boolean(settings?.localModel?.enabled), folder: settings?.localModel?.folder ?? local.folder, modelId: m.id } })}
                        >
                          Make default
                        </button>
                      )}
                      {!isActive && (
                        <button className="btn btn-outline btn-sm" disabled={busy !== null || !engineInstalled} onClick={() => void act(`start:${m.id}`, () => window.tb.local.start(m.id))} title={engineInstalled ? 'Load onto the GPU' : 'Install llama.cpp first'}>
                          {busy === `start:${m.id}` ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />} Start
                        </button>
                      )}
                    </div>
                  </Row>
                )
              })
            )}
          </Group>
        </>
      )}
    </>
  )
}
