/**
 * The depth gauge's label layout (`src/renderer/src/lib/gaugeLayout.ts`).
 *
 * The portfolio panel drew "invalid", "trail 5%" and "stop" on top of one
 * another whenever a plan's levels sat within a dollar — which is what a tight
 * plan looks like, so the gauge was unreadable exactly where it mattered.
 * Labels now take separate rows; this pins that no two labels on a row ever
 * overlap, that spread-out labels stay on one row, that a label at the edge is
 * kept on the track, and that the row count is bounded.
 *
 * Run: `npm run check -- gauge-layout`
 */
import { LABEL_GAP, MAX_ROWS, labelsOverlap, layoutGaugeLabels } from '../../src/renderer/src/lib/gaugeLayout'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const CH = 6.4
const label = (x: number, text: string): { x: number; width: number } => ({ x, width: text.length * CH })
const W = 280

// A crowded gauge: invalid, trail 5% and stop within a few px, cost and target far away.
const mstr = [label(30, 'invalid'), label(52, 'trail 5%'), label(62, 'stop'), label(140, 'cost'), label(263, 'target')]
const p1 = layoutGaugeLabels(mstr, W)
check('MSTR: no two labels overlap', !labelsOverlap(mstr, p1), JSON.stringify(p1))
check('MSTR: the cluster spreads over rows, the far labels stay on row 0', p1[3].row === 0 && p1[4].row === 0 && new Set([p1[0].row, p1[1].row, p1[2].row]).size === 3)
check('MSTR: every label stays centred on its tick', p1.every((p, i) => p.cx === mstr[i].x || (i === 4 && p.cx < mstr[i].x)))

// Spread-out levels: one row, nothing moved.
const wide = [label(20, 'stop'), label(120, 'cost'), label(240, 'target')]
const p2 = layoutGaugeLabels(wide, W)
check('spread-out labels all sit on row 0', p2.every((p) => p.row === 0))
check('…and none of them moves', p2.every((p, i) => p.cx === wide[i].x))

// A label at the extreme is kept inside the track.
const edge = [label(2, 'invalid'), label(279, 'target')]
const p3 = layoutGaugeLabels(edge, W)
check('left-edge label is pulled onto the track', p3[0].cx - edge[0].width / 2 >= 0, String(p3[0].cx))
check('right-edge label is pulled onto the track', p3[1].cx + edge[1].width / 2 <= W, String(p3[1].cx))

// Same price twice (stop == invalidation): still separated.
const same = [label(100, 'stop'), label(100, 'invalid')]
const p4 = layoutGaugeLabels(same, W)
check('two labels at one price take two rows', p4[0].row !== p4[1].row && !labelsOverlap(same, p4))

// More clustered labels than rows: rows are bounded and the overflow shifts sideways, never overlaps.
const many = ['cost', 'stop', 'trail 2%', 'invalid', 'target'].map((t) => label(140, t))
const p5 = layoutGaugeLabels(many, W)
check(`row count is bounded at ${MAX_ROWS}`, p5.every((p) => p.row < MAX_ROWS))
check('the overflow is shifted, not overlapped', !labelsOverlap(many, p5), JSON.stringify(p5))
check('a shifted label clears its neighbour by the gap', p5.some((p, i) => p.cx > many[i].x + LABEL_GAP))

// Order in = order out, whatever the x order.
const shuffled = [label(200, 'target'), label(20, 'stop'), label(110, 'cost')]
const p6 = layoutGaugeLabels(shuffled, W)
check('results are returned in input order', p6[0].cx === 200 && p6[1].cx === 20 && p6[2].cx === 110)

// Unmeasured (0-width) track: still lays out, still no overlap.
const p7 = layoutGaugeLabels(mstr, 0)
check('a zero-width track still separates the cluster', !labelsOverlap(mstr, p7))

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
