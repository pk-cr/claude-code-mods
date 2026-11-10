// What the band and the pane draw.
//
// The views build plain blocks: rows of fixed-width cells, KPI tiles and a tab row,
// sized to the cells the surface gives. `blockLines` and `bandText` flatten blocks to
// text for the tests, the previews and `/meter status`. The JSX at the bottom maps
// blocks to Box, Text and Button only, the elements every surface has. Widths are
// cell counts held by Boxes, not padding spaces, so columns line up on the terminal
// and in the desktop's proportional font alike.

import type { Elements } from 'claude-code'

import type { AgentRow, Ledger, Live, Tally, Ui, ViewId } from '../types'
import {
  GLYPH,
  attributed,
  buildTree,
  cacheNet,
  checkLedger,
  compactAtPct,
  ctxLevel,
  hitRate,
  isBusy,
  limitKinds,
  statusLine,
  totalTally,
  turnsLeft,
  windowState,
} from './ledger'
import type { Level, Node } from './ledger'
import { barParts, fmtClock, fmtPct, fmtRate, fmtReset, fmtTokens, fmtUsd, shortModel, windowName, wrapWords } from './format'
import { PRICES_AS_OF, priceAgeDays, priceFor } from './prices'

export type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type ViewData = { ledger: Ledger; live: Live; ui: Ui; now: number }

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** What a run of text means. A status tone always comes with a glyph and a word, never color alone. */
export type Tone = 'accent' | 'ok' | 'warn' | 'bad' | 'muted'

export type Run = { text: string; tone?: Tone; bold?: boolean }

/** One cell of a row: its runs, cut to `width` cells, aligned left or right. */
export type Cell = { runs: Run[]; width: number; right?: boolean }

/** A tab of the pane, or the Refresh button (no `view`). */
export type Tab = { key: string; label: string; hotkey: string; isActive: boolean; view?: ViewId }

export type Block =
  | { kind: 'row'; cells: Cell[]; gap: number }
  | { kind: 'space' }
  | { kind: 'tiles'; width: number; gap: number; tiles: Run[][][] }
  | { kind: 'tabs'; tabs: Tab[] }

const SPACE: Block = { kind: 'space' }

export const runsLength = (runs: readonly Run[]): number => runs.reduce((sum, run) => sum + run.text.length, 0)

const muted = (text: string): Run => ({ text, tone: 'muted' })
const strong = (text: string): Run => ({ text, bold: true })
const plain = (text: string): Run => ({ text })

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** Cuts runs to `width` cells; an ellipsis marks a cut. */
export function fit(runs: readonly Run[], width: number): Run[] {
  const kept = runs.filter(run => run.text !== '')
  if (runsLength(kept) <= width) return kept
  if (width <= 0) return []
  const out: Run[] = []
  let room = width - 1
  for (const run of kept) {
    if (room <= 0) break
    const text = run.text.slice(0, room)
    out.push({ ...run, text })
    room -= text.length
  }
  const last = out[out.length - 1]
  if (last !== undefined) last.text = last.text.trimEnd()
  const ellipsis: Run = last?.tone === undefined ? { text: '…' } : { text: '…', tone: last.tone }

  return [...out.filter(run => run.text !== ''), ellipsis]
}

function cell(runs: readonly Run[], width: number, isRight = false): Cell {
  const fitted = fit(runs, width)

  return isRight ? { runs: fitted, width, right: true } : { runs: fitted, width }
}

const row = (cells: Cell[], gap = 1): Block => ({ kind: 'row', cells, gap })

const line = (runs: readonly Run[], width: number): Block => row([cell(runs, width)], 0)

/** A section title with a thin rule to the right edge: `Tokens ──────────`. */
function heading(title: string, width: number): Block {
  return line([strong(title), muted(` ${'─'.repeat(Math.max(0, width - title.length - 1))}`)], width)
}

const rule = (width: number): Block => line([muted('─'.repeat(width))], width)

/** Text that wraps at word ends, one row per line. */
function paragraph(text: string, width: number, tone: Tone = 'muted'): Block[] {
  return wrapWords(text, width).map(part => line([{ text: part, tone }], width))
}

/** A row with runs on the left and runs on the right edge. */
function sides(left: readonly Run[], right: readonly Run[], width: number): Block {
  const rightWidth = Math.min(runsLength(right), width)
  const leftWidth = width - rightWidth - 1
  if (leftWidth < 4) return line(left, width)

  return row([cell(left, leftWidth), cell(right, rightWidth, true)], 1)
}

const FILL: Readonly<Record<Level, Tone>> = { ok: 'accent', warn: 'warn', bad: 'bad' }
const MARK: Readonly<Record<Level, Tone>> = { ok: 'ok', warn: 'warn', bad: 'bad' }

