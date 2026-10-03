/**
 * A stand-in for the preload bridge, for looking at the UI in a plain browser.
 *
 * Installed by main.tsx ONLY when `window.tb` is missing in dev (i.e. served by
 * `vite.preview.config.ts`, never inside Electron). The fixture fleet is built
 * to be REVIEWED: it covers every message shape the thread can render — prose,
 * tool calls, fills with economics, a run report, a plan, a question, a held
 * action and a failed send — and every identity the chrome has to distinguish:
 * paper and live, armed and not, Claude · OpenRouter · Local GPU, and a retired one.
 *
 * Everything the fixtures do not answer explicitly resolves to `null` through a
 * Proxy, so a new IPC method never breaks the preview; it just does nothing
 * here. ⚠️ That fallback only covers METHODS — a namespace the fixtures never
 * mention (`window.tb.local`) resolves to a function, and reading `.onEvent`
 * off it is `undefined`, which is exactly how the store's boot used to die at
 * `window.tb.local.onEvent is not a function`. Every namespace in `TbApi` must
 * appear below, even when all it needs is a pair of no-ops.
 *
 * A LOCAL fixture set replaces the built-in one when it exists:
 * `mock-data/fixtures.ts` at the repository root, default-exporting
 * `PreviewFixtures`. That folder is git-ignored — it is for staging screenshots
 * with a fleet of your own — and without it the preview is exactly the
 * built-in fleet below.
 */
import type { AgentEvent, AppSettings, TbApi } from '@shared/ipc'
import { DEFAULT_GUARDRAILS, DEFAULT_LOCAL_MODEL, DEFAULT_MODEL, DEFAULT_OPENROUTER_MODEL, reportFallbackText, type AgentReport, type AgentSummary, type Ledger, type Message, type RunRecord } from '@shared/agents'
import { DEFAULT_TOOL_POLICY } from '@shared/mcps'
import { openAsks } from '@shared/awaiting'
import type { DecisionRecord } from '@shared/decisions'
import type { TimelineRow } from '@shared/timeline'
import type { AgentLayout } from '@shared/agentLayout'
import { useApp } from '@renderer/store/appStore'

/** What the preview hands a local fixture set's `setup`, and exposes as `window.__preview` for scripted walkthroughs. */
export interface PreviewContext {
  app: typeof useApp
  emit(e: AgentEvent): void
  /** Patch one agent's state and tell the app, the way the engine would. */
  patch(id: string, next: Partial<AgentSummary['state']>): AgentSummary | null
  /** Append a message to a thread and tell the app. */
  post(m: Message): void
}

/** A fleet to preview instead of the built-in one (see the header). */
export interface PreviewFixtures {
  agents: AgentSummary[]
  messages: Record<string, Message[]>
  runs?: Record<string, RunRecord[]>
  decisions?: Record<string, DecisionRecord[]>
  timeline?: TimelineRow[]
  layout?: AgentLayout
  settings?: Partial<AppSettings>
  /** Bridge methods to add or replace, by namespace (`{ robinhood: { account: async () => … } }`). */
  bridge?: Record<string, unknown>
  /** Runs once the bridge is installed — timers, live streams, anything the fleet should do on its own. */
  setup?(ctx: PreviewContext): void
}

const local = Object.values(import.meta.glob<{ default: PreviewFixtures }>('../../../../mock-data/fixtures.ts', { eager: true }))[0]?.default ?? null

const now = Date.now()
const ago = (min: number): string => new Date(now - min * 60_000).toISOString()
const ahead = (min: number): string => new Date(now + min * 60_000).toISOString()

const emptyLedger = (cash: number): Ledger => ({ cash, positions: [], fills: [], openOrders: [], realizedPnl: 0 })

const A = 'a-mu-overnight'
const B = 'b-spy-opener'
const C = 'c-nvda-dip'
const D = 'd-brass-book'
const E = 'e-report-week'
const F = 'f-local-scout'

const paperA: Ledger = {
  cash: 4488.5,
  positions: [{ symbol: 'MU', qty: 5, avgCost: 102.3 }],
  fills: [
    { id: 'f1', ts: ago(1500), symbol: 'MU', side: 'buy', qty: 5, price: 99.82, realized: 0 },
    { id: 'f2', ts: ago(1080), symbol: 'MU', side: 'sell', qty: 5, price: 102.3, realized: 12.4 },
    { id: 'f3', ts: ago(60), symbol: 'MU', side: 'buy', qty: 5, price: 102.3, realized: 0 }
  ],
  openOrders: [],
  realizedPnl: 61.2
}

