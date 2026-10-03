# Robinhood Trading Agents

> An independent open-source project. **Not made by, affiliated with or endorsed by
> Robinhood Markets, Inc.** "Robinhood" here names the broker the app connects to.

**Every trading agent is a message thread.**

Give an agent one job in plain English, for example _"Buy $500 of MU at 3:58 PM every trading
day and sell it at 9:31 AM the next morning."_ It turns that into a schedule and a set of
guardrails, then runs on that schedule **on your computer**. It trades through **your own
Robinhood account** and reports back in its thread like a colleague texting you. You can
message it at any time to adjust it, question it, or override it.

Robinhood Trading Agents is a local-first desktop app built with Electron and React. There
is no server, no sign-up and no telemetry. Your agents, their books and your credentials stay
on your machine, and the app talks only to the services you connect yourself. See
**[SECURITY.md](SECURITY.md)** for exactly what is stored where and what leaves your computer.

<!-- SCREENSHOT: docs/screenshots/hero.png — the main window: sidebar of agents, one thread open, status bar -->

> [!WARNING]
> **This is not financial advice, and it can lose money.** Language models make mistakes.
> An agent with live trading armed places real orders in your brokerage account.
> - Every agent starts in **paper** mode: simulated fills at real quotes.
> - Live mode has to be armed explicitly, per agent.
> - Read the guardrails before you arm anything, and start small.
>
> The software is provided "as is", without warranty of any kind (see [LICENSE](LICENSE)).

---

## Contents

