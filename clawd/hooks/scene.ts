// Clawd's scenes: a 40x18 pixel grid drawn at 3x as one SVG. Each pixel run is a <rect>; the motion
// is CSS keyframes in the SVG's own <style>, so the band never redraws to animate. A transform from
// CSS replaces a transform attribute, so a group placed by `transform="..."` never carries an
// animation itself: `at()` places, `anim()` moves, always as two nested groups. Pure code: no `$`.

import type { Scene } from '../types'

export type { Scene }

export const SCENES: readonly Scene[] = [
  'idle',
  'relax',
  'done',
  'working',
  'read',
  'terminal',
  'write',
  'web',
  'waiting',
  'delegate',
]

export const GRID_W = 40
export const GRID_H = 18
export const SCALE = 3
export const SCENE_WIDTH = GRID_W * SCALE
export const SCENE_HEIGHT = GRID_H * SCALE

/** How long the "done" party shows before Clawd relaxes. */
export const DONE_MS = 6_500

const PAL: Readonly<Record<string, string>> = {
  o: '#d97757', // Clawd orange
  O: '#b65a3c', // orange shade
  e: '#1a1a1a', // eyes
  k: '#141414', // screen
  L: '#7d838c', // metal
  l: '#c3c7cf', // light metal
  g: '#8a8a8a', // gray
  P: '#efe8d6', // paper
  w: '#f4efe4', // white
  n: '#5fbf6a', // green
  N: '#2f7d3a', // dark green
  c: '#7fd6e8', // cyan
  y: '#f7dc6f', // yellow
  r: '#e5534b', // red
  p: '#f08fb0', // pink
  u: '#5a8fe6', // blue
  U: '#2d4f9e', // dark blue
  v: '#9b6be0', // violet
  b: '#8a5a2b', // wood
  B: '#5b3a1c', // dark wood
}

const fill = (c: string): string => PAL[c] ?? c

function rect(x: number, y: number, w: number, h: number, c: string): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill(c)}"/>`
}

/** An ASCII sprite: one character a pixel, '.' clear; each run of one color is one rect. */
function spr(rows: readonly string[], x = 0, y = 0): string {
  let out = ''
  rows.forEach((row, j) => {
    let i = 0
    while (i < row.length) {
      const c = row[i] ?? '.'
      if (c === '.') {
        i += 1
        continue
      }
      let k = i
      while (k < row.length && row[k] === c) k += 1
      out += rect(x + i, y + j, k - i, 1, c)
      i = k
    }
  })

  return out
}

/** Places `inner` at (x, y). */
function at(x: number, y: number, inner: string): string {
  return `<g transform="translate(${x} ${y})">${inner}</g>`
}

/** Moves `inner` by a CSS animation shorthand; `origin` is where a scale grows from. */
function anim(shorthand: string, inner: string, origin?: readonly [number, number]): string {
  const from = origin === undefined ? '' : `;transform-origin:${origin[0]}px ${origin[1]}px`

  return `<g style="animation:${shorthand}${from}">${inner}</g>`
}

// Every track the scenes name. Most run `step-end`, so each keyframe is a whole-pixel jump.
const KEYFRAMES: Readonly<Record<string, string>> = {
  bob: '0%{transform:translate(0,0)}50%{transform:translate(0,-1px)}',
  hop: '0%{transform:translate(0,0)}20%{transform:translate(0,-2px)}40%{transform:translate(0,-3px)}60%{transform:translate(0,-2px)}80%{transform:translate(0,0)}',
  blink: '0%{opacity:1}92%{opacity:0}96%{opacity:1}',
  look: '0%{transform:translate(0,0)}40%{transform:translate(-1px,0)}55%{transform:translate(1px,0)}70%{transform:translate(0,0)}',
  scan: '0%{transform:translate(-1px,0)}50%{transform:translate(1px,0)}',
  wave: '0%{transform:translate(0,0)}50%{transform:translate(0,-2px)}',
  on: '0%{opacity:1}50%{opacity:0}',
  off: '0%{opacity:0}50%{opacity:1}',
  vis3: '0%{opacity:1}33.33%{opacity:0}',
  rise: '0%{transform:translate(0,0);opacity:0}15%{opacity:1}100%{transform:translate(1px,-6px);opacity:0}',
  fall: '0%{transform:translate(0,-3px)}100%{transform:translate(1px,21px)}',
  grow: '0%{transform:scale(0,1)}75%{transform:scale(1,1)}100%{transform:scale(1,1)}',
  scroll: '0%{transform:translate(0,0)}100%{transform:translate(0,-8px)}',
  pencil: '0%{transform:translate(0,0)}25%{transform:translate(2px,0)}50%{transform:translate(4px,1px)}75%{transform:translate(6px,1px)}',
  page: '0%{transform:scale(1,1)}60%{transform:scale(1,1)}70%{transform:scale(0.5,1)}80%{transform:scale(-0.5,1)}90%{transform:scale(-1,1)}',
  send: '0%{transform:translate(0,0);opacity:0}10%{opacity:1}80%{opacity:1}100%{transform:translate(-14px,0);opacity:0}',
  tap: '0%{transform:translate(0,0)}50%{transform:translate(0,-1px)}',
  dance: '0%{transform:translate(0,0)}25%{transform:translate(-1px,-2px)}50%{transform:translate(0,0)}75%{transform:translate(1px,-2px)}',
}

