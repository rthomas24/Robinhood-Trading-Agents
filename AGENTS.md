# AGENTS.md

Guidance for AI coding agents working in this repository. Read
`docs/ARCHITECTURE.md` first — it is the product and technical contract.

## What this is

Robinhood Trading Agents: a local-first Electron desktop app where **every trading agent is
a message thread** with a task, a schedule, guardrails and its own book. Agents
think with a model the operator connects (Claude Code login, ChatGPT
subscription, their own OpenRouter key, or a local GGUF model) and trade **only**
through the operator's own Robinhood account via the Robinhood Agentic Trading
MCP. No server, no account, no telemetry.

## Commands

```bash
npm run dev            # Electron app with HMR
npm run typecheck      # node + web (passes --composite false)
npm run check          # every scripts/checks/check-*.ts; `npm run check -- <name>` filters
npm run build          # typecheck + electron-vite build → out/
npm run dist:win|dist:mac|dist:linux
npm run preview        # renderer only, in a browser, against src/renderer/src/dev/mockTb.ts
```

Always run `npm run typecheck` and `npm run check` after a change. There is no
linter.

## Layout and boundaries

- `src/shared` — types and pure logic used by every process. **No Node APIs.**
  Every user-facing sentence the engine and the UI must agree on lives here.
- `src/core` — the Electron-free runtime: `runner/runOnce.ts` (one run),
  `runner/agentTools.ts` (tool defs: name + description + zod schema + host
  handler), `runner/prompts.ts`, `runner/vendors/{claude,chatgpt,openrouter,local}.ts`,
  `broker/{guardrails,execute,paper}.ts`, `robinhood/{oauth,mcp,api,tools}.ts`,
  `market/` (feeds), `intel/servers.ts`, `research/`. **Never import
  `electron` here.**
- `src/main` — Electron main: the `Engine` (one `AgentRunner` per agent), JSON
  stores, auth flows, IPC (`ipc/register.ts`), the local model engine.
- `src/preload` — the `window.tb` bridge (`TbApi` in `shared/ipc.ts`).
- `src/renderer` — React 19 + Tailwind v4 + Zustand 5 (`store/appStore.ts`;
  select stable references).

The host ↔ core seam is `RuntimeDeps` (`core/runner/types.ts`): vendors,
storage, credentials, tools policy, capacity, market feed, account controls,
audit, emit, log. The desktop implements it in `main/engine/Engine.ts`.

## Load-bearing rules

- **The engine trades, the model decides.** The model gets read-only
  `mcp__robinhood__*` tools plus our `mcp__tb__*` tools. Orders go through
  `checkGuardrails` → `executeTrade` (paper ledger, or a live Robinhood order
  with poll-for-fill). Robinhood write tools are off unless enabled in Settings →
  Robinhood tools, and even then only live + armed agents can call them
  (`core/robinhood/tools.ts isRobinhoodToolAllowed`).
- **One tool-call path.** `makeRunTool` (`core/runner/vendors/shared.ts`) is gate
  → argument validation → dispatch → audit, used by every vendor (the Claude
  vendor routes our in-process tools through it too). The `ToolGate.vet` is the
  ONE choke point for the approval hold, the loop guard and the run-over
  refusal. New write tools must be covered there, not re-implemented.
- **Four vendors, one agent.** `ModelChoice.vendor` is the provider
  (`shared/provider.ts providerOf`). Tool names are identical across vendors;
  prompts, allowlists and the UI never branch on vendor. Add a vendor by
  implementing transport only. ESM-only SDKs (`@anthropic-ai/claude-agent-sdk`,
  `@openrouter/agent`, `@openrouter/sdk`, `@modelcontextprotocol/client`) stay
  external and are dynamically imported once (`main/claude/sdk.ts`,
  `main/openrouter/sdk.ts`).
- **Claude auth = the Claude Code login** (`~/.claude/.credentials.json` or a
  setup token). Never rely on `ANTHROPIC_API_KEY` (the app warns if it is set).
  The ChatGPT vendor uses an unofficial Codex endpoint, isolated in
  `main/chatgpt/*` and `vendors/chatgpt.ts`. OpenRouter uses the operator's own
  key (`main/store/openrouterKey.ts`).
