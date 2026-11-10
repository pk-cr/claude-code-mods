// session-pulse: which session needs you, which works, which is done.
//
// One writer, one atom. Hooks only note what happened (in module memory); the 1 s tick turns
// that into this session's status, beats its file, reads the other sessions' files and writes
// the `view` atom when what it shows changed. Times move in whole minutes, so an idle board
// redraws about once a minute.
//
// `$` calls: clock, state, store (`pin` only), session id/root/end, env HOME, fs read/write/list
// of ~/.claude/session-pulse/live only, agent.list, ui (open, resolve, toast), command.register,
// and, only with `/pulse pin on|test`, one app tool: mcp__ccd_sidebar__set_pinned on "self".

import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { Row, View } from '../types'
import {
  BUSY_BEAT_MS,
  IDLE_BEAT_MS,
  START,
  USAGE,
  bandWords,
  clean,
  closedFileOf,
  colorOf,
  fileOf,
  glyphOf,
  isPeerEntry,
  liveDirOf,
  liveFileName,
  parseArgs,
  parseFile,
  phaseMoves,
  projectName,
  settled,
  statusOf,
  stateWord,
  timeWords,
  turnBegins,
  turnEnds,
  viewOf,
} from './model'
import type { Ask, LiveFile, Self, Status } from './model'

const PANE = 'pulse'
const PANE_TITLE = 'Sessions'
/** The one app tool Pulse may call, only for this session ("self"). */
export const PIN_TOOL = 'mcp__ccd_sidebar__set_pinned'
const PEER_READ_MS = 2_000
const QUESTION_TOOLS: Readonly<Record<string, Ask['kind']>> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' }

const EMPTY_VIEW: View = {
  self: null,
  rows: [],
  folded: '',
  counts: { needs: 0, working: 0, failed: 0, ready: 0, idle: 0, offline: 0 },
  oldestNeed: null,
  pin: 'Pin while waiting: off',
}

const view = atom({ plugin: 'session-pulse', key: 'view' } as const, EMPTY_VIEW)

// ---------------------------------------------------------------------------
// Module memory: what the hooks saw. A reload starts it over; session.start fills it again.
// ---------------------------------------------------------------------------

type PinMemory = {
  isOn: boolean
  /** A `/pulse pin` this run: the saved choice read at the start no longer applies. */
  isChosen: boolean
  /** Whether Pulse pinned this session itself; it never unpins a pin it did not set. */
  isPinned: boolean
  isBusy: boolean
  /** Why pinning stopped, once it did. */
  stopped?: string
}

type Memory = {
  self: Self
  asks: Map<string, Ask>
  background: number
  home?: string
  selfId?: string
  /** The app's title for this session, from the prompt and start hooks. */
  title?: string
  /** A name set with `/pulse name`, kept in this session's own file. */
  label?: string
  project: string
  lastBeatAt: number
  lastPrint?: string
  lastReadAt: number
  isDirty: boolean
  cache: Map<string, { size: number; mtimeMs: number; file?: LiveFile }>
  writes: Promise<void>
  closed: Set<string>
  isTicking: boolean
  viewKey: string
  pin: PinMemory
  ready: Promise<void>
}

export function newMemory(): Memory {
  return {
    self: START,
    asks: new Map(),
    background: 0,
    project: 'session',
    lastBeatAt: 0,
    lastReadAt: Number.NEGATIVE_INFINITY,
    isDirty: true,
    cache: new Map(),
    writes: Promise.resolve(),
    closed: new Set(),
    isTicking: false,
    viewKey: '',
    pin: { isOn: false, isChosen: false, isPinned: false, isBusy: false },
    ready: Promise.resolve(),
  }
}

/** Started over at each register (a load or a reload), so nothing outlives the module's own life. */
let memory = newMemory()

