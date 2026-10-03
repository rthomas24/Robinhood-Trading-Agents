import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MAX_MODEL_DAILY_LOSS_PCT, QUESTION_WAIT_DEFAULT_MIN, QUESTION_WAIT_MAX, QUESTION_WAIT_MIN, type AgentConfig, type AgentReport, type Errand, type ExitSpec, type PlanProposal, type SpawnSpec, type RetirementPolicy, type Schedule, type TradeIntent, type WatchCondition } from '@shared/agents'
import { MAX_AGENT_NAME } from '@shared/createAgent'
import { etClock, etDateTime, formatEt } from '@shared/marketTime'
import { validateSchedule } from '@shared/schedule'
import { MAX_SLEEP_DAYS, parseSleepUntil } from '@shared/sleep'

/**
 * The agent's own tools, VENDOR-NEUTRAL: name + description + zod input schema +
 * a handler that talks to the engine through `ToolHost`. Each model vendor
 * adapts these — the Claude runner wraps them in an in-process MCP server, the
 * OpenRouter runner registers them as function tools — so prompts, allowlists
 * and the UI see the same `mcp__tb__<name>` everywhere.
 */
/**
 * Lenient argument coercion.
 *
 * A model that emits `qty: "5"` instead of `5` has made no mistake a person
 * would make twice, but a strict parse throws the whole tool call away. Every
 * vendor validates against THIS schema — the Claude runner via
 * `t.schema.shape`, the OpenRouter SDK via `inputSchema`, the ChatGPT and Local
 * runners via `safeParse` — so a `z.preprocess` here is enforced once for all
 * four. Doing it at the vendor call sites instead would be four
 * implementations of one rule, which is how one gets missed.
 *
 * WRAP THE FIELD, NEVER THE OBJECT: `vendors/claude.ts` passes
 * `t.schema.shape`, and a `ZodPipe` has no `.shape` — wrapping the top-level
 * object would break that vendor at construction time, before any argument is
 * ever parsed.
 *
 * Verified on zod 4.4.3 that this does NOT change the JSON Schema the model is
 * shown (`z.toJSONSchema(..., { io: 'input' })` still emits the type, the
 * bounds, the enum list and the description). That mattered: a coercion that
 * widened the advertised schema to `any` would cause the very sloppiness it
 * exists to absorb.
 *
 * Leniency is not permissiveness. `"abc"` is still not a number and `"-5"` is
 * still not positive — the inner schema decides, and only the REPRESENTATION
 * is repaired.
 *
 * ⚠️ THE ONE FIELD THAT NEVER COERCES IS `side`. Coercing `qty` is
 * unambiguous; a guess about buy-vs-sell is a wrong trade. The rule is by FIELD
 * TYPE, not by tool kind, precisely so that adding a write tool later cannot
 * quietly opt into something looser.
 */
const lenientNumber = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v
    // Models format money the way prose does: "$1,250.50".
    const t = v.trim().replace(/^\$/, '').replace(/,/g, '')
    return t !== '' && Number.isFinite(Number(t)) ? Number(t) : v
  }, inner)

/**
 * Free text with a length bound the model is TOLD about and never punished
 * for: a 130-character reason is clipped to `max`, not thrown away with the
 * whole call. The inner `.max()` stays so the advertised JSON Schema keeps its
 * `maxLength`; the preprocess only guarantees the value meets it. Trims first,
 * so whitespace never counts against the bound.
 */
const lenientString = <T extends z.ZodTypeAny>(max: number, inner: T) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v
    const t = v.trim()
    return t.length > max ? t.slice(0, max) : t
  }, inner)

const lenientBoolean = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => {
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase()
      if (t === 'true' || t === 'yes') return true
      if (t === 'false' || t === 'no') return false
    }
    if (v === 1) return true
    if (v === 0) return false
    return v
  }, inner)

/**
 * Case- and whitespace-insensitive match against the declared values. Takes the
 * values explicitly rather than reading `.options` off the inner schema,
 * because by the time `.optional()` or `.default()` has wrapped it there is no
 * `.options` to read.
 */
const lenientEnum = <T extends z.ZodTypeAny>(values: readonly string[], inner: T) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v
    const t = v.trim()
    return values.find((x) => x.toLowerCase() === t.toLowerCase()) ?? v
  }, inner)

export const TB_SERVER_NAME = 'tb'
export const tbToolName = (bare: string): string => `mcp__${TB_SERVER_NAME}__${bare}`

export interface ToolHost {
  trade(intent: TradeIntent): Promise<string>
  cancelOrder(orderId: string): Promise<string>
  /**
   * `pct` is resolved against the agent's allocation by the HOST, which is the
   * only place that knows it. The stored policy stays in dollars.
   */
  changePlan(plan: PlanProposal, pct?: { profitTargetPct?: number; maxLossPct?: number }): Promise<string>
  setExit(args: { symbol: string; clear: boolean; acknowledgeTight?: boolean } & ExitSpec): Promise<string>
  watchPrice(args: { symbol: string; condition: WatchCondition; value: number; note?: string; cancel?: boolean; id?: string }): Promise<string>
  setThesis(symbol: string, thesis: string | undefined): Promise<string>
  /**
   * Name yourself, once, when the operator left the name blank.
   * Refused otherwise — an operator's name is theirs, not the agent's.
   */
  setName(name: string): Promise<string>
  retire(reason: string): Promise<string>
  /** `defer` turns a durable fact into a one-time errand the engine hands back when its moment comes. */
  remember(note: string, defer?: Errand['when']): Promise<string>
  forget(match: string): Promise<string>
  /**
   * Search the WHOLE thread — not the ~24-message window the prompt carries.
   * Makes falling off the transcript RECOVERABLE rather than terminal.
   */
  searchThread(query: string, limit: number): Promise<string>
  /**
   * Live prices / candles for ANY symbol from whichever feed prices this run
   * (Robinhood, or the operator's market-data key for a paper agent without one).
   * Read-only: the one way an agent with no broker can size a new idea.
   */
  quotes(symbols: string[]): Promise<string>
  bars(symbol: string, interval: 'day' | '5minute', days: number): Promise<string>
  /** All-in earnings mode: this session's reporters with their reaction history (`core/research/earnings.ts`). */
  earningsCandidates(): Promise<string>
  /** All-in earnings mode: one name's full pre-report dossier. */
  earningsDossier(symbol: string): Promise<string>
  /** Settle a pending errand so it stops being handed back. */
  errandDone(id: string, outcome: string): Promise<string>
  /**
   * Park the agent until a dated moment (already parsed by the tool; `until`
   * is an instant). The host refuses the past, anything past MAX_SLEEP_DAYS and
   * a paused/retired agent; `cancel` wakes it back onto its schedule.
   */
  sleepUntil(args: { until?: Date; reason?: string; cancel?: boolean; raw?: string }): Promise<string>
  /** Post a card asking the operator to confirm a NEW standing task. Never auto-applies. */
  proposeTask(task: string, why: string): Promise<string>
  /** Post a card asking the operator to confirm a NEW AGENT. Checks the plan's capacity first and explains a refusal. */
  proposeAgent(spec: SpawnSpec): Promise<string>
  /** Post a question card with a deadline + promised fallback; the host enforces the one-open / unattended budget. */
  askOperator(args: { question: string; options?: string[]; stakes: string; fallback: string; waitMinutes?: number }): Promise<string>
  /** Post a message flagged worth interrupting the operator for (not a routine end-of-run summary). */
  tellOperator(message: string, urgency: 'fyi' | 'important'): Promise<string>
  /** File the structured end-of-run summary; the host attaches it to the run's final message. */
  report(r: AgentReport): Promise<string>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZodObject = z.ZodObject<any>

export interface AgentToolDef<S extends AnyZodObject = AnyZodObject> {
  /** Bare name; vendors expose it as `mcp__tb__<name>`. */
  name: string
  description: string
  schema: S
  run(args: z.infer<S>, host: ToolHost): Promise<string>
}

function def<S extends AnyZodObject>(name: string, description: string, schema: S, run: (args: z.infer<S>, host: ToolHost) => Promise<string>): AgentToolDef<S> {
  return { name, description, schema, run }
}

const scheduleSchema = z
  .object({
    kind: lenientEnum(['manual', 'interval', 'times', 'once'], z.enum(['manual', 'interval', 'times', 'once']).describe('manual = only when the operator runs you; interval = every N minutes; times = specific ET clock times on given days; once = a single datetime')),
    everyMinutes: lenientNumber(z.number().int().min(1).max(1440).optional().describe('interval: minutes between runs')),
    marketHoursOnly: lenientBoolean(z.boolean().optional().describe('interval: only run during the regular session (default true)')),
    times: z.array(z.string()).optional().describe('times: 24h "HH:MM" in ET, e.g. ["15:58","09:31"]'),
    days: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).optional().describe('times: days of week (default Mon–Fri)'),
    tradingDaysOnly: lenientBoolean(z.boolean().optional().describe('times: skip market holidays (default true)')),
    at: z.string().optional().describe('once: ISO 8601 datetime')
  })
  .describe('When the agent should wake up')

