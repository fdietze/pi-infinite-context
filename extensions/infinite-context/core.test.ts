import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type AgentMessageLike,
  type BranchEntry,
  type Span,
  branchMessages,
  buildContextMap,
  buildOverlay,
  estimateTokens,
  fmtTokens,
  planFold,
  planUnfold,
  planNudge,
  reconcileSpans,
  reconstructSpans,
  searchMessages,
  compileSearchPattern,
  serializeSpan,
  stubTokens,
  summarizeTree,
  unitBounds,
} from "./core.ts";

// --- branch builders -------------------------------------------------------

let ts = 0;
const entry = (
  id: string,
  role: string,
  content: AgentMessageLike["content"],
  extra: Partial<AgentMessageLike> = {},
): BranchEntry => ({
  type: "message",
  id,
  message: { role, content, timestamp: ++ts, ...extra },
});

const userE = (id: string, text: string) => entry(id, "user", text);
const asstText = (id: string, text: string) => entry(id, "assistant", text);
// Assistant turn that issues parallel tool calls.
const asstCalls = (id: string, callIds: string[]) =>
  entry(id, "assistant", [
    { type: "text", text: "working" },
    ...callIds.map((c) => ({ type: "toolCall", id: c }) as { type: string }),
  ] as AgentMessageLike["content"]);
const toolRes = (id: string, callId: string, text: string) =>
  entry(id, "toolResult", [{ type: "text", text }], { toolCallId: callId });

// A turn with N parallel reads in ONE assistant message + their results.
function batchedReadBranch(): BranchEntry[] {
  ts = 0;
  return [
    userE("u1", "read 3 files"),
    asstCalls("A", ["c1", "c2", "c3"]),
    toolRes("R1", "c1", "file 1 contents"),
    toolRes("R2", "c2", "file 2 contents"),
    toolRes("R3", "c3", "file 3 contents"),
    asstText("A2", "all read"),
  ];
}

// Five standalone user messages (no tool units) -> splittable span.
function fiveUserBranch(): BranchEntry[] {
  ts = 0;
  return [
    userE("u1", "one"),
    userE("u2", "two two"),
    userE("u3", "three three three"),
    userE("u4", "four four four four"),
    userE("u5", "five"),
  ];
}

// --- estimateTokens / fmtTokens -------------------------------------------

test("estimateTokens uses pi's estimator for text, tool calls, and images", () => {
  assert.equal(estimateTokens({ role: "user", content: "x".repeat(40) }), 10);
  // "ab"(2) + name "read"(4) + JSON.stringify({path:"f"}) '{"path":"f"}'(12) = 18 -> ceil/4 = 5
  const a: AgentMessageLike = {
    role: "assistant",
    content: [
      { type: "text", text: "ab" },
      { type: "toolCall", name: "read", arguments: { path: "f" } },
    ] as AgentMessageLike["content"],
  };
  assert.equal(estimateTokens(a), 5);
  // An image block costs pi's flat ESTIMATED_IMAGE_CHARS, not its payload length.
  assert.equal(
    estimateTokens({ role: "toolResult", content: [{ type: "image" }] }),
    1200,
  );
  assert.equal(
    estimateTokens({ role: "bashExecution", command: "pwd", output: "/tmp" }),
    2,
  );
  assert.equal(
    estimateTokens({ role: "compactionSummary", summary: "x".repeat(40) }),
    10,
  );
});

// stubTokens must measure exactly what buildOverlay renders (no inline id).
test("stubTokens equals the estimate of the rendered stub text", () => {
  assert.equal(
    stubTokens("summary", 2, 100),
    estimateTokens({ role: "user", content: "(summary, 100 hidden) summary" }),
  );
});

test("fmtTokens: raw below 1000, k-suffix with trailing .0 dropped", () => {
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1000), "1k");
  assert.equal(fmtTokens(1200), "1.2k");
  assert.equal(fmtTokens(3400), "3.4k");
  assert.equal(fmtTokens(12000), "12k");
});

// --- unitBounds ------------------------------------------------------------

