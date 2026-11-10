// Draws the pane from the session map, the same on the terminal and the desktop. Pure: the hooks
// module hands it the state, the UI state, the surface's elements and an `act` callback, and it
// returns the tree. The engine scrolls the pane when the tree is taller than the pane.

import type { Elements, RenderElement } from 'claude-code'
import type { AtlasQuestion, AtlasRequest, AtlasSessionRow, AtlasState, AtlasTask, AtlasUi } from '../types'
import { chapterOf, currentRequest, doneTasks, effectiveGoal, type GoalSource, isOpen, openQuestions, openTasks, visibleSuggestions } from './model'
import { base, norm } from './signals'

export type ViewAction =
  | { type: 'expand'; id: string }
  | { type: 'edit-goal' }
  | { type: 'set-goal'; text: string }
  | { type: 'use-goal'; text: string }
  | { type: 'auto-goal' }
  | { type: 'dismiss'; text: string }
  | { type: 'add-task'; text: string }
  | { type: 'add-question'; text: string }
  | { type: 'task'; id: string; status: 'pending' | 'running' | 'done' | 'drop' }
  | { type: 'ask'; id: string }
  | { type: 'background'; id: string }
  | { type: 'release'; id: string }
  | { type: 'ask-new'; text: string }
  | { type: 'question'; id: string; status: 'answered' | 'dropped' | 'open' }
  | { type: 'toggle-done' }
  | { type: 'toggle-requests' }
  | { type: 'sync' }

type Table = Elements['desktop']
export type El = { Box: Table['Box']; Text: Table['Text']; Button: Table['Button']; Input?: Table['Input'] }

export type ViewCtx = {
  el: El
  width: number
  now: number
  // Sync (a Claude re-read of the session) is offered.
  canSync: boolean
  act: (a: ViewAction) => void
}

export const COLOR = {
  goal: '#7dcfff',
  run: '#bb9af7',
  ok: '#9ece6a',
  fail: '#f7768e',
  wait: '#e0af68',
  head: '#a9b1d6',
  write: '#ff9e64',
  read: '#bb9af7',
} as const

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

function cells(text: string): number {
  return Array.from(text).length
}

function fit(text: string, width: number): string {
  const chars = Array.from(text)
  return chars.length <= width ? text : `${chars.slice(0, Math.max(1, width - 1)).join('')}…`
}

type RowSpec = {
  key: string
  glyph: string
  color?: string
  text: string
  meta?: string
  metaColor?: string
  dim?: boolean
  bold?: boolean
  italic?: boolean
  onPress?: () => void
}

// One line: glyph, text (pressable when it opens detail), and right-aligned meta.
function row(ctx: ViewCtx, r: RowSpec): RenderElement {
  const { Box, Text, Button } = ctx.el
  const meta = r.meta ?? ''
  const room = Math.max(8, ctx.width - 2 - (meta ? cells(meta) + 1 : 0))
  const label = fit(r.text, room)
  return (
    <Box key={r.key} flexDirection="row">
      <Text color={r.color} dimColor={r.dim && !r.color} bold={r.bold}>{`${r.glyph} `}</Text>
      {r.onPress ? (
        <Button key={`${r.key}-b`} label={label} plain dimColor={r.dim} onPress={r.onPress} />
      ) : (
        <Text wrap="truncate-end" dimColor={r.dim} bold={r.bold} italic={r.italic}>{label}</Text>
      )}
      <Box flexGrow={1} />
      {meta ? <Text color={r.metaColor} dimColor={!r.metaColor}>{` ${meta}`}</Text> : null}
    </Box>
  )
}

function heading(ctx: ViewCtx, key: string, title: string, right?: string, color: string = COLOR.head): RenderElement {
  const { Box, Text } = ctx.el
  return (
    <Box key={key} flexDirection="row" marginTop={1}>
      <Text bold color={color}>{title}</Text>
      <Box flexGrow={1} />
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  )
}

