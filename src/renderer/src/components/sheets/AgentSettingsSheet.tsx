import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CopyPlus, Lock, ShieldCheck } from 'lucide-react'
import { DEFAULT_ALLOCATION_USD, DEFAULT_MODEL, activeTasks, isAutonomous, needsTypedConfirm, riskSummary, setupState, TYPED_CONFIRM_WORD, type AgentConfig, type Guardrails, type Mode, type ModelChoice, type RetirementPolicy, type Schedule } from '@shared/agents'
import { armBlockedReason } from '@shared/brokerConnection'
import { SETTLEMENT_LABEL, type SettlementMode } from '@shared/settlement'
import { EARNINGS_POP, PLAYBOOK_LABEL } from '@shared/earningsPlaybook'
import { liveAllocationVerdict, liveRoom, liveRoomLabel } from '@shared/liveAllocation'
import type { AccountSnapshot } from '@shared/ipc'
import { Sheet, Segmented } from '@renderer/components/common/Sheet'
import { ModelPicker } from '@renderer/components/common/ModelPicker'
import { Amount, LedgerLine, Money, SectionHead, StatTile } from '@renderer/components/common/Primitives'
import { ScheduleForm } from './ScheduleForm'
import { useApp } from '@renderer/store/appStore'
import { cn, money, ipcErrorText } from '@renderer/lib/format'
import { PROVIDER_HINT, PROVIDER_LABEL, providerOf, type Provider } from '@shared/provider'
import { ProviderPicker, useProviderReadiness } from '@renderer/components/common/ProviderPicker'
import { GroupSelect } from '@renderer/components/common/GroupSelect'

/** The word that lifts the safety cover. Not a shared rule — the cover is this surface's own deliberation step. */
const ARM_WORD = 'arm'

/**
 * A titled group of settings — the same shape New agent uses, so the two sheets
 * read as one form seen at two moments in an agent's life.
 */
