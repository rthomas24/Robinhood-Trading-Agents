import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link2, Server, SlidersHorizontal, Cpu, ShieldAlert } from 'lucide-react'
import { BrandMark } from '@renderer/components/common/BrandMark'
import { useApp, type AccountSection } from '@renderer/store/appStore'
import { cn } from '@renderer/lib/format'
import { useIndicator } from '@renderer/lib/indicator'
import { ChatGptCard, ClaudeCard, MarketDataCard, OpenRouterCard, RobinhoodCard } from '@renderer/components/sheets/ConnectionsSheet'
import { themeById } from '@shared/themes'
import { ThemePicker } from './ThemePicker'
import { ModelPicker } from '@renderer/components/common/ModelPicker'
import { ProviderPicker } from '@renderer/components/common/ProviderPicker'
import { PROVIDER_HINT, PROVIDER_LABEL } from '@shared/provider'
import { SectionTitle } from './SectionTitle'
import { Group, Row } from '@renderer/components/common/Settings'
import { TradingHalt } from './TradingHalt'
import { LocalModelsSection } from './LocalModelsSection'
import { McpServersSection } from './McpServersSection'
import { RobinhoodToolsSection } from './RobinhoodToolsSection'

/**
 * Settings: the page for everything that applies to every agent — connections,
 * trading safety, local models, MCP servers, Robinhood tools, preferences. Each
 * section is its own component; this file is the shell + nav. Everything here
 * is stored on this computer.
 */
type Section = AccountSection

const SECTIONS: { id: Section; label: string; icon: ReactNode; render: () => JSX.Element }[] = [
  { id: 'connections', label: 'Connections', icon: <Link2 size={15} />, render: () => <ConnectionsSection /> },
  { id: 'safety', label: 'Trading safety', icon: <ShieldAlert size={15} />, render: () => <SafetySection /> },
  { id: 'local', label: 'Local models', icon: <Cpu size={15} />, render: () => <LocalModelsSection /> },
  { id: 'mcp', label: 'MCP servers', icon: <Server size={15} />, render: () => <McpServersSection /> },
  { id: 'robinhood', label: 'Robinhood tools', icon: <BrandMark slug="robinhood" size={15} label={null} />, render: () => <RobinhoodToolsSection /> },
  { id: 'preferences', label: 'Preferences', icon: <SlidersHorizontal size={15} />, render: () => <PreferencesSection /> }
]

function ConnectionsSection(): JSX.Element {
  return (
    <>
      <SectionTitle
        title="Connections"
        blurb="The model providers your agents think with, the broker they trade through, and optional market data. Every credential is your own and stays encrypted on this computer."
      />
      <div className="space-y-2.5">
        <ClaudeCard />
        <ChatGptCard />
        <OpenRouterCard />
        <RobinhoodCard />
        <MarketDataCard />
      </div>
    </>
  )
}

function SafetySection(): JSX.Element {
  return (
    <>
      <SectionTitle
        title="Trading safety"
        blurb="Controls that apply to every agent at once. Per-agent limits — allocation, order caps, the daily loss breaker — live in each agent's own settings."
      />
      <TradingHalt />
    </>
  )
}

function PreferencesSection(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const setTheme = useApp((s) => s.setTheme)
  const updateSettings = useApp((s) => s.updateSettings)
  const setDefaultProvider = useApp((s) => s.setDefaultProvider)
  const theme = settings?.theme ?? 'light'
  const model = settings?.defaultModel
  const provider = settings?.defaultProvider ?? 'claude'
  return (
    <>
      <SectionTitle title="Preferences" blurb="Appearance and the defaults a new agent starts with." />
      <Group title="Appearance">
        <Row
          title="Theme"
          hint={
            <>
              Currently <span className="text-text font-medium">{themeById(theme).name}</span>. The status-bar toggle flips between a theme and its light/dark sibling.
            </>
          }
          stack
        >
          <ThemePicker value={theme} onChange={(v) => void setTheme(v)} />
        </Row>
      </Group>
      <Group title="New agents" hint="Only seeds new agents — every existing agent keeps its own provider (Agent settings → Runs on).">
        <Row title="Runs on" hint={`${PROVIDER_LABEL[provider]} — ${PROVIDER_HINT[provider]}`}>
          <ProviderPicker value={provider} onChange={(p) => void setDefaultProvider(p)} />
        </Row>
        <Row title="Default model" hint="Model and effort within that provider; change per agent any time." stack>
          {model && <ModelPicker value={model} onChange={(m) => void updateSettings({ defaultModel: m })} lockVendor={provider} hideVendor compact />}
        </Row>
      </Group>
    </>
  )
}

export function AccountPage(): JSX.Element {
  const portfolioOpen = useApp((s) => s.portfolioOpen)
  const requested = useApp((s) => s.accountSection)
  const [section, setSection] = useState<Section>(requested?.id ?? 'connections')
  // A caller asked for a section ("Set up" on Local GPU) — go there, even when
  // Settings is already open on another one.
  useEffect(() => {
    if (requested) setSection(requested.id)
  }, [requested])
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const { container, style } = useIndicator(section, 'y')
  return (
    <section className="flex-1 min-w-0 h-full flex flex-col bg-bg">
      <header className="drag h-[var(--h-header)] shrink-0 flex items-center gap-3 px-5 hair-b">
        <div className="flex-1 min-w-0 no-drag">
          <div className="text-lg font-semibold tracking-[-0.01em] leading-tight">Settings</div>
          <div className="text-xs text-muted">Everything that applies to every agent — stored on this computer</div>
        </div>
        <div aria-hidden className="shrink-0" style={{ width: portfolioOpen ? 0 : 'var(--wco-pad, 0px)' }} />
      </header>
      <div className="flex-1 min-h-0 flex">
        {/* One highlight slides between sections rather than each row painting
            its own — see useIndicator. */}
        <nav ref={container} className="panel relative w-[200px] shrink-0 py-3 px-2.5 space-y-px hair-r overflow-y-auto" aria-label="Settings sections">
          <span aria-hidden className="absolute left-2.5 right-2.5 top-0 rounded-md bg-surface-2" style={style} />
          {SECTIONS.map((s) => {
            const on = section === s.id
            return (
              <button
                key={s.id}
                data-key={s.id}
                aria-current={on ? 'page' : undefined}
                onClick={() => setSection(s.id)}
                className={cn('row relative z-10 w-full flex items-center gap-2.5 rounded-md px-2.5 h-[var(--h-row)] text-base text-left', on ? 'text-text font-medium' : 'text-muted hover:text-text')}
              >
                <span className={cn('shrink-0', on ? 'text-text' : 'text-text-3')}>{s.icon}</span>
                <span className="truncate">{s.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div key={section} className="max-w-[720px] px-10 py-9 fade-in">
            {current.render()}
          </div>
        </div>
      </div>
    </section>
  )
}
