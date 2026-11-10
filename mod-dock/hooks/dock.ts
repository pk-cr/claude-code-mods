// The dock's logic, all pure: it turns manifests, the slash-command list and
// the pane ids seen open into rows, status words and labels. Nothing here
// touches `$`, so the tests read it directly.

import type { CommandInfo } from 'claude-code'

import type { DiskMod, DockUi, LoadedMod, Scan } from '../types'

export const SELF = 'mod-dock'
export const DOCK_PANE = 'dock'
export const DOCK_TITLE = 'Mod dock'
export const DOCK_COMMAND = 'dock'

/** The Select's value while nothing is picked. A mod name never has an `@`. */
export const PLACEHOLDER = '@pick'

const SELF_NOTE = 'A dock above the prompt that lists every mod, shows which are loaded in this session, and opens or closes their windows.'

/** The pane a mod's window is, as `$.ui.open` names it, and the tab title that mod gives it. */
export type Window = { pane: string; title: string }

/** Mods whose pane id the dock knows. Any other loaded mod opens the dock's own detail view. */
const KNOWN = new Map<string, Window>([
  ['agent-radar', { pane: 'agents', title: 'Subagents' }],
  ['usage-meter', { pane: 'meter', title: 'Usage' }],
  ['conversation-atlas', { pane: 'atlas', title: 'Atlas' }],
  ['conversation-atlas-plus', { pane: 'atlas', title: 'Atlas' }],
])

export const windowOf = (name: string): Window | undefined =>
  name === SELF ? { pane: DOCK_PANE, title: DOCK_TITLE } : KNOWN.get(name)

/**
 * `loaded` means the engine shows the plugin, `idle` that it exists on disk only (installed, in a marketplace folder, or in a
 * dev-mods folder), `absent` that its folder is loaded but the mod was not seen.
 */
export type Status = 'loaded' | 'idle' | 'absent'

export const GLYPH: Record<Status, string> = { loaded: '●', idle: '○', absent: '!' }

export type Row = {
  name: string
  version: string
  description: string
  path: string
  copies: number
  status: Status
  glyph: string
  /** One plain sentence on why the mod has this status. */
  reason: string
  window: Window | undefined
  /** The slash command that opens the mod, empty when none is known. */
  command: string
  isOpen: boolean
  isSelf: boolean
  /** True when the path and version shown are the installed copy's. */
  isInstalled: boolean
  /** True when the path shown is in a marketplace folder (a folder `sync.sh` installs from) and the mod is not installed. */
  isMarket: boolean
}

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** How often the dock reads the mods folder again, so a mod made since shows without a click. */
export const RESCAN_MS = 60_000

/** Whether a rescan found the same mods: the dock writes state only when it did not, so an idle band never redraws. */
export const sameDisk = (a: readonly DiskMod[] | undefined, b: readonly DiskMod[]): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Whether a rescan looked at the same places with the same outcome. The first scan (`at` 0) always counts as new. */
export const sameScan = (old: Scan | undefined, now: Scan): boolean =>
  old !== undefined && old.at !== 0 && old.devMods === now.devMods && old.sessionDir === now.sessionDir && old.error === now.error

/**
 * The stored UI value with every field filled. A hot reload keeps `$.state` as the older version wrote it, so a field added
 * since is missing from the stored value, and every read of it goes through here.
 */
export function uiOf(stored: Partial<DockUi> | undefined): DockUi {
  return {
    isExpanded: stored?.isExpanded === true,
    focus: typeof stored?.focus === 'string' ? stored.focus : '',
    picks: typeof stored?.picks === 'number' ? stored.picks : 0,
  }
}

// ---------------------------------------------------------------------------
// Reading mods from disk

export type Manifest = { name: string; version: string; description: string }

/** The three manifest fields the dock keeps, or undefined when the text is no plugin manifest. */
export function parseManifest(text: string): Manifest | undefined {
  try {
    const data: unknown = JSON.parse(text)
    if (typeof data !== 'object' || data === null) return undefined
    const fields = data as Record<string, unknown>
    if (typeof fields.name !== 'string' || fields.name === '') return undefined

    return {
      name: fields.name,
      version: typeof fields.version === 'string' ? fields.version : '',
      description: typeof fields.description === 'string' ? clip(fields.description, 240) : '',
    }
  } catch {
    return undefined
  }
}

