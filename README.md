# claude-code-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins with function hooks that add panes, bands above the prompt, toasts, slash commands and subagent tooling. Each folder is one plugin.

## Install

In Claude Code:

```
/plugin marketplace add pk-cr/claude-code-mods
/plugin install <mod>@claude-code-mods
```

Then run `/reload-plugins`. A session that already runs an older version of a mod keeps it until the process restarts, so restart the app after an update.

## Mods

| Mod | What it does |
| --- | --- |
| [`agent-radar`](agent-radar/) | Pixel-art studio view of your subagents, a cross-session tracker, and a router that picks each subagent's model and effort. |
| [`clawd`](clawd/) | Pixel mascot in the band above the prompt. Scenes follow the session: working by tool, waiting on you, delegating, a party when a turn ends. |
| [`context-keeper`](context-keeper/) | Toasts at 60% and 75% of the compaction point. `/keeper` shows status. |
| [`conversation-atlas-plus`](conversation-atlas-plus/) | Live map of the session and your other sessions. A rebuild of Conversation Atlas (MIT, by Neel). |
| [`delegate`](delegate/) | Consistent subagent deployment: policy, nudge, check on each Agent call, caps, warn-only budgets and `/delegate score`. |
| [`gauntlet`](gauntlet/) | `/gauntlet`: fresh sub-agents compete on one task, attack and defend, and a blind judge picks one answer. Built from arena-skill (MIT, Jake Schincariol). |
| [`mod-dock`](mod-dock/) | A dock above the prompt that lists every mod, marks the loaded ones and opens each mod's window. |
| [`session-pulse`](session-pulse/) | A board (`/pulse`) of every session on this machine with a status mark per session, a one-line band, and an optional pin while waiting. |
| [`usage-meter`](usage-meter/) | Meter for tokens, cost, context and rate limits, with a band, a pane and toasts. |

`agent-radar-art/` holds the Python sources for agent-radar's pixel characters. It is not a plugin.

## Develop

1. Validate: `"$CLAUDE_CODE_EXECPATH" plugin validate <mod>`
2. Test: `"$CLAUDE_CODE_EXECPATH" plugin test <mod>` (takes a folder, not a file)
3. Bump `version` in `<mod>/.claude-plugin/plugin.json` after every change, so `/plugin update` picks it up.

Use the Claude Code binary at `$CLAUDE_CODE_EXECPATH`. An older `claude` on `PATH` may not know function hooks.

## Privacy

No mod sends session content anywhere except through Claude Code's own Anthropic client. `plugin validate` prints each mod's `calls:` line, and the mods that touch the network carry an egress test. Mods that keep state on disk write only small status files under `~/.claude/<mod>/`.

## License

MIT, see [LICENSE](LICENSE). `conversation-atlas-plus` and `gauntlet` carry the notices of the MIT projects they build on.
