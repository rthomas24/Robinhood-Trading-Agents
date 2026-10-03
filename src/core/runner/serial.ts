/**
 * One writer at a time for a run's `state`.
 *
 * `runOnce` owns a single mutable `state`, and every tool handler follows the
 * same shape: snapshot it, await something (a quote, a DB write), then assign
 * the result back. That is safe exactly as long as no two handlers are in
 * flight at once — and the OpenRouter agent SDK executes a turn's tool calls
 * CONCURRENTLY, so a model that asks for six buys in one turn gets six handlers
 * racing the same base snapshot, and the last assignment wins.
 *
 * Unserialized, that silently drops fills: every multi-fill turn keeps only
 * its LAST fill, positions "vanish" while their trade cards say filled, and an
 * agent can rebuild the same positions again and again. The thread looks right
 * (cards render from the fill, not from state) while the book quietly loses
 * the money. `check-parallel-fills.ts` reproduces the race.
 *
 * The lane serializes anything that reads or writes `state`: each wrapped call
 * starts only after the previous one settled, errors do not break the chain,
 * and callers still get their own call's result (or rejection). Tool calls are
 * seconds at most and their semantics were always sequential — a book has no
 * meaningful "parallel" application of fills — so the cost is latency the
 * model cannot observe.
 *
 * Deadlock rule: code running INSIDE the lane must never await the lane again.
 * Handlers call the underlying helpers (`patch`, `saveState`, `executeTrade`)
 * directly, never each other's wrapped forms.
 */
export function exclusiveLane(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    // `fn` runs whether the predecessor resolved or rejected — one failed tool
    // call must not dam every call behind it.
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
