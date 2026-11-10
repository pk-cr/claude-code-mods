// usage-meter: tokens, cost, context and rate-limit windows, in a status entry,
// a band above the prompt, a pane and threshold toasts.
//
// What it reads: usage numbers from `turn.complete` and `session.measure`, the
// agent list, and `$.session.usage()` in its local-estimate mode. It never reads
// an answer, a prompt or thinking text: the only turn fields it touches are
// `agentId`, `reason` and `usage`. It makes no network, file, process or store
// call, and it sends and keeps nothing outside the session's own state.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { Ledger, Live, Ui, ViewId } from '../types'
import {
  EMPTY_UI,
  alertsFor,
  applyMeasure,
  attributed,
  emptyLedger,
  emptyLive,
  footerLine,
  hitRate,
  noteMissing,
  parseMeterArgs,
  recordTurn,
  settle,
  sightOf,
  statusLine,
  syncAgents,
  turnUsd,
} from './ledger'
import type { Sighting } from './ledger'
import { Band, Panel, bandModel, summaryText } from './views'
import type { ViewData } from './views'

const PANE = 'meter'
const PANE_TITLE = 'Usage'

const ledger = atom({ plugin: 'usage-meter', key: 'ledger' } as const, emptyLedger())
const live = atom({ plugin: 'usage-meter', key: 'live' } as const, emptyLive())
const ui = atom({ plugin: 'usage-meter', key: 'ui' } as const, EMPTY_UI)

