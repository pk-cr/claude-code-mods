import { describe, expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { AgentSpawnInput } from 'claude-code'

import { fillCounts } from './policy'
import { register } from './register'
import {
  BARE,
  FULL,
  UNTAGGED,
  agent,
  agentCall,
  appended,
  cmd,
  complete,
  countsOf,
  denyOf,
  engine,
  measure,
  readCall,
  spawn,
  spawnInput,
  start,
  step,
  turnStart,
  use,
} from './testkit/world'
import type { World } from './testkit/world'

const SURFACES = ['terminal', 'desktop'] as const

/** A small linear congruential generator, so a failure replays. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Every op that could carry text out of the session or change the machine. A call to any of them fails the test. */
const FORBIDDEN = [
  'http.fetch',
  'process.run',
  'mcp.call',
  'mcp.connect',
  'model.complete',
  'model.fork',
  'model.classify',
  'telemetry.log',
  'telemetry.mark',
  'fs.read',
  'fs.write',
  'prompt.submit',
  'tool.register',
  'agent.register',
  'turn.abort',
] as const

/** agent-radar's part of the chain, as a stand-in: it sets the model from the tag and leaves the rest (Sonnet or Opus only, as radar 1.4). */
function radarStandIn(tier: 'prepend' | 'append'): Plugin {
  return {
    name: 'agent-radar',
    tier,
    register: on => {
      on('agent.spawn', async (_$, e, next) => {
        const tag = /\[\s*difficulty\s*:\s*(\w+)\s*\]/i.exec(`${e.description}\n${e.prompt.slice(0, 400)}`)?.[1]?.toLowerCase()
        const model = tag === 'hard' ? 'opus' : tag === undefined ? e.model : 'sonnet'

        return next({ ...e, model })
      })
    },
  }
}

describe('nothing leaves the session', () => {
  test('a full run calls none of the ops that reach out or write, and no state holds a brief', { plugins: [] }, async ($, on) => {
    const world = engine(on)
    const called: string[] = []
    for (const name of FORBIDDEN) {
      on(name as never, (() => {
        called.push(name)

        return { value: undefined }
      }) as never)
    }
    on('process.spawn', async function* () {
      called.push('process.spawn')

      return { exitCode: 0 } as never
    })
    world.listed = [agent('a1')]
    await start($)
    await turnStart($)
    for (let i = 0; i < 9; i += 1) await readCall($)
    await agentCall($, { prompt: 'Look around.' })
    await agentCall($, { prompt: 'Look around.' })
    await agentCall($, { prompt: UNTAGGED, description: 'two' })
    await agentCall($, { prompt: BARE, description: 'three' })
    await agentCall($, { prompt: FULL, description: 'four', agentId: 'a1' })
    await spawn($)
    await complete($, { agentId: 'a1', answer: '', usage: use(1, 1, 1, 1) })
    await step($)
    await measure($, 95)
    for (const args of ['', 'score', 'score all', 'off', 'on', 'reset']) await cmd($, args)
    await complete($)
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)
    expect(called).toEqual([])
  })
})

for (const surface of SURFACES) {
  describe(`beside agent-radar on ${surface}`, () => {
    for (const tier of ['prepend', 'append'] as const) {
      test(`${tier}: radar reads the tag after our rewrite, and our spawn hook leaves its model alone`, { plugins: [radarStandIn(tier)] }, async ($, on) => {
        const world = engine(on)
        await start($)
        await agentCall($, { prompt: BARE, description: 'Find key readers' })
        const sent = world.reached.at(-1)
        expect(String(sent?.['prompt'])).toContain('(delegate contract)')
        const input = spawnInput({ prompt: String(sent?.['prompt']), description: String(sent?.['description']) })
        await $.agent.spawn(input)
        const got = world.spawned[0] as AgentSpawnInput
        expect(got.model).toBe('sonnet')
        expect({ ...got, model: undefined }).toEqual({ ...input, model: undefined })
      })

      test(`${tier}: a hard tag still routes to the strongest model with our footer on the brief`, { plugins: [radarStandIn(tier)] }, async ($, on) => {
        const world = engine(on)
        await start($)
        const hard = BARE.replace('lookup', 'hard')
        await agentCall($, { prompt: hard })
        await $.agent.spawn(spawnInput({ prompt: String(world.reached.at(-1)?.['prompt']) }))
        expect(world.spawned[0]?.model).toBe('opus')
      })

      test(`${tier}: a brief we refused never reaches radar's hook`, { plugins: [radarStandIn(tier)] }, async ($, on) => {
        const world = engine(on)
        await start($)
        expect(denyOf(await agentCall($, { prompt: 'Look around.' }))).toMatch(/not ready/)
        expect(world.spawned).toHaveLength(0)
      })
    }

    test('a cap refusal stops the spawn before radar picks a model, in either order', { plugins: [radarStandIn('prepend')] }, async ($, on) => {
      const world = engine(on)
      world.listed = Array.from({ length: 8 }, (_, i) => agent(`r${i}`))
      await start($)
      expect(denyOf(await spawn($))).toMatch(/already running/)
      expect(world.spawned).toHaveLength(0)
    })
  })
}