/** A live book: real money, two open positions, and a sale still settling (T+1). */
const liveD: Ledger = {
  cash: 1642.18,
  positions: [
    { symbol: 'NVDA', qty: 6, avgCost: 121.44 },
    { symbol: 'AAPL', qty: 3, avgCost: 228.9 }
  ],
  fills: [
    { id: 'd1', ts: ago(4 * 1440), symbol: 'NVDA', side: 'buy', qty: 6, price: 121.44, realized: 0 },
    { id: 'd2', ts: ago(2 * 1440), symbol: 'AAPL', side: 'buy', qty: 3, price: 228.9, realized: 0 },
    { id: 'd3', ts: ago(320), symbol: 'MU', side: 'sell', qty: 4, price: 103.1, realized: 27.6 }
  ],
  openOrders: [],
  realizedPnl: 88.15,
  unsettled: [{ amount: 412.4, ts: ago(320), settlesOn: new Date(now + 20 * 3_600_000).toISOString().slice(0, 10) }]
}

const base = (id: string, name: string, task: string, over: Partial<AgentSummary['config']>, state: Partial<AgentSummary['state']>): AgentSummary => ({
  config: {
    id,
    name,
    task,
    icon: 'arrow',
    color: 'blue',
    schedule: { kind: 'times', times: ['15:58', '09:31'], days: [1, 2, 3, 4, 5], tradingDaysOnly: true },
    guardrails: DEFAULT_GUARDRAILS,
    mode: 'paper',
    model: DEFAULT_MODEL,
    allocationUsd: 5000,
    liveArmedAt: null,
    retirement: null,
    createdAt: ago(3 * 1440),
    updatedAt: ago(30),
    ...over
  } as AgentSummary['config'],
  state: {
    status: 'scheduled',
    nextRunAt: ahead(137),
    lastRunAt: ago(60),
    lastError: null,
    runCount: 14,
    ordersToday: { date: '2026-09-03', count: 1 },
    paper: paperA,
    live: emptyLedger(0),
    memory: [],
    exits: {},
    watches: [],
    theses: {},
    unread: 0,
    lastMessageAt: ago(4),
    lastMessagePreview: 'Holding 5 MU into the close — flatten 9:31 tomorrow',
    sessionId: null,
    ...state
  } as AgentSummary['state']
})

const builtInAgents: AgentSummary[] = [
  base(A, 'MU Overnight', 'Buy $500 of MU at 3:58 PM ET every trading day, then sell the whole position at 9:31 AM ET the next morning.', {}, {
    exits: { MU: { stop: 99.2, target: 107.4, trail: { pct: 2.5, high: 103.8 }, setAt: ago(60) } },
    watches: [{ id: 'w1', symbol: 'MU', condition: 'below', value: 99.2, baseline: 102.3, note: 'Stop zone — re-read the thesis before it trips.', setAt: ago(58) }],
    theses: { MU: 'Overnight gap-up pattern has paid 9 of 12 sessions; earnings next Wednesday is the one night to sit out.' },
    memory: ['The operator prefers half size on a >3% gap into the close.']
  }),
  base(
    B,
    'SPY Opener',
    'At 9:35 AM each day, buy $200 of SPY. At 3:50 PM, sell it all.',
    { icon: 'sphere', color: 'teal', model: DEFAULT_OPENROUTER_MODEL, autonomous: false, allocationUsd: 2000 },
    // Mid-run, so a message sent to it in the preview shows as QUEUED (shared/messageQueue.ts).
    { status: 'running', running: true, runStartedAt: ago(1), runId: 'r1', unread: 2, lastMessageAt: ago(1), lastMessagePreview: 'Needs your OK: Buy 2 SPY', paper: emptyLedger(2000), nextRunAt: null }
  ),
  base(
    D,
    'Brass Book',
    'Hold a core of NVDA and AAPL. Trim 20% on any single-day gain over 4%, and never let the book go below $2,000 of cash.',
    {
      icon: 'cube',
      color: 'orange',
      mode: 'live',
      // Armed: real money, and the one place red is allowed in the chrome.
      liveArmedAt: ago(6 * 1440),
      allocationUsd: 4000,
      schedule: { kind: 'interval', everyMinutes: 30, marketHoursOnly: true }
    },
    {
      live: liveD,
      paper: emptyLedger(0),
      exits: { NVDA: { stop: 114.2, target: 139.0, trail: { pct: 4, high: 120.2 }, stopIf: { below: 114.9, reason: 'Loses the 20-day' }, setAt: ago(4 * 1440) }, AAPL: { trail: { pct: 3, high: 234.1 }, setAt: ago(2 * 1440) } },
      ordersToday: { date: '2026-09-03', count: 2 },
      runCount: 212,
      lastRunAt: ago(12),
      nextRunAt: ahead(18),
      lastMessageAt: ago(12),
      lastMessagePreview: 'Trimmed 4 MU at $103.10 — +$27.60 realized'
    }
  ),
  base(
    E,
    'Report Week',
    'Two days before a report in my watchlist, take a starter position; flatten the session before the print.',
    { icon: 'helix', color: 'violet', mode: 'live', liveArmedAt: null, model: DEFAULT_OPENROUTER_MODEL, allocationUsd: 1500, schedule: { kind: 'times', times: ['09:45'], days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], tradingDaysOnly: true } },
    { status: 'paused', live: emptyLedger(1500), paper: emptyLedger(0), nextRunAt: null, runCount: 31, lastMessageAt: ago(3 * 1440), lastMessagePreview: 'Paused — not armed, so nothing can reach the account' }
  ),
  base(
    F,
    'Local Scout',
    'Every 10 minutes, read the tape on my watchlist and tell me only about things that changed my thesis. Never trade.',
    { icon: 'plasma', color: 'green', model: DEFAULT_LOCAL_MODEL, allocationUsd: 1000, schedule: { kind: 'interval', everyMinutes: 10, marketHoursOnly: true } },
    { status: 'running', running: true, runStartedAt: ago(0.4), runId: 'rF', paper: emptyLedger(1000), nextRunAt: ahead(9), runCount: 604, lastMessageAt: ago(9), lastMessagePreview: 'Nothing moved the thesis — AMD volume is the only outlier' }
  ),
  base(
    C,
    'NVDA Dip',
    'Every 15 minutes during market hours, check NVDA. If it drops more than 2% from the open, buy $300.',
    { icon: 'donut', color: 'slate', schedule: { kind: 'interval', everyMinutes: 15, marketHoursOnly: true } },
    { status: 'retired', retireReason: 'Take-profit reached', nextRunAt: null, lastMessageAt: ago(2 * 1440), lastMessagePreview: 'Retired — target hit', paper: { ...emptyLedger(5210.4), realizedPnl: 210.4 } } as Partial<AgentSummary['state']>
  )
]

