import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotHasFolds, unappliedFoldsNotice } from "./unapplied-folds.ts";

test("only a saved root fold makes the unfolded transcript unsafe to send", () => {
  for (const data of [undefined, null, "x", { roots: "garbage" }, { version: 2, roots: [] }, { roots: [null, { kind: "message", id: "a" }] }])
    assert.equal(snapshotHasFolds(data), false, JSON.stringify(data));
  assert.equal(snapshotHasFolds({ version: 2, roots: [{ kind: "message", id: "a" }, { kind: "fold", id: "f", children: [] }] }), true);
});

test("the notice ends with the session file when Pi knows it", () => {
  assert.match(unappliedFoldsNotice("why", "/s.jsonl"), /\(why\).*session file \/s\.jsonl\.$/);
  assert.match(unappliedFoldsNotice("why", undefined), /session file\.$/);
});
