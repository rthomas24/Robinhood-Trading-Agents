/**
 * Tool policy: what the operator lets EVERY agent reach.
 *
 * Two halves, both pure data so the renderer (settings UI), the core runner
 * (allowlists), and the hosts (key storage) share one source of truth:
 *  - the Robinhood tool catalog (read AND write) — reads are on unless switched
 *    off, writes are off unless switched on (and only for live, armed agents);
 *  - the registry of free "intel" MCP servers agents can be given for news,
 *    filings, macro and sentiment. Off by default; secrets live host-side.
 */

/* ───────────────────────────── Robinhood tools ───────────────────────────── */

export type RobinhoodToolKind = 'read' | 'write'

export interface RobinhoodToolInfo {
  /** Bare MCP tool name on the Robinhood server (no `mcp__robinhood__` prefix). */
  name: string
  label: string
  description: string
  kind: RobinhoodToolKind
  /** The engine itself relies on this feed for context/protection — switching
   *  it off only removes the MODEL's direct access, never the engine's. */
  engineUses?: boolean
}

/**
 * Tools we know the Robinhood Agentic Trading MCP exposes (verified against the
 * live server). The server's surface varies per
 * account, so the settings page merges this with a live `tools/list`; unknown
 * names are classified by `robinhoodToolKind`.
 */
export const ROBINHOOD_TOOL_CATALOG: RobinhoodToolInfo[] = [
  // ── read ──
  { name: 'get_accounts', label: 'Accounts', description: 'The brokerage accounts on this login (agentic-enabled flag).', kind: 'read', engineUses: true },
  { name: 'get_equity_quotes', label: 'Quotes', description: 'Real-time last/bid/ask and previous close for symbols.', kind: 'read', engineUses: true },
  { name: 'get_equity_historicals', label: 'Historical bars', description: 'Daily and intraday OHLCV candles.', kind: 'read', engineUses: true },
  { name: 'get_equity_fundamentals', label: 'Fundamentals', description: 'Market cap, P/E, 52-week range, average volume, sector.', kind: 'read' },
  { name: 'get_equity_technical_indicators', label: 'Technical indicators', description: "Robinhood's computed indicators (RSI, MACD, moving averages…).", kind: 'read' },
  { name: 'get_equity_tradability', label: 'Tradability', description: 'Whether a symbol is tradable / halted / restricted in this account.', kind: 'read', engineUses: true },
  { name: 'get_equity_price_book', label: 'Price book', description: 'Level-2 style bid/ask ladder (order book depth).', kind: 'read' },
  { name: 'get_portfolio', label: 'Portfolio', description: 'Account value, cash and buying power.', kind: 'read', engineUses: true },
  { name: 'get_equity_positions', label: 'Positions', description: 'Every position in the Robinhood account (agents still only sell their own book).', kind: 'read', engineUses: true },
  { name: 'get_equity_orders', label: 'Orders', description: 'Order history and open orders.', kind: 'read', engineUses: true },
  { name: 'get_equity_tax_lots', label: 'Tax lots', description: 'Per-position tax lots (cost basis, holding period).', kind: 'read' },
  { name: 'search', label: 'Symbol search', description: 'Look up tickers and company names.', kind: 'read' },
  { name: 'get_earnings_results', label: 'Earnings results', description: 'Reported EPS/revenue vs. estimates.', kind: 'read' },
  { name: 'get_earnings_calendar', label: 'Earnings calendar', description: 'Upcoming earnings dates and timing (before open / after close).', kind: 'read', engineUses: true },
  { name: 'get_index_quotes', label: 'Index quotes', description: 'S&P 500, Nasdaq, Dow and other index levels.', kind: 'read' },
  { name: 'get_indexes', label: 'Index list', description: 'The indexes Robinhood can quote.', kind: 'read' },
  { name: 'get_financials', label: 'Financial statements', description: 'Income statement, balance sheet, cash flow.', kind: 'read' },
  { name: 'get_realized_pnl', label: 'Realized P&L', description: 'Closed-trade P&L for the account.', kind: 'read' },
  { name: 'get_pnl_trade_history', label: 'Trade history', description: 'Historical trades with P&L.', kind: 'read' },
  { name: 'get_watchlists', label: 'Watchlists', description: 'Your watchlists and their symbols.', kind: 'read' },
  { name: 'get_scans', label: 'Saved scans', description: 'Your saved screeners and their filters.', kind: 'read' },
  { name: 'get_option_quotes', label: 'Option quotes', description: 'Quotes and Greeks for option contracts.', kind: 'read' },
  { name: 'get_option_chains', label: 'Option chains', description: 'Expirations and strikes for an underlying.', kind: 'read' },
  { name: 'get_option_instruments', label: 'Option instruments', description: 'Contract details by symbol / expiry / strike.', kind: 'read' },
  { name: 'get_option_positions', label: 'Option positions', description: 'Open option positions in the account.', kind: 'read' },
  // ── write ──
  { name: 'review_equity_order', label: 'Review equity order', description: 'Dry-run an equity order: pre-trade warnings and collar checks. Places nothing.', kind: 'write' },
  { name: 'place_equity_order', label: 'Place equity order', description: "Submit a stock order directly. The engine still checks your guardrails and records it in the agent's book.", kind: 'write' },
  { name: 'cancel_equity_order', label: 'Cancel equity order', description: 'Cancel an open stock order by id.', kind: 'write' },
  { name: 'place_option_order', label: 'Place option order', description: 'Not supported. The engine places equity orders only, so agents are refused every option WRITE even when this is enabled — no guardrail, book entry or stop would apply to one. Option reads stay available for research.', kind: 'write' },
  { name: 'add_to_watchlist', label: 'Add to watchlist', description: 'Add symbols to a watchlist.', kind: 'write' },
  { name: 'update_watchlist', label: 'Update watchlist', description: 'Rename or edit a watchlist.', kind: 'write' },
  { name: 'create_scan', label: 'Create scan', description: 'Create a saved screener.', kind: 'write' },
  { name: 'update_scan_filters', label: 'Update scan', description: "Edit a saved screener's filters.", kind: 'write' }
]

