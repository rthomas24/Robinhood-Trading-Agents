/**
 * Every full-screen overlay must reclaim its own pixels from the drag region.
 *
 * The window has no native title bar (`titleBarStyle: 'hidden'`), so the top of
 * the app is made draggable with `-webkit-app-region: drag` — the thread header
 * (`drag h-14`), the account header, the sidebar's spacers.
 *
 * Electron hands those regions to the OS as plain RECTANGLES, and that
 * hit-testing IS NOT Z-INDEX AWARE. An overlay painted on top does not reclaim
 * the pixels underneath: the OS still owns them, and a click there drags the
 * window instead of reaching the element the user can plainly see. Any
 * interactive element that lands in the top ~56px of the window is dead unless
 * something in its ancestry says `no-drag`.
 *
 * That is what happened to `Sheet`: its header is `h-14`, so it sat exactly
 * inside the thread header's drag band, and the close button did nothing on
 * ALL FOUR sheets. Nothing threw, nothing logged, the button kept its hover
 * state — it looked completely alive. The backdrop's top 56px were swallowed
 * the same way, so the usual escape hatch of "click outside" was also dead in
 * the one strip nearest the button.
 *
 * The rule is easy to restate and easy to forget, which is why it is a check
 * and not a comment: an overlay that covers the window covers a drag region,
 * and covering is not claiming.
 *
 * Run: `npm run check -- overlay-clickable`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const RENDERER = join(import.meta.dirname, '..', '..', 'src', 'renderer', 'src')

const walk = (dir: string): string[] => {
  let out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out = out.concat(walk(p))
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** A `className` string containing both `fixed` and `inset-0` — a full-window layer. */
const OVERLAY = /className=\{?["'`]([^"'`]*\bfixed\b[^"'`]*\binset-0\b[^"'`]*)["'`]/g

const offenders: string[] = []
let overlays = 0

for (const file of walk(RENDERER)) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(OVERLAY)) {
    const classes = m[1]
    // An `absolute inset-0` backdrop INSIDE an overlay inherits from it; only
    // the `fixed` layer that establishes the overlay has to declare it.
    overlays++
    if (/\bno-drag\b/.test(classes)) continue
    const line = src.slice(0, m.index).split('\n').length
    offenders.push(`${relative(join(import.meta.dirname, '..', '..'), file).replace(/\\/g, '/')}:${line} — "${classes.trim()}"`)
  }
}

check(`found ${overlays} full-screen overlay(s) to inspect`, overlays > 0, 'zero means the pattern stopped matching, not that the app has no modals')
check(
  'every full-screen overlay carries no-drag',
  offenders.length === 0,
  offenders.length ? `${offenders.join(' | ')} — the top ~56px of these is a drag region; clicks there reach the OS, not the app` : ''
)

// The specific regression, named, because this one shipped.
const sheet = readFileSync(join(RENDERER, 'components', 'common', 'Sheet.tsx'), 'utf8')
check('Sheet reclaims its pixels', /no-drag[^"'`]*fixed[^"'`]*inset-0/.test(sheet), 'without this the X does nothing on every sheet in the app')
check('…and the close button is still wired to onClose', /onClick=\{onClose\}[\s\S]{0,120}aria-label="Close"/.test(sheet) || /aria-label="Close"[\s\S]{0,120}onClick=\{onClose\}/.test(sheet))
check('…and Escape still closes', /e\.key === 'Escape'\) onClose\(\)/.test(sheet), 'the keyboard path was the only one that worked before the fix')
check('…and the backdrop still closes', /absolute inset-0[^>]*onClick=\{onClose\}/.test(sheet))

// The detector has to be able to see a bad one, or it is decoration.
const planted = 'className="fixed inset-0 z-40 flex justify-end"'
const seen = [...planted.matchAll(OVERLAY)]
check('the detector flags an overlay without no-drag', seen.length === 1 && !/no-drag/.test(seen[0][1]))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
