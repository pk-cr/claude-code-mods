import { describe, expect, test } from 'claude-code/testing'

import {
  addNote,
  addQuestion,
  addTask,
  agentFinished,
  alignmentLine,
  applyNotice,
  applyReports,
  applySuggested,
  applyTaskTool,
  applyTodoWrite,
  applyToolResult,
  dismiss,
  dispatchTask,
  doneTasks,
  effectiveGoal,
  emptyState,
  endRequest,
  hydrate,
  leadSentence,
  linkAgent,
  openQuestions,
  openTasks,
  parseReports,
  replay,
  setGoal,
  setTask,
  startRequest,
  summaryOf,
  takeNotes,
  upgrade,
  visibleSuggestions,
} from '../hooks/model'
import { endingQuestion, firstLine, notices, similar, stripPromptMarkers } from '../hooks/signals'
import { buildDigest, buildSyncPrompt, mergeSessions, parseDesktopSessions, parseSummary } from '../hooks/summary'
import type { AtlasState } from '../types'

const ROOT = '/home/dev/work'
const NOW = 1_800_000_000_000

const blank = (): AtlasState => emptyState('model-session', ROOT, NOW)
const todo = (content: string, status: string) => ({ content, status, activeForm: content })
const call = (tool: string, input: Record<string, unknown>, result: unknown = {}, failed = false) => ({ tool, input, result, failed, main: true })

describe('requests', () => {
  test('a prompt starts a working request; the reply closes it with its first line', () => {
    let s = startRequest(blank(), 'Build the usage report for EU markets.', NOW)
    expect(s.requests[0]).toMatchObject({ turn: 1, status: 'working', outcome: null })
    expect(s.title).toBe('Build the usage report for EU markets.')
    s = endRequest(s, 'answer', '## Plan\n\nI will fit a regression model per market.\n\n- step one', NOW + 5_000)
    expect(s.requests[0]).toMatchObject({ status: 'answered', outcome: 'Plan', endedAt: NOW + 5_000 })
  })

  test('a reply that ends on a question waits on you, and your next prompt answers it', () => {
    let s = startRequest(blank(), 'Pick the cohort size for the forecast.', NOW)
    s = endRequest(s, 'answer', 'Both work.\n\nShould I use weekly or monthly cohorts?', NOW + 1)
    expect(s.requests[0]?.status).toBe('waiting')
    expect(openQuestions(s).map(q => [q.text, q.by])).toEqual([['Should I use weekly or monthly cohorts?', 'claude']])
    s = startRequest(s, 'monthly', NOW + 2)
    expect(openQuestions(s)).toEqual([])
    expect(s.questions[0]).toMatchObject({ status: 'answered', closedAt: NOW + 2 })
  })

  test('interrupted and failed turns are marked; acknowledgements do not name the session', () => {
    let s = startRequest(blank(), 'ok', NOW)
    expect(s.title).toBeNull()
    s = endRequest(s, 'aborted', '', NOW + 1)
    expect(s.requests[0]?.status).toBe('stopped')
    s = endRequest(startRequest(s, 'yes do it', NOW + 2), 'error', '', NOW + 3)
    expect(s.requests[1]?.status).toBe('error')
    expect(s.title).toBeNull()
  })

  test('typed text is separated from engine blocks and command echoes', () => {
    expect(stripPromptMarkers('<system-reminder>internal</system-reminder>\nfix the build')).toBe('fix the build')
    expect(stripPromptMarkers('<local-command-caveat>x</local-command-caveat><command-name>/model</command-name><local-command-stdout>Set model</local-command-stdout>')).toBe('')
    expect(stripPromptMarkers('<command-message>graphify</command-message>\n<command-name>/graphify</command-name>\n<command-args>src</command-args>')).toBe('/graphify src')
    expect(stripPromptMarkers('look at this <pasted_content id="1">a\nb\nc</pasted_content>')).toBe('look at this [pasted 3 lines]')
    expect(stripPromptMarkers('<task-notification><task-id>t1</task-id><status>completed</status></task-notification>')).toBe('')
  })

  test('first lines skip headings, fences and tables; ending questions need a final "?"', () => {
    expect(firstLine('```ts\ncode\n```\n**Done.** Tests pass.')).toBe('Done. Tests pass.')
    expect(firstLine('| a | b |\n|---|---|\n')).toBe('| a | b |')
    expect(firstLine('')).toBeNull()
    expect(endingQuestion('I fixed it.\n\nWant me to open a PR?')).toBe('Want me to open a PR?')
    expect(endingQuestion('Is it fine? I fixed it.')).toBeNull()
  })
})

