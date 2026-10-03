# Design system

The product is a set of colleagues who each keep a book. The interface should
read like correspondence with them, and like a statement of what they did with
the money. Everything below is implemented in `src/renderer/src/index.css` and
`src/renderer/src/components/common/Primitives.tsx`; this document is the rule
set those two files encode.

## The six rules

1. **Elevation has two regimes and they never mix.** On the page, depth is a
   tinted surface plus a hairline (`.card`, `.card-quiet`, `.panel`, `.inset`).
   Above the page — menu, popover, sheet, dialog, palette — depth is a stacked
   shadow plus an inset ring (`.card-float`). A card never needs a shadow to
   exist; a popover never relies on a border alone.
2. **Colour is rationed to meaning.** The chrome is achromatic. The accent means
   "the action here". Green and red mean **money and nothing else**. Brass
   (`--color-live`) marks real money; red outside a loss figure means only
   *armed* (`--color-armed`) or *halted*. A colour spent on decoration is a
   colour that can no longer tell the truth.
3. **Hierarchy is weight and tone, not size.** 400 body · 500 labels, buttons and
   selected rows · 600 headings. Nothing heavier. Emphasise by muting the
   neighbours, never by bolding the subject.
4. **Numbers are first-class typography.** Every numeral is tabular, every P&L
   carries a sign, money is right-aligned in tables, figures never change width
   as they change value. Use `Money` / `Amount` / `.money` / `.nums` / `.mono`.
5. **Everything derives from 18 seed tokens.** `shared/themes.ts` gives a palette
   18 colours. Every surface, hairline, tint and state is `color-mix`ed from
   those, so all 18 catalogue themes get the same elevation steps and hairline
   visibility without hand-tuning. **Never hard-code a hex in a component.**
6. **Motion is fast, ease-out, transform/opacity only, interruptible.** ≤200 ms
   for anything immediate, 300 ms ceiling for surfaces, and absent from
   high-frequency actions. Delight scales inversely with frequency: a fill
   animates, a sidebar row does not.

## Tokens

| Group | Names |
| --- | --- |
| Surfaces | `--color-bg` `--color-rail` `--color-surface` `--color-surface-2` `--color-surface-3` |
| Lines | `--color-hairline` (9 %) · `--color-hairline-strong` (15 %) · `--color-line-faint` (5 %) |
| Text | `--color-text` · `--color-text-2` (muted) · `--color-text-3` (faint) |
| Money | `--color-up` `--color-down` `--color-warn` |
| Identity | `--color-live` (brass) `--color-paper` (graphite) `--color-local` `--color-armed` (red) |
| Tints | `--tint-accent` `--tint-up` `--tint-down` `--tint-warn` `--tint-live` `--tint-paper` `--tint-local` `--tint-armed` |
| Elevation | `--shadow-1` `--shadow-2` `--shadow-float` `--shadow-sheet` `--sel` `--ring-soft` |
| Type | `text-2xs` 10.5 · `text-xs` 11.5 · `text-sm` 12.5 · `text-base` 13 · `text-md` 13.75 · `text-lg` 15 · `text-xl` 17 · `text-2xl` 22 |
| Radii | `rounded-xs` 5 · `rounded-sm` 7 · `rounded-md` 9 · `rounded-lg` 12 · `rounded-xl` 15 |
| Motion | `--dur-fast` 120 · `--dur` 200 · `--dur-slow` 280 · `--ease-out` · `--ease-drawer` |
| Chrome | `--h-header` 48 · `--h-status` 28 · `--h-row` 34 · `--w-thread` 760 |

Eight type steps replace the thirteen ad-hoc sizes the old renderer used. Use
the named utility (`text-sm`), never `text-[12.5px]`.

## Class vocabulary

**Surfaces** `.panel` `.card` `.card-quiet` `.card-float`
`.inset` `.hair-t` `.hair-b` `.hair-r` `.hair-l` `.divide-hair`

