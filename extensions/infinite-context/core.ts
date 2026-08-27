/**
 * Infinite Context - pure logic (functional core).
 *
 * No imports from pi packages: every function is a pure transformation over
 * plain data structures, so it is testable in isolation via node:test
 * (core.test.ts). The imperative shell (index.ts) wires pi events/tools and
 * calls into here.
 *
 * ONE mechanism: every forget is a `Span` (a range snapped to whole tool units)
 * with an optional summary. A span with a single member and an empty summary is
 * the former "tombstone" (content gone, stub remains). Because spans always
 * cover whole toolCall/toolResult units (expandRange), replacing them with a
 * single synthetic user message can never orphan a pair. Everything is fully
 * reversible (remember).
 */

// Custom-entry type for the persisted span list.
export const INFINITE_CONTEXT_ENTRY = "infinite-context";

// --- context-fill nudge policy -------------------------------------------
// Encourage the agent to fold before it runs out: on each turn we compare the
// context fill to a ladder of thresholds and, when it first crosses a new one,
// steer a one-off note toward the tools above. Deliberately minimal (KISS):
// no persistence, no growth tracking, no escalation levels — a single note
// text, one crossing per band.
export const NUDGE_BASE_PERCENT = 75; // first nudge once fill reaches this
export const NUDGE_STEP_PERCENT = 5; // re-nudge every 5 points above the base

// The 5-point band floor at/above the base that `percent` falls into
// (75, 80, 85, ...), or null when below the base — below the base nudging is
// disarmed, so a fold that lowers fill re-arms the ladder.
export function nudgeBand(percent: number): number | null {
  if (!Number.isFinite(percent) || percent < NUDGE_BASE_PERCENT) return null;
  return (
    NUDGE_BASE_PERCENT +
    NUDGE_STEP_PERCENT *
      Math.floor((percent - NUDGE_BASE_PERCENT) / NUDGE_STEP_PERCENT)
  );
}

// Decide whether to steer a nudge this turn and the band state to carry forward.
// `lastBand` is the highest band already nudged (0 = none). We nudge only on a
// CONTINUING turn (the steer lands before the model's next step) and only when
// the current band is strictly above the last one nudged. When `continuing` is
// false but the band advanced, we HOLD `lastBand` so the next continuing turn
// still fires; dropping below the base resets to 0 (re-arm). Pure so the one
// bit of stateful logic stays under the test gate.
//
// The Map Is Not the Territory: `percent` derives from getContextUsage().tokens,
// which is the last assistant usage and lags a just-made fold by one turn — the
// re-arm is therefore one turn late, which is acceptable for a nudge.
export function planNudge(
  percent: number,
  lastBand: number,
  continuing: boolean,
): { nudge: boolean; band: number } {
  const band = nudgeBand(percent);
  if (band === null) return { nudge: false, band: 0 };
  if (continuing && band > lastBand) return { nudge: true, band };
  return { nudge: false, band: lastBand };
}

// Every conversation role that pi can associate with a session entry id.
export const TAGGABLE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "custom",
  "bashExecution",
  "branchSummary",
  "compactionSummary",
]);

export type Content = string | Array<{ type?: string; text?: string }>;
export interface AgentMessageLike {
  role: string;
  content?: Content;
  timestamp?: number;
  details?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  summary?: string;
  fromId?: string;
  tokensBefore?: number;
  customType?: string;
  display?: boolean;
}

// Minimal session-entry shape needed to mirror pi's conversion from active
// context entries to messages. See docs/session-format.md, "Context Building".
export interface BranchEntry {
  type: string;
  id?: string;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  message?: AgentMessageLike;
  content?: Content;
  display?: boolean;
  details?: unknown;
  summary?: string;
  fromId?: string;
  tokensBefore?: number;
}

export type BranchMsg = { id: string; message: AgentMessageLike };

// A folded range, addressed by fromId (= first member) in tool results
// (map/search/peek/collapse); the stub itself carries no inline id. memberIds
// are always real entry ids (flat), contiguous and ascending in branch order.
// summary == "" -> the range is only dropped (stub "(forgotten N)"), otherwise
// it is replaced by the summary.
export interface Span {
  fromId: string;
  memberIds: string[];
  summary: string;
}

/**
 * Compact token label: <1000 -> "340"; else one-decimal k with trailing ".0"
 * dropped ("1.2k", "12k"). Single formatter (DRY) for stubs, tails, peek.
 */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

