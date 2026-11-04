import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repairSession, verifySession } from "./repair-session.ts";

const header = JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });
const user = (id: string, parentId: string | null) =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: id }], timestamp: 1 },
  });
const snapshot = (id: string, parentId: string, ids: string[]) =>
  JSON.stringify({
    type: "custom",
    customType: "infinite-context",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: { version: 2, roots: ids.map((leaf) => ({ kind: "message", id: leaf })) },
  });
const torn = (line: string) => line.slice(0, line.length / 2);
const text = (...lines: string[]) => `${lines.join("\n")}\n`;

/** The repaired text must load in Pi and satisfy the extension's branch and snapshot checks. */
function assertLoads(repaired: string): void {
  const directory = mkdtempSync(join(tmpdir(), "repair-session-"));
  try {
    const path = join(directory, "session.jsonl");
    writeFileSync(path, repaired);
    verifySession(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a healthy session stays byte-identical", () => {
  const healthy = text(header, user("a", null), user("b", "a"), snapshot("c", "b", ["a", "b"]));
  assert.deepEqual(repairSession(healthy), { text: healthy, notes: [] });
});

test("a glued entry is split off the torn line and reattached to the last intact entry", () => {
  const damaged = text(header, user("a", null), torn(user("lost", "a")) + user("b", "lost"), user("c", "b"));
  const { text: repaired } = repairSession(damaged);
  assert.deepEqual(
    repaired.trim().split("\n").slice(1).map((line) => [JSON.parse(line).id, JSON.parse(line).parentId]),
    [["a", null], ["b", "a"], ["c", "b"]],
  );
  assertLoads(repaired);
});

test("a lost parent continues after its predecessor in the snapshot, not after the previous file entry", () => {
  // `x` and `y` live on a dead end in the file; the snapshot knows the branch is a, lost, b.
  const damaged = text(
    header,
    user("a", null),
    user("x", "a"),
    user("y", "x"),
    user("b", "lost"),
    snapshot("s", "b", ["a", "lost", "b"]),
  );
  const { text: repaired, notes } = repairSession(damaged);
  assert.equal(JSON.parse(repaired.split("\n")[4]).parentId, "a");
  assert.equal(notes.length, 2);
  assertLoads(repaired);
});

test("lost archive leaves and the folds they emptied leave every snapshot", () => {
  const withFold = JSON.parse(snapshot("s", "b", []));
  withFold.data.roots = [
    { kind: "message", id: "a" },
    { kind: "fold", id: "f", summary: "gone", children: [{ kind: "message", id: "lost" }] },
    { kind: "message", id: "b" },
  ];
  const { text: repaired } = repairSession(text(header, user("a", null), user("b", "a"), JSON.stringify(withFold)));
  assert.deepEqual(JSON.parse(repaired.trim().split("\n")[3]).data.roots, [
    { kind: "message", id: "a" },
    { kind: "message", id: "b" },
  ]);
  assertLoads(repaired);
});