/** A bar: the fill in `tone`, the track muted. */
export function bar(pct: number, width: number, tone: Tone = 'accent'): Run[] {
  const { fill, track } = barParts(pct, width)
  const runs: Run[] = []
  if (fill !== '') runs.push({ text: fill, tone })
  if (track !== '') runs.push(muted(track))

  return runs
}

const join = (runs: readonly Run[], gap: string): Run[] => runs.flatMap((run, index) => (index === 0 ? [run] : [plain(gap), run]))

/** The pane's width: what the surface gives, held between 24 and 108 cells so lines stay readable. */
export const paneWidth = (bodyColumns: number): number => Math.max(24, Math.min(108, Math.floor(bodyColumns)))

// ---------------------------------------------------------------------------
// The check against the engine total
// ---------------------------------------------------------------------------

function checkRuns(d: ViewData): { tile: Run; sentence: Run } {
  const check = checkLedger(d.ledger, d.live.usd)
  if (check.state === 'none') {
    return { tile: muted('— nothing to check'), sentence: muted('no engine ledger to check against') }
  }
  if (check.state === 'settling') {
    const busy = Object.values(d.ledger.agents).filter(agent => isBusy(agent.status)).length

    return { tile: muted(`… ${plural(busy, 'agent')} running`), sentence: muted(`settling: ${plural(busy, 'agent')} still running`) }
  }
  const level: Level = check.state === 'ok' ? 'ok' : check.state === 'warn' ? 'warn' : 'bad'
  const share = fmtRate(check.share)
  const gap = check.state === 'ok' ? '' : ` · unattributed ${fmtUsd(Math.abs(check.drift))}${check.drift < 0 ? ' over' : ''}`

  return {
    tile: { text: `${GLYPH[level]} ${share} accounted`, tone: MARK[level] },
    sentence: { text: `${GLYPH[level]} attributed ${fmtUsd(check.attributed)} of ${fmtUsd(check.spent)} (${share})${gap}`, tone: MARK[level] },
  }
}

// ---------------------------------------------------------------------------
// Overview: tiles, then Tokens, Context window and Spend
// ---------------------------------------------------------------------------

type TileMaker = (inner: number) => Run[][]

const TILE_MIN = 22
const TILE_MAX = 34
const TILE_GAP = 1

/** Bars in the sections stop at this many cells, so a wide pane keeps numbers near their bars. */
const BAR_MAX = 40

const TILE_NAME: Readonly<Record<string, string>> = { five_hour: '5-HOUR', seven_day: '7-DAY', spend_limit: 'SPEND LIMIT' }

function spendTile(d: ViewData): TileMaker {
  return () => {
    const mine = attributed(d.ledger)
    const usd = d.live.usd
    const value =
      usd === undefined
        ? mine > 0
          ? [strong(fmtUsd(mine)), muted(' counted')]
          : [strong('—')]
        : [strong(fmtUsd(usd)), muted(' est.')]

    const hasCount = mine > 0 || usd !== undefined

    return [
      [muted('SPEND')],
      value,
      hasCount ? [muted(`${fmtUsd(mine)} attributed`)] : [muted('no turns counted yet')],
      hasCount ? [checkRuns(d).tile] : [],
      d.ledger.key > 0 ? [muted(`since ${fmtClock(d.ledger.key)}`)] : [],
    ]
  }
}

function contextTile(d: ViewData): TileMaker {
  return inner => {
    const ctx = d.live.ctx
    const pct = ctx.percent
    if (pct === undefined) return [[muted('CONTEXT')], [strong('—')], [muted('no reading yet')]]
    const level = ctxLevel(pct)
    const autoAt = compactAtPct(ctx)
    const left = turnsLeft(ctx)
    const near: Run[] =
      autoAt === undefined
        ? level === 'ok'
          ? []
          : [{ text: `${GLYPH[level]} filling up`, tone: MARK[level] }]
        : level === 'ok'
          ? [muted(`compacts at ~${autoAt}%`)]
          : [{ text: `${GLYPH[level]} compacts at ~${autoAt}%`, tone: MARK[level] }]

    return [
      [muted('CONTEXT')],
      [strong(fmtPct(pct)), muted(` of ${fmtTokens(ctx.window)}`)],
      bar(pct, inner, FILL[level]),
      near,
      left === undefined ? [] : left === 0 ? [muted('due now')] : [muted(`~${plural(left, 'turn')} left`)],
    ]
  }
}

function windowTile(d: ViewData, kind: string): TileMaker {
  return inner => {
    const limit = d.live.limits[kind]
    if (limit === undefined) return []
    const state = windowState(limit, d.now)
    const isAlarm = state.isFilling || state.pct >= 100

    return [
      [muted(TILE_NAME[kind] ?? kind.toUpperCase())],
      [strong(fmtPct(state.pct)), { text: ` ${GLYPH[state.level]}`, tone: MARK[state.level] }],
      bar(state.pct, inner, FILL[state.level]),
      isAlarm ? [{ text: `▲ ${state.pace}`, tone: 'warn' }] : [muted(state.pace)],
      state.resets === undefined ? [] : [muted(`resets ${fmtReset(state.resets, d.now)}`)],
    ]
  }
}

