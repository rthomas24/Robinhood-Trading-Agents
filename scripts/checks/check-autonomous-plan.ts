/**
 * The Acting switch decides who applies a plan change (2026-09-11).
 *
 * An "On its own" agent applies its own `change_plan` — schedule, task,
 * limits, a WIDENING included — with an `important` thread note carrying the
 * money the new limits mean and a `plan.widened` decision row. An "Ask me
 * first" agent keeps the card: operator-requested and first-setup changes
 * apply, an invented one posts pending, and a widening always waits for the
 * tap (typed `widen` past 10% daily loss / 25% per order). Before this an
 * autonomous agent that widened its own fence stalled on the typed word on
 * top of "On its own", and the operator asked why they were being asked.
 *
 * Pinned here: the host rule in `runOnce`, the prompt sentences on both sides
 * of the switch, the sheet copy that describes it, the decision-log rule, and
 * that the card never asks for the word on an applied plan.
 *
 * Run: `npm run check -- autonomous-plan`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, isAutonomous, type AgentConfig } from '@shared/agents'
import { RULE_LABEL } from '@shared/decisionSummary'
import { composeSystemPrompt, respawnBlock } from '@core/runner/prompts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const src = (p: string): string => readFileSync(resolve(import.meta.dirname, '../../', p), 'utf8')

const base = {
  id: 'ag',
  name: 'T',
  mode: 'paper',
  allocationUsd: 10_000,
  guardrails: { ...DEFAULT_GUARDRAILS },
  liveArmedAt: null,
  retirement: null,
  task: 'Trade MU dips',
  createdAt: 'x',
  updatedAt: 'x',
  schedule: { kind: 'manual' },
  model: { vendor: 'openrouter', id: 'x' }
} as unknown as AgentConfig
const auto: AgentConfig = { ...base }
const ask: AgentConfig = { ...base, autonomous: false }
check('absent autonomous = on its own; false = ask first', isAutonomous(auto) && !isAutonomous(ask))

console.log('— the host rule —')
const runOnce = src('src/core/runner/runOnce.ts')
check('an autonomous agent applies every change_plan, widening included', /const selfApplies = isAutonomous\(cfg\)\s*\n\s*const autoApply = selfApplies \|\| \(\(req\.trigger === 'reply' \|\| req\.trigger === 'plan' \|\| respawnRevision\) && !loosens\)/.test(runOnce))
check('an ask-first agent still cannot widen without the tap (the && !loosens fence survives)', /\|\| respawnRevision\) && !loosens\)/.test(runOnce))
check('a self-applied widening posts an IMPORTANT note with the risk sentence', /notify: 'important', text: `Plan updated by the agent — limits widened: \$\{widened\}\. \$\{riskSummary\(next\.guardrails, next\.allocationUsd\)\}`/.test(runOnce))
check('and lands in the decision log as plan.widened', /rule: 'plan\.widened', detail: short\(widened, 200\)/.test(runOnce))
check('the model is told its limits are wider and to say why', /Your limits are WIDER now \(\$\{widened\}\) and the operator has been notified — say plainly in your reply why you widened them/.test(runOnce))
check('the ask-first refusal names the setting', /this agent is set to ask first, so only they can do that/.test(runOnce))
check('first setup never counts as a widening (no fence yet)', /const loosens = req\.trigger !== 'plan' && loosensGuardrails\(diff\)/.test(runOnce))
check('RULE_LABEL has a phrase for plan.widened', RULE_LABEL['plan.widened'] === 'the agent widening its own limits')

console.log('\n— the prompt says which side of the switch this agent is on —')
const sysAuto = composeSystemPrompt(auto)
const sysAsk = composeSystemPrompt(ask)
check('autonomous: change_plan applies at once, limits included, widening = alert', /it applies at once, limits included; a change that WIDENS your limits is posted to the operator as an alert/.test(sysAuto))
check('autonomous: no "posts a card for them to tap"', !/that posts a card for them to tap/.test(sysAuto))
check('ask first: a widening posts a card for the tap', /EXCEPT for anything that widens your limits: that posts a card for them to tap/.test(sysAsk))
check('ask first: not told it applies limits on its own', !/limits included/.test(sysAsk))
const respawnAuto = respawnBlock({ respawnedAt: '2026-09-10T13:00:00Z' }, new Date(), true)
const respawnAsk = respawnBlock({ respawnedAt: '2026-09-10T13:00:00Z' }, new Date(), false)
check('respawn block (autonomous): limits included, widening alerts', /limits included — a change that would WIDEN your limits is posted to the operator as an alert/.test(respawnAuto))
check("respawn block (ask first): a widening waits for the operator's tap", /which still wait for the operator's tap/.test(respawnAsk))
const prompts = src('src/core/runner/prompts.ts')
check('the run prompt passes the switch into respawnBlock', /respawnBlock\(state, new Date\(\), isAutonomous\(cfg\)\)/.test(prompts))
check('the self-review line branches on the switch too', /call change_plan \(\$\{isAutonomous\(cfg\) \? 'it applies at once — widening your limits alerts the operator, so say why' : 'it will post as a pending card for the operator to approve'\}\)/.test(prompts))
const tools = src('src/core/runner/agentTools.ts')
check('the tool description defers to the Acting setting rather than promising a card', /depends on this agent\\'s Acting setting/.test(tools) && /an agent that acts on its own applies it and the operator is alerted; an agent that asks first always waits for their tap/.test(tools))

console.log('\n— the card and the sheets —')
const card = src('src/renderer/src/components/thread/MessageItem.tsx')
check('the typed word is only ever asked on a PENDING card', /const mustType = pending && widens/.test(card))
const settings = src('src/renderer/src/components/sheets/AgentSettingsSheet.tsx')
check('Agent settings: "On its own" says it adjusts its own plan and guardrails, with an alert on a widening', /adjusts its own plan and guardrails without asking — you get an alert in the thread when it widens a limit/.test(settings))
check('Agent settings: "Ask me first" says a widening waits for the tap', /A plan change that widens its limits waits for your tap too/.test(settings))
const create = src('src/renderer/src/components/sheets/NewAgentSheet.tsx')
check('New agent: both hints say the same', /can adjust its own plan and guardrails — you get an alert when it widens a limit/.test(create) && /retirement and limit-widening waits in the thread/.test(create))

// The sheet's own typed-word gate is the OPERATOR widening the fence by hand,
// which is a different act from the agent doing it; it stays.
check('the settings sheet still asks the operator for the word when THEY widen past the line', /needsTypedConfirm\(guardrailsNow, alloc\)/.test(settings))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
