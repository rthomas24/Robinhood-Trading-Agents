import type { Ask } from './awaiting'
import type {
  AgentColor,
  RetirementPolicy,
  AgentConfig,
  AgentIcon,
  AgentSummary,
  Guardrails,
  Message,
  Mode,
  ModelChoice,
  ModelVendor,
  RunRecord,
  Schedule
} from './agents'
import type { McpProviderId, McpRuntimeNeed, RobinhoodLiveTool, ToolPolicy } from './mcps'
import type { ThemeId } from './themes'
import type { DecisionRecord } from './decisions'
import type { TimelineRow } from './timeline'
import type { Provider } from './provider'
import type { AgentLayout } from './agentLayout'
import type { Playbook } from './earningsPlaybook'
import type { RealtimeCreateRequest, RealtimeKeyStatus, RealtimePriceSample, RealtimeState, RealtimeStreamKeyRequest, RealtimeStreamStatus, RealtimeSummary, RealtimeTick, RealtimeUpdateRequest } from './realtimeAgents'

/* ───────────────────────────── Channels ───────────────────────────── */

export const IpcChannels = {
  // Claude (model vendor) auth
  claudeStatus: 'claude:status',
  claudeLogin: 'claude:login',
  claudeSaveToken: 'claude:saveToken',
  claudeLogout: 'claude:logout',
  claudeUsage: 'claude:usage',
  claudeUsageOverride: 'claude:usageOverride',
  // ChatGPT (model vendor) auth — the user's own subscription via the Codex OAuth flow
  chatgptStatus: 'chatgpt:status',
  chatgptLogin: 'chatgpt:login',
  chatgptLoginDevice: 'chatgpt:loginDevice',
  chatgptLogout: 'chatgpt:logout',
  // OpenRouter (model vendor) — the operator's own API key; the key never leaves main
  openrouterStatus: 'openrouter:status',
  openrouterSetKey: 'openrouter:setKey',
  openrouterClearKey: 'openrouter:clearKey',
  openrouterTestKey: 'openrouter:testKey',
  // Robinhood
  rhStatus: 'rh:status',
  rhConnect: 'rh:connect',
  rhDisconnect: 'rh:disconnect',
  rhAccount: 'rh:account',
  rhQuotes: 'rh:quotes',
  rhSparks: 'rh:sparks',
  rhTools: 'rh:tools',
  // Agents
  agentsList: 'agents:list',
  agentsCreate: 'agents:create',
  agentsUpdate: 'agents:update',
  agentsDelete: 'agents:delete',
  agentsPause: 'agents:pause',
  agentsResume: 'agents:resume',
  agentsRunNow: 'agents:runNow',
  agentsStop: 'agents:stop',
  agentsSend: 'agents:send',
  agentsMessages: 'agents:messages',
  agentsRuns: 'agents:runs',
  agentsDecisions: 'agents:decisions',
  agentsTimeline: 'agents:timeline',
  agentsAwaiting: 'agents:awaiting',
  agentsMarkRead: 'agents:markRead',
  agentsApplyPlan: 'agents:applyPlan',
  agentsDismissPlan: 'agents:dismissPlan',
  agentsAnswerApproval: 'agents:answerApproval',
  agentsResetPaper: 'agents:resetPaper',
  agentsRetire: 'agents:retire',
  agentsRespawn: 'agents:respawn',
  agentsArmLive: 'agents:armLive',
  agentsSetProvider: 'agents:setProvider',
  agentsCompleteTask: 'agents:completeTask',
  // Settings / misc
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsSetTradingHalt: 'settings:setTradingHalt',
  // The sidebar arrangement (groups + order), stored on this computer
  layoutGet: 'layout:get',
  layoutSet: 'layout:set',
  openExternal: 'shell:openExternal',
  // Local GPU models (the local llama.cpp engine + the operator's models folder)
  localStatus: 'local:status',
  localStart: 'local:start',
  localStop: 'local:stop',
  localPickFolder: 'local:pickFolder',
  localRescan: 'local:rescan',
  localSetOptions: 'local:setOptions',
  localLogs: 'local:logs',
  // Intel MCP providers (keys never leave main)
  mcpStatus: 'mcp:status',
  mcpSetKey: 'mcp:setKey',
  mcpClearKey: 'mcp:clearKey',
  // Real-time agents (desktop-only paper loop decided by a System One model)
  realtimeList: 'realtime:list',
  realtimeCreate: 'realtime:create',
  realtimeUpdate: 'realtime:update',
  realtimeDelete: 'realtime:delete',
  realtimeSetStatus: 'realtime:setStatus',
  realtimeResetPaper: 'realtime:resetPaper',
  realtimeTickNow: 'realtime:tickNow',
  realtimeKeyStatus: 'realtime:keyStatus',
  realtimeSetKey: 'realtime:setKey',
  realtimeClearKey: 'realtime:clearKey',
  realtimeTestKey: 'realtime:testKey',
  realtimeStreamStatus: 'realtime:streamStatus',
  realtimeSetStreamKey: 'realtime:setStreamKey',
  realtimeClearStreamKey: 'realtime:clearStreamKey'
} as const