function SettingsGroup({ title, hint, right, children, className }: { title: string; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  return (
    <section className={cn('mb-6', className)}>
      <SectionHead title={title} hint={hint} right={right} />
      <div className="card p-4 flex flex-col gap-4">{children}</div>
    </section>
  )
}

/** One labelled control inside a group. `<label>` wraps its own input, so the hit area is the label too. */
function LabelledField({ label, hint, children, className, htmlLabel = true }: { label: string; hint?: ReactNode; children: ReactNode; className?: string; /** False when the control is not a single form element (a segmented control, a picker). */ htmlLabel?: boolean }): JSX.Element {
  const Tag = htmlLabel ? 'label' : 'div'
  return (
    <Tag className={cn('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint !== undefined && <p className="hint mt-1.5">{hint}</p>}
    </Tag>
  )
}

/** A number/text cell in the guardrail grid: quiet label above, figure field below. */
function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <label className={cn('block', className)}>
      <span className="block text-sm text-muted mb-1">{label}</span>
      {children}
    </label>
  )
}

export function AgentSettingsSheet({ agentId, onClose }: { agentId: string; onClose: () => void }): JSX.Element {
  const agent = useApp((s) => s.agents[agentId])
  const openSheet = useApp((s) => s.openSheet)
  const rh = useApp((s) => s.robinhood)
  const cfg = agent?.config
  const layout = useApp((s) => s.layout)
  const assignAgentToGroup = useApp((s) => s.assignAgentToGroup)
  const [name, setName] = useState(cfg?.name ?? '')
  const [task, setTask] = useState(cfg?.task ?? '')
  const [schedule, setSchedule] = useState<Schedule>(cfg?.schedule ?? { kind: 'manual' })
  const [g, setG] = useState<Guardrails>(cfg?.guardrails ?? ({} as Guardrails))
  /** Typed confirmation for a fence past the line a tap can cross. */
  const [typed, setTyped] = useState('')
  /** Set when a Save was refused for want of that word, so the field says so instead of nothing happening. */
  const [confirmMissing, setConfirmMissing] = useState(false)
  const [mode, setMode] = useState<Mode>(cfg?.mode ?? 'paper')
  const [autonomous, setAutonomous] = useState(cfg ? isAutonomous(cfg) : true)
  const [model, setModel] = useState<ModelChoice>(cfg?.model ?? DEFAULT_MODEL)
  const [alloc, setAllocNumber] = useState(cfg?.allocationUsd ?? DEFAULT_ALLOCATION_USD)
  // The field shows the typed text; the number is derived (see NewAgentSheet).
  const [allocText, setAllocText] = useState(String(cfg?.allocationUsd ?? DEFAULT_ALLOCATION_USD))
  const setAlloc = (n: number): void => {
    setAllocNumber(n)
    setAllocText(n > 0 ? String(n) : '')
  }
  const [symbols, setSymbols] = useState((cfg?.guardrails.allowedSymbols ?? []).join(', '))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [retProfit, setRetProfit] = useState(cfg?.retirement?.profitTargetUsd?.toString() ?? '')
  const [retLoss, setRetLoss] = useState(cfg?.retirement?.maxLossUsd?.toString() ?? '')
  const [retAt, setRetAt] = useState(cfg?.retirement?.at ? cfg.retirement.at.slice(0, 16) : '')
  const [busy, setBusy] = useState(false)
  const [switching, setSwitching] = useState(false)
  /** The live safety cover: closed until lifted, and the word typed under it. */
  const [coverOpen, setCoverOpen] = useState(false)
  const [armWord, setArmWord] = useState('')
  const [switchErr, setSwitchErr] = useState<string | null>(null)
  // Live allocation is bounded by what the OTHER live agents leave of the
  // account (shared/liveAllocation.ts) — the same rule as New agent and the
  // IPC gate. Read from this computer's Robinhood connection; unreadable means
  // the sheet cannot warn, and the gate decides on what it can read.
  const agents = useApp((s) => s.agents)
  const [acct, setAcct] = useState<AccountSnapshot | null>(null)
  const [acctErr, setAcctErr] = useState<string | null>(null)
  const [allocErr, setAllocErr] = useState<string | null>(null)
  useEffect(() => {
    if (mode !== 'live' || !rh?.connected || acct) return
    window.tb.robinhood
      .account()
      .then(setAcct)
      // Recorded rather than swallowed: "no room shown" and "we could not look"
      // are different facts, and the second one is the operator's to know.
      .catch((e: unknown) => setAcctErr(ipcErrorText(e) || 'Could not read your Robinhood account.'))
  }, [mode, rh?.connected, acct])
  const room = useMemo(() => (acct ? liveRoom(acct.buyingPower, Object.values(agents), { exceptAgentId: agentId }) : null), [acct, agents, agentId])
  const liveVerdict = mode === 'live' && room ? liveAllocationVerdict(room, alloc) : null
  /** The config this form was seeded from — the baseline for "did the operator touch this?". */
  const [seed, setSeed] = useState<AgentConfig | null>(cfg ?? null)
  const readiness = useProviderReadiness()

  useEffect(() => {
    if (!cfg) onClose()
  }, [cfg, onClose])

  /**
   * An agent's config can change WHILE you are looking at it — a plan applies,
   * the agent adds a task, a run renames it. Snapshotting the config at mount
   * and writing every field back on Save would silently revert whatever had
   * happened in between (an agent's own schedule change, reverted seconds later
   * by a Save from a sheet opened earlier).
   *
   * Two halves fix it and both are needed. Here: adopt the new value for any
   * field the operator has NOT edited, so what is on screen stays true. In
   * `save`: send only fields that actually changed, so an untouched one can
   * never clobber. The deps are deliberately just `updatedAt` — the form values
   * come from this render's closure, which is current, and listing them would
   * re-run this on every keystroke and fight the person typing.
   */
  useEffect(() => {
    if (!cfg || !seed || cfg.updatedAt === seed.updatedAt) return
    const untouched = (now: unknown, was: unknown): boolean => JSON.stringify(now) === JSON.stringify(was)
    if (untouched(name, seed.name)) setName(cfg.name)
    if (untouched(task, seed.task)) setTask(cfg.task)
    if (untouched(schedule, seed.schedule)) setSchedule(cfg.schedule)
    if (untouched(g, seed.guardrails)) setG(cfg.guardrails)
    if (untouched(symbols, (seed.guardrails.allowedSymbols ?? []).join(', '))) setSymbols((cfg.guardrails.allowedSymbols ?? []).join(', '))
    if (untouched(mode, seed.mode)) setMode(cfg.mode)
    if (untouched(autonomous, isAutonomous(seed))) setAutonomous(isAutonomous(cfg))
    if (untouched(model, seed.model)) setModel(cfg.model)
    if (untouched(alloc, seed.allocationUsd)) setAlloc(cfg.allocationUsd)
    if (untouched(buildRetirementPatch(retProfit, retLoss, retAt), seed.retirement ?? null)) {
      setRetProfit(cfg.retirement?.profitTargetUsd?.toString() ?? '')
      setRetLoss(cfg.retirement?.maxLossUsd?.toString() ?? '')
      setRetAt(cfg.retirement?.at ? cfg.retirement.at.slice(0, 16) : '')
    }
    setSeed(cfg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.updatedAt])

  if (!cfg || !agent) return <></>
  const provider = providerOf(cfg)
  const broker = rh
  // The same sentence the engine would refuse with, so the disabled button and
  // the error you would otherwise have got say one thing.
  const armBlocked = armBlockedReason(rh)
  // Whether "Manual" below is a decision or an unfinished setup.
  const setup = setupState(cfg, agent.state)
  // Task 1 is the editable goal above; the rest were added later and are listed.
  const extraTasks = activeTasks(cfg).slice(1)
  /** Held as the value, not a boolean, so the "armed at" line never needs a cast. */
  const armedAt = cfg.liveArmedAt

  /** Applies immediately (not on Save): a provider move is its own operation, and the thread records it. */
  const moveTo = async (p: Provider): Promise<void> => {
    if (p === provider || switching) return
    setSwitching(true)
    setSwitchErr(null)
    try {
      const next = await window.tb.agents.setProvider(agentId, p)
      setModel(next.config.model)
    } catch (err) {
      setSwitchErr(ipcErrorText(err))
    } finally {
      setSwitching(false)
    }
  }

  const guardrailsFromForm = (): Guardrails => ({ ...g, allowedSymbols: symbols.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean) })
  /** Widening past the line needs the word, not a click — `allowedSymbols` never moves either of these two numbers, so the form's copy answers for both. */
  const isWidened = (next: Guardrails): boolean => next.maxDailyLossPct > cfg.guardrails.maxDailyLossPct || next.maxOrderNotional > cfg.guardrails.maxOrderNotional

  /**
   * ONLY what changed. Sending the whole form meant a field the operator
   * never touched could overwrite something that changed after this sheet
   * opened — which is exactly how an agent's own plan got reverted 26
   * seconds after it was applied.
   *
   * Compared against the LIVE config, not the seed, so the diff is against
   * what is actually stored right now.
   */
  const buildPatch = (guardrails: Guardrails): Partial<AgentConfig> => {
    const changed = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]): Partial<AgentConfig> =>
      JSON.stringify(value) === JSON.stringify(cfg[key]) ? {} : ({ [key]: value } as Partial<AgentConfig>)
    return {
      ...changed('name', name.trim() || cfg.name),
      ...changed('task', task),
      ...changed('schedule', schedule),
      ...changed('guardrails', guardrails),
      ...changed('mode', mode),
      // Absent means autonomous, so compare meaning rather than the raw field
      // or every legacy agent would look changed.
      ...(autonomous === isAutonomous(cfg) ? {} : { autonomous }),
      ...changed('model', model),
      // An emptied box is not a request for a $0 book — it keeps the current allocation.
      ...(alloc > 0 ? changed('allocationUsd', alloc) : {}),
      ...changed('retirement', buildRetirementPatch(retProfit, retLoss, retAt))
    }
  }
  /** What the footer states: there is something here Save would send. */
  const dirty = Object.keys(buildPatch(guardrailsFromForm())).length > 0

  const save = async (): Promise<void> => {
    const guardrailsNow = guardrailsFromForm()
    // Widening past the line needs the word, not a click — and only when the
    // fence actually widened, so an unrelated edit on an already-wide agent is
    // not held hostage to it.
    const widened = isWidened(guardrailsNow)
    if (widened && needsTypedConfirm(guardrailsNow, alloc) && typed.trim().toLowerCase() !== TYPED_CONFIRM_WORD) {
      setConfirmMissing(true)
      return
    }
    setConfirmMissing(false)
    // A live allocation above what the other live agents leave is refused
    // here with the sentence, and again by the engine if it gets that far.
    if (mode === 'live' && alloc > 0 && liveVerdict && !liveVerdict.ok && alloc !== cfg.allocationUsd) {
      setAllocErr(liveVerdict.reason)
      return
    }
    setAllocErr(null)
    setBusy(true)
    try {
      const patch = buildPatch(guardrailsNow)
      if (Object.keys(patch).length) await window.tb.agents.update(agentId, patch)
      onClose()
    } finally {
      setBusy(false)
    }
  }
  const ledger = cfg.mode === 'live' ? agent.state.live : agent.state.paper
  const showTypedConfirm = isWidened(g) && needsTypedConfirm({ ...g, allowedSymbols: [] }, alloc)
  const dailyLossDollars = (cfg.guardrails.maxDailyLossPct / 100) * Math.max(1, cfg.allocationUsd)

  return (
    <Sheet
      title="Agent settings"
      onClose={onClose}
      width={520}
      footer={
        <>
          <span className="hint mr-auto" aria-live="polite">
            {dirty ? 'Unsaved changes' : 'Everything here is saved'}
          </span>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <SettingsGroup title="What it does" hint="Its name, where it sits in your list, and the job it works on every run.">
        <LabelledField label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </LabelledField>
        <LabelledField
          label="Group"
          htmlLabel={false}
          hint={layout.groups.length ? 'Which section of the agent list this sits in. Applies at once — it is your arrangement, not the agent’s setup.' : 'No groups yet. Make one from the agent list (the layers button) to file agents into sections.'}
        >
          <div className="flex items-center gap-2">
            <GroupSelect groups={layout.groups} value={layout.membership[agentId] ?? null} disabled={layout.groups.length === 0} onChange={(gid) => void assignAgentToGroup(agentId, gid)} />
            <button className="btn btn-ghost btn-sm" onClick={() => openSheet({ kind: 'groups' })}>
              Manage groups
            </button>
          </div>
        </LabelledField>
        <LabelledField label={extraTasks.length ? 'Goal (task 1)' : 'Task'} hint={extraTasks.length ? 'What this agent was created to do.' : undefined}>
          <textarea className="textarea min-h-[92px] resize-y leading-relaxed" value={task} onChange={(e) => setTask(e.target.value)} />
        </LabelledField>
        {extraTasks.length > 0 && (
          <LabelledField label={`Also doing (${extraTasks.length})`} htmlLabel={false} hint="Added later with your confirmation. The agent works on every one of these on every run.">
            <ul className="inset divide-hair overflow-hidden">
              {extraTasks.map((t, i) => (
                <li key={t.id} className="flex items-start gap-2.5 px-3 py-2">
                  <span className="text-xs font-medium text-text-3 nums mt-0.5 shrink-0">{i + 2}</span>
                  <span className="text-sm flex-1 min-w-0 leading-relaxed">{t.text}</span>
                  <button className="btn btn-ghost btn-sm shrink-0 -mr-1.5" title="Stop working on this task" onClick={() => void window.tb.agents.completeTask(agentId, t.id, 'Removed by the operator')}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </LabelledField>
        )}
      </SettingsGroup>

      <SettingsGroup title="Schedule" hint="When it wakes up. Times are Eastern.">
        {/* "Manual" is both the default and a real choice, so a setup run that
            never produced a schedule is indistinguishable from a deliberate one
            unless we say which this is. */}
        {setup === 'planning' && (
          <p className="text-sm text-muted flex items-start gap-2">
            <span className="dot bg-accent pulse mt-1.5" />
            <span>Choosing its own schedule — it reads the task on its first run and sets this. Manual until then.</span>
          </p>
        )}
        {setup === 'unplanned' && (
          <p className="text-sm text-warn leading-relaxed">
            Its setup run finished without setting a schedule, so it is still manual and will not run on its own. Message it (&ldquo;how often should you run?&rdquo;) or pick a schedule below.
          </p>
        )}
        {cfg?.playbook ? (
          // A special mode owns its cycle: editing the times here would move
          // runs the engine's gate, entry window and exits are written against.
          <div className="card-quiet p-3 text-sm leading-relaxed">
            <div className="font-medium mb-1">{PLAYBOOK_LABEL[cfg.playbook]} mode — the engine runs this cycle</div>
            <p className="text-muted">
              Research at <span className="nums">{EARNINGS_POP.researchAt}</span> ET before the open, a re-check at <span className="nums">{EARNINGS_POP.recheckAt}</span> ET, a whole-book buy from <span className="nums">{EARNINGS_POP.entryWindow}</span> ET of one name reporting tonight or before tomorrow’s open, and an
              engine sale at <span className="nums">{EARNINGS_POP.exitAt}</span> ET next session. Between trades it sleeps until the sale has settled.
            </p>
            <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => void window.tb.agents.update(agentId, { playbook: undefined })} title="Turns the mode off: buys are sized by the agent inside its guardrails again, and the schedule becomes editable. The current schedule and limits are kept.">
              Turn the mode off
            </button>
          </div>
        ) : (
          <ScheduleForm value={schedule} onChange={setSchedule} />
        )}
      </SettingsGroup>

      <SettingsGroup title="Money" hint="Paper rehearses with the same rules; live sends orders to Robinhood.">
        <LabelledField label="Mode" htmlLabel={false}>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'paper', label: 'Paper' },
              { value: 'live', label: 'Live' }
            ]}
          />
        </LabelledField>

        <LabelledField label="Allocation" htmlLabel={false} hint="The agent's whole budget. It can never deploy more than this, whatever the account holds.">
          <div className="flex items-end gap-2">
            <label className="block">
              <span className="sr-only">Allocation in US dollars</span>
              <input
                type="number"
                min={1}
                className="input w-36 nums"
                value={allocText}
                onChange={(e) => {
                  setAllocText(e.target.value)
                  setAllocNumber(Math.max(0, Number(e.target.value) || 0))
                }}
              />
            </label>
            <button className="btn btn-outline" onClick={() => void window.tb.agents.resetPaper(agentId)}>
              Reset paper ledger
            </button>
          </div>
          {mode === 'live' && room && <p className={cn('mt-1.5 text-xs', liveVerdict && !liveVerdict.ok ? 'text-down' : 'text-muted')}>{liveVerdict && !liveVerdict.ok ? liveVerdict.reason : liveRoomLabel(room)}</p>}
          {mode === 'live' && !room && !acctErr && rh?.connected && <p className="mt-1.5 text-xs text-muted">Reading what your Robinhood account leaves free…</p>}
          {mode === 'live' && acctErr && <p className="mt-1.5 text-xs text-muted">Could not read your Robinhood buying power just now, so the free-to-allocate figure is unknown. {acctErr}</p>}
          {allocErr && <p className="mt-1.5 text-sm text-down">{allocErr}</p>}
        </LabelledField>

        <div>
          <span className="label">Book</span>
          {/* Two columns, not four: a sheet is ~440px wide, and a money figure
              like $17,016.36 at stat size needs more than a quarter of that —
              in four columns it ran over the tile beside it (2026-09-11). */}
          <div className="grid grid-cols-2 gap-2">
            {/* Cash keeps its cents, like the Realized figure beside it: a book
                balance is an exact number, and rounding it to the dollar makes
                the two tiles disagree about the same ledger. */}
            <StatTile label="Cash" value={<Amount value={ledger.cash} />} />
            <StatTile label="Realized" value={<Money value={ledger.realizedPnl} />} />
            <StatTile label="Positions" value={<span className="nums">{ledger.positions.length}</span>} />
            <StatTile label="Fills" value={<span className="nums">{ledger.fills.length}</span>} />
          </div>
        </div>

        {mode === 'live' && (
          /* The safety cover. Everything that binds a live order is stated
             BEFORE the control that lets one through — the broker it would
             reach, the money it may use, and the fence the engine holds it to —
             because "arm" is the one tap in this app that turns a rehearsal into
             an order. */
          <div className="rounded-lg overflow-hidden" style={{ background: 'var(--tint-live)', boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--color-live) 40%, transparent)' }}>
            <div className="flex items-center gap-2 px-3.5 pt-3">
              <AlertTriangle size={14} className="text-live shrink-0" />
              <span className="text-md font-semibold text-live flex-1">Real money</span>
              {armedAt ? <span className="pill pill-armed">Armed</span> : <span className="pill">Not armed</span>}
            </div>
            <p className="px-3.5 pt-1.5 text-sm text-muted leading-relaxed">
              Live orders go to your Robinhood agentic account{broker?.accountHint ? ` (${broker.accountHint})` : ''}. The agent must be <b className="font-medium text-text">armed</b> before any live order is accepted.
            </p>
            <div className="mx-3.5 my-3 card p-3 flex flex-col gap-1">
              <LedgerLine label="Broker" value={broker?.accountHint ?? 'This computer'} />
              <LedgerLine label="Allocation" value={<Amount value={cfg.allocationUsd} decimals={0} />} />
              {/* To the cent, and it is `liveRoom`'s own number — the same one
                  `liveAllocationVerdict` and the IPC gate measure an allocation
                  against. Rounded to the dollar this line could state a ceiling
                  up to 50¢ above the real one, and an operator who types the
                  figure they were shown here gets refused by the gate. */}
              <LedgerLine label="Free to allocate" value={room ? <Amount value={room.available} /> : <span className="text-muted">unknown</span>} />
              <LedgerLine label="Max per order" value={<Amount value={cfg.guardrails.maxOrderNotional} decimals={0} />} />
              <LedgerLine label="Max per symbol" value={<Amount value={cfg.guardrails.maxPositionNotional} decimals={0} />} />
              <LedgerLine label="Buying stops after a daily loss of" value={`${cfg.guardrails.maxDailyLossPct}% · ${money(dailyLossDollars, 0)}`} />
              <LedgerLine label="Orders a day" value={<span className="nums">{cfg.guardrails.maxOrdersPerDay}</span>} />
              {dirty && <p className="hint mt-1">These are the limits as they are saved. Unsaved edits above apply once you Save.</p>}
            </div>

            <div className="px-3.5 pb-3.5">
              {armedAt ? (
                <div className="flex items-center gap-2.5">
                  <button className="btn btn-danger-solid" onClick={() => void window.tb.agents.armLive(agentId, false)}>
                    Disarm
                  </button>
                  <span className="text-xs text-muted flex items-center gap-1.5">
                    <ShieldCheck size={12} className="text-live" />
                    {`Armed ${new Date(armedAt).toLocaleString()}`}
                  </span>
                </div>
              ) : armBlocked ? (
                <p className="text-sm text-warn leading-relaxed">{armBlocked}</p>
              ) : coverOpen ? (
                <div className="flex flex-col gap-2">
                  <label className="block text-sm">
                    <span className="block mb-1">
                      Type <b>{ARM_WORD}</b> to confirm. Until you disarm it, this agent can place real orders in your Robinhood account.
                    </span>
                    <input autoFocus className="input h-8 w-40" value={armWord} placeholder={ARM_WORD} onChange={(e) => setArmWord(e.target.value)} />
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      className="btn btn-danger"
                      disabled={armWord.trim().toLowerCase() !== ARM_WORD}
                      onClick={() => {
                        void window.tb.agents.armLive(agentId, true)
                        setArmWord('')
                        setCoverOpen(false)
                      }}
                    >
                      Arm live trading
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setArmWord('')
                        setCoverOpen(false)
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-outline" onClick={() => setCoverOpen(true)}>
                  <Lock size={13} /> Arm live trading…
                </button>
              )}
            </div>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Guardrails" hint="Enforced by the engine on every order, whatever the agent decides.">
        <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
          <Cell label="Max $ per order">
            <input type="number" className="input nums" value={g.maxOrderNotional} onChange={(e) => setG({ ...g, maxOrderNotional: Number(e.target.value) })} />
          </Cell>
          <Cell label="Max orders / day">
            <input type="number" className="input nums" value={g.maxOrdersPerDay} onChange={(e) => setG({ ...g, maxOrdersPerDay: Number(e.target.value) })} />
          </Cell>
          <Cell label="Max $ per symbol">
            <input type="number" className="input nums" value={g.maxPositionNotional} onChange={(e) => setG({ ...g, maxPositionNotional: Number(e.target.value) })} />
          </Cell>
          <Cell label="Allowed symbols">
            <input className="input mono" placeholder="any" value={symbols} onChange={(e) => setSymbols(e.target.value)} />
          </Cell>
          <Cell label="Max daily loss (% of allocation)" className="col-span-2">
            <input type="number" className="input nums w-40" value={g.maxDailyLossPct} onChange={(e) => setG({ ...g, maxDailyLossPct: Number(e.target.value) })} />
          </Cell>
        </div>

        {/* What the fence means in money, and the typed word when it is widened past the line. */}
        <p className="inset px-3 py-2.5 hint leading-relaxed">{riskSummary({ ...g, allowedSymbols: symbols.split(/[,\s]+/).filter(Boolean) }, alloc)}</p>

        {showTypedConfirm && (
          <label className="block text-sm text-warn leading-relaxed">
            Daily loss above 10% or one order above 25% of the allocation: type <b>{TYPED_CONFIRM_WORD}</b> to save it.
            <input
              className={cn('input mt-1.5 h-8 w-40', confirmMissing && typed.trim().toLowerCase() !== TYPED_CONFIRM_WORD && 'input-invalid')}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={TYPED_CONFIRM_WORD}
              aria-invalid={confirmMissing && typed.trim().toLowerCase() !== TYPED_CONFIRM_WORD}
            />
          </label>
        )}

        {/* Entry discipline. Empty = no rule, which is
            what every agent made before these existed has. */}
        <div>
          <p className="eyebrow mb-2">Entry discipline</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
            <Cell label="No buys before (ET, HH:MM)">
              <input className="input nums" placeholder="off" value={g.noEntriesBeforeEt ?? ''} onChange={(e) => setG({ ...g, noEntriesBeforeEt: e.target.value.trim() || undefined })} />
            </Cell>
            <Cell label="Max entry extension (% above VWAP/open)">
              <input type="number" className="input nums" placeholder="off" value={g.maxEntryExtensionPct ?? ''} onChange={(e) => setG({ ...g, maxEntryExtensionPct: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </Cell>
            <Cell label="Max per symbol per day (% of allocation)">
              <input type="number" className="input nums" placeholder="off" value={g.maxSymbolDayPct ?? ''} onChange={(e) => setG({ ...g, maxSymbolDayPct: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </Cell>
            <Cell label="Re-entry cooldown after a loss (min)">
              <input type="number" className="input nums" placeholder="off" value={g.reentryCooldownMin ?? ''} onChange={(e) => setG({ ...g, reentryCooldownMin: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </Cell>
            <Cell label="New positions per run">
              <input type="number" className="input nums" placeholder="off" value={g.maxNewPositionsPerRun ?? ''} onChange={(e) => setG({ ...g, maxNewPositionsPerRun: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </Cell>
          </div>
        </div>

        {/* Settlement (T+1). Paper simulates whichever mode is chosen; a live
            agent follows the broker's real account type and this only fills
            in when that cannot be read. */}
        <Cell label={`Settlement of sale proceeds${cfg.mode === 'live' ? ' (live: the Robinhood account type decides)' : ''}`}>
          <select className="select" value={g.settlement ?? ''} onChange={(e) => setG({ ...g, settlement: (e.target.value || undefined) as SettlementMode | undefined })}>
            <option value="">Not simulated — proceeds reusable at once</option>
            <option value="cash">{SETTLEMENT_LABEL.cash}</option>
            <option value="margin">{SETTLEMENT_LABEL.margin}</option>
          </select>
        </Cell>

        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={g.marketHoursOnly} onChange={(e) => setG({ ...g, marketHoursOnly: e.target.checked })} /> Regular session only
          </label>
          <label className={cn('flex items-center gap-2', g.marketHoursOnly && 'opacity-45')}>
            <input type="checkbox" disabled={g.marketHoursOnly} checked={g.allowExtendedHours} onChange={(e) => setG({ ...g, allowExtendedHours: e.target.checked })} /> Allow extended hours (limit)
          </label>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Acting"
        hint={
          autonomous
            ? 'It buys, sells, sets exits and retires on its own, and adjusts its own plan and guardrails without asking — you get an alert in the thread when it widens a limit. Every limit is still capped by the allocation.'
            : 'Every buy, sell, exit change and retirement waits in the thread for your approval — the agent holds until you answer, however long that takes. A plan change that widens its limits waits for your tap too. Approving is not an instruction: it re-checks the price and can decide the moment has passed.'
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
        {!autonomous && agent.state.pendingAction && !agent.state.pendingAction.approvedAt && (
          <p className="text-sm text-warn leading-relaxed">Waiting on you: “{agent.state.pendingAction.summary}” — answer it in the thread and the agent picks up again.</p>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Runs on"
        hint={`${PROVIDER_HINT[provider]} Switching applies right away — even mid-run: the current run finishes where it started, the next one runs on the new service.`}
      >
        <div>
          <ProviderPicker value={provider} onChange={(p) => void moveTo(p)} disabled={switching} />
          <div aria-live="polite">
            {switching && <p className="text-sm text-muted mt-2">Moving…</p>}
            {switchErr && <p className="text-sm text-down mt-2">{switchErr}</p>}
            {!switching && !switchErr && agent.state.running && <p className="text-sm text-muted mt-2">Running now on {PROVIDER_LABEL[provider]}.</p>}
            {!switching && !switchErr && !readiness[provider].ready && <p className="text-sm text-warn mt-2">{readiness[provider].detail}</p>}
          </div>
        </div>
        <LabelledField label="Model" htmlLabel={false}>
          <ModelPicker value={model} onChange={setModel} lockVendor={provider} hideVendor />
        </LabelledField>
      </SettingsGroup>

      <SettingsGroup title="Retirement" hint="The agent flattens and retires when any condition is met. Blank = runs until stopped.">
        <div className="flex items-end gap-3 flex-wrap">
          <Cell label="Profit target ($)">
            <input type="number" placeholder="off" className="input w-28 nums" value={retProfit} onChange={(e) => setRetProfit(e.target.value)} />
          </Cell>
          <Cell label="Max loss ($)">
            <input type="number" placeholder="off" className="input w-28 nums" value={retLoss} onChange={(e) => setRetLoss(e.target.value)} />
          </Cell>
          <Cell label="Deadline">
            <input type="datetime-local" className="input w-auto nums" value={retAt} onChange={(e) => setRetAt(e.target.value)} />
          </Cell>
        </div>
        {agent.state.status !== 'retired' && (
          <div>
            <button
              className="btn btn-outline"
              onClick={() => {
                void window.tb.agents.retire(agentId)
                onClose()
              }}
            >
              Retire now
            </button>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Duplicate" hint="Opens New agent filled in from this one — same task, schedule, symbols, limits and allocation — with its own thread and its own book, starting in paper.">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className="btn btn-outline"
            title="Open New agent filled in from this agent — same task, schedule, symbols, limits and allocation; its own thread and its own book, starting in paper"
            onClick={() => {
              if (!cfg) return
              // A duplicate is a copy of OUR agent: it carries the allocation,
              // every cap and the finish line, and fills the sheet directly.
              onClose()
              openSheet({ kind: 'new', duplicateOf: cfg.id, nonce: Date.now() })
            }}
          >
            <CopyPlus size={13} /> Duplicate
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Danger zone" hint="Deleting takes the agent's thread, book and history with it. Retiring keeps all of it.">
        {confirmDelete ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm flex-1 min-w-[14rem]">Delete this agent and its history?</span>
            <button
              className="btn btn-danger-solid"
              onClick={() => {
                void window.tb.agents.delete(agentId)
                onClose()
              }}
            >
              Delete
            </button>
            <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </div>
        ) : (
          <div>
            <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              Delete agent
            </button>
          </div>
        )}
      </SettingsGroup>
    </Sheet>
  )
}

function buildRetirementPatch(profit: string, loss: string, at: string): RetirementPolicy | null {
  const pt = Number(profit)
  const ml = Number(loss)
  const r: RetirementPolicy = {
    ...(pt > 0 ? { profitTargetUsd: pt } : {}),
    ...(ml > 0 ? { maxLossUsd: ml } : {}),
    ...(at ? { at: new Date(at).toISOString() } : {})
  }
  return Object.keys(r).length ? r : null
}
