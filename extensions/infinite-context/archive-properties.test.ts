// Property tests against real Pi sessions: random branches (abandoned calls,
// context edits, excluded bash, a running turn) and random fold sequences.
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import fc from "fast-check";
import {
  INFINITE_CONTEXT_ENTRY,
  type Forest,
  messageItem,
  originalIds,
  parseSnapshot,
  snapshot,
  syncOriginals,
  wrapRootRanges,
} from "./forest.ts";
import { branchOriginals, type OriginalMessage, projectedPositions } from "./originals.ts";
import { buildOverlay } from "./overlay.ts";
import { planRootRanges } from "./plan-root-ranges.ts";
import { assistantMessage, toolResultMessage, userMessage } from "./pi-test-fixtures.ts";
import { toolUnits, validateToolUnitOwnership } from "./tool-units.ts";

type Step =
  | { kind: "user" }
  | { kind: "custom" }
  | { kind: "bash"; excluded: boolean }
  | { kind: "assistant"; calls: number; answered: boolean[] }
  | { kind: "omit"; target: number }
  | { kind: "replace"; target: number };

const step = fc.oneof(
  fc.constant<Step>({ kind: "user" }),
  fc.constant<Step>({ kind: "custom" }),
  fc.record({ kind: fc.constant<"bash">("bash"), excluded: fc.boolean() }),
  fc.record({
    kind: fc.constant<"assistant">("assistant"),
    calls: fc.integer({ min: 0, max: 3 }),
    answered: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  }),
  fc.record({ kind: fc.constant<"omit">("omit"), target: fc.nat() }),
  fc.record({ kind: fc.constant<"replace">("replace"), target: fc.nat() }),
);

/** Build one real session; `pendingTail` leaves the last assistant's call unanswered. */
function buildSession(steps: readonly Step[], pendingTail: boolean): SessionManager {
  const sm = SessionManager.inMemory("/tmp");
  const append = (message: unknown) =>
    sm.appendMessage(message as Parameters<typeof sm.appendMessage>[0]);
  const editable: string[] = [];
  let clock = 0;
  let calls = 0;
  for (const current of steps) {
    clock += 1;
    switch (current.kind) {
      case "user":
        editable.push(append(userMessage(`user ${clock}`, clock)));
        break;
      case "custom":
        editable.push(sm.appendCustomMessageEntry("nudge", `nudge ${clock}`, true));
        break;
      case "bash":
        append({
          role: "bashExecution",
          command: `echo ${clock}`,
          output: `out ${clock}`,
          exitCode: 0,
          cancelled: false,
          truncated: false,
          excludeFromContext: current.excluded,
          timestamp: clock,
        });
        break;
      case "assistant": {
        const ids = Array.from({ length: current.calls }, () => `call-${++calls}`);
        const content = [
          { type: "text" as const, text: `step ${clock}` },
          ...ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { id } })),
        ];
        editable.push(append(assistantMessage(content, clock)));
        ids.forEach((id, i) => {
          if (current.answered[i])
            editable.push(append(toolResultMessage(id, `result ${id}`, ++clock)));
        });
        break;
      }
      case "omit":
      case "replace": {
        if (editable.length === 0) break;
        const target = editable[current.target % editable.length];
        sm.appendContextEdit(
          target,
          current.kind === "omit" ? null : { content: [{ type: "text", text: "(edited)" }] },
        );
        break;
      }
    }
  }
  if (pendingTail) {
    append(
      assistantMessage(
        [{ type: "toolCall", id: `call-${++calls}`, name: "read", arguments: {} }],
        ++clock,
      ),
    );
  }
  return sm;
}

interface State {
  readonly originals: OriginalMessage[];
  readonly positions: ReturnType<typeof projectedPositions>;
  readonly request: AgentMessage[];
}