describe('tasks', () => {
  test('your tasks change by hand; engine tasks only by removal', () => {
    let s = addTask(blank(), 'Write the report', 'you', null, 'pending', NOW)
    s = addTask(s, 'write the report', 'you', null, 'pending', NOW)
    expect(s.tasks).toHaveLength(1)
    const mine = s.tasks[0]!.id
    s = setTask(s, mine, 'running', NOW + 1)
    expect(openTasks(s)[0]?.status).toBe('running')
    s = addTask(s, 'Explore: find the fit code', 'agent', 'agent-1', 'running', NOW + 2)
    s = addTask(s, 'Explore: find the fit code', 'agent', 'agent-1', 'running', NOW + 2)
    expect(s.tasks).toHaveLength(2)
    const agent = s.tasks[1]!.id
    expect(setTask(s, agent, 'done', NOW + 3)).toBe(s)
    s = setTask(s, agent, 'drop', NOW + 3)
    expect(s.tasks.map(t => t.kind)).toEqual(['you'])
  })

  test("Claude's todo list is mirrored: ids stay, finished items stay as history", () => {
    let s = applyTodoWrite(blank(), [todo('Load data', 'in_progress'), todo('Fit model', 'pending')], NOW)
    expect(openTasks(s).map(t => [t.text, t.status, t.kind])).toEqual([['Load data', 'running', 'todo'], ['Fit model', 'pending', 'todo']])
    expect(applyTodoWrite(s, [todo('Load data', 'in_progress'), todo('Fit model', 'pending')], NOW + 1)).toBe(s)
    const loadId = s.tasks[0]!.id
    s = applyTodoWrite(s, [todo('Load data', 'completed'), todo('Fit model', 'in_progress')], NOW + 2)
    expect(s.tasks.find(t => t.text === 'Load data')).toMatchObject({ id: loadId, status: 'done' })
    s = applyTodoWrite(s, [todo('Report', 'pending')], NOW + 3)
    expect(s.tasks.map(t => [t.text, t.status])).toEqual([['Load data', 'done'], ['Report', 'pending']])
  })

  test("Claude's Task tools follow engine ids; a failed update changes nothing", () => {
    let s = applyTaskTool(blank(), 'TaskCreate', { subject: 'Build' }, { task: { id: '1', subject: 'Build' } }, NOW)
    s = applyTaskTool(s, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true, taskId: '1' }, NOW + 1)
    expect(s.tasks[0]).toMatchObject({ kind: 'plan', ref: '1', status: 'running' })
    expect(applyTaskTool(s, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: false }, NOW + 2)).toBe(s)
    s = applyTaskTool(s, 'TaskList', {}, { tasks: [{ id: '1', subject: 'Build', status: 'completed' }, { id: '2', subject: 'Ship', status: 'pending' }] }, NOW + 3)
    expect(s.tasks.map(t => [t.ref, t.status])).toEqual([['1', 'done'], ['2', 'pending']])
    s = applyTaskTool(s, 'TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true }, NOW + 4)
    expect(s.tasks.map(t => t.ref)).toEqual(['1'])
  })

  test('background work, sessions, agents and stops come from tool results', () => {
    let s = applyToolResult(blank(), call('Bash', { command: 'npm run watch', description: 'Watch build', run_in_background: true }, { backgroundTaskId: 'bg7' }), NOW)
    expect(s.tasks[0]).toMatchObject({ kind: 'background', ref: 'bg7', status: 'running', text: 'Watch build' })
    s = applyToolResult(s, call('TaskStop', { task_id: 'bg7' }, { message: 'stopped' }), NOW + 1)
    expect(s.tasks[0]?.status).toBe('stopped')
    s = applyToolResult(s, call('mcp__ccd_session__start_session', { title: 'Fix CI' }, { content: [{ type: 'text', text: 'started local_1234abcd-0000' }] }), NOW + 2)
    expect(s.tasks[1]).toMatchObject({ kind: 'session', ref: 'local_1234abcd-0000', text: 'Fix CI' })
    s = addTask(s, 'Explore code', 'agent', 'agent-9', 'running', NOW + 3)
    s = applyToolResult(s, call('Agent', { description: 'Explore code', run_in_background: true }, { status: 'async_launched' }), NOW + 4)
    expect(s.tasks[2]?.status).toBe('running')
    s = applyToolResult(s, call('Agent', { description: 'Explore code' }, { agentId: 'agent-9' }), NOW + 5)
    expect(s.tasks[2]?.status).toBe('done')
    s = addTask(s, 'Broken agent', 'agent', 'agent-10', 'running', NOW + 6)
    s = applyToolResult(s, call('Agent', { description: 'Broken agent' }, {}, true), NOW + 7)
    expect(s.tasks[3]?.status).toBe('failed')
  })

  test('notifications close background work by id, or the only running one', () => {
    let s = addTask(blank(), 'Long build', 'background', 'b1', 'running', NOW)
    s = addTask(s, 'Long test', 'background', 'b2', 'running', NOW)
    const [byId] = notices('<task-notification><task-id>b2</task-id><status>failed</status><summary>exit 1</summary></task-notification>')
    s = applyNotice(s, byId!, NOW + 1)
    expect(s.tasks.map(t => t.status)).toEqual(['running', 'failed'])
    const [noId] = notices('<task-notification>status: completed</task-notification>')
    s = applyNotice(s, noId!, NOW + 2)
    expect(s.tasks.map(t => t.status)).toEqual(['done', 'failed'])
    expect(doneTasks(s)).toHaveLength(2)
  })

  test('chapters, the /goal condition, files and answered questions', () => {
    let s = addQuestion(blank(), 'Which market first?', 'claude', NOW)
    s = applyToolResult(s, call('AskUserQuestion', { questions: [{ question: 'Which market first?' }] }, { answers: {} }), NOW + 1)
    expect(openQuestions(s)).toEqual([])
    s = applyToolResult(s, call('mcp__ccd_session__mark_chapter', { title: 'Model fitting', summary: 'regression per market' }), NOW + 2)
    expect(s.chapters[0]).toMatchObject({ title: 'Model fitting', summary: 'regression per market' })
    s = applyToolResult(s, call('ProposeGoal', { condition: 'forecast tests pass' }, { condition: 'forecast tests pass', askUser: true }), NOW + 3)
    expect(s.claudeGoal).toBe('forecast tests pass')
    s = applyToolResult(s, call('Edit', { file_path: 'src/fit.py' }), NOW + 4)
    s = applyToolResult(s, call('Read', { file_path: '/abs/data.csv' }), NOW + 5)
    expect(s.files.map(f => [f.path, f.writes, f.reads])).toEqual([[`${ROOT}/src/fit.py`, 1, 0], ['/abs/data.csv', 0, 1]])
    expect(applyToolResult(s, call('Edit', { file_path: 'x.py' }, {}, true), NOW + 6)).toBe(s)
  })
})

