// mod-dock: a one-line band above the prompt that lists every mod, marks which
// are loaded in this session and opens or closes each mod's window, plus a
// /dock pane with the full list and details. A pick of a mod that is not loaded
// opens nothing and says what to do: the dock never loads or copies a mod.
//
// What it reads: each mod's manifest on disk (`$.fs.list` and `$.fs.read`), the
// engine's installed-plugin registry and marketplace list (two JSON files), the
// slash-command list (`$.command.list`, names and owning plugin only) and the
// `ui.open` and `ui.close` events (a pane id and who closed it). It never reads a
// prompt, an answer or thinking text.
//
// It writes nothing: no `$.fs.write`, and no network, process, environment,
// settings, tool, prompt or store call. It logs nothing.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DockUi, Scan } from '../types'
import {
  DOCK_PANE,
  DOCK_TITLE,
  MANIFEST,
  RESCAN_MS,
  buildRows,
  footerLabel,
  hasModules,
  hiddenNames,
  installedPlaces,
  loadedFrom,
  mergeCopies,
  notSeenNote,
  othersOf,
  parseInstalled,
  parseManifest,
  parseMarkets,
  planOf,
  pluginsDirOf,
  sameDisk,
  sameLoaded,
  sameScan,
  summaryOf,
  uiOf,
  unloadedNote,
} from './dock'
import type { Found, Row } from './dock'
import { Band, Footer, Panel } from './views'

const disk = atom({ plugin: 'mod-dock', key: 'disk' } as const, [])
const loaded = atom({ plugin: 'mod-dock', key: 'loaded' } as const, [])
const panes = atom({ plugin: 'mod-dock', key: 'panes' } as const, [])
const ui = atom({ plugin: 'mod-dock', key: 'ui' } as const, { isExpanded: false, focus: '', picks: 0 } satisfies DockUi)
const scan = atom({ plugin: 'mod-dock', key: 'scan' } as const, { at: 0, devMods: '', sessionDir: '', error: '' } satisfies Scan)

/** What the options hold: the mods to leave out, and the mods folder the person named. */
type Opts = { hidden: readonly string[]; modsDir: string }

/** Runs a step that may fail and answers undefined when it does: a dock step never breaks a turn. */
async function guard<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Reading mods

/**
 * The mods one folder holds: each sub-folder with a readable `.claude-plugin/plugin.json`. A marketplace folder also holds
 * plugins that are not mods, so there a sub-folder counts only when its hooks.json names a hooks module.
 */
async function foundIn($: EngineInterface, dir: string, isSession: boolean, isMarket: boolean): Promise<Found[]> {
  const entries = (await guard(() => $.fs.list(dir))) ?? []
  const found = await Promise.all(
    entries
      // A mod's folder never starts with a dot: `.claude` and `.claude-plugin` sit beside the mods in the mods folder.
      .filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.'))
      .map(async (entry): Promise<Found | undefined> => {
        const path = `${dir}/${entry.name}`
        if (isMarket) {
          const hooks = await guard(() => $.fs.read(`${path}/hooks/hooks.json`))
          if (!hasModules(typeof hooks === 'string' ? hooks : undefined)) return undefined
        }
        const text = await guard(() => $.fs.read(`${path}/${MANIFEST}`))
        const manifest = typeof text === 'string' ? parseManifest(text) : undefined

        return manifest === undefined ? undefined : { ...manifest, path, isSession, ...(isMarket && { isMarket: true }) }
      }),
  )

  return found.filter((one): one is Found => one !== undefined)
}

/**
 * The mods the engine installs from: the registry names each installed plugin's folder (a plugin whose marketplace is a folder
 * is read in place there, so that folder's manifest is the version a session loads), and each marketplace that is a folder
 * holds the mods `sync.sh` would install. Plugins without a hooks module are not mods.
 */
async function registryFound($: EngineInterface, devMods: string): Promise<Found[]> {
  const dir = pluginsDirOf(devMods)
  if (dir === '') return []
  const registry = await guard(() => $.fs.read(`${dir}/installed_plugins.json`))
  const markets = parseMarkets(await guard(() => $.fs.read(`${dir}/known_marketplaces.json`)))
  const installed = await Promise.all(
    parseInstalled(typeof registry === 'string' ? registry : undefined).map(async (one): Promise<Found | undefined> => {
      for (const path of installedPlaces(one, markets)) {
        const hooks = await guard(() => $.fs.read(`${path}/hooks/hooks.json`))
        if (!hasModules(typeof hooks === 'string' ? hooks : undefined)) continue
        const text = await guard(() => $.fs.read(`${path}/${MANIFEST}`))
        const manifest = typeof text === 'string' ? parseManifest(text) : undefined
        if (manifest !== undefined) return { ...manifest, path, isSession: false, isInstalled: true }
      }

      return undefined
    }),
  )
  const folders = await Promise.all([...markets.values()].map(place => foundIn($, place, false, true)))

  return [...installed.filter((one): one is Found => one !== undefined), ...folders.flat()]
}