- **One writer per book.** Tool handlers are snapshot → await → assign on the
  run's shared state and some SDKs run a turn's tool calls concurrently.
  `core/runner/serial.ts exclusiveLane()` serialises them; anything that
  mutates run state rides the lane, and nothing inside the lane awaits the lane.
- **Guardrails have rule keys.** Every refusal has a stable key in
  `shared/decisions.ts` (`cap.orderNotional`, `live.notArmed`,
  `lock.dailyLoss`, `account.tradingHalted`…), so the decision log and the
  engine cannot drift. `RULE_LABEL` is a `Record` over the closed set — a new
  rule without a phrase fails to compile. New entry rules are BUY-ONLY and
  absent on agents made before them.
- **Exits are levels the engine enforces** (`ExitPlan`, `armExitPlan`,
  `enforceExits`): stop, target, trail (floor-checked), `stopIf`,
  `breakEvenAfterPct`, `targetPct`, `armAfterMin`, `flattenAt`. The 15 s
  desktop watcher and every run start go through `enforceExits`.
- **Live agents keep a sub-ledger** of their own fills. Never mirror the shared
  Robinhood account into an agent's book.
- **The trading halt** (`AppSettings.tradingHalted`) refuses live BUYS only —
  sells and stops keep working.
- **Approval is not execution.** Ask-first agents hold write tools as an
  `approval` card; approving asks the agent to re-decide against the price now,
  and the pass (`approvalCovers`) is narrow and spent on the first successful
  matching execution.
- **Schedules**: `nextRunAt()` / `nextWakeAt()` in `shared/schedule.ts` are the
  single source of truth; a late wake-up past `CATCH_UP_GRACE_MS` is reported as
  missed rather than silently run. Timers go through `Engine.ts timerFor`
  (Node clamps long `setTimeout`s).
- **Everything rendered as a time is ET** — use `formatEt` from
  `shared/marketTime.ts`, never `toLocaleString()`.
- **Untrusted text**: tool results are capped and sanitised
  (`neutralizeStructuralMarkers` before truncating) at each vendor seam;
  nothing that leaves the runtime carries a credential (`core/redact.ts`).
- **The window shows only the app.** Every URL handed to the OS goes through
  `openExternalSafely` (`main/lib/openExternal.ts` → `shared/externalUrl.ts`);
  never call `shell.openExternal` directly. Navigation guards are registered for
  every web contents in `main/index.ts`. Markdown in agent prose renders no
  `<img>`, and the CSP refuses remote images. Pinned by
  `check-renderer-hardening.ts`.
- **Secrets and ids on disk**: secret files go through `main/lib/secureFile.ts`
  (`readSecretJson` / `writeSecretJson`, atomic). An id becomes a path only
  through a store's `pathOf()`, which refuses anything `isStoredId` rejects.
  `agents:update` takes only the `UpdateAgentPatch` fields; `liveArmedAt` changes
  only through `armLive`.
- **Atomic writes**: desktop JSON goes through `store/json.ts writeFileAtomic`
  (temp + fsync + rename) — `state.json` is an agent's book.
- **A discarded error is a confident negative.** Destructure the error and
  decide; never let "could not read" become "there is nothing".
- **Robinhood wire quirks** live in `core/robinhood/api.ts` (string numerics,
  `results[].quote.*`, `{order:{id,state}}`, the post-close previous-close
  rollover). Verify new tool shapes against the live MCP before adding
  wrappers.

## Checks

`scripts/checks/check-*.ts` are standalone tsx scripts (no network, no
credentials) run by `scripts/run-checks.ts` with `scripts/tsconfig.json` for
the `@shared/*`, `@core/*`, `@renderer/*` aliases. Prefer exercising the real
function over grepping its source; when a source contract is the only option,
make it CRLF-safe. A check must never read outside this repository.

## UI

Light-first flat design, iMessage proportions. Tokens live in
`src/renderer/src/index.css`; the rules are in `docs/DESIGN.md` (no hex
literals in components, colour rationed to meaning, tabular numerals, motion
on transform/opacity only). Themes are a catalog in `shared/themes.ts`.
