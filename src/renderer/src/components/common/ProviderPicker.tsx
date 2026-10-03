import type { CSSProperties, JSX, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Cpu, KeyRound, LogIn, Settings2 } from 'lucide-react'
import { PROVIDERS, PROVIDER_HINT, PROVIDER_LABEL, type Provider } from '@shared/provider'
import { useApp } from '@renderer/store/appStore'
import { cn } from '@renderer/lib/format'
import { localDefaultModelId } from '@renderer/lib/vendor'
import { BrandMark } from '@renderer/components/common/BrandMark'

/**
 * The one picker for *which service thinks for an agent*: a dropdown with each
 * service's logo, name and a readiness line. Used in the status bar (default
 * for new agents), New agent, Agent settings (move this agent, mid-run is fine)
 * and Preferences. Readiness: green dot = the service can run an agent now.
 * Locked rows can't be chosen and offer a jump to what's missing: Claude and
 * ChatGPT need their account signed in, OpenRouter needs an API key, Local GPU
 * needs a default model picked in Settings → Local models. (Being merely
 * *offline* never locks a service — those agents wait for the connection and
 * pick up; only a missing account/key/model does.)
 */

/* ───────────────────────────── logos ───────────────────────────── */

/*
 * The hand-drawn approximations that used to live here are gone. They were an
 * eight-ray asterisk for Claude and six rotated rounded rects for ChatGPT —
 * close enough to read as the real marks at 12px and wrong at any size a person
 * would actually look at. `BrandMark` draws the real paths from
 * `shared/brandMarks.ts`, so every surface draws the same shape.
 */

/**
 * Third-party BRAND colours, and the only hexes in the renderer.
 *
 * Design rule 5 forbids a hard-coded hex in a component because every colour
 * the app owns must derive from the theme's 18 seeds. A brand mark is the one
 * thing the app does not own: Anthropic's terracotta and ChatGPT's green belong
 * to those companies and are the same colour in all 18 themes, so they cannot
 * be `color-mix`ed out of a palette and are therefore exempt. They live here,
 * named once, rather than being spelt out at each use — and every tint derived
 * from them is a `color-mix` on the constant, so the hue exists in exactly one
 * place per brand.
 */
const BRAND = {
  /** Anthropic's terracotta — reads on both light and dark surfaces. */
  claude: '#D97757',
  /**
   * ChatGPT's older green. OpenAI's current brand colour is BLACK, which is
   * invisible on a dark surface, so the tile keeps the familiar tint and the
   * mark inherits it: the shape is authentic, the colour is ours rather than a
   * recolouring of their mark.
   */
  chatgpt: '#10A37F'
} as const

/** The tinted plate a brand mark sits on: the brand hue at 14 %, mixed not guessed. */
const brandTint = (hex: string): string => `color-mix(in srgb, ${hex} 14%, transparent)`

/** Logo tile: a soft tinted square with the service's mark. */
export function ProviderLogo({ provider, size = 28, className }: { provider: Provider; size?: number; className?: string }): JSX.Element {
  const inner = Math.round(size * 0.62)
  const tile: Record<Provider, { bg: string; fg: string; mark: JSX.Element }> = {
    claude: { bg: brandTint(BRAND.claude), fg: BRAND.claude, mark: <BrandMark slug="claude" size={inner} brand label={null} /> },
    chatgpt: { bg: brandTint(BRAND.chatgpt), fg: BRAND.chatgpt, mark: <BrandMark slug="openai" size={inner} label={null} /> },
    openrouter: { bg: 'var(--tint-accent)', fg: 'var(--color-accent)', mark: <BrandMark slug="openrouter" size={inner} label={null} /> },
    local: { bg: 'var(--tint-local)', fg: 'var(--color-local)', mark: <Cpu size={inner} strokeWidth={2.1} /> }
  }
  const t = tile[provider]
  return (
    <span className={cn('inline-flex items-center justify-center shrink-0', className)} style={{ width: size, height: size, borderRadius: Math.max(6, size * 0.3), background: t.bg, color: t.fg }} aria-hidden>
      {t.mark}
    </span>
  )
}

/** Bare glyph (no tile) for dense places like the sidebar row. */
export function providerIcon(p: Provider, size = 12): JSX.Element {
  switch (p) {
    case 'claude':
      return <BrandMark slug="claude" size={size} label={null} />
    case 'chatgpt':
      return <BrandMark slug="openai" size={size} label={null} />
    case 'openrouter':
      return <BrandMark slug="openrouter" size={size} label={null} />
    case 'local':
      return <Cpu size={size} />
  }
}

/* ───────────────────────────── readiness ───────────────────────────── */

