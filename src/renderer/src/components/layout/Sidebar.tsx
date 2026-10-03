import type { DragEvent, JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  Archive,
  Hand,
  ChevronDown,
  ChevronRight,
  Loader2,
  RotateCcw,
  Settings,
  Layers,
  ArrowUp,
  ArrowDown,
  Settings2,
} from "lucide-react";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_RAIL,
  SIDEBAR_SNAP,
  useApp,
  type ModeFilter,
} from "@renderer/store/appStore";
import { Segmented } from "@renderer/components/common/Sheet";
import { cn, countdown, pnlClass, relTime } from "@renderer/lib/format";
import { ASK_LABEL, type Ask, type AskKind } from "@shared/awaiting";
import type { Quote } from "@shared/ipc";
import {
  MAX_ACTIVE_AGENTS,
  agentSlotBlocked,
  bookPnl,
  countActiveAgents,
  countByMode,
  ledgerFor,
  type AgentColor,
  type AgentSummary,
} from "@shared/agents";
import { agentsInGroup, groupOf, orderAgents, pruneLayout } from "@shared/agentLayout";
import { ContextMenu, type MenuItem } from "@renderer/components/common/ContextMenu";
import { etClock } from "@shared/marketTime";
import { activeSleep, sleepStatusText } from "@shared/sleep";
import { AgentAvatar, COLORS } from "@renderer/components/common/AgentAvatar";
import { isLocalVendor } from "@renderer/lib/vendor";
import {
  PROVIDER_HINT,
  PROVIDER_LABEL,
  providerOf,
} from "@shared/provider";
import { ProviderBadge } from "@renderer/components/common/ProviderPicker";
import { EmptyState, Meter, Money, TickerChip } from "@renderer/components/common/Primitives";

/**
 * An agent stopped on an unanswered request. It reads as more urgent than the
 * last thing it said, because it IS: nothing else happens until it is answered.
 */
// Was `state.pendingAction` only, so a proposed PLAN or an open QUESTION —
// both of which also stop and wait — showed nothing here at all. It now reads
// the same `asks` list the docked bar does, so the row badge and the bar can
// never disagree about which agents are blocked.
/**
 * One word for the pill beside the name. `ASK_LABEL` is a sentence — "Asked you
 * a question" — which is right in a tooltip and in the docked bar, and would
 * push the agent's name off its own row here. The sentence is still the title.
 */
const ASK_SHORT: Record<AskKind, string> = {
  approval: "Approve",
  question: "Question",
  plan: "Plan",
};

const waitingOn = (asks: Ask[], agentId: string): Ask | null =>
  asks.find((k) => k.agentId === agentId) ?? null;

const MARKS_POLL_MS = 30_000;
/**
 * How often the berths re-age. Countdowns and relative times are read off one
 * clock held here rather than recomputed per row from `Date.now()`, so the
 * whole list agrees with itself and a "2m" never sits beside a "1m" that was
 * rendered a keystroke later.
 */
const CLOCK_MS = 30_000;
/** Section key for agents in no group — never a group id (those start with `g_`). */
const UNGROUPED_KEY = "__ungrouped";
const etDateOf = (iso: string): string => etClock(new Date(iso)).date;
const pct = (x: number): string =>
  `${x > 0 ? "+" : x < 0 ? "−" : ""}${(Math.abs(x) * 100).toFixed(Math.abs(x) >= 0.1 ? 1 : 2)}%`;

/**
 * The symbol a preview line is ABOUT — taken from the agent's own book, never
 * guessed out of the text. A "three to five capitals" regex matches SELL, BUY,
 * OPEN and ETF as readily as NVDA, and a ticker chip that is sometimes a verb
 * is worse than no chip at all. Only a symbol this agent holds, watches or has
 * an exit armed on can win, so the chip is always a fact about that agent.
 */
function previewSymbol(a: AgentSummary, preview: string): string | null {
  if (!preview) return null;
  const own = new Set<string>();
  for (const p of ledgerFor(a.config, a.state).positions) own.add(p.symbol);
  for (const w of a.state.watches ?? []) own.add(w.symbol);
  for (const s of Object.keys(a.state.exits ?? {})) own.add(s);
  if (own.size === 0) return null;
  const upper = preview.toUpperCase();
  for (const sym of own) {
    const i = upper.indexOf(sym);
    if (i === -1) continue;
    // Word boundary by hand: "MU" must not match inside "MUCH".
    const before = i === 0 ? "" : upper[i - 1];
    const after = upper[i + sym.length] ?? "";
    if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return sym;
  }
  return null;
}

/**
 * What this agent's own book is worth, at the right end of line 2. TWO figures,
 * because they answer different questions and neither stands in for the other:
 * the OVERALL standing since the agent started, as a percentage of what it was
 * given, and TODAY's move in dollars. Demoting the overall figure to a tooltip
 * hid the only number on the row that says whether an agent has made money at
 * all — "+$4 today" reads like a win on a book that is down a fifth.
 */
function BerthPnl({
  a,
  marks,
}: {
  a: AgentSummary;
  marks: Record<string, Quote>;
}): JSX.Element {
  const p = bookPnl(a.config, a.state, marks, etClock().date, etDateOf);
  // An unmarked book is priced at COST, so every percentage is exactly zero by
  // construction — not "flat", just unknown. Rendering 0.00% in green is a
  // confident answer nothing supports. Say which symbol is unpriced instead.
  //
  // The symbol is in the VISIBLE text, not only the title: "no price" alone is
  // a dead end — it says a figure is missing without saying what to go and
  // fetch, and a hover is not available to someone scanning the list.
  if (!p.marked) {
    return (
      <span
        className="shrink-0 text-2xs text-muted"
        title={`No price yet for ${p.unmarked.join(", ")} — this agent's P&L can't be computed until a quote arrives.`}
      >
        no price · {p.unmarked[0]}
        {p.unmarked.length > 1 ? ` +${p.unmarked.length - 1}` : ""}
      </span>
    );
  }
  return (
    <span
      className="shrink-0 flex items-center gap-1"
      title={`Overall ${pct(p.totalPct)} (${p.totalPnl >= 0 ? "+" : "−"}$${Math.abs(p.totalPnl).toFixed(2)}) since it started · today ${pct(p.dayPct)}`}
    >
      {/* Coloured by the DOLLAR result, not the percentage: `pnlClass` carries a
          neutral band in dollars, and 0.004 of a fraction is 0.4 % — a real move
          that would render grey. Both figures then agree on their sign. */}
      <span className={cn("money text-2xs", pnlClass(p.totalPnl))}>{pct(p.totalPct)}</span>
      <span className="text-2xs text-text-3" aria-hidden>
        ·
      </span>
      <Money value={p.dayPnl} className="text-xs" />
    </span>
  );
}

