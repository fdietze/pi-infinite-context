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

When Pi estimates that context holds at least **150k tokens or 75% of the model's window** (whichever comes first), the extension reminds the agent during tool work to fold what later work no longer needs while keeping the thread (instructions, the active request, open decisions), once that frees about 30% of the context or little room is left. It reminds again every 15k tokens as usage rises (closer together when little room remains).

Optional file `~/.pi/agent/infinite-context/settings.json` (inside Pi's configured agent directory) changes the limits; missing or invalid values use the defaults, and changes apply after restarting Pi:

```json
{ "nudgeAtTokens": 150000, "nudgeAtPercent": 75 }
```

`nudgeAtTokens` can also be a range, `[100000, 300000]`, to measure how the limit affects cost: each session then draws one limit uniformly from the range and keeps it when resumed, reloaded or forked. A changed range draws anew.

The session records the effective limits as a `custom` entry of type `infinite-context:settings` whenever they change (with `nudgeAtTokensRange` when the limit was drawn), and each reminder carries its token count, window, threshold and step in `details`.

The agent chooses what to fold and writes the summaries. Reminders do not fold anything themselves.

Pi's own compaction, including `/compact`, is blocked. If the agent does not fold enough, the context can still overflow.

## Prefix caching

Providers cache the start of a prompt and charge about 20× less for cached tokens. A fold changes the prompt from the folded messages onward, so the first request after a fold is mostly uncached. After that, the new prompt is cached again.

Measured on the author's sessions: 89,000 requests, 92 sessions with 502 folds, mixed models.

- **98% of input tokens came from the cache** for requests less than 2 minutes apart. Sessions with folds: 98.0%. Sessions without folds: 98.3%.
- **Only the first request after a fold misses**: 50% cached instead of 98%. A fold happens about once per 56 requests.
- **A fold shrinks the context** from 121k to 47k tokens (median). A fold costs its folding turns plus the cache miss, together about ten cached reads of the whole context. Over 1,218 folds in 90 days, counting cheaper reads until the next fold as savings, a fold returned about $0.2 per $1 when it freed less than 20% of the context, broke even between 20% and 30% (reliably only from 30%), and returned about $4 at 40–50% and $14 at 70–80%. So the reminders ask for about 30%.
- After 5 minutes idle, only 18% of input is cached.
