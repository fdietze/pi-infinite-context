import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { serializeMessage } from "./serialize-message.ts";

/**
 * Compact text a map preview is cut from. Separate from the authoritative
 * serializeMessage (peek and search) because a map preview only has a few
 * characters to identify a message: assistant thinking is dropped and a tool
 * call shows its name and bare argument values instead of JSON syntax.
 */
export function previewMessage(message: AgentMessage): string {
  if (message.role !== "assistant") return serializeMessage(message);
  const texts: string[] = [];
  const calls: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") texts.push(block.text);
    else if (block.type === "toolCall") {
      const values = Object.values(block.arguments ?? {}).map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      );
      calls.push([block.name, ...values].join(" "));
    }
  }
  return [...texts, ...calls].join("; ");
}
