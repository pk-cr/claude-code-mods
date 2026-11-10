// QA suite: what the unit tests do not reach. Randomized event streams checked
// against invariants, hostile inputs, concurrent agent turns, and whole-session
// scenarios (/clear, resume, reload, a window that resets) through the real hooks.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement, SessionUsage } from 'claude-code'

import type { Ledger, Live } from '../types'
import {
  EMPTY_UI,
  MAX_AGENTS,
  ZERO,
  alertsFor,
  applyMeasure,
  attributed,
  buildTree,
  checkLedger,
  emptyLedger,
  emptyLive,
  noteMissing,
  recordTurn,
  settle,
  statusLine,
  sumTally,
  syncAgents,
  totalTally,
} from './ledger'
import type { Sighting } from './ledger'
import type { ViewId } from '../types'
import { bandText, paneLines, summaryText } from './views'
import type { ViewData } from './views'
import { drawText } from './testkit/draw'

const SURFACES = ['terminal', 'desktop'] as const
const MIN = 60_000
const HOUR = 3_600_000
const T0 = Date.parse('2026-10-07T12:00:00Z')

const PANE = {
  title: 'Usage',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

// ---------------------------------------------------------------------------
// Random streams against invariants
// ---------------------------------------------------------------------------

/** A small seeded generator, so a failure repeats. */
function seeded(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0

    return state / 4294967296
  }
}

const MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5-1',
  'claude-fable-5[1m]',
  'claude-unknown-9',
  'weird model id',
]
const STATUSES = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed']
const TYPES = ['Explore', 'general-purpose', 'fork', 'teammate', 'plugin:helper']

