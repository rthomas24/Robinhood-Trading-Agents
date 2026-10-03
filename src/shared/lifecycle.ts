import { money, type Mode } from './agents'
import { formatEt } from './marketTime'
import { PROVIDER_LABEL, type Provider } from './provider'

/** The thread note for `sleep_until`: the wake instant in ET (the operator's clock, never the host's) and the agent's reason. */
export const sleepNote = (until: string, reason: string): string => `💤 Sleeping until ${formatEt(until, true)} — ${reason}. Messages and price watches still wake it.`

/**
 * The system notes posted into a thread for lifecycle events — one place, so
 * the engine and the UI write identical text.
 */
export const LIFECYCLE = {
  created: (mode: Mode): string => `Agent created · ${mode.toUpperCase()}.`,
  /** A LIVE agent is created disarmed; the sheet never said so, and the agent's first scheduled run could be twelve hours away. */
  createdLiveUnarmed: 'Live, but not armed yet: it can research, plan and set exits, but no real order goes out until you arm live trading in Agent settings.',
  paused: 'Paused.',
  resumed: 'Resumed.',
  /** The operator pressed Stop mid-run. Posted by the engine (runOnce) so a stopped run leaves a mark in the thread. */
  runStopped: (hadReply: boolean): string => `⏹ Stopped${hadReply ? ' — the reply above is where it got to' : ''}.`,
  scheduleUpdated: 'Schedule updated.',
  /** An agent the operator left unnamed picked its own name on its first run. */
  namedItself: (name: string): string => `This agent named itself “${name}”.`,
  modeSwitched: (mode: Mode): string => `Switched to ${mode.toUpperCase()} mode.`,
  /** The agent now thinks on another service. */
  providerSwitched: (from: Provider, to: Provider): string => `Now running on ${PROVIDER_LABEL[to]} (was ${PROVIDER_LABEL[from]}).`,
  approvalAnswered: (summary: string, approved: boolean): string =>
    approved ? `✅ Approved: ${summary} — the agent is looking at it again with current prices before it acts.` : `🚫 Declined: ${summary}`,
  autonomyChanged: (on: boolean): string =>
    on ? '🔓 Fully autonomous — it places orders on its own from here.' : '🔒 Approval required — it will ask before anything that moves money.',
  /** What a confirmed plan card says in the thread — adding a task reads as its own event, not a schedule tweak. */
  planConfirmed: (plan: { addTask?: string; summary: string }): string => (plan.addTask ? `✅ New task added: ${plan.addTask}` : `Plan applied: ${plan.summary}`),
  armed: '⚠️ LIVE trading armed — real orders will be placed.',
  disarmed: 'Live trading disarmed.',
  paperReset: (allocationUsd: number): string => `Paper ledger reset to ${money(allocationUsd, 0)}.`,
  retired: (reason: string, note?: string): string => `🏁 Retired: ${reason}.${note ? ` ${note}` : ''}`,
  /** A standing task was retired — the agent stops working on it. */
  taskRemoved: (text: string): string => `Stopped working on: ${text}`,
  /** A spun-off agent was confirmed and created. */
  spawned: (name: string): string => `🐣 Created a new agent for this: ${name}. It works on that from now on; this thread keeps its own tasks.`,
  /** The parent's thread, so the trail from proposal to agent is readable. */
  spawnedFrom: (parent: string): string => `Created by ${parent} — split off so each agent stays focused on one kind of work.`,
  /** `sleep_until` parked the agent until a dated event; its schedule is untouched and resumes afterwards. */
  sleeping: sleepNote,
  /** The sleep's moment arrived (or a run found it already past) — the agent is on its normal schedule again. */
  awake: (reason: string): string => `⏰ Awake — ${reason}. Back on the normal schedule.`,
  /** The agent cancelled its own sleep before the moment came. */
  sleepCancelled: (reason: string): string => `⏰ Back on schedule — sleep cancelled (was waiting for: ${reason}).`,
  respawned: 'Respawned — same agent, same mission. I\'m running now to bring my plan up to date for today, and I\'ll post exactly what I changed. Message me if you want a different goal instead.'
} as const
