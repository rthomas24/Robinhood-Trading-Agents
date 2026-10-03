import type { JSX, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Check, Wallet, RefreshCw, ChevronDown, LayoutGrid } from 'lucide-react'
import type { AccountSnapshot } from '@shared/ipc'
import { activeTasks, isAutonomous, AGENT_COLORS, AGENT_ICONS, agentCapMessage, agentSlotBlocked, countActiveAgents, DEFAULT_ALLOCATION_USD, DEFAULT_MODEL, goalRealism, goalRealismLine, MAX_ACTIVE_AGENTS, type AgentColor, type AgentIcon, type Guardrails, type Mode, type ModelChoice, type RetirementPolicy, type Schedule } from '@shared/agents'
import { suggestName } from '@shared/createAgent'
import { AGENT_TEMPLATES, type AgentTemplate } from '@shared/templates'
import { EARNINGS_POP, PLAYBOOK_LABEL, earningsPopSchedule, type Playbook } from '@shared/earningsPlaybook'
import { describeSchedule } from '@shared/schedule'
import { etClock, etDateTime } from '@shared/marketTime'
import { Sheet, Segmented } from '@renderer/components/common/Sheet'
import { ModelPicker } from '@renderer/components/common/ModelPicker'
import { AgentAvatar, COLORS } from '@renderer/components/common/AgentAvatar'
import { ScheduleForm } from './ScheduleForm'
import { TemplateGallery } from './TemplateGallery'
import { useApp } from '@renderer/store/appStore'
import { PROVIDER_HINT, PROVIDER_LABEL, providerOf, providerTarget, type Provider } from '@shared/provider'
import { ALLOCATION_NO_BROKER_HINT, paperModeHint } from '@shared/marketData'
import { liveAllocationVerdict, liveRoom, liveRoomLabel } from '@shared/liveAllocation'
import { ProviderPicker, useProviderReadiness } from '@renderer/components/common/ProviderPicker'
import { Amount, SectionHead, StatTile } from '@renderer/components/common/Primitives'
import { GroupSelect } from '@renderer/components/common/GroupSelect'
import { cn, money, ipcErrorText } from '@renderer/lib/format'

/** The floor the allocation field's `min={1}` used to hold; arrow-key stepping and the refusal below share it. */
const ALLOC_MIN = 1

/**
 * `initialDuplicateOf`: one of this account's agents — the sheet fills from its FULL config
 * (allocation, caps, finish line included; mode back to paper).
 * `initialTemplateId`: a starter picked elsewhere (onboarding) — applied as if its card were clicked.
 */
