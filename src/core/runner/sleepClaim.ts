/**
 * A report that SAYS the agent will sleep, from an agent that did not call
 * `sleep_until`, is two stories at once — and the thread showed both.
 *
 * The shape of it: an agent buys ahead of a report and files
 * `next: "Sleep to Wed 9:35 ET: sell at the open…"` — with no `sleep_until`
 * among its tool calls. The card reads "Sleep to Wed"; the header, reading the
 * schedule, reads "Next run in 17h 45m". The header is right — `report.next`
 * is prose nothing reads back — and the agent wakes on schedule to say "still
 * holding", paid runs whose only job is to not act.
 *
 * Two seams, both in `runOnce`, no vendor branching:
 *  - the `report` handler answers a sleep claim with no sleep armed by telling
 *    the model, in the tool result it reads in the same turn, that only
 *    `sleep_until` parks it and what its schedule will otherwise do;
 *  - the settle pass, when the claim is still standing and `sleep_until` was
 *    never called this run, posts one schedule note under the reply so the
 *    thread states which of the two the engine will actually do.
 *
 * The predicate is deliberately dumb — a word match on the report's own
 * fields — because the false positive costs one sentence and the false
 * negative is the confusion above.
 */
import type { AgentReport } from '@shared/agents'
import { formatEt } from '@shared/marketTime'

const SLEEP_WORDS = /\b(sleep|sleeps|sleeping|asleep)\b/i

/** Whether the report's own words promise a sleep (next / headline / details). */
export function reportClaimsSleep(r: Pick<AgentReport, 'next' | 'headline' | 'details'> | null | undefined): boolean {
  if (!r) return false
  return [r.next, r.headline, r.details].some((s) => typeof s === 'string' && SLEEP_WORDS.test(s))
}

/** Appended to the `report` tool's result when the report claims a sleep no `sleep_until` has armed. */
export function sleepClaimAdvice(nextScheduled: Date | null): string {
  const otherwise = nextScheduled ? `your schedule wakes you ${formatEt(nextScheduled, true)}` : 'your schedule decides your next wake-up'
  return `NOTE: your report says you will sleep, but writing that does nothing — only \`sleep_until\` parks you. If you have not called it this run, call it now with the wake time you named (${otherwise} otherwise). If you meant to keep your schedule, file the report again without the sleep claim.`
}

/** The thread note when the run ended with the claim standing and no sleep set. */
export function sleepClaimNote(nextScheduled: Date | null): string {
  const next = nextScheduled ? `next run is ${formatEt(nextScheduled, true)} as scheduled` : 'schedule is unchanged'
  return `⚠️ The report said it would sleep, but the agent never called sleep_until — no sleep is set and its ${next}. It was told so; if it should wait, ask it to sleep until the date it named.`
}
