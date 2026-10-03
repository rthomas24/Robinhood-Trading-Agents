import { defaultGuardrailsFor, entryDefaultsFor, newId, type AgentConfig, type ModelChoice } from './agents'
import type { CreateAgentRequest } from './ipc'
import { earningsPopGuardrails, earningsPopSchedule } from './earningsPlaybook'

/**
 * Shown while an unnamed agent has not yet run. Deliberately dull: it should
 * read as "not named yet" rather than as a name somebody chose, and it is the
 * string the sidebar renders for the few seconds or minutes before the first
 * run replaces it.
 */
export const PLACEHOLDER_AGENT_NAME = 'New agent'

/** Max length the agent may give itself — a sidebar row, not a sentence. */
export const MAX_AGENT_NAME = 32


/**
 * A first-guess name from the task, used ONLY as the interim label while an
 * unnamed agent waits for its first run.
 *
 * Deliberately a weak heuristic — it finds a ticker and a trading style and
 * gives up otherwise. That is the point: it exists so the sidebar is not full
 * of rows called "New agent" for the minutes before the agent runs, not to be
 * the final answer. The agent replaces it with something informed by the whole
 * task, which is why this one is allowed to be crude. Applied where the config
 * is built rather than in each form.
 */
export function suggestName(task: string): string {
  const sym = /\$?\b([A-Z]{2,5})\b/.exec(task)?.[1]
  if (!sym) return ''
  if (/sell.*(next|morning|open)/i.test(task) || /overnight/i.test(task)) return `${sym} Overnight`
  if (/scalp|every \d+ ?min/i.test(task)) return `${sym} Scalper`
  return `${sym} Agent`
}

/**
 * A `CreateAgentRequest` → the `AgentConfig` the engine stores. One place for
 * the defaults (name fallback, guardrails merge, manual schedule, no retirement,
 * not armed).
 */
export function configFromCreateRequest(req: CreateAgentRequest, defaultModel: ModelChoice, now = new Date().toISOString()): AgentConfig {
  const model = req.model ?? defaultModel
  // An operator who left the name blank gets a placeholder AND a flag: the
  // agent names itself on its first run (`set_name`), from the task it was
  // actually given. The flag is what makes that safe — see `AgentConfig.nameAuto`.
  const named = req.name.trim()
  const task = req.task.trim()
  // A playbook OWNS its cycle: the schedule and the fence are the mode's, laid
  // over whatever the form carried, because the engine's gate, exits and sizing
  // are written against exactly these times.
  const earningsPop = req.playbook === 'earningsPop'
  const schedule = earningsPop ? earningsPopSchedule() : (req.schedule ?? { kind: 'manual' as const })
  return {
    id: newId('ag_'),
    // Operator's name wins outright. Otherwise an interim label from the task —
    // so the sidebar reads sensibly immediately — plus the flag that lets the
    // agent replace it with something better on its first run.
    name: named || suggestName(task) || PLACEHOLDER_AGENT_NAME,
    ...(named ? {} : { nameAuto: true as const }),
    icon: req.icon,
    color: req.color,
    task: req.task.trim(),
    schedule,
    // Entry discipline defaults for NEW agents only;
    // the opening window also lands later, from `applyPlanToConfig`, when the
    // setup run picks an interval schedule.
    guardrails: { ...defaultGuardrailsFor(req.allocationUsd), ...entryDefaultsFor(schedule), ...(req.guardrails ?? {}), ...(earningsPop ? earningsPopGuardrails(req.allocationUsd) : {}) },
    ...(earningsPop ? { playbook: 'earningsPop' as const } : {}),
    mode: req.mode,
    model,
    allocationUsd: req.allocationUsd,
    retirement: req.retirement ?? null,
    // Explicit either way: the field being absent means "made before this
    // existed and therefore autonomous", which is not what a new agent means.
    autonomous: req.autonomous !== false,
    liveArmedAt: null,
    createdAt: now,
    updatedAt: now
  }
}
