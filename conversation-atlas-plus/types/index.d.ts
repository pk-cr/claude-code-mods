// Conversation Atlas Plus: the state contract.
//
// One map per session: your goal, what Claude is doing now, tasks, open questions, the conversation
// (one row per request), activity, working files, and the sessions list. Everything comes from engine
// events in this session, from what you set, or from a summary a Claude model made through this
// session's own Anthropic client. The goal fills in by itself and a goal you set overrides it; other
// summary items stay suggestions until you press Add or Track.

export type AtlasTaskStatus = 'running' | 'pending' | 'done' | 'failed' | 'stopped'

// agent: a subagent. background: a shell or monitor left running. session: a session Claude started.
// todo: Claude's TodoWrite list. plan: Claude's Task tools. you: added by you.
export type AtlasTaskKind = 'agent' | 'background' | 'session' | 'todo' | 'plan' | 'you'

export type AtlasTask = {
  id: string
  text: string
  status: AtlasTaskStatus
  kind: AtlasTaskKind
  // The engine's id for it: an agent id, a background task id, a session id, a plan task id.
  ref: string | null
  at: number
  updatedAt: number
  turn: number
  // Who closed it without you: Claude's "Atlas: done" line, or a summary. Absent when you or the engine did.
  closedBy?: 'claude' | 'summary' | null
  // The last word on it: the first line of Claude's reply, or why it is not done.
  note?: string | null
  // Sent to Claude from Atlas, in this conversation (ask) or as a background agent.
  dispatch?: AtlasDispatch | null
  // You reopened it after it closed without you: summaries leave it open from then on.
  keepOpen?: boolean
}

export type AtlasDispatch = {
  mode: 'ask' | 'background'
  at: number
  // The request its prompt became (ask), or the agent working on it (background).
  requestId: string | null
  agentId: string | null
}

export type AtlasQuestion = {
  id: string
  text: string
  status: 'open' | 'answered' | 'dropped'
  by: 'claude' | 'you'
  at: number
  turn: number
  closedAt: number | null
}

// working: Claude is on it. answered: the turn ended with a reply. waiting: the reply asked you something.
export type AtlasRequestStatus = 'working' | 'answered' | 'waiting' | 'stopped' | 'error'

export type AtlasRequest = {
  id: string
  turn: number
  text: string
  at: number
  status: AtlasRequestStatus
  // The first line of Claude's reply.
  outcome: string | null
  endedAt: number | null
  tools: number
  agents: number
  // The task of yours this request came from, when Atlas sent it.
  taskId?: string | null
}

// A chapter Claude marked in the transcript (mark_chapter): a phase of the work.
export type AtlasChapter = {
  id: string
  title: string
  summary: string | null
  at: number
  turn: number
}

export type AtlasActivityKind = 'read' | 'search' | 'edit' | 'bash' | 'test' | 'git' | 'web' | 'agent' | 'ask' | 'plan' | 'other'

export type AtlasActivity = {
  id: string
  kind: AtlasActivityKind
  label: string
  state: 'running' | 'done' | 'failed'
  at: number
  endedAt: number | null
  agent: string | null
}

export type AtlasFile = {
  path: string
  reads: number
  writes: number
  lastOp: 'read' | 'write'
  at: number
}

export type AtlasGoal = {
  text: string
  at: number
}

// The latest summary. Its goal is the automatic goal; its lists are suggestions until you add them.
export type AtlasSuggested = {
  by: 'haiku' | 'claude'
  at: number
  turn: number
  title: string | null
  goal: string | null
  now: string | null
  outstanding: string[]
  threads: string[]
}

export type AtlasState = {
  v: 2
  sessionId: string
  root: string
  startedAt: number
  lastActive: number
  turn: number
  seq: number
  title: string | null
  // The first request worth naming the session by: the automatic goal before any summary.
  firstAsk: string | null
  // A goal you set or pinned. It overrides the automatic goal.
  goal: AtlasGoal | null
  // A goal set through Claude Code's own /goal (the ProposeGoal tool).
  claudeGoal: string | null
  suggested: AtlasSuggested | null
  // Suggestions you dismissed, normalized, so a later summary does not offer them again.
  dismissed: string[]
  requests: AtlasRequest[]
  tasks: AtlasTask[]
  questions: AtlasQuestion[]
  chapters: AtlasChapter[]
  activity: AtlasActivity[]
  files: AtlasFile[]
  // Notes for Claude with your next prompt: what a background agent did. Each is sent once.
  pendingNotes?: string[]
}

// One row of the Sessions list: this session, sessions Atlas recorded, and the desktop app's sessions.
export type AtlasSessionRow = {
  id: string
  title: string
  goal: string | null
  open: number | null
  questions: number | null
  lastActive: number | null
  state: string | null
  current: boolean
  tracked: boolean
}

export type AtlasUi = {
  expanded: string | null
  editingGoal: boolean
  showDone: boolean
  showAllRequests: boolean
  sync: { running: boolean; note: string | null }
  sessions: AtlasSessionRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'conversation-atlas-plus': {
      atlas: AtlasState
      ui: AtlasUi
    }
  }
}
