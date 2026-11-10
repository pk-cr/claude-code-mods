import { describe, expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'conversation-atlas-plus'
const ROOT = '/home/dev/work'
const NOW = 1_800_000_000_000
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PANE_PROPS = { title: 'Atlas', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } as any
const SURFACES = ['terminal', 'desktop'] as const

type HostOptions = {
  store?: Record<string, unknown>
  summary?: string | string[]
  sync?: string
  sessions?: unknown
  messages?: unknown[]
  failModels?: boolean
  failSessions?: boolean
}

// A test host: a store you can read, model and MCP stand-ins that record every call, and the engine
// events a session raises. Each op gets exactly one stand-in.
function host(on: any, opts: HostOptions = {}) {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const calls = { complete: [] as any[], fork: [] as any[], mcp: [] as any[], toasts: [] as string[], logs: [] as string[] }
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$: any, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'host-session' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.messages', () => ({ value: opts.messages ?? [] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$: any, e: any) => {
    calls.toasts.push(String(e.text ?? ''))
    return { value: undefined }
  })
  on('ui.log', (_$: any, e: any) => {
    calls.logs.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('agent.spawn', (_$: any, e: any) => ({ model: 'test-model', agentId: `agent-${e.tool_use_id}` }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'Bash' && e.run_in_background) return { result: { backgroundTaskId: 'bg1' } }
    if (e.tool === 'mcp__ccd_session__start_session') return { result: { content: [{ type: 'text', text: 'Started local_abcdef12-3456' }] } }
    return { result: { ok: true } }
  })
  on('model.complete', (_$: any, e: any) => {
    calls.complete.push(e)
    if (opts.failModels) throw new Error('model refused')
    const replies = Array.isArray(opts.summary) ? opts.summary : [opts.summary ?? '{}']
    return { value: { isAnswered: true, text: replies[Math.min(calls.complete.length, replies.length) - 1] ?? '{}', usage: USAGE } }
  })
  on('model.fork', (_$: any, e: any) => {
    calls.fork.push(e)
    if (opts.failModels) throw new Error('fork refused')
    return { value: { isAnswered: true, text: opts.sync ?? '{}', usage: USAGE } }
  })
  on('mcp.call', (_$: any, e: any) => {
    calls.mcp.push(e)
    if (opts.failSessions) throw new Error('not allowed')
    return { value: { content: [{ type: 'text', text: JSON.stringify(opts.sessions ?? []) }], isError: false } }
  })
  return { clock, store, calls }
}

const start = async ($: any, clock: any) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
}
const run = async ($: any, args: string) => (await $.command.run({ command: 'atlas', args, origin: { kind: 'composer' } })).text as string
const turn = ($: any, id: string, text: string) => $.turn.start({ turnId: id, text })
const reply = ($: any, id: string, answer: string, extra: Record<string, unknown> = {}) =>
  $.turn.complete({ turnId: id, answer, durationMs: 10, isAborted: false, reason: 'answer', ...extra })
const spawn = ($: any, id: string, description: string) =>
  $.agent.spawn({ tool_use_id: id, prompt: `Please ${description} carefully`, description, subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: false, fork: false })
const mount = ($: any, surface: 'terminal' | 'desktop') => $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'atlas', props: PANE_PROPS })
const drawn = async (ui: any) => JSON.stringify(await ui.drawn())
const keys = async (ui: any, prefix: string): Promise<string[]> =>
  (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.props.key ?? '')).filter((k: string) => k.startsWith(prefix))

