// The pure part of Pulse: this session's state, the status file, the other sessions and the
// words and order the board shows. Nothing here touches `$`, so every rule is a plain test.

import type { Counts, PulseState, Row, View } from '../types'

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** A permission ask shows only after this long: an ask that auto mode settles at once never flashes. */
export const ASK_DELAY_MS = 2_000
/** A finished session reads `Ready` this long, then `Idle`. */
export const READY_MS = 30 * 60_000
/** Beats: every 2 s while working or waiting, every 5 s otherwise. */
export const BUSY_BEAT_MS = 2_000
export const IDLE_BEAT_MS = 5_000
/** A file with no beat for max(this, 3 beats) is offline. */
export const OFFLINE_MIN_MS = 20_000
/** A file older than this is never read: it is a session long gone. */
export const STALE_MS = 24 * 3_600_000
/** At most this many other sessions get a row; the rest are counted on one line. */
export const MAX_ROWS = 8
/** Longest title and status words kept, in characters. */
export const TITLE_CHARS = 60
export const WORDS_CHARS = 40

// ---------------------------------------------------------------------------
// This session
// ---------------------------------------------------------------------------

export type Phase = 'thinking' | 'writing' | 'tool' | 'compacting'
export type NeedKind = 'permission' | 'question' | 'plan' | 'input'

/** Something open that waits on the person. */
export type Ask = { kind: NeedKind; tool?: string; since: number }

/** This session as its own hooks saw it. `needs` is never stored: it comes from the open asks. */
export type Self = {
  state: 'working' | 'ready' | 'failed' | 'idle'
  /** When `state` began. */
  since: number
  /** The running main turn, from its first step to its end. */
  turnId?: string
  turnAt?: number
  phase?: Phase
  /** The tool the main loop runs, by name. */
  tool?: string
  /** Why it failed: `API error`, `Refused`. */
  detail?: string
}

export const START: Self = { state: 'idle', since: 0 }

/** A main turn begins (its first step, or `turn.start`). Already running: unchanged. */
export function turnBegins(self: Self, turnId: string, now: number): Self {
  if (self.state === 'working' && self.turnId === turnId) return self
  return { state: 'working', since: now, turnId, turnAt: now, phase: 'thinking' }
}

/** The main turn moves to another phase; a phase change outside a turn is ignored (a warm spawn's stray call). */
export function phaseMoves(self: Self, phase: Phase, tool?: string): Self {
  if (self.state !== 'working') return self
  if (self.phase === phase && self.tool === tool) return self
  return { ...self, phase, ...(tool === undefined ? { tool: undefined } : { tool }) }
}

/** How a main turn ended, as `turn.complete` says. */
export function turnEnds(self: Self, reason: 'answer' | 'aborted' | 'refusal' | 'error', now: number): Self {
  if (reason === 'answer') return { state: 'ready', since: now }
  if (reason === 'aborted') return { state: 'idle', since: now }
  return { state: 'failed', since: now, detail: reason === 'error' ? 'API error' : 'Refused' }
}

/** A start or a reload: no turn runs, so a turn still marked as running is left over from before. */
export function settled(self: Self, now: number): Self {
  return self.state === 'working' ? { state: 'idle', since: now } : self
}

/** The ask that has waited longest and is old enough to show, if any. Questions and plans show at once. */
export function shownAsk(asks: Iterable<Ask>, now: number): Ask | undefined {
  let oldest: Ask | undefined
  for (const ask of asks) {
    const isShown = ask.kind !== 'permission' || now - ask.since >= ASK_DELAY_MS
    if (!isShown) continue
    if (oldest === undefined || ask.since < oldest.since) oldest = ask
  }
  return oldest
}

/** The words for a phase of work. */
export function phaseWords(phase: Phase | undefined, tool: string | undefined): string {
  if (phase === 'writing') return 'Writing'
  if (phase === 'compacting') return 'Compacting'
  if (phase === 'tool' && tool !== undefined) return `Running ${toolLabel(tool)}`
  return 'Thinking'
}

