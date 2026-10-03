/**
 * Everything an agent is waiting on the operator for, in one list.
 *
 * Three kinds of card ask a question and then stop — a proposed PLAN, a held
 * ACTION, a direct QUESTION — and each was only visible inside its own thread.
 * From the sidebar, an agent stalled on an unanswered card looked exactly like
 * one quietly working. The held action is the sharpest case: every autonomous
 * wake-up is a no-op until someone answers, with no deadline and nothing that
 * expires, so an unanswered card is an agent switched off by accident.
 *
 * The list is DERIVED from the messages on every read. An "is waiting" flag
 * would be one more thing to clear correctly on each of six answer paths
 * (apply, dismiss, approve, decline, timeout, supersede), and the day one is
 * missed the badge outlives the card that justified it.
 *
 * Run: `npm run check -- awaiting`
 */
import { openAsks, isAsk, isOperatorAsk, waitsForever, consequence, ASK_LABEL, DEADLINE_TOKEN } from '@shared/awaiting'
import type { Message } from '@shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const base = (id: string, ts: string, agentId = 'ag_1'): { id: string; agentId: string; ts: string } => ({ id, agentId, ts })
const plan = (id: string, ts: string, status: string, agentId = 'ag_1'): Message =>
  ({ ...base(id, ts, agentId), role: 'plan', status, plan: { summary: `plan ${id}`, guardrails: {} } }) as unknown as Message
const approval = (id: string, ts: string, status: string, agentId = 'ag_1'): Message =>
  ({ ...base(id, ts, agentId), role: 'approval', status, action: { summary: `buy 10 MU`, tool: 'trade', args: {}, reason: 'r', requestedAt: ts } }) as unknown as Message
const question = (id: string, ts: string, answeredBy?: string, deadline?: string, agentId = 'ag_1'): Message =>
  ({ ...base(id, ts, agentId), role: 'question', text: `q ${id}`, answeredBy, deadline, fallback: 'hold' }) as unknown as Message
const chat = (id: string, ts: string): Message => ({ ...base(id, ts), role: 'agent', text: 'thinking out loud' }) as unknown as Message

const T = (m: number): string => new Date(Date.UTC(2026, 7, 24, 18, m)).toISOString()

// ── all three kinds are asks ───────────────────────────────────────────────
check('a pending plan is an ask', isAsk(plan('m1', T(1), 'pending')))
check('a pending approval is an ask', isAsk(approval('m2', T(2), 'pending')))
check('an unanswered question is an ask', isAsk(question('m3', T(3))))
check('ordinary chatter is not', isAsk(chat('m4', T(4))) === false)

// ── answered cards drop out ────────────────────────────────────────────────
// This is the whole reason it is derived: six different paths close an ask, and
// each one already writes the message. None of them has to remember a flag.
check('an applied plan is gone', isAsk(plan('m5', T(5), 'applied')) === false)
check('a dismissed plan is gone', isAsk(plan('m6', T(6), 'dismissed')) === false)
check('an approved action is gone', isAsk(approval('m7', T(7), 'approved')) === false)
check('a rejected action is gone', isAsk(approval('m8', T(8), 'rejected')) === false)
check('a withdrawn action is gone', isAsk(approval('m9', T(9), 'withdrawn')) === false)
check('an answered question is gone', isAsk(question('m10', T(10), 'yes')) === false)
check('...however it was answered', isAsk(question('m11', T(11), 'the fallback ran')) === false, 'operator, timeout or superseded all set answeredBy')

// ── the list ───────────────────────────────────────────────────────────────
const thread: Message[] = [chat('c1', T(0)), plan('p', T(30), 'pending'), approval('a', T(5), 'pending'), question('q', T(20)), plan('done', T(25), 'applied')]
const asks = openAsks(thread)
check('only the open ones are listed', asks.length === 3, `${asks.length}`)
check(
  'OLDEST first — the most stalled is the one to answer next',
  asks.map((a) => a.messageId).join(',') === 'a,q,p',
  asks.map((a) => a.messageId).join(',')
)
check('each carries the agent it belongs to', asks.every((a) => a.agentId === 'ag_1'))
check('the approval summarises the ACTION, not the card', asks[0].summary === 'buy 10 MU', asks[0].summary)

// ── across agents ──────────────────────────────────────────────────────────
// Each ask is pinned in its own thread, but the rule is per-agent and a
// combined list shows them together, so the ordering has to hold across agents too.
const many = openAsks([approval('x', T(9), 'pending', 'ag_2'), plan('y', T(1), 'pending', 'ag_3')])
check('asks from different agents coexist', many.length === 2)
check('...still oldest-first across them', many[0].agentId === 'ag_3', many.map((a) => a.agentId).join(','))

// ── what waits forever ─────────────────────────────────────────────────────
// Only a question answers itself. Saying so is the difference between "I'll get
// to it" and "this agent is stopped until I reply".
check('a held action waits indefinitely', waitsForever('approval') === true)
check('a proposed plan waits indefinitely', waitsForever('plan') === true)
check('a question does not — it has a fallback', waitsForever('question') === false)
check(
  'a question carries its deadline through',
  openAsks([question('d', T(1), undefined, T(45))], new Date(T(40)))[0].deadline === T(45),
  'read at T(40), before the deadline'
)
check('every kind has a label', Object.keys(ASK_LABEL).length === 3)

