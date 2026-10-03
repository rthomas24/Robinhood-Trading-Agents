import { ipcMain, type BrowserWindow } from 'electron'
import { openExternalSafely } from '../lib/openExternal'
import { AGENT_EVENT_CHANNEL, AUTH_EVENT_CHANNEL, LOCAL_EVENT_CHANNEL, IpcChannels, type CreateAgentRequest, type DecisionQuery, type UpdateAgentPatch, type AppSettings, type TradingHaltResult } from '@shared/ipc'
import { normMarketDataFeed, type MarketDataKeyRequest } from '@shared/marketData'
import { agentSlotBlocked, countActiveAgents, type AgentConfig } from '@shared/agents'
import { configFromCreateRequest } from '@shared/createAgent'
import { checkClaudeAuth } from '../claude/auth'
import { runClaudeLogin, saveToken, logoutClaude, setSignInSuccessHandler } from '../claude/login'
import { usageService } from '../claude/usage'
import { chatgptLogin, chatgptLoginDevice, chatgptLogout, chatgptStatus } from '../chatgpt/auth'
import { onTokensChange as onChatGptTokensChange } from '../chatgpt/oauth'
import { engine } from '../engine/Engine'
import { agentStore } from '../store/agentStore'
import { timelineRows } from '../store/timelineRows'
import { openAsks } from '@shared/awaiting'
import { settingsStore } from '../store/settingsStore'
import { layoutStore } from '../store/layoutStore'
import { openrouterKey } from '../store/openrouterKey'
import { mcpKeys } from '../store/mcpKeys'
import { alpacaKey } from '../store/alpacaKey'
import type { McpProviderId, RobinhoodLiveTool } from '@shared/mcps'
import { rhCreds } from '../robinhood/credStore'
import { connectRobinhood } from '../robinhood/connect'
import { localEngine } from '../local/engine'
import type { RobinhoodMcpClient } from '@core/robinhood/mcp'
import { getQuotes, getSparkSeries } from '@core/robinhood/api'
import { fetchPortfolioSnapshot } from '../robinhood/account'
import { desktopMarketFeed } from '../market/feed'
import { focusMainWindow } from '../window'
import { liveAllocationVerdict, liveRoom } from '@shared/liveAllocation'
import { PROVIDERS, providerTarget, type Provider } from '@shared/provider'

let registered = false

const rhClient = (): RobinhoodMcpClient | null => rhCreds.client()

/**
 * One ceiling: `MAX_ACTIVE_AGENTS` non-retired agents on this computer.
 * `agentSlotBlocked` is the SHARED rule, so this gate, the New-agent sheet and
 * the sidebar's respawn button cannot disagree about whether there is room.
 */
function requireAgentSlot(): void {
  const reason = agentSlotBlocked(countActiveAgents(engine.list()))
  if (reason) throw new Error(reason)
}

/**
 * A live allocation must fit inside what the account's OTHER live agents leave
 * of its buying power (shared/liveAllocation.ts). Read from this computer's
 * Robinhood connection; when the account cannot be read the gate lets the
 * write through and logs it — refusing on a guess would block every live
 * agent whenever the broker hiccups, and the sheet has already said what it
 * could. Refusing on a number we DID read is the whole point.
 */
async function requireLiveRoom(cfg: Pick<AgentConfig, 'mode' | 'allocationUsd'>, exceptAgentId?: string): Promise<void> {
  if (cfg.mode !== 'live' || !(cfg.allocationUsd > 0)) return
  let buyingPower: number
  try {
    buyingPower = (await fetchPortfolioSnapshot({ sparks: false })).buyingPower
  } catch (err) {
    console.warn(`[ipc] live allocation not checked — account unreadable: ${(err as Error).message}`)
    return
  }
  const v = liveAllocationVerdict(liveRoom(buyingPower, engine.list(), { exceptAgentId }), cfg.allocationUsd)
  if (!v.ok) throw new Error(v.reason)
}

/**
 * The fields the renderer may change through `agents:update` — `UpdateAgentPatch`
 * as a runtime allowlist. Everything else on a config belongs to the engine:
 * `liveArmedAt` only through `armLive` (which checks the broker connection),
 * the id never.
 */
const UPDATABLE_FIELDS = ['name', 'icon', 'color', 'task', 'schedule', 'guardrails', 'mode', 'model', 'allocationUsd', 'retirement', 'autonomous', 'playbook'] as const satisfies readonly (keyof UpdateAgentPatch)[]
function updatableFields(raw: unknown): UpdateAgentPatch {
  const out: Record<string, unknown> = {}
  if (raw && typeof raw === 'object') for (const k of UPDATABLE_FIELDS) if (k in raw) out[k] = (raw as Record<string, unknown>)[k]
  return out as UpdateAgentPatch
}

