# pi-infinite-context

A [Pi](https://pi.dev/) extension for long-lived sessions. It keeps an ordered, searchable archive inside the current session while the model sees only a finite working context.

The agent can:

- recursively fold contiguous visible context roots into a summarized parent;
- navigate roots and direct fold children;
- search every current-branch message and fold summary;
- read archived text without permanently restoring it; and
- replace the summary of a visible root fold.

Folding never changes the original session messages. Native Pi compaction is blocked so the fold tree remains the only compactor. If the provider still overflows, the error remains visible rather than silently replacing history with native compaction.

## Install

```bash
pi install git:github.com/fdietze/pi-infinite-context
```

Start a new session after installing this v2 architecture. Old extension snapshots and sessions that already contain native compaction are deliberately unsupported.

## Development

```bash
nix develop -c npm ci
nix develop -c npm run ci
```

See [DESIGN.md](DESIGN.md) for invariants and tool semantics.

## License

[MIT](LICENSE)
