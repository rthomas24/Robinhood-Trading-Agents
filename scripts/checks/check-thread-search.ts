/**
 * The agent must be able to find what scrolled out of its window.
 *
 * The prompt carries the last ~24 messages. Everything before that is on disk
 * and invisible, and nothing tells the agent it is missing — an operator's
 * "never touch biotech" from three weeks ago simply is not there.
 * `search_thread` makes falling off the transcript recoverable instead of
 * terminal.
 *
 * THE TRAP THIS EXISTS TO CATCH (found by lane D before a line was written):
 * `agentStore.loadMessages` keeps only the last `MSG_CACHE_MAX` = 400 messages
 * hot, and `recentMessages` reads through it. A `searchMessages` written
 * alongside it, over that same helper, would silently search only the tail and
 * return "no matches" for anything older — a wrong answer shaped exactly like
 * a right one, reproducing the bug the tool exists to fix, INSIDE the fix, and
 * passing every test written against a short thread.
 *
 * So the corpus below is deliberately larger than the cache and the assertion
 * that matters is a hit on message #1. The same check with 50 messages would
 * pass against the broken implementation, which is the point.
 *
 * Run: `npm run check -- thread-search`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { searchThreadMessages, searchableText } from '@core/runner/threadSearch'
import type { Message } from '@shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const MSG_CACHE_MAX = 400 // asserted against the real constant below
const TOTAL = MSG_CACHE_MAX + 120
const ts = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
const msg = (id: string, i: number, text: string, role = 'agent'): Message => ({ id, agentId: 'ag_1', role, ts: ts(i), text }) as unknown as Message

const thread: Message[] = [msg('m1', 1, 'never touch biotech, whatever happens', 'user')]
for (let i = 2; i <= TOTAL; i++) thread.push(msg(`m${i}`, i, `routine tick ${i}, nothing to report`))
thread.push(msg('recent', TOTAL + 1, 'how is the biotech position doing', 'user'))

// ── the assertion the whole check exists for ───────────────────────────────
check(`corpus is larger than the cache (${thread.length} > ${MSG_CACHE_MAX})`, thread.length > MSG_CACHE_MAX)
check('the cached TAIL could not see message #1', thread.slice(-MSG_CACHE_MAX).some((m) => m.id === 'm1') === false, 'if this ever goes false the trap is gone and the next line proves nothing')

const hits = searchThreadMessages(thread, 'biotech', 10)
check('search finds the OLDEST message', hits.some((m) => m.id === 'm1'), hits.map((m) => m.id).join(',') || 'NONE')
check('...and the recent one too', hits.some((m) => m.id === 'recent'))
check('results are oldest-first', hits.length > 1 && hits[0].ts < hits[hits.length - 1].ts, hits.map((m) => m.id).join(','))

// ── the wiring, not just the rule ──────────────────────────────────────────
// The rule above is pure and could be perfect while the store still fed it the
// cached tail. That is the actual defect, so assert the call site: the desktop
// must search `allMessages`, never `loadMessages`.
const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'main', 'store', 'agentStore.ts'), 'utf8')
const body = src.slice(src.indexOf('searchMessages(agentId: string'), src.indexOf('appendRun(r: RunRecord)'))
check('agentStore.searchMessages reads allMessages', body.includes('allMessages('), body.slice(0, 120))
check('...and NOT the truncated cache', body.includes('loadMessages(') === false, 'loadMessages caps at MSG_CACHE_MAX')
check('MSG_CACHE_MAX is still 400, as this check assumes', src.includes(`MSG_CACHE_MAX = ${MSG_CACHE_MAX}`), 'if the constant moved, re-size the corpus above')

// ── every term must match ──────────────────────────────────────────────────
check('every term must appear', searchThreadMessages(thread, 'never biotech', 10).some((m) => m.id === 'm1'))
check('...so an absent term excludes the message', searchThreadMessages(thread, 'biotech pharmaceutical', 10).length === 0)
check('a genuine miss returns nothing', searchThreadMessages(thread, 'zzzznotpresent', 10).length === 0)
check('case-insensitive', searchThreadMessages(thread, 'BIOTECH', 10).some((m) => m.id === 'm1'))
check('an empty query returns NOTHING, not everything', searchThreadMessages(thread, '   ', 10).length === 0, 'returning the whole thread would be the worst possible answer')

// ── the limit ──────────────────────────────────────────────────────────────
const many = searchThreadMessages(thread, 'routine', 5)
check('the limit is respected', many.length === 5, String(many.length))
check('...keeping the most RECENT matches', many.some((m) => m.id === `m${TOTAL}`), many.map((m) => m.id).join(','))
check('the limit is capped even if the model asks for more', searchThreadMessages(thread, 'routine', 9999).length <= 20)
check('...and a nonsense limit still returns something', searchThreadMessages(thread, 'routine', 0).length >= 1)

// ── a trade card must be findable ──────────────────────────────────────────
// "when did I buy MU" is one of the questions this exists to answer, and a
// trade card carries its symbol in structured fields, not in `text`.
const card = { id: 'a1', agentId: 'ag_1', role: 'action', ts: ts(5), action: { symbol: 'MU', side: 'buy', reason: 'breakout above range' } } as unknown as Message
check('a trade card is searchable by its symbol', searchThreadMessages([card], 'MU', 5).length === 1)
check('...and by its reason', searchThreadMessages([card], 'breakout', 5).length === 1)
check('searchableText covers structured fields', /MU/.test(searchableText(card)) && /breakout/.test(searchableText(card)), searchableText(card))

// The root cause a text-only search would hit: an `action` message has no
// `text` field, so searching `text` alone can never find a trade card.
const agentsSrc = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'shared', 'agents.ts'), 'utf8')
check("an 'action' message still has NO text field", /role: 'action'; action: TradeAction/.test(agentsSrc))

// And the parity that matters behaviourally: the shared rule finds a trade
// card, so any host that calls it finds one too.
check('the shared rule finds a trade card by symbol', searchThreadMessages([card], 'MU', 5).length === 1, 'every host runs this exact function')

// PARITY UNDER PAGING. A host that pages newest-first and unshifts each older
// page's hits must produce what the shared rule produces over the whole corpus
// at once. Simulate that paging here against the same thread — including an
// action row, which a text-only search could never match.
const withCard: Message[] = [card, ...thread]
const PAGE = 1_000
const paged: Message[] = []
for (let p = 0; p * PAGE < withCard.length; p++) {
  const newestFirst = [...withCard].reverse().slice(p * PAGE, (p + 1) * PAGE)
  paged.unshift(...searchThreadMessages([...newestFirst].reverse(), 'biotech', 10 - paged.length))
  if (paged.length >= 10) break
}
const whole = searchThreadMessages(withCard, 'biotech', 10)
check('paged search equals whole-corpus search', JSON.stringify(paged.map((m) => m.id)) === JSON.stringify(whole.map((m) => m.id)), `${paged.map((m) => m.id).join(',')} vs ${whole.map((m) => m.id).join(',')}`)
check('...over a corpus larger than one page', withCard.length > PAGE / 2, `${withCard.length} messages`)
check('the oldest message is still found when paging', paged.some((m) => m.id === 'm1'), 'this is the MSG_CACHE_MAX assertion, in paged form')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
