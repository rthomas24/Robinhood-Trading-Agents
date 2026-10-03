import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { TrendingUp } from 'lucide-react'
import { etClock } from '@shared/marketTime'
import {
  buildTimeline,
  dayLabel,
  formatChange,
  TIMELINE_RANGES,
  TIMELINE_RANGE_LABEL,
  type PeriodStat,
  type TimelineMetric,
  type TimelineRange,
  type TimelineRow
} from '@shared/timeline'
import { EmptyState, SectionHead, StatTile } from '@renderer/components/common/Primitives'
import { money, pnlClass } from '@renderer/lib/format'
import { TimelineChart } from './TimelineChart'

/**
 * "How has the paper book done over time?" — the one question the all-time
 * tiles cannot answer. Rows come from the local run log (the last book per
 * agent per ET day); everything from carry-forward to the axis is
 * `shared/timeline.ts`, so the numbers come from one pure place.
 *
 * Paper only, on purpose: this page IS the paper book, and a live sub-ledger
 * is a different question with a different answer (the Robinhood panel).
 */
export function PortfolioTimeline({ mode = 'paper' }: { mode?: 'paper' | 'live' }): JSX.Element | null {
  const [rows, setRows] = useState<TimelineRow[] | null>(null)
  const [range, setRange] = useState<TimelineRange>('1M')
  const [metric, setMetric] = useState<TimelineMetric>('pnl')

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.tb.agents.timeline().then((r) => alive && setRows(r)).catch(() => alive && setRows([]))
    }
    load()
    // A finished run is a new (or updated) day. Refetch on the end of any run,
    // throttled so a busy fleet does not turn into a query per tick.
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.tb.agents.onEvent((e) => {
      if (e.type !== 'run:delta' || e.delta.kind !== 'end') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 4_000)
    })
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      off()
    }
  }, [])

  const tl = useMemo(() => (rows ? buildTimeline(rows, { range, today: etClock().date, mode, metric }) : null), [rows, range, mode, metric])

  // Still fetching. A quiet placeholder of the chart's own size, so the page
  // does not jump by 300px the moment the rows land.
  if (rows === null)
    return (
      <section className="mt-1" aria-busy="true">
        <SectionHead title="P&L over time" hint="Loading the daily books…" />
        <div className="card overflow-hidden">
          <div className="skeleton h-[220px] rounded-none" />
        </div>
      </section>
    )

  if (!tl || tl.all.length === 0)
    return (
      <section className="mt-1">
        <SectionHead title="P&L over time" />
        <div className="card">
          <EmptyState
            icon={<TrendingUp size={18} strokeWidth={1.7} />}
            title="Nothing to plot yet"
            body="The timeline fills in as agents run — one point per trading day, from each run's closing book."
          />
        </div>
      </section>
    )

  const periods: { label: string; stat: PeriodStat }[] = [
    { label: 'Today', stat: tl.stats.day },
    { label: 'This week', stat: tl.stats.week },
    { label: 'This month', stat: tl.stats.month },
    { label: 'This year', stat: tl.stats.year },
    { label: 'All time', stat: tl.stats.all }
  ]

  return (
    <section className="mt-1">
      <SectionHead
        title={metric === 'pnl' ? 'P&L over time' : 'Equity over time'}
        hint={metric === 'pnl' ? 'Equity minus what was allocated — allocating capital is not a gain.' : 'What the books were worth at the end of each trading day.'}
        right={
          <div className="flex items-center gap-2">
            <Seg
              label="Metric"
              value={metric}
              onChange={(v) => setMetric(v as TimelineMetric)}
              options={[
                { value: 'pnl', label: 'P&L' },
                { value: 'equity', label: 'Equity' }
              ]}
            />
            <Seg label="Range" value={range} onChange={(v) => setRange(v as TimelineRange)} options={TIMELINE_RANGES.map((r) => ({ value: r, label: TIMELINE_RANGE_LABEL[r] }))} />
          </div>
        }
      />

      <div className="card overflow-hidden">
        {tl.empty ? (
          <div className="h-[220px] flex items-center justify-center">
            <EmptyState title="Not enough days in this range yet" body="Try a wider one." />
          </div>
        ) : (
          <TimelineChart points={tl.points} metric={metric} />
        )}
      </div>

      <div className="grid grid-cols-5 gap-2 mt-3">
        {periods.map((p) => (
          <StatTile key={p.label} label={p.label} value={p.stat.fromDay === null ? '—' : formatChange(p.stat)} sub={p.stat.fromDay === null ? undefined : `since ${dayLabel(p.stat.fromDay)}`} tone={statTone(p.stat)} />
        ))}
      </div>

      <p className="hint nums mt-2.5">
        {tl.stats.high && tl.stats.low && (
          <>
            Range high {money(tl.stats.high.value)} · low {money(tl.stats.low.value)}
          </>
        )}
        {tl.stats.bestDay && tl.stats.worstDay && (
          <>
            {' · '}best day <span className={pnlClass(tl.stats.bestDay.change)}>{formatChange({ fromDay: null, start: 0, end: 0, change: tl.stats.bestDay.change, changePct: null })}</span> · worst{' '}
            <span className={pnlClass(tl.stats.worstDay.change)}>{formatChange({ fromDay: null, start: 0, end: 0, change: tl.stats.worstDay.change, changePct: null })}</span>
          </>
        )}
        {tl.partlyAtCost && ' · hollow dots: a position had no quote that day, so the point is partly at cost.'}
      </p>
    </section>
  )
}

/** A period with no baseline has no colour to claim — it has no number either. */
function statTone(stat: PeriodStat): 'up' | 'down' | 'muted' {
  if (stat.fromDay === null) return 'muted'
  return stat.change > 0.004 ? 'up' : stat.change < -0.004 ? 'down' : 'muted'
}

function Seg({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }): JSX.Element {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} data-on={o.value === value} className="seg-item" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