export type Found = Manifest & { path: string; isSession: boolean; isInstalled?: boolean; isMarket?: boolean }

/** One installed plugin, as the engine's registry lists it: `name@marketplace` and the folder it keeps a copy in. */
export type Installed = { name: string; market: string; installPath: string }

/** The engine's plugins folder, next to the mods folder: `~/.claude/plugins` for `~/.claude/dev-mods`. Empty when no mods folder is known. */
export const pluginsDirOf = (devMods: string): string => (devMods === '' ? '' : `${parentOf(devMods)}/plugins`)

function jsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const data: unknown = JSON.parse(text)

    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The installed plugins from `installed_plugins.json`: the first record of each `name@marketplace` that names a folder. */
export function parseInstalled(text: string | undefined): Installed[] {
  const plugins = jsonObject(text)?.plugins
  if (typeof plugins !== 'object' || plugins === null) return []
  const out: Installed[] = []
  for (const [key, records] of Object.entries(plugins)) {
    const at = key.lastIndexOf('@')
    const first: unknown = Array.isArray(records) ? records[0] : undefined
    const installPath = typeof first === 'object' && first !== null ? (first as Record<string, unknown>).installPath : undefined
    if (at <= 0 || typeof installPath !== 'string' || installPath === '') continue
    const name = key.slice(0, at)
    const market = key.slice(at + 1)
    if (isSafeName(name) && isSafeName(market)) out.push({ name, market, installPath })
  }

  return out
}

/** The folder of each marketplace that is a folder on disk, from `known_marketplaces.json`. The engine reads such a plugin in place there. */
export function parseMarkets(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const [market, record] of Object.entries(jsonObject(text) ?? {})) {
    const fields = typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {}
    const source = typeof fields.source === 'object' && fields.source !== null ? (fields.source as Record<string, unknown>) : {}
    if (source.source === 'directory' && typeof fields.installLocation === 'string' && fields.installLocation !== '') {
      out.set(market, fields.installLocation)
    }
  }

  return out
}

/** Whether a `hooks/hooks.json` names a hooks module: only those plugins are mods. */
export const hasModules = (text: string | undefined): boolean => /"modules"\s*:\s*\[\s*"/.test(text ?? '')

/** Where to read an installed mod: its marketplace folder when that is a folder (the engine reads it in place), else its install copy. */
export const installedPlaces = (one: Installed, markets: ReadonlyMap<string, string>): string[] => {
  const place = markets.get(one.market)

  return place === undefined ? [one.installPath] : [`${place}/${one.name}`, one.installPath]
}

/** Where the scan looks: the folder of per-session folders, which of them this session loads, and one flat folder of mods. */
export type ScanPlan = { devMods: string; sessionId: string; flat: string }

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))

const trimSlash = (path: string): string => path.replace(/\/+$/, '')

/** Works out the scan from the dock's own folder, or from the folder the user named. */
export function planOf(root: string, override: string): ScanPlan {
  const inDev = /^(.*\/dev-mods)\/([^/]+)\/[^/]+$/.exec(root)
  const sessionId = inDev?.[2] ?? ''
  const flat = inDev === null ? parentOf(root) : ''
  if (override.trim() !== '') return { devMods: trimSlash(override.trim()), sessionId, flat }
  if (inDev !== null) return { devMods: inDev[1] ?? '', sessionId, flat }
  const home = /^(\/(?:Users|home)\/[^/]+)\//.exec(root)

  return { devMods: home === null ? '' : `${home[1]}/.claude/dev-mods`, sessionId, flat }
}

/** Orders two dotted versions; a missing or odd part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(part => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }

  return 0
}

/**
 * The copy to show: the one in this session's folder, else the installed one (what a session reads), else the one in a
 * marketplace folder (what `sync.sh` installs), else the highest version, else the later path.
 */
const better = (a: Found, b: Found): Found => {
  if (a.isSession !== b.isSession) return a.isSession ? a : b
  if ((a.isInstalled === true) !== (b.isInstalled === true)) return a.isInstalled === true ? a : b
  if ((a.isMarket === true) !== (b.isMarket === true)) return a.isMarket === true ? a : b
  const byVersion = compareVersions(a.version, b.version)
  if (byVersion !== 0) return byVersion > 0 ? a : b

  return a.path >= b.path ? a : b
}

