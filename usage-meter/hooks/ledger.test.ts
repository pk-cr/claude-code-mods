import { describe, expect, test } from 'claude-code/testing'

import type { Ledger, Limit, Live } from '../types'
import { barParts, fmtClock, fmtTokens, fmtUsd, shortModel, wrapWords } from './format'
import {
  MAX_AGENTS,
  ZERO,
  addSample,
  alertsFor,
  anyBusy,
  applyMeasure,
  attributed,
  buildTree,
  cacheNet,
  checkLedger,
  compactAtPct,
  costOf,
  ctxLevel,
  emptyLedger,
  emptyLive,
  footerLine,
  noteMissing,
  parseMeterArgs,
  prune,
  project,
  recordTurn,
  settle,
  statusLine,
  syncAgents,
  totalTally,
  turnUsd,
  turnsLeft,
  windowChip,
  windowState,
} from './ledger'
import type { Sighting } from './ledger'
import { modelKey, priceFor } from './prices'

const MIN = 60_000
const HOUR = 3_600_000
const T0 = Date.parse('2026-10-07T12:00:00Z')

const near = (a: number, b: number): void => expect(Math.abs(a - b) < 1e-9, `${a} is not near ${b}`).toBe(true)

const use = (i: number, o: number, r: number, w: number, model = 'claude-opus-5-5') => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
  model,
})

const sight = (id: string, fields: Partial<Sighting> = {}): Sighting => ({
  id,
  type: 'Explore',
  label: 'Survey the repo',
  status: 'running',
  ...fields,
})

describe('prices', () => {
  test('a model is found by its id, with or without a date or a window suffix', () => {
    expect(priceFor('claude-opus-5-5')?.id).toBe('claude-opus-5-5')
    expect(priceFor('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5')
    expect(priceFor('claude-opus-5[1m]')?.id).toBe('claude-opus-5')
    expect(modelKey('Claude-Sonnet-5-5-20260101[1m]')).toBe('claude-sonnet-5-5')
  })

  test('an id the table does not know is never guessed from a near one', () => {
    expect(priceFor('claude-opus-5-6')).toBeUndefined()
    expect(priceFor('claude-opus-5-5-fast')).toBeUndefined()
    expect(priceFor('gpt-x')).toBeUndefined()
    expect(turnUsd(use(1, 1, 1, 1, 'claude-opus-9'))).toBeUndefined()
  })

  test('cache reads keep their own price per model', () => {
    expect(priceFor('claude-fable-5-1')?.r).toBe(0.25)
    expect(priceFor('claude-fable-5')?.r).toBe(1)
    expect(priceFor('claude-opus-5-5')?.r).toBe(0.2)
    expect(priceFor('claude-opus-5')?.r).toBe(0.5)
    expect(priceFor('claude-haiku-4-5')?.r).toBe(0.1)
  })

  test('the Sonnet 5.5 cache-read conflict and the Haiku 5.5 tier are flagged in the table', () => {
    expect(priceFor('claude-sonnet-5-5')?.note).toContain('$0.10')
    expect(priceFor('claude-haiku-5-5')?.note).toContain('100k')
  })

  test('one turn costs its four counts at their prices', () => {
    const price = priceFor('claude-opus-5-5')
    if (price === undefined) throw new Error('no price')
    // 1000 x $4 + 500 x $20 + 10000 x $0.20 + 2000 x $5 = $26,000 per million
    near(costOf(price, use(1000, 500, 10_000, 2000)), 0.026)
    near(turnUsd(use(1000, 500, 10_000, 2000)) ?? -1, 0.026)
  })
})

describe('format', () => {
  test('tokens and dollars read short', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(4200)).toBe('4.2k')
    expect(fmtTokens(41_000)).toBe('41k')
    expect(fmtTokens(3_900_000)).toBe('3.9M')
    expect(fmtUsd(0)).toBe('$0.00')
    expect(fmtUsd(0.004)).toBe('<$0.01')
    expect(fmtUsd(3.4249)).toBe('$3.42')
    expect(fmtUsd(120.4)).toBe('$120')
  })

  test('a bar fills in eighths of a cell and holds inside its track', () => {
    const drawn = (pct: number, width: number): string => {
      const { fill, track } = barParts(pct, width)

      return fill + track
    }
    expect(drawn(0, 10)).toBe('░░░░░░░░░░')
    expect(drawn(100, 10)).toBe('██████████')
    expect(drawn(45, 10)).toBe('████▌░░░░░')
    expect(drawn(41, 20)).toBe('████████▎░░░░░░░░░░░')
    expect(drawn(250, 10)).toBe('██████████')
    expect(drawn(-4, 10)).toBe('░░░░░░░░░░')
    expect(drawn(Number.NaN, 4)).toBe('░░░░')
    expect(barParts(0.1, 10)).toEqual({ fill: '▏', track: '░░░░░░░░░' })
    for (const width of [1, 6, 13, 40]) {
      for (const pct of [0, 0.4, 12.5, 33, 50, 99.9, 100]) expect(drawn(pct, width), `${pct}% in ${width}`).toHaveLength(width)
    }
  })

  test('text wraps at word ends and a long word is cut', () => {
    expect(wrapWords('one two three four', 9)).toEqual(['one two', 'three', 'four'])
    expect(wrapWords('  spaced   out  ', 20)).toEqual(['spaced out'])
    expect(wrapWords('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapWords('', 10)).toEqual([])
    for (const part of wrapWords('the quick brown fox jumps over the lazy dog', 7)) expect(part.length <= 7).toBe(true)
  })

  test('model ids shorten and the clock reads hours and minutes', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus-5.5')
    expect(shortModel('claude-haiku-4-5')).toBe('haiku-4.5')
    expect(shortModel('claude-fable-5')).toBe('fable-5')
    expect(shortModel('mystery')).toBe('mystery')
    expect(fmtClock(T0)).toMatch(/^\d\d:\d\d$/)
  })
})