/**
 * A provider can only be CHOSEN once the thing it runs on exists: signed in to
 * Claude / ChatGPT, an OpenRouter key stored, or (Local GPU) a default model
 * picked. Same rule the picker greys out, enforced here so a stale window can't
 * slip past it. Checked only where a provider is actually chosen (create /
 * setProvider) — never on a plain update, so editing an existing agent always works.
 */
function requireProviderReady(cfg: Pick<AgentConfig, 'model'>): void {
  switch (cfg.model.vendor) {
    case 'claude':
      if (!checkClaudeAuth().authenticated) throw new Error('Sign in to Claude (Connections) before running agents on your Claude subscription.')
      return
    case 'chatgpt':
      if (!chatgptStatus().authenticated) throw new Error('Sign in to ChatGPT (Connections) before running agents on your ChatGPT subscription.')
      return
    case 'openrouter':
      if (!openrouterKey.value()) throw new Error('Add your OpenRouter API key (Connections) before running agents on OpenRouter.')
      return
    case 'local':
      if (!settingsStore.load().localModel.modelId) throw new Error('Pick a default model in Settings → Local models before running agents on the Local GPU.')
      return
    default:
      return
  }
}

// The Robinhood tool surface varies per account and changes rarely — cache the
// live `tools/list` for the settings page (dropped on credential change).
let rhToolsCache: { at: number; tools: RobinhoodLiveTool[] } | null = null
const RH_TOOLS_TTL = 10 * 60_000

/** How far back an unanswered card still counts as an open ask. */
const ASK_WINDOW = 60

