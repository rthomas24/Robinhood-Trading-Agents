import { app } from 'electron'
import { join } from 'node:path'
import type { LayoutWriteResult } from '@shared/ipc'
import { EMPTY_LAYOUT, normalizeLayout, type AgentLayout } from '@shared/agentLayout'
import { readJson, writeJson } from './json'

/**
 * The sidebar arrangement — groups, membership, manual order
 * (`shared/agentLayout.ts`) — as ONE document in `userData/layout.json`.
 * Whole-document writes, last writer wins: it is one person's arrangement and
 * a lost drag costs a drag. Normalized on the way in AND out, so a renderer bug
 * cannot store a shape the next launch would then drop.
 */
function path(): string {
  return join(app.getPath('userData'), 'layout.json')
}

export const layoutStore = {
  load(): AgentLayout {
    const raw = readJson<unknown>(path())
    return raw ? normalizeLayout(raw) : EMPTY_LAYOUT
  },
  save(raw: unknown): LayoutWriteResult {
    try {
      writeJson(path(), normalizeLayout(raw))
      return { ok: true }
    } catch (err) {
      return { ok: false, detail: `Could not save the arrangement (${(err as Error).message}).` }
    }
  }
}
