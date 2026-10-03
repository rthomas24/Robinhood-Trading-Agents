/**
 * The prompt breakdown, exercised THROUGH ITS REAL CALLER.
 *
 * A module can be adversarially probed at 10,000 / 7 / 999,983 and look done
 * while having **no caller** — it never runs, so no category figures are ever
 * persisted, and nothing downstream of it can be built. One shape: attack the
 * module, forget the caller.
 *
 * The rule: *a feature is not verified until a check exercises it through its
 * real caller.* Probing an exported function proves the export.
 *
 * So this drives the real `runOnce` with a stub vendor and asserts the figures
 * land on the RunRecord. It is the first check in the suite that invokes
 * `runOnce` rather than reading its source — which is the point. A source
 * assertion would have passed against the uncalled version if someone had
 * written `promptBreakdown(` in a comment.
 *
 * Run: `npm run check -- prompt-breakdown-wiring`
 */
import { DEFAULT_GUARDRAILS, initialState, type AgentConfig, type AgentState, type Message, type RunRecord } from '@shared/agents'
import type { AgentStorage, RuntimeDeps } from '@core/runner/types'
import type { VendorRunResult } from '@core/runner/vendors/types'
import { runOnce } from '@core/runner/runOnce'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const ID = 'ag_pb'
const cfg = {
  id: ID,
  name: 'Breakdown',
  task: 'watch MU and report',
  mode: 'paper',
  createdAt: '2026-01-01T00:00:00Z',
  schedule: { kind: 'manual' },
  guardrails: { ...DEFAULT_GUARDRAILS, allowedSymbols: ['MU'] },
  allocationUsd: 10_000,
  model: { vendor: 'openrouter', id: 'x-ai/grok-4.6', effort: 'medium' },
  icon: 'a',
  color: '#fff',
} as unknown as AgentConfig

/** A vendor that answers instantly, reporting whatever context total we ask it to. */
const stubVendor = (contextTokens: number) => ({
  vendor: 'openrouter' as const,
  async run(): Promise<VendorRunResult> {
    return { texts: ['ok'], thinking: [], toolCalls: [], inputTokens: contextTokens, outputTokens: 10, contextTokens, sessionId: null, stoppedBecause: 'natural' }
  }
})

async function runWith(contextTokens: number): Promise<RunRecord> {
  let state: AgentState = initialState(cfg)
  const runs: RunRecord[] = []
  const messages: Message[] = []
  const storage: AgentStorage = {
    async getConfig() {
      return cfg
    },
    async getState() {
      return state
    },
    async saveState(_id, s) {
      state = s
    },
    async saveConfig() {},
    async appendMessage(m) {
      messages.push(m)
    },
    async updateMessage() {},
    async recentMessages() {
      return messages
    },
    async searchMessages() {
      return { messages: [], scannedAll: true }
    },
    async appendRun(r) {
      runs.push(r)
    }
  }
  const deps = {
    vendors: { openrouter: stubVendor(contextTokens) },
    storage,
    creds: { async robinhoodToken() { return null } },
    cwd: process.cwd(),
    emit: () => {},
    log: () => {}
  } as unknown as RuntimeDeps
  await runOnce(deps, { agentId: ID, trigger: 'manual' })
  if (runs.length !== 1) throw new Error(`expected one run record, got ${runs.length}`)
  return runs[0]
}

// ── the figures reach the row ──────────────────────────────────────────────
const run = await runWith(50_000)
const cats = run.promptCategories ?? []
check('a real runOnce persists prompt categories', cats.length > 0, `${cats.length} categories`)
check('...with the system prompt among them', cats.some((c) => c.id === 'system'), cats.map((c) => c.id).join(','))
check('...and the tool definitions', cats.some((c) => c.id === 'tools'))
check('...and blocks from the registry, not a fixed list', cats.length > 3, cats.map((c) => c.id).join(','))
check('every category measured real chars', cats.every((c) => c.chars > 0))
check('shares are a distribution', Math.abs(cats.reduce((s, c) => s + c.share, 0) - 1) < 0.001, String(cats.reduce((s, c) => s + c.share, 0)))

// ── tokens are apportioned from the vendor's real total ────────────────────
const attributed = cats.reduce((s, c) => s + (c.tokens ?? 0), 0)
check('tokens are apportioned when the vendor reported a total', cats.every((c) => typeof c.tokens === 'number'))
check(
  'attributed + unaccounted === the reported total, exactly',
  attributed + (run.promptUnaccountedTokens ?? 0) === 50_000,
  `${attributed} + ${run.promptUnaccountedTokens ?? 0} vs 50000`
)
check('the residual is NAMED, not spread to look tidy', typeof run.promptUnaccountedTokens === 'number')

// ── absence, which is the whole reason the breakdown anchors on contextTokens
// A vendor that reported nothing must yield chars-only. A category carrying
// `tokens: 0` would read as "measured zero" and is the defect this codebase
// keeps making.
const none = await runWith(0)
const nc = none.promptCategories ?? []
check('an unreported total still persists the char split', nc.length > 0, `${nc.length}`)
check('...with NO token figures at all', nc.every((c) => c.tokens === undefined), nc.filter((c) => c.tokens !== undefined).map((c) => c.id).join(','))
check('...and no unaccounted figure either', none.promptUnaccountedTokens === undefined, String(none.promptUnaccountedTokens))
check('contextTokens itself stays absent rather than 0', none.contextTokens === undefined, String(none.contextTokens))

// ── the renderer can read it ───────────────────────────────────────────────
// The persisted shape must be plain data in `src/shared` — the renderer cannot
// import anything under `src/core`.
check('the persisted categories survive a JSON round trip', JSON.stringify(JSON.parse(JSON.stringify(cats))) === JSON.stringify(cats))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
