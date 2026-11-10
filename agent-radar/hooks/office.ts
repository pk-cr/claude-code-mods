// The pixel office: every agent is a person at a desk, the main loop is the Lead, finished agents
// gather in the lounge. One scene, two encodings: terminal Raster cells (animated by `$.ui.blit`)
// and an SVG for the remote surfaces (animated by SMIL, with hover tooltips). Pure code: no `$`.

import { blend, createCanvas, drawSprite, escapeXml, fillRect, pngBase64, setPixel, shiftHue, svgPaths, toCells, upscale } from './pixels'
import type { Canvas, Overlay, RasterFrame } from './pixels'
import { ARENA, ARENA_LOOKS, ARENA_NAMES, CREW, CREW_LOOKS, EMPEROR, EMPEROR_LOOK } from './crew'
import type { CrewLook, CrewSprite, Mood, Pose } from './crew'

export type Activity =
  | 'typing'
  | 'reading'
  | 'terminal'
  | 'browsing'
  | 'helper'
  | 'studying'
  | 'calling'
  | 'thinking'
  | 'writing'
  | 'waiting-you'
  | 'starting'
  | 'idle'
  | 'working'
  | 'done'
  | 'failed'
  | 'stopped'

export type Role =
  | 'lead'
  | 'explore'
  | 'scout'
  | 'plan'
  | 'architect'
  | 'reviewer'
  | 'builder'
  | 'researcher'
  | 'general'
  | 'other'
  | 'gladiator'
  | 'judge'

/** One person in the office: the main loop (the Lead) or a subagent. */
export type Member = {
  id: string
  label: string
  role: Role
  activity: Activity
  /** Desk number; 0 is the Lead's. */
  seat: number
  isEnded: boolean
  /** When it arrived and, once ended, when it left its desk (`$.clock.now()` ms). */
  startedAt: number
  endedAt?: number
  /** One line for the hover tooltip. */
  tooltip: string
  /** Which sibling of its role it is, by start order: 0 is the named character, 1 and up wear other colors. */
  variant?: number
  /** A shorter name for the picture's name tags ("Glad A"); cards, tooltips and the alt text keep `label`. */
  tag?: string
}

/** Subagent tokens by route kind, drawn as the wall board's bars. */
export type KindSpend = Readonly<Partial<Record<(typeof KINDS)[number], number>>>

export type OfficeOptions = {
  /** Width to fit, in terminal columns (one pixel each). */
  columns: number
  /** `$.clock.now()`: picks the animation frame and how far a walk has got. */
  now: number
  labels: boolean
  motion: boolean
  /** Walks from the door and to the lounge; absent is on. Another session's office has none: it is seen late. */
  walks?: boolean
  /** The gauntlet's colosseum instead of the studio: see `arenaOn`. */
  arena?: boolean
}

export const SEAT_W = 18
export const SEAT_H = 18
const MARGIN = 2
const WALL_H = 10
const FLOOR_PAD = 2
const LOUNGE_H = 17
const SPOT_W = 13
const MAX_PER_ROW = 6
/** The narrowest room: two desks a row. */
export const MIN_OFFICE_COLUMNS = 2 * MARGIN + 2 * SEAT_W
/** A walk from the door to a desk, or from a desk to the lounge. */
export const WALK_MS = 2000
/** One animation frame: the terminal's repaint and the SVG loops' step. */
export const FRAME_MS = 250
/** The SVG cap is 131072 characters; past this the motion goes, then the picture. */
export const SVG_LIMIT = 120_000
const SVG_SCALE = 6
const DOOR_X = 2
const KINDS = ['lookup', 'routine', 'careful', 'hard'] as const

/** brand orange: the director's beret and name tag, the neon sign, the noren over the door. */
export const CR_ORANGE = '#f47521'

// An animation studio at night: an indigo wall with a window on the city, a neon sign, a carpeted floor,
// white desks, and a break room with tiles and a vending machine.
const COLOR = {
  wall: '#2b2547',
  wallEdge: '#211b3d',
  wallBase: '#3b3366',
  baseboard: '#1d1833',
  doorFrame: '#4a2f1a',
  door: '#6b4426',
  doorKnob: '#e9c46a',
  norenDark: '#c25a12',
  lanternLight: '#ffc58f',
  windowFrame: '#3a2a1e',
  night: '#141a3d',
  nightLow: '#1c2454',
  moon: '#fff1b8',
  skyline: '#232b6a',
  skylineLit: '#ffd678',
  neonFace: '#1a1330',
  neonText: '#ffbe78',
  slate: '#24242c',
  chalk: '#f5f5f5',
  corkFrame: '#6e4a28',
  cork: '#b8895a',
  pin: '#e5484d',
  boardFrame: '#6e4a28',
  boardFace: '#f4f1ea',
  sticky: '#ffd166',
  stickyEdge: '#c28a2b',
  carpet: '#8d779a',
  carpetAlt: '#9680a3',
  carpetEdge: '#6f5a82',
  deskTop: '#efe9f5',
  deskEdge: '#ffffff',
  deskFront: '#c8bfd6',
  deskShade: '#a99fbf',
  monitor: '#1b1f27',
  stand: '#2d333b',
  screenOff: '#161b22',
  tile: '#d8c8aa',
  tileAlt: '#cebc9c',
  skirting: '#7a4a2a',
  machine: '#e54553',
  machineShade: '#a82c38',
  machineGlass: '#bfe6ff',
  machineSlot: '#3c141c',
  cup: '#f3f0ff',
  steam: '#e6edf3',
  counterTop: '#aa6c3e',
  counter: '#7a4a2a',
  counterShade: '#5e3720',
  bowl: '#ffffff',
  ramen: '#e8a046',
  egg: '#ffdc78',
  stool: '#e54553',
  stoolLeg: '#3c3c46',
  tagText: '#2a2340',
  tag: '#fff6e8',
  tagLead: CR_ORANGE,
  tagLeadText: '#2a1608',
  tagAlert: '#c81e28',
  tagAlertText: '#ffffff',
  tagDone: '#3a3550',
  tagDoneText: '#d8d4ea',
  bubble: '#ffffff',
  bubbleIdle: '#e1e8ff',
  bubbleRim: '#1b1f27',
  alert: '#c81e28',
  alertDark: '#8b2b2b',
  sparkle: '#fff3a3',
  moreText: '#3a3550',
  avatarBack: '#4a3f78',
} as const

const KIND_COLORS: Readonly<Record<(typeof KINDS)[number], string>> = {
  lookup: '#3fb950',
  routine: '#58a6ff',
  careful: '#d29922',
  hard: '#f85149',
}

// ---------------------------------------------------------------------------
// Who is who: role, name, activity
// ---------------------------------------------------------------------------

/** The look an agent type gets. A plugin's role agents (`delegate:scout`) read by their last part. */
export function roleOf(type: string): Role {
  const name = (type.split(':').pop() ?? type).toLowerCase()
  if (name === 'explore') return 'explore'
  if (name === 'plan' || name === 'planner') return 'plan'
  if (name === 'general-purpose' || name === 'general' || name === 'claude') return 'general'
  for (const role of ['scout', 'architect', 'reviewer', 'builder', 'researcher'] as const) {
    if (name.includes(role)) return role
  }
  return 'other'
}

/** A short name for an agent type: `general-purpose` is General, `delegate:scout` is Scout. */
export function displayName(type: string): string {
  const name = type.split(':').pop() ?? type
  if (name === 'general-purpose') return 'General'
  if (name === '') return 'Agent'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** Numbers repeated names in order: Explore, Explore 2, Explore 3. */
export function numberLabels(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return names.map(name => {
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    return count === 1 ? name : `${name} ${count}`
  })
}

/** What a tool call looks like from across the room. */
export function toolActivity(tool: string | undefined): Activity {
  if (tool === undefined) return 'working'
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(tool)) return 'reading'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'typing'
  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'BashOutput') return 'terminal'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'browsing'
  if (tool === 'Agent' || tool === 'Task') return 'helper'
  if (tool === 'Skill') return 'studying'
  if (tool.startsWith('mcp__')) return 'calling'
  return 'working'
}

export type ActivityFacts = {
  status: string
  phase: string
  tool?: string
  /** It has waited for the person's approval long enough to show. */
  isWaiting: boolean
}

export function activityOf(facts: ActivityFacts): Activity {
  if (facts.status === 'completed') return 'done'
  if (facts.status === 'failed') return 'failed'
  if (facts.status === 'killed') return 'stopped'
  if (facts.isWaiting) return 'waiting-you'
  if (facts.status === 'idle' || facts.status === 'waiting') return 'idle'
  if (facts.phase === 'thinking') return 'thinking'
  if (facts.phase === 'writing') return 'writing'
  if (facts.phase === 'starting') return 'starting'
  if (facts.phase === 'tool') return toolActivity(facts.tool)
  if (facts.phase === 'idle') return 'idle'
  return 'working'
}

/** The words a card says for an activity. */
export const ACTIVITY_WORDS: Readonly<Record<Activity, string>> = {
  typing: 'typing',
  reading: 'reading',
  terminal: 'at the terminal',
  browsing: 'browsing',
  helper: 'waiting on a helper',
  studying: 'studying a skill',
  calling: 'calling a service',
  thinking: 'thinking',
  writing: 'writing a reply',
  'waiting-you': 'waiting on you',
  starting: 'settling in',
  idle: 'on a break',
  working: 'working',
  done: 'done',
  failed: 'stuck',
  stopped: 'stopped',
}

/** The studio role each agent type plays, and its name: a card says it beside the agent's label. */
export const ARCHETYPES: Readonly<Record<Role, string>> = {
  lead: 'director Kaito',
  explore: 'location scout Pip',
  scout: 'sound engineer Rachael',
  plan: 'storyboard artist Mira',
  architect: 'producer Vance',
  reviewer: 'QC editor Ren',
  builder: 'animator Bolt',
  researcher: 'archivist Sora',
  general: 'studio assistant',
  other: 'intern',
  gladiator: 'gladiator',
  judge: 'judge',
}

/**
 * The cast of a gauntlet: while `/gauntlet` runs, its competitors are gladiators (A to H, one look each) and
 * its judges wear robes and wigs. The skill names each agent in its Agent call, and that name is all
 * the radar reads: `Gauntlet competitor C`, `Gauntlet judge r1m2`, or `Gauntlet judge r1m2 swap` for the judge
 * that sees one round-1 pair in swapped order. Nothing else of the brief.
 */
export const ARENA_SIZE = 8
export type Gauntlet = {
  role: 'gladiator' | 'judge'
  /** The full name, for cards and tooltips. */
  label: string
  /** The short name for the tags under the people; a match judge's is "Judge" until `teamOf` numbers it. */
  tag: string
  kind?: 'match' | 'swap' | 'check' | 'final'
  letter?: number
  match?: string
}

export function gauntletOf(description: string | undefined): Gauntlet | undefined {
  if (description === undefined) return undefined
  const competitor = /^Gauntlet competitor ([A-H])\b/.exec(description)
  if (competitor !== null) {
    const letter = competitor[1] ?? 'A'
    return { role: 'gladiator', label: `Gladiator ${letter}`, tag: `Glad ${letter}`, letter: letter.charCodeAt(0) - 65 }
  }
  const judge = /^Gauntlet judge (r\d{1,2}m\d{1,2}|final|check)$/.exec(description)
  if (judge !== null) {
    const which = judge[1] ?? ''
    const kind = which === 'final' || which === 'check' ? which : 'match'
    const tag = kind === 'match' ? 'Judge' : kind === 'final' ? 'Final' : 'Check'
    return { role: 'judge', label: `Judge ${which}`, tag, kind, match: which }
  }
  const swap = /^Gauntlet judge (r\d{1,2}m\d{1,2}) swap$/.exec(description)
  if (swap !== null) return { role: 'judge', label: `Judge ${swap[1] ?? ''} swap`, tag: 'Swap', kind: 'swap', match: swap[1] }
  return undefined
}

const isArena = (role: Role): role is 'gladiator' | 'judge' => role === 'gladiator' || role === 'judge'

/** How long the colosseum holds after the gauntlet's last step, and how long it waits through a gap with no gauntlet agent running. */
export const ARENA_LINGER_MS = 8000
export const ARENA_IDLE_MS = 180_000

/**
 * Whether this session's office is the colosseum. It is while any gladiator or judge runs, through the
 * gaps between waves and rounds (up to ARENA_IDLE_MS with none running: a stopped run ends there), and
 * until ARENA_LINGER_MS after the Lead runs the gauntlet's last step (`doneAt`). A gauntlet that starts
 * after `doneAt` turns it on again. Nothing is saved: it is worked out from the agents at hand.
 */
export function arenaOn(
  members: readonly Pick<Member, 'role' | 'isEnded' | 'startedAt' | 'endedAt'>[],
  now: number,
  doneAt?: number,
): boolean {
  const cast = members.filter(member => isArena(member.role))
  if (cast.length === 0) return false
  const newest = Math.max(...cast.map(member => member.startedAt))
  if (doneAt !== undefined && doneAt >= newest) return now - doneAt < ARENA_LINGER_MS
  if (cast.some(member => !member.isEnded)) return true
  const lastEnd = Math.max(...cast.map(member => member.endedAt ?? member.startedAt))
  return now - lastEnd < ARENA_IDLE_MS
}

/** The Lead's look in the colosseum is variant 1. */
const isEmperor = (member: Pick<Member, 'role' | 'variant'>): boolean => member.role === 'lead' && member.variant === 1

/** A card's role line: the named character's role, or for the arena's cast, the one this look plays. */
export function archetypeOf(member: Pick<Member, 'role' | 'variant'>): string {
  if (isArena(member.role)) return ARENA_NAMES[member.role][(member.variant ?? 0) % ARENA_SIZE] ?? ARCHETYPES[member.role]
  if (isEmperor(member)) return 'emperor Kaito'
  return ARCHETYPES[member.role]
}

/** The color of a card's activity line; undefined is the plain text color. */
export function activityColor(activity: Activity): string | undefined {
  switch (activity) {
    case 'waiting-you':
    case 'failed':
      return 'error'
    case 'idle':
    case 'starting':
    case 'helper':
      return 'warning'
    case 'done':
    case 'stopped':
      return undefined
    default:
      return 'success'
  }
}

/** A context gauge: `filled` of `width` blocks, green to amber to red as it fills. */
export function contextBar(fill: number, width = 16): { bar: string; color: string; percent: number } {
  const share = Math.min(1, Math.max(0, Number.isFinite(fill) ? fill : 0))
  const filled = Math.round(share * width)
  const color = share >= 0.85 ? '#f85149' : share >= 0.6 ? '#d29922' : '#3fb950'
  return { bar: `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`, color, percent: Math.round(share * 100) }
}

// People
// ---------------------------------------------------------------------------

// An animation studio's staff, drawn as chibi people 20 by 28: a big head (a fringe with strands, a shine
// on the hair, small dark eyes with a colored glint, blush) on a small body in casual clothes. The
// grids are in crew.ts, made by the sprite studio; here they are colored, outlined and placed. Each
// role is a named original character with its own face and prop; the general and other roles vary
// their hair, eyes and skin by id, so two of them are not twins.
export type Look = CrewLook

