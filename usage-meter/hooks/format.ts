// Text helpers. They turn numbers into the short strings the views draw.

export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/** 950 is `950`, 4200 is `4.2k`, 41000 is `41k`, 3900000 is `3.9M`. */
export function fmtTokens(count: number): string {
  if (count < 1000) return `${Math.round(count)}`
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`

  return `${(count / 1_000_000).toFixed(1)}M`
}

/** `$0.31`, `$3.42`, `<$0.01`, `$120`. */
export function fmtUsd(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  if (usd < 100) return `$${usd.toFixed(2)}`

  return `$${Math.round(usd)}`
}

/** A whole percentage, `41%`. */
export const fmtPct = (pct: number): string => `${Math.round(pct)}%`

/** `0.912` is `91%`. */
export const fmtRate = (rate: number): string => `${Math.round(rate * 100)}%`

const two = (n: number): string => (n < 10 ? `0${n}` : `${n}`)

/** The local time of day for a time in ms: `16:40`. */
export function fmtClock(ms: number): string {
  const at = new Date(ms)

  return `${two(at.getHours())}:${two(at.getMinutes())}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * When a window resets: the time of day when it is within a day of `now`,
 * else the weekday and the time.
 */
export function fmtReset(ms: number, now: number): string {
  if (ms - now < 86_400_000) return fmtClock(ms)

  return `${DAYS[new Date(ms).getDay()]} ${fmtClock(ms)}`
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const

/**
 * A bar `width` cells long, filled to `pct` (held to 0 to 100) in eighths of a cell:
 * the fill (`████▌`) and the empty track (`░░░░░`). Any reading above 0 shows a sliver.
 */
export function barParts(pct: number, width: number): { fill: string; track: string } {
  const cells = Math.max(0, Math.floor(width))
  const held = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0
  const eighths = Math.round((held / 100) * cells * 8)
  const full = Math.floor(eighths / 8)
  const part = held > 0 && eighths === 0 && cells > 0 ? 1 : eighths % 8
  const used = full + (part > 0 ? 1 : 0)

  return { fill: `${'█'.repeat(full)}${EIGHTHS[part] ?? ''}`, track: '░'.repeat(Math.max(0, cells - used)) }
}

/** Splits text into lines of at most `width` cells at spaces; a word longer than a line is cut. */
export function wrapWords(text: string, width: number): string[] {
  const room = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(part => part !== '')) {
    let rest = word
    while (rest.length > room) {
      if (current !== '') {
        lines.push(current)
        current = ''
      }
      lines.push(rest.slice(0, room))
      rest = rest.slice(room)
    }
    if (current === '') current = rest
    else if (current.length + 1 + rest.length <= room) current = `${current} ${rest}`
    else {
      lines.push(current)
      current = rest
    }
  }
  if (current !== '') lines.push(current)

  return lines
}

const MODEL_ID = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?$/

/** `claude-sonnet-5-5` is `sonnet-5.5`; an id the pattern does not know loses `claude-` only. */
export function shortModel(key: string): string {
  const parts = MODEL_ID.exec(key)
  if (parts === null) return key.replace(/^claude-/, '')
  const [, family, major, minor] = parts

  return minor === undefined ? `${family}-${major}` : `${family}-${major}.${minor}`
}

/** The label of a rate-limit window. */
export function windowName(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  if (kind === 'spend_limit') return 'spend'

  return kind
}

export const pad = (text: string, width: number): string => text.padEnd(width, ' ')
export const padLeft = (text: string, width: number): string => text.padStart(width, ' ')
