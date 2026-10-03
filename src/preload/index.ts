import { contextBridge, ipcRenderer } from 'electron'
import { AGENT_EVENT_CHANNEL, AUTH_EVENT_CHANNEL, LOCAL_EVENT_CHANNEL, IpcChannels, type AgentEvent, type AuthEvent, type LocalEvent, type TbApi } from '@shared/ipc'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: TbApi & { onAuthEvent(cb: (e: AuthEvent) => void): () => void } = {
  claude: {
    status: () => ipcRenderer.invoke(IpcChannels.claudeStatus),
    login: () => ipcRenderer.invoke(IpcChannels.claudeLogin),
    saveToken: (token) => ipcRenderer.invoke(IpcChannels.claudeSaveToken, token),
    logout: () => ipcRenderer.invoke(IpcChannels.claudeLogout),
    usage: () => ipcRenderer.invoke(IpcChannels.claudeUsage),
    overrideUsageHold: () => ipcRenderer.invoke(IpcChannels.claudeUsageOverride)
  },
  chatgpt: {
    status: () => ipcRenderer.invoke(IpcChannels.chatgptStatus),
    login: () => ipcRenderer.invoke(IpcChannels.chatgptLogin),
    loginDevice: () => ipcRenderer.invoke(IpcChannels.chatgptLoginDevice),
    logout: () => ipcRenderer.invoke(IpcChannels.chatgptLogout)
  },
  openrouter: {
    status: () => ipcRenderer.invoke(IpcChannels.openrouterStatus),
    setKey: (key) => ipcRenderer.invoke(IpcChannels.openrouterSetKey, key),
    clearKey: () => ipcRenderer.invoke(IpcChannels.openrouterClearKey),
    testKey: () => ipcRenderer.invoke(IpcChannels.openrouterTestKey)
  },
  robinhood: {
    status: () => ipcRenderer.invoke(IpcChannels.rhStatus),
    connect: () => ipcRenderer.invoke(IpcChannels.rhConnect),
    disconnect: () => ipcRenderer.invoke(IpcChannels.rhDisconnect),
    account: () => ipcRenderer.invoke(IpcChannels.rhAccount),
    quotes: (symbols) => ipcRenderer.invoke(IpcChannels.rhQuotes, symbols),
    sparks: (symbols) => ipcRenderer.invoke(IpcChannels.rhSparks, symbols),
    tools: (refresh) => ipcRenderer.invoke(IpcChannels.rhTools, refresh ?? false)
  },
  agents: {
    list: () => ipcRenderer.invoke(IpcChannels.agentsList),
    create: (req) => ipcRenderer.invoke(IpcChannels.agentsCreate, req),
    update: (id, patch) => ipcRenderer.invoke(IpcChannels.agentsUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(IpcChannels.agentsDelete, id),
    pause: (id) => ipcRenderer.invoke(IpcChannels.agentsPause, id),
    resume: (id) => ipcRenderer.invoke(IpcChannels.agentsResume, id),
    runNow: (id) => ipcRenderer.invoke(IpcChannels.agentsRunNow, id),
    stop: (id) => ipcRenderer.invoke(IpcChannels.agentsStop, id),
    send: (id, text) => ipcRenderer.invoke(IpcChannels.agentsSend, id, text),
    messages: (id, opts) => ipcRenderer.invoke(IpcChannels.agentsMessages, id, opts),
    runs: (id, limit) => ipcRenderer.invoke(IpcChannels.agentsRuns, id, limit),
    decisions: (id, opts) => ipcRenderer.invoke(IpcChannels.agentsDecisions, id, opts),
    timeline: () => ipcRenderer.invoke(IpcChannels.agentsTimeline),
    awaiting: () => ipcRenderer.invoke(IpcChannels.agentsAwaiting),
    markRead: (id) => ipcRenderer.invoke(IpcChannels.agentsMarkRead, id),
    applyPlan: (id, mid) => ipcRenderer.invoke(IpcChannels.agentsApplyPlan, id, mid),
    dismissPlan: (id, mid) => ipcRenderer.invoke(IpcChannels.agentsDismissPlan, id, mid),
    answerApproval: (id, mid, approve) => ipcRenderer.invoke(IpcChannels.agentsAnswerApproval, id, mid, approve),
    resetPaper: (id) => ipcRenderer.invoke(IpcChannels.agentsResetPaper, id),
    retire: (id, reason) => ipcRenderer.invoke(IpcChannels.agentsRetire, id, reason),
    respawn: (id) => ipcRenderer.invoke(IpcChannels.agentsRespawn, id),
    armLive: (id, armed) => ipcRenderer.invoke(IpcChannels.agentsArmLive, id, armed),
    setProvider: (id, provider) => ipcRenderer.invoke(IpcChannels.agentsSetProvider, id, provider),
    completeTask: (id, taskId, reason) => ipcRenderer.invoke(IpcChannels.agentsCompleteTask, id, taskId, reason),
    onEvent: (cb) => on<AgentEvent>(AGENT_EVENT_CHANNEL, cb)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.settingsGet),
    set: (patch) => ipcRenderer.invoke(IpcChannels.settingsSet, patch),
    setTradingHalt: (halted) => ipcRenderer.invoke(IpcChannels.settingsSetTradingHalt, halted)
  },
  layout: {
    get: () => ipcRenderer.invoke(IpcChannels.layoutGet),
    set: (layout) => ipcRenderer.invoke(IpcChannels.layoutSet, layout)
  },
  local: {
    status: () => ipcRenderer.invoke(IpcChannels.localStatus),
    start: (modelId) => ipcRenderer.invoke(IpcChannels.localStart, modelId),
    stop: () => ipcRenderer.invoke(IpcChannels.localStop),
    pickFolder: () => ipcRenderer.invoke(IpcChannels.localPickFolder),
    rescan: () => ipcRenderer.invoke(IpcChannels.localRescan),
    setOptions: (patch) => ipcRenderer.invoke(IpcChannels.localSetOptions, patch),
    logs: (tail) => ipcRenderer.invoke(IpcChannels.localLogs, tail ?? 120),
    onEvent: (cb) => on<LocalEvent>(LOCAL_EVENT_CHANNEL, cb)
  },
  mcp: {
    status: () => ipcRenderer.invoke(IpcChannels.mcpStatus),
    setKey: (id, key) => ipcRenderer.invoke(IpcChannels.mcpSetKey, id, key),
    clearKey: (id) => ipcRenderer.invoke(IpcChannels.mcpClearKey, id)
  },
  marketData: {
    status: () => ipcRenderer.invoke(IpcChannels.marketDataStatus),
    setKey: (req) => ipcRenderer.invoke(IpcChannels.marketDataSetKey, req),
    clearKey: () => ipcRenderer.invoke(IpcChannels.marketDataClearKey)
  },
  openExternal: (url) => ipcRenderer.invoke(IpcChannels.openExternal, url),
  platform: process.platform,
  onAuthEvent: (cb) => on(AUTH_EVENT_CHANNEL, cb)
}

contextBridge.exposeInMainWorld('tb', api)
