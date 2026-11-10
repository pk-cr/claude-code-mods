# Origin

Conversation Atlas Plus started as a modified copy of **Conversation Atlas** v0.1.0 by NeelAPatel.

- Source: https://github.com/NeelAPatel/Claude-Mod-ConversationAtlas
- Copied from commit `4fcec98c7095496e619a73ce2ef344e303182b09` (2026-10-05)
- License: MIT, copyright (c) 2026 NeelAPatel. The original `LICENSE` file is kept unchanged and applies to this copy.

This rebuild is published in this repository and is not supported by the original author.

## v0.2.0: a rebuild

Version 0.2.0 is a rewrite. The original's observer depended on a tool that Claude calls, and many
organizations' policies block plugin tools, so its topic path, detours and decisions could not update.
The rebuild works from engine events, from what you set, and from optional summaries.

Kept from the original, adapted:

- `classify()` (what a tool call did and which files it touched), in `hooks/signals.ts`.
- `stripPromptMarkers()` (what the person typed, without engine blocks) and the task-notification
  reader, in `hooks/signals.ts`.
- `clip()`, `norm()` and `similar()`, in `hooks/signals.ts`.
- The idea of a side pane, a footer button and an `/atlas` command.

Everything else is new: the state model, the reducers, the summaries, the sessions list, the pane and
the tests. Removed: detours, return packets, decision weights, message chips, the Trail and Evidence
tabs, the observe tool, project save files under `.claude/atlas/`, and golden snapshots.
