# usage-meter

Token, cost, context and rate-limit meter: a status entry, a band above the prompt, a pane (Overview, Models, Agents, Diagnostics) and threshold toasts. It reads usage numbers only. It sends nothing out and stores nothing.

## Commands

- `/meter` opens the pane.

## Install

```
/plugin marketplace add pk-cr/claude-code-mods
/plugin install usage-meter@claude-code-mods
```

Then run `/reload-plugins`.

## Test

```
"$CLAUDE_CODE_EXECPATH" plugin validate usage-meter
"$CLAUDE_CODE_EXECPATH" plugin test usage-meter
```
