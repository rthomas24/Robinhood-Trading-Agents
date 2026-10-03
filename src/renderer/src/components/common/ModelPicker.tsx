import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Lock } from 'lucide-react'
import { CHATGPT_MODELS, CLAUDE_MODELS, OPENROUTER_MODELS, defaultModelFor, VENDOR_LABEL, type Effort, type ModelChoice, type ModelOption, type ModelVendor } from '@shared/agents'
import { Segmented } from './Sheet'
import { AnchoredMenu, MenuRow, ReadyDot } from './ProviderPicker'
import { useApp } from '@renderer/store/appStore'
import { cn } from '@renderer/lib/format'

/**
 * Vendor + model + effort picker. Claude = the operator's Claude account (pick
 * a Claude model); ChatGPT = their ChatGPT subscription; OpenRouter = any
 * OpenRouter model on their own API key (pick a suggestion or type any id);
 * Local GPU = a model on this computer. Pass `lockVendor` to pin the vendor.
 */

/** One line per service, shown under its name in the vendor menu. */
const VENDOR_DETAIL: Record<ModelVendor, string> = {
  claude: 'Your Claude account',
  chatgpt: 'Your ChatGPT subscription — Plus / Pro / Team',
  openrouter: 'Any OpenRouter model, on your own API key',
  local: 'A model running on this computer (Settings → Local models)'
}

const MENU_W = 300

