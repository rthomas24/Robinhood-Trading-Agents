import { ROBINHOOD_MCP_URL } from './oauth'

/**
 * Minimal Streamable-HTTP MCP client for the Robinhood Agentic Trading server,
 * used by the ENGINE (deterministic code) — quotes, positions, order placement.
 * The model talks to the same server through the Agent SDK's `{type:'http'}`
 * mcpServers entry (see tools.ts); this client is for code paths.
 *
 * Verified wire behaviors (from live probing):
 *  - `Accept` must list both application/json and text/event-stream.
 *  - The session id arrives in the `mcp-session-id` response header and is echoed
 *    back as `Mcp-Session-Id`.
 *  - Tool results are `{"data": {...}}` serialized into content[].text; multiple
 *    text blocks may need concatenating. Action tools may return a plain string.
 *  - `isError: true` is the real failure signal; error text ends with remediation.
 */
export interface McpTokenProvider {
  /** Return a currently-valid bearer token (refreshing if needed). */
  token(): Promise<string>
  /**
   * Called on a 401 — force a refresh and return the new token, or null when no
   * better token can be produced (the store holds nothing newer and a refresh
   * is not possible or was already spent).
   */
  onUnauthorized?(): Promise<string | null>
  /**
   * Called at most once per client when a 401 PERSISTS: the forced refresh
   * yielded nothing better, or its token was rejected too. That means the grant
   * is bad in a way its own expiry cannot see — revoked, or its client
   * registration gone — and only the host can act on that (mark the connection
   * broken, tell the operator). Without this hook a dead client registration
   * is invisible: refreshes keep "succeeding", the connection keeps saying ok,
   * and every agent goes blind.
   */
  onAuthFailure?(detail: string): Promise<void>
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean; tools?: Array<{ name?: string; description?: string }>; nextCursor?: string }
  error?: { code?: number; message?: string }
}

export class RobinhoodMcpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly tool?: string
  ) {
    super(message)
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])

export class RobinhoodMcpClient {
  private sessionId: string | undefined
  private initialized = false
  private rpcId = 0
  private initPromise: Promise<void> | null = null

