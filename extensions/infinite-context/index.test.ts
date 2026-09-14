import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import infiniteContext from "./index.ts";
import type { AgentMessageLike, BranchEntry } from "./messages.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
type Tool = {
  name: string;
  executionMode?: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

function harness(initial: BranchEntry[]) {
  let entries = [...initial];
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const notifications: string[] = [];
  let appended = 0;
  const pi = {
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", id: `state-${++appended}`, customType, data });
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
    setEntries(next: BranchEntry[]) {
      entries = next;
    },
    async emit(name: string, event: Record<string, unknown> = {}) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
      return result;
    },
  };
}

const entry = (id: string, role: string, content: AgentMessageLike["content"], timestamp: number): BranchEntry => ({
  type: "message",
  id,
  message: { role, content, timestamp },
});

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
  assert.equal((saved.data as { version: number }).version, 2);

  const overlay = (await h.emit("context", {
    messages: source.map((sourceEntry) => ({ ...(sourceEntry.message as AgentMessageLike) })),
  })) as { messages: AgentMessageLike[] };
  assert.equal(overlay.messages.length, 1);
  assert.equal(overlay.messages[0].content, "both");

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
    {
      type: "message",
      id: "bash",
      message: {
        role: "bashExecution",
        command: "secret",
        output: "hidden",
        excludeFromContext: true,
        timestamp: 1,
      },
    },
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

test("old snapshots and pre-compacted sessions are rejected rather than interpreted", async () => {
  const old = harness([
    entry("u1", "user", "one", 1),
    { type: "custom", id: "old", customType: "infinite-context", data: { spans: [] } },
  ]);
  await old.emit("session_start");
  assert.match(old.notifications[0], /Unsupported.*start a new session/);
  await assert.rejects(
    old.tools.get("context_map")!.execute("map", {}, undefined, undefined, old.ctx),
    /Unsupported/,
  );

  const compacted = harness([{ type: "compaction", id: "c", summary: "native" }]);
  await compacted.emit("session_start");
  assert.match(compacted.notifications[0], /already contains native compaction/);
});