describe('recording turns', () => {
  test('the main loop adds to main and to its model', () => {
    const ledger = recordTurn(emptyLedger(), { usage: use(1000, 500, 10_000, 2000), now: T0 })
    expect(ledger.main.n).toBe(1)
    expect(ledger.main.i).toBe(1000)
    near(ledger.main.usd, 0.026)
    near(ledger.models['claude-opus-5-5']?.usd ?? -1, 0.026)
    expect(ledger.diag.withUsage).toBe(1)
    expect(ledger.diag.models).toEqual(['claude-opus-5-5'])
    near(attributed(ledger), 0.026)
  })

  test('a listed agent gets a row with its parent, label and model, and a resumed run adds to it', () => {
    let ledger = recordTurn(emptyLedger(), {
      agentId: 'a1',
      usage: use(100, 50, 0, 1000, 'claude-haiku-4-5-20251001'),
      now: T0,
      sight: sight('a1', { parent: 'a0', name: 'scout' }),
    })
    const row = ledger.agents['a1']
    expect(row?.type).toBe('Explore')
    expect(row?.parent).toBe('a0')
    expect(row?.model).toBe('claude-haiku-4-5')
    expect(row?.t.n).toBe(1)
    expect(row?.runs).toBe(1)
    expect(row?.firstHit).toBe(0)
    expect(ledger.win.agents > 0).toBe(true)
    ledger = recordTurn(ledger, { agentId: 'a1', usage: use(10, 5, 1000, 0, 'claude-haiku-4-5'), now: T0 + MIN })
    expect(ledger.agents['a1']?.t.n).toBe(2)
    expect(ledger.agents['a1']?.runs).toBe(2)
    expect(ledger.agents['a1']?.firstHit).toBe(0)
    expect(ledger.agents['a1']?.last).toBe(T0 + MIN)
    expect(Object.keys(ledger.models)).toEqual(['claude-haiku-4-5'])
  })

  test('a loop no list names goes to the system bucket and its id is remembered', () => {
    const ledger = recordTurn(emptyLedger(), { agentId: 'ghost-1', usage: use(10, 10, 0, 0), now: T0 })
    expect(ledger.system.n).toBe(1)
    expect(ledger.agents).toEqual({})
    expect(ledger.diag.sysIds).toEqual(['ghost-1'])
    expect(ledger.win.agents > 0).toBe(true)
  })

  test('a model with no price keeps its tokens, adds no dollars and counts as unpriced', () => {
    const ledger = recordTurn(emptyLedger(), { usage: use(1000, 1000, 0, 0, 'claude-new-9'), now: T0 })
    expect(ledger.main.o).toBe(1000)
    expect(ledger.main.usd).toBe(0)
    expect(ledger.main.np).toBe(1)
    expect(ledger.models['claude-new-9']?.np).toBe(1)
  })

  test('every bucket adds up to the model totals', () => {
    let ledger = emptyLedger()
    ledger = recordTurn(ledger, { usage: use(1000, 500, 10_000, 2000), now: T0 })
    ledger = recordTurn(ledger, { agentId: 'a1', usage: use(200, 100, 5000, 0, 'claude-sonnet-5-5'), now: T0, sight: sight('a1') })
    ledger = recordTurn(ledger, { agentId: 'ghost', usage: use(50, 20, 0, 400, 'claude-haiku-4-5'), now: T0 })
    const total = totalTally(ledger)
    near(total.usd, attributed(ledger))
    expect(total.i).toBe(1250)
    expect(total.o).toBe(620)
    expect(total.r).toBe(15_000)
    expect(total.w).toBe(2400)
    expect(total.n).toBe(3)
  })

  test('a turn without usage is counted by its reason and adds no tokens', () => {
    let ledger = noteMissing(emptyLedger(), 'aborted')
    ledger = noteMissing(ledger, 'aborted')
    ledger = noteMissing(ledger, 'error')
    expect(ledger.diag.noUsage).toBe(3)
    expect(ledger.diag.reasons).toEqual({ aborted: 2, error: 1 })
    expect(totalTally(ledger)).toEqual(ZERO)
  })

  test('the lists in the diagnostics stay short', () => {
    let ledger = emptyLedger()
    for (let n = 0; n < 20; n += 1) {
      ledger = recordTurn(ledger, { agentId: `ghost-${n}`, usage: use(1, 1, 0, 0, `claude-x-${n}`), now: T0 })
    }
    expect(ledger.diag.models).toHaveLength(12)
    expect(ledger.diag.sysIds).toHaveLength(10)
    expect(ledger.diag.sysIds[9]).toBe('ghost-19')
  })

  test('the cache saves money when reads outweigh the write premium', () => {
    const ledger = recordTurn(emptyLedger(), { usage: use(0, 0, 1_000_000, 100_000), now: T0 })
    // reads save (4 - 0.2) x 1 = 3.8; the write costs (5 - 4) x 0.1 = 0.1 extra
    near(cacheNet(ledger), 3.7)
  })
})