describe('goal and suggestions', () => {
  test('the goal fills in by itself: first request, then summary, then Claude Code /goal, then yours', () => {
    let s = startRequest(blank(), 'hi there', NOW)
    expect(effectiveGoal(s)).toBeNull()
    s = startRequest(s, 'Build the usage report for EU markets. Use regression.', NOW + 1)
    expect(effectiveGoal(s)).toEqual({ text: 'Build the usage report for EU markets.', source: 'first-request', at: null })
    s = startRequest(s, 'Now look at APAC too please', NOW + 2)
    expect(s.firstAsk).toBe('Build the usage report for EU markets.')
    s = applySuggested(s, { title: 'Usage report', goal: 'Ship a usage report for EU and US', now: null, outstanding: [], threads: [] }, 'haiku', NOW + 3)
    expect(effectiveGoal(s)).toMatchObject({ text: 'Ship a usage report for EU and US', source: 'summary', at: NOW + 3 })
    s = applyToolResult(s, call('ProposeGoal', { condition: 'forecast tests pass' }, { condition: 'forecast tests pass', askUser: false }), NOW + 4)
    expect(effectiveGoal(s)?.source).toBe('claude-code')
    s = setGoal(s, 'Ship v1 of the forecast', NOW + 5)
    expect(effectiveGoal(s)).toEqual({ text: 'Ship v1 of the forecast', source: 'you', at: NOW + 5 })
    expect(summaryOf(s).goal).toBe('Ship v1 of the forecast')
  })

  test('summaries keep the goal steady: a rewording or a missing goal keeps the last words', () => {
    const summary = (goal: string | null) => ({ title: null, goal, now: null, outstanding: [], threads: [] })
    let s = applySuggested(blank(), summary('Ship a usage report'), 'haiku', NOW)
    s = applySuggested(s, summary('Ship the usage report'), 'haiku', NOW + 1)
    expect(effectiveGoal(s)?.text).toBe('Ship a usage report')
    s = applySuggested(s, summary(null), 'haiku', NOW + 2)
    expect(effectiveGoal(s)?.text).toBe('Ship a usage report')
    s = applySuggested(s, summary('Build the status dashboard'), 'claude', NOW + 3)
    expect(effectiveGoal(s)).toMatchObject({ text: 'Build the status dashboard', source: 'summary' })
  })

  test('a brief is read from its Task line; label lines are skipped', () => {
    expect(leadSentence('Background (from the session that started this one):\nThe user is learning mods.\n\nTask:\nEvaluate the existing atlas mod for the user, then adapt it.')).toBe('Evaluate the existing atlas mod for the user, then adapt it.')
    expect(leadSentence('Context:\nWe ship Friday. Fix the flaky login test.')).toBe('We ship Friday.')
    const s = startRequest(blank(), 'Background:\nlong text here about things.\nTask: Rebuild the status dashboard with a rate cap.', NOW)
    expect(s.firstAsk).toBe('Rebuild the status dashboard with a rate cap.')
  })

  test('summary items hide once dismissed or tracked; a different reading shows only against your goal', () => {
    let s = applySuggested(blank(), { title: 'Usage report', goal: 'Build a usage report', now: 'Fitting models', outstanding: ['Write the report', 'Validate holdout'], threads: ['Weekly or monthly cohorts?'] }, 'haiku', NOW)
    expect(s.title).toBe('Usage report')
    expect(visibleSuggestions(s)).toEqual({ goal: null, now: 'Fitting models', outstanding: ['Write the report', 'Validate holdout'], threads: ['Weekly or monthly cohorts?'] })
    s = setGoal(s, 'Build the usage report', NOW + 1)
    expect(visibleSuggestions(s).goal).toBeNull()
    s = setGoal(s, 'Polish the slides', NOW + 1)
    expect(visibleSuggestions(s).goal).toBe('Build a usage report')
    s = dismiss(s, 'Build a usage report')
    s = addTask(s, 'Write the report', 'you', null, 'pending', NOW + 2)
    s = dismiss(s, 'Weekly or monthly cohorts?')
    expect(visibleSuggestions(s)).toEqual({ goal: null, now: 'Fitting models', outstanding: ['Validate holdout'], threads: [] })
  })

  test('the alignment line holds only what you set', () => {
    expect(alignmentLine(blank())).toBeNull()
    let s = setGoal(blank(), 'Ship the forecast', NOW)
    s = addTask(s, 'Write the report', 'you', null, 'pending', NOW)
    s = addTask(s, 'Agent work', 'agent', 'a1', 'running', NOW)
    expect(alignmentLine(s)).toBe('Conversation Atlas, set by the user for this session: goal "Ship the forecast". open tasks [k1] "Write the report". When you finish one of these tasks, end your reply with the line "Atlas: done <id>".')
    expect(alignmentLine(setGoal(blank(), 'Just a goal', NOW))).toBe('Conversation Atlas, set by the user for this session: goal "Just a goal".')
  })

  test('similar() matches rewordings but not short overlaps', () => {
    expect(similar('Write the holdout report', 'write holdout report')).toBe(true)
    expect(similar('fix', 'fix the flaky login test in CI')).toBe(false)
  })
})

