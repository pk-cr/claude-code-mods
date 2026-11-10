// The ledger: pure functions over the state values. None of them takes `$`,
// so the tests run them without an engine. Nothing here reads a prompt or an answer.

import type { AgentInfo } from 'claude-code'

import type { Account, AgentRow, Ctx, Ledger, Limit, Live, Sample, Tally, Ui, ViewId } from '../types'
import { clip, fmtClock, fmtPct, fmtRate, fmtReset, fmtTokens, fmtUsd, oneLine, windowName } from './format'
import { modelKey, priceFor } from './prices'
import type { Price } from './prices'

// ---------------------------------------------------------------------------
// Empty values
// ---------------------------------------------------------------------------

export const ZERO: Tally = { i: 0, o: 0, r: 0, w: 0, usd: 0, n: 0, np: 0 }

export function emptyLedger(key = 0): Ledger {
  return {
    key,
    base: null,
    main: ZERO,
    system: ZERO,
    folded: ZERO,
    foldedN: 0,
    agents: {},
    models: {},
    win: { agents: 0 },
    diag: { withUsage: 0, noUsage: 0, models: [], sysIds: [], reasons: {} },
  }
}

export function emptyLive(): Live {
  return { account: 'unknown', measures: 0, at: 0, ctx: { window: 0, growth: 0, cats: [] }, limits: {} }
}

export const EMPTY_UI: Ui = { view: 'overview', footer: true, alerts: {} }

/** State values hold no `undefined`: a missing field is absent. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(value)) {
    if (field !== undefined) out[name] = field
  }

  return out as T
}

// ---------------------------------------------------------------------------
// Tokens and dollars
// ---------------------------------------------------------------------------

export type UsageIn = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}

/**
 * Dollars for one usage at one price. `TurnUsage` does not split cache writes by
 * lifetime, so the 5-minute write price is assumed.
 */
export function costOf(price: Price, usage: UsageIn): number {
  return (
    (usage.input_tokens * price.in +
      usage.output_tokens * price.out +
      usage.cache_read_input_tokens * price.r +
      usage.cache_creation_input_tokens * price.w5) /
    1_000_000
  )
}

/** Dollars for a turn, or undefined when the model has no price. */
export function turnUsd(usage: UsageIn & { readonly model: string }): number | undefined {
  const price = priceFor(usage.model)

  return price === undefined ? undefined : costOf(price, usage)
}

export function addTally(tally: Tally, usage: UsageIn, usd: number | undefined): Tally {
  return {
    i: tally.i + usage.input_tokens,
    o: tally.o + usage.output_tokens,
    r: tally.r + usage.cache_read_input_tokens,
    w: tally.w + usage.cache_creation_input_tokens,
    usd: tally.usd + (usd ?? 0),
    n: tally.n + 1,
    np: tally.np + (usd === undefined ? 1 : 0),
  }
}

export function sumTally(a: Tally, b: Tally): Tally {
  return { i: a.i + b.i, o: a.o + b.o, r: a.r + b.r, w: a.w + b.w, usd: a.usd + b.usd, n: a.n + b.n, np: a.np + b.np }
}