const BAD_TEXT = /NaN|undefined|Infinity|\[object|null/

/** Every number finite, no function or undefined anywhere, and the value is its own JSON round trip. */
function expectPlainData(value: unknown, what: string): void {
  const walk = (item: unknown, path: string): void => {
    if (typeof item === 'number') expect(Number.isFinite(item), `${what}: ${path} is ${item}`).toBe(true)
    else if (typeof item === 'function' || typeof item === 'undefined' || typeof item === 'symbol' || typeof item === 'bigint') {
      throw new Error(`${what}: ${path} is a ${typeof item}`)
    } else if (item !== null && typeof item === 'object') {
      for (const [name, child] of Object.entries(item)) walk(child, `${path}.${name}`)
    }
  }
  walk(value, 'value')
  expect(JSON.parse(JSON.stringify(value)), `${what} is not its own JSON round trip`).toStrictEqual(value)
}

function audit(ledger: Ledger, step: string): void {
  expectPlainData(ledger, `ledger at ${step}`)
  const rows = Object.values(ledger.agents)
  // Every bucket adds up to the model totals.
  const buckets = rows.reduce((sum, row) => sumTally(sum, row.t), sumTally(sumTally(ledger.main, ledger.system), ledger.folded))
  const models = totalTally(ledger)
  for (const field of ['i', 'o', 'r', 'w', 'n', 'np'] as const) {
    expect(buckets[field], `${field} buckets against models at ${step}`).toBe(models[field])
  }
  expect(Math.abs(buckets.usd - models.usd) <= 1e-9 * Math.max(1, Math.abs(models.usd)), `usd buckets against models at ${step}`).toBe(true)
  // The agent table stays small unless agents are still running.
  const ended = rows.filter(row => row.status === 'completed' || row.status === 'failed' || row.status === 'killed')
  expect(rows.length <= MAX_AGENTS || ended.length === 0, `agent table size at ${step}`).toBe(true)
  // The tree lists each agent once and rolls up the whole cost.
  const seen: string[] = []
  const visit = (node: ReturnType<typeof buildTree>): void => {
    seen.push(node.id)
    node.kids.forEach(visit)
  }
  const tree = buildTree(ledger)
  visit(tree)
  expect([...seen].sort(), `tree members at ${step}`).toEqual(['main', ...rows.map(row => row.id)].sort())
  const expected = ledger.main.usd + rows.reduce((sum, row) => sum + row.t.usd, 0)
  expect(Math.abs(tree.sub.usd - expected) <= 1e-9 * Math.max(1, expected), `tree rollup at ${step}`).toBe(true)
  expect(JSON.stringify(ledger).length < 120_000, `state size at ${step}`).toBe(true)
}

const VIEWS: readonly ViewId[] = ['overview', 'models', 'agents', 'diag']

/** No line shows NaN, undefined or a raw object, and none runs past `width`. */
function expectSaneText(lines: readonly string[], width: number, what: string): void {
  for (const one of lines) {
    expect(BAD_TEXT.test(one), `${what}: "${one}"`).toBe(false)
    expect(one.length <= width, `${what} runs past ${width}: "${one}"`).toBe(true)
  }
}

/** Every tab of the pane at a few widths, checked. */
function expectSanePane(view: ViewData, what: string): void {
  for (const tab of VIEWS) {
    for (const width of [100, 56, 30]) expectSaneText(paneLines({ ...view, ui: { ...view.ui, view: tab } }, width), width, `${what} ${tab} @ ${width}`)
  }
}

const LIVE: Live = {
  ...emptyLive(),
  usd: 12.5,
  account: 'subscription',
  measures: 4,
  ctx: { tokens: 300_000, window: 1_000_000, percent: 30, growth: 15_000, cats: [['Messages', 200_000]], threshold: 820_000 },
  limits: { five_hour: { s: [[T0, 40], [T0 + 30 * MIN, 45]], resetsAt: new Date(T0 + 4 * HOUR).toISOString(), d: 5 } },
}

describe('random event streams keep the ledger sound', () => {
  for (const seed of [1, 7, 42, 2026, 99_999, 314_159]) {
    test(`seed ${seed}`, () => {
      const rand = seeded(seed)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
      const pool = Array.from({ length: 70 }, (_, n) => `agent-${n}`)
      let ledger = emptyLedger(1)
      let now = T0
      for (let step = 0; step < 250; step += 1) {
        now += Math.floor(rand() * 90_000)
        const roll = rand()
        const usage = {
          input_tokens: Math.floor(rand() * 5000),
          output_tokens: Math.floor(rand() * 3000),
          cache_read_input_tokens: Math.floor(rand() * 200_000),
          cache_creation_input_tokens: Math.floor(rand() * 50_000),
          model: pick(MODELS),
        }
        if (roll < 0.3) {
          ledger = recordTurn(ledger, { usage, now })
        } else if (roll < 0.7) {
          const id = pick(pool)
          const sight: Sighting | undefined =
            rand() < 0.8
              ? {
                  id,
                  type: pick(TYPES),
                  label: rand() < 0.2 ? 'x'.repeat(300) : 'Look at things',
                  status: pick(STATUSES),
                  ...(rand() < 0.7 ? { parent: pick(pool) } : {}),
                }
              : undefined
          ledger = recordTurn(ledger, { agentId: id, usage, now, ...(sight === undefined ? {} : { sight }) })
        } else if (roll < 0.85) {
          const listed = Array.from({ length: Math.floor(rand() * 8) }, () => {
            const id = pick(pool)

            return { id, type: pick(TYPES), label: 'listed', status: pick(STATUSES), ...(rand() < 0.5 ? { parent: pick(pool) } : {}) }
          })
          ledger = syncAgents(ledger, listed, now)
        } else if (roll < 0.92) {
          ledger = noteMissing(ledger, pick(['aborted', 'error', 'refusal']))
        } else {
          ledger = settle(ledger, 1 + Math.floor(rand() * 3), rand() < 0.8 ? rand() * 50 : undefined, rand() < 0.5)
        }
        audit(ledger, `seed ${seed} step ${step}`)
        if (step % 25 === 0) {
          const view = { ledger, live: LIVE, ui: EMPTY_UI, now }
          expectSanePane(view, `seed ${seed} step ${step}`)
          expect(BAD_TEXT.test(summaryText(view))).toBe(false)
          expect(checkLedger(ledger, 99).state).toMatch(/^(none|settling|ok|warn|bad)$/)
        }
      }
      expect(ledger.diag.withUsage > 100).toBe(true)
    })
  }

  test('a long run of the same agents stays small', () => {
    let ledger = emptyLedger(1)
    for (let turn = 0; turn < 600; turn += 1) {
      ledger = recordTurn(ledger, { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, model: 'claude-opus-5-5' }, now: T0 + turn })
      const id = `a${turn % 30}`
      ledger = recordTurn(ledger, {
        agentId: id,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, model: 'claude-haiku-4-5' },
        now: T0 + turn,
        sight: { id, type: 'Explore', label: 'Look', status: turn % 7 === 0 ? 'running' : 'completed' },
      })
    }
    audit(ledger, 'long run')
    expect(ledger.main.n).toBe(600)
    expect(Object.keys(ledger.agents)).toHaveLength(30)
    expect(JSON.stringify(ledger).length < 20_000).toBe(true)
  })
})

