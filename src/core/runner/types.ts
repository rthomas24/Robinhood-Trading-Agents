import type { AgentCapacity, AgentConfig, AgentState, Message, RunRecord, RunTrigger } from '@shared/agents'
import type { RunDelta } from '@shared/ipc'
import type { Quote } from '@shared/ipc'
import type { ToolAccess } from '../intel/servers'
import type { DecisionRecord } from '@shared/decisions'
import type { TraceSink } from '../trace/types'
import type { PriceSource } from '@shared/marketData'
import type { PriceFeed } from '../market/feed'
import type { VendorRunners } from './vendors/types'

/** The ESM-only Claude Agent SDK module. Loaded once per process by the host. */
export type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk')

/** Robinhood OAuth token material (stored encrypted by the host). */
export interface RobinhoodToken {
  accessToken: string
  refreshToken?: string
  /** epoch ms */
  expiresAt: number
  tokenType?: string
  scope?: string
}

/**
 * Everything the runner needs from its host. `src/core` never imports Electron:
 * the desktop main process supplies JSON storage, safeStorage credentials and
 * the model vendors, and any other host (a test harness, a headless runner)
 * can supply its own. Model vendors are injected: the desktop offers Claude,
 * ChatGPT, OpenRouter and Local GPU.
 */
export interface RuntimeDeps {
  vendors: VendorRunners
  storage: AgentStorage
  creds: CredentialSource
  /** Scratch cwd for vendor subprocesses. */
  cwd: string
  /**
   * What code is running (the app version on the desktop). Stamped onto every
   * RunRecord so "was this run before or after the fix?" is a question about
   * the row, not a log-timestamp correlation.
   */
  build?: string
  /** Operator tool policy + intel-MCP keys/runtimes. `undefined` = Robinhood read tools only. */
  tools?: () => Promise<ToolAccess>
  now?: () => Date
  emit: (agentId: string, runId: string, delta: RunDelta) => void
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void
  /** Optional sink for the authorization decision log (shared/decisions.ts). */
  audit?: (record: DecisionRecord) => void
  /**
   * The other half of `audit`: read back what was refused, so the next run can
   * be told. Newest first; the prompt filters and bounds it (`refusalsBlock`).
   *
   * Optional, and a failure here must never fail the run — a refusal the agent
   * is not told about costs it a wasted wake-up, while a run that dies because
   * its advisory block could not be read costs the wake-up outright. Hosts
   * without a decision store simply omit it and the block does not render.
   */
  recentDecisions?: (agentId: string, limit: number) => Promise<DecisionRecord[]>

  /**
   * May this computer take on another agent? Only the host can answer — the
   * fleet lives outside the runner. Absent = the host cannot create agents, so
   * `propose_agent` declines and says so.
   */
  capacity?: () => Promise<AgentCapacity>
  /**
   * Switches that span every agent — today just the trading halt. Absent, or a
   * rejected promise, means "not halted": see `GuardrailInput.tradingHalted`.
   */
  accountControls?: () => Promise<AccountControls>
  /**
   * A market-data feed — prices for PAPER agents when there is no Robinhood
   * connection (`core/market/feed.ts`, rule in `shared/marketData.ts`). The
   * desktop supplies one when the operator has entered their own Alpaca key.
   * Absent or null = none, and paper needs Robinhood. Never used for a live
   * agent: a live order is priced and placed by the broker, or not at all.
   */
  marketFeed?: () => Promise<PriceFeed | null>
  /**
   * Where a run's full story goes — prompts, model steps, tool calls, decisions,
   * outcome (`core/trace/types.ts`). Absent = nothing is traced; a sink must
   * never throw into the run it describes.
   */
  trace?: TraceSink
}

/** Operator switches that apply to every agent, not one. */
export interface AccountControls {
  /** Live BUYS are refused on every agent. Sells, stops and targets still work. */
  tradingHalted: boolean
}

