import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentInfo, On, PaneOpenArgs, RenderElement, SessionUsage } from 'claude-code'

import type { Ledger, Live, Ui, ViewId } from '../types'
import { EMPTY_UI, emptyLedger, emptyLive, recordTurn, syncAgents } from './ledger'
import { KEYS_HINT, bandModel, bandText, paneBlocks, paneLines, paneWidth, statusWords, summaryText } from './views'
import { drawText } from './testkit/draw'
import type { ViewData } from './views'

const SURFACES = ['terminal', 'desktop'] as const

const HOUR = 3_600_000
const T0 = Date.parse('2026-10-07T12:00:00Z')

const PANE = {
  title: 'Usage',
  isFocused: false,
  bodyColumns: 110,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 110,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
} as const

const SECRET = 'THE SECRET ANSWER'

/** What the test sets up and reads back around the stand-in engine. */
type World = {
  clock: MockClock
  /** What `$.session.usage()` answers (the breakdown is cut when the call did not ask for it). */
  usage: Record<string, unknown>
  /** What `$.agent.list()` answers. */
  listed: AgentInfo[]
  /** True makes `$.agent.list()` throw. */
  listFails: boolean
  /** True makes `$.session.usage()` throw. */
  usageFails: boolean
  commands: string[]
  opened: PaneOpenArgs[]
  statuses: (string | undefined)[]
  toasts: string[]
  usageCalls: number
  /** The last value the mod wrote to each of its state keys. */
  state: Record<string, unknown>
}

const BREAKDOWN = {
  categories: [
    { name: 'Free space', tokens: 560_000, kind: 'free' },
    { name: 'Messages', tokens: 312_000, kind: 'used' },
    { name: 'System tools', tokens: 38_000, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 30_000, kind: 'buffer' },
  ],
  autoCompactThreshold: 820_000,
}

function usageOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startedAt: 1,
    context: { tokens: 410_000, window: 1_000_000, percent: 41, breakdown: BREAKDOWN },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(T0 + 3 * HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 18 },
    ],
    cost: { usd: 0 },
    ...over,
  }
}

/** What stands for the engine beneath the plugin: it answers each event and op the mod uses. */
function engine(on: On): World {
  const world: World = {
    clock: mock.clock(on, { now: T0 }),
    usage: usageOf(),
    listed: [],
    listFails: false,
    usageFails: false,
    commands: [],
    opened: [],
    statuses: [],
    toasts: [],
    usageCalls: 0,
    state: {},
  }
  on('agent.list', () => {
    if (world.listFails) throw new Error('list is down')

    return { value: world.listed }
  })
  on('session.usage', (_$, e) => {
    world.usageCalls += 1
    if (world.usageFails) throw new Error('usage is down')
    const full = world.usage as { context: Record<string, unknown> }
    if (e.breakdown !== undefined) return { value: full as unknown as SessionUsage }
    const { breakdown, ...context } = full.context
    void breakdown

    return { value: { ...full, context } as unknown as SessionUsage }
  })
  on('command.register', (_$, e) => {
    world.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    world.opened.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.status', (_$, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('state.set', (_$, e, next) => {
    const write = e as unknown as { plugin: string; key: string; value: unknown }
    if (write.plugin === 'usage-meter') world.state[write.key] = write.value

    return next(e)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, null, 'ENGINE BAND') as RenderElement
  })

  return world
}

const use = (i: number, o: number, r: number, w: number, model = 'claude-opus-5-5') => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
  model,
})

const agent = (id: string, fields: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  description: 'Survey the repo',
  type: 'Explore',
  status: 'running',
  ...fields,
})

/** A turn ends. The answer is a marker string: it must never reach the state. */
const complete = ($: Engine, fields: Record<string, unknown>) =>
  $.turn.complete({
    answer: SECRET,
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    ...fields,
  } as never)

const start = ($: Engine) => $.session.start({ cwd: '/work' } as never)

const measure = ($: Engine) =>
  $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context', 'cost'] } as never)

