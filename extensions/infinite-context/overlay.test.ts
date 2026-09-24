import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageItem, wrapRootRanges } from "./forest.ts";
import { ProjectionMismatchError, buildOverlay } from "./overlay.ts";
import {
  assistantMessage,
  bashMessage,
  completedTools,
  customMessage,
  omittedOriginal,
  original,
  positionsOf,
  userMessage,
} from "./pi-test-fixtures.ts";

const live = (originals: readonly { live?: AgentMessage }[]) =>
  originals.flatMap(({ live: message }) => (message ? [{ ...message } as AgentMessage] : []));

test("overlay preserves live object identity and drops folded members", () => {
  const originals = completedTools();
  const roots = wrapRootRanges(
    originals.map(({ id }) => messageItem(id)),
    [{ first: 1, last: 3, id: "fold-x", summary: "files read" }],
  );
  const request = live(originals);
  const output = buildOverlay(request, positionsOf(originals), originals, roots);
  assert.equal(output[0], request[0]);
  assert.equal(output.length, 3);
  assert.equal(output[1].role === "user" && output[1].content, "[#fold-x] archived fold summary:\nfiles read");
  assert.equal(output[2], request[4]);
  assert.ok(output.every((message) => message.role !== "toolResult"));
});

test("a fold is projected at its anchor, the first live member", () => {
  const originals = [
    omittedOriginal("dropped", assistantMessage([{ type: "text", text: "retry" }], 1)),
    original("u2", userMessage("two", 2)),
    original("u3", userMessage("three", 3)),
  ];
  const roots = wrapRootRanges(originals.map(({ id }) => messageItem(id)), [
    { first: 0, last: 1, id: "fold-a", summary: "archived" },
  ]);
  const request = live(originals);
  const output = buildOverlay(request, positionsOf(originals), originals, roots);
  assert.equal(output.length, 2);
  assert.equal(output[0].role === "user" && output[0].content, "[#fold-a] archived fold summary:\narchived");
  assert.equal(output[0].timestamp, request[0].timestamp);
  assert.equal(output[1], request[1]);
});

test("a fold without any live member projects nothing", () => {
  const originals = [
    omittedOriginal("bash", bashMessage("secret", "hidden", 1, true)),
    original("u2", userMessage("two", 2)),
  ];
  const roots = wrapRootRanges(originals.map(({ id }) => messageItem(id)), [
    { first: 0, last: 0, id: "fold-bash", summary: "must not enter context" },
  ]);
  const request = [{ ...originals[0].message }, { ...originals[1].live! }] as AgentMessage[];
  const output = buildOverlay(request, positionsOf(originals), originals, roots);
  assert.deepEqual(output, [request[1]]);
});

test("a folded custom message is projected from its entry id, not its timestamp", () => {
  const originals = [original("custom", customMessage("nudge", "notice", 1000))];
  const roots = wrapRootRanges([messageItem("custom")], [
    { first: 0, last: 0, id: "fold-custom", summary: "archived notice" },
  ]);
  const output = buildOverlay(
    live(originals),
    positionsOf(originals),
    originals,
    roots,
  );
  assert.equal(output[0].role === "user" && output[0].content, "[#fold-custom] archived fold summary:\narchived notice");
});

test("messages appended after the projection pass through unchanged", () => {
  const originals = completedTools();
  const injected = { role: "custom-other", content: "keep me", timestamp: 999 } as unknown as AgentMessage;
  const request = [...live(originals), injected];
  const output = buildOverlay(
    request,
    positionsOf(originals),
    originals,
    originals.map(({ id }) => messageItem(id)),
  );
  assert.equal(output.at(-1), injected);
  assert.equal(output.length, request.length);
});

test("a request that does not start with the projection is refused", () => {
  const originals = completedTools();
  const request = live(originals);
  assert.throws(
    () => buildOverlay(request.slice(1), positionsOf(originals), originals, []),
    ProjectionMismatchError,
  );
  assert.throws(
    () => buildOverlay([userMessage("other", 1)], positionsOf(originals).slice(0, 1), originals, []),
    /stops matching the session projection at position 0/,
  );
});

test("an empty-summary fold projects an id-marked placeholder", () => {
  const originals = [original("u1", userMessage("one", 1)), original("u2", userMessage("two", 2))];
  const roots = wrapRootRanges(originals.map(({ id }) => messageItem(id)), [
    { first: 0, last: 1, id: "fold-empty", summary: "" },
  ]);
  const output = buildOverlay(live(originals), positionsOf(originals), originals, roots);
  assert.equal(output.length, 1);
  assert.equal(
    output[0].role === "user" && output[0].content,
    "[#fold-empty] archived fold summary:\n(no summary: 2 messages)",
  );
});
