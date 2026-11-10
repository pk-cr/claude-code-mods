import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement } from 'claude-code'

import {
  ASK_DELAY_MS,
  READY_MS,
  START,
  bandWords,
  clean,
  emptyCounts,
  fileOf,
  glyphOf,
  liveFileName,
  parseArgs,
  parseFile,
  phaseMoves,
  span,
  statusOf,
  timeWords,
  toolLabel,
  turnBegins,
  turnEnds,
  viewOf,
} from './model'
import type { Ask, LiveFile } from './model'
import { PIN_TOOL, labelOf, pinOutcome } from './register'
import type { Row } from '../types'

const SURFACES = ['terminal', 'desktop'] as const
const HOME = '/home/user'
const LIVE = '/home/user/.claude/session-pulse/live'
const OWN = `${LIVE}/s1.json`
/** A time well past zero, so "since 0" never looks like a real moment. */
const T0 = 1_800_000_000_000

const PANE = { title: 'Sessions', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {} } as const

type World = {
  clock: MockClock
  disk: Map<string, { text: string; mtimeMs: number }>
  toasts: string[]
  opened: string[]
  calls: { tool: string; input: Record<string, unknown> }[]
  listed: AgentInfo[]
  store: Map<string, unknown>
  /** What the engine's permission check answers, by tool. */
  verdicts: Record<string, 'allow' | 'ask' | 'deny'>
  /** Runs inside a tool's run, where a permission prompt or a question would wait. */
  during?: (tool: string) => Promise<void>
}

/** `$` is the test's own: the engine's permission check is raised from it, as a session raises it inside a call. */
function engine(on: On, $: Engine): World {
  const world: World = { clock: mock.clock(on), disk: new Map(), toasts: [], opened: [], calls: [], listed: [], store: new Map(), verdicts: {} }
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work/web-app' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('agent.list', () => ({ value: world.listed }))
  on('store.get', (_$, e) => ({ value: world.store.get(e.key) }))
  on('store.set', (_$, e) => {
    world.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.write', (_$, e) => {
    world.disk.set(e.path, { text: e.text, mtimeMs: world.clock.now() })
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const file = world.disk.get(e.path)
    if (file === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: file.text }
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    return {
      value: [...world.disk]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, file]) => ({ name: path.slice(prefix.length), kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false })),
    }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.check', (_$, e) => ({ decision: world.verdicts[e.tool] ?? 'allow' }))
  on('tool.call', async (_$, e) => {
    const { tool, tool_use_id: id, ...input } = e as unknown as Record<string, unknown> & { tool: string; tool_use_id?: string }
    world.calls.push({ tool, input })
    // The engine asks its permission question inside the call, as a session does.
    const check = await $.tool.check({ tool, input, tool_use_id: id } as never)
    if (check.decision === 'deny') return { deny: check.reason ?? 'denied' }
    await world.during?.(tool)
    return { result: 'ok' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'hello' } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'ENGINE BAND') as RenderElement
  })
  return world
}

/** What this session's own file says now. */
function own(world: World): LiveFile | undefined {
  const file = world.disk.get(OWN)
  return file === undefined ? undefined : parseFile(file.text)
}

/** Another session's file, beaten `ago` ms before now. */
function peer(world: World, fields: Partial<LiveFile> & Pick<LiveFile, 'id' | 'state' | 'words'>, ago = 0): void {
  const now = world.clock.now()
  const file: LiveFile = { v: 1, beat: now - ago, every: 2000, project: 'claude', since: now - 60_000, ...fields }
  world.disk.set(`${LIVE}/${fields.id}.json`, { text: JSON.stringify(file), mtimeMs: now - ago })
}

const begin = { cwd: '/work/web-app', surface: null, isInteractive: true } as const
const complete = (reason: 'answer' | 'aborted' | 'error') =>
  ({ answer: '', durationMs: 1000, isAborted: reason === 'aborted', turnId: 't1', reason }) as never
const pulse = (args: string) => ({ command: 'pulse', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }) as never

async function run(step: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of step) void chunk
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

