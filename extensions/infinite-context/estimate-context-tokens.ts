import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

/** Pi's estimate, except content that Pi explicitly excludes from provider context. */
export function estimateContextTokens(message: AgentMessage): number {
  return message.role === "bashExecution" && message.excludeFromContext
    ? 0
    : estimateTokens(message);
}
