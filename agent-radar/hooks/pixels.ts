// A small pixel canvas and its two encodings: terminal `Raster` cells (two pixels per cell, drawn as
// upper half blocks) and SVG paths (one path per color). Pure code: no `$`, so the tests reach it.

/** A grid of palette indexes, row-major. Index 0 is "nothing drawn here". */
export type Canvas = {
  readonly width: number
  readonly height: number
  readonly px: Uint16Array
  readonly palette: string[]
  readonly lookup: Map<string, number>
}

/** What `Raster` takes: `columns * rows` cells packed per `RasterProps`. */
export type RasterFrame = { columns: number; rows: number; cells: string }

/** Text written over the cells after the pixels: name tags and speech bubbles. */
export type Overlay = { col: number; row: number; text: string; fg: string; bg?: string }

/** `0x01000000`: the terminal's own default color, per `RasterProps`. */
const DEFAULT_COLOR = 0x01000000
const UPPER_HALF = 0x2580
const SPACE = 0x20
/** A room full of people has far more than 256 colors; a PNG sprite has few (see `pngBase64`). */
const MAX_COLORS = 65535

export function createCanvas(width: number, height: number, background?: string): Canvas {
  const canvas: Canvas = {
    width,
    height,
    px: new Uint16Array(Math.max(0, width * height)),
    palette: [''],
    lookup: new Map(),
  }
  if (background !== undefined) fillRect(canvas, 0, 0, width, height, background)
  return canvas
}

/** The palette index of a color, added on first use. A full palette reuses its last color. */
export function colorIndex(canvas: Canvas, color: string): number {
  const known = canvas.lookup.get(color)
  if (known !== undefined) return known
  if (canvas.palette.length >= MAX_COLORS) return canvas.palette.length - 1
  canvas.palette.push(color)
  const index = canvas.palette.length - 1
  canvas.lookup.set(color, index)
  return index
}

export function setPixel(canvas: Canvas, x: number, y: number, color: string): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return
  canvas.px[y * canvas.width + x] = colorIndex(canvas, color)
}

export function fillRect(canvas: Canvas, x: number, y: number, w: number, h: number, color: string): void {
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(canvas.width, x + w)
  const y1 = Math.min(canvas.height, y + h)
  if (x1 <= x0 || y1 <= y0) return
  const index = colorIndex(canvas, color)
  for (let row = y0; row < y1; row += 1) canvas.px.fill(index, row * canvas.width + x0, row * canvas.width + x1)
}

/**
 * Draws a template: each character names a color in `colors`; `.` and unknown characters draw
 * nothing. Rows at or below `clipY` are skipped, so a body can sit behind a desk.
 */
export function drawSprite(
  canvas: Canvas,
  x: number,
  y: number,
  rows: readonly string[],
  colors: Readonly<Record<string, string>>,
  clipY = Number.POSITIVE_INFINITY,
): void {
  rows.forEach((line, dy) => {
    if (y + dy >= clipY) return
    for (let dx = 0; dx < line.length; dx += 1) {
      const color = colors[line[dx] ?? '.']
      if (color !== undefined) setPixel(canvas, x + dx, y + dy, color)
    }
  })
}

/** The canvas `k` times larger, each pixel a k by k block. */
export function upscale(canvas: Canvas, k: number): Canvas {
  const out = createCanvas(canvas.width * k, canvas.height * k)
  for (const color of canvas.palette.slice(1)) colorIndex(out, color)
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const index = canvas.px[y * canvas.width + x] ?? 0
      if (index === 0) continue
      for (let dy = 0; dy < k; dy += 1) out.px.fill(index, (y * k + dy) * out.width + x * k, (y * k + dy) * out.width + x * k + k)
    }
  }
  return out
}

/** The color at a pixel, or '' where nothing was drawn. */
export function colorAt(canvas: Canvas, x: number, y: number): string {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return ''
  return canvas.palette[canvas.px[y * canvas.width + x] ?? 0] ?? ''
}

/** `#rrggbb` as `0x00RRGGBB`; anything else is the terminal's default color. */
export function rgbOf(color: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  return match === null ? DEFAULT_COLOR : Number.parseInt(match[1] ?? '0', 16)
}

/** Mixes `color` toward `toward` by `amount` (0 keeps it, 1 is `toward`). Both `#rrggbb`. */
export function blend(color: string, toward: string, amount: number): string {
  const a = rgbOf(color)
  const b = rgbOf(toward)
  if (a === DEFAULT_COLOR || b === DEFAULT_COLOR) return color
  const mix = (shift: number): number => {
    const from = (a >> shift) & 0xff
    const to = (b >> shift) & 0xff
    return Math.round(from + (to - from) * Math.min(1, Math.max(0, amount)))
  }
  const value = (mix(16) << 16) | (mix(8) << 8) | mix(0)
  return `#${value.toString(16).padStart(6, '0')}`
}

