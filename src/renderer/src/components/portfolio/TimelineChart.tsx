import type { JSX, KeyboardEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { dayLabelLong, nearestPointIndex, signedMoney, timelineGeometry, type TimelineMetric, type TimelinePoint } from '@shared/timeline'
import { money } from '@renderer/lib/format'

/**
 * The portfolio line, drawn from shared geometry (`shared/timeline.ts`). Hover snaps a crosshair to the nearest day and shows a floating
 * card; the area fills between the line and $0 (P&L) tinted by where the range
 * ended. Points partly at cost are dimmed — a hollow dot, not a value.
 *
 * No charting library: the series is a few hundred points at most, the
 * design is flat, and one pure geometry function beats a dependency.
 *
 * The chart's identity is four horizontal rules and NOTHING vertical except the
 * crosshair the operator asked for: a grid of verticals on a series whose x axis
 * is "trading days that happened" implies an even cadence the data does not
 * have (gaps are gaps — see `portfolioSeries`).
 */

/**
 * Room on the right for the tick labels: drawn inside the plot they sat on top
 * of the line's last point (seen in the first render).
 */
const PAD = { top: 14, right: 64, bottom: 24, left: 10 }

export function TimelineChart({ points, metric, height = 220 }: { points: TimelinePoint[]; metric: TimelineMetric; height?: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const g = useMemo(() => timelineGeometry(points, width, height, metric, PAD), [points, width, height, metric])
  const tone = g.up ? 'var(--color-up)' : 'var(--color-down)'
  const gradId = useMemo(() => `tl-${Math.random().toString(36).slice(2, 8)}`, [])
  const i = hover !== null && hover >= 0 && hover < points.length ? hover : null
  const last = points.length - 1
  const plotRight = width - PAD.right
  const valueAt = (p: TimelinePoint): string => (metric === 'pnl' ? signedMoney(p.pnl) : money(p.equity))

  // Keyboard operability: a chart nobody can reach with a keyboard states its
  // numbers to nobody. Focus lands on the newest day; the arrows walk the
  // series exactly as the pointer does.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (last < 0) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const from = i ?? last
      setHover(Math.max(0, Math.min(last, from + (e.key === 'ArrowRight' ? 1 : -1))))
    } else if (e.key === 'Escape') setHover(null)
  }

  return (
    <div
      ref={ref}
      className="relative w-full select-none outline-none"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={
        last >= 0
          ? `${metric === 'pnl' ? 'Profit and loss' : 'Equity'} over ${points.length} trading days, ending ${valueAt(points[last])} on ${dayLabelLong(points[last].day)}. Use the arrow keys to read each day.`
          : 'No days to draw yet.'
      }
      onKeyDown={onKeyDown}
      onFocus={() => setHover((h) => h ?? (last >= 0 ? last : null))}
      onBlur={() => setHover(null)}
    >
      <svg width={width} height={height} className="block" onMouseMove={(e) => setHover(nearestPointIndex(g, e.nativeEvent.offsetX))} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity={0.28} />
            <stop offset="100%" stopColor={tone} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {g.yTicks.map((t) => {
          // $0 is the line the P&L is judged against, so it is drawn solid and a
          // shade stronger while every other rule stays a dotted hint.
          const zero = t.value === 0 && metric === 'pnl'
          return (
            <g key={t.value}>
              <line
                x1={PAD.left}
                x2={plotRight}
                y1={t.y}
                y2={t.y}
                stroke={zero ? 'var(--color-hairline-strong)' : 'var(--color-line-faint)'}
                strokeDasharray={zero ? undefined : '2 5'}
                strokeWidth={1}
              />
              <text x={plotRight + 8} y={t.y + 3} textAnchor="start" fontSize={10.5} fill="var(--color-text-3)" className="nums">
                {metric === 'pnl' ? signedMoney(t.value).replace(/\.00$/, '') : money(t.value, 0)}
              </text>
            </g>
          )
        })}
        {g.areaPath && <path d={g.areaPath} fill={`url(#${gradId})`} />}
        <path d={g.linePath} fill="none" stroke={tone} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, k) => (!p.marked ? <circle key={p.day} cx={g.xs[k]} cy={g.ys[k]} r={3} fill="var(--color-bg)" stroke="var(--color-warn)" strokeWidth={1.5} /> : null))}
        {last >= 0 && i === null && (
          <g>
            <circle cx={g.xs[last]} cy={g.ys[last]} r={6} fill={tone} opacity={0.18} />
            <circle cx={g.xs[last]} cy={g.ys[last]} r={3} fill={tone} />
          </g>
        )}
        {i !== null && (
          <g>
            <line x1={g.xs[i]} x2={g.xs[i]} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--color-hairline-strong)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={g.xs[i]} cy={g.ys[i]} r={4} fill={tone} stroke="var(--color-bg)" strokeWidth={2} />
          </g>
        )}
        {g.xTicks.map((t, k) => (
          <text key={t.label + k} x={t.x} y={height - 7} textAnchor={k === 0 ? 'start' : k === g.xTicks.length - 1 ? 'end' : 'middle'} fontSize={10.5} fill="var(--color-text-3)">
            {t.label}
          </text>
        ))}
      </svg>
      {i !== null && (
        <div
          className="card-float absolute top-1.5 pointer-events-none px-2.5 py-1.5 pop-in"
          style={{ left: Math.min(Math.max(g.xs[i] - 70, 0), Math.max(0, width - 160)) }}
          role="status"
        >
          <div className="text-2xs text-muted">{dayLabelLong(points[i].day)}</div>
          <div className="text-md font-medium money mt-0.5">{valueAt(points[i])}</div>
          <div className="text-2xs text-muted nums mt-0.5">
            {metric === 'pnl' ? `equity ${money(points[i].equity)}` : `P&L ${signedMoney(points[i].pnl)}`}
            {points[i].carried > 0 && ` · ${points[i].carried} carried`}
            {!points[i].marked && ' · partly at cost'}
          </div>
        </div>
      )}
    </div>
  )
}