export function NewAgentSheet({ onClose, initialTemplateId, initialDuplicateOf, initialMode }: { onClose: () => void; initialTemplateId?: string; initialDuplicateOf?: string; initialMode?: Mode }): JSX.Element {
  const rh = useApp((s) => s.robinhood)
  // The operator's own market-data key prices paper agents without Robinhood.
  const feedOn = useApp((s) => Boolean(s.marketData?.configured))
  const settings = useApp((s) => s.settings)
  const agents = useApp((s) => s.agents)
  const select = useApp((s) => s.select)
  const activeCount = countActiveAgents(Object.values(agents))
  const [name, setName] = useState('')
  // The status-bar switcher seeds which service this agent runs on; the model follows the provider.
  const [provider, setProvider] = useState<Provider>(settings?.defaultProvider ?? 'claude')
  const [model, setModel] = useState<ModelChoice>(() => providerTarget(settings?.defaultProvider ?? 'claude', settings?.defaultModel ?? DEFAULT_MODEL).model)
  // The one ceiling: MAX_ACTIVE_AGENTS non-retired agents on this computer.
  const atCap = activeCount >= MAX_ACTIVE_AGENTS
  const pickProvider = (p: Provider): void => {
    setProvider(p)
    setModel(providerTarget(p, model).model)
  }
  const readiness = useProviderReadiness()
  const [icon, setIcon] = useState<AgentIcon>('donut')
  const [color, setColor] = useState<AgentColor>('blue')
  /** The colour/shape grid is a preference, not a decision — it opens on ask. */
  // Open from the start: picking a face is part of making an agent, not a
  // setting to go looking for.
  const [lookOpen, setLookOpen] = useState(true)
  /** Optional: which section of the list the new agent is filed under. Layout, not config — applied by id once the agent exists. */
  const [groupId, setGroupId] = useState<string | null>(null)
  const layout = useApp((s) => s.layout)
  const assignAgentToGroup = useApp((s) => s.assignAgentToGroup)
  const [task, setTask] = useState('')
  // Paper unless the operator arrived from the sidebar's Live filter — the one
  // place a "New live agent" intent is already stated. Templates and imports
  // still put the sheet back in paper, as they always have.
  const [mode, setMode] = useState<Mode>(initialMode ?? 'paper')
  const [autonomous, setAutonomous] = useState(true)
  const lock = readiness[provider].locked
  const brokerReady = Boolean(rh?.connected)
  const [planMode, setPlanMode] = useState<'ai' | 'manual'>('ai')
  const [schedule, setSchedule] = useState<Schedule>({ kind: 'times', times: ['09:31'], days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], tradingDaysOnly: true })
  const [alloc, setAllocNumber] = useState(DEFAULT_ALLOCATION_USD)
  // What the field SHOWS is the text the operator typed, not the number it
  // parses to: binding a number meant clearing the box snapped it to "0" and
  // typing 400 produced "0400". Presets and fills set both through `setAlloc`.
  const [allocText, setAllocText] = useState(String(DEFAULT_ALLOCATION_USD))
  const setAlloc = (n: number): void => {
    setAllocNumber(n)
    setAllocText(n > 0 ? String(n) : '')
  }
  // Thousands separators are added for DISPLAY only (`groupDigits`), so the
  // caret has to be put back by counting digits rather than characters — a
  // comma appearing to its left would otherwise shunt it a place.
  const allocRef = useRef<HTMLInputElement>(null)
  const caretDigits = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = allocRef.current
    const want = caretDigits.current
    caretDigits.current = null
    if (!el || want === null || document.activeElement !== el) return
    let seen = 0
    let i = 0
    for (; i < el.value.length && seen < want; i++) if (el.value.charCodeAt(i) >= 48 && el.value.charCodeAt(i) <= 57) seen++
    el.setSelectionRange(i, i)
  }, [allocText])
  const realism = useMemo(() => goalRealism(task, alloc), [task, alloc])
  const [acct, setAcct] = useState<AccountSnapshot | null>(null)
  const [acctErr, setAcctErr] = useState<string | null>(null)
  // What is genuinely free for THIS agent: buying power minus what the other
  // live agents already hold (shared/liveAllocation.ts — the IPC gate reads
  // the same rule, so the sheet never offers what the engine will refuse).
  const room = useMemo(() => (acct ? liveRoom(acct.buyingPower, Object.values(agents)) : null), [acct, agents])
  const liveVerdict = mode === 'live' && room ? liveAllocationVerdict(room, alloc) : null

  /**
   * Why Create is blocked right now (also the button tooltip); null = not
   * blocked. Same rules + wording as the IPC gate: there must be room for an
   * agent, and the provider must be ready (signed in, a key stored, or a local
   * model picked). The stored default may be unready, so this is checked on the
   * way in, not only on submit.
   */
  const blockReason = ((): string | null => {
    // ONE rule, shared with the IPC gate and the sidebar.
    const slot = agentSlotBlocked(activeCount)
    if (slot) return slot
    if (lock === 'signin') return `Sign in to ${PROVIDER_LABEL[provider]} (Connections) before creating an agent that runs on it.`
    if (lock === 'key') return 'Add your OpenRouter API key (Connections) before creating an agent that runs on it.'
    if (lock === 'setup') return 'Pick a default model in Settings → Local models before running agents on the Local GPU.'
    // Real money on an account other live agents already draw from.
    if (liveVerdict && !liveVerdict.ok) return liveVerdict.reason
    return null
  })()
  const [acctLoading, setAcctLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [profitTarget, setProfitTarget] = useState('')
  const [maxLoss, setMaxLoss] = useState('')
  const [todayOnly, setTodayOnly] = useState(false)
  /** The starter this sheet was filled from, if any — kept only to show its risk note and highlight the card. */
  const [templateId, setTemplateId] = useState<string | null>(null)
  const template = templateId ? AGENT_TEMPLATES.find((t) => t.id === templateId) : undefined
  /**
   * A special mode the engine runs (all-in earnings). Carried from a template
   * or a duplicate; it owns the schedule and the sizing, so while it is set the
   * schedule section shows the mode's cycle instead of a form, and Create sends
   * it for `configFromCreateRequest` to lay the mode's fence over the form's.
   */
  const [playbook, setPlaybook] = useState<Playbook | undefined>(undefined)
  /** The whole catalog in a modal over the sheet — the strip shows a row, this shows what each one does. */
  const [galleryOpen, setGalleryOpen] = useState(false)

  /**
   * A template fills every field a first-timer would otherwise have to invent
   * — name, look, task, the schedule the task implies, act-or-ask — and
   * switches the schedule to "Set manually" so what it chose is visible and
   * editable rather than re-derived by a plan run. Nothing is created here.
   * It also puts the sheet back in PAPER: a template is a starting point, and
   * one that inherited Live from whatever the sheet showed a moment earlier
   * would be the single field the operator never chose.
   */
  const applyTemplate = (t: AgentTemplate): void => {
    setTemplateId(t.id)
    setName(t.name)
    setIcon(t.icon)
    setColor(t.color)
    setTask(t.task)
    setSchedule(t.schedule)
    setPlanMode('manual')
    setAutonomous(t.autonomous)
    setMode('paper')
    setGuardrails(undefined)
    setPlaybook(t.playbook)
  }

  /** A guardrails PATCH laid over the allocation's defaults at Create (a duplicate carries the source's). */
  const [guardrails, setGuardrails] = useState<Partial<Guardrails> | undefined>(undefined)
  /** What a duplicate filled the sheet from, said once under the template strip. */
  const [fillNote, setFillNote] = useState<string | null>(null)
  /**
   * Duplicate: a copy of one of OUR agents. Unlike an import, the source is
   * trusted and its numbers are ours, so the allocation, every guardrail and
   * the profit/loss finish line come across. Mode still starts in PAPER (a
   * copy that woke up live and armed would be the one field nobody chose),
   * a dated deadline is not copied (it belongs to the original's engagement).
   */
  useEffect(() => {
    const src = initialDuplicateOf ? agents[initialDuplicateOf] : undefined
    if (!src) return
    const cfg = src.config
    const [first, ...rest] = activeTasks(cfg)
    setTemplateId(null)
    setName(`${cfg.name} copy`)
    setIcon(cfg.icon)
    setColor(cfg.color)
    setTask(rest.length ? `${first?.text ?? cfg.task}\n\nAlso: ${rest.map((t) => t.text).join(' · ')}` : (first?.text ?? cfg.task))
    setSchedule(cfg.schedule)
    setPlanMode('manual')
    setAutonomous(isAutonomous(cfg))
    setMode('paper')
    setPlaybook(cfg.playbook)
    setProvider(providerOf(cfg))
    setModel(cfg.model)
    setAlloc(cfg.allocationUsd)
    setGuardrails({ ...cfg.guardrails })
    setProfitTarget(cfg.retirement?.profitTargetUsd !== undefined ? String(cfg.retirement.profitTargetUsd) : '')
    setMaxLoss(cfg.retirement?.maxLossUsd !== undefined ? String(cfg.retirement.maxLossUsd) : '')
    setTodayOnly(false)
    const dropped = cfg.retirement?.at ? ' · its dated deadline was not copied' : ''
    setFillNote(`Duplicate of “${cfg.name}” — same task, schedule, symbols, limits and ${money(cfg.allocationUsd, 0)} allocation · starts in Paper${dropped}. Nothing is created until you press Create.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDuplicateOf])
  useEffect(() => {
    const t = initialTemplateId ? AGENT_TEMPLATES.find((x) => x.id === initialTemplateId) : undefined
    if (t) applyTemplate(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTemplateId])

  const loadAccount = async (): Promise<void> => {
    setAcctLoading(true)
    setAcctErr(null)
    try {
      setAcct(await window.tb.robinhood.account())
    } catch (e) {
      setAcctErr(ipcErrorText(e))
    } finally {
      setAcctLoading(false)
    }
  }
  useEffect(() => {
    // The buying-power tiles come from this computer's Robinhood connection.
    if (mode === 'live' && rh?.connected && !acct && !acctLoading) void loadAccount()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, rh?.connected])

  const available = room?.available ?? null
  const allocTooHigh = mode === 'live' && available !== null && alloc > available
  /**
   * The box carries text so it can show thousands separators, which cost it the
   * `min={1}` a `type="number"` field enforced for free. This is that constraint
   * said in the form instead: anything that is not a positive number — an empty
   * box, a zero, or something like "1.2.3" that survives the digit filter and
   * `Number` cannot read — is refused here, in the same breath as the disabled
   * Create button, because a button that does nothing and says nothing reads as
   * a broken app rather than a refusal.
   */
  const allocInvalid = !(alloc > 0)

  const create = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const s = await window.tb.agents.create({
        // Sent RAW. An empty name is meaningful now: configFromCreateRequest
        // supplies the interim label AND sets `nameAuto`, so the agent names
        // itself on its first run. Filling it in here would look identical and
        // silently spend that.
        name: name.trim(),
        icon,
        color,
        task,
        mode,
        model,
        allocationUsd: alloc,
        retirement: buildRetirement(profitTarget, maxLoss, todayOnly),
        autonomous,
        guardrails,
        ...(playbook ? { playbook, schedule: earningsPopSchedule(), planNow: false } : { schedule: planMode === 'manual' ? schedule : undefined, planNow: planMode === 'ai' })
      })
      // The group is a layout edit keyed by the id we only now have; it can fail
      // on its own (the store shows why in the sidebar) without undoing the create.
      if (groupId) void assignAgentToGroup(s.config.id, groupId)
      select(s.config.id)
      onClose()
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  /** What the form itself is still missing — said under the button it disables. */
  const needs = !task.trim() ? 'Describe what it should do' : !(alloc > 0) ? 'Set an allocation' : null

  return (
    <Sheet
      title="New agent"
      onClose={onClose}
      width={520}
      footer={
        <>
          {needs && !blockReason && (
            <span className="mr-auto text-xs text-muted truncate" title={needs}>
              {needs}
            </span>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !!blockReason || !task.trim() || !(alloc > 0) || allocTooHigh} onClick={() => void create()} title={blockReason ?? undefined}>
            {busy ? 'Creating…' : atCap ? `Limit ${MAX_ACTIVE_AGENTS} reached` : `Create — ${money(alloc, alloc % 1 === 0 ? 0 : 2)} ${mode}`}
          </button>
        </>
      }
    >
      {atCap && <p className="mb-5 rounded-md bg-warn/10 text-warn px-3 py-2 text-sm">{agentCapMessage(activeCount)}</p>}

      {/* ── Starters ──────────────────────────────────────────────────────── */}
      <section className="mb-6">
        <SectionHead
          title="Start from a template"
          hint="Illustrations of what an agent can be told, not recommendations — swap in your own tickers and sizes. Each one fills the sheet (name, task, schedule, act-or-ask); everything stays editable and nothing is created until you press Create."
          right={
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setGalleryOpen(true)} title="Every template, with what it does, when it runs and where it goes wrong">
              <LayoutGrid size={13} /> Browse all {AGENT_TEMPLATES.length}
            </button>
          }
        />
        {/* The row scrolls sideways, and an `overflow-x` scroller clips on BOTH
            axes: an outset ring on the picked card lost its top and bottom
            edges, and the scrollbar sat flush under the cards. So the selection
            ring is an INSET ring (`inset-ring-*`, drawn inside the card's own
            edge — nothing to clip) and the row keeps room above and below. */}
        <div className="flex gap-2 overflow-x-auto pt-1 pb-2.5 -mx-1 px-1">
          {AGENT_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t)}
              title={t.task}
              aria-pressed={templateId === t.id}
              className={cn(
                'card-quiet shrink-0 w-[186px] text-left p-3 transition-shadow duration-[var(--dur-fast)]',
                templateId === t.id ? 'inset-ring-2 inset-ring-accent' : 'hover:inset-ring hover:inset-ring-hairline-strong'
              )}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <AgentAvatar icon={t.icon} color={t.color} size={24} active={templateId === t.id} />
                <span className="font-medium text-sm truncate">{t.name}</span>
              </div>
              <div className="text-xs text-muted leading-snug line-clamp-3">{t.tagline}</div>
              <div className="text-2xs text-text-3 mt-2 truncate nums">{describeSchedule(t.schedule)}</div>
              <div className="text-2xs text-text-3 truncate">
                {t.playbook ? <span className="text-accent">{PLAYBOOK_LABEL[t.playbook]} mode · </span> : null}
                {t.autonomous ? 'Acts on its own' : 'Asks first'}
              </div>
            </button>
          ))}
        </div>
        {fillNote && <p className="text-sm mt-2 leading-relaxed text-muted">{fillNote}</p>}
        {galleryOpen && (
          <TemplateGallery
            selectedId={templateId}
            onPick={(t) => {
              applyTemplate(t)
              setGalleryOpen(false)
            }}
            onClose={() => setGalleryOpen(false)}
          />
        )}
      </section>

      {/* ── What it does ──────────────────────────────────────────────────── */}
      <Group title="What it does">
        <Row>
          <div className="flex items-center gap-3">
            <AgentAvatar icon={icon} color={color} size={40} active />
            <input className="input flex-1 min-w-0 text-md font-medium" value={name} onChange={(e) => setName(e.target.value)} placeholder={suggestName(task) || 'Name it, or leave it to name itself'} aria-label="Agent name" />
          </div>
        </Row>
        <Row label="What should it do?" hint="Plain language. One job per agent. Times are Eastern.">
          <textarea className="input min-h-[128px] resize-y text-md leading-relaxed" value={task} onChange={(e) => setTask(e.target.value)} placeholder={AGENT_TEMPLATES[0].task} autoFocus aria-label="What should it do?" />
          {template && task === template.task && <p className="text-sm text-warn mt-2 leading-relaxed">Where this idea goes wrong: {template.risk}</p>}
          {/* Goal realism: what the sentence asks for per
              trading day, said before the agent exists. The first run repeats it
              against the watchlist's actual daily range. */}
          {realism && <p className="mt-2 text-sm text-warn leading-relaxed">{goalRealismLine(realism, null)}</p>}
        </Row>
        <Row>
          <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={lookOpen} onClick={() => setLookOpen((v) => !v)}>
            <span className="label mb-0 flex-1">Look</span>
            <span className="text-xs text-muted capitalize">
              {color} · {icon}
            </span>
            <ChevronDown size={14} className={cn('text-muted transition-transform duration-[var(--dur-fast)]', lookOpen && 'rotate-180')} />
          </button>
          {/* Collapsed, the grid is not just hidden — `inert` keeps it out of the
              tab order, so Tab from the name goes to the task, not into 24
              invisible swatches. */}
          <div className="fold" data-open={lookOpen || undefined}>
            {/* `.fold > *` clips with overflow:hidden at ITS OWN box, and the
                selection rings sit OUTSIDE their buttons (ring-2 + offset-2 on a
                swatch, ring-2 + offset-1 on a tile) — so the first swatch and the
                first tile lost their left edge, the last column its right, the
                last row its bottom (2026-09-11). The clipping box is widened
                into the row's own padding and given room at the foot; the
                content stays exactly where it was. */}
            <div inert={!lookOpen || undefined} className="-mx-2 px-2 pb-1.5">
              {/* Room under the swatches is measured ring to ring: the picked swatch grows
                  ring-2 + offset-2 (and scales), the picked tile ring-2 + offset-1
                  above itself — 8px between the rows left ~2px of air between the
                  two rings. */}
              <div className="flex items-center gap-1.5 pt-3 pb-4">
                {AGENT_COLORS.map((c) => (
                  <button key={c} aria-label={c} aria-pressed={color === c} onClick={() => setColor(c)} className={cn('h-6 w-6 rounded-full transition-transform duration-[var(--dur-fast)]', color === c && 'ring-2 ring-offset-2 ring-offset-surface ring-[var(--ring)] scale-110')} style={{ background: (COLORS[c] ?? COLORS.blue).swatch }}>
                    {color === c && <Check size={12} className="mx-auto text-accent-fg" />}
                  </button>
                ))}
              </div>
              {/* A grid of fixed cells, not a wrapping row: wrapped tiles with a
                  scaled, circular ring on the chosen one ran into their
                  neighbours. Each cell is the tile plus its ring, the ring
                  follows the tile's own corners, and selection changes tone,
                  never size (2026-09-11). */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(42px,1fr))] gap-2 justify-items-center">
                {AGENT_ICONS.map((k) => (
                  <button
                    key={k}
                    aria-label={k}
                    aria-pressed={icon === k}
                    title={k}
                    onClick={() => setIcon(k)}
                    // Every cell has its own visible edge: the tile's navy field
                    // is near-invisible on a dark theme, and unbounded glyph
                    // fields of different shapes read as one overlapping mess.
                    className={cn(
                      'rounded-[var(--radius-sm)] p-[3px] bg-surface-2 transition-[opacity,box-shadow] duration-[var(--dur-fast)]',
                      icon === k ? 'ring-2 ring-[var(--ring)] ring-offset-1 ring-offset-surface' : 'ring-1 ring-[var(--color-hairline-strong)] opacity-80 hover:opacity-100 hover:ring-[var(--color-text-3)]'
                    )}
                  >
                    <AgentAvatar icon={k} color={color} size={34} active={icon === k} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Row>
        {layout.groups.length > 0 && (
          <Row label="Group" hint="Optional — which section of the agent list it is filed under. Your arrangement, not the agent’s setup; change it any time.">
            <GroupSelect groups={layout.groups} value={groupId} onChange={setGroupId} />
          </Row>
        )}
      </Group>

      {/* ── When it runs ──────────────────────────────────────────────────── */}
      <Group title={playbook ? `When it runs · ${PLAYBOOK_LABEL[playbook]}` : 'When it runs'}>
        {playbook && (
          <Row>
            <div className="card-quiet p-3 text-sm leading-relaxed">
              <div className="font-medium mb-1.5">The engine runs this cycle — the task sentence cannot change it</div>
              <ul className="list-disc pl-4 space-y-1 text-muted">
                <li>
                  <span className="nums">{EARNINGS_POP.researchAt}</span> ET researches the day’s reporters before the open; <span className="nums">{EARNINGS_POP.recheckAt}</span> ET re-checks the shortlist against the tape and fresh news; <span className="nums">{EARNINGS_POP.entryAt}</span> ET buys ONE name that reports after today’s close or before tomorrow’s open — or none. No buys before{' '}
                  <span className="nums">{EARNINGS_POP.entryWindow}</span> ET.
                </li>
                <li>Every buy is the whole book: all of its settled cash, whatever size the agent asks for. One name at a time.</li>
                <li>
                  The engine sells everything at <span className="nums">{EARNINGS_POP.exitAt}</span> ET the next session, gap up or down; <span className="nums">{EARNINGS_POP.reviewAt}</span> ET scores the call.
                </li>
                <li>A cash account waits for the sale to settle (next trading day), so the agent sleeps until that morning’s research. With limited margin it can go again the same afternoon.</li>
              </ul>
              <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => setPlaybook(undefined)}>
                Make it an ordinary agent instead
              </button>
            </div>
          </Row>
        )}
        {!playbook && (
        <Row>
          <Segmented
            block
            value={planMode}
            onChange={setPlanMode}
            options={[
              { value: 'ai', label: 'Let the agent plan it' },
              { value: 'manual', label: 'Set manually' }
            ]}
          />
          {planMode === 'ai' ? (
            <p className="text-sm text-muted mt-2.5 flex items-start gap-1.5 leading-relaxed">
              <Sparkles size={13} className="mt-0.5 shrink-0 text-accent" /> The agent reads your task and proposes the schedule + guardrails in the thread right after creation.
            </p>
          ) : (
            <div className="mt-3">
              <ScheduleForm value={schedule} onChange={setSchedule} />
            </div>
          )}
        </Row>
        )}
      </Group>

      {/* ── How much ──────────────────────────────────────────────────────── */}
      <Group title="How much">
        <Row label="Mode" hint={mode === 'live' ? 'Live orders also require arming the agent in its settings after creation.' : paperModeHint(feedOn)}>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'paper', label: 'Paper' },
              { value: 'live', label: 'Live', hint: brokerReady ? undefined : 'Connect Robinhood first' }
            ]}
          />
          {mode === 'live' && !brokerReady && (
            <p className="text-sm text-warn mt-2 leading-relaxed">Robinhood is not connected — live orders will be rejected until you connect.</p>
          )}
        </Row>
        <Row label="Allocation" hint="The agent's whole budget. It can never deploy more than this, whatever the account holds.">
          {mode === 'live' && (
            <div className="mb-3">
              {rh?.connected ? (
                acct ? (
                  <div className="grid grid-cols-3 gap-2">
                    {/* Cents stay: "Free to allocate" is a ceiling the Create
                        gate checks exactly, and a figure rounded UP would offer
                        a dollar the engine then refuses. */}
                    <StatTile label="Free to allocate" value={<Amount value={room?.available ?? acct.buyingPower} className="text-accent" />} />
                    <StatTile
                      label={room && room.claimedBy > 0 ? `Held by ${room.claimedBy} live agent${room.claimedBy === 1 ? '' : 's'}` : 'Buying power'}
                      value={<Amount value={room && room.claimedBy > 0 ? room.claimed : acct.buyingPower} />}
                    />
                    <StatTile label="Account equity" value={<Amount value={acct.equity} />} />
                  </div>
                ) : (
                  <div className="inset px-3 py-2.5 flex items-center gap-2 text-sm text-muted">
                    {acctLoading ? (
                      <>
                        <RefreshCw size={13} className="animate-spin" /> Fetching your Robinhood account…
                      </>
                    ) : (
                      <>
                        <Wallet size={13} className="shrink-0" />
                        <span className="min-w-0 truncate" title={acctErr ?? undefined}>
                          {acctErr ?? 'Account unavailable.'}
                        </span>
                        <button className="btn btn-outline btn-sm ml-auto shrink-0" onClick={() => void loadAccount()}>
                          Retry
                        </button>
                      </>
                    )}
                  </div>
                )
              ) : (
                <p className={cn('text-sm leading-relaxed', feedOn ? 'text-muted' : 'text-warn')}>{feedOn ? ALLOCATION_NO_BROKER_HINT : 'Connect Robinhood to see how much is available to allocate.'}</p>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative w-40">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none">$</span>
              <input
                ref={allocRef}
                type="text"
                inputMode="decimal"
                aria-label="Allocation in dollars"
                // A text box that steps with the arrow keys is a spinbutton to
                // anything reading the screen — the box stopped being `number`
                // for the separators, not for the semantics.
                role="spinbutton"
                aria-valuenow={alloc > 0 ? alloc : undefined}
                aria-valuemin={ALLOC_MIN}
                aria-invalid={allocInvalid || allocTooHigh}
                className={cn('input pl-6 money text-md', (allocTooHigh || allocInvalid) && 'input-invalid')}
                value={groupDigits(allocText)}
                onKeyDown={(e) => {
                  // Arrow-key stepping, which `type="number"` gave for free
                  // before the field became text. The same step of 1 and the
                  // same floor as the `min={1}` it replaced, so holding Down can
                  // never walk an agent's whole budget to nothing — and cents
                  // survive a step ($400.25 → $401.25, never $401).
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                  e.preventDefault()
                  const from = Number(allocText.replace(/[^0-9.]/g, ''))
                  const base = Number.isFinite(from) ? from : 0
                  setAlloc(Math.max(ALLOC_MIN, Math.round((e.key === 'ArrowUp' ? base + 1 : base - 1) * 100) / 100))
                }}
                onChange={(e) => {
                  const raw = e.target.value
                  const caret = e.target.selectionStart ?? raw.length
                  caretDigits.current = (raw.slice(0, caret).match(/\d/g) ?? []).length
                  const clean = raw.replace(/[^0-9.]/g, '')
                  setAllocText(clean)
                  setAllocNumber(Math.max(0, Number(clean) || 0))
                }}
              />
            </div>
            {mode === 'live' && available !== null
              ? [0.1, 0.25, 0.5, 1].map((f) => (
                  <button key={f} type="button" className="chip chip-btn nums" onClick={() => setAlloc(Math.floor(available * f))}>
                    {f === 1 ? 'Max' : `${f * 100}%`}
                  </button>
                ))
              : [1_000, 5_000, 10_000, 25_000].map((v) => (
                  <button key={v} type="button" className="chip chip-btn nums" onClick={() => setAlloc(v)}>
                    ${v / 1000}k
                  </button>
                ))}
          </div>
          {allocInvalid && (
            <p className="text-sm text-down mt-2 leading-relaxed" role="alert">
              {allocText.trim() ? `“${allocText}” is not an amount.` : 'The allocation is this agent’s whole budget.'} Enter a number above $0 before creating it.
            </p>
          )}
          {mode === 'live' && available !== null && (
            <div className="mt-2.5">
              <div className="meter" data-level={allocTooHigh ? 'over' : undefined}>
                <span style={{ width: `${Math.min(100, (alloc / Math.max(1, available)) * 100)}%` }} />
              </div>
              <p className={cn('text-xs mt-1.5 leading-relaxed', allocTooHigh ? 'text-down' : 'text-muted')}>
                {allocTooHigh && liveVerdict && !liveVerdict.ok
                  ? liveVerdict.reason
                  : `${((alloc / Math.max(1, available)) * 100).toFixed(0)}% of what is free — ${room ? liveRoomLabel(room) : ''}`}
              </p>
            </div>
          )}
        </Row>
        <Row label="Retirement" hint="Optional finish line — the agent flattens, stops, and moves to the Retired section when any condition is met (stats preserved, respawnable).">
          {/* Each label stacks its caption OVER its input; the checkbox has its own
              row. As inline labels in one wrapping flex row, the captions sat on
              the inputs' baseline and the checkbox line wrapped under them with
              no room of its own, running into the hint below. */}
          <div className="flex items-end gap-3 flex-wrap">
            <label className="block text-xs text-muted">
              <span className="block mb-1">Profit target ($)</span>
              <input type="number" min={1} placeholder="off" className="input w-28 nums" value={profitTarget} onChange={(e) => setProfitTarget(e.target.value)} />
            </label>
            <label className="block text-xs text-muted">
              <span className="block mb-1">Max loss ($)</span>
              <input type="number" min={1} placeholder="off" className="input w-28 nums" value={maxLoss} onChange={(e) => setMaxLoss(e.target.value)} />
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm leading-none">
            <input type="checkbox" className="shrink-0" checked={todayOnly} onChange={(e) => setTodayOnly(e.target.checked)} /> Today only (retire 8 PM ET)
          </label>
        </Row>
      </Group>

      {/* ── How it acts ───────────────────────────────────────────────────── */}
      <Group title="How it acts">
        <Row
          label="Acting"
          hint={
            autonomous
              ? 'It buys, sells and sets exits on its own, and can adjust its own plan and guardrails — you get an alert when it widens a limit.'
              : 'It asks first. Every buy, sell, exit change, retirement and limit-widening waits in the thread until you approve it — and when you do, it re-checks the price before acting.'
          }
        >
          <Segmented
            value={autonomous ? 'auto' : 'ask'}
            onChange={(v) => setAutonomous(v === 'auto')}
            options={[
              { value: 'auto', label: 'On its own' },
              { value: 'ask', label: 'Ask me first' }
            ]}
          />
        </Row>
      </Group>

      {/* ── Where it runs ─────────────────────────────────────────────────── */}
      <Group title="Where it runs">
        <Row label="Runs on" hint={`${PROVIDER_HINT[provider]} You can move it to another service any time from its settings.`}>
          <ProviderPicker value={provider} onChange={pickProvider} />
          {lock && <p className="text-sm text-warn mt-2 leading-relaxed">{blockReason}</p>}
          {!lock && !readiness[provider].ready && <p className="text-sm text-muted mt-2 leading-relaxed">{readiness[provider].detail}</p>}
        </Row>
        <Row label="Model">
          <ModelPicker value={model} onChange={setModel} lockVendor={provider} hideVendor />
        </Row>
      </Group>

      {err && <p className="text-sm text-down leading-relaxed">{err}</p>}
    </Sheet>
  )
}

/** A titled section of the form: heading outside, hairline-separated rows inside one card. */
function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="mb-6">
      <SectionHead title={title} hint={hint} />
      <div className="card divide-hair">{children}</div>
    </section>
  )
}

/** One row of a group: label, control, then the sentence that explains it. */
function Row({ label, hint, children }: { label?: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="px-3.5 py-3">
      {label && <div className="label">{label}</div>}
      {children}
      {hint !== undefined && <p className="hint mt-2">{hint}</p>}
    </div>
  )
}

/** "12500.5" → "12,500.5". Display only — the field's state keeps what was typed. */
function groupDigits(text: string): string {
  const dot = text.indexOf('.')
  const whole = dot === -1 ? text : text.slice(0, dot)
  const rest = dot === -1 ? '' : text.slice(dot)
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + rest
}

function buildRetirement(profitTarget: string, maxLoss: string, todayOnly: boolean): RetirementPolicy | null {
  const pt = Number(profitTarget)
  const ml = Number(maxLoss)
  const r: RetirementPolicy = {
    ...(pt > 0 ? { profitTargetUsd: pt } : {}),
    ...(ml > 0 ? { maxLossUsd: ml } : {}),
    ...(todayOnly ? { at: etDateTime(etClock().date, 20 * 60).toISOString() } : {})
  }
  return Object.keys(r).length ? r : null
}
