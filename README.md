# idle-compact

A Claude Code mod that compacts an idle session just before its 1-hour prompt cache expires, so coming back doesn't re-write the full context.

```
/plugin marketplace add benredmond/idle-compact
/plugin install idle-compact@idle-compact
/reload-plugins
```

- Runs a plain `/compact` once after 55 minutes idle, then waits for your next turn. It never compacts twice in a row.
- Skips sessions under 40k tokens, running turns, and caches that have already expired.
- Shows a countdown in the status line (`◔ 12m`), then `✓ 120k→12k` once compacted.

Configure with `/plugin configure idle-compact@idle-compact` (`ttlMinutes` 60, `marginMinutes` 5, `minContextTokens` 40000, `instructions` empty for a plain `/compact`).

Not useful if your prompt cache lasts 5 minutes.

MIT
