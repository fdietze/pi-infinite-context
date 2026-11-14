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

/** A fold's cost in reads of the whole context: its folding turns plus the cache rewrite it causes. */
export const FOLD_COST_READS = 10;

/**
 * Turns after which a fold freeing FOLD_MIN_SHARE repays itself: each turn saves the freed share
 * of one context read, so cost / share turns (10 / 0.35 ≈ 29, stated as 30).
 * Work usually continues longer: 71% of 406 session files ran 30 or more requests after their
 * first reminder, median 81 (90 days to 2026-11-14).
 */
const BREAK_EVEN_TURNS = Math.round(FOLD_COST_READS / FOLD_MIN_SHARE / 10) * 10;

/**
 * When and what to fold, given the minimum fold size in the caller's unit.
 * The reason names money, time and reasoning quality because kept tokens cost all three: cloud
 * models bill them, local models compute over them, and every model reasons worse in a longer
 * context. It states the break-even and the conclusion explicitly: weaker models given only the
 * cost per turn concluded that folding early costs more than it saves (Qwen 3.8 27b, 2026-11-13).
 * "As soon as that part reaches" also says what to do below the minimum: keep working.
 */
export const foldRule = (minFreed: string): string =>
  `Fold what the remaining work no longer needs verbatim, as soon as that part reaches ${minFreed}, in one context_fold call. ` +
  `Every kept token is paid again on every later turn, in money, time and reasoning quality, while a fold costs about ${FOLD_COST_READS} reads of the whole context: ` +
  `a fold that frees ${FOLD_MIN_SHARE * 100}% repays itself after about ${BREAK_EVEN_TURNS} turns, sooner when it frees more, and work usually continues longer. ` +
  "Wait only if the task ends before the fold repays itself.";

/** What to do when little room is left; native compaction is blocked, so overflow fails the turn. */
export const OVERFLOW_RULE =
  "fold even if less is freed, parts of the thread included: restate them in the summary; context_peek recovers details.";
