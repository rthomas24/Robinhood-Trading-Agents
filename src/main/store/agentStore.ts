import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, appendFileSync } from 'node:fs'
import { readJson, writeFileAtomic, writeJson } from './json'
import { join } from 'node:path'
import { compareAgentSummaries, defaultModelFor, isStoredId, DEFAULT_ALLOCATION_USD, DEFAULT_GUARDRAILS, DEFAULT_MODEL, initialState, type AgentConfig, type AgentState, type AgentSummary, type Message, type RunRecord } from '@shared/agents'
import type { AgentStorage } from '@core/runner/types'
import { searchThreadMessages } from '@core/runner/threadSearch'
import type { DecisionRecord } from '@shared/decisions'
import type { DecisionQuery } from '@shared/ipc'
import { etClock } from '@shared/marketTime'

/**
 * Human-inspectable JSON persistence:
 *   userData/agents/<id>/{config.json,state.json,messages.jsonl,runs.jsonl}
 * Writes are small and synchronous; JSON files go through tmp+rename for atomicity.
 */
function root(): string {
  const dir = join(app.getPath('userData'), 'agents')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
/** `newId` mints letters, digits and `_`; anything else never becomes a folder name. */
function pathOf(id: string): string {
  if (!isStoredId(id)) throw new Error(`Invalid agent id: ${JSON.stringify(String(id).slice(0, 40))}`)
  return join(root(), id)
}
function dirOf(id: string): string {
  const d = pathOf(id)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as T)
    } catch {
      /* skip corrupt line */
    }
  }
  return out
}

/**
 * Migrate configs written by older builds so the runtime can assume every field
 * is present (the prompt/guardrail composers format these directly). Covers
 * added fields and one rename: `paperStartingCash` became `allocationUsd` when
 * the allocation started seeding the live sub-ledger too.
 */
function normalizeConfig(c: AgentConfig & { paperStartingCash?: number }): AgentConfig {
  return {
    ...c,
    guardrails: { ...DEFAULT_GUARDRAILS, ...(c.guardrails ?? {}) },
    // Missing fields come from the agent's OWN vendor's default — Claude's id
    // under an OpenRouter agent would be a model that provider does not have.
    model: { ...defaultModelFor(c.model?.vendor ?? DEFAULT_MODEL.vendor), ...(c.model ?? {}) },
    allocationUsd: c.allocationUsd ?? c.paperStartingCash ?? DEFAULT_ALLOCATION_USD,
    retirement: c.retirement ?? null,
    liveArmedAt: c.liveArmedAt ?? null
  }
}
function normalizeState(s: AgentState, c: AgentConfig): AgentState {
  const base = initialState(c)
  return { ...base, ...s, paper: { ...base.paper, ...(s.paper ?? {}) }, live: { ...base.live, ...(s.live ?? {}) }, running: false }
}

// In-memory caches: the engine and IPC layer read config/state far more often
// than they change, and all writes flow through this module.
const cfgCache = new Map<string, AgentConfig>()
const stateCache = new Map<string, AgentState>()

// In-memory message cache per agent (messages.jsonl can grow; we keep the tail hot).
const msgCache = new Map<string, Message[]>()
export const MSG_CACHE_MAX = 400

/*
 * The run and decision logs are append-only and grow for an agent's whole life,
 * while their readers want the newest rows — the open thread's run strip after
 * every run, the run prompt's recent refusals, the stats sheet — or one row per
 * day (the portfolio timeline). Each agent's log is parsed ONCE and these are
 * kept current by the appends below (this module is the only writer); only a
 * request deeper than the tail reads the file again.
 */
const RUNS_TAIL = 500
const DECISIONS_TAIL = 1000
interface RunLog {
  /** The newest `RUNS_TAIL` distinct runs: one id, one run, the last copy wins (Map order = first appearance). */
  tail: Map<string, RunRecord>
  /** The tail holds every run in the file. */
  complete: boolean
  /** Per ET day, the last run that recorded a book — what the timeline draws (`dailyRowsFromRuns`). */
  booked: Map<string, RunRecord>
}
const runLogs = new Map<string, RunLog>()
const decisionTails = new Map<string, { rows: DecisionRecord[]; complete: boolean }>()

/** Keep `r` as its day's booked run when it is the newest one (a re-written copy of the same run replaces itself). */
function noteBooked(booked: Map<string, RunRecord>, r: RunRecord): void {
  if (!r.book) return
  const at = r.endedAt || r.startedAt
  const day = etClock(new Date(at)).date
  const cur = booked.get(day)
  const curAt = cur ? cur.endedAt || cur.startedAt : ''
  if (!cur || at > curAt || (at === curAt && cur.id === r.id)) booked.set(day, r)
}
function trimFront<K, V>(m: Map<K, V>, max: number): boolean {
  let trimmed = false
  while (m.size > max) {
    m.delete(m.keys().next().value as K)
    trimmed = true
  }
  return trimmed
}
function runLog(agentId: string): RunLog {
  let log = runLogs.get(agentId)
  if (!log) {
    const tail = new Map<string, RunRecord>()
    const booked = new Map<string, RunRecord>()
    for (const r of readJsonl<RunRecord>(join(dirOf(agentId), 'runs.jsonl'))) {
      tail.set(r.id, r)
      noteBooked(booked, r)
    }
    log = { tail, complete: !trimFront(tail, RUNS_TAIL), booked }
    runLogs.set(agentId, log)
  }
  return log
}
function decisionTail(agentId: string): { rows: DecisionRecord[]; complete: boolean } {
  let t = decisionTails.get(agentId)
  if (!t) {
    const all = readJsonl<DecisionRecord>(join(dirOf(agentId), 'decisions.jsonl'))
    t = { rows: all.slice(-DECISIONS_TAIL), complete: all.length <= DECISIONS_TAIL }
    decisionTails.set(agentId, t)
  }
  return t
}

