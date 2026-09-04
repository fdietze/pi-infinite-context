# infinite-context — Design

Design for the revision of the `infinite-context` pi extension. The extension lets
the agent edit its own LLM context: fold finished or bulky message
ranges into reversible stubs, and recover them (unfold / peek / search). This
revision makes the tool surface self-explanatory, gives the agent a single
orientation call over the whole context, makes every tool uniformly batched
(no union / overloaded params), and makes the reported token numbers correct
and reconciling.

Source lives under `extensions/infinite-context/`: `index.ts` (imperative
shell), `core.ts` (functional core), `core.test.ts` (node:test).

## Goal

Five crystal-clear, single-purpose tools the agent can reason about at a glance,
a whole-context "map" to plan batch folds from, and result numbers it can
trust and cross-check.

## Initial constraints

- Tools: `fold`, `unfold`, `peek`, `search`.
- `peek` is overloaded: no arg -> fold overview; `id` -> one fold's members.
- Batching is inconsistent: `fold`/`unfold` take `items: [...]`; `peek`
  takes an optional single `id`; `search` takes a single `query`.
- All prompt encouragement sits on `fold` (its `promptSnippet` + 5
  `promptGuidelines`). `peek`/`search`/`unfold` carry only a `description`.
  Search is mentioned only indirectly, inside fold's recovery guideline.
- Reported-number bugs (all confirmed in code):
  - **A — `ctx %` lags the action.** `getContextUsage().tokens` is derived from
    the last assistant `usage` (`calculateContextTokens` in `agent-session.js`).
    Within a turn, a just-made fold only takes effect on the next `context`
    build, so `ctx %` is unchanged while `freed` is a prediction. They do not
    reconcile until the next LLM response.
  - **B — asymmetric definitions.** `fold.freedTokens` is *net*
    (`Σ(live − stub)`, excludes already-folded members); `unfold.restoredTokens`
    is *gross* (`Σ member tokens`, ignores the removed stub and remnant stubs).
    Folding then unfolding the same range reports different magnitudes.
  - **C — negative freed + double sign.** When a stub (esp. with a long summary)
    is >= the hidden content, `freedTokens <= 0`; the head prints "freed -120"
    and `pctOf(neg, win, "−")` yields a literal double minus "(−-0.3%)".

## Changes

### 1. Taxonomy — 5 tools, `context_` prefix, one purpose each

`context_map`, `context_peek`, `context_search`, `context_fold`,
`context_unfold`.

Rationale: tool names as a semantic index (self-explanatory subsystem); SRP;
a discoverable verb menu the model sees at a glance (serves the orientation
goal). **Rejected:** a single merged `context` tool with an `op` enum — it saves
only the per-tool envelope (~100–150 tokens total) because the descriptive
payload is conserved, while it makes illegal states representable (`op=map` with
a `summary` field), worsens inference reliability (provider tool-choice is tuned
for one tool = one param shape), and hides the ops. The real token lever is
deduping the shared preamble (change 4), not merging.

### 2. `context_map` — the orientation call (no args)

Lists the entire current context in conversation order:

- live message -> `[#id] role · <tokens> · <~60-char snippet>`
- fold -> `[#id] ⊟ <n> msgs · <hidden> hidden · <summary>`

Header: `folds: N · Xk hidden · ctx <fill>`.

Replaces peek's former no-arg overview. The model takes one `context_map`, spots
the fat or finished chunks, then batches several ranges into one
`context_fold`. Backed by a pure core fn `buildContextMap(msgs, spans)`
(tested); `index.ts` wires it. It complements, not duplicates, `context_search`:
map = orientation without prior knowledge; search = grep by regex.

### 3. Uniform batching — no union / overloaded params

Every read/write tool takes an array; no optional-single or overloaded params.

- `context_peek`: `ids: string[]` — fold-stub or inner-member ids; prints each
  resolved fold's members; folds deduped. The former no-arg mode is gone
  (-> `context_map`).
