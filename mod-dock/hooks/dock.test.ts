import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { CommandInfo, On, PaneOpenArgs } from 'claude-code'

import {
  RESCAN_MS,
  actionNote,
  buildRows,
  chipLabel,
  compareVersions,
  hiddenNames,
  isSafeName,
  loadedFrom,
  mergeCopies,
  notSeenNote,
  hasModules,
  installedPlaces,
  optionLabel,
  parseInstalled,
  parseManifest,
  parseMarkets,
  planOf,
  pluginsDirOf,
  statusWord,
  summaryOf,
  uiOf,
  unloadedNote,
} from './dock'
import type { Found } from './dock'
import type { DiskMod } from '../types'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
} as const

const PANE = {
  title: 'Mod dock',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

const OPTIONS = { options: { modsDir: '/mods' } }

// ---------------------------------------------------------------------------
// The stand-in engine

/** What the test sets up and reads back around the stand-in engine. */
type World = {
  clock: MockClock
  /** Every pane the dock asked to open. */
  opened: PaneOpenArgs[]
  /** Every pane id the dock asked to close. */
  closed: string[]
  /** Every toast text. */
  toasts: string[]
  /** Every path the dock wrote. */
  writes: string[]
  /** Every path the dock read. */
  reads: string[]
  /** File path → text. A folder exists while a file lies under it. */
  files: Record<string, string>
  /** Folders that exist with nothing in them. */
  roots: string[]
  /** Paths whose read fails. */
  unreadable: string[]
  /** What `$.command.list()` answers. */
  commands: CommandInfo[]
  /** The commands the dock registered. */
  registered: string[]
  /** True while every `fs.list` fails. */
  isListFailing: boolean
  /** How many times the band was drawn: the dock's hook asks the engine beneath for its band each time. */
  bandDraws: number
}

const manifest = (name: string, version: string, description = `${name} does a job.`): string =>
  JSON.stringify({ name, version, description })

const command = (name: string, plugin: string): CommandInfo => ({ name, description: `${name} command`, source: 'plugin', plugin })

/**
 * Two session folders: agent-radar twice, a placeholder that is hidden by default, a mod nobody loaded (`notes`, with the
 * files a real mod has, among them ones a copy leaves out) and one that holds a single manifest.
 */
function fixture(): Pick<World, 'files' | 'roots'> {
  const path = (session: string, mod: string): string => `/mods/${session}/${mod}/.claude-plugin/plugin.json`
  const notes = (rest: string): string => `/mods/s2/notes/${rest}`

  return {
    roots: ['/mods'],
    files: {
      '/mods/.DS_Store': '',
      [path('s1', 'agent-radar')]: manifest('agent-radar', '0.3.0', 'Skills band and a subagent pane.'),
      [path('s1', 'usage-meter')]: manifest('usage-meter', '0.1.0', 'Tokens and cost.'),
      [path('s2', 'agent-radar')]: manifest('agent-radar', '0.2.0'),
      [path('s2', 'conversation-atlas-plus')]: manifest('conversation-atlas-plus', '0.1.0', 'Tracks the conversation.'),
      [path('s2', 'hot-reload-on')]: manifest('hot-reload-on', '0.1.0'),
      [path('s2', 'notes')]: manifest('notes', '0.4.2', 'Keeps notes.'),
      [notes('.claude-plugin/types/claude-code/index.d.ts')]: 'engine types',
      [notes('hooks/hooks.json')]: '{ "modules": ["./register.tsx"] }',
      [notes('hooks/register.tsx')]: 'export const register = () => {}',
      [notes('hooks/ding.wav')]: 'RIFF',
      [notes('node_modules/x/index.js')]: 'module.exports = 1',
      [notes('types/index.d.ts')]: 'export type Note = string',
      [notes('tsconfig.json')]: '{}',
    },
  }
}

/** What stands for the engine beneath the plugin. */
function engine(on: On, setup: Partial<World> = {}): World {
  const world: World = {
    clock: mock.clock(on),
    opened: [],
    closed: [],
    toasts: [],
    writes: [],
    reads: [],
    unreadable: [],
    ...fixture(),
    commands: [command('radar', 'agent-radar'), command('meter', 'usage-meter')],
    registered: [],
    isListFailing: false,
    bandDraws: 0,
    ...setup,
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.list', (_$, e) => {
    if (world.isListFailing) throw new Error('ENOENT')
    const prefix = `${e.path}/`
    const seen = new Map<string, 'dir' | 'file'>()
    for (const path of Object.keys(world.files)) {
      if (!path.startsWith(prefix)) continue
      const parts = path.slice(prefix.length).split('/')
      seen.set(parts[0] ?? '', parts.length > 1 ? 'dir' : 'file')
    }
    if (seen.size === 0 && !world.roots.includes(e.path)) throw new Error('ENOENT')

    return { value: [...seen].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => {
    world.reads.push(e.path)
    const text = world.files[e.path]
    if (text === undefined || world.unreadable.includes(e.path)) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.write', (_$, e) => {
    world.writes.push(e.path)
    world.files[e.path] = e.text

    return { value: undefined }
  })
  on('command.list', () => ({ value: world.commands }))
  on('command.register', (_$, e) => {
    world.registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    world.opened.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    world.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    world.bandDraws += 1
    const { Text } = $.ui.resolve(e)

    return h(Text, null, 'ENGINE BAND') as never
  })
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, null, 'ENGINE MODES') as never
  })

  return world
}

const FOOTER = { modes: [] } as const