function note(ctx: ViewCtx, key: string, text: string, indent = 0): RenderElement {
  const { Text } = ctx.el
  return <Text key={key} dimColor wrap="wrap">{`${' '.repeat(indent)}${text}`}</Text>
}

function detail(ctx: ViewCtx, key: string, lines: readonly string[]): RenderElement {
  const { Box, Text } = ctx.el
  return (
    <Box key={key} flexDirection="column" marginLeft={2}>
      {lines.map((line, i) => <Text key={`${key}-${i}`} dimColor wrap="wrap">{line}</Text>)}
    </Box>
  )
}

type Act = { key: string; label: string; primary?: boolean; onPress: () => void }

function buttons(ctx: ViewCtx, key: string, items: readonly Act[]): RenderElement {
  const { Box, Button } = ctx.el
  return (
    <Box key={key} flexDirection="row" flexWrap="wrap" gap={1} marginLeft={2}>
      {items.map(a => <Button key={a.key} label={a.label} variant={a.primary ? 'primary' : 'secondary'} onPress={a.onPress} />)}
    </Box>
  )
}

// ---------------------------------------------------------------- header

function header(ctx: ViewCtx, s: AtlasState, u: AtlasUi): RenderElement[] {
  const { Box, Text, Button } = ctx.el
  const sg = s.suggested
  const when = u.sync.running
    ? 'syncing with Claude…'
    : sg
      ? `${sg.by === 'claude' ? 'synced' : 'summary'} ${ago(ctx.now - sg.at)}`
      : ''
  const out: RenderElement[] = [
    <Box key="head" flexDirection="row">
      <Text bold color={COLOR.goal}>{fit(s.title ?? 'This session', Math.max(10, ctx.width - 22))}</Text>
      <Box flexGrow={1} />
      {when ? <Text dimColor>{`${when} `}</Text> : null}
      {ctx.canSync && !u.sync.running ? (
        <Button key="sync" label="Sync" onPress={() => ctx.act({ type: 'sync' })} />
      ) : null}
    </Box>,
  ]
  if (u.sync.note) out.push(note(ctx, 'sync-note', u.sync.note))
  return out
}

// ---------------------------------------------------------------- goal

const GOAL_FROM: Record<GoalSource, string> = { you: 'you', 'claude-code': 'Claude Code /goal', summary: 'auto', 'first-request': 'auto · first request' }

// The goal fills in by itself: your first request, then each summary's reading of the session. Edit sets
// your own, Pin keeps the automatic one fixed, Use auto hands it back.
function goalSection(ctx: ViewCtx, s: AtlasState, u: AtlasUi): RenderElement[] {
  const goal = effectiveGoal(s)
  const sg = visibleSuggestions(s)
  const out: RenderElement[] = [heading(ctx, 'h-goal', 'GOAL', undefined, COLOR.goal)]
  const edit: Act = { key: 'goal-edit', label: goal ? 'Edit' : 'Set goal', onPress: () => ctx.act({ type: 'edit-goal' }) }
  if (u.editingGoal) {
    const { Input } = ctx.el
    if (Input) {
      out.push(
        <Input
          key="goal-input"
          label="◎ "
          placeholder="what are you trying to get done?"
          value={goal?.text ?? ''}
          submitLabel="set"
          autoFocus
          onSubmit={(value: string) => ctx.act({ type: 'set-goal', text: value })}
        />,
      )
    } else {
      out.push(note(ctx, 'goal-hint', 'Type /atlas goal <text> to set it.'))
    }
    out.push(buttons(ctx, 'goal-edit-actions', [{ key: 'goal-cancel', label: 'Cancel', onPress: () => ctx.act({ type: 'edit-goal' }) }]))
  } else if (goal) {
    const when = goal.at !== null && (goal.source === 'you' || goal.source === 'summary') ? ` · ${ago(ctx.now - goal.at)}` : ''
    out.push(row(ctx, { key: 'goal', glyph: '◎', color: COLOR.goal, text: goal.text, bold: true, meta: `${GOAL_FROM[goal.source]}${when}` }))
    const auto: Act = { key: 'goal-auto', label: 'Use auto', onPress: () => ctx.act({ type: 'auto-goal' }) }
    if (goal.source === 'you' && sg.goal) {
      const reading = sg.goal
      out.push(note(ctx, 'goal-reads', `Claude reads it as: ${reading}`, 2))
      out.push(buttons(ctx, 'goal-actions', [
        { key: 'goal-use', label: 'Use this', onPress: () => ctx.act({ type: 'use-goal', text: reading }) },
        { key: 'goal-keep', label: 'Keep mine', onPress: () => ctx.act({ type: 'dismiss', text: reading }) },
        edit,
      ]))
    } else if (goal.source === 'you') {
      out.push(buttons(ctx, 'goal-actions', [edit, auto]))
    } else {
      out.push(buttons(ctx, 'goal-actions', [edit, { key: 'goal-pin', label: 'Pin', onPress: () => ctx.act({ type: 'use-goal', text: goal.text }) }]))
    }
  } else {
    out.push(note(ctx, 'goal-none', 'No goal yet. It fills in from your first request, or set your own.'))
    out.push(buttons(ctx, 'goal-actions', [{ ...edit, primary: true }]))
  }
  if (s.claudeGoal && goal?.source !== 'claude-code') out.push(note(ctx, 'goal-claude', `Claude Code goal (/goal): ${s.claudeGoal}`, 2))
  return out
}