/** Cache read tokens over all input-side tokens, 0 to 1; undefined with no input. */
export function hitRate(i: number, r: number, w: number): number | undefined {
  const total = i + r + w

  return total === 0 ? undefined : r / total
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** One agent as `$.agent.list()` names it, cut to what the ledger keeps. */
export type Sighting = {
  id: string
  parent?: string
  type: string
  label: string
  name?: string
  status: string
  teammate?: boolean
  by?: string
}

export function sightOf(agent: AgentInfo): Sighting {
  return compact({
    id: agent.id,
    parent: agent.parentId,
    type: agent.type,
    label: clip(oneLine(agent.description), 48),
    name: agent.name,
    status: agent.status,
    teammate: agent.teammateId === undefined ? undefined : true,
    by: agent.spawnedBy,
  })
}

export const isEnded = (status: string): boolean =>
  status === 'completed' || status === 'failed' || status === 'killed'

export const isBusy = (status: string): boolean =>
  status === 'running' || status === 'pending' || status === 'waiting'

export function anyBusy(ledger: Ledger): boolean {
  return Object.values(ledger.agents).some(row => isBusy(row.status))
}

function newRow(sight: Sighting, now: number): AgentRow {
  return compact({ ...sight, t: ZERO, runs: 0, first: now, last: now })
}

function mergeSight(row: AgentRow, sight: Sighting): AgentRow {
  return compact({
    ...row,
    parent: sight.parent,
    type: sight.type,
    label: sight.label,
    name: sight.name ?? row.name,
    status: sight.status,
    teammate: sight.teammate,
    by: sight.by,
  })
}

const isSame = (a: AgentRow, b: AgentRow): boolean =>
  a.parent === b.parent && a.type === b.type && a.label === b.label && a.name === b.name && a.status === b.status

export const MAX_AGENTS = 40

/** Keeps the state small: the oldest finished agents fold into one tally. */
export function prune(ledger: Ledger): Ledger {
  const rows = Object.values(ledger.agents)
  if (rows.length <= MAX_AGENTS) return ledger
  const ended = rows.filter(row => isEnded(row.status)).sort((a, b) => a.last - b.last)
  const drop = ended.slice(0, rows.length - MAX_AGENTS)
  if (drop.length === 0) return ledger
  const agents = { ...ledger.agents }
  let folded = ledger.folded
  for (const row of drop) {
    folded = sumTally(folded, row.t)
    delete agents[row.id]
  }

  return { ...ledger, agents, folded, foldedN: ledger.foldedN + drop.length }
}

/** Brings the rows in line with the agent list. Hands back the same ledger when nothing changed. */
export function syncAgents(ledger: Ledger, listed: readonly Sighting[], now: number): Ledger {
  if (listed.length === 0) return ledger
  const agents = { ...ledger.agents }
  let isChanged = false
  for (const sight of listed) {
    const row = agents[sight.id]
    if (row === undefined) {
      agents[sight.id] = newRow(sight, now)
      isChanged = true
      continue
    }
    const merged = mergeSight(row, sight)
    if (!isSame(row, merged)) {
      agents[sight.id] = merged
      isChanged = true
    }
  }

  return isChanged ? prune({ ...ledger, agents }) : ledger
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export type TurnIn = {
  agentId?: string
  usage: UsageIn & { readonly model: string }
  now: number
  /** The agent as the list names it. Absent for the main loop and for a loop no list names. */
  sight?: Sighting
}

function remember(list: readonly string[], item: string, cap: number): string[] {
  return list.includes(item) ? [...list] : [...list, item].slice(-cap)
}

/** Adds one loop turn that carried usage. */
export function recordTurn(ledger: Ledger, turn: TurnIn): Ledger {
  const key = modelKey(turn.usage.model)
  const usd = turnUsd(turn.usage)
  const diag = {
    ...ledger.diag,
    withUsage: ledger.diag.withUsage + 1,
    models: remember(ledger.diag.models, turn.usage.model, 12),
  }
  const models = { ...ledger.models, [key]: addTally(ledger.models[key] ?? ZERO, turn.usage, usd) }
  if (turn.agentId === undefined) {
    return { ...ledger, main: addTally(ledger.main, turn.usage, usd), models, diag }
  }
  const win = { agents: ledger.win.agents + (usd ?? 0) }
  const row = ledger.agents[turn.agentId]
  const known = row ?? (turn.sight === undefined ? undefined : newRow(turn.sight, turn.now))
  if (known === undefined) {
    return {
      ...ledger,
      system: addTally(ledger.system, turn.usage, usd),
      models,
      win,
      diag: { ...diag, sysIds: remember(diag.sysIds, turn.agentId, 10) },
    }
  }
  const seen = turn.sight === undefined ? known : mergeSight(known, turn.sight)
  const next: AgentRow = compact({
    ...seen,
    model: key,
    t: addTally(seen.t, turn.usage, usd),
    runs: seen.runs + 1,
    last: turn.now,
    firstHit:
      seen.runs === 0
        ? hitRate(turn.usage.input_tokens, turn.usage.cache_read_input_tokens, turn.usage.cache_creation_input_tokens)
        : seen.firstHit,
  })

  return prune({ ...ledger, agents: { ...ledger.agents, [turn.agentId]: next }, models, win, diag })
}

/** Counts a turn that ended without usage (an interrupt, an API error). */
export function noteMissing(ledger: Ledger, reason: string): Ledger {
  const reasons = { ...ledger.diag.reasons, [reason]: (ledger.diag.reasons[reason] ?? 0) + 1 }

  return { ...ledger, diag: { ...ledger.diag, noUsage: ledger.diag.noUsage + 1, reasons } }
}

export function attributed(ledger: Ledger): number {
  let total = ledger.main.usd + ledger.system.usd + ledger.folded.usd
  for (const row of Object.values(ledger.agents)) total += row.t.usd

  return total
}

/** Every token the ledger counted, from the model buckets. */
export function totalTally(ledger: Ledger): Tally {
  return Object.values(ledger.models).reduce(sumTally, ZERO)
}

/** Dollars the cache saved against paying the input price for every cached token. Writes are 5-minute. */
export function cacheNet(ledger: Ledger): number {
  let net = 0
  for (const [model, tally] of Object.entries(ledger.models)) {
    const price = priceFor(model)
    if (price === undefined) continue
    net += (tally.r * (price.in - price.r) - tally.w * (price.w5 - price.in)) / 1_000_000
  }

  return net
}

/** The ledger as a tree: `main` on top, each agent under its parent, subtotals rolled up. */
export type Node = {
  id: string
  row?: AgentRow
  own: Tally
  sub: Tally
  kids: Node[]
}

export function buildTree(ledger: Ledger): Node {
  const rows = Object.values(ledger.agents)
  const byParent = new Map<string, AgentRow[]>()
  for (const row of rows) {
    const home = row.parent !== undefined && row.parent !== row.id && ledger.agents[row.parent] !== undefined ? row.parent : 'main'
    byParent.set(home, [...(byParent.get(home) ?? []), row])
  }
  const seen = new Set<string>()
  const grow = (id: string, row?: AgentRow): Node => {
    seen.add(id)
    const kids = (byParent.get(id) ?? []).filter(kid => !seen.has(kid.id)).map(kid => grow(kid.id, kid))
    kids.sort((a, b) => b.sub.usd - a.sub.usd || (b.row?.last ?? 0) - (a.row?.last ?? 0))
    const own = row === undefined ? ledger.main : row.t
    const node: Node = { id, own, sub: kids.reduce((sum, kid) => sumTally(sum, kid.sub), own), kids }
    if (row !== undefined) node.row = row

    return node
  }
  const root = grow('main')
  // A cycle in the parent links leaves rows no walk reaches: hang them under main.
  const lost: Node[] = []
  for (const row of rows) {
    if (!seen.has(row.id)) lost.push(grow(row.id, row))
  }
  if (lost.length === 0) return root

  return { ...root, kids: [...root.kids, ...lost], sub: lost.reduce((sum, kid) => sumTally(sum, kid.sub), root.sub) }
}

// ---------------------------------------------------------------------------
// The check against the engine's own cost total
// ---------------------------------------------------------------------------

export type Check = {
  state: 'none' | 'settling' | 'ok' | 'warn' | 'bad'
  /** What the engine says it spent since the ledger began. */
  spent: number
  attributed: number
  /** `spent` less `attributed`: engine loops no turn event named, surcharges the table lacks, unknown models. */
  drift: number
  /** `attributed` over `spent`. */
  share: number
}

export function checkLedger(ledger: Ledger, engineUsd: number | undefined): Check {
  const mine = attributed(ledger)
  if (engineUsd === undefined || ledger.base === null) {
    return { state: 'none', spent: 0, attributed: mine, drift: 0, share: 1 }
  }
  const spent = Math.max(0, engineUsd - ledger.base)
  const drift = spent - mine
  const share = spent > 0 ? mine / spent : 1
  const size = Math.abs(drift)
  let state: Check['state'] = 'bad'
  if (anyBusy(ledger)) state = 'settling'
  else if (size <= Math.max(0.02, 0.05 * spent)) state = 'ok'
  else if (size <= Math.max(0.05, 0.15 * spent)) state = 'warn'

  return { state, spent, attributed: mine, drift, share }
}

// ---------------------------------------------------------------------------
// Rate-limit windows
// ---------------------------------------------------------------------------

export const SAMPLE_CAP = 24
const HOUR = 3_600_000
const MIN_SPAN = 10 * 60_000
const STALE = 30 * 60_000
const KEEP_EVERY = 5 * 60_000

/**
 * Adds a reading. A reading equal to the last one is kept only every five minutes.
 * A reading that fell by a point or more means the window reset: the old readings go.
 */
export function addSample(samples: readonly Sample[], at: number, pct: number): Sample[] {
  const last = samples[samples.length - 1]
  if (last === undefined) return [[at, pct]]
  if (pct < last[1] - 1) return [[at, pct]]
  if (pct === last[1] && at - last[0] < KEEP_EVERY) return [...samples]

  return [...samples, [at, pct] as Sample].slice(-SAMPLE_CAP)
}

export type Verdict = 'learning' | 'idle' | 'ok' | 'full' | 'stale'

export type Projection = {
  verdict: Verdict
  /** Points per hour over the last hour. */
  perHour?: number
  /** When the window reaches 100% at that pace (ms). */
  fullAt?: number
  /** Where the window stands at its reset at that pace. */
  atReset?: number
}

/** A straight-line projection from the readings. It is an estimate: other sessions move the same window. */
export function project(samples: readonly Sample[], now: number, resetsAt: number | undefined): Projection {
  const latest = samples[samples.length - 1]
  if (latest === undefined) return { verdict: 'learning' }
  const [at, pct] = latest
  if (resetsAt !== undefined && now > resetsAt) return { verdict: 'stale' }
  if (now - at > STALE) return { verdict: 'stale' }
  if (pct >= 100) return { verdict: 'full', fullAt: at, perHour: 0 }
  const inside = samples.filter(sample => sample[0] >= now - HOUR)
  const anchor = inside.length > 1 ? inside[0] : samples.length > 1 ? samples[samples.length - 2] : undefined
  if (anchor === undefined || at - anchor[0] < MIN_SPAN) return { verdict: 'learning' }
  const rate = Math.max(0, (pct - anchor[1]) / (at - anchor[0]))
  if (rate === 0) {
    return compact({ verdict: 'idle' as const, perHour: 0, atReset: resetsAt === undefined ? undefined : pct })
  }
  const fullAt = Math.max(now, at + (100 - pct) / rate)
  const atReset = resetsAt === undefined ? undefined : Math.min(100, pct + rate * (resetsAt - at))
  const isFull = resetsAt !== undefined && fullAt < resetsAt

  return compact({ verdict: isFull ? ('full' as const) : ('ok' as const), perHour: rate * HOUR, fullAt, atReset })
}

export function resetMs(limit: Limit): number | undefined {
  if (limit.resetsAt === undefined) return undefined
  const ms = Date.parse(limit.resetsAt)

  return Number.isNaN(ms) ? undefined : ms
}

export const projectionOf = (limit: Limit, now: number): Projection => project(limit.s, now, resetMs(limit))

export function latestPct(limit: Limit): number {
  return limit.s[limit.s.length - 1]?.[1] ?? 0
}

const ORDER = ['five_hour', 'seven_day', 'spend_limit']

/** Window kinds in the order the views draw them: 5h, 7d, spend, then any other. */
export function limitKinds(live: Live): string[] {
  const kinds = Object.keys(live.limits)

  return [...ORDER.filter(kind => kinds.includes(kind)), ...kinds.filter(kind => !ORDER.includes(kind)).sort()]
}

export function accountOf(kinds: readonly string[]): Account {
  if (kinds.includes('spend_limit')) return 'gateway'
  if (kinds.includes('five_hour') || kinds.includes('seven_day')) return 'subscription'

  return 'unknown'
}

// ---------------------------------------------------------------------------
// A measure: what `$.session.usage()` says now
// ---------------------------------------------------------------------------

export type UsageLike = {
  readonly startedAt?: number
  readonly context: {
    readonly tokens?: number
    readonly window: number
    readonly percent?: number
    readonly breakdown?: {
      readonly categories: readonly { readonly name: string; readonly tokens: number; readonly kind: string }[]
      readonly autoCompactThreshold?: number
    }
  }
  readonly rateLimits: readonly { readonly kind: string; readonly percentUsed: number; readonly resetsAt?: string }[]
  readonly cost?: { readonly usd: number }
}

const round1 = (n: number): number => Math.round(n * 10) / 10

function grown(ctx: Ctx, tokens: number | undefined): number {
  if (tokens === undefined || ctx.tokens === undefined) return ctx.growth
  const delta = tokens - ctx.tokens
  if (delta <= 0) return ctx.growth

  return ctx.growth === 0 ? delta : Math.round(ctx.growth * 0.7 + delta * 0.3)
}

function usedCats(
  categories: readonly { readonly name: string; readonly tokens: number; readonly kind: string }[],
): [string, number][] {
  return categories
    .filter(cat => cat.kind === 'used' && cat.tokens > 0)
    .map((cat): [string, number] => [cat.name, cat.tokens])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
}

export function applyMeasure(live: Live, usage: UsageLike, now: number): Live {
  const context = usage.context
  const found = context.breakdown
  const ctx: Ctx = compact({
    tokens: context.tokens,
    window: context.window,
    percent: context.percent,
    growth: grown(live.ctx, context.tokens),
    cats: found === undefined ? live.ctx.cats : usedCats(found.categories),
    threshold: found === undefined ? live.ctx.threshold : found.autoCompactThreshold,
  })
  const limits: Record<string, Limit> = {}
  for (const reading of usage.rateLimits) {
    const old = live.limits[reading.kind]
    const before = old?.s[old.s.length - 1]
    const s = addSample(old?.s ?? [], now, reading.percentUsed)
    const isMoved = old === undefined || s.length !== old.s.length || before?.[1] !== reading.percentUsed
    limits[reading.kind] = compact({
      s,
      resetsAt: reading.resetsAt ?? old?.resetsAt,
      d: isMoved && before !== undefined ? round1(reading.percentUsed - before[1]) : (old?.d ?? 0),
    })
  }
  const kinds = usage.rateLimits.map(reading => reading.kind)

  return compact({
    usd: usage.cost?.usd ?? live.usd,
    account: kinds.length === 0 ? live.account : accountOf(kinds),
    measures: live.measures + 1,
    at: now,
    ctx,
    limits,
  })
}

/**
 * Sets the ledger's key, its starting cost, and clears the footer's window. The base is the
 * engine's total less what the ledger already counted: a resume, or a mod enabled mid-session.
 */
export function settle(ledger: Ledger, key: number | undefined, engineUsd: number | undefined, isTurnEnd: boolean): Ledger {
  let next = ledger
  if (next.key === 0 && key !== undefined && key !== 0) next = { ...next, key }
  if (next.base === null && engineUsd !== undefined) next = { ...next, base: Math.max(0, engineUsd - attributed(next)) }
  if (isTurnEnd && next.win.agents !== 0) next = { ...next, win: { agents: 0 } }

  return next
}

export function turnsLeft(ctx: Ctx): number | undefined {
  if (ctx.tokens === undefined || ctx.threshold === undefined || ctx.growth <= 0) return undefined

  return Math.max(0, Math.floor((ctx.threshold - ctx.tokens) / ctx.growth))
}

/** Where auto-compaction runs, as a percentage of the window. */
export function compactAtPct(ctx: Ctx): number | undefined {
  if (ctx.threshold === undefined || ctx.window <= 0) return undefined

  return Math.round((ctx.threshold / ctx.window) * 100)
}

// ---------------------------------------------------------------------------
// Words: window states, the status entry, the footer
// ---------------------------------------------------------------------------

/** How serious a reading is. `ok` draws calm, `warn` and `bad` draw in a status color with a glyph and a word. */
export type Level = 'ok' | 'warn' | 'bad'

export const GLYPH: Readonly<Record<Level, string>> = { ok: '✓', warn: '▲', bad: '✖' }

/** The context window's level: warn from 80%, bad from 90% (the alert levels). */
export function ctxLevel(pct: number): Level {
  if (pct >= 90) return 'bad'
  if (pct >= 80) return 'warn'

  return 'ok'
}

/** One rate-limit window, ready to draw: its percent, level, pace words and reset time. */
export type WindowState = {
  pct: number
  level: Level
  /** `full ~16:40`, `full now`, `≈31% at reset`, `on pace`, `no growth`, `learning pace`, `reading is old`. */
  pace: string
  /** True when the pace says the window fills before it resets: draw the pace as a warning. */
  isFilling: boolean
  /** When it fills at this pace (ms), while that is before the reset. */
  fullAt?: number
  /** When the window resets (ms). */
  resets?: number
}

export function windowState(limit: Limit, now: number): WindowState {
  const pct = latestPct(limit)
  const proj = projectionOf(limit, now)
  const resets = resetMs(limit)
  const isFilling = proj.verdict === 'full' && proj.fullAt !== undefined && pct < 100
  let pace = 'learning pace'
  if (pct >= 100) pace = 'full now'
  else if (isFilling && proj.fullAt !== undefined) pace = `full ~${fmtClock(proj.fullAt)}`
  else if (proj.verdict === 'ok') pace = proj.atReset === undefined ? 'on pace' : `≈${fmtPct(proj.atReset)} at reset`
  else if (proj.verdict === 'idle') pace = 'no growth'
  else if (proj.verdict === 'stale') pace = 'reading is old'
  const level: Level = pct >= 90 ? 'bad' : pct >= 75 || isFilling ? 'warn' : 'ok'

  return compact({ pct, level, pace, isFilling, fullAt: isFilling ? proj.fullAt : undefined, resets })
}

/** One chip for the status entry: `5h 62%`, `5h 81% ▲`, `5h 62% ▲ full ~16:40`. */
export function windowChip(kind: string, limit: Limit, now: number): string {
  const state = windowState(limit, now)
  const mark = state.level === 'ok' ? '' : ` ${GLYPH[state.level]}`

  return `${windowName(kind)} ${fmtPct(state.pct)}${mark}${state.isFilling ? ` ${state.pace}` : ''}`
}

/** The one-line status entry: `ctx 41% · 5h 62% ▲ full ~16:40 · 7d 18% · $3.42 est.` Undefined while nothing is measured. */
export function statusLine(live: Live, spend: number | undefined, now: number): string | undefined {
  const parts: string[] = []
  const pct = live.ctx.percent
  if (pct !== undefined) {
    const level = ctxLevel(pct)
    parts.push(`ctx ${fmtPct(pct)}${level === 'ok' ? '' : ` ${GLYPH[level]}`}`)
  }
  for (const kind of limitKinds(live)) {
    const limit = live.limits[kind]
    if (limit !== undefined) parts.push(windowChip(kind, limit, now))
  }
  if (spend !== undefined) parts.push(`${fmtUsd(spend)} est.`)

  return parts.length === 0 ? undefined : parts.join(' · ')
}

export type FooterIn = {
  /** Dollars for the main loop's turn, undefined when its model has no price. */
  turnUsd: number | undefined
  out: number
  hit: number | undefined
  agentsUsd: number
  session: number
}

/** The line under an answer: `↳ $0.31 turn + $2.00 agents · $3.42 session (est.) · 4.2k out · 94% cached`. */
export function footerLine(f: FooterIn): string {
  const turn = f.turnUsd === undefined ? 'turn not priced' : `${fmtUsd(f.turnUsd)} turn`
  const agents = f.agentsUsd >= 0.005 ? ` + ${fmtUsd(f.agentsUsd)} agents` : ''
  const parts = [`${turn}${agents}`, `${fmtUsd(f.session)} session (est.)`, `${fmtTokens(f.out)} out`]
  if (f.hit !== undefined) parts.push(`${fmtRate(f.hit)} cached`)

  return `↳ ${parts.join(' · ')}`
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const CONTEXT_LEVELS = [80, 90]
const WINDOW_LEVELS = [75, 90]
const REARM = 5

const topLevel = (value: number, levels: readonly number[]): number =>
  levels.reduce((top, level) => (value >= level ? level : top), 0)

/** Whether a value crossed a new level, and the level to remember. A fall of 5 points re-arms the alert. */
function crossed(value: number, levels: readonly number[], held: number): { held: number; isFired: boolean } {
  const top = topLevel(value, levels)
  if (top > held) return { held: top, isFired: true }
  if (held > 0 && value < held - REARM) return { held: top, isFired: false }

  return { held, isFired: false }
}

export type AlertOut = { toasts: string[]; next: Record<string, number> }

/** The toasts a measure earns, and the alert memory after it. Numbers and times only. */
export function alertsFor(live: Live, now: number, held: Readonly<Record<string, number>>, costStep: number): AlertOut {
  const next: Record<string, number> = { ...held }
  const toasts: string[] = []
  const ctxPct = live.ctx.percent
  if (ctxPct !== undefined) {
    const step = crossed(ctxPct, CONTEXT_LEVELS, held['ctx'] ?? 0)
    next['ctx'] = step.held
    if (step.isFired) {
      const autoAt = compactAtPct(live.ctx)
      toasts.push(`Usage: context ${fmtPct(ctxPct)}.${autoAt === undefined ? '' : ` Auto-compaction near ${autoAt}%.`}`)
    }
  }
  for (const kind of limitKinds(live)) {
    const limit = live.limits[kind]
    if (limit === undefined) continue
    const pct = latestPct(limit)
    const step = crossed(pct, WINDOW_LEVELS, held[`win:${kind}`] ?? 0)
    next[`win:${kind}`] = step.held
    if (step.isFired) toasts.push(`Usage: ${windowName(kind)} window ${fmtPct(pct)}.`)
    const proj = projectionOf(limit, now)
    const resets = resetMs(limit)
    const wasFull = (held[`full:${kind}`] ?? 0) > 0
    if (proj.verdict === 'full' && proj.fullAt !== undefined && pct < 100) {
      next[`full:${kind}`] = 1
      if (!wasFull) {
        const until = resets === undefined ? '' : `, before reset ${fmtReset(resets, now)}`
        toasts.push(`Usage: ${windowName(kind)} window ${fmtPct(pct)}. At this pace it fills ~${fmtClock(proj.fullAt)}${until}.`)
      }
    } else if (wasFull) {
      next[`full:${kind}`] = 0
    }
  }
  if (costStep > 0 && live.usd !== undefined) {
    const level = Math.floor(live.usd / costStep)
    const before = held['cost'] ?? 0
    next['cost'] = level
    if (level > before) toasts.push(`Usage: session passed est. ${fmtUsd(level * costStep)}.`)
  }

  return { toasts, next }
}

// ---------------------------------------------------------------------------
// The /meter command
// ---------------------------------------------------------------------------

export const USAGE = '/meter [overview | models | agents | diag | refresh | status | reset | footer on | footer off]'

export type MeterCommand =
  | { kind: 'open' }
  | { kind: 'view'; view: ViewId }
  | { kind: 'refresh' }
  | { kind: 'status' }
  | { kind: 'reset' }
  | { kind: 'footer'; isOn: boolean }
  | { kind: 'bad'; usage: string }

const VIEWS: readonly string[] = ['overview', 'models', 'agents', 'diag']

/**
 * Every action of the pane has a command, so none needs a click: a desktop button
 * press can arrive as "not handled" on a surface that does not route it.
 */
export function parseMeterArgs(args: string): MeterCommand {
  const words = args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  const [first, second] = words
  if (words.length === 0 || (words.length === 1 && first === 'open')) return { kind: 'open' }
  if (words.length === 1 && first !== undefined && VIEWS.includes(first)) return { kind: 'view', view: first as ViewId }
  if (words.length === 1 && first === 'refresh') return { kind: 'refresh' }
  if (words.length === 1 && first === 'status') return { kind: 'status' }
  if (words.length === 1 && first === 'reset') return { kind: 'reset' }
  if (words.length === 2 && first === 'footer' && (second === 'on' || second === 'off')) {
    return { kind: 'footer', isOn: second === 'on' }
  }

  return { kind: 'bad', usage: USAGE }
}
