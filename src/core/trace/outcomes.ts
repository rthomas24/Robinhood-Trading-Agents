import type { Fill } from '@shared/agents'

/**
 * Which runs a sell's result belongs to.
 *
 * A sell realizes the P&L of the buys still open in that symbol — the ones
 * since the position was last flat. The run that placed the SELL only chose
 * the exit; the runs that placed those BUYS chose the trade, and that is the
 * decision a trader wants scored. `Fill.runId` (stamped by the engine at the
 * fill) is what makes the attribution possible.
 *
 * Pure. Replays the symbol's fills in order, tracking the open quantity, and
 * returns the run ids of the buys that were open when `sell` landed — plus the
 * sell's own run, so an exit is scored too. Engine sells (stops, targets,
 * sweeps) carry no run id and simply contribute nothing.
 */
export function entryRunsFor(fills: readonly Fill[], sell: Fill): string[] {
  const runs = new Set<string>()
  let open: string[] = []
  let qty = 0
  for (const f of fills) {
    if (f.symbol !== sell.symbol) continue
    if (f.id === sell.id) break
    if (f.side === 'buy') {
      if (qty <= 1e-9) open = []
      qty += f.qty
      if (f.runId) open.push(f.runId)
    } else {
      qty = Math.max(0, qty - f.qty)
      if (qty <= 1e-9) open = []
    }
  }
  for (const r of open) runs.add(r)
  if (sell.runId) runs.add(sell.runId)
  return [...runs]
}

/**
 * The sells that landed since `sinceTs` (exclusive) — what a run should
 * score once it has settled. Engine sells between runs (a stop firing in the
 * sweep) are picked up by the next run this way.
 */
export function sellsSince(fills: readonly Fill[], sinceTs: string | null | undefined): Fill[] {
  return fills.filter((f) => f.side === 'sell' && (!sinceTs || f.ts > sinceTs))
}
