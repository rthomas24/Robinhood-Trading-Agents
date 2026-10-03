/**
 * The desktop's side of the agent layout (`src/renderer/src/lib/agentLayout.ts`
 * + the store + `main/store/layoutStore.ts`), pinned where it is pure.
 *
 *   1. `placeAgent` — a drop is assign + place in one document, and the index
 *      means "among the ids the operator is looking at", whether the row came
 *      from that section or another.
 *   2. Main stores ONE normalized document in `userData/layout.json` and
 *      reports a failed write instead of swallowing it.
 *   3. The renderer prunes at render and before a write, never on a prune
 *      alone; collapsed state never enters the stored document.
 *
 * Run: `npm run check -- agent-layout-desktop`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGroup, EMPTY_LAYOUT, orderAgents, type AgentLayout } from '@shared/agentLayout'
import { placeAgent } from '../../src/renderer/src/lib/agentLayout'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------- placeAgent

const agents = ['a1', 'a2', 'a3', 'a4'].map((id) => ({ config: { id } }))
let lay = createGroup(EMPTY_LAYOUT, 'Swing').layout
const gid = lay.groups[0].id
lay = { ...lay, order: ['a1', 'a2', 'a3', 'a4'] }
// Ungrouped section shows a1..a4; drop a4 between a1 and a2 (index 1).
let next = placeAgent(lay, 'a4', null, ['a1', 'a2', 'a3', 'a4'], 1)
check('reorder within a section lands at the index (caller shifts for a from-above source)', next.order.join() === 'a1,a4,a2,a3', next.order.join())
check('reorder within a section leaves membership alone', Object.keys(next.membership).length === 0)
// Cross-section: a2 into the (empty) group at index 0.
next = placeAgent(lay, 'a2', gid, [], 0)
check('drop into an empty group assigns it', next.membership.a2 === gid)
check('…and keeps the full order intact', next.order.join() === 'a1,a2,a3,a4', next.order.join())
// Now a3 into the group AFTER a2 (the group shows [a2]; index 1 = end).
const withA2 = next
next = placeAgent(withA2, 'a3', gid, ['a2'], 1)
check('drop after the last member assigns and orders after it', next.membership.a3 === gid && next.order.indexOf('a2') < next.order.indexOf('a3'))
// a1 into the group BEFORE a2 (index 0).
next = placeAgent(withA2, 'a1', gid, ['a2'], 0)
check('drop before the first member orders before it', next.membership.a1 === gid && next.order.indexOf('a1') < next.order.indexOf('a2'))
const shown = orderAgents(agents.filter((a) => next.membership[a.config.id] === gid), next).map((a) => a.config.id)
check('what the group section then shows is [a1, a2]', shown.join() === 'a1,a2', shown.join())
check('an unknown group is a no-op (assignAgent ignores it), order untouched', placeAgent(lay, 'a1', 'g_nope', ['a1'], 0).membership.a1 === undefined)

// ------------------------------------------------------------------- wiring

const R = join(import.meta.dirname, '..', '..', 'src')
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const store = code(readFileSync(join(R, 'renderer', 'src', 'store', 'appStore.ts'), 'utf8'))
const sidebar = code(readFileSync(join(R, 'renderer', 'src', 'components', 'layout', 'Sidebar.tsx'), 'utf8'))
const lib = code(readFileSync(join(R, 'renderer', 'src', 'lib', 'agentLayout.ts'), 'utf8'))
const fileStore = code(readFileSync(join(R, 'main', 'store', 'layoutStore.ts'), 'utf8'))

check('main normalizes the document on the way in and out', /normalizeLayout\(raw\)/.test(fileStore) && (fileStore.match(/normalizeLayout\(/g) ?? []).length >= 2)
check('main writes atomically and reports a failed write', /writeJson\(path\(\), normalizeLayout\(raw\)\)/.test(fileStore) && /return \{ ok: false, detail:/.test(fileStore))
check('store loads the layout from main at boot', /window\.tb\.layout\.get\(\)/.test(store))
check('store writes through main', /window\.tb\.layout\.set\(layout\)/.test(store))
check('store prunes before every write', /const layout = pruneLayout\(next, ids\)/.test(store))
check('store reverts on a refused write, with the reason', /set\(\{ layout: prev, layoutError: r\.detail/.test(store))
check('store never writes on prune alone', !/pruneLayout[^\n]*\n[^\n]*setLayout/.test(store))
check('collapsed groups live in localStorage, not the document', /COLLAPSED_GROUPS_KEY/.test(lib) && /localStorage\.setItem\(COLLAPSED_GROUPS_KEY/.test(store) && !/collapsed/i.test(readFileSync(join(R, 'shared', 'agentLayout.ts'), 'utf8')))
check('sidebar prunes at render', /pruneLayout\(storedLayout, Object\.keys\(agents\)\)/.test(sidebar))
check('sidebar reorders around the section it shows', /moveAgentTo\(id, ids, to\)/.test(sidebar) && /placeAgentAt\(id, sec\.groupId, ids, index\)/.test(sidebar))
check('sidebar row menu offers Move up / Move down / Move to group', /label: "Move up"/.test(sidebar) && /label: "Move down"/.test(sidebar) && /label: "Move to group"/.test(sidebar))
check('retired rows are not draggable', !/retired\.map\([\s\S]*?draggable/.test(sidebar.slice(sidebar.indexOf('retired.map('))))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