export interface ProviderReadiness {
  /** The service can run an agent right now. */
  ready: boolean
  /** Can't be chosen: not signed in, no API key, or setup that hasn't been done (Local GPU: no default model). */
  locked: false | 'signin' | 'key' | 'setup'
  /** One line for the menu: "Your Claude account (max)", "Not signed in", "Key saved"… */
  detail: string
}

export function useProviderReadiness(): Record<Provider, ProviderReadiness> {
  const claude = useApp((s) => s.claude)
  const chatgpt = useApp((s) => s.chatgpt)
  const openrouter = useApp((s) => s.openrouter)
  const local = useApp((s) => s.local)
  const settings = useApp((s) => s.settings)
  const online = useApp((s) => s.online)
  const off = online ? '' : ' · offline'
  // Local GPU needs a default model: the operator's pick in Settings → Local
  // models (and, once the folder has been scanned, that file must still be
  // there). ONE answer, shared with the Local models page and its enable
  // toggle — see localDefaultModelId.
  const localModelId = localDefaultModelId(settings, local)
  const localModel = localModelId ? (local?.models.length ? local.models.find((m) => m.id === localModelId) : { id: localModelId, name: localModelId }) : undefined
  return {
    claude: {
      ready: Boolean(claude?.authenticated) && online,
      locked: claude?.authenticated ? false : 'signin',
      detail: claude?.authenticated ? `Your Claude account${claude.subscriptionType ? ` (${claude.subscriptionType})` : ''}${off}` : 'Not signed in'
    },
    chatgpt: {
      ready: Boolean(chatgpt?.authenticated) && online,
      locked: chatgpt?.authenticated ? false : 'signin',
      detail: chatgpt?.authenticated ? `Your ChatGPT subscription${chatgpt.subscriptionType ? ` (${chatgpt.subscriptionType.replace(/^ChatGPT\s*/, '')})` : ''}${off}` : 'Not signed in'
    },
    openrouter: {
      ready: Boolean(openrouter?.hasKey) && !openrouter?.error && online,
      locked: openrouter?.hasKey ? false : 'key',
      detail: !openrouter?.hasKey ? 'No API key yet' : openrouter.error ? 'Key failed its last test' : `Your API key${openrouter.label ? ` (${openrouter.label})` : ''}${off}`
    },
    local: {
      ready: Boolean(localModel),
      locked: localModel ? false : 'setup',
      detail: local?.active ? `${local.active.modelName} running` : localModel ? `${localModel.name} · starts on first run` : localModelId ? 'Default model is gone from the folder — pick another' : 'Pick a default model first (Local models)'
    }
  }
}

/* ───────────────────────────── badge ───────────────────────────── */

/** Sidebar / header badge: which service thinks for this agent. */
export function ProviderBadge({ provider, className, title }: { provider: Provider; className?: string; title?: string }): JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-1', className)} title={title === '' ? undefined : (title ?? PROVIDER_HINT[provider])}>
      {providerIcon(provider, 11)}
      <span>{PROVIDER_LABEL[provider]}</span>
    </span>
  )
}

/* ─────────────────────────── the menu surface ─────────────────────────── */

/**
 * The floating surface both pickers open (rule 1: above the page means a
 * stacked shadow and an inset ring, never a border — `.card-float`).
 *
 * Portalled to <body> and positioned from viewport coordinates, which is
 * load-bearing rather than tidy: the sheet panel carries a `transform` (its
 * slide-in rests at translateX(0)), and a transformed ancestor becomes the
 * containing block for `position: fixed` — so a menu placed inside the sheet
 * would land far to the right of the panel, clipped by its scroller, and read
 * as "nothing happened" on click.
 *
 * It lives beside the provider picker because these two pickers are the only
 * things that open it, and one copy of the placement/dismissal rules is one
 * place for them to be wrong.
 *
 * It is a real listbox from the keyboard. Both pickers replaced a native
 * `<select>`, and a portalled menu that nothing focuses is a control that
 * cannot be operated at all without a mouse — which for the model picker meant
 * the model could not be chosen. The surface itself takes focus on open and
 * names the active row with `aria-activedescendant`; ↑/↓/Home/End move it,
 * Enter or Space chooses it (by clicking the row, so there is one
 * implementation of "choose"), Escape closes and hands focus back to the
 * trigger.
 */