const SKINS = ['#ffe6d5', '#f9d2b6', '#ecb891', '#c98e63', '#8f5b3a']
const HAIRS = ['#2a2340', '#5b3527', '#f7c95e', '#ff8fc7', '#5aaeff', '#9b6bff', '#dfe3ee', '#e8424f', '#8a5a3c']
const CAT_HAIRS = ['#dcb98c', '#3a3350', '#ff9d4a', '#9aa3b5', '#f2efe6']
const EYES = ['#3b82f6', '#a855f7', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#06b6d4']
const OTHER_OUTFITS = ['#6a56a8', '#2b3a67', '#7a2e3a', '#2f5d4a', '#3d4458']

/**
 * The members with each one's variant set: by role, in start order (then id), the first is the
 * named character and the next ones are its siblings. A lone agent always looks like itself.
 */
export function withVariants<T extends Pick<Member, 'id' | 'role' | 'startedAt'>>(members: readonly T[]): (T & { variant: number })[] {
  const seen = new Map<Role, number>()
  const order = [...members].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const variants = new Map<string, number>()
  for (const member of order) {
    if (member.role === 'lead' || isArena(member.role)) {
      variants.set(member.id, 0)
      continue
    }
    const next = seen.get(member.role) ?? 0
    seen.set(member.role, next + 1)
    variants.set(member.id, next)
  }
  return members.map(member => ({ ...member, variant: variants.get(member.id) ?? 0 }))
}

/** FNV-1a: a stable number for a string, so an agent keeps its face. */
export function hashOf(text: string): number {
  let hash = 2166136261
  for (const ch of text) {
    hash ^= ch.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * How a sibling differs from the named character: hair and outfit turned to other hues, a lighter
 * or darker tone on a second lap, other eyes. Siblings keep the role's accent, skin and kit, so they
 * still read as that role.
 */
const SIBLINGS = [
  { hair: 0, outfit: 0 },
  { hair: 40, outfit: 150 },
  { hair: 80, outfit: 300 },
  { hair: 130, outfit: 60 },
  { hair: 190, outfit: 210 },
  { hair: 240, outfit: 120 },
  { hair: 290, outfit: 330 },
  { hair: 330, outfit: 90 },
] as const

export function lookOf(member: Pick<Member, 'id' | 'role' | 'variant'>): Look {
  if (isArena(member.role)) {
    const looks = ARENA_LOOKS[member.role]
    return looks[(member.variant ?? 0) % ARENA_SIZE] ?? (looks[0] as Look)
  }
  if (isEmperor(member)) return EMPEROR_LOOK
  const base = CREW_LOOKS[member.role]
  const variant = member.variant ?? 0
  if (member.role !== 'general' && member.role !== 'other') {
    if (variant <= 0) return base
    const sibling = SIBLINGS[variant % SIBLINGS.length] ?? SIBLINGS[1]
    const lap = Math.floor(variant / SIBLINGS.length)
    const light = lap === 0 ? 0 : lap % 2 === 1 ? 0.16 : -0.14
    return {
      ...base,
      hair: shiftHue(base.hair, sibling.hair, light),
      outfit: shiftHue(base.outfit, sibling.outfit, light),
      eyes: EYES[(variant + EYES.indexOf(base.eyes) + 1) % EYES.length] ?? base.eyes,
    }
  }
  const hash = hashOf(member.id)
  const hairs = member.role === 'general' ? CAT_HAIRS : HAIRS
  return {
    ...base,
    skin: SKINS[hash % SKINS.length] ?? base.skin,
    hair: hairs[(hash >>> 4) % hairs.length] ?? base.hair,
    eyes: EYES[(hash >>> 12) % EYES.length] ?? base.eyes,
    outfit: member.role === 'other' ? (OTHER_OUTFITS[(hash >>> 8) % OTHER_OUTFITS.length] ?? base.outfit) : base.outfit,
  }
}

/** People are drawn at twice the room's resolution: one room pixel is DETAIL by DETAIL person pixels. */
export const DETAIL = 2
/** A person's sprite: 20 wide and 28 tall; the head is the top 17 rows. */
export const SPRITE_W = 20
export const SPRITE_H = 28
/** A card's portrait: the head, rows 0 to 17. */
const AVATAR_H = 18

/** The face a person makes at a desk: eyes on the screen at work, wide for a request, shut on a break. */
function seatMood(activity: Activity): Mood {
  if (activity === 'waiting-you') return 'wow'
  if (activity === 'idle') return 'sleepy'
  if (activity === 'starting') return 'normal'
  return 'work'
}

/** The face of someone on their feet: glad when done, stuck when it failed, plain otherwise. */
export function figureMood(activity: Activity): Mood {
  if (activity === 'done') return 'happy'
  if (activity === 'failed') return 'stuck'
  return 'normal'
}

/** A finished agent fades to rest. A stuck one does not: it still needs a look. */
export function isFaded(activity: Activity): boolean {
  return activity === 'done' || activity === 'stopped'
}

/** The grids of a role; for the arena's cast, of the one look `variant` names. */
function spriteSet(role: Role, variant: number): CrewSprite {
  if (isArena(role)) {
    const set = ARENA[role]
    return set[variant % ARENA_SIZE] ?? (set[0] as CrewSprite)
  }
  if (role === 'lead' && variant === 1) return EMPEROR
  return CREW[role]
}

const seatRows = (role: Role, variant: number, mood: Mood): string[] => [...spriteSet(role, variant).head[mood], ...spriteSet(role, variant).seatBody]
const figureRows = (role: Role, variant: number, mood: Mood, pose: Pose): string[] => [
  ...spriteSet(role, variant).head[mood],
  ...spriteSet(role, variant).body,
  ...spriteSet(role, variant).legs[pose],
]

/** An outline cell takes its neighbor's palette key, moved into a private range: it is drawn in a dark shade of that color. */
const OUTLINE_FIRST = 0xe000
const outlineKey = (key: string): string => String.fromCharCode(OUTLINE_FIRST + key.charCodeAt(0))

/**
 * Rows with an outline added: every empty cell next to a drawn one, up, down, left or right, takes
 * the key of the neighbor below first (the soft side), then left, right and above.
 */
export function outlined(rows: readonly string[]): string[] {
  const at = (r: number, c: number): string | undefined => {
    const ch = rows[r]?.[c]
    return ch === undefined || ch === '.' ? undefined : ch
  }
  return rows.map((row, r) =>
    [...row]
      .map((ch, c) => {
        if (ch !== '.') return ch
        const near = at(r + 1, c) ?? at(r, c - 1) ?? at(r, c + 1) ?? at(r - 1, c)
        return near === undefined ? '.' : outlineKey(near)
      })
      .join(''),
  )
}

const OUTLINES = new Map<string, string[]>()
/** A sprite's outlined rows, made once. */
function spriteOf(kind: 'seat' | Pose, role: Role, variant: number, mood: Mood): string[] {
  const own = isArena(role) ? variant % ARENA_SIZE : role === 'lead' && variant === 1 ? 1 : 0
  const key = `${kind}/${role}/${own}/${mood}`
  let rows = OUTLINES.get(key)
  if (rows === undefined) {
    rows = outlined(kind === 'seat' ? seatRows(role, own, mood) : figureRows(role, own, mood, kind))
    OUTLINES.set(key, rows)
  }
  return rows
}

/**
 * The palette of a person: H hair, h its strand shade, w its shine; S skin, s its shade, B blush;
 * E the eye, J its glint, W white; M and m the mouth; C the outfit, c its shade, d its light; A the
 * accent, K the kit; P trousers, F shoes with an accent toe (f). Every key has an outline shade.
 */
function peopleColors(look: Look, isDim: boolean): Record<string, string> {
  const skin = look.skin
  const base: Record<string, string> = {
    H: look.hair,
    h: blend(look.hair, '#1a1030', 0.32),
    w: blend(look.hair, '#ffffff', 0.6),
    S: skin,
    s: blend(skin, '#c47f78', 0.5),
    B: blend(skin, '#ff5c8a', 0.6),
    L: skin,
    E: '#2a1c3a',
    I: blend(look.eyes, '#0c0a2a', 0.55),
    J: look.eyes,
    i: blend(blend(look.eyes, '#fff0a0', 0.5), '#ffffff', 0.15),
    W: '#ffffff',
    M: '#b83a55',
    m: '#e3808f',
    C: look.outfit,
    c: blend(look.outfit, '#10102a', 0.3),
    d: blend(look.outfit, '#ffffff', 0.25),
    A: look.accent,
    a: blend(look.accent, '#10102a', 0.35),
    K: look.kit,
    k: blend(look.kit, '#3a2a1a', 0.3),
    G: '#7fd6ff',
    g: '#ffffff',
    P: look.pants,
    Z: '#6f7890',
    z: '#bfe9ff',
    F: '#f4f4fa',
    f: look.accent,
    D: '#7cc8ff',
    Y: '#a8702f',
    y: '#e6c99a',
  }
  const colors: Record<string, string> = {}
  for (const [key, color] of Object.entries(base)) {
    const tone = isDim ? blend(color, '#c9a27a', 0.22) : color
    colors[key] = tone
    colors[outlineKey(key)] = blend(tone, '#140a24', 0.9)
  }
  return colors
}

/** Working hard enough to nod along. */
const BUSY: ReadonlySet<Activity> = new Set(['typing', 'writing', 'terminal', 'reading', 'browsing', 'calling', 'working'])
/** Hands on the keys. */
const TYPING: ReadonlySet<Activity> = new Set(['typing', 'writing', 'terminal', 'working'])

/** The 8 by 8 screen of a desk's monitor, showing what its person does. Person pixels. */
function paintScreen(canvas: Canvas, x: number, y: number, activity: Activity, role: Role, frame: number): void {
  const odd = frame % 2 === 1
  const box = (dx: number, dy: number, w: number, h: number, color: string): void => fillRect(canvas, x + dx, y + dy, w, h, color)
  const fill = (color: string): void => box(0, 0, 8, 8, color)
  switch (activity) {
    case 'typing':
    case 'writing':
    case 'working':
      if (role === 'plan') {
        // A storyboard panel being drawn.
        fill('#faf7ee')
        box(1, 1, 6, 4, '#c8e0ff')
        box(2, 3, 2, 2, CR_ORANGE)
        box(1, 6, odd ? 5 : 3, 1, '#5a5a6e')
        return
      }
      if (role === 'builder') {
        // Animation frames on a timeline, one lit in turn.
        fill('#1e1a34')
        for (let i = 0; i < 3; i += 1) box(i * 3, 1, 2, 3, i === frame % 3 ? '#ffffff' : '#7a6ea0')
        box(0, 5, 8, 1, '#3fb950')
        box(1 + (frame % 6), 5, 1, 1, '#ffffff')
        return
      }
      fill('#0d1117')
      box(1, 1, 4, 1, '#7ee787')
      box(3, 2, odd ? 3 : 5, 1, '#79c0ff')
      box(3, 3, 3, 1, '#ffa657')
      box(1, 4, odd ? 4 : 5, 1, '#d2a8ff')
      box(3, 5, 4, 1, '#79c0ff')
      return
    case 'terminal':
      fill('#010409')
      box(1, 1, 1, 1, '#3fb950')
      box(2, 2, 1, 1, '#3fb950')
      box(1, 3, 1, 1, '#3fb950')
      box(4, 3, 2, 1, '#3fb950')
      box(1, 5, 4, 1, '#287837')
      if (odd) box(6, 5, 1, 2, '#7ee787')
      return
    case 'browsing':
      fill('#e6edf3')
      box(0, 0, 8, 1, '#2f81f7')
      box(1, 2, 6, 1, '#8b949e')
      box(1, 4, odd ? 6 : 4, 1, '#8b949e')
      box(1, 6, odd ? 3 : 5, 1, '#8b949e')
      return
    case 'reading': {
      fill('#f2e8d5')
      const top = odd ? 2 : 1
      for (let i = 0; i < 3; i += 1) box(1, top + i * 2, 6, 1, '#8b949e')
      return
    }
    case 'thinking':
      fill('#0b1d3a')
      for (let i = 0; i < 3; i += 1) box(1 + i * 3, 4, 1, 1, i === frame % 3 ? '#9cc2ff' : '#2c4a80')
      return
    case 'helper':
    case 'studying':
    case 'calling':
      fill('#1a2233')
      box(1 + (frame % 6), 3, 1, 2, '#d29922')
      box(1, 6, 6, 1, '#3a4660')
      return
    case 'waiting-you':
      fill(odd ? '#5a1e1e' : '#c81e28')
      box(3, 1, 2, 3, '#ffffff')
      box(3, 5, 2, 1, '#ffffff')
      return
    case 'starting':
      fill('#30363d')
      return
    default:
      fill(COLOR.screenOff)
  }
}

type Box = readonly [x: number, y: number, w: number, h: number, color: string]

/** What lies on each desk, by role: a prop or two on the desk top. x and y count from the desk's left edge and top; person pixels. */
const PROPS: Readonly<Record<Role, readonly Box[]>> = {
  // A clapperboard.
  lead: [
    [4, 0, 10, 1, '#f5f5f5'], [4, 0, 1, 1, '#24242c'], [7, 0, 1, 1, '#24242c'], [10, 0, 1, 1, '#24242c'], [13, 0, 1, 1, '#24242c'],
    [4, 1, 10, 3, '#24242c'], [5, 2, 4, 1, '#f5f5f5'],
  ],
  // A camera and a folded map.
  explore: [[4, 1, 7, 3, '#2d2f3a'], [6, 1, 3, 2, '#7fd6ff'], [13, 1, 6, 3, '#f0dca0'], [15, 1, 1, 3, '#78593c']],
  // A small mixing board with faders and knobs.
  scout: [
    [4, 0, 11, 4, '#3a3d4e'], [5, 1, 1, 2, '#12141c'], [7, 1, 1, 2, '#12141c'], [9, 1, 1, 2, '#12141c'], [11, 1, 1, 2, '#12141c'], [13, 1, 1, 2, '#12141c'],
    [5, 2, 1, 1, CR_ORANGE], [7, 1, 1, 1, '#ffffff'], [9, 2, 1, 1, CR_ORANGE], [11, 1, 1, 1, '#ffffff'], [13, 2, 1, 1, CR_ORANGE],
  ],
  // A sketchbook with panels, and a pencil.
  plan: [[4, 0, 11, 4, '#faf7ee'], [5, 1, 4, 2, '#c8e0ff'], [10, 1, 4, 2, '#ffd6e0'], [16, 2, 7, 1, '#ffd166'], [23, 2, 1, 1, '#ff8fb1']],
  // A phone, a coffee and a folder.
  architect: [
    [4, 0, 3, 4, '#2d2f3a'], [5, 1, 1, 2, '#78aaff'], [9, 0, 4, 4, '#fff6e8'], [10, 1, 2, 1, '#7a4a2a'], [15, 0, 8, 4, '#f0c86e'],
  ],
  // A clipboard with a checklist, and a red pen.
  reviewer: [
    [4, 0, 8, 5, '#8a5a33'], [5, 1, 6, 4, '#faf7ee'], [6, 0, 4, 1, '#c8c8d2'], [6, 2, 1, 1, '#3fb950'], [8, 2, 2, 1, '#8b949e'],
    [6, 3, 1, 1, '#e5484d'], [8, 3, 2, 1, '#8b949e'], [14, 2, 6, 1, '#d23c3c'],
  ],
  // A drawing tablet and a stylus.
  builder: [[4, 0, 12, 4, '#2d2f3a'], [5, 1, 10, 3, '#46496a'], [7, 2, 2, 1, '#ff8fb1'], [17, 2, 5, 1, '#e6e6f0']],
  // A stack of books, and a magnifying glass.
  researcher: [
    [4, 2, 10, 2, '#8a5a3c'], [5, 1, 8, 1, '#7f9444'], [6, 0, 6, 1, '#c28a2b'],
    [16, 0, 4, 1, '#c28a2b'], [16, 1, 1, 2, '#c28a2b'], [19, 1, 1, 2, '#c28a2b'], [16, 3, 4, 1, '#c28a2b'], [17, 1, 2, 2, '#bfe9ff'], [20, 3, 2, 1, '#78593c'],
  ],
  // A tea tray with a cup and a pot, and a pad of sticky notes.
  general: [
    [4, 3, 10, 1, '#6f7890'], [6, 1, 3, 2, '#ffffff'], [9, 1, 1, 1, '#ffffff'], [11, 0, 3, 3, '#ff8fb0'], [17, 1, 4, 3, '#ffd166'], [18, 2, 2, 1, '#c28a2b'],
  ],
  // Papers, sticky notes and a big coffee.
  other: [
    [4, 1, 9, 3, '#fafafa'], [4, 2, 9, 1, '#c8c8d4'], [15, 1, 3, 3, '#ffd166'], [18, 2, 3, 3, '#ff8fb1'], [23, 0, 3, 4, '#fff6e8'], [24, 1, 1, 1, '#7a4a2a'],
  ],
  // The arena's cast has a prop each: see ARENA_PROPS.
  gladiator: [],
  judge: [],
}

/** Each gladiator's and judge's desk top: their kit laid out, as boxes like PROPS. */
const STEEL = '#bfe9ff'
const WOOD = '#a8702f'
const GOLD = '#d9a441'
const ARENA_PROPS: Readonly<Record<'gladiator' | 'judge', readonly (readonly Box[])[]>> = {
  gladiator: [
    // murmillo: a blue scutum and a short sword.
    [[4, 0, 6, 4, '#2f5fb0'], [6, 1, 2, 2, GOLD], [12, 2, 8, 1, STEEL], [20, 1, 2, 3, GOLD]],
    // retiarius: a trident and a few knots of net.
    [[4, 2, 16, 1, WOOD], [20, 0, 1, 4, STEEL], [22, 0, 1, 4, STEEL], [21, 1, 1, 1, STEEL], [6, 0, 1, 1, '#ffd166'], [8, 0, 1, 1, '#ffd166'], [10, 0, 1, 1, '#ffd166'], [7, 1, 1, 1, '#ffd166'], [9, 1, 1, 1, '#ffd166']],
    // thraex: a round shield and a curved sica.
    [[4, 0, 5, 4, '#a8402a'], [6, 1, 1, 2, '#f47521'], [11, 1, 6, 1, STEEL], [16, 2, 2, 1, STEEL], [10, 2, 1, 2, '#c28a2b']],
    // secutor: a steel shield with a red stripe and a helmet.
    [[4, 0, 5, 4, '#8a94ad'], [6, 0, 1, 4, '#d23c3c'], [12, 1, 5, 3, '#8a94ad'], [14, 0, 1, 1, '#d23c3c']],
    // hoplomachus: a long spear and a red plume.
    [[4, 2, 18, 1, WOOD], [22, 1, 2, 3, STEEL], [17, 0, 2, 2, '#e5484d'], [4, 0, 4, 2, '#7a2e3a']],
    // provocator: a silver breastplate trimmed in gold, and a feather.
    [[4, 0, 8, 4, '#c9d1d9'], [4, 0, 8, 1, '#e9c46a'], [14, 0, 6, 1, '#e9c46a'], [15, 1, 5, 1, '#e9c46a'], [14, 3, 6, 1, STEEL]],
    // eques: a pennant on a pole and a round shield.
    [[4, 0, 1, 4, WOOD], [5, 0, 7, 3, '#d23c3c'], [14, 0, 5, 4, '#2f6a4a'], [16, 1, 1, 2, '#e3c27a']],
    // dimachaerus: two crossed short swords and a whetstone.
    [[4, 0, 1, 1, STEEL], [5, 1, 1, 1, STEEL], [6, 2, 1, 1, STEEL], [7, 3, 1, 1, STEEL], [7, 0, 1, 1, STEEL], [6, 1, 1, 1, STEEL], [5, 2, 1, 1, STEEL], [4, 3, 1, 1, STEEL], [12, 2, 6, 2, '#8a94ad']],
  ],
  judge: [
    // Gavel: a gavel and its block.
    [[4, 2, 8, 2, '#78593c'], [6, 0, 4, 2, GOLD], [14, 2, 7, 1, WOOD], [20, 1, 3, 3, GOLD]],
    // Writ: a scroll with a red ribbon.
    [[4, 1, 12, 3, '#f5ecd8'], [4, 1, 1, 3, '#c28a2b'], [15, 1, 1, 3, '#c28a2b'], [9, 1, 2, 3, '#a8202a']],
    // Scales: a pair of scales.
    [[5, 0, 14, 1, GOLD], [11, 1, 2, 3, '#c28a2b'], [8, 3, 8, 1, '#c28a2b'], [4, 1, 4, 1, GOLD], [16, 1, 4, 1, GOLD]],
    // Quill: an inkwell and a quill.
    [[4, 1, 4, 3, '#1f2f5a'], [5, 1, 2, 1, '#0d1117'], [8, 0, 10, 1, '#f5f5f5'], [17, 0, 3, 1, '#d8d8e0']],
    // Statute: a stack of law books.
    [[4, 2, 12, 2, '#1f5a3a'], [5, 1, 10, 1, '#a8202a'], [6, 0, 8, 1, '#4a2f7a']],
    // Seal: a stamped paper and the stamp.
    [[4, 0, 9, 4, '#f5ecd8'], [8, 1, 3, 2, '#a8202a'], [15, 1, 3, 3, '#78593c']],
    // Bell: a bell and a stack of papers.
    [[5, 0, 5, 3, GOLD], [4, 3, 7, 1, '#c28a2b'], [12, 1, 8, 3, '#f5f5f5'], [12, 2, 8, 1, '#c8c8d4']],
    // Docket: a gold nameplate and a gavel.
    [[4, 1, 12, 3, GOLD], [6, 2, 8, 1, '#2a2f45'], [18, 1, 4, 3, '#78593c']],
  ],
}

/** The emperor's bench: a gold goblet, a decree scroll and a laurel sprig. */
const EMPEROR_PROPS: readonly Box[] = [
  [4, 0, 4, 4, GOLD], [5, 0, 2, 1, '#fff0c0'], [8, 2, 4, 2, GOLD], [14, 1, 10, 3, '#f5ecd8'], [14, 1, 1, 3, '#c28a2b'], [23, 1, 1, 3, '#c28a2b'], [18, 1, 2, 3, '#a8202a'],
]

/** A seat's props: by role, or for the arena's cast, those of the look it plays. */
function propsOf(member: Pick<Member, 'role' | 'variant'>): readonly Box[] {
  if (isArena(member.role)) return ARENA_PROPS[member.role][(member.variant ?? 0) % ARENA_SIZE] ?? []
  if (isEmperor(member)) return EMPEROR_PROPS
  return PROPS[member.role]
}

/** The desk of the seat at room pixel `x, y` on a canvas at DETAIL: the top and front, and a monitor that is off. */
export function paintDesk(canvas: Canvas, x: number, y: number): void {
  const px = x * DETAIL
  const py = y * DETAIL
  fillRect(canvas, px + 2, py + 22, 32, 1, COLOR.deskEdge)
  fillRect(canvas, px + 2, py + 23, 32, 4, COLOR.deskTop)
  fillRect(canvas, px + 2, py + 27, 32, 5, COLOR.deskFront)
  fillRect(canvas, px + 2, py + 31, 32, 1, COLOR.deskShade)
  fillRect(canvas, px + 27, py + 20, 4, 2, COLOR.stand)
  fillRect(canvas, px + 24, py + 8, 10, 12, COLOR.monitor)
  fillRect(canvas, px + 25, py + 9, 8, 8, COLOR.screenOff)
}

/** What changes from frame to frame at a desk: the screen, and the hands on the desk top. */
export function paintDeskLive(canvas: Canvas, x: number, y: number, member: Member, frame: number): void {
  const px = x * DETAIL
  const py = y * DETAIL
  paintScreen(canvas, px + 25, py + 9, member.activity, member.role, frame)
  const skin = lookOf(member).skin
  const isTyping = TYPING.has(member.activity) && frame % 2 === 1
  fillRect(canvas, px + (isTyping ? 9 : 8), py + 23, 4, 2, skin)
  fillRect(canvas, px + (isTyping ? 13 : 14), py + 23, 4, 2, skin)
}

/** The person at the desk whose top-left corner is room pixel `x, y`, on a canvas at DETAIL, with the props on the desk top. */
export function paintSeated(canvas: Canvas, x: number, y: number, member: Member, frame: number): void {
  const nod = BUSY.has(member.activity) && frame % 2 === 1 ? 1 : 0
  for (const [bx, by, bw, bh, color] of propsOf(member)) fillRect(canvas, x * DETAIL + bx, y * DETAIL + 23 + by, bw, bh, color)
  const rows = spriteOf('seat', member.role, member.variant ?? 0, seatMood(member.activity))
  drawSprite(canvas, x * DETAIL + 2, y * DETAIL + 2 + nod, rows, peopleColors(lookOf(member), false), y * DETAIL + 22)
}

/** A whole person at room pixel `x, y`, 20 by 28 on a canvas at DETAIL: walking (two steps) or standing. */
export function paintFigure(
  canvas: Canvas,
  x: number,
  y: number,
  member: Pick<Member, 'id' | 'role' | 'variant'>,
  pose: Pose,
  isDim: boolean,
  mood: Mood = 'normal',
): void {
  paintFigurePx(canvas, Math.round(x * DETAIL), Math.round(y * DETAIL), member, pose, isDim, mood)
}

/** The same person at person pixel `px, py`, optionally mirrored: a fighter on the right faces left. */
export function paintFigurePx(
  canvas: Canvas,
  px: number,
  py: number,
  member: Pick<Member, 'id' | 'role' | 'variant'>,
  pose: Pose,
  isDim: boolean,
  mood: Mood = 'normal',
  isMirrored = false,
): void {
  const rows = spriteOf(pose, member.role, member.variant ?? 0, mood)
  drawSprite(canvas, px, py, isMirrored ? rows.map(row => [...row].reverse().join('')) : rows, peopleColors(lookOf(member), isDim))
}


// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

export type Seat = { index: number; x: number; y: number; member?: Member }
export type Spot = { x: number; y: number; member: Member }
/** A gladiator on the sand: a pair faces each other, the right one mirrored; an odd one fights alone. */
export type Stand = { x: number; y: number; member: Member; side: 'left' | 'right' | 'solo'; pair: number }
export type Layout = {
  width: number
  height: number
  perRow: number
  seats: Seat[]
  spots: Spot[]
  extraDone: number
  loungeY: number
  /** The colosseum: benches for the Lead and the judges, a sand ring for the gladiators, the sidelines for the finished. */
  arena?: boolean
  stands?: Stand[]
  sandY?: number
}

/** The lounge keeps the right side for a vending machine, and for a ramen counter too when the room is wide. */
const COUNTER_MIN_WIDTH = 76
const loungeReserve = (width: number): number => (width >= COUNTER_MIN_WIDTH ? 26 : 10)

/**
 * Places everyone: live members at their desks (seat 0 is the Lead's, a full row of desks at a
 * time, empty ones too), ended ones in the lounge, the most recent first. Undefined when the room
 * would not fit two desks across.
 */
export function layoutOffice(members: readonly Member[], columns: number): Layout | undefined {
  if (!Number.isFinite(columns) || columns < MIN_OFFICE_COLUMNS) return undefined
  const perRow = Math.max(2, Math.min(MAX_PER_ROW, Math.floor((columns - 2 * MARGIN) / SEAT_W)))
  const live = members.filter(member => !member.isEnded)
  const done = members
    .filter(member => member.isEnded)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const highest = live.reduce((top, member) => Math.max(top, member.seat), 0)
  const deskRows = Math.floor(highest / perRow) + 1
  const width = 2 * MARGIN + perRow * SEAT_W
  const top = WALL_H + FLOOR_PAD
  const seats: Seat[] = Array.from({ length: deskRows * perRow }, (_, index) => ({
    index,
    x: MARGIN + (index % perRow) * SEAT_W,
    y: top + Math.floor(index / perRow) * SEAT_H,
  }))
  for (const member of live) {
    const wanted = seats[member.seat]
    const seat = wanted !== undefined && wanted.member === undefined ? wanted : seats.find(one => one.index > 0 && one.member === undefined)
    if (seat !== undefined) seat.member = member
  }
  const loungeY = top + deskRows * SEAT_H
  const capacity = Math.max(1, Math.floor((width - 2 * MARGIN - loungeReserve(width)) / SPOT_W))
  const spots = done.slice(0, capacity).map((member, i) => ({ member, x: MARGIN + 1 + i * SPOT_W, y: loungeY + 3 }))
  const height = loungeY + (done.length > 0 ? LOUNGE_H : 0) + 2
  return { width, height: height + (height % 2), perRow, seats, spots, extraDone: done.length - spots.length, loungeY }
}

/** The 3 by 5 letters of the neon sign. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  S: ['###', '#..', '###', '..#', '###'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  O: ['###', '#.#', '#.#', '#.#', '###'],
  G: ['###', '#..', '#.#', '#.#', '###'],
  A: ['###', '#.#', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  E: ['###', '#..', '###', '#..', '###'],
}
const SIGN_PLATE_W = 27

/** What hangs on the back wall, by the room's width: always the door and the token board; a night window, the sign, a corkboard or a clapperboard as there is room. */
type WallPlan = { boardX: number; window?: { x: number; w: number }; sign?: { x: number }; cork?: { x: number; w: number }; clapper?: { x: number } }

function wallPlan(width: number): WallPlan {
  const boardX = width - 19
  const left = DOOR_X + 11
  const right = boardX - 2
  const free = right - left
  const plan: WallPlan = { boardX }
  let next = left
  if (free >= SIGN_PLATE_W + 2 + 14) {
    const w = Math.min(26, free - SIGN_PLATE_W - 2)
    plan.window = { x: left, w }
    plan.sign = { x: left + w + 2 }
    next = left + w + 2 + SIGN_PLATE_W + 2
  } else if (free >= SIGN_PLATE_W) {
    plan.sign = { x: left + Math.floor((free - SIGN_PLATE_W) / 2) }
    next = right
  } else if (free >= 10) {
    plan.window = { x: left, w: free - 1 }
    next = right
  }
  const rest = right - next
  if (rest >= 20) plan.cork = { x: next, w: Math.min(rest, 30) }
  else if (rest >= 9) plan.clapper = { x: next }
  return plan
}

/** A studio door with an orange noren curtain over it, where the team comes in. */
function paintDoor(canvas: Canvas): void {
  fillRect(canvas, DOOR_X, 1, 8, 9, COLOR.doorFrame)
  fillRect(canvas, DOOR_X + 1, 3, 6, 7, COLOR.door)
  fillRect(canvas, DOOR_X + 5, 6, 1, 2, COLOR.doorKnob)
  fillRect(canvas, DOOR_X, 1, 8, 3, CR_ORANGE)
  fillRect(canvas, DOOR_X + 2, 3, 1, 1, COLOR.norenDark)
  fillRect(canvas, DOOR_X + 5, 3, 1, 1, COLOR.norenDark)
  fillRect(canvas, DOOR_X, 1, 8, 1, COLOR.lanternLight)
}

/** The night window: sky, a moon, a skyline whose windows twinkle in four frames. */
function paintNightWindow(canvas: Canvas, x: number, w: number, frame: number): void {
  fillRect(canvas, x, 1, w, 8, COLOR.windowFrame)
  fillRect(canvas, x + 1, 2, w - 2, 6, COLOR.night)
  fillRect(canvas, x + 1, 5, w - 2, 3, COLOR.nightLow)
  const moon = x + w - 5
  if (w >= 14) fillRect(canvas, moon, 3, 2, 2, COLOR.moon)
  const heights = [3, 4, 2, 5, 3, 4, 2]
  for (let bx = x + 1, i = 0; bx < x + w - 1; bx += 3, i += 1) {
    const h = Math.min(heights[i % heights.length] ?? 3, 5)
    const bw = Math.min(2, x + w - 1 - bx)
    fillRect(canvas, bx, 8 - h, bw, h, COLOR.skyline)
    if (h >= 3 && (i + (frame % 4 < 2 ? 0 : 1)) % 2 === 0) setPixel(canvas, bx, 8 - h + 1, COLOR.skylineLit)
  }
  fillRect(canvas, x + Math.floor(w / 2), 2, 1, 6, COLOR.windowFrame)
}

/** The STUDIO neon sign: an orange rim, a dark face, 3 by 5 letters. */
function paintSign(canvas: Canvas, x: number): void {
  fillRect(canvas, x, 1, SIGN_PLATE_W, 7, CR_ORANGE)
  fillRect(canvas, x + 1, 2, SIGN_PLATE_W - 2, 5, COLOR.neonFace)
  ;[...'STUDIO'].forEach((letter, i) => {
    ;(GLYPHS[letter] ?? []).forEach((row, dy) => {
      ;[...row].forEach((cell, dx) => {
        if (cell === '#') setPixel(canvas, x + 2 + i * 4 + dx, 2 + dy, COLOR.neonText)
      })
    })
  })
}

/** A clapperboard: striped clapper over a dark slate with chalk lines. */
function paintClapper(canvas: Canvas, x: number): void {
  fillRect(canvas, x, 3, 8, 6, COLOR.slate)
  fillRect(canvas, x, 1, 8, 2, COLOR.chalk)
  for (let dx = 0; dx < 8; dx += 3) fillRect(canvas, x + dx, 1, 1, 2, COLOR.slate)
  fillRect(canvas, x + 1, 5, 3, 1, COLOR.chalk)
  fillRect(canvas, x + 1, 7, 5, 1, COLOR.chalk)
}

/** A corkboard of storyboard panels pinned up. */
function paintCork(canvas: Canvas, x: number, w: number): void {
  fillRect(canvas, x, 1, w, 8, COLOR.corkFrame)
  fillRect(canvas, x + 1, 2, w - 2, 6, COLOR.cork)
  const papers = ['#f4f4f0', '#ffeec8', '#d2e8ff', '#ffd6e0', '#e1f0d2']
  for (let i = 0, px = x + 2; px + 3 < x + w - 1; i += 1, px += 5) {
    const py = 2 + (i % 2) * 2
    fillRect(canvas, px, py, 3, 3, papers[i % papers.length] ?? '#f4f4f0')
    setPixel(canvas, px + 1, py, COLOR.pin)
  }
}

function paintWall(canvas: Canvas, spend: KindSpend, frame: number): void {
  const width = canvas.width
  fillRect(canvas, 0, 0, width, WALL_H, COLOR.wall)
  fillRect(canvas, 0, 0, width, 1, COLOR.wallEdge)
  fillRect(canvas, 0, WALL_H - 2, width, 1, COLOR.wallBase)
  fillRect(canvas, 0, WALL_H - 1, width, 1, COLOR.baseboard)
  const plan = wallPlan(width)
  paintDoor(canvas)
  if (plan.window !== undefined) paintNightWindow(canvas, plan.window.x, plan.window.w, frame)
  if (plan.sign !== undefined) paintSign(canvas, plan.sign.x)
  if (plan.cork !== undefined) paintCork(canvas, plan.cork.x, plan.cork.w)
  if (plan.clapper !== undefined) paintClapper(canvas, plan.clapper.x)
  // The token board: a whiteboard, subagent tokens by route kind as bars, a sticky note in the corner.
  paintBoard(canvas, plan.boardX, spend, 1)
}

/** The carpet: soft blocks in two tones. */
function paintFloor(canvas: Canvas, top = WALL_H): void {
  for (let y = top; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const block = (Math.floor(x / 4) + Math.floor((y - top) / 4)) % 2
      setPixel(canvas, x, y, block === 0 ? COLOR.carpet : COLOR.carpetAlt)
    }
  }
  fillRect(canvas, 0, top, canvas.width, 1, COLOR.carpetEdge)
}

/** Where the vending machine stands, by the right side. */
const machineX = (width: number): number => width - MARGIN - 7
/** Where the ramen counter stands, left of the machine; only in a wide room. */
const counterX = (width: number): number => machineX(width) - 18

/** Steam over the bowls and the cup loops in four frames: a still deck draws the same each second. */
function paintLounge(canvas: Canvas, layout: Layout, frame: number, motion: boolean): void {
  const y = layout.loungeY
  const width = canvas.width
  // The break room: pale tiles under a wooden skirting line.
  for (let row = y + 1; row < canvas.height; row += 1) {
    for (let x = 0; x < width; x += 1) {
      const tile = (Math.floor(x / 3) + Math.floor((row - y) / 3)) % 2
      setPixel(canvas, x, row, tile === 0 ? COLOR.tile : COLOR.tileAlt)
    }
  }
  fillRect(canvas, 0, y, width, 1, COLOR.skirting)
  // The vending machine: a lit glass front with rows of cans, a dark slot, a cup on the floor.
  const mx = machineX(width)
  fillRect(canvas, mx, y + 3, 7, 13, COLOR.machine)
  fillRect(canvas, mx, y + 14, 7, 2, COLOR.machineShade)
  fillRect(canvas, mx + 1, y + 4, 5, 5, COLOR.machineGlass)
  ;['#3fb950', '#f2cc60', '#58a6ff', '#ff8fbf', '#3fb950'].forEach((color, i) => {
    fillRect(canvas, mx + 1 + i, y + 5, 1, 2, color)
    fillRect(canvas, mx + 1 + i, y + 8 - (i % 2), 1, 1, color)
  })
  fillRect(canvas, mx + 1, y + 11, 5, 2, COLOR.machineSlot)
  fillRect(canvas, mx - 3, y + 12, 2, 3, COLOR.cup)
  fillRect(canvas, mx - 3, y + 12, 2, 1, CR_ORANGE)
  const lift = frame % 4 >= 2 ? 1 : 0
  if (motion) setPixel(canvas, mx - 3 + (frame % 2), y + 10 - lift, COLOR.steam)
  // A ramen counter: bowls with steam, red stools.
  if (width >= COUNTER_MIN_WIDTH) {
    const cx = counterX(width)
    fillRect(canvas, cx, y + 9, 16, 1, COLOR.counterTop)
    fillRect(canvas, cx, y + 10, 16, 4, COLOR.counter)
    fillRect(canvas, cx, y + 14, 16, 1, COLOR.counterShade)
    for (const bx of [cx + 2, cx + 9]) {
      fillRect(canvas, bx, y + 8, 5, 1, COLOR.bowl)
      fillRect(canvas, bx + 1, y + 7, 3, 1, COLOR.ramen)
      setPixel(canvas, bx + 2, y + 7, COLOR.egg)
      if (motion) setPixel(canvas, bx + 1 + ((frame + (bx % 3)) % 3), y + 5 - lift, COLOR.steam)
    }
    for (const sx of [cx + 3, cx + 10]) {
      fillRect(canvas, sx, y + 16, 3, 1, COLOR.stool)
      setPixel(canvas, sx + 1, y + 17, COLOR.stoolLeg)
    }
  }
}

function paintRoom(canvas: Canvas, layout: Layout, spend: KindSpend, frame: number, motion: boolean): void {
  if (layout.arena === true) {
    paintArenaBase(canvas, layout)
    return
  }
  paintFloor(canvas)
  paintWall(canvas, spend, motion ? frame : 0)
  if (layout.spots.length > 0) paintLounge(canvas, layout, frame, motion)
}

// ---------------------------------------------------------------------------
// The colosseum: the office while a gauntlet runs
// ---------------------------------------------------------------------------

const ARENA_WALL_H = 18
const SAND_ROW_H = 19
const PAIR_W = 34
/** Room pixels from a pair's left sprite to its right one. */
const PAIR_GAP = 17
/** Where the cast comes in: the gate in the arena wall. */
const ARENA_GATE: Point = { x: DOOR_X, y: 4 }

const ARENA_COLOR = {
  crowdBack: '#3a1f2a',
  parapet: '#d6be8a',
  stone: '#bea068',
  stone2: '#ac8e5a',
  stone3: '#d6be8a',
  arch: '#2e2018',
  bars: '#50402c',
  sand: '#e8cc94',
  sand2: '#ddbe82',
  sand3: '#cdac70',
  fence: '#7a4a2a',
  fenceShade: '#5a361e',
  benchTop: '#8a5a33',
  benchEdge: '#b48250',
  benchFront: '#6b4426',
  benchTrim: '#d9a441',
  benchShade: '#462c18',
  banner: '#961824',
  gold: '#d9a441',
  goldText: '#ffe08c',
  rack: '#6b4426',
  white: '#ffffff',
  glow: '#ffec96',
  spark: '#fff3a3',
  flame: '#ffd166',
  flameHot: '#f47521',
} as const

const CROWD_SKINS = ['#ffe0cd', '#ecb891', '#c98e63', '#8f5b3a'] as const
const CROWD_HAIRS = ['#2a2340', '#5b3527', '#f7c95e', '#ff8fc7', '#5aaeff', '#9b6bff', '#e8424f', '#f0f0f5'] as const
const CROWD_CLOTHES = ['#e5484d', '#58a6ff', '#ffd166', '#3fb950', '#c878ff', '#ff8fb1', '#f0f0f0', '#f47521'] as const

/** Who sits on the dais, who stands on the sand, who rests on the sidelines. */
export function layoutArena(members: readonly Member[], columns: number): Layout | undefined {
  if (!Number.isFinite(columns) || columns < MIN_OFFICE_COLUMNS) return undefined
  const perRow = Math.max(2, Math.min(MAX_PER_ROW, Math.floor((columns - 2 * MARGIN) / SEAT_W)))
  const width = 2 * MARGIN + perRow * SEAT_W
  const live = members.filter(member => !member.isEnded)
  const done = members.filter(member => member.isEnded).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const byStart = (a: Member, b: Member): number => a.startedAt - b.startedAt
  const fighters = live.filter(member => member.role === 'gladiator').sort((a, b) => (a.variant ?? 0) - (b.variant ?? 0) || byStart(a, b))
  const bench = [
    ...live.filter(member => member.role === 'lead'),
    ...live.filter(member => member.role === 'judge').sort(byStart),
    ...live.filter(member => member.role !== 'lead' && member.role !== 'judge' && member.role !== 'gladiator').sort(byStart),
  ]
  const benchRows = Math.max(1, Math.ceil(bench.length / perRow))
  const seats: Seat[] = Array.from({ length: benchRows * perRow }, (_, index) => ({
    index,
    x: MARGIN + (index % perRow) * SEAT_W,
    y: ARENA_WALL_H + Math.floor(index / perRow) * SEAT_H,
  }))
  bench.forEach((member, i) => {
    const seat = seats[i]
    if (seat !== undefined) seat.member = member
  })
  const sandY = ARENA_WALL_H + benchRows * SEAT_H + 2
  const perSandRow = Math.max(1, Math.floor((width - 2 * MARGIN) / PAIR_W))
  const pairs = Math.ceil(fighters.length / 2)
  const lead = Math.floor((width - 2 * MARGIN - perSandRow * PAIR_W) / 2)
  const stands: Stand[] = []
  for (let p = 0; p < pairs; p += 1) {
    const x = MARGIN + 1 + Math.max(0, lead) + (p % perSandRow) * PAIR_W
    const y = sandY + 3 + Math.floor(p / perSandRow) * SAND_ROW_H
    const first = fighters[2 * p]
    const second = fighters[2 * p + 1]
    if (first !== undefined) stands.push({ x, y, member: first, side: second === undefined ? 'solo' : 'left', pair: p })
    if (second !== undefined) stands.push({ x: x + PAIR_GAP, y, member: second, side: 'right', pair: p })
  }
  const sandRows = Math.max(1, Math.ceil(pairs / perSandRow))
  const loungeY = sandY + sandRows * SAND_ROW_H + 3
  const capacity = Math.max(1, Math.floor((width - 2 * MARGIN - 12) / SPOT_W))
  const spots = done.slice(0, capacity).map((member, i) => ({ member, x: MARGIN + 1 + i * SPOT_W, y: loungeY + 3 }))
  const height = loungeY + (done.length > 0 ? LOUNGE_H : 0) + 2
  return { width, height: height + (height % 2), perRow, seats, spots, extraDone: done.length - spots.length, loungeY, arena: true, stands, sandY }
}

/** The room under the people, in room pixels: the dais, the sand with its ring, and the sidelines with a weapon rack. */
function paintArenaBase(canvas: Canvas, layout: Layout): void {
  const sandY = layout.sandY ?? ARENA_WALL_H
  const { width } = canvas
  fillRect(canvas, 0, 0, width, ARENA_WALL_H, ARENA_COLOR.crowdBack)
  fillRect(canvas, 0, ARENA_WALL_H, width, sandY - ARENA_WALL_H, ARENA_COLOR.stone3)
  for (let y = ARENA_WALL_H + 2; y < sandY; y += 5) fillRect(canvas, 0, y, width, 1, ARENA_COLOR.stone2)
  fillRect(canvas, 0, sandY - 2, width, 2, ARENA_COLOR.stone2)
  fillRect(canvas, 0, sandY, width, layout.height - sandY, ARENA_COLOR.sand)
  for (let y = sandY + 2; y < layout.height; y += 4) {
    for (let x = (y * 7) % 11; x < width; x += 11) fillRect(canvas, x, y, 3, 1, ARENA_COLOR.sand2)
  }
  // The ring: a dotted ellipse round the fighting ground.
  const cy = (sandY + layout.loungeY) / 2
  const ry = (layout.loungeY - sandY) / 2 - 2
  for (let x = 6; x < width - 6; x += 2) {
    const t = (x - width / 2) / (width / 2 - 6)
    const dy = ry * Math.sqrt(Math.max(0, 1 - t * t))
    setPixel(canvas, x, Math.round(cy - dy), ARENA_COLOR.sand3)
    setPixel(canvas, x, Math.round(cy + dy), ARENA_COLOR.sand3)
  }
  if (layout.spots.length === 0) return
  const y = layout.loungeY
  fillRect(canvas, 0, y, width, layout.height - y, ARENA_COLOR.sand2)
  fillRect(canvas, 0, y, width, 2, ARENA_COLOR.fence)
  fillRect(canvas, 0, y + 2, width, 1, ARENA_COLOR.fenceShade)
  for (let x = 2; x < width; x += 6) fillRect(canvas, x, y + 2, 1, 3, ARENA_COLOR.fence)
  // The weapon rack, on the right.
  const rx = width - MARGIN - 9
  fillRect(canvas, rx, y + 7, 9, 1, ARENA_COLOR.rack)
  fillRect(canvas, rx, y + 13, 9, 1, ARENA_COLOR.rack)
  for (let i = 0; i < 4; i += 1) {
    fillRect(canvas, rx + 1 + i * 2, y + 4 + (i % 2), 1, 11 - (i % 2), WOOD)
    fillRect(canvas, rx + 1 + i * 2, y + 3 + (i % 2), 1, 1, STEEL)
  }
}

/** The stands, the wall and its gate, the banner and the torches, at person pixels. `wave` 1 lifts the other half of the crowd's arms. */
function paintBackdrop(canvas: Canvas, widthRoom: number, wave: number): void {
  const width = widthRoom * DETAIL
  fillRect(canvas, 0, 0, width, 18, ARENA_COLOR.crowdBack)
  let index = 0
  for (const [ry, offset] of [[2, 0], [9, 3]] as const) {
    for (let cx = offset + 1; cx < width - 5; cx += 7) {
      const h = Math.imul(index + 1, 2654435761) >>> 0
      const skin = CROWD_SKINS[h % CROWD_SKINS.length] ?? '#ecb891'
      const hair = CROWD_HAIRS[(h >>> 4) % CROWD_HAIRS.length] ?? '#2a2340'
      const clothes = CROWD_CLOTHES[(h >>> 8) % CROWD_CLOTHES.length] ?? '#e5484d'
      fillRect(canvas, cx, ry + 4, 5, 5, clothes)
      fillRect(canvas, cx + 1, ry + 1, 3, 3, skin)
      fillRect(canvas, cx + 1, ry, 3, 2, hair)
      if (index % 2 === 0 || wave === 1) {
        fillRect(canvas, cx - 1, ry + 1, 1, 4, skin)
        fillRect(canvas, cx + 5, ry + 1, 1, 4, skin)
      }
      index += 1
    }
  }
  fillRect(canvas, 0, 16, width, 4, ARENA_COLOR.parapet)
  fillRect(canvas, 0, 19, width, 1, ARENA_COLOR.stone2)
  fillRect(canvas, 0, 20, width, 16, ARENA_COLOR.stone)
  for (let y = 20; y < 36; y += 6) {
    fillRect(canvas, 0, y, width, 1, ARENA_COLOR.stone2)
    for (let x = ((y - 20) / 6) % 2 === 0 ? 8 : 0; x < width; x += 16) fillRect(canvas, x, y, 1, 6, ARENA_COLOR.stone2)
  }
  for (let ax = 4; ax + 20 < width - 4; ax += 26) {
    fillRect(canvas, ax, 24, 20, 12, ARENA_COLOR.arch)
    fillRect(canvas, ax + 2, 22, 16, 2, ARENA_COLOR.arch)
    fillRect(canvas, ax + 4, 21, 12, 1, ARENA_COLOR.arch)
    for (let gx = ax + 3; gx < ax + 18; gx += 4) fillRect(canvas, gx, 25, 1, 11, ARENA_COLOR.bars)
  }
  if (widthRoom >= 58) {
    const bx = Math.floor(width / 2) - 22
    fillRect(canvas, bx, 2, 44, 24, ARENA_COLOR.banner)
    fillRect(canvas, bx, 2, 44, 2, ARENA_COLOR.gold)
    fillRect(canvas, bx, 24, 44, 2, ARENA_COLOR.gold)
    fillRect(canvas, bx + 2, 26, 2, 4, ARENA_COLOR.banner)
    fillRect(canvas, bx + 40, 26, 2, 4, ARENA_COLOR.banner)
    ;[...'GAUNTLET'].forEach((letter, i) => {
      ;(GLYPHS[letter] ?? []).forEach((row, dy) => {
        ;[...row].forEach((cell, dx) => {
          if (cell === '#') setPixel(canvas, bx + 7 + i * 4 + dx, 11 + dy, ARENA_COLOR.goldText)
        })
      })
    })
  }
  for (const tx of [3, width - 5]) {
    fillRect(canvas, tx, 24, 2, 11, '#6e4628')
    fillRect(canvas, tx - 1, 22, 4, 2, '#3c281e')
    fillRect(canvas, tx, 17 + wave, 2, 5 - wave, ARENA_COLOR.flame)
    fillRect(canvas, tx, 19 + wave, 2, 3 - wave, ARENA_COLOR.flameHot)
  }
}

/** The token board, on the wall at the right: a whiteboard with a bar per route kind. `scale` 1 is room pixels, DETAIL person pixels. */
function paintBoard(canvas: Canvas, boardX: number, spend: KindSpend, scale: number): void {
  const r = (x: number, y: number, w: number, h: number, color: string): void =>
    fillRect(canvas, (boardX + x) * scale, (1 + y) * scale, w * scale, h * scale, color)
  r(0, 0, 16, 7, COLOR.boardFrame)
  r(1, 1, 14, 5, COLOR.boardFace)
  const most = Math.max(0, ...KINDS.map(kind => spend[kind] ?? 0))
  KINDS.forEach((kind, k) => {
    const value = spend[kind] ?? 0
    const height = most > 0 && value > 0 ? Math.max(1, Math.round((4 * value) / most)) : 0
    r(2 + k * 3, 5 - height, 2, height, KIND_COLORS[kind])
  })
  r(12, 1, 2, 2, COLOR.sticky)
  r(12, 1, 1, 1, COLOR.stickyEdge)
}

/** A judge's bench at the seat at room pixel `x, y` on a canvas at DETAIL: a wooden front with a gold rim. No monitor. */
function paintBench(canvas: Canvas, x: number, y: number): void {
  const px = x * DETAIL
  const py = y * DETAIL
  fillRect(canvas, px + 2, py + 22, 32, 1, ARENA_COLOR.benchEdge)
  fillRect(canvas, px + 2, py + 23, 32, 4, ARENA_COLOR.benchTop)
  fillRect(canvas, px + 2, py + 27, 32, 1, ARENA_COLOR.benchTrim)
  fillRect(canvas, px + 2, py + 28, 32, 4, ARENA_COLOR.benchFront)
  fillRect(canvas, px + 4, py + 31, 28, 1, ARENA_COLOR.benchShade)
}

/** What a judge does while at work: bang a gavel, write with a quill, or lift a scorecard. Loops every four frames. */
const JUDGE_FX = ['gavel', 'quill', 'card', 'quill', 'card', 'gavel', 'gavel', 'card'] as const

function paintJudgeFx(canvas: Canvas, x: number, y: number, member: Member, frame: number): void {
  if (member.role !== 'judge' || !FIGHTING.has(member.activity)) return
  const kind = JUDGE_FX[(member.variant ?? 0) % ARENA_SIZE]
  const ox = x * DETAIL + 2
  const oy = y * DETAIL + 2
  const f = frame % 4
  const box = (dx: number, dy: number, w: number, h: number, color: string): void => fillRect(canvas, ox + dx, oy + dy, w, h, color)
  if (kind === 'gavel') {
    const hy = [8, 13, 18, 13][f] ?? 8
    box(19, hy + 4, 2, Math.max(1, 20 - hy - 4), WOOD)
    box(16, hy, 8, 4, GOLD)
    box(16, hy, 8, 1, '#ffe08c')
    box(16, hy + 3, 8, 1, '#a06e28')
    if (f === 2) for (const [dx, dy] of [[13, 19], [25, 19], [14, 17], [24, 17], [12, 18], [26, 18]] as const) box(dx, dy, 1, 1, ARENA_COLOR.white)
  }
  if (kind === 'quill') {
    const qx = [4, 7, 10, 13][f] ?? 4
    box(3, 16, 17, 4, '#f5ecd8')
    box(3, 16, 17, 1, '#c8beaa')
    box(5, 18, 3 + f * 3, 1, '#1e1e50')
    box(5, 17, 2 + f * 2, 1, '#3c3c78')
    for (let i = 0; i < 6; i += 1) {
      box(qx + i, 17 - i, 1, 1, '#5a3c28')
      box(qx + i, 16 - i, 1, 1, ARENA_COLOR.white)
      box(qx + i + 1, 17 - i, 1, 1, '#e6e6f5')
    }
    box(qx - 1, 18, 2, 1, '#1e1e50')
  }
  if (kind === 'card') {
    const top = [16, 12, 6, 12][f] ?? 16
    box(20, top, 9, 20 - top, '#faf7ee')
    box(20, top, 9, 1, '#c8c8d2')
    box(20, top, 1, 20 - top, '#c8c8d2')
    if (f === 2) box(24, top + 3, 3, 5, '#c81e28')
  }
}

/** The fight: ready, wind-up, the strike with a spark, the recoil. A fighter on the left lunges right; the right one mirrors it. */
const SPAR = [
  { dx: 0, dy: 0, arc: 0, spark: 0 },
  { dx: 2, dy: -1, arc: 1, spark: 0 },
  { dx: 4, dy: 0, arc: 2, spark: 1 },
  { dx: -1, dy: 0, arc: 0, spark: 2 },
] as const

/** Live and not waiting on the person or just settling in: at work, so they fight (a judge: so they write). */
const FIGHTING: ReadonlySet<Activity> = new Set(['typing', 'reading', 'terminal', 'browsing', 'helper', 'studying', 'calling', 'thinking', 'writing', 'working'])

const SLASH_SMALL = [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]] as const
const SLASH_BIG = [[0, 8], [1, 8], [2, 7], [3, 6], [4, 5], [5, 3], [6, 1], [7, 0], [1, 7], [2, 6], [3, 5], [4, 4], [5, 2]] as const

function paintSlash(canvas: Canvas, x: number, y: number, size: 1 | 2, isMirrored: boolean): void {
  for (const [dx, dy] of size === 1 ? SLASH_SMALL : SLASH_BIG) {
    const sx = isMirrored ? x - dx : x + dx
    const side = isMirrored ? -1 : 1
    fillRect(canvas, sx, y + dy, 1, 1, ARENA_COLOR.white)
    fillRect(canvas, sx + side, y + dy, 1, 1, ARENA_COLOR.glow)
    fillRect(canvas, sx, y + dy + 1, 1, 1, ARENA_COLOR.glow)
  }
}

function paintSpark(canvas: Canvas, x: number, y: number, isBig: boolean): void {
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const) fillRect(canvas, x + dx, y + dy, 1, 1, ARENA_COLOR.spark)
  if (isBig) {
    for (const [dx, dy] of [[-2, -2], [2, -2], [-2, 2], [2, 2], [-4, 0], [4, 0], [0, -4], [0, 4], [-3, 0], [3, 0], [0, -3], [0, 3]] as const) fillRect(canvas, x + dx, y + dy, 1, 1, ARENA_COLOR.white)
    for (const [dx, dy] of [[-5, -1], [5, -1], [-1, -5], [1, 5]] as const) fillRect(canvas, x + dx, y + dy, 1, 1, ARENA_COLOR.flame)
  }
  fillRect(canvas, x, y, 1, 1, ARENA_COLOR.white)
}