describe('the agent list', () => {
  test('rows follow the list, and nothing changes when the list repeats', () => {
    const first = syncAgents(emptyLedger(), [sight('a1'), sight('a2', { parent: 'a1' })], T0)
    expect(Object.keys(first.agents)).toEqual(['a1', 'a2'])
    expect(first.agents['a2']?.parent).toBe('a1')
    expect(syncAgents(first, [sight('a1'), sight('a2', { parent: 'a1' })], T0 + 1)).toBe(first)
    expect(syncAgents(first, [], T0 + 1)).toBe(first)
    const done = syncAgents(first, [sight('a1', { status: 'completed' })], T0 + 2)
    expect(done.agents['a1']?.status).toBe('completed')
    expect(anyBusy(first)).toBe(true)
    expect(anyBusy(done)).toBe(true)
    expect(anyBusy(syncAgents(done, [sight('a2', { parent: 'a1', status: 'completed' })], T0 + 3))).toBe(false)
  })

  test('the oldest finished agents fold into one tally when there are too many', () => {
    let ledger = emptyLedger()
    for (let n = 0; n < MAX_AGENTS + 5; n += 1) {
      ledger = recordTurn(ledger, {
        agentId: `a${n}`,
        usage: use(10, 10, 0, 0),
        now: T0 + n,
        sight: sight(`a${n}`, { status: 'completed' }),
      })
    }
    expect(Object.keys(ledger.agents)).toHaveLength(MAX_AGENTS)
    expect(ledger.foldedN).toBe(5)
    expect(ledger.folded.n).toBe(5)
    expect(ledger.agents['a0']).toBeUndefined()
    expect(ledger.agents['a44']).toBeDefined()
    near(attributed(ledger), totalTally(ledger).usd)
    expect(prune(ledger)).toBe(ledger)
  })

  test('a running agent is never folded away', () => {
    let ledger = emptyLedger()
    for (let n = 0; n < MAX_AGENTS + 3; n += 1) {
      ledger = recordTurn(ledger, { agentId: `a${n}`, usage: use(1, 1, 0, 0), now: T0 + n, sight: sight(`a${n}`) })
    }
    expect(Object.keys(ledger.agents)).toHaveLength(MAX_AGENTS + 3)
    expect(ledger.foldedN).toBe(0)
  })
})

