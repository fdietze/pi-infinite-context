import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type Forest,
  type Item,
  INFINITE_CONTEXT_ENTRY,
  allItems,
  findItem,
  messageItem,
  originalIds,
  parseSnapshot,
  replaceRootSummary,
  snapshot,
  syncOriginals,
  wrapRootRanges,
} from "./forest.ts";
import {
  type OriginalMessage,
  branchOriginals,
  buildOverlay,
  estimateContextTokens,
  planRootRanges,
  serializeMessage,
  validateToolUnitOwnership,
} from "./messages.ts";
import { planNudge } from "./nudge.ts";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_OUTPUT_BYTES,
  boundOutput,
  lineWindow,
  parsePage,
} from "./output.ts";
import {
  SEARCH_MATCHES_PER_ITEM,
  SEARCH_MATCHES_PER_PATTERN,
  compilePattern,
  searchArchive,
} from "./search.ts";

const MAX_ID_LENGTH = 128;
const MAX_PATTERN_LENGTH = 4096;
const MAX_SUMMARY_LENGTH = 12_000;
// Leave headroom for TypeBox's per-item error paths and pretty-printed argument echo
// while still admitting the schema's 12,000-character ASCII summary.
const MAX_PREPARED_ARGUMENT_BYTES = 12 * 1024;
const bareId = (id: string) => id.replace(/^#/, "");
const IdParam = (description: string) =>
  Type.String({ description, minLength: 1, maxLength: MAX_ID_LENGTH });
const SummaryParam = (description: string) =>
  Type.String({ description, maxLength: MAX_SUMMARY_LENGTH });

/** Pi echoes invalid arguments, so discard only whole provider payloads above the byte budget. */
function prepareArguments<T>(value: unknown): T {
  const json = JSON.stringify(value);
  return (json !== undefined && Buffer.byteLength(json, "utf8") > MAX_PREPARED_ARGUMENT_BYTES
    ? 0
    : value) as T;
}
const fmtTokens = (tokens: number) =>
  tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;

const PageParams = {
  offset: Type.Optional(
    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT }),
  ),
};

function directItems(roots: Forest, id?: string): { label: string; items: Forest } {
  if (!id) return { label: "roots", items: roots };
  const item = findItem(roots, id);
  if (!item) throw new Error("Unknown node id");
  if (item.kind !== "fold") throw new Error("A message node has no children");
  return { label: `children of ${id}`, items: item.children };
}

function previewText(text: string): string {
  const characters = [...text.replace(/\s+/g, " ").trim()];
  return characters.length > 100
    ? `${characters.slice(0, 100).join("")}…`
    : characters.join("");
}

function itemPreview(item: Item, byId: ReadonlyMap<string, OriginalMessage>): string {
  if (item.kind === "fold") {
    const preview = previewText(item.summary) || "(empty summary)";
    return `[#${item.id}] fold · ${item.children.length} direct children · ${originalIds([item]).length} messages · ${preview}`;
  }
  const original = byId.get(item.id)!;
  const preview = previewText(serializeMessage(original.message)) || "(empty text projection)";
  return `[#${item.id}] ${original.message.role} · ~${fmtTokens(estimateContextTokens(original.message))} tokens · ${preview}`;
}

function visibleTokens(roots: Forest, byId: ReadonlyMap<string, OriginalMessage>): number {
  return roots.reduce((total, item) => {
    if (item.kind === "message") return total + estimateContextTokens(byId.get(item.id)!.message);
    const ids = originalIds([item]);
    const hasProjectionAnchor = ids.some((id) => {
      const message = byId.get(id)!.message;
      return message.role !== "bashExecution" || !message.excludeFromContext;
    });
    if (!hasProjectionAnchor) return total;
    const text = item.summary || `(folded archive: ${ids.length} messages)`;
    return total + Math.ceil(text.length / 4);
  }, 0);
}