function numberOption(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

const sameAlerts = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** Runs work that must never break the call it rides on. The meter only watches. */
async function guard(work: () => unknown): Promise<void> {
  try {
    await work()
  } catch {
    // A failed write costs a redraw, never a turn.
  }
}

async function commitLedger($: EngineInterface, fn: (value: Ledger) => Ledger): Promise<void> {
  const current = await read($, ledger)
  if (fn(current) === current) return
  await update($, ledger, fn)
}

async function commitLive($: EngineInterface, fn: (value: Live) => Live): Promise<void> {
  const current = await read($, live)
  if (fn(current) === current) return
  await update($, live, fn)
}

async function commitUi($: EngineInterface, fn: (value: Ui) => Ui): Promise<void> {
  const current = await read($, ui)
  if (fn(current) === current) return
  await update($, ui, fn)
}

async function listAgents($: EngineInterface): Promise<Sighting[]> {
  try {
    return (await $.agent.list()).map(sightOf)
  } catch {
    return []
  }
}

async function dataOf($: EngineInterface): Promise<ViewData> {
  const now = await $.clock.now()
  const ledgerNow = await read($, ledger)
  const liveNow = await read($, live)
  const uiNow = await read($, ui)

  return { ledger: ledgerNow, live: liveNow, ui: uiNow, now }
}

/** Pins the one-line status entry from the state. */
async function paint($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const ledgerNow = await read($, ledger)
  const liveNow = await read($, live)
  const mine = attributed(ledgerNow)
  $.ui.status(statusLine(liveNow, liveNow.usd ?? (mine > 0 ? mine : undefined), now))
}

type Mode = 'turn' | 'agent' | 'refresh'

/**
 * Reads `$.session.usage()` and folds it in: the context window, the rate-limit
 * windows and the engine's cost total, then the agent list, the alerts and the status.
 * `turn` and `refresh` also take the local-estimate breakdown (no network).
 */
async function measureNow($: EngineInterface, mode: Mode, costStep: number, isTurnEnd: boolean): Promise<void> {
  const now = await $.clock.now()
  const usage = await $.session.usage(mode === 'agent' ? undefined : { breakdown: 'summary' })
  await commitLive($, value => applyMeasure(value, usage, now))
  await commitLedger($, value => settle(value, usage.startedAt, usage.cost?.usd, isTurnEnd))
  const listed = await listAgents($)
  await commitLedger($, value => syncAgents(value, listed, now))
  if (mode !== 'refresh') {
    const liveNow = await read($, live)
    const uiNow = await read($, ui)
    const out = alertsFor(liveNow, now, uiNow.alerts, costStep)
    await commitUi($, value => (sameAlerts(value.alerts, out.next) ? value : { ...value, alerts: out.next }))
    for (const text of out.toasts) $.ui.toast(text)
  }
  await paint($)
}

/** Starts a ledger for this session. A reload of the mod keeps the one it has. */
async function startLedger($: EngineInterface, costStep: number, isForced: boolean): Promise<void> {
  const usage = await $.session.usage()
  const base = usage.cost?.usd ?? 0
  await commitLedger($, value => (!isForced && value.key === usage.startedAt ? value : { ...emptyLedger(usage.startedAt), base }))
  await measureNow($, 'refresh', costStep, true)
}

/** A /clear starts the conversation over: the count and the alert memory go. */
async function forget($: EngineInterface): Promise<void> {
  await commitLedger($, () => emptyLedger())
  await commitLive($, () => emptyLive())
  await commitUi($, value => (Object.keys(value.alerts).length === 0 ? value : { ...value, alerts: {} }))
  $.ui.status(undefined)
}

/** The fields of a turn the meter reads. It is handed these and nothing else of the event. */
type TurnFacts = { reason: string; agentId?: string; usage?: TurnUsage }

/** Adds one finished loop turn to the ledger. */
async function noteTurn($: EngineInterface, turn: TurnFacts, costStep: number): Promise<void> {
  const usage = turn.usage
  if (usage === undefined) {
    await commitLedger($, value => noteMissing(value, turn.reason))
    return
  }
  const now = await $.clock.now()
  const listed = turn.agentId === undefined ? [] : await listAgents($)
  const sight = listed.find(one => one.id === turn.agentId)
  await commitLedger($, value => syncAgents(recordTurn(value, { agentId: turn.agentId, usage, now, sight }), listed, now))
  if (turn.agentId === undefined) {
    await paint($)
  } else {
    // A background agent can end after the main turn did, and no measure follows it.
    await measureNow($, 'agent', costStep, false)
  }
}

/** The line under a main-loop answer, or undefined when the footer is off or the turn had no usage. */
async function footerFor($: EngineInterface, turn: TurnFacts): Promise<string | undefined> {
  try {
    const usage = turn.usage
    if (usage === undefined) return undefined
    const uiNow = await read($, ui)
    if (!uiNow.footer) return undefined
    const ledgerNow = await read($, ledger)

    return footerLine({
      turnUsd: turnUsd(usage),
      out: usage.output_tokens,
      hit: hitRate(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens),
      agentsUsd: ledgerNow.win.agents,
      session: (ledgerNow.base ?? 0) + attributed(ledgerNow),
    })
  } catch {
    return undefined
  }
}

async function showView($: EngineInterface, view: ViewId): Promise<void> {
  await guard(() => commitUi($, value => (value.view === view ? value : { ...value, view })))
}

async function refreshNow($: EngineInterface, costStep: number): Promise<void> {
  await guard(() => measureNow($, 'refresh', costStep, false))
}

async function openPane($: EngineInterface): Promise<void> {
  await guard(() => $.ui.open({ id: PANE, title: PANE_TITLE }))
}

async function statusText($: EngineInterface): Promise<string> {
  return summaryText(await dataOf($))
}

export const register: Register = (on, options) => {
  const costStep = numberOption(options['costAlertUsd'], 10)

  on('session.start', async ($, e, next) => {
    // Apart, so that one failing does not keep the others from starting.
    await guard(async () => {
      await $.command.register({
        name: 'meter',
        description: 'Open the usage pane, or: /meter models | agents | diag | refresh | status | reset | footer on|off',
      })
    })
    await guard(() => startLedger($, costStep, false))

    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    const asked = parseMeterArgs(e.args)
    if (asked.kind === 'bad') return { text: asked.usage }
    if (asked.kind === 'footer') {
      await commitUi($, value => (value.footer === asked.isOn ? value : { ...value, footer: asked.isOn }))

      return { text: `Footer ${asked.isOn ? 'on' : 'off'}.` }
    }
    if (asked.kind === 'reset') {
      await guard(() => startLedger($, costStep, true))

      return { text: 'Count cleared. The meter counts again from this turn on.' }
    }
    if (asked.kind === 'view') {
      await commitUi($, value => (value.view === asked.view ? value : { ...value, view: asked.view }))
      const shown = await $.ui.open({ id: PANE, title: PANE_TITLE })

      return { text: shown.isPlaced ? `Usage pane: ${asked.view}.` : `The usage pane waits: ${shown.reason}` }
    }
    if (asked.kind === 'refresh') {
      await refreshNow($, costStep)

      return { text: 'Usage read again.' }
    }
    if (asked.kind === 'status') return { text: await statusText($) }
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })

    return { text: opened.isPlaced ? 'Usage pane opened.' : `The usage pane waits: ${opened.reason}` }
  })

  on('turn.complete', async ($, e, next) => {
    // Only these three fields leave the event. The answer text is never read.
    const facts: TurnFacts = { reason: e.reason, agentId: e.agentId, usage: e.usage }
    await guard(() => noteTurn($, facts, costStep))
    // A subagent's text is its answer to its parent: it passes through untouched.
    if (e.agentId !== undefined) return next(e)
    const ending = await next(e)
    const text = await footerFor($, facts)

    return text === undefined ? ending : { ...ending, text }
  })

  on('session.measure', async ($, e, next) => {
    await guard(() => measureNow($, 'turn', costStep, e.changed.includes('cost')))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await guard(() => forget($))

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const data = await dataOf($)
    const band = bandModel(data, e.props.bodyColumns)
    if (band === undefined) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // Another mod may draw this band too: keep what is beneath and put ours under it.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {below}
        {Band({ Box, Text, Button }, band, () => void openPane($))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await dataOf($)

    return Panel({ Box, Text, Button }, data, e.props.bodyColumns, {
      onView: view => void showView($, view),
      onRefresh: () => void refreshNow($, costStep),
    })
  })
}
