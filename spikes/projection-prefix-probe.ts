// Run: pi -p --no-session -ne -e spikes/projection-prefix-probe.ts --model fake/scripted go
// Expect every {request} line to report prefixOk: true.
// Deterministic smoke test with a scripted fake provider: retries of abandoned
// attempts (incl. a partial tool call), parallel tools, steers, follow-up.
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const out = "process.env.PROBE_OUT ?? "/tmp/projection-prefix-probe.jsonl"";
const log = (x: unknown) => appendFileSync(out, JSON.stringify(x) + "\n");
const tag = (m: any) => `${m.role}${m.customType ? ":" + m.customType : ""}`;

type Step = { error?: string; text?: string; calls?: string[] };
const script: Step[] = [
  { text: "starting", error: "529 overloaded_error: Overloaded" },          // abandoned attempt
  { calls: ["echo a", "echo b"] },                                          // parallel tools
  { text: "partial", calls: ["echo never"], error: "529 overloaded_error: Overloaded" }, // abandoned attempt with a tool call
  { calls: ["echo c"] },
  { text: "DONE" },
  { text: "FOLLOWUP" },
];

export default function (pi: any) {
  let call = 0, request = 0, steeredMidTool = false, turnSteers = 0, followedUp = false;
  pi.registerProvider("fake", {
    baseUrl: "http://127.0.0.1:9", apiKey: "x", api: "fake-api",
    models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model: any, context: any) {
      const step = script[Math.min(call, script.length - 1)];
      const n = ++call;
      log({ providerCall: n, transcript: context.messages.map(tag).join(" ") });
      const stream = createAssistantMessageEventStream();
      const output: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "pending", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        if (step.text) output.content.push({ type: "text", text: step.text });
        for (const [i, command] of (step.calls ?? []).entries())
          output.content.push({ type: "toolCall", id: `call_${n}_${i}`, name: "bash", arguments: { command } });
        if (step.error) {
          output.stopReason = "error"; output.errorMessage = step.error;
          stream.push({ type: "error", reason: "error", error: output });
        } else {
          output.stopReason = step.calls ? "toolUse" : "stop";
          stream.push({ type: "done", reason: output.stopReason, message: output });
        }
        stream.end();
      });
      return stream;
    },
  });
  pi.on("context", (event: any, ctx: any) => {
    const projected = ctx.sessionManager.buildSessionProjection().messages.filter((m: any) => m.role !== "system");
    const events = event.messages;
    let firstMismatch = -1;
    for (let i = 0; i < projected.length; i++)
      if (!isDeepStrictEqual(projected[i], events[i])) { firstMismatch = i; break; }
    const edits = ctx.sessionManager.getBranch().filter((e: any) => e.type === "context_edit").length;
    log({ request: ++request, projected: projected.length, event: events.length,
      prefixOk: firstMismatch === -1 && projected.length <= events.length,
      firstMismatch: firstMismatch === -1 ? null : { i: firstMismatch, projected: tag(projected[firstMismatch]), event: events[firstMismatch] && tag(events[firstMismatch]) },
      tail: events.slice(projected.length).map(tag), edits, roles: events.map(tag).join(" ") });
  });
  pi.on("tool_execution_end", () => {
    if (steeredMidTool) return;
    steeredMidTool = true;
    pi.sendMessage({ customType: "midtool-steer", content: "(steer)", display: false }, { deliverAs: "steer" });
  });
  pi.on("turn_end", (event: any) => {
    log({ turn_end: event.outcome, toolResults: event.toolResults.length });
    if (turnSteers >= 2 || event.toolResults.length === 0) return;
    turnSteers++;
    pi.sendMessage({ customType: "nudge", content: "(nudge)", display: true }, { deliverAs: "steer" });
  });
  pi.on("agent_end", (_e: any, ctx: any) => {
    const branch = ctx.sessionManager.getBranch();
    log({ agent_end: branch.map((e: any) => e.type === "message" ? tag(e.message) : e.type === "context_edit" ? `EDIT(${e.targetId})` : e.type).join(" ") });
    if (followedUp) return;
    followedUp = true;
    pi.sendMessage({ customType: "followup", content: "follow up", display: true }, { deliverAs: "followUp", triggerTurn: true });
  });
}
