import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantMessage } from "./pi-test-fixtures.ts";
import { serializeMessage } from "./serialize-message.ts";

test("serializer labels binary images honestly and preserves stable lines", () => {
  const text = serializeMessage({
    role: "user",
    content: [
      { type: "image", mimeType: "image/png", data: "bytes" },
      { type: "text", text: "answer" },
    ],
    timestamp: 1,
  });
  assert.equal(text, "(image image/png; binary source preserved in session)\nanswer");
  assert.equal(
    serializeMessage(assistantMessage([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "answer" },
    ])),
    "(thinking) private reasoning\nanswer",
  );
});
