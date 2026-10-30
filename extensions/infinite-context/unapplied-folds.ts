/**
 * When saved folds cannot be applied, the unfolded transcript is several times larger than the
 * folded context: it costs far more than expected and can overflow the window. The extension
 * stops the first such request and lets the user decide (index.ts, `context` handler).
 */

/** True when snapshot data holds a root fold. Tolerant of garbage: it runs after a failed load. */
export function snapshotHasFolds(data: unknown): boolean {
  const roots = (data as { roots?: unknown } | null | undefined)?.roots;
  return Array.isArray(roots) && roots.some((root) => (root as { kind?: unknown } | null)?.kind === "fold");
}

/** What the user reads when a request was stopped: the reason and the three ways forward. */
export const unappliedFoldsNotice = (reason: string, sessionFile: string | undefined): string =>
  `infinite-context: saved folds cannot be applied (${reason}). ` +
  "This request was stopped instead of sending the unfolded transcript, which costs several times more and can overflow the window. " +
  "Send another message to continue unfolded, hand the work over to a new session, or have another agent repair the session file" +
  (sessionFile ? ` ${sessionFile}.` : ".");

/**
 * The request a stopped run carries. Pi passes the already aborted signal to the provider, so
 * this only matters for a transport that ignores it: the model then sees this one message.
 */
export const stoppedRequest = (timestamp: number) => [
  { role: "user" as const, content: "Reply only: folds could not be applied.", timestamp },
];
