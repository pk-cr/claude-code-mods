// Hook tests: the plugin loaded by the engine's own host. The test's `on`
// hooks stand for core: `session.usage`, `ui.toast` and `command.register`
// are stand-ins; a pass-through `state.set` watches every write.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

import type { KeeperNudge } from '../types'
import { TEMPLATE_NOTE, USAGE } from './keeper'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const ANSWER = 'THE ANSWER'

type Fill = { tokens?: number; window: number; threshold?: number }

type World = {
  usage: Fill
  usageFails: boolean
  /** The `breakdown` argument of every `$.session.usage` call. */
  usageArgs: (string | undefined)[]
  toasts: string[]
  commands: string[]
  hints: (string | undefined)[]
  /** Every state write of the mod, as JSON. */
  writes: string[]
  /** The last value the mod wrote to each key. */
  state: Record<string, unknown>
}

/** Stands for the engine beneath the plugin. */
function engine(on: On): World {
  const world: World = {
    usage: { tokens: 100_000, window: 1_000_000, threshold: 800_000 },
    usageFails: false,
    usageArgs: [],
    toasts: [],
    commands: [],
    hints: [],
    writes: [],
    state: {},
  }
  on('session.usage', (_$, e) => {
    world.usageArgs.push(e.breakdown)
    if (world.usageFails) throw new Error('usage is down')
    const fill = world.usage
    const context: Record<string, unknown> = { window: fill.window }
    if (fill.tokens !== undefined) {
      context['tokens'] = fill.tokens
      context['percent'] = Math.round((fill.tokens / fill.window) * 100)
    }
    if (e.breakdown !== undefined) {
      context['breakdown'] = {
        categories: [],
        totalTokens: fill.tokens ?? 0,
        maxTokens: fill.window,
        rawMaxTokens: fill.window,
        percentage: 0,
        gridRows: [],
        model: 'claude-opus-5-5',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled: fill.threshold !== undefined,
        apiUsage: null,
        ...(fill.threshold === undefined ? {} : { autoCompactThreshold: fill.threshold }),
      }
    }

    return { value: { startedAt: 1, context, rateLimits: [] } as unknown as SessionUsage }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    world.commands.push(e.name)
    world.hints.push(e.argumentHint)

    return { value: { command: e.name } }
  })
  on('state.set', (_$, e, next) => {
    const write = e as unknown as { plugin: string; key: string; value: unknown }
    if (write.plugin === 'context-keeper') {
      world.state[write.key] = write.value
      world.writes.push(`${write.key}=${JSON.stringify(write.value) ?? 'undefined'}`)
    }

    return next(e)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  return world
}

const start = ($: Engine, surface: Surface) => $.session.start({ cwd: '/work', surface, isInteractive: true })

const turn = ($: Engine, more: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: ANSWER, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', ...more } as never)

const keeper = ($: Engine, args: string) =>
  $.command.run({ command: 'keeper', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const nudgeOf = (world: World): KeeperNudge => (world.state['nudge'] as KeeperNudge | undefined) ?? { level: 0 }

const at = (world: World, tokens: number, threshold = 800_000) => {
  world.usage = { tokens, window: 1_000_000, threshold }
}

describe('the toast', () => {
  for (const surface of SURFACES) {
    test(`at 60% and 75% of the point, once each, and again after the context drops (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      at(world, 200_000)
      await turn($)
      expect(world.toasts).toEqual([])
      // Under the cheap gate (30% of the window): no breakdown read.
      expect(world.usageArgs).toEqual([undefined])
      at(world, 496_000)
      await turn($)
      expect(world.toasts).toEqual([
        'context-keeper: context is at 62% of the compaction point. Run /compact at the end of this task, while the cache is warm.',
      ])
      expect(world.usageArgs.slice(1)).toEqual([undefined, 'summary'])
      at(world, 520_000)
      await turn($)
      expect(world.toasts).toHaveLength(1)
      at(world, 600_000)
      await turn($)
      expect(world.toasts).toHaveLength(2)
      expect(world.toasts[1]).toContain('at 75% of the compaction point')
      at(world, 700_000)
      await turn($)
      expect(world.toasts).toHaveLength(2)
      expect(nudgeOf(world)).toEqual({ level: 2, lastPoint: 800_000 })

      // A compaction: the context drops under the gate, the level resets.
      at(world, 40_000)
      await turn($)
      expect(nudgeOf(world).level).toBe(0)
      at(world, 496_000)
      await turn($)
      expect(world.toasts).toHaveLength(3)
    })

    test(`a drop that stays above the gate also resets the level (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      at(world, 550_000)
      await turn($)
      expect(nudgeOf(world).level).toBe(1)
      at(world, 300_000)
      await turn($)
      expect(nudgeOf(world).level).toBe(0)
      at(world, 500_000)
      await turn($)
      expect(world.toasts).toHaveLength(2)
    })

    test(`past the second level at once: one toast, not two (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      at(world, 700_000)
      await turn($)
      await turn($)
      expect(world.toasts).toHaveLength(1)
      expect(world.toasts[0]).toContain('at 88% of the compaction point')
      expect(nudgeOf(world).level).toBe(2)
    })

    test(`the gate uses the last point when it is below the window (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      // A low threshold: 150,000 tokens is 15% of the window but 75% of the point.
      at(world, 150_000, 200_000)
      await turn($)
      // No point known yet, so the first reading is gated on the window.
      expect(world.toasts).toEqual([])
      expect(world.usageArgs).toEqual([undefined])
      at(world, 310_000, 200_000)
      await turn($)
      expect(world.toasts).toHaveLength(1)
      at(world, 70_000, 200_000)
      await turn($)
      // 70,000 is 35% of the known point: past the gate, below 60%: a reset.
      expect(world.usageArgs.slice(-2)).toEqual([undefined, 'summary'])
      expect(nudgeOf(world).level).toBe(0)
      at(world, 130_000, 200_000)
      await turn($)
      expect(world.toasts).toHaveLength(2)
      expect(world.toasts[1]).toContain('at 65% of the compaction point')
    })

    test(`the threshold absent, the window is the point (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      world.usage = { tokens: 610_000, window: 1_000_000 }
      await turn($)
      expect(world.toasts[0]).toContain('at 61% of the compaction point')
    })

    test(`/keeper mode off silences it, mode ask brings it back (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      expect((await keeper($, 'mode off')).text).toBe('Mode for this session: off.')
      at(world, 650_000)
      await turn($)
      expect(world.toasts).toEqual([])
      expect(world.usageArgs).toEqual([])
      expect((await keeper($, 'mode ask')).text).toBe('Mode for this session: ask.')
      await turn($)
      expect(world.toasts).toHaveLength(1)
    })

    test(`subagent turns and turns that are not answers are ignored (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      at(world, 650_000)
      await turn($, { agentId: 'a1' })
      await turn($, { reason: 'aborted', isAborted: true })
      await turn($, { reason: 'error' })
      expect(world.toasts).toEqual([])
      expect(world.usageArgs).toEqual([])
    })
  }

  for (const surface of SURFACES) {
    test(`mode off from settings silences it (${surface})`, { options: { mode: 'off' } }, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      at(world, 700_000)
      await turn($)
      expect(world.toasts).toEqual([])
    })

    test(`other levels from settings (${surface})`, { options: { nudgeAtPercent: 50, nudgeAgainAtPercent: 70 } }, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      at(world, 400_000)
      await turn($)
      at(world, 560_000)
      await turn($)
      expect(world.toasts).toHaveLength(2)
      expect(world.toasts[0]).toContain('at 50% of the compaction point')
    })
  }
})

describe('turn.complete', () => {
  for (const surface of SURFACES) {
    test(`returns what next returned, unchanged, in every case (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      at(world, 496_000)
      expect(await turn($)).toEqual({ text: ANSWER })
      expect(world.toasts).toHaveLength(1)
      expect(await turn($, { agentId: 'a1' })).toEqual({ text: ANSWER })
      expect(await turn($, { reason: 'aborted', isAborted: true })).toEqual({ text: ANSWER })
      world.usageFails = true
      expect(await turn($)).toEqual({ text: ANSWER })
      world.usageFails = false
      world.usage = { window: 1_000_000 }
      expect(await turn($)).toEqual({ text: ANSWER })
    })
  }
})

describe('/keeper', () => {
  for (const surface of SURFACES) {
    test(`registers one command with an argument hint (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      expect(world.commands).toEqual(['keeper'])
      expect(world.hints).toEqual(['[mode ask|off]'])
    })

    test(`status, and the commands of 0.1.x answer with the usage (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      at(world, 496_000)
      await turn($)
      const status = (await keeper($, '')).text ?? ''
      expect(status).toContain('Mode: ask (from settings): a toast asks you to run /compact at 60% and 75% of the compaction point.')
      expect(status).toContain('Context: 496,000 tokens, 62% of the compaction point (800,000 tokens, the auto-compact threshold).')
      expect(status).toContain('Toasts: the first toast showed.')
      expect(status).toContain(TEMPLATE_NOTE)
      for (const gone of ['compact', 'tail 1', 'pin a note', 'unpin', 'template', 'frobnicate']) expect((await keeper($, gone)).text).toBe(USAGE)
      expect((await keeper($, 'mode auto')).text).toContain('Mode must be ask or off.')
      world.usageFails = true
      expect((await keeper($, '')).text).toContain('Context: not known yet.')
    })

    test(`state holds the mode, the level and the point only (${surface})`, async ($, on) => {
      const world = engine(on)
      await start($, surface)
      at(world, 550_000)
      await turn($)
      await keeper($, 'mode off')
      expect(Object.keys(world.state).sort()).toEqual(['nudge', 'settings'])
      expect(world.writes).toEqual(['nudge={"level":1,"lastPoint":800000}', 'settings={"mode":"off"}'])
    })
  }
})

const FORBIDDEN = [
  'model.complete',
  'model.classify',
  'model.fork',
  'mcp.call',
  'mcp.connect',
  'http.fetch',
  'process.run',
  'fs.read',
  'fs.write',
  'fs.list',
  'fs.exists',
  'fs.stat',
  'fs.ancestors',
  'store.get',
  'store.set',
  'store.delete',
  'store.keys',
  'env.get',
  'env.set',
  'session.messages',
  'tool.register',
  'agent.register',
  'audio.play',
  'audio.speak',
  'session.compact',
]

describe('egress', () => {
  for (const surface of SURFACES) {
    test(`no network, model, process, file, store, transcript or compaction call on any path (${surface})`, async ($, on) => {
      const world = engine(on)
      const hits: string[] = []
      const stand = on as unknown as (event: string, hook: () => never) => void
      for (const op of FORBIDDEN) {
        stand(op, () => {
          hits.push(op)
          throw new Error(`context-keeper must not call ${op}`)
        })
      }
      await start($, surface)
      for (const tokens of [100_000, 496_000, 600_000, 700_000, 40_000, 650_000]) {
        at(world, tokens)
        await turn($)
      }
      await turn($, { agentId: 'a1' })
      for (const args of ['', 'mode off', 'mode ask', 'compact', 'nonsense']) await keeper($, args)
      expect(hits).toEqual([])
      expect(world.usageArgs.every(arg => arg === undefined || arg === 'summary')).toBe(true)
    })
  }
})
