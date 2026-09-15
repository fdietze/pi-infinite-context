import assert from "node:assert/strict";
import { test } from "node:test";
import { messageItem, wrapRootRanges } from "./forest.ts";
import type { OriginalMessage } from "./messages.ts";
import { boundOutput, lineWindow, MAX_OUTPUT_BYTES, parsePage } from "./output.ts";
import { compilePattern, searchArchive } from "./search.ts";

const originals: OriginalMessage[] = [
  { id: "m1", message: { role: "user", content: "alpha\nneedle original", timestamp: 1 } },
  { id: "m2", message: { role: "assistant", content: [{ type: "text", text: "other" }], timestamp: 2 } },
];

const roots = wrapRootRanges(originals.map(({ id }) => messageItem(id)), [
  { first: 0, last: 1, id: "fold-a", summary: "needle summary\nsecond summary line" },
]);

test("search scans each original and reachable fold summary with lookup-compatible lines", () => {
  const result = searchArchive(originals, roots, compilePattern("needle"));
  assert.equal(result.totalMatchingItems, 2);
  assert.deepEqual(
    result.hits.map((hit) => [hit.id, hit.kind, hit.matches[0].line, hit.parentFoldId]),
    [
      ["m1", "message", 2, "fold-a"],
      ["fold-a", "fold", 1, null],
    ],
  );
  assert.equal(lineWindow("alpha\nneedle original", 2, 1).text, "needle original");
  assert.equal(lineWindow("needle summary\nsecond summary line", 1, 1).text, "needle summary");
});

test("search previews do not split Unicode surrogate pairs", () => {
  const unicode: OriginalMessage[] = [
    { id: "emoji", message: { role: "user", content: `${"😀".repeat(100)}needle${"😀".repeat(100)}`, timestamp: 1 } },
  ];
  const result = searchArchive(unicode, [messageItem("emoji")], compilePattern("needle"));
  assert.doesNotMatch(result.hits[0].matches[0].text, /�/);
});

test("empty and invalid regex patterns fail at the boundary", () => {
  assert.throws(() => compilePattern(""), /empty/);
  assert.throws(() => compilePattern("("), SyntaxError);
});

test("line windows use exact newline semantics and report out-of-range offsets", () => {
  assert.deepEqual(lineWindow("a\n", 1, 100), {
    text: "a\n",
    totalLines: 2,
    start: 1,
    end: 2,
    clippedLine: false,
  });
  assert.deepEqual(lineWindow("a\nb", 3, 1), {
    text: "",
    totalLines: 2,
    start: 3,
    end: 2,
    clippedLine: false,
  });
});

test("giant Unicode lines are byte-bounded and clipping is explicit", () => {
  const window = lineWindow("😀".repeat(100_000), 1, 1, 1000);
  assert.ok(Buffer.byteLength(window.text, "utf8") <= 1000);
  assert.match(window.text, /line clipped/);
  assert.equal(window.totalLines, 1);
  assert.equal(window.clippedLine, true);
  assert.doesNotMatch(window.text, /�/);
});

test("global output defense applies one byte and line budget", () => {
  const output = boundOutput(Array.from({ length: 3000 }, () => "😀".repeat(100)).join("\n"));
  assert.ok(Buffer.byteLength(output, "utf8") <= MAX_OUTPUT_BYTES);
  assert.match(output, /tool output truncated/);
  assert.doesNotMatch(output, /�/);
});

test("page arguments reject unsafe or excessive integers", () => {
  assert.throws(() => parsePage(Number.MAX_SAFE_INTEGER + 1, 1), /safe integer/);
  assert.throws(() => parsePage(1, 2001), /1 to 2000/);
  assert.deepEqual(parsePage(undefined, undefined), { offset: 1, limit: 100 });
});
