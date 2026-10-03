import { money, type AgentConfig, type AgentState } from './agents'

/**
 * How much of the Robinhood account a NEW (or re-sized) live agent may be
 * given, once the live agents that already exist have taken their share.
 *
 * Every live agent is promised its allocation out of the same account, so the
 * account's buying power is only free to the extent nobody else is already
 * standing on it. What another agent stands on is its UNDEPLOYED cash — the
 * part of its allocation it has not spent yet. The part it has spent is
 * already gone from buying power (the broker took it when the order filled),
 * so counting the whole allocation would take it away twice. With nothing
 * deployed the two are the same number, which is the case the operator sees
 * when they set up a fleet: two $500 agents on an $800 account is $200 the
 * second one can never have.
 *
 * Retired agents hold nothing (their book was flattened or they are
 * respawnable with a flat book), so they claim nothing. Paused agents keep
 * their claim — a paused live agent still owns its positions and its cash.
 *
 * Pure and Node-free; the IPC gate, the New-agent sheet and the Agent
 * settings sheet read this one rule so they can never disagree about the
 * number.
 */

export interface LiveRoom {
  /** The account's buying power the room was measured against. */
  buyingPower: number
  /** Dollars already promised to OTHER live agents (their undeployed cash). */
  claimed: number
  /** How many other live agents hold that claim. */
  claimedBy: number
  /** What is left for this agent's allocation — never negative. */
  available: number
}

type LiveAgentLike = { config: Pick<AgentConfig, 'id' | 'mode' | 'allocationUsd'>; state: Pick<AgentState, 'status' | 'live'> }

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * The room left in `buyingPower` once every OTHER non-retired live agent's
 * undeployed cash is set aside. `exceptAgentId` is the agent being re-sized:
 * its own cash is not a competing claim, so its allocation can go up to the
 * room the others leave.
 */
export function liveRoom(buyingPower: number, agents: Iterable<LiveAgentLike>, opts: { exceptAgentId?: string } = {}): LiveRoom {
  let claimed = 0
  let claimedBy = 0
  for (const a of agents) {
    if (a.config.mode !== 'live' || a.state.status === 'retired' || a.config.id === opts.exceptAgentId) continue
    // A brand-new live agent has not run yet and its ledger may be seeded to
    // its allocation; either way the undeployed slice is what it holds.
    const cash = Math.max(0, a.state.live?.cash ?? a.config.allocationUsd)
    claimed += cash
    claimedBy++
  }
  claimed = round2(claimed)
  return { buyingPower, claimed, claimedBy, available: round2(Math.max(0, buyingPower - claimed)) }
}

export type LiveAllocationVerdict = { ok: true } | { ok: false; reason: string }

/** May this allocation be given, and if not, the sentence that says why and what would fit. */
export function liveAllocationVerdict(room: LiveRoom, allocationUsd: number): LiveAllocationVerdict {
  if (!(allocationUsd > 0)) return { ok: false, reason: 'Set an allocation first.' }
  if (allocationUsd <= room.available + 1e-6) return { ok: true }
  if (room.claimedBy === 0) {
    return { ok: false, reason: `That allocation is more than the ${money(room.buyingPower, 0)} of buying power in your Robinhood account. Lower it to what the account can actually cover.` }
  }
  return {
    ok: false,
    reason: `Only ${money(room.available)} of your ${money(room.buyingPower, 0)} buying power is left to allocate — ${money(room.claimed)} is already held by ${room.claimedBy} other live agent${room.claimedBy === 1 ? '' : 's'}. Lower it to ${money(room.available)} or less, or free some up by reducing or retiring another live agent.`
  }
}

/** One line for the allocation field: what is free, and who holds the rest. */
export function liveRoomLabel(room: LiveRoom): string {
  if (room.claimedBy === 0) return `${money(room.buyingPower)} of buying power, none of it held by another live agent`
  return `${money(room.available)} free of ${money(room.buyingPower)} buying power · ${money(room.claimed)} held by ${room.claimedBy} other live agent${room.claimedBy === 1 ? '' : 's'}`
}
