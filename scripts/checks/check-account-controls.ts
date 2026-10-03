/**
 * What the tool policy normalizer makes of a missing or garbled policy, and
 * that a real one survives intact.
 *
 * `normalizeToolPolicy(null)` yields `robinhoodDisabled: []`: every Robinhood
 * read tool enabled. That is the right DEFAULT for a fresh install, and the
 * wrong thing to substitute for an operator's policy that could not be read —
 * it would silently hand back access they took away. Writes are off either way.
 *
 * Run: `npm run check -- account-controls`
 */
import { ROBINHOOD_TOOL_CATALOG, normalizeToolPolicy } from '@shared/mcps'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const READS = ROBINHOOD_TOOL_CATALOG.filter((t) => t.kind === 'read').map((t) => t.name)

// The trap itself, stated as a fact about the shared helper rather than about
// our code — this is WHY the fallback cannot be the default policy.
const fallback = normalizeToolPolicy(null)
check(
  'the DEFAULT policy leaves every Robinhood read tool enabled',
  fallback.robinhoodDisabled.length === 0,
  'so substituting it on a read error hands back access the operator took away'
)
check('there are read tools to lose in the first place', READS.length > 0, `${READS.length} in the catalog`)

// The operator's real policy must survive intact when the read SUCCEEDS —
// failing safe is worthless if it also fires on the happy path.
const real = normalizeToolPolicy({ robinhoodDisabled: ['get_equity_quotes'], robinhoodWriteEnabled: [] })
check('a successful read keeps exactly what the operator disabled', real.robinhoodDisabled.join() === 'get_equity_quotes', real.robinhoodDisabled.join())
check('and does not withhold everything else', real.robinhoodDisabled.length < READS.length)

// Writes were already safe — worth pinning so a future "fix" to the read side
// cannot quietly invert this half.
check('an empty policy enables no write tool', fallback.robinhoodWriteEnabled.length === 0, 'writes are off unless switched on, and only for live+armed agents')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