export function toSchedule(s: z.infer<typeof scheduleSchema>): Schedule {
  switch (s.kind) {
    case 'manual':
      return { kind: 'manual' }
    case 'interval':
      return { kind: 'interval', everyMinutes: s.everyMinutes ?? 5, marketHoursOnly: s.marketHoursOnly ?? true }
    case 'times':
      return { kind: 'times', times: s.times ?? [], days: s.days ?? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], tradingDaysOnly: s.tradingDaysOnly ?? true }
    case 'once':
      return { kind: 'once', at: s.at ?? new Date().toISOString() }
  }
}

const changePlan = def(
  'change_plan',
  'Change this agent\'s plan. Call it whenever the operator asks to change WHAT you do, WHEN you run, your limits, or your name — and on first setup. Send ONLY the fields that change; omitted fields keep their current value. Times are ET, 24h "HH:MM". Example: "buy at 3:58 and sell at 9:31 every trading day" → schedule kind "times", times ["15:58","09:31"]. Whether it applies at once or posts a card for the operator to tap depends on this agent\'s Acting setting — your instructions say which. Anything that WIDENS your limits (a bigger order, more orders, more exposure per symbol, a looser daily loss limit, more symbols, extra hours) is the consequential case: an agent that acts on its own applies it and the operator is alerted; an agent that asks first always waits for their tap, even when they told you to be more aggressive. Tightening always applies immediately. NEVER call this to confirm or restate settings you already have — a plan that changes nothing is refused, and on a scheduled run it would otherwise ask the operator to approve a no-op. Your current schedule, limits and task are in your context; read them there.',
  z.object({
    name: z.string().min(1).max(40).optional().describe('New display name (only if the operator asked to rename)'),
    task: z.string().min(3).optional().describe('ONLY to reword the agent\'s existing goal, or to set it during first setup. To take on something ADDITIONAL, use propose_task instead — adding a job needs the operator\'s confirmation, rewording one does not.'),
    schedule: scheduleSchema.optional().describe('Omit to keep the current schedule'),
    retirement: z
      .object({
        profitTargetUsd: lenientNumber(z.number().positive().optional().describe('Self-retire when total P&L reaches this many USD (e.g. the operator wants "$100 profit then stop")')),
        profitTargetPct: lenientNumber(z.number().positive().max(1000).optional().describe('Same, but as a % of your allocation — use this when the operator states the goal in percent ("make 10% this week"). The engine converts it against your capital, so you never have to.')),
        maxLossUsd: lenientNumber(z.number().positive().optional().describe('Give up and retire when total P&L falls to minus this many USD')),
        maxLossPct: lenientNumber(z.number().positive().max(100).optional().describe('Same, but as a % of your allocation.')),
        endOfToday: lenientBoolean(z.boolean().optional().describe('true = retire at 8:00 PM ET today ("just run for today")')),
        at: z.string().optional().describe('Retire at this ISO datetime (overrides endOfToday)'),
        flatten: lenientBoolean(z.boolean().optional().describe('Sell remaining positions when retiring (default true)')),
        clear: lenientBoolean(z.boolean().optional().describe('true = remove any retirement policy'))
      })
      .optional()
      .describe('Self-retirement conditions — set when the task has an end ("make $100 then stop", "run for today only")'),
    guardrails: z
      .object({
        allowedSymbols: z.array(z.string()).optional().describe('Restrict to these tickers (uppercase). Omit to keep current.'),
        maxOrderNotional: lenientNumber(z.number().positive().optional().describe('USD cap per order')),
        maxOrdersPerDay: lenientNumber(z.number().int().positive().optional()),
        marketHoursOnly: lenientBoolean(z.boolean().optional()),
        allowExtendedHours: lenientBoolean(z.boolean().optional()),
        maxPositionNotional: lenientNumber(z.number().positive().optional()),
        maxDailyLossPct: z
          .number()
          .positive()
          .max(MAX_MODEL_DAILY_LOSS_PCT)
          .optional()
          .describe(
            `Daily loss limit as % of allocation; breaching it disables buys for the day. You may set at most ${MAX_MODEL_DAILY_LOSS_PCT} — it is the only guardrail that STOPS you rather than sizing you, and turning it off is the operator's call in Settings, not yours.`
          ),
        noEntriesBeforeEt: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional().describe('ET "HH:MM": no buys before this minute (the opening range is the widest, least tradeable part of the day). null removes it.'),
        maxEntryExtensionPct: lenientNumber(z.number().min(0).max(50).nullable().optional().describe('Refuse buys more than this % above VWAP or above the day open — no chasing. null removes it.')),
        maxSymbolDayPct: lenientNumber(z.number().min(1).max(100).nullable().optional().describe('Cap on one day\'s buys in ONE symbol as % of allocation; also one buy per symbol per run. null removes it.')),
        reentryCooldownMin: lenientNumber(z.number().int().min(0).max(1440).nullable().optional().describe('Minutes to wait before re-buying a symbol you just sold at a LOSS. null removes it.')),
        maxNewPositionsPerRun: lenientNumber(z.number().int().min(1).max(50).nullable().optional().describe('How many NEW positions one run may open (adds to held names are unlimited). null removes it.')),
        settlement: z
          .enum(['cash', 'margin'])
          .nullable()
          .optional()
          .describe('How sale proceeds are treated for buys: "cash" = only SETTLED cash may buy, proceeds return the next trading day (T+1 — the Robinhood Agentic default); "margin" = proceeds reusable at once (limited margin). null stops simulating it. A LIVE agent follows the broker\u2019s real account type whatever this says; this is the operator\u2019s call to make, not yours — propose it, do not assume it.')
      })
      .optional()
      .describe('Only the guardrails you want to change'),
    summary: z.string().describe('One line, human-readable, describing the CHANGE (or the full plan on setup), e.g. "Now also selling at 3:55 PM on Fridays"')
  }),
  async (args, host) => {
    const schedule = args.schedule ? toSchedule(args.schedule) : undefined
    const err = schedule ? validateSchedule(schedule) : null
    if (err) return `Plan rejected: ${err}. Fix the schedule and call change_plan again.`
    const g = args.guardrails ?? {}
    const r = args.retirement
    // A deadline in the past is not a plan, it is an instant retirement: the
    // engine's `retirementDue` fires on the next tick with "Deadline reached".
    // A respawned agent can do exactly this — re-state the deadline of an
    // engagement that has already ENDED — so the check
    // lives here, where the refusal reaches the model as the tool result with
    // today's date in it, rather than in the trigger a week too late.
    if (r && !r.clear) {
      const nowMs = Date.now()
      const today = etClock(new Date(nowMs))
      if (r.at !== undefined) {
        const atMs = Date.parse(r.at)
        if (Number.isNaN(atMs)) return `Plan rejected: retirement.at ${JSON.stringify(r.at)} is not an ISO datetime. Today is ${today.weekday} ${today.date}; give a full ISO instant with an offset, e.g. "${today.date}T16:05:00-04:00".`
        if (atMs <= nowMs) return `Plan rejected: retirement.at ${formatEt(r.at, true)} is already in the PAST — applying it would retire you immediately. Today is ${today.weekday} ${today.date}, ${formatEt(nowMs)}; compute the deadline from TODAY's date and call change_plan again.`
      } else if (r.endOfToday && today.minutes >= 20 * 60) {
        return `Plan rejected: endOfToday means 8:00 PM ET today (${today.weekday} ${today.date}) and it is already ${formatEt(nowMs)} — that deadline has passed and would retire you immediately. Use retirement.at with the next session's date instead.`
      }
    }
    // A deadline without a target is a timer, and a target without a deadline
    // never ends. "10% this week" is both, and the model has to be told to send
    // both — the schema cannot enforce it because either alone is legitimate.
    return host.changePlan(
      {
      ...(args.name ? { name: args.name } : {}),
      ...(args.task ? { task: args.task } : {}),
      ...(schedule ? { schedule } : {}),
      ...(args.retirement
        ? {
            retirement: args.retirement.clear
              ? null
              : ({
                  ...(args.retirement.profitTargetUsd !== undefined ? { profitTargetUsd: args.retirement.profitTargetUsd } : {}),
                  ...(args.retirement.maxLossUsd !== undefined ? { maxLossUsd: args.retirement.maxLossUsd } : {}),
                  ...(args.retirement.at ? { at: args.retirement.at } : args.retirement.endOfToday ? { at: etDateTime(etClock().date, 20 * 60).toISOString() } : {}),
                  ...(args.retirement.flatten !== undefined ? { flatten: args.retirement.flatten } : {})
                } satisfies RetirementPolicy)
          }
        : {}),
        guardrails: {
          ...(g.allowedSymbols ? { allowedSymbols: g.allowedSymbols.map((s) => s.toUpperCase()) } : {}),
          ...(g.maxOrderNotional !== undefined ? { maxOrderNotional: g.maxOrderNotional } : {}),
          ...(g.maxOrdersPerDay !== undefined ? { maxOrdersPerDay: g.maxOrdersPerDay } : {}),
          ...(g.marketHoursOnly !== undefined ? { marketHoursOnly: g.marketHoursOnly } : {}),
          ...(g.allowExtendedHours !== undefined ? { allowExtendedHours: g.allowExtendedHours } : {}),
          ...(g.maxPositionNotional !== undefined ? { maxPositionNotional: g.maxPositionNotional } : {}),
          ...(g.maxDailyLossPct !== undefined ? { maxDailyLossPct: g.maxDailyLossPct } : {}),
          // `null` = remove the rule. Carried as `undefined` under the key so
          // `guardrailDiff` (`key in next`) can tell "remove" from "unchanged".
          ...(g.noEntriesBeforeEt !== undefined ? { noEntriesBeforeEt: g.noEntriesBeforeEt ?? undefined } : {}),
          ...(g.maxEntryExtensionPct !== undefined ? { maxEntryExtensionPct: g.maxEntryExtensionPct ?? undefined } : {}),
          ...(g.maxSymbolDayPct !== undefined ? { maxSymbolDayPct: g.maxSymbolDayPct ?? undefined } : {}),
          ...(g.reentryCooldownMin !== undefined ? { reentryCooldownMin: g.reentryCooldownMin ?? undefined } : {}),
          ...(g.maxNewPositionsPerRun !== undefined ? { maxNewPositionsPerRun: g.maxNewPositionsPerRun ?? undefined } : {}),
          ...(g.settlement !== undefined ? { settlement: g.settlement ?? undefined } : {})
        },
        summary: args.summary
      },
      r && !r.clear && (r.profitTargetPct !== undefined || r.maxLossPct !== undefined) ? { profitTargetPct: r.profitTargetPct, maxLossPct: r.maxLossPct } : undefined
    )
  }
)

