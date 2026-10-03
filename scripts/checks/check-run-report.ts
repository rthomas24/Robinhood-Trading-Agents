/**
 * A run ends as a CARD, not a paragraph — and never as a blank for anything
 * that predates cards.
 *
 * Nine near-identical "Holding this tick — …" paragraphs is what a thread
 * looked like; the `report` tool is the structured, vendor-neutral channel
 * that replaces them (tools are the one place all four vendors already agree,
 * with lenient coercion — no response-format branching anywhere). The
 * contract, asserted here:
 *
 *   1. `report` is a plain-object schema (claude vendor reads `.shape`) with
 *      lenient enums, and the model's sloppy casing still parses;
 *   2. the host HOLDS the report (`pendingReport`) rather than posting — the
 *      run's settle attaches it to the FINAL message, so one-message-per-run
 *      stays the invariant;
 *   3. `text` always carries a readable twin (the model's own prose, else
 *      `reportFallbackText`) — transcripts, previews, notifications and older
 *      records never meet a blank message;
 *   4. previews lead with the headline;
 *   5. the prompt teaches it — and keeps reply runs HUMAN: a conversation
 *      does not come back as a form;
 *   6. the thread renders the report, and prose the model wrote anyway is
 *      shown under it rather than silently dropped.
 *
 * Run: `npm run check -- run-report`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_TOOLS, type ToolHost } from '../../src/core/runner/agentTools'
import { composeSystemPrompt } from '../../src/core/runner/prompts'
import { previewOf, reportFallbackText, DEFAULT_GUARDRAILS, type AgentConfig, type AgentReport, type Message } from '../../src/shared/agents'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const reportTool = AGENT_TOOLS.find((t) => t.name === 'report')!

// ------------------------------------------------------------- schema + tool

check('report tool exists and keeps .shape', Boolean(reportTool) && typeof (reportTool.schema as z.ZodObject<z.ZodRawShape>).shape === 'object')

// The schema's output type is opaque at this seam (lenient enums pipe through
// unknown), so name what the parse is expected to produce.
const sloppy = reportTool.schema.parse({
  headline: 'Holding all three — flatten starts ~3:50',
  status: ' Held ',
  facts: [{ label: 'PLTR', value: '$187.52', delta: '+0.8% vs entry', tone: 'UP' }],
  next: 'Flatten ~3:50, retire at close.'
})
// What the parse is expected to have produced, for the field checks below.
const parsed = sloppy as unknown as AgentReport
check('sloppy model casing still parses (status " Held " → held, tone "UP" → up)', parsed.status === 'held' && parsed.facts?.[0].tone === 'up')

// Assigned inside the host closure, which control-flow analysis cannot see —
// declared through the assertion so it is not narrowed to `null` below.
let reported = null as AgentReport | null
const host = { report: async (r: AgentReport) => ((reported = r), 'Report filed — it will be the run summary. End your run now; do NOT also write a closing summary message.') } as unknown as ToolHost
const result = await reportTool.run(sloppy, host)
check('the tool hands the report to the host and tells the model to stop', reported?.headline === parsed.headline && /do NOT also write/.test(result))

// ------------------------------------------------------- the fallback twin

const r: AgentReport = {
  headline: 'Holding all three — flatten starts ~3:50',
  status: 'held',
  facts: [
    { label: 'PLTR', value: '$187.52', delta: '+0.8% vs entry', tone: 'up' },
    { label: 'Book', value: '−$707 (−2.83%)', tone: 'down' }
  ],
  next: 'Flatten ~3:50, retire at close. 7 orders left.',
  details: 'Tape soft; AVGO reports Wed.'
}
const fb = reportFallbackText(r)
check('fallback text carries headline, every fact, next and details', fb.startsWith(r.headline) && fb.includes('PLTR: $187.52 (+0.8% vs entry)') && fb.includes('Next: Flatten ~3:50') && fb.includes('AVGO reports Wed'))

const msg = { id: 'm1', ts: '2026-08-31T20:00:00Z', role: 'agent', text: fb, report: r } as Message
check('previews lead with the headline', previewOf(msg) === r.headline)
check('a report-less agent message previews as before', previewOf({ id: 'm2', ts: '', role: 'agent', text: 'plain words' } as Message) === 'plain words')

// ------------------------------------------------------- source contracts

const R = join(import.meta.dirname, '..', '..')
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (...p: string[]): string => code(readFileSync(join(R, ...p), 'utf8'))

const runOnce = read('src', 'core', 'runner', 'runOnce.ts')
check('the host holds the report; the settle posts it', /async report\(r\) \{\s*pendingReport = r/.test(runOnce), 'posting from the handler would put the summary above whatever the model does next')
check('one message per run: the report RIDES the final message', /if \(finalText \|\| pendingReport\)/.test(runOnce) && /\.\.\.\(pendingReport \? \{ report: pendingReport \} : \{\}\)/.test(runOnce))
check('text is the prose when the model wrote any, else the composed twin', /finalText \|\| \(pendingReport \? reportFallbackText\(pendingReport\) : ''\)/.test(runOnce))

const cfg = { id: 'a', name: 'T', task: 't', mode: 'paper', model: { vendor: 'claude', id: 'x' }, schedule: { kind: 'manual' }, guardrails: DEFAULT_GUARDRAILS, allocationUsd: 1000, createdAt: '', updatedAt: '' } as AgentConfig
const sys = composeSystemPrompt(cfg)
check('the prompt teaches ending autonomous runs with report', /END EVERY AUTONOMOUS RUN by calling `report`/.test(sys))
check('…and keeps reply runs human', /answer them in plain prose/.test(sys), 'a conversation must not come back as a form')

const item = read('src', 'renderer', 'src', 'components', 'thread', 'MessageItem.tsx')
// The report renders as a memo: `if (m.report) { … <ReportMemo report={m.report}`.
check('the thread renders the report when one exists', /if \(m\.report\) \{[\s\S]{0,240}<Report(?:Card|Memo)\s+report=\{m\.report\}/.test(item))
check('prose the model wrote anyway shows under the report, not dropped', /m\.text !== reportFallbackText\(m\.report\) \? m\.text : undefined/.test(item))
check('all four statuses have a rendering', ['acted', 'held', 'blocked', 'done'].every((s) => new RegExp(`${s}: \\{ label`).test(item)))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
