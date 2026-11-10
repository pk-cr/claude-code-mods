// Pure reducers for the session map. Every function takes the state and the time and returns a new
// state; register.tsx wires them to engine events, and replay() runs the same reducers over the
// transcript when Atlas joins a session late. No `$`, no clock.

import type {
  AtlasActivity,
  AtlasChapter,
  AtlasDispatch,
  AtlasFile,
  AtlasQuestion,
  AtlasRequest,
  AtlasRequestStatus,
  AtlasState,
  AtlasTask,
  AtlasTaskKind,
  AtlasTaskStatus,
} from '../types'
import {
  agentIdOf,
  askedQuestions,
  backgroundStart,
  CHAPTER_TOOL,
  classify,
  clip,
  endingQuestion,
  firstLine,
  GOAL_TOOL,
  norm,
  type Notice,
  notices,
  posix,
  rawOf,
  sentences,
  SESSION_TOOLS,
  sessionRefOf,
  similar,
  str,
  stripPromptMarkers,
  TASK_TOOLS,
  taskIdOf,
} from './signals'

export const LIMITS = {
  requests: 80,
  tasks: 80,
  questions: 40,
  chapters: 30,
  activity: 30,
  files: 60,
  dismissed: 60,
  requestText: 300,
  notes: 3,
  noteText: 300,
} as const

export function emptyState(sessionId: string, root: string, now: number): AtlasState {
  return {
    v: 2,
    sessionId,
    root,
    startedAt: now,
    lastActive: now,
    turn: 0,
    seq: 0,
    title: null,
    firstAsk: null,
    goal: null,
    claudeGoal: null,
    suggested: null,
    dismissed: [],
    requests: [],
    tasks: [],
    questions: [],
    chapters: [],
    activity: [],
    files: [],
    pendingNotes: [],
  }
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

// A saved map read back after a restart. Agents and background shells die with the process, so what
// was running is marked stopped.
export function hydrate(raw: unknown, sessionId: string, root: string, now: number): AtlasState {
  const fresh = emptyState(sessionId, root, now)
  const s = rawOf(raw) as Partial<AtlasState>
  if (s.v !== 2) return fresh
  return {
    ...fresh,
    startedAt: typeof s.startedAt === 'number' ? s.startedAt : now,
    lastActive: typeof s.lastActive === 'number' ? s.lastActive : now,
    turn: typeof s.turn === 'number' ? s.turn : 0,
    seq: typeof s.seq === 'number' ? s.seq : 0,
    title: typeof s.title === 'string' ? s.title : null,
    firstAsk: typeof s.firstAsk === 'string' ? s.firstAsk : (list<AtlasRequest>(s.requests).map(r => r.text).filter(isSubstantive).map(t => clip(leadSentence(t), 160))[0] ?? null),
    goal: s.goal && typeof s.goal.text === 'string' ? s.goal : null,
    claudeGoal: typeof s.claudeGoal === 'string' ? s.claudeGoal : null,
    suggested: s.suggested && typeof s.suggested === 'object' ? s.suggested : null,
    dismissed: list<string>(s.dismissed).filter(x => typeof x === 'string'),
    requests: list<AtlasRequest>(s.requests).map(r => (r.status === 'working' ? { ...r, status: 'stopped' as const, endedAt: r.endedAt ?? now } : r)),
    tasks: list<AtlasTask>(s.tasks).map(t => {
      if (t.status === 'running' && (t.kind === 'agent' || t.kind === 'background')) return { ...t, status: 'stopped' as const, updatedAt: now }
      // A task sent to Claude before a restart: the turn or the agent died with the process.
      if (t.status === 'running' && t.dispatch) return { ...t, status: 'pending' as const, dispatch: null, note: 'Interrupted when the session restarted.', updatedAt: now }
      return t
    }),
    questions: list<AtlasQuestion>(s.questions),
    chapters: list<AtlasChapter>(s.chapters),
    activity: list<AtlasActivity>(s.activity).map(a => (a.state === 'running' ? { ...a, state: 'failed' as const, endedAt: a.endedAt ?? now } : a)),
    files: list<AtlasFile>(s.files),
    pendingNotes: list<string>(s.pendingNotes).filter(x => typeof x === 'string'),
  }
}

// A map saved by version 0.2.0 has no first request recorded: it is read from the map's own requests.
export function upgrade(s: AtlasState): AtlasState {
  if (typeof s.firstAsk === 'string' || s.firstAsk === null) return s
  const first = s.requests.find(r => isSubstantive(r.text))
  return { ...s, firstAsk: first ? clip(leadSentence(first.text), 160) : null }
}

function nextId(s: AtlasState, prefix: string): [string, AtlasState] {
  const seq = s.seq + 1
  return [`${prefix}${seq}`, { ...s, seq }]
}

function keep<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items
}

function lastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i] as T)) return i
  return -1
}

// ---------------------------------------------------------------- requests

const ACK = new Set([
  'hi', 'hello', 'hey', 'ok', 'okay', 'thanks', 'thank', 'you', 'yes', 'yep', 'yeah', 'sure', 'please', 'do', 'it',
  'go', 'ahead', 'no', 'nope', 'continue', 'proceed', 'great', 'cool', 'nice', 'perfect', 'sounds', 'good', 'that',
])

// A request with enough words to name the session by.
export function isSubstantive(text: string): boolean {
  const found = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return text.length >= 12 && found.length >= 3 && !found.every(w => ACK.has(w))
}

// The sentence that says what a request is about. A brief with a "Task:" line is read from there, and
// label lines that end with ":" are skipped.
export function leadSentence(text: string): string {
  const task = /^\s*(?:task|goal|objective)\s*:\s*([\s\S]+)/im.exec(text)?.[1]
  const body = task ?? text
  const parts = sentences(body)
  return parts.find(p => !p.endsWith(':') && (p.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3) ?? parts[0] ?? body
}

export function currentRequest(s: AtlasState): AtlasRequest | null {
  return s.requests[s.requests.length - 1] ?? null
}

// The first line of a prompt Atlas sent for one of your tasks: "Atlas task k3: ...".
const TASK_PROMPT = /^Atlas task (k\d+):/m

// A new prompt from you: a request row starts, and Claude's open questions count as answered by it. A
// prompt Atlas sent for one of your tasks shows as that task and links to it.
export function startRequest(s: AtlasState, typed: string, now: number): AtlasState {
  const text = typed.trim()
  if (!text) return s
  const marked = TASK_PROMPT.exec(text)?.[1] ?? null
  const task = marked ? (s.tasks.find(t => t.id === marked && t.kind === 'you') ?? null) : null
  const turn = s.turn + 1
  const requests = s.requests.map(r => (r.status === 'working' ? { ...r, status: 'stopped' as const, endedAt: now } : r))
  const questions = s.questions.map(q => (q.status === 'open' && q.by === 'claude' ? { ...q, status: 'answered' as const, closedAt: now } : q))
  const [id, next] = nextId({ ...s, turn, requests, questions, lastActive: now }, 'r')
  const made: AtlasRequest = {
    id,
    turn,
    text: clip(task ? `Atlas task: ${task.text}` : text, LIMITS.requestText),
    at: now,
    status: 'working',
    outcome: null,
    endedAt: null,
    tools: 0,
    agents: 0,
    ...(task ? { taskId: task.id } : {}),
  }
  const lead = !task && isSubstantive(text) ? leadSentence(text) : null
  const title = next.title ?? (lead ? clip(lead, 60) : null)
  const firstAsk = next.firstAsk ?? (lead ? clip(lead, 160) : null)
  const tasks = task
    ? next.tasks.map(t => (t.id === task.id && t.status === 'running' && t.dispatch?.mode === 'ask' && !t.dispatch.requestId ? { ...t, dispatch: { ...t.dispatch, requestId: id } } : t))
    : next.tasks
  return { ...next, title, firstAsk, tasks, requests: keep([...next.requests, made], LIMITS.requests) }
}

// The turn ended: how, and the first line of the reply. A reply that ends on a question waits on you.
// Claude's "Atlas: done" lines close your tasks; a task sent to Claude whose turn was cut short waits again.
export function endRequest(s: AtlasState, reason: string, answer: string, now: number): AtlasState {
  const index = lastIndex(s.requests, r => r.status === 'working')
  if (index < 0) return reason === 'answer' ? applyReports({ ...s, lastActive: now }, answer, now) : { ...s, lastActive: now }
  const ended = s.requests[index]
  const asked = reason === 'answer' ? endingQuestion(answer) : null
  const status: AtlasRequestStatus = reason === 'answer' ? (asked ? 'waiting' : 'answered') : reason === 'aborted' ? 'stopped' : 'error'
  const requests = s.requests.map((r, i) => (i === index ? { ...r, status, outcome: firstLine(answer), endedAt: now } : r))
  let next: AtlasState = { ...s, requests, lastActive: now }
  if (asked) next = addQuestion(next, asked, 'claude', now)
  if (reason === 'answer') return applyReports(next, answer, now)
  const linked = next.tasks.find(t => t.status === 'running' && t.dispatch?.mode === 'ask' && t.dispatch.requestId === ended?.id)
  return linked ? releaseTask(next, linked.id, reason === 'aborted' ? 'Interrupted before Claude finished.' : 'The turn ended with an error.', now) : next
}

function bumpCurrent(s: AtlasState, field: 'tools' | 'agents'): AtlasState {
  const index = lastIndex(s.requests, r => r.status === 'working')
  if (index < 0) return s
  return { ...s, requests: s.requests.map((r, i) => (i === index ? { ...r, [field]: r[field] + 1 } : r)) }
}

export function countTool(s: AtlasState): AtlasState {
  return bumpCurrent(s, 'tools')
}

export function countAgent(s: AtlasState): AtlasState {
  return bumpCurrent(s, 'agents')
}

// ---------------------------------------------------------------- questions

export function openQuestions(s: AtlasState): AtlasQuestion[] {
  return s.questions.filter(q => q.status === 'open')
}

// Open questions stay; when the list is full the oldest closed ones go first.
function trimQuestions(items: AtlasQuestion[]): AtlasQuestion[] {
  if (items.length <= LIMITS.questions) return items
  const drop = new Set(items.filter(q => q.status !== 'open').slice(0, items.length - LIMITS.questions).map(q => q.id))
  return keep(items.filter(q => !drop.has(q.id)), LIMITS.questions)
}

export function addQuestion(s: AtlasState, text: string, by: 'claude' | 'you', now: number): AtlasState {
  const body = clip(text, 200)
  if (!body || s.questions.some(q => q.status === 'open' && similar(q.text, body))) return s
  const [id, next] = nextId(s, 'q')
  const made: AtlasQuestion = { id, text: body, status: 'open', by, at: now, turn: s.turn, closedAt: null }
  return { ...next, questions: trimQuestions([...next.questions, made]) }
}

export function setQuestion(s: AtlasState, id: string, status: AtlasQuestion['status'], now: number): AtlasState {
  if (!s.questions.some(q => q.id === id)) return s
  return { ...s, questions: s.questions.map(q => (q.id === id ? { ...q, status, closedAt: status === 'open' ? null : now } : q)) }
}

// AskUserQuestion came back with your answers: those questions are answered.
export function answerAsked(s: AtlasState, texts: readonly string[], now: number): AtlasState {
  let next = s
  for (const text of texts) {
    const hit = next.questions.find(q => q.status === 'open' && similar(q.text, text))
    if (hit) next = setQuestion(next, hit.id, 'answered', now)
  }
  return next
}

// ---------------------------------------------------------------- tasks

export function isOpen(t: AtlasTask): boolean {
  return t.status === 'running' || t.status === 'pending'
}

// Working first, then waiting, oldest first within each.
export function openTasks(s: AtlasState): AtlasTask[] {
  return s.tasks.filter(isOpen).sort((a, b) => (a.status === b.status ? a.at - b.at : a.status === 'running' ? -1 : 1))
}

export function doneTasks(s: AtlasState): AtlasTask[] {
  return s.tasks.filter(t => !isOpen(t)).sort((a, b) => b.updatedAt - a.updatedAt)
}

// Open tasks stay; when the list is full the oldest finished ones go first.
function trimTasks(items: AtlasTask[]): AtlasTask[] {
  if (items.length <= LIMITS.tasks) return items
  const closed = items.filter(t => !isOpen(t)).sort((a, b) => a.updatedAt - b.updatedAt)
  const drop = new Set(closed.slice(0, items.length - LIMITS.tasks).map(t => t.id))
  return keep(items.filter(t => !drop.has(t.id)), LIMITS.tasks)
}

export function addTask(s: AtlasState, text: string, kind: AtlasTaskKind, ref: string | null, status: AtlasTaskStatus, now: number): AtlasState {
  const body = clip(text, 120)
  if (!body) return s
  if (ref && s.tasks.some(t => t.kind === kind && t.ref === ref)) return s
  if (kind === 'you' && s.tasks.some(t => t.kind === 'you' && isOpen(t) && norm(t.text) === norm(body))) return s
  const [id, next] = nextId(s, 'k')
  const made: AtlasTask = { id, text: body, status, kind, ref, at: now, updatedAt: now, turn: s.turn }
  return { ...next, tasks: trimTasks([...next.tasks, made]) }
}

function setTaskWhere(s: AtlasState, test: (t: AtlasTask) => boolean, status: AtlasTaskStatus, now: number): AtlasState {
  let changed = false
  const tasks = s.tasks.map(t => {
    if (!test(t) || t.status === status) return t
    changed = true
    return { ...t, status, updatedAt: now }
  })
  return changed ? { ...s, tasks } : s
}

export function setTaskByRef(s: AtlasState, ref: string, status: AtlasTaskStatus, now: number): AtlasState {
  return setTaskWhere(s, t => t.ref === ref, status, now)
}

// A press or command on one task. Only your own tasks change state by hand; the engine owns the rest.
// Any task can be removed, for example one whose end the engine never reported. Reopening a task that
// closed without you keeps summaries from closing it again.
export function setTask(s: AtlasState, id: string, status: AtlasTaskStatus | 'drop', now: number): AtlasState {
  const hit = s.tasks.find(t => t.id === id)
  if (!hit) return s
  if (status === 'drop') return { ...s, tasks: s.tasks.filter(t => t.id !== id) }
  if (hit.kind !== 'you') return s
  return patchTask(s, id, t => {
    if (status === 'pending') {
      if (t.status === 'pending' && !t.dispatch) return t
      return { ...t, status: 'pending', dispatch: null, note: null, keepOpen: Boolean(t.keepOpen || t.closedBy), closedBy: null, updatedAt: now }
    }
    if (t.status === status) return t
    return { ...t, status, closedBy: null, dispatch: status === 'done' ? null : (t.dispatch ?? null), updatedAt: now }
  })
}

// ---------------------------------------------------------------- tasks sent to Claude

function patchTask(s: AtlasState, id: string, fn: (t: AtlasTask) => AtlasTask): AtlasState {
  let changed = false
  const tasks = s.tasks.map(t => {
    if (t.id !== id) return t
    const out = fn(t)
    if (out !== t) changed = true
    return out
  })
  return changed ? { ...s, tasks } : s
}

// Ask Claude or Background on one of your open tasks: from now on it waits on Claude.
export function dispatchTask(s: AtlasState, id: string, mode: AtlasDispatch['mode'], now: number): AtlasState {
  return patchTask(s, id, t =>
    t.kind !== 'you' || !isOpen(t) || (t.status === 'running' && t.dispatch)
      ? t
      : { ...t, status: 'running', note: null, closedBy: null, updatedAt: now, dispatch: { mode, at: now, requestId: null, agentId: null } },
  )
}

// The background agent that took the task.
export function linkAgent(s: AtlasState, id: string, agentId: string): AtlasState {
  return patchTask(s, id, t => (t.dispatch ? { ...t, dispatch: { ...t.dispatch, agentId } } : t))
}

// Back to waiting, with why.
export function releaseTask(s: AtlasState, id: string, note: string, now: number): AtlasState {
  return patchTask(s, id, t => (t.kind !== 'you' || t.status === 'done' ? t : { ...t, status: 'pending', dispatch: null, note: clip(note, 160) || null, updatedAt: now }))
}

// Closed without you: by Claude's "Atlas: done" line, or by a summary. A summary leaves alone a task you
// reopened after it closed without you.
export function closeTask(s: AtlasState, id: string, by: 'claude' | 'summary', note: string | null, now: number): AtlasState {
  return patchTask(s, id, t => {
    if (t.kind !== 'you' || t.status === 'done' || (by === 'summary' && t.keepOpen)) return t
    return { ...t, status: 'done', closedBy: by, note: note ? clip(note, 160) : null, dispatch: null, updatedAt: now }
  })
}

export type Report = { done: boolean; ids: string[]; reason: string | null }

const REPORT = /^\W*atlas\s*:\s*(not\s+done|done)\b(.*)$/i

// The report lines in the last lines of a reply: "Atlas: done k3", or "Atlas: not done k3 - why".
export function parseReports(answer: string): Report[] {
  const lines = answer.split('\n').map(line => line.replace(/[*_`>]/g, '').trim()).filter(Boolean).slice(-6)
  const out: Report[] = []
  for (const line of lines) {
    const m = REPORT.exec(line)
    if (!m) continue
    const rest = m[2] ?? ''
    const ids = [...rest.matchAll(/\bk(\d+)\b/gi)].map(x => `k${x[1]}`)
    const reason = clip(rest.replace(/\bk\d+\b/gi, ' ').replace(/^[\s,;:.–—-]+/, ''), 160) || null
    out.push({ done: !/^not/i.test(m[1] ?? ''), ids, reason })
  }
  return out
}

// Claude's report lines close or release your tasks. A line with no id is about the one task waiting on
// Claude, when there is exactly one.
export function applyReports(s: AtlasState, answer: string, now: number): AtlasState {
  const reports = parseReports(answer)
  if (!reports.length) return s
  const outcome = firstLine(answer)
  let next = s
  for (const r of reports) {
    const waiting = next.tasks.filter(t => t.kind === 'you' && t.status === 'running' && t.dispatch)
    const ids = r.ids.length ? r.ids : waiting.length === 1 && waiting[0] ? [waiting[0].id] : []
    for (const id of ids) next = r.done ? closeTask(next, id, 'claude', outcome, now) : releaseTask(next, id, r.reason ?? 'Claude could not finish it.', now)
  }
  return next
}

// A background agent working on one of your tasks ended: done unless it said "not done", waiting again
// when it was stopped or failed. A note tells Claude with your next prompt what happened.
export function agentFinished(s: AtlasState, agentId: string, reason: string, answer: string, now: number): AtlasState {
  const task = s.tasks.find(t => t.kind === 'you' && t.status === 'running' && t.dispatch?.agentId === agentId)
  if (!task) return s
  const outcome = firstLine(answer)
  const said = parseReports(answer).filter(r => !r.ids.length || r.ids.includes(task.id)).pop()
  const next = reason !== 'answer'
    ? releaseTask(s, task.id, reason === 'aborted' ? 'The background agent was stopped.' : 'The background agent failed.', now)
    : said && !said.done
      ? releaseTask(s, task.id, said.reason ?? 'The background agent could not finish it.', now)
      : closeTask(s, task.id, 'claude', outcome, now)
  const finished = next.tasks.find(t => t.id === task.id)?.status === 'done'
  return addNote(next, `Conversation Atlas: a background agent the user started ${finished ? 'finished' : 'did not finish'} the task "${task.text}".${outcome ? ` Its answer began: "${outcome}"` : ''}`)
}

export function addNote(s: AtlasState, text: string): AtlasState {
  const body = clip(text, LIMITS.noteText)
  return body ? { ...s, pendingNotes: keep([...(s.pendingNotes ?? []), body], LIMITS.notes) } : s
}

// The notes waiting for your next prompt, and the map without them.
export function takeNotes(s: AtlasState): [string[], AtlasState] {
  const notes = s.pendingNotes ?? []
  return notes.length ? [notes, { ...s, pendingNotes: [] }] : [[], s]
}

const PLAN_STATUS: Record<string, AtlasTaskStatus> = { pending: 'pending', in_progress: 'running', completed: 'done' }

// TodoWrite sends the whole list each time. A finished item that leaves the list stays as history;
// an unfinished one that leaves it was removed. Ids stay while an item's text stays.
export function applyTodoWrite(s: AtlasState, todos: unknown, now: number): AtlasState {
  if (!Array.isArray(todos)) return s
  const incoming = todos.flatMap(item => {
    const raw = rawOf(item)
    const text = clip(raw.content, 120)
    return text ? [{ text, status: PLAN_STATUS[str(raw.status)] ?? ('pending' as AtlasTaskStatus) }] : []
  })
  const old = s.tasks.filter(t => t.kind === 'todo')
  const others = s.tasks.filter(t => t.kind !== 'todo')
  const used = new Set<string>()
  let next = s
  let changed = false
  const rebuilt = incoming.map((item): AtlasTask => {
    const prev = old.find(t => !used.has(t.id) && t.text === item.text)
    if (prev) {
      used.add(prev.id)
      if (prev.status === item.status) return prev
      changed = true
      return { ...prev, status: item.status, updatedAt: now }
    }
    const [id, after] = nextId(next, 'k')
    next = after
    changed = true
    return { id, text: item.text, status: item.status, kind: 'todo', ref: null, at: now, updatedAt: now, turn: s.turn }
  })
  const history = old.filter(t => !used.has(t.id) && t.status === 'done')
  if (!changed && history.length + used.size === old.length) return s
  return { ...next, tasks: trimTasks([...others, ...history, ...rebuilt]) }
}

function refOf(value: unknown): string | null {
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null
}

function upsertPlan(s: AtlasState, ref: string, text: string | null, status: AtlasTaskStatus | null, now: number): AtlasState {
  const hit = s.tasks.find(t => t.kind === 'plan' && t.ref === ref)
  if (!hit) return addTask(s, text ?? `Task ${ref}`, 'plan', ref, status ?? 'pending', now)
  const nextText = text ?? hit.text
  const nextStatus = status ?? hit.status
  if (nextText === hit.text && nextStatus === hit.status) return s
  return { ...s, tasks: s.tasks.map(t => (t.id === hit.id ? { ...t, text: nextText, status: nextStatus, updatedAt: now } : t)) }
}

// Claude's Task tools: each reads the engine's typed input and result.
export function applyTaskTool(s: AtlasState, tool: string, input: unknown, result: unknown, now: number): AtlasState {
  const args = rawOf(input)
  const out = rawOf(result)
  switch (tool) {
    case 'TaskCreate': {
      const made = rawOf(out.task)
      const ref = refOf(made.id)
      const text = clip(made.subject, 120) || clip(args.subject, 120)
      return ref && text ? upsertPlan(s, ref, text, 'pending', now) : s
    }
    case 'TaskUpdate': {
      const ref = refOf(args.taskId) ?? refOf(out.taskId)
      if (!ref || out.success === false) return s
      if (args.status === 'deleted') return { ...s, tasks: s.tasks.filter(t => !(t.kind === 'plan' && t.ref === ref)) }
      const text = clip(args.subject, 120) || null
      const status = PLAN_STATUS[str(args.status)] ?? null
      return text || status ? upsertPlan(s, ref, text, status, now) : s
    }
    case 'TaskGet': {
      const one = rawOf(out.task)
      const ref = refOf(one.id)
      const text = clip(one.subject, 120)
      return ref && text ? upsertPlan(s, ref, text, PLAN_STATUS[str(one.status)] ?? null, now) : s
    }
    case 'TaskList': {
      let next = s
      for (const entry of list<unknown>(out.tasks)) {
        const one = rawOf(entry)
        const ref = refOf(one.id)
        const text = clip(one.subject, 120)
        if (ref && text) next = upsertPlan(next, ref, text, PLAN_STATUS[str(one.status)] ?? null, now)
      }
      return next
    }
    default:
      return s
  }
}

// A <task-notification> said background work ended. With no id match and exactly one background task
// running, the notice is about that one.
export function applyNotice(s: AtlasState, n: Notice, now: number): AtlasState {
  const word = n.status ?? ''
  const status: AtlasTaskStatus = /fail|error|kill|crash/.test(word)
    ? 'failed'
    : /stop|cancel|abort/.test(word)
      ? 'stopped'
      : /running|progress|started/.test(word)
        ? 'running'
        : 'done'
  if (n.taskId) {
    const next = setTaskByRef(s, n.taskId, status, now)
    if (next !== s) return next
  }
  const running = s.tasks.filter(t => t.kind === 'background' && t.status === 'running')
  const only = running.length === 1 ? running[0] : undefined
  return only ? setTaskWhere(s, t => t.id === only.id, status, now) : s
}

// ---------------------------------------------------------------- chapters and goals

export function addChapter(s: AtlasState, title: string, summary: string, now: number): AtlasState {
  const text = clip(title, 60)
  if (!text) return s
  const last = s.chapters[s.chapters.length - 1]
  if (last && norm(last.title) === norm(text)) return s
  const [id, next] = nextId(s, 'c')
  const made: AtlasChapter = { id, title: text, summary: clip(summary, 140) || null, at: now, turn: s.turn }
  return { ...next, chapters: keep([...next.chapters, made], LIMITS.chapters) }
}

// The chapter a turn belongs to: the last one marked at or before it.
export function chapterOf(s: AtlasState, turn: number): AtlasChapter | null {
  let hit: AtlasChapter | null = null
  for (const c of s.chapters) if (c.turn <= turn) hit = c
  return hit
}

export function setGoal(s: AtlasState, text: string, now: number): AtlasState {
  const body = clip(text, 200)
  return body ? { ...s, goal: { text: body, at: now } } : s
}

export function clearGoal(s: AtlasState): AtlasState {
  return s.goal ? { ...s, goal: null } : s
}

export function setClaudeGoal(s: AtlasState, condition: string): AtlasState {
  const text = clip(condition, 300)
  return text ? { ...s, claudeGoal: text } : s
}

// ---------------------------------------------------------------- summaries (suggestions only)

export type ParsedSummary = {
  title: string | null
  goal: string | null
  now: string | null
  outstanding: string[]
  threads: string[]
  // Ids of your open tasks the summary sees as finished.
  done?: string[]
}

// A new summary. Its goal becomes the automatic goal, but a rewording of the same goal keeps the old
// words and a summary with no goal keeps the last one, so the goal does not flicker.
export function applySuggested(s: AtlasState, p: ParsedSummary, by: 'haiku' | 'claude', now: number): AtlasState {
  const old = s.suggested?.goal ?? null
  const goal = p.goal ? (old && similar(old, p.goal) ? old : p.goal) : old
  let next: AtlasState = {
    ...s,
    title: p.title ?? s.title,
    suggested: { by, at: now, turn: s.turn, title: p.title, goal, now: p.now, outstanding: p.outstanding, threads: p.threads },
  }
  for (const id of p.done ?? []) {
    const t = next.tasks.find(x => x.id === id)
    // Work still queued for Claude, or with a background agent, ends by its own signal.
    if (!t || (t.dispatch && (t.dispatch.mode === 'background' || !t.dispatch.requestId))) continue
    next = closeTask(next, id, 'summary', null, now)
  }
  return next
}

export type GoalSource = 'you' | 'claude-code' | 'summary' | 'first-request'

export type EffectiveGoal = { text: string; source: GoalSource; at: number | null }

// The goal the map shows: yours when you set or pinned one, else Claude Code's /goal, else the latest
// summary's reading of the whole session, else your first request. Only yours rides along with prompts.
export function effectiveGoal(s: AtlasState): EffectiveGoal | null {
  if (s.goal) return { text: s.goal.text, source: 'you', at: s.goal.at }
  if (s.claudeGoal) return { text: s.claudeGoal, source: 'claude-code', at: null }
  if (s.suggested?.goal) return { text: s.suggested.goal, source: 'summary', at: s.suggested.at }
  if (s.firstAsk) return { text: s.firstAsk, source: 'first-request', at: null }
  return null
}

export function isDismissed(s: AtlasState, text: string): boolean {
  return s.dismissed.includes(norm(text))
}

export function dismiss(s: AtlasState, text: string): AtlasState {
  const key = norm(text)
  if (!key || s.dismissed.includes(key)) return s
  return { ...s, dismissed: keep([...s.dismissed, key], LIMITS.dismissed) }
}

// What the pane offers from the latest summary: minus what you dismissed and what you already track.
// The summary's goal is offered only against a goal you set, when it reads the session differently.
export function visibleSuggestions(s: AtlasState): { goal: string | null; now: string | null; outstanding: string[]; threads: string[] } {
  const sg = s.suggested
  if (!sg) return { goal: null, now: null, outstanding: [], threads: [] }
  const goal = s.goal && sg.goal && !isDismissed(s, sg.goal) && !similar(s.goal.text, sg.goal) ? sg.goal : null
  const outstanding = sg.outstanding.filter(text => !isDismissed(s, text) && !s.tasks.some(t => similar(t.text, text)))
  const threads = sg.threads.filter(text => !isDismissed(s, text) && !s.questions.some(q => similar(q.text, text)))
  return { goal, now: sg.now, outstanding, threads }
}

// ---------------------------------------------------------------- activity and files

export function startActivity(s: AtlasState, a: Omit<AtlasActivity, 'state' | 'endedAt'>): AtlasState {
  return { ...s, activity: keep([...s.activity, { ...a, state: 'running', endedAt: null }], LIMITS.activity) }
}

export function endActivity(s: AtlasState, id: string, state: 'done' | 'failed', now: number): AtlasState {
  if (!s.activity.some(a => a.id === id)) return s
  return { ...s, activity: s.activity.map(a => (a.id === id ? { ...a, state, endedAt: now } : a)) }
}

export function touchFile(s: AtlasState, path: string, op: 'read' | 'write', now: number): AtlasState {
  const p = posix(path).trim()
  if (!p) return s
  const resolved = p.startsWith('/') || /^[A-Za-z]:\//.test(p) ? p : `${s.root.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
  const hit = s.files.find(f => f.path === resolved)
  const file: AtlasFile = hit
    ? { ...hit, reads: hit.reads + (op === 'read' ? 1 : 0), writes: hit.writes + (op === 'write' ? 1 : 0), lastOp: op, at: now }
    : { path: resolved, reads: op === 'read' ? 1 : 0, writes: op === 'write' ? 1 : 0, lastOp: op, at: now }
  return { ...s, files: keep([...s.files.filter(f => f.path !== resolved), file], LIMITS.files) }
}

// ---------------------------------------------------------------- one finished tool call

export type ToolOutcome = { tool: string; input: Record<string, unknown>; result: unknown; failed: boolean; main: boolean }

// Everything one finished tool call means for the map: files, Claude's lists, chapters, the /goal
// condition, answered questions, background work, sessions started, and agents that came back.
export function applyToolResult(s: AtlasState, call: ToolOutcome, now: number): AtlasState {
  const { tool, input, result, failed, main } = call
  if (tool === 'Agent' || tool === 'Task') {
    if (input.run_in_background === true && !failed) return s
    const status: AtlasTaskStatus = failed ? 'failed' : 'done'
    const ref = agentIdOf(result)
    if (ref) return setTaskByRef(s, ref, status, now)
    const text = clip(str(input.description) || str(input.subagent_type), 40)
    const index = lastIndex(s.tasks, t => t.kind === 'agent' && t.status === 'running' && t.text === text)
    const hit = index >= 0 ? s.tasks[index] : undefined
    return hit ? setTaskWhere(s, t => t.id === hit.id, status, now) : s
  }
  if (failed) return s
  let next = s
  for (const f of classify(tool, input)?.files ?? []) next = touchFile(next, f.path, f.op, now)
  if (tool === 'TodoWrite') return main ? applyTodoWrite(next, input.todos, now) : next
  if (TASK_TOOLS.has(tool)) return applyTaskTool(next, tool, input, result, now)
  if (tool === CHAPTER_TOOL) return addChapter(next, str(input.title), str(input.summary), now)
  if (tool === GOAL_TOOL) return setClaudeGoal(next, str(rawOf(result).condition) || str(input.condition))
  if (tool === 'AskUserQuestion') return answerAsked(next, askedQuestions(input), now)
  if (tool === 'TaskStop') {
    const ref = str(input.task_id) || str(input.shell_id)
    return ref ? setTaskByRef(next, ref, 'stopped', now) : next
  }
  if (tool === 'GetTask') {
    const out = rawOf(result)
    const ref = str(input.taskId)
    if (!ref || out.status !== 'completed') return next
    return setTaskByRef(next, ref, rawOf(out.result).isError === true ? 'failed' : 'done', now)
  }
  if (SESSION_TOOLS.has(tool)) {
    const title = str(input.title) || str(input.name) || 'Session'
    return addTask(next, title, 'session', sessionRefOf(result) ?? `session-${next.seq + 1}`, 'running', now)
  }
  const background = backgroundStart(tool, input)
  if (background) return addTask(next, background, 'background', taskIdOf(result) ?? `bg-${next.seq + 1}`, 'running', now)
  return next
}

// ---------------------------------------------------------------- replay

export type HistoryRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly { tool: string; input?: Record<string, unknown>; result?: unknown; isError?: true; agentId?: string }[]
}

// Rebuilds the map from the transcript when Atlas joins a session late, with the live reducers.
export function replay(s: AtlasState, rows: readonly HistoryRow[], now: number): AtlasState {
  let next = s
  let answer = ''
  const close = () => {
    if (next.requests.some(r => r.status === 'working')) next = endRequest(next, 'answer', answer, now)
    answer = ''
  }
  for (const row of rows) {
    const text = typeof row.text === 'string' ? row.text : ''
    if (row.role === 'user') {
      for (const n of notices(text)) next = applyNotice(next, n, now)
      const typed = stripPromptMarkers(text)
      if (typed) {
        close()
        next = startRequest(next, typed, now)
      }
      continue
    }
    if (text.trim()) answer = text
    for (const use of row.toolUses ?? []) {
      const tool = String(use.tool)
      const input = use.input ?? {}
      const answered = use.result !== undefined
      if (tool === 'Agent' || tool === 'Task') {
        const ref = use.agentId ?? agentIdOf(use.result) ?? `agent-${next.seq + 1}`
        const status: AtlasTaskStatus = !answered || input.run_in_background === true ? 'running' : use.isError ? 'failed' : 'done'
        next = countAgent(countTool(next))
        next = addTask(next, clip(str(input.description) || str(input.subagent_type), 40) || 'Subagent', 'agent', ref, status, now)
        continue
      }
      next = countTool(next)
      if (tool === 'AskUserQuestion' && !answered) {
        for (const q of askedQuestions(input)) next = addQuestion(next, q, 'claude', now)
        continue
      }
      next = applyToolResult(next, { tool, input, result: use.result, failed: Boolean(use.isError), main: true }, now)
    }
  }
  if (rows[rows.length - 1]?.role === 'assistant') close()
  return next
}

// ---------------------------------------------------------------- what other places read

export type SessionSummary = {
  id: string
  root: string
  title: string | null
  goal: string | null
  open: number
  questions: number
  turns: number
  lastActive: number
}

export function summaryOf(s: AtlasState): SessionSummary {
  return {
    id: s.sessionId,
    root: s.root,
    title: s.title,
    goal: effectiveGoal(s)?.text ?? null,
    open: openTasks(s).length,
    questions: openQuestions(s).length,
    turns: s.turn,
    lastActive: s.lastActive,
  }
}

export function isSummary(value: unknown): value is SessionSummary {
  const r = rawOf(value)
  return typeof r.id === 'string' && typeof r.root === 'string' && typeof r.lastActive === 'number'
}

// One short line beside each prompt so Claude works toward what you set: your goal, and your own open
// tasks with their ids and the line that reports one finished.
export function alignmentLine(s: AtlasState): string | null {
  const mine = openTasks(s).filter(t => t.kind === 'you').slice(0, 5)
  if (!s.goal && !mine.length) return null
  const parts = [s.goal ? `goal "${s.goal.text}"` : null, mine.length ? `open tasks ${mine.map(t => `[${t.id}] "${t.text}"`).join('; ')}` : null].filter(Boolean)
  const report = mine.length ? ' When you finish one of these tasks, end your reply with the line "Atlas: done <id>".' : ''
  return `Conversation Atlas, set by the user for this session: ${parts.join('. ')}.${report}`
}
