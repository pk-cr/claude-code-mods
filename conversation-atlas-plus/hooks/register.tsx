// Conversation Atlas Plus: a live map of this Claude Code session and your other sessions. It shows
// your goal, what Claude is doing now, tasks, open questions, the conversation, activity, working
// files and sessions.
//
// Sources, all inside this session: your prompts and Claude's replies (turn events), tool calls,
// subagent starts and ends, background jobs, sessions Claude starts, chapters Claude marks, Claude's
// own todo and plan lists, and what you set in the pane or with /atlas.
//
// Outbound calls. These are the only ones this module makes, and tests/egress.test.tsx holds it:
//   $.model.complete({ model: 'haiku' })  a short digest after each answer  (summaries: both, each turn)
//   $.model.fork                           /atlas sync and the Sync button   (summaries: both, on demand)
//     Both go through this session's own Anthropic client.
//   $.mcp.call('ccd_session_mgmt', 'list_sessions')  the Claude desktop app's session list on this Mac
//                                                    (desktopSessions: on); it sends no session content.
//   $.prompt.submit   one of your tasks, as your own words, to Claude in this session  (only when you press
//                     Ask Claude or type /atlas ask)
//   $.agent.spawn     one of your tasks to a background fork of this session  (only when you press
//                     Background or type /atlas bg)
// No $.http, $.process, $.fs, $.tool or other MCP servers. The map stays in $.state and $.store.

import { type EngineInterface, type Register, type Timer, update } from 'claude-code'

import type { AtlasState, AtlasUi } from '../types'
import {
  addQuestion,
  addTask,
  agentFinished,
  alignmentLine,
  applyNotice,
  applySuggested,
  applyToolResult,
  clearGoal,
  countAgent,
  countTool,
  dismiss,
  dispatchTask,
  effectiveGoal,
  emptyState,
  endActivity,
  endRequest,
  type HistoryRow,
  hydrate,
  isOpen,
  isSummary,
  linkAgent,
  openQuestions,
  openTasks,
  releaseTask,
  replay,
  type SessionSummary,
  setGoal,
  setQuestion,
  setTask,
  setTaskByRef,
  startActivity,
  startRequest,
  summaryOf,
  takeNotes,
  upgrade,
} from './model'
import { askedQuestions, classify, clip, norm, notices, posix, stripPromptMarkers } from './signals'
import { buildDigest, buildSyncPrompt, type DesktopSession, mergeSessions, parseDesktopSessions, parseSummary, SUMMARY_SYSTEM } from './summary'
import { pane, TASK_FROM, type ViewAction } from './view'

const ATLAS = { plugin: 'conversation-atlas-plus', key: 'atlas' } as const
const UI = { plugin: 'conversation-atlas-plus', key: 'ui' } as const
const PANE = 'atlas'
const COLUMNS = 48
const SAVE_MS = 2_000
// Save ticks between two reads of the sessions list: one minute.
const SESSIONS_EVERY = 30
const SUMMARY_DELAY_MS = 3_000
const INDEX_MAX = 40
const STATES_MAX = 10
const DESKTOP_SERVER = 'ccd_session_mgmt'
const DEFAULT_UI: AtlasUi = {
  expanded: null,
  editingGoal: false,
  showDone: false,
  showAllRequests: false,
  sync: { running: false, note: null },
  sessions: [],
}

type Summaries = 'both' | 'each turn' | 'on demand' | 'off'

let summaries: Summaries = 'both'
let desktopSessions = true
let align = true
let sid = ''
let root = ''
let ready: Promise<void> | null = null
let saving: Timer | null = null
let summaryTimer: Timer | null = null
let summaryBusy = false
let lastSaved = ''
let ticks = 0
let activitySeq = 0
const agentNames = new Map<string, string>()
// The first words of each subagent's prompt, so its own first turn is not read as your request.
const spawnPrompts: string[] = []
// The first words of the background agents Atlas starts, so they show as your task, not as a second task.
const selfSpawns: string[] = []

function remember(list: string[], head: string): void {
  if (!head) return
  list.push(head)
  if (list.length > 20) list.shift()
}

const autoSummary = () => summaries === 'both' || summaries === 'each turn'
const syncAllowed = () => summaries === 'both' || summaries === 'on demand'

// ------------------------------------------------------------------ state