describe('replay and saves', () => {
  test('replay rebuilds requests, agents, lists, chapters and closures from the transcript', () => {
    const rows = [
      { role: 'user' as const, text: 'Plan the usage report for EU.' },
      { role: 'assistant' as const, text: 'Starting.', toolUses: [
        { tool: 'TodoWrite', input: { todos: [todo('Load data', 'completed'), todo('Fit regression', 'in_progress')] }, result: {} },
        { tool: 'Agent', input: { description: 'Explore data' }, result: 'done', agentId: 'ag1' },
        { tool: 'Bash', input: { command: 'make watch', description: 'Watch', run_in_background: true }, result: { taskId: 'bg1' } },
        { tool: 'mcp__ccd_session__mark_chapter', input: { title: 'Data prep' }, result: 'ok' },
      ] },
      { role: 'assistant' as const, text: 'Data is loaded.\n\nShould I include APAC?' },
      { role: 'user' as const, text: '<task-notification><task-id>bg1</task-id><status>completed</status></task-notification>' },
      { role: 'user' as const, text: 'No, EU only.' },
      { role: 'assistant' as const, text: 'Understood: EU only.' },
    ]
    const s = replay(blank(), rows, NOW)
    expect(s.requests.map(r => [r.text, r.status, r.outcome])).toEqual([
      ['Plan the usage report for EU.', 'waiting', 'Data is loaded.'],
      ['No, EU only.', 'answered', 'Understood: EU only.'],
    ])
    expect(s.tasks.map(t => [t.text, t.kind, t.status])).toEqual([
      ['Load data', 'todo', 'done'],
      ['Fit regression', 'todo', 'running'],
      ['Explore data', 'agent', 'done'],
      ['Watch', 'background', 'done'],
    ])
    expect(s.chapters.map(c => c.title)).toEqual(['Data prep'])
    expect(s.questions.map(q => [q.text, q.status])).toEqual([['Should I include APAC?', 'answered']])
  })

  test('a map from version 0.2.0 gets its first request from its own history', () => {
    const old = { ...startRequest(startRequest(blank(), 'ok', NOW), 'Rebuild the status dashboard with a rate cap. Then test.', NOW) } as Record<string, unknown>
    delete old.firstAsk
    const up = upgrade(old as unknown as AtlasState)
    expect(up.firstAsk).toBe('Rebuild the status dashboard with a rate cap.')
    expect(upgrade(up)).toBe(up)
    expect(hydrate(JSON.parse(JSON.stringify(old)), 'model-session', ROOT, NOW).firstAsk).toBe('Rebuild the status dashboard with a rate cap.')
  })

  test('a restored map marks what was running as stopped; other shapes start fresh', () => {
    let s = startRequest(blank(), 'Run the long job please', NOW)
    s = addTask(s, 'Job', 'background', 'b1', 'running', NOW)
    s = addTask(s, 'Mine', 'you', null, 'running', NOW)
    const back = hydrate(JSON.parse(JSON.stringify(s)), 'model-session', ROOT, NOW + 10)
    expect(back.requests[0]?.status).toBe('stopped')
    expect(back.tasks.map(t => t.status)).toEqual(['stopped', 'running'])
    expect(hydrate({ v: 1, goal: { text: 'old' } }, 'x', ROOT, NOW).goal).toBeNull()
    expect(summaryOf(back)).toMatchObject({ id: 'model-session', root: ROOT, open: 1, questions: 0, turns: 1 })
  })
})