// Pi's flat-rate stand-in for an image block (compaction.ts ESTIMATED_IMAGE_CHARS).
const ESTIMATED_IMAGE_CHARS = 4800;

/** string-or-blocks content chars, image blocks at pi's flat rate. */
function contentChars(c: Content | undefined): number {
  if (typeof c === "string") return c.length;
  if (!Array.isArray(c)) return 0;
  let chars = 0;
  for (const block of c as Array<Record<string, unknown>>) {
    if (typeof block.text === "string") chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/**
 * Byte-for-byte mirror of pi's estimateTokens (compaction.ts): per-role char
 * count / 4, rounded up. Mirrored instead of imported to keep the core free of
 * pi imports (testable in isolation) — exact counts are impossible anyway:
 * providers expose no portable per-message tokenizer, and pi itself plans
 * compaction with this same estimate plus the last reported assistant usage.
 * Matching pi's numbers is therefore the accuracy ceiling, and it keeps our
 * freed/hidden math consistent with pi's compaction thresholds.
 */
export function estimateTokens(message: AgentMessageLike): number {
  let chars = 0;
  switch (message.role) {
    case "user":
    case "custom":
    case "toolResult":
      chars = contentChars(message.content);
      break;
    case "assistant": {
      if (!Array.isArray(message.content)) break;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (typeof block.text === "string") chars += block.text.length;
        else if (typeof block.thinking === "string")
          chars += block.thinking.length;
        else if (block.type === "toolCall") {
          if (typeof block.name === "string") chars += block.name.length;
          chars += JSON.stringify(block.arguments ?? {}).length;
        }
      }
      break;
    }
    case "bashExecution":
      chars = (message.command?.length ?? 0) + (message.output?.length ?? 0);
      break;
    case "branchSummary":
    case "compactionSummary":
      chars = message.summary?.length ?? 0;
      break;
    default:
      return 0;
  }
  return Math.ceil(chars / 4);
}

/** Plain searchable text of a message, for map/search/peek. */
export function serializeContent(message: AgentMessageLike): string {
  if (message.role === "branchSummary" || message.role === "compactionSummary")
    return message.summary ?? "";
  if (message.role === "bashExecution")
    return [message.command, message.output].filter(Boolean).join("\n");
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const block of c as Array<Record<string, unknown>>) {
    if (typeof block.text === "string") parts.push(block.text);
    else if (typeof block.thinking === "string")
      parts.push(`(thinking) ${block.thinking}`);
    else if (block.type === "toolCall")
      parts.push(`(call ${block.name ?? "?"} ${JSON.stringify(block.arguments ?? {})})`);
  }
  return parts.join("\n");
}

/**
 * Convert pi's active context entries into ordered, addressable messages. The
 * caller must pass buildContextEntries(), not getBranch(), so native compaction
 * summaries replace the raw messages they summarized.
 */
export function branchMessages(branch: BranchEntry[]): BranchMsg[] {
  const out: BranchMsg[] = [];
  for (const entry of branch) {
    if (entry.id === undefined) continue;
    let message: AgentMessageLike | undefined;
    if (entry.type === "message") {
      message = entry.message;
    } else if (entry.type === "custom_message") {
      message = {
        role: "custom",
        customType: entry.customType,
        content: entry.content ?? [],
        display: entry.display,
        details: entry.details,
        timestamp: entry.timestamp
          ? new Date(entry.timestamp).getTime()
          : undefined,
      };
    } else if (entry.type === "branch_summary" && entry.summary) {
      message = {
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: entry.timestamp
          ? new Date(entry.timestamp).getTime()
          : undefined,
      };
    } else if (entry.type === "compaction") {
      message = {
        role: "compactionSummary",
        summary: entry.summary ?? "",
        tokensBefore: entry.tokensBefore ?? 0,
        timestamp: entry.timestamp
          ? new Date(entry.timestamp).getTime()
          : undefined,
      };
    }
    if (message && TAGGABLE_ROLES.has(message.role))
      out.push({ id: entry.id, message });
  }
  return out;
}

/**
 * Per position, the [start,end] bounds of the atomic toolCall/toolResult unit.
 * A unit = an assistant message with toolCall blocks + every toolResult message
 * answering its call ids (a turn can have several). Messages outside a unit have
 * start==end==their own index.
 */
