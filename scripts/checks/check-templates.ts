/**
 * Every starter template is one the engine would accept and the sheet can show.
 *
 * `AGENT_TEMPLATES` fills the New-agent sheet and the onboarding step, so a
 * template with a schedule `validateSchedule` refuses, an icon the avatar
 * cannot draw, or a task that trades while claiming to ask first would be the
 * first thing a new operator meets. Also pins the three rules the catalog
 * makes: every template is worded as an illustration (the sheet's hint carries
 * the disclaimer, so here: every task names ET times or no time at all), EVERY
 * template is ask-first (a starter that trades on its own the moment it is
 * clicked is the wrong first experience), and no template names a dollar size
 * (sizing belongs to the receiver's allocation and guardrails, not to a
 * sentence written for everyone).
 *
 * Run: `npm run check -- templates`
 */
import { AGENT_COLORS, AGENT_ICONS } from '@shared/agents'
import { validateSchedule } from '@shared/schedule'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_TEMPLATES, TEMPLATE_STYLE_HINT, TEMPLATE_STYLE_LABEL, templateById, templateMatches, templatesByStyle } from '@shared/templates'
import { MAX_AGENT_NAME } from '@shared/createAgent'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

check('the catalog is twenty-six strong (2026-09-29: + Earnings All-In)', AGENT_TEMPLATES.length === 26, String(AGENT_TEMPLATES.length))
check('the all-in earnings template carries its mode, and no other template has one', templateById('earnings-all-in')?.playbook === 'earningsPop' && AGENT_TEMPLATES.filter((t) => t.playbook).length === 1)
check('a mode template still asks first', templateById('earnings-all-in')?.autonomous === false)
check('the onboarding’s three starters still exist by id', ['weekly-dca', 'overnight-hold', 'morning-brief'].every((id) => templateById(id) !== undefined))
check('every style has at least four templates', templatesByStyle().every((g) => g.templates.length >= 4), templatesByStyle().map((g) => `${g.style}:${g.templates.length}`).join(' '))
check('taglines stay one line', AGENT_TEMPLATES.every((t) => t.tagline.length <= 96), AGENT_TEMPLATES.filter((t) => t.tagline.length > 96).map((t) => t.id).join(','))
check('names are unique', new Set(AGENT_TEMPLATES.map((t) => t.name)).size === AGENT_TEMPLATES.length)
check('ids are unique', new Set(AGENT_TEMPLATES.map((t) => t.id)).size === AGENT_TEMPLATES.length)
check('names fit the sidebar', AGENT_TEMPLATES.every((t) => t.name.trim().length > 0 && t.name.length <= MAX_AGENT_NAME))
check('every icon and colour is one the avatar can draw', AGENT_TEMPLATES.every((t) => (AGENT_ICONS as readonly string[]).includes(t.icon) && (AGENT_COLORS as readonly string[]).includes(t.color)))
for (const t of AGENT_TEMPLATES) {
  const problem = validateSchedule(t.schedule)
  check(`${t.id}: schedule is one the engine accepts`, problem === null, problem ?? '')
  check(`${t.id}: task, tagline and risk note are all present`, t.task.trim().length > 20 && t.tagline.trim().length > 0 && t.risk.trim().length > 0)
  check(`${t.id}: times in the task are stated in ET`, !/\b\d{1,2}:\d{2}\s*(AM|PM)\b(?!\s*ET)/.test(t.task), t.task)
  check(`${t.id}: no schedule is a one-off`, t.schedule.kind !== 'once')
  check(`${t.id}: every template asks first`, t.autonomous === false)
  const dollar = /\$\s?\d|\b\d[\d,]*(\.\d+)?\s?(dollars|USD|bucks)\b/i
  check(`${t.id}: no dollar size anywhere in the template`, ![t.task, t.tagline, t.risk, t.name].some((s) => dollar.test(s)), [t.task, t.tagline, t.risk].find((s) => dollar.test(s)) ?? '')
}
check('the catalog is ask-first without exception', AGENT_TEMPLATES.every((t) => !t.autonomous))
check('every style has a label and a hint', AGENT_TEMPLATES.every((t) => TEMPLATE_STYLE_LABEL[t.style].length > 0 && TEMPLATE_STYLE_HINT[t.style].length > 0))
check('search matches name, tagline, task, risk and style — and everything on an empty query', templateMatches(templateById('macro-watch')!, 'cpi') && templateMatches(templateById('dip-ladder')!, 'investing') && !templateMatches(templateById('dip-ladder')!, 'zzzz') && AGENT_TEMPLATES.every((t) => templateMatches(t, '  ')))
const R = join(import.meta.dirname, '..', '..')
const read = (p: string): string => readFileSync(join(R, p), 'utf8').replace(/\r\n/g, '\n')
const sheet = read('src/renderer/src/components/sheets/NewAgentSheet.tsx')
const gallery = read('src/renderer/src/components/sheets/TemplateGallery.tsx')
check('the sheet offers the whole catalog behind a button', /Browse all \{AGENT_TEMPLATES\.length\}/.test(sheet) && /<TemplateGallery/.test(sheet))
check('picking in the gallery fills the sheet the same way the strip does, then closes', /onPick=\{\(t\) => \{\s*applyTemplate\(t\)\s*setGalleryOpen\(false\)/.test(sheet))
check('the gallery is portalled to body (a sheet panel is a transform container)', /createPortal\(/.test(gallery) && /document\.body/.test(gallery))
check('…and catches Escape in the capture phase so the sheet under it stays open', /addEventListener\('keydown', onKey, true\)/.test(gallery) && /e\.stopPropagation\(\)/.test(gallery))
check('the gallery shows the task, the schedule, ask-first and the risk for every card', /What it does/.test(gallery) && /describeSchedule\(t\.schedule\)/.test(gallery) && /Asks first/.test(gallery) && /Where it goes wrong/.test(gallery))
check('picking a mode template carries the mode, and Create sends it', /setPlaybook\(t\.playbook\)/.test(sheet) && /playbook, schedule: earningsPopSchedule\(\), planNow: false/.test(sheet))
check('templateById finds and misses', templateById('overnight-hold')?.name === 'MU Overnight' && templateById('nope') === undefined)
const groups = templatesByStyle()
check('grouping keeps every template once, in catalog order', groups.flatMap((g) => g.templates).length === AGENT_TEMPLATES.length && groups[0].templates[0].id === AGENT_TEMPLATES[0].id)

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
