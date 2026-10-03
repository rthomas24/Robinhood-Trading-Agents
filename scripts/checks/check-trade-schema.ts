/**
 * `trade` refuses a call with neither qty nor notional at the VENDOR boundary
 * — a zod refinement on the schema every
 * runner parses against, with the human-readable bounce kept as the fallback.
 *
 * Two properties the Claude vendor depends on are pinned: the refined schema
 * is still a ZodObject with a `.shape` (vendors/claude.ts hands the shape to
 * the SDK), and the advertised JSON schema is unchanged.
 *
 * Run: `npm run check -- trade-schema`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { AGENT_TOOLS } from '@core/runner/agentTools'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const trade = AGENT_TOOLS.find((t) => t.name === 'trade')!
const base = { side: 'buy', symbol: 'MU', reason: 'x' }
check('neither qty nor notional is rejected by the schema', !trade.schema.safeParse(base).success)
check('the error names the rule', /qty OR notional/.test(JSON.stringify(trade.schema.safeParse(base).error?.issues ?? [])))
check('a SELL with neither passes — it closes the whole position (the host fills the held qty)', trade.schema.safeParse({ ...base, side: 'sell' }).success)
check('qty alone passes', trade.schema.safeParse({ ...base, qty: 5 }).success)
check('notional alone passes', trade.schema.safeParse({ ...base, notional: 500 }).success)
check('a lenient "5" still passes', trade.schema.safeParse({ ...base, qty: '5' }).success)
check('the refined schema keeps its .shape for the Claude vendor', typeof (trade.schema as { shape?: unknown }).shape === 'object' && 'qty' in (trade.schema as { shape: Record<string, unknown> }).shape)
const json = z.toJSONSchema(trade.schema, { target: 'draft-7', io: 'input' }) as { properties?: Record<string, unknown>; required?: string[] }
check('the advertised JSON schema still lists qty and notional as optional', !!json.properties?.qty && !!json.properties?.notional && !(json.required ?? []).includes('qty'))
const src = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/agentTools.ts'), 'utf8')
check('the human-readable bounce stays as the fallback', /NOT PLACED \(missing argument\): give qty OR notional/.test(src))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
