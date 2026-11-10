import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentSpawnInput, EngineInterface, FsEntry, Register, RenderElement } from 'claude-code'

import {
  ACTIVITY_WORDS,
  ARCHETYPES,
  archetypeOf,
  arenaOn,
  gauntletOf,
  WALK_MS,
  activityColor,
  activityOf,
  avatarRaster,
  avatarSvg,
  contextBar,
  displayName,
  WINDOWS,
  buildingAlt,
  buildingRaster,
  buildingSvg,
  floorAlt,
  isBuildingMoving,
  numberLabels,
  officeAlt,
  officeRaster,
  officeSvg,
  roleOf,
  withVariants,
} from './office'
import type { Activity, BuildingFloor, KindSpend, Member, Role } from './office'

import type {
  AgentRow,
  AgentStatus,
  Conflict,
  LiveAgent,
  LiveCall,
  LiveFile,
  LiveLead,
  MainState,
  Outcome,
  PeerBand,
  PeerSession,
  PeerSpend,
  PendingRoute,
  Phase,
  Route,
  RouteBook,
  RouteCeiling,
  RouteEffort,
  RouteKind,
  RouteMode,
  RouterSettings,
  SelfInfo,
  SkillUse,
  Spend,
  TokenCounts,
  TrailStep,
  ViewPrefs,
} from '../types'

const PANE = 'agents'
const PANE_TITLE = 'Team'
/** The office Raster's key: what the frame timer repaints with `$.ui.blit`. */
const OFFICE_KEY = 'office'
/** The other sessions' building Raster: one picture, a storey each. */
const BUILDING_KEY = 'building'
/** The terminal's office repaint: four frames a second while anyone moves. */
const FRAME_TICK_MS = 250
/** The widest office: six desks a row. */
const OFFICE_MAX_COLUMNS = 224
const DEFAULT_WINDOW = 200_000
const VIEW_KEY = 'view'
const LAYOUTS: readonly ViewPrefs['layout'][] = ['both', 'office', 'cards']
const FINISHED_SHOWN = 6
const MAX_ROWS = 40
const MAX_SKILLS = 24
const MAX_ROUTES = 60
const TAIL_CHARS = 2000
const SCAN_EVERY = 6
const RECENT_END_MS = 3000
/** A finished agent that acts again was resumed: for this long a list that still calls it finished does not end it again. */
const RESUME_HOLD_MS = 10_000
/** How long after a walk starts the clock still moves: past the walk's end, with a tick to spare. */
const SETTLE_MS = WALK_MS + 2000
const MAX_FILES = 60
/** A card's trail of tool calls: kept, and shown. */
const TRAIL_KEPT = 5
const TRAIL_SHOWN = 4
const TRAIL_DETAIL_CHARS = 40
/** Tools counted apart on a card; any after these count as `other`. */
const MAX_TOOL_KINDS = 24
/** How much of an answer a card with details keeps and shows; without details, a line. */
const ANSWER_CHARS = 300
const DOING_CHARS = 90
const MAX_CONFLICTS = 20
const CONFLICTS_SHOWN = 3
/** An ask that settles faster than this (an auto mode, an allow rule) is never shown or toasted. */
const NEEDS_SHOWN_AFTER_MS = 2000
const LEARN_WINDOW = 50
const LEARN_MIN_RUNS = 10
const LEARN_STRUGGLE_RATE = 0.25
const MAX_OUTCOMES_PER_KIND = 100
const MAX_OUTCOMES_PER_SESSION = 200
const MAX_STORE_SESSIONS = 30
const OUTCOME_PREFIX = 'outcomes:'
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const LEARNED_KINDS = ['lookup', 'routine', 'careful', 'hard'] as const
/** Where each session publishes itself for the others, under the home folder: one small file per session. */
const LIVE_DIR = '.claude/agent-radar/live'
/** How often a session rewrites its file: while an agent or the Lead works, and while idle. */
const BUSY_BEAT_MS = 2000
const IDLE_BEAT_MS = 5000
/** How often the other sessions' files are listed and read. */
const PEER_READ_MS = 2000
/** A session with no heartbeat for this long (or three of its own beats) is closed: it is not listed. */
const GONE_AFTER_MS = 20_000
/** Other sessions' elapsed times move in steps of this much. */
const ELAPSED_STEP_MS = 5000
/** The other sessions are drawn again at most this often, unless one comes, goes, starts or stops work, or waits on you. */
const PEERS_REDRAW_MS = 4000
/** A file older than this is never read. A mod cannot delete one, so an old file stays on disk, unread. */
const LIVE_MAX_AGE_MS = 24 * 60 * 60_000
const LIVE_MAX_BYTES = 64 * 1024
const LIVE_AGENTS = 24
/** Finished agents the file keeps, newest first: more than the office draws (`FINISHED_SHOWN`), so a reader
 * that looks once after a wave of 8 (a gauntlet's) still finds every agent of it. Capped by `LIVE_AGENTS`. */
const LIVE_FINISHED = 16
const LIVE_TEXT = 40
const LIVE_DESCRIPTION = 80
const EXPANDED_KEPT = 20
/** How long an idle session keeps its dim floor, and how many other sessions get a floor: `/radar idle`, `/radar floors`. */
const DEFAULT_IDLE_HOURS = 2
const MAX_IDLE_HOURS = 168
const DEFAULT_FLOORS = 6
const MAX_FLOORS = 20
/** A card's task description: two lines at most. */
const DESCRIPTION_CHARS = 160
const NO_PEERS = 'No other session is publishing. A session shows here once it runs agent-radar 0.8.0 or later.'
/** A session id fit for a file name: no separator, no leading dot, so no path out of the folder. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const skills = atom({ plugin: 'agent-radar', key: 'skills' } as const, [])
const agents = atom({ plugin: 'agent-radar', key: 'agents' } as const, [])
const clockNow = atom({ plugin: 'agent-radar', key: 'now' } as const, 0)
const main = atom({ plugin: 'agent-radar', key: 'main' } as const, { model: '', phase: 'idle' })
const prefs = atom({ plugin: 'agent-radar', key: 'settings' } as const, { mode: 'auto', ceiling: 'raise' })
const routeBook = atom({ plugin: 'agent-radar', key: 'routes' } as const, { pending: [], byAgent: {} })
const spend = atom({ plugin: 'agent-radar', key: 'spend' } as const, {})
const conflicts = atom({ plugin: 'agent-radar', key: 'conflicts' } as const, [])
const outcomes = atom({ plugin: 'agent-radar', key: 'outcomes' } as const, [])
const storeKey = atom({ plugin: 'agent-radar', key: 'storeKey' } as const, '')
const viewPrefs = atom({ plugin: 'agent-radar', key: 'view' } as const, {
  layout: 'both',
  labels: true,
  motion: true,
  details: true,
  sessions: true,
})
const peers = atom({ plugin: 'agent-radar', key: 'peers' } as const, [])
const peerBand = atom({ plugin: 'agent-radar', key: 'peerBand' } as const, { sessions: 0, agents: 0, waiting: [] })
const selfInfo = atom({ plugin: 'agent-radar', key: 'self' } as const, { expanded: [] })

// ---------------------------------------------------------------------------
// Pure helpers. They are exported so the tests can reach them.
// ---------------------------------------------------------------------------

export type CallLike = { readonly tool: string; readonly [argument: string]: unknown }

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path

/**
 * A shell command without the `cd <folder> &&` (or `;`) it starts with: the part worth reading.
 * A command that is only a `cd` stays as it is.
 */
export function withoutCd(command: string): string {
  const rest = command.replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/, '')
  return rest.trim() === '' ? command : rest
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

const MODEL_ID = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/

/** `claude-sonnet-5-5` is `sonnet 5.5`; an alias stays; an unknown id loses `claude-`. */
export function shortModel(model: string | undefined): string {
  if (model === undefined || model === '') return ''
  const parts = MODEL_ID.exec(model)
  if (parts === null) return model.replace(/^claude-/, '')
  const [, family, major, minor] = parts
  return minor === undefined ? `${family} ${major}` : `${family} ${major}.${minor}`
}

/** `12s`, `1m 05s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  if (hours > 0) return `${hours}h ${two(minutes)}m`
  if (minutes > 0) return `${minutes}m ${two(seconds)}s`
  return `${seconds}s`
}

/** One line on what a tool call does, for the card's `↳` row. */
export function describeCall(call: CallLike): string {
  switch (call.tool) {
    case 'Read':
      return `Reading ${base(str(call.file_path))}`
    case 'Edit':
      return `Editing ${base(str(call.file_path))}`
    case 'Write':
      return `Writing ${base(str(call.file_path))}`
    case 'NotebookEdit':
      return `Editing ${base(str(call.notebook_path))}`
    case 'Bash': {
      const said = oneLine(str(call.description))
      return said !== '' ? clip(said, 80) : `Running ${clip(withoutCd(oneLine(str(call.command))), 70)}`
    }
    case 'Grep':
      return `Searching "${clip(oneLine(str(call.pattern)), 50)}"`
    case 'Glob':
      return `Finding ${clip(oneLine(str(call.pattern)), 60)}`
    case 'WebFetch': {
      const url = str(call.url)
      try {
        return `Fetching ${new URL(url).host}`
      } catch {
        return `Fetching ${clip(url, 60)}`
      }
    }
    case 'WebSearch':
      return `Searching the web: ${clip(oneLine(str(call.query)), 60)}`
    case 'Skill':
      return `Loading skill ${str(call.skill)}`
    case 'Agent':
    case 'Task':
      return `Delegating: ${clip(oneLine(str(call.description)), 60)}`
    default: {
      if (call.tool.startsWith('mcp__')) {
        const [, server = '', ...rest] = call.tool.split('__')
        return `Calling ${server} · ${rest.join('__')}`
      }
      return `Using ${call.tool}`
    }
  }
}

/**
 * The Lead runs the gauntlet's last step, `winner`: the colosseum has a few seconds left. The skill calls the script `G`,
 * and a Bash call has no memory, so the command either holds the script's path (`python3 ".../gauntlet.py" winner`) or
 * names it first, as a function (`G() { python3 ".../gauntlet.py" "$@"; }; G winner`) or a variable (`G="python3 .../gauntlet.py"; $G winner`).
 * Only the command's words are read, never kept.
 */