async function atlas($: EngineInterface): Promise<AtlasState | undefined> {
  const value = (await $.state.get(ATLAS)).value
  return value && value.v === 2 ? value : undefined
}

async function editAtlas($: EngineInterface, fn: (s: AtlasState, now: number) => AtlasState): Promise<AtlasState> {
  const now = await $.clock.now()
  return update($, ATLAS, cur => fn(cur && cur.v === 2 && cur.sessionId === sid ? cur : emptyState(sid, root, now), now))
}

async function editUi($: EngineInterface, fn: (u: AtlasUi) => AtlasUi): Promise<void> {
  await update($, UI, cur => fn({ ...DEFAULT_UI, ...(cur ?? {}) }))
}

async function readIndex($: EngineInterface): Promise<SessionSummary[]> {
  const value = await $.store.get('index')
  return Array.isArray(value) ? value.filter(isSummary) : []
}

// ------------------------------------------------------------------ binding and saving

async function history($: EngineInterface): Promise<HistoryRow[]> {
  try {
    const rows = await $.session.messages()
    return Array.isArray(rows) ? (rows as unknown as HistoryRow[]) : []
  } catch {
    return []
  }
}

// Binds the map to the live session: the same id keeps it (a hot reload), a saved one comes back (a
// resume), otherwise the transcript so far is replayed so the map starts where the conversation is.
async function bind($: EngineInterface): Promise<void> {
  const [id, r] = await Promise.all([$.session.id(), $.session.root()])
  sid = id
  root = posix(r)
  const cur = (await $.state.get(ATLAS)).value
  if (cur && cur.v === 2 && cur.sessionId === sid) {
    const upgraded = upgrade(cur)
    if (upgraded !== cur) await $.state.set(ATLAS, upgraded)
    return
  }
  const now = await $.clock.now()
  const saved = await $.store.get(`s:${sid}`)
  const next = saved ? hydrate(saved, sid, root, now) : replay(emptyState(sid, root, now), await history($), now)
  await $.state.set(ATLAS, next)
}

async function ensureBound($: EngineInterface): Promise<void> {
  await setup($)
  if (!sid || (await $.session.id()) !== sid) await bind($)
}

// Version 0.1 kept other keys, with prompt excerpts, in this plugin's store. They are removed once.
async function dropOldStore($: EngineInterface): Promise<void> {
  for (const key of await $.store.keys()) {
    if (key === 'setup' || key === 'trail-view' || key.startsWith('session:') || key.startsWith('project:')) await $.store.delete(key)
  }
}

// The map goes to the store on this Mac: the full map of the last few sessions, and one summary row
// per session for the Sessions list.
async function save($: EngineInterface): Promise<void> {
  const s = await atlas($)
  if (!s || s.sessionId !== sid) return
  const text = JSON.stringify(s)
  if (text === lastSaved) return
  lastSaved = text
  await $.store.set(`s:${s.sessionId}`, s)
  const row = summaryOf(s)
  const index = [row, ...(await readIndex($)).filter(r => r.id !== row.id)].sort((a, b) => b.lastActive - a.lastActive).slice(0, INDEX_MAX)
  await $.store.set('index', index)
  const kept = new Set(index.slice(0, STATES_MAX).map(r => `s:${r.id}`))
  kept.add(`s:${s.sessionId}`)
  for (const key of await $.store.keys()) if (key.startsWith('s:') && !kept.has(key)) await $.store.delete(key)
}

// The Sessions list: Atlas's own records, plus the desktop app's session list when that is on. A
// refused or failed read shows Atlas's records alone, without a message.
async function refreshSessions($: EngineInterface): Promise<void> {
  const s = await atlas($)
  const index = await readIndex($)
  let desktop: DesktopSession[] = []
  if (desktopSessions) {
    try {
      const result = await $.mcp.call(DESKTOP_SERVER, 'list_sessions', { limit: 20 })
      if (!result.isError) desktop = parseDesktopSessions(result)
    } catch {
      desktop = []
    }
  }
  const sessions = mergeSessions(s ? summaryOf(s) : null, index, desktop, root)
  await editUi($, u => ({ ...u, sessions }))
}

// ------------------------------------------------------------------ summaries

function scheduleSummary($: EngineInterface): void {
  if (!autoSummary()) return
  summaryTimer?.cancel()
  summaryTimer = $.clock.after(SUMMARY_DELAY_MS, () => {
    summaryTimer = null
    void summarize($).catch(() => undefined)
  })
}

