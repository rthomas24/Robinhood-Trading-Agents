import type { JSX } from 'react'
import { BRAND_MARKS, brandColor, type BrandSlug } from '@shared/brandMarks'

/**
 * A real company's mark, drawn from the shared path data.
 *
 * Defaults to `currentColor` so a mark inherits the surrounding text colour and
 * works in both themes without a second asset. Pass `brand` to paint it in the
 * company's own colour instead — right for a connection card, wrong for a dense
 * sidebar row where it would fight the row's own state colour.
 *
 * NOT decorative by default. These identify which real service an operator is
 * connected to, so the mark carries the brand's name for a screen reader unless
 * a caller says otherwise with `label={null}` (correct when a visible text label
 * sits right beside it and the mark would just repeat it).
 */
export function BrandMark({
  slug,
  size = 18,
  brand = false,
  label,
  className
}: {
  slug: BrandSlug
  size?: number
  /** Paint it in the company's own colour rather than inheriting. */
  brand?: boolean
  /** Accessible name; `null` when an adjacent visible label already says it. */
  label?: string | null
  className?: string
}): JSX.Element {
  const mark = BRAND_MARKS[slug]
  const name = label === undefined ? mark.title : label
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill={brand ? brandColor(slug) : 'currentColor'}
      role={name ? 'img' : undefined}
      aria-label={name ?? undefined}
      aria-hidden={name ? undefined : true}
    >
      {name ? <title>{name}</title> : null}
      <path d={mark.d} />
    </svg>
  )
}

