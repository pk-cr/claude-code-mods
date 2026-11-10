// State contract of agent-radar: what its hooks write and its drawings read.
// Every value is plain data, so the host can hold it across a hot reload.

/** Where an agent's loop is right now, as the radar words it. */
export type Phase = 'starting' | 'thinking' | 'writing' | 'tool' | 'done' | 'failed' | 'stopped'

/** `$.agent.list()`'s word for where an agent stands. */
export type AgentStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'

/** One skill seen in use: loaded by a call, or only named in the thinking. */
export type SkillUse = {
  name: string
  /** `invoked`: a Skill call or a skill prompt; `thought`: only mentioned. */
  how: 'invoked' | 'thought'
  /** The subagent (its name or type) that loaded it; absent for the main loop. */
  by?: string
  /** True once the turn that used it is over: it shows dimmed. */
  isFinal: boolean
}

/** What the router does with a spawn. `off`: nothing. `suggest`: shows its pick. `auto`: sends it. */
export type RouteMode = 'off' | 'suggest' | 'auto'

/**
 * How far a pick may go. `raise`: a hard task may get a stronger model and more effort
 * than the session runs on. `session`: never above the session's own model and effort.
 */
export type RouteCeiling = 'raise' | 'session'

/** The router's switches, set with `/radar mode ...`, `/radar ceiling ...` and `/radar learn ...`. */
export type RouterSettings = {
  mode: RouteMode
  ceiling: RouteCeiling
  /** Whether lessons from past runs adjust the picks. Absent means on. */
  learn?: boolean
  /** The share of routed runs to aim for on the light model (0 to 1), by trying it more often. Absent: no target. */
  target?: number
}

/** The effort levels the router picks from. It never picks `max`. */
export type RouteEffort = 'low' | 'medium' | 'high' | 'xhigh'

/** The kind of task the rules read from the instructions; `kept` is a spawn the router leaves alone. */
export type RouteKind = 'lookup' | 'routine' | 'careful' | 'hard' | 'kept'

/** The router's pick for one subagent, and why. */
export type Route = {
  kind: RouteKind
  /** What the spawn is sent: an alias, or the parent's own id. Absent when the model is left alone. */
  model?: string
  /** What every step of the agent is sent, before any raise. Absent when the effort is left alone. */
  effort?: RouteEffort
  /** The most a struggling agent's effort may be raised to: the session's under `ceiling: 'session'`. */
  maxEffort?: RouteEffort
  /** True when a lesson from past runs raised this pick. */
  isLearned?: boolean
  /** The model tier the pick runs on, and the tier the task kind starts on before any move down. */
  tier?: 'haiku' | 'sonnet' | 'opus'
  baseTier?: 'haiku' | 'sonnet' | 'opus'
  /** True when the pick tries a cheaper tier to learn whether it holds. */
  isExplore?: boolean
  /** True when past runs proved the cheaper tier holds for this kind. */
  isProven?: boolean
  /** The run's token budget, in input-token equivalents: what the starting tier's runs of this kind need. */
  budget?: number
  /** True for a plugin role's pick (delegate's): it only raises the role's own model and effort, and teaches the router nothing. */
  isRaiseOnly?: boolean
  /** The cues behind the pick, in words. */
  why: string
  /** True when the pick is sent; false in suggest mode and for a kept spawn. */
  isApplied: boolean
}

/** A pick made at the spawn, before the engine answered with the agent's id. */
export type PendingRoute = {
  toolUseId: string
  type: string
  description: string
  route: Route
}

/** The picks the steps look up: by agent id once the spawn answered, pending before. */
export type RouteBook = {
  pending: PendingRoute[]
  byAgent: Record<string, Route>
}

/** Tokens one agent used, summed over its model requests. */
export type TokenCounts = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Tokens and agent count for one route kind (or `unrouted`), this session. */
export type Spend = {
  tokens: number
  agents: number
}

/** Two or more live subagents that edited the same file. */
export type Conflict = {
  /** The path, lowercased: macOS and Windows file systems ignore case by default. */
  key: string
  /** The path as the first edit spelled it. */
  path: string
  /** The agent ids, in the order they edited it. */
  agents: string[]
  at: number
}

/**
 * How one routed agent's run went: what the router learns from. Kept on disk with `$.store`,
 * one key per session. It holds no prompt or answer text.
 */