const STYLE =
  `<style>g{animation-fill-mode:both}` +
  Object.entries(KEYFRAMES)
    .map(([name, body]) => `@keyframes ${name}{${body}}`)
    .join('') +
  `@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>`

// ---------- Clawd ----------

type Eyes = 'normal' | 'look' | 'scan' | 'down' | 'focus' | 'happy' | 'shades' | 'closed'

type ClawdOpts = {
  eyes?: Eyes
  /** The whole body's animation. */
  move?: string
  armL?: string
  armR?: string
  armLUp?: boolean
  armRUp?: boolean
  sit?: boolean
  /** Legs step in turn (typing, tapping a foot). */
  legs?: 'still' | 'walk' | 'tap'
}

function eyes(kind: Eyes): string {
  const pair = rect(4, 1, 1, 2, 'e') + rect(11, 1, 1, 2, 'e')
  switch (kind) {
    case 'normal':
      return anim('blink 4s step-end infinite', pair)
    case 'look':
      return anim('look 7s step-end infinite', anim('blink 4s step-end infinite', pair))
    case 'scan':
      return anim('scan .8s step-end infinite', pair)
    case 'down':
      return rect(4, 2, 1, 2, 'e') + rect(11, 2, 1, 2, 'e')
    case 'focus':
      return rect(3, 2, 2, 1, 'e') + rect(10, 2, 2, 1, 'e') + rect(3, 1, 2, 1, 'O') + rect(10, 1, 2, 1, 'O')
    case 'happy':
      return spr(['.e.', 'e.e'], 3, 1) + spr(['.e.', 'e.e'], 10, 1)
    case 'closed':
      return rect(3, 2, 2, 1, 'e') + rect(10, 2, 2, 1, 'e')
    case 'shades':
      return spr(['kkkkk.kkkkk', 'kkkkkkkkkkk', '.kkk...kkk.'], 2, 1) + rect(3, 1, 1, 1, 'w') + rect(9, 1, 1, 1, 'w')
  }
}

/** Clawd, 16x8: a 12x6 body, a 2x2 arm on each side, four 1x2 legs. */
function clawd(x: number, y: number, o: ClawdOpts = {}): string {
  const body = rect(2, 0, 12, 6, 'o') + rect(2, 5, 12, 1, 'O')
  const left = o.armLUp ? rect(0, 0, 2, 2, 'o') + rect(1, 2, 1, 1, 'o') : rect(0, 2, 2, 2, 'o')
  const right = o.armRUp ? rect(14, 0, 2, 2, 'o') + rect(14, 2, 1, 1, 'o') : rect(14, 2, 2, 2, 'o')
  const armL = o.armL === undefined ? left : anim(o.armL, left)
  const armR = o.armR === undefined ? right : anim(o.armR, right)
  let legs = ''
  if (!o.sit) {
    const outer = rect(3, 6, 1, 2, 'o') + rect(12, 6, 1, 2, 'o')
    const inner = rect(5, 6, 1, 2, 'o') + rect(10, 6, 1, 2, 'o')
    if (o.legs === 'walk') {
      legs = anim('bob .3s step-end infinite', outer) + anim('bob .3s step-end infinite -.15s', inner)
    } else if (o.legs === 'tap') {
      legs = outer + rect(5, 6, 1, 2, 'o') + anim('tap .5s step-end infinite', rect(10, 6, 1, 2, 'o'))
    } else {
      legs = outer + inner
    }
  }
  const whole = legs + body + armL + armR + eyes(o.eyes ?? 'normal')

  return at(x, y, o.move === undefined ? whole : anim(o.move, whole))
}

