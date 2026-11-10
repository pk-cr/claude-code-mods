/** What a session is doing, as Pulse shows it. `offline` is only ever a reader's verdict on another session's file. */
export type PulseState = 'needs' | 'working' | 'failed' | 'ready' | 'idle' | 'offline'

/** One row of the board: the glyph comes from `state`, always drawn left of `title`. */
export type Row = {
  /** The session id; for this session too. */
  id: string
  title: string
  state: PulseState
  /** The status words: `Approve Bash`, `Thinking`, `Ready`. */
  words: string
  /** The time column: `waited 6m`, `2m`, `3m ago`. Moves in whole minutes, so a row redraws at most once a minute. */
  time: string
  isSelf: boolean
}

/** How many sessions are in each state. */
export type Counts = Record<PulseState, number>

/** Everything the pane and the band draw, worked out by one writer and written only when it changed. */
export type View = {
  /** This session's own row; null before the first look. */
  self: Row | null
  /** The other sessions shown, sorted: needs you, working, failed, ready, idle, offline. */
  rows: Row[]
  /** The line for the rows left out (`+4 idle, 2 offline`), or ''. */
  folded: string
  /** The other sessions only. */
  counts: Counts
  /** The other session that has waited on you longest, for the band and `/pulse next`. */
  oldestNeed: Row | null
  /** One line on the pin while waiting: off, on, or why it stopped. */
  pin: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-pulse': { view: View }
  }
}
