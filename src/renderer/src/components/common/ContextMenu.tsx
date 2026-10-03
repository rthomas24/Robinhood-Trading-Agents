import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@renderer/lib/format'

export type MenuItem =
  | {
      kind: 'item'
      label: string
      icon?: ReactNode
      disabled?: boolean
      checked?: boolean
      danger?: boolean
      /**
       * The shortcut that does the same thing from the keyboard, printed as a
       * `.kbd` on the right. Only pass one that actually exists — a menu is
       * where people learn shortcuts, so an invented one is a lie they will
       * carry around and try.
       */
      kbd?: string
      onSelect: () => void
    }
  | { kind: 'label'; label: string }
  | { kind: 'separator' }

/**
 * A small right-click menu anchored at a point. Native HTML, no library: it is
 * the keyboard-and-trackpad route to everything the sidebar's drag can do
 * (move up/down, move to a group), so nothing here may depend on a drag
 * having happened. Closes on Escape, on any click outside, on scroll and on
 * window blur; clamps itself inside the viewport.
 *
 * Floating, so it takes the floating elevation — `.card-float` is a stacked
 * shadow plus an inset ring, never the hairline a card on the page gets
 * (design rule 1: the two regimes never mix).
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  /** One slot per `items` entry; separators and labels leave a hole. */
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Drop refs for rows that no longer exist, so the roving focus never walks
    // into a button from a previous render of this menu.
    buttons.current.length = items.length
    const r = el.getBoundingClientRect()
    const nx = Math.max(4, Math.min(x, window.innerWidth - r.width - 4))
    const ny = Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    setPos({ x: nx, y: ny })
  }, [x, y, items.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  /**
   * Roving focus over the enabled items. The menu is the accessible route to
   * the sidebar's drag, so it has to be operable from the keyboard alone —
   * arrows to move, Home/End to jump, Enter to choose. Focus moves for real
   * rather than through `aria-activedescendant`, because a real focus ring is
   * what tells a sighted keyboard user where they are.
   */
  const focusAt = useCallback((from: number, step: number): void => {
    const list = buttons.current
    const n = list.length
    if (n === 0) return
    for (let i = 1; i <= n; i++) {
      const el = list[(((from + step * i) % n) + n) % n]
      if (el && !el.disabled) {
        el.focus()
        return
      }
    }
  }, [])

  useEffect(() => {
    // Land on the first usable item so the menu answers a keypress immediately.
    // Whatever had focus gets it back when the menu goes: the menu is the
    // keyboard route INTO the sidebar, so dismissing it with Escape must not
    // drop the operator out of the list they were walking.
    const previous = document.activeElement as HTMLElement | null
    focusAt(-1, 1)
    return () => previous?.focus?.()
  }, [focusAt])

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const at = buttons.current.findIndex((b) => b === document.activeElement)
    if (e.key === 'ArrowDown') focusAt(at, 1)
    else if (e.key === 'ArrowUp') focusAt(at, -1)
    else if (e.key === 'Home') focusAt(-1, 1)
    else if (e.key === 'End') focusAt(0, -1)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={onMenuKeyDown}
      className="no-drag card-float fixed z-50 min-w-[184px] max-w-[264px] p-1 text-base pop-in"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.kind === 'separator') return <div key={i} role="separator" className="menu-sep" />
        if (it.kind === 'label')
          return (
            <div key={i} role="presentation" className="eyebrow px-2 pt-2 pb-1 truncate">
              {it.label}
            </div>
          )
        return (
          <button
            key={i}
            ref={(el) => {
              buttons.current[i] = el
            }}
            // `aria-checked` is not supported on `menuitem`, so a plain
            // menuitem announced the group an agent is in as nothing at all.
            // A checked row here is always one of a set with exactly one
            // winner — "Move to group" — hence radio rather than checkbox.
            role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
            type="button"
            tabIndex={-1}
            disabled={it.disabled}
            data-danger={it.danger ? 'true' : undefined}
            aria-checked={it.checked === undefined ? undefined : it.checked}
            className={cn('menu-item disabled:opacity-40 disabled:hover:bg-transparent')}
            onClick={() => {
              it.onSelect()
              onClose()
            }}
          >
            <span className="w-4 shrink-0 flex items-center justify-center text-muted">{it.icon}</span>
            <span className="flex-1 truncate">{it.label}</span>
            {it.kbd && <kbd className="kbd shrink-0">{it.kbd}</kbd>}
            {it.checked && <Check size={13} className="shrink-0 text-accent" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}
