import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useApp, type SheetKind } from './store/appStore'
import { useRealtime } from './store/realtimeStore'
import { Sidebar } from './components/layout/Sidebar'
import { StatusBar } from './components/layout/StatusBar'
import { ThreadView } from './components/thread/ThreadView'
import { NewAgentSheet } from './components/sheets/NewAgentSheet'
import { AgentSettingsSheet } from './components/sheets/AgentSettingsSheet'
import { AgentStatsSheet } from './components/sheets/AgentStatsSheet'
import { ConnectionsSheet } from './components/sheets/ConnectionsSheet'
import { ManageGroupsSheet } from './components/sheets/ManageGroupsSheet'
import { Onboarding } from './components/onboarding/Onboarding'
import { PortfolioPanel } from './components/portfolio/PortfolioPanel'
import { AccountPage } from './components/account/AccountPage'
import { PaperPortfolioPage } from './components/portfolio/PaperPortfolioPage'
import { RealtimePage } from './components/realtime/RealtimePage'
import { SheetClosing } from './components/common/Sheet'
import { CommandPalette } from './components/common/CommandPalette'
import { EmptyState } from './components/common/Primitives'
import { MessageSquarePlus } from 'lucide-react'

/** Must cover the longest exit transition in index.css (.sheet-panel, 280ms). */
const SHEET_EXIT_MS = 300

/**
 * Keeps the last sheet mounted for the length of its exit after the store has
 * forgotten it. Every way out — Cancel, Save, Escape, the backdrop — goes
 * through `openSheet({kind:'none'})`, so animating the exit HERE means no
 * sheet has to know about animation at all.
 */
function useLingeringSheet(sheet: SheetKind): { shown: SheetKind; closing: boolean } {
  const [last, setLast] = useState<SheetKind>(sheet)
  useEffect(() => {
    if (sheet.kind !== 'none') {
      setLast(sheet)
      return
    }
    const t = setTimeout(() => setLast(sheet), SHEET_EXIT_MS)
    return () => clearTimeout(t)
  }, [sheet])
  const closing = sheet.kind === 'none' && last.kind !== 'none'
  return { shown: sheet.kind !== 'none' ? sheet : last, closing }
}

/**
 * True when the keystroke landed somewhere the operator is writing. A bare "/"
 * shortcut is only safe with this guard — without it, typing "sell 3/4 of MU"
 * into the composer would rip focus out to the sidebar's search box mid-word.
 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

export default function App(): JSX.Element {
  const booted = useApp((s) => s.booted)
  const boot = useApp((s) => s.boot)
  const selectedId = useApp((s) => s.selectedId)
  const sheet = useApp((s) => s.sheet)
  const openSheet = useApp((s) => s.openSheet)
  const settings = useApp((s) => s.settings)
  const order = useApp((s) => s.order)
  const portfolioOpen = useApp((s) => s.portfolioOpen)
  const view = useApp((s) => s.view)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)
  const [skipOnboarding, setSkip] = useState(false)
  const updateSettings = useApp((s) => s.updateSettings)
  const { shown, closing } = useLingeringSheet(sheet)

  // The market-data key status is read up front too: it decides whether paper
  // agents can be marked without Robinhood (sidebar P&L).
  const refreshStream = useRealtime((s) => s.refreshStream)
  useEffect(() => {
    void boot()
    void refreshStream()
  }, [boot, refreshStream])

  // Having an agent IS being past onboarding, so record it the moment it is
  // true rather than only when the sheet is dismissed.
  //
  // `onboardingDone` used to be written in exactly two places, both inside the
  // Onboarding component. Anyone whose first boot already had agents never saw
  // the sheet, so the flag stayed false indefinitely — and the day they deleted
  // their last agent, `order.length === 0` became true and they were dropped
  // into first-run onboarding months into using the app. The stored `false`
  // meant "we never asked", and the gate read it as "they never finished".
  useEffect(() => {
    if (booted && order.length > 0 && settings && !settings.onboardingDone) void updateSettings({ onboardingDone: true })
  }, [booted, order.length, settings?.onboardingDone, updateSettings])

  // Measure the native window-controls overlay (Windows caption buttons) and
  // expose it as --wco-pad so headers can keep their buttons clear of it.
  useEffect(() => {
    const wco = (navigator as unknown as { windowControlsOverlay?: { visible?: boolean; getTitlebarAreaRect?: () => DOMRect; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void } }).windowControlsOverlay
    const apply = (): void => {
      let pad = 0
      if (wco?.visible && wco.getTitlebarAreaRect) {
        const r = wco.getTitlebarAreaRect()
        pad = Math.max(0, window.innerWidth - (r.x + r.width))
      } else if (window.tb.platform === 'win32') {
        pad = 138 // three 46px caption buttons (DIP — DPI-independent)
      }
      document.documentElement.style.setProperty('--wco-pad', `${pad}px`)
    }
    apply()
    wco?.addEventListener?.('geometrychange', apply)
    window.addEventListener('resize', apply)
    return () => {
      wco?.removeEventListener?.('geometrychange', apply)
      window.removeEventListener('resize', apply)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        openSheet({ kind: 'new' })
      } else if (mod && e.key.toLowerCase() === 'k') {
        // ⌘K is the palette now. The old behaviour — jump to the sidebar's
        // filter box — is not gone: it moved to "/", and the palette's "Go to"
        // group answers the same question with one keystroke fewer.
        e.preventDefault()
        setPaletteOpen(true)
      } else if (e.key === '/' && !mod && !e.altKey && !isTyping(e.target)) {
        e.preventDefault()
        document.getElementById('tb-search')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSheet, setPaletteOpen])

  if (!booted) return <BootSplash />

  const showOnboarding = !skipOnboarding && settings && !settings.onboardingDone && order.length === 0
  if (showOnboarding) {
    return (
      <Onboarding
        onDone={() => {
          setSkip(true)
          void window.tb.settings.set({ onboardingDone: true })
        }}
      />
    )
  }

  const close = (): void => openSheet({ kind: 'none' })
  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex-1 min-h-0 flex">
        <Sidebar />
        {view === 'account' ? (
          <AccountPage />
        ) : view === 'paper' ? (
          <PaperPortfolioPage />
        ) : view === 'realtime' ? (
          <RealtimePage />
        ) : selectedId ? (
          <ThreadView agentId={selectedId} />
        ) : (
          <NoAgentSelected onNew={() => openSheet({ kind: 'new' })} />
        )}
        {portfolioOpen && <PortfolioPanel />}
      </div>
      <StatusBar />
      {/* Keyed on what opened it: a second recipe arriving while the sheet is up
          remounts it, so nothing typed against the previous fill — least of all
          its Mode — carries over. */}
      <SheetClosing.Provider value={closing}>
        {shown.kind === 'new' && <NewAgentSheet key={shown.nonce ?? 'blank'} onClose={close} initialTemplateId={shown.templateId} initialDuplicateOf={shown.duplicateOf} initialMode={shown.initialMode} />}
        {shown.kind === 'settings' && <AgentSettingsSheet agentId={shown.agentId} onClose={close} />}
        {shown.kind === 'stats' && <AgentStatsSheet agentId={shown.agentId} onClose={close} />}
        {shown.kind === 'connections' && <ConnectionsSheet onClose={close} />}
        {shown.kind === 'groups' && <ManageGroupsSheet onClose={close} />}
      </SheetClosing.Provider>
      <CommandPalette />
    </div>
  )
}

