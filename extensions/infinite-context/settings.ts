/**
 * Parse the extension's optional settings file (location: see index.ts) and resolve the
 * settings one branch runs under.
 *
 * Both fields only tune when a reminder appears, so each one is fail-open on its own:
 * a missing or nonsensical value falls back to its default and a partial file still works
 * (KISS — refusing to run over a typo'd number helps nobody). Nothing here grants authority.
 *
 * `modelOverrides` maps an exact "provider/id" key to its own fields, the convention of Pi's
 * `compaction.modelOverrides` (Pi docs/compaction.md): each field falls back on its own from
 * the override to the top-level value to the default.
 */

/**
 * Session entry type recording the effective settings, for retrospective analysis. Separate
 * from the fold snapshot entry (forest.ts INFINITE_CONTEXT_ENTRY), whose latest entry is
 * parsed as fold state on load.
 */
export const SETTINGS_ENTRY = "infinite-context:settings";

/** Inclusive token bounds [min, max] with min < max. */
export type TokenRange = readonly [number, number];

/** The settings file for one model: a fixed token limit, or a range to draw one per branch from. */
export interface FileSettings {
  readonly nudgeAtTokens: number | TokenRange;
  readonly nudgeAtPercent: number;
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
}

/**
 * 150k tokens is where long contexts degrade on large-window models; 75% of a 200k window
 * is the same number, so small-window behavior is unchanged.
 */
export const DEFAULT_SETTINGS: Settings = {
  nudgeAtTokens: 150_000,
  nudgeAtPercent: 75,
};

/** A token count is a whole, positive number. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Two positive whole token counts, the first smaller. */
function tokenRange(value: unknown): TokenRange | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [min, max] = value.map((bound) => positiveInt(bound) ?? 0);
  return min > 0 && min < max ? [min, max] : undefined;
}

/** A window share above 100% could never be reached, so the range is (0, 100]. */
function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : undefined;
}

/** A JSON object; arrays and null are not. */
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parses the settings file's contents for `model` ("provider/id", or undefined when no model
 * is selected); unparseable text is treated as an empty file.
 */
export function parseSettings(json: string, model?: string): FileSettings {
  let file: Record<string, unknown> | undefined;
  try {
    file = object(JSON.parse(json));
  } catch {
    // Fall through to defaults; the file is the user's, not a contract we can repair.
  }
  const overrides = object(file?.modelOverrides);
  // Object.hasOwn keeps keys like "constructor" from resolving to Object.prototype members.
  const override =
    model !== undefined && overrides !== undefined && Object.hasOwn(overrides, model)
      ? object(overrides[model])
      : undefined;
  const tokens = (value: unknown) => tokenRange(value) ?? positiveInt(value);
  return {
    nudgeAtTokens:
      tokens(override?.nudgeAtTokens) ??
      tokens(file?.nudgeAtTokens) ??
      DEFAULT_SETTINGS.nudgeAtTokens,
    nudgeAtPercent:
      percent(override?.nudgeAtPercent) ??
      percent(file?.nudgeAtPercent) ??
      DEFAULT_SETTINGS.nudgeAtPercent,
  };
}

const sameRange = (a: unknown, b: TokenRange | undefined): boolean =>
  Array.isArray(a) && b !== undefined && a.length === 2 && a[0] === b[0] && a[1] === b[1];

/**
 * The settings a branch runs under. A fixed limit is used as is. A range assigns the branch
 * one limit drawn uniformly from it (a randomized experiment, unit = branch): the branch keeps
 * the limit of its latest record for the same range (`recorded`: the data of the branch's
 * settings entries in order, untrusted session data), so resuming, reloading, forking and
 * switching models back and forth stay in the same arm; otherwise `random` (in [0, 1)) draws
 * a new one. A range without a record starts a new draw, so edited settings still apply.
 */
export function resolveSettings(
  file: FileSettings,
  recorded: readonly unknown[],
  random: () => number,
): Settings {
  const { nudgeAtTokens, nudgeAtPercent } = file;
  if (typeof nudgeAtTokens === "number") return { nudgeAtTokens, nudgeAtPercent };
  const [min, max] = nudgeAtTokens;
  const keeps = (record: unknown) => {
    if (typeof record !== "object" || record === null) return false;
    const data = record as Record<string, unknown>;
    const kept = data.nudgeAtTokens;
    return (
      sameRange(data.nudgeAtTokensRange, nudgeAtTokens) &&
      typeof kept === "number" && Number.isInteger(kept) && kept >= min && kept <= max
    );
  };
  const record = recorded.filter(keeps).at(-1) as { nudgeAtTokens: number } | undefined;
  const drawn = record?.nudgeAtTokens ?? min + Math.floor(random() * (max - min + 1));
  return { nudgeAtTokens: drawn, nudgeAtPercent, nudgeAtTokensRange: nudgeAtTokens };
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
      : !sameRange(data.nudgeAtTokensRange, current.nudgeAtTokensRange))
  );
}