test("unitBounds groups parallel tool calls of one assistant turn into one unit", () => {
  const msgs = branchMessages(batchedReadBranch());
  const { start, end } = unitBounds(msgs);
  assert.deepEqual(start, [0, 1, 1, 1, 1, 5]);
  assert.deepEqual(end, [0, 4, 4, 4, 4, 5]);
});

// --- planFold --------------------------------------------------------------

test("planFold: two items hitting the same tool unit merge into ONE stub, keep the non-empty summary, count distinct", () => {
  const msgs = branchMessages(batchedReadBranch());
  const plan = planFold(msgs, [], [
    { from: "R1", summary: "f01 done" },
    { from: "R2" },
  ]);
  assert.equal(plan.spans.length, 1, "one merged span");
  assert.deepEqual(plan.spans[0].memberIds, ["A", "R1", "R2", "R3"]);
  assert.equal(plan.spans[0].fromId, "A");
  assert.equal(plan.spans[0].summary, "f01 done");
  assert.deepEqual(plan.applied, ["A"]);
  assert.equal(plan.folded, 4);
  assert.deepEqual(plan.summaries, ["f01 done"]);
});

test("planFold: freedTokens > 0 for a fresh fold, and excludes already-folded members", () => {
  const msgs = branchMessages(batchedReadBranch());
  const first = planFold(msgs, [], [{ from: "R1" }]);
  assert.ok(first.freedTokens > 0, "fresh fold frees tokens");
  // Re-folding an already folded range frees no new live tokens.
  const second = planFold(msgs, first.spans, [{ from: "R1" }]);
  assert.ok(second.freedTokens <= 0, "no double-counting already-folded members");
});

test("planFold: single standalone message -> single-member span", () => {
  const plan = planFold(branchMessages(fiveUserBranch()), [], [{ from: "u2" }]);
  assert.equal(plan.spans.length, 1);
  assert.deepEqual(plan.spans[0].memberIds, ["u2"]);
  assert.equal(plan.spans[0].summary, "");
  assert.equal(plan.folded, 1);
});

test("planFold: unknown ids reported, not applied", () => {
  const msgs = branchMessages(batchedReadBranch());
  const plan = planFold(msgs, [], [{ from: "nope" }, { from: "A2" }]);
  assert.deepEqual(plan.unknown, ["nope"]);
  assert.deepEqual(plan.applied, ["A2"]);
});

test("planFold: folding over an existing span absorbs it and inherits its summary", () => {
  const msgs = branchMessages(fiveUserBranch());
  const first = planFold(msgs, [], [{ from: "u5", summary: "kept" }]);
  const second = planFold(msgs, first.spans, [
    { from: "u1", to: "u5", summary: "outer" },
  ]);
  assert.equal(second.spans.length, 1);
  assert.match(second.spans[0].summary, /kept/);
  assert.match(second.spans[0].summary, /outer/);
});

test("planFold: input spans are not mutated (pure)", () => {
  const msgs = branchMessages(batchedReadBranch());
  const input: Span[] = [];
  const plan = planFold(msgs, input, [{ from: "A2", summary: "x" }]);
  assert.equal(input.length, 0);
  assert.equal(plan.spans.length, 1);
});

// --- planUnfold (range-aware, splits) --------------------------------------

test("planUnfold: bare span fromId unfolds the whole fold", () => {
  const msgs = branchMessages(fiveUserBranch());
  const folded = planFold(msgs, [], [{ from: "u1", to: "u5", summary: "s" }]);
  const plan = planUnfold(msgs, folded.spans, [{ from: "u1" }]);
  assert.equal(plan.spans.length, 0, "fold fully dissolved");
  assert.deepEqual(plan.applied, ["u1"]);
  assert.ok(plan.restoredTokens > 0);
});

test("planUnfold: a bare inner member id (no `to`) also unfolds the WHOLE fold", () => {
  const msgs = branchMessages(fiveUserBranch());
  const folded = planFold(msgs, [], [{ from: "u1", to: "u5", summary: "s" }]);
  const plan = planUnfold(msgs, folded.spans, [{ from: "u3" }]); // u3 is inner, not the stub id
  assert.equal(plan.spans.length, 0, "whole fold unfolded, not just u3");
});

