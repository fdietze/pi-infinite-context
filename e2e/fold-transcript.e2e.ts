// End-to-end: the real `pi` binary, the real extension and a scripted provider.
// Proves what unit tests cannot: what the provider finally receives after a fold.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

interface Message {
  role: string;
  text: string;
  toolCallIds: string[];
  toolCallId?: string;
}

const FOLD_SUMMARY = "ARCHIVED: greeting and the aborted attempt";

const strippedEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_")));

test("a scripted fold replaces the archived messages in the provider transcript", () => {
  const transcript = join(mkdtempSync(join(tmpdir(), "infinite-context-e2e-")), "transcript.jsonl");
  execFileSync(
    "pi",
    [
      "-p",
      "--no-session",
      "-ne",
      "-e",
      "e2e/scripted-provider.ts",
      "-e",
      "extensions/infinite-context/index.ts",
      "--model",
      "fake/scripted",
      "say hello",
    ],
    {
      // A Pi session exports PI_* routing variables (package dir, session file).
      // Inheriting them would point the child at another installation, so the
      // fake-provider run builds its own environment.
      env: { ...strippedEnv(), E2E_TRANSCRIPT: transcript },
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const requests: { request: number; messages: Message[] }[] = readFileSync(transcript, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.ok(requests.length >= 5, `expected the whole script to run, got ${requests.length} requests`);
  const live = (messages: Message[]) => messages.filter((message) => message.role !== "system");

  // Pi drops the aborted attempt itself: the retry request repeats the previous one.
  assert.deepEqual(live(requests[2].messages), live(requests[1].messages));

  const last = live(requests.at(-1)!.messages);
  // The fold summary reached the provider as one message, in place of the archived turns.
  assert.equal(last.filter((message) => message.text.includes(FOLD_SUMMARY)).length, 1);
  assert.equal(last[0].text, FOLD_SUMMARY);
  assert.ok(
    !last.some((message) => message.toolCallIds.includes("call_1_0") || message.toolCallId === "call_1_0"),
    "an archived tool exchange is still in the transcript",
  );
  // Every tool result still has its call, and every call its result.
  const calls = new Set(last.flatMap((message) => message.toolCallIds));
  const results = last.flatMap((message) => (message.toolCallId ? [message.toolCallId] : []));
  for (const id of results) assert.ok(calls.has(id), `orphan tool result ${id}`);
  assert.equal(new Set(results).size, results.length);
  for (const id of calls)
    assert.ok(results.includes(id), `tool call ${id} lost its result in the transcript`);
});
