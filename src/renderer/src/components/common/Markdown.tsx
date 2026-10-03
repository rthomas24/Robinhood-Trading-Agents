import type { JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@renderer/lib/format'

/**
 * Agent prose. Every rule lives on `.md` in index.css, so a paragraph written
 * by an agent is set the same way in a memo, a report card, a plan and the live
 * bubble — this component adds no typography of its own.
 *
 * Three things it does own, because they are behaviour rather than style:
 * a link opens in the operator's browser (never inside the app's window); an
 * image is shown as its alt text and NEVER fetched — agent prose can be steered
 * by what the agent read, and an auto-loading `![](https://host/?d=…)` would
 * carry the book to that host without a click (the CSP refuses remote images
 * too); and a wide table scrolls inside its own box instead of pushing the
 * thread column sideways.
 */
export function Markdown({ text, className }: { text: string; className?: string }): JSX.Element {
  return (
    <div className={cn('md', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              /* The destination, visible before the click: agent prose can
                 carry a link from anywhere it read, and the label is the
                 model's words, not the URL's. */
              title={href}
              rel="noreferrer noopener"
              onClick={(e) => {
                e.preventDefault()
                if (href) void window.tb.openExternal(href)
              }}
            >
              {children}
            </a>
          ),
          img: ({ alt, src }) => (
            <span className="text-muted" title={typeof src === 'string' ? src : undefined}>
              [image{alt ? `: ${alt}` : ''}]
            </span>
          ),
          // A ten-column table must not widen the reading column; it gets its
          // own scroller, which is the design system's rule for wide content.
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
