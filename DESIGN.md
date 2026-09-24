# infinite-context design

## Goal

Grow a searchable archive while keeping a finite working context. The archive is the sole compactor; reads never permanently restore hidden messages.

## Vocabulary

- **original**: one addressable raw entry on the current session branch; it is an archive leaf and is never rewritten.
- **root**: a top-level item of the fold forest — what `context_map` lists.
- **live**: the message as the model receives it, taken from Pi's session projection. It is undefined when Pi omits the entry: a `context_edit` omission (retry recovery) or a `bashExecution` excluded from context. Liveness alone drives token cost, tool units and anchoring.
- **anchor**: the first live member of a root; the position where a fold's summary appears in the request.
- **pending unit**: the last live assistant of the branch when some of its calls still lack a live result — the turn that is currently executing.

## State

The last `infinite-context` custom entry on the current raw session branch is the authoritative cumulative snapshot:

```ts
type Item =
  | { readonly kind: "message"; readonly id: string }
  | {
      readonly kind: "fold";
      readonly id: string;
      readonly summary: string;
      readonly children: readonly Item[];
    };

interface Snapshot {
  readonly version: 2;
  readonly roots: readonly Item[];
}
```

The invariants are:

1. Leaves contain every addressable original on the current branch exactly once and in branch order.
2. Node IDs are globally unique. Fold IDs do not reuse Pi session-entry IDs.
3. A fold has at least one child. Its summary is a projection of that node, not another child.
4. A live assistant tool call and its live results stay in the same root or fold subtree. Tool units have live members only, so an omitted entry between a call and its result belongs to no unit. The pending unit cannot be folded; every other range can, including abandoned calls whose results never arrived.
5. A mutation appends one complete snapshot only after all validation succeeds. Reads append nothing.

New branch messages are appended as roots when state is derived. Session reload and tree navigation reconstruct from the last snapshot on that current branch. Old span snapshots and branches containing native compaction are rejected with a new-session instruction; there is intentionally no migration layer.

## Operations

- `context_map({id?, offset?, limit?})` lists roots, or one fold's direct children. Roots Pi omits from the model context are listed as `not live · 0 tokens`. It never recursively dumps a subtree.
- `context_peek({id, offset?, limit?})` reads one original's authoritative text projection or exactly one fold summary. Lines are 1-based; the default limit is 100 and the footer always reports total item lines.
- `context_search({patterns})` searches every raw current-branch original and every reachable fold summary once. Results contain stable IDs, parent-fold location and lookup-compatible line numbers.
- `context_fold({items})` atomically wraps disjoint contiguous root ranges. Each item has an explicit summary, which may be empty. Tool-unit boundaries expand the range when necessary. Existing folds remain unchanged children; summaries are never concatenated.
- `context_summary({id, summary})` replaces only a root fold's summary. Hidden summaries are immutable.

Every rejection names the id, item number or pattern the caller supplied together with the next step (call `context_map`, fold the containing root, combine overlapping items, or wait for the pending unit).

There is no unfold operation and no persistent navigation state.

## Context projection

Pi builds each request from its session projection (`buildSessionProjection()`, `context_edit` applied) and appends whatever is not persisted yet, so the projection minus system messages is a deep-equal prefix of the `context` event messages. That prefix gives every request position its owning entry id — no timestamp or content matching is needed.

The overlay walks the request: a fold emits one synthetic user message at its anchor, containing its summary or a small empty-summary placeholder; its other members are dropped; a fold without a live member emits nothing; everything else, including the unpersisted tail, passes through unchanged. If the request does not start with the projection, the extension notifies an error and returns the request untouched rather than risking a dropped tool result.

The raw session branch is never rewritten, so original typed message objects and image sources remain there. Lookup/search use one text serializer. It labels images rather than claiming their binary data is lossless text, and includes the serializer's existing assistant-thinking/tool-call projections.

Originals Pi omits from the model context stay searchable archive leaves with zero live cost, and never anchor a fold.

## Output safety

Map and search synthesize aggregate output that never lived in context as one unit, so they share a final UTF-8 byte/line cap; previews and search lines are bounded, and search emission is capped and asks the caller to refine the regex. Peek is exempt: it returns exactly one item, which is either an original message that already fit in context once or a schema-bounded fold summary, so it is returned whole and paged only by line offset/limit — a single over-long line is never clipped into an unreachable tail. No tool writes a recursive archive dump to model context.

Token sizes are documented estimates. Fold and summary results report the signed estimated live-context delta, so a large summary may correctly report growth rather than false savings.

## Native compaction

`session_before_compact` cancels `manual`, `threshold`, and `overflow` compaction. The extension does not mutate global or project Pi settings. Proactive 75%/5-point folding nudges remain; their wording states that native recovery is blocked and a real overflow stays visible.

## Structure

- `forest.ts`: snapshot types, parsing, traversal, invariant-preserving transforms.
- `originals.ts`: raw branch entries joined with their live message.
- `serialize-message.ts`: authoritative text projection of one message.
- `fold-projection.ts`: anchors, fold summary text, live token cost.
- `tool-units.ts`: live tool units, the pending unit, snapshot ownership validation.
- `plan-root-ranges.ts`: fold request resolution and tool-unit expansion.
- `overlay.ts`: the request overlay.
- `id-errors.ts`: actionable errors for caller-supplied ids.
- `search.ts`: pure regex archive search.
- `output.ts`: pagination and global output budgets.
- `nudge.ts`: pure proactive-nudge policy.
- `index.ts`: Pi event/tool shell and persistence.
- `*.test.ts`: property, unit and public integration tests.
- `e2e/`: the real `pi` binary with a scripted provider (`npm run e2e`), asserting what the provider finally receives.

The split follows a functional-core/imperative-shell boundary and keeps persistence and Pi APIs out of the archive transforms.