/**
 * Boot. The engine is reading every agent's book off disk, so this is the one
 * moment the app has nothing true to say — and the honest answer to that is a
 * calm mark and the product's name, not the word "Loading…" and a spinner
 * implying something might fail.
 *
 * The whole frame is draggable: an unresponsive-looking window you cannot even
 * move is the thing that gets force-quit.
 */
function BootSplash(): JSX.Element {
  return (
    <div className="drag h-full w-full flex flex-col items-center justify-center gap-4 bg-bg fade-in">
      <AppMark />
      <div className="text-center">
        <p className="text-lg font-semibold tracking-[-0.02em]">Robinhood Trading Agents</p>
        <p className="shimmer-text text-sm mt-1">Opening the books</p>
      </div>
    </div>
  )
}

/**
 * The app's mark: a message bubble holding a rising line — every agent is a
 * thread, and every thread keeps a book. Drawn rather than shipped as an asset
 * so it takes the theme's own ink on all 18 palettes.
 */
function AppMark(): JSX.Element {
  return (
    <span className="h-12 w-12 rounded-xl inset flex items-center justify-center text-accent" aria-hidden>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z" strokeOpacity={0.5} />
        <path d="M7.5 12l3-3 2 2 4-4.5" />
      </svg>
    </span>
  )
}

/**
 * Nothing selected — every agent deleted, or the last one retired out of view.
 * Given the same weight as any other empty surface rather than a shrug: the
 * shortcut is on the button because this is exactly where someone learns it.
 */
function NoAgentSelected({ onNew }: { onNew: () => void }): JSX.Element {
  return (
    <section className="flex-1 flex flex-col bg-bg min-w-0">
      <div className="drag shrink-0" style={{ height: 'var(--h-header)' }} />
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<MessageSquarePlus size={20} strokeWidth={1.7} />}
          title="No agent selected"
          body="Pick one from the list to read its thread, or start a new one — a name, a job in plain English, and a schedule."
          action={
            <button className="btn btn-primary" onClick={onNew}>
              New agent
              {/* Not a `.kbd` chip: on a filled button its own surface colour
                  would read as a second badge rather than a hint. */}
              <span className="text-2xs font-normal opacity-60">{window.tb.platform === 'darwin' ? '⌘N' : 'Ctrl N'}</span>
            </button>
          }
        />
      </div>
    </section>
  )
}