export const AGENT_EVENT_CHANNEL = 'tb:agent-event'
export const AUTH_EVENT_CHANNEL = 'tb:auth-event'
export const LOCAL_EVENT_CHANNEL = 'tb:local-event'
export const REALTIME_EVENT_CHANNEL = 'tb:realtime-event'

/** Pushed by the real-time engine. A tick carries the state WITHOUT `recent`; the renderer appends the tick itself. */
export type RealtimeEvent =
  | { type: 'realtime:updated'; summary: RealtimeSummary }
  | { type: 'realtime:deleted'; id: string }
  | { type: 'realtime:tick'; id: string; tick: RealtimeTick; state: Omit<RealtimeState, 'recent'> }
  /** A quote sample between decisions (every `REALTIME_PRICE_POLL_MS` while an agent runs in session). Ephemeral: never stored. */
  | { type: 'realtime:price'; sample: RealtimePriceSample }
  | { type: 'realtime:stream'; status: RealtimeStreamStatus }

/* ───────────────────────────── Local GPU models ───────────────────────────── */

export interface LocalEngineInfo {
  id: string
  displayName: string
  installed: boolean
  availableOnThisPlatform: boolean
  installHint: string | null
  installCommand: string | null
  executable: string | null
}

/** A GGUF file found in the operator's models folder. `id` = absolute file path. */
export interface LocalModelInfo {
  id: string
  name: string
  /** Path relative to the models folder (for display). */
  relPath: string
  sizeGiB: number
  /** A sharded model's first shard (the others load automatically). */
  sharded: boolean
  /** Looks like a fit for this GPU's VRAM (rough: file size vs. VRAM + headroom). */
  fit: 'good' | 'tight' | 'cpu' | null
}

export interface LocalStatus {
  /** The engine runtime could be started at all. */
  available: boolean
  url: string | null
  state: string
  active: { modelId: string; modelName: string; engine: string; contextWindow: number | null; reasoning: boolean } | null
  activating: { modelId: string; modelName: string } | null
  engines: LocalEngineInfo[]
  hardware: { chip: string; memoryGiB: number; freeDiskGiB: number | null; tier: string | null; gpus: { name: string; vramGiB: number | null; vendor: string }[] } | null
  /** The operator's models folder and what was found in it. */
  folder: string | null
  folderError: string | null
  models: LocalModelInfo[]
  lastError: string | null
  /** llama.cpp knobs the operator can set (context window in tokens, KV-cache precision). */
  options: { contextTokens: number; kvCacheType: string } | null
  /** Settings mirror: the global "run everything locally" switch + preferred model. */
  enabled: boolean
  defaultModelId: string | null
}

export type LocalEvent = { type: 'local:status'; status: LocalStatus }

/* ───────────────────────────── Claude auth ───────────────────────────── */

