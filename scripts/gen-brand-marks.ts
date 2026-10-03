/**
 * Regenerate the brand-mark data from `assets/brands/*.svg`.
 *
 * The downloaded SVGs are the source of truth; `src/shared/brandMarks.ts` is
 * generated from them, so the provenance of each shape stays auditable — a path
 * string in a TypeScript file is a shape nobody can check.
 *
 * WHY DATA RATHER THAN FILES. A single 24x24 path plus a hex is a
 * representation any renderer can consume unchanged, and one shape serves
 * light and dark themes.
 *
 * Adding a brand: drop its SVG in `assets/brands/`, add its title and hex to
 * the tables below, re-run. Only single-path 24x24 marks are supported — the
 * script refuses anything else rather than silently emitting a broken shape.
 *
 * Run: `npm run gen:brand-marks`
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..')
const SRC = join(REPO, 'assets', 'brands')

/** The brand's own colour, without '#'. From Simple Icons' own data. */
const HEX: Record<string, string> = {
  claude: 'D97757',
  openrouter: '94A3B8',
  robinhood: 'CCFF00',
  // Not in Simple Icons any more — see the header of the generated file.
  openai: '000000'
}

const TITLE: Record<string, string> = {
  claude: 'Claude',
  openrouter: 'OpenRouter',
  robinhood: 'Robinhood',
  openai: 'OpenAI'
}

/** Emitted first, so the licensing is never more than one file away. */
const HEADER = `/**
 * Real brand marks, as path data. GENERATED — do not edit by hand.
 *
 * Source: \`assets/brands/*.svg\`.
 * Regenerate: \`npm run gen:brand-marks\`
 *
 * Every mark is 24x24, ONE path, and carries no fill — the caller decides the
 * colour, so one shape serves light and dark without a second asset.
 *
 * PROVENANCE. Paths come from Simple Icons (https://simple-icons.org), which
 * publishes them CC0.
 *
 * TRADEMARKS ARE NOT CC0. CC0 covers the drawing, never the right to use the
 * mark. These identify services an operator is genuinely connected to —
 * nominative use, the same basis as a "Sign in with…" button. So: never alter a
 * mark, never imply endorsement or partnership, never use one as the app's own
 * identity.
 *
 * ⚠️ OpenAI is NOT in Simple Icons any more. It was removed, and OpenAI
 * enforces its marks actively; this path came from the Iconify mirror of an
 * earlier release. The ChatGPT integration is reached through an unofficial
 * surface (the operator's own subscription) rather than as an API customer.
 * Treat it as the mark most likely to need removing.
 */`

interface Mark {
  d: string
  hex: string
  title: string
}

const marks: Record<string, Mark> = {}
for (const file of readdirSync(SRC).sort()) {
  if (!file.endsWith('.svg')) continue
  const slug = file.slice(0, -4)
  const svg = readFileSync(join(SRC, file), 'utf8')

  const paths = svg.match(/<path\b/g) ?? []
  if (paths.length !== 1) throw new Error(`${file}: expected exactly one <path>, found ${paths.length} — this pipeline only handles single-path marks`)
  const viewBox = /viewBox="0 0 24 24"/.test(svg)
  if (!viewBox) throw new Error(`${file}: expected viewBox="0 0 24 24"`)
  const d = /<path[^>]*\bd="([^"]+)"/.exec(svg)?.[1]
  if (!d) throw new Error(`${file}: no path data`)
  if (!HEX[slug] || !TITLE[slug]) throw new Error(`${file}: add "${slug}" to HEX and TITLE in this script`)

  marks[slug] = { d, hex: HEX[slug], title: TITLE[slug] }
}

const ORDER = ['claude', 'openai', 'openrouter', 'robinhood']
const slugs = [...ORDER.filter((s) => marks[s]), ...Object.keys(marks).filter((s) => !ORDER.includes(s))]

const union = slugs.map((s) => `'${s}'`).join(' | ')
const entries = slugs.map((s) => `  ${s}: {\n    d: '${marks[s].d}',\n    hex: '${marks[s].hex}',\n    title: '${marks[s].title}'\n  }`).join(',\n')
const out = `${HEADER}
export interface BrandMark {
  /** Single 24x24 path. */
  readonly d: string
  /** The brand's own colour, without the leading '#'. */
  readonly hex: string
  /** For \`aria-label\` / \`<title>\`, so the mark is not invisible to a screen reader. */
  readonly title: string
}

export type BrandSlug = ${union}

export const BRAND_MARKS: Record<BrandSlug, BrandMark> = {
${entries}
}

/** \`#RRGGBB\` for a slug — the brand's own colour. */
export const brandColor = (slug: BrandSlug): string => \`#\${BRAND_MARKS[slug].hex}\`
`

writeFileSync(join(REPO, 'src', 'shared', 'brandMarks.ts'), out)
console.log(`ok    src/shared/brandMarks.ts (${slugs.length} marks: ${slugs.join(', ')})`)
