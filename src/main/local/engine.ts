import { app, dialog } from 'electron'
import { join, relative, basename, dirname, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import type { EngineAttachment, EngineClient, LocalModel } from '@elyxndra/engine'
import type { LocalEvent, LocalModelInfo, LocalStatus } from '@shared/ipc'
import type { LocalEndpoint } from '@core/runner/vendors/local'
import { settingsStore } from '../store/settingsStore'
import { focusMainWindow } from '../window'

/**
 * Local GPU models. The operator points the app at a FOLDER of GGUF files
 * (anything llama.cpp runs — LM Studio / Ollama-export / Hugging Face layouts,
 * or loose files); we list what's there and run the chosen one with the
 * `@elyxndra/engine` runtime (llama.cpp supervision, health, hardware probe,
 * OpenAI-compatible /v1 on 127.0.0.1). No model store, no downloads — the
 * folder is the source of truth. The app hosts its own engine daemon on its
 * own port (TB_LOCAL_ENGINE_PORT, default 8905) so it never fights another
 * app for the management port; llama-server itself lives on 8902.
 */
type EngineModule = typeof import('@elyxndra/engine')

const PORT = Number(process.env.TB_LOCAL_ENGINE_PORT ?? 8905)
const CLIENT_NAME = 'robinhood-trading-agents'
const START_TIMEOUT_MS = 240_000
const SCAN_DEPTH = 4

let modPromise: Promise<EngineModule> | null = null
const loadEngine = (): Promise<EngineModule> => (modPromise ??= import('@elyxndra/engine') as unknown as Promise<EngineModule>)

type Listener = (e: LocalEvent) => void

/** Shard detection: keep `-00001-of-0000N.gguf`, hide the rest (llama.cpp loads them from the first). */
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i

/** Trading ticks carry ~10–20k tokens of context; 16k with a q8 KV cache fits most 16 GB cards. */
const DEFAULT_OPTIONS = { contextTokens: 16_384, kvCacheType: 'q8_0' as const }

class LocalEngineService {
  private attachment: EngineAttachment | null = null
  private client: EngineClient | null = null
  private options: { contextTokens: number; kvCacheType: string } | null = null
  private opening: Promise<void> | null = null
  private lastError: string | null = null
  private listeners = new Set<Listener>()
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private starting: Promise<void> | null = null
  private models: LocalModelInfo[] = []
  private folderError: string | null = null
  private scannedFolder: string | null = null

  onChange(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private push(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      const status = this.status()
      for (const l of this.listeners) l({ type: 'local:status', status })
    }, 60)
  }

  /** Host our engine runtime (lazy, idempotent). */
  async ensure(): Promise<EngineAttachment> {
    if (this.attachment) return this.attachment
    if (!this.opening) {
      this.opening = (async () => {
        try {
          const mod = await loadEngine()
          const settingsFile = join(app.getPath('userData'), 'local-engine-settings.json')
          const firstRun = !(await fs.stat(settingsFile).then(() => true).catch(() => false))
          const a = await mod.EngineAttachment.open({
            port: PORT,
            client: CLIENT_NAME,
            // Never adopt a llama-server someone else launched — we only drive what we start.
            adopt: false,
            // Our own engine settings file, so llama.cpp knobs set here never touch another app's.
            runtime: { env: process.env, probeGPUs: true, settingsFile, logFile: join(app.getPath('userData'), 'local-engine.log') },
            log: (line) => console.log(`[local-engine] ${line}`)
          })
          this.attachment = a
          this.client = new mod.EngineClient({ baseURL: a.url, client: CLIENT_NAME, token: mod.engineSecret() })
          try {
            const cur = await this.client.llamaOptions()
            this.options = firstRun ? await this.client.setLlamaOptions(DEFAULT_OPTIONS) : { contextTokens: cur.contextTokens, kvCacheType: String(cur.kvCacheType) }
          } catch (err) {
            console.warn('[local-engine] llama options unavailable:', (err as Error).message)
          }
          const wire = (): void => {
            const s = a.session
            s.on('state', () => this.push())
            s.on('active', () => this.push())
            s.on('change', () => this.push())
          }
          wire()
          a.on('session', () => {
            wire()
            this.push()
          })
          this.lastError = null
        } catch (err) {
          this.lastError = (err as Error).message
          this.opening = null
          throw err
        }
      })()
    }
    await this.opening
    await this.rescan()
    return this.attachment!
  }

  /** Walk the models folder for GGUF files. */
  async rescan(): Promise<LocalStatus> {
    const folder = settingsStore.load().localModel.folder
    this.scannedFolder = folder
    this.models = []
    this.folderError = null
    if (folder) {
      try {
        const st = await fs.stat(folder)
        if (!st.isDirectory()) throw new Error('not a folder')
        const found: { file: string; size: number }[] = []
        const walk = async (dir: string, depth: number): Promise<void> => {
          let entries: import('node:fs').Dirent[]
          try {
            entries = await fs.readdir(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of entries) {
            if (e.name.startsWith('.')) continue
            const full = join(dir, e.name)
            if (e.isDirectory()) {
              if (depth < SCAN_DEPTH) await walk(full, depth + 1)
              continue
            }
            if (!/\.gguf$/i.test(e.name) || /mmproj/i.test(e.name)) continue
            const shard = SHARD.exec(e.name)
            if (shard && shard[1] !== '00001') continue
            try {
              let size = (await fs.stat(full)).size
              if (shard) {
                // Sum the sibling shards so the size (and the fit hint) is honest.
                const prefix = e.name.slice(0, shard.index)
                for (const sib of entries) if (sib.name.startsWith(prefix) && sib.name !== e.name && SHARD.test(sib.name)) size += (await fs.stat(join(dir, sib.name))).size
              }
              found.push({ file: full, size })
            } catch {
              /* unreadable file */
            }
          }
        }
        await walk(folder, 0)
        const vram = this.attachment?.session.hardware?.gpus.reduce<number | null>((best, g) => (g.vramGiB !== null && (best === null || g.vramGiB > best) ? g.vramGiB : best), null) ?? null
        const ram = this.attachment?.session.hardware?.memoryGiB ?? null
        this.models = found
          .map(({ file, size }) => {
            const gib = size / 1024 ** 3
            const fit = vram === null ? null : gib * 1.15 <= vram ? 'good' : gib * 1.05 <= vram + (ram ?? 0) * 0.5 ? 'tight' : 'cpu'
            return {
              id: file,
              name: basename(file).replace(/\.gguf$/i, '').replace(SHARD, ''),
              relPath: relative(folder, file).replace(/\\/g, '/'),
              sizeGiB: Math.round(gib * 10) / 10,
              sharded: SHARD.test(basename(file)),
              fit
            } satisfies LocalModelInfo
          })
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      } catch (err) {
        this.folderError = `Cannot read ${folder}: ${(err as Error).message}`
      }
    }
    this.push()
    return this.status()
  }

  async pickFolder(): Promise<LocalStatus> {
    const cur = settingsStore.load().localModel
    const res = await dialog.showOpenDialog({ title: 'Choose your models folder (GGUF files)', properties: ['openDirectory', 'createDirectory'], defaultPath: cur.folder ?? undefined })
    focusMainWindow()
    if (res.canceled || !res.filePaths[0]) return this.status()
    return this.setFolder(res.filePaths[0])
  }

  async setFolder(folder: string | null): Promise<LocalStatus> {
    const cur = settingsStore.load().localModel
    const next = folder ? resolve(folder) : null
    settingsStore.save({ localModel: { ...cur, folder: next, modelId: next === cur.folder ? cur.modelId : null } })
    await this.ensure().catch(() => undefined)
    return this.rescan()
  }

  status(): LocalStatus {
    const settings = settingsStore.load().localModel
    const a = this.attachment
    const s = a?.session
    const base = { folder: settings.folder, folderError: this.folderError, models: this.scannedFolder === settings.folder ? this.models : [], options: this.options, enabled: settings.enabled, defaultModelId: settings.modelId, lastError: this.lastError }
    if (!s) return { available: false, url: null, state: 'stopped', active: null, activating: null, engines: [], hardware: null, ...base }
    const hw = s.hardware
    return {
      available: true,
      url: s.url,
      state: String((s.state as { kind?: string }).kind ?? s.state),
      active: s.active
        ? { modelId: s.active.model.id, modelName: s.active.model.shortName ?? s.active.model.id, engine: s.active.engineDisplayName, contextWindow: s.active.health?.contextWindow ?? null, reasoning: Boolean(s.active.health?.reasoning?.supported) }
        : null,
      activating: s.activating ? { modelId: s.activating.id, modelName: s.activating.shortName ?? s.activating.id } : null,
      engines: s.engines.map((e) => ({ id: e.id, displayName: e.displayName, installed: e.installed, availableOnThisPlatform: e.availableOnThisPlatform, installHint: e.installHint ?? null, installCommand: e.installCommand ?? null, executable: e.executable ?? null })),
      hardware: hw ? { chip: hw.chipName, memoryGiB: hw.memoryGiB, freeDiskGiB: hw.freeDiskGiB, tier: hw.tier ?? null, gpus: hw.gpus.map((g) => ({ name: g.name, vramGiB: g.vramGiB, vendor: g.vendor })) } : null,
      ...base
    }
  }

  /** A folder file as the engine's `LocalModel` (the manager runs any GGUF path). */
  private asLocalModel(file: string): LocalModel {
    const info = this.models.find((m) => m.id === file)
    return {
      id: file,
      path: dirname(file),
      repoId: basename(dirname(file)) || 'local',
      sizeBytes: Math.round((info?.sizeGiB ?? 0) * 1024 ** 3),
      isComplete: true,
      format: 'gguf',
      engineId: 'llamacpp',
      weightsFile: basename(file),
      subfolder: null
    } as LocalModel
  }

  async start(modelId: string): Promise<LocalStatus> {
    const a = await this.ensure()
    if (!this.models.some((m) => m.id === modelId)) throw new Error('That model is not in your models folder any more — rescan.')
    if (!a.runtime) throw new Error('The engine runtime is not hosted by this app (another process holds its port).')
    if (!this.starting) {
      this.starting = (async () => {
        try {
          const model = this.asLocalModel(modelId)
          const runtime = a.runtime!
          if (runtime.manager.active) await runtime.manager.switchTo(model)
          else await runtime.manager.activate(model)
          this.lastError = null
          // Remember the operator's pick as the model local mode boots by default.
          const cur = settingsStore.load().localModel
          if (cur.modelId !== modelId) settingsStore.save({ localModel: { ...cur, modelId } })
        } catch (err) {
          const mod = await loadEngine()
          this.lastError = mod.describeEngineError(err) || (err as Error).message
          throw new Error(this.lastError)
        } finally {
          this.starting = null
          this.push()
        }
      })()
    }
    await this.starting
    return this.status()
  }

  async stop(): Promise<LocalStatus> {
    const a = await this.ensure()
    await a.session.stop({ reason: 'user', client: CLIENT_NAME })
    this.push()
    return this.status()
  }

  /** llama.cpp knobs (context window, KV-cache precision); take effect on the next start. */
  async setOptions(patch: { contextTokens?: number; kvCacheType?: string }): Promise<LocalStatus> {
    await this.ensure()
    if (!this.client) return this.status()
    const p: Record<string, unknown> = {}
    if (patch.contextTokens && Number.isFinite(patch.contextTokens)) p.contextTokens = Math.max(2048, Math.min(262_144, Math.round(patch.contextTokens)))
    if (patch.kvCacheType && ['f16', 'q8_0', 'q4_0'].includes(patch.kvCacheType)) p.kvCacheType = patch.kvCacheType
    const next = await this.client.setLlamaOptions(p as never)
    this.options = { contextTokens: next.contextTokens, kvCacheType: String(next.kvCacheType) }
    this.push()
    return this.status()
  }

  async logs(tail = 120): Promise<string[]> {
    if (!this.attachment) return []
    return this.attachment.session.logs(tail).map((l) => {
      const e = l as { line?: string; message?: string; text?: string }
      return e.line ?? e.message ?? e.text ?? JSON.stringify(l)
    })
  }

  /** Preferred model: the operator's pick when it still exists, else the first file found. */
  private preferredModelId(): string | null {
    const pick = settingsStore.load().localModel.modelId
    if (pick && this.models.some((m) => m.id === pick)) return pick
    return this.models[0]?.id ?? null
  }

  /**
   * The local vendor's endpoint: the live model's /v1 (+ headers). If nothing is
   * running, boot the preferred model first (a cold 8B load is seconds; 27B a
   * couple of minutes) so a scheduled agent doesn't silently skip its wake-up.
   */
  async endpoint(): Promise<LocalEndpoint | null> {
    const a = await this.ensure()
    const s = a.session
    if (!s.active) {
      const id = this.preferredModelId()
      if (!id) return null
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local model did not become ready in time')), START_TIMEOUT_MS))
      await Promise.race([this.start(id), timeout])
    }
    const active = s.active
    const ep = s.chatEndpoint(null)
    if (!active || !ep) return null
    return {
      baseUrl: ep.baseURL,
      headers: ep.headers,
      model: active.health?.modelId ?? 'local',
      modelLabel: active.model.shortName ?? active.model.id,
      reasoning: active.health?.reasoning ? { supported: active.health.reasoning.supported, effortLevels: active.health.reasoning.effortLevels } : null,
      contextWindow: active.health?.contextWindow ?? null
    }
  }

  /** Why `endpoint()` came back null — for the agent's thread. */
  unavailableReason(): string {
    const st = this.status()
    if (!st.available) return `The local engine could not start${st.lastError ? ` (${st.lastError})` : ''}. Open Settings → Local models.`
    if (!st.engines.some((e) => e.installed)) return 'llama.cpp is not installed. Open Settings → Local models for the install command.'
    if (!st.folder) return 'No models folder is set — choose one in Settings → Local models.'
    if (!st.models.length) return `No GGUF models were found in ${st.folder}.`
    return 'No local model is running — start one in Settings → Local models.'
  }

  async close(): Promise<void> {
    const a = this.attachment
    this.attachment = null
    await a?.close({ keepAdopted: true, keepEngine: false }).catch(() => undefined)
  }
}

export const localEngine = new LocalEngineService()
