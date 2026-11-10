# Changelog

## 0.3.0: hand tasks to Claude, and tasks that close by themselves

- Ask Claude: press one of your tasks, or a suggested item, to send it to Claude in this session as
  your own words. The task follows the turn: "queued for Claude", "with Claude", then done, or back
  to waiting with the reason. `/atlas ask <n>` does the same.
- Background: give a task to a fork of this session, which knows the conversation so far. The task
  closes when the agent ends, and your next prompt tells Claude once. `/atlas bg <n>` does the same.
- Tasks close without you. Claude ends a reply with `Atlas: done <id>`: the alignment line now lists
  your open tasks with ids and asks for that line. Summaries name tasks they see finished ("done · auto").
- Reopen undoes an automatic close. A reopened task stays open through summaries. Only Claude's own
  report closes it again.
- Start is gone from task rows. Ask Claude replaces it.
- Two new calls, both inside your session and both only on your press: `$.prompt.submit` and
  `$.agent.spawn`. `tests/egress.test.tsx` fails on either one without a press.

## 0.2.1: automatic goal

- The goal fills in by itself: your first request, then each summary's reading of the whole session.
  A summary that only rewords the goal keeps the old words, and one with no goal keeps the last.
- Your own goal overrides it: Edit, or Pin to keep the automatic goal fixed; Use auto (or
  `/atlas goal auto`) hands it back. Claude Code's /goal comes before the automatic goal.
- Only a goal you set rides along with prompts; the automatic goal is shown, never sent.
- The first request is read from a "Task:" line when a brief has one, and label lines are skipped.
- Version 0.1 store keys are removed again every minute, in case another session writes them back.

## 0.2.0: rebuild

- One view: Goal, Now, Tasks, Open questions, Conversation, Activity, Working files, Sessions.
- Tasks come from real lifecycles: subagents, background shells and monitors, sessions Claude starts,
  Claude's todo and plan lists, and tasks you add.
- Claude's questions close when you reply. The conversation shows one line per request with the first
  line of the reply, grouped by the chapters Claude marks.
- No guessed goal. Your goal rides along with each prompt as one line (`/atlas align`). Summaries
  suggest a goal, outstanding work and open threads; nothing is adopted until you press a button.
- Summaries: a Haiku digest after each answer and `/atlas sync` (a Claude fork over the session), both
  through the session's own Anthropic client. Setting: `summaries`.
- Sessions list: Atlas's local records plus the Claude desktop app's session list. Setting: `desktopSessions`.
- The transcript is replayed when Atlas joins a running session.
- Outbound calls are limited to the three above; `tests/egress.test.tsx` holds it.
- Removed: the observe tool, detours, return packets, decision weights, chips, Trail and Evidence tabs,
  project save files, golden snapshots. Version 0.1 keys in the plugin store are deleted on first load.

## 0.1.0: fork of Conversation Atlas 0.1.0

- Added a TASKS section fed by TodoWrite and the Task tools, and `/atlas task`.
- Engine-only observer by default; the observe tool registered only after the Claude observer was chosen.
- Stored prompt text capped at 400 characters; save files without a project root rejected.
- A refused observe tool fell back to engine-only mode without a message.
