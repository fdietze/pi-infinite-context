# pi-infinite-context

A [pi](https://pi.dev) extension that lets the agent edit its own LLM context.
The agent reversibly **folds** finished or bulky message ranges into compact
stubs and **recovers** them on demand, so a long session stays within the
context window without losing access to earlier detail.

It operates on the *active* context (pi's native compaction already applied),
and a fold is reversible as long as its messages are still part of that context.

## Tools

- `context_map` — orientation: the whole active context in order (id, role,
  estimated tokens, snippet, fold state). No arguments.
- `context_collapse` — fold one or more message ranges into reversible stubs,
  each keeping an optional visible summary.
- `context_expand` — restore a whole fold, or a sub-range (which splits it).
- `context_peek` — read a fold's hidden contents without restoring them.
- `context_search` — find text across live messages, folded messages, and
  summaries.

## Automatic nudge

On each turn the extension checks how full the context is and, when it first
crosses a threshold band at or above 75%, steers a one-off note toward
`context_map` + `context_collapse` — so the agent folds *before* it runs low.

## Install

```bash
pi install git:github.com/fdietze/pi-infinite-context
```

pi bundles the packages the extension imports, so no extra runtime setup is
needed. See [pi packages](https://pi.dev/packages) for install management.

## Develop

Toolchain via the flake dev shell; type libraries via npm:

```bash
nix develop
npm ci
npm run ci   # typecheck (tsgo) + lint (oxlint) + test (node --test)
```

Design rationale lives in [DESIGN.md](DESIGN.md).

## License

[MIT](LICENSE)
