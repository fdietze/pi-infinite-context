import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Forest, Item } from "./forest.ts";
import { originalIds } from "./forest.ts";
import { anchorId, foldSummaryText, type OriginalsById } from "./fold-projection.ts";
import type { OriginalMessage, ProjectedPosition } from "./originals.ts";

/** Raised when some projected entry is missing from the request, so the position mapping cannot be trusted. */
export class ProjectionMismatchError extends Error {}

const matches = (position: ProjectedPosition, message: AgentMessage) =>
  position.message === message || isDeepStrictEqual(position.message, message);

/**
 * Overlay the request copy; the raw session branch is never rewritten.
 *
 * Pi builds the request from the session projection and appends anything not
 * yet persisted. Other extensions' `context` handlers may run before this one
 * and insert messages (e.g. synthetic results for an abandoned tool call), and
 * Pi does not let us order handlers. So the projection must appear in the
 * request as an ordered subsequence, matched greedily by identity or deep
 * equality; that gives every matched request message its owning entry id.
 *
 * Each fold emits one synthetic user message at its anchor and drops its other
 * members. An unmatched message before the last projected position is a foreign
 * insertion owned by the root of the nearest preceding projected position: a
 * fold drops it as part of the folded unit (a result of a folded call must not
 * outlive its call), anything else passes it through. Messages before the first
 * and after the last projected position pass through unchanged.
 */
export function buildOverlay(
  messages: readonly AgentMessage[],
  positions: readonly ProjectedPosition[],
  originals: readonly OriginalMessage[],
  roots: Forest,
): AgentMessage[] {
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
  let next = 0; // next projected position to match
  let matchedUpTo = 0; // request length up to and including the last matched message
  let owner: Item | undefined; // root of the last matched projected position
  for (let i = 0; i < messages.length; ++i) {
    const message = messages[i];
    if (next < positions.length && matches(positions[next], message)) {
      const { id } = positions[next++];
      matchedUpTo = i + 1;
      owner = rootByOriginal.get(id);
      if (!owner || owner.kind === "message") output.push(message);
      else if (anchors.get(owner) === id)
        output.push({ role: "user", content: foldSummaryText(owner), timestamp: message.timestamp });
      continue;
    }
    // Foreign insertion inside the projection, or the unpersisted tail.
    if (next < positions.length && owner?.kind === "fold") continue;
    output.push(message);
  }
  if (next < positions.length)
    throw new ProjectionMismatchError(
      `Projected entry "${positions[next].id}" (${positions[next].message.role}) is missing ` +
        `from the request at or after position ${matchedUpTo}: another context handler ` +
        `removed or changed it`,
    );
  return output;
}
