/**
 * A newly created agent speaks first — whichever way it was created.
 *
 * A LIVE agent made from a template (schedule set by hand, so no plan run)
 * used to post "Agent created · LIVE." and nothing else. Its first wake-up
 * could be the next morning's open, hours away, and nothing told the operator
 * it was unarmed. The AI-plan path never had this problem
 * because a `plan` run fires at creation.
 *
 * The contract:
 *   1. `introBlock` renders on an agent's FIRST run only — never after a run has
 *      landed, never for a retired agent, never on the `plan` run (which has
 *      its own setup head);
 *   2. it asks for an introduction, the finish line the task names (computed
 *      from TODAY), and — for a live, unarmed agent — a plain sentence that no
 *      real order goes out until the operator arms it;
 *   3. create requests an immediate `manual` run when there is no plan run,
 *      and posts the live-unarmed note for a live create.
 *
 * Run: `npm run check -- first-run-intro`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { introBlock } from '../../src/core/runner/prompts'
import { LIFECYCLE } from '../../src/shared/lifecycle'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const fresh = { lastRunAt: null, runCount: 0, status: 'idle' as const }
const paperCfg = { mode: 'paper' as const, liveArmedAt: null, schedule: { kind: 'interval' as const, everyMinutes: 10, marketHoursOnly: true } }
const liveCfg = { ...paperCfg, mode: 'live' as const }

const paper = introBlock(paperCfg, fresh, 'manual')
check('first manual run → the block renders', /THIS IS YOUR FIRST RUN/.test(paper))
check('it asks for an introduction and names the closed-market case', /INTRODUCE YOURSELF/.test(paper) && /market is closed/.test(paper))
check('it asks for the finish line, computed from today, in the future', /SET YOUR FINISH LINE/.test(paper) && /TODAY/.test(paper) && /must be in the future/.test(paper))
check('a paper agent is told it is paper', /PAPER — simulated fills/.test(paper) && !/NOT ARMED/.test(paper))

const live = introBlock(liveCfg, fresh, 'manual')
check('a live, unarmed agent is told to say it cannot place orders yet', /LIVE BUT NOT ARMED/.test(live) && /arms live trading/.test(live))
const armed = introBlock({ ...liveCfg, liveArmedAt: '2026-09-08T00:00:00Z' }, fresh, 'schedule')
check('a live, armed agent confirms real orders instead', /LIVE and armed/.test(armed) && !/NOT ARMED/.test(armed))

check('never after a run has landed', introBlock(paperCfg, { ...fresh, lastRunAt: '2026-09-08T13:30:00Z', runCount: 1 }, 'manual') === '')
check('never once runCount says a run happened, even without lastRunAt', introBlock(paperCfg, { ...fresh, runCount: 1 }, 'manual') === '')
check('never for a retired agent', introBlock(paperCfg, { ...fresh, status: 'retired' }, 'manual') === '')
check('never on the plan run — that head does its own setup', introBlock(paperCfg, fresh, 'plan') === '')

const R = join(import.meta.dirname, '..', '..')
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const engine = code(readFileSync(join(R, 'src', 'main', 'engine', 'Engine.ts'), 'utf8'))
const create = engine.slice(engine.indexOf('async create(cfg: AgentConfig, planNow: boolean)'), engine.indexOf('async update(id: string'))
check('desktop create requests a manual run when there is no plan run', /r\.arm\(\)[\s\S]{0,200}r\.request\(\{ trigger: 'manual' \}\)/.test(create))
check('create posts the live-unarmed note for a live create', (create.match(/LIFECYCLE\.createdLiveUnarmed/g) ?? []).length === 1)
check('the note says what it cannot do and where to fix it', /not armed/.test(LIFECYCLE.createdLiveUnarmed) && /Agent settings/.test(LIFECYCLE.createdLiveUnarmed))

const prompts = code(readFileSync(join(R, 'src', 'core', 'runner', 'prompts.ts'), 'utf8'))
check('the block is mounted in the run prompt, after the respawn block', /b\('respawn'[^\n]*\n\s*b\('intro', 'mandatory', '\\n', retired \? '' : introBlock\(cfg, state, trigger\)\)/.test(prompts))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
