export const INFINITE_CONTEXT_ENTRY = "infinite-context";
export const SNAPSHOT_VERSION = 2;

export interface MessageItem {
  readonly kind: "message";
  readonly id: string;
}

export interface FoldItem {
  readonly kind: "fold";
  readonly id: string;
  readonly summary: string;
  readonly children: readonly Item[];
}

export type Item = MessageItem | FoldItem;
export type Forest = readonly Item[];

export interface Snapshot {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly roots: Forest;
}

export function messageItem(id: string): MessageItem {
  return { kind: "message", id };
}

/** Iterative traversal keeps even deliberately deep fold trees safe. */
export function allItems(roots: Forest): Item[] {
  const output: Item[] = [];
  const pending = [...roots].reverse();
  while (pending.length) {
    const item = pending.pop()!;
    output.push(item);
    if (item.kind === "fold") {
      for (let i = item.children.length - 1; i >= 0; --i)
        pending.push(item.children[i]);
    }
  }
  return output;
}

export function originalIds(roots: Forest): string[] {
  return allItems(roots)
    .filter((item): item is MessageItem => item.kind === "message")
    .map((item) => item.id);
}

export function findItem(roots: Forest, id: string): Item | undefined {
  return allItems(roots).find((item) => item.id === id);
}

/** Wrap disjoint root ranges. Validation happens before construction (atomicity). */
export function wrapRootRanges(
  roots: Forest,
  ranges: readonly { first: number; last: number; id: string; summary: string }[],
): Forest {
  const occupied = new Set<number>();
  const ids = new Set(allItems(roots).map((item) => item.id));
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.first) ||
      !Number.isSafeInteger(range.last) ||
      range.first < 0 ||
      range.last < range.first ||
      range.last >= roots.length
    )
      throw new Error("Fold range is outside the roots");
    if (!range.id || ids.has(range.id)) throw new Error("Fold node id is not unique");
    ids.add(range.id);
    for (let i = range.first; i <= range.last; ++i) {
      if (occupied.has(i)) throw new Error("Fold ranges overlap after tool-unit expansion");
      occupied.add(i);
    }
  }

  const byFirst = new Map(ranges.map((range) => [range.first, range] as const));
  const result: Item[] = [];
  for (let i = 0; i < roots.length; ++i) {
    const range = byFirst.get(i);
    if (!range) {
      if (!occupied.has(i)) result.push(roots[i]);
      continue;
    }
    result.push({
      kind: "fold",
      id: range.id,
      summary: range.summary,
      children: roots.slice(range.first, range.last + 1),
    });
    i = range.last;
  }
  return result;
}

/** Hidden summaries are immutable: only a currently visible fold may change. */
export function replaceRootSummary(roots: Forest, id: string, summary: string): Forest {
  const index = roots.findIndex((item) => item.id === id);
  const item = roots[index];
  if (!item || item.kind !== "fold") throw new Error(`"${id}" is not a root fold`);
  return roots.map((candidate, i) =>
    i === index ? { ...item, summary } : candidate,
  );
}

/** Append new branch messages while proving every archived original still exists once and in order. */
export function syncOriginals(roots: Forest, currentOriginalIds: readonly string[]): Forest {
  const archived = originalIds(roots);
  if (new Set(archived).size !== archived.length)
    throw new Error("Snapshot contains duplicate original references");
  if (archived.length > currentOriginalIds.length)
    throw new Error("Snapshot references messages outside the current branch");
  for (let i = 0; i < archived.length; ++i) {
    if (archived[i] !== currentOriginalIds[i])
      throw new Error("Snapshot does not match the current branch");
  }
  return [
    ...roots,
    ...currentOriginalIds.slice(archived.length).map(messageItem),
  ];
}

interface MutableFold {
  kind: "fold";
  id: string;
  summary: string;
  children: Item[];
}

/** Parse, don't validate: callers receive a defensive, invariant-carrying v2 value. */
export function parseSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== "object") throw new Error("Missing infinite-context snapshot");
  const data = value as Record<string, unknown>;
  if (data.version !== SNAPSHOT_VERSION || !Array.isArray(data.roots))
    throw new Error("Unsupported infinite-context state; start a new session");

  const ids = new Set<string>();
  const roots: Item[] = [];
  const pending: Array<{ source: unknown; target: Item[] }> = data.roots
    .map((source) => ({ source, target: roots }))
    .reverse();
  let count = 0;
  while (pending.length) {
    if (++count > 100_000) throw new Error("Snapshot contains too many nodes");
    const { source, target } = pending.pop()!;
    if (!source || typeof source !== "object") throw new Error("Snapshot item is not an object");
    const item = source as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id) throw new Error("Snapshot item has no id");
    if (ids.has(item.id)) throw new Error("Snapshot has a duplicate node id");
    ids.add(item.id);
    if (item.kind === "message") {
      target.push({ kind: "message", id: item.id });
      continue;
    }
    if (item.kind !== "fold" || typeof item.summary !== "string" || !Array.isArray(item.children))
      throw new Error("Snapshot contains an invalid item");
    if (!item.children.length) throw new Error("Snapshot contains an empty fold");
    const fold: MutableFold = { kind: "fold", id: item.id, summary: item.summary, children: [] };
    target.push(fold);
    for (let i = item.children.length - 1; i >= 0; --i)
      pending.push({ source: item.children[i], target: fold.children });
  }
  return { version: SNAPSHOT_VERSION, roots };
}

export function snapshot(roots: Forest): Snapshot {
  return { version: SNAPSHOT_VERSION, roots };
}