/** What the person types: `/dock refresh` is `typed('dock', 'refresh')`. */
const typed = (name: string, args = '') =>
  ({
    command: name,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  }) as never

const dockArgs = (args: string) => typed('dock', args)

/** Another mod, as the engine sees it: it opens and closes its own pane and registers a command late, each on a command of its own. */
const NEIGHBOUR: Plugin = {
  name: 'agent-radar',
  register: on => {
    on('command.run', { command: 'radar' }, async $ => {
      await $.ui.open({ id: 'agents', title: 'Subagents' })

      return { text: 'opened' }
    })
    on('command.run', { command: 'radar-close' }, async $ => {
      await $.ui.close({ id: 'agents' })

      return { text: 'closed' }
    })
    on('command.run', { command: 'radar-late' }, async ($, e) => {
      await $.command.register({ name: e.args, description: 'A command that arrives late' })

      return { text: 'registered' }
    })
  },
}

const WITH_NEIGHBOUR = { ...OPTIONS, plugins: [NEIGHBOUR] }

/**
 * A mod that holds the band above the prompt the way agent-radar does: it sits outside the dock and draws its own tree
 * without asking the plugins beneath, so the dock's band is never drawn while it has something to show.
 */
const BAND_HOG: Plugin = {
  name: 'band-hog',
  tier: 'prepend',
  register: on => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return h(Text, null, 'HOG BAND') as never
    })
  },
}

const WITH_HOG = { ...OPTIONS, plugins: [BAND_HOG] }

/** Starts the dock as a session does, then lets its two timers run. */
async function start($: Engine, world: World): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await world.clock.advance(2000)
}

// ---------------------------------------------------------------------------
// Pure logic

const disk = (fields: Partial<DiskMod> & Pick<DiskMod, 'name'>): DiskMod => ({
  version: '1.0.0',
  description: '',
  path: `/mods/s1/${fields.name}`,
  copies: 1,
  inSession: false,
  ...fields,
})

const found = (fields: Partial<Found> & Pick<Found, 'name' | 'path'>): Found => ({
  version: '1.0.0',
  description: '',
  isSession: false,
  ...fields,
})

describe('reading mods', () => {
  test('a manifest keeps its name, version and a clipped description', () => {
    expect(parseManifest('{"name":"a","version":"1.2.3","description":"does   a\\n job"}')).toEqual({
      name: 'a',
      version: '1.2.3',
      description: 'does a job',
    })
    expect(parseManifest('{"name":"a"}')).toEqual({ name: 'a', version: '', description: '' })
    expect(parseManifest(JSON.stringify({ name: 'a', description: 'x'.repeat(500) }))?.description).toHaveLength(240)
  })

  test('text that is no manifest is left out', () => {
    expect(parseManifest('not json')).toBeUndefined()
    expect(parseManifest('[]')).toBeUndefined()
    expect(parseManifest('{"version":"1"}')).toBeUndefined()
    expect(parseManifest('{"name":""}')).toBeUndefined()
  })

  test('the scan is planned from where the dock sits, or from the folder the person names', () => {
    expect(planOf('/home/u/.claude/dev-mods/abc/mod-dock', '')).toEqual({ devMods: '/home/u/.claude/dev-mods', sessionId: 'abc', flat: '' })
    expect(planOf('/home/u/claude/mods/mod-dock', '')).toEqual({ devMods: '/home/u/.claude/dev-mods', sessionId: '', flat: '/home/u/claude/mods' })
    expect(planOf('/opt/mods/mod-dock', '')).toEqual({ devMods: '', sessionId: '', flat: '/opt/mods' })
    expect(planOf('/home/u/.claude/dev-mods/abc/mod-dock', '/x/dev/')).toEqual({ devMods: '/x/dev', sessionId: 'abc', flat: '' })
  })

  test('versions compare number by number', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('', '0.0.1')).toBeLessThan(0)
  })

  test('copies of one mod merge to one entry: this session first, then the highest version', () => {
    const merged = mergeCopies([
      found({ name: 'a', path: '/m/s1/a', version: '0.2.0' }),
      found({ name: 'a', path: '/m/s2/a', version: '0.10.0' }),
      found({ name: 'b', path: '/m/s1/b', version: '1.0.0' }),
      found({ name: 'b', path: '/m/s9/b', version: '0.5.0', isSession: true }),
    ])
    expect(merged.map(one => [one.name, one.path, one.version, one.copies, one.inSession])).toEqual([
      ['a', '/m/s2/a', '0.10.0', 2, false],
      ['b', '/m/s9/b', '0.5.0', 2, true],
    ])
  })

  test('only plugins that own a command count as loaded, and a tail after @ is dropped', () => {
    const list = [
      command('radar', 'agent-radar@inline'),
      command('radar-mode', 'agent-radar'),
      { name: 'clear', description: '', source: 'builtin' as const },
      command('meter', 'usage-meter'),
    ]
    expect(loadedFrom(list)).toEqual([
      { name: 'agent-radar', command: 'radar' },
      { name: 'usage-meter', command: 'meter' },
    ])
  })

  test('the hidden option is a trimmed comma list', () => {
    expect(hiddenNames(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
    expect(hiddenNames('')).toEqual([])
    expect(hiddenNames(undefined)).toEqual([])
  })
})