export function unitBounds(msgs: BranchMsg[]): {
  start: number[];
  end: number[];
} {
  const n = msgs.length;
  const start = Array.from({ length: n }, (_, i) => i);
  const end = Array.from({ length: n }, (_, i) => i);
  const callOwner = new Map<string, number>(); // toolCall block id -> assistant index
  for (let i = 0; i < n; i++) {
    const m = msgs[i].message;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as Array<{ type?: string; id?: string }>) {
        if (b?.type === "toolCall" && b.id) callOwner.set(b.id, i);
      }
    }
  }
  const resultsByOwner = new Map<number, number[]>(); // assistant index -> result indices
  for (let i = 0; i < n; i++) {
    const m = msgs[i].message;
    if (m.role === "toolResult" && m.toolCallId) {
      const a = callOwner.get(m.toolCallId);
      if (a !== undefined)
        (resultsByOwner.get(a) ?? resultsByOwner.set(a, []).get(a)!).push(i);
    }
  }
  for (const [a, rs] of resultsByOwner) {
    const e = Math.max(a, ...rs);
    start[a] = a;
    end[a] = e;
    for (const r of rs) {
      start[r] = a;
      end[r] = e;
    }
  }
  return { start, end };
}

/**
 * First snap lo/hi to whole tool units, then flatly absorb overlapping spans
 * (fully include their members). Repeat until stable.
 */
export function expandRange(
  msgs: BranchMsg[],
  bounds: { start: number[]; end: number[] },
  spans: Span[],
  loIn: number,
  hiIn: number,
): { lo: number; hi: number } {
  let lo = loIn;
  let hi = hiIn;
  const indexById = new Map(msgs.map((m, i) => [m.id, i] as const));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = lo; i <= hi; i++) {
      if (bounds.start[i] < lo) {
        lo = bounds.start[i];
        changed = true;
      }
      if (bounds.end[i] > hi) {
        hi = bounds.end[i];
        changed = true;
      }
    }
    for (const span of spans) {
      const idxs = span.memberIds
        .map((id) => indexById.get(id))
        .filter((x): x is number => x !== undefined);
      if (idxs.some((x) => x >= lo && x <= hi)) {
        const sLo = Math.min(...idxs);
        const sHi = Math.max(...idxs);
        if (sLo < lo) {
          lo = sLo;
          changed = true;
        }
        if (sHi > hi) {
          hi = sHi;
          changed = true;
        }
      }
    }
  }
  return { lo, hi };
}

export interface CollapseItem {
  from: string;
  to?: string;
  summary?: string;
}

export interface CollapsePlan {
  spans: Span[]; // new span state (the input is left unchanged)
  applied: string[]; // fromIds of the resulting stubs (deduplicated)
  summaries: string[]; // summary per applied stub
  collapsed: number; // distinct collapsed messages
  unknown: string[]; // ids that could not be resolved
  freedTokens: number; // net context tokens freed (live members - new stubs)
}

// Stub text carries NO inline [#id]: ids exist only in tool results (map/
// search/peek/collapse), one uniform rule. The id-less stub costs one
// context_map call in the rare "expand the fold I'm looking at" case, and buys
// zero first-token imitation surface plus a few tokens per fold per request
// (same trade that removed live-message prefixes, see index.ts header).
function stubText(summary: string, n: number, hidden: number): string {
  const h = fmtTokens(hidden);
  return summary
    ? `(summary, ${h} hidden) ${summary}`
    : `(forgotten ${n} message${n > 1 ? "s" : ""}, ${h} hidden)`;
}

/**
 * Token cost of a span's stub message, exactly as buildOverlay renders it,
 * measured with the same estimator as every other count. Single source (DRY)
 * for the freed/restored net-token math in planCollapse and planExpand.
 */
export function stubTokens(summary: string, n: number, hidden: number): number {
  return estimateTokens({
    role: "user",
    content: stubText(summary, n, hidden),
  });
}

/**
 * Pure forget planning. Returns the new span state + report without mutating
 * the input. Multiple items that snap to the same tool unit (e.g. parallel tool
 * calls in ONE assistant turn) merge into one stub; non-empty summaries are
 * kept (an empty one never overwrites a real one). The report is derived from
 * the final state -> deduplicated and counted correctly no matter how many
 * items coincided.
 */
