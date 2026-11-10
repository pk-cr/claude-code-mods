// State contract of usage-meter: what its hooks write and its drawings read.
// Every value is plain data, so the host can hold it across a hot reload.
// It holds token counts, dollar estimates, model ids, agent types and short
// agent labels. It never holds a prompt, an answer or any thinking text.

/** What one bucket (the main loop, one agent, one model) has used. `usd` counts priced turns only. */
export type Tally = {
  /** Uncached input tokens. */
  i: number
  /** Output tokens. */
  o: number
  /** Cache read tokens. */
  r: number
  /** Cache write tokens. */
  w: number
  /** Estimated dollars from the price table. */
  usd: number
  /** Loop turns counted. */
  n: number
  /** Turns whose model has no price: their tokens are in the counts, not in `usd`. */
  np: number
}

/** One agent loop: a subagent, a fork or a teammate, as `$.agent.list()` names it. */
export type AgentRow = {
  id: string
  parent?: string
  /** The agent type (`Explore`, `general-purpose`, `fork`, `teammate`, a plugin's agent). */
  type: string
  /** The Agent call's own few-word description, clipped. Session state only. */
  label: string
  name?: string
  /** The model its last turn named, with any date suffix removed. */
  model?: string
  /** `$.agent.list()`'s word for where the loop stands. */
  status: string
  t: Tally
  /** How many times its loop ran (a resumed agent runs again). */
  runs: number
  first: number
  last: number
  teammate?: boolean
  /** The plugin that spawned it, when a plugin did. */
  by?: string
  /** Cache hit rate of its first run, 0 to 1: a fork that paid for its whole prefix reads low. */
  firstHit?: number
}

/** What accrued from agents since the last turn ended (for the per-turn footer). */
export type Win = { agents: number }

/** What the pane's Diagnostics block shows: the facts that settle the open questions. */
export type Diag = {
  withUsage: number
  noUsage: number
  /** Distinct model ids as the API reported them (at most 12). */
  models: string[]
  /** Agent ids that raised a turn and that `$.agent.list()` does not name (at most 10). */
  sysIds: string[]
  /** Turns without usage, by their end reason. */
  reasons: Record<string, number>
}

/** Everything the turn events add up to. */
export type Ledger = {
  /** `$.session.usage().startedAt` of the session it counts, 0 until known. */
  key: number
  /** The engine's cost total before this ledger began (a resume, or the mod enabled mid-session). */
  base: number | null
  main: Tally
  /** Loops that raised a turn but that no agent list names (engine forks, workflows). */
  system: Tally
  /** Old finished agents folded away to keep the state small. */
  folded: Tally
  foldedN: number
  agents: Record<string, AgentRow>
  models: Record<string, Tally>
  win: Win
  diag: Diag
}

/** `[time in ms, percent used]`. */
export type Sample = [number, number]

/** One rate-limit window. */
export type Limit = {
  s: Sample[]
  resetsAt?: string
  /** Change in points at the last sample. */
  d: number
}

/** What the rate-limit kinds say about the account. */
export type Account = 'subscription' | 'gateway' | 'unknown'

/** The context window as last measured. */
export type Ctx = {
  tokens?: number
  window: number
  percent?: number
  /** Moving average of the growth per measure, in tokens. */
  growth: number
  /** The used categories of the summary breakdown, largest first. */
  cats: [string, number][]
  /** The token count where auto-compaction runs. */
  threshold?: number
}

/** What `session.measure` and `$.session.usage()` last said. */
export type Live = {
  /** The engine's cost total. */
  usd?: number
  account: Account
  measures: number
  at: number
  ctx: Ctx
  limits: Record<string, Limit>
}

export type ViewId = 'overview' | 'models' | 'agents' | 'diag'

/** The person's choices and the alert memory. */
export type Ui = {
  view: ViewId
  footer: boolean
  /** The highest level each alert announced, so a reload does not announce it again. */
  alerts: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      ledger: Ledger
      live: Live
      ui: Ui
    }
  }
}