describe('the map follows the session', () => {
  test('requests, now, agents, background jobs and files update on both surfaces', { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = host(on)
    await start($, clock)
    await turn($, 't1', 'Build the usage report for EU')
    await $.tool.call({ tool: 'Read', file_path: 'src/fit.py' } as any)
    await spawn($, 'tu1', 'Explore fit code')
    await $.tool.call({ tool: 'Bash', command: 'make watch', description: 'Watch the build', run_in_background: true } as any)

    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      const text = await drawn(ui)
      expect(text).toContain('NOW')
      expect(text).toContain('Build the usage report for EU')
      expect(text).toContain('working')
      expect(text).toContain('Explore fit code')
      expect(text).toContain('Watch the build')
      expect(text).toContain('fit.py')
      expect(text).toContain('2 open · 0 done')
      await ui.unmount()
    }

    await reply($, 'a1', 'Found it in src/fit.py.', { agentId: 'agent-tu1' })
    await turn($, 'n1', '<task-notification><task-id>bg1</task-id><status>completed</status></task-notification>')
    await reply($, 't1', 'Fitted regression for 4 markets.\n\nDetails follow.')
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      const text = await drawn(ui)
      expect(text).toContain('Fitted regression for 4 markets.')
      expect(text).toContain('0 open · 2 done')
      expect(text).toContain('1 request')
      await ui.unmount()
    }
  })

  test("a question Claude ends on waits on you and closes when you reply", { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = host(on)
    await start($, clock)
    await turn($, 't1', 'Pick the cohort size')
    await reply($, 't1', 'Both are possible.\n\nShould I use weekly or monthly cohorts?')
    let ui = await mount($, 'desktop')
    let text = await drawn(ui)
    expect(text).toContain('waiting on you')
    expect(text).toContain('Should I use weekly or monthly cohorts?')
    expect(text).toContain('1 open · 0 answered')
    await ui.unmount()
    await turn($, 't2', 'monthly')
    ui = await mount($, 'terminal')
    text = await drawn(ui)
    expect(text).toContain('0 open · 1 answered')
    await ui.unmount()
  })

  test('chapters group the conversation; the transcript is replayed when Atlas joins late', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock, calls } = host(on, {
      summary: JSON.stringify({ title: 'Status dashboard', goal: 'Build the rate-capped status dashboard', now: null, outstanding: [], threads: [] }),
      messages: [
        { role: 'user', text: 'Plan the status dashboard' },
        { role: 'assistant', text: 'Planned it.', toolUses: [{ tool: 'mcp__ccd_session__mark_chapter', input: { title: 'Planning' }, result: 'ok' }] },
        { role: 'user', text: 'Now build the rate cap' },
        { role: 'assistant', text: 'Built the cap.' },
      ],
    })
    await start($, clock)
    const ui = await mount($, 'desktop')
    const text = await drawn(ui)
    expect(text).toContain('2 requests')
    expect(text).toContain('— Planning')
    expect(text).toContain('Built the cap.')
    expect(text).toContain('Plan the status dashboard')
    expect(text).toContain('auto · first request')
    await ui.unmount()
    // Joining a session with history maps it once, without waiting for the next answer.
    await clock.advance(3_000)
    await clock.settle()
    expect(calls.complete).toHaveLength(1)
    expect(await run($, 'goal')).toBe('Goal (automatic, from the latest summary): Build the rate-capped status dashboard')
  })
})

