import assert from "node:assert/strict";
import { test } from "node:test";
import { messageItem, wrapRootRanges } from "./forest.ts";
import {
  assistantMessage,
  completedTools,
  omittedOriginal,
  original,
  userMessage,
} from "./pi-test-fixtures.ts";
import { toolUnits, validateToolUnitOwnership } from "./tool-units.ts";

const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });

test("tool units group parallel calls with all results", () => {
  const units = toolUnits(completedTools());
  assert.deepEqual(units.start, [0, 1, 1, 1, 4]);
  assert.deepEqual(units.end, [0, 3, 3, 3, 4]);
  assert.equal(units.pendingOwner, undefined);
});

test("the running turn's incomplete call is the pending unit", () => {
  const units = toolUnits(completedTools().slice(0, 3));
  assert.equal(units.pendingOwner, 1);
});

test("only the final assistant can be pending; earlier abandoned calls are complete units", () => {
  const originals = [
    original("u0", userMessage("one", 1)),
    original("a1", assistantMessage([call("aborted")], 2)),
    original("u2", userMessage("two", 3)),
    original("a3", assistantMessage([{ type: "text", text: "done" }], 4)),
  ];
  const units = toolUnits(originals);
  assert.equal(units.pendingOwner, undefined);
  assert.deepEqual(units.end, [0, 1, 2, 3]);
  // While that same call is still the last assistant, it is the running turn.
  assert.equal(toolUnits(originals.slice(0, 3)).pendingOwner, 1);
});

test("a call Pi omitted from context never forms a unit", () => {
  const units = toolUnits([
    omittedOriginal("a1", assistantMessage([call("dropped")], 1)),
    original("u2", userMessage("two", 2)),
  ]);
  assert.equal(units.pendingOwner, undefined);
  assert.deepEqual(units.start, [0, 1]);
});

test("ownership validation accepts a completed unit folded as one subtree", () => {
  const originals = completedTools();
  const roots = wrapRootRanges(
    originals.map(({ id }) => messageItem(id)),
    [{ first: 1, last: 3, id: "f", summary: "done" }],
  );
  assert.doesNotThrow(() => validateToolUnitOwnership(roots, originals));
});

test("ownership validation rejects a unit split across roots", () => {
  const originals = completedTools();
  const roots = wrapRootRanges(
    originals.map(({ id }) => messageItem(id)),
    [{ first: 1, last: 2, id: "f", summary: "partial" }],
  );
  assert.throws(
    () => validateToolUnitOwnership(roots, originals),
    /splits the tool call of "a1"/,
  );
});
