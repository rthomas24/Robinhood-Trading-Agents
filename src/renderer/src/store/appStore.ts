import { create } from 'zustand'
import { compareAgentSummaries, newId, symbolsToMark, type AgentColor, type AgentSummary, type Message, type Mode } from '@shared/agents'
import { isAsk, type Ask } from '@shared/awaiting'
import type { AgentEvent, ChatGptAuthStatus, ClaudeAuthStatus, ClaudeUsage, LocalStatus, McpStatus, OpenRouterStatus, Quote, RobinhoodStatus, AppSettings, RunDelta } from '@shared/ipc'
import type { ThemeId } from '@shared/themes'
import { providerOf, type Provider } from '@shared/provider'
import { applyCalm, applyTheme } from '@renderer/lib/theme'
import { assignAgent, createGroup, deleteGroup, EMPTY_LAYOUT, moveAgent, moveGroup, pruneLayout, renameGroup, type AgentLayout } from '@shared/agentLayout'
import { COLLAPSED_GROUPS_KEY, placeAgent, readCollapsedGroups } from '@renderer/lib/agentLayout'
import { ipcErrorText } from '@renderer/lib/format'

export interface LiveRun {
  runId: string
  text: string
  thinking: string
  tool: string | null
  /** Set while a transient failure is being retried, so the bubble can say so. */
  retry: { attempt: number; reason: string } | null
  startedAt: number
  /** Every tool the run has called so far, in order, ticked as each result lands — the live bubble's activity list. */
  steps: { name: string; done: boolean }[]
  /**
   * The operator pressed Run now and the run has not reported `start` yet. The
   * bubble shows at once — a click that changes nothing on screen reads as a
   * click that did nothing, and gets pressed again. Replaced by the real run's
   * `start` delta, or dropped by `runNow`'s timeout if nothing ever starts.
   */
  pending?: boolean
}

/** `runId` of the placeholder bubble `runNow` opens before the engine has minted one. */
const PENDING_RUN_ID = 'pending'
/**
 * How long the placeholder waits for a `start`. A run reports within
 * milliseconds unless a gate (paused, retired, held on approval) swallowed it.
 */
const PENDING_TIMEOUT_MS = 8_000
/** "Stopping…" gives up on its own after this: the run may have ended without an event this store saw. */
const STOP_TIMEOUT_MS = 30_000

/**
 * Streaming deltas are batched before they reach the store.
 *
 * A delta arrives per TOKEN. Applying each one immediately meant a new `live`
 * map, a new LiveRun and a thread re-render for every token — hundreds a
 * second. Coalescing into one `set()` per frame-ish window renders identically
 * and costs one to two orders of magnitude less.
 */
const DELTA_FLUSH_MS = 50
/**
 * How long after a run's bubble closes we keep ignoring its stragglers. A
 * vendor stream can yield for a moment after its run ends, and those deltas
 * would otherwise open a fresh bubble for a run whose message has already
 * landed — a ghost that never closes.
 */
const DELTA_TAIL_MS = 2_000
interface PendingDelta {
  agentId: string
  runId: string
  delta: RunDelta
}
let pendingDeltas: PendingDelta[] = []
let deltaTimer: ReturnType<typeof setTimeout> | null = null
const streamClosedAt = new Map<string, number>()

/**
 * New agent may open pre-filled: from a starter template (`templateId`) or a
 * duplicate (`duplicateOf`). `nonce` changes per fill and is the sheet's React
 * key, so a second fill remounts it instead of layering over state — and over
 * a Mode — typed against the first.
 */
export type SheetKind = { kind: 'none' } | { kind: 'new'; templateId?: string; duplicateOf?: string; nonce?: number; initialMode?: Mode } | { kind: 'settings'; agentId: string } | { kind: 'stats'; agentId: string } | { kind: 'connections' } | { kind: 'groups' }
/**
 * Which agents the sidebar lists: every one, or only the paper or only the live
 * ones. A view, never state on the agents. Persisted per computer (`tb:mode-filter`).
 */
export type ModeFilter = 'all' | Mode
const MODE_FILTER_KEY = 'tb:mode-filter'
function readModeFilter(): ModeFilter {
  const v = localStorage.getItem(MODE_FILTER_KEY)
  return v === 'paper' || v === 'live' ? v : 'all'
}
/** What fills the main pane: the selected agent's thread, the account/settings page, the paper book, or the Real time page. */
export type MainView = 'thread' | 'account' | 'paper' | 'realtime'

