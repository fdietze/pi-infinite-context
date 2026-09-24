import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantMessage, userMessage } from "./pi-test-fixtures.ts";
import { previewMessage } from "./preview-message.ts";

test("assistant previews drop thinking and show calls as name plus bare argument values", () => {
  assert.equal(
    previewMessage(assistantMessage([
      { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test", timeout: 30 } },
      { type: "text", text: "Running tests" },
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "a.ts", range: [1, 2] } },
    ])),
    "Running tests; bash npm test 30; read a.ts [1,2]",
  );
  assert.equal(previewMessage(assistantMessage([{ type: "thinking", thinking: "only" }])), "");
});

test("non-assistant previews use the authoritative serialization", () => {
  assert.equal(previewMessage(userMessage("hello")), "hello");
});