const meterArgs = (args: string) =>
  ({ command: 'meter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }) as never

const ledgerOf = (world: World): Ledger => (world.state['ledger'] as Ledger | undefined) ?? emptyLedger()
const liveOf = (world: World): Live => (world.state['live'] as Live | undefined) ?? emptyLive()
const uiOf = (world: World): Ui => (world.state['ui'] as Ui | undefined) ?? EMPTY_UI

describe('the hooks', () => {
  test('a session start registers /meter and starts the ledger from the engine total', async ($, on) => {
    const world = engine(on)
    world.usage = usageOf({ cost: { usd: 7.5 } })
    await start($)
    expect(world.commands).toEqual(['meter'])
    expect(ledgerOf(world).key).toBe(1)
    expect(ledgerOf(world).base).toBe(7.5)
    expect(world.statuses[world.statuses.length - 1]).toBe('ctx 41% · 5h 62% · 7d 18% · $7.50 est.')
  })

  test('a second start, as a reload makes, keeps the ledger it has', async ($, on) => {
    const world = engine(on)
    await start($)
    await complete($, { usage: use(1000, 500, 10_000, 2000) })
    await start($)
    expect(ledgerOf(world).main.n).toBe(1)
    expect(ledgerOf(world).base).toBe(0)
  })

  test('a main turn is counted and answered with a footer under the answer', async ($, on) => {
    const world = engine(on)
    await start($)
    const out = await complete($, { usage: use(1000, 500, 10_000, 2000) })
    expect(out.text).toBe('↳ $0.03 turn · $0.03 session (est.) · 500 out · 77% cached')
    expect(ledgerOf(world).main.n).toBe(1)
    expect(ledgerOf(world).models['claude-opus-5-5']?.o).toBe(500)
  })

  test('the footer goes off and on with /meter footer', async ($, on) => {
    const world = engine(on)
    await start($)
    expect((await $.command.run(meterArgs('footer off'))).text).toBe('Footer off.')
    expect(uiOf(world).footer).toBe(false)
    expect((await complete($, { usage: use(1, 1, 0, 0) })).text).toBe(SECRET)
    await $.command.run(meterArgs('footer on'))
    expect((await complete($, { usage: use(1, 1, 0, 0) })).text).toMatch(/^↳ <?\$/)
  })

  test('no state value holds the answer text', async ($, on) => {
    const world = engine(on)
    world.listed = [agent('a1')]
    await start($)
    await complete($, { usage: use(1000, 500, 10_000, 2000) })
    await complete($, { agentId: 'a1', usage: use(10, 10, 0, 0) })
    await complete($, { usage: undefined, reason: 'aborted' })
    expect(Object.keys(world.state).sort()).toEqual(['ledger', 'live', 'ui'])
    const everything = JSON.stringify(world.state)
    expect(everything).not.toContain('SECRET')
    expect(everything.length > 100).toBe(true)
  })

  test('a subagent turn passes through untouched, adds a row and refreshes the totals', async ($, on) => {
    const world = engine(on)
    world.listed = [agent('a1', { name: 'scout' })]
    await start($)
    const before = world.usageCalls
    const out = await complete($, { agentId: 'a1', usage: use(100, 50, 0, 1000, 'claude-haiku-4-5-20251001') })
    expect(out.text).toBe(SECRET)
    expect(ledgerOf(world).agents['a1']?.t.n).toBe(1)
    expect(ledgerOf(world).agents['a1']?.model).toBe('claude-haiku-4-5')
    expect(ledgerOf(world).agents['a1']?.name).toBe('scout')
    expect(world.usageCalls > before).toBe(true)
  })

  test('a loop no agent list names lands in the system bucket', async ($, on) => {
    const world = engine(on)
    await start($)
    await complete($, { agentId: 'ghost', usage: use(10, 10, 0, 0) })
    expect(ledgerOf(world).system.n).toBe(1)
    expect(ledgerOf(world).diag.sysIds).toEqual(['ghost'])
  })

  test('a turn without usage is counted by its reason and gets no footer', async ($, on) => {
    const world = engine(on)
    await start($)
    const out = await complete($, { usage: undefined, reason: 'aborted' })
    expect(out.text).toBe(SECRET)
    expect(ledgerOf(world).diag.reasons).toEqual({ aborted: 1 })
    expect(ledgerOf(world).main.n).toBe(0)
  })

  test('a measure pins the status and toasts each level once', async ($, on) => {
    const world = engine(on)
    await start($)
    world.usage = usageOf({
      context: { tokens: 820_000, window: 1_000_000, percent: 82, breakdown: BREAKDOWN },
      rateLimits: [{ kind: 'five_hour', percentUsed: 76, resetsAt: new Date(T0 + 3 * HOUR).toISOString() }],
      cost: { usd: 12 },
    })
    await measure($)
    expect(world.toasts).toEqual([
      'Usage: context 82%. Auto-compaction near 82%.',
      'Usage: 5h window 76%.',
      'Usage: session passed est. $10.00.',
    ])
    expect(world.statuses[world.statuses.length - 1]).toBe('ctx 82% ▲ · 5h 76% ▲ · $12.00 est.')
    await measure($)
    expect(world.toasts).toHaveLength(3)
  })

  test('an alert comes back after the value fell below its level and rose again', async ($, on) => {
    const world = engine(on)
    await start($)
    world.usage = usageOf({ context: { tokens: 850_000, window: 1_000_000, percent: 85, breakdown: BREAKDOWN } })
    await measure($)
    expect(world.toasts).toHaveLength(1)
    world.usage = usageOf({ context: { tokens: 100_000, window: 1_000_000, percent: 10, breakdown: BREAKDOWN } })
    await measure($)
    world.usage = usageOf({ context: { tokens: 840_000, window: 1_000_000, percent: 84, breakdown: BREAKDOWN } })
    await measure($)
    expect(world.toasts).toHaveLength(2)
  })

  test('an agent that ends after the main turn still updates the status', async ($, on) => {
    const world = engine(on)
    world.listed = [agent('bg', { status: 'completed' })]
    await start($)
    world.usage = usageOf({ cost: { usd: 1.5 } })
    await complete($, { agentId: 'bg', usage: use(0, 50_000, 0, 0) })
    expect(world.statuses[world.statuses.length - 1]).toBe('ctx 41% · 5h 62% · 7d 18% · $1.50 est.')
  })

  test('a /clear forgets the count and clears the status', async ($, on) => {
    const world = engine(on)
    await start($)
    await complete($, { usage: use(1000, 500, 10_000, 2000) })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(ledgerOf(world).main.n).toBe(0)
    expect(ledgerOf(world).key).toBe(0)
    expect(ledgerOf(world).base).toBeNull()
    expect(liveOf(world).measures).toBe(0)
    expect(world.statuses[world.statuses.length - 1]).toBeUndefined()
  })

  test('any other end leaves the count alone', async ($, on) => {
    const world = engine(on)
    await start($)
    await complete($, { usage: use(1000, 500, 10_000, 2000) })
    await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(ledgerOf(world).main.n).toBe(1)
  })

  test('/meter status answers in text, /meter reset starts a new count, a bad word gets the usage line', async ($, on) => {
    const world = engine(on)
    await start($)
    await complete($, { usage: use(1000, 500, 10_000, 2000) })
    const status = await $.command.run(meterArgs('status'))
    expect(status.text).toContain('tokens: 1.0k uncached · 500 output · 10k cache read · 2.0k cache write')
    world.usage = usageOf({ cost: { usd: 4 } })
    const reset = await $.command.run(meterArgs('reset'))
    expect(reset.text).toContain('Count cleared')
    expect(ledgerOf(world).main.n).toBe(0)
    expect(ledgerOf(world).base).toBe(4)
    expect((await $.command.run(meterArgs('nope'))).text).toContain('/meter')
  })

  test('/meter opens the pane', async ($, on) => {
    const world = engine(on)
    await start($)
    const out = await $.command.run(meterArgs(''))
    expect(out.text).toBe('Usage pane opened.')
    expect(world.opened.map(pane => pane.id)).toEqual(['meter'])
  })

  test('/meter models and /meter agents switch the view and open the pane, with no click', async ($, on) => {
    const world = engine(on)
    await start($)
    expect((await $.command.run(meterArgs('models'))).text).toBe('Usage pane: models.')
    expect(uiOf(world).view).toBe('models')
    expect((await $.command.run(meterArgs('agents'))).text).toBe('Usage pane: agents.')
    expect(uiOf(world).view).toBe('agents')
    expect((await $.command.run(meterArgs('overview'))).text).toBe('Usage pane: overview.')
    expect(uiOf(world).view).toBe('overview')
    expect(world.opened.map(pane => pane.id)).toEqual(['meter', 'meter', 'meter'])
  })

  test('/meter refresh reads the engine again and /meter diag opens the diagnostics tab', async ($, on) => {
    const world = engine(on)
    await start($)
    const before = world.usageCalls
    world.usage = usageOf({ cost: { usd: 6.25 } })
    expect((await $.command.run(meterArgs('refresh'))).text).toBe('Usage read again.')
    expect(world.usageCalls > before).toBe(true)
    expect(liveOf(world).usd).toBe(6.25)
    expect((await $.command.run(meterArgs('diag'))).text).toBe('Usage pane: diag.')
    expect(uiOf(world).view).toBe('diag')
    expect((await $.command.run(meterArgs('diag off'))).text).toContain('/meter')
    expect(world.opened.map(pane => pane.id)).toEqual(['meter'])
  })

  test('the pane tells where the keyboard way is, on every tab', async ($, on) => {
    engine(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'Pane', requestId: 'meter', props: PANE })
      for (const key of ['tab-overview', 'tab-models', 'tab-agents', 'tab-diag']) {
        await ui.press({ key })
        await ui.redraw()
        expect(await ui.find({ type: 'Text', text: KEYS_HINT }), key).toBeDefined()
      }
      await ui.unmount()
    }
  })

  test('a failing engine call never breaks a turn', async ($, on) => {
    const world = engine(on)
    world.listFails = true
    await start($)
    const out = await complete($, { agentId: 'a1', usage: use(1, 1, 0, 0) })
    expect(out.text).toBe(SECRET)
    expect(ledgerOf(world).system.n).toBe(1)
  })

  test('a usage read that fails at the start still registers the command and still counts turns', async ($, on) => {
    const world = engine(on)
    world.usageFails = true
    await start($)
    expect(world.commands).toEqual(['meter'])
    const out = await complete($, { usage: use(1000, 500, 10_000, 2000) })
    expect(out.text).toMatch(/^↳ \$/)
    expect(ledgerOf(world).main.n).toBe(1)
  })

  test('the cost alert follows the costAlertUsd option', { options: { costAlertUsd: 5 } }, async ($, on) => {
    const world = engine(on)
    await start($)
    world.usage = usageOf({ cost: { usd: 11 } })
    await measure($)
    expect(world.toasts).toEqual(['Usage: session passed est. $10.00.'])
  })

  test('a costAlertUsd of 0 turns the cost alert off', { options: { costAlertUsd: 0 } }, async ($, on) => {
    const world = engine(on)
    await start($)
    world.usage = usageOf({ cost: { usd: 500 } })
    await measure($)
    expect(world.toasts).toEqual([])
  })
})