/**
 * Calm mode: the operator wants to read the fleet without the money shouting.
 * Desktop-local, and read BEFORE React mounts (main.tsx) so the first frame is
 * already drained — a P&L column that flashes green and then greys is worse
 * than one that never coloured.
 */
export const CALM_KEY = 'tb:calm'
export const readCalm = (): boolean => localStorage.getItem(CALM_KEY) === '1'

/** The sections of the Settings page (`components/account/AccountPage.tsx`). */
export type AccountSection = 'connections' | 'safety' | 'local' | 'mcp' | 'robinhood' | 'preferences'

interface AppState {
  booted: boolean
  agents: Record<string, AgentSummary>
  order: string[]
  selectedId: string | null
  view: MainView
  messages: Record<string, Message[]>
  hasMore: Record<string, boolean>
  live: Record<string, LiveRun | undefined>
  /**
   * The operator's messages that are in flight, or failed to send. The bubble
   * goes up BEFORE the engine answers and stays up either way — a send that
   * fails keeps the operator's words on screen under "Not sent · Try again"
   * rather than clearing the box and throwing the text away.
   */
  msgStatus: Record<string, 'sending' | 'failed'>
  /** Agents whose Stop was pressed and whose run has not yet ended — the button says "Stopping…" meanwhile. */
  stopping: Record<string, boolean>
  claude: ClaudeAuthStatus | null
  /** The operator's ChatGPT subscription (desktop vendor; tokens stay in main). */
  chatgpt: ChatGptAuthStatus | null
  claudeUsage: ClaudeUsage | null
  robinhood: RobinhoodStatus | null
  /** The operator's OpenRouter key, as the renderer may see it (the key itself never leaves main). */
  openrouter: OpenRouterStatus | null
  /** Local GPU engine (null until Settings → Local models is opened or a Local GPU agent exists). */
  local: LocalStatus | null
  settings: AppSettings | null
  mcp: McpStatus | null
  /** Renderer-side connectivity (navigator.onLine): offline, only Local GPU agents can think — the status bar says so. */
  online: boolean
  sheet: SheetKind
  search: string
  /** Sidebar: all agents, or only paper / only live ones. Persisted per computer. */
  modeFilter: ModeFilter
  portfolioOpen: boolean
  sidebarCollapsed: boolean
  /** Width of the expanded sidebar in px — the operator drags its right edge (clamped to SIDEBAR_MIN..SIDEBAR_MAX). */
  sidebarWidth: number
  /**
   * How the agents are arranged — groups, membership, manual order
   * (`shared/agentLayout.ts`), saved by main in `userData/layout.json`.
   * Normalized, NOT pruned: the sidebar prunes at render and every edit prunes
   * before writing, so an agent that is missing for a moment never loses its
   * place in the stored document.
   */
  layout: AgentLayout
  /** Group ids whose section is folded. A viewing preference (localStorage), never in the layout document. */
  collapsedGroups: string[]
  /** The last layout write that failed, for the sidebar to show; cleared by the next successful one. */
  layoutError: string | null
  /** The ⌘K command palette. One flag: it is a single overlay, never per-surface. */
  paletteOpen: boolean
  /** P&L colour drained app-wide (`data-calm` on <html>). Safety signals are exempt by rule. */
  calm: boolean

  /**
   * The Settings section a caller asked for, with a nonce so asking again for
   * the section already open still lands there (the page may have been moved
   * to another section by hand in between).
   */
  accountSection: { id: AccountSection; nonce: number } | null

