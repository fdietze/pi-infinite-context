import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { branchOriginals } from "./originals.ts";
import { linkEntries, messageEntry, projectionOf, userMessage } from "./pi-test-fixtures.ts";

test("Pi session projection preserves entry ids and omits zero-message entries", () => {
  const ignored: SessionEntry = {
    type: "model_change",
    id: "metadata",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    provider: "test",
    modelId: "test",
  };
  const emptyBranchSummary = {
    type: "branch_summary",
    id: "empty-summary",
    parentId: "metadata",
    timestamp: new Date(1).toISOString(),
    fromId: "user",
    summary: "",
  } satisfies SessionEntry;
  const entries = [ignored, emptyBranchSummary, messageEntry("user", userMessage("hello")), {
    type: "custom_message",
    id: "custom",
    parentId: "user",
    timestamp: new Date(2).toISOString(),
    customType: "notice",
    content: "remember",
    display: true,
  } satisfies SessionEntry];
  const linked = linkEntries(entries);
  const projected = branchOriginals(linked, projectionOf(linked));
  assert.deepEqual(projected.map(({ id }) => id), ["user", "custom"]);
  assert.deepEqual(projected.map(({ message }) => message.role), ["user", "custom"]);
});