/**
 * The exit levels beyond stop/target/trail, shared by `trade` and `set_exit` so
 * the two tools cannot drift.
 * Flat fields rather than a nested object because the top-level schema must
 * stay a plain z.object for the Claude vendor (`.shape`), and models fill flat
 * fields far more reliably than nested ones.
 */
const exitLevelFields = {
  flattenAt: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .optional()
    .describe('BUYS: ET "HH:MM" (e.g. "15:55"). At or after this minute of the regular session the engine market-sells the WHOLE position, whatever the price. Set it whenever the task says same-day, flat by close, or never hold overnight — a trail cannot see the overnight gap, this can. The minute is the FIRST one after the buy: if it has already passed today it fires TOMORROW at that minute ("09:31" on a 15:58 buy = out at the next open) — for a same-day exit, buy before it.'),
  armAfterMin: lenientNumber(z.number().int().min(0).max(120).optional().describe('BUYS: opening-range grace — the trailing stop is not judged until this many minutes after the 09:30 open (it still ratchets; the hard stop, target and invalidation still fire). Default 0.')),
  stopIfBelow: lenientNumber(z.number().positive().optional().describe('BUYS: invalidation level — market-sell the whole position if the price falls to this. Enforced like a hard stop but reported with stopIfReason. Use this instead of a price watch for "cut it if it loses X".')),
  stopIfAbove: lenientNumber(z.number().positive().optional().describe('BUYS: the symmetric invalidation — sell if the price RISES to this (a level whose breach means your thesis was wrong the other way).')),
  stopIfReason: lenientString(120, z.string().max(120).optional().describe('Why the invalidation level invalidates the thesis (required with stopIfBelow/stopIfAbove; shown on the exit card).')),
  breakEvenAfterPct: lenientNumber(z.number().positive().max(50).optional().describe('BUYS: once the position is up this many % from your average cost, the engine moves the stop up to that cost (never down).')),
  targetPct: lenientNumber(z.number().min(1).max(100).optional().describe('BUYS: the takeProfit sells only this % of the position (default 100). The remainder keeps the stop/trail; the target is spent once it fires.'))
}