  boot(): Promise<void>
  select(id: string | null): void
  /** Show Settings; with a section, open it there ("Set up" → Local models). */
  openAccount(section?: AccountSection): void
  /** The all-time paper book, every simulated agent including retired ones. */
  openPaper(): void
  /** Real-time paper agents decided by the System One model. */
  openRealtime(): void
  loadMessages(id: string, more?: boolean): Promise<void>
  applyEvent(e: AgentEvent): void
  /** Apply one coalesced batch of streaming deltas (see DELTA_FLUSH_MS). */
  flushDeltas(): void
  openSheet(s: SheetKind): void
  setPaletteOpen(open: boolean): void
  /** Toggle the P&L drain, persisted per computer and applied to <html> at once. */
  setCalm(on: boolean): void
  /** Run now: opens the typing bubble immediately, then asks the engine. Repeat clicks while it starts are no-ops. */
  runNow(agentId: string): Promise<void>
  /** The operator's message: on screen at once, marked failed (never dropped) if the engine refuses it. Sent mid-run, it is QUEUED behind that run (shared/messageQueue.ts). */
  send(agentId: string, text: string): Promise<void>
  /** Try a failed message again — same words, a fresh attempt. */
  resend(agentId: string, messageId: string): Promise<void>
  /** Give up on a failed message. */
  discardMessage(agentId: string, messageId: string): void
  /** Stop the run in flight. Queued messages go out as soon as it stops. */
  stopRun(agentId: string): Promise<void>
  setSearch(q: string): void
  setModeFilter(f: ModeFilter): void
  togglePortfolio(): void
  toggleSidebar(): void
  setSidebarCollapsed(collapsed: boolean): void
  setSidebarWidth(px: number): void
  /**
   * Replace the arrangement: on screen at once, then written through main. A
   * failed write puts the previous document back and the reason in `layoutError`.
   */
  setLayout(next: AgentLayout): Promise<void>
  /** Reorder within what the operator is looking at: `visibleIds` is that section in display order. */
  moveAgentTo(agentId: string, visibleIds: readonly string[], toIndex: number): Promise<void>
  /** Drop into a section at an index (assign + reorder in one write). `sectionIds` = the target section's ids in display order. */
  placeAgentAt(agentId: string, groupId: string | null, sectionIds: readonly string[], toIndex: number): Promise<void>
  assignAgentToGroup(agentId: string, groupId: string | null): Promise<void>
  /** Returns the shared refusal sentence (name taken, cap reached) instead of writing, or null on success. */
  createGroup(name: string, color?: AgentColor): Promise<string | null>
  renameGroup(id: string, name: string, color?: AgentColor | null): Promise<void>
  deleteGroup(id: string): Promise<void>
  moveGroup(id: string, toIndex: number): Promise<void>
  toggleGroupCollapsed(id: string): void
  setTheme(theme: ThemeId): Promise<void>
  /** The status-bar switcher: default provider for NEW agents (existing agents keep theirs). */
  setDefaultProvider(p: Provider): Promise<void>
  /** Latest quotes for every symbol the active agents hold (sidebar P&L marks). */
  marks: Record<string, Quote>
  /** Every open ask across all agents, oldest first (shared/awaiting.ts). */
  asks: Ask[]
  refreshMarks(): Promise<void>
  refreshAsks(): Promise<void>
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  refreshSettings(): Promise<void>
  refreshMcp(): Promise<void>
  refreshLocal(): Promise<void>
  refreshConnections(): Promise<void>
  setOpenRouter(status: OpenRouterStatus | null): void
}

/** How often the ask list re-ages. A question deadline is the only ask that expires without an event. */
const ASKS_POLL_MS = 20_000

function sortIds(agents: Record<string, AgentSummary>): string[] {
  return Object.values(agents).sort(compareAgentSummaries).map((a) => a.config.id)
}

/** Sidebar sizing — the drag handle, the collapsed rail and the store all agree on these. */
export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 560
export const SIDEBAR_DEFAULT = 300
/** Width of the icons-only rail. */
export const SIDEBAR_RAIL = 68
/** Dragging narrower than this snaps to the collapsed rail; dragging the rail wider than this re-expands. */
export const SIDEBAR_SNAP = 160

const clampSidebar = (px: number): number => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)))

let bootStarted = false

