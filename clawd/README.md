# clawd

Clawd, a pixel mascot at the right end of the band above the prompt. The other mods' band rows (mod-dock, session-pulse, usage-meter) stay on the left. Desktop and VS Code only: the terminal, a band narrower than 70 columns and a survey get the band unchanged.

## Scenes

| Trigger | Scene |
| --- | --- |
| Main turn starts | working (laptop) |
| Main-loop tool call | read (Read, Grep, Glob), terminal (Bash, Monitor), write (Edit, Write), web (WebFetch, WebSearch, browser MCP), delegate (Agent) |
| A permission ask open 1.5 s or more, or AskUserQuestion / ExitPlanMode | waiting: Clawd waves with a `!` bubble |
| Subagents running and no fresher tool | delegate |
| Main turn ends with an answer | done: a confetti dance for 6.5 s, then relax for 4 min, then idle |
| Main turn aborted or failed | idle |

Subagents' own tools do not change the scene: agent-radar draws each subagent.

## Design rules

- The band hook calls `next(e)` and puts the result on the left. It never draws in place of another mod.
- Each scene change redraws the whole band and gives other mods' buttons new press handles. So two work scenes in one turn change at most every 4 s, and nothing redraws on a timer alone.
- The animation is CSS keyframes inside the SVG. A scene keeps the same SVG string, so a redraw that keeps the scene keeps its image.
- `prefers-reduced-motion` stops all motion.
- Calls: `$.clock`, `$.state`, `$.ui.resolve` only. No file reads, no processes, no network.

The idea (an SVG band mascot animated by CSS) comes from pixel-buddy (github.com/hamymarnie/marnie-plugins). That repository has no license, so no code was copied: the engine, the sprites and the scenes here are new.

## Files

- `hooks/scene.ts`: the sprites, keyframes and 10 scenes (pure)
- `hooks/mood.ts`: which scene shows, from the session facts (pure)
- `hooks/register.tsx`: the hooks
- `hooks/clawd.test.ts`: 24 tests

## Check

```bash
"$CLAUDE_CODE_EXECPATH" plugin validate clawd
"$CLAUDE_CODE_EXECPATH" plugin test clawd
```