  constructor(
    private readonly tokens: McpTokenProvider,
    private readonly url = ROBINHOOD_MCP_URL,
    private readonly clientName = 'trading-agents'
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${await this.tokens.token()}`,
      'MCP-Protocol-Version': '2025-06-18'
    }
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    return h
  }

  /** Drop the MCP session (e.g. after the token changed or the server forgot us). */
  reset(): void {
    this.sessionId = undefined
    this.initialized = false
    this.initPromise = null
  }

  private async parse(res: Response): Promise<JsonRpcResponse> {
    const ctype = res.headers.get('content-type') ?? ''
    const text = await res.text()
    if (ctype.includes('text/event-stream')) {
      let parsed: JsonRpcResponse | undefined
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        try {
          const obj = JSON.parse(t.slice(5).trim()) as JsonRpcResponse
          if (obj.result || obj.error) parsed = obj
        } catch {
          /* skip */
        }
      }
      return parsed ?? {}
    }
    try {
      return JSON.parse(text) as JsonRpcResponse
    } catch {
      return {}
    }
  }

  private async post(body: unknown): Promise<Response> {
    return fetch(this.url, { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) })
  }

  /**
   * Report a persistent auth failure to the host, once per client. Once, because
   * a run makes many calls and every one of them will hit the same dead grant —
   * the host's escalation (mark the connection for reconnecting, tell the operator once) must
   * not be asked for per call.
   */
  private authFailureReported = false
  private async reportAuthFailure(detail: string): Promise<void> {
    if (this.authFailureReported || !this.tokens.onAuthFailure) return
    this.authFailureReported = true
    await this.tokens.onAuthFailure(detail).catch(() => undefined)
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    if (!this.initPromise) {
      this.initPromise = (async () => {
        // Up to two attempts: a 401 here consults `onUnauthorized` exactly like
        // `call()` does: a dead grant fails at the handshake, before any tool
        // call, where a refresh hook living only in `call()` would never run.
        for (let attempt = 0; ; attempt++) {
          const res = await this.post({
            jsonrpc: '2.0',
            id: ++this.rpcId,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.clientName, version: '0.1.0' } }
          })
          if (!res.ok) {
            const detail = `Robinhood MCP initialize ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`
            if (res.status === 401 && attempt === 0 && this.tokens.onUnauthorized) {
              const t = await this.tokens.onUnauthorized()
              // headers() re-reads token() on every post, so a refreshed token
              // is picked up by the retry without threading it through.
              if (t) continue
            }
            this.initPromise = null
            if (res.status === 401) await this.reportAuthFailure(detail)
            throw new RobinhoodMcpError(detail, res.status)
          }
          const sid = res.headers.get('mcp-session-id')
          if (sid) this.sessionId = sid
          await this.parse(res)
          await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined)
          this.initialized = true
          return
        }
      })()
    }
    return this.initPromise
  }

  /**
   * Call a tool and return its unwrapped `data` payload (or the raw text for
   * action tools that reply with a plain confirmation string). Retries transient
   * 5xx/429 with backoff, re-initializes on a lost session (404), and refreshes
   * the token once on 401.
   */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    let refreshed = false
    let reinit = false
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.ensureInitialized()
      const res = await this.post({ jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/call', params: { name, arguments: args } })
      if (res.status === 401) {
        if (!refreshed && this.tokens.onUnauthorized) {
          refreshed = true
          const t = await this.tokens.onUnauthorized()
          if (t) {
            this.reset()
            continue
          }
        }
        // Refresh already tried (or impossible) and the broker still says 401:
        // this is not a stale token, it is a dead grant. Tell the host once.
        const detail = `Robinhood ${name} 401: ${(await res.text().catch(() => '')).slice(0, 300)}`
        await this.reportAuthFailure(detail)
        throw new RobinhoodMcpError(detail, 401, name)
      }
      if (res.status === 404 && !reinit) {
        // Session expired server-side — re-handshake once.
        reinit = true
        this.reset()
        continue
      }
      if (RETRYABLE.has(res.status) && attempt < 3) {
        const ra = Number(res.headers.get('retry-after'))
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      if (!res.ok) {
        throw new RobinhoodMcpError(`Robinhood ${name} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`, res.status, name)
      }
      const msg = await this.parse(res)
      if (msg.error) throw new RobinhoodMcpError(`Robinhood ${name}: ${msg.error.message ?? 'error'}`, undefined, name)
      const textBlock = (msg.result?.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('')
        .trim()
      if (msg.result?.isError) {
        throw new RobinhoodMcpError(`Robinhood ${name} rejected: ${textBlock.slice(0, 2000) || 'unknown error'}`, undefined, name)
      }
      if (!textBlock) return {} as T
      try {
        const payload = JSON.parse(textBlock) as { data?: T }
        return (payload.data ?? payload) as T
      } catch {
        return textBlock as unknown as T
      }
    }
    throw new RobinhoodMcpError(`Robinhood ${name}: gave up after retries`, undefined, name)
  }

  /** Probe the tool surface (varies per account): names + server descriptions. */
  async listTools(): Promise<{ name: string; description?: string }[]> {
    await this.ensureInitialized()
    const tools: { name: string; description?: string }[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const res = await this.post({ jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/list', params: cursor ? { cursor } : {} })
      if (!res.ok) throw new RobinhoodMcpError(`Robinhood tools/list ${res.status}`, res.status)
      const msg = await this.parse(res)
      if (msg.error) throw new RobinhoodMcpError(`Robinhood tools/list: ${msg.error.message ?? 'error'}`)
      for (const t of msg.result?.tools ?? []) if (t.name) tools.push({ name: t.name, description: t.description })
      cursor = msg.result?.nextCursor
      if (!cursor) break
    }
    return tools
  }
}
