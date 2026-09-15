import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { messageItem, originalIds, wrapRootRanges } from "./forest.ts";
import {
  type OriginalMessage,
  branchOriginals,
  buildOverlay,
  estimateContextTokens,
  planRootRanges,
  serializeMessage,
  unitBounds,
  validateToolUnitOwnership,
} from "./messages.ts";
import {
  assistantMessage,
  bashMessage,
  customMessage,
  messageEntry,
  toolResultMessage,
  userMessage,
} from "./pi-test-fixtures.ts";

const original = (id: string, message: AgentMessage): OriginalMessage => ({ id, message });

function completedTools(): OriginalMessage[] {
  return [
    original("u0", userMessage("read both", 1)),
    original("a1", assistantMessage([
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } },
    ], 2)),
    original("r2", toolResultMessage("c1", "A", 3)),
    original("r3", toolResultMessage("c2", "B", 4)),
    original("a4", assistantMessage([{ type: "text", text: "done" }], 5)),
  ];
}

test("Pi session projection preserves entry ids and omits zero-message entries", () => {
  const ignored: SessionEntry = {
    type: "model_change",
    id: "metadata",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    provider: "test",
    modelId: "test",
  };
  const emptyBranchSummary = {
    type: "branch_summary",
    id: "empty-summary",
    parentId: "metadata",
    timestamp: new Date(1).toISOString(),
    fromId: "user",
    summary: "",
  } satisfies SessionEntry;
  const entries = [ignored, emptyBranchSummary, messageEntry("user", userMessage("hello")), {
    type: "custom_message",
    id: "custom",
    parentId: "user",
    timestamp: new Date(2).toISOString(),
    customType: "notice",
    content: "remember",
    display: true,
  } satisfies SessionEntry];
  const projected = branchOriginals(entries);
  assert.deepEqual(projected.map(({ id }) => id), ["user", "custom"]);
  assert.deepEqual(projected.map(({ message }) => message.role), ["user", "custom"]);
});

test("tool bounds group parallel calls with all results", () => {
  const bounds = unitBounds(completedTools());
  assert.deepEqual(bounds.start, [0, 1, 1, 1, 4]);
  assert.deepEqual(bounds.end, [0, 3, 3, 3, 4]);
  assert.equal(bounds.unfinished.size, 0);
});

test("fold range expands to a whole tool unit", () => {
  const originals = completedTools();
  const roots = originals.map(({ id }) => messageItem(id));
  assert.deepEqual(planRootRanges(roots, originals, [{ from: "r2", summary: "read" }]), [
    { first: 1, last: 3, summary: "read" },
  ]);
});

test("unfinished tool calls cannot be folded", () => {
  const originals = completedTools().slice(0, 2);
  const roots = originals.map(({ id }) => messageItem(id));
  assert.throws(
    () => planRootRanges(roots, originals, [{ from: "a1", summary: "" }]),
    /unfinished/,
  );
});

test("a partial parallel result batch cannot be folded through a known result", () => {
  const originals = completedTools().slice(0, 3);
  const roots = originals.map(({ id }) => messageItem(id));
  assert.throws(
    () => planRootRanges(roots, originals, [{ from: "r2", summary: "" }]),
    /unfinished/,
  );
});

test("ownership validation accepts a completed unit folded as one subtree", () => {
  const originals = completedTools();
  const roots = wrapRootRanges(
    originals.map(({ id }) => messageItem(id)),
    [{ first: 1, last: 3, id: "f", summary: "done" }],
  );
  assert.doesNotThrow(() => validateToolUnitOwnership(roots, originals));
});

test("nested fold children remain identity-preserving roots for later folding", () => {
  const originals = completedTools();
  const flat = originals.map(({ id }) => messageItem(id));
  const inner = wrapRootRanges(flat, [{ first: 1, last: 3, id: "f1", summary: "inner" }]);
  const range = planRootRanges(inner, originals, [{ from: "u0", to: "f1", summary: "outer" }]);
  const outer = wrapRootRanges(inner, [{ ...range[0], id: "f2" }]);
  assert.deepEqual(originalIds(outer), originals.map(({ id }) => id));
  assert.equal(outer[0].kind, "fold");
  assert.equal((outer[0] as { children: readonly { id: string }[] }).children[1].id, "f1");
});

test("overlay preserves live object identity and drops folded call results", () => {
  const originals = completedTools();
  const roots = wrapRootRanges(
    originals.map(({ id }) => messageItem(id)),
    [{ first: 1, last: 3, id: "fold-x", summary: "files read" }],
  );
  const request = originals.map(({ message }) => ({ ...message })) as AgentMessage[];
  const output = buildOverlay(request, originals, roots);
  assert.equal(output[0], request[0]);
  assert.equal(output.length, 3);
  assert.equal(output[1].role, "user");
  assert.equal(output[1].role === "user" && output[1].content, "files read");
  assert.equal(output[2], request[4]);
  assert.ok(output.every((message) => message.role !== "toolResult"));
});

test("overlay correlates persisted custom messages despite independent timestamps", () => {
  const originals = [original("custom", customMessage("nudge", "notice", 1000))];
  const roots = wrapRootRanges([messageItem("custom")], [
    { first: 0, last: 0, id: "fold-custom", summary: "archived notice" },
  ]);
  const output = buildOverlay([customMessage("nudge", "notice", 999)], originals, roots);
  assert.equal(output[0].role === "user" && output[0].content, "archived notice");
});

test("ambiguous injected custom duplicates are preserved instead of mis-correlated", () => {
  const source = customMessage("nudge", "same", 1000);
  const originals = [original("custom", source)];
  const roots = wrapRootRanges([messageItem("custom")], [
    { first: 0, last: 0, id: "fold-custom", summary: "archived" },
  ]);
  const output = buildOverlay(
    [customMessage("nudge", "same", 999), customMessage("nudge", "same", 998)],
    originals,
    roots,
  );
  assert.equal(output.length, 2);
  assert.ok(output.every((message) => message.role === "custom" && message.content === "same"));
});

test("token estimates delegate to Pi and exclude hidden bash context", async () => {
  const { estimateTokens } = await import("@earendil-works/pi-coding-agent");
  const visible = userMessage("12345");
  assert.equal(estimateContextTokens(visible), estimateTokens(visible));

  const message = bashMessage("secret", "hidden", 1, true);
  const originals = [original("bash", message)];
  const roots = wrapRootRanges([messageItem("bash")], [
    { first: 0, last: 0, id: "fold-bash", summary: "must not enter context" },
  ]);
  assert.equal(estimateContextTokens(message), 0);
  assert.deepEqual(buildOverlay([message], originals, roots), []);
});

test("overlay keeps unknown messages injected by other extensions", () => {
  const originals = completedTools();
  const injected = { role: "custom-other", content: "keep me", timestamp: 999 } as unknown as AgentMessage;
  const output = buildOverlay(
    [...originals.map(({ message }) => ({ ...message }) as AgentMessage), injected],
    originals,
    originals.map(({ id }) => messageItem(id)),
  );
  assert.equal(output.at(-1), injected);
});

test("serializer labels binary images honestly and preserves stable lines", () => {
  const text = serializeMessage({
    role: "user",
    content: [
      { type: "image", mimeType: "image/png", data: "bytes" },
      { type: "text", text: "answer" },
    ],
    timestamp: 1,
  });
  assert.equal(text, "(image image/png; binary source preserved in session)\nanswer");
  assert.equal(
    serializeMessage(assistantMessage([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "answer" },
    ])),
    "(thinking) private reasoning\nanswer",
  );
});
