# context-keeper

A toast at 60% and 75% of the compaction point asks you to run /compact at the end of the task while the cache is warm. It reads token counts only. It sends nothing out and stores nothing.

## Commands

- `/keeper` shows the context fill.

## Install

```
/plugin marketplace add pk-cr/claude-code-mods
/plugin install context-keeper@claude-code-mods
```

Then run `/reload-plugins`.

## Test

```
"$CLAUDE_CODE_EXECPATH" plugin validate context-keeper
"$CLAUDE_CODE_EXECPATH" plugin test context-keeper
```