const SPARK = ['.y.', 'yyy', '.y.']
const sparkle = (x: number, y: number, delay: number): string =>
  at(x, y, anim(`on 1.6s step-end infinite ${-delay}s`, spr(SPARK)))

// ---------- the scenes; Clawd stands at (22, 10), props to his left ----------

function idle(): string {
  const plant = spr(['.n.n.', 'nNnNn', '.nNn.', '..N..', 'bbbbb', '.bbb.', '.bbb.'], 9, 10)

  return plant + sparkle(4, 3, 0) + sparkle(15, 6, 0.8) + clawd(22, 10, { eyes: 'look', move: 'bob 2.4s step-end infinite' })
}

function relax(): string {
  const chair = spr(['B..........B', 'bbbbbbbbbbbb', 'b..........b'], 21, 15)
  const mug = spr(['PPPP.', 'PrrPP', 'PPPP.', 'PPPP.'], 14, 13)
  const steam = [0, 1.2].map((d, i) => at(15 + i * 2, 11, anim(`rise 2.4s steps(6) infinite ${-d}s`, spr(['g', 'g'])))).join('')

  return chair + mug + steam + clawd(22, 9, { eyes: 'shades', sit: true, move: 'bob 3s step-end infinite' })
}

function done(): string {
  const colors = ['r', 'y', 'c', 'n', 'p', 'v', 'u']
  let confetti = ''
  for (let i = 0; i < 14; i++) {
    const x = 1 + ((i * 11) % 38)
    const dur = (1.4 + ((i * 7) % 5) * 0.2).toFixed(1)
    const delay = (((i * 13) % 10) / 10).toFixed(1)
    const c = colors[i % colors.length] ?? 'y'
    confetti += at(x, 0, anim(`fall ${dur}s steps(12) infinite -${delay}s`, i % 2 ? rect(0, 0, 1, 2, c) : rect(0, 0, 2, 1, c)))
  }
  const mood = clawd(22, 10, {
    eyes: 'happy',
    armLUp: true,
    armRUp: true,
    armL: 'wave .3s step-end infinite',
    armR: 'wave .3s step-end infinite -.15s',
    legs: 'walk',
    move: 'dance 1.2s step-end infinite',
  })

  return confetti + sparkle(6, 8, 0) + sparkle(16, 4, 0.5) + mood
}

function typingClawd(eyesKind: Eyes): string {
  return clawd(22, 10, {
    eyes: eyesKind,
    move: 'bob .6s step-end infinite',
    armL: 'bob .3s step-end infinite',
    armR: 'bob .3s step-end infinite -.15s',
  })
}

function working(): string {
  const lines = [5, 8, 4, 7]
    .map((w, i) => anim(`grow 1.6s steps(${w}) infinite ${-i * 0.4}s`, rect(7, 9 + i, w, 1, i % 2 ? 'c' : 'n'), [7, 9 + i]))
    .join('')
  const laptop = rect(5, 8, 14, 6, 'L') + rect(6, 9, 12, 4, 'k') + lines + rect(3, 14, 18, 1, 'l') + rect(4, 15, 16, 1, 'L')

  return laptop + typingClawd('focus')
}

function read(): string {
  const book = spr(['UPPPPUPPPPU', 'UPgggUPgggU', 'UPPPPUPPPPU', 'UPgggUPggPU', 'UUUUUUUUUUU'], 9, 12)
  // The right page turns over the spine (x 14): it scales about its own left edge.
  const page = anim('page 3s step-end infinite', spr(['PPPP', 'PggP', 'PPPP', 'PgPP']), [0, 0])

  return book + at(15, 12, page) + clawd(22, 10, { eyes: 'down', move: 'bob 3s step-end infinite' })
}

function terminal(): string {
  const monitor = rect(2, 4, 17, 10, 'L') + rect(3, 5, 15, 8, 'k') + rect(9, 14, 3, 1, 'L') + rect(7, 15, 7, 1, 'L')
  const widths = [6, 9, 4, 11, 7, 5, 10, 3]
  const rows = widths.map((w, i) => rect(4, 6 + i * 2, w, 1, i % 3 ? 'n' : 'g')).join('')
  const scrolled = `<g clip-path="url(#screen)">${anim('scroll 2.4s steps(4) infinite', rows + rows.replace(/y="(\d+)"/g, (_m, v: string) => `y="${Number(v) + 16}"`))}</g>`
  const clip = `<clipPath id="screen"><rect x="3" y="5" width="15" height="8"/></clipPath>`
  const cursor = anim('on .8s step-end infinite', rect(16, 11, 1, 1, 'n'))

  return clip + monitor + scrolled + cursor + typingClawd('focus')
}

