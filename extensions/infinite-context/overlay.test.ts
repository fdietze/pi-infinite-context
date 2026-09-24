import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "./estimate-context-tokens.ts";
import { messageItem, wrapRootRanges } from "./forest.ts";
import { buildOverlay } from "./overlay.ts";
import {
  bashMessage,
  completedTools,
  customMessage,
  original,
  userMessage,
} from "./pi-test-fixtures.ts";

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
