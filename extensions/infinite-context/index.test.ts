import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
import type { Snapshot } from "./forest.ts";
import type { Settings } from "./settings.ts";
import {
  assistantMessage,
  bashMessage,
  linkEntries,
  messageEntry,
  projectionOf,
  toolResultMessage,
  userMessage,
} from "./pi-test-fixtures.ts";

// The extension reads <agent dir>/infinite-context/settings.json when it is created. An empty
// agent dir keeps the tests on the defaults whatever the developer has configured. node --test
// runs each file in its own process, so this does not leak into other test files.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "infinite-context-test-"));

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
  let status: string | undefined;
  const sent: string[] = [];
  let aborts = 0;
  let usage = { contextWindow: 100_000, tokens: 10_000 };
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
    sendMessage(message: { content: string }) {
      sent.push(message.content);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: {
      getBranch: () => linkEntries(entries),
      buildSessionProjection: () => projectionOf(entries),
      getSessionFile: () => "/sessions/s.jsonl",
    },
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (_key: string, text: string | undefined) => {
        status = text;
      },
    },
    abort: () => {
      aborts++;
    },
    getContextUsage: () => usage,
  } as unknown as ExtensionContext;
  infiniteContext(pi);
  return {
    tools,
    notifications,
    sent,
    aborts: () => aborts,
    status: () => status,
    ctx,
    setUsage(next: typeof usage) {
      usage = next;
    },
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

test("each branch records the effective settings once, again after switching to a branch without them", async () => {
  const settingsEntries = (h: ReturnType<typeof harness>) =>
    h.entries().filter((e) => e.type === "custom" && e.customType === "infinite-context:settings");
  const source = [entry("u1", "user", "one", 1)];
  const h = harness(source);
  await h.emit("session_start");
  await h.emit("session_start", { reason: "reload" });
  assert.equal(settingsEntries(h).length, 1);
  const recorded = settingsEntries(h)[0];
  assert.deepEqual(recorded.type === "custom" && recorded.data, {
    nudgeAtTokens: 150_000,
    nudgeAtPercent: 75,
  });

  h.setEntries(source);
  await h.emit("session_tree");
  assert.equal(settingsEntries(h).length, 1);
});

test("a token range assigns each branch one recorded limit that survives reloads", async () => {
  const file = path.join(process.env.PI_CODING_AGENT_DIR!, "infinite-context", "settings.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ nudgeAtTokens: [100_000, 250_000] }));
  const source = [entry("u1", "user", "one", 1)];
  const h = harness(source); // reads the file when created
  rmSync(file);
  const recorded = () =>
    h.entries().flatMap((e) =>
      e.type === "custom" && e.customType === "infinite-context:settings" ? [e.data as Settings] : [],
    );
  await h.emit("session_start");
  await h.emit("session_start", { reason: "reload" });
  assert.equal(recorded().length, 1);
  const [first] = recorded();
  assert.deepEqual(first.nudgeAtTokensRange, [100_000, 250_000]);
  assert.ok(first.nudgeAtTokens >= 100_000 && first.nudgeAtTokens <= 250_000);

  // A branch without a record (e.g. a new session in the same process) gets its own draw.
  h.setEntries(source);
  await h.emit("session_tree");
  assert.equal(recorded().length, 1);
  assert.deepEqual(recorded()[0].nudgeAtTokensRange, [100_000, 250_000]);
});

test("a reminder names the fold size that pays off and skips the stale usage of a folding turn", async () => {
  const h = harness([entry("u1", "user", "one", 1)]);
  await h.emit("session_start");
  h.setUsage({ contextWindow: 1_000_000, tokens: 200_000 });
  const turn = (toolName: string) =>
    h.emit("turn_end", { message: { stopReason: "toolUse" }, toolResults: [{ toolName }] });

  await turn("context_fold");
  assert.deepEqual(h.sent, []);

  await turn("bash");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /frees ~60k tokens or more/);
});

test("registers the approved four-tool surface in sequential mode", () => {
  const h = harness([]);
  assert.deepEqual([...h.tools.keys()], [
    "context_map",
    "context_peek",
    "context_search",
    "context_fold",
  ]);
  assert.ok([...h.tools.values()].every((tool) => tool.executionMode === "sequential"));
  assert.equal(h.tools.has("context_summary"), false);
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
    `[#${(result.details as { ids: string[] }).ids[0]}] archived fold summary:\nboth`,
  );

  await h.emit("session_start", { reason: "reload" });
  const map = await h.tools.get("context_map")!.execute("map", {}, undefined, undefined, h.ctx);
  assert.match(map.content[0].text, /fold-/);
  assert.match(map.content[0].text, /both/);
});