test("planUnfold: sub-range splits the fold into two remnants that inherit the summary", () => {
  const msgs = branchMessages(fiveUserBranch());
  const folded = planFold(msgs, [], [{ from: "u1", to: "u5", summary: "s" }]);
  const plan = planUnfold(msgs, folded.spans, [{ from: "u3", to: "u3" }]);
  assert.deepEqual(plan.applied, ["u3"]);
  assert.equal(plan.spans.length, 2);
  const byFrom = Object.fromEntries(plan.spans.map((s) => [s.fromId, s]));
  assert.deepEqual(byFrom["u1"].memberIds, ["u1", "u2"]);
  assert.deepEqual(byFrom["u4"].memberIds, ["u4", "u5"]);
  assert.equal(byFrom["u1"].summary, "s");
  assert.equal(byFrom["u4"].summary, "s");
  // net restored = restored member(s) + remnant stubs − removed original stub
  const tk = (c: string) => estimateTokens({ role: "user", content: c });
  const hLeft = tk("one") + tk("two two");
  const hRight = tk("four four four four") + tk("five");
  const hAll = hLeft + tk("three three three") + hRight;
  const expected =
    tk("three three three") +
    stubTokens("s", 2, hLeft) +
    stubTokens("s", 2, hRight) -
    stubTokens("s", 5, hAll);
  assert.equal(plan.restoredTokens, expected);
});

test("planUnfold: sub-range snaps to whole tool units (no orphaned pair)", () => {
  const msgs = branchMessages(batchedReadBranch());
  const folded = planFold(msgs, [], [{ from: "u1", to: "A2", summary: "s" }]);
  // Trying to unfold just R2 (inside the A..R3 unit) snaps to the whole unit.
  const plan = planUnfold(msgs, folded.spans, [{ from: "R2", to: "R2" }]);
  // the restored chunk must be the whole unit A,R1,R2,R3; remnants are u1 and A2
  const fromsRestoredUnit = plan.applied[0];
  assert.equal(fromsRestoredUnit, "A");
  const remnants = plan.spans.flatMap((s) => s.memberIds).sort();
  assert.deepEqual(remnants, ["A2", "u1"]);
});

test("planUnfold: id matching no span is a noop", () => {
  const msgs = branchMessages(fiveUserBranch());
  const folded = planFold(msgs, [], [{ from: "u1", to: "u2", summary: "s" }]);
  const plan = planUnfold(msgs, folded.spans, [{ from: "u5" }]);
  assert.deepEqual(plan.noop, ["u5"]);
  assert.equal(plan.spans.length, 1);
});

test("planUnfold: rejects an end id outside the fold containing from", () => {
  const msgs = branchMessages(fiveUserBranch());
  const folded = planFold(msgs, [], [{ from: "u1", to: "u2", summary: "s" }]);
  const plan = planUnfold(msgs, folded.spans, [{ from: "u1", to: "u5" }]);
  assert.deepEqual(plan.invalid, ["u1..u5"]);
  assert.deepEqual(plan.spans, folded.spans);
  assert.equal(plan.restoredMsgs, 0);
});

// --- summarizeTree ---------------------------------------------------------

