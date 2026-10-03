import type { JSX, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { ArrowLeft, Check, Copy, FlaskConical, Radio, Wallet } from 'lucide-react'
import { fleetScorecardText } from '@shared/scorecard'
import { livePortfolio, paperPortfolio, type PaperAgentRow, type PaperPortfolio } from '@shared/agents'
import { etClock } from '@shared/marketTime'
import { useApp } from '@renderer/store/appStore'
import { Amount, EmptyState, HeroFigure, Meter, Money, SectionHead, Stamp, StatTile } from '@renderer/components/common/Primitives'
import { money, pnlClass, signedMoney } from '@renderer/lib/format'
import { PortfolioTimeline } from './PortfolioTimeline'

const etDateOf = (iso: string): string => etClock(new Date(iso)).date
const pct = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%`
/**
 * The hero figure's tone, READ OFF `pnlClass` rather than re-testing the neutral
 * band. The band was hand-copied into four places and a fifth copy is how the
 * big number ends up green while every figure under it is grey.
 */
const toneOf = (n: number): 'up' | 'down' | undefined => {
  const c = pnlClass(n)
  return c === 'text-up' ? 'up' : c === 'text-down' ? 'down' : undefined
}
/** Shares without the trailing zeros a 4dp fraction leaves behind. */
const shares = (qty: number): string => qty.toFixed(4).replace(/\.?0+$/, '')

/**
 * The all-time paper book. Separate from the Robinhood panel because the two
 * answer different questions: that one is what you own, this one is what the
 * agents would have done. Mixing them into one equity figure would be the worst
 * possible answer to both.
 */
export function PaperPortfolioPage(): JSX.Element {
  const agents = useApp((s) => s.agents)
  const marks = useApp((s) => s.marks)
  const openAgent = useApp((s) => s.select)
  const openAccount = useApp((s) => s.openAccount)

  const p = useMemo(
    () => paperPortfolio(Object.values(agents), marks, etClock().date, etDateOf),
    [agents, marks]
  )
  // The live side — each agent's OWN sub-ledger, never the shared Robinhood
  // account. Its own call and its own tiles, so the two are never one number.
  const lp = useMemo(
    () => livePortfolio(Object.values(agents), marks, etClock().date, etDateOf),
    [agents, marks]
  )
  const hasLive = lp.rows.length > 0

  // One side's books as text, for pasting. Paper and live are separate buttons
  // because they are separate texts — never one number, never one card.
  const [copied, setCopied] = useState<'paper' | 'live' | null>(null)
  const copyFleet = (side: 'paper' | 'live'): void => {
    void navigator.clipboard
      .writeText(fleetScorecardText(side, side === 'live' ? lp : p))
      .then(() => {
        setCopied(side)
        window.setTimeout(() => setCopied(null), 1500)
      })
      .catch(() => undefined)
  }

  const live = p.rows.filter((r) => !r.retired)
  const retired = p.rows.filter((r) => r.retired)

  return (
    <section className="flex-1 min-w-0 h-full flex flex-col bg-bg">
      {/* Same height and rule as the thread and account headers: this page swaps
          into that slot, and a 8px jump on every switch is a jump. */}
      <header className="drag h-14 shrink-0 flex items-center gap-3 px-5 hair-b">
        <button className="btn-icon no-drag" title="Back" aria-label="Back" onClick={() => openAccount()}>
          <ArrowLeft size={15} />
        </button>
        <FlaskConical size={15} className="text-muted shrink-0" />
        <h1 className="text-md font-semibold truncate">{hasLive ? 'Agent books' : 'Paper portfolio'}</h1>
        <span className="pill">{hasLive ? 'all time · paper and live, never added together' : 'simulated · all time'}</span>
        {p.rows.length > 0 && (
          <button
            className="btn btn-outline btn-sm ml-auto no-drag"
            onClick={() => copyFleet('paper')}
            title="Copy every paper agent's standing as plain text — labelled paper, per agent, never a forecast"
          >
            {copied === 'paper' ? <Check size={12} /> : <Copy size={12} />} {copied === 'paper' ? 'Copied' : 'Copy paper scorecard'}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-6 py-6">
          {hasLive && (
            <SectionHead
              className="mb-3"
              title="Paper"
              hint="Simulated money — what the agents would have done."
              right={<span className="pill pill-paper">simulated</span>}
            />
          )}

          {p.rows.length === 0 ? (
            <div className="card">
              <EmptyState
                icon={<Wallet size={18} strokeWidth={1.7} />}
                title="No paper agents yet"
                body="Every agent starts in paper mode — make one and it shows up here."
              />
            </div>
          ) : (
            <div className="flex flex-col gap-7">
              <div>
                <BookSummary book={p} kind="paper" />
                {/*
                  The unmarked warning is not decoration. An unmarked book is valued
                  at COST, so its unrealized P&L is exactly zero by construction —
                  printing that as a real number is the failure `BookPnl.marked`
                  exists to prevent. Realized is unaffected, which is why the tile
                  above says so.
                */}
                {!p.marked && (
                  <p className="mt-3 text-sm text-warn leading-relaxed">
                    No live price yet for {p.unmarked.slice(0, 4).join(', ')}
                    {p.unmarked.length > 4 ? ` and ${p.unmarked.length - 4} more` : ''} — those holdings are counted at cost, so
                    the unrealized figures understate movement until a quote arrives. <strong>Realized is exact regardless.</strong>
                  </p>
                )}
              </div>

              <PortfolioTimeline mode="paper" />

              {p.positions.length > 0 && <PositionsTable title="Open paper positions" positions={p.positions} />}

              <AgentTable title="Agents" rows={live} onOpen={openAgent} />
              {retired.length > 0 && (
                <AgentTable
                  title="Retired"
                  rows={retired}
                  onOpen={openAgent}
                  note="Retired agents still count — stopping one does not un-happen its trades."
                />
              )}
            </div>
          )}

          {hasLive && (
            <div className="mt-10 pt-7 hair-t flex flex-col gap-7">
              <div>
                <SectionHead
                  className="mb-3"
                  title="Live"
                  hint={
                    /* Each agent's OWN fills — the sub-ledger — never the whole Robinhood
                       account, which the Robinhood panel already shows. The same marks
                       rules as the paper side: unmarked holdings sit at cost, realized is
                       exact regardless. */
                    'What your live agents did with real money — each counted by its own fills only, never the whole Robinhood account (that is the Robinhood panel). Paper and live are never added together.'
                  }
                  right={
                    <span className="pill pill-live">
                      <Radio size={10} /> real fills
                    </span>
                  }
                />
                <BookSummary book={lp} kind="live" />
                {!lp.marked && (
                  <p className="mt-3 text-sm text-warn leading-relaxed">
                    No live price yet for {lp.unmarked.slice(0, 4).join(', ')}
                    {lp.unmarked.length > 4 ? ` and ${lp.unmarked.length - 4} more` : ''} — those holdings are counted at cost. <strong>Realized is exact regardless.</strong>
                  </p>
                )}
                <button
                  className="btn btn-outline btn-sm mt-3"
                  onClick={() => copyFleet('live')}
                  title="Copy every live agent's standing as plain text — labelled live, each agent's own fills only, never a forecast"
                >
                  {copied === 'live' ? <Check size={12} /> : <Copy size={12} />} {copied === 'live' ? 'Copied' : 'Copy live scorecard'}
                </button>
              </div>

              <AgentTable title="Live agents" rows={lp.rows.filter((r) => !r.retired)} onOpen={openAgent} />
              <AgentTable
                title="Retired live agents"
                rows={lp.rows.filter((r) => r.retired)}
                onOpen={openAgent}
                note="Retired agents still count — stopping one does not un-happen its trades."
              />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * One book's headline. P&L leads, because the page is about performance and an
 * equity figure answers a different question — and because allocating capital
 * is not a gain (the same rule the timeline draws).
 */
function BookSummary({ book, kind }: { book: PaperPortfolio; kind: 'paper' | 'live' }): JSX.Element {
  return (
    <div>
      <HeroFigure
        value={signedMoney(book.totalPnl)}
        tone={toneOf(book.totalPnl)}
        caption={
          <>
            All-time {kind === 'live' ? 'live' : 'paper'} P&amp;L · {book.marked ? pct(book.totalPct) : 'part cost-based'}
          </>
        }
      />
      <div className="grid grid-cols-4 gap-2.5 mt-4">
        {/* Cash is real in every book; an unmarked position is carried at cost,
            which is a floor rather than a fiction. So the number stays and the
            label says what it is — blanking a true figure to avoid an untrue
            implication throws away more than it protects. */}
        <StatTile
          label={kind === 'live' ? 'Live equity' : 'Paper equity'}
          value={<Amount value={book.totalEquity} />}
          sub={book.marked ? `across ${book.rows.length} agent${book.rows.length === 1 ? '' : 's'}` : `cash ${money(book.totalCash, 0)} · rest at cost`}
        />
        <StatTile label="Realized" value={<Money value={book.realizedPnl} />} sub="closed trades — exact" />
        <StatTile label="Today" value={<Money value={book.dayPnl} />} sub="since the previous close" />
        <StatTile label="Allocated" value={<Amount value={book.totalAllocated} decimals={0} />} sub="capital at work" />
      </div>
    </div>
  )
}

/** Every symbol the side holds, heaviest first, with its share of the book. */
function PositionsTable({ title, positions }: { title: string; positions: PaperPortfolio['positions'] }): JSX.Element {
  const total = positions.reduce((s, x) => s + x.value, 0)
  return (
    <section>
      <SectionHead title={title} hint={`${positions.length} symbol${positions.length === 1 ? '' : 's'} across the book`} />
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">Shares</th>
              <th>Weight</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((pos) => (
              <tr key={pos.symbol}>
                <td>
                  <span className="mono text-base font-medium">{pos.symbol}</span>
                  {pos.agents > 1 && <span className="text-xs text-muted ml-2">held by {pos.agents} agents</span>}
                  {!pos.marked && (
                    <Stamp tone="warn" className="ml-2">
                      at cost
                    </Stamp>
                  )}
                </td>
                <td className="num text-muted">{shares(pos.qty)}</td>
                <td>
                  <WeightBar ratio={total > 0 ? pos.value / total : 0} />
                </td>
                <td className="num">
                  <Amount value={pos.value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * Full scale is a hair above 1 on purpose. `Meter` paints `data-level="over"`
 * in the loss colour the instant value meets max, and a symbol that IS the whole
 * book is a concentration fact, not a loss — red there would be a colour telling
 * an untruth. At this epsilon the bar still reads as full and the figure beside
 * it still says 100%.
 */
const WEIGHT_FULL = 1.0001
/** Out of range: weight never warns (see below), so the threshold must never bite. */
const WEIGHT_NEVER_WARNS = 2

/**
 * Share of the book, drawn achromatically on purpose: weight is neither good
 * nor bad, and the meter's warn/over colours would claim it was. That is what
 * `quiet` is for — the shared `Meter`, held in its reporting register, rather
 * than a second bar with its own geometry and its own hand-mixed grey.
 */
function WeightBar({ ratio }: { ratio: number }): JSX.Element {
  const clamped = Math.max(0, Math.min(1, ratio))
  return (
    <div className="flex items-center gap-2" title={`${(clamped * 100).toFixed(1)}% of the book`}>
      <Meter value={clamped} max={WEIGHT_FULL} warnAt={WEIGHT_NEVER_WARNS} quiet className="w-20" />
      <span className="text-xs text-muted nums w-9">{(clamped * 100).toFixed(0)}%</span>
    </div>
  )
}

function AgentTable({
  title,
  rows,
  onOpen,
  note
}: {
  title: string
  rows: PaperAgentRow[]
  onOpen: (id: string) => void
  note?: ReactNode
}): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <section>
      <SectionHead title={title} hint={note} />
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Agent</th>
              <th className="num">Allocated</th>
              <th className="num">Equity</th>
              <th className="num">All-time</th>
              <th className="num">Realized</th>
              <th className="num">Trades</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                tabIndex={0}
                aria-label={`Open ${r.name}`}
                onClick={() => onOpen(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(r.id)
                  }
                }}
                className="row cursor-default"
                title={r.marked ? undefined : `No price yet for ${r.unmarked.join(', ')} — valued at cost.`}
              >
                <td>
                  <div className="font-medium truncate max-w-[22ch]">{r.name}</div>
                  <div className="text-xs text-muted">
                    {r.openPositions === 0 ? 'flat' : `${r.openPositions} position${r.openPositions === 1 ? '' : 's'}`}
                    {!r.marked && ' · at cost'}
                  </div>
                </td>
                <td className="num text-muted">
                  <Amount value={r.allocationUsd} decimals={0} />
                </td>
                <td className="num">
                  <Amount value={r.equity} />
                </td>
                {/* Only a percentage we can stand behind: an unmarked book's is 0 by construction. */}
                <td className="num font-medium">
                  <Money value={r.totalPnl} pct={r.marked ? r.totalPct * 100 : undefined} />
                </td>
                <td className="num">
                  <Money value={r.realizedPnl} />
                </td>
                <td className="num text-muted nums">{r.trades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