/** The words for an ask. */
export function askWords(ask: Ask): string {
  if (ask.kind === 'question') return 'Answer a question'
  if (ask.kind === 'plan') return 'Review the plan'
  if (ask.kind === 'input') return ask.tool === undefined ? 'Input requested' : `Input for ${ask.tool}`
  return ask.tool === undefined ? 'Approve a tool' : `Approve ${toolLabel(ask.tool)}`
}

/** A tool's name as a person reads it: an MCP tool by its own name, without the server prefix. */
export function toolLabel(tool: string): string {
  const parts = tool.split('__')
  const name = tool.startsWith('mcp__') && parts.length >= 3 ? parts.slice(2).join('__') : tool
  return clean(name, 24)
}

/** What this session is, at `now`, for its own file and row. */
export type Status = { state: Exclude<PulseState, 'offline'>; since: number; words: string }

export function statusOf(self: Self, asks: Iterable<Ask>, background: number, now: number): Status {
  const ask = shownAsk(asks, now)
  if (ask !== undefined) return { state: 'needs', since: ask.since, words: askWords(ask) }
  const agents = background > 0 ? ` · ${background} agent${background === 1 ? '' : 's'}` : ''
  if (self.state === 'working') return { state: 'working', since: self.turnAt ?? self.since, words: phaseWords(self.phase, self.tool) + agents }
  if (self.state === 'failed') return { state: 'failed', since: self.since, words: `Failed · ${self.detail ?? 'error'}` }
  if (self.state === 'ready' && now - self.since < READY_MS) return { state: 'ready', since: self.since, words: `Ready${agents}` }
  // Background agents still running after the turn ended: the session is not idle.
  if (background > 0) return { state: 'working', since: self.since, words: `Agents running${agents}` }
  return { state: 'idle', since: self.since, words: 'Idle' }
}

// ---------------------------------------------------------------------------
// The status file
// ---------------------------------------------------------------------------

/** One session's file. Labels and times only: never a prompt, thinking or answer. */
export type LiveFile = {
  v: 1
  id: string
  beat: number
  every: number
  project: string
  title?: string
  state: Exclude<PulseState, 'offline'>
  since: number
  words: string
  closed?: true
}

const STATES: readonly LiveFile['state'][] = ['needs', 'working', 'failed', 'ready', 'idle']

export function liveDirOf(home: string): string {
  return `${home.replace(/\/+$/, '')}/.claude/session-pulse/live`
}

/** The file name for a session id; undefined for an id that could leave the folder. */
export function liveFileName(id: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? `${id}.json` : undefined
}

/** The last folder name of a path: what the project is called. */
export function projectName(root: string): string {
  const name = root.replace(/\/+$/, '').split('/').pop() ?? ''
  return clean(name, 40) || 'session'
}

/** Text from a file or a hook, made safe to draw: no control or direction characters, one line, cut to `max`. */
export function clean(text: unknown, max: number): string {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

export function fileOf(input: { id: string; now: number; every: number; project: string; title?: string; status: Status }): LiveFile {
  const title = clean(input.title, TITLE_CHARS)
  return {
    v: 1,
    id: input.id,
    beat: input.now,
    every: input.every,
    project: input.project,
    ...(title === '' ? {} : { title }),
    state: input.status.state,
    since: input.status.since,
    words: clean(input.status.words, WORDS_CHARS),
  }
}

export function closedFileOf(input: { id: string; now: number; project: string; title?: string }): LiveFile {
  const title = clean(input.title, TITLE_CHARS)
  return { v: 1, id: input.id, beat: input.now, every: IDLE_BEAT_MS, project: input.project, ...(title === '' ? {} : { title }), state: 'idle', since: input.now, words: 'Closed', closed: true }
}

/** Reads a file another session wrote; undefined for anything that is not one (a half write, junk). */
export function parseFile(text: string): LiveFile | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const one = raw as Record<string, unknown>
  const state = STATES.find(name => name === one.state)
  const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  if (one.v !== 1 || typeof one.id !== 'string' || liveFileName(one.id) === undefined) return undefined
  if (state === undefined || !isNumber(one.beat) || !isNumber(one.since) || !isNumber(one.every) || one.every <= 0) return undefined
  const title = clean(one.title, TITLE_CHARS)
  return {
    v: 1,
    id: one.id,
    beat: one.beat,
    every: Math.min(one.every, 60_000),
    project: clean(one.project, 40) || 'session',
    ...(title === '' ? {} : { title }),
    state,
    since: Math.min(one.since, one.beat),
    words: clean(one.words, WORDS_CHARS),
    ...(one.closed === true ? { closed: true as const } : {}),
  }
}

