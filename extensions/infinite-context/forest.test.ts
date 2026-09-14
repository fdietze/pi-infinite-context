import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  type Forest,
  type Item,
  allItems,
  findItem,
  messageItem,
  originalIds,
  parseSnapshot,
  replaceRootSummary,
  snapshot,
  syncOriginals,
  wrapRootRanges,
} from "./forest.ts";

const ids = (count: number) => Array.from({ length: count }, (_, i) => `m${i}`);

test("nested folds preserve ordered, uniquely owned original leaves", () => {
  const roots = ids(5).map(messageItem);
  const inner = wrapRootRanges(roots, [{ first: 1, last: 2, id: "f1", summary: "inner" }]);
  const outer = wrapRootRanges(inner, [{ first: 0, last: 1, id: "f2", summary: "outer" }]);
  assert.deepEqual(originalIds(outer), ids(5));
  assert.equal(findItem(outer, "f1")?.kind, "fold");
  assert.deepEqual((findItem(outer, "f1") as { summary: string }).summary, "inner");
  assert.throws(() => replaceRootSummary(outer, "f1", "hidden edit"), /visible fold/);
  assert.equal((replaceRootSummary(outer, "f2", "new") as Item[])[0].kind, "fold");
});

test("invalid batches are atomic", () => {
  const roots = ids(4).map(messageItem);
  const before = structuredClone(roots);
  assert.throws(
    () =>
      wrapRootRanges(roots, [
        { first: 0, last: 2, id: "a", summary: "" },
        { first: 2, last: 3, id: "b", summary: "" },
      ]),
    /overlap/,
  );
  assert.deepEqual(roots, before);
});

test("snapshot parser rejects old and corrupt state explicitly", () => {
  assert.throws(() => parseSnapshot({ spans: [] }), /Unsupported.*start a new session/);
  assert.throws(
    () =>
      parseSnapshot({
        version: 2,
        roots: [messageItem("same"), messageItem("same")],
      }),
    /duplicate/,
  );
});

test("snapshot parser and traversals handle deep trees iteratively", () => {
  let item: unknown = messageItem("leaf");
  for (let i = 0; i < 5000; ++i)
    item = { kind: "fold", id: `f${i}`, summary: "", children: [item] };
  const parsed = parseSnapshot({ version: 2, roots: [item] });
  assert.deepEqual(originalIds(parsed.roots), ["leaf"]);
  assert.equal(allItems(parsed.roots).length, 5001);
});

test("sync appends only a current-branch suffix and rejects branch mismatch", () => {
  const roots = wrapRootRanges(ids(2).map(messageItem), [
    { first: 0, last: 1, id: "f", summary: "done" },
  ]);
  assert.deepEqual(originalIds(syncOriginals(roots, ["m0", "m1", "m2"])), [
    "m0",
    "m1",
    "m2",
  ]);
  assert.throws(() => syncOriginals(roots, ["m0", "other"]), /current branch/);
});

test("fast-check command sequences preserve archive invariants and round-trip", () => {
  const operation = fc.record({
    a: fc.nat(),
    b: fc.nat(),
    summary: fc.string({ maxLength: 30 }),
    invalid: fc.boolean(),
    read: fc.boolean(),
  });
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 30 }),
      fc.array(operation, { maxLength: 100 }),
      (count, operations) => {
        const expected = ids(count);
        let roots: Forest = expected.map(messageItem);
        let nextId = 0;
        for (const op of operations) {
          const before = structuredClone(roots);
          if (op.read) {
            allItems(roots);
            originalIds(roots);
            assert.deepEqual(roots, before);
            continue;
          }
          const first = op.a % roots.length;
          const last = first + (op.b % (roots.length - first));
          const range = { first, last, id: `f${nextId++}`, summary: op.summary };
          if (op.invalid) {
            assert.throws(() => wrapRootRanges(roots, [range, { ...range, id: `bad${nextId++}` }]));
            assert.deepEqual(roots, before);
          } else {
            roots = wrapRootRanges(roots, [range]);
          }
          assert.deepEqual(originalIds(roots), expected);
          assert.equal(new Set(allItems(roots).map((item) => item.id)).size, allItems(roots).length);
          assert.deepEqual(parseSnapshot(JSON.parse(JSON.stringify(snapshot(roots)))).roots, roots);
        }
      },
    ),
    { numRuns: 300 },
  );
});
