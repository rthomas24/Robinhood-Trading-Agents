/**
 * Goals and guardrails:
 *
 *   13  a plan that widens the fence carries `riskSummary`, and past 10% daily
 *       loss / 25% per order the operator types `widen` (plan card + sheet)
 *   15  the setup prompt sets `retirement.at` ONLY when the task names a date
 *   16  a profit target without a max loss gets one of the same size, said so
 *   17  the daily-loss lock is mark-to-market and judged on the sweep too
 *   18  `goalRealism` turns "10% this week" into 2% a day and says so
 *
 * (The numbers label the sections below.)
 *
 * Run: `npm run check -- goal-guardrails`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, applyPlanToConfig, emptyLedger, goalRealism, goalRealismLine, initialState, needsTypedConfirm, riskSummary, type AgentConfig, type AgentState } from '@shared/agents'
import { etDateTime } from '@shared/marketTime'
import { dailyLossLock, enforceExits } from '@core/broker/execute'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const src = (p: string): string => readFileSync(resolve(import.meta.dirname, '../../', p), 'utf8')
const cfg = { id: 'ag', name: 'T', mode: 'paper', allocationUsd: 10_000, guardrails: { ...DEFAULT_GUARDRAILS }, liveArmedAt: null, retirement: null, task: 't', createdAt: 'x', updatedAt: 'x', schedule: { kind: 'manual' } } as unknown as AgentConfig

async function main(): Promise<void> {
  console.log('— 13. the risk sentence and the typed word —')
  const rs = riskSummary({ ...DEFAULT_GUARDRAILS, maxOrderNotional: 2_500, maxDailyLossPct: 15 }, 10_000)
  check('riskSummary states order, symbol and day in dollars AND % of allocation', /\$2,500 \(25%/.test(rs) && /15% \(\$1,500\)/.test(rs), rs)
  check('15% daily loss needs the word', needsTypedConfirm({ ...DEFAULT_GUARDRAILS, maxDailyLossPct: 15 }, 10_000))
  check('a $3,000 order on $10,000 needs the word', needsTypedConfirm({ ...DEFAULT_GUARDRAILS, maxOrderNotional: 3_000 }, 10_000))
  check('$2,500 (25% exactly) and 10% do not', !needsTypedConfirm({ ...DEFAULT_GUARDRAILS, maxOrderNotional: 2_500, maxDailyLossPct: 10 }, 10_000))
  const card = src('src/renderer/src/components/thread/MessageItem.tsx')
  check('the desktop plan card renders the sentence under the diff and gates Apply on the word', /riskSummary\(nextGuardrails, allocationUsd\)/.test(card) && /disabled=\{!typedOk\}/.test(card))
  const sheet = src('src/renderer/src/components/sheets/AgentSettingsSheet.tsx')
  check('the settings sheet refuses to save a widened fence past the line without the word', /needsTypedConfirm\(guardrailsNow, alloc\) && typed\.trim\(\)\.toLowerCase\(\) !== TYPED_CONFIRM_WORD\)/.test(sheet))

  console.log('\n— 15. retirement.at only for a dated task —')
  const prompts = src('src/core/runner/prompts.ts')
  check('the setup prompt says so', /Set \\`retirement\.at\\` ONLY when the task names a date or a deadline/.test(prompts))

  console.log('\n— 16. a target gets a floor — proposed and SAID, never inferred at the write —')
  // `applyPlanToConfig` is also the apply-card path, which has no
  // sentence to attach: a floor inferred there reached a live agent as a new
  // automatic flatten trigger nobody had read. The tool host proposes it, and
  // the card's summary says so.
  const asWritten = applyPlanToConfig(cfg, { retirement: { profitTargetUsd: 300 }, guardrails: {}, summary: 's' }, 'now')
  check('profitTargetUsd without maxLossUsd is applied as written — no silent floor', asWritten.retirement?.profitTargetUsd === 300 && asWritten.retirement?.maxLossUsd === undefined, JSON.stringify(asWritten.retirement))
  const kept = applyPlanToConfig(cfg, { retirement: { profitTargetUsd: 300, maxLossUsd: 100 }, guardrails: {}, summary: 's' }, 'now')
  check('an explicit max loss is kept', kept.retirement?.maxLossUsd === 100)
  const runOnceSrc = src('src/core/runner/runOnce.ts')
  check('the tool host adds the floor to the PROPOSAL and the card says so', /maxLossUsd: rawPlan\.retirement\.profitTargetUsd \}, summary: `\$\{rawPlan\.summary\} \(max loss set to \$\{money\(rawPlan\.retirement\.profitTargetUsd, 0\)\} to match the profit target/.test(runOnceSrc))

  console.log('\n— 17. mark-to-market lock, at the sweep too —')
  const now = etDateTime('2026-09-03', 11 * 60)
  const today = '2026-09-03'
  const down: AgentState = { ...initialState({ allocationUsd: 10_000 }), paper: { ...emptyLedger(0), positions: [{ symbol: 'MU', qty: 100, avgCost: 100 }] }, dayAnchor: { date: today, equity: 10_000 }, exits: { MU: { stop: 80, setAt: 'x' } } }
  const q = (last: number): Quote[] => [{ symbol: 'MU', last, bid: last, ask: last, ts: 'x' }]
  check('−6% unrealized against a 5% limit locks buying', dailyLossLock(cfg, down, q(94), now)?.date === today)
  check('−4% does not', dailyLossLock(cfg, down, q(96), now) === null)
  check('no anchor today → no lock (nothing ran today)', dailyLossLock(cfg, { ...down, dayAnchor: null }, q(90), now) === null)
  const swept = await enforceExits({ config: cfg, state: down, rh: null, accountNumber: null, quotes: q(94), now })
  check('enforceExits writes the lock without selling anything', swept.state.buyLockDate === today && swept.results.length === 0)
  check('and returns a new object so the sweep persists it', swept.state !== down)
  check('a lock set by the sweep carries a notice for the next run start (the note + the busy signal)', swept.state.buyLockNotice?.date === today && (swept.state.buyLockNotice?.lossPct ?? 0) >= 5, JSON.stringify(swept.state.buyLockNotice))
  // The sweep quotes only the symbols with exits or watches; a book with an
  // unquoted position is half-priced (cost stands in for the mark) and a
  // verdict on it would be a verdict on a book it never saw.
  const twoNames: AgentState = { ...down, dayAnchor: { date: today, equity: 11_000 }, paper: { ...down.paper, positions: [...down.paper.positions, { symbol: 'NVDA', qty: 10, avgCost: 100 }] } }
  check('no lock from a partial mark — a held name without a quote is no verdict', dailyLossLock(cfg, twoNames, q(90), now) === null)
  check('with every held name priced the same book locks', dailyLossLock(cfg, twoNames, [...q(90), { symbol: 'NVDA', last: 100, bid: 100, ask: 100, ts: 'x' }], now)?.date === today)
  check('the desktop sweep persists any change, not only a sale', /if \(ex\.state !== state\) \{\s*agentStore\.saveState\(id, ex\.state\)/.test(src('src/main/engine/Engine.ts')))
  check('DEFAULT maxDailyLossPct is 5', DEFAULT_GUARDRAILS.maxDailyLossPct === 5)
  check('runOnce uses the same function', /const lock = dailyLossLock\(cfg, state, quotes, now\(\)\)/.test(src('src/core/runner/runOnce.ts')))

  console.log('\n— 18. goal realism —')
  const r = goalRealism('Make 10% this week trading MU dips', 10_000)
  check('"10% this week" → 2% a day over 5 days', r?.targetPct === 10 && r?.tradingDays === 5 && r?.impliedDailyPct === 2, JSON.stringify(r))
  const d = goalRealism('turn $10,000 into +$500 by end of day', 10_000)
  check('"$500 today" on $10,000 → 5% a day', d?.impliedDailyPct === 5, JSON.stringify(d))
  check('"by Sep 30" counts trading days to the date', (goalRealism('grow the account 20% by Sep 30', 10_000, '2026-09-03T00:00:00Z')?.tradingDays ?? 0) >= 18)
  check('a standing job with no goal → null', goalRealism('Buy MU at 3:58 and sell at 9:31 every day', 10_000) === null)
  check('a goal with no horizon → null', goalRealism('make 10% on MU', 10_000) === null)
  check('the line says it is a hope when the range cannot deliver it', /not a plan, a hope/.test(goalRealismLine(r!, 1.2)))
  check('and says ambitious-but-inside when it can', /inside the range/.test(goalRealismLine(r!, 3.5)))
  check('the New-agent sheet shows it under the task box', /goalRealismLine\(realism, null\)/.test(src('src/renderer/src/components/sheets/NewAgentSheet.tsx')))
  check('the first run pins it against the watchlist range', /Goal check: \$\{goalRealismLine\(realism, range\)\}/.test(src('src/core/runner/runOnce.ts')))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}
void main()
