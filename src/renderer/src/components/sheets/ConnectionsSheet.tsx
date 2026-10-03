import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Activity, ExternalLink, LogOut, KeyRound, Smartphone } from 'lucide-react'
import { BrandMark } from '@renderer/components/common/BrandMark'
import { Sheet } from '@renderer/components/common/Sheet'
import { SectionHead } from '@renderer/components/common/Primitives'
import { useApp } from '@renderer/store/appStore'
import { useRealtime } from '@renderer/store/realtimeStore'
import { cn, ipcErrorText } from '@renderer/lib/format'
import { robinhoodConnectionSummary } from '@shared/brokerConnection'
import { REALTIME_STREAM_FEED_LABEL, type RealtimeStreamFeed } from '@shared/realtimeAgents'

/**
 * One card per connection: a status dot, ONE sentence about where it stands,
 * and the single action that moves it. Nothing is described twice — the dot and
 * the sentence carry the state between them, so there is no badge repeating in
 * a pill what the sentence already says.
 *
 * The dot is deliberately not green: on this system green and red mean money,
 * so "working" is ink, "needs you" is the warn colour, and "not connected" is a
 * hollow ring. Colour alone never carries the state — the dot has a label, and
 * a card that needs something says so in words beside the title.
 */
function ConnCard({ icon, title, detail, ok, warn, action, children }: { icon: ReactNode; title: string; detail: string; ok: boolean; warn?: boolean; action: ReactNode; children?: ReactNode }): JSX.Element {
  const status = warn ? 'Attention' : ok ? 'Connected' : 'Not connected'
  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-md inset flex items-center justify-center shrink-0 text-muted">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="dot shrink-0"
              role="img"
              aria-label={status}
              title={status}
              style={warn ? { background: 'var(--color-warn)' } : ok ? { background: 'var(--color-text)' } : { boxShadow: 'inset 0 0 0 1.5px var(--color-text-3)' }}
            />
            <span className="text-md font-semibold tracking-[-0.01em] truncate">{title}</span>
            {/* The state in words only when it carries news; a working connection is told by the sentence below. */}
            {(!ok || warn) && <span className={cn('eyebrow shrink-0', warn && 'text-warn')}>{status}</span>}
          </div>
          <p className={cn('text-sm mt-1 leading-relaxed', warn ? 'text-warn' : 'text-muted')}>{detail}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="mt-3 space-y-2">{children}</div>}
    </div>
  )
}

/** Waiting on a browser round-trip: the same two words on every card. */
function Waiting(): JSX.Element {
  return (
    <>
      <span className="dot bg-current pulse" /> Waiting…
    </>
  )
}

export function ClaudeCard(): JSX.Element {
  const claude = useApp((s) => s.claude)
  const refresh = useApp((s) => s.refreshConnections)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const ok = Boolean(claude?.authenticated)
  return (
    <ConnCard
      icon={<BrandMark slug="claude" size={18} brand label={null} />}
      title="Claude"
      detail={claude?.detail ?? '…'}
      ok={ok}
      warn={claude?.apiKeyOverrideDetected}
      action={
        ok ? (
          <button
            className="btn btn-outline"
            onClick={async () => {
              const r = await window.tb.claude.logout()
              setMsg(r.message)
              void refresh()
            }}
          >
            <LogOut size={13} /> Sign out
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setMsg('Finish the Claude sign-in in your browser — this updates automatically.')
              const r = await window.tb.claude.login()
              setMsg(r.message)
              setBusy(false)
              void refresh()
            }}
          >
            {busy ? <Waiting /> : <><ExternalLink size={13} /> Sign in</>}
          </button>
        )
      }
    >
      {msg && <p className="hint">{msg}</p>}
      {!ok && (
        <div>
          <button className="text-xs text-muted hover:text-text inline-flex items-center gap-1" aria-expanded={showToken} onClick={() => setShowToken((v) => !v)}>
            <KeyRound size={12} /> Paste a setup token instead
          </button>
          {showToken && (
            <div className="flex gap-2 mt-2">
              <input className="input mono text-sm" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-oat…" aria-label="Claude setup token" value={token} onChange={(e) => setToken(e.target.value)} />
              <button
                className="btn btn-outline shrink-0"
                onClick={async () => {
                  const r = await window.tb.claude.saveToken(token)
                  setMsg(r.message)
                  void refresh()
                }}
              >
                Save
              </button>
            </div>
          )}
        </div>
      )}
    </ConnCard>
  )
}

/**
 * The operator's ChatGPT subscription (Plus / Pro / Team) — the Codex OAuth
 * flow on the fixed loopback port 1455. "Sign in with a code" is the fallback
 * when that port is busy (another app mid-sign-in, the Codex CLI running).
 */