export function isGauntletClose(call: CallLike): boolean {
  if (call.tool !== 'Bash') return false
  const command = str(call.command)
  if (!command.includes('gauntlet.py')) return false
  if (/gauntlet\.py["']?\s+winner\b/.test(command)) return true
  const names = new Set<string>()
  for (const found of command.matchAll(/(?:^|[;&|\n(]\s*)(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{[^}]*gauntlet\.py/g)) names.add(found[1] ?? found[2] ?? '')
  for (const found of command.matchAll(/(?:^|[;&|\n(]\s*)([A-Za-z_]\w*)=[^;&|\n]*gauntlet\.py/g)) {
    const name = found[1] ?? ''
    for (const spelled of [`$${name}`, `"$${name}"`, `\${${name}}`, `"\${${name}}"`]) names.add(spelled)
  }
  names.delete('')
  return command.split(/[;&|\n(]+/).some(part => {
    const [first, second] = part.trim().split(/\s+/)
    return first !== undefined && second === 'winner' && names.has(first)
  })
}

/** The short argument a card shows after a tool's name: a file, a pattern, a command, a host. */
export function callDetail(call: CallLike): string {
  switch (call.tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return base(str(call.file_path))
    case 'NotebookEdit':
      return base(str(call.notebook_path))
    case 'Bash': {
      const said = oneLine(str(call.description))
      return clip(said !== '' ? said : withoutCd(oneLine(str(call.command))), 60)
    }
    case 'Grep':
    case 'Glob':
      return clip(oneLine(str(call.pattern)), 50)
    case 'WebFetch': {
      const url = str(call.url)
      try {
        return new URL(url).host
      } catch {
        return clip(url, 50)
      }
    }
    case 'WebSearch':
      return clip(oneLine(str(call.query)), 50)
    case 'Skill':
      return str(call.skill)
    case 'Agent':
    case 'Task':
      return clip(oneLine(str(call.description)), 50)
    default: {
      if (call.tool.startsWith('mcp__')) {
        const [, server = '', ...rest] = call.tool.split('__')
        return `${server} · ${rest.join('__')}`
      }
      return ''
    }
  }
}

const isEnded = (status: AgentStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'killed'

const isTerminalPhase = (phase: Phase): boolean =>
  phase === 'done' || phase === 'failed' || phase === 'stopped'

/** The phase an ended or idle status stands for. */
function endPhase(status: AgentStatus): Phase {
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'stopped'
  return 'done'
}

export type Glyph = { glyph: string; color?: string }

export function statusGlyph(status: AgentStatus): Glyph {
  switch (status) {
    case 'running':
      return { glyph: '●', color: 'success' }
    case 'waiting':
      return { glyph: '◐', color: 'warning' }
    case 'idle':
      return { glyph: '○', color: 'warning' }
    case 'pending':
      return { glyph: '…', color: 'warning' }
    case 'failed':
      return { glyph: '✗', color: 'error' }
    case 'killed':
      return { glyph: '■', color: 'warning' }
    case 'completed':
      return { glyph: '✓' }
  }
}

function defined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out as Partial<T>
}

type RowChange = Partial<AgentRow> | ((row: AgentRow) => Partial<AgentRow>)

/**
 * Patches the row of `id`. It never creates one, and it hands back the same list
 * when the patch changes nothing, so a caller can skip the write.
 */
export function patchRows(list: AgentRow[], id: string, change: RowChange): AgentRow[] {
  const index = list.findIndex(row => row.id === id)
  const row = list[index]
  if (row === undefined) return list
  const patch = typeof change === 'function' ? change(row) : change
  const keys = Object.keys(patch) as (keyof AgentRow)[]
  if (keys.every(key => row[key] === patch[key])) return list
  const next = list.slice()
  next[index] = defined({ ...row, ...patch }) as AgentRow
  return next
}

/**
 * A finished agent that steps or calls a tool again was resumed (SendMessage): it is back at its
 * desk, with its record kept. A stopped or failed one is not revived by events: the list says.
 */
export function reviving(row: AgentRow, now: number): Partial<AgentRow> {
  return row.status === 'completed' ? { status: 'running', endedAt: undefined, needs: undefined, resumedAt: now } : {}
}

function prune(list: AgentRow[]): AgentRow[] {
  const over = list.length - MAX_ROWS
  if (over <= 0) return list
  const oldest = list
    .filter(row => isEnded(row.status))
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    .slice(0, over)
    .map(row => row.id)
  return list.filter(row => !oldest.includes(row.id))
}

/** The lowest desk no live agent holds. Desk 0 is the Lead's. */
export function freeSeat(rows: readonly AgentRow[]): number {
  const taken = new Set(rows.filter(row => !isEnded(row.status) && row.seat !== undefined).map(row => row.seat))
  let seat = 1
  while (taken.has(seat)) seat += 1
  return seat
}

/** Creates the row of `id`, or patches it when a timer tick made it first. */
export function upsertRow(
  list: AgentRow[],
  id: string,
  now: number,
  fields: Partial<AgentRow>,
): AgentRow[] {
  if (list.some(row => row.id === id)) return patchRows(list, id, defined(fields))
  const row: AgentRow = {
    id,
    type: 'agent',
    description: '',
    status: 'running',
    phase: 'starting',
    doing: 'starting…',
    tools: 0,
    startedAt: now,
    background: false,
    fork: false,
    seat: freeSeat(list),
    ...defined(fields),
  }
  return prune([...list, row])
}

/** Brings the rows in line with `$.agent.list()`. It creates rows for agents it never saw. */
export function reconcile(
  rows: AgentRow[],
  listed: readonly AgentInfo[],
  now: number,
): AgentRow[] {
  let next = rows
  for (const agent of listed) {
    const row = next.find(one => one.id === agent.id)
    const status = agent.status
    if (row === undefined) {
      const ended = isEnded(status)
      // Found already done, it never sat at a desk here: it is in the lounge at once, with no walk.
      const since = ended ? now - WALK_MS : now
      next = upsertRow(next, agent.id, since, {
        type: agent.type,
        name: agent.name,
        description: agent.description,
        parentId: agent.parentId,
        status,
        phase: ended || status === 'idle' ? endPhase(status) : status === 'pending' ? 'starting' : 'thinking',
        doing: ended ? 'finished' : 'in progress',
        endedAt: ended ? since : undefined,
      })
      continue
    }
    // A row that just ended can still read as running in the list for a moment.
    const isJustEnded = row.endedAt !== undefined && now - row.endedAt < RECENT_END_MS
    // ...and a row just resumed can still read as finished: its steps and calls say otherwise.
    const isJustResumed = row.resumedAt !== undefined && now - row.resumedAt < RESUME_HOLD_MS
    const patch: Partial<AgentRow> = {}
    if (!(isJustEnded && !isEnded(status)) && !(isJustResumed && isEnded(status))) {
      patch.status = status
      patch.endedAt = isEnded(status) ? (row.endedAt ?? now) : undefined
      if (isEnded(status) || status === 'idle') patch.phase = endPhase(status)
      else if (isTerminalPhase(row.phase)) patch.phase = status === 'pending' ? 'starting' : 'thinking'
    }
    if (agent.type !== row.type) patch.type = agent.type
    if (agent.parentId !== undefined) patch.parentId = agent.parentId
    if (agent.name !== undefined) patch.name = agent.name
    if (row.description.trim() === '' && agent.description !== '') patch.description = agent.description
    next = patchRows(next, agent.id, patch)
  }
  return next
}

/**
 * Notes one skill sighting. The first sighting after a turn ended drops that turn's
 * skills. A skill that was only thought of becomes invoked when a call loads it.
 */
export function recordSkill(
  list: SkillUse[],
  name: string,
  how: SkillUse['how'],
  by?: string,
): SkillUse[] {
  const live = list.some(skill => skill.isFinal) ? list.filter(skill => !skill.isFinal) : list
  const index = live.findIndex(skill => skill.name === name)
  const known = live[index]
  if (known === undefined) {
    return [...live, defined({ name, how, by, isFinal: false }) as SkillUse].slice(-MAX_SKILLS)
  }
  const isUpgrade = how === 'invoked' && known.how !== 'invoked'
  const isNamed = by !== undefined && known.by === undefined
  if (!isUpgrade && !isNamed) return live
  const next = live.slice()
  next[index] = defined({ ...known, how: isUpgrade ? 'invoked' : known.how, by: known.by ?? by }) as SkillUse
  return next
}

export type SkillMatcher = { name: string; needles: string[]; pattern: RegExp }

const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * One matcher per known skill name. Three spellings count as a mention: `/name`,
 * `skill name` (also `skill: name`, `skills/name`) and `name skill`. A bare word
 * does not count, or `run` and `loop` would light up all the time.
 */
export function buildMatchers(names: readonly string[]): SkillMatcher[] {
  const matchers: SkillMatcher[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const colon = name.indexOf(':')
    const forms = [name, ...(colon > 0 ? [name.slice(colon + 1)] : [])].filter(form => form.length >= 4)
    if (forms.length === 0) continue
    const alternatives = `(?:${forms.map(escapePattern).join('|')})`
    const quote = '["\'`]?'
    const pattern = new RegExp(
      `(?:^|[\\s("'\`])/${alternatives}(?![\\w\\-/.])` +
        `|\\bskills?[:/\\s]+${quote}${alternatives}(?![\\w-])` +
        `|(?:^|[^\\w-])${alternatives}${quote}\\s+skill\\b`,
      'i',
    )
    matchers.push({ name, needles: forms.map(form => form.toLowerCase()), pattern })
  }
  return matchers
}

export function findMentions(text: string, matchers: readonly SkillMatcher[]): string[] {
  if (text === '') return []
  const lower = text.toLowerCase()
  const found: string[] = []
  for (const matcher of matchers) {
    if (!matcher.needles.some(needle => lower.includes(needle))) continue
    if (matcher.pattern.test(text)) found.push(matcher.name)
  }
  return found
}

// ---------------------------------------------------------------------------
// Routing. It picks a model and an effort for a subagent from what the subagent
// is asked to do. Local rules only: the prompt is read by the patterns below and
// goes nowhere else. No `$` call is made to decide.
// ---------------------------------------------------------------------------

const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const
type ModelTier = (typeof MODEL_TIERS)[number]
const EFFORT_LEVELS: readonly RouteEffort[] = ['low', 'medium', 'high', 'xhigh']

/** The model family an id or alias names, or undefined for one the router does not know. */
export function tierOf(model: string | undefined): ModelTier | undefined {
  const lower = (model ?? '').toLowerCase()
  return MODEL_TIERS.find(tier => lower.includes(tier))
}

// The router sends agents to Sonnet or Opus only. Haiku sits below the
// floor and Fable (any family outside MODEL_TIERS) above the list: neither is picked, inherited
// from the session or kept from the call. Haiku stays in MODEL_TIERS so old run records still read.
const MIN_TIER: ModelTier = 'sonnet'
const atFloor = (tier: ModelTier): ModelTier => (tierRank(tier) < tierRank(MIN_TIER) ? MIN_TIER : tier)
const isBlockedModel = (model: string | undefined): boolean => {
  if (model === undefined) return false
  const tier = tierOf(model)
  return tier === undefined || tierRank(tier) < tierRank(MIN_TIER)
}
/** The allowed tier nearest a blocked model: the floor for one below it, Opus for one above (Fable). */
const nearestAllowed = (model: string): ModelTier => (tierOf(model) === undefined ? 'opus' : MIN_TIER)

const tierRank = (tier: ModelTier): number => MODEL_TIERS.indexOf(tier)
const effortRank = (level: string | undefined): number => EFFORT_LEVELS.findIndex(one => one === level)

type Signal = { label: string; pattern: RegExp }

// A quality gate. "verify" alone is left out: implementation briefs end with "verify the tests
// pass" all the time. "auditable" is not an audit.
const REVIEW_CUE = /\b(?:review|audit(?:s|ing|ed)?|critique|verification|adversarial|red[- ]team)\b/

/** Cues of a task that needs real reasoning. Each pattern counts once. */
const HARD_SIGNALS: readonly Signal[] = [
  { label: 'root cause', pattern: /\b(?:root[- ]?cause|diagnos\w*|debug\w*|race condition|deadlock|memory leak|flaky)\b/ },
  { label: 'design', pattern: /\b(?:architect\w*|trade-?offs?|rfc|design (?:a|an|the|doc)\b)/ },
  { label: 'security', pattern: /\b(?:security|vulnerab\w*|threat model|exploit|injection)\b/ },
  { label: 'review', pattern: REVIEW_CUE },
  { label: 'refactor', pattern: /\b(?:refactor\w*|migrat\w*|rewrite)\b/ },
  { label: 'performance', pattern: /\b(?:optimi[sz]\w*|performance|bottleneck|profil\w*)\b/ },
  { label: 'correctness', pattern: /\b(?:prove|proof|invariant|correctness|algorithm|concurren\w*|distributed)\b/ },
  { label: 'investigation', pattern: /\b(?:why (?:does|is|do|did|are)|figure out why|investigate)\b/ },
]

/** Cues of a task that only reads and reports. */
const LOOKUP_SIGNALS: readonly Signal[] = [
  {
    label: 'find',
    pattern: /\b(?:find|locate|list|enumerate|where (?:is|are|does)|which (?:files?|functions?|modules?|tests?)|grep|search for|look ?up|inventory)\b/,
  },
  { label: 'survey', pattern: /\b(?:summari[sz]e|overview|survey|map out|outline)\b/ },
]

// "read-only", or "do not edit, create or delete": the whole negated list, so that a verb
// after the first one ("do not modify or write") does not read as a write.
const NO_WRITE = 'modify|modifying|edit|editing|write|writing|change|changing|touch|touching|delete|deleting|create|creating|commit|committing'
const NO_WRITE_JOIN = '(?:\\s*,\\s*(?:(?:or|and)\\s+)?|\\s+(?:or|and)\\s+|\\s*/\\s*)'
const READ_ONLY = new RegExp(
  `\\bread[- ]only\\b|\\b(?:do not|don't|never|without)\\s+(?:${NO_WRITE})\\b(?:${NO_WRITE_JOIN}(?:${NO_WRITE})\\b)*`,
)
const READ_ONLY_EVERY = new RegExp(READ_ONLY.source, 'g')
const WRITE_VERB = /\b(?:implement|add|create|write|edit|modify|fix|update|change|rename|delete|remove|generate|refactor|migrate|commit|push|install)\b/
const DEEP_ASK = /\b(?:think (?:hard|carefully|deeply)|ultrathink|very thorough|maximum effort|take your time)\b/
const EASY_ASK = /\b(?:typo|one[- ]liner|trivial(?:ly)?|bump (?:the )?version|reformat|lint fix)\b/
// Judgment work is never a plain lookup, even when it only reads: research, compare, evaluate.
const JUDGMENT = /\b(?:research\w*|compare|comparison|evaluat\w*|assess\w*|recommend\w*|synthesi[sz]\w*|critique|judge|weigh|analy[sz]\w*|argue|justify)\b/
// A literature review is research, not a code review.
const LITERATURE_REVIEW = /\b(?:literature|lit\.?)\s+reviews?\b/g
const FILE_PATH = /[\w.-]+\/[\w./-]+\.\w{1,6}\b/g
// Many files named is a broad task. The prompt's length is not a cue: a long brief makes a task clearer, not harder.
const BROAD_FILES = 6
const ASK_HEAD = 1200
const ASK_TAIL = 600
/** `[difficulty: hard]`: the main model's own rating of the task, the strongest signal there is. */
const DIFFICULTY_TAG = /\[\s*difficulty\s*:\s*(lookup|routine|careful|hard|deep)\s*\]/i
const TAG_SCAN_CHARS = 400

/** The words the rules read: the description, and the start and end of a long prompt. */
function askText(input: Pick<AgentSpawnInput, 'description' | 'prompt'>): string {
  const { prompt } = input
  const sample =
    prompt.length > ASK_HEAD + ASK_TAIL ? `${prompt.slice(0, ASK_HEAD)}\n${prompt.slice(-ASK_TAIL)}` : prompt
  return `${input.description}\n${sample}`.toLowerCase()
}

export type Verdict = {
  kind: Exclude<RouteKind, 'kept'>
  tier: ModelTier
  effort: RouteEffort
  why: string
}

const TAGGED: Record<string, Omit<Verdict, 'why'>> = {
  lookup: { kind: 'lookup', tier: 'haiku', effort: 'medium' },
  routine: { kind: 'routine', tier: 'sonnet', effort: 'medium' },
  careful: { kind: 'careful', tier: 'sonnet', effort: 'high' },
  hard: { kind: 'hard', tier: 'opus', effort: 'high' },
  deep: { kind: 'hard', tier: 'opus', effort: 'xhigh' },
}

/**
 * The main model's own rating, when it put one in the description or the start of the prompt:
 * `[difficulty: lookup | routine | careful | hard | deep]`.
 */
export function readDifficultyTag(input: Pick<AgentSpawnInput, 'description' | 'prompt'>): Verdict | undefined {
  const found = DIFFICULTY_TAG.exec(`${input.description}\n${input.prompt.slice(0, TAG_SCAN_CHARS)}`)
  const level = found?.[1]?.toLowerCase()
  const verdict = level === undefined ? undefined : TAGGED[level]
  return level === undefined || verdict === undefined ? undefined : { ...verdict, why: `tagged: ${level}` }
}

/**
 * Reads the instructions and says what the task asks for. A difficulty tag wins; the cues
 * below decide without one.
 * `lookup` finds and reports, with no judgment: a light model, low effort (the middle model
 * at low effort when it spans many files, as the light model takes no effort setting).
 * `routine` is a clear job, research and review included: the middle model, medium effort.
 * `careful` has two hard cues: the middle model, high effort.
 * `hard` has three or more: the strongest model, high effort, or xhigh when asked to think hard.
 */
export function classifyTask(
  input: Pick<AgentSpawnInput, 'subagentType' | 'description' | 'prompt'>,
): Verdict {
  const tagged = readDifficultyTag(input)
  if (tagged !== undefined) return tagged

  const text = askText(input)
  const type = input.subagentType.toLowerCase()
  const isPlan = type === 'plan'
  const isExplore = type === 'explore'
  const isReadOnly = READ_ONLY.test(text)
  const isWrite = WRITE_VERB.test(text.replace(READ_ONLY_EVERY, ' '))
  const isJudgment = JUDGMENT.test(text)
  const isBroad = (text.match(FILE_PATH)?.length ?? 0) >= BROAD_FILES
  const isDeep = DEEP_ASK.test(text)
  const isEasy = EASY_ASK.test(text)
  const hardText = text.replace(LITERATURE_REVIEW, ' ')
  const hard = HARD_SIGNALS.filter(signal => signal.pattern.test(hardText)).map(signal => signal.label)
  const find = LOOKUP_SIGNALS.filter(signal => signal.pattern.test(text)).map(signal => signal.label)

  const difficulty = hard.length + (isPlan ? 2 : 0) + (isBroad ? 1 : 0) + (isDeep ? 2 : 0)
  const hardCues = [
    ...(isPlan ? ['Plan'] : []),
    ...hard,
    ...(isDeep ? ['asked to think hard'] : []),
    ...(isBroad ? ['many files'] : []),
  ]
  const lookupCues = [
    ...(isExplore ? ['Explore'] : []),
    ...(isReadOnly ? ['read-only'] : []),
    ...find,
    ...(isBroad ? ['many files'] : []),
  ]
  const said = (kind: string, cues: readonly string[]): string => `${kind}: ${cues.slice(0, 3).join(', ')}`

  if (difficulty >= 3) {
    const effort: RouteEffort = difficulty >= 5 || isDeep ? 'xhigh' : 'high'
    return { kind: 'hard', tier: 'opus', effort, why: said('hard', hardCues) }
  }
  // A task whose description names a review, audit or verification is a quality gate: it gets
  // care on that cue alone. The prompt's own mentions ("review the literature") do not count here.
  const isReviewTask = REVIEW_CUE.test(input.description.toLowerCase().replace(LITERATURE_REVIEW, ' '))
  if (difficulty === 2 || isReviewTask) {
    return { kind: 'careful', tier: 'sonnet', effort: 'high', why: said('careful', hardCues) }
  }
  // A lookup is retrieval only: no hard cue, no judgment, no write.
  const lookupScore = (isExplore ? 2 : 0) + (isReadOnly ? 2 : 0) + find.length
  const isPlainRead = hard.length === 0 && !isPlan && !isDeep && !isWrite && !isJudgment
  if (isPlainRead && lookupScore >= 2) {
    // Haiku at medium: at low effort it skips searches and checks (Anthropic's effort guidance).
    return { kind: 'lookup', tier: 'haiku', effort: 'medium', why: said('lookup', lookupCues) }
  }
  // A small, clear change starts on the light model; the rest of routine work on the middle one.
  return {
    kind: 'routine',
    tier: isEasy ? 'haiku' : 'sonnet',
    effort: 'medium',
    why: isEasy ? 'routine: small change' : isJudgment ? 'routine: judgment' : 'routine: no hard signals',
  }
}

/** What the router reads off one spawn. An `AgentSpawnInput` fits. */
export type SpawnFacts = Pick<
  AgentSpawnInput,
  'subagentType' | 'description' | 'prompt' | 'fork' | 'parentModel' | 'provider'
> &
  Partial<Pick<AgentSpawnInput, 'model' | 'isTeammate'>> & {
    /** An effort the Agent call itself names (the person or an instruction asked for it): it stays. */
    callEffort?: string
    /** A stable value per spawn (its tool_use_id) that decides whether this run tries a cheaper tier. */
    seed?: string
  }

const kept = (why: string): Route => ({ kind: 'kept', why, isApplied: false })

/** Plugins whose role agents a difficulty tag may raise: the delegate mod puts one on every brief for this. */
const RAISED_PLUGINS: ReadonlySet<string> = new Set(['delegate'])

/**
 * A delegate role tagged `hard` runs on Opus at high effort, `deep` on Opus at xhigh; any other
 * tag, or none, hands back undefined (the role is kept as defined). It only raises: Opus is the
 * top allowed tier, and the step hook applies the effort only to a step that runs lower. A model
 * and an effort the call names stay (a gauntlet competitor keeps the gauntlet's pick). No struggle
 * raise on top: the effort ceiling is the effort. The pick teaches the router nothing.
 */
function raiseRole(
  input: SpawnFacts,
  config: RouterSettings,
  parentEffort: string | undefined,
  isCallBlocked: boolean,
): Route | undefined {
  const tag = readDifficultyTag(input)
  if (tag === undefined || tag.kind !== 'hard') return undefined
  const level = tag.effort === 'xhigh' ? 'deep' : 'hard'
  const callModel = isCallBlocked ? undefined : input.model
  const isCapped = config.ceiling === 'session'
  const parentTier = tierOf(input.parentModel)
  // Under the session cap, a session below Opus raises no model: the role keeps its own.
  const isModelCapped = isCapped && parentTier !== undefined && tierRank(parentTier) < tierRank(tag.tier)
  const swap = isCallBlocked && input.model !== undefined ? nearestAllowed(input.model) : undefined
  const tier = callModel !== undefined ? tierOf(callModel) : isModelCapped ? swap : tag.tier
  const model = callModel !== undefined || tier === undefined ? undefined : tier === parentTier ? input.parentModel : tier
  let effort = tag.effort
  const cap = effortRank(parentEffort)
  if (isCapped && cap >= 0 && effortRank(effort) > cap) effort = EFFORT_LEVELS[cap] ?? effort
  const isLimited = isModelCapped || effort !== tag.effort
  const isEffortNamed = input.callEffort !== undefined
  const notes = [
    `${input.provider.plugin} role, tagged ${level}: ${tag.tier}`,
    ...(isLimited ? ['capped to the session'] : []),
    ...(isCallBlocked ? [`${input.model} not allowed`] : []),
    ...(callModel === undefined ? [] : ['model set by the call']),
    ...(isEffortNamed ? ['effort set by the call'] : []),
  ]
  return {
    kind: tag.kind,
    ...(model === undefined ? {} : { model }),
    ...(isEffortNamed ? {} : { effort, maxEffort: effort }),
    ...(tier === undefined ? {} : { tier }),
    isRaiseOnly: true,
    why: notes.join(' · '),
    isApplied: config.mode === 'auto',
  }
}

/**
 * The router's pick for one spawn, or undefined when it is off.
 * It leaves a fork, a teammate and any agent a plugin or the person defined alone, except a
 * delegate role tagged hard or deep, which it raises (see `raiseRole`).
 * A model the call names stays. `ceiling: 'session'` holds the pick to the session's own
 * model and effort. Only Haiku, Sonnet and Opus are allowed: a call that names another family
 * (Fable) gets the router's pick, a custom agent gets Opus, and a session on another family
 * never passes its model down.
 */
export function chooseRoute(
  input: SpawnFacts,
  config: RouterSettings,
  parentEffort?: string,
  lessons?: Lessons,
  history?: RouteHistory,
): Route | undefined {
  if (config.mode === 'off') return undefined
  if (input.fork) return kept('a fork inherits its parent')
  if (input.isTeammate === true) return kept('a teammate keeps its own setup')
  const isCallBlocked = isBlockedModel(input.model)
  const raised = RAISED_PLUGINS.has(input.provider.plugin) ? raiseRole(input, config, parentEffort, isCallBlocked) : undefined
  if (raised !== undefined) return raised
  if (input.provider.plugin !== 'engine') {
    if (!isCallBlocked || input.model === undefined) return kept('custom agent, kept as defined')
    const swap = nearestAllowed(input.model)
    return {
      kind: 'kept',
      model: swap,
      tier: swap,
      why: `custom agent, kept as defined · ${input.model} not allowed: ${swap}`,
      isApplied: config.mode === 'auto',
    }
  }
  // A blocked model the call names counts as no model named: the router picks.
  const callModel = isCallBlocked ? undefined : input.model

  const raw = classifyTask(input)
  const isLearning = config.learn !== false
  const lesson = isLearning ? lessons?.[raw.kind] : undefined
  const learned = applyLesson(raw, lesson)
  const isLearned = learned.isLearned
  // The floor first, so a lookup starts on Sonnet and no move down goes under it.
  const start = { ...learned.verdict, tier: atFloor(learned.verdict.tier) }
  const isCapped = config.ceiling === 'session'
  const parentTier = tierOf(input.parentModel)
  // Learn down too: a cheaper tier that holds, or a few runs that try it. Not when the call names
  // a model, not after a lesson raised the kind.
  const move = isLearning && !isLearned && callModel === undefined ? downMove(start, history, config, input.seed) : undefined
  const verdict = move === undefined ? start : { ...start, tier: move.tier, effort: move.effort }

  let tier = verdict.tier
  // The session cap never takes a pick under the floor (a session on Haiku still sends Sonnet).
  if (isCapped && parentTier !== undefined && tierRank(tier) > tierRank(parentTier)) tier = atFloor(parentTier)
  let effort = verdict.effort
  const cap = effortRank(parentEffort)
  if (isCapped && cap >= 0 && effortRank(effort) > cap) effort = EFFORT_LEVELS[cap] ?? effort
  const isLimited = tier !== verdict.tier || effort !== verdict.effort
  // How far a struggling agent may be raised: the session's own effort under the cap, else xhigh.
  const maxEffort: RouteEffort = isCapped && cap >= 0 ? (EFFORT_LEVELS[cap] ?? 'xhigh') : 'xhigh'

  // The parent's own id when the pick is its family: no alias drift, and it holds even
  // for an agent type whose own default is another model. A parent outside the allowed
  // families (Fable) gets the alias, so the agent never inherits it.
  const model =
    callModel !== undefined
      ? undefined
      : parentTier === undefined
        ? tier
        : tier === parentTier
          ? input.parentModel
          : tier
  const isParentBlocked = callModel === undefined && isBlockedModel(input.parentModel)

  const isEffortNamed = input.callEffort !== undefined
  const notes = [
    verdict.why,
    ...(isLearned ? ['learned: raised'] : []),
    ...(move?.isProven === true ? [`learned: ${move.tier} holds`] : []),
    ...(move?.isExplore === true ? [`trying ${move.tier}`] : []),
    ...(isLimited ? ['capped to the session'] : []),
    ...(isCallBlocked ? [`${input.model} not allowed`] : []),
    ...(isParentBlocked ? [`session's ${input.parentModel} not passed down`] : []),
    ...(callModel === undefined ? [] : ['model set by the call']),
    ...(isEffortNamed ? ['effort set by the call'] : []),
  ]

  return {
    kind: verdict.kind,
    ...(model === undefined ? {} : { model }),
    ...(isEffortNamed ? {} : { effort, maxEffort }),
    ...(isLearned ? { isLearned: true } : {}),
    tier,
    baseTier: start.tier,
    ...(move?.isExplore === true ? { isExplore: true } : {}),
    ...(move?.isProven === true ? { isProven: true } : {}),
    budget: budgetFor(start.kind, history),
    why: notes.join(' · '),
    isApplied: config.mode === 'auto',
  }
}

// ---------------------------------------------------------------------------
// Routing v2: learn both ways, try cheaper tiers, budget at parity. Counts only, no task text.
// ---------------------------------------------------------------------------

/** Token weights, in input-token equivalents: what each kind of token costs next to plain input. */
const BILLED_WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } as const

/** An agent's tokens as input-token equivalents: cache reads are cheap, output is dear. */
export function billedTokens(counts: TokenCounts | undefined): number {
  if (counts === undefined) return 0
  return Math.round(
    counts.input * BILLED_WEIGHTS.input +
      counts.cacheRead * BILLED_WEIGHTS.cacheRead +
      counts.cacheWrite * BILLED_WEIGHTS.cacheWrite +
      counts.output * BILLED_WEIGHTS.output,
  )
}

/** A kind's budget until its own runs say more: input-token equivalents per run. */
const DEFAULT_BUDGETS: Readonly<Record<Exclude<RouteKind, 'kept'>, number>> = {
  lookup: 50_000,
  routine: 600_000,
  careful: 800_000,
  hard: 1_200_000,
}
/** Runs a kind needs at its starting tier before its median sets the budget. */
const BUDGET_MIN_RUNS = 5
/** Runs a cheaper tier needs before it can be proven to hold. */
const PROVE_MIN_RUNS = 20
/** The lower bound (90% confidence) of the cheaper tier's success rate that proves it holds: 20 clean runs of 20 give 0.88. */
const PROVE_RATE = 0.85
/** How often a run tries a cheaper tier, with no target set; the target moves it within the bounds. */
const EXPLORE_RATE = 0.1
const EXPLORE_MIN = 0.05
const EXPLORE_MAX = 0.3
/** The recent routed runs the light-model share is read from. */
const SHARE_WINDOW = 50
/** The kinds that may try a cheaper tier. Careful and hard work only moves down once proven. */
const EXPLORE_KINDS: ReadonlySet<string> = new Set(['lookup', 'routine'])
/** Routed runs on record before any run tries a cheaper tier. */
const EXPLORE_AFTER_RUNS = 10

/** What past outcomes say, read once per spawn: success per kind and tier, budgets, the light-model share. */
export type RouteHistory = {
  tiers: Readonly<Record<string, { runs: number; ok: number }>>
  budgets: Partial<Record<Exclude<RouteKind, 'kept'>, number>>
  haikuShare: number
  routedRuns: number
}

/** The tier a record from before routing v2 ran on: its kind's old default. */
const legacyTier = (kind: Outcome['kind']): ModelTier => (kind === 'lookup' ? 'haiku' : kind === 'hard' ? 'opus' : 'sonnet')

export function historyFrom(list: readonly Outcome[]): RouteHistory {
  const tiers: Record<string, { runs: number; ok: number }> = {}
  const billed: Partial<Record<Outcome['kind'], number[]>> = {}
  for (const one of list) {
    const tier = one.tier ?? legacyTier(one.kind)
    const key = `${one.kind}:${tier}`
    const cell = tiers[key] ?? { runs: 0, ok: 0 }
    tiers[key] = { runs: cell.runs + 1, ok: cell.ok + (one.struggled ? 0 : 1) }
    if (one.billed !== undefined && one.wasExplore !== true && !one.struggled) {
      billed[one.kind] = [...(billed[one.kind] ?? []), one.billed]
    }
  }
  const budgets: RouteHistory['budgets'] = {}
  for (const kind of LEARNED_KINDS) {
    const runs = billed[kind] ?? []
    if (runs.length < BUDGET_MIN_RUNS) continue
    const sorted = [...runs].sort((a, b) => a - b)
    budgets[kind] = sorted[Math.floor(sorted.length / 2)] ?? DEFAULT_BUDGETS[kind]
  }
  const recent = list.filter(one => one.tier !== undefined).slice(-SHARE_WINDOW)
  const haikuShare = recent.length === 0 ? 0 : recent.filter(one => one.tier === 'haiku').length / recent.length
  return { tiers, budgets, haikuShare, routedRuns: recent.length }
}

/** The lower bound of a success rate's 90% Wilson interval: what the rate is at least, given the runs. */
export function wilsonLower(ok: number, runs: number): number {
  if (runs <= 0) return 0
  const z = 1.645
  const p = ok / runs
  const centre = p + (z * z) / (2 * runs)
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * runs)) / runs)
  return (centre - spread) / (1 + (z * z) / runs)
}

/** A number in [0, 1) from a string, the same every time: whether this spawn tries a cheaper tier. */
export function seedFraction(seed: string): number {
  let hash = 2166136261
  for (const ch of seed) {
    hash ^= ch.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  // A final mix (MurmurHash3's), so ids that differ in their last letters spread over [0, 1).
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return (hash >>> 0) / 4294967296
}

/** How often runs try a cheaper tier: more while the light-model share is under the target. */
export function exploreRate(config: RouterSettings, history: RouteHistory | undefined): number {
  if (config.target === undefined) return EXPLORE_RATE
  const share = history?.haikuShare ?? 0
  return Math.min(EXPLORE_MAX, Math.max(EXPLORE_MIN, config.target - share + EXPLORE_MIN))
}

/**
 * One tier down, when the cheaper tier holds (proven by past runs) or this run is one of the few
 * that try it. The effort goes up one level as it moves down, so the run keeps its budget's reach.
 */
export function downMove(
  verdict: Verdict,
  history: RouteHistory | undefined,
  config: RouterSettings,
  seed: string | undefined,
): { tier: ModelTier; effort: RouteEffort; isProven: boolean; isExplore: boolean } | undefined {
  const below = MODEL_TIERS[tierRank(verdict.tier) - 1]
  if (below === undefined || tierRank(below) < tierRank(MIN_TIER)) return undefined
  const effort = EFFORT_LEVELS[Math.min(effortRank(verdict.effort) + 1, EFFORT_LEVELS.length - 1)] ?? verdict.effort
  const cell = history?.tiers[`${verdict.kind}:${below}`]
  if (cell !== undefined && cell.runs >= PROVE_MIN_RUNS && wilsonLower(cell.ok, cell.runs) >= PROVE_RATE) {
    return { tier: below, effort, isProven: true, isExplore: false }
  }
  // Tries start once there is a baseline: some routed runs on record.
  if (!EXPLORE_KINDS.has(verdict.kind) || seed === undefined || (history?.routedRuns ?? 0) < EXPLORE_AFTER_RUNS) return undefined
  return seedFraction(seed) < exploreRate(config, history) ? { tier: below, effort, isProven: false, isExplore: true } : undefined
}

/** A kind's budget: the median of its own clean runs once there are enough, else the default. */
export function budgetFor(kind: Exclude<RouteKind, 'kept'>, history: RouteHistory | undefined): number {
  return history?.budgets[kind] ?? DEFAULT_BUDGETS[kind]
}

/** How much of its budget an agent used, as a whole percent; undefined without a budget. */
export function budgetUse(route: Route | undefined, tokens: TokenCounts | undefined): number | undefined {
  const billed = billedTokens(tokens)
  if (route?.budget === undefined || route.budget <= 0 || billed === 0) return undefined
  return Math.round((billed / route.budget) * 100)
}

/**
 * One line on a pick, for the card's last row. `current` is the effort the agent's last step
 * carried; when the radar raised it, the line says so.
 */
export function describeRoute(route: Route, current?: string, used?: number): string {
  if (route.kind === 'kept') return `· ${route.why}`
  const pick = [route.model === undefined ? 'model as set' : shortModel(route.model), route.effort]
    .filter(part => part !== undefined)
    .join(' · ')
  // A raise-only pick never raises for struggle: an effort above it is the role's own.
  const isRaised =
    route.isApplied &&
    route.isRaiseOnly !== true &&
    route.effort !== undefined &&
    current !== undefined &&
    effortRank(current) > effortRank(route.effort)
  const budget = used === undefined || route.budget === undefined ? '' : ` · budget ${used}% of ${formatTokens(route.budget)}`
  return `${route.isApplied ? '⇄' : '⇢ would use'} ${pick} — ${route.why}${isRaised ? ` · raised to ${current}` : ''}${budget}`
}

type StepEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

/** A run this many steps long raises the effort one level at each mark. */
const RAISE_AT_STEPS: readonly number[] = [12, 24]
/** This many failed or refused tool calls raise the effort one level. */
const RAISE_AT_ERRORS = 3

/**
 * The effort for one step of an agent: the pick's, one level up for each sign of struggle
 * (a long run, repeated tool errors). Never above the pick's ceiling, never below the pick.
 * The model is never changed mid-run: that would break the prompt cache.
 */
export function stepEffort(route: Route, stepIndex: number, errors: number): RouteEffort | undefined {
  if (route.effort === undefined) return undefined
  const base = effortRank(route.effort)
  const bumps = RAISE_AT_STEPS.filter(mark => stepIndex >= mark).length + (errors >= RAISE_AT_ERRORS ? 1 : 0)
  const ceiling = effortRank(route.maxEffort ?? 'xhigh')
  return EFFORT_LEVELS[Math.max(base, Math.min(base + bumps, ceiling))] ?? route.effort
}

/**
 * The step as it is sent: the pick's effort, raised for struggle, in place of the one the engine
 * chose. A step with no effort (a model that takes none) and a pick that is not applied go
 * through as they are. A raise-only pick changes only a step that runs lower than it.
 */
export function withEffort<T extends { readonly effort?: StepEffort; readonly index: number }>(
  step: T,
  route: Route | undefined,
  errors = 0,
): T {
  if (route === undefined || !route.isApplied) return step
  const effort = stepEffort(route, step.index, errors)
  if (effort === undefined || step.effort === undefined || step.effort === effort) return step
  // `max` and a number are not on the router's scale: a raise-only pick leaves them as they are.
  const isLower = typeof step.effort === 'string' && effortRank(step.effort) >= 0 && effortRank(step.effort) < effortRank(effort)
  if (route.isRaiseOnly === true && !isLower) return step
  return { ...step, effort }
}

function trimRoutes(map: Record<string, Route>): Record<string, Route> {
  const entries = Object.entries(map)
  return entries.length <= MAX_ROUTES ? map : Object.fromEntries(entries.slice(-MAX_ROUTES))
}

/** Notes a pick made at the spawn, before the engine answered with an id. */
export function addPending(book: RouteBook, entry: PendingRoute): RouteBook {
  return { ...book, pending: [...book.pending, entry].slice(-MAX_ROUTES) }
}

/** The spawn answered: the id owns the pick, whether or not a first step took it already. */
export function settleRoute(book: RouteBook, toolUseId: string, agentId: string, route: Route): RouteBook {
  const pending = book.pending.filter(one => one.toolUseId !== toolUseId)
  return { pending, byAgent: trimRoutes({ ...book.byAgent, [agentId]: book.byAgent[agentId] ?? route }) }
}

/** The spawn was refused, or started nothing: its pick is dropped. */
export function dropPending(book: RouteBook, toolUseId: string): RouteBook {
  return book.pending.some(one => one.toolUseId === toolUseId)
    ? { ...book, pending: book.pending.filter(one => one.toolUseId !== toolUseId) }
    : book
}

/**
 * A step came before the spawn answered. The agent is matched to a pending pick by its type
 * and description, which the radar never rewrites. It hands back the same book when none fits.
 */
export function claimRoute(book: RouteBook, agentId: string, type: string, description: string): RouteBook {
  if (book.byAgent[agentId] !== undefined) return book
  const index = book.pending.findIndex(one => one.type === type && one.description === description)
  const hit = book.pending[index]
  if (hit === undefined) return book
  return {
    pending: book.pending.filter((_, at) => at !== index),
    byAgent: trimRoutes({ ...book.byAgent, [agentId]: hit.route }),
  }
}

/** The words of the settings, for a line of text. */
export function routingWords(config: RouterSettings): string {
  if (config.mode === 'off') return 'mode off'
  const target = config.target === undefined ? '' : `, haiku target ${Math.round(config.target * 100)}% (unused: haiku is off)`
  return `mode ${config.mode}, ceiling ${config.ceiling}, models sonnet and opus only${config.learn === false ? ', learning off' : ''}${target}`
}

const USAGE =
  'Usage: /radar (open the pane) · /radar status · /radar stats · /radar mode auto|suggest|off · /radar ceiling raise|session · /radar learn on|off|reset · /radar target haiku <n>%|off · /radar view both|office|cards · /radar labels on|off · /radar motion on|off · /radar details on|off · /radar sessions [on|off|all|recent] · /radar idle <hours> · /radar floors <n> · /radar expand <n|name|all> · /radar collapse [n|name|all] · /radar name [label]'

export type RadarCommand =
  | { kind: 'open' }
  | { kind: 'status' }
  | { kind: 'stats' }
  | { kind: 'forget' }
  | { kind: 'set'; change: Partial<RouterSettings> }
  | { kind: 'view'; change: Partial<ViewPrefs> }
  | { kind: 'sessions' }
  | { kind: 'expand'; target: string }
  | { kind: 'collapse'; target?: string }
  | { kind: 'name'; label: string }
  | { kind: 'bad'; usage: string }

const MODES: readonly RouteMode[] = ['auto', 'suggest', 'off']
const CEILINGS: readonly RouteCeiling[] = ['raise', 'session']

/** Reads what the person typed after `/radar`. A label keeps its case; everything else is read lowercased. */
export function parseRadarArgs(args: string): RadarCommand {
  const raw = args.trim()
  const head = raw.split(/\s+/)[0] ?? ''
  if (head.toLowerCase() === 'name') return { kind: 'name', label: cleanText(raw.slice(head.length), LIVE_TEXT) }
  const words = raw
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word !== '')
  const [key, value, ...rest] = words
  if (key === undefined || key === 'open') return { kind: 'open' }
  if (key === 'status' && value === undefined) return { kind: 'status' }
  if (key === 'stats' && value === undefined) return { kind: 'stats' }
  if (key === 'sessions' && value === undefined) return { kind: 'sessions' }
  if (key === 'sessions' && rest.length === 0 && (value === 'on' || value === 'off')) {
    return { kind: 'view', change: { sessions: value === 'on' } }
  }
  if (key === 'sessions' && rest.length === 0 && (value === 'all' || value === 'recent')) {
    return { kind: 'view', change: { sessionsMode: value } }
  }
  if (key === 'idle' && rest.length === 0 && value !== undefined && /^\d+(?:\.\d+)?$/.test(value)) {
    const hours = Number(value)
    if (hours > 0 && hours <= MAX_IDLE_HOURS) return { kind: 'view', change: { idleHours: hours } }
  }
  if (key === 'floors' && rest.length === 0 && value !== undefined && /^\d+$/.test(value)) {
    const floors = Number(value)
    if (floors <= MAX_FLOORS) return { kind: 'view', change: { floors } }
  }
  if (key === 'expand' && value !== undefined) return { kind: 'expand', target: [value, ...rest].join(' ') }
  if (key === 'collapse') return value === undefined ? { kind: 'collapse' } : { kind: 'collapse', target: [value, ...rest].join(' ') }
  if (rest.length === 0 && key === 'view') {
    const layout = LAYOUTS.find(one => one === value)
    if (layout !== undefined) return { kind: 'view', change: { layout } }
  }
  if (rest.length === 0 && (key === 'labels' || key === 'motion' || key === 'details') && (value === 'on' || value === 'off')) {
    const isOn = value === 'on'
    return { kind: 'view', change: key === 'labels' ? { labels: isOn } : key === 'motion' ? { motion: isOn } : { details: isOn } }
  }
  if (rest.length === 0 && key === 'learn') {
    if (value === 'on' || value === 'off') return { kind: 'set', change: { learn: value === 'on' } }
    if (value === 'reset') return { kind: 'forget' }
  }
  if (rest.length === 0 && key === 'mode') {
    const mode = MODES.find(one => one === value)
    if (mode !== undefined) return { kind: 'set', change: { mode } }
  }
  if (key === 'target' && rest.length === 0 && value === 'off') return { kind: 'set', change: { target: undefined } }
  if (key === 'target' && value === 'haiku' && rest.length === 1) {
    const percent = /^(\d{1,2}|100)%?$/.exec(rest[0] ?? '')
    if (percent !== null) return { kind: 'set', change: { target: Number(percent[1]) / 100 } }
  }
  if (rest.length === 0 && key === 'ceiling') {
    const ceiling = CEILINGS.find(one => one === value)
    if (ceiling !== undefined) return { kind: 'set', change: { ceiling } }
  }
  return { kind: 'bad', usage: USAGE }
}

/** The settings with a change applied; the same object when nothing changes. */
export function withPrefs(current: RouterSettings, change: Partial<RouterSettings>): RouterSettings {
  const next = { ...current, ...change }
  return next.mode === current.mode && next.ceiling === current.ceiling && next.learn === current.learn && next.target === current.target
    ? current
    : next
}

/** The view switches with a change applied; the same object when nothing changes. */
export function withView(current: ViewPrefs, change: Partial<ViewPrefs>): ViewPrefs {
  const next = { ...current, ...change }
  return next.layout === current.layout &&
    next.labels === current.labels &&
    next.motion === current.motion &&
    next.details === current.details &&
    next.sessions === current.sessions &&
    next.sessionsMode === current.sessionsMode &&
    next.idleHours === current.idleHours &&
    next.floors === current.floors
    ? current
    : next
}

/** How long an idle session keeps its floor, in ms. */
export const idleMsOf = (view: ViewPrefs): number => (view.idleHours ?? DEFAULT_IDLE_HOURS) * 3_600_000
/** How many other sessions get a floor. */
export const floorsOf = (view: ViewPrefs): number => view.floors ?? DEFAULT_FLOORS

/** `2h`, `30m`, `36s`, `1.5h`: a span of hours as the settings word it. */
function hoursWords(hours: number): string {
  if (hours * 60 < 1) return `${Math.round(hours * 3600)}s`
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${Number(hours.toFixed(2))}h`
}

/**
 * The view switches read back from the store; undefined for anything malformed. A save from before
 * details or sessions has them on.
 */
export function asView(value: unknown): ViewPrefs | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const one = value as Record<string, unknown>
  const layout = LAYOUTS.find(each => each === one.layout)
  if (layout === undefined || typeof one.labels !== 'boolean' || typeof one.motion !== 'boolean') return undefined
  if (one.details !== undefined && typeof one.details !== 'boolean') return undefined
  if (one.sessions !== undefined && typeof one.sessions !== 'boolean') return undefined
  const mode = one.sessionsMode === 'all' || one.sessionsMode === 'recent' ? one.sessionsMode : undefined
  const idle = typeof one.idleHours === 'number' && one.idleHours > 0 && one.idleHours <= MAX_IDLE_HOURS ? one.idleHours : undefined
  const floors = typeof one.floors === 'number' && Number.isInteger(one.floors) && one.floors >= 0 && one.floors <= MAX_FLOORS ? one.floors : undefined
  return defined({
    layout,
    labels: one.labels,
    motion: one.motion,
    details: one.details !== false,
    sessions: one.sessions !== false,
    sessionsMode: mode,
    idleHours: idle,
    floors,
  }) as ViewPrefs
}

export function viewWords(view: ViewPrefs): string {
  const layout = view.layout === 'both' ? 'office and cards' : view.layout === 'office' ? 'office only' : 'cards only'
  const onOff = (isOn: boolean): string => (isOn ? 'on' : 'off')
  const sessions =
    view.sessions === false
      ? 'sessions off'
      : `sessions ${view.sessionsMode === 'all' ? 'all' : `recent (idle ${hoursWords(idleMsOf(view) / 3_600_000)})`}, ${plural(floorsOf(view), 'floor')}`
  return `${layout}, labels ${onOff(view.labels)}, motion ${onOff(view.motion)}, details ${onOff(view.details !== false)}, ${sessions}`
}

// ---------------------------------------------------------------------------
// Tokens, file conflicts and lessons from past runs. Pure, so the tests can reach them.
// ---------------------------------------------------------------------------

/** One response's usage, as a step's `stop` chunk carries it. */
export type UsageLike = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}

/** Adds one response's usage to an agent's counts. */
export function addTokens(counts: TokenCounts | undefined, usage: UsageLike): TokenCounts {
  const known = counts ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    input: known.input + (usage.input_tokens || 0),
    output: known.output + (usage.output_tokens || 0),
    cacheRead: known.cacheRead + (usage.cache_read_input_tokens || 0),
    cacheWrite: known.cacheWrite + (usage.cache_creation_input_tokens || 0),
  }
}

/** Every token counted: input, output, cache reads and cache writes. */
export function totalTokens(counts: TokenCounts | undefined): number {
  return counts === undefined ? 0 : counts.input + counts.output + counts.cacheRead + counts.cacheWrite
}

/** How full the context was for one request: all it sent, cached or not. */
export function contextOf(usage: UsageLike): number {
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
}

/** `850`, `12.3k`, `123k`, `1.2M`. */
export function formatTokens(count: number): string {
  const trim = (text: string): string => text.replace(/\.0$/, '')
  if (count < 1000) return String(Math.max(0, Math.round(count)))
  if (count < 100_000) return `${trim((count / 1000).toFixed(1))}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${trim((count / 1_000_000).toFixed(1))}M`
}

/** Where a row's tokens are summed: its pick's kind, or `unrouted`. */
export const spendKind = (route: Route | undefined): string => route?.kind ?? 'unrouted'

const SPEND_ORDER = ['lookup', 'routine', 'careful', 'hard', 'kept', 'unrouted']

/** Counts one more agent of a kind. */
export function countAgent(book: Record<string, Spend>, kind: string): Record<string, Spend> {
  const known = book[kind] ?? { tokens: 0, agents: 0 }
  return { ...book, [kind]: { ...known, agents: known.agents + 1 } }
}

/** Adds tokens to a kind; the same book for none. */
export function addSpendTokens(book: Record<string, Spend>, kind: string, tokens: number): Record<string, Spend> {
  if (tokens <= 0) return book
  const known = book[kind] ?? { tokens: 0, agents: 0 }
  return { ...book, [kind]: { ...known, tokens: known.tokens + tokens } }
}

/** One line on where the subagents' tokens went, or '' before any. */
export function describeSpend(book: Record<string, Spend>): string {
  const used = SPEND_ORDER.filter(kind => (book[kind]?.tokens ?? 0) > 0)
  if (used.length === 0) return ''
  const sum = used.reduce((all, kind) => all + (book[kind]?.tokens ?? 0), 0)
  return [`subagent tokens ${formatTokens(sum)}`, ...used.map(kind => `${kind} ${formatTokens(book[kind]?.tokens ?? 0)}`)].join(' · ')
}

/** The path an edit names: `file_path`, or a notebook's `notebook_path`. Undefined for any other call. */
export function editedPath(call: CallLike): string | undefined {
  if (!EDIT_TOOLS.has(call.tool)) return undefined
  const path = str(call.file_path) || str(call.notebook_path)
  return path === '' ? undefined : path
}

/** The path a read names: the Read tool's `file_path`. Undefined for any other call. */
export function readPath(call: CallLike): string | undefined {
  if (call.tool !== 'Read') return undefined
  const path = str(call.file_path)
  return path === '' ? undefined : path
}

/** Notes a file an agent edited or read, as named; the same list when it is known in any case. */
export function noteFile(files: string[] | undefined, path: string): string[] {
  const list = files ?? []
  const key = path.toLowerCase()
  return list.some(file => file.toLowerCase() === key) ? list : [...list, path].slice(-MAX_FILES)
}

/** The other live agents that edited the same file (`key`, lowercased). Ended ones are history, not a clash. */
export function rivalsOf(rows: readonly AgentRow[], selfId: string, key: string): string[] {
  return rows
    .filter(row => row.id !== selfId && !isEnded(row.status) && (row.files ?? []).some(file => file.toLowerCase() === key))
    .map(row => row.id)
}

/** A tool's short name on a card: every MCP tool is `MCP`. */
const toolName = (tool: string): string => (tool.startsWith('mcp__') ? 'MCP' : tool)

/** A row's trail and tool counts with one more call. */
export function noteCall(
  row: Pick<AgentRow, 'trail' | 'toolCounts'>,
  tool: string,
  detail: string,
): Required<Pick<AgentRow, 'trail' | 'toolCounts'>> {
  const name = toolName(tool)
  const counts = row.toolCounts ?? {}
  const key = counts[name] !== undefined || Object.keys(counts).length < MAX_TOOL_KINDS ? name : 'other'
  return {
    trail: [...(row.trail ?? []), { tool: name, detail }].slice(-TRAIL_KEPT),
    toolCounts: { ...counts, [key]: (counts[key] ?? 0) + 1 },
  }
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** `14:02:11`, in this machine's time zone. */
export function clockTime(ms: number): string {
  const at = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}

/** What a subagent's card says below its task with details on. Each part is absent when it has nothing to say. */
export type CardDetails = {
  /** "recent: Grep loadConfig › Read config.ts": its last calls, oldest first. */
  recent?: string
  /** "3 tool calls (Read 2, Grep 1) · 1 failed · 2 model calls · edited a.ts · read 2 files". */
  stats?: string
  /** "in 1k · cache read 5k · cache write 300 · out 200": its tokens by kind. */
  tokens?: string
  /** "11:02:14–11:05:30", "since 11:02:14", led by "for Explore ·" when another agent started it. */
  times?: string
}

/**
 * A subagent card's details: its last calls, one line of counts and files, its tokens by kind
 * (shown on hover), and when it ran and for whom (`parent`).
 */
export function cardDetails(row: AgentRow, parent: string): CardDetails {
  const recent = (row.trail ?? [])
    .slice(-TRAIL_SHOWN)
    .map(step => (step.detail === '' ? step.tool : `${step.tool} ${clip(step.detail, TRAIL_DETAIL_CHARS)}`))
  const byTool = Object.entries(row.toolCounts ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool, count]) => `${tool} ${count}`)
  const calls = row.tools === 0 ? 'no tool calls' : `${plural(row.tools, 'tool call')}${byTool.length > 0 ? ` (${byTool.join(', ')})` : ''}`
  const errors = row.errors ?? 0
  const steps = row.steps ?? 0
  const edited = (row.files ?? []).map(base)
  const reads = row.readCount ?? row.reads?.length ?? 0
  const stats = [
    calls,
    ...(errors > 0 ? [`${errors} failed`] : []),
    ...(steps > 0 ? [plural(steps, 'model call')] : []),
    ...(edited.length === 0 ? [] : [edited.length <= 3 ? `edited ${edited.join(', ')}` : `edited ${edited.length} files: ${edited.slice(0, 3).join(', ')}, …`]),
    ...(reads === 0 ? [] : [`read ${plural(reads, 'file')}`]),
  ].join(' · ')
  const tokens = row.tokens
  // A row found already done carries no real times: it starts and ends at one made-up moment.
  const isMadeUp = row.endedAt !== undefined && row.endedAt === row.startedAt
  const span = row.endedAt === undefined ? `since ${clockTime(row.startedAt)}` : `${clockTime(row.startedAt)}–${clockTime(row.endedAt)}`
  return defined({
    recent: recent.length === 0 ? undefined : `recent: ${recent.join(' › ')}`,
    stats,
    tokens:
      tokens === undefined || totalTokens(tokens) === 0
        ? undefined
        : `in ${formatTokens(tokens.input)} · cache read ${formatTokens(tokens.cacheRead)} · cache write ${formatTokens(tokens.cacheWrite)} · out ${formatTokens(tokens.output)}`,
    times: isMadeUp ? undefined : `${parent === 'Lead' ? '' : `for ${parent} · `}${span}`,
  }) as CardDetails
}

/**
 * The router's pick in a few words, for a card's footer: its kind, and whether a lesson or a
 * struggle raised it; for a suggestion, what it would use; for a spawn it kept, why.
 */
export function routeSummary(route: Route, current?: string, used?: number): string {
  if (route.kind === 'kept') return route.why
  if (!route.isApplied) {
    const pick = [route.model === undefined ? 'its own model' : shortModel(route.model), route.effort].filter(part => part !== undefined).join(' ')
    return `${route.kind} · would use ${pick}`
  }
  const isRaised =
    route.isRaiseOnly !== true && route.effort !== undefined && current !== undefined && effortRank(current) > effortRank(route.effort)
  return [
    route.kind,
    ...(route.isLearned === true ? ['learned'] : []),
    ...(route.isProven === true ? [`${route.tier ?? 'cheaper'} holds`] : []),
    ...(route.isExplore === true ? [`trying ${route.tier ?? 'cheaper'}`] : []),
    ...(isRaised ? [`raised to ${current}`] : []),
    ...(used === undefined ? [] : [`budget ${used}%`]),
  ].join(' · ')
}

/**
 * Notes a clash on a file. `isNew` is true when the file, or one of its agents, is new to the
 * list: that is when the person hears of it.
 */
export function addConflict(
  list: Conflict[],
  key: string,
  path: string,
  ids: readonly string[],
  at: number,
): { list: Conflict[]; isNew: boolean } {
  const known = list.find(one => one.key === key)
  if (known === undefined) {
    return { list: [{ key, path, agents: [...ids], at }, ...list].slice(0, MAX_CONFLICTS), isNew: true }
  }
  const added = ids.filter(id => !known.agents.includes(id))
  if (added.length === 0) return { list, isNew: false }
  return {
    list: [{ ...known, agents: [...known.agents, ...added], at }, ...list.filter(one => one.key !== key)],
    isNew: true,
  }
}

/** What past runs of one kind teach. */
export type Lesson = { runs: number; struggled: number; isRaised: boolean }
export type Lessons = Partial<Record<Outcome['kind'], Lesson>>

/**
 * What past runs teach, per kind: raise the pick when a quarter or more of at least ten
 * recent runs struggled. Only runs no lesson had raised count, so a raise never feeds itself:
 * it holds until `/radar learn reset`.
 */
export function lessonsFrom(list: readonly Outcome[]): Lessons {
  const lessons: Lessons = {}
  for (const kind of LEARNED_KINDS) {
    const plain = list.filter(one => one.kind === kind && !one.wasRaised && one.wasExplore !== true).slice(-LEARN_WINDOW)
    if (plain.length === 0) continue
    const struggled = plain.filter(one => one.struggled).length
    lessons[kind] = {
      runs: plain.length,
      struggled,
      isRaised: plain.length >= LEARN_MIN_RUNS && struggled / plain.length >= LEARN_STRUGGLE_RATE,
    }
  }
  return lessons
}

/** The verdict a lesson raises: a haiku lookup to the middle model, any other kind one effort level. */
export function applyLesson(verdict: Verdict, lesson: Lesson | undefined): { verdict: Verdict; isLearned: boolean } {
  if (lesson === undefined || !lesson.isRaised) return { verdict, isLearned: false }
  if (verdict.kind === 'lookup') {
    return verdict.tier === 'haiku'
      ? { verdict: { ...verdict, tier: 'sonnet' }, isLearned: true }
      : { verdict, isLearned: false }
  }
  const raised = EFFORT_LEVELS[Math.min(effortRank(verdict.effort) + 1, EFFORT_LEVELS.length - 1)] ?? verdict.effort
  return raised === verdict.effort ? { verdict, isLearned: false } : { verdict: { ...verdict, effort: raised }, isLearned: true }
}

/**
 * What an agent's end teaches. An unrouted, kept, suggested or stopped run teaches nothing:
 * a stop is the person's choice, not a sign the pick was weak.
 */
export function outcomeOf(row: AgentRow, at: number): Outcome | undefined {
  const route = row.route
  // A raised role's runs are not the engine agents' runs: they set no lesson, tier or budget.
  if (route === undefined || route.kind === 'kept' || !route.isApplied || route.isRaiseOnly === true) return undefined
  if (row.status !== 'completed' && row.status !== 'failed') return undefined
  const billed = billedTokens(row.tokens)
  const overBudget = route.budget !== undefined && billed > route.budget
  return defined({
    kind: route.kind,
    struggled: row.status === 'failed' || (row.errors ?? 0) >= RAISE_AT_ERRORS || overBudget,
    wasRaised: route.isLearned === true,
    tokens: totalTokens(row.tokens),
    at,
    tier: route.tier,
    effort: route.effort,
    billed,
    wasExplore: route.isExplore === true ? true : undefined,
    overBudget: overBudget ? true : undefined,
  }) as Outcome
}

/** Reads outcomes back from the store, dropping anything malformed. */
export function asOutcomes(value: unknown): Outcome[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Outcome => {
    if (typeof item !== 'object' || item === null) return false
    const one = item as Record<string, unknown>
    return (
      LEARNED_KINDS.some(kind => kind === one.kind) &&
      typeof one.struggled === 'boolean' &&
      typeof one.wasRaised === 'boolean' &&
      typeof one.tokens === 'number' &&
      typeof one.at === 'number' &&
      (one.tier === undefined || MODEL_TIERS.some(tier => tier === one.tier)) &&
      (one.billed === undefined || typeof one.billed === 'number')
    )
  })
}

/** Keeps the newest outcomes of each kind, oldest first. */
export function trimOutcomes(list: readonly Outcome[]): Outcome[] {
  const sorted = [...list].sort((a, b) => a.at - b.at)
  const kept: Outcome[] = []
  for (const kind of LEARNED_KINDS) kept.push(...sorted.filter(one => one.kind === kind).slice(-MAX_OUTCOMES_PER_KIND))
  return kept.sort((a, b) => a.at - b.at)
}

/** One line per kind for `/radar stats`. */
export function describeLessons(list: readonly Outcome[]): string {
  const lessons = lessonsFrom(list)
  const history = historyFrom(list)
  const lines = LEARNED_KINDS.flatMap(kind => {
    const runs = list.filter(one => one.kind === kind)
    if (runs.length === 0) return []
    const lesson = lessons[kind]
    const rate = lesson === undefined || lesson.runs === 0 ? 0 : Math.round((lesson.struggled / lesson.runs) * 100)
    const average = runs.reduce((sum, one) => sum + one.tokens, 0) / runs.length
    const byTier = MODEL_TIERS.flatMap(tier => {
      const cell = history.tiers[`${kind}:${tier}`]
      return cell === undefined ? [] : [`${tier} ${cell.runs} (${Math.round((cell.ok / cell.runs) * 100)}% ok)`]
    })
    return [
      `${kind}: ${runs.length} runs, ${rate}% struggled, about ${formatTokens(average)} tokens each${lesson?.isRaised === true ? ' (raised)' : ''}` +
        `${byTier.length === 0 ? '' : ` · ${byTier.join(', ')}`} · budget ${formatTokens(budgetFor(kind, history))}`,
    ]
  })
  if (lines.length === 0) return 'No routed runs recorded yet.'
  const share = history.routedRuns === 0 ? '' : `\nOn haiku: ${Math.round(history.haikuShare * 100)}% of the last ${history.routedRuns} routed runs.`
  return lines.join('\n') + share
}

/** The kinds a lesson raises now, for the pane. */
export function raisedKinds(list: readonly Outcome[]): string[] {
  const lessons = lessonsFrom(list)
  return LEARNED_KINDS.filter(kind => lessons[kind]?.isRaised === true)
}

/** A live agent that has waited long enough for approval to be worth showing. */
export function isWaiting(row: AgentRow, now: number): boolean {
  return row.needs !== undefined && !isEnded(row.status) && now - row.needs.since >= NEEDS_SHOWN_AFTER_MS
}

// ---------------------------------------------------------------------------
// The team: who is in the office, as the office and the cards draw them. Pure.
// ---------------------------------------------------------------------------

/** The context window a model has: 1M for a `[1m]` id, else the session's. */
export function windowOf(model: string | undefined, fallback: number): number {
  return model !== undefined && model.includes('[1m]') ? 1_000_000 : fallback
}

const TOOL_ACTIVITIES: ReadonlySet<Activity> = new Set([
  'typing',
  'reading',
  'terminal',
  'browsing',
  'helper',
  'studying',
  'calling',
  'working',
  'waiting-you',
])

/**
 * A card's activity line: "reading · Grep: MAX_OFFICES", "thinking", "done · Found three modules."
 * An ended agent's answer is clipped at `max` characters.
 */
export function statusLine(
  activity: Activity,
  tool: string | undefined,
  detail: string | undefined,
  doing: string,
  max = DOING_CHARS,
): string {
  const words = ACTIVITY_WORDS[activity]
  if (activity === 'done' || activity === 'stopped' || activity === 'failed') {
    const said = oneLine(doing)
    return said === '' || said === 'finished' || said === 'failed' ? words : `${words} · ${clip(said, max)}`
  }
  if (tool === undefined || !TOOL_ACTIVITIES.has(activity)) return words
  const name = tool.startsWith('mcp__') ? 'MCP' : tool
  return detail === undefined || detail === '' ? `${words} · ${name}` : `${words} · ${name}: ${detail}`
}

/** One member of the team: the Lead (no row) or a subagent with its row. */
export type TeamEntry = { member: Member; row?: AgentRow }

/**
 * The Lead and every subagent, live ones in spawn order then finished ones. Names repeat as
 * Explore, Explore 2. A row from before desks were numbered gets the lowest free desk.
 */
export function teamOf(rows: readonly AgentRow[], lead: MainState, now: number): TeamEntry[] {
  const leadActivity: Activity =
    lead.phase === 'idle' ? 'idle' : activityOf({ status: 'running', phase: lead.phase, tool: lead.tool, isWaiting: false })
  const leadEntry: TeamEntry = {
    member: {
      id: 'main',
      label: 'Lead',
      role: 'lead',
      activity: leadActivity,
      seat: 0,
      isEnded: false,
      startedAt: 0,
      tooltip: ['Lead', shortModel(lead.model), lead.effort, leadActivity === 'idle' ? 'waiting for your next message' : ACTIVITY_WORDS[leadActivity]]
        .filter(part => part !== undefined && part !== '')
        .join(' · '),
    },
  }
  const ordered = [...rows].sort((a, b) => a.startedAt - b.startedAt)
  const labels = numberLabels(ordered.map(row => gauntletOf(row.description)?.label ?? row.name ?? displayName(row.type)))
  let matchJudges = 0
  const taken = new Set<number>([0])
  for (const row of ordered) if (!isEnded(row.status) && row.seat !== undefined && row.seat > 0) taken.add(row.seat)
  const seatFor = (row: AgentRow): number => {
    if (row.seat !== undefined && row.seat > 0) return row.seat
    let seat = 1
    while (taken.has(seat)) seat += 1
    taken.add(seat)
    return seat
  }
  const entries = ordered.map((row, i): TeamEntry => {
    const activity = activityOf({
      status: row.status,
      phase: row.phase,
      tool: row.needs?.tool ?? row.tool,
      isWaiting: isWaiting(row, now),
    })
    const label = labels[i] ?? row.type
    // The short name under the person: "Glad C", "Judge 2" (numbered in start order), "Swap", "Check", "Final".
    const arena = gauntletOf(row.description)
    if (arena?.kind === 'match') matchJudges += 1
    const tag = arena === undefined ? undefined : arena.kind === 'match' ? `Judge ${matchJudges}` : arena.tag
    const tooltip = [label, statusLine(activity, row.needs?.tool ?? row.tool, row.detail, row.doing), shortModel(row.model), row.effort]
      .filter(part => part !== undefined && part !== '')
      .join(' · ')
    return {
      row,
      member: {
        id: row.id,
        label,
        ...(tag === undefined ? {} : { tag }),
        role: arena?.role ?? roleOf(row.type),
        activity,
        seat: isEnded(row.status) ? (row.seat ?? 0) : seatFor(row),
        isEnded: isEnded(row.status),
        startedAt: row.startedAt,
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
        tooltip,
      },
    }
  })
  // Repeated roles get sibling looks, so eight Builders are not eight twins. A gauntlet's gladiator
  // keeps its letter's look, and its judges take theirs by start order.
  const siblings = new Map(withVariants(entries.map(entry => entry.member)).map(member => [member.id, member.variant] as const))
  let judges = 0
  // While a gauntlet runs the office is the colosseum, and the Lead wears the emperor's look (variant 1).
  const isArena = arenaOn(entries.map(entry => entry.member), now, lead.gauntletDoneAt)
  return [
    isArena ? { ...leadEntry, member: { ...leadEntry.member, variant: 1 } } : leadEntry,
    ...entries.map(entry => {
      const arena = gauntletOf(entry.row?.description)
      const variant = arena === undefined ? (siblings.get(entry.member.id) ?? 0) : arena.letter ?? judges++
      return variant > 0 ? { ...entry, member: { ...entry.member, variant } } : entry
    }),
  ]
}

/** The wall board's bars: subagent tokens by route kind. */
export function kindSpendOf(book: Record<string, Spend>): KindSpend {
  return {
    lookup: book.lookup?.tokens ?? 0,
    routine: book.routine?.tokens ?? 0,
    careful: book.careful?.tokens ?? 0,
    hard: book.hard?.tokens ?? 0,
  }
}

/** Whether this team's office is the colosseum: `teamOf` gives the Lead variant 1 then. */
export const isArenaTeam = (team: readonly TeamEntry[]): boolean => team[0]?.member.variant === 1

/** Anyone on screen who moves: a live agent at work, the Lead at work, or a walk under way. */
export function isMoving(team: readonly TeamEntry[], now: number): boolean {
  // The colosseum's crowd waves and its torches flicker all the while.
  if (isArenaTeam(team)) return true
  return team.some(({ member }) => {
    if (!member.isEnded && member.activity !== 'idle') return true
    const since = member.isEnded ? member.endedAt : member.startedAt
    return member.role !== 'lead' && since !== undefined && now - since < WALK_MS
  })
}

// ---------------------------------------------------------------------------
// Other sessions. Each session writes one small file of its own for the others and reads theirs:
// only its own file is ever written, and only the live folder is listed and read. Pure, so the
// tests can reach them.
// ---------------------------------------------------------------------------

const ACTIVITIES = Object.keys(ACTIVITY_WORDS) as Activity[]
const ROLES = Object.keys(ARCHETYPES) as Role[]
const LEAD_PHASES: readonly LiveLead['phase'][] = ['idle', 'thinking', 'writing', 'tool']
const ENDED_ACTIVITIES: ReadonlySet<string> = new Set(['done', 'failed', 'stopped'])
const STATE_ORDER: Readonly<Record<PeerSession['state'], number>> = { working: 0, idle: 1 }

const asActivity = (word: string): Activity => ACTIVITIES.find(one => one === word) ?? 'working'
const asRole = (word: string): Role => ROLES.find(one => one === word) ?? 'other'
const nonEmpty = (part: string | undefined): part is string => part !== undefined && part !== ''

/** A character that could move the cursor, break a line or flip the text's direction. */
function isControl(code: number): boolean {
  return code < 32 || (code >= 127 && code < 160) || code === 8232 || code === 8233 || (code >= 8234 && code <= 8238) || (code >= 8294 && code <= 8297)
}

/** Text from another session's file or the person, made safe to draw: no control characters, one line, clipped. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  let plain = ''
  for (const char of value) plain += isControl(char.codePointAt(0) ?? 0) ? ' ' : char
  return clip(oneLine(plain), max)
}

const optionalText = (value: unknown, max: number): string | undefined => {
  const text = cleanText(value, max)
  return text === '' ? undefined : text
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The live folder under a home folder. */
export function liveDirOf(home: string): string {
  return `${home.replace(/\/+$/, '')}/${LIVE_DIR}`
}

/** A session's file name, or undefined for an id that could name a path out of the folder. */
export function liveFileName(id: string): string | undefined {
  return SESSION_ID.test(id) ? `${id}.json` : undefined
}

/** The folder name of a project root: `/home/user/project` is `project`. */
export function projectName(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '')
  const name = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
  return cleanText(name, LIVE_TEXT) || 'session'
}

/** Busy: a subagent is live or the Lead works. A busy session writes its file more often. */
export function isBusy(rows: readonly AgentRow[], lead: MainState): boolean {
  return lead.phase !== 'idle' || rows.some(row => !isEnded(row.status))
}

/**
 * The Lead between turns: idle, no turn open; the same object when it is already. At a turn's end,
 * and at a start or reload (which never come mid-turn): 0.8.0 left a Lead "thinking" after a call
 * raised outside any turn, and a busy Lead makes its session look busy to all the others.
 */
export function settledLead(lead: MainState): MainState {
  if (lead.phase === 'idle' && lead.turnId === undefined) return lead
  return defined({ ...lead, phase: 'idle', turnId: undefined }) as MainState
}

export type LiveInput = {
  id: string
  now: number
  every: number
  project: string
  label?: string
  rows: readonly AgentRow[]
  lead: MainState
  spend?: Record<string, Spend>
  /** When the session last did anything, as the writer saw it; 0 or absent when unknown. */
  active?: number
}

const ROUTE_KINDS: readonly RouteKind[] = ['lookup', 'routine', 'careful', 'hard', 'kept']
const STATUSES: readonly AgentStatus[] = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed']
const PHASES: readonly Phase[] = ['starting', 'thinking', 'writing', 'tool', 'done', 'failed', 'stopped']
/** A call's short argument in a live file, 60 characters at most. */
const LIVE_DETAIL = 60
const LIVE_FILES = 20
const LIVE_ID = 64
const LIVE_WHY = 80

/** How an ended agent ended, in one word: what the others see in place of its answer. */
function endWord(status: AgentStatus): string {
  return status === 'failed' ? 'failed' : status === 'killed' ? 'interrupted' : 'finished'
}

const liveCall = (tool: string, detail: string | undefined): LiveCall =>
  defined({ tool: cleanText(tool, LIVE_ID), detail: optionalText(detail, LIVE_DETAIL) }) as LiveCall

const liveRoute = (route: Route): Route =>
  defined({
    kind: route.kind,
    model: optionalText(route.model, LIVE_TEXT),
    effort: route.effort,
    maxEffort: route.maxEffort,
    isLearned: route.isLearned === true ? true : undefined,
    why: cleanText(route.why, LIVE_WHY),
    isApplied: route.isApplied,
  }) as Route

/**
 * What this session publishes: the Lead, its live subagents and its newest `LIVE_FINISHED` finished
 * ones, as its office and cards show them. Labels, status, model, effort, times, tokens, the Agent call's
 * short description, and each agent's calls (the tool and a short argument), the base names of
 * the files it edited, and counts. Never a prompt, thinking text or answer: an ended agent's
 * `doing` is one word.
 */
export function liveFileOf(input: LiveInput): LiveFile {
  const [, ...entries] = teamOf(input.rows, input.lead, input.now)
  const live = entries.filter(entry => !entry.member.isEnded)
  const ended = entries
    .filter(entry => entry.member.isEnded)
    .sort((a, b) => (b.row?.endedAt ?? 0) - (a.row?.endedAt ?? 0))
    .slice(0, LIVE_FINISHED)
  // A finished agent past the office's `FINISHED_SHOWN` gets no card on any floor: it goes in without its calls,
  // files, tool counts or route, which keeps a full file of `LIVE_AGENTS` small.
  const kept = [...live.map(entry => ({ ...entry, isBrief: false })), ...ended.map((entry, i) => ({ ...entry, isBrief: i >= FINISHED_SHOWN }))]
  const agents = kept.slice(0, LIVE_AGENTS).flatMap(({ member, row, isBrief }): LiveAgent[] => {
    if (row === undefined) return []
    const isOver = isEnded(row.status)
    const current = TOOL_ACTIVITIES.has(member.activity) ? (row.needs?.tool ?? row.tool) : undefined
    return [
      defined({
        label: cleanText(member.label, LIVE_TEXT),
        role: member.role,
        activity: member.activity,
        tool: current === undefined ? undefined : optionalText(toolName(current), LIVE_TEXT),
        model: optionalText(row.model, LIVE_TEXT),
        effort: optionalText(row.effort, LIVE_TEXT),
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        tokens: totalTokens(row.tokens),
        description: cleanText(row.description, LIVE_DESCRIPTION),
        background: row.background ? true : undefined,
        id: optionalText(row.id, LIVE_ID),
        type: optionalText(row.type, LIVE_TEXT),
        name: optionalText(row.name, LIVE_TEXT),
        status: row.status,
        phase: row.phase,
        doing: isOver ? endWord(row.status) : cleanText(row.doing, LIVE_DETAIL),
        call: isBrief || row.tool === undefined ? undefined : liveCall(row.tool, row.detail),
        tools: row.tools,
        errors: row.errors,
        steps: row.steps,
        tokenCounts: row.tokens,
        context: row.context,
        seat: member.seat,
        files: isBrief || (row.files ?? []).length === 0 ? undefined : (row.files ?? []).slice(-LIVE_FILES).map(file => cleanText(base(file), LIVE_DETAIL)),
        reads: (row.reads ?? []).length === 0 ? undefined : row.reads?.length,
        trail: isBrief ? undefined : row.trail?.map(step => ({ tool: cleanText(step.tool, LIVE_TEXT), detail: cleanText(step.detail, LIVE_DETAIL) })),
        toolCounts: isBrief ? undefined : row.toolCounts,
        needs: row.needs === undefined || isOver ? undefined : { tool: cleanText(row.needs.tool, LIVE_TEXT), since: row.needs.since },
        parentId: optionalText(row.parentId, LIVE_ID),
        route: isBrief || row.route === undefined ? undefined : liveRoute(row.route),
        fork: row.fork ? true : undefined,
      }) as LiveAgent,
    ]
  })
  const lead = input.lead
  const board = input.spend === undefined ? {} : kindSpendOf(input.spend)
  const spend = Object.values(board).some(value => value > 0) ? board : undefined
  const file = defined({
    v: 1 as const,
    id: input.id,
    beat: input.now,
    every: input.every,
    project: input.project,
    label: input.label === undefined || input.label === '' ? undefined : input.label,
    lead: defined({
      phase: lead.phase,
      model: optionalText(lead.model, LIVE_TEXT),
      effort: optionalText(lead.effort, LIVE_TEXT),
      tool: lead.phase === 'tool' && lead.tool !== undefined ? optionalText(toolName(lead.tool), LIVE_TEXT) : undefined,
      call: lead.phase === 'tool' && lead.tool !== undefined ? liveCall(lead.tool, lead.detail) : undefined,
      context: lead.context,
      window: lead.window,
    }) as LiveLead,
    agents,
    spend,
    active: input.active !== undefined && input.active > 0 ? input.active : undefined,
  }) as LiveFile
  return withinReadLimit(file)
}

/** A string's size in UTF-8 bytes, as a reader's file listing counts it. */
function utf8Bytes(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** The file less its last agents (the oldest finished go first) until a reader takes it: at most `LIVE_MAX_BYTES`. */
function withinReadLimit(file: LiveFile): LiveFile {
  let bytes = utf8Bytes(JSON.stringify({ ...file, agents: [] }))
  const fits: LiveAgent[] = []
  for (const agent of file.agents) {
    bytes += utf8Bytes(JSON.stringify(agent)) + (fits.length === 0 ? 0 : 1)
    if (bytes > LIVE_MAX_BYTES) break
    fits.push(agent)
  }
  return fits.length === file.agents.length ? file : { ...file, agents: fits }
}

/**
 * What a file says, less its heartbeat: two files with one print say the same thing. A change of
 * print is activity; a heartbeat with no change is not.
 */
export function livePrint(file: LiveFile): string {
  const { beat: _beat, every: _every, active: _active, ...said } = file
  return JSON.stringify(said)
}

/** What an ended session leaves for its resume: its label and when it last did anything. Readers skip it. */
export function closedFileOf(input: Pick<LiveInput, 'id' | 'now' | 'project' | 'label' | 'active'>): LiveFile {
  return defined({
    v: 1 as const,
    id: input.id,
    beat: input.now,
    every: IDLE_BEAT_MS,
    project: input.project,
    label: input.label === undefined || input.label === '' ? undefined : input.label,
    lead: { phase: 'idle' as const },
    agents: [],
    active: input.active !== undefined && input.active > 0 ? input.active : undefined,
    closed: true,
  }) as LiveFile
}

/** A whole number from 0 to `max`, or undefined. */
const count = (value: unknown, max = 1e12): number | undefined => {
  const number = finite(value)
  return number === undefined ? undefined : Math.min(max, Math.max(0, Math.floor(number)))
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

function parseCall(value: unknown): LiveCall | undefined {
  const call = asObject(value)
  const tool = cleanText(call?.tool, LIVE_ID)
  return call === undefined || tool === '' ? undefined : (defined({ tool, detail: optionalText(call.detail, LIVE_DETAIL) }) as LiveCall)
}

function parseTokenCounts(value: unknown): TokenCounts | undefined {
  const counts = asObject(value)
  if (counts === undefined) return undefined
  const [input, output, cacheRead, cacheWrite] = [counts.input, counts.output, counts.cacheRead, counts.cacheWrite].map(one => count(one))
  return input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined
    ? undefined
    : { input, output, cacheRead, cacheWrite }
}

function parseTrail(value: unknown): TrailStep[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(-TRAIL_KEPT).flatMap((item: unknown): TrailStep[] => {
    const step = asObject(item)
    const tool = cleanText(step?.tool, LIVE_TEXT)
    return step === undefined || tool === '' ? [] : [{ tool, detail: cleanText(step.detail, LIVE_DETAIL) }]
  })
}

function parseToolCounts(value: unknown): Record<string, number> | undefined {
  const counts = asObject(value)
  if (counts === undefined) return undefined
  const out: Record<string, number> = {}
  for (const [key, item] of Object.entries(counts).slice(0, MAX_TOOL_KINDS + 1)) {
    const name = cleanText(key, LIVE_TEXT)
    const number = count(item)
    if (name !== '' && number !== undefined) out[name] = number
  }
  return out
}

function parseRoute(value: unknown): Route | undefined {
  const route = asObject(value)
  const kind = ROUTE_KINDS.find(one => one === route?.kind)
  if (route === undefined || kind === undefined || typeof route.isApplied !== 'boolean') return undefined
  return defined({
    kind,
    model: optionalText(route.model, LIVE_TEXT),
    effort: EFFORT_LEVELS.find(one => one === route.effort),
    maxEffort: EFFORT_LEVELS.find(one => one === route.maxEffort),
    isLearned: route.isLearned === true ? true : undefined,
    why: cleanText(route.why, LIVE_WHY),
    isApplied: route.isApplied,
  }) as Route
}

function parseNeeds(value: unknown): AgentRow['needs'] {
  const needs = asObject(value)
  const since = finite(needs?.since)
  const tool = cleanText(needs?.tool, LIVE_TEXT)
  return since === undefined || tool === '' ? undefined : { tool, since }
}

function parseSpend(value: unknown): PeerSpend | undefined {
  const spend = asObject(value)
  if (spend === undefined) return undefined
  return defined({ lookup: count(spend.lookup), routine: count(spend.routine), careful: count(spend.careful), hard: count(spend.hard) }) as PeerSpend
}

/** One agent of another session's file; undefined for anything malformed. Every string cleaned, every word checked. */
function parseLiveAgent(item: unknown): LiveAgent | undefined {
  const one = asObject(item)
  if (one === undefined) return undefined
  const startedAt = finite(one.startedAt)
  const label = cleanText(one.label, LIVE_TEXT)
  if (startedAt === undefined || label === '') return undefined
  const files = Array.isArray(one.files) ? one.files.slice(-LIVE_FILES).map(file => cleanText(file, LIVE_DETAIL)).filter(nonEmpty) : undefined
  return defined({
    label,
    role: asRole(String(one.role)),
    activity: asActivity(String(one.activity)),
    tool: optionalText(one.tool, LIVE_TEXT),
    model: optionalText(one.model, LIVE_TEXT),
    effort: optionalText(one.effort, LIVE_TEXT),
    startedAt,
    endedAt: finite(one.endedAt),
    tokens: Math.max(0, finite(one.tokens) ?? 0),
    description: cleanText(one.description, LIVE_DESCRIPTION),
    background: one.background === true ? true : undefined,
    id: typeof one.id === 'string' && /^[\w.:-]{1,64}$/.test(one.id) ? one.id : undefined,
    type: optionalText(one.type, LIVE_TEXT),
    name: optionalText(one.name, LIVE_TEXT),
    status: STATUSES.find(status => status === one.status),
    phase: PHASES.find(phase => phase === one.phase),
    doing: optionalText(one.doing, LIVE_DETAIL),
    call: parseCall(one.call),
    tools: count(one.tools),
    errors: count(one.errors),
    steps: count(one.steps),
    tokenCounts: parseTokenCounts(one.tokenCounts),
    context: count(one.context),
    seat: count(one.seat, 200),
    files: files === undefined || files.length === 0 ? undefined : files,
    reads: count(one.reads, 100_000),
    trail: parseTrail(one.trail),
    toolCounts: parseToolCounts(one.toolCounts),
    needs: parseNeeds(one.needs),
    parentId: typeof one.parentId === 'string' && /^[\w.:-]{1,64}$/.test(one.parentId) ? one.parentId : undefined,
    route: parseRoute(one.route),
    fork: one.fork === true ? true : undefined,
  }) as LiveAgent
}

/**
 * Reads another session's file; undefined for anything malformed. Every string is cleaned and
 * clipped and every word checked against the radar's own lists: any process can write the folder.
 */
export function parseLiveFile(text: string): LiveFile | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const file = asObject(value)
  if (file === undefined) return undefined
  const id = typeof file.id === 'string' ? file.id : ''
  const beat = finite(file.beat)
  const every = finite(file.every)
  const lead = asObject(file.lead)
  if (file.v !== 1 || liveFileName(id) === undefined || beat === undefined || lead === undefined) return undefined
  const agents = (Array.isArray(file.agents) ? file.agents : []).slice(0, LIVE_AGENTS).flatMap((item: unknown): LiveAgent[] => {
    const agent = parseLiveAgent(item)
    return agent === undefined ? [] : [agent]
  })
  return defined({
    v: 1 as const,
    id,
    beat,
    every: every !== undefined && every >= 500 && every <= 600_000 ? every : IDLE_BEAT_MS,
    project: cleanText(file.project, LIVE_TEXT) || 'session',
    label: optionalText(file.label, LIVE_TEXT),
    lead: defined({
      phase: LEAD_PHASES.find(phase => phase === lead.phase) ?? 'idle',
      model: optionalText(lead.model, LIVE_TEXT),
      effort: optionalText(lead.effort, LIVE_TEXT),
      tool: optionalText(lead.tool, LIVE_TEXT),
      call: parseCall(lead.call),
      context: count(lead.context),
      window: count(lead.window),
    }) as LiveLead,
    agents,
    spend: parseSpend(file.spend),
    // A writer cannot have been active after its own heartbeat.
    active: count(file.active, beat) || undefined,
    closed: file.closed === true ? true : undefined,
  }) as LiveFile
}

/** A listing entry worth reading: another session's file, not empty (an ended session), not huge, written in the last day. */
export function isPeerEntry(entry: FsEntry, own: string | undefined, now: number): boolean {
  return (
    entry.kind === 'file' &&
    !entry.isLink &&
    entry.name !== own &&
    entry.name.endsWith('.json') &&
    liveFileName(entry.name.slice(0, -'.json'.length)) === entry.name &&
    entry.size > 0 &&
    entry.size <= LIVE_MAX_BYTES &&
    now - entry.mtimeMs <= LIVE_MAX_AGE_MS
  )
}

/** The status a 0.8 file's activity stands for. */
function statusFor(activity: Activity): AgentStatus {
  if (activity === 'done') return 'completed'
  if (activity === 'failed') return 'failed'
  if (activity === 'stopped') return 'killed'
  if (activity === 'idle') return 'idle'
  if (activity === 'starting') return 'pending'
  return 'running'
}

/** The phase a 0.8 file's activity stands for. */
function phaseFor(activity: Activity): Phase {
  if (activity === 'done' || activity === 'failed' || activity === 'stopped' || activity === 'starting' || activity === 'thinking' || activity === 'writing') {
    return activity
  }
  return activity === 'idle' ? 'thinking' : 'tool'
}

/** Another session's agents as rows, the shape this session's own cards and office draw from. */
export function peerRowsOf(file: LiveFile): AgentRow[] {
  const ids = new Set<string>()
  return file.agents.map((agent, index): AgentRow => {
    const activity = asActivity(agent.activity)
    const status = agent.status ?? statusFor(activity)
    const isOver = isEnded(status)
    const wanted = agent.id ?? `p${index + 1}`
    const id = ids.has(wanted) ? `${wanted}-${index + 1}` : wanted
    ids.add(id)
    const call = agent.call ?? (agent.tool === undefined ? undefined : { tool: agent.tool })
    // A 0.8 file says only that an agent waits on the person: it has waited long enough to show.
    const needs = agent.needs ?? (activity === 'waiting-you' && !isOver ? { tool: call?.tool ?? 'a tool', since: 0 } : undefined)
    return defined({
      id,
      type: agent.type ?? agent.label,
      name: agent.type === undefined ? agent.label : agent.name,
      description: agent.description,
      model: agent.model,
      effort: agent.effort,
      status,
      phase: agent.phase ?? phaseFor(activity),
      doing: agent.doing ?? (isOver ? endWord(status) : ACTIVITY_WORDS[activity]),
      tools: agent.tools ?? 0,
      errors: agent.errors,
      steps: agent.steps,
      tokens: agent.tokenCounts ?? (agent.tokens > 0 ? { input: agent.tokens, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined),
      context: agent.context,
      seat: agent.seat ?? index + 1,
      tool: call?.tool,
      detail: call?.detail,
      files: agent.files,
      readCount: agent.reads,
      trail: agent.trail,
      toolCounts: agent.toolCounts,
      needs,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt ?? (isOver ? agent.startedAt : undefined),
      background: agent.background === true,
      fork: agent.fork === true,
      parentId: agent.parentId,
      route: agent.route,
    }) as AgentRow
  })
}

/** Another session's Lead, as this session's own Lead card draws it. */
export function peerLeadOf(lead: LiveLead): MainState {
  const call = lead.call ?? (lead.tool === undefined ? undefined : { tool: lead.tool })
  return defined({
    model: lead.model ?? '',
    effort: lead.effort,
    phase: lead.phase,
    tool: call?.tool,
    detail: call?.detail,
    context: lead.context,
    window: lead.window,
  }) as MainState
}

/** How the other sessions are sorted out: the idle cutoff, the floor cap, and the changes a reader saw. */
export type PeerOptions = {
  /** How long an idle session keeps its dim floor. */
  idleMs: number
  /** How many other sessions get a floor. */
  floors: number
  /** `/radar sessions all`: every live session gets a floor, idle or past the cap. */
  isAll: boolean
  /** When this reader saw each session's file say something new: activity for a file that carries no `active`. */
  changedAt?: ReadonlyMap<string, number>
}

export const DEFAULT_PEER_OPTIONS: PeerOptions = { idleMs: DEFAULT_IDLE_HOURS * 3_600_000, floors: DEFAULT_FLOORS, isAll: false }

/**
 * When a session last did anything: the newest of its writer's own word (a Lead turn, a subagent
 * change, any change to what it publishes), a change this reader saw, and its agents' starts and
 * ends. Never later than its heartbeat; 0 when nothing says.
 */
export function lastActiveOf(file: LiveFile, changedAt?: number): number {
  let latest = Math.max(file.active ?? 0, changedAt ?? 0)
  for (const agent of file.agents) latest = Math.max(latest, agent.startedAt, agent.endedAt ?? 0)
  return Math.min(latest, file.beat)
}

/**
 * The other sessions at `now`, ranked: the newest file of each, this session's own, closed ones
 * and silent ones (no heartbeat for 20 s, or three of their own beats) left out. Working sessions
 * first, then by their last activity. An idle session whose last activity is `idleMs` old or more
 * (or unknown) is hidden; past the first `floors`, the rest are hidden too. `isAll` hides none.
 */
export function peerSessionsOf(
  files: readonly LiveFile[],
  selfId: string | undefined,
  now: number,
  options: PeerOptions = DEFAULT_PEER_OPTIONS,
): PeerSession[] {
  const newest = new Map<string, LiveFile>()
  for (const file of files) {
    if (file.id === selfId) continue
    const known = newest.get(file.id)
    if (known === undefined || known.beat < file.beat) newest.set(file.id, file)
  }
  const sessions: PeerSession[] = []
  for (const file of newest.values()) {
    if (file.closed === true || now - file.beat > Math.max(GONE_AFTER_MS, 3 * file.every)) continue
    const rows = peerRowsOf(file)
    const lead = peerLeadOf(file.lead)
    const live = rows.filter(row => !isEnded(row.status)).length
    const state: PeerSession['state'] = live > 0 || lead.phase !== 'idle' ? 'working' : 'idle'
    const activeAt = lastActiveOf(file, options.changedAt?.get(file.id))
    const isOld = state === 'idle' && (activeAt === 0 || now - activeAt >= options.idleMs)
    // A floor with agents at work is drawn at now, in steps of 5 s: their times move, and the pane is
    // drawn again no more often than that (each drawing hands its buttons new press handles, and a
    // click on the drawing before is dropped). Any other floor is drawn at its last activity: still.
    const asOf = live > 0 ? Math.floor(Math.max(now, file.beat) / ELAPSED_STEP_MS) * ELAPSED_STEP_MS : activeAt
    sessions.push(
      defined({
        id: file.id,
        name: file.label ?? file.project,
        state,
        activeAt,
        idleMinutes: state === 'idle' && activeAt > 0 ? Math.floor(Math.max(0, now - activeAt) / 60_000) : undefined,
        hiddenBy: isOld && !options.isAll ? 'idle' : undefined,
        asOf,
        lead,
        rows,
        spend: file.spend ?? {},
        live,
        done: rows.length - live,
        waiting: rows.filter(row => isWaiting(row, asOf)).length,
      }) as PeerSession,
    )
  }
  // Sessions in one folder share its name: a short id tells them apart.
  const counts = new Map<string, number>()
  for (const one of sessions) counts.set(one.name.toLowerCase(), (counts.get(one.name.toLowerCase()) ?? 0) + 1)
  const ranked = sessions
    .map(one => ((counts.get(one.name.toLowerCase()) ?? 0) > 1 ? { ...one, name: `${one.name} #${one.id.slice(0, 4)}` } : one))
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        Number(a.hiddenBy !== undefined) - Number(b.hiddenBy !== undefined) ||
        b.activeAt - a.activeAt ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
  let shown = 0
  return ranked.map(one => {
    if (one.hiddenBy !== undefined || options.isAll) return one
    shown += 1
    return shown > options.floors ? { ...one, hiddenBy: 'cap' as const } : one
  })
}

/** Another session's team: its Lead and agents, labelled and placed as on its own floor. */
export function peerTeamOf(peer: PeerSession): TeamEntry[] {
  return teamOf(peer.rows, peer.lead, peer.asOf)
}

/** What the band says of the other sessions: how many work, their live agents, and who waits on the person. */
export function peerBandOf(list: readonly PeerSession[]): PeerBand {
  const working = list.filter(one => one.state === 'working' && one.live > 0)
  return {
    sessions: working.length,
    agents: working.reduce((sum, one) => sum + one.live, 0),
    waiting: working
      .flatMap(one =>
        peerTeamOf(one)
          .filter(entry => !entry.member.isEnded && entry.member.activity === 'waiting-you')
          .map(entry => `${entry.member.label} in ${one.name}`),
      )
      .slice(0, 3),
  }
}

/** The band's words for the other sessions: "2 other sessions · 5 agents working". */
export function peerBandWords(band: PeerBand): string {
  return `${plural(band.sessions, 'other session')} · ${plural(band.agents, 'agent')} working`
}

/** Another session's Lead in a few words: "thinking", "at the terminal · Bash". */
function leadWords(lead: MainState): string {
  if (lead.phase === 'idle') return 'waiting for a message'
  const activity = activityOf({ status: 'running', phase: lead.phase, tool: lead.tool, isWaiting: false })
  return statusLine(activity, lead.tool, undefined, '')
}

/**
 * Another session on one line: its number for `/radar expand`, its name, how many agents work and
 * the one most worth a look (one that waits on the person, else the longest at work).
 */
export function peerLine(peer: PeerSession, index: number, isExpanded = false): string {
  return `${isExpanded ? '▾' : '▸'} ${index} ${peer.name} · ${peerParts(peer).join(' · ')}`
}

/** What another session does, in a few parts: how many work, the one most worth a look, how long. */
export function peerParts(peer: PeerSession): string[] {
  const parts: string[] = []
  const live = peerTeamOf(peer).filter(entry => entry.row !== undefined && !entry.member.isEnded)
  const waiting = live.find(entry => entry.member.activity === 'waiting-you')
  const longest = [...live].sort((a, b) => (a.row?.startedAt ?? 0) - (b.row?.startedAt ?? 0))[0]
  if (waiting !== undefined) {
    parts.push(`${live.length} working`, `${waiting.member.label} ${statusLine('waiting-you', waiting.row?.needs?.tool, undefined, '')}`)
  } else if (longest !== undefined) {
    const doing = statusLine(longest.member.activity, longest.row?.tool, undefined, '')
    parts.push(`${live.length} working`, `${longest.member.label} ${doing}`, formatElapsed(peer.asOf - (longest.row?.startedAt ?? peer.asOf)))
  } else if (peer.state === 'working') {
    parts.push(`Lead ${leadWords(peer.lead)}`)
  } else if (peer.state === 'idle') {
    parts.push(idleWords(peer.idleMinutes))
  }
  if (peer.done > 0) parts.push(`${peer.done} done`)
  return parts
}

/** The sessions that get a floor: working and recently idle ones up to the cap, and any opened one. */
export function floorsShownOf(list: readonly PeerSession[], expanded: ReadonlySet<string>): NumberedPeer[] {
  return list
    .map((peer, at): NumberedPeer => ({ peer, index: at + 1 }))
    .filter(({ peer }) => peer.hiddenBy === undefined || expanded.has(peer.id))
}

/** A session's name and the short id that tells two of one folder apart: "claude #7f1a" is "claude" and "#7f1a". */
export function splitTag(name: string): { name: string; tag?: string } {
  const found = /^(.+) (#[\w-]{4})$/.exec(name)
  return found === null ? { name } : { name: found[1] ?? name, tag: found[2] }
}

/** `12m`, `1h 05m`: how long a floor has been idle; nothing under a minute. */
function idleSpan(minutes: number | undefined): string | undefined {
  if (minutes === undefined || minutes < 1) return undefined
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

const THINKING: ReadonlySet<Activity> = new Set(['thinking', 'writing'])

/**
 * The building's floors, top down: each session's label as fields (number, name, tone, the one
 * agent worth a look and its tool, the time, the count) and its people at the windows, Lead first.
 */
export function buildingFloorsOf(shown: readonly NumberedPeer[], expanded: ReadonlySet<string>): BuildingFloor[] {
  return shown.map(({ peer, index }) => {
    const team = peerTeamOf(peer)
    const members = team
      .map(entry => entry.member)
      .filter(member => !member.isEnded)
      .sort((a, b) => a.seat - b.seat)
    const live = team.filter(entry => entry.row !== undefined && !entry.member.isEnded)
    const waiting = live.find(entry => entry.member.activity === 'waiting-you')
    const longest = [...live].sort((a, b) => (a.row?.startedAt ?? 0) - (b.row?.startedAt ?? 0))[0]
    const focus = waiting ?? longest
    const lead = team[0]?.member
    const toolOf = (activity: Activity, tool: string | undefined): string | undefined =>
      tool !== undefined && TOOL_ACTIVITIES.has(activity) ? toolName(tool) : undefined
    const { name, tag } = splitTag(peer.name)
    const base = {
      id: peer.id,
      index,
      name,
      ...(tag === undefined ? {} : { tag }),
      isOpen: expanded.has(peer.id),
      members: members.slice(0, WINDOWS),
      ...(live.length > 1 ? { count: `${live.length} at work` } : {}),
    }
    if (peer.state === 'idle') return defined({ ...base, tone: 'idle' as const, status: 'idle', time: idleSpan(peer.idleMinutes) }) as BuildingFloor
    if (focus !== undefined) {
      const activity = focus.member.activity
      const tone = waiting !== undefined ? ('waiting' as const) : THINKING.has(activity) ? ('thinking' as const) : ('working' as const)
      return defined({
        ...base,
        tone,
        status: `${focus.member.label} ${ACTIVITY_WORDS[activity]}`,
        tool: waiting === undefined ? toolOf(activity, focus.row?.tool) : waiting.row?.needs?.tool === undefined ? undefined : toolName(waiting.row.needs.tool),
        time: formatElapsed(peer.asOf - (focus.row?.startedAt ?? peer.asOf)),
      }) as BuildingFloor
    }
    const activity = lead?.activity ?? 'working'
    return defined({
      ...base,
      tone: THINKING.has(activity) ? ('thinking' as const) : ('working' as const),
      status: `Lead ${ACTIVITY_WORDS[activity]}`,
      tool: toolOf(activity, peer.lead.tool),
    }) as BuildingFloor
  })
}

/** `idle`, `idle 12m`, `idle 1h 05m`: how long a session has done nothing. */
export function idleWords(minutes: number | undefined): string {
  if (minutes === undefined || minutes < 1) return 'idle'
  return `idle ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`}`
}

/** The line under the floors for the sessions with none: "+3 idle sessions hidden · /radar sessions all". */
export function hiddenLine(list: readonly PeerSession[], floors: number, expanded: ReadonlySet<string> = new Set()): string {
  const idle = list.filter(one => one.hiddenBy === 'idle' && !expanded.has(one.id)).length
  const capped = list.filter(one => one.hiddenBy === 'cap' && !expanded.has(one.id)).length
  const parts = [
    ...(capped > 0 ? [`+${capped} more past the ${plural(floors, 'floor')} · /radar floors <n>`] : []),
    ...(idle > 0 ? [`+${plural(idle, 'idle session')} hidden`] : []),
  ]
  return parts.length === 0 ? '' : `${parts.join(' · ')} · /radar sessions all`
}

export type NumberedPeer = { peer: PeerSession; index: number }

/** One floor as the pane draws it: this session's (no `peer`) or another's. */
type FloorScope = { team: TeamEntry[]; lead: MainState; now: number; spend: KindSpend; peer?: PeerSession }

/** A floor Raster the terminal's frame timer repaints: a closed floor's strip, or an open floor's office. */
export type FloorPaint = { key: string; peerId: string; kind: 'building' | 'office' }

/** The session `target` names: its number in the list, its name, or the start of its name or id when only one fits. */
export function findPeer(list: readonly PeerSession[], target: string): PeerSession | undefined {
  const key = target.trim().toLowerCase()
  if (key === '') return undefined
  if (/^\d+$/.test(key)) return list[Number(key) - 1]
  const exact = list.find(one => one.name.toLowerCase() === key)
  if (exact !== undefined) return exact
  const starts = list.filter(one => one.name.toLowerCase().startsWith(key) || one.id.toLowerCase().startsWith(key))
  return starts.length === 1 ? starts[0] : undefined
}

/** `/radar sessions`: how this session shows to the others, then one line per other session. */
export function sessionsText(list: readonly PeerSession[], selfName: string, isOn: boolean): string {
  const head = `This session shows as "${selfName}" (rename it: /radar name <label>).`
  if (!isOn) return `${head}\nOther sessions are hidden here: /radar sessions on shows them.`
  if (list.length === 0) return `${head}\n${NO_PEERS}`
  const why = (peer: PeerSession): string =>
    peer.hiddenBy === 'idle' ? ' (no floor: idle too long)' : peer.hiddenBy === 'cap' ? ' (no floor: past the cap)' : ''
  return [head, ...list.map((peer, at) => `${peerLine(peer, at + 1)}${why(peer)}`), '/radar expand <n> shows one in the Team pane.'].join('\n')
}

/** This session's info with the label set, or cleared with ''; the same object when nothing changes. */
export function withLabel(info: SelfInfo, label: string): SelfInfo {
  if ((info.label ?? '') === label) return info
  return label === '' ? defined({ ...info, label: undefined }) as SelfInfo : { ...info, label }
}

/** The expanded list with `ids` shown or hidden; the same list when nothing changes. */
export function withExpanded(info: SelfInfo, ids: readonly string[], isShown: boolean): SelfInfo {
  const kept = isShown
    ? [...info.expanded, ...ids.filter(id => !info.expanded.includes(id))].slice(-EXPANDED_KEPT)
    : info.expanded.filter(id => !ids.includes(id))
  return kept.length === info.expanded.length && kept.every((id, at) => info.expanded[at] === id) ? info : { ...info, expanded: kept }
}

// ---------------------------------------------------------------------------
// State writes. Each one skips the write when `fn` hands back the value it got.
// One helper per atom: `claude plugin validate` reads each atom where it is named.
// ---------------------------------------------------------------------------

async function commitSkills(
  $: EngineInterface,
  fn: (value: SkillUse[]) => SkillUse[],
): Promise<void> {
  const current = await read($, skills)
  if (fn(current) === current) return
  await update($, skills, fn)
}

async function commitAgents(
  $: EngineInterface,
  fn: (value: AgentRow[]) => AgentRow[],
): Promise<void> {
  const current = await read($, agents)
  if (fn(current) === current) return
  await update($, agents, fn)
}

async function commitMain(
  $: EngineInterface,
  fn: (value: MainState) => MainState,
): Promise<void> {
  const current = await read($, main)
  if (fn(current) === current) return
  await update($, main, fn)
}

async function commitNow($: EngineInterface, fn: (value: number) => number): Promise<void> {
  const current = await read($, clockNow)
  if (fn(current) === current) return
  await update($, clockNow, fn)
}

async function commitPrefs(
  $: EngineInterface,
  fn: (value: RouterSettings) => RouterSettings,
): Promise<void> {
  const current = await read($, prefs)
  if (fn(current) === current) return
  await update($, prefs, fn)
}

async function commitBook($: EngineInterface, fn: (value: RouteBook) => RouteBook): Promise<void> {
  const current = await read($, routeBook)
  if (fn(current) === current) return
  await update($, routeBook, fn)
}

async function commitSpend(
  $: EngineInterface,
  fn: (value: Record<string, Spend>) => Record<string, Spend>,
): Promise<void> {
  const current = await read($, spend)
  if (fn(current) === current) return
  await update($, spend, fn)
}

async function commitConflicts($: EngineInterface, fn: (value: Conflict[]) => Conflict[]): Promise<void> {
  const current = await read($, conflicts)
  if (fn(current) === current) return
  await update($, conflicts, fn)
}

async function commitOutcomes($: EngineInterface, fn: (value: Outcome[]) => Outcome[]): Promise<void> {
  const current = await read($, outcomes)
  if (fn(current) === current) return
  await update($, outcomes, fn)
}

async function commitStoreKey($: EngineInterface, fn: (value: string) => string): Promise<void> {
  const current = await read($, storeKey)
  if (fn(current) === current) return
  await update($, storeKey, fn)
}

async function commitView($: EngineInterface, fn: (value: ViewPrefs) => ViewPrefs): Promise<void> {
  const current = await read($, viewPrefs)
  if (fn(current) === current) return
  await update($, viewPrefs, fn)
}

/** The other sessions, written only when what the pane shows of them changed: a write redraws it. */
async function commitPeers($: EngineInterface, list: PeerSession[]): Promise<void> {
  const current = await read($, peers)
  if (JSON.stringify(current) === JSON.stringify(list)) return
  await update($, peers, () => list)
}

async function commitPeerBand($: EngineInterface, band: PeerBand): Promise<void> {
  const current = await read($, peerBand)
  if (JSON.stringify(current) === JSON.stringify(band)) return
  await update($, peerBand, () => band)
}

async function commitSelf($: EngineInterface, fn: (value: SelfInfo) => SelfInfo): Promise<void> {
  const current = await read($, selfInfo)
  if (fn(current) === current) return
  await update($, selfInfo, fn)
}

/** The view switches from disk, kept across sessions. No session text: three settings. */
async function loadView($: EngineInterface): Promise<void> {
  try {
    const saved = asView(await $.store.get(VIEW_KEY))
    if (saved !== undefined) await commitView($, current => withView(current, saved))
  } catch {
    // The defaults stand.
  }
}

/** A view change: in this session's state, then on disk for the next sessions. */
async function changeView($: EngineInterface, change: Partial<ViewPrefs>): Promise<ViewPrefs> {
  await commitView($, current => withView(current, change))
  const now = await read($, viewPrefs)
  try {
    await $.store.set(VIEW_KEY, now)
  } catch {
    // It holds for this session anyway.
  }
  return now
}

/**
 * One terminal frame of the office, painted over the mounted Raster. False when it could not be
 * (the pane closed, the width changed): the next drawing mounts it again.
 */
async function paintOfficeFrame($: EngineInterface, columns: number): Promise<boolean> {
  try {
    const view = await read($, viewPrefs)
    if (!view.motion || view.layout === 'cards') return false
    const now = await $.clock.now()
    const team = teamOf(await read($, agents), await read($, main), now)
    const frame = officeRaster(
      team.map(entry => entry.member),
      kindSpendOf(await read($, spend)),
      { columns, now, labels: view.labels, motion: true, arena: isArenaTeam(team) },
    )
    if (frame === undefined) return false
    const done = await $.ui.blit({ requestId: PANE, key: OFFICE_KEY, cells: frame.cells, columns: frame.columns, rows: frame.rows })
    return done.deny === undefined && isMoving(team, now)
  } catch {
    return false
  }
}

/**
 * One terminal frame of what moves among the other floors the pane mounted: the building while a
 * floor works, an open floor's office while it works. True while any of them moves.
 */
async function paintFloorFrames($: EngineInterface, columns: number, paints: readonly FloorPaint[]): Promise<boolean> {
  try {
    const view = await read($, viewPrefs)
    if (!view.motion || paints.length === 0) return false
    const list = await read($, peers)
    const info = await read($, selfInfo)
    const now = await $.clock.now()
    let isAny = false
    for (const paint of paints) {
      let frame: ReturnType<typeof officeRaster>
      if (paint.kind === 'building') {
        const expanded = new Set(info.expanded)
        const floors = buildingFloorsOf(floorsShownOf(list, expanded), expanded)
        if (!isBuildingMoving(floors)) continue
        frame = buildingRaster(floors, { columns, now, motion: true })
      } else {
        const peer = list.find(one => one.id === paint.peerId)
        if (peer === undefined || peer.state !== 'working') continue
        const peerTeam = peerTeamOf(peer)
        const members = peerTeam.map(entry => entry.member)
        frame = officeRaster(members, peer.spend, { columns, now, labels: view.labels, motion: true, walks: false, arena: isArenaTeam(peerTeam) })
      }
      if (frame === undefined) continue
      const done = await $.ui.blit({ requestId: PANE, key: paint.key, cells: frame.cells, columns: frame.columns, rows: frame.rows })
      if (done.deny === undefined) isAny = true
    }
    return isAny
  } catch {
    return false
  }
}

/** A floor's button: opens another session's floor, or closes it, as it stands now. */
async function toggleFloor($: EngineInterface, id: string): Promise<void> {
  await commitSelf($, current => withExpanded(current, [id], !current.expanded.includes(id)))
}

/** Runs state work that must never break the call or the stream it rides on. */
async function guard(work: () => unknown): Promise<void> {
  try {
    await work()
  } catch {
    // The radar only watches. A failed write costs a redraw, never a tool call.
  }
}

type LivePhase = Exclude<MainState['phase'], 'idle'>

async function setPhase(
  $: EngineInterface,
  id: string | undefined,
  phase: LivePhase,
  doing?: string,
): Promise<void> {
  if (id === undefined) {
    // Between turns a call is not the Lead's work (the host or a plugin raised it): it stays idle.
    await commitMain($, lead => (lead.turnId === undefined || lead.phase === phase ? lead : { ...lead, phase }))
    return
  }
  await commitAgents($, rows =>
    patchRows(rows, id, row =>
      isEnded(row.status) ? {} : doing === undefined ? { phase } : { phase, doing },
    ),
  )
}

async function agentLabel($: EngineInterface, id: string | undefined): Promise<string | undefined> {
  if (id === undefined) return undefined
  const row = (await read($, agents)).find(one => one.id === id)
  return row === undefined ? undefined : (row.name ?? row.type)
}

async function sight(
  $: EngineInterface,
  name: string,
  how: SkillUse['how'],
  by?: string,
): Promise<void> {
  await commitSkills($, list => recordSkill(list, name, how, by))
}

/** The effort the spawning loop runs on: the main loop's, or a subagent's row. */
async function parentEffortOf(
  $: EngineInterface,
  parentId: string | undefined,
): Promise<string | undefined> {
  if (parentId === undefined) return (await read($, main)).effort
  return (await read($, agents)).find(row => row.id === parentId)?.effort
}

/**
 * Decides one spawn. It hands back the call to send and the pick behind it. It fails open:
 * on any error the call goes through as it came, and the radar shows no pick.
 */
async function planSpawn(
  $: EngineInterface,
  call: AgentSpawnInput,
  callEffort: string | undefined,
): Promise<{ route?: Route; sent: AgentSpawnInput }> {
  try {
    const past = await read($, outcomes)
    const facts = { ...call, seed: call.tool_use_id, ...(callEffort === undefined ? {} : { callEffort }) }
    const route = chooseRoute(facts, await read($, prefs), await parentEffortOf($, call.parentAgentId), lessonsFrom(past), historyFrom(past))
    if (route === undefined) return { sent: call }
    await commitBook($, book =>
      addPending(book, {
        toolUseId: call.tool_use_id,
        type: call.subagentType,
        description: call.description,
        route,
      }),
    )
    const sent = route.isApplied && route.model !== undefined ? { ...call, model: route.model } : call
    return { route, sent }
  } catch {
    return { sent: call }
  }
}

/** The pick for an agent's step. A step that beats the spawn's answer claims it from the pending list. */
async function routeFor($: EngineInterface, id: string): Promise<Route | undefined> {
  try {
    const book = await read($, routeBook)
    const known = book.byAgent[id]
    if (known !== undefined) return known
    if (book.pending.length === 0) return undefined
    const listed = (await $.agent.list()).find(one => one.id === id)
    if (listed === undefined) return undefined
    await commitBook($, current => claimRoute(current, id, listed.type, listed.description))
    return (await read($, routeBook)).byAgent[id]
  } catch {
    return undefined
  }
}

/** How many of an agent's tool calls failed or were refused. It never rejects. */
async function errorsOf($: EngineInterface, id: string): Promise<number> {
  try {
    return (await read($, agents)).find(row => row.id === id)?.errors ?? 0
  } catch {
    return 0
  }
}

/** Adds one response's tokens to the agent's card and to its kind's total. Unknown agents count nowhere. */
async function recordUsage($: EngineInterface, id: string, usage: UsageLike): Promise<void> {
  const row = (await read($, agents)).find(one => one.id === id)
  if (row === undefined) return
  await commitAgents($, rows =>
    patchRows(rows, id, current => ({
      tokens: addTokens(current.tokens, usage),
      context: contextOf(usage),
      steps: (current.steps ?? 0) + 1,
    })),
  )
  await commitSpend($, book => addSpendTokens(book, spendKind(row.route), totalTokens(addTokens(undefined, usage))))
}

/** Notes a file an agent edits, and says so once when another live agent edited it too. */
async function noteEdit($: EngineInterface, id: string, path: string): Promise<void> {
  const key = path.toLowerCase()
  await commitAgents($, rows => patchRows(rows, id, row => ({ files: noteFile(row.files, path) })))
  const rows = await read($, agents)
  const rivals = rivalsOf(rows, id, key)
  if (rivals.length === 0) return
  const at = await $.clock.now()
  const ids = [...rivals, id]
  if (!addConflict(await read($, conflicts), key, path, ids, at).isNew) return
  await commitConflicts($, list => addConflict(list, key, path, ids, at).list)
  const names = ids.map(one => {
    const row = rows.find(each => each.id === one)
    return row === undefined ? 'an agent' : (row.name ?? row.type)
  })
  $.ui.toast(`${names.length} subagents edited ${base(path)}: ${names.join(', ')}`)
}

/** Marks an agent as waiting for the person's approval, and says so if it still waits a moment later. */
async function markNeeds($: EngineInterface, id: string, tool: string): Promise<void> {
  const since = await $.clock.now()
  await commitAgents($, rows => patchRows(rows, id, row => (isEnded(row.status) ? {} : { needs: { tool, since } })))
  $.clock.after(NEEDS_SHOWN_AFTER_MS, () => {
    void alertNeeds($, id, since)
  })
}

/** The toast for an agent that still waits for approval. A settled ask says nothing. */
async function alertNeeds($: EngineInterface, id: string, since: number): Promise<void> {
  try {
    const row = (await read($, agents)).find(one => one.id === id)
    if (row?.needs === undefined || row.needs.since !== since || isEnded(row.status)) return
    $.ui.toast(`${row.name ?? row.type} needs your approval: ${row.needs.tool}`)
  } catch {
    // A toast is a courtesy; the card shows the wait anyway.
  }
}

/** When the newest gauntlet agent of this session started: 0 with none. */
async function newestGauntletStart($: EngineInterface): Promise<number> {
  const rows = await read($, agents)
  return Math.max(0, ...rows.filter(row => gauntletOf(row.description) !== undefined).map(row => row.startedAt))
}

/**
 * Records how a routed agent's run went: in this session's state, and on disk under this
 * session's own `$.store` key. Only kinds, flags, token counts and times: no prompt or answer text.
 */
async function recordOutcome($: EngineInterface, id: string): Promise<void> {
  const row = (await read($, agents)).find(one => one.id === id)
  if (row === undefined || row.isTaught === true) return
  const outcome = outcomeOf(row, await $.clock.now())
  if (outcome === undefined) return
  // Once per agent: a resumed one ends again, and its later work was never routed.
  await commitAgents($, rows => patchRows(rows, id, { isTaught: true }))
  await commitOutcomes($, list => trimOutcomes([...list, outcome]))
  const key = await read($, storeKey)
  if (key === '') return
  const saved = asOutcomes(await $.store.get(key))
  await $.store.set(key, [...saved, outcome].slice(-MAX_OUTCOMES_PER_SESSION))
}

/** This session's name for its store key: its id, or when that is not offered, its start time. */
async function sessionKeyOf($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return `started-${(await $.session.usage({ breakdown: 'summary' })).startedAt}`
  }
}

/** Reads every session's outcomes from disk, and drops the oldest sessions past the cap. */
async function loadOutcomes($: EngineInterface): Promise<void> {
  try {
    const own = `${OUTCOME_PREFIX}${await sessionKeyOf($)}`
    await commitStoreKey($, () => own)
    const keys = (await $.store.keys()).filter(key => key.startsWith(OUTCOME_PREFIX))
    const saved: { key: string; items: Outcome[]; last: number }[] = []
    for (const key of keys) {
      const items = asOutcomes(await $.store.get(key))
      saved.push({ key, items, last: items.reduce((latest, one) => Math.max(latest, one.at), 0) })
    }
    saved.sort((a, b) => b.last - a.last)
    for (const stale of saved.slice(MAX_STORE_SESSIONS)) {
      if (stale.key !== own) await $.store.delete(stale.key)
    }
    const merged = trimOutcomes(saved.slice(0, MAX_STORE_SESSIONS).flatMap(one => one.items))
    await commitOutcomes($, () => merged)
  } catch {
    // Learning waits for the next start; routing goes on without it.
  }
}

/** `/radar learn reset`: deletes every session's outcomes. Hands back how many sessions it cleared. */
async function forgetOutcomes($: EngineInterface): Promise<number> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(OUTCOME_PREFIX))
  for (const key of keys) await $.store.delete(key)
  await commitOutcomes($, list => (list.length === 0 ? list : []))
  return keys.length
}

/**
 * The matchers for the skills the session lists, from a local estimate (no network).
 * It answers an empty list when the session is not ready, and never rejects.
 */
async function fetchMatchers($: EngineInterface): Promise<SkillMatcher[]> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const list = usage.context.breakdown?.skills?.skillFrontmatter ?? []
    const window = usage.context.window
    if (typeof window === 'number' && window > 0) {
      await commitMain($, lead => (lead.window === window ? lead : { ...lead, window }))
    }

    return buildMatchers(list.map(skill => skill.name))
  } catch {
    return []
  }
}

/**
 * Whether the pane must still be drawn again for `row`: it is live, or its last walk may not have
 * been drawn finished yet. A repaint (a click back into the window) shows the last drawing again,
 * and a picture left mid-walk walks the agent to the lounge again at every click.
 */
export function isSettling(row: AgentRow, now: number): boolean {
  if (!isEnded(row.status)) return true
  return now - Math.max(row.startedAt, row.endedAt ?? row.startedAt) < SETTLE_MS
}

/** One timer tick: bring the rows in line with the session's agents, and move the clock. */
async function tick($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now()
    const listed = await $.agent.list()
    await commitAgents($, rows => reconcile(rows, listed, now))
    const rows = await read($, agents)
    // The colosseum turns off by time alone, so a draw is needed each second while it is on, and once after.
    const team = teamOf(rows, await read($, main), now)
    const isArena = isArenaTeam(team)
    const wasArena = arenaWas
    arenaWas = isArena
    if (rows.some(row => isSettling(row, now)) || isArena || wasArena) await commitNow($, () => now)
  } catch {
    // The next tick tries again.
  }
}

/** Whether the last tick saw the colosseum, in module memory: a reload starts it over. */
let arenaWas = false

/** What the live timer keeps between its ticks, in module memory: a reload starts it over. */
export type LiveMemory = {
  home?: string
  /** This session's id as last published: its own file is never read as another's. */
  selfId?: string
  lastBeatAt: number
  lastBusy?: boolean
  lastReadAt: number
  /** The label changed: write at the next tick, whatever the beat. */
  isDirty: boolean
  isSyncing: boolean
  /** Ended sessions (a /clear ends one and goes on under a new id): their files say so, and stay that way. */
  closed: Set<string>
  /**
   * The other sessions' files by name, with the listing's size and time they were read at, what
   * the file said (its print) and the heartbeat at which that last changed.
   */
  cache: Map<string, { size: number; mtimeMs: number; file?: LiveFile; print?: string; changedAt?: number }>
  /** The writes of this session's own file, in order: an end's write lands after any beat in flight. */
  writes: Promise<void>
  /** When this session last did anything: what it last published changed. 0 until something does. */
  activeAt: number
  /** The other sessions as last shown: their shape, and when. */
  peersShape?: string
  peersShownAt: number
  /** What this session last published, less its heartbeat. */
  lastPrint?: string
  /** The start's read of this session's own file: a beat waits for it, so the last activity carries over. */
  ready: Promise<void>
}

export function newLiveMemory(): LiveMemory {
  return {
    lastBeatAt: 0,
    lastReadAt: 0,
    isDirty: false,
    isSyncing: false,
    closed: new Set(),
    cache: new Map(),
    writes: Promise.resolve(),
    activeAt: 0,
    peersShownAt: 0,
    ready: Promise.resolve(),
  }
}

/** The live folder, from the home folder; undefined when there is none, and nothing is read or written. */
async function liveDir($: EngineInterface, memory: LiveMemory): Promise<string | undefined> {
  if (memory.home === undefined) {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') return undefined
    memory.home = home
  }
  return liveDirOf(memory.home)
}

/** Writes this session's own file, after any write before it. It is the one file the radar writes. */
function writeOwn($: EngineInterface, memory: LiveMemory, dir: string, id: string, text: string, isClosing = false): Promise<void> {
  const name = liveFileName(id)
  if (name === undefined) return memory.writes
  memory.writes = memory.writes
    .then(async () => {
      // An ended session's file stays closed: only the end's own write lands.
      if (!isClosing && memory.closed.has(id)) return
      await $.fs.write(`${dir}/${name}`, text)
    })
    .catch(() => undefined)
  return memory.writes
}

/** Publishes this session when its beat is due: every 2 s while busy, every 5 s while idle, at once when that changes. */
async function publishLive($: EngineInterface, memory: LiveMemory, now: number): Promise<void> {
  await memory.ready
  const dir = await liveDir($, memory)
  if (dir === undefined) return
  const rows = await read($, agents)
  const lead = await read($, main)
  const busy = isBusy(rows, lead)
  const every = busy ? BUSY_BEAT_MS : IDLE_BEAT_MS
  if (!memory.isDirty && busy === memory.lastBusy && now - memory.lastBeatAt < every) return
  const id = await $.session.id()
  if (liveFileName(id) === undefined || memory.closed.has(id)) return
  // The session went on under a new id with no end seen: its file under the old id is emptied too.
  const previous = memory.selfId
  if (previous !== undefined && previous !== id && !memory.closed.has(previous)) await closeFile($, memory, dir, previous, now)
  const project = projectName(await $.session.root())
  await commitSelf($, current => (current.project === project ? current : { ...current, project }))
  const info = await read($, selfInfo)
  memory.selfId = id
  memory.isDirty = false
  memory.lastBusy = busy
  memory.lastBeatAt = now
  const board = await read($, spend)
  const file = liveFileOf({ id, now, every, project, label: info.label, rows, lead, spend: board })
  // A change to what it says is activity; the same words again are only a heartbeat. The first beat
  // after a start or a reload has nothing to compare with: the last activity carries over.
  const print = livePrint(file)
  if (memory.lastPrint !== undefined && print !== memory.lastPrint) memory.activeAt = now
  memory.lastPrint = print
  await writeOwn($, memory, dir, id, JSON.stringify(memory.activeAt > 0 ? { ...file, active: memory.activeAt } : file))
}

/** Lists the live folder and reads the files that changed since the last look; never this session's own. */
async function readPeers($: EngineInterface, memory: LiveMemory, now: number): Promise<void> {
  if (now - memory.lastReadAt < PEER_READ_MS) return
  memory.lastReadAt = now
  const dir = await liveDir($, memory)
  if (dir === undefined) return
  // This session's own file is never read as another's, even before its first beat.
  if (memory.selfId === undefined) memory.selfId = await $.session.id()
  const own = liveFileName(memory.selfId)
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
      const file = parseLiveFile(await $.fs.read(`${dir}/${entry.name}`))
      // A file caught mid-write reads as broken: it keeps what it said before, until it changes again.
      const isOwnName = file !== undefined && liveFileName(file.id) === entry.name
      const print = isOwnName ? livePrint(file) : known?.print
      // A change it says is activity, timed at the beat that wrote it; a first sight is not, nor a bare heartbeat.
      const isChange = isOwnName && known?.print !== undefined && print !== known.print
      memory.cache.set(entry.name, {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        file: isOwnName ? file : known?.file,
        print,
        changedAt: isChange ? file.beat : known?.changedAt,
      })
    } catch {
      // Gone between the listing and the read.
    }
  }
  for (const name of [...memory.cache.keys()]) if (!seen.has(name)) memory.cache.delete(name)
}

/** Works out the other sessions at `now` for the pane and the band; each atom is written only when it changed. */
async function showPeers($: EngineInterface, memory: LiveMemory, now: number): Promise<void> {
  const files = [...memory.cache.values()].flatMap(entry => (entry.file === undefined ? [] : [entry.file]))
  const changedAt = new Map<string, number>()
  for (const entry of memory.cache.values()) {
    if (entry.file !== undefined && entry.changedAt !== undefined) changedAt.set(entry.file.id, entry.changedAt)
  }
  const view = await read($, viewPrefs)
  const list = peerSessionsOf(files, memory.selfId, now, { idleMs: idleMsOf(view), floors: floorsOf(view), isAll: view.sessionsMode === 'all', changedAt })
  // A change of shape (a session comes or goes, starts or stops work, gets or loses a floor, waits
  // on you) shows at once; anything else (a tool, a time) waits for the next 4 s.
  const shape = peerShape(list)
  if (shape === memory.peersShape && now - memory.peersShownAt < PEERS_REDRAW_MS) return
  memory.peersShape = shape
  memory.peersShownAt = now
  await commitPeers($, list)
  await commitPeerBand($, peerBandOf(list))
}

/** What about the other sessions shows at once: who is there, who works, who has a floor, who waits. */
export function peerShape(list: readonly PeerSession[]): string {
  return JSON.stringify(list.map(peer => [peer.id, peer.state, peer.hiddenBy ?? '', peer.live, peer.waiting]))
}

/**
 * The live timer, each second: publish this session when due, read the others every 2 s, and work
 * out what to show. Anything that moves with time (elapsed times, a session going quiet) reaches
 * the drawings through the atoms written here, so the last drawing is never stale.
 */
async function syncLive($: EngineInterface, memory: LiveMemory): Promise<void> {
  if (memory.isSyncing) return
  memory.isSyncing = true
  try {
    const now = await $.clock.now()
    await guard(() => publishLive($, memory, now))
    if ((await read($, viewPrefs)).sessions === false) {
      // Hidden here: nothing read, nothing shown. This session still publishes for the others.
      memory.cache.clear()
    } else {
      await guard(() => readPeers($, memory, now))
    }
    await guard(() => showPeers($, memory, now))
  } finally {
    memory.isSyncing = false
  }
}

/**
 * Marks a session's own file closed (a mod cannot delete it): readers skip it. It keeps only the
 * label and the last activity, so a resume carries them over.
 */
async function closeFile($: EngineInterface, memory: LiveMemory, dir: string, id: string, now: number): Promise<void> {
  memory.closed.add(id)
  const info = await read($, selfInfo)
  const file = closedFileOf({ id, now, project: info.project ?? 'session', label: info.label, active: memory.activeAt })
  await writeOwn($, memory, dir, id, JSON.stringify(file), true)
}

/** The session ends. A /clear goes on under a new id: the next tick publishes that one at once. */
async function closeLive($: EngineInterface, memory: LiveMemory, id: string): Promise<void> {
  memory.selfId = undefined
  memory.lastBusy = undefined
  memory.lastBeatAt = 0
  const dir = await liveDir($, memory)
  if (dir === undefined) {
    memory.closed.add(id)
    return
  }
  await closeFile($, memory, dir, id, await $.clock.now())
}

/** At the start: the label back from this session's own file, so a resumed session keeps its name. */
async function startLive($: EngineInterface, memory: LiveMemory): Promise<void> {
  const dir = await liveDir($, memory)
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
  const previous = before === '' ? undefined : parseLiveFile(before)
  // A resumed session keeps its last activity: a restart is not activity.
  if (previous?.active !== undefined && memory.activeAt === 0) memory.activeAt = previous.active
  const label = previous?.label
  if (label === undefined) return
  await commitSelf($, current => (current.label === undefined ? { ...current, label } : current))
  memory.isDirty = true
}

// ---------------------------------------------------------------------------
// The mod
// ---------------------------------------------------------------------------

export const register: Register = on => {
  // Nothing here needs to outlive a reload: session.start fires again and refills it.
  let matchers: SkillMatcher[] = []
  let isLoadingNames = false
  let hasOpenedPane = false
  // Which agent made each tool call in flight: `tool.check` names only the call.
  const owners = new Map<string, string>()
  // Efforts the Agent calls in flight name themselves, by call id, for the spawn that follows.
  const callEfforts = new Map<string, string>()
  // The terminal office the pane drew last, and whether the frame timer should repaint it.
  let officeColumns: number | undefined
  let isAnimating = false
  let isPainting = false
  // The other sessions' floor Rasters the pane drew last, and how wide.
  let floorPaints: FloorPaint[] = []
  let floorColumns: number | undefined
  // The effort each subagent's last request went out with. A first request can come before the
  // spawn answers, when there is no row to write it on yet: the row takes it when it is made.
  const stepEfforts = new Map<string, string>()
  // The calls whose agent was marked as waiting for approval. The mark is written inside the
  // call's permission check, a nested dispatch, so the call's own hook reads an older version
  // and must not trust it to see the mark.
  const marked = new Set<string>()
  // This session's file for the others, and what it last read of theirs.
  const liveMemory = newLiveMemory()

  const adopt = (found: SkillMatcher[]): void => {
    isLoadingNames = false
    if (found.length > 0) matchers = found
  }

  on('session.start', async ($, e, next) => {
    // Apart, so that one failing does not keep the others from starting.
    await guard(async () => {
      await $.command.register({
        name: 'radar',
        description:
          'Open the Team pane (the office of subagents and the other sessions), or set it up: /radar sessions, expand, collapse, name, mode, ceiling, learn, view, labels, motion, details',
      })
    })
    // No turn runs at a start or a reload: a Lead still marked at work is left over from before.
    await guard(() => commitMain($, settledLead))
    await guard(() => {
      liveMemory.ready = startLive($, liveMemory).catch(() => undefined)
      // The other sessions, and this one for them: a beat and a look, each second.
      $.clock.every(1000, () => {
        void syncLive($, liveMemory)
      })
    })
    await guard(() => {
      isLoadingNames = true
      void fetchMatchers($).then(adopt)
    })
    await guard(() => {
      $.clock.every(1000, () => {
        void tick($)
      })
    })
    await guard(() => {
      void loadOutcomes($)
      void loadView($)
    })
    await guard(() => {
      // The terminal office moves between drawings: one frame each tick while anyone moves.
      $.clock.every(FRAME_TICK_MS, () => {
        const columns = officeColumns
        const floorWidth = floorColumns
        if (!isAnimating || isPainting || (columns === undefined && floorWidth === undefined)) return
        isPainting = true
        const ownFrame = columns === undefined ? Promise.resolve(false) : paintOfficeFrame($, columns)
        const floorFrames = floorWidth === undefined ? Promise.resolve(false) : paintFloorFrames($, floorWidth, floorPaints)
        void Promise.all([ownFrame, floorFrames]).then(([isOwnMoving, isFloorMoving]) => {
          isPainting = false
          if (!isOwnMoving && !isFloorMoving) isAnimating = false
        })
      })
    })

    return next(e)
  })

  // The other sessions stop showing this one: its file is emptied. A /clear goes on under a new id.
  on('session.end', async ($, e, next) => {
    await guard(() => closeLive($, liveMemory, e.sessionId))

    return next(e)
  })

  on('command.run', { command: 'radar' }, async ($, e) => {
    const asked = parseRadarArgs(e.args)
    if (asked.kind === 'bad') return { text: asked.usage }
    if (asked.kind === 'sessions') {
      const info = await read($, selfInfo)
      const isOn = (await read($, viewPrefs)).sessions !== false
      return { text: sessionsText(await read($, peers), info.label ?? info.project ?? 'this session', isOn) }
    }
    if (asked.kind === 'name') {
      await commitSelf($, current => withLabel(current, asked.label))
      liveMemory.isDirty = true
      return {
        text:
          asked.label === ''
            ? 'This session shows as its folder name again.'
            : `This session shows as "${asked.label}" in the other sessions' Team panes.`,
      }
    }
    if (asked.kind === 'expand' || asked.kind === 'collapse') {
      const list = await read($, peers)
      if (list.length === 0) return { text: NO_PEERS }
      const target = asked.target ?? 'all'
      const found = target === 'all' ? undefined : findPeer(list, target)
      if (target !== 'all' && found === undefined) {
        return { text: `No other session matches "${target}". /radar sessions lists them.` }
      }
      const ids = found === undefined ? (asked.kind === 'expand' ? list.map(one => one.id) : (await read($, selfInfo)).expanded) : [found.id]
      const isShown = asked.kind === 'expand'
      await commitSelf($, current => withExpanded(current, ids, isShown))
      const what = found === undefined ? 'every other session' : found.name
      if (!isShown) return { text: `Collapsed ${what}.` }
      await $.ui.open({ id: PANE, title: PANE_TITLE })
      return { text: `Expanded ${what} in the Team pane.` }
    }
    if (asked.kind === 'set') {
      await guard(() => commitPrefs($, current => withPrefs(current, asked.change)))
      return { text: `Routing: ${routingWords(await read($, prefs))}.` }
    }
    if (asked.kind === 'status') {
      return { text: `Routing: ${routingWords(await read($, prefs))}. ${USAGE}` }
    }
    if (asked.kind === 'stats') {
      const thisSession = describeSpend(await read($, spend))
      return {
        text: `${describeLessons(await read($, outcomes))}\nThis session: ${thisSession === '' ? 'no subagent tokens yet' : thisSession}.`,
      }
    }
    if (asked.kind === 'view') {
      const view = await changeView($, asked.change)
      return { text: `View: ${viewWords(view)}.` }
    }
    if (asked.kind === 'forget') {
      try {
        const cleared = await forgetOutcomes($)
        return { text: `Forgot past outcomes from ${cleared} session${cleared === 1 ? '' : 's'}. Picks are back to the rules alone.` }
      } catch {
        return { text: 'Could not clear the stored outcomes. Nothing changed.' }
      }
    }

    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })

    return {
      text: opened.isPlaced
        ? 'Agent radar opened.'
        : 'Agent radar is waiting for room: widen the terminal, or press the Team button.',
    }
  })

  // --- Skills: a call, a prompt, or a mention in the main loop's thinking -----

  on('skill.prompt', async ($, e, next) => {
    await guard(() => sight($, e.skill, 'invoked'))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await guard(async () => {
      await commitSkills($, list => (list.some(skill => skill.isFinal) ? list.filter(skill => !skill.isFinal) : list))
      if (matchers.length === 0 && !isLoadingNames) {
        isLoadingNames = true
        void fetchMatchers($).then(adopt)
      }
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await guard(async () => {
      const now = await $.clock.now()
      const id = e.agentId
      if (id === undefined) {
        await commitMain($, settledLead)
        await commitSkills($, list =>
          list.every(skill => skill.isFinal) ? list : list.map(skill => (skill.isFinal ? skill : { ...skill, isFinal: true })),
        )
        return
      }
      const status: AgentStatus =
        e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
      const fallback = e.reason === 'answer' ? 'finished' : e.reason === 'aborted' ? 'interrupted' : 'failed'
      const answer = oneLine(e.answer)
      const doing = answer === '' ? fallback : clip(answer, DOING_CHARS)
      stepEfforts.delete(id)
      await commitAgents($, rows =>
        patchRows(rows, id, {
          status,
          phase: endPhase(status),
          doing,
          endedAt: now,
          needs: undefined,
          resumedAt: undefined,
          ...(answer === '' ? {} : { answer: clip(answer, ANSWER_CHARS) }),
        }),
      )
    })
    const ended = e.agentId
    if (ended !== undefined) await guard(() => recordOutcome($, ended))

    return next(e)
  })

  // --- Subagents: spawn, steps, tool calls ------------------------------------

  on('agent.spawn', async ($, e, next) => {
    // The router picks first. It fails open: a pick that cannot be made sends the call as it came.
    const callEffort = callEfforts.get(e.tool_use_id)
    callEfforts.delete(e.tool_use_id)
    const { route, sent } = await planSpawn($, e, callEffort)
    const started = await next(sent)
    // Refused, or no agent to name: nothing started, so nothing to show.
    if (started.deny !== undefined || started.agentId === undefined) {
      if (route !== undefined) await guard(() => commitBook($, book => dropPending(book, e.tool_use_id)))
      return started
    }
    const id = started.agentId

    await guard(async () => {
      const now = await $.clock.now()
      await commitAgents($, rows =>
        upsertRow(rows, id, now, {
          type: e.subagentType,
          description: e.description,
          model: started.model,
          background: e.background,
          fork: e.fork,
          parentId: e.parentAgentId,
          name: e.name,
          route,
          effort: stepEfforts.get(id),
        }),
      )
      await commitNow($, value => (value < now ? now : value))
    })
    if (route !== undefined) {
      await guard(() => commitBook($, book => settleRoute(book, e.tool_use_id, id, route)))
    }
    await guard(() => commitSpend($, book => countAgent(book, spendKind(route))))
    await guard(async () => {
      if (hasOpenedPane) return
      hasOpenedPane = true
      // Unasked, so a narrow terminal keeps it waiting: the band's Team button
      // and /radar open it by hand at any width.
      await $.ui.open({ id: PANE, title: PANE_TITLE })
    })

    return started
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    // The router's effort goes in here, for a subagent's request. The main loop is never routed.
    const route = id === undefined ? undefined : await routeFor($, id)
    const errors = id === undefined || route === undefined ? 0 : await errorsOf($, id)
    const step = withEffort(e, route, errors)
    const model = step.model
    const effort = step.effort
    const effortText = effort === undefined ? undefined : String(effort)
    if (id !== undefined && effortText !== undefined) {
      stepEfforts.delete(id)
      stepEfforts.set(id, effortText)
      // Agents that never end here (a reload in between) must not pile up.
      const oldest = stepEfforts.keys().next().value
      if (stepEfforts.size > MAX_ROWS * 2 && oldest !== undefined) stepEfforts.delete(oldest)
    }
    await guard(async () => {
      if (id === undefined) {
        // A main step opens the Lead's turn: from here to its end, its calls are its own work.
        const turnId = e.turnId
        await commitMain($, lead =>
          lead.model === model && lead.phase === 'thinking' && lead.effort === effortText && lead.turnId === turnId
            ? lead
            : { ...lead, model, phase: 'thinking', turnId, ...(effortText === undefined ? {} : { effort: effortText }) },
        )
        return
      }
      const now = await $.clock.now()
      await commitAgents($, rows =>
        patchRows(rows, id, row => {
          if (isEnded(row.status) && row.status !== 'completed') return {}
          const isIdle = row.status === 'pending' || row.status === 'idle' || row.status === 'waiting'

          return {
            ...reviving(row, now),
            model,
            phase: 'thinking',
            doing: 'thinking…',
            ...(effortText === undefined ? {} : { effort: effortText }),
            ...(isIdle ? { status: 'running' as const } : {}),
          }
        }),
      )
    })

    let phase: LivePhase = 'thinking'
    let tail = ''
    let thinkingChunks = 0
    let isScanned = true
    const mentioned = new Set<string>()

    const scan = async (): Promise<void> => {
      isScanned = true
      for (const name of findMentions(tail, matchers)) {
        if (mentioned.has(name)) continue
        mentioned.add(name)
        await sight($, name, 'thought')
      }
    }

    // The response's usage rides on its last chunk: one state write per response, never per chunk.
    let usage: UsageLike | null = null
    for await (const chunk of next(step)) {
      if (chunk.kind === 'stop') usage = chunk.usage
      await guard(async () => {
        if (chunk.kind === 'thinking') {
          // Only the main loop's thinking: a subagent's is not "the latest thinking".
          if (id !== undefined) return
          tail = (tail + chunk.text).slice(-TAIL_CHARS)
          thinkingChunks += 1
          isScanned = false
          if (thinkingChunks % SCAN_EVERY === 0) await scan()
        } else if (chunk.kind === 'text' && phase !== 'writing') {
          phase = 'writing'
          await setPhase($, id, 'writing', 'writing a reply…')
        } else if (chunk.kind === 'tool' && phase !== 'tool') {
          phase = 'tool'
          if (id === undefined) {
            const tool = chunk.name
            await commitMain($, lead => ({ ...lead, phase: 'tool', tool, detail: '' }))
          } else {
            await setPhase($, id, 'tool', `preparing ${chunk.name}…`)
          }
        }
      })
      yield chunk
    }

    if (!isScanned) await guard(scan)
    const used = usage
    if (id !== undefined && used !== null) await guard(() => recordUsage($, id, used))
    if (id === undefined && used !== null) {
      const context = contextOf(used)
      await guard(() => commitMain($, lead => (lead.context === context ? lead : { ...lead, context })))
    }
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    const callId = e.tool_use_id
    if (id !== undefined && callId !== undefined) owners.set(callId, id)
    if (e.tool === 'Agent' && callId !== undefined) {
      const named = (e as { effort?: unknown }).effort
      if (typeof named === 'string') callEfforts.set(callId, named)
    }
    await guard(async () => {
      if (e.tool === 'Skill') {
        await sight($, e.skill, 'invoked', await agentLabel($, id))
      }
      const tool = e.tool
      const detail = callDetail(e)
      if (id === undefined) {
        // The gauntlet's closing step: only the time is kept, never the command. The first one after the newest
        // gauntlet agent started counts: a `winner` read again later does not bring the colosseum back.
        const closedAt = isGauntletClose(e) ? await $.clock.now() : undefined
        const newest = closedAt === undefined ? 0 : await newestGauntletStart($)
        await commitMain($, lead => {
          const updated = lead.turnId === undefined ? lead : { ...lead, phase: 'tool' as const, tool, detail }
          const isFirst = lead.gauntletDoneAt === undefined || lead.gauntletDoneAt < newest
          return closedAt === undefined || !isFirst ? updated : { ...updated, gauntletDoneAt: closedAt }
        })
        return
      }
      const doing = describeCall(e)
      const read = readPath(e)
      const now = await $.clock.now()
      await commitAgents($, rows =>
        patchRows(rows, id, row =>
          isEnded(row.status) && row.status !== 'completed'
            ? {}
            : {
                ...reviving(row, now),
                status: 'running',
                phase: 'tool',
                doing,
                tool,
                detail,
                tools: row.tools + 1,
                ...noteCall(row, tool, detail),
                ...(read === undefined ? {} : { reads: noteFile(row.reads, read) }),
              },
        ),
      )
      const path = editedPath(e)
      if (path !== undefined) await noteEdit($, id, path)
    })

    // The permission prompt, when there is one, waits inside `next`.
    const ran = await next(e).finally(() => {
      if (callId !== undefined) {
        owners.delete(callId)
        callEfforts.delete(callId)
      }
    })

    const wasMarked = callId !== undefined && marked.delete(callId)
    await guard(async () => {
      if (id !== undefined) {
        // A failed or refused call is a sign of struggle: three of them raise the agent's effort.
        const isFailed = ran.deny !== undefined || ran.isError === true
        if (isFailed || wasMarked) {
          // A plain `update`, not `commitAgents`: its version check re-reads when the mark was
          // written in the nested permission check, where this hook's read cannot see it.
          await update($, agents, rows =>
            patchRows(rows, id, row => ({
              ...(isFailed ? { errors: (row.errors ?? 0) + 1 } : {}),
              needs: undefined,
            })),
          )
        }
      }
      await setPhase($, id, 'thinking')
    })

    return ran
  })

  // A subagent's call that waits for the person: the card and the band say so. It only
  // watches: the verdict goes back exactly as it came, and nothing is approved or denied here.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const callId = e.tool_use_id
    const owner = callId === undefined ? undefined : owners.get(callId)
    if (callId !== undefined && owner !== undefined && verdict.decision === 'ask') {
      marked.add(callId)
      await guard(() => markNeeds($, owner, e.tool))
    }

    return verdict
  })

  // --- Drawing ----------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, skills)
    const rows = await read($, agents)
    // The other sessions' agents at work, and theirs that wait on the person: a reason to look.
    const others = (await read($, viewPrefs)).sessions === false ? undefined : await read($, peerBand)
    const hasOthers = others !== undefined && others.agents > 0
    if (list.length === 0 && rows.length === 0 && !hasOthers) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const isAllFinal = list.length > 0 && list.every(skill => skill.isFinal)
    const active = rows.filter(row => !isEnded(row.status)).length
    // The clock is read only while an agent waits: then a tick redraws the band, and only then.
    const hasNeeds = rows.some(row => row.needs !== undefined && !isEnded(row.status))
    const now = hasNeeds ? await read($, clockNow) : 0
    const names = new Map(
      teamOf(rows, await read($, main), now).map(entry => [entry.member.id, entry.member.label] as const),
    )
    const waiting = rows.filter(row => isWaiting(row, now))
    // Another mod may draw this band too: keep what is beneath, and put ours under it.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {list.length > 0 && (
            <Text bold dimColor={isAllFinal}>
              {isAllFinal ? 'Skills · last turn' : 'Skills'}
            </Text>
          )}
          {list.map(skill =>
            skill.how === 'invoked' ? (
              <Text color="claude" dimColor={skill.isFinal}>
                {`◆ ${skill.name}${skill.by === undefined ? '' : ` (${skill.by})`}`}
              </Text>
            ) : (
              <Text dimColor italic>
                {`◇ ${skill.name}`}
              </Text>
            ),
          )}
          {waiting.map(row => (
            <Text color="error" bold>
              {`! ${names.get(row.id) ?? row.name ?? row.type} needs you`}
            </Text>
          ))}
          {hasOthers && <Text dimColor>{peerBandWords(others)}</Text>}
          {hasOthers &&
            others.waiting.map(who => (
              <Text color="error" bold>
                {`! ${who} needs you`}
              </Text>
            ))}
          {(rows.length > 0 || hasOthers) && (
            <Button
              key="agents"
              label={rows.length > 0 ? `Team ${active}/${rows.length}` : 'Team'}
              onPress={async () => {
                await $.ui.open({ id: PANE, title: PANE_TITLE })
              }}
            />
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, agents)
    // The atom makes the pane redraw each second while anyone is live or a walk is not yet drawn
    // finished (isSettling); the time itself comes from the clock. The atom stops at the last tick,
    // and a walk timed from it would replay at every redraw, forever "just finished".
    await read($, clockNow)
    const now = await $.clock.now()
    const lead = await read($, main)
    const config = await read($, prefs)
    const book = await read($, spend)
    const clashes = await read($, conflicts)
    const past = await read($, outcomes)
    const view = await read($, viewPrefs)
    // The other sessions come worked out by the live timer: nothing here reads the clock for them.
    const others = view.sessions === false ? [] : await read($, peers)
    const info = await read($, selfInfo)
    // How this session shows to the others: only once it has a name of its own (`/radar name`).
    const selfName = view.sessions === false ? undefined : info.label

    const team = teamOf(rows, lead, now)
    const room = Math.max(20, e.props.bodyColumns - 4)
    const live = rows.filter(row => !isEnded(row.status))
    const finishedAll = rows.filter(row => isEnded(row.status))
    const waitingCount = rows.filter(row => isWaiting(row, now)).length

    const isRouting = config.mode !== 'off'
    const raised = isRouting && config.learn !== false ? raisedKinds(past) : []
    // The router's settings show only when they differ from the defaults (auto, raise, learning on).
    const routingLine = [
      ...(config.mode === 'auto' ? [] : [`routing ${config.mode}`]),
      ...(isRouting && config.ceiling !== 'raise' ? [`ceiling ${config.ceiling}`] : []),
      ...(isRouting && config.learn === false ? ['learning off'] : []),
      ...(raised.length > 0 ? [`learned: ${raised.join(', ')} raised`] : []),
    ].join(' · ')
    const spendLine = describeSpend(book)
    const metaLine = [spendLine, routingLine].filter(part => part !== '').join(' · ')
    const labelOf = (id: string): string => team.find(entry => entry.member.id === id)?.member.label ?? 'an agent'
    const liveClashes = clashes
      .filter(clash => clash.agents.some(id => rows.some(row => row.id === id && !isEnded(row.status))))
      .slice(0, CONFLICTS_SHOWN)

    const columns = Math.min(OFFICE_MAX_COLUMNS, e.props.bodyColumns)
    // The floors this drawing mounts as terminal Rasters, for the frame timer to repaint.
    const paints: FloorPaint[] = []

    /** One floor's office: terminal cells repainted by the frame timer, an SVG with its own motion elsewhere. */
    const officeOf = (scope: FloorScope): RenderElement | undefined => {
      const scopeMembers = scope.team.map(entry => entry.member)
      // Another session's office is seen seconds late: it walks no one, so its last drawing is still.
      const isArena = isArenaTeam(scope.team)
      const options = { columns, now: scope.now, labels: view.labels, motion: view.motion, walks: scope.peer === undefined, arena: isArena }
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        const frame = officeRaster(scopeMembers, scope.spend, options)
        if (frame === undefined) return undefined
        const key = scope.peer === undefined ? OFFICE_KEY : `office-${scope.peer.id}`
        if (scope.peer !== undefined) paints.push({ key, peerId: scope.peer.id, kind: 'office' })
        return <Raster key={key} columns={frame.columns} rows={frame.rows} cells={frame.cells} />
      }
      const { Svg } = $.ui.resolve(e)
      const markup = officeSvg(scopeMembers, scope.spend, options)
      // An image, not an interactive frame: SMIL still runs in it, and a new picture replaces the
      // old one in place, where a frame reloads and flashes white at every change.
      if (markup === undefined) return undefined
      const alt = scope.peer === undefined ? officeAlt(scopeMembers, isArena) : floorAlt(scope.peer.name, scopeMembers)
      return <Svg source={markup} alt={alt} />
    }

    const avatar = (member: Member, scope: FloorScope): RenderElement => {
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        const face = avatarRaster(member)
        const key = scope.peer === undefined ? `av-${member.id}` : `av-${scope.peer.id}-${member.id}`
        return <Raster key={key} columns={face.columns} rows={face.rows} cells={face.cells} />
      }
      const { Svg } = $.ui.resolve(e)
      return <Svg source={avatarSvg(member)} alt={member.label} width={36} height={32} />
    }

    /** A context gauge: a thin drawn bar on remote surfaces, block characters in the terminal. */
    const gaugeOf = (fill: number, color: string, key: string): RenderElement => {
      if (e.surface === 'terminal') {
        const bar = contextBar(fill, 12)
        return <Text color={bar.color}>{bar.bar}</Text>
      }
      const { Svg } = $.ui.resolve(e)
      const share = Math.min(1, Math.max(0, Number.isFinite(fill) ? fill : 0))
      const markup =
        `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="6" viewBox="0 0 96 6">` +
        `<rect x="0" y="1" width="96" height="4" rx="2" fill="#3b3f4a"/>` +
        `<rect x="0" y="1" width="${Math.max(share > 0 ? 4 : 0, Math.round(96 * share))}" height="4" rx="2" fill="${color}"/></svg>`
      return <Svg key={key} source={markup} alt={`context ${Math.round(share * 100)}% full`} width={96} height={6} />
    }

    const cardIn = (scope: FloorScope) => ({ member, row }: TeamEntry): RenderElement => {
      const scopeLead = scope.lead
      const at = scope.now
      const isLead = row === undefined
      const key = `${scope.peer === undefined ? 'card' : `card-${scope.peer.id}`}-${member.id}`
      const glyph = row === undefined ? undefined : statusGlyph(row.status)
      const model = row === undefined ? scopeLead.model : row.model
      const effort = row === undefined ? scopeLead.effort : row.effort
      const modelLine = [shortModel(model), effort].filter(part => part !== undefined && part !== '').join(' · ')
      const context = row === undefined ? scopeLead.context : row.context
      const contextWindow = windowOf(model, scopeLead.window ?? DEFAULT_WINDOW)
      const isDetailed = row !== undefined && view.details !== false
      const color = activityColor(member.activity)
      const tokens = row === undefined ? 0 : totalTokens(row.tokens)
      const end = row === undefined ? at : (row.endedAt ?? Math.max(at, row.startedAt))
      const isAlert = member.activity === 'waiting-you' || member.activity === 'failed'
      // Color on a border means something: the Lead, or someone who needs you or is stuck. Work shows in the status line.
      const border = isAlert ? 'error' : isLead ? 'claude' : undefined
      const name = (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1} flexShrink={1}>
          {glyph !== undefined &&
            (glyph.color === undefined ? <Text dimColor>{glyph.glyph}</Text> : <Text color={glyph.color}>{glyph.glyph}</Text>)}
          <Text bold>{member.label}</Text>
          <Text dimColor italic>
            {archetypeOf(member)}
          </Text>
          {row?.background === true && <Text dimColor>bg</Text>}
          {row !== undefined && isWaiting(row, at) && (
            <Text backgroundColor="error" color="#ffffff" bold>
              {' needs approval '}
            </Text>
          )}
        </Box>
      )

      // A finished agent: two lines, how it ended and when, then the first line of its answer.
      if (row !== undefined && member.isEnded) {
        const ended = `${ACTIVITY_WORDS[member.activity]} in ${formatElapsed(end - row.startedAt)}`
        const said = oneLine(row.answer ?? (row.doing === 'finished' || row.doing === 'failed' || row.doing === 'interrupted' ? '' : row.doing))
        return (
          <Box key={key} flexDirection="row" columnGap={1} borderStyle="round" borderColor={border} borderDimColor paddingX={1}>
            {avatar(member, scope)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" columnGap={1}>
                {name}
                <Box flexDirection="row" columnGap={1} flexShrink={0}>
                  <Text dimColor>{ended}</Text>
                  {tokens > 0 && <Text dimColor>{`${formatTokens(tokens)} tok`}</Text>}
                </Box>
              </Box>
              {said !== '' && (
                <Text dimColor wrap="truncate-end">
                  {clip(said, room)}
                </Text>
              )}
            </Box>
          </Box>
        )
      }

      const status =
        row === undefined
          ? member.activity === 'idle'
            ? scope.peer === undefined
              ? 'waiting for your next message'
              : 'waiting for a message'
            : statusLine(member.activity, scopeLead.tool, scopeLead.detail, '')
          : statusLine(member.activity, row.needs?.tool ?? row.tool, row.detail, row.doing)
      const parent =
        row?.parentId === undefined ? 'Lead' : (scope.team.find(entry => entry.member.id === row.parentId)?.member.label ?? 'another agent')
      const details = row === undefined || !isDetailed ? undefined : cardDetails(row, parent)
      const footer =
        row === undefined ? '' : [modelLine, ...(row.route === undefined ? [] : [routeSummary(row.route, row.effort, budgetUse(row.route, row.tokens))])].filter(part => part !== '').join(' · ')
      const gauge = context === undefined ? undefined : contextBar(context / contextWindow, 12)

      return (
        <Box
          key={key}
          flexDirection="row"
          columnGap={1}
          borderStyle="round"
          borderColor={border}
          paddingX={1}
          hover={{ borderColor: border ?? 'claude' }}
        >
          {avatar(member, scope)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" columnGap={1}>
              {name}
              <Box flexDirection="row" columnGap={1} flexShrink={0}>
                {row === undefined ? (
                  modelLine !== '' && <Text dimColor>{modelLine}</Text>
                ) : (
                  <Text>{formatElapsed(end - row.startedAt)}</Text>
                )}
                {tokens > 0 && <Text dimColor>{`${formatTokens(tokens)} tok`}</Text>}
              </Box>
            </Box>
            {color === undefined ? (
              <Text dimColor wrap="truncate-end">
                {clip(status, room)}
              </Text>
            ) : (
              <Text color={color} wrap="truncate-end">
                {clip(status, room)}
              </Text>
            )}
            {row !== undefined && row.description.trim() !== '' && (
              <Text wrap="wrap">{clip(oneLine(row.description), Math.min(DESCRIPTION_CHARS, 2 * room - 2))}</Text>
            )}
            {gauge !== undefined && context !== undefined && (
              <Box flexDirection="row" columnGap={1} alignItems="center">
                {gaugeOf(context / contextWindow, gauge.color, `${key}-ctx`)}
                <Text dimColor>
                  {isDetailed ? `ctx ${gauge.percent}% · ${formatTokens(context)} of ${formatTokens(contextWindow)}` : `ctx ${gauge.percent}%`}
                </Text>
              </Box>
            )}
            {details?.recent !== undefined && (
              <Text dimColor wrap="wrap">
                {clip(details.recent, 2 * room - 2)}
              </Text>
            )}
            {details?.stats !== undefined && (
              <Text dimColor wrap="wrap">
                {clip(details.stats, 2 * room - 2)}
              </Text>
            )}
            {footer !== '' && (
              <Box flexDirection="row" columnGap={2}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor wrap="truncate-end">
                    {footer}
                  </Text>
                </Box>
                {details?.times !== undefined && <Text dimColor>{details.times}</Text>}
              </Box>
            )}
            {/* On hover: the tokens by kind and the router's reasons. */}
            {row !== undefined && (details?.tokens !== undefined || row.route !== undefined) && (
              <Box flexDirection="column" display="none" hover={{ display: 'flex' }}>
                {details?.tokens !== undefined && (
                  <Text dimColor wrap="truncate-end">
                    {clip(`tokens ${details.tokens}`, room)}
                  </Text>
                )}
                {row.route !== undefined && (
                  <Text dimColor wrap="truncate-end">
                    {clip(describeRoute(row.route, row.effort, budgetUse(row.route, row.tokens)), room)}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    /** A floor's cards: the Lead, the live agents, the newest finished ones. */
    const cardsOf = (scope: FloorScope): RenderElement => {
      const [leadEntry, ...agentEntries] = scope.team
      const liveEntries = agentEntries.filter(entry => !entry.member.isEnded)
      const finishedEntries = agentEntries
        .filter(entry => entry.member.isEnded)
        .sort((a, b) => (b.row?.endedAt ?? 0) - (a.row?.endedAt ?? 0))
      const shownFinished = finishedEntries.slice(0, FINISHED_SHOWN)
      const card = cardIn(scope)
      return (
        <Box flexDirection="column" marginTop={1}>
          {leadEntry !== undefined && card(leadEntry)}
          {liveEntries.map(card)}
          {shownFinished.map(card)}
          {finishedEntries.length > shownFinished.length && (
            <Text dimColor>{`+${finishedEntries.length - shownFinished.length} older finished`}</Text>
          )}
        </Box>
      )
    }

    const own: FloorScope = { team, lead, now, spend: kindSpendOf(book) }
    let office: RenderElement | undefined
    let officeNote: string | undefined
    if (view.layout !== 'cards') {
      office = officeOf(own)
      if (e.surface === 'terminal') officeColumns = office === undefined ? undefined : columns
      if (office === undefined) officeNote = 'Widen the pane to see the office (40 columns or more).'
    }

    // The other sessions, one floor each: closed, a strip of desks with its people at work; open,
    // its whole office and cards. A floor's button or `/radar expand <n>` opens it.
    const expandedIds = new Set(info.expanded)
    // Working sessions and the recently idle, up to the cap; an opened one shows whatever its rank.
    const floorsShown = floorsShownOf(others, expandedIds)
    const hidden = hiddenLine(others, floorsOf(view), expandedIds)
    const buildingFloors = buildingFloorsOf(floorsShown, expandedIds)
    // The building: one picture, a storey per session, its people as lit windows. Office only, or
    // office and cards; cards only gives a line per floor instead.
    let building: RenderElement | undefined
    if (buildingFloors.length > 0 && view.layout !== 'cards') {
      const options = { columns, now, motion: view.motion }
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        const frame = buildingRaster(buildingFloors, options)
        if (frame !== undefined) {
          paints.push({ key: BUILDING_KEY, peerId: '', kind: 'building' })
          building = <Raster key={BUILDING_KEY} columns={frame.columns} rows={frame.rows} cells={frame.cells} />
        }
      } else {
        const { Svg } = $.ui.resolve(e)
        const markup = buildingSvg(buildingFloors, options)
        if (markup !== undefined) building = <Svg source={markup} alt={buildingAlt(buildingFloors)} />
      }
    }
    const floorLine = ({ peer, index }: NumberedPeer): RenderElement => {
      const line = clip(peerLine(peer, index, expandedIds.has(peer.id)), room)
      return peer.waiting > 0 ? (
        <Text color="error" bold wrap="truncate-end">
          {line}
        </Text>
      ) : (
        <Text bold={peer.state === 'working'} dimColor={peer.state !== 'working'} wrap="truncate-end">
          {line}
        </Text>
      )
    }
    // A button per floor (desktop presses are not always handled: `/radar expand <n>` always works).
    const floorButtons = floorsShown.map(({ peer }) => (
      <Button
        key={`floor-${peer.id}`}
        label={`${expandedIds.has(peer.id) ? 'close' : 'open'} ${clip(peer.name, 20)}`}
        onPress={() => toggleFloor($, peer.id)}
      />
    ))
    /** An open floor: its line, its whole office and its cards. */
    const openFloor = ({ peer, index }: NumberedPeer): RenderElement => {
      const scope: FloorScope = { team: peerTeamOf(peer), lead: peer.lead, now: peer.asOf, spend: peer.spend, peer }
      const peerOffice = view.layout === 'cards' ? undefined : officeOf(scope)
      return (
        <Box flexDirection="column" marginTop={1}>
          {floorLine({ peer, index })}
          {peerOffice !== undefined && <Box marginTop={1}>{peerOffice}</Box>}
          {view.layout !== 'office' && cardsOf(scope)}
        </Box>
      )
    }
    const opened = floorsShown.filter(({ peer }) => expandedIds.has(peer.id)).map(openFloor)
    if (e.surface === 'terminal') {
      floorPaints = paints
      floorColumns = paints.length === 0 ? undefined : columns
      const isOwnMoving = office !== undefined && view.motion && isMoving(team, now)
      const isFloorMoving =
        view.motion &&
        paints.some(paint =>
          paint.kind === 'building' ? isBuildingMoving(buildingFloors) : others.some(peer => peer.id === paint.peerId && peer.state === 'working'),
        )
      isAnimating = isOwnMoving || isFloorMoving
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold>Team</Text>
          <Text dimColor>{`${live.length} active · ${finishedAll.length} finished`}</Text>
          {waitingCount > 0 && (
            <Text backgroundColor="error" color="#ffffff" bold>
              {` ${waitingCount} need${waitingCount === 1 ? 's' : ''} you `}
            </Text>
          )}
          {selfName !== undefined && <Text dimColor>{`shows as ${selfName}`}</Text>}
        </Box>
        {metaLine !== '' && (
          <Text dimColor wrap="truncate-end">
            {clip(metaLine, room)}
          </Text>
        )}
        {liveClashes.map(clash => (
          <Text color="warning" wrap="truncate-end">
            {`▲ ${base(clash.path)} — edited by ${clash.agents.map(labelOf).join(', ')}`}
          </Text>
        ))}
        {office !== undefined && <Box marginTop={1}>{office}</Box>}
        {officeNote !== undefined && <Text dimColor>{officeNote}</Text>}
        {rows.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No subagents yet. They appear here the moment Claude starts one.</Text>
          </Box>
        )}
        {view.layout !== 'office' && cardsOf(own)}
        {others.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" columnGap={2}>
              <Text bold>Other floors</Text>
              <Text dimColor>{`${floorsShown.length} of ${plural(others.length, 'session')}`}</Text>
            </Box>
            {building !== undefined && <Box marginTop={1}>{building}</Box>}
            {building === undefined && floorsShown.map(floorLine)}
            {floorButtons.length > 0 && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {floorButtons}
              </Box>
            )}
            {opened}
            {hidden !== '' && (
              <Box marginTop={1}>
                <Text dimColor wrap="truncate-end">
                  {clip(hidden, room)}
                </Text>
              </Box>
            )}
            {floorsShown.length > 0 && (
              <Text dimColor wrap="truncate-end">
                {clip('or type /radar expand <n>', room)}
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