const isFighting = (member: Member): boolean => !member.isEnded && FIGHTING.has(member.activity)

/** One pair's frame at `frame`: each pair is a beat apart from the next. */
function sparFor(layout: Layout, pair: number, frame: number, motion: boolean): (typeof SPAR)[number] {
  const group = (layout.stands ?? []).filter(stand => stand.pair === pair)
  const fights = motion && group.some(stand => isFighting(stand.member))
  return SPAR[fights ? (frame + pair) % 4 : 0] ?? SPAR[0]
}

/** A fighter's shadow and body at person pixel `px, py`, in the pair's frame `f`; the right one of a pair is mirrored and lunges left. */
function paintFighter(canvas: Canvas, px: number, py: number, stand: Stand, f: (typeof SPAR)[number]): void {
  fillRect(canvas, px + 1, py + 27, 18, 2, ARENA_COLOR.sand3)
  fillRect(canvas, px + 3, py + 29, 14, 1, ARENA_COLOR.sand3)
  const mirrored = stand.side === 'right'
  paintFigurePx(canvas, px + (mirrored ? -f.dx : f.dx), py + f.dy, stand.member, 'stand', false, seatMood(stand.member.activity), mirrored)
}

/** The slashes and the spark of a pair, from the left fighter's origin `ox, oy` (person pixels); a lone fighter slashes the air. */
function paintPairFx(canvas: Canvas, ox: number, oy: number, hasPartner: boolean, f: (typeof SPAR)[number]): void {
  if (f.arc > 0) paintSlash(canvas, ox + 20 + f.dx, oy + (f.arc === 2 ? 6 : 2), f.arc === 2 ? 2 : 1, false)
  if (!hasPartner) return
  if (f.arc > 0) paintSlash(canvas, ox + PAIR_GAP * DETAIL - 1 - f.dx, oy + (f.arc === 2 ? 6 : 2), f.arc === 2 ? 2 : 1, true)
  if (f.spark === 1) paintSpark(canvas, ox + 27, oy + 12, true)
  if (f.spark === 2) paintSpark(canvas, ox + 27, oy + 12, false)
}

