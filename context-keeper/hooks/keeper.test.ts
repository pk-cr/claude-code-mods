// Unit tests of the pure logic in keeper.ts. Each runs once per surface, as
// the hook tests do, though nothing here reads a surface.

import { describe, expect, test } from 'claude-code/testing'

import { TEMPLATE_NOTE, USAGE, gateBase, knobsOf, nudgeOf, nudgeStep, nudgeText, optionsOf, parseKeeper, pointOf, settingsOf, statusText } from './keeper'

const SURFACES = ['terminal', 'desktop'] as const

describe('options and settings', () => {
  for (const surface of SURFACES) {
    test(`defaults, bad values and clamps (${surface})`, () => {
      expect(optionsOf({})).toEqual({ mode: 'ask', nudgeAt: 60, nudgeAgainAt: 75 })
      expect(optionsOf({ mode: 'off', nudgeAtPercent: 50, nudgeAgainAtPercent: 70 })).toEqual({ mode: 'off', nudgeAt: 50, nudgeAgainAt: 70 })
      // 0.1.x had an auto mode; it falls back to ask.
      expect(optionsOf({ mode: 'auto' }).mode).toBe('ask')
      expect(optionsOf({ nudgeAtPercent: 500, nudgeAgainAtPercent: 'x' })).toEqual({ mode: 'ask', nudgeAt: 100, nudgeAgainAt: 100 })
      expect(optionsOf({ nudgeAtPercent: 80, nudgeAgainAtPercent: 70 }).nudgeAgainAt).toBe(80)
    })

    test(`a session mode overrides the option; old state reads safely (${surface})`, () => {
      const options = optionsOf({})
      expect(knobsOf(options, {})).toEqual({ ...options, isModeSession: false })
      expect(knobsOf(options, { mode: 'off' })).toEqual({ ...options, mode: 'off', isModeSession: true })
      expect(settingsOf({ mode: 'auto', tail: 2 })).toEqual({})
      expect(settingsOf(null)).toEqual({})
      expect(nudgeOf({ level: 2, fillPending: true })).toEqual({ level: 2 })
      expect(nudgeOf({ level: 1, lastPoint: 800_000 })).toEqual({ level: 1, lastPoint: 800_000 })
      expect(nudgeOf({ level: 7, lastPoint: -1 })).toEqual({ level: 0 })
      expect(nudgeOf('junk')).toEqual({ level: 0 })
    })
  }
})

describe('the point and the gate', () => {
  for (const surface of SURFACES) {
    test(`the threshold, else the window (${surface})`, () => {
      expect(pointOf({ window: 1_000_000, breakdown: { autoCompactThreshold: 800_000 } })).toBe(800_000)
      expect(pointOf({ window: 1_000_000 })).toBe(1_000_000)
      expect(pointOf({ window: 0 })).toBeUndefined()
      expect(pointOf(undefined)).toBeUndefined()
    })

    test(`the gate divides by the last point when it is below the window (${surface})`, () => {
      expect(gateBase(1_000_000, undefined)).toBe(1_000_000)
      expect(gateBase(1_000_000, 200_000)).toBe(200_000)
      expect(gateBase(200_000, 900_000)).toBe(200_000)
    })
  }
})

describe('nudgeStep', () => {
  for (const surface of SURFACES) {
    test(`0 -> 1 at the first level, 1 -> 2 at the second, then quiet (${surface})`, () => {
      expect(nudgeStep(0, 0.59, 60, 75)).toEqual({ level: 0, fire: false })
      expect(nudgeStep(0, 0.6, 60, 75)).toEqual({ level: 1, fire: true })
      expect(nudgeStep(1, 0.7, 60, 75)).toEqual({ level: 1, fire: false })
      expect(nudgeStep(1, 0.75, 60, 75)).toEqual({ level: 2, fire: true })
      expect(nudgeStep(2, 0.9, 60, 75)).toEqual({ level: 2, fire: false })
    })

    test(`past the second level at once: one toast, straight to 2 (${surface})`, () => {
      expect(nudgeStep(0, 0.8, 60, 75)).toEqual({ level: 2, fire: true })
    })

    test(`below the first level it resets, at any level (${surface})`, () => {
      expect(nudgeStep(2, 0.1, 60, 75)).toEqual({ level: 0, fire: false })
      expect(nudgeStep(1, 0.59, 60, 75)).toEqual({ level: 0, fire: false })
    })

    test(`the toast names /compact and the fill (${surface})`, () => {
      expect(nudgeText(0.623)).toBe(
        'context-keeper: context is at 62% of the compaction point. Run /compact at the end of this task, while the cache is warm.',
      )
    })
  }
})

describe('/keeper', () => {
  for (const surface of SURFACES) {
    test(`parses status, mode and the rest (${surface})`, () => {
      expect(parseKeeper('')).toEqual({ kind: 'status' })
      expect(parseKeeper('  status ')).toEqual({ kind: 'status' })
      expect(parseKeeper('mode off')).toEqual({ kind: 'mode', mode: 'off' })
      expect(parseKeeper('mode ask')).toEqual({ kind: 'mode', mode: 'ask' })
      expect(parseKeeper('mode auto')).toEqual({ kind: 'bad', text: `Mode must be ask or off.\n\n${USAGE}` })
      for (const gone of ['compact', 'tail 2', 'pin a note', 'unpin', 'template']) expect(parseKeeper(gone)).toEqual({ kind: 'bad', text: USAGE })
    })

    test(`status text (${surface})`, () => {
      const knobs = knobsOf(optionsOf({}), {})
      const known = statusText({ knobs, tokens: 496_000, point: 800_000, isThreshold: true, level: 1 })
      expect(known).toBe(
        [
          'context-keeper',
          'Mode: ask (from settings): a toast asks you to run /compact at 60% and 75% of the compaction point.',
          'Context: 496,000 tokens, 62% of the compaction point (800,000 tokens, the auto-compact threshold).',
          'Toasts: the first toast showed. They start again when the context drops below 60%, as after a compaction.',
          TEMPLATE_NOTE,
        ].join('\n'),
      )
      const off = statusText({ knobs: knobsOf(optionsOf({}), { mode: 'off' }), isThreshold: false, level: 0 })
      expect(off).toContain('Mode: off (set for this session): no toast.')
      expect(off).toContain('Context: not known yet.')
      expect(off).toContain('Toasts: no toast yet.')
      expect(statusText({ knobs, tokens: 610_000, point: 1_000_000, isThreshold: false, level: 2 })).toContain('(1,000,000 tokens, the window)')
    })
  }
})
