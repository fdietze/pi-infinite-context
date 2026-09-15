import assert from "node:assert/strict";
import { test } from "node:test";
import { messageItem, originalIds, wrapRootRanges } from "./forest.ts";
import {
  type AgentMessageLike,
  type OriginalMessage,
  buildOverlay,
  planRootRanges,
  serializeMessage,
  unitBounds,
  validateToolUnitOwnership,
} from "./messages.ts";

const msg = (id: string, role: string, content: AgentMessageLike["content"], extra: Partial<AgentMessageLike> = {}): OriginalMessage => ({
  id,
  message: { role, content, timestamp: Number(id.replace(/\D/g, "")) || id.charCodeAt(0), ...extra },
});

function completedTools(): OriginalMessage[] {
  return [
    msg("u0", "user", "read both"),
    msg("a1", "assistant", [
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } },
    ]),
    msg("r2", "toolResult", [{ type: "text", text: "A" }], { toolCallId: "c1" }),
    msg("r3", "toolResult", [{ type: "text", text: "B" }], { toolCallId: "c2" }),
    msg("a4", "assistant", [{ type: "text", text: "done" }]),
  ];
}

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
  const request = originals.map(({ message }) => ({ ...message }));
  const output = buildOverlay(request, originals, roots);
  assert.equal(output[0], request[0]);
  assert.equal(output.length, 3);
  assert.equal(output[1].role, "user");
  assert.equal(output[1].content, "files read");
  assert.equal(output[2], request[4]);
  assert.ok(output.every((message) => message.toolCallId !== "c1" && message.toolCallId !== "c2"));
});

test("overlay correlates persisted custom messages despite independently-created timestamps", () => {
  const originals: OriginalMessage[] = [
    { id: "custom", message: { role: "custom", customType: "nudge", content: "notice", timestamp: 1000 } },
  ];
  const roots = wrapRootRanges([messageItem("custom")], [
    { first: 0, last: 0, id: "fold-custom", summary: "archived notice" },
  ]);
  const output = buildOverlay(
    [{ role: "custom", customType: "nudge", content: "notice", timestamp: 999 }],
    originals,
    roots,
  );
  assert.equal(output.length, 1);
  assert.equal(output[0].content, "archived notice");
});

test("ambiguous injected custom duplicates are preserved instead of mis-correlated", () => {
  const original = { role: "custom", customType: "nudge", content: "same", timestamp: 1000 };
  const originals: OriginalMessage[] = [{ id: "custom", message: original }];
  const roots = wrapRootRanges([messageItem("custom")], [
    { first: 0, last: 0, id: "fold-custom", summary: "archived" },
  ]);
  const injected = { ...original, timestamp: 999 };
  const output = buildOverlay([injected, { ...original, timestamp: 998 }], originals, roots);
  assert.equal(output.length, 2);
  assert.ok(output.every((message) => message.content === "same"));
});

test("excluded bash remains searchable state but never anchors a fold projection", () => {
  const originals: OriginalMessage[] = [
    { id: "bash", message: { role: "bashExecution", command: "secret", output: "hidden", excludeFromContext: true, timestamp: 1 } },
  ];
  const roots = wrapRootRanges([messageItem("bash")], [
    { first: 0, last: 0, id: "fold-bash", summary: "must not enter context" },
  ]);
  const output = buildOverlay([{ ...originals[0].message }], originals, roots);
  assert.deepEqual(output, [], "Pi excluded the source, so folding cannot inject a replacement");
});

test("overlay keeps unknown messages injected by later or earlier extensions", () => {
  const originals = completedTools();
  const injected = { role: "custom-other", content: "keep me", timestamp: 999 };
  const output = buildOverlay(
    [...originals.map(({ message }) => ({ ...message })), injected],
    originals,
    originals.map(({ id }) => messageItem(id)),
  );
  assert.equal(output.at(-1), injected);
});

test("serializer labels images honestly and shares stable lines", () => {
  const text = serializeMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "image", mimeType: "image/png", data: "bytes" },
      { type: "text", text: "answer" },
    ],
  });
  assert.equal(
    text,
    "(thinking) private reasoning\n(image image/png; binary source preserved in session)\nanswer",
  );
});