describe('goal and alignment', () => {
  test('the goal set in the pane rides along with each prompt until align is off', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = host(on)
    await start($, clock)
    let sent = await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false } as any)
    expect(sent.context ?? []).toEqual([])
    const ui = await mount($, 'desktop')
    expect(await drawn(ui)).toContain('No goal yet')
    await ui.press({ key: 'goal-edit' })
    await ui.input({ key: 'goal-input', text: 'Ship the usage report v1' })
    const text = await drawn(ui)
    expect(text).toContain('Ship the usage report v1')
    expect(text).not.toContain('goal-input')
    await ui.unmount()
    expect(await run($, 'task Write the holdout report')).toBe('Task added: Write the holdout report')
    sent = await $.prompt.submit({ text: 'next', origin: { kind: 'composer' }, wait: false } as any)
    expect(sent.context).toEqual(['Conversation Atlas, set by the user for this session: goal "Ship the usage report v1". open tasks [k1] "Write the holdout report". When you finish one of these tasks, end your reply with the line "Atlas: done <id>".'])
    expect(await run($, 'align off')).toContain('Align off')
    sent = await $.prompt.submit({ text: 'again', origin: { kind: 'composer' }, wait: false } as any)
    expect(sent.context ?? []).toEqual([])
  })

  test('commands set, list and close goals, tasks and questions', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = host(on)
    await start($, clock)
    expect(await run($, 'goal')).toContain('No goal yet')
    expect(await run($, 'goal Ship the forecast')).toBe('Goal set: Ship the forecast')
    await run($, 'task Write the report')
    await spawn($, 'tu9', 'Explore data')
    expect(await run($, 'tasks')).toContain('1. ● Explore data · agent')
    expect(await run($, 'tasks')).toContain('2. ○ Write the report · you')
    expect(await run($, 'done 1')).toContain('ends by itself')
    expect(await run($, 'done 2')).toBe('Finished: Write the report')
    expect(await run($, 'drop 1')).toBe('Removed: Explore data')
    expect(await run($, 'question Weekly or monthly?')).toBe('Question tracked: Weekly or monthly?')
    expect(await run($, 'questions')).toContain('1. Weekly or monthly? · you')
    expect(await run($, 'answered 1')).toBe('Answered: Weekly or monthly?')
    expect(await run($, 'goal clear')).toBe('The goal is automatic again.')
    expect(await run($, 'status')).toContain('Nothing else: Atlas makes no HTTP, process or file calls')
    expect(await run($, 'bogus')).toContain('Unknown: bogus')
  })
})

describe('automatic goal', () => {
  const said = (goal: string) => JSON.stringify({ title: 'T', goal, now: null, outstanding: [], threads: [] })

  test('fills in from the first request, follows the summaries, and yields to your override', { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = host(on, { summary: [said('Ship a usage report'), said('Ship the usage report'), said('Build the status dashboard'), said('Build the status dashboard')] })
    await start($, clock)
    await turn($, 't1', 'Build the usage report for EU. Start with the data.')
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      const text = await drawn(ui)
      expect(text).toContain('Build the usage report for EU.')
      expect(text).toContain('auto · first request')
      await ui.unmount()
    }
    expect(await run($, 'goal')).toBe('Goal (automatic, from your first request): Build the usage report for EU.')

    await reply($, 't1', 'Loaded.')
    await clock.advance(3_000)
    await clock.settle()
    expect(await run($, 'goal')).toBe('Goal (automatic, from the latest summary): Ship a usage report')
    await turn($, 't2', 'Continue')
    await reply($, 't2', 'Done.')
    await clock.advance(3_000)
    await clock.settle()
    expect(await run($, 'goal')).toContain('Ship a usage report')
    await turn($, 't3', 'Switch to the status dashboard')
    await reply($, 't3', 'Switched.')
    await clock.advance(3_000)
    await clock.settle()
    expect(await run($, 'goal')).toBe('Goal (automatic, from the latest summary): Build the status dashboard')

    // The automatic goal is shown, never sent.
    let sent = await $.prompt.submit({ text: 'x', origin: { kind: 'composer' }, wait: false } as any)
    expect(sent.context ?? []).toEqual([])
    expect(await run($, 'goal Ship v1 of the usage report')).toBe('Goal set: Ship v1 of the usage report')
    sent = await $.prompt.submit({ text: 'y', origin: { kind: 'composer' }, wait: false } as any)
    expect(sent.context).toEqual(['Conversation Atlas, set by the user for this session: goal "Ship v1 of the usage report".'])

    await turn($, 't4', 'More dashboard work')
    await reply($, 't4', 'Done.')
    await clock.advance(3_000)
    await clock.settle()
    const ui = await mount($, 'desktop')
    let text = await drawn(ui)
    expect(text).toContain('Ship v1 of the usage report')
    expect(text).toContain('Claude reads it as: Build the status dashboard')
    await ui.press({ key: 'goal-edit' })
    await ui.press({ key: 'goal-cancel' })
    await ui.press({ key: 'goal-keep' })
    text = await drawn(ui)
    expect(text).not.toContain('Claude reads it as')
    await ui.press({ key: 'goal-auto' })
    text = await drawn(ui)
    expect(text).toContain('Build the status dashboard')
    expect(text).toContain('auto · ')
    await ui.press({ key: 'goal-pin' })
    expect(await run($, 'goal')).toBe('Goal (set by you): Build the status dashboard')
    await ui.unmount()
  })

  test('with summaries off the goal stays on your first real request', { timeoutMs: 20_000, options: { summaries: 'off' } }, async ($, on) => {
    const { clock, calls } = host(on)
    await start($, clock)
    await turn($, 't1', 'hi')
    expect(await run($, 'goal')).toContain('No goal yet')
    await turn($, 't2', 'Fix the flaky login test in CI before Friday')
    await reply($, 't2', 'Fixed.')
    await clock.advance(10_000)
    await clock.settle()
    expect(await run($, 'goal')).toBe('Goal (automatic, from your first request): Fix the flaky login test in CI before Friday')
    expect(calls.complete).toEqual([])
  })

  test("Claude Code's /goal comes before the automatic goal", { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = host(on)
    await start($, clock)
    await turn($, 't1', 'Build the usage report for EU')
    await $.tool.call({ tool: 'ProposeGoal', condition: 'all forecast tests pass', ask_user: false } as any)
    expect(await run($, 'goal')).toBe("Goal (Claude Code's /goal): all forecast tests pass")
    const ui = await mount($, 'terminal')
    expect(await drawn(ui)).toContain('Claude Code /goal')
    await ui.unmount()
  })
})

