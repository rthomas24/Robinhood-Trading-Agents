import type { JSX, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ArrowRight, Layers, Moon, MessageSquarePlus, Pause, Play, Plug, SearchX, Settings2, Square, Sun, Wallet, Waves, Zap } from 'lucide-react'
import { themeById, toggleTheme } from '@shared/themes'
import { providerOf } from '@shared/provider'
import type { AgentSummary } from '@shared/agents'
import { useApp } from '@renderer/store/appStore'
import { cn } from '@renderer/lib/format'
import { EmptyState } from '@renderer/components/common/Primitives'
import { AgentAvatar } from '@renderer/components/common/AgentAvatar'

/**
 * The command palette — ⌘K / Ctrl K.
 *
 * It is PURE UI over the store: every row calls the same action the sidebar
 * menu, the thread header or the status bar already calls, so there is exactly
 * one implementation of "retire this agent" in the app and the palette cannot
 * drift from it. Nothing here talks to the engine that some visible control
 * does not also talk to.
 *
 * Three groups, in the order a keystroke is usually meant: what to do with the
 * agent in front of you, where to go, then the app itself.
 */

type Group = 'agent' | 'goto' | 'app'

interface Item {
  id: string
  group: Group
  label: string
  /** Extra words the query may match — an agent's task, a synonym for a page. */
  keywords?: string
  icon: ReactNode
  /**
   * One line of consequence, shown muted under the label. Only on rows that
   * change something an operator would want warning about: a run in flight, a
   * schedule, a live book.
   */
  consequence?: string
  shortcut?: string
  right?: ReactNode
  /**
   * An irreversible row does not run on Enter. It replaces the list with this,
   * and `run` happens only when the operator confirms it there.
   *
   * Fuzzy search plus a standing cursor means the highlighted row changes as
   * you type: "ret" can be Retire, and Retire sells an agent's open positions —
   * real money on a live agent. Nothing that destroys something may be one
   * keystroke away from a search box.
   */
  confirm?: { heading: string; body: ReactNode; action: string }
  run: () => void
}

const GROUP_LABEL: Record<Group, string> = { agent: 'This agent', goto: 'Go to', app: 'App' }
const GROUP_ORDER: Group[] = ['agent', 'goto', 'app']

/**
 * Subsequence match with a small score: every query character must appear in
 * order, a run of adjacent matches and a match at a word boundary score higher.
 * A plain substring therefore always wins over a scattered one, which is what
 * "type the first few letters" needs to feel right.
 */
function score(text: string, query: string): number | null {
  if (!query) return 0
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  let at = 0
  let points = 0
  let streak = 0
  for (const ch of needle) {
    const found = hay.indexOf(ch, at)
    if (found === -1) return null
    const boundary = found === 0 || /[\s\-_/·]/.test(hay[found - 1])
    streak = found === at ? streak + 1 : 0
    points += 1 + streak * 2 + (boundary ? 3 : 0)
    at = found + 1
  }
  // A short label that matched is a better answer than a long one that also did.
  return points - text.length * 0.01
}

