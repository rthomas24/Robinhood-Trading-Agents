/**
 * State tools take ONE-OR-MANY; write tools stay one-per-call, on purpose.
 *
 * A respawned agent clearing four dead theses made four `set_thesis` calls —
 * four gate/audit/state round-trips for one intention, and in a parallel-call
 * turn the thread paired results with the wrong calls (META's call showed
 * AMZN's answer). The fix: `set_thesis`, `watch_price`, `remember`, `forget`
 * and `errand_done` each gained a plural field carrying the whole batch, the
 * singular fields still work, and the handler loops the existing host method —
 * hosts and vendors unchanged.
 *
 * Two contracts here are load-bearing:
 *  - every top-level schema stays a plain z.object — `vendors/claude.ts` reads
 *    `t.schema.shape`, so "singular or plural, not neither" lives in the
 *    handler (answered with instructions, not a validation error);
 *  - WRITE tools (`trade`, `cancel_order`, `set_exit`, `retire`) take NO batch:
 *    the approval flow's contract is one yes covers one narrow action
 *    (`approvalCovers`: same tool, same symbol, size no larger), and a batched
 *    write would let one tap approve N risks.
 *
 * Run: `npm run check -- batch-tools`
 */
import { z } from 'zod'
import { AGENT_TOOLS, type ToolHost } from '../../src/core/runner/agentTools'
import { composeSystemPrompt } from '../../src/core/runner/prompts'
import { DEFAULT_GUARDRAILS, WRITE_TOOLS, type AgentConfig } from '../../src/shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!
const calls: string[] = []
const host = new Proxy({} as ToolHost, {
  get:
    (_t, method: string) =>
    async (...args: unknown[]) => {
      calls.push(`${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`)
      return `${method} ok`
    }
})

// ------------------------------------------------- the claude-vendor contract

for (const t of AGENT_TOOLS) {
  check(`${t.name} schema keeps .shape`, typeof (t.schema as z.ZodObject<z.ZodRawShape>).shape === 'object', 'vendors/claude.ts reads t.schema.shape — a refine/pipe at top level breaks that vendor at construction')
}

// ------------------------------------------------------------- set_thesis

{
  calls.length = 0
  const parsed = tool('set_thesis').schema.parse({ theses: [{ symbol: 'meta' }, { symbol: 'googl' }, { symbol: 'NVDA', thesis: 'AI capex supercycle' }] })
  const out = await tool('set_thesis').run(parsed, host)
  check('set_thesis batch loops the host per item, in order', calls.join('|') === 'setThesis("META", )|setThesis("GOOGL", )|setThesis("NVDA", "AI capex supercycle")', calls.join('|'))
  check('…and joins per-item results', out.split('\n').length === 3)

  calls.length = 0
  await tool('set_thesis').run(tool('set_thesis').schema.parse({ symbol: 'mu', thesis: 'HBM demand outruns supply' }), host)
  check('set_thesis single form still works', calls[0] === 'setThesis("MU", "HBM demand outruns supply")')

  const neither = await tool('set_thesis').run(tool('set_thesis').schema.parse({}), host)
  check('set_thesis with neither form instructs instead of throwing', /pass `symbol`.*or `theses`/.test(neither))
}

// ------------------------------------------------------------- watch_price

{
  calls.length = 0
  const parsed = tool('watch_price').schema.parse({ watches: [{ symbol: 'mu', condition: 'below', value: 900 }, { symbol: 'PLTR', cancel: true }, { symbol: 'AVGO' }] })
  const out = await tool('watch_price').run(parsed, host)
  check('watch_price batch: set + cancel both reach the host', calls.length === 2 && /watchPrice.*"MU".*"below".*900/.test(calls[0]) && /watchPrice.*"PLTR".*"cancel":true/.test(calls[1]), calls.join('|'))
  check('…an item missing condition/value is skipped with instructions, not sent', out.includes('AVGO: skipped') && !calls.some((c) => c.includes('AVGO')))

  calls.length = 0
  await tool('watch_price').run(tool('watch_price').schema.parse({ symbol: 'mu', condition: 'move_down_pct', value: 2 }), host)
  check('watch_price single form still works', calls.length === 1 && /"MU"/.test(calls[0]))
}

// ------------------------------------------------------- remember / forget

{
  calls.length = 0
  const out = await tool('remember').run(tool('remember').schema.parse({ notes: ['sold MU 8/31', 'operator wants fresh-day resets'], defer: 'next_run' }), host)
  check('remember batch carries the shared defer to every note', calls.length === 2 && calls.every((c) => c.includes('"next_run"')), calls.join('|'))
  check('…and prefixes each line with its note (the host result is only a count)', out.split('\n').every((l) => l.startsWith('"')))

  calls.length = 0
  await tool('remember').run(tool('remember').schema.parse({ note: 'single note' }), host)
  check('remember single form is unprefixed, as before', calls.length === 1)

  calls.length = 0
  const fOut = await tool('forget').run(tool('forget').schema.parse({ matches: ['stale MU plan', 'labor day'] }), host)
  check('forget batch loops and names each fragment', calls.length === 2 && fOut.includes('"stale MU plan"') && fOut.includes('"labor day"'))
}

// ------------------------------------------------------------- errand_done

{
  calls.length = 0
  await tool('errand_done').run(tool('errand_done').schema.parse({ settled: [{ id: 'e_1', outcome: 'sold at open' }, { id: 'e_2', outcome: 'no longer relevant' }] }), host)
  check('errand_done batch settles each errand', calls.join('|') === 'errandDone("e_1", "sold at open")|errandDone("e_2", "no longer relevant")', calls.join('|'))

  calls.length = 0
  await tool('errand_done').run(tool('errand_done').schema.parse({ id: 'e_3', outcome: 'done' }), host)
  check('errand_done single form still works', calls[0] === 'errandDone("e_3", "done")')

  const neither = await tool('errand_done').run(tool('errand_done').schema.parse({}), host)
  check('errand_done with neither form instructs', /`id`\+`outcome`.*or `settled`/.test(neither))
}

// ---------------------------------------- write tools stay one-per-call

for (const name of WRITE_TOOLS) {
  const props = (z.toJSONSchema(tool(name).schema, { io: 'input' }) as { properties?: Record<string, { type?: string }> }).properties ?? {}
  const arrays = Object.entries(props).filter(([, p]) => p.type === 'array').map(([k]) => k)
  const allowed = name === 'trade' ? [] : arrays // trade has no array field at all today; none may gain one
  check(`${name} carries no batch field`, arrays.length === allowed.length && arrays.every((a) => allowed.includes(a)), `one yes covers one narrow action — arrays found: ${arrays.join(', ') || '(none)'}`)
}

// --------------------------------------------------- the habit is taught

for (const name of ['set_thesis', 'watch_price', 'remember', 'forget', 'errand_done']) {
  check(`${name} description advertises the batch`, /ONE call/.test(tool(name).description) || /one call/.test(tool(name).description))
}

const cfg = { id: 'a', name: 'T', task: 't', mode: 'paper', model: { vendor: 'claude', id: 'x' }, schedule: { kind: 'manual' }, guardrails: DEFAULT_GUARDRAILS, allocationUsd: 1000, createdAt: '', updatedAt: '' } as AgentConfig
check('the system prompt teaches batching (and the trade exception)', /BATCH your bookkeeping/.test(composeSystemPrompt(cfg)) && /Trading is the exception/.test(composeSystemPrompt(cfg)))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