// A short digest goes to Haiku through this session's own Anthropic client. Any failure is silent.
async function summarize($: EngineInterface): Promise<void> {
  if (summaryBusy) return
  const s = await atlas($)
  if (!s || !s.requests.length) return
  summaryBusy = true
  try {
    const reply = await $.model.complete({ model: 'haiku', system: SUMMARY_SYSTEM, prompt: buildDigest(s), maxTokens: 600 })
    if (!reply.isAnswered) return
    const parsed = parseSummary(reply.text)
    if (parsed) await editAtlas($, (cur, now) => applySuggested(cur, parsed, 'haiku', now))
  } finally {
    summaryBusy = false
  }
}

// /atlas sync and the Sync button: Claude re-reads this whole session from its cache and suggests the
// goal, outstanding work and open threads.
async function syncWithClaude($: EngineInterface): Promise<string> {
  if (!syncAllowed()) return 'Sync is off in the Summaries setting.'
  await editUi($, u => ({ ...u, sync: { running: true, note: null } }))
  let note: string | null = null
  try {
    const reply = await $.model.fork({ prompt: buildSyncPrompt(await atlas($)) })
    if (!reply.isAnswered) {
      note = reply.reason === 'nothing-to-fork' ? 'Nothing to sync yet.' : 'Sync did not finish.'
    } else {
      const parsed = parseSummary(reply.text)
      if (parsed) await editAtlas($, (cur, now) => applySuggested(cur, parsed, 'claude', now))
      else note = 'Sync reply could not be read.'
    }
  } catch {
    note = 'Sync did not finish.'
  }
  await editUi($, u => ({ ...u, sync: { running: false, note } }))
  return note ?? 'Synced: the map shows what Claude reads from this session.'
}

// ------------------------------------------------------------------ sending a task to Claude

function askText(id: string, text: string): string {
  return [
    `Atlas task ${id}: ${text}`,
    `Please do this task now. When it is finished, end your reply with the line "Atlas: done ${id}". If you cannot finish it, end with "Atlas: not done ${id} - <one-line reason>".`,
  ].join('\n')
}

function backgroundText(id: string, text: string): string {
  return [
    `Atlas task ${id}: ${text}`,
    `Work on this task in the background, using what this conversation has established. When it is finished, end your answer with the line "Atlas: done ${id}". If you cannot finish it, end with "Atlas: not done ${id} - <one-line reason>".`,
  ].join('\n')
}

// The prompt for one task, as your own words. A refusal puts the task back to waiting with why.
async function submitTask($: EngineInterface, id: string, text: string): Promise<string> {
  try {
    const sent = await $.prompt.submit({ text: askText(id, text), asUser: true })
    if (sent.drop) {
      const why = clip(sent.drop, 120)
      await editAtlas($, (s, now) => releaseTask(s, id, `Not sent: ${why}`, now))
      return `Not sent: ${why}`
    }
  } catch {
    await editAtlas($, (s, now) => releaseTask(s, id, 'Could not send it to Claude.', now))
    return 'Could not send the task to Claude.'
  }
  return `Sent to Claude: ${text}`
}

// Ask Claude: the task goes to Claude in this session as your own words, after the current turn. It
// closes when Claude reports it done. From a command it is sent once the command has returned: a
// prompt submitted inside a command would wait on the command's own turn.
async function askClaude($: EngineInterface, id: string, afterCommand = false): Promise<string> {
  const task = (await atlas($))?.tasks.find(t => t.id === id)
  if (!task || task.kind !== 'you' || !isOpen(task) || (task.status === 'running' && task.dispatch)) return 'Only an open task of your own, not already with Claude, can be sent.'
  await editAtlas($, (s, now) => dispatchTask(s, id, 'ask', now))
  if (!afterCommand) return submitTask($, id, task.text)
  $.clock.after(1, () => void submitTask($, id, task.text).catch(() => undefined))
  return `Sending to Claude: ${task.text}`
}