- `context_search`: `patterns: string[]` — each regex returns its own hit group.
- `context_fold` / `context_unfold`: keep `items: [...]`.

Rationale: consistency, "always batch", make illegal states unrepresentable.

### 4. Dedup the shared preamble

Move the marker mechanics, the fold model, the `map -> search -> peek -> unfold`
recovery flow, and "never write markers yourself" into ONE `promptGuidelines`
block; slim each tool `description` down to its own action. Cuts the fixed
per-call token cost (the actual lever, since guideline text is paid on every
call). Second-order thinking: prompt tokens are a permanent recurring cost.

### 5. Unified, reconciling numbers (fix A / B / C)

Both mutators compute `Δlive` — the net change to live-context tokens — with the
same formula:

- fold: `Δlive = stub_new − Σ(newly hidden live members)` (excludes
  already-folded members) -> negative = freed.
- unfold: `Δlive = Σ(restored members) − stub_removed + Σ(remnant stubs)` ->
  positive = added.

Rendering:

- Head: `freed |Δlive|` (fold) / `restored |Δlive|` (unfold). Sign derived
  from the value, so no double minus (fixes C).
- Guard: fold with `Δlive >= 0` -> "no net saving (stub/summary >= hidden
  content)" instead of a misleading "freed -N" (fixes C).
- ctx line projected: `→ ctx ~37% (last 40%)` from
  `clamp0(last_tokens + Δlive) / window`; omitted when last usage is unknown.
  Honest that the measured usage lags, and reconciles by construction:
  `before − freed = projected` (fixes A). Symmetric definition fixes B.

### 6. Drop live-message prefixes (ids come from the map)

Live messages are no longer prefixed with an inline `[#id token]` marker. Only a
fold's own stub keeps an inline `[#id]`, as the handle to unfold that exact fold.
The model reads live-message ids from `context_map` (id + role + tokens + snippet
+ fold state) and from `context_search`/`context_peek`.

Rationale: per-message prefixing served two jobs — id source and inline size
hint — that `context_map` already covers, so it added no capability. It cost two
things: ~85% first-token imitation (the model echoed `[#id]` into its own
output, needing a strip-on-output defense) and marker tokens on every message on
every call. Dropping it deletes the whole imitation-defense machinery
(`stripLeadingMarkers`, the `LEADING_FAKE_MARKERS` regex, the `message_end`
handler, `tag`, `sizedMarker`) and keeps live messages byte-identical across
calls, so the provider's native prefix cache is never perturbed by the overlay.
**Cost:** the first fold in a session now needs a preceding `context_map`
call to learn ids (the intended orient-then-fold flow anyway), and id
selection is by map snippet+role+position rather than an inline anchor.