export function ChatGptCard(): JSX.Element {
  const gpt = useApp((s) => s.chatgpt)
  const refresh = useApp((s) => s.refreshConnections)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [device, setDevice] = useState<{ code: string; url: string } | null>(null)
  const ok = Boolean(gpt?.authenticated)
  return (
    <ConnCard
      icon={<BrandMark slug="openai" size={18} label={null} />}
      title="ChatGPT"
      detail={gpt?.detail ?? '…'}
      ok={ok}
      warn={gpt?.apiKeyOverrideDetected}
      action={
        ok ? (
          <button
            className="btn btn-outline"
            onClick={async () => {
              const r = await window.tb.chatgpt.logout()
              setMsg(r.message)
              setDevice(null)
              void refresh()
            }}
          >
            <LogOut size={13} /> Sign out
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setDevice(null)
              setMsg('Finish the ChatGPT sign-in in your browser — this updates automatically.')
              const r = await window.tb.chatgpt.login()
              setMsg(r.message)
              setBusy(false)
              void refresh()
            }}
          >
            {busy ? <Waiting /> : <><ExternalLink size={13} /> Sign in</>}
          </button>
        )
      }
    >
      <p className="hint">Run agents on GPT models with your own ChatGPT plan — flat pricing, nothing billed per token.</p>
      {msg && <p className="hint">{msg}</p>}
      {!ok && (
        <div>
          <button
            className="text-xs text-muted hover:text-text inline-flex items-center gap-1"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const r = await window.tb.chatgpt.loginDevice()
              setBusy(false)
              if (r.ok && r.userCode && r.verificationUrl) {
                setDevice({ code: r.userCode, url: r.verificationUrl })
                setMsg('Enter the code on the page that opened; this card updates when you finish.')
              } else setMsg(r.message)
            }}
          >
            <Smartphone size={12} /> Sign in with a code instead
          </button>
          {device && (
            <div className="mt-2 flex items-center gap-2">
              <code className="inset mono text-lg tracking-[0.25em] px-3 py-1.5 select-all">{device.code}</code>
              <button className="btn btn-outline" onClick={() => void window.tb.openExternal(device.url)}>
                Open page
              </button>
            </div>
          )}
        </div>
      )}
      {gpt && !gpt.secureStorage && <p className="text-xs text-warn">OS keychain unavailable — tokens are stored obfuscated, not encrypted.</p>}
    </ConnCard>
  )
}


/**
 * The operator's own OpenRouter API key — what agents on the OpenRouter
 * provider think with, billed to their OpenRouter account. Stored encrypted on
 * this computer; the renderer only ever sees whether one is set and what the
 * last test said.
 */
