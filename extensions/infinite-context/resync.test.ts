import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageItem, originalIds, syncOriginals, wrapRootRanges } from "./forest.ts";
import { validateToolUnitOwnership } from "./tool-units.ts";

// A session whose history changed after the last snapshot: a crash recovery wrote the result
// (qr) of an interactive tool call (q) between that call and the next user message (u2).
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const call = (name: string, callId: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: callId, name, arguments: {} }],
  timestamp: 0,
});
const result = (name: string, callId: string, text: string) => ({
  role: "toolResult",
  toolCallId: callId,
  toolName: name,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});
const branch: Array<[string, unknown]> = [
  ["u1", user("task")],
  ["a1", call("bash", "c1")],
  ["r1", result("bash", "c1", "out")],
  ["q", call("question", "Q")],
  ["qr", result("question", "Q", "No result provided")],
  ["u2", user("recovered answer")],
  ["a2", call("bash", "c2")],
  ["r2", result("bash", "c2", "ok")],
];
const originals = branch.map(([id, message]) => ({
  id,
  message: message as AgentMessage,
  live: message as AgentMessage,
}));
const ids = originals.map(({ id }) => id);
const withoutRecovered = ids.filter((id) => id !== "qr");

test("a recovered tool result between roots becomes a root, and the fold before it is kept", () => {
  const saved = wrapRootRanges(withoutRecovered.map(messageItem), [
    { first: 0, last: 2, id: "fold-1", summary: "early work" },
  ]);
  const synced = syncOriginals(saved, ids);
  assert.deepEqual(synced.map((root) => root.id), ["fold-1", "q", "qr", "u2", "a2", "r2"]);
  assert.equal(synced[0], saved[0]);
  assert.deepEqual(originalIds(synced), ids);
  validateToolUnitOwnership(synced, originals);
});

test("a recovered result whose call is inside a fold still fails tool-unit validation", () => {
  const saved = wrapRootRanges(withoutRecovered.map(messageItem), [
    { first: 3, last: 3, id: "fold-q", summary: "asked" },
  ]);
  const synced = syncOriginals(saved, ids);
  assert.throws(() => validateToolUnitOwnership(synced, originals), /splits the tool call/);
});
