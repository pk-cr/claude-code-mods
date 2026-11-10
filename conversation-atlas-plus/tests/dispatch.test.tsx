import { describe, expect, mock, test } from 'claude-code/testing'

// Sending a task to Claude (Ask Claude in this session, or Background as a forked agent) and tasks that
// close without you: Claude's "Atlas: done" line, a background agent ending, or a summary.

const PLUGIN = 'conversation-atlas-plus'
const ROOT = '/home/dev/work'
const NOW = 1_800_000_000_000
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PANE_PROPS = { title: 'Atlas', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } as any
const SURFACES = ['terminal', 'desktop'] as const

type HostOptions = { summary?: string[]; spawn?: 'ok' | 'deny' | 'throw'; drop?: boolean; store?: Record<string, unknown> }

// A test host that records the prompts and agents Atlas sends. Each op gets exactly one stand-in.
function host(on: any, opts: HostOptions = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, opts.store ?? {})
  const calls = { submits: [] as any[], spawns: [] as any[], complete: [] as any[] }
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'dispatch-session' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { ok: true } }))
  on('prompt.submit', (_$: any, e: any) => {
    const fromAtlas = String(e.text ?? '').startsWith('Atlas task ')
    if (fromAtlas) calls.submits.push(e)
    if (fromAtlas && opts.drop) return { drop: 'blocked by a hook' }
    return { text: e.text, context: e.context }
  })
  on('agent.spawn', (_$: any, e: any) => {
    calls.spawns.push(e)
    if (opts.spawn === 'deny') return { deny: 'forks are off here' }
    if (opts.spawn === 'throw') throw new Error('no agents')
    return { model: 'test-model', agentId: `agent-${calls.spawns.length}` }
  })
  on('model.complete', (_$: any, e: any) => {
    calls.complete.push(e)
    const replies = opts.summary ?? ['{}']
    return { value: { isAnswered: true, text: replies[Math.min(calls.complete.length, replies.length) - 1] ?? '{}', usage: USAGE } }
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}', usage: USAGE } }))
  return { clock, calls }
}

const start = async ($: any, clock: any) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
}
const run = async ($: any, args: string) => (await $.command.run({ command: 'atlas', args, origin: { kind: 'composer' } })).text as string
const turn = ($: any, id: string, text: string) => $.turn.start({ turnId: id, text })
const reply = ($: any, id: string, answer: string, extra: Record<string, unknown> = {}) =>
  $.turn.complete({ turnId: id, answer, durationMs: 10, isAborted: false, reason: 'answer', ...extra })
const typed = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
const mount = ($: any, surface: 'terminal' | 'desktop') => $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'atlas', props: PANE_PROPS })
const drawn = async (ui: any) => JSON.stringify(await ui.drawn())
const keys = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.props.key ?? ''))
// The id of the task row titled `text`: its row button is keyed task-<id>-b.
const taskId = async (ui: any, text: string): Promise<string> => {
  for (const b of await ui.findAll({ type: 'Button' })) {
    const m = /^task-(k\d+)-b$/.exec(String(b.props.key ?? ''))
    if (m && String(b.props.label ?? '').startsWith(text.slice(0, 20))) return m[1]!
  }
  throw new Error(`no task row for ${text}`)
}