export function planCollapse(
  msgs: BranchMsg[],
  spans: Span[],
  items: CollapseItem[],
): CollapsePlan {
  const next: Span[] = spans.map((s) => ({
    ...s,
    memberIds: s.memberIds.slice(),
  }));
  const indexById = new Map(msgs.map((m, i) => [m.id, i] as const));
  const tokById = new Map(
    msgs.map((m) => [m.id, estimateTokens(m.message)] as const),
  );
  // Members already folded before this call do not count as newly freed.
  const priorMembers = new Set(spans.flatMap((s) => s.memberIds));
  const bounds = unitBounds(msgs);
  const unknown: string[] = [];
  const touched = new Set<string>();
  for (const item of items) {
    // Spans mutate per item -> rebuild the lookup each time.
    const spanByFrom = new Map(next.map((s) => [s.fromId, s] as const));
    const startIdx = (id: string) => {
      const s = spanByFrom.get(id);
      return indexById.get(s ? s.memberIds[0] : id);
    };
    const endIdx = (id: string) => {
      const s = spanByFrom.get(id);
      return indexById.get(s ? s.memberIds[s.memberIds.length - 1] : id);
    };
    const toId = item.to ?? item.from;
    const a = startIdx(item.from);
    const b = endIdx(toId);
    if (a === undefined) unknown.push(item.from);
    if (b === undefined && toId !== item.from) unknown.push(toId);
    if (a === undefined || b === undefined) continue;
    const { lo, hi } = expandRange(
      msgs,
      bounds,
      next,
      Math.min(a, b),
      Math.max(a, b),
    );
    const memberIds = msgs.slice(lo, hi + 1).map((m) => m.id);
    const memberSet = new Set(memberIds);
    // Absorb overlapping/coinciding spans; inherit their non-empty summaries.
    const inherited: string[] = [];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].memberIds.some((id) => memberSet.has(id))) {
        if (next[i].summary) inherited.unshift(next[i].summary);
        next.splice(i, 1);
      }
    }
    const summary = [...inherited, item.summary ?? ""]
      .filter((s) => s)
      .join("; ");
    next.push({ fromId: memberIds[0], memberIds, summary });
    for (const id of memberIds) touched.add(id);
  }
  const resultSpans = next.filter((s) =>
    s.memberIds.some((id) => touched.has(id)),
  );
  // freed = newly-hidden live members minus the stub(s) that replace them.
  // Members folded by a prior span are excluded (already saved).
  let freedTokens = 0;
  for (const s of resultSpans) {
    const hidden = s.memberIds.reduce((t, id) => t + (tokById.get(id) ?? 0), 0);
    const live = s.memberIds.reduce(
      (t, id) => t + (priorMembers.has(id) ? 0 : (tokById.get(id) ?? 0)),
      0,
    );
    const stubTok = stubTokens(s.summary, s.memberIds.length, hidden);
    freedTokens += live - stubTok;
  }
  return {
    spans: next,
    applied: resultSpans.map((s) => s.fromId),
    summaries: resultSpans.map((s) => s.summary),
    collapsed: touched.size,
    unknown,
    freedTokens,
  };
}

export interface ExpandItem {
  from: string;
  to?: string;
}

export interface ExpandPlan {
  spans: Span[];
  applied: string[]; // fromId of each restored sub-range
  noop: string[]; // ids matching no span
  invalid: string[]; // "from..to" ranges whose `to` lies outside `from`'s fold
  restoredTokens: number; // net context tokens added (restored members + remnant stubs − removed stub)
  restoredMsgs: number; // messages brought back live
}

/**
 * Pure expand planning (inverse of collapse). Range-aware: an item is matched to
 * the fold containing `from` (its stub fromId, or any inner member id revealed
 * by search/peek). Uniform rule: omit `to` -> expand the WHOLE fold; give `to`
 * -> the from..to sub-range SPLITS the fold - the sub-range is restored live,
 * the two leftover halves stay folded, both inheriting the original summary
 * (lossless). The sub-range is snapped to whole tool units and clamped within
 * the fold, so remnants never orphan a tool call/result pair.
 */