/** The fighters of every pair and the sparks between them, on a canvas at DETAIL. */
function paintStands(canvas: Canvas, layout: Layout, walking: ReadonlySet<string>, frame: number, motion: boolean): void {
  const stands = layout.stands ?? []
  for (const stand of stands) {
    if (walking.has(stand.member.id)) continue
    paintFighter(canvas, stand.x * DETAIL, stand.y * DETAIL, stand, sparFor(layout, stand.pair, frame, motion))
  }
  for (const stand of stands) {
    if (stand.side === 'right' || walking.has(stand.member.id)) continue
    const hasPartner = stands.some(other => other.pair === stand.pair && other.side === 'right')
    paintPairFx(canvas, stand.x * DETAIL, stand.y * DETAIL, hasPartner, sparFor(layout, stand.pair, frame, motion))
  }
}

// ---------------------------------------------------------------------------
// Motion: frames and walks
// ---------------------------------------------------------------------------

/** The animation frame at `now`; frame 0 forever when the motion is off. */
export function frameAt(now: number, motion: boolean): number {
  return motion ? Math.floor(Math.max(0, now) / FRAME_MS) : 0
}

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/** How far a walk has got, from 0 to 1. Without motion, or with no time to go on, it is over. */
export function walkProgress(since: number | undefined, now: number, motion: boolean): number {
  if (!motion || since === undefined || !Number.isFinite(since)) return 1
  if (now <= since) return 0
  return Math.min(1, (now - since) / WALK_MS)
}

