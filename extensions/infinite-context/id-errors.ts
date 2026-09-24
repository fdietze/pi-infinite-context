import { allItems, type Forest } from "./forest.ts";

/**
 * Errors for ids a caller supplied. Every message names the offending id and
 * the next step, so a model can recover without guessing.
 */

/** The fold root that contains `id`, if the id is archived below the roots. */
function containingFold(roots: Forest, id: string) {
  return roots.find(
    (root) => root.kind === "fold" && allItems([root]).some((item) => item.id === id),
  );
}

export function unknownIdError(id: string): Error {
  return new Error(
    `"${id}" is not in the archive on this branch. Call context_map or context_search for current ids.`,
  );
}

export function notARootError(roots: Forest, id: string): Error {
  const fold = containingFold(roots, id);
  if (fold)
    return new Error(`"${id}" is not a root: it is inside fold "${fold.id}". Fold "${fold.id}" instead.`);
  return new Error(`"${id}" is not a root. Call context_map for the current root ids.`);
}

export function notAFoldRootError(roots: Forest, id: string): Error {
  if (roots.some((root) => root.kind === "message" && root.id === id))
    return new Error(`"${id}" is a message root, not a fold. Only fold summaries can be replaced.`);
  const fold = containingFold(roots, id);
  if (fold)
    return new Error(
      `"${id}" is not a root: it is inside fold "${fold.id}", whose summary is immutable. Replace the summary of "${fold.id}" instead.`,
    );
  return new Error(`"${id}" is not a root fold. Call context_map for the current root ids.`);
}
