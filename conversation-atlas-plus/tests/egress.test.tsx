import { expect, mock, test } from 'claude-code/testing'

// Atlas may reach outside the session in exactly three ways: a Haiku digest and a Claude sync, both
// through this session's own Anthropic client, and the Claude desktop app's session list. Two more calls
// stay inside your session and run only when you press a button: Ask Claude submits one of your tasks
// as a prompt, and Background starts a fork of the session for it. This test drives every feature and
// fails on any other outbound call, on these calls aimed elsewhere, or on a prompt or agent Atlas sends
// without your press.

const ROOT = '/home/dev/work'
const NOW = 1_800_000_000_000
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const SUMMARY = JSON.stringify({ title: 'T', goal: 'G', now: 'N', outstanding: ['O'], threads: ['Q?'] })
const FORBIDDEN = ['http.fetch', 'process.run', 'fs.read', 'fs.write', 'fs.list', 'fs.stat', 'fs.exists', 'env.get', 'env.set', 'mcp.connect', 'tool.register', 'audio.play']

test('Atlas makes no outbound call outside its declared three', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  const forbidden: string[] = []
  const models: string[] = []
  const prompts: string[] = []
  const mcp: string[] = []
  const submits: string[] = []
  const spawns: any[] = []
  let forks = 0
  for (const op of FORBIDDEN) {
    on(op, () => {
      forbidden.push(op)
      return { value: undefined }
    })
  }
  on('model.complete', (_$: any, e: any) => {
    models.push(String(e.model))
    prompts.push(`${e.system ?? ''}\n${e.prompt}`)
    return { value: { isAnswered: true, text: SUMMARY, usage: USAGE } }
  })
  on('model.fork', () => {
    forks += 1
    return { value: { isAnswered: true, text: SUMMARY, usage: USAGE } }
  })
  on('mcp.call', (_$: any, e: any) => {
    mcp.push(`${e.server}/${e.tool} ${JSON.stringify(e.args)}`)
    return { value: { content: [{ type: 'text', text: '[]' }], isError: false } }
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'egress-session' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('agent.spawn', (_$: any, e: any) => {
    if (String(e.prompt ?? '').startsWith('Atlas task ')) spawns.push(e)
    return { model: 'm', agentId: `agent-${e.tool_use_id}` }
  })
  on('prompt.submit', (_$: any, e: any) => {
    if (String(e.text ?? '').startsWith('Atlas task ')) submits.push(String(e.text))
    return { text: e.text, context: e.context }
  })
  on('tool.call', (_$: any, e: any) => ({ result: e.tool === 'Read' ? { file: { content: 'PRIVATE FILE BODY' } } : { ok: true } }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as any)
  await clock.settle()
  const atlas = (args: string) => $.command.run({ command: 'atlas', args, origin: { kind: 'composer' } } as any)
  await atlas('goal Ship the forecast')
  await atlas('task Write the report')
  await $.prompt.submit({ text: 'Read the data and fit', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 't1', text: 'Read the data and fit' } as any)
  await $.tool.call({ tool: 'Read', file_path: 'data.csv' } as any)
  await $.tool.call({ tool: 'Edit', file_path: 'fit.py' } as any)
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Fit', status: 'in_progress', activeForm: 'Fitting' }] } as any)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which market?' }] } as any)
  await $.agent.spawn({ tool_use_id: 'u1', prompt: 'look', description: 'Explore', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: false, fork: false } as any)
  await $.turn.complete({ turnId: 't1', answer: 'Fitted.\n\nShall I continue?', durationMs: 1, isAborted: false, reason: 'answer' } as any)
  await clock.advance(65_000)
  await clock.settle()
  await atlas('sync')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'conversation-atlas-plus', surface, component: 'Pane', requestId: 'atlas', props: { title: 'Atlas', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as any)
    await ui.press({ key: 'sync' })
    await ui.unmount()
  }
  await atlas('status')

  // Nothing above was a press of Ask Claude or Background: no prompt and no agent from Atlas.
  expect(submits).toEqual([])
  expect(spawns).toEqual([])

  await atlas('task Run the holdout check')
  const ui = await $.ui.mount({ plugin: 'conversation-atlas-plus', surface: 'desktop', component: 'Pane', requestId: 'atlas', props: { title: 'Atlas', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as any)
  const rowOf = async (title: string) => {
    const b = (await ui.findAll({ type: 'Button' })).find((x: any) => /^task-k\d+-b$/.test(String(x.props.key ?? '')) && String(x.props.label ?? '').startsWith(title))
    return /^task-(k\d+)-b$/.exec(String(b?.props.key ?? ''))?.[1] ?? 'none'
  }
  const ids = [await rowOf('Write the report'), await rowOf('Run the holdout check')]
  await ui.press({ key: `task-${ids[0]}-b` })
  await ui.press({ key: `task-${ids[0]}-ask` })
  await ui.press({ key: `task-${ids[1]}-b` })
  await ui.press({ key: `task-${ids[1]}-bg` })
  await ui.unmount()
  expect(submits).toHaveLength(1)
  expect(submits[0]).toMatch(/^Atlas task k\d+: /)
  expect(spawns).toHaveLength(1)
  expect(spawns[0].subagentType ?? spawns[0].subagent_type).toBe('fork')

  expect(forbidden).toEqual([])
  expect(models.length).toBeGreaterThanOrEqual(1)
  expect([...new Set(models)]).toEqual(['haiku'])
  expect(forks).toBe(3)
  expect(mcp.length).toBeGreaterThanOrEqual(2)
  expect([...new Set(mcp)]).toEqual(['ccd_session_mgmt/list_sessions {"limit":20}'])
  // The digest holds what you typed and how turns ended; never a file's contents.
  for (const prompt of prompts) expect(prompt).not.toContain('PRIVATE FILE BODY')
})
