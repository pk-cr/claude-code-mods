import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import type { Scene } from '../types'
import { HOLD_MS, RELAX_MS, TOOL_FRESH_MS, WAIT_DELAY_MS, isUrgent, nextChange, sceneFor, toolScene } from './mood'
import { ALT, DONE_MS, SCENES, sceneSvg } from './scene'

const T0 = Date.parse('2026-10-20T12:00:00Z')

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 110,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
} as const

type World = { clock: MockClock; verdict: 'allow' | 'ask'; inTool: (() => Promise<void>) | undefined }

/** The engine beneath the mod: it answers each event the mod hooks. */
function engine(on: On): World {
  const world: World = { clock: mock.clock(on, { now: T0 }), verdict: 'allow', inTool: undefined }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.check', () => ({ decision: world.verdict }))
  on('tool.call', async () => {
    if (world.inTool) await world.inTool()

    return { result: 'ok' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, null, 'ENGINE BAND') as RenderElement
  })

  return world
}

const startTurn = ($: Engine, agentId?: string) =>
  $.turn.start({ text: '', turnId: 't1', ...(agentId ? { agentId } : {}) } as never)

const endTurn = ($: Engine, fields: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: 'x', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', ...fields } as never)

const callTool = ($: Engine, tool: string, id: string, agentId?: string) =>
  $.tool.call({ tool, tool_use_id: id, ...(agentId ? { agentId } : {}) } as never)

/** The scene the desktop band shows now, by its alt text. */
async function shownOn($: Engine, surface: 'desktop' | 'terminal' = 'desktop', props: object = BAND): Promise<Scene | undefined> {
  const ui = await $.ui.mount({ plugin: 'clawd', surface, component: 'AbovePrompt', props } as never)
  const svg = await ui.find({ type: 'Svg' })
  await ui.unmount()
  const alt = svg?.props['alt']

  return SCENES.find(s => ALT[s] === alt)
}

describe('the scene rules', () => {
  test('tools map to scenes', () => {
    expect(toolScene('Read')).toBe('read')
    expect(toolScene('Grep')).toBe('read')
    expect(toolScene('Bash')).toBe('terminal')
    expect(toolScene('Edit')).toBe('write')
    expect(toolScene('Write')).toBe('write')
    expect(toolScene('WebFetch')).toBe('web')
    expect(toolScene('mcp__Claude_Browser__navigate')).toBe('web')
    expect(toolScene('Agent')).toBe('delegate')
    expect(toolScene('TodoWrite')).toBe('working')
  })

  test('waiting wins over everything once the delay is past', () => {
    const f = { busy: true, tool: { scene: 'read' as const, at: 0 }, waitingSince: 0, agents: 2, doneAt: undefined }
    expect(sceneFor(f, WAIT_DELAY_MS - 1)).toBe('read')
    expect(sceneFor(f, WAIT_DELAY_MS)).toBe('waiting')
  })

  test('a busy turn shows the fresh tool, then delegate or working', () => {
    const f = { busy: true, tool: { scene: 'terminal' as const, at: 0 }, agents: 0 }
    expect(sceneFor(f, 1)).toBe('terminal')
    expect(sceneFor(f, TOOL_FRESH_MS)).toBe('working')
    expect(sceneFor({ ...f, agents: 1 }, TOOL_FRESH_MS)).toBe('delegate')
  })

  test('after a turn: done, then relax, then idle; running agents show delegate after the party', () => {
    const f = { busy: false, agents: 0, doneAt: 0 }
    expect(sceneFor(f, 1)).toBe('done')
    expect(sceneFor(f, DONE_MS)).toBe('relax')
    expect(sceneFor(f, DONE_MS + RELAX_MS)).toBe('idle')
    expect(sceneFor({ ...f, agents: 1 }, 1)).toBe('done')
    expect(sceneFor({ ...f, agents: 1 }, DONE_MS)).toBe('delegate')
    expect(sceneFor({ busy: false, agents: 0 }, 5)).toBe('idle')
  })

  test('only a change between two work scenes waits', () => {
    expect(isUrgent('read', 'terminal')).toBe(false)
    expect(isUrgent('read', 'delegate')).toBe(false)
    // The plain working scene gives way at once to the first tool's own scene.
    expect(isUrgent('working', 'read')).toBe(true)
    expect(isUrgent('read', 'waiting')).toBe(true)
    expect(isUrgent('idle', 'working')).toBe(true)
    expect(isUrgent('terminal', 'done')).toBe(true)
    expect(isUrgent(undefined, 'read')).toBe(true)
  })

  test('the next change by time alone', () => {
    expect(nextChange({ busy: false, agents: 0, doneAt: 0 }, 1)).toBe(DONE_MS)
    expect(nextChange({ busy: false, agents: 0, doneAt: 0 }, DONE_MS)).toBe(DONE_MS + RELAX_MS)
    expect(nextChange({ busy: false, agents: 0 }, 1)).toBeUndefined()
    expect(nextChange({ busy: true, agents: 0, tool: { scene: 'read', at: 0 } }, 1)).toBe(TOOL_FRESH_MS)
  })
})

describe('the drawings', () => {
  for (const s of SCENES) {
    test(`${s} is a small, static-safe SVG`, () => {
      const svg = sceneSvg(s)
      expect(svg.startsWith('<svg ')).toBe(true)
      expect(svg.length < 131072).toBe(true)
      expect(/script|on[a-z]+=|href=["']http/i.test(svg)).toBe(false)
      // A CSS transform would replace a placing transform attribute on the same element.
      expect(/<g transform="[^"]*" style=/.test(svg)).toBe(false)
      // Every animation names a track the style defines.
      for (const m of svg.matchAll(/animation:([a-z0-9]+)/g)) if (m[1] !== 'none') expect(svg.includes(`@keyframes ${m[1]}{`)).toBe(true)
      expect(sceneSvg(s)).toBe(svg)
    })
  }
})

describe('the hooks', () => {
  test('a main turn shows working, then the tool, then the party, relax and idle', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/w' } as never)
    expect(await shownOn($)).toBe('idle')
    await startTurn($)
    expect(await shownOn($)).toBe('working')
    await callTool($, 'Read', 'u1')
    expect(await shownOn($)).toBe('read')
    await endTurn($)
    expect(await shownOn($)).toBe('done')
    await world.clock.advance(DONE_MS + 100)
    expect(await shownOn($)).toBe('relax')
    await world.clock.advance(RELAX_MS)
    expect(await shownOn($)).toBe('idle')
  })

  test('tool scenes inside one turn change at most every HOLD_MS', async ($, on) => {
    const world = engine(on)
    await startTurn($)
    await callTool($, 'Read', 'u1')
    await world.clock.advance(HOLD_MS + 1)
    await callTool($, 'Bash', 'u2')
    expect(await shownOn($)).toBe('terminal')
    await world.clock.advance(500)
    await callTool($, 'Edit', 'u3')
    expect(await shownOn($)).toBe('terminal')
    await world.clock.advance(HOLD_MS)
    expect(await shownOn($)).toBe('write')
  })

  test('an aborted turn goes straight to idle', async ($, on) => {
    engine(on)
    await startTurn($)
    await endTurn($, { isAborted: true, reason: 'aborted' })
    expect(await shownOn($)).toBe('idle')
  })

  test('a question to the person shows waiting while it is open', async ($, on) => {
    const world = engine(on)
    await startTurn($)
    let seen: Scene | undefined
    world.inTool = async () => {
      seen = await shownOn($)
    }
    await callTool($, 'AskUserQuestion', 'q1')
    expect(seen).toBe('waiting')
    expect(await shownOn($)).toBe('working')
  })

  test('an ask verdict shows waiting after the delay, and the verdict passes on unchanged', async ($, on) => {
    const world = engine(on)
    await startTurn($)
    world.verdict = 'ask'
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'c1' } as never)
    expect((verdict as { decision: string }).decision).toBe('ask')
    expect(await shownOn($)).toBe('working')
    await world.clock.advance(WAIT_DELAY_MS + 10)
    expect(await shownOn($)).toBe('waiting')
    await endTurn($)
    expect(await shownOn($)).toBe('done')
  })

  test('a running subagent shows delegate after the party, and its end lets Clawd relax', async ($, on) => {
    const world = engine(on)
    await startTurn($)
    await startTurn($, 'a1')
    await endTurn($)
    await world.clock.advance(DONE_MS + 100)
    expect(await shownOn($)).toBe('delegate')
    // A subagent's tools do not change the main scene.
    await callTool($, 'Bash', 'u9', 'a1')
    expect(await shownOn($)).toBe('delegate')
    await endTurn($, { agentId: 'a1' })
    expect(await shownOn($)).toBe('relax')
  })

  test('the band keeps what the other mods draw, with Clawd at the right end', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ plugin: 'clawd', surface: 'desktop', component: 'AbovePrompt', props: BAND } as never)
    expect(await ui.find({ type: 'Text', text: 'ENGINE BAND' })).toBeDefined()
    const row = await ui.find({ type: 'Box' })
    const kids = ((row as unknown as { children?: { type: string; children?: { text?: string }[] }[] })?.children ?? [])
    expect(kids.map(k => k.type)).toEqual(['Box', 'Svg'])
    expect(JSON.stringify(kids[0]).includes('ENGINE BAND')).toBe(true)
    await ui.unmount()
  })

  test('the terminal, a narrow band and a survey get the band untouched', async ($, on) => {
    engine(on)
    for (const [surface, props] of [
      ['terminal', BAND],
      ['desktop', { ...BAND, bodyColumns: 60 }],
      ['desktop', { ...BAND, hasSurvey: true }],
    ] as const) {
      const ui = await $.ui.mount({ plugin: 'clawd', surface, component: 'AbovePrompt', props } as never)
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'ENGINE BAND' })).toBeDefined()
      await ui.unmount()
    }
  })
})