export type Outcome = {
  kind: Exclude<RouteKind, 'kept'>
  /** It failed, or three or more of its tool calls failed. */
  struggled: boolean
  /** A lesson had already raised its pick: such runs never feed the lesson again. */
  wasRaised: boolean
  tokens: number
  at: number
  /** The tier and effort it ran on. Absent in records from before routing v2. */
  tier?: 'haiku' | 'sonnet' | 'opus'
  effort?: RouteEffort
  /** Its tokens in input-token equivalents (cache reads weigh 0.1, output 5). */
  billed?: number
  /** It was a try of a cheaper tier: it teaches that tier, never the kind's raise. */
  wasExplore?: boolean
  /** It used more than its budget: that counts as a struggle. */
  overBudget?: boolean
}

/** One subagent card of the pane. */
/** One tool call on a card's trail: the tool's short name and the argument it shows. */
export type TrailStep = { tool: string; detail: string }

export type AgentRow = {
  id: string
  type: string
  name?: string
  description: string
  /** The model its last request named, as the engine resolved it. */
  model?: string
  effort?: string
  status: AgentStatus
  phase: Phase
  /** One line on what it does now: the last tool call, or its phase. */
  doing: string
  tools: number
  /** Tool calls that failed or were refused: three of them raise the agent's effort a level. */
  errors?: number
  /** Model requests it made. */
  steps?: number
  /** Tokens it used, from each response's usage. */
  tokens?: TokenCounts
  /** Tokens in its last request: how full its context is. */
  context?: number
  /** Its desk in the office; desk 0 is the Lead's. */
  seat?: number
  /** Its last tool call: the tool and the short argument a card shows ("Grep" and "MAX_OFFICES"). */
  tool?: string
  detail?: string
  /** Files it edited, as named; the conflict check compares them lowercased. */
  files?: string[]
  /** Files it read, as named: the card counts them. */
  reads?: string[]
  /** How many files it read, where only the count is known (another session's agent). */
  readCount?: number
  /** Its last few tool calls, oldest first. */
  trail?: TrailStep[]
  /** Its tool calls by tool; MCP tools count as one. */
  toolCounts?: Record<string, number>
  /** Its answer on one line, clipped: the card shows it once the agent ends. */
  answer?: string
  /** A tool call of its own that waits for the person's approval. */
  needs?: { tool: string; since: number }
  startedAt: number
  endedAt?: number
  background: boolean
  fork: boolean
  parentId?: string
  /** What the router picked for it, when the router was on. */
  route?: Route
  /** When a finished agent got new work (SendMessage) and came back: a list that still calls it finished does not end it again at once. */
  resumedAt?: number
  /** Its end taught the router already: a resumed agent's later ends teach nothing more. */
  isTaught?: boolean
}

/** The main loop (the Lead): the model and effort it runs on and what it does now. */
export type MainState = {
  model: string
  effort?: string
  phase: 'idle' | 'thinking' | 'writing' | 'tool'
  /** Its last tool call, as a card shows it. */
  tool?: string
  detail?: string
  /** Tokens in its last request, and the session's context window. */
  context?: number
  window?: number
  /** The main turn in progress, from its first step to its end; absent between turns. */
  turnId?: string
  /** When the Lead last ran the gauntlet's closing step (`gauntlet.py winner`): the colosseum holds a few seconds more, then the studio returns. */
  gauntletDoneAt?: number
}

/** How the Team pane draws: `/radar view ...`, `/radar labels ...`, `/radar motion ...`. Kept on disk. */
export type ViewPrefs = {
  layout: 'office' | 'cards' | 'both'
  /** Name tags over the desks. */
  labels: boolean
  /** Typing, nodding, blinking and walking. */
  motion: boolean
  /** More lines on each subagent's card: calls, files, tokens, times. Absent (an older save) is on. */
  details?: boolean
  /** The other sessions: their section in the pane and their line in the band. Absent (an older save) is on. */
  sessions?: boolean
  /** `recent`: working sessions and those active in the last `idleHours`, at most `floors`. `all`: every live session. Absent is recent. */
  sessionsMode?: 'recent' | 'all'
  /** How long an idle session keeps its dim floor, in hours. Absent is 2. */
  idleHours?: number
  /** How many other sessions get a floor. Absent is 6. */
  floors?: number
}

/** One tool call as another session shows it: the tool's name and its short argument (60 characters at most). */
export type LiveCall = { tool: string; detail?: string }

/** The Lead as another session sees it: where its loop is, its model and effort, its current call. */
export type LiveLead = {
  phase: 'idle' | 'thinking' | 'writing' | 'tool'
  model?: string
  effort?: string
  /** The tool it runs now, by name only (every MCP tool is `MCP`): what 0.8 reads. */
  tool?: string
  /** Since 0.9: its current call, the tool's own name and its short argument. */
  call?: LiveCall
  context?: number
  window?: number
}

