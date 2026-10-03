/**
 * Label placement for the depth gauge — pure, so it can be proven without a
 * DOM (`scripts/checks/check-gauge-layout.ts`).
 *
 * A gauge puts every armed exit on one price line, and a trail, a stop and an
 * invalidation level are routinely within a dollar of each other — that is what
 * a tight plan looks like. Their TICKS may sit on top of one another (a 1px
 * line in each role's colour still reads), but their LABELS may not: three
 * words printed on the same spot are no words at all.
 *
 * The rule: labels are placed left to right, each on the first row where it
 * clears the previous label on that row by `LABEL_GAP`; a label that clears no
 * row opens a new one, up to `MAX_ROWS`; past that it is pushed right of the
 * least-crowded row's last label rather than drawn over it. A label is also
 * kept inside the track, so "target" at the right edge is not cut in half.
 * Ticks extend down to their own label's row, so a label two rows down still
 * visibly belongs to its level.
 */

/** Pixels between two labels sharing a row. */
export const LABEL_GAP = 6
/** How many rows of labels a gauge will grow before it starts shifting labels sideways. */
export const MAX_ROWS = 3

export interface GaugeLabelIn {
  /** Centre of the tick along the track, px. */
  x: number
  /** The label's rendered width, px. */
  width: number
}

export interface GaugeLabelOut {
  /** Where the label is centred, px — the tick's x unless it had to move. */
  cx: number
  /** 0 = directly under the line; each row below is one label-height lower. */
  row: number
}

export function layoutGaugeLabels(labels: readonly GaugeLabelIn[], trackWidth: number, maxRows = MAX_ROWS): GaugeLabelOut[] {
  const order = labels.map((l, i) => ({ ...l, i })).sort((a, b) => a.x - b.x || a.i - b.i)
  const lastRight: number[] = []
  const out: GaugeLabelOut[] = new Array(labels.length)
  for (const l of order) {
    const half = l.width / 2
    // Keep the whole label on the track when the track is wide enough to hold it.
    const cx = trackWidth > l.width ? Math.min(Math.max(l.x, half), trackWidth - half) : l.x
    let row = lastRight.findIndex((right) => cx - half >= right + LABEL_GAP)
    let placedCx = cx
    if (row < 0) {
      if (lastRight.length < Math.max(1, maxRows)) {
        row = lastRight.length
      } else {
        // Every row is taken here: shift right of whichever row ends soonest.
        row = lastRight.indexOf(Math.min(...lastRight))
        placedCx = lastRight[row] + LABEL_GAP + half
      }
    }
    lastRight[row] = placedCx + half
    out[l.i] = { cx: placedCx, row }
  }
  return out
}

/** Whether any two placed labels still overlap — the property the check asserts. */
export function labelsOverlap(labels: readonly GaugeLabelIn[], placed: readonly GaugeLabelOut[]): boolean {
  for (let a = 0; a < placed.length; a++) {
    for (let b = a + 1; b < placed.length; b++) {
      if (placed[a].row !== placed[b].row) continue
      const la = placed[a].cx - labels[a].width / 2
      const ra = placed[a].cx + labels[a].width / 2
      const lb = placed[b].cx - labels[b].width / 2
      const rb = placed[b].cx + labels[b].width / 2
      if (la < rb && lb < ra) return true
    }
  }
  return false
}
