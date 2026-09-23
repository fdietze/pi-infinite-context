import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Tool as AiTool,
  type ToolCall,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import infiniteContext from "./index.ts";
import { MAX_OUTPUT_BYTES } from "./output.ts";
import {
  assistantMessage,
  bashMessage,
  messageEntry,
  toolResultMessage,
  userMessage,
} from "./pi-test-fixtures.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
type RegisteredTool = {
  name: string;
  description: string;
  parameters: object;
  executionMode?: string;
  prepareArguments?: (arguments_: unknown) => unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

function harness(initial: SessionEntry[]) {
  let entries = [...initial];
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, RegisteredTool>();
  const notifications: string[] = [];
  let appended = 0;
  const pi = {
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({
        type: "custom",
        id: `state-${++appended}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date(appended).toISOString(),
        customType,
        data,
      });
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getBranch: () => entries },
    ui: { notify: (text: string) => notifications.push(text) },
    getContextUsage: () => ({ contextWindow: 100_000, tokens: 10_000 }),
  } as unknown as ExtensionContext;
  infiniteContext(pi);
  return {
    tools,
    notifications,
    ctx,
    entries: () => entries,
    setEntries(next: SessionEntry[]) {
      entries = next;
    },
    async emit(name: string, event: Record<string, unknown> = {}) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
      return result;
    },
  };
}

const entry = (
  id: string,
  role: "user" | "assistant",
  content: string | Extract<AgentMessage, { role: "assistant" }>["content"],
  timestamp: number,
): SessionEntry => messageEntry(
  id,
  role === "user"
    ? userMessage(content as string, timestamp)
    : assistantMessage(content as Extract<AgentMessage, { role: "assistant" }>["content"], timestamp),
);

test("registers the approved five-tool surface in sequential mode", () => {
  const h = harness([]);
  assert.deepEqual([...h.tools.keys()], [
    "context_map",
    "context_peek",
    "context_search",
    "context_fold",
    "context_summary",
  ]);
  assert.ok([...h.tools.values()].every((tool) => tool.executionMode === "sequential"));
  assert.equal(h.tools.has("context_unfold"), false);
});

test("every native compaction reason is cancelled with an explanation", async () => {
  const h = harness([]);
  for (const reason of ["manual", "threshold", "overflow"]) {
    assert.deepEqual(await h.emit("session_before_compact", { reason }), { cancel: true });
  }
  assert.equal(h.notifications.length, 3);
  assert.match(h.notifications[2], /blocked overflow compaction/);
});

test("fold persists v2, overlays one summary, and reloads its own snapshot", async () => {
  const source = [entry("u1", "user", "one", 1), entry("u2", "user", "two", 2)];
  const h = harness(source);
  await h.emit("session_start");
  const fold = h.tools.get("context_fold")!;
  const result = await fold.execute(
    "call",
    { items: [{ from: "u1", to: "u2", summary: "both" }] },
    undefined,
    undefined,
    h.ctx,
  );
  assert.match(result.content[0].text, /Created 1 fold/);
  const saved = h.entries().at(-1)!;
  assert.equal(saved.type === "custom" && (saved.data as { version: number }).version, 2);

  const overlay = (await h.emit("context", {
    messages: source.map((sourceEntry) => ({ ...(sourceEntry.type === "message" && sourceEntry.message) })),
  })) as { messages: AgentMessage[] };
  assert.equal(overlay.messages.length, 1);
  assert.equal(
    overlay.messages[0].role === "user" && overlay.messages[0].content,
    "both",
  );

  await h.emit("session_start", { reason: "reload" });
  const map = await h.tools.get("context_map")!.execute("map", {}, undefined, undefined, h.ctx);
  assert.match(map.content[0].text, /fold-/);
  assert.match(map.content[0].text, /both/);
});

test("new originals append after a fold; tree navigation reconstructs branch-local state", async () => {
  const source = [entry("u1", "user", "one", 1), entry("u2", "user", "two", 2)];
  const h = harness(source);
  await h.emit("session_start");
  await h.tools.get("context_fold")!.execute(
    "call",
    { items: [{ from: "u1", to: "u2", summary: "old" }] },
    undefined,
    undefined,
    h.ctx,
  );
  h.setEntries([...h.entries(), entry("u3", "user", "new", 3)]);
  const map = await h.tools.get("context_map")!.execute("map", {}, undefined, undefined, h.ctx);
  assert.match(map.content[0].text, /old/);
  assert.match(map.content[0].text, /\[#u3\]/);

  h.setEntries([source[0]]);
  await h.emit("session_tree", { newLeafId: "u1" });
  const branchMap = await h.tools.get("context_map")!.execute("map", {}, undefined, undefined, h.ctx);
  assert.doesNotMatch(branchMap.content[0].text, /old/);
  assert.match(branchMap.content[0].text, /\[#u1\]/);
});

test("folding only excluded bash reports the actual zero provider-context delta", async () => {
  const h = harness([
    messageEntry("bash", bashMessage("secret", "hidden", 1, true)),
  ]);
  await h.emit("session_start");
  const result = await h.tools.get("context_fold")!.execute(
    "call",
    { items: [{ from: "bash", summary: "excluded" }] },
    undefined,
    undefined,
    h.ctx,
  );
  assert.match(result.content[0].text, /no estimated context change/);
});

test("generic argument budget bounds the real Pi validation-error path", () => {
  const h = harness([entry("u1", "user", "one", 1)]);
  const validate = (name: string, arguments_: unknown) => {
    const tool = h.tools.get(name)!;
    const prepared = tool.prepareArguments?.(arguments_) ?? arguments_;
    const call: ToolCall = {
      type: "toolCall",
      id: "call",
      name,
      arguments: prepared as ToolCall["arguments"],
    };
    return validateToolArguments(tool as unknown as AiTool, call);
  };
  const validationError = (name: string, arguments_: unknown) => {
    let caught: Error | undefined;
    try {
      validate(name, arguments_);
    } catch (error) {
      caught = error as Error;
    }
    assert.ok(caught, "expected schema validation failure");
    return `Error: ${caught.message}`;
  };

  // Valid provider JSON passes preparation unchanged, including the largest ASCII summary.
  assert.deepEqual(validate("context_map", {}), {});
  assert.deepEqual(validate("context_peek", { id: "u1", offset: 1, limit: 100 }), {
    id: "u1",
    offset: 1,
    limit: 100,
  });
  assert.deepEqual(validate("context_search", { patterns: ["needle"] }), {
    patterns: ["needle"],
  });
  assert.deepEqual(validate("context_summary", { id: "fold", summary: "x".repeat(12_000) }), {
    id: "fold",
    summary: "x".repeat(12_000),
  });
  const maximalFold = {
    items: [{
      from: "f".repeat(128),
      to: "t".repeat(128),
      summary: "s".repeat(12_000),
    }],
  };
  assert.deepEqual(validate("context_fold", maximalFold), maximalFold);

  const huge = "😀\n\\\"".repeat(50_000);
  const errors = [
    validationError("context_peek", null),
    validationError("context_peek", {}),
    validationError("context_search", { patterns: {} }),
    validationError("context_fold", { items: Array.from({ length: 1000 }, () => ({})) }),
    // This stays just below the guard and maximizes per-element TypeBox paths.
    validationError("context_search", { patterns: Array.from({ length: 6649 }, () => 0) }),
    validationError("context_summary", { summary: "x".repeat(12_000) }),
    validationError("context_summary", { summary: "😀\n\\\"".repeat(1000) }),
    validationError("context_peek", { id: huge }),
    validationError("context_search", { patterns: [huge] }),
    validationError("context_fold", { items: [{ from: "u1", summary: huge }] }),
  ];
  for (const error of errors)
    assert.ok(
      Buffer.byteLength(error, "utf8") < MAX_OUTPUT_BYTES,
      `validation error exceeded ${MAX_OUTPUT_BYTES} bytes`,
    );
  assert.doesNotMatch(errors.at(-1)!, /😀{100}/);
});

test("reload rejects v2 snapshots that split or hide unfinished tool units", async () => {
  const assistant = entry(
    "a1",
    "assistant",
    [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
    1,
  );
  const result = messageEntry("r1", toolResultMessage("call", "done", 2));
  const split = harness([
    assistant,
    result,
    {
      type: "custom",
      id: "state",
      parentId: "r1",
      timestamp: new Date(3).toISOString(),
      customType: "infinite-context",
      data: {
        version: 2,
        roots: [
          { kind: "fold", id: "fold-a", summary: "call", children: [{ kind: "message", id: "a1" }] },
          { kind: "message", id: "r1" },
        ],
      },
    },
  ]);
  await split.emit("session_start");
  assert.match(split.notifications[0], /splits an assistant tool call/);

  const unfinished = harness([
    assistant,
    {
      type: "custom",
      id: "state",
      parentId: "a1",
      timestamp: new Date(2).toISOString(),
      customType: "infinite-context",
      data: {
        version: 2,
        roots: [
          { kind: "fold", id: "fold-a", summary: "pending", children: [{ kind: "message", id: "a1" }] },
        ],
      },
    },
  ]);
  await unfinished.emit("session_start");
  assert.match(unfinished.notifications[0], /unfinished tool-call unit/);
});

test("old snapshots and pre-compacted sessions are rejected rather than interpreted", async () => {
  const old = harness([
    entry("u1", "user", "one", 1),
    {
      type: "custom",
      id: "old",
      parentId: "u1",
      timestamp: new Date(2).toISOString(),
      customType: "infinite-context",
      data: { spans: [] },
    },
  ]);
  await old.emit("session_start");
  assert.match(old.notifications[0], /Unsupported.*start a new session/);
  await assert.rejects(
    old.tools.get("context_map")!.execute("map", {}, undefined, undefined, old.ctx),
    /Unsupported/,
  );

  const compacted = harness([{
    type: "compaction",
    id: "c",
    parentId: null,
    timestamp: new Date(1).toISOString(),
    summary: "native",
    firstKeptEntryId: "c",
    tokensBefore: 1,
  }]);
  await compacted.emit("session_start");
  assert.match(compacted.notifications[0], /already contains native compaction/);
});
