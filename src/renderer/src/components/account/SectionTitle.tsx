import type { JSX } from 'react'

/**
 * The heading at the top of a My-account section. One level above `Group` —
 * heavier by tone and spacing, never by a third font size — so the page reads
 * as section → groups → rows without any of them shouting.
 *
 * Title and blurb only. A control parked beside a page heading belongs in a
 * `Row` of one of the groups under it, where its own label and the sentence
 * explaining it sit together — a switch floating next to a section name is a
 * switch nothing describes.
 */
export function SectionTitle({ title, blurb }: { title: string; blurb: string }): JSX.Element {
  return (
    <div className="mb-6">
      <h3 className="text-xl font-semibold tracking-[-0.02em]">{title}</h3>
      <p className="text-sm text-muted mt-1.5 max-w-[68ch] leading-relaxed">{blurb}</p>
    </div>
  )
}
