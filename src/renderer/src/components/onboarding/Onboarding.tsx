import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { MessageSquarePlus, Check, ArrowRight, ArrowLeft, ShieldCheck, Clock, Cpu, Lock, Sparkles } from 'lucide-react'
import { BrandMark } from '@renderer/components/common/BrandMark'
import { ClaudeCard, ChatGptCard, MarketDataCard, OpenRouterCard, RobinhoodCard } from '@renderer/components/sheets/ConnectionsSheet'
import { useApp } from '@renderer/store/appStore'
import { useRealtime } from '@renderer/store/realtimeStore'
import { cn } from '@renderer/lib/format'
import { ROBINHOOD_OPTIONAL_HINT } from '@shared/marketData'
import { AGENT_TEMPLATES } from '@shared/templates'
import { describeSchedule } from '@shared/schedule'
import { AgentAvatar } from '@renderer/components/common/AgentAvatar'

/**
 * First run. A model comes first — an agent needs something to think with:
 * your Claude login, your ChatGPT subscription, your own OpenRouter key, or a
 * local GGUF model (Settings → Local models). Robinhood is next because it is
 * what gives an agent prices and where live orders go; a free Alpaca market-data
 * key is the alternative for paper trading without a broker.
 *
 * One idea per screen. The stepper at the top is CLICKABLE rather than a bare
 * progress bar: nothing here is a gate, so someone who only wants the last step
 * can take it, and "Skip for now" is on every screen.
 */
/** The starters shown on the last onboarding step — one per style, in this order. */
const FIRST_TEMPLATES = ['weekly-dca', 'overnight-hold', 'morning-brief'] as const

