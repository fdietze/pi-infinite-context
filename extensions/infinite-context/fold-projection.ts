import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { FoldItem, Forest, Item } from "./forest.ts";
import { originalIds } from "./forest.ts";
import type { OriginalMessage } from "./originals.ts";

export type OriginalsById = ReadonlyMap<string, OriginalMessage>;

/** Live-context cost of one original. An original Pi omits costs nothing. */
export function liveTokens(original: OriginalMessage): number {
  return original.live ? estimateTokens(original.live) : 0;
}

/**
 * The anchor: the first live member of a root, i.e. the position where the root
 * appears in the live context. A root without one is not live at all.
 */
export function anchorId(item: Item, byId: OriginalsById): string | undefined {
  return originalIds([item]).find((id) => byId.get(id)?.live !== undefined);
}

/**
 * What the model reads in place of a fold. The first line marks the synthetic
 * user message as archive content, not user text, and names the fold id in the
 * same `[#id]` form the tools print, so the model can address it without a map.
 */
export function foldSummaryText(fold: FoldItem): string {
  const body = fold.summary || `(no summary: ${originalIds([fold]).length} messages)`;
  return `[#${fold.id}] archived fold summary:\n${body}`;
}

export function rootTokens(item: Item, byId: OriginalsById): number {
  if (item.kind === "message") return liveTokens(byId.get(item.id)!);
  if (!anchorId(item, byId)) return 0;
  return Math.ceil(foldSummaryText(item).length / 4);
}

export function visibleTokens(roots: Forest, byId: OriginalsById): number {
  return roots.reduce((total, item) => total + rootTokens(item, byId), 0);
}