describe('this session', () => {
  test('a turn works, then is ready, then reads idle after 30 minutes', () => {
    const working = turnBegins(START, 't1', T0)
    expect(statusOf(working, [], 0, T0 + 5000)).toEqual({ state: 'working', since: T0, words: 'Thinking' })
    expect(statusOf(phaseMoves(working, 'tool', 'Bash'), [], 0, T0).words).toBe('Running Bash')
    expect(statusOf(phaseMoves(working, 'tool', 'mcp__ccd_sidebar__list_sessions'), [], 0, T0).words).toBe('Running list_sessions')
    const ready = turnEnds(working, 'answer', T0 + 9000)
    expect(statusOf(ready, [], 0, T0 + 9000).state).toBe('ready')
    expect(statusOf(ready, [], 0, T0 + 9000 + READY_MS).state).toBe('idle')
  })

  test('how a turn ended: interrupted is idle, an API error or a refusal fails', () => {
    expect(turnEnds(START, 'aborted', T0).state).toBe('idle')
    expect(statusOf(turnEnds(START, 'error', T0), [], 0, T0).words).toBe('Failed · API error')
    expect(statusOf(turnEnds(START, 'refusal', T0), [], 0, T0).words).toBe('Failed · Refused')
  })

  test('a permission ask shows after 2 s; a question or a plan at once; the oldest wins', () => {
    const working = turnBegins(START, 't1', T0)
    const asks: Ask[] = [{ kind: 'permission', tool: 'Bash', since: T0 }]
    expect(statusOf(working, asks, 0, T0 + ASK_DELAY_MS - 1).state).toBe('working')
    expect(statusOf(working, asks, 0, T0 + ASK_DELAY_MS)).toEqual({ state: 'needs', since: T0, words: 'Approve Bash' })
    expect(statusOf(working, [{ kind: 'question', since: T0 }], 0, T0).words).toBe('Answer a question')
    expect(statusOf(working, [{ kind: 'plan', since: T0 + 5 }, { kind: 'question', since: T0 }], 0, T0 + 10).words).toBe('Answer a question')
  })

  test('agents still running after the turn ended keep the session from idle', () => {
    const done = turnEnds(START, 'answer', T0)
    expect(statusOf(done, [], 2, T0).words).toBe('Ready · 2 agents')
    expect(statusOf(done, [], 1, T0 + READY_MS)).toEqual({ state: 'working', since: T0, words: 'Agents running · 1 agent' })
  })

  test('a phase change outside a turn changes nothing (a warm spawn calls tools with no turn)', () => {
    expect(phaseMoves(START, 'tool', 'Read')).toBe(START)
  })
})

describe('the file', () => {
  test('round trip, and junk is refused', () => {
    const file = fileOf({ id: 's1', now: T0, every: 2000, project: 'claude', title: 'Refactor auth', status: { state: 'working', since: T0, words: 'Thinking' } })
    expect(parseFile(JSON.stringify(file))).toStrictEqual(file)
    expect(parseFile('{"v":1,')).toBeUndefined()
    expect(parseFile(JSON.stringify({ ...file, id: '../evil' }))).toBeUndefined()
    expect(parseFile(JSON.stringify({ ...file, state: 'exploded' }))).toBeUndefined()
    expect(parseFile(JSON.stringify({ ...file, every: 0 }))).toBeUndefined()
  })

  test('text from another file is cleaned: no control or direction characters, cut short', () => {
    const file = parseFile(JSON.stringify({ v: 1, id: 's2', beat: T0, every: 2000, project: 'p', since: T0 + 99, state: 'idle', words: 'a‮b\nc', title: 'x'.repeat(200) }))
    expect(file?.words).toBe('a b c')
    expect(file?.title?.length).toBe(60)
    expect(file?.since).toBe(T0)
    expect(liveFileName('a/b')).toBeUndefined()
    expect(clean(42, 10)).toBe('')
    expect(labelOf('{"label":"Review"}')).toBe('Review')
    expect(labelOf('nope')).toBeUndefined()
  })
})