// ---------------------------------------------------------------- now

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function nowSection(ctx: ViewCtx, s: AtlasState): RenderElement[] {
  const out: RenderElement[] = [heading(ctx, 'h-now', 'NOW')]
  const r = currentRequest(s)
  const sg = visibleSuggestions(s)
  if (!r) {
    out.push(note(ctx, 'now-none', 'Nothing yet. Ask Claude something.'))
    return out
  }
  const running = s.tasks.filter(t => t.status === 'running')
  const agents = running.filter(t => t.kind === 'agent').length
  const jobs = running.filter(t => t.kind === 'background' || t.kind === 'session').length
  const extra = [agents ? `${plural(agents, 'agent')} running` : null, jobs ? `${jobs} background` : null].filter(Boolean).join(' · ')
  if (r.status === 'working') {
    out.push(row(ctx, { key: 'now-request', glyph: '●', color: COLOR.run, text: r.text, bold: true, meta: `working · ${ago(ctx.now - r.at)}`, metaColor: COLOR.run }))
    out.push(note(ctx, 'now-detail', [plural(r.tools, 'tool call'), extra].filter(Boolean).join(' · '), 2))
  } else if (r.status === 'waiting') {
    const asked = openQuestions(s).filter(q => q.by === 'claude').pop()
    out.push(row(ctx, { key: 'now-request', glyph: '?', color: COLOR.wait, text: asked?.text ?? r.outcome ?? r.text, meta: 'waiting on you', metaColor: COLOR.wait }))
    if (extra) out.push(note(ctx, 'now-detail', `still running: ${extra}`, 2))
  } else {
    const glyph = r.status === 'answered' ? '✓' : r.status === 'error' ? '✗' : '■'
    const color = r.status === 'answered' ? COLOR.ok : r.status === 'error' ? COLOR.fail : undefined
    const word = r.status === 'answered' ? 'done' : r.status
    out.push(row(ctx, { key: 'now-request', glyph, color, text: r.outcome ?? r.text, meta: `${word} · ${ago(ctx.now - (r.endedAt ?? r.at))}` }))
    if (extra) out.push(note(ctx, 'now-detail', `still running: ${extra}`, 2))
  }
  if (sg.now) out.push(note(ctx, 'now-summary', `Claude: ${sg.now}`, 2))
  return out
}

// ---------------------------------------------------------------- tasks

