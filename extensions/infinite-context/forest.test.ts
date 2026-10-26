import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  type Forest,
  allItems,
  findItem,
  messageItem,
  originalIds,
  parseSnapshot,
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
});

test("singleton refolding preserves the entire previous fold unchanged", () => {
  const roots = wrapRootRanges(ids(3).map(messageItem), [
    { first: 0, last: 1, id: "inner", summary: "inner history" },
  ]);
  const previous = wrapRootRanges(roots, [
    { first: 0, last: 1, id: "previous", summary: "previous history" },
  ]);
  const before = structuredClone(previous);
  const revised = wrapRootRanges(previous, [
    { first: 0, last: 0, id: "revised", summary: "current state" },
  ]);
  assert.deepEqual(previous, before);
  assert.equal(revised[0].id, "revised");
  assert.equal(revised[0].kind, "fold");
  if (revised[0].kind !== "fold") throw new Error("Expected a fold");
  assert.equal(revised[0].summary, "current state");
  assert.deepEqual(revised[0].children, before);
  assert.equal(revised[0].children[0], previous[0]);
  assert.equal(findItem(revised, "inner"), findItem(previous, "inner"));
  assert.deepEqual(originalIds(revised), ids(3));
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
  assert.throws(
    () => syncOriginals(roots, ["m0"]),
    /Snapshot lists message m1, which is missing from the current branch/,
  );
  assert.throws(
    () => syncOriginals([messageItem("m0"), messageItem("m0")], ["m0", "m0"]),
    /lists message m0 twice/,
  );
  assert.throws(
    () => syncOriginals([messageItem("m0"), messageItem("m1")], ["m1", "m0"]),
    /Snapshot lists message m1 after m0, but the current branch has them in the other order/,
  );
});

// Shape of a real session: after the snapshot, a crash recovery wrote a tool result (r) into the
// history between its call (c) and the next user message (u2).
test("sync places originals inserted between roots at their branch position and keeps the roots", () => {
  const saved = wrapRootRanges(["u1", "a1", "r1", "c", "u2"].map(messageItem), [
    { first: 0, last: 2, id: "f", summary: "early work" },
  ]);
  const synced = syncOriginals(saved, ["x", "u1", "a1", "r1", "c", "r", "y", "u2", "z"]);
  assert.deepEqual(synced.map((root) => root.id), ["x", "f", "c", "r", "y", "u2", "z"]);
  assert.equal(synced[1], saved[0]);
  assert.deepEqual(originalIds(synced), ["x", "u1", "a1", "r1", "c", "r", "y", "u2", "z"]);
  assert.deepEqual(syncOriginals([], ["a", "b"]).map((root) => root.id), ["a", "b"]);
});

test("sync rejects an original inserted inside a root's range: branch order could not hold", () => {
  const saved = wrapRootRanges(["u1", "a1", "r1"].map(messageItem), [
    { first: 0, last: 2, id: "f", summary: "early work" },
  ]);
  assert.throws(
    () => syncOriginals(saved, ["u1", "new", "a1", "r1"]),
    /The current branch has message new inside root f, which the snapshot does not list/,
  );
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
