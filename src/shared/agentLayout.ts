import type { AgentColor } from './agents'

/**
 * How an operator arranges their agents: named GROUPS ("Aggressive",
 * "Long term"), which group each agent sits in, and a manual ORDER.
 *
 * One document, saved by main in `userData/layout.json` and read and written
 * by the sidebar. It is a LAYOUT, not agent state: it names agents by id and
 * never owns them, so a deleted agent simply drops out when `normalizeLayout`
 * next runs against the fleet.
 *
 * Every function here is pure and returns a NEW document. Writers save the
 * whole document (last writer wins — it is one person's arrangement, and a
 * lost drag costs a drag). Readers run everything through `normalizeLayout`
 * first: the file may have been written by an older build, or be missing.
 */

export const LAYOUT_VERSION = 1 as const
export const MAX_GROUPS = 20
export const MAX_GROUP_NAME = 24

export interface AgentGroup {
  id: string
  name: string
  /** Optional tint, from the same palette agents use. */
  color?: AgentColor
}

export interface AgentLayout {
  v: typeof LAYOUT_VERSION
  /** Display order of the group tabs / sections. */
  groups: AgentGroup[]
  /** Agent ids in display order. Agents missing here sort after, by the caller's default. */
  order: string[]
  /** agentId → groupId. Absent = ungrouped. */
  membership: Record<string, string>
}