/** One entry per mod name, however many folders hold a copy of it. */
export function mergeCopies(found: readonly Found[]): DiskMod[] {
  // One folder found twice (as a mods-folder entry and as an installed or marketplace plugin) is one copy that has every flag.
  const byPath = new Map<string, Found>()
  for (const one of found) {
    const seen = byPath.get(one.path)
    byPath.set(
      one.path,
      seen === undefined
        ? one
        : {
            ...seen,
            isSession: seen.isSession || one.isSession,
            isInstalled: seen.isInstalled === true || one.isInstalled === true,
            isMarket: seen.isMarket === true || one.isMarket === true,
          },
    )
  }
  const groups = new Map<string, Found[]>()
  for (const one of byPath.values()) groups.set(one.name, [...(groups.get(one.name) ?? []), one])
  const mods: DiskMod[] = []
  for (const [name, copies] of groups) {
    const best = copies.reduce(better)
    mods.push({
      name,
      version: best.version,
      description: best.description,
      path: best.path,
      copies: copies.length,
      inSession: copies.some(one => one.isSession),
      ...(best.isInstalled === true && { isInstalled: true }),
      ...(best.isMarket === true && { isMarket: true }),
    })
  }

  return mods.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Reading what is loaded

/** A plugin's name without a `@inline` or `@marketplace` tail. */
export const baseName = (plugin: string): string => plugin.split('@')[0] ?? plugin

/** The plugins that own at least one slash command, each with its first command. */
export function loadedFrom(commands: readonly Pick<CommandInfo, 'name' | 'plugin'>[]): LoadedMod[] {
  const first = new Map<string, string>()
  for (const command of commands) {
    if (command.plugin === undefined) continue
    const name = baseName(command.plugin)
    if (!first.has(name)) first.set(name, command.name)
  }

  return [...first].map(([name, command]) => ({ name, command })).sort((a, b) => a.name.localeCompare(b.name))
}

export const sameLoaded = (a: readonly LoadedMod[], b: readonly LoadedMod[]): boolean =>
  a.length === b.length && a.every((one, i) => one.name === b[i]?.name && one.command === b[i]?.command)

/** Names from the `hidden` option: comma separated, trimmed, empties dropped. */
export const hiddenNames = (option: unknown): string[] =>
  typeof option === 'string'
    ? option
        .split(',')
        .map(name => name.trim())
        .filter(name => name !== '')
    : []

// ---------------------------------------------------------------------------
// Rows

export type RowInput = {
  disk: readonly DiskMod[]
  loaded: readonly LoadedMod[]
  panes: readonly string[]
  hidden: readonly string[]
  /** The dock's own folder, shown as its path when the scan did not find it. */
  selfRoot: string
}

const ORDER: Record<Status, number> = { loaded: 0, absent: 1, idle: 2 }

/** Where `sync.sh` sits: in the folder that holds the mod. */
const syncPathOf = (path: string): string => `${parentOf(path)}/sync.sh`

function reasonOf(mod: DiskMod, status: Status, command: string): string {
  if (mod.name === SELF) return 'This dock. It is running, so it is loaded.'
  const via = command === '' ? '' : `, seen through /${command}`
  if (status === 'loaded') {
    const copy =
      mod.path === '' || mod.inSession
        ? ''
        : mod.isInstalled === true
          ? "; the path and version are the installed copy's, and a session keeps the module it loaded until /reload-plugins or a restart"
          : '; the path is the newest copy on disk, which may not be the loaded one'

    return `Loaded in this session${via}${copy}.`
  }
  if (status === 'absent') {
    return 'This session loads its folder, but the mod was not seen: it has no slash command to show it is running, or it failed to load. A failed load is named in the transcript and the debug log; the engine does not tell mods the reason.'
  }
  if (mod.isInstalled === true) return 'Installed, but not loaded in this session. /reload-plugins loads it.'
  if (mod.isMarket === true) return `In your mods folder but not installed. Run ${syncPathOf(mod.path)} in your Terminal.`

  return 'Only in a dev-mods folder, which this session does not load. Move it into your mods folder, then run that folder\'s sync.sh.'
}

/** The rows the band and the pane draw: one per mod, the dock included, hidden mods left out. */
export function buildRows(input: RowInput): Row[] {
  const commands = new Map(input.loaded.map(one => [one.name, one.command]))
  const mods = new Map(input.disk.map(one => [one.name, one]))
  if (!mods.has(SELF)) {
    mods.set(SELF, { name: SELF, version: '', description: SELF_NOTE, path: input.selfRoot, copies: 1, inSession: true })
  }
  for (const one of input.loaded) {
    if (!mods.has(one.name) && KNOWN.has(one.name)) {
      mods.set(one.name, { name: one.name, version: '', description: '', path: '', copies: 0, inSession: false })
    }
  }
  const rows: Row[] = []
  for (const mod of mods.values()) {
    if (mod.name !== SELF && input.hidden.includes(mod.name)) continue
    const isSelf = mod.name === SELF
    const command = isSelf ? DOCK_COMMAND : (commands.get(mod.name) ?? '')
    const isLoaded = isSelf || commands.has(mod.name)
    const status: Status = isLoaded ? 'loaded' : mod.inSession ? 'absent' : 'idle'
    const window = windowOf(mod.name)
    rows.push({
      name: mod.name,
      version: mod.version,
      description: mod.description,
      path: mod.path,
      copies: mod.copies,
      status,
      glyph: GLYPH[status],
      reason: reasonOf(mod, status, command),
      window,
      command,
      isOpen: window !== undefined && input.panes.includes(window.pane),
      isSelf,
      isInstalled: mod.isInstalled === true,
      isMarket: mod.isMarket === true && mod.isInstalled !== true,
    })
  }

  return rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name))
}

