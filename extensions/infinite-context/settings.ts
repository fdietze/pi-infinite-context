import { isDeepStrictEqual } from "node:util";

/**
 * Parse the extension's optional settings file (location: see index.ts) and resolve the
 * settings one branch runs under.
 *
 * Every field only tunes when a reminder appears, so each one is fail-open on its own:
 * a missing or nonsensical value falls back to its default and a partial file still works
 * (KISS — refusing to run over a typo'd number helps nobody). The same holds for each field of
 * a per-model reminder rule. Nothing here grants authority.
 */

/**
 * Session entry type recording the effective settings, for retrospective analysis. Separate
 * from the fold snapshot entry (forest.ts INFINITE_CONTEXT_ENTRY), whose latest entry is
 * parsed as fold state on load.
 */
export const SETTINGS_ENTRY = "infinite-context:settings";

/** Inclusive token bounds [min, max] with min < max. */
export type TokenRange = readonly [number, number];

/** Reminder limits for one provider or model; a missing field inherits (nudge.ts). */
export interface ReminderRule {
  /** First reminder at this many tokens; still never later than `nudgeAtPercent` of the window. */
  readonly startTokens?: number;
  /** Tokens between reminders above the start; still shrunk when little room remains. */
  readonly everyTokens?: number;
}

/** Per-model reminder rules: `overrides` keyed by exact "provider/modelId" or by provider. */
export interface Reminders {
  readonly default: ReminderRule;
  readonly overrides: Readonly<Record<string, ReminderRule>>;
}

/** The settings file: a fixed token limit, or a range to draw one per branch from. */
export interface FileSettings {
  readonly nudgeAtTokens: number | TokenRange;
  readonly nudgeAtPercent: number;
  /** Present only when the file sets at least one valid rule field. */
  readonly reminders?: Reminders;
}

/** The settings one branch runs under; recorded as the SETTINGS_ENTRY data. */
export interface Settings {
  /** Remind once the context holds at least this many tokens. */
  readonly nudgeAtTokens: number;
  /** Remind once the context fills at least this percentage of the model's window. */
  readonly nudgeAtPercent: number;
  /**
   * Present only when nudgeAtTokens was drawn from this range: it marks the branch as part of
   * a randomized experiment on the reminder limit, so analyses can tell assigned limits from
   * chosen ones.
   */
  readonly nudgeAtTokensRange?: TokenRange;
  /** Per-model rules, as parsed from the file; absent when there are none. */
  readonly reminders?: Reminders;
}

/**
 * 150k tokens is where long contexts degrade on large-window models; 75% of a 200k window
 * is the same number, so small-window behavior is unchanged.
 */
export const DEFAULT_SETTINGS: Settings = {
  nudgeAtTokens: 150_000,
  nudgeAtPercent: 75,
};

/** The provider and id of a model, as Pi names them. */
export interface ModelRef {
  readonly provider?: string;
  readonly id?: string;
}

/** What a table keyed by exact "provider/modelId" or by provider holds for `model`, most specific first. */
export function modelEntries<T>(table: Readonly<Record<string, T>>, model: ModelRef | undefined): T[] {
  const exact = model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;
  return [exact, model?.provider].flatMap((key) =>
    key !== undefined && Object.hasOwn(table, key) ? [table[key]] : [],
  );
}

/** A token count is a whole, positive number. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Two positive whole token counts, the first smaller. */
function tokenRange(value: unknown): TokenRange | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [min, max] = value.map((bound) => positiveInt(bound, 0));
  return min > 0 && min < max ? [min, max] : undefined;
}

/** A window share above 100% could never be reached, so the range is (0, 100]. */
function percent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : fallback;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The valid fields of one rule; undefined when none is valid. */
function reminderRule(value: unknown): ReminderRule | undefined {
  if (!isRecord(value)) return undefined;
  const startTokens = positiveInt(value.startTokens, 0);
  const everyTokens = positiveInt(value.everyTokens, 0);
  const rule = {
    ...(startTokens > 0 && { startTokens }),
    ...(everyTokens > 0 && { everyTokens }),
  };
  return Object.keys(rule).length > 0 ? rule : undefined;
}