export function ModelPicker({ value, onChange, lockVendor, compact, hideVendor }: { value: ModelChoice; onChange: (m: ModelChoice) => void; lockVendor?: ModelVendor; compact?: boolean; /** The vendor is implied by a ProviderPicker above — show only model + effort. */ hideVendor?: boolean }): JSX.Element {
  const claude = useApp((s) => s.claude)
  const chatgpt = useApp((s) => s.chatgpt)
  const openrouter = useApp((s) => s.openrouter)
  const local = useApp((s) => s.local)
  const vendor = lockVendor ?? value.vendor

  useEffect(() => {
    if (lockVendor && value.vendor !== lockVendor) onChange({ ...defaultModelFor(lockVendor), effort: value.effort })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockVendor])

  const setVendor = (v: ModelVendor): void => {
    if (v === value.vendor) return
    onChange({ ...defaultModelFor(v), effort: value.effort })
  }

  /** Whether each service could actually run this agent — the dot in the menu. */
  const vendorReadyOf = (v: ModelVendor): boolean =>
    v === 'claude' ? Boolean(claude?.authenticated) : v === 'chatgpt' ? Boolean(chatgpt?.authenticated) : v === 'local' ? Boolean(local?.models.length) || !local : Boolean(openrouter?.hasKey)
  const vendorReady = vendorReadyOf(vendor)

  const [customOpen, setCustomOpen] = useState(false)
  const [customId, setCustomId] = useState('')
  const [vendorOpen, setVendorOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const vendorRef = useRef<HTMLButtonElement>(null)
  const modelRef = useRef<HTMLButtonElement>(null)
  const closeVendor = useCallback(() => setVendorOpen(false), [])
  const closeModel = useCallback(() => setModelOpen(false), [])

  // A local model is picked once, by file, in Settings → Local models; every
  // other vendor has models to choose from (OpenRouter also takes any id).
  const list: ModelOption[] | null = vendor === 'claude' ? CLAUDE_MODELS : vendor === 'chatgpt' ? CHATGPT_MODELS : vendor === 'openrouter' ? OPENROUTER_MODELS : null
  const commitCustom = (): void => {
    const id = customId.trim()
    if (id && id !== value.id) onChange({ ...value, id })
    setCustomOpen(false)
  }
  // A model id we don't recognise still has to be selectable and visible — an
  // agent may carry one this build has never heard of.
  const known = list?.find((m) => m.id === value.id)
  const modelName = known?.label ?? value.id

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        {hideVendor ? null : lockVendor ? (
          <span className="pill h-7 px-2.5">
            <Lock size={11} /> {VENDOR_LABEL[lockVendor]}
          </span>
        ) : (
          <>
            <button
              ref={vendorRef}
              type="button"
              aria-haspopup="listbox"
              aria-expanded={vendorOpen}
              onClick={() => setVendorOpen((v) => !v)}
              title={VENDOR_DETAIL[value.vendor]}
              className={cn('inline-flex items-center gap-2 rounded-md bg-surface hover:bg-surface-2 transition-colors select-none h-8 px-2.5 text-base ring-1 ring-hairline-strong', vendorOpen && 'bg-surface-2')}
            >
              <span className="font-medium">{VENDOR_LABEL[value.vendor]}</span>
              <ReadyDot ready={vendorReadyOf(value.vendor)} />
              <ChevronDown size={13} className={cn('text-muted transition-transform duration-[var(--dur-fast)]', vendorOpen && 'rotate-180')} />
            </button>
            <AnchoredMenu open={vendorOpen} anchor={vendorRef} onClose={closeVendor} width={MENU_W} estHeight={4 * 46 + 16} label="Model provider">
              {(['claude', 'chatgpt', 'openrouter', 'local'] as ModelVendor[]).map((v) => (
                <MenuRow
                  key={v}
                  title={VENDOR_LABEL[v]}
                  detail={VENDOR_DETAIL[v]}
                  selected={v === value.vendor}
                  onSelect={() => {
                    setVendor(v)
                    setVendorOpen(false)
                  }}
                  right={v === value.vendor ? <Check size={15} className="text-accent shrink-0" /> : <ReadyDot ready={vendorReadyOf(v)} />}
                />
              ))}
            </AnchoredMenu>
          </>
        )}
        <Segmented<Effort>
          value={value.effort}
          onChange={(effort) => onChange({ ...value, effort })}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]}
        />
      </div>
      {list && (
        <>
          <button
            ref={modelRef}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={modelOpen}
            onClick={() => setModelOpen((v) => !v)}
            className={cn('inline-flex items-center gap-2 rounded-md bg-surface hover:bg-surface-2 transition-colors select-none max-w-full px-2.5 text-base ring-1 ring-hairline-strong', compact ? 'h-8' : 'h-9', modelOpen && 'bg-surface-2')}
          >
            <span className="font-medium truncate">{modelName}</span>
            {known && <span className="text-xs text-muted truncate">{known.hint}</span>}
            <ChevronDown size={13} className={cn('text-muted shrink-0 transition-transform duration-[var(--dur-fast)]', modelOpen && 'rotate-180')} />
          </button>
          <AnchoredMenu open={modelOpen} anchor={modelRef} onClose={closeModel} width={MENU_W} estHeight={(list.length + 2) * 46 + 16} label="Model">
            {list.map((m) => (
              <MenuRow
                key={m.id}
                title={m.label}
                detail={m.hint}
                selected={m.id === value.id}
                onSelect={() => {
                  onChange({ ...value, id: m.id })
                  setModelOpen(false)
                }}
                right={m.id === value.id ? <Check size={15} className="text-accent shrink-0" /> : undefined}
              />
            ))}
            {!known && (
              <MenuRow
                title={value.id}
                detail="Set on this agent — not one of the suggested models"
                selected
                onSelect={() => setModelOpen(false)}
                right={<Check size={15} className="text-accent shrink-0" />}
              />
            )}
            {vendor === 'openrouter' && (
              <MenuRow
                title="Another model…"
                detail="Any OpenRouter model id, e.g. provider/model-name"
                selected={false}
                onSelect={() => {
                  setCustomId(known ? '' : value.id)
                  setCustomOpen(true)
                  setModelOpen(false)
                }}
              />
            )}
          </AnchoredMenu>
          {vendor === 'openrouter' && customOpen && (
            <div className="flex gap-2 max-w-[420px]">
              <input
                className="input mono text-sm"
                autoFocus
                placeholder="provider/model-name"
                aria-label="OpenRouter model id"
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitCustom()
                  if (e.key === 'Escape') setCustomOpen(false)
                }}
              />
              <button type="button" className="btn btn-outline shrink-0" disabled={!customId.trim()} onClick={commitCustom}>
                Use
              </button>
            </div>
          )}
        </>
      )}
      {!vendorReady && (
        <p className="text-xs text-warn">
          {vendor === 'claude'
            ? 'Claude is not connected — sign in to Claude in Connections before this agent runs.'
            : vendor === 'chatgpt'
              ? 'ChatGPT is not connected — sign in with your ChatGPT subscription in Connections before this agent runs.'
            : vendor === 'local'
              ? 'No GGUF models found yet — choose your models folder in Settings → Local models before this agent runs.'
              : 'No OpenRouter API key yet — add yours in Connections before this agent runs.'}
        </p>
      )}
    </div>
  )
}