/** Lays tiles out in even rows, as wide as the pane allows, every tile the same height. */
function tileRows(makers: readonly TileMaker[], width: number): Block[] {
  if (makers.length === 0) return []
  const most = Math.max(1, Math.floor((width + TILE_GAP) / (TILE_MIN + TILE_GAP)))
  const rows = Math.ceil(makers.length / most)
  const perRow = Math.ceil(makers.length / rows)
  const tileWidth = Math.max(10, Math.min(TILE_MAX, Math.floor((width - TILE_GAP * (perRow - 1)) / perRow)))
  const inner = tileWidth - 4
  const built = makers.map(make => make(inner).map(each => fit(each, inner)))
  const height = Math.max(...built.map(tile => tile.length))
  const even = built.map(tile => [...tile, ...Array.from({ length: height - tile.length }, (): Run[] => [])])
  const blocks: Block[] = []
  for (let start = 0; start < even.length; start += perRow) {
    blocks.push({ kind: 'tiles', width: tileWidth, gap: TILE_GAP, tiles: even.slice(start, start + perRow) })
  }

  return blocks
}

const STATS: readonly { long: string; short: string }[] = [
  { long: 'Uncached', short: 'In' },
  { long: 'Output', short: 'Out' },
  { long: 'Cache read', short: 'Read' },
  { long: 'Cache write', short: 'Write' },
  { long: 'Hit rate', short: 'Hit' },
]

function tokenBlocks(d: ViewData, width: number): Block[] {
  const all = totalTally(d.ledger)
  const blocks: Block[] = [heading('Tokens', width)]
  if (all.n === 0) return [...blocks, ...paragraph('No turns counted yet. A turn adds its usage when it ends.', width)]
  const hit = hitRate(all.i, all.r, all.w)
  const values = [fmtTokens(all.i), fmtTokens(all.o), fmtTokens(all.r), fmtTokens(all.w), hit === undefined ? '—' : fmtRate(hit)]
  const perStrip = Math.min(STATS.length, Math.max(1, Math.floor((width + 1) / 9)))
  const cellWidth = Math.min(14, Math.floor((width - (perStrip - 1)) / perStrip))
  for (let start = 0; start < STATS.length; start += perStrip) {
    const stats = STATS.slice(start, start + perStrip)
    blocks.push(row(stats.map(stat => cell([muted(cellWidth >= 11 ? stat.long : stat.short)], cellWidth))))
    blocks.push(row(stats.map((_, index) => cell([strong(values[start + index] ?? '—')], cellWidth))))
  }
  if (hit !== undefined) blocks.push(...paragraph(`cache saved ≈ ${fmtUsd(Math.max(0, cacheNet(d.ledger)))} against no cache`, width))

  return blocks
}

function contextBlocks(d: ViewData, width: number): Block[] {
  const ctx = d.live.ctx
  if (ctx.cats.length === 0 || ctx.window <= 0) return []
  const nameWidth = Math.min(18, Math.max(10, Math.floor(width * 0.24)))
  const valueWidth = 6
  const barWidth = Math.max(4, Math.min(BAR_MAX, width - nameWidth - valueWidth - 2))

  return [
    heading('Context window', width),
    ...ctx.cats.slice(0, 5).map(([name, tokens]) =>
      row([cell([plain(name)], nameWidth), cell(bar((tokens / ctx.window) * 100, barWidth), barWidth), cell([plain(fmtTokens(tokens))], valueWidth, true)]),
    ),
  ]
}

const byCost = (entries: [string, Tally][]): [string, Tally][] =>
  entries.sort((a, b) => b[1].usd - a[1].usd || b[1].o - a[1].o)

const isUnpriced = (tally: Tally): boolean => tally.np > 0 && tally.usd === 0

function costText(tally: Tally): Run {
  if (isUnpriced(tally)) return muted('—')

  return plain(`${tally.np > 0 ? '~' : ''}${fmtUsd(tally.usd)}`)
}

