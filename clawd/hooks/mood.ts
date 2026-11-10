// Which scene Clawd shows, from what the session is doing. Pure code: no `$`.

import type { Scene } from '../types'
import { DONE_MS } from './scene'

/** A tool's last use counts this long while the main turn runs. */
export const TOOL_FRESH_MS = 20_000
/** An `ask` verdict shows as "waiting" only after this long (an auto-mode classifier answers sooner). */
export const WAIT_DELAY_MS = 1_500
/** After the party Clawd relaxes this long, then idles. */
export const RELAX_MS = 4 * 60_000
/** Scenes inside one turn change at most this often: each change redraws the whole band. */
export const HOLD_MS = 4_000
/** A subagent with no turn or tool call for this long is taken to have ended. */
export const AGENT_STALE_MS = 15 * 60_000

/** Tools that always wait on the person. */
export const PERSON_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

export type ToolScene = 'read' | 'terminal' | 'write' | 'web' | 'delegate' | 'working'

/** The scene a main-loop tool call shows. */
export function toolScene(tool: string): ToolScene {
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(tool)) return 'read'
  if (['Bash', 'BashOutput', 'KillShell', 'Monitor', 'PowerShell'].includes(tool)) return 'terminal'
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) return 'write'
  if (['WebFetch', 'WebSearch'].includes(tool) || /^mcp__.*(browser|chrome)/i.test(tool)) return 'web'
  if (tool === 'Agent' || tool === 'Task') return 'delegate'

  return 'working'
}

export type Facts = {
  /** The main loop has a turn running. */
  busy: boolean
  /** The main loop's last tool call in this turn. */
  tool?: { scene: ToolScene; at: number }
  /** When the oldest open `ask` began. */
  waitingSince?: number
  /** Subagents running. */
  agents: number
  /** When the last main turn ended with an answer. */
  doneAt?: number
}

export function sceneFor(f: Facts, now: number): Scene {
  if (f.waitingSince !== undefined && now - f.waitingSince >= WAIT_DELAY_MS) return 'waiting'
  if (f.busy) {
    if (f.tool !== undefined && now - f.tool.at < TOOL_FRESH_MS) return f.tool.scene
    return f.agents > 0 ? 'delegate' : 'working'
  }
  if (f.doneAt !== undefined && now - f.doneAt < DONE_MS) return 'done'
  if (f.agents > 0) return 'delegate'
  if (f.doneAt !== undefined && now - f.doneAt < DONE_MS + RELAX_MS) return 'relax'

  return 'idle'
}

const WORK: ReadonlySet<Scene> = new Set(['working', 'read', 'terminal', 'write', 'web', 'delegate'])

/**
 * A change shown at once; any other waits out HOLD_MS (one tool scene to the next inside a turn).
 * The plain working scene gives way at once to the first tool's own scene.
 */
export function isUrgent(from: Scene | undefined, to: Scene): boolean {
  return from === undefined || from === 'working' || !WORK.has(from) || !WORK.has(to)
}

/** The soonest time after `now` at which time alone changes the scene, if any. */
export function nextChange(f: Facts, now: number): number | undefined {
  const times: number[] = []
  if (f.waitingSince !== undefined) times.push(f.waitingSince + WAIT_DELAY_MS)
  if (f.busy && f.tool !== undefined) times.push(f.tool.at + TOOL_FRESH_MS)
  if (!f.busy && f.doneAt !== undefined) times.push(f.doneAt + DONE_MS, f.doneAt + DONE_MS + RELAX_MS)
  const later = times.filter(t => t > now)

  return later.length === 0 ? undefined : Math.min(...later)
}
