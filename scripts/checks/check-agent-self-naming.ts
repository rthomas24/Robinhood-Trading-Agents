/**
 * An agent the operator did not name, names itself — once.
 *
 * The whole feature is one grant and its expiry, so the checks are mostly about
 * the ways that grant can leak:
 *
 *   IT MUST BE A FLAG, NOT A NAME COMPARISON. The obvious implementation is
 *   `if (cfg.name === 'New agent')`, and it is wrong: "New agent" is a name an
 *   operator may legitimately type, and it would then be silently overwritten
 *   by the agent on its first run. `nameAuto` is set only where the create
 *   form's name was empty, so it records the OPERATOR'S INTENT rather than
 *   guessing it back out of the result.
 *
 *   IT MUST BE ONE-SHOT. `set_name` clears the flag, so an agent cannot rename
 *   itself run after run — which would make the sidebar unstable and, worse,
 *   would let an agent walk away from a name the operator had come to know it
 *   by.
 *
 *   AN OPERATOR'S NAME IS FINAL. With no flag the tool refuses. That refusal is
 *   the reason the tool is safe to expose at all.
 *
 * The prompt half matters as much as the tool: an unnamed agent that is never
 * TOLD to name itself keeps the placeholder forever, and the block is
 * `mandatory` precisely because a budgeter dropping it would spend the agent's
 * only opportunity in silence.
 *
 * Run: `npm run check -- agent-self-naming`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFromCreateRequest, suggestName, PLACEHOLDER_AGENT_NAME, MAX_AGENT_NAME } from '@shared/createAgent'
import { defaultModelFor } from '@shared/agents'
import { namingBlock } from '@core/runner/prompts'
import { AGENT_TOOLS } from '@core/runner/agentTools'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const MODEL = defaultModelFor('openrouter')
const req = (over: Record<string, unknown> = {}) =>
  ({
    name: '',
    icon: 'cube',
    color: 'blue',
    task: 'Buy the MU dip and sell it next morning',
    mode: 'paper',
    allocationUsd: 500,
    ...over
  }) as Parameters<typeof configFromCreateRequest>[0]

// ------------------------------------------------------------- the grant

const unnamed = configFromCreateRequest(req(), MODEL)
check('a blank name sets nameAuto', unnamed.nameAuto === true)
check('…and still gets a usable interim name', unnamed.name.length > 0 && unnamed.name !== '', unnamed.name)
check('…derived from the task, not the placeholder', unnamed.name === 'MU Overnight', unnamed.name)

const noTicker = configFromCreateRequest(req({ task: 'Watch the market and tell me things' }), MODEL)
check('a task with no ticker falls back to the placeholder', noTicker.name === PLACEHOLDER_AGENT_NAME, noTicker.name)
check('…and is still flagged for self-naming', noTicker.nameAuto === true)

const named = configFromCreateRequest(req({ name: 'My Scalper' }), MODEL)
check('an operator-supplied name is kept', named.name === 'My Scalper')
check('…and is NOT flagged', named.nameAuto === undefined, String(named.nameAuto))

// The trap this whole design exists to avoid.
const literal = configFromCreateRequest(req({ name: PLACEHOLDER_AGENT_NAME }), MODEL)
check(
  `an operator who literally types "${PLACEHOLDER_AGENT_NAME}" is NOT flagged`,
  literal.nameAuto === undefined,
  'a name comparison would have silently overwritten their choice'
)

// -------------------------------------------------------------- the tool

const tool = AGENT_TOOLS.find((t) => t.name === 'set_name')
check('set_name is a registered agent tool', Boolean(tool))
check('…and says it is first-run only', /first run/i.test(tool?.description ?? ''), tool?.description?.slice(0, 60))
check('…and warns against generic names', /trading bot|generic/i.test(tool?.description ?? ''))

const runOnce = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8')

// Scoped to the function BODY rather than a character window. The first version
// asserted `setName[\s\S]{0,900}saveConfig` and went red purely because the
// explanatory comment above the call grew past 900 chars — a check that fails
// when documentation is added is measuring the wrong thing.
const bodyStart = runOnce.indexOf('async setName(name)')
const setNameBody = bodyStart < 0 ? '' : runOnce.slice(bodyStart, runOnce.indexOf('\n    },', bodyStart))
check('setName exists on the host', setNameBody.length > 0)
check('the host refuses when the operator named it', /if \(!cfg\.nameAuto\) return/.test(setNameBody), 'without this the tool renames an operator-named agent')
check('…and DELETES the flag rather than setting it false', /delete cfg\.nameAuto/.test(setNameBody), 'one spelling for "not ours to touch", not two')
check('…and persists the config', /saveConfig\(cfg\)/.test(setNameBody))
check('…and records it in the thread', /namedItself/.test(setNameBody))
check('the name is NOT derived by comparing against the placeholder', !/cfg\.name === PLACEHOLDER_AGENT_NAME/.test(runOnce))

// ------------------------------------------------------------ the prompt

const block = namingBlock({ task: 'Scalp AMZN every 15 minutes', name: PLACEHOLDER_AGENT_NAME })
check('the naming block names the tool', /mcp__tb__set_name/.test(block))
check('…quotes the actual task', block.includes('Scalp AMZN every 15 minutes'))
check('…states the length limit', block.includes(String(MAX_AGENT_NAME)))
check('…and says what a BAD name is', /Trading Bot|Agent 1/.test(block), 'the failure mode is ten agents all called the same thing')

const prompts = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'prompts.ts'), 'utf8')
check('the block renders ONLY while the flag is set', /cfg\.nameAuto \? namingBlock\(cfg\) : ''/.test(prompts), 'otherwise it nags an already-named agent every run')
check('…and is MANDATORY, not cuttable', /b\('naming', 'mandatory'/.test(prompts), 'a budgeter dropping it spends the one opportunity in silence')

// ------------------------------------------------------- the create form

for (const [label, path] of [
  ['desktop', join(import.meta.dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'sheets', 'NewAgentSheet.tsx')]
] as const) {
  let form = ''
  try {
    form = readFileSync(path, 'utf8')
  } catch {
    check(`${label} create form is readable`, false, path)
    continue
  }
  check(`${label} sends the name RAW`, /name: name\.trim\(\),/.test(form), 'a client-side fallback here silently spends the grant before the agent ever sees it')
  check(`${label} has no private copy of suggestName`, !/^function suggestName/m.test(form), 'one rule, in src/shared')
}

check('suggestName respects word boundaries', suggestName('Track AMAZON closely') !== 'AMAZO Agent', `got ${JSON.stringify(suggestName('Track AMAZON closely'))}`)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
