/**
 * A respawned agent revises itself for today — it does not improvise, and it
 * does not ask the operator to do its date arithmetic.
 *
 * If nothing tells a respawned agent what being back MEANS, each invents an
 * answer: one re-reads the tape and trades, one idles, and one burns a check-in
 * on ask_operator("What's the new goal?") over a 10%-by-Friday mandate whose
 * only problem is that Friday has passed — a deadline it could simply roll
 * forward.
 *
 * The contract, asserted here:
 *   1. the respawn path (Engine) stamps `state.respawnedAt` and requests an
 *      immediate `manual` run — a manual-schedule agent has no next tick, and
 *      the operator who pressed Respawn is watching;
 *   2. while the flag is set, the run prompt carries `respawnBlock()` — revise
 *      the plan for today with change_plan, re-check theses/exits, then TELL
 *      the operator what changed; asking is the exception and must arrive with
 *      a proposed translation;
 *   3. change_plan AUTO-APPLIES during the revision window (rolling a deadline
 *      must not post a pending card — that is the same stall in card form) but
 *      the loosening fence is untouched: no revision widens its own limits;
 *   4. the flag clears only when a run COMPLETES, so a failed attempt keeps
 *      the instructions for the retry;
 *   5. retired agents never render the block (respawn clears retired first).
 *
 * Run: `npm run check -- respawn-revision`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { respawnBlock, runPromptBlocks, renderBlocks } from '../../src/core/runner/prompts'
import { AGENT_TOOLS } from '../../src/core/runner/agentTools'
import { initialState, DEFAULT_GUARDRAILS, type AgentConfig } from '../../src/shared/agents'
import { LIFECYCLE } from '../../src/shared/lifecycle'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ------------------------------------------------------------------ the block

const blank = respawnBlock({ respawnedAt: null })
check('no flag → no block', blank === '')

const block = respawnBlock({ respawnedAt: '2026-08-31T17:44:48.954Z' })
check('flagged → the block renders', block.length > 0)
check('it says the agent was respawned, with the moment', /RESPAWNED/.test(block) && /Aug|ET/.test(block))
check('it orders a self-revision via change_plan', /change_plan/.test(block) && /roll deadlines forward/i.test(block))
check('it keeps the mission — updating, not reinventing', /updating yourself, not inventing a new job/.test(block))
check('it re-states the cleared retirement policy', /retirement policy/.test(block) && /cleared/.test(block))
check('it re-checks theses/exits/watches against today', /set_thesis \/ set_exit \/ watch_price/.test(block))
check('it ends by telling the operator what changed', /TELL THE OPERATOR WHAT CHANGED/.test(block))
check('asking the operator is the exception, with a proposed translation', /Do NOT ask the operator what your goal is/.test(block) && /propose your best translation/.test(block))
check('it names the loosening fence (autonomous: applied with an alert)', /WIDEN your limits/.test(block) && /posted to the operator as an alert/.test(block))
check('an ask-first agent is told a widening waits for the tap', /wait for the operator's tap/.test(respawnBlock({ respawnedAt: '2026-08-31T17:44:48.954Z' }, new Date(), false)))

// ------------------------------------------------- wired into the run prompt

const cfg: AgentConfig = {
  id: 'ag_test',
  name: 'Respawn Test',
  task: 'Make 10% by Friday',
  mode: 'paper',
  model: { vendor: 'claude', id: 'claude-sonnet-5' },
  schedule: { kind: 'manual' },
  guardrails: DEFAULT_GUARDRAILS,
  allocationUsd: 10_000,
  createdAt: '2026-08-24T00:00:00Z',
  updatedAt: '2026-08-24T00:00:00Z'
} as AgentConfig

const base = { cfg, trigger: 'manual' as const, market: { quotes: [], account: null, session: 'open' as const, etNow: 'now', analysis: '' }, messages: [], ordersToday: 0 }

const flagged = renderBlocks(runPromptBlocks({ ...base, state: { ...initialState(cfg), respawnedAt: '2026-08-31T17:44:48.954Z' } }))
check('run prompt carries the block while the flag is set', flagged.includes('YOU WERE JUST RESPAWNED'))

const unflagged = renderBlocks(runPromptBlocks({ ...base, state: initialState(cfg) }))
check('and not otherwise', !unflagged.includes('YOU WERE JUST RESPAWNED'))

const retired = renderBlocks(runPromptBlocks({ ...base, state: { ...initialState(cfg), status: 'retired' as const, respawnedAt: '2026-08-31T17:44:48.954Z' } }))
check('a retired agent never renders it', !retired.includes('YOU WERE JUST RESPAWNED'), 'respawn clears retired before any run; a stale flag on a retired row must not instruct')

// ----------------------------------------------------------- source contracts

const R = join(import.meta.dirname, '..', '..')
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (...p: string[]): string => code(readFileSync(join(R, ...p), 'utf8'))

const engine = read('src', 'main', 'engine', 'Engine.ts')
const engineRespawn = engine.slice(engine.indexOf('async respawn('))
check('desktop respawn stamps respawnedAt', /respawnedAt: new Date\(\)\.toISOString\(\)/.test(engineRespawn.slice(0, 1500)))
check('desktop respawn requests the revision run now', /request\(\{ trigger: 'manual' \}\)/.test(engineRespawn.slice(0, 1800)))

const runOnce = read('src', 'core', 'runner', 'runOnce.ts')
check('change_plan auto-applies during the revision window', /respawnRevision = Boolean\(state!\.respawnedAt\)/.test(runOnce) && /\|\| respawnRevision\) && !loosens\)/.test(runOnce), 'without this, "roll the deadline forward" posts a pending card — the stall in card form')
check('the flag clears only when a run completes', /state\.respawnedAt && !error \? \{ respawnedAt: null \}/.test(runOnce), 'a failed attempt keeps the instructions for the retry')

check('the respawn note tells the operator what happens next', /bring my plan up to date/.test(LIFECYCLE.respawned) && /what I changed/.test(LIFECYCLE.respawned))

// -------------------------------------------------------- the date, and the past
//
// An agent respawned on a Monday evening whose clock line says only "9:17 PM ET
// (Mon)" cannot tell WHICH Monday it is, so it assumes the one its old plan was
// written on, rolls the mission to "tomorrow", and re-states a retirement
// deadline that is days in the past — which, if change_plan accepted it, the
// next tick would honour by retiring it: "Deadline reached".

const labourDay = new Date('2026-09-08T01:17:00Z') // Mon 2026-09-07 9:17 PM ET
const dated = respawnBlock({ respawnedAt: '2026-09-08T01:16:55Z' }, labourDay)
check('the respawn block states TODAY as a full date, not a weekday', /TODAY IS Mon 2026-09-07/.test(dated), dated.slice(0, 160))
check('and says every date in the old plan is older than that', /compute .* from TODAY's date/.test(dated))
check('and that a retirement deadline must be in the future', /MUST be in the future/.test(dated) && /change_plan refuses it/.test(dated))

const promptsSrc = read('src', 'core', 'runner', 'prompts.ts')
check('the CLOCK line carries the date on every run', /CLOCK: \$\{formatEt\(now\)\} on \$\{c\.weekday\} \$\{c\.date\}/.test(promptsSrc), 'the weekday alone cannot tell one Monday from the next')
check('so does the manual-run head (a respawn revision is a manual run)', /MANUAL RUN requested by the operator at \$\{formatEt\(new Date\(\)\)\} \(\$\{c\.weekday\} \$\{c\.date\}\)/.test(promptsSrc))

const changePlan = AGENT_TOOLS.find((t) => t.name === 'change_plan')
check('change_plan exists', Boolean(changePlan))
if (changePlan) {
  const calls: unknown[] = []
  const host = { changePlan: async (patch: unknown) => (calls.push(patch), 'applied') } as unknown as Parameters<typeof changePlan.run>[1]
  const past = await changePlan.run({ retirement: { at: '2026-09-01T16:05:00-04:00', flatten: true }, summary: 'roll to 9/1' }, host)
  check('change_plan REFUSES a retirement deadline already in the past', /Plan rejected/.test(past) && /PAST/.test(past) && calls.length === 0, past.slice(0, 140))
  check('and the refusal tells the model today\'s date', /Today is \w{3} \d{4}-\d{2}-\d{2}/.test(past))
  const garbage = await changePlan.run({ retirement: { at: 'tomorrow at close' }, summary: 'x' }, host)
  check('an unparseable deadline is refused, not stored', /Plan rejected/.test(garbage) && /not an ISO datetime/.test(garbage) && calls.length === 0)
  const future = await changePlan.run({ retirement: { at: '2999-01-01T16:05:00-04:00', flatten: true }, summary: 'far off' }, host)
  check('a future deadline still goes through to the host', future === 'applied' && calls.length === 1)
  const cleared = await changePlan.run({ retirement: { clear: true }, summary: 'no end' }, host)
  check('clearing the policy is never date-checked', cleared === 'applied' && calls.length === 2)
}

const sidebar = readFileSync(join(R, 'src', 'renderer', 'src', 'components', 'layout', 'Sidebar.tsx'), 'utf8')
check('the sidebar clears "Respawning…" when the agent leaves retired, not when the row unmounts', /stillRetired\.has\(id\)/.test(sidebar) && /\[retiredKey\]/.test(sidebar), 'the flag lives above the row: a re-retired agent remounted with the spinner still on')

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
