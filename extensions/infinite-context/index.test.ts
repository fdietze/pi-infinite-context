import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { INFINITE_CONTEXT_ENTRY, type BranchEntry, type Span } from "./core.ts";
import infiniteContext from "./index.ts";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface RegisteredTool {
  name: string;
  description: string;
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResult>;
  renderResult?(
    result: ToolResult,
    opts: { expanded: boolean; isPartial: boolean },
    theme: Theme,
  ): { render(width: number): string[] };
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

async function publicShell(messageCount = 125) {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  const api = {
    registerTool(tool: unknown) {
      const registered = tool as RegisteredTool;
      tools.set(registered.name, registered);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;

  const active: BranchEntry[] = Array.from({ length: messageCount }, (_, i) => ({
    type: "message",
    id: `m${i}`,
    message: {
      role: "user",
      content: `message ${i}`,
      timestamp: i + 1,
    },
  }));
  const summary = `${"a".repeat(59)}😀${"z".repeat(1_000_000)}`;
  const spans: Span[] = [
    { fromId: "m0", memberIds: ["m0", "m1"], summary },
  ];
  const branch: BranchEntry[] = [
    ...active,
    { type: "custom", customType: INFINITE_CONTEXT_ENTRY, data: { spans } },
  ];
  const ctx = {
    sessionManager: {
      buildContextEntries: () => active,
      getBranch: () => branch,
    },
    getContextUsage: () => ({
      tokens: 1234,
      contextWindow: 10_000,
      percent: 12.34,
    }),
  } as unknown as ExtensionContext;

  infiniteContext(api);
  await handlers.get("session_start")?.({}, ctx);

  return {
    summary,
    tool(name: string) {
      const registered = tools.get(name);
      assert.ok(registered, `${name} was registered`);
      return registered;
    },
    execute(name: string, params: unknown) {
      return this.tool(name).execute("test", params, undefined, undefined, ctx);
    },
  };
}

function resultText(result: ToolResult): string {
  const block = result.content[0];
  assert.ok(block?.type === "text" && typeof block.text === "string");
  return block.text;
}

const plainTheme = {
  fg: (_color: unknown, text: string) => text,
} as unknown as Theme;

function rendered(tool: RegisteredTool, details: unknown): string {
  assert.ok(tool.renderResult);
  return tool
    .renderResult(
      { content: [{ type: "text", text: "legacy" }], details },
      { expanded: true, isPartial: false },
      plainTheme,
    )
    .render(1000)
    .join("\n")
    .trimEnd();
}

test("registered context_map bounds model output and paginates rows", async () => {
  const shell = await publicShell();
  const map = shell.tool("context_map");
  assert.match(map.description, /Pi's current estimate/);

  const first = await shell.execute("context_map", {});
  const firstText = resultText(first);
  const firstDetails = first.details as {
    rows: Array<{ id: string; text: string }>;
    notes: string[];
  };
  assert.equal(firstDetails.rows.length, 50);
  assert.deepEqual(
    [firstDetails.rows[0].id, firstDetails.rows.at(-1)?.id],
    ["m0", "m50"],
  );
  assert.ok(firstText.length < 10_000, `bounded map was ${firstText.length} chars`);
  assert.match(firstText, /124 rows total · showing 1-50/);
  assert.match(firstText, /Pi context estimate 12% \(1\.2k\/10k tok\)/);
  assert.match(firstText, new RegExp(`${"a".repeat(59)}…`));
  assert.doesNotMatch(firstText, /[\uD800-\uDFFF]/);
  assert.match(firstText, /context_map with offset=50 and limit=50/);

  const second = await shell.execute("context_map", { offset: 50, limit: 50 });
  const secondDetails = second.details as {
    rows: Array<{ id: string }>;
    notes: string[];
  };
  assert.deepEqual(
    [secondDetails.rows[0].id, secondDetails.rows.at(-1)?.id],
    ["m51", "m100"],
  );
  assert.match(resultText(second), /showing 51-100/);
  assert.deepEqual(secondDetails.notes, [
    "More rows: call context_map with offset=100 and limit=50.",
  ]);

  const last = await shell.execute("context_map", { offset: 100, limit: 50 });
  const lastDetails = last.details as {
    rows: Array<{ id: string }>;
    notes: string[];
  };
  assert.equal(lastDetails.rows.length, 24);
  assert.deepEqual(
    [lastDetails.rows[0].id, lastDetails.rows.at(-1)?.id],
    ["m101", "m124"],
  );
  assert.deepEqual(lastDetails.notes, []);
});

test("registered tools reject invalid bounds and peek mode combinations", async () => {
  const shell = await publicShell();
  await assert.rejects(
    shell.execute("context_map", { offset: -1 }),
    /offset must be a non-negative safe integer/,
  );
  await assert.rejects(
    shell.execute("context_map", { limit: 201 }),
    /limit must be between 1 and 200/,
  );
  await assert.rejects(
    shell.execute("context_peek", {
      ids: ["m0"],
      offset: 1,
      summaryOnly: true,
    }),
    /summaryOnly cannot be combined with offset/,
  );
});

test("registered context_peek returns an exact full summary by hidden-member id", async () => {
  const shell = await publicShell();
  const result = await shell.execute("context_peek", {
    ids: ["#m1"],
    summaryOnly: true,
  });
  const text = resultText(result);
  const bodyAt = text.indexOf("\n\n");
  assert.ok(bodyAt > 0);
  assert.equal(text.slice(bodyAt + 2), shell.summary);
  assert.deepEqual(result.details, {
    folds: 1,
    members: 0,
    missing: [],
    summaryOnly: true,
  });
});

test("map and peek render legacy result detail shapes", async () => {
  const shell = await publicShell();
  const mapText = rendered(shell.tool("context_map"), {
    header: "legacy map",
    rows: [
      {
        id: "old",
        kind: "fold",
        role: "fold",
        tokens: 12,
        msgs: 2,
        text: "old summary",
      },
    ],
  });
  assert.match(mapText, /\[#old\].*12 tok hidden.*old summary/);

  const peekText = rendered(shell.tool("context_peek"), {
    folds: 1,
    members: 2,
    missing: [],
  });
  assert.match(peekText, /◈ 1 fold · 2 members/);
});
