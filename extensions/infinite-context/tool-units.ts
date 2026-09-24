import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Forest, Item } from "./forest.ts";
import { originalIds } from "./forest.ts";
import type { OriginalMessage } from "./originals.ts";

export interface ToolUnits {
  /** Index of the unit's first live member for every live member; every other original maps to itself. */
  readonly start: number[];
  /** Index of the unit's last live member, mirroring `start`. */
  readonly end: number[];
  /**
   * The currently executing turn: the last live assistant of the branch, when
   * some of its calls still lack a live result. Everything before it is
   * settled, so it is the only range the archive must refuse to fold.
   */
  readonly pendingOwner: number | undefined;
}

const toolCallIds = (message: AgentMessage | undefined): string[] => {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content)
    if (block.type === "toolCall" && typeof block.id === "string") ids.push(block.id);
  return ids;
};

/**
 * Group live assistant tool calls with their live results.
 *
 * Only live messages are members: an attempt Pi omitted via `context_edit`
 * never reaches the provider, so it neither orphans nor joins anything even
 * when it sits between a call and its result. An abandoned call without a
 * result is a complete one-message unit — the provider boundary synthesizes
 * the missing result.
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
    if (!live || live.role !== "assistant") continue;
    lastLiveAssistant = owner;
    const calls = toolCallIds(live);
    if (calls.length === 0) continue;
    const results = calls
      .map((id) => resultIndex.get(id))
      .filter((index): index is number => index !== undefined);
    const members = [owner, ...results];
    const last = Math.max(...members);
    for (const member of members) {
      start[member] = owner;
      end[member] = last;
    }
    if (results.length !== calls.length) pendingOwner = owner;
  }
  // Only the final assistant can still be running; an earlier incomplete unit
  // was abandoned and stays foldable forever.
  if (pendingOwner !== lastLiveAssistant) pendingOwner = undefined;
  return { start, end, pendingOwner };
}

/** The live members of the unit owned by `owner`, in branch order. */
export function unitMembers(units: ToolUnits, owner: number): number[] {
  const members: number[] = [];
  for (let i = owner; i <= units.end[owner]; ++i) if (units.start[i] === owner) members.push(i);
  return members;
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
    const locations = unitMembers(units, owner).map(
      (member) => rootByOriginal.get(originals[member].id)!,
    );
    const allRoots = locations.every((location) => location.kind === "message");
    const oneFold = locations.every(
      (location) => location.kind === "fold" && location.index === locations[0].index,
    );
    if (!allRoots && !oneFold)
      throw new Error(
        `Snapshot splits the tool call of "${originals[owner].id}" from its results; start a new session`,
      );
  }
}