// Background: a fork of this session (it knows the conversation so far) works on the task while you go
// on. It closes when the agent ends.
async function runInBackground($: EngineInterface, id: string): Promise<string> {
  const task = (await atlas($))?.tasks.find(t => t.id === id)
  if (!task || task.kind !== 'you' || !isOpen(task) || (task.status === 'running' && task.dispatch)) return 'Only an open task of your own, not already with Claude, can run in the background.'
  const prompt = backgroundText(id, task.text)
  const head = norm(prompt).slice(0, 80)
  remember(selfSpawns, head)
  remember(spawnPrompts, head)
  await editAtlas($, (s, now) => dispatchTask(s, id, 'background', now))
  try {
    const started = await $.agent.spawn({ prompt, description: clip(`Atlas: ${task.text}`, 60), subagentType: 'fork' })
    if (started.deny || !started.agentId) {
      const why = clip(started.deny ?? 'no agent started', 120)
      await editAtlas($, (s, now) => releaseTask(s, id, `Background agent not started: ${why}`, now))
      return `Background agent not started: ${why}`
    }
    const agentId = started.agentId
    agentNames.set(agentId, clip(`Atlas: ${task.text}`, 40))
    await editAtlas($, s => linkAgent(s, id, agentId))
    return `Running in the background: ${task.text}`
  } catch {
    await editAtlas($, (s, now) => releaseTask(s, id, 'Background agents are not available here.', now))
    return 'Background agents are not available here.'
  }
}

// ------------------------------------------------------------------ pane actions

async function act($: EngineInterface, a: ViewAction): Promise<void> {
  switch (a.type) {
    case 'expand':
      return editUi($, u => ({ ...u, expanded: u.expanded === a.id ? null : a.id }))
    case 'edit-goal':
      return editUi($, u => ({ ...u, editingGoal: !u.editingGoal }))
    case 'set-goal': {
      const text = a.text.trim()
      await editAtlas($, (s, now) => (text ? setGoal(s, text, now) : clearGoal(s)))
      return editUi($, u => ({ ...u, editingGoal: false }))
    }
    case 'use-goal':
      await editAtlas($, (s, now) => setGoal(s, a.text, now))
      return editUi($, u => ({ ...u, editingGoal: false }))
    case 'auto-goal':
      await editAtlas($, s => clearGoal(s))
      return editUi($, u => ({ ...u, editingGoal: false }))
    case 'dismiss':
      await editAtlas($, s => dismiss(s, a.text))
      return
    case 'add-task':
      await editAtlas($, (s, now) => addTask(s, a.text, 'you', null, 'pending', now))
      return
    case 'add-question':
      await editAtlas($, (s, now) => addQuestion(s, a.text, 'you', now))
      return
    case 'task':
      await editAtlas($, (s, now) => setTask(s, a.id, a.status, now))
      if (a.status === 'drop') await editUi($, u => ({ ...u, expanded: null }))
      return
    case 'question':
      await editAtlas($, (s, now) => setQuestion(s, a.id, a.status, now))
      return
    case 'ask':
      await askClaude($, a.id)
      return editUi($, u => ({ ...u, expanded: null }))
    case 'background':
      await runInBackground($, a.id)
      return editUi($, u => ({ ...u, expanded: null }))
    case 'release':
      await editAtlas($, (s, now) => releaseTask(s, a.id, 'Taken back from Claude.', now))
      return
    case 'ask-new': {
      const after = await editAtlas($, (s, now) => addTask(s, a.text, 'you', null, 'pending', now))
      const made = after.tasks.find(t => t.kind === 'you' && isOpen(t) && norm(t.text) === norm(clip(a.text, 120)))
      if (made) await askClaude($, made.id)
      return editUi($, u => ({ ...u, expanded: null }))
    }
    case 'toggle-done':
      return editUi($, u => ({ ...u, showDone: !u.showDone }))
    case 'toggle-requests':
      return editUi($, u => ({ ...u, showAllRequests: !u.showAllRequests }))
    case 'sync':
      await syncWithClaude($)
      return
  }
}

