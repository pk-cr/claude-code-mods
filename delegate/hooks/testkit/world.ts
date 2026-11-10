// Shared by the test files: the stand-in engine beneath the plugin, and the helpers that raise events.
import { mock } from 'claude-code/testing'
import type { Engine, MockClock, MockSession } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, On } from 'claude-code'

import type { Counts, Gate } from '../../types'
import { fillCounts, fillGate } from '../policy'

export const T0 = Date.parse('2026-10-08T12:00:00Z')
export const SECRET = 'THE SECRET TEXT'

export const FULL = [
  '[difficulty: routine]',
  'Goal: list the exported functions in /home/me/proj/src/auth.ts.',
  'Scope: read-only, do not edit anything.',
  'Done when you have listed them all.',
  'Return format: a numbered list, under 200 words.',
  'Do not spawn agents.',
].join('\n')
export const BARE = '[difficulty: lookup]\nFind where the session key is read in /home/me/proj/src/state.ts and say which functions call it, with enough context for a stranger to follow.'
export const UNTAGGED = FULL.replace('[difficulty: routine]\n', '')

export type World = {
  clock: MockClock
  session: MockSession
  toasts: string[]
  commands: string[]
  listed: AgentInfo[]
  /** Every tool.call that reached the engine, as the plugin passed it on. */
  reached: Record<string, unknown>[]
  /** Every agent.spawn that reached the engine. */
  spawned: AgentSpawnInput[]
  /** The last value the mod wrote to each of its state keys. */
  state: Record<string, unknown>
  startedAt: number
  /** The store's entries. */
  store: Map<string, unknown>
  /** True makes `$.agent.list()` throw. */
  listFails: boolean
  /** A reason makes the engine refuse every spawn. */
  spawnDeny?: string
  /** How long the engine takes to start an agent, on the mock clock. */
  spawnDelay: number
}

export function engine(on: On): World {
  const world: World = {
    clock: mock.clock(on, { now: T0 }),
    session: mock.session(on),
    toasts: [],
    commands: [],
    listed: [],
    reached: [],
    spawned: [],
    state: {},
    startedAt: 1,
    store: new Map(),
    listFails: false,
    spawnDelay: 0,
  }
  let spawns = 0
  on('store.get', (_$, e) => ({ value: world.store.get(e.key) }))
  on('store.set', (_$, e) => {
    world.store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    world.store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...world.store.keys()] }))
  on('agent.list', () => {
    if (world.listFails) throw new Error('list is down')

    return { value: world.listed }
  })
  on('session.usage', () => ({
    value: { startedAt: world.startedAt, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } } as never,
  }))
  on('command.register', (_$, e) => {
    world.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('state.set', (_$, e, next) => {
    const write = e as unknown as { plugin: string; key: string; value: unknown }
    if (write.plugin === 'delegate') world.state[write.key] = write.value

    return next(e)
  })
  on('tool.call', (_$, e) => {
    world.reached.push(e as unknown as Record<string, unknown>)

    return { result: 'ok' }
  })
  on('agent.spawn', async (_$, e) => {
    world.spawned.push(e)
    if (world.spawnDelay > 0) await world.clock.sleep(world.spawnDelay)
    if (world.spawnDeny !== undefined) return { deny: world.spawnDeny } as never
    spawns += 1

    return { model: 'claude-sonnet-5-5', agentId: `a${spawns}` }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are an assistant.', scope: 'shared' }] }))
  on('tool.describe', () => ({ description: 'Launch a new agent.' }))

  return world
}

export let counter = 0
export const start = ($: Engine) => $.session.start({ cwd: '/work' } as never)
export const turnStart = ($: Engine) => $.turn.start({ text: 'go', turnId: `t${++counter}` } as never)
export const complete = ($: Engine, fields: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: 'a full answer, long enough', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer', ...fields } as never)
export const step = async ($: Engine, fields: Record<string, unknown> = {}) => {
  for await (const chunk of $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, ...fields } as never)) void chunk
}
export const agentCall = ($: Engine, fields: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Agent', tool_use_id: `tu${++counter}`, description: 'List auth exports', prompt: FULL, ...fields } as never)
export const readCall = ($: Engine, fields: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Read', tool_use_id: `tu${++counter}`, file_path: '/x/a.ts', ...fields } as never)
export const bashCall = ($: Engine, command: string) =>
  $.tool.call({ tool: 'Bash', tool_use_id: `b${++counter}`, command } as never)
export const spawnInput = (fields: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  tool_use_id: `tu${++counter}`,
  prompt: FULL,
  description: 'List auth exports',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-sonnet-5-5',
  background: true,
  fork: false,
  ...fields,
})
export const spawn = ($: Engine, fields: Partial<AgentSpawnInput> = {}) => $.agent.spawn(spawnInput(fields))
export const cmd = ($: Engine, args: string) =>
  $.command.run({ command: 'delegate', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
export const measure = ($: Engine, five: number | undefined) =>
  $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: five === undefined ? [] : [{ kind: 'five_hour', percentUsed: five }],
    changed: ['rateLimits'],
  } as never)
export const use = (i: number, o: number, r: number, w: number) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
  model: 'claude-haiku-5-5',
})
export const agent = (id: string, fields: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  description: 'x',
  type: 'general-purpose',
  status: 'running',
  ...fields,
})

export const countsOf = (world: World): Counts => fillCounts(world.state['counts'])
export const gateOf = (world: World): Gate => fillGate(world.state['gate'])
export const denyOf = (out: unknown): string | undefined => (out as { deny?: string }).deny
export const appended = (world: World): string[] =>
  world.session.appended().map(row => (row.message.content[0] as unknown as { text: string }).text)