export function OpenRouterCard(): JSX.Element {
  const status = useApp((s) => s.openrouter)
  const setStatus = useApp((s) => s.setOpenRouter)
  const [key, setKey] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ok = Boolean(status?.hasKey) && !status?.error
  const showForm = editing || !status?.hasKey
  const save = async (): Promise<void> => {
    if (!key.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await window.tb.openrouter.setKey(key.trim())
      setStatus(await window.tb.openrouter.testKey())
      setKey('')
      setEditing(false)
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConnCard
      icon={<BrandMark slug="openrouter" size={18} label={null} />}
      title="OpenRouter"
      detail={status?.detail ?? '…'}
      ok={ok}
      warn={Boolean(status?.error)}
      action={
        status?.hasKey && !editing ? (
          <div className="flex gap-1.5">
            <button
              className="btn btn-outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setStatus(await window.tb.openrouter.testKey().catch(() => status))
                setBusy(false)
              }}
            >
              {busy ? <Waiting /> : 'Test'}
            </button>
            <button className="btn btn-outline" onClick={() => setEditing(true)}>
              Replace
            </button>
          </div>
        ) : null
      }
    >
      <p className="hint">Run agents on any OpenRouter model with your own API key — pay per token on your OpenRouter account.</p>
      {showForm && (
        <div className="flex gap-2">
          <input
            className="input mono text-sm"
            type="password"
            autoComplete="off"
            placeholder="sk-or-…"
            aria-label="OpenRouter API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
          />
          <button className="btn btn-primary shrink-0" disabled={busy || !key.trim()} onClick={() => void save()}>
            {busy ? <Waiting /> : 'Save'}
          </button>
          {status?.hasKey && (
            <button className="btn btn-ghost shrink-0" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </div>
      )}
      {err && <p className="text-xs text-warn">{err}</p>}
      <div className="flex items-center gap-3">
        <button className="text-xs text-muted hover:text-text inline-flex items-center gap-1" onClick={() => void window.tb.openExternal('https://openrouter.ai/keys')}>
          <KeyRound size={12} /> Get a key
        </button>
        {status?.hasKey && (
          <button
            className="text-xs text-muted hover:text-down"
            onClick={async () => {
              setStatus(await window.tb.openrouter.clearKey())
              setEditing(false)
            }}
          >
            Remove key
          </button>
        )}
      </div>
    </ConnCard>
  )
}

/**
 * Robinhood: one OAuth connection held on this computer. The wording for every
 * state is `robinhoodConnectionSummary` in shared, so every surface that shows
 * the connection says the same sentence.
 */
export function RobinhoodCard(): JSX.Element {
  const rh = useApp((s) => s.robinhood)
  const refresh = useApp((s) => s.refreshConnections)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const sum = robinhoodConnectionSummary(rh)
  const connect = async (): Promise<void> => {
    setBusy(true)
    setMsg('Sign in to Robinhood in your browser and approve access.')
    const r = await window.tb.robinhood.connect()
    setMsg(r.message)
    setBusy(false)
    void refresh()
  }
  return (
    <ConnCard
      icon={<BrandMark slug="robinhood" size={18} label={null} />}
      title="Robinhood"
      detail={rh ? sum.detail : '…'}
      ok={sum.connected}
      warn={sum.warn}
      action={
        sum.action === 'disconnect' ? (
          <button
            className="btn btn-outline"
            onClick={async () => {
              await window.tb.robinhood.disconnect()
              setMsg(null)
              void refresh()
            }}
          >
            <LogOut size={13} /> Disconnect
          </button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={connect}>
            {busy ? <Waiting /> : <><ExternalLink size={13} /> {sum.actionLabel}</>}
          </button>
        )
      }
    >
      {msg && <p className="hint">{msg}</p>}
      {rh && !rh.secureStorage && <p className="text-xs text-warn">OS keychain unavailable — tokens are stored obfuscated, not encrypted.</p>}
    </ConnCard>
  )
}

/**
 * The operator's own Alpaca Market Data key. Two jobs, one key: it prices
 * PAPER agents when Robinhood is not connected, and it feeds the Real time
 * page's live tape. Stored encrypted on this computer.
 */
export function MarketDataCard(): JSX.Element {
  const stream = useRealtime((s) => s.stream)
  const refreshStream = useRealtime((s) => s.refreshStream)
  const setStreamKey = useRealtime((s) => s.setStreamKey)
  const clearStreamKey = useRealtime((s) => s.clearStreamKey)
  const [editing, setEditing] = useState(false)
  const [keyId, setKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [feed, setFeed] = useState<RealtimeStreamFeed>('iex')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    void refreshStream()
  }, [refreshStream])
  useEffect(() => {
    if (stream?.feed) setFeed(stream.feed)
  }, [stream?.feed])
  const configured = Boolean(stream?.configured)
  const showForm = editing || !configured
  const save = async (): Promise<void> => {
    if (!keyId.trim() || !secret.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await setStreamKey({ keyId: keyId.trim(), secret: secret.trim(), feed })
      setKeyId('')
      setSecret('')
      setEditing(false)
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConnCard
      icon={<Activity size={18} />}
      title="Market data (Alpaca)"
      detail={configured ? `Key saved · ${REALTIME_STREAM_FEED_LABEL[stream?.feed ?? 'iex']}. Paper agents price from it when Robinhood is not connected.` : 'Optional. Lets paper agents trade without Robinhood, and powers the Real time page.'}
      ok={configured}
      action={
        configured && !editing ? (
          <button className="btn btn-outline" onClick={() => setEditing(true)}>
            Replace
          </button>
        ) : null
      }
    >
      {showForm && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input className="input mono text-sm" autoComplete="off" aria-label="Alpaca key id" placeholder="Key id" value={keyId} onChange={(e) => setKeyId(e.target.value)} />
            <input
              className="input mono text-sm"
              type="password"
              autoComplete="off"
              aria-label="Alpaca secret"
              placeholder="Secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
          </div>
          <div className="flex gap-2">
            <select className="select text-sm" aria-label="Feed" value={feed} onChange={(e) => setFeed(e.target.value as RealtimeStreamFeed)}>
              {(Object.keys(REALTIME_STREAM_FEED_LABEL) as RealtimeStreamFeed[]).map((f) => (
                <option key={f} value={f}>
                  {REALTIME_STREAM_FEED_LABEL[f]}
                </option>
              ))}
            </select>
            <button className="btn btn-primary shrink-0" disabled={busy || !keyId.trim() || !secret.trim()} onClick={() => void save()}>
              {busy ? <Waiting /> : 'Save'}
            </button>
            {configured && (
              <button className="btn btn-ghost shrink-0" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {err && <p className="text-xs text-warn">{err}</p>}
      <div className="flex items-center gap-3">
        <button className="text-xs text-muted hover:text-text inline-flex items-center gap-1" onClick={() => void window.tb.openExternal('https://alpaca.markets/')}>
          <KeyRound size={12} /> Get a free key
        </button>
        {configured && (
          <button className="text-xs text-muted hover:text-down" onClick={() => void clearStreamKey()}>
            Remove key
          </button>
        )}
      </div>
    </ConnCard>
  )
}

export function ConnectionsSheet({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Sheet title="Connections" onClose={onClose} width={520}>
      <section>
        <SectionHead title="Models" hint="Where your agents think. Every agent runs on its own — connecting here only makes the choice available." />
        <div className="space-y-2.5">
          <ClaudeCard />
          <ChatGptCard />
          <OpenRouterCard />
        </div>
      </section>
      <section className="mt-6">
        <SectionHead title="Broker" hint="Where orders go. Paper agents can trade without it; live agents cannot." />
        <RobinhoodCard />
      </section>
      <section className="mt-6">
        <SectionHead title="Market data" hint="Optional prices for paper agents without Robinhood, and the Real time page's live tape." />
        <MarketDataCard />
      </section>
    </Sheet>
  )
}