export function planExpand(
  msgs: BranchMsg[],
  spans: Span[],
  items: ExpandItem[],
): ExpandPlan {
  const next: Span[] = spans.map((s) => ({
    ...s,
    memberIds: s.memberIds.slice(),
  }));
  const indexById = new Map(msgs.map((m, i) => [m.id, i] as const));
  const tokById = new Map(
    msgs.map((m) => [m.id, estimateTokens(m.message)] as const),
  );
  const bounds = unitBounds(msgs);
  const sumTok = (ids: string[]) =>
    ids.reduce((t, id) => t + (tokById.get(id) ?? 0), 0);
  const applied: string[] = [];
  const noop: string[] = [];
  const invalid: string[] = [];
  let restoredTokens = 0;
  let restoredMsgs = 0;
  for (const item of items) {
    const si = next.findIndex(
      (s) => s.fromId === item.from || s.memberIds.includes(item.from),
    );
    if (si < 0) {
      noop.push(item.from);
      continue;
    }
    const span = next[si];
    // Omit `to` -> whole fold (whether `from` is the stub id or an inner member);
    // give `to` -> from..to sub-range (splits the fold).
    const wholeSpan = item.to === undefined;
    // Design by Contract: a sub-range must lie inside `from`'s fold. An outside
    // `to` would silently clamp to something the caller didn't ask for, so it is
    // rejected as invalid instead of guessed at.
    if (!wholeSpan && item.to !== undefined && !span.memberIds.includes(item.to)) {
      invalid.push(`${item.from}..${item.to}`);
      continue;
    }
    const subFromId = wholeSpan ? span.memberIds[0] : item.from;
    const subToId = wholeSpan
      ? span.memberIds[span.memberIds.length - 1]
      : (item.to ?? item.from);
    const ai = indexById.get(subFromId);
    const bi = indexById.get(subToId);
    if (ai === undefined || bi === undefined) {
      noop.push(item.from);
      continue;
    }
    // Snap to whole tool units, clamped to the span's own member index range.
    const memberIdx = span.memberIds.map((id) => indexById.get(id)!);
    const spanLo = Math.min(...memberIdx);
    const spanHi = Math.max(...memberIdx);
    let lo = Math.min(ai, bi);
    let hi = Math.max(ai, bi);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = lo; i <= hi; i++) {
        if (bounds.start[i] >= spanLo && bounds.start[i] < lo) {
          lo = bounds.start[i];
          changed = true;
        }
        if (bounds.end[i] <= spanHi && bounds.end[i] > hi) {
          hi = bounds.end[i];
          changed = true;
        }
      }
    }
    const left: string[] = [];
    const right: string[] = [];
    const restored: string[] = [];
    for (const id of span.memberIds) {
      const idx = indexById.get(id)!;
      if (idx < lo) left.push(id);
      else if (idx > hi) right.push(id);
      else restored.push(id);
    }
    if (restored.length === 0) {
      noop.push(item.from);
      continue;
    }
    next.splice(si, 1);
    const origStub = stubTokens(
      span.summary,
      span.memberIds.length,
      sumTok(span.memberIds),
    );
    let remnantStub = 0;
    if (left.length) {
      next.push({ fromId: left[0], memberIds: left, summary: span.summary });
      remnantStub += stubTokens(span.summary, left.length, sumTok(left));
    }
    if (right.length) {
      next.push({ fromId: right[0], memberIds: right, summary: span.summary });
      remnantStub += stubTokens(span.summary, right.length, sumTok(right));
    }
    applied.push(restored[0]);
    restoredMsgs += restored.length;
    restoredTokens += sumTok(restored) + remnantStub - origStub;
  }
  return { spans: next, applied, noop, invalid, restoredTokens, restoredMsgs };
}

/**
 * Drop span members that are no longer part of the active context (pi's native
 * compaction summarized them away). A fold over vanished messages would
 * otherwise show phantom savings and an unexpandable stub — the stub stays only
 * for members that still exist, keyed to the first surviving member.
 */
export function reconcileSpans(
  spans: Span[],
  msgs: BranchMsg[],
): { spans: Span[]; changed: boolean } {
  const active = new Set(msgs.map((m) => m.id));
  const out: Span[] = [];
  let changed = false;
  for (const s of spans) {
    const memberIds = s.memberIds.filter((id) => active.has(id));
    if (memberIds.length === s.memberIds.length) {
      out.push({ ...s, memberIds });
      continue;
    }
    changed = true;
    if (memberIds.length === 0) continue;
    out.push({ fromId: memberIds[0], memberIds, summary: s.summary });
  }
  return { spans: out, changed };
}

/**
 * Overview of the fold tree: totals + one line per span (branch order). Used by
 * peek() and the collapse/expand result tails.
 */