const REPORT_HELD: AgentReport = { headline: 'Holding 5 MU overnight', status: 'held', facts: [{ label: 'MU', value: '$99.82', delta: 'entry', tone: 'flat' }, { label: 'Stop', value: '$96.80', delta: '−3.0%', tone: 'down' }, { label: 'Book', value: '+$48.80', tone: 'up' }], next: 'Sell the whole position at 9:31 AM.' }
const REPORT_ACTED: AgentReport = { headline: 'Flat after the open — +$12.40 on the overnight', status: 'acted', facts: [{ label: 'Realized', value: '+$12.40', delta: '+2.48%', tone: 'up' }, { label: 'Book', value: '+$61.20', tone: 'up' }, { label: 'Win rate', value: '9 / 12' }], next: 'Re-enter at 3:58 PM.', details: 'Gap held through the first minute; no slippage vs the 9:30 print.' }

const msg = <T extends Omit<Message, 'id' | 'agentId'>>(agentId: string, id: string, m: T): Message => ({ id, agentId, ...m }) as unknown as Message

const builtInMessages: Record<string, Message[]> = {
  [A]: [
    msg(A, 'a1', { role: 'system', kind: 'created', text: 'Created — paper mode, $5,000 allocation. Runs on your Claude subscription.', ts: ago(3 * 1440) }),
    msg(A, 'a2', { role: 'user', text: 'Buy $500 of MU at 3:58 PM ET every trading day, then sell the whole position at 9:31 AM ET the next morning.', ts: ago(3 * 1440 - 1) }),
    msg(A, 'a3', {
      role: 'agent',
      text: 'Got it. I’ll buy ~$500 of MU in the last two minutes of each session and flatten it one minute after the next open. I’ve set the schedule to 3:58 PM and 9:31 AM on trading days and will keep a hard stop 3% under each entry.',
      toolCalls: [
        { name: 'mcp__robinhood__get_equity_quotes', input: '{"symbols":["MU"]}', output: 'MU 99.82 (+1.1%)', args: { symbols: ['MU'] }, result: 'MU  last 99.82  prev 98.73  +1.10%\nbid 99.80  ask 99.84  volume 18,402,911', durationMs: 412 },
        { name: 'mcp__tb__change_plan', input: '{"schedule":{"kind":"times","times":["15:58","09:31"]}}', output: 'Schedule set.', args: { schedule: { kind: 'times', times: ['15:58', '09:31'], tradingDaysOnly: true } }, result: 'Schedule set: 3:58 PM and 9:31 AM ET on trading days.', durationMs: 38 }
      ],
      ts: ago(3 * 1440 - 2)
    }),
    msg(A, 'a4', { role: 'system', kind: 'schedule', text: 'Schedule set: 3:58 PM and 9:31 AM ET on trading days.', ts: ago(3 * 1440 - 2) }),
    msg(A, 'a5', {
      role: 'action',
      action: { side: 'buy', symbol: 'MU', qty: 5, type: 'market', tif: 'day', reason: 'Scheduled entry — 3:58 PM.', mode: 'paper', status: 'filled', fillPrice: 99.82, fillQty: 5, refPrice: 99.8, stopLoss: 96.8, econ: { notional: 499.1, positionQty: 5, positionAvgCost: 99.82, bookRealized: 48.8 } },
      ts: ago(1500)
    }),
    msg(A, 'a6', {
      role: 'agent',
      text: reportFallbackText(REPORT_HELD),
      report: REPORT_HELD,
      ts: ago(1499)
    }),
    msg(A, 'a7', {
      role: 'action',
      action: { side: 'sell', symbol: 'MU', qty: 5, type: 'market', tif: 'day', reason: 'Scheduled exit — 9:31 AM.', mode: 'paper', status: 'filled', fillPrice: 102.3, fillQty: 5, refPrice: 102.28, econ: { notional: 511.5, realized: 12.4, costBasis: 99.82, realizedPct: 2.48, positionQty: 0, positionAvgCost: 0, bookRealized: 61.2 } },
      ts: ago(1080)
    }),
    msg(A, 'a8', {
      role: 'agent',
      text: reportFallbackText(REPORT_ACTED),
      report: REPORT_ACTED,
      ts: ago(1079)
    }),
    // A refused call, so the thread's "blocked" verdict has something to draw.
    msg(A, 'a8b', {
      role: 'agent',
      text: 'I wanted to double the entry on the strength, but the order cap stopped me — which is the right answer. Staying at one unit.',
      toolCalls: [{ name: 'mcp__tb__trade', input: '{"side":"buy","symbol":"MU","notionalUsd":1000}', output: 'Blocked', args: { side: 'buy', symbol: 'MU', notionalUsd: 1000 }, blocked: 'cap.orderNotional — $1,000.00 is over this agent’s $500.00 per-order cap.', durationMs: 6 }],
      ts: ago(1078)
    }),
    msg(A, 'a9', { role: 'user', text: 'Nice. What’s your read on MU into earnings next week?', ts: ago(70) }),
    msg(A, 'a10', {
      role: 'agent',
      text: 'Earnings land after the close next Wednesday. The overnight pattern has paid 9 of 12 sessions, but an earnings gap is a different animal — I’d rather **skip that one night** than hold a $500 lottery ticket. I can add a rule to sit out the session before a report; say the word.',
      notify: 'fyi',
      ts: ago(69)
    }),
    msg(A, 'a11', {
      role: 'action',
      action: { side: 'buy', symbol: 'MU', qty: 5, type: 'market', tif: 'day', reason: 'Scheduled entry — 3:58 PM.', mode: 'paper', status: 'filled', fillPrice: 102.3, fillQty: 5, refPrice: 102.31, stopLoss: 99.2, econ: { notional: 511.5, positionQty: 5, positionAvgCost: 102.3, bookRealized: 61.2 } },
      ts: ago(60)
    }),
    msg(A, 'a12', {
      role: 'plan',
      status: 'pending',
      plan: { summary: 'Skip the overnight before earnings', task: 'Buy $500 of MU at 3:58 PM ET every trading day except the session before an earnings report, then sell at 9:31 AM.', guardrails: { maxDailyLossPct: 2 }, diff: [{ key: 'maxDailyLossPct', label: 'Max daily loss', from: '3%', to: '2%', looser: false }] },
      ts: ago(58)
    } as unknown as Omit<Message, 'id' | 'agentId'>),
    msg(A, 'a13', {
      role: 'question',
      text: 'MU is +4% on a rumour into the close. Still enter tonight at full size?',
      options: ['Full size', 'Half size', 'Skip tonight'],
      stakes: 'A $500 entry 4% above yesterday’s close, with the stop 3% under.',
      fallback: 'Enter at half size',
      deadline: ahead(8),
      ts: ago(4)
    })
  ],
  [B]: [
    msg(B, 'b1', { role: 'system', kind: 'created', text: 'Created — paper mode, $2,000 allocation. Thinks on OpenRouter.', ts: ago(2 * 1440) }),
    msg(B, 'b2', { role: 'system', kind: 'mode', text: 'Approval required: this agent asks before every order.', ts: ago(2 * 1440) }),
    msg(B, 'b3', {
      role: 'approval',
      status: 'pending',
      action: { id: 'pa1', tool: 'trade', args: {}, summary: 'Buy 2 SPY at market', reason: 'Scheduled 9:35 AM entry. SPY opened flat; the first five minutes held the overnight range.', symbol: 'SPY', side: 'buy', quote: 548.12, requestedAt: ago(3) },
      ts: ago(3)
    }),
    // Sent after the run above began (runStartedAt = ago(1)) → queued behind it.
    msg(B, 'b4', { role: 'user', text: 'Skip SPY today — just watch and tell me what you see.', ts: ago(0.5), queuedBehind: 'r1' })
  ],
  [D]: [
    msg(D, 'd-m1', { role: 'system', kind: 'created', text: 'Created — live mode, $4,000 allocation. Runs on your Claude subscription.', ts: ago(8 * 1440) }),
    msg(D, 'd-m2', { role: 'system', kind: 'mode', text: 'Armed for live trading. Orders go to the Robinhood account with real money until you disarm it.', ts: ago(6 * 1440) }),
    msg(D, 'd-m3', {
      role: 'action',
      action: { side: 'sell', symbol: 'MU', qty: 4, type: 'market', tif: 'day', reason: 'Single-day gain over 4% — trimming the agreed 20%.', mode: 'live', status: 'filled', fillPrice: 103.1, fillQty: 4, refPrice: 103.08, econ: { notional: 412.4, realized: 27.6, costBasis: 96.2, realizedPct: 7.17, positionQty: 0, positionAvgCost: 0, bookRealized: 88.15 } },
      ts: ago(320)
    }),
    msg(D, 'd-m4', {
      role: 'agent',
      text: 'Trimmed 4 MU at $103.10 — **+$27.60** realized. Those proceeds settle tomorrow, so today’s spendable cash is $1,642.18 rather than the full balance. NVDA and AAPL untouched; NVDA’s stop is at $114.20 and AAPL is on a 3% trail from $234.10.',
      notify: 'important',
      ts: ago(319)
    }),
    msg(D, 'd-m5', { role: 'user', text: 'Good. Leave the core alone this week.', ts: ago(300) }),
    msg(D, 'd-m6', {
      role: 'agent',
      text: 'Understood — core untouched through Friday. I’ll still enforce the stops, because those exist for the day I am wrong rather than for the week I am right.',
      toolCalls: [{ name: 'mcp__tb__remember', input: '{"note":"Core untouched through Friday"}', output: 'Noted.', args: { note: 'Leave the NVDA/AAPL core untouched through Friday (operator, this week only).' }, result: 'Noted.', durationMs: 11 }],
      ts: ago(299)
    })
  ],
  [E]: [
    msg(E, 'e-m1', { role: 'system', kind: 'created', text: 'Created — live mode, $1,500 allocation. Thinks on OpenRouter.', ts: ago(5 * 1440) }),
    msg(E, 'e-m2', { role: 'system', kind: 'mode', text: 'Not armed: it can plan and report, but no order can reach the account until you arm it.', ts: ago(5 * 1440) }),
    msg(E, 'e-m3', { role: 'system', kind: 'paused', text: 'Paused by you. Scheduled wake-ups stop until you resume.', ts: ago(3 * 1440) })
  ],
  [F]: [
    msg(F, 'f-m1', { role: 'system', kind: 'created', text: 'Created — paper mode, $1,000 allocation. Runs on this computer’s GPU.', ts: ago(11 * 1440) }),
    msg(F, 'f-m2', {
      role: 'agent',
      text: 'Nothing moved the thesis this tick. AMD is the only outlier — 2.4× its 20-day volume at the same price, which usually resolves within a session. I’ll say so again only if it breaks the range.',
      toolCalls: [
        { name: 'mcp__robinhood__get_equity_quotes', input: '{"symbols":["AMD","NVDA","MU"]}', output: '3 quotes', args: { symbols: ['AMD', 'NVDA', 'MU'] }, result: 'AMD  162.40  +0.12%\nNVDA 128.40  +1.18%\nMU   102.30  +3.23%', durationMs: 388 },
        { name: 'mcp__webvector__search', input: '{"q":"AMD unusual volume"}', output: '5 results', args: { q: 'AMD unusual volume', limit: 5 }, result: '1. AMD volume spikes on data-centre chatter — no filing\n2. Sector ETF rebalance scheduled Friday\n…', durationMs: 1640 }
      ],
      ts: ago(9)
    })
  ],
  [C]: [
    msg(C, 'c1', { role: 'system', kind: 'created', text: 'Created — paper mode, $5,000 allocation.', ts: ago(9 * 1440) }),
    msg(C, 'c2', {
      role: 'action',
      action: { side: 'sell', symbol: 'NVDA', qty: 3, type: 'market', tif: 'day', reason: 'Take-profit hit at +5%.', mode: 'paper', status: 'filled', fillPrice: 128.4, fillQty: 3, refPrice: 128.4, econ: { notional: 385.2, realized: 18.3, costBasis: 122.3, realizedPct: 4.99, positionQty: 0, positionAvgCost: 0, bookRealized: 210.4 } },
      ts: ago(2 * 1440 + 5)
    }),
    msg(C, 'c3', { role: 'system', kind: 'retired', text: 'Retired — take-profit reached. Final book +$210.40 (+4.2%) over 7 sessions, 11 fills.', ts: ago(2 * 1440) })
  ]
}