describe('the tree', () => {
  test('subtotals roll up through parents, children sort by cost, and main holds its own', () => {
    let ledger = emptyLedger()
    ledger = recordTurn(ledger, { usage: use(0, 1_000_000, 0, 0, 'claude-opus-5-5'), now: T0 }) // $20
    ledger = recordTurn(ledger, { agentId: 'p', usage: use(0, 100_000, 0, 0, 'claude-opus-5-5'), now: T0, sight: sight('p', { type: 'general-purpose' }) }) // $2
    ledger = recordTurn(ledger, { agentId: 'c', usage: use(0, 50_000, 0, 0, 'claude-opus-5-5'), now: T0, sight: sight('c', { parent: 'p' }) }) // $1
    ledger = recordTurn(ledger, { agentId: 'q', usage: use(0, 10_000, 0, 0, 'claude-opus-5-5'), now: T0, sight: sight('q') }) // $0.20
    const tree = buildTree(ledger)
    near(tree.own.usd, 20)
    near(tree.sub.usd, 23.2)
    expect(tree.kids.map(kid => kid.id)).toEqual(['p', 'q'])
    const parent = tree.kids[0]
    near(parent?.own.usd ?? -1, 2)
    near(parent?.sub.usd ?? -1, 3)
    expect(parent?.kids.map(kid => kid.id)).toEqual(['c'])
  })

  test('an agent whose parent is unknown hangs under main, and a cycle loses no agent', () => {
    let ledger = syncAgents(emptyLedger(), [sight('x', { parent: 'missing' }), sight('y', { parent: 'z' }), sight('z', { parent: 'y' })], T0)
    expect(buildTree(ledger).kids.map(kid => kid.id)).toContain('x')
    ledger = recordTurn(ledger, { agentId: 'y', usage: use(0, 1000, 0, 0), now: T0 })
    const ids: string[] = []
    const visit = (node: ReturnType<typeof buildTree>): void => {
      ids.push(node.id)
      node.kids.forEach(visit)
    }
    visit(buildTree(ledger))
    expect(ids.sort()).toEqual(['main', 'x', 'y', 'z'])
  })
})

describe('the check against the engine total', () => {
  // One main turn of 50,000 output tokens on Opus 5.5: $1.00 attributed, base 0.
  const oneDollar: Ledger = { ...recordTurn(emptyLedger(), { usage: use(0, 50_000, 0, 0), now: T0 }), base: 0 }

  test('small drift is fine, larger drift warns, a gap is bad', () => {
    expect(checkLedger(oneDollar, 1.02).state).toBe('ok')
    expect(checkLedger(oneDollar, 1.1).state).toBe('warn')
    expect(checkLedger(oneDollar, 1.6).state).toBe('bad')
    const gap = checkLedger(oneDollar, 1.6)
    near(gap.drift, 0.6)
    near(gap.share, 0.625)
  })

  test('there is no check without an engine total or a base', () => {
    expect(checkLedger(oneDollar, undefined).state).toBe('none')
    expect(checkLedger({ ...oneDollar, base: null }, 1).state).toBe('none')
  })

  test('the cost from before the ledger began is left out', () => {
    const check = checkLedger({ ...oneDollar, base: 5 }, 6.01)
    near(check.spent, 1.01)
    expect(check.state).toBe('ok')
  })

  test('it waits while an agent still runs', () => {
    const busy = syncAgents(oneDollar, [sight('a1')], T0)
    expect(checkLedger(busy, 1).state).toBe('settling')
  })

  test('settle sets the key and a base, and clears the footer window at a turn end', () => {
    let ledger = recordTurn(emptyLedger(), { agentId: 'g', usage: use(0, 50_000, 0, 0), now: T0 })
    expect(ledger.win.agents > 0).toBe(true)
    ledger = settle(ledger, 77, 4, false)
    expect(ledger.key).toBe(77)
    near(ledger.base ?? -1, 3)
    expect(ledger.win.agents > 0).toBe(true)
    ledger = settle(ledger, 99, 9, true)
    expect(ledger.key).toBe(77)
    near(ledger.base ?? -1, 3)
    expect(ledger.win.agents).toBe(0)
    expect(settle(ledger, 77, 4, true)).toBe(ledger)
  })
})

