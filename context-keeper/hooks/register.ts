// context-keeper: a toast before the compaction point, while the cache is warm.
//
// After a main answer, at 60% and again at 75% of the compaction point, a
// toast asks for /compact at the end of the task. /keeper shows the status.
//
// Why so little (engine 2.1.299): where an organization manages Claude Code,
// the engine skips the `session.compact` and `prompt.*` hooks of a plugin a
// person installs, and in the desktop app (an SDK host) `$.session.compact`
// always rejects. The handoff template therefore lives in CLAUDE.md under
// "# Compact Instructions", and the engine keeps the last messages itself.
//
// Privacy: it reads token counts only. State holds the mode, the toast level
// and the last compaction point. It makes no network, file, store, process or
// model call.

import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, Register, TurnCompleteReason } from 'claude-code'

import type { KeeperMode } from '../types'
import { GATE, gateBase, knobsOf, nudgeOf, nudgeStep, nudgeText, optionsOf, parseKeeper, pointOf, settingsOf, statusText } from './keeper'
import type { Knobs, Options } from './keeper'

const settings = atom({ plugin: 'context-keeper', key: 'settings' } as const, {})
const nudge = atom({ plugin: 'context-keeper', key: 'nudge' } as const, { level: 0 })

async function knobsNow($: EngineInterface, options: Options): Promise<Knobs> {
  try {
    return knobsOf(options, settingsOf(await read($, settings)))
  } catch {
    return knobsOf(options, {})
  }
}

async function writeMode($: EngineInterface, mode: KeeperMode): Promise<void> {
  await update($, settings, value => ({ ...settingsOf(value), mode }))
}

/** The breakdown's point: the auto-compact threshold, else the window; undefined when unknown. */
async function breakdownPoint($: EngineInterface): Promise<{ tokens?: number; point?: number; isThreshold: boolean }> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const point = pointOf(usage?.context)

    return { tokens: usage?.context?.tokens, point, isThreshold: point !== undefined && point === usage?.context?.breakdown?.autoCompactThreshold }
  } catch {
    return { isThreshold: false }
  }
}

/** Below the cheap gate: the level back to 0 when it is not 0 yet. */
async function resetLevel($: EngineInterface): Promise<void> {
  if (nudgeOf(await read($, nudge)).level === 0) return
  await update($, nudge, value => ({ ...nudgeOf(value), level: 0 as const }))
}

/** Moves the level for this fill and keeps the point. True when a toast is due. */
async function stepNudge($: EngineInterface, fill: number, point: number, knobs: Knobs): Promise<boolean> {
  let isDue = false
  await update($, nudge, value => {
    const now = nudgeOf(value)
    const step = nudgeStep(now.level, fill, knobs.nudgeAt, knobs.nudgeAgainAt)
    isDue = step.fire

    return { level: step.level, lastPoint: point }
  })

  return isDue
}

/** After a main answer: the toast when the fill calls for it. Never throws. */
async function afterMainTurn($: EngineInterface, reason: TurnCompleteReason, options: Options): Promise<void> {
  try {
    if (reason !== 'answer') return
    const knobs = await knobsNow($, options)
    if (knobs.mode === 'off') return
    const plain = await $.session.usage()
    const tokens = plain?.context?.tokens
    const window = plain?.context?.window
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || typeof window !== 'number' || !(window > 0)) return
    if (tokens / gateBase(window, nudgeOf(await read($, nudge)).lastPoint) < GATE) {
      await resetLevel($)

      return
    }
    const { point } = await breakdownPoint($)
    if (point === undefined) return
    const fill = tokens / point
    if (await stepNudge($, fill, point, knobs)) $.ui.toast(nudgeText(fill))
  } catch {
    // A failure here must never affect the turn.
  }
}

async function keeperStatus($: EngineInterface, options: Options): Promise<string> {
  const knobs = await knobsNow($, options)
  const { tokens, point, isThreshold } = await breakdownPoint($)
  let level: 0 | 1 | 2 = 0
  try {
    level = nudgeOf(await read($, nudge)).level
  } catch {
    // Unknown: shown as 0.
  }

  return statusText({ knobs, tokens, point, isThreshold, level })
}

async function runKeeper($: EngineInterface, args: string, options: Options): Promise<CommandRunResult> {
  const asked = parseKeeper(args)
  switch (asked.kind) {
    case 'status':
      return { text: await keeperStatus($, options) }
    case 'mode':
      await writeMode($, asked.mode)

      return { text: `Mode for this session: ${asked.mode}.` }
    case 'bad':
      return { text: asked.text }
  }
}

async function registerKeeper($: EngineInterface): Promise<void> {
  try {
    await $.command.register({
      name: 'keeper',
      description: 'context-keeper: context fill and the compaction toast',
      argumentHint: '[mode ask|off]',
    })
  } catch {
    // Without the command the toast still works.
  }
}

export const register: Register = (on, raw) => {
  const options = optionsOf(raw)

  on('session.start', async ($, e, next) => {
    await registerKeeper($)

    return next(e)
  })

  on('command.run', { command: 'keeper' }, async ($, e) => runKeeper($, e.args, options))

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId === undefined) await afterMainTurn($, e.reason, options)

    return ended
  })
}