export interface ClaudeAuthStatus {
  vendor: ModelVendor
  authenticated: boolean
  apiKeyOverrideDetected: boolean
  subscriptionType?: string
  detail: string
}

export interface AuthLoginResult {
  ok: boolean
  status: ClaudeAuthStatus
  message: string
}

/**
 * Claude subscription rate-limit reading. The 5-hour window drives the agent
 * hold: at 100% utilization autonomous runs pause until it resets, usage
 * recovers, or the operator overrides.
 */
export interface ClaudeUsageWindow {
  /** 0–100. */
  utilization: number
  resetsAt: string | null
}

export interface ClaudeUsage {
  /** Rate-limit info is available for this account/session. */
  available: boolean
  fiveHour?: ClaudeUsageWindow
  sevenDay?: ClaudeUsageWindow
  /** The 5-hour window is used up. */
  exhausted: boolean
  /** Agents are being held (exhausted and not overridden). */
  holdActive: boolean
  /** Operator chose to keep running despite exhaustion. */
  overridden: boolean
  fetchedAt: number
}

/**
 * ChatGPT-subscription sign-in state. Tokens never cross to the renderer — only
 * this derived view. `subscriptionType` is the plan label ("ChatGPT Plus").
 */
export interface ChatGptAuthStatus {
  authenticated: boolean
  /** OPENAI_API_KEY is set in the environment — not used by us, flagged so the operator knows. */
  apiKeyOverrideDetected: boolean
  subscriptionType?: string
  email?: string
  /** Access-token expiry (epoch ms); refreshed proactively before runs. */
  expiresAt?: number
  detail: string
  secureStorage: boolean
}
export interface ChatGptLoginResult {
  ok: boolean
  status: ChatGptAuthStatus
  message: string
}
/** Device-code sign-in: show the code, open the URL; `completed` resolves through a later status push. */
export interface ChatGptDeviceStart {
  ok: boolean
  userCode?: string
  verificationUrl?: string
  message: string
}

/** Auth-status pushes from main: connection changes and usage refreshes. */
export type AuthEvent =
  | { kind: 'claude'; status: ClaudeAuthStatus }
  | { kind: 'chatgpt'; status: ChatGptAuthStatus }
  | { kind: 'robinhood'; status: RobinhoodStatus }
  | { kind: 'openrouter'; status: OpenRouterStatus }
  | { kind: 'usage'; usage: ClaudeUsage }

/* ───────────────────────────── OpenRouter ───────────────────────────── */

/**
 * The operator's own OpenRouter API key, as the renderer may see it: whether
 * one is stored and what the last test said. The key itself never crosses the
 * bridge — it is encrypted at rest and only the engine reads it.
 */
export interface OpenRouterStatus {
  hasKey: boolean
  /** One line for the UI: a confirmation, or what is wrong. */
  detail: string
  /** The key's label on openrouter.ai, from the last successful test. */
  label?: string
  /** USD spent on this key so far, from the last successful test. */
  usageUsd?: number
  /** The key's credit limit in USD (null = unlimited), from the last successful test. */
  limitUsd?: number | null
  testedAt?: string
  error?: string
}

/* ───────────────────────────── Robinhood ───────────────────────────── */

export interface RobinhoodStatus {
  connected: boolean
  /** Masked account hint when connected. */
  accountHint?: string
  expiresAt?: number
  detail: string
  /** Encryption backend available for at-rest secrets. */
  secureStorage: boolean
}

export interface RobinhoodConnectResult {
  ok: boolean
  message: string
  status: RobinhoodStatus
}

/** One execution at the broker on the current ET day, whoever placed it (an agent or the operator by hand). */
export interface AccountFill {
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  /** Average execution price. */
  price: number
  at: string
}

export interface AccountSnapshot {
  accountNumber?: string
  buyingPower: number
  cash: number
  equity: number
  positions: { symbol: string; qty: number; avgCost: number; marketValue: number }[]
  /**
   * Every fill at the broker today, so "today" can be measured from the
   * account's day-start equity rather than from the shares held right now.
   * Absent = UNKNOWN (the orders call failed, or an older publisher) — never
   * read it as "no trades today": the day figure then excludes today's
   * trades and the reader must say so.
   */
  fillsToday?: AccountFill[]
  fetchedAt: string
}

