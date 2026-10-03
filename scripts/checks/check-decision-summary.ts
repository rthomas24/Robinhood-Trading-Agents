/**
 * The decision log reads as a sentence, and every rule has a phrase.
 *
 * `summarizeDecisions` groups a window of decision records by the rule that
 * blocked them; `heldBackSentence` says it in words. The check that matters
 * most is the compile-time one — `RULE_LABEL` is a Record over the closed
 * `DecisionRule` set, so a rule added to `decisions.ts` without a phrase here
 * is a type error, not a blank in the UI. The runtime checks below pin the
 * counting, the window, the ordering and the wording.
 *
 * Run: `npm run check -- decision-summary`
 */
import type { DecisionRecord } from '@shared/decisions'
import { heldBackSentence, ruleLabel, RULE_LABEL, summarizeDecisions } from '@shared/decisionSummary'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const t0 = Date.UTC(2026, 8, 1, 14, 0)
const at = (min: number): string => new Date(t0 + min * 60_000).toISOString()
let n = 0
const rec = (min: number, rule: DecisionRecord['rule'], outcome: DecisionRecord['outcome'], attended: boolean, detail?: string): DecisionRecord => ({
  id: `dec_${++n}`,
  ts: at(min),
  agentId: 'ag_1',
  runId: `run_${min}`,
  trigger: attended ? 'reply' : 'schedule',
  attended,
  tool: 'mcp__tb__trade',
  outcome,
  rule,
  detail
})

const log: DecisionRecord[] = [
  rec(10, 'ok', 'allowed', false),
  rec(20, 'cap.ordersPerDay', 'blocked', false, 'buy 3 MU — 10 of 10 orders used today'),
  rec(30, 'cap.ordersPerDay', 'blocked', false, 'buy 2 MU — 10 of 10 orders used today'),
  rec(40, 'session.closed', 'blocked', true, 'sell 5 SPY — market closed'),
  rec(50, 'cap.ordersPerDay', 'blocked', true, 'buy 3 MU — 10 of 10 orders used today'),
  rec(60, 'ok.operatorExit', 'allowed', true),
  rec(70, 'lock.dailyLoss', 'blocked', false, 'buy 1 NVDA — daily loss lock'),
  rec(80, 'cap.ordersPerDay', 'blocked', false, 'buy 1 MU — 10 of 10 orders used today')
]

// Shuffled on purpose: the summary must not depend on the order it was handed.
const shuffled = [log[5], log[2], log[7], log[0], log[6], log[1], log[4], log[3]]
const s = summarizeDecisions(shuffled)
check('counts: 8 total, 2 allowed, 6 blocked', s.total === 8 && s.allowed === 2 && s.blocked === 6)
check('unattended blocks counted separately', s.unattendedBlocked === 4, String(s.unattendedBlocked))
check('most frequent rule first', s.blockedBy[0]?.rule === 'cap.ordersPerDay' && s.blockedBy[0].count === 4)
check('ties broken by label so the order is stable', s.blockedBy[1]?.rule === 'lock.dailyLoss' && s.blockedBy[2]?.rule === 'session.closed')
check('per-rule unattended count', s.blockedBy[0].unattended === 3)
check('examples: at most two, distinct, most recent first', s.blockedBy[0].examples.length === 2 && s.blockedBy[0].examples[0] === 'buy 1 MU — 10 of 10 orders used today')
check('lastAt is the most recent occurrence', s.blockedBy[0].lastAt === at(80))
check('no window → since is null', s.since === null)

const sentence = heldBackSentence(s, 'in the last 7 days')
check('the sentence', sentence === 'Held back 6 times in the last 7 days: 4× by the daily order cap, 1× by the daily-loss buy lock, 1× by the market being closed. 4 of those happened with nobody at the keyboard.', sentence)

const windowed = summarizeDecisions(log, { since: t0 + 45 * 60_000 })
check('window keeps only records at or after since', windowed.total === 4 && windowed.blocked === 3 && windowed.since === new Date(t0 + 45 * 60_000).toISOString())

const many = summarizeDecisions([...log, rec(90, 'price.missing', 'blocked', false), rec(91, 'symbol.notAllowed', 'blocked', false)])
check('more than three rules → "and N other rules"', /, and 2 other rules\./.test(heldBackSentence(many)), heldBackSentence(many))

check('all allowed reads as nothing held back', heldBackSentence(summarizeDecisions([log[0], log[5]])) === 'Nothing held back: 2 gated calls, all allowed.')
check('empty reads as no gated calls', heldBackSentence(summarizeDecisions([]), 'today') === 'No gated tool calls today.')
check('singular forms', heldBackSentence(summarizeDecisions([log[3]])) === 'Held back 1 time: 1× by the market being closed.', heldBackSentence(summarizeDecisions([log[3]])))

check('an undeclared rule key still reads as itself', ruleLabel('future.rule') === 'future.rule' && ruleLabel('cap.ordersPerDay') === 'the daily order cap')
check('every label is a non-empty phrase', Object.values(RULE_LABEL).every((v) => typeof v === 'string' && v.trim().length > 3))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
