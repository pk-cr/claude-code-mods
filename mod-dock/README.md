# mod-dock

A dock above the prompt that lists the mods you have, marks which are loaded in this session, and opens or closes each mod window with one click. It reads manifests and the installed-plugin registry. It writes nothing and sends nothing out.

## Commands

- `/dock` opens the pane with the same list.

## Install

```
/plugin marketplace add pk-cr/claude-code-mods
/plugin install mod-dock@claude-code-mods
```

Then run `/reload-plugins`.

## Test

```
"$CLAUDE_CODE_EXECPATH" plugin validate mod-dock
"$CLAUDE_CODE_EXECPATH" plugin test mod-dock
```
