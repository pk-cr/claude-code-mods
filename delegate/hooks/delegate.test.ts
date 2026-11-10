import { describe, expect, test } from 'claude-code/testing'

import { AGENT_NOTE, EMPTY_NOTE, MARK, POLICY_SECTION_ID, fillCounts, nudgeText } from './policy'
import {
  BARE,
  FULL,
  SECRET,
  UNTAGGED,
  agent,
  agentCall,
  appended,
  bashCall,
  cmd,
  complete,
  countsOf,
  denyOf,
  engine,
  gateOf,
  measure,
  readCall,
  spawn,
  spawnInput,
  start,
  step,
  turnStart,
  use,
} from './testkit/world'

// The `surface` of a test is the one the host draws on; this mod draws nothing, so each
// behaviour is run on both, as the other mods' tests do.
const SURFACES = ['terminal', 'desktop'] as const

for (const surface of SURFACES) {
  describe(`on ${surface}`, () => {
    describe('the session', () => {
      test('a start registers /delegate and keys the counts to the session', async ($, on) => {
        const world = engine(on)
        world.startedAt = 77
        await start($)
        expect(world.commands).toEqual(['delegate'])
        expect(countsOf(world).key).toBe(77)
      })

      test('a second start, as a reload makes, keeps the counts', async ($, on) => {
        const world = engine(on)
        await start($)
        await agentCall($, { prompt: UNTAGGED })
        const before = countsOf(world)
        await start($)
        expect(countsOf(world)).toEqual(before)
        expect(before.denied.untagged).toBe(1)
      })

      test('a start in another session clears the counts and the memory of denied tasks', async ($, on) => {
        const world = engine(on)
        await start($)
        await agentCall($, { prompt: UNTAGGED })
        world.startedAt = 2
        await start($)
        expect(countsOf(world).denied.untagged).toBe(0)
        expect(world.state['seen']).toEqual([])
      })

      test('a /clear clears the counts, and the next turn keys them again', async ($, on) => {
        const world = engine(on)
        await start($)
        await agentCall($, { prompt: UNTAGGED })
        await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)
        expect(countsOf(world).denied.untagged).toBe(0)
        expect(countsOf(world).key).toBe(0)
        world.startedAt = 9
        await turnStart($)
        expect(countsOf(world).key).toBe(9)
      })

      test('any other end keeps the counts', async ($, on) => {
        const world = engine(on)
        await start($)
        await agentCall($, { prompt: UNTAGGED })
        await $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's' } } as never)
        expect(countsOf(world).denied.untagged).toBe(1)
      })
    })

    describe('what the model reads', () => {
      test('the policy joins the system prompt once, last, on the session side', async ($, on) => {
        engine(on)
        const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [surface], tools: [], outputStyle: null, traits: [] } as never)
        expect(out.sections.map(s => s.id)).toEqual(['intro', POLICY_SECTION_ID])
        expect(out.sections[1]?.scope).toBe('session')
        expect(out.sections[1]?.text).toContain('Delegation policy')
      })

      test('a bare run and a teammate get no policy', async ($, on) => {
        engine(on)
        for (const trait of ['bare', 'teammate']) {
          const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [trait] } as never)
          expect(out.sections.map(s => s.id)).toEqual(['intro'])
        }
      })

      test('policyText off adds nothing to the prompt or the Agent tool', { options: { policyText: false } }, async ($, on) => {
        engine(on)
        const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [surface], tools: [], outputStyle: null, traits: [] } as never)
        expect(out.sections.map(s => s.id)).toEqual(['intro'])
        const agentTool = await $.tool.describe({ tool: 'Agent', description: 'Launch a new agent.', provider: { plugin: 'engine', tier: 'core' } } as never)
        expect(agentTool.description).toBe('Launch a new agent.')
      })

      test('the Agent tool description gets one note and no other tool does', async ($, on) => {
        engine(on)
        const agentTool = await $.tool.describe({ tool: 'Agent', description: 'Launch a new agent.', provider: { plugin: 'engine', tier: 'core' } } as never)
        expect(agentTool.description).toBe(`Launch a new agent.\n\n${AGENT_NOTE}`)
        const again = await $.tool.describe({ tool: 'Agent', description: agentTool.description, provider: { plugin: 'engine', tier: 'core' } } as never)
        expect(again.description).toBe(agentTool.description)
        const bash = await $.tool.describe({ tool: 'Bash', description: 'Run.', provider: { plugin: 'engine', tier: 'core' } } as never)
        expect(bash.description).toBe('Launch a new agent.')
      })
    })

    describe('checking an Agent call', () => {
      test('a complete brief reaches the engine as it was sent, and its shape is counted', async ($, on) => {
        const world = engine(on)
        await start($)
        const out = await agentCall($)
        expect(denyOf(out)).toBeUndefined()
        expect(world.reached.at(-1)?.['prompt']).toBe(FULL)
        const c = countsOf(world)
        expect([c.checked, c.tag, c.scope, c.done, c.ret, c.nospawn, c.footers]).toEqual([1, 1, 1, 1, 1, 1, 0])
      })

      test('a vague brief is refused once with a reason, then goes through with the footer', async ($, on) => {
        const world = engine(on)
        await start($)
        const first = await agentCall($, { prompt: 'Look around.' })
        expect(denyOf(first)).toMatch(/not ready/)
        expect(world.reached.filter(r => r['tool'] === 'Agent')).toHaveLength(0)
        expect(countsOf(world).denied.vague).toBe(1)
        expect(world.state['seen']).toHaveLength(1)
        const second = await agentCall($, { prompt: 'Look around.' })
        expect(denyOf(second)).toBeUndefined()
        const sent = String(world.reached.at(-1)?.['prompt'])
        expect(sent.startsWith('Look around.')).toBe(true)
        expect(sent).toContain(MARK)
        const c = countsOf(world)
        expect([c.checked, c.footers]).toEqual([1, 1])
      })

      test('an untagged brief is refused once and the reason names the tag', async ($, on) => {
        const world = engine(on)
        await start($)
        expect(denyOf(await agentCall($, { prompt: UNTAGGED }))).toContain('[difficulty: ...]')
        expect(denyOf(await agentCall($, { prompt: UNTAGGED }))).toBeUndefined()
        expect(countsOf(world).denied.untagged).toBe(1)
        expect(countsOf(world).tag).toBe(0)
      })

      test('a tagged brief that lacks the return format and the rest gets a footer after its own text', async ($, on) => {
        const world = engine(on)
        await start($)
        await agentCall($, { prompt: BARE, description: 'Find key readers' })
        const sent = String(world.reached.at(-1)?.['prompt'])
        expect(sent.startsWith(BARE)).toBe(true)
        expect(sent).toMatch(/Return format:[\s\S]*Done when:[\s\S]*Do not spawn other agents\.\n\(delegate contract\)$/)
        expect(Object.keys(world.reached.at(-1) ?? {}).sort()).toEqual(['description', 'prompt', 'tool', 'tool_use_id'])
      })

      test('a role agent, a fork and another plugin\'s agent pass untouched and are not counted', async ($, on) => {
        const world = engine(on)
        await start($)
        for (const subagent_type of ['delegate:scout', 'fork', 'statslab:stats-planner']) {
          expect(denyOf(await agentCall($, { prompt: 'Look around.', subagent_type }))).toBeUndefined()
          expect(world.reached.at(-1)?.['prompt']).toBe('Look around.')
        }
        expect(countsOf(world).checked).toBe(0)
      })

      test('a malformed call does not throw and is judged as an empty brief', async ($, on) => {
        const world = engine(on)
        await start($)
        const out = await $.tool.call({ tool: 'Agent', tool_use_id: 'tuX' } as never)
        expect(denyOf(out)).toMatch(/not ready/)
        expect(countsOf(world).denied.vague).toBe(1)
      })

      test('a huge brief is read in linear time', async ($, on) => {
        engine(on)
        await start($)
        const huge = `[difficulty: routine]\n${'a /b/c.ts '.repeat(60_000)}`
        const began = Date.now()
        await agentCall($, { prompt: huge })
        expect(Date.now() - began < 2000).toBe(true)
      })

      test('a general subagent that starts an agent is refused, an orchestrator from another plugin is not', async ($, on) => {
        const world = engine(on)
        world.listed = [agent('g1', { type: 'general-purpose' }), agent('o1', { type: 'gsd-debug-session-manager' })]
        await start($)
        expect(denyOf(await agentCall($, { agentId: 'g1' }))).toMatch(/may not start other agents/)
        expect(countsOf(world).denied.nested).toBe(1)
        expect(denyOf(await agentCall($, { agentId: 'o1' }))).toBeUndefined()
        expect(denyOf(await agentCall($, { agentId: 'unknown' }))).toBeUndefined()
      })

      test('after three refused briefs in a turn the rest go through, and the next turn starts over', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        for (let i = 1; i <= 3; i += 1) expect(denyOf(await agentCall($, { prompt: UNTAGGED, description: `reworded ${i}` }))).toMatch(/not ready/)
        expect(denyOf(await agentCall($, { prompt: UNTAGGED, description: 'reworded 4' }))).toBeUndefined()
        expect(denyOf(await agentCall($, { prompt: 'Look around.', description: 'reworded 5' }))).toBeUndefined()
        expect(String(world.reached.at(-1)?.['prompt'])).toContain(MARK)
        expect(countsOf(world).denied.untagged).toBe(3)
        await turnStart($)
        expect(denyOf(await agentCall($, { prompt: UNTAGGED, description: 'reworded 6' }))).toMatch(/not ready/)
      })

      test('a failing agent list lets the nested call through and the cap read as none running', async ($, on) => {
        const world = engine(on)
        world.listFails = true
        await start($)
        expect(denyOf(await agentCall($, { agentId: 'g1' }))).toBeUndefined()
        expect(denyOf(await spawn($))).toBeUndefined()
      })
    })

    describe('the store', () => {
      test('a main turn keeps this session\'s counts in the store under its key', async ($, on) => {
        const world = engine(on)
        world.startedAt = 41
        await start($)
        await turnStart($)
        await spawn($)
        await agentCall($)
        await complete($)
        const kept = fillCounts(world.store.get('score:41'))
        expect([kept.key, kept.spawns, kept.checked]).toEqual([41, 1, 1])
      })

      test('after a /clear, counts with no key are not stored', async ($, on) => {
        const world = engine(on)
        await start($)
        await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)
        await complete($)
        expect([...world.store.keys()].filter(k => k.startsWith('score:'))).toEqual([])
      })
    })

    describe('the switch', () => {
      test('off, a subagent with no answer is not counted and no note is waiting', async ($, on) => {
        const world = engine(on)
        world.listed = [agent('a1')]
        await start($)
        await cmd($, 'off')
        await complete($, { agentId: 'a1', answer: '' })
        expect(countsOf(world).empty).toBe(0)
        await step($)
        expect(appended(world)).toEqual([])
      })

      test('a note that waited when the switch went off is dropped', async ($, on) => {
        const world = engine(on)
        world.listed = [agent('a1')]
        await start($)
        await complete($, { agentId: 'a1', answer: '' })
        await cmd($, 'off')
        await step($)
        expect(appended(world)).toEqual([])
        await cmd($, 'on')
        await step($)
        expect(appended(world)).toEqual([])
      })

      test('/delegate off stops the check, the nudge and the caps; on brings them back', async ($, on) => {
        const world = engine(on)
        await start($)
        expect((await cmd($, 'off')).text).toMatch(/delegate is off/)
        expect(denyOf(await agentCall($, { prompt: 'Look around.' }))).toBeUndefined()
        expect(world.reached.at(-1)?.['prompt']).toBe('Look around.')
        for (let i = 0; i < 9; i += 1) await readCall($)
        await step($)
        expect(appended(world)).toEqual([])
        expect((await cmd($, 'on')).text).toBe('delegate is on.')
        expect(denyOf(await agentCall($, { prompt: 'Look around.' }))).toMatch(/not ready/)
        expect(world.state['control']).toEqual({ on: true })
      })
    })

    describe('the read-heavy nudge', () => {
      test('six read-only calls in one turn send one note before the next request, and only one', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        for (let i = 0; i < 5; i += 1) await readCall($)
        await step($)
        expect(appended(world)).toEqual([])
        await readCall($)
        expect(appended(world)).toEqual([])
        await step($)
        expect(appended(world)).toEqual([nudgeText(6)])
        for (let i = 0; i < 12; i += 1) await readCall($)
        await step($)
        expect(appended(world)).toHaveLength(1)
        const c = countsOf(world)
        expect([c.triggers, c.nudges]).toEqual([1, 1])
        expect(world.session.appended()[0]?.message.type).toBe('user')
      })

      test('a Bash read counts, a Bash write ends the run, and a subagent\'s calls are not counted', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        for (let i = 0; i < 5; i += 1) await bashCall($, 'cat a.ts | head -3')
        await bashCall($, 'npm test')
        for (let i = 0; i < 5; i += 1) await readCall($)
        for (let i = 0; i < 20; i += 1) await readCall($, { agentId: 'sub' })
        await step($)
        expect(appended(world)).toEqual([])
        expect(countsOf(world).triggers).toBe(0)
      })

      test('a new turn starts the run again', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        for (let i = 0; i < 4; i += 1) await readCall($)
        await turnStart($)
        for (let i = 0; i < 4; i += 1) await readCall($)
        await step($)
        expect(appended(world)).toEqual([])
      })

      test('no note when an agent was already started in the turn, but the turn is counted and credited', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        await spawn($)
        for (let i = 0; i < 9; i += 1) await readCall($)
        await step($)
        expect(appended(world)).toEqual([])
        await complete($)
        const c = countsOf(world)
        expect([c.triggers, c.nudges, c.triggersDelegated]).toEqual([1, 0, 1])
      })

      test('a trigger turn that never delegates is counted and not credited', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        for (let i = 0; i < 8; i += 1) await readCall($)
        await complete($)
        const c = countsOf(world)
        expect([c.triggers, c.nudges, c.triggersDelegated]).toEqual([1, 1, 0])
      })

      test('a reset in the middle of a trigger turn does not credit a trigger it cleared', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        for (let i = 0; i < 8; i += 1) await readCall($)
        await cmd($, 'reset')
        await spawn($)
        await complete($)
        const c = countsOf(world)
        expect(c.triggersDelegated).toBeLessThanOrEqual(c.triggers)
        expect([c.triggers, c.triggersDelegated]).toEqual([0, 0])
      })

      test('a subagent\'s own request does not take the note', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        for (let i = 0; i < 8; i += 1) await readCall($)
        await step($, { agentId: 'sub' })
        expect(appended(world)).toEqual([])
        await step($)
        expect(appended(world)).toHaveLength(1)
      })
    })

    describe('caps', () => {
      test('a new agent is refused while the cap of running agents holds, and never reaches the engine', async ($, on) => {
        const world = engine(on)
        world.listed = Array.from({ length: 8 }, (_, i) => agent(`r${i}`))
        await start($)
        const out = await spawn($)
        expect(denyOf(out)).toMatch(/8 agents are already running/)
        expect(world.spawned).toHaveLength(0)
        expect(countsOf(world).denied.live).toBe(1)
        world.listed = world.listed.slice(1)
        expect(denyOf(await spawn($))).toBeUndefined()
        expect(world.spawned).toHaveLength(1)
      })

      test('finished agents and teammates do not count as running', { options: { maxLive: 2 } }, async ($, on) => {
        const world = engine(on)
        world.listed = [
          ...Array.from({ length: 5 }, (_, i) => agent(`d${i}`, { status: 'completed' })),
          agent('t1', { teammateId: 'x@team' }),
          agent('t2', { teammateId: 'y@team' }),
          agent('r1'),
        ]
        await start($)
        expect(denyOf(await spawn($))).toBeUndefined()
      })

      test('the turn cap counts agents started in the turn, and a new turn clears it', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        for (let i = 0; i < 16; i += 1) expect(denyOf(await spawn($))).toBeUndefined()
        expect(denyOf(await spawn($))).toMatch(/already started in this turn/)
        expect(countsOf(world).denied.turn).toBe(1)
        expect(countsOf(world).spawns).toBe(16)
        await complete($)
        await turnStart($)
        expect(denyOf(await spawn($))).toBeUndefined()
      })

      test('the session cap holds over turns and /delegate reset clears it', async ($, on) => {
        const world = engine(on)
        await start($)
        for (let t = 0; t < 4; t += 1) {
          await turnStart($)
          for (let i = 0; i < 7; i += 1) {
            if (countsOf(world).spawns >= 25) break
            await spawn($)
          }
          await complete($)
        }
        expect(countsOf(world).spawns).toBe(25)
        await turnStart($)
        expect(denyOf(await spawn($))).toMatch(/in this session \(cap 25\)/)
        await cmd($, 'reset')
        expect(denyOf(await spawn($))).toBeUndefined()
      })

      test('a fork, a teammate and a workflow agent are neither counted nor refused', async ($, on) => {
        const world = engine(on)
        world.listed = Array.from({ length: 9 }, (_, i) => agent(`r${i}`))
        await start($)
        expect(denyOf(await spawn($, { fork: true }))).toBeUndefined()
        expect(denyOf(await spawn($, { isTeammate: true }))).toBeUndefined()
        expect(denyOf(await spawn($, { workflow: { runId: 'wf_1', agentIndex: 1 } }))).toBeUndefined()
        expect(world.spawned).toHaveLength(3)
        expect(countsOf(world).spawns).toBe(0)
      })

      test('a burst of spawns in one message holds the turn cap exactly', { options: { maxLive: 0, maxSession: 0 } }, async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        const outs = await Promise.all(Array.from({ length: 20 }, () => spawn($)))
        expect(outs.filter(o => denyOf(o) === undefined)).toHaveLength(16)
        expect(world.spawned).toHaveLength(16)
        expect(countsOf(world).denied.turn).toBe(4)
        expect(countsOf(world).spawns).toBe(16)
      })

      test('a burst holds the session cap exactly, over several turns', { options: { maxLive: 0, maxTurn: 0, maxSession: 5 } }, async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        const first = await Promise.all(Array.from({ length: 3 }, () => spawn($)))
        await complete($)
        await turnStart($)
        const second = await Promise.all(Array.from({ length: 4 }, () => spawn($)))
        expect([...first, ...second].filter(o => denyOf(o) === undefined)).toHaveLength(5)
        expect(countsOf(world).denied.session).toBe(2)
      })

      test('a burst of starts that are still under way holds the running cap', async ($, on) => {
        const world = engine(on)
        world.spawnDelay = 100
        await start($)
        await turnStart($)
        const pending = Array.from({ length: 10 }, () => spawn($))
        await world.clock.settle()
        await world.clock.advance(100)
        const outs = await Promise.all(pending)
        expect(outs.filter(o => denyOf(o) === undefined)).toHaveLength(8)
        expect(world.spawned).toHaveLength(8)
        expect(countsOf(world).denied.live).toBe(2)
      })

      test('the spawn hook passes the event on exactly as it came', async ($, on) => {
        const world = engine(on)
        await start($)
        const input = spawnInput({ prompt: 'Look around.', model: 'haiku', description: 'x' })
        await $.agent.spawn(input)
        expect(world.spawned[0]).toEqual(input)
      })

      test('an agent the engine refuses is not counted, and its refusal reaches the caller', async ($, on) => {
        const world = engine(on)
        world.spawnDeny = 'the engine says no'
        await start($)
        await turnStart($)
        expect(denyOf(await spawn($))).toBe('the engine says no')
        expect(countsOf(world).spawns).toBe(0)
        await spawn($)
        await complete($)
        expect(countsOf(world).multi).toBe(0)
      })
    })

    describe('agents that start together', () => {
      test('two agents within three seconds are one parallel start, two far apart are not', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        await spawn($)
        await world.clock.advance(1000)
        await spawn($)
        await complete($)
        await turnStart($)
        await spawn($)
        await world.clock.advance(20_000)
        await spawn($)
        await complete($)
        const c = countsOf(world)
        expect([c.multi, c.multiParallel]).toEqual([2, 1])
      })

      test('one agent in a turn is neither', async ($, on) => {
        const world = engine(on)
        await start($)
        await turnStart($)
        await spawn($)
        await complete($)
        expect([countsOf(world).multi, countsOf(world).multiParallel]).toEqual([0, 0])
      })
    })

    describe('subagent turns, tokens and warnings', () => {
      test('a subagent turn adds input, cache-write and output tokens, not cache reads, and passes through', async ($, on) => {
        const world = engine(on)
        await start($)
        const out = await complete($, { agentId: 'a1', usage: use(1000, 500, 900_000, 2000) })
        expect(out.text).toBe('a full answer, long enough')
        expect(countsOf(world).tokens).toBe(3500)
      })

      test('a toast shows at the token warning and again at the alert, once each, and nothing is refused', async ($, on) => {
        const world = engine(on)
        await start($)
        await complete($, { agentId: 'a1', usage: use(2_400_000, 0, 0, 0) })
        expect(world.toasts).toEqual([])
        await complete($, { agentId: 'a1', usage: use(200_000, 0, 0, 0) })
        expect(world.toasts).toHaveLength(1)
        expect(world.toasts[0]).toMatch(/2\.6M tokens/)
        await complete($, { agentId: 'a2', usage: use(100_000, 0, 0, 0) })
        expect(world.toasts).toHaveLength(1)
        await complete($, { agentId: 'a2', usage: use(2_500_000, 0, 0, 0) })
        expect(world.toasts).toHaveLength(2)
        expect(world.toasts[1]).toMatch(/alert/)
        expect(denyOf(await spawn($))).toBeUndefined()
      })

      test('the five-hour window toasts at 80 and 92, once each, and never refuses a spawn', async ($, on) => {
        const world = engine(on)
        await start($)
        await measure($, 79)
        expect(world.toasts).toEqual([])
        await measure($, 81)
        await measure($, 85)
        expect(world.toasts).toHaveLength(1)
        await measure($, 95)
        expect(world.toasts).toHaveLength(2)
        expect(world.toasts[1]).toMatch(/last of it/)
        expect(denyOf(await spawn($))).toBeUndefined()
        expect(gateOf(world).five).toBe(95)
      })

      test('the window warning comes back after a reset', async ($, on) => {
        const world = engine(on)
        await start($)
        await measure($, 85)
        await measure($, 5)
        await measure($, 90)
        expect(world.toasts).toHaveLength(2)
      })

      test('a reading with no five-hour window changes nothing', async ($, on) => {
        const world = engine(on)
        await start($)
        await measure($, 85)
        await measure($, undefined)
        expect(world.toasts).toHaveLength(1)
        expect(gateOf(world).five).toBe(85)
      })

      test('a subagent that ends with no answer is counted, and the model is told once at its next request', async ($, on) => {
        const world = engine(on)
        world.listed = [agent('a1'), agent('a2')]
        await start($)
        await complete($, { agentId: 'a1', answer: '' })
        await complete($, { agentId: 'a2', answer: ' ' })
        expect(countsOf(world).empty).toBe(2)
        await step($)
        expect(appended(world)).toEqual([EMPTY_NOTE])
        await step($)
        expect(appended(world)).toHaveLength(1)
      })

      test('a short real answer is not empty, and neither is a loop the agent list does not name or a fork', async ($, on) => {
        const world = engine(on)
        world.listed = [agent('a1'), agent('f1', { type: 'fork' })]
        await start($)
        await complete($, { agentId: 'a1', answer: 'RESULT: 7' })
        await complete($, { agentId: 'ghost', answer: '' })
        await complete($, { agentId: 'f1', answer: '' })
        expect(countsOf(world).empty).toBe(0)
        await step($)
        expect(appended(world)).toEqual([])
      })

      test('a subagent that was stopped is not an empty answer', async ($, on) => {
        const world = engine(on)
        world.listed = [agent('a1')]
        await start($)
        await complete($, { agentId: 'a1', answer: '', isAborted: true })
        expect(countsOf(world).empty).toBe(0)
        await step($)
        expect(appended(world)).toEqual([])
      })
    })

    describe('the command', () => {
      test('the status shows the version, the caps, the window and the score', async ($, on) => {
        const world = engine(on)
        world.listed = [agent('r1'), agent('r2', { status: 'completed' })]
        await start($)
        await measure($, 41)
        await spawn($)
        const text = (await cmd($, '')).text ?? ''
        expect(text).toContain('delegate 0.1.4: on')
        expect(text).toContain('running now 1')
        expect(text).toContain('Five-hour window 41%')
        expect((await cmd($, 'status')).text).toBe(text)
      })

      test('the score for this session and for all stored sessions', async ($, on) => {
        const world = engine(on)
        await start($)
        await agentCall($)
        await agentCall($, { prompt: UNTAGGED, description: 'second' })
        await turnStart($)
        await complete($)
        const mine = (await cmd($, 'score')).text ?? ''
        expect(mine).toContain('this session')
        expect(mine).toMatch(/judged briefs 2\. As the model sent them: tag 1\/2/)
        const all = (await cmd($, 'score all')).text ?? ''
        expect(all).toContain('all 1 stored sessions')
        expect(world.state['counts']).toBeDefined()
      })

      test('all stored sessions adds the other sessions kept in the store', async ($, on) => {
        const world = engine(on)
        await start($)
        world.store.set('score:5', { ...fillCounts({ key: 5 }), checked: 4, tag: 4 })
        world.store.set('score:6', { ...fillCounts({ key: 6 }), checked: 6, tag: 0 })
        await agentCall($)
        const all = (await cmd($, 'score all')).text ?? ''
        expect(all).toContain('all 3 stored sessions')
        expect(all).toMatch(/judged briefs 11\./)
      })

      test('a word it does not know gets the usage line', async ($, on) => {
        engine(on)
        expect((await cmd($, 'banana')).text).toMatch(/^Use: \/delegate/)
      })

      test('only the newest 30 sessions stay in the store', async ($, on) => {
        const world = engine(on)
        for (let i = 1; i <= 40; i += 1) world.store.set(`score:${i}`, fillCounts({ key: i }))
        world.store.set('other', 1)
        await start($)
        const keys = [...world.store.keys()].filter(k => k.startsWith('score:'))
        expect(keys).toHaveLength(30)
        expect(keys).toContain('score:40')
        expect(keys).not.toContain('score:10')
        expect(world.store.get('other')).toBe(1)
      })
    })

    describe('hot reload and hostile state', () => {
      test('a counts value an older version stored still reads and shows', async ($, on) => {
        engine(on)
        on('state.get', { plugin: 'delegate', key: 'counts' } as never, () => ({ value: { value: { key: 1, spawns: 3 }, version: 1 } }) as never)
        const text = (await cmd($, 'status')).text ?? ''
        expect(text).toContain('Agents started this session 3')
        expect(text).toContain('Denied: vague 0')
      })
    })

    describe('what it keeps', () => {
      test('no state value, store value or note holds a word of a brief, a description or an answer', async ($, on) => {
        const world = engine(on)
        world.listed = [agent('a1')]
        await start($)
        await turnStart($)
        await agentCall($, { prompt: `${SECRET} short`, description: `${SECRET} one` })
        await agentCall($, { prompt: `${SECRET} short`, description: `${SECRET} one` })
        await agentCall($, { prompt: BARE.replace('Find', SECRET), description: `${SECRET} two` })
        await spawn($, { description: `${SECRET} three`, prompt: SECRET })
        await complete($, { agentId: 'a1', answer: SECRET, usage: use(10, 10, 0, 0) })
        await complete($, { agentId: 'a1', answer: '', usage: use(10, 10, 0, 0) })
        await complete($, { answer: SECRET })
        await step($)
        const kept = JSON.stringify({ state: world.state, rows: appended(world), toasts: world.toasts, store: [...world.store.values()] })
        expect(kept.toLowerCase()).not.toContain('secret')
        expect(kept.toLowerCase()).not.toMatch(/\bone\b|\btwo\b|\bthree\b/)
        expect(JSON.stringify(world.store.get(`score:${world.startedAt}`)).toLowerCase()).not.toContain('secret')
        expect(Object.keys(world.state).sort()).toEqual(['counts', 'gate', 'seen', 'control'].sort().filter(k => k in world.state))
      })

      test('the footer never repeats a word of the description', async ($, on) => {
        const world = engine(on)
        await start($)
        await agentCall($, { prompt: BARE, description: 'ZZ-UNIQUE-DESCRIPTION' })
        expect(String(world.reached.at(-1)?.['prompt'])).not.toContain('ZZ-UNIQUE')
      })
    })
  })
}

