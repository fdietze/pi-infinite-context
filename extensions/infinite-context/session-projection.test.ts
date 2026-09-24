// Regressions from real sessions: abandoned tool calls and attempts Pi omitted
// via `context_edit` must never block folding, and must never reach the model.
import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { messageItem, wrapRootRanges } from "./forest.ts";
import { branchOriginals, projectedPositions } from "./originals.ts";
import { buildOverlay } from "./overlay.ts";
import { planRootRanges } from "./plan-root-ranges.ts";
import { assistantMessage, toolResultMessage, userMessage } from "./pi-test-fixtures.ts";

const call = (id: string, name = "question") => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: {},
});

function session() {
  const sm = SessionManager.inMemory("/tmp");
  // Fixtures return the wider AgentMessage union; these are all persistable roles.
  const append = (message: unknown) =>
    sm.appendMessage(message as Parameters<typeof sm.appendMessage>[0]);
  const u1 = append(userMessage("one", 1));
  // Abandoned attempt: an aborted question whose call never got a result.
  const orphan = append(assistantMessage([call("q1")], 2));
  const u2 = append(userMessage("two", 3));
  // Retry recovery: Pi omits a failed attempt that already carried a fold call.
  const omitted = append(assistantMessage([call("c2", "context_fold")], 4));
  sm.appendContextEdit(omitted, null);
  const a3 = append(assistantMessage([call("c3", "read")], 5));
  const r3 = append(toolResultMessage("c3", "done", 6));
  return { sm, ids: { u1, orphan, u2, omitted, a3, r3 } };
}

const state = (sm: SessionManager) => {
  const projection = sm.buildSessionProjection();
  return {
    originals: branchOriginals(sm.getBranch(), projection),
    positions: projectedPositions(projection),
    projection,
  };
};

test("an omitted entry stays an archive leaf without a live message", () => {
  const { sm, ids } = session();
  const { originals } = state(sm);
  assert.deepEqual(originals.map(({ id }) => id), [
    ids.u1,
    ids.orphan,
    ids.u2,
    ids.omitted,
    ids.a3,
    ids.r3,
  ]);
  assert.equal(originals.find(({ id }) => id === ids.omitted)!.live, undefined);
  assert.ok(originals.every(({ id, live }) => id === ids.omitted || live !== undefined));
});

test("an abandoned call followed by later messages is foldable", () => {
  const { sm, ids } = session();
  const { originals } = state(sm);
  const roots = originals.map(({ id }) => messageItem(id));
  assert.deepEqual(planRootRanges(roots, originals, [{ from: ids.u1, to: ids.u2, summary: "" }]), [
    { first: 0, last: 2, summary: "" },
  ]);
  // The omitted fold-call attempt does not block its neighbours either.
  assert.deepEqual(
    planRootRanges(roots, originals, [{ from: ids.u2, to: ids.omitted, summary: "" }]),
    [{ first: 2, last: 3, summary: "" }],
  );
});

test("folding an abandoned call removes it from the request without orphaning results", () => {
  const { sm, ids } = session();
  const { originals, positions, projection } = state(sm);
  const roots = wrapRootRanges(originals.map(({ id }) => messageItem(id)), [
    { first: 0, last: 3, id: "fold-a", summary: "early work" },
  ]);
  const request = projection.messages.filter((message) => message.role !== "system");
  const output = buildOverlay(request, positions, originals, roots);
  assert.equal(output[0].role === "user" && output[0].content, "early work");
  assert.deepEqual(output.slice(1), request.slice(-2));
  assert.equal(
    output.filter((message) => message.role === "assistant" && JSON.stringify(message.content).includes("q1")).length,
    0,
  );
  void ids;
});