/**
 * The dot answers ONE question — is this agent healthy and working? — and the
 * four colours are the four answers:
 *
 *   ink    working normally: running, scheduled, or idle (alive, nothing due)
 *   amber  YOU stopped it (paused)
 *   red    its last run failed  (`--color-armed`)
 *   grey   finished or put away (done, retired)
 *
 * Healthy is the TEXT colour, not green. Green and red are money and nothing
 * else (design rule 2), and a green dot beside a P&L figure on the same row is
 * exactly the confusion that rationing buys us — a healthy agent that has lost
 * money must not wear the winning colour. Nor is it the accent: the accent means
 * "the action is here", which on this surface belongs to the waiting queue and
 * to the selected thread, and spending it on every healthy berth would leave
 * those with nothing left to say. The red is `--color-armed`, the one red the
 * chrome is allowed, and a failed run is the only thing here that earns it.
 *
 * Ink covers three statuses on purpose. The distinction between "running",
 * "scheduled" and "idle" is real but it is not what someone scanning a sidebar
 * is asking, and rendering it as three colours made a healthy fleet look like
 * three different conditions. Running is told apart by the pulse rather than by
 * a fourth hue, and `statusTitle` keeps the precise state on hover, so
 * collapsing the colours loses nothing a reader can no longer recover.
 *
 * `error` is NOT sticky: `runOnce` recomputes status on every run, so the next
 * successful one clears this by itself — a failed run does not need clearing and
 * there is nothing to reset by hand.
 *
 * Local runs keep `bg-local` while running: that colour is the local vendor's
 * identity across the whole UI (`--color-local`, `.local-glow`), and a run on
 * the operator's own GPU is worth telling apart at a glance.
 */
function statusColor(s: AgentSummary, onLocal = false): string {
  if (s.state.running) return onLocal ? "bg-local pulse" : "bg-text pulse";
  switch (s.state.status) {
    case "error":
      return "bg-armed";
    case "paused":
      return "bg-warn";
    case "retired":
    case "done":
      return "bg-muted/30";
    // scheduled | idle | running — alive and nothing wrong with it.
    default:
      return "bg-text";
  }
}

/** The precise state, on hover — what the four colours deliberately do not distinguish. */
function statusTitle(s: AgentSummary): string {
  if (s.state.running) return "Running now";
  switch (s.state.status) {
    case "error":
      return s.state.lastError
        ? `Last run failed: ${s.state.lastError} — the next successful run clears this.`
        : "Last run failed — the next successful run clears this.";
    case "paused":
      return "Paused — it will not wake until you resume it.";
    case "retired":
      return "Retired.";
    case "done":
      return "Finished — this agent ran once and is done.";
    case "scheduled": {
      const sleep = activeSleep(s.state);
      if (sleep) return `${sleepStatusText(sleep.until)} — ${sleep.reason}. Messages and price watches still wake it.`;
      return s.state.nextRunAt
        ? `Scheduled — next run ${new Date(s.state.nextRunAt).toLocaleString()}.`
        : "Scheduled.";
    }
    default:
      return "Idle — nothing scheduled; run it whenever you like.";
  }
}

/**
 * The right end of line 1: when this berth next comes alive. A countdown is
 * what the operator is actually asking of a scheduled agent, and it outranks
 * "last spoke 3h ago" — which is still here, as the fallback for an agent with
 * nothing on the clock, and in the title either way.
 */
function nextWakeText(a: AgentSummary, now: number): string {
  const sleep = activeSleep(a.state, now);
  if (sleep) return "asleep";
  if (a.state.status === "paused") return "paused";
  if (a.state.nextRunAt) return countdown(a.state.nextRunAt, now);
  return relTime(a.state.lastMessageAt ?? a.config.createdAt, now);
}

/**
 * "Last activity 3m ago" — correct for the relative steps, and wrong for the two
 * answers `relTime` gives that are not durations: the bare word "now" under 45 s
 * ("Last activity now ago"), and a calendar date once the gap passes a day
 * ("Last activity Sep 3 ago"). Both get their own phrasing rather than a blindly
 * appended " ago".
 */
function lastActivityText(iso: string, now: number): string {
  const t = relTime(iso, now);
  if (!t) return "No activity yet";
  if (t === "now") return "Last activity just now";
  return /^\d+[mh]$/.test(t) ? `Last activity ${t} ago` : `Last activity ${t}`;
}

/** Bottom-left entry to the settings page (full row, or icon-only when collapsed). */
function AccountButton({ collapsed }: { collapsed: boolean }): JSX.Element {
  const view = useApp((s) => s.view);
  const openAccount = useApp((s) => s.openAccount);
  const active = view === "account";
  const sub = "Connections, safety, preferences";
  if (collapsed) {
    return (
      <div className="hair-t p-2 flex justify-center no-drag">
        <button
          type="button"
          className="btn-icon h-9 w-9"
          data-on={active ? "true" : undefined}
          title={`Settings · ${sub}`}
          aria-label={`Settings · ${sub}`}
          onClick={() => openAccount()}
        >
          <Settings size={17} strokeWidth={1.8} />
        </button>
      </div>
    );
  }
  return (
    <div className="hair-t p-2 no-drag">
      <button
        type="button"
        onClick={() => openAccount()}
        data-on={active ? "true" : undefined}
        aria-current={active ? "page" : undefined}
        className="row w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
      >
        <span className="inset h-8 w-8 flex items-center justify-center shrink-0 text-muted">
          <Settings size={16} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block text-base truncate", active ? "font-medium" : "font-normal")}>Settings</span>
          <span className="block text-xs text-muted truncate">{sub}</span>
        </span>
      </button>
    </div>
  );
}

/** One section of the list: a layout group, or the agents in none. `groupId` null = ungrouped. */
interface Section {
  key: string;
  groupId: string | null;
  name: string;
  color?: AgentColor;
  agents: AgentSummary[];
}