describe('the views as text', () => {
  const data = (over: Partial<ViewData> = {}): ViewData => ({
    ledger: emptyLedger(),
    live: emptyLive(),
    ui: EMPTY_UI,
    now: T0,
    ...over,
  })

  const busy = (view: ViewId = 'overview'): ViewData => {
    let ledger: Ledger = { ...emptyLedger(1), base: 0 }
    ledger = recordTurn(ledger, { usage: use(1000, 500, 10_000, 2000), now: T0 })
    ledger = recordTurn(ledger, {
      agentId: 'a1',
      usage: use(100, 50, 0, 1000, 'claude-haiku-4-5'),
      now: T0,
      sight: { id: 'a1', type: 'Explore', label: 'Survey the repo', status: 'completed' },
    })
    ledger = recordTurn(ledger, {
      agentId: 'f1',
      usage: use(5000, 100, 5000, 90_000),
      now: T0,
      sight: { id: 'f1', type: 'fork', label: 'Review the diff', status: 'running', parent: 'a1' },
    })
    ledger = recordTurn(ledger, { agentId: 'ghost', usage: use(10, 10, 0, 0), now: T0 })
    ledger = recordTurn(ledger, { usage: use(5, 5, 0, 0, 'claude-new-9'), now: T0 })
    const live: Live = {
      ...emptyLive(),
      usd: 0.9,
      at: T0,
      ctx: { tokens: 410_000, window: 1_000_000, percent: 41, growth: 20_000, cats: [['Messages', 312_000]], threshold: 820_000 },
      limits: { five_hour: { s: [[T0, 62]], d: 0 } },
      account: 'subscription',
      measures: 3,
    }

    return data({ ledger, live, ui: { ...EMPTY_UI, view } })
  }

  const text = (view: ViewId, width = 100, d = busy(view)): string => paneLines({ ...d, ui: { ...d.ui, view } }, width).join('\n')

  test('every view of every state stays inside its width', () => {
    for (const d of [data(), busy()]) {
      for (const view of ['overview', 'models', 'agents', 'diag'] as const) {
        for (const width of [24, 30, 40, 56, 60, 72, 84, 100, 108]) {
          for (const each of paneLines({ ...d, ui: { ...d.ui, view } }, width)) {
            expect(each.length <= width, `${view} @ ${width}: "${each}"`).toBe(true)
          }
        }
      }
    }
  })

  test('a wide surface is held to 108 columns and a tiny one to 24', () => {
    expect(paneWidth(200)).toBe(108)
    expect(paneWidth(10)).toBe(24)
    expect(paneWidth(72.6)).toBe(72)
  })

  test('an empty ledger says what it waits for', () => {
    const overview = text('overview', 72, data())
    expect(overview).toContain('no reading yet')
    expect(overview).toContain('no turns counted yet')
    expect(overview).toContain('No turns counted yet. A turn adds its usage when it ends.')
    expect(overview).not.toContain('Spend by model')
    expect(text('models', 72, data())).toContain('No turns counted yet.')
    expect(text('agents', 72, data())).toContain('No turns counted yet.')
    expect(bandModel(data(), 110)).toBeUndefined()
    expect(bandText(data(), 110)).toBeUndefined()
  })

  test('the header names the pane and the last reading, and the tabs follow the width', () => {
    const wide = paneLines(busy(), 100)
    expect(wide[0]).toMatch(/^Usage · this session +updated \d\d:\d\d$/)
    expect(wide[1]).toBe('[ 1 Overview ] [ 2 Models ] [ 3 Agents ] [ 4 Diagnostics ] [ r Refresh ]')
    expect(paneLines(busy(), 60)[1]).toBe('[ Overview ] [ Models ] [ Agents ] [ Diag ] [ Refresh ]')
  })

  test('the overview leads with tiles for spend, context and each window', () => {
    const lines = paneLines(busy(), 100)
    const top = lines.findIndex(each => each.startsWith('╭'))
    expect(lines[top]?.split('╭')).toHaveLength(4)
    const tiles = lines.slice(top, top + 7).join('\n')
    expect(tiles).toContain('│ SPEND ')
    expect(tiles).toContain('│ $0.90 est. ')
    expect(tiles).toContain('… 1 agent running')
    expect(tiles).toContain('│ CONTEXT ')
    expect(tiles).toContain('│ 41% of 1.0M ')
    expect(tiles).toContain('compacts at ~82%')
    expect(tiles).toContain('~20 turns left')
    expect(tiles).toContain('│ 5-HOUR ')
    expect(tiles).toContain('│ 62% ✓ ')
    expect(tiles).toContain('learning pace')
    const narrow = paneLines(busy(), 56)
    expect(narrow.filter(each => each.startsWith('╭'))).toHaveLength(2)
  })

  test('tiles in a row have the same number of lines, so they draw the same height on any surface', () => {
    let rows = 0
    for (const d of [data(), busy()]) {
      for (const width of [100, 72, 56, 30]) {
        for (const block of paneBlocks(d, paneWidth(width))) {
          if (block.kind !== 'tiles') continue
          rows += 1
          expect(new Set(block.tiles.map(tile => tile.length)).size, `tiles @ ${width}`).toBe(1)
        }
      }
    }
    expect(rows > 8).toBe(true)
  })

  test('the overview sections show tokens, the context window, spend by model and the notes', () => {
    const overview = text('overview')
    expect(overview).toMatch(/Tokens ─+/)
    expect(overview).toMatch(/Uncached +Output +Cache read +Cache write +Hit rate/)
    expect(overview).toMatch(/6\.1k +665 +15k +93k +13%/)
    expect(overview).toContain('cache saved ≈')
    expect(overview).toMatch(/Context window ─+/)
    expect(overview).toMatch(/Messages +█+[▏▎▍▌▋▊▉]?░+ +312k/)
    expect(overview).toMatch(/Spend by model ─+/)
    expect(overview).toMatch(/opus-5\.5 +█+.*\$0\.\d\d +\d+%/)
    expect(overview).toMatch(/new-9 +unpriced +— *\n/)
    expect(overview).toMatch(/main \$[\d.]+ · 2 agents \$[\d.]+ · system /)
    expect(overview).toContain('prices as of 2026-10-07 · est. = engine estimate, not a bill')
    expect(overview).toContain(KEYS_HINT)
  })

  test('the models table picks its columns by width and totals the rows', () => {
    const wide = text('models', 100).split('\n')
    expect(wide).toContainEqual(expect.stringMatching(/^Model +Turns +Output +Cache read +Cache write +Uncached +Cost +Share$/))
    expect(wide).toContainEqual(expect.stringMatching(/^opus-5\.5 +3 +610 +15k +92k +6\.0k +\$0\.\d\d █/))
    expect(wide).toContainEqual(expect.stringMatching(/^new-9 +1 +5 +0 +0 +5 +— unpriced$/))
    expect(wide).toContainEqual(expect.stringMatching(/^Total +5 +665 +15k +93k +6\.1k +\$0\.\d\d$/))
    expect(text('models', 64)).toMatch(/\nModel +Turns +Output +Cost +Share\n/)
    expect(text('models', 40)).toMatch(/\nModel +Cost +Share\n/)
    expect(text('models', 100)).toContain('prices as of 2026-10-07 · cache writes priced as 5-minute')
  })

  test('the agents table rolls cost up the tree and marks status, a cold fork and the system loops', () => {
    const lines = text('agents', 100).split('\n')
    expect(lines).toContainEqual(expect.stringMatching(/^Agent +Model +Cost +Turns +Status$/))
    expect(lines).toContainEqual(expect.stringMatching(/^main \(this conversation\) +\$[\d.]+ +2$/))
    expect(lines).toContainEqual(expect.stringMatching(/^└─ Explore · Survey the repo +haiku-4\.5 +\$[\d.]+ +1 ✓ done$/))
    expect(lines).toContainEqual(expect.stringMatching(/^ {3}└─ fork · Review the diff +opus-5\.5 +\$[\d.]+ +1 ● running$/))
    expect(lines).toContainEqual(expect.stringMatching(/^ {9}▲ cold prefix \(hit 5%\)$/))
    expect(lines).toContainEqual(expect.stringMatching(/^system \(unnamed engine loops\) +<?\$[\d.]+ +1$/))
    expect(text('agents', 56)).toMatch(/\nAgent +Cost +Status\n/)
  })

  test('the diagnostics tab lays out the ledger, the session and the prices', () => {
    const diag = text('diag')
    expect(diag).toMatch(/Ledger ─+/)
    expect(diag).toMatch(/Turns +5 with usage · 0 without/)
    expect(diag).toMatch(/Check +settling: 1 agent still running/)
    expect(diag).toMatch(/Unnamed loops +1 · ghost/)
    expect(diag).toContain('claude-new-9')
    expect(diag).toMatch(/Session ─+/)
    expect(diag).toMatch(/Account +subscription: the cost is an API-equivalent figure/)
    expect(diag).toMatch(/Prices ─+/)
    expect(diag).toMatch(/Table +as of 2026-10-07/)
  })

  test('status words always carry a glyph and a word', () => {
    expect(statusWords('running')).toBe('● running')
    expect(statusWords('waiting')).toBe('● running')
    expect(statusWords('idle')).toBe('○ idle')
    expect(statusWords('completed')).toBe('✓ done')
    expect(statusWords('failed')).toBe('✖ failed')
    expect(statusWords('killed')).toBe('✖ stopped')
  })

  test('the band draws bars when wide, drops them, then the name, as room runs short', () => {
    const view = busy()
    expect(bandText(view, 110)).toBe('◆ Usage   ctx ██▌░░░ 41%   5h ███▊░░ 62%   $0.90 est.   [ Details ]')
    expect(bandText(view, 60)).toBe('◆ Usage   ctx 41%   5h 62%   $0.90 est.   [ Details ]')
    expect(bandText(view, 40)).toBe('◆  ctx 41%  5h 62%  $0.90 est.  [ Details ]')
  })

  test('the band marks a window that needs care with a glyph, and its fill time when there is room', () => {
    const view = busy()
    const hot: ViewData = {
      ...view,
      now: T0 + 60 * 60_000,
      live: {
        ...view.live,
        ctx: { ...view.live.ctx, percent: 84 },
        limits: { five_hour: { s: [[T0, 50], [T0 + 30 * 60_000, 55], [T0 + 60 * 60_000, 60]], resetsAt: new Date(T0 + 6 * HOUR).toISOString(), d: 5 } },
      },
    }
    expect(bandText(hot, 110)).toMatch(/^◆ Usage {3}ctx █+.* 84% ▲ {3}5h █+.* 60% ▲ full ~\d\d:\d\d {3}\$0\.90 est\. {3}\[ Details \]$/)
    expect(bandText(hot, 60)).toMatch(/^◆ Usage {2,3}ctx 84% ▲ {2,3}5h 60% ▲( full ~\d\d:\d\d)? {2,3}\$0\.90 est\. {2,3}\[ Details \]$/)
  })

  test('the summary has the status entry, the tokens and the check', () => {
    const lines = summaryText(busy()).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('ctx 41% · 5h 62% · $0.90 est.')
    expect(lines[1]).toBe('tokens: 6.1k uncached · 665 output · 15k cache read · 93k cache write · 13% hit')
    expect(lines[2]).toBe('check: settling: 1 agent still running')
  })

  test('a listed agent with no turn yet shows as a zero row', () => {
    const ledger = syncAgents(emptyLedger(1), [{ id: 'a1', type: 'Plan', label: 'Make a plan', status: 'running' }], T0)
    expect(text('agents', 56, data({ ledger }))).toMatch(/\n└─ Plan · Make a plan +\$0\.00 ● running\n/)
  })
})

