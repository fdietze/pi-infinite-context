import type { Forest } from "./forest.ts";
import { originalIds } from "./forest.ts";
import type { OriginalMessage } from "./originals.ts";
import { unitBounds } from "./tool-units.ts";

export interface RootRangeRequest {
  readonly from: string;
  readonly to?: string;
  readonly summary: string;
}

/** Resolve visible root ids, then expand ranges just enough to preserve whole completed tool units. */
export function planRootRanges(
  roots: Forest,
  originals: readonly OriginalMessage[],
  requests: readonly RootRangeRequest[],
): { first: number; last: number; summary: string }[] {
  if (requests.length === 0) throw new Error("At least one fold range is required");
  const rootIndex = new Map(roots.map((root, i) => [root.id, i] as const));
  const originalIndex = new Map(originals.map((message, i) => [message.id, i] as const));
  const rootOfOriginal = new Map<string, number>();
  for (let i = 0; i < roots.length; ++i)
    for (const id of originalIds([roots[i]])) rootOfOriginal.set(id, i);
  const bounds = unitBounds(originals);

  return requests.map((request) => {
    const a = rootIndex.get(request.from);
    const b = rootIndex.get(request.to ?? request.from);
    if (a === undefined || b === undefined)
      throw new Error("A fold endpoint is not a visible root");
    let first = Math.min(a, b);
    let last = Math.max(a, b);
    let changed = true;
    while (changed) {
      changed = false;
      const selectedIds = roots
        .slice(first, last + 1)
        .flatMap((root) => originalIds([root]));
      for (const id of selectedIds) {
        const index = originalIndex.get(id)!;
        const owner = bounds.start[index];
        if (bounds.unfinished.has(owner))
          throw new Error("Cannot fold an unfinished tool-call unit");
        const unitFirst = rootOfOriginal.get(originals[bounds.start[index]].id)!;
        const unitLast = rootOfOriginal.get(originals[bounds.end[index]].id)!;
        if (unitFirst < first) {
          first = unitFirst;
          changed = true;
        }
        if (unitLast > last) {
          last = unitLast;
          changed = true;
        }
      }
    }
    return { first, last, summary: request.summary };
  });
}
