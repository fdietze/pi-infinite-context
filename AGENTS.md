# Repository map

- `README.md`: user-facing purpose, tools, context reminders, installation, and limits.
- `docs/folding.svg`: recursive folding diagram embedded in the README.
- `DESIGN.md`: authoritative fold-tree invariants and public tool semantics.
- `extensions/infinite-context/index.ts`: Pi integration and tool registration.
- `extensions/infinite-context/forest.ts`: pure recursive archive state and transforms.
- `extensions/infinite-context/messages.ts`: session messages, serialization, tool units, and context overlay.
- `extensions/infinite-context/search.ts`: pure archive regex search.
- `extensions/infinite-context/output.ts`: line windows and global output limits.
- `extensions/infinite-context/nudge.ts`: proactive folding threshold policy.
- `extensions/infinite-context/*.test.ts`: unit, property, and integration tests.

Use the pinned dev shell. Run `nix develop -c npm run ci` before committing. Keep Pi I/O in `index.ts`; keep archive logic deterministic and independently testable.
