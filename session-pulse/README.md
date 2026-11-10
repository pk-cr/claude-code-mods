# session-pulse

A board of all your sessions with a status mark for each (needs you, working, ready, failed, idle, offline), and a one-line band above the prompt that names the session that has waited longest.

## Commands

- `/pulse` opens the board. `/pulse next` names the session to look at. `/pulse name <label>` renames this session. `/pulse pin on|off|test` controls optional sidebar pinning while a session waits.

## Install

```
/plugin marketplace add pk-cr/claude-code-mods
/plugin install session-pulse@claude-code-mods
```

Then run `/reload-plugins`.

## Test

```
"$CLAUDE_CODE_EXECPATH" plugin validate session-pulse
"$CLAUDE_CODE_EXECPATH" plugin test session-pulse
```
