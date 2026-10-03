import { etClock, parseHHMM, type EtClock, type Weekday } from './marketTime'
import { settlesOn, type SettlementMode, type UnsettledLot } from './settlement'
import type { Playbook } from './earningsPlaybook'

/** Paper = simulated fills marked with real quotes; live = real Robinhood orders. */
export type Mode = 'paper' | 'live'
export type AgentStatus = 'idle' | 'scheduled' | 'running' | 'paused' | 'error' | 'done' | 'retired'

/**
 * Self-retirement policy: the engine retires the agent when any condition is
 * met. Retired agents stop running (stats and thread preserved) and can be
 * respawned from the Retired section.
 */
export interface RetirementPolicy {
  /** Retire when total P&L (realized + unrealized) reaches this many USD. */
  profitTargetUsd?: number
  /** Retire (give up) when total P&L falls to −this many USD. */
  maxLossUsd?: number
  /** Hard deadline (ISO) — retire at/after this instant (e.g. end of today). */
  at?: string
  /** Sell any remaining position when retiring (default true). */
  flatten?: boolean
}

export type Schedule =
  | { kind: 'manual' }
  | { kind: 'interval'; everyMinutes: number; marketHoursOnly: boolean }
  | { kind: 'times'; times: string[]; days: Weekday[]; tradingDaysOnly: boolean }
  | { kind: 'once'; at: string }

export interface Guardrails {
  /** Empty = any symbol. Uppercase tickers. */
  allowedSymbols: string[]
  /** Max USD per single order. */
  maxOrderNotional: number
  /** Max orders this agent may place per ET calendar day. */
  maxOrdersPerDay: number
  /** Reject orders outside the regular session (09:30–16:00 ET). */
  marketHoursOnly: boolean
  /** Allow limit orders during extended hours (only meaningful when !marketHoursOnly). */
  allowExtendedHours: boolean
  /** Max USD exposure per symbol (this agent's own book). */
  maxPositionNotional: number
  /** Down this % of allocation on the day -> buying disabled until tomorrow. */
  maxDailyLossPct: number
  // ── Entry discipline. All optional,
  // all BUYS ONLY, and absent means the rule does not exist — an agent made
  // before these shipped keeps behaving exactly as it did. New agents get the
  // defaults `entryDefaultsFor` names.
  /** ET "HH:MM": no buys before this minute. The first minutes carry the widest, least tradeable range. */
  noEntriesBeforeEt?: string
  /** Refuse a buy more than this % above VWAP or above the day's open — chasing an extended print. */
  maxEntryExtensionPct?: number
  /** Today's buys in ONE symbol may not pass this % of the allocation; and one buy per symbol per run. */
  maxSymbolDayPct?: number
  /** After a sell that realized a LOSS in a symbol, no buys in it for this many minutes. */
  reentryCooldownMin?: number
  /** New positions (symbols not already held) this agent may open in one run. */
  maxNewPositionsPerRun?: number
  /**
   * How sale proceeds are treated for BUYS (`shared/settlement.ts`).
   * `'cash'` = only SETTLED cash may buy — proceeds come back the next trading
   * day (T+1), which is what Robinhood's Agentic account does by default;
   * `'margin'` = proceeds are reusable at once (limited margin). Absent = not
   * simulated, so every agent made before this keeps behaving as it did. A LIVE
   * agent follows the broker's real account type whenever it is known, and
   * this setting only fills in when it is not.
   */
  settlement?: SettlementMode
}

/**
 * What a NEW agent gets for the entry rules. Not folded into
 * `DEFAULT_GUARDRAILS`, because that object is spread into places that must
 * not retroactively change an existing agent's fence. The opening window is
 * only for interval agents: a `times` agent scheduled at 09:31 was asked to buy
 * at 09:31, and refusing it would be the engine overruling the operator.
 */
export const ENTRY_DEFAULTS = { noEntriesBeforeEt: '09:45', reentryCooldownMin: 30, maxNewPositionsPerRun: 1, settlement: 'cash' } as const

export function entryDefaultsFor(schedule: Schedule | undefined): Partial<Guardrails> {
  return {
    reentryCooldownMin: ENTRY_DEFAULTS.reentryCooldownMin,
    maxNewPositionsPerRun: ENTRY_DEFAULTS.maxNewPositionsPerRun,
    // The Agentic account is a cash account unless the operator upgrades it,
    // so a new paper agent rehearses T+1 from day one.
    settlement: ENTRY_DEFAULTS.settlement,
    ...(schedule?.kind === 'interval' ? { noEntriesBeforeEt: ENTRY_DEFAULTS.noEntriesBeforeEt } : {})
  }
}

/** An agent created after the entry rules existed — the marker `applyPlanToConfig` keys the interval default on. */
export const hasEntryRules = (g: Guardrails): boolean => g.maxNewPositionsPerRun !== undefined || g.reentryCooldownMin !== undefined

export const DEFAULT_GUARDRAILS: Guardrails = {
  allowedSymbols: [],
  maxOrderNotional: 1000,
  maxOrdersPerDay: 10,
  marketHoursOnly: true,
  allowExtendedHours: false,
  maxPositionNotional: 5000,
  maxDailyLossPct: 5
}

/**
 * Guardrails sized to the capital the agent was actually given.
 *
 * DEFAULT_GUARDRAILS is a set of constants, and New agent sent no guardrails at
 * all — so a $500 agent and a $250,000 agent both got $1,000 per order and
 * $5,000 per symbol. At $500 neither cap can ever bite (only the allocation
 * does); at $250,000 the agent could deploy $10,000 a day and would take
 * twenty-five sessions to reach its own capital, which reads to the operator as
 * an agent ignoring them.
 *
 * 15% of capital per order and 50% per symbol, floored so a tiny agent can
 * still place a trade and capped at the allocation, because a limit above the
 * allocation is not a limit. The operator can change any of it in Settings, and
 * the setup run is told to size them to the task.
 */
export function defaultGuardrailsFor(allocationUsd: number): Guardrails {
  const alloc = Math.max(1, allocationUsd)
  const round = (n: number): number => Math.max(1, Math.round(n))
  return {
    ...DEFAULT_GUARDRAILS,
    maxOrderNotional: round(Math.min(alloc, Math.max(100, alloc * 0.15))),
    maxPositionNotional: round(Math.min(alloc, Math.max(200, alloc * 0.5)))
  }
}

/**
 * Model vendors — every one of them runs on the operator's own account or
 * hardware. `claude` = the Claude Agent SDK on the operator's Claude login;
 * `chatgpt` = the operator's ChatGPT subscription (Plus / Pro / Team) through
 * the Codex OAuth flow; `openrouter` = any OpenRouter model on the operator's
 * own OpenRouter API key; `local` = a GGUF model on this computer's GPU.
 */
export type ModelVendor = 'claude' | 'chatgpt' | 'openrouter' | 'local'
export const VENDOR_LABEL: Record<ModelVendor, string> = { claude: 'Claude', chatgpt: 'ChatGPT', openrouter: 'OpenRouter', local: 'Local GPU' }
export type Effort = 'low' | 'medium' | 'high'

export interface ModelChoice {
  vendor: ModelVendor
  /** Vendor model id, e.g. 'claude-sonnet-5' or 'anthropic/claude-sonnet-5'. */
  id: string
  effort: Effort
}

export interface ModelOption {
  id: string
  label: string
  hint: string
}

/** Newest first. Older models stay listed so an agent already on one still shows and runs it. */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Fast · recommended for scheduled ticks' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Latest Opus · deeper reasoning' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'Most capable' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'Previous generation' },
  { id: 'claude-opus-5', label: 'Opus 5', hint: 'Previous generation' },
  { id: 'claude-fable-5', label: 'Fable 5', hint: 'Previous generation' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', hint: 'Previous generation' }
]
/**
 * Models the ChatGPT-subscription (Codex) backend serves. Slugs are what the
 * Codex CLI sends (its bundled list: `codex-rs/models-manager/models.json` in
 * github.com/openai/codex); they are NOT the public API names and can change —
 * the runner surfaces an unsupported-model error verbatim so a drift is visible.
 *
 * GPT-5.5 is the default because it is the newest model Codex still drives with
 * plain function tools, which is what this app sends. Everything newer is marked
 * `tool_mode: code_mode_only` there — the Codex CLI hands those models a
 * code-execution tool instead of direct tools — so they are offered, but expect
 * the tool calling to be less polished than on 5.5.
 */
export const CHATGPT_MODELS: ModelOption[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5', hint: 'Recommended · direct tool calls' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', hint: 'Latest workhorse · tuned for Codex code mode' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', hint: 'Frontier · slowest, most capable' },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', hint: 'Fast and light' },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', hint: 'Previous workhorse' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', hint: 'Older workhorse' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', hint: 'Older · balanced' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', hint: 'Older · fast' }
]
/**
 * OpenRouter models offered in the picker — tool-capable models that run an
 * agent well. Any OpenRouter model id works (the picker also takes a custom id);
 * these are only the suggestions. The operator's own OpenRouter key pays for
 * every call.
 */
export const DEFAULT_OPENROUTER_MODEL_ID = 'z-ai/glm-5.3-flash'
export const OPENROUTER_MODELS: ModelOption[] = [
  { id: DEFAULT_OPENROUTER_MODEL_ID, label: 'GLM 5.3 Flash', hint: 'Fast and inexpensive · a good default for scheduled ticks' },
  { id: 'google/gemini-3.7-flash', label: 'Gemini 3.7 Flash', hint: 'Fast, long context' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', hint: 'Strong tool use · higher cost' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', hint: 'Strong reasoning · higher cost' }
]
/**
 * Tried in order after the agent's own model, by OpenRouter, on ITS side — sent
 * as the `models` array (the `model` field stays a single id). OpenRouter walks
 * the list ONCE, on provider downtime, rate limits, moderation refusals and
 * context-length errors; if the last entry errors, that error is what we get.
 *
 * Why a fallback at all: scheduled runs are unattended, so a provider outage at
 * 09:30 is a missed trading window nobody is present to retry. Only applied when
 * the agent runs on the default model — an operator who picked a specific model
 * gets that model or an error, never a silent substitute.
 *
 * ⚠️ A fallback run is a COLD CACHE: a different model shares no prompt-cache
 * shard, so a degraded primary costs more per tick than usual.
 */
export const OPENROUTER_FALLBACK_MODELS: readonly string[] = ['google/gemini-3.7-flash']
/** The OpenRouter model an agent runs: its stored id, or the default when none was stored. */
export const openRouterModelFor = (requested: string): string => requested.trim() || DEFAULT_OPENROUTER_MODEL_ID
/** The local vendor serves ONE model at a time — 'local' means "whatever is running". */
export const LOCAL_MODELS: ModelOption[] = [{ id: 'local', label: 'Active local model', hint: 'The model running on this GPU (Settings → Local models)' }]
export const DEFAULT_MODEL: ModelChoice = { vendor: 'claude', id: 'claude-sonnet-5-5', effort: 'medium' }
export const DEFAULT_CHATGPT_MODEL: ModelChoice = { vendor: 'chatgpt', id: 'gpt-5.5', effort: 'medium' }
export const DEFAULT_OPENROUTER_MODEL: ModelChoice = { vendor: 'openrouter', id: DEFAULT_OPENROUTER_MODEL_ID, effort: 'medium' }
export const DEFAULT_LOCAL_MODEL: ModelChoice = { vendor: 'local', id: 'local', effort: 'medium' }

export function defaultModelFor(vendor: ModelVendor): ModelChoice {
  return vendor === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : vendor === 'local' ? DEFAULT_LOCAL_MODEL : vendor === 'chatgpt' ? DEFAULT_CHATGPT_MODEL : DEFAULT_MODEL
}

/**
 * Why a retired agent takes no messages, and what to do instead.
 *
 * A `reply` used to be the one trigger that got through, on the reasoning that
 * talking to a retired agent about its record is a thing people do. The problem
 * is that a reply is not a comment — it wakes the agent and it RUNS, so the
 * exception quietly meant a retired agent could still think, call tools and,
 * with a live book, trade. "Retired" has to mean stopped, and reading the thread
 * back is unaffected: only sending is refused.
 *
 * Respawn is the way in, and it is deliberately an explicit act — it re-arms the
 * schedule and clears `retiredAt`, so the operator restarting an agent knows
 * they restarted it rather than discovering it from a fill.
 */
export const RETIRED_NO_MESSAGE = 'This agent is retired. Respawn it first to pick the conversation back up.'

/** Default capital handed to a new agent (USD). */
export const DEFAULT_ALLOCATION_USD = 10_000

/**
 * How many agents may be alive (not retired) at once on this computer — timers,
 * the 15-second price watcher and a local model process are all supervised by
 * one desktop. Retire or delete one to make room.
 */
export const MAX_ACTIVE_AGENTS = 10
/** Every non-retired agent — what `MAX_ACTIVE_AGENTS` bounds. */
export function countActiveAgents(list: readonly { state: { status: string } }[]): number {
  return list.filter((a) => a.state.status !== 'retired').length
}

/**
 * How many agents are trading in each book — the figures on the All / Paper /
 * Live tabs of the agent list. A retired agent is NOT counted: it holds nothing
 * and runs nothing, and it is listed under its own "Retired" fold.
 */
export function countByMode(list: readonly { config: Pick<AgentConfig, 'mode'>; state: { status: string } }[]): Record<Mode, number> {
  const out: Record<Mode, number> = { paper: 0, live: 0 }
  for (const a of list) if (a.state.status !== 'retired') out[a.config.mode] += 1
  return out
}

export function agentCapMessage(active: number): string {
  return `This computer already runs ${active} agents — the limit is ${MAX_ACTIVE_AGENTS}. Retire or delete one to add another.`
}

/**
 * Is there room for one more agent? `null` = go ahead, otherwise the sentence
 * the create path refuses with. One rule for the New-agent sheet, the IPC gate,
 * the sidebar's respawn button and the agent's own `propose_agent` tool, so
 * none of them can say a different thing.
 */
export function agentSlotBlocked(active: number): string | null {
  return active >= MAX_ACTIVE_AGENTS ? agentCapMessage(active) : null
}

