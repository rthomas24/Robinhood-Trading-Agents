/**
 * Held actions: what happens when an agent is NOT fully autonomous.
 *
 * The rule is one sentence — an agent that is not autonomous may think, read and
 * plan freely, but it may not move money without the operator saying so. The
 * interesting part is not the block, it is the wait. An answer can come back in
 * ten seconds or ten hours, and a "yes" to a decision made against a $35 quote is
 * not a "yes" to the same trade at $30. So approval never executes anything: it
 * un-stalls the agent and hands it back its own reasoning, the elapsed time and
 * the price as it is now, and the agent decides again.
 *
 * What an approval grants is therefore narrow and explicit: permission to do THIS
 * thing, once, no larger than asked. Anything else is a new request.
 *
 * Pure and Node-free: the engine and the UI say the same things about a held
 * action.
 */
import { describeExitPlan, type PendingAction } from './agents'

/** Sizing an operator approved. Comparable only against the same shape. */
const sizeOf = (a: Record<string, unknown>): { by: 'qty' | 'notional' | 'none'; n: number } => {
  if (typeof a.qty === 'number' && a.qty > 0) return { by: 'qty', n: a.qty }
  if (typeof a.notional === 'number' && a.notional > 0) return { by: 'notional', n: a.notional }
  return { by: 'none', n: 0 }
}

const sym = (a: Record<string, unknown>): string | undefined => (typeof a.symbol === 'string' ? a.symbol.toUpperCase() : undefined)

/**
 * The one variant an approval covers beyond doing LESS: a tighter stop.
 *
 * Absent → present, or present → higher on a long, is unambiguously less
 * downside on the same decision. Removing a stop or lowering it never is. This
 * is the only relaxation, and it exists because the review note explicitly asks
 * the agent to re-decide with fresh prices — so the agent that comes back
 * wanting the same trade with MORE protection was doing what we told it, and
 * being sent to a second card for that was absurd.
 *
 * Deliberately NOT covered, though each looks tempting: a lower limit price (a
 * different order that may never fill, and "approved but never happened" is a
 * worse surprise than a second card); a loosened or removed takeProfit (it does
 * not change the downside, but the exit was part of what the operator SAW, and
 * changing it silently makes the card a lie after the fact); and market↔limit
 * either way (different fill risk in both directions, monotone in neither).
 *
 * The test: could the operator, seeing this variant, have been worse off than
 * what they approved? Any answer but a flat no is a new card.
 */
const stopIsSaferOrSame = (p: PendingAction, args: Record<string, unknown>): boolean => {
  const a = typeof p.args.stopLoss === 'number' ? p.args.stopLoss : undefined
  const b = typeof args.stopLoss === 'number' ? args.stopLoss : undefined
  if (a === b) return true
  if (b === undefined) return false
  // A stop is only "safer" if it is a FLOOR — strictly below the price. One at
  // or above the market is not protection at all: the engine arms it, the next
  // sweep sees the price already through it, and it market-sells the WHOLE
  // position as a protective exit — exempt from the daily order cap, exempt
  // from the day-trade cap, and never held for approval because the engine
  // initiated it. So "add a stop" would have been a way to turn a one-share
  // approval into an unapproved liquidation of everything held in that symbol.
  //
  // `quote` is the price the operator saw on the card. It is the only reference
  // available to a pure function, and it is deliberately not the last word —
  // the engine re-checks against the LIVE price before arming anything.
  if (p.quote === undefined || !(p.quote > 0) || !(b < p.quote)) return false
  if (a === undefined) return true
  return b > a
}

/** Everything except the size, the prose and the stop — the three things allowed to differ. */
const shapeOf = (a: Record<string, unknown>): string => {
  const rest: Record<string, unknown> = {}
  for (const k of Object.keys(a).sort()) {
    if (k === 'qty' || k === 'notional' || k === 'reason' || k === 'stopLoss') continue
    rest[k] = k === 'symbol' && typeof a[k] === 'string' ? (a[k] as string).toUpperCase() : a[k]
  }
  return JSON.stringify(rest)
}

/**
 * Does an approved request cover the call the agent is now making?
 *
 * Deliberately strict. The operator approved a specific thing, so the agent may
 * do that thing or less of it — a smaller size after a re-think is still inside
 * what was agreed. A different symbol, a different side, a bigger position or a
 * second order is a new decision and gets its own card, which is what stops one
 * "yes" from becoming a licence for the rest of the run.
 */
