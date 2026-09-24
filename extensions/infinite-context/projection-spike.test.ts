// Spike: does Pi 0.87's public session projection give the archive the model-visible
// messages (context_edit applied) together with their stable entry ids?
import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { messageItem } from "./forest.ts";
import { branchOriginals } from "./originals.ts";
import { planRootRanges } from "./plan-root-ranges.ts";
import { assistantMessage, toolResultMessage, userMessage } from "./pi-test-fixtures.ts";

const call = (id: string) => ({ type: "toolCall" as const, id, name: "question", arguments: {} });

function session() {
  const sm = SessionManager.inMemory("/tmp");
  // Fixtures return the wider AgentMessage union; these are all persistable roles.
  const append = (message: unknown) =>
    sm.appendMessage(message as Parameters<typeof sm.appendMessage>[0]);
  const u1 = append(userMessage("one", 1));
  // Abandoned attempt: a tool call that never got a result (aborted question).
  const orphan = append(assistantMessage([call("q1")], 2));
  const u2 = append(userMessage("two", 3));
  // Recovery-style omission of a later failed attempt.
  const failed = append(assistantMessage([call("c2")], 4));
  sm.appendContextEdit(failed, null);
  const a3 = append(assistantMessage([call("c3")], 5));
  const r3 = append(toolResultMessage("c3", "done", 6));
  return { sm, ids: { u1, orphan, u2, failed, a3, r3 } };
}

test("projection omits context_edit targets; raw-branch conversion does not", () => {
  const { sm, ids } = session();
  const projection = sm.buildSessionProjection();
  const projectedIds = projection.entries
    .filter((entry) => entry.messages.length > 0)
    .map((entry) => entry.sourceEntry.id);
  assert.deepEqual(projectedIds, [ids.u1, ids.orphan, ids.u2, ids.a3, ids.r3]);
  assert.ok(branchOriginals(sm.getBranch()).some(({ id }) => id === ids.failed));
  // projection.messages is exactly the flattened per-entry messages.
  assert.deepEqual(projection.messages, projection.entries.flatMap((entry) => entry.messages));
});

test("an abandoned orphan call followed by later messages blocks folding (current bug)", () => {
  const { sm, ids } = session();
  const originals = sm
    .buildSessionProjection()
    .entries.filter((entry) => entry.messages.length === 1)
    .map((entry) => ({ id: entry.sourceEntry.id, message: entry.messages[0] }));
  const roots = originals.map(({ id }) => messageItem(id));
  assert.throws(
    () => planRootRanges(roots, originals, [{ from: ids.u1, to: ids.u2, summary: "" }]),
    /unfinished tool-call unit/,
  );
});