function loadMessages(id: string): Message[] {
  let m = msgCache.get(id)
  if (!m) {
    m = readJsonl<Message>(join(dirOf(id), 'messages.jsonl'))
    if (m.length > MSG_CACHE_MAX) m = m.slice(-MSG_CACHE_MAX)
    msgCache.set(id, m)
  }
  return m
}

export const agentStore = {
  list(): AgentSummary[] {
    const out: AgentSummary[] = []
    for (const id of readdirSync(root(), { withFileTypes: true }).filter((d) => d.isDirectory() && isStoredId(d.name)).map((d) => d.name)) {
      const cfg = this.getConfig(id)
      const st = this.getState(id)
      if (cfg && st) out.push({ config: cfg, state: st })
    }
    return out.sort(compareAgentSummaries)
  },
  getConfig(id: string): AgentConfig | null {
    const hit = cfgCache.get(id)
    if (hit) return hit
    const c = readJson<AgentConfig>(join(pathOf(id), 'config.json'))
    if (!c) return null
    const norm = normalizeConfig(c)
    cfgCache.set(id, norm)
    return norm
  },
  getState(id: string): AgentState | null {
    const hit = stateCache.get(id)
    if (hit) return hit
    const c = this.getConfig(id)
    if (!c) return null
    const s = readJson<AgentState>(join(pathOf(id), 'state.json'))
    const norm = normalizeState(s ?? initialState(c), c)
    stateCache.set(id, norm)
    return norm
  },
  saveConfig(cfg: AgentConfig): void {
    cfgCache.set(cfg.id, normalizeConfig(cfg))
    writeJson(join(dirOf(cfg.id), 'config.json'), cfg)
  },
  saveState(id: string, state: AgentState): void {
    const persisted = { ...state, running: false }
    stateCache.set(id, persisted)
    writeJson(join(dirOf(id), 'state.json'), persisted)
  },
  create(cfg: AgentConfig): AgentSummary {
    this.saveConfig(cfg)
    const state = initialState(cfg)
    this.saveState(cfg.id, state)
    return { config: cfg, state }
  },
  delete(id: string): void {
    msgCache.delete(id)
    cfgCache.delete(id)
    stateCache.delete(id)
    runLogs.delete(id)
    decisionTails.delete(id)
    rmSync(pathOf(id), { recursive: true, force: true })
  },
  appendMessage(m: Message): void {
    // Load (and populate) the cache BEFORE appending to the file — a cold cache
    // reads the file, and appending first would make the new message show up
    // twice (once from the file read, once from the push below).
    const cache = loadMessages(m.agentId)
    appendFileSync(join(dirOf(m.agentId), 'messages.jsonl'), `${JSON.stringify(m)}\n`)
    cache.push(m)
    if (cache.length > MSG_CACHE_MAX) cache.splice(0, cache.length - MSG_CACHE_MAX)
  },
  updateMessage(m: Message): void {
    const all = readJsonl<Message>(join(dirOf(m.agentId), 'messages.jsonl'))
    const idx = all.findIndex((x) => x.id === m.id)
    if (idx < 0) return
    all[idx] = m
    const path = join(dirOf(m.agentId), 'messages.jsonl')
    writeFileAtomic(path, all.map((x) => JSON.stringify(x)).join('\n') + '\n')
    // Patch the hot cache in place instead of discarding the whole tail.
    const cache = msgCache.get(m.agentId)
    if (cache) {
      const ci = cache.findIndex((x) => x.id === m.id)
      if (ci >= 0) cache[ci] = m
    }
  },
  getMessage(agentId: string, id: string): Message | null {
    return loadMessages(agentId).find((m) => m.id === id) ?? readJsonl<Message>(join(dirOf(agentId), 'messages.jsonl')).find((m) => m.id === id) ?? null
  },
  /** Every message on disk, oldest first (search; not for the UI). */
  allMessages(agentId: string): Message[] {
    return readJsonl<Message>(join(dirOf(agentId), 'messages.jsonl'))
  },
  /** Newest-last page. `before` = message id to page backwards from. */
  messages(agentId: string, opts: { before?: string; limit?: number } = {}): { messages: Message[]; hasMore: boolean } {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 60))
    let all = loadMessages(agentId)
    if (opts.before) {
      let idx = all.findIndex((m) => m.id === opts.before)
      if (idx < 0) {
        all = readJsonl<Message>(join(dirOf(agentId), 'messages.jsonl'))
        idx = all.findIndex((m) => m.id === opts.before)
      }
      if (idx >= 0) all = all.slice(0, idx)
    }
    const page = all.slice(-limit)
    return { messages: page, hasMore: all.length > page.length }
  },
  recentMessages(agentId: string, limit: number): Message[] {
    return loadMessages(agentId).slice(-limit)
  },
  /**
   * Search every message ON DISK — `allMessages`, never `loadMessages`.
   *
   * The cache holds the last `MSG_CACHE_MAX` (400) only, so searching it would
   * report "no matches" for everything older: a wrong answer shaped exactly
   * like a right one, on the one feature whose promise is finding what
   * scrolled away. A thread long enough to need this is by definition longer
   * than the cache. The matching rule itself lives in
   * `core/runner/threadSearch.ts` so any host answers the same question.
   */
  searchMessages(agentId: string, query: string, limit: number): Message[] {
    return searchThreadMessages(this.allMessages(agentId), query, limit)
  },
  appendRun(r: RunRecord): void {
    appendFileSync(join(dirOf(r.agentId), 'runs.jsonl'), `${JSON.stringify(r)}\n`)
    const log = runLogs.get(r.agentId)
    if (log) {
      log.tail.set(r.id, r)
      if (trimFront(log.tail, RUNS_TAIL)) log.complete = false
      noteBooked(log.booked, r)
    }
  },
  runs(agentId: string, limit = 50): RunRecord[] {
    // The log is append-only, so a row written twice must not come back
    // twice (a duplicate becomes a duplicate React key in the heartbeat).
    // One id, one run: the LAST copy wins, and the newest `limit` distinct
    // runs come back.
    const log = runLog(agentId)
    if (limit <= RUNS_TAIL || log.complete) return [...log.tail.values()].slice(-limit).reverse()
    const byId = new Map<string, RunRecord>()
    for (const r of readJsonl<RunRecord>(join(dirOf(agentId), 'runs.jsonl'))) byId.set(r.id, r)
    return [...byId.values()].slice(-limit).reverse()
  },
  /** Per ET day, the last run that recorded a book — the portfolio timeline's input. */
  bookedRuns(agentId: string): RunRecord[] {
    return [...runLog(agentId).booked.values()]
  },
  /**
   * The authorization decision log (shared/decisions.ts): why a tool call
   * was allowed or blocked. Fire-and-forget — an audit write must never take
   * down the decision it is auditing.
   */
  appendDecision(d: DecisionRecord): void {
    try {
      appendFileSync(join(dirOf(d.agentId), 'decisions.jsonl'), `${JSON.stringify(d)}\n`)
      const t = decisionTails.get(d.agentId)
      if (t) {
        t.rows.push(d)
        if (t.rows.length > DECISIONS_TAIL) {
          t.rows.shift()
          t.complete = false
        }
      }
    } catch {
      /* best effort */
    }
  },
  /**
   * Newest first. `since` filters by the record's own timestamp BEFORE the row
   * cap is applied, so a caller asking for "the last 7 days" gets the window
   * (up to `limit` rows of it) rather than the newest N rows re-labelled as a
   * week — which is how the stats sheet came to say "held back 6 times in the
   * last 7 days" over a 60-row sample of a much longer week.
   */
  decisions(agentId: string, opts: DecisionQuery = {}): DecisionRecord[] {
    const limit = opts.limit ?? 100
    const t = decisionTail(agentId)
    // The tail answers when it holds every row the query could return: the
    // whole file, or (for a window) a row older than the window's start.
    const covered = t.complete || (opts.since === undefined ? limit <= t.rows.length : t.rows.length > 0 && Date.parse(t.rows[0].ts) < opts.since)
    const all = covered ? t.rows : readJsonl<DecisionRecord>(join(dirOf(agentId), 'decisions.jsonl'))
    const rows = opts.since === undefined ? all : all.filter((d) => Date.parse(d.ts) >= opts.since!)
    return rows.slice(-limit).reverse()
  }
}

/** The `AgentStorage` the core runner needs, backed by the JSON store. */
export const localStorageAdapter: AgentStorage = {
  async getConfig(id) {
    return agentStore.getConfig(id)
  },
  async getState(id) {
    return agentStore.getState(id)
  },
  async saveState(id, state) {
    agentStore.saveState(id, state)
  },
  async saveConfig(cfg) {
    agentStore.saveConfig(cfg)
  },
  async searchMessages(id, query, limit) {
    // The desktop reads the entire JSONL, so it has always seen the oldest
    // message — there is no bound here to report.
    return { messages: agentStore.searchMessages(id, query, limit), scannedAll: true }
  },
  async appendMessage(m) {
    agentStore.appendMessage(m)
  },
  async updateMessage(m) {
    agentStore.updateMessage(m)
  },
  async recentMessages(id, limit) {
    return agentStore.recentMessages(id, limit)
  },
  async appendRun(r) {
    agentStore.appendRun(r)
  }
}
