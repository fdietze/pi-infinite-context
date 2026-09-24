import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Forest, Item } from "./forest.ts";
import { originalIds } from "./forest.ts";
import { anchorId, foldSummaryText, type OriginalsById } from "./fold-projection.ts";
import type { OriginalMessage, ProjectedPosition } from "./originals.ts";

/** Raised when the request no longer starts with the session projection, so no position can be trusted. */
export class ProjectionMismatchError extends Error {}

/**
 * Overlay the request copy; the raw session branch is never rewritten.
 *
 * Pi builds the request from the session projection and appends anything not yet
 * persisted, so the projection is a prefix of `messages` and gives every prefix
 * position its owning entry id. Each fold emits one synthetic user message at
 * its anchor, its other members are dropped, and everything else passes through
 * unchanged.
 */
export function buildOverlay(
  messages: readonly AgentMessage[],
  positions: readonly ProjectedPosition[],
  originals: readonly OriginalMessage[],
  roots: Forest,
): AgentMessage[] {
  if (positions.length > messages.length)
    throw new ProjectionMismatchError(
      `The request has ${messages.length} messages but the session projection has ${positions.length}`,
    );
  for (let i = 0; i < positions.length; ++i)
    if (positions[i].message !== messages[i] && !isDeepStrictEqual(positions[i].message, messages[i]))
      throw new ProjectionMismatchError(
        `The request stops matching the session projection at position ${i} (${messages[i]?.role ?? "missing"})`,
      );

  const byId: OriginalsById = new Map(
    originals.map((original) => [original.id, original] as const),
  );
  const rootByOriginal = new Map<string, Item>();
  const anchors = new Map<Item, string | undefined>();
  for (const root of roots) {
    for (const id of originalIds([root])) rootByOriginal.set(id, root);
    if (root.kind === "fold") anchors.set(root, anchorId(root, byId));
  }

  const output: AgentMessage[] = [];
  for (let i = 0; i < messages.length; ++i) {
    const root = i < positions.length ? rootByOriginal.get(positions[i].id) : undefined;
    if (!root || root.kind === "message") {
      output.push(messages[i]);
      continue;
    }
    if (anchors.get(root) !== positions[i].id) continue;
    output.push({
      role: "user",
      content: foldSummaryText(root),
      timestamp: messages[i].timestamp,
    });
  }
  return output;
}