export function summarizeTree(
  spans: Span[],
  msgs: BranchMsg[],
): { totalSpans: number; hiddenTokens: number; lines: string[] } {
  const tokById = new Map(
    msgs.map((m) => [m.id, estimateTokens(m.message)] as const),
  );
  const idxById = new Map(msgs.map((m, i) => [m.id, i] as const));
  const ordered = spans
    .slice()
    .sort(
      (a, b) =>
        (idxById.get(a.memberIds[0]) ?? 0) - (idxById.get(b.memberIds[0]) ?? 0),
    );
  let hiddenTokens = 0;
  const lines = ordered.map((s) => {
    const tok = s.memberIds.reduce((t, id) => t + (tokById.get(id) ?? 0), 0);
    hiddenTokens += tok;
    const n = s.memberIds.length;
    const label = s.summary
      ? s.summary.length > 60
        ? `${s.summary.slice(0, 60)}…`
        : s.summary
      : "(no summary)";
    return `[#${s.fromId}] · ${n} msg${n > 1 ? "s" : ""} · ${fmtTokens(tok)} tok · ${label}`;
  });
  return { totalSpans: spans.length, hiddenTokens, lines };
}

/**
 * Serialize a span's hidden members for peek(id): per message its inner id,
 * role, size and content (capped, so peeking a fat span can't blow the budget).
 */
export function serializeSpan(
  span: Span,
  msgs: BranchMsg[],
  cap = 2000,
): string {
  const byId = new Map(msgs.map((m) => [m.id, m.message] as const));
  const out: string[] = [];
  for (const id of span.memberIds) {
    const m = byId.get(id);
    if (!m) continue;
    const text = serializeContent(m);
    const body =
      text.length > cap
        ? `${text.slice(0, cap)}… [+${text.length - cap} chars]`
        : text;
    out.push(`[#${id}] ${m.role} ${fmtTokens(estimateTokens(m))}\n${body}`);
  }
  return out.join("\n\n");
}

export interface SearchHit {
  id: string;
  role: string;
  foldFrom: string | null; // fromId of the fold hiding this msg, or null if live
  snippet: string;
}

/**
 * Case-insensitive substring search across ALL taggable messages (live and
 * folded) AND every fold's summary digest, flagging which fold (if any) hides
 * each hit. The find-by-content complement to peek's look-by-id: locate a
 * keyword, then peek/expand the hit. A fold whose *summary* matches is returned
 * as its own hit (role "fold", id = the fold's stub) - the digest is curated to
 * be findable, so it must be searchable even though it is not a stored message.
 */
export function searchMessages(
  msgs: BranchMsg[],
  spans: Span[],
  query: string,
  cap = 20,
): { hits: SearchHit[]; total: number } {
  const q = query.toLowerCase();
  if (!q) return { hits: [], total: 0 };
  const foldOf = new Map<string, string>();
  for (const s of spans) for (const id of s.memberIds) foldOf.set(id, s.fromId);
  const hits: SearchHit[] = [];
  let total = 0;
  const push = (
    id: string,
    role: string,
    foldFrom: string | null,
    text: string,
    at: number,
  ) => {
    total++;
    if (hits.length >= cap) return;
    const start = Math.max(0, at - 40);
    const end = Math.min(text.length, at + q.length + 40);
    const snippet =
      (start > 0 ? "…" : "") +
      text.slice(start, end).replace(/\s+/g, " ").trim() +
      (end < text.length ? "…" : "");
    hits.push({ id, role, foldFrom, snippet });
  };
  for (const m of msgs) {
    const text = serializeContent(m.message);
    const idx = text.toLowerCase().indexOf(q);
    if (idx >= 0) push(m.id, m.message.role, foldOf.get(m.id) ?? null, text, idx);
  }
  // Fold summaries: not stored as messages, so scanned separately. The fold
  // itself is the hit (role "fold"); foldFrom is null since it IS the fold.
  for (const s of spans) {
    if (!s.summary) continue;
    const idx = s.summary.toLowerCase().indexOf(q);
    if (idx >= 0) push(s.fromId, "fold", null, s.summary, idx);
  }
  return { hits, total };
}

/**
 * Reconstruct the span list from the branch. The last custom entry wins
 * (cumulative snapshot: each persist writes the full span list).
 */
export function reconstructSpans(branch: BranchEntry[]): Span[] {
  let spans: Span[] = [];
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === INFINITE_CONTEXT_ENTRY) {
      const data = entry.data as { spans?: Span[] } | undefined;
      spans = [...(data?.spans ?? [])];
    }
  }
  return spans;
}