// ── a passed deadline stops being YOUR problem ───────────────────────────
// Past its deadline a question is waiting on the ENGINE, which owes it a
// 'timeout' run that takes the fallback. It is still unresolved — `isAsk` says
// so and the thread still renders it — but it is no longer something to ask a
// person to answer, and listing it as such tells them they are holding up a
// decision that has already been made for them.
//
// This test needs an explicit `now` for the reason it exists: these fixtures are
// pinned to a date in the past, so with the default clock EVERY dated question
// here is expired. That is exactly how this rule was caught — the assertion
// above went red the moment the rule landed.
const expiredQ = question('exp', T(1), undefined, T(20))
check('an expired question is NOT waiting on you', openAsks([expiredQ], new Date(T(30))).length === 0)
check('...but it is still an unresolved ask', isAsk(expiredQ) === true, 'isAsk is about the CARD, openAsks is about the OPERATOR')
check('...and before the deadline it is both', openAsks([expiredQ], new Date(T(10))).length === 1)
check(
  'a question with NO deadline never expires',
  openAsks([question('legacy', T(1))], new Date(T(999))).length === 1,
  'legacy rows carry no deadline and must not vanish'
)
check(
  'an expired question does not hide the others',
  openAsks([expiredQ, approval('keep', T(2), 'pending')], new Date(T(30))).length === 1
)

// ── every "waiting on you" surface must agree ─────────────────────────────
// This is the invariant that actually broke. `openAsks` learned about deadlines
// and the thread's pinned-card filter did not, so the sidebar released a
// question while the thread kept it pinned to the bottom under a heading saying
// the operator was holding it up. One predicate now, and this asserts that
// openAsks is exactly the messages isOperatorAsk accepts — so a surface written
// against either one cannot drift from a surface written against the other.
const mixed = [
  approval('a1', T(1), 'pending'),
  question('q_open', T(2), undefined, T(90)),
  question('q_expired', T(3), undefined, T(20)),
  question('q_answered', T(4), 'held'),
  plan('p1', T(5), 'pending'),
  plan('p_done', T(6), 'applied'),
  chat('c1', T(7))
]
const at = new Date(T(30))
const viaPredicate = mixed.filter((m) => isOperatorAsk(m, at)).map((m) => m.id).sort()
const viaList = openAsks(mixed, at).map((k) => k.messageId).sort()
check(
  'openAsks is exactly what isOperatorAsk accepts',
  JSON.stringify(viaPredicate) === JSON.stringify(viaList),
  `${viaPredicate.join(',')} vs ${viaList.join(',')}`
)
check(
  'the expired question is in neither',
  !viaPredicate.includes('q_expired') && !viaList.includes('q_expired')
)
check(
  '...while isAsk still says it is unresolved',
  isAsk(mixed.find((m) => m.id === 'q_expired')!) === true,
  'the thread must still RENDER it — it just stops being pinned'
)

// ── what waits is not the same as what STOPS ───────────────────────────────
// waitsForever merges two cases a person experiences differently: a held action
// stops the agent dead, a plan is a proposal it keeps running past. Saying
// "stopped" for a plan would be an overclaim, and a feature whose job is to be
// believed cannot afford one.
check('a held action is described as STOPPING the agent', /stopped/i.test(consequence({ kind: 'approval' })), consequence({ kind: 'approval' }))
check('a plan is NOT described as stopping it', /stopped/i.test(consequence({ kind: 'plan' })) === false, consequence({ kind: 'plan' }))
check('...but is still described as waiting indefinitely', /waits for you|nothing expires/i.test(consequence({ kind: 'plan' })), consequence({ kind: 'plan' }))
check('a question is described as resolving itself', /answers itself/i.test(consequence({ kind: 'question' })), consequence({ kind: 'question' }))
check('both plan and approval still wait forever', waitsForever('plan') && waitsForever('approval'), 'the colour is shared even though the words are not')
check(
  "a question's FALLBACK is carried, because it is data",
  consequence({ kind: 'question', fallback: 'I sell half' }).includes('I sell half'),
  consequence({ kind: 'question', fallback: 'I sell half' })
)
check('...and its absence degrades rather than reads oddly', consequence({ kind: 'question' }).endsWith('deadline'), consequence({ kind: 'question' }))
check(
  'the DEADLINE is not baked in — that is formatting, and each app owns its own clock',
  /\d/.test(consequence({ kind: 'question', fallback: 'x' })) === false,
  "a baked-in time format would force every view onto one clock"
)

// A view may substitute its own duration by replacing DEADLINE_TOKEN inside
// this sentence — a coupling nobody reading the sentence can see. If a reword
// drops the token the replace silently no-ops and the view renders "at the
// deadline" to someone holding a countdown. Fail here instead.
check('the question sentence still contains DEADLINE_TOKEN', consequence({ kind: 'question' }).includes(DEADLINE_TOKEN), consequence({ kind: 'question' }))
check('...and substituting it yields a natural sentence', consequence({ kind: 'question', fallback: 'I sell half' }).replace(DEADLINE_TOKEN, 'in 3h') === 'Answers itself in 3h — I sell half', consequence({ kind: 'question', fallback: 'I sell half' }).replace(DEADLINE_TOKEN, 'in 3h'))
check('the other kinds carry no token to substitute', !consequence({ kind: 'plan' }).includes(DEADLINE_TOKEN) && !consequence({ kind: 'approval' }).includes(DEADLINE_TOKEN), 'only a question has a when')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
