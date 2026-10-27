# pi-infinite-context

A [Pi](https://pi.dev/) extension for long-running sessions. The agent replaces old work in its context with short summaries. The original messages stay saved and searchable.

## Install

```bash
pi install npm:pi-infinite-context
```

Start a new session after installing.

## How it works

![On the left, the model sees a message, Summary B, and another message from top to bottom. Summary B represents Fold B in the archive on the right. Each fold has its summary in the header and ordered children below. Fold B contains an original message, Fold A, and another original message. Fold A contains two original messages.](docs/folding.svg)

A **fold** groups messages under a summary. The model sees the summary instead of those messages; the originals stay in the archive. Folds can contain earlier folds, as Fold B contains Fold A above. The agent can search and read the archive without unfolding it. Pi's chat history stays unchanged.

## Tools

| Tool | What it does |
| --- | --- |
| `context_fold` | Groups consecutive messages or folds under a new summary. |
| `context_map` | Lists top-level messages and folds, or the direct contents of one fold. |
| `context_search` | Searches original messages and fold summaries using regular expressions. |
| `context_peek` | Reads one original message or fold summary by ID, with an optional line range. |

Map and search results provide the IDs to read next.

## Context reminders

When Pi estimates that context holds at least **150k tokens or 75% of the model's window** (whichever comes first), the extension reminds the agent during tool work to fold completed work while keeping the current task, open questions, errors, and useful evidence. It reminds again every 15k tokens as usage rises (closer together when little room remains).

Optional file `~/.pi/agent/infinite-context/settings.json` (inside Pi's configured agent directory) changes the limits; missing or invalid values use the defaults, and changes apply after restarting Pi:

```json
{ "nudgeAtTokens": 150000, "nudgeAtPercent": 75 }
```

`nudgeAtTokens` can also be a range, `[100000, 300000]`, to measure how the limit affects cost: each session then draws one limit uniformly from the range and keeps it when resumed, reloaded or forked. A changed range draws anew.

`reminders` sets the start (`startTokens`) and the distance (`everyTokens`) per provider or model, for example a later start on a model with a large window:

```json
{
  "reminders": {
    "default": { "everyTokens": 20000 },
    "overrides": {
      "anthropic": { "startTokens": 200000 },
      "anthropic/claude-opus-4-5": { "startTokens": 300000, "everyTokens": 50000 }
    }
  }
}
```

Each field resolves on its own: the exact `provider/modelId` entry, then the provider entry, then `default`, then `nudgeAtTokens` (start, including a drawn one) or 15k (distance). The start is still capped at `nudgeAtPercent` of the window, and the distance still shrinks when little room remains. A rule's `startTokens` therefore overrides a drawn `nudgeAtTokens` for that model: the draw is disabled there, and the recorded `nudgeAtTokens` is not the start the reminders use (`details.threshold` and the recorded `reminders` are).

With `"foldHint": "cache-aware"` (default `"fixed"`: off), reminders also say what folding costs now (see [Prefix caching](#prefix-caching)), and the system prompt gets a short `fold_timing` section on when to fold. While the prompt cache is warm, a reminder names the turns after which folding the oldest 75% of the context pays off, and the general rule behind it; once no request succeeded for `cacheTtlMinutes` (default 5), it says folding is free now. Cache prices come from the model's cost in Pi's model registry; `prices` overrides them per exact `provider/modelId` or provider, e.g. `{ "anthropic": { "cacheWrite": 3.75, "cacheRead": 0.3 } }` (any unit; only the ratio matters).

The session records the effective limits as a `custom` entry of type `infinite-context:settings` whenever they change (with `nudgeAtTokensRange` when the limit was drawn, `reminders` and `prices` when set), and each reminder carries its token count, window, threshold and step in `details`.

The agent chooses what to fold and writes the summaries. Reminders do not fold anything themselves.

Pi's own compaction, including `/compact`, is blocked. If the agent does not fold enough, the context can still overflow.

## Prefix caching

Providers cache the start of a prompt and charge about 20× less for cached tokens. A fold changes the prompt from the folded messages onward, so the first request after a fold is mostly uncached. After that, the new prompt is cached again.

Measured on the author's sessions: 89,000 requests, 92 sessions with 502 folds, mixed models.

- **98% of input tokens came from the cache** for requests less than 2 minutes apart. Sessions with folds: 98.0%. Sessions without folds: 98.3%.
- **Only the first request after a fold misses**: 50% cached instead of 98%. A fold happens about once per 56 requests.
- **A fold shrinks the context** from 121k to 47k tokens (median). The cache miss pays for itself after about 3 to 6 requests for folds that free 15k tokens or more. Folds that free less than 15k often never pay off, so the reminders ask for 15k or more.
- After 5 minutes idle, only 18% of input is cached.
