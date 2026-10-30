import type { Settings } from "./settings.ts";

/**
 * Upper bound for the distance between two reminders. It exceeds the context growth of one
 * fold cycle (map, peeks, summaries: ~10k tokens), so the agent is not nagged while it folds,
 * and it is small enough that a missed reminder is repeated while folding still helps.
 * A fixed token count (not a window share) because quality loss follows tokens.
 */
export const NUDGE_STEP_TOKENS = 15_000;

/**
 * Share of the context one context_fold call should free to repay its cost. A fold costs its
 * folding turns plus the cache miss it causes, about ten cached reads of the whole context, so the
 * break-even scales with context size, not with a fixed token count. Measured return per dollar
 * crosses 1 between 20% and 30% freed (1,218 folds over 90 days; context-efficiency
 * chart_fold_payoff.py).
 */
export const FOLD_MIN_SHARE = 0.3;

/** Reminders that must fit between the threshold and the window's end. */
export const NUDGES_BEFORE_OVERFLOW = 3;

/**
 * Where reminders start and how far apart they are for one window size.
 * The threshold is the earlier of the two limits (Margin of Safety): the token limit catches
 * degraded quality on large windows, the percentage catches overflow on small ones.
 * The step shrinks when little room remains, so at least NUDGES_BEFORE_OVERFLOW reminders fit
 * before the window ends; native compaction is blocked, so there is no net below them.
 */
export function nudgeSchedule(
  window: number,
  settings: Settings,
): { threshold: number; step: number } {
  const threshold = Math.min(settings.nudgeAtTokens, (settings.nudgeAtPercent / 100) * window);
  // max(1, …) keeps the step positive when the threshold equals the window (100%).
  const step = Math.max(1, Math.min(NUDGE_STEP_TOKENS, (window - threshold) / NUDGES_BEFORE_OVERFLOW));
  return { threshold, step };
}

/**
 * Decides whether this turn should remind the agent to fold, following nudgeSchedule().
 * `band` is the token level of the last reminder step reached; a reminder fires only when a
 * higher band is reached while the agent keeps working (`continuing`).
 */
export function planNudge(
  tokens: number,
  window: number,
  settings: Settings,
  lastBand: number,
  continuing: boolean,
): { nudge: boolean; band: number } {
  if (!Number.isFinite(tokens) || !(window > 0)) return { nudge: false, band: 0 };
  const { threshold, step } = nudgeSchedule(window, settings);
  if (tokens < threshold) return { nudge: false, band: 0 };
  const band = threshold + step * Math.floor((tokens - threshold) / step);
  if (continuing && band > lastBand) return { nudge: true, band };
  return { nudge: false, band: lastBand };
}