/** Mutating tools by name shape — anything that places, cancels, reviews, edits or follows. */
const WRITE_NAME = /^(place|cancel|review|exercise|add|remove|update|create|delete|set|follow|unfollow|submit|edit|rename)_/i

/**
 * Coarse groups for the settings page so the 50+ tools read as a handful of
 * switches. Options get their own group on BOTH sides so "everything but
 * options" is one click. Classified by name so live-discovered tools land too.
 */
export type RobinhoodToolGroup = 'account' | 'market' | 'options' | 'orders' | 'watchlists' | 'scans' | 'other'
export const ROBINHOOD_TOOL_GROUP_LABEL: Record<RobinhoodToolGroup, string> = {
  account: 'Account & orders',
  market: 'Market data',
  options: 'Options',
  orders: 'Equity orders',
  watchlists: 'Watchlists',
  scans: 'Scans',
  other: 'Other'
}
export function robinhoodToolGroup(bare: string, kind: RobinhoodToolKind = robinhoodToolKind(bare)): RobinhoodToolGroup {
  const n = bare.toLowerCase()
  if (/option/.test(n)) return 'options'
  if (/watchlist/.test(n)) return 'watchlists'
  if (/scan|screen/.test(n)) return 'scans'
  if (kind === 'write') return /order|exercise|transfer/.test(n) ? 'orders' : 'other'
  return /account|portfolio|position|order|pnl|tax_lot|buying_power|cash|transfer|history/.test(n) ? 'account' : 'market'
}

/** Classify any Robinhood tool name (known or discovered live). */
export function robinhoodToolKind(bare: string): RobinhoodToolKind {
  const known = ROBINHOOD_TOOL_CATALOG.find((t) => t.name === bare)
  if (known) return known.kind
  return WRITE_NAME.test(bare) ? 'write' : 'read'
}

/** A live `tools/list` row, as surfaced by the Robinhood server for this account. */
export interface RobinhoodLiveTool {
  name: string
  description?: string
}

/* ───────────────────────────── Intel MCP registry ───────────────────────────── */

export type McpProviderId = 'webvector' | 'edgar' | 'alphavantage' | 'econcal' | 'yfinance' | 'tiingo' | 'fred' | 'finnhub'

/** What a stdio server needs on the machine that runs the agent. */
export type McpRuntimeNeed = 'uv' | 'node'