/** Where a dragged row would land: a section and an index within it. */
interface DropTarget {
  key: string;
  index: number;
}

interface RowMenu {
  agentId: string;
  x: number;
  y: number;
  /** The section the row is in, or null for the lifted "Waiting on you" rows. */
  section: Section | null;
  index: number;
}

/** The pointer's half of a row decides before/after — the same rule every list DnD uses. */
const dropIndexFor = (e: DragEvent<HTMLElement>, rowIndex: number): number => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? rowIndex : rowIndex + 1;
};

/** The thin accent line between rows that says "here". */
function DropLine({ active }: { active: boolean }): JSX.Element | null {
  return active ? <div className="drop-line mx-2 my-0.5" aria-hidden /> : null;
}

/** The eyebrow + count head every section of the list wears. */
function SectionBar({
  children,
  count,
  tone,
  className,
  ...rest
}: {
  children: ReactNode;
  count?: number;
  tone?: "accent";
  className?: string;
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
  title?: string;
}): JSX.Element {
  return (
    <div className={cn("flex items-center gap-1.5 h-6 px-2 select-none", className)} {...rest}>
      {children}
      {count !== undefined && <span className={cn("eyebrow nums shrink-0", tone === "accent" && "text-accent")}>{count}</span>}
    </div>
  );
}

/**
 * One agent in the expanded list. Two lines:
 *
 *   1  status dot · name · what it is · when it next wakes
 *   2  the last thing it said or did · today's P&L
 *
 * Everything about the row's CONTENT lives here; the section decides what wraps
 * it (drag handlers, drop line, the waiting queue's accent edge).
 *
 * A div with `role="button"`, not a `<button>`, so a control can sit inside the
 * row (the retired list does exactly that with its Respawn action): a button
 * inside a button is invalid HTML that React logs and browsers resolve however
 * they like. The keyboard contract is rebuilt by hand instead.
 */
