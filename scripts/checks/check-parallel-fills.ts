/**
 * Parallel tool calls must not eat the book.
 *
 *   npm run check -- parallel-fills
 *
 * The race this pins: every `ToolHost` handler in `runOnce` follows
 * snapshot → await → assign on one shared `state`, and the OpenRouter SDK
 * executes a turn's tool calls CONCURRENTLY. Six buys in one turn mean six
 * handlers racing the same base snapshot; the last assignment wins, in memory
 * and in the store. Every multi-fill turn keeps only its LAST fill, trade cards
 * say "filled" (they render from the fill, not from state), and an agent ends
 * up rebuilding positions that "vanished overnight".
 *
 * `exclusiveLane` (core/runner/serial.ts) is the fix: one writer at a time.
 * This check (1) reproduces the exact race and shows the lane closes it,
 * (2) pins the lane's semantics, and (3) pins — as a source property — that
 * `runOnce` actually routes the host AND the gate through a lane, because the
 * wrapper is one refactor away from being dropped and nothing else would fail.
 *
 * No credentials, no database, no network.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyLedger, type Ledger } from '@shared/agents'
import { applyFill } from '@core/broker/paper'
import { exclusiveLane } from '@core/runner/serial'

let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The handler shape from runOnce, verbatim in miniature: capture the shared
 * state, await (a quote fetch in real use), apply the fill to the CAPTURED
 * copy, assign back.
 */
function makeHarness(): { buy: (symbol: string) => Promise<void>; state: () => { paper: Ledger } } {
  let state = { paper: emptyLedger(10_000) }
  return {
    buy: async (symbol: string) => {
      const snapshot = state
      await sleep(5)
      const r = applyFill(snapshot.paper, { symbol, side: 'buy', qty: 1, price: 100, orderId: 'po_x' })
      state = { ...snapshot, paper: r.ledger }
    },
    state: () => state
  }
}

const SYMBOLS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF']

async function main(): Promise<void> {
  // ── 1. the bug, reproduced — kept as the counter-example ────────────────
  const racy = makeHarness()
  await Promise.all(SYMBOLS.map((s) => racy.buy(s)))
  check(
    'UNSERIALIZED handlers lose fills (the race, reproduced)',
    racy.state().paper.fills.length === 1,
    `6 concurrent buys left ${racy.state().paper.fills.length} fill(s) — last writer wins`
  )
  check('...and the cash only reflects the surviving fill', racy.state().paper.cash === 9_900)

  // ── 2. the lane closes it ───────────────────────────────────────────────
  const safe = makeHarness()
  const lane = exclusiveLane()
  await Promise.all(SYMBOLS.map((s) => lane(() => safe.buy(s))))
  check('the SAME six concurrent buys through the lane all survive', safe.state().paper.fills.length === 6)
  check('cash reflects every fill', safe.state().paper.cash === 10_000 - 600, `$${safe.state().paper.cash}`)
  check('all six positions exist', safe.state().paper.positions.length === 6)

  // ── 3. lane semantics ───────────────────────────────────────────────────
  const order: number[] = []
  const lane2 = exclusiveLane()
  await Promise.all([
    lane2(async () => {
      await sleep(15)
      order.push(1)
    }),
    lane2(async () => {
      order.push(2)
    }),
    lane2(async () => {
      order.push(3)
    })
  ])
  check('calls run strictly in arrival order, however long each takes', order.join(',') === '1,2,3', order.join(','))

  const lane3 = exclusiveLane()
  const first = lane3(async () => {
    throw new Error('boom')
  })
  const second = lane3(async () => 'alive')
  check(
    'a rejected call does not dam the lane',
    (await first.catch((e: Error) => e.message)) === 'boom' && (await second) === 'alive'
  )
  check(
    'each caller gets its own result back',
    (await Promise.all([lane3(async () => 'a'), lane3(async () => 'b')])).join('') === 'ab'
  )

  // ── 4. runOnce actually uses it (source property, CRLF-normalized) ──────
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'runner', 'runOnce.ts'), 'utf8').replace(/\r\n/g, '\n')
  check('runOnce creates the lane', src.includes('const exclusive = exclusiveLane()'))
  check(
    'every host method is wrapped through the lane',
    /Object\.entries\(hostImpl\)\.map\(\[?[\s\S]{0,600}?exclusive\(/.test(src),
    'the ToolHost handed to vendors must be the wrapped one'
  )
  check(
    "the gate's vet rides the same lane",
    /vet: \(name, input\) => [^\n]*exclusive\(\(\) => vetImpl\(name, input\)\)/.test(src)
  )
  check(
    "the gate's afterTool rides the same lane",
    /afterTool: \(name, input, output\) => [^\n]*exclusive\(\(\) => afterToolImpl\(name, input, output\)\)/.test(src)
  )
  check(
    'the racy pattern the lane protects still exists (else this check is stale)',
    src.includes('state = r.state'),
    'handlers still snapshot-await-assign; if that changed, revisit whether the lane is still needed'
  )

  console.log(failed === 0 ? '\nall passed' : `\n${failed} check(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main()