function read(sm: SessionManager): State {
  const projection = sm.buildSessionProjection();
  return {
    originals: branchOriginals(sm.getBranch(), projection),
    positions: projectedPositions(projection),
    request: projection.messages.filter((message) => message.role !== "system"),
  };
}

const flatRoots = (originals: readonly OriginalMessage[]): Forest =>
  originals.map(({ id }) => messageItem(id));

const callIdsOf = (message: AgentMessage): string[] =>
  message.role === "assistant" && Array.isArray(message.content)
    ? message.content.flatMap((block) =>
        block.type === "toolCall" && typeof block.id === "string" ? [block.id] : [],
      )
    : [];

const resultIdsOf = (messages: readonly AgentMessage[]): string[] =>
  messages.flatMap((message) =>
    message.role === "toolResult" && message.toolCallId ? [message.toolCallId] : [],
  );

/** The overlay may drop whole tool units, but must never orphan what Pi sent it. */
function assertProviderValid(input: readonly AgentMessage[], output: readonly AgentMessage[]) {
  const inputCalls = new Set(input.flatMap(callIdsOf));
  const outputCalls = new Set(output.flatMap(callIdsOf));
  const inputResults = resultIdsOf(input);
  const outputResults = resultIdsOf(output);
  assert.equal(new Set(outputResults).size, outputResults.length, "duplicated tool result");
  for (const id of outputResults) {
    assert.ok(inputResults.includes(id), "overlay invented a tool result");
    assert.ok(!inputCalls.has(id) || outputCalls.has(id), "kept a result whose call was dropped");
  }
  for (const id of outputCalls)
    assert.ok(
      !inputResults.includes(id) || outputResults.includes(id),
      "kept a call whose result was dropped",
    );
}

/** Root index range covered by the pending unit, if the branch has one. */
function pendingRoots(
  roots: Forest,
  originals: readonly OriginalMessage[],
): { first: number; last: number } | undefined {
  const units = toolUnits(originals);
  if (units.pendingOwner === undefined) return undefined;
  const rootOf = new Map<string, number>();
  for (let i = 0; i < roots.length; ++i)
    for (const id of originalIds([roots[i]])) rootOf.set(id, i);
  return {
    first: rootOf.get(originals[units.pendingOwner].id)!,
    last: rootOf.get(originals[units.end[units.pendingOwner]].id)!,
  };
}

/**
 * The request after another extension's `context` handler ran first and
 * inserted a synthetic result after every call that lacks one.
 */
function repairAbandonedCalls(request: readonly AgentMessage[]): AgentMessage[] {
  const answered = new Set(resultIdsOf(request));
  return request.flatMap((message) => [
    message,
    ...callIdsOf(message)
      .filter((id) => !answered.has(id))
      .map((id) => toolResultMessage(id, "(no result)", message.timestamp)),
  ]);
}

function assertInvariants(roots: Forest, state: State) {
  // P4: leaves are exactly the raw originals, in branch order.
  assert.deepEqual(originalIds(roots), state.originals.map(({ id }) => id));
  validateToolUnitOwnership(roots, state.originals);
  for (const request of [state.request, repairAbandonedCalls(state.request)])
    assertProviderValid(
      request,
      buildOverlay(request, state.positions, state.originals, roots),
    );

  // P3: every contiguous range clear of the pending unit is foldable.
  const pending = pendingRoots(roots, state.originals);
  for (let first = 0; first < roots.length; ++first)
    for (let last = first; last < roots.length; ++last) {
      if (pending && first <= pending.last && pending.first <= last) continue;
      assert.doesNotThrow(
        () =>
          planRootRanges(roots, state.originals, [
            { from: roots[first].id, to: roots[last].id, summary: "" },
          ]),
        `range ${first}..${last} is not foldable`,
      );
    }
}

