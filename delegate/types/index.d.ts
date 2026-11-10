// State contract of delegate: what its hooks write.
// Every value is plain data, so the host can hold it across a hot reload.
// It holds counts, token totals, percentages and task keys (an agent type and a
// hash of the description). It never holds a prompt, an answer, a description or
// any thinking text.

/** Why a call was refused. Each word is one counter. */
export type DenyKind = 'vague' | 'untagged' | 'nested' | 'live' | 'turn' | 'session'

/** What the hooks counted for one session. The shape counters read the brief as the model sent it. */
export type Counts = {
  /** `$.session.usage().startedAt` of the session it counts, 0 until known. */
  key: number
  /** Agents the engine started and this mod counted (forks, teammates and workflow agents are left out). */
  spawns: number
  /** Briefs judged: the ones sent to a general-purpose, Explore or Plan agent. */
  checked: number
  /** Of the judged briefs: how many carried each part when the model sent them. */
  tag: number
  scope: number
  done: number
  ret: number
  nospawn: number
  /** Briefs that got the contract footer. */
  footers: number
  denied: Record<DenyKind, number>
  /** Notes sent to the model about a read-heavy run. */
  nudges: number
  /** Main turns that reached the read-heavy line. */
  triggers: number
  /** Of those turns: the ones that started an agent before they ended. */
  triggersDelegated: number
  /** Main turns that started two or more agents. */
  multi: number
  /** Of those turns: the ones whose agents all started within a few seconds of each other. */
  multiParallel: number
  /** Subagent turns that ended with no answer. */
  empty: number
  /** Subagent input, cache-write and output tokens. Cache reads are not counted. */
  tokens: number
}

/** What the rate-limit windows and the token total last said, and which warnings already showed. */
export type Gate = {
  /** The five-hour window, percent used. */
  five?: number
  /** The seven-day window, percent used. */
  seven?: number
  /** 0 nothing, 1 warning shown, 2 alert shown. Falls back to 0 when the value falls below the warning. */
  fiveLevel: number
  tokenLevel: number
}

/** Keys of tasks that were denied once: an agent type and a hash, no text. A retry with the same key goes through. At most 40. */
export type Seen = string[]

/** The person's runtime switch: /delegate on | off. */
export type Control = { on: boolean }

declare module 'claude-code' {
  interface PluginState {
    delegate: {
      counts: Counts
      gate: Gate
      seen: Seen
      control: Control
    }
  }
}
