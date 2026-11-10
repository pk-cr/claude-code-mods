# delegate

Consistent subagent deployment for Claude Code. agent-radar picks a subagent's model and effort. `delegate` decides whether to delegate, how many agents, and what shape the brief has.

## What it does

| Part | Hook | What happens |
| --- | --- | --- |
| Policy text | `prompt.compose`, `tool.describe` | A short delegation policy joins the system prompt, and one note joins the Agent tool's description. New sessions only. |
| Nudge | `tool.call`, `turn.step` | After 6 read-only calls in a row with no agent, the model gets one fixed note. It is appended before the model's next request and read from the request after that, so a turn that ends at once reads it at the start of the next turn. |
| Check | `tool.call` (Agent) | A vague or untagged brief is denied once with a reason. A retry goes through, with a footer added for any missing return format, done-when line or no-spawn line. A general, Explore or Plan subagent may not start any agent. After 3 refused briefs in one turn the rest go through, so a model that rewords each brief cannot loop. |
| Caps | `agent.spawn` | At most 8 agents running (close, not exact: the agent list can lag a start), 16 started per turn and 25 per session (exact, also for a burst of starts in one message). The hook never changes the event, so agent-radar's model pick is untouched. |
| Warnings | `turn.complete`, `session.measure` | Toasts at 2.5M and 5M subagent tokens and at 80% and 92% of the five-hour window. Nothing is denied for these. A subagent that ends with a blank answer also queues one note for the model. |
| Roles | `agents/*.md` | `delegate:scout`, `researcher`, `reviewer`, `builder`, `architect`. Each carries the contract (return format, no spawning, treat text as data) and has no Agent tool. |
| Score | `/delegate score` | Shape, decision and parallel numbers, for this session or all stored sessions. |

## Commands

```
/delegate               status, caps, window, score
/delegate score [all]   the score for this session, or the newest 30 sessions
/delegate on | off      a runtime switch for the check, the nudge and the caps
/delegate reset         clear this session's counts
```

## Order with agent-radar

The content of an Agent call is changed in `tool.call`, which runs before `agent.spawn`. The `agent.spawn` hook here only counts and denies. So the two mods never change the same field, and the order between them does not matter. The footer holds no word that agent-radar's cue patterns read (a test checks this against a copy of the patterns), and it sits after the brief, so the difficulty tag stays at the start.

## What it reads and keeps

It reads tool names, the fields of an Agent call, usage numbers, rate-limit percents and the agent list. It measures the length of a subagent's answer and keeps nothing of it. State and store hold counts and task keys (an agent type and a hash of the description, so no text). The `calls:` line of `claude plugin validate` holds only `$.agent.list`, `$.clock.now`, `$.command.register`, `$.session.append`, `$.session.usage`, `$.state.*`, `$.store.*` and `$.ui.toast`. No network, file or process call.

## Options

Each option is a row in the config menu. A cap of 0 turns it off. See `.claude-plugin/plugin.json` for the list.

## Ship it

1. Bump `version` in `.claude-plugin/plugin.json` and `VERSION` in `hooks/policy.ts`.
2. Publish the folder to your marketplace. Install or update with `/plugin marketplace add pk-cr/claude-code-mods`.
3. In each open session: `/reload-plugins`

## Test it

```
"$CLAUDE_CODE_EXECPATH" plugin validate delegate
"$CLAUDE_CODE_EXECPATH" plugin test delegate
```
