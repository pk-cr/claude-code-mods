import { describe, expect, test } from 'claude-code/testing'

import {
  ARCHETYPES,
  CR_ORANGE,
  MIN_OFFICE_COLUMNS,
  outlined,
  SVG_LIMIT,
  WALK_MS,
  activityOf,
  avatarRaster,
  avatarSvg,
  contextBar,
  figureMood,
  isFaded,
  paintSeated,
  BUILDING_W,
  TONE_COLORS,
  WINDOWS,
  buildingAlt,
  buildingRaster,
  buildingSvg,
  displayName,
  floorAlt,
  frameAt,
  isBuildingMoving,
  windowPeriod,
  hashOf,
  layoutOffice,
  lookOf,
  numberLabels,
  officeAlt,
  officeRaster,
  officeSvg,
  paintFigure,
  roleOf,
  toolActivity,
  walkProgress,
  withVariants,
  ARENA_IDLE_MS,
  ARENA_LINGER_MS,
  arenaOn,
  tagChars,
  layoutArena,
  archetypeOf,
  fitTag,
  gauntletOf,
} from './office'
import type { BuildingFloor, Member } from './office'
import { ARENA, ARENA_LOOKS, CREW, EMPEROR } from './crew'
import { base64, blend, cellChar, colorAt, createCanvas, fillRect, pngBase64, setPixel, shiftHue, svgPaths, toCells, upscale } from './pixels'

const NOW = 1_000_000

const member = (fields: Partial<Member> & Pick<Member, 'id'>): Member => ({
  label: fields.id,
  role: 'general',
  activity: 'typing',
  seat: 1,
  isEnded: false,
  startedAt: NOW - 60_000,
  tooltip: `${fields.id} at work`,
  ...fields,
})

/** The chunks of a PNG, by type. */
function pngChunks(base64Png: string): Map<string, Uint8Array> {
  const bytes = Uint8Array.from(atob(base64Png), ch => ch.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const chunks = new Map<string, Uint8Array>()
  for (let at = 8; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at)
    chunks.set(String.fromCharCode(...bytes.slice(at + 4, at + 8)), bytes.slice(at + 8, at + 8 + size))
    at += 12 + size
  }
  return chunks
}

/** A small inflater for one fixed-Huffman block: the check that the PNG encoder's stream decodes to its input. */
function inflateFixed(zlib: Uint8Array): number[] {
  const data = zlib.slice(2, zlib.length - 4)
  let pos = 0
  const bit = (): number => {
    const value = ((data[pos >> 3] ?? 0) >> (pos & 7)) & 1
    pos += 1
    return value
  }
  const bits = (n: number): number => {
    let value = 0
    for (let i = 0; i < n; i += 1) value |= bit() << i
    return value
  }
  const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
  const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
  const distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
  const distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
  expect(bit()).toBe(1)
  expect(bits(2)).toBe(1)
  const symbol = (): number => {
    let code = 0
    for (let n = 1; n <= 9; n += 1) {
      code = (code << 1) | bit()
      if (n === 7 && code <= 0b0010111) return 256 + code
      if (n === 8 && code >= 0x30 && code <= 0xbf) return code - 0x30
      if (n === 8 && code >= 0xc0 && code <= 0xc7) return 280 + code - 0xc0
      if (n === 9 && code >= 0x190) return 144 + code - 0x190
    }
    throw new Error('not a fixed Huffman code')
  }
  const out: number[] = []
  for (;;) {
    const sym = symbol()
    if (sym === 256) return out
    if (sym < 256) {
      out.push(sym)
      continue
    }
    const length = (lengthBase[sym - 257] ?? 0) + bits(lengthExtra[sym - 257] ?? 0)
    let slot = 0
    for (let i = 0; i < 5; i += 1) slot = (slot << 1) | bit()
    const distance = (distBase[slot] ?? 0) + bits(distExtra[slot] ?? 0)
    for (let i = 0; i < length; i += 1) out.push(out[out.length - distance] ?? 0)
  }
}

const rgbSum = (color: string): number => [1, 3, 5].reduce((sum, at) => sum + Number.parseInt(color.slice(at, at + 2), 16), 0)

const LEAD = member({ id: 'main', label: 'Lead', role: 'lead', activity: 'thinking', seat: 0, startedAt: 0 })