describe('summaries', () => {
  const SUMMARY = JSON.stringify({ title: 'Usage report', goal: 'Ship a usage report', now: 'Fitting models', outstanding: ['Validate the holdout'], threads: ['Weekly or monthly cohorts?'] })

  test('after each answer Haiku suggests; Use, Add and Dismiss act on the suggestions', { timeoutMs: 30_000 }, async ($, on) => {
    const { clock, calls } = host(on, { summary: SUMMARY })
    await start($, clock)
    await turn($, 't1', 'Report usage for EU')
    await reply($, 't1', 'Started the fit.')
    await clock.advance(3_000)
    await clock.settle()
    expect(calls.complete).toHaveLength(1)
    expect(calls.complete[0].model).toBe('haiku')
    expect(calls.complete[0].prompt).toContain('#1 developer: Report usage for EU')

    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      const text = await drawn(ui)
      expect(text).toContain('Usage report')
      expect(text).toContain('Ship a usage report')
      expect(text).toContain('Validate the holdout')
      expect(text).toContain('Weekly or monthly cohorts?')
      expect(text).toContain('suggested')
      await ui.unmount()
    }

    const ui = await mount($, 'desktop')
    await ui.press({ key: 'goal-pin' })
    const [taskRow] = await keys(ui, 'st-')
    await ui.press({ key: taskRow! })
    await ui.press({ key: 'st-add' })
    const [threadRow] = await keys(ui, 'sq-')
    await ui.press({ key: threadRow! })
    await ui.press({ key: 'sq-dismiss' })
    const text = await drawn(ui)
    expect(text).toContain('Ship a usage report')
    expect(text).toContain('you · now')
    expect(text).toContain('1 open · 0 done')
    expect(text).not.toContain('Weekly or monthly cohorts?')
    await ui.unmount()

    // The next summary offers the same thread again: it stays dismissed.
    await turn($, 't2', 'Continue')
    await reply($, 't2', 'Continued.')
    await clock.advance(3_000)
    await clock.settle()
    expect(calls.complete).toHaveLength(2)
    expect(await drawn(await mount($, 'terminal'))).not.toContain('Weekly or monthly cohorts?')
  })

  test('Sync asks Claude through a fork of this session', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock, calls } = host(on, { sync: SUMMARY })
    await start($, clock)
    await turn($, 't1', 'Report usage')
    await reply($, 't1', 'Done.')
    const ui = await mount($, 'desktop')
    await ui.press({ key: 'sync' })
    expect(calls.fork).toHaveLength(1)
    const text = await drawn(ui)
    expect(text).toContain('synced now')
    expect(text).toContain('Validate the holdout')
    await ui.unmount()
    expect(await run($, 'sync')).toContain('Synced')
  })

  test('summaries off makes no model call and offers no Sync', { timeoutMs: 20_000, options: { summaries: 'off' } }, async ($, on) => {
    const { clock, calls } = host(on, { summary: SUMMARY, sync: SUMMARY })
    await start($, clock)
    await turn($, 't1', 'Report usage')
    await reply($, 't1', 'Done.')
    await clock.advance(10_000)
    await clock.settle()
    const ui = await mount($, 'desktop')
    expect(await keys(ui, 'sync')).toEqual([])
    await ui.unmount()
    expect(await run($, 'sync')).toBe('Sync is off in the Summaries setting.')
    expect(calls.complete).toEqual([])
    expect(calls.fork).toEqual([])
  })

  test('failed model calls and a refused session list stay silent', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock, calls } = host(on, { failModels: true, failSessions: true })
    await start($, clock)
    await turn($, 't1', 'Report usage')
    await reply($, 't1', 'Done.')
    await clock.advance(70_000)
    await clock.settle()
    expect(calls.complete).toHaveLength(1)
    expect(calls.mcp.length).toBeGreaterThanOrEqual(1)
    expect(calls.toasts).toEqual([])
    expect(calls.logs).toEqual([])
    const ui = await mount($, 'desktop')
    await ui.press({ key: 'sync' })
    const text = await drawn(ui)
    expect(text).toContain('Sync did not finish.')
    expect(text).toContain('Report usage')
    await ui.unmount()
    expect(calls.toasts).toEqual([])
    expect(calls.logs).toEqual([])
  })
})