export interface Quote {
  symbol: string
  last: number
  bid?: number
  ask?: number
  /** The PRIOR session's close — never the close of a session that ended today (see `prevCloseDate`). */
  prevClose?: number
  /**
   * yyyy-mm-dd (ET) of the session `prevClose` closed. Robinhood rolls its
   * "previous close" to TODAY's close the moment the regular session ends;
   * `core/robinhood/api.ts` reads this date to notice and swap the prior
   * session's close back in, so a day figure at 8 PM measures the same thing
   * as one at 2 PM. Absent on quotes from a source that did not say.
   */
  prevCloseDate?: string
  changePct?: number
  ts: string
}

/* ───────────────────────────── Agents ───────────────────────────── */

export interface CreateAgentRequest {
  name: string
  icon: AgentIcon
  color: AgentColor
  task: string
  mode: Mode
  schedule?: Schedule
  guardrails?: Partial<Guardrails>
  model?: ModelChoice
  allocationUsd: number
  retirement?: RetirementPolicy | null
  /** Ask the agent to propose a schedule/guardrails from the task (default true). */
  planNow?: boolean
  /** Let it act on its own. Off = every money-moving tool waits for the operator. */
  autonomous?: boolean
  /** A special mode the engine enforces (`shared/earningsPlaybook.ts`); it owns the schedule and the sizing fence. */
  playbook?: Playbook
}

export type UpdateAgentPatch = Partial<
  Pick<AgentConfig, 'name' | 'icon' | 'color' | 'task' | 'schedule' | 'guardrails' | 'mode' | 'model' | 'allocationUsd' | 'retirement' | 'autonomous' | 'playbook'>
>

/** How much of the decision log to read: a time window (`since`, epoch ms) and/or a row cap (newest first). */
export interface DecisionQuery {
  since?: number
  limit?: number
}

export interface MessagesPage {
  messages: Message[]
  hasMore: boolean
}

/** Live, mid-run deltas so the thread shows the agent working. */
export type RunDelta =
  | { kind: 'start'; trigger: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'tool_result'; name: string; output: string }
  /** A transient vendor failure is being retried — the thread shows it rather than a silent gap. */
  /**
   * A transient vendor failure is being retried. The next attempt REGENERATES
   * the whole reply from scratch, so everything streamed so far is void:
   * consumers must CLEAR any accumulated text and thinking on this delta, or
   * the new attempt's reply appends to the abandoned one's partial and the
   * operator reads the same sentence twice, spliced together.
   */
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  | { kind: 'end'; ok: boolean; error?: string }

export type AgentEvent =
  | { type: 'agent:updated'; summary: AgentSummary }
  | { type: 'agent:deleted'; agentId: string }
  | { type: 'message:new'; message: Message }
  | { type: 'message:updated'; message: Message }
  | { type: 'run:delta'; agentId: string; runId: string; delta: RunDelta }

/* ───────────────────────────── Settings ───────────────────────────── */

export type ThemeName = ThemeId
export interface AppSettings {
  /** Theme id from shared/themes.ts (any of the catalog; 'light' | 'dark' remain the defaults). */
  theme: ThemeName
  /** Default provider (which service runs it) for new agents — the status-bar switcher. Seeds new agents only; never reroutes existing ones. */
  defaultProvider: Provider
  /** Default model for new agents (its vendor always matches `defaultProvider`). */
  defaultModel: ModelChoice
  onboardingDone: boolean
  /** Global tool policy: Robinhood tools switched off + intel MCPs switched on. */
  tools: ToolPolicy
  /** The trading halt: live BUYS are refused on every agent. Sells, stops and take-profits keep working. */
  tradingHalted: boolean
  /** Local GPU engine: the GGUF folder + the file to serve. `enabled` is legacy (the old fleet-wide force switch) and no longer reroutes agents — each agent has its own provider. */
  localModel: { enabled: boolean; folder: string | null; modelId: string | null }
}

