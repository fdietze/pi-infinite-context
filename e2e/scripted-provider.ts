// A Pi extension that replaces the model with a deterministic script and records
// every provider request transcript to E2E_TRANSCRIPT as JSONL.
//
// The script drives one realistic recovery pattern: parallel tool calls, an
// aborted attempt that leaves a tool call without a result, then a context_fold
// of everything before the current turn.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const FOLD_SUMMARY = "ARCHIVED: greeting and the aborted attempt";
const transcriptPath = process.env.E2E_TRANSCRIPT ?? "/tmp/e2e-transcript.jsonl";
const log = (value: unknown) => appendFileSync(transcriptPath, `${JSON.stringify(value)}\n`);

type Step =
  | { kind: "calls"; calls: { name: string; arguments: unknown }[] }
  | { kind: "abort"; call: { name: string; arguments: unknown } }
  | { kind: "fold" }
  | { kind: "text"; text: string };

const script: Step[] = [
  { kind: "calls", calls: [{ name: "bash", arguments: { command: "echo one" } }] },
  // Abandoned attempt: a tool call the provider never answers.
  { kind: "abort", call: { name: "bash", arguments: { command: "echo never" } } },
  { kind: "calls", calls: [{ name: "context_map", arguments: {} }] },
  { kind: "fold" },
  { kind: "text", text: "DONE" },
];

/** Root ids as the last context_map result reported them. */
function mapRootIds(messages: readonly any[]): string[] {
  for (let i = messages.length - 1; i >= 0; --i) {
    const message = messages[i];
    if (message.role !== "toolResult") continue;
    const text = (Array.isArray(message.content) ? message.content : [])
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");
    const ids = [...text.matchAll(/\[#([\w-]+)\]/g)].map((match) => match[1]);
    if (ids.length) return ids;
  }
  return [];
}

export default function scriptedProvider(pi: any) {
  let step = 0;
  pi.registerProvider("fake", {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "unused",
    api: "fake-api",
    models: [
      {
        id: "scripted",
        name: "Scripted",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1000,
      },
    ],
    streamSimple(model: any, context: any) {
      const current = script[Math.min(step, script.length - 1)];
      const index = ++step;
      log({ request: index, messages: context.messages.map(summarize) });
      const stream = createAssistantMessageEventStream();
      const message: any = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        const call = (name: string, args: unknown) =>
          message.content.push({
            type: "toolCall",
            id: `call_${index}_${message.content.length}`,
            name,
            arguments: args,
          });
        if (current.kind === "text") message.content.push({ type: "text", text: current.text });
        if (current.kind === "calls")
          for (const entry of current.calls) call(entry.name, entry.arguments);
        if (current.kind === "abort") {
          call(current.call.name, current.call.arguments);
          message.stopReason = "error";
          message.errorMessage = "529 overloaded_error: Overloaded";
          stream.push({ type: "error", reason: "error", error: message });
          stream.end();
          return;
        }
        if (current.kind === "fold") {
          const ids = mapRootIds(context.messages);
          call("context_fold", {
            // Everything except the running turn, including the abandoned attempt.
            items: [{ from: ids[0], to: ids[Math.max(ids.length - 2, 0)], summary: FOLD_SUMMARY }],
          });
        }
        message.stopReason = message.content.some((block: any) => block.type === "toolCall")
          ? "toolUse"
          : "stop";
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}

/** Enough of each message to assert transcript shape without dumping content. */
function summarize(message: any) {
  return {
    role: message.role,
    text: typeof message.content === "string"
      ? message.content
      : (Array.isArray(message.content) ? message.content : [])
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text)
          .join("\n"),
    toolCallIds: (Array.isArray(message.content) ? message.content : [])
      .filter((block: any) => block.type === "toolCall")
      .map((block: any) => block.id),
    toolCallId: message.toolCallId,
  };
}