function write(): string {
  const paper = rect(5, 9, 12, 8, 'P')
  const lines = [8, 6, 9]
    .map((w, i) => anim(`grow 3s steps(${w}) infinite ${-i}s`, rect(7, 11 + i * 2, w, 1, 'g'), [7, 11 + i * 2]))
    .join('')
  const pencil = at(7, 6, anim('pencil 1.2s step-end infinite', spr(['..y', '.yy', 'yy.', 'b..'])))

  return paper + lines + pencil + clawd(22, 10, { eyes: 'down', armL: 'bob .3s step-end infinite' })
}

function web(): string {
  const frames = [
    ['..uuuuu..', '.unnuuuu.', 'unnnuuuuu', 'uunuuunnu', 'uuuuunnnu', 'uuuuuunuu', 'uunuuuuuu', '.unnuuuu.', '..uuuuu..'],
    ['..uuuuu..', '.uunnuuu.', 'uuunnnuuu', 'uuuunuuun', 'nuuuuunnn', 'uuuuuuunu', 'uuunuuuuu', '.uuunnuu.', '..uuuuu..'],
    ['..uuuuu..', '.uuuunnu.', 'uuuuunnnu', 'nuuuuunuu', 'nnuuuuuun', 'nuuuuuuuu', 'uuuuunuuu', '.uuuuunn.', '..uuuuu..'],
  ]
  const globe = frames.map((rows, i) => anim(`vis3 1.8s step-end infinite ${-i * 0.6}s`, spr(rows))).join('')
  const stand = rect(10, 15, 3, 1, 'L') + rect(8, 16, 7, 1, 'L')

  return at(7, 5, globe) + stand + clawd(22, 10, { eyes: 'scan' })
}

function waiting(): string {
  const bubble = spr(['.wwwww.', 'wwwrwww', 'wwwrwww', 'wwwrwww', 'wwwwwww', 'wwwrwww', '.wwwww.', '....ww.', '.....w.'], 12, 0)

  return (
    anim('bob .5s step-end infinite', bubble) +
    clawd(22, 10, { armRUp: true, armR: 'wave .4s step-end infinite', legs: 'tap', eyes: 'normal' })
  )
}

function delegate(): string {
  const arrow = spr(['.y..', 'yyyy', '.y..'])
  const arrows = [0, 0.8, 1.6].map(d => at(17, 11, anim(`send 2.4s steps(14) infinite ${-d}s`, arrow))).join('')
  const clipboard = spr(['.ll.', 'bbbb', 'bPPb', 'bPgb', 'bPPb', 'bbbb'], 36, 10)

  return arrows + clawd(20, 10, { armLUp: true, armL: 'wave .6s step-end infinite', eyes: 'normal' }) + clipboard
}

const DRAW: Readonly<Record<Scene, () => string>> = {
  idle,
  relax,
  done,
  working,
  read,
  terminal,
  write,
  web,
  waiting,
  delegate,
}

/** What each scene says to a reader who cannot see it. */
export const ALT: Readonly<Record<Scene, string>> = {
  idle: 'Clawd is idle',
  relax: 'Clawd is relaxing with a drink',
  done: 'Clawd is celebrating a finished turn',
  working: 'Clawd is working on a laptop',
  read: 'Clawd is reading',
  terminal: 'Clawd is running commands at a terminal',
  write: 'Clawd is writing',
  web: 'Clawd is browsing the web',
  waiting: 'Clawd is waving: Claude needs you',
  delegate: 'Clawd is handing work to subagents',
}

const cache = new Map<Scene, string>()

/** The SVG of `scene`: the same string each time, so a redraw that keeps the scene keeps its image. */
export function sceneSvg(scene: Scene): string {
  const hit = cache.get(scene)
  if (hit !== undefined) return hit
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID_W} ${GRID_H}" width="${SCENE_WIDTH}" height="${SCENE_HEIGHT}" shape-rendering="crispEdges">` +
    `${STYLE}${DRAW[scene]()}</svg>`
  cache.set(scene, svg)

  return svg
}
