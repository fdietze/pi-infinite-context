import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionProjection,
  type SessionEntry,
  type SessionProjection,
} from "@earendil-works/pi-coding-agent";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const userMessage = (content: string, timestamp = 1): AgentMessage => ({
  role: "user",
  content,
  timestamp,
});

export const assistantMessage = (
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
  timestamp = 1,
): AgentMessage => ({
  role: "assistant",
  content,
  api: "test",
  provider: "test",
  model: "test",
  usage,
  stopReason: "stop",
  timestamp,
});

export const toolResultMessage = (
  toolCallId: string,
  text: string,
  timestamp = 1,
): AgentMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp,
});

export const bashMessage = (
  command: string,
  output: string,
  timestamp = 1,
  excludeFromContext = false,
): AgentMessage => ({
  role: "bashExecution",
  command,
  output,
  exitCode: 0,
  cancelled: false,
  truncated: false,
  excludeFromContext,
  timestamp,
});

export const customMessage = (
  customType: string,
  content: string,
  timestamp = 1,
): AgentMessage => ({
  role: "custom",
  customType,
  content,
  display: true,
  timestamp,
});

export const messageEntry = (id: string, message: AgentMessage): SessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: new Date(message.timestamp).toISOString(),
  message,
});

/** An original the model receives exactly as it was persisted. */
export const original = (id: string, message: AgentMessage) => ({ id, message, live: message });

/** An archive leaf Pi keeps out of the model context (context edit or excluded bash). */
export const omittedOriginal = (id: string, message: AgentMessage) => ({
  id,
  message,
  live: undefined,
});

/**
 * The projection positions implied by a list of originals.
 *
 * Mirrors Pi: an entry omitted by `context_edit` has no position, while excluded
 * bash output still occupies one (Pi drops it later, at the provider boundary),
 * so it has a position but no live message.
 */
export const positionsOf = (
  originals: readonly { id: string; message: AgentMessage; live?: AgentMessage }[],
) =>
  originals.flatMap(({ id, message, live }) =>
    live
      ? [{ id, message: live }]
      : message.role === "bashExecution" && message.excludeFromContext
        ? [{ id, message }]
        : [],
  );

/** A real session is one parent chain; test fixtures declare entries in branch order. */
export const linkEntries = (entries: readonly SessionEntry[]): SessionEntry[] =>
  entries.map((entry, i) => ({ ...entry, parentId: i === 0 ? null : entries[i - 1].id }));

export const projectionOf = (entries: SessionEntry[]): SessionProjection =>
  buildSessionProjection(linkEntries(entries));

/** One user turn, two parallel calls with both results, then a plain reply. */
export const completedTools = () => [
  original("u0", userMessage("read both", 1)),
  original(
    "a1",
    assistantMessage(
      [
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
        { type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } },
      ],
      2,
    ),
  ),
  original("r2", toolResultMessage("c1", "A", 3)),
  original("r3", toolResultMessage("c2", "B", 4)),
  original("a4", assistantMessage([{ type: "text", text: "done" }], 5)),
];