type Point = { x: number; y: number }
const DOORWAY: Point = { x: DOOR_X, y: 0 }
const seatSpot = (seat: Pick<Seat, 'x' | 'y'>): Point => ({ x: seat.x + 1, y: seat.y + 1 })

/** Where desk `index` stands, even past the rows drawn now (a desk just left). */
function deskAt(layout: Layout, index: number): Pick<Seat, 'x' | 'y'> {
  const row = Math.floor(Math.max(0, index) / layout.perRow)
  return {
    x: MARGIN + (Math.max(0, index) % layout.perRow) * SEAT_W,
    y: Math.min(WALL_H + FLOOR_PAD + row * SEAT_H, layout.loungeY - SEAT_H),
  }
}
const lerp = (from: Point, to: Point, t: number): Point => ({
  x: Math.round(from.x + (to.x - from.x) * ease(t)),
  y: Math.round(from.y + (to.y - from.y) * ease(t)),
})

/** Who is on the move at `now`, where from, where to, and how far. */
type Walk = { member: Member; from: Point; to: Point; progress: number; isLeaving: boolean }

function walksOf(layout: Layout, now: number, motion: boolean): Walk[] {
  const walks: Walk[] = []
  const gate = layout.arena === true ? ARENA_GATE : DOORWAY
  for (const seat of layout.seats) {
    const member = seat.member
    if (member === undefined || member.role === 'lead') continue
    const progress = walkProgress(member.startedAt, now, motion)
    if (progress < 1) walks.push({ member, from: gate, to: seatSpot(seat), progress, isLeaving: false })
  }
  for (const stand of layout.stands ?? []) {
    const progress = walkProgress(stand.member.startedAt, now, motion)
    if (progress < 1) walks.push({ member: stand.member, from: gate, to: { x: stand.x, y: stand.y }, progress, isLeaving: false })
  }
  for (const spot of layout.spots) {
    const progress = walkProgress(spot.member.endedAt, now, motion)
    if (progress < 1) {
      // A finished fighter walks off the sand; anyone else walks from their desk or bench.
      const from =
        layout.arena === true ? { x: Math.floor(layout.width / 2) - 5, y: (layout.sandY ?? 0) + 3 } : seatSpot(deskAt(layout, spot.member.seat))
      walks.push({ member: spot.member, from, to: { x: spot.x, y: spot.y }, progress, isLeaving: true })
    }
  }
  return walks
}

// ---------------------------------------------------------------------------
// Tags and marks
// ---------------------------------------------------------------------------

type Tag = { x: number; y: number; width: number; text: string; fg: string; bg: string }
/** A mark by a head, in person pixels: 8 wide, 6 tall, one slot for every state. */
type Bubble = { x: number; y: number; text: string; fg: string; bg: string; isBlinking: boolean }
const BUBBLE_W = 8
const BUBBLE_H = 6

const fit = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

/** A tag's text clipped to `max`, keeping a short last word ("A", "r1m2"): "Gladia… A", not "Gladiato…". */
export function fitTag(text: string, max: number): string {
  if (text.length <= max) return text
  const tail = /\s\S{1,4}$/.exec(text)?.[0]
  if (tail !== undefined && max > tail.length + 3) return `${text.slice(0, max - tail.length - 1)}…${tail}`
  return fit(text, max)
}

/** The SVG tags' font size and, with it, one monospace character's width (0.6 of the size), in room pixels. */
const TAG_FONT = 2
const TAG_CHAR_W = 1.2

function tagOf(member: Member, x: number, y: number, width: number): Tag {
  const text = member.tag ?? member.label
  if (member.isEnded) return { x, y, width, text, fg: COLOR.tagDoneText, bg: COLOR.tagDone }
  if (member.activity === 'waiting-you') return { x, y, width, text, fg: COLOR.tagAlertText, bg: COLOR.tagAlert }
  if (member.role === 'lead') return { x, y, width, text, fg: COLOR.tagLeadText, bg: COLOR.tagLead }
  return { x, y, width, text, fg: COLOR.tagText, bg: COLOR.tag }
}