/** Decodes Raster cells back to `[codePoint, fg, bg]` triplets. */
function decode(cells: string): number[][] {
  const bytes = Uint8Array.from(atob(cells), ch => ch.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const out: number[][] = []
  for (let at = 0; at + 12 <= bytes.length; at += 12) {
    out.push([view.getUint32(at, true), view.getUint32(at + 4, true), view.getUint32(at + 8, true)])
  }
  return out
}

describe('pixels', () => {
  test('base64 matches the standard', () => {
    const enc = (text: string): string => base64(new TextEncoder().encode(text))
    expect(enc('')).toBe('')
    expect(enc('f')).toBe('Zg==')
    expect(enc('fo')).toBe('Zm8=')
    expect(enc('foo')).toBe('Zm9v')
    expect(enc('foobar')).toBe('Zm9vYmFy')
    expect(base64(Uint8Array.of(0xff, 0xfe, 0xfd, 0xfc))).toBe('//79/A==')
  })

  test('two pixels make one cell: an upper half block, or a space when they match', () => {
    const canvas = createCanvas(2, 2)
    fillRect(canvas, 0, 0, 1, 1, '#ff0000')
    fillRect(canvas, 0, 1, 1, 1, '#0000ff')
    fillRect(canvas, 1, 0, 1, 2, '#00ff00')
    const frame = toCells(canvas)
    expect(frame).toMatchObject({ columns: 2, rows: 1 })
    expect(decode(frame.cells)).toEqual([
      [0x2580, 0xff0000, 0x0000ff],
      [0x20, 0x00ff00, 0x00ff00],
    ])
  })

  test('an odd height pads the last row with the background', () => {
    const canvas = createCanvas(1, 1, '#123456')
    expect(decode(toCells(canvas, [], '#000000').cells)).toEqual([[0x2580, 0x123456, 0x000000]])
  })

  test('overlays write text on the cell background, and only safe glyphs', () => {
    const canvas = createCanvas(4, 2, '#101010')
    const cells = decode(toCells(canvas, [{ col: 1, row: 0, text: 'a…界', fg: '#ffffff' }]).cells)
    expect(cells[1]).toEqual(['a'.codePointAt(0), 0xffffff, 0x101010])
    expect(cells[2]?.[0]).toBe(0x2026)
    expect(cells[3]?.[0]).toBe(0x3f)
    expect(cellChar('✓')).toBe(0x2713)
    expect(cellChar('\u0007')).toBe(0x3f)
  })

  test('svg paths merge a row of one color into one run', () => {
    const canvas = createCanvas(4, 1)
    fillRect(canvas, 0, 0, 3, 1, '#abcdef')
    expect(svgPaths(canvas)).toBe('<path fill="#abcdef" d="M0 0h3v1H0z"/>')
  })

  test('blend mixes two colors', () => {
    expect(blend('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(blend('#123456', '#ffffff', 0)).toBe('#123456')
    expect(blend('red', '#ffffff', 0.5)).toBe('red')
  })
})

describe('who is who', () => {
  test('agent types get a role and a short name', () => {
    expect(roleOf('Explore')).toBe('explore')
    expect(roleOf('Plan')).toBe('plan')
    expect(roleOf('general-purpose')).toBe('general')
    expect(roleOf('delegate:scout')).toBe('scout')
    expect(roleOf('delegate:builder')).toBe('builder')
    expect(roleOf('statslab:stats-reviewer')).toBe('reviewer')
    expect(roleOf('acme:widget')).toBe('other')
    expect(displayName('general-purpose')).toBe('General')
    expect(displayName('delegate:scout')).toBe('Scout')
    expect(displayName('Explore')).toBe('Explore')
  })

  test('repeated names are numbered in order', () => {
    expect(numberLabels(['Explore', 'Plan', 'Explore', 'Explore'])).toEqual(['Explore', 'Plan', 'Explore 2', 'Explore 3'])
  })

  test('a tool call reads as an activity, and a status wins over a phase', () => {
    expect(toolActivity('Grep')).toBe('reading')
    expect(toolActivity('Edit')).toBe('typing')
    expect(toolActivity('Bash')).toBe('terminal')
    expect(toolActivity('WebSearch')).toBe('browsing')
    expect(toolActivity('Agent')).toBe('helper')
    expect(toolActivity('mcp__github__get_issue')).toBe('calling')
    expect(activityOf({ status: 'running', phase: 'tool', tool: 'Read', isWaiting: false })).toBe('reading')
    expect(activityOf({ status: 'running', phase: 'tool', tool: 'Bash', isWaiting: true })).toBe('waiting-you')
    expect(activityOf({ status: 'completed', phase: 'done', isWaiting: true })).toBe('done')
    expect(activityOf({ status: 'killed', phase: 'stopped', isWaiting: false })).toBe('stopped')
    expect(activityOf({ status: 'idle', phase: 'done', isWaiting: false })).toBe('idle')
    expect(activityOf({ status: 'running', phase: 'writing', isWaiting: false })).toBe('writing')
  })

  test('a face is stable for an id, and a named role is always the same character', () => {
    expect(hashOf('a1')).toBe(hashOf('a1'))
    expect(lookOf({ id: 'a1', role: 'builder' })).toEqual(lookOf({ id: 'a1', role: 'builder' }))
    expect(lookOf({ id: 'a1', role: 'builder' })).toEqual(lookOf({ id: 'zz', role: 'builder' }))
    expect(lookOf({ id: 'a1', role: 'builder' }).hair).toBe('#8a5a3c')
    expect(lookOf({ id: 'main', role: 'lead' })).toMatchObject({ hair: '#e9edf7', accent: CR_ORANGE })
  })

  test('every role has a studio role, and the director wears a brand-orange beret', () => {
    const roles = ['lead', 'explore', 'scout', 'plan', 'architect', 'reviewer', 'builder', 'researcher', 'general', 'other'] as const
    for (const role of roles) expect(ARCHETYPES[role].length).toBeGreaterThan(0)
    expect(ARCHETYPES.lead).toBe('director Kaito')
    expect(lookOf({ id: 'whoever', role: 'lead' }).accent).toBe(CR_ORANGE)
    // Two of the generic roles still get their own faces.
    for (const role of ['general', 'other'] as const) {
      const looks = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(id => JSON.stringify(lookOf({ id, role })))
      expect(new Set(looks).size).toBeGreaterThan(1)
    }
  })

  test('every role is its own 20 by 28 character: heads, bodies and legs line up', () => {
    const roles = Object.keys(CREW) as (keyof typeof CREW)[]
    expect(roles).toHaveLength(10)
    const looks = new Set<string>()
    for (const role of roles) {
      const sprite = CREW[role]
      for (const rows of [...Object.values(sprite.head), sprite.seatBody, sprite.body, ...Object.values(sprite.legs)]) {
        for (const row of rows) expect(row).toHaveLength(20)
      }
      for (const rows of Object.values(sprite.head)) expect(rows).toHaveLength(18)
      expect(sprite.seatBody).toHaveLength(2)
      expect(sprite.body).toHaveLength(6)
      for (const rows of Object.values(sprite.legs)) expect(rows).toHaveLength(4)
      looks.add(sprite.head.normal.join(''))
    }
    expect(looks.size).toBe(10)
  })

  test('a face for each state: working looks at the screen, a request is wide, a break is shut, done is glad, stuck is stuck', () => {
    for (const role of ['lead', 'plan', 'reviewer'] as const) {
      const heads = Object.values(CREW[role].head).map(rows => rows.join(''))
      expect(new Set(heads).size).toBe(6)
    }
    expect(figureMood('done')).toBe('happy')
    expect(figureMood('failed')).toBe('stuck')
    expect(figureMood('stopped')).toBe('normal')
  })

  test('repeated roles get sibling looks by start order: the first is the named character, the rest differ', () => {
    const builders = Array.from({ length: 8 }, (_, i) => member({ id: `b${i}`, role: 'builder', startedAt: 1000 + i, seat: i + 1 }))
    const looks = withVariants([LEAD, ...builders]).map(one => ({ ...one, look: JSON.stringify(lookOf(one)) }))
    expect(looks[0]?.variant).toBe(0)
    expect(looks[1]?.look).toBe(JSON.stringify(lookOf({ id: 'x', role: 'builder' })))
    expect(new Set(looks.slice(1).map(one => one.look)).size).toBe(8)
    // The role stays itself: accent, skin, kit and trousers do not change.
    const first = lookOf(looks[1] ?? LEAD)
    const eighth = lookOf(looks[8] ?? LEAD)
    expect([eighth.accent, eighth.skin, eighth.kit, eighth.pants]).toEqual([first.accent, first.skin, first.kit, first.pants])
    expect(eighth.hair).not.toBe(first.hair)
  })

  test('a variant follows start order, not list order or id order', () => {
    const a = member({ id: 'zz', role: 'plan', startedAt: 1000 })
    const b = member({ id: 'aa', role: 'plan', startedAt: 2000 })
    const variants = (list: Member[]): Record<string, number> => Object.fromEntries(withVariants(list).map(one => [one.id, one.variant]))
    expect(variants([a, b])).toEqual({ zz: 0, aa: 1 })
    expect(variants([b, a])).toEqual({ zz: 0, aa: 1 })
    // Two roles count apart, and a lone agent is always the named character.
    expect(variants([a, member({ id: 'r', role: 'reviewer', startedAt: 1500 })])).toEqual({ zz: 0, r: 0 })
  })

  test('a sibling is drawn in its own colors: portrait and office both change', () => {
    const portrait = (variant: number): string => avatarRaster({ id: 'a1', role: 'builder', isEnded: false, variant }).cells
    expect(portrait(1)).not.toBe(portrait(0))
    const team = (variant: number): Member[] => [LEAD, member({ id: 'a1', role: 'builder', variant })]
    const at = (variant: number): string | undefined => officeRaster(team(variant), {}, { columns: 100, now: NOW, labels: true, motion: true })?.cells
    expect(at(1)).not.toBe(at(0))
  })

  test('shiftHue turns a hue, keeps a grey grey, and lightens or darkens', () => {
    expect(shiftHue('#ff0000', 120)).toBe('#00ff00')
    expect(shiftHue('#ff0000', 0)).toBe('#ff0000')
    expect(shiftHue('#808080', 90)).toBe('#808080')
    expect(shiftHue('#336699', 0, 0.2)).not.toBe('#336699')
    expect(rgbSum(shiftHue('#336699', 0, 0.2))).toBeGreaterThan(rgbSum('#336699'))
    expect(rgbSum(shiftHue('#336699', 0, -0.2))).toBeLessThan(rgbSum('#336699'))
    expect(shiftHue('not a color', 40)).toBe('not a color')
  })

  test('a gauntlet names its agents, and only those names make gladiators and judges', () => {
    expect(gauntletOf('Gauntlet competitor C')).toEqual({ role: 'gladiator', label: 'Gladiator C', tag: 'Glad C', letter: 2 })
    expect(gauntletOf('Gauntlet competitor A')?.letter).toBe(0)
    expect(gauntletOf('Gauntlet competitor H')?.letter).toBe(7)
    expect(gauntletOf('Gauntlet judge r1m2')).toEqual({ role: 'judge', label: 'Judge r1m2', tag: 'Judge', kind: 'match', match: 'r1m2' })
    expect(gauntletOf('Gauntlet judge final')).toMatchObject({ label: 'Judge final', tag: 'Final', kind: 'final' })
    expect(gauntletOf('Gauntlet judge check')).toMatchObject({ tag: 'Check', kind: 'check' })
    expect(gauntletOf('Gauntlet judge r1m1 swap')).toMatchObject({ label: 'Judge r1m1 swap', tag: 'Swap', kind: 'swap' })
    expect(gauntletOf('Gauntlet judge r1m2 swap')).toEqual({ role: 'judge', label: 'Judge r1m2 swap', tag: 'Swap', kind: 'swap', match: 'r1m2' })
    expect(gauntletOf('Gauntlet judge r12m3 swap')?.match).toBe('r12m3')
    for (const other of ['Gauntlet competitor I', 'Gauntlet competitor', 'gauntlet competitor A', 'Gauntlet judge', 'Gauntlet judge r1m2 and more', 'Gauntlet judge final swap', 'Gauntlet judge r1m2 swapped', 'Gauntlet judge r1m2 swap ', 'Find the gauntlet competitor A', 'Find the Gauntlet competitor A', 'Not a Gauntlet judge final', '', undefined]) {
      expect(gauntletOf(other)).toBeUndefined()
    }
  })

  test('the arena cast is eight gladiators and eight judges, each its own 20 by 28 look', () => {
    for (const role of ['gladiator', 'judge'] as const) {
      expect(ARENA[role]).toHaveLength(8)
      expect(ARENA_LOOKS[role]).toHaveLength(8)
      for (const sprite of ARENA[role]) {
        for (const rows of [...Object.values(sprite.head), sprite.seatBody, sprite.body, ...Object.values(sprite.legs)]) for (const row of rows) expect(row).toHaveLength(20)
        for (const rows of Object.values(sprite.head)) expect(rows).toHaveLength(18)
        expect(sprite.seatBody).toHaveLength(2)
        expect(sprite.body).toHaveLength(6)
      }
      expect(new Set(ARENA[role].map(sprite => sprite.head.normal.join(''))).size).toBe(8)
      expect(new Set(ARENA_LOOKS[role].map(look => JSON.stringify(look))).size).toBe(8)
      const bodies = new Set(ARENA[role].map(sprite => sprite.body.join('')))
      expect(bodies.size).toBeGreaterThanOrEqual(6)
    }
    // No gladiator or judge shares a head with the studio crew.
    const crew = new Set(Object.values(CREW).map(sprite => sprite.head.normal.join('')))
    for (const role of ['gladiator', 'judge'] as const) for (const sprite of ARENA[role]) expect(crew.has(sprite.head.normal.join(''))).toBe(false)
  })

  test('a gladiator or judge is drawn by its variant, named by it, and not shifted like a sibling', () => {
    const at = (role: Member['role'], variant: number): string =>
      officeRaster([LEAD, member({ id: 'a1', role, variant })], {}, { columns: 100, now: NOW, labels: true, motion: true })?.cells ?? ''
    for (const role of ['gladiator', 'judge'] as const) {
      const seen = new Set(Array.from({ length: 8 }, (_, variant) => at(role, variant)))
      expect(seen.size).toBe(8)
      expect(at(role, 8)).toBe(at(role, 0))
      for (let variant = 0; variant < 8; variant += 1) expect(lookOf({ id: 'x', role, variant })).toEqual(ARENA_LOOKS[role][variant])
    }
    expect(archetypeOf({ role: 'gladiator', variant: 3 })).toBe('secutor')
    expect(archetypeOf({ role: 'judge', variant: 7 })).toBe('judge Docket')
    expect(archetypeOf({ role: 'builder', variant: 2 })).toBe('animator Bolt')
    expect(archetypeOf({ role: 'gladiator' })).toBe('murmillo')
  })

  test('each gladiator and judge has its own shape and its own prop, not only its own colors', () => {
    const shape = (role: Member['role'], variant: number): string => {
      const canvas = createCanvas(20, 28)
      paintFigure(canvas, 0, 0, { id: 'x', role, variant }, 'stand', false, 'normal')
      return [...canvas.px].map(index => (index === 0 ? 0 : 1)).join('')
    }
    const props = (role: Member['role'], variant: number): string => {
      const canvas = createCanvas(36, 36)
      paintSeated(canvas, 0, 0, member({ id: 'p', role, variant, activity: 'idle' }), 0)
      return [...canvas.px.slice(22 * 36)].map(index => canvas.palette[index] ?? '').join('|')
    }
    for (const role of ['gladiator', 'judge'] as const) {
      expect(new Set(Array.from({ length: 8 }, (_, variant) => shape(role, variant))).size).toBe(8)
      expect(new Set(Array.from({ length: 8 }, (_, variant) => props(role, variant))).size).toBe(8)
    }
  })

  test('no person in the arena cast has a personal name: gladiators are their class, judges a court object', () => {
    const classes = ['murmillo', 'retiarius', 'thraex', 'secutor', 'hoplomachus', 'provocator', 'eques', 'dimachaerus']
    const courtObjects = ['judge Gavel', 'judge Writ', 'judge Scales', 'judge Quill', 'judge Statute', 'judge Seal', 'judge Bell', 'judge Docket']
    expect(Array.from({ length: 8 }, (_, variant) => archetypeOf({ role: 'gladiator', variant }))).toEqual(classes)
    expect(Array.from({ length: 8 }, (_, variant) => archetypeOf({ role: 'judge', variant }))).toEqual(courtObjects)
  })

  test('a name tag never outgrows its chip: the SVG clips to what the chip holds, the terminal to its columns', () => {
    const long = member({ id: 'x', label: 'A very long agent name indeed', role: 'builder', isEnded: true, activity: 'done', endedAt: NOW - 60_000 })
    const svg = officeSvg([LEAD, long], {}, { columns: 112, now: NOW, labels: true, motion: false }) ?? ''
    const chips = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="2.4" rx="0.6"[^>]*\/><text[^>]*textLength="([\d.]+)"[^>]*>([^<]*)<\/text>/g)]
    expect(chips.length).toBeGreaterThanOrEqual(2)
    for (const [, , chip, length, text] of chips) {
      expect(Number(length)).toBeLessThanOrEqual(Number(chip) - 1)
      expect((text ?? '').length * 1.2).toBeLessThanOrEqual(Number(chip) - 1 + 0.01)
    }
    expect(chips.some(([, , , , text]) => (text ?? '').endsWith('…'))).toBe(true)
    expect(tagChars(12)).toBe(9)
    expect(tagChars(16)).toBe(12)
    expect(tagChars(1)).toBe(3)
    // The terminal has twice the room: a label that the SVG clips shows whole there.
    const cells = (labels: boolean): string =>
      decode(officeRaster([LEAD, member({ id: 'x', label: 'Explore 2', role: 'explore', isEnded: true, activity: 'done', endedAt: NOW - 60_000 })], {}, { columns: 100, now: NOW, labels, motion: false })?.cells ?? '')
        .map(([point]) => String.fromCodePoint(point ?? 0x20))
        .join('')
    expect(cells(true)).toContain('Explore 2')
    expect(cells(false)).not.toContain('Explore 2')
    // A label past even the terminal's room is clipped, not run over the next tag.
    const clipped = decode(officeRaster([LEAD, long], {}, { columns: 100, now: NOW, labels: true, motion: false })?.cells ?? '')
      .map(([point]) => String.fromCodePoint(point ?? 0x20))
      .join('')
    expect(clipped).toContain('…')
    expect(clipped).not.toContain('A very long agent name indeed')
  })

  test('a tag keeps its last short word when it is clipped', () => {
    expect(fitTag('Gladiator A', 9)).toBe('Gladia… A')
    expect(fitTag('Judge r1m1', 9)).toBe('Jud… r1m1')
    expect(fitTag('Gladiator A', 16)).toBe('Gladiator A')
    expect(fitTag('Explore researching', 9)).toBe('Explore …')
    expect(fitTag('Builder', 3)).toBe('Bu…')
  })

  test('a finished agent fades to rest, but a stuck one never does', () => {
    expect(isFaded('done')).toBe(true)
    expect(isFaded('stopped')).toBe(true)
    expect(isFaded('failed')).toBe(false)
    expect(isFaded('typing')).toBe(false)
  })

  test('the context gauge turns amber, then red', () => {
    expect(contextBar(0.25, 8)).toEqual({ bar: '██░░░░░░', color: '#3fb950', percent: 25 })
    expect(contextBar(0.7, 10).color).toBe('#d29922')
    expect(contextBar(0.9, 10).color).toBe('#f85149')
    expect(contextBar(Number.NaN, 4)).toEqual({ bar: '░░░░', color: '#3fb950', percent: 0 })
    expect(contextBar(3, 4).percent).toBe(100)
  })
})

describe('the room', () => {
  test('is undefined when two desks do not fit', () => {
    expect(layoutOffice([LEAD], MIN_OFFICE_COLUMNS - 1)).toBeUndefined()
    expect(layoutOffice([LEAD], Number.NaN)).toBeUndefined()
  })

  test('draws full rows of desks, the Lead at desk 0, and a lounge only for the finished', () => {
    const layout = layoutOffice([LEAD, member({ id: 'a1', seat: 1 })], 80)
    expect(layout?.perRow).toBe(4)
    expect(layout?.seats).toHaveLength(4)
    expect(layout?.seats[0]?.member?.id).toBe('main')
    expect(layout?.seats[1]?.member?.id).toBe('a1')
    expect(layout?.spots).toEqual([])
    const withLounge = layoutOffice([LEAD, member({ id: 'a2', seat: 2, isEnded: true, activity: 'done', endedAt: NOW })], 80)
    expect(withLounge?.spots.map(spot => spot.member.id)).toEqual(['a2'])
    expect((withLounge?.height ?? 0) > (layout?.height ?? 0)).toBe(true)
  })

  test('a desk past the first row adds a row, and two claims of one desk do not collide', () => {
    const layout = layoutOffice([LEAD, member({ id: 'a1', seat: 5 }), member({ id: 'a2', seat: 5 })], 80)
    expect(layout?.seats).toHaveLength(8)
    expect(layout?.seats[5]?.member?.id).toBe('a1')
    expect(layout?.seats.filter(seat => seat.member?.id === 'a2')).toHaveLength(1)
  })

  test('the lounge shows the most recent first and counts the rest', () => {
    const done = Array.from({ length: 9 }, (_, i) =>
      member({ id: `d${i}`, seat: i + 1, isEnded: true, activity: 'done', endedAt: NOW - i * 1000 }),
    )
    const layout = layoutOffice([LEAD, ...done], 60)
    expect(layout?.spots[0]?.member.id).toBe('d0')
    expect((layout?.spots.length ?? 0) + (layout?.extraDone ?? 0)).toBe(9)
    expect(layout?.extraDone).toBeGreaterThan(0)
  })
})

describe('motion', () => {
  test('frames step every 250 ms, and stand still without motion', () => {
    expect(frameAt(1000, true)).toBe(4)
    expect(frameAt(1250, true)).toBe(5)
    expect(frameAt(1250, false)).toBe(0)
  })

  test('a walk takes two seconds, and is over at once without motion', () => {
    expect(walkProgress(NOW, NOW, true)).toBe(0)
    expect(walkProgress(NOW, NOW + WALK_MS / 2, true)).toBe(0.5)
    expect(walkProgress(NOW, NOW + WALK_MS * 3, true)).toBe(1)
    expect(walkProgress(NOW, NOW, false)).toBe(1)
    expect(walkProgress(undefined, NOW, true)).toBe(1)
  })
})

describe('the terminal office', () => {
  const options = { columns: 100, now: NOW, labels: true, motion: true }

  test('is valid Raster cells: the size it says, and only blocks, spaces and safe text', () => {
    const frame = officeRaster([LEAD, member({ id: 'a1', label: 'Explore' })], {}, options)
    expect(frame).toBeDefined()
    if (frame === undefined) return
    expect(frame.columns).toBeLessThanOrEqual(100)
    const cells = decode(frame.cells)
    expect(cells).toHaveLength(frame.columns * frame.rows)
    for (const [point] of cells) {
      const ok = point === 0x2580 || point === 0x20 || point === 0x2026 || point === 0x2713 || ((point ?? 0) >= 0x21 && (point ?? 0) <= 0x7e)
      expect(ok).toBe(true)
    }
  })

  test('name tags show when labels are on', () => {
    const text = (labels: boolean): string => {
      const frame = officeRaster([LEAD, member({ id: 'a1', label: 'Explore' })], {}, { ...options, labels })
      return decode(frame?.cells ?? '')
        .map(([point]) => String.fromCodePoint(point ?? 0x20))
        .join('')
    }
    expect(text(true)).toContain('Explore')
    expect(text(true)).toContain('Lead')
    expect(text(false)).not.toContain('Explore')
  })

  test('moves from frame to frame while someone works, and stands still without motion', () => {
    const team = [LEAD, member({ id: 'a1', activity: 'typing' })]
    const at = (now: number, motion: boolean): string | undefined => officeRaster(team, {}, { ...options, now, motion })?.cells
    expect(at(NOW, true)).not.toBe(at(NOW + 250, true))
    expect(at(NOW, false)).toBe(at(NOW + 250, false))
  })

  test('a newcomer walks in from the door before taking its desk', () => {
    const settled = officeRaster([LEAD, member({ id: 'a1' })], {}, options)?.cells
    const arriving = officeRaster([LEAD, member({ id: 'a1', startedAt: NOW - 500 })], {}, options)?.cells
    const arrived = officeRaster([LEAD, member({ id: 'a1', startedAt: NOW - WALK_MS - 10 })], {}, options)?.cells
    expect(arriving).not.toBe(settled)
    expect(arrived).toBe(settled)
  })

  test('in the lounge, a finished agent shows a yellow + and a stuck one a red x', () => {
    const colorsOf = (team: Member[]): Set<number> =>
      new Set(decode(officeRaster(team, {}, options)?.cells ?? '').flatMap(([, fg, bg]) => [fg ?? 0, bg ?? 0]))
    const done = member({ id: 'd1', isEnded: true, activity: 'done', endedAt: NOW - 60_000 })
    const stuck = member({ id: 'd2', isEnded: true, activity: 'failed', endedAt: NOW - 60_000 })
    expect(colorsOf([LEAD, done]).has(0xfff3a3)).toBe(true)
    expect(colorsOf([LEAD, done]).has(0xc81e28)).toBe(false)
    expect(colorsOf([LEAD, stuck]).has(0xc81e28)).toBe(true)
    expect(colorsOf([LEAD, stuck]).has(0xfff3a3)).toBe(false)
  })

  test('the mark is one glyph cell in the middle of its box, for every state', () => {
    const glyphs = (team: Member[]): string => {
      const frame = officeRaster(team, {}, options)
      return decode(frame?.cells ?? '')
        .map(([point]) => String.fromCodePoint(point ?? 0x20))
        .join('')
    }
    const text = glyphs([
      LEAD,
      member({ id: 'a1', seat: 1, activity: 'waiting-you' }),
      member({ id: 'a2', seat: 2, activity: 'idle' }),
      member({ id: 'd1', seat: 3, isEnded: true, activity: 'done', endedAt: NOW - 60_000 }),
      member({ id: 'd2', seat: 4, isEnded: true, activity: 'failed', endedAt: NOW - 60_000 }),
    ])
    for (const glyph of ['…', '!', 'z', '+', 'x']) expect(text).toContain(glyph)
    expect(glyphs([member({ id: 'a1', seat: 0, activity: 'typing' })])).not.toContain('…')
  })

  test('a mark sits at its seat: one glyph cell, right of the head, in the middle of its box', () => {
    const team = [LEAD, member({ id: 'a1', seat: 1, activity: 'waiting-you' })]
    const layout = layoutOffice(team, 50)
    const seat = layout?.seats[1]
    expect(seat).toBeDefined()
    const frame = officeRaster(team, {}, options)
    const cells = decode(frame?.cells ?? '')
    const col = (seat?.x ?? 0) * 2 + 22 + 3
    const row = ((seat?.y ?? 0) * 2 + 2) / 2
    expect(cells[row * (frame?.columns ?? 0) + col]?.[0]).toBe(0x21)
    // The cell's own fill is the mark's red; the box's rim is dark around it.
    expect(cells[row * (frame?.columns ?? 0) + col]?.[2]).toBe(0xc81e28)
    expect(cells[row * (frame?.columns ?? 0) + col - 4]?.[1]).not.toBe(0xc81e28)
  })

  test('a request for you blinks: red, then dark red, on the beat of a frame', () => {
    const team = [LEAD, member({ id: 'a1', seat: 1, activity: 'waiting-you' })]
    const seat = layoutOffice(team, 50)?.seats[1]
    const fillAt = (now: number): number | undefined => {
      const frame = officeRaster(team, {}, { ...options, now })
      const at = (Math.floor(((seat?.y ?? 0) * 2 + 2) / 2)) * (frame?.columns ?? 0) + (seat?.x ?? 0) * 2 + 25
      return decode(frame?.cells ?? '')[at]?.[2]
    }
    expect(fillAt(NOW)).toBe(0xc81e28)
    expect(fillAt(NOW + 250)).toBe(0x8b2b2b)
    expect(fillAt(NOW + 500)).toBe(0xc81e28)
  })

  test('the narrowest room draws, and one column less does not', () => {
    const frame = officeRaster([LEAD, member({ id: 'a1', seat: 1 }), member({ id: 'd1', isEnded: true, activity: 'done', endedAt: NOW - 60_000 })], {}, { ...options, columns: MIN_OFFICE_COLUMNS * 2 })
    expect(frame).toBeDefined()
    expect(frame?.columns).toBe(MIN_OFFICE_COLUMNS * 2)
    expect(decode(frame?.cells ?? '')).toHaveLength((frame?.columns ?? 0) * (frame?.rows ?? 0))
    expect(officeRaster([LEAD], {}, { ...options, columns: MIN_OFFICE_COLUMNS * 2 - 1 })).toBeUndefined()
  })

  test('a wide room shows the neon STUDIO sign; a narrow one does not', () => {
    const colorsAt = (columns: number): Set<number> =>
      new Set(decode(officeRaster([LEAD], {}, { ...options, columns })?.cells ?? '').flatMap(([, fg, bg]) => [fg ?? 0, bg ?? 0]))
    expect(colorsAt(224).has(0xffbe78)).toBe(true)
    expect(colorsAt(100).has(0xffbe78)).toBe(false)
  })

  test('a room full of people keeps every color: more than 255 colors on one canvas', () => {
    const canvas = createCanvas(40, 40)
    for (let i = 0; i < 400; i += 1) setPixel(canvas, i % 40, Math.floor(i / 40), `#${(i * 997 + 0x101010).toString(16).padStart(6, '0').slice(-6)}`)
    expect(colorAt(canvas, 39, 9)).toBe(`#${(399 * 997 + 0x101010).toString(16).padStart(6, '0').slice(-6)}`)
    expect(colorAt(canvas, 0, 0)).toBe(`#${(0 * 997 + 0x101010).toString(16).padStart(6, '0').slice(-6)}`)
  })

  test('each role has its own prop on the desk', () => {
    const propsOf = (role: Member['role']): string => {
      const canvas = createCanvas(36, 36)
      paintSeated(canvas, 0, 0, member({ id: 'p', role, activity: 'idle' }), 0)
      // Rows 22 and below are the desk top: the sprite stops above it, so only props are there.
      return [...canvas.px.slice(22 * 36)].map(index => canvas.palette[index] ?? '').join('|')
    }
    const roles = ['lead', 'explore', 'scout', 'plan', 'architect', 'reviewer', 'builder', 'researcher', 'general', 'other'] as const
    expect(new Set(roles.map(propsOf)).size).toBe(10)
  })

  test('a still office draws the same each second: the window lights and the steam loop in four frames', () => {
    const team = [
      { ...LEAD, activity: 'idle' as const },
      member({ id: 'd1', isEnded: true, activity: 'done', endedAt: NOW - 60_000 }),
      member({ id: 'd2', isEnded: true, activity: 'failed', endedAt: NOW - 60_000 }),
    ]
    const at = (now: number): string | undefined => officeRaster(team, {}, { ...options, now })?.cells
    expect(at(NOW + 1000)).toBe(at(NOW))
    expect(at(NOW + 250)).not.toBe(at(NOW))
  })

  test('the wall board grows a bar per route kind', () => {
    const empty = officeRaster([LEAD], {}, options)?.cells
    const spent = officeRaster([LEAD], { lookup: 10, hard: 40 }, options)?.cells
    expect(spent).not.toBe(empty)
  })
})

describe('the remote office (SVG)', () => {
  const options = { columns: 100, now: NOW, labels: true, motion: true }

  test('is one SVG with a tooltip per person, tags, and SMIL motion', () => {
    const svg = officeSvg([LEAD, member({ id: 'a1', label: 'Explore', tooltip: 'Explore · reading · Grep: <x>' })], {}, options) ?? ''
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('<title>Explore · reading · Grep: &lt;x&gt;</title>')
    expect(svg).toContain('>Explore</text>')
    expect(svg).toContain('<animate ')
    expect(svg).toContain('shape-rendering="crispEdges"')
  })

  test('has no motion when motion is off, and no tags when labels are off', () => {
    const svg = officeSvg([LEAD, member({ id: 'a1', label: 'Explore' })], {}, { ...options, motion: false, labels: false }) ?? ''
    expect(svg).not.toContain('<animate')
    expect(svg).not.toContain('>Explore</text>')
  })

  test('the night window twinkles with motion on, and holds still with it off', () => {
    const team = [LEAD, member({ id: 'a1' })]
    expect(officeSvg(team, {}, options)).toContain('<animate attributeName="opacity" values="1;0.1;1"')
    expect(officeSvg(team, {}, { ...options, motion: false })).not.toContain('values="1;0.1;1"')
  })

  test('one mark slot for every state: thinking dots, !, z, + and x, and nothing for plain work', () => {
    const svg =
      officeSvg(
        [
          LEAD,
          member({ id: 'a1', seat: 1, activity: 'waiting-you' }),
          member({ id: 'a2', seat: 2, activity: 'idle' }),
          member({ id: 'a3', seat: 3, activity: 'typing' }),
          member({ id: 'd1', seat: 4, isEnded: true, activity: 'done', endedAt: NOW - 60_000 }),
          member({ id: 'd2', seat: 5, isEnded: true, activity: 'failed', endedAt: NOW - 60_000 }),
        ],
        {},
        options,
      ) ?? ''
    for (const glyph of ['!', 'z', '+', 'x']) expect(svg).toContain(`text-anchor="middle">${glyph}</text>`)
    // Only the request blinks.
    expect(svg.split('values="1;0.25"')).toHaveLength(2)
    expect(svg).toContain('values="0;1;1;0"')
    const plain = officeSvg([member({ id: 'a1', seat: 0, activity: 'typing' })], {}, options) ?? ''
    expect(plain).not.toContain('values="0;1;1;0"')
    expect(plain).not.toContain('text-anchor="middle">!</text>')
  })

  test('a walk is SMIL that picks up where it is: a negative begin', () => {
    const svg = officeSvg([LEAD, member({ id: 'a1', startedAt: NOW - 500 })], {}, options) ?? ''
    expect(svg).toContain('<animateTransform attributeName="transform" type="translate"')
    expect(svg).toContain('begin="-0.50s"')
    // The walk ends where the seated person's head is: one room pixel in from the desk's corner (20, 12).
    expect(svg).toContain('to="21 13"')
    expect(svg).toContain('<set attributeName="visibility" to="visible" begin="1.50s"')
  })

  test('the same team draws the same markup, so a redraw restarts nothing', () => {
    const team = [LEAD, member({ id: 'a1' })]
    expect(officeSvg(team, {}, options)).toBe(officeSvg(team, {}, { ...options, now: NOW + 5000 }))
  })

  test('stays under the size cap with a big team', () => {
    const team = [
      LEAD,
      ...Array.from({ length: 30 }, (_, i) => member({ id: `a${i}`, label: `Agent ${i}`, seat: i + 1 })),
      ...Array.from({ length: 12 }, (_, i) => member({ id: `d${i}`, seat: 40 + i, isEnded: true, activity: 'done', endedAt: NOW - i })),
    ]
    const svg = officeSvg(team, { routine: 5 }, options)
    expect(svg).toBeDefined()
    expect((svg ?? '').length).toBeLessThanOrEqual(SVG_LIMIT)
  })

  test('says in words who is there', () => {
    const alt = officeAlt([LEAD, member({ id: 'a1', label: 'Explore', activity: 'reading' }), member({ id: 'a2', isEnded: true, activity: 'done' })])
    expect(alt).toBe('Office: Lead: thinking; Explore: reading; 1 in the lounge')
  })
})

describe('detail', () => {
  test('an outline wraps every drawn pixel, and only empty cells', () => {
    const ink = (key: string): string => String.fromCharCode(0xe000 + key.charCodeAt(0))
    expect(outlined(['...', '.H.', '...'])).toEqual([`.${ink('H')}.`, `${ink('H')}H${ink('H')}`, `.${ink('H')}.`])
    // An outline takes the color of the neighbor below first, then left, right and above.
    expect(outlined(['.A', 'B.'])).toEqual([`${ink('B')}A`, `B${ink('B')}`])
  })

  test('upscale makes each pixel a block', () => {
    const small = createCanvas(2, 1)
    fillRect(small, 1, 0, 1, 1, '#ff0000')
    const big = upscale(small, 2)
    expect(big.width).toBe(4)
    expect(svgPaths(big)).toBe('<path fill="#ff0000" d="M2 0h2v1H2zM2 1h2v1H2z"/>')
  })

  test('a PNG of one flat color is deflated: a few hundred characters at most', () => {
    const canvas = createCanvas(36, 36, '#336699')
    expect(pngBase64(canvas).length).toBeLessThan(260)
  })

  test('a PNG deflates to exactly its pixels: runs, repeated rows and noise', () => {
    const canvas = createCanvas(40, 30, '#223344')
    fillRect(canvas, 3, 4, 20, 6, '#ff8800')
    fillRect(canvas, 10, 12, 25, 3, '#00cc88')
    for (let i = 0; i < 90; i += 1) setPixel(canvas, (i * 7) % 40, 16 + (i % 14), `#${((i * 2654435) % 0xffffff).toString(16).padStart(6, '0')}`)
    const raw: number[] = []
    for (let y = 0; y < canvas.height; y += 1) {
      raw.push(0)
      for (let x = 0; x < canvas.width; x += 1) raw.push(canvas.px[y * canvas.width + x] ?? 0)
    }
    const idat = pngChunks(pngBase64(canvas)).get('IDAT')
    expect(idat).toBeDefined()
    expect(inflateFixed(idat ?? new Uint8Array())).toEqual(raw)
  })

  test('a PNG holds at most 256 colors: a canvas with more draws the extra ones as the last', () => {
    const canvas = createCanvas(30, 20)
    for (let i = 0; i < 400; i += 1) setPixel(canvas, i % 30, Math.floor(i / 30), `#${(i * 997 + 0x101010).toString(16).padStart(6, '0').slice(-6)}`)
    const chunks = pngChunks(pngBase64(canvas))
    expect(chunks.get('PLTE')).toHaveLength(256 * 3)
    const raw = inflateFixed(chunks.get('IDAT') ?? new Uint8Array())
    expect(Math.max(...raw)).toBe(255)
  })

  test('a PNG sprite has the PNG signature and its size', () => {
    const canvas = createCanvas(3, 2)
    fillRect(canvas, 0, 0, 1, 1, '#123456')
    const bytes = Uint8Array.from(atob(pngBase64(canvas)), ch => ch.charCodeAt(0))
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const view = new DataView(bytes.buffer)
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([3, 2])
  })

  test('a big team draws its people as PNG sprites to stay under the cap', () => {
    const team = [
      LEAD,
      ...Array.from({ length: 30 }, (_, i) => member({ id: `a${i}`, label: `Agent ${i}`, seat: i + 1 })),
    ]
    const svg = officeSvg(team, {}, { columns: 100, now: NOW, labels: true, motion: true }) ?? ''
    expect(svg).toContain('href="data:image/png;base64,')
    expect(svg.length).toBeLessThanOrEqual(SVG_LIMIT)
    expect(officeSvg([LEAD, member({ id: 'a1' })], {}, { columns: 100, now: NOW, labels: true, motion: true })).not.toContain('data:image/png')
  })
})

describe('avatars', () => {
  test('a portrait is 20 by 9 cells in the terminal and a 20 by 18 SVG elsewhere', () => {
    const face = avatarRaster({ id: 'a1', role: 'explore', isEnded: false })
    expect(face).toMatchObject({ columns: 20, rows: 9 })
    expect(decode(face.cells)).toHaveLength(180)
    expect(avatarSvg({ id: 'a1', role: 'explore', isEnded: false })).toContain('viewBox="0 0 20 18"')
    expect(avatarRaster({ id: 'a1', role: 'explore', isEnded: true }).cells).not.toBe(face.cells)
  })
})

describe('the colosseum', () => {
  const options = { columns: 224, now: NOW, labels: true, motion: true, arena: true }
  const gladiator = (i: number, fields: Partial<Member> = {}): Member =>
    member({ id: `g${i}`, label: `Gladiator ${'ABCDEFGH'[i]}`, tag: `Glad ${'ABCDEFGH'[i]}`, role: 'gladiator', variant: i, seat: i + 1, startedAt: NOW - 60_000 + i, ...fields })
  const judge = (i: number, fields: Partial<Member> = {}): Member =>
    member({ id: `j${i}`, label: `Judge r1m${i + 1}`, tag: `Judge ${i + 1}`, role: 'judge', variant: i, seat: 20 + i, startedAt: NOW - 30_000 + i, activity: 'reading', ...fields })
  const emperor = { ...LEAD, variant: 1 }
  const team = [emperor, judge(0), judge(1), gladiator(0), gladiator(1), gladiator(2), gladiator(3)]
  const cellsAt = (members: Member[], now: number, extra: Partial<typeof options> = {}): string =>
    officeRaster(members, {}, { ...options, now, ...extra })?.cells ?? ''
  const colors = (members: Member[], now = NOW): Set<number> =>
    new Set(decode(officeRaster(members, {}, { ...options, now })?.cells ?? '').flatMap(([, fg, bg]) => [fg ?? 0, bg ?? 0]))

  test('it is on while any gladiator or judge runs, through gaps, and off with no gauntlet at all', () => {
    const ended = (member: Member, at: number): Member => ({ ...member, isEnded: true, activity: 'done', endedAt: at })
    expect(arenaOn([LEAD, member({ id: 'a1', role: 'builder' })], NOW)).toBe(false)
    expect(arenaOn([LEAD], NOW)).toBe(false)
    expect(arenaOn([LEAD, gladiator(0)], NOW)).toBe(true)
    expect(arenaOn([LEAD, judge(0)], NOW)).toBe(true)
    // A gap between waves: everyone has finished and the next wave has not started yet.
    const gap = [LEAD, ended(gladiator(0), NOW - 1000), ended(gladiator(1), NOW - 2000)]
    expect(arenaOn(gap, NOW)).toBe(true)
    expect(arenaOn(gap, NOW - 1000 + ARENA_IDLE_MS - 1)).toBe(true)
    // A stopped run ends after the idle hold.
    expect(arenaOn(gap, NOW - 1000 + ARENA_IDLE_MS)).toBe(false)
    // A long fight is not a gap: someone still running keeps it on however long it has gone.
    expect(arenaOn([LEAD, gladiator(0, { startedAt: NOW - 10 * ARENA_IDLE_MS })], NOW)).toBe(true)
  })

  test('the Lead running the last step ends it after a short finish, and a new gauntlet turns it on again', () => {
    const ended = (member: Member, at: number): Member => ({ ...member, isEnded: true, activity: 'done', endedAt: at })
    const run = [LEAD, ended(gladiator(0), NOW - 9000), ended(judge(0), NOW - 5000)]
    expect(arenaOn(run, NOW, undefined)).toBe(true)
    // The winner step at NOW - 4000: eight seconds of finish, then the studio.
    expect(arenaOn(run, NOW, NOW - 4000)).toBe(true)
    expect(arenaOn(run, NOW - 4000 + ARENA_LINGER_MS - 1, NOW - 4000)).toBe(true)
    expect(arenaOn(run, NOW - 4000 + ARENA_LINGER_MS, NOW - 4000)).toBe(false)
    // Even with agents still counted live, the closing step wins: nothing runs after the winner is read out.
    expect(arenaOn([LEAD, gladiator(0)], NOW + ARENA_LINGER_MS + 1, NOW)).toBe(false)
    // A second gauntlet in the same session starts after the first one's closing step.
    expect(arenaOn([...run, gladiator(1, { startedAt: NOW + 1000 })], NOW + 60_000, NOW - 4000)).toBe(true)
  })

  test('the room has a crowd, a banner and a sand floor: not one of the studio\'s colors is the carpet', () => {
    const arena = colors(team)
    const studio = new Set(decode(officeRaster(team, {}, { ...options, arena: false })?.cells ?? '').flatMap(([, fg, bg]) => [fg ?? 0, bg ?? 0]))
    expect(arena.has(0xe8cc94)).toBe(true)
    expect(arena.has(0x961824)).toBe(true)
    expect(arena.has(0x8d779a)).toBe(false)
    expect(studio.has(0x8d779a)).toBe(true)
    expect(studio.has(0x961824)).toBe(false)
    expect(cellsAt(team, NOW)).not.toBe(cellsAt(team, NOW, { arena: false }))
  })

  test('the Lead is the emperor: the same Kaito with a wreath, and the card names him so', () => {
    expect(lookOf(emperor)).not.toEqual(lookOf(LEAD))
    expect(lookOf(emperor).hair).toBe(lookOf(LEAD).hair)
    expect(lookOf(emperor).skin).toBe(lookOf(LEAD).skin)
    expect(archetypeOf(emperor)).toBe('emperor Kaito')
    expect(archetypeOf(LEAD)).toBe('director Kaito')
    expect(EMPEROR.head.normal.join('')).not.toBe(CREW.lead.head.normal.join(''))
    // The same face: the eyes and mouth match the director's (the ribbon tails and the hair's ends are outside it).
    expect(EMPEROR.head.normal.slice(10, 17).map(row => row.slice(5, 15))).toEqual(CREW.lead.head.normal.slice(10, 17).map(row => row.slice(5, 15)))
    const at = (member: Member): string => officeRaster([member], {}, { ...options, columns: 100 })?.cells ?? ''
    expect(at(emperor)).not.toBe(at(LEAD))
  })

  test('gladiators fight in pairs: the picture repeats every four frames, and differs frame to frame', () => {
    const at = (frame: number): string => cellsAt(team, NOW + frame * 250)
    expect(at(0)).not.toBe(at(1))
    expect(at(1)).not.toBe(at(2))
    expect(at(0)).toBe(at(4))
    expect(at(3)).toBe(at(7))
    // A beat apart per pair: it is never the same moment in two pairs.
    const two = [emperor, gladiator(0), gladiator(1), gladiator(2), gladiator(3)]
    expect(cellsAt(two, NOW + 250)).not.toBe(cellsAt(two, NOW))
  })

  test('the crowd waves on its own beat, the finished sway on the sidelines, and every pair is a beat behind the last', () => {
    const done = gladiator(4, { isEnded: true, activity: 'done', endedAt: NOW - 60_000 })
    const four = [emperor, gladiator(0), gladiator(1), gladiator(2), gladiator(3), done]
    const layout = layoutArena(four, 112)
    type Shot = { columns: number; cells: number[][] }
    const frame = (now: number): Shot => {
      const f = officeRaster(four, {}, { ...options, now })
      return { columns: f?.columns ?? 0, cells: decode(f?.cells ?? '') }
    }
    const region = (shot: Shot, col0: number, row0: number, w: number, h: number): string => {
      const out: string[] = []
      for (let r = row0; r < row0 + h; r += 1) for (let c = col0; c < col0 + w; c += 1) out.push((shot.cells[r * shot.columns + c] ?? []).join(','))
      return out.join('|')
    }
    const a = frame(NOW)
    const b = frame(NOW + 500)
    expect(layout?.arena).toBe(true)
    // The stands (the top 9 rows) wave between the first and third frame, and not between the first and second.
    expect(region(a, 0, 0, 224, 9)).not.toBe(region(b, 0, 0, 224, 9))
    expect(region(a, 0, 0, 224, 9)).toBe(region(frame(NOW + 250), 0, 0, 224, 9))
    // The sidelines (below the sand) sway on the same beat.
    const side = layout?.loungeY ?? 0
    expect(region(a, 0, side + 3, 40, 14)).not.toBe(region(b, 0, side + 3, 40, 14))
    // Pair 0 stands ready at frame 0 while pair 1 winds up: only pair 1 shows a slash's glow yet.
    const glow = (f: Shot, stand: { x: number; y: number }): boolean =>
      region(f, stand.x * 2, stand.y - 1, 40, 12).includes(String(0xffec96))
    const lefts = (layout?.stands ?? []).filter(stand => stand.side === 'left')
    expect(lefts).toHaveLength(2)
    expect(glow(a, lefts[0] ?? { x: 0, y: 0 })).toBe(false)
    expect(glow(a, lefts[1] ?? { x: 0, y: 0 })).toBe(true)
  })

  test('a mark sits beside its fighter\'s head: to the right for the left one of a pair, to the left for the right one', () => {
    const waiting = (i: number): Member => gladiator(i, { activity: 'waiting-you' })
    for (const [members, side] of [[[emperor, waiting(0), gladiator(1)], 'left'], [[emperor, gladiator(0), waiting(1)], 'right']] as const) {
      const layout = layoutArena([...members], 112)
      const stand = (layout?.stands ?? []).find(one => one.side === side)
      expect(stand).toBeDefined()
      const frame = officeRaster([...members], {}, options)
      const cells = decode(frame?.cells ?? '')
      const col = (stand?.x ?? 0) * 2 + (side === 'right' ? -6 : 16) + 3
      const row = Math.floor(((stand?.y ?? 0) * 2 - 4 + 2) / 2)
      expect(cells[row * (frame?.columns ?? 0) + col]?.[0]).toBe(0x21)
    }
  })

  test('a gladiator at rest does not fight, and the fight stops when the motion is off', () => {
    const resting = [emperor, gladiator(0, { activity: 'idle' }), gladiator(1, { activity: 'idle' })]
    // Nothing at work in the sand: only the crowd, the torches and the judges move, and with none of them the sand holds still.
    const sandOnly = (now: number): string => cellsAt(resting, now, { motion: true })
    expect(sandOnly(NOW)).toBe(sandOnly(NOW + 1000))
    expect(cellsAt(team, NOW, { motion: false })).toBe(cellsAt(team, NOW + 250, { motion: false }))
  })

  test('a judge at work bangs a gavel, writes or shows a card; one on a break does not', () => {
    const at = (j: Member, frame: number): string => cellsAt([emperor, j], NOW + frame * 250)
    for (const variant of [0, 1, 2]) {
      const working = judge(variant, { activity: 'reading' })
      expect(at(working, 0)).not.toBe(at(working, 1))
      expect(at(working, 0)).not.toBe(at(working, 2))
    }
    // The crowd waves every other half second, so compare two frames inside one wave. A judge on a break does nothing.
    const resting = judge(0, { activity: 'idle' })
    expect(at(resting, 0)).toBe(at(resting, 1))
  })

  test('the sidelines hold the finished, who sway; the stands hold the rest', () => {
    const done = (i: number, activity: Member['activity'] = 'done'): Member => gladiator(i, { isEnded: true, activity, endedAt: NOW - 60_000 })
    const mixed = [emperor, gladiator(0), done(4), done(5, 'failed')]
    expect(colors(mixed).has(0xfff3a3)).toBe(true)
    expect(colors(mixed).has(0xc81e28)).toBe(true)
    const layout = layoutOffice(mixed, 56)
    expect(layout?.arena).toBeUndefined()
    // The finished sway: one pixel down on the other half beat.
    expect(cellsAt([emperor, done(4)], NOW)).not.toBe(cellsAt([emperor, done(4)], NOW + 500))
  })

  test('the gate: a newcomer walks in from the wall, and the same room with no one walking is still', () => {
    const settled = cellsAt([emperor, gladiator(0, { startedAt: NOW - 60_000 })], NOW)
    const arriving = cellsAt([emperor, gladiator(0, { startedAt: NOW - 500 })], NOW)
    const arrived = cellsAt([emperor, gladiator(0, { startedAt: NOW - WALK_MS - 10 })], NOW)
    expect(arriving).not.toBe(settled)
    expect(arrived).toBe(settled)
  })

  test('as an SVG: the crowd, the fighters and the judges loop on their own, labels and tooltips stay, and the biggest gauntlet fits', () => {
    const svg = officeSvg(team, { hard: 5 }, { columns: 112, now: NOW, labels: true, motion: true, arena: true }) ?? ''
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('>Glad A</text>')
    expect(svg).toContain('<title>')
    expect(svg).toContain('values="1;0;0;0"')
    expect(svg).toContain('dur="1.00s"')
    const still = officeSvg(team, {}, { columns: 112, now: NOW, labels: true, motion: false, arena: true }) ?? ''
    expect(still).not.toContain('<animate')
    const letters = Array.from({ length: 8 }, (_, i) => gladiator(i))
    const judges = Array.from({ length: 8 }, (_, i) => judge(i, { label: `Judge ${i}` }))
    const big = officeSvg([emperor, ...judges, ...letters], {}, { columns: 112, now: NOW, labels: true, motion: true, arena: true })
    expect(big).toBeDefined()
    expect((big ?? '').length).toBeLessThanOrEqual(SVG_LIMIT)
    expect(officeAlt(team, true).startsWith('Colosseum: ')).toBe(true)
    expect(officeAlt(team, false).startsWith('Office: ')).toBe(true)
  })

  test('the narrowest room still draws it, and a name tag keeps its letter', () => {
    const frame = officeRaster(team, {}, { ...options, columns: MIN_OFFICE_COLUMNS * 2 })
    expect(frame).toBeDefined()
    expect(frame?.columns).toBe(MIN_OFFICE_COLUMNS * 2)
    expect(decode(frame?.cells ?? '')).toHaveLength((frame?.columns ?? 0) * (frame?.rows ?? 0))
    expect(officeRaster(team, {}, { ...options, columns: MIN_OFFICE_COLUMNS * 2 - 1 })).toBeUndefined()
  })
})

describe('the building (the other sessions)', () => {
  const options = { columns: 112, now: NOW, motion: true }
  const floor = (fields: Partial<BuildingFloor> & Pick<BuildingFloor, 'id'>): BuildingFloor => ({
    index: 1,
    name: fields.id,
    tone: 'working',
    status: 'Explore reading',
    tool: 'Grep',
    time: '2m 10s',
    isOpen: false,
    members: [LEAD, member({ id: 'a1', label: 'Explore', role: 'explore', activity: 'reading' })],
    ...fields,
  })
  const busy = floor({
    id: 'token-usage-mod',
    count: '2 at work',
    members: [LEAD, member({ id: 'a1', label: 'Explore', role: 'explore', activity: 'reading' }), member({ id: 'a2', label: 'Builder', role: 'builder', activity: 'typing', seat: 2 })],
  })
  const idle = floor({ id: 'claude', index: 2, tag: '#7f1a', tone: 'idle', status: 'idle', tool: undefined, time: '2m', members: [{ ...LEAD, activity: 'idle' }] })
  const cellText = (cells: number[][]): string => cells.map(([point]) => String.fromCodePoint(point ?? 32)).join('')

  test('in the terminal: roof, a storey of four rows per floor, a lobby; a label of chip, name, status, tool, time and count', () => {
    const frame = buildingRaster([busy, idle], options)
    expect(frame?.rows).toBe(16)
    const cells = decode(frame?.cells ?? '')
    expect(cells).toHaveLength((frame?.columns ?? 0) * (frame?.rows ?? 0))
    const columns = frame?.columns ?? 0
    const row = (r: number): string => cellText(cells.slice(r * columns, (r + 1) * columns))
    // Storey 1 is rows 4-7: the chip and name on row 5, the status on row 6, each beside the building.
    expect(row(5).slice(BUILDING_W)).toMatch(/^ +1 +token-usage-mod +2 at work$/)
    expect(row(6).slice(BUILDING_W)).toMatch(/^ +Explore reading Grep +2m 10s$/)
    expect(row(9).slice(BUILDING_W)).toMatch(/^ +2 +claude #7f1a *$/)
    // The chip is filled with the floor's color: working is brand orange.
    const chip = cells[5 * columns + BUILDING_W + 3]
    expect(chip?.[2]).toBe(0xf47521)
    // The sign on the roof counts the floors.
    expect(row(1)).toContain('2 FLOORS')
    expect(buildingRaster([busy, idle], { ...options, now: NOW + 750 })?.cells).not.toBe(frame?.cells)
    expect(buildingRaster([idle], { ...options, now: NOW + 750 })?.cells).toBe(buildingRaster([idle], options)?.cells)
    expect(buildingRaster([], options)).toBeUndefined()
    expect(buildingRaster([busy], { ...options, columns: 30 })).toBeUndefined()
    // An open floor says so beside its name.
    expect(cellText(decode(buildingRaster([{ ...busy, isOpen: true }], options)?.cells ?? ''))).toContain('token-usage-mod open')
  })

  test('as an SVG: windows flicker each on its own beat, nothing timed from now, still when all are idle, labels set in type', () => {
    const markup = buildingSvg([busy, idle], options) ?? ''
    expect(markup.startsWith('<svg')).toBe(true)
    expect(markup).not.toContain('animateTransform')
    expect(buildingSvg([busy, idle], { ...options, now: NOW + 12_345 })).toBe(markup)
    // Two windows at work keep two different beats.
    const beats = new Set([...markup.matchAll(/dur="([\d.]+s)" begin="-([\d.]+s)"/g)].map(found => `${found[1]}@${found[2]}`))
    expect(beats.size).toBeGreaterThan(1)
    expect(buildingSvg([idle], options)).not.toContain('<animate')
    // The label: a chip with the number, the name in a sans face, the tag, a status dot, the tool in mono, the time.
    expect(markup).toContain('>token-usage-mod<')
    expect(markup).toContain('font-family="-apple-system')
    expect(markup).toContain('>#7f1a</tspan>')
    expect(markup).toMatch(/<circle [^>]*fill="#ffcf70"/)
    expect(markup).toContain('>Grep</tspan>')
    expect(markup).toContain('tabular-nums')
    expect(markup).toContain('>2 FLOORS')
    expect(markup).toContain('shape-rendering="geometricPrecision"')
    const six = Array.from({ length: 6 }, (_, i) =>
      floor({ id: `s${i}`, index: i + 1, members: [LEAD, ...Array.from({ length: WINDOWS - 1 }, (_, k) => member({ id: `m${k}`, seat: k + 1 }))] }),
    )
    expect((buildingSvg(six, options) ?? '').length).toBeLessThan(60_000)
    expect(isBuildingMoving([idle])).toBe(false)
    expect(isBuildingMoving([idle, busy])).toBe(true)
    expect(buildingAlt([busy, idle])).toBe('Building: 1 token-usage-mod, Explore reading, Grep, 2m 10s, 2 at work; 2 claude #7f1a, idle, 2m')
    expect(floorAlt('mod-dock', [LEAD])).toBe('Floor mod-dock, open: Lead: thinking')
  })

  test('in the terminal too, two windows at work flicker on their own beats, not in step', () => {
    const frames = Array.from({ length: 12 }, (_, k) => decode(buildingRaster([busy], { ...options, now: NOW + k * 250 })?.cells ?? ''))
    const columns = buildingRaster([busy], options)?.columns ?? 0
    // Window i sits at x 3 + 7i, rows 5-6 of storey 1 (cells of rows 5 and 6): its cells, frame by frame.
    const windowAt = (cells: number[][], i: number): string =>
      [5, 6].map(r => cells.slice(r * columns + 3 + i * 7, r * columns + 8 + i * 7).map(cell => cell.join(',')).join(';')).join('|')
    const flips = (i: number): string => frames.map((cells, k) => (k > 0 && windowAt(cells, i) !== windowAt(frames[k - 1] ?? [], i) ? '1' : '0')).join('')
    expect(flips(1)).toContain('1')
    expect(flips(2)).toContain('1')
    expect(flips(1)).not.toBe(flips(2))
  })

  test('the Lead\'s window is lit cream, so its orange hair shows', () => {
    const cells = decode(buildingRaster([floor({ id: 'l', members: [LEAD] })], options)?.cells ?? '')
    const colors = new Set(cells.flatMap(([, fg, bg]) => [fg, bg]))
    expect(colors.has(0xffe7c2) || colors.has(0xfff4e0)).toBe(true)
    expect(colors.has(0xf47521)).toBe(true)
  })

  test('someone waiting on you blinks red and fast; the waiting tone is one red everywhere', () => {
    const waiting = floor({ id: 'w', tone: 'waiting', status: 'Builder waiting on you', members: [LEAD, member({ id: 'b1', activity: 'waiting-you' })] })
    const red = (cells: number[][]): boolean => cells.some(([, fg, bg]) => fg === 0xff5c5c || bg === 0xff5c5c)
    const lit = [0, 250, 500, 750].map(at => red(decode(buildingRaster([waiting], { ...options, now: NOW + at })?.cells ?? '').filter((_, i) => i % 112 < BUILDING_W)))
    expect(lit.includes(true) && lit.includes(false)).toBe(true)
    expect(TONE_COLORS.waiting.dot).toBe(TONE_COLORS.waiting.chip)
    expect(windowPeriod(member({ id: 'b1', activity: 'waiting-you' }), 0, 0)).toBeLessThan(windowPeriod(member({ id: 'b2', activity: 'thinking' }), 0, 0))
  })

  test('an office with walks off walks no one, even a newcomer', () => {
    const newcomer = member({ id: 'n1', label: 'New', startedAt: NOW - 500 })
    const walking = officeSvg([LEAD, newcomer], {}, { columns: 100, now: NOW, labels: true, motion: true }) ?? ''
    expect(walking).toContain('animateTransform')
    const still = officeSvg([LEAD, newcomer], {}, { columns: 100, now: NOW, labels: true, motion: true, walks: false }) ?? ''
    expect(still).not.toContain('animateTransform')
  })
})