export function approvalCovers(p: PendingAction, tool: string, args: Record<string, unknown>): { ok: true } | { ok: false; why: string } {
  if (!p.approvedAt) return { ok: false, why: 'that request has not been approved yet' }
  if (p.tool !== tool) return { ok: false, why: `the operator approved ${p.tool}, not ${tool}` }

  const was = sizeOf(p.args)
  const now = sizeOf(args)
  if (shapeOf(p.args) !== shapeOf(args)) {
    const a = sym(p.args)
    const b = sym(args)
    return { ok: false, why: a && b && a !== b ? `the operator approved ${a}, not ${b}` : 'the details differ from what the operator approved' }
  }
  if (was.by !== now.by) return { ok: false, why: `the operator approved it sized by ${was.by === 'none' ? 'no explicit amount' : was.by}` }
  if (now.n > was.n) return { ok: false, why: `the operator approved ${was.n} ${was.by === 'qty' ? 'shares' : 'dollars'}, and this is larger` }
  if (!stopIsSaferOrSame(p, args)) return { ok: false, why: 'the stop differs from what the operator approved — it may only be added or tightened, must sit below the price, and anything else is a fresh request' }
  return { ok: true }
}

/** "trade" → "Buy 12 MU at market" — one line, the same on every surface. */
export function describeHeldAction(tool: string, args: Record<string, unknown>): string {
  const s = sym(args) ?? ''
  const size = sizeOf(args)
  const amount = size.by === 'qty' ? `${size.n} ${size.n === 1 ? 'share' : 'shares'}` : size.by === 'notional' ? `$${size.n}` : ''
  const bare = tool.replace(/^mcp__[a-z]+__/, '')
  if (bare === 'trade') {
    const side = String(args.side ?? '').toLowerCase()
    const kind = args.type === 'limit' && typeof args.limitPrice === 'number' ? `limit $${args.limitPrice}` : 'market'
    // The protection is PART of the decision being approved. "Buy 12 MU at
    // market" and "Buy 12 MU at market, stop $345" are different risks, and the
    // operator was only ever shown the first — on the one screen where their
    // judgement IS the safety mechanism. An unprotected buy says so out loud,
    // because the absence is the thing worth noticing.
    const guards = describeExitPlan({ stop: args.stopLoss as number | undefined, target: args.takeProfit as number | undefined, trailPct: args.trailPct as number | undefined })
    const tail = guards ? `, ${guards}` : side === 'sell' ? '' : ', no stop'
    return `${side === 'sell' ? 'Sell' : 'Buy'} ${amount} ${s} at ${kind}${tail}`.replace(/\s+/g, ' ').trim()
  }
  if (bare === 'set_exit') {
    const bits = describeExitPlan({ stop: args.stop as number | undefined, target: args.target as number | undefined, trailPct: args.trailPct as number | undefined })
    return args.clear ? `Clear the exit plan on ${s}` : `Set ${bits || 'an exit plan'} on ${s}`
  }
  if (bare === 'cancel_order') return `Cancel order ${String(args.orderId ?? '')}`
  if (bare === 'retire') return 'Retire — stop running for good'
  return `${bare.replace(/_/g, ' ')}${s ? ` ${s}` : ''}${amount ? ` (${amount})` : ''}`.trim()
}

/**
 * What the held order is actually worth, and what that figure rests on.
 *
 * Not simply `qty × quote`: a limit order should be valued at its own limit, a
 * notional-sized order already carries the number, and an order with neither a
 * live quote nor a limit cannot be valued at all — saying nothing is better than
 * showing a number that is quietly wrong. Lives here rather than in the
 * renderer so every surface that shows the card says the same thing about what
 * the operator is approving.
 *
 * `basis` is for the surface to label with: 'stated' and 'limit' are exact,
 * 'quote' is an estimate against the price the agent saw when it asked.
 */
export function heldNotional(p: PendingAction): { amount: number; basis: 'limit' | 'quote' | 'stated' } | null {
  const a = p.args
  const size = sizeOf(a)
  if (size.by === 'notional') return { amount: size.n, basis: 'stated' }
  if (size.by !== 'qty') return null
  if (a.type === 'limit' && typeof a.limitPrice === 'number' && a.limitPrice > 0) return { amount: size.n * a.limitPrice, basis: 'limit' }
  if (typeof p.quote === 'number' && p.quote > 0) return { amount: size.n * p.quote, basis: 'quote' }
  return null
}