/** P6: a rejection must name something the caller sent, so it can be acted on. */
function assertActionable(message: string, ids: readonly string[], items: number) {
  const namesId = ids.some((id) => message.includes(id));
  const namesItem = Array.from({ length: items }, (_, i) => `Item ${i + 1}`).some((label) =>
    message.includes(label),
  );
  assert.ok(namesId || namesItem || /Items \d+ and \d+/.test(message), `unactionable: ${message}`);
}

test("folding a real session keeps the archive and the request consistent", () => {
  fc.assert(
    fc.property(
      fc.array(step, { minLength: 1, maxLength: 12 }),
      fc.boolean(),
      fc.array(
        fc.record({
          from: fc.nat(),
          span: fc.integer({ min: 0, max: 3 }),
          second: fc.option(fc.record({ from: fc.nat(), span: fc.integer({ min: 0, max: 3 }) }), {
            nil: undefined,
          }),
          summary: fc.oneof(fc.constant(""), fc.string({ maxLength: 40 })),
        }),
        { maxLength: 8 },
      ),
      (steps, pendingTail, ops) => {
        const sm = buildSession(steps, pendingTail);
        let state = read(sm);
        let roots = flatRoots(state.originals);
        // P1: without folds the overlay hands back exactly what Pi sent.
        assert.deepEqual(
          buildOverlay(state.request, state.positions, state.originals, roots),
          state.request,
        );
        const repaired = repairAbandonedCalls(state.request);
        assert.deepEqual(
          buildOverlay(repaired, state.positions, state.originals, roots),
          repaired,
        );
        assertInvariants(roots, state);

        let created = 0;
        for (const op of ops) {
          if (roots.length === 0) break;
          const range = (from: number, span: number) => {
            const first = from % roots.length;
            return {
              from: roots[first].id,
              to: roots[Math.min(first + span, roots.length - 1)].id,
              summary: op.summary,
            };
          };
          const requests = [range(op.from, op.span)];
          if (op.second) requests.push(range(op.second.from, op.second.span));
          let planned: ReturnType<typeof planRootRanges>;
          try {
            planned = planRootRanges(roots, state.originals, requests);
          } catch (error) {
            assertActionable(
              (error as Error).message,
              requests.flatMap((request) => [request.from, request.to!]),
              requests.length,
            );
            // Keep building folds: retry the same start clipped before the pending unit.
            const pending = pendingRoots(roots, state.originals);
            if (!pending || pending.first === 0) continue;
            const first = Math.min(op.from % roots.length, pending.first - 1);
            planned = planRootRanges(roots, state.originals, [
              {
                from: roots[first].id,
                to: roots[Math.min(first + op.span, pending.first - 1)].id,
                summary: op.summary,
              },
            ]);
          }
          try {
            roots = wrapRootRanges(
              roots,
              planned.map((plan) => ({ ...plan, id: `fold-${++created}` })),
            );
          } catch (error) {
            assertActionable((error as Error).message, [], requests.length);
            continue;
          }
          assertInvariants(roots, state);
        }

        // P5: the snapshot reloads to exactly the in-memory state.
        sm.appendCustomEntry(INFINITE_CONTEXT_ENTRY, JSON.parse(JSON.stringify(snapshot(roots))));
        const reloaded = read(sm);
        const saved = sm
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === INFINITE_CONTEXT_ENTRY)
          .at(-1)!;
        const parsed = syncOriginals(
          parseSnapshot((saved as { data: unknown }).data).roots,
          reloaded.originals.map(({ id }) => id),
        );
        assert.deepEqual(parsed, roots);

        // Omitting an already-archived original must not break the state.
        // Pi only accepts edits on entries that contribute editable content.
        const archived = state.originals.find(
          ({ live, message }) => live !== undefined && message.role !== "bashExecution",
        );
        if (archived) {
          sm.appendContextEdit(archived.id, null);
          state = read(sm);
          const synced = syncOriginals(roots, state.originals.map(({ id }) => id));
          assertInvariants(synced, state);
        }
      },
    ),
    { numRuns: 100 },
  );
});
