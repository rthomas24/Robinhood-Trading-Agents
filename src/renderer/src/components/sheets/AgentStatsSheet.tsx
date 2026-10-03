import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Ban, Check, Clock, Copy, ScrollText, ShieldCheck, Wallet } from 'lucide-react'
import { effectiveStop, exitEnforcementNote, ledgerFor, riskPanel, type ExitPlan, type Fill, type RunRecord } from '@shared/agents'
import { etClock, formatEt } from '@shared/marketTime'
import { settledCash, unsettledCash } from '@shared/settlement'
import type { Quote } from '@shared/ipc'
import type { DecisionRecord } from '@shared/decisions'
import { describeSchedule } from '@shared/schedule'
import { PROVIDER_LABEL, providerOf } from '@shared/provider'
import { daysSince, scorecardText, trackRecord } from '@shared/scorecard'
import { heldBackSentence, ruleLabel, summarizeDecisions } from '@shared/decisionSummary'
import { Sheet } from '@renderer/components/common/Sheet'
import { AgentAvatar } from '@renderer/components/common/AgentAvatar'
import { Amount, DepthGauge, EmptyState, HeroFigure, LedgerLine, Meter, Money, SectionHead, StatTile, type GaugeLevel } from '@renderer/components/common/Primitives'
import { useApp } from '@renderer/store/appStore'
import { cn, compactNumber, money, pct, pnlClass, relTime, signedMoney } from '@renderer/lib/format'

/**
 * The STATEMENT: what one agent did with the money.
 *
 * Every figure on this sheet comes from `trackRecord()` over the agent's own
 * ledger — the same pure function the copyable scorecard reads — so the screen
 * and the pasted card can never disagree about a win
 * rate. Nothing here is estimated and nothing is recomputed from a second copy.
 */

/** The decision log is read by time window; the row cap only bounds a pathological week and is stated when it bites. */
const DECISION_WINDOW_MS = 7 * 86_400_000
const DECISION_ROW_CAP = 2_000
/** Rows drawn in the scrolling list — the sentence and pills above are over ALL fetched rows. */
const DECISION_LIST_ROWS = 200

/** A fetch that can be in flight, done, or have failed — each gets its own surface state. */
type Load = 'loading' | 'ready' | 'error'

/**
 * P&L tone, READ OFF `pnlClass` rather than re-testing its neutral band. The
 * band was hand-copied into four places; a fifth copy is how the hero figure
 * ends up green while every figure under it is grey.
 */
const toneOf = (n: number): 'up' | 'down' | undefined => {
  const c = pnlClass(n)
  return c === 'text-up' ? 'up' : c === 'text-down' ? 'down' : undefined
}

/**
 * What is actually protecting a position. The number is `effectiveStop()`:
 * where a fixed floor and a trail are both set the engine sells at the TIGHTER
 * of the two, so the trail percentage alone would misstate the protection.
 *
 * An unprotected position is a RISK STATE, not an absent value, so it carries
 * the warn colour — the one colour rule 2 leaves for "something here needs
 * looking at". A protected one is the ordinary case and stays achromatic:
 * green on a stop would spend a money colour on a level, not on money.
 */
function Protection({ plan }: { plan: ExitPlan | undefined }): JSX.Element {
  const stop = plan ? effectiveStop(plan) : undefined
  if (!plan || (stop === undefined && plan.target === undefined))
    return (
      <span className="text-warn" title="Nothing sells these shares on its own — no stop, no trail, no target.">
        no stop set
      </span>
    )
  const bits = [stop !== undefined ? `stop ${money(stop)}${plan.trail ? ` · ${plan.trail.pct}% trail` : ''}` : '', plan.target !== undefined ? `target ${money(plan.target)}` : ''].filter(Boolean)
  return <span className="mono text-xs">{bits.join(' · ')}</span>
}