/** The exit fields of a tool call, in the `ExitSpec` shape the engine stores. */
function exitSpecFromArgs(a: { flattenAt?: string; armAfterMin?: number; stopIfBelow?: number; stopIfAbove?: number; stopIfReason?: string; breakEvenAfterPct?: number; targetPct?: number }): ExitSpec {
  const stopIf = a.stopIfBelow !== undefined || a.stopIfAbove !== undefined ? { below: a.stopIfBelow, above: a.stopIfAbove, reason: a.stopIfReason?.trim() || 'invalidation level' } : undefined
  return {
    ...(a.flattenAt !== undefined ? { flattenAt: a.flattenAt } : {}),
    ...(a.armAfterMin !== undefined ? { armAfterMin: a.armAfterMin } : {}),
    ...(stopIf ? { stopIf } : {}),
    ...(a.breakEvenAfterPct !== undefined ? { breakEvenAfterPct: a.breakEvenAfterPct } : {}),
    ...(a.targetPct !== undefined ? { targetPct: a.targetPct } : {})
  }
}

const trade = def(
  'trade',
  'Place an equity order through the engine (the ONLY way to trade). Give qty OR notional (USD); a SELL with neither closes the whole position. Market orders need the regular session unless extended hours are allowed (then limit only). The engine checks your guardrails and returns the outcome — read it; do not retry a rejected order with the same parameters.',
  z.object({
    side: z.enum(['buy', 'sell']),
    symbol: z.string().describe('Ticker, e.g. MU'),
    qty: lenientNumber(z.number().positive().optional().describe('Shares (fractional ok in paper; live market orders may be fractional, live limit orders whole shares)')),
    notional: lenientNumber(z.number().positive().optional().describe('USD amount instead of qty (market orders)')),
    type: lenientEnum(['market', 'limit'], z.enum(['market', 'limit']).default('market')),
    limitPrice: lenientNumber(z.number().positive().optional().describe('Required for limit')),
    tif: lenientEnum(['day', 'gtc'], z.enum(['day', 'gtc']).default('day')),
    stopLoss: z
      .number()
      .positive()
      .optional()
      .describe(
        'BUYS: protective stop — the engine market-sells the whole position if the price touches it. Must sit BELOW your entry: one at or above it is already breached and would liquidate you on the next check, so it is refused. It is a MARKET sell and only fires while the regular session is open — it cannot protect you against an overnight gap.'
      ),
    takeProfit: lenientNumber(z.number().positive().optional().describe('BUYS: profit target — the engine sells the whole position when reached. Must sit ABOVE your entry. Same session limits as the stop.')),
    trailPct: z
      .number()
      .min(0.1)
      .max(50)
      .optional()
      .describe('BUYS: trailing stop as a % from the high after you are filled — "sell if it drops 3% from its peak". Ratchets up with the price and never down. Use with stopLoss for a hard floor as well; the engine enforces whichever is tighter. Must be at least the trail floor shown in TECHNICALS (0.75× the name\'s average daily range) unless you pass acknowledgeTight.'),
    ...exitLevelFields,
    acknowledgeTight: lenientBoolean(z.boolean().optional().describe('true = you read the advisory (a trail narrower than the floor on a BUY, or a SELL at a loss inside the noise band with a stop already armed below) and still want it. Say why in reason.')),
    reason: z.string().describe('One short sentence: why (shown on the action card)')
  })
    // A call with neither size is rejected at the VENDOR boundary —
    // every runner parses against this schema — so it never reaches the host.
    // On zod 4 `.refine` keeps the ZodObject (and its `.shape`, which the
    // Claude vendor reads) and leaves the advertised JSON schema unchanged;
    // `check-trade-schema.ts` pins both. The human-readable bounce below stays
    // as the fallback for a vendor that hands arguments through unparsed.
    // A SELL with neither closes the whole position (the host fills in the
    // held quantity): "sell META — early cut" with no size was the model's
    // most common fumble, and it means exactly one thing.
    .refine((a) => a.side === 'sell' || (a.qty ?? 0) > 0 || (a.notional ?? 0) > 0, { message: 'give qty OR notional (USD) > 0 (a sell may omit both to close the whole position)', path: ['qty'] }),
  async (args, host) => {
    // Argument fumbles bounce HERE, before the host: they get no action card
    // and no decision-log row, because "the model forgot a parameter" is not a
    // trading decision — it is retry noise, and posting a rejected card for
    // each one would clutter the operator's thread twice per trade. The guardrail
    // rules (`size.missing`, `limit.missingPrice`) remain as the backstop for
    // every non-tool path into `executeTrade`.
    if (args.side === 'buy' && !(args.qty && args.qty > 0) && !(args.notional && args.notional > 0)) {
      return 'NOT PLACED (missing argument): give qty OR notional (USD) > 0. No card was posted — retry the same order WITH a size.'
    }
    if (args.type === 'limit' && !(args.limitPrice && args.limitPrice > 0)) {
      return 'NOT PLACED (missing argument): a limit order needs limitPrice > 0 — without one it can never fill. No card was posted — retry WITH limitPrice, or use type "market".'
    }
    const intent: TradeIntent = {
      side: args.side,
      symbol: args.symbol.toUpperCase(),
      qty: args.qty,
      notional: args.notional,
      type: args.type,
      limitPrice: args.limitPrice,
      tif: args.tif,
      stopLoss: args.stopLoss,
      takeProfit: args.takeProfit,
      trailPct: args.trailPct,
      ...exitSpecFromArgs(args),
      ...(args.acknowledgeTight ? { acknowledgeTight: true } : {}),
      reason: args.reason
    }
    return host.trade(intent)
  }
)

const cancelOrder = def('cancel_order', 'Cancel one of YOUR open orders by id (see "open orders" in your book).', z.object({ orderId: z.string() }), async (args, host) => host.cancelOrder(args.orderId))

