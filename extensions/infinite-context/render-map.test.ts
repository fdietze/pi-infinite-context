import assert from "node:assert/strict";
import { test } from "node:test";
import { messageItem, wrapRootRanges } from "./forest.ts";
import { liveTokens, type OriginalsById } from "./fold-projection.ts";
import { MAX_OUTPUT_BYTES, fmtTokens } from "./output.ts";
import {
  assistantMessage,
  bashMessage,
  omittedOriginal,
  original,
  userMessage,
} from "./pi-test-fixtures.ts";
import { MAX_PREVIEW_CHARS, cutPreview, renderMap } from "./render-map.ts";

const byIdOf = (originals: readonly { id: string }[]) =>
  new Map(originals.map((o) => [o.id, o])) as unknown as OriginalsById;

test("previews cut code points, collapse whitespace and mark empty text", () => {
  assert.equal(cutPreview("  a \n\t b  ", 40), "a b");
  assert.equal(cutPreview("😀".repeat(41), 40), `${"😀".repeat(40)}…`);
  assert.equal(cutPreview("😀".repeat(40), 40), "😀".repeat(40));
  assert.equal(cutPreview(" ", 40), "(empty)");
});

test("map lines are compact and name role, cost and preview", () => {
  const originals = [
    original("u1", userMessage("fix the build")),
    original("a1", assistantMessage([
      { type: "thinking", thinking: "hmm" },
      { type: "toolCall", id: "c", name: "bash", arguments: { command: "cd ~/projects/x && npm test" } },
    ])),
    omittedOriginal("b1", bashMessage("secret", "hidden", 1, true)),
    original("u2", userMessage("a")),
    original("u3", userMessage("b")),
  ];
  const byId = byIdOf(originals);
  const roots = wrapRootRanges(originals.map(({ id }) => messageItem(id)), [
    { first: 2, last: 2, id: "fold-dead", summary: "" },
    { first: 3, last: 4, id: "fold-ab", summary: "letters\nand more" },
  ]);
  const { text, previewChars } = renderMap("roots", roots, byId);
  const tokens = (id: string) => fmtTokens(liveTokens(originals.find((o) => o.id === id)!));
  const foldTokens = fmtTokens(Math.ceil("[#fold-ab] archived fold summary:\nletters\nand more".length / 4));
  assert.equal(previewChars, MAX_PREVIEW_CHARS);
  assert.deepEqual(text.split("\n"), [
    `[#u1] user ~${tokens("u1")} · fix the build`,
    `[#a1] assistant ~${tokens("a1")} · bash cd ~/projects/x && npm test`,
    "[#fold-dead] fold 1 msgs not live · (empty)",
    `[#fold-ab] fold 2 msgs ~${foldTokens} · letters and more`,
    "roots: 4 items",
  ]);
});

test("a huge map lists every item, shrinking previews uniformly to fit", () => {
  const count = 1200;
  const originals = Array.from({ length: count }, (_, i) =>
    original(`id-${String(i).padStart(8, "0")}`, userMessage(`${"x".repeat(60)} ${i}`)),
  );
  const byId = byIdOf(originals);
  const roots = originals.map(({ id }) => messageItem(id));
  const { text, previewChars } = renderMap("roots", roots, byId);
  const lines = text.split("\n");
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES);
  assert.equal(lines.length, count + 1);
  for (const [i, { id }] of originals.entries()) assert.ok(lines[i].startsWith(`[#${id}] user ~`));
  assert.ok(previewChars > 0 && previewChars < MAX_PREVIEW_CHARS, `previewChars ${previewChars}`);
  assert.equal(lines.at(-1), `roots: ${count} items · previews shortened to ${previewChars} chars to fit`);
  // Uniform: every preview is cut to the same length.
  assert.ok(lines.slice(0, count).every((line) => line.endsWith(`· ${"x".repeat(previewChars)}…`)));
});

test("previews are omitted entirely when only the bare index fits, and ids are never dropped", () => {
  for (const count of [2600, 4000]) {
    const originals = Array.from({ length: count }, (_, i) =>
      original(`m-${String(i).padStart(4, "0")}`, userMessage("payload")),
    );
    const { text, previewChars } = renderMap("roots", originals.map(({ id }) => messageItem(id)), byIdOf(originals));
    const lines = text.split("\n");
    assert.equal(previewChars, 0);
    assert.equal(lines.length, count + 1);
    assert.match(lines[0], /^\[#m-0000\] user ~\d+$/);
    assert.equal(lines.at(-1), `roots: ${count} items · previews omitted to fit`);
    // 4000 bare index lines exceed the cap and are still returned whole.
    assert.equal(Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES, count === 2600);
  }
});
