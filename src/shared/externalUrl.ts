/**
 * The one rule for what the app hands to the operating system to open.
 *
 * `shell.openExternal` passes its argument to the OS shell, and on Windows a
 * `file:`, `ms-msdt:`, `search-ms:` or UNC target can run code or leak
 * credentials. Agent prose carries links from anything it read, so the main
 * process decides here — never trusting the renderer's markdown sanitizer to
 * have done it.
 *
 * Only absolute `https:`, `http:` and `mailto:` URLs pass. `new URL()` rejects
 * relative and protocol-relative strings (`//host/share`), which is what keeps
 * a scheme-less link from resolving against the app's own `file://` page.
 *
 * PURE. No Node APIs — shared by the main process and its checks.
 */
const SAFE_SCHEMES = new Set(['https:', 'http:', 'mailto:'])
const MAX_URL_LENGTH = 4096

/** The URL, normalised, when it is safe to open outside the app; null otherwise. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!SAFE_SCHEMES.has(url.protocol)) return null
  if (url.protocol !== 'mailto:' && !url.hostname) return null
  return url.toString()
}

/**
 * Whether a navigation stays on the app's own page — the same file for the
 * packaged app (`file:` URLs have no origin to compare), the same origin for
 * the dev server. The window is a single-page app, so anything else is a page
 * that would inherit the preload bridge.
 */
export function isSameAppDocument(target: string, current: string): boolean {
  try {
    const a = new URL(target)
    const b = new URL(current)
    if (a.protocol === 'file:' || b.protocol === 'file:') return a.protocol === b.protocol && a.pathname === b.pathname
    return a.origin === b.origin
  } catch {
    return false
  }
}
