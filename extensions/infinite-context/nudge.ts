export const NUDGE_BASE_PERCENT = 75;
export const NUDGE_STEP_PERCENT = 5;

export function planNudge(
  percent: number,
  lastBand: number,
  continuing: boolean,
): { nudge: boolean; band: number } {
  if (!Number.isFinite(percent) || percent < NUDGE_BASE_PERCENT)
    return { nudge: false, band: 0 };
  const band =
    NUDGE_BASE_PERCENT +
    NUDGE_STEP_PERCENT * Math.floor((percent - NUDGE_BASE_PERCENT) / NUDGE_STEP_PERCENT);
  if (continuing && band > lastBand) return { nudge: true, band };
  return { nudge: false, band: lastBand };
}