/** "4 hours" / "12 minutes" / "just now" — how long a decision has been sitting. */
export function heldForLabel(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`
  return `${Math.floor(h / 24)} days`
}

/**
 * What the agent is told when its held action comes back approved. This is the
 * whole point of making the delay visible: the numbers are laid next to each
 * other and the agent is asked to decide, not to execute.
 */
export function approvalReviewNote(p: PendingAction, nowPrice: number | undefined, now: Date): string {
  const held = heldForLabel(now.getTime() - new Date(p.requestedAt).getTime())
  const lines = ['The operator approved this, and you may now do it — once, and no larger than you asked:', `  ${p.summary}`, `  Your reason: ${p.reason}`, `  You asked ${held === 'just now' ? 'a moment ago' : `${held} ago`}.`]
  if (p.quote !== undefined && nowPrice !== undefined) {
    const pct = p.quote === 0 ? 0 : ((nowPrice - p.quote) / p.quote) * 100
    lines.push(`  ${p.symbol ?? 'It'} was $${p.quote.toFixed(2)} when you asked and is $${nowPrice.toFixed(2)} now (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%).`)
  } else if (p.quote !== undefined) {
    lines.push(`  ${p.symbol ?? 'It'} was $${p.quote.toFixed(2)} when you asked; you have no live quote now.`)
  }
  lines.push(
    'Approval is permission, not an instruction. Check the reasoning against the market as it is NOW: if it still holds, call the tool and it will go through. If the move already happened, the edge is gone, or the setup broke, do NOT do it — say plainly what changed and what you would do instead. A smaller size is fine; a different symbol, side, or a larger size needs a fresh request.'
  )
  return lines.join('\n')
}

/** What the agent is told when it tries to move money and cannot. */
export const heldMessage = (summary: string): string =>
  `HELD FOR APPROVAL — nothing happened. This agent is not autonomous, so "${summary}" was posted to the thread for the operator to approve or decline, and no order was placed.\n\nStop here. Do not call this or any other action tool again this run, and do not look for a way around it. Finish with one short message telling the operator what you want to do and why, so they can answer the card. You will be woken when they answer, and you will get to decide again with fresh prices.`

/** Why a second request is refused while one is already waiting. */
export const alreadyHeldMessage = (summary: string): string =>
  `You already have an action waiting on the operator: "${summary}". Only one at a time. Say what you would do and end your turn — you will be woken when they answer.`

/** Why a call was refused despite an approval: it was not the thing approved. */
export const outsideApprovalMessage = (why: string): string =>
  `NOT DONE — ${why}. The approval covers only what the operator saw on the card. Ask again with a fresh request if you want to do something different.`

/**
 * How long an operator's yes stays good for.
 *
 * An approved pass used to live only inside the run it was reviewed in: cleared
 * from state at run start, held in a local variable, gone at run end whether or
 * not anything executed. Approve a sell after the close and the review run
 * could not trade, so the yes evaporated — the agent re-proposed the SAME sell
 * the next morning, the operator approved a second time, and a position that
 * was supposed to close on Wednesday was still open the following Monday.
 *
 * Now the pass persists in `state.pendingAction` until it is SPENT by a
 * successful execution, SUPERSEDED by the agent asking for something different,
 * WITHDRAWN by an operator reply, or EXPIRED here. 72 hours covers approve-on-
 * Friday-evening → execute-at-Monday-open; the staleness risk is bounded
 * because the pass only skips re-asking the human — the agent still re-decides
 * against fresh prices every run, and the size/side/symbol scope of
 * `approvalCovers` still applies.
 */
export const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000

/** True when an approved pass has outlived its welcome and must not grant. */
export function approvalExpired(p: PendingAction, now: Date): boolean {
  return Boolean(p.approvedAt) && now.getTime() - Date.parse(p.approvedAt!) > APPROVAL_TTL_MS
}

/** Card outcome + thread note when an approved pass expires unexecuted. */
export const approvalExpiredOutcome = (): string => 'Expired — approved but never executed within 3 days.'
export const approvalExpiredNote = (summary: string): string =>
  `The approved action "${summary}" was never executed and has expired after 3 days. If it is still wanted, ask the agent and a fresh card will be posted.`

/**
 * Card outcome + thread note when the agent is made FULLY AUTONOMOUS while a
 * card is still open or approved. The hold exists to route a decision through
 * the operator; with autonomy on, the agent decides for itself, and a pass it
 * no longer needs would otherwise be re-presented every run until it expired
 * — an agent could decline the same stale approval dozens of times a day.
 */
export const approvalMootOutcome = (): string => 'Set aside — this agent is fully autonomous now and decides on its own.'
export const approvalMootNote = (summary: string): string => `"${summary}" is no longer waiting on you: this agent is fully autonomous now and decides for itself against the current tape.`

/**
 * Card outcome + thread note when the agent LOOKED AGAIN during the regular
 * session, could have acted, and chose not to. The review run asked it to
 * re-decide against the price now; a pass it declined with the market open is
 * spent, not parked — parking it made the same declined idea come back every
 * run. A review that ran with the market closed keeps the pass for the open.
 */
export const approvalPassedOutcome = (): string => 'Passed — the agent looked again with the market open and decided against it.'
export const approvalPassedNote = (summary: string): string => `The agent looked at "${summary}" again with the market open and passed on it. If you still want it, ask and a fresh card will be posted.`

/** Card outcome + thread note when the agent moves on to a different action. */
export const approvalSupersededOutcome = (): string => 'Set aside — the agent asked for something different, which got its own card.'
export const approvalSupersededNote = (summary: string): string =>
  `The approved action "${summary}" was set aside: the agent asked for something different, and that request has its own card.`
