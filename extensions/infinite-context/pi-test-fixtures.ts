import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
