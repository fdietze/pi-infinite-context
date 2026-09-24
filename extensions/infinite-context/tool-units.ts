import type { Forest, Item } from "./forest.ts";
import { originalIds } from "./forest.ts";
import type { OriginalMessage } from "./originals.ts";

export interface ToolUnits {
  /** Index of the first original of the tool unit owning each original. */
  readonly start: number[];
  /** Index of the last original of that unit. */
  readonly end: number[];
  /**
   * The currently executing turn: the last live assistant of the branch, when
   * some of its calls still lack a live result. Everything before it is
   * settled, so it is the only range the archive must refuse to fold.
   */
  readonly pendingOwner: number | undefined;
}

const toolCallIds = (message: OriginalMessage["live"]): string[] => {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content)
    if (block.type === "toolCall" && typeof block.id === "string") ids.push(block.id);
  return ids;
};

/**
 * Group live assistant tool calls with their live results.
 *
 * Only live messages can form a unit: an attempt Pi omitted via `context_edit`
 * never reaches the provider, so it cannot orphan anything. An abandoned call
 * without a result is a complete one-message unit — the provider boundary
 * synthesizes the missing result.
 */
export function toolUnits(originals: readonly OriginalMessage[]): ToolUnits {
  const start = originals.map((_, i) => i);
  const end = originals.map((_, i) => i);
  const resultIndex = new Map<string, number>();
  for (let i = 0; i < originals.length; ++i) {
    const live = originals[i].live;
    if (live?.role === "toolResult" && live.toolCallId) resultIndex.set(live.toolCallId, i);
  }
  let lastLiveAssistant: number | undefined;
  let pendingOwner: number | undefined;
  for (let owner = 0; owner < originals.length; ++owner) {
    const live = originals[owner].live;
    if (!live) continue;
    if (live.role !== "assistant") continue;
    lastLiveAssistant = owner;
    const calls = toolCallIds(live);
    if (calls.length === 0) continue;
    const results = calls
      .map((id) => resultIndex.get(id))
      .filter((index): index is number => index !== undefined);
    const last = Math.max(owner, ...results);
    for (let i = owner; i <= last; ++i) {
      start[i] = owner;
      end[i] = last;
    }
    if (results.length !== calls.length) pendingOwner = owner;
  }
  // Only the final assistant can still be running; an earlier incomplete unit
  // was abandoned and stays foldable forever.
  if (pendingOwner !== lastLiveAssistant) pendingOwner = undefined;
  return { start, end, pendingOwner };
}

/** Reject persisted states that would project a tool call without its results. */
export function validateToolUnitOwnership(
  roots: Forest,
  originals: readonly OriginalMessage[],
): void {
  const rootByOriginal = new Map<string, { index: number; kind: Item["kind"] }>();
  for (let index = 0; index < roots.length; ++index)
    for (const id of originalIds([roots[index]]))
      rootByOriginal.set(id, { index, kind: roots[index].kind });
  const units = toolUnits(originals);
  for (let owner = 0; owner < originals.length; ++owner) {
    if (units.start[owner] !== owner || units.end[owner] === owner) continue;
    const locations = originals
      .slice(owner, units.end[owner] + 1)
      .map(({ id }) => rootByOriginal.get(id)!);
    const allRoots = locations.every((location) => location.kind === "message");
    const oneFold = locations.every(
      (location) => location.kind === "fold" && location.index === locations[0].index,
    );
    if (!allRoots && !oneFold)
      throw new Error(
        "Snapshot splits an assistant tool call from its results; start a new session",
      );
  }
}