/** The same rule, phrased as the `AgentCapacity` the runner's `propose_agent` tool reads. */
export function agentCapacity(active: number): AgentCapacity {
  const blocked = agentSlotBlocked(active)
  return blocked
    ? { ok: false, used: active, max: MAX_ACTIVE_AGENTS, reason: `this computer already runs ${active} agents, which is the maximum — one would have to be retired first` }
    : { ok: true, used: active, max: MAX_ACTIVE_AGENTS }
}

export const AGENT_ICONS = ['donut', 'cube', 'sphere', 'pyramid', 'helix', 'plasma', 'ripple', 'vortex', 'matrix', 'face', 'skull', 'heart', 'diamond', 'arrow', 'orb', 'sea', 'moire'] as const
export type AgentIcon = (typeof AGENT_ICONS)[number]
export const AGENT_COLORS = ['blue', 'green', 'violet', 'orange', 'pink', 'teal', 'slate'] as const
export type AgentColor = (typeof AGENT_COLORS)[number]

export interface AgentConfig {
  id: string
  name: string
  /**
   * The name is a PLACEHOLDER the operator did not choose, and the agent may
   * replace it once on its first run (`set_name`).
   *
   * A flag rather than sniffing the name for a sentinel: an operator is
   * perfectly entitled to call an agent "New agent", and a name-comparison
   * would then let the engine overwrite a deliberate choice. Absent means the
   * name is the operator's and is not ours to touch — which is also the right
   * answer for every agent made before this existed.
   *
   * Cleared the moment the agent names itself, so this is one-shot: an agent
   * cannot keep renaming itself run after run, and the operator renaming it
   * later is final.
   */
  nameAuto?: boolean
  /** Avatar: a Lucide icon key + a color token (see AGENT_ICONS / AGENT_COLORS). */
  icon: AgentIcon
  color: AgentColor
  /**
    * The agent's ORIGINAL goal — the sentence it was created with. Kept as its
    * own field because it is the agent's identity: list previews, the first
    * prompt line and every older client read it.
    */
  task: string
  /**
   * Everything this agent is standing instructed to do, oldest first. An agent
   * created before task lists existed has none, and `tasksOf()` derives the one
   * task it does have from `task` — so nothing needs migrating.
   *
   * Only the operator can add to this: the agent proposes (`propose_task`) and
   * the operator confirms, because a second task changes what the agent IS.
   */
  tasks?: AgentTask[]
  schedule: Schedule
  guardrails: Guardrails
  mode: Mode
  model: ModelChoice
  /** Total capital allocated to this agent (USD). Seeds the paper ledger AND the live sub-ledger budget. */
  allocationUsd: number
  /** ISO timestamp when the user explicitly armed live trading; null = not armed. */
  liveArmedAt: string | null
  /**
   * Fully autonomous: the agent buys, sells, sets exits and retires on its own.
   * Turn it OFF and every money-moving tool stops for the operator's word first —
   * the agent asks in the thread and waits, however long that takes.
   *
   * Absent on agents made before this existed, and `isAutonomous()` reads those
   * as autonomous, which is how they have always behaved.
   *
   * This governs the agent ACTING. It never governs the agent changing what it
   * IS: tasks, plans and spin-offs are confirmed either way.
   */
  autonomous?: boolean
  /**
   * A special operating mode whose rules the ENGINE enforces (size, timing,
   * exits, the settlement wait) rather than the task sentence. Absent = an
   * ordinary agent. `'earningsPop'` = the all-in earnings mode
   * (`shared/earningsPlaybook.ts`).
   */
  playbook?: Playbook
  /** Self-retirement conditions; null = runs until stopped. */
  retirement: RetirementPolicy | null
  createdAt: string
  updatedAt: string
}

export interface Position {
  symbol: string
  qty: number
  avgCost: number
}

export interface Fill {
  id: string
  ts: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  /** Realized P&L for sells (0 for buys). */
  realized: number
  orderId?: string
  // ── Stamped at execution for the track record and the post-mortem. All
  // optional; fills from before carry none.
  /** Buys: the trail attached to this entry, as %. */
  trailPct?: number
  /** Buys: % above (+) / below (−) VWAP at the fill, when the run had technicals. */
  extensionPct?: number
  /** The order's reason, shortened — the entry thesis on a buy, the exit reason on a sell. */
  reason?: string
  /** Sells the ENGINE made: which exit fired. */
  engineExit?: ExitTrigger['kind']
  /**
   * The run whose decision placed this order. Absent on engine
   * fills (stops, targets, sweeps) and on everything before this. What lets a
   * sell's realized P&L be scored against the runs that OPENED the position
   * (`core/trace/outcomes.ts`) — the ground truth for judging decisions.
   */
  runId?: string
}

/** One closed lot: a buy matched FIFO against a later sell of the same symbol. */
export interface RoundTrip {
  symbol: string
  qty: number
  entryTs: string
  exitTs: string
  entryPrice: number
  exitPrice: number
  pnl: number
  holdMin: number
  trailPct?: number
  extensionPct?: number
  engineExit?: ExitTrigger['kind']
  entryReason?: string
  exitReason?: string
}

/**
 * Fills → closed round trips, FIFO per symbol. The ledger keeps an averaged
 * position, not lots, so this is the one place lots are reconstructed — and it
 * is deliberately pure over `fills` alone so any surface can draw the same table.
 */
export function roundTrips(fills: readonly Fill[]): RoundTrip[] {
  const open = new Map<string, { qty: number; price: number; ts: string; trailPct?: number; extensionPct?: number; reason?: string }[]>()
  const out: RoundTrip[] = []
  for (const f of fills) {
    const lots = open.get(f.symbol) ?? []
    if (f.side === 'buy') {
      lots.push({ qty: f.qty, price: f.price, ts: f.ts, trailPct: f.trailPct, extensionPct: f.extensionPct, reason: f.reason })
      open.set(f.symbol, lots)
      continue
    }
    let left = f.qty
    while (left > 1e-9 && lots.length) {
      const lot = lots[0]
      const q = Math.min(left, lot.qty)
      out.push({
        symbol: f.symbol,
        qty: q,
        entryTs: lot.ts,
        exitTs: f.ts,
        entryPrice: lot.price,
        exitPrice: f.price,
        pnl: Math.round((f.price - lot.price) * q * 100) / 100,
        holdMin: Math.max(0, Math.round((Date.parse(f.ts) - Date.parse(lot.ts)) / 60_000)),
        trailPct: lot.trailPct,
        extensionPct: lot.extensionPct,
        engineExit: f.engineExit,
        entryReason: lot.reason,
        exitReason: f.reason
      })
      lot.qty -= q
      left -= q
      if (lot.qty <= 1e-9) lots.shift()
    }
    open.set(f.symbol, lots)
  }
  return out
}

/** One row of the track-record table: a bucket, how many trips landed in it, and how they did. */
export interface RecordRow {
  dimension: 'entry time' | 'hold' | 'trail' | 'extension'
  label: string
  n: number
  winRate: number
  avgPnl: number
  netPnl: number
}

/** ET minutes → the entry-time bucket results are split by. */
export function entryBucket(etMinutes: number): string {
  if (etMinutes < 9 * 60 + 45) return 'pre-09:45'
  if (etMinutes < 11 * 60) return '09:45–11:00'
  if (etMinutes < 15 * 60) return 'midday'
  return 'last hour'
}

/**
 * Win rate and average P&L per bucket, four ways. `etMinutesOf`
 * comes from the caller (shared/marketTime.ts) so this file stays free of
 * clock code. Rows with no trips are omitted.
 */
export function trackRecordBuckets(trips: readonly RoundTrip[], etMinutesOf: (iso: string) => number): RecordRow[] {
  const groups = new Map<string, { dimension: RecordRow['dimension']; label: string; trips: RoundTrip[] }>()
  const add = (dimension: RecordRow['dimension'], label: string, t: RoundTrip): void => {
    const key = `${dimension}|${label}`
    const g = groups.get(key) ?? { dimension, label, trips: [] }
    g.trips.push(t)
    groups.set(key, g)
  }
  for (const t of trips) {
    add('entry time', entryBucket(etMinutesOf(t.entryTs)), t)
    add('hold', t.holdMin < 15 ? '<15 min' : t.holdMin < 60 ? '15–60 min' : t.holdMin < 240 ? '1–4 h' : 'over 4 h / overnight', t)
    add('trail', t.trailPct === undefined ? 'no trail' : t.trailPct < 1.5 ? 'trail <1.5%' : t.trailPct < 3 ? 'trail 1.5–3%' : 'trail ≥3%', t)
    if (t.extensionPct !== undefined) add('extension', t.extensionPct < 0 ? 'below VWAP' : t.extensionPct <= 1 ? '0–1% above VWAP' : '>1% above VWAP', t)
  }
  return [...groups.values()].map((g) => {
    const wins = g.trips.filter((t) => t.pnl > 0).length
    const net = g.trips.reduce((s, t) => s + t.pnl, 0)
    return { dimension: g.dimension, label: g.label, n: g.trips.length, winRate: Math.round((wins / g.trips.length) * 100), avgPnl: Math.round((net / g.trips.length) * 100) / 100, netPnl: Math.round(net * 100) / 100 }
  })
}

/** The table as text, one line per row, grouped by dimension — the prompt's rendering; a UI can use the rows directly. */
export function renderTrackRecordRows(rows: readonly RecordRow[]): string[] {
  const dims: RecordRow['dimension'][] = ['entry time', 'hold', 'trail', 'extension']
  const lines: string[] = []
  for (const d of dims) {
    const rs = rows.filter((r) => r.dimension === d)
    if (!rs.length) continue
    lines.push(`- by ${d}: ${rs.map((r) => `${r.label} ${r.n}× ${r.winRate}% win, avg ${r.avgPnl < 0 ? '-' : '+'}$${Math.abs(r.avgPnl).toFixed(2)}`).join(' · ')}`)
  }
  return lines
}

export interface PaperOrder extends ExitSpec {
  id: string
  ts: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  type: 'market' | 'limit'
  limitPrice?: number
  /**
   * Carried so the settle sweep can honour it: every card already printed
   * "day" or "gtc", but the ledger never stored it, so a resting day order
   * survived forever — a promise the paper broker printed and ignored. Absent
   * (orders from before this) reads as 'day', which is what every such card
   * said.
   */
  tif?: 'day' | 'gtc'
  status: 'open' | 'filled' | 'cancelled'
  /**
   * Exits to arm when this order actually FILLS. A resting buy's protection has
   * to survive the wait: attaching a stop to an order that does not fill at once
   * used to drop it entirely, so the order that most needed a stop — the one
   * left working overnight — was the one that silently had none.
   *
   * Carried on the order rather than in `state.exits` because until there is a
   * position there is nothing to protect; the settle paths arm them on the fill.
   * Lives inside the agent's saved state, so no migration.
   */
  stopLoss?: number
  takeProfit?: number
  /**
   * A trailing stop attached to the order, as a percent. Carried here for the
   * same reason as the other two, and the omission would have been worse: a
   * trail dropped on a resting buy is #2 reintroduced by the very feature meant
   * to close overnight risk, and it bites hardest on the case that motivated it
   * — "buy at 15:58 with a 3% trail" is a limit that rests, fills at the open,
   * and would have arrived at a live position with no trail at all.
   *
   * The engine seeds `ExitPlan.trail.high` from the FILL price, not from
   * whatever quote the next sweep happens to see: a position that dropped right
   * after filling would otherwise trail from the drop, which is protection
   * measured from the wrong place and looser than was asked for.
   */
  trailPct?: number
}

/** The agent's own book — paper ledger or live sub-ledger (same shape). */
export interface Ledger {
  cash: number
  positions: Position[]
  fills: Fill[]
  openOrders: PaperOrder[]
  realizedPnl: number
  /**
   * Sale proceeds inside `cash` that have not settled yet (T+1). Appended by
   * every sell in `applyFill`, pruned there as lots mature; read by
   * `settledCash` (`shared/settlement.ts`). Optional so a book written before
   * settlement was tracked still parses — absent reads as "nothing unsettled".
   */
  unsettled?: UnsettledLot[]
}

/** The single paper/live book selector — the app's most safety-critical branch. */
export function ledgerFor(cfg: Pick<AgentConfig, 'mode'>, state: Pick<AgentState, 'paper' | 'live'>): Ledger {
  return cfg.mode === 'live' ? state.live : state.paper
}

/** USD formatter shared by prompts and UI so the model and operator see the same numbers. */
export function money(n: number | undefined | null, dp = 2): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '\u2014'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}

/** Conversation-list ordering (last activity, newest first) — one comparator for all clients. */
export function compareAgentSummaries(a: AgentSummary, b: AgentSummary): number {
  return (b.state.lastMessageAt ?? b.config.createdAt).localeCompare(a.state.lastMessageAt ?? a.config.createdAt)
}

/** Watch-fired thread-message prefix — matched by OS notifications; keep in sync everywhere. */
export const WATCH_FIRED_PREFIX = '\u23f1 Price watch fired: '

export function emptyLedger(cash: number): Ledger {
  return { cash, positions: [], fills: [], openOrders: [], realizedPnl: 0 }
}

/** A run's closing book, small enough to sit on every run row. See `RunRecord.book`. */
export interface RunBookSummary {
  mode: Mode
  cash: number
  realizedPnl: number
  positions: number
  fills: number
  openOrders: number
  /** Cash + positions marked at the run's quotes (cost basis for unquoted symbols) — the paperPortfolio() convention. */
  equity: number
  /** True when every held symbol had a live quote; false means `equity` partly carries cost basis. */
  marked: boolean
}

/**
 * Summarize a ledger as a run leaves it. Pure and cheap on purpose: it runs at
 * every run settle, and the UI renders the result without recomputing.
 */
export function runBookSummary(mode: Mode, ledger: Ledger, quotes: Record<string, number>): RunBookSummary {
  let value = 0
  let marked = true
  for (const p of ledger.positions) {
    const q = quotes[p.symbol]
    if (q && q > 0) value += p.qty * q
    else {
      value += p.qty * p.avgCost
      marked = false
    }
  }
  const r2 = (n: number): number => Math.round(n * 100) / 100
  return {
    mode,
    cash: r2(ledger.cash),
    realizedPnl: r2(ledger.realizedPnl),
    positions: ledger.positions.length,
    fills: ledger.fills.length,
    openOrders: ledger.openOrders.length,
    equity: r2(ledger.cash + value),
    marked
  }
}

