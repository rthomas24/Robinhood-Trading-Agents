import type { JSX, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { cn, money, pnlClass, signedMoney } from '@renderer/lib/format'
import { layoutGaugeLabels } from '@renderer/lib/gaugeLayout'

/**
 * The design-system primitives — the small, repeated pieces the whole interface is
 * assembled from. They exist so a ticker, a figure, a stat and a level gauge
 * look identical in the sidebar, a tool row, a trade receipt and the portfolio
 * panel: density and voice both come from using ONE of each everywhere.
 *
 * Every one of them is pure presentation. None reads the store, none calls the
 * bridge, none formats money itself — `lib/format.ts` does that.
 */

/* ───────────────────────────── money ──────────────────────────────────── */

/**
 * A P&L figure. Always signed, always tabular, coloured only when it is money
 * (rule 2: green and red mean money and nothing else).
 *
 * There is deliberately no way to ask for an uncoloured P&L: draining the
 * colour is the operator's decision, made once for the whole app by calm mode
 * (`data-calm="1"`), never a per-figure one. A number the app decided to mute
 * on its own would be a P&L that reads differently depending on where it was
 * printed.
 */
export function Money({ value, className, pct: pctValue }: { value: number; className?: string; pct?: number }): JSX.Element {
  return (
    <span className={cn('money', pnlClass(value), className)}>
      {signedMoney(value)}
      {pctValue !== undefined && Number.isFinite(pctValue) && <span className="opacity-70"> ({pctValue >= 0 ? '+' : '−'}{Math.abs(pctValue).toFixed(2)}%)</span>}
    </span>
  )
}

/** An absolute amount — a balance, a cap, a notional. Never coloured. */
export function Amount({ value, className, decimals }: { value: number; className?: string; decimals?: number }): JSX.Element {
  return <span className={cn('money', className)}>{money(value, decimals)}</span>
}

/* ───────────────────────────── ticker ─────────────────────────────────── */

/**
 * The atomic unit of the interface: `NVDA 118.20 ▲0.6%`. The symbol is mono so
 * tickers of different lengths still align in a column; the price is tabular so
 * it does not jitter as it updates.
 */
export function TickerChip({ symbol, price, changePct, qty, className, title }: { symbol: string; price?: number; changePct?: number; qty?: number; className?: string; title?: string }): JSX.Element {
  const dir = changePct === undefined ? 0 : changePct > 0.0001 ? 1 : changePct < -0.0001 ? -1 : 0
  return (
    <span title={title} className={cn('ticker', className)}>
      <span className="ticker-sym">{symbol}</span>
      {qty !== undefined && <span className="ticker-px">×{qty}</span>}
      {price !== undefined && <span className="ticker-px">{price.toFixed(2)}</span>}
      {changePct !== undefined && Number.isFinite(changePct) && (
        <span className={cn('text-2xs money', dir > 0 ? 'money-up' : dir < 0 ? 'money-down' : 'text-text-3')}>
          {dir > 0 ? '▲' : dir < 0 ? '▼' : '·'}
          {Math.abs(changePct).toFixed(2)}%
        </span>
      )}
    </span>
  )
}

/* ──────────────────────────── stat tiles ──────────────────────────────── */

export function StatTile({ label, value, sub, tone, className }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' | 'warn' | 'muted'; className?: string }): JSX.Element {
  return (
    <div className={cn('stat', className)}>
      <div className="stat-label">{label}</div>
      <div className={cn('stat-value', tone === 'up' && 'money-up', tone === 'down' && 'money-down', tone === 'warn' && 'text-warn', tone === 'muted' && 'text-muted')}>{value}</div>
      {sub !== undefined && <div className="stat-sub truncate">{sub}</div>}
    </div>
  )
}

/** The one headline figure a surface is allowed, with its period stated. */
export function HeroFigure({ value, caption, tone, className }: { value: string; caption?: ReactNode; tone?: 'up' | 'down'; className?: string }): JSX.Element {
  return (
    <div className={className}>
      <div className={cn('hero-num', tone === 'up' && 'money-up', tone === 'down' && 'money-down')}>{value}</div>
      {caption !== undefined && <div className="text-xs text-muted mt-1">{caption}</div>}
    </div>
  )
}

/* ────────────────────────────── meters ────────────────────────────────── */

/**
 * A bounded quantity: allocation deployed, agent slots in use, how close the
 * day is to its loss limit. Warns at 60 % and turns to the loss colour at 100 %,
 * so the same bar carries the same meaning everywhere it appears.
 */
export function Meter({ value, max = 1, className, warnAt = 0.6, quiet }: { value: number; max?: number; className?: string; warnAt?: number; quiet?: boolean }): JSX.Element {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  const level = ratio >= 1 ? 'over' : ratio >= warnAt ? 'warn' : 'ok'
  return (
    <div className={cn('meter', className)} data-level={level} data-tone={quiet && level === 'ok' ? 'quiet' : undefined} role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${ratio * 100}%` }} />
    </div>
  )
}

/* ─────────────────────────── depth gauge ──────────────────────────────── */

export interface GaugeLevel {
  /** Where on the price axis. */
  price: number
  label: string
  /** Coloured by ROLE, never by up/down — a stop is a stop whichever way it sits. */
  role: 'stop' | 'target' | 'trail' | 'breakEven' | 'invalidation' | 'cost'
}

const LEVEL_COLOR: Record<GaugeLevel['role'], string> = {
  stop: 'var(--color-down)',
  invalidation: 'var(--color-down)',
  target: 'var(--color-up)',
  trail: 'var(--color-warn)',
  breakEven: 'var(--color-muted)',
  cost: 'var(--color-muted)'
}

/** The line sits this far down; ticks start at the top and reach their label's row. */
const GAUGE_LINE_Y = 12
/** Where the first label row begins — just under the tick's default length. */
const GAUGE_LABEL_TOP = 24
/** One label row of `text-2xs` mono. */
const GAUGE_ROW_H = 13
/** JetBrains Mono at 10.5px advances 0.6em per glyph; the extra covers the sub-pixel drift. */
const GAUGE_CH = 6.4
/** A width to lay out against before the first measurement lands. */
const GAUGE_FALLBACK_W = 280

/**
 * One horizontal line with the live price on it and every armed exit marked —
 * "Exits are levels the engine enforces" made visible without a
 * chart. Used identically on a trade receipt, in the portfolio panel and in the
 * risk panel.
 *
 * Labels are laid out by `layoutGaugeLabels` against the measured track width:
 * a trail, a stop and an invalidation level a dollar apart keep their ticks
 * side by side and take their labels to separate rows, each tick reaching down
 * to its own word. The gauge grows a row at a time, so the caller need not
 * reserve space under it.
 */
export function DepthGauge({ price, levels, className }: { price: number; levels: GaugeLevel[]; className?: string }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pts = [price, ...levels.map((l) => l.price)].filter((n) => Number.isFinite(n) && n > 0)
  if (pts.length < 2) return null
  const lo = Math.min(...pts)
  const hi = Math.max(...pts)
  const span = hi - lo || 1
  // 6 % of padding on each end so a marker at the extreme is not clipped.
  const at = (n: number): number => 6 + ((n - lo) / span) * 88
  const track = width || GAUGE_FALLBACK_W
  const placed = layoutGaugeLabels(
    levels.map((l) => ({ x: (at(l.price) / 100) * track, width: l.label.length * GAUGE_CH })),
    track
  )
  const rows = placed.reduce((m, p) => Math.max(m, p.row + 1), 1)
  return (
    <div ref={ref} className={cn('relative select-none', className)} style={{ height: GAUGE_LABEL_TOP + rows * GAUGE_ROW_H }}>
      <div className="absolute left-0 right-0 h-px" style={{ top: GAUGE_LINE_Y, background: 'var(--color-hairline-strong)' }} />
      {levels.map((l, i) => {
        const p = placed[i]
        const tickH = GAUGE_LABEL_TOP + p.row * GAUGE_ROW_H
        return (
          <div key={`${l.role}-${l.price}`} title={`${l.label} ${l.price.toFixed(2)}`}>
            <div className="absolute top-0 w-px -translate-x-1/2" style={{ left: `${at(l.price)}%`, height: tickH, background: LEVEL_COLOR[l.role] }} />
            <div className="text-2xs mono absolute -translate-x-1/2 whitespace-nowrap leading-none" style={{ left: p.cx, top: tickH + 2, color: LEVEL_COLOR[l.role] }}>
              {l.label}
            </div>
          </div>
        )
      })}
      <div className="absolute -translate-x-1/2" style={{ left: `${at(price)}%`, top: GAUGE_LINE_Y - 5 }} title={`Now ${price.toFixed(2)}`}>
        <div className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--color-text)', boxShadow: '0 0 0 2px var(--color-surface)' }} />
      </div>
    </div>
  )
}

/* ──────────────────────────── sparkline ───────────────────────────────── */

/**
 * Word-sized, dependency-free, last point marked. Drawn only with three or more
 * points — two points is a line segment pretending to be a trend.
 */
export function Sparkline({ points, width = 58, height = 20, className, tone }: { points: number[]; width?: number; height?: number; className?: string; tone?: 'up' | 'down' | 'neutral' }): JSX.Element | null {
  if (points.length < 3) return null
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const span = hi - lo || 1
  const step = (width - 2) / (points.length - 1)
  const y = (n: number): number => height - 2 - ((n - lo) / span) * (height - 4)
  const d = points.map((n, i) => `${i === 0 ? 'M' : 'L'}${(1 + i * step).toFixed(2)} ${y(n).toFixed(2)}`).join(' ')
  const dir = tone ?? (points[points.length - 1] > points[0] ? 'up' : points[points.length - 1] < points[0] ? 'down' : 'neutral')
  const stroke = dir === 'up' ? 'var(--color-up)' : dir === 'down' ? 'var(--color-down)' : 'var(--color-muted)'
  return (
    <svg className={cn('shrink-0 overflow-visible', className)} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={1 + (points.length - 1) * step} cy={y(points[points.length - 1])} r={2} fill={stroke} />
    </svg>
  )
}

/* ────────────────────────────── stamps ────────────────────────────────── */

/** A settled fact printed on a card: FILLED, SPENT, EXPIRED, PAPER. */
export function Stamp({ children, tone = 'muted', className, title }: { children: ReactNode; tone?: 'up' | 'down' | 'warn' | 'muted' | 'accent'; className?: string; title?: string }): JSX.Element {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent' : 'text-muted'
  return (
    <span className={cn('stamp', color, className)} title={title}>
      {children}
    </span>
  )
}

/* ─────────────────────────── empty states ─────────────────────────────── */

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center px-6 py-10 fade-in', className)}>
      {icon && <div className="mb-3.5 h-11 w-11 rounded-xl inset flex items-center justify-center text-muted">{icon}</div>}
      <p className="text-md font-medium">{title}</p>
      {body !== undefined && <p className="text-sm text-muted mt-1 max-w-[46ch] leading-relaxed">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/* ───────────────────────────── sections ───────────────────────────────── */

export function SectionHead({ title, hint, right, className }: { title: string; hint?: ReactNode; right?: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('flex items-start gap-3 mb-2.5', className)}>
      <div className="min-w-0 flex-1">
        <h4 className="text-base font-semibold tracking-[-0.01em]">{title}</h4>
        {hint !== undefined && <p className="hint mt-0.5">{hint}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}

/**
 * A statement line: label, dotted leader, figure. Deliberately unstyleable from
 * outside — every statement in the app is set at the same size and rhythm, and
 * a caller that could nudge one line would be the start of two.
 */
export function LedgerLine({ label, value }: { label: ReactNode; value: ReactNode }): JSX.Element {
  return (
    <div className="leader text-sm">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  )
}
