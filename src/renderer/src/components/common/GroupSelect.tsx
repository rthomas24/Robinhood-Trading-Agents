import type { JSX } from 'react'
import type { AgentGroup } from '@shared/agentLayout'
import { cn } from '@renderer/lib/format'

/**
 * "Which group" as a plain select: every group in the layout's order plus
 * "None". Used by Agent settings (writes at once — the group is layout, not
 * config, so it does not wait for Save) and New agent (applied after create).
 *
 * `.select` rather than `.input`: the system draws the disclosure chevron and
 * strips the platform's own, so a group picker looks the same on Windows and
 * macOS instead of borrowing whatever the OS paints.
 */
export function GroupSelect({ groups, value, onChange, className, disabled }: { groups: AgentGroup[]; value: string | null; onChange: (groupId: string | null) => void; className?: string; disabled?: boolean }): JSX.Element {
  return (
    <select
      className={cn('select w-auto max-w-full', className)}
      aria-label="Group"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">None</option>
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  )
}