/* ───────────────────────────── Intel MCPs ───────────────────────────── */

/** Host-side facts the settings UI needs: which keys are stored, which runtimes exist. */
export interface McpStatus {
  /** Provider id → a key/token is stored (value never crosses the bridge). */
  keys: Partial<Record<McpProviderId, boolean>>
  runtimes: Record<McpRuntimeNeed, boolean>
  platform: NodeJS.Platform
}

/* ───────────────────────────── Safety + layout ───────────────────────────── */

/** Result of flipping the trading halt. */
export interface TradingHaltResult {
  halted: boolean
  detail: string
}

/** Result of saving the sidebar layout. */
export interface LayoutWriteResult {
  /** Did the file take the whole document? False = the next launch will NOT see this arrangement. */
  ok: boolean
  detail?: string
}

/* ───────────────────────────── The bridge ───────────────────────────── */

export interface TbApi {
  claude: {
    status(): Promise<ClaudeAuthStatus>
    login(): Promise<AuthLoginResult>
    saveToken(token: string): Promise<AuthLoginResult>
    logout(): Promise<AuthLoginResult>
    usage(): Promise<ClaudeUsage>
    /** Keep running despite an exhausted 5-hour window. */
    overrideUsageHold(): Promise<ClaudeUsage>
  }
  chatgpt: {
    status(): Promise<ChatGptAuthStatus>
    /** Browser PKCE sign-in on the Codex loopback port (1455). */
    login(): Promise<ChatGptLoginResult>
    /** Device-code fallback (port busy / headless): returns the code to type; completion arrives as an auth event. */
    loginDevice(): Promise<ChatGptDeviceStart>
    logout(): Promise<ChatGptLoginResult>
  }
  openrouter: {
    status(): Promise<OpenRouterStatus>
    setKey(key: string): Promise<OpenRouterStatus>
    clearKey(): Promise<OpenRouterStatus>
    /** Ask openrouter.ai about the stored key (label, usage, limit). */
    testKey(): Promise<OpenRouterStatus>
  }
  robinhood: {
    status(): Promise<RobinhoodStatus>
    connect(): Promise<RobinhoodConnectResult>
    disconnect(): Promise<RobinhoodStatus>
    account(): Promise<AccountSnapshot>
    quotes(symbols: string[]): Promise<Quote[]>
    /** Intraday close series per symbol (last session) for sparklines. */
    sparks(symbols: string[]): Promise<Record<string, number[]>>
    /** Live `tools/list` from the Robinhood MCP for this account ([] when not connected). */
    tools(refresh?: boolean): Promise<RobinhoodLiveTool[]>
  }
  agents: {
    list(): Promise<AgentSummary[]>
    create(req: CreateAgentRequest): Promise<AgentSummary>
    update(id: string, patch: UpdateAgentPatch): Promise<AgentSummary>
    delete(id: string): Promise<void>
    pause(id: string): Promise<AgentSummary>
    resume(id: string): Promise<AgentSummary>
    runNow(id: string): Promise<void>
    stop(id: string): Promise<void>
    send(id: string, text: string): Promise<Message>
    messages(id: string, opts?: { before?: string; limit?: number }): Promise<MessagesPage>
    runs(id: string, limit?: number): Promise<RunRecord[]>
    /**
     * Authorization decision log, newest first (shared/decisions.ts). `since`
     * (epoch ms) bounds by TIME so a sentence about "the last 7 days" is a
     * claim about the window, not about the newest N rows; `limit` caps the
     * rows returned (newest first) — a result of exactly `limit` rows may be
     * truncated, and readers should say so.
     */
    decisions(id: string, opts?: DecisionQuery): Promise<DecisionRecord[]>
    /** The portfolio's daily history for every agent, reduced from the local run log (shared/timeline.ts). Fold with `buildTimeline`. */
    timeline(): Promise<TimelineRow[]>
    /**
     * Every open ask across EVERY agent, oldest first.
     *
     * Computed in main from the local message store rather than in the
     * renderer, because the renderer only loads a thread once you open it — so
     * a bar that showed asks from loaded threads would be a bar that hides the
     * agent you have not looked at, which is the one most likely to be stuck.
     */
    awaiting(): Promise<Ask[]>
    markRead(id: string): Promise<void>
    applyPlan(id: string, messageId: string): Promise<AgentSummary>
    dismissPlan(id: string, messageId: string): Promise<void>
    /** Answer a held action. Approving wakes the agent to re-decide — it never executes anything itself. */
    answerApproval(id: string, messageId: string, approve: boolean): Promise<AgentSummary>
    resetPaper(id: string): Promise<AgentSummary>
    retire(id: string, reason?: string): Promise<AgentSummary>
    respawn(id: string): Promise<AgentSummary>
    armLive(id: string, armed: boolean): Promise<AgentSummary>
    /** Move an agent to another provider — mid-run is fine; the next run uses the new one (shared/provider.ts). */
    setProvider(id: string, provider: Provider): Promise<AgentSummary>
    /** Stop working on one standing task. The agent keeps the record; it just stops being given to the model. */
    completeTask(id: string, taskId: string, reason?: string): Promise<AgentSummary>
    onEvent(cb: (e: AgentEvent) => void): () => void
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
    /** The trading halt: refuses live BUYS on every agent. Sells, stops and targets keep working. */
    setTradingHalt(halted: boolean): Promise<TradingHaltResult>
  }
  /** The sidebar arrangement (groups, membership, manual order), stored on this computer. */
  layout: {
    get(): Promise<AgentLayout>
    /** Save the WHOLE layout (last writer wins). */
    set(layout: AgentLayout): Promise<LayoutWriteResult>
  }
  local: {
    status(): Promise<LocalStatus>
    /** Start a GGUF from the models folder (absolute path = LocalModelInfo.id). */
    start(modelId: string): Promise<LocalStatus>
    stop(): Promise<LocalStatus>
    /** Native folder picker → sets the models folder and rescans. */
    pickFolder(): Promise<LocalStatus>
    rescan(): Promise<LocalStatus>
    /** Context window / KV cache for llama.cpp (applies on the next model start). */
    setOptions(patch: { contextTokens?: number; kvCacheType?: string }): Promise<LocalStatus>
    logs(tail?: number): Promise<string[]>
    onEvent(cb: (e: LocalEvent) => void): () => void
  }
  mcp: {
    status(): Promise<McpStatus>
    setKey(id: McpProviderId, key: string): Promise<McpStatus>
    clearKey(id: McpProviderId): Promise<McpStatus>
  }
  /** Real-time agents: a paper loop on this computer, decided by a System One model. */
  realtime: {
    list(): Promise<RealtimeSummary[]>
    create(req: RealtimeCreateRequest): Promise<RealtimeSummary>
    update(id: string, patch: RealtimeUpdateRequest): Promise<RealtimeSummary>
    delete(id: string): Promise<void>
    setStatus(id: string, status: 'running' | 'paused'): Promise<RealtimeSummary>
    resetPaper(id: string): Promise<RealtimeSummary>
    /** One tick now, whatever the schedule says. */
    tickNow(id: string): Promise<RealtimeSummary>
    keyStatus(): Promise<RealtimeKeyStatus>
    setKey(key: string): Promise<RealtimeKeyStatus>
    clearKey(): Promise<RealtimeKeyStatus>
    /** Ask the service which models the stored key can use. */
    testKey(): Promise<RealtimeKeyStatus>
    /** The live market-data stream (the operator's own key) behind one-second decisions. */
    streamStatus(): Promise<RealtimeStreamStatus>
    setStreamKey(req: RealtimeStreamKeyRequest): Promise<RealtimeStreamStatus>
    clearStreamKey(): Promise<RealtimeStreamStatus>
    onEvent(cb: (e: RealtimeEvent) => void): () => void
  }
  openExternal(url: string): Promise<void>
  platform: NodeJS.Platform
}
