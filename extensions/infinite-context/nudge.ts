import { type ModelRef, type ReminderRule, type Settings, modelEntries } from "./settings.ts";

/**
 * Upper bound for the distance between two reminders. It exceeds the context growth of one
 * fold cycle (map, peeks, summaries: ~10k tokens), so the agent is not nagged while it folds,
 * and it is small enough that a missed reminder is repeated while folding still helps.
 * A fixed token count (not a window share) because quality loss follows tokens.
 */
export const NUDGE_STEP_TOKENS = 15_000;

/** Reminders that must fit between the threshold and the window's end. */
export const NUDGES_BEFORE_OVERFLOW = 3;

/**
 * Where reminders start and how far apart they are for one window size and model.
 * A per-model rule (settings `reminders`) sets the start and the step field by field: the exact
 * "provider/modelId" rule, then the provider's, then `reminders.default`; a field no rule sets
 * falls back to `nudgeAtTokens` (start) or NUDGE_STEP_TOKENS (step).
 * The threshold is the earlier of that start and the window share (Margin of Safety): the token
 * limit catches degraded quality on large windows, the percentage catches overflow on small ones.
 * The step shrinks when little room remains, so at least NUDGES_BEFORE_OVERFLOW reminders fit
 * before the window ends; native compaction is blocked, so there is no net below them.
 */
export function nudgeSchedule(
  window: number,
  settings: Settings,
  model?: ModelRef,
): { threshold: number; step: number } {
  const rules = settings.reminders
    ? [...modelEntries(settings.reminders.overrides, model), settings.reminders.default]
    : [];
  const pick = (key: keyof ReminderRule) => rules.find((rule) => rule[key] !== undefined)?.[key];
  const start = pick("startTokens") ?? settings.nudgeAtTokens;
  const threshold = Math.min(start, (settings.nudgeAtPercent / 100) * window);
  const every = pick("everyTokens") ?? NUDGE_STEP_TOKENS;
  // max(1, …) keeps the step positive when the threshold equals the window (100%).
  const step = Math.max(1, Math.min(every, (window - threshold) / NUDGES_BEFORE_OVERFLOW));
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
  model?: ModelRef,
): { nudge: boolean; band: number } {
  if (!Number.isFinite(tokens) || !(window > 0)) return { nudge: false, band: 0 };
  const { threshold, step } = nudgeSchedule(window, settings, model);
  if (tokens < threshold) return { nudge: false, band: 0 };
  const band = threshold + step * Math.floor((tokens - threshold) / step);
  if (continuing && band > lastBand) return { nudge: true, band };
  return { nudge: false, band: lastBand };
}

const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
// Below 1k a rounded "0k" would be misleading (nudgeAtPercent 100 gives a step of 1).
const exact = (tokens: number) => {
  const n = Math.max(1, Math.round(tokens));
  return tokens < 1000 ? `${n} token${n === 1 ? "" : "s"}` : k(tokens);
};

/**
 * The reminder's opening sentences: absolute tokens next to the window share, and the schedule
 * they follow. With per-model rules the share alone does not tell the agent how close it is.
 */
export function reminderText(
  tokens: number,
  window: number,
  schedule: { threshold: number; step: number },
): string {
  const percent = Math.round((tokens / window) * 100);
  return (
    `Context is ~${k(tokens)} tokens (${percent}% of the ${k(window)}-token window). ` +
    `Reminders start at ${k(schedule.threshold)} tokens and repeat every ${exact(schedule.step)}.`
  );
}