describe('Ask Claude', () => {
  for (const surface of SURFACES) {
    test(`sends your task as your words, follows the turn, and closes on "Atlas: done" (${surface})`, { timeoutMs: 30_000 }, async ($, on) => {
      const { clock, calls } = host(on)
      await start($, clock)
      expect(await run($, 'task Write the holdout report')).toBe('Task added: Write the holdout report')
      const ui = await mount($, surface)
      const id = await taskId(ui, 'Write the holdout report')
      await ui.press({ key: `task-${id}-b` })
      expect(await keys(ui)).toEqual(expect.arrayContaining([`task-${id}-ask`, `task-${id}-bg`, `task-${id}-done`, `task-${id}-drop`]))
      await ui.press({ key: `task-${id}-ask` })

      expect(calls.submits).toHaveLength(1)
      const sent = calls.submits[0]
      expect(sent.text.startsWith(`Atlas task ${id}: Write the holdout report\n`)).toBe(true)
      expect(sent.text).toContain(`end your reply with the line "Atlas: done ${id}"`)
      expect(sent.asUser === true || sent.origin?.asUser === true).toBe(true)
      expect(await drawn(ui)).toContain('queued for Claude')

      await turn($, 't1', sent.text)
      let text = await drawn(ui)
      expect(text).toContain('with Claude')
      expect(text).toContain('Atlas task: Write the holdout report')

      await reply($, 't1', `Wrote it to docs/holdout.md.\n\nAtlas: done ${id}`)
      text = await drawn(ui)
      expect(text).toContain('0 open · 1 done')
      await ui.press({ key: 'tasks-toggle' })
      expect(await drawn(ui)).toContain('done by Claude')
      await ui.press({ key: `task-${id}-b` })
      text = await drawn(ui)
      expect(text).toContain('Claude: Wrote it to docs/holdout.md.')
      expect(await keys(ui)).toContain(`task-${id}-reopen`)
      await ui.unmount()
    })
  }

  test('"Atlas: not done" and an interrupted turn put the task back to waiting with why', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock, calls } = host(on)
    await start($, clock)
    await run($, 'task Write the holdout report')
    const ui = await mount($, 'desktop')
    const id = await taskId(ui, 'Write the holdout report')
    await ui.press({ key: `task-${id}-b` })
    await ui.press({ key: `task-${id}-ask` })
    await turn($, 't1', calls.submits[0].text)
    await reply($, 't1', `I need the data first.\nAtlas: not done ${id} - the holdout CSV is missing`)
    expect(await drawn(ui)).toContain('1 open · 0 done')
    await ui.press({ key: `task-${id}-b` })
    expect(await drawn(ui)).toContain('Note: the holdout CSV is missing')

    await ui.press({ key: `task-${id}-ask` })
    expect(calls.submits).toHaveLength(2)
    await turn($, 't2', calls.submits[1].text)
    await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' } as any)
    await ui.press({ key: `task-${id}-b` })
    const text = await drawn(ui)
    expect(text).toContain('Note: Interrupted before Claude finished.')
    expect(await keys(ui)).toContain(`task-${id}-ask`)
    await ui.unmount()
  })

  test('a prompt a hook refuses puts the task back with the reason', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = host(on, { drop: true })
    await start($, clock)
    await run($, 'task Write the holdout report')
    const ui = await mount($, 'terminal')
    const id = await taskId(ui, 'Write the holdout report')
    await ui.press({ key: `task-${id}-b` })
    await ui.press({ key: `task-${id}-ask` })
    await ui.press({ key: `task-${id}-b` })
    expect(await drawn(ui)).toContain('Note: Not sent: blocked by a hook')
    expect(await keys(ui)).toContain(`task-${id}-ask`)
    await ui.unmount()
  })

  test('Ask Claude on a suggested item adds it as your task and sends it', { timeoutMs: 20_000 }, async ($, on) => {
    const summary = JSON.stringify({ title: 'T', goal: 'G', now: null, outstanding: ['Validate the holdout'], threads: [] })
    const { clock, calls } = host(on, { summary: [summary] })
    await start($, clock)
    await turn($, 't1', 'Report usage for EU')
    await reply($, 't1', 'Started.')
    await clock.advance(3_000)
    await clock.settle()
    const ui = await mount($, 'desktop')
    const row = (await keys(ui)).find(k => k.startsWith('st-') && k.endsWith('-b'))
    await ui.press({ key: row! })
    await ui.press({ key: 'st-ask' })
    expect(calls.submits).toHaveLength(1)
    expect(calls.submits[0].text).toMatch(/^Atlas task k\d+: Validate the holdout\n/)
    expect(await drawn(ui)).toContain('queued for Claude')
    await ui.unmount()
  })
})

// The test host cannot start an agent for a plugin: what $.agent.spawn returns there has no agent id,
// which the engine's contract reads as "no agent started". So these tests check the request Atlas makes
// and that a spawn without an id puts the task back to waiting. What happens once a real agent runs
// (linkAgent, its turn.complete, the note for Claude) is tested on the reducers in model.test.ts.
const spawnType = (e: any) => e.subagentType ?? e.subagent_type

describe('Background', () => {
  for (const surface of SURFACES) {
    test(`asks the engine for a fork with your task; with no agent id the task waits again (${surface})`, { timeoutMs: 30_000 }, async ($, on) => {
      const { clock, calls } = host(on)
      await start($, clock)
      await run($, 'task Write the holdout report')
      const ui = await mount($, surface)
      const id = await taskId(ui, 'Write the holdout report')
      await ui.press({ key: `task-${id}-b` })
      await ui.press({ key: `task-${id}-bg` })

      expect(calls.spawns).toHaveLength(1)
      expect(spawnType(calls.spawns[0])).toBe('fork')
      expect(String(calls.spawns[0].prompt).startsWith(`Atlas task ${id}: Write the holdout report\n`)).toBe(true)
      expect(String(calls.spawns[0].prompt)).toContain(`end your answer with the line "Atlas: done ${id}"`)
      // No second task row for the agent, and the task is back to waiting with why.
      expect(await drawn(ui)).toContain('1 open · 0 done')
      await ui.press({ key: `task-${id}-b` })
      expect(await drawn(ui)).toContain('Note: Background agent not started: no agent started')
      await ui.unmount()
    })
  }

  test('a refused or failed background agent leaves the task waiting with the reason', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = host(on, { spawn: 'deny' })
    await start($, clock)
    await run($, 'task Write the holdout report')
    expect(await run($, 'bg 1')).toBe('Background agent not started: forks are off here')
    const ui = await mount($, 'desktop')
    const id = await taskId(ui, 'Write the holdout report')
    await ui.press({ key: `task-${id}-b` })
    expect(await drawn(ui)).toContain('Note: Background agent not started: forks are off here')
    await ui.unmount()
  })

  test('an agent that throws leaves the task waiting', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = host(on, { spawn: 'throw' })
    await start($, clock)
    await run($, 'task Write the holdout report')
    expect(await run($, 'bg 1')).toBe('Background agents are not available here.')
    expect(await run($, 'tasks')).toContain('1. ○ Write the holdout report · you')
  })
})