export function AnchoredMenu({
  open,
  anchor,
  onClose,
  width,
  estHeight,
  label,
  children
}: {
  open: boolean
  anchor: RefObject<HTMLElement | null>
  onClose: () => void
  width: number
  /** Used only to decide whether the menu flips above its trigger. */
  estHeight: number
  label: string
  children: ReactNode
}): JSX.Element | null {
  const [pos, setPos] = useState<CSSProperties>({})
  const menuRef = useRef<HTMLDivElement>(null)
  const baseId = useId()
  /** Index into the rows in DOM order; -1 while the menu has no active row. */
  const [active, setActive] = useState(-1)
  /**
   * Set just before a click OUTSIDE closes the menu. Closing by Escape or by
   * choosing a row hands focus back to the trigger; closing because the
   * operator clicked something else must not yank it away from what they
   * clicked.
   */
  const clickedAway = useRef(false)

  const rowsOf = useCallback((): HTMLElement[] => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[data-menurow]') ?? []), [])
  const enabled = (el: HTMLElement | undefined): boolean => Boolean(el) && el?.getAttribute('aria-disabled') !== 'true'

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      const up = window.innerHeight - r.bottom < estHeight && r.top > estHeight
      setPos(up ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 })
    }
    place()
    const onAway = (e: MouseEvent): void => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || anchor.current?.contains(t)) return
      clickedAway.current = true
      onClose()
    }
    // Kept as a window listener for the case where focus has left the menu
    // (a nested "Sign in" button, say); the surface's own handler answers
    // Escape first and stops it there, so a menu open over a sheet closes the
    // menu alone.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onAway)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('mousedown', onAway)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, onClose, width, estHeight])

  // Open on the row that is already the value — the operator's own answer is
  // where a listbox should start — otherwise on the first one they could pick.
  useLayoutEffect(() => {
    if (!open) {
      setActive(-1)
      return
    }
    clickedAway.current = false
    const rows = rowsOf()
    const selected = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true' && enabled(r))
    setActive(selected >= 0 ? selected : rows.findIndex((r) => enabled(r)))
    menuRef.current?.focus()
    return () => {
      if (!clickedAway.current) anchor.current?.focus?.()
    }
  }, [open, anchor, rowsOf])

  // A row cannot know its own place in the list, and `aria-activedescendant`
  // has to name one — so the ids are stamped here, after every render, along
  // with the attribute the active row is drawn from.
  useLayoutEffect(() => {
    if (!open) return
    rowsOf().forEach((el, i) => {
      el.id = `${baseId}-o${i}`
      if (i === active) el.setAttribute('data-active', 'true')
      else el.removeAttribute('data-active')
    })
  })

  useLayoutEffect(() => {
    if (open && active >= 0) rowsOf()[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active, rowsOf])

  /** Walk to the next row that can be chosen, wrapping; disabled rows are skipped. */
  const move = (step: number, from = active): void => {
    const rows = rowsOf()
    const n = rows.length
    if (!n) return
    for (let i = 1; i <= n; i++) {
      const at = (((from + step * i) % n) + n) % n
      if (enabled(rows[at])) {
        setActive(at)
        return
      }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      // A menu open over a sheet must not close the sheet as well.
      e.stopPropagation()
      onClose()
      return
    }
    // Anything focusable INSIDE a row (the "Sign in" / "Add key" button)
    // keeps its own keys.
    if (e.target !== e.currentTarget) return
    if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'Home') move(1, -1)
    else if (e.key === 'End') move(-1, 0)
    else if (e.key === 'Enter' || e.key === ' ') {
      const el = rowsOf()[active]
      if (!enabled(el)) return
      // Click the row rather than reaching for its handler: choosing is
      // implemented once, in MenuRow's onClick.
      el?.click()
    } else return
    e.preventDefault()
  }

  if (!open) return null
  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      aria-label={label}
      tabIndex={-1}
      aria-activedescendant={active >= 0 ? `${baseId}-o${active}` : undefined}
      className="no-drag fixed z-50 card-float p-1.5 pop-in outline-none"
      style={{ ...pos, width, transformOrigin: 'bottom' in pos ? 'bottom left' : 'top left' }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body
  )
}

/**
 * One row of either picker: mark, name, a single line of description, and the
 * state on the right (chosen · ready · what is missing).
 */
export function MenuRow({
  mark,
  title,
  detail,
  selected,
  disabled,
  right,
  titleTone,
  onSelect,
  hint
}: {
  mark?: ReactNode
  title: ReactNode
  detail?: string
  selected?: boolean
  disabled?: boolean
  right?: ReactNode
  titleTone?: 'muted'
  onSelect: () => void
  hint?: string
}): JSX.Element {
  return (
    <div
      data-menurow
      role="option"
      aria-selected={Boolean(selected)}
      aria-disabled={disabled || undefined}
      // The LISTBOX holds focus and names the active row with
      // `aria-activedescendant` (see AnchoredMenu), so a row is never a tab
      // stop and never handles a key itself — `data-active` is the keyboard's
      // highlight and is stamped by the menu.
      onClick={() => {
        if (disabled) return
        onSelect()
      }}
      className={cn(
        'w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-surface-2 data-[active=true]:bg-surface-2',
        selected && 'bg-accent/8'
      )}
    >
      {mark}
      <div className="flex-1 min-w-0">
        <div className={cn('flex items-center gap-1.5 text-base font-medium', titleTone === 'muted' ? 'text-muted' : 'text-text')}>{title}</div>
        {detail !== undefined && (
          <div className="text-xs text-muted truncate" title={hint ? `${detail} — ${hint}` : detail}>
            {detail}
          </div>
        )}
      </div>
      {right}
    </div>
  )
}

