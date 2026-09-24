import type { Forest } from "./forest.ts";
import { originalIds } from "./forest.ts";
import { notARootError } from "./id-errors.ts";
import type { OriginalMessage } from "./originals.ts";
import { toolUnits } from "./tool-units.ts";

export interface RootRangeRequest {
  readonly from: string;
  readonly to?: string;
  readonly summary: string;
}

export interface PlannedRange {
  readonly first: number;
  readonly last: number;
  readonly summary: string;
}

/**
 * Resolve root ids to root index ranges and expand them to whole tool units.
 *
 * Folding the pending unit is the only tool-unit rejection: every other range
 * is foldable, so an abandoned call can never block the archive.
 */
export function planRootRanges(
  roots: Forest,
  originals: readonly OriginalMessage[],
  requests: readonly RootRangeRequest[],
): PlannedRange[] {
  if (requests.length === 0) throw new Error("At least one fold range is required");
  const rootIndex = new Map(roots.map((root, i) => [root.id, i] as const));
  const originalIndex = new Map(originals.map((message, i) => [message.id, i] as const));
  const rootOfOriginal = new Map<string, number>();
  for (let i = 0; i < roots.length; ++i)
    for (const id of originalIds([roots[i]])) rootOfOriginal.set(id, i);
  const units = toolUnits(originals);
  const pendingRoot =
    units.pendingOwner === undefined
      ? undefined
      : rootOfOriginal.get(originals[units.pendingOwner].id);

  const planned = requests.map((request, item) => {
    const a = rootIndex.get(request.from);
    const b = rootIndex.get(request.to ?? request.from);
    if (a === undefined) throw notARootError(roots, request.from);
    if (b === undefined) throw notARootError(roots, request.to ?? request.from);
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
        const unitFirst = rootOfOriginal.get(originals[units.start[index]].id)!;
        const unitLast = rootOfOriginal.get(originals[units.end[index]].id)!;
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
    if (pendingRoot !== undefined && first <= pendingRoot && pendingRoot <= last)
      throw new Error(
        `Item ${item + 1} covers root "${roots[pendingRoot].id}", the pending tool call of the running turn. Fold the roots before it.`,
      );
    return { first, last, summary: request.summary };
  });

  for (let i = 0; i < planned.length; ++i)
    for (let j = i + 1; j < planned.length; ++j)
      if (planned[i].first <= planned[j].last && planned[j].first <= planned[i].last)
        throw new Error(
          `Items ${i + 1} and ${j + 1} overlap after tool-unit expansion ` +
            `(roots "${roots[planned[i].first].id}".."${roots[planned[i].last].id}" and ` +
            `"${roots[planned[j].first].id}".."${roots[planned[j].last].id}"). Combine them into one item.`,
        );
  return planned;
}
