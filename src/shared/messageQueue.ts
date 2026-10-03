import type { AgentState, Message } from './agents'

/**
 * Messages sent to an agent that is already mid-run.
 *
 * The engine has always accepted them — it queues a `reply` run behind the
 * one in flight — but nothing SAID so. The operator's words sat under a live
 * bubble that was answering something else, and a send that failed dropped
 * the text on the floor (a
 * "Gateway Timeout" on the insert, the composer already cleared, no trace of
 * the message anywhere).
 *
 * "Queued" is DERIVED, never stored: a user message stamped after the current
 * run began, while that run is still going. When the run ends the reply run
 * starts and its own `runStartedAt` is later than the message, so the message
 * stops being queued exactly when something is answering it. No flag to
 * clear, nothing to go stale after a crash.
 *
 * Pure and Node-free.
 */
export function isQueuedMessage(m: Pick<Message, 'role' | 'ts'> & { queuedBehind?: string }, state: Pick<AgentState, 'running' | 'runStartedAt' | 'status'> & { runId?: string | null }): boolean {
  if (m.role !== 'user' || !state.running || state.status === 'retired') return false
  // Stamped by whoever knew (the sender, or the run itself at its start): the
  // message waits behind the run that is in flight right now.
  if (m.queuedBehind && state.runId && m.queuedBehind === state.runId) return true
  if (!state.runStartedAt) return false
  const started = Date.parse(state.runStartedAt)
  const sent = Date.parse(m.ts)
  return Number.isFinite(started) && Number.isFinite(sent) && sent > started
}

/** What a message sent right now would wait behind: the run in flight, or nothing. */
export const queuedBehindNow = (state: Pick<AgentState, 'running' | 'runId'>): string | undefined => (state.running && state.runId ? state.runId : undefined)

/**
 * Thread order, with each queued message placed AFTER the run it waited behind.
 *
 * By timestamp alone a message sent at 6:58 during a run that replied at 7:03
 * sorts above that reply — and the reply was answering the message before it,
 * so the operator's second question reads as already answered. The message
 * moves to just after the last message carrying `queuedBehind`'s run id; a
 * run that left no message in the loaded window (or none at all) leaves the
 * message in timestamp order. Pure; the thread calls it before grouping.
 */
export function orderThread(messages: readonly Message[]): Message[] {
  const moved = new Set<string>()
  const lastOfRun = new Map<string, number>()
  messages.forEach((m, i) => {
    if (m.runId) lastOfRun.set(m.runId, i)
  })
  const out: Message[] = []
  const after = new Map<number, Message[]>()
  messages.forEach((m, i) => {
    if (m.role !== 'user' || !m.queuedBehind) return
    const at = lastOfRun.get(m.queuedBehind)
    if (at === undefined || at < i) return
    moved.add(m.id)
    const list = after.get(at) ?? []
    list.push(m)
    after.set(at, list)
  })
  if (!moved.size) return [...messages]
  messages.forEach((m, i) => {
    if (!moved.has(m.id)) out.push(m)
    const tail = after.get(i)
    if (tail) out.push(...tail)
  })
  return out
}

/** Every queued message in a thread, oldest first. */
export const queuedMessages = (messages: readonly Message[], state: Pick<AgentState, 'running' | 'runStartedAt' | 'status'>): Message[] => messages.filter((m) => isQueuedMessage(m, state))

/** The sentences used around the queue, so every surface says the same thing. */
export const QUEUE_COPY = {
  /** Above the queued bubbles while the run is still going. */
  header: (name: string): string => `Queued — sends when ${name} finishes this run`,
  caption: 'Queued',
  sendNow: 'Stop & send now',
  stopping: 'Stopping…',
  /** The composer while a run is in flight: typing is welcome, the message just waits its turn. */
  placeholder: (name: string): string => `Message ${name}… it sends when this run finishes`,
  sendTitle: 'Queue this message — it goes out the moment the current run finishes',
  notSent: 'Not sent',
  retry: 'Try again',
  discard: 'Discard',
  sending: 'Sending…'
} as const