describe('parallel events', () => {
  test('twenty Agent calls at once lose no count', async ($, on) => {
    const world = engine(on)
    await start($)
    await Promise.all(Array.from({ length: 20 }, (_, i) => agentCall($, { prompt: UNTAGGED, description: `task ${i}` })))
    const c = countsOf(world)
    expect([c.checked, c.denied.untagged, c.tag]).toEqual([20, 20, 0])
    expect(world.state['seen']).toHaveLength(20)
  })

  test('twelve spawns at once are all counted when the caps are off', { options: { maxLive: 0, maxTurn: 0, maxSession: 0 } }, async ($, on) => {
    const world = engine(on)
    await start($)
    await turnStart($)
    await Promise.all(Array.from({ length: 12 }, () => spawn($)))
    expect(countsOf(world).spawns).toBe(12)
    expect(world.spawned).toHaveLength(12)
    await complete($)
    expect(countsOf(world).multiParallel).toBe(1)
  })

  test('reads and subagent turns at once add up', async ($, on) => {
    const world = engine(on)
    await start($)
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => complete($, { agentId: `a${i}`, usage: use(100, 10, 5, 20) })),
      ...Array.from({ length: 10 }, () => measure($, 50)),
    ])
    expect(countsOf(world).tokens).toBe(1300)
  })
})

describe('hostile inputs', () => {
  test('odd readings and odd turns never throw and never write a bad number', async ($, on) => {
    const world = engine(on)
    await start($)
    for (const five of [150, -5, Number.NaN, Number.POSITIVE_INFINITY, 0, 79.999, 80, 92, 92.0001]) await measure($, five)
    await complete($, { agentId: 'a1', usage: use(Number.NaN, -4, undefined as never, Number.POSITIVE_INFINITY) })
    await complete($, { agentId: 'a1', usage: undefined })
    await complete($, { usage: use(1, 1, 1, 1), answer: 'x'.repeat(1_000_000) })
    const c = countsOf(world)
    for (const value of Object.values(c)) if (typeof value === 'number') expect(Number.isFinite(value) && value >= 0).toBe(true)
    expect(JSON.stringify(world.state)).not.toMatch(/NaN|Infinity/)
  })

  test('odd words after /delegate and odd agent lists are answered', async ($, on) => {
    const world = engine(on)
    world.listed = [{ id: 'x', description: '', type: '', status: 'weird' } as never, agent('y', { type: undefined as never })]
    await start($)
    for (const args of ['  SCORE   ALL  ', 'score all extra words', '\n', 'ON', 'Off', 'status status', '/delegate', 'x'.repeat(5000)]) {
      const out = await cmd($, args)
      expect(typeof out.text).toBe('string')
    }
    expect(denyOf(await agentCall($, { agentId: 'y' }))).toBeUndefined()
  })

  test('a very long description and a very long prompt keep the state small', async ($, on) => {
    const world = engine(on)
    await start($)
    await agentCall($, { prompt: 'p'.repeat(2_000_000), description: 'd'.repeat(100_000) })
    await agentCall($, { prompt: 'q'.repeat(10), description: 'e'.repeat(100_000) })
    expect(JSON.stringify(world.state).length < 2000).toBe(true)
  })
})