/** The `reminders` block, keeping only valid rule fields; undefined when nothing valid is left. */
function parseReminders(value: unknown): Reminders | undefined {
  if (!isRecord(value)) return undefined;
  const overrides: Record<string, ReminderRule> = {};
  if (isRecord(value.overrides))
    for (const [key, raw] of Object.entries(value.overrides)) {
      const rule = reminderRule(raw);
      if (rule) overrides[key] = rule;
    }
  const fallback = reminderRule(value.default) ?? {};
  return Object.keys(fallback).length > 0 || Object.keys(overrides).length > 0
    ? { default: fallback, overrides }
    : undefined;
}

const withReminders = (reminders: Reminders | undefined) => (reminders ? { reminders } : {});

/** Parses the settings file's contents; unparseable text is treated as an empty file. */
export function parseSettings(json: string): FileSettings {
  let value: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) value = parsed as Record<string, unknown>;
  } catch {
    // Fall through to defaults; the file is the user's, not a contract we can repair.
  }
  return {
    nudgeAtTokens:
      tokenRange(value?.nudgeAtTokens) ??
      positiveInt(value?.nudgeAtTokens, DEFAULT_SETTINGS.nudgeAtTokens),
    nudgeAtPercent: percent(value?.nudgeAtPercent, DEFAULT_SETTINGS.nudgeAtPercent),
    ...withReminders(parseReminders(value?.reminders)),
  };
}

const sameRange = (a: unknown, b: TokenRange | undefined): boolean =>
  Array.isArray(a) && b !== undefined && a.length === 2 && a[0] === b[0] && a[1] === b[1];

/**
 * The settings a branch runs under. A fixed limit is used as is. A range assigns the branch
 * one limit drawn uniformly from it (a randomized experiment, unit = branch): the branch keeps
 * the limit its latest record (`recorded`, untrusted session data) holds for the same range,
 * so resuming, reloading and forking stay in the same arm; otherwise `random` (in [0, 1))
 * draws a new one. A changed range starts a new draw, so edited settings still apply.
 */
export function resolveSettings(
  file: FileSettings,
  recorded: unknown,
  random: () => number,
): Settings {
  const { nudgeAtTokens, nudgeAtPercent } = file;
  const rules = withReminders(file.reminders);
  if (typeof nudgeAtTokens === "number") return { nudgeAtTokens, nudgeAtPercent, ...rules };
  const [min, max] = nudgeAtTokens;
  const data = (typeof recorded === "object" && recorded !== null ? recorded : {}) as Record<
    string,
    unknown
  >;
  const kept = data.nudgeAtTokens;
  const drawn =
    sameRange(data.nudgeAtTokensRange, nudgeAtTokens) &&
    typeof kept === "number" && Number.isInteger(kept) && kept >= min && kept <= max
      ? kept
      : min + Math.floor(random() * (max - min + 1));
  return { nudgeAtTokens: drawn, nudgeAtPercent, nudgeAtTokensRange: nudgeAtTokens, ...rules };
}

/**
 * True when `recorded` (the data of the latest settings entry on the branch, if any) does not
 * describe `current`. Untrusted session data, so anything unexpected counts as changed.
 */
export function settingsChanged(recorded: unknown, current: Settings): boolean {
  if (typeof recorded !== "object" || recorded === null) return true;
  const data = recorded as Record<string, unknown>;
  return (
    data.nudgeAtTokens !== current.nudgeAtTokens ||
    data.nudgeAtPercent !== current.nudgeAtPercent ||
    (current.nudgeAtTokensRange === undefined
      ? data.nudgeAtTokensRange !== undefined
      : !sameRange(data.nudgeAtTokensRange, current.nudgeAtTokensRange)) ||
    !isDeepStrictEqual(data.reminders, current.reminders)
  );
}
