# Architecture

This document is the product and technical contract the implementation
follows. `README.md` is the quick start; `docs/DESIGN.md` is the interface's
rule set.

---

## 1. The idea

**Every trading agent is a message thread.** The app is a list of
conversations. Each one is an agent with a job written in plain English ("buy
$500 of MU at 3:58 PM every trading day, sell it at 9:31 AM the next
morning"), a schedule, guardrails, its own book, its own memory, and a history
of what it did and why. You talk to an agent to give it work, adjust it, or ask
what is going on; it answers in the thread and posts a card every time it acts.

Everything runs **on your computer**. Agents think with a model you connect
(your Claude or ChatGPT login, your own OpenRouter API key, or a GGUF model on
your own GPU) and trade **only** through **your own Robinhood account**, via the
Robinhood Agentic Trading MCP. There is no server, no account and no telemetry:
the app talks only to the services you connect (§12).

## 2. Principles

1. **Threads, not dashboards.** A conversation list and a conversation.
   Anything that is not a message is a sheet over the thread.
2. **Plain language in, structured plan out.** The agent turns a task into a
   plan (schedule, guardrails, exits) and shows it as a card. Every field stays
   editable as a form.
3. **The engine trades, the model decides.** The model never places a broker
   order. It calls our `trade` tool; the engine checks guardrails, then places
   the order (or fills it on paper). Paper is the default for every new agent.
4. **One runtime, many hosts.** `src/core` is Electron-free. The desktop main
   process hosts it today; anything else that implements `RuntimeDeps` can.
5. **A discarded error is a confident negative.** `const { data } = await …`
   turns "could not look" into "there is nothing". Destructure the error and
   decide, every time.

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Agent** (= thread) | `AgentConfig` (name, icon, colour, task(s), schedule, guardrails, mode, model, allocation, autonomy) + `AgentState` (status, book, memory, exits, watches, errands…) + messages. |
| **Task** | The standing instruction. An agent may carry up to five (`tasks`), added only with the operator's confirmation (`propose_task`). |
| **Schedule** | `manual` · `interval` (every N minutes, optionally market hours only) · `times` (ET clock times on chosen weekdays) · `once` (a datetime). `shared/schedule.ts nextRunAt()` is the single source of truth. |
| **Run** | One wake-up: build context → one model conversation with tools → persist the run record. Triggers: `schedule`, `manual`, `reply`, `plan`, `watch`, `timeout`, `approval`. |
| **Mode** | `paper` (simulated fills at real quotes) or `live` (real Robinhood orders, armed per agent). |
| **Provider** | Which model service runs the agent: `claude`, `chatgpt`, `openrouter`, `local` (§6). Per agent; the status bar only seeds new agents. |
| **Guardrails** | Hard limits the engine enforces on every order (§7.4). |
| **Message** | `user`, `agent`, `system`, `action` (a trade card), `plan` (a plan card), `question` (a check-in), `approval` (a held action). |
| **Decision log** | Every gated tool call: tool, outcome, rule key, attended or not. Answers "why didn't it sell at 3:58?". |

## 4. The desktop app

- **Sidebar** — agents in operator-arranged groups (drag to reorder, a
  "Waiting on you" queue, a Retired list), New agent, Settings.
- **Thread** — memos (an agent's turns), receipts (fills), plan / question /
  approval cards, run groups with every tool call expandable to its full input
  and result, a live bubble while a run streams, and a composer that queues a
  message sent mid-run.
- **New agent** — templates (`shared/templates.ts`), name, look, task, mode,
  provider, allocation, act-on-its-own vs ask-first. The first run is a setup
  run that proposes the schedule and limits.
- **Agent settings** — task(s), schedule, guardrails and entry rules,
  retirement (profit target, max loss, deadline), mode and live arming,
  provider and model, autonomy, group, duplicate, reset, delete.
- **Stats sheet** — track record (`shared/scorecard.ts`), risk panel, a copyable
  scorecard, and the decision log read as a sentence.
- **Portfolio** — paper and live sub-ledgers shown separately, never summed, with
  a P&L timeline built from the local run log.
- **Settings** — Connections (Claude, ChatGPT, OpenRouter, Robinhood, market
  data), Trading safety (the halt), Local models, MCP servers (data sources),
  Robinhood tools, Preferences (theme, the default provider and model for new
  agents).
- **Onboarding** — pick a model → connect a broker (or a market-data key for
  paper) → create the first agent.

## 5. The runtime (`src/core`)

```
src/core/
  runner/runOnce.ts     one run: context → prompts → vendor → tools → persist
  runner/agentTools.ts  the agent's tools as vendor-neutral defs (zod schema + host handler)
  runner/prompts.ts     system prompt + run prompt blocks (pure, budgeted, durable blocks never cut)
  runner/vendors/       claude · chatgpt · openrouter · local — transport only
  runner/types.ts       RuntimeDeps: the seam a host implements
  broker/guardrails.ts  pure order validation (every rule has a stable key)
  broker/execute.ts     paper or live execution, exits, watches, retirement
  broker/paper.ts       the paper ledger and fill simulation
  robinhood/            OAuth (PKCE), the MCP client, typed API wrappers, the tool allowlist
  market/               price feeds: Robinhood, Alpaca
  intel/servers.ts      operator-enabled data-source MCP servers
  research/earnings.ts  the earnings playbook's research tools (§11)
```

### 5.1 A run, step by step

1. One run per agent at a time; a message arriving mid-run is queued and runs
   next.
2. Context: the agent's own book (paper ledger or live sub-ledger), open
   orders, quotes and computed technicals for the symbols it cares about, the
   ET clock and session, today's order count, memory, theses, errands, exits
   and watches, recent refusals, and the last ~24 thread messages.
3. Prompts are composed from named blocks. Under a budget only `cuttable`
   blocks may be trimmed — the book, protections and memory are `mandatory`,
   so an agent never trades on a book it cannot fully see.
4. The vendor runs the conversation with our tools plus read-only Robinhood
   tools and any enabled data sources. Every tool call goes through ONE gate
   (`makeRunTool` / the `ToolGate`): policy, the approval hold, a loop guard
   (identical calls refused at 6), and argument validation.
5. Tool results are capped and sanitised before the model reads them; forged
   transcript markers are neutralised (`shared/sanitize.ts`).
6. The final reply becomes a message; the run record keeps tokens, cost,
   duration, the closing book and the build. Failures post a note and keep the
   tools that never ran visible as such.

Run-safety primitives: a 45 s activity-based stall watchdog (longer while a
tool or setup is pending), a 300 s hard ceiling, transient-vs-terminal retry
with backoff, a silent turn re-asked once, and catch-up vs missed for
wake-ups that arrive late.

### 5.2 One writer per book

The OpenRouter SDK runs a turn's tool calls concurrently, and every handler is
snapshot → await → assign on the run's shared state. `core/runner/serial.ts
exclusiveLane()` serialises the host and the gate per run; anything new that
mutates run state rides that lane (and nothing inside it may await it).

## 6. Model providers

Four vendors, one agent: prompts, tool names (`mcp__tb__trade`,
`mcp__robinhood__get_equity_quotes`…) and the UI never branch on vendor.

| Provider | How it authenticates | Notes |
|---|---|---|
| **Claude** | The Claude Code login on this computer (`~/.claude/.credentials.json`) or a setup token. Never `ANTHROPIC_API_KEY`. | Claude Agent SDK; sessions resume for prompt-cache reuse. A 5-hour usage hold applies to Claude agents only. |
| **ChatGPT** | Your ChatGPT subscription through the Codex OAuth flow (loopback port 1455, device-code fallback). | ⚠️ An unofficial surface, isolated in `main/chatgpt/*` and `vendors/chatgpt.ts`. |
| **OpenRouter** | Your own OpenRouter API key, stored encrypted. | Any OpenRouter model id; GLM 5.3 Flash by default. Remote HTTP MCP servers are bridged natively. |
| **Local GPU** | Nothing — a GGUF file from your models folder. | `@elyxndra/engine` supervises llama.cpp on port 8905 (`TB_LOCAL_ENGINE_PORT`). Works offline. |

While the computer is offline, autonomous wake-ups of network providers are
skipped with one note and replayed when the connection returns; Local GPU agents
keep running.

## 7. Trading

### 7.1 Broker boundary

The model sees read-only Robinhood tools (quotes, positions, orders,
historicals, fundamentals, earnings, search, accounts) and our tools: `trade`,
`cancel_order`, `set_exit`, `watch_price`, `change_plan`, `set_thesis`,
`set_name`, `remember`, `forget`, `errand_done`, `sleep_until`, `quotes`,
`bars`, `search_thread`, `ask_operator`, `tell_operator`, `report`,
`propose_task`, `propose_agent`, `retire`. Robinhood write tools
(`place_*`, `cancel_*`, watchlists, scans) are off unless enabled in Settings →
Robinhood tools, and even then reachable only by live, armed agents.

### 7.2 Paper

A paper agent's ledger starts at its allocation ($10,000 by default). Market
orders fill at the quote side plus 2 bps of slippage; marketable limits fill at
once, others rest until marketable or expired (`day` / `gtc`). Sale proceeds
settle T+1 (`shared/settlement.ts`): with settlement `cash` — the default for
new agents, because Robinhood's Agentic account is a cash account unless
upgraded — a buy may only spend settled cash.

### 7.3 Live

Live agents keep a **sub-ledger** of their own fills — never a mirror of the
whole account. Live mode needs Robinhood connected and an explicit arm per
agent. Market orders of at least one share become marketable limits; dollar
orders are regular-session market orders only. A live allocation must fit in
what the other live agents leave of the account's buying power
(`shared/liveAllocation.ts`).

### 7.4 Guardrails

Every order is checked by `checkGuardrails` and every refusal carries a rule
key the decision log records: symbol allow-list, max order and position
notional, orders per day, market hours / extended hours, daily-loss buy lock,
settled cash, entry window, extension above VWAP, per-symbol and per-run caps,
re-entry cooldown after a losing sell, live arming, and the **trading halt** —
a panic switch in Settings → Trading safety that refuses live BUYS on every
agent and leaves sells and stops working. Operator-driven sells are exempt from
the daily order cap; engine protective exits are exempt from caps that would
stop them firing.

### 7.5 Exits, watches, approvals

- **Exits are levels the engine enforces**, not sentences the model remembers:
  stop, target, trailing stop (floor-checked against the name's daily range),
  invalidation levels, break-even ratchet, partial target, opening-range grace
  and a flatten time. A 15 s watcher and every run start enforce them.
- **Price watches** wake an agent when a level is hit.
- **Ask-first agents** hold every write tool as an approval card. Approving
  does not execute — the agent re-decides against the price NOW, and the pass
  is spent by the first successful matching execution.
- **Check-ins**: `ask_operator` posts a question with a required fallback and a
  deadline; when it expires the agent wakes and does the fallback.

### 7.6 Robinhood wire details (verified against the live server)

- **OAuth** (`core/robinhood/oauth.ts`): discovery
  `https://agent.robinhood.com/.well-known/oauth-authorization-server` →
  authorize `https://robinhood.com/oauth` (PKCE S256), token
  `https://api.robinhood.com/oauth2/token/` (public client), dynamic
  registration `https://agent.robinhood.com/oauth/trading/register`; scope
  `internal`; `resource=https://agent.robinhood.com/mcp/trading` on authorize,
  token and refresh. The redirect is a loopback `http://127.0.0.1:<port>/callback`
  (bind first, then register a client for that URI). Keep the old refresh token
  if a refresh omits it. Tokens live encrypted with the OS keychain
  (`safeStorage`).
- **MCP transport** (`core/robinhood/mcp.ts`): JSON-RPC POSTs to
  `/mcp/trading` with `Accept: application/json, text/event-stream`,
  `MCP-Protocol-Version: 2025-06-18`, Bearer auth; the session id comes back
  in `mcp-session-id`. Responses may be SSE or JSON; tool results are
  `{"data":…}` in `content[].text`; `isError:true` is a failure whose text ends
  with remediation. Retries 429/5xx with backoff, re-initialises on 404, and a
  401 gets one forced refresh before the operator is told to reconnect.
- **Quotes**: string numerics under `results[].quote.*`; pick the more recent of
  the regular and non-regular trade. ⚠️ After 16:00 ET every "previous close"
  field rolls to TODAY's close (and `previous_close_date` says so) —
  `getQuotesDetailed` swaps in the prior session's close from the daily bars,
  whose `begins_at` is midnight UTC of their own session date.
- **Orders**: `place_equity_order` takes `quantity` or `dollar_amount` (market
  only) as strings, `limit_price`, `time_in_force` gfd|gtc, `market_hours`,
  and a `ref_id` for idempotency; the response is `{order:{id,state}}`.
  Fractional and dollar orders are regular-hours market only; extended hours
  are limit only.

## 8. Prices without a broker

A paper agent can run before Robinhood is connected: add an **Alpaca
market-data key** (free IEX feed, or SIP if your plan has it) under Settings →
Connections. `shared/marketData.ts priceSourceFor()` is the rule: Robinhood when
connected, your Alpaca key for **paper only**, nothing otherwise — a live agent
is never priced by anything that cannot also place its order.

## 9. Data sources

Settings → MCP servers switches on read-only data-source servers for every
agent (`shared/mcps.ts`): SEC EDGAR, Alpha Vantage and an economic calendar
(Apify) over HTTP; WebVector (web research and market news, via `npx`), Yahoo
Finance and Tiingo (via `uvx`), FRED and Finnhub (via `npx`) as local stdio
processes. Keys are stored encrypted; the renderer only learns whether one
exists.

⚠️ Stdio servers need a vendor that can start a local MCP process — today that
is the Claude provider. OpenRouter, ChatGPT and Local GPU agents reach the HTTP
servers and skip stdio ones with a log line.

## 10. Schedules, sleep, retirement

- `sleep_until` parks an agent until a dated event (up to 120 days); messages,
  watches and question deadlines still wake it.
- A retirement deadline fires at its time; a retirement that cannot flatten
  does not retire, and a refused flatten backs off rather than looping.
- A quiet interval tick — nothing moved, nothing pending — is skipped without
  calling the model, and the run log says why.

## 11. Playbooks

`AgentConfig.playbook: 'earningsPop'` (the **Earnings All-In** template) is a
mode the engine runs: a fixed daily cycle, one name at a time, all spendable
cash per buy, a report-window check, a next-open flatten, and two research
tools (`earnings_candidates`, `earnings_dossier`). The rules live in
`shared/earningsPlaybook.ts` so no task sentence can change them.

## 12. Privacy and network

Nothing is sent anywhere you did not connect. The app makes requests to:

| When | Host |
|---|---|
| Robinhood connected | `agent.robinhood.com`, `api.robinhood.com`, `robinhood.com` |
| Claude provider | Anthropic, through the Claude Agent SDK / Claude Code |
| ChatGPT provider | `auth.openai.com`, `chatgpt.com` |
| OpenRouter provider | `openrouter.ai` |
| Market-data key | `data.alpaca.markets` |
| Data sources you enable | each provider's endpoint; `npx`/`uvx` fetch their packages |
| Local GPU | `127.0.0.1` only |

There is no analytics, crash reporting, auto-update or account. The run tracer
seam (`core/trace/types.ts`) is unused by default.

## 13. Persistence

Everything lives in Electron's `userData` directory:

```
agents/<id>/config.json      the agent's configuration
agents/<id>/state.json       its book, memory, exits, watches… (atomic writes: temp + fsync + rename)
agents/<id>/messages.jsonl   the thread
agents/<id>/runs.jsonl       one record per run
agents/<id>/decisions.jsonl  the decision log
settings.json                app settings (theme, tool policy, defaults, halt)
layout.json                  the sidebar arrangement
credentials/*.bin            tokens and keys, encrypted with safeStorage
```

## 14. Repository layout

```
src/shared     types + pure logic shared by main, preload and renderer (no Node APIs)
src/core       the Electron-free runtime (runner, vendors, broker, robinhood, market, intel)
src/main       Electron main: auth flows, stores, engine, IPC, local model engine
src/preload    the window.tb bridge (TbApi)
src/renderer   React 19 + Tailwind v4 + Zustand 5
scripts/       checks (scripts/checks/check-*.ts) and generators
docs/          this file and the design system
```

## 15. Checks

`npm run check` runs every `scripts/checks/check-*.ts`: standalone, no
credentials, no network. Each pins one behaviour — usually a failure that
happened once — through the real function where possible and through a source
contract where not. `npm run check -- <name>` runs the ones whose file name
contains `<name>`.