describe('hostile measures never produce a broken line or a broken toast', () => {
  const cases: { name: string; usage: Record<string, unknown> }[] = [
    {
      name: 'a spend limit past 100 with a date that is no date and a huge cost',
      usage: {
        context: { tokens: 5_000_000_000, window: 1_000_000, percent: 500 },
        rateLimits: [{ kind: 'spend_limit', percentUsed: 123.4, resetsAt: 'not a date' }],
        cost: { usd: 1_000_000 },
      },
    },
    { name: 'a zero window and nothing else', usage: { context: { window: 0 }, rateLimits: [] } },
    {
      name: 'an empty breakdown, a zero threshold and an unknown window kind',
      usage: {
        context: { tokens: 0, window: 0, percent: 0, breakdown: { categories: [], autoCompactThreshold: 0 } },
        rateLimits: [{ kind: 'weird_kind', percentUsed: 0 }],
        cost: { usd: 0 },
      },
    },
    {
      name: 'a window at exactly 100',
      usage: { context: { tokens: 1, window: 2, percent: 50 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + HOUR).toISOString() }] },
    },
  ]
  for (const one of cases) {
    test(one.name, () => {
      let live = applyMeasure(emptyLive(), one.usage as never, T0)
      live = applyMeasure(live, one.usage as never, T0 + 20 * MIN)
      expectPlainData(live, 'live')
      const line = statusLine(live, live.usd, T0 + 20 * MIN)
      expect(BAD_TEXT.test(line ?? '')).toBe(false)
      const out = alertsFor(live, T0 + 20 * MIN, {}, 10)
      expectPlainData(out.next, 'alert memory')
      for (const toast of out.toasts) expect(toast).toMatch(/^Usage: [A-Za-z0-9 .,:~$%\-]+$/)
      const view = { ledger: emptyLedger(1), live, ui: EMPTY_UI, now: T0 + 20 * MIN }
      expectSanePane(view, one.name)
      for (const width of [110, 60, 40]) expect(BAD_TEXT.test(bandText(view, width) ?? '')).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// Whole sessions through the real hooks
// ---------------------------------------------------------------------------

type World = {
  clock: MockClock
  usage: Record<string, unknown>
  listed: AgentInfo[]
  statuses: (string | undefined)[]
  toasts: string[]
  state: Record<string, unknown>
}

const breakdown = {
  categories: [{ name: 'Messages', tokens: 300_000, kind: 'used' }],
  autoCompactThreshold: 820_000,
}

function usageOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startedAt: 1,
    context: { tokens: 300_000, window: 1_000_000, percent: 30, breakdown },
    rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: new Date(T0 + 4 * HOUR).toISOString() }],
    cost: { usd: 0 },
    ...over,
  }
}