/** `…` thinks, `!` needs you (red, blinking), `z` is on a break, `+` is done, `x` is stuck. */
function bubbleOf(member: Member, x: number, y: number): Bubble | undefined {
  switch (member.activity) {
    case 'thinking':
      return { x, y, text: '…', fg: '#1b1f27', bg: COLOR.bubble, isBlinking: false }
    case 'helper':
    case 'studying':
      return { x, y, text: '…', fg: '#9a6700', bg: COLOR.bubble, isBlinking: false }
    case 'waiting-you':
      return { x, y, text: '!', fg: '#ffffff', bg: COLOR.alert, isBlinking: true }
    case 'idle':
      return { x, y, text: 'z', fg: '#3a4252', bg: COLOR.bubbleIdle, isBlinking: false }
    case 'done':
      return { x, y, text: '+', fg: '#2a2340', bg: COLOR.sparkle, isBlinking: false }
    case 'failed':
      return { x, y, text: 'x', fg: '#ffffff', bg: COLOR.alert, isBlinking: false }
    default:
      return undefined
  }
}

/** A mark's shape on a canvas at DETAIL: a rounded box with a dark rim. */
function paintBubble(canvas: Canvas, bubble: Bubble, isDark: boolean): void {
  const { x, y } = bubble
  fillRect(canvas, x + 1, y, BUBBLE_W - 2, 1, COLOR.bubbleRim)
  fillRect(canvas, x + 1, y + BUBBLE_H - 1, BUBBLE_W - 2, 1, COLOR.bubbleRim)
  fillRect(canvas, x, y + 1, 1, BUBBLE_H - 2, COLOR.bubbleRim)
  fillRect(canvas, x + BUBBLE_W - 1, y + 1, 1, BUBBLE_H - 2, COLOR.bubbleRim)
  fillRect(canvas, x + 1, y + 1, BUBBLE_W - 2, BUBBLE_H - 2, isDark ? COLOR.alertDark : bubble.bg)
}

/** A member's name tag and mark, where it sits or stands. */
type Marks = { tag: Tag; bubble?: Bubble }

function seatMarks(member: Member, seat: Pick<Seat, 'x' | 'y'>): Marks {
  return { tag: tagOf(member, seat.x + 1, seat.y + 16, SEAT_W - 2), bubble: bubbleOf(member, seat.x * DETAIL + 22, seat.y * DETAIL) }
}

function spotMarks(member: Member, spot: Pick<Spot, 'x' | 'y'>): Marks {
  return { tag: tagOf(member, spot.x - 1, spot.y + 14, SPOT_W - 1), bubble: bubbleOf(member, spot.x * DETAIL + 16, spot.y * DETAIL - 4) }
}

/** A fighter on the sand: the tag under it, the mark beside its head (on the outer side for the right one of a pair). */
function standMarks(member: Member, stand: Stand): Marks {
  const outer = stand.side === 'right' ? -6 : 16
  return { tag: tagOf(member, stand.x - 2, stand.y + 14, 14), bubble: bubbleOf(member, stand.x * DETAIL + outer, stand.y * DETAIL - 4) }
}

/** Every tag and mark of the people in place (not those walking). */
function marksOf(layout: Layout, walking: ReadonlySet<string>): { tags: Tag[]; bubbles: Bubble[] } {
  const all: Marks[] = []
  for (const seat of layout.seats) {
    if (seat.member !== undefined && !walking.has(seat.member.id)) all.push(seatMarks(seat.member, seat))
  }
  for (const stand of layout.stands ?? []) {
    if (!walking.has(stand.member.id)) all.push(standMarks(stand.member, stand))
  }
  for (const spot of layout.spots) {
    if (!walking.has(spot.member.id)) all.push(spotMarks(spot.member, spot))
  }
  return {
    tags: all.map(marks => marks.tag),
    bubbles: all.flatMap(marks => (marks.bubble === undefined ? [] : [marks.bubble])),
  }
}

/** Where the "+3 more" count of a full lounge goes: just past the last figure. */
const moreAt = (layout: Layout): Point => ({ x: MARGIN + 1 + layout.spots.length * SPOT_W + 1, y: layout.loungeY + 10 })

// ---------------------------------------------------------------------------
// Terminal: Raster cells
// ---------------------------------------------------------------------------

/** The office as Raster cells at `now`; undefined when the room does not fit. */
export function officeRaster(members: readonly Member[], spend: KindSpend, options: OfficeOptions): RasterFrame | undefined {
  // Terminal columns are person pixels; the room is laid out in room pixels, DETAIL to a column.
  const columns = Math.floor(options.columns / DETAIL)
  const layout = options.arena === true ? layoutArena(members, columns) : layoutOffice(members, columns)
  if (layout === undefined) return undefined
  const isArena = layout.arena === true
  const frame = frameAt(options.now, options.motion)
  const ground = isArena ? ARENA_COLOR.sand : COLOR.carpet
  const base = createCanvas(layout.width, layout.height, ground)
  paintRoom(base, layout, spend, frame, options.motion)
  const walks = options.walks === false ? [] : walksOf(layout, options.now, options.motion)
  const walking = new Set(walks.map(walk => walk.member.id))
  const canvas = upscale(base, DETAIL)
  if (isArena) {
    paintBackdrop(canvas, layout.width, options.motion ? (frame >> 1) & 1 : 0)
    paintBoard(canvas, layout.width - 19, spend, DETAIL)
    for (const seat of layout.seats) paintBench(canvas, seat.x, seat.y)
    for (const seat of layout.seats) {
      if (seat.member === undefined || walking.has(seat.member.id)) continue
      paintSeated(canvas, seat.x, seat.y, seat.member, frame)
      paintJudgeFx(canvas, seat.x, seat.y, seat.member, frame)
    }
    paintStands(canvas, layout, walking, frame, options.motion)
  } else {
    for (const seat of layout.seats) paintDesk(canvas, seat.x, seat.y)
    for (const seat of layout.seats) {
      if (seat.member === undefined || walking.has(seat.member.id)) continue
      paintSeated(canvas, seat.x, seat.y, seat.member, frame)
      paintDeskLive(canvas, seat.x, seat.y, seat.member, frame)
    }
  }
  for (const spot of layout.spots) {
    const activity = spot.member.activity
    // On the sidelines the finished sway: one pixel down on every other beat.
    const sway = isArena && options.motion ? (frame >> 1) & 1 : 0
    if (!walking.has(spot.member.id)) paintFigurePx(canvas, spot.x * DETAIL, spot.y * DETAIL + sway, spot.member, 'stand', isFaded(activity), figureMood(activity))
  }
  for (const walk of walks) {
    const at = lerp(walk.from, walk.to, walk.progress)
    const activity = walk.member.activity
    const pose = frame % 2 === 0 ? 'step-a' : 'step-b'
    paintFigure(canvas, at.x, at.y, walk.member, pose, walk.isLeaving && isFaded(activity), walk.isLeaving ? figureMood(activity) : 'normal')
  }
  const row = (y: number): number => Math.floor((y * DETAIL) / 2)
  const overlays: Overlay[] = []
  const { tags, bubbles } = marksOf(layout, walking)
  if (options.labels) {
    for (const tag of tags) {
      // The tag is as wide in columns as its room pixels twice over: clip to what fits, with a column to spare each side.
      const text = fitTag(tag.text, tag.width * DETAIL - 2)
      const col = tag.x * DETAIL + Math.max(0, Math.floor((tag.width * DETAIL - text.length) / 2))
      overlays.push({ col, row: row(tag.y), text, fg: tag.fg, bg: tag.bg })
    }
  }
  for (const bubble of bubbles) {
    const isDark = bubble.isBlinking && frame % 2 === 1
    paintBubble(canvas, bubble, isDark)
    // The glyph is one text cell in the middle of the mark: two pixel rows tall, on the mark's own fill.
    overlays.push({
      col: bubble.x + 3,
      row: Math.floor((bubble.y + 2) / 2),
      text: bubble.text,
      fg: bubble.fg,
      bg: isDark ? COLOR.alertDark : bubble.bg,
    })
  }
  if (layout.extraDone > 0) {
    const at = moreAt(layout)
    overlays.push({ col: at.x * DETAIL, row: row(at.y), text: `+${layout.extraDone}`, fg: COLOR.moreText })
  }
  return toCells(canvas, overlays, ground)
}

// ---------------------------------------------------------------------------
// Remote surfaces: SVG with SMIL motion
// ---------------------------------------------------------------------------

const seconds = (ms: number): string => `${Math.max(0, ms / 1000).toFixed(2)}s`
const FLIP_DUR = seconds(FRAME_MS * 2)

/** Night life: stars that twinkle in the window, and a soft pulse on the neon sign. Loops, so a redraw restarts nothing. */
function ambientSvg(width: number): string {
  const plan = wallPlan(width)
  const parts: string[] = []
  if (plan.window !== undefined && plan.window.w >= 10) {
    const { x, w } = plan.window
    ;[
      { at: x + 3, y: 2, seconds: 3.1, offset: 0 },
      { at: x + Math.floor(w / 2) + 2, y: 3, seconds: 4.3, offset: 1.2 },
      { at: x + w - 8, y: 2, seconds: 3.7, offset: 2.4 },
    ].forEach(star => {
      parts.push(
        `<rect x="${star.at}" y="${star.y}" width="1" height="1" fill="${COLOR.skylineLit}">` +
          `<animate attributeName="opacity" values="1;0.1;1" dur="${star.seconds}s" begin="-${star.offset}s" repeatCount="indefinite"/></rect>`,
      )
    })
  }
  if (plan.sign !== undefined) {
    parts.push(
      `<rect x="${plan.sign.x}" y="1" width="${SIGN_PLATE_W}" height="7" fill="${COLOR.neonText}" opacity="0">` +
        `<animate attributeName="opacity" values="0;0.16;0" dur="3.2s" repeatCount="indefinite"/></rect>`,
    )
  }
  return parts.join('')
}

/** Two frames that take turns, so a loop runs with no script. */
function flipFrames(frameA: string, frameB: string): string {
  if (frameA === frameB) return frameA
  return (
    `<g>${frameA}<animate attributeName="opacity" values="1;0" dur="${FLIP_DUR}" calcMode="discrete" repeatCount="indefinite"/></g>` +
    `<g opacity="0">${frameB}<animate attributeName="opacity" values="0;1" dur="${FLIP_DUR}" calcMode="discrete" repeatCount="indefinite"/></g>`
  )
}

/** Frames that take turns, `step` ms each, round and round: a loop of any length, with no script. */
function loopFrames(frames: readonly string[], step = FRAME_MS): string {
  const first = frames[0]
  if (first === undefined) return ''
  if (frames.every(frame => frame === first)) return first
  const dur = seconds(step * frames.length)
  return frames
    .map((frame, i) => {
      const values = frames.map((_, k) => (k === i ? '1' : '0')).join(';')
      return `<g opacity="${i === 0 ? 1 : 0}">${frame}<animate attributeName="opacity" values="${values}" dur="${dur}" calcMode="discrete" repeatCount="indefinite"/></g>`
    })
    .join('')
}

/**
 * A person canvas (person pixels) as markup in room pixels: vector paths, or, when the team is too
 * big for paths to fit the size cap, one small PNG image.
 */
function personMarkup(canvas: Canvas, asImage: boolean): string {
  if (!asImage) return `<g transform="scale(${1 / DETAIL})">${svgPaths(canvas)}</g>`
  return (
    `<image width="${canvas.width / DETAIL}" height="${canvas.height / DETAIL}" style="image-rendering:pixelated" ` +
    `href="data:image/png;base64,${pngBase64(canvas)}"/>`
  )
}

/** A person at a desk, in the seat's own room pixels: the person and the desk top's props, then the screen and hands, which move. */
function seatedSvg(member: Member, motion: boolean, asImage = false): string {
  const live = (frame: number): string => {
    const canvas = createCanvas(SEAT_W * DETAIL, SEAT_H * DETAIL)
    paintDeskLive(canvas, 0, 0, member, frame)
    return personMarkup(canvas, asImage)
  }
  const person = createCanvas(SEAT_W * DETAIL, SEAT_H * DETAIL)
  paintSeated(person, 0, 0, member, 0)
  return `${personMarkup(person, asImage)}${motion ? flipFrames(live(0), live(1)) : live(0)}`
}

/** Every desk of the room, drawn once: one layer at DETAIL, as paths or a single PNG. */
function desksSvg(layout: Layout, asImage: boolean): string {
  const canvas = createCanvas(layout.width * DETAIL, layout.height * DETAIL)
  for (const seat of layout.seats) paintDesk(canvas, seat.x, seat.y)
  return personMarkup(canvas, asImage)
}

/** The stands, wall and banner, two frames of the crowd's wave. */
function backdropSvg(layout: Layout, spend: KindSpend, motion: boolean, asImage: boolean): string {
  const frame = (wave: number): string => {
    const canvas = createCanvas(layout.width * DETAIL, 36)
    paintBackdrop(canvas, layout.width, wave)
    paintBoard(canvas, layout.width - 19, spend, DETAIL)
    return personMarkup(canvas, asImage)
  }
  return motion ? loopFrames([frame(0), frame(1)], FRAME_MS * 2) : frame(0)
}

/** Every bench of the dais, drawn once. */
function benchesSvg(layout: Layout, asImage: boolean): string {
  const canvas = createCanvas(layout.width * DETAIL, layout.height * DETAIL)
  for (const seat of layout.seats) paintBench(canvas, seat.x, seat.y)
  return personMarkup(canvas, asImage)
}

/** A person on the dais: the person with their props, and, at work, a judge's gavel, quill or scorecard on a four-frame loop. */
function benchedSvg(member: Member, motion: boolean, asImage: boolean): string {
  const person = createCanvas(SEAT_W * DETAIL, SEAT_H * DETAIL)
  paintSeated(person, 0, 0, member, 0)
  const fx = (frame: number): string => {
    const canvas = createCanvas(SEAT_W * DETAIL, SEAT_H * DETAIL)
    paintJudgeFx(canvas, 0, 0, member, frame)
    return personMarkup(canvas, asImage)
  }
  const isAnimated = motion && member.role === 'judge' && FIGHTING.has(member.activity)
  return `${personMarkup(person, asImage)}${isAnimated ? loopFrames([0, 1, 2, 3].map(fx)) : ''}`
}

/** A fighter on the four-frame spar loop (a beat behind the pair before it), or still when it is not at work. */
function fighterSvg(layout: Layout, stand: Stand, motion: boolean, asImage: boolean): string {
  const frame = (k: number): string => {
    const canvas = createCanvas(34, 34)
    paintFighter(canvas, 4, 2, stand, sparFor(layout, stand.pair, k, true))
    return personMarkup(canvas, asImage)
  }
  const fights = motion && isFighting(stand.member)
  const still = (): string => {
    const canvas = createCanvas(34, 34)
    paintFighter(canvas, 4, 2, stand, sparFor(layout, stand.pair, 0, false))
    return personMarkup(canvas, asImage)
  }
  return fights ? loopFrames([0, 1, 2, 3].map(frame)) : still()
}

/** The slashes and the spark between a pair, on the same loop. Empty (no markup) when nobody in the pair is at work. */
function pairFxSvg(layout: Layout, stand: Stand, motion: boolean, asImage: boolean): string {
  const group = (layout.stands ?? []).filter(other => other.pair === stand.pair)
  if (!motion || !group.some(other => isFighting(other.member))) return ''
  const hasPartner = group.some(other => other.side === 'right')
  const frame = (k: number): string => {
    const canvas = createCanvas(2 * (PAIR_GAP + 14), 34)
    paintPairFx(canvas, 0, 2, hasPartner, sparFor(layout, stand.pair, k, true))
    return personMarkup(canvas, asImage)
  }
  return loopFrames([0, 1, 2, 3].map(frame))
}

function figureSvg(member: Member, pose: 'stand' | 'walk', isDim: boolean, mood: Mood, asImage = false, sway = false): string {
  if (pose === 'stand' && sway) {
    const draw = (dy: number): string => {
      const canvas = createCanvas(SPRITE_W, SPRITE_H + 1)
      paintFigurePx(canvas, 0, dy, member, 'stand', isDim, mood)
      return personMarkup(canvas, asImage)
    }
    return loopFrames([draw(0), draw(1)], FRAME_MS * 2)
  }
  const draw = (which: Pose): string => {
    const canvas = createCanvas(SPRITE_W, SPRITE_H)
    paintFigure(canvas, 0, 0, member, which, isDim, mood)
    return personMarkup(canvas, asImage)
  }
  return pose === 'stand' ? draw('stand') : flipFrames(draw('step-a'), draw('step-b'))
}