export function CommandPalette(): JSX.Element | null {
  const open = useApp((s) => s.paletteOpen)
  const setOpen = useApp((s) => s.setPaletteOpen)
  const agents = useApp((s) => s.agents)
  const order = useApp((s) => s.order)
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const openSheet = useApp((s) => s.openSheet)
  const openAccount = useApp((s) => s.openAccount)
  const openPaper = useApp((s) => s.openPaper)
  const openRealtime = useApp((s) => s.openRealtime)
  const runNow = useApp((s) => s.runNow)
  const stopRun = useApp((s) => s.stopRun)
  const stopping = useApp((s) => s.stopping)
  const live = useApp((s) => s.live)
  const portfolioOpen = useApp((s) => s.portfolioOpen)
  const togglePortfolio = useApp((s) => s.togglePortfolio)
  const settings = useApp((s) => s.settings)
  const setTheme = useApp((s) => s.setTheme)
  const calm = useApp((s) => s.calm)
  const setCalm = useApp((s) => s.setCalm)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  /** The irreversible row waiting for an answer. Non-null = the palette IS the confirmation. */
  const [pending, setPending] = useState<{ item: Item; ask: NonNullable<Item['confirm']> } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const mod = window.tb.platform === 'darwin' ? '⌘' : 'Ctrl '
  const theme = settings?.theme ?? 'light'
  const agent: AgentSummary | undefined = selectedId ? agents[selectedId] : undefined
  const working = Boolean(agent && (agent.state.running || live[agent.config.id]))
  const retired = agent?.state.status === 'retired'
  const paused = agent?.state.status === 'paused'

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    if (agent && !retired) {
      const id = agent.config.id
      if (working)
        out.push({
          id: 'a-stop',
          group: 'agent',
          label: 'Stop the run',
          keywords: 'halt cancel abort',
          icon: <Square size={13} />,
          consequence: stopping[id] ? 'Already stopping — waiting for the run to end.' : 'Ends the run in flight. Anything queued goes out right after.',
          run: () => void stopRun(id)
        })
      else
        out.push({
          id: 'a-run',
          group: 'agent',
          label: 'Run now',
          keywords: 'tick wake execute',
          icon: <Zap size={13} />,
          run: () => void runNow(id)
        })
      out.push(
        paused
          ? { id: 'a-resume', group: 'agent', label: 'Resume', keywords: 'unpause start', icon: <Play size={13} />, run: () => void window.tb.agents.resume(id) }
          : {
              id: 'a-pause',
              group: 'agent',
              label: 'Pause',
              keywords: 'hold stop schedule',
              icon: <Pause size={13} />,
              consequence: 'Scheduled wake-ups stop until you resume. Armed exits keep being enforced.',
              run: () => void window.tb.agents.pause(id)
            }
      )
    }
    if (agent) {
      const id = agent.config.id
      out.push(
        { id: 'a-settings', group: 'agent', label: 'Agent settings', keywords: 'edit guardrails schedule allocation provider', icon: <Settings2 size={13} />, run: () => openSheet({ kind: 'settings', agentId: id }) },
        { id: 'a-stats', group: 'agent', label: 'Track record', keywords: 'stats scorecard win rate decisions', icon: <Wallet size={13} />, run: () => openSheet({ kind: 'stats', agentId: id }) }
      )
      if (!retired)
        out.push({
          id: 'a-retire',
          group: 'agent',
          label: 'Retire',
          keywords: 'stop finish close archive',
          icon: <Archive size={13} />,
          consequence: 'It flattens its open positions and stops for good. You can respawn it later.',
          confirm: {
            heading: `Retire ${agent.config.name}?`,
            body: (
              <>
                It flattens its open positions{agent.config.mode === 'live' ? ' — this agent trades real money, so those are real orders' : ''} and stops for good. You can respawn it later from the Retired
                section.
              </>
            ),
            action: 'Retire'
          },
          run: () => void window.tb.agents.retire(id)
        })
    }

    for (const agentId of order) {
      const a = agents[agentId]
      if (!a) continue
      out.push({
        id: `g-${agentId}`,
        group: 'goto',
        label: a.config.name,
        keywords: `${a.config.task} ${a.config.mode} ${providerOf(a.config)}`,
        icon: <AgentAvatar icon={a.config.icon} color={a.config.color} size={18} active={a.state.running} />,
        right:
          a.config.mode === 'live' ? (
            <span className={cn('pill', a.config.liveArmedAt ? 'pill-armed' : 'pill-live')}>{a.config.liveArmedAt ? 'Armed' : 'Live'}</span>
          ) : a.state.status === 'retired' ? (
            <span className="text-2xs text-text-3">Retired</span>
          ) : undefined,
        run: () => select(agentId)
      })
    }
    out.push(
      { id: 'g-account', group: 'goto', label: 'Settings', keywords: 'settings connections robinhood preferences trading safety local models mcp', icon: <ArrowRight size={13} />, run: () => openAccount() },
      { id: 'g-paper', group: 'goto', label: 'Paper portfolio', keywords: 'simulated book timeline all-time', icon: <ArrowRight size={13} />, run: () => openPaper() },
      { id: 'g-realtime', group: 'goto', label: 'Real time', keywords: 'realtime jev typesafe system one fast ticks scalping', icon: <ArrowRight size={13} />, run: () => openRealtime() },
      { id: 'g-panel', group: 'goto', label: portfolioOpen ? 'Hide the portfolio panel' : 'Show the portfolio panel', keywords: 'positions holdings sidebar right', icon: <Wallet size={13} />, run: () => togglePortfolio() }
    )

    out.push(
      { id: 'p-new', group: 'app', label: 'New agent', keywords: 'create add start template import', icon: <MessageSquarePlus size={13} />, shortcut: `${mod}N`, run: () => openSheet({ kind: 'new' }) },
      { id: 'p-groups', group: 'app', label: 'Manage groups', keywords: 'folders sections arrange layout', icon: <Layers size={13} />, run: () => openSheet({ kind: 'groups' }) },
      { id: 'p-connections', group: 'app', label: 'Connections', keywords: 'claude chatgpt robinhood sign in account broker', icon: <Plug size={13} />, run: () => openSheet({ kind: 'connections' }) },
      {
        id: 'p-theme',
        group: 'app',
        label: `Switch to ${themeById(toggleTheme(theme)).name}`,
        keywords: 'theme dark light appearance',
        icon: themeById(theme).scheme === 'dark' ? <Sun size={13} /> : <Moon size={13} />,
        run: () => void setTheme(toggleTheme(theme))
      },
      {
        id: 'p-calm',
        group: 'app',
        label: calm ? 'Turn calm mode off' : 'Turn calm mode on',
        keywords: 'quiet colour color pnl drain focus',
        icon: <Waves size={13} />,
        right: <span className="text-2xs text-text-3">{calm ? 'On' : 'Off'}</span>,
        run: () => setCalm(!calm)
      }
    )
    return out
  }, [agent, agents, order, working, paused, retired, stopping, mod, theme, calm, portfolioOpen, openSheet, select, openAccount, openPaper, openRealtime, togglePortfolio, runNow, stopRun, setTheme, setCalm])

  const results = useMemo(() => {
    const q = query.trim()
    // A keyword-only hit is worth less than a hit on the label itself, so
    // "retire" ranks the Retire row above an agent whose task mentions it.
    const scored = q ? items.map((it) => ({ it, s: Math.max(score(it.label, q) ?? -Infinity, (score(it.keywords ?? '', q) ?? -Infinity) - 6) })).filter((r) => Number.isFinite(r.s)) : items.map((it) => ({ it, s: 0 }))
    // Grouped in the order the groups are DRAWN, because the keyboard cursor is
    // an index into this list: a flat best-first sort would highlight rows in an
    // order the eye cannot follow down the page.
    return GROUP_ORDER.flatMap((g) =>
      scored
        .filter((r) => r.it.group === g)
        .sort((a, b) => b.s - a.s)
        .map((r) => r.it)
    )
  }, [items, query])

  // A fresh query means a fresh first answer; without this the cursor could sit
  // past the end of a shorter result list and Enter would do nothing.
  useEffect(() => setCursor(0), [query])
  // The list can also shrink under a standing cursor — an agent retires, a run
  // ends and Stop becomes Run now — so keep it inside the list either way.
  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, results.length - 1))), [results.length])
  useEffect(() => {
    if (!open) {
      setQuery('')
      // A confirmation never survives the palette closing: reopening it must
      // not put the operator one keypress from an order they walked away from.
      setPending(null)
    }
  }, [open])

  // Keep the highlighted row in view — `nearest` so arrowing down one row
  // scrolls by one row rather than recentring the whole list.
  useLayoutEffect(() => {
    if (!open || pending) return
    listRef.current?.querySelector<HTMLElement>('[data-on="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open, pending, results.length])

  // Give focus back to whatever had it. A palette that swallows focus leaves the
  // composer dead after Escape, which reads as the app having hung.
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => previous?.focus?.()
  }, [open])

  // Focus lands on Cancel, not on the destructive button: the key that opened
  // the confirmation must not also be the key that answers it. Cancelling hands
  // focus back to the search box — every key the palette listens for arrives
  // through the surface, so focus parked on <body> would leave it dead.
  useEffect(() => {
    if (pending) cancelRef.current?.focus()
    else if (open) inputRef.current?.focus()
  }, [pending, open])

  if (!open) return null

  const choose = (item: Item): void => {
    if (item.confirm) {
      setPending({ item, ask: item.confirm })
      return
    }
    setOpen(false)
    item.run()
  }

  const commit = (): void => {
    if (!pending) return
    const { item } = pending
    setPending(null)
    setOpen(false)
    item.run()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    // While a confirmation is up it is the whole palette: the list, its cursor
    // and its shortcuts are gone, and Escape steps back to the list rather than
    // closing anything.
    if (pending) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setPending(null)
      }
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault()
      setCursor((c) => (results.length ? (c + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault()
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setCursor(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setCursor(Math.max(0, results.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[cursor]
      if (item) choose(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Stop here. A sheet open behind the palette listens for Escape on the
      // window, so one press used to close both — and the sheet closing is the
      // operator's unsaved edits gone.
      e.stopPropagation()
      setOpen(false)
    }
  }

  let index = -1
  if (pending)
    return createPortal(
      <div className="no-drag fixed inset-0 z-[60] flex justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label={pending.ask.heading}>
        {/* Clicking away dismisses the whole palette, as it does from the list —
            nothing runs either way, and closing clears the pending answer. */}
        <div className="absolute inset-0 sheet-backdrop" onClick={() => setOpen(false)} aria-hidden />
        {/* The confirmation REPLACES the list rather than sitting over it: while
            this is up there is no search box to type into and no cursor to
            press Enter on, so there is exactly one thing the palette can do. */}
        <div className="palette relative pop-in flex flex-col" onKeyDown={onKey}>
          <div className="p-4 flex items-start gap-3">
            <span className="shrink-0 mt-0.5 text-armed flex items-center justify-center w-4.5">{pending.item.icon}</span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{pending.ask.heading}</h2>
              <p className="mt-1 text-sm text-muted leading-relaxed max-w-[56ch]">{pending.ask.body}</p>
            </div>
          </div>
          <div className="hair-t flex items-center gap-2 px-3 h-12">
            {/* Focus sits on Cancel, so the hint says how to reach the other
                button rather than pretending ↵ is the answer. */}
            <span className="flex items-center gap-1 text-2xs text-text-3">
              <span className="kbd">esc</span> cancel
              <span className="kbd ml-2">tab</span> to {pending.ask.action}
            </span>
            <span className="flex-1" />
            <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger-solid" onClick={commit}>
              {pending.ask.action}
            </button>
          </div>
        </div>
      </div>,
      document.body
    )

  return createPortal(
    <div className="no-drag fixed inset-0 z-[60] flex justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 sheet-backdrop" onClick={() => setOpen(false)} aria-hidden />
      <div className="palette relative pop-in flex flex-col max-h-[68vh]" onKeyDown={onKey}>
        <div className="hair-b shrink-0">
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={agent ? `Search ${agent.config.name}, your agents and the app…` : 'Search your agents and the app…'}
            aria-label="Search commands"
            aria-controls="tb-palette-list"
            aria-activedescendant={results[cursor] ? `tb-palette-${results[cursor].id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div ref={listRef} id="tb-palette-list" role="listbox" aria-label="Commands" className="flex-1 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <EmptyState icon={<SearchX size={18} />} title="Nothing matches" body={<>No command or agent called “{query.trim()}”. Try part of an agent's name, or a word like “retire”, “theme” or “connections”.</>} className="py-8" />
          ) : (
            GROUP_ORDER.map((group) => {
              const rows = results.filter((r) => r.group === group)
              if (!rows.length) return null
              return (
                <div key={group} className="mb-1 last:mb-0">
                  <div className="eyebrow px-2.5 pt-2 pb-1 flex items-baseline gap-2">
                    <span className="shrink-0">{GROUP_LABEL[group]}</span>
                    {group === 'agent' && agent && <span className="normal-case tracking-normal text-muted truncate">{agent.config.name}</span>}
                  </div>
                  {rows.map((item) => {
                    index += 1
                    const i = index
                    const on = i === cursor
                    return (
                      <button
                        key={item.id}
                        id={`tb-palette-${item.id}`}
                        role="option"
                        aria-selected={on}
                        type="button"
                        data-on={on}
                        // `mousemove`, not `mouseenter`: a cursor parked over a
                        // row must not steal the highlight from the arrow keys.
                        onMouseMove={() => setCursor(i)}
                        onClick={() => choose(item)}
                        className={cn('palette-row', item.consequence && 'h-auto py-1.5 items-start')}
                      >
                        <span className={cn('shrink-0 text-muted flex items-center justify-center w-4.5', item.consequence && 'mt-0.5')}>{item.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{item.label}</span>
                          {item.consequence && <span className="block text-xs text-muted truncate">{item.consequence}</span>}
                        </span>
                        {item.right}
                        {item.shortcut && <span className="kbd shrink-0">{item.shortcut}</span>}
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        <div className="hair-t shrink-0 flex items-center gap-3 px-3 h-8 text-2xs text-text-3">
          <span className="flex items-center gap-1">
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> move
          </span>
          <span className="flex items-center gap-1">
            <span className="kbd">↵</span> run
          </span>
          <span className="flex items-center gap-1">
            <span className="kbd">esc</span> close
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1">
            <span className="kbd">/</span> search the list
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