export const EMPTY_LAYOUT: AgentLayout = { v: LAYOUT_VERSION, groups: [], order: [], membership: {} }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A short id that is unique enough for one account's handful of groups. */
export const newGroupId = (): string => `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/**
 * Whatever the column holds → a well-formed layout. Unknown shapes, wrong
 * types, duplicate ids and dangling memberships are dropped, never thrown on:
 * a corrupt layout must degrade to "default order, no groups", not to a list
 * screen that cannot render.
 */
export function normalizeLayout(raw: unknown): AgentLayout {
  if (!isRecord(raw)) return EMPTY_LAYOUT
  const groups: AgentGroup[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups) {
      if (!isRecord(g) || typeof g.id !== 'string' || typeof g.name !== 'string') continue
      const id = g.id.trim()
      const name = g.name.trim().slice(0, MAX_GROUP_NAME)
      if (!id || !name || seen.has(id)) continue
      seen.add(id)
      groups.push({ id, name, ...(typeof g.color === 'string' ? { color: g.color as AgentColor } : {}) })
      if (groups.length >= MAX_GROUPS) break
    }
  }
  const order: string[] = []
  const inOrder = new Set<string>()
  if (Array.isArray(raw.order)) {
    for (const id of raw.order) {
      if (typeof id !== 'string' || !id || inOrder.has(id)) continue
      inOrder.add(id)
      order.push(id)
    }
  }
  const membership: Record<string, string> = {}
  if (isRecord(raw.membership)) {
    for (const [agentId, groupId] of Object.entries(raw.membership)) {
      if (typeof groupId === 'string' && seen.has(groupId) && agentId) membership[agentId] = groupId
    }
  }
  return { v: LAYOUT_VERSION, groups, order, membership }
}

/** Drop agents the fleet no longer has, so a deleted agent leaves no trace. Returns the same object when nothing changed. */
export function pruneLayout(layout: AgentLayout, agentIds: ReadonlySet<string> | readonly string[]): AgentLayout {
  const ids = agentIds instanceof Set ? agentIds : new Set(agentIds)
  const order = layout.order.filter((id) => ids.has(id))
  const membership = Object.fromEntries(Object.entries(layout.membership).filter(([id]) => ids.has(id)))
  if (order.length === layout.order.length && Object.keys(membership).length === Object.keys(layout.membership).length) return layout
  return { ...layout, order, membership }
}

/**
 * The fleet in display order: the layout's order first, then everything the
 * layout has not placed, in the caller's default order (newest first on both
 * apps today). A layout never hides an agent.
 */
export function orderAgents<T extends { config: { id: string } }>(agents: readonly T[], layout: AgentLayout): T[] {
  const byId = new Map(agents.map((a) => [a.config.id, a]))
  const placed: T[] = []
  for (const id of layout.order) {
    const a = byId.get(id)
    if (a) {
      placed.push(a)
      byId.delete(id)
    }
  }
  return [...placed, ...agents.filter((a) => byId.has(a.config.id))]
}

export const groupOf = (layout: AgentLayout, agentId: string): AgentGroup | null => {
  const gid = layout.membership[agentId]
  return gid ? (layout.groups.find((g) => g.id === gid) ?? null) : null
}

/** Agents shown under one tab: a group's members, or (groupId null) every agent. */
export function agentsInGroup<T extends { config: { id: string } }>(agents: readonly T[], layout: AgentLayout, groupId: string | null): T[] {
  return groupId === null ? [...agents] : agents.filter((a) => layout.membership[a.config.id] === groupId)
}

/**
 * Move one agent so it lands at `toIndex` within `visible` — the list the
 * operator is actually looking at (a group tab, or everything). The full order
 * is rewritten around it: the visible agents keep their relative order except
 * for the moved one, and agents not on screen keep their places relative to
 * the ones that are.
 */
export function moveAgent(layout: AgentLayout, visible: readonly string[], agentId: string, toIndex: number): AgentLayout {
  if (!visible.includes(agentId)) return layout
  const rest = visible.filter((id) => id !== agentId)
  const at = Math.max(0, Math.min(rest.length, toIndex))
  const nextVisible = [...rest.slice(0, at), agentId, ...rest.slice(at)]
  // Splice the new visible sequence back into the full order: walk the full
  // order, and wherever a visible agent sat, emit the next one from the new
  // sequence instead. Visible agents the full order never placed are appended.
  const visibleSet = new Set(visible)
  const full = layout.order
  const queue = [...nextVisible]
  const order: string[] = []
  for (const id of full) {
    if (visibleSet.has(id)) {
      const next = queue.shift()
      if (next !== undefined) order.push(next)
    } else order.push(id)
  }
  order.push(...queue)
  return { ...layout, order }
}

export function createGroup(layout: AgentLayout, name: string, color?: AgentColor): { layout: AgentLayout; group: AgentGroup | null; error?: string } {
  const clean = name.trim().slice(0, MAX_GROUP_NAME)
  if (!clean) return { layout, group: null, error: 'Give the group a name.' }
  if (layout.groups.length >= MAX_GROUPS) return { layout, group: null, error: `Up to ${MAX_GROUPS} groups.` }
  if (layout.groups.some((g) => g.name.toLowerCase() === clean.toLowerCase())) return { layout, group: null, error: `There is already a group called “${clean}”.` }
  const group: AgentGroup = { id: newGroupId(), name: clean, ...(color ? { color } : {}) }
  return { layout: { ...layout, groups: [...layout.groups, group] }, group }
}

export function renameGroup(layout: AgentLayout, groupId: string, name: string, color?: AgentColor | null): AgentLayout {
  const clean = name.trim().slice(0, MAX_GROUP_NAME)
  if (!clean) return layout
  return {
    ...layout,
    groups: layout.groups.map((g) => (g.id === groupId ? { id: g.id, name: clean, ...(color === null ? {} : color ? { color } : g.color ? { color: g.color } : {}) } : g))
  }
}

/** Removing a group ungroups its members; nothing is deleted but the label. */
export function deleteGroup(layout: AgentLayout, groupId: string): AgentLayout {
  return {
    ...layout,
    groups: layout.groups.filter((g) => g.id !== groupId),
    membership: Object.fromEntries(Object.entries(layout.membership).filter(([, gid]) => gid !== groupId))
  }
}

export function moveGroup(layout: AgentLayout, groupId: string, toIndex: number): AgentLayout {
  const g = layout.groups.find((x) => x.id === groupId)
  if (!g) return layout
  const rest = layout.groups.filter((x) => x.id !== groupId)
  const at = Math.max(0, Math.min(rest.length, toIndex))
  return { ...layout, groups: [...rest.slice(0, at), g, ...rest.slice(at)] }
}

/** Put an agent in a group, or take it out (groupId null). Unknown groups are ignored. */
export function assignAgent(layout: AgentLayout, agentId: string, groupId: string | null): AgentLayout {
  const membership = { ...layout.membership }
  if (groupId === null) delete membership[agentId]
  else if (layout.groups.some((g) => g.id === groupId)) membership[agentId] = groupId
  else return layout
  return { ...layout, membership }
}

/** Members per group, for tab counts. */
export function groupCounts(layout: AgentLayout, agentIds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const g of layout.groups) out[g.id] = 0
  for (const id of agentIds) {
    const gid = layout.membership[id]
    if (gid && gid in out) out[gid]++
  }
  return out
}
