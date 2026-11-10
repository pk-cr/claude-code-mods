// State contract of context-keeper: what its hooks write to `$.state`.
// It holds the mode, the toast level and a token count. Never message text.

/** Whether the toast shows. */
export type KeeperMode = 'ask' | 'off'

/** Values the person set for this session with /keeper. They override `userConfig`. */
export type KeeperSettings = {
  mode?: KeeperMode
}

/** Where the toasts stand. */
export type KeeperNudge = {
  /** 0: no toast yet; 1: the first toast showed; 2: the second toast showed. */
  level: 0 | 1 | 2
  /** The compaction point at the last reading, in tokens. */
  lastPoint?: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-keeper': {
      settings: KeeperSettings
      nudge: KeeperNudge
    }
  }
}