const TASK_GLYPH: Record<AtlasTask['status'], string> = { running: '●', pending: '○', done: '✓', failed: '✗', stopped: '■' }
const TASK_COLOR: Record<AtlasTask['status'], string | undefined> = { running: COLOR.run, pending: undefined, done: COLOR.ok, failed: COLOR.fail, stopped: undefined }
export const TASK_FROM: Record<AtlasTask['kind'], string> = {
  agent: 'agent',
  background: 'background',
  session: 'session',
  todo: "Claude's list",
  plan: "Claude's plan",
  you: 'you',
}
const STATUS_WORD: Record<AtlasTask['status'], string> = { running: 'working', pending: 'waiting', done: 'finished', failed: 'failed', stopped: 'stopped' }

// Where a task stands, at the right of its row.
function taskMeta(t: AtlasTask, now: number): { text: string; color?: string } {
  const when = ago(now - t.updatedAt)
  if (t.kind === 'you' && t.status === 'running' && t.dispatch) {
    if (t.dispatch.mode === 'background') return { text: `background agent · ${when}`, color: COLOR.run }
    return t.dispatch.requestId ? { text: `with Claude · ${when}`, color: COLOR.run } : { text: 'queued for Claude', color: COLOR.run }
  }
  if (t.status === 'done' && t.closedBy === 'claude') return { text: `done by Claude · ${when}`, color: COLOR.ok }
  if (t.status === 'done' && t.closedBy === 'summary') return { text: `done · auto · ${when}`, color: COLOR.ok }
  return { text: `${TASK_FROM[t.kind]} · ${when}` }
}

function taskDetail(t: AtlasTask, now: number): string[] {
  const lines = [`${STATUS_WORD[t.status]} · from ${TASK_FROM[t.kind]} · turn ${t.turn}`]
  if (t.status === 'running' && t.dispatch) {
    lines.push(t.dispatch.mode === 'background'
      ? `A background agent took it ${ago(now - t.dispatch.at)} ago. It closes when the agent ends.`
      : t.dispatch.requestId
        ? `Sent to Claude ${ago(now - t.dispatch.at)} ago. It closes when Claude ends a reply with "Atlas: done ${t.id}".`
        : 'Queued: Claude starts it when the current turn ends.')
  }
  if (t.note) lines.push(t.status === 'done' ? `Claude: ${t.note}` : `Note: ${t.note}`)
  if (t.status === 'done' && t.closedBy === 'claude') lines.push('Closed when Claude reported it done.')
  if (t.status === 'done' && t.closedBy === 'summary') lines.push('Closed by the session summary. Reopen it if that is wrong.')
  if (t.kind !== 'you') lines.push('Atlas follows this one from the engine; it ends by itself.')
  return lines
}

function taskRows(ctx: ViewCtx, t: AtlasTask, u: AtlasUi): RenderElement[] {
  const open = isOpen(t)
  const meta = taskMeta(t, ctx.now)
  const out: RenderElement[] = [
    row(ctx, {
      key: `task-${t.id}`,
      glyph: TASK_GLYPH[t.status],
      color: TASK_COLOR[t.status],
      text: t.text,
      dim: !open,
      bold: t.status === 'running',
      meta: meta.text,
      metaColor: meta.color,
      onPress: () => ctx.act({ type: 'expand', id: t.id }),
    }),
  ]
  if (u.expanded !== t.id) return out
  out.push(detail(ctx, `task-${t.id}-detail`, taskDetail(t, ctx.now)))
  const press = (a: ViewAction) => () => ctx.act(a)
  const set = (status: 'pending' | 'running' | 'done' | 'drop') => press({ type: 'task', id: t.id, status })
  const remove: Act = { key: `task-${t.id}-drop`, label: 'Remove', onPress: set('drop') }
  const items: Act[] = t.kind !== 'you'
    ? [remove]
    : t.status === 'pending'
      ? [
          { key: `task-${t.id}-ask`, label: 'Ask Claude', primary: true, onPress: press({ type: 'ask', id: t.id }) },
          { key: `task-${t.id}-bg`, label: 'Background', onPress: press({ type: 'background', id: t.id }) },
          { key: `task-${t.id}-done`, label: 'Done', onPress: set('done') },
          remove,
        ]
      : t.status === 'running'
        ? [
            { key: `task-${t.id}-done`, label: 'Done', primary: true, onPress: set('done') },
            { key: `task-${t.id}-release`, label: 'Back to waiting', onPress: press({ type: 'release', id: t.id }) },
            remove,
          ]
        : [{ key: `task-${t.id}-reopen`, label: 'Reopen', onPress: set('pending') }, remove]
  out.push(buttons(ctx, `task-${t.id}-actions`, items))
  return out
}

