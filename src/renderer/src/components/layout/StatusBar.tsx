import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Moon, Sun, Wallet, Play, Plug, WifiOff, Waves, ShieldAlert } from 'lucide-react'
import { useApp } from '@renderer/store/appStore'
import { cn } from '@renderer/lib/format'
import { themeById, toggleTheme } from '@shared/themes'
import { PROVIDER_LABEL, providerOf } from '@shared/provider'
import { formatEt, minutesToClose, sessionLabel, type SessionLabel } from '@shared/marketTime'
import { ProviderPicker, useProviderReadiness } from '@renderer/components/common/ProviderPicker'
import { Meter } from '@renderer/components/common/Primitives'

/**
 * A connection's state, as one dot.
 *
 * Healthy is INK, not green. Green is money (rule 2) — spending it on "the
 * broker socket is up" is how a colour stops being able to tell the truth, and
 * a row of green dots in the corner is exactly the sort of ambient reassurance
 * that makes a real P&L figure harder to find. Degraded is `--color-warn`,
 * absent is the muted grey. Red never appears here at all: the only red in this
 * strip is the account halt.
 */
function Dot({ ok, warn }: { ok: boolean; warn?: boolean }): JSX.Element {
  return <span className={cn('dot shrink-0', ok ? (warn ? 'bg-warn' : 'bg-text/70') : 'bg-muted/40')} />
}

/** Connection chip: shrinks and truncates instead of overlapping its neighbour. */
function Chip({ label, value, ok, warn, onClick }: { label: string; value: string; ok: boolean; warn?: boolean; onClick: () => void }): JSX.Element {
  return (
    <button className="flex items-center gap-1.5 min-w-0 hover:text-text transition-colors" onClick={onClick} title={`${label}: ${value}`}>
      <Dot ok={ok} warn={warn} />
      <span className="truncate">
        {label}: {value}
      </span>
    </button>
  )
}

/** A hairline tick between clusters, so the strip reads as groups rather than a queue of items. */
function Rule(): JSX.Element {
  return <span aria-hidden className="shrink-0 h-3.5 w-px bg-hairline" />
}

function resetLabel(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** How often the session clock re-reads the ET wall clock. */
const CLOCK_TICK_MS = 15_000

/**
 * The two steps of Claude's 5-hour window. At `USAGE_WARN_PCT` the bar leaves
 * the accent for `--color-warn`; at `USAGE_TIGHT_PCT` the figure itself takes
 * the warn colour and a little weight, because from there a scheduled run can
 * plausibly be the one that hits the wall.
 *
 * Warn, not red. A quota nearly spent is a warning, and this strip has exactly
 * one red — the account halt (rule 2 and "one red in the chrome"). The escalation
 * is carried by the step from accent → warn → warn-and-emphasised, and by the
 * "on hold" line appearing when the limit actually bites.
 */
const USAGE_WARN_PCT = 75
const USAGE_TIGHT_PCT = 95

const SESSION_TEXT: Record<SessionLabel, string> = { open: 'Open', pre: 'Pre-market', after: 'After hours', closed: 'Closed' }

/**
 * The trading day, in the corner of the window.
 *
 * Everything the fleet does is timed to a session that is not the operator's
 * own clock, and "why didn't it sell at 3:58?" is usually answered by which
 * session it was. So the strip states it: the phase, and the ET time it is
 * derived from — from `shared/marketTime.ts`, the same functions the engine
 * schedules against, so the chrome can never disagree with the runner about
 * whether the market is open.
 *
 * Deliberately achromatic. Green and red are money (rule 2); the session is
 * carried by ink weight — open is full strength, the edges of the day are
 * muted, closed is faint.
 */
function SessionClock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), CLOCK_TICK_MS)
    return () => clearInterval(t)
  }, [])
  const phase = sessionLabel(now)
  const left = minutesToClose(now)
  const title =
    phase === 'open'
      ? `The regular session is open${left === null ? '' : ` — ${left} minute${left === 1 ? '' : 's'} to the close`}. ${formatEt(now)}.`
      : phase === 'pre'
        ? `Pre-market (from 4:00 AM ET). Limit orders only, and whole shares. ${formatEt(now)}.`
        : phase === 'after'
          ? `After hours (to 8:00 PM ET). Limit orders only, and whole shares. ${formatEt(now)}.`
          : `The US equity market is closed. ${formatEt(now)}.`
  return (
    <span className={cn('flex items-center gap-1.5 shrink-0', phase === 'open' ? 'text-text' : phase === 'closed' ? 'text-text-3' : 'text-muted')} title={title}>
      <span className={cn('dot shrink-0', phase === 'open' ? 'bg-text' : phase === 'closed' ? 'bg-muted/30' : 'bg-muted/60')} />
      <span className="font-medium">{SESSION_TEXT[phase]}</span>
      <span className="nums hidden @2xl:inline text-text-3">{formatEt(now)}</span>
    </span>
  )
}