/** Whether a listed file is worth reading: another session's, not empty, not long gone. */
export function isPeerEntry(entry: { name: string; kind: string; size: number; mtimeMs: number }, own: string | undefined, now: number): boolean {
  return entry.kind === 'file' && entry.name.endsWith('.json') && entry.name !== own && entry.size > 0 && now - entry.mtimeMs < STALE_MS
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** The sort order: what needs the person first. */
const ORDER: readonly PulseState[] = ['needs', 'working', 'failed', 'ready', 'idle', 'offline']

/** A short span: `<1m`, `6m`, `1h 5m`, `3d`. Whole minutes, so a time changes at most once a minute. */
export function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d`
}

/** The time column for a state that began at `since`. */
export function timeWords(state: PulseState, since: number, now: number): string {
  const gone = span(now - since)
  if (state === 'needs') return `waited ${gone}`
  if (state === 'working') return gone
  if (state === 'idle' || state === 'offline') return gone === '<1m' ? 'now' : gone
  return gone === '<1m' ? 'just now' : `${gone} ago`
}

/** Whether the file has stopped beating. */
export function isOffline(file: LiveFile, now: number): boolean {
  return now - file.beat > Math.max(OFFLINE_MIN_MS, 3 * file.every)
}

/** Another session's row at `now`. A `ready` past READY_MS reads idle, as it would in its own row. */
export function peerRow(file: LiveFile, now: number): Row {
  const title = file.title ?? file.project
  if (isOffline(file, now)) return { id: file.id, title, state: 'offline', words: 'Offline', time: timeWords('offline', file.beat, now), isSelf: false }
  const isStale = file.state === 'ready' && now - file.since >= READY_MS
  const state: PulseState = isStale ? 'idle' : file.state
  return { id: file.id, title, state, words: isStale ? 'Idle' : file.words, time: timeWords(state, file.since, now), isSelf: false }
}

export function emptyCounts(): Counts {
  return { needs: 0, working: 0, failed: 0, ready: 0, idle: 0, offline: 0 }
}

/** Sorts rows: by state, then needs and working longest first, the rest newest first. */
export function sortRows(rows: readonly { row: Row; since: number }[]): Row[] {
  return [...rows]
    .sort((a, b) => {
      const byState = ORDER.indexOf(a.row.state) - ORDER.indexOf(b.row.state)
      if (byState !== 0) return byState
      const isOldestFirst = a.row.state === 'needs' || a.row.state === 'working'
      return isOldestFirst ? a.since - b.since : b.since - a.since
    })
    .map(one => one.row)
}

/** The line for rows left out: `+4 idle, 2 offline`. */
export function foldedWords(rows: readonly Row[]): string {
  if (rows.length === 0) return ''
  const counts = emptyCounts()
  for (const row of rows) counts[row.state] += 1
  const parts = ORDER.filter(state => counts[state] > 0).map(state => `${counts[state]} ${stateWord(state, counts[state])}`)
  return `+${parts.join(', ')}`
}

/** A state as a count says it: `2 need you`, `1 needs you`, `3 working`. */
export function stateWord(state: PulseState, count: number): string {
  if (state === 'needs') return count === 1 ? 'needs you' : 'need you'
  return state
}

/** The whole board at `now`: this session's row, the others sorted, the fold, the counts. */
export function viewOf(input: { self: Row | null; files: readonly LiveFile[]; selfId?: string; now: number; pin: string }): View {
  const seen = new Set<string>()
  const peers: { row: Row; since: number }[] = []
  for (const file of input.files) {
    if (file.closed === true || file.id === input.selfId || seen.has(file.id)) continue
    if (input.now - file.beat >= STALE_MS) continue
    seen.add(file.id)
    const row = peerRow(file, input.now)
    peers.push({ row, since: row.state === 'offline' ? file.beat : file.since })
  }
  const sorted = sortRows(peers)
  const counts = emptyCounts()
  for (const row of sorted) counts[row.state] += 1
  // Every session that needs you or works gets a row; idle and offline fill what room is left.
  const isActive = (row: Row): boolean => row.state !== 'idle' && row.state !== 'offline'
  const active = sorted.filter(isActive)
  const shown = active.length >= MAX_ROWS ? active : sorted.slice(0, MAX_ROWS)
  const left = sorted.filter(row => !shown.includes(row))
  return {
    self: input.self,
    rows: shown,
    folded: foldedWords(left),
    counts,
    oldestNeed: sorted.find(row => row.state === 'needs') ?? null,
    pin: input.pin,
  }
}

/** The glyph for a state: each a different shape, so colour never carries the meaning alone. */
export function glyphOf(state: PulseState): string {
  switch (state) {
    case 'needs':
      return '▲'
    case 'working':
      return '◐'
    case 'ready':
      return '✓'
    case 'failed':
      return '✕'
    case 'idle':
      return '○'
    case 'offline':
      return '◌'
  }
}

/** The theme colour for a state's glyph; theme keys follow light and dark by themselves. */
export function colorOf(state: PulseState): 'warning' | 'suggestion' | 'success' | 'error' | 'inactive' | 'subtle' {
  switch (state) {
    case 'needs':
      return 'warning'
    case 'working':
      return 'suggestion'
    case 'ready':
      return 'success'
    case 'failed':
      return 'error'
    case 'idle':
      return 'inactive'
    case 'offline':
      return 'subtle'
  }
}

/** The band's one line, or undefined when nothing else is going on. */
export function bandWords(view: View): { lead?: string; parts: string[] } | undefined {
  const counts = view.counts
  if (counts.needs + counts.working + counts.ready + counts.failed === 0) return undefined
  const parts: string[] = []
  for (const state of ['working', 'ready', 'failed'] as const) {
    if (counts[state] > 0) parts.push(`${glyphOf(state)} ${counts[state]} ${stateWord(state, counts[state])}`)
  }
  const need = view.oldestNeed
  if (need === null) return { parts }
  const others = counts.needs > 1 ? ` (+${counts.needs - 1})` : ''
  return { lead: `${glyphOf('needs')} ${clean(need.title, 32)} ${need.time}${others}`, parts }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export type PulseArgs =
  | { kind: 'open' }
  | { kind: 'next' }
  | { kind: 'name'; label: string }
  | { kind: 'pin'; mode: 'on' | 'off' | 'test' }
  | { kind: 'help' }
  | { kind: 'bad'; usage: string }

export const USAGE = [
  '/pulse — open the board of sessions',
  '/pulse next — name the session that has waited on you longest',
  '/pulse name <label> — what this session is called on the board (empty: the app title)',
  '/pulse pin on|off|test — pin this session in the sidebar while it waits on you',
].join('\n')

export function parseArgs(args: string): PulseArgs {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const [first, ...rest] = words
  if (first === undefined || first === 'open') return { kind: 'open' }
  if (first === 'next') return { kind: 'next' }
  if (first === 'help') return { kind: 'help' }
  if (first === 'name') return { kind: 'name', label: clean(rest.join(' '), TITLE_CHARS) }
  if (first === 'pin' && (rest[0] === 'on' || rest[0] === 'off' || rest[0] === 'test') && rest.length === 1) return { kind: 'pin', mode: rest[0] }
  return { kind: 'bad', usage: USAGE }
}
