import type { Forest, Item } from "./forest.ts";
import { originalIds } from "./forest.ts";
import type { OriginalMessage } from "./originals.ts";

export interface UnitBounds {
  readonly start: number[];
  readonly end: number[];
  readonly unfinished: ReadonlySet<number>;
}

/** Completed assistant call batches and all correlated results are indivisible. */
export function unitBounds(messages: readonly OriginalMessage[]): UnitBounds {
  const start = messages.map((_, i) => i);
  const end = messages.map((_, i) => i);
  const ownerByCall = new Map<string, number>();
  const callsByOwner = new Map<number, string[]>();
  for (let i = 0; i < messages.length; ++i) {
    const message = messages[i].message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && typeof block.id === "string") {
        ownerByCall.set(block.id, i);
        const calls = callsByOwner.get(i) ?? [];
        calls.push(block.id);
        callsByOwner.set(i, calls);
      }
    }
  }
  const resultIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; ++i) {
    const message = messages[i].message;
    if (message.role === "toolResult" && message.toolCallId)
      resultIndex.set(message.toolCallId, i);
  }
  const unfinished = new Set<number>();
  for (const [owner, calls] of callsByOwner) {
    const presentResults = calls
      .map((id) => resultIndex.get(id))
      .filter((index): index is number => index !== undefined);
    const last = Math.max(owner, ...presentResults);
    // Even a partial result batch is one unfinished unit. Mark its known range
    // so selecting a result cannot evade the unfinished-owner rejection.
    for (let i = owner; i <= last; ++i) {
      start[i] = owner;
      end[i] = last;
    }
    if (presentResults.length !== calls.length) unfinished.add(owner);
  }
  return { start, end, unfinished };
}

/** Reject persisted states that could project an orphan call or result. */
export function validateToolUnitOwnership(
  roots: Forest,
  originals: readonly OriginalMessage[],
): void {
  const rootByOriginal = new Map<string, { index: number; kind: Item["kind"] }>();
  for (let index = 0; index < roots.length; ++index)
    for (const id of originalIds([roots[index]]))
      rootByOriginal.set(id, { index, kind: roots[index].kind });
  const bounds = unitBounds(originals);
  for (let owner = 0; owner < originals.length; ++owner) {
    if (bounds.start[owner] !== owner || bounds.end[owner] === owner) {
      if (!bounds.unfinished.has(owner)) continue;
    }
    const members = originals.slice(owner, bounds.end[owner] + 1);
    const locations = members.map(({ id }) => rootByOriginal.get(id)!);
    if (bounds.unfinished.has(owner)) {
      if (locations.some((location) => location.kind === "fold"))
        throw new Error(
          "Snapshot folds an unfinished tool-call unit; start a new session",
        );
      continue;
    }
    const allLive = locations.every((location) => location.kind === "message");
    const oneFold =
      locations.every((location) => location.kind === "fold") &&
      locations.every((location) => location.index === locations[0].index);
    if (!allLive && !oneFold)
      throw new Error(
        "Snapshot splits an assistant tool call from its results; start a new session",
      );
  }
}