async function guard(work: () => unknown): Promise<void> {
  try {
    await work()
  } catch {
    // Pulse only watches. A failed read or write costs one beat, never a turn or a tool call.
  }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

async function liveDir($: EngineInterface): Promise<string | undefined> {
  if (memory.home === undefined) {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') return undefined
    memory.home = home
  }
  return liveDirOf(memory.home)
}

/** Writes this session's own file, after any write before it. It is the one file Pulse writes. */
function writeOwn($: EngineInterface, dir: string, id: string, text: string, isClosing = false): Promise<void> {
  const name = liveFileName(id)
  if (name === undefined) return memory.writes
  memory.writes = memory.writes
    .then(async () => {
      if (!isClosing && memory.closed.has(id)) return
      await $.fs.write(`${dir}/${name}`, text)
    })
    .catch(() => undefined)
  return memory.writes
}

/** The name this session shows: its `/pulse name`, else the app title, else the project folder. */
function selfTitle(): string {
  return memory.label ?? memory.title ?? memory.project
}

/** Beats this session's file when due: every 2 s while working or waiting, every 5 s else, at once on a change. */
async function publish($: EngineInterface, status: Status, now: number): Promise<void> {
  await memory.ready
  const dir = await liveDir($)
  if (dir === undefined) return
  const id = await $.session.id()
  if (liveFileName(id) === undefined || memory.closed.has(id)) return
  // A /clear goes on under a new id with no end seen: the old file is closed too.
  const previous = memory.selfId
  if (previous !== undefined && previous !== id && !memory.closed.has(previous)) await closeFile($, dir, previous, now)
  memory.selfId = id
  const isBusy = status.state === 'needs' || status.state === 'working'
  const every = isBusy ? BUSY_BEAT_MS : IDLE_BEAT_MS
  const print = JSON.stringify([status.state, status.since, status.words, selfTitle(), memory.project])
  if (!memory.isDirty && print === memory.lastPrint && now - memory.lastBeatAt < every) return
  memory.isDirty = false
  memory.lastPrint = print
  memory.lastBeatAt = now
  const file = fileOf({ id, now, every, project: memory.project, title: selfTitle(), status })
  await writeOwn($, dir, id, JSON.stringify(memory.label === undefined ? file : { ...file, label: memory.label }))
}

/** Lists the live folder and reads the files that changed since the last look; never this session's own. */
async function readPeers($: EngineInterface, now: number): Promise<void> {
  if (now - memory.lastReadAt < PEER_READ_MS) return
  memory.lastReadAt = now
  const dir = await liveDir($)
  if (dir === undefined) return
  const own = memory.selfId === undefined ? undefined : liveFileName(memory.selfId)
  let entries: readonly FsEntry[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    // No folder yet: no session has published.
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isPeerEntry(entry, own, now)) continue
    seen.add(entry.name)
    const known = memory.cache.get(entry.name)
    if (known !== undefined && known.size === entry.size && known.mtimeMs === entry.mtimeMs) continue
    try {
      const file = parseFile(await $.fs.read(`${dir}/${entry.name}`))
      // A file caught mid-write reads as broken: it keeps what it said before.
      const isOwnName = file !== undefined && liveFileName(file.id) === entry.name
      memory.cache.set(entry.name, { size: entry.size, mtimeMs: entry.mtimeMs, file: isOwnName ? file : known?.file })
    } catch {
      // Gone between the listing and the read.
    }
  }
  for (const name of [...memory.cache.keys()]) if (!seen.has(name)) memory.cache.delete(name)
}

/** Writes the view only when what it shows changed. */
async function commitView($: EngineInterface, next: View): Promise<void> {
  const key = JSON.stringify(next)
  if (key === memory.viewKey) return
  memory.viewKey = key
  await update($, view, () => next)
}

