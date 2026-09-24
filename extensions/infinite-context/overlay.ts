import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Forest, Item } from "./forest.ts";
import { originalIds } from "./forest.ts";
import { ADDRESSABLE_ROLES, type OriginalMessage } from "./originals.ts";
import { serializeMessage } from "./serialize-message.ts";

/** Overlay only the request copy; raw session messages remain untouched. */
export function buildOverlay(
  messages: AgentMessage[],
  originals: readonly OriginalMessage[],
  roots: Forest,
): AgentMessage[] {
  const byId = new Map(originals.map((original) => [original.id, original] as const));
  // Excluded bash entries remain searchable archive sources but cannot anchor a
  // synthetic fold projection: Pi would otherwise receive content it excluded.
  const projectionAnchor = new Map<Item, string>();
  for (const root of roots) {
    const anchor = originalIds([root]).find((id) => {
      const message = byId.get(id)!.message;
      return message.role !== "bashExecution" || !message.excludeFromContext;
    });
    if (anchor) projectionAnchor.set(root, anchor);
  }
  const rootByOriginal = new Map<string, Item>();
  for (const root of roots)
    for (const id of originalIds([root])) rootByOriginal.set(id, root);

  const queues = new Map<string, string[]>();
  const customQueues = new Map<string, string[]>();
  const customOriginalCounts = new Map<string, number>();
  const available = new Set(originals.map(({ id }) => id));
  const customKey = (message: AgentMessage) =>
    `${message.role === "custom" ? message.customType : ""}|${serializeMessage(message)}`;
  const foldedCallIds = new Set<string>();
  for (const { id, message } of originals) {
    const key = `${message.timestamp}|${message.role}`;
    const queue = queues.get(key) ?? [];
    queue.push(id);
    queues.set(key, queue);
    if (message.role === "custom") {
      const fallback = customQueues.get(customKey(message)) ?? [];
      fallback.push(id);
      const key = customKey(message);
      customQueues.set(key, fallback);
      customOriginalCounts.set(key, (customOriginalCounts.get(key) ?? 0) + 1);
    }
    const root = rootByOriginal.get(id);
    if (root?.kind === "fold" && message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content)
        if (block.type === "toolCall" && typeof block.id === "string") foldedCallIds.add(block.id);
    }
  }

  const customEventCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "custom") continue;
    const key = customKey(message);
    customEventCounts.set(key, (customEventCounts.get(key) ?? 0) + 1);
  }
  const take = (queue: string[] | undefined) => {
    while (queue?.length) {
      const id = queue.shift()!;
      if (available.delete(id)) return id;
    }
    return undefined;
  };
  const output: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId && foldedCallIds.has(message.toolCallId))
      continue;
    if (!ADDRESSABLE_ROLES.has(message.role)) {
      output.push(message);
      continue;
    }
    // Custom-message persistence timestamps are created independently from the
    // in-memory message timestamp. Fall back to its stable payload projection.
    const id =
      take(queues.get(`${message.timestamp}|${message.role}`)) ??
      (message.role === "custom" &&
      customOriginalCounts.get(customKey(message)) === 1 &&
      customEventCounts.get(customKey(message)) === 1
        ? take(customQueues.get(customKey(message)))
        : undefined);
    if (!id) {
      output.push(message);
      continue;
    }
    const root = rootByOriginal.get(id);
    if (!root || root.kind === "message") {
      output.push(message);
      continue;
    }
    if (projectionAnchor.get(root) !== id) continue;
    const count = originalIds([root]).length;
    output.push({
      role: "user",
      content: root.summary || `(folded archive: ${count} messages)`,
      timestamp: message.timestamp,
    });
  }
  return output;
}
