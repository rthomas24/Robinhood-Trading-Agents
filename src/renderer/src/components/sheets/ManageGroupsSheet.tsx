import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, Check, FolderTree, Pencil, Plus, Trash2 } from 'lucide-react'
import { AGENT_COLORS, type AgentColor } from '@shared/agents'
import { groupCounts, MAX_GROUP_NAME, MAX_GROUPS, type AgentGroup } from '@shared/agentLayout'
import { Sheet } from '@renderer/components/common/Sheet'
import { COLORS } from '@renderer/components/common/AgentAvatar'
import { EmptyState, SectionHead } from '@renderer/components/common/Primitives'
import { useApp } from '@renderer/store/appStore'
import { cn } from '@renderer/lib/format'

/** The agent palette as picker chips; `null` = no tint. */
function ColorDots({ value, onChange }: { value: AgentColor | undefined; onChange: (c: AgentColor | null) => void }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label="No colour"
        aria-pressed={!value}
        title="No colour"
        onClick={() => onChange(null)}
        className={cn('h-5 w-5 rounded-full bg-surface-2 transition-transform duration-[var(--dur-fast)]', !value && 'ring-2 ring-offset-1 ring-offset-surface ring-[var(--ring)] scale-110')}
        style={{ boxShadow: 'inset 0 0 0 1px var(--color-hairline-strong)' }}
      />
      {AGENT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          aria-pressed={value === c}
          title={c}
          onClick={() => onChange(c)}
          className={cn('h-5 w-5 rounded-full transition-transform duration-[var(--dur-fast)]', value === c && 'ring-2 ring-offset-1 ring-offset-surface ring-[var(--ring)] scale-110')}
          style={{ background: (COLORS[c] ?? COLORS.blue).swatch }}
        >
          {value === c && <Check size={10} className="mx-auto text-accent-fg" />}
        </button>
      ))}
    </div>
  )
}

/**
 * Groups: make, rename, tint, reorder, delete. Every edit is one whole-document
 * write through the store (`shared/agentLayout.ts` rules — names ≤
 * MAX_GROUP_NAME, at most MAX_GROUPS, no duplicate names; the refusal
 * sentences come from `createGroup` so every surface says the same thing).
 * Deleting a group ungroups its members and deletes nothing else; the confirm
 * says so, because "delete" beside a list of agents reads like it might.
 */
