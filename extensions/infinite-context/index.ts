/**
 * Infinite Context - the agent edits its own context (imperative shell).
 *
 * Idea: the agent references messages by id via five context_ tools. Ids are
 * NOT prefixed onto live messages; the agent learns them from context_map
 * (whole-context orientation list: id + role + tokens + snippet + fold state)
 * and from context_search/context_peek. context_fold (fold a range, with an
 * optional summary) and context_unfold (restore a fold or a sub-range, which
 * splits it) are the mutators; context_map, context_peek (read folds' contents)
 * and context_search (find by keyword) are the reads. Nothing in the overlay
 * carries an inline `[#id]` — not even fold stubs: ids exist only in tool
 * results, one uniform rule.
 *
 * Why no inline `[#id]` anywhere: per-message prefixes trained ~85% first-token
 * imitation (the model echoed markers into its own output) and cost marker
 * tokens on every message every call, for ids the map already exposes. Dropping
 * them removes the imitation-defense machinery and keeps live messages byte-
 * identical across calls (native prompt cache intact). Fold stubs followed for
 * the same reasons: the id was readable inline only in the rare "unfold what
 * I'm looking at" case, which now costs one context_map call — and
 * context_fold's own result already printed the fold id anyway.
 *
 * Why the id lookup needs the session entries: the provider serializes only
 * `role` + `content`; extra fields on the message object never reach the model,
 * and the entry `id` lives only on the session *entry*, not on the AgentMessage
 * (see docs/session-format.md). So the context handler correlates entry <->
 * message via `timestamp`+`role`.
 *
 * Why buildContextEntries() and not getBranch(): after pi's native compaction
 * the raw branch still contains messages the model no longer sees. The tools
 * must describe the ACTIVE context (map/search/fold over what is actually
 * sent), so they read buildContextEntries() — compaction applied, summaries
 * included. Spans referencing compacted-away members are reconciled lazily
 * (reconcileSpans) so folds never report phantom savings. Only the persisted
 * span list is still reconstructed from getBranch(): its custom entries can
 * predate the compaction cut.
 *
 * Persistence: the cumulative span list is written via pi.appendEntry as a
 * custom entry into the session and reconstructed in session_start/session_tree
 * (analogous to examples/extensions/todo.ts).
 *
 * This file is only the shell: wire pi events/tools. All logic is pure in
 * ./core.ts (tested via ./core.test.ts).
 *
 * Docs: docs/extensions.md ("context" event, registerTool, appendEntry),
 *       docs/session-format.md (entry/message types, getBranch, ids).
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type AgentMessageLike,
  type BranchEntry,
  type BranchMsg,
  type Span,
  INFINITE_CONTEXT_ENTRY,
  branchMessages,
  buildContextMap,
  type MapRow,
  buildOverlay,
  fmtTokens,
  planFold,
  planUnfold,
  planNudge,
  type SearchHit,
  reconcileSpans,
  reconstructSpans,
  searchMessages,
  serializeSpan,
  summarizeTree,
} from "./core.ts";

// Ids appear as `[#id]` in tool output, so the model tends to echo the `#`
// back. Strip one leading `#` at the tool boundary (parse, don't validate) so
// `#5` and `5` resolve identically; core only ever sees bare ids.
const bareId = (id: string) => id.replace(/^#/, "");

// --- preview formatting helpers (TUI only) -------------------------------
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
// All numeric sizes in this extension are TOKEN estimates (chars/4). The `tok`
// suffix disambiguates them from the `msgs` count on the same preview line.
const tok = (n: number) => `${fmtTokens(n)} tok`;

// Context fill as "20% (202.5k/1000k)", or "" when unknown.
function ctxFill(contextWindow: number, contextTokens: number | null): string {
  return contextWindow > 0 && contextTokens != null
    ? `${Math.round((contextTokens / contextWindow) * 100)}% (${fmtTokens(contextTokens)}/${fmtTokens(contextWindow)})`
    : "";
}

// Shared, symmetric overview tail (model-facing): totals + budget, identical
// after either mutator so the model always sees the same map + pressure.
function overviewTail(spans: Span[], msgs: BranchMsg[]): string {
  const { totalSpans, hiddenTokens } = summarizeTree(spans, msgs);
  return `folds: ${totalSpans} · ${tok(hiddenTokens)} hidden`;
}

// Projected context fill after a mutation. getContextUsage().tokens reflects the
// LAST assistant usage (agent-session.js), so a just-made fold only shows on the
// next call. Project it from last + the net token delta (fold: negative,
// unfold: positive) so the reported numbers reconcile in place. Empty when the
// last usage is unknown (e.g. right after compaction).
function projectedCtx(
  usage: { contextWindow: number; tokens: number | null } | undefined,
  deltaTokens: number,
): string {
  const win = usage?.contextWindow ?? 0;
  const last = usage?.tokens ?? null;
  if (win <= 0 || last == null) return "";
  const proj = Math.max(0, last + deltaTokens);
  return ` → ctx ~${Math.round((proj / win) * 100)}% (last ${Math.round((last / win) * 100)}%)`;
}

// Signed percentage of the context window; sign derived from the value (never a
// hardcoded prefix), so a non-saving fold can't print a double minus.
function pctOf(deltaTokens: number, contextWindow: number): string {
  if (contextWindow <= 0) return "";
  const p = (deltaTokens / contextWindow) * 100;
  return ` (${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%)`;
}

// Shared TUI detail for the two inverse mutators (fold/unfold).
interface MutateDetails {
  action: "fold" | "unfold";
  ok: boolean; // applied something
  msgs: number; // messages folded / restored
  deltaTokens: number; // freed (fold) / restored (unfold)
  tail: string; // standing state line (folds · hidden · ctx)
  summaries: string[]; // fold digests (empty for unfold)
  failed: string[]; // unresolved ids
  failLabel: string; // "unknown" | "not folded"
}

// One renderer for both mutators: the host TUI shows a terse action line in its
// compact view, then standing state + digests/failures when the host API
// requests details (`opts.expanded`). Symmetric glyphs ⊟ (fold) / ⊞ (unfold).
function renderMutate(
  d: MutateDetails,
  opts: ToolRenderResultOptions,
  theme: Theme,
): Text {
  const fold = d.action === "fold";
  const glyph = fold ? "⊟" : "⊞";
  const past = fold ? "folded" : "unfolded";
  const verb = fold ? "freed" : "restored";
  const color: ThemeColor = d.ok ? "success" : "warning";
  const head = d.ok
    ? `${glyph} ${past} ${plural(d.msgs, "msg")} · ${verb} ${tok(d.deltaTokens)}`
    : `${glyph} nothing ${past} · ${d.failed.length} ${d.failLabel}`;
  if (!opts.expanded) return new Text(theme.fg(color, head), 0, 0);
  const lines = [theme.fg(color, head)];
  if (d.ok) {
    lines.push(theme.fg("dim", d.tail));
    for (const s of d.summaries) lines.push(theme.fg("dim", `→ ${s}`));
  }
  if (d.failed.length)
    lines.push(theme.fg("warning", `${d.failLabel}: ${d.failed.join(", ")}`));
  return new Text(lines.join("\n"), 0, 0);
}

export default function (pi: ExtensionAPI) {
  // In-memory source of truth, reconstructed from the session.
  let spans: Span[] = [];

  const persist = () => pi.appendEntry(INFINITE_CONTEXT_ENTRY, { spans });
  // Active context entries (native compaction applied) as addressable messages.
  const activeMsgs = (ctx: ExtensionContext) =>
    branchMessages(
      ctx.sessionManager.buildContextEntries() as unknown as BranchEntry[],
    );
  // Drop span members that native compaction removed from the active context;
  // persists only when something actually changed (idempotent otherwise).
  const reconcile = (msgs: BranchMsg[]) => {
    const r = reconcileSpans(spans, msgs);
    spans = r.spans;
    if (r.changed) persist();
    return msgs;
  };
  const reconstruct = (ctx: ExtensionContext) => {
    // Raw branch, not buildContextEntries(): the last infinite-context custom
    // entry can lie before a later compaction cut.
    spans = reconstructSpans(
      ctx.sessionManager.getBranch() as unknown as BranchEntry[],
    );
    reconcile(activeMsgs(ctx));
  };

  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

  // Nudge the agent to fold before it runs out of context. On each turn we read
  // the context fill and, when it first crosses a 5-point band at/above 75%,
  // steer a one-off note toward the context_ tools (see planNudge). In-memory
  // only: the worst case after a reload is one extra nudge. getContextUsage()
  // has no `percent`, so derive it from tokens/contextWindow (guard null/0),
  // like the previews above.
  let lastNudgedBand = 0;
  pi.on("turn_end", async (event, ctx) => {
    const usage = ctx.getContextUsage();
    const win = usage?.contextWindow ?? 0;
    const tokens = usage?.tokens ?? null;
    if (win <= 0 || tokens == null) return; // fill unknown (e.g. post-compaction)
    const percent = (tokens / win) * 100;
    // Only steer on a continuing turn: the note then lands before the model's
    // next LLM call, not while it sits idle at the user prompt.
    const message = event.message as { stopReason?: string };
    const continuing =
      message.stopReason === "toolUse" && event.toolResults.length > 0;
    const { nudge, band } = planNudge(percent, lastNudgedBand, continuing);
    lastNudgedBand = band;
    if (!nudge) return;
    pi.sendMessage(
      {
        customType: "infinite-context/nudge",
        content:
          `<context-maintenance>\nContext is ~${Math.round(percent)}% full. ` +
          `Before continuing, run context_map, then batch a context_fold ` +
          `of completed or superseded material. Preserve the active request, ` +
          `open loops, unresolved errors, and evidence you still need. ` +
          `A no-op is valid if nothing is safe to fold.\n</context-maintenance>`,
        display: true,
        details: { band },
      },
      { deliverAs: "steer" },
    );
  });

  // Replace folded ranges with a stub; live messages pass through untouched.
  pi.on("context", async (event, ctx) => {
    const messages = buildOverlay(
      event.messages as AgentMessageLike[],
      activeMsgs(ctx),
      spans,
    );
    return { messages: messages as unknown as typeof event.messages };
  });

  // --- map (read-only orientation) -----------------------------------------

  pi.registerTool({
    name: "context_map",
    label: "Context map",
    description:
      "Index your active conversation context in order. Live rows show [#id] · role · estimated tokens · snippet; " +
      "fold rows show [#id] · hidden size · summary. The header totals it up and adds context fill from the last " +
      "reported usage. All token numbers are chars/4 estimates. No arguments.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const msgs = reconcile(activeMsgs(ctx));
      const rows = buildContextMap(msgs, spans);
      const usage = ctx.getContextUsage();
      const { totalSpans, hiddenTokens } = summarizeTree(spans, msgs);
      const fill = ctxFill(usage?.contextWindow ?? 0, usage?.tokens ?? null);
      const header = `${rows.length} rows · folds: ${totalSpans} · ${tok(hiddenTokens)} hidden${fill ? ` · ctx ${fill}` : ""}`;
      const lines = rows.map((r) =>
        r.kind === "fold"
          ? `[#${r.id}] ⊟ ${plural(r.msgs, "msg")} · ${tok(r.tokens)} hidden · ${r.text}`
          : `[#${r.id}] ${r.role} · ${tok(r.tokens)} · ${r.text}`,
      );
      const text = rows.length
        ? `${header}\n${lines.join("\n")}`
        : "Context is empty.";
      return {
        content: [{ type: "text", text }],
        details: { rows, header } as { rows: MapRow[]; header: string },
      };
    },
    renderResult(result, opts, theme) {
      const d = result.details as
        | { rows: MapRow[]; header: string }
        | undefined;
      if (!d) return new Text("", 0, 0);
      const head = `▤ ${d.header}`;
      if (!opts.expanded) return new Text(theme.fg("accent", head), 0, 0);
      const lines = [
        theme.fg("accent", head),
        ...d.rows.map((r) =>
          theme.fg(
            "dim",
            r.kind === "fold"
              ? `[#${r.id}] ⊟ ${plural(r.msgs, "msg")} · ${tok(r.tokens)} · ${r.text}`
              : `[#${r.id}] ${r.role} · ${tok(r.tokens)} · ${r.text}`,
          ),
        ),
      ];
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // --- fold ----------------------------------------------------------------

  const FoldParam = Type.Object({
    items: Type.Array(
      Type.Object({
        from: Type.String({
          description:
            "Start id, as shown by context_map, context_search, or context_peek.",
        }),
        to: Type.Optional(
          Type.String({
            description:
              "Inclusive end id. Defaults to `from`; either order is accepted.",
          }),
        ),
        summary: Type.Optional(
          Type.String({
            description:
              "Short digest kept visible in the stub. Omit to leave only a bare stub (for pure noise).",
          }),
        ),
      }),
      {
        description:
          "Inclusive ranges to fold. Batch independent ranges in one call.",
      },
    ),
  });

  pi.registerTool({
    name: "context_fold",
    label: "Context fold",
    description:
      "Replace inclusive message ranges with reversible fold stubs. A supplied summary stays visible in the stub; " +
      "hidden messages remain available to context_search, context_peek, and context_unfold. If a range touches an " +
      "assistant turn that made tool calls, the whole turn and all its tool results fold together. Existing folds " +
      "touched by a range are absorbed whole, joining their summaries.",
    promptSnippet:
      "Reversibly fold completed conversation history; use context_map for ids and context_search/context_peek/context_unfold to recover it",
    promptGuidelines: [
      "Use context_fold on your own, without being asked, whenever completed material bloats your active context — typically after finishing an exploration, debugging, implementation, or verification phase, and after several large tool results. Good candidates: digested file reads and logs, redundant re-reads, superseded plans and old file versions, completed steps, and dead ends. Fold before the context limit forces coarser auto-compaction.",
      "Do not fold governing instructions (loaded skills, AGENTS.md), the active request, unresolved errors, open decisions, or anything needed verbatim soon. Fold only when the stub or summary is materially smaller than what it hides.",
      "In a context_fold summary, keep only what is likely to matter later: open loops, current state (paths, symbols, passing tests), decisions with rejected options, and gotchas. For a dead end, one line: 'tried X, failed because Y'. Drop narration and raw output. Omit the summary entirely when nothing is worth keeping.",
      "Use context_map to pick ranges and batch independent ranges into one context_fold call. To recover folded detail: context_search to locate, context_peek to read in place, context_unfold only when messages must return to the active context.",
    ],
    parameters: FoldParam,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const msgs = reconcile(activeMsgs(ctx));
      const items = params.items.map((it) => ({
        ...it,
        from: bareId(it.from),
        to: it.to === undefined ? undefined : bareId(it.to),
      }));
      const plan = planFold(msgs, spans, items);
      spans = plan.spans;
      if (plan.folded) persist();
      const usage = ctx.getContextUsage();
      const win = usage?.contextWindow ?? 0;
      const tail = overviewTail(spans, msgs);
      // Fold lowers live tokens -> delta is negative; freedTokens is the
      // positive magnitude. freedTokens <= 0 means the stub/summary is as big as
      // the hidden content: the fold still applied, but there is no net saving.
      const saved = plan.freedTokens > 0;
      const head = plan.applied.length
        ? `+ folded ${plural(plan.folded, "msg")} into ${plural(plan.applied.length, "fold")}: ${plan.applied.join(", ")}, ` +
          (saved
            ? `freed ${fmtTokens(plan.freedTokens)}${pctOf(-plan.freedTokens, win)}`
            : "no net saving (stub/summary ≥ hidden content)") +
          projectedCtx(usage, -plan.freedTokens) +
          (plan.unknown.length
            ? `. unknown id(s): ${plan.unknown.join(", ")}`
            : "")
        : `Folded nothing. unknown id(s): ${plan.unknown.join(", ")}`;
      return {
        content: [{ type: "text", text: `${head}\n${tail}` }],
        details: {
          action: "fold",
          ok: plan.applied.length > 0,
          msgs: plan.folded,
          deltaTokens: plan.freedTokens,
          tail,
          summaries: plan.summaries.filter((s) => s),
          failed: plan.unknown,
          failLabel: "unknown",
        } as MutateDetails,
      };
    },
    renderResult(result, opts, theme) {
      const d = result.details as MutateDetails | undefined;
      return d ? renderMutate(d, opts, theme) : new Text("", 0, 0);
    },
  });

  // --- unfold --------------------------------------------------------------

  const UnfoldParam = Type.Object({
    items: Type.Array(
      Type.Object({
        from: Type.String({
          description:
            "Id of a fold stub or of a hidden message. Without `to`, restores its whole fold.",
        }),
        to: Type.Optional(
          Type.String({
            description:
              "Inclusive end id of a sub-range. Must belong to the SAME fold as `from`, else the item is rejected. Set it equal to `from` to restore a single hidden message.",
          }),
        ),
      }),
      {
        description:
          "Folds or inclusive hidden sub-ranges to restore. Batch several in one call.",
      },
    ),
  });

  pi.registerTool({
    name: "context_unfold",
    label: "Context unfold",
    description:
      "Restore folded messages — inverse of context_fold. Restores a whole fold, or the from..to sub-range, " +
      "which splits the fold and leaves up to two remainder folds, each carrying the original summary. Assistant " +
      "turns with tool calls move together with all their tool results. To only read folded content, use " +
      "context_peek instead.",
    parameters: UnfoldParam,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const msgs = reconcile(activeMsgs(ctx));
      const items = params.items.map((it) => ({
        ...it,
        from: bareId(it.from),
        to: it.to === undefined ? undefined : bareId(it.to),
      }));
      const plan = planUnfold(msgs, spans, items);
      spans = plan.spans;
      if (plan.applied.length) persist();
      const usage = ctx.getContextUsage();
      const win = usage?.contextWindow ?? 0;
      const tail = overviewTail(spans, msgs);
      // Unfold raises live tokens -> delta is positive (net: members + remnant
      // stubs − removed stub).
      // Cross-fold ranges are rejected rather than clamped, so they are reported
      // separately from ids that simply are not folded.
      const failed = [...plan.noop, ...plan.invalid];
      const head =
        (plan.applied.length
          ? `− unfolded ${plural(plan.restoredMsgs, "msg")}: ${plan.applied.join(", ")}, restored ${fmtTokens(plan.restoredTokens)}${pctOf(plan.restoredTokens, win)}${projectedCtx(usage, plan.restoredTokens)}`
          : "Unfolded nothing") +
        (plan.noop.length ? `. not folded: ${plan.noop.join(", ")}` : "") +
        (plan.invalid.length
          ? `. \`to\` outside \`from\`'s fold: ${plan.invalid.join(", ")}`
          : "");
      return {
        content: [{ type: "text", text: `${head}\n${tail}` }],
        details: {
          action: "unfold",
          ok: plan.applied.length > 0,
          msgs: plan.restoredMsgs,
          deltaTokens: plan.restoredTokens,
          tail,
          summaries: [],
          failed,
          failLabel: "not restorable",
        } as MutateDetails,
      };
    },
    renderResult(result, opts, theme) {
      const d = result.details as MutateDetails | undefined;
      return d ? renderMutate(d, opts, theme) : new Text("", 0, 0);
    },
  });

  // --- peek (read-only) ----------------------------------------------------

  const PeekParam = Type.Object({
    ids: Type.Array(
      Type.String({
        description:
          "Id of a fold stub or of a hidden message; both resolve to the containing fold.",
      }),
      {
        description:
          "Fold ids to read, batched. Ids resolving to the same fold are printed once.",
      },
    ),
  });

  pi.registerTool({
    name: "context_peek",
    label: "Context peek",
    description:
      "Read folded messages without unfolding them. Prints each hidden message's id, role, estimated tokens and " +
      "text, capped at about 2000 characters PER message.",
    parameters: PeekParam,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const msgs = reconcile(activeMsgs(ctx));
      const seen = new Set<string>();
      const blocks: string[] = [];
      const missing: string[] = [];
      let members = 0;
      for (const rawId of params.ids) {
        const id = bareId(rawId);
        const span = spans.find(
          (s) => s.fromId === id || s.memberIds.includes(id),
        );
        if (!span) {
          missing.push(id);
          continue;
        }
        if (seen.has(span.fromId)) continue;
        seen.add(span.fromId);
        members += span.memberIds.length;
        blocks.push(
          `fold [#${span.fromId}] · ${span.memberIds.length} members:\n\n${serializeSpan(span, msgs)}`,
        );
      }
      const text =
        [
          blocks.join("\n\n———\n\n"),
          missing.length ? `no fold for: ${missing.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n") || "No folds for those ids.";
      return {
        content: [{ type: "text", text }],
        details: { folds: seen.size, members, missing } as {
          folds: number;
          members: number;
          missing: string[];
        },
      };
    },
    renderResult(result, opts, theme) {
      const d = result.details as
        | { folds: number; members: number; missing: string[] }
        | undefined;
      if (!d) return new Text("", 0, 0);
      if (!d.folds)
        return new Text(theme.fg("warning", "◈ no folds for those ids"), 0, 0);
      const head = `◈ ${plural(d.folds, "fold")} · ${plural(d.members, "member")}`;
      if (!opts.expanded) return new Text(theme.fg("accent", head), 0, 0);
      const lines = [theme.fg("accent", head)];
      if (d.missing.length)
        lines.push(theme.fg("warning", `missing: ${d.missing.join(", ")}`));
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // --- search (read-only, find-by-content) ---------------------------------

  const SearchParam = Type.Object({
    queries: Type.Array(
      Type.String({
        description: "Case-insensitive literal substring (not a regex).",
      }),
      {
        description:
          "Substrings to search, batched; each returns its own hit group.",
      },
    ),
  });

  pi.registerTool({
    name: "context_search",
    label: "Context search",
    description:
      "Search live messages, folded messages, and fold summaries for a literal substring, case-insensitively. " +
      "Returns at most one hit per message (its first occurrence) and shows up to 20 per query, with [#id], role " +
      "(a matched summary has role 'fold'), the containing fold if any, and a snippet.",
    parameters: SearchParam,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const msgs = reconcile(activeMsgs(ctx));
      const groups = params.queries.map((q) => ({
        q,
        ...searchMessages(msgs, spans, q, 20),
      }));
      const text = groups
        .map((g) =>
          g.total
            ? `${g.total} hit(s) for "${g.q}"${g.total > g.hits.length ? ` (showing ${g.hits.length})` : ""}:\n` +
              g.hits
                .map(
                  (h) =>
                    `[#${h.id}] ${h.role}${h.foldFrom ? ` (folded in [#${h.foldFrom}])` : ""} · ${h.snippet}`,
                )
                .join("\n")
            : `No hits for "${g.q}".`,
        )
        .join("\n\n");
      const total = groups.reduce((t, g) => t + g.total, 0);
      const allHits = groups.flatMap((g) => g.hits);
      return {
        content: [{ type: "text", text }],
        details: {
          queries: params.queries,
          total,
          folded: allHits.filter((h) => h.foldFrom).length,
          hits: allHits,
        } as {
          queries: string[];
          total: number;
          folded: number;
          hits: SearchHit[];
        },
      };
    },
    renderResult(result, opts, theme) {
      const d = result.details as
        | {
            queries: string[];
            total: number;
            folded: number;
            hits: SearchHit[];
          }
        | undefined;
      if (!d) return new Text("", 0, 0);
      if (!d.total)
        return new Text(
          theme.fg(
            "muted",
            `⌕ no hits for ${d.queries.map((q) => `"${q}"`).join(", ")}`,
          ),
          0,
          0,
        );
      const head =
        `⌕ ${plural(d.total, "hit")} for ${d.queries.map((q) => `"${q}"`).join(", ")}` +
        (d.folded ? ` · ${d.folded} folded` : "");
      if (!opts.expanded) return new Text(theme.fg("accent", head), 0, 0);
      const rows = d.hits.map((h) =>
        theme.fg(
          "dim",
          `[#${h.id}] ${h.role}${h.foldFrom ? ` (in ${h.foldFrom})` : ""} · ${h.snippet}`,
        ),
      );
      return new Text([theme.fg("accent", head), ...rows].join("\n"), 0, 0);
    },
  });
}
