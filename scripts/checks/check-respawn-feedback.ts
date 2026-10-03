/**
 * Clicking Respawn must LOOK like something happened.
 *
 * A respawn is a multi-write round trip (config write, state transition, the
 * revision run's enqueue) and the row/header only changes when the store flips
 * — it can take seconds. A bare ghost icon gives no sign the click landed, so
 * the operator clicks again and reads the pause as breakage. The contract: every respawn button shows a spinner and disables
 * while in flight, reverts on failure (with the reason, where the sidebar row
 * has space for it), and never clears early on success — the row's own
 * unmount/status flip is the true completion signal, and clearing on resolve
 * flashes "Respawn" on a row that is about to disappear.
 *
 * Plus one rule this change tripped over, pinned so it stays fixed: the
 * ThreadView respawn hooks live ABOVE the `!agent` early return. Hooks after a
 * conditional return render conditionally — the one thing hooks must never do,
 * and invisible until an agent row appears or vanishes mid-session.
 *
 * Run: `npm run check -- respawn-feedback`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const R = join(import.meta.dirname, '..', '..', 'src', 'renderer', 'src', 'components')
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const sidebar = code(readFileSync(join(R, 'layout', 'Sidebar.tsx'), 'utf8'))
const thread = code(readFileSync(join(R, 'thread', 'ThreadView.tsx'), 'utf8'))

// ------------------------------------------------------------------- sidebar

check('sidebar respawn is a labelled button, not a ghost icon', /className="btn btn-(?:accent|outline)[^"]*"\s*\n?\s*title=\{respawnBlocked \?\? "Respawn/.test(sidebar) && /\{busy \? "Respawning…" : "Respawn"\}/.test(sidebar))
check('sidebar spins while the round trip runs', /Loader2/.test(sidebar) && /animate-spin/.test(sidebar) && /"Respawning…"/.test(sidebar))
check('sidebar disables the button while busy', /disabled=\{Boolean\(respawnBlocked\) \|\| busy\}/.test(sidebar))
check('sidebar reverts WITH the reason on failure', /\.catch\(\(error: Error\)/.test(sidebar) && /err: error\.message/.test(sidebar), 'a silent revert reads as the same dead click')
check('sidebar shows the failure where the subtitle is', /err \?\? \(busy \? "Bringing it back…"/.test(sidebar))
check('sidebar does not clear busy on resolve', !/\.then\([^)]*setRespawn/.test(sidebar), 'success is the row unmounting, not the promise resolving')

// ---------------------------------------------------------------- threadview

check('thread respawn spins and disables in both places', (thread.match(/disabled=\{respawning\}/g) ?? []).length === 2 && (thread.match(/Respawning…/g) ?? []).length >= 2, 'header button AND the composer read-only action')
check('thread reverts on failure only', /\.catch\(\(\) => setRespawning\(false\)\)/.test(thread) && !/\.then\([^)]*setRespawning/.test(thread))
check('thread resets when the agent actually leaves retired', /if \(!isRetired\) setRespawning\(false\)/.test(thread))

const hooksAt = thread.indexOf('const [respawning, setRespawning] = useState(false)')
const earlyReturnAt = thread.indexOf('if (!agent) return')
check('thread respawn hooks sit ABOVE the !agent early return', hooksAt !== -1 && earlyReturnAt !== -1 && hooksAt < earlyReturnAt, 'hooks after a conditional return render conditionally — React forbids it')

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
