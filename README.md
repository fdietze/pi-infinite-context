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

When Pi estimates that context holds at least **150k tokens or 75% of the model's window** (whichever comes first), the extension reminds the agent during tool work to fold what later work no longer needs while keeping the thread (instructions, the active request, open decisions), once that frees about 30% of the context or little room is left. Each reminder states that share in tokens. If the agent does not fold, it reminds again after another 15k tokens (sooner when little room remains). In practice the agent folds at the first reminder 78% of the time, so repeats are rare.

Optional file `~/.pi/agent/infinite-context/settings.json` (inside Pi's configured agent directory) changes the limits; missing or invalid values use the defaults, and changes apply after restarting Pi:

```json
{ "nudgeAtTokens": 150000, "nudgeAtPercent": 75 }
```

`nudgeAtTokens` can also be a range, `[100000, 300000]`, to measure how the limit affects cost: each session then draws one limit uniformly from the range and keeps it when resumed, reloaded or forked. A changed range draws anew.

The session records the effective limits as a `custom` entry of type `infinite-context:settings` whenever they change (with `nudgeAtTokensRange` when the limit was drawn), and each reminder carries its token count, window, threshold and step in `details`.

The agent chooses what to fold and writes the summaries. Reminders do not fold anything themselves.

Pi's own compaction, including `/compact`, is blocked. If the agent does not fold enough, the context can still overflow.

If saved folds cannot be applied (the snapshot does not match the branch, the branch fails a check, or the request cannot be mapped to the history), the extension stops the first request and shows the reason, instead of sending the unfolded transcript, which costs several times more and can overflow the window. Send another message to continue unfolded (the status line then shows "folds not applied: sending unfolded"), hand the work over to a new session, or have another agent repair the session file. Reloading tries the folds again. Subagents show no notice; their parent sees an aborted run. Without folds, nothing changes.

## When a fold pays off

Providers cache the start of a prompt; cached tokens cost about a tenth of uncached ones. A fold changes the prompt from the first folded message onward, so the next request reads that part uncached (47% cached instead of 99%). After that, the shorter prompt is cached again and every request reads fewer tokens.

So a fold costs its folding turns plus that one cache miss, together about ten cached reads of the whole context, and every later request saves the freed share of one read. So it pays off when (share freed) × (requests until the next fold) exceeds about 10. Folds are typically followed by a few dozen requests, so in practice the share decides:

![Return per dollar of 1,232 folds against the share of context each freed, on a log scale. The return of all folds in each 10% step rises from about 0.2 below 20% freed, crosses 1 between 20% and 30%, and reaches about 13 at 70-80%.](docs/fold-payoff.png)

Each dot is one fold: the share of the context it freed (x) and the dollars it saved per dollar it cost (y, log scale), counting savings until the next fold. The black line is the return of all folds in each 10% step, the gray band its 90% interval. Above the dashed line a fold paid off.

- Folds that free less than 20% lose money: about $0.2 back per $1.
- Folds break even between 20% and 30% and pay off on average from 30% (the gray band stays above 1), though single folds vary widely: about $4 back at 40–50%, about $13 at 70–80%.
- So the reminders ask for about 30% of the context.

Measured on the author's sessions over 90 days: 1,232 folds, Claude and GPT models. A median fold shrank the context from 152k to 46k tokens. Only cost is measured, not how folding affects the quality of the agent's work. The chart comes from [context-efficiency](https://github.com/fdietze/context-efficiency) (`context-efficiency-metrics --all-projects --since 90d --html report.html`).
