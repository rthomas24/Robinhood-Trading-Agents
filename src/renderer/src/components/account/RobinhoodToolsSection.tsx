import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw, Eye, PenLine, ChevronDown, ChevronRight, Landmark, LineChart, Layers, ListChecks, ScanSearch, Boxes, ShoppingCart } from 'lucide-react'
import {
  DEFAULT_TOOL_POLICY,
  ROBINHOOD_TOOL_CATALOG,
  ROBINHOOD_TOOL_GROUP_LABEL,
  robinhoodToolGroup,
  robinhoodToolKind,
  type RobinhoodLiveTool,
  type RobinhoodToolGroup,
  type RobinhoodToolInfo,
  type RobinhoodToolKind,
  type ToolPolicy
} from '@shared/mcps'
import { useApp } from '@renderer/store/appStore'
import { cn, ipcErrorText } from '@renderer/lib/format'
import { Switch } from '@renderer/components/common/Switch'
import { SectionTitle } from './SectionTitle'

/**
 * Settings → Robinhood tools. Two panels (Read / Write), each a grid of
 * GROUP tiles with their own master switch — the whole surface fits on one
 * screen. Click a tile to expand its tools for per-tool switches. Options
 * write tools are their own group so "all writes except options" is one click.
 */

const GROUP_ORDER: RobinhoodToolGroup[] = ['account', 'market', 'options', 'orders', 'watchlists', 'scans', 'other']
const GROUP_ICON: Record<RobinhoodToolGroup, ReactNode> = {
  account: <Landmark size={14} />,
  market: <LineChart size={14} />,
  options: <Layers size={14} />,
  orders: <ShoppingCart size={14} />,
  watchlists: <ListChecks size={14} />,
  scans: <ScanSearch size={14} />,
  other: <Boxes size={14} />
}

/** Catalog entry, or a live-discovered tool classified by name. */
function toolRows(live: RobinhoodLiveTool[] | null): RobinhoodToolInfo[] {
  if (!live || live.length === 0) return ROBINHOOD_TOOL_CATALOG
  const known = new Map(ROBINHOOD_TOOL_CATALOG.map((t) => [t.name, t]))
  return live.map((l) => known.get(l.name) ?? { name: l.name, label: l.name.replace(/_/g, ' '), description: l.description?.split('\n')[0] ?? '', kind: robinhoodToolKind(l.name) })
}

interface Group {
  id: RobinhoodToolGroup
  kind: RobinhoodToolKind
  tools: RobinhoodToolInfo[]
}
function groupsOf(rows: RobinhoodToolInfo[], kind: RobinhoodToolKind): Group[] {
  const by = new Map<RobinhoodToolGroup, RobinhoodToolInfo[]>()
  for (const t of rows) if (t.kind === kind) by.set(robinhoodToolGroup(t.name, t.kind), [...(by.get(robinhoodToolGroup(t.name, t.kind)) ?? []), t])
  return GROUP_ORDER.filter((g) => by.has(g)).map((g) => ({ id: g, kind, tools: by.get(g)! }))
}

function ToolRow({ t, on, onChange }: { t: RobinhoodToolInfo; on: boolean; onChange: (next: boolean) => void }): JSX.Element {
  return (
    <div className={cn('flex items-center gap-3 px-3 py-2', !on && 'opacity-55')}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{t.label}</span>
          <code className="text-2xs text-text-3 mono">{t.name}</code>
          {t.engineUses && (
            <span className="pill" title="The engine fetches this itself for context and protection; the switch only changes the model's direct access.">
              engine
            </span>
          )}
          {t.name === 'place_equity_order' && <span className="pill pill-up">guardrail-checked</span>}
        </div>
        {t.description && <div className="text-xs text-muted line-clamp-2 mt-0.5">{t.description}</div>}
      </div>
      <Switch checked={on} onChange={onChange} label={`${t.label} tool`} />
    </div>
  )
}