export interface AgentStorage {
  getConfig(agentId: string): Promise<AgentConfig | null>
  getState(agentId: string): Promise<AgentState | null>
  /** Persist state; the host should also push `agent:updated` to its UI. */
  saveState(agentId: string, state: AgentState): Promise<void>
  saveConfig(cfg: AgentConfig): Promise<void>
  appendMessage(msg: Message): Promise<void>
  updateMessage(msg: Message): Promise<void>
  recentMessages(agentId: string, limit: number): Promise<Message[]>
  /**
   * Search the WHOLE thread, not the recent window — that is the entire point
   * of the tool this backs. `recentMessages` is deliberately not reusable
   * here: the desktop's cache holds only the last `MSG_CACHE_MAX` (400)
   * messages, so a search built on it would answer "no matches" for anything
   * older and be indistinguishable from a genuine miss.
   */
  searchMessages(agentId: string, query: string, limit: number): Promise<ThreadSearchResult>
  appendRun(run: RunRecord): Promise<void>
}

/**
 * `scannedAll: false` means the host stopped before reaching the oldest
 * message, so a miss is NOT evidence the thread never contained the term. Any
 * bound on a host's scan must be visible, or a truncated search reads as a
 * genuine "no matches".
 */
export interface ThreadSearchResult {
  messages: Message[]
  scannedAll: boolean
}

export interface CredentialSource {
  /**
   * Current Robinhood token, refreshed by the host if needed. Null when not
   * connected.
   *
   * `forceRefresh` is the 401 path: the broker just rejected a token that looks
   * valid by its own clock, so "not expiring yet" is no reason to skip — handing
   * the same dead token back would leave every call failing. The host must try
   * to produce a BETTER token: re-read its store first (the operator may have
   * reconnected), then spend at most one refresh per cooldown. Returning null on
   * a forced call means "I cannot do better than what you already have" — the
   * grant itself is bad, not the moment.
   */
  robinhoodToken(opts?: { forceRefresh?: boolean }): Promise<RobinhoodToken | null>
  /**
   * The broker refused authentication even after a forced refresh. This is the
   * only signal for the failure mode where every refresh "succeeds" — the token
   * endpoint mints happily but the resource rejects what it minted (a dead
   * client registration did exactly this) — so no expiry check can ever see it.
   * Hosts mark the connection broken and tell the operator; they should ignore
   * it when the forced refresh could not run at all (a transient token-endpoint
   * error is a bad minute, not a dead grant).
   */
  brokerAuthFailed?(detail: string): Promise<void>
}

export interface RunRequest {
  agentId: string
  trigger: RunTrigger
  /** For 'reply' runs: the user message(s) that triggered it. */
  userText?: string
  abort?: AbortSignal
}

export interface RunOutcome {
  runId: string
  ok: boolean
  error?: string
  /** Actions taken during the run. */
  actions: number
  state: AgentState
}

export interface MarketContext {
  quotes: Quote[]
  /**
   * Symbols we asked for and did not get. An empty quote list used to be
   * indistinguishable from never having asked, so a broker outage rendered to
   * the model as "QUOTES: none requested" — an invitation to retry the call
   * that just failed. "I have no data" and "I asked and it broke" call for
   * different behaviour, so the prompt has to be able to tell them apart.
   */
  quotesFailed?: string[]
  /** `type` / `unsettledFunds` come from `get_accounts` — the settlement facts (`shared/settlement.ts`). */
  account: { buyingPower: number; cash: number; equity: number; type?: string; unsettledFunds?: number } | null
  /** Why `account` is null, when the reason is a failure rather than "not connected". */
  accountError?: string
  session: 'open' | 'pre' | 'after' | 'closed'
  etNow: string
  /** Computed technicals / earnings / tradability block ('' when unavailable). */
  analysis: string
  /**
   * False when this run has no working broker connection (no grant, or one the
   * broker is rejecting). The prompt needs it for one specific honesty: engine
   * stop/target enforcement and price watches ride the SAME feed, so an agent
   * that cannot see quotes must not reassure the operator that its protective
   * exits are covering the position.
   */
  brokerConnected?: boolean
  /**
   * Where this run's prices came from. `brokerConnected` keeps answering the
   * question it always did (is Robinhood usable — which also decides whether
   * the `mcp__robinhood__*` tools exist); this answers the one the prompt now
   * also needs: are there prices at all, and whose. A paper agent on the
   * market-data feed has `brokerConnected: false, priceSource: 'feed'` — priced,
   * protected, and told that Robinhood's data tools are not on the menu.
   */
  priceSource?: PriceSource
}
