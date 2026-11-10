/** The scene Clawd shows in the band. */
export type Scene =
  | 'idle'
  | 'relax'
  | 'done'
  | 'working'
  | 'read'
  | 'terminal'
  | 'write'
  | 'web'
  | 'waiting'
  | 'delegate'

declare module 'claude-code' {
  interface PluginState {
    clawd: { scene: Scene }
  }
}