/** The ViewData the pane draws from right now, rebuilt from what the mod wrote. */
function dataNow(world: World): ViewData {
  return { ledger: ledgerOf(world), live: liveOf(world), ui: uiOf(world), now: world.clock.now() }
}

for (const surface of SURFACES) {
  describe(`on ${surface}`, () => {
    test('the band stays out until there is a reading, and the engine band shows', async ($, on) => {
      engine(on)
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'AbovePrompt', props: BAND })
      expect(drawText(await ui.drawn(), 110)).toEqual(['ENGINE BAND'])
      await ui.unmount()
    })

    test('the band draws under the engine band, and Details opens the pane', async ($, on) => {
      const world = engine(on)
      await start($)
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'AbovePrompt', props: BAND })
      const lines = drawText(await ui.drawn(), 110)
      expect(lines[0]).toBe('ENGINE BAND')
      expect(lines[1]).toBe(bandText(dataNow(world), 110))
      expect(lines[1]).toMatch(/^◆ Usage {3}ctx █+.* 41% {3}5h █+.* 62% {3}7d █+.* 18% {3}\$0\.00 est\. {3}\[ Details \]$/)
      await ui.press({ key: 'details' })
      expect(world.opened.map(pane => pane.id)).toEqual(['meter'])
      await ui.unmount()
    })

    test('a narrow band drops the bars and a survey keeps the band quiet', async ($, on) => {
      engine(on)
      await start($)
      const narrow = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 60 } })
      expect(drawText(await narrow.drawn(), 60)[1]).toBe('◆ Usage  ctx 41%  5h 62%  7d 18%  $0.00 est.  [ Details ]')
      await narrow.unmount()
      const survey = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
      expect(drawText(await survey.drawn(), 110)).toEqual(['ENGINE BAND'])
      await survey.unmount()
    })

    test('the drawn pane is the text the views build, line for line, on every tab and width', async ($, on) => {
      const world = engine(on)
      world.listed = [agent('a1')]
      await start($)
      await complete($, { usage: use(1000, 500, 10_000, 2000) })
      await complete($, { agentId: 'a1', usage: use(100, 50, 0, 1000, 'claude-haiku-4-5') })
      for (const width of [110, 72, 56, 30]) {
        const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'Pane', requestId: 'meter', props: { ...PANE, bodyColumns: width } })
        for (const key of ['tab-overview', 'tab-models', 'tab-agents', 'tab-diag']) {
          await ui.press({ key })
          await ui.redraw()
          expect(drawText(await ui.drawn(), paneWidth(width)), `${key} @ ${width}`).toEqual(paneLines(dataNow(world), width))
        }
        await ui.unmount()
      }
    })

    test('the tabs switch views and mark the active one', async ($, on) => {
      const world = engine(on)
      world.listed = [agent('a1')]
      await start($)
      await complete($, { usage: use(1000, 500, 10_000, 2000) })
      await complete($, { agentId: 'a1', usage: use(100, 50, 0, 1000, 'claude-haiku-4-5') })
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'Pane', requestId: 'meter', props: PANE })
      expect((await ui.find({ type: 'Button', key: 'tab-overview' }))?.props['variant']).toBe('primary')
      expect((await ui.find({ type: 'Button', key: 'tab-models' }))?.props['variant']).toBe('secondary')
      await ui.press({ key: 'tab-models' })
      await ui.redraw()
      expect(uiOf(world).view).toBe('models')
      expect((await ui.find({ type: 'Button', key: 'tab-models' }))?.props['variant']).toBe('primary')
      expect(drawText(await ui.drawn(), 108)).toContainEqual(expect.stringMatching(/^haiku-4\.5 /))
      await ui.press({ key: 'tab-agents' })
      await ui.redraw()
      expect(drawText(await ui.drawn(), 108)).toContainEqual(expect.stringMatching(/^└─ Explore · Survey the repo /))
      await ui.press({ key: 'tab-diag' })
      await ui.redraw()
      expect(uiOf(world).view).toBe('diag')
      expect(drawText(await ui.drawn(), 108)).toContainEqual(expect.stringMatching(/^Ledger ─+$/))
      await ui.unmount()
    })

    test('the tab labels carry their hotkeys when wide and shorten when narrow', async ($, on) => {
      engine(on)
      await start($)
      const wide = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'Pane', requestId: 'meter', props: PANE })
      expect((await wide.findAll({ type: 'Button' })).map(found => [found.key, found.props['label'], found.props['hotkey']])).toEqual([
        ['tab-overview', '1 Overview', '1'],
        ['tab-models', '2 Models', '2'],
        ['tab-agents', '3 Agents', '3'],
        ['tab-diag', '4 Diagnostics', '4'],
        ['refresh', 'r Refresh', 'r'],
      ])
      await wide.unmount()
      const narrow = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'Pane', requestId: 'meter', props: { ...PANE, bodyColumns: 60 } })
      expect((await narrow.findAll({ type: 'Button' })).map(found => found.props['label'])).toEqual(['Overview', 'Models', 'Agents', 'Diag', 'Refresh'])
      await narrow.unmount()
    })

    test('Refresh reads the engine again', async ($, on) => {
      const world = engine(on)
      await start($)
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'Pane', requestId: 'meter', props: PANE })
      world.usage = usageOf({ cost: { usd: 9.99 } })
      await ui.press({ key: 'refresh' })
      await ui.redraw()
      expect(drawText(await ui.drawn(), 108).join('\n')).toContain('│ $9.99 est. ')
      await ui.unmount()
    })

    test('the check turns ok once the engine total matches the ledger', async ($, on) => {
      const world = engine(on)
      await start($)
      await complete($, { usage: use(0, 50_000, 0, 0) })
      world.usage = usageOf({ cost: { usd: 1.01 } })
      await measure($)
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'Pane', requestId: 'meter', props: PANE })
      expect(drawText(await ui.drawn(), 108).join('\n')).toContain('│ ✓ 99% accounted ')
      await ui.unmount()
    })

    test('every run is drawn with a known style and no undefined prop', async ($, on) => {
      engine(on)
      await start($)
      await complete($, { usage: use(1000, 500, 10_000, 2000) })
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'Pane', requestId: 'meter', props: PANE })
      for (const key of ['tab-overview', 'tab-models', 'tab-agents', 'tab-diag']) {
        await ui.press({ key })
        await ui.redraw()
        for (const found of await ui.findAll({ type: 'Text' })) {
          for (const [name, value] of Object.entries(found.props)) {
            expect(value === undefined, `${key}: Text prop ${name} is undefined`).toBe(false)
            if (name === 'color') expect(['claude', 'success', 'warning', 'error']).toContain(value)
          }
        }
      }
      await ui.unmount()
    })
  })
}
