import assert from "node:assert/strict";
import { test } from "node:test";
import { messageItem, originalIds, wrapRootRanges } from "./forest.ts";
import { completedTools } from "./pi-test-fixtures.ts";
import { planRootRanges } from "./plan-root-ranges.ts";

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