describe('rows and words', () => {
  const rowsOf = (extra: Partial<Parameters<typeof buildRows>[0]> = {}) =>
    buildRows({
      disk: [
        disk({ name: 'agent-radar', version: '0.3.0' }),
        disk({ name: 'usage-meter' }),
        disk({ name: 'notes' }),
        disk({ name: 'lost', inSession: true }),
        disk({ name: 'hot-reload-on' }),
      ],
      loaded: [
        { name: 'agent-radar', command: 'radar' },
        { name: 'usage-meter', command: 'meter' },
      ],
      panes: [],
      hidden: ['hot-reload-on'],
      selfRoot: '/self',
      ...extra,
    })

  test('loaded, not seen and on disk only are told apart, in that order, and the dock lists itself', () => {
    const rows = rowsOf()
    expect(rows.map(row => `${row.glyph} ${row.name}`)).toEqual([
      '● agent-radar',
      '● mod-dock',
      '● usage-meter',
      '! lost',
      '○ notes',
    ])
    const self = rows.find(row => row.isSelf)
    expect(self?.path).toBe('/self')
    expect(self?.command).toBe('dock')
    expect(self?.window).toEqual({ pane: 'dock', title: 'Mod dock' })
  })

  test('a status carries its reason in plain words', () => {
    const rows = rowsOf()
    expect(rows.find(row => row.name === 'agent-radar')?.reason).toContain('seen through /radar')
    expect(rows.find(row => row.name === 'notes')?.reason).toContain('Only in a dev-mods folder')
    expect(rows.find(row => row.name === 'lost')?.reason).toContain('failed to load')
  })

  test('a hidden mod is left out, but never the dock', () => {
    expect(rowsOf().some(row => row.name === 'hot-reload-on')).toBe(false)
    expect(rowsOf({ hidden: ['hot-reload-on', 'mod-dock', 'notes'] }).map(row => row.name)).toEqual(['agent-radar', 'mod-dock', 'usage-meter', 'lost'])
  })

  test('a known mod that is loaded but not on disk still shows; an unknown plugin does not', () => {
    const rows = rowsOf({
      disk: [],
      loaded: [
        { name: 'agent-radar', command: 'radar' },
        { name: 'mattpocock-skills', command: 'tdd' },
      ],
    })
    expect(rows.map(row => row.name)).toEqual(['agent-radar', 'mod-dock'])
    expect(rows[0]?.path).toBe('')
  })

  test('a window counts as open when its pane id was seen open', () => {
    const rows = rowsOf({ panes: ['agents', 'dock'] })
    expect(rows.find(row => row.name === 'agent-radar')?.isOpen).toBe(true)
    expect(rows.find(row => row.name === 'mod-dock')?.isOpen).toBe(true)
    expect(rows.find(row => row.name === 'usage-meter')?.isOpen).toBe(false)
  })

  test('the summary counts the mods, the active ones and the rest', () => {
    const rows = rowsOf()
    expect(summaryOf(rows, true)).toBe('5 mods · 3 active · 2 not loaded')
    expect(summaryOf(rows, false)).toBe('3/5 active')
    expect(summaryOf(rows.slice(0, 1), true)).toBe('1 mod · 1 active')
  })

  test('chips and options say the status and whether the window is open', () => {
    const closed = rowsOf().find(row => row.name === 'agent-radar')
    const open = rowsOf({ panes: ['agents'] }).find(row => row.name === 'agent-radar')
    const idle = rowsOf().find(row => row.name === 'notes')
    expect(closed && chipLabel(closed)).toBe('● agent-radar')
    expect(open && chipLabel(open)).toBe('● agent-radar · open')
    expect(open && optionLabel(open)).toBe('● agent-radar (open, pick to close)')
    expect(closed && actionNote(closed)).toBe('pick to open')
    expect(idle && optionLabel(idle)).toBe('○ notes (not loaded here)')
  })

})

describe('installed mods', () => {
  const registry = JSON.stringify({
    version: 2,
    plugins: {
      'agent-radar@claude-code-mods': [{ scope: 'user', installPath: '/cache/agent-radar/0.4.0', version: '0.4.0' }],
      'no-path@claude-code-mods': [{ scope: 'user' }],
      'a/b@claude-code-mods': [{ installPath: '/x' }],
      broken: [{ installPath: '/y' }],
    },
  })

  test('the registry lists each installed plugin with the folder it keeps', () => {
    expect(parseInstalled(registry)).toEqual([{ name: 'agent-radar', market: 'claude-code-mods', installPath: '/cache/agent-radar/0.4.0' }])
    expect(parseInstalled(undefined)).toEqual([])
    expect(parseInstalled('not json')).toEqual([])
    expect(parseInstalled('{"plugins":[]}')).toEqual([])
  })

  test('a marketplace that is a folder is read in place, the others from their install copy', () => {
    const markets = parseMarkets(
      JSON.stringify({
        'claude-code-mods': { source: { source: 'directory', path: '/m' }, installLocation: '/m' },
        official: { source: { source: 'git', url: 'x' }, installLocation: '/o' },
      }),
    )
    expect([...markets]).toEqual([['claude-code-mods', '/m']])
    const radar = { name: 'agent-radar', market: 'claude-code-mods', installPath: '/cache/r' }
    expect(installedPlaces(radar, markets)).toEqual(['/m/agent-radar', '/cache/r'])
    expect(installedPlaces({ ...radar, market: 'official' }, markets)).toEqual(['/cache/r'])
    expect(parseMarkets(undefined).size).toBe(0)
  })

  test('only a plugin whose hooks.json names a module is a mod', () => {
    expect(hasModules('{ "modules": ["./register.tsx"] }')).toBe(true)
    expect(hasModules('{"modules":[]}')).toBe(false)
    expect(hasModules('{"hooks":{}}')).toBe(false)
    expect(hasModules(undefined)).toBe(false)
  })

  test('the plugins folder sits next to the mods folder', () => {
    expect(pluginsDirOf('/home/u/.claude/dev-mods')).toBe('/home/u/.claude/plugins')
    expect(pluginsDirOf('/mods')).toBe('/plugins')
    expect(pluginsDirOf('')).toBe('')
  })

  test('the installed copy is shown over a newer dev copy, but this session’s own copy wins', () => {
    const dev = found({ name: 'a', path: '/m/s1/a', version: '0.3.0' })
    const installed = found({ name: 'a', path: '/market/a', version: '0.2.1', isInstalled: true })
    expect(mergeCopies([dev, installed])[0]).toMatchObject({ path: '/market/a', version: '0.2.1', isInstalled: true, copies: 2 })
    const own = found({ name: 'a', path: '/m/s9/a', version: '0.1.0', isSession: true })
    expect(mergeCopies([dev, installed, own])[0]).toMatchObject({ path: '/m/s9/a', version: '0.1.0', inSession: true, copies: 3 })
    expect(mergeCopies([dev, installed, own])[0]?.isInstalled).toBeUndefined()
  })

  test('one folder found as a mods-folder entry and as an installed plugin is one copy', () => {
    const merged = mergeCopies([found({ name: 'a', path: '/market/a' }), found({ name: 'a', path: '/market/a', isInstalled: true })])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ copies: 1, isInstalled: true })
  })

})