/**
 * Where a self-planning agent got to.
 *
 * `manual` means two different things, and the difference matters to whoever is
 * looking at the settings sheet: either the operator chose it, or the agent was
 * asked to choose and never managed to. Derived rather than stored, so there is
 * no flag to clear and no way for the two to drift:
 *
 *   planning  - asked to plan, has not run yet. "Manual" on screen is a
 *               placeholder, not a decision.
 *   unplanned - asked to plan, HAS run, and still has no schedule. The setup run
 *               finished without one (it crashed, or the model never called
 *               change_plan). This is the state that used to be invisible.
 *   ready     - it has a schedule, or the operator picked manual themselves.
 */
export type SetupState = 'planning' | 'unplanned' | 'ready'

/**
 * Symbols an agent needs a live price for: what it holds, plus what it traded
 * recently.
 *
 * The fills matter as much as the positions — a symbol bought AND sold today is
 * flat by close of business but still needs a previous close for today's P&L,
 * and dropping it makes the day's number silently wrong rather than absent.
 *
 * Retired agents are skipped: they hold nothing that is still moving.
 */
export function symbolsToMark(agents: { config: AgentConfig; state: AgentState }[], recentFills = 40): string[] {
  const set = new Set<string>()
  for (const a of agents) {
    if (a.state.status === 'retired') continue
    const ledger = ledgerFor(a.config, a.state)
    for (const p of ledger.positions) set.add(p.symbol)
    for (const f of ledger.fills.slice(-recentFills)) set.add(f.symbol)
  }
  return [...set]
}

export function setupState(cfg: Pick<AgentConfig, 'schedule'>, state: Pick<AgentState, 'awaitingPlan' | 'runCount'>): SetupState {
  if (!state.awaitingPlan || cfg.schedule.kind !== 'manual') return 'ready'
  return state.runCount > 0 ? 'unplanned' : 'planning'
}


export interface AgentState {
  /**
   * Created asking the model to choose its own schedule, and that setup run has
   * not yet produced one.
   *
   * Exists because `{ kind: 'manual' }` is BOTH the default and a legitimate
   * choice, so an agent whose setup run died looks exactly like one the operator
   * deliberately set to manual - a state that reads as a decision and is
   * actually a failure nobody recorded.
   *
   * Settled where every schedule change flows through — `Engine.update` and the
   * runner's own `change_plan` — so a schedule chosen by the agent OR by the
   * operator answers it. Read through `setupState()`, never directly.
   */
  awaitingPlan?: boolean
  status: AgentStatus
  nextRunAt: string | null
  lastRunAt: string | null
  lastError: string | null
  runCount: number
  /** Orders placed today (ET date) for the maxOrdersPerDay guardrail. */
  ordersToday: { date: string; count: number }
  /** Paper-mode book. */
  paper: Ledger
  /** Live-mode sub-ledger: ONLY this agent's own fills, never the whole account. */
  live: Ledger
  /**
   * The one write this agent is waiting on approval for. While it is set the
   * agent is STALLED — autonomous wake-ups do nothing — because whatever it
   * meant to do next follows from an answer it has not had yet.
   */
  pendingAction?: PendingAction | null
  /** Agent's own persistent notes (short lines, capped). */
  memory: string[]
  /**
   * One-time things the agent deferred because it could not do them yet — "set
   * the 5% watch when the market opens". A memory note is a durable FACT and
   * stays forever; an errand is a debt and must clear itself, or it is re-read
   * as a fresh instruction every run and done again (and again).
   *
   * The engine surfaces these when their moment arrives and drops them once
   * they are settled or stale; the agent settles one with `errand_done`.
   */
  errands?: Errand[]
  /**
   * Asleep until a dated moment the agent looked up ("Apple reports on the
   * 30th"). While set and in the future it IS the next wake-up — `armedState`
   * prefers it over the schedule's next tick — and the schedule resumes
   * untouched afterwards. Messages, price watches and question deadlines still
   * wake it; a run they start leaves the sleep in place. Cleared by the run that
   * arrives at or after `until`, or by `sleep_until` with `cancel`. Absent on
   * every agent made before this, which means simply "awake".
   */
  sleep?: AgentSleep
  /** Engine-enforced exits per held symbol. */
  exits: Record<string, ExitPlan>
  /** Registered price watches (fire -> system message + wake-up). */
  watches: PriceWatch[]
  /** Per-symbol standing theses ("MU: overnight gap-up pattern into earnings"). */
  theses: Record<string, string>
  unread: number
  lastMessageAt: string | null
  lastMessagePreview: string
  /** Resumable SDK session id (prompt-cache reuse); rotated before overflow. */
  sessionId: string | null
  /**
   * The model VENDOR that ran the previous run, so the next one can be told
   * that the reasoning above it came from somewhere else. Written at end-of-run.
   *
   * Vendor, NOT provider: a change of model id within one vendor keeps the
   * same family of reasoning, and telling the agent otherwise would be a lie
   * inside the one block whose entire job is saying what to trust.
   * `check-model-switch.ts` pins when it fires.
   *
   * Optional, and absent means DO NOT FIRE — never "assume a change". Every
   * agent created before this has no value, and a first run has nothing prior.
   */
  lastRunVendor?: ModelVendor
  /** Last full run's quotes (symbol -> last) — the triage gate's baseline. */
  lastRunQuotes: Record<string, number>
  /** Start-of-ET-day equity snapshot for the daily loss limit. */
  dayAnchor: { date: string; equity: number } | null
  /**
   * Engine exits (fill ids) whose post-mortem the model has already read
   *. The post-mortem used to cover "exits since the last run" and
   * was consumed by the run the sale itself woke — thirty seconds later, with
   * no bars to say what the price did next; 13 of 18 exits in the review were
   * never post-mortemed. An exit is now shown once it has a quarter-hour of
   * tape behind it (or the session closed on it) and remembered here so it is
   * shown exactly once. Absent = none.
   */
  postMortemSeen?: string[]
  /** ET date on which buying is locked (daily loss limit breached). */
  buyLockDate: string | null
  /**
   * A daily-loss lock set BETWEEN runs (by a price sweep) that the thread has
   * not been told about yet. `runOnce` consumes it at run start: posts the note,
   * marks the tick busy for the fast path, clears it. Without this a lock the
   * sweep wrote landed silently — the run-start check saw `buyLockDate` already
   * set for today and said nothing.
   */
  buyLockNotice?: { date: string; lossPct: number } | null
  /**
   * When a retirement's flatten was last refused (market closed, no quote, a
   * guardrail). `shared/retirement.ts` turns it into the retry instant both
   * hosts wait for; absent or null means no refusal is outstanding.
   */
  flattenRefusedAt?: string | null
  /** Check-ins the agent initiated today on UNATTENDED runs (ET date) — the ask/tell budget. */
  checkIns: { date: string; questions: number; tells: number }
  retiredAt: string | null
  retireReason: string | null
  /**
   * Set when the operator brings a retired agent back; cleared by the first
   * run that completes. While set, the run prompt carries `respawnBlock()` and
   * `change_plan` may auto-apply (still never loosening guardrails): a
   * respawned agent's standing orders were written for an engagement that
   * already ENDED, so its first job is to revise them for today and tell the
   * operator what changed. Without it, respawned agents improvise — one
   * stalls on ask_operator over a deadline it could simply roll forward.
   */
  respawnedAt?: string | null
  /** True while a run is in flight (UI indicator). */
  running: boolean
  /**
   * When the run in flight began (ISO). With `running`, it is what makes a
   * message QUEUED: an operator message stamped after this instant was sent to
   * an agent already mid-run, so nothing is answering it yet — the reply run
   * behind it will (shared/messageQueue.ts). Kept after the run ends (it is
   * "when the last run started"); `running` is the discriminator. Absent on
   * agents that have not run since this field existed.
   */
  runStartedAt?: string | null
  /** The id of the run in flight (with `runStartedAt`); what a message sent mid-run records as `queuedBehind`. */
  runId?: string | null
}

export function initialState(cfg: Pick<AgentConfig, 'allocationUsd'>): AgentState {
  return {
    status: 'idle',
    nextRunAt: null,
    lastRunAt: null,
    lastError: null,
    runCount: 0,
    ordersToday: { date: '', count: 0 },
    paper: emptyLedger(cfg.allocationUsd),
    live: emptyLedger(cfg.allocationUsd),
    memory: [],
    errands: [],
    exits: {},
    watches: [],
    theses: {},
    sessionId: null,
    lastRunQuotes: {},
    dayAnchor: null,
    buyLockDate: null,
    checkIns: { date: '', questions: 0, tells: 0 },
    retiredAt: null,
    retireReason: null,
    unread: 0,
    lastMessageAt: null,
    lastMessagePreview: '',
    running: false
  }
}

export interface ToolCallSummary {
  name: string
  /** Short rendering of the input (truncated). Kept for clients that predate `args`. */
  input: string
  /** Short rendering of the result (truncated). Kept for clients that predate `result`. */
  output?: string
  /**
   * The call in full. Until now the thread kept 200 characters of
   * the input and 300 of the output — the wire, cut mid-word — so an operator
   * asking "what did it actually see?" had nowhere to look. `args` is what the
   * tool RECEIVED after the gate (the object itself, or its JSON cut to size
   * when oversized); `result` is the whole text the model read, secrets
   * redacted, capped per call and per run (core/runner/vendors/shared.ts);
   * `truncated` says a cap bit. Display only — nothing here goes back to the
   * model. Every field is optional so rows written before this, and clients
   * that only know `input`/`output`, keep working unchanged.
   */
  args?: unknown
  result?: string
  truncated?: boolean
  /** ISO instant the call began; `durationMs` once its result landed. */
  startedAt?: string
  durationMs?: number
  /** The gate refused it: the sentence the model was given instead of a result. */
  blocked?: string
  /** The tool failed — threw, or answered with an error result. */
  error?: boolean
}

/**
 * How often the engine checks exit plans BETWEEN runs, in ms. `null` means
 * nothing sweeps them and a stop is only evaluated when the agent itself runs.
 *
 * This exists so the SYSTEM PROMPT CANNOT OUTLIVE THE CODE. `exitsLine()` in
 * core/runner/prompts.ts derives what it promises an agent from this number
 * instead of hard-coding a cadence, and the desktop watcher takes its timer
 * from the same constant. A prompt claiming protection the engine does not
 * provide is exactly the failure to avoid — so changing how often exits are
 * enforced forces the sentence to change with it.
 */
export const DESKTOP_EXIT_WATCH_MS: number | null = 15_000

/** The cadence as the prompt says it out loud; null when nothing is sweeping. */
export function exitCadenceLabel(ms: number | null): string | null {
  if (ms === null || !(ms > 0)) return null
  if (ms < 60_000) return `every ~${Math.round(ms / 1000)}s`
  if (ms === 60_000) return 'every minute'
  return `every ~${Math.round(ms / 60_000)} min`
}

/**
 * What a stop actually promises, in one sentence, for any surface that shows
 * one — the agent's prompt and the stats sheet. Shared so two copies of a
 * sentence about engine behaviour cannot drift apart.
 */
export function exitEnforcementNote(): string {
  const cadence = exitCadenceLabel(DESKTOP_EXIT_WATCH_MS)
  const checked = cadence ? `checked ${cadence} while the market is open` : 'checked only when this agent runs'
  return `Stops and targets are market sells, ${checked} — nothing fires overnight, at a weekend, or through the gap at the open. A trail follows the highest price seen at that cadence, not the true high.`
}

/** Engine-enforced exit plan for a held symbol. */
export interface ExitPlan {
  stop?: number
  target?: number
  /**
   * Trailing stop: sell when the price falls `pct` from its high. The effective
   * stop is `high × (1 − pct/100)`, and where a fixed `stop` is also set the
   * engine takes the TIGHTER of the two — a trail must never cancel a floor the
   * operator asked for ("3% off the high" does not mean "and forget the $90").
   *
   * `high` is engine state, ratcheted in `enforceExits`, and the model can
   * never set it: given the chance it could name a high and place the stop
   * wherever it liked. It is the highest price the ENGINE HAS SEEN since the
   * trail was set — not the true intraday high, because it only moves when the
   * exit sweep runs. The prompt says so in the same breath as offering it.
   */
  trail?: { pct: number; high: number }
  /**
   * Who will actually sell this. `broker` means a resting order at Robinhood
   * owns the exit, and the engine must NOT also enforce it — a dip through both
   * sells twice, and the second sale is a naked short in an account that cannot
   * short. Absent = `engine`, so every plan written before this keeps behaving
   * exactly as it did.
   *
   * LOAD-BEARING ORDERING, found by probing the reconcile path rather than
   * reading it: `enforceExits` must clear a DEAD position's exit before it skips
   * a broker-owned symbol. Today a stale plan is cleaned up only by
   * `enforceExits` noticing the position is gone; skip first and the exit leaks
   * forever, so the agent believes it is protected on something it no longer
   * holds and a later `set_exit` collides with a plan nobody can see.
   */
  enforcedBy?: 'engine' | 'broker'
  /**
   * The resting order's id, so a fill can be attributed and — the part that
   * matters — so it can be CANCELLED. A broker stop that outlives its position
   * is a resting sell for shares we do not hold; if it fills, that is the naked
   * short, arriving days later with nobody watching. Cancellation is not
   * cleanup here, it is the safety property: any path that takes a position to
   * zero must cancel this first.
   */
  brokerOrderId?: string
  /**
   * Flatten time, ET "HH:MM": at or after this minute of the regular session the
   * engine market-sells the WHOLE position, whatever the price is doing.
   * Day-trade agents carrying intraday trails into the close eat the overnight
   * gap the trail can never see;
   * "flat by close" is now a level the sweep enforces, not a sentence the
   * model has to remember at 15:55. Absent = hold (the old behaviour).
   */
  flattenAt?: string
  /**
   * Opening-range grace, in minutes after 09:30 ET: the TRAIL is not judged
   * until this long into the session (it still ratchets, and the hard stop,
   * target and invalidation levels still fire). 0 or absent = the trail is
   * live from the first sweep, exactly as before.
   */
  armAfterMin?: number
  /**
   * Invalidation levels — "cut it if it loses $X" as a level the engine
   * enforces like a hard stop, but reported with the agent's own reason so
   * the card says WHY rather than "stop hit". `below` is the long-side case;
   * `above` is the symmetric one (a level whose breach means the thesis is
   * wrong in the other direction). Replaces the watch → run → sell pattern,
   * which cost a wake-up and a model call to do what a stop does in code.
   */
  stopIf?: { below?: number; above?: number; reason: string }
  /**
   * Break-even ratchet: once the position is up this many % from its average
   * cost, the engine moves `stop` up to that cost (never down). One-way, like
   * the trail's high.
   */
  breakEvenAfterPct?: number
  /**
   * Fraction of the position (1–100) the TARGET sells. Absent = 100, the old
   * behaviour. A partial target clears itself once it fires and the remainder
   * keeps every other level of the plan.
   */
  targetPct?: number
  setAt: string
}