/** Lists the mods folder and every session folder in it, and keeps one entry per mod name. */
async function scanDisk($: EngineInterface, override: string): Promise<void> {
  const plan = planOf($.plugin.root, override)
  const found: Found[] = []
  const problems: string[] = []
  if (plan.devMods !== '') {
    const sessions = await guard(() => $.fs.list(plan.devMods))
    if (sessions === undefined) {
      problems.push(`Could not list ${plan.devMods}.`)
    } else {
      const groups = await Promise.all(
        sessions
          .filter(entry => entry.kind === 'dir')
          .map(entry => foundIn($, `${plan.devMods}/${entry.name}`, entry.name === plan.sessionId, false)),
      )
      for (const group of groups) found.push(...group)
    }
  }
  if (plan.flat !== '') found.push(...(await foundIn($, plan.flat, false, false)))
  found.push(...(await registryFound($, plan.devMods)))
  if (plan.devMods === '' && plan.flat === '') problems.push('No mods folder was worked out. Set Mods folder in /config.')
  // State is written only when the scan found something new, so a scan that changes nothing redraws nothing.
  if (found.length > 0 || problems.length === 0) {
    const mods = mergeCopies(found)
    if (!sameDisk(await read($, disk), mods)) await update($, disk, () => mods)
  }
  const now: Scan = {
    at: await $.clock.now(),
    devMods: plan.devMods,
    sessionDir: plan.devMods === '' || plan.sessionId === '' ? '' : `${plan.devMods}/${plan.sessionId}`,
    error: problems.join(' '),
  }
  if (!sameScan(await read($, scan), now)) await update($, scan, () => now)
}

/** The UI value with every field filled: a hot reload keeps what an older version stored, which may lack newer fields. */
async function uiNow($: EngineInterface): Promise<DockUi> {
  return uiOf(await read($, ui))
}

async function rowsOf($: EngineInterface, hidden: readonly string[]): Promise<Row[]> {
  return buildRows({
    disk: await read($, disk),
    loaded: await read($, loaded),
    panes: await read($, panes),
    hidden,
    selfRoot: $.plugin.root,
  })
}

// ---------------------------------------------------------------------------
// Opening and closing windows

async function showDock($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: DOCK_PANE, title: DOCK_TITLE })
  await update($, panes, list => (list.includes(DOCK_PANE) ? list : [...list, DOCK_PANE]))

  return opened.isPlaced
}

/** Opens a loaded mod's window, or the dock's detail view for a mod that has no window of its own. */
async function showWindow($: EngineInterface, row: Row): Promise<void> {
  const win = row.window
  if (win === undefined) {
    await update($, ui, value => ({ ...uiOf(value), focus: row.name }))
    await guard(() => showDock($))

    return
  }
  try {
    const opened = await $.ui.open({ id: win.pane, title: win.title })
    await update($, panes, list => (list.includes(win.pane) ? list : [...list, win.pane]))
    if (!opened.isPlaced) $.ui.toast(`${row.name} waits for room: ${opened.reason}`)
  } catch {
    const hint = row.command === '' ? '' : `; try /${row.command}`
    $.ui.toast(`${row.name} would not open from the dock${hint}`)
  }
}

/** Closes a loaded mod's window, or opens it when it is shut. A mod with no window of its own shows in the dock's pane. */
async function flipWindow($: EngineInterface, row: Row): Promise<void> {
  const win = row.window
  if (win === undefined || !row.isOpen) {
    await showWindow($, row)

    return
  }
  try {
    await $.ui.close({ id: win.pane })
    await update($, panes, list => list.filter(id => id !== win.pane))
  } catch {
    const hint = row.command === '' ? '' : `; try /${row.command}`
    $.ui.toast(`${row.name} would not close from the dock${hint}`)
  }
}

/** Reads which plugins own a slash command: the engine's one passive sign of what is loaded. */
async function refreshLoaded($: EngineInterface): Promise<void> {
  const commands = await guard(() => $.command.list())
  if (commands === undefined) return
  const now = loadedFrom(commands)
  if (!sameLoaded(await read($, loaded), now)) await update($, loaded, () => now)
}

/** Reads the mods folder and the command list again: a mod made or loaded since shows without a click. */
async function rescan($: EngineInterface, opts: Opts): Promise<void> {
  await scanDisk($, opts.modsDir)
  await refreshLoaded($)
}

/** A pick in the Select or on a chip: counted, so the Select draws its placeholder again, then acted on. */
async function pickMod($: EngineInterface, opts: Opts, name: string): Promise<void> {
  await guard(async () => {
    await update($, ui, value => ({ ...uiOf(value), picks: uiOf(value).picks + 1 }))
    await toggleMod($, opts, name)
  })
}