describe('window readings and the projection', () => {
  const at = (ms: number, pct: number): [number, number] => [T0 + ms, pct]

  test('a repeat reading is kept every five minutes only, and a fall means a reset', () => {
    let samples = addSample([], T0, 50)
    expect(addSample(samples, T0 + MIN, 50)).toEqual(samples)
    expect(addSample(samples, T0 + 6 * MIN, 50)).toHaveLength(2)
    samples = addSample(samples, T0 + 10 * MIN, 53)
    expect(addSample(samples, T0 + 11 * MIN, 12)).toEqual([[T0 + 11 * MIN, 12]])
    expect(addSample(samples, T0 + 11 * MIN, 52.5)).toHaveLength(3)
  })

  test('the readings stay at 24', () => {
    let samples: [number, number][] = []
    for (let n = 0; n < 40; n += 1) samples = addSample(samples, T0 + n * 6 * MIN, 10 + n)
    expect(samples).toHaveLength(24)
    expect(samples[23]?.[1]).toBe(49)
  })

  test('it learns the pace first, then projects a full window before the reset', () => {
    expect(project([], T0, undefined).verdict).toBe('learning')
    expect(project([at(0, 50)], T0, undefined).verdict).toBe('learning')
    expect(project([at(0, 50), at(5 * MIN, 51)], T0 + 5 * MIN, undefined).verdict).toBe('learning')
    const samples = [at(0, 50), at(30 * MIN, 55), at(60 * MIN, 60)]
    const now = T0 + 60 * MIN
    const full = project(samples, now, T0 + 6 * HOUR)
    expect(full.verdict).toBe('full')
    near(full.perHour ?? -1, 10)
    near(full.fullAt ?? -1, T0 + 5 * HOUR)
    const ok = project(samples, now, T0 + 4 * HOUR)
    expect(ok.verdict).toBe('ok')
    near(ok.atReset ?? -1, 90)
  })

  test('a window with no growth is idle, and an old or past-reset reading is stale', () => {
    const flat = [at(0, 30), at(40 * MIN, 30)]
    expect(project(flat, T0 + 40 * MIN, T0 + 3 * HOUR).verdict).toBe('idle')
    expect(project(flat, T0 + 40 * MIN + 45 * MIN, T0 + 3 * HOUR).verdict).toBe('stale')
    expect(project([at(0, 50), at(30 * MIN, 60)], T0 + 31 * MIN, T0 + 20 * MIN).verdict).toBe('stale')
  })

  test('a window already at 100% is full now', () => {
    const proj = project([at(0, 99), at(20 * MIN, 100)], T0 + 20 * MIN, T0 + 3 * HOUR)
    expect(proj.verdict).toBe('full')
  })

  test('a chip names the window and its percent, with a glyph and the fill time when it needs care', () => {
    const limit: Limit = { s: [at(0, 50), at(30 * MIN, 55), at(60 * MIN, 60)], resetsAt: new Date(T0 + 6 * HOUR).toISOString(), d: 5 }
    expect(windowChip('five_hour', limit, T0 + 60 * MIN)).toMatch(/^5h 60% ▲ full ~\d\d:\d\d$/)
    expect(windowChip('seven_day', { s: [at(0, 18)], d: 0 }, T0)).toBe('7d 18%')
    expect(windowChip('seven_day', { s: [at(0, 80)], d: 0 }, T0)).toBe('7d 80% ▲')
    expect(windowChip('five_hour', { s: [at(0, 93)], d: 0 }, T0)).toBe('5h 93% ✖')
  })

  test('a window state carries its level, pace words and reset time', () => {
    const resets = T0 + 6 * HOUR
    const filling = windowState({ s: [at(0, 50), at(30 * MIN, 55), at(60 * MIN, 60)], resetsAt: new Date(resets).toISOString(), d: 5 }, T0 + 60 * MIN)
    expect(filling.level).toBe('warn')
    expect(filling.isFilling).toBe(true)
    expect(filling.pace).toMatch(/^full ~\d\d:\d\d$/)
    expect(filling.resets).toBe(resets)
    expect(filling.fullAt).toBeDefined()
    const easy = windowState({ s: [at(0, 50), at(30 * MIN, 55), at(60 * MIN, 60)], resetsAt: new Date(T0 + 2 * HOUR).toISOString(), d: 5 }, T0 + 60 * MIN)
    expect(easy).toMatchObject({ level: 'ok', isFilling: false, pace: '≈70% at reset' })
    expect(easy.fullAt).toBeUndefined()
    expect(windowState({ s: [at(0, 30)], d: 0 }, T0).pace).toBe('learning pace')
    expect(windowState({ s: [at(0, 30), at(40 * MIN, 30)], d: 0 }, T0 + 40 * MIN).pace).toBe('no growth')
    expect(windowState({ s: [at(0, 30)], d: 0 }, T0 + 2 * HOUR).pace).toBe('reading is old')
    expect(windowState({ s: [at(0, 100)], d: 0 }, T0)).toMatchObject({ level: 'bad', pace: 'full now', isFilling: false })
    expect(windowState({ s: [at(0, 76)], d: 0 }, T0).level).toBe('warn')
    expect(windowState({ s: [at(0, 74.9)], d: 0 }, T0).level).toBe('ok')
  })

  test('the context level follows the alert levels', () => {
    expect(ctxLevel(79.9)).toBe('ok')
    expect(ctxLevel(80)).toBe('warn')
    expect(ctxLevel(90)).toBe('bad')
  })
})

