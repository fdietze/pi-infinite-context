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

/**
 * An id inside a fold is usually a stale id whose content is already folded, so the error states
 * that fact and points to a fresh map rather than to the fold: told to fold the containing fold,
 * Qwen 3.8 27b refolded it alone and rewrote its summary, which frees nothing (2026-11-14).
 * Folding an old fold together with new roots works from the fresh map, where it is a root.
 * An id that is neither a root nor archived is usually a miscopied id, so the
 * error says it does not exist rather than suggesting it exists elsewhere.
 */
export function notARootError(roots: Forest, id: string): Error {
  const fold = containingFold(roots, id);
  if (fold)
    return new Error(`"${id}" is already folded inside "${fold.id}". Call context_map for the current roots.`);
  return unknownIdError(id);
}
