# Conversation Atlas Plus

A live map of your Claude Code session and your other sessions, in a side pane. It answers five
questions at a glance: what is the goal, what is Claude doing now, what is outstanding, what is
still open, and what has been touched.

Rebuilt (v0.2.0) from [Conversation Atlas](https://github.com/NeelAPatel/Claude-Mod-ConversationAtlas)
by NeelAPatel (MIT). `NOTICE.md` says what was kept.

## The pane

| Section | What it shows | Where it comes from |
|---|---|---|
| **Goal** | The goal, filled in by itself and kept current. Edit sets your own, Pin keeps the automatic one, Use auto hands it back. Against your own goal, "Claude reads it as: …" shows a different reading. | In order: a goal you set, Claude Code's own `/goal`, the latest summary's reading of the whole session, your first request. |
| **Now** | The request Claude is working on, how long, tool calls, agents and background jobs running. Or the question it is waiting on. | Turn events, tool calls, subagent starts and ends. |
| **Tasks** | Open work, working first. Finished tasks fold away. Ask Claude or Background hands one of your tasks to Claude, and a task closes when Claude reports it done. | Subagents, background shells and monitors, sessions Claude starts, Claude's todo and plan lists, tasks you add, and summary suggestions (marked "suggested"). |
| **Open questions** | Questions waiting on you. A question Claude asks closes when you reply. | Replies that end with a question, AskUserQuestion, questions you track, and summary suggestions. |
| **Conversation** | One line per request, newest first, with the first line of Claude's reply, grouped by the chapters Claude marks. | Your prompts and Claude's replies. |
| **Activity** | The last tool calls, with running, done or failed. | Tool calls. |
| **Working files** | Files read and edited, newest first, with counts. | Read, Edit and Write calls. |
| **Sessions** | This session, other sessions Atlas mapped in this folder, and your desktop sessions. | Atlas's local records and the Claude desktop app's session list. |

Press a row to see its detail and actions. Suggestions stay dim and say "suggested" until you press
Use, Add task, Track or Dismiss. A dismissed suggestion does not come back.

## Handing a task to Claude

Press one of your own tasks to see its actions.

- **Ask Claude** sends the task to Claude in this session, as your own words, after the current
  turn. The task shows "queued for Claude", then "with Claude". The prompt asks Claude to end its
  reply with `Atlas: done k3`, and that line closes the task ("done by Claude"). A reply that ends
  with `Atlas: not done k3 - <why>`, a stopped turn, or a prompt a hook refuses puts the task back
  to waiting, with the reason under it.
- **Background** gives the task to a fork of this session: an agent that knows the conversation so
  far, while you keep working. The task shows "background agent" and closes when the agent ends.
  Your next prompt then tells Claude, once, that the agent finished (while `/atlas align` is on).
- **Ask Claude** on a suggested item adds it as your task, then sends it.

Tasks also close without a button:

- While `/atlas align` is on, each prompt lists your open tasks with their ids and asks Claude to
  end a reply with `Atlas: done <id>` when it finishes one. You see that line at the end of the reply.
- The summary after each answer names the tasks it sees finished. They close as "done · auto".
- Reopen undoes a close. A task you reopen stays open through later summaries. Only Claude's own
  report closes it again.

When Atlas joins a session that is already running, it replays the transcript so far, so the map
starts where the conversation is.

## What leaves this Mac

| Data | Where it goes | When |
|---|---|---|
| The map (session state and the store) | Nowhere. It stays in `~/.claude/plugins/store/` on this Mac. | Always. |
| One line with the goal you set (never the automatic one), your own open tasks with their ids, and how to report one done | To Claude, with your prompt, in this session. | Each prompt, while `/atlas align` is on (default on). |
| One of your tasks, as a prompt in your words | To Claude, in this session. | Only when you press Ask Claude or run `/atlas ask <n>`. |
| One of your tasks, as the prompt of a fork of this session (the fork reads this session's transcript) | Claude, through this session's own client, as a background agent. | Only when you press Background or run `/atlas bg <n>`. |
| One line saying that a background agent you started finished your task | To Claude, with your next prompt, once. | After that agent ends, while `/atlas align` is on. |
| A short digest: your recent requests, the first line of each reply, task and question states. No file contents, no full replies. | Haiku, through this session's own Anthropic client. | After each answer, while Summaries is `both` or `each turn`. |
| This session's own transcript (from the prompt cache) | Claude, through this session's own client, as a fork. | Only when you press Sync or run `/atlas sync` (Summaries `both` or `on demand`). |
| Nothing: a read of titles and states | The Claude desktop app on this Mac (`ccd_session_mgmt` / `list_sessions`). | Every minute, while Desktop sessions is `on`. |

Atlas makes no HTTP, process or file calls and talks to no other server. `tests/egress.test.tsx`
drives every feature and fails on any other outbound call. It also fails if Atlas sends a prompt or
starts an agent without your press. `claude plugin validate` lists every `$` call the module makes.

A failed or refused call (for example an org policy that blocks a model) is silent: the map keeps
working from engine events and what you set.

## Commands

```
/atlas                      open the map
/atlas goal [<text>]        show the goal, or set your own (/atlas goal auto returns to automatic)
/atlas task <text>          add a task of your own
/atlas tasks                list open tasks with numbers
/atlas done <n>             finish your task n
/atlas drop <n>             remove task n
/atlas ask <n>              send your task n to Claude (sent once the command has returned)
/atlas bg <n>               give your task n to a background fork of this session
/atlas question <text>      track an open question
/atlas questions            list open questions with numbers
/atlas answered <n>         close question n
/atlas sync                 ask Claude to re-read the session and update the suggestions
/atlas align on|off         send your goal and your own tasks with each prompt
/atlas status               settings, and where Atlas data goes
/atlas reset                clear this session's map
```

## Settings

In `/config`, or `pluginConfigs` in your settings, under `conversation-atlas-plus`:

| Setting | Values | Default |
|---|---|---|
| `summaries` | `both`, `each turn`, `on demand`, `off` | `both` |
| `desktopSessions` | `on`, `off` | `on` |

## Check it

```bash
"$CLAUDE_CODE_EXECPATH" plugin validate .
"$CLAUDE_CODE_EXECPATH" plugin test .
```

Use the desktop app's bundled binary. An older `claude` on the PATH cannot read function hooks.

## Limits

- Tasks you did not add end by themselves. If the engine never reports an end (a background job
  from before a restart), remove it from its row.
- Summaries are suggestions. They can be wrong; nothing they say becomes your goal or a task until
  you press a button. The one exception: a summary can close a task it sees finished. Reopen undoes it.
- Claude closes a task only by ending a reply with `Atlas: done <id>`, and it can forget. A task it
  never reports stays open; finish it from its row or with `/atlas done <n>`.
- A task that is with Claude when the session restarts goes back to waiting, with a note.
- The test kit starts no agent for a plugin. The tests check the fork Atlas asks for and the steps
  that follow an agent's end, but not a live background agent.
- The desktop session list depends on the desktop app. Elsewhere (a plain terminal), the Sessions
  list shows only sessions Atlas mapped.