export interface McpProvider {
  id: McpProviderId
  name: string
  tagline: string
  /** What the agents gain that Robinhood does not give them. */
  adds: string[]
  transport:
    | { kind: 'http'; url: string; /** Header template; `${KEY}` is replaced with the stored key. */ headers?: Record<string, string>; /** Append the key as this query param instead of a header. */ keyQueryParam?: string }
    | {
        kind: 'stdio'
        command: string
        args: string[]
        /** Env var that carries the key. */
        keyEnv?: string
        needs: McpRuntimeNeed
      }
  /** Needs an API key/token from the operator (free to obtain). */
  keyed: boolean
  keyLabel?: string
  keyUrl?: string
  freeTier: string
  docsUrl: string
  /** One-line note for the settings UI (limits, caveats). */
  caveat?: string
  /** Guidance injected into the agent prompt when enabled. */
  promptHint: string
  /** Switched on for everyone until the operator turns it off (recorded in `ToolPolicy.mcpSeen`). */
  defaultOn?: boolean
}

export const MCP_PROVIDERS: McpProvider[] = [
  {
    id: 'webvector',
    name: 'WebVector',
    tagline: 'Web research + market news for agents: headlines per ticker, SEC filings, macro calendar, sentiment, VIX/yields, and full-page reads with citations',
    adds: [
      'Ticker/market headlines from free feeds, deduped and event-tagged (webvector_news)',
      'SEC EDGAR filings with decoded 8-K items + full-text search (webvector_filings)',
      'Macro calendar, Fed releases and earnings dates (webvector_calendar)',
      'StockTwits skew + FINRA short volume (webvector_sentiment), VIX/yields pulse (webvector_pulse)',
      'General web research and page reads with citations (webvector_research / webvector_fetch / webvector_search)'
    ],
    transport: {
      kind: 'stdio',
      command: 'npx',
      // `@latest` so npx re-resolves the registry each start (the markets tools ship in ≥ 0.3.0;
      // an older cached copy would silently expose only research/fetch/search).
      args: ['-y', 'webvector-mcp@latest', '--tools', 'research,fetch,search,markets', '--max-tokens', '3000'],
      needs: 'node'
    },
    keyed: false,
    freeTier: 'Free — no key, no telemetry',
    docsUrl: 'https://www.npmjs.com/package/webvector-mcp',
    caveat:
      'Runs locally via npx (Node.js ≥ 22); the first run downloads the package from npm, and `@latest` re-resolves it on each start. Sources whose terms discourage automation (Google News, Nasdaq, Yahoo quotes) stay off. Off by default — switch it on here to let agents browse the web.',
    promptHint:
      'your web research kit. webvector_news (symbols, hours) for the catalyst behind a gap or an unexplained move and for "what happened since my last run"; webvector_filings before holding into a filing window or when dilution/insider activity matters; webvector_calendar before sizing around 8:30/14:00 ET prints or earnings; webvector_sentiment for crowd skew; webvector_pulse for VIX/yields context; webvector_research for any other question about the web (then webvector_fetch to read one URL). Budget: one or two targeted calls per run, then decide — never a research project.',
    defaultOn: false
  },
  {
    id: 'edgar',
    name: 'SEC EDGAR',
    tagline: 'Filings: 8-K events, Form 4 insiders, 13F holders, XBRL financials',
    adds: ['Material events (8-K) filed since the last run', 'Insider buys/sells (Form 4)', 'Institutional & 5% holders', 'Full-text filing search'],
    transport: { kind: 'http', url: 'https://secedgar.caseyjhand.com/mcp' },
    keyed: false,
    freeTier: 'Free — public SEC data, no key',
    docsUrl: 'https://github.com/cyanheads/secedgar-mcp-server',
    caveat: 'Community-hosted public instance of an open-source server; may rate-limit or go down.',
    promptHint: 'secedgar_get_material_events / secedgar_get_insider_transactions before holding a position overnight or into a filing window.'
  },
  {
    id: 'alphavantage',
    name: 'Alpha Vantage',
    tagline: 'News with sentiment scores, earnings calendar, insider transactions, economic indicators',
    adds: ['Ticker-tagged news with sentiment scores (NEWS_SENTIMENT)', 'Insider transactions', 'Economic indicators (CPI, rates, GDP)', '48 technical indicators'],
    transport: { kind: 'http', url: 'https://mcp.alphavantage.co/mcp', keyQueryParam: 'apikey' },
    keyed: true,
    keyLabel: 'Alpha Vantage API key',
    keyUrl: 'https://www.alphavantage.co/support/#api-key',
    freeTier: 'Free key: 25 requests/day',
    docsUrl: 'https://github.com/alphavantage/alpha_vantage_mcp',
    caveat: 'The free key is tiny (25/day) — a couple of interval agents will exhaust it; real-time quotes are premium (use Robinhood for prices).',
    promptHint: 'NEWS_SENTIMENT for scored headlines on a symbol; spend calls sparingly (25/day budget shared by all agents).'
  },
  {
    id: 'econcal',
    name: 'Economic calendar (Apify)',
    tagline: 'FOMC, CPI, NFP, GDP with consensus, prior and surprise verdicts',
    adds: ['Upcoming high-impact US releases with times', 'Consensus vs. prior vs. actual', 'Fed speeches and decisions'],
    transport: { kind: 'http', url: 'https://mcp.apify.com/?tools=michael_b/economic-calendar-fed-watch', headers: { Authorization: 'Bearer ${KEY}' } },
    keyed: true,
    keyLabel: 'Apify API token',
    keyUrl: 'https://console.apify.com/settings/integrations',
    freeTier: 'Apify free plan: $5 credit/month (~$0.02 per query)',
    docsUrl: 'https://apify.com/michael_b/economic-calendar-fed-watch/api/mcp',
    promptHint: 'Check high-impact releases in the next 24h before opening an overnight hold or sizing a buy near 8:30 AM ET.'
  },
  {
    id: 'yfinance',
    name: 'Yahoo Finance',
    tagline: 'News, analyst upgrades/downgrades & targets, holders, option chains, screeners',
    adds: ['Recent news per ticker (no key)', 'Analyst upgrades/downgrades and price targets', 'Insider & institutional holders', 'Gapper and custom screeners'],
    transport: { kind: 'stdio', command: 'uvx', args: ['yfmcp@latest'], needs: 'uv' },
    keyed: false,
    freeTier: 'Free — no key (unofficial Yahoo feed)',
    docsUrl: 'https://github.com/narumiruna/yfinance-mcp',
    caveat: 'Runs locally via uv (Python). Unofficial scraping feed — fine for news/context, not for prices.',
    promptHint: 'yfinance_get_ticker_news and yfinance_get_upgrades_downgrades explain a gap or a dip before you trade it.'
  },
  {
    id: 'tiingo',
    name: 'Tiingo',
    tagline: 'Curated financial news per ticker plus fundamentals and EOD prices',
    adds: ['News by ticker/tag/source/date (3-month history)', 'Daily fundamentals (market cap, P/E, EV/EBITDA)', 'Financial statements'],
    transport: { kind: 'stdio', command: 'uvx', args: ['tiingo-mcp'], keyEnv: 'TIINGO_API_KEY', needs: 'uv' },
    keyed: true,
    keyLabel: 'Tiingo API key',
    keyUrl: 'https://www.tiingo.com/account/api/token',
    freeTier: 'Free key: 1,000 requests/day, news included',
    docsUrl: 'https://github.com/wshobson/tiingo-mcp',
    caveat: 'Runs locally via uv (Python 3.12+).',
    promptHint: 'get_news with the symbol and a startDate of the last run for what happened while you were asleep.'
  },
  {
    id: 'fred',
    name: 'FRED (St. Louis Fed)',
    tagline: '800k+ macro series: rates, CPI, yields, unemployment',
    adds: ['Fed funds rate, 2y/10y yields, CPI, jobs', 'Any FRED series by id with transformations'],
    transport: { kind: 'stdio', command: 'npx', args: ['-y', 'fred-mcp-server'], keyEnv: 'FRED_API_KEY', needs: 'node' },
    keyed: true,
    keyLabel: 'FRED API key',
    keyUrl: 'https://fred.stlouisfed.org/docs/api/api_key.html',
    freeTier: 'Free key, generous limits',
    docsUrl: 'https://github.com/stefanoamorelli/fred-mcp-server',
    caveat: 'Runs locally via npx (Node.js).',
    promptHint: 'fred_get_series for macro backdrop only (e.g. DGS10, FEDFUNDS, CPIAUCSL) — not for intraday decisions.'
  },
  {
    id: 'finnhub',
    name: 'Finnhub',
    tagline: 'Company & market news, news/insider sentiment, analyst recommendations, earnings surprises',
    adds: ['Company and market news', 'News sentiment and insider sentiment scores', 'Analyst recommendation trends', 'Earnings surprises'],
    transport: { kind: 'stdio', command: 'npx', args: ['-y', 'aigroup-finnhub-mcp'], keyEnv: 'FINNHUB_API_KEY', needs: 'node' },
    keyed: true,
    keyLabel: 'Finnhub API key',
    keyUrl: 'https://finnhub.io/dashboard',
    freeTier: 'Free key: 60 requests/minute',
    docsUrl: 'https://www.npmjs.com/package/aigroup-finnhub-mcp',
    caveat: 'Runs locally via npx (Node.js).',
    promptHint: 'finnhub_news_sentiment (get_company_news / get_news_sentiment) for the why behind a move.'
  }
]