export function ManageGroupsSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const layout = useApp((s) => s.layout)
  const agents = useApp((s) => s.agents)
  const layoutError = useApp((s) => s.layoutError)
  const create = useApp((s) => s.createGroup)
  const rename = useApp((s) => s.renameGroup)
  const remove = useApp((s) => s.deleteGroup)
  const move = useApp((s) => s.moveGroup)

  const counts = useMemo(() => groupCounts(layout, Object.keys(agents)), [layout, agents])
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<AgentColor | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const atCap = layout.groups.length >= MAX_GROUPS

  const add = async (): Promise<void> => {
    const e = await create(newName, newColor ?? undefined)
    setErr(e)
    if (!e) {
      setNewName('')
      setNewColor(null)
    }
  }
  const commitRename = (g: AgentGroup): void => {
    const clean = draft.trim()
    if (clean && clean !== g.name) void rename(g.id, clean)
    setEditing(null)
  }

  const problem = err ?? layoutError

  return (
    <Sheet title="Groups" onClose={onClose} width={440}>
      <p className="hint mb-4">Sections in the agent list. Drag agents between them, or pick a group in an agent&apos;s settings. Groups are saved on this computer.</p>

      {/* Armed red, not the P&L red: calm mode drains `--color-down` and clears
          `--tint-down` outright, so on this banner it would take the background
          away and leave a refusal looking like a caption. A refusal is a safety
          signal, and calm mode is exempt from those by rule. */}
      {problem && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-md px-3 py-2 text-sm text-armed" style={{ background: 'var(--tint-armed)' }}>
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{problem}</span>
        </div>
      )}

      <section className="mb-6">
        <SectionHead title="New group" hint={atCap ? `You have the maximum of ${MAX_GROUPS} groups.` : `A name and, if you like, a tint. Up to ${MAX_GROUPS}.`} />
        <div className="card p-3">
          <div className="flex items-center gap-2">
            <input
              className="input flex-1"
              aria-label="New group name"
              placeholder={atCap ? `Up to ${MAX_GROUPS} groups.` : 'Name'}
              maxLength={MAX_GROUP_NAME}
              value={newName}
              disabled={atCap}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add()
              }}
            />
            <button className="btn btn-primary shrink-0" disabled={atCap || !newName.trim()} onClick={() => void add()}>
              <Plus size={14} /> Add
            </button>
          </div>
          <div className="mt-2.5">
            <ColorDots value={newColor ?? undefined} onChange={setNewColor} />
          </div>
        </div>
      </section>

      <section>
        <SectionHead title="Your groups" right={<span className="text-sm text-muted nums">{layout.groups.length}</span>} />
        {layout.groups.length === 0 ? (
          <div className="card">
            <EmptyState icon={<FolderTree size={18} />} title="No groups yet" body="Every agent sits in one list. Add a group above and drag agents into it." />
          </div>
        ) : (
          <ul className="card divide-hair overflow-hidden">
            {layout.groups.map((g, i) => {
              const n = counts[g.id] ?? 0
              const isEditing = editing === g.id
              return (
                <li key={g.id} className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: g.color ? (COLORS[g.color] ?? COLORS.blue).swatch : 'var(--color-hairline-strong)' }} />
                    {isEditing ? (
                      <input
                        autoFocus
                        aria-label={`Rename ${g.name}`}
                        className="input h-7 flex-1 min-w-0"
                        maxLength={MAX_GROUP_NAME}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitRename(g)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(g)
                          else if (e.key === 'Escape') setEditing(null)
                        }}
                      />
                    ) : (
                      <button
                        className="flex-1 min-w-0 text-left flex items-baseline gap-2 group"
                        title="Rename"
                        onClick={() => {
                          setDraft(g.name)
                          setEditing(g.id)
                        }}
                      >
                        <span className="text-md font-medium truncate">{g.name}</span>
                        <span className="text-xs text-muted nums shrink-0">
                          {n} agent{n === 1 ? '' : 's'}
                        </span>
                        <Pencil size={11} className="text-muted opacity-0 group-hover:opacity-100 transition-opacity duration-[var(--dur-fast)] shrink-0 self-center" />
                      </button>
                    )}
                    <button className="btn-icon h-7 w-7" title="Move up" aria-label={`Move ${g.name} up`} disabled={i === 0} onClick={() => void move(g.id, i - 1)}>
                      <ArrowUp size={13} />
                    </button>
                    <button className="btn-icon h-7 w-7" title="Move down" aria-label={`Move ${g.name} down`} disabled={i === layout.groups.length - 1} onClick={() => void move(g.id, i + 1)}>
                      <ArrowDown size={13} />
                    </button>
                    <button
                      className="btn-icon h-7 w-7 text-down"
                      title="Delete group"
                      aria-label={`Delete ${g.name}`}
                      aria-expanded={confirm === g.id}
                      onClick={() => setConfirm(confirm === g.id ? null : g.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="mt-2 pl-4">
                    <ColorDots value={g.color} onChange={(c) => void rename(g.id, g.name, c)} />
                  </div>
                  {confirm === g.id && (
                    <div className="mt-2.5 inset p-2.5 flex items-center gap-2 text-sm animate-in">
                      <span className="flex-1">
                        Delete “{g.name}”? {n > 0 ? `Its ${n} agent${n === 1 ? '' : 's'} become ungrouped — nothing else changes.` : 'No agents are in it.'}
                      </span>
                      <button
                        className="btn btn-danger btn-sm shrink-0"
                        onClick={() => {
                          setConfirm(null)
                          void remove(g.id)
                        }}
                      >
                        Delete
                      </button>
                      <button className="btn btn-ghost btn-sm shrink-0" onClick={() => setConfirm(null)}>
                        Keep
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </Sheet>
  )
}
