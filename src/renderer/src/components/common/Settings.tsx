import type { JSX, ReactNode } from 'react'
import { cn } from '@renderer/lib/format'
import { SectionHead } from './Primitives'

/**
 * The settings row, the way macOS and Linear lay one out: a titled group is ONE
 * card, each setting is a row with its name and explanation on the left and its
 * control on the right, rows separated by hairlines rather than boxed twice.
 *
 * This pair is the CANONICAL one — every settings surface in the app is meant
 * to come through it, so density, hairline weight and the label/hint voice are
 * decided once. A control that needs the full width (a picker, a gallery, a
 * form) uses `stack`.
 *
 * Neither takes a `className` and a group takes no header control, on purpose.
 * The moment one caller can nudge the padding or park a switch beside a heading,
 * "every settings surface looks the same" stops being true by construction and
 * starts being true only while someone is watching.
 */
export function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="mb-8">
      <SectionHead title={title} hint={hint} className="px-0.5" />
      <div className="card overflow-hidden divide-hair">{children}</div>
    </section>
  )
}

export function Row({
  title,
  hint,
  children,
  stack
}: {
  title: ReactNode
  hint?: ReactNode
  /** The control. Sits at the right; with `stack` it sits under the text at full width. */
  children?: ReactNode
  stack?: boolean
}): JSX.Element {
  return (
    <div className={cn('px-4 py-2.5 min-h-[var(--h-row)]', stack ? 'flex flex-col gap-2.5' : 'flex items-center gap-4')}>
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium">{title}</div>
        {hint !== undefined && <div className="hint mt-0.5 max-w-[64ch]">{hint}</div>}
      </div>
      {children !== undefined && <div className={cn(stack ? 'w-full' : 'shrink-0')}>{children}</div>}
    </div>
  )
}
