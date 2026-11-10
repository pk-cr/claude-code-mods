// What the band and the pane draw. The band is one line while collapsed: the
// title, the count summary, a Select over every mod and a toggle for the chip
// row. The chip row and the pane use Box, Text and Button, which every surface has.

import type { Elements, RenderElement } from 'claude-code'

import type { Scan } from '../types'
import { PLACEHOLDER, chipLabel, optionLabel, statusWord, summaryOf } from './dock'
import type { Row } from './dock'

export type BandEls = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Select'>
/** The pane is raised on every surface, and the mobile table has no Select, so the pane's Select is optional. */
export type PanelEls = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & { Select?: Elements['terminal']['Select'] }
export type FooterEls = Pick<Elements['terminal'], 'Box' | 'Button'>

/** The Select's options: a placeholder, then every mod with its status and what a pick does. */
const pickOptions = (rows: readonly Row[]) => [
  { value: PLACEHOLDER, label: 'pick a mod…' },
  ...rows.map(row => ({ value: row.name, label: optionLabel(row) })),
]

/** The button in the prompt footer: it opens the dock pane, so the dock stays reachable when another mod holds the band. */
export function Footer({ Box, Button }: FooterEls, below: RenderElement, label: string, onPress: () => void) {
  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      {below}
      <Button key="dock-footer" dimColor label={label} onPress={() => onPress()} />
    </Box>
  )
}

/** Narrower than this and the band says `4/5 active` rather than the whole summary. */
export const WIDE_BAND = 72

export type BandActions = {
  onPick: (name: string) => void
  onChips: () => void
  onRefresh: () => void
  onDetails: () => void
}

export function Band(
  { Box, Text, Button, Select }: BandEls,
  rows: readonly Row[],
  isExpanded: boolean,
  columns: number,
  act: BandActions,
) {
  const options = pickOptions(rows)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2} alignItems="center">
        <Text bold>Mods</Text>
        <Text wrap="truncate-end">{summaryOf(rows, columns >= WIDE_BAND)}</Text>
        <Select
          key="mods"
          label="open"
          options={options}
          value={PLACEHOLDER}
          onSelect={value => {
            if (value !== PLACEHOLDER) act.onPick(value)
          }}
        />
        <Button key="chips" label={isExpanded ? 'hide' : 'chips'} dimColor onPress={() => act.onChips()} />
      </Box>
      {isExpanded && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {rows.map(row => (
            <Button
              key={`mod-${row.name}`}
              label={chipLabel(row)}
              variant={row.isOpen ? 'primary' : undefined}
              dimColor={row.status !== 'loaded'}
              onPress={() => act.onPick(row.name)}
            />
          ))}
          <Button key="refresh" label="refresh" dimColor onPress={() => act.onRefresh()} />
          <Button key="details" label="details" dimColor onPress={() => act.onDetails()} />
        </Box>
      )}
    </Box>
  )
}

export type PanelView = {
  rows: readonly Row[]
  scan: Scan
  focus: string
  /** Characters across the pane body. */
  columns: number
}

export type PanelActions = {
  onRefresh: () => void
  onToggle: (name: string) => void
  onPick: (name: string) => void
}

/** The line that says where the dock looked, and what went wrong when something did. */
export function whereLine(scan: Scan): string {
  if (scan.at === 0) return 'Not scanned yet.'
  const folder = scan.devMods === '' ? 'no mods folder was worked out' : `mods folder: ${scan.devMods}`

  return scan.sessionDir === '' ? folder : `${folder} · this session loads: ${scan.sessionDir}`
}

const actionLabel = (row: Row): string => (row.window === undefined ? 'details' : row.isOpen ? 'close' : 'open')

export function Panel({ Box, Text, Button, Select }: PanelEls, view: PanelView, act: PanelActions) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2} alignItems="center">
        <Text bold>Mod dock</Text>
        <Text>{summaryOf(view.rows, true)}</Text>
        <Button key="refresh" label="refresh" onPress={() => act.onRefresh()} />
      </Box>
      {Select !== undefined && (
        <Select
          key="mods"
          label="open"
          options={pickOptions(view.rows)}
          value={PLACEHOLDER}
          onSelect={value => {
            if (value !== PLACEHOLDER) act.onPick(value)
          }}
        />
      )}
      <Text dimColor wrap="truncate-middle">
        {whereLine(view.scan)}
      </Text>
      {view.scan.error !== '' && <Text color="yellow">{view.scan.error}</Text>}
      {view.rows.map(row => (
        <Box key={`row-${row.name}`} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text bold={row.name === view.focus}>{`${row.name === view.focus ? '▶' : ' '} ${row.glyph} ${row.name}`}</Text>
            {row.version !== '' && <Text dimColor>{`v${row.version}`}</Text>}
            <Text dimColor>{statusWord(row)}</Text>
            {row.status === 'loaded' && (
              <Button key={`act-${row.name}`} label={actionLabel(row)} onPress={() => act.onToggle(row.name)} />
            )}
          </Box>
          <Text dimColor wrap="wrap">
            {row.description === '' ? '(no description)' : row.description}
          </Text>
          <Text dimColor wrap="truncate-middle">
            {row.path === '' ? 'path: not known' : `${row.path}${row.copies > 1 ? ` (${row.copies} copies)` : ''}`}
          </Text>
          <Text dimColor wrap="wrap">
            {row.reason}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
