/**
 * Minimal generic Streamable-HTTP MCP client (initialize, tools/list,
 * tools/call) for vendors that have no MCP bridge of their own (the local-model
 * vendor). Same wire behaviour the Robinhood client verified: JSON or SSE
 * responses, `mcp-session-id` round-trip, retry on 429/5xx, re-handshake on 404.
 */
export interface McpHttpClientOptions {
  url: string
  headers?: () => Promise<Record<string, string>> | Record<string, string>
  clientName?: string
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean; tools?: McpToolInfo[]; nextCursor?: string }
  error?: { code?: number; message?: string }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])

export class McpHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
  }
}

export class McpHttpClient {
  private sessionId: string | undefined
  private initialized = false
  private initPromise: Promise<void> | null = null
  private rpcId = 0

  constructor(private readonly opts: McpHttpClientOptions) {}

  private async headers(): Promise<Record<string, string>> {
    const extra = (await this.opts.headers?.()) ?? {}
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...extra }
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    return h
  }

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
    return fetch(this.opts.url, { method: 'POST', headers: await this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const res = await this.post({
          jsonrpc: '2.0',
          id: ++this.rpcId,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.opts.clientName ?? 'robinhood-trading-agents', version: '0.1.0' } }
        })
        if (!res.ok) {
          this.initPromise = null
          throw new McpHttpError(`MCP initialize ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`, res.status)
        }
        const sid = res.headers.get('mcp-session-id')
        if (sid) this.sessionId = sid
        await this.parse(res)
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined)
        this.initialized = true
      })()
    }
    return this.initPromise
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.ensureInitialized()
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const res = await this.post({ jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/list', params: cursor ? { cursor } : {} })
      if (!res.ok) throw new McpHttpError(`MCP tools/list ${res.status}`, res.status)
      const msg = await this.parse(res)
      if (msg.error) throw new McpHttpError(`MCP tools/list: ${msg.error.message ?? 'error'}`)
      for (const t of msg.result?.tools ?? []) if (t.name) tools.push({ name: t.name, description: t.description, inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} } })
      cursor = msg.result?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  /** Call a tool; returns the concatenated text content (errors throw with the server's text). */
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    let reinit = false
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.ensureInitialized()
      const res = await this.post({ jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/call', params: { name, arguments: args } })
      if (res.status === 404 && !reinit) {
        reinit = true
        this.reset()
        continue
      }
      if (RETRYABLE.has(res.status) && attempt < 3) {
        const ra = Number(res.headers.get('retry-after'))
        await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt))
        continue
      }
      if (!res.ok) throw new McpHttpError(`MCP ${name} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`, res.status)
      const msg = await this.parse(res)
      if (msg.error) throw new McpHttpError(`MCP ${name}: ${msg.error.message ?? 'error'}`)
      const text = (msg.result?.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('')
        .trim()
      if (msg.result?.isError) throw new McpHttpError(`${name} rejected: ${text.slice(0, 2000) || 'unknown error'}`)
      return text
    }
    throw new McpHttpError(`MCP ${name}: gave up after retries`)
  }
}