- [How it works](#how-it-works)
- [Features](#features)
  - [Agents as conversations](#agents-as-conversations)
  - [Creating an agent](#creating-an-agent)
  - [Schedules, sleep and retirement](#schedules-sleep-and-retirement)
  - [Paper and live trading](#paper-and-live-trading)
  - [Guardrails](#guardrails)
  - [Exits the engine enforces](#exits-the-engine-enforces)
  - [Ask-first or autonomous](#ask-first-or-autonomous)
  - [Check-ins and notifications](#check-ins-and-notifications)
  - [Bring your own model](#bring-your-own-model)
  - [Market data and data sources](#market-data-and-data-sources)
  - [Track record, stats and portfolio](#track-record-stats-and-portfolio)
  - [The Earnings All-In playbook](#the-earnings-all-in-playbook)
  - [Organising agents](#organising-agents)
  - [Look and feel](#look-and-feel)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Settings at a glance](#settings-at-a-glance)
- [Development](#development)
- [Security and privacy](#security-and-privacy)
- [Third-party services and terms](#third-party-services-and-terms)
- [License](#license)

---

## How it works

```
 you ──message──▶ agent thread ──run──▶ model (Claude · ChatGPT · OpenRouter · local GPU)
                       ▲                     │ decides, using tools
                       │                     ▼
                 report / cards ◀──── engine: guardrails → paper ledger or Robinhood order
```

1. **An agent wakes up.** Its schedule fires, you send a message, a price watch triggers, or
   a deadline passes.
2. **The engine builds its context.** That includes:
   - the agent's own book (cash, positions, open orders);
   - quotes and computed technicals for the symbols it cares about;
   - the market clock;
   - its memory, theses and armed exits;
   - recent refusals and the recent thread.
3. **The model decides, using tools.** It can research with read-only tools, place a trade,
   set an exit, watch a price, change its plan, ask you something, or report.
4. **The engine, not the model, executes.** Every order is checked against the agent's
   guardrails before it goes to the paper ledger or to Robinhood. Every allowed or blocked
   call is written to a decision log.
5. **The agent reports back in the thread:** what it did, why, and when it runs next.

---

## Features

### Agents as conversations

<!-- SCREENSHOT: docs/screenshots/thread.png — a thread with a report memo, a trade receipt and an expanded tool call -->

- **One agent, one thread.** Each agent is a conversation. The thread holds:
  - its run reports, written as short memos with facts and a "next" line;
  - a **trade receipt** for every fill: side, size, price, notional and, for sells, the
    realized P&L and the cost basis it closed against;
  - plan cards, questions and approval requests.
- **Full tool transparency.** Every run groups its messages on one rail. Every tool call can be
  expanded to see:
  - the exact input and result, drawn as tables, key-value lists or prose (with a Raw view and
    Copy);
  - how long the call took;
  - whether the engine refused it, and why.
- **Live runs.** While a run is in progress you see it stream: thinking, each tool step as it
  lands, then the reply.
- **Message any time.** A message sent mid-run is queued and answered right after, and the
  composer says so. **Stop** ends a run, and the thread marks where it got to.
- **Memory, theses and errands.** Agents keep:
  - **memory notes**: durable facts;
  - **theses**: why they hold a position;
  - **errands**: deferred work that clears itself, like "set the 5% watch when the market
    opens", shown with whether its moment has arrived.
- **Multiple tasks and spin-offs.** An agent can carry up to five related tasks. It can
  propose a new task, or propose spinning work off into a separate agent. You confirm either
  with one tap.
- **Thread search.** Agents can search their own history when they need something older than
  what fits in their context.

### Creating an agent

<!-- SCREENSHOT: docs/screenshots/new-agent.png — the New agent sheet with the template strip -->

- **26 starter templates**, all ask-first, paper, and free of dollar sizes. They cover:
  - intraday rides (Opening Gap Rider, VWAP Reclaim, Power Hour);
  - overnight and swing holds (MU Overnight, Trend Pullback, Breakout Hunter);
  - investing books (VOO Weekly, Dividend Ladder, 60/40 Rebalancer);
  - research-first agents (Morning Brief, Earnings Scout, Filings Watch, Macro Watch).

  Templates are starting points written as illustrations, not recommendations. Every field
  stays editable.
- **Write your own task** in plain English. On its first run the agent proposes a schedule
  and limits as a plan card you confirm or edit.
- **Choose:** paper or live, the model it runs on, its allocation, and whether it acts on its
  own or asks first.
- **Names itself.** Leave the name blank and the agent picks one on its first run.
- **Duplicate** any agent into a fresh thread and book, starting in paper.

### Schedules, sleep and retirement

- **Schedules:**
  - manual;
  - every N minutes, optionally only during market hours;
  - at set ET clock times on chosen weekdays;
  - once, at a set time.
- **Late wake-ups are honest.** A wake-up that arrives more than a few minutes late is
  reported as missed rather than run silently at the wrong time.
- **Quiet ticks are free.** An interval tick where nothing moved and nothing is pending is
  skipped without calling the model, and the run log says why.
- **`sleep_until`.** An agent waiting on a dated event (an earnings date, a release) can park
  itself for up to 120 days. Messages and price watches still wake it.
- **Retirement policies.** Set a profit target, a max loss or a deadline. A retirement that
  cannot flatten the book does not retire: exits stay armed and you are told. Retired agents
  keep their stats and can be **respawned**. A respawned agent revises its plan for today and
  tells you what changed.
- **Offline-aware.** While your computer is offline, wake-ups for network models are skipped
  with one note and replayed when the connection returns. Local GPU agents keep running.

### Paper and live trading

- **Paper by default.**
  - Simulated fills at the real bid or ask plus a small slippage.
  - Limit orders rest until they are marketable or expire.
  - Sale proceeds settle T+1 when cash settlement is on (the default for new agents), so a
    paper agent rehearses what a real cash account allows.
- **Live trading is armed per agent**, with an explicit confirmation.
- **Each live agent keeps a sub-ledger of only its own fills.** The shared brokerage account
  is never mirrored into an agent's book.
- **Allocations are checked.** A live allocation must fit in the buying power the other live
  agents leave free.
- **Real order handling.** Fractional and dollar market orders run in the regular session;
  whole-share limits run outside it. Live fills are polled to completion.

### Guardrails

<!-- SCREENSHOT: docs/screenshots/agent-settings.png — Agent settings, guardrails section -->

The engine enforces every rule below on every order. Each refusal carries a rule name in the
decision log.

| Guardrail | What it does |
|---|---|
| Allowed symbols | Restrict an agent to a list of tickers |
| Max per order / per symbol | Notional caps on each order and on each position |
| Orders per day | A daily order cap. Sells you ask for in the thread are exempt |
| Daily loss lock | Buying stops for the day after a set loss; selling still works |
| Market hours | Regular session only, or allow extended hours (limit orders) |
| Entry window | No buys before a set time, e.g. skip the opening range |
| Max extension | No buys too far above VWAP or the day's open |
| Per-symbol-per-day and per-run caps | No piling into one name |
| Re-entry cooldown | A wait after a losing sell before buying that name again |
| Settled cash | In a cash account, buys can spend only settled cash |
| **Trading halt** | A global panic switch: live **buys** refused on every agent; sells and stops keep working |

Plans that **widen** limits say so in plain language, and large widenings require typing
`widen` to confirm.

### Exits the engine enforces

- **Exit types:** stop-loss, profit target, trailing stop, invalidation levels with the
  agent's own reason, a break-even ratchet, a partial take-profit, an opening-range grace
  period, and a flatten-at time.
- **Enforced by the engine.** Exits are checked every 15 seconds and at every run start. They
  fire without waiting for the model.
- **Trailing-stop width is checked.** A trailing stop narrower than the stock's normal daily
  swing is answered with the numbers before it is placed.
- **Exit cards say what happened.** An engine exit's card shows which level fired, where it
  filled, and the dollars between.
- **After the exit.** Fifteen minutes later the agent gets a short post-mortem of what the
  price did next.
- **Price watches.** These wake an agent when a level is hit, without spending a model call
  on polling.

### Ask-first or autonomous

<!-- SCREENSHOT: docs/screenshots/approval.png — an approval card in a thread -->

- **Ask me first.** Every trade, exit change and retirement waits as an **approval card**,
  and the agent pauses until you answer.
- **Approving is not executing.** The agent re-checks against the current price and may decide
  the moment has passed. A yes covers that one action only.
- **On its own.** The agent acts within its guardrails and alerts you about anything that
  widens them.

### Check-ins and notifications

- **Questions.** Agents can ask you a question with a deadline and a required fallback ("if I
  don't hear back in 10 minutes, I'll sell half"). They do the fallback if you don't answer.
- **Rate limits.** Unattended agents get a small daily allowance of questions and alerts, so
  they can't spam you.
- **Desktop notifications.** You get notified for questions, important notes, live fills,
  errors and fired watches.

### Bring your own model

<!-- SCREENSHOT: docs/screenshots/provider-picker.png — the "Runs on" provider picker -->

Each agent picks its own provider, and you can switch it at any time. Agents on different
providers run side by side.

| Provider | What you need | Models |
|---|---|---|
| **Claude** | Claude Code signed in on this computer | Sonnet 5.5, Opus 5.5, Fable 5.1 and earlier |
| **ChatGPT** | A ChatGPT Plus / Pro / Team subscription | GPT-5.5, GPT-6.1-Sol, GPT-6-Astra, GPT-6-Luna and more |
| **OpenRouter** | Your own OpenRouter API key | Any OpenRouter model; GLM 5.3 Flash by default |
| **Local GPU** | A GGUF model file and llama.cpp | Whatever you run. Private, free, works offline |

Run-safety guards apply to every provider:

- a stall watchdog and a hard time limit per run;
- retries for transient errors only;
- a loop guard that refuses the same call repeated over and over;
- a single re-ask when a model ends its turn without doing anything.

### Market data and data sources

- **Robinhood** quotes and historical bars when connected.
- **Alpaca market-data key (optional).** Paper agents can price trades before you connect a
  broker.
- **Computed technicals.** Agents are given numbers computed in code, not left to estimate
  them: VWAP, the opening range, ATR, average daily range, distance from the open, and days to
  earnings.
- **Optional data sources (MCP servers)** that every agent can read:
  - SEC EDGAR filings;
  - Alpha Vantage news and sentiment;
  - an economic calendar;
  - Yahoo Finance, Tiingo, FRED and Finnhub;
  - WebVector web research and market news.

  Keys are stored encrypted. The ones that run as local processes (WebVector, Yahoo Finance,
  Tiingo, FRED, Finnhub) currently need the Claude provider.
- **Robinhood tool controls.** Turn individual read tools off for every agent. Robinhood write
  tools are off unless you enable them, and even then only live, armed agents can reach them.

### Track record, stats and portfolio

<!-- SCREENSHOT: docs/screenshots/stats.png — an agent's stats sheet with track record and risk panel -->
<!-- SCREENSHOT: docs/screenshots/portfolio.png — the paper portfolio page with the P&L timeline -->

- **Stats sheet per agent:**
  - win rate, profit factor and realized P&L;
  - a breakdown by entry time, holding period and trailing-stop width;
  - a risk panel: largest position, cash share, positions carrying an intraday exit
    overnight, trailing-stop distances.
- **Decision log, read as a sentence.** For example: "held back 4 times in the last 7 days,
  mostly by the daily order cap", with the raw rows underneath.
- **Copyable scorecard.** It says PAPER or LIVE first and "not a forecast" last.
- **Portfolio page.** Paper and live books shown separately, never summed, with a P&L
  timeline across days.

### The Earnings All-In playbook

An engine-run mode started from the **Earnings All-In** template:

- **One name at a time**, bought into a report after today's close or before tomorrow's open.
- **Sized to all spendable cash**, and flattened at the next open.
- **Research tools for this mode:** an earnings candidate scan, and a dossier for one name.
  The dossier compares the options-implied move with real past reactions, EPS surprises,
  revenue trends and the run-up into the print.

### Organising agents

- **Groups.** Arrange agents into named, colour-tinted groups by dragging. Groups can be
  reordered and collapsed.
- **A "Waiting on you" queue** for agents with an open question or approval.
- **Command palette** (`Ctrl/⌘ K`) to jump anywhere or run any action.
- **Up to 10 active agents.** Retired agents don't count.

### Look and feel

<!-- SCREENSHOT: docs/screenshots/themes.png — the theme picker -->

- **18 themes**, light and dark, with a one-click toggle in the status bar.
- **Calm mode** drains profit-and-loss colour from the whole app. Safety signals are never
  dimmed.
- **Interface style:** iMessage-style proportions, tabular numerals everywhere, and a status bar
  showing connection state and your Claude 5-hour usage.

---

## Requirements

- **Node.js** 20.19+ or 22.12+ and npm, to build from source.
- A **model provider**, at least one of:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code) signed in on this computer;
  - a ChatGPT Plus/Pro/Team subscription;
  - an [OpenRouter](https://openrouter.ai) API key;
  - a GGUF model plus [llama.cpp](https://github.com/ggml-org/llama.cpp/releases), with
    `llama-server` on your `PATH`.
- A **Robinhood** account with Agentic Trading, for live trading and broker quotes. You
  connect it with OAuth in your browser.
- **Optional:**
  - an [Alpaca](https://alpaca.markets) market-data key, for paper pricing without Robinhood;
  - keys for any data sources you enable;
  - `npx`/`uvx` on your `PATH` for the local-process data sources.

## Getting started

```bash
git clone <this repository>
cd robinhood-trading-agents
npm install
npm run dev
```

<!-- SCREENSHOT: docs/screenshots/onboarding.png — the first-launch onboarding -->

First launch walks you through three steps:

1. **Pick a model.** Sign in to Claude or ChatGPT, add an OpenRouter key, or point the app at
   a folder of GGUF models.
2. **Connect a broker.** Sign in to Robinhood, or add a market-data key and trade on paper
   only.
3. **Create your first agent.** Start from a template or write your own task.

To build an installer:

```bash
npm run dist:win     # or dist:mac / dist:linux → dist/
```

Builds are unsigned, so macOS and Windows will warn the first time you open one.

### Optional environment variables

| Variable | Purpose |
|---|---|
| `TB_CLAUDE_CLI_PATH` | Path to the `claude` executable, if it is not on your `PATH` |
| `TB_LOCAL_ENGINE_PORT` | Port for the local model engine (default `8905`) |

Leave `ANTHROPIC_API_KEY` unset. The Claude provider is built around your Claude Code login,
and a set key overrides it with per-token API billing. The app warns when it sees one.

## Settings at a glance

<!-- SCREENSHOT: docs/screenshots/settings.png — the Settings page -->

| Section | What's there |
|---|---|
| **Connections** | Claude, ChatGPT, OpenRouter, Robinhood, market data |
| **Trading safety** | The trading halt |
| **Local models** | Your GGUF folder, the default model, engine status |
| **MCP servers** | Optional data sources and their keys |
| **Robinhood tools** | Turn read tools off; opt in to write tools for live agents |
| **Preferences** | Theme, the default provider and model for new agents |

## Development

```bash
npm run dev          # Electron app with hot reload
npm run typecheck    # main + preload + renderer
npm run check        # every behaviour check in scripts/checks (no network, no credentials)
npm run check -- exit-sweep    # only checks whose name contains "exit-sweep"
npm run build        # production build → out/
npm run preview      # the renderer alone in a browser, against fixture data
```

```
src/shared     types + pure logic shared by every process (no Node APIs)
src/core       the Electron-free runtime: runner, model vendors, broker, Robinhood, market data
src/main       Electron main: auth flows, stores, the engine, IPC, the local model engine
src/preload    the window.tb bridge
src/renderer   React 19 + Tailwind v4 + Zustand 5
scripts        behaviour checks and generators
```

Further reading:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how a run works, the guardrails, the
  Robinhood wire details and the persistence layout.
- [`docs/DESIGN.md`](docs/DESIGN.md): the interface's rules.
- [`CLAUDE.md`](CLAUDE.md): the load-bearing rules, if you work on the code with an AI
  assistant.

## Security and privacy

**Read [SECURITY.md](SECURITY.md).** It covers:

- where every file and secret is stored, and how secrets are encrypted;
- exactly which hosts the app contacts, and when;
- the trading safety controls and how prompt injection is contained;
- how to revoke access and wipe everything;
- how to report a vulnerability.

The short version:

- Everything lives in your user-data folder.
- Credentials are encrypted with your operating system's keychain.
- Nothing is sent anywhere you didn't connect.

## Third-party services and terms

Robinhood Trading Agents is an independent open-source project. It is not made by, affiliated with,
endorsed by or sponsored by Robinhood Markets, Inc., Anthropic, OpenAI, OpenRouter, Alpaca or any data
provider. All product names and logos belong to their owners.

You connect your own accounts, and **you are responsible for complying with each service's
terms**:

- **Robinhood:** review the Agentic Trading and API terms in your Customer Agreement.
- **Claude and ChatGPT:** these providers run on your own subscription logins. Both vendors
  restrict how their subscription credentials may be used by third-party apps, and they can
  change or enforce that at any time.
- **OpenRouter and Local GPU:** an API key you own, or a model on your own hardware, does
  not depend on a subscription login.

## License

[MIT](LICENSE)
