/**
 * One ceiling, one rule, every call site.
 *
 * `MAX_ACTIVE_AGENTS` bounds what one desktop is asked to supervise: a timer
 * per agent, the 15-second price watcher, possibly a local model process.
 * Retired agents do not count. `agentSlotBlocked` is the shared rule and
 * `agentCapacity` the same rule phrased for the runner's `propose_agent` tool,
 * so the IPC gate, the New-agent sheet, the sidebar's respawn button and the
 * agent itself can never disagree about whether there is room.
 *
 * Run: `npm run check -- agent-ceilings`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentCapacity, agentCapMessage, agentSlotBlocked, countActiveAgents, MAX_ACTIVE_AGENTS } from '@shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const active = { state: { status: 'scheduled' } }
const retired = { state: { status: 'retired' } }

// ------------------------------------------------------------- the count
check('active agents count', countActiveAgents([active, active]) === 2)
check('retired agents do not', countActiveAgents([active, retired, retired]) === 1)

// ------------------------------------------------------------- the rule
check('room below the ceiling', agentSlotBlocked(MAX_ACTIVE_AGENTS - 1) === null)
check('refused at the ceiling', agentSlotBlocked(MAX_ACTIVE_AGENTS) !== null)
check('…with the shared sentence', agentSlotBlocked(MAX_ACTIVE_AGENTS) === agentCapMessage(MAX_ACTIVE_AGENTS))
check('…which names this computer and the limit', /this computer/i.test(agentCapMessage(10)) && agentCapMessage(10).includes(String(MAX_ACTIVE_AGENTS)))
check('…and offers the way out', /retire or delete/i.test(agentCapMessage(10)))
check('…and says nothing about a cloud or a plan', !/cloud|plan/i.test(agentCapMessage(10)))

const ok = agentCapacity(0)
const full = agentCapacity(MAX_ACTIVE_AGENTS)
check('agentCapacity agrees with agentSlotBlocked (room)', ok.ok === true && ok.max === MAX_ACTIVE_AGENTS)
check('agentCapacity agrees with agentSlotBlocked (full)', full.ok === false && Boolean(full.reason))

// ------------------------------------------------------------- the gates
// Comments stripped before matching: an explanatory comment must not satisfy
// (or fail) a source assertion.
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const src = (...p: string[]): string => code(readFileSync(join(import.meta.dirname, '..', '..', ...p), 'utf8'))

const register = src('src', 'main', 'ipc', 'register.ts')
check('the IPC gate uses the shared rule', /agentSlotBlocked\(countActiveAgents\(/.test(register))
const sidebar = src('src', 'renderer', 'src', 'components', 'layout', 'Sidebar.tsx')
check('the sidebar respawn button uses the shared rule', /agentSlotBlocked\(activeCount\)/.test(sidebar))
const sheet = src('src', 'renderer', 'src', 'components', 'sheets', 'NewAgentSheet.tsx')
check('the New-agent sheet uses the shared rule', /agentSlotBlocked\(activeCount\)/.test(sheet))
const engine = src('src', 'main', 'engine', 'Engine.ts')
check('propose_agent capacity uses the shared rule', /agentCapacity\(countActiveAgents\(/.test(engine))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