describe('summaries and sessions', () => {
  test('the digest carries the first request and the automatic goal', () => {
    let s = startRequest(blank(), 'Build the usage report for EU markets.', NOW)
    s = applySuggested(s, { title: null, goal: 'Ship a usage report', now: null, outstanding: [], threads: [] }, 'haiku', NOW)
    const digest = buildDigest(s)
    expect(digest).toContain('Goal set by the developer: none')
    expect(digest).toContain('Current automatic goal: Ship a usage report')
    expect(digest).toContain('First request of the session: Build the usage report for EU markets.')
  })

  test('the digest carries requests and results, never file contents', () => {
    let s = setGoal(blank(), 'Ship the forecast', NOW)
    s = startRequest(s, 'Read data.csv and fit the model', NOW)
    s = applyToolResult(s, call('Read', { file_path: 'data.csv' }, { file: { content: 'SECRET,ROW,CONTENT' } }), NOW)
    s = endRequest(s, 'answer', 'Fitted the model.', NOW + 1)
    const digest = buildDigest(s)
    expect(digest).toContain('Goal set by the developer: Ship the forecast')
    expect(digest).toContain('#1 developer: Read data.csv and fit the model')
    expect(digest).toContain('result: answered - Fitted the model.')
    expect(digest).not.toContain('SECRET')
  })

  test('summary replies parse from JSON with text around it', () => {
    expect(parseSummary('Here:\n```json\n{"title":"T","goal":"G","now":null,"outstanding":["a",""],"threads":[]}\n```')).toEqual({ title: 'T', goal: 'G', now: null, outstanding: ['a'], threads: [], done: [] })
    expect(parseSummary('{"title":null,"goal":"null","now":"","outstanding":[],"threads":[]}')).toBeNull()
    expect(parseSummary('no json')).toBeNull()
  })

  test("the desktop app's list parses defensively and merges with Atlas's records", () => {
    const desktop = parseDesktopSessions({ content: [{ type: 'text', text: JSON.stringify([
      { sessionId: 'local_a', title: 'Status dashboard', status: 'idle', lastActivityAt: '2027-01-15T10:00:00Z', cwd: ROOT },
      { sessionId: 'local_b', title: 'Elsewhere', cwd: '/other' },
      { sessionId: 'local_c', title: 'Tracked one', cliSessionId: 'rec-1' },
      { title: 'no id' },
    ]) }], isError: false })
    expect(desktop.map(d => d.id)).toEqual(['local_a', 'local_b', 'local_c'])
    expect(parseDesktopSessions({ content: [{ type: 'text', text: 'not json' }], isError: false })).toEqual([])
    expect(parseDesktopSessions({ content: [], structuredContent: { sessions: [{ id: 'x', name: 'Y' }] }, isError: false }).map(d => d.title)).toEqual(['Y'])
    const current = { id: 'cur', root: ROOT, title: 'This one', goal: 'G', open: 2, questions: 1, turns: 3, lastActive: NOW }
    const records = [
      { id: 'rec-1', root: ROOT, title: 'Old title', goal: 'Forecast', open: 1, questions: 0, turns: 5, lastActive: NOW - 60_000 },
      { id: 'rec-2', root: '/other', title: 'Other folder', goal: null, open: 0, questions: 0, turns: 1, lastActive: NOW },
    ]
    const rows = mergeSessions(current, records, desktop, ROOT)
    expect(rows.map(r => [r.title, r.current, r.tracked])).toEqual([
      ['This one', true, true],
      ['Status dashboard', false, false],
      ['Tracked one', false, true],
    ])
  })
})