const setExit = def(
  'set_exit',
  'Set, update, or clear the ENGINE-ENFORCED exit plan on a position you hold: stop, profit target, trailing stop, invalidation levels, break-even ratchet, opening-range grace and a flatten time. The engine watches prices between your runs and market-sells when a level is breached. Omitted fields keep their current value. Prefer attaching the levels to the buy itself; use this to adjust afterward.',
  z.object({
    symbol: z.string(),
    stop: lenientNumber(z.number().positive().optional().describe('Stop price. Must sit BELOW the current price — one at or above it fires immediately and sells the whole position. Omit to leave any stop already set untouched; use clear to remove one.')),
    target: lenientNumber(z.number().positive().optional().describe('Profit target price. Must sit ABOVE the current price. Omit to leave the existing target untouched.')),
    trailPct: z
      .number()
      .min(0.1)
      .max(50)
      .optional()
      .describe('TRAILING stop: sell if the price falls this many % from its high. The high ratchets up as the price rises and never falls, so this locks in gains while letting a winner run. Combine with `stop` for a hard floor — the engine enforces whichever is tighter. Must be at least the trail floor in TECHNICALS unless you pass acknowledgeTight.'),
    ...exitLevelFields,
    acknowledgeTight: lenientBoolean(z.boolean().optional().describe('true = you read the trail-floor advisory and still want a trail narrower than the floor.')),
    clear: lenientBoolean(z.boolean().default(false).describe('true = remove the exit plan for this symbol'))
  }),
  async (args, host) =>
    host.setExit({
      symbol: args.symbol.toUpperCase(),
      stopLoss: args.stop,
      takeProfit: args.target,
      trailPct: args.trailPct,
      ...exitSpecFromArgs(args),
      ...(args.acknowledgeTight ? { acknowledgeTight: true } : {}),
      clear: args.clear
    })
)

const watchItem = z.object({
  symbol: z.string(),
  // Optional at the SCHEMA because a cancel item legitimately has neither; the
  // handler requires both for a set item and answers with instructions.
  condition: lenientEnum(['above', 'below', 'move_up_pct', 'move_down_pct'], z.enum(['above', 'below', 'move_up_pct', 'move_down_pct']).optional().describe('above/below an absolute price, or a % move from the CURRENT price (required unless cancelling)')),
  value: lenientNumber(z.number().positive().optional().describe('Price for above/below; percent (e.g. 2 = 2%) for move_* (required unless cancelling)')),
  note: lenientString(120, z.string().max(120).optional().describe('What you intend to do when it fires')),
  cancel: lenientBoolean(z.boolean().default(false).describe('true = cancel a watch instead of setting one')),
  id: z.string().optional().describe('With cancel: the id of ONE watch to drop (shown in your ACTIVE PRICE WATCHES block). Omit it and every watch on the symbol goes.')
})

const watchPrice = def(
  'watch_price',
  'Register a price watch that WAKES YOU UP early when it fires ("wake me if MU drops 2%"). The engine checks every ~15s while the market is open; on fire it posts to the thread, runs you immediately, and the watch is spent (one-shot — re-arm it if you still want it). Setting one for a symbol+condition you are already watching REPLACES it rather than stacking. A move_*_pct watch needs a live price to measure from: if that is refused, the refusal tells you the absolute level to use with "below"/"above" instead — use it, do not defer. Max 6 active watches. Arming or cancelling SEVERAL? Pass them all in `watches` in ONE call — never one call per watch.',
  z.object({
    symbol: z.string().optional().describe('Single form: the symbol'),
    condition: lenientEnum(['above', 'below', 'move_up_pct', 'move_down_pct'], z.enum(['above', 'below', 'move_up_pct', 'move_down_pct']).optional().describe('Single form: above/below an absolute price, or a % move from the CURRENT price')),
    value: lenientNumber(z.number().positive().optional().describe('Single form: price for above/below; percent (e.g. 2 = 2%) for move_*')),
    note: lenientString(120, z.string().max(120).optional().describe('Single form: what you intend to do when it fires')),
    cancel: lenientBoolean(z.boolean().default(false).describe('Single form: true = cancel a watch instead of setting one')),
    id: z.string().optional().describe('Single form, with cancel: the id of ONE watch to drop. Omit it and every watch on the symbol goes.'),
    watches: z.array(watchItem).min(1).max(6).optional().describe('Batch form: every watch to set or cancel, in one call')
  }),
  async (args, host) => {
    const items = args.watches ?? (args.symbol ? [{ symbol: args.symbol, condition: args.condition, value: args.value, note: args.note, cancel: args.cancel ?? false, id: args.id }] : [])
    if (!items.length) return 'Nothing to do — pass `symbol`+`condition`+`value` (one watch) or `watches` (several in one call).'
    const out: string[] = []
    for (const it of items) {
      // The singular schema had to loosen for the batch field to exist, so the
      // per-item requirements move here — with instructions, not a stack trace.
      if (!it.cancel && (!it.condition || it.value === undefined)) {
        out.push(`${it.symbol.toUpperCase()}: skipped — a watch needs \`condition\` and \`value\` (or \`cancel: true\` to drop one).`)
        continue
      }
      out.push(await host.watchPrice({ symbol: it.symbol.toUpperCase(), condition: it.condition ?? 'below', value: it.value ?? 0, note: it.note, cancel: it.cancel, id: it.id }))
    }
    return out.join('\n')
  }
)

/**
 * BATCHING. A respawned agent clearing four dead theses made four
 * tool calls — four gate/audit/state round-trips for one intention, and in a
 * parallel-call turn the thread rendered the results against the wrong calls.
 * State tools whose items are independent now take ONE-OR-MANY: the plural
 * field carries the batch, the original singular fields still work, and the
 * handler loops the existing host method so hosts never change.
 *
 * A batch is NOT atomic as a unit: each host call in the loop takes its own
 * slot on the run's exclusive lane, so the items can never interleave with
 * each other (the loop awaits), but another concurrent tool call CAN land
 * between two of them. That is fine precisely because only tools with
 * independent items are batched — do not add a batch whose items depend on
 * ordering against other tools without revisiting this.
 *
 * ⚠️ Top-level schemas must stay plain z.object (`vendors/claude.ts` reads
 * `.shape`), so "singular or plural, not neither" cannot be a z.refine — each
 * handler enforces it and answers with instructions rather than a validation
 * error.
 *
 * WRITE TOOLS ARE DELIBERATELY EXEMPT (`trade`, `cancel_order`, `set_exit`,
 * `retire`): the approval flow's whole contract is that one yes covers one
 * narrow action (`approvalCovers`: same tool, same symbol, size no larger). A
 * batched write would make one tap approve N risks, and `describeHeldAction`
 * could no longer state what is being approved in one line. `change_plan` is
 * already a batch by construction — every field of one edit in one call.
 */
const thesisItem = z.object({
  symbol: z.string(),
  thesis: lenientString(200, z.string().min(3).max(200).optional().describe('The thesis in one or two sentences. Omit to CLEAR this symbol\'s thesis.'))
})

