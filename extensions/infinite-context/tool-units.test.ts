import assert from "node:assert/strict";
import { test } from "node:test";
import { messageItem, wrapRootRanges } from "./forest.ts";
import { completedTools } from "./pi-test-fixtures.ts";
import { unitBounds, validateToolUnitOwnership } from "./tool-units.ts";

test("tool bounds group parallel calls with all results", () => {
  const bounds = unitBounds(completedTools());
  assert.deepEqual(bounds.start, [0, 1, 1, 1, 4]);
  assert.deepEqual(bounds.end, [0, 3, 3, 3, 4]);
  assert.equal(bounds.unfinished.size, 0);
});

test("ownership validation accepts a completed unit folded as one subtree", () => {
  const originals = completedTools();
  const roots = wrapRootRanges(
    originals.map(({ id }) => messageItem(id)),
    [{ first: 1, last: 3, id: "f", summary: "done" }],
  );
  assert.doesNotThrow(() => validateToolUnitOwnership(roots, originals));
});