describe('sessions and storage', () => {
  test("the Sessions list joins Atlas's records with the desktop app's list", { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = host(on, {
      store: {
        index: [{ id: 'older', root: ROOT, title: 'Status dashboard', goal: 'Cap rate at $75', open: 3, questions: 1, turns: 9, lastActive: NOW - 3_600_000 }],
      },
      sessions: [
        { sessionId: 'local_1', title: 'Token usage mod', status: 'working', lastActivityAt: NOW - 60_000 },
        { sessionId: 'local_2', title: 'Another folder', cwd: '/elsewhere' },
      ],
    })
    await start($, clock)
    await turn($, 't1', 'Map the usage work')
    await clock.advance(62_000)
    await clock.settle()
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      const text = await drawn(ui)
      expect(text).toContain('(this session)')
      expect(text).toContain('Status dashboard')
      expect(text).toContain('3 open')
      expect(text).toContain('Token usage mod')
      expect(text).not.toContain('Another folder')
      await ui.unmount()
    }
  })

  test('the map is saved locally, old v0.1 keys are removed, and a restart restores it', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock, store } = host(on, {
      store: { setup: { observer: 'claude' }, 'trail-view': {}, 'session:old': { prompt: 'excerpt' }, 'project:/x': {} },
    })
    await start($, clock)
    await run($, 'goal Ship it')
    await clock.advance(2_000)
    await clock.settle()
    const savedKeys = [...store.keys()].sort()
    expect(savedKeys).toEqual(['index', 's:host-session'])
    expect((store.get('s:host-session') as any).goal.text).toBe('Ship it')
    expect((store.get('index') as any)[0]).toMatchObject({ id: 'host-session', goal: 'Ship it' })
  })

  test('old keys another session writes back are removed again within a minute', { timeoutMs: 20_000 }, async ($, on) => {
    const { clock, store } = host(on)
    await start($, clock)
    store.set('session:other', { prompt: 'excerpt' })
    store.set('project:/home/dev/work', { goal: 'old' })
    await clock.advance(62_000)
    await clock.settle()
    expect([...store.keys()].filter(k => k.startsWith('session:') || k.startsWith('project:'))).toEqual([])
  })
})