/**
 * The exit levels a BUY can carry — one shape for the tool argument, the resting
 * order and the stored plan's inputs, so a level that exists on one of them
 * cannot be silently dropped by another (the trail was, once: attached to a
 * resting buy and lost when it filled). `armExitPlan` turns one into a plan.
 */
export interface ExitSpec {
  /** Engine-enforced protective stop for the resulting position (buys). */
  stopLoss?: number
  /** Engine-enforced profit target for the resulting position (buys). */
  takeProfit?: number
  /**
   * Engine-enforced TRAILING stop, as a % from the high (buys). The engine
   * seeds the high from the fill price — the model never supplies it.
   */
  trailPct?: number
  /** ET "HH:MM": market-sell everything at/after this minute (see ExitPlan.flattenAt). */
  flattenAt?: string
  /** Minutes after the open before the trail is judged (see ExitPlan.armAfterMin). */
  armAfterMin?: number
  /** Invalidation levels with the reason (see ExitPlan.stopIf). */
  stopIf?: { below?: number; above?: number; reason: string }
  /** Move the stop to entry once up this many % (see ExitPlan.breakEvenAfterPct). */
  breakEvenAfterPct?: number
  /** The target sells this % of the position (see ExitPlan.targetPct). */
  targetPct?: number
}

export const EXIT_SPEC_KEYS: readonly (keyof ExitSpec)[] = ['stopLoss', 'takeProfit', 'trailPct', 'flattenAt', 'armAfterMin', 'stopIf', 'breakEvenAfterPct', 'targetPct']

/** Does this carry ANY exit level? The bookkeeping paths key on it. */
export const hasExitSpec = (x: ExitSpec): boolean => EXIT_SPEC_KEYS.some((k) => x[k] !== undefined)

/** Just the exit fields of a larger object (a TradeIntent, a PaperOrder). */
export function exitSpecOf(x: ExitSpec): ExitSpec {
  const out: ExitSpec = {}
  for (const k of EXIT_SPEC_KEYS) if (x[k] !== undefined) (out as Record<string, unknown>)[k] = x[k]
  return out
}

/**
 * What a BUY's exit spec does to the plan already on the position — the ONE
 * merge rule, used by the immediate-fill path and the resting-fill path alike.
 *
 * MERGE, never replace: a level the spec does not mention is a level it is not
 * asking to change. And a trail on an ADD re-seeds its high at
 * `max(previous high, fill)`, never at the fill alone: an add on a dip used to
 * reset the high to the lower fill, which moved an already-armed stop DOWN
 * and loosened the protection on the shares bought earlier. The high is a ratchet; a fill can raise it, not lower it.
 *
 * Returns the plan and, when the buy moved the EFFECTIVE stop of a plan that
 * already existed, the old and new levels so the host can say so out loud.
 */
export function armExitPlan(prev: ExitPlan | undefined, spec: ExitSpec, fillPrice: number | undefined, nowIso: string): { plan: ExitPlan; stopMoved?: { from: number | undefined; to: number | undefined } } {
  const seed = fillPrice !== undefined && fillPrice > 0 ? fillPrice : 0
  const trail = spec.trailPct !== undefined ? { pct: spec.trailPct, high: Math.max(prev?.trail?.high ?? 0, seed) } : prev?.trail
  const plan: ExitPlan = {
    ...prev,
    stop: spec.stopLoss ?? prev?.stop,
    target: spec.takeProfit ?? prev?.target,
    trail,
    ...(spec.flattenAt !== undefined ? { flattenAt: spec.flattenAt } : {}),
    ...(spec.armAfterMin !== undefined ? { armAfterMin: spec.armAfterMin } : {}),
    ...(spec.stopIf !== undefined ? { stopIf: spec.stopIf } : {}),
    ...(spec.breakEvenAfterPct !== undefined ? { breakEvenAfterPct: spec.breakEvenAfterPct } : {}),
    ...(spec.targetPct !== undefined ? { targetPct: spec.targetPct } : {}),
    setAt: nowIso
  }
  if (!prev) return { plan }
  const from = effectiveStop(prev)
  const to = effectiveStop(plan)
  return from === to ? { plan } : { plan, stopMoved: { from, to } }
}

/**
 * How an exit plan reads, in one place, for every surface that shows one.
 *
 * There were four copies of this and they had already drifted: two knew about
 * `trail` and two did not, so a buy carrying only a trailing stop rendered on
 * the approval card as "no stop" — the card asserting the opposite of what the
 * order did, on the one screen where the operator's judgement IS the safety
 * mechanism. Callers pass whichever shape they hold; `trailPct` is what a tool
 * argument carries, `trail` what a stored plan carries.
 */