export function registerIpc(win: BrowserWindow): () => void {
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const offAgent = engine.onEvent((e) => send(AGENT_EVENT_CHANNEL, e))
  const offRh = rhCreds.onChange(() => {
    rhToolsCache = null
    send(AUTH_EVENT_CHANNEL, { kind: 'robinhood', status: rhCreds.status() })
  })
  const offUsage = usageService.onChange((usage) => send(AUTH_EVENT_CHANNEL, { kind: 'usage', usage }))
  const offOpenRouter = openrouterKey.onChange(() => send(AUTH_EVENT_CHANNEL, { kind: 'openrouter', status: openrouterKey.status() }))
  const offChatGpt = onChatGptTokensChange(() => send(AUTH_EVENT_CHANNEL, { kind: 'chatgpt', status: chatgptStatus() }))
  const offLocal = localEngine.onChange((e) => send(LOCAL_EVENT_CHANNEL, e))
  setSignInSuccessHandler(() => {
    focusMainWindow()
    send(AUTH_EVENT_CHANNEL, { kind: 'claude', status: checkClaudeAuth() })
  })

  if (!registered) {
    registered = true
    // Claude
    ipcMain.handle(IpcChannels.claudeStatus, () => checkClaudeAuth())
    ipcMain.handle(IpcChannels.claudeLogin, () => runClaudeLogin())
    ipcMain.handle(IpcChannels.claudeSaveToken, (_e, token: string) => saveToken(token))
    ipcMain.handle(IpcChannels.claudeLogout, () => logoutClaude())
    ipcMain.handle(IpcChannels.claudeUsage, () => usageService.get())
    ipcMain.handle(IpcChannels.claudeUsageOverride, () => {
      const usage = usageService.override()
      // Held runners re-arm immediately so the next wake-ups fire.
      engine.emitAll()
      return usage
    })
    // ChatGPT (the operator's own subscription; tokens never cross)
    ipcMain.handle(IpcChannels.chatgptStatus, () => chatgptStatus())
    ipcMain.handle(IpcChannels.chatgptLogin, async () => {
      const r = await chatgptLogin()
      if (r.ok) focusMainWindow()
      return r
    })
    ipcMain.handle(IpcChannels.chatgptLoginDevice, () => chatgptLoginDevice())
    ipcMain.handle(IpcChannels.chatgptLogout, () => chatgptLogout())
    // OpenRouter (the operator's own API key; the key itself never crosses)
    ipcMain.handle(IpcChannels.openrouterStatus, () => openrouterKey.status())
    ipcMain.handle(IpcChannels.openrouterSetKey, (_e, key: string) => openrouterKey.set(String(key ?? '')))
    ipcMain.handle(IpcChannels.openrouterClearKey, () => openrouterKey.clear())
    ipcMain.handle(IpcChannels.openrouterTestKey, () => openrouterKey.test())
    // Robinhood
    ipcMain.handle(IpcChannels.rhStatus, () => rhCreds.status())
    ipcMain.handle(IpcChannels.rhConnect, () => connectRobinhood())
    // Forget the stored grant. The connection itself is revoked from the Robinhood app.
    ipcMain.handle(IpcChannels.rhDisconnect, () => {
      rhCreds.clear()
      return rhCreds.status()
    })
    ipcMain.handle(IpcChannels.rhAccount, () => fetchPortfolioSnapshot({ sparks: false }))
    // Robinhood when connected, else the operator's market-data key (paper
    // marks without a broker), else nothing.
    ipcMain.handle(IpcChannels.rhQuotes, async (_e, symbols: string[]) => {
      const c = rhClient()
      if (c) return getQuotes(c, symbols)
      const feed = desktopMarketFeed()
      return feed ? (await feed.quotes(symbols)).quotes : []
    })
    ipcMain.handle(IpcChannels.rhSparks, async (_e, symbols: string[]) => {
      const c = rhClient()
      if (!c) return {}
      return getSparkSeries(c, symbols)
    })
    ipcMain.handle(IpcChannels.rhTools, async (_e, refresh?: boolean): Promise<RobinhoodLiveTool[]> => {
      const c = rhClient()
      if (!c) return []
      if (!refresh && rhToolsCache && Date.now() - rhToolsCache.at < RH_TOOLS_TTL) return rhToolsCache.tools
      const tools = await c.listTools()
      rhToolsCache = { at: Date.now(), tools }
      return tools
    })
    // Agents
    ipcMain.handle(IpcChannels.agentsList, () => engine.list())
    ipcMain.handle(IpcChannels.agentsCreate, async (_e, req: CreateAgentRequest) => {
      const cfg = configFromCreateRequest(req, settingsStore.load().defaultModel)
      requireAgentSlot()
      requireProviderReady(cfg)
      await requireLiveRoom(cfg)
      // A playbook owns its schedule, so a setup run that picks one would only fight it.
      return engine.create(cfg, cfg.playbook ? false : (req.planNow ?? true))
    })
    ipcMain.handle(IpcChannels.agentsUpdate, async (_e, id: string, raw: unknown) => {
      const patch = updatableFields(raw)
      const cur = agentStore.getConfig(id)
      // A provider move is its own operation (`agents:setProvider`): it checks
      // the provider is ready and records the move in the thread.
      if (cur && patch.model && patch.model.vendor !== cur.model.vendor) throw new Error('Change where an agent runs with "Runs on" — it moves the agent and notes it in the thread.')
      // A move to live, or a bigger live allocation, has to fit what the other
      // live agents leave. A paper agent's allocation is its own business.
      if (cur && (patch.mode === 'live' || (cur.mode === 'live' && patch.allocationUsd !== undefined && patch.allocationUsd > cur.allocationUsd))) {
        await requireLiveRoom({ mode: 'live', allocationUsd: patch.allocationUsd ?? cur.allocationUsd }, id)
      }
      return engine.update(id, patch)
    })
    ipcMain.handle(IpcChannels.agentsDelete, (_e, id: string) => engine.delete(id))
    ipcMain.handle(IpcChannels.agentsPause, (_e, id: string) => engine.pause(id))
    ipcMain.handle(IpcChannels.agentsResume, (_e, id: string) => engine.resume(id))
    ipcMain.handle(IpcChannels.agentsRunNow, (_e, id: string) => engine.runNow(id))
    ipcMain.handle(IpcChannels.agentsStop, (_e, id: string) => engine.stop(id))
    ipcMain.handle(IpcChannels.agentsSend, (_e, id: string, text: string) => engine.send(id, text))
    ipcMain.handle(IpcChannels.agentsMessages, (_e, id: string, opts?: { before?: string; limit?: number }) => agentStore.messages(id, opts ?? {}))
    ipcMain.handle(IpcChannels.agentsRuns, (_e, id: string, limit?: number) => agentStore.runs(id, limit))
    ipcMain.handle(IpcChannels.agentsDecisions, (_e, id: string, opts?: DecisionQuery) => agentStore.decisions(id, opts))
    ipcMain.handle(IpcChannels.agentsTimeline, () => timelineRows())
    // Every open ask across EVERY agent, computed here rather than in the
    // renderer: that store only holds threads which have been opened, and the
    // agent nobody has looked at is the one most likely to be stuck.
    //
    // ASK_WINDOW rather than the whole thread — an unanswered card hundreds of
    // messages back has been overtaken by events, and reading every thread in
    // full on each refresh would make a status bar cost more than the app.
    ipcMain.handle(IpcChannels.agentsAwaiting, () => engine.list().flatMap((s) => openAsks(agentStore.recentMessages(s.config.id, ASK_WINDOW))))
    ipcMain.handle(IpcChannels.agentsMarkRead, (_e, id: string) => engine.markRead(id))
    ipcMain.handle(IpcChannels.agentsApplyPlan, (_e, id: string, mid: string) => engine.applyPlan(id, mid))
    ipcMain.handle(IpcChannels.agentsDismissPlan, (_e, id: string, mid: string) => engine.dismissPlan(id, mid))
    ipcMain.handle(IpcChannels.agentsAnswerApproval, (_e, id: string, mid: string, approve: boolean) => engine.answerApproval(id, mid, approve))
    ipcMain.handle(IpcChannels.agentsResetPaper, (_e, id: string) => engine.resetPaper(id))
    ipcMain.handle(IpcChannels.agentsRetire, (_e, id: string, reason?: string) => engine.retire(id, reason))
    ipcMain.handle(IpcChannels.agentsRespawn, (_e, id: string) => {
      if (agentStore.getState(id)?.status === 'retired') requireAgentSlot()
      return engine.respawn(id)
    })
    ipcMain.handle(IpcChannels.agentsArmLive, (_e, id: string, armed: boolean) => engine.armLive(id, armed))
    ipcMain.handle(IpcChannels.agentsCompleteTask, (_e, id: string, taskId: string, reason?: string) => engine.completeTask(id, taskId, reason))
    ipcMain.handle(IpcChannels.agentsSetProvider, (_e, id: string, provider: Provider) => {
      if (!PROVIDERS.includes(provider)) throw new Error('unknown provider')
      const cur = agentStore.getConfig(id)
      if (cur) requireProviderReady(providerTarget(provider, cur.model))
      return engine.setProvider(id, provider)
    })
    // Settings / misc
    ipcMain.handle(IpcChannels.settingsGet, () => settingsStore.load())
    ipcMain.handle(IpcChannels.settingsSet, (_e, patch: Partial<AppSettings>) => {
      const next = settingsStore.save(patch)
      if (patch.localModel) engine.warmLocalEngine()
      return next
    })
    // The trading halt. Read by every agent's guardrails before each order.
    ipcMain.handle(IpcChannels.settingsSetTradingHalt, (_e, halted: boolean): TradingHaltResult => {
      const on = halted === true
      settingsStore.save({ tradingHalted: on })
      return {
        halted: on,
        detail: on ? 'Live buying is off for every agent. Selling, stops and take-profits still work.' : 'Live buying is back on for every agent.'
      }
    })
    // The sidebar layout (groups + order) — one document, last writer wins.
    ipcMain.handle(IpcChannels.layoutGet, () => layoutStore.load())
    ipcMain.handle(IpcChannels.layoutSet, (_e, layout: unknown) => layoutStore.save(layout))
    // Only absolute http(s)/mailto URLs leave the app (`shared/externalUrl.ts`):
    // agent prose carries links from anything it read.
    ipcMain.handle(IpcChannels.openExternal, async (_e, url: unknown) => {
      await openExternalSafely(url)
    })
    // Local GPU models (the local llama.cpp engine) — lazily attaches/hosts the daemon on first use.
    ipcMain.handle(IpcChannels.localStatus, async () => {
      await localEngine.ensure().catch(() => undefined)
      return localEngine.status()
    })
    ipcMain.handle(IpcChannels.localStart, (_e, modelId: string) => localEngine.start(String(modelId)))
    ipcMain.handle(IpcChannels.localStop, () => localEngine.stop())
    ipcMain.handle(IpcChannels.localPickFolder, () => localEngine.pickFolder())
    ipcMain.handle(IpcChannels.localRescan, () => localEngine.rescan())
    ipcMain.handle(IpcChannels.localSetOptions, (_e, patch: { contextTokens?: number; kvCacheType?: string }) => localEngine.setOptions(patch ?? {}))
    ipcMain.handle(IpcChannels.localLogs, (_e, tail?: number) => localEngine.logs(Number(tail) || 120))
    // Intel MCP keys (values stay in main)
    ipcMain.handle(IpcChannels.mcpStatus, () => mcpKeys.status())
    ipcMain.handle(IpcChannels.mcpSetKey, (_e, id: McpProviderId, key: string) => mcpKeys.set(id, String(key ?? '')))
    ipcMain.handle(IpcChannels.mcpClearKey, (_e, id: McpProviderId) => mcpKeys.clear(id))
    // Market data key (values stay in main)
    ipcMain.handle(IpcChannels.marketDataStatus, () => alpacaKey.status())
    ipcMain.handle(IpcChannels.marketDataSetKey, (_e, req: MarketDataKeyRequest) => {
      const keyId = String(req?.keyId ?? '').trim()
      const secret = String(req?.secret ?? '').trim()
      if (!keyId || !secret) throw new Error('Both the key id and the secret are needed.')
      alpacaKey.set({ keyId, secret, feed: normMarketDataFeed(req?.feed) })
      return alpacaKey.status()
    })
    ipcMain.handle(IpcChannels.marketDataClearKey, () => {
      alpacaKey.set(null)
      return alpacaKey.status()
    })
  }

  return () => {
    offAgent()
    offRh()
    offUsage()
    offOpenRouter()
    offChatGpt()
    offLocal()
  }
}