function spendBlocks(d: ViewData, width: number): Block[] {
  const { ledger } = d
  const models = byCost(Object.entries(ledger.models))
  if (models.length === 0) return []
  const total = models.reduce((sum, [, tally]) => sum + tally.usd, 0)
  const costWidth = 8
  const pctWidth = 5
  // The bar takes what is left after a 14-cell name; below 4 cells it goes and the name takes the room.
  const barRoom = Math.min(BAR_MAX, width - 14 - costWidth - pctWidth - 3)
  const hasBar = barRoom >= 4
  const nameWidth = hasBar ? 14 : Math.max(4, width - costWidth - pctWidth - 2)
  const blocks: Block[] = [heading('Spend by model', width)]
  for (const [key, tally] of models.slice(0, 5)) {
    const share = total > 0 ? (tally.usd / total) * 100 : 0
    const shareBar = hasBar ? [cell(isUnpriced(tally) ? [muted('unpriced')] : bar(share, barRoom), barRoom)] : []
    blocks.push(
      row([
        cell([plain(shortModel(key))], nameWidth),
        ...shareBar,
        cell([costText(tally)], costWidth, true),
        cell(isUnpriced(tally) ? [] : [muted(fmtPct(share))], pctWidth, true),
      ]),
    )
  }
  const agents = Object.values(ledger.agents).filter(agent => agent.t.n > 0)
  const agentUsd = agents.reduce((sum, agent) => sum + agent.t.usd, ledger.folded.usd)
  const loops = [`main ${fmtUsd(ledger.main.usd)}`, `${plural(agents.length + ledger.foldedN, 'agent')} ${fmtUsd(agentUsd)}`]
  if (ledger.system.n > 0) loops.push(`system ${fmtUsd(ledger.system.usd)}`)
  blocks.push(...paragraph(loops.join(' · '), width))
  if (ledger.base !== null && ledger.base >= 0.005) blocks.push(...paragraph(`before the meter began ${fmtUsd(ledger.base)}`, width))

  return blocks
}

