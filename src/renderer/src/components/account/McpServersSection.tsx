import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { ExternalLink, KeyRound, Check, AlertTriangle, Globe, Terminal } from 'lucide-react'
import { DEFAULT_TOOL_POLICY, MCP_PROVIDERS, type McpProvider, type McpProviderId, type ToolPolicy } from '@shared/mcps'
import { useApp } from '@renderer/store/appStore'
import { cn, ipcErrorText } from '@renderer/lib/format'
import { Switch } from '@renderer/components/common/Switch'
import { SectionTitle } from './SectionTitle'

/** Settings → MCP servers: the free intel MCP providers, per-provider switch + key + runtime hints. */
const RUNTIME_INSTALL = {
  uv: { label: 'uv (Python)', url: 'https://docs.astral.sh/uv/getting-started/installation/' },
  node: { label: 'Node.js (npx)', url: 'https://nodejs.org/' }
}

/**
 * The key field. The renderer never sees a stored key — `hasKey` is the only
 * thing that crosses the bridge — so "Stored" is a claim about the keychain,
 * not a masked value we are holding on screen.
 */
function KeyEditor({ p, stored, onSaved }: { p: McpProvider; stored: boolean; onSaved: () => void }): JSX.Element {
  const [editing, setEditing] = useState(!stored)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setEditing(!stored), [stored])
  const save = async (): Promise<void> => {
    if (!value.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await window.tb.mcp.setKey(p.id, value.trim())
      setValue('')
      setEditing(false)
      onSaved()
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="inset p-3 mt-3">
      <div className="flex items-center gap-2 text-xs">
        <KeyRound size={12} className="text-muted" />
        <span className="font-medium">{p.keyLabel ?? 'API key'}</span>
        {stored && !editing && (
          <span className="pill pill-up">
            <Check size={11} /> Stored
          </span>
        )}
        <span className="flex-1" />
        {p.keyUrl && (
          <button className="text-muted hover:text-text inline-flex items-center gap-1" onClick={() => void window.tb.openExternal(p.keyUrl!)}>
            Get a free key <ExternalLink size={11} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="flex gap-2 mt-2">
          <input
            className="input mono text-sm"
            type="password"
            autoComplete="off"
            aria-label={`${p.name} ${p.keyLabel ?? 'API key'}`}
            placeholder={`Paste your ${p.keyLabel ?? 'key'}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
          />
          <button className="btn btn-primary" disabled={busy || !value.trim()} onClick={() => void save()}>
            Save
          </button>
          {stored && (
            <button className="btn btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="flex gap-2 mt-2">
          <button className="btn btn-outline btn-sm" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button
            className="btn btn-ghost btn-sm text-down"
            onClick={async () => {
              setErr(null)
              try {
                await window.tb.mcp.clearKey(p.id)
                onSaved()
              } catch (e) {
                setErr(ipcErrorText(e))
              }
            }}
          >
            Remove
          </button>
        </div>
      )}
      {err && <p className="hint mt-2 text-down">{err}</p>}
      <p className="hint mt-2">Stored encrypted on this device; sent only to {p.name}.</p>
    </div>
  )
}

function ProviderCard({ p, on, hasKey, runtimeOk, onToggle, onKeyChange }: { p: McpProvider; on: boolean; hasKey: boolean; runtimeOk: boolean; onToggle: (next: boolean) => void; onKeyChange: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const needsKey = p.keyed && !hasKey
  const needsRuntime = p.transport.kind === 'stdio' && !runtimeOk
  const blocked = needsKey || needsRuntime
  const runtimeNeed = p.transport.kind === 'stdio' ? p.transport.needs : null
  const live = on && !blocked
  return (
    <div className={cn('card p-4', live && 'ring-1 ring-up/40')}>
      <div className="flex items-start gap-3">
        <div className={cn('h-10 w-10 rounded-md flex items-center justify-center shrink-0', live ? 'bg-up/12 text-up' : 'bg-surface-2 text-muted')}>{p.transport.kind === 'http' ? <Globe size={18} /> : <Terminal size={18} />}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-md font-semibold">{p.name}</span>
            <span className="pill">{p.transport.kind === 'http' ? 'Remote' : `Local · ${runtimeNeed === 'uv' ? 'uv' : 'npx'}`}</span>
            <span className="pill">{p.freeTier}</span>
            {p.defaultOn && <span className="pill pill-up">On by default</span>}
          </div>
          <div className="text-sm text-muted mt-0.5">{p.tagline}</div>
        </div>
        <Switch checked={on} onChange={onToggle} label={`Enable ${p.name}`} />
      </div>

      {on && blocked && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-warn/10 text-warn px-3 py-2 text-xs leading-relaxed">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div>
            {needsKey && <div>Switched on, but agents won&apos;t load it until you add the {p.keyLabel ?? 'API key'} below.</div>}
            {needsRuntime && runtimeNeed && (
              <div>
                Requires {RUNTIME_INSTALL[runtimeNeed].label} on this computer.{' '}
                <button className="underline" onClick={() => void window.tb.openExternal(RUNTIME_INSTALL[runtimeNeed].url)}>
                  Install
                </button>{' '}
                and restart the app.
              </div>
            )}
          </div>
        </div>
      )}

      {(on || open) && (
        <div className="mt-3">
          <ul className="text-xs grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
            {p.adds.map((a) => (
              <li key={a} className="flex gap-1.5">
                <span className="text-up">+</span>
                <span>{a}</span>
              </li>
            ))}
          </ul>
          {p.caveat && <p className="hint mt-2">{p.caveat}</p>}
          {p.keyed && <KeyEditor p={p} stored={hasKey} onSaved={onKeyChange} />}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3 text-xs text-muted">
        {!on && (
          <button className="hover:text-text" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Less' : 'What it adds'}
          </button>
        )}
        <button className="hover:text-text inline-flex items-center gap-1" onClick={() => void window.tb.openExternal(p.docsUrl)}>
          Docs <ExternalLink size={11} />
        </button>
      </div>
    </div>
  )
}

export function McpServersSection(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const mcp = useApp((s) => s.mcp)
  const updateSettings = useApp((s) => s.updateSettings)
  const refreshMcp = useApp((s) => s.refreshMcp)
  const policy: ToolPolicy = settings?.tools ?? DEFAULT_TOOL_POLICY
  const toggle = (id: McpProviderId, next: boolean): void => {
    const set = new Set(policy.mcpEnabled)
    if (next) set.add(id)
    else set.delete(id)
    void updateSettings({ tools: { ...policy, mcpEnabled: [...set] } })
  }
  const remote = MCP_PROVIDERS.filter((p) => p.transport.kind === 'http')
  const local = MCP_PROVIDERS.filter((p) => p.transport.kind === 'stdio')
  const card = (p: McpProvider): JSX.Element => (
    <ProviderCard
      key={p.id}
      p={p}
      on={policy.mcpEnabled.includes(p.id)}
      hasKey={Boolean(mcp?.keys[p.id])}
      runtimeOk={p.transport.kind === 'http' ? true : Boolean(mcp?.runtimes[p.transport.needs])}
      onToggle={(next) => toggle(p.id, next)}
      onKeyChange={() => void refreshMcp()}
    />
  )
  return (
    <>
      <SectionTitle
        title="MCP servers"
        blurb="Free, read-only servers that give every agent more to reason with — news, SEC filings, the macro calendar, sentiment. Robinhood stays the only broker. Each switch applies to all agents on their next run."
      />
      <div className="eyebrow mb-2">Remote · nothing to install</div>
      <div className="space-y-2.5">{remote.map(card)}</div>
      <div className="eyebrow mt-7 mb-2">Local · run on this computer</div>
      <p className="hint mb-3 max-w-[72ch]">
        These start as small local processes when an agent runs. They need {RUNTIME_INSTALL.uv.label} or {RUNTIME_INSTALL.node.label} installed
        {mcp ? (
          <>
            {' — detected: '}
            <span className={mcp.runtimes.uv ? 'text-up' : 'text-muted'}>uv {mcp.runtimes.uv ? '✓' : '✗'}</span>
            {', '}
            <span className={mcp.runtimes.node ? 'text-up' : 'text-muted'}>npx {mcp.runtimes.node ? '✓' : '✗'}</span>.
          </>
        ) : (
          '.'
        )}
      </p>
      <div className="space-y-2.5">{local.map(card)}</div>
    </>
  )
}