function engine(on: On): World {
  const world: World = { clock: mock.clock(on, { now: T0 }), usage: usageOf(), listed: [], statuses: [], toasts: [], state: {} }
  on('agent.list', () => ({ value: world.listed }))
  on('session.usage', (_$, e) => {
    const full = world.usage as { context: Record<string, unknown> }
    if (e.breakdown !== undefined) return { value: full as unknown as SessionUsage }
    const { breakdown: cut, ...context } = full.context
    void cut

    return { value: { ...full, context } as unknown as SessionUsage }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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

const complete = ($: Engine, fields: Record<string, unknown>) =>
  $.turn.complete({ answer: 'ANSWER', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...fields } as never)
const start = ($: Engine) => $.session.start({ cwd: '/w' } as never)
const measure = ($: Engine) => $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context', 'cost'] } as never)
const clearSession = ($: Engine) => $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)
const agent = (id: string, status = 'completed'): AgentInfo => ({ id, description: 'Task', type: 'Explore', status } as AgentInfo)

const ledgerOf = (world: World): Ledger => (world.state['ledger'] as Ledger | undefined) ?? emptyLedger()
const liveOf = (world: World): Live => (world.state['live'] as Live | undefined) ?? emptyLive()

describe('sessions through the hooks', () => {
  test('agents that finish together lose no tokens', async ($, on) => {
    const world = engine(on)
    world.listed = Array.from({ length: 12 }, (_, n) => agent(`a${n}`))
    await start($)
    const jobs: Promise<unknown>[] = []
    for (let n = 0; n < 12; n += 1) jobs.push(complete($, { agentId: `a${n}`, usage: use(0, 100 + n, 0, 0) }))
    for (let n = 0; n < 3; n += 1) jobs.push(complete($, { usage: use(0, 1000, 0, 0) }))
    await Promise.all(jobs)
    const ledger = ledgerOf(world)
    expect(ledger.main.n).toBe(3)
    expect(ledger.main.o).toBe(3000)
    expect(Object.values(ledger.agents).reduce((sum, row) => sum + row.t.n, 0)).toBe(12)
    expect(Object.values(ledger.agents).reduce((sum, row) => sum + row.t.o, 0)).toBe(12 * 100 + 66)
    expect(totalTally(ledger).o).toBe(3000 + 12 * 100 + 66)
    audit(ledger, 'concurrent')
  })

  test('a measure before the turn and a measure after it count the same', async ($, on) => {
    const before = engine(on)
    await start($)
    await measure($)
    await complete($, { usage: use(1000, 500, 10_000, 2000) })
    await measure($)
    const first = ledgerOf(before)
    expect(first.main.n).toBe(1)
    expect(first.main.usd > 0).toBe(true)
  })

  test('many reloads between turns change nothing', async ($, on) => {
    const world = engine(on)
    world.usage = usageOf({ cost: { usd: 3 } })
    await start($)
    await complete($, { usage: use(1000, 500, 10_000, 2000) })
    const settled = JSON.stringify(ledgerOf(world))
    for (let n = 0; n < 5; n += 1) await start($)
    expect(JSON.stringify(ledgerOf(world))).toBe(settled)
    await complete($, { usage: use(1, 1, 0, 0) })
    expect(ledgerOf(world).main.n).toBe(2)
  })

  test('a /clear then new work: the cost the engine keeps is a base, not a drift', async ($, on) => {
    const world = engine(on)
    await start($)
    world.usage = usageOf({ cost: { usd: 1 } })
    await complete($, { usage: use(0, 50_000, 0, 0) })
    await measure($)
    expect(checkLedger(ledgerOf(world), 1).state).toBe('ok')
    await clearSession($)
    expect(ledgerOf(world).main.n).toBe(0)
    world.usage = usageOf({ startedAt: 2, cost: { usd: 1.5 } })
    await complete($, { usage: use(0, 25_000, 0, 0) })
    await measure($)
    const after = ledgerOf(world)
    expect(after.key).toBe(2)
    expect(after.base).toBe(1)
    expect(checkLedger(after, 1.5).state).toBe('ok')
  })

  test('a /clear when the engine total restarts at zero', async ($, on) => {
    const world = engine(on)
    await start($)
    world.usage = usageOf({ cost: { usd: 4 } })
    await complete($, { usage: use(0, 50_000, 0, 0) })
    await measure($)
    await clearSession($)
    world.usage = usageOf({ startedAt: 2, cost: { usd: 0.5 } })
    await complete($, { usage: use(0, 25_000, 0, 0) })
    await measure($)
    expect(ledgerOf(world).base).toBe(0)
    expect(checkLedger(ledgerOf(world), 0.5).state).toBe('ok')
  })

  test('a resumed session starts from the cost it already has', async ($, on) => {
    const world = engine(on)
    world.usage = usageOf({ cost: { usd: 7.5 } })
    await start($)
    expect(ledgerOf(world).base).toBe(7.5)
    await complete($, { usage: use(0, 50_000, 0, 0) })
    world.usage = usageOf({ cost: { usd: 8.5 } })
    await measure($)
    const check = checkLedger(ledgerOf(world), 8.5)
    expect(check.state).toBe('ok')
    expect(check.spent).toBe(1)
  })

  test('a window that fills fast warns once, shows its time, and is quiet after it resets', async ($, on) => {
    const world = engine(on)
    const resets = new Date(T0 + 6 * HOUR).toISOString()
    const reading = (pct: number): Record<string, unknown> => usageOf({ rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: resets }] })
    world.usage = reading(50)
    await start($)
    await world.clock.set(T0 + 30 * MIN)
    world.usage = reading(55)
    await measure($)
    await world.clock.set(T0 + 60 * MIN)
    world.usage = reading(60)
    await measure($)
    // The warning comes with the first pair of readings that projects a fill before the reset: 55%.
    const fill = world.toasts.filter(text => text.includes('At this pace'))
    expect(fill).toHaveLength(1)
    expect(fill[0]).toMatch(/^Usage: 5h window 55%\. At this pace it fills ~\d\d:\d\d, before reset \d\d:\d\d\.$/)
    expect(world.statuses[world.statuses.length - 1]).toMatch(/5h 60% ▲ full ~\d\d:\d\d/)
    await world.clock.set(T0 + 61 * MIN)
    world.usage = reading(60.5)
    await measure($)
    expect(world.toasts.filter(text => text.includes('At this pace'))).toHaveLength(1)
    // Six hours on: the window reset and the reading is low again.
    await world.clock.set(T0 + 7 * HOUR)
    world.usage = usageOf({ rateLimits: [{ kind: 'five_hour', percentUsed: 3, resetsAt: new Date(T0 + 12 * HOUR).toISOString() }] })
    await measure($)
    expect(liveOf(world).limits['five_hour']?.s).toEqual([[T0 + 7 * HOUR, 3]])
    expect(world.statuses[world.statuses.length - 1]).toMatch(/5h 3%( · |$)/)
  })

  test('the footer covers an unpriced model, an aborted turn and agents that ran in the turn', async ($, on) => {
    const world = engine(on)
    world.listed = [agent('a1')]
    await start($)
    const unpriced = await complete($, { usage: use(10, 20, 0, 0, 'claude-never-heard-9') })
    expect(unpriced.text).toBe('↳ turn not priced · $0.00 session (est.) · 20 out · 0% cached')
    const aborted = await complete($, { usage: undefined, reason: 'aborted' })
    expect(aborted.text).toBe('ANSWER')
    await complete($, { agentId: 'a1', usage: use(0, 100_000, 0, 0) })
    const withAgents = await complete($, { usage: use(0, 1000, 0, 0) })
    // 100,000 output tokens on Opus 5.5 at $20 per million is $2.00; the main turn is $0.02.
    expect(withAgents.text).toBe('↳ $0.02 turn + $2.00 agents · $2.02 session (est.) · 1.0k out')
    const next = await measure($)
    void next
    const after = await complete($, { usage: use(0, 1000, 0, 0) })
    expect(after.text).not.toContain('agents')
  })

  test('a very long agent description is clipped and never reaches a toast or a status', async ($, on) => {
    const world = engine(on)
    world.listed = [{ id: 'a1', description: `${'secret-task '.repeat(60)}`, type: 'Explore', status: 'completed' } as AgentInfo]
    await start($)
    await complete($, { agentId: 'a1', usage: use(0, 10, 0, 0) })
    const label = ledgerOf(world).agents['a1']?.label ?? ''
    expect(label.length <= 48).toBe(true)
    expect(label.endsWith('…')).toBe(true)
    expect(world.toasts.join('\n')).not.toContain('secret-task')
    expect(world.statuses.join('\n')).not.toContain('secret-task')
  })

  test('the band keeps its bars while they fit and drops them one column short', async ($, on) => {
    engine(on)
    await start($)
    for (const surface of SURFACES) {
      const base = { hasSurvey: false, isWorking: false, maxRows: 6, scroll: { offset: 0, bodyRows: 5 }, view: {} }
      // ◆ Usage, ctx with a 6-cell bar, 5h with a bar, the cost and the button, 3 cells apart: 67 cells.
      const fits = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'AbovePrompt', props: { ...base, bodyColumns: 67 } })
      expect(drawText(await fits.drawn(), 67)[1]).toMatch(/^◆ Usage {3}ctx █.* 30% {3}5h █.* 20% {3}\$0\.00 est\. {3}\[ Details \]$/)
      await fits.unmount()
      const short = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'AbovePrompt', props: { ...base, bodyColumns: 66 } })
      expect(drawText(await short.drawn(), 66)[1]).toBe('◆ Usage   ctx 30%   5h 20%   $0.00 est.   [ Details ]')
      await short.unmount()
    }
  })

  test('every pane view draws on both surfaces from a busy, odd state', async ($, on) => {
    const world = engine(on)
    world.listed = [agent('a1', 'running'), { ...agent('a2'), parentId: 'a1' }, { ...agent('a3', 'failed'), parentId: 'a3' }]
    world.usage = usageOf({
      context: { tokens: 990_000, window: 1_000_000, percent: 99, breakdown },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(T0 + 3 * 24 * HOUR).toISOString() },
        { kind: 'spend_limit', percentUsed: 130 },
      ],
      cost: { usd: 250 },
    })
    await start($)
    await complete($, { usage: use(10, 10, 0, 0, 'claude-unknown-9') })
    await complete($, { agentId: 'a1', usage: use(100, 100, 0, 90_000) })
    await complete($, { agentId: 'a2', usage: use(1, 1, 1, 1, 'claude-haiku-4-5') })
    await complete($, { agentId: 'a3', usage: use(1, 1, 1, 1) })
    await complete($, { agentId: 'ghost', usage: use(1, 1, 1, 1) })
    await measure($)
    for (const surface of SURFACES) {
      for (const view of ['tab-models', 'tab-agents', 'tab-diag', 'tab-overview']) {
        const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'Pane', requestId: 'meter', props: PANE })
        await ui.press({ key: view })
        await ui.redraw()
        const lines = drawText(await ui.drawn(), 100)
        expect(lines.length > 8).toBe(true)
        expectSaneText(lines, 100, `${surface} ${view}`)
        await ui.unmount()
      }
    }
    expect(world.toasts.length > 0).toBe(true)
    for (const toast of world.toasts) expect(toast).toMatch(/^Usage: [A-Za-z0-9 .,:~$%\-]+$/)
  })
})

describe('the empty and the tiny', () => {
  test('nothing counted gives no status line and no band, and a ledger of zeros adds up', () => {
    expect(statusLine(emptyLive(), undefined, T0)).toBeUndefined()
    expect(bandText({ ledger: emptyLedger(), live: emptyLive(), ui: EMPTY_UI, now: T0 }, 110)).toBeUndefined()
    expect(attributed(emptyLedger())).toBe(0)
    expect(totalTally(emptyLedger())).toEqual(ZERO)
    expect(checkLedger(emptyLedger(1), 0).state).toBe('none')
    expect(buildTree(emptyLedger()).kids).toEqual([])
  })
})