function overviewBlocks(d: ViewData, width: number): Block[] {
  const makers = [spendTile(d), contextTile(d), ...limitKinds(d.live).filter(kind => d.live.limits[kind] !== undefined).map(kind => windowTile(d, kind))]
  const sections = [tokenBlocks(d, width), contextBlocks(d, width), spendBlocks(d, width)].filter(section => section.length > 0)
  const age = priceAgeDays(d.now)
  const blocks: Block[] = [...tileRows(makers, width)]
  for (const section of sections) blocks.push(SPACE, ...section)
  blocks.push(SPACE, ...paragraph(`prices as of ${PRICES_AS_OF}${age > 45 ? ` (${age} days old)` : ''} · est. = engine estimate, not a bill`, width))

  return blocks
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

type Column = { title: string; width: number; right?: boolean }

/** Fixed columns, then one column that takes the rest of the width. */
function columns(fixed: readonly Column[], grow: Column, growAt: number, width: number): Column[] {
  const used = fixed.reduce((sum, col) => sum + col.width, 0) + fixed.length
  const grown = { ...grow, width: Math.max(4, width - used) }

  return [...fixed.slice(0, growAt), grown, ...fixed.slice(growAt)]
}

function tableRow(cols: readonly Column[], values: readonly (readonly Run[])[]): Block {
  return row(cols.map((col, index) => cell(values[index] ?? [], col.width, col.right === true)))
}

function tableHead(cols: readonly Column[], width: number): Block[] {
  return [tableRow(cols, cols.map(col => [muted(col.title)])), rule(width)]
}

type Tier = 'wide' | 'mid' | 'narrow'

const modelTier = (width: number): Tier => (width >= 84 ? 'wide' : width >= 60 ? 'mid' : 'narrow')

function modelBlocks(d: ViewData, width: number): Block[] {
  const models = byCost(Object.entries(d.ledger.models))
  if (models.length === 0) return paragraph('No turns counted yet. A turn adds its usage when it ends.', width)
  const tier = modelTier(width)
  const total = models.reduce((sum, [, tally]) => sum + tally.usd, 0)
  const name: Column = { title: 'Model', width: 14 }
  const turns: Column = { title: 'Turns', width: 5, right: true }
  const output: Column = { title: 'Output', width: 7, right: true }
  const read: Column = { title: 'Cache read', width: 10, right: true }
  const write: Column = { title: 'Cache write', width: 11, right: true }
  const fresh: Column = { title: 'Uncached', width: 8, right: true }
  const cost: Column = { title: 'Cost', width: 8, right: true }
  const share: Column = { title: 'Share', width: 0 }
  const pct: Column = { title: tier === 'narrow' ? 'Share' : '', width: 5, right: true }
  const cols =
    tier === 'wide'
      ? columns([name, turns, output, read, write, fresh, cost, pct], share, 7, width)
      : tier === 'mid'
        ? columns([name, turns, output, cost, pct], share, 4, width)
        : columns([cost, pct], { ...name, width: 0 }, 0, width)
  const barWidth = cols.find(col => col.title === 'Share' && col.right !== true)?.width ?? 0
  const valuesOf = (key: string, tally: Tally, isTotal: boolean): Run[][] => {
    const weight = (text: string): Run => (isTotal ? strong(text) : plain(text))
    const sharePct = total > 0 ? (tally.usd / total) * 100 : 0
    const shareBar = isTotal ? [] : isUnpriced(tally) ? [muted('unpriced')] : bar(sharePct, barWidth)
    const shareText = isTotal || isUnpriced(tally) ? [] : [muted(fmtPct(sharePct))]
    const costRun = isTotal ? strong(fmtUsd(tally.usd)) : costText(tally)
    const nameRun = isTotal ? strong(key) : plain(shortModel(key))
    if (tier === 'wide') {
      return [[nameRun], [weight(`${tally.n}`)], [weight(fmtTokens(tally.o))], [weight(fmtTokens(tally.r))], [weight(fmtTokens(tally.w))], [weight(fmtTokens(tally.i))], [costRun], shareBar, shareText]
    }
    if (tier === 'mid') return [[nameRun], [weight(`${tally.n}`)], [weight(fmtTokens(tally.o))], [costRun], shareBar, shareText]

    return [[nameRun], [costRun], shareText]
  }
  const sum = models.reduce<Tally>(
    (acc, [, tally]) => ({ i: acc.i + tally.i, o: acc.o + tally.o, r: acc.r + tally.r, w: acc.w + tally.w, usd: acc.usd + tally.usd, n: acc.n + tally.n, np: acc.np + tally.np }),
    { i: 0, o: 0, r: 0, w: 0, usd: 0, n: 0, np: 0 },
  )
  const blocks: Block[] = [...tableHead(cols, width)]
  for (const [key, tally] of models) blocks.push(tableRow(cols, valuesOf(key, tally, false)))
  if (models.length > 1) blocks.push(rule(width), tableRow(cols, valuesOf('Total', sum, true)))
  const notes = models.flatMap(([key]) => {
    const note = priceFor(key)?.note

    return note === undefined ? [] : [`${shortModel(key)}: ${note}`]
  })
  blocks.push(SPACE)
  for (const note of notes) blocks.push(...paragraph(note, width))
  blocks.push(...paragraph(`prices as of ${PRICES_AS_OF} · cache writes priced as 5-minute · ~ = some turns unpriced`, width))

  return blocks
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function statusPill(status: string): Run {
  if (isBusy(status)) return { text: '● running', tone: 'accent' }
  if (status === 'idle') return muted('○ idle')
  if (status === 'completed') return { text: '✓ done', tone: 'ok' }
  if (status === 'failed') return { text: '✖ failed', tone: 'bad' }
  if (status === 'killed') return { text: '✖ stopped', tone: 'bad' }

  return muted(status)
}

export const statusWords = (status: string): string => statusPill(status).text

function agentFlags(agent: AgentRow): Run[] {
  const flags: Run[] = []
  if (agent.type === 'fork' && agent.firstHit !== undefined && agent.firstHit < 0.2) {
    flags.push({ text: `▲ cold prefix (hit ${fmtRate(agent.firstHit)})`, tone: 'warn' })
  }
  if (agent.t.np > 0) flags.push({ text: '▲ model not priced', tone: 'warn' })
  if (agent.by !== undefined) flags.push(muted(`via ${agent.by}`))

  return join(flags, '  ')
}

function agentBlocks(d: ViewData, width: number): Block[] {
  const { ledger } = d
  if (ledger.main.n === 0 && Object.keys(ledger.agents).length === 0 && ledger.system.n === 0) {
    return paragraph('No turns counted yet. A turn adds its usage when it ends.', width)
  }
  const isWide = width >= 72
  const nameCol: Column = { title: 'Agent', width: 0 }
  const fixed: Column[] = isWide
    ? [
        { title: 'Model', width: 11 },
        { title: 'Cost', width: 8, right: true },
        { title: 'Turns', width: 5, right: true },
        { title: 'Status', width: 10 },
      ]
    : [
        { title: 'Cost', width: 8, right: true },
        { title: 'Status', width: 10 },
      ]
  const cols = columns(fixed, nameCol, 0, width)
  const values = (nameRuns: Run[], model: string, sub: Tally, turns: number, status: Run[]): Run[][] =>
    isWide
      ? [nameRuns, model === '' ? [] : [plain(model)], [plain(fmtUsd(sub.usd))], [plain(`${turns}`)], status]
      : [nameRuns, [plain(fmtUsd(sub.usd))], status]
  const tree = buildTree(ledger)
  const blocks: Block[] = [...tableHead(cols, width)]
  blocks.push(tableRow(cols, values([strong('main'), muted(' (this conversation)')], '', tree.sub, ledger.main.n, [])))
  const walk = (node: Node, prefix: string): void => {
    node.kids.forEach((kid, index) => {
      const agent = kid.row
      if (agent === undefined) return
      const isLast = index === node.kids.length - 1
      const stem = `${prefix}${isLast ? '   ' : '│  '}`
      const name = agent.teammate === true ? `teammate${agent.name === undefined ? '' : ` ${agent.name}`}` : agent.type
      const nameRuns = [muted(`${prefix}${isLast ? '└─ ' : '├─ '}`), strong(name), ...(agent.label === '' ? [] : [muted(` · ${agent.label}`)])]
      blocks.push(tableRow(cols, values(nameRuns, agent.model === undefined ? '' : shortModel(agent.model), kid.sub, agent.t.n, [statusPill(agent.status)])))
      const flags = agentFlags(agent)
      if (flags.length > 0) blocks.push(line([muted(`${stem}${kid.kids.length > 0 ? '│  ' : '   '}`), ...flags], width))
      walk(kid, stem)
    })
  }
  walk(tree, '')
  if (ledger.foldedN > 0) {
    blocks.push(tableRow(cols, values([strong('earlier agents'), muted(` (${ledger.foldedN} folded)`)], '', ledger.folded, ledger.folded.n, [])))
  }
  if (ledger.system.n > 0) {
    blocks.push(tableRow(cols, values([strong('system'), muted(' (unnamed engine loops)')], '', ledger.system, ledger.system.n, [])))
  }
  blocks.push(SPACE, ...paragraph('Cost includes children · ● still adding cost · a row appears when an agent first reports', width))

  return blocks
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function pairs(items: readonly [string, Run][], width: number): Block[] {
  const labelWidth = Math.min(16, Math.max(10, Math.floor(width / 4)))
  const valueWidth = Math.max(8, width - labelWidth - 1)

  return items.flatMap(([label, value]) =>
    wrapWords(value.text, valueWidth).map((part, index) =>
      row([cell(index === 0 ? [muted(label)] : [], labelWidth), cell([{ ...value, text: part }], valueWidth)]),
    ),
  )
}

function diagBlocks(d: ViewData, width: number): Block[] {
  const { ledger, live, now } = d
  const diag = ledger.diag
  const reasons = Object.entries(diag.reasons).map(([reason, count]) => `${reason} ${count}`).join(', ')
  const kinds = limitKinds(live)
  const account =
    live.account === 'subscription'
      ? 'subscription: the cost is an API-equivalent figure'
      : live.account === 'gateway'
        ? 'gateway: the cost is a spend figure'
        : 'unknown (no rate-limit windows reported)'
  const notes = diag.models.flatMap(model => {
    const note = priceFor(model)?.note

    return note === undefined ? [] : [`${shortModel(model)}: ${note}`]
  })
  const age = priceAgeDays(now)

  return [
    heading('Ledger', width),
    ...pairs(
      [
        ['Turns', plain(`${diag.withUsage} with usage · ${diag.noUsage} without${reasons === '' ? '' : ` (${reasons})`}`)],
        ['Check', checkRuns(d).sentence],
        ['Unnamed loops', plain(`${diag.sysIds.length}${diag.sysIds.length === 0 ? '' : ` · ${diag.sysIds.slice(0, 4).join(', ')}`}`)],
        ['Model ids', plain(diag.models.length === 0 ? 'none yet' : diag.models.join(', '))],
      ],
      width,
    ),
    SPACE,
    heading('Session', width),
    ...pairs(
      [
        ['Account', plain(account)],
        ['Window kinds', plain(kinds.length === 0 ? 'none' : kinds.join(', '))],
        ['Measures', plain(`${live.measures}${live.at > 0 ? ` · last ${fmtClock(live.at)}` : ''}`)],
        ['Ledger base', plain(ledger.base === null ? 'not set' : `${fmtUsd(ledger.base)} before the meter began`)],
        ['Session key', plain(`${ledger.key}${ledger.key > 0 ? ` · started ${fmtClock(ledger.key)}` : ''}`)],
      ],
      width,
    ),
    SPACE,
    heading('Prices', width),
    ...pairs(
      [
        ['Table', { text: `as of ${PRICES_AS_OF} · ${plural(Math.max(0, age), 'day')} old`, ...(age > 45 ? { tone: 'warn' as const } : {}) }],
        ['Notes', plain(notes.length === 0 ? 'none for the models seen' : notes.join(' · '))],
        ['Cache writes', plain('priced as 5-minute writes (usage does not split them by lifetime)')],
      ],
      width,
    ),
  ]
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

/** Under every tab: the same actions as commands, for a surface where a button press does not arrive. */
export const KEYS_HINT = '/meter overview · models · agents · diag · refresh'

const TABS: readonly { view: ViewId; long: string; short: string; hotkey: string }[] = [
  { view: 'overview', long: '1 Overview', short: 'Overview', hotkey: '1' },
  { view: 'models', long: '2 Models', short: 'Models', hotkey: '2' },
  { view: 'agents', long: '3 Agents', short: 'Agents', hotkey: '3' },
  { view: 'diag', long: '4 Diagnostics', short: 'Diag', hotkey: '4' },
]

function tabsBlock(view: ViewId, width: number): Block {
  const isLong = width >= 76
  const tabs: Tab[] = TABS.map(tab => ({ key: `tab-${tab.view}`, label: isLong ? tab.long : tab.short, hotkey: tab.hotkey, isActive: tab.view === view, view: tab.view }))
  tabs.push({ key: 'refresh', label: isLong ? 'r Refresh' : 'Refresh', hotkey: 'r', isActive: false })

  return { kind: 'tabs', tabs }
}

export function viewBlocks(view: ViewId, d: ViewData, width: number): Block[] {
  if (view === 'models') return modelBlocks(d, width)
  if (view === 'agents') return agentBlocks(d, width)
  if (view === 'diag') return diagBlocks(d, width)

  return overviewBlocks(d, width)
}

export function paneBlocks(d: ViewData, width: number): Block[] {
  const view: ViewId = TABS.some(tab => tab.view === d.ui.view) ? d.ui.view : 'overview'
  const updated = d.live.at > 0 ? `updated ${fmtClock(d.live.at)}` : 'no reading yet'

  return [
    sides([strong('Usage'), muted(' · this session')], [muted(updated)], width),
    tabsBlock(view, width),
    SPACE,
    ...viewBlocks(view, d, width),
    SPACE,
    ...paragraph(KEYS_HINT, width),
  ]
}

// ---------------------------------------------------------------------------
// Text: the blocks as lines
// ---------------------------------------------------------------------------

const textOf = (runs: readonly Run[]): string => runs.map(run => run.text).join('')

function cellText(one: Cell): string {
  const text = textOf(one.runs)

  return one.right === true ? text.padStart(one.width, ' ') : text.padEnd(one.width, ' ')
}

/** The label a Button draws on the terminal. */
export const buttonText = (label: string): string => `[ ${label} ]`

function tabLines(tabs: readonly Tab[], width: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const tab of tabs) {
    const text = buttonText(tab.label)
    if (current === '') current = text
    else if (current.length + 1 + text.length <= width) current = `${current} ${text}`
    else {
      lines.push(current)
      current = text
    }
  }
  if (current !== '') lines.push(current)

  return lines
}

/** The blocks as plain lines, trailing spaces cut. */
export function blockLines(blocks: readonly Block[], width: number): string[] {
  const out: string[] = []
  for (const block of blocks) {
    if (block.kind === 'space') out.push('')
    else if (block.kind === 'row') out.push(block.cells.map(cellText).join(' '.repeat(block.gap)).trimEnd())
    else if (block.kind === 'tabs') out.push(...tabLines(block.tabs, width))
    else {
      const inner = block.width - 4
      const gap = ' '.repeat(block.gap)
      const height = Math.max(0, ...block.tiles.map(tile => tile.length))
      const edge = (left: string, right: string): string => block.tiles.map(() => `${left}${'─'.repeat(block.width - 2)}${right}`).join(gap)
      out.push(edge('╭', '╮'))
      for (let index = 0; index < height; index += 1) {
        out.push(block.tiles.map(tile => `│ ${textOf(tile[index] ?? []).padEnd(inner, ' ')} │`).join(gap))
      }
      out.push(edge('╰', '╯'))
    }
  }

  return out
}

export const paneLines = (d: ViewData, bodyColumns: number): string[] => {
  const width = paneWidth(bodyColumns)

  return blockLines(paneBlocks(d, width), width)
}

/** The text `/meter status` answers: the status entry, the token counts, and the check. */
export function summaryText(d: ViewData): string {
  const all = totalTally(d.ledger)
  const mine = attributed(d.ledger)
  const first = statusLine(d.live, d.live.usd ?? (mine > 0 ? mine : undefined), d.now) ?? 'No reading yet.'
  const hit = hitRate(all.i, all.r, all.w)
  const tokens = `tokens: ${fmtTokens(all.i)} uncached · ${fmtTokens(all.o)} output · ${fmtTokens(all.r)} cache read · ${fmtTokens(all.w)} cache write${hit === undefined ? '' : ` · ${fmtRate(hit)} hit`}`

  return `${first}\n${tokens}\ncheck: ${checkRuns(d).sentence.text}`
}

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

export type BandModel = { groups: Run[][]; gap: number }

const DETAILS = 'Details'

/**
 * The band's groups, fitted to `width`: bars and the fill time go first when room is short,
 * then the word "Usage". Undefined while nothing is measured, so the band stays out of the way.
 */
export function bandModel(d: ViewData, width: number): BandModel | undefined {
  const { live, now } = d
  const pct = live.ctx.percent
  const kinds = limitKinds(live).filter(kind => live.limits[kind] !== undefined)
  const mine = attributed(d.ledger)
  const spend = live.usd ?? (mine > 0 ? mine : undefined)
  if (pct === undefined && kinds.length === 0 && spend === undefined) return undefined
  const build = (hasBars: boolean, hasEta: boolean, hasName: boolean): Run[][] => {
    const groups: Run[][] = [[{ text: '◆', tone: 'accent' }, ...(hasName ? [strong(' Usage')] : [])]]
    if (pct !== undefined) {
      const level = ctxLevel(pct)
      groups.push([
        muted('ctx '),
        ...(hasBars ? [...bar(pct, 6, FILL[level]), plain(' ')] : []),
        strong(fmtPct(pct)),
        ...(level === 'ok' ? [] : [{ text: ` ${GLYPH[level]}`, tone: MARK[level] }]),
      ])
    }
    for (const kind of kinds) {
      const limit = live.limits[kind]
      if (limit === undefined) continue
      const state = windowState(limit, now)
      groups.push([
        muted(`${windowName(kind)} `),
        ...(hasBars ? [...bar(state.pct, 6, FILL[state.level]), plain(' ')] : []),
        strong(fmtPct(state.pct)),
        ...(state.level === 'ok' ? [] : [{ text: ` ${GLYPH[state.level]}`, tone: MARK[state.level] }]),
        ...(hasEta && state.isFilling ? [{ text: ` ${state.pace}`, tone: 'warn' as const }] : []),
      ])
    }
    if (spend !== undefined) groups.push([strong(fmtUsd(spend)), muted(' est.')])

    return groups
  }
  const tries: readonly [boolean, boolean, boolean, number][] = [
    [true, true, true, 3],
    [false, true, true, 3],
    [false, true, true, 2],
    [false, false, true, 2],
    [false, false, false, 2],
  ]
  for (const [hasBars, hasEta, hasName, gap] of tries) {
    const groups = build(hasBars, hasEta, hasName)
    const size = groups.reduce((sum, group) => sum + runsLength(group), 0) + gap * groups.length + buttonText(DETAILS).length
    if (size <= width) return { groups, gap }
  }

  return { groups: build(false, false, false), gap: 2 }
}

/** The band as one line of text, or undefined while nothing is measured. */
export function bandText(d: ViewData, width: number): string | undefined {
  const model = bandModel(d, width)
  if (model === undefined) return undefined

  return [...model.groups.map(textOf), buttonText(DETAILS)].join(' '.repeat(model.gap))
}

// ---------------------------------------------------------------------------
// Drawing: blocks to Box, Text and Button
// ---------------------------------------------------------------------------

const COLOR: Readonly<Record<Exclude<Tone, 'muted'>, string>> = { accent: 'claude', ok: 'success', warn: 'warning', bad: 'error' }

type TextStyle = { bold?: true; dimColor?: true; color?: string }

/** A run's Text props, each present only when set: a tree holds no undefined prop. */
function styleOf(run: Run): TextStyle {
  const style: TextStyle = {}
  if (run.bold === true) style.bold = true
  if (run.tone === 'muted') style.dimColor = true
  else if (run.tone !== undefined) style.color = COLOR[run.tone]

  return style
}

function drawRun({ Text }: Els, run: Run) {
  return (
    <Text wrap="truncate-end" {...styleOf(run)}>
      {run.text}
    </Text>
  )
}

function drawRuns(els: Els, runs: readonly Run[]) {
  const { Box, Text } = els
  if (runs.length === 0) return <Text> </Text>

  return <Box flexDirection="row">{runs.map(run => drawRun(els, run))}</Box>
}

function drawCell(els: Els, one: Cell) {
  const { Box } = els

  return (
    <Box flexDirection="row" width={one.width} flexShrink={0} justifyContent={one.right === true ? 'flex-end' : 'flex-start'}>
      {one.runs.map(run => drawRun(els, run))}
    </Box>
  )
}

export type Handlers = {
  onView: (view: ViewId) => void
  onRefresh: () => void
}

function drawBlock(els: Els, block: Block, handlers: Handlers) {
  const { Box, Text, Button } = els
  if (block.kind === 'space') return <Text> </Text>
  if (block.kind === 'row') {
    if (block.cells.every(one => one.runs.length === 0)) return <Text> </Text>

    return (
      <Box flexDirection="row" columnGap={block.gap}>
        {block.cells.map(one => drawCell(els, one))}
      </Box>
    )
  }
  if (block.kind === 'tabs') {
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {block.tabs.map(tab => (
          <Button
            key={tab.key}
            label={tab.label}
            hotkey={tab.hotkey}
            variant={tab.isActive ? 'primary' : 'secondary'}
            onPress={() => {
              const view = tab.view
              if (view === undefined) handlers.onRefresh()
              else handlers.onView(view)
            }}
          />
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" columnGap={block.gap}>
      {block.tiles.map(tile => (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={block.width} flexShrink={0}>
          {tile.map(runs => drawRuns(els, runs))}
        </Box>
      ))}
    </Box>
  )
}

export function Panel(els: Els, d: ViewData, bodyColumns: number, handlers: Handlers) {
  const { Box } = els
  const width = paneWidth(bodyColumns)

  return <Box flexDirection="column">{paneBlocks(d, width).map(block => drawBlock(els, block, handlers))}</Box>
}

export function Band(els: Els, band: BandModel, onOpen: () => void) {
  const { Box, Button } = els

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={band.gap}>
      {band.groups.map(group => drawRuns(els, group))}
      <Button key="details" label={DETAILS} onPress={() => onOpen()} />
    </Box>
  )
}
