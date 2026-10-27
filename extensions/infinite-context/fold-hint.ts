import type { CachePrice, FoldHintMode } from "./settings.ts";

/**
 * The cost-aware part of a reminder, and the fold-timing section of the system prompt. Both
 * follow from what a fold costs: it changes the prompt from the fold point on, so the provider
 * writes the prompt cache anew from there (README, Prefix caching).
 *
 * Pure: reading prices, the TTL and the clock is index.ts's job.
 */

/**
 * Turns after which a fold has paid for itself. Folding R tokens invalidates the cache of the
 * K tokens kept after the fold point: writing them again costs K (w - r) once, and every later
 * request saves R r. So payoff = ((w - r) / r) · K / R.
 */
export function payoffTurns(keptTokens: number, removedTokens: number, price: CachePrice): number {
  const { cacheWrite: w, cacheRead: r } = price;
  return removedTokens > 0 ? ((w - r) / r) * (keptTokens / removedTokens) : Infinity;
}

/** The share of the live context a typical fold removes: the oldest three quarters. */
const FOLD_REMOVED_SHARE = 0.75;

/**
 * The cost-aware sentence of a reminder. Cold cache (`now - lastRequestAt >= ttlMs`, or no
 * request yet in this process): the next request writes the whole prompt anyway, so folding is
 * free. Warm: the payoff of folding the oldest 75%, plus the general rule so the agent can apply
 * it to the fold it plans. Warm without a price for the model, or mode `fixed`: no hint.
 */
export function foldHint(a: {
  tokens: number;
  price: CachePrice | undefined;
  lastRequestAt: number | undefined;
  now: number;
  ttlMs: number;
  mode: FoldHintMode;
}): string | undefined {
  if (a.mode === "fixed") return undefined;
  if (a.lastRequestAt === undefined || a.now - a.lastRequestAt >= a.ttlMs)
    return "Fold hint: the prompt cache is cold, so folding is free now.";
  if (!a.price) return undefined;
  const removed = a.tokens * FOLD_REMOVED_SHARE;
  const turns = payoffTurns(a.tokens - removed, removed, a.price);
  const { cacheWrite: w, cacheRead: r } = a.price;
  const n = Math.round(turns);
  const payoff = n < 1 ? "pays off right away" : `pays off after ≈ ${n} more turn${n === 1 ? "" : "s"}`;
  const factor = +((w - r) / r).toFixed(1);
  return (
    `Fold hint: the prompt cache is warm; folding the oldest ${FOLD_REMOVED_SHARE * 100}% ${payoff} ` +
    `(in general ≈ ${factor} × K/R turns, K = tokens kept after the fold point, R = tokens removed).`
  );
}

/**
 * The `fold_timing` system-prompt section in mode `cache-aware`. Constant, so the system prompt
 * stays byte-identical across turns; a model reads it, so a test pins the literal.
 */
export const FOLD_TIMING_TEXT =
  "Fold timing: a fold re-writes the prompt cache from the fold point on. Fold a completed phase promptly, while it is still at the end of the context — that is cheap. Folding old ranges while the cache is warm is expensive; prefer it when the cache is cold or the range is large.";

/**
 * Sets the `fold_timing` section in mode `cache-aware`. In `fixed` it does nothing, so the prompt
 * stays as it was and a same-named section of another extension is left alone.
 */
export function applyFoldTiming(sections: Record<string, string>, mode: FoldHintMode): void {
  if (mode === "cache-aware") sections.fold_timing = FOLD_TIMING_TEXT;
}
