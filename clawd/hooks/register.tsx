// Clawd: a pixel mascot at the right end of the band above the prompt. Its scene follows the
// session: working (by tool), waiting on you, delegating to subagents, a party when a turn ends,
// then relaxing, then idle. It draws beside whatever the other mods put in the band (`next(e)`),
// never in place of it, and only on the desktop and VS Code surfaces (they draw SVG).
// It reads no file, runs no process and sends nothing out.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Scene } from '../types'
import { AGENT_STALE_MS, PERSON_TOOLS, WAIT_DELAY_MS, HOLD_MS, isUrgent, nextChange, sceneFor, toolScene } from './mood'
import type { Facts, ToolScene } from './mood'
import { ALT, SCENE_HEIGHT, SCENE_WIDTH, sceneSvg } from './scene'

const scene = atom({ plugin: 'clawd', key: 'scene' } as const, 'idle' as Scene)

/** Below this many band columns Clawd steps aside, so the other mods keep their width. */
export const MIN_COLUMNS = 70

// What the session is doing, in module memory: a reload starts it over, and the next event refills it.
let busy = false
let tool: { scene: ToolScene; at: number } | undefined
let doneAt: number | undefined
/** Open asks, by tool call: when each began and the loop it is in. */
const pending = new Map<string, { since: number; agentId: string | undefined }>()
/** Running subagents, by id: when each was last heard from. */
const agents = new Map<string, number>()
/** The scene last written, and when; undefined until this load writes one. */
let shown: Scene | undefined
let shownAt = 0
/** When the one pending timer fires, if one is set. */
let wakeAt: number | undefined

function factsAt(now: number): Facts {
  for (const [id, seen] of agents) if (now - seen > AGENT_STALE_MS) agents.delete(id)
  const since = [...pending.values()].map(p => p.since)

  return {
    busy,
    tool,
    waitingSince: since.length === 0 ? undefined : Math.min(...since),
    agents: agents.size,
    doneAt,
  }
}

// Works out the scene and writes it when it changed. Each write redraws the whole band (and hands
// the other mods' buttons new press handles), so a change between two work scenes waits HOLD_MS.
async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const facts = factsAt(now)
  const want = sceneFor(facts, now)
  let wake = nextChange(facts, now)
  if (want !== shown) {
    if (isUrgent(shown, want) || now - shownAt >= HOLD_MS) {
      shown = want
      shownAt = now
      await update($, scene, () => want)
    } else {
      const held = shownAt + HOLD_MS
      wake = wake === undefined ? held : Math.min(wake, held)
    }
  }
  if (wake !== undefined && (wakeAt === undefined || wake < wakeAt || wakeAt <= now)) {
    wakeAt = wake
    $.clock.after(Math.max(1, wake - now), () => {
      if (wakeAt === wake) wakeAt = undefined
      void refresh($).catch(() => {})
    })
  }
}

// A failed refresh must never fail the event it rode on.
async function settle($: EngineInterface): Promise<void> {
  await refresh($).catch(() => {})
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await settle($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      agents.set(e.agentId, now)
    } else {
      busy = true
      tool = undefined
      doneAt = undefined
    }
    await settle($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      agents.delete(e.agentId)
      for (const [id, p] of pending) if (p.agentId === e.agentId) pending.delete(id)
    } else {
      busy = false
      tool = undefined
      for (const [id, p] of pending) if (p.agentId === undefined) pending.delete(id)
      doneAt = e.reason === 'answer' && !e.isAborted ? now : undefined
    }
    await settle($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const now = await $.clock.now()
    const id = e.tool_use_id
    if (e.agentId !== undefined) {
      agents.set(e.agentId, now)
    } else if (busy) {
      tool = { scene: toolScene(e.tool), at: now }
    }
    // A question or a plan to approve waits on the person from the start.
    if (id !== undefined && PERSON_TOOLS.has(e.tool)) pending.set(id, { since: now - WAIT_DELAY_MS, agentId: e.agentId })
    await settle($)
    try {
      return await next(e)
    } finally {
      if (id !== undefined && pending.delete(id)) await settle($)
    }
  }).catch(($, e, next) => next(e))

  // An `ask` verdict puts the call to the person (or to the auto-mode classifier, which answers
  // inside WAIT_DELAY_MS). The verdict passes on unchanged.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      pending.set(e.tool_use_id, { since: await $.clock.now(), agentId: e.agentId })
      await settle($)
    }

    return verdict
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (e.surface !== 'desktop' && e.surface !== 'vscode')) return next(e)
    if (e.props.bodyColumns < MIN_COLUMNS) return next(e)
    const now = await read($, scene)
    // Another mod may draw this band too: theirs fills the left, Clawd keeps the right end.
    const below = await next(e)
    const { Box, Svg } = $.ui.resolve(e as typeof e & { surface: 'desktop' })

    return (
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {below}
        </Box>
        <Svg key="clawd" source={sceneSvg(now)} alt={ALT[now]} width={SCENE_WIDTH} height={SCENE_HEIGHT} isInteractive />
      </Box>
    )
  })
}