/** The background agents still at work: a session whose turn ended with agents out is not idle. */
async function countBackground($: EngineInterface): Promise<void> {
  const agents = await $.agent.list()
  memory.background = agents.filter(agent => agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting').length
}

function pinLine(pin: PinMemory): string {
  if (pin.stopped !== undefined) return `Pin while waiting: stopped (${pin.stopped})`
  return pin.isOn ? 'Pin while waiting: on' : 'Pin while waiting: off'
}

async function tick($: EngineInterface): Promise<void> {
  if (memory.isTicking) return
  memory.isTicking = true
  try {
    const now = await $.clock.now()
    await guard(() => countBackground($))
    const status = statusOf(memory.self, memory.asks.values(), memory.background, now)
    await guard(() => publish($, status, now))
    await guard(() => readPeers($, now))
    const self: Row = {
      id: memory.selfId ?? 'self',
      title: selfTitle(),
      state: status.state,
      words: status.words,
      time: timeWords(status.state, status.since, now),
      isSelf: true,
    }
    const files = [...memory.cache.values()].flatMap(entry => (entry.file === undefined ? [] : [entry.file]))
    await guard(() => commitView($, viewOf({ self, files, selfId: memory.selfId, now, pin: pinLine(memory.pin) })))
    pinStep($, status.state === 'needs')
  } finally {
    memory.isTicking = false
  }
}

// ---------------------------------------------------------------------------
// Pin while waiting
// ---------------------------------------------------------------------------

/** What a pin call came to: done, or why not. */
export function pinOutcome(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return 'no answer'
  const one = result as { deny?: unknown; isError?: unknown; text?: unknown }
  if (typeof one.deny === 'string') return clean(one.deny, 60) || 'refused'
  if (one.isError === true) return clean(one.text, 60) || 'the app refused'
  return undefined
}

/** One pin or unpin of this session. Resolves to why it failed, or undefined. */
async function setPinned($: EngineInterface, pinned: boolean): Promise<string | undefined> {
  try {
    return pinOutcome(await $.tool.call({ tool: PIN_TOOL, session_id: 'self', pinned }))
  } catch (error) {
    return clean(error instanceof Error ? error.message : String(error), 60) || 'the call failed'
  }
}

/** Pins this session while it waits on you and unpins it after; one call at a time, never awaited by a hook. */
function pinStep($: EngineInterface, isWaiting: boolean): void {
  const pin = memory.pin
  if (pin.isBusy || pin.stopped !== undefined) return
  const want = pin.isOn && isWaiting
  if (want === pin.isPinned) return
  pin.isBusy = true
  void setPinned($, want).then(failure => {
    pin.isBusy = false
    if (failure === undefined) {
      pin.isPinned = want
      return
    }
    // The first reason stands: an ask seen by the check hook says more than the deny it caused.
    pin.stopped ??= failure
    pin.isOn = false
  })
}

/** `/pulse pin test`: pin, then unpin, and say what happened. */
async function pinTest($: EngineInterface): Promise<string> {
  const first = await setPinned($, true)
  if (first !== undefined) {
    memory.pin.stopped = first
    memory.pin.isOn = false
    return `Pinning does not work here: ${first}. Pin while waiting stays off.`
  }
  const second = await setPinned($, false)
  if (second !== undefined) return `This session was pinned, but unpinning failed: ${second}. Unpin it from the sidebar menu.`
  memory.pin.stopped = undefined
  return 'Pinning works: this session was pinned and unpinned. Turn it on with /pulse pin on.'
}

// ---------------------------------------------------------------------------
// Start, end and the file's own name
// ---------------------------------------------------------------------------

/** Marks a session's file closed (a mod cannot delete it): readers skip it. It keeps the name for a resume. */
async function closeFile($: EngineInterface, dir: string, id: string, now: number): Promise<void> {
  memory.closed.add(id)
  const file = closedFileOf({ id, now, project: memory.project, title: selfTitle() })
  await writeOwn($, dir, id, JSON.stringify(memory.label === undefined ? file : { ...file, label: memory.label }), true)
}

async function closeLive($: EngineInterface, id: string): Promise<void> {
  memory.selfId = undefined
  memory.lastPrint = undefined
  memory.isDirty = true
  const dir = await liveDir($)
  if (dir === undefined) return
  await closeFile($, dir, id, await $.clock.now())
}

/** At the start: the project, the saved pin choice, and a `/pulse name` back from this session's own file. */
async function startLive($: EngineInterface): Promise<void> {
  memory.project = projectName(await $.session.root())
  const saved = await $.store.get('pin')
  if (!memory.pin.isChosen) memory.pin.isOn = saved === true
  const dir = await liveDir($)
  const id = await $.session.id()
  const name = liveFileName(id)
  if (dir === undefined || name === undefined) return
  memory.selfId = id
  let before = ''
  try {
    before = await $.fs.read(`${dir}/${name}`)
  } catch {
    // A new session: no file yet.
  }
  const label = labelOf(before)
  if (label !== undefined && memory.label === undefined) memory.label = label
}

/** The `/pulse name` a file carries, if any. */
export function labelOf(text: string): string | undefined {
  try {
    const raw = JSON.parse(text) as { label?: unknown }
    const label = clean(raw.label, 60)
    return label === '' ? undefined : label
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function countsLine(view: View): string {
  const parts: string[] = []
  for (const state of ['needs', 'working', 'ready', 'failed'] as const) {
    const count = view.counts[state]
    if (count > 0) parts.push(`${glyphOf(state)} ${count} ${stateWord(state, count)}`)
  }
  return parts.length === 0 ? 'nothing else running' : parts.join(' · ')
}

// ---------------------------------------------------------------------------
// The mod
// ---------------------------------------------------------------------------

export const register: Register = on => {
  memory = newMemory()

  on('session.start', async ($, e, next) => {
    await guard(() =>
      $.command.register({
        name: 'pulse',
        description: 'Open the board of sessions (needs you, working, ready). /pulse next, /pulse name <label>, /pulse pin on|off|test',
      }),
    )
    // No turn runs at a start or a reload: a turn still marked as running is left over.
    memory.self = settled(memory.self, await $.clock.now())
    memory.asks.clear()
    memory.isDirty = true
    memory.ready = startLive($).catch(() => undefined)
    await guard(() => {
      $.clock.every(1000, () => {
        void tick($)
      })
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await guard(() => closeLive($, e.sessionId))

    return next(e)
  })

  // The app's title for this session rides on the prompt and start hooks.
  on('classic.UserPromptSubmit', ($, e, next) => {
    const title = clean(e.session_title, 60)
    if (title !== '' && title !== memory.title) {
      memory.title = title
      memory.isDirty = true
    }
    return next(e)
  })

  on('classic.SessionStart', ($, e, next) => {
    const title = clean(e.session_title, 60)
    if (title !== '') memory.title = title
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    memory.self = turnBegins(memory.self, e.turnId, await $.clock.now())
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain) memory.self = turnBegins(memory.self, e.turnId, await $.clock.now())
    let phase: 'thinking' | 'writing' | 'tool' = 'thinking'
    for await (const chunk of next(e)) {
      if (isMain && chunk.kind === 'text' && phase !== 'writing') {
        phase = 'writing'
        memory.self = phaseMoves(memory.self, 'writing')
      } else if (isMain && chunk.kind === 'tool') {
        phase = 'tool'
        memory.self = phaseMoves(memory.self, 'tool', chunk.name)
      } else if (isMain && chunk.kind === 'thinking' && phase !== 'thinking') {
        phase = 'thinking'
        memory.self = phaseMoves(memory.self, 'thinking')
      }
      yield chunk
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) memory.self = turnEnds(memory.self, e.reason, await $.clock.now())
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const before = memory.self
    memory.self = phaseMoves(memory.self, 'compacting')
    try {
      return await next(e)
    } finally {
      if (memory.self.phase === 'compacting') memory.self = phaseMoves(memory.self, before.phase ?? 'thinking', before.tool)
    }
  })

  // A question or a plan waits on the person from the moment it opens; any other tool only
  // when the permission check asks (below). Every ask ends when its call returns.
  on('tool.call', async ($, e, next) => {
    if (e.tool === PIN_TOOL) return next(e)
    const id = e.tool_use_id
    const kind = QUESTION_TOOLS[e.tool]
    if (kind !== undefined) memory.asks.set(id, { kind, since: await $.clock.now() })
    const isMainTool = e.agentId === undefined && memory.self.state === 'working'
    if (isMainTool) memory.self = phaseMoves(memory.self, 'tool', e.tool)
    try {
      return await next(e)
    } finally {
      memory.asks.delete(id)
      if (isMainTool && memory.self.phase === 'tool') memory.self = phaseMoves(memory.self, 'thinking')
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool === PIN_TOOL) {
      // Pulse's own pin must never put a dialog in front of the person: an ask here stops pinning.
      if (verdict.decision !== 'ask') return verdict
      memory.pin.stopped = 'the app asks before each pin'
      memory.pin.isOn = false
      return { decision: 'deny', reason: 'session-pulse does not pin when that needs your approval' }
    }
    const id = e.tool_use_id
    if (verdict.decision === 'ask' && id !== undefined && QUESTION_TOOLS[e.tool] === undefined) {
      memory.asks.set(id, { kind: 'permission', tool: e.tool, since: await $.clock.now() })
    }
    return verdict
  })

  on('classic.Elicitation', async ($, e, next) => {
    memory.asks.set(`elicit:${e.elicitation_id ?? e.mcp_server_name}`, { kind: 'input', tool: clean(e.mcp_server_name, 24), since: await $.clock.now() })
    return next(e)
  })

  on('classic.ElicitationResult', ($, e, next) => {
    memory.asks.delete(`elicit:${e.elicitation_id ?? e.mcp_server_name}`)
    return next(e)
  })

  on('command.run', { command: 'pulse' }, async ($, e) => {
    const asked = parseArgs(e.args)
    if (asked.kind === 'bad' || asked.kind === 'help') return { text: USAGE }
    if (asked.kind === 'open') {
      await $.ui.open({ id: PANE, title: PANE_TITLE })
      return { text: 'Sessions board opened.' }
    }
    if (asked.kind === 'next') {
      const need = (await read($, view)).oldestNeed
      const text = need === null ? 'No other session waits on you.' : `${need.title} needs you: ${need.words} (${need.time}).`
      $.ui.toast(text)
      return { text }
    }
    if (asked.kind === 'name') {
      memory.label = asked.label === '' ? undefined : asked.label
      memory.isDirty = true
      return { text: memory.label === undefined ? 'This session shows its app title again.' : `This session shows as "${memory.label}".` }
    }
    if (asked.mode === 'test') return { text: await pinTest($) }
    const isOn = asked.mode === 'on'
    memory.pin.isOn = isOn
    memory.pin.isChosen = true
    if (isOn) memory.pin.stopped = undefined
    await guard(() => $.store.set('pin', isOn))
    return { text: isOn ? 'Pin while waiting is on: a session that waits on you is pinned in the sidebar, then unpinned.' : 'Pin while waiting is off.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const shown = await read($, view)
    const line = (row: Row, tag?: string) => (
      <Box key={`row-${row.id}`} gap={1}>
        <Text color={colorOf(row.state)}>{glyphOf(row.state)}</Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end" bold={row.state === 'needs'} dimColor={row.state === 'offline'}>
            {row.title}
          </Text>
        </Box>
        {tag !== undefined && <Text dimColor>{tag}</Text>}
        <Text color={row.state === 'needs' ? 'warning' : row.state === 'failed' ? 'error' : undefined} dimColor={row.state !== 'needs' && row.state !== 'failed'} wrap="truncate-end">
          {row.words}
        </Text>
        <Text dimColor>{row.time}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box gap={2}>
          <Text bold>Sessions</Text>
          <Text dimColor>{countsLine(shown)}</Text>
        </Box>
        {shown.self !== null && line(shown.self, 'this session')}
        {shown.rows.length === 0 && <Text dimColor>No other session on this machine right now.</Text>}
        {shown.rows.map(row => line(row))}
        {shown.folded !== '' && <Text dimColor>{shown.folded}</Text>}
        <Text dimColor>/pulse next names the session that waited longest · {shown.pin}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const words = bandWords(await read($, view))
    if (words === undefined) return below
    const { Box, Text } = $.ui.resolve(e)
    const own = (
      <Box key="pulse-band" gap={2}>
        {words.lead !== undefined && (
          <Text color="warning" bold wrap="truncate-end">
            {words.lead}
          </Text>
        )}
        {words.parts.map(part => (
          <Text key={`part-${part}`} dimColor>
            {part}
          </Text>
        ))}
        <Text dimColor>/pulse</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {below}
        {own}
      </Box>
    )
  })
}
