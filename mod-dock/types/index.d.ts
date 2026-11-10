// State contract of mod-dock: what its hooks write and its drawings read.
// Every value is plain data, so the host can hold it across a hot reload.
// It holds mod names, versions, short manifest descriptions, folder paths and
// pane ids. It never holds a prompt, an answer, thinking text or file contents
// other than those manifest fields.

/** One mod found on disk, de-duplicated by name (one entry for every copy of it). */
export type DiskMod = {
  name: string
  version: string
  /** The manifest's description, clipped. */
  description: string
  /** Folder of the copy the dock shows: this session's own when it has one, else the highest version. */
  path: string
  /** How many folders hold a mod of this name. */
  copies: number
  /** True when a copy sits in the folder this session loads. */
  inSession: boolean
  /** True when the copy shown is the installed one (the folder the engine loads for an installed plugin). Absent in values an older version stored. */
  isInstalled?: boolean
  /** True when the copy shown sits in a marketplace folder, the folder `sync.sh` installs from. Absent in values an older version stored. */
  isMarket?: boolean
}

/** A plugin seen on the slash-command list, which is the engine's one passive sign that it is loaded. */
export type LoadedMod = {
  name: string
  /** The first slash command the plugin owns, without the slash. */
  command: string
}

/** What the last disk scan looked at and how it went. */
export type Scan = {
  /** Clock time of the scan, 0 before the first. */
  at: number
  /** The mods folder that was listed, empty when none could be worked out. */
  devMods: string
  /** The folder this session loads, empty when the dock does not sit in one. */
  sessionDir: string
  /** A short plain sentence when a folder could not be read, else empty. */
  error: string
}

export type DockUi = {
  /** True while the chip row shows under the one-line band. */
  isExpanded: boolean
  /** The mod the dock pane marks, set when a click has no window of its own to open. */
  focus: string
  /** Counts the clicks on a mod, so the band draws again and its Select goes back to the placeholder even when a click changed nothing else. */
  picks: number
}

declare module 'claude-code' {
  interface PluginState {
    'mod-dock': {
      disk: DiskMod[]
      loaded: LoadedMod[]
      /** Ids of the panes seen open, from the dock's own opens and the `ui.open` and `ui.close` events. */
      panes: string[]
      ui: DockUi
      scan: Scan
    }
  }
}