**Controls** `.btn` (+ `-primary` `-accent` `-ghost` `-outline` `-danger`
`-danger-solid` `-sm` `-lg`) `.btn-icon` `.input` `.textarea` `.select`
`.label` `.hint` `.eyebrow` `.seg` `.seg-item` `.kbd` `.menu-item` `.menu-sep`

**Identity** `.pill` (+ `-live` `-armed` `-paper` `-local` `-accent` `-warn`
`-up` `-down`) `.chip` `.ticker` `.ticker-sym` `.ticker-px`

**Money** `.money` `.money-up` `.money-down` `.hero-num` `.leader` `.stat`
`.stat-label` `.stat-value` `.stat-sub` `.meter` `.hatched`

**Thread** `.bubble-user` (+ `.bubble-queued` `.bubble-failed`) `.memo`
`.memo-head` `.memo-body` `.book-line` `.msg-card[data-pending]` `.msg-enter`
`.run-group` `.run-head` `.run-dot` `.bell` `.day-rule` `.queue-head`
`.composer-field` `.send-btn` `.receipt` `.receipt-band` `.receipt-fig`
`.stamp` `.fold` `.shimmer-text`

**Tools** `.tool-activity` `.tool-activity-head` `.tool-activity-body`
`.tool-row` `.tool-row-head` `.tool-kind` `.tool-detail` `.tool-pane`
`.tool-pre` `.tool-copy` `.tool-kv` `.tool-kv-key` `.tool-kv-val`
`.tool-nested` `.tool-table`

**Layers** `.sheet-backdrop` `.sheet-panel` `.pop-in` `.animate-in` `.fade-in`
`.palette` `.palette-input` `.palette-row`

**Tables** `.tbl` (+ `th`, `td`, `.num` for right-aligned figures)

`data-` attributes carry state so CSS holds the styling: `data-on="true"`
(selected row, active segment, toggled icon button), `data-pending="true"` (a
card waiting on the operator), `data-level="warn|over"` (meter), `data-fresh`
(a receipt band that should draw itself once).

## Primitives

`components/common/Primitives.tsx` — `Money`, `Amount`, `TickerChip`,
`StatTile`, `HeroFigure`, `Meter`, `DepthGauge`, `Sparkline`, `Stamp`,
`EmptyState`, `SectionHead`, `LedgerLine`. All pure presentation: they read no
store, call no bridge, and format nothing themselves.

## Signature patterns

- **Memos, not bubbles.** Only the operator gets a bubble. An agent's turn is a
  memo — a ruled header (name, trigger, ET time, duration), prose, and, when it
  moved money, a **book line** footer set like a bank statement.
- **The ticker chip is the atomic unit.** The same chip in a sidebar preview, a
  tool row, a trade receipt and the portfolio panel.
- **Receipts.** A fill is a settled fact, not a chat message: a slip with a side
  band in ink, dotted leaders, mono figures and an ET stamp. The band draws
  itself once on arrival — the app's one signature motion, a handful of times a
  day.
- **Session bells.** 09:30 open, 15:50 "exits judged on tomorrow's print",
  16:00 close appear in the transcript as `.bell` rules, so the trading day is
  visible structure.
- **Depth gauge.** Every armed exit as a tick on one price line, coloured by
  role, never by direction. Ticks may crowd (a tight plan is three levels a
  dollar apart); labels never do — `lib/gaugeLayout.ts` takes colliding labels
  to further rows and each tick reaches down to its own word.
- **One red in the chrome.** Armed live and the account halt. Because red is
  rationed this strictly, it is unmissable without ever shouting.
- **Calm mode.** `data-calm="1"` on `<html>` drains P&L colour from the whole
  app — but never from a safety signal: armed pennants, halts and pending
  approvals are exempt by rule.

## What not to do

No gradients, glows, mesh or noise on anything carrying a number. No uppercase
micro-labels as the main hierarchy tool (`.eyebrow` is for column heads only).
No shadows on structural chrome. No colour on a decorative element. No
`text-[13px]`-style arbitrary sizes. No hex literals. No new dependency for a
chart — the app draws its own SVG.
