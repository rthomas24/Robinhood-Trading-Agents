import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, X } from 'lucide-react'
import { AGENT_TEMPLATES, templateMatches, templatesByStyle, type AgentTemplate } from '@shared/templates'
import { describeSchedule } from '@shared/schedule'
import { PLAYBOOK_LABEL } from '@shared/earningsPlaybook'
import { AgentAvatar } from '@renderer/components/common/AgentAvatar'
import { cn } from '@renderer/lib/format'

/**
 * Every starter, with what it does. The New-agent strip shows a card's name
 * and tagline; this shows the whole catalog — the task sentence the agent is
 * given, the schedule it implies, that it asks first, and where the idea goes
 * wrong — so an operator can pick from twenty-five with their eyes open.
 * Picking one fills the sheet exactly as the strip does; nothing is created
 * here, and every field stays editable afterwards.
 *
 * Portalled to `document.body`: `.sheet-panel` carries a transform and would
 * otherwise be the containing block for `position: fixed`. Escape is caught
 * in the CAPTURE phase on window and stopped there, because the Sheet under
 * this listens for Escape on window too (bubble phase) and would close itself
 * along with the gallery.
 */
export function TemplateGallery({ selectedId, onPick, onClose }: { selectedId: string | null; onPick: (t: AgentTemplate) => void; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const groups = useMemo(
    () =>
      templatesByStyle()
        .map((g) => ({ ...g, templates: g.templates.filter((t) => templateMatches(t, query)) }))
        .filter((g) => g.templates.length > 0),
    [query]
  )
  const shown = groups.reduce((n, g) => n + g.templates.length, 0)
  return createPortal(
    <div className="no-drag fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8" role="dialog" aria-modal aria-label="All templates">
      <div className="sheet-backdrop absolute inset-0" onClick={onClose} />
      <div className="card-float relative flex flex-col w-full max-w-[940px] max-h-[88vh] overflow-hidden pop-in">
        <header className="flex items-center gap-3 pl-5 pr-3 h-[var(--h-header)] shrink-0 hair-b">
          <div className="min-w-0 flex-1">
            <h2 className="text-md font-semibold tracking-[-0.01em]">Templates</h2>
            <p className="hint truncate">{AGENT_TEMPLATES.length} starting points — what each does, when it runs, and where it goes wrong. Nothing is created until you press Create.</p>
          </div>
          <label className="relative shrink-0 hidden sm:block">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input className="input h-8 w-[220px] pl-8 text-sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates" aria-label="Search templates" autoFocus />
          </label>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {groups.length === 0 && <p className="text-sm text-muted py-6 text-center">Nothing matches “{query}”.</p>}
          {groups.map((g) => (
            <section key={g.style} className="mb-7 last:mb-0">
              <div className="mb-2.5">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-base font-semibold tracking-[-0.01em]">{g.label}</h3>
                  <span className="text-xs text-muted nums">{g.templates.length}</span>
                </div>
                <p className="hint mt-0.5">{g.hint}</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {g.templates.map((t) => (
                  <TemplateCard key={t.id} t={t} selected={t.id === selectedId} onPick={() => onPick(t)} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="px-5 py-2.5 hair-t shrink-0 flex items-center justify-between gap-3 text-xs text-muted">
          <span className="nums truncate">
            {shown} of {AGENT_TEMPLATES.length} shown · every template starts in paper and asks first · swap in your own tickers and sizes
          </span>
          <button className="btn btn-ghost btn-sm shrink-0" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}

/** One template, in full: the sentence, the schedule, the switch, the risk. */
function TemplateCard({ t, selected, onPick }: { t: AgentTemplate; selected: boolean; onPick: () => void }): JSX.Element {
  return (
    <article className={cn('card-quiet p-3.5 flex flex-col gap-2.5', selected && 'inset-ring-2 inset-ring-accent')} aria-current={selected || undefined}>
      <div className="flex items-center gap-2.5">
        <AgentAvatar icon={t.icon} color={t.color} size={28} active={selected} />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">{t.name}</div>
          <div className="text-xs text-muted truncate" title={t.tagline}>
            {t.tagline}
          </div>
        </div>
        <button type="button" className={cn('btn btn-sm shrink-0', selected ? 'btn-accent' : 'btn-outline')} onClick={onPick}>
          {selected ? 'Selected' : 'Use this'}
        </button>
      </div>
      <div>
        <div className="label">What it does</div>
        <p className="text-sm leading-relaxed">{t.task}</p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="nums">{describeSchedule(t.schedule)}</span>
        {t.playbook && <span className="text-accent">{PLAYBOOK_LABEL[t.playbook]} mode — the engine owns size, timing and exits</span>}
        <span>{t.autonomous ? 'Acts on its own' : 'Asks first'}</span>
        <span>Paper</span>
      </div>
      <div>
        <div className="label">Where it goes wrong</div>
        <p className="text-xs text-muted leading-relaxed">{t.risk}</p>
      </div>
    </article>
  )
}
