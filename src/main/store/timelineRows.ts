import { dailyRowsFromRuns, type TimelineRow } from '@shared/timeline'
import { agentStore } from './agentStore'

/**
 * The desktop's read of the portfolio's daily history (`agents:timeline`):
 * the last book per agent per ET day, reduced from the local run log
 * (`dailyRowsFromRuns`), so the chart draws from exactly what the engine
 * recorded.
 */
export async function timelineRows(): Promise<TimelineRow[]> {
  const summaries = agentStore.list()
  const allocation = new Map(summaries.map((s) => [s.config.id, s.config.allocationUsd]))
  const runs = summaries.flatMap((s) => agentStore.bookedRuns(s.config.id))
  return dailyRowsFromRuns(runs, (id) => allocation.get(id) ?? null)
}