const agents: AgentSummary[] = local?.agents ?? builtInAgents
const messages: Record<string, Message[]> = local?.messages ?? builtInMessages

const settings: AppSettings = {
  theme: (localStorage.getItem('tb:theme') as AppSettings['theme']) ?? 'light',
  defaultProvider: 'claude',
  defaultModel: DEFAULT_MODEL,
  onboardingDone: true,
  tools: DEFAULT_TOOL_POLICY,
  tradingHalted: false,
  localModel: { enabled: false, folder: null, modelId: null },
  ...local?.settings
}

const walk = (start: number, n = 40): number[] => {
  const out = [start]
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + (Math.sin(i * 1.7 + start) + Math.cos(i * 0.6)) * 0.0015))
  return out
}

const listeners = new Set<(e: AgentEvent) => void>()
const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))

/** Patch one fixture agent's state and tell the app, the way the engine would. */
const patch = (id: string, next: Partial<AgentSummary['state']>): AgentSummary | null => {
  const a = agents.find((x) => x.config.id === id)
  if (!a) return null
  a.state = { ...a.state, ...next } as AgentSummary['state']
  const summary = { ...a }
  emit({ type: 'agent:updated', summary })
  return summary
}

const explicit = {
  platform: 'win32',
  claude: { status: async () => ({ vendor: 'claude', authenticated: true, apiKeyOverrideDetected: false, subscriptionType: 'Max', detail: 'Signed in' }), usage: async () => null, overrideUsageHold: async () => undefined },
  chatgpt: { status: async () => ({ vendor: 'chatgpt', authenticated: false, detail: 'Not signed in' }) },
  robinhood: {
    status: async () => ({ connected: true, accountHint: '••4821', detail: 'Connected', secureStorage: true }),
    account: async () => ({
      buyingPower: 12480.22,
      cash: 6120.4,
      equity: 31842.9,
      positions: [
        { symbol: 'NVDA', qty: 40, avgCost: 118.2, marketValue: 5136 },
        { symbol: 'MU', qty: 60, avgCost: 96.1, marketValue: 6138 },
        { symbol: 'SPY', qty: 20, avgCost: 531.0, marketValue: 10962.4 },
        { symbol: 'AAPL', qty: 15, avgCost: 201.4, marketValue: 3486 }
      ],
      fetchedAt: new Date().toISOString()
    }),
    quotes: async (symbols: string[]) => {
      const px: Record<string, [number, number]> = { NVDA: [128.4, 126.9], MU: [102.3, 99.1], SPY: [548.12, 549.3], AAPL: [232.4, 230.1], AMD: [162.4, 162.2] }
      return symbols.map((s) => ({ symbol: s, last: px[s]?.[0] ?? 100, prevClose: px[s]?.[1] ?? 100, changePct: px[s] ? ((px[s][0] - px[s][1]) / px[s][1]) * 100 : 0, ts: new Date().toISOString() }))
    },
    sparks: async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, walk(s === 'SPY' ? 549 : s === 'MU' ? 99 : s === 'NVDA' ? 127 : 230)]))
  },
  agents: {
    list: async () => agents,
    messages: async (id: string) => ({ messages: messages[id] ?? [], hasMore: false }),
    decisions: async (id: string) => local?.decisions?.[id] ?? [],
    timeline: async () => local?.timeline ?? [],
    // The run log: only quiet ticks matter to the thread (they have no
    // message), so the fixture is four of them for agent A — three in a row
    // between its last two replies, one after — to see the fold and the tail.
    runs: async (id: string): Promise<RunRecord[]> =>
      local
        ? (local.runs?.[id] ?? [])
        : id !== A
        ? []
        : [50, 40, 30, 2].map((min) => ({
            id: `q${min}`,
            agentId: A,
            trigger: 'schedule' as const,
            startedAt: ago(min),
            endedAt: ago(min),
            ok: true,
            model: 'claude:sonnet',
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: 0,
            actions: 0,
            durationMs: 900,
            skipped: true,
            skipReason: 'quiet interval tick — no watch fired, no exit level moved, no order settled, no operator message, no errand due, no symbol moved more than 0.3% since the last run; the model was not called'
          })),
    awaiting: async () => Object.values(messages).flatMap((ms) => openAsks(ms)),
    markRead: async () => undefined,
    // The engine's side of a send: the row lands and the thread hears about it.
    // A message starting with "fail" is refused, so the Not sent / Try again
    // path can be seen without a broken network.
    send: async (id: string, text: string): Promise<Message> => {
      await new Promise((r) => setTimeout(r, 400))
      if (/^fail\b/i.test(text)) throw new Error('Gateway Timeout')
      const m = msg(id, `u${Date.now()}`, { role: 'user', text, ts: new Date().toISOString() })
      ;(messages[id] ??= []).push(m)
      emit({ type: 'message:new', message: m })
      return m
    },
    // Stop: the run ends a beat later, and the agent is idle again.
    stop: async (id: string): Promise<void> => {
      await new Promise((r) => setTimeout(r, 300))
      const a = agents.find((x) => x.config.id === id)
      if (!a) return
      // The stopped run's reply lands with its runId, so a message that waited
      // behind it (b4, queuedBehind r1) moves under this reply — the ordering
      // rule in shared/messageQueue.ts, visible in the preview.
      const reply = msg(id, `r1-${Date.now()}`, { role: 'agent', runId: 'r1', text: 'Stopped where I was — SPY is flat at $548.12, the 9:35 entry is still waiting on your OK.', ts: new Date().toISOString() })
      ;(messages[id] ??= []).push(reply)
      emit({ type: 'message:new', message: reply })
      emit({ type: 'run:delta', agentId: id, runId: 'r1', delta: { kind: 'end', ok: true } })
      patch(id, { running: false, status: 'scheduled', nextRunAt: ahead(30) })
    },
    // A tick the operator asked for: the live bubble opens, a tool runs, a reply
    // lands. Enough for the streaming states to be reviewed without an engine.
    runNow: async (id: string): Promise<void> => {
      const runId = `run-${Date.now()}`
      patch(id, { running: true, status: 'running', runId, runStartedAt: new Date().toISOString() })
      emit({ type: 'run:delta', agentId: id, runId, delta: { kind: 'start', trigger: 'manual' } })
      setTimeout(() => emit({ type: 'run:delta', agentId: id, runId, delta: { kind: 'tool', name: 'mcp__robinhood__get_equity_quotes', input: '{"symbols":["MU"]}' } }), 600)
      setTimeout(() => emit({ type: 'run:delta', agentId: id, runId, delta: { kind: 'tool_result', name: 'mcp__robinhood__get_equity_quotes', output: 'MU 102.30 (+3.2%)' } }), 1800)
      setTimeout(() => emit({ type: 'run:delta', agentId: id, runId, delta: { kind: 'text', text: 'Nothing has changed since the last tick — the levels still hold and I have not touched the book.' } }), 2200)
      setTimeout(() => {
        const reply = msg(id, `m-${Date.now()}`, { role: 'agent', runId, text: 'Nothing has changed since the last tick — the levels still hold and I have not touched the book.', ts: new Date().toISOString() })
        ;(messages[id] ??= []).push(reply)
        emit({ type: 'message:new', message: reply })
        emit({ type: 'run:delta', agentId: id, runId, delta: { kind: 'end', ok: true } })
        patch(id, { running: false, status: 'scheduled', lastRunAt: new Date().toISOString(), nextRunAt: ahead(30) })
      }, 3200)
    },
    pause: async (id: string) => patch(id, { status: 'paused', nextRunAt: null }) ?? agents[0],
    resume: async (id: string) => patch(id, { status: 'scheduled', nextRunAt: ahead(24) }) ?? agents[0],
    retire: async (id: string) => patch(id, { status: 'retired', retireReason: 'Retired by you', nextRunAt: null } as Partial<AgentSummary['state']>) ?? agents[0],
    respawn: async (id: string) => patch(id, { status: 'scheduled', nextRunAt: ahead(24) }) ?? agents[0],
    armLive: async (id: string) => agents.find((a) => a.config.id === id) ?? agents[0],
    onEvent: (cb: (e: AgentEvent) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  },
  // Fresh objects each time, as IPC would give: the store bails out of a
  // re-render when it is handed the same reference it already holds.
  settings: {
    get: async () => ({ ...settings }),
    set: async (patchIn: Partial<AppSettings>) => ({ ...Object.assign(settings, patchIn) }),
    setTradingHalt: async (halted: boolean) => {
      settings.tradingHalted = halted
      return { halted, detail: halted ? 'Live buying is off for every agent.' : 'Live buying is back on for every agent.' }
    }
  },
  layout: { get: async () => local?.layout ?? { v: 1, groups: [], order: [], membership: {} }, set: async () => ({ ok: true }) },
  local: { status: async () => null, onEvent: () => () => undefined },
  mcp: { status: async () => ({ keys: {}, runtimes: { uv: false, node: true }, platform: 'win32' }) },
  // The market-data key reads as saved, so paper agents mark without Robinhood.
  marketData: {
    status: async () => ({ configured: true, feed: 'iex' }),
    setKey: async (req: { feed: 'iex' | 'sip' }) => ({ configured: true, feed: req.feed }),
    clearKey: async () => ({ configured: false, feed: 'iex' })
  },
  openrouter: {
    status: async () => ({ hasKey: true, detail: 'Key works (“preview”) · $1.24 used.', label: 'preview', usageUsd: 1.24, limitUsd: null, testedAt: ago(30) }),
    setKey: async () => ({ hasKey: true, detail: 'Key saved. Test it to confirm it works.' }),
    clearKey: async () => ({ hasKey: false, detail: 'No API key yet.' }),
    testKey: async () => ({ hasKey: true, detail: 'Key works (“preview”) · $1.24 used.', label: 'preview', usageUsd: 1.24, limitUsd: null, testedAt: ago(0) })
  },
  /**
   * Auth events. Present ONLY because the store subscribes to events at boot
   * (`window.tb.onAuthEvent`, `window.tb.local.onEvent`): the Proxy below answers an unknown
   * KEY with a function, and reading `.onEvent` off a function is `undefined`,
   * so the whole of `boot()` threw here and the preview never finished booting.
   */
  onAuthEvent: () => () => undefined,
  openExternal: async () => undefined
}

