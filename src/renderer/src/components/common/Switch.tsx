import type { JSX } from 'react'
import { cn } from '@renderer/lib/format'

/**
 * iOS-style toggle. The thumb STRETCHES while pressed (18 → 22px, anchored to
 * the side it is on) — the detail that makes a switch feel held rather than
 * clicked — and settles with the ease-out curve when released. Pressed on the
 * right it must give back the 4px it gains (16 → 12) or the edge it is anchored
 * to would move.
 *
 * Everything it is painted with is a token: the track takes the accent when on
 * and the surface ladder when off, and the thumb rides on the app's own
 * elevation step rather than a hand-mixed shadow, so all 18 palettes get the
 * same control without tuning.
 */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label?: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('group relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full disabled:opacity-45 disabled:pointer-events-none', checked ? 'bg-accent' : 'bg-surface-3')}
      style={{ transition: 'background-color var(--dur) var(--ease-out)' }}
    >
      <span
        aria-hidden
        className={cn('absolute top-[2px] left-[2px] h-[18px] w-[18px] rounded-full group-active:w-[22px]', checked ? 'translate-x-[16px] group-active:translate-x-[12px]' : 'translate-x-0')}
        style={{ background: 'var(--color-accent-fg)', boxShadow: 'var(--shadow-2)', transition: 'transform var(--dur) var(--ease-out), width var(--dur) var(--ease-out)' }}
      />
    </button>
  )
}