describe('a measure', () => {
  const usage = (over: Record<string, unknown> = {}) => ({
    startedAt: 1,
    context: { tokens: 200_000, window: 1_000_000, percent: 20 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(T0 + 3 * HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 18 },
    ],
    cost: { usd: 3.42 },
    ...over,
  })

  test('it takes the context, the windows, the cost and the account kind', () => {
    const live = applyMeasure(emptyLive(), usage(), T0)
    expect(live.ctx.percent).toBe(20)
    expect(live.ctx.window).toBe(1_000_000)
    expect(live.usd).toBe(3.42)
    expect(live.account).toBe('subscription')
    expect(live.measures).toBe(1)
    expect(Object.keys(live.limits)).toEqual(['five_hour', 'seven_day'])
    expect(live.limits['five_hour']?.s).toEqual([[T0, 62]])
    expect(applyMeasure(emptyLive(), usage({ rateLimits: [{ kind: 'spend_limit', percentUsed: 10 }] }), T0).account).toBe('gateway')
    expect(applyMeasure(emptyLive(), usage({ rateLimits: [] }), T0).account).toBe('unknown')
  })

  test('the change since the last reading is kept in points', () => {
    let live = applyMeasure(emptyLive(), usage(), T0)
    live = applyMeasure(live, usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 63.4 }] }), T0 + 10 * MIN)
    expect(live.limits['five_hour']?.d).toBe(1.4)
    expect(live.limits['seven_day']).toBeUndefined()
    const same = applyMeasure(live, usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 63.4 }] }), T0 + 11 * MIN)
    expect(same.limits['five_hour']?.d).toBe(1.4)
  })

  test('the growth per turn averages, and a compaction does not reset it', () => {
    let live = applyMeasure(emptyLive(), usage(), T0)
    live = applyMeasure(live, usage({ context: { tokens: 220_000, window: 1_000_000, percent: 22 } }), T0 + MIN)
    expect(live.ctx.growth).toBe(20_000)
    live = applyMeasure(live, usage({ context: { tokens: 260_000, window: 1_000_000, percent: 26 } }), T0 + 2 * MIN)
    expect(live.ctx.growth).toBe(26_000)
    live = applyMeasure(live, usage({ context: { tokens: 90_000, window: 1_000_000, percent: 9 } }), T0 + 3 * MIN)
    expect(live.ctx.growth).toBe(26_000)
  })

  test('the breakdown gives the used categories and the compaction point, and a later measure keeps them', () => {
    const breakdown = {
      categories: [
        { name: 'Free space', tokens: 600_000, kind: 'free' },
        { name: 'Messages', tokens: 312_000, kind: 'used' },
        { name: 'System tools', tokens: 38_000, kind: 'used' },
        { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
      ],
      autoCompactThreshold: 820_000,
    }
    let live = applyMeasure(emptyLive(), usage({ context: { tokens: 410_000, window: 1_000_000, percent: 41, breakdown } }), T0)
    expect(live.ctx.cats).toEqual([['Messages', 312_000], ['System tools', 38_000]])
    expect(live.ctx.threshold).toBe(820_000)
    expect(compactAtPct(live.ctx)).toBe(82)
    live = applyMeasure(live, usage({ context: { tokens: 430_000, window: 1_000_000, percent: 43 } }), T0 + MIN)
    expect(live.ctx.cats).toEqual([['Messages', 312_000], ['System tools', 38_000]])
    live = { ...live, ctx: { ...live.ctx, growth: 20_000 } }
    expect(turnsLeft(live.ctx)).toBe(19)
    expect(turnsLeft({ ...live.ctx, growth: 0 })).toBeUndefined()
  })
})

