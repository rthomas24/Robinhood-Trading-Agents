import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { AlertTriangle, Ban, Check } from 'lucide-react'
import { useApp } from '@renderer/store/appStore'
import { cn, ipcErrorText } from '@renderer/lib/format'

/**
 * The trading halt — one switch covering every agent.
 *
 * The design problem here is not the switch, it is the promise. "Halt trading"
 * sounds absolute, and this one is deliberately not: it refuses live BUYS and
 * leaves every exit working. That is the right behaviour — a halt that also
 * blocked sells would trap every open position at the moment its owner reached
 * for the panic button, and their stops would stop being stops — but it is only
 * safe if the control SAYS so. Someone who believes this froze everything, and
 * finds a stop fired an hour later, has been misled by the button rather than
 * protected by it. So the two scope columns are laid out with equal weight and
 * are never folded away: what it does NOT stop is as prominent as the control.
 *
 * This is also the app's one red control. Red is rationed to a loss figure, an
 * armed live agent and this — which is what makes it unmissable here without
 * ever having to shout.
 */
function Scope({ title, items }: { title: string; items: string[] }): JSX.Element {
  return (
    <div className="inset p-3">
      <div className="text-sm font-medium mb-1.5">{title}</div>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it} className="flex gap-2 text-xs text-muted leading-relaxed">
            <span aria-hidden className="mt-[7px] h-[3px] w-[3px] rounded-full bg-text-3 shrink-0" />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TradingHalt(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const refreshSettings = useApp((s) => s.refreshSettings)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; warn: boolean } | null>(null)
  const halted = settings?.tradingHalted === true

  const flip = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.tb.settings.setTradingHalt(!halted)
      setMsg({ text: r.detail, warn: false })
    } catch (e) {
      setMsg({ text: `The change did not save: ${ipcErrorText(e)}`, warn: true })
    }
    await refreshSettings()
    setBusy(false)
  }

  const icon: ReactNode = halted ? <Ban size={18} /> : <Check size={18} />
  return (
    <div className={cn('card p-4', halted && 'ring-1 ring-armed/55')}>
      <div className="flex items-center gap-3">
        <div className={cn('h-10 w-10 rounded-md flex items-center justify-center shrink-0', halted ? 'bg-armed/12 text-armed' : 'bg-surface-2 text-muted')}>{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-md font-semibold">Live buying</span>
            <span className={cn('pill', halted ? 'pill-armed' : 'pill-up')}>{halted ? 'Halted' : 'Allowed'}</span>
          </div>
          <div className="text-sm text-muted mt-0.5">{halted ? 'No agent can open a new live position.' : 'Agents can open positions inside their own guardrails.'}</div>
        </div>
        <div className="shrink-0">
          <button className={cn('btn', halted ? 'btn-outline' : 'btn-danger')} disabled={busy} onClick={() => void flip()}>
            {busy ? 'Working…' : halted ? 'Allow buying' : 'Halt buying'}
          </button>
        </div>
      </div>

      {/* The part that makes the switch honest. Both halves, always visible —
          not folded behind a tooltip someone reads after the fact. */}
      <div className="mt-3.5 grid gap-2 sm:grid-cols-2">
        <Scope title="What it stops" items={['Every live buy, on every agent', 'Even with the network down — it is checked locally before each order', 'Until you turn it back on — there is no timer']} />
        <Scope title="What it does not stop" items={['Selling — including stops and take-profits', 'Paper agents, which move no money', 'Agents thinking, watching and messaging you']} />
      </div>
      <p className="hint mt-2.5 max-w-[72ch]">
        Exits stay open on purpose: a halt that blocked selling would trap whatever you already hold, and being unable to get out is worse than the thing this guards against. To stop one agent completely, pause it.
      </p>
      {/* Always mounted, so the result of a flip is announced rather than
          arriving as a new region a screen reader never revisits. */}
      <p className={cn('text-xs flex items-start gap-1.5', msg && 'mt-2', msg?.warn ? 'text-warn' : 'text-muted')} role="status" aria-live="polite">
        {msg?.warn && <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
        {msg?.text}
      </p>
    </div>
  )
}
