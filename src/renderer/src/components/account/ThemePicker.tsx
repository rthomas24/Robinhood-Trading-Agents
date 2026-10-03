import type { JSX } from 'react'
import { Check } from 'lucide-react'
import { THEMES, type Theme, type ThemeId } from '@shared/themes'
import { cn } from '@renderer/lib/format'

/**
 * The two palettes the system was designed against. They lead each column so
 * the first thing an operator sees is the app as it was drawn, not the
 * alphabetically-first port of someone's editor theme.
 */
const FLAGSHIP: ThemeId[] = ['light', 'dark']

/**
 * A miniature of the app painted in the theme's OWN tokens — canvas, rail, a
 * surface card with text on it, the accent, and the money pair. Every colour
 * here is an inline style on purpose: this is the one place in the app that
 * must render a palette that is not the active one, so it cannot go through the
 * CSS variables (rule 5's exception, and the only one).
 */
function Swatch({ t }: { t: Theme }): JSX.Element {
  const k = t.tokens
  return (
    <div className="h-[68px] rounded-md overflow-hidden flex" style={{ background: k.bg, boxShadow: `inset 0 0 0 1px ${k.border}` }} aria-hidden>
      <div className="w-[30%] h-full p-1.5 flex flex-col gap-1" style={{ background: k.rail }}>
        <span className="h-1.5 rounded-full" style={{ background: k.accent, width: '82%' }} />
        <span className="h-1.5 rounded-full" style={{ background: k['surface-3'], width: '94%' }} />
        <span className="h-1.5 rounded-full" style={{ background: k['surface-3'], width: '68%' }} />
      </div>
      <div className="flex-1 p-1.5 flex flex-col gap-1.5 min-w-0">
        <div className="rounded-sm p-1.5 flex flex-col gap-1" style={{ background: k.surface, boxShadow: `inset 0 0 0 1px ${k.border}` }}>
          <span className="h-1 rounded-full" style={{ background: k.text, opacity: 0.75, width: '72%' }} />
          <span className="h-1 rounded-full" style={{ background: k.muted, width: '46%' }} />
        </div>
        <div className="mt-auto flex items-center gap-1">
          <span className="h-1.5 flex-1 rounded-full" style={{ background: k.up }} />
          <span className="h-1.5 flex-1 rounded-full" style={{ background: k.down }} />
          <span className="h-1.5 w-2 rounded-full" style={{ background: k.warn }} />
        </div>
      </div>
    </div>
  )
}

/** Theme gallery: every catalogue theme as a clickable preview, light then dark. */
export function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (id: ThemeId) => void }): JSX.Element {
  const inScheme = (scheme: Theme['scheme']): Theme[] => {
    const items = THEMES.filter((t) => t.scheme === scheme)
    const rank = (t: Theme): number => (FLAGSHIP.includes(t.id) ? 0 : 1)
    return [...items].sort((a, b) => rank(a) - rank(b))
  }
  const groups: { label: string; items: Theme[] }[] = [
    { label: 'Light', items: inScheme('light') },
    { label: 'Dark', items: inScheme('dark') }
  ]
  return (
    <div className="space-y-5" role="radiogroup" aria-label="Theme">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="eyebrow mb-2">{g.label}</div>
          <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {g.items.map((t) => {
              const on = t.id === value
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange(t.id)}
                  className={cn('text-left rounded-lg p-1.5 transition-shadow', on ? 'ring-2 ring-accent' : 'ring-1 ring-hairline hover:ring-hairline-strong')}
                  title={t.name}
                >
                  <Swatch t={t} />
                  <div className="flex items-center gap-1.5 mt-1.5 px-0.5">
                    <span className={cn('text-sm truncate flex-1', on ? 'font-medium' : 'text-muted')}>{t.name}</span>
                    {on && <Check size={12} className="text-accent shrink-0" />}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