function GroupTile({ g, on, open, tone, onToggleAll, onOpen, children }: { g: Group; on: number; open: boolean; tone?: 'warn'; onToggleAll: (next: boolean) => void; onOpen: () => void; children: ReactNode }): JSX.Element {
  const all = on === g.tools.length
  const none = on === 0
  return (
    <div className={cn('card overflow-hidden flex flex-col', open && 'sm:col-span-2 lg:col-span-3')}>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className={cn('h-7 w-7 rounded-sm flex items-center justify-center shrink-0', none ? 'bg-surface-2 text-muted' : tone === 'warn' ? 'bg-down/12 text-down' : 'bg-accent/12 text-accent')}>{GROUP_ICON[g.id]}</span>
        <button type="button" className="flex-1 min-w-0 text-left" aria-expanded={open} onClick={onOpen}>
          <div className="flex items-center gap-1.5">
            <span className="text-base font-medium truncate">{ROBINHOOD_TOOL_GROUP_LABEL[g.id]}</span>
            {open ? <ChevronDown size={12} className="text-muted shrink-0" /> : <ChevronRight size={12} className="text-muted shrink-0" />}
          </div>
          <div className="text-xs text-muted nums">
            {on}/{g.tools.length} on{!all && !none ? ' · mixed' : ''}
          </div>
        </button>
        <Switch checked={all} onChange={onToggleAll} label={`All ${ROBINHOOD_TOOL_GROUP_LABEL[g.id]} tools`} />
      </div>
      {open && <div className="hair-t divide-hair max-h-[40vh] overflow-y-auto">{children}</div>}
    </div>
  )
}

/** The head above each panel: what it is, how many are on, and the bulk switches. */
function PanelHead({ icon, tone, title, count, total, children }: { icon: ReactNode; tone?: 'warn'; title: string; count: number; total: number; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className={cn('h-7 w-7 rounded-sm flex items-center justify-center shrink-0', tone === 'warn' ? 'bg-down/12 text-down' : 'bg-surface-2 text-muted')}>{icon}</span>
      <span className="text-base font-semibold">{title}</span>
      <span className="text-xs text-muted nums">
        {count}/{total} on
      </span>
      <span className="flex-1" />
      {children}
    </div>
  )
}

