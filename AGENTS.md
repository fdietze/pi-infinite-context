# Repository map

- `README.md`: user-facing purpose, tools, context reminders, installation, and limits.
- `docs/folding.svg`: recursive folding diagram embedded in the README.
- `DESIGN.md`: authoritative fold-tree invariants and public tool semantics.
- `extensions/infinite-context/index.ts`: Pi integration and tool registration.
- `extensions/infinite-context/forest.ts`: pure recursive archive state and transforms.
- `extensions/infinite-context/originals.ts`: branch entries joined with their live message from Pi's session projection.
- `extensions/infinite-context/serialize-message.ts`: authoritative text projection of one message.
- `extensions/infinite-context/fold-projection.ts`: anchors, fold summary text and live token cost.
- `extensions/infinite-context/tool-units.ts`: live tool-call units, the pending unit, and snapshot ownership validation.
- `extensions/infinite-context/plan-root-ranges.ts`: fold request resolution and tool-unit range expansion.
- `extensions/infinite-context/id-errors.ts`: actionable errors for caller-supplied ids.
- `extensions/infinite-context/overlay.ts`: request-copy context overlay.
- `extensions/infinite-context/search.ts`: pure archive regex search.
- `extensions/infinite-context/output.ts`: line windows and global output limits.
- `extensions/infinite-context/nudge.ts`: proactive folding threshold policy.
- `extensions/infinite-context/*.test.ts`: unit, property, and integration tests.
- `e2e/`: end-to-end test driving the real `pi` binary with a scripted fake provider.

Use the pinned dev shell. Run `nix develop -c npm run ci` before committing, and `nix develop -c npm run e2e` (real `pi` binary, ~1 min) before merging changes to the context overlay. Keep Pi I/O in `index.ts`; keep archive logic deterministic and independently testable.