describe('tasks sent to Claude, and tasks closed without you', () => {
  const mine = (text = 'Write the holdout report') => addTask(blank(), text, 'you', null, 'pending', NOW)

  test('Ask Claude: the prompt links to the task, and "Atlas: done" closes it with the first line of the reply', () => {
    let s = dispatchTask(mine(), 'k1', 'ask', NOW + 1)
    expect(s.tasks[0]).toMatchObject({ status: 'running', dispatch: { mode: 'ask', requestId: null, agentId: null } })
    expect(dispatchTask(s, 'k1', 'ask', NOW + 2)).toBe(s)
    expect(dispatchTask(addTask(s, 'Agent work', 'agent', 'a1', 'running', NOW), 'k2', 'ask', NOW).tasks[1]?.dispatch).toBeUndefined()
    s = startRequest(s, 'Atlas task k1: Write the holdout report\nPlease do this task now.', NOW + 3)
    const r = s.requests[0]!
    expect(r).toMatchObject({ text: 'Atlas task: Write the holdout report', taskId: 'k1' })
    expect(s.tasks[0]?.dispatch?.requestId).toBe(r.id)
    expect(s.firstAsk).toBeNull()
    s = endRequest(s, 'answer', 'Wrote it to docs/holdout.md.\n\n**Atlas: done k1**', NOW + 4)
    expect(s.tasks[0]).toMatchObject({ status: 'done', closedBy: 'claude', note: 'Wrote it to docs/holdout.md.', dispatch: null })
  })

  test('"Atlas: not done" and a cut-short turn put the task back to waiting, with why', () => {
    let s = dispatchTask(mine(), 'k1', 'ask', NOW)
    s = startRequest(s, 'Atlas task k1: Write the holdout report', NOW + 1)
    s = endRequest(s, 'answer', 'I need the CSV first.\n\nAtlas: not done k1 - the holdout CSV is missing', NOW + 2)
    expect(s.tasks[0]).toMatchObject({ status: 'pending', note: 'the holdout CSV is missing', dispatch: null })
    s = dispatchTask(s, 'k1', 'ask', NOW + 3)
    s = startRequest(s, 'Atlas task k1: Write the holdout report', NOW + 4)
    s = endRequest(s, 'aborted', '', NOW + 5)
    expect(s.tasks[0]).toMatchObject({ status: 'pending', note: 'Interrupted before Claude finished.' })
  })

  test('report lines: ids, a bare line with one task waiting, markdown, and only the last lines count', () => {
    expect(parseReports('x\n- `Atlas: done k3, k5`')).toEqual([{ done: true, ids: ['k3', 'k5'], reason: null }])
    expect(parseReports('Atlas: Not done k2 — waiting on data')).toEqual([{ done: false, ids: ['k2'], reason: 'waiting on data' }])
    expect(parseReports('Atlas: done k1\n' + 'line\n'.repeat(8))).toEqual([])
    expect(parseReports('Atlas: doneness k1')).toEqual([])
    let s = dispatchTask(addTask(mine(), 'Second task here', 'you', null, 'pending', NOW), 'k1', 'ask', NOW)
    s = applyReports(s, 'All set.\nAtlas: done', NOW + 1)
    expect(s.tasks.map(t => t.status)).toEqual(['done', 'pending'])
    // With no id and no single task waiting on Claude, a bare line changes nothing.
    expect(applyReports(s, 'Atlas: done', NOW + 2)).toBe(s)
  })

  test('a background agent ending closes the task, or puts it back; either way a note for Claude waits once', () => {
    let s = dispatchTask(mine(), 'k1', 'background', NOW)
    s = linkAgent(s, 'k1', 'agent-7')
    expect(s.tasks[0]?.dispatch).toMatchObject({ mode: 'background', agentId: 'agent-7' })
    const done = agentFinished(s, 'agent-7', 'answer', 'Report written to docs/holdout.md.', NOW + 1)
    expect(done.tasks[0]).toMatchObject({ status: 'done', closedBy: 'claude', note: 'Report written to docs/holdout.md.' })
    const [notes, cleared] = takeNotes(done)
    expect(notes).toEqual(['Conversation Atlas: a background agent the user started finished the task "Write the holdout report". Its answer began: "Report written to docs/holdout.md."'])
    expect(takeNotes(cleared)[0]).toEqual([])
    expect(agentFinished(s, 'agent-7', 'aborted', '', NOW + 1).tasks[0]).toMatchObject({ status: 'pending', note: 'The background agent was stopped.' })
    expect(agentFinished(s, 'agent-7', 'answer', 'No data.\nAtlas: not done k1 - no data', NOW + 1).tasks[0]).toMatchObject({ status: 'pending', note: 'no data' })
    expect(agentFinished(s, 'agent-other', 'answer', 'x', NOW + 1)).toBe(s)
  })

  test('summaries close finished tasks, but not one you reopened, one still queued, or one with a background agent', () => {
    const summary = (done: string[]) => ({ title: null, goal: null, now: null, outstanding: [], threads: [], done })
    let s = addTask(addTask(addTask(mine(), 'Queued task', 'you', null, 'pending', NOW), 'Agent task', 'you', null, 'pending', NOW), 'Plain task', 'you', null, 'pending', NOW)
    s = dispatchTask(s, 'k2', 'ask', NOW)
    s = dispatchTask(s, 'k3', 'background', NOW)
    s = applySuggested(s, summary(['k1', 'k2', 'k3', 'k9']), 'haiku', NOW + 1)
    expect(s.tasks.map(t => [t.id, t.status, t.closedBy ?? null])).toEqual([['k1', 'done', 'summary'], ['k2', 'running', null], ['k3', 'running', null], ['k4', 'pending', null]])
    s = setTask(s, 'k1', 'pending', NOW + 2)
    expect(s.tasks[0]).toMatchObject({ status: 'pending', keepOpen: true, closedBy: null })
    s = applySuggested(s, summary(['k1']), 'haiku', NOW + 3)
    expect(s.tasks[0]?.status).toBe('pending')
    // Claude's own report still closes it.
    s = applyReports(s, 'Done now.\nAtlas: done k1', NOW + 4)
    expect(s.tasks[0]).toMatchObject({ status: 'done', closedBy: 'claude' })
  })

  test('a restored map puts a task sent to Claude back to waiting and keeps the notes', () => {
    const s = addNote(dispatchTask(mine(), 'k1', 'ask', NOW), 'note')
    const back = hydrate(JSON.parse(JSON.stringify(s)), 'model-session', ROOT, NOW + 5)
    expect(back.tasks[0]).toMatchObject({ status: 'pending', dispatch: null, note: 'Interrupted when the session restarted.' })
    expect(back.pendingNotes).toEqual(['note'])
  })

  test('the digest and the sync prompt list your open tasks with ids; summary replies parse done ids', () => {
    let s = dispatchTask(addTask(mine(), 'Validate the cap', 'you', null, 'pending', NOW), 'k2', 'ask', NOW)
    s = addTask(s, 'Explore code', 'agent', 'a1', 'running', NOW)
    const digest = buildDigest(s)
    expect(digest).toContain('Open tasks the developer tracks: [k2] Validate the cap (sent to Claude); [k1] Write the holdout report')
    expect(digest).toContain('Other work in flight: Explore code (agent, running)')
    expect(buildSyncPrompt(s)).toContain('[k2] Validate the cap; [k1] Write the holdout report')
    expect(buildSyncPrompt(undefined)).toContain('done: leave it empty.')
    expect(parseSummary('{"title":null,"goal":null,"now":null,"outstanding":[],"threads":[],"done":["K1"," k2 ","x3",4]}')?.done).toEqual(['k1', 'k2'])
  })
})