Revision 2 extended this to fold stubs (initially kept as the handle to "unfold
what I just saw"): that rationale weakened once map-first became the mandated
flow and `context_fold`'s own result printed the fold ids anyway, so the
stub marker bought one saved tool call in a rare case at the price of tokens per
fold per request, a residual imitation surface, and an exception to the uniform
rule. Now NOTHING in the overlay carries an inline id: ids exist only in tool
results (map/search/peek/fold).

## Prompt text

See `index.ts` for the authoritative strings. Division of labour: each tool
`description` states only that tool's own effect and mechanics; the four shared
`promptGuidelines` on `context_fold` carry the policy (when to fold on
your own, what to keep live, what a summary contains, and the
map → fold → search → peek → unfold flow). Parameter descriptions state
only argument semantics, including where ids come from.

## Revision 2 — accuracy of the agent's mental model

The descriptions above were true only before pi's native compaction and only for
valid input. This revision makes the implementation match what the tools claim.

### 7. Describe the ACTIVE context, not the raw branch

Every tool read `getBranch()`, which keeps pre-compaction history. After pi
compacts, that made the map list messages the model no longer sees, hide the
active compaction summary, report phantom savings, and offer folds that
`context_unfold` could never restore — i.e. "current context", "whole
conversation" and unconditional reversibility were false.

Fix: tools read `sessionManager.buildContextEntries()` (compaction applied) and
`branchMessages` mirrors pi's `sessionEntryToContextMessages`, so compaction and
branch summaries, custom messages and bash executions are addressable rows.
`reconcileSpans` lazily drops span members that compaction removed, persisting
only on change. The persisted span list is still reconstructed from
`getBranch()`, because its custom entries can predate the compaction cut.

Map Is Not The Territory: the map now describes the territory the model is
actually in.

### 8. Exact-as-possible token numbers

Exact per-message counts are not obtainable: providers report only whole-request
totals after the fact and expose no portable tokenizer; pi itself plans
compaction from this same estimate plus the last assistant usage. So the ceiling
is *agreeing with pi*: `estimateTokens` now mirrors pi's `estimateTokens`
byte-for-byte (per-role chars/4, images at the flat `ESTIMATED_IMAGE_CHARS =
4800`, bash command+output, summary text). `stubTokens` measures exactly the
stub text the overlay emits, so a fold's net saving is not overstated.
Descriptions now say "estimated".

### 9. Reject cross-fold unfold ranges

`context_unfold` clamped a `to` belonging to another fold, silently restoring
something else. Design by Contract: an item whose `to` is not a member of
`from`'s fold is now rejected and reported (`invalid`), never guessed at.

### 10. Prompt surface: policy once, mechanics per tool

The same policy was repeated across snippet, descriptions, parameter
descriptions and five guidelines. Since live messages no longer carry inline
ids, the whole "never invent `[#id]` markers" defense is dropped. Five
guidelines were reduced to four (DRY), keeping concrete triggers and examples for
weaker models, and the categorical "maintain context at every phase boundary"
becomes conditional on an actual saving.

## Implementation mapping

- **core.ts**: add `buildContextMap(msgs, spans)` (pure, returns ordered rows for
  live msgs + folds). Change `planUnfold` to return net `restoredTokens`
  (`Δlive`) alongside `restoredMsgs`. Keep `planFold.freedTokens` (already
  net); expose it unchanged. `searchMessages`/`serializeSpan` already return
  array-friendly data for batched callers.
- **index.ts**: rename the five tools; add `context_map`; `context_peek` takes
  `ids: string[]`, `context_search` takes `patterns: string[]`; number rendering
  (`|Δ|`, projected ctx, non-saving guard, value-derived sign); move the shared
  preamble into the consolidated `promptGuidelines`.
- **core.test.ts**: update unfold assertions to the net `restoredTokens`
  semantics; add a `buildContextMap` test; add batched `peek(ids)` /
  `search(patterns)` shape tests.

## Verification

`nix develop -c npm ci` followed by `nix develop -c npm run ci` must stay
green; the latter runs tsgo, oxlint, and node --test with the flake's pinned
toolchain.

## Context-fill nudge (turn_end)

Beyond the tools, the extension steers the agent to fold *before* it runs out.
On each `turn_end` it reads `getContextUsage()` fill (tokens/contextWindow) and,
when the fill first crosses a 5-point band at or above 75% (75, 80, 85, ...),
injects one `<context-maintenance>` note via `pi.sendMessage(..., { deliverAs:
"steer" })` pointing at `context_map` + `context_fold`. It steers only on a
continuing turn (`stopReason === "toolUse"` with tool results) so the note lands
before the model's next step, not while idle at the prompt.

Minimal by design (KISS, YAGNI): one note text, one crossing per band, in-memory
band state (no persistence — worst case after a reload is one extra nudge), no
growth tracking and no escalation levels. Dropping below 75% re-arms the ladder,
so a fold that lowers fill lets it nudge again on a later climb. The only bit of
stateful logic is the pure `planNudge` in `core.ts`, tested in `core.test.ts`.

## Out of scope

- Auto-compaction behavior (we adapt to it; we do not change it).
- Persistence format (the `infinite-context` span entry stays as-is).
- Restoring content that pi's native compaction already discarded: folds are
  reversible only while their members are part of the active context.