// A summary item: shown dim with "suggested" until you add or dismiss it.
function suggestionRows(ctx: ViewCtx, prefix: string, text: string, u: AtlasUi, add: ViewAction, addLabel: string, glyph: string, more: readonly Act[] = []): RenderElement[] {
  const id = `sg:${prefix}:${norm(text)}`
  const out: RenderElement[] = [
    row(ctx, { key: `${prefix}-${norm(text).slice(0, 40)}`, glyph, text, dim: true, italic: true, meta: 'suggested', onPress: () => ctx.act({ type: 'expand', id }) }),
  ]
  if (u.expanded !== id) return out
  out.push(buttons(ctx, `${prefix}-${norm(text).slice(0, 40)}-actions`, [
    { key: `${prefix}-add`, label: addLabel, primary: true, onPress: () => ctx.act(add) },
    ...more,
    { key: `${prefix}-dismiss`, label: 'Dismiss', onPress: () => ctx.act({ type: 'dismiss', text }) },
  ]))
  return out
}

function tasksSection(ctx: ViewCtx, s: AtlasState, u: AtlasUi): RenderElement[] {
  const open = openTasks(s)
  const done = doneTasks(s)
  const sg = visibleSuggestions(s)
  const out: RenderElement[] = [heading(ctx, 'h-tasks', 'TASKS', open.length + done.length ? `${open.length} open · ${done.length} done` : undefined)]
  for (const t of open) out.push(...taskRows(ctx, t, u))
  for (const text of sg.outstanding) {
    const ask: Act = { key: 'st-ask', label: 'Ask Claude', onPress: () => ctx.act({ type: 'ask-new', text }) }
    out.push(...suggestionRows(ctx, 'st', text, u, { type: 'add-task', text }, 'Add task', '○', [ask]))
  }
  if (!open.length && !sg.outstanding.length) {
    out.push(note(ctx, 'tasks-none', done.length
      ? 'Everything here is finished.'
      : "No tasks yet. Subagents, background jobs and Claude's lists show up here. /atlas task <text> adds your own."))
  }
  if (done.length) {
    if (u.showDone) for (const t of done.slice(0, 20)) out.push(...taskRows(ctx, t, u))
    const { Button } = ctx.el
    out.push(
      <Button key="tasks-toggle" label={u.showDone ? 'Hide finished' : `Show ${done.length} finished`} plain dimColor onPress={() => ctx.act({ type: 'toggle-done' })} />,
    )
  }
  return out
}

// ---------------------------------------------------------------- questions

function questionRows(ctx: ViewCtx, q: AtlasQuestion, u: AtlasUi): RenderElement[] {
  const out: RenderElement[] = [
    row(ctx, {
      key: `question-${q.id}`,
      glyph: '?',
      color: COLOR.wait,
      text: q.text,
      meta: `${q.by === 'claude' ? 'Claude' : 'you'} · ${ago(ctx.now - q.at)}`,
      onPress: () => ctx.act({ type: 'expand', id: q.id }),
    }),
  ]
  if (u.expanded !== q.id) return out
  out.push(buttons(ctx, `question-${q.id}-actions`, [
    { key: `question-${q.id}-answered`, label: 'Answered', primary: true, onPress: () => ctx.act({ type: 'question', id: q.id, status: 'answered' }) },
    { key: `question-${q.id}-drop`, label: 'Drop', onPress: () => ctx.act({ type: 'question', id: q.id, status: 'dropped' }) },
  ]))
  return out
}