export function Onboarding({ onDone }: { onDone: () => void }): JSX.Element {
  const rh = useApp((s) => s.robinhood)
  const claude = useApp((s) => s.claude)
  const chatgpt = useApp((s) => s.chatgpt)
  const openrouter = useApp((s) => s.openrouter)
  const settings = useApp((s) => s.settings)
  const openSheet = useApp((s) => s.openSheet)
  const openAccount = useApp((s) => s.openAccount)
  const feedOn = useRealtime((s) => Boolean(s.stream?.configured))
  const [step, setStep] = useState(0)
  const rhOk = Boolean(rh?.connected)
  const localModel = Boolean(settings?.localModel.modelId)
  const hasModel = Boolean(claude?.authenticated || chatgpt?.authenticated || openrouter?.hasKey || localModel)
  // A paper agent needs prices: Robinhood, or the operator's own market-data key.
  const hasPrices = rhOk || feedOn
  const ready = hasModel
  const done = [hasModel, hasPrices].filter(Boolean).length

  const steps: { key: string; short: string; icon: ReactNode; title: string; hint: string; done: boolean; body: ReactNode }[] = [
    {
      key: 'model',
      short: 'Model',
      icon: <Sparkles size={15} />,
      title: 'Choose what your agents think with',
      hint: 'Connect at least one. Your Claude or ChatGPT subscription runs agents at flat pricing; an OpenRouter key gives you any model, paid per token; a local GGUF model runs free and offline on this GPU. Credentials stay encrypted on this computer.',
      done: hasModel,
      body: (
        <div className="space-y-2.5">
          <ClaudeCard />
          <ChatGptCard />
          <OpenRouterCard />
          <button type="button" className="card w-full p-4 text-left flex items-center gap-3 hover:ring-1 hover:ring-hairline-strong" onClick={() => openAccount('local')}>
            <span className="h-9 w-9 rounded-md inset flex items-center justify-center shrink-0 text-muted">
              <Cpu size={18} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-md font-semibold">Local GPU</span>
              <span className="block text-sm text-muted">{localModel ? 'A default local model is set.' : 'Point the app at a folder of GGUF models in Settings → Local models.'}</span>
            </span>
            <ArrowRight size={14} className="text-muted" />
          </button>
        </div>
      )
    },
    {
      key: 'broker',
      short: 'Broker',
      icon: <BrandMark slug="robinhood" size={15} label={null} />,
      title: 'Connect Robinhood',
      hint: `This is where your agents get prices, and where live orders go. Paper mode uses it for real quotes without touching your money. ${ROBINHOOD_OPTIONAL_HINT}`,
      done: hasPrices,
      body: (
        <div className="space-y-2.5">
          <RobinhoodCard />
          <MarketDataCard />
        </div>
      )
    },
    {
      key: 'agent',
      short: 'First agent',
      icon: <MessageSquarePlus size={15} />,
      title: 'Create your first agent',
      hint: 'Start from a template — illustrations, not recommendations; every field stays editable and it starts in paper — or describe the job in your own words and let the agent propose the schedule and guardrails.',
      done: false,
      body: (
        <>
          {/* Three starters spanning the catalog's styles, then the blank sheet.
              Same catalog as the New-agent strip (shared/templates.ts), so the
              first agent is a filled-in sheet rather than an empty textarea. */}
          <div className="grid grid-cols-3 gap-2 mb-2.5">
            {FIRST_TEMPLATES.map((id) => AGENT_TEMPLATES.find((t) => t.id === id)).map(
              (t) =>
                t && (
                  <button key={t.id} type="button" disabled={!ready} title={t.task} className="card p-3 text-left hover:ring-1 hover:ring-hairline-strong disabled:opacity-50" onClick={() => {
                    onDone()
                    openSheet({ kind: 'new', templateId: t.id })
                  }}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <AgentAvatar icon={t.icon} color={t.color} size={24} />
                      <span className="text-sm font-medium truncate">{t.name}</span>
                    </div>
                    <div className="text-xs text-muted leading-snug line-clamp-2">{t.tagline}</div>
                    <div className="text-2xs text-text-3 mt-1.5 truncate">
                      {describeSchedule(t.schedule)}
                      {t.autonomous ? '' : ' · asks first'}
                    </div>
                  </button>
                )
            )}
          </div>
          <div className="card p-4 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-base font-medium">{ready ? 'Or start from a blank sheet' : 'Connect a model first (step 1) to start'}</div>
              <div className="text-sm text-muted truncate">“Buy $500 of MU at 3:58 PM ET every day and sell it at 9:31 AM ET the next morning.”</div>
            </div>
            <button
              className="btn btn-primary btn-lg"
              disabled={!ready}
              onClick={() => {
                onDone()
                openSheet({ kind: 'new' })
              }}
            >
              New agent <ArrowRight size={14} />
            </button>
          </div>
        </>
      )
    }
  ]
  const cur = steps[step]
  const last = step === steps.length - 1

  return (
    <div className="h-full w-full flex bg-bg">
      {/* Brand panel. Every colour is a token, so the first screen someone sees
          is already in the theme the rest of the app will be in. */}
      <aside className="panel hidden md:flex w-[360px] lg:w-[420px] shrink-0 flex-col justify-between p-10 hair-r">
        <div className="drag h-4" />
        <div>
          <div className="flex items-center gap-2.5 mb-8">
            <div className="h-9 w-9 rounded-md bg-accent text-accent-fg flex items-center justify-center">
              <MessageSquarePlus size={18} />
            </div>
            <span className="text-xl font-semibold tracking-tight">Robinhood Trading Agents</span>
          </div>
          <h1 className="text-2xl leading-[1.2] font-semibold tracking-[-0.02em]">Every trading agent is a message thread.</h1>
          <p className="mt-4 text-muted text-base leading-relaxed">
            Give it one job in plain English. It runs on a schedule on this computer, trades through your Robinhood account, and reports back like a colleague texting you.
          </p>
          <ul className="mt-8 space-y-3.5">
            <Feature icon={<Clock size={15} />} text="“Buy $500 of MU at 3:58 PM, sell at 9:31 AM” — scheduled to the minute, ET." />
            <Feature icon={<ShieldCheck size={15} />} text="The engine places orders after your guardrails. Paper by default; live must be armed." />
            <Feature icon={<Lock size={15} />} text="Runs entirely on this computer. Your credentials, agents and history never leave it." />
            <Feature icon={<Cpu size={15} />} text="Think with your own Claude, ChatGPT, OpenRouter key — or a local model on your GPU." />
          </ul>
        </div>
        <p className="text-xs text-text-3">Not financial advice. Trading involves risk.</p>
      </aside>

      {/* Steps */}
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="drag h-10 shrink-0" />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[620px] mx-auto px-8 pb-10">
            <p className="text-xs text-muted">
              <span className="nums">{done}</span>/2 steps done · everything stays on this computer
            </p>

            {/* Clickable stepper — a map of the flow, not a gate. */}
            <nav className="mt-3 flex items-center gap-1.5" aria-label="Setup steps">
              {steps.map((s, i) => (
                <button
                  key={s.key}
                  type="button"
                  aria-current={i === step ? 'step' : undefined}
                  onClick={() => setStep(i)}
                  className={cn('flex items-center gap-1.5 h-7 px-2 rounded-sm text-xs transition-colors', i === step ? 'bg-surface-2 text-text font-medium' : 'text-muted hover:text-text')}
                >
                  {/* Filled = done, ringed = you are here, flat = not yet — and
                      all three in the accent. Green is money (rule 2): spent on
                      a checkmark it stops being able to say "this made a
                      profit", and the check glyph already says "done". */}
                  <span
                    className={cn(
                      'h-4 w-4 rounded-full flex items-center justify-center text-2xs shrink-0',
                      s.done ? 'bg-accent text-accent-fg' : i === step ? 'ring-1 ring-accent text-accent' : 'bg-surface-3 text-muted'
                    )}
                  >
                    {s.done ? <Check size={10} /> : <span className="nums">{i + 1}</span>}
                  </span>
                  {s.short}
                </button>
              ))}
            </nav>

            <div key={cur.key} className="mt-7 fade-in">
              <div className="flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-md inset text-muted flex items-center justify-center shrink-0">{cur.icon}</span>
                <h2 className="text-xl font-semibold tracking-[-0.01em]">{cur.title}</h2>
              </div>
              <p className="text-sm text-muted mt-2 mb-4 max-w-[64ch] leading-relaxed">{cur.hint}</p>
              {cur.body}
            </div>

            <div className="mt-8 pt-5 hair-t flex items-center gap-2">
              <button className="text-xs text-muted hover:text-text" onClick={onDone}>
                Skip for now
              </button>
              <span className="flex-1" />
              {step > 0 && (
                <button className="btn btn-ghost" onClick={() => setStep((s) => s - 1)}>
                  <ArrowLeft size={14} /> Back
                </button>
              )}
              {!last && (
                <button className="btn btn-outline" onClick={() => setStep((s) => s + 1)}>
                  {cur.done ? 'Next' : 'Skip this step'} <ArrowRight size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

function Feature({ icon, text }: { icon: ReactNode; text: string }): JSX.Element {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden className="mt-px h-6 w-6 rounded-sm inset flex items-center justify-center shrink-0 text-muted">
        {icon}
      </span>
      <span className="text-sm text-muted leading-snug">{text}</span>
    </li>
  )
}
