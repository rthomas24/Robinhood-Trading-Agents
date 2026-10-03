import { themeById, type ThemeId } from '@shared/themes'

/**
 * Apply a catalog theme: tokens become inline CSS variables on <html> (they
 * win over the @theme defaults and the [data-theme='dark'] block in index.css),
 * `data-theme` carries the scheme (color-scheme, native controls), and
 * `data-theme-id` the id. Returns the id actually applied (unknown → default).
 *
 * ⚠️ These writes are INLINE, so they outrank every ordinary stylesheet rule
 * for the same token. `up`, `down` and `warn` are among them, which is why the
 * `:root[data-calm='1']` block in index.css has to mark its two drain lines
 * `!important` — without the flag the theme's own up/down simply won and calm
 * mode silently did nothing to the P&L colour. Any future rule that needs to
 * override a `ThemeTokens` key has the same problem.
 */
export function applyTheme(id: string | null | undefined): ThemeId {
  const t = themeById(id)
  const root = document.documentElement
  root.dataset.theme = t.scheme
  root.dataset.themeId = t.id
  for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty(`--color-${k}`, v)
  return t.id
}

/**
 * Calm mode: `data-calm="1"` on <html>, which index.css reads to drain the P&L
 * colours to the muted text colour.
 *
 * It lives on the ROOT rather than in a React context because the drain is a
 * token swap, not a prop — every `.money-up`, every tint and every sparkline
 * stroke follows it without a single component knowing it exists. And because
 * it only rewrites `--color-up`/`--color-down`, nothing that carries a SAFETY
 * meaning can be quietened by it: armed pennants, the account halt and every
 * destructive control are drawn from `--color-armed`, warnings from
 * `--color-warn`, and calm mode names neither.
 */
export function applyCalm(on: boolean): void {
  const root = document.documentElement
  if (on) root.dataset.calm = '1'
  else delete root.dataset.calm
}