const setThesis = def(
  'set_thesis',
  'Record (or clear) your standing THESIS per symbol — the why behind trading it. Re-injected every run next to that symbol\'s technicals. Update it when the story changes; clear it when it is invalidated. Touching SEVERAL symbols? Pass them all in `theses` in ONE call — never one call per symbol.',
  z.object({
    symbol: z.string().optional().describe('Single form: the symbol'),
    thesis: lenientString(200, z.string().min(3).max(200).optional().describe('Single form: the thesis. Omit to CLEAR the thesis for `symbol`.')),
    theses: z.array(thesisItem).min(1).max(12).optional().describe('Batch form: every thesis to set or clear, in one call')
  }),
  async (args, host) => {
    const items = args.theses ?? (args.symbol ? [{ symbol: args.symbol, thesis: args.thesis }] : [])
    if (!items.length) return 'Nothing to do — pass `symbol` (one thesis) or `theses` (several in one call).'
    const out: string[] = []
    for (const it of items) out.push(await host.setThesis(it.symbol.toUpperCase(), it.thesis))
    return out.join('\n')
  }
)

const setName = def(
  'set_name',
  'Give yourself a name. Only available on your FIRST run, and only if the operator did not name you — otherwise it is refused and their name stands. Pick something short and specific to what you actually do ("MU Overnight", "AMZN Dip Buyer"), not a generic label like "Trading Bot". It shows in a narrow sidebar row, so keep it under 32 characters.',
  z.object({ name: z.string().min(2).max(MAX_AGENT_NAME).describe('Your name, ≤32 chars. Specific to your task.') }),
  async (args, host) => host.setName(args.name)
)

const retire = def(
  'retire',
  'RETIRE yourself: use when your task is fully complete (goal met, one-shot mission done) or your retirement condition has been satisfied. The engine flattens remaining positions (per policy), stops your schedule, and moves you to the Retired section — stats and this thread are preserved, and the operator can respawn you. Say a short goodbye after calling this.',
  z.object({ reason: lenientString(200, z.string().min(3).max(200).describe('Why you are retiring, e.g. "Profit target of $100 reached (+$104.20)"')) }),
  async (args, host) => host.retire(args.reason)
)

const remember = def(
  'remember',
  'Save a short note (≤ 200 chars) shown to you on every future run. Use for durable FACTS you must carry across runs — entries, exit plans, lessons. A note you save stays forever, so do not use it for a one-time errand: if you are recording something you intend to DO later (because you cannot do it yet), pass `defer` instead and it will be handed back to you when it becomes possible, then cleared. Saving SEVERAL notes? Pass them all in `notes` in ONE call.',
  z.object({
    note: lenientString(200, z.string().min(1).max(200).optional().describe('Single form: the note')),
    // A single string in `notes` is one note, not a mistake: the model wrote
    // `notes: "…"` and lost the memory to a shape error.
    notes: z.preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(lenientString(200, z.string().min(1).max(200))).min(1).max(8).optional().describe('Batch form: several notes in one call (the same `defer` applies to all of them)')),
    defer: z
      .enum(['market_open', 'next_run'])
      .optional()
      .describe('Makes this a one-time errand instead of a permanent fact: "market_open" = do it when the market next opens, "next_run" = as soon as you run again. It is given back to you when its moment comes and cleared once you settle it.')
  }),
  async (args, host) => {
    const items = args.notes ?? (args.note ? [args.note] : [])
    if (!items.length) return 'Nothing to save — pass `note` (one) or `notes` (several in one call).'
    const out: string[] = []
    // Prefixed with the note, because the host's own result is a running count
    // and a batch of counts would not say which note a refusal was about.
    for (const n of items) out.push(items.length === 1 ? await host.remember(n, args.defer) : `"${n.length > 40 ? `${n.slice(0, 40)}…` : n}" → ${await host.remember(n, args.defer)}`)
    return out.join('\n')
  }
)

const errandDone = def(
  'errand_done',
  'Settle a pending errand — you did it, or it is no longer relevant. ALWAYS call this once you have acted on one; an errand you leave open is handed back to you every run and you will do it again. Settling SEVERAL? Pass them all in `settled` in ONE call.',
  z.object({
    id: z.string().min(1).optional().describe('Single form: the errand id shown in your PENDING ERRANDS block'),
    outcome: lenientString(160, z.string().min(1).max(160).optional().describe('Single form: one line — what you did, or why it no longer applies')),
    settled: z
      .array(z.object({ id: z.string().min(1).describe('The errand id'), outcome: lenientString(160, z.string().min(1).max(160).describe('One line: what you did, or why it no longer applies')) }))
      .min(1)
      .max(8)
      .optional()
      .describe('Batch form: settle several errands in one call')
  }),
  async (args, host) => {
    const items = args.settled ?? (args.id && args.outcome ? [{ id: args.id, outcome: args.outcome }] : [])
    if (!items.length) return 'Nothing to settle — pass `id`+`outcome` (one errand) or `settled` (several in one call).'
    const out: string[] = []
    for (const it of items) out.push(await host.errandDone(it.id, it.outcome))
    return out.join('\n')
  }
)

const sleepUntil = def(
  'sleep_until',
  `Put yourself to sleep until a DATED moment, when your task waits on an event you have looked up — an earnings date (mcp__robinhood__get_earnings_calendar), a scheduled announcement, a known release. Use it instead of waking every tick to re-check a calendar and conclude "not yet". Your schedule is untouched and resumes after you wake. If you must act BEFORE the event, wake shortly before it: for "enter the day before earnings" sleep until the day before at 09:35 ET, not until the report itself. While asleep you are still woken by the operator's messages, by your price watches and by an open question's deadline — a run they start leaves the sleep in place, so you answer and go back to sleep. Call again to move the wake time; \`cancel: true\` wakes you onto your normal schedule. Max ${MAX_SLEEP_DAYS} days.`,
  z.object({
    until: z.string().optional().describe('When to wake: ISO 8601 with a zone ("2026-10-29T09:35:00-04:00"), or ET wall-clock "YYYY-MM-DD HH:MM", or a bare "YYYY-MM-DD" (= 09:35 ET that day). Required unless cancelling.'),
    reason: lenientString(120, z.string().max(120).optional().describe('One line the operator will read: what you are waiting for, e.g. "AAPL reports after the close on Oct 30; entering the day before"')),
    cancel: lenientBoolean(z.boolean().default(false).describe('true = wake up now and run on your normal schedule again'))
  }),
  async (args, host) => {
    if (args.cancel) return host.sleepUntil({ cancel: true })
    if (!args.until?.trim()) return 'Nothing to do — pass `until` (when to wake) and `reason`, or `cancel: true`.'
    const until = parseSleepUntil(args.until)
    if (!until) return `Could not read "${args.until}" as a time. Use ISO 8601 with a zone (2026-10-29T09:35:00-04:00), ET wall-clock "YYYY-MM-DD HH:MM", or a bare "YYYY-MM-DD" for 09:35 ET that day.`
    return host.sleepUntil({ until, reason: args.reason?.trim() || 'waiting for a dated event', raw: args.until })
  }
)

