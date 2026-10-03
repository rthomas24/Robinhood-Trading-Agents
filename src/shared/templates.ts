import type { AgentColor, AgentIcon, Schedule } from './agents'
import { earningsPopSchedule, type Playbook } from './earningsPlaybook'

/**
 * Starter agents — a catalog, not a feature.
 *
 * The New-agent sheet used to offer three bare example sentences. A template
 * is the same sentence PLUS everything a first-time operator would otherwise
 * have to invent before pressing Create: a name, a look, the schedule the task
 * implies, whether it should act on its own or ask first, and an honest one-line
 * note on where the idea goes wrong. Picking one fills the sheet; nothing is
 * created until the operator presses Create, and every field stays editable,
 * so a template is a head start rather than a commitment.
 *
 * Every template is PAPER, inherits the sheet's allocation, and is ASK-FIRST:
 * a template that trades on its own the moment someone clicks it would be the
 * wrong first experience of the product, and the operator flips one switch to
 * change that once they have watched it propose a few. No template names a
 * dollar size either — sizing belongs to the allocation and the guardrails the
 * sheet derives from it, not to a sentence written for everyone. Tickers stay,
 * for now, as illustrations (`check-templates.ts` pins both rules).
 *
 * They cover the common shapes — overnight holds, dip buyers, a gap-and-go
 * "Closer", an hourly news reader, goal-by-Friday sprints, an approval-gated
 * earnings agent, a long-term book — and the ideas those suggest. The strip in the sheet shows the first row; the gallery shows all
 * of them with the whole task sentence, the schedule and the risk note.
 *
 * Pure and Node-free.
 */

export type TemplateStyle = 'intraday' | 'swing' | 'invest' | 'research'

export const TEMPLATE_STYLE_LABEL: Record<TemplateStyle, string> = {
  intraday: 'Intraday',
  swing: 'Overnight & swing',
  invest: 'Investing',
  research: 'Research first'
}

/** One line under each style's heading in the gallery. */
export const TEMPLATE_STYLE_HINT: Record<TemplateStyle, string> = {
  intraday: 'In and out the same day. Flat by the close, so no overnight gap can touch the book.',
  swing: 'Held overnight or for days, with engine-enforced exits doing the watching.',
  invest: 'Slow by design: accumulate, hold, rebalance. Most runs end with no order.',
  research: 'Reads first and proposes — every trade waits for you.'
}

export interface AgentTemplate {
  id: string
  name: string
  icon: AgentIcon
  color: AgentColor
  style: TemplateStyle
  /** One line under the name — what the operator gets. */
  tagline: string
  /** The task, in the plain language the agent is given. Times are Eastern. */
  task: string
  /** The schedule the task implies; the sheet switches to "Set manually" with it. */
  schedule: Schedule
  /** False = every buy, sell and exit change waits for the operator. */
  autonomous: boolean
  /** Where this idea goes wrong. Shown, not hidden — a template is a teaching moment. */
  risk: string
  /**
   * A special mode the ENGINE runs (`shared/earningsPlaybook.ts`): it owns the
   * schedule, the size of every order and the exits, so the sheet sends it with
   * the create request and the config builder lays the mode's fence over the
   * form's. Absent on every ordinary template.
   */
  playbook?: Playbook
}

