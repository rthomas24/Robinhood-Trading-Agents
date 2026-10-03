import { isOpenApproval, isOpenQuestion, questionExpired, type Message } from './agents'

/**
 * Everything an agent is waiting on the operator for.
 *
 * Three different cards ask a question and then stop: a proposed PLAN, a held
 * ACTION, and a direct QUESTION. Each already renders well inside its thread —
 * and that was the whole problem. An agent that has stalled waiting for an
 * answer looks, from the sidebar, exactly like one that is quietly working, so
 * the ask is only visible if you happen to have that thread open and scrolled
 * to the right place. A held action in particular stops the agent completely:
 * every autonomous wake-up is a no-op until someone answers, with no deadline
 * and nothing that expires.
 *
 * So the asks need to be visible from wherever you are, and they need to be the
 * same list on every surface — which is why the rule lives here rather than in
 * the renderer.
 *
 * DERIVED from the messages, never stored. An "is waiting" flag would be one
 * more thing to clear correctly on every answer path (apply, dismiss, approve,
 * decline, timeout, supersede), and the day it is missed the badge outlives the
 * card that justified it.
 */

export type AskKind = 'approval' | 'question' | 'plan'

export interface Ask {
  agentId: string
  messageId: string
  kind: AskKind
  /** One line, already phrased for a list. */
  summary: string
  /** When the agent asked — the list sorts oldest-first, because the oldest is the most stalled. */
  ts: string
  /** Answer-by instant, for questions that carry one. */
  deadline?: string
  /** What happens on its own if nobody answers. Only questions have one; a plan and a held action wait forever. */
  fallback?: string
}

/** Does this message still want an answer? */
export function isAsk(m: Message): boolean {
  if (isOpenApproval(m)) return true
  if (isOpenQuestion(m)) return true
  // A spawn/task proposal and a plain plan are the same card to the operator:
  // something to apply or dismiss.
  return m.role === 'plan' && m.status === 'pending'
}

/**
 * Is this card waiting on the OPERATOR, right now?
 *
 * Distinct from `isAsk`, which asks whether the card is UNRESOLVED. An expired
 * question is unresolved — nothing has answered it yet — but it is waiting on
 * the engine, which owes it a 'timeout' run that takes the stated fallback.
 * Nobody should be asked to answer a decision that has already been made for
 * them.
 *
 * Every surface that says "waiting on you" must use THIS one: the sidebar
 * section and the thread's pinned cards. Two predicates for one idea drift:
 * the moment only one of them learns about deadlines, the sidebar lets a
 * question go while the thread keeps it pinned to the bottom.
 *
 * The operator can still beat the fallback by replying before the timeout run
 * lands (`runOnce` gives the human the win right up to the moment it executes).
 * That is a race they can win, not a request we should keep making.
 */
export function isOperatorAsk(m: Message, now: Date = new Date()): boolean {
  if (!isAsk(m)) return false
  if (isOpenQuestion(m) && questionExpired(m, now)) return false
  return true
}

/**
 * The open asks in one agent's thread, oldest first.
 *
 * Oldest first is deliberate: the top of the list is the thing that has been
 * blocked longest, which is the one worth answering next. Newest-first would
 * bury a held action under a plan proposed thirty seconds ago.
 */
export function openAsks(messages: Message[], now: Date = new Date()): Ask[] {
  const out: Ask[] = []
  for (const m of messages) {
    if (!isOperatorAsk(m, now)) continue
    if (isOpenApproval(m)) {
      out.push({ agentId: m.agentId, messageId: m.id, kind: 'approval', summary: m.action.summary, ts: m.ts })
    } else if (isOpenQuestion(m)) {
      out.push({ agentId: m.agentId, messageId: m.id, kind: 'question', summary: m.text, ts: m.ts, deadline: m.deadline, fallback: m.fallback })
    } else if (m.role === 'plan') {
      out.push({ agentId: m.agentId, messageId: m.id, kind: 'plan', summary: m.plan.summary, ts: m.ts })
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts))
}

/** What the operator is being asked to do — the verb, for a button or a badge. */
export const ASK_LABEL: Record<AskKind, string> = {
  approval: 'Needs your OK',
  question: 'Asked you a question',
  plan: 'Proposed a plan'
}

/**
 * Only a question answers itself. A plan and a held action wait indefinitely —
 * and saying so is the difference between "I'll get to it" and "it is stopped."
 *
 * Drives the COLOUR. For the words, use `consequence` — see why there.
 */
export const waitsForever = (kind: AskKind): boolean => kind !== 'question'

/**
 * What actually happens while this sits unanswered.
 *
 * `waitsForever` merges two cases that a person experiences very differently,
 * and only one of them is an emergency:
 *
 *   a HELD ACTION stops the agent. Every autonomous wake-up is a no-op until
 *   someone replies. Nothing else it planned happens.
 *
 *   a PLAN waits, but the agent carries on running its existing plan meanwhile.
 *   It is a proposal, not a blockage.
 *
 * Telling someone their agent is "stopped" when it is quietly still working
 * would be an overclaim, and a feature whose whole job is to be believed cannot
 * afford one.
 */
/**
 * The stand-in for "when" inside a question's consequence.
 *
 * A surface that can render a countdown swaps this for its own duration —
 * "Answers itself IN 3H — I sell half". It is exported rather than left as a
 * literal because the substitution happens elsewhere, against a string authored
 * here: matching `'at the deadline'` by hand would make rewording this sentence
 * silently no-op the replace. A typed import moves when the sentence does.
 *
 * `check-awaiting.ts` asserts the sentence still contains it, so a reword fails
 * the check rather than quietly losing the countdown.
 */
export const DEADLINE_TOKEN = 'at the deadline'

export function consequence(ask: Pick<Ask, 'kind' | 'fallback'>): string {
  if (ask.kind === 'approval') return 'Stopped until you answer'
  if (ask.kind === 'plan') return 'Nothing expires — it waits for you'
  // The fallback is DATA and belongs here; the deadline is FORMATTING and does
  // not. A surface that can render a countdown says "Answers itself in 3h — I
  // sell half" by supplying its own clock; one that cannot still gets the
  // promise and the consequence. Forcing a time format into shared would make
  // every caller take one surface's format, and none is right for all.
  return `Answers itself ${DEADLINE_TOKEN}${ask.fallback ? ` — ${ask.fallback}` : ''}`
}