describe('notes for Claude', () => {
  test('a note waiting from a background agent goes with your next prompt, once, and not with Atlas prompts', { timeoutMs: 20_000 }, async ($, on) => {
    const note = 'Conversation Atlas: a background agent the user started finished the task "Write the holdout report".'
    const saved = {
      v: 2, sessionId: 'dispatch-session', root: ROOT, startedAt: NOW, lastActive: NOW, turn: 0, seq: 1, title: null, firstAsk: null,
      goal: null, claudeGoal: null, suggested: null, dismissed: [], requests: [], questions: [], chapters: [], activity: [], files: [],
      tasks: [{ id: 'k1', text: 'Write the holdout report', status: 'done', kind: 'you', ref: null, at: NOW, updatedAt: NOW, turn: 0, closedBy: 'claude' }],
      pendingNotes: [note],
    }
    const { clock } = host(on, { store: { 's:dispatch-session': saved } })
    await start($, clock)
    expect((await typed($, 'What next?')).context ?? []).toEqual([note])
    expect((await typed($, 'And then?')).context ?? []).toEqual([])
  })
})

describe('closing without you', () => {
  test('the alignment line lists your tasks with ids; Claude reporting one in a normal reply closes it', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = host(on)
    await start($, clock)
    await run($, 'task Write the report')
    const sent = await typed($, 'go')
    expect(sent.context).toEqual(['Conversation Atlas, set by the user for this session: open tasks [k1] "Write the report". When you finish one of these tasks, end your reply with the line "Atlas: done <id>".'])
    await turn($, 't1', 'go')
    await reply($, 't1', 'The report is in docs/report.md.\n\nAtlas: done k1')
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await drawn(ui)).toContain('0 open · 1 done')
      await ui.unmount()
    }
    expect((await typed($, 'next')).context ?? []).toEqual([])
  })

  test('a summary closes a task it sees finished; a task you reopen stays open until Claude reports it', { timeoutMs: 30_000 }, async ($, on) => {
    const done = JSON.stringify({ title: 'T', goal: 'G', now: null, outstanding: [], threads: [], done: ['k1'] })
    const { clock } = host(on, { summary: [done, done] })
    await start($, clock)
    await run($, 'task Write the holdout report')
    await turn($, 't1', 'Write the holdout report section')
    await reply($, 't1', 'Wrote the holdout report.')
    await clock.advance(3_000)
    await clock.settle()
    const ui = await mount($, 'desktop')
    expect(await drawn(ui)).toContain('0 open · 1 done')
    await ui.press({ key: 'tasks-toggle' })
    expect(await drawn(ui)).toContain('done · auto')
    await ui.press({ key: 'task-k1-b' })
    expect(await drawn(ui)).toContain('Closed by the session summary. Reopen it if that is wrong.')
    await ui.press({ key: 'task-k1-reopen' })
    expect(await drawn(ui)).toContain('1 open · 0 done')

    await turn($, 't2', 'Polish it')
    await reply($, 't2', 'Polished.')
    await clock.advance(3_000)
    await clock.settle()
    expect(await drawn(ui)).toContain('1 open · 0 done')

    await turn($, 't3', 'Finish it')
    await reply($, 't3', 'Finished the report.\nAtlas: done k1')
    expect(await drawn(ui)).toContain('0 open · 1 done')
    await ui.unmount()
  })
})

describe('commands', () => {
  test('/atlas ask and /atlas bg send only your own open tasks', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock, calls } = host(on)
    await start($, clock)
    await run($, 'task First task to send')
    await run($, 'task Second task to send')
    await $.agent.spawn({ tool_use_id: 'u1', prompt: 'Please explore the data', description: 'Explore data', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: false, fork: false } as any)
    const numberOf = async (text: string) => {
      const line = (await run($, 'tasks')).split('\n').find(l => l.includes(text))
      return /^\s*(\d+)\./.exec(line ?? '')?.[1] ?? '0'
    }
    expect(await run($, `ask ${await numberOf('Explore data')}`)).toContain('Only your own tasks can be sent to Claude.')
    expect(await run($, `ask ${await numberOf('First task')}`)).toBe('Sending to Claude: First task to send')
    // A command sends once it has returned.
    expect(calls.submits).toHaveLength(0)
    await clock.advance(1)
    await clock.settle()
    expect(calls.submits).toHaveLength(1)
    expect(await run($, `ask ${await numberOf('First task')}`)).toBe('Only an open task of your own, not already with Claude, can be sent.')
    expect(await run($, `bg ${await numberOf('Second task')}`)).toBe('Background agent not started: no agent started')
    expect(spawnType(calls.spawns.at(-1))).toBe('fork')
    expect(await run($, 'ask 99')).toBe('Usage: /atlas ask <number from /atlas tasks>')
    expect(await run($, 'help')).toContain('/atlas bg <n>')
  })
})