export function describeExitPlan(p: { stop?: number; target?: number; trail?: { pct: number; high: number }; trailPct?: number; flattenAt?: string; armAfterMin?: number; stopIf?: { below?: number; above?: number; reason: string }; breakEvenAfterPct?: number; targetPct?: number }): string {
  const pct = p.trail?.pct ?? p.trailPct
  const partial = p.targetPct !== undefined && p.targetPct < 100 ? ` (sell ${p.targetPct}%)` : ''
  return [
    p.stop !== undefined ? `stop ${money(p.stop)}` : '',
    pct !== undefined ? `trailing ${pct}%${p.trail ? ` from a high of ${money(p.trail.high)}` : ''}${p.armAfterMin ? `, live ${p.armAfterMin} min after the open` : ''}` : '',
    p.target !== undefined ? `target ${money(p.target)}${partial}` : '',
    p.stopIf?.below !== undefined ? `cut below ${money(p.stopIf.below)} (${p.stopIf.reason})` : '',
    p.stopIf?.above !== undefined ? `cut above ${money(p.stopIf.above)} (${p.stopIf.reason})` : '',
    p.breakEvenAfterPct !== undefined ? `stop to break-even once up ${p.breakEvenAfterPct}%` : '',
    p.flattenAt ? `flatten at ${p.flattenAt} ET` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The stop a plan is actually enforcing right now: the TIGHTEST of the fixed
 * stop, the trailing stop and the invalidation level below. Whichever is
 * highest is the one the sweep hits first, so it is the one to show.
 */
export function effectiveStop(plan: ExitPlan): number | undefined {
  const trailing = plan.trail && plan.trail.high > 0 ? plan.trail.high * (1 - plan.trail.pct / 100) : undefined
  const levels = [plan.stop, trailing, plan.stopIf?.below].filter((n): n is number => typeof n === 'number' && n > 0)
  return levels.length ? Math.max(...levels) : undefined
}

/**
 * A trail narrower than the name's ordinary daily swing is not a trail, it is a
 * coin flip: a 1–1.5% trail in a name that moves 3–4% on a normal day is
 * stopped out by noise, and the agent re-enters higher. The floor
 * is a fraction of the average daily range; below it the tool ANSWERS with the
 * numbers and asks for a wider trail or an explicit `acknowledgeTight` — it
 * never refuses, because the operator may genuinely want it.
 */
export const TRAIL_FLOOR_FACTOR = 0.75

/** The narrowest trail the floor allows for a name with this average daily range (%). */
export const trailFloorPct = (dailyRangePct: number): number => Math.round(dailyRangePct * TRAIL_FLOOR_FACTOR * 100) / 100

/** Null when the trail is wide enough (or the range is unknown); else the advisory the model reads. */
export function trailTooTight(symbol: string, trailPct: number | undefined, dailyRangePct: number | null | undefined): string | null {
  if (trailPct === undefined || !(dailyRangePct && dailyRangePct > 0)) return null
  const floor = trailFloorPct(dailyRangePct)
  if (trailPct >= floor) return null
  return `NOT PLACED (trail too tight): a ${trailPct}% trail on ${symbol} is inside its ordinary daily swing — ${symbol} moves ${dailyRangePct.toFixed(2)}% on an average day, so anything under ${floor}% (${TRAIL_FLOOR_FACTOR}× the range) is likely to be stopped out by noise rather than by a real reversal. Widen trailPct to at least ${floor}%, or if you and the operator genuinely want it this tight, call again with acknowledgeTight: true and say so in the reason.`
}

/**
 * The sell-side twin of the trail floor. A model-initiated SELL at a loss
 * smaller than the name's trail floor, while an engine stop already sits below
 * the price, is answered with the numbers rather than placed: a cut inside the
 * name's ordinary daily swing, above an armed stop that is never touched that
 * day, is a loss the stop would not have taken. Advisory, once, `acknowledgeTight` lets it
 * through. Null when the sell is not such a cut: a profit, a loss past the
 * floor, no stop armed below the price, or no range computed.
 */
export function cutInsideRange(symbol: string, avgCost: number, last: number, dailyRangePct: number | null | undefined, stop: number | undefined): string | null {
  if (!(avgCost > 0) || !(last > 0) || !(dailyRangePct && dailyRangePct > 0)) return null
  if (stop === undefined || !(stop > 0) || stop >= last) return null
  const lossPct = ((avgCost - last) / avgCost) * 100
  if (lossPct <= 0) return null
  const floor = trailFloorPct(dailyRangePct)
  if (lossPct >= floor) return null
  const stopPct = ((avgCost - stop) / avgCost) * 100
  return `NOT PLACED (cut inside the noise): ${symbol} is ${lossPct.toFixed(2)}% under your cost — inside its ordinary daily swing (${symbol} moves ${dailyRangePct.toFixed(2)}% on an average day; under ${floor}% is noise, not a reversal) — and your stop at $${stop.toFixed(2)} already bounds the downside at −${stopPct.toFixed(2)}%. Cuts like this are a reliable way to lose: hold and let the stop do its job. If the THESIS is broken rather than the price, call again with acknowledgeTight: true and say what changed.`
}

/** ET minute (since midnight) from which an intraday exit still held counts as overnight exposure. */
export const OVERNIGHT_WARN_MINUTES = 15 * 60 + 50

/**
 * Positions whose engine exits will NOT be judged again before the next
 * session. Pure over the plan and the clock so the prompt and the stats sheet
 * draw the same line at 15:50 ET.
 */
export function overnightExposure(exits: Record<string, ExitPlan>, positions: readonly Position[], etMinutes: number): string[] {
  if (etMinutes < OVERNIGHT_WARN_MINUTES) return []
  const held = new Set(positions.map((p) => p.symbol))
  return Object.entries(exits)
    .filter(([sym, p]) => held.has(sym) && p.enforcedBy !== 'broker' && (p.stop !== undefined || p.trail !== undefined || p.stopIf !== undefined))
    .map(([sym]) => sym)
}

/**
 * Whether a plan's flatten minute is due at `clock`. The minute names the FIRST
 * occurrence after the plan was set: a plan armed today at or after its own
 * minute means tomorrow's: a 15:58 buy with `flattenAt` "09:31" (out at the
 * next open) must not be sold by the 15:59 sweep just because
 * `clock.minutes >= at` is true the moment the plan exists. A
 * plan whose `setAt` cannot be read keeps the old reading: due once the minute
 * has passed today.
 */
export function flattenDue(plan: Pick<ExitPlan, 'flattenAt' | 'setAt'>, clock: Pick<EtClock, 'date' | 'minutes'>): boolean {
  if (!plan.flattenAt) return false
  const at = parseHHMM(plan.flattenAt)
  if (at === null || clock.minutes < at) return false
  const setMs = Date.parse(plan.setAt)
  if (!Number.isFinite(setMs)) return true
  const set = etClock(new Date(setMs))
  return !(set.date === clock.date && set.minutes >= at)
}

/** The sentence a BUY's tool result carries when its `flattenAt` has already passed today — the flatten is the next session's. */
export function flattenTomorrowNote(flattenAt: string, clock: Pick<EtClock, 'minutes'>): string | null {
  const at = parseHHMM(flattenAt)
  if (at === null || clock.minutes < at) return null
  return `flattenAt ${flattenAt} ET has already passed today, so the engine flattens this position at ${flattenAt} ET on the NEXT session — it is held overnight on purpose. If it must be flat tonight, sell it yourself before the close.`
}

export type WatchCondition = 'above' | 'below' | 'move_up_pct' | 'move_down_pct'

/** A wake-up condition the agent registered ("wake me if MU drops 2%"). */
export interface PriceWatch {
  id: string
  symbol: string
  condition: WatchCondition
  value: number
  /** Price when the watch was set (basis for move_*_pct). */
  baseline: number
  note?: string
  setAt: string
}

export interface TradeIntent extends ExitSpec {
  side: 'buy' | 'sell'
  symbol: string
  /** Share quantity (fractional allowed in paper). */
  qty?: number
  /** Dollar amount; the engine converts to qty at the current quote. */
  notional?: number
  type: 'market' | 'limit'
  limitPrice?: number
  tif: 'day' | 'gtc'
  /** The model has read the trail-floor advisory and still wants a trail this tight. */
  acknowledgeTight?: boolean
  /**
   * An all-in buy sized by the engine (`shared/earningsPlaybook.ts`). A live one
   * goes to the broker as a DOLLAR-amount market order so the whole book is
   * deployed, instead of being rounded down to whole shares.
   */
  allIn?: boolean
  /** Why — shown on the card. */
  reason: string
}

/** Which engine exit fired, and at what level, frozen onto the sell it produced. */
export interface ExitTrigger {
  kind: 'stop' | 'trail' | 'target' | 'invalidation' | 'flatten'
  /** The level the sweep compared the price against (the flatten kind carries the price seen). */
  level: number
  /** For sells: (level − fill) × shares — positive means the fill was WORSE than the level. Absent until filled. */
  slippageUsd?: number
}

export interface TradeAction extends TradeIntent {
  mode: Mode
  status: 'filled' | 'open' | 'rejected' | 'cancelled' | 'error'
  fillPrice?: number
  fillQty?: number
  orderId?: string
  error?: string
  /** Quote used for the decision/fill. */
  refPrice?: number
  /**
   * Set on a BUY that follows a LOSING sell of the same symbol within the
   * agent's cooldown window (or the last hour when it has none): how long
   * after, and how much was lost. The card says "re-entering MU, 12 min after
   * a −$41 stop-out" — the most common losing pattern, made visible
   * at the moment it recurs. Frozen like `econ`.
   */
  reentry?: { minutesAfter: number; lossUsd: number }
  /**
   * Set on ENGINE-initiated sells only: the exit that fired, its level and the
   * dollars lost between that level and the fill. Frozen like `econ`, because
   * "the stop was at $340 and it filled at $338.20" is the fact the operator
   * asks about afterwards and nothing else on the card records it.
   */
  exitTrigger?: ExitTrigger
  /**
   * What the fill actually did to the book — captured at execution and frozen
   * into the message, because a trade card has to keep telling the truth about
   * the moment it happened even after later trades move the position.
   */
  econ?: FillEconomics
}

/** The money side of one fill, as the thread card shows it. */
export interface FillEconomics {
  /** Cash moved: shares × price. Out of the book on a buy, into it on a sell. */
  notional: number
  /** Sells: profit or loss on the shares closed, after averaging cost. */
  realized?: number
  /** Sells: the average cost those shares were closed against. */
  costBasis?: number
  /** Sells: `realized` as a percentage of the cost closed. */
  realizedPct?: number
  /** Shares held in this symbol AFTER the fill (0 = the position is closed). */
  positionQty: number
  /** Average cost of what is still held (0 when flat). */
  positionAvgCost: number
  /** The book's total realized P&L after this fill — the running score. */
  bookRealized: number
  /** Sells: the ET date the proceeds settle (T+1) — when a cash account can spend them again. */
  settlesOn?: string
}

/** Build the card's economics from the ledger either side of a fill. Pure. */
export function fillEconomics(before: Ledger, after: Ledger, fill: Fill): FillEconomics {
  const pos = after.positions.find((p) => p.symbol === fill.symbol)
  const prior = before.positions.find((p) => p.symbol === fill.symbol)
  const econ: FillEconomics = {
    notional: round2(fill.qty * fill.price),
    positionQty: pos?.qty ?? 0,
    positionAvgCost: pos?.avgCost ?? 0,
    bookRealized: after.realizedPnl
  }
  if (fill.side === 'sell') {
    econ.realized = fill.realized
    econ.settlesOn = settlesOn(fill.ts)
    // What those shares cost is the position's average BEFORE the sale — after
    // it, a partial sell leaves the same average and a full one leaves nothing.
    const basis = prior?.avgCost ?? 0
    if (basis > 0) {
      econ.costBasis = basis
      econ.realizedPct = round2((fill.realized / (basis * fill.qty)) * 100)
    }
  }
  return econ
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Something the agent meant to do but could not yet. `when` is the condition it
 * was waiting for, so the engine can tell it "this is possible now" instead of
 * the agent re-deriving that from a sentence every run.
 */
export interface Errand {
  id: string
  note: string
  addedAt: string
  /** What it is waiting for. 'market_open' is the common one; 'next_run' = as soon as possible. */
  when: 'next_run' | 'market_open'
}

/** See `AgentState.sleep`; the rules (parsing, cap, status text) live in `shared/sleep.ts`. */
export interface AgentSleep {
  /** ISO instant of the wake-up. */
  until: string
  /** Why, in the agent's words — shown in the thread note, the header and the run prompt. */
  reason: string
  setAt: string
}

/** Errands are debts, not archives: one this old was never going to be paid. */
export const ERRAND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** More than this pending and the agent is hoarding intentions rather than acting on them. */
export const MAX_ERRANDS = 8

/** Is this errand's moment now? `marketOpen` comes from the caller (shared/marketTime.ts). */
export const errandReady = (e: Errand, marketOpen: boolean): boolean => e.when === 'next_run' || marketOpen

/** Too old to still be meant — the engine drops these and says so in the thread. */
export const errandStale = (e: Errand, now: number = Date.now()): boolean => now - Date.parse(e.addedAt) > ERRAND_MAX_AGE_MS

/**
 * One standing instruction. The agent works through every ACTIVE task on every
 * run, so adding one changes the agent's job — which is why adding one needs the
 * operator's word (see `PlanProposal.addTask`).
 */
export interface AgentTask {
  id: string
  text: string
  addedAt: string
  /** 'created' = the goal the agent was made with; 'operator' = added later, with their confirmation. */
  source: 'created' | 'operator'
  /** Finished or abandoned. Kept for the record, no longer given to the model. */
  doneAt?: string | null
  /** Why it ended — shown in the list so a struck-through task explains itself. */
  doneReason?: string
}

/**
 * The task list, including agents that predate it (their `task` is task one).
 * Always use this rather than reading `cfg.tasks` — that field is absent on
 * every agent created before today.
 */
export function tasksOf(cfg: Pick<AgentConfig, 'task' | 'tasks' | 'createdAt'>): AgentTask[] {
  if (cfg.tasks?.length) return cfg.tasks
  const text = cfg.task.trim()
  return text ? [{ id: 't_1', text, addedAt: cfg.createdAt, source: 'created' }] : []
}

/** The tasks the agent is actually working — what the prompt injects. */
export const activeTasks = (cfg: Pick<AgentConfig, 'task' | 'tasks' | 'createdAt'>): AgentTask[] => tasksOf(cfg).filter((t) => !t.doneAt)

/** At most this many standing tasks at once — past a handful an agent has no focus left. */
export const MAX_TASKS = 5

/**
 * A new agent one agent proposes spinning off. Deliberately small: everything
 * not named here is inherited from the parent (provider, mode, guardrails,
 * allocation), because a spin-off should differ in WHAT IT WATCHES, not in how
 * carefully it is allowed to trade.
 */
export interface SpawnSpec {
  name: string
  task: string
  schedule?: Schedule
  /** One line for the card: why this deserves its own agent rather than another task. */
  why: string
}

/**
 * Whether this computer may take on another agent right now, and if not, the
 * sentence to tell the operator. Answered by the HOST (`RuntimeDeps.capacity`)
 * because only it can see the whole fleet.
 */
export interface AgentCapacity {
  /** Active (non-retired) agents. */
  used: number
  /** The ceiling (`MAX_ACTIVE_AGENTS`). */
  max: number
  /** True = a new agent can be created right now. */
  ok: boolean
  /** Why not — written for the operator, not the log. */
  reason?: string
}

/**
 * A money-moving tool call the agent wants to make, held until the operator says
 * yes. Exactly one is open at a time: while it waits the agent is stalled, so a
 * queue of stale intentions can never pile up behind an unanswered question.
 *
 * `quote` and `requestedAt` are what keep approval honest rather than a rubber
 * stamp. When the answer finally comes — ten seconds or ten hours later — the
 * agent is shown what it believed then, how long ago that was, and what is true
 * now, and decides again from there.
 */
export interface PendingAction {
  id: string
  /** Bare tool name: 'trade', 'set_exit', or a Robinhood write tool. */
  tool: string
  /** The exact arguments it wanted to call with, replayed verbatim if it still wants to. */
  args: Record<string, unknown>
  /** One line for the card: what would happen. */
  summary: string
  /** Why, in the agent's words. */
  reason: string
  symbol?: string
  side?: 'buy' | 'sell'
  /** Price of `symbol` when it asked — the reference the decision was made against. */
  quote?: number
  requestedAt: string
  /**
   * Fingerprint of the tool definition this was approved against.
   * If the definition changes underneath a pending card, the operator approved
   * something that no longer exists and the pass must not be replayed against
   * the new meaning. Absent means "no opinion" — never "unchanged".
   */
  toolHash?: string
  /** Set the moment the operator says yes. The agent is then woken to re-decide, not to fire. */
  approvedAt?: string
}

/** Agents made before the switch existed acted on their own, and still do. */
export const isAutonomous = (cfg: Pick<AgentConfig, 'autonomous'>): boolean => cfg.autonomous !== false

/**
 * The tools that move money or change a position, and so need the operator's
 * word when an agent is not autonomous. Everything else an agent can do —
 * remembering, watching, setting a thesis, asking — changes nothing outside
 * itself and never stops.
 *
 * Robinhood's own write tools are gated too, by shape rather than by name
 * (`robinhoodToolKind`), so a tool we have never heard of cannot slip past.
 */
export const WRITE_TOOLS: readonly string[] = ['trade', 'cancel_order', 'set_exit', 'retire']

export const isWriteTool = (name: string): boolean => WRITE_TOOLS.includes(name)

/** A (partial) change to the agent's plan — omitted fields keep their current value. */
export interface PlanProposal {
  name?: string
  task?: string
  schedule?: Schedule
  /** undefined = unchanged; null = clear the policy. */
  retirement?: RetirementPolicy | null
  /**
   * A standing task to ADD. Never auto-applied, on any trigger: a second task
   * changes what the agent is for, so the operator confirms it in the thread.
   */
  addTask?: string
  /**
   * A whole new agent to create, rather than a change to this one. Confirming
   * the card creates it; dismissing does nothing. Never auto-applied.
   */
  spawnAgent?: SpawnSpec
  /** Mark a task finished/abandoned by id (it stops being given to the model). */
  completeTaskId?: string
  /** Why that task ended, for the list. */
  completeReason?: string
  guardrails: Partial<Guardrails>
  /**
   * The guardrail change as `from → to`, computed WHERE THE PLAN IS PROPOSED and
   * frozen into the message.
   *
   * It cannot be derived at render time: once an applied card's change is live,
   * the agent's current guardrails ARE the new values, so recomputing against
   * them yields nothing and the card goes blank — precisely when it matters
   * most, because an applied card is the audit trail for "what did I agree to
   * last Tuesday?". Same reasoning as `FillEconomics` on a trade card: a record
   * of a decision has to keep telling the truth about its own moment, not be
   * recomputed against a world that has since moved.
   *
   * Absent on plans posted before this existed, and on plans that change no
   * guardrails — renderers should treat absence as "nothing to show".
   */
  diff?: GuardrailChange[]
  /** One-line explanation of what changed / what the plan is. */
  summary: string
}

/** One guardrail a plan would change, ready to render as `from → to`. */
export interface GuardrailChange {
  key: keyof Guardrails
  /** Operator-facing name, in the words the agent's own prompt uses. */
  label: string
  from: string
  to: string
  /** True = this widens what the agent may do, or how much it may lose. */
  looser: boolean
}

const GUARDRAIL_LABEL: Record<keyof Guardrails, string> = {
  allowedSymbols: 'Symbols',
  maxOrderNotional: 'Max per order',
  maxOrdersPerDay: 'Max orders per day',
  marketHoursOnly: 'Regular session only',
  allowExtendedHours: 'Extended hours',
  maxPositionNotional: 'Max per symbol',
  maxDailyLossPct: 'Daily loss limit',
  noEntriesBeforeEt: 'No buys before',
  maxEntryExtensionPct: 'Max entry extension',
  maxSymbolDayPct: 'Max per symbol per day',
  reentryCooldownMin: 'Re-entry cooldown',
  maxNewPositionsPerRun: 'New positions per run',
  settlement: 'Settlement'
}

const symbolsLabel = (s: string[]): string => (s.length ? s.join(', ') : 'any symbol')

/**
 * What a plan would change about the fence, and in which direction.
 *
 * The model's own one-line summary next to the new values was never enough:
 * the summary is prose the model wrote, and "More aggressive posture" does not
 * tell an operator that their daily loss limit went from 5% to 40%. A computed
 * `from → to` is a fact, and `looser` is what the auto-apply rule turns on.
 *
 * Pure, and shared so the plan card and the engine agree on what counts as
 * loosening.
 */
export function guardrailDiff(prev: Guardrails, next: Partial<Guardrails> | undefined): GuardrailChange[] {
  const out: GuardrailChange[] = []
  if (!next) return out
  const num = (key: 'maxOrderNotional' | 'maxOrdersPerDay' | 'maxPositionNotional' | 'maxDailyLossPct', fmt: (n: number) => string): void => {
    const to = next[key]
    if (to === undefined || to === prev[key]) return
    // Every one of these is a ceiling, so raising it loosens — including the
    // daily loss limit, where a bigger number means a bigger tolerated loss.
    out.push({ key, label: GUARDRAIL_LABEL[key], from: fmt(prev[key]), to: fmt(to), looser: to > prev[key] })
  }
  num('maxOrderNotional', (n) => money(n, 0))
  num('maxPositionNotional', (n) => money(n, 0))
  num('maxOrdersPerDay', (n) => `${n}/day`)
  num('maxDailyLossPct', (n) => `${n}% of allocation`)
  const yn = (b: boolean): string => (b ? 'yes' : 'no')
  // `loosensWhen` is the whole difference between these two, and spelling it out
  // per key beats two near-identical blocks whose only distinction is a negation
  // buried mid-expression: restricting to market hours loosens when it turns
  // OFF, allowing extended hours loosens when it turns ON.
  const bool = (key: 'marketHoursOnly' | 'allowExtendedHours', loosensWhen: (to: boolean) => boolean): void => {
    const to = next[key]
    if (to === undefined || to === prev[key]) return
    out.push({ key, label: GUARDRAIL_LABEL[key], from: yn(prev[key]), to: yn(to), looser: loosensWhen(to) })
  }
  bool('marketHoursOnly', (to) => !to)
  bool('allowExtendedHours', (to) => to)
  // The entry rules. Each is a restriction, so RAISING a cap or REMOVING the
  // rule loosens; a later window, a longer cooldown, a smaller extension or a
  // smaller per-run count tightens. `null` in a plan means "remove".
  const entry = <K extends 'maxEntryExtensionPct' | 'maxSymbolDayPct' | 'reentryCooldownMin' | 'maxNewPositionsPerRun'>(key: K, fmt: (n: number) => string, looserWhenHigher: boolean): void => {
    if (!(key in next)) return
    const to = next[key] ?? undefined
    const was = prev[key]
    if (to === was) return
    const looser = to === undefined ? was !== undefined : was === undefined ? false : looserWhenHigher ? to > was : to < was
    out.push({ key, label: GUARDRAIL_LABEL[key], from: was === undefined ? 'off' : fmt(was), to: to === undefined ? 'off' : fmt(to), looser })
  }
  entry('maxEntryExtensionPct', (n) => `${n}%`, true)
  entry('maxSymbolDayPct', (n) => `${n}% of allocation`, true)
  entry('reentryCooldownMin', (n) => `${n} min`, false)
  entry('maxNewPositionsPerRun', (n) => `${n}/run`, true)
  if ('noEntriesBeforeEt' in next && (next.noEntriesBeforeEt ?? undefined) !== prev.noEntriesBeforeEt) {
    const to = next.noEntriesBeforeEt ?? undefined
    const was = prev.noEntriesBeforeEt
    // An earlier window (or none) loosens.
    const looser = to === undefined ? was !== undefined : was === undefined ? false : to < was
    out.push({ key: 'noEntriesBeforeEt', label: GUARDRAIL_LABEL.noEntriesBeforeEt, from: was ?? 'off', to: to ? `${to} ET` : 'off', looser })
  }
  if ('settlement' in next && (next.settlement ?? undefined) !== prev.settlement) {
    const to = next.settlement ?? undefined
    const was = prev.settlement
    // 'cash' is the restriction (buys wait for T+1); margin or off loosens.
    out.push({ key: 'settlement', label: GUARDRAIL_LABEL.settlement, from: was ?? 'off', to: to ?? 'off', looser: was === 'cash' && to !== 'cash' })
  }
  if (next.allowedSymbols) {
    const before = prev.allowedSymbols.map((x) => x.toUpperCase())
    const after = next.allowedSymbols.map((x) => x.toUpperCase())
    if (before.join() !== after.join()) {
      // An empty list means ANY symbol — the most permissive value there is. So
      // emptying a restricted list opens everything, and while a list is already
      // empty nothing can widen it further.
      const looser = before.length > 0 && (after.length === 0 || after.some((x) => !before.includes(x)))
      out.push({ key: 'allowedSymbols', label: GUARDRAIL_LABEL.allowedSymbols, from: symbolsLabel(before), to: symbolsLabel(after), looser })
    }
  }
  return out
}

/**
 * The rows a plan card should SHOW, which is not always the rows it was born
 * with.
 *
 * An applied or dismissed card is history and must keep its frozen diff — that
 * is the whole point of freezing it. A PENDING card is a live control, and its
 * `from` can go stale: if the operator tightens a limit in Settings while a card
 * waits, the card still claims the old starting point, so "$1,000 → $2,000"
 * understates a change that is now four times the current cap. The `to` is
 * absolute and what they actually tap for, so this was never a wrong write —
 * but #5 exists so the operator sees what they are agreeing to, and a stale
 * `from` is the same class of problem one step milder.
 */
export function planDiffFor(plan: PlanProposal, status: 'pending' | 'applied' | 'dismissed', current: Guardrails): GuardrailChange[] {
  return status === 'pending' ? guardrailDiff(current, plan.guardrails) : (plan.diff ?? guardrailDiff(current, plan.guardrails))
}

/**
 * Does this change widen the fence? The question the auto-apply rule turns on.
 * Takes the diff rather than recomputing it, because every caller already has
 * one — and two ways to ask "is this looser" is one way too many for a
 * predicate that decides whether money limits apply without a human.
 */
export const loosensGuardrails = (changes: GuardrailChange[]): boolean => changes.some((c) => c.looser)

/**
 * A cap above the allocation is not a cap. `cap.allocation` already binds every
 * buy to the agent's own remaining cash, so a $50,000 per-order limit on a
 * $10,000 agent can never bite — it only removes a guardrail from the
 * operator's view of the fence while changing nothing about the behaviour.
 * Clamping at the moment the model proposes keeps the plan card honest, rather
 * than showing one number and applying another.
 */
export function clampGuardrails(g: Partial<Guardrails>, allocationUsd: number): Partial<Guardrails> {
  const cap = Math.max(1, allocationUsd)
  const clampNum = (n: number | undefined, lo: number, hi: number): number | undefined => (n === undefined ? undefined : Math.min(hi, Math.max(lo, n)))
  return {
    ...g,
    ...(g.maxOrderNotional !== undefined ? { maxOrderNotional: Math.min(g.maxOrderNotional, cap) } : {}),
    ...(g.maxPositionNotional !== undefined ? { maxPositionNotional: Math.min(g.maxPositionNotional, cap) } : {}),
    ...(g.maxDailyLossPct !== undefined ? { maxDailyLossPct: Math.min(g.maxDailyLossPct, MAX_MODEL_DAILY_LOSS_PCT) } : {}),
    // The entry rules are bounded to what can mean anything: a window inside
    // the session, an extension and a per-symbol budget as a percentage, a
    // cooldown inside a day, at least one new position per run.
    ...(g.noEntriesBeforeEt !== undefined && g.noEntriesBeforeEt !== null ? { noEntriesBeforeEt: /^\d{1,2}:\d{2}$/.test(g.noEntriesBeforeEt) ? g.noEntriesBeforeEt : undefined } : {}),
    ...(g.maxEntryExtensionPct !== undefined && g.maxEntryExtensionPct !== null ? { maxEntryExtensionPct: clampNum(g.maxEntryExtensionPct, 0, 50) } : {}),
    ...(g.maxSymbolDayPct !== undefined && g.maxSymbolDayPct !== null ? { maxSymbolDayPct: clampNum(g.maxSymbolDayPct, 1, 100) } : {}),
    ...(g.reentryCooldownMin !== undefined && g.reentryCooldownMin !== null ? { reentryCooldownMin: clampNum(Math.round(g.reentryCooldownMin), 0, 1440) } : {}),
    ...(g.maxNewPositionsPerRun !== undefined && g.maxNewPositionsPerRun !== null ? { maxNewPositionsPerRun: clampNum(Math.round(g.maxNewPositionsPerRun), 1, 50) } : {}),
    ...(g.settlement !== undefined && g.settlement !== null ? { settlement: g.settlement === 'cash' || g.settlement === 'margin' ? g.settlement : undefined } : {})
  }
}

/**
 * What a fence means in money, in one sentence, for the plan card that widens
 * it. A diff says "$1,000 → $2,500"; this
 * says what that lets one order, one symbol and one day lose.
 */
export function riskSummary(g: Guardrails, allocationUsd: number): string {
  const alloc = Math.max(1, allocationUsd)
  const pct = (n: number): string => `${Math.round((n / alloc) * 1000) / 10}%`
  return `At these limits one order can put ${money(g.maxOrderNotional, 0)} (${pct(g.maxOrderNotional)} of the allocation) into a name, one symbol can carry ${money(g.maxPositionNotional, 0)} (${pct(g.maxPositionNotional)}), and a day can lose ${g.maxDailyLossPct}% (${money((g.maxDailyLossPct / 100) * alloc, 0)}) before buying stops — ${g.maxOrdersPerDay} orders a day${g.allowedSymbols.length ? ` across ${g.allowedSymbols.length} symbol${g.allowedSymbols.length === 1 ? '' : 's'}` : ' in any symbol'}.`
}

/**
 * The stats sheet's Risk panel, pure so any surface can show the same
 * numbers: concentration, cash, what would carry overnight with an intraday
 * exit, each trail's width against the stop it implies, and how often this
 * week the agent bought inside the opening window.
 */
export interface RiskPanel {
  largestPositionPct: number | null
  largestSymbol: string | null
  cashPct: number
  /** Symbols held with an engine stop/trail and no flatten time — they carry overnight if not hit. */
  overnightCarry: string[]
  trails: { symbol: string; trailPct: number; stopDistancePct: number | null }[]
  openingWindowBuysThisWeek: number
}

export function riskPanel(cfg: Pick<AgentConfig, 'mode' | 'allocationUsd'>, state: Pick<AgentState, 'paper' | 'live' | 'exits'>, marks: Record<string, number>, etMinutesOf: (iso: string) => number, now: number = Date.now()): RiskPanel {
  const ledger = ledgerFor(cfg, state)
  const alloc = Math.max(1, cfg.allocationUsd)
  let largest: { symbol: string; pct: number } | null = null
  for (const p of ledger.positions) {
    const pct = (p.qty * (marks[p.symbol] ?? p.avgCost)) / alloc
    if (!largest || pct > largest.pct) largest = { symbol: p.symbol, pct }
  }
  const held = new Set(ledger.positions.map((p) => p.symbol))
  const overnightCarry = Object.entries(state.exits)
    .filter(([s, p]) => held.has(s) && p.enforcedBy !== 'broker' && !p.flattenAt && (p.stop !== undefined || p.trail !== undefined || p.stopIf !== undefined))
    .map(([s]) => s)
  const trails = Object.entries(state.exits)
    .filter(([s, p]) => held.has(s) && p.trail)
    .map(([symbol, p]) => {
      const last = marks[symbol]
      const stop = effectiveStop(p)
      return { symbol, trailPct: p.trail!.pct, stopDistancePct: last && stop !== undefined ? Math.round(((last - stop) / last) * 10000) / 100 : null }
    })
  const weekAgo = now - 7 * 86_400_000
  const openingWindowBuysThisWeek = ledger.fills.filter((f) => f.side === 'buy' && Date.parse(f.ts) >= weekAgo && etMinutesOf(f.ts) < 9 * 60 + 45).length
  return {
    largestPositionPct: largest ? Math.round(largest.pct * 1000) / 10 : null,
    largestSymbol: largest?.symbol ?? null,
    cashPct: Math.round((ledger.cash / alloc) * 1000) / 10,
    overnightCarry,
    trails,
    openingWindowBuysThisWeek
  }
}

/** Daily loss above this % of allocation, or per-order above `TYPED_CONFIRM_ORDER_PCT`, needs the word typed. */
export const TYPED_CONFIRM_DAILY_LOSS_PCT = 10
export const TYPED_CONFIRM_ORDER_PCT = 25
export const TYPED_CONFIRM_WORD = 'widen'

/**
 * Does applying these guardrails need the operator to TYPE `widen`? A tap is
 * cheap and a 40% daily loss limit is not; the word is the moment of reading.
 * Pure and shared so the plan card and the settings sheet draw the line in
 * the same place.
 */
export function needsTypedConfirm(next: Guardrails, allocationUsd: number): boolean {
  const alloc = Math.max(1, allocationUsd)
  return next.maxDailyLossPct > TYPED_CONFIRM_DAILY_LOSS_PCT || next.maxOrderNotional > (TYPED_CONFIRM_ORDER_PCT / 100) * alloc
}

/**
 * What a task's goal implies per trading day, parsed from the sentence:
 * "make 10% this week" is 2% a day, and a name
 * that moves 1.5% on an ordinary day cannot deliver it. Null when the task
 * names no measurable goal with a horizon — a standing job has no implied
 * daily return and must not be handed a fake one.
 */
export interface GoalRealism {
  /** The goal as % of allocation. */
  targetPct: number
  /** Trading days the sentence gives it. */
  tradingDays: number
  /** targetPct / tradingDays. */
  impliedDailyPct: number
}

export function goalRealism(task: string, allocationUsd: number, todayIso?: string): GoalRealism | null {
  const t = task.toLowerCase()
  if (!/\b(make|gain|earn|profit|return|grow|target|goal|up|reach|hit|turn|into|double)\b/.test(t)) return null
  const pctM = /(\d+(?:\.\d+)?)\s*%/.exec(t)
  // The GOAL's dollar figure, not the capital's: "turn $10,000 into +$500"
  // names both, and the one after a goal verb (or a plus sign) is the goal.
  const usdAll = [...t.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/g)]
  const usdM = usdAll.find((m) => /(make|gain|earn|profit|return|target|goal|reach|hit|into|up|\+)\s*$/.test(t.slice(Math.max(0, (m.index ?? 0) - 12), m.index))) ?? usdAll[0]
  let targetPct: number | null = null
  if (pctM) targetPct = Number(pctM[1])
  else if (usdM) {
    const usd = Number(usdM[1].replace(/,/g, '')) * (usdM[2] ? 1000 : 1)
    if (usd > 0 && allocationUsd > 0) targetPct = (usd / allocationUsd) * 100
  }
  if (targetPct === null || !(targetPct > 0)) return null
  let days: number | null = null
  if (/\b(today|by (the )?close|end of (the )?day|intraday|same.?day)\b/.test(t)) days = 1
  else if (/\b(\d+)\s*(trading\s*)?days?\b/.test(t)) days = Number(/\b(\d+)\s*(trading\s*)?days?\b/.exec(t)![1])
  else if (/\b(\d+)\s*weeks?\b/.test(t)) days = Number(/\b(\d+)\s*weeks?\b/.exec(t)![1]) * 5
  else if (/\b(this week|a week|by friday|end of (the )?week|within the week)\b/.test(t)) days = 5
  else if (/\b(this month|a month|by month.?end|end of (the )?month|30 days)\b/.test(t)) days = 21
  else if (/\b(this quarter|a quarter|3 months)\b/.test(t)) days = 63
  else if (/\b(this year|a year|12 months)\b/.test(t)) days = 252
  else {
    // "by Sep 30" / "by 2026-09-30": calendar days to the date, as trading days.
    const iso = /\b(20\d\d-\d\d-\d\d)\b/.exec(t)?.[1]
    const mon = /\bby\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/.exec(t)
    const today = todayIso ? new Date(todayIso) : new Date()
    let target: Date | null = null
    if (iso) target = new Date(`${iso}T00:00:00Z`)
    else if (mon) {
      const m = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(mon[1])
      target = new Date(Date.UTC(today.getUTCFullYear() + (m < today.getUTCMonth() ? 1 : 0), m, Number(mon[2])))
    }
    if (target) days = Math.max(1, Math.round(((target.getTime() - today.getTime()) / 86_400_000) * (5 / 7)))
  }
  if (days === null) return null
  return { targetPct: Math.round(targetPct * 100) / 100, tradingDays: days, impliedDailyPct: Math.round((targetPct / days) * 100) / 100 }
}

/** The sentence both the New-agent sheet and the first run's card say about an implied daily return. */
export function goalRealismLine(r: GoalRealism, rangePct: number | null): string {
  const need = `${r.targetPct}% in ${r.tradingDays} trading day${r.tradingDays === 1 ? '' : 's'} is ${r.impliedDailyPct}% a day, every day`
  if (rangePct === null) return `${need} — check that against how much the names actually move.`
  return r.impliedDailyPct > rangePct
    ? `${need}, and the watchlist moves about ${rangePct.toFixed(2)}% on an ordinary day. That needs more than the whole daily range captured every day — not a plan, a hope. Expect this agent to be behind, and size the goal to the market.`
    : `${need}; the watchlist moves about ${rangePct.toFixed(2)}% a day, so it is ambitious but inside the range.`
}

/**
 * The most an AGENT may set its own daily loss limit to. The operator can still
 * choose anything in Settings — this bounds what the model can talk itself into
 * on a reply run, because that limit is the only guardrail that is a stop rather
 * than a size, and 100% would switch it off entirely.
 */
export const MAX_MODEL_DAILY_LOSS_PCT = 25

/** Merge a plan change onto a config (pure; used by the runner and the apply-card path). */
export function applyPlanToConfig(cfg: AgentConfig, plan: PlanProposal, at: string): AgentConfig {
  // A spawn is not a change to this agent — the caller creates a new one. If it
  // ever reaches here, changing nothing is the only safe reading.
  if (plan.spawnAgent) return cfg
  // Task edits rebuild the list from `tasksOf`, so an agent that predates task
  // lists gets its original goal materialised as task one the first time either
  // side touches it — rather than silently losing it behind a new task.
  let tasks = plan.addTask || plan.completeTaskId ? tasksOf(cfg) : cfg.tasks
  if (plan.completeTaskId) tasks = (tasks ?? []).map((t) => (t.id === plan.completeTaskId ? { ...t, doneAt: at, doneReason: plan.completeReason } : t))
  if (plan.addTask) tasks = [...(tasks ?? []), { id: newId('t_'), text: plan.addTask.trim(), addedAt: at, source: 'operator' as const }]
  return {
    ...cfg,
    ...(tasks ? { tasks } : {}),
    ...(plan.name ? { name: plan.name } : {}),
    ...(plan.task ? { task: plan.task } : {}),
    ...(plan.schedule ? { schedule: plan.schedule } : {}),
    // Applied AS PROPOSED. A profit target without a max loss is a goal with no
    // floor, and the tool host proposes the floor and
    // SAYS so in the card's summary — but this function is also the apply-card
    // path, and a `maxLossUsd` inferred here would reach a live agent as a new
    // automatic flatten trigger nobody had read.
    // A retirement condition is never invented silently at the write.
    ...(plan.retirement !== undefined ? { retirement: plan.retirement } : {}),
    // Clamped HERE, at the one place a plan becomes config. It was previously
    // clamped by the tool host — a single producer — while this function is
    // called from more than one: the runner and the apply-card path. An
    // invariant about money limits belongs with the write, not with one of the
    // writers.
    //
    // The opening window rides on the SCHEDULE: a new-style agent whose plan
    // makes it an interval agent gets `noEntriesBeforeEt` here, because the
    // setup run is where most agents get their schedule, not the create form.
    // Only agents that carry the other entry rules (made after they existed);
    // an older agent is never handed a rule it did not have.
    guardrails: {
      ...cfg.guardrails,
      ...(plan.schedule?.kind === 'interval' && hasEntryRules(cfg.guardrails) && cfg.guardrails.noEntriesBeforeEt === undefined && plan.guardrails.noEntriesBeforeEt === undefined ? { noEntriesBeforeEt: ENTRY_DEFAULTS.noEntriesBeforeEt } : {}),
      ...clampGuardrails(plan.guardrails, cfg.allocationUsd)
    },
    updatedAt: at
  }
}

export type SystemKind = 'created' | 'paused' | 'resumed' | 'schedule' | 'error' | 'info' | 'mode' | 'retired'

interface MessageBase {
  id: string
  agentId: string
  ts: string
  runId?: string
}

/** One label/value chip on a run report — the freeform half of the schema. */
export interface ReportFact {
  label: string
  value: string
  /** Small qualifier next to the value ("+0.8% vs entry"). */
  delta?: string
  /** Colors the value/delta; omitted renders neutral. */
  tone?: 'up' | 'down' | 'flat'
}

/**
 * The structured end-of-run summary an agent files with `mcp__tb__report`
 *. Nine near-identical paragraphs of "Holding this tick — …" is
 * what a thread looked like before this: every field here exists to make a run
 * scannable in one glance. `status` is deliberately a four-value enum — it is
 * what the card's color says before the operator reads a word:
 *   acted   = orders were placed / plans changed this run
 *   held    = looked, decided to do nothing (the common case)
 *   blocked = wanted to act and could not (approval pending, broker down)
 *   done    = the task is finished (usually alongside retire)
 *
 * FROZEN into the message like a trade card's econ: it is the agent's claim at
 * that moment, never recomputed. The `facts` label/value chips are the
 * universal container — a scalper files entries and trails, a news reader the
 * headlines screened — so the schema never has to know about a use case.
 */
export interface AgentReport {
  headline: string
  status: 'acted' | 'held' | 'blocked' | 'done'
  facts?: ReportFact[]
  /** What happens next and when ("Flatten ~3:50, retire at close"). */
  next?: string
  /** Anything that did not fit the structure. */
  details?: string
}

/**
 * The plain-text twin of a report, composed at POST time and stored as the
 * message's `text`. It is what old clients, the transcript block, push
 * notifications and previews see — so a report is never a message a
 * pre-report surface renders as blank.
 */
export function reportFallbackText(r: AgentReport): string {
  const lines: string[] = [r.headline]
  for (const f of r.facts ?? []) lines.push(`${f.label}: ${f.value}${f.delta ? ` (${f.delta})` : ''}`)
  if (r.next) lines.push(`Next: ${r.next}`)
  if (r.details) lines.push(r.details)
  return lines.join('\n')
}

export type Message =
  | (MessageBase & {
      role: 'user'
      text: string
      /**
       * The run this message was sent DURING and waited behind (its id). The
       * thread places the message after that run's messages rather than at its
       * timestamp, because the reply that run produced answers what came
       * before it — the operator's second question belongs under that reply,
       * not above it (shared/messageQueue.ts `orderThread`). Absent on a
       * message sent to an idle agent.
       */
      queuedBehind?: string
    })
  | (MessageBase & {
      role: 'agent'
      text: string
      thinking?: string
      toolCalls?: ToolCallSummary[]
      /** Structured end-of-run summary; `text` always carries its plain-text twin (or the model's own prose). */
      report?: AgentReport
      /**
       * The agent flagged this as worth interrupting the operator for: `fyi`
       * respects the operator's conversation preference, `important` is pushed
       * like a question. Set by `tell_operator`, and 'fyi' on replies to the operator.
       */
      notify?: 'fyi' | 'important'
    })
  | (MessageBase & {
      role: 'system'
      text: string
      kind: SystemKind
      /**
       * Set by the SENDER when a note has to reach the operator wherever they
       * are — the engine stopping an agent (a broker reconnect needed, a
       * retirement that could not flatten). The operator tapping
       * Pause posts the same `kind` and must NOT buzz them about their own tap,
       * and no rule derived from the message alone can tell those apart.
       */
      notify?: 'fyi' | 'important'
    })
  | (MessageBase & { role: 'action'; action: TradeAction })
  | (MessageBase & { role: 'plan'; plan: PlanProposal; status: 'pending' | 'applied' | 'dismissed' })
  | (MessageBase & {
      role: 'approval'
      /** What the agent wants to do, frozen at the moment it asked. */
      action: PendingAction
      /**
       * `pending` waits indefinitely: there is no deadline, and nothing happens
       * without an answer. `withdrawn` is the agent taking it back — the operator
       * sent a new message instead of answering, so the request is stale and it
       * will ask again against what is true now.
       */
      status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
      answeredAt?: string
      /** What came of it once the agent looked again — including deciding the moment had passed. */
      outcome?: string
    })
  | (MessageBase & {
      role: 'question'
      text: string
      options?: string[]
      /** What's at stake — one line, shown on the card and in the notification. */
      stakes?: string
      /** What the agent WILL do if nobody answers by `deadline`. Every new question has one; legacy rows don't. */
      fallback?: string
      /** ISO instant. Unanswered past this → the engine wakes the agent with trigger 'timeout'. Absent = legacy, never times out. */
      deadline?: string
      /** The answer: the operator's words, or the fallback when it timed out. Set = resolved. */
      answeredBy?: string
      /**
       * How it resolved. `superseded` is the honest third case: the operator
       * sent a message that was not a reply to this card. Recording that as an
       * ANSWER meant an unrelated "what's my P&L?" cancelled the promised
       * fallback and came back to the agent as `OPERATOR ANSWERED: what's my
       * P&L?` — which it could act on as an instruction. The question is closed
       * either way (no fallback fires on a message nobody aimed at it), but the
       * agent is told which happened.
       */
      answeredVia?: 'operator' | 'timeout' | 'superseded'
      answeredAt?: string
    })

/** Distributive omit so each Message variant keeps its own fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
/** A message before the store stamps id/agentId/ts. */
export type NewMessage = DistributiveOmit<Message, 'id' | 'agentId' | 'ts' | 'runId'> & { ts?: string; runId?: string }

export type QuestionMessage = Extract<Message, { role: 'question' }>
export type ApprovalMessage = Extract<Message, { role: 'approval' }>

/** A held action still waiting on the operator — the thing that stalls an agent. */
export function isOpenApproval(m: Message): m is ApprovalMessage {
  return m.role === 'approval' && m.status === 'pending'
}

/** A question nobody has answered yet (by hand or by timeout). */
export function isOpenQuestion(m: Message): m is QuestionMessage {
  return m.role === 'question' && !m.answeredBy
}
/** An open question whose deadline has passed — the engine owes it a 'timeout' run. */
export function questionExpired(m: QuestionMessage, now: Date = new Date()): boolean {
  return !m.answeredBy && !!m.deadline && new Date(m.deadline).getTime() <= now.getTime()
}
/** Check-in budget for runs nobody started (schedule/watch/timeout): questions and tells per ET day. */
export const UNATTENDED_QUESTIONS_PER_DAY = 3
export const UNATTENDED_TELLS_PER_DAY = 4
/** Default / allowed wait for an operator answer before the fallback runs. */
export const QUESTION_WAIT_DEFAULT_MIN = 10
export const QUESTION_WAIT_MIN = 2
export const QUESTION_WAIT_MAX = 120

/** `timeout` = an open question's deadline passed with no answer; the agent wakes to do its promised fallback. */
/**
 * `approval` is the operator answering a held write. It is deliberately NOT a
 * command to execute: the agent is woken to look at the world as it is now and
 * decide again, because the price it reasoned about may be long gone.
 */
export type RunTrigger = 'schedule' | 'manual' | 'reply' | 'plan' | 'watch' | 'timeout' | 'approval'

export interface RunPromptCategory {
  /** Block id from the prompt registry, or a synthetic category ('system', 'tools'). */
  id: string
  chars: number
  /** Share of the measured prompt, 0..1. */
  share: number
  /** Apportioned from the vendor's reported total — absent when there was none. */
  tokens?: number
}

export interface RunRecord {
  id: string
  agentId: string
  trigger: RunTrigger
  startedAt: string
  endedAt: string
  ok: boolean
  error?: string
  model: string
  inputTokens: number
  outputTokens: number
  /** Prompt tokens served from the provider's cache (a subset of inputTokens). The cost lever we actually control — measure it, don't assume it. */
  cachedTokens?: number
  /**
   * The FULL context footprint of the last model call — fresh input plus cache
   * reads. Not a nicety: `inputTokens` means different things per vendor, so it
   * cannot anchor a token breakdown. `vendors/openrouter.ts` documents its
   * `inputTokens` as the total prompt INCLUDING cache; `vendors/claude.ts` sets
   * it from `input_tokens`, which EXCLUDES cache reads, and assembles the true
   * size separately. A per-category breakdown built on
   * `inputTokens` is therefore wrong on Claude whenever the cache hits — the
   * normal case — and the residual can go negative.
   *
   * Optional: runs recorded before this carry no value, and absent must read as
   * "not measured" rather than zero.
   */
  contextTokens?: number
  costUsd?: number
  toolCalls: number
  actions: number
  durationMs: number
  /**
   * The book as this run left it. Two jobs:
   *
   * DEBUGGING — `state.json` is one file overwritten in place, so without this
   * there is NO history to diff when a book looks wrong; it could only be
   * reconstructed from trade cards. With a summary on every run,
   * "run N ended with 8 fills, run N+1 started from 2" is a query, not an
   * archaeology project.
   *
   * UI — this is the only per-agent equity TIME SERIES the product has. The
   * paper portfolio page can only show the book as it is now; sparklines and
   * all-time P/L curves read these rows.
   *
   * `equity` marks positions at this run's quotes and falls back to cost for
   * symbols the run had no quote for — same convention as `paperPortfolio()`.
   * Optional: runs recorded before this carry none.
   */
  book?: RunBookSummary
  /**
   * What CODE served this run (the app version). "Did that run happen before
   * or after the fix?" is then a field on the row rather than a guess from log
   * timestamps. Optional; absent means unrecorded.
   */
  build?: string
  /**
   * The observability backend's id for this run's trace, when the host
   * supplies a `TraceSink` — the full prompts, every model step, every tool
   * call and decision live there, and this is the key that joins the row to
   * them. Absent when the host traces nothing.
   */
  traceId?: string
  /**
   * Where the prompt's size went, per category. Chars are MEASURED;
   * `tokens` is apportioned from the vendor's reported total and is ABSENT
   * when the vendor reported none — `core` holds no tokenizer, and inventing
   * one would produce a figure that looks like the number we bill on and is
   * not. A category with no `tokens` means "we could not say", never "zero".
   */
  promptCategories?: RunPromptCategory[]
  /**
   * Tokens the vendor counted that no category accounts for — chat framing,
   * the tool wire format, per-message overhead. Named rather than spread
   * across the categories, so they stay honest and growth here stays visible.
   */
  promptUnaccountedTokens?: number
  /** Interval tick skipped by the triage gate (no model call). */
  skipped?: boolean
  /** Why it was skipped — the fast path names the signals it found absent. Lives in the JSON record; no column. */
  skipReason?: string
  /**
   * Why the run stopped. ONE discriminant rather than a set of flags, because
   * these are mutually exclusive outcomes and separate booleans would make
   * "cancelled and timed out" representable.
   *
   * The gap this closes is persistence, not memory: the distinction already
   * exists in `runOnce` (`abortReason` separates `'Run cancelled'` from
   * `'Run exceeded the time limit'`, `STALL_MSG` names a stall, `stoppedBecause`
   * carries turns/cost) and is then DISCARDED at the row. So an
   * operator-cancelled run persists as `ok: true, error: undefined` — byte
   * for byte a clean run — and "why did it stop at 3:58?" is unanswerable from
   * the record afterwards.
   *
   *   natural   — the model finished its turn
   *   cancelled — the operator stopped it (not a failure; `ok` stays true)
   *   timeout   — hit the hard run ceiling
   *   stalled   — the activity watchdog fired: silence, not slowness
   *   turns     — hit MAX_TURNS with more to do
   *   cost      — hit the budget cap with more to do
   *   error     — threw; `error` carries the message
   *
   * Optional, and absent means "not recorded" — every run before this has none,
   * and defaulting them to `natural` would invent a fact about history.
   */
  stopReason?: 'natural' | 'cancelled' | 'timeout' | 'stalled' | 'turns' | 'cost' | 'error'
}

/** Compact summary shown in the conversation list. */
export interface AgentSummary {
  config: AgentConfig
  state: AgentState
}

/** Minimal quote shape the P&L helper needs (a subset of ipc.Quote). */
export interface Mark {
  last: number
  prevClose?: number
}

/** One paper agent's all-time standing, for the paper portfolio. */
export interface PaperAgentRow {
  id: string
  name: string
  /** Retired agents are INCLUDED — "all time" means the ones you stopped, too. */
  retired: boolean
  allocationUsd: number
  equity: number
  totalPnl: number
  totalPct: number
  dayPnl: number
  dayPct: number
  /** Booked, from closed trades. Unlike `totalPnl` this needs no marks and is always exact. */
  realizedPnl: number
  openPositions: number
  trades: number
  marked: boolean
  unmarked: string[]
}

/** Every paper book added up. */
export interface PaperPortfolio {
  rows: PaperAgentRow[]
  totalEquity: number
  /**
   * The cash half of `totalEquity`, which is real money in every book regardless
   * of marks. Carried so a surface can say "cash $X · rest at cost" instead of
   * either printing a partly cost-valued total as a mark or blanking a figure
   * that is genuinely true. A position at cost is a floor, not a fiction — the
   * number is right, it just is not a mark, and labelling removes the false
   * implication while keeping the number.
   */
  totalCash: number
  totalAllocated: number
  totalPnl: number
  totalPct: number
  dayPnl: number
  /** Sum of every closed trade across every paper agent, ever. Exact regardless of marks. */
  realizedPnl: number
  positions: { symbol: string; qty: number; value: number; agents: number; marked: boolean }[]
  /**
   * False when ANY held symbol across ANY paper agent lacks a mark. The
   * unrealized figures are then part cost-based, so a surface must say so
   * rather than print them as fact — the same rule `BookPnl.marked` states,
   * carried up to the aggregate where it is easier to forget.
   */
  marked: boolean
  unmarked: string[]
}

/**
 * The paper side of the portfolio: every agent whose book is simulated, added up.
 *
 * ALL-TIME, so retired agents count. Retiring an agent does not un-happen its
 * trades, and a lifetime P&L that quietly drops the ones you stopped would
 * flatter itself every time you cleared out a loser.
 *
 * ⚠️ `symbolsToMark` deliberately skips retired agents, so a retired agent still
 * holding something has no mark and is valued at COST. That is why `marked` and
 * `unmarked` are carried here: `realizedPnl` is exact either way, and it is the
 * number to lead with when marks are incomplete.
 */
export function paperPortfolio(
  agents: readonly { config: AgentConfig; state: AgentState }[],
  marks: Record<string, Mark>,
  todayEt: string,
  etDateOf: (iso: string) => string
): PaperPortfolio {
  return bookPortfolio(agents, 'paper', marks, todayEt, etDateOf)
}

/**
 * The LIVE side: every agent trading real money, each counted by its OWN
 * sub-ledger — only the fills it placed, never the shared Robinhood account
 * (the Robinhood panel is what you own; this is what the agents did). Same
 * shape and rules as the paper side so the two can sit on one page, and
 * deliberately a separate call so no surface can add the two into one number.
 */
export function livePortfolio(
  agents: readonly { config: AgentConfig; state: AgentState }[],
  marks: Record<string, Mark>,
  todayEt: string,
  etDateOf: (iso: string) => string
): PaperPortfolio {
  return bookPortfolio(agents, 'live', marks, todayEt, etDateOf)
}

/** One mode's books added up — the shared body of `paperPortfolio` and `livePortfolio`. */
function bookPortfolio(
  agents: readonly { config: AgentConfig; state: AgentState }[],
  mode: Mode,
  marks: Record<string, Mark>,
  todayEt: string,
  etDateOf: (iso: string) => string
): PaperPortfolio {
  const rows: PaperAgentRow[] = []
  const bySymbol = new Map<string, { qty: number; value: number; agents: number; marked: boolean }>()
  const unmarked = new Set<string>()
  let totalEquity = 0
  let totalCash = 0
  let totalAllocated = 0
  let dayPnl = 0
  let realizedPnl = 0

  for (const a of agents) {
    if (a.config.mode !== mode) continue
    const book = mode === 'live' ? a.state.live : a.state.paper
    const p = bookPnl({ mode, allocationUsd: a.config.allocationUsd }, a.state, marks, todayEt, etDateOf)
    for (const u of p.unmarked) unmarked.add(u)
    rows.push({
      id: a.config.id,
      name: a.config.name,
      retired: a.state.status === 'retired',
      allocationUsd: a.config.allocationUsd,
      equity: p.equity,
      totalPnl: p.totalPnl,
      totalPct: p.totalPct,
      dayPnl: p.dayPnl,
      dayPct: p.dayPct,
      realizedPnl: book.realizedPnl,
      openPositions: book.positions.length,
      trades: book.fills.length,
      marked: p.marked,
      unmarked: p.unmarked
    })
    totalEquity += p.equity
    totalCash += book.cash
    totalAllocated += a.config.allocationUsd
    dayPnl += p.dayPnl
    realizedPnl += book.realizedPnl
    for (const pos of book.positions) {
      const m = marks[pos.symbol]
      const cur = bySymbol.get(pos.symbol) ?? { qty: 0, value: 0, agents: 0, marked: true }
      cur.qty += pos.qty
      cur.value += pos.qty * (m?.last ?? pos.avgCost)
      cur.agents += 1
      if (!m) cur.marked = false
      bySymbol.set(pos.symbol, cur)
    }
  }

  rows.sort((x, y) => y.totalPnl - x.totalPnl)
  const totalPnl = totalEquity - totalAllocated
  return {
    rows,
    totalEquity,
    totalCash,
    totalAllocated,
    totalPnl,
    // Guarded: with no paper agents this is 0/0, and NaN renders as "NaN%".
    totalPct: totalAllocated > 0 ? totalPnl / totalAllocated : 0,
    dayPnl,
    realizedPnl,
    positions: [...bySymbol.entries()]
      .map(([symbol, v]) => ({ symbol, ...v }))
      .sort((x, y) => y.value - x.value),
    marked: unmarked.size === 0,
    unmarked: [...unmarked]
  }
}

export interface BookPnl {
  /** Cash + positions at the latest marks (cost when unmarked). */
  equity: number
  totalPnl: number
  /** vs. the allocation (fraction, 0.012 = +1.2%). */
  totalPct: number
  /** Today's change: fills today + held positions vs. previous close. */
  dayPnl: number
  dayPct: number
  /**
   * False when a held symbol has no mark yet — every figure above is then
   * COST-BASED, which means `dayPct` is 0 and `totalPct` is 0 by construction.
   *
   * Surfaces must not render those as numbers. Cost against cost is exactly
   * zero, so an unmarked book prints a confident green 0.00% for a figure
   * nothing supports.
   */
  marked: boolean
  /** The held symbols with no mark — so a surface can say WHICH, not just "pending". */
  unmarked: string[]
}

/**
 * The agent's own P&L from its book + quotes — the same math on every
 * surface. Today's P&L is a cash-flow identity that needs no intraday snapshot:
 * equity_now − equity_at_day_start, where day-start equity = today's cash
 * flows reversed + positions held at the open at their previous close.
 * `todayEt` is the ET calendar date (yyyy-mm-dd); `etDateOf` maps a fill ts to it.
 */
export function bookPnl(cfg: Pick<AgentConfig, 'mode' | 'allocationUsd'>, state: Pick<AgentState, 'paper' | 'live'>, marks: Record<string, Mark>, todayEt: string, etDateOf: (iso: string) => string): BookPnl {
  const book = ledgerFor(cfg, state)
  const unmarked: string[] = []
  let mv = 0
  for (const p of book.positions) {
    const m = marks[p.symbol]
    if (!m) unmarked.push(p.symbol)
    mv += p.qty * (m?.last ?? p.avgCost)
  }
  const marked = unmarked.length === 0
  const equity = book.cash + mv
  const alloc = Math.max(1, cfg.allocationUsd)
  // Day-start holdings = current − today's buys + today's sells (per symbol).
  const qty0 = new Map<string, number>()
  for (const p of book.positions) qty0.set(p.symbol, p.qty)
  let buyCash = 0
  let sellCash = 0
  /** Today's traded volume per symbol — the day-start reference for a symbol nothing marked. */
  const traded = new Map<string, { qty: number; notional: number }>()
  // Only today's fills move these numbers, and fills are append-ordered — so
  // walk back from the newest and stop at the first one that is not today.
  // Reading the whole (500-cap) list cost an ET-date conversion per fill on
  // every prompt build, to look at a handful of them.
  for (let i = book.fills.length - 1; i >= 0; i--) {
    const f = book.fills[i]
    if (etDateOf(f.ts) !== todayEt) break
    const t = traded.get(f.symbol) ?? { qty: 0, notional: 0 }
    traded.set(f.symbol, { qty: t.qty + f.qty, notional: t.notional + f.qty * f.price })
    if (f.side === 'buy') {
      buyCash += f.qty * f.price
      qty0.set(f.symbol, (qty0.get(f.symbol) ?? 0) - f.qty)
    } else {
      sellCash += f.qty * f.price
      qty0.set(f.symbol, (qty0.get(f.symbol) ?? 0) + f.qty)
    }
  }
  let openValue = 0
  for (const [sym, q] of qty0) {
    if (q <= 0) continue
    const m = marks[sym]
    // A symbol sold today and marked by nothing used to fall to 0 here, so its
    // day-start value vanished and the whole sale read as a day's GAIN — an
    // agent could tell the operator it made thousands on a day it made a few
    // dollars. Today's own fill prices are the honest fallback: the shares
    // are valued at what they actually traded for, so an unmarked sale
    // contributes nothing to the day rather than everything.
    const t = traded.get(sym)
    const ref = m?.prevClose ?? m?.last ?? book.positions.find((p) => p.symbol === sym)?.avgCost ?? (t && t.qty > 0 ? t.notional / t.qty : 0)
    openValue += q * ref
  }
  const dayStartEquity = book.cash - sellCash + buyCash + openValue
  const dayPnl = equity - dayStartEquity
  return {
    equity,
    totalPnl: equity - cfg.allocationUsd,
    totalPct: (equity - cfg.allocationUsd) / alloc,
    dayPnl,
    dayPct: dayStartEquity > 0 ? dayPnl / dayStartEquity : 0,
    marked,
    unmarked
  }
}

export function previewOf(m: Message): string {
  switch (m.role) {
    case 'user':
      return `You: ${m.text}`
    case 'agent':
      // The headline was written to be the one-line answer; a preview built
      // from the first characters of a paragraph was the problem it replaces.
      return m.report?.headline ?? m.text
    case 'system':
      return m.text
    case 'action': {
      const a = m.action
      const amt = a.fillQty ?? a.qty
      const px = a.fillPrice ?? a.limitPrice ?? a.refPrice
      return `${a.side === 'buy' ? 'Bought' : 'Sold'} ${amt ?? ''} ${a.symbol}${px ? ` @ $${px.toFixed(2)}` : ''}${a.status !== 'filled' ? ` (${a.status})` : ''}`
    }
    case 'plan':
      return `Plan: ${m.plan.summary}`
    case 'question':
      return `❓ ${m.text}`
    case 'approval':
      return m.status === 'pending' ? `✋ Needs your OK: ${m.action.summary}` : `${m.status === 'approved' ? '✅' : '🚫'} ${m.action.summary}`
  }
}

/** What `newId` mints — and so the only shape an id that names a folder or file may have. */
export const isStoredId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)

export function newId(prefix = ''): string {
  const rnd = Math.random().toString(36).slice(2, 10)
  return `${prefix}${Date.now().toString(36)}${rnd}`
}