describe('words', () => {
  const live = (over: Partial<Live> = {}): Live => ({
    ...emptyLive(),
    ctx: { window: 1_000_000, percent: 41, tokens: 410_000, growth: 0, cats: [] },
    limits: { five_hour: { s: [[T0, 62]], d: 0 }, seven_day: { s: [[T0, 18]], d: 0 } },
    usd: 3.42,
    ...over,
  })

  test('the status entry joins the context, the windows and the cost', () => {
    expect(statusLine(live(), 3.42, T0)).toBe('ctx 41% · 5h 62% · 7d 18% · $3.42 est.')
    expect(statusLine(live({ ctx: { window: 1_000_000, percent: 84, tokens: 840_000, growth: 0, cats: [] } }), 3.42, T0)).toBe('ctx 84% ▲ · 5h 62% · 7d 18% · $3.42 est.')
    expect(statusLine(emptyLive(), undefined, T0)).toBeUndefined()
    expect(statusLine({ ...emptyLive(), ctx: { window: 1, percent: 5, growth: 0, cats: [] } }, undefined, T0)).toBe('ctx 5%')
  })

  test('the footer names the turn, the output, the cache and the session', () => {
    expect(footerLine({ turnUsd: 0.31, out: 4200, hit: 0.94, agentsUsd: 0, session: 3.42 })).toBe('↳ $0.31 turn · $3.42 session (est.) · 4.2k out · 94% cached')
    expect(footerLine({ turnUsd: 0.31, out: 4200, hit: undefined, agentsUsd: 0.114, session: 3.42 })).toBe('↳ $0.31 turn + $0.11 agents · $3.42 session (est.) · 4.2k out')
    expect(footerLine({ turnUsd: undefined, out: 10, hit: 0, agentsUsd: 0.001, session: 0 })).toBe('↳ turn not priced · $0.00 session (est.) · 10 out · 0% cached')
  })
})