function AgentRow({
  a,
  active,
  waiting,
  asks,
  marks,
  dragging,
  draggable,
  now,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onContextMenu,
}: {
  a: AgentSummary;
  active: boolean;
  waiting: boolean;
  asks: Ask[];
  marks: Record<string, Quote>;
  dragging: boolean;
  draggable: boolean;
  now: number;
  onSelect: () => void;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: DragEvent<HTMLElement>) => void;
  onDrop?: (e: DragEvent<HTMLElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
}): JSX.Element {
  const mine = asks.filter((k) => k.agentId === a.config.id);
  const ask = waitingOn(asks, a.config.id);
  const provider = providerOf(a.config);
  const live = a.config.mode === "live";
  const onLocal = isLocalVendor(a.config);
  // The ask outranks "Working…": an agent can be mid-run and still be blocked on
  // an answer, and the block is the thing that needs a person.
  const preview = ask
    ? waiting
      ? ask.summary
      : `Waiting on you: ${ask.summary}`
    : a.state.running
      ? "Working…"
      : a.state.lastMessagePreview || a.config.task || "No activity yet";
  const symbol = previewSymbol(a, preview);
  const quote = symbol ? marks[symbol] : undefined;
  const activate = (): void => onSelect();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      data-on={active ? "true" : undefined}
      onClick={activate}
      onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
        // Only the row's OWN keystrokes. Keyboard events bubble — without this
        // guard, Enter on a focused child control would be eaten here and
        // select the agent instead of pressing what the operator had focused.
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        activate();
      }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
      title={`${a.config.name} · ${live ? "Live — real money" : "Paper"} · ${PROVIDER_LABEL[provider]}`}
      className={cn(
        "row w-full text-left flex items-start gap-2.5 rounded-md px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        // The exception queue, marked on the ROW and not only on the section it
        // usually sits in: in search results there is no accent edge, and a
        // 30 %-alpha hairline was the entire difference between "this agent has
        // stopped until you answer" and any other row. Amber is the same colour
        // the status dot already spends on "stopped" (paused), which is exactly
        // what a blocked agent is.
        //
        // A tint is safe here despite `.row` painting hover and selection as
        // backgrounds, but only because of these two clauses: `!active` leaves
        // the selected row to `.row[data-on]`, so which thread is open is never
        // in doubt, and the explicit hover keeps the row answering the pointer
        // (a utility in the utilities layer beats `.row:hover` in components).
        !active && waiting && "bg-warn/10 ring-1 ring-warn/45 hover:bg-warn/15",
        dragging && "opacity-40",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
    >
      <AgentAvatar
        icon={a.config.icon}
        color={a.config.color}
        size={36}
        active={a.state.running}
        mode={a.config.mode}
        armed={live && Boolean(a.config.liveArmedAt)}
        local={onLocal}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        {/* Both lines WRAP rather than drop what does not fit. A narrow list
            used to delete the mode and the provider from the row — the two
            facts ("is this real money", "which service runs it") that must
            survive every width, because an operator who cannot see them will
            assume them. Wrapping only ever costs a row of height: the name is
            `flex-1` (basis 0), so it contributes nothing to the line-breaking
            and the pills stay put until they genuinely run out of room. */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
          <span
            title={statusTitle(a)}
            className={cn("dot shrink-0", statusColor(a, onLocal))}
          />
          {/* `flex-1` + a floor: pills and the countdown give up their space
              before the name does, and the name never shrinks past a few
              characters. Without the floor every `shrink-0` neighbour won the
              fight and a narrow list showed "S." where a name should be. */}
          <span className={cn("truncate text-base min-w-[4.5rem] flex-1", active ? "font-medium" : "font-normal")} title={a.config.name}>
            {a.config.name}
          </span>
          {/* The label names the kind — approval, question or plan. The row's
              own amber and the section it sits in carry "this is blocked". */}
          {mine.length > 0 && (
            <span
              className="pill pill-accent shrink-0"
              title={mine.map((k) => `${ASK_LABEL[k.kind]}: ${k.summary}`).join(" · ")}
            >
              {mine.length > 1 ? `${mine.length} asks` : ASK_SHORT[mine[0].kind]}
            </span>
          )}
          {/* The mode is never hidden, however narrow the list gets: it is what
              says real money, and a mode someone has to widen a pane to read is
              a mode they will assume. */}
          {live ? (
            <span className="pill pill-live shrink-0">Live</span>
          ) : (
            <span className="pill pill-paper shrink-0">Paper</span>
          )}
          <span
            className="shrink-0 text-2xs text-muted nums"
            title={`${lastActivityText(a.state.lastMessageAt ?? a.config.createdAt, now)} · ${statusTitle(a)}`}
          >
            {nextWakeText(a, now)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 mt-1">
          {/* Line 2 is context: which service runs it, what it is watching, what
              it last said, and what the book is worth. Identity and urgency stay
              on line 1. The provider wraps with the rest rather than vanishing —
              see the note on line 1. */}
          <ProviderBadge
            provider={provider}
            className={cn("shrink-0 text-2xs", provider === "local" ? "text-local" : "text-muted")}
            title={`${a.state.running ? "Running now on" : "Runs on"} ${PROVIDER_LABEL[provider]} — ${PROVIDER_HINT[provider]}`}
          />
          {symbol && (
            <TickerChip
              symbol={symbol}
              price={quote?.last}
              changePct={quote?.changePct}
              className="shrink-0"
            />
          )}
          <span className="truncate text-sm text-muted flex-1">{preview}</span>
          {a.state.unread > 0 && !active && (
            <span
              className="shrink-0 min-w-4 h-4 px-1 rounded-full bg-accent text-accent-fg text-2xs font-medium nums flex items-center justify-center"
              title={`${a.state.unread} unread`}
            >
              {a.state.unread}
            </span>
          )}
          <BerthPnl a={a} marks={marks} />
        </div>
      </div>
    </div>
  );
}

export function Sidebar(): JSX.Element {
  const agents = useApp((s) => s.agents);
  const booted = useApp((s) => s.booted);
  const order = useApp((s) => s.order);
  const selectedId = useApp((s) => s.selectedId);
  const view = useApp((s) => s.view);
  const search = useApp((s) => s.search);
  const modeFilter = useApp((s) => s.modeFilter);
  const setModeFilter = useApp((s) => s.setModeFilter);
  const select = useApp((s) => s.select);
  const openSheet = useApp((s) => s.openSheet);
  const setSearch = useApp((s) => s.setSearch);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const width = useApp((s) => s.sidebarWidth);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const marks = useApp((s) => s.marks);
  const asks = useApp((s) => s.asks);
  const refreshMarks = useApp((s) => s.refreshMarks);
  // Marks come from Robinhood, or from a market-data key when it is not connected.
  const rhConnected = useApp((s) => Boolean(s.robinhood?.connected));
  const feedConfigured = useApp((s) => Boolean(s.marketData?.configured));
  const canMark = rhConnected || feedConfigured;
  const storedLayout = useApp((s) => s.layout);
  const collapsedGroups = useApp((s) => s.collapsedGroups);
  const layoutError = useApp((s) => s.layoutError);
  const toggleGroupCollapsed = useApp((s) => s.toggleGroupCollapsed);
  const moveAgentTo = useApp((s) => s.moveAgentTo);
  const placeAgentAt = useApp((s) => s.placeAgentAt);
  const assignAgentToGroup = useApp((s) => s.assignAgentToGroup);

  // Marks for the P&L badges: the held symbols of every active agent, every 30 s.
  useEffect(() => {
    if (!canMark) return;
    void refreshMarks();
    const t = setInterval(() => void refreshMarks(), MARKS_POLL_MS);
    return () => clearInterval(t);
  }, [canMark, refreshMarks]);

  /**
   * One clock for the whole list. Without it a countdown only re-ages when some
   * unrelated store write happens to re-render the sidebar, so a quiet fleet
   * sits on "3m" for an hour — the exact figure someone is trusting to know
   * when the next wake-up lands.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);

  const [showRetired, setShowRetired] = useState(true);
  /**
   * Per-row respawn progress. 'busy' spins until the row unmounts on success
   * (the agent leaves the Retired list); a failure reverts the button and puts
   * the reason where the subtitle is.
   */
  const [respawn, setRespawn] = useState<Record<string, "busy" | { err: string }>>({});
  // The flag is keyed by agent and lives HERE, above the row — so a row that
  // left the Retired list and came back (an agent that respawned and retired
  // itself again within a minute) remounted with "Respawning…" still set,
  // spinning forever. Clear it the moment the agent is no longer retired;
  // a later retirement is a new row with a fresh button.
  const retiredKey = Object.values(agents)
    .filter((a) => a.state.status === "retired")
    .map((a) => a.config.id)
    .sort()
    .join(",");
  useEffect(() => {
    const stillRetired = new Set(retiredKey ? retiredKey.split(",") : []);
    setRespawn((r) => {
      const next = { ...r };
      let changed = false;
      for (const id of Object.keys(next)) {
        if (next[id] === "busy" && !stillRetired.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : r;
    });
  }, [retiredKey]);
  /** The row being dragged, and where it would land. Both local: a drag is not state anyone else needs. */
  const [drag, setDrag] = useState<{ id: string; groupId: string | null } | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // The one ceiling (MAX_ACTIVE_AGENTS) — the same rule the IPC gate applies.
  const activeCount = countActiveAgents(Object.values(agents));
  /**
   * The stored document, pruned to the agents we actually have — at RENDER, not
   * in the store, so an agent that is missing for a moment keeps its place in
   * the document (`appStore.layout`). `pruneLayout` returns the same object when
   * nothing is stale, so this is a stable reference on the common path.
   */
  const layout = useMemo(() => pruneLayout(storedLayout, Object.keys(agents)), [storedLayout, agents]);
  const searching = search.trim().length > 0;
  /**
   * Paper vs live, counted over every agent that exists (retired ones
   * included, since the filter hides those too) — what the switch's labels
   * show, so "Live 0" is a fact the operator can read before choosing it.
   */
  // The shared rule (`countByMode`): retired agents are not counted — they
  // sit under their own fold, and the tabs count what the list shows.
  const modeCounts = useMemo(() => countByMode(order.map((id) => agents[id]).filter((a): a is AgentSummary => Boolean(a))), [agents, order]);
  const { flat, waiting, sections, retired, hidden } = useMemo(() => {
    const q = search.trim().toLowerCase();
    // `order` is the store's default (newest first); the layout's manual order
    // goes on top of it and only ever places, never hides (`orderAgents`).
    const matched = orderAgents(
      order
        .map((id) => agents[id])
        .filter(
          (a) =>
            a &&
            (!q ||
              a.config.name.toLowerCase().includes(q) ||
              a.config.task.toLowerCase().includes(q)),
        ),
      layout,
    );
    // The paper/live switch applies to EVERYTHING below — groups, the waiting
    // rows, retired — so a section's count always matches its rows. What it
    // hides is counted, and the list says so at the bottom, because a filter
    // that quietly removes a blocked live agent from view is a trap.
    const all = modeFilter === "all" ? matched : matched.filter((a) => a.config.mode === modeFilter);
    const hidden = matched.length - all.length;
    const live = all.filter((a) => a.state.status !== "retired");
    // An agent with an open ask is LIFTED OUT of its group into its own section
    // at the top. Deliberately in one place, not two: a duplicate row reads as
    // two agents, and the count beside the group would stop matching the rows.
    //
    // Nothing here is stored. Membership is derived from `asks`, which is itself
    // derived from the messages, so answering the card is what removes the row.
    const askIds = new Set(asks.map((k) => k.agentId));
    const waiting = live.filter((a) => askIds.has(a.config.id));
    const rest = live.filter((a) => !askIds.has(a.config.id));
    // The operator's own groups, in the order they arranged them, then whatever
    // is in none. The ungrouped section has a header only when there is
    // something to tell it apart from; with no groups it is simply the list.
    const sections: Section[] = [
      ...layout.groups.map((g) => ({ key: g.id, groupId: g.id, name: g.name, color: g.color, agents: agentsInGroup(rest, layout, g.id) })),
      { key: UNGROUPED_KEY, groupId: null, name: "Ungrouped", agents: rest.filter((a) => !layout.membership[a.config.id]) },
    ];
    return {
      // Searching flattens: a match is a match wherever it is filed, and headers
      // over one-row sections would be more chrome than list.
      flat: q ? live : [],
      waiting,
      sections,
      retired: all.filter((a) => a.state.status === "retired"),
      hidden,
    };
  }, [agents, order, search, asks, layout, modeFilter]);
  const MODE_FILTER_OPTIONS: { value: ModeFilter; label: string; hint: string }[] = [
    { value: "all", label: `All ${modeCounts.paper + modeCounts.live}`, hint: "Every agent, paper and live" },
    { value: "paper", label: `Paper ${modeCounts.paper}`, hint: "Only paper agents — simulated fills at real quotes, no real money" },
    { value: "live", label: `Live ${modeCounts.live}`, hint: "Only live agents — real money in the Robinhood account" },
  ];
  const nothingToShow =
    flat.length === 0 && waiting.length === 0 && sections.every((s) => s.agents.length === 0) && retired.length === 0;

  /** Every id in a section, in display order — what `moveAgent` calls the visible list. */
  const idsOf = (sec: Section): string[] => sec.agents.map((a) => a.config.id);

  const onRowDragStart = (a: AgentSummary, sec: Section) => (e: DragEvent<HTMLElement>): void => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", a.config.id);
    setDrag({ id: a.config.id, groupId: sec.groupId });
    closeMenu();
  };
  const endDrag = (): void => {
    setDrag(null);
    setOver(null);
  };
  const overAt = (key: string, index: number) => (e: DragEvent<HTMLElement>): void => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (over?.key !== key || over.index !== index) setOver({ key, index });
  };
  /**
   * The drop. Within a section it is a reorder around the section's visible
   * ids; across sections it is assign + place in ONE write, so the stored
   * layout never holds an agent in a group at the wrong spot. The index arithmetic
   * is the usual: removing the row from above the target shifts the target up
   * by one.
   */
  const dropAt = (sec: Section, index: number) => (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    const id = drag?.id ?? e.dataTransfer.getData("text/plain");
    endDrag();
    if (!id || !agents[id]) return;
    const ids = idsOf(sec);
    const from = ids.indexOf(id);
    if (from !== -1) {
      const to = from < index ? index - 1 : index;
      if (to !== from) void moveAgentTo(id, ids, to);
      return;
    }
    void placeAgentAt(id, sec.groupId, ids, index);
  };

  /** The row's right-click menu: what the drag does, reachable without one. */
  const menuItems = (m: RowMenu): MenuItem[] => {
    const a = agents[m.agentId];
    if (!a) return [];
    const cur = layout.membership[m.agentId] ?? null;
    const ids = m.section ? idsOf(m.section) : [];
    const items: MenuItem[] = [];
    if (m.section) {
      items.push(
        { kind: "item", label: "Move up", icon: <ArrowUp size={13} />, disabled: m.index === 0, onSelect: () => void moveAgentTo(m.agentId, ids, m.index - 1) },
        { kind: "item", label: "Move down", icon: <ArrowDown size={13} />, disabled: m.index >= ids.length - 1, onSelect: () => void moveAgentTo(m.agentId, ids, m.index + 1) },
        { kind: "separator" },
      );
    }
    items.push({ kind: "label", label: "Move to group" });
    for (const g of layout.groups) {
      items.push({ kind: "item", label: g.name, checked: cur === g.id, icon: <span className="h-2 w-2 rounded-full" style={{ background: g.color ? (COLORS[g.color] ?? COLORS.blue).swatch : "var(--color-border)" }} />, onSelect: () => void assignAgentToGroup(m.agentId, g.id) });
    }
    items.push({ kind: "item", label: layout.groups.length ? "No group" : "No groups yet", checked: cur === null, disabled: layout.groups.length === 0, onSelect: () => void assignAgentToGroup(m.agentId, null) });
    items.push(
      { kind: "separator" },
      { kind: "item", label: "Manage groups…", icon: <Layers size={13} />, onSelect: () => openSheet({ kind: "groups" }) },
      { kind: "item", label: "Agent settings…", icon: <Settings2 size={13} />, onSelect: () => openSheet({ kind: "settings", agentId: m.agentId }) },
    );
    return items;
  };
  const openMenu = (a: AgentSummary, section: Section | null, index: number) => (e: MouseEvent<HTMLElement>): void => {
    e.preventDefault();
    setMenu({ agentId: a.config.id, x: e.clientX, y: e.clientY, section, index });
  };

  const rowFor = (a: AgentSummary, sec: Section | null, index: number, waitingRow: boolean): JSX.Element => (
    <AgentRow
      key={a.config.id}
      a={a}
      active={a.config.id === selectedId && view === "thread"}
      waiting={waitingRow}
      asks={asks}
      marks={marks}
      now={now}
      dragging={drag?.id === a.config.id}
      // Only rows in a layout section drag: the lifted waiting rows and search
      // results have no "here" to be dropped at. The menu still moves them.
      draggable={sec !== null && !searching}
      onSelect={() => select(a.config.id)}
      onDragStart={sec ? onRowDragStart(a, sec) : undefined}
      onDragEnd={endDrag}
      onDragOver={sec ? (e) => overAt(sec.key, dropIndexFor(e, index))(e) : undefined}
      onDrop={sec ? (e) => dropAt(sec, over?.key === sec.key ? over.index : dropIndexFor(e, index))(e) : undefined}
      onContextMenu={openMenu(a, sec, index)}
    />
  );

  const body = collapsed ? (
    <>
      <div className="drag h-10 shrink-0" />
      <div className="flex flex-col items-center gap-1.5 pb-2 no-drag">
        <button
          type="button"
          className="btn-icon"
          title="Expand agents"
          aria-label="Expand agents"
          onClick={toggleSidebar}
        >
          <PanelLeftOpen size={16} />
        </button>
        <button
          type="button"
          className="btn-icon card"
          title="New agent (Ctrl/⌘+N)"
          aria-label="New agent"
          onClick={() => openSheet({ kind: "new" })}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col items-center gap-1.5 py-1">
        {orderAgents(order.map((id) => agents[id]).filter((a) => a && (modeFilter === "all" || a.config.mode === modeFilter)), layout).map((a) => {
          const id = a.config.id;
          const active = id === selectedId && view === "thread";
          return (
            <button
              type="button"
              key={id}
              className={cn(
                "relative rounded-md p-0.5 transition-opacity duration-[var(--dur-fast)]",
                active
                  ? "ring-2 ring-accent"
                  : a.state.status === "retired"
                    ? "opacity-35 hover:opacity-70 grayscale"
                    : "opacity-80 hover:opacity-100",
              )}
              title={`${a.config.name} — ${a.state.running ? "working" : a.state.status}${groupOf(layout, id) ? ` · ${groupOf(layout, id)!.name}` : ""}`}
              aria-label={a.config.name}
              aria-current={active ? "true" : undefined}
              onClick={() => select(id)}
            >
              <AgentAvatar
                icon={a.config.icon}
                color={a.config.color}
                size={40}
                active={a.state.running}
                mode={a.config.mode}
                armed={a.config.mode === "live" && Boolean(a.config.liveArmedAt)}
                local={isLocalVendor(a.config)}
              />
              <span
                title={statusTitle(a)}
                className={cn(
                  "dot absolute right-0.5 bottom-0.5 ring-2 ring-rail",
                  statusColor(a, isLocalVendor(a.config)),
                )}
              />
              {a.state.unread > 0 && !active && (
                <span className="absolute -top-1 -right-1 min-w-4 h-4 px-0.5 rounded-full bg-accent text-accent-fg text-2xs font-medium nums flex items-center justify-center">
                  {a.state.unread}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <AccountButton collapsed />
    </>
  ) : (
    <>
      <div className="drag h-10 shrink-0" />
      <div className="px-2.5 pb-2 flex items-center gap-1.5 no-drag">
        <button
          type="button"
          className="btn-icon shrink-0"
          title="Collapse agents"
          aria-label="Collapse agents"
          onClick={toggleSidebar}
        >
          <PanelLeftClose size={16} />
        </button>
        <div className="relative flex-1 min-w-0">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3 pointer-events-none"
            aria-hidden
          />
          <input
            id="tb-search"
            className="input h-7 py-0 pl-7 text-sm"
            placeholder="Search agents"
            aria-label="Search agents"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn-icon shrink-0"
          title="Manage groups"
          aria-label="Manage groups"
          onClick={() => openSheet({ kind: "groups" })}
        >
          <Layers size={16} />
        </button>
        {/* The one filled action on this surface. */}
        <button
          type="button"
          className="btn-icon card shrink-0"
          title="New agent (Ctrl/⌘+N)"
          aria-label="New agent"
          onClick={() => openSheet({ kind: "new" })}
        >
          <Plus size={16} />
        </button>
      </div>
      {/* Paper / live, always shown — even with no live agent yet, so the
          operator can see "Live 0" and make one from the empty state. */}
      <div className="px-2.5 pb-2 no-drag">
        <Segmented<ModeFilter> size="sm" block value={modeFilter} onChange={setModeFilter} options={MODE_FILTER_OPTIONS} />
      </div>
      {/* The fleet at a glance: how many of this computer's berths are in use,
          and whether any of this is real money. Both are already in the store —
          the meter asks nothing new of anything. */}
      {order.length > 0 && (
        <div
          role="group"
          aria-label="Fleet"
          className="px-2.5 pb-2.5 flex items-center gap-2 no-drag"
          title={`${activeCount} of ${MAX_ACTIVE_AGENTS} agent berths on this computer are in use. Retired agents don't take one.`}
        >
          <Meter quiet value={activeCount} max={MAX_ACTIVE_AGENTS} warnAt={0.8} className="flex-1" />
          <span className="text-2xs text-muted nums shrink-0">
            {activeCount}/{MAX_ACTIVE_AGENTS} berths
          </span>
          {modeCounts.live > 0 && (
            <span className="pill pill-live shrink-0" title={`${modeCounts.live} agent${modeCounts.live === 1 ? "" : "s"} trading real money`}>
              {modeCounts.live} live
            </span>
          )}
        </div>
      )}
      {layoutError && (
        <div role="alert" className="mx-2 mb-1.5 flex items-start gap-2 rounded-md bg-down/10 text-down px-2.5 py-1.5 text-xs">
          <span className="flex-1">{layoutError}</span>
          <button type="button" className="shrink-0 font-medium hover:underline" onClick={() => useApp.setState({ layoutError: null })}>
            Dismiss
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2" onDragLeave={(e) => {
        // Leaving the LIST (not moving between its rows) clears the line.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
      }}>
        {/* Still reading the store. Four ghost berths rather than an empty
            state, because "no agents yet" is a claim and we do not know yet. */}
        {!booted && (
          <div className="pt-2 space-y-1.5" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-2.5 px-2 py-1.5">
                <div className="skeleton h-9 w-9 rounded-md shrink-0" />
                <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
                  <div className="skeleton h-3 w-2/3" />
                  <div className="skeleton h-2.5 w-5/6" />
                </div>
              </div>
            ))}
          </div>
        )}
        {booted && nothingToShow && (
          order.length === 0 ? (
            <EmptyState
              title="No agents yet."
              body="An agent is a thread with one task, one schedule and its own book."
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => openSheet({ kind: "new" })}
                >
                  <Plus size={14} /> New agent
                </button>
              }
            />
          ) : modeFilter !== "all" && !searching ? (
            // Nothing on this side of the switch yet. The button opens New
            // agent already set to this mode, and "Show all" is one click
            // away so the other side is never lost behind the filter.
            <EmptyState
              title={`No ${modeFilter} agents yet.`}
              body={
                <>
                  {hidden} {modeFilter === "live" ? "paper" : "live"} agent{hidden === 1 ? "" : "s"} hidden ·{" "}
                  <button type="button" className="font-medium text-accent hover:underline" onClick={() => setModeFilter("all")}>
                    Show all
                  </button>
                </>
              }
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => openSheet({ kind: "new", initialMode: modeFilter })}
                >
                  <Plus size={14} /> New {modeFilter} agent
                </button>
              }
            />
          ) : (
            <EmptyState
              title="No matches."
              body={searching ? <>Nothing here matches “{search.trim()}”.</> : undefined}
            />
          )
        )}
        {searching ? (
          flat.map((a, i) => rowFor(a, null, i, waitingOn(asks, a.config.id) !== null))
        ) : (
          <>
            {waiting.length > 0 && (
              // The waiting section is first and is not a group — it is the one
              // thing on this screen that is blocked on a person rather than on
              // the market, so it outranks every other ordering. The accent edge
              // is the exception queue's whole identity: accent means "the action
              // is here", and here it literally is.
              <div className="mt-1 mb-1.5 rounded-r-md border-l-2 border-accent bg-accent/5 pb-1">
                <SectionBar count={waiting.length} tone="accent" title="These agents have stopped and are waiting for your answer.">
                  <Hand size={11} className="text-accent shrink-0" aria-hidden />
                  <span className="eyebrow text-accent truncate">Waiting on you</span>
                  <span className="flex-1" />
                </SectionBar>
                <p className="px-2 pb-1 text-2xs text-muted">
                  {waiting.length} answer{waiting.length === 1 ? "" : "s"} owed · stopped until you reply
                </p>
                {waiting.map((a, i) => rowFor(a, null, i, true))}
              </div>
            )}
            {sections.map((sec) => {
              const hasGroups = layout.groups.length > 0;
              const isUngrouped = sec.groupId === null;
              // Ungrouped with no groups at all is just the list: no header, no
              // fold. An EMPTY group still shows — it is a drop target, and a
              // group that vanished when its last agent left would be a puzzle.
              if (isUngrouped && !hasGroups && sec.agents.length === 0) return null;
              const showHeader = hasGroups;
              const folded = !isUngrouped && collapsedGroups.includes(sec.key);
              const overHere = over?.key === sec.key;
              return (
                <div key={sec.key} className={cn("rounded-md", drag && overHere && "ring-1 ring-accent/40")}>
                  {showHeader && (
                    <SectionBar
                      className="mt-2"
                      count={sec.agents.length}
                      // Dropping ON the header files the agent at the end of the
                      // section — "put it in this group", with the exact spot a
                      // second drag away.
                      onDragOver={overAt(sec.key, sec.agents.length)}
                      onDrop={dropAt(sec, sec.agents.length)}
                    >
                      <button
                        type="button"
                        className="flex items-center gap-1.5 min-w-0 flex-1 text-left eyebrow hover:text-text transition-colors duration-[var(--dur-fast)]"
                        onClick={() => !isUngrouped && toggleGroupCollapsed(sec.key)}
                        disabled={isUngrouped}
                        aria-expanded={isUngrouped ? undefined : !folded}
                        title={isUngrouped ? "Agents in no group" : folded ? "Expand" : "Collapse"}
                      >
                        {isUngrouped ? (
                          <span className="w-3" />
                        ) : folded ? (
                          <ChevronRight size={12} className="shrink-0" />
                        ) : (
                          <ChevronDown size={12} className="shrink-0" />
                        )}
                        {sec.color && <span className="h-2 w-2 rounded-full shrink-0" style={{ background: (COLORS[sec.color] ?? COLORS.blue).swatch }} />}
                        <span className="truncate">{sec.name}</span>
                      </button>
                    </SectionBar>
                  )}
                  {!folded && (
                    <div
                      // The list body catches drops past the last row (and into
                      // an empty group), which the rows themselves cannot.
                      onDragOver={(e) => {
                        if (e.target === e.currentTarget) overAt(sec.key, sec.agents.length)(e);
                      }}
                      onDrop={(e) => {
                        if (e.target === e.currentTarget) dropAt(sec, sec.agents.length)(e);
                      }}
                      className={cn(sec.agents.length === 0 && "min-h-9")}
                    >
                      {sec.agents.length === 0 && showHeader && (
                        <div
                          className={cn(
                            "mx-2 my-1 rounded-md px-2.5 py-2 text-xs text-center",
                            drag ? "drop-target text-accent" : "inset text-muted",
                          )}
                          onDragOver={overAt(sec.key, 0)}
                          onDrop={dropAt(sec, 0)}
                        >
                          {drag ? "Drop here" : "No agents — drag one here"}
                        </div>
                      )}
                      {sec.agents.map((a, i) => (
                        <div key={a.config.id}>
                          <DropLine active={Boolean(drag) && overHere && over?.index === i && drag?.id !== a.config.id} />
                          {rowFor(a, sec, i, false)}
                        </div>
                      ))}
                      <DropLine active={Boolean(drag) && overHere && over?.index === sec.agents.length && sec.agents.length > 0} />
                    </div>
                  )}
                  {folded && drag && overHere && <div className="mx-2 mb-1 text-2xs text-accent">Drop to add to {sec.name}</div>}
                </div>
              );
            })}
          </>
        )}
        {retired.length > 0 && (
          <div className="mt-3">
            <SectionBar count={retired.length}>
              <button
                type="button"
                className="flex items-center gap-1.5 min-w-0 flex-1 text-left eyebrow hover:text-text transition-colors duration-[var(--dur-fast)]"
                aria-expanded={showRetired}
                onClick={() => setShowRetired((v) => !v)}
              >
                {showRetired ? (
                  <ChevronDown size={12} className="shrink-0" />
                ) : (
                  <ChevronRight size={12} className="shrink-0" />
                )}
                <Archive size={11} className="shrink-0" aria-hidden />
                <span className="truncate">Retired</span>
              </button>
            </SectionBar>
            {showRetired &&
              retired.map((a) => {
                const active = a.config.id === selectedId && view === "thread";
                // The same shared rule the IPC gate applies, so this button
                // and a respawn reached from the thread can never disagree.
                const respawnBlocked = agentSlotBlocked(activeCount);
                const status = respawn[a.config.id];
                const busy = status === "busy";
                const err = typeof status === "object" ? status.err : null;
                const open = (): void => select(a.config.id);
                return (
                  // The row holds a button, so it cannot BE one: a nested
                  // <button> is invalid HTML that React logs and browsers
                  // resolve however they like. Same keyboard contract, by hand.
                  <div
                    key={a.config.id}
                    role="button"
                    tabIndex={0}
                    aria-current={active ? "true" : undefined}
                    // Named explicitly: the avatar's character field is the row's
                    // first text, so without this the row's accessible name is a
                    // wall of punctuation rather than the agent.
                    aria-label={`${a.config.name} · Retired`}
                    data-on={active ? "true" : undefined}
                    onClick={open}
                    onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
                      // Only the row's OWN keystrokes. Keyboard events bubble,
                      // so without this the row swallowed Enter and Space on the
                      // focused Respawn button — Tab reached it, and pressing it
                      // opened the thread instead of bringing the agent back.
                      if (e.target !== e.currentTarget) return;
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      open();
                    }}
                    className={cn(
                      "row w-full text-left flex items-center gap-2.5 rounded-md px-2 py-1.5 mb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                      !active && "opacity-70 hover:opacity-100",
                    )}
                  >
                    <AgentAvatar
                      icon={a.config.icon}
                      color={a.config.color}
                      size={28}
                      className="grayscale opacity-70"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{a.config.name}</div>
                      <div className={cn("text-2xs truncate", err ? "text-down" : "text-muted")} title={err ?? undefined}>
                        {err ?? (busy ? "Bringing it back…" : (a.state.retireReason ?? "Retired"))}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm shrink-0 disabled:opacity-40"
                      title={respawnBlocked ?? "Respawn this agent"}
                      disabled={Boolean(respawnBlocked) || busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        // 'busy' clears by UNMOUNT on success (the row leaves
                        // the Retired list when the store flips), and by hand
                        // only on failure — clearing on resolve would flash
                        // "Respawn" on a row that is about to disappear.
                        const id = a.config.id;
                        setRespawn((r) => ({ ...r, [id]: "busy" }));
                        window.tb.agents.respawn(id)
                          .then(() => {
                            // Resolved but the store never left 'retired' (a no-op
                            // respawn, a missed event): do not spin forever. The
                            // status effect above clears the normal case first.
                            window.setTimeout(() => setRespawn((r) => (r[id] === "busy" ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== id)) : r)), 3000);
                          })
                          .catch((error: Error) => {
                            setRespawn((r) => ({ ...r, [id]: { err: error.message || "Respawn failed — try again." } }));
                          });
                      }}
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                      {busy ? "Respawning…" : "Respawn"}
                    </button>
                  </div>
                );
              })}
          </div>
        )}
        {/* What the switch is hiding, said on the list itself — so a blocked
            live agent is never out of sight AND out of mind. */}
        {hidden > 0 && !nothingToShow && (
          <div className="mt-3 px-2 py-2 text-center text-xs text-muted">
            {hidden} {modeFilter === "live" ? "paper" : "live"} agent{hidden === 1 ? "" : "s"} hidden ·{" "}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => setModeFilter("all")}>
              Show all
            </button>
          </div>
        )}
      </div>
      <AccountButton collapsed={false} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />}
    </>
  );

  return (
    <aside
      aria-label="Agents"
      className="panel relative h-full shrink-0 flex flex-col hair-r"
      style={{ width: collapsed ? SIDEBAR_RAIL : width }}
    >
      {body}
      <ResizeHandle />
    </aside>
  );
}