export const MCP_PROVIDER_IDS: McpProviderId[] = MCP_PROVIDERS.map((p) => p.id)

export function mcpProvider(id: string): McpProvider | undefined {
  return MCP_PROVIDERS.find((p) => p.id === id)
}

/* ───────────────────────────── Policy ───────────────────────────── */

export interface ToolPolicy {
  /** Robinhood READ tools (bare names) switched off for every agent. Reads are on by default. */
  robinhoodDisabled: string[]
  /** Robinhood WRITE tools (bare names) switched on. Writes are off by default and only
   *  ever reachable by live, armed agents. */
  robinhoodWriteEnabled: string[]
  /** Intel MCP providers switched on for every agent. */
  mcpEnabled: McpProviderId[]
  /**
   * Providers whose default has already been applied to this policy. A `defaultOn`
   * provider the operator has never seen is switched on once (here) and then left
   * alone — turning it off sticks.
   */
  mcpSeen: McpProviderId[]
}

/** Providers that are on until the operator says otherwise. */
const DEFAULT_ON_IDS: McpProviderId[] = MCP_PROVIDERS.filter((p) => p.defaultOn).map((p) => p.id)

export const DEFAULT_TOOL_POLICY: ToolPolicy = { robinhoodDisabled: [], robinhoodWriteEnabled: [], mcpEnabled: [...DEFAULT_ON_IDS], mcpSeen: [...DEFAULT_ON_IDS] }

