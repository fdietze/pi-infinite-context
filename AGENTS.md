# Documentation

Use simple, accurate English and keep both documents very concise.

- `README.md`: only a short purpose description, installation, the diagram with a short explanation below it, tools, context reminders, and measured prefix-cache behavior, in that order.
- `DESIGN.md`: only vocabulary, data structure, algebra, and invariants. Check the model against the code.

# Repository map

- `README.md`: purpose, installation, folding diagram, tools, context reminders, and prefix caching.
- `docs/publishing.md`: CI release semantics and one-time npm Trusted Publisher setup.
- `.github/workflows/ci.yml`: checks and serialized OIDC publishing on pushes to `main`.
- `scripts/publish.ts`: CI-only versioning, tarball integrity checks and release-tag selection.
- `scripts/*.test.ts`: release-policy and real package-content checks.
- `package.json` → `files`, `extensions/infinite-context/.npmignore`: published files and test exclusions.
- `docs/folding.svg`: recursive folding diagram embedded in the README.
- `DESIGN.md`: archive vocabulary, data structure, fold algebra, and invariants.
- `extensions/infinite-context/index.ts`: Pi integration and tool registration.
- `extensions/infinite-context/forest.ts`: pure recursive archive state and transforms.
- `extensions/infinite-context/assert-supported-branch.ts`: rejects branches cut off by a corrupted session file or containing native compaction.
- `extensions/infinite-context/originals.ts`: branch entries joined with their live message from Pi's session projection.
- `extensions/infinite-context/serialize-message.ts`: authoritative text projection of one message.
- `extensions/infinite-context/preview-message.ts`: compact preview projection of one message for map lines.
- `extensions/infinite-context/render-map.ts`: complete `context_map` listing that fits the output budget.
- `extensions/infinite-context/fold-projection.ts`: anchors, fold summary text and live token cost.
- `extensions/infinite-context/tool-units.ts`: live tool-call units, the pending unit, and snapshot ownership validation.
- `extensions/infinite-context/plan-root-ranges.ts`: fold request resolution and tool-unit range expansion.
- `extensions/infinite-context/id-errors.ts`: actionable errors for caller-supplied ids.
- `extensions/infinite-context/overlay.ts`: request-copy context overlay.
- `extensions/infinite-context/fold-hint.ts`: the cost-aware fold hint of a reminder and the `fold_timing` system-prompt section.
- `extensions/infinite-context/search.ts`: pure archive regex search.
- `extensions/infinite-context/output.ts`: line windows, token formatting, and global output limits.
- `extensions/infinite-context/nudge.ts`: proactive folding threshold and reminder-step policy, per model.
- `extensions/infinite-context/settings.ts`: parser for `<agent dir>/infinite-context/settings.json` (nudge limits, per-model reminder rules, cache prices and fold-hint mode), the per-branch limit (fixed or drawn from a range), and the session entry that records it.
- `extensions/infinite-context/*.test.ts`: unit, property, and integration tests.
- `e2e/`: end-to-end test driving the real `pi` binary with a scripted fake provider.

Use the pinned dev shell. Run `nix develop -c npm run ci` before committing, and `nix develop -c npm run e2e` (real `pi` binary, ~1 min) before merging changes to the context overlay. Keep Pi I/O in `index.ts`; keep archive logic deterministic and independently testable.
