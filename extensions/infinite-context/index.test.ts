import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import type { BranchEntry, Span } from "./core.ts";

const messages = (): BranchEntry[] =>
  ["one", "two", "three", "four", "five"].map((content, index) => ({
    type: "message",
    id: `u${index + 1}`,
    message: { role: "user", content, timestamp: index + 1 },
  }));

type Handler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

class Harness {
  active = messages();
  branch: BranchEntry[];
  readonly tools = new Map<string, ToolDefinition>();
  readonly handlers = new Map<string, Handler>();
  readonly appended: Array<{ customType: string; data: { spans: Span[] } }> = [];
  readonly ctx: ExtensionContext;

  constructor(initialSpans?: Span[]) {
    this.branch = [...this.active];
    if (initialSpans)
      this.branch.push({
        type: "custom",
        customType: "infinite-context",
        data: { spans: structuredClone(initialSpans) },
      });

    const api = {
      on: (name: string, handler: Handler) => this.handlers.set(name, handler),
      registerTool: (tool: ToolDefinition) => this.tools.set(tool.name, tool),
      appendEntry: (customType: string, data: unknown) => {
        const snapshot = structuredClone(data) as { spans: Span[] };
        this.appended.push({ customType, data: snapshot });
        this.branch.push({ type: "custom", customType, data: snapshot });
      },
      sendMessage: () => undefined,
    } as unknown as ExtensionAPI;

    this.ctx = {
      sessionManager: {
        buildContextEntries: () => this.active,
        getBranch: () => this.branch,
      },
      getContextUsage: () => ({
        tokens: 50,
        contextWindow: 100,
        percent: 50,
      }),
      ui: { notify: () => undefined },
    } as unknown as ExtensionContext;
    extension(api);
  }

  async start(): Promise<void> {
    await this.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      this.ctx,
    );
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
  ): Promise<AgentToolResult<unknown>> {
    const tool = this.tools.get(name);
    assert.ok(tool, `${name} registered`);
    return tool.execute("call", params, undefined, undefined, this.ctx);
  }
}

const outputText = (result: AgentToolResult<unknown>): string => {
  const block = result.content[0];
  assert.equal(block.type, "text");
  return block.text;
};

const latestSpans = (harness: Harness): Span[] =>
  harness.appended.at(-1)?.data.spans ?? [];

test("public tools replace, clear, normalize ids, persist only mutations, and keep messages recoverable", async () => {
  const harness = new Harness();
  await harness.start();
  assert.equal(harness.appended.length, 0);

  const folded = await harness.execute("context_fold", {
    items: [{ from: "#u1", to: "#u5", summary: "old; old" }],
  });
  assert.equal(harness.appended.length, 1);
  assert.deepEqual(latestSpans(harness)[0].memberIds, [
    "u1",
    "u2",
    "u3",
    "u4",
    "u5",
  ]);
  assert.deepEqual(latestSpans(harness)[0].summaryFragments?.map((f) => f.text), [
    "old; old",
  ]);
  const foldText = outputText(folded);
  assert.match(foldText, /mutation-only ctx projection/);
  assert.match(foldText, /Pi estimate 50%; excludes this response/);
  assert.doesNotMatch(foldText, /provider|last 50%|sf:/i);

  await harness.execute("context_fold", {
    items: [{ from: "#u3", summary: "new handoff", replaceSummary: true }],
  });
  assert.equal(harness.appended.length, 2);
  assert.equal(latestSpans(harness)[0].summary, "new handoff");

  const invalid = await harness.execute("context_fold", {
    items: [
      {
        from: "#u1",
        to: "#u2",
        summary: "invalid",
        replaceSummary: true,
      },
      { from: "#missing", summary: "x", replaceSummary: true },
    ],
  });
  assert.equal(harness.appended.length, 2, "invalid input does not persist");
  assert.match(outputText(invalid), /invalid replacement/);
  assert.match(outputText(invalid), /unknown id/);

  const peeked = await harness.execute("context_peek", { ids: ["#u3"] });
  for (let id = 1; id <= 5; id++)
    assert.match(outputText(peeked), new RegExp(`\\[#u${id}\\]`));

  await harness.execute("context_fold", {
    items: [{ from: "#u1", summary: "", replaceSummary: true }],
  });
  assert.equal(latestSpans(harness)[0].summary, "");
  assert.deepEqual(latestSpans(harness)[0].summaryFragments, []);

  const unfolded = await harness.execute("context_unfold", {
    items: [{ from: "#u1" }],
  });
  assert.match(outputText(unfolded), /unfolded 5 msgs/);
  assert.deepEqual(latestSpans(harness), []);
});

test("public fold merges then replaces in one batch", async () => {
  const harness = new Harness([
    { fromId: "u1", memberIds: ["u1", "u2"], summary: "left" },
    { fromId: "u4", memberIds: ["u4", "u5"], summary: "right" },
  ]);
  await harness.start();

  await harness.execute("context_fold", {
    items: [
      { from: "#u1", to: "#u5" },
      { from: "#u1", summary: "combined; exact", replaceSummary: true },
    ],
  });

  assert.equal(harness.appended.length, 1);
  assert.equal(latestSpans(harness).length, 1);
  assert.equal(latestSpans(harness)[0].summary, "combined; exact");
  assert.deepEqual(latestSpans(harness)[0].summaryFragments?.map((f) => f.text), [
    "combined; exact",
  ]);
});

test("metadata absence or damage does not write; real reconciliation changes still do", async () => {
  const malformed = {
    fromId: "u1",
    memberIds: ["u1", "u2"],
    summary: "exact; text",
    summaryFragments: [{ id: "sf:1", text: "different" }],
  } as Span;
  const harness = new Harness([malformed]);
  await harness.start();
  await harness.execute("context_map", {});
  assert.equal(harness.appended.length, 0, "read access does not repair metadata");

  await harness.execute("context_fold", {
    items: [{ from: "#missing", summary: "ignored", replaceSummary: true }],
  });
  assert.equal(harness.appended.length, 0, "failed mutation does not repair metadata");

  harness.active = harness.active.slice(1);
  await harness.execute("context_map", {});
  assert.equal(harness.appended.length, 1, "membership reconciliation still persists");
  assert.equal(latestSpans(harness)[0].fromId, "u2");
  assert.deepEqual(
    latestSpans(harness)[0].summaryFragments,
    malformed.summaryFragments,
    "reconciliation retains metadata without normalizing it",
  );
});
