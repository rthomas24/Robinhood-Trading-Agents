import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FlaskConical, PanelRightClose, Plug, RefreshCw, TriangleAlert, Wallet } from 'lucide-react'
import type { AccountSnapshot, Quote } from '@shared/ipc'
import { paperPortfolio, type AgentSummary } from '@shared/agents'
import { portfolioRows, portfolioTotals } from '@shared/portfolio'
import { etClock } from '@shared/marketTime'
import { useApp } from '@renderer/store/appStore'
import { cn, money, pnlClass, ipcErrorText } from '@renderer/lib/format'
import { Amount, DepthGauge, EmptyState, HeroFigure, Money, StatTile, TickerChip, type GaugeLevel } from '@renderer/components/common/Primitives'

/**
 * A peek into the operator's Robinhood account: equity + day move, buying power,
 * and every position as a ticker row (symbol · intraday sparkline · price · %),
 * green when up, red when down. Read-only mirror of the shared account — agents
 * still only ever see/trade their own books.
 */
const POLL_MS = 30_000
const SPARK_MS = 5 * 60_000

const etDateOf = (iso: string): string => etClock(new Date(iso)).date

/**
 * Two books, one panel, never added together. Robinhood is what the operator
 * actually owns; Paper is what the agents would have done. A combined equity
 * figure would be the worst possible answer to either question, so the tab is a
 * hard switch rather than a filter.
 */
type Tab = 'live' | 'paper'

/** The big number at the top of either tab: equity, then the day's move under it. */
function Headline({ equity, dayChange, dayPct, note }: { equity: number; dayChange: number; dayPct?: number; note?: string }): JSX.Element {
  return (
    <HeroFigure
      className="mt-2"
      value={money(equity)}
      caption={
        <span className={cn('money font-medium', pnlClass(dayChange))}>
          {dayChange >= 0 ? '+' : '−'}
          {money(Math.abs(dayChange))}
          {dayPct !== undefined && ` (${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%)`} today
          {note && <span className="block text-2xs text-muted mt-0.5">{note}</span>}
        </span>
      }
    />
  )
}

/** One enforcing agent's armed levels on this symbol, ready for the gauge. */
interface ArmedExits {
  id: string
  name: string
  levels: GaugeLevel[]
}

/**
 * The exits the ENGINE will actually enforce on this symbol, one entry per
 * agent that holds it. Four conditions, each load-bearing, because a tick on
 * this line is a claim that real shares are protected:
 *
 *  - **live mode** — a paper agent's exits are enforced against its own
 *    simulated book, never against these Robinhood shares;
 *  - **`liveArmedAt` set** — an unarmed live agent places no order at all, so
 *    its plan is an intention, not a protection;
 *  - **not paused** — a paused agent is not woken by the schedule or the watch
 *    tick, so nothing evaluates its levels;
 *  - **not retired** — same, permanently.
 *
 * Drawing anything else here would tell the operator a stop exists that the
 * engine will never fire.
 */
function armedExitsFor(agents: AgentSummary[], symbol: string, avgCost: number): ArmedExits[] {
  return agents
    .filter(
      (a) =>
        a.config.mode === 'live' &&
        a.config.liveArmedAt !== null &&
        a.state.status !== 'paused' &&
        a.state.status !== 'retired' &&
        a.state.exits[symbol] !== undefined
    )
    .map((a) => {
      const plan = a.state.exits[symbol]
      const levels: GaugeLevel[] = []
      if (avgCost > 0) levels.push({ price: avgCost, label: 'cost', role: 'cost' })
      if (plan.stop !== undefined) levels.push({ price: plan.stop, label: 'stop', role: 'stop' })
      if (plan.target !== undefined) levels.push({ price: plan.target, label: 'target', role: 'target' })
      // The trail's effective level is the high the ENGINE has seen, less the
      // percentage — the same arithmetic `enforceExits` applies, so the tick sits
      // where the sale would actually happen.
      if (plan.trail) levels.push({ price: plan.trail.high * (1 - plan.trail.pct / 100), label: `trail ${plan.trail.pct}%`, role: 'trail' })
      if (plan.stopIf?.below !== undefined) levels.push({ price: plan.stopIf.below, label: 'invalid', role: 'invalidation' })
      if (plan.stopIf?.above !== undefined) levels.push({ price: plan.stopIf.above, label: 'invalid', role: 'invalidation' })
      return { id: a.config.id, name: a.config.name, levels }
    })
    .filter((h) => h.levels.length > 0)
}