const proposeAgent = def(
  'propose_agent',
  'Propose spinning a job off into its OWN new agent, when it does not belong with what you already do. Use propose_task instead when the work is the same kind as yours — the same names, the same thesis, the same watchlist — because one agent holding a related set is what you are for. Reach for this only when the new job would pull you in a genuinely different direction: a different market, a different style, a different time horizon, or work that would make your existing tasks compete for the same run. The operator must confirm; it is NOT created until they do, and their plan may refuse it (this tool tells you if so — relay that to them in your own words instead of asking).',
  z.object({
    name: z.string().min(1).max(40).describe('Short name for the new agent, e.g. "NVDA Earnings"'),
    task: lenientString(300, z.string().min(3).max(300).describe("The new agent's one standing instruction, in one or two sentences, keeping the operator's intent and numbers exactly")),
    why: lenientString(200, z.string().min(3).max(200).describe('One line: why this needs its own agent rather than being another of your tasks')),
    schedule: scheduleSchema.optional().describe('When the new agent should wake. Omit and the operator sets it after creating.')
  }),
  async (args, host) => host.proposeAgent({ name: args.name.trim(), task: args.task.trim(), why: args.why.trim(), schedule: args.schedule ? toSchedule(args.schedule) : undefined })
)

const proposeTask = def(
  'propose_task',
  'Ask the operator to ADD a standing task to this agent — a second job it will work on every run, alongside the ones it already has. Use this whenever the operator asks you to also do something new ("also buy MU when it drops 5%"). It posts a card they must confirm; it does NOT take effect until they do, so do not start doing the new thing yet, and do not ask twice for the same thing. To reword the goal you already have, use change_plan instead.',
  z.object({
    task: lenientString(300, z.string().min(3).max(300).describe("The new standing instruction in one or two sentences, keeping the operator's intent and numbers exactly")),
    why: lenientString(160, z.string().min(3).max(160).describe('One line: what the operator said that makes this a new standing job rather than a one-off'))
  }),
  async (args, host) => host.proposeTask(args.task.trim(), args.why.trim())
)

/**
 * The thread window is the last ~24 messages. Everything before that is on
 * disk and invisible — an operator's "never touch biotech" from three weeks
 * ago simply is not in the prompt, and nothing tells the agent it is missing.
 *
 * This makes that recoverable. Deliberately keyword-first: the description
 * teaches the retrieval strategy, because an agent that reads a long thread
 * linearly to answer one question spends its whole context doing it, which is
 * the problem restated rather than solved.
 */
const searchThread = def(
  'search_thread',
  'Search this thread\'s ENTIRE history — every message ever, not just the recent ones you can see. Use it when you suspect the operator said something earlier that matters ("did they ever tell me to avoid X?"), when you need an old decision or its reasoning, or when a position exists that you have no recent record of opening. Give the distinctive WORDS you expect, not a sentence: all of them must appear in a message for it to match, so "biotech" or "avoid biotech" finds more than "did the operator ever mention biotech". Results come back oldest-first with dates. Search first and read the few hits — never ask for a large number of messages and read them through.',
  z.object({
    query: z.string().min(2).max(120).describe('The distinctive words to look for. ALL of them must appear in a message.'),
    limit: lenientNumber(z.number().int().min(1).max(20).optional().describe('How many matches to return (default 6, max 20). Ask for few: each one costs you context.'))
  }),
  async (args, host) => host.searchThread(args.query, args.limit ?? 6)
)

const quotesTool = def(
  'quotes',
  'Current prices for up to 20 symbols (last, bid/ask, % vs previous close) from the feed pricing this run. Works whether or not Robinhood is connected. Use it to price a symbol that is not in your context before sizing a trade — never guess a price.',
  z.object({ symbols: z.array(z.string().min(1).max(10)).min(1).max(20).describe('Tickers, e.g. ["NVDA","AMD"]') }),
  async (args, host) => host.quotes(args.symbols)
)

const barsTool = def(
  'bars',
  'OHLCV candles for ONE symbol from the feed pricing this run: daily bars (up to a year) or 5-minute bars (up to 10 days). For the symbols in your context the TECHNICALS block already summarises these — reach for this only when you need the actual series (a level, a range, a prior session).',
  z.object({
    symbol: z.string().min(1).max(10),
    interval: lenientEnum(['day', '5minute'], z.enum(['day', '5minute']).default('day')),
    days: lenientNumber(z.number().int().min(1).max(365).optional().describe('Lookback in days (default 30 for daily, 2 for 5-minute)'))
  }),
  async (args, host) => host.bars(args.symbol, args.interval, args.days ?? (args.interval === 'day' ? 30 : 2))
)

const forget = def(
  'forget',
  'Remove memory notes containing this text. Removing SEVERAL unrelated notes? Pass every fragment in `matches` in ONE call.',
  z.object({
    match: z.string().min(1).optional().describe('Single form: remove notes containing this text'),
    matches: z.array(z.string().min(1)).min(1).max(8).optional().describe('Batch form: several fragments, each removing the notes that contain it, in one call')
  }),
  async (args, host) => {
    const items = args.matches ?? (args.match ? [args.match] : [])
    if (!items.length) return 'Nothing to forget — pass `match` (one fragment) or `matches` (several in one call).'
    const out: string[] = []
    // Prefixed with the fragment: the host's own result is only a count, and a
    // batch of counts would not say which fragment matched nothing.
    for (const m of items) out.push(items.length === 1 ? await host.forget(m) : `"${m}" → ${await host.forget(m)}`)
    return out.join('\n')
  }
)

const askOperator = def(
  'ask_operator',
  "Ask the operator ONE decision you cannot make yourself (outside your task's authority, irreversible/large, or genuinely ambiguous). Posts a question card and notifies them. You MUST say what you will do if they do not answer in time — if nobody answers by the deadline you are woken again to do exactly that. Finish this run after asking; do not act on the undecided thing now. Never ask on routine ticks.",
  z.object({
    question: z.string().min(3).describe('One clear question, ideally answerable with a short reply or one of the options'),
    options: z.array(z.string().min(1)).max(4).optional().describe('Up to 4 quick-reply choices'),
    stakes: lenientString(160, z.string().min(3).max(160).describe('One line: what is at stake / why this needs them (shown on the card and in the notification)')),
    fallback: lenientString(200, z.string().min(3).max(200).describe('What you WILL do if they do not answer in time, e.g. "hold and re-check at 3:55 PM" or "sell half"')),
    waitMinutes: lenientNumber(z.number().int().min(QUESTION_WAIT_MIN).max(QUESTION_WAIT_MAX).optional().describe(`How long to wait for an answer (default ${QUESTION_WAIT_DEFAULT_MIN}; ${QUESTION_WAIT_MIN}–${QUESTION_WAIT_MAX})`))
  }),
  async (args, host) => host.askOperator(args)
)