describe('a mod that is not loaded', () => {
  const rowsOf = (disk: DiskMod[]) =>
    buildRows({ disk, loaded: [], panes: [], hidden: [], selfRoot: '/self' })
  const only = disk({ name: 'orphan', path: '/home/u/.claude/dev-mods/s1/orphan' })
  const market = disk({ name: 'fresh', path: '/home/u/claude/mods/fresh', isMarket: true })
  const installed = disk({ name: 'notes', path: '/home/u/claude/mods/notes', isMarket: true, isInstalled: true })

  test('a mod in a marketplace folder that is not installed is told to run sync.sh', () => {
    const row = rowsOf([market]).find(one => one.name === 'fresh')
    expect(row?.isMarket).toBe(true)
    expect(row?.reason).toBe('In your mods folder but not installed. Run /home/u/claude/mods/sync.sh in your Terminal.')
    expect(row && actionNote(row)).toBe('not installed: run sync.sh')
    expect(row && unloadedNote(row)).toBe('fresh is not installed. Run /home/u/claude/mods/sync.sh in your Terminal.')
  })

  test('an installed mod is told to reload, even when its folder is also a marketplace folder', () => {
    const row = rowsOf([installed]).find(one => one.name === 'notes')
    expect(row?.isMarket).toBe(false)
    expect(row?.isInstalled).toBe(true)
    expect(row && actionNote(row)).toBe('installed, not loaded here')
    expect(row && unloadedNote(row)).toBe('notes is installed but not loaded in this session. Run /reload-plugins.')
  })

  test('a mod only in a dev-mods folder is told to move into the mods folder, and nothing offers to load it', () => {
    const row = rowsOf([only]).find(one => one.name === 'orphan')
    expect(row && actionNote(row)).toBe('not loaded here')
    expect(row && unloadedNote(row)).toBe(
      "orphan is only in /home/u/.claude/dev-mods/s1/orphan. Move it into your mods folder, then run that folder's sync.sh.",
    )
    expect(row?.reason).toContain('Only in a dev-mods folder')
  })

  test('a note says why a mod loaded in this session\u2019s folder was not seen', () => {
    const lost = buildRows({ disk: [disk({ name: 'lost', inSession: true })], loaded: [], panes: [], hidden: [], selfRoot: '/self' })
    expect(lost.find(one => one.name === 'lost') && notSeenNote(lost.find(one => one.name === 'lost') as never)).toContain('was not seen loaded')
  })

  test('a marketplace copy is shown over a newer dev copy, and the flags of one folder found twice are joined', () => {
    const dev = found({ name: 'a', path: '/m/s1/a', version: '0.9.0' })
    const market = found({ name: 'a', path: '/market/a', version: '0.2.0', isMarket: true })
    expect(mergeCopies([dev, market])[0]).toMatchObject({ path: '/market/a', isMarket: true, copies: 2 })
    const both = mergeCopies([market, found({ name: 'a', path: '/market/a', version: '0.2.0', isInstalled: true })])
    expect(both).toHaveLength(1)
    expect(both[0]).toMatchObject({ copies: 1, isInstalled: true, isMarket: true })
  })

  test('only plain names join into a path', () => {
    expect(isSafeName('notes')).toBe(true)
    expect(isSafeName('conversation-atlas-plus')).toBe(true)
    expect(isSafeName('..')).toBe(false)
    expect(isSafeName('a/b')).toBe(false)
    expect(isSafeName('')).toBe(false)
  })
})

describe('stored UI state', () => {
  test('a value from an older version gets the fields it lacks', () => {
    expect(uiOf({ isExpanded: true, focus: 'notes', picks: 3 })).toEqual({ isExpanded: true, focus: 'notes', picks: 3 })
    expect(uiOf({})).toEqual({ isExpanded: false, focus: '', picks: 0 })
    expect(uiOf(undefined)).toEqual({ isExpanded: false, focus: '', picks: 0 })
  })

  test('a whole value passes through unchanged, and a damaged field falls back', () => {
    const whole = { isExpanded: true, focus: 'a', picks: 2 }
    expect(uiOf(whole)).toEqual(whole)
    expect(uiOf({ picks: 'x', focus: 4 } as never)).toEqual({ isExpanded: false, focus: '', picks: 0 })
  })
})