describe('the options', () => {
  test('nudge off still counts the read-heavy turn and sends no note', { options: { nudge: false } }, async ($, on) => {
    const world = engine(on)
    await start($)
    await turnStart($)
    for (let i = 0; i < 9; i += 1) await readCall($)
    await step($)
    expect(appended(world)).toEqual([])
    const c = countsOf(world)
    expect([c.triggers, c.nudges]).toEqual([1, 0])
  })

  test('nudgeRun sets the line, and 0 turns the trigger off', { options: { nudgeRun: 3 } }, async ($, on) => {
    const world = engine(on)
    await start($)
    await turnStart($)
    for (let i = 0; i < 3; i += 1) await readCall($)
    await step($)
    expect(appended(world)).toEqual([nudgeText(3)])
  })

  test('nudgeRun 0 counts and sends nothing', { options: { nudgeRun: 0 } }, async ($, on) => {
    const world = engine(on)
    await start($)
    await turnStart($)
    for (let i = 0; i < 30; i += 1) await readCall($)
    await step($)
    expect(appended(world)).toEqual([])
    expect(countsOf(world).triggers).toBe(0)
  })

  test('normalise off passes a vague brief and counts nothing', { options: { normalise: false } }, async ($, on) => {
    const world = engine(on)
    await start($)
    expect(denyOf(await agentCall($, { prompt: 'Look around.' }))).toBeUndefined()
    expect(world.reached.at(-1)?.['prompt']).toBe('Look around.')
    expect(countsOf(world).checked).toBe(0)
  })

  test('requireTag off lets an untagged brief through without a refusal', { options: { requireTag: false } }, async ($, on) => {
    const world = engine(on)
    await start($)
    expect(denyOf(await agentCall($, { prompt: UNTAGGED }))).toBeUndefined()
    expect(world.reached.at(-1)?.['prompt']).toBe(UNTAGGED)
  })

  test('blockNested off lets a general subagent start agents', { options: { blockNested: false } }, async ($, on) => {
    const world = engine(on)
    world.listed = [agent('g1')]
    await start($)
    expect(denyOf(await agentCall($, { agentId: 'g1' }))).toBeUndefined()
  })

  test('maxLive 2 holds at two, and a cap of 0 is off', { options: { maxLive: 2, maxTurn: 0, maxSession: 0 } }, async ($, on) => {
    const world = engine(on)
    world.listed = [agent('r1'), agent('r2')]
    await start($)
    await turnStart($)
    expect(denyOf(await spawn($))).toMatch(/2 agents are already running/)
    world.listed = []
    for (let i = 0; i < 30; i += 1) expect(denyOf(await spawn($))).toBeUndefined()
  })

  test('warning limits of 0 are off', { options: { warnTokens: 0, alertTokens: 0, warnWindow: 0, alertWindow: 0 } }, async ($, on) => {
    const world = engine(on)
    await start($)
    await complete($, { agentId: 'a1', usage: use(90_000_000, 0, 0, 0) })
    await measure($, 99)
    expect(world.toasts).toEqual([])
  })
})
