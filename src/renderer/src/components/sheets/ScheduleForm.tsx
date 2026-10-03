import type { JSX } from 'react'
import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { Schedule } from '@shared/agents'
import { describeSchedule } from '@shared/schedule'
import { TRADING_WEEKDAYS, WEEKDAYS, type Weekday } from '@shared/marketTime'
import { Segmented } from '@renderer/components/common/Sheet'
import { cn } from '@renderer/lib/format'

/** Presets for the interval field — a cadence is picked far more often than it is typed. */
const INTERVALS = [5, 15, 30, 60] as const

/**
 * "When does it wake up." Each kind shows ONLY its own fields, and whatever the
 * operator builds is read back as one sentence (`describeSchedule` — the same
 * string the model is given in its system prompt), so the control and the agent
 * never describe the schedule differently.
 */
export function ScheduleForm({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }): JSX.Element {
  const [newTime, setNewTime] = useState('')
  const kind = value.kind
  const setKind = (k: Schedule['kind']): void => {
    if (k === kind) return
    if (k === 'manual') onChange({ kind: 'manual' })
    else if (k === 'interval') onChange({ kind: 'interval', everyMinutes: 5, marketHoursOnly: true })
    else if (k === 'times') onChange({ kind: 'times', times: ['09:31'], days: [...TRADING_WEEKDAYS], tradingDaysOnly: true })
    else onChange({ kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() })
  }
  /** Adding a time is idempotent and sorted — the same instant twice is one wake-up. */
  const addTime = (): void => {
    if (value.kind !== 'times' || !newTime) return
    if (!value.times.includes(newTime)) onChange({ ...value, times: [...value.times, newTime].sort() })
    setNewTime('')
  }
  return (
    <div>
      <Segmented
        block
        value={kind}
        onChange={setKind}
        options={[
          { value: 'times', label: 'At times' },
          { value: 'interval', label: 'Every N min' },
          { value: 'once', label: 'Once' },
          { value: 'manual', label: 'Manual' }
        ]}
      />
      <div className="mt-3">
        {value.kind === 'times' && (
          <div className="flex flex-col gap-3">
            <div>
              <div className="eyebrow mb-1.5">Wake-ups (ET)</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {value.times.map((t) => (
                  <span key={t} className="chip pr-1 nums">
                    {t}
                    <button
                      type="button"
                      className="btn-icon h-4 w-4 rounded-xs"
                      aria-label={`Remove ${t} ET`}
                      title={`Remove ${t} ET`}
                      onClick={() => onChange({ ...value, times: value.times.filter((x) => x !== t) })}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
                <span className="inline-flex items-center gap-1">
                  <input
                    type="time"
                    aria-label="Add a wake-up time (ET)"
                    className="input w-auto h-[22px] py-0 px-1.5 text-xs nums"
                    value={newTime}
                    onChange={(e) => setNewTime(e.target.value)}
                    // Blur commits too: a time typed and then clicked away from
                    // is a time the operator meant to add.
                    onBlur={addTime}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addTime()
                      }
                    }}
                  />
                  <button type="button" className="btn-icon h-[22px] w-[22px] rounded-xs" aria-label="Add this time" title="Add this time" disabled={!newTime} onClick={addTime}>
                    <Plus size={12} />
                  </button>
                </span>
              </div>
              {value.times.length === 0 && <p className="hint mt-1.5 text-warn">Add at least one time, or the agent never wakes up on its own.</p>}
            </div>
            <div>
              <div className="eyebrow mb-1.5">Days</div>
              <div className="flex gap-1">
                {WEEKDAYS.map((d: Weekday) => {
                  const on = value.days.includes(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      title={d}
                      className={cn('h-7 w-9 rounded-sm text-xs font-medium transition-colors duration-[var(--dur-fast)]', on ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted hover:text-text')}
                      onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== d) : [...value.days, d] })}
                    >
                      {d.slice(0, 2)}
                    </button>
                  )
                })}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={value.tradingDaysOnly} onChange={(e) => onChange({ ...value, tradingDaysOnly: e.target.checked })} /> Skip market holidays
            </label>
          </div>
        )}
        {value.kind === 'interval' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-2 text-sm">
                Every
                <input
                  type="number"
                  min={1}
                  max={1440}
                  aria-label="Minutes between runs"
                  className="input w-20 h-7 py-0 nums"
                  value={value.everyMinutes}
                  onChange={(e) => onChange({ ...value, everyMinutes: Math.max(1, Number(e.target.value) || 1) })}
                />
                min
              </label>
              <div className="flex items-center gap-1">
                {INTERVALS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={value.everyMinutes === m}
                    className={cn('chip chip-btn nums', value.everyMinutes === m && 'text-accent')}
                    onClick={() => onChange({ ...value, everyMinutes: m })}
                  >
                    {m === 60 ? '1 h' : `${m}m`}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={value.marketHoursOnly} onChange={(e) => onChange({ ...value, marketHoursOnly: e.target.checked })} /> Market hours only
            </label>
          </div>
        )}
        {value.kind === 'once' && (
          <div>
            <div className="eyebrow mb-1.5">Date and time</div>
            <input type="datetime-local" aria-label="When to run" className="input w-auto nums" value={value.at.slice(0, 16)} onChange={(e) => onChange({ ...value, at: new Date(e.target.value).toISOString() })} />
          </div>
        )}
        {value.kind === 'manual' && <p className="hint">The agent only runs when you press Run now or message it.</p>}
      </div>
      {/* The cadence, in one sentence, whatever was just changed above. */}
      <p className="text-sm text-muted mt-3 nums">{describeSchedule(value)}</p>
    </div>
  )
}