test("summarizeTree: totals + one line per span in branch order", () => {
  const msgs = branchMessages(fiveUserBranch());
  const spans: Span[] = [
    { fromId: "u4", memberIds: ["u4", "u5"], summary: "" },
    { fromId: "u1", memberIds: ["u1", "u2"], summary: "early notes" },
  ];
  const t = summarizeTree(spans, msgs);
  assert.equal(t.totalSpans, 2);
  assert.ok(t.hiddenTokens > 0);
  // ordered by first-member position: u1 span before u4 span
  assert.match(t.lines[0], /^\[#u1\] · 2 msgs · \S+ tok · early notes$/);
  assert.match(t.lines[1], /^\[#u4\] · 2 msgs · \S+ tok · \(no summary\)$/);
});

// --- serializeSpan ---------------------------------------------------------

test("serializeSpan: members with inner id + role + size + content, no range when shown whole", () => {
  const msgs = branchMessages(fiveUserBranch());
  const span: Span = { fromId: "u2", memberIds: ["u2", "u3"], summary: "" };
  const out = serializeSpan(span, msgs);
  assert.match(out, /\[#u2\] user \d+\ntwo two/);
  assert.match(out, /\[#u3\] user \d+\nthree three three/);
});

test("serializeSpan: long content is truncated with a marker; the range counts only printed lines", () => {
  ts = 0;
  const branch = [userE("big", `${"z".repeat(5000)}\ntail`)];
  const span: Span = { fromId: "big", memberIds: ["big"], summary: "" };
  const out = serializeSpan(span, branchMessages(branch), new Map(), 2000);
  assert.match(out, /· lines 1-1 of 2\n/, "the cut-off second line is not claimed");
  assert.match(out, /… \[\+3005 chars\]$/);
});

test("serializeSpan: the range stops at the last COMPLETE line, so start = last + 1 loses nothing", () => {
  ts = 0;
  const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}${"x".repeat(299)}`);
  const branch = [userE("m", lines.join("\n"))];
  const msgs = branchMessages(branch);
  const span: Span = { fromId: "m", memberIds: ["m"], summary: "" };
  const first = serializeSpan(span, msgs, new Map(), 2000);
  const last = Number(/lines 1-(\d+) of 10/.exec(first)![1]);
  assert.equal(last, 6, "line 7 is cut in half by the cap and is not claimed");
  const resumed = serializeSpan(span, msgs, new Map([["m", last + 1]]), 2000);
  assert.equal(resumed.split("\n")[1], lines[last], "resumes at the full line 7");
});

test("serializeSpan: offset windows only the named message, other members start at line 1", () => {
  ts = 0;
  const branch = [
    userE("long", "a\nb\nc\nd\ne"),
    userE("short", "only line"),
  ];
  const span: Span = { fromId: "long", memberIds: ["long", "short"], summary: "" };
  const out = serializeSpan(span, branchMessages(branch), new Map([["long", 4]]));
  assert.match(out, /\[#long\] user \d+ · lines 4-5 of 5\nd\ne/);
  assert.match(out, /\[#short\] user \d+\nonly line/);
});

test("serializeSpan: an offset past the last line says so instead of printing an empty range", () => {
  ts = 0;
  const branch = [userE("m", "a\nb")];
  const span: Span = { fromId: "m", memberIds: ["m"], summary: "" };
  const out = serializeSpan(span, branchMessages(branch), new Map([["m", 9]]));
  assert.match(out, /· 2 lines \(offset 9 is past the end\)$/);
});

// The search -> peek pipe only works if both count lines over the same text.
test("search line numbers address exactly the lines peek prints", () => {
  ts = 0;
  const filler = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const branch = [userE("m", [...filler, "the needle here", ...filler].join("\n"))];
  const msgs = branchMessages(branch);
  const span: Span = { fromId: "m", memberIds: ["m"], summary: "" };
  const hit = grep(msgs, [span], "needle").hits[0].lines[0];
  assert.equal(hit.line, 41);
  const out = serializeSpan(span, msgs, new Map([["m", hit.line]]));
  const firstBodyLine = out.split("\n")[1];
  assert.equal(firstBodyLine, "the needle here");
});

// --- searchMessages (regex grep, per line) ---------------------------------

// searchMessages takes a compiled pattern; tests state the pattern as source.
const grep = (
  msgs: Parameters<typeof searchMessages>[0],
  spans: Span[],
  pattern: string,
  linesPerMessage?: number,
  linesPerPattern?: number,
) =>
  searchMessages(
    msgs,
    spans,
    compileSearchPattern(pattern),
    linesPerMessage,
    linesPerPattern,
  );

// A branch whose messages contain multiple lines, for line-level assertions.
function multilineBranch(): BranchEntry[] {
  ts = 0;
  return [
    userE("u1", "alpha one\nbeta two\ngamma three"),
    userE("u2", "ALPHA shouting\nnothing here"),
  ];
}

test("searchMessages: regex metacharacters match, case-insensitively", () => {
  const msgs = branchMessages(multilineBranch());
  const r = grep(msgs, [], "al.ha\\s+\\w+");
  assert.equal(r.totalLines, 2);
  assert.equal(r.totalMessages, 2);
  assert.deepEqual(
    r.hits.map((h) => [h.id, h.lines[0].line, h.lines[0].text]),
    [
      ["u1", 1, "alpha one"],
      ["u2", 1, "ALPHA shouting"],
    ],
  );
});

test("searchMessages: matching is per line, so `.` never spans a newline", () => {
  const msgs = branchMessages(multilineBranch());
  assert.equal(grep(msgs, [], "one.*beta").totalLines, 0);
  assert.equal(grep(msgs, [], "one|beta").totalLines, 2);
});

test("searchMessages: several lines of one message are reported with 1-based line numbers", () => {
  const msgs = branchMessages(multilineBranch());
  // `^` anchors per line without the `m` flag: each line is matched on its own.
  const r = grep(msgs, [], "^(beta|gamma)");
  assert.equal(r.hits.length, 1);
  assert.deepEqual(r.hits[0].lines, [
    { line: 2, text: "beta two" },
    { line: 3, text: "gamma three" },
  ]);
  assert.equal(r.hits[0].moreLines, 0);
  assert.equal(r.totalLines, 2);
  assert.equal(r.totalMessages, 1);
});

test("searchMessages: a hit inside a fold carries its fold's fromId; a live hit carries null", () => {
  const msgs = branchMessages(multilineBranch());
  const spans: Span[] = [{ fromId: "u2", memberIds: ["u2"], summary: "" }];
  const r = grep(msgs, spans, "alpha");
  assert.deepEqual(
    r.hits.map((h) => [h.id, h.foldFrom]),
    [
      ["u1", null],
      ["u2", "u2"],
    ],
  );
  assert.equal(r.foldedMessages, 1);
});

test("searchMessages: a matching summary is its own 'fold summary' hit, listed last", () => {
  const msgs = branchMessages(multilineBranch());
  const spans: Span[] = [
    { fromId: "u1", memberIds: ["u1", "u2"], summary: "the secret digest" },
  ];
  const r = grep(msgs, spans, "secret|gamma");
  assert.deepEqual(
    r.hits.map((h) => [h.id, h.role, h.foldFrom]),
    [
      ["u1", "user", "u1"],
      ["u1", "fold summary", null],
    ],
  );
  assert.deepEqual(r.hits[1].lines, [{ line: 1, text: "the secret digest" }]);
  // The summary hit is not "folded": it IS the fold, and it is always visible.
  assert.equal(r.foldedMessages, 1);
});

test("searchMessages: per-message cap emits N lines + a remainder, totals stay true", () => {
  ts = 0;
  const msgs = branchMessages([userE("big", "hit\n".repeat(8).trim())]);
  const r = grep(msgs, [], "hit", 5, 50);
  assert.equal(r.hits[0].lines.length, 5);
  assert.equal(r.hits[0].moreLines, 3);
  assert.equal(r.totalLines, 8);
  assert.equal(r.capped, false, "the per-pattern budget was not the limit");
});

test("searchMessages: per-pattern cap stops emission, counting continues", () => {
  ts = 0;
  const branch = [1, 2, 3].map((i) => userE(`m${i}`, "hit\nhit\nhit"));
  const r = grep(branchMessages(branch), [], "hit", 5, 4);
  assert.equal(
    r.hits.reduce((n, h) => n + h.lines.length, 0),
    4,
    "emission stops at the per-pattern budget",
  );
  assert.equal(r.totalLines, 9);
  assert.equal(r.totalMessages, 3, "silenced messages still count");
  assert.equal(r.hits.length, 2, "the third message emits nothing");
  assert.equal(r.capped, true);
});

test("searchMessages: a long line is windowed around its first match", () => {
  ts = 0;
  const line = `${"x".repeat(500)}needle${"y".repeat(500)}`;
  const r = grep(branchMessages([userE("l", line)]), [], "needle");
  const text = r.hits[0].lines[0].text;
  assert.ok(text.includes("needle"));
  assert.ok(text.startsWith("…") && text.endsWith("…"), "both ends truncated");
  assert.ok(text.length <= 202, `windowed to ~200 chars, got ${text.length}`);
});

test("compileSearchPattern: an invalid pattern throws (the shell turns it into a tool error)", () => {
  assert.throws(() => compileSearchPattern("("), SyntaxError);
});

// --- reconcileSpans / reconstructSpans -----------------------------------

test("reconcileSpans drops compacted members and keeps active tail members", () => {
  const active = branchMessages([userE("u3", "three"), userE("u4", "four")]);
  const spans: Span[] = [
    { fromId: "u1", memberIds: ["u1", "u2"], summary: "gone" },
    { fromId: "u2", memberIds: ["u2", "u3", "u4"], summary: "partly active" },
  ];
  const reconciled = reconcileSpans(spans, active);
  assert.deepEqual(reconciled.spans, [
    { fromId: "u3", memberIds: ["u3", "u4"], summary: "partly active" },
  ]);
  assert.equal(reconciled.changed, true);
});

test("reconcileSpans preserves already-active spans without mutation", () => {
  const active = branchMessages(fiveUserBranch());
  const spans: Span[] = [
    { fromId: "u2", memberIds: ["u2", "u3"], summary: "active" },
  ];
  const reconciled = reconcileSpans(spans, active);
  assert.deepEqual(reconciled.spans, spans);
  assert.equal(reconciled.changed, false);
  assert.notEqual(reconciled.spans, spans);
});

test("branchMessages exposes every addressable active context entry", () => {
  const active: BranchEntry[] = [
    { type: "compaction", id: "cmp", timestamp: "2026-01-01T00:00:00Z", summary: "older work", tokensBefore: 2000 },
    { type: "branch_summary", id: "br", timestamp: "2026-01-01T00:00:01Z", summary: "other branch", fromId: "old" },
    { type: "custom_message", id: "custom", timestamp: "2026-01-01T00:00:02Z", customType: "facts", content: "injected" },
    entry("bash", "bashExecution", "", { command: "pwd", output: "/tmp" }),
    userE("u", "live"),
  ];
  const msgs = branchMessages(active);
  assert.deepEqual(msgs.map((m) => [m.id, m.message.role]), [
    ["cmp", "compactionSummary"],
    ["br", "branchSummary"],
    ["custom", "custom"],
    ["bash", "bashExecution"],
    ["u", "user"],
  ]);
  assert.equal(msgs[0].message.summary, "older work");
});

test("reconstructSpans: last custom entry wins (cumulative snapshot); other custom types ignored", () => {
  const branch: BranchEntry[] = [
    { type: "custom", customType: "infinite-context", data: { spans: [{ fromId: "X", memberIds: ["X"], summary: "old" }] } },
    { type: "custom", customType: "other", data: { spans: [] } },
    { type: "custom", customType: "infinite-context", data: { spans: [{ fromId: "A", memberIds: ["A", "R1"], summary: "keep" }] } },
  ];
  const spans = reconstructSpans(branch);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0], { fromId: "A", memberIds: ["A", "R1"], summary: "keep" });
});

// --- buildOverlay ----------------------------------------------------------

function messagesOf(branch: BranchEntry[]): AgentMessageLike[] {
  return branchMessages(branch).map((entry) => ({ ...entry.message }));
}

test("buildOverlay: no spans -> live messages pass through untouched (no marker)", () => {
  const branch = batchedReadBranch();
  const out = buildOverlay(messagesOf(branch), branchMessages(branch), []);
  // Live message content is byte-identical to the source (no [#id] prefix), so
  // the provider's native prefix cache stays intact across calls.
  assert.equal(out[0].content as string, "read 3 files");
  const r1 = out[2].content as Array<{ text?: string }>;
  assert.doesNotMatch(r1[0].text as string, /^\[#/);
});

test("buildOverlay: a summarized span renders a stub with hidden cost and hides members", () => {
  const branch = batchedReadBranch();
  const span: Span = { fromId: "A", memberIds: ["A", "R1", "R2", "R3"], summary: "read 3 files" };
  const out = buildOverlay(messagesOf(branch), branchMessages(branch), [span]);
  assert.equal(out.length, 3);
  assert.equal(out[1].role, "user");
  // No inline [#id]: fold ids are visible only in tool results (map/search/
  // peek/fold), keeping the overlay free of imitation-prone markers.
  assert.match(out[1].content as string, /^\(summary, \S+ hidden\) read 3 files$/);
});

test("buildOverlay: empty-summary span renders a (folded N, X hidden) stub", () => {
  const branch = batchedReadBranch();
  const span: Span = { fromId: "A", memberIds: ["A", "R1", "R2", "R3"], summary: "" };
  const out = buildOverlay(messagesOf(branch), branchMessages(branch), [span]);
  assert.match(out[1].content as string, /^\(folded 4 messages, \S+ hidden\)$/);
});

// --- buildContextMap -------------------------------------------------------

test("buildContextMap: interleaves live rows and one fold row in conversation order", () => {
  const msgs = branchMessages(batchedReadBranch());
  const span: Span = { fromId: "A", memberIds: ["A", "R1", "R2", "R3"], summary: "read 3 files" };
  const rows = buildContextMap(msgs, [span]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.id), ["u1", "A", "A2"]);
  assert.deepEqual(rows.map((r) => r.kind), ["live", "fold", "live"]);
  assert.equal(rows[0].role, "user");
  assert.match(rows[0].text, /read 3 files/);
  assert.equal(rows[1].kind, "fold");
  assert.equal(rows[1].msgs, 4);
  assert.ok(rows[1].tokens > 0);
  assert.equal(rows[1].text, "read 3 files");
  assert.equal(rows[2].role, "assistant");
});

test("buildContextMap: no folds -> one live row per taggable message", () => {
  const msgs = branchMessages(fiveUserBranch());
  const rows = buildContextMap(msgs, []);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.kind === "live" && r.msgs === 1));
  assert.deepEqual(rows.map((r) => r.id), ["u1", "u2", "u3", "u4", "u5"]);
});

test("buildContextMap: fold with empty summary -> (no summary) label; snippet is capped", () => {
  ts = 0;
  const branch = [userE("big", "z".repeat(400)), userE("u2", "two")];
  const msgs = branchMessages(branch);
  const span: Span = { fromId: "u2", memberIds: ["u2"], summary: "" };
  const rows = buildContextMap(msgs, [span], 60);
  assert.equal(rows[0].id, "big");
  assert.ok(rows[0].text.endsWith("…"), "long snippet is truncated with an ellipsis");
  assert.ok(rows[0].text.length <= 61);
  const fold = rows.find((r) => r.kind === "fold")!;
  assert.equal(fold.text, "(no summary)");
});

// --- planNudge (context-fill nudge policy) ---------------------------------

test("planNudge: silent below the base, disarmed (band 0)", () => {
  assert.deepEqual(planNudge(74.9, 0, true), { nudge: false, band: 0 });
  // Below the base re-arms even if a higher band was nudged before.
  assert.deepEqual(planNudge(10, 90, true), { nudge: false, band: 0 });
});

test("planNudge: fires once per band on continuing turns, then holds", () => {
  // First crossing of 75 fires and records the band.
  assert.deepEqual(planNudge(76, 0, true), { nudge: true, band: 75 });
  // Same band again does not re-fire.
  assert.deepEqual(planNudge(79, 75, true), { nudge: false, band: 75 });
  // Next 5-point band fires again.
  assert.deepEqual(planNudge(81, 75, true), { nudge: true, band: 80 });
  assert.deepEqual(planNudge(97, 90, true), { nudge: true, band: 95 });
});

test("planNudge: never fires on a non-continuing turn but holds the band", () => {
  // Advanced past a band while idle: hold lastBand so the next continuing turn fires.
  assert.deepEqual(planNudge(88, 0, false), { nudge: false, band: 0 });
  assert.deepEqual(planNudge(88, 0, true), { nudge: true, band: 85 });
});

test("planNudge: re-arms after fill drops below the base then climbs again", () => {
  // Nudged at 75, dropped below base (reset to 0), climbs back over 75 -> fires.
  assert.deepEqual(planNudge(70, 75, true), { nudge: false, band: 0 });
  assert.deepEqual(planNudge(77, 0, true), { nudge: true, band: 75 });
});

test("planNudge: non-finite percent is treated as below base", () => {
  assert.deepEqual(planNudge(NaN, 80, true), { nudge: false, band: 0 });
});
