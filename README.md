# idle-compact

A [Claude Code mod](https://claude.dev/blog/getting-started-with-claude-code-mods/) that compacts an idle session shortly before its prompt cache expires, so the next prompt you send doesn't re-write the full context.

When you come back to a large session after the cache has expired, the next request pays to write the entire context into the cache again. idle-compact does the compaction while the cache is still warm: the summary request is mostly cache reads, and the next request only re-writes the much smaller summary.

## Install

In Claude Code:

```
/plugin marketplace add benredmond/idle-compact
/plugin install idle-compact@ben-mods
/reload-plugins
```

If it doesn't show up, restart Claude Code. Mods are early access; it was built and tested on Claude Code 2.1.283–2.1.286.

## How it works

- Starts a countdown from the last main-conversation request. Subagent requests don't reset it.
- When the session has been idle for `ttlMinutes − marginMinutes` (55 minutes by default), it runs `/compact` with your instructions and shows a toast with the size change.
- **It never compacts twice in a row.** After any compaction between turns (its own or a manual `/compact`), it waits until you start a new turn. A compaction that another hook vetoes, or one that fails three times, also waits for the next turn.
- It never compacts while a turn is running, and leaves sessions under `minContextTokens` alone.
- If the cache has already expired (for example, the machine slept), it skips, since compacting would save nothing.
- The status line shows its state, e.g. `idle-compact in 12m · cache 17m`.

## Settings

Change these with `/plugin configure idle-compact@ben-mods`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `ttlMinutes` | 60 | How long your prompt cache lasts after a request |
| `marginMinutes` | 5 | How long before expiry to compact |
| `minContextTokens` | 40000 | Leave smaller sessions alone |
| `instructions` | Preserve the current task, open decisions, file paths touched, and next steps. | What the summary should keep |

## When not to use it

- **Your prompt cache lasts 5 minutes, not 1 hour.** The 60-minute default assumes a 1-hour cache. With a 5-minute cache, the cache is cold long before minute 55, so the mod would never save anything. Lowering the TTL to 5 would compact after every short pause, which loses detail for little gain.
- **You often leave sessions you never come back to.** Compacting is itself a paid request, so it only pays off when you return.
- **You need the full transcript.** A summary keeps less detail than the original conversation.

It only runs while Claude Code is open and the machine is awake, because its timer stops otherwise.

## Security

A mod runs inside Claude Code with the same access Claude Code has. Read [`idle-compact/hooks/register.ts`](idle-compact/hooks/register.ts) (about 160 lines) before installing.

## Development

```bash
claude plugin validate ./idle-compact
claude plugin test ./idle-compact
```

## License

MIT