export interface MapRow {
  id: string; // live: message id; fold: span fromId
  kind: "live" | "fold";
  role: string; // message role, or "fold"
  tokens: number; // live: message tokens; fold: hidden member tokens
  msgs: number; // live: 1; fold: member count
  text: string; // live: snippet; fold: summary or "(no summary)"
}

/**
 * Whole-context map for context_map: one row per live message and one per fold,
 * in conversation order. The orientation view the model reads to pick ranges for
 * a batch collapse — complements searchMessages (find-by-content) with
 * find-by-position. Pure and tested in isolation.
 */
export function buildContextMap(
  msgs: BranchMsg[],
  spans: Span[],
  snippetLen = 60,
): MapRow[] {
  const spanByFrom = new Map(spans.map((s) => [s.fromId, s] as const));
  const tokById = new Map(
    msgs.map((m) => [m.id, estimateTokens(m.message)] as const),
  );
  // Non-first members are hidden behind their span's stub -> no own row.
  const hiddenMembers = new Set<string>();
  for (const s of spans)
    for (const id of s.memberIds.slice(1)) hiddenMembers.add(id);
  const snip = (s: string) => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > snippetLen ? `${one.slice(0, snippetLen)}…` : one;
  };
  const rows: MapRow[] = [];
  for (const { id, message } of msgs) {
    if (hiddenMembers.has(id)) continue;
    const span = spanByFrom.get(id);
    if (span) {
      const tokens = span.memberIds.reduce(
        (t, m) => t + (tokById.get(m) ?? 0),
        0,
      );
      rows.push({
        id,
        kind: "fold",
        role: "fold",
        tokens,
        msgs: span.memberIds.length,
        text: span.summary || "(no summary)",
      });
      continue;
    }
    rows.push({
      id,
      kind: "live",
      role: message.role,
      tokens: estimateTokens(message),
      msgs: 1,
      text: snip(serializeContent(message)),
    });
  }
  return rows;
}

/**
 * Build the context overlay: replace forgotten ranges with a stub, and pass
 * every live message through UNTOUCHED. Live messages are not prefixed; the
 * model reads their ids from context_map/_search/_peek. Untouched live messages
 * keep the provider's native prefix cache intact (no per-call mutation).
 * Mutates only the replaced (span-first) message objects in place (like the pi
 * context handler). `active` must be branchMessages(buildContextEntries()) so
 * ids correlate with what the context event actually carries.
 */
export function buildOverlay(
  messages: AgentMessageLike[],
  active: BranchMsg[],
  spans: Span[],
): AgentMessageLike[] {
  // Entry ids in context order per (timestamp,role) as a queue, to consume equal
  // keys position-stably. Needed because the provider message objects carry no
  // entry id; timestamp+role is the only shared key (see index.ts header).
  const idQueues = new Map<string, string[]>();
  // Per entry id, its estimated token footprint (matches event.messages
  // content). Used for a span stub's hidden-token label.
  const idTokens = new Map<string, number>();
  for (const { id, message: msg } of active) {
    const key = `${msg.timestamp}|${msg.role}`;
    const queue = idQueues.get(key) ?? idQueues.set(key, []).get(key)!;
    queue.push(id);
    idTokens.set(id, estimateTokens(msg));
  }

  const spanByFrom = new Map(spans.map((s) => [s.fromId, s] as const));
  const hiddenMembers = new Set<string>();
  for (const s of spans)
    for (const id of s.memberIds.slice(1)) hiddenMembers.add(id);

  const out: AgentMessageLike[] = [];
  for (const message of messages) {
    if (!TAGGABLE_ROLES.has(message.role)) {
      out.push(message);
      continue;
    }
    const id = idQueues.get(`${message.timestamp}|${message.role}`)?.shift();
    if (!id) {
      out.push(message);
      continue;
    }
    if (hiddenMembers.has(id)) continue; // non-first member of a span -> drop
    const span = spanByFrom.get(id);
    if (span) {
      const n = span.memberIds.length;
      const hidden = span.memberIds.reduce(
        (t, m) => t + (idTokens.get(m) ?? 0),
        0,
      );
      message.role = "user";
      message.content = stubText(span.summary, n, hidden);
      message.details = undefined;
      message.toolCallId = undefined;
      out.push(message);
      continue;
    }
    // Live (non-folded) message: pass through unmodified.
    out.push(message);
  }
  return out;
}