// ---------------------------------------------------------------------------
// The mod in the engine

describe('the dock', () => {
  for (const surface of SURFACES) {
    describe(surface, () => {
      test('the band is one line: title, count summary and a Select over every mod', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: BAND })
        expect(await ui.find({ type: 'Text', text: /^Mods$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^5 mods · 3 active · 2 not loaded$/ })).toBeDefined()
        const select = await ui.find({ type: 'Select', key: 'mods' })
        expect((select?.props.options as { value: string; label: string }[]).map(option => option.label)).toEqual([
          'pick a mod…',
          '● agent-radar (pick to open)',
          '● mod-dock (pick to open)',
          '● usage-meter (pick to open)',
          '○ conversation-atlas-plus (not loaded here)',
          '○ notes (not loaded here)',
        ])
        expect(await ui.find({ type: 'Button', key: 'mod-agent-radar' })).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: /ENGINE BAND/ })).toBeDefined()
        await ui.unmount()
      })

      test('a narrow band shortens the summary', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 60 } })
        expect(await ui.find({ type: 'Text', text: /^3\/5 active$/ })).toBeDefined()
        await ui.unmount()
      })

      test('the chip row opens on request and shows each mod with its status', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: BAND })
        await ui.press({ key: 'chips' })
        expect((await ui.find({ type: 'Button', key: 'mod-agent-radar' }))?.props.label).toBe('● agent-radar')
        expect((await ui.find({ type: 'Button', key: 'mod-notes' }))?.props.label).toBe('○ notes')
        expect((await ui.find({ type: 'Button', key: 'mod-notes' }))?.props.dimColor).toBe(true)
        expect((await ui.find({ type: 'Button', key: 'mod-mod-dock' }))?.props.label).toBe('● mod-dock')
        expect((await ui.find({ type: 'Button', key: 'chips' }))?.props.label).toBe('hide')
        await ui.press({ key: 'chips' })
        expect(await ui.find({ type: 'Button', key: 'mod-agent-radar' })).toBeUndefined()
        await ui.unmount()
      })

      test('picking a mod opens its window and picking it again closes it, and the chip says which', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: BAND })
        await ui.press({ key: 'chips' })

        await ui.select({ key: 'mods', value: 'agent-radar' })
        expect(world.opened).toEqual([{ id: 'agents', title: 'Subagents' }])
        expect((await ui.find({ type: 'Button', key: 'mod-agent-radar' }))?.props.label).toBe('● agent-radar · open')
        expect((await ui.find({ type: 'Button', key: 'mod-agent-radar' }))?.props.variant).toBe('primary')

        await ui.select({ key: 'mods', value: 'agent-radar' })
        expect(world.closed).toEqual(['agents'])
        expect((await ui.find({ type: 'Button', key: 'mod-agent-radar' }))?.props.label).toBe('● agent-radar')

        await ui.press({ key: 'mod-usage-meter' })
        expect(world.opened.at(-1)).toEqual({ id: 'meter', title: 'Usage' })
        await ui.press({ key: 'mod-usage-meter' })
        expect(world.closed).toEqual(['agents', 'meter'])
        await ui.unmount()
      })

      test('the footer button counts the loaded mods and opens and closes the dock pane', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'SessionMode', props: FOOTER })
        expect((await ui.find({ type: 'Button', key: 'dock-footer' }))?.props.label).toBe('Mods 3/5')
        expect(await ui.find({ type: 'Text', text: /ENGINE MODES/ })).toBeDefined()
        await ui.press({ key: 'dock-footer' })
        expect(world.opened).toEqual([{ id: 'dock', title: 'Mod dock' }])
        await ui.press({ key: 'dock-footer' })
        expect(world.closed).toEqual(['dock'])
        await ui.unmount()
      })

      test('the footer button stays out of the way when there are no other mods', OPTIONS, async ($, on) => {
        const world = engine(on, { files: {}, roots: ['/mods'], commands: [] })
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'SessionMode', props: FOOTER })
        expect(await ui.find({ type: 'Text', text: /ENGINE MODES/ })).toBeDefined()
        expect(await ui.find({ type: 'Button', key: 'dock-footer' })).toBeUndefined()
        await ui.unmount()
      })

      test('another mod that holds the band hides the dock band, and the footer button and pane still reach every mod', WITH_HOG, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const band = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: BAND })
        expect(await band.find({ type: 'Text', text: /HOG BAND/ })).toBeDefined()
        expect(await band.find({ type: 'Select', key: 'mods' })).toBeUndefined()
        await band.unmount()

        const footer = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'SessionMode', props: FOOTER })
        await footer.press({ key: 'dock-footer' })
        expect(world.opened).toEqual([{ id: 'dock', title: 'Mod dock' }])
        await footer.unmount()

        const pane = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'Pane', requestId: 'dock', props: PANE })
        await pane.select({ key: 'mods', value: 'usage-meter' })
        expect(world.opened.at(-1)).toEqual({ id: 'meter', title: 'Usage' })
        await pane.press({ key: 'act-agent-radar' })
        expect(world.opened.at(-1)).toEqual({ id: 'agents', title: 'Subagents' })
        await pane.unmount()
      })

      test('the placeholder pick does nothing', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: BAND })
        await ui.select({ key: 'mods', value: '@pick' })
        expect(world.opened).toEqual([])
        expect(world.closed).toEqual([])
        await ui.unmount()
      })

      test('a window another mod opens or closes shows on the chip', WITH_NEIGHBOUR, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: BAND })
        await ui.press({ key: 'chips' })

        await $.command.run(typed('radar'))
        await ui.redraw()
        expect((await ui.find({ type: 'Button', key: 'mod-agent-radar' }))?.props.label).toBe('● agent-radar · open')

        await $.command.run(typed('radar-close'))
        await ui.redraw()
        expect((await ui.find({ type: 'Button', key: 'mod-agent-radar' }))?.props.label).toBe('● agent-radar')
        await ui.unmount()
      })

      test('a loaded mod with no window of its own opens the dock pane on its details', OPTIONS, async ($, on) => {
        const world = engine(on, { commands: [command('radar', 'agent-radar'), command('notes', 'notes')] })
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: BAND })
        await ui.press({ key: 'chips' })
        await ui.press({ key: 'mod-notes' })
        expect(world.opened).toEqual([{ id: 'dock', title: 'Mod dock' }])
        const pane = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'Pane', requestId: 'dock', props: PANE })
        expect(await pane.find({ type: 'Text', text: /^▶ ● notes$/ })).toBeDefined()
        expect(await pane.find({ type: 'Text', text: /^ {2}● agent-radar$/ })).toBeDefined()
        await pane.unmount()
        await ui.unmount()
      })

      test('the dock is in its own list and opens and closes its own pane', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: BAND })
        await ui.select({ key: 'mods', value: 'mod-dock' })
        expect(world.opened).toEqual([{ id: 'dock', title: 'Mod dock' }])
        await ui.press({ key: 'chips' })
        expect((await ui.find({ type: 'Button', key: 'mod-mod-dock' }))?.props.label).toBe('● mod-dock · open')
        await ui.select({ key: 'mods', value: 'mod-dock' })
        expect(world.closed).toEqual(['dock'])
        await ui.unmount()
      })

      test('the band yields to a survey and shows nothing extra when there are no other mods', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const survey = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
        expect(await survey.find({ type: 'Text', text: /ENGINE BAND/ })).toBeDefined()
        expect(await survey.find({ type: 'Text', text: /^Mods$/ })).toBeUndefined()
        await survey.unmount()
      })

      test('with no mods on disk and none loaded the band stays out of the way', OPTIONS, async ($, on) => {
        const world = engine(on, { files: {}, roots: ['/mods'], commands: [] })
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'AbovePrompt', props: BAND })
        expect(await ui.find({ type: 'Text', text: /ENGINE BAND/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^Mods$/ })).toBeUndefined()
        expect(await ui.find({ type: 'Select', key: 'mods' })).toBeUndefined()
        await ui.unmount()
      })

      test('the pane lists every mod with its version, description, path and the reason for its status', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'Pane', requestId: 'dock', props: PANE })
        expect(await ui.find({ type: 'Text', text: /^Mod dock$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^5 mods · 3 active · 2 not loaded$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /mods folder: \/mods/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^ {2}● agent-radar$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^v0\.3\.0$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^Skills band and a subagent pane\.$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^\/mods\/s1\/agent-radar \(2 copies\)$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Loaded in this session, seen through \/radar/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^ {2}○ notes$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Only in a dev-mods folder/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^ {2}● mod-dock$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /hot-reload-on/ })).toBeUndefined()
        await ui.unmount()
      })

      test('the pane opens and closes a window, and refresh reads the folders again', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'Pane', requestId: 'dock', props: PANE })
        expect((await ui.find({ type: 'Button', key: 'act-usage-meter' }))?.props.label).toBe('open')
        expect(await ui.find({ type: 'Button', key: 'act-notes' })).toBeUndefined()
        await ui.press({ key: 'act-usage-meter' })
        expect(world.opened).toEqual([{ id: 'meter', title: 'Usage' }])
        expect((await ui.find({ type: 'Button', key: 'act-usage-meter' }))?.props.label).toBe('close')
        await ui.press({ key: 'act-usage-meter' })
        expect(world.closed).toEqual(['meter'])

        world.files['/mods/s2/fresh/.claude-plugin/plugin.json'] = manifest('fresh', '0.0.1', 'New one.')
        world.commands = [...world.commands, command('fresh', 'fresh')]
        await ui.press({ key: 'refresh' })
        expect(await ui.find({ type: 'Text', text: /^ {2}● fresh$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^6 mods · 4 active · 2 not loaded$/ })).toBeDefined()
        await ui.unmount()
      })

      test('a folder that cannot be listed is said so, not hidden', OPTIONS, async ($, on) => {
        const world = engine(on, { isListFailing: true })
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'Pane', requestId: 'dock', props: PANE })
        expect(await ui.find({ type: 'Text', text: /Could not list \/mods\./ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^ {2}● mod-dock$/ })).toBeDefined()
        await ui.unmount()
      })

      test('folders that start with a dot are not probed for a manifest', OPTIONS, async ($, on) => {
        const world = engine(on)
        world.files['/mods/s2/.claude/settings.json'] = '{}'
        await start($, world)
        expect(world.reads.some(path => path.includes('/.claude/'))).toBe(false)
        const pane = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'Pane', requestId: 'dock', props: PANE })
        expect(await pane.find({ type: 'Text', text: /^5 mods · 3 active · 2 not loaded$/ })).toBeDefined()
        await pane.unmount()
      })

      test('the dock reads and never writes', OPTIONS, async ($, on) => {
        const world = engine(on)
        await start($, world)
        const ui = await $.ui.mount({ plugin: 'mod-dock', surface, component: 'Pane', requestId: 'dock', props: PANE })
        await ui.press({ key: 'refresh' })
        await $.command.run(dockArgs('refresh'))
        expect(world.writes).toEqual([])
        await ui.unmount()
      })
    })
  }

  test('the hidden option names the mods to leave out', { options: { modsDir: '/mods', hidden: 'notes,usage-meter' } }, async ($, on) => {
    const world = engine(on)
    await start($, world)
    const ui = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'Pane', requestId: 'dock', props: PANE })
    expect(await ui.find({ type: 'Text', text: /notes/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /usage-meter/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /hot-reload-on/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ {2}● mod-dock$/ })).toBeDefined()
    await ui.unmount()
  })

  test('/dock registers at session start and opens the pane', OPTIONS, async ($, on) => {
    const world = engine(on)
    await start($, world)
    expect(world.registered).toEqual(['dock'])
    const ran = await $.command.run(dockArgs(''))
    expect(ran.text).toBe('Mod dock opened: 5 mods · 3 active · 2 not loaded.')
    expect(world.opened).toEqual([{ id: 'dock', title: 'Mod dock' }])
  })

  test('/dock refresh reads again without opening the pane, and a stray word shows the usage', OPTIONS, async ($, on) => {
    const world = engine(on)
    await start($, world)
    const ran = await $.command.run(dockArgs('refresh'))
    expect(ran.text).toBe('Mod dock refreshed: 5 mods · 3 active · 2 not loaded.')
    expect(world.opened).toEqual([])
    expect((await $.command.run(dockArgs('nope'))).text).toContain('Usage: /dock')
  })

  test('a mod that registers a command later turns its row to loaded', WITH_NEIGHBOUR, async ($, on) => {
    const world = engine(on)
    await start($, world)
    world.commands = [...world.commands, command('atlas', 'conversation-atlas-plus')]
    await $.command.run(typed('radar-late', 'atlas'))
    await world.clock.advance(500)
    const ui = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'Pane', requestId: 'dock', props: PANE })
    expect(await ui.find({ type: 'Text', text: /^ {2}● conversation-atlas-plus$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5 mods · 4 active · 1 not loaded$/ })).toBeDefined()
    await ui.unmount()
  })

  test('the version and path shown for an installed mod are the installed copy’s, read in place or from its install folder', OPTIONS, async ($, on) => {
    const world = engine(on)
    const plugin = (path: string, name: string, version: string, hooks = true) => {
      world.files[`${path}/.claude-plugin/plugin.json`] = manifest(name, version, `${name} installed.`)
      if (hooks) world.files[`${path}/hooks/hooks.json`] = '{ "modules": ["./register.tsx"] }'
    }
    plugin('/market/agent-radar', 'agent-radar', '0.4.0')
    plugin('/cache/usage-meter/0.2.0', 'usage-meter', '0.2.0')
    plugin('/market/notes', 'notes', '0.9.0')
    plugin('/cache/skills-only/1', 'skills-only', '1.0.0', false)
    world.files['/plugins/known_marketplaces.json'] = JSON.stringify({
      'claude-code-mods': { source: { source: 'directory', path: '/market' }, installLocation: '/market' },
    })
    const entry = (installPath: string) => [{ scope: 'user', installPath }]
    world.files['/plugins/installed_plugins.json'] = JSON.stringify({
      version: 2,
      plugins: {
        'agent-radar@claude-code-mods': entry('/cache/agent-radar/0.4.0'),
        'usage-meter@claude-code-mods': entry('/cache/usage-meter/0.2.0'),
        'notes@claude-code-mods': entry('/cache/notes/0.9.0'),
        'skills-only@claude-code-mods': entry('/cache/skills-only/1'),
      },
    })
    await start($, world)
    const pane = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'Pane', requestId: 'dock', props: PANE })
    // agent-radar: dev copies are 0.3.0 and 0.2.0, the installed folder (in place) is 0.4.0
    expect(await pane.find({ type: 'Text', text: /^v0\.4\.0$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^\/market\/agent-radar \(3 copies\)$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /seen through \/radar; the path and version are the installed copy.s/ })).toBeDefined()
    // usage-meter: no in-place folder, so the install copy
    expect(await pane.find({ type: 'Text', text: /^v0\.2\.0$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^\/cache\/usage-meter\/0\.2\.0 \(2 copies\)$/ })).toBeDefined()
    // a plugin without a hooks module is not listed
    expect(await pane.find({ type: 'Text', text: /skills-only/ })).toBeUndefined()
    // an installed mod that is not loaded: told to reload, offered no button, and nothing is written
    expect(await pane.find({ type: 'Text', text: /^Installed, but not loaded in this session\. \/reload-plugins loads it\.$/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'act-notes' })).toBeUndefined()
    const before = JSON.stringify(world.files)
    await pane.select({ key: 'mods', value: 'notes' })
    expect(world.writes).toEqual([])
    expect(JSON.stringify(world.files)).toBe(before)
    expect(world.toasts).toEqual(['notes is installed but not loaded in this session. Run /reload-plugins.'])
    await pane.unmount()
  })

  test('a pick of a mod that is not loaded only says what to do: nothing is written, whether it is installed, in the marketplace folder or only in a dev-mods folder', OPTIONS, async ($, on) => {
    const world = engine(on)
    const plugin = (path: string, name: string) => {
      world.files[`${path}/.claude-plugin/plugin.json`] = manifest(name, '1.0.0')
      world.files[`${path}/hooks/hooks.json`] = '{ "modules": ["./register.tsx"] }'
      world.files[`${path}/hooks/register.tsx`] = 'export const register = () => {}'
    }
    plugin('/market/installed-mod', 'installed-mod')
    plugin('/market/fresh-mod', 'fresh-mod')
    // a plugin in the marketplace folder that has no hooks module is not a mod, so it is not listed
    world.files['/market/skills-only/.claude-plugin/plugin.json'] = manifest('skills-only', '1.0.0')
    world.files['/plugins/known_marketplaces.json'] = JSON.stringify({
      'claude-code-mods': { source: { source: 'directory', path: '/market' }, installLocation: '/market' },
    })
    world.files['/plugins/installed_plugins.json'] = JSON.stringify({
      version: 2,
      plugins: { 'installed-mod@claude-code-mods': [{ scope: 'user', installPath: '/cache/installed-mod/1.0.0' }] },
    })
    await start($, world)
    const ui = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'chips' })
    expect(await ui.find({ type: 'Button', key: 'mod-skills-only' })).toBeUndefined()
    const before = JSON.stringify(world.files)

    await ui.select({ key: 'mods', value: 'installed-mod' })
    await ui.press({ key: 'mod-fresh-mod' })
    await ui.select({ key: 'mods', value: 'notes' })

    expect(world.toasts).toEqual([
      'installed-mod is installed but not loaded in this session. Run /reload-plugins.',
      'fresh-mod is not installed. Run /market/sync.sh in your Terminal.',
      'notes is only in /mods/s2/notes. Move it into your mods folder, then run that folder\'s sync.sh.',
    ])
    expect(world.writes).toEqual([])
    expect(JSON.stringify(world.files)).toBe(before)
    expect(world.opened).toEqual([])
    expect((await ui.find({ type: 'Button', key: 'mod-fresh-mod' }))?.props.label).toBe('○ fresh-mod')
    await ui.unmount()
  })

  test('a missing or unreadable registry changes nothing', OPTIONS, async ($, on) => {
    const world = engine(on)
    world.files['/plugins/installed_plugins.json'] = 'not json'
    await start($, world)
    const pane = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'Pane', requestId: 'dock', props: PANE })
    expect(await pane.find({ type: 'Text', text: /^5 mods · 3 active · 2 not loaded$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^v0\.3\.0$/ })).toBeDefined()
    await pane.unmount()
  })

  test('a mod made after the dock started shows within a minute, with no click', OPTIONS, async ($, on) => {
    const world = engine(on)
    await start($, world)
    const ui = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /^5 mods · 3 active · 2 not loaded$/ })).toBeDefined()
    world.files['/mods/s2/fresh/.claude-plugin/plugin.json'] = manifest('fresh', '0.0.1', 'New one.')
    await world.clock.advance(RESCAN_MS)
    expect(await ui.find({ type: 'Text', text: /^6 mods · 3 active · 3 not loaded$/ })).toBeDefined()
    await ui.press({ key: 'chips' })
    expect((await ui.find({ type: 'Button', key: 'mod-fresh' }))?.props.label).toBe('○ fresh')
    await ui.unmount()
  })

  test('a mod made in this session shows as soon as it registers its command, not a minute later', WITH_NEIGHBOUR, async ($, on) => {
    const world = engine(on)
    await start($, world)
    world.files['/mods/s2/fresh2/.claude-plugin/plugin.json'] = manifest('fresh2', '0.0.1')
    world.commands = [...world.commands, command('fresh2', 'fresh2')]
    await $.command.run(typed('radar-late', 'fresh2'))
    await world.clock.advance(500)
    const pane = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'Pane', requestId: 'dock', props: PANE })
    expect(await pane.find({ type: 'Text', text: /^ {2}● fresh2$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^6 mods · 4 active · 2 not loaded$/ })).toBeDefined()
    await pane.unmount()
  })

  test('a rescan that finds nothing new draws nothing', OPTIONS, async ($, on) => {
    const world = engine(on)
    await start($, world)
    const ui = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const before = world.bandDraws
    await world.clock.advance(RESCAN_MS * 5)
    expect(world.bandDraws).toBe(before)
    world.files['/mods/s2/fresh/.claude-plugin/plugin.json'] = manifest('fresh', '0.0.1')
    await world.clock.advance(RESCAN_MS)
    expect(world.bandDraws).toBeGreaterThan(before)
    await ui.unmount()
  })

  // A hot reload keeps `$.state` as the older version wrote it, so a field added since is missing from what is stored.
  test('state kept by an older version, without the newer fields, still draws and answers', OPTIONS, async ($, on) => {
    const world = engine(on)
    on('state.get', { plugin: 'mod-dock', key: 'ui' }, () => ({
      value: { value: { isExpanded: true, focus: 'notes', picks: 3 }, version: 1 },
    }))
    await start($, world)
    const ran = await $.command.run(dockArgs(''))
    expect(ran.text).toBe('Mod dock opened: 5 mods · 3 active · 2 not loaded.')
    const band = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Select', key: 'mods' })).toBeDefined()
    expect(await band.find({ type: 'Button', key: 'mod-notes' })).toBeDefined()
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'Pane', requestId: 'dock', props: PANE })
    expect(await pane.find({ type: 'Text', text: /^▶ ○ notes$/ })).toBeDefined()
    await pane.unmount()
  })

  test('a /clear forgets which windows were open', WITH_NEIGHBOUR, async ($, on) => {
    const world = engine(on)
    await start($, world)
    await $.command.run(typed('radar'))
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    const ui = await $.ui.mount({ plugin: 'mod-dock', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'chips' })
    expect((await ui.find({ type: 'Button', key: 'mod-agent-radar' }))?.props.label).toBe('● agent-radar')
    await ui.unmount()
  })
})