/** The dot that says "this service could run an agent right now". */
export function ReadyDot({ ready, title }: { ready: boolean; title?: string }): JSX.Element {
  return <span className={cn('dot shrink-0', ready ? 'bg-up' : 'bg-muted/40')} title={title} />
}

/* ───────────────────────────── dropdown ───────────────────────────── */

const MENU_W = 300
const MENU_H_EST = 4 * 56 + 16

export function ProviderPicker({
  value,
  onChange,
  compact,
  disabled
}: {
  value: Provider
  onChange: (p: Provider) => void
  /** Status-bar variant: small trigger. */
  compact?: boolean
  disabled?: boolean
}): JSX.Element {
  const ready = useProviderReadiness()
  const options = PROVIDERS
  const openAccount = useApp((s) => s.openAccount)
  const openSheet = useApp((s) => s.openSheet)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const FIX_LABEL: Record<'signin' | 'key' | 'setup', string> = { signin: 'Sign in', key: 'Add key', setup: 'Set up' }

  /** Take the operator to whatever the locked row is missing. */
  const fix = (p: Provider): void => {
    setOpen(false)
    if (p === 'local') openAccount('local')
    else openSheet({ kind: 'connections' })
  }

  const cur = ready[value]
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${PROVIDER_LABEL[value]} — ${cur.detail}`}
        className={cn(
          'inline-flex items-center rounded-md bg-surface hover:bg-surface-2 transition-colors select-none disabled:opacity-60 ring-1 ring-hairline-strong',
          // The compact trigger lives in the 28px status bar, so it has to stay
          // under that height with room to breathe.
          compact ? 'h-6 pl-0.5 pr-1.5 gap-1.5 text-xs' : 'h-9 pl-1.5 pr-2.5 gap-2 text-base',
          open && 'bg-surface-2'
        )}
      >
        <ProviderLogo provider={value} size={compact ? 20 : 24} />
        <span className={cn('font-medium text-text', value === 'local' && 'text-local')}>{PROVIDER_LABEL[value]}</span>
        <ReadyDot ready={cur.ready} />
        <ChevronDown size={compact ? 11 : 13} className={cn('text-muted transition-transform duration-[var(--dur-fast)]', open && 'rotate-180')} />
      </button>

      <AnchoredMenu open={open} anchor={triggerRef} onClose={close} width={MENU_W} estHeight={MENU_H_EST} label="Runs on">
        {options.map((p) => {
          const r = ready[p]
          const selected = p === value
          // A locked row that is ALREADY the value stays as-is (nothing to change); it just can't be chosen elsewhere.
          const locked = r.locked !== false && !selected
          return (
            <MenuRow
              key={p}
              mark={<ProviderLogo provider={p} size={30} className={cn(locked && 'opacity-50 grayscale')} />}
              title={
                <>
                  {PROVIDER_LABEL[p]}
                  {r.locked === 'signin' && <LogIn size={11} className="text-muted" />}
                  {r.locked === 'key' && <KeyRound size={11} className="text-muted" />}
                  {r.locked === 'setup' && <Settings2 size={11} className="text-muted" />}
                </>
              }
              titleTone={locked ? 'muted' : undefined}
              detail={r.detail}
              hint={PROVIDER_HINT[p]}
              selected={selected}
              disabled={locked}
              onSelect={() => {
                onChange(p)
                setOpen(false)
              }}
              right={
                r.locked !== false ? (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm shrink-0"
                    onClick={(e) => {
                      e.stopPropagation()
                      fix(p)
                    }}
                  >
                    {FIX_LABEL[r.locked]}
                  </button>
                ) : selected ? (
                  <Check size={15} className="text-accent shrink-0" />
                ) : (
                  <ReadyDot ready={r.ready} title={r.ready ? 'Ready' : 'Not ready — you can still pick it; the agent explains in its thread'} />
                )
              }
            />
          )
        })}
        <p className="px-2 pt-2 pb-1 text-2xs text-muted leading-relaxed">{PROVIDER_HINT[value]}</p>
      </AnchoredMenu>
    </>
  )
}
