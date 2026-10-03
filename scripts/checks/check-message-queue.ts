/**
 * Messages sent mid-run are queued, a run ends when it is told to, and a
 * stopped or timed-out run tells the truth about what it did not do.
 *
 * The failure shape this pins: a run's abort fires at the ceiling and the
 * OpenRouter stream runs on for minutes, until the model finishes on its own;
 * the SDK then refuses the turn's tool calls and throws. Everything queued
 * behind the run waits the extra minutes; the refused calls show in the thread
 * as steps with no verdict, under a reply that says they were done; and a
 * message that failed to send is cleared from the box — the words are gone.
 *
 * What this pins:
 *   1. `isQueuedMessage` — the shared rule the thread draws the queue from;
 *   2. the OpenRouter vendor returns within a beat of the run's abort, even
 *      when the SDK's stream never ends, keeping the text it had;
 *   3. runOnce stamps `runStartedAt`, refuses tool work after the run ended,
 *      marks calls that never ran, posts the Stop note, and no longer posts
 *      "no reply" under a reply;
 *   4. the desktop keeps a failed message on screen, Stop aborts the run, and
 *      one queued reply runs per run.
 *
 * Run: `npm run check -- message-queue`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isQueuedMessage, orderThread, queuedBehindNow, queuedMessages, QUEUE_COPY } from '../../src/shared/messageQueue'
import { type Message } from '../../src/shared/agents'
import { createOpenRouterRunner, STREAM_ABORTED_MSG, untilAborted } from '../../src/core/runner/vendors/openrouter'
import type { ToolHost } from '../../src/core/runner/agentTools'
import type { VendorRunRequest } from '../../src/core/runner/vendors/types'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const R = join(import.meta.dirname, '..', '..')
// Some of these files carry CRLF in places; the pins below are written against LF.
const read = (p: string): string => readFileSync(join(R, p), 'utf8').replace(/\r\n/g, '\n')

// ------------------------------------------------------------ 1. the rule
const user = (ts: string): Message => ({ id: 'm1', agentId: 'ag', ts, role: 'user', text: 'hi' })
const running = { running: true, runStartedAt: '2026-09-08T21:39:40.000Z', status: 'running' as const }
check('a user message stamped after the run began, while it runs, is queued', isQueuedMessage(user('2026-09-08T21:42:31.000Z'), running))
check('the message that TRIGGERED the run (stamped before it) is not', !isQueuedMessage(user('2026-09-08T21:39:38.000Z'), running))
check('nothing is queued once the run has ended', !isQueuedMessage(user('2026-09-08T21:42:31.000Z'), { ...running, running: false }))
check('an agent that never recorded a run start queues nothing', !isQueuedMessage(user('2026-09-08T21:42:31.000Z'), { running: true, runStartedAt: null, status: 'running' }))
check('a retired agent queues nothing', !isQueuedMessage(user('2026-09-08T21:42:31.000Z'), { ...running, status: 'retired' }))
check('only the operator’s messages qualify', !isQueuedMessage({ role: 'agent', ts: '2026-09-08T21:42:31.000Z' }, running))
check('a malformed timestamp is not queued (never a crash)', !isQueuedMessage(user('not a date'), running))
check('queuedMessages keeps thread order', queuedMessages([user('2026-09-08T21:41:00.000Z'), { ...user('2026-09-08T21:42:00.000Z'), id: 'm2' }, { ...user('2026-09-08T21:00:00.000Z'), id: 'm0' }], running).map((m) => m.id).join(',') === 'm1,m2')
check('the copy names the wait and the way out', /finishes this run/.test(QUEUE_COPY.header('X')) && /Stop/.test(QUEUE_COPY.sendNow))
{
  // Thread order: the second question, sent DURING the run that answered the
  // first, sits under that run's reply — not above it by timestamp.
  const q1: Message = { id: 'q1', agentId: 'ag', ts: '2026-09-08T22:57:00.000Z', role: 'user', text: 'What’s your status?' }
  const q2: Message = { id: 'q2', agentId: 'ag', ts: '2026-09-08T22:58:00.000Z', role: 'user', text: 'how did it go today', queuedBehind: 'run_1' }
  const reply: Message = { id: 'a1', agentId: 'ag', ts: '2026-09-08T23:03:00.000Z', role: 'agent', runId: 'run_1', text: 'You just asked this…' }
  const note: Message = { id: 's1', agentId: 'ag', ts: '2026-09-08T23:03:01.000Z', role: 'system', kind: 'info', runId: 'run_1', text: 'Run finished.' }
  const ids = (ms: Message[]): string => orderThread(ms).map((m) => m.id).join(',')
  check('a queued message moves after the LAST message of the run it waited behind', ids([q1, q2, reply, note]) === 'q1,a1,s1,q2')
  check('while that run has no messages yet, timestamp order stands', ids([q1, q2]) === 'q1,q2')
  check('a run the loaded window does not hold leaves the message where it is', ids([q1, q2, { ...reply, runId: 'run_other' }]) === 'q1,q2,a1')
  check('an ordinary message is never moved', ids([q1, { ...q2, queuedBehind: undefined }, reply]) === 'q1,q2,a1')
  check('queuedBehindNow names the run in flight, and nothing when idle', queuedBehindNow({ running: true, runId: 'run_1' }) === 'run_1' && queuedBehindNow({ running: false, runId: 'run_1' }) === undefined)
  // N messages: all sent behind run_1, all placed after its reply, in the order they were sent.
  const many = Array.from({ length: 5 }, (_, i): Message => ({ id: `n${i}`, agentId: 'ag', ts: `2026-09-08T22:5${i}:30.000Z`, role: 'user', text: `q${i}`, queuedBehind: 'run_1' }))
  check('N queued messages all land after the run they waited behind, in send order', ids([q1, ...many, reply]) === 'q1,a1,n0,n1,n2,n3,n4')
  // Stamped as queued behind the run in flight → queued, even when its timestamp predates the run's start (the run stamped it itself).
  check('a message the run stamped at its start reads as queued while that run is in flight', isQueuedMessage({ ...q2, queuedBehind: 'run_1' }, { running: true, runStartedAt: '2026-09-08T22:59:00.000Z', status: 'running', runId: 'run_1' }))
  check('and not once a different run is in flight', !isQueuedMessage({ ...q2, queuedBehind: 'run_1' }, { running: true, runStartedAt: '2026-09-08T23:10:00.000Z', status: 'running', runId: 'run_2' }))
}

// ------------------------------------------------- 2. the vendor lets go
const timed = async <T,>(p: Promise<T>, ms: number): Promise<{ value?: T; timedOut: boolean; ms: number }> => {
  const t0 = Date.now()
  const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))
  const v = await Promise.race([p, timer])
  return v === 'timeout' ? { timedOut: true, ms: Date.now() - t0 } : { value: v as T, timedOut: false, ms: Date.now() - t0 }
}

{
  // A source that never yields: the abort alone must end the loop.
  const never: AsyncIterable<number> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
  const ac = new AbortController()
  const loop = (async (): Promise<string> => {
    try {
      for await (const _ of untilAborted(never, ac.signal)) void _
      return 'ended'
    } catch (err) {
      return (err as Error).message
    }
  })()
  setTimeout(() => ac.abort(), 150)
  const r = await timed(loop, 2_000)
  check('untilAborted leaves a stream that never yields, within a beat of the abort', !r.timedOut && r.value === STREAM_ABORTED_MSG, `${r.ms} ms`)
}
{
  // Through the whole vendor: one text delta, then a stream that hangs — as
  // the SDK can for minutes. The run signal fires; the vendor
  // must return promptly, keep the text, and report the abort as its error.
  async function* hung(): AsyncGenerator<unknown> {
    yield { type: 'response.output_text.delta', delta: 'Passing on the approved AMD buy' }
    await new Promise(() => undefined)
  }
  const fakeModules = {
    agent: {
      OpenRouter: class {
        callModel(): unknown {
          return { getFullResponsesStream: () => hung(), getUsage: () => new Promise(() => undefined), getResponse: () => new Promise(() => undefined) }
        }
      },
      tool: (t: unknown) => t,
      stepCountIs: () => () => false
    },
    mcp: { createMCPTools: async () => ({ tools: [], close: async () => undefined }) }
  }
  const runner = createOpenRouterRunner({ apiKey: async () => 'k', modules: async () => fakeModules as never })
  const abort = new AbortController()
  const texts: string[] = []
  const req: VendorRunRequest = {
    model: { vendor: 'openrouter', id: 'z-ai/glm-5.3-flash', effort: 'medium' },
    agentId: 'ag_check',
    systemPrompt: 's',
    prompt: 'p',
    tools: [],
    host: {} as ToolHost,
    remote: [],
    gate: { allow: () => true, permits: () => true },
    maxTurns: 5,
    resumeSessionId: null,
    cwd: process.cwd(),
    abort,
    emit: (d) => {
      if (d.kind === 'text') texts.push(d.text)
    },
    log: () => undefined
  }
  const run = runner.run(req)
  setTimeout(() => abort.abort(), 300)
  const r = await timed(run, 3_000)
  check('the OpenRouter vendor returns within a beat of the run’s abort even when the SDK stream never ends', !r.timedOut && r.ms < 1_500, `${r.ms} ms`)
  check('it keeps the text the model had streamed', r.value?.texts.join('') === 'Passing on the approved AMD buy')
  check('and reports the abort as its error (runOnce names the real cause)', r.value?.error === STREAM_ABORTED_MSG, r.value?.error)
  check('the thread saw the text before the cut', texts.join('') === 'Passing on the approved AMD buy')
}

// ---------------------------------------------------- 3. runOnce pins
const runOnce = read('src/core/runner/runOnce.ts')
check('runOnce stamps runStartedAt from the run’s entry instant, and the run id', /running: true, runStartedAt: startedAt\.toISOString\(\), runId,/.test(runOnce))
check('the deadline and the operator’s Stop both close the run to tool work', (runOnce.match(/runEnded = true\n\s+outer\.abort\(\)/g) ?? []).length === 2)
check('and so does the model loop ending', /req\.abort\?\.removeEventListener\('abort', onAbort\)\n\s+runEnded = true/.test(runOnce))
check('the gate refuses a call that arrives after the run ended', /vet: \(name, input\) => \(runEnded \? Promise\.resolve\(\{ ok: false as const, message: RUN_OVER_MSG \}\)/.test(runOnce))
check('the host refuses too — second lock on the same door', /if \(runEnded\) return Promise\.reject\(new Error\(RUN_OVER_MSG\)\)/.test(runOnce))
check('the emitter goes quiet after the run ended (no ghost bubbles)', /if \(runEnded && delta\.kind !== 'end'\) return/.test(runOnce))
check('a killed attempt’s stragglers are dropped', /if \(attempt\.signal\.aborted\) return\n\s+\/\/ Only what the model WROTE/.test(runOnce) || /if \(attempt\.signal\.aborted\) return/.test(runOnce))
check('calls the model asked for that never ran are marked failed', /const unfinished = result\.toolCalls\.filter\(\(t\) => t\.output === undefined && !t\.blocked\)/.test(runOnce) && /t\.error = true/.test(runOnce))
check('the failure note names them', /never ran\./.test(runOnce) && /\$\{notRunNote\}/.test(runOnce))
check('a stopped run posts the Stop note', /else if \(cancelled\) \{[\s\S]{0,400}LIFECYCLE\.runStopped\(Boolean\(finalText\)\)/.test(runOnce))
check('"Run finished with no reply." only when there was NO reply', /else if \(!finalText && !pendingReport && result\.toolCalls\.length === 0\)/.test(runOnce))

const vendor = read('src/core/runner/vendors/openrouter.ts')
check('the vendor reads the SDK stream through untilAborted', /for await \(const ev of untilAborted\(result\.getFullResponsesStream\(\), req\.abort\.signal\)\)/.test(vendor))
check('and never waits on getUsage/getResponse after walking away', /if \(cut\) throw new Error\(STREAM_ABORTED_MSG\)/.test(vendor))

// ---------------------------------------------------- 4. the desktop
const engine = read('src/main/engine/Engine.ts')
const store = read('src/renderer/src/store/appStore.ts')
check('the desktop keeps a failed message on screen, marked, with a retry', /msgStatus: \{ \.\.\.s\.msgStatus, \[optimistic\.id\]: 'failed' \}/.test(store) && /async resend\(agentId, messageId\)/.test(store))
check('the desktop draws the bubble BEFORE the engine answers', /msgStatus: \{ \.\.\.s\.msgStatus, \[optimistic\.id\]: 'sending' \}/.test(store))
const thread = read('src/renderer/src/components/thread/ThreadView.tsx')
check('queued messages are drawn after the live bubble with the way out beside them', /tail\.map\(\(m\) => \(/.test(thread) && /QUEUE_COPY\.sendNow/.test(thread) && thread.indexOf('{live && (') < thread.indexOf('tail.length > 0 && ('))
check('the composer stays open mid-run and says the message will wait', /placeholder=\{working \? QUEUE_COPY\.placeholder\(config\.name\) : undefined\}/.test(thread))
const item = read('src/renderer/src/components/thread/MessageItem.tsx')
check('a user bubble knows sending / failed / queued', /status\?: 'sending' \| 'failed' \| 'queued'/.test(item) && /bubble-queued/.test(item) && /bubble-failed/.test(item))
check('a message sent mid-run records the run it waited behind, from the live stream first (the row’s running flag lags it)', /this\.inFlight\.get\(id\) \?\? /.test(engine) && /if \(e\.delta\.kind === 'start'\) this\.inFlight\.set\(e\.agentId, e\.runId\)/.test(engine))
check('and the desktop runs one queued reply per run too', /const q = this\.queue\.shift\(\)!/.test(engine) && !/this\.queue\[0\]\?\.trigger === 'reply'/.test(engine))
check('the thread treats a streaming bubble as a run in flight', /const working = running \|\| streaming/.test(thread) && /isQueuedMessage\(m, byStream\)/.test(thread))
check('sending to an idle agent opens its bubble at once', /const placeholder = !get\(\)\.live\[agentId\] && !get\(\)\.agents\[agentId\]\?\.state\.running/.test(store))
check('the thread orders through orderThread', /orderThread\(messages \?\? \[\]\)/.test(thread))
check('Engine.stop aborts the run in flight', /async stop\(id: string\): Promise<void> \{\s+this\.runners\.get\(id\)\?\.stop\(\)/.test(engine))


console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exitCode = failures ? 1 : 0