/**
 * `color` with its hue turned by `degrees`, and lighter (positive `light`) or darker (negative) by
 * that share. A grey stays grey. Used to give a second agent of one role a sibling look.
 */
export function shiftHue(color: string, degrees: number, light = 0): string {
  const rgb = rgbOf(color)
  if (rgb === DEFAULT_COLOR) return color
  const r = ((rgb >> 16) & 0xff) / 255
  const g = ((rgb >> 8) & 0xff) / 255
  const b = (rgb & 0xff) / 255
  const top = Math.max(r, g, b)
  const bottom = Math.min(r, g, b)
  const l = (top + bottom) / 2
  const d = top - bottom
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    if (top === r) h = ((g - b) / d) % 6
    else if (top === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  const hue = (((h * 60 + degrees) % 360) + 360) % 360
  const lightness = Math.min(0.92, Math.max(0.08, l + light))
  const c = (1 - Math.abs(2 * lightness - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lightness - c / 2
  const [r1, g1, b1] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
  const part = (value: number): string =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${part(r1 ?? 0)}${part(g1 ?? 0)}${part(b1 ?? 0)}`
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64, with no dependence on what the runtime offers. */
export function base64(bytes: Uint8Array): string {
  const out: string[] = []
  const char = (n: number): string => BASE64[n & 63] ?? 'A'
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out.push(char(n >> 18) + char(n >> 12) + char(n >> 6) + char(n))
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    out.push(`${char(n >> 18)}${char(n >> 12)}==`)
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out.push(`${char(n >> 18)}${char(n >> 12)}${char(n >> 6)}=`)
  }
  return out.join('')
}

/** The few non-ASCII glyphs a cell may hold: one column wide in every terminal font. */
const WIDE_SAFE = new Set([0x2026, 0x2713, 0x00b7])

/** A character a Raster cell may hold: printable ASCII and a few safe symbols, else `?`. */
export function cellChar(ch: string): number {
  const point = ch.codePointAt(0) ?? SPACE
  if ((point >= 0x20 && point <= 0x7e) || WIDE_SAFE.has(point)) return point
  return 0x3f
}

/**
 * The canvas as terminal cells: each cell is two pixels, the upper one the glyph's foreground
 * and the lower one its background. Where nothing was drawn, `background` shows. Overlays are
 * then written as text, on the cell's own background unless they name one.
 */
export function toCells(canvas: Canvas, overlays: readonly Overlay[] = [], background = '#000000'): RasterFrame {
  const columns = canvas.width
  const rows = Math.ceil(canvas.height / 2)
  const view = new DataView(new ArrayBuffer(columns * rows * 12))
  const fallback = rgbOf(background)
  const colorOf = (x: number, y: number): number => {
    if (y >= canvas.height) return fallback
    const index = canvas.px[y * columns + x] ?? 0
    return index === 0 ? fallback : rgbOf(canvas.palette[index] ?? background)
  }
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const top = colorOf(col, row * 2)
      const bottom = colorOf(col, row * 2 + 1)
      const at = (row * columns + col) * 12
      view.setUint32(at, top === bottom ? SPACE : UPPER_HALF, true)
      view.setUint32(at + 4, top, true)
      view.setUint32(at + 8, bottom, true)
    }
  }
  for (const overlay of overlays) {
    if (overlay.row < 0 || overlay.row >= rows) continue
    let col = overlay.col
    for (const ch of overlay.text) {
      if (col >= 0 && col < columns) {
        const at = (overlay.row * columns + col) * 12
        const bg = overlay.bg === undefined ? view.getUint32(at + 8, true) : rgbOf(overlay.bg)
        view.setUint32(at, cellChar(ch), true)
        view.setUint32(at + 4, rgbOf(overlay.fg), true)
        view.setUint32(at + 8, bg, true)
      }
      col += 1
    }
  }
  return { columns, rows, cells: base64(new Uint8Array(view.buffer)) }
}

/** The canvas as SVG paths, one per color, each a row run `M x y h w v1 H x z`. */
export function svgPaths(canvas: Canvas): string {
  const runs = new Map<number, string[]>()
  for (let y = 0; y < canvas.height; y += 1) {
    let x = 0
    while (x < canvas.width) {
      const index = canvas.px[y * canvas.width + x] ?? 0
      if (index === 0) {
        x += 1
        continue
      }
      let end = x + 1
      while (end < canvas.width && canvas.px[y * canvas.width + end] === index) end += 1
      const list = runs.get(index) ?? []
      list.push(`M${x} ${y}h${end - x}v1H${x}z`)
      runs.set(index, list)
      x = end
    }
  }
  let out = ''
  for (const [index, list] of runs) out += `<path fill="${canvas.palette[index] ?? '#000000'}" d="${list.join('')}"/>`
  return out
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

/**
 * `data` as one zlib stream: a single deflate block with the fixed Huffman code, and matches found
 * through 3-byte hashes. Pixel art is runs and repeated rows, so it shrinks to a fifth or less.
 */
function zlibFixed(data: Uint8Array): number[] {
  const out: number[] = [0x78, 0x01]
  let bits = 0
  let count = 0
  const put = (value: number, n: number): void => {
    // Bits go in least significant first.
    for (let i = 0; i < n; i += 1) {
      bits |= ((value >> i) & 1) << count
      count += 1
      if (count === 8) {
        out.push(bits)
        bits = 0
        count = 0
      }
    }
  }
  const putCode = (code: number, n: number): void => {
    // Huffman codes go most significant first.
    for (let i = n - 1; i >= 0; i -= 1) put((code >> i) & 1, 1)
  }
  const putSymbol = (sym: number): void => {
    if (sym < 144) putCode(0x30 + sym, 8)
    else if (sym < 256) putCode(0x190 + sym - 144, 9)
    else if (sym < 280) putCode(sym - 256, 7)
    else putCode(0xc0 + sym - 280, 8)
  }
  put(1, 1)
  put(1, 2)
  const heads = new Map<number, number[]>()
  const keyAt = (i: number): number => ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0)
  let i = 0
  while (i < data.length) {
    let bestLength = 0
    let bestDistance = 0
    if (i + 2 < data.length) {
      const candidates = heads.get(keyAt(i)) ?? []
      for (let c = candidates.length - 1; c >= Math.max(0, candidates.length - 24); c -= 1) {
        const from = candidates[c] ?? 0
        if (i - from > 32768) break
        let length = 0
        while (length < 258 && i + length < data.length && data[from + length] === data[i + length]) length += 1
        if (length > bestLength) {
          bestLength = length
          bestDistance = i - from
          if (length === 258) break
        }
      }
    }
    const step = bestLength >= 3 ? bestLength : 1
    if (bestLength >= 3) {
      let code = LENGTH_BASE.length - 1
      while ((LENGTH_BASE[code] ?? 0) > bestLength) code -= 1
      putSymbol(257 + code)
      put(bestLength - (LENGTH_BASE[code] ?? 0), LENGTH_EXTRA[code] ?? 0)
      let slot = DISTANCE_BASE.length - 1
      while ((DISTANCE_BASE[slot] ?? 0) > bestDistance) slot -= 1
      putCode(slot, 5)
      put(bestDistance - (DISTANCE_BASE[slot] ?? 0), DISTANCE_EXTRA[slot] ?? 0)
    } else {
      putSymbol(data[i] ?? 0)
    }
    for (let k = 0; k < step; k += 1) {
      if (i + k + 2 < data.length) {
        const list = heads.get(keyAt(i + k)) ?? []
        list.push(i + k)
        heads.set(keyAt(i + k), list)
      }
    }
    i += step
  }
  putSymbol(256)
  if (count > 0) out.push(bits)
  let a = 1
  let b = 0
  for (const byte of data) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  out.push((b >> 8) & 0xff, b & 0xff, (a >> 8) & 0xff, a & 0xff)
  return out
}

/**
 * The canvas as a PNG, base64: indexed color, index 0 transparent, deflated. A sprite this way
 * costs a few hundred characters, where SVG paths cost thousands. At most 256 colors: a canvas
 * with more draws its extra colors as the last one.
 */
export function pngBase64(canvas: Canvas): string {
  const colors = Math.min(256, canvas.palette.length)
  const raw = new Uint8Array(canvas.height * (canvas.width + 1))
  for (let y = 0; y < canvas.height; y += 1) {
    raw[y * (canvas.width + 1)] = 0
    for (let x = 0; x < canvas.width; x += 1) raw[y * (canvas.width + 1) + 1 + x] = Math.min(255, canvas.px[y * canvas.width + x] ?? 0)
  }
  const chunk = (type: string, data: readonly number[]): number[] => {
    const body = new Uint8Array([...[...type].map(ch => ch.charCodeAt(0)), ...data])
    const crc = crc32(body)
    const n = data.length
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]
  }
  const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const plte: number[] = []
  for (let i = 0; i < colors; i += 1) {
    const rgb = i === 0 ? 0 : rgbOf(canvas.palette[i] ?? '#000000') & 0xffffff
    plte.push((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255)
  }
  const bytes = [
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', [...u32(canvas.width), ...u32(canvas.height), 8, 3, 0, 0, 0]),
    ...chunk('PLTE', plte),
    ...chunk('tRNS', [0]),
    ...chunk('IDAT', zlibFixed(raw)),
    ...chunk('IEND', []),
  ]
  return base64(new Uint8Array(bytes))
}

/** Text safe inside SVG markup. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, ch =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  )
}
