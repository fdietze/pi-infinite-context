import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export interface OriginalMessage {
  readonly id: string;
  readonly message: AgentMessage;
}

export const ADDRESSABLE_ROLES = new Set<AgentMessage["role"]>([
  "user",
  "assistant",
  "toolResult",
  "custom",
  "bashExecution",
  "branchSummary",
]);

/** Project raw current-branch entries with Pi's public session conversion. */
export function branchOriginals(branch: readonly SessionEntry[]): OriginalMessage[] {
  const output: OriginalMessage[] = [];
  for (const entry of branch) {
    const messages = sessionEntryToContextMessages(entry);
    // A forest leaf owns one session entry id. Pi currently projects zero or one
    // message per entry; reject an SDK semantic change rather than aliasing an id.
    if (messages.length > 1)
      throw new Error("A session entry projected to multiple context messages");
    const message = messages[0];
    if (message && ADDRESSABLE_ROLES.has(message.role))
      output.push({ id: entry.id, message });
  }
  return output;
}
