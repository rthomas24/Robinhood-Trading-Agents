import type { Message } from '@shared/agents'

/**
 * The matching rule behind `search_thread`, pure and host-free.
 *
 * It lives here rather than inside the store because any host must answer the
 * SAME question — the desktop over a JSONL file, another host over its own
 * store — and a rule implemented twice is a rule that diverges. This module is
 * the definition every store is held to.
 *
 * WHAT IT DOES NOT DO: fetch. The corpus is passed in, and that is the whole
 * safety property. `agentStore` holds only the last `MSG_CACHE_MAX` (400)
 * messages hot, so a search that fetched its own corpus could quietly be
 * handed the tail and report "no matches" for anything older — indistinguishable
 * from a genuine miss, on the one feature whose promise is finding what
 * scrolled away. Making the caller supply the messages puts that decision at a
 * call site where it is visible.
 */

/**
 * What a message can be FOUND BY.
 *
 * Not just `text`: a trade card carries its symbol, side and reason in
 * structured fields, so searching `text` alone would make the agent's own
 * order history invisible to the tool built to find it — and "when did I buy
 * MU" is one of the questions this exists to answer.
 */
export function searchableText(m: Message): string {
  const parts: string[] = [(m as { text?: string }).text ?? '']
  const a = (m as { action?: { symbol?: string; side?: string; reason?: string; summary?: string; error?: string } }).action
  if (a) parts.push(a.symbol ?? '', a.side ?? '', a.reason ?? '', a.summary ?? '', a.error ?? '')
  const p = (m as { plan?: { summary?: string } }).plan
  if (p) parts.push(p.summary ?? '')
  return parts.filter(Boolean).join(' ')
}

/**
 * Messages matching EVERY term, oldest-first, at most `limit`.
 *
 * Every term rather than any: an agent searching "avoid biotech" means both
 * words, and an any-match would bury the one real hit under every message
 * containing "avoid". When more match than fit, the NEWEST are kept — recency
 * is the tie-break a person means by "did they ever say…" — but the survivors
 * are returned oldest-first so the agent reads them in the order they happened.
 */
/**
 * How many hits a search may return, whoever asks.
 *
 * Exported because re-deriving it at each call site produces slightly
 * DIFFERENT spellings: only one of them would floor a fractional limit or
 * survive `NaN`.
 */
export const clampSearchLimit = (limit: number): number => Math.min(20, Math.max(1, Math.floor(limit) || 1))

export function searchThreadMessages(all: Message[], query: string, limit: number): Message[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (terms.length === 0) return []
  const cap = clampSearchLimit(limit)
  const hits: Message[] = []
  for (let i = all.length - 1; i >= 0 && hits.length < cap; i--) {
    const hay = searchableText(all[i]).toLowerCase()
    if (terms.every((t) => hay.includes(t))) hits.push(all[i])
  }
  return hits.reverse()
}