const TOOL_NAME = /^[a-z0-9_]{1,64}$/i
function names(list: unknown): string[] {
  return Array.isArray(list) ? [...new Set(list.filter((n): n is string => typeof n === 'string' && TOOL_NAME.test(n)))] : []
}

const knownIds = (list: unknown): McpProviderId[] =>
  Array.isArray(list) ? [...new Set(list.filter((id): id is McpProviderId => MCP_PROVIDER_IDS.includes(id as McpProviderId)))] : []

export function normalizeToolPolicy(p: Partial<ToolPolicy> | null | undefined): ToolPolicy {
  const enabled = new Set(knownIds(p?.mcpEnabled))
  const seen = new Set(knownIds(p?.mcpSeen))
  // Apply each default-on provider exactly once per policy; after that the operator's switch wins.
  for (const id of DEFAULT_ON_IDS) {
    if (seen.has(id)) continue
    enabled.add(id)
    seen.add(id)
  }
  return {
    robinhoodDisabled: names(p?.robinhoodDisabled).filter((n) => robinhoodToolKind(n) === 'read'),
    robinhoodWriteEnabled: names(p?.robinhoodWriteEnabled).filter((n) => robinhoodToolKind(n) === 'write'),
    mcpEnabled: [...enabled],
    mcpSeen: [...seen]
  }
}

/** Does the operator's policy let agents call this Robinhood tool at all? */
export function robinhoodToolOn(bare: string, policy: ToolPolicy): boolean {
  return robinhoodToolKind(bare) === 'write' ? policy.robinhoodWriteEnabled.includes(bare) : !policy.robinhoodDisabled.includes(bare)
}