/**
 * One subagent as another session sees it: what its desk and its card show. Labels, role, status,
 * model, effort, times, tokens, the Agent call's short description, and since 0.9 its calls (the
 * tool and a short argument), the base names of the files it edited, and counts. Never a prompt,
 * thinking text or answer: an ended agent's `doing` is only "finished", "failed" or "interrupted".
 */
export type LiveAgent = {
  label: string
  /** The office role it is drawn as: `explore`, `builder`, ... */
  role: string
  /** What it does, in the office's words: `reading`, `typing`, `done`, ... */
  activity: string
  /** The tool it runs now, by name only: every MCP tool is `MCP`. */
  tool?: string
  model?: string
  effort?: string
  startedAt: number
  endedAt?: number
  /** Every token counted. */
  tokens: number
  description: string
  background?: boolean
  // Since 0.9: what the card shows.
  id?: string
  type?: string
  name?: string
  status?: AgentStatus
  phase?: Phase
  doing?: string
  call?: LiveCall
  tools?: number
  errors?: number
  steps?: number
  tokenCounts?: TokenCounts
  context?: number
  seat?: number
  files?: string[]
  reads?: number
  trail?: TrailStep[]
  toolCounts?: Record<string, number>
  needs?: { tool: string; since: number }
  parentId?: string
  route?: Route
  fork?: boolean
}

/** Subagent tokens by route kind: the wall board's bars. */
export type PeerSpend = { lookup?: number; routine?: number; careful?: number; hard?: number }

/**
 * What one session publishes for the others, in `~/.claude/agent-radar/live/<session id>.json`:
 * rewritten every 2 s while busy and every 15 s while idle, emptied when the session ends.
 */
export type LiveFile = {
  v: 1
  id: string
  /** When it was written: the heartbeat. */
  beat: number
  /** How often its session writes it while in this state, in ms. */
  every: number
  /** The folder name of the session's project root. */
  project: string
  /** The name set with `/radar name`. */
  label?: string
  lead: LiveLead
  agents: LiveAgent[]
  /** Since 0.9: the wall board. */
  spend?: PeerSpend
  /**
   * Since 0.9.1: when the session last did anything, as its writer saw it: a Lead turn, a subagent
   * change, any change to what it publishes. A heartbeat with no change leaves it alone.
   */
  active?: number
  /** Since 0.9.1: the session ended. Its file keeps only its label and `active`, for a resume. */
  closed?: boolean
}

/**
 * Another session on this machine, as the pane and the band draw it: its floor's people as the
 * cards hold them. The live timer works it out each second, so the last drawing (which a repaint
 * shows again) is never out of date.
 */
export type PeerSession = {
  id: string
  /** Its label, else its folder name; with a short id when two sessions share one. */
  name: string
  /** `working`: a live agent or a busy Lead. A session with no heartbeat for 20 s is closed, and not listed. */
  state: 'working' | 'idle'
  /** When it last did anything (0 when unknown): what ranks it, and what ends its dim floor. */
  activeAt: number
  /** Whole minutes since then, while idle. */
  idleMinutes?: number
  /** Why it has no floor: idle past the cutoff, or past the floor cap. Absent, it has one. */
  hiddenBy?: 'idle' | 'cap'
  /**
   * The time its floor is drawn at: now (to the second) while it works, its last activity
   * otherwise. Elapsed times count to it.
   */
  asOf: number
  lead: MainState
  rows: AgentRow[]
  spend: PeerSpend
  live: number
  done: number
  waiting: number
}

/** What the band says of the other sessions. */
export type PeerBand = {
  /** Other sessions with a live subagent. */
  sessions: number
  /** Their live subagents. */
  agents: number
  /** "Builder in mod-dock": other sessions' agents that wait on the person. */
  waiting: string[]
}

/** This session as the others see it, and the other sessions its pane shows expanded. */
export type SelfInfo = {
  /** The name set with `/radar name`; absent, the folder name stands. */
  label?: string
  /** The folder name of the project root, as last published. */
  project?: string
  /** The ids of the other sessions shown expanded. */
  expanded: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-radar': {
      skills: SkillUse[]
      agents: AgentRow[]
      /** `$.clock.now()` as of the last timer tick: it makes elapsed times tick. */
      now: number
      main: MainState
      settings: RouterSettings
      routes: RouteBook
      /** Tokens by route kind this session; it outlives pruned rows. */
      spend: Record<string, Spend>
      conflicts: Conflict[]
      /** Past outcomes from every session on this machine, read at start, added to at each agent's end. */
      outcomes: Outcome[]
      /** This session's `$.store` key for its outcomes. */
      storeKey: string
      view: ViewPrefs
      /** The other sessions on this machine, as of the live timer's last tick. */
      peers: PeerSession[]
      peerBand: PeerBand
      self: SelfInfo
    }
  }
}