/**
 * The sidebar's right edge, dragged to resize. Dragging narrower than
 * SIDEBAR_SNAP collapses it to the icon rail (and dragging the rail back out
 * re-expands), so the same gesture covers "wider", "narrower" and "closed".
 * Double-click restores the default width.
 */
function ResizeHandle(): JSX.Element {
  const width = useApp((s) => s.sidebarWidth);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const setWidth = useApp((s) => s.setSidebarWidth);
  const setCollapsed = useApp((s) => s.setSidebarCollapsed);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = collapsed ? SIDEBAR_RAIL : width;
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent): void => {
      // Never let the list eat the thread: leave room for the conversation whatever the window size.
      const next = Math.min(
        startW + (ev.clientX - startX),
        window.innerWidth - 320,
      );
      if (next < SIDEBAR_SNAP) setCollapsed(true);
      else {
        setCollapsed(false);
        setWidth(next);
      }
    };
    const up = (): void => {
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const nudge = (px: number): void => {
    if (collapsed) {
      if (px > 0) setCollapsed(false);
      return;
    }
    if (width + px < SIDEBAR_SNAP) setCollapsed(true);
    else setWidth(width + px);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the agent list"
      aria-valuenow={collapsed ? SIDEBAR_RAIL : width}
      aria-valuemin={SIDEBAR_RAIL}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        setCollapsed(false);
        setWidth(SIDEBAR_DEFAULT);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") nudge(-24);
        else if (e.key === "ArrowRight") nudge(24);
        else return;
        e.preventDefault();
      }}
      title="Drag to resize · double-click to reset · drag all the way in to collapse"
      className="no-drag absolute top-0 -right-1 z-30 h-full w-2 cursor-col-resize group focus-visible:outline-none"
    >
      <span
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-[var(--dur-fast)]",
          dragging
            ? "bg-accent"
            : "bg-transparent group-hover:bg-accent/50 group-focus-visible:bg-accent/50",
        )}
      />
    </div>
  );
}
