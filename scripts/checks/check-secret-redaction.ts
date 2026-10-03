/**
 * An error must never carry the operator's credentials to the model.
 *
 * Making tool failures legible means walking the `cause` chain, because Node
 * reports a refused socket as "fetch failed" and hides the real reason
 * underneath. What it also surfaces is the REQUEST, and two of our
 * intel providers authenticate in the request itself:
 *
 *   Alpha Vantage  `mcp.alphavantage.co/mcp?apikey=…`   (`keyQueryParam`)
 *   Apify          `Authorization: Bearer …`            (`headers`)
 *
 * — both assembled in `core/intel/servers.ts` from keys the operator typed
 * into Settings. So a provider having a bad afternoon could put an API key
 * into tool-result text, which the model reads, may repeat in its reply, and
 * which is then stored as a message and shown in notifications. The blast
 * radius of a flaky upstream should not be a leaked key.
 *
 * Redaction is by PARAMETER NAME and by scheme, never by entropy. "This looks
 * random" would mangle order ids and ticker lists, and the failure mode of
 * over-redaction is an error nobody can debug — the very thing the `cause`
 * walk exists to fix. Short list, because the ways we actually authenticate are few.
 *
 * Run: `npm run check -- secret-redaction`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeError } from '@core/runner/vendors/shared'
import { redactSecrets } from '@core/redact'
import { MCP_PROVIDERS } from '@shared/mcps'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const KEY = 'AVKEY1234567890ABCD'

// ── the two shapes we actually build, taken from the provider catalogue ────
// Derived from MCP_PROVIDERS rather than hand-written, so a provider that
// starts authenticating a new way fails here instead of leaking quietly.
const keyed = MCP_PROVIDERS.filter((p) => p.transport.kind === 'http' && (p.transport as { keyQueryParam?: string }).keyQueryParam)
const headered = MCP_PROVIDERS.filter((p) => p.transport.kind === 'http' && (p.transport as { headers?: Record<string, string> }).headers)
check('the catalogue still has URL-keyed providers to protect', keyed.length > 0, keyed.map((p) => p.id).join(','))
check('...and header-keyed ones', headered.length > 0, headered.map((p) => p.id).join(','))

for (const p of keyed) {
  const param = (p.transport as { keyQueryParam: string }).keyQueryParam
  const url = `${(p.transport as { url: string }).url}?${param}=${KEY}`
  const out = redactSecrets(`request to ${url} failed`)
  check(`${p.id}: the key is gone from a failing URL`, out.includes(KEY) === false, out)
  check(`${p.id}: ...and the endpoint is still readable`, out.includes('alphavantage') || out.includes(new URL((p.transport as { url: string }).url).hostname), out)
}
for (const p of headered) {
  const out = redactSecrets(`401 from ${p.id}: Authorization: Bearer ${KEY}`)
  check(`${p.id}: a Bearer token is redacted`, out.includes(KEY) === false, out)
}

// ── through the real function, not just the regex ──────────────────────────
// This is the path that actually reaches the model: an undici-shaped failure
// whose cause carries the request.
const wrapped = new Error('fetch failed', { cause: new Error(`connect ECONNREFUSED https://mcp.alphavantage.co/mcp?apikey=${KEY}`) })
const described = describeError(wrapped)
check('describeError does not leak a key from a cause chain', described.includes(KEY) === false, described)
check('...while still naming the real failure', /ECONNREFUSED/.test(described), described)
check('...and the wrapper', /fetch failed/.test(described))

// ── other credential shapes ────────────────────────────────────────────────
for (const [label, text] of [
  ['access_token in a query', `GET /x?access_token=${KEY}`],
  ['token= in a query', `GET /x?token=${KEY}`],
  ['api_key underscore form', `GET /x?api_key=${KEY}`],
  ['a password in a connection string', `postgres://admin:hunter2@db.internal:5432/app`],
  ['basic auth', `Authorization: Basic ${KEY}`]
] as const) {
  const out = redactSecrets(text)
  const leaked = out.includes(KEY) || out.includes('hunter2')
  check(`${label} is redacted`, leaked === false, out)
}

// ── over-redaction would be its own bug ────────────────────────────────────
// The `cause` walk exists so a failure is debuggable. Mangling ordinary error text
// would undo it, so assert the benign cases are byte-identical.
for (const benign of [
  'ECONNREFUSED 127.0.0.1:8905',
  'Tool "mcp__robinhood__get_equity_quotes" is not available to this agent.',
  'order 8f3a-22b1 rejected: insufficient buying power',
  'symbols MU, NVDA, AMD returned no quote',
  'Stalled: the model sent nothing for 45s',
  'column messages.origin does not exist'
]) {
  check(`benign text is untouched: ${benign.slice(0, 40)}…`, redactSecrets(benign) === benign, redactSecrets(benign))
}

// ── the run-error path, which outlives the run ─────────────────────────────
// `runOnce` redacts once where the run's error is settled, because that value
// reaches a thread message, RunRecord.error and notifications.
const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8')
check('runOnce redacts the run error before it is stored or posted', /redactSecrets\(result\.error\)/.test(src), 'a thread message, RunRecord.error and notifications all read this one value')

// A broker that echoes the submitted refresh token into its error body is not
// hypothetical enough to leave untested.
const echoed = `Token exchange failed (400): {"error":"invalid_grant","refresh_token":"rt_9f3a2b7c8d1e4f5a6b"}`
check('a refresh token echoed by the broker is redacted', redactSecrets(`?refresh_token=rt_9f3a2b7c8d1e4f5a6b`).includes('rt_9f3a2b7c8d1e4f5a6b') === false, redactSecrets('?refresh_token=rt_9f3a2b7c8d1e4f5a6b'))
check('...and the surrounding failure is still readable', /invalid_grant/.test(redactSecrets(echoed)), redactSecrets(echoed))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