/** The dock pane opened, or closed when it is open: what the footer button does. */
async function toggleDock($: EngineInterface): Promise<void> {
  if (!(await read($, panes)).includes(DOCK_PANE)) {
    await showDock($)

    return
  }
  try {
    await $.ui.close({ id: DOCK_PANE })
    await update($, panes, list => list.filter(id => id !== DOCK_PANE))
  } catch {
    $.ui.toast('The dock pane would not close')
  }
}

/** One click on a mod: open its window, or close it when it is open. A mod that is not loaded gets a note and nothing else. */
async function toggleMod($: EngineInterface, opts: Opts, name: string): Promise<void> {
  const row = (await rowsOf($, opts.hidden)).find(one => one.name === name)
  if (row === undefined) return
  if (row.status === 'absent') $.ui.toast(notSeenNote(row))
  else if (row.status === 'idle') $.ui.toast(unloadedNote(row))
  else await flipWindow($, row)
}

export const register: Register = (on, options) => {
  const opts: Opts = {
    hidden: hiddenNames(options.hidden),
    modsDir: typeof options.modsDir === 'string' ? options.modsDir : '',
  }
  let pending: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await guard(() =>
      $.command.register({
        name: 'dock',
        description: 'Show every mod with its status, and open or close its window',
        argumentHint: '[refresh]',
      }),
    )
    // Other mods register their commands in their own session.start, so read the list again a moment later.
    $.clock.after(100, () => void guard(() => scanDisk($, opts.modsDir)))
    $.clock.after(1500, () => void guard(() => refreshLoaded($)))
    // A mod made later, in this session or another, shows up on the next pass.
    $.clock.every(RESCAN_MS, () => void guard(() => rescan($, opts)))

    return next(e)
  })

  // A mod that loads later (a hot reload, a new mod in this session, or one the dock just copied) registers its command after the dock started.
  on('command.register', async ($, e, next) => {
    const done = await next(e)
    pending?.cancel()
    pending = $.clock.after(400, () => void guard(() => rescan($, opts)))

    return done
  })

  // Every pane open and close in the session passes here, so the chips show a window the person opened or closed by hand.
  on('ui.open', async ($, e, next) => {
    const opened = await next(e)
    await guard(() => update($, panes, list => (list.includes(e.id) ? list : [...list, e.id])))

    return opened
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    await guard(() => update($, panes, list => list.filter(id => id !== e.id)))

    return closed
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await guard(() => update($, panes, () => []))

    return next(e)
  })

  on('command.run', { command: 'dock' }, async ($, e) => {
    const word = e.args.trim()
    if (word !== '' && word !== 'refresh') {
      return { text: 'Usage: /dock opens the list of mods. /dock refresh reads the mods folder and the command list again.' }
    }
    await guard(() => rescan($, opts))
    const summary = summaryOf(await rowsOf($, opts.hidden), true)
    if (word === 'refresh') return { text: `Mod dock refreshed: ${summary}.` }
    const isPlaced = await guard(() => showDock($))

    return { text: isPlaced === false ? `Mod dock is waiting for room: ${summary}.` : `Mod dock opened: ${summary}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The mobile table has no Select; the band is raised on the terminal and the desktop only.
    if (e.props.hasSurvey || e.surface === 'mobile') return next(e)
    const rows = await rowsOf($, opts.hidden)
    if (othersOf(rows).length === 0) return next(e)
    const { isExpanded } = await uiNow($)
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    // Another mod may draw this band too: keep what is beneath and put ours under it.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {below}
        {Band({ Box, Text, Button, Select }, rows, isExpanded, e.props.bodyColumns, {
          // Each handler returns its promise, so the engine waits for it and the open counts as the person's own.
          onPick: name => pickMod($, opts, name),
          onChips: () => update($, ui, value => ({ ...uiOf(value), isExpanded: !uiOf(value).isExpanded })),
          onRefresh: () => guard(() => rescan($, opts)),
          onDetails: () => guard(() => showDock($)),
        })}
      </Box>
    )
  })

  // The footer button: the dock stays one click away when another mod holds the band above the prompt.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const rows = await rowsOf($, opts.hidden)
    const below = await next(e)
    if (othersOf(rows).length === 0) return below
    const { Box, Button } = $.ui.resolve(e)

    return Footer({ Box, Button }, below, footerLabel(rows), () => toggleDock($))
  })

  on('ui.render', { component: 'Pane', requestId: 'dock' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // The mobile table has no Select, so the pane draws without one there.
    const Select = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Select
    const rows = await rowsOf($, opts.hidden)
    const { focus } = await uiNow($)

    return Panel(
      { Box, Text, Button, Select },
      { rows, scan: await read($, scan), focus, columns: e.props.bodyColumns },
      {
        onRefresh: () => guard(() => rescan($, opts)),
        onToggle: name => guard(() => toggleMod($, opts, name)),
        onPick: name => pickMod($, opts, name),
      },
    )
  })
}
