// context-keeper: the pure logic. No `$` here, so the tests call it directly.
//
// It reads numbers only: context tokens, the window and the auto-compact
// threshold. It never reads, keeps or returns message text.

import type { KeeperMode, KeeperNudge, KeeperSettings } from '../types'

/** The cheap gate of the nudge: below this share of the gate base, no breakdown is read. */
export const GATE = 0.3

/**
 * Where the handoff template lives now. Where an organization manages Claude
 * Code, the engine skips the `session.compact` and `prompt.*` hooks of a
 * plugin a person installs, so the template cannot ride a hook.
 */
export const TEMPLATE_NOTE =
  'Handoff template: not part of this mod. Where an organization manages Claude Code, the engine skips the compaction hooks of installed mods. Put the template in CLAUDE.md under "# Compact Instructions": every /compact and auto compaction follows it.'

// ---------------------------------------------------------------- settings

export type Options = {
  mode: KeeperMode
  nudgeAt: number
  nudgeAgainAt: number
}

const MODES: readonly KeeperMode[] = ['ask', 'off']

export function isMode(value: unknown): value is KeeperMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberIn(value: unknown, low: number, high: number, fallback: number): number {
  const n = finite(value)

  return n === undefined ? fallback : Math.min(high, Math.max(low, n))
}

/** The `userConfig` values, each checked, with the manifest's defaults where one is bad. */
export function optionsOf(raw: Readonly<Record<string, unknown>>): Options {
  const nudgeAt = numberIn(raw['nudgeAtPercent'], 1, 100, 60)

  return {
    mode: raw['mode'] === 'off' ? 'off' : 'ask',
    nudgeAt,
    nudgeAgainAt: Math.max(nudgeAt, numberIn(raw['nudgeAgainAtPercent'], 1, 100, 75)),
  }
}

export type Knobs = Options & { isModeSession: boolean }

/** The options with this session's /keeper setting on top. */
export function knobsOf(options: Options, settings: KeeperSettings): Knobs {
  return { ...options, mode: settings.mode ?? options.mode, isModeSession: settings.mode !== undefined }
}

// ---------------------------------------------------------------- state normalizers
// State can hold what an older version wrote: read every value through these.

export function settingsOf(value: unknown): KeeperSettings {
  if (typeof value !== 'object' || value === null) return {}
  const mode = (value as Record<string, unknown>)['mode']

  return isMode(mode) ? { mode } : {}
}

export function nudgeOf(value: unknown): KeeperNudge {
  if (typeof value !== 'object' || value === null) return { level: 0 }
  const raw = value as Record<string, unknown>
  const level = raw['level'] === 1 || raw['level'] === 2 ? raw['level'] : 0
  const point = finite(raw['lastPoint'])

  return point !== undefined && point > 0 ? { level, lastPoint: point } : { level }
}

// ---------------------------------------------------------------- the nudge

/** The compaction point from a usage reading: the auto-compact threshold, else the window. */
export function pointOf(context: { window?: number; breakdown?: { autoCompactThreshold?: number } } | undefined): number | undefined {
  const threshold = finite(context?.breakdown?.autoCompactThreshold)
  if (threshold !== undefined && threshold > 0) return threshold
  const window = finite(context?.window)

  return window !== undefined && window > 0 ? window : undefined
}

/** What the cheap gate divides by: the last known compaction point when it is below the window. */
export function gateBase(window: number, lastPoint: number | undefined): number {
  return lastPoint !== undefined && lastPoint > 0 && lastPoint < window ? lastPoint : window
}

/**
 * One step of the nudge. Below the first level it resets to 0, so the toasts
 * come back after a compaction. Past the second level it goes straight to 2,
 * so one reading never shows two toasts.
 */
export function nudgeStep(level: 0 | 1 | 2, fill: number, nudgeAt: number, nudgeAgainAt: number): { level: 0 | 1 | 2; fire: boolean } {
  if (fill < nudgeAt / 100) return { level: 0, fire: false }
  if (level < 2 && fill >= nudgeAgainAt / 100) return { level: 2, fire: true }
  if (level === 0) return { level: 1, fire: true }

  return { level, fire: false }
}

export function nudgeText(fill: number): string {
  return `context-keeper: context is at ${Math.round(fill * 100)}% of the compaction point. Run /compact at the end of this task, while the cache is warm.`
}

// ---------------------------------------------------------------- /keeper

export const USAGE = ['Usage:', '/keeper - status', '/keeper mode ask|off - the toast on or off, for this session'].join('\n')

export type KeeperCommand = { kind: 'status' } | { kind: 'mode'; mode: KeeperMode } | { kind: 'bad'; text: string }

export function parseKeeper(args: string): KeeperCommand {
  const all = (args ?? '').trim()
  if (all === '' || all === 'status') return { kind: 'status' }
  const word = all.split(/\s+/, 1)[0] ?? ''
  const rest = all.slice(word.length).trim()
  if (word !== 'mode') return { kind: 'bad', text: USAGE }

  return isMode(rest) ? { kind: 'mode', mode: rest } : { kind: 'bad', text: `Mode must be ask or off.\n\n${USAGE}` }
}

/** Whole numbers with thousands separators, with no Intl needed. */
export function fmt(value: number): string {
  const n = Math.round(value)
  const sign = n < 0 ? '-' : ''

  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export type StatusFacts = {
  knobs: Knobs
  tokens?: number
  point?: number
  isThreshold: boolean
  level: 0 | 1 | 2
}

const LEVEL_WORDS = ['no toast yet', 'the first toast showed', 'both toasts showed'] as const

export function statusText(facts: StatusFacts): string {
  const k = facts.knobs
  const from = k.isModeSession ? 'set for this session' : 'from settings'
  const what = k.mode === 'ask' ? `a toast asks you to run /compact at ${fmt(k.nudgeAt)}% and ${fmt(k.nudgeAgainAt)}% of the compaction point` : 'no toast'
  const lines = ['context-keeper', `Mode: ${k.mode} (${from}): ${what}.`]
  if (facts.point !== undefined && facts.tokens !== undefined) {
    const where = facts.isThreshold ? 'the auto-compact threshold' : 'the window'
    lines.push(
      `Context: ${fmt(facts.tokens)} tokens, ${Math.round((facts.tokens / facts.point) * 100)}% of the compaction point (${fmt(facts.point)} tokens, ${where}).`,
    )
  } else {
    lines.push('Context: not known yet.')
  }
  lines.push(`Toasts: ${LEVEL_WORDS[facts.level]}. They start again when the context drops below ${fmt(k.nudgeAt)}%, as after a compaction.`)
  lines.push(TEMPLATE_NOTE)

  return lines.join('\n')
}