export function RobinhoodToolsSection(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const rh = useApp((s) => s.robinhood)
  const updateSettings = useApp((s) => s.updateSettings)
  const policy: ToolPolicy = settings?.tools ?? DEFAULT_TOOL_POLICY
  const [live, setLive] = useState<RobinhoodLiveTool[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = async (refresh = false): Promise<void> => {
    if (!rh?.connected) {
      setLive(null)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      setLive(await window.tb.robinhood.tools(refresh))
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rh?.connected])

  const rows = useMemo(() => toolRows(live), [live])
  const reads = useMemo(() => groupsOf(rows, 'read'), [rows])
  const writes = useMemo(() => groupsOf(rows, 'write'), [rows])
  const disabled = new Set(policy.robinhoodDisabled)
  const writeOn = new Set(policy.robinhoodWriteEnabled)
  const readOn = (t: RobinhoodToolInfo): boolean => !disabled.has(t.name)
  const writeIsOn = (t: RobinhoodToolInfo): boolean => writeOn.has(t.name)
  const readsOnCount = reads.reduce((n, g) => n + g.tools.filter(readOn).length, 0)
  const readsTotal = reads.reduce((n, g) => n + g.tools.length, 0)
  const writesOnCount = writes.reduce((n, g) => n + g.tools.filter(writeIsOn).length, 0)
  const writesTotal = writes.reduce((n, g) => n + g.tools.length, 0)
  const save = (patch: Partial<ToolPolicy>): void => void updateSettings({ tools: { ...policy, ...patch } })
  /** Reads are stored as a disabled-list, writes as an enabled-list — one setter each. */
  const setReads = (names: string[], on: boolean): void => {
    const next = new Set(disabled)
    for (const n of names) on ? next.delete(n) : next.add(n)
    save({ robinhoodDisabled: [...next] })
  }
  const setWrites = (names: string[], on: boolean): void => {
    const next = new Set(writeOn)
    for (const n of names) on ? next.add(n) : next.delete(n)
    save({ robinhoodWriteEnabled: [...next] })
  }
  const optionWrites = writes.find((g) => g.id === 'options')?.tools ?? []
  const nonOptionWrites = writes.filter((g) => g.id !== 'options').flatMap((g) => g.tools)
  const allButOptionsOn = nonOptionWrites.length > 0 && nonOptionWrites.every(writeIsOn) && !optionWrites.some(writeIsOn)
  const toggle = (key: string): void => setOpen((cur) => (cur === key ? null : key))

  return (
    <>
      <SectionTitle title="Robinhood tools" blurb="Every tool the Robinhood MCP exposes, for every agent, grouped. Flip a whole group with its switch or open it to pick tools. Changes apply to all agents on their next run." />
      <div className="flex items-center gap-2 text-xs text-muted mb-5">
        {/* Only the sentence is the live region — the Refresh button beside it
            must not be re-announced every time the list reloads. */}
        <span role="status" aria-live="polite">
          {live && live.length > 0 ? (
            <>
              Showing the <span className="nums">{live.length}</span> tools your Robinhood account exposes right now.
            </>
          ) : rh?.connected ? (
            <span className={err ? 'text-warn' : undefined}>{loading ? 'Reading your account’s tool list…' : err ? `Could not read the live tool list (${err}) — showing known tools.` : 'Showing known tools.'}</span>
          ) : (
            'Showing known tools — connect Robinhood to see exactly what your account exposes.'
          )}
        </span>
        {rh?.connected && (
          <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void load(true)}>
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        )}
      </div>

      {/* ── Read ── */}
      <PanelHead icon={<Eye size={14} />} title="Read" count={readsOnCount} total={readsTotal}>
        <button className="btn btn-outline btn-sm" disabled={readsOnCount === readsTotal} onClick={() => save({ robinhoodDisabled: [] })}>
          All on
        </button>
        <button className="btn btn-outline btn-sm" disabled={readsOnCount === 0} onClick={() => save({ robinhoodDisabled: reads.flatMap((g) => g.tools.map((t) => t.name)) })}>
          All off
        </button>
      </PanelHead>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 mb-2.5">
        {reads.map((g) => (
          <GroupTile key={g.id} g={g} on={g.tools.filter(readOn).length} open={open === `r:${g.id}`} onOpen={() => toggle(`r:${g.id}`)} onToggleAll={(on) => setReads(g.tools.map((t) => t.name), on)}>
            {g.tools.map((t) => (
              <ToolRow key={t.name} t={t} on={readOn(t)} onChange={(on) => setReads([t.name], on)} />
            ))}
          </GroupTile>
        ))}
      </div>
      <p className="hint mb-7 max-w-[78ch]">
        “engine” tools are also fetched by the engine itself (quotes, technicals, earnings, tradability, book). Switching one off removes the model&apos;s direct call; computed context and stop/target protection keep working.
      </p>

      {/* ── Write ── */}
      <PanelHead icon={<PenLine size={14} />} tone="warn" title="Write" count={writesOnCount} total={writesTotal}>
        {optionWrites.length > 0 && (
          <button
            className={cn('btn btn-sm', allButOptionsOn ? 'btn-primary' : 'btn-outline')}
            title="Turn on every write tool except options"
            onClick={() => {
              const next = new Set(writeOn)
              for (const t of nonOptionWrites) next.add(t.name)
              for (const t of optionWrites) next.delete(t.name)
              save({ robinhoodWriteEnabled: [...next] })
            }}
          >
            All on except options
          </button>
        )}
        <button className="btn btn-outline btn-sm" disabled={writesOnCount === writesTotal} onClick={() => save({ robinhoodWriteEnabled: writes.flatMap((g) => g.tools.map((t) => t.name)) })}>
          All on
        </button>
        <button className="btn btn-outline btn-sm" disabled={writesOnCount === 0} onClick={() => save({ robinhoodWriteEnabled: [] })}>
          All off
        </button>
      </PanelHead>
      <div className="mb-2.5 flex items-start gap-2 rounded-md bg-down/10 text-down px-3 py-2.5 text-xs leading-relaxed">
        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
        <div>
          Write tools let the model act on your Robinhood account directly. They are only ever callable by <b>live agents you have armed</b> — paper agents can never reach them. <code className="mono">place_equity_order</code> is still vetted against the agent&apos;s guardrails and booked in its ledger; option, review, watchlist and scan tools are not. The built-in <code className="mono">trade</code> tool remains the safer path.
        </div>
      </div>
      {writes.length === 0 ? (
        <div className="card px-4 py-3 text-sm text-muted">No write tools reported for this account.</div>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {writes.map((g) => (
            <GroupTile key={g.id} g={g} tone="warn" on={g.tools.filter(writeIsOn).length} open={open === `w:${g.id}`} onOpen={() => toggle(`w:${g.id}`)} onToggleAll={(on) => setWrites(g.tools.map((t) => t.name), on)}>
              {g.tools.map((t) => (
                <ToolRow key={t.name} t={t} on={writeIsOn(t)} onChange={(on) => setWrites([t.name], on)} />
              ))}
            </GroupTile>
          ))}
        </div>
      )}
    </>
  )
}
