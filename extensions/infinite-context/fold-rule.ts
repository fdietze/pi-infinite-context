/**
 * The rule for when and what to fold, stated once (DRY) and sent in two places: the context_fold
 * prompt guideline, read when the agent folds on its own, and every context reminder, where the
 * rule is fresh at the moment of decision so the agent need not look it up in the system prompt.
 */

/**
 * Share of the context one context_fold call should free to repay its cost. A fold costs its
 * folding turns plus the cache miss it causes, about ten cached reads of the whole context, so the
 * break-even scales with context size, not with a fixed token count. Measured return per dollar
 * crosses 1 between 20% and 30% of the context freed net, i.e. after the map, the fold call and
 * the summary (1,313 folds over 90 days; context-efficiency chart_fold_payoff.py), and is
 * reliable from 30%. What a fold reports as freed is before that overhead, which takes about 5%
 * of the context (median, 90 days): 30% net + 5% = 35%.
 */
export const FOLD_MIN_SHARE = 0.35;

/**
 * When and what to fold, given the minimum fold size in the caller's unit.
 * The reason names money, time and reasoning quality because kept tokens cost all three: cloud
 * models bill them, local models compute over them, and every model reasons worse in a longer
 * context. It states the conclusion (fold early) explicitly: weaker models given only the cost
 * per turn concluded that folding early costs more than it saves (Qwen 3.8 27b, 2026-11-13).
 */
export const foldRule = (minFreed: string): string =>
  `Fold what the remaining work no longer needs verbatim, batched so one context_fold call frees ${minFreed} or more. ` +
  "Every kept token is paid again on every later turn, in money, time and reasoning quality, while a fold costs about ten re-reads of the whole context; " +
  "so a fold saves more the more turns remain. Keep what the remaining work uses; wait only if the task ends within a few turns.";

/** What to do when little room is left; native compaction is blocked, so overflow fails the turn. */
export const OVERFLOW_RULE =
  "fold even if less is freed, parts of the thread included: restate them in the summary; context_peek recovers details.";