function questionsSection(ctx: ViewCtx, s: AtlasState, u: AtlasUi): RenderElement[] {
  const open = openQuestions(s).slice().reverse()
  const sg = visibleSuggestions(s)
  const answered = s.questions.filter(q => q.status === 'answered').length
  const out: RenderElement[] = [heading(ctx, 'h-questions', 'OPEN QUESTIONS', open.length || answered ? `${open.length} open · ${answered} answered` : undefined)]
  for (const q of open) out.push(...questionRows(ctx, q, u))
  for (const text of sg.threads) out.push(...suggestionRows(ctx, 'sq', text, u, { type: 'add-question', text }, 'Track', '?'))
  if (!open.length && !sg.threads.length) out.push(note(ctx, 'questions-none', 'No open questions. A question Claude asks shows here until you reply.'))
  return out
}

// ---------------------------------------------------------------- conversation

const SHOWN_REQUESTS = 6

function requestRows(ctx: ViewCtx, r: AtlasRequest, u: AtlasUi): RenderElement[] {
  const meta = r.status === 'working'
    ? 'working'
    : r.status === 'waiting'
      ? 'waiting on you'
      : r.status === 'answered'
        ? ago(ctx.now - (r.endedAt ?? r.at))
        : r.status
  const metaColor = r.status === 'working' ? COLOR.run : r.status === 'waiting' ? COLOR.wait : r.status === 'error' ? COLOR.fail : undefined
  const out: RenderElement[] = [
    row(ctx, { key: `request-${r.id}`, glyph: '›', color: COLOR.goal, text: r.text, meta, metaColor, onPress: () => ctx.act({ type: 'expand', id: r.id }) }),
  ]
  if (u.expanded === r.id) {
    out.push(detail(ctx, `request-${r.id}-detail`, [
      `You: ${r.text}`,
      r.outcome ? `Claude: ${r.outcome}` : 'Claude: no reply yet',
      `turn ${r.turn} · ${plural(r.tools, 'tool call')} · ${plural(r.agents, 'agent')}`,
    ]))
  } else if (r.outcome) {
    const { Text } = ctx.el
    out.push(<Text key={`request-${r.id}-outcome`} dimColor wrap="truncate-end">{`  → ${fit(r.outcome, Math.max(8, ctx.width - 4))}`}</Text>)
  }
  return out
}

function conversationSection(ctx: ViewCtx, s: AtlasState, u: AtlasUi): RenderElement[] {
  const all = s.requests.slice().reverse()
  const shown = u.showAllRequests ? all : all.slice(0, SHOWN_REQUESTS)
  const out: RenderElement[] = [heading(ctx, 'h-conversation', 'CONVERSATION', all.length ? plural(all.length, 'request') : undefined)]
  let lastChapter: string | null | undefined
  for (const r of shown) {
    const chapter = chapterOf(s, r.turn)
    if (chapter && chapter.id !== lastChapter) out.push(note(ctx, `chapter-${chapter.id}-${r.id}`, `— ${chapter.title}`))
    lastChapter = chapter?.id ?? null
    out.push(...requestRows(ctx, r, u))
  }
  if (!all.length) out.push(note(ctx, 'conversation-none', 'Your requests show here, one line each, with how Claude answered.'))
  if (all.length > SHOWN_REQUESTS) {
    const { Button } = ctx.el
    out.push(
      <Button key="requests-toggle" label={u.showAllRequests ? 'Show fewer' : `Show all ${all.length}`} plain dimColor onPress={() => ctx.act({ type: 'toggle-requests' })} />,
    )
  }
  return out
}

// ---------------------------------------------------------------- activity and files

