/**
 * A 401 from the broker must end in a refreshed token or a told operator —
 * never in the same dead token, silently, forever.
 *
 * The failure this guards: the token endpoint happily mints a new token while
 * Robinhood's MCP rejects every token it mints (a dead dynamic client
 * registration: "initialize 401: client id not allowed"). Every layer can
 * reason itself out of acting — the refresh hook living only in `call()` while
 * the failure is at the handshake; a refresh that only fires when the token's
 * OWN clock says so, so a 401 gets the identical dead token back; nothing
 * marking the grant, so the Connections page claims a working broker.
 *
 * The contract now, asserted here:
 *   1. a 401 at initialize OR tools/call consults `onUnauthorized` once;
 *   2. `onUnauthorized` FORCES a refresh (store reload first, one rotation per
 *      cooldown), returning null only when nothing better can exist;
 *   3. a 401 that survives the refresh calls `onAuthFailure` exactly once per
 *      client — the host marks the grant `needsReauth` and tells the operator once;
 *   4. escalation is gated on the refresh having RUN: a transient
 *      token-endpoint error is a bad minute, not a dead grant;
 *   5. a grant marked `needsReauth` reads as NOT CONNECTED, so agents get the
 *      guardrail sentence instead of replaying the 401;
 *   6. the prompt stops the false reassurance: exits/watches are declared
 *      unenforced when the feed they ride is down.
 *
 * Run: `npm run check -- broker-auth-retry`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RobinhoodMcpClient, RobinhoodMcpError } from '../../src/core/robinhood/mcp'
import { refreshFailureIsFatal } from '../../src/core/robinhood/oauth'
import { protectionsBlock } from '../../src/core/runner/prompts'
import type { AgentState } from '../../src/shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ───────────────────────────── behavioural: the MCP client against a fake wire

type Step = { status: number; body?: unknown; sessionId?: string }
function wire(steps: Step[]): { calls: string[] } {
  const calls: string[] = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const method = (JSON.parse(init?.body ?? '{}') as { method?: string }).method ?? '?'
    calls.push(method)
    // notifications/initialized is fire-and-forget — always accept it without
    // consuming a scripted step, so scripts only describe the calls that matter.
    if (method === 'notifications/initialized') return new Response('', { status: 202 })
    const step = steps.shift() ?? { status: 500, body: 'script exhausted' }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (step.sessionId) headers['mcp-session-id'] = step.sessionId
    const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {})
    return new Response(body, { status: step.status, headers })
  }) as typeof fetch
  return { calls }
}

const ok = (result: unknown): Step => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result }, sessionId: 's1' })
const denied: Step = { status: 401, body: 'client id not allowed: <missing>' }
const toolResult = ok({ content: [{ type: 'text', text: JSON.stringify({ data: { fine: true } }) }] })

interface Probe {
  unauthorized: number
  authFailures: string[]
}
function provider(tokens: string[], onUnauthorizedResult: () => string | null): { p: Probe; client: RobinhoodMcpClient } {
  const p: Probe = { unauthorized: 0, authFailures: [] }
  let current = tokens[0]
  const client = new RobinhoodMcpClient({
    token: async () => current,
    onUnauthorized: async () => {
      p.unauthorized++
      const t = onUnauthorizedResult()
      if (t) current = t
      return t
    },
    onAuthFailure: async (detail) => {
      p.authFailures.push(detail)
    }
  })
  return { p, client }
}

// 1. Initialize 401 → forced refresh → retry succeeds. THE fix for the actual
//    outage path: before this, a 401 at the handshake threw without ever
//    consulting onUnauthorized.
{
  wire([denied, ok({}), toolResult])
  const { p, client } = provider(['dead'], () => 'fresh')
  const r = await client.call('get_equity_quotes').then(
    () => 'resolved',
    (e) => `rejected: ${(e as Error).message}`
  )
  check('initialize 401 recovers through the forced refresh', r === 'resolved', r)
  check('…one onUnauthorized, no escalation', p.unauthorized === 1 && p.authFailures.length === 0)
}

// 2. Initialize 401 → refresh mints → STILL 401: the dead-grant shape. Must
//    escalate exactly once and throw a 401 error.
{
  wire([denied, denied])
  const { p, client } = provider(['dead'], () => 'fresh-but-also-dead')
  const err = await client.call('get_equity_quotes').then(
    () => null,
    (e) => e as RobinhoodMcpError
  )
  check('401 surviving the refresh throws with status 401', err instanceof RobinhoodMcpError && err.status === 401)
  check('…and escalates via onAuthFailure once', p.authFailures.length === 1, `got ${p.authFailures.length}`)

  // 3. Same client, next call: the grant is still dead. However many more 401s
  //    arrive, the host is told once per client — a run makes dozens of calls
  //    and the escalation (mark + pause + push) must not be requested per call.
  wire([denied])
  const again = await client.call('get_positions').then(
    () => null,
    (e) => e as Error
  )
  check('a later call on the same client still fails', again !== null)
  check('…but does NOT escalate a second time', p.authFailures.length === 1)
}

// 4. tools/call 401 with no better token available (onUnauthorized → null):
//    escalates rather than retrying the token the broker just rejected.
{
  wire([ok({}), denied])
  const { p, client } = provider(['dead'], () => null)
  const err = await client.call('get_equity_quotes').then(
    () => null,
    (e) => e as RobinhoodMcpError
  )
  check('tools/call 401 with nothing better escalates once', err?.status === 401 && p.authFailures.length === 1)
}

// ─────────────────────────────── the fatal-vs-transient rule, now host-shared

check('token-endpoint 400 is fatal', refreshFailureIsFatal('Token exchange failed (400): invalid_grant'))
check('429 is NOT fatal (our own clustered renewals)', !refreshFailureIsFatal('Token exchange failed (429): slow down'))
check('5xx is NOT fatal', !refreshFailureIsFatal('Token exchange failed (502): bad gateway'))
check('a socket error is NOT fatal', !refreshFailureIsFatal('fetch failed'))
check('a (404) inside an error body does not match the anchor', !refreshFailureIsFatal('some page said Token exchange failed (404): nope'.replace(/^some page said /, 'x ')))

// ───────────────────────────────────────── the prompt stops false reassurance

const armed = {
  exits: {},
  watches: [{ id: 'w1', symbol: 'AAPL', condition: 'above', value: 200, baseline: 180 }]
} as unknown as AgentState
check('watches + broker down → the block says nothing is checking them', protectionsBlock(armed, false).includes('NO BROKER CONNECTION'))
check('watches + broker up → no warning', !protectionsBlock(armed, true).includes('NO BROKER CONNECTION'))
check('hosts that do not report the flag change nothing', !protectionsBlock(armed).includes('NO BROKER CONNECTION'))
check('nothing armed → no orphan warning', protectionsBlock({ exits: {}, watches: [] } as unknown as AgentState, false) === '')

// ─────────────────────────────────────────────── source contracts, per host

const R = join(import.meta.dirname, '..', '..')
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (...p: string[]): string => code(readFileSync(join(R, ...p), 'utf8'))

const client = read('src', 'core', 'robinhood', 'client.ts')
check('client: onUnauthorized passes forceRefresh', /robinhoodToken\(\{ forceRefresh: true \}\)/.test(client))
check('client: onAuthFailure reaches the host seam', /brokerAuthFailed\?\.\(detail\)/.test(client))

const store = read('src', 'main', 'robinhood', 'credStore.ts')
check('desktop: needsReauth reads as not connected', /c\.needsReauth\) return null/.test(store))
check('desktop: forced-and-unchanged means null', /c\.accessToken === before\) return null/.test(store))
check('desktop: escalation flags the grant and tells the operator', /needsReauth: true/.test(store) && /Notification/.test(store))
check('desktop: transient forced refresh does not escalate', /lastForced\?\.outcome === 'transient'/.test(store))

const runOnce = read('src', 'core', 'runner', 'runOnce.ts')
check('runOnce hands the prompt the broker truth', /brokerConnected: rh !== null \}/.test(runOnce))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