/**
 * A position's intraday line. The shared `Sparkline` primitive refuses fewer
 * than three points and knows nothing about a reference level; both matter on
 * this row. Two closes still draw — a position opened half an hour ago has
 * exactly two — and the previous close is BOTH in the y-scale and on the chart
 * as a dashed rule, because without it the line only says which way the price
 * wandered, never whether the day is up or down.
 */
function PositionSparkline({ closes, prevClose, tone }: { closes: number[]; prevClose?: number; tone: 'up' | 'down' }): JSX.Element | null {
  if (closes.length < 2) return null
  const W = 72
  const H = 22
  const all = prevClose !== undefined ? [...closes, prevClose] : closes
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const x = (i: number): number => (i / (closes.length - 1)) * W
  const y = (v: number): number => 2 + (1 - (v - min) / span) * (H - 4)
  const pts = closes.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const stroke = tone === 'up' ? 'var(--color-up)' : 'var(--color-down)'
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 overflow-visible" aria-hidden>
      {prevClose !== undefined && (
        <line x1={0} x2={W} y1={y(prevClose)} y2={y(prevClose)} stroke="var(--color-muted)" strokeOpacity={0.45} strokeWidth={1} strokeDasharray="1.5 3" />
      )}
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function PortfolioPanel(): JSX.Element {
  const rh = useApp((s) => s.robinhood)
  const toggle = useApp((s) => s.togglePortfolio)
  const agents = useApp((s) => s.agents)
  const marks = useApp((s) => s.marks)
  const openPaper = useApp((s) => s.openPaper)
  const [tab, setTab] = useState<Tab>('live')
  const [acct, setAcct] = useState<AccountSnapshot | null>(null)
  const acctRef = useRef<AccountSnapshot | null>(null)
  acctRef.current = acct
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [sparks, setSparks] = useState<Record<string, number[]>>({})
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ account: true, positions: true })

  const load = async (withSparks: boolean): Promise<void> => {
    if (!rh?.connected) return
    setLoading(true)
    try {
      const a = await window.tb.robinhood.account()
      setAcct(a)
      setErr(null)
      // The snapshot already carries quotes for everything the day figure
      // needs — the holdings AND every symbol traded today — so seed from it.
      const seeded = 'quotes' in a && a.quotes && typeof a.quotes === 'object' ? (a.quotes as Record<string, Quote>) : {}
      if (Object.keys(seeded).length) setQuotes((prev) => ({ ...prev, ...seeded }))
      const held = a.positions.map((p) => p.symbol)
      // Quote today's traded symbols too, not only what is held: a position
      // held overnight and sold out this morning has no row, but its move from
      // yesterday's close is part of today. Quoting only holdings left a flat
      // book with NO quotes, so an overnight loss on a name sold this morning
      // was valued at its own sell price and the day understated the broker's.
      const syms = [...new Set([...held, ...(a.fillsToday ?? []).map((f) => f.symbol)])]
      if (syms.length) {
        void window.tb.robinhood
          .quotes(syms)
          .then((qs) => setQuotes((prev) => ({ ...prev, ...Object.fromEntries(qs.map((q) => [q.symbol, q])) })))
          .catch(() => undefined)
        if (withSparks && held.length) void window.tb.robinhood.sparks(held).then(setSparks).catch(() => undefined)
      }
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(true)
    const q = setInterval(() => void load(false), POLL_MS)
    const s = setInterval(() => {
      // Read positions through the ref — the effect closes over the connect-time
      // (null) snapshot otherwise and would fetch nothing forever.
      const syms = acctRef.current?.positions.map((p) => p.symbol) ?? []
      if (syms.length) void window.tb.robinhood.sparks(syms).then(setSparks).catch(() => undefined)
    }, SPARK_MS)
    return () => {
      clearInterval(q)
      clearInterval(s)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rh?.connected])

  const agentList = useMemo(() => Object.values(agents), [agents])

  // ONE computation (`shared/portfolio.ts`): the day figure is
  // the account's equity against yesterday's close, rebuilt from today's
  // fills — not the day move of whatever is held right now. Each row also
  // carries the exits the engine will enforce on it, for the gauge.
  const day = useMemo(() => {
    if (!acct) return null
    const input = { ...acct, quotes, sparks }
    const avgCost = new Map(acct.positions.map((p) => [p.symbol, p.avgCost]))
    return { rows: portfolioRows(input).map((r) => ({ ...r, exits: armedExitsFor(agentList, r.symbol, avgCost.get(r.symbol) ?? 0) })), ...portfolioTotals(input) }
  }, [acct, quotes, sparks, agentList])
  const rows = day?.rows ?? []
  const equity = day?.equity ?? 0
  const dayChange = day?.dayChange ?? 0
  const dayPct = day?.dayPct ?? 0

  const paper = useMemo(() => paperPortfolio(agentList, marks, etClock().date, etDateOf), [agentList, marks])

  const tabs = (
    <div className="seg mt-3 w-full no-drag" role="tablist" aria-label="Which book">
      {(
        [
          { value: 'live', label: 'Robinhood' },
          { value: 'paper', label: 'Paper' }
        ] as { value: Tab; label: string }[]
      ).map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={tab === o.value} data-on={tab === o.value} className="seg-item" onClick={() => setTab(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )

  if (tab === 'paper')
    return (
      <Shell
        title="Paper"
        onHide={toggle}
        head={
          <>
            {/* Same rule as the page: the headline figure is true, it just is not
                all marks, and it must say so where it is stated. */}
            <Headline equity={paper.totalEquity} dayChange={paper.dayPnl} note={paper.marked ? undefined : `cash ${money(paper.totalCash, 0)} · rest at cost`} />
            {tabs}
          </>
        }
      >
        {paper.rows.length === 0 ? (
          <EmptyState icon={<FlaskConical size={17} strokeWidth={1.7} />} title="No paper agents yet." body="Every agent starts in paper — the book shows up here on its first run." />
        ) : (
          <>
            <div className="px-3 pt-3 grid grid-cols-2 gap-2">
              <StatTile label="All-time" value={<Money value={paper.totalPnl} />} />
              <StatTile label="Realized" value={<Money value={paper.realizedPnl} />} />
            </div>
            {/* Cost-valued holdings make the unrealized figures understate movement; realized is exact. */}
            {!paper.marked && (
              <p className="px-3 pt-2.5 text-xs text-warn leading-relaxed">
                {paper.unmarked.slice(0, 2).join(', ')}
                {paper.unmarked.length > 2 ? ` +${paper.unmarked.length - 2}` : ''} priced at cost — realized is exact.
              </p>
            )}
            <div className="mt-2 divide-hair">
              {paper.rows.slice(0, 8).map((r) => (
                <div key={r.id} className="row flex items-center gap-2 px-3 h-[var(--h-row)]">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{r.name}</div>
                    <div className="text-2xs text-muted">{r.retired ? 'Retired' : r.openPositions === 0 ? 'Flat' : `${r.openPositions} position${r.openPositions === 1 ? '' : 's'}`}</div>
                  </div>
                  <Money value={r.totalPnl} className="text-sm font-medium shrink-0" />
                </div>
              ))}
            </div>
            <div className="p-3">
              <button className="btn btn-ghost btn-sm w-full" onClick={openPaper}>
                All-time detail
              </button>
            </div>
          </>
        )}
      </Shell>
    )

  return (
    <Shell
      title="Robinhood"
      onHide={toggle}
      actions={
        <button className="btn-icon" title="Refresh" aria-label="Refresh the account" onClick={() => void load(true)}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      }
      head={
        <>
          {/* No account, no figure: the headline appears only once there is a
              real balance behind it. The state itself is stated in the body. */}
          {/* The orders call can fail on its own; the figure is then the move of
              what is held, minus today's trades, and must say so. */}
          {rh?.connected && acct && <Headline equity={equity} dayChange={dayChange} dayPct={dayPct} note={day?.fillsKnown === false ? "today's trades not counted" : undefined} />}
          {tabs}
        </>
      }
    >
      {/* Not connected, connected-but-failed and connected-but-waiting are three
          different answers, and a balance is shown in none of them: an unknown
          book must render nothing rather than a placeholder number. */}
      {!rh?.connected ? (
        <EmptyState icon={<Plug size={17} strokeWidth={1.7} />} title="Not connected" body="Connect Robinhood to see your portfolio." />
      ) : !acct && err ? (
        <EmptyState
          icon={<TriangleAlert size={17} strokeWidth={1.7} />}
          title="Could not read the account"
          body={err}
          action={
            <button className="btn btn-outline btn-sm" onClick={() => void load(true)}>
              Try again
            </button>
          }
        />
      ) : !acct ? (
        <div className="p-3 flex flex-col gap-2" aria-busy="true">
          <div className="skeleton h-14" />
          <div className="skeleton h-14" />
          <div className="skeleton h-14" />
        </div>
      ) : (
        <>
          {/* The figures above are the last good ones. Say the refresh failed
              rather than let a stale book pass for a current one. */}
          {err && (
            <p className="px-3 pt-2.5 text-xs text-warn leading-relaxed">
              <TriangleAlert size={11} className="inline -mt-0.5 mr-1" />
              Last refresh failed — {err}
            </p>
          )}
          <FoldHead title="Account" open={openSections.account} onToggle={() => setOpenSections((o) => ({ ...o, account: !o.account }))} />
          <div className="fold" data-open={openSections.account}>
            <div>
              <div className="px-3 pb-3 grid grid-cols-2 gap-2">
                <StatTile label="Buying power" value={<Amount value={acct.buyingPower} />} />
                <StatTile label="Cash" value={<Amount value={acct.cash} />} />
              </div>
            </div>
          </div>

          <FoldHead title="Positions" right={rows.length ? String(rows.length) : undefined} open={openSections.positions} onToggle={() => setOpenSections((o) => ({ ...o, positions: !o.positions }))} />
          <div className="fold" data-open={openSections.positions}>
            <div>
              {rows.length === 0 ? (
                <EmptyState icon={<Wallet size={17} strokeWidth={1.7} />} title="No open positions." body="Nothing held in this account right now." />
              ) : (
                <div className="divide-hair pb-2">
                  {rows.map((r) => (
                    <div key={r.symbol} className="row px-3 py-2" title={`${r.qty} shares · ${money(r.value)}`}>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0">
                          <TickerChip symbol={r.symbol} qty={r.qty} />
                          <div className="text-2xs text-muted nums mt-1">{money(r.value, 0)}</div>
                        </div>
                        <div className="flex-1 flex justify-end">
                          <PositionSparkline closes={r.closes} prevClose={r.prevClose} tone={(r.changePct ?? 0) >= 0 ? 'up' : 'down'} />
                        </div>
                        <div className="w-[66px] shrink-0 text-right">
                          <div className="text-sm font-medium money">{money(r.last)}</div>
                          <div className={cn('text-xs money', pnlClass(r.changePct))}>{r.changePct === undefined ? '—' : `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%`}</div>
                        </div>
                      </div>
                      {/* Every armed exit on one price line — what the engine will
                          do with these shares without being asked. One gauge PER
                          agent: the levels belong to that agent's own sub-ledger,
                          so folding several holders into a single line would draw
                          one agent's plan over the whole account position. */}
                      {r.exits.map((h) => (
                        <div key={h.id} className="mt-2 pb-1">
                          <DepthGauge price={r.last} levels={h.levels} />
                          <div className="text-2xs text-muted mt-1">exits armed by {h.name}</div>
                        </div>
                      ))}
                      {r.exits.length > 1 && (
                        <div className="text-2xs text-muted pb-1">Each agent enforces only its own shares — these are not one plan for the position.</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Shell>
  )
}

/** The panel's chrome: drag strip, title bar, the tab's head, then the scroller. */
function Shell({ title, head, actions, onHide, children }: { title: string; head: ReactNode; actions?: ReactNode; onHide: () => void; children: ReactNode }): JSX.Element {
  return (
    <aside className="panel hair-l h-full w-80 shrink-0 flex flex-col" aria-label="Portfolio">
      <div className="drag h-10 shrink-0" />
      <div className="px-3 pb-3 hair-b">
        <div className="flex items-center gap-1 no-drag">
          <h2 className="text-base font-semibold flex-1 truncate">{title}</h2>
          {actions}
          <button className="btn-icon" title="Hide portfolio" aria-label="Hide portfolio" onClick={onHide}>
            <PanelRightClose size={14} />
          </button>
        </div>
        {head}
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </aside>
  )
}

function FoldHead({ title, open, onToggle, right }: { title: string; open: boolean; onToggle: () => void; right?: string }): JSX.Element {
  return (
    <button className="row w-full flex items-center gap-2 px-3 h-8" onClick={onToggle} aria-expanded={open}>
      <span className="eyebrow flex-1 text-left">{title}</span>
      {right && <span className="text-xs text-muted nums">{right}</span>}
      <ChevronDown size={13} className="text-muted transition-transform duration-[var(--dur)]" style={{ transform: open ? undefined : 'rotate(-90deg)', transitionTimingFunction: 'var(--ease-out)' }} />
    </button>
  )
}