describe('the board', () => {
  const file = (fields: Partial<LiveFile> & Pick<LiveFile, 'id' | 'state'>): LiveFile => ({ v: 1, beat: T0, every: 2000, project: 'claude', since: T0 - 60_000, words: fields.state, ...fields })

  test('sorted: needs you (oldest first), working (longest first), failed, ready (newest first), idle, offline', () => {
    const view = viewOf({
      self: null,
      now: T0,
      pin: '',
      files: [
        file({ id: 'idle1', state: 'idle' }),
        file({ id: 'ready-old', state: 'ready', since: T0 - 600_000 }),
        file({ id: 'need-new', state: 'needs', since: T0 - 60_000 }),
        file({ id: 'gone', state: 'working', beat: T0 - 60_000 }),
        file({ id: 'work-short', state: 'working', since: T0 - 30_000 }),
        file({ id: 'fail', state: 'failed' }),
        file({ id: 'need-old', state: 'needs', since: T0 - 360_000 }),
        file({ id: 'work-long', state: 'working', since: T0 - 300_000 }),
        file({ id: 'ready-new', state: 'ready', since: T0 - 120_000 }),
      ],
    })
    expect(view.rows.map(row => row.id)).toEqual(['need-old', 'need-new', 'work-long', 'work-short', 'fail', 'ready-new', 'ready-old', 'idle1'])
    expect(view.folded).toBe('+1 offline')
    expect(view.oldestNeed?.time).toBe('waited 6m')
    expect(view.counts).toEqual({ ...emptyCounts(), needs: 2, working: 2, failed: 1, ready: 2, idle: 1, offline: 1 })
  })

  test('closed files, this session and files older than a day are left out; a ready past 30 minutes reads idle', () => {
    const view = viewOf({
      self: null,
      selfId: 's1',
      now: T0,
      pin: '',
      files: [file({ id: 's1', state: 'working' }), file({ id: 'shut', state: 'idle', closed: true }), file({ id: 'old', state: 'idle', beat: T0 - 25 * 3_600_000 }), file({ id: 'r', state: 'ready', since: T0 - READY_MS })],
    })
    expect(view.rows.map(row => [row.id, row.state, row.words])).toEqual([['r', 'idle', 'Idle']])
  })

  test('idle and offline fold away first: at most 8 rows unless more sessions need you or work', () => {
    const files = Array.from({ length: 12 }, (_, at) => file({ id: `s${at + 10}`, state: at < 3 ? 'working' : 'idle', since: T0 - at * 1000 }))
    const view = viewOf({ self: null, now: T0, pin: '', files })
    expect(view.rows).toHaveLength(8)
    expect(view.folded).toBe('+4 idle')
    const busy = viewOf({ self: null, now: T0, pin: '', files: Array.from({ length: 10 }, (_, at) => file({ id: `w${at}`, state: 'working' })) })
    expect(busy.rows).toHaveLength(10)
  })

  test('times move in whole minutes', () => {
    expect(span(59_999)).toBe('<1m')
    expect(span(6 * 60_000 + 5000)).toBe('6m')
    expect(span(65 * 60_000)).toBe('1h 5m')
    expect(span(120 * 60_000)).toBe('2h')
    expect(span(50 * 3_600_000)).toBe('2d')
    expect(timeWords('ready', T0 - 1000, T0)).toBe('just now')
    expect(timeWords('ready', T0 - 180_000, T0)).toBe('3m ago')
    expect(timeWords('needs', T0 - 360_000, T0)).toBe('waited 6m')
  })

  test('each state has its own shape', () => {
    const shapes = (['needs', 'working', 'ready', 'failed', 'idle', 'offline'] as const).map(glyphOf)
    expect(new Set(shapes).size).toBe(6)
  })

  test('the band says nothing while nothing else goes on', () => {
    const quiet = viewOf({ self: null, now: T0, pin: '', files: [file({ id: 'a', state: 'idle' })] })
    expect(bandWords(quiet)).toBeUndefined()
    const busy = viewOf({ self: null, now: T0, pin: '', files: [file({ id: 'a', state: 'needs', title: 'Refactor auth', since: T0 - 360_000 }), file({ id: 'b', state: 'needs' }), file({ id: 'c', state: 'working' })] })
    expect(bandWords(busy)).toEqual({ lead: '▲ Refactor auth waited 6m (+1)', parts: ['◐ 1 working'] })
  })

  test('the command words', () => {
    expect(parseArgs('')).toEqual({ kind: 'open' })
    expect(parseArgs(' next ')).toEqual({ kind: 'next' })
    expect(parseArgs('name  Review   v2')).toEqual({ kind: 'name', label: 'Review v2' })
    expect(parseArgs('pin test')).toEqual({ kind: 'pin', mode: 'test' })
    expect(parseArgs('pin maybe').kind).toBe('bad')
    expect(toolLabel('mcp__x__y__z')).toBe('y__z')
  })

  test('what a pin call came to', () => {
    expect(pinOutcome({ result: 'ok' })).toBeUndefined()
    expect(pinOutcome({ deny: 'no such tool' })).toBe('no such tool')
    expect(pinOutcome({ result: {}, isError: true, text: 'Unknown session' })).toBe('Unknown session')
    expect(pinOutcome(undefined)).toBe('no answer')
  })
})

// ---------------------------------------------------------------------------
// The mod, through the engine
// ---------------------------------------------------------------------------

