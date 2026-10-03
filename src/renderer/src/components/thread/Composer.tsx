import type { JSX, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { ArrowUp, Hourglass, Laptop } from 'lucide-react'

/**
 * The thread's input, and the ONE place that knows what a refusal looks like.
 *
 * `readOnlyReason` replaces the box rather than disabling it. A disabled input
 * invites typing and then swallows it; a sentence says why, once, before anyone
 * has spent a thought on the message.
 *
 * One component knows what "refused" looks like, so the app says no the same
 * way whatever the reason, and nobody reads two styles as two kinds of no.
 */
export function Composer({
  name,
  readOnlyReason,
  readOnlyIcon,
  readOnlyAction,
  onSend,
  chips = [],
  placeholder,
  sendTitle,
  queued = false
}: {
  name: string
  readOnlyReason?: string
  /** Defaults to the laptop — override when the refusal is not about the desktop. */
  readOnlyIcon?: ReactNode
  /** The way back in, shown WHERE the refusal is. A dead end with the remedy at
   *  the far end of the window is a worse answer than the refusal itself. */
  readOnlyAction?: ReactNode
  onSend: (text: string) => void
  chips?: string[]
  /**
   * Replaces "Message {name}…" — the thread sets it while a run is in flight,
   * so the box itself says the message will wait its turn rather than
   * interrupt (shared/messageQueue.ts). Never disabled: typing mid-run is
   * welcome, and a disabled box invites typing and then swallows it.
   */
  placeholder?: string
  sendTitle?: string
  /**
   * A run is in flight, so this message will be queued behind it. The
   * placeholder says so — until the first keystroke covers it, which is
   * exactly when someone is deciding whether to send. The same sentence then
   * moves above the box rather than a second one being written here: two ways
   * of saying "it will wait" read as two different rules.
   */
  queued?: boolean
}): JSX.Element {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  if (readOnlyReason) {
    return (
      <div className="shrink-0 bg-bg px-5 pb-4 pt-2">
        <div className="mx-auto w-full max-w-[var(--w-thread)] card px-4 py-3 flex items-center gap-3">
          {readOnlyIcon ?? <Laptop size={14} className="text-muted shrink-0" />}
          <span className="text-base text-muted flex-1 leading-relaxed">{readOnlyReason}</span>
          {readOnlyAction}
        </div>
      </div>
    )
  }
  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
    if (ref.current) ref.current.style.height = 'auto'
  }
  const canSend = text.trim().length > 0
  return (
    <div className="shrink-0 bg-bg px-5 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[var(--w-thread)]">
        {chips.length > 0 && !text && (
          <div className="flex gap-1.5 mb-2 fade-in">
            {chips.map((c) => (
              <button
                key={c}
                className="chip chip-btn h-7 px-3 text-sm text-muted hover:text-text active:scale-[.97]"
                style={{ transition: 'color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)' }}
                onClick={() => {
                  setText(c)
                  ref.current?.focus()
                }}
              >
                {c.replace(/[:…]\s*$/, '')}
              </button>
            ))}
          </div>
        )}
        {queued && canSend && placeholder && (
          <div className="queue-head mb-1.5 fade-in">
            <Hourglass size={11} className="shrink-0" />
            <span className="truncate">{placeholder}</span>
          </div>
        )}
        <div className="composer-field flex items-end gap-2 pl-4 pr-1.5 py-1.5">
          <textarea
            ref={ref}
            value={text}
            rows={1}
            placeholder={placeholder ?? `Message ${name}…`}
            aria-label={placeholder ?? `Message ${name}`}
            className="flex-1 bg-transparent outline-none resize-none max-h-40 py-1.5 text-md leading-5 placeholder:text-text-3"
            onChange={(e) => {
              setText(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <button className="send-btn" disabled={!canSend} onClick={submit} aria-label="Send" title={sendTitle ?? 'Send — Enter (Shift+Enter for a new line)'}>
            <ArrowUp size={16} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </div>
  )
}
