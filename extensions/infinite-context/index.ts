import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type Forest,
  INFINITE_CONTEXT_ENTRY,
  allItems,
  findItem,
  messageItem,
  parseSnapshot,
  snapshot,
  syncOriginals,
  wrapRootRanges,
} from "./forest.ts";
import { visibleTokens } from "./fold-projection.ts";
import { unknownIdError } from "./id-errors.ts";
import { assertSupportedBranch } from "./assert-supported-branch.ts";
import { branchOriginals, projectedPositions } from "./originals.ts";
import { ProjectionMismatchError, buildOverlay } from "./overlay.ts";
import { planRootRanges } from "./plan-root-ranges.ts";
import { serializeMessage } from "./serialize-message.ts";
import { validateToolUnitOwnership } from "./tool-units.ts";
import { nudgeSchedule, planNudge, reminderText } from "./nudge.ts";
import {
  DEFAULT_SETTINGS,
  type FileSettings,
  SETTINGS_ENTRY,
  type Settings,
  parseSettings,
  resolveSettings,
  settingsChanged,
} from "./settings.ts";
import { renderMap } from "./render-map.ts";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  boundOutput,
  fmtTokens,
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
const bareId = (id: string) => id.replace(/^#/, "");
const IdParam = (description: string) =>
  Type.String({ description, minLength: 1, maxLength: MAX_ID_LENGTH });
const SummaryParam = (description: string) =>
  Type.String({ description, maxLength: MAX_SUMMARY_LENGTH });

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
  if (!item) throw unknownIdError(id);
  if (item.kind !== "fold")
    throw new Error(`"${id}" is a message, not a fold: it has no children. Use context_peek to read it.`);
  return { label: `children of ${id}`, items: item.children };
}

function previewText(text: string): string {
  const characters = [...text.replace(/\s+/g, " ").trim()];
  return characters.length > 100
    ? `${characters.slice(0, 100).join("")}…`
    : characters.join("");
}

/**
 * Read this extension's settings next to pi's own agent config (getAgentDir() honors pi's
 * agent-dir override). A missing or unreadable file is the same as an empty one; parseSettings
 * decides what that means per field. Read once per load: changes apply after restart or /reload.
 */
function readSettings(): FileSettings {
  const file = path.join(getAgentDir(), "infinite-context", "settings.json");
  try {
    return parseSettings(fs.readFileSync(file, "utf8"));
  } catch {
    return parseSettings("");
  }
}