export default function infiniteContext(pi: ExtensionAPI) {
  let roots: Forest = [];
  let stateError: Error | undefined;
  let loaded = false;
  let lastNudgedBand = 0;

  const branch = (ctx: ExtensionContext): SessionEntry[] =>
    ctx.sessionManager.getBranch();

  const load = (ctx: ExtensionContext) => {
    stateError = undefined;
    loaded = true;
    try {
      const entries = branch(ctx);
      if (entries.some((entry) => entry.type === "compaction"))
        throw new Error(
          "This session already contains native compaction and is incompatible with infinite-context v2; start a new session.",
        );
      const originals = branchOriginals(entries);
      let saved: Extract<SessionEntry, { type: "custom" }> | undefined;
      for (const entry of entries)
        if (entry.type === "custom" && entry.customType === INFINITE_CONTEXT_ENTRY)
          saved = entry;
      roots = saved
        ? parseSnapshot(saved.data).roots
        : originals.map(({ id }) => messageItem(id));
      roots = syncOriginals(roots, originals.map(({ id }) => id));
      validateToolUnitOwnership(roots, originals);
    } catch (error) {
      stateError = error as Error;
      roots = [];
      ctx.ui.notify(`infinite-context: ${stateError.message}`, "error");
    }
  };

  const current = (ctx: ExtensionContext) => {
    // Some headless SDK hosts do not emit session_start on programmatic reload.
    // Lazy loading keeps snapshot restoration correct without host-specific hooks.
    if (!loaded) load(ctx);
    if (stateError) throw stateError;
    const entries = branch(ctx);
    if (entries.some((entry) => entry.type === "compaction"))
      throw new Error(
        "Native compaction is incompatible with infinite-context v2; start a new session.",
      );
    const originals = branchOriginals(entries);
    const derivedRoots = syncOriginals(roots, originals.map(({ id }) => id));
    validateToolUnitOwnership(derivedRoots, originals);
    return {
      roots: derivedRoots,
      originals,
      byId: new Map(originals.map((original) => [original.id, original] as const)),
    };
  };

  const persist = (next: Forest) => {
    roots = next;
    pi.appendEntry(INFINITE_CONTEXT_ENTRY, snapshot(roots));
  };

  pi.on("session_start", async (_event, ctx) => load(ctx));
  pi.on("session_tree", async (_event, ctx) => load(ctx));

  pi.on("context", async (event, ctx) => {
    if (stateError) return;
    const state = current(ctx);
    return {
      messages: buildOverlay(event.messages, state.originals, state.roots),
    };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    ctx.ui.notify(
      `infinite-context blocked ${event.reason} compaction: the fold tree is the sole compactor. Fold more context or start a new session if the provider reports overflow.`,
      "warning",
    );
    return { cancel: true };
  });

  pi.on("turn_end", async (event, ctx) => {
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? 0;
    const tokens = usage?.tokens ?? null;
    if (window <= 0 || tokens == null) return;
    const percent = (tokens / window) * 100;
    const message = event.message as { stopReason?: string };
    const continuing = message.stopReason === "toolUse" && event.toolResults.length > 0;
    const planned = planNudge(percent, lastNudgedBand, continuing);
    lastNudgedBand = planned.band;
    if (!planned.nudge) return;
    pi.sendMessage(
      {
        customType: "infinite-context/nudge",
        content:
          `<context-maintenance>\nContext is ~${Math.round(percent)}% full. ` +
          "Use context_map, then context_fold completed or superseded roots. " +
          "Keep the active request, open loops, unresolved errors, and evidence needed soon. " +
          "Native compaction is blocked, so an actual overflow will remain visible.\n</context-maintenance>",
        display: true,
        details: { band: planned.band },
      },
      { deliverAs: "steer" },
    );
  });

  pi.registerTool({
    name: "context_map",
    label: "Context map",
    description:
      "List ordered visible roots, or the direct children of one fold. Output is paginated and previews are bounded; it never recursively dumps a subtree.",
    parameters: Type.Object({
      id: Type.Optional(IdParam("Fold id whose direct children to list. Omit for visible roots.")),
      ...PageParams,
    }),
    executionMode: "sequential",
    prepareArguments,
    async execute(_callId, params, _signal, _update, ctx) {
      const state = current(ctx);
      const page = parsePage(params.offset, params.limit);
      const id = params.id === undefined ? undefined : bareId(params.id);
      const listing = directItems(state.roots, id);
      const start = page.offset - 1;
      const selected = listing.items.slice(start, start + page.limit);
      const rows = selected.map((item) => itemPreview(item, state.byId));
      const end = selected.length ? start + selected.length : start;
      const footer = `${listing.label}: items ${selected.length ? `${page.offset}-${end}` : "none"} of ${listing.items.length}`;
      return {
        content: [{ type: "text", text: boundOutput([...rows, footer].join("\n")) }],
        details: { count: selected.length, total: listing.items.length, id },
      };
    },
  });

  pi.registerTool({
    name: "context_peek",
    label: "Context peek",
    description:
      `Read one original message's serialized text or exactly one fold's summary without changing context. ` +
      `Uses 1-based line windows (default ${DEFAULT_PAGE_LIMIT}); every result reports total item lines. Output is capped at ${MAX_OUTPUT_BYTES} UTF-8 bytes, so a giant line may be clipped.`,
    parameters: Type.Object({
      id: IdParam("Stable message or fold id from context_map or context_search."),
      ...PageParams,
    }),
    executionMode: "sequential",
    prepareArguments,
    async execute(_callId, params, _signal, _update, ctx) {
      const state = current(ctx);
      const id = bareId(params.id);
      const item = findItem(state.roots, id);
      if (!item) throw new Error("Unknown node id");
      const page = parsePage(params.offset, params.limit);
      const text = item.kind === "fold" ? item.summary : serializeMessage(state.byId.get(item.id)!.message);
      const window = lineWindow(text, page.offset, page.limit, MAX_OUTPUT_BYTES - 500);
      const kind = item.kind === "fold" ? "fold summary" : state.byId.get(item.id)!.message.role;
      const range = window.end >= window.start ? `${window.start}-${window.end}` : "none";
      const footer = `[#${id}] ${kind} · lines ${range} of ${window.totalLines}${window.clippedLine ? " · current line clipped by byte cap" : ""}`;
      return {
        content: [{ type: "text", text: boundOutput(`${window.text}${window.text ? "\n" : ""}${footer}`) }],
        details: { id, kind, totalLines: window.totalLines, start: window.start, end: window.end },
      };
    },
  });

  pi.registerTool({
    name: "context_search",
    label: "Context search",
    description:
      `Case-insensitive JavaScript regex search over every current-branch original and every reachable fold summary, once each. ` +
      `Returns stable ids and 1-based lines. Each pattern emits at most ${SEARCH_MATCHES_PER_ITEM} lines per item and ${SEARCH_MATCHES_PER_PATTERN} lines overall.`,
    parameters: Type.Object({
      patterns: Type.Array(Type.String({ description: "JavaScript regular expression; empty patterns are rejected.", minLength: 1, maxLength: MAX_PATTERN_LENGTH }), {
        minItems: 1,
        maxItems: 20,
      }),
    }),
    executionMode: "sequential",
    prepareArguments,
    async execute(_callId, params, _signal, _update, ctx) {
      const state = current(ctx);
      const groups = params.patterns.map((source) => {
        let pattern: RegExp;
        try {
          pattern = compilePattern(source);
        } catch {
          throw new Error("Invalid search pattern: malformed JavaScript regular expression");
        }
        return { source, result: searchArchive(state.originals, state.roots, pattern) };
      });
      const rendered = groups.map(({ source, result }) => {
        if (!result.totalMatchingLines) return `No hits for /${source}/.`;
        const lines = [
          `${result.totalMatchingLines} matching lines in ${result.totalMatchingItems} items for /${source}/:`,
        ];
        for (const hit of result.hits) {
          lines.push(
            `[#${hit.id}] ${hit.role}${hit.parentFoldId ? ` · child of [#${hit.parentFoldId}]` : " · root"}`,
            ...hit.matches.map((match) => `${match.line}: ${match.text}`),
          );
          if (hit.omittedMatches) lines.push(`… ${hit.omittedMatches} more matching lines in this item`);
        }
        if (result.capped) lines.push(`… capped at ${SEARCH_MATCHES_PER_PATTERN} emitted lines; refine the pattern`);
        return lines.join("\n");
      });
      return {
        content: [{ type: "text", text: boundOutput(rendered.join("\n\n")) }],
        details: { patterns: params.patterns, matches: groups.reduce((n, group) => n + group.result.totalMatchingLines, 0) },
      };
    },
  });

  pi.registerTool({
    name: "context_fold",
    label: "Context fold",
    description:
      "Wrap contiguous currently visible root ranges in new folds. Each explicit summary is the new fold's projection; existing folds become children unchanged. The batch is all-or-nothing and tool calls/results remain indivisible.",
    promptSnippet: "Fold completed context into a searchable recursive archive before the context limit",
    promptGuidelines: [
      "Use context_fold proactively after completed exploration, debugging, implementation, or verification phases and after large tool results; native compaction is blocked.",
      "Keep governing instructions, the active request, unresolved errors, open decisions, and evidence needed soon as visible roots. Fold only when the replacement is worthwhile.",
      "Write a short context_fold summary containing durable state, decisions, open loops, paths/symbols, and gotchas; use an empty summary only for disposable noise.",
      "Use context_map for root ids, context_search to locate archived text, context_peek to read it, and context_summary to replace only a visible root fold summary. Reads never unfold context.",
    ],
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          from: IdParam("First visible root id."),
          to: Type.Optional(IdParam("Inclusive visible root id; defaults to from.")),
          summary: SummaryParam("Exact new fold summary; an empty string is allowed."),
        }),
        { minItems: 1, maxItems: 50, description: "Disjoint root ranges; the mutation is atomic." },
      ),
    }),
    executionMode: "sequential",
    prepareArguments,
    async execute(_callId, params, _signal, _update, ctx) {
      const state = current(ctx);
      const requests = params.items.map((item) => ({
        from: bareId(item.from),
        to: item.to === undefined ? undefined : bareId(item.to),
        summary: item.summary,
      }));
      const planned = planRootRanges(state.roots, state.originals, requests);
      const existingIds = new Set(allItems(state.roots).map((item) => item.id));
      const ids = planned.map(() => {
        let id: string;
        do id = `fold-${randomUUID().slice(0, 8)}`;
        while (existingIds.has(id));
        existingIds.add(id);
        return id;
      });
      const ranges = planned.map((range, i) => ({ ...range, id: ids[i] }));
      const before = visibleTokens(state.roots, state.byId);
      const next = wrapRootRanges(state.roots, ranges);
      const after = visibleTokens(next, state.byId);
      persist(next);
      const delta = after - before;
      const effect = delta < 0 ? `freed ~${fmtTokens(-delta)} tokens` : delta > 0 ? `added ~${fmtTokens(delta)} tokens` : "no estimated context change";
      return {
        content: [{ type: "text", text: `Created ${ids.length} fold${ids.length === 1 ? "" : "s"}: ${ids.map((id) => `[#${id}]`).join(", ")} · ${effect}` }],
        details: { ids, deltaTokens: delta },
      };
    },
  });

  pi.registerTool({
    name: "context_summary",
    label: "Context summary",
    description:
      "Replace the summary of one currently visible root fold. Hidden fold summaries are immutable; an empty string clears the summary.",
    parameters: Type.Object({
      id: IdParam("Visible root fold id."),
      summary: SummaryParam("Exact replacement summary; empty clears it."),
    }),
    executionMode: "sequential",
    prepareArguments,
    async execute(_callId, params, _signal, _update, ctx) {
      const state = current(ctx);
      const id = bareId(params.id);
      const before = visibleTokens(state.roots, state.byId);
      const next = replaceRootSummary(state.roots, id, params.summary);
      const after = visibleTokens(next, state.byId);
      persist(next);
      const delta = after - before;
      return {
        content: [{ type: "text", text: `Updated [#${id}] summary · estimated live-context delta ${delta >= 0 ? "+" : ""}${delta} tokens` }],
        details: { id, deltaTokens: delta },
      };
    },
  });
}