export function AgentStatsSheet({ agentId, onClose }: { agentId: string; onClose: () => void }): JSX.Element {
  const agent = useApp((s) => s.agents[agentId])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [runsLoad, setRunsLoad] = useState<Load>('loading')
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [decisions, setDecisions] = useState<DecisionRecord[]>([])
  const [decisionsLoad, setDecisionsLoad] = useState<Load>('loading')

  const cfg = agent?.config
  const state = agent?.state
  const ledger = cfg && state ? ledgerFor(cfg, state) : null

  useEffect(() => {
    setRunsLoad('loading')
    setDecisionsLoad('loading')
    void window.tb.agents
      .runs(agentId, 300)
      .then((rs) => {
        setRuns(rs)
        setRunsLoad('ready')
      })
      .catch(() => setRunsLoad('error'))
    // By TIME, not by count: the sentence below claims "the last 7 days", so it
    // must see the whole window — 60 newest rows re-labelled as a week said
    // "held back 6 times" about weeks that held back sixty.
    void window.tb.agents
      .decisions(agentId, { since: Date.now() - DECISION_WINDOW_MS, limit: DECISION_ROW_CAP })
      .then((ds) => {
        setDecisions(ds)
        setDecisionsLoad('ready')
      })
      .catch(() => setDecisionsLoad('error'))
  }, [agentId])
  const symsKey = useMemo(() => (ledger?.positions.map((p) => p.symbol) ?? []).join(','), [ledger])
  useEffect(() => {
    if (!symsKey) return
    void window.tb.robinhood
      .quotes(symsKey.split(','))
      .then((qs) => setQuotes(Object.fromEntries(qs.map((q) => [q.symbol, q]))))
      .catch(() => undefined)
  }, [agentId, symsKey])

  const m = useMemo(() => {
    if (!cfg || !state || !ledger) return null
    // The book's numbers come from the shared track record — the same function
    // the scorecard reads — so this sheet cannot drift from it.
    const track = trackRecord(cfg, ledger, Object.fromEntries(Object.entries(quotes).map(([sym, q]) => [sym, q.last])))
    const okRuns = runs.filter((r) => r.ok).length
    const tokens = runs.reduce((s, r) => s + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0)
    const cost = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0)
    const avgDur = runs.length ? runs.reduce((s, r) => s + r.durationMs, 0) / runs.length : 0
    const actions = runs.reduce((s, r) => s + r.actions, 0)
    return { ...track, okRuns, tokens, cost, avgDur, actions }
  }, [cfg, state, ledger, quotes, runs])

  // A plain-text scorecard of this agent's own book, for pasting anywhere.
  const [copied, setCopied] = useState(false)
  const copyScorecard = async (): Promise<void> => {
    if (!cfg || !m) return
    try {
      await navigator.clipboard.writeText(scorecardText(cfg, m))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // No clipboard in this context — the button simply does nothing visible.
    }
  }

  // The footer sentence is TAKEN from the scorecard rather than retyped: a
  // claim about what these numbers are not must not be able to drift between
  // this screen and the text someone pastes somewhere else.
  const footNote = useMemo(() => (cfg && m ? (scorecardText(cfg, m).split('\n').pop() ?? '') : ''), [cfg, m])

  // The rows already ARE the window (fetched by `since`); the summary is over
  // all of them. A result of exactly the cap may be truncated, so the sentence
  // says which rows it read rather than claiming the whole week.
  const summary = useMemo(() => summarizeDecisions(decisions), [decisions])
  const truncated = decisions.length >= DECISION_ROW_CAP
  const windowLabel = truncated ? `in the newest ${DECISION_ROW_CAP} of the last 7 days` : 'in the last 7 days'

  if (!cfg || !state || !ledger || !m) return <></>
  // The risk shape of the book, from one pure function in shared.
  const risk = riskPanel(cfg, state, Object.fromEntries(Object.values(quotes).map((q) => [q.symbol, q.last])), (iso) => etClock(new Date(iso)).minutes)

  const days = daysSince(cfg.createdAt)
  const etDate = etClock().date
  const unsettled = unsettledCash(ledger, etDate)
  const avgWin = m.wins.length ? m.grossWin / m.wins.length : null
  const avgLoss = m.losses.length ? -(m.grossLoss / m.losses.length) : null

  return (
    <Sheet title="Statement" onClose={onClose} width={680}>
      {/* ── Masthead: whose book, whose money, and over what period ───────── */}
      <div className="flex items-start gap-3">
        <AgentAvatar icon={cfg.icon} color={cfg.color} size={44} active={state.running} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg font-semibold tracking-[-0.01em] truncate">{cfg.name}</span>
            <span className={cn('pill shrink-0', cfg.mode === 'live' ? 'pill-live' : 'pill-paper')}>{cfg.mode === 'live' ? 'LIVE' : 'PAPER'}</span>
            <span className="pill shrink-0">{PROVIDER_LABEL[providerOf(cfg)]}</span>
          </div>
          <p className="text-xs text-muted mt-1 truncate">
            {describeSchedule(cfg.schedule)} · allocation {money(cfg.allocationUsd)} · {days} day{days === 1 ? '' : 's'}
          </p>
        </div>
        <button
          className="btn btn-outline btn-sm shrink-0"
          onClick={() => void copyScorecard()}
          title="Copy a six-line plain-text scorecard of this agent — P&L, win rate, open positions, schedule — to paste anywhere"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy scorecard'}
        </button>
      </div>

      {/* ── The bottom line ───────────────────────────────────────────────── */}
      <div className="card p-4 mt-4">
        <div className="flex items-end justify-between gap-5">
          <HeroFigure value={signedMoney(ledger.realizedPnl)} tone={toneOf(ledger.realizedPnl)} caption={`Realized P&L · ${m.sells.length} close${m.sells.length === 1 ? '' : 's'}`} />
          <div className="text-right shrink-0">
            <div className={cn('text-xl font-medium money', pnlClass(m.totalPnl))}>{signedMoney(m.totalPnl)}</div>
            <div className="text-xs text-muted mt-0.5">
              incl. unrealized · <span className={cn('money', pnlClass(m.totalPnl))}>{pct(m.retPct)}</span> of allocation
            </div>
          </div>
        </div>
        <p className="hint mt-3 pt-3 hair-t">{cfg.mode === 'live' ? 'This agent’s own fills only — never the whole account.' : 'Paper: simulated fills at real Robinhood quotes.'}</p>
      </div>

      {/* ── Track record ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2 mt-3">
        <StatTile label="Win rate" value={m.winRate === null ? '—' : `${Math.round(m.winRate * 100)}%`} sub={m.sells.length ? `${m.wins.length}W · ${m.losses.length}L` : 'no closes yet'} />
        <StatTile label="Profit factor" value={m.profitFactor === null ? '—' : m.profitFactor.toFixed(2)} sub={m.sells.length ? `won ${money(m.grossWin, 0)} · lost ${money(m.grossLoss, 0)}` : 'needs a losing close'} />
        <StatTile label="Fills" value={String(m.fills.length)} sub={`${m.buys.length} buys · ${m.sells.length} sells`} />
        <StatTile label="Average win" value={avgWin === null ? '—' : signedMoney(avgWin)} tone={avgWin === null ? undefined : 'up'} sub={m.sells.length ? `best ${signedMoney(m.best)}` : 'no wins yet'} />
        <StatTile label="Average loss" value={avgLoss === null ? '—' : signedMoney(avgLoss)} tone={avgLoss === null ? undefined : 'down'} sub={m.sells.length ? `worst ${signedMoney(m.worst)}` : 'no losses yet'} />
        <StatTile label="Volume traded" value={money(m.volume, 0)} sub="both sides, at fill price" />
      </div>

      {/* ── The book, set as statement lines ──────────────────────────────── */}
      <Section title="The book" hint="Cash and holdings, as the ledger has them.">
        <div className="card px-4 py-3.5 space-y-2">
          <LedgerLine label="Allocation" value={<Amount value={cfg.allocationUsd} />} />
          <LedgerLine label="Cash" value={<Amount value={ledger.cash} />} />
          {unsettled > 0 && (
            <LedgerLine
              label={<span title="US equities settle the next trading day. Until then the proceeds are in the book but cannot be spent on a buy.">Settled cash (spendable on buys today)</span>}
              value={<Amount value={settledCash(ledger, etDate)} />}
            />
          )}
          {unsettled > 0 && <LedgerLine label="Unsettled proceeds (T+1)" value={<Amount value={unsettled} />} />}
          <LedgerLine label={`Market value · ${m.positions.length} position${m.positions.length === 1 ? '' : 's'}`} value={<Amount value={m.marketValue} />} />
          <div className="pt-2 hair-t">
            <LedgerLine label="Equity" value={<Amount value={m.equity} className="font-medium" />} />
          </div>
          <LedgerLine label="Realized P&L" value={<Money value={ledger.realizedPnl} />} />
          <LedgerLine label="Unrealized" value={<Money value={m.unrealized} />} />
        </div>
      </Section>

      {/* ── Cumulative realized P&L ───────────────────────────────────────── */}
      <Section title="Cumulative realized P&L" hint="One step per closed trade, since the agent was created.">
        {m.curve.length > 1 ? (
          <PnlChart points={m.curve} />
        ) : (
          <div className="card">
            <EmptyState icon={<ArrowUpRight size={16} />} title="No closed trades yet" body="The curve draws itself as the agent sells." />
          </div>
        )}
      </Section>

      {/* ── Positions ─────────────────────────────────────────────────────── */}
      <Section title="Positions" hint={m.positions.length ? `${m.positions.length} open` : undefined}>
        {m.positions.length === 0 ? (
          <div className="card">
            <EmptyState icon={<Wallet size={16} />} title="Flat" body="No open positions — the whole allocation is in cash." />
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Qty</th>
                  <th className="num">Avg cost</th>
                  <th className="num">Last</th>
                  <th className="num">Value</th>
                  <th className="num">Unrealized</th>
                  <th>Protection</th>
                </tr>
              </thead>
              <tbody>
                {m.positions.map((p) => (
                  <tr key={p.symbol}>
                    <td className="mono font-medium">{p.symbol}</td>
                    <td className="num">{p.qty}</td>
                    <td className="num">{money(p.avgCost)}</td>
                    <td className="num">
                      {money(p.last)}
                      {/* No quote came back, so `trackRecord` marked this one at cost — say so rather than
                          letting an unpriced holding read as a confident mark. */}
                      {!quotes[p.symbol] && (
                        <span className="text-2xs text-muted ml-1" title="No quote — marked at average cost">
                          at cost
                        </span>
                      )}
                    </td>
                    <td className="num">{money(p.value)}</td>
                    <td className="num">
                      <Money value={p.unrealized} pct={p.uPct * 100} />
                    </td>
                    <td className="text-xs">
                      <Protection plan={state.exits[p.symbol]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* What a stop on this screen actually means. Derived from the same
            constants the agent's prompt reads, so the screen cannot drift from
            the engine — an operator reading "stop $345" at 8pm cannot otherwise
            know it will not fire until 9:30. */}
        {m.positions.length > 0 && <p className="hint mt-2">{exitEnforcementNote()}</p>}
      </Section>

      {/* ── Open orders ───────────────────────────────────────────────────── */}
      {ledger.openOrders.length > 0 && (
        <Section title="Open orders" hint={`${ledger.openOrders.length} resting`}>
          <div className="card divide-hair">
            {ledger.openOrders.map((o) => (
              <div key={o.id} className="flex items-center gap-2 px-3 text-sm" style={{ height: 'var(--h-row)' }}>
                <SideBadge side={o.side} />
                <span className="mono font-medium">
                  {o.qty} {o.symbol}
                </span>
                <span className="text-muted text-xs">
                  {o.type}
                  {o.limitPrice ? ` @ ${money(o.limitPrice)}` : ''}
                </span>
                <span className="ml-auto text-muted text-xs" title={o.ts}>
                  {relTime(o.ts)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── Per symbol ────────────────────────────────────────────────────── */}
      {m.bySymbol.length > 0 && (
        <Section title="By symbol" hint="Realized only — open positions sit in the table above.">
          <div className="card overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Fills</th>
                  <th className="num">Volume</th>
                  <th className="num">Realized</th>
                </tr>
              </thead>
              <tbody>
                {m.bySymbol.map((s) => (
                  <tr key={s.symbol}>
                    <td className="mono font-medium">{s.symbol}</td>
                    <td className="num">{s.trades}</td>
                    <td className="num">{money(s.volume, 0)}</td>
                    <td className="num">
                      <Money value={s.realized} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* ── Risk ──────────────────────────────────────────────────────────
          Concentration, cash, what carries overnight, trail widths and
          opening-window entries. */}
      <Section title="Risk" hint="What the book is exposed to right now.">
        <div className="card p-4">
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Largest position" value={risk.largestPositionPct === null ? '—' : `${risk.largestPositionPct}%`} sub={risk.largestSymbol ? `${risk.largestSymbol} · of allocation` : 'flat'} />
            <StatTile label="Cash" value={`${risk.cashPct}%`} sub="of allocation undeployed" />
            <StatTile label="Opening-window buys" value={String(risk.openingWindowBuysThisWeek)} sub="before 09:45 ET this week" />
          </div>
          <div className="mt-3.5">
            <div className="flex items-baseline justify-between text-xs text-muted mb-1.5">
              <span>Concentration</span>
              <span className="money">{risk.largestPositionPct === null ? 'flat' : `${risk.largestPositionPct}% of allocation in ${risk.largestSymbol}`}</span>
            </div>
            <Meter value={risk.largestPositionPct ?? 0} max={100} warnAt={40} />
          </div>
          {risk.overnightCarry.length > 0 && (
            <p className="text-xs text-warn mt-3 leading-relaxed">
              Carrying an intraday exit overnight if not hit: {risk.overnightCarry.join(', ')} — no flatten time is set, and nothing is checked after the close.
            </p>
          )}
          {risk.trails.length > 0 && (
            <div className="mt-3 space-y-1">
              {risk.trails.map((t) => (
                <div key={t.symbol} className="leader text-xs">
                  <span className="mono">{t.symbol}</span>
                  <span>
                    {t.trailPct}% trail{t.stopDistancePct !== null ? ` · stop ${t.stopDistancePct}% below last` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
          {/* Every armed level on one price line — the engine's exits made visible. */}
          {m.positions.map((p) => (
            <ExitGauge key={p.symbol} symbol={p.symbol} last={p.last} avgCost={p.avgCost} plan={state.exits[p.symbol]} />
          ))}
        </div>
      </Section>

      {/* ── Trade history ─────────────────────────────────────────────────── */}
      <Section title="Trade history" hint={m.fills.length ? `${m.fills.length} fills, newest first` : undefined}>
        {m.fills.length === 0 ? (
          <div className="card">
            <EmptyState icon={<Clock size={16} />} title="No fills yet" body="Every fill this agent gets is printed here, with what it made or lost." />
          </div>
        ) : (
          <div className="card max-h-72 overflow-y-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="sticky top-0 bg-surface">When</th>
                  <th className="sticky top-0 bg-surface">Side</th>
                  <th className="sticky top-0 bg-surface">Symbol</th>
                  <th className="sticky top-0 bg-surface num">Qty</th>
                  <th className="sticky top-0 bg-surface num">Price</th>
                  <th className="sticky top-0 bg-surface num">Notional</th>
                  <th className="sticky top-0 bg-surface num">Realized</th>
                </tr>
              </thead>
              <tbody>
                {[...m.fills].reverse().map((f: Fill) => (
                  <tr key={f.id}>
                    <td className="text-xs text-muted whitespace-nowrap" title={f.ts}>
                      {formatEt(f.ts, true)}
                    </td>
                    <td>
                      <SideBadge side={f.side} />
                    </td>
                    <td className="mono font-medium">{f.symbol}</td>
                    <td className="num">{f.qty}</td>
                    <td className="num">{money(f.price)}</td>
                    <td className="num">{money(f.qty * f.price)}</td>
                    <td className="num">{f.side === 'sell' ? <Money value={f.realized} /> : <span className="text-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Runs & usage ──────────────────────────────────────────────────── */}
      <Section title="Runs & usage" hint="The newest 300 runs.">
        {runsLoad === 'loading' ? (
          <div className="grid grid-cols-4 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-16" />
            ))}
          </div>
        ) : runsLoad === 'error' ? (
          <div className="card">
            <EmptyState icon={<ScrollText size={16} />} title="Couldn’t read the run log" body="The agent’s run history is on disk and could not be opened. Close and reopen this sheet to try again." />
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            <StatTile label="Runs" value={String(runs.length)} sub={runs.length ? `${Math.round((m.okRuns / runs.length) * 100)}% ok` : '—'} />
            <StatTile label="Actions" value={String(m.actions)} sub="orders placed" />
            <StatTile label="Tokens" value={compactNumber(m.tokens)} sub={m.cost > 0 ? `${money(m.cost)} est.` : 'subscription'} />
            <StatTile label="Avg run" value={m.avgDur ? `${(m.avgDur / 1000).toFixed(1)}s` : '—'} sub={state.lastRunAt ? `last ${relTime(state.lastRunAt)}` : 'never ran'} />
          </div>
        )}
        {state.lastError && (
          <p className="text-xs text-down mt-2 truncate" title={state.lastError}>
            Last error: {state.lastError}
          </p>
        )}
      </Section>

      {/* ── The logbook ───────────────────────────────────────────────────
          Why a tool call was allowed or blocked — the answer to "why didn't
          it sell?" that the thread alone cannot give. */}
      <Section title="Logbook" hint={`Every gated tool call, ${decisionsLoad === 'ready' ? `${decisions.length}${truncated ? '+' : ''} ` : ''}over the last 7 days.`}>
        {decisionsLoad === 'loading' ? (
          <div className="skeleton h-24" />
        ) : decisionsLoad === 'error' ? (
          <div className="card">
            <EmptyState icon={<ScrollText size={16} />} title="Couldn’t read the decision log" body="The log is on disk and could not be opened. Close and reopen this sheet to try again." />
          </div>
        ) : decisions.length === 0 ? (
          <div className="card">
            <EmptyState icon={<ShieldCheck size={16} />} title="No gated tool calls in the last 7 days." body="Every order, exit and check-in this agent attempts is recorded here with the rule that decided it." />
          </div>
        ) : (
          <>
            {/* The same rows, read as a sentence — so "why didn't it trade?" has
                an answer before anyone reads the rule keys below. */}
            <div className="card-quiet px-3.5 py-3 mb-2">
              <div className="flex items-start gap-2 text-sm leading-relaxed">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-muted" />
                <span>{heldBackSentence(summary, windowLabel)}</span>
              </div>
              {summary.blockedBy.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {summary.blockedBy.slice(0, 5).map((r) => (
                    <span key={r.rule} className="pill pill-warn" title={r.examples.join('\n') || r.rule}>
                      {r.count}× {r.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="card max-h-80 overflow-y-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="sticky top-0 bg-surface">When</th>
                    <th className="sticky top-0 bg-surface">Tool</th>
                    <th className="sticky top-0 bg-surface">Rule</th>
                    <th className="sticky top-0 bg-surface">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.slice(0, DECISION_LIST_ROWS).map((d, i) => (
                    <tr key={`${d.ts}-${i}`}>
                      <td className="text-xs text-muted whitespace-nowrap align-top" title={d.ts}>
                        <div>{formatEt(d.ts, true)}</div>
                        {!d.attended && (
                          <span className="pill mt-1" title="Nobody was at the keyboard — the schedule or a price watch started this run">
                            auto
                          </span>
                        )}
                      </td>
                      <td className="mono text-xs align-top">{d.tool.replace(/^mcp__[^_]+__/, '')}</td>
                      <td className="mono text-2xs text-muted align-top whitespace-nowrap">{d.rule}</td>
                      <td className="align-top">
                        <div className="flex items-start gap-1.5">
                          {d.outcome === 'blocked' ? <Ban size={12} className="mt-0.5 shrink-0 text-warn" aria-label="Held back" /> : <Check size={12} className="mt-0.5 shrink-0 text-muted" aria-label="Allowed" />}
                          <div className="min-w-0">
                            <div className="text-sm">
                              {d.outcome === 'blocked' ? 'Held back by ' : 'Allowed by '}
                              {ruleLabel(d.rule)}
                            </div>
                            {d.detail && (
                              <div className="text-xs text-muted mt-0.5 line-clamp-2" title={d.detail}>
                                {d.detail}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {decisions.length > DECISION_LIST_ROWS && (
              <p className="hint mt-2">
                Newest {DECISION_LIST_ROWS} of {decisions.length} shown; the sentence above counts all of them.
              </p>
            )}
          </>
        )}
      </Section>

      <p className="hint text-center pt-4 mt-1 hair-t">{footNote}</p>
    </Sheet>
  )
}

/* ── pieces ─────────────────────────────────────────────────────────── */

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="mt-6">
      <SectionHead title={title} hint={hint} />
      {children}
    </section>
  )
}

/**
 * Which way an order went — deliberately achromatic. Green and red are money
 * (rule 2), and a buy is not a gain: painting the side badge coloured the
 * DIRECTION and left the reader to discover, in the last column, that the green
 * row lost money. The arrow and the word carry the direction; the realized
 * figure beside it keeps the colour.
 */
function SideBadge({ side }: { side: 'buy' | 'sell' }): JSX.Element {
  return (
    <span className="pill">
      {side === 'buy' ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />} {side}
    </span>
  )
}

/**
 * One position's armed levels on a single price line. Roles, not directions:
 * a stop is a stop whether it sits above or below the mark, which is what the
 * gauge's colouring says and a red/green line would not.
 */
function ExitGauge({ symbol, last, avgCost, plan }: { symbol: string; last: number; avgCost: number; plan: ExitPlan | undefined }): JSX.Element | null {
  if (!plan) return null
  const levels: GaugeLevel[] = []
  if (avgCost > 0) levels.push({ price: avgCost, label: 'cost', role: 'cost' })
  const stop = effectiveStop(plan)
  if (stop !== undefined) levels.push({ price: stop, label: plan.trail ? 'trail' : 'stop', role: plan.trail ? 'trail' : 'stop' })
  if (plan.stopIf?.below !== undefined) levels.push({ price: plan.stopIf.below, label: 'invalid', role: 'invalidation' })
  if (plan.target !== undefined) levels.push({ price: plan.target, label: 'target', role: 'target' })
  if (levels.length === 0) return null
  return (
    <div className="mt-3.5 pt-3 hair-t">
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="mono font-medium">{symbol}</span>
        <span className="text-muted money">last {money(last)}</span>
      </div>
      <DepthGauge price={last} levels={levels} className="mb-1" />
    </div>
  )
}

/** Index-spaced line geometry: the accessors and both paths a chart needs. */
interface LineGeometry {
  /** Pixel x of the i-th value. */
  x: (i: number) => number
  /** Pixel y of a VALUE — not an index — so a baseline can be placed too. */
  y: (v: number) => number
  linePath: string
  /** `linePath`, closed down to the bottom of the plotted range. */
  areaPath: string
}

/**
 * The same arithmetic the `Sparkline` primitive draws with — evenly spaced on
 * the index, inverted min/max on the value, padded off the edges — at a size a
 * word-sized sparkline cannot serve. One builder rather than a hand-rolled path
 * per chart: two charts in the same app whose axes disagree are two charts that
 * mean different things by the same shape.
 *
 * `includeZero` keeps the baseline in view for a P&L series. Callers guarantee
 * at least one value.
 */
function lineGeometry(values: number[], width: number, height: number, pad: number, includeZero = false): LineGeometry {
  const scale = includeZero ? [0, ...values] : values
  const lo = Math.min(...scale)
  const hi = Math.max(...scale)
  const span = hi - lo || 1
  const x = (i: number): number => pad + (i / Math.max(1, values.length - 1)) * (width - pad * 2)
  const y = (v: number): number => pad + (1 - (v - lo) / span) * (height - pad * 2)
  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const floor = y(lo)
  return {
    x,
    y,
    linePath,
    areaPath: `${linePath} L${x(values.length - 1).toFixed(1)},${floor.toFixed(1)} L${x(0).toFixed(1)},${floor.toFixed(1)} Z`
  }
}

/** Minimal dependency-free area chart of cumulative realized P&L. */
function PnlChart({ points }: { points: { t: string; v: number }[] }): JSX.Element {
  const W = 560
  const H = 120
  const PAD = 6
  const g = lineGeometry(
    points.map((p) => p.v),
    W,
    H,
    PAD,
    true
  )
  const last = points[points.length - 1]
  const up = last.v >= 0
  const stroke = up ? 'var(--color-up)' : 'var(--color-down)'
  return (
    <div className="card p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} preserveAspectRatio="none" role="img" aria-label={`Cumulative realized P&L, ${signedMoney(last.v)} after ${points.length - 1} closed trades`}>
        <line x1={PAD} x2={W - PAD} y1={g.y(0)} y2={g.y(0)} stroke="var(--color-hairline-strong)" strokeDasharray="3 4" />
        <path d={g.areaPath} fill={stroke} opacity={0.08} />
        <path d={g.linePath} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={g.x(points.length - 1)} cy={g.y(last.v)} r={3.5} fill={stroke} />
      </svg>
      <div className="flex items-center justify-between text-xs text-muted mt-1.5 pt-1.5 hair-t">
        <span>{relTime(points[0].t)} → now</span>
        <span className={cn('money font-medium', pnlClass(last.v))}>{signedMoney(last.v)} realized</span>
      </div>
    </div>
  )
}