export const useApp = create<AppState>((set, get) => ({
  booted: false,
  agents: {},
  order: [],
  selectedId: null,
  view: 'thread',
  accountSection: null,
  messages: {},
  hasMore: {},
  live: {},
  msgStatus: {},
  stopping: {},
  claude: null,
  chatgpt: null,
  claudeUsage: null,
  robinhood: null,
  openrouter: null,
  marks: {},
  asks: [],
  local: null,
  settings: null,
  mcp: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  sheet: { kind: 'none' },
  search: '',
  modeFilter: readModeFilter(),
  portfolioOpen: localStorage.getItem('tb:portfolio') === '1',
  sidebarCollapsed: localStorage.getItem('tb:sidebar') === '1',
  sidebarWidth: clampSidebar(Number(localStorage.getItem('tb:sidebar-w')) || SIDEBAR_DEFAULT),
  layout: EMPTY_LAYOUT,
  collapsedGroups: readCollapsedGroups(),
  layoutError: null,
  paletteOpen: false,
  calm: readCalm(),

  async boot() {
    // StrictMode mounts App twice in dev — never double-subscribe the bridges.
    if (bootStarted) return
    bootStarted = true
    const [list, claude, chatgpt, claudeUsage, robinhood, openrouter, settings, mcp, layout] = await Promise.all([
      window.tb.agents.list(),
      window.tb.claude.status(),
      window.tb.chatgpt.status().catch(() => null),
      window.tb.claude.usage().catch(() => null),
      window.tb.robinhood.status(),
      window.tb.openrouter.status().catch(() => null),
      window.tb.settings.get(),
      window.tb.mcp.status().catch(() => null),
      window.tb.layout.get().catch(() => EMPTY_LAYOUT)
    ])
    const agents = Object.fromEntries(list.map((a) => [a.config.id, a]))
    const order = sortIds(agents)
    const selectedId = localStorage.getItem('tb:selected') && agents[localStorage.getItem('tb:selected')!] ? localStorage.getItem('tb:selected') : (order[0] ?? null)
    set({ agents, order, selectedId, claude, chatgpt, claudeUsage, robinhood, openrouter, settings, mcp, layout, booted: true })
    void get().refreshAsks()
    // Asks used to refresh only when a message arrived, and one of them now ages
    // out on a CLOCK rather than an event: a question whose deadline passes stops
    // being an ask with nothing happening at all. Without this the row sat in
    // "Waiting on you" until some unrelated message happened to arrive.
    setInterval(() => void get().refreshAsks(), ASKS_POLL_MS)
    if (settings.theme) localStorage.setItem('tb:theme', applyTheme(settings.theme))
    if (selectedId) void get().loadMessages(selectedId)
    window.tb.agents.onEvent((e) => get().applyEvent(e))
    window.tb.onAuthEvent((e) => {
      if (e.kind === 'claude') set({ claude: e.status })
      else if (e.kind === 'chatgpt') set({ chatgpt: e.status })
      else if (e.kind === 'usage') set({ claudeUsage: e.usage })
      else if (e.kind === 'openrouter') set({ openrouter: e.status })
      else set({ robinhood: e.status })
    })
    window.tb.local.onEvent((e) => set({ local: e.status }))
    window.addEventListener('online', () => set({ online: true }))
    window.addEventListener('offline', () => set({ online: false }))
    // Any Local GPU agent (or default) → the engine is in play; surface its status without opening the page.
    if (settings.defaultProvider === 'local' || list.some((a) => providerOf(a.config) === 'local')) void get().refreshLocal()
  },

  /**
   * Re-read the local engine AND the settings it may have changed.
   *
   * Starting a model makes it the default (`local/engine.ts`:
   * `if (cur.modelId !== modelId) settingsStore.save(...)`), so main's settings
   * change without the renderer asking for it. Reading only `LocalStatus` left
   * the two copies disagreeing: `local.defaultModelId` was fresh, so the model
   * showed a "default" pill, while `settings.localModel.modelId` stayed null —
   * and everything gated on THAT said the GPU was not set up. The picker
   * offered "Set up", the New-agent sheet offered "Set up", and the enable
   * toggle stayed disabled saying "pick a default model below", next to a model
   * already labelled default.
   *
   * The gate in main read main's settings, which were correct all along — so
   * the provider genuinely worked and only the UI claimed it did not. That is
   * the worst version: nothing was broken, and every surface said it was.
   */
  async refreshLocal() {
    const [local] = await Promise.all([window.tb.local.status().catch(() => null), get().refreshSettings()])
    set({ local })
  },

  select(id) {
    set({ selectedId: id, view: 'thread' })
    if (id) {
      localStorage.setItem('tb:selected', id)
      if (!get().messages[id]) void get().loadMessages(id)
      void window.tb.agents.markRead(id)
    }
  },

  openPaper() {
    set({ view: 'paper', sheet: { kind: 'none' } })
  },
  openRealtime() {
    set({ view: 'realtime', sheet: { kind: 'none' } })
  },
  openAccount(section) {
    set((s) => ({
      view: 'account',
      sheet: { kind: 'none' },
      ...(section ? { accountSection: { id: section, nonce: (s.accountSection?.nonce ?? 0) + 1 } } : {})
    }))
    void get().refreshMcp()
  },

  async loadMessages(id, more = false) {
    const existing = get().messages[id] ?? []
    const page = await window.tb.agents.messages(id, { before: more ? existing[0]?.id : undefined, limit: 60 })
    set((s) => ({
      messages: { ...s.messages, [id]: more ? [...page.messages, ...existing] : page.messages },
      hasMore: { ...s.hasMore, [id]: page.hasMore }
    }))
  },

  applyEvent(e) {
    switch (e.type) {
      case 'agent:updated': {
        set((s) => {
          const agents = { ...s.agents, [e.summary.config.id]: e.summary }
          // The run the operator was stopping has ended (however it ended).
          if (!e.summary.state.running && s.stopping[e.summary.config.id]) {
            const stopping = { ...s.stopping }
            delete stopping[e.summary.config.id]
            return { agents, order: sortIds(agents), stopping }
          }
          return { agents, order: sortIds(agents) }
        })
        if (e.summary.config.id === get().selectedId && get().view === 'thread' && e.summary.state.unread) void window.tb.agents.markRead(e.summary.config.id)
        break
      }
      case 'agent:deleted':
        set((s) => {
          const agents = { ...s.agents }
          delete agents[e.agentId]
          const order = sortIds(agents)
          return { agents, order, selectedId: s.selectedId === e.agentId ? (order[0] ?? null) : s.selectedId }
        })
        break
      case 'message:new':
        set((s) => {
          const list = s.messages[e.message.agentId]
          if (!list) return {}
          if (list.some((m) => m.id === e.message.id)) return {}
          // The engine's copy of a message this store put up optimistically.
          // It can land BEFORE `send()` resolves, and for a moment the thread
          // would show the same words twice — "Sending…" above, "Queued" below.
          // The in-flight copy with the same text leaves the moment the real
          // row arrives; `send()` still clears its own on resolve.
          const m = e.message
          const ghost = m.role === 'user' ? list.find((x) => x.role === 'user' && s.msgStatus[x.id] === 'sending' && x.text === m.text) : undefined
          const kept = ghost ? list.filter((x) => x.id !== ghost.id) : list
          const msgStatus = ghost ? Object.fromEntries(Object.entries(s.msgStatus).filter(([id]) => id !== ghost.id)) : s.msgStatus
          return { messages: { ...s.messages, [m.agentId]: [...kept, m] }, msgStatus }
        })
        // A card that ASKS something arrives as an ordinary message, and one
        // that is answered arrives as an update — so both refresh the list.
        // Recomputed in main rather than patched here: this store only holds
        // threads that have been opened, and the whole point of the bar is the
        // agent you have NOT looked at.
        if (isAsk(e.message)) void get().refreshAsks()
        break
      case 'message:updated':
        set((s) => {
          const list = s.messages[e.message.agentId]
          if (!list) return {}
          return { messages: { ...s.messages, [e.message.agentId]: list.map((m) => (m.id === e.message.id ? e.message : m)) } }
        })
        void get().refreshAsks()
        break
      case 'run:delta': {
        pendingDeltas.push({ agentId: e.agentId, runId: e.runId, delta: e.delta })
        deltaTimer ??= setTimeout(() => get().flushDeltas(), DELTA_FLUSH_MS)
        break
      }
    }
  },

  /** Apply one batch of streaming deltas, in the order main emitted them. */
  flushDeltas() {
    deltaTimer = null
    const batch = pendingDeltas
    pendingDeltas = []
    if (!batch.length) return
    set((s) => {
      const live = { ...s.live }
      /** Runs that ended in this batch — a pending Stop on them is done. */
      const ended: string[] = []
      for (const { agentId, runId, delta: d } of batch) {
        const cur = live[agentId]
        // The tail of a run whose message has already landed. Without this a
        // straggler opens a fresh bubble for a finished run, and nothing closes it.
        if (!cur && d.kind !== 'start' && Date.now() - (streamClosedAt.get(agentId) ?? 0) < DELTA_TAIL_MS) continue
        // `live` is keyed by AGENT, so a delta belonging to a run this bubble is
        // no longer showing — a superseded retry attempt, or the previous run's
        // tail — would otherwise append into the current run's text. That is the
        // spliced, half-scrambled bubble. Only `start` may claim it for a new run.
        // NOT redundant with the tail guard above, and neither subsumes the
        // other: this one fires only when a bubble EXISTS for a different run,
        // that one only when no bubble exists at all. Deleting either reopens a
        // different hole.
        if (cur && d.kind !== 'start' && cur.runId !== runId) continue
        const base: LiveRun = cur ?? { runId, text: '', thinking: '', tool: null, retry: null, startedAt: Date.now(), steps: [] }
        switch (d.kind) {
          case 'start':
            live[agentId] = { runId, text: '', thinking: '', tool: null, retry: null, startedAt: Date.now(), steps: [] }
            break
          case 'end':
            // Delete rather than store `undefined` — an ended run should leave
            // no key behind in a map that is rebuilt on every flush.
            delete live[agentId]
            streamClosedAt.set(agentId, Date.now())
            ended.push(agentId)
            break
          case 'text':
            live[agentId] = { ...base, text: base.text + d.text, tool: null, retry: null }
            break
          case 'thinking':
            live[agentId] = { ...base, thinking: (base.thinking + d.text).slice(-600), retry: null }
            break
          case 'tool':
            live[agentId] = { ...base, tool: d.name, retry: null, steps: [...base.steps, { name: d.name, done: false }] }
            break
          case 'tool_result': {
            // Tick the newest un-ticked step of that name; a vendor that runs a
            // turn's calls concurrently may settle them out of order.
            const steps = base.steps.slice()
            for (let i = steps.length - 1; i >= 0; i--) {
              if (steps[i].name === d.name && !steps[i].done) {
                steps[i] = { ...steps[i], done: true }
                break
              }
            }
            live[agentId] = { ...base, tool: null, steps }
            break
          }
          case 'retry':
            // A retry regenerates the whole reply, so everything streamed so far
            // is void. Keeping it appended attempt 2's reply to attempt 1's
            // partial — the duplicated message in the thread.
            live[agentId] = { ...base, text: '', thinking: '', tool: null, retry: { attempt: d.attempt, reason: d.reason }, steps: [] }
            break
        }
      }
      if (!ended.some((id) => s.stopping[id])) return { live }
      const stopping = { ...s.stopping }
      for (const id of ended) delete stopping[id]
      return { live, stopping }
    })
  },

  openSheet(sheet) {
    set({ sheet })
  },
  setPaletteOpen(paletteOpen) {
    set({ paletteOpen })
  },
  setCalm(calm) {
    localStorage.setItem(CALM_KEY, calm ? '1' : '0')
    applyCalm(calm)
    set({ calm })
  },
  async runNow(agentId) {
    // Already running, or already starting: nothing more to ask for.
    if (get().live[agentId] || get().agents[agentId]?.state.running) return
    set((s) => ({ live: { ...s.live, [agentId]: { runId: PENDING_RUN_ID, pending: true, text: '', thinking: '', tool: null, retry: null, startedAt: Date.now(), steps: [] } } }))
    const dropPlaceholder = (): void =>
      set((s) => {
        if (!s.live[agentId]?.pending) return {}
        const live = { ...s.live }
        delete live[agentId]
        return { live }
      })
    try {
      await window.tb.agents.runNow(agentId)
    } catch {
      dropPlaceholder()
      return
    }
    // If no `start` arrives — a gate swallowed the run — the placeholder must
    // not outlive the truth.
    setTimeout(dropPlaceholder, PENDING_TIMEOUT_MS)
  },
  async send(agentId, text) {
    // Up on screen now; the engine's copy takes its place when it lands
    // (`message:new`) and this one leaves.
    const optimistic: Message = { id: newId('m_'), agentId, ts: new Date().toISOString(), role: 'user', text }
    // And the agent's bubble opens NOW when nothing is in flight — the reply
    // run's `start` is a moment away (the reply debounce, then context), and a
    // thread that shows nothing for that moment reads as ignoring you. When a
    // run IS in flight the message is queued behind it instead, and that bubble
    // is already up.
    const placeholder = !get().live[agentId] && !get().agents[agentId]?.state.running
    set((s) => ({
      messages: { ...s.messages, [agentId]: [...(s.messages[agentId] ?? []), optimistic] },
      msgStatus: { ...s.msgStatus, [optimistic.id]: 'sending' },
      ...(placeholder ? { live: { ...s.live, [agentId]: { runId: PENDING_RUN_ID, pending: true, text: '', thinking: '', tool: null, retry: null, startedAt: Date.now(), steps: [] } } } : {})
    }))
    const dropPlaceholder = (): void =>
      set((s) => {
        if (!s.live[agentId]?.pending) return {}
        const live = { ...s.live }
        delete live[agentId]
        return { live }
      })
    if (placeholder) setTimeout(dropPlaceholder, PENDING_TIMEOUT_MS)
    try {
      await window.tb.agents.send(agentId, text)
      set((s) => {
        const msgStatus = { ...s.msgStatus }
        delete msgStatus[optimistic.id]
        return { messages: { ...s.messages, [agentId]: (s.messages[agentId] ?? []).filter((m) => m.id !== optimistic.id) }, msgStatus }
      })
    } catch {
      // Keep the bubble — a message that vanishes on failure loses what the
      // person wrote. It carries the failure and a retry instead. No reply is
      // coming, so the agent's placeholder goes.
      set((s) => ({ msgStatus: { ...s.msgStatus, [optimistic.id]: 'failed' } }))
      dropPlaceholder()
    }
  },
  async resend(agentId, messageId) {
    const failed = get().messages[agentId]?.find((m) => m.id === messageId)
    if (failed?.role !== 'user') return
    get().discardMessage(agentId, messageId)
    await get().send(agentId, failed.text)
  },
  discardMessage(agentId, messageId) {
    set((s) => {
      const msgStatus = { ...s.msgStatus }
      delete msgStatus[messageId]
      return { messages: { ...s.messages, [agentId]: (s.messages[agentId] ?? []).filter((m) => m.id !== messageId) }, msgStatus }
    })
  },
  async stopRun(agentId) {
    if (get().stopping[agentId]) return
    set((s) => ({ stopping: { ...s.stopping, [agentId]: true } }))
    const clear = (): void =>
      set((s) => {
        if (!s.stopping[agentId]) return {}
        const stopping = { ...s.stopping }
        delete stopping[agentId]
        return { stopping }
      })
    try {
      await window.tb.agents.stop(agentId)
    } catch {
      clear()
      return
    }
    // Cleared for real when the run ends (`agent:updated` with running=false,
    // or the stream's `end`); this is the ceiling in case neither arrives.
    setTimeout(clear, STOP_TIMEOUT_MS)
  },
  setSearch(search) {
    set({ search })
  },
  setModeFilter(modeFilter) {
    if (get().modeFilter === modeFilter) return
    localStorage.setItem(MODE_FILTER_KEY, modeFilter)
    set({ modeFilter })
  },
  togglePortfolio() {
    const next = !get().portfolioOpen
    localStorage.setItem('tb:portfolio', next ? '1' : '0')
    set({ portfolioOpen: next })
  },
  setSidebarCollapsed(collapsed) {
    if (get().sidebarCollapsed === collapsed) return
    localStorage.setItem('tb:sidebar', collapsed ? '1' : '0')
    set({ sidebarCollapsed: collapsed })
  },
  setSidebarWidth(px) {
    const w = clampSidebar(px)
    if (get().sidebarWidth === w) return
    localStorage.setItem('tb:sidebar-w', String(w))
    set({ sidebarWidth: w })
  },
  async setLayout(next) {
    const prev = get().layout
    const ids = Object.keys(get().agents)
    const layout = pruneLayout(next, ids)
    set({ layout, layoutError: null })
    try {
      const r = await window.tb.layout.set(layout)
      if (!r.ok) {
        console.warn('[layout] write refused', r.detail)
        set({ layout: prev, layoutError: r.detail ?? 'Could not save the arrangement.' })
      }
    } catch (e) {
      console.error('[layout] write failed', e)
      set({ layout: prev, layoutError: ipcErrorText(e) || 'Could not save the arrangement.' })
    }
  },
  moveAgentTo(agentId, visibleIds, toIndex) {
    return get().setLayout(moveAgent(get().layout, visibleIds, agentId, toIndex))
  },
  placeAgentAt(agentId, groupId, sectionIds, toIndex) {
    return get().setLayout(placeAgent(get().layout, agentId, groupId, sectionIds, toIndex))
  },
  assignAgentToGroup(agentId, groupId) {
    return get().setLayout(assignAgent(get().layout, agentId, groupId))
  },
  async createGroup(name, color) {
    const r = createGroup(get().layout, name, color)
    if (!r.group) return r.error ?? 'Could not create the group.'
    await get().setLayout(r.layout)
    return get().layoutError
  },
  renameGroup(id, name, color) {
    return get().setLayout(renameGroup(get().layout, id, name, color))
  },
  deleteGroup(id) {
    return get().setLayout(deleteGroup(get().layout, id))
  },
  moveGroup(id, toIndex) {
    return get().setLayout(moveGroup(get().layout, id, toIndex))
  },
  toggleGroupCollapsed(id) {
    const cur = get().collapsedGroups
    const next = cur.includes(id) ? cur.filter((g) => g !== id) : [...cur, id]
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(next))
    set({ collapsedGroups: next })
  },
  toggleSidebar() {
    const next = !get().sidebarCollapsed
    localStorage.setItem('tb:sidebar', next ? '1' : '0')
    set({ sidebarCollapsed: next })
  },
  async setTheme(theme) {
    localStorage.setItem('tb:theme', applyTheme(theme))
    const settings = await window.tb.settings.set({ theme })
    set({ settings })
  },
  async setDefaultProvider(p) {
    await get().updateSettings({ defaultProvider: p })
    if (p === 'local') void get().refreshLocal()
  },
  async updateSettings(patch) {
    // Optimistic: the toggles feel instant; main returns the normalized truth.
    const cur = get().settings
    if (cur) set({ settings: { ...cur, ...patch } })
    const settings = await window.tb.settings.set(patch)
    set({ settings })
  },
  /** Re-read settings from main. Needed when something OTHER than `updateSettings` changed them — the trading halt has its own IPC, and starting a local model makes it the default. */
  async refreshSettings() {
    const settings = await window.tb.settings.get().catch(() => null)
    if (settings) set({ settings })
  },
  async refreshMcp() {
    const mcp = await window.tb.mcp.status().catch(() => null)
    set({ mcp })
  },
  async refreshConnections() {
    const [claude, chatgpt, claudeUsage, robinhood, openrouter] = await Promise.all([
      window.tb.claude.status(),
      window.tb.chatgpt.status().catch(() => null),
      window.tb.claude.usage().catch(() => null),
      window.tb.robinhood.status(),
      window.tb.openrouter.status().catch(() => null)
    ])
    set({ claude, chatgpt, claudeUsage, robinhood, openrouter })
  },
  setOpenRouter(openrouter) {
    set({ openrouter })
  },
  async refreshAsks() {
    try {
      set({ asks: await window.tb.agents.awaiting() })
    } catch (e) {
      // NOT swallowed. The first version of this was `.catch(() => null)`, and
      // it hid the fact that the main-process handler had never been
      // registered: the call rejected on every refresh, the list stayed empty,
      // and the bar simply never appeared — with nothing anywhere saying why.
      // An empty bar and a broken bar look identical, so the broken one has to
      // say so.
      console.error('[asks] could not read what is waiting — the bar will be empty', e)
    }
  },
  async refreshMarks() {
    const { agents } = get()
    // `symbolsToMark` is the one rule for which symbols the fleet needs priced.
    // Main answers from Robinhood when connected, else from a market-data key,
    // else with nothing — so paper agents are marked without a broker too.
    const syms = symbolsToMark(Object.values(agents))
    if (syms.length === 0) return
    try {
      const qs = await window.tb.robinhood.quotes(syms)
      set({ marks: Object.fromEntries(qs.map((q) => [q.symbol, q])) })
    } catch {
      /* keep the last marks */
    }
  }
}))