/** The most characters a tag's chip can hold at the tags' font size. */
export const tagChars = (width: number): number => Math.max(3, Math.floor((width - 1) / TAG_CHAR_W))

function tagSvg(tag: Tag): string {
  const height = 2.4
  // The text is clipped to what the chip holds, and `textLength` squeezes it in when the font is wider than a monospace guess.
  const text = fitTag(tag.text, tagChars(tag.width))
  const width = Math.min(tag.width, text.length * TAG_CHAR_W + 1.6)
  const x = tag.x + (tag.width - width) / 2
  const length = Math.min(text.length * TAG_CHAR_W, width - 1)
  return (
    `<rect x="${x.toFixed(2)}" y="${tag.y - 0.2}" width="${width.toFixed(2)}" height="${height}" rx="0.6" fill="${tag.bg}"/>` +
    `<text x="${(x + width / 2).toFixed(2)}" y="${(tag.y + 1.65).toFixed(2)}" fill="${tag.fg}" font-size="${TAG_FONT}" ` +
    `font-family="Menlo,ui-monospace,monospace" font-weight="700" text-anchor="middle" textLength="${length.toFixed(2)}" ` +
    `lengthAdjust="spacingAndGlyphs">${escapeXml(text)}</text>`
  )
}

function bubbleSvg(bubble: Bubble, motion: boolean): string {
  const x = bubble.x / DETAIL
  const y = bubble.y / DETAIL
  const blink =
    motion && bubble.isBlinking
      ? `<animate attributeName="opacity" values="1;0.25" dur="${FLIP_DUR}" calcMode="discrete" repeatCount="indefinite"/>`
      : ''
  const glyph =
    bubble.text === '…'
      ? [0, 1, 2]
          .map(i => {
            const dot = `<rect x="${(x + 0.75 + i).toFixed(2)}" y="${(y + 1.2).toFixed(2)}" width="0.6" height="0.6" fill="${bubble.fg}">`
            return motion
              ? `${dot}<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;${(0.2 + i * 0.2).toFixed(1)};0.9;1" dur="1.2s" repeatCount="indefinite"/></rect>`
              : `${dot}</rect>`
          })
          .join('')
      : `<text x="${x + 2}" y="${(y + 2.15).toFixed(2)}" fill="${bubble.fg}" font-size="2.4" font-family="Menlo,ui-monospace,monospace" ` +
        `font-weight="700" text-anchor="middle">${escapeXml(bubble.text)}</text>`
  return (
    `<g><rect x="${x}" y="${y}" width="${BUBBLE_W / DETAIL}" height="${BUBBLE_H / DETAIL}" rx="0.9" fill="${COLOR.bubbleRim}"/>` +
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${BUBBLE_W / DETAIL - 1}" height="${BUBBLE_H / DETAIL - 1}" rx="0.6" fill="${bubble.bg}"/>${glyph}${blink}</g>`
  )
}

/** A walk as SMIL: the walker crosses from `from` to `to`, then the person in place appears. */
function walkSvg(walk: Walk, settled: string): string {
  const elapsed = walk.progress * WALK_MS
  const left = WALK_MS - elapsed
  const move =
    `<animateTransform attributeName="transform" type="translate" from="${walk.from.x} ${walk.from.y}" ` +
    `to="${walk.to.x} ${walk.to.y}" dur="${seconds(WALK_MS)}" begin="-${seconds(elapsed)}" fill="freeze" calcMode="spline" ` +
    `keyTimes="0;1" keySplines="0.45 0 0.55 1"/>`
  const hide = `<set attributeName="visibility" to="hidden" begin="${seconds(left)}" fill="freeze"/>`
  const show = `<set attributeName="visibility" to="visible" begin="${seconds(left)}" fill="freeze"/>`
  const activity = walk.member.activity
  const fig = figureSvg(walk.member, 'walk', walk.isLeaving && isFaded(activity), walk.isLeaving ? figureMood(activity) : 'normal')
  return (
    `<g transform="translate(${walk.from.x} ${walk.from.y})">${fig}${move}${hide}</g>` +
    `<g visibility="hidden">${settled}${show}</g>`
  )
}

/**
 * The office as an SVG document (at most `SVG_LIMIT` characters): the room as one layer, each
 * person a group with a hover tooltip, frames that take turns for typing, bubbles, name tags, and
 * walks from the door and to the lounge. Undefined when it would not fit.
 */
export function officeSvg(members: readonly Member[], spend: KindSpend, options: OfficeOptions): string | undefined {
  const layout = options.arena === true ? layoutArena(members, options.columns) : layoutOffice(members, options.columns)
  if (layout === undefined) return undefined
  const isArena = layout.arena === true
  const build = (motion: boolean, labels: boolean, asImage = false): string => {
    const room = createCanvas(layout.width, layout.height, isArena ? ARENA_COLOR.sand : COLOR.carpet)
    paintRoom(room, layout, spend, 0, false)
    const walks = options.walks === false ? [] : walksOf(layout, options.now, motion)
    const walkFor = new Map(walks.map(walk => [walk.member.id, walk]))
    const marksSvg = (marks: Marks): string =>
      `${labels ? tagSvg(marks.tag) : ''}${marks.bubble === undefined ? '' : bubbleSvg(marks.bubble, motion)}`
    const person = (member: Member, sprite: string, marks: Marks): string => {
      const settled = `${sprite}${marksSvg(marks)}`
      const walk = walkFor.get(member.id)
      return `<g><title>${escapeXml(member.tooltip)}</title>${walk === undefined ? settled : walkSvg(walk, settled)}</g>`
    }
    const people: string[] = []
    for (const seat of layout.seats) {
      const member = seat.member
      if (member === undefined) continue
      const inner = isArena ? benchedSvg(member, motion, asImage) : seatedSvg(member, motion, asImage)
      const sprite = `<g transform="translate(${seat.x} ${seat.y})">${inner}</g>`
      people.push(person(member, sprite, seatMarks(member, seat)))
    }
    for (const stand of layout.stands ?? []) {
      // A fighter sits in a 34 by 34 person-pixel frame that starts 2 room pixels left of it and 1 above.
      const sprite =
        `<g transform="translate(${stand.x - 2} ${stand.y - 1})">${fighterSvg(layout, stand, motion, asImage)}</g>` +
        (stand.side === 'right' ? '' : `<g transform="translate(${stand.x} ${stand.y - 1})">${pairFxSvg(layout, stand, motion, asImage)}</g>`)
      people.push(person(stand.member, sprite, standMarks(stand.member, stand)))
    }
    for (const spot of layout.spots) {
      const activity = spot.member.activity
      const sprite = `<g transform="translate(${spot.x} ${spot.y})">${figureSvg(spot.member, 'stand', isFaded(activity), figureMood(activity), asImage, isArena && motion)}</g>`
      people.push(person(spot.member, sprite, spotMarks(spot.member, spot)))
    }
    // Steam over the vending machine's cup and, in a wide room, the ramen bowls.
    const steamAt = (x: number, from: number, dur: number): string =>
      `<rect x="${x}" y="${from}" width="1" height="1" fill="${COLOR.steam}">` +
      `<animate attributeName="y" values="${from};${from - 3}" dur="${dur}s" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="0.9;0" dur="${dur}s" repeatCount="indefinite"/></rect>`
    const steam =
      motion && !isArena && layout.spots.length > 0
        ? steamAt(machineX(layout.width) - 3, layout.loungeY + 10, 1.6) +
          (layout.width >= COUNTER_MIN_WIDTH
            ? steamAt(counterX(layout.width) + 4, layout.loungeY + 6, 1.9) + steamAt(counterX(layout.width) + 11, layout.loungeY + 6, 2.3)
            : '')
        : ''
    const more = moreAt(layout)
    const extra =
      layout.extraDone > 0
        ? `<text x="${more.x}" y="${more.y + 1.6}" fill="${COLOR.moreText}" font-size="2.3" font-family="Menlo,ui-monospace,monospace">+${layout.extraDone}</text>`
        : ''
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width * SVG_SCALE}" height="${layout.height * SVG_SCALE}" ` +
      `viewBox="0 0 ${layout.width} ${layout.height}" shape-rendering="crispEdges">` +
      `<g>${svgPaths(room)}</g>` +
      (isArena
        ? `${backdropSvg(layout, spend, motion, asImage)}${benchesSvg(layout, asImage)}`
        : `${desksSvg(layout, asImage)}${motion ? ambientSvg(layout.width) : ''}${steam}`) +
      `${people.join('')}${extra}</svg>`
    )
  }
  for (const [motion, labels, asImage] of [
    [options.motion, options.labels, false],
    [options.motion, options.labels, true],
    [false, options.labels, true],
    [false, false, true],
  ] as const) {
    const markup = build(motion, labels, asImage)
    if (markup.length <= SVG_LIMIT) return markup
  }
  return undefined
}

/** One line for the picture's `alt`: who is in the office and what they do. */
export function officeAlt(members: readonly Member[], arena = false): string {
  const live = members.filter(member => !member.isEnded)
  const done = members.length - live.length
  const people = live.map(member => `${member.label}: ${ACTIVITY_WORDS[member.activity]}`).join('; ')
  const text = arena
    ? `Colosseum: ${people === '' ? 'empty' : people}${done > 0 ? `; ${done} on the sidelines` : ''}`
    : `Office: ${people === '' ? 'empty' : people}${done > 0 ? `; ${done} in the lounge` : ''}`
  return fit(text, 400)
}

// ---------------------------------------------------------------------------
// Another session's floor, closed: one storey of a building, its people at lit windows
// ---------------------------------------------------------------------------

/** How a storey reads at a glance: someone waits on you, people work, people think, or nobody does. */
export type FloorTone = 'waiting' | 'working' | 'thinking' | 'idle'

/** One closed floor of the building: its label's fields, and who sits at a window. */
export type BuildingFloor = {
  id: string
  /** Its number for `/radar expand`. */
  index: number
  /** "token-usage-mod": the label or folder name. */
  name: string
  /** "#7f1a": what tells two sessions of one folder apart. */
  tag?: string
  tone: FloorTone
  /** "Builder waiting on you", "Explore reading", "Lead thinking", "idle". */
  status: string
  /** The tool the one named runs, by name: "Bash". */
  tool?: string
  /** How long the one named has worked, or how long the floor has been idle: "2m 10s", "30m". */
  time?: string
  /** "3 at work", when more than one agent works. */
  count?: string
  isOpen: boolean
  /** The Lead and the live agents, Lead first: one window each. */
  members: readonly Member[]
}

export type BuildingOptions = {
  /** Width to fit, in terminal columns (one pixel each); the building, then its labels. */
  columns: number
  /** `$.clock.now()`: picks the terminal's animation frame. The SVG does not depend on it. */
  now: number
  motion: boolean
}

/** The building's width: two pillars and six windows of 5 with gaps of 2. */
export const BUILDING_W = 46
const ROOF_H = 8
const STOREY_H = 8
const LOBBY_H = 8
/** Windows on one floor; past these the label counts the rest. */
export const WINDOWS = 6
const LABEL_GAP = 3
/** The SVG's label column, in pixels. */
const LABEL_PX = 100
/** The neon sign on the roof: where it hangs, and how wide. */
const SIGN_X = 13
const SIGN_W = 20

const TOWER = {
  sky: '#141a3d',
  star: '#c9cbf2',
  wall: '#3b3366',
  pillar: '#2b2547',
  slab: '#1d1833',
  empty: '#1c1834',
  curtain: '#2a2448',
  desk: '#1a1530',
  antenna: '#8b8fa8',
  beacon: '#ff4d4d',
  beaconOff: '#5c2a3a',
  neon: CR_ORANGE,
  neonText: '#ffd2a8',
  signFace: '#241c3a',
  tank: '#6b4a5e',
  glass: '#7fb2d9',
  glassDark: '#34507a',
  awning: CR_ORANGE,
  awningAlt: '#fff4e6',
  lanternCap: '#2a1a12',
  lanternGlow: '#ffc58f',
} as const

/** Each tone's color: the status dot and word, the index chip. One red for "waiting" everywhere. */
export const TONE_COLORS: Readonly<Record<FloorTone, { dot: string; word: string; chip: string; chipText: string }>> = {
  waiting: { dot: '#ff5c5c', word: '#ff8a80', chip: '#ff5c5c', chipText: '#1a0f14' },
  working: { dot: '#ffcf70', word: '#ffe3a8', chip: CR_ORANGE, chipText: '#1f1208' },
  thinking: { dot: '#c3b4ff', word: '#ddd3ff', chip: '#8f7be8', chipText: '#140f26' },
  idle: { dot: '#6f6a8e', word: '#9893b5', chip: '#2f2a4d', chipText: '#a49fc0' },
}
const NAME_COLOR = '#f1ecff'
const NAME_DIM = '#a49fc0'
const META_COLOR = '#8b86a8'

/** A window's light for what its person does: warm while at work, lavender in thought, red while it waits on you. */
function lightOf(member: Member, frame: number): string {
  if (member.activity === 'waiting-you') return frame % 2 === 1 ? '#5c1f2a' : '#ff5c5c'
  // The Lead's room is lit cream, so its orange hair stands out against it.
  if (member.role === 'lead') return frame % 2 === 1 && BUSY.has(member.activity) ? '#fff4e0' : '#ffe7c2'
  switch (member.activity) {
    case 'thinking':
    case 'writing':
      return frame % 2 === 1 ? '#b3a2f5' : '#d2c4ff'
    case 'idle':
      return '#4a4270'
    case 'helper':
    case 'studying':
    case 'starting':
      return '#a8d8ff'
    default:
      return frame % 2 === 1 ? '#fff1c2' : '#ffe08a'
  }
}

/**
 * One window, 5 by 5, at (x, y) of `canvas`: its light, then the person in their own colors (hair,
 * face, outfit, a dot of their role's accent), at a dark desk. A busy head nods on the second frame.
 * An empty window has its curtains drawn.
 */
function paintTowerWindow(canvas: Canvas, x: number, y: number, member: Member | undefined, frame: number, dim: boolean): void {
  if (member === undefined) {
    fillRect(canvas, x, y, 5, 5, TOWER.empty)
    fillRect(canvas, x + 1, y, 1, 3, TOWER.curtain)
    fillRect(canvas, x + 3, y, 1, 3, TOWER.curtain)
    return
  }
  const look = lookOf(member)
  const shade = (color: string): string => (dim ? blend(color, '#1c1834', 0.62) : color)
  fillRect(canvas, x, y, 5, 5, dim ? '#3a3360' : lightOf(member, frame))
  const nod = !dim && BUSY.has(member.activity) && frame % 2 === 1 ? 1 : 0
  fillRect(canvas, x + 1, y + 1 + nod, 3, 1, shade(look.hair))
  setPixel(canvas, x + (member.role === 'lead' ? 2 : 3), y + 1 + nod, shade(member.role === 'lead' ? look.hair : look.accent))
  fillRect(canvas, x + 1, y + 2 + nod, 3, 1, shade(look.skin))
  fillRect(canvas, x, y + 3 + nod, 5, 1, shade(look.outfit))
  fillRect(canvas, x, y + 4, 5, 1, TOWER.desk)
}

/** The roof: the parapet, an antenna with its beacon, the neon sign's frame and a water tank. */
function paintRoof(canvas: Canvas, isBeaconLit: boolean): void {
  fillRect(canvas, 0, ROOF_H - 2, BUILDING_W, 2, TOWER.pillar)
  fillRect(canvas, 6, 1, 1, ROOF_H - 3, TOWER.antenna)
  setPixel(canvas, 6, 0, isBeaconLit ? TOWER.beacon : TOWER.beaconOff)
  fillRect(canvas, SIGN_X, 1, SIGN_W, 5, TOWER.neon)
  fillRect(canvas, SIGN_X + 1, 2, SIGN_W - 2, 3, TOWER.signFace)
  fillRect(canvas, 37, 2, 6, 4, TOWER.tank)
  fillRect(canvas, 38, 1, 4, 1, TOWER.tank)
}