/**
 * Bottom chrome — 28px (`--h-status`), hairline above, no shadow (rule 1: a
 * structural strip is separated by a line, never by elevation).
 *
 * Left, the state of the world: the trading session, then the **provider
 * switcher** — which service NEW agents run on (Claude · ChatGPT ·
 * OpenRouter · Local GPU); each option's dot says whether that service is ready and
 * hovering tells you why not. Existing agents keep their own provider (switch
 * one from its settings). Then Claude's 5-hour meter (only while Claude is the
 * selected provider), Robinhood, and a plug to open Connections.
 *
 * Right, things that need answering: the trading halt, offline, the usage hold,
 * then the two view switches. The halt is the only red in the chrome, which is
 * what makes it unmissable without shouting.
 */
export function StatusBar(): JSX.Element {
  const claude = useApp((s) => s.claude)
  const usage = useApp((s) => s.claudeUsage)
  const rh = useApp((s) => s.robinhood)
  const settings = useApp((s) => s.settings)
  const openSheet = useApp((s) => s.openSheet)
  const openAccount = useApp((s) => s.openAccount)
  const setTheme = useApp((s) => s.setTheme)
  const setDefaultProvider = useApp((s) => s.setDefaultProvider)
  const portfolioOpen = useApp((s) => s.portfolioOpen)
  const togglePortfolio = useApp((s) => s.togglePortfolio)
  const calm = useApp((s) => s.calm)
  const setCalm = useApp((s) => s.setCalm)
  const online = useApp((s) => s.online)
  const agents = useApp((s) => s.agents)
  const ready = useProviderReadiness()
  const theme = settings?.theme ?? 'light'
  const connections = (): void => openSheet({ kind: 'connections' })
  const fiveHour = usage?.available ? usage.fiveHour : undefined
  const used = fiveHour ? Math.min(100, Math.round(fiveHour.utilization)) : 0
  const provider = settings?.defaultProvider ?? 'claude'
  const stranded = online ? 0 : Object.values(agents).filter((a) => a.state.status !== 'retired' && a.state.status !== 'paused' && providerOf(a.config) !== 'local').length

  return (
    <footer className="@container shrink-0 hair-t bg-rail flex items-center px-2.5 gap-2.5 text-xs text-muted overflow-hidden" style={{ height: 'var(--h-status)' }}>
      <SessionClock />
      <Rule />

      <span className="flex items-center gap-1.5 shrink-0" title={`New agents run on ${PROVIDER_LABEL[provider]} — ${ready[provider].detail}. Existing agents keep their own provider (Agent settings → Runs on).`}>
        <span className="hidden @4xl:inline">New agents:</span>
        <ProviderPicker value={provider} onChange={(p) => void setDefaultProvider(p)} compact />
      </span>

      {/* Claude's 5-hour subscription window — only while Claude is the selected
          provider, so a bar about someone else's service isn't sitting in the way.
          The "on hold" warning below is separate: it appears whenever the limit
          actually bites, whichever provider is selected. */}
      {provider === 'claude' && claude?.authenticated && fiveHour && (
        <span
          className="flex items-center gap-1.5 shrink-0"
          title={`Claude 5-hour window: ${used}% used${fiveHour.resetsAt ? ` · resets ${resetLabel(fiveHour.resetsAt)}` : ''}${usage?.sevenDay ? ` · 7-day: ${Math.round(usage.sevenDay.utilization)}%` : ''}`}
        >
          <Meter value={used} max={100} warnAt={USAGE_WARN_PCT / 100} className="meter-chrome w-14" />
          <span className={cn('nums', used >= USAGE_TIGHT_PCT && 'text-warn font-medium')}>{used}%</span>
        </span>
      )}

      <Chip
        label="Robinhood"
        value={rh?.connected ? (rh.accountHint ? `Connected ${rh.accountHint}` : 'No agentic account') : 'Not connected'}
        ok={Boolean(rh?.connected)}
        warn={Boolean(rh?.connected && !rh.accountHint)}
        onClick={connections}
      />
      <button className="btn-icon h-5 w-5 shrink-0" onClick={connections} title="Connections — Claude, ChatGPT, OpenRouter, Robinhood and market data">
        <Plug size={12} />
      </button>

      <span className="flex-1 min-w-2" />

      {/* The one red in the chrome. It states what the halt does NOT stop as
          plainly as what it does — a panic switch that is believed to do more
          than it does is worse than none. */}
      {settings?.tradingHalted && (
        <button
          className="pill pill-armed shrink-0 hover:opacity-90 transition-opacity"
          onClick={() => openAccount('safety')}
          title="Trading is halted: live BUYS are refused on every agent. Sells, stops, targets and paper agents keep working. Open Settings → Trading safety to lift it."
        >
          <ShieldAlert size={11} />
          <span className="font-medium tracking-[0.04em]">HALTED</span>
        </button>
      )}

      {!online && (
        <span className="flex items-center gap-1.5 shrink-0 text-warn font-medium" title="This computer is offline. Local GPU agents keep running; everything else — Claude, ChatGPT and OpenRouter agents — waits for the connection and picks up where it left off.">
          <WifiOff size={12} />
          <span className="hidden @xl:inline">
            Offline — only {PROVIDER_LABEL.local}
            {stranded ? ` (${stranded} waiting)` : ''}
          </span>
          <span className="@xl:hidden">Offline</span>
        </span>
      )}

      {/* The usage hold pauses Claude-vendor agents until the window resets. It
          is a warning, not a halt and not a loss — `--color-warn`, so the one
          red in this strip stays the account halt above. */}
      {usage?.holdActive && (
        <span className="flex items-center gap-1.5 shrink-0 text-warn font-medium">
          <span className="hidden @xl:inline">Claude agents on hold — limit reached{fiveHour?.resetsAt ? ` · resets ${resetLabel(fiveHour.resetsAt)}` : ''}</span>
          <span className="@xl:hidden">On hold</span>
          <button className="btn btn-outline h-5 px-2 text-2xs gap-1" onClick={() => void window.tb.claude.overrideUsageHold()} title="Run Claude agents anyway despite the usage limit">
            <Play size={10} /> Resume anyway
          </button>
        </span>
      )}

      <button
        className={cn('flex items-center gap-1.5 shrink-0 transition-colors', portfolioOpen ? 'text-text font-medium' : 'hover:text-text')}
        onClick={togglePortfolio}
        aria-pressed={portfolioOpen}
        title="Toggle portfolio panel"
      >
        <Wallet size={12} /> <span className="hidden @lg:inline">Portfolio</span>
      </button>

      <Rule />

      <button
        className="btn-icon h-5 w-5 shrink-0"
        data-on={calm}
        aria-pressed={calm}
        onClick={() => setCalm(!calm)}
        title={
          calm
            ? 'Calm mode is on — profit-and-loss colour is drained app-wide. Armed agents, the trading halt and anything waiting on you are never quietened. Click to turn it off.'
            : 'Calm mode — drain profit-and-loss colour from the app so you can read the fleet without the numbers shouting. Armed agents, the trading halt and anything waiting on you stay exactly as loud.'
        }
      >
        <Waves size={12} />
      </button>
      <button className="btn-icon h-5 w-5 shrink-0" title={`Theme: ${themeById(theme).name} — switch to ${themeById(toggleTheme(theme)).name}`} onClick={() => void setTheme(toggleTheme(theme))}>
        {themeById(theme).scheme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
      </button>
    </footer>
  )
}
