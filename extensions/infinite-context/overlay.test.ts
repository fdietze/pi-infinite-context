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
  toolResultMessage,
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

/** A branch whose call c1 was abandoned, as left behind by quitting while a tool call was pending. */
const abandonedCall = () => [
  original("u0", userMessage("ask me", 1)),
  original(
    "a1",
    assistantMessage([{ type: "toolCall", id: "c1", name: "question", arguments: {} }], 2),
  ),
  original("u2", userMessage("never mind", 3)),
  original("a3", assistantMessage([{ type: "text", text: "ok" }], 4)),
];

/** What another extension's `context` handler inserts to repair the abandoned call. */
const syntheticResult = toolResultMessage("c1", "No answer.", 2);

test("a message inserted after a live position passes through in place", () => {
  const originals = abandonedCall();
  const request = live(originals);
  request.splice(2, 0, syntheticResult);
  const output = buildOverlay(
    request,
    positionsOf(originals),
    originals,
    originals.map(({ id }) => messageItem(id)),
  );
  assert.deepEqual(output, request);
});

test("a message inserted after a folded position is dropped with the fold", () => {
  const originals = abandonedCall();
  const roots = wrapRootRanges(originals.map(({ id }) => messageItem(id)), [
    { first: 1, last: 2, id: "fold-q", summary: "asked, then dropped it" },
  ]);
  const request = live(originals);
  request.splice(2, 0, syntheticResult);
  const output = buildOverlay(request, positionsOf(originals), originals, roots);
  assert.equal(output.length, 3);
  assert.equal(output[0], request[0]);
  assert.equal(output[1].role === "user" && output[1].content, "[#fold-q] archived fold summary:\nasked, then dropped it");
  assert.equal(output[2], request[4]);
});

test("a message inserted before the first position passes through", () => {
  const originals = abandonedCall();
  const roots = wrapRootRanges(originals.map(({ id }) => messageItem(id)), [
    { first: 0, last: 1, id: "fold-head", summary: "head" },
  ]);
  const preamble = customMessage("other", "preamble", 0);
  const request = [preamble, ...live(originals)];
  const output = buildOverlay(request, positionsOf(originals), originals, roots);
  assert.equal(output[0], preamble);
  assert.equal(output[1].role === "user" && output[1].content, "[#fold-head] archived fold summary:\nhead");
  assert.deepEqual(output.slice(2), request.slice(3));
});

test("a request missing a projected entry is refused", () => {
  const originals = abandonedCall();
  const positions = positionsOf(originals);
  const request = live(originals);
  assert.throws(
    () => buildOverlay([...request.slice(0, 2), ...request.slice(3)], positions, originals, []),
    /Projected entry "u2" \(user\) is missing from the request at or after position 2/,
  );
  const changed = [...request.slice(0, 2), userMessage("rewritten", 3), request[3]];
  assert.throws(() => buildOverlay(changed, positions, originals, []), ProjectionMismatchError);
  assert.throws(
    () => buildOverlay(request.slice(0, 3), positions, originals, []),
    /Projected entry "a3"/,
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