/** A storey's shell: wall, slab, pillars; the windows come after. */
function paintStoreyShell(canvas: Canvas, y: number): void {
  fillRect(canvas, 0, y, BUILDING_W, STOREY_H, TOWER.wall)
  fillRect(canvas, 0, y, BUILDING_W, 1, TOWER.slab)
  fillRect(canvas, 0, y + 1, 2, STOREY_H - 1, TOWER.pillar)
  fillRect(canvas, BUILDING_W - 2, y + 1, 2, STOREY_H - 1, TOWER.pillar)
}

const windowX = (i: number): number => 3 + i * 7

/** The lobby: a striped awning over glass doors, a paper lantern each side. */
function paintLobby(canvas: Canvas, y: number): void {
  fillRect(canvas, 0, y, BUILDING_W, LOBBY_H, TOWER.wall)
  fillRect(canvas, 0, y, BUILDING_W, 1, TOWER.slab)
  for (let x = 4; x < BUILDING_W - 4; x += 1) fillRect(canvas, x, y + 1, 1, 2, x % 4 < 2 ? TOWER.awning : TOWER.awningAlt)
  fillRect(canvas, 17, y + 3, 12, LOBBY_H - 3, TOWER.glassDark)
  fillRect(canvas, 18, y + 4, 4, LOBBY_H - 4, TOWER.glass)
  fillRect(canvas, 24, y + 4, 4, LOBBY_H - 4, TOWER.glass)
  for (const x of [6, 37]) {
    setPixel(canvas, x + 1, y + 3, TOWER.lanternCap)
    fillRect(canvas, x, y + 4, 3, 3, CR_ORANGE)
    setPixel(canvas, x + 1, y + 5, TOWER.lanternGlow)
  }
}

/** Stars over the label column, where no text stands. */
function paintSky(canvas: Canvas): void {
  for (let x = BUILDING_W + 6; x < canvas.width; x += 17) setPixel(canvas, x, (x * 7) % 5, TOWER.star)
}

const towerHeight = (floors: readonly BuildingFloor[]): number => ROOF_H + floors.length * STOREY_H + LOBBY_H
const storeyY = (i: number): number => ROOF_H + i * STOREY_H

/** Whether anything in the building moves: a floor at work. */
export function isBuildingMoving(floors: readonly BuildingFloor[]): boolean {
  return floors.some(floor => floor.tone !== 'idle')
}

/**
 * How many 250-ms frames one window holds its light, so the windows do not flicker in step: a wait
 * blinks fast, thought is slow, work sits in between, each window a little apart from the next.
 */
export function windowPeriod(member: Member, floorIndex: number, windowIndex: number): number {
  if (member.activity === 'waiting-you') return 2
  if (member.activity === 'thinking' || member.activity === 'writing') return 6
  return 3 + ((floorIndex * 5 + windowIndex * 3) % 3)
}

/** The frame a window shows at building frame `frame`: its own period, its own offset. */
function windowFrame(frame: number, period: number, floorIndex: number, windowIndex: number): number {
  return Math.floor((frame + floorIndex * 3 + windowIndex * 2) / period) % 2
}

/** The sign's words: the number of floors. */
const signText = (floors: readonly BuildingFloor[]): string => (floors.length === 1 ? '1 FLOOR' : `${floors.length} FLOORS`)

/**
 * The other sessions as one building, in Raster cells at `now`: a storey each, its people at lit
 * windows that flicker each in its own time, and beside it a label: a numbered chip in the floor's
 * color, the name, a status dot and word, the tool, the time and the count. Undefined when there
 * are none or it does not fit.
 */
export function buildingRaster(floors: readonly BuildingFloor[], options: BuildingOptions): RasterFrame | undefined {
  if (floors.length === 0 || !Number.isFinite(options.columns) || options.columns < BUILDING_W) return undefined
  const moving = options.motion && isBuildingMoving(floors)
  const frame = frameAt(options.now, moving)
  const width = Math.min(options.columns, BUILDING_W + LABEL_GAP + 64)
  const canvas = createCanvas(width, towerHeight(floors), TOWER.sky)
  paintSky(canvas)
  paintRoof(canvas, moving && Math.floor(frame / 4) % 2 === 0)
  floors.forEach((floor, f) => {
    const y = storeyY(f)
    paintStoreyShell(canvas, y)
    for (let i = 0; i < WINDOWS; i += 1) {
      const member = floor.members[i]
      const own = member === undefined || !moving ? 0 : windowFrame(frame, windowPeriod(member, f, i), f, i)
      paintTowerWindow(canvas, windowX(i), y + 2, member, own, floor.tone === 'idle')
    }
  })
  paintLobby(canvas, storeyY(floors.length))
  const overlays: Overlay[] = [
    { col: SIGN_X + Math.max(1, Math.floor((SIGN_W - signText(floors).length) / 2)), row: 1, text: signText(floors), fg: TOWER.neonText, bg: TOWER.signFace },
  ]
  const left = BUILDING_W + LABEL_GAP
  const room = width - left
  if (room >= 10) {
    floors.forEach((floor, f) => {
      const row = storeyY(f) / 2 + 1
      const tone = TONE_COLORS[floor.tone]
      const chip = ` ${floor.index} `
      overlays.push({ col: left, row, text: chip, fg: tone.chipText, bg: tone.chip })
      const right = floor.count ?? ''
      const nameRoom = room - chip.length - 1 - (right === '' ? 0 : right.length + 1)
      const name = fit(floor.name, Math.max(4, nameRoom - (floor.tag === undefined ? 0 : floor.tag.length + 1)))
      overlays.push({ col: left + chip.length + 1, row, text: name, fg: floor.tone === 'idle' ? NAME_DIM : NAME_COLOR })
      const after = left + chip.length + 2 + name.length
      if (floor.tag !== undefined) overlays.push({ col: after, row, text: floor.tag, fg: META_COLOR })
      const openAt = after + (floor.tag === undefined ? 0 : floor.tag.length + 1)
      if (floor.isOpen && openAt + 4 <= width - (right === '' ? 0 : right.length + 1)) overlays.push({ col: openAt, row, text: 'open', fg: CR_ORANGE })
      if (right !== '') overlays.push({ col: width - right.length, row, text: right, fg: META_COLOR })
      // The status line: a dot in the floor's color, its word, the tool, and the time at the right.
      setPixel(canvas, left + 1, (row + 1) * 2, tone.dot)
      setPixel(canvas, left + 1, (row + 1) * 2 + 1, tone.dot)
      const time = floor.time ?? ''
      const statusRoom = room - 3 - (time === '' ? 0 : time.length + 1)
      const status = fit(floor.status, statusRoom)
      overlays.push({ col: left + 3, row: row + 1, text: status, fg: tone.word })
      const toolRoom = statusRoom - status.length - 1
      if (floor.tool !== undefined && toolRoom >= floor.tool.length) overlays.push({ col: left + 4 + status.length, row: row + 1, text: floor.tool, fg: META_COLOR })
      if (time !== '') overlays.push({ col: width - time.length, row: row + 1, text: time, fg: META_COLOR })
    })
  }
  return toCells(canvas, overlays, TOWER.sky)
}

const SANS = `-apple-system,'SF Pro Text','Helvetica Neue',system-ui,sans-serif`
const MONO = `'SF Mono',Menlo,ui-monospace,monospace`

/** One window as its own little picture, flickering on its own period, so the building never strobes in step. */
function windowSvg(member: Member | undefined, floor: BuildingFloor, f: number, i: number, motion: boolean): string {
  const draw = (frame: number): string => {
    const canvas = createCanvas(5, 5)
    paintTowerWindow(canvas, 0, 0, member, frame, floor.tone === 'idle')
    return svgPaths(canvas)
  }
  const at = `translate(${windowX(i)} ${storeyY(f) + 2})`
  if (member === undefined || !motion || floor.tone === 'idle') return `<g transform="${at}">${draw(0)}</g>`
  const period = windowPeriod(member, f, i) * FRAME_MS * 2
  const offset = ((f * 3 + i * 2) % windowPeriod(member, f, i)) * FRAME_MS
  const a = draw(0)
  const b = draw(1)
  if (a === b) return `<g transform="${at}">${a}</g>`
  const anim = (values: string): string =>
    `<animate attributeName="opacity" values="${values}" dur="${seconds(period)}" begin="-${seconds(offset)}" calcMode="discrete" repeatCount="indefinite"/>`
  return `<g transform="${at}"><g>${a}${anim('1;0')}</g><g opacity="0">${b}${anim('0;1')}</g></g>`
}

/** A storey's label in the SVG: a numbered chip, the name and tag, the count; then a status dot, its word, the tool and the time. */
function labelSvg(floor: BuildingFloor, f: number, width: number): string {
  const top = storeyY(f)
  const x = BUILDING_W + LABEL_GAP
  const tone = TONE_COLORS[floor.tone]
  const chipW = floor.index >= 10 ? 7.4 : 5.6
  const nameBudget = floor.count === undefined ? 42 : 32
  const name = fit(floor.name, nameBudget - (floor.tag?.length ?? 0))
  const time = floor.time ?? ''
  const status = fit(floor.status, time === '' ? 40 : 32)
  const parts = [
    `<rect x="${x}" y="${(top + 0.9).toFixed(2)}" width="${chipW}" height="3.6" rx="1.1" fill="${tone.chip}"/>`,
    `<text x="${(x + chipW / 2).toFixed(2)}" y="${(top + 3.6).toFixed(2)}" fill="${tone.chipText}" font-family="${MONO}" font-size="2.6" font-weight="700" text-anchor="middle">${floor.index}</text>`,
    `<text x="${(x + chipW + 1.6).toFixed(2)}" y="${(top + 3.75).toFixed(2)}" font-family="${SANS}" font-size="3.3" font-weight="600" letter-spacing="0.02" fill="${floor.tone === 'idle' ? NAME_DIM : NAME_COLOR}">` +
      `${escapeXml(name)}${floor.tag === undefined ? '' : `<tspan dx="1.2" font-size="2.5" font-weight="500" fill="${META_COLOR}">${escapeXml(floor.tag)}</tspan>`}` +
      `${floor.isOpen ? `<tspan dx="1.4" font-size="2.3" font-weight="600" fill="${CR_ORANGE}">OPEN</tspan>` : ''}</text>`,
    floor.count === undefined
      ? ''
      : `<text x="${width - 1.5}" y="${(top + 3.6).toFixed(2)}" font-family="${SANS}" font-size="2.4" font-weight="500" fill="${META_COLOR}" text-anchor="end">${escapeXml(floor.count)}</text>`,
    `<circle cx="${(x + 1.3).toFixed(2)}" cy="${(top + 6.25).toFixed(2)}" r="0.85" fill="${tone.dot}"/>`,
    `<text x="${(x + 3).toFixed(2)}" y="${(top + 7.15).toFixed(2)}" font-family="${SANS}" font-size="2.6" font-weight="500" fill="${tone.word}">` +
      `${escapeXml(status)}${floor.tool === undefined ? '' : `<tspan dx="1.1" fill="${META_COLOR}" font-family="${MONO}" font-size="2.3">${escapeXml(floor.tool)}</tspan>`}</text>`,
    time === ''
      ? ''
      : `<text x="${width - 1.5}" y="${(top + 7.15).toFixed(2)}" font-family="${MONO}" font-size="2.4" fill="${META_COLOR}" text-anchor="end" style="font-variant-numeric:tabular-nums">${escapeXml(time)}</text>`,
  ]
  return parts.join('')
}

/**
 * The building as an SVG: the shell as one layer, then each window flickering on its own period
 * (a wait blinks fast), the beacon on its own slow beat, a slow shimmer on the sign, and the labels
 * set in type. Nothing in it is timed from `now`, so a redraw restarts nothing and the last drawing
 * is safe to repaint.
 */
export function buildingSvg(floors: readonly BuildingFloor[], options: BuildingOptions): string | undefined {
  if (floors.length === 0) return undefined
  const moving = options.motion && isBuildingMoving(floors)
  const width = BUILDING_W + LABEL_GAP + LABEL_PX
  const height = towerHeight(floors)
  const shell = createCanvas(width, height, TOWER.sky)
  paintSky(shell)
  paintRoof(shell, true)
  floors.forEach((_, f) => paintStoreyShell(shell, storeyY(f)))
  paintLobby(shell, storeyY(floors.length))
  const windows = floors
    .map((floor, f) => Array.from({ length: WINDOWS }, (_, i) => windowSvg(floor.members[i], floor, f, i, moving)).join(''))
    .join('')
  const beacon = moving
    ? `<rect x="6" y="0" width="1" height="1" fill="${TOWER.beaconOff}"><animate attributeName="fill" values="${TOWER.beacon};${TOWER.beaconOff}" dur="1.8s" calcMode="discrete" repeatCount="indefinite"/></rect>`
    : `<rect x="6" y="0" width="1" height="1" fill="${TOWER.beaconOff}"/>`
  const sign =
    `<text x="${SIGN_X + SIGN_W / 2}" y="4.55" fill="${TOWER.neonText}" font-family="${SANS}" font-size="2.5" font-weight="800" letter-spacing="0.45" text-anchor="middle">` +
    `${escapeXml(signText(floors))}${moving ? `<animate attributeName="opacity" values="1;0.72;1" dur="3.2s" repeatCount="indefinite"/>` : ''}</text>`
  const labels = floors.map((floor, f) => labelSvg(floor, f, width)).join('')
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * SVG_SCALE}" height="${height * SVG_SCALE}" viewBox="0 0 ${width} ${height}">` +
    `<g shape-rendering="crispEdges">${svgPaths(shell)}${windows}${beacon}</g>` +
    `<g shape-rendering="geometricPrecision" text-rendering="geometricPrecision">${sign}${labels}</g></svg>`
  return markup.length <= SVG_LIMIT ? markup : undefined
}

/** One line for an open floor's office `alt`: whose floor, and what its people do. */
export function floorAlt(name: string, members: readonly Member[]): string {
  const live = members.filter(member => !member.isEnded)
  const people = live.map(member => `${member.label}: ${ACTIVITY_WORDS[member.activity]}`).join('; ')
  return fit(`Floor ${name}, open: ${people === '' ? 'empty' : people}`, 400)
}

/** One line for the building's `alt`: each floor, its state and what it does. */
export function buildingAlt(floors: readonly BuildingFloor[]): string {
  const said = floors.map(floor =>
    [`${floor.index} ${floor.name}${floor.tag === undefined ? '' : ` ${floor.tag}`}`, floor.status, floor.tool, floor.time, floor.count].filter(part => part !== undefined && part !== '').join(', '),
  )
  return fit(`Building: ${said.join('; ')}`, 400)
}

// ---------------------------------------------------------------------------
// Avatars for the cards
// ---------------------------------------------------------------------------

function avatarCanvas(member: Pick<Member, 'id' | 'role' | 'isEnded' | 'variant'>): Canvas {
  const canvas = createCanvas(SPRITE_W, AVATAR_H, COLOR.avatarBack)
  drawSprite(canvas, 0, 0, spriteOf('seat', member.role, member.variant ?? 0, 'normal'), peopleColors(lookOf(member), member.isEnded))
  return canvas
}

/** A card's portrait as 20 by 9 terminal cells. */
export function avatarRaster(member: Pick<Member, 'id' | 'role' | 'isEnded' | 'variant'>): RasterFrame {
  return toCells(avatarCanvas(member), [], COLOR.avatarBack)
}

/** A card's portrait as a small SVG. */
export function avatarSvg(member: Pick<Member, 'id' | 'role' | 'isEnded' | 'variant'>): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="36" viewBox="0 0 ${SPRITE_W} ${AVATAR_H}" shape-rendering="crispEdges">` +
    `${svgPaths(avatarCanvas(member))}</svg>`
  )
}
