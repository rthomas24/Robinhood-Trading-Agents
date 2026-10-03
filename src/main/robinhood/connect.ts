import { createServer, type Server } from 'node:http'
import type { RobinhoodConnectResult } from '@shared/ipc'
import { buildAuthorizeUrl, discoverEndpoints, exchangeCode, makePkce, registerClient } from '@core/robinhood/oauth'
import { RobinhoodMcpClient } from '@core/robinhood/mcp'
import type { RobinhoodToken } from '@core/runner/types'
import { getAccounts } from '@core/robinhood/api'
import { rhCreds } from './credStore'
import { focusMainWindow } from '../window'
import { sendLoopbackPage } from '../lib/loopbackPage'
import { openExternalSafely } from '../lib/openExternal'
import { safeExternalUrl } from '@shared/externalUrl'

/**
 * Robinhood sign-in: bind a loopback http server on 127.0.0.1:<random>, register a
 * public client bound to that redirect, open the system browser to the PKCE
 * authorize URL, catch the code on /callback, exchange it, then discover the
 * agentic-enabled account.
 */
const TIMEOUT_MS = 300_000

function awaitRedirect(server: Server, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Sign-in timed out. Please try again.'))
      server.close()
    }, TIMEOUT_MS)
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.statusCode = 404
        res.end()
        return
      }
      const err = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (err || !code || state !== expectedState) {
        sendLoopbackPage(res, 400, 'Sign-in failed', err ?? 'Missing code or state mismatch')
        clearTimeout(timer)
        reject(new Error(err ?? 'Missing code or state mismatch'))
      } else {
        sendLoopbackPage(res, 200, 'Connected ✓', 'You can close this tab and return to Robinhood Trading Agents.')
        clearTimeout(timer)
        resolve(code)
      }
      setTimeout(() => server.close(), 1000)
    })
  })
}

/** A completed Robinhood authorization: the token pair, its client, and the agentic account. */
export interface RobinhoodGrant extends RobinhoodToken {
  clientId: string
  accountNumber?: string
  /** Why no agentic account was found, when there isn't one. */
  note: string
}

/**
 * One Robinhood sign-in, start to finish: loopback redirect, a fresh dynamic
 * client registration, PKCE, code exchange, then the agentic account lookup.
 * The resulting grant lives only on this computer (encrypted in the OS keychain).
 */
export async function authorizeRobinhood(): Promise<RobinhoodGrant> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const redirectUri = `http://127.0.0.1:${port}/callback`
  let ep: Awaited<ReturnType<typeof discoverEndpoints>>
  let clientId: string
  let pkce: ReturnType<typeof makePkce>
  let authUrl: string
  try {
    ep = await discoverEndpoints()
    clientId = await registerClient(ep, redirectUri)
    pkce = makePkce()
    authUrl = buildAuthorizeUrl(ep, clientId, redirectUri, pkce)
    // The authorize endpoint comes from Robinhood's discovery document; only a
    // web URL is ever handed to the operating system.
    if (!safeExternalUrl(authUrl)) throw new Error('Robinhood returned a sign-in address that is not a web URL — not opening it.')
  } catch (err) {
    server.close()
    throw err
  }
  const codeP = awaitRedirect(server, pkce.state)
  await openExternalSafely(authUrl)
  const code = await codeP
  const token = await exchangeCode(ep, { code, redirectUri, clientId, verifier: pkce.verifier })

  // Which account may an agent actually trade in? Also the cheapest proof the
  // grant works before anything is stored.
  let accountNumber: string | undefined
  let note = ''
  try {
    const client = new RobinhoodMcpClient({ token: async () => token.accessToken })
    const accounts = await getAccounts(client)
    accountNumber = accounts.find((a) => a.agenticAllowed)?.accountNumber
    if (!accountNumber && accounts.length) note = ' No agentic-enabled account was found — enable Agentic Trading in the Robinhood app, then reconnect.'
  } catch (err) {
    note = ` (account lookup failed: ${(err as Error).message})`
  }
  return { ...token, clientId, accountNumber, note }
}

let inFlight: Promise<RobinhoodConnectResult> | null = null

export function connectRobinhood(): Promise<RobinhoodConnectResult> {
  if (inFlight) return inFlight
  inFlight = (async (): Promise<RobinhoodConnectResult> => {
    try {
      const { note, ...grant } = await authorizeRobinhood()
      rhCreds.save(grant)
      focusMainWindow()
      return { ok: Boolean(grant.accountNumber), message: grant.accountNumber ? 'Robinhood connected.' : `Signed in.${note}`, status: rhCreds.status() }
    } catch (err) {
      return { ok: false, message: (err as Error).message, status: rhCreds.status() }
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