for (const surface of SURFACES) {
  describe(`on ${surface}`, () => {
    test('a turn: its file says working, then ready; the pane draws the mark left of the name', async ($, on) => {
      const world = engine(on, $)
      await $.session.start(begin)
      await $.turn.start({ text: 'go', turnId: 't1' })
      await world.clock.advance(1000)
      expect(own(world)?.state).toBe('working')
      expect(own(world)?.project).toBe('web-app')
      await run($.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 }))
      await world.clock.advance(1000)
      expect(own(world)?.words).toBe('Writing')
      await $.turn.complete(complete('answer'))
      await world.clock.advance(1000)
      expect(own(world)?.state).toBe('ready')

      const ui = await $.ui.mount({ plugin: 'session-pulse', surface, component: 'Pane', requestId: 'pulse', props: PANE })
      const row = await ui.find({ type: 'Box', key: 'row-s1' })
      expect(row).toBeDefined()
      const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
      const mark = texts.indexOf('✓')
      expect(mark).toBeGreaterThanOrEqual(0)
      // The mark comes first, the name right after it.
      expect(texts[mark + 1]).toBe('web-app')
      expect(await ui.find({ type: 'Text', text: 'this session' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'No other session on this machine right now.' })).toBeDefined()
      await ui.unmount()
    })

    test('a permission prompt: "needs you" after 2 s, gone once answered', async ($, on) => {
      const world = engine(on, $)
      world.verdicts.Bash = 'ask'
      await $.session.start(begin)
      await $.turn.start({ text: 'go', turnId: 't1' })
      world.during = async () => {
        await world.clock.advance(1000)
        expect([own(world)?.state, own(world)?.beat, own(world)?.since]).toEqual(['working', 1000, 0])
        await world.clock.advance(2000)
        expect(own(world)?.state).toBe('needs')
        expect(own(world)?.words).toBe('Approve Bash')
      }
      await $.tool.call({ tool: 'Bash', command: 'ls' })
      await world.clock.advance(1000)
      expect(own(world)?.state).toBe('working')
    })

    test('a question waits on you at once', async ($, on) => {
      const world = engine(on, $)
      await $.session.start(begin)
      await $.turn.start({ text: 'go', turnId: 't1' })
      world.during = async () => {
        await world.clock.advance(1000)
        expect(own(world)?.words).toBe('Answer a question')
      }
      await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
      await world.clock.advance(1000)
      expect(own(world)?.state).toBe('working')
    })

    test('other sessions: sorted rows, the band names who waited longest and keeps the mods beneath it', async ($, on) => {
      const world = engine(on, $)
      peer(world, { id: 'p1', state: 'working', words: 'Thinking', title: 'Fix flaky test' })
      peer(world, { id: 'p2', state: 'needs', words: 'Approve Bash', title: 'Refactor auth flow', since: world.clock.now() - 360_000 })
      peer(world, { id: 'p3', state: 'idle', words: 'Idle', title: 'Graphify install' }, 120_000)
      await $.session.start(begin)
      await world.clock.advance(1000)

      const ui = await $.ui.mount({ plugin: 'session-pulse', surface, component: 'Pane', requestId: 'pulse', props: PANE })
      const keys = (await ui.findAll({ type: 'Box' })).map(box => box.props.key).filter(key => typeof key === 'string' && key.startsWith('row-'))
      expect(keys).toEqual(['row-s1', 'row-p2', 'row-p1', 'row-p3'])
      expect(await ui.find({ type: 'Text', text: 'Offline' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'waited 6m' })).toBeDefined()
      await ui.unmount()

      const band = await $.ui.mount({ plugin: 'session-pulse', surface, component: 'AbovePrompt', props: BAND })
      expect(await band.find({ type: 'Text', text: 'ENGINE BAND' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: '▲ Refactor auth flow waited 6m' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: '◐ 1 working' })).toBeDefined()
      await band.unmount()

      expect((await $.command.run(pulse('next'))).text).toBe('Refactor auth flow needs you: Approve Bash (waited 6m).')
      expect(world.toasts).toContain('Refactor auth flow needs you: Approve Bash (waited 6m).')
    })

    test('the band hides when nothing else goes on, and shows only the mods beneath', async ($, on) => {
      const world = engine(on, $)
      peer(world, { id: 'p3', state: 'idle', words: 'Idle' })
      await $.session.start(begin)
      await world.clock.advance(1000)
      const band = await $.ui.mount({ plugin: 'session-pulse', surface, component: 'AbovePrompt', props: BAND })
      expect(await band.find({ type: 'Text', text: 'ENGINE BAND' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: '/pulse' })).toBeUndefined()
      await band.unmount()
    })
  })
}