const tellOperator = def(
  'tell_operator',
  'Say something the operator would want to know NOW, not at the end of the run: a thesis invalidated, unusual tape, you are about to do something unusual. It notifies them. Not for routine summaries — your normal end-of-run reply covers those. At most once per run.',
  z.object({
    message: z.string().min(3).max(600),
    urgency: lenientEnum(['fyi', 'important'], z.enum(['fyi', 'important']).describe('important = interrupt them even if they muted conversation; fyi = respect their preference'))
  }),
  async (args, host) => host.tellOperator(args.message, args.urgency)
)

const report = def(
  'report',
  'File your END-OF-RUN summary as structured data — the operator reads it as a card, not a paragraph. Call this ONCE, as the LAST thing you do on a scheduled/watch/timeout/manual run, INSTEAD of writing a closing summary message. When the operator messaged you (a reply run), answer them in plain text instead — a conversation should not come back as a form; file a report there only if you also acted. headline = the one-line answer ("Holding all three — flatten starts ~3:50"). status: acted = you placed orders or changed plans; held = looked and decided to do nothing; blocked = wanted to act and could not (approval pending, broker down — say why in details); done = the task is finished. facts = short label/value chips (a symbol and its price, the book, the tape) — numbers you would otherwise bury in prose. next = what happens next and when.',
  z.object({
    // Every free-text field is CLIPPED to its bound, never refused for it: in
    // one day 45 reports were thrown away for a 110-character headline or a
    // 50-character fact, and each lost report cost the run its summary card
    // plus an extra model turn to write a closing message instead.
    headline: lenientString(100, z.string().min(3).max(100).describe('The one-line answer to "what happened this run?"')),
    status: lenientEnum(['acted', 'held', 'blocked', 'done'], z.enum(['acted', 'held', 'blocked', 'done'])),
    facts: z
      .array(
        z.object({
          label: lenientString(24, z.string().min(1).max(24).describe('"PLTR", "Book", "Tape"')),
          value: lenientString(48, z.string().min(1).max(48).describe('"$187.52", "−$707 (−2.8%)"')),
          delta: lenientString(32, z.string().max(32).optional().describe('Qualifier: "+0.8% vs entry"')),
          tone: lenientEnum(['up', 'down', 'flat'], z.enum(['up', 'down', 'flat']).optional().describe('Colors the value; omit for neutral'))
        })
      )
      .max(8)
      .optional()
      .describe('Up to 8 label/value chips — the numbers that matter this run'),
    next: lenientString(120, z.string().max(120).optional().describe('What YOU will do at your next wake-up and after ("Flatten ~3:50, retire at close. 7 orders left."). Your next wake-up itself is fixed by your schedule and shown in CLOCK — never state a different one here (an agent that skipped a buy wrote "Next run Monday" while its 3:45 PM run was still armed). Writing "sleep until Wednesday" here sleeps nothing — call `sleep_until` for that, then say so.')),
    details: lenientString(500, z.string().max(500).optional().describe('Anything that does not fit the fields above — kept short'))
  }),
  async (args, host) => host.report(args as AgentReport)
)

const earningsCandidatesTool = def(
  'earnings_candidates',
  "ALL-IN EARNINGS MODE. Every $1B+ company reporting after today's close or before tomorrow's open — the only reports this mode may buy into — with price, size, dollar volume, this quarter's EPS estimate and, for each, how the stock has actually reacted to its last reports (gap-up rate, typical move, beat rate, whether beats got paid). Computed by the engine from the broker's calendar, results and daily bars. Call it FIRST on a hunt.",
  z.object({}),
  async (_args, host) => host.earningsCandidates()
)

const earningsDossierTool = def(
  'earnings_dossier',
  "ALL-IN EARNINGS MODE. The full pre-report file on ONE name: profile and valuation, the coming report (date, timing, estimate, whether it is in this mode's window), the OPTIONS-IMPLIED MOVE against the moves it has really made, eight quarters of EPS surprise → next-open gap, revenue growth and margin trend, analyst targets, and how it is running into the print. Every number is computed by the engine. Use it on your 2–3 best candidates before deciding, then read their news and sentiment.",
  z.object({ symbol: z.string().min(1).max(10).describe('Ticker, e.g. NKE') }),
  async (args, host) => host.earningsDossier(args.symbol)
)

export const AGENT_TOOLS: AgentToolDef[] = [changePlan, trade, cancelOrder, setExit, watchPrice, quotesTool, barsTool, sleepUntil, setThesis, setName, retire, remember, errandDone, proposeTask, proposeAgent, forget, searchThread, askOperator, tellOperator, report] as AgentToolDef[]

/** Research tools only an all-in earnings agent is given — every other agent's tool list (and prompt) stays exactly as it was. */
export const EARNINGS_TOOLS: AgentToolDef[] = [earningsCandidatesTool, earningsDossierTool] as AgentToolDef[]

/** The tools THIS agent is offered: the common set, plus its playbook's own. */
export function toolsFor(cfg: Pick<AgentConfig, 'playbook'>): AgentToolDef[] {
  return cfg.playbook === 'earningsPop' ? [...AGENT_TOOLS, ...EARNINGS_TOOLS] : AGENT_TOOLS
}

export const TB_TOOL_NAMES: string[] = [...AGENT_TOOLS, ...EARNINGS_TOOLS].map((t) => tbToolName(t.name))

/**
 * A fingerprint of what a tool MEANS, for the approval pass.
 *
 * An approval is granted against a specific tool definition. If the definition
 * changes — a renamed argument, a new required field, a description that
 * redraws what the tool does — the operator approved something that no longer
 * exists, and replaying their yes against the new meaning is putting words in
 * their mouth. Our approvals are usually short-lived, but by design they have
 * NO deadline: a card can sit pending indefinitely, across an app update.
 *
 * Covers name, description and the JSON schema, because all three are what the
 * operator was shown or what bounds the call. Not the handler: an
 * implementation fix that leaves the contract identical should not invalidate
 * a pending card, and if it changed the contract it changed the schema.
 *
 * Truncated to 16 hex chars — this is a change detector, not a security
 * boundary. Nothing trusts it; a mismatch only means "ask again".
 */
export function toolDefinitionHash(name: string): string | undefined {
  const bare = name.replace(/^mcp__[a-z]+__/, '')
  const t = [...AGENT_TOOLS, ...EARNINGS_TOOLS].find((x) => x.name === bare)
  // A Robinhood write tool is discovered from the live MCP server, so we hold
  // no definition to hash. Undefined means "no opinion", never "unchanged" —
  // the caller must not treat an absent hash as a match.
  if (!t) return undefined
  const shape = JSON.stringify(z.toJSONSchema(t.schema, { target: 'draft-7', io: 'input' }))
  return createHash('sha256').update(`${t.name}\u0000${t.description}\u0000${shape}`).digest('hex').slice(0, 16)
}