async function openPane($: EngineInterface, focus: boolean): Promise<boolean> {
  try {
    const opened = await $.ui.open({ id: PANE, title: 'Atlas', columns: COLUMNS, ...(focus ? { focus: true } : {}) })
    return opened.isPlaced
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ /atlas

const HELP = [
  'Atlas commands (the pane does the same):',
  '  /atlas                      open the map',
  '  /atlas goal [<text>]        show the goal, or set your own (/atlas goal auto returns to automatic)',
  '  /atlas task <text>          add a task of your own',
  '  /atlas tasks                list open tasks with numbers',
  '  /atlas done <n>             finish your task n',
  '  /atlas drop <n>             remove task n',
  '  /atlas ask <n>              send your task n to Claude in this conversation',
  '  /atlas bg <n>               hand your task n to a background agent (a fork of this conversation)',
  '  /atlas question <text>      track an open question',
  '  /atlas questions            list open questions with numbers',
  '  /atlas answered <n>         close question n',
  '  /atlas sync                 ask Claude to re-read the session and update the suggestions',
  '  /atlas align on|off         send your goal and your own tasks with each prompt',
  '  /atlas status               settings, and where Atlas data goes',
  '  /atlas reset                clear this session\'s map',
].join('\n')

function statusText(): string {
  return [
    `Summaries: ${summaries}. Align: ${align ? 'on' : 'off'}. Desktop sessions: ${desktopSessions ? 'on' : 'off'}.`,
    'Where Atlas data goes:',
    '  Stays on this Mac: the map (session state) and the store file under ~/.claude/plugins/store.',
    `  To Claude, with each prompt: ${align ? 'one line with the goal you set (not the automatic one), your own open tasks with their ids, and the line that reports one done ("Atlas: done <id>")' : 'nothing'}.`,
    '  To Claude, when you press Ask Claude or Background (or type /atlas ask, /atlas bg): that task, nothing else.',
    `  To Anthropic, through this session's own client: ${autoSummary() ? 'a short digest to Haiku after each answer' : 'no digest'}${syncAllowed() ? '; /atlas sync asks Claude to re-read the session' : ''}.`,
    `  From the Claude desktop app on this Mac: ${desktopSessions ? 'your session list (titles and state)' : 'nothing'}.`,
    '  Nothing else: Atlas makes no HTTP, process or file calls and talks to no other server.',
  ].join('\n')
}

const GOAL_WORDS = {
  you: 'set by you',
  'claude-code': "Claude Code's /goal",
  summary: 'automatic, from the latest summary',
  'first-request': 'automatic, from your first request',
} as const

function numbered<T>(items: readonly T[], arg: string): T | undefined {
  const n = Number(arg)
  return Number.isInteger(n) && n >= 1 ? items[n - 1] : undefined
}

async function command($: EngineInterface, args: string): Promise<string> {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const verb = first.toLowerCase()
  const text = rest.join(' ').trim()
  const s = await atlas($)
  switch (verb) {
    case '':
      return (await openPane($, true)) ? 'Atlas opened.' : 'Atlas is waiting for room: widen the window, or open it from the footer.'
    case 'help':
      return HELP
    case 'goal': {
      if (!text) {
        const goal = s ? effectiveGoal(s) : null
        if (!goal) return 'No goal yet. It fills in from your first request; /atlas goal <text> sets your own.'
        return `Goal (${GOAL_WORDS[goal.source]}): ${goal.text}`
      }
      if (text.toLowerCase() === 'auto' || text.toLowerCase() === 'clear') {
        await editAtlas($, cur => clearGoal(cur))
        return 'The goal is automatic again.'
      }
      await editAtlas($, (cur, now) => setGoal(cur, text, now))
      return `Goal set: ${clip(text, 200)}`
    }
    case 'task':
      if (!text) return HELP
      await editAtlas($, (cur, now) => addTask(cur, text, 'you', null, 'pending', now))
      return `Task added: ${clip(text, 120)}`
    case 'tasks': {
      const open = s ? openTasks(s) : []
      if (!open.length) return 'No open tasks.'
      return ['Open tasks (/atlas done <n>, /atlas drop <n>):', ...open.map((t, i) => `  ${i + 1}. ${t.status === 'running' ? '●' : '○'} ${t.text} · ${TASK_FROM[t.kind]}`)].join('\n')
    }
    case 'done':
    case 'drop': {
      const pick = numbered(s ? openTasks(s) : [], text)
      if (!pick) return `Usage: /atlas ${verb} <number from /atlas tasks>`
      if (verb === 'done' && pick.kind !== 'you') return `"${pick.text}" comes from ${TASK_FROM[pick.kind]} and ends by itself. /atlas drop ${text} removes it.`
      await editAtlas($, (cur, now) => setTask(cur, pick.id, verb === 'done' ? 'done' : 'drop', now))
      return `${verb === 'done' ? 'Finished' : 'Removed'}: ${pick.text}`
    }
    case 'ask':
    case 'bg': {
      const pick = numbered(s ? openTasks(s) : [], text)
      if (!pick) return `Usage: /atlas ${verb} <number from /atlas tasks>`
      if (pick.kind !== 'you') return `"${pick.text}" comes from ${TASK_FROM[pick.kind]}. Only your own tasks can be sent to Claude.`
      return verb === 'ask' ? askClaude($, pick.id, true) : runInBackground($, pick.id)
    }
    case 'question':
    case 'questions': {
      if (verb === 'question' && text) {
        await editAtlas($, (cur, now) => addQuestion(cur, text, 'you', now))
        return `Question tracked: ${clip(text, 200)}`
      }
      const open = s ? openQuestions(s) : []
      if (!open.length) return 'No open questions.'
      return ['Open questions (/atlas answered <n>):', ...open.map((q, i) => `  ${i + 1}. ${q.text} · ${q.by === 'claude' ? 'Claude' : 'you'}`)].join('\n')
    }
    case 'answered': {
      const pick = numbered(s ? openQuestions(s) : [], text)
      if (!pick) return 'Usage: /atlas answered <number from /atlas questions>'
      await editAtlas($, (cur, now) => setQuestion(cur, pick.id, 'answered', now))
      return `Answered: ${pick.text}`
    }
    case 'sync':
      return syncWithClaude($)
    case 'align': {
      const value = text.toLowerCase()
      if (value !== 'on' && value !== 'off') {
        return `Align is ${align ? 'on: your goal and your own open tasks ride along with each prompt' : 'off: Atlas adds nothing to your prompts'}. /atlas align on|off`
      }
      align = value === 'on'
      await $.store.set('align', align)
      return align ? 'Align on: your goal and your own open tasks ride along with each prompt to Claude.' : 'Align off: Atlas adds nothing to your prompts.'
    }
    case 'status':
      return statusText()
    case 'reset': {
      const now = await $.clock.now()
      await $.state.set(ATLAS, emptyState(sid, root, now))
      return "Atlas cleared this session's map."
    }
    default:
      return `Unknown: ${first}\n${HELP}`
  }
}

// ------------------------------------------------------------------ setup

// Runs once per load, on whichever event reaches the module first. A step that cannot run (no room
// for the pane, a refused command) is skipped without a message; a failed binding is tried again on
// the next event.
function setup($: EngineInterface): Promise<void> {
  ready ??= (async () => {
    try {
      await $.command.register({
        name: 'atlas',
        description: 'Conversation Atlas: open the map, set your goal, add tasks and questions, sync with Claude',
        argumentHint: '[goal|task|tasks|done|drop|question|questions|answered|sync|align|status|help] [text]',
      })
    } catch {
      // The pane and the footer button still work.
    }
    await bind($)
    await dropOldStore($).catch(() => undefined)
    align = (await $.store.get('align')) !== false
    saving?.cancel()
    saving = $.clock.every(SAVE_MS, () => {
      ticks += 1
      void save($).catch(() => undefined)
      if (ticks % SESSIONS_EVERY === 0) {
        void refreshSessions($).catch(() => undefined)
        // Another session still on version 0.1 can write the old keys back; they go again here.
        void dropOldStore($).catch(() => undefined)
      }
    })
    void refreshSessions($).catch(() => undefined)
    // Joining a session that already has requests but no summary: map it once now, not after the next answer.
    const joined = await atlas($)
    if (joined && joined.requests.length && !joined.suggested) scheduleSummary($)
    await openPane($, false)
  })().catch(() => {
    ready = null
  })
  return ready
}

// ------------------------------------------------------------------ hooks

export const register: Register = (on, options) => {
  const choice = options?.summaries
  summaries = choice === 'each turn' || choice === 'on demand' || choice === 'off' ? choice : 'both'
  desktopSessions = options?.desktopSessions !== 'off'
  ready = null
  lastSaved = ''
  ticks = 0
  summaryBusy = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await setup($)
    return result
  })

  on('session.end', async ($, e, next) => {
    summaryTimer?.cancel()
    summaryTimer = null
    await save($).catch(() => undefined)
    if (e.reason === 'clear') sid = ''
    return next(e)
  })

  // Only what you confirmed rides along: your goal and your own open tasks, one line.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    await ensureBound($)
    let notes: string[] = []
    if ((await atlas($))?.pendingNotes?.length) {
      await editAtlas($, cur => {
        const [taken, rest] = takeNotes(cur)
        notes = taken
        return rest
      })
    }
    if (!align) return next(e)
    const s = await atlas($)
    const line = s ? alignmentLine(s) : null
    const extra = [...(line ? [line] : []), ...notes]
    return next(extra.length ? { ...e, context: [...(e.context ?? []), ...extra] } : e)
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    await ensureBound($)
    const raw = String(e.text ?? '')
    const found = notices(raw)
    const typed = stripPromptMarkers(raw)
    const fromAgent = Boolean(typed) && spawnPrompts.some(p => norm(typed).startsWith(p))
    await editAtlas($, (s, now) => {
      let out = s
      for (const n of found) out = applyNotice(out, n, now)
      return typed && !fromAgent ? startRequest(out, typed, now) : out
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await ensureBound($)
    if (e.agentId) {
      const agentId = e.agentId
      const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await editAtlas($, (s, now) => agentFinished(setTaskByRef(s, agentId, status, now), agentId, e.reason, e.answer ?? '', now))
      return result
    }
    await editAtlas($, (s, now) => endRequest(s, e.reason, e.answer ?? '', now))
    if (e.reason === 'answer') scheduleSummary($)
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if ('agentId' in started && started.agentId) {
      const agentId = started.agentId
      const head = norm(e.prompt).slice(0, 80)
      // A background agent Atlas started for one of your tasks shows as that task.
      if (selfSpawns.includes(head)) return started
      const name = clip(e.description || e.subagentType, 40) || 'Subagent'
      agentNames.set(agentId, name)
      remember(spawnPrompts, head)
      await ensureBound($)
      await editAtlas($, (s, now) => addTask(countAgent(s), name, 'agent', agentId, 'running', now))
    }
    return started
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const main = !e.agentId
    const c = classify(tool, input)
    const aid = c ? `a${++activitySeq}` : null
    const asked = tool === 'AskUserQuestion' ? askedQuestions(input) : []
    await ensureBound($)
    await editAtlas($, (s, now) => {
      let out = main ? countTool(s) : s
      if (c && aid) out = startActivity(out, { id: aid, kind: c.kind, label: c.label, at: now, agent: e.agentId ? agentNames.get(e.agentId) ?? 'agent' : null })
      for (const q of asked) out = addQuestion(out, q, 'claude', now)
      return out
    })
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (err) {
      if (aid) await editAtlas($, (s, now) => endActivity(s, aid, 'failed', now))
      throw err
    }
    const failed = ran.deny !== undefined || ran.isError === true
    await editAtlas($, (s, now) => {
      const out = aid ? endActivity(s, aid, failed ? 'failed' : 'done', now) : s
      return applyToolResult(out, { tool, input, result: ran.result, failed, main }, now)
    })
    return ran
  })

  on('command.run', { command: 'atlas' }, async ($, e) => {
    await ensureBound($)
    return { text: await command($, e.args ?? '') }
  })

  // Always in the footer while the mod is loaded: opens the map anywhere, at any width.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)
    const s = await atlas($)
    const { Box, Button } = $.ui.resolve(e)
    const open = s ? openTasks(s).length : 0
    const questions = s ? openQuestions(s).length : 0
    const lead = (s ? effectiveGoal(s)?.text : null) ?? s?.title ?? ''
    const label = clip(`Atlas${lead ? `: ${lead}` : ''}${open ? ` · ${open} open` : ''}${questions ? ` · ${questions}?` : ''}`, 44)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Button key="atlas-open" dimColor={!open && !questions} label={label} onPress={() => void openPane($, true)} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Text } = t
    const s = await atlas($)
    if (!s) return <Text dimColor>Atlas is starting…</Text>
    const u = { ...DEFAULT_UI, ...((await $.state.get(UI)).value ?? {}) }
    const now = await $.clock.now()
    const width = Math.max(24, (e.props.bodyColumns || COLUMNS) - 1)
    return pane(
      {
        el: { Box: t.Box, Text: t.Text, Button: t.Button, Input: 'Input' in t ? t.Input : undefined },
        width,
        now,
        canSync: syncAllowed(),
        act: a => void act($, a).catch(() => undefined),
      },
      s,
      u,
    )
  })
}