describe('the file on disk', () => {
  test('the session ends: its file is closed and the others skip it', async ($, on) => {
    const world = engine(on, $)
    await $.session.start(begin)
    await world.clock.advance(1000)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(own(world)?.closed).toBe(true)
    await world.clock.advance(5000)
    expect(own(world)?.closed).toBe(true)
  })

  test('/pulse name lasts: it goes into the file and comes back at the next start', async ($, on) => {
    const world = engine(on, $)
    await $.session.start(begin)
    await $.command.run(pulse('name Review notes'))
    await world.clock.advance(1000)
    expect(own(world)?.title).toBe('Review notes')
    expect(labelOf(world.disk.get(OWN)?.text ?? '')).toBe('Review notes')
  })

  test('writes only its own file, and only in the live folder', async ($, on) => {
    const world = engine(on, $)
    peer(world, { id: 'p1', state: 'working', words: 'Thinking' })
    const before = world.disk.get(`${LIVE}/p1.json`)?.text
    await $.session.start(begin)
    await world.clock.advance(10_000)
    expect([...world.disk.keys()].sort()).toEqual([`${LIVE}/p1.json`, OWN])
    expect(world.disk.get(`${LIVE}/p1.json`)?.text).toBe(before)
  })
})

describe('pin while waiting', () => {
  test('off by default: no app tool is called', async ($, on) => {
    const world = engine(on, $)
    world.verdicts.Bash = 'ask'
    await $.session.start(begin)
    await $.turn.start({ text: 'go', turnId: 't1' })
    world.during = async () => {
      await world.clock.advance(4000)
    }
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(world.calls.map(call => call.tool)).toEqual(['Bash'])
  })

  test('on: pins this session while it waits, unpins after; only ever "self"', async ($, on) => {
    const world = engine(on, $)
    world.verdicts.Bash = 'ask'
    await $.session.start(begin)
    await $.command.run(pulse('pin on'))
    expect(world.store.get('pin')).toBe(true)
    await $.turn.start({ text: 'go', turnId: 't1' })
    world.during = async tool => {
      if (tool === 'Bash') await world.clock.advance(4000)
    }
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await world.clock.advance(2000)
    const pins = world.calls.filter(call => call.tool === PIN_TOOL)
    expect(pins.map(call => call.input)).toEqual([
      { session_id: 'self', pinned: true },
      { session_id: 'self', pinned: false },
    ])
  })

  test('if the app would ask before each pin, Pulse denies its own call and stops pinning', async ($, on) => {
    const world = engine(on, $)
    world.verdicts.Bash = 'ask'
    world.verdicts[PIN_TOOL] = 'ask'
    await $.session.start(begin)
    await $.command.run(pulse('pin on'))
    await $.turn.start({ text: 'go', turnId: 't1' })
    world.during = async tool => {
      if (tool === 'Bash') await world.clock.advance(6000)
    }
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await world.clock.advance(2000)
    expect(world.calls.filter(call => call.tool === PIN_TOOL)).toHaveLength(1)
    const ui = await $.ui.mount({ plugin: 'session-pulse', surface: 'desktop', component: 'Pane', requestId: 'pulse', props: PANE })
    expect(await ui.find({ type: 'Text', text: /stopped \(the app asks before each pin\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('/pulse pin test says what happened', async ($, on) => {
    const world = engine(on, $)
    await $.session.start(begin)
    expect((await $.command.run(pulse('pin test'))).text).toMatch(/^Pinning works/)
    world.verdicts[PIN_TOOL] = 'deny'
    expect((await $.command.run(pulse('pin test'))).text).toMatch(/^Pinning does not work here/)
  })
})

describe('egress', () => {
  test('no network, process, model or telemetry call, whatever happens', async ($, on) => {
    const seen: string[] = []
    for (const op of ['http.fetch', 'mcp.connect', 'mcp.call', 'model.complete', 'model.classify', 'telemetry.log']) {
      on(op as never, (() => {
        seen.push(op)
        throw new Error(`forbidden: ${op}`)
      }) as never)
    }
    on('process.spawn' as never, async function* () {
      seen.push('process.spawn')
      yield* []
      throw new Error('forbidden: process.spawn')
    } as never)
    const world = engine(on, $)
    peer(world, { id: 'p1', state: 'needs', words: 'Approve Bash' })
    await $.session.start(begin)
    await $.command.run(pulse('pin on'))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
    await $.turn.complete(complete('error'))
    await world.clock.advance(30_000)
    await $.command.run(pulse('next'))
    const ui = await $.ui.mount({ plugin: 'session-pulse', surface: 'desktop', component: 'Pane', requestId: 'pulse', props: PANE })
    await ui.unmount()
    expect(seen).toEqual([])
    // The only tools Pulse itself calls are the pin tool; the Read above was the test's.
    expect(world.calls.filter(call => call.tool !== 'Read').every(call => call.tool === PIN_TOOL)).toBe(true)
  })
})

export type { Row }