describe('alerts', () => {
  const live = (ctx: number | undefined, win: number | undefined, usd?: number): Live => ({
    ...emptyLive(),
    ctx: { window: 1_000_000, growth: 0, cats: [], threshold: 820_000, ...(ctx === undefined ? {} : { percent: ctx }) },
    limits: win === undefined ? {} : { five_hour: { s: [[T0, win]], d: 0 } },
    ...(usd === undefined ? {} : { usd }),
  })

  test('the context alert fires once per level and again after it fell and rose', () => {
    let held: Record<string, number> = {}
    let out = alertsFor(live(79, undefined), T0, held, 0)
    expect(out.toasts).toEqual([])
    out = alertsFor(live(82, undefined), T0, out.next, 0)
    expect(out.toasts).toEqual(['Usage: context 82%. Auto-compaction near 82%.'])
    held = out.next
    expect(held['ctx']).toBe(80)
    out = alertsFor(live(85, undefined), T0, held, 0)
    expect(out.toasts).toEqual([])
    out = alertsFor(live(91, undefined), T0, out.next, 0)
    expect(out.toasts).toEqual(['Usage: context 91%. Auto-compaction near 82%.'])
    out = alertsFor(live(40, undefined), T0, out.next, 0)
    expect(out.next['ctx']).toBe(0)
    out = alertsFor(live(81, undefined), T0, out.next, 0)
    expect(out.toasts).toHaveLength(1)
  })

  test('a drop of less than five points does not re-arm it', () => {
    let out = alertsFor(live(91, undefined), T0, {}, 0)
    expect(out.toasts).toHaveLength(1)
    out = alertsFor(live(87, undefined), T0, out.next, 0)
    out = alertsFor(live(92, undefined), T0, out.next, 0)
    expect(out.toasts).toEqual([])
  })

  test('a window alerts at 75 and 90', () => {
    let out = alertsFor(live(undefined, 76), T0, {}, 0)
    expect(out.toasts).toEqual(['Usage: 5h window 76%.'])
    out = alertsFor(live(undefined, 77), T0, out.next, 0)
    expect(out.toasts).toEqual([])
    out = alertsFor(live(undefined, 91), T0, out.next, 0)
    expect(out.toasts).toEqual(['Usage: 5h window 91%.'])
  })

  test('a projected full window alerts once, and again after the pace eased', () => {
    const fast: Live = {
      ...emptyLive(),
      limits: {
        five_hour: {
          s: [[T0, 50], [T0 + 30 * MIN, 55], [T0 + 60 * MIN, 60]],
          resetsAt: new Date(T0 + 6 * HOUR).toISOString(),
          d: 0,
        },
      },
    }
    const now = T0 + 60 * MIN
    let out = alertsFor(fast, now, {}, 0)
    expect(out.toasts).toHaveLength(1)
    expect(out.toasts[0]).toMatch(/^Usage: 5h window 60%\. At this pace it fills ~\d\d:\d\d, before reset \d\d:\d\d\.$/)
    out = alertsFor(fast, now + MIN, out.next, 0)
    expect(out.toasts).toEqual([])
    const eased: Live = { ...fast, limits: { five_hour: { ...(fast.limits['five_hour'] as Limit), resetsAt: new Date(T0 + 2 * HOUR).toISOString() } } }
    out = alertsFor(eased, now + 2 * MIN, out.next, 0)
    expect(out.next['full:five_hour']).toBe(0)
    out = alertsFor(fast, now + 3 * MIN, out.next, 0)
    expect(out.toasts).toHaveLength(1)
  })

  test('the cost alert fires for each multiple of the step and never with a step of 0', () => {
    let out = alertsFor(live(undefined, undefined, 9.5), T0, {}, 10)
    expect(out.toasts).toEqual([])
    out = alertsFor(live(undefined, undefined, 10.2), T0, out.next, 10)
    expect(out.toasts).toEqual(['Usage: session passed est. $10.00.'])
    out = alertsFor(live(undefined, undefined, 15), T0, out.next, 10)
    expect(out.toasts).toEqual([])
    out = alertsFor(live(undefined, undefined, 21), T0, out.next, 10)
    expect(out.toasts).toEqual(['Usage: session passed est. $20.00.'])
    expect(alertsFor(live(undefined, undefined, 99), T0, {}, 0).toasts).toEqual([])
  })

  test('no toast carries anything but numbers and times', () => {
    const everything = alertsFor(live(95, 95, 50), T0, {}, 10)
    for (const toast of everything.toasts) expect(toast).toMatch(/^Usage: [A-Za-z0-9 .,:~$%\-]+$/)
  })
})

describe('the /meter command', () => {
  test('it opens, shows status, resets, and sets the footer', () => {
    expect(parseMeterArgs('')).toEqual({ kind: 'open' })
    expect(parseMeterArgs('  OPEN ')).toEqual({ kind: 'open' })
    expect(parseMeterArgs('status')).toEqual({ kind: 'status' })
    expect(parseMeterArgs('reset')).toEqual({ kind: 'reset' })
    expect(parseMeterArgs('footer on')).toEqual({ kind: 'footer', isOn: true })
    expect(parseMeterArgs('Footer OFF')).toEqual({ kind: 'footer', isOn: false })
  })

  test('every pane action has a command, so none needs a click', () => {
    expect(parseMeterArgs('overview')).toEqual({ kind: 'view', view: 'overview' })
    expect(parseMeterArgs('Models')).toEqual({ kind: 'view', view: 'models' })
    expect(parseMeterArgs(' agents ')).toEqual({ kind: 'view', view: 'agents' })
    expect(parseMeterArgs('refresh')).toEqual({ kind: 'refresh' })
    expect(parseMeterArgs('diag')).toEqual({ kind: 'view', view: 'diag' })
    expect(parseMeterArgs('DIAG')).toEqual({ kind: 'view', view: 'diag' })
  })

  test('it refuses the rest with the usage line', () => {
    for (const bad of ['footer', 'footer maybe', 'open now', 'nonsense', 'status extra', 'models now', 'diag maybe', 'diag on', 'diag off', 'refresh 5']) {
      const parsed = parseMeterArgs(bad)
      expect(parsed.kind).toBe('bad')
      if (parsed.kind === 'bad') expect(parsed.usage).toContain('/meter')
    }
  })
})