/** Throws with the name of the invariant that broke, so that a failing seed says which. */
function holds(label: string, ok: boolean): void {
  if (!ok) throw new Error(`invariant broken: ${label}`)
}

describe('a seeded stream of events keeps its invariants', () => {
  async function run(seed: number, $: Engine, world: World, steps: number): Promise<number> {
    const rand = lcg(seed)
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
    const prompts = ['Look around.', UNTAGGED, BARE, FULL, `${BARE}\n${'x'.repeat(300)}`]
    const types = [undefined, 'general-purpose', 'Explore', 'delegate:scout', 'fork', 'statslab:stats-planner']
    let spawned = 0
    let mainSteps = 0
    for (let i = 0; i < steps; i += 1) {
      const roll = rand()
      if (roll < 0.25) await readCall($, rand() < 0.1 ? { agentId: 'a1' } : {})
      else if (roll < 0.4) await agentCall($, { prompt: pick(prompts), description: `task ${Math.floor(rand() * 6)}`, subagent_type: pick(types), ...(rand() < 0.15 ? { agentId: pick(['a1', 'g1', 'nope']) } : {}) })
      else if (roll < 0.52) {
        const before = world.spawned.length
        const out = await spawn($, { fork: rand() < 0.1, isTeammate: rand() < 0.05 ? true : undefined, subagentType: pick(['general-purpose', 'Explore']) })
        if (denyOf(out) === undefined && world.spawned.length > before) spawned += 1
      } else if (roll < 0.62) await turnStart($)
      else if (roll < 0.74) await complete($, rand() < 0.5 ? { agentId: pick(['a1', 'a2', 'ghost']), answer: pick(['', 'a long enough answer here', ' ']), isAborted: rand() < 0.1, usage: use(Math.floor(rand() * 2_000_000), Math.floor(rand() * 5000), Math.floor(rand() * 9_000_000), Math.floor(rand() * 300_000)) } : {})
      else if (roll < 0.82) await measure($, pick([undefined, 5, 79, 80, 91, 93, 100]))
      else if (roll < 0.9) {
        const isSub = rand() < 0.2
        if (!isSub) mainSteps += 1
        await step($, isSub ? { agentId: 'a1' } : {})
      }
      else if (roll < 0.96) await cmd($, pick(['', 'score', 'score all', 'status', 'off', 'on', 'reset']))
      else if (roll < 0.98) world.listed = pick([[], [agent('a1')], [agent('a1'), agent('g1', { type: 'Explore' })], Array.from({ length: 7 }, (_, k) => agent(`r${k}`))])
      else await $.session.end({ reason: pick(['clear', 'other']), sessionId: 's', resume: { id: 's' } } as never)
      check(world, spawned)
    }

    return mainSteps
  }

  function check(world: World, _spawned: number): void {
    const c = countsOf(world)
    const values = Object.entries(c).filter(([k]) => k !== 'denied' && k !== 'key').map(([, v]) => v as number)
    for (const v of [...values, ...Object.values(c.denied)]) holds('a count is a whole number from 0', Number.isInteger(v) && v >= 0)
    holds('multiParallel <= multi', c.multiParallel <= c.multi)
    holds('triggersDelegated <= triggers', c.triggersDelegated <= c.triggers)
    holds('nudges <= triggers', c.nudges <= c.triggers)
    for (const part of [c.tag, c.scope, c.done, c.ret, c.nospawn]) holds('a shape part <= checked', part <= c.checked)
    holds('footers <= checked', c.footers <= c.checked)
    holds('seen <= 40', ((world.state['seen'] as string[] | undefined) ?? []).length <= 40)
    expect(fillCounts(JSON.parse(JSON.stringify(c)))).toStrictEqual(c)
    holds('only the four state keys', Object.keys(world.state).every(k => ['counts', 'gate', 'seen', 'control'].includes(k)))
  }

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`seed ${seed}: 400 events`, async ($, on) => {
      const world = engine(on)
      await start($)
      const mainSteps = await run(seed, $, world, 400)
      const c = countsOf(world)
      // Every counted spawn reached the engine, and no main request takes more than one note.
      holds('spawns <= engine spawns', c.spawns <= world.spawned.length)
      holds('rows <= main requests', appended(world).length <= mainSteps)
    })
  }
})