export default function infiniteContext(pi: ExtensionAPI) {
  const fileSettings = readSettings();
  let roots: Forest = [];
  let stateError: Error | undefined;
  let loaded = false;
  // Branch state: one Pi process can switch sessions (/new, /resume, /tree), so load() sets
  // both for the branch it loads; nothing leaks from the previous branch's reminder arm.
  let settings: Settings = DEFAULT_SETTINGS;
  let lastNudgedBand = 0;

  const branch = (ctx: ExtensionContext): SessionEntry[] =>
    ctx.sessionManager.getBranch();

  const load = (ctx: ExtensionContext) => {
    stateError = undefined;
    loaded = true;
    try {
      const entries = branch(ctx);
      assertSupportedBranch(entries);
      const originals = branchOriginals(entries, ctx.sessionManager.buildSessionProjection());
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
    resolveBranchSettings(ctx);
  };

  // Every branch states the settings it ran under, so cost and token analyses of a session
  // can be tied to its nudge limits. Appended only when the branch's latest record differs,
  // which also captures a settings change after /reload. The record also keeps a drawn limit
  // stable for the branch (resolveSettings).
  const resolveBranchSettings = (ctx: ExtensionContext) => {
    let recorded: unknown;
    for (const entry of branch(ctx))
      if (entry.type === "custom" && entry.customType === SETTINGS_ENTRY) recorded = entry.data;
    settings = resolveSettings(fileSettings, recorded, Math.random);
    lastNudgedBand = 0;
    if (settingsChanged(recorded, settings)) pi.appendEntry(SETTINGS_ENTRY, settings);
  };

  const current = (ctx: ExtensionContext) => {
    // Some headless SDK hosts do not emit session_start on programmatic reload.
    // Lazy loading keeps snapshot restoration correct without host-specific hooks.
    if (!loaded) load(ctx);
    if (stateError) throw stateError;
    const entries = branch(ctx);
    assertSupportedBranch(entries);
    const projection = ctx.sessionManager.buildSessionProjection();
    const originals = branchOriginals(entries, projection);
    const derivedRoots = syncOriginals(roots, originals.map(({ id }) => id));
    validateToolUnitOwnership(derivedRoots, originals);
    return {
      roots: derivedRoots,
      originals,
      positions: projectedPositions(projection),
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
    try {
      return {
        messages: buildOverlay(event.messages, state.positions, state.originals, state.roots),
      };
    } catch (error) {
      // Without a trustworthy position mapping, folding the request could drop a
      // tool result and break the turn: leave the request untouched and say so.
      if (!(error instanceof ProjectionMismatchError)) throw error;
      ctx.ui.notify(
        `infinite-context: folds are not applied to this request. ${error.message}`,
        "error",
      );
      return;
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    ctx.ui.notify(
      `infinite-context blocked ${event.reason} compaction: the fold tree is the sole compactor. Fold more context or start a new session if the provider reports overflow.`,
      "warning",
    );
    return { cancel: true };
  });

  pi.on("turn_end", async (event, ctx) => {
    // Same lazy load as current(): the branch's settings must be resolved before planning.
    if (!loaded) load(ctx);
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? 0;
    const tokens = usage?.tokens ?? null;
    if (window <= 0 || tokens == null) return;
    const message = event.message as { stopReason?: string };
    const continuing = message.stopReason === "toolUse" && event.toolResults.length > 0;
    const planned = planNudge(tokens, window, settings, lastNudgedBand, continuing, ctx.model);
    lastNudgedBand = planned.band;
    if (!planned.nudge) return;
    const schedule = nudgeSchedule(window, settings, ctx.model);
    pi.sendMessage(
      {
        customType: "infinite-context/nudge",
        content:
          `<context-maintenance>\n${reminderText(tokens, window, schedule)} ` +
          "Use context_map, then context_fold completed or superseded roots in one call that frees at least ~15k tokens. " +
          "Keep the active request, open loops, unresolved errors, and evidence needed soon. " +
          "Native compaction is blocked, so an actual overflow will remain visible.\n</context-maintenance>",
        display: true,
        details: { band: planned.band, tokens, window, ...schedule },
      },
      { deliverAs: "steer" },
    );
  });

  pi.registerTool({
    name: "context_map",
    label: "Context map",
    description:
      "List all ordered roots, or all direct children of one fold, in one response: " +
      "`[#id] <role> ~<tokens> · <preview>` per message, `[#id] fold <N> msgs ~<tokens> · <summary preview>` per fold, " +
      "`not live` instead of tokens when Pi omits it from context. Previews shrink when needed so every item is listed; it never recursively dumps a subtree.",
    parameters: Type.Object({
      id: Type.Optional(IdParam("Fold id whose direct children to list. Omit for the roots.")),
    }),
    executionMode: "sequential",
    async execute(_callId, params, _signal, _update, ctx) {
      const state = current(ctx);
      const id = params.id === undefined ? undefined : bareId(params.id);
      const listing = directItems(state.roots, id);
      const map = renderMap(listing.label, listing.items, state.byId);
      return {
        content: [{ type: "text", text: map.text }],
        details: { count: listing.items.length, previewChars: map.previewChars, id },
      };
    },
  });

  pi.registerTool({
    name: "context_peek",
    label: "Context peek",
    description:
      `Read one original message's serialized text or exactly one fold's summary without changing context. ` +
      `Uses 1-based line windows (default ${DEFAULT_PAGE_LIMIT}); every result reports total item lines. The item is returned whole — it already fit in context once — so page with offset/limit to bound what you pull back.`,
    parameters: Type.Object({
      id: IdParam("Stable message or fold id from context_map or context_search."),
      ...PageParams,
    }),
    executionMode: "sequential",
    async execute(_callId, params, _signal, _update, ctx) {
      const state = current(ctx);
      const id = bareId(params.id);
      const item = findItem(state.roots, id);
      if (!item) throw unknownIdError(id);
      const page = parsePage(params.offset, params.limit);
      const text = item.kind === "fold" ? item.summary : serializeMessage(state.byId.get(item.id)!.message);
      const window = lineWindow(text, page.offset, page.limit);
      const kind = item.kind === "fold" ? "fold summary" : state.byId.get(item.id)!.message.role;
      const range = window.end >= window.start ? `${window.start}-${window.end}` : "none";
      const footer = `[#${id}] ${kind} · lines ${range} of ${window.totalLines}`;
      // No boundOutput here: peek deliberately returns one already-context-sized item in full.
      return {
        content: [{ type: "text", text: `${window.text}${window.text ? "\n" : ""}${footer}` }],
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
    async execute(_callId, params, _signal, _update, ctx) {
      const state = current(ctx);
      const groups = params.patterns.map((source, index) => {
        let pattern: RegExp;
        try {
          pattern = compilePattern(source);
        } catch {
          throw new Error(
            `Pattern ${index + 1} is not a valid JavaScript regular expression: /${previewText(source)}/`,
          );
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
      "Wrap contiguous root ranges in new folds. Each explicit summary is the new fold's projection; existing folds become children unchanged. Refold a single root fold to revise its active summary while preserving history. The batch is all-or-nothing and tool calls/results remain indivisible.",
    promptSnippet: "Fold completed context into a searchable recursive archive before the context limit",
    promptGuidelines: [
      "Use context_fold proactively after completed exploration, debugging, implementation, or verification phases and after large tool results; native compaction is blocked.",
      "Fold what the current task step no longer needs. Keep governing instructions, the active request, unresolved errors, open decisions, and evidence needed soon as roots. Each context_fold call rewrites the cached prompt prefix, so fold in batches that free at least ~15k tokens.",
      "Write each summary so work can continue without the originals. Keep verbatim: file paths, symbols, commands, error messages, decisions with their rationale, open loops. Drop: verbose logs, repeated reads, dead ends that teach nothing. Include the exact terms you would later pass to context_search. Use an empty summary only for disposable noise.",
      "Use context_map for root ids, context_search to locate archived text, and context_peek to read it. Reads never unfold context.",
      "Revise a root fold with context_fold({items:[{from:id, summary:newSummary}]}): the new wrapper preserves the previous fold and summary as history.",
    ],
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          from: IdParam("First root id."),
          to: Type.Optional(IdParam("Inclusive root id; defaults to from.")),
          summary: SummaryParam("Exact new fold summary; an empty string is allowed."),
        }),
        { minItems: 1, maxItems: 50, description: "Disjoint root ranges; the mutation is atomic." },
      ),
    }),
    executionMode: "sequential",
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
}