/** The mods other than the dock: the band shows nothing while there are none. */
export const othersOf = (rows: readonly Row[]): Row[] => rows.filter(row => !row.isSelf)

/** `5 mods · 4 active · 1 not loaded`, or `4/5 active` where the band is narrow. */
export function summaryOf(rows: readonly Row[], isWide: boolean): string {
  const active = rows.filter(row => row.status === 'loaded').length
  if (!isWide) return `${active}/${rows.length} active`
  const parts = [plural(rows.length, 'mod'), `${active} active`]
  if (rows.length > active) parts.push(`${rows.length - active} not loaded`)

  return parts.join(' · ')
}

/** The footer button's text: `Mods 4/5`, the mods loaded out of all of them. */
export const footerLabel = (rows: readonly Row[]): string => `Mods ${rows.filter(row => row.status === 'loaded').length}/${rows.length}`

/** The chip's text: status glyph, name, and `· open` after it while its window is open. */
export const chipLabel = (row: Row): string => `${row.glyph} ${row.name}${row.isOpen ? ' · open' : ''}`

/** What a click on this mod will do, in a few words. */
export function actionNote(row: Row): string {
  if (row.status === 'idle') return row.isInstalled ? 'installed, not loaded here' : row.isMarket ? 'not installed: run sync.sh' : 'not loaded here'
  if (row.status === 'absent') return 'not seen here'
  if (row.window === undefined) return 'pick for details'

  return row.isOpen ? 'open, pick to close' : 'pick to open'
}

export const optionLabel = (row: Row): string => `${row.glyph} ${row.name} (${actionNote(row)})`

/** The toast for a click on a mod whose folder is loaded here but which the dock did not see. */
export const notSeenNote = (row: Row): string =>
  `${row.name} is in this session's folder but was not seen loaded: it has no slash command, or it failed to load. The transcript names a failed load.`

/** The toast for a click on a mod that is not loaded here: what to do so that it loads. The dock copies nothing. */
export function unloadedNote(row: Row): string {
  if (row.isInstalled) return `${row.name} is installed but not loaded in this session. Run /reload-plugins.`
  if (row.isMarket) return `${row.name} is not installed. Run ${syncPathOf(row.path)} in your Terminal.`

  return `${row.name} is only in ${row.path === '' ? 'a dev-mods folder' : row.path}. Move it into your mods folder, then run that folder's sync.sh.`
}

/** The status word beside a row in the pane. */
export function statusWord(row: Row): string {
  if (row.status === 'loaded') return row.isOpen ? 'loaded · open' : 'loaded'

  return row.status === 'absent' ? 'not seen' : 'not loaded here'
}

// ---------------------------------------------------------------------------
// Names and paths

/** Where a mod's manifest sits inside its folder. */
export const MANIFEST = '.claude-plugin/plugin.json'

/** A name from a folder listing or a registry key that is safe to join into a path: no separator, never `.` or `..`. */
export const isSafeName = (name: string): boolean => /^[A-Za-z0-9._@-]+$/.test(name) && name !== '.' && name !== '..'
