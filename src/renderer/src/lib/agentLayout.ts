import { assignAgent, moveAgent, type AgentLayout } from '@shared/agentLayout'

/**
 * The renderer's side of the agent layout (`shared/agentLayout.ts` is the
 * document; main keeps it in `userData/layout.json`).
 *
 * Pure. The store calls these; `scripts/checks/check-agent-layout-desktop.ts`
 * pins them.
 */

/** Which group sections are folded. A viewing preference, not part of the arrangement — kept in localStorage. */
export const COLLAPSED_GROUPS_KEY = 'tb:groups-collapsed'

export function readCollapsedGroups(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * One drop: the agent lands in `groupId` (null = ungrouped) at `toIndex` among
 * `sectionIds` — the ids the operator is looking at in that section, in
 * display order. Assignment first, then the order rewrite around the section's
 * visible sequence (`moveAgent` needs the agent in the visible list, so a
 * cross-section drop appends it before placing it).
 */
export function placeAgent(layout: AgentLayout, agentId: string, groupId: string | null, sectionIds: readonly string[], toIndex: number): AgentLayout {
  const assigned = assignAgent(layout, agentId, groupId)
  const visible = sectionIds.includes(agentId) ? sectionIds : [...sectionIds, agentId]
  return moveAgent(assigned, visible, agentId, toIndex)
}