test("from-only refolding revises active context and keeps readable, searchable summary history", async () => {
  const source = [entry("u1", "user", "one", 1), entry("u2", "user", "two", 2)];
  const h = harness(source);
  const call = (name: string, params: Record<string, unknown>) =>
    h.tools.get(name)!.execute("call", params, undefined, undefined, h.ctx);
  const fold = async (params: Record<string, unknown>) => {
    const result = await call("context_fold", params);
    return (result.details as { ids: string[] }).ids[0];
  };
  const saved = () => (h.entries().at(-1) as Extract<SessionEntry, { type: "custom" }>).data as Snapshot;

  const innerId = await fold({ items: [{ from: "u1", summary: "inner history" }] });
  const oldId = await fold({ items: [{ from: innerId, to: "u2", summary: "previous history" }] });
  const previous = saved().roots[0];
  const before = structuredClone(previous);
  const newId = await fold({ items: [{ from: oldId, summary: "current state" }] });
  assert.notEqual(newId, oldId);
  assert.notEqual(newId, innerId);
  const revised = saved().roots[0];
  assert.equal(revised.id, newId);
  assert.equal(revised.kind, "fold");
  if (revised.kind !== "fold") throw new Error("Expected a fold");
  assert.equal(revised.summary, "current state");
  assert.deepEqual(revised.children, [before]);
  assert.equal(revised.children[0], previous);

  // Favor Immutability: reloading and reading history leave the active projection intact.
  await h.emit("session_start", { reason: "reload" });
  const entriesBeforeReads = structuredClone(h.entries());
  const peek = await call("context_peek", { id: oldId });
  assert.equal(peek.content[0].text, `previous history\n[#${oldId}] fold summary · lines 1-1 of 1`);
  const innerPeek = await call("context_peek", { id: innerId });
  assert.match(innerPeek.content[0].text, /^inner history\n/);
  const search = await call("context_search", { patterns: ["previous history"] });
  assert.equal((search.details as { matches: number }).matches, 1);
  assert.ok(search.content[0].text.includes(`[#${oldId}] fold summary · child of [#${newId}]`));
  assert.match(search.content[0].text, /1: previous history/);
  const children = await call("context_map", { id: newId });
  assert.ok(children.content[0].text.includes(`[#${oldId}]`));
  assert.match(children.content[0].text, /previous history/);

  const overlay = await h.emit("context", {
    messages: source.map((sourceEntry) => sourceEntry.type === "message" && sourceEntry.message),
  }) as { messages: AgentMessage[] };
  assert.equal(overlay.messages.length, 1);
  assert.equal(
    overlay.messages[0].role === "user" && overlay.messages[0].content,
    `[#${newId}] archived fold summary:\ncurrent state`,
  );
  assert.deepEqual(h.entries(), entriesBeforeReads);
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

test("maximal tool arguments pass Pi's own schema validation", () => {
  const h = harness([entry("u1", "user", "one", 1)]);
  const validate = (name: string, arguments_: unknown) => {
    const tool = h.tools.get(name)!;
    const call: ToolCall = {
      type: "toolCall",
      id: "call",
      name,
      arguments: arguments_ as ToolCall["arguments"],
    };
    return validateToolArguments(tool as unknown as AiTool, call);
  };

  assert.deepEqual(validate("context_map", {}), {});
  assert.deepEqual(validate("context_search", { patterns: ["needle"] }), {
    patterns: ["needle"],
  });
  const maximalFold = {
    items: [{
      from: "f".repeat(128),
      to: "t".repeat(128),
      summary: "s".repeat(12_000),
    }],
  };
  assert.deepEqual(validate("context_fold", maximalFold), maximalFold);
  // Invalid arguments are rejected by Pi with its own actionable schema error.
  assert.throws(
    () => validate("context_fold", { items: [{ from: "fold", summary: "x".repeat(12_001) }] }),
    /must not have more than 12000 characters/,
  );
  assert.throws(() => validate("context_fold", { items: [{ summary: "no from id" }] }), /from/);
});

test("reload rejects a split tool unit and accepts a folded abandoned call", async () => {
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
  assert.match(split.notifications[0], /splits the tool call of "a1"/);

  // An abandoned call is a complete unit: a snapshot folding it stays loadable.
  const abandoned = harness([
    assistant,
    messageEntry("u2", userMessage("next", 2)),
    {
      type: "custom",
      id: "state",
      parentId: "u2",
      timestamp: new Date(3).toISOString(),
      customType: "infinite-context",
      data: {
        version: 2,
        roots: [
          { kind: "fold", id: "fold-a", summary: "abandoned", children: [{ kind: "message", id: "a1" }] },
          { kind: "message", id: "u2" },
        ],
      },
    },
  ]);
  await abandoned.emit("session_start");
  assert.deepEqual(abandoned.notifications, []);
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
  assert.match(compacted.notifications[0], /contains native compaction/);
});

test("id errors name the id and the next step", async () => {
  const h = harness([entry("u1", "user", "one", 1), entry("u2", "user", "two", 2)]);
  await h.emit("session_start");
  await h.tools.get("context_fold")!.execute(
    "call",
    { items: [{ from: "u1", to: "u2", summary: "both" }] },
    undefined,
    undefined,
    h.ctx,
  );
  const foldId = (h.entries().at(-1) as { data: { roots: { id: string }[] } }).data.roots[0].id;
  const call = (name: string, params: Record<string, unknown>) =>
    h.tools.get(name)!.execute("call", params, undefined, undefined, h.ctx);

  await assert.rejects(call("context_peek", { id: "nope" }), /"nope" is not in the archive/);
  await assert.rejects(call("context_map", { id: "nope" }), /"nope" is not in the archive/);
  await assert.rejects(call("context_map", { id: "u1" }), /"u1" is a message, not a fold/);
  await assert.rejects(
    call("context_fold", { items: [{ from: "u1", summary: "x" }] }),
    /"u1" is not a root: it is inside fold "/,
  );
  await assert.rejects(
    call("context_search", { patterns: ["("] }),
    /Pattern 1 is not a valid JavaScript regular expression/,
  );
  assert.ok(foldId);
});

const snapshotEntry = (parentId: string, roots: unknown[]): SessionEntry => ({
  type: "custom",
  id: "state",
  parentId,
  timestamp: new Date(9).toISOString(),
  customType: "infinite-context",
  data: { version: 2, roots },
});
const requestOf = (entries: SessionEntry[]) => ({
  messages: entries.flatMap((e) => (e.type === "message" ? [{ ...e.message }] : [])),
});
const compactionEntry = (parentId: string): SessionEntry => ({
  type: "compaction",
  id: "compaction",
  parentId,
  timestamp: new Date(10).toISOString(),
  summary: "native summary",
  firstKeptEntryId: parentId,
  tokensBefore: 1,
});
const foldedHarness = async () => {
  const source = [entry("u1", "user", "one", 1), entry("u2", "user", "two", 2), entry("u3", "user", "three", 3)];
  const h = harness(source);
  await h.emit("session_start");
  await h.tools.get("context_fold")!.execute(
    "call",
    { items: [{ from: "u1", to: "u2", summary: "both" }] },
    undefined,
    undefined,
    h.ctx,
  );
  return { h, source };
};

test("saved folds that cannot be loaded stop the first request, then the user's next request goes out unfolded", async () => {
  const source = [entry("u1", "user", "one", 1), entry("u2", "user", "two", 2)];
  // The snapshot lists an original the branch no longer has.
  const h = harness([
    ...source,
    snapshotEntry("u2", [
      { kind: "fold", id: "fold-a", summary: "s", children: [{ kind: "message", id: "gone" }] },
      { kind: "message", id: "u1" },
      { kind: "message", id: "u2" },
    ]),
  ]);
  await h.emit("session_start");
  const stopped = (await h.emit("context", requestOf(source))) as { messages: AgentMessage[] };
  assert.equal(stopped.messages.length, 1);
  assert.equal(h.aborts(), 1);
  const notice = h.notifications.at(-1)!;
  assert.match(notice, /saved folds cannot be applied \(Snapshot lists message gone/);
  assert.match(notice, /continue unfolded, hand the work over to a new session, or have another agent repair the session file \/sessions\/s\.jsonl\./);

  assert.equal(await h.emit("context", requestOf(source)), undefined);
  assert.equal(h.aborts(), 1);
  assert.equal(h.status(), "folds not applied: sending unfolded");

  // A reload tries the folds again and stops again.
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.status(), undefined);
  await h.emit("context", requestOf(source));
  assert.equal(h.aborts(), 2);
});

test("a snapshot without folds that cannot be loaded leaves the request untouched", async () => {
  const source = [entry("u1", "user", "one", 1)];
  const h = harness([...source, snapshotEntry("u1", [{ kind: "message", id: "gone" }])]);
  await h.emit("session_start");
  assert.equal(await h.emit("context", requestOf(source)), undefined);
  assert.equal(h.aborts(), 0);
});

test("a request whose projection does not match stops only when folds exist", async () => {
  const plain = harness([entry("u1", "user", "one", 1), entry("u2", "user", "two", 2)]);
  await plain.emit("session_start");
  assert.equal(await plain.emit("context", { messages: [] }), undefined);
  assert.equal(plain.aborts(), 0);

  const { h } = await foldedHarness();
  const stopped = (await h.emit("context", { messages: [] })) as { messages: AgentMessage[] };
  assert.equal(stopped.messages.length, 1);
  assert.equal(h.aborts(), 1);
});

test("a branch that fails the checks at request time stops with folds in memory and rethrows without", async () => {
  const { h, source } = await foldedHarness();
  // The branch becomes unsupported after the load: current() throws inside the context handler.
  h.setEntries([...h.entries(), compactionEntry("u3")]);
  await h.emit("context", requestOf(source));
  assert.equal(h.aborts(), 1);
  assert.match(h.notifications.at(-1)!, /saved folds cannot be applied \(.*native compaction/);

  const plainSource = [entry("u1", "user", "one", 1), entry("u2", "user", "two", 2)];
  const plain = harness(plainSource);
  await plain.emit("session_start");
  plain.setEntries([...plainSource, compactionEntry("u2")]);
  await assert.rejects(plain.emit("context", requestOf(plainSource)), /native compaction/);
  assert.equal(plain.aborts(), 0);
});
