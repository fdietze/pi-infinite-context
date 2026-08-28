# pi-infinite-context

*This readme is fully human-written.*

This [pi](https://pi.dev/) extension enables an infinite context experience for agentic chat sessions. It provides tools for the agent to fold and summarize arbitrary parts of its history. Summarized content is not lost. It can still be searched and unfolded on demand. This is a more fine-grained alternative to auto compaction (which summarizes the entire history) commonly found in many harnesses.

![A selected range of stored chat history is replaced by a summary in active context while the original messages remain available.](docs/folding.svg)

This turns out to work surprisingly well with claude-opus-4/5 and gpt-5.6-sol models. I usually have a single chat per project and use it to work through many more tasks than would be possible with limited context. I rarely notice any task performance / understanding degradation.


## Install

```bash
pi install git:github.com/fdietze/pi-infinite-context
```

## Prior Art

- [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)

## License

[MIT](LICENSE)
