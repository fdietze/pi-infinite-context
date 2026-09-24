import assert from "node:assert/strict";
import { test } from "node:test";
import { messageItem, originalIds, wrapRootRanges } from "./forest.ts";
import {
  assistantMessage,
  completedTools,
  original,
  userMessage,
} from "./pi-test-fixtures.ts";
import { planRootRanges } from "./plan-root-ranges.ts";

const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });

test("fold range expands to a whole tool unit", () => {
  const originals = completedTools();
  const roots = originals.map(({ id }) => messageItem(id));
  assert.deepEqual(planRootRanges(roots, originals, [{ from: "r2", summary: "read" }]), [
    { first: 1, last: 3, summary: "read" },
  ]);
});

test("the pending unit of the running turn is rejected by name", () => {
  const originals = completedTools().slice(0, 2);
  const roots = originals.map(({ id }) => messageItem(id));
  assert.throws(
    () => planRootRanges(roots, originals, [{ from: "a1", summary: "" }]),
    /Item 1 covers root "a1", the pending tool call/,
  );
});

test("a partial parallel result batch cannot be folded through a known result", () => {
  const originals = completedTools().slice(0, 3);
  const roots = originals.map(({ id }) => messageItem(id));
  assert.throws(
    () => planRootRanges(roots, originals, [{ from: "r2", summary: "" }]),
    /pending tool call/,
  );
});

test("an abandoned call is foldable together with the messages around it", () => {
  const originals = [
    original("u0", userMessage("one", 1)),
    original("a1", assistantMessage([call("aborted")], 2)),
    original("u2", userMessage("two", 3)),
    original("a3", assistantMessage([{ type: "text", text: "done" }], 4)),
  ];
  const roots = originals.map(({ id }) => messageItem(id));
  assert.deepEqual(planRootRanges(roots, originals, [{ from: "u0", to: "u2", summary: "old" }]), [
    { first: 0, last: 2, summary: "old" },
  ]);
});

test("unknown and non-root endpoints name the id and the way out", () => {
  const originals = completedTools();
  const roots = wrapRootRanges(
    originals.map(({ id }) => messageItem(id)),
    [{ first: 1, last: 3, id: "fold-a", summary: "read" }],
  );
  assert.throws(
    () => planRootRanges(roots, originals, [{ from: "nope", summary: "" }]),
    /"nope" is not a root\. Call context_map/,
  );
  assert.throws(
    () => planRootRanges(roots, originals, [{ from: "r2", summary: "" }]),
    /"r2" is not a root: it is inside fold "fold-a"\. Fold "fold-a" instead\./,
  );
});

test("overlapping items name both item numbers", () => {
  const originals = completedTools();
  const roots = originals.map(({ id }) => messageItem(id));
  assert.throws(
    () =>
      planRootRanges(roots, originals, [
        { from: "u0", to: "a1", summary: "a" },
        { from: "r3", to: "a4", summary: "b" },
      ]),
    /Items 1 and 2 overlap after tool-unit expansion/,
  );
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
