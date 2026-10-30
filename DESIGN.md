# Archive model

## Vocabulary

- **Original:** an addressable message on the current Pi session branch; an archive leaf.
- **Fold:** a node with a summary and ordered children, which may be originals or folds.
- **Forest:** the ordered list of trees forming the archive. Its top-level nodes are **roots**.
- **Live:** included in Pi's session projection, before folding is applied. Omitted originals remain archived.

## Data structure

Serialized form ([`forest.ts`](extensions/infinite-context/forest.ts)):

```ts
type Item =
  | { kind: "message"; id: string }
  | { kind: "fold"; id: string; summary: string; children: Item[] };

type Snapshot = { version: 2; roots: Item[] };
```

Original text stays in Pi's session; a leaf stores only its entry ID. The last snapshot on the current branch supplies the forest; originals it does not list become roots at their branch position, and one inside a root's range makes the branch unloadable.

## Algebra

`++` concatenates lists. Folding wraps a nonempty contiguous root range `X` with a fresh ID and summary `s`:

```text
L ++ X ++ R  ->  L ++ [fold(id, s, X)] ++ R
```

Let `leaves` list original IDs in order:

```text
leaves(message(id))   = [id]
leaves(fold(id, s, X)) = leaves(X)
leaves([])            = []
leaves([x] ++ X)      = leaves(x) ++ leaves(X)
```

Revising a summary means `fold(newId, newSummary, [oldFold])`, not changing `oldFold`.

## Invariants

1. Leaves contain every current-branch original exactly once, in branch order.
2. Node IDs are nonempty, unique and stable. Fold IDs do not reuse session-entry IDs.
3. A fold has at least one child. Its summary is a property, not a child, and may be empty. Existing nodes and original messages are never rewritten.
4. A live assistant message containing tool calls and its live results are either all original roots or inside the same root fold. The last live assistant cannot be folded while any of its calls lack live results.
5. In model context, a root fold's summary message replaces its live leaves at the first live leaf. A root without live leaves emits nothing.
6. A batch wraps disjoint ranges atomically: all ranges validate before one complete snapshot is appended. Reads change nothing and never unfold.
7. The current branch is complete: it starts at the session root and contains no native compaction. Otherwise the archive refuses to load instead of guessing.
8. While the branch has saved folds, a request never goes out unfolded unnoticed: if the folds cannot be applied, the first request after loading stops with the reason, and only later requests go out unfolded.