function activitySection(ctx: ViewCtx, s: AtlasState): RenderElement[] {
  const recent = s.activity.slice(-6).reverse()
  const running = s.activity.filter(a => a.state === 'running').length
  const out: RenderElement[] = [heading(ctx, 'h-activity', 'ACTIVITY', running ? `${running} running` : undefined)]
  for (const a of recent) {
    const glyph = a.state === 'running' ? '●' : a.state === 'failed' ? '✗' : '✓'
    const color = a.state === 'running' ? COLOR.run : a.state === 'failed' ? COLOR.fail : COLOR.ok
    out.push(row(ctx, {
      key: `activity-${a.id}`,
      glyph,
      color,
      text: `${a.agent ? `${a.agent} · ` : ''}${a.label}`,
      dim: a.state === 'done',
      meta: a.state === 'running' ? 'running' : ago(ctx.now - (a.endedAt ?? a.at)),
      metaColor: a.state === 'running' ? COLOR.run : undefined,
    }))
  }
  if (!recent.length) out.push(note(ctx, 'activity-none', 'Waiting for Claude to use a tool.'))
  return out
}

function filesSection(ctx: ViewCtx, s: AtlasState): RenderElement[] {
  const recent = s.files.slice().sort((a, b) => b.at - a.at).slice(0, 6)
  const out: RenderElement[] = [heading(ctx, 'h-files', 'WORKING FILES', s.files.length ? plural(s.files.length, 'file') : undefined)]
  for (const f of recent) {
    out.push(row(ctx, {
      key: `file-${f.path}`,
      glyph: f.lastOp === 'write' ? '✎' : '·',
      color: f.lastOp === 'write' ? COLOR.write : COLOR.read,
      text: base(f.path),
      meta: `${f.writes}e ${f.reads}r · ${ago(ctx.now - f.at)}`,
    }))
  }
  if (!recent.length) out.push(note(ctx, 'files-none', 'No files touched yet.'))
  return out
}

// ---------------------------------------------------------------- sessions

function sessionRows(ctx: ViewCtx, r: AtlasSessionRow, u: AtlasUi): RenderElement[] {
  const when = r.lastActive ? ago(ctx.now - r.lastActive) : ''
  const counts = r.tracked ? [`${r.open ?? 0} open`, r.questions ? `${r.questions}?` : null].filter(Boolean).join(' · ') : (r.state ?? '')
  const meta = [counts, when].filter(Boolean).join(' · ')
  const out: RenderElement[] = [
    row(ctx, {
      key: `session-${r.id}`,
      glyph: r.current ? '●' : '○',
      color: r.current ? COLOR.goal : undefined,
      text: r.current ? `${r.title} (this session)` : r.title,
      dim: !r.tracked,
      meta,
      onPress: () => ctx.act({ type: 'expand', id: `session:${r.id}` }),
    }),
  ]
  if (u.expanded === `session:${r.id}`) {
    out.push(detail(ctx, `session-${r.id}-detail`, r.tracked
      ? [`goal: ${r.goal ?? 'not set'}`, `${r.open ?? 0} open tasks · ${r.questions ?? 0} open questions`]
      : ['From the desktop app. Atlas has not mapped this session.']))
  }
  return out
}

function sessionsSection(ctx: ViewCtx, u: AtlasUi): RenderElement[] {
  const out: RenderElement[] = [heading(ctx, 'h-sessions', 'SESSIONS', u.sessions.length > 1 ? `${u.sessions.length}` : undefined)]
  for (const r of u.sessions) out.push(...sessionRows(ctx, r, u))
  if (u.sessions.length <= 1) out.push(note(ctx, 'sessions-none', 'Other sessions in this folder show here.'))
  return out
}

// ---------------------------------------------------------------- pane

export function pane(ctx: ViewCtx, s: AtlasState, u: AtlasUi): RenderElement {
  const { Box, Text } = ctx.el
  return (
    <Box flexDirection="column">
      {header(ctx, s, u)}
      {goalSection(ctx, s, u)}
      {nowSection(ctx, s)}
      {tasksSection(ctx, s, u)}
      {questionsSection(ctx, s, u)}
      {conversationSection(ctx, s, u)}
      {activitySection(ctx, s)}
      {filesSection(ctx, s)}
      {sessionsSection(ctx, u)}
      <Box key="legend" marginTop={1}>
        <Text dimColor wrap="wrap">● working  ○ waiting  ✓ done  ✗ failed  ? question  › your request</Text>
      </Box>
    </Box>
  )
}
