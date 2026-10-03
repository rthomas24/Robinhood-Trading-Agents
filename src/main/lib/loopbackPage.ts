import type { ServerResponse } from 'node:http'

/**
 * The page a loopback OAuth callback shows in the operator's browser.
 *
 * Both sign-in flows (Robinhood, ChatGPT) serve one of these from a short-lived
 * server on 127.0.0.1, and the text can include the provider's `error`
 * parameter — which anyone able to open a URL in that browser controls. So the
 * text is HTML-escaped, and the response carries a CSP that forbids scripts
 * outright: a reflected value cannot execute even if a future caller forgets.
 */
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c])

export function sendLoopbackPage(res: ServerResponse, status: number, title: string, body: string): void {
  const t = escapeHtml(title.slice(0, 200))
  const b = escapeHtml(body.slice(0, 500))
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${t}</title><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-weight:600">${t}</h1><p style="color:#aaa">${b}</p></div></body>`
  )
}