/** Anything not answered above: a function that resolves to null. */
const fallback = (target: Record<string, unknown>): unknown =>
  new Proxy(target, {
    get(t, key) {
      if (key in t) {
        const v = t[key as string]
        return v && typeof v === 'object' && !Array.isArray(v) ? fallback(v as Record<string, unknown>) : v
      }
      return async () => null
    }
  })

// A local fixture set may add or replace methods, one namespace at a time.
for (const [ns, methods] of Object.entries(local?.bridge ?? {})) {
  const target = (explicit as Record<string, unknown>)[ns]
  ;(explicit as Record<string, unknown>)[ns] = target && typeof target === 'object' && methods && typeof methods === 'object' ? { ...target, ...methods } : methods
}

;(window as unknown as { tb: TbApi }).tb = fallback(explicit) as TbApi

const ctx: PreviewContext = {
  app: useApp,
  emit,
  patch,
  post: (m) => {
    ;(messages[m.agentId] ??= []).push(m)
    emit({ type: 'message:new', message: m })
  }
}
;(window as unknown as { __preview: PreviewContext }).__preview = ctx

if (local) local.setup?.(ctx)
else builtInDemos()

/** The built-in fleet's moving parts: a streaming run and a failed send. */
function builtInDemos(): void {
  // A run streaming on the OpenRouter agent, so the live bubble and shimmer can be seen.
  setTimeout(() => {
    emit({ type: 'run:delta', agentId: B, runId: 'r1', delta: { kind: 'start' } } as AgentEvent)
    setTimeout(() => emit({ type: 'run:delta', agentId: B, runId: 'r1', delta: { kind: 'tool', name: 'mcp__robinhood__get_equity_quotes' } } as AgentEvent), 800)
  }, 1200)

  // One message that could not be sent, so the "Not sent · Try again / Discard"
  // state is reviewable without unplugging anything. It goes through the store's
  // own `send`, which is what marks it failed — seeding `msgStatus` directly would
  // be a picture of the state rather than the state. Late enough that boot's
  // `loadMessages` has already replaced the thread array.
  setTimeout(() => {
    void useApp.getState().send(A, 'fail — did the 3:58 entry go in?')
  }, 1600)
}
