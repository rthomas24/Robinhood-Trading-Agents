/**
 * An approval is granted against a specific tool definition.
 *
 * If that definition changes — a renamed argument, a new required
 * field, a description that redraws what the tool does — the operator approved
 * something that no longer exists, and replaying their yes against the new
 * meaning is putting words in their mouth.
 *
 * Our approvals are usually short-lived, but by design they have NO deadline:
 * `waitsForever('approval')` is true, a card can sit pending indefinitely, and
 * "pending across an app update" is therefore a supported state rather than an
 * edge case.
 *
 * TWO THINGS HERE ARE LOAD-BEARING AND BOTH ARE ABOUT ABSENCE.
 *
 * 1. An absent hash means "no opinion", never "unchanged". Cards written
 *    before this shipped have none, and a Robinhood write tool is discovered
 *    from the live MCP server so we hold no definition to hash. Treating
 *    absence as a mismatch would invalidate every approval in flight on the
 *    day an update ships — the operator taps Approve and it refuses.
 * 2. The check lives in `runOnce.ts`, not in `approvalCovers`. That function
 *    is in `src/shared` and the renderer uses it too, but holds no tool
 *    definitions to hash — a second implementation there is exactly what
 *    shared exists to prevent. Verified: `approvalCovers` has ONE caller and it
 *    is engine-side.
 *
 * Run: `npm run check -- approval-staleness`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toolDefinitionHash, AGENT_TOOLS } from '@core/runner/agentTools'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── the hash is stable, and distinguishes ──────────────────────────────────
const a = toolDefinitionHash('trade')
check('a known tool hashes', typeof a === 'string' && a.length === 16, String(a))
check('...deterministically', toolDefinitionHash('trade') === a, 'a hash that moved every process would refuse every approval after a restart')
check('...accepting the prefixed name too', toolDefinitionHash('mcp__tb__trade') === a, 'the gate sees prefixed names')
check('different tools hash differently', toolDefinitionHash('set_exit') !== a)
const all = AGENT_TOOLS.map((t) => toolDefinitionHash(t.name))
check('every tool hashes', all.every((h) => typeof h === 'string'), `${all.filter(Boolean).length}/${AGENT_TOOLS.length}`)
check('...and all distinctly', new Set(all).size === all.length, `${new Set(all).size}/${all.length}`)

// ── absence is not a mismatch ──────────────────────────────────────────────
check('an unknown tool returns undefined, not a hash of nothing', toolDefinitionHash('place_equity_order') === undefined, 'a Robinhood write tool is discovered live; we hold no definition')
check('...and undefined is falsy, so the guard skips it', !toolDefinitionHash('place_equity_order'))

// The guard as written: refuse only when BOTH sides have a hash and they differ.
const refuses = (stored: string | undefined, current: string | undefined): boolean => Boolean(stored && current && stored !== current)
check('a changed definition REFUSES', refuses('aaaa', 'bbbb'))
check('an unchanged definition passes', refuses('aaaa', 'aaaa') === false)
check('a card from before this shipped passes', refuses(undefined, 'aaaa') === false, 'else every approval in flight breaks the day this deploys')
check('a tool we cannot hash passes', refuses('aaaa', undefined) === false, 'Robinhood write tools keep working')
check('neither side known passes', refuses(undefined, undefined) === false)

// ── the wiring ─────────────────────────────────────────────────────────────
const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8')
check('the hash is STORED when the card is created', /toolHash: toolDefinitionHash\(name\)/.test(src), 'a check against a field nobody writes always passes')
check('...and CHECKED before the pass is spent', src.indexOf('approved.toolHash') < src.indexOf('const covers = approvalCovers'))
check('the refusal names the tool that changed', /tool changed after the operator approved this/.test(src), 'the UI puts whatever we raise on a button they just pressed; "something went wrong" gets tapped again')
check('it is audited under its own rule', /approval\.staleDefinition/.test(src))

// ── the check must not have moved into shared ──────────────────────────────
const approval = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'shared', 'approval.ts'), 'utf8')
check('approvalCovers does NOT hash tool definitions', /toolDefinitionHash|createHash/.test(approval) === false, 'the renderer holds no tool definitions')

// ── and the rule key is typed, so it cannot drift ──────────────────────────
const decisions = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'shared', 'decisions.ts'), 'utf8')
check("'approval.staleDefinition' is in the DecisionRule union", /'approval\.staleDefinition'/.test(decisions), 'a rule key outside the typed union would be a key nothing else knows')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
