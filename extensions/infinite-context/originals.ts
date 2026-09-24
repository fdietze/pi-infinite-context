import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type SessionEntry,
  type SessionProjection,
} from "@earendil-works/pi-coding-agent";

/**
 * One addressable branch entry: the archive leaf (`message`, always present) and
 * the message the model actually receives (`live`).
 *
 * `live` is undefined when Pi omits the entry from the model context — a
 * `context_edit` omission during retry recovery, or a `bashExecution` the user
 * excluded. Liveness alone drives token cost, tool units and fold anchoring.
 */
export interface OriginalMessage {
  readonly id: string;
  readonly message: AgentMessage;
  readonly live: AgentMessage | undefined;
}

export const ADDRESSABLE_ROLES = new Set<AgentMessage["role"]>([
  "user",
  "assistant",
  "toolResult",
  "custom",
  "bashExecution",
  "branchSummary",
]);

/** One model-visible position of the session projection, tagged with its owning entry. */
export interface ProjectedPosition {
  readonly id: string;
  readonly message: AgentMessage;
}

/** A leaf owns one entry id, so an entry must not project to several messages. */
function singleProjectedMessage(
  messages: readonly AgentMessage[],
): AgentMessage | undefined {
  // Map is not the territory: reject an SDK semantic change rather than aliasing an id.
  if (messages.length > 1)
    throw new Error("A session entry projected to multiple context messages");
  return messages[0];
}

/**
 * The projection positions that the `context` event is expected to start with.
 *
 * System messages are excluded: Pi passes the system prompt separately and the
 * `context` event never contains it.
 */
export function projectedPositions(projection: SessionProjection): ProjectedPosition[] {
  const positions: ProjectedPosition[] = [];
  for (const entry of projection.entries) {
    const message = singleProjectedMessage(entry.messages);
    if (message && message.role !== "system")
      positions.push({ id: entry.sourceEntry.id, message });
  }
  return positions;
}

/** Raw branch entries as archive leaves, joined with their live message by entry id. */
export function branchOriginals(
  branch: readonly SessionEntry[],
  projection: SessionProjection,
): OriginalMessage[] {
  const liveById = new Map<string, AgentMessage>();
  for (const { id, message } of projectedPositions(projection)) liveById.set(id, message);
  const output: OriginalMessage[] = [];
  for (const entry of branch) {
    const message = singleProjectedMessage(sessionEntryToContextMessages(entry));
    if (!message || !ADDRESSABLE_ROLES.has(message.role)) continue;
    const projected = liveById.get(entry.id);
    // Pi drops excluded bash output at the provider boundary, so the model never
    // receives it: it is an archive leaf with no live message.
    const live =
      projected && projected.role === "bashExecution" && projected.excludeFromContext
        ? undefined
        : projected;
    output.push({ id: entry.id, message, live });
  }
  return output;
}
