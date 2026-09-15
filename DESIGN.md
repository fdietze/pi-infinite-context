# infinite-context design

## Goal

Grow a searchable archive while keeping a finite working context. The archive is the sole compactor; reads never permanently restore hidden messages.

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
4. Completed assistant tool calls and all correlated results stay in the same visible root or fold subtree. An unfinished tool-call unit cannot be folded.
5. A mutation appends one complete snapshot only after all validation succeeds. Reads append nothing.

New branch messages are appended as roots when state is derived. Session reload and tree navigation reconstruct from the last snapshot on that current branch. Old span snapshots and branches containing native compaction are rejected with a new-session instruction; there is intentionally no migration layer.

## Operations

- `context_map({id?, offset?, limit?})` lists visible roots, or one fold's direct children. It never recursively dumps a subtree.
- `context_peek({id, offset?, limit?})` reads one original's authoritative text projection or exactly one fold summary. Lines are 1-based; the default limit is 100 and the footer always reports total item lines.
- `context_search({patterns})` searches every raw current-branch original and every reachable fold summary once. Results contain stable IDs, parent-fold location and lookup-compatible line numbers.
- `context_fold({items})` atomically wraps disjoint contiguous visible-root ranges. Each item has an explicit summary, which may be empty. Tool-unit boundaries expand the range when necessary. Existing folds remain unchanged children; summaries are never concatenated.
- `context_summary({id, summary})` replaces only a visible root fold's summary. Hidden summaries are immutable.

There is no unfold operation and no persistent navigation state.

## Context projection

The `context` event overlays a request copy. Live messages pass through unchanged. A visible fold becomes one synthetic user message containing its summary, or a small empty-summary placeholder. Descendants are omitted. Results correlated with a folded assistant call are also omitted, including request-only results not yet persisted when the fold snapshot was made.

The raw session branch is never rewritten, so original typed message objects and image sources remain there. Lookup/search use one text serializer. It labels images rather than claiming their binary data is lossless text, and includes the serializer's existing assistant-thinking/tool-call projections.

Excluded bash entries remain searchable archive leaves but have zero live-context cost and never anchor a synthetic fold message.

## Output safety

Map and search synthesize aggregate output that never lived in context as one unit, so they share a final UTF-8 byte/line cap; previews and search lines are bounded, and search emission is capped and asks the caller to refine the regex. Peek is exempt: it returns exactly one item, which is either an original message that already fit in context once or a schema-bounded fold summary, so it is returned whole and paged only by line offset/limit — a single over-long line is never clipped into an unreachable tail. No tool writes a recursive archive dump to model context.

Token sizes are documented estimates. Fold and summary results report the signed estimated live-context delta, so a large summary may correctly report growth rather than false savings.

## Native compaction

`session_before_compact` cancels `manual`, `threshold`, and `overflow` compaction. The extension does not mutate global or project Pi settings. Proactive 75%/5-point folding nudges remain; their wording states that native recovery is blocked and a real overflow stays visible.

## Structure

- `forest.ts`: snapshot types, parsing, traversal, invariant-preserving transforms.
- `messages.ts`: raw branch conversion, authoritative serialization, tool units, request overlay.
- `search.ts`: pure regex archive search.
- `output.ts`: pagination and global output budgets.
- `nudge.ts`: pure proactive-nudge policy.
- `index.ts`: Pi event/tool shell and persistence.
- `*.test.ts`: property, unit and public integration tests.

The split follows a functional-core/imperative-shell boundary and keeps persistence and Pi APIs out of the archive transforms.