const WEEKDAYS: Schedule = { kind: 'times', times: [], days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], tradingDaysOnly: true }
const at = (...times: string[]): Schedule => ({ ...WEEKDAYS, times } as Schedule)
const every = (everyMinutes: number): Schedule => ({ kind: 'interval', everyMinutes, marketHoursOnly: true })
const weekly = (day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri', time: string): Schedule => ({ kind: 'times', times: [time], days: [day], tradingDaysOnly: true })

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  // ── Intraday ─────────────────────────────────────────────────────────────
  {
    id: 'dip-buyer',
    name: 'NVDA Dip Buyer',
    icon: 'ripple',
    color: 'green',
    style: 'intraday',
    tagline: 'Buy a sharp intraday drop, take a small gain, flat by the close.',
    task: 'Every 15 minutes during market hours, check NVDA. If it drops more than 2% from the open, buy a single position sized inside my guardrails. Sell at +1.5% or at 3:55 PM ET, whichever comes first.',
    schedule: every(15),
    autonomous: false,
    risk: 'A 2% drop is often the start of a 5% drop. The 3:55 PM sell is the real stop — do not remove it.'
  },
  {
    id: 'opening-drive',
    name: 'SPY Day Ride',
    icon: 'arrow',
    color: 'blue',
    style: 'intraday',
    tagline: 'One index position a day, no overnight risk.',
    task: 'At 9:35 AM ET each trading day, buy one SPY position sized inside my guardrails. At 3:50 PM ET, sell it all. If the position is down more than 1% at any check-in, sell early.',
    schedule: at('09:35', '12:30', '15:50'),
    autonomous: false,
    risk: 'Buying every open ignores the tape entirely; expect many small losses on down days. Good for learning how the engine trades, not for edge.'
  },
  {
    id: 'gap-and-go',
    name: 'Opening Gap Rider',
    icon: 'arrow',
    color: 'orange',
    style: 'intraday',
    tagline: 'Ride the morning’s biggest gap-ups, out by 3:58 no matter what.',
    task: 'At 9:31 AM ET each trading day, scan large-cap names gapping up more than 2% on real news or earnings with strong pre-market volume. Buy the one or two with the cleanest momentum, sized inside my guardrails, with a trailing stop on each fill. At 3:58 PM ET sell everything, no matter what. Never hold overnight.',
    schedule: at('09:31', '11:00', '15:58'),
    autonomous: false,
    risk: 'Gaps fade as often as they run, and the first ten minutes carry the widest spreads of the day. The 3:58 PM flatten is the rule that keeps a bad morning from becoming a bad week.'
  },
  {
    id: 'headline-rider',
    name: 'Headline Rider',
    icon: 'face',
    color: 'pink',
    style: 'intraday',
    tagline: 'Hourly news check; buy what is already moving on a real headline; flat by the close.',
    task: 'Every hour during market hours, read the news. When a large-cap name has a clearly positive headline and is already moving on real volume, buy it sized inside my guardrails with a trailing stop. Take profits into strength and be flat by 3:50 PM ET every day — never hold a headline trade overnight.',
    schedule: at('09:35', '10:35', '11:35', '12:35', '13:35', '14:35', '15:20', '15:50'),
    autonomous: false,
    risk: 'By the time a headline is on a feed the first move is usually done, so this often buys the top of the spike. Size small and let the trail decide.'
  },
  {
    id: 'vwap-reclaim',
    name: 'VWAP Reclaim',
    icon: 'ripple',
    color: 'blue',
    style: 'intraday',
    tagline: 'Buy a mega cap the moment it reclaims VWAP after a morning dip.',
    task: 'Every 10 minutes during market hours, watch AAPL, MSFT, AMZN, GOOGL and META. When one that dipped in the morning reclaims its VWAP on rising volume after 10:15 AM ET, buy it sized inside my guardrails with a trailing stop at the floor the technicals show. Sell into a move back to the day’s high, or at 3:55 PM ET, whichever comes first.',
    schedule: every(10),
    autonomous: false,
    risk: 'Mega caps cross VWAP several times on a choppy day and each false reclaim costs a stop. Skip days when the index has no direction.'
  },
  {
    id: 'power-hour',
    name: 'Power Hour',
    icon: 'plasma',
    color: 'orange',
    style: 'intraday',
    tagline: 'Join the day’s leaders at 3:00, sell at 3:55.',
    task: 'At 3:00 PM ET each trading day, find the two large-cap names that are up on the day, above VWAP and making new highs into the afternoon on rising volume. Buy them sized inside my guardrails with a trailing stop. Sell everything at 3:55 PM ET.',
    schedule: at('15:00', '15:30', '15:55'),
    autonomous: false,
    risk: 'The last hour is where a trend either extends or unwinds, and a 3:00 PM entry gives the trade fifty-five minutes to work. Expect small wins and the occasional sharp reversal into the close.'
  },
  {
    id: 'one-day-sprint',
    name: 'One-Day Sprint',
    icon: 'skull',
    color: 'pink',
    style: 'intraday',
    tagline: 'Trade big tech hard for one session, flatten, retire at the close.',
    task: 'For one trading day only: trade the big tech names — NVDA, AAPL, MSFT, GOOGL, AMZN, META, AVGO, TSLA, AMD — intraday for as much profit as you can, buying confirmed strength sized inside my guardrails with a trailing stop on every fill. Flatten everything by 3:55 PM ET, then retire yourself at the close.',
    schedule: every(10),
    autonomous: false,
    risk: 'A one-day deadline is pressure to trade when there is nothing to trade. Most sprints end flat or slightly down after spreads; the good ones are the days the index trends.'
  },
  {
    id: 'momentum-week',
    name: 'Momentum Week',
    icon: 'plasma',
    color: 'pink',
    style: 'intraday',
    tagline: 'Big tech and high-beta names, traded hard all week, retired at Friday’s close.',
    task: 'Every 10 minutes during market hours, find the strongest momentum among large-cap tech and high-volatility names — NVDA, TSLA, AMD, META, AVGO, COIN, PLTR, MSTR — and press it: buy confirmed strength sized inside my guardrails, put a trailing stop on every position the moment it fills, cut losers fast and add only to winners. Flatten everything by 3:55 PM ET each day unless a position is up on the day with its stop above cost. This is a one-week sprint: make as much profit as you can, then retire yourself at this Friday’s close.',
    schedule: every(10),
    autonomous: false,
    risk: 'The most expensive idea here. High-beta names move 5% in an hour, ten-minute checks mean stops fill on gaps, and a week is long enough to give back three good days in one bad one. Keep the daily loss limit on and expect it to trip.'
  },

  // ── Overnight & swing ────────────────────────────────────────────────────
  {
    id: 'earnings-all-in',
    name: 'Earnings All-In',
    icon: 'diamond',
    color: 'orange',
    style: 'swing',
    tagline: 'Special mode: the whole book on one earnings pop, sold at the next open.',
    task: "Every trading day, find the one company reporting earnings after today's close or before tomorrow's open that is most likely to gap up on its report. Research it properly before the open at 8:45 AM ET — how it has traded on its past reports, what the options market expects, its revenue and margin trend, analyst targets, the news and the sentiment — re-check the shortlist at 12:30 PM ET against the tape and fresh news, and at 3:40 PM ET buy the best one with the whole book. The engine sells everything at 9:31 AM ET the next morning, gap up or down, then waits for the proceeds to settle before researching again. Pass on any day nothing is convincing, and keep a log of every call and how it resolved.",
    schedule: earningsPopSchedule(),
    autonomous: false,
    playbook: 'earningsPop',
    risk: 'Every trade is the whole book on one overnight gap. A company can beat and still fall, no stop can act while the market is closed, and one bad report can take a fifth of the book or more. The options market already prices the expected move, so a real edge is rare — passing is often the right call.'
  },
  {
    id: 'overnight-hold',
    name: 'MU Overnight',
    icon: 'orb',
    color: 'violet',
    style: 'swing',
    tagline: 'Buy into the close, sell at the open.',
    task: 'Buy MU at 3:58 PM ET every trading day, sized inside my guardrails, then sell the whole position at 9:31 AM ET the next morning.',
    schedule: at('15:58', '09:31'),
    autonomous: false,
    risk: 'Carries a full position through every earnings night and gap; the overnight edge in one name can vanish for months.'
  },
  {
    id: 'earnings-swing',
    name: 'Earnings Swing',
    icon: 'diamond',
    color: 'pink',
    style: 'swing',
    tagline: 'Find who reports today, buy the ones set to pop, ride the print.',
    task: "At 9:35 AM ET each trading day, find every notable company reporting earnings after today's close or before tomorrow's open, and research each one: expected move, recent estimate revisions, how it has traded into and out of past reports, and the tape today. Pick the ones you believe will go UP on their report. At 3:45 PM ET, buy those names sized inside my guardrails, one position each, to hold through the report. At 9:35 AM ET the next morning, sell whatever you hold from the report — take the gap up, cut the gap down — and start again. Keep a memory note of every call and how it resolved.",
    schedule: at('09:35', '15:45'),
    autonomous: false,
    risk: 'The most all-or-nothing idea here. A report gaps the stock while the market is closed, so no stop can protect the position: a wrong call costs the whole gap, and options markets already price the expected move. Expect a coin-flip hit rate and size for it.'
  },
  {
    id: 'earnings-ask-first',
    name: 'Earnings, Ask First',
    icon: 'diamond',
    color: 'violet',
    style: 'swing',
    tagline: 'One earnings play per print, proposed as a card; nothing moves until you approve it.',
    task: 'Each trading day, find one well-known company reporting earnings after today’s close or before tomorrow’s open. At 3:40 PM ET propose ONE plan — buy at market sized inside my guardrails, a 5% stop and a 6% target, both engine-enforced — and wait for my approval; never trade without it. Sell the morning after the print at 9:40 AM ET whether it gapped up or down.',
    schedule: at('09:40', '15:40'),
    autonomous: false,
    risk: 'A stop cannot protect a position through the gap the report itself makes; the 5% stop only works during the session. One name per print keeps a wrong call the size of one gap.'
  },
  {
    id: 'momentum-rotation',
    name: 'Sector Rotation',
    icon: 'vortex',
    color: 'orange',
    style: 'swing',
    tagline: 'Hold the two strongest sector funds, re-sorted every Friday.',
    task: 'Every Friday at 3:30 PM ET, compare XLK, XLE, XLF, XLV, XLI and XLY on 20-day performance. Hold the two strongest at roughly equal weight and sell the rest. Trade only what is needed to get there.',
    schedule: weekly('Fri', '15:30'),
    autonomous: false,
    risk: 'Momentum rotation whipsaws in choppy markets and the weekly rebalance pays a spread each time; six funds keep the turnover bounded.'
  },
  {
    id: 'trend-pullback',
    name: 'Trend Pullback',
    icon: 'sea',
    color: 'teal',
    style: 'swing',
    tagline: 'Buy an uptrend on its pullback to the 20-day, hold with a wide trail.',
    task: 'At 3:30 PM ET each trading day, look through large caps in clear uptrends — above their 50-day average, making higher highs — for one that has pulled back to its 20-day average on light volume. Buy it sized inside my guardrails with a 6% trailing stop and hold for days to weeks, adding nothing. Sell when the trail fires or the trend breaks.',
    schedule: at('15:30'),
    autonomous: false,
    risk: 'A pullback and the start of a downtrend look identical on the day you buy. The trail is what tells them apart, so never move it down.'
  },
  {
    id: 'breakout-hunter',
    name: 'Breakout Hunter',
    icon: 'pyramid',
    color: 'orange',
    style: 'swing',
    tagline: 'Buy 20-day breakouts on volume, stop just under the level.',
    task: 'At 3:40 PM ET each trading day, find large caps closing above their 20-day high on at least 1.5× average volume. Buy the strongest one sized inside my guardrails with a stop just below the breakout level, and add a trailing stop once it is up 3%. Hold as long as the trail allows.',
    schedule: at('15:40'),
    autonomous: false,
    risk: 'Half of breakouts fail within three days. The stop under the breakout level is the whole edge — a breakout you hold below it is a loss you are hoping about.'
  },
  {
    id: 'moonshot-week',
    name: 'Moonshot Week',
    icon: 'vortex',
    color: 'pink',
    style: 'swing',
    tagline: 'Aim for +10% by Friday with engine exits on every position.',
    task: 'Aim for a 10% gain on this book by Friday’s close. Be aggressive: find the highest-momentum names, size up inside my guardrails, and carry winners only with engine-enforced trailing stops. Pre-arm dip entries rather than chasing, never buy a name you were stopped out of the same day, and flatten anything without a stop by 3:50 PM ET. Retire yourself at Friday’s close either way.',
    schedule: every(10),
    autonomous: false,
    risk: 'A target with a deadline is the most reliable way to over-trade. Every version of this idea we have run gave its good days back on one bad one; keep the daily loss limit on.'
  },
  {
    id: 'momentum-compounder',
    name: 'Momentum Compounder',
    icon: 'helix',
    color: 'green',
    style: 'swing',
    tagline: 'No end date: ride the strongest names with wide trails and compound.',
    task: 'No end date. Deploy into the highest-momentum large caps — breakouts, earnings gaps that hold, strong uptrends — one or two positions at a time sized inside my guardrails, each with a trailing stop wide enough for the name’s daily range. Ride winners, cut losers at the stop, and compound; never average down.',
    schedule: at('09:45', '12:30', '15:40'),
    autonomous: false,
    risk: 'Momentum works until it stops all at once. The wide trail keeps you in the trend and costs a big give-back at the turn; that is the price of the strategy, not a bug.'
  },

  // ── Investing ────────────────────────────────────────────────────────────
  {
    id: 'weekly-dca',
    name: 'VOO Weekly',
    icon: 'cube',
    color: 'teal',
    style: 'invest',
    tagline: 'Dollar-cost average into an index fund, every Monday.',
    task: 'Every Monday at 10:00 AM ET, buy a fixed slice of VOO — the same amount each week, sized inside my guardrails. Never sell. Keep a memory note of the running average cost and post it after each buy.',
    schedule: weekly('Mon', '10:00'),
    autonomous: false,
    risk: 'Boring by design. The failure mode is the operator, not the agent: stopping the schedule after a bad month.'
  },
  {
    id: 'steady-book',
    name: 'Steady Book',
    icon: 'sphere',
    color: 'slate',
    style: 'invest',
    tagline: 'A diversified book, held for the long run, touched only when a setup warrants it.',
    task: 'Long-term, never retire. Pick a diversified watchlist of eight to twelve quality names and broad ETFs, build positions gradually sized inside my guardrails, and hold. Check prices at each run and buy or sell only when the setup clearly warrants it; moderate risk — not aggressive, not conservative. Work the existing book; never flatten for inactivity.',
    schedule: at('09:45', '12:30', '15:40'),
    autonomous: false,
    risk: 'The danger is doing something because a run happened. Most runs should end with no order; if they do not, the agent is trading, not investing.'
  },
  {
    id: 'dividend-ladder',
    name: 'Dividend Ladder',
    icon: 'cube',
    color: 'green',
    style: 'invest',
    tagline: 'Rotate weekly buys across three dividend ETFs, never sell.',
    task: 'Every Monday at 10:05 AM ET, buy a fixed slice of one of SCHD, VYM and DVY in turn, sized inside my guardrails, and never sell. Keep a memory note of the running yield on cost and which name is next in the rotation.',
    schedule: weekly('Mon', '10:05'),
    autonomous: false,
    risk: 'Dividend ETFs lag growth-led markets for years at a time. This is an income plan, and it only works if it keeps buying when the price is down.'
  },
  {
    id: 'sixty-forty',
    name: '60/40 Rebalancer',
    icon: 'matrix',
    color: 'slate',
    style: 'invest',
    tagline: 'VTI and BND at 60/40, rebalanced only when they drift.',
    task: 'Hold VTI and BND at 60/40. Every Friday at 3:30 PM ET, check the weights; if either has drifted more than five points from target, trade only what is needed to rebalance, sized inside my guardrails. Otherwise do nothing and say so.',
    schedule: weekly('Fri', '15:30'),
    autonomous: false,
    risk: 'Rebalancing sells what has been working; in a long equity run this looks wrong every week and is right over years. The five-point band keeps turnover low.'
  },
  {
    id: 'dip-ladder',
    name: 'Dip Ladder',
    icon: 'donut',
    color: 'blue',
    style: 'invest',
    tagline: 'Start a QQQ position and add a slice on every further 2% drop.',
    task: 'Buy a starter position in QQQ, then every time it trades more than 2% below my average cost, buy another slice of the same size, sized inside my guardrails, up to my position cap. Check every 15 minutes during market hours and keep going until I tell you to stop; never sell.',
    schedule: every(15),
    autonomous: false,
    risk: 'Averaging down has no stop by design; a long decline fills the whole position cap near the lows. Only for an index you would hold through a bear market, never for a single stock.'
  },

  // ── Research first ───────────────────────────────────────────────────────
  {
    id: 'morning-brief',
    name: 'Morning Brief',
    icon: 'face',
    color: 'slate',
    style: 'research',
    tagline: 'A five-line briefing on your watchlist before the open. Asks before trading.',
    task: 'Each trading day at 9:00 AM ET, research overnight news, pre-market moves and any filings for AMD, AVGO and TSM, then message me a five-line brief. Only propose a trade if something material changed, and ask me before acting.',
    schedule: at('09:00'),
    autonomous: false,
    risk: 'Research costs model time every morning whether or not anything happened; keep the watchlist short.'
  },
  {
    id: 'earnings-scout',
    name: 'Earnings Scout',
    icon: 'orb',
    color: 'violet',
    style: 'research',
    tagline: 'Monday morning: this week’s reports on your watchlist, with a plan for each.',
    task: 'Every Monday at 8:30 AM ET, list this week’s notable earnings reports, and for each name on my watchlist — NVDA, AMD, AVGO, TSM, MSFT — that reports, research the expected move, recent estimate revisions and how it traded into past prints. Message me a plan for the week and propose trades; ask before acting on any.',
    schedule: weekly('Mon', '08:30'),
    autonomous: false,
    risk: 'Pre-earnings research is only as good as the calendar it reads; verify report dates against the company’s own announcement before proposing anything.'
  },
  {
    id: 'filings-watch',
    name: 'Filings Watch',
    icon: 'moire',
    color: 'slate',
    style: 'research',
    tagline: 'New SEC filings and insider trades on your names, summarised before the open.',
    task: 'Each trading day at 8:45 AM ET, check for new SEC filings on AAPL, MSFT, NVDA, TSLA and AMZN — 8-Ks, insider buys and sells, and anything unusual — and message me a short note on what changed. Propose a trade only when a filing is genuinely material, and ask before acting.',
    schedule: at('08:45'),
    autonomous: false,
    risk: 'Most filings are routine and a model can over-read them. A good week from this agent is five quiet notes and no trades.'
  },
  {
    id: 'macro-watch',
    name: 'Macro Watch',
    icon: 'heart',
    color: 'orange',
    style: 'research',
    tagline: 'CPI, jobs, FOMC: what is due, what is expected, and how the market took it.',
    task: 'Each trading day at 8:15 AM ET, check the economic calendar. On days with a major release — CPI, jobs, FOMC, GDP — message me what is due, when, what the market expects, and what it would mean for SPY and QQQ. After the release, at 9:35 AM ET, message the actual number and the reaction. Propose a trade only if the reaction is clear, and ask first.',
    schedule: at('08:15', '09:35'),
    autonomous: false,
    risk: 'Macro days move fast and the first reaction often reverses within the hour. This agent is a briefing, not a signal; trade it rarely.'
  }
]

export const templateById = (id: string): AgentTemplate | undefined => AGENT_TEMPLATES.find((t) => t.id === id)

/** Templates grouped by style, in catalog order, for a picker. */
export function templatesByStyle(): { style: TemplateStyle; label: string; hint: string; templates: AgentTemplate[] }[] {
  const styles = [...new Set(AGENT_TEMPLATES.map((t) => t.style))]
  return styles.map((style) => ({ style, label: TEMPLATE_STYLE_LABEL[style], hint: TEMPLATE_STYLE_HINT[style], templates: AGENT_TEMPLATES.filter((t) => t.style === style) }))
}

/** Case-insensitive match over the words an operator would search by: name, tagline, task and risk. */
export function templateMatches(t: AgentTemplate, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [t.name, t.tagline, t.task, t.risk, TEMPLATE_STYLE_LABEL[t.style]].some((s) => s.toLowerCase().includes(q))
}
