import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock, Mounted } from 'claude-code/testing'
import type {
  AgentInfo,
  AgentSpawnInput,
  FsEntry,
  On,
  PaneOpenArgs,
  RenderElement,
  RenderSurface,
  SessionUsage,
  TurnStepChunk,
  TurnStepInput,
} from 'claude-code'

import {
  addConflict,
  addPending,
  addSpendTokens,
  addTokens,
  applyLesson,
  asOutcomes,
  asView,
  DEFAULT_PEER_OPTIONS,
  callDetail,
  cleanText,
  clockTime,
  buildMatchers,
  billedTokens,
  budgetUse,
  chooseRoute,
  downMove,
  exploreRate,
  historyFrom,
  seedFraction,
  wilsonLower,
  claimRoute,
  classifyTask,
  contextOf,
  countAgent,
  describeCall,
  describeLessons,
  describeRoute,
  describeSpend,
  cardDetails,
  routeSummary,
  dropPending,
  editedPath,
  findMentions,
  findPeer,
  formatElapsed,
  formatTokens,
  freeSeat,
  hiddenLine,
  isBusy,
  isArenaTeam,
  isMoving,
  isPeerEntry,
  isSettling,
  isWaiting,
  kindSpendOf,
  lessonsFrom,
  lastActiveOf,
  liveDirOf,
  liveFileName,
  liveFileOf,
  livePrint,
  newLiveMemory,
  noteCall,
  noteFile,
  outcomeOf,
  parseLiveFile,
  parseRadarArgs,
  patchRows,
  peerBandOf,
  peerBandWords,
  peerLeadOf,
  peerLine,
  peerRowsOf,
  peerSessionsOf,
  peerTeamOf,
  projectName,
  readPath,
  readDifficultyTag,
  isGauntletClose,
  reconcile,
  reviving,
  recordSkill,
  rivalsOf,
  routingWords,
  sessionsText,
  settledLead,
  settleRoute,
  shortModel,
  statusGlyph,
  statusLine,
  stepEffort,
  teamOf,
  tierOf,
  totalTokens,
  trimOutcomes,
  upsertRow,
  withEffort,
  withExpanded,
  withoutCd,
  withLabel,
  withPrefs,
  withView,
  viewWords,
  windowOf,
} from './register'
import type { LiveInput, SpawnFacts } from './register'
import { WALK_MS } from './office'
import type { AgentRow, LiveFile, LiveLead, MainState, Outcome, Route, RouteBook, RouterSettings, SkillUse } from '../types'

const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  title: 'Subagents',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
} as const

/** What the test sets up and reads back around the stand-in engine. */
type World = {
  clock: MockClock
  /** Every pane the mod asked to open. */
  opened: PaneOpenArgs[]
  /** What `$.agent.list()` answers: agents the engine tracks. */
  listed: AgentInfo[]
  /** The commands the mod registered. */
  commands: string[]
  /** Every spawn as it reached the engine, after the radar's hook. */
  spawned: AgentSpawnInput[]
  /** Every step as it reached the engine, after the radar's hook. */
  steps: TurnStepInput[]
  /** Every toast the mod showed. */
  toasts: string[]
  /** What `$.store` holds: the disk, as far as the mod can tell. */
  store: Map<string, unknown>
  /** Every Raster repaint the mod asked for. */
  blits: { requestId: string; key: string; columns?: number; rows?: number }[]
  /** What the file system holds, by path. */
  disk: Map<string, { text: string; mtimeMs: number }>
  /** Every `$.fs` call, in order. */
  fsCalls: { op: 'read' | 'write' | 'list'; path: string; text?: string }[]
  /** What `$.session.id()` answers: a test moves it on, as a /clear does. */
  sessionId: string
}

/** The home folder the stand-in engine reports, and the live folder and own file under it. */
const HOME = '/home/user'
const LIVE = '/home/user/.claude/agent-radar/live'
const OWN = `${LIVE}/s1.json`

const TEXT_STEP: readonly TurnStepChunk[] = [{ kind: 'text', index: 0, text: 'hello' }]

type EngineHooks = {
  /** Runs inside the engine's spawn, before it answers with an id. */
  beforeAnswer?: () => Promise<void>
  /** Refuses every tool call, as a failing tool would. */
  isRefusingTools?: boolean
  /** The permission verdict the engine reaches for every call. */
  checkDecision?: 'allow' | 'ask' | 'deny'
  /** Runs inside the engine's tool call, where its permission prompt would wait. */
  duringToolCall?: (call: { tool: string; tool_use_id?: string }) => Promise<void>
}

/** What stands for the engine beneath the plugin: it answers each event the mod hooks. */
function engine(on: On, chunks: readonly TurnStepChunk[] = TEXT_STEP, hooks: EngineHooks = {}): World {
  const world: World = {
    clock: mock.clock(on),
    opened: [],
    listed: [],
    commands: [],
    spawned: [],
    steps: [],
    toasts: [],
    store: new Map(),
    blits: [],
    disk: new Map(),
    fsCalls: [],
    sessionId: 's1',
  }
  let spawned = 0
  on('agent.spawn', async (_$, e) => {
    world.spawned.push(e)
    await hooks.beforeAnswer?.()

    return { model: 'claude-sonnet-5-5', agentId: `a${++spawned}` }
  })
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('tool.call', async (_$, e) => {
    await hooks.duringToolCall?.(e)

    return hooks.isRefusingTools === true ? { deny: 'refused' } : { result: 'ok' }
  })
  on('tool.check', () => ({ decision: hooks.checkDecision ?? 'allow' }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('session.id', () => ({ value: world.sessionId }))
  on('session.root', () => ({ value: '/work/agent-radar' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.write', (_$, e) => {
    world.fsCalls.push({ op: 'write', path: e.path, text: e.text })
    world.disk.set(e.path, { text: e.text, mtimeMs: world.clock.now() })

    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    world.fsCalls.push({ op: 'read', path: e.path })
    const file = world.disk.get(e.path)
    if (file === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: file.text }
  })
  on('fs.list', (_$, e) => {
    world.fsCalls.push({ op: 'list', path: e.path })
    const prefix = `${e.path}/`
    const entries = [...world.disk]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, file]) => ({
        name: path.slice(prefix.length),
        kind: 'file' as const,
        size: new TextEncoder().encode(file.text).length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      }))

    return { value: entries }
  })
  on('ui.blit', (_$, e) => {
    world.blits.push(e as World['blits'][number])

    return { value: {} }
  })
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
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($, e) {
    world.steps.push(e)
    yield* chunks

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  })
  on('agent.list', () => ({ value: world.listed }))
  on('ui.open', (_$, e) => {
    world.opened.push(e)

    return { value: { isPlaced: true } }
  })
  on('command.register', (_$, e) => {
    world.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 200_000,
        breakdown: {
          skills: { skillFrontmatter: [{ name: 'graphify' }, { name: 'asd-ste100' }, { name: 'run' }] },
        },
      },
    } as unknown as SessionUsage,
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, null, 'ENGINE BAND') as RenderElement
  })

  return world
}

/** A whole `agent.spawn` input: the engine's own `$` takes what an engine call site passes. */
function spawnInput(
  fields: Pick<AgentSpawnInput, 'description' | 'subagentType'> & Partial<AgentSpawnInput>,
): AgentSpawnInput {
  return {
    tool_use_id: `tu-${fields.description}`,
    prompt: 'Look around.',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-sonnet-5-5',
    background: false,
    fork: false,
    ...fields,
  }
}

/** What the person types after `/radar`. */
const radarArgs = (args: string) =>
  ({
    command: 'radar',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  }) as never

/** Reads a stream to its end. */
async function run(step: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of step) void chunk
}

const stepOf = (fields: Partial<TurnStepInput> = {}): TurnStepInput => ({
  turnId: 't1',
  index: 0,
  model: 'claude-sonnet-5-5',
  messageCount: 1,
  ...fields,
})

const row = (fields: Partial<AgentRow> = {}): AgentRow => ({
  id: 'a1',
  type: 'Explore',
  description: 'Survey the repo',
  status: 'running',
  phase: 'thinking',
  doing: 'thinking…',
  tools: 0,
  startedAt: 0,
  background: false,
  fork: false,
  ...fields,
})

/** The router's input as the rules read it. */
const facts = (
  fields: Pick<SpawnFacts, 'subagentType' | 'description' | 'prompt'> & Partial<SpawnFacts>,
): SpawnFacts => ({
  fork: false,
  parentModel: 'claude-sonnet-5-5',
  provider: { plugin: 'engine', tier: 'core' },
  ...fields,
})

const AUTO: RouterSettings = { mode: 'auto', ceiling: 'raise' }

const LOOKUP_ASK = {
  subagentType: 'Explore',
  description: 'Find the config loader',
  prompt: 'Find where the config is loaded. Do not modify any file.',
} as const

const HARD_ASK = {
  subagentType: 'general-purpose',
  description: 'Find the root cause of the deadlock',
  prompt: 'Investigate why the cache deadlocks under load. Think hard.',
} as const

const DELEGATE = { provider: { plugin: 'delegate', tier: 'user' } } as const

/** A delegate role's brief, with the tag the delegate mod puts first. */
const roleAsk = (role: string, tag?: string) =>
  ({
    subagentType: `delegate:${role}`,
    description: 'Build the validation check',
    prompt: `${tag === undefined ? '' : `[difficulty: ${tag}] `}Implement the check in stats.py and run the tests.`,
    ...DELEGATE,
  }) as const

/** One response's usage: 6.5k tokens in all, 6.3k of context. */
const USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 300,
  model: 'claude-haiku-4-5',
} as const

/** A step that writes a line and then stops with `USAGE`. */
const STEP_WITH_USAGE = [
  { kind: 'text', index: 0, text: 'hello' },
  { kind: 'stop', stopReason: 'end_turn', usage: USAGE },
] as unknown as readonly TurnStepChunk[]

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const outcome = (fields: Partial<Outcome> = {}): Outcome => ({
  kind: 'lookup',
  struggled: false,
  wasRaised: false,
  tokens: 1000,
  at: 0,
  ...fields,
})

/** Ten past lookups, three of which struggled: 30%, over the 25% bar. */
const STRUGGLING_LOOKUPS: Outcome[] = Array.from({ length: 10 }, (_, at) => outcome({ struggled: at < 3, at }))

describe('shortModel', () => {
  test('words ids the way the card shows them', () => {
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet 5.5')
    expect(shortModel('claude-fable-5-1')).toBe('fable 5.1')
    expect(shortModel('claude-opus-4-1-20250805')).toBe('opus 4.1')
    expect(shortModel('claude-sonnet-4-20250514')).toBe('sonnet 4')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(shortModel('claude-opus-4-1[1m]')).toBe('opus 4.1')
  })

  test('leaves aliases alone and strips claude- from ids it does not know', () => {
    for (const alias of ['haiku', 'opus', 'sonnet', 'fable']) expect(shortModel(alias)).toBe(alias)
    expect(shortModel('claude-3-5-sonnet-20241022')).toBe('3-5-sonnet-20241022')
    expect(shortModel('gpt-x')).toBe('gpt-x')
    expect(shortModel(undefined)).toBe('')
    expect(shortModel('')).toBe('')
  })
})

describe('describeCall', () => {
  test('says what each tool does in a line', () => {
    expect(describeCall({ tool: 'Read', file_path: '/a/b/c.ts' })).toBe('Reading c.ts')
    expect(describeCall({ tool: 'Edit', file_path: '/a/b/c.ts' })).toBe('Editing c.ts')
    expect(describeCall({ tool: 'Write', file_path: 'notes.md' })).toBe('Writing notes.md')
    expect(describeCall({ tool: 'Bash', description: 'List files', command: 'ls -la' })).toBe('List files')
    expect(describeCall({ tool: 'Bash', command: 'ls   -la\n' })).toBe('Running ls -la')
    expect(describeCall({ tool: 'Grep', pattern: 'TODO' })).toBe('Searching "TODO"')
    expect(describeCall({ tool: 'Glob', pattern: '**/*.ts' })).toBe('Finding **/*.ts')
    expect(describeCall({ tool: 'WebFetch', url: 'https://example.com/a/b' })).toBe('Fetching example.com')
    expect(describeCall({ tool: 'WebSearch', query: 'plugin api' })).toBe('Searching the web: plugin api')
    expect(describeCall({ tool: 'Skill', skill: 'graphify' })).toBe('Loading skill graphify')
    expect(describeCall({ tool: 'Agent', description: 'Survey the repo' })).toBe('Delegating: Survey the repo')
    expect(describeCall({ tool: 'mcp__github__create_issue' })).toBe('Calling github · create_issue')
    expect(describeCall({ tool: 'TodoWrite' })).toBe('Using TodoWrite')
  })

  test('clips a long command', () => {
    const line = describeCall({ tool: 'Bash', command: 'x'.repeat(300) })
    expect(line.length).toBeLessThanOrEqual(80)
    expect(line).toEndWith('…')
  })
})

describe('formatElapsed', () => {
  test('uses seconds, minutes and hours', () => {
    expect(formatElapsed(12_000)).toBe('12s')
    expect(formatElapsed(65_000)).toBe('1m 05s')
    expect(formatElapsed(3_720_000)).toBe('1h 02m')
    expect(formatElapsed(-5)).toBe('0s')
  })
})

describe('statusGlyph', () => {
  test('gives each status its own glyph', () => {
    const glyphs = (
      ['running', 'waiting', 'idle', 'pending', 'completed', 'failed', 'killed'] as const
    ).map(status => statusGlyph(status).glyph)
    expect(glyphs).toEqual(['●', '◐', '○', '…', '✓', '✗', '■'])
    expect(statusGlyph('completed').color).toBeUndefined()
  })
})

describe('findMentions', () => {
  const matchers = buildMatchers(['graphify', 'run', 'loop', 'research', 'pdf-viewer:open', 'asd-ste100'])

  test('sees a slash, a skill: prefix and a "name skill" suffix', () => {
    expect(findMentions('I should use /graphify here', matchers)).toEqual(['graphify'])
    expect(findMentions('(/graphify)', matchers)).toEqual(['graphify'])
    expect(findMentions('Let me invoke the skill: graphify first', matchers)).toEqual(['graphify'])
    expect(findMentions('skills/asd-ste100 applies', matchers)).toEqual(['asd-ste100'])
    expect(findMentions('The Graphify skill covers it', matchers)).toEqual(['graphify'])
  })

  test('ignores a bare word, a path and a short name', () => {
    expect(findMentions('I will graphify the repo', matchers)).toEqual([])
    expect(findMentions('run the loop and research it', matchers)).toEqual([])
    expect(findMentions('see src/graphify/index.ts', matchers)).toEqual([])
    expect(findMentions('/graphify-out is a folder', matchers)).toEqual([])
    expect(findMentions('/run the thing', matchers)).toEqual([])
  })

  test('matches the part after a plugin prefix and reports the full name', () => {
    expect(findMentions('open the pdf-viewer:open skill', matchers)).toEqual(['pdf-viewer:open'])
    expect(findMentions('use skill open for it', matchers)).toEqual(['pdf-viewer:open'])
  })

  test('escapes the name', () => {
    const odd = buildMatchers(['a.b+c'])
    expect(findMentions('/a.b+c', odd)).toEqual(['a.b+c'])
    expect(findMentions('/aXb+c', odd)).toEqual([])
  })
})

describe('recordSkill', () => {
  test('upgrades a thought to invoked and names who loaded it', () => {
    let list: SkillUse[] = []
    list = recordSkill(list, 'graphify', 'thought')
    expect(list).toEqual([{ name: 'graphify', how: 'thought', isFinal: false }])
    expect(recordSkill(list, 'graphify', 'thought')).toBe(list)
    list = recordSkill(list, 'graphify', 'invoked', 'Explore')
    expect(list).toEqual([{ name: 'graphify', how: 'invoked', by: 'Explore', isFinal: false }])
    expect(recordSkill(list, 'graphify', 'thought')).toBe(list)
  })

  test('drops last turn\'s skills at the first new sighting', () => {
    const last: SkillUse[] = [{ name: 'old', how: 'invoked', isFinal: true }]
    expect(recordSkill(last, 'fresh', 'invoked')).toEqual([{ name: 'fresh', how: 'invoked', isFinal: false }])
  })
})

describe('rows', () => {
  test('patchRows never creates a row and keeps the list when nothing changes', () => {
    const list = [row()]
    expect(patchRows(list, 'ghost', { doing: 'x' })).toBe(list)
    expect(patchRows(list, 'a1', { doing: 'thinking…' })).toBe(list)
    expect(patchRows(list, 'a1', { doing: 'x' })[0]?.doing).toBe('x')
  })

  test('patchRows drops a field set to undefined', () => {
    const list = [row({ endedAt: 5 })]
    expect(patchRows(list, 'a1', { endedAt: undefined })[0]).not.toHaveProperty('endedAt')
  })

  test('upsertRow creates a row, then patches it', () => {
    const made = upsertRow([], 'a1', 100, { type: 'Explore', description: 'Survey', model: 'm' })
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ id: 'a1', startedAt: 100, status: 'running', model: 'm' })
    const patched = upsertRow(made, 'a1', 200, { description: 'Other' })
    expect(patched[0]).toMatchObject({ startedAt: 100, description: 'Other', model: 'm' })
  })

  test('the gauntlet\'s closing step is the Lead running `gauntlet.py winner`, and nothing else', () => {
    const bash = (command: string) => ({ tool: 'Bash', command })
    expect(isGauntletClose(bash('python3 "/Users/p/.claude/skills/gauntlet/gauntlet.py" winner'))).toBe(true)
    expect(isGauntletClose(bash("python3 '/x/gauntlet.py' winner"))).toBe(true)
    expect(isGauntletClose(bash('python3 gauntlet.py winner'))).toBe(true)
    expect(isGauntletClose(bash('python3 /x/gauntlet.py next'))).toBe(false)
    expect(isGauntletClose(bash('python3 /x/gauntlet.py status && echo winner'))).toBe(false)
    expect(isGauntletClose(bash('cat winner.md'))).toBe(false)
    expect(isGauntletClose(bash('python3 gauntlet.py winners'))).toBe(false)
    // The commands the orchestrator really sends: a Bash call has no memory, so G is defined in the same command.
    const define = 'G() { python3 "/home/user/skills/gauntlet/skills/gauntlet/gauntlet.py" "$@"; }'
    expect(isGauntletClose(bash(`cd /tmp/run && ${define}; G winner`))).toBe(true)
    expect(isGauntletClose(bash(`cd /tmp/run && ${define}; G winner && G tokens-from-radar`))).toBe(true)
    expect(isGauntletClose(bash(`function G { python3 /x/gauntlet.py "$@"; }\nG winner`))).toBe(true)
    expect(isGauntletClose(bash(`function G() { python3 /x/gauntlet.py "$@"; }; G winner`))).toBe(true)
    expect(isGauntletClose(bash('G() { cd /x; python3 /x/gauntlet.py "$@"; }; G winner'))).toBe(true)
    expect(isGauntletClose(bash('gl() { python3 /x/gauntlet.py "$@"; }; gl winner'))).toBe(true)
    expect(isGauntletClose(bash('G="python3 /x/gauntlet.py"; $G winner'))).toBe(true)
    expect(isGauntletClose(bash('G="python3 /x/gauntlet.py"; "$G" winner'))).toBe(true)
    expect(isGauntletClose(bash('G="python3 /x/gauntlet.py"; ${G} winner'))).toBe(true)
    // The other steps, and words that merely look like it.
    expect(isGauntletClose(bash(`${define}; G next`))).toBe(false)
    expect(isGauntletClose(bash(`${define}; G verdict r1m1 <<'EOF'\n{"reason":"X is the winner"}\nEOF`))).toBe(false)
    expect(isGauntletClose(bash(`${define}; G status && echo winner`))).toBe(false)
    expect(isGauntletClose(bash('H() { echo hi; }; H winner'))).toBe(false)
    expect(isGauntletClose(bash('G() { echo hi; }; G winner'))).toBe(false)
    expect(isGauntletClose(bash('G winner'))).toBe(false)
    expect(isGauntletClose({ tool: 'Read', file_path: '/x/gauntlet.py winner' })).toBe(false)
    expect(isGauntletClose({ tool: 'Bash' })).toBe(false)
  })

  test('a gauntlet\'s tags are short: Glad A, Judge 1 and 2 in start order, then Swap, Check and Final; the cards keep the full names', () => {
    const lead = { model: 'm', phase: 'idle' } as const
    const j = (id: string, description: string, startedAt: number) => row({ id, type: 'delegate:reviewer', description, startedAt })
    const team = teamOf(
      [
        row({ id: 'g1', type: 'delegate:builder', description: 'Gauntlet competitor A', startedAt: 1000 }),
        row({ id: 'g2', type: 'delegate:builder', description: 'Gauntlet competitor H', startedAt: 1001 }),
        j('j2', 'Gauntlet judge r1m2', 2001),
        j('j1', 'Gauntlet judge r1m1', 2000),
        j('js', 'Gauntlet judge r1m1 swap', 2002),
        j('jc', 'Gauntlet judge check', 3000),
        j('jf', 'Gauntlet judge final', 4000),
        row({ id: 'b1', type: 'delegate:builder', description: 'Fix the band layout', startedAt: 500 }),
      ],
      lead,
      9000,
    )
    const of = (id: string) => team.find(entry => entry.member.id === id)?.member
    expect([of('g1')?.tag, of('g2')?.tag]).toEqual(['Glad A', 'Glad H'])
    expect([of('j1')?.tag, of('j2')?.tag, of('js')?.tag, of('jc')?.tag, of('jf')?.tag]).toEqual(['Judge 1', 'Judge 2', 'Swap', 'Check', 'Final'])
    expect([of('g1')?.label, of('j1')?.label, of('js')?.label]).toEqual(['Gladiator A', 'Judge r1m1', 'Judge r1m1 swap'])
    expect(of('b1')?.tag).toBeUndefined()
    expect(team[0]?.member.tag).toBeUndefined()
    // Every tag fits the narrowest chip, the lounge's.
    for (const entry of team) expect((entry.member.tag ?? '').length).toBeLessThanOrEqual(7)
  })

  test('teamOf: the Lead is the emperor (variant 1) while a gauntlet runs, and not otherwise', () => {
    const lead = { model: 'm', phase: 'idle' } as const
    const builder = row({ id: 'b1', type: 'delegate:builder', description: 'Fix the band layout', startedAt: 1000 })
    const g = (id: string, letter: string, fields: Partial<AgentRow> = {}) =>
      row({ id, type: 'delegate:builder', description: `Gauntlet competitor ${letter}`, startedAt: 2000, ...fields })
    expect(teamOf([builder], lead, 5000)[0]?.member.variant).toBeUndefined()
    expect(teamOf([builder, g('g1', 'A')], lead, 5000)[0]?.member.variant).toBe(1)
    expect(isArenaTeam(teamOf([builder, g('g1', 'A')], lead, 5000))).toBe(true)
    expect(isArenaTeam(teamOf([builder], lead, 5000))).toBe(false)
    // Everything finished and a closing step long ago: the studio.
    const finished = g('g1', 'A', { status: 'completed', endedAt: 3000 })
    expect(teamOf([finished], lead, 4000)[0]?.member.variant).toBe(1)
    expect(teamOf([finished], { ...lead, gauntletDoneAt: 3500 }, 4000)[0]?.member.variant).toBe(1)
    expect(teamOf([finished], { ...lead, gauntletDoneAt: 3500 }, 3500 + 8000)[0]?.member.variant).toBeUndefined()
    expect(teamOf([finished], lead, 3000 + 180_000)[0]?.member.variant).toBeUndefined()
    // Another session's floor has no closing step to read: only its agents decide.
    const peer = teamOf(peerRowsOf(peerFile({ id: 's2', now: 5000, project: 'p', lead: BUSY_LEAD, rows: [g('c1', 'D')] })), BUSY_LEAD, 5000)
    expect(peer[0]?.member.variant).toBe(1)
    expect(peer[1]?.member).toMatchObject({ role: 'gladiator', label: 'Gladiator D', variant: 3 })
  })

  test('the pane is the colosseum from the first gauntlet agent, through the gaps, until the closing step; then the studio', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    const SAND = 0xe8cc94
    const CARPET = 0x8d779a
    // A plain agent: the studio.
    await $.agent.spawn(spawnInput({ subagentType: 'delegate:builder', description: 'Fix the band layout', prompt: 'Do it.' }))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: { ...PANE, bodyColumns: 160 } })
    const colorsOf = async (): Promise<Set<number>> => {
      const cells = String((await ui.find({ type: 'Raster', key: 'office' }))?.props.cells ?? '')
      const bytes = Uint8Array.from(atob(cells), ch => ch.charCodeAt(0))
      const view = new DataView(bytes.buffer)
      const seen = new Set<number>()
      for (let at = 0; at + 12 <= bytes.length; at += 12) {
        seen.add(view.getUint32(at + 4, true))
        seen.add(view.getUint32(at + 8, true))
      }
      return seen
    }
    expect((await colorsOf()).has(CARPET)).toBe(true)
    expect((await colorsOf()).has(SAND)).toBe(false)
    // The first gauntlet agent: the colosseum.
    await $.agent.spawn(spawnInput({ subagentType: 'delegate:builder', description: 'Gauntlet competitor A', prompt: 'Compete.', tool_use_id: 'tu-g1' }))
    await world.clock.advance(1100)
    expect((await colorsOf()).has(SAND)).toBe(true)
    expect((await colorsOf()).has(CARPET)).toBe(false)
    // The gauntlet's agents end and nothing runs for a while: still the colosseum (a gap between waves).
    await $.turn.complete({ answer: 'DONE', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a2' })
    await world.clock.advance(60_000)
    expect((await colorsOf()).has(SAND)).toBe(true)
    // The Lead runs the closing step: eight seconds of finish, then the studio, with no new draw asked for.
    await run($.turn.step(stepOf({ index: 1 })))
    await $.tool.call({ tool: 'Bash', command: 'python3 "/s/gauntlet.py" winner' } as never)
    await world.clock.advance(4000)
    expect((await colorsOf()).has(SAND)).toBe(true)
    await world.clock.advance(6000)
    expect((await colorsOf()).has(CARPET)).toBe(true)
    expect((await colorsOf()).has(SAND)).toBe(false)
    await ui.unmount()
  })

  test('a second `winner` after the studio is back does not bring the colosseum back; a new gauntlet does, and its winner ends it', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await world.clock.settle()
    const define = 'G() { python3 "/s/gauntlet.py" "$@"; }'
    const alt = async (): Promise<string> => String((await ui.find({ type: 'Svg' }))?.props.alt ?? '')
    await $.agent.spawn(spawnInput({ subagentType: 'delegate:builder', description: 'Gauntlet competitor A', prompt: 'Go.', tool_use_id: 'tu-g1' }))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'desktop', component: 'Pane', requestId: 'agents', props: { ...PANE, bodyColumns: 112 } })
    await $.turn.complete({ answer: 'DONE', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    await run($.turn.step(stepOf({ index: 1 })))
    await $.tool.call({ tool: 'Bash', command: `cd /run && ${define}; G winner` } as never)
    await world.clock.advance(12_000)
    expect((await alt()).startsWith('Office: ')).toBe(true)
    // Reading the winner again (a rate, a re-run) later: still the studio.
    await $.tool.call({ tool: 'Bash', command: `cd /run && ${define}; G winner` } as never)
    await world.clock.advance(2000)
    expect((await alt()).startsWith('Office: ')).toBe(true)
    // A new gauntlet: the colosseum again, until its own winner.
    await $.agent.spawn(spawnInput({ subagentType: 'delegate:builder', description: 'Gauntlet competitor B', prompt: 'Go.', tool_use_id: 'tu-g2' }))
    await world.clock.advance(1100)
    expect((await alt()).startsWith('Colosseum: ')).toBe(true)
    await $.turn.complete({ answer: 'DONE', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a2' })
    await $.tool.call({ tool: 'Bash', command: `cd /run && ${define}; G winner` } as never)
    await world.clock.advance(12_000)
    expect((await alt()).startsWith('Office: ')).toBe(true)
    await ui.unmount()
  })

  test('on the desktop the studio comes back by itself at the end: the picture is drawn again with no other change', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await world.clock.settle()
    const alt = async (): Promise<string> => String((await ui.find({ type: 'Svg' }))?.props.alt ?? '')
    await $.agent.spawn(spawnInput({ subagentType: 'delegate:reviewer', description: 'Gauntlet judge r1m1', prompt: 'Judge.', tool_use_id: 'tu-j1' }))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'desktop', component: 'Pane', requestId: 'agents', props: { ...PANE, bodyColumns: 112 } })
    expect((await alt()).startsWith('Colosseum: ')).toBe(true)
    await $.turn.complete({ answer: 'DONE', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    await run($.turn.step(stepOf({ index: 1 })))
    await $.tool.call({ tool: 'Bash', command: 'python3 /s/gauntlet.py winner' } as never)
    await world.clock.advance(2000)
    expect((await alt()).startsWith('Colosseum: ')).toBe(true)
    await world.clock.advance(12_000)
    expect((await alt()).startsWith('Office: ')).toBe(true)
    await ui.unmount()
  })

  test('teamOf gives repeated roles sibling variants by start order, and leaves a lone role the named character', () => {
    const rows = [
      row({ id: 'b2', type: 'delegate:builder', startedAt: 2000 }),
      row({ id: 'b1', type: 'delegate:builder', startedAt: 1000 }),
      row({ id: 'r1', type: 'delegate:reviewer', startedAt: 1500 }),
    ]
    const team = teamOf(rows, { model: 'm', phase: 'idle' }, 5000)
    const variant = (id: string): number | undefined => team.find(entry => entry.member.id === id)?.member.variant
    expect(variant('b1')).toBeUndefined()
    expect(variant('b2')).toBe(1)
    expect(variant('r1')).toBeUndefined()
    expect(team[0]?.member.variant).toBeUndefined()
  })

  test('a gauntlet\'s agents are gladiators and judges by their names, with a look each; others stay as they are', () => {
    const rows = [
      row({ id: 'g3', type: 'delegate:builder', description: 'Gauntlet competitor C', startedAt: 3000 }),
      row({ id: 'g1', type: 'delegate:builder', description: 'Gauntlet competitor A', startedAt: 1000 }),
      row({ id: 'j2', type: 'delegate:reviewer', description: 'Gauntlet judge final', startedAt: 6000 }),
      row({ id: 'j1', type: 'delegate:reviewer', description: 'Gauntlet judge r1m1', startedAt: 5000 }),
      row({ id: 'b1', type: 'delegate:builder', description: 'Fix the band layout', startedAt: 2000 }),
    ]
    const team = teamOf(rows, { model: 'm', phase: 'idle' }, 9000)
    const by = (id: string) => team.find(entry => entry.member.id === id)?.member
    expect(by('g1')).toMatchObject({ role: 'gladiator', label: 'Gladiator A' })
    expect(by('g1')?.variant).toBeUndefined()
    expect(by('g3')).toMatchObject({ role: 'gladiator', label: 'Gladiator C', variant: 2 })
    // Judges look by start order, whatever their match.
    expect(by('j1')).toMatchObject({ role: 'judge', label: 'Judge r1m1' })
    expect(by('j1')?.variant).toBeUndefined()
    expect(by('j2')).toMatchObject({ role: 'judge', label: 'Judge final', variant: 1 })
    // A builder of the same type that is not a competitor stays a Builder, the named character.
    expect(by('b1')).toMatchObject({ role: 'builder', label: 'Builder' })
    expect(by('b1')?.variant).toBeUndefined()
  })

  test('another session\'s gauntlet shows as gladiators too: the description crosses in its file', () => {
    const file = peerFile({
      id: 's2',
      now: 1000,
      project: 'p',
      lead: BUSY_LEAD,
      rows: [row({ id: 'c1', type: 'delegate:builder', description: 'Gauntlet competitor D', startedAt: 500 })],
    })
    const team = teamOf(peerRowsOf(file), BUSY_LEAD, 1000)
    expect(team[1]?.member).toMatchObject({ role: 'gladiator', label: 'Gladiator D', variant: 3 })
  })

  test('reviving: only a completed agent comes back on its own; a resumed one is not ended again by a stale list for 10 s', () => {
    expect(reviving(row({ status: 'completed', endedAt: 500 }), 900)).toEqual({ status: 'running', endedAt: undefined, needs: undefined, resumedAt: 900 })
    expect(reviving(row({ status: 'killed', endedAt: 500 }), 900)).toEqual({})
    expect(reviving(row({ status: 'failed', endedAt: 500 }), 900)).toEqual({})
    expect(reviving(row({ status: 'running' }), 900)).toEqual({})
    const stale = [{ id: 'a1', type: 'Explore', description: 'x', status: 'completed' as const }]
    const resumed = row({ status: 'running', resumedAt: 10_000 })
    expect(reconcile([resumed], stale, 15_000)[0]?.status).toBe('running')
    expect(reconcile([resumed], stale, 20_001)[0]?.status).toBe('completed')
    // A list that agrees brings a finished row back by itself, resumed or not.
    const live = [{ id: 'a1', type: 'Explore', description: 'x', status: 'running' as const }]
    expect(reconcile([row({ status: 'completed', endedAt: 100 })], live, 20_000)[0]).toMatchObject({ status: 'running' })
    expect(reconcile([row({ status: 'completed', endedAt: 100 })], live, 20_000)[0]?.endedAt).toBeUndefined()
  })

  test('reconcile creates rows for agents it never saw and keeps a blank-only description rule', () => {
    const listed = [
      { id: 'x1', type: 'Explore', description: 'Seen before reload', status: 'running' as const },
      { id: 'a1', type: 'Explore', description: 'List text', status: 'running' as const, name: 'scout' },
    ]
    const next = reconcile([row({ description: 'Mine' })], listed, 1000)
    expect(next.map(one => one.id)).toEqual(['a1', 'x1'])
    expect(next[0]).toMatchObject({ description: 'Mine', name: 'scout' })
    expect(next[1]).toMatchObject({ description: 'Seen before reload', startedAt: 1000 })
    expect(reconcile([row({ description: '' })], listed.slice(1), 1000)[0]?.description).toBe('List text')
  })

  test('reconcile ends a row, and does not revive one that ended under 3 s ago', () => {
    const ended = row({ status: 'completed', phase: 'done', endedAt: 1000 })
    const running = [{ id: 'a1', type: 'Explore', description: '', status: 'running' as const }]
    expect(reconcile([ended], running, 3500)[0]).toMatchObject({ status: 'completed', endedAt: 1000 })
    expect(reconcile([ended], running, 4500)[0]).toMatchObject({ status: 'running', phase: 'thinking' })
    expect(reconcile([ended], running, 4500)[0]).not.toHaveProperty('endedAt')
    const done = [{ id: 'a1', type: 'Explore', description: '', status: 'killed' as const }]
    expect(reconcile([row()], done, 9000)[0]).toMatchObject({ status: 'killed', phase: 'stopped', endedAt: 9000 })
  })

  test('reconcile puts an agent found already done in the lounge at once, with no walk', () => {
    const done = [{ id: 'x1', type: 'Explore', description: 'Before the radar', status: 'completed' as const }]
    const made = reconcile([], done, 10_000)
    expect(made[0]).toMatchObject({ status: 'completed', startedAt: 10_000 - WALK_MS, endedAt: 10_000 - WALK_MS })
    expect(isMoving(teamOf(made, { model: 'm', phase: 'idle' }, 10_000), 10_000)).toBe(false)
  })

  test('isSettling: live, or a walk that may not be drawn finished yet', () => {
    expect(isSettling(row(), 1_000_000)).toBe(true)
    const done = row({ status: 'completed', phase: 'done', startedAt: 0, endedAt: 10_000 })
    expect(isSettling(done, 10_000 + WALK_MS + 1500)).toBe(true)
    expect(isSettling(done, 10_000 + WALK_MS + 2000)).toBe(false)
    // A quick agent that ended before its walk in was over settles from the later walk.
    expect(isSettling(row({ status: 'completed', startedAt: 9000, endedAt: 8000 }), 12_500)).toBe(true)
  })
})

describe('classifyTask', () => {
  test('a read-only search is a lookup: the light model at medium effort', () => {
    expect(classifyTask(LOOKUP_ASK)).toEqual({
      kind: 'lookup',
      tier: 'haiku',
      effort: 'medium',
      why: 'lookup: Explore, read-only, find',
    })
  })

  test('a clear job is routine, and a small change starts on the light model', () => {
    const job = classifyTask({
      subagentType: 'general-purpose',
      description: 'Add pagination',
      prompt: 'Implement pagination for the list endpoint in api/list.ts.',
    })
    expect(job).toMatchObject({ kind: 'routine', tier: 'sonnet', effort: 'medium', why: 'routine: no hard signals' })
    const small = classifyTask({ subagentType: 'general-purpose', description: 'Fix typo', prompt: 'Fix the typo in README.md.' })
    expect(small).toMatchObject({ kind: 'routine', tier: 'haiku', effort: 'medium', why: 'routine: small change' })
  })

  test('two hard cues make a careful task: the middle model, high effort', () => {
    const review = classifyTask({
      subagentType: 'general-purpose',
      description: 'Review the diff',
      prompt: 'Review this change for security issues.',
    })
    expect(review).toEqual({ kind: 'careful', tier: 'sonnet', effort: 'high', why: 'careful: security, review' })
    const plan = classifyTask({ subagentType: 'Plan', description: 'Plan the endpoint', prompt: 'Outline the steps for the endpoint.' })
    expect(plan).toMatchObject({ kind: 'careful', tier: 'sonnet', effort: 'high', why: 'careful: Plan' })
  })

  test('several hard cues, or a plea to think hard, make a hard task: the strongest model, xhigh', () => {
    expect(classifyTask(HARD_ASK)).toEqual({
      kind: 'hard',
      tier: 'opus',
      effort: 'xhigh',
      why: 'hard: root cause, investigation, asked to think hard',
    })
    const plain = classifyTask({
      subagentType: 'general-purpose',
      description: 'Audit the auth flow',
      prompt: 'Audit the login code for security flaws, then refactor the session code.',
    })
    expect(plain).toMatchObject({ kind: 'hard', tier: 'opus', effort: 'high' })
  })

  test('a task that writes is never a lookup, even from Explore', () => {
    const fix = classifyTask({ subagentType: 'Explore', description: 'Find and fix typos', prompt: 'Find every typo and fix it.' })
    expect(fix.kind).toBe('routine')
    expect(fix.tier).toBe('haiku')
  })

  test('"do not modify" is not a write, and neither is the list that follows it', () => {
    for (const ban of [
      'Do not modify or write anything.',
      'Do not edit, create, or delete files.',
      "Don't touch/change any file.",
      'Without editing or committing.',
    ]) {
      expect(classifyTask({ ...LOOKUP_ASK, prompt: `List the tests. ${ban}` }).kind).toBe('lookup')
    }
  })

  test('a write after the ban is still a write', () => {
    const verdict = classifyTask({ ...LOOKUP_ASK, prompt: "Don't edit the tests, but write the missing fix." })
    expect(verdict.kind).toBe('routine')
  })

  test('a lookup across many files stays on the light model: Haiku 5.5 takes an effort setting', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'lib/d.ts', 'lib/e.ts', 'test/f.ts'].join(', ')
    const broad = classifyTask({
      subagentType: 'Explore',
      description: 'Find the loaders',
      prompt: `Find where config loads in ${files}. Do not modify anything.`,
    })
    expect(broad).toMatchObject({ kind: 'lookup', tier: 'haiku', effort: 'medium' })
  })

  test('a long prompt alone is not a cue: a detailed brief makes a task clearer, not harder', () => {
    const brief = classifyTask({
      subagentType: 'general-purpose',
      description: 'Find the loader',
      prompt: `Find the loader. Do not modify anything. ${'Context line. '.repeat(400)}`,
    })
    expect(brief).toMatchObject({ kind: 'lookup', tier: 'haiku', effort: 'medium' })
  })

  test('research and other judgment work is routine, not a lookup, even when it only reads', () => {
    const research = classifyTask({
      subagentType: 'general-purpose',
      description: 'Research eval protocols',
      prompt: 'Research how teams evaluate rankers without labels and find the main methods. Do not modify any file.',
    })
    expect(research).toEqual({ kind: 'routine', tier: 'sonnet', effort: 'medium', why: 'routine: judgment' })
    const compare = classifyTask({ ...LOOKUP_ASK, prompt: 'Find the two loaders and compare them. Read-only.' })
    expect(compare.kind).toBe('routine')
  })

  test('a review, audit or verification gets care on a single cue, and never counts as a lookup', () => {
    for (const [description, prompt] of [
      ['Independent numeric audit', 'Check every number in the report against the source data.'],
      ['Adversarial defensibility review', 'Attack the method as a skeptical reader would.'],
      ['Independent verification of QA findings', 'List each finding and say if it holds. Do not modify any file.'],
    ] as const) {
      expect(classifyTask({ subagentType: 'general-purpose', description, prompt })).toMatchObject({
        kind: 'careful',
        tier: 'sonnet',
        effort: 'high',
      })
    }
  })

  test('a review word in the prompt alone, or "auditable", sets no floor', () => {
    const research = classifyTask({
      subagentType: 'general-purpose',
      description: 'Research lexicon induction',
      prompt: 'Review the existing approaches and say which are auditable. Do not modify any file.',
    })
    expect(research).toMatchObject({ kind: 'routine', effort: 'medium' })
    const able = classifyTask({ subagentType: 'general-purpose', description: 'Lexicon auditability', prompt: 'Summarize it.' })
    expect(able.kind).not.toBe('careful')
  })

  test('"verify" in an implementation brief is not a review', () => {
    const job = classifyTask({
      subagentType: 'general-purpose',
      description: 'Add pagination',
      prompt: 'Implement pagination, then verify the tests pass.',
    })
    expect(job.kind).toBe('routine')
  })

  test('any hard cue keeps a task out of the lookup class', () => {
    const debugLookup = classifyTask({ ...LOOKUP_ASK, prompt: 'Find where debug logging is set. Do not modify any file.' })
    expect(debugLookup.kind).toBe('routine')
  })

  test('a literature review is not a code review', () => {
    const lit = classifyTask({
      subagentType: 'general-purpose',
      description: 'Classic lit review',
      prompt: 'Survey the literature review findings on zero-shot classification and their performance.',
    })
    expect(lit.kind).toBe('routine')
    const code = classifyTask({
      subagentType: 'general-purpose',
      description: 'Code review',
      prompt: 'Review the diff for performance problems.',
    })
    expect(code.kind).toBe('careful')
  })

  test('it reads the start and the end of a long prompt, not the pasted middle', () => {
    const prompt = `Add a button. ${'x '.repeat(800)}root cause deadlock security review ${'x '.repeat(800)}Thanks.`
    const verdict = classifyTask({ subagentType: 'general-purpose', description: 'Add a button', prompt })
    expect(verdict).toMatchObject({ kind: 'routine', tier: 'sonnet', effort: 'medium' })
  })
})

describe('difficulty tag', () => {
  test('the main model\'s tag wins over every cue', () => {
    expect(readDifficultyTag({ description: '[difficulty: hard] Fix the cache', prompt: 'x' })).toEqual({
      kind: 'hard',
      tier: 'opus',
      effort: 'high',
      why: 'tagged: hard',
    })
    expect(classifyTask({ ...HARD_ASK, prompt: `[difficulty: lookup] ${HARD_ASK.prompt}` })).toMatchObject({
      kind: 'lookup',
      tier: 'haiku',
      effort: 'medium',
      why: 'tagged: lookup',
    })
    expect(classifyTask({ ...LOOKUP_ASK, description: '[ Difficulty : DEEP ] Find it' })).toMatchObject({
      kind: 'hard',
      tier: 'opus',
      effort: 'xhigh',
      why: 'tagged: deep',
    })
    expect(readDifficultyTag({ description: 'x', prompt: '[difficulty: careful] Review it.' })).toMatchObject({
      kind: 'careful',
      tier: 'sonnet',
      effort: 'high',
    })
    expect(readDifficultyTag({ description: 'x', prompt: '[difficulty: routine]' })).toMatchObject({ tier: 'sonnet', effort: 'medium' })
  })

  test('an unknown level, or a tag deep in a long prompt, is no tag', () => {
    expect(readDifficultyTag({ description: '[difficulty: extreme]', prompt: '' })).toBeUndefined()
    expect(readDifficultyTag({ description: 'x', prompt: `${'y'.repeat(500)} [difficulty: hard]` })).toBeUndefined()
    expect(readDifficultyTag({ description: 'difficulty: hard', prompt: '' })).toBeUndefined()
  })
})

describe('stepEffort', () => {
  const route: Route = { kind: 'routine', model: 'sonnet', effort: 'medium', maxEffort: 'xhigh', why: 'x', isApplied: true }

  test('raises one level at 12 steps, one more at 24, and one for three tool errors', () => {
    expect(stepEffort(route, 0, 0)).toBe('medium')
    expect(stepEffort(route, 11, 2)).toBe('medium')
    expect(stepEffort(route, 12, 0)).toBe('high')
    expect(stepEffort(route, 24, 0)).toBe('xhigh')
    expect(stepEffort(route, 0, 3)).toBe('high')
    expect(stepEffort(route, 30, 5)).toBe('xhigh')
  })

  test('never goes above the ceiling or below the pick', () => {
    expect(stepEffort({ ...route, maxEffort: 'medium' }, 30, 5)).toBe('medium')
    expect(stepEffort({ ...route, effort: 'high', maxEffort: 'medium' }, 0, 0)).toBe('high')
    const { maxEffort, ...open } = route
    void maxEffort
    expect(stepEffort(open, 24, 3)).toBe('xhigh')
    const { effort, ...none } = route
    void effort
    expect(stepEffort(none, 30, 5)).toBeUndefined()
  })

  test('withEffort sends the raised effort', () => {
    expect(withEffort(stepOf({ index: 12, effort: 'low' }), route).effort).toBe('high')
    expect(withEffort(stepOf({ index: 0, effort: 'low' }), route, 3).effort).toBe('high')
  })
})

describe('tierOf', () => {
  test('names the family of an id or an alias, and nothing for one it does not know', () => {
    expect(tierOf('claude-sonnet-5-5')).toBe('sonnet')
    expect(tierOf('claude-opus-4-1[1m]')).toBe('opus')
    expect(tierOf('haiku')).toBe('haiku')
    expect(tierOf('claude-fable-5-1')).toBeUndefined()
    expect(tierOf(undefined)).toBeUndefined()
  })
})

describe('chooseRoute', () => {
  test('is silent when off', () => {
    expect(chooseRoute(facts(LOOKUP_ASK), { mode: 'off', ceiling: 'raise' })).toBeUndefined()
  })

  test('leaves a fork, a teammate and a custom agent alone', () => {
    expect(chooseRoute(facts({ ...LOOKUP_ASK, fork: true }), AUTO)).toEqual({
      kind: 'kept',
      why: 'a fork inherits its parent',
      isApplied: false,
    })
    expect(chooseRoute(facts({ ...LOOKUP_ASK, isTeammate: true }), AUTO)).toMatchObject({ kind: 'kept', isApplied: false })
    const custom = chooseRoute(facts({ ...LOOKUP_ASK, provider: { plugin: 'acme', tier: 'user' } }), AUTO)
    expect(custom).toEqual({ kind: 'kept', why: 'custom agent, kept as defined', isApplied: false })
  })

  test('sends a lookup and a routine job to sonnet, on the parent\'s own id', () => {
    expect(chooseRoute(facts(LOOKUP_ASK), AUTO)).toMatchObject({ kind: 'lookup', model: 'claude-sonnet-5-5', effort: 'medium', isApplied: true, tier: 'sonnet', budget: 50_000 })
    const job = chooseRoute(facts({ subagentType: 'general-purpose', description: 'Add pagination', prompt: 'Implement pagination.' }), AUTO)
    expect(job).toMatchObject({ kind: 'routine', model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  test('raises a hard task above the session when the ceiling allows it', () => {
    expect(chooseRoute(facts(HARD_ASK), AUTO)).toMatchObject({ kind: 'hard', model: 'opus', effort: 'xhigh', isApplied: true })
    const fromOpus = chooseRoute(facts({ ...LOOKUP_ASK, parentModel: 'claude-opus-4-1' }), AUTO)
    expect(fromOpus).toMatchObject({ kind: 'lookup', model: 'sonnet', tier: 'sonnet' })
    const fromHaiku = chooseRoute(
      facts({ subagentType: 'general-purpose', description: 'Add pagination', prompt: 'Implement pagination.', parentModel: 'claude-haiku-4-5' }),
      AUTO,
    )
    expect(fromHaiku).toMatchObject({ model: 'sonnet' })
  })

  test('holds the pick to the session when the ceiling is "session"', () => {
    const capped = chooseRoute(facts(HARD_ASK), { mode: 'auto', ceiling: 'session' }, 'medium')
    expect(capped).toMatchObject({ kind: 'hard', model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(capped?.why).toContain('capped to the session')
    const open = chooseRoute(facts(HARD_ASK), { mode: 'auto', ceiling: 'session' })
    expect(open).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
    const low = chooseRoute(facts(LOOKUP_ASK), { mode: 'auto', ceiling: 'session' }, 'low')
    expect(low).toMatchObject({ model: 'claude-sonnet-5-5', tier: 'sonnet', effort: 'low' })
    expect(low?.why).toContain('capped to the session')
    expect(chooseRoute(facts(LOOKUP_ASK), { mode: 'auto', ceiling: 'session' }, 'high')?.why).not.toContain('capped')
  })

  test('keeps an allowed model the call names, and still picks the effort', () => {
    const named = chooseRoute(facts({ ...HARD_ASK, model: 'opus' }), AUTO)
    expect(named).not.toHaveProperty('model')
    expect(named).toMatchObject({ effort: 'xhigh' })
    expect(named?.why).toContain('model set by the call')
  })

  test('never passes down a parent model outside the allowed families', () => {
    const route = chooseRoute(facts({ ...HARD_ASK, parentModel: 'claude-fable-5-1' }), AUTO)
    expect(route).toMatchObject({ model: 'opus', effort: 'xhigh', isApplied: true })
    expect(route?.why).toContain("session's claude-fable-5-1 not passed down")
  })

  test('only suggests in suggest mode', () => {
    expect(chooseRoute(facts(LOOKUP_ASK), { mode: 'suggest', ceiling: 'raise' })).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      isApplied: false,
    })
  })

  test('no route ever names haiku or fable, in model or tier, for engine and delegate agents', () => {
    const asks = {
      lookup: LOOKUP_ASK,
      routine: { subagentType: 'general-purpose', description: 'Add pagination', prompt: 'Implement pagination.' },
      careful: { subagentType: 'general-purpose', description: 'Review the change', prompt: 'Review this change for mistakes.' },
      hard: HARD_ASK,
      deep: { ...HARD_ASK, prompt: `[difficulty: deep] ${HARD_ASK.prompt}` },
      taggedHard: { ...HARD_ASK, prompt: `[difficulty: hard] ${HARD_ASK.prompt}` },
      taggedRoutine: { ...HARD_ASK, prompt: `[difficulty: routine] ${HARD_ASK.prompt}` },
    } as const
    const providers = [{ plugin: 'engine', tier: 'core' }, DELEGATE.provider] as const
    const parents = ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']
    const models = [undefined, 'haiku', 'fable', 'sonnet', 'opus']
    let count = 0
    for (const provider of providers) {
      for (const ask of Object.values(asks)) {
        for (const parentModel of parents) {
          for (const ceiling of ['raise', 'session'] as const) {
            for (const model of models) {
              for (const parentEffort of [undefined, 'low', 'xhigh']) {
                const input = facts({ ...ask, provider, parentModel, ...(model === undefined ? {} : { model }) })
                const route = chooseRoute(input, { mode: 'auto', ceiling }, parentEffort)
                count += 1
                expect(route?.model ?? '').not.toMatch(/haiku|fable/)
                expect(route?.tier ?? '').not.toMatch(/haiku|fable/)
                expect(route?.baseTier ?? '').not.toMatch(/haiku|fable/)
                // A blocked model the call names is always swapped, never kept.
                if (model === 'haiku' || model === 'fable') expect(route?.model).toBeDefined()
              }
            }
          }
        }
      }
    }
    expect(count).toBe(2 * 7 * 4 * 2 * 5 * 3)
  })

  test('an engine agent whose call names fable or haiku gets the router\'s pick, and the why says so', () => {
    const fable = chooseRoute(facts({ ...HARD_ASK, model: 'fable' }), AUTO)
    expect(fable).toMatchObject({ kind: 'hard', model: 'opus', tier: 'opus', effort: 'xhigh', isApplied: true })
    expect(fable?.why).toContain('fable not allowed')
    expect(fable?.why).not.toContain('model set by the call')
    const haiku = chooseRoute(facts({ ...LOOKUP_ASK, model: 'haiku' }), AUTO)
    expect(haiku).toMatchObject({ kind: 'lookup', model: 'claude-sonnet-5-5', tier: 'sonnet' })
    expect(haiku?.why).toContain('haiku not allowed')
  })

  test('a custom agent whose call names fable gets opus, haiku gets sonnet, and others stay kept', () => {
    const custom = { provider: { plugin: 'acme', tier: 'user' } } as const
    expect(chooseRoute(facts({ ...LOOKUP_ASK, ...custom, model: 'fable' }), AUTO)).toMatchObject({ kind: 'kept', model: 'opus', isApplied: true })
    expect(chooseRoute(facts({ ...LOOKUP_ASK, ...custom, model: 'haiku' }), AUTO)).toMatchObject({ kind: 'kept', model: 'sonnet', isApplied: true })
    const plain = { kind: 'kept', why: 'custom agent, kept as defined', isApplied: false }
    expect(chooseRoute(facts({ ...LOOKUP_ASK, ...custom, model: 'sonnet' }), AUTO)).toEqual(plain)
    expect(chooseRoute(facts({ ...LOOKUP_ASK, ...custom, model: 'opus' }), AUTO)).toEqual(plain)
    expect(chooseRoute(facts({ ...LOOKUP_ASK, ...custom }), AUTO)).toEqual(plain)
  })

  test('a fable parent never passes its model down: the route gets the alias', () => {
    for (const ask of [LOOKUP_ASK, HARD_ASK]) {
      const route = chooseRoute(facts({ ...ask, parentModel: 'claude-fable-5-1' }), AUTO)
      expect(['sonnet', 'opus']).toContain(route?.model)
      expect(route?.why).toContain("session's claude-fable-5-1 not passed down")
    }
    const capped = chooseRoute(facts({ ...HARD_ASK, parentModel: 'claude-fable-5-1' }), { mode: 'auto', ceiling: 'session' })
    expect(['sonnet', 'opus']).toContain(capped?.model)
  })

  test('in suggest mode a custom agent that names fable is not applied', () => {
    const route = chooseRoute(
      facts({ ...LOOKUP_ASK, provider: { plugin: 'acme', tier: 'user' }, model: 'fable' }),
      { mode: 'suggest', ceiling: 'raise' },
    )
    expect(route).toMatchObject({ kind: 'kept', model: 'opus', isApplied: false })
  })
})

describe('chooseRoute for delegate roles', () => {
  const plain = { kind: 'kept', why: 'custom agent, kept as defined', isApplied: false }
  const SESSION: RouterSettings = { mode: 'auto', ceiling: 'session' }

  test('a builder tagged hard runs on opus at high, and tagged deep on opus at xhigh', () => {
    expect(chooseRoute(facts(roleAsk('builder', 'hard')), AUTO)).toEqual({
      kind: 'hard',
      model: 'opus',
      effort: 'high',
      maxEffort: 'high',
      tier: 'opus',
      isRaiseOnly: true,
      why: 'delegate role, tagged hard: opus',
      isApplied: true,
    })
    expect(chooseRoute(facts(roleAsk('builder', 'deep')), AUTO)).toMatchObject({
      kind: 'hard',
      model: 'opus',
      effort: 'xhigh',
      maxEffort: 'xhigh',
      why: 'delegate role, tagged deep: opus',
      isApplied: true,
    })
  })

  test('on an opus session the raise sends the session\'s own id', () => {
    expect(chooseRoute(facts({ ...roleAsk('builder', 'hard'), parentModel: 'claude-opus-5-5' }), AUTO)).toMatchObject({ model: 'claude-opus-5-5' })
  })

  test('tagged lookup, routine or careful, or not tagged, a builder is kept as defined', () => {
    for (const tag of ['lookup', 'routine', 'careful', undefined]) {
      expect(chooseRoute(facts(roleAsk('builder', tag)), AUTO)).toEqual(plain)
    }
  })

  test('an architect tagged routine is kept, not lowered; tagged hard it stays opus at high', () => {
    expect(chooseRoute(facts(roleAsk('architect', 'routine')), AUTO)).toEqual(plain)
    expect(chooseRoute(facts(roleAsk('architect', 'lookup')), AUTO)).toEqual(plain)
    expect(chooseRoute(facts(roleAsk('architect', 'hard')), AUTO)).toMatchObject({ model: 'opus', effort: 'high', isRaiseOnly: true })
  })

  test('a model the call names stays, the gauntlet case: sonnet plus a hard tag runs on sonnet', () => {
    const named = chooseRoute(facts({ ...roleAsk('builder', 'hard'), model: 'sonnet' }), AUTO)
    expect(named).not.toHaveProperty('model')
    expect(named).toMatchObject({ kind: 'hard', tier: 'sonnet', effort: 'high', isRaiseOnly: true, isApplied: true })
    expect(named?.why).toBe('delegate role, tagged hard: opus · model set by the call')
    const opus = chooseRoute(facts({ ...roleAsk('builder', 'hard'), model: 'claude-opus-5-5' }), AUTO)
    expect(opus).not.toHaveProperty('model')
  })

  test('an effort the call names stays, and so does a model and an effort both named', () => {
    const effort = chooseRoute(facts({ ...roleAsk('builder', 'deep'), callEffort: 'medium' }), AUTO)
    expect(effort).toMatchObject({ model: 'opus' })
    expect(effort).not.toHaveProperty('effort')
    expect(effort).not.toHaveProperty('maxEffort')
    expect(effort?.why).toContain('effort set by the call')
    const both = chooseRoute(facts({ ...roleAsk('builder', 'hard'), model: 'sonnet', callEffort: 'high' }), AUTO)
    expect(both).not.toHaveProperty('model')
    expect(both).not.toHaveProperty('effort')
    expect(both?.why).toBe('delegate role, tagged hard: opus · model set by the call · effort set by the call')
  })

  test('a call that names haiku or fable is still swapped; a hard tag swaps it to opus', () => {
    const haiku = chooseRoute(facts({ ...roleAsk('builder', 'hard'), model: 'haiku' }), AUTO)
    expect(haiku).toMatchObject({ kind: 'hard', model: 'opus', tier: 'opus', isApplied: true })
    expect(haiku?.why).toBe('delegate role, tagged hard: opus · haiku not allowed')
    expect(chooseRoute(facts({ ...roleAsk('builder', 'deep'), model: 'fable' }), AUTO)).toMatchObject({ model: 'opus', effort: 'xhigh' })
    expect(chooseRoute(facts({ ...roleAsk('builder', 'routine'), model: 'haiku' }), AUTO)).toMatchObject({ kind: 'kept', model: 'sonnet', isApplied: true })
    expect(chooseRoute(facts({ ...roleAsk('scout'), model: 'fable' }), AUTO)).toMatchObject({ kind: 'kept', model: 'opus', isApplied: true })
  })

  test('under the session cap a session below opus raises no model, and the effort is held to the session', () => {
    const capped = chooseRoute(facts(roleAsk('builder', 'deep')), SESSION, 'high')
    expect(capped).not.toHaveProperty('model')
    expect(capped).toMatchObject({ kind: 'hard', effort: 'high', maxEffort: 'high', isRaiseOnly: true })
    expect(capped?.why).toBe('delegate role, tagged deep: opus · capped to the session')
    expect(chooseRoute(facts({ ...roleAsk('builder', 'hard'), model: 'haiku' }), SESSION)).toMatchObject({ model: 'claude-sonnet-5-5' })
    const fromOpus = chooseRoute(facts({ ...roleAsk('builder', 'hard'), parentModel: 'claude-opus-5-5' }), SESSION, 'xhigh')
    expect(fromOpus).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(fromOpus?.why).toBe('delegate role, tagged hard: opus')
  })

  test('another plugin\'s agent tagged hard is kept as defined, and so are a delegate fork and teammate', () => {
    const acme = { ...roleAsk('builder', 'hard'), subagentType: 'acme:builder', provider: { plugin: 'acme', tier: 'user' } } as const
    expect(chooseRoute(facts(acme), AUTO)).toEqual(plain)
    expect(chooseRoute(facts({ ...roleAsk('builder', 'hard'), fork: true }), AUTO)).toMatchObject({ kind: 'kept', isApplied: false })
    expect(chooseRoute(facts({ ...roleAsk('builder', 'hard'), isTeammate: true }), AUTO)).toMatchObject({ kind: 'kept', isApplied: false })
  })

  test('suggest mode shows the raise as "would use" and applies nothing; off mode does nothing', () => {
    const suggested = chooseRoute(facts(roleAsk('builder', 'hard')), { mode: 'suggest', ceiling: 'raise' })
    expect(suggested).toMatchObject({ model: 'opus', effort: 'high', isApplied: false })
    expect(suggested === undefined ? '' : describeRoute(suggested)).toBe('⇢ would use opus · high — delegate role, tagged hard: opus')
    expect(chooseRoute(facts(roleAsk('builder', 'hard')), { mode: 'off', ceiling: 'raise' })).toBeUndefined()
  })

  test('a raised role\'s end teaches the router nothing', () => {
    const raised = chooseRoute(facts(roleAsk('builder', 'hard')), AUTO)
    const done = row({ type: 'delegate:builder', status: 'completed', route: raised, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })
    expect(outcomeOf(done, 99)).toBeUndefined()
  })
})

describe('describeRoute', () => {
  const lookup: Route = { kind: 'lookup', model: 'haiku', effort: 'low', why: 'lookup: Explore', isApplied: true }

  test('words an applied pick, a suggested one and a kept spawn', () => {
    expect(describeRoute(lookup)).toBe('⇄ haiku · low — lookup: Explore')
    expect(describeRoute({ ...lookup, isApplied: false })).toBe('⇢ would use haiku · low — lookup: Explore')
    expect(describeRoute({ ...lookup, model: 'claude-sonnet-5-5' })).toBe('⇄ sonnet 5.5 · low — lookup: Explore')
    const { model, ...noModel } = lookup
    void model
    expect(describeRoute(noModel)).toBe('⇄ model as set · low — lookup: Explore')
    expect(describeRoute({ kind: 'kept', why: 'a fork inherits its parent', isApplied: false })).toBe('· a fork inherits its parent')
  })
})

describe('withEffort', () => {
  const route: Route = { kind: 'lookup', model: 'haiku', effort: 'low', why: 'x', isApplied: true }

  test('puts the pick\'s effort in the step', () => {
    const step = stepOf({ effort: 'high' })
    expect(withEffort(step, route)).toEqual({ ...step, effort: 'low' })
  })

  test('hands back the same step when there is nothing to change', () => {
    const step = stepOf({ effort: 'low' })
    expect(withEffort(step, route)).toBe(step)
    expect(withEffort(step, undefined)).toBe(step)
    const noEffort = stepOf()
    expect(withEffort(noEffort, route)).toBe(noEffort)
    const high = stepOf({ effort: 'high' })
    expect(withEffort(high, { ...route, isApplied: false })).toBe(high)
    const { effort, ...noPick } = route
    void effort
    expect(withEffort(high, noPick)).toBe(high)
  })

  test('a raise-only pick raises a step that runs lower, and never lowers one', () => {
    const raised: Route = { kind: 'hard', model: 'opus', effort: 'high', maxEffort: 'high', isRaiseOnly: true, why: 'x', isApplied: true }
    expect(withEffort(stepOf({ effort: 'medium' }), raised).effort).toBe('high')
    expect(withEffort(stepOf({ effort: 'low' }), raised).effort).toBe('high')
    for (const effort of ['high', 'xhigh', 'max', 3] as const) {
      const step = stepOf({ effort })
      expect(withEffort(step, raised)).toBe(step)
    }
    // No struggle raise on top of it.
    expect(withEffort(stepOf({ index: 30, effort: 'medium' }), raised, 5).effort).toBe('high')
    const suggested = stepOf({ effort: 'medium' })
    expect(withEffort(suggested, { ...raised, isApplied: false })).toBe(suggested)
  })
})

describe('route book', () => {
  const route: Route = { kind: 'lookup', model: 'haiku', effort: 'low', why: 'x', isApplied: true }
  const other: Route = { ...route, model: 'opus', effort: 'high' }
  const empty: RouteBook = { pending: [], byAgent: {} }
  const entry = { toolUseId: 'tu1', type: 'Explore', description: 'Find', route }

  test('a spawn answer moves the pick to the agent id', () => {
    const book = addPending(empty, entry)
    expect(book.pending).toHaveLength(1)
    const settled = settleRoute(book, 'tu1', 'a1', route)
    expect(settled.pending).toEqual([])
    expect(settled.byAgent['a1']).toBe(route)
  })

  test('a step that comes first claims the pick by type and description', () => {
    const book = addPending(empty, entry)
    expect(claimRoute(book, 'a1', 'Plan', 'Find')).toBe(book)
    expect(claimRoute(book, 'a1', 'Explore', 'Other')).toBe(book)
    const claimed = claimRoute(book, 'a1', 'Explore', 'Find')
    expect(claimed.byAgent['a1']).toBe(route)
    expect(claimed.pending).toEqual([])
    expect(claimRoute(claimed, 'a1', 'Explore', 'Find')).toBe(claimed)
    // The answer that follows keeps the claimed pick.
    expect(settleRoute(claimed, 'tu1', 'a1', other).byAgent['a1']).toBe(route)
  })

  test('a refused spawn drops its pick', () => {
    const book = addPending(empty, entry)
    expect(dropPending(book, 'ghost')).toBe(book)
    expect(dropPending(book, 'tu1').pending).toEqual([])
  })

  test('the book stays small', () => {
    let book = empty
    for (let i = 0; i < 80; i += 1) book = addPending(book, { ...entry, toolUseId: `tu${i}` })
    expect(book.pending).toHaveLength(60)
    expect(book.pending[0]?.toolUseId).toBe('tu20')
    let settled = empty
    for (let i = 0; i < 80; i += 1) settled = settleRoute(settled, `tu${i}`, `a${i}`, route)
    expect(Object.keys(settled.byAgent)).toHaveLength(60)
    expect(settled.byAgent['a79']).toBe(route)
    expect(settled.byAgent['a0']).toBeUndefined()
  })
})

describe('/radar arguments', () => {
  test('opens, shows status, sets a mode or a ceiling, and refuses the rest', () => {
    expect(parseRadarArgs('')).toEqual({ kind: 'open' })
    expect(parseRadarArgs('  open ')).toEqual({ kind: 'open' })
    expect(parseRadarArgs('status')).toEqual({ kind: 'status' })
    expect(parseRadarArgs('mode auto')).toEqual({ kind: 'set', change: { mode: 'auto' } })
    expect(parseRadarArgs('MODE Suggest')).toEqual({ kind: 'set', change: { mode: 'suggest' } })
    expect(parseRadarArgs('mode off')).toEqual({ kind: 'set', change: { mode: 'off' } })
    expect(parseRadarArgs('ceiling session')).toEqual({ kind: 'set', change: { ceiling: 'session' } })
    expect(parseRadarArgs('ceiling raise')).toEqual({ kind: 'set', change: { ceiling: 'raise' } })
    for (const bad of ['mode loud', 'mode', 'mode auto now', 'ceiling', 'nonsense']) {
      const parsed = parseRadarArgs(bad)
      expect(parsed.kind).toBe('bad')
      if (parsed.kind === 'bad') expect(parsed.usage).toContain('/radar mode auto|suggest|off')
    }
  })

  test('withPrefs changes the settings and keeps the object when nothing changes', () => {
    expect(withPrefs(AUTO, { mode: 'auto' })).toBe(AUTO)
    expect(withPrefs(AUTO, {})).toBe(AUTO)
    expect(withPrefs(AUTO, { mode: 'off' })).toEqual({ mode: 'off', ceiling: 'raise' })
    expect(withPrefs(AUTO, { ceiling: 'session' })).toEqual({ mode: 'auto', ceiling: 'session' })
  })
})

describe('tokens', () => {
  test('adds a response\'s usage, and counts every kind of token', () => {
    const once = addTokens(undefined, USAGE)
    expect(once).toEqual({ input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 })
    expect(addTokens(once, USAGE)).toEqual({ input: 2000, output: 400, cacheRead: 10000, cacheWrite: 600 })
    expect(totalTokens(once)).toBe(6500)
    expect(totalTokens(undefined)).toBe(0)
    expect(contextOf(USAGE)).toBe(6300)
  })

  test('words a count briefly', () => {
    expect(formatTokens(850)).toBe('850')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(123_456)).toBe('123k')
    expect(formatTokens(1_234_567)).toBe('1.2M')
    expect(formatTokens(2_000_000)).toBe('2M')
  })

  test('sums tokens by route kind, in a fixed order', () => {
    let book = countAgent({}, 'hard')
    book = countAgent(book, 'lookup')
    book = addSpendTokens(book, 'hard', 900_000)
    book = addSpendTokens(book, 'lookup', 40_000)
    expect(addSpendTokens(book, 'lookup', 0)).toBe(book)
    expect(book).toEqual({ hard: { tokens: 900_000, agents: 1 }, lookup: { tokens: 40_000, agents: 1 } })
    expect(describeSpend(book)).toBe('subagent tokens 940k · lookup 40k · hard 900k')
    expect(describeSpend({})).toBe('')
  })
})

describe('file conflicts', () => {
  test('reads the path an edit names, and nothing from other calls', () => {
    expect(editedPath({ tool: 'Edit', file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(editedPath({ tool: 'Write', file_path: '/a/c.md' })).toBe('/a/c.md')
    expect(editedPath({ tool: 'NotebookEdit', notebook_path: '/n.ipynb' })).toBe('/n.ipynb')
    expect(editedPath({ tool: 'Read', file_path: '/a/b.ts' })).toBeUndefined()
    expect(editedPath({ tool: 'Edit' })).toBeUndefined()
  })

  test('notes a file once', () => {
    const files = noteFile(undefined, '/a/b.ts')
    expect(files).toEqual(['/a/b.ts'])
    expect(noteFile(files, '/a/b.ts')).toBe(files)
  })

  test('only another live agent that edited the file is a rival', () => {
    const rows = [
      row({ id: 'a1', files: ['/x.ts'] }),
      row({ id: 'a2', files: ['/x.ts'] }),
      row({ id: 'a3', files: ['/x.ts'], status: 'completed', endedAt: 5 }),
      row({ id: 'a4', files: ['/y.ts'] }),
    ]
    expect(rivalsOf(rows, 'a1', '/x.ts')).toEqual(['a2'])
  })

  test('a clash is news once per file and once per new agent', () => {
    const first = addConflict([], '/x.ts', '/X.ts', ['a1', 'a2'], 10)
    expect(first.isNew).toBe(true)
    expect(first.list).toEqual([{ key: '/x.ts', path: '/X.ts', agents: ['a1', 'a2'], at: 10 }])
    const again = addConflict(first.list, '/x.ts', '/x.ts', ['a2', 'a1'], 20)
    expect(again.isNew).toBe(false)
    expect(again.list).toBe(first.list)
    const third = addConflict(first.list, '/x.ts', '/x.ts', ['a1', 'a3'], 30)
    expect(third.isNew).toBe(true)
    expect(third.list[0]?.agents).toEqual(['a1', 'a2', 'a3'])
  })
})

describe('lessons', () => {
  const applied: Route = { kind: 'lookup', model: 'haiku', effort: 'low', why: 'x', isApplied: true }

  test('an agent\'s end teaches only when it was routed, applied and not stopped', () => {
    const done = row({ status: 'completed', route: applied, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })
    expect(outcomeOf(done, 99)).toEqual({ kind: 'lookup', struggled: false, wasRaised: false, tokens: 10, at: 99, effort: 'low', billed: 16 })
    expect(outcomeOf({ ...done, status: 'failed' }, 99)?.struggled).toBe(true)
    expect(outcomeOf({ ...done, errors: 3 }, 99)?.struggled).toBe(true)
    expect(outcomeOf({ ...done, route: { ...applied, isLearned: true } }, 99)?.wasRaised).toBe(true)
    expect(outcomeOf({ ...done, status: 'killed' }, 99)).toBeUndefined()
    expect(outcomeOf({ ...done, status: 'running' }, 99)).toBeUndefined()
    expect(outcomeOf({ ...done, route: { ...applied, isApplied: false } }, 99)).toBeUndefined()
    expect(outcomeOf({ ...done, route: { kind: 'kept', why: 'x', isApplied: false } }, 99)).toBeUndefined()
    const { route, ...unrouted } = done
    void route
    expect(outcomeOf(unrouted, 99)).toBeUndefined()
  })

  test('raises a kind when a quarter of ten or more runs struggled', () => {
    expect(lessonsFrom(STRUGGLING_LOOKUPS).lookup).toEqual({ runs: 10, struggled: 3, isRaised: true })
    expect(lessonsFrom(STRUGGLING_LOOKUPS.slice(1)).lookup?.isRaised).toBe(false)
    const calm = Array.from({ length: 10 }, (_, at) => outcome({ struggled: at < 2, at }))
    expect(lessonsFrom(calm).lookup?.isRaised).toBe(false)
    expect(lessonsFrom([]).lookup).toBeUndefined()
  })

  test('runs a lesson already raised never feed the lesson', () => {
    const raisedRuns = Array.from({ length: 10 }, (_, at) => outcome({ struggled: true, wasRaised: true, at }))
    expect(lessonsFrom(raisedRuns).lookup).toBeUndefined()
  })

  test('a lesson moves a haiku lookup to the middle model and raises any other kind one level', () => {
    const lesson = { runs: 10, struggled: 3, isRaised: true }
    const lookup = classifyTask(LOOKUP_ASK)
    expect(applyLesson(lookup, lesson)).toEqual({ verdict: { ...lookup, tier: 'sonnet' }, isLearned: true })
    const routine = classifyTask({ subagentType: 'general-purpose', description: 'Add pagination', prompt: 'Implement it.' })
    expect(applyLesson(routine, lesson).verdict.effort).toBe('high')
    const hard = classifyTask(HARD_ASK)
    expect(applyLesson(hard, lesson)).toEqual({ verdict: hard, isLearned: false })
    expect(applyLesson(lookup, { ...lesson, isRaised: false }).isLearned).toBe(false)
  })

  test('the router applies a lesson, says so, and drops it when learning is off', () => {
    const lessons = lessonsFrom(STRUGGLING_LOOKUPS)
    const learned = chooseRoute(facts(LOOKUP_ASK), AUTO, undefined, lessons)
    expect(learned).toMatchObject({ kind: 'lookup', model: 'claude-sonnet-5-5', effort: 'medium', isLearned: true })
    expect(learned?.why).toContain('learned: raised')
    const off = chooseRoute(facts(LOOKUP_ASK), { ...AUTO, learn: false }, undefined, lessons)
    expect(off).toMatchObject({ model: 'claude-sonnet-5-5', tier: 'sonnet' })
    expect(off).not.toHaveProperty('isLearned')
  })

  test('reads stored outcomes safely, and keeps the newest of each kind', () => {
    expect(asOutcomes('junk')).toEqual([])
    expect(asOutcomes([outcome(), { kind: 'kept', struggled: false, wasRaised: false, tokens: 1, at: 1 }, null, { kind: 'lookup' }])).toEqual([outcome()])
    const many = Array.from({ length: 130 }, (_, at) => outcome({ at }))
    const kept = trimOutcomes([...many, outcome({ kind: 'hard', at: 5 })])
    expect(kept.filter(one => one.kind === 'lookup')).toHaveLength(100)
    expect(kept[0]?.at).toBe(5)
    expect(kept.at(-1)?.at).toBe(129)
  })

  test('/radar stats words the lessons', () => {
    expect(describeLessons([])).toBe('No routed runs recorded yet.')
    expect(describeLessons(STRUGGLING_LOOKUPS)).toBe('lookup: 10 runs, 30% struggled, about 1k tokens each (raised) · haiku 10 (70% ok) · budget 50k')
  })

  test('the new /radar words, and the learning switch in the settings line', () => {
    expect(parseRadarArgs('stats')).toEqual({ kind: 'stats' })
    expect(parseRadarArgs('learn off')).toEqual({ kind: 'set', change: { learn: false } })
    expect(parseRadarArgs('learn on')).toEqual({ kind: 'set', change: { learn: true } })
    expect(parseRadarArgs('learn reset')).toEqual({ kind: 'forget' })
    expect(parseRadarArgs('learn maybe').kind).toBe('bad')
    expect(parseRadarArgs('status now').kind).toBe('bad')
    expect(routingWords({ ...AUTO, learn: false })).toBe('mode auto, ceiling raise, models sonnet and opus only, learning off')
    expect(withPrefs(AUTO, { learn: false })).toEqual({ ...AUTO, learn: false })
  })

  test('a wait shows only after two seconds, and never on an ended agent', () => {
    const waiting = row({ needs: { tool: 'Bash', since: 1000 } })
    expect(isWaiting(waiting, 2500)).toBe(false)
    expect(isWaiting(waiting, 3000)).toBe(true)
    expect(isWaiting({ ...waiting, status: 'completed' }, 9000)).toBe(false)
    expect(isWaiting(row(), 9000)).toBe(false)
  })
})

describe('routing v2', () => {
  const routine = (fields: Partial<Outcome> = {}): Outcome => outcome({ kind: 'routine', tier: 'haiku', ...fields })
  const JOB = { subagentType: 'general-purpose', description: 'Add pagination', prompt: 'Implement pagination.' } as const

  test('tokens are weighed by what they cost: cache reads light, output heavy', () => {
    expect(billedTokens({ input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 })).toBe(2875)
    expect(billedTokens(undefined)).toBe(0)
  })

  test('the Wilson bound: 20 clean runs prove 85%, one miss in 20 does not', () => {
    expect(wilsonLower(20, 20)).toBeGreaterThan(0.85)
    expect(wilsonLower(19, 20)).toBeLessThan(0.85)
    expect(wilsonLower(0, 0)).toBe(0)
  })

  test('history counts runs per kind and tier, old records on their old tier, and the haiku share', () => {
    const old = outcome({ kind: 'routine' })
    const history = historyFrom([old, routine(), routine({ struggled: true }), outcome({ kind: 'lookup', tier: 'haiku' })])
    expect(history.tiers['routine:sonnet']).toEqual({ runs: 1, ok: 1 })
    expect(history.tiers['routine:haiku']).toEqual({ runs: 2, ok: 1 })
    expect(history.haikuShare).toBe(1)
    expect(history.routedRuns).toBe(3)
  })

  test('a budget is the median of clean runs once there are five, else the default', () => {
    const runs = [100, 200, 300, 400, 500].map(billed => outcome({ kind: 'routine', tier: 'sonnet', billed }))
    expect(historyFrom(runs).budgets.routine).toBe(300)
    expect(historyFrom(runs.slice(1)).budgets.routine).toBeUndefined()
    expect(budgetUse({ kind: 'routine', why: '', isApplied: true, budget: 1000 }, { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(50)
    expect(budgetUse({ kind: 'routine', why: '', isApplied: true }, { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
  })

  test('a cheaper tier that holds takes a hard kind from opus to sonnet, with one more level of effort', () => {
    const hard = (at: number, fields: Partial<Outcome> = {}): Outcome => outcome({ kind: 'hard', tier: 'sonnet', at, ...fields })
    const proven = historyFrom(Array.from({ length: 20 }, (_, at) => hard(at)))
    const route = chooseRoute(facts(HARD_ASK), AUTO, undefined, undefined, proven)
    expect(route).toMatchObject({ kind: 'hard', model: 'claude-sonnet-5-5', effort: 'xhigh', tier: 'sonnet', baseTier: 'opus', isProven: true })
    expect(route?.why).toContain('learned: sonnet holds')
    // A model the call names stays, and learning off moves nothing.
    expect(chooseRoute(facts({ ...HARD_ASK, model: 'opus' }), AUTO, undefined, undefined, proven)).not.toHaveProperty('isProven')
    expect(chooseRoute(facts(HARD_ASK), { ...AUTO, learn: false }, undefined, undefined, proven)).toMatchObject({ tier: 'opus' })
    // One miss in twenty is not proof.
    const missed = historyFrom(Array.from({ length: 20 }, (_, at) => hard(at, { struggled: at === 0 })))
    expect(chooseRoute(facts(HARD_ASK), AUTO, undefined, undefined, missed)).toMatchObject({ tier: 'opus' })
  })

  test('nothing moves below sonnet, even when haiku history is proven', () => {
    const proven = historyFrom(Array.from({ length: 20 }, (_, at) => routine({ at })))
    expect(proven.tiers['routine:haiku']?.runs).toBe(20)
    const route = chooseRoute(facts(JOB), AUTO, undefined, undefined, proven)
    expect(route).toMatchObject({ kind: 'routine', tier: 'sonnet', baseTier: 'sonnet', effort: 'medium' })
    expect(route).not.toHaveProperty('isProven')
    const verdict = { kind: 'routine', tier: 'sonnet', effort: 'medium', why: 'x' } as const
    expect(downMove(verdict, proven, AUTO, 'seed-1')).toBeUndefined()
  })

  test('no run tries a cheaper tier from sonnet, for any seed', () => {
    const baseline = historyFrom(Array.from({ length: 10 }, (_, at) => outcome({ kind: 'routine', tier: 'sonnet', at })))
    const seeds = Array.from({ length: 200 }, (_, i) => `seed-${i}`)
    for (const kind of ['lookup', 'routine', 'careful'] as const) {
      const verdict = { kind, tier: 'sonnet', effort: 'medium', why: 'x' } as const
      expect(seeds.filter(seed => downMove(verdict, baseline, AUTO, seed) !== undefined)).toEqual([])
      expect(seeds.filter(seed => downMove(verdict, baseline, { ...AUTO, target: 0.9 }, seed) !== undefined)).toEqual([])
    }
    const hardVerdict = { kind: 'hard', tier: 'opus', effort: 'xhigh', why: 'x' } as const
    expect(seeds.filter(seed => downMove(hardVerdict, baseline, AUTO, seed) !== undefined)).toEqual([])
    expect(seedFraction('a')).toBe(seedFraction('a'))
  })

  test('a haiku target raises how often runs try haiku while the share is below it', () => {
    const history = historyFrom(Array.from({ length: 10 }, (_, at) => outcome({ kind: 'routine', tier: 'sonnet', at })))
    expect(exploreRate(AUTO, history)).toBe(0.1)
    expect(Math.abs(exploreRate({ ...AUTO, target: 0.3 }, history) - 0.3) < 1e-9).toBe(true)
    expect(Math.abs(exploreRate({ ...AUTO, target: 0.1 }, history) - 0.15) < 1e-9).toBe(true)
  })

  test('an over-budget run counts as a struggle; a try teaches its tier but never raises the kind', () => {
    const route = { kind: 'routine', why: '', isApplied: true, tier: 'haiku', budget: 10, isExplore: true } as const
    const done = row({ status: 'completed', route, tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } })
    expect(outcomeOf(done, 1)).toMatchObject({ struggled: true, overBudget: true, wasExplore: true, tier: 'haiku' })
    const tries = Array.from({ length: 10 }, (_, at) => routine({ struggled: true, wasExplore: true, at }))
    expect(lessonsFrom(tries).routine).toBeUndefined()
  })

  test('/radar target haiku sets the share to aim for, and the settings line says it', () => {
    expect(parseRadarArgs('target haiku 30%')).toEqual({ kind: 'set', change: { target: 0.3 } })
    expect(parseRadarArgs('target haiku 30')).toEqual({ kind: 'set', change: { target: 0.3 } })
    expect(parseRadarArgs('target off')).toEqual({ kind: 'set', change: { target: undefined } })
    expect(parseRadarArgs('target haiku lots').kind).toBe('bad')
    expect(routingWords({ ...AUTO, target: 0.3 })).toBe('mode auto, ceiling raise, models sonnet and opus only, haiku target 30% (unused: haiku is off)')
  })
})

describe('the team', () => {
  const lead = { model: 'claude-opus-5-5', effort: 'xhigh', phase: 'thinking' } as const

  test('callDetail is the short argument after a tool name', () => {
    expect(callDetail({ tool: 'Grep', pattern: 'MAX_OFFICES' })).toBe('MAX_OFFICES')
    expect(callDetail({ tool: 'Read', file_path: '/a/b/notes.md' })).toBe('notes.md')
    expect(callDetail({ tool: 'Bash', command: 'git status' })).toBe('git status')
    expect(callDetail({ tool: 'Bash', description: 'Show status', command: 'git status' })).toBe('Show status')
    expect(callDetail({ tool: 'WebFetch', url: 'https://example.com/x' })).toBe('example.com')
    expect(callDetail({ tool: 'mcp__github__get_issue' })).toBe('github · get_issue')
    expect(callDetail({ tool: 'TodoWrite' })).toBe('')
  })

  test('statusLine names the activity, the tool and its argument', () => {
    expect(statusLine('reading', 'Grep', 'MAX_OFFICES', '')).toBe('reading · Grep: MAX_OFFICES')
    expect(statusLine('terminal', 'Bash', 'git status', '')).toBe('at the terminal · Bash: git status')
    expect(statusLine('helper', 'Agent', 'Look over the tests', '')).toBe('waiting on a helper · Agent: Look over the tests')
    expect(statusLine('calling', 'mcp__github__get_issue', 'github · get_issue', '')).toBe('calling a service · MCP: github · get_issue')
    expect(statusLine('thinking', 'Grep', 'x', '')).toBe('thinking')
    expect(statusLine('done', undefined, undefined, 'Found three modules.')).toBe('done · Found three modules.')
    expect(statusLine('done', undefined, undefined, 'finished')).toBe('done')
    expect(statusLine('waiting-you', 'Bash', 'make clean', '')).toBe('waiting on you · Bash: make clean')
  })

  test('teamOf puts the Lead first, numbers repeated names and keeps desks', () => {
    const team = teamOf(
      [
        row({ id: 'a1', type: 'Explore', startedAt: 1, seat: 2 }),
        row({ id: 'a2', type: 'Explore', startedAt: 2, seat: 1 }),
        row({ id: 'a3', type: 'general-purpose', startedAt: 3 }),
        row({ id: 'a4', type: 'Plan', name: 'planner', startedAt: 4, status: 'completed', endedAt: 9, seat: 1 }),
      ],
      lead,
      100,
    )
    expect(team.map(entry => entry.member.label)).toEqual(['Lead', 'Explore', 'Explore 2', 'General', 'planner'])
    expect(team.map(entry => entry.member.seat)).toEqual([0, 2, 1, 3, 1])
    expect(team[0]?.member).toMatchObject({ role: 'lead', activity: 'thinking' })
    expect(team[0]?.member.tooltip).toBe('Lead · opus 5.5 · xhigh · thinking')
    expect(team[4]?.member).toMatchObject({ isEnded: true, activity: 'done' })
  })

  test('a desk goes to the lowest one no live agent holds', () => {
    expect(freeSeat([])).toBe(1)
    expect(freeSeat([row({ seat: 1 }), row({ id: 'a2', seat: 2 })])).toBe(3)
    expect(freeSeat([row({ seat: 1, status: 'completed' }), row({ id: 'a2', seat: 2 })])).toBe(1)
    const made = upsertRow([row({ seat: 1 })], 'a9', 5, { type: 'Explore' })
    expect(made[1]?.seat).toBe(2)
  })

  test('isMoving: work, a walk under way, or nobody at all', () => {
    const idle = teamOf([], { model: 'm', phase: 'idle' }, 100)
    expect(isMoving(idle, 100)).toBe(false)
    expect(isMoving(teamOf([], { model: 'm', phase: 'thinking' }, 100), 100)).toBe(true)
    const justDone = teamOf([row({ status: 'completed', endedAt: 90, startedAt: 0 })], { model: 'm', phase: 'idle' }, 100)
    expect(isMoving(justDone, 100)).toBe(true)
    expect(isMoving(justDone, 5000)).toBe(false)
  })

  test('view switches: parse, apply, read back and word', () => {
    expect(parseRadarArgs('view office')).toEqual({ kind: 'view', change: { layout: 'office' } })
    expect(parseRadarArgs('view cards')).toEqual({ kind: 'view', change: { layout: 'cards' } })
    expect(parseRadarArgs('labels off')).toEqual({ kind: 'view', change: { labels: false } })
    expect(parseRadarArgs('motion on')).toEqual({ kind: 'view', change: { motion: true } })
    expect(parseRadarArgs('details off')).toEqual({ kind: 'view', change: { details: false } })
    expect(parseRadarArgs('details maybe').kind).toBe('bad')
    expect(parseRadarArgs('view sideways').kind).toBe('bad')
    const view = { layout: 'both', labels: true, motion: true } as const
    expect(withView(view, { labels: true })).toBe(view)
    expect(withView(view, { motion: false })).toEqual({ ...view, motion: false })
    expect(withView(view, { details: false })).toEqual({ ...view, details: false })
    // A save from before the details switch reads as details on.
    expect(asView({ layout: 'office', labels: false, motion: true })).toEqual({ layout: 'office', labels: false, motion: true, details: true, sessions: true })
    expect(asView({ layout: 'office', labels: false, motion: true, details: false })?.details).toBe(false)
    expect(asView({ layout: 'office', labels: false, motion: true, details: 'yes' })).toBeUndefined()
    expect(asView({ layout: 'nope', labels: false, motion: true })).toBeUndefined()
    expect(asView('junk')).toBeUndefined()
    expect(viewWords(view)).toBe('office and cards, labels on, motion on, details on, sessions recent (idle 2h), 6 floors')
    expect(viewWords({ ...view, details: false })).toBe('office and cards, labels on, motion on, details off, sessions recent (idle 2h), 6 floors')
    expect(viewWords({ ...view, sessionsMode: 'all', floors: 1 })).toBe('office and cards, labels on, motion on, details on, sessions all, 1 floor')
    expect(viewWords({ ...view, idleHours: 0.5 })).toContain('sessions recent (idle 30m), 6 floors')
    expect(viewWords({ ...view, sessions: false })).toBe('office and cards, labels on, motion on, details on, sessions off')
    // The session settings: parsed, kept on save, and anything out of range dropped.
    expect(parseRadarArgs('idle 0.5')).toEqual({ kind: 'view', change: { idleHours: 0.5 } })
    expect(parseRadarArgs('idle 0').kind).toBe('bad')
    expect(parseRadarArgs('idle 200').kind).toBe('bad')
    expect(parseRadarArgs('idle soon').kind).toBe('bad')
    expect(parseRadarArgs('floors 3')).toEqual({ kind: 'view', change: { floors: 3 } })
    expect(parseRadarArgs('floors 0')).toEqual({ kind: 'view', change: { floors: 0 } })
    expect(parseRadarArgs('floors 21').kind).toBe('bad')
    expect(parseRadarArgs('floors 2.5').kind).toBe('bad')
    expect(parseRadarArgs('sessions all')).toEqual({ kind: 'view', change: { sessionsMode: 'all' } })
    expect(parseRadarArgs('sessions recent')).toEqual({ kind: 'view', change: { sessionsMode: 'recent' } })
    const saved = { layout: 'both', labels: true, motion: true, sessionsMode: 'all', idleHours: 3, floors: 4 }
    expect(asView(saved)).toEqual({ ...saved, details: true, sessions: true })
    expect(asView({ ...saved, sessionsMode: 'some', idleHours: -1, floors: 99 })).toEqual({ layout: 'both', labels: true, motion: true, details: true, sessions: true })
    expect(withView(view, { floors: 6 })).not.toBe(view)
    expect(withView({ ...view, floors: 6 }, { floors: 6 })).toEqual({ ...view, floors: 6 })
  })

  test('the window and the board read the right numbers', () => {
    expect(windowOf('claude-opus-5-5', 200_000)).toBe(200_000)
    expect(windowOf('claude-opus-4-1[1m]', 200_000)).toBe(1_000_000)
    expect(kindSpendOf({ hard: { tokens: 9, agents: 1 } })).toEqual({ lookup: 0, routine: 0, careful: 0, hard: 9 })
  })
})

describe('details', () => {
  test('noteCall keeps the last five calls and counts calls by tool, MCP tools as one', () => {
    let state: Pick<AgentRow, 'trail' | 'toolCounts'> = {}
    for (const [tool, detail] of [
      ['Read', 'a.ts'],
      ['Grep', 'load'],
      ['Read', 'b.ts'],
      ['mcp__github__search', 'github · search'],
      ['mcp__chat__post', 'chat · post'],
      ['Bash', 'Run tests'],
    ] as const) {
      state = noteCall(state, tool, detail)
    }
    expect(state.trail).toEqual([
      { tool: 'Grep', detail: 'load' },
      { tool: 'Read', detail: 'b.ts' },
      { tool: 'MCP', detail: 'github · search' },
      { tool: 'MCP', detail: 'chat · post' },
      { tool: 'Bash', detail: 'Run tests' },
    ])
    expect(state.toolCounts).toEqual({ Read: 2, Grep: 1, MCP: 2, Bash: 1 })
  })

  test('noteCall counts tools past the first 24 kinds as other', () => {
    const many = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`T${i}`, 1]))
    expect(noteCall({ toolCounts: many }, 'Newcomer', '').toolCounts).toMatchObject({ other: 1 })
    expect(noteCall({ toolCounts: many }, 'T3', '').toolCounts).toMatchObject({ T3: 2 })
  })

  test('files are kept as named, known in any case, and compared lowercased for clashes', () => {
    const files = noteFile(undefined, '/repo/Config.ts')
    expect(noteFile(files, '/repo/config.ts')).toBe(files)
    expect(rivalsOf([row({ id: 'a1', files: ['/repo/Config.ts'] }), row({ id: 'a2' })], 'a2', '/repo/config.ts')).toEqual(['a1'])
    expect(readPath({ tool: 'Read', file_path: '/repo/README.md' })).toBe('/repo/README.md')
    expect(readPath({ tool: 'Grep', pattern: 'x' })).toBeUndefined()
  })

  test('clockTime is the local time of day', () => {
    const at = new Date(2026, 9, 8, 9, 5, 7).getTime()
    expect(clockTime(at)).toBe('09:05:07')
  })

  test('detailLines: last calls, calls by tool, files, tokens and times', () => {
    const start = new Date(2026, 9, 8, 14, 2, 11).getTime()
    const full = row({
      status: 'completed',
      tools: 6,
      errors: 1,
      steps: 4,
      trail: [
        { tool: 'Read', detail: 'a.ts' },
        { tool: 'Grep', detail: 'load' },
        { tool: 'Read', detail: 'b.ts' },
        { tool: 'Bash', detail: '' },
        { tool: 'Edit', detail: 'a.ts' },
      ],
      toolCounts: { Read: 3, Grep: 1, Bash: 1, Edit: 1 },
      files: ['/repo/a.ts'],
      reads: ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'],
      tokens: { input: 1200, output: 820, cacheRead: 88_000, cacheWrite: 5000 },
      startedAt: start,
      endedAt: start + 6000,
    })
    expect(cardDetails(full, 'Lead')).toEqual({
      recent: 'recent: Grep load › Read b.ts › Bash › Edit a.ts',
      stats: '6 tool calls (Read 3, Bash 1, Edit 1, Grep 1) · 1 failed · 4 model calls · edited a.ts · read 3 files',
      tokens: 'in 1.2k · cache read 88k · cache write 5k · out 820',
      times: '14:02:11–14:02:17',
    })
    const quiet = row({ tools: 0, steps: 1, startedAt: start })
    expect(cardDetails(quiet, 'Explore 2')).toEqual({ stats: 'no tool calls · 1 model call', times: 'for Explore 2 · since 14:02:11' })
    const chatty = row({ trail: [{ tool: 'Bash', detail: 'Run the whole test suite for the mod and then the linter' }] })
    expect(cardDetails(chatty, 'Lead').recent).toBe('recent: Bash Run the whole test suite for the mod an…')
    // Another session's agent carries only how many files it read.
    expect(cardDetails(row({ readCount: 3 }), 'Lead').stats).toContain('read 3 files')
    const many = row({ files: ['/a/1.ts', '/a/2.ts', '/a/3.ts', '/a/4.ts'] })
    expect(cardDetails(many, 'Lead').stats).toContain('edited 4 files: 1.ts, 2.ts, 3.ts, …')
    // Found already done: its times are made up, so none show.
    const found = row({ status: 'completed', startedAt: 500, endedAt: 500 })
    expect(cardDetails(found, 'Lead')).toEqual({ stats: 'no tool calls' })
  })

  test('routeSummary: the kind, a lesson or a raise, a suggestion, or why a spawn was kept', () => {
    expect(routeSummary({ kind: 'lookup', model: 'haiku', effort: 'low', why: 'lookup: Explore', isApplied: true })).toBe('lookup')
    expect(routeSummary({ kind: 'careful', model: 'sonnet', effort: 'high', isLearned: true, why: 'x', isApplied: true }, 'xhigh')).toBe(
      'careful · learned · raised to xhigh',
    )
    expect(routeSummary({ kind: 'lookup', model: 'haiku', effort: 'low', why: 'x', isApplied: false })).toBe('lookup · would use haiku low')
    expect(routeSummary({ kind: 'kept', why: 'a fork inherits its parent', isApplied: false })).toBe('a fork inherits its parent')
  })

  test('statusLine shows more of an answer when asked', () => {
    const long = 'x'.repeat(200)
    expect(statusLine('done', undefined, undefined, long)).toHaveLength('done · '.length + 90)
    expect(statusLine('done', undefined, undefined, long, 300)).toBe(`done · ${long}`)
  })
})

for (const surface of SURFACES) {
  describe(`on ${surface}`, () => {
    test('the Team pane draws the office: Raster cells in the terminal, an SVG elsewhere', async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      if (surface === 'terminal') {
        const office = await ui.find({ type: 'Raster', key: 'office' })
        expect(office).toBeDefined()
        expect(await ui.find({ type: 'Raster', key: 'av-a1' })).toBeDefined()
        expect(await ui.find({ type: 'Raster', key: 'av-main' })).toBeDefined()
      } else {
        const office = (await ui.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('Office: Lead'))
        expect(office).toBeDefined()
        // An image, not an interactive frame: a frame reloads, and flashes white, at every change.
        expect(office?.props.isInteractive).toBeUndefined()
        expect(String(office?.props.source).startsWith('<svg')).toBe(true)
      }
      expect(await ui.find({ type: 'Text', text: /^Team$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Lead$/ })).toBeDefined()
      await ui.unmount()
    })

    test('cards carry a status line and a context gauge, the Lead too', async ($, on) => {
      engine(on, STEP_WITH_USAGE)
      await run($.turn.step(stepOf({ effort: 'xhigh' })))
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await run($.turn.step(stepOf({ model: 'claude-haiku-4-5', agentId: 'a1' })))
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      // The Lead's gauge, and the subagent's with its numbers (details are on by default).
      expect(await ui.findAll({ type: 'Text', text: /^ctx 3%$/ })).toHaveLength(1)
      expect(await ui.find({ type: 'Text', text: /^ctx 3% · 6\.3k of 200k$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^writing a reply$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a card with details shows recent calls, calls by tool, files, tokens, times and the answer', async ($, on) => {
      const world = engine(on, STEP_WITH_USAGE)
      const startedAt = world.clock.now()
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await run($.turn.step(stepOf({ model: 'claude-haiku-4-5', agentId: 'a1' })))
      for (const call of [
        { tool: 'Read', file_path: '/repo/src/Config.ts' },
        { tool: 'Read', file_path: '/repo/src/config.ts' },
        { tool: 'Grep', pattern: 'loadConfig' },
        { tool: 'Read', file_path: '/repo/README.md' },
        { tool: 'Edit', file_path: '/repo/src/Config.ts' },
        { tool: 'mcp__github__search', query: 'config' },
      ]) {
        await $.tool.call({ ...call, agentId: 'a1' } as never)
      }
      await world.clock.advance(6000)
      let ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      // At work: its last calls (up to two lines), one wrapping line of counts and files, the footer
      // (model with its number, effort, the router's kind; when it started), and on hover its tokens by kind.
      expect(await ui.find({ type: 'Text', text: /^recent: Grep loadConfig › Read README\.md › Edit Config\.ts › MCP/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^6 tool calls \(Read 3, Edit 1, Grep 1, MCP 1\) · 1 model call · edited Config\.ts · read 2 files$/ })).toBeDefined()
      // This step sent no effort (the model takes none), so the footer names none.
      // Its budget shows once it has used tokens: 2.9k input-token equivalents of the lookup's 50k.
      expect(await ui.find({ type: 'Text', text: /^haiku 4\.5 · lookup · budget 6%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `since ${clockTime(startedAt)}` })).toBeDefined()
      const breakdown = await ui.find({ type: 'Text', text: /^tokens in 1k · cache read 5k · cache write 300 · out 200$/ })
      expect(breakdown).toBeDefined()
      // That line and the router's reasons wait under the card, shown while the pointer is on it.
      const reveals = (await ui.findAll({ type: 'Box' })).filter(box => box.props.display === 'none')
      expect(reveals).toHaveLength(1)
      // (The kit does not carry `hover` in the props it shows: the reveal itself is the surface's.)
      // Color on a border means something: the Lead's is orange; a working agent's is plain.
      expect((await ui.find({ type: 'Box', key: 'card-main' }))?.props.borderColor).toBe('claude')
      expect((await ui.find({ type: 'Box', key: 'card-a1' }))?.props.borderColor).toBeUndefined()
      await ui.unmount()
      const answer = `Config loads in src/Config.ts through loadConfig, which reads the env first and the file second; ${'more '.repeat(20)}END`
      await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
      ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^recent: / })).toBeUndefined()
      // Finished, its card is two lines: how it ended and when, then the first line of its answer.
      expect(await ui.find({ type: 'Text', text: /^done in 6s$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Config loads in src\/Config\.ts .*…$/ })).toBeDefined()
      // Kept in this session only: nothing of the answer goes to disk.
      expect(JSON.stringify([...world.store.values()])).not.toContain('loadConfig')
      await ui.unmount()

      expect((await $.command.run(radarArgs('details off'))).text).toBe('View: office and cards, labels on, motion on, details off, sessions recent (idle 2h), 6 floors.')
      ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^recent: / })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^6 tool calls/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^Config loads in .*…$/ })).toBeDefined()
      await ui.unmount()
    })

    test('the effort of a request that came before the spawn answered shows on the card', async ($, on) => {
      const world = engine(on, TEXT_STEP, {
        beforeAnswer: () => run($.turn.step(stepOf({ model: 'claude-haiku-4-5', effort: 'high', agentId: 'a1' }))),
      })
      world.listed = [{ id: 'a1', type: 'Explore', description: LOOKUP_ASK.description, status: 'running' }]
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      expect(world.steps[0]?.effort).toBe('medium')
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^sonnet 5\.5 · medium · / })).toBeDefined()
      await ui.unmount()
    })

    test('/radar view cards drops the office, and view office drops the cards', async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      expect((await $.command.run(radarArgs('view cards'))).text).toBe('View: cards only, labels on, motion on, details on, sessions recent (idle 2h), 6 floors.')
      let ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      const offices = surface === 'terminal'
        ? await ui.findAll({ type: 'Raster', key: 'office' })
        : (await ui.findAll({ type: 'Svg' })).filter(one => String(one.props.alt).startsWith('Office'))
      expect(offices).toEqual([])
      expect(await ui.find({ type: 'Text', text: /^Lead$/ })).toBeDefined()
      await ui.unmount()
      await $.command.run(radarArgs('view office'))
      ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^Lead$/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^Team$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a redraw long after an agent finished walks no one to the lounge again', async ($, on) => {
      const world = engine(on)
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await world.clock.settle()
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await world.clock.advance(3000)
      await $.turn.complete({ answer: 'Found it.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
      // Nobody is live now, so the radar's own tick stops; the clock goes on.
      await world.clock.advance(60_000)
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      if (surface === 'desktop') {
        const office = (await ui.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('Office'))
        expect(String(office?.props.source)).not.toContain('animateTransform')
      } else {
        const before = (await ui.find({ type: 'Raster', key: 'office' }))?.props.cells
        await world.clock.advance(5000)
        await ui.redraw()
        expect((await ui.find({ type: 'Raster', key: 'office' }))?.props.cells).toBe(before)
      }
      await ui.unmount()
    })

    test('the last drawing of an open pane holds no walk once the walk is over (a click back in repaints it)', async ($, on) => {
      const world = engine(on)
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await world.clock.settle()
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      const officeNow = async (): Promise<string> =>
        surface === 'desktop'
          ? String((await ui.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('Office'))?.props.source)
          : String((await ui.find({ type: 'Raster', key: 'office' }))?.props.cells)
      await world.clock.advance(3000)
      await $.turn.complete({ answer: 'Found it.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
      const leaving = await officeNow()
      if (surface === 'desktop') expect(leaving).toContain('animateTransform')
      // No redraw is asked for from here on: a repaint shows whatever the pane drew last.
      await world.clock.advance(5000)
      const shown = await officeNow()
      expect(shown).not.toBe(leaving)
      if (surface === 'desktop') expect(shown).not.toContain('animateTransform')
      await world.clock.advance(5000)
      await ui.redraw()
      expect(await officeNow()).toBe(shown)
      await ui.unmount()
    })

    test('a narrow pane says to widen it instead of drawing the office', async ($, on) => {
      engine(on)
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: { ...PANE, bodyColumns: 30 } })
      expect(await ui.find({ type: 'Text', text: /^Widen the pane to see the office/ })).toBeDefined()
      await ui.unmount()
    })

    test('two agents of one type are Explore and Explore 2', async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK, description: 'Find the other loader' }))
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^Explore 2$/ })).toBeDefined()
      await ui.unmount()
    })
    test('the pane says what it waits for when no subagent ran', async ($, on) => {
      engine(on)
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /0 active · 0 finished/ })).toBeDefined()
      // The router's defaults go unsaid.
      expect(await ui.find({ type: 'Text', text: /routing/ })).toBeUndefined()
      await ui.unmount()
    })

    test('the pane shows a spawned subagent with its type, model and task', async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput({ description: 'Survey the repo', subagentType: 'Explore' }))
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^Explore$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /sonnet 5\.5/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Survey the repo/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 active · 0 finished/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^settling in$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a step shows the real model and effort, and what the agent does', async ($, on) => {
      let check: (() => Promise<void>) | undefined
      let during: unknown
      engine(on, TEXT_STEP, {
        duringToolCall: async () => {
          await check?.()
        },
      })
      await $.command.run(radarArgs('mode off'))
      await $.agent.spawn(spawnInput({ description: 'Survey the repo', subagentType: 'Explore' }))
      const step = $.turn.step({
        turnId: 't1',
        index: 0,
        model: 'claude-opus-4-1-20250805',
        effort: 'high',
        messageCount: 1,
        agentId: 'a1',
      })
      for await (const chunk of step) expect(chunk.kind).toBe('text')
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /opus 4\.1 · high/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /sonnet 5\.5/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^writing a reply$/ })).toBeDefined()
      check = async () => {
        await ui.redraw()
        during = await ui.find({ type: 'Text', text: /^reading · Read: main\.ts$/ })
      }
      await $.tool.call({ tool: 'Read', file_path: '/repo/src/main.ts', agentId: 'a1' } as never)
      // While the call runs, the card says what it reads; once it returns, the agent thinks again.
      expect(during).toBeDefined()
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /^thinking$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a step of an agent the radar never saw makes no row', async ($, on) => {
      engine(on)
      for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'ghost' })) {
        expect(chunk.kind).toBe('text')
      }
      await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'ghost' } as never)
      await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'ghost' })
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
      await ui.unmount()
    })

    test('a finished agent shows its answer and how long it ran', async ($, on) => {
      const { clock } = engine(on)
      await $.agent.spawn(spawnInput({ description: 'Survey the repo', subagentType: 'Explore' }))
      await clock.advance(65_000)
      await $.turn.complete({ answer: 'Found three modules.\nAll fine.', durationMs: 65_000, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /0 active · 1 finished/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1m 05s/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^done in 1m 05s$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Found three modules\. All fine\.$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
      await ui.unmount()
    })

    test('an aborted agent reads as stopped', async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput({ description: 'Survey the repo', subagentType: 'Explore' }))
      await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted', agentId: 'a1' })
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^■$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^stopped in \d+s$/ })).toBeDefined()
      await ui.unmount()
    })

    test('the band stays out of the way with nothing to show, and under a survey', async ($, on) => {
      engine(on)
      const quiet = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: BAND })
      expect(await quiet.find({ type: 'Text', text: /ENGINE BAND/ })).toBeDefined()
      await quiet.unmount()

      await $.skill.prompt({ skill: 'graphify', text: '' })
      const survey = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
      expect(await survey.find({ type: 'Text', text: /ENGINE BAND/ })).toBeDefined()
      expect(await survey.find({ type: 'Text', text: /graphify/ })).toBeUndefined()
      await survey.unmount()
    })

    test('a skill prompt shows a chip in the band', async ($, on) => {
      engine(on)
      await $.skill.prompt({ skill: 'graphify', text: '' })
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ type: 'Text', text: /^Skills$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /◆ graphify/ })).toBeDefined()
      // Another mod's band (here the engine's stand-in) stays, with ours under it.
      expect(await ui.find({ type: 'Text', text: /ENGINE BAND/ })).toBeDefined()
      await ui.unmount()
    })

    test('a Skill call from a subagent names the subagent, and the turn end dims the chip', async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput({ description: 'Survey the repo', subagentType: 'Explore' }))
      await $.tool.call({ tool: 'Skill', skill: 'asd-ste100', agentId: 'a1' } as never)
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ type: 'Text', text: /◆ asd-ste100 \(Explore\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'agents' })).toBeDefined()

      await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /^Skills · last turn$/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /◆ asd-ste100/ }))?.props.dimColor).toBe(true)

      await $.turn.start({ text: 'next', turnId: 't2' })
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /asd-ste100/ })).toBeUndefined()
      await ui.unmount()
    })

    test('the Agents button counts the active agents and offers the pane', async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput({ description: 'First', subagentType: 'Explore' }))
      await $.agent.spawn(spawnInput({ description: 'Second', subagentType: 'Plan' }))
      await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: BAND })
      expect((await ui.find({ type: 'Button', key: 'agents' }))?.props.label).toBe('Team 1/2')
      expect(await ui.find({ type: 'Text', text: /^Skills/ })).toBeUndefined()
      await ui.unmount()
    })

    test('pressing Agents opens the pane', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput({ description: 'First', subagentType: 'Explore' }))
      world.opened.length = 0
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: BAND })
      await ui.press({ key: 'agents' })
      expect(world.opened).toEqual([{ id: 'agents', title: 'Team' }])
      await ui.unmount()
    })

    test('the timer moves elapsed time, picks up listed agents, and ends rows', async ($, on) => {
      const world = engine(on)
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await $.agent.spawn(spawnInput({ description: 'Survey the repo', subagentType: 'Explore' }))
      world.listed = [
        { id: 'a1', type: 'Explore', description: 'Survey the repo', status: 'running' },
        { id: 'old', type: 'Plan', description: 'Spawned before a reload', status: 'running', name: 'planner' },
      ]
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      await world.clock.advance(5000)
      expect(await ui.find({ type: 'Text', text: /2 active · 0 finished/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^5s$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^4s$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^planner$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Spawned before a reload/ })).toBeDefined()

      world.listed = [{ id: 'a1', type: 'Explore', description: 'Survey the repo', status: 'completed' }, ...world.listed.slice(1)]
      await world.clock.advance(1000)
      expect(await ui.find({ type: 'Text', text: /1 active · 1 finished/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^done in 6s$/ })).toBeDefined()
      await world.clock.advance(3000)
      expect(await ui.find({ type: 'Text', text: /^done in 6s$/ })).toBeDefined()
      await ui.unmount()
    })

    test('the main loop: chunks pass through, its model and phase show, mentions show as thoughts', async ($, on) => {
      const thinking = (text: string): TurnStepChunk => ({ kind: 'thinking', index: 0, text })
      const sent: TurnStepChunk[] = [
        thinking('Let me think. '),
        thinking('I could load the skill: graphify first. '),
        thinking('That runs a loop, then research. '),
        thinking('Not sure. '),
        thinking('Hmm. '),
        thinking('OK. '),
        thinking('Also /asd-ste100 for the wording.'),
        { kind: 'tool', index: 1, id: 'tu9', name: 'Read' },
      ]
      const world = engine(on, sent)
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await world.clock.settle()
      const seen: TurnStepChunk[] = []
      for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-1-20250805', messageCount: 1 })) {
        seen.push(chunk)
      }
      expect(seen).toEqual(sent)

      const pane = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await pane.find({ type: 'Text', text: /^Lead$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^opus 4\.1$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^reading · Read$/ })).toBeDefined()
      const band = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: BAND })
      expect(await band.find({ type: 'Text', text: /^◇ graphify$/ })).toBeDefined()
      expect(await band.find({ type: 'Text', text: /^◇ asd-ste100$/ })).toBeDefined()
      expect(await band.findAll({ type: 'Text', text: /◇/ })).toHaveLength(2)

      await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
      await pane.redraw()
      expect(await pane.find({ type: 'Text', text: /^waiting for your next message$/ })).toBeDefined()
      await pane.unmount()
      await band.unmount()
    })

    test('a subagent\'s thinking is not read for skills', async ($, on) => {
      const sent: TurnStepChunk[] = Array.from({ length: 7 }, (): TurnStepChunk => ({ kind: 'thinking', index: 0, text: 'use /graphify. ' }))
      engine(on, sent)
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await $.agent.spawn(spawnInput({ description: 'Survey the repo', subagentType: 'Explore' }))
      for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' })) {
        expect(chunk.kind).toBe('thinking')
      }
      const band = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: BAND })
      expect(await band.find({ type: 'Text', text: /graphify/ })).toBeUndefined()
      expect(await band.find({ type: 'Button', key: 'agents' })).toBeDefined()
      await band.unmount()
    })

    test('auto mode sends the pick: the model with the spawn, the effort with each step', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      expect(world.spawned[0]?.model).toBe('claude-sonnet-5-5')
      await run($.turn.step(stepOf({ model: 'claude-sonnet-5-5', effort: 'medium', agentId: 'a1' })))
      expect(world.steps[0]?.effort).toBe('medium')

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      // The footer: the model with its number, the effort, the router's kind.
      expect(await ui.find({ type: 'Text', text: /^sonnet 5\.5 · medium · lookup$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^⇄ sonnet 5\.5 · medium — lookup: Explore, read-only, find$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a step with no effort (a model that takes none) is sent as it came', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await run($.turn.step(stepOf({ model: 'claude-haiku-4-5', agentId: 'a1' })))
      expect(world.steps[0]).not.toHaveProperty('effort')
    })

    test('the main loop is never routed', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await run($.turn.step(stepOf({ effort: 'xhigh' })))
      expect(world.steps[0]?.effort).toBe('xhigh')
    })

    test('suggest mode shows the pick and changes nothing', async ($, on) => {
      const world = engine(on)
      await $.command.run(radarArgs('mode suggest'))
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      expect(world.spawned[0]?.model).toBeUndefined()
      await run($.turn.step(stepOf({ effort: 'medium', agentId: 'a1' })))
      expect(world.steps[0]?.effort).toBe('medium')

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^⇢ would use sonnet 5\.5 · medium — lookup: Explore, read-only, find$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^routing suggest$/ })).toBeDefined()
      await ui.unmount()
    })

    test('off mode does nothing and shows no pick', async ($, on) => {
      const world = engine(on)
      await $.command.run(radarArgs('mode off'))
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      expect(world.spawned[0]?.model).toBeUndefined()
      await run($.turn.step(stepOf({ effort: 'medium', agentId: 'a1' })))
      expect(world.steps[0]?.effort).toBe('medium')

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^routing off$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /lookup:/ })).toBeUndefined()
      await ui.unmount()
    })

    test('a custom agent and a fork are kept as they are defined', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK, provider: { plugin: 'acme', tier: 'user' } }))
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK, description: 'A fork', fork: true }))
      expect(world.spawned.map(one => one.model)).toEqual([undefined, undefined])
      await run($.turn.step(stepOf({ effort: 'high', agentId: 'a1' })))
      expect(world.steps[0]?.effort).toBe('high')

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^· custom agent, kept as defined$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^· a fork inherits its parent$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a delegate builder tagged hard spawns on opus, and its steps are raised to high, never lowered', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput(roleAsk('builder', 'hard')))
      expect(world.spawned[0]?.model).toBe('opus')
      await run($.turn.step(stepOf({ model: 'claude-opus-5-5', effort: 'medium', agentId: 'a1' })))
      expect(world.steps[0]?.effort).toBe('high')
      await run($.turn.step(stepOf({ index: 1, model: 'claude-opus-5-5', effort: 'xhigh', agentId: 'a1' })))
      expect(world.steps[1]?.effort).toBe('xhigh')

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^⇄ opus · high — delegate role, tagged hard: opus$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a delegate builder tagged routine, and one in suggest mode, keep their own model and effort', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput(roleAsk('builder', 'routine')))
      await $.command.run(radarArgs('mode suggest'))
      await $.agent.spawn(spawnInput({ ...roleAsk('builder', 'hard'), description: 'Prove the bound' }))
      expect(world.spawned.map(one => one.model)).toEqual([undefined, undefined])
      await run($.turn.step(stepOf({ effort: 'medium', agentId: 'a1' })))
      await run($.turn.step(stepOf({ effort: 'medium', agentId: 'a2' })))
      expect(world.steps.map(one => one.effort)).toEqual(['medium', 'medium'])

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^· custom agent, kept as defined$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^⇢ would use opus · high — delegate role, tagged hard: opus$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a model the call names stays, and the effort is still picked', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput({ description: 'Plan the endpoint', subagentType: 'Plan', prompt: 'Outline the steps.', model: 'opus' }))
      expect(world.spawned[0]?.model).toBe('opus')
      await run($.turn.step(stepOf({ model: 'claude-opus-4-1', effort: 'medium', agentId: 'a1' })))
      expect(world.steps[0]?.effort).toBe('high')

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /model as set · high — careful: Plan · model set by the call/ })).toBeDefined()
      await ui.unmount()
    })

    test('a first step that comes before the spawn answers still gets its effort', async ($, on) => {
      const world = engine(on, TEXT_STEP, {
        beforeAnswer: () => run($.turn.step(stepOf({ model: 'claude-haiku-4-5', effort: 'high', agentId: 'a1' }))),
      })
      world.listed = [{ id: 'a1', type: 'Explore', description: LOOKUP_ASK.description, status: 'running' }]
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      expect(world.steps[0]?.effort).toBe('medium')
      await run($.turn.step(stepOf({ model: 'claude-haiku-4-5', effort: 'high', agentId: 'a1' })))
      expect(world.steps[1]?.effort).toBe('medium')
    })

    test('the ceiling "session" holds a hard task to the session\'s model and effort', async ($, on) => {
      const world = engine(on)
      await run($.turn.step(stepOf({ effort: 'medium' })))
      await $.command.run(radarArgs('ceiling session'))
      await $.agent.spawn(spawnInput({ ...HARD_ASK }))
      expect(world.spawned[0]?.model).toBe('claude-sonnet-5-5')
      await run($.turn.step(stepOf({ effort: 'high', agentId: 'a1' })))
      expect(world.steps.at(-1)?.effort).toBe('medium')
    })

    test('three failed tool calls raise the effort a level, and the card says so', async ($, on) => {
      const world = engine(on, TEXT_STEP, { isRefusingTools: true })
      await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', description: 'Add pagination', prompt: 'Implement pagination.' }))
      await run($.turn.step(stepOf({ effort: 'medium', agentId: 'a1' })))
      expect(world.steps[0]?.effort).toBe('medium')
      for (let call = 0; call < 3; call += 1) {
        await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'a1' } as never)
      }
      await run($.turn.step(stepOf({ index: 1, effort: 'medium', agentId: 'a1' })))
      expect(world.steps[1]?.effort).toBe('high')

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^⇄ sonnet 5\.5 · medium — routine: no hard signals · raised to high$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a long run raises the effort a level at 12 steps', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await run($.turn.step(stepOf({ index: 12, model: 'claude-haiku-4-5', effort: 'low', agentId: 'a1' })))
      expect(world.steps[0]?.effort).toBe('high')
    })

    test('a tagged spawn takes the tag over the cues', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(
        spawnInput({ subagentType: 'general-purpose', description: 'Fix the cache', prompt: '[difficulty: deep] Fix the eviction bug.' }),
      )
      expect(world.spawned[0]?.model).toBe('opus')
      await run($.turn.step(stepOf({ model: 'claude-opus-5-5', effort: 'medium', agentId: 'a1' })))
      expect(world.steps[0]?.effort).toBe('xhigh')

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^⇄ opus · xhigh — tagged: deep$/ })).toBeDefined()
      await ui.unmount()
    })

    test('each response\'s tokens show on the card and add up by route kind; the main loop\'s do not', async ($, on) => {
      engine(on, STEP_WITH_USAGE)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await run($.turn.step(stepOf({ model: 'claude-haiku-4-5', agentId: 'a1' })))
      await run($.turn.step(stepOf({ index: 0 })))

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^6\.5k tok$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^subagent tokens 6\.5k · lookup 6\.5k$/ })).toBeDefined()

      await run($.turn.step(stepOf({ index: 1, model: 'claude-haiku-4-5', agentId: 'a1' })))
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /^13k tok$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^subagent tokens 13k · lookup 13k$/ })).toBeDefined()
      await ui.unmount()
    })

    test('a call that waits for approval shows on the card and the band, with one toast, until it settles', async ($, on) => {
      const gate = deferred()
      const world = engine(on, TEXT_STEP, {
        checkDecision: 'ask',
        duringToolCall: async call => {
          await $.tool.check({ tool: call.tool, input: {}, tool_use_id: call.tool_use_id } as never)
          await gate.promise
        },
      })
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      const pending = $.tool.call({ tool: 'Bash', command: 'make clean', tool_use_id: 'tu-9', agentId: 'a1' } as never)
      await world.clock.advance(3000)

      expect(world.toasts).toEqual(['Explore needs your approval: Bash'])
      const pane = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await pane.find({ type: 'Text', text: /^ needs approval $/ })).toBeDefined()
      const band = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: BAND })
      expect(await band.find({ type: 'Text', text: /^! Explore needs you$/ })).toBeDefined()

      gate.resolve()
      await pending
      await pane.redraw()
      await band.redraw()
      expect(await pane.find({ type: 'Text', text: /needs approval/ })).toBeUndefined()
      expect(await band.find({ type: 'Text', text: /needs you/ })).toBeUndefined()
      await pane.unmount()
      await band.unmount()
    })

    test('an ask that settles at once (an auto mode, an allow rule) shows nothing', async ($, on) => {
      const world = engine(on, TEXT_STEP, {
        checkDecision: 'ask',
        duringToolCall: async call => {
          await $.tool.check({ tool: call.tool, input: {}, tool_use_id: call.tool_use_id } as never)
        },
      })
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu-1', agentId: 'a1' } as never)
      await world.clock.advance(3000)
      expect(world.toasts).toEqual([])
      const pane = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await pane.find({ type: 'Text', text: /needs approval/ })).toBeUndefined()
      await pane.unmount()
    })

    test('two live agents that edit the same file raise one warning and one toast', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await $.agent.spawn(spawnInput({ subagentType: 'Plan', description: 'Plan the fix', prompt: 'Outline it.' }))
      await $.tool.call({ tool: 'Edit', file_path: '/repo/src/App.ts', agentId: 'a1' } as never)
      expect(world.toasts).toEqual([])
      await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', agentId: 'a2' } as never)
      await $.tool.call({ tool: 'Write', file_path: '/repo/src/app.ts', agentId: 'a1' } as never)
      expect(world.toasts).toEqual(['2 subagents edited app.ts: Explore, Plan'])

      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^▲ app\.ts — edited by Explore, Plan$/ })).toBeDefined()
      await ui.unmount()
    })

    test('an agent that edits a file after the first one ended is no clash', async ($, on) => {
      const world = engine(on)
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', agentId: 'a1' } as never)
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
      await $.agent.spawn(spawnInput({ subagentType: 'Plan', description: 'Plan the fix', prompt: 'Outline it.' }))
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', agentId: 'a2' } as never)
      expect(world.toasts).toEqual([])
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /^▲/ })).toBeUndefined()
      await ui.unmount()
    })
  })
}

describe('session', () => {
  test('the radar command and the first spawn open the pane, once', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(world.commands).toEqual(['radar'])
    expect(world.opened).toEqual([])
    await $.agent.spawn(spawnInput({ description: 'First', subagentType: 'Explore' }))
    await $.agent.spawn(spawnInput({ description: 'Second', subagentType: 'Plan' }))
    expect(world.opened).toEqual([{ id: 'agents', title: 'Team' }])
  })

  test('/radar opens the pane at any width', async ($, on) => {
    const world = engine(on)
    const ran = await $.command.run(radarArgs(''))
    expect(ran.text).toBe('Agent radar opened.')
    expect(world.opened).toEqual([{ id: 'agents', title: 'Team' }])
  })

  test('/radar mode and /radar ceiling change the router and say so', async ($, on) => {
    const world = engine(on)
    expect((await $.command.run(radarArgs('mode suggest'))).text).toBe('Routing: mode suggest, ceiling raise, models sonnet and opus only.')
    expect((await $.command.run(radarArgs('ceiling session'))).text).toBe('Routing: mode suggest, ceiling session, models sonnet and opus only.')
    expect((await $.command.run(radarArgs('mode off'))).text).toBe('Routing: mode off.')
    const status = (await $.command.run(radarArgs('status'))).text ?? ''
    expect(status.startsWith('Routing: mode off. Usage:')).toBe(true)
    const bad = (await $.command.run(radarArgs('mode loud'))).text ?? ''
    expect(bad.startsWith('Usage:')).toBe(true)
    expect(world.opened).toEqual([])
  })

  test('learning: past struggles on disk raise the pick, and the pane says so', async ($, on) => {
    const world = engine(on)
    world.store.set('outcomes:old', STRUGGLING_LOOKUPS)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    expect(world.spawned[0]?.model).toBe('claude-sonnet-5-5')
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await ui.find({ type: 'Text', text: /^learned: lookup raised$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /learned: raised/ })).toBeDefined()
    await ui.unmount()
  })

  test('learning: an agent\'s end is saved under this session\'s key, with no text', async ($, on) => {
    const world = engine(on, STEP_WITH_USAGE)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', description: 'Add pagination', prompt: 'Implement it.' }))
    await run($.turn.step(stepOf({ agentId: 'a1', effort: 'medium' })))
    await $.turn.complete({ answer: 'Secret answer text', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    const saved = world.store.get('outcomes:s1')
    expect(saved).toEqual([{ kind: 'routine', struggled: false, wasRaised: false, tokens: 6500, at: expect.any(Number), tier: 'sonnet', effort: 'medium', billed: 2875 }])
    expect(JSON.stringify(saved)).not.toContain('Secret')
    expect(JSON.stringify(saved)).not.toContain('pagination')
    const stats = (await $.command.run(radarArgs('stats'))).text ?? ''
    expect(stats.startsWith('routine: 1 runs, 0% struggled, about 6.5k tokens each')).toBe(true)
    expect(stats).toContain('This session: subagent tokens 6.5k · routine 6.5k.')
  })

  test('learning: a stopped agent teaches nothing', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted', agentId: 'a1' })
    expect(world.store.has('outcomes:s1')).toBe(false)
  })

  test('a finished agent that steps or calls again was resumed: it is back at work, and its second end teaches nothing more', async ($, on) => {
    const world = engine(on, STEP_WITH_USAGE)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', description: 'Add pagination', prompt: 'Implement it.' }))
    await run($.turn.step(stepOf({ agentId: 'a1', effort: 'medium' })))
    await $.turn.complete({ answer: 'first', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    expect(world.store.get('outcomes:s1')).toHaveLength(1)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await ui.find({ type: 'Text', text: /^done in / })).toBeDefined()
    // SendMessage resumes it: its next step puts it back at its desk, live, with no "done" card.
    await run($.turn.step(stepOf({ agentId: 'a1', index: 1 })))
    await world.clock.advance(300)
    expect(await ui.find({ type: 'Text', text: /^done in / })).toBeUndefined()
    // A call by a resumed agent is work too.
    await $.turn.complete({ answer: 'second', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    expect(await ui.find({ type: 'Text', text: /^done in / })).toBeDefined()
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts', agentId: 'a1' } as never)
    await world.clock.advance(300)
    expect(await ui.find({ type: 'Text', text: /^done in / })).toBeUndefined()
    // A list that has not caught up and still calls it finished does not end it again at once.
    world.listed = [{ id: 'a1', type: 'general-purpose', description: 'Add pagination', status: 'completed' }]
    await world.clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: /^done in / })).toBeUndefined()
    world.listed = []
    await $.turn.complete({ answer: 'third', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    // Three ends, one lesson.
    expect(world.store.get('outcomes:s1')).toHaveLength(1)
    await ui.unmount()
  })

  test('a stopped agent is not revived by a late call: only the list can bring it back', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted', agentId: 'a1' })
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts', agentId: 'a1' } as never)
    await run($.turn.step(stepOf({ agentId: 'a1', index: 1 })))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await ui.find({ type: 'Text', text: /^stopped in / })).toBeDefined()
    await ui.unmount()
  })

  test('learning: /radar learn off ignores the lessons, and reset forgets them', async ($, on) => {
    const world = engine(on)
    world.store.set('outcomes:old', STRUGGLING_LOOKUPS)
    world.store.set('other-key', 'kept')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()

    expect((await $.command.run(radarArgs('learn off'))).text).toBe('Routing: mode auto, ceiling raise, models sonnet and opus only, learning off.')
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    expect(world.spawned[0]?.model).toBe('claude-sonnet-5-5')

    await $.command.run(radarArgs('learn on'))
    expect((await $.command.run(radarArgs('learn reset'))).text).toBe(
      'Forgot past outcomes from 1 session. Picks are back to the rules alone.',
    )
    expect([...world.store.keys()]).toEqual(['other-key'])
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK, description: 'Find it again' }))
    expect(world.spawned[1]?.model).toBe('claude-sonnet-5-5')
  })

  test('learning: only the newest 30 sessions stay on disk', async ($, on) => {
    const world = engine(on)
    for (let session = 0; session < 33; session += 1) {
      world.store.set(`outcomes:x${session}`, [outcome({ at: session })])
    }
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    const left = [...world.store.keys()].filter(key => key.startsWith('outcomes:'))
    expect(left).toHaveLength(30)
    expect(left).not.toContain('outcomes:x0')
    expect(left).toContain('outcomes:x32')
  })

  test('the terminal office repaints by blit while someone works, and stops with motion off', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    await run($.turn.step(stepOf({ agentId: 'a1' })))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    await world.clock.advance(1000)
    expect(world.blits.length).toBeGreaterThanOrEqual(2)
    expect(world.blits[0]).toMatchObject({ requestId: 'agents', key: 'office' })

    await $.command.run(radarArgs('motion off'))
    await ui.redraw()
    const before = world.blits.length
    await world.clock.advance(1000)
    expect(world.blits.length).toBe(before)
    await ui.unmount()
  })

  test('the desktop office needs no repaint: its SVG moves by itself', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await world.clock.settle()
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'desktop', component: 'Pane', requestId: 'agents', props: PANE })
    await world.clock.advance(1000)
    expect(world.blits).toEqual([])
    await ui.unmount()
  })

  test('view switches are saved on disk and come back in the next session', async ($, on) => {
    const world = engine(on)
    await $.command.run(radarArgs('labels off'))
    expect(world.store.get('view')).toEqual({ layout: 'both', labels: false, motion: true, details: true, sessions: true })
  })

  test('saved view switches load at the start', async ($, on) => {
    const world = engine(on)
    world.store.set('view', { layout: 'cards', labels: true, motion: false })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await ui.find({ type: 'Raster', key: 'office' })).toBeUndefined()
    await ui.unmount()
  })

  test('an effort the Agent call names stays, and the model is still picked', async ($, on) => {
    const world = engine(on, TEXT_STEP, {
      duringToolCall: async call => {
        if (call.tool === 'Agent') await $.agent.spawn(spawnInput({ ...LOOKUP_ASK, tool_use_id: call.tool_use_id ?? 'tu' }))
      },
    })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tu-agent', effort: 'high', description: LOOKUP_ASK.description, prompt: LOOKUP_ASK.prompt } as never)
    expect(world.spawned[0]?.model).toBe('claude-sonnet-5-5')
    await run($.turn.step(stepOf({ effort: 'medium', agentId: 'a1' })))
    expect(world.steps[0]?.effort).toBe('medium')
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await ui.find({ type: 'Text', text: /effort set by the call/ })).toBeDefined()
    await ui.unmount()
  })

  test('a gauntlet competitor (delegate builder, hard tag, model and effort in the call) runs as the call says', async ($, on) => {
    const ask = { ...roleAsk('builder', 'hard'), model: 'sonnet' }
    const world = engine(on, TEXT_STEP, {
      duringToolCall: async call => {
        if (call.tool === 'Agent') await $.agent.spawn(spawnInput({ ...ask, tool_use_id: call.tool_use_id ?? 'tu' }))
      },
    })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tu-agent', effort: 'high', model: 'sonnet', description: ask.description, prompt: ask.prompt } as never)
    expect(world.spawned[0]?.model).toBe('sonnet')
    await run($.turn.step(stepOf({ effort: 'high', agentId: 'a1' })))
    expect(world.steps[0]?.effort).toBe('high')
    // The card clips the line to its width: its start is enough to tell.
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await ui.find({ type: 'Text', text: /^⇄ model as set — delegate role, tagged hard: opus · model set/ })).toBeDefined()
    await ui.unmount()
  })

  test('a denied spawn makes no row and opens nothing', async ($, on) => {
    const opened: PaneOpenArgs[] = []
    mock.clock(on)
    on('agent.spawn', () => ({ deny: 'no' }))
    on('ui.open', (_$, e) => {
      opened.push(e)

      return { value: { isPlaced: true } }
    })
    const started = await $.agent.spawn(spawnInput({ description: 'First', subagentType: 'Explore' }))
    expect(started.deny).toBe('no')
    expect(opened).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Other sessions: the file each session writes for the others, and what a pane makes of theirs.
// ---------------------------------------------------------------------------

const IDLE_LEAD: MainState = { model: '', phase: 'idle' }
const BUSY_LEAD: MainState = { model: 'claude-opus-5-5', effort: 'high', phase: 'thinking' }
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** Another session's file, as that session's own writer makes it. */
const peerFile = (fields: Partial<LiveInput> & Pick<LiveInput, 'id' | 'now'>): LiveFile =>
  liveFileOf({ every: 2000, project: 'token-usage-mod', rows: [], lead: IDLE_LEAD, active: fields.now, ...fields })

/** Puts another session's file on the test disk, as if that session had just written it. */
function putPeer(world: World, file: LiveFile): void {
  world.disk.set(`${LIVE}/${file.id}.json`, { text: JSON.stringify(file), mtimeMs: world.clock.now() })
}

/** What this session last wrote of itself. */
const ownFile = (world: World): LiveFile | undefined => parseLiveFile(world.disk.get(OWN)?.text ?? '')

/** Every write of this session's own file, in order. */
const ownWrites = (world: World): string[] =>
  world.fsCalls.filter(call => call.op === 'write' && call.path === OWN).map(call => call.text ?? '')

/** What the other sessions' building says: its alt on desktop, the text in its cells in the terminal. */
async function buildingText(ui: Pick<Mounted<RenderSurface, 'Pane'>, 'find' | 'findAll'>, surface: string): Promise<string | undefined> {
  if (surface === 'terminal') {
    const raster = await ui.find({ type: 'Raster', key: 'building' })
    if (raster === undefined) return undefined
    const bytes = Uint8Array.from(atob(String(raster.props.cells)), ch => ch.charCodeAt(0))
    const view = new DataView(bytes.buffer)
    let text = ''
    for (let at = 0; at + 12 <= bytes.length; at += 12) text += String.fromCodePoint(view.getUint32(at, true))
    return text.replace(/\u2580/g, ' ').replace(/\s+/g, ' ').trim()
  }
  const svg = (await ui.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('Building: '))
  return svg === undefined ? undefined : String(svg.props.alt)
}

/** The item at `index`, which the test knows is there. */
function nth<T>(list: readonly T[], index: number): T {
  const item = list[index]
  if (item === undefined) throw new Error(`nothing at ${index}`)
  return item
}

describe('other sessions', () => {
  test('a file name never leads out of the live folder', () => {
    expect(liveFileName('3f2a9c1e-7d4b-4a8e-9f00-1234567890ab')).toBe('3f2a9c1e-7d4b-4a8e-9f00-1234567890ab.json')
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(101)]) expect(liveFileName(bad)).toBeUndefined()
    expect(liveDirOf('/home/user/')).toBe(LIVE)
    expect(projectName('/home/user/project/')).toBe('project')
    expect(projectName('/')).toBe('session')
    expect(isBusy([], IDLE_LEAD)).toBe(false)
    expect(isBusy([row()], IDLE_LEAD)).toBe(true)
    expect(isBusy([row({ status: 'completed' })], IDLE_LEAD)).toBe(false)
    expect(isBusy([], BUSY_LEAD)).toBe(true)
  })

  test('between turns the Lead is idle with no turn open', () => {
    expect(settledLead(IDLE_LEAD)).toBe(IDLE_LEAD)
    expect(settledLead({ ...BUSY_LEAD, turnId: 't1', tool: 'Bash' })).toEqual({ model: 'claude-opus-5-5', effort: 'high', phase: 'idle', tool: 'Bash' })
    // What 0.8.0 left after a call raised outside any turn: "thinking", no model, no turn.
    expect(settledLead({ model: '', phase: 'thinking' })).toEqual({ model: '', phase: 'idle' })
  })

  test('the file holds what the cards show: calls with a short argument and file base names, never an answer', () => {
    const rows = [
      row({
        id: 'a1',
        description: 'Find the config loader',
        model: 'claude-haiku-5-5',
        effort: 'low',
        phase: 'tool',
        tool: 'Grep',
        detail: 'loadConfig',
        doing: 'Searching "loadConfig"',
        tokens: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 },
        startedAt: 1000,
        tools: 3,
        trail: [{ tool: 'Grep', detail: 'loadConfig' }, { tool: 'Bash', detail: 'x'.repeat(90) }],
        toolCounts: { Grep: 2, Bash: 1 },
        files: ['/private/path/edited.ts'],
        reads: ['/private/path/read.ts', '/private/path/other.ts'],
        route: { kind: 'lookup', model: 'haiku', effort: 'low', why: 'lookup: Explore, find', isApplied: true },
      }),
      row({
        id: 'a2',
        type: 'mcp-thing',
        status: 'completed',
        phase: 'done',
        doing: 'ANSWER-SECRET in the answer line',
        answer: 'ANSWER-SECRET in full',
        startedAt: 2000,
        endedAt: 9000,
        tool: 'mcp__github__create_issue',
        detail: 'github · create_issue',
        needs: { tool: 'Bash', since: 3000 },
      }),
    ]
    const lead: MainState = { ...BUSY_LEAD, phase: 'tool', tool: 'mcp__chat__post', detail: 'chat · post', context: 5000, window: 200_000 }
    const file = liveFileOf({ id: 's1', now: 10_000, every: 2000, project: 'agent-radar', rows, lead, spend: { lookup: { tokens: 6500, agents: 1 } } })
    expect(file).toEqual({
      v: 1,
      id: 's1',
      beat: 10_000,
      every: 2000,
      project: 'agent-radar',
      lead: {
        phase: 'tool',
        model: 'claude-opus-5-5',
        effort: 'high',
        tool: 'MCP',
        call: { tool: 'mcp__chat__post', detail: 'chat · post' },
        context: 5000,
        window: 200_000,
      },
      agents: [
        {
          label: 'Explore',
          role: 'explore',
          activity: 'reading',
          tool: 'Grep',
          model: 'claude-haiku-5-5',
          effort: 'low',
          startedAt: 1000,
          tokens: 6500,
          description: 'Find the config loader',
          id: 'a1',
          type: 'Explore',
          status: 'running',
          phase: 'tool',
          doing: 'Searching "loadConfig"',
          call: { tool: 'Grep', detail: 'loadConfig' },
          tools: 3,
          tokenCounts: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 },
          seat: 1,
          files: ['edited.ts'],
          reads: 2,
          trail: [{ tool: 'Grep', detail: 'loadConfig' }, { tool: 'Bash', detail: `${'x'.repeat(59)}…` }],
          toolCounts: { Grep: 2, Bash: 1 },
          route: { kind: 'lookup', model: 'haiku', effort: 'low', why: 'lookup: Explore, find', isApplied: true },
        },
        {
          label: 'Mcp-thing',
          role: 'other',
          activity: 'done',
          startedAt: 2000,
          endedAt: 9000,
          tokens: 0,
          description: 'Survey the repo',
          id: 'a2',
          type: 'mcp-thing',
          status: 'completed',
          phase: 'done',
          doing: 'finished',
          call: { tool: 'mcp__github__create_issue', detail: 'github · create_issue' },
          tools: 0,
          seat: 0,
        },
      ],
      spend: { lookup: 6500, routine: 0, careful: 0, hard: 0 },
    })
    // An answer never goes in, nor a full path: only a file's base name.
    expect(JSON.stringify(file)).not.toContain('ANSWER-SECRET')
    expect(JSON.stringify(file)).not.toContain('/private/path')
    expect(parseLiveFile(JSON.stringify(file))).toEqual(file)
  })

  test('the file keeps a whole wave of 8 finished agents past the office, and 24 full agents stay under the read limit', () => {
    const long = (n: number, tag: string): string => `${tag}-${'x'.repeat(n)}`
    const full = (i: number, fields: Partial<AgentRow>): AgentRow =>
      row({
        id: `agent-${String(i).padStart(2, '0')}-${'f'.repeat(50)}`,
        type: long(60, 'type'),
        name: long(60, 'name'),
        description: long(120, `task ${i}`),
        model: 'claude-opus-5-5',
        effort: 'high',
        phase: 'tool',
        tool: long(60, 'mcp__tool'),
        detail: long(120, 'detail'),
        doing: long(120, 'doing'),
        tokens: { input: 9_999_999, output: 9_999_999, cacheRead: 99_999_999, cacheWrite: 9_999_999 },
        context: 999_999,
        tools: 9999,
        errors: 999,
        steps: 9999,
        trail: Array.from({ length: 5 }, (_, k) => ({ tool: long(60, `t${k}`), detail: long(120, `d${k}`) })),
        toolCounts: Object.fromEntries(Array.from({ length: 25 }, (_, k) => [`Tool${k}${'y'.repeat(30)}`, 999])),
        files: Array.from({ length: 30 }, (_, k) => `/a/${long(90, `file${k}`)}.ts`),
        reads: Array.from({ length: 50 }, (_, k) => `/r/${k}.ts`),
        needs: { tool: long(60, 'Bash'), since: 1 },
        route: { kind: 'hard', model: 'opus', effort: 'high', maxEffort: 'xhigh', why: long(200, 'why'), isApplied: true },
        parentId: `parent-${'p'.repeat(70)}`,
        background: true,
        ...fields,
      })
    const live = Array.from({ length: 4 }, (_, i) => full(i, { startedAt: 1000 + i }))
    const done = Array.from({ length: 20 }, (_, i) =>
      full(10 + i, { status: 'completed', phase: 'done', startedAt: 2000 + i, endedAt: 50_000 + i * 100 }),
    )
    const file = liveFileOf({ id: 's1', now: 100_000, every: 2000, project: 'gauntlet', rows: [...live, ...done], lead: BUSY_LEAD })
    const short = (id: string | undefined): string => (id ?? '').slice(0, 8)
    // The 4 live agents, then the newest 16 finished, newest first: more than the office's 6.
    expect(file.agents.map(agent => short(agent.id))).toEqual([...live, ...done.slice(4).reverse()].map(agent => short(agent.id)))
    // The 6 newest finished have cards on another floor and keep their details; the older 10 go in brief.
    const finished = file.agents.slice(4)
    for (const agent of finished.slice(0, 6)) expect([agent.trail, agent.files, agent.toolCounts, agent.call, agent.route].every(Boolean)).toBe(true)
    for (const agent of finished.slice(6)) {
      expect([agent.trail, agent.files, agent.toolCounts, agent.call, agent.route]).toEqual([undefined, undefined, undefined, undefined, undefined])
      expect(agent).toMatchObject({ description: expect.stringContaining('task'), status: 'completed', tokenCounts: { input: 9_999_999 } })
    }
    const bytes = (it: LiveFile): number => new TextEncoder().encode(JSON.stringify(it)).length
    // A gauntlet wave: 8 live and 16 finished with the usual calls, all 24 in, well under the 64 KB a reader takes.
    const usual = (i: number, fields: Partial<AgentRow>): AgentRow =>
      row({
        id: `agent-${i}`,
        type: 'delegate:builder',
        description: `Gauntlet competitor ${String.fromCharCode(65 + (i % 8))}`,
        model: 'claude-opus-5-5',
        effort: 'high',
        tokens: { input: 90_000, output: 20_000, cacheRead: 900_000, cacheWrite: 60_000 },
        trail: Array.from({ length: 5 }, (_, k) => ({ tool: 'Write', detail: `/runs/20261014-181459/solutions/${k}.md` })),
        toolCounts: { Read: 6, Write: 3, Bash: 2 },
        files: ['/runs/20261014-181459/solutions/A.md'],
        route: { kind: 'hard', model: 'opus', effort: 'high', why: 'hard: tagged hard', isApplied: true },
        ...fields,
      })
    const wave = liveFileOf({
      id: 's1',
      now: 100_000,
      every: 2000,
      project: 'gauntlet',
      rows: [
        ...Array.from({ length: 8 }, (_, i) => usual(i, { startedAt: 60_000 + i })),
        ...Array.from({ length: 16 }, (_, i) => usual(10 + i, { status: 'completed', phase: 'done', startedAt: 1000 + i, endedAt: 30_000 + i })),
      ],
      lead: BUSY_LEAD,
    })
    expect(wave.agents).toHaveLength(24)
    expect(bytes(wave)).toBeLessThan(32 * 1024)
    // 24 live agents with every field at its cap would pass 64 KB: the last ones are left out, so a reader still takes it.
    const crowdRows = Array.from({ length: 24 }, (_, i) => full(40 + i, { startedAt: 3000 + i }))
    const crowd = liveFileOf({ id: 's1', now: 100_000, every: 2000, project: 'gauntlet', rows: crowdRows, lead: BUSY_LEAD })
    expect(crowd.agents.length).toBeGreaterThan(10)
    expect(crowd.agents.length).toBeLessThan(24)
    expect(crowd.agents.map(agent => short(agent.id))).toEqual(crowdRows.slice(0, crowd.agents.length).map(agent => short(agent.id)))
    expect(bytes(crowd)).toBeLessThanOrEqual(64 * 1024)
    const oneMore = liveFileOf({ id: 's1', now: 100_000, every: 2000, project: 'gauntlet', rows: crowdRows.slice(0, crowd.agents.length + 1), lead: BUSY_LEAD })
    expect(oneMore.agents).toHaveLength(crowd.agents.length)
    expect(parseLiveFile(JSON.stringify(crowd))?.agents).toHaveLength(crowd.agents.length)
  })

  test('a file reads back as written; anything malformed is dropped and anything hostile cleaned', () => {
    const file = peerFile({ id: 's2', now: 5000, project: 'mod-dock', label: 'Dock work', rows: [row({ startedAt: 1000 })], lead: BUSY_LEAD })
    expect(parseLiveFile(JSON.stringify(file))).toEqual(file)
    for (const bad of ['not json', '[]', 'null', '7']) expect(parseLiveFile(bad)).toBeUndefined()
    expect(parseLiveFile(JSON.stringify({ ...file, v: 2 }))).toBeUndefined()
    expect(parseLiveFile(JSON.stringify({ ...file, id: '../evil' }))).toBeUndefined()
    expect(parseLiveFile(JSON.stringify({ ...file, beat: 'soon' }))).toBeUndefined()
    expect(parseLiveFile(JSON.stringify({ ...file, lead: null }))).toBeUndefined()
    const hostile = parseLiveFile(
      JSON.stringify({
        ...file,
        label: `bad${ESC}[31mred${BEL}\nand a name far too long for one line of any pane`,
        every: 1,
        agents: [
          { label: 'x', role: 'wizard', activity: 'hacking', startedAt: 0, tokens: -5, description: 7 },
          { role: 'explore', activity: 'reading', startedAt: 0 },
          'junk',
        ],
      }),
    )
    const label = hostile?.label ?? ''
    expect(label.startsWith('bad [31mred and a name')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(40)
    expect([...label].some(char => (char.codePointAt(0) ?? 0) < 32)).toBe(false)
    expect(hostile?.every).toBe(5000)
    expect(hostile?.agents).toEqual([{ label: 'x', role: 'other', activity: 'working', startedAt: 0, tokens: 0, description: '' }])
    expect(cleanText(`a${String.fromCharCode(8238)}b`, 10)).toBe('a b')
    expect(cleanText(42, 10)).toBe('')
  })

  test('the others: this session, closed and silent ones left out; working first, then by last activity; old idle hidden', () => {
    const now = 10_000_000
    const HOUR = 3_600_000
    const idleFile = (id: string, project: string, active: number): LiveFile => peerFile({ id, now: now - 3000, every: 5000, project, active })
    const files = [
      peerFile({ id: 's1', now, project: 'agent-radar', rows: [row({ startedAt: now - 5000 })] }),
      peerFile({ id: 'sw', now: now - 1000, rows: [row({ startedAt: now - 185_000, phase: 'tool', tool: 'Grep' })] }),
      idleFile('si', 'delegate', now - 30 * 60_000),
      idleFile('sj', 'older', now - 90 * 60_000),
      // The cutoff: exactly 2 h idle is hidden, a millisecond less is not.
      idleFile('so', 'stale', now - 2 * HOUR),
      idleFile('sk', 'edge', now - 2 * HOUR + 1),
      idleFile('sn', 'nothing', 0),
      // No heartbeat for 21 s: closed, though it said it was working. 19 s is still alive.
      peerFile({ id: 'sg', now: now - 21_000, project: 'gone', rows: [row({ startedAt: now - 60_000 })] }),
      peerFile({ id: 'sa', now: now - 19_000, project: 'alive', rows: [row({ startedAt: now - 60_000 })] }),
      { ...peerFile({ id: 'sc', now: now - 1000, project: 'closed', rows: [row({ startedAt: now - 9000 })] }), closed: true },
    ]
    const list = peerSessionsOf(files, 's1', now)
    expect(list.map(one => [one.name, one.state, one.hiddenBy])).toEqual([
      ['token-usage-mod', 'working', undefined],
      ['alive', 'working', undefined],
      ['delegate', 'idle', undefined],
      ['older', 'idle', undefined],
      ['edge', 'idle', undefined],
      ['stale', 'idle', 'idle'],
      ['nothing', 'idle', 'idle'],
    ])
    // A working floor is drawn at now; an idle one at its last activity.
    expect(nth(list, 0).asOf - (nth(list, 0).rows[0]?.startedAt ?? 0)).toBe(185_000)
    expect(nth(list, 2).asOf).toBe(now - 30 * 60_000)
    expect(peerLine(nth(list, 0), 1)).toBe('▸ 1 token-usage-mod · 1 working · Explore reading · Grep · 3m 05s')
    expect(peerLine(nth(list, 2), 3)).toBe('▸ 3 delegate · idle 30m')
    expect(peerLine(nth(list, 3), 4)).toBe('▸ 4 older · idle 1h 30m')
    expect(hiddenLine(list, 6)).toBe('+2 idle sessions hidden · /radar sessions all')
    // An opened one counts as shown.
    expect(hiddenLine(list, 6, new Set(['so']))).toBe('+1 idle session hidden · /radar sessions all')
    // `/radar sessions all` hides none; `/radar idle 0.25` hides more.
    expect(peerSessionsOf(files, 's1', now, { ...DEFAULT_PEER_OPTIONS, isAll: true }).filter(one => one.hiddenBy !== undefined)).toEqual([])
    const tight = peerSessionsOf(files, 's1', now, { ...DEFAULT_PEER_OPTIONS, idleMs: 0.25 * HOUR })
    expect(tight.filter(one => one.hiddenBy === 'idle').map(one => one.name)).toEqual(['delegate', 'older', 'edge', 'stale', 'nothing'])
    // Sessions in one folder share its name: a short id tells them apart.
    const twins = peerSessionsOf([peerFile({ id: 'abcd1', now, project: 'claude' }), peerFile({ id: 'wxyz2', now, project: 'claude' })], 's1', now)
    expect(twins.map(one => one.name)).toEqual(['claude #abcd', 'claude #wxyz'])
    // The newest file of one session wins.
    const both = [peerFile({ id: 'sx', now: now - 5000 }), peerFile({ id: 'sx', now, label: 'newer' })]
    expect(peerSessionsOf(both, 's1', now).map(one => one.name)).toEqual(['newer'])
  })

  test('the cap: working sessions first, then the most recently active; the rest wait on the +N line', () => {
    const now = 10_000_000
    const busy = (id: string, project: string, startedAt: number): LiveFile =>
      peerFile({ id, now, project, rows: [row({ startedAt })], active: startedAt })
    const idle = (id: string, project: string, active: number): LiveFile => peerFile({ id, now, every: 5000, project, active })
    const files = [
      idle('i1', 'idle-new', now - 60_000),
      idle('i2', 'idle-old', now - 50 * 60_000),
      busy('w1', 'busy-early', now - 600_000),
      idle('i3', 'idle-mid', now - 10 * 60_000),
      busy('w2', 'busy-late', now - 1000),
    ]
    const list = peerSessionsOf(files, 's1', now, { ...DEFAULT_PEER_OPTIONS, floors: 3 })
    expect(list.map(one => [one.name, one.hiddenBy])).toEqual([
      ['busy-late', undefined],
      ['busy-early', undefined],
      ['idle-new', undefined],
      ['idle-mid', 'cap'],
      ['idle-old', 'cap'],
    ])
    expect(hiddenLine(list, 3)).toBe('+2 more past the 3 floors · /radar floors <n> · /radar sessions all')
    // A working session outranks any idle one, however recent: with one floor, a busy one gets it.
    const one = peerSessionsOf(files, 's1', now, { ...DEFAULT_PEER_OPTIONS, floors: 1 })
    expect(one.filter(peer => peer.hiddenBy === undefined).map(peer => peer.name)).toEqual(['busy-late'])
    // No floors at all: everyone waits on the line.
    expect(peerSessionsOf(files, 's1', now, { ...DEFAULT_PEER_OPTIONS, floors: 0 }).every(peer => peer.hiddenBy === 'cap')).toBe(true)
  })

  test('the last activity: the writer\'s word, a change the reader saw, an agent\'s start or end; never past the beat', () => {
    const base = peerFile({ id: 's2', now: 100_000, active: 40_000, rows: [row({ status: 'completed', startedAt: 10_000, endedAt: 60_000 })] })
    expect(lastActiveOf(base)).toBe(60_000)
    expect(lastActiveOf(base, 90_000)).toBe(90_000)
    expect(lastActiveOf({ ...base, active: 500_000 })).toBe(100_000)
    expect(lastActiveOf({ ...base, active: undefined, agents: [] })).toBe(0)
    // A heartbeat changes nothing the print sees; a change of phase does.
    expect(livePrint({ ...base, beat: 200_000, every: 5000 })).toBe(livePrint(base))
    expect(livePrint({ ...base, lead: { phase: 'thinking' } })).not.toBe(livePrint(base))
  })

  test('the band counts the sessions at work, their agents, and who waits on the person', () => {
    const now = 50_000
    const list = peerSessionsOf(
      [
        peerFile({ id: 'sa', now, project: 'alpha', rows: [row({ startedAt: 1000 }), row({ id: 'a2', startedAt: 2000 })] }),
        peerFile({
          id: 'sb',
          now,
          project: 'beta',
          rows: [row({ id: 'b1', type: 'delegate:builder', startedAt: 1000, needs: { tool: 'Bash', since: 1000 } })],
        }),
        peerFile({ id: 'sc', now, project: 'gamma' }),
      ],
      's1',
      now,
    )
    expect(peerBandOf(list)).toEqual({ sessions: 2, agents: 3, waiting: ['Builder in beta'] })
    expect(peerBandWords(peerBandOf(list))).toBe('2 other sessions · 3 agents working')
    expect(peerBandWords({ sessions: 1, agents: 1, waiting: [] })).toBe('1 other session · 1 agent working')
    expect(peerLine(nth(list, 1), 2)).toBe('▸ 2 beta · 1 working · Builder waiting on you · Bash')
    expect(nth(list, 1).waiting).toBe(1)
  })

  test('another session reads back as the rows and Lead its own cards draw from', () => {
    const now = 100_000
    const rows = [
      row({ model: 'claude-haiku-5-5', effort: 'low', startedAt: 35_000, tokens: { input: 10_000, output: 2000, cacheRead: 0, cacheWrite: 0 }, background: true, seat: 2 }),
      row({ id: 'a2', type: 'Plan', status: 'completed', phase: 'done', startedAt: 10_000, endedAt: 40_000, seat: 1 }),
    ]
    const peer = nth(peerSessionsOf([peerFile({ id: 'sa', now, project: 'alpha', lead: BUSY_LEAD, rows })], 's1', now), 0)
    expect(peer.lead).toEqual({ model: 'claude-opus-5-5', effort: 'high', phase: 'thinking' })
    expect(peer.rows.map(one => [one.id, one.type, one.status, one.seat, totalTokens(one.tokens), one.background])).toEqual([
      ['a1', 'Explore', 'running', 2, 12_000, true],
      ['a2', 'Plan', 'completed', 1, 0, false],
    ])
    const team = peerTeamOf(peer)
    expect(team.map(entry => [entry.member.label, entry.member.role, entry.member.activity, entry.member.seat])).toEqual([
      ['Lead', 'lead', 'thinking', 0],
      ['Plan', 'plan', 'done', 1],
      ['Explore', 'explore', 'thinking', 2],
    ])
    expect(peerLine(peer, 1)).toBe('▸ 1 alpha · 1 working · Explore thinking · 1m 05s · 1 done')
    // A 0.8 file, with no card fields: the rows still draw, from its words alone.
    const old: LiveFile = {
      v: 1,
      id: 's8',
      beat: now,
      every: 2000,
      project: 'old',
      lead: { phase: 'tool', model: 'claude-opus-5-5', tool: 'Bash' },
      agents: [
        { label: 'Explore', role: 'explore', activity: 'reading', tool: 'Grep', startedAt: 1000, tokens: 500, description: 'Find it' },
        { label: 'Builder', role: 'builder', activity: 'waiting-you', tool: 'Bash', startedAt: 2000, tokens: 0, description: '' },
        { label: 'Plan', role: 'plan', activity: 'done', startedAt: 3000, endedAt: 9000, tokens: 0, description: '' },
      ],
    }
    expect(peerLeadOf(old.lead)).toEqual({ model: 'claude-opus-5-5', phase: 'tool', tool: 'Bash' })
    const oldRows = peerRowsOf(old)
    expect(oldRows.map(one => [one.id, one.name, one.status, one.phase, one.tool, one.seat])).toEqual([
      ['p1', 'Explore', 'running', 'tool', 'Grep', 1],
      ['p2', 'Builder', 'running', 'tool', 'Bash', 2],
      ['p3', 'Plan', 'completed', 'done', undefined, 3],
    ])
    expect(teamOf(oldRows, peerLeadOf(old.lead), now).map(entry => entry.member.activity)).toEqual(['terminal', 'reading', 'waiting-you', 'done'])
  })

  test('a session is found by number, by name, or by the start of its name or id when only one fits', () => {
    const list = peerSessionsOf(
      [peerFile({ id: 'sa1', now: 1000, project: 'alpha' }), peerFile({ id: 'sb1', now: 1000, project: 'beta' }), peerFile({ id: 'sb2', now: 1000, project: 'betamax' })],
      's1',
      1000,
    )
    expect(findPeer(list, '1')?.name).toBe('alpha')
    expect(findPeer(list, 'BETA')?.id).toBe('sb1')
    expect(findPeer(list, 'betam')?.id).toBe('sb2')
    expect(findPeer(list, 'bet')).toBeUndefined()
    expect(findPeer(list, 'sa')?.name).toBe('alpha')
    expect(findPeer(list, '9')).toBeUndefined()
    expect(findPeer(list, ' ')).toBeUndefined()
    expect(sessionsText(list, 'agent-radar', true).split('\n')).toEqual([
      'This session shows as "agent-radar" (rename it: /radar name <label>).',
      '▸ 1 alpha · idle',
      '▸ 2 beta · idle',
      '▸ 3 betamax · idle',
      '/radar expand <n> shows one in the Team pane.',
    ])
    expect(sessionsText([], 'x', true)).toContain('No other session is publishing')
    expect(sessionsText(list, 'x', false)).toContain('/radar sessions on shows them')
  })

  test('/radar sessions, expand, collapse and name parse; a label keeps its case', () => {
    expect(parseRadarArgs('sessions')).toEqual({ kind: 'sessions' })
    expect(parseRadarArgs('sessions off')).toEqual({ kind: 'view', change: { sessions: false } })
    expect(parseRadarArgs('Sessions ON')).toEqual({ kind: 'view', change: { sessions: true } })
    expect(parseRadarArgs('sessions maybe').kind).toBe('bad')
    expect(parseRadarArgs('expand 2')).toEqual({ kind: 'expand', target: '2' })
    expect(parseRadarArgs('expand Token Usage')).toEqual({ kind: 'expand', target: 'token usage' })
    expect(parseRadarArgs('expand').kind).toBe('bad')
    expect(parseRadarArgs('collapse')).toEqual({ kind: 'collapse' })
    expect(parseRadarArgs('collapse all')).toEqual({ kind: 'collapse', target: 'all' })
    expect(parseRadarArgs('name  Radar Work ')).toEqual({ kind: 'name', label: 'Radar Work' })
    expect(parseRadarArgs('name')).toEqual({ kind: 'name', label: '' })
    expect(parseRadarArgs('names x').kind).toBe('bad')
    expect(withLabel({ expanded: [] }, 'X')).toEqual({ expanded: [], label: 'X' })
    expect(withLabel({ expanded: [], label: 'X' }, '')).toEqual({ expanded: [] })
    const info = { expanded: ['a'] }
    expect(withLabel(info, '')).toBe(info)
    expect(withExpanded(info, ['a'], true)).toBe(info)
    expect(withExpanded(info, ['b'], true)).toEqual({ expanded: ['a', 'b'] })
    expect(withExpanded(info, ['a'], false)).toEqual({ expanded: [] })
  })

  test('a listing entry is read only when it is another session file: not empty, not huge, from the last day', () => {
    const entry = (fields: Partial<FsEntry>): FsEntry => ({ name: 's2.json', kind: 'file', size: 100, mtimeMs: 1000, isLink: false, ...fields })
    expect(isPeerEntry(entry({}), 's1.json', 2000)).toBe(true)
    expect(isPeerEntry(entry({ name: 's1.json' }), 's1.json', 2000)).toBe(false)
    expect(isPeerEntry(entry({ size: 0 }), 's1.json', 2000)).toBe(false)
    expect(isPeerEntry(entry({ size: 65 * 1024 }), 's1.json', 2000)).toBe(false)
    expect(isPeerEntry(entry({ mtimeMs: 2000 - 25 * 3_600_000 }), 's1.json', 2000)).toBe(false)
    expect(isPeerEntry(entry({ kind: 'dir' }), 's1.json', 2000)).toBe(false)
    expect(isPeerEntry(entry({ kind: 'other', isLink: true }), 's1.json', 2000)).toBe(false)
    expect(isPeerEntry(entry({ name: 'notes.txt' }), 's1.json', 2000)).toBe(false)
    expect(isPeerEntry(entry({ name: '.hidden.json' }), 's1.json', 2000)).toBe(false)
  })
})

describe('other sessions, live', () => {
  test('this session beats every 2 s while busy, once at once when it goes idle, then every 5 s', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(1000)
    expect(ownWrites(world)).toHaveLength(1)
    expect(ownFile(world)?.every).toBe(5000)
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    await world.clock.advance(1000)
    expect(ownWrites(world)).toHaveLength(2)
    await world.clock.advance(10_000)
    expect(ownWrites(world)).toHaveLength(7)
    expect(ownFile(world)).toMatchObject({ id: 's1', every: 2000, project: 'agent-radar' })
    expect(ownFile(world)?.agents.map(agent => agent.label)).toEqual(['Explore'])
    await $.turn.complete({ answer: 'Found it.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    await world.clock.advance(1000)
    expect(ownWrites(world)).toHaveLength(8)
    expect(ownFile(world)?.every).toBe(5000)
    expect(ownFile(world)?.agents[0]?.activity).toBe('done')
    await world.clock.advance(4000)
    expect(ownWrites(world)).toHaveLength(8)
    await world.clock.advance(1000)
    expect(ownWrites(world)).toHaveLength(9)
  })

  for (const surface of SURFACES) {
    test(`on ${surface}: two sessions see each other collapsed and live, then quiet, then gone when one ends`, async ($, on) => {
      const world = engine(on)
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await world.clock.settle()
      await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
      await world.clock.advance(2000)
      // Session B: this writer's own bytes under another id and folder, as a second session writes them.
      const mine = ownFile(world)
      expect(mine?.agents).toHaveLength(1)
      const beatB = (): void => {
        if (mine !== undefined) putPeer(world, { ...mine, id: 's2', project: 'token-usage-mod', beat: world.clock.now() })
      }
      beatB()
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'Pane', requestId: 'agents', props: PANE })
      await world.clock.advance(2000)
      beatB()
      // No redraw is asked for from here on: what the test reads is the last drawing, as a repaint shows it.
      expect(await ui.find({ type: 'Text', text: /^Other floors$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^1 of 1 session$/ })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'floor-s2' }))?.props.label).toBe('open token-usage-mod')
      // B's floor: a storey of the building, its name and what it does beside its lit windows.
      const lineB = async (): Promise<string | undefined> => {
        const said = await buildingText(ui, surface)
        return said !== undefined && said.includes('1 token-usage-mod') ? said : undefined
      }
      const first = await lineB()
      expect(first).toMatch(/1 token-usage-mod.*Explore .+\d+s/)
      for (let beat = 0; beat < 3; beat += 1) {
        await world.clock.advance(1000)
        beatB()
      }
      await world.clock.advance(1000)
      const later = await lineB()
      expect(later).toMatch(/1 token-usage-mod.*Explore /)
      expect(later).not.toBe(first)
      // This session's own file never shows as another session.
      expect(await buildingText(ui, surface)).not.toMatch(/\d agent-radar/)
      // With no name of its own, it says nothing of how it shows to the others.
      expect(await ui.find({ type: 'Text', text: /^shows as / })).toBeUndefined()
      const band = await $.ui.mount({ plugin: 'agent-radar', surface, component: 'AbovePrompt', props: BAND })
      expect(await band.find({ type: 'Text', text: /^1 other session · 1 agent working$/ })).toBeDefined()
      await band.unmount()
      // B stops beating: 20 s on it is closed, and its floor goes, with no redraw asked for.
      await world.clock.advance(19_000)
      expect(await lineB()).toBeDefined()
      await world.clock.advance(3000)
      expect(await lineB()).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^Other floors/ })).toBeUndefined()
      // B beats again, then ends: its closed file takes it off the list at once.
      beatB()
      await world.clock.advance(2000)
      expect(await lineB()).toMatch(/Explore /)
      world.disk.set(`${LIVE}/s2.json`, { text: JSON.stringify({ ...mine, id: 's2', beat: world.clock.now(), closed: true }), mtimeMs: world.clock.now() })
      await world.clock.advance(2000)
      expect(await ui.find({ type: 'Text', text: /^Other floors/ })).toBeUndefined()
      expect(await buildingText(ui, surface)).toBeUndefined()
      await ui.unmount()
    })
  }

  test('/radar expand opens another session to its Lead and agents; /radar collapse folds it again', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    const now = world.clock.now()
    const builder = row({
      id: 'b1',
      type: 'delegate:builder',
      description: 'Fix the band layout',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      startedAt: now - 70_000,
      phase: 'tool',
      tool: 'Edit',
    })
    putPeer(world, peerFile({ id: 's2', now, project: 'mod-dock', lead: BUSY_LEAD, rows: [builder] }))
    await world.clock.advance(2000)
    expect((await $.command.run(radarArgs('expand mod-dock'))).text).toBe('Expanded mod-dock in the Team pane.')
    expect(world.opened.at(-1)?.id).toBe('agents')
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    // The open floor: its own office, and its cards as this session's own cards look.
    expect(await ui.find({ type: 'Text', text: /^▾ 1 mod-dock · 1 working · Builder typing · Edit · 1m 10s$/ })).toBeDefined()
    expect(await ui.find({ type: 'Raster', key: 'office-s2' })).toBeDefined()
    // It keeps its storey in the building, marked open.
    expect(await buildingText(ui, 'terminal')).toMatch(/1 mod-dock open/)
    expect(await ui.find({ type: 'Raster', key: 'av-s2-b1' })).toBeDefined()
    expect(await ui.find({ type: 'Raster', key: 'av-s2-main' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^Lead$/ })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /^Builder$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^animator Bolt$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^typing · Edit$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1m 10s$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Fix the band layout$/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'floor-s2' }))?.props.label).toBe('close mod-dock')
    expect((await $.command.run(radarArgs('collapse 1'))).text).toBe('Collapsed mod-dock.')
    expect(await ui.find({ type: 'Raster', key: 'office-s2' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Builder$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^▾ 1 mod-dock/ })).toBeUndefined()
    expect(await buildingText(ui, 'terminal')).toMatch(/1 mod-dock.*Builder typing Edit.*1m 10s/)
    // Its button opens the floor too, and closes it again.
    await ui.press({ key: 'floor-s2' })
    expect(await ui.find({ type: 'Raster', key: 'office-s2' })).toBeDefined()
    await ui.press({ key: 'floor-s2' })
    expect(await ui.find({ type: 'Raster', key: 'office-s2' })).toBeUndefined()
    expect((await $.command.run(radarArgs('expand nowhere'))).text).toBe('No other session matches "nowhere". /radar sessions lists them.')
    expect((await $.command.run(radarArgs('expand all'))).text).toBe('Expanded every other session in the Team pane.')
    expect(await ui.find({ type: 'Text', text: /^▾ 1 mod-dock/ })).toBeDefined()
    expect((await $.command.run(radarArgs('collapse'))).text).toBe('Collapsed every other session.')
    expect(await ui.find({ type: 'Text', text: /^▾ 1 mod-dock/ })).toBeUndefined()
    await ui.unmount()
  })

  test('/radar name: the label goes out with the next beat, keeps its case, and a resumed session gets it back', async ($, on) => {
    const world = engine(on)
    world.disk.set(OWN, { text: JSON.stringify(peerFile({ id: 's1', now: 0, every: 15_000, project: 'agent-radar', label: 'Kept Name' })), mtimeMs: 0 })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(1000)
    expect(ownFile(world)?.label).toBe('Kept Name')
    expect((await $.command.run(radarArgs('name Radar Work'))).text).toBe(
      'This session shows as "Radar Work" in the other sessions\' Team panes.',
    )
    await world.clock.advance(1000)
    expect(ownFile(world)?.label).toBe('Radar Work')
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await ui.find({ type: 'Text', text: /^shows as Radar Work$/ })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(radarArgs('name'))).text).toBe('This session shows as its folder name again.')
    await world.clock.advance(1000)
    expect(ownFile(world)?.label).toBeUndefined()
    expect((await $.command.run(radarArgs('sessions'))).text).toContain('This session shows as "agent-radar"')
    expect((await $.command.run(radarArgs('expand 1'))).text).toBe(
      'No other session is publishing. A session shows here once it runs agent-radar 0.8.0 or later.',
    )
  })

  test('a call outside any turn leaves the Lead idle, so the session publishes as idle; inside a turn it shows', async ($, on) => {
    // What the Lead's card says while each call runs.
    const seen: (string | undefined)[] = []
    let readCard = async (): Promise<string | undefined> => undefined
    const world = engine(on, TEXT_STEP, {
      duringToolCall: async () => {
        seen.push(await readCard())
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    readCard = async () => (await ui.find({ type: 'Text', text: /^at the terminal · Bash/ }))?.text
    // A warm spawn: the host or a plugin raises a call, and no turn runs.
    await $.tool.call({ tool: 'Bash', command: 'true' } as never)
    await world.clock.advance(1000)
    expect(ownFile(world)).toMatchObject({ every: 5000, lead: { phase: 'idle' } })
    await world.clock.advance(15_000)
    expect(ownFile(world)?.lead.phase).toBe('idle')
    // A real turn: its first step opens it, its calls show, its end closes it.
    await run($.turn.step(stepOf()))
    await $.tool.call({ tool: 'Bash', command: 'true', tool_use_id: 'tu-main' } as never)
    expect(seen).toEqual([undefined, 'at the terminal · Bash: true'])
    await world.clock.advance(1000)
    expect(ownFile(world)).toMatchObject({ every: 2000, lead: { phase: 'thinking', model: 'claude-sonnet-5-5' } })
    await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.tool.call({ tool: 'Bash', command: 'true' } as never)
    expect(seen).toEqual([undefined, 'at the terminal · Bash: true', undefined])
    await world.clock.advance(1000)
    expect(ownFile(world)).toMatchObject({ every: 5000, lead: { phase: 'idle' } })
    await ui.unmount()
  })

  test('a Lead left "thinking" by 0.8.0 is settled at the start, so the session does not look busy', async ($, on) => {
    const world = engine(on)
    // The state a 0.8.0 session kept: this stand-in holds the Lead's cell, versions and all.
    let cell: { value: unknown; version: number } = { value: { model: '', phase: 'thinking' }, version: 1 }
    on('state.get', { plugin: 'agent-radar', key: 'main' }, (() => ({ value: cell })) as never)
    on('state.set', { plugin: 'agent-radar', key: 'main' }, ((_$: unknown, e: { value: unknown; ifVersion?: number }) => {
      if (e.ifVersion !== undefined && e.ifVersion !== cell.version) return { value: { isSet: false, version: cell.version } }
      cell = { value: e.value, version: cell.version + 1 }
      return { value: { isSet: true, version: cell.version } }
    }) as never)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(1000)
    expect(ownFile(world)).toMatchObject({ every: 5000, lead: { phase: 'idle' } })
  })

  test('a new id with no end seen closes the file under the old id', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(1000)
    expect(ownFile(world)?.id).toBe('s1')
    world.sessionId = 's5'
    await world.clock.advance(15_000)
    expect(parseLiveFile(world.disk.get(OWN)?.text ?? '')).toMatchObject({ id: 's1', closed: true, agents: [] })
    expect(parseLiveFile(world.disk.get(`${LIVE}/s5.json`)?.text ?? '')?.id).toBe('s5')
  })

  test('the end closes this session file, keeping only its label and last activity; no beat opens it again; after a /clear the new id beats', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    await world.clock.advance(2000)
    expect(ownFile(world)?.agents).toHaveLength(1)
    await $.command.run(radarArgs('name Radar Work'))
    await world.clock.advance(1000)
    const active = ownFile(world)?.active
    expect(active).toBeGreaterThan(0)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    const closed = world.disk.get(OWN)?.text ?? ''
    expect(parseLiveFile(closed)).toEqual({
      v: 1,
      id: 's1',
      beat: world.clock.now(),
      every: 5000,
      project: 'agent-radar',
      label: 'Radar Work',
      lead: { phase: 'idle' },
      agents: [],
      active,
      closed: true,
    })
    world.sessionId = 's9'
    await world.clock.advance(5000)
    expect(world.disk.get(OWN)?.text).toBe(closed)
    expect(parseLiveFile(world.disk.get(`${LIVE}/s9.json`)?.text ?? '')?.id).toBe('s9')
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's9', resume: { id: 's9' } })
    await world.clock.advance(5000)
    expect(parseLiveFile(world.disk.get(`${LIVE}/s9.json`)?.text ?? '')?.closed).toBe(true)
  })

  test('only the live folder is read and only the own file written; no prompt, thinking or answer text goes in; nothing goes out', async ($, on) => {
    const chunks = [
      { kind: 'thinking', index: 0, text: 'THINK-SECRET-1 the /graphify skill' },
      { kind: 'text', index: 0, text: 'REPLY-SECRET-2' },
    ] as unknown as readonly TurnStepChunk[]
    const world = engine(on, chunks)
    const forbidden: string[] = []
    const ops = [
      'http.fetch',
      'process.run',
      'mcp.call',
      'mcp.connect',
      'model.complete',
      'model.classify',
      'model.fork',
      'session.messages',
      'session.send',
      'fs.exists',
      'fs.stat',
      'fs.ancestors',
      'env.set',
      'settings.read',
    ]
    for (const op of ops) {
      on(op as never, (() => {
        forbidden.push(op)
        throw new Error(`${op} is not allowed`)
      }) as never)
    }
    putPeer(world, peerFile({ id: 's2', now: world.clock.now(), rows: [row({ startedAt: world.clock.now() })] }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await run($.turn.step(stepOf()))
    await $.agent.spawn(spawnInput({ subagentType: 'Explore', description: 'Find the config loader', prompt: 'PROMPT-SECRET-3 find it' }))
    await run($.turn.step(stepOf({ agentId: 'a1' })))
    for (const call of [
      { tool: 'Grep', pattern: 'ARG-SECRET-4', agentId: 'a1' },
      { tool: 'Bash', command: 'echo ARG-SECRET-5', description: 'ARG-SECRET-6', agentId: 'a1' },
      { tool: 'Read', file_path: '/x/ARG-SECRET-7.ts', agentId: 'a1' },
      { tool: 'Edit', file_path: '/x/ARG-SECRET-8.ts', agentId: 'a1' },
      { tool: 'Bash', command: 'MAIN-ARG-SECRET-9' },
    ]) {
      await $.tool.call(call as never)
    }
    await world.clock.advance(2000)
    await $.turn.complete({ answer: 'ANSWER-SECRET-10', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    await world.clock.advance(2000)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    const band = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    for (const args of ['sessions', 'expand 1', 'collapse', 'name Radar Work', 'sessions off', 'sessions on']) {
      await $.command.run(radarArgs(args))
    }
    await world.clock.advance(4000)
    await ui.unmount()
    await band.unmount()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })

    expect(forbidden).toEqual([])
    const written = world.fsCalls.filter(call => call.op === 'write').map(call => call.text ?? '')
    expect(written.join('\n')).toContain('Find the config loader')
    // Calls go in with a short argument (approved for 0.9); prompts, thinking, replies and answers never.
    expect(written.join('\n')).not.toMatch(/THINK-SECRET|REPLY-SECRET|PROMPT-SECRET|ANSWER-SECRET/)
    expect(written.join('\n')).toContain('ARG-SECRET-4')
    // A file goes in by its base name, never its path.
    expect(written.join('\n')).not.toContain('/x/')
    expect(world.fsCalls.some(call => call.op === 'list')).toBe(true)
    for (const call of world.fsCalls) {
      if (call.op === 'list') expect(call.path).toBe(LIVE)
      else if (call.op === 'write') expect(call.path).toBe(OWN)
      else expect(call.path.startsWith(`${LIVE}/`)).toBe(true)
    }
  })

  test('the band shows the other sessions at work and their agents that wait on the person, with a Team button', async ($, on) => {
    const world = engine(on)
    const now = world.clock.now()
    const waiting = row({ id: 'b1', type: 'delegate:builder', startedAt: now - 5000, needs: { tool: 'Bash', since: now - 5000 } })
    putPeer(world, peerFile({ id: 's2', now, project: 'mod-dock', rows: [waiting] }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    const band = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /^1 other session · 1 agent working$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^! Builder in mod-dock needs you$/ })).toBeDefined()
    expect((await band.find({ type: 'Button', key: 'agents' }))?.props.label).toBe('Team')
    expect(await band.find({ type: 'Text', text: /^ENGINE BAND$/ })).toBeDefined()
    await band.unmount()
  })

  test('/radar sessions off hides the others and stops reading them; this session still publishes', async ($, on) => {
    const world = engine(on)
    const beatB = (): void => putPeer(world, peerFile({ id: 's2', now: world.clock.now(), rows: [row({ startedAt: world.clock.now() })] }))
    beatB()
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await ui.find({ type: 'Text', text: /^1 of 1 session$/ })).toBeDefined()
    expect((await $.command.run(radarArgs('sessions off'))).text).toBe('View: office and cards, labels on, motion on, details on, sessions off.')
    await world.clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: /^Other floors/ })).toBeUndefined()
    const lists = world.fsCalls.filter(call => call.op === 'list').length
    const writes = ownWrites(world).length
    for (let beat = 0; beat < 10; beat += 1) {
      beatB()
      await world.clock.advance(2000)
    }
    expect(world.fsCalls.filter(call => call.op === 'list')).toHaveLength(lists)
    expect(ownWrites(world).length).toBeGreaterThan(writes)
    const band = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /other session/ })).toBeUndefined()
    await band.unmount()
    expect((await $.command.run(radarArgs('sessions on'))).text).toContain('sessions recent (idle 2h), 6 floors.')
    await world.clock.advance(2000)
    expect(await ui.find({ type: 'Text', text: /^1 of 1 session$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a broken, huge, stale, misnamed or empty file is skipped, and a huge or stale one is never read', async ($, on) => {
    const world = engine(on)
    const now = world.clock.now()
    const good = peerFile({ id: 's2', now, project: 'good', rows: [row({ startedAt: now })] })
    const text = JSON.stringify(good)
    world.disk.set(`${LIVE}/s2.json`, { text, mtimeMs: now })
    world.disk.set(`${LIVE}/junk.json`, { text: 'not json', mtimeMs: now })
    world.disk.set(`${LIVE}/big.json`, { text: JSON.stringify({ ...good, id: 'big' }) + ' '.repeat(70 * 1024), mtimeMs: now })
    world.disk.set(`${LIVE}/old.json`, { text: JSON.stringify({ ...good, id: 'old' }), mtimeMs: now - 25 * 3_600_000 })
    // Its name and the id inside disagree.
    world.disk.set(`${LIVE}/s7.json`, { text: JSON.stringify({ ...good, id: 's8', project: 'liar' }), mtimeMs: now })
    // An ended session.
    world.disk.set(`${LIVE}/s3.json`, { text: '', mtimeMs: now })
    world.disk.set(`${LIVE}/notes.txt`, { text: 'hello', mtimeMs: now })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    const shown = (await $.command.run(radarArgs('sessions'))).text ?? ''
    expect(shown.split('\n').filter(line => line.startsWith('▸'))).toEqual([expect.stringMatching(/^▸ 1 good · 1 working · /)])
    const reads = world.fsCalls.filter(call => call.op === 'read').map(call => call.path.slice(LIVE.length + 1))
    for (const never of ['big.json', 'old.json', 's3.json', 'notes.txt']) expect(reads).not.toContain(never)
    // Caught mid-write, a file keeps what it said before.
    world.disk.set(`${LIVE}/s2.json`, { text: text.slice(0, 40), mtimeMs: world.clock.now() })
    await world.clock.advance(2000)
    expect((await $.command.run(radarArgs('sessions'))).text).toMatch(/^▸ 1 good · 1 working · /m)
  })
})

describe('more detail on calls', () => {
  test('a Bash command loses the cd it starts with; a description still wins', () => {
    expect(withoutCd('cd /home/user/project && npm test')).toBe('npm test')
    expect(withoutCd('cd "/a b/c"; make')).toBe('make')
    expect(withoutCd("cd '/x' && git status")).toBe('git status')
    expect(withoutCd('cd /tmp')).toBe('cd /tmp')
    expect(withoutCd('npm test && cd x')).toBe('npm test && cd x')
    expect(callDetail({ tool: 'Bash', command: 'cd /home/user/project && git log --oneline -5' })).toBe('git log --oneline -5')
    expect(describeCall({ tool: 'Bash', command: 'cd /repo && pytest -q' })).toBe('Running pytest -q')
    expect(callDetail({ tool: 'Bash', command: 'cd /repo && pytest -q', description: 'Run the tests' })).toBe('Run the tests')
  })

  test('a card gives the recent calls and the task two lines', async ($, on) => {
    engine(on)
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK, description: `Find the config loader ${'and more '.repeat(12)}` }))
    for (const call of [
      { tool: 'Bash', command: 'cd /home/user/project && npm run build -- --verbose' },
      { tool: 'Grep', pattern: 'loadConfigFromEnvironment' },
      { tool: 'Read', file_path: '/repo/src/config/loader.ts' },
    ]) {
      await $.tool.call({ ...call, agentId: 'a1' } as never)
    }
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    const recent = await ui.find({ type: 'Text', text: /^recent: / })
    expect(recent?.text).toBe('recent: Bash npm run build -- --verbose › Grep loadConfigFromEnvironment › Read loader.ts')
    expect(recent?.props.wrap).toBe('wrap')
    const task = await ui.find({ type: 'Text', text: /^Find the config loader/ })
    expect(task?.props.wrap).toBe('wrap')
    expect((task?.text.length ?? 0) > 80).toBe(true)
    await ui.unmount()
  })
})

describe('other sessions as floors', () => {
  /** A busy floor of another session: its Lead and one Builder with calls, files and tokens. */
  const busyPeer = (world: World, fields: Partial<AgentRow> = {}): void => {
    const now = world.clock.now()
    const builder = row({
      id: 'b1',
      type: 'delegate:builder',
      description: 'Fix the band layout',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      startedAt: now - 30_000,
      phase: 'tool',
      tool: 'Edit',
      detail: 'Band.tsx',
      doing: 'Editing Band.tsx',
      tools: 4,
      steps: 3,
      tokens: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 },
      trail: [
        { tool: 'Read', detail: 'Band.tsx' },
        { tool: 'Grep', detail: 'columnGap' },
        { tool: 'Edit', detail: 'Band.tsx' },
      ],
      toolCounts: { Read: 2, Grep: 1, Edit: 1 },
      files: ['/repo/src/Band.tsx'],
      reads: ['/repo/src/Band.tsx', '/repo/src/Pane.tsx'],
      seat: 1,
      ...fields,
    })
    putPeer(world, peerFile({ id: 's2', now, project: 'mod-dock', lead: BUSY_LEAD, rows: [builder] }))
  }

  test('an open floor shows the other session\'s cards with their details, as this session\'s own', async ($, on) => {
    const world = engine(on)
    busyPeer(world)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    await $.command.run(radarArgs('expand 1'))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'desktop', component: 'Pane', requestId: 'agents', props: PANE })
    const floor = (await ui.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('Floor mod-dock, open: '))
    expect(String(floor?.props.source).startsWith('<svg')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^typing · Edit: Band\.tsx$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^recent: Read Band\.tsx › Grep columnGap › Edit Band\.tsx$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^4 tool calls \(Read 2, Edit 1, Grep 1\) · 3 model calls · edited Band\.tsx · read 2 files$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^tokens in 1k · cache read 5k · cache write 300 · out 200$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^waiting for a message$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('an open idle floor: its Lead waits for a message, and this session\'s Lead for yours', async ($, on) => {
    const world = engine(on)
    putPeer(world, peerFile({ id: 's2', now: world.clock.now(), every: 15_000, project: 'mod-dock' }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    await $.command.run(radarArgs('expand mod-dock'))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await ui.find({ type: 'Raster', key: 'office-s2' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^waiting for your next message$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^waiting for a message$/ })).toHaveLength(1)
    await ui.unmount()
  })

  test('the open floor of another session holds no walk, so its last drawing is safe to repaint', async ($, on) => {
    const world = engine(on)
    // It arrives just before the floor is drawn: with walks on, it would be mid-walk from the door.
    busyPeer(world, { startedAt: world.clock.now() + 1900 })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    await $.command.run(radarArgs('expand 1'))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'desktop', component: 'Pane', requestId: 'agents', props: PANE })
    const source = async (): Promise<string> =>
      String((await ui.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('Floor mod-dock'))?.props.source)
    expect(await source()).not.toContain('animateTransform')
    // Its Builder ends: the floor moves it to the lounge with no walk.
    busyPeer(world, { status: 'completed', phase: 'done', startedAt: world.clock.now() - 9000, endedAt: world.clock.now() + 1900, doing: 'finished' })
    await world.clock.advance(2000)
    expect(await source()).not.toContain('animateTransform')
    expect(await source()).toContain('<svg')
    await ui.unmount()
  })

  test('the terminal repaints a working floor by blit, and an idle one not at all', async ($, on) => {
    const world = engine(on)
    busyPeer(world)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    const floorBlits = (): number => world.blits.filter(blit => blit.key === 'building').length
    const before = floorBlits()
    // Four frames a second while the other floor works, though nobody works here.
    await world.clock.advance(2000)
    expect(floorBlits()).toBeGreaterThanOrEqual(before + 6)
    // It goes idle while this session's own office keeps moving: its strip is dim and still, and never repainted.
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    putPeer(world, peerFile({ id: 's2', now: world.clock.now(), every: 15_000, project: 'mod-dock' }))
    await world.clock.advance(3000)
    await ui.redraw()
    const idle = floorBlits()
    const own = world.blits.filter(blit => blit.key === 'office').length
    await world.clock.advance(2000)
    expect(world.blits.filter(blit => blit.key === 'office').length).toBeGreaterThan(own)
    expect(floorBlits()).toBe(idle)
    expect(await buildingText(ui, 'terminal')).toMatch(/1 mod-dock idle/)
    await ui.unmount()
  })

  test('six floors by default, eight with /radar floors 8: each picture under the SVG cap; the rest on the +N line', async ($, on) => {
    const world = engine(on)
    const now = world.clock.now()
    for (let i = 1; i <= 9; i += 1) {
      const crew = Array.from({ length: 6 }, (_, k) => row({ id: `x${k}`, type: k % 2 === 0 ? 'Explore' : 'delegate:builder', startedAt: now - k * 1000, seat: k + 1 }))
      putPeer(world, peerFile({ id: `s${i + 10}`, now, project: `proj-${i}`, lead: BUSY_LEAD, rows: crew }))
    }
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    await $.command.run(radarArgs('expand proj-1'))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'desktop', component: 'Pane', requestId: 'agents', props: PANE })
    // A storey and an open button per floor.
    const floorsNow = async (): Promise<number> => (await ui.findAll({ type: 'Button' })).filter(one => String(one.key).startsWith('floor-')).length
    // Six floors by default; the rest wait on a line.
    expect(await floorsNow()).toBe(6)
    expect(await ui.find({ type: 'Text', text: /^\+3 more past the 6 floors · \/radar floors <n> · \/radar sessions all$/ })).toBeDefined()
    expect((await $.command.run(radarArgs('floors 8'))).text).toContain(', 8 floors.')
    await world.clock.advance(1000)
    expect(await floorsNow()).toBe(8)
    const tower = (await ui.findAll({ type: 'Svg' })).find(one => String(one.props.alt).startsWith('Building: '))
    expect(String(tower?.props.source)).toContain('>proj-8<')
    expect(String(tower?.props.source)).not.toContain('>proj-9<')
    // The building and the open floor's office: each picture under the SVG cap.
    const pictures = (await ui.findAll({ type: 'Svg' })).filter(one => /^(Building: |Floor )/.test(String(one.props.alt)))
    expect(pictures).toHaveLength(2)
    for (const picture of pictures) expect(String(picture.props.source).length).toBeLessThan(131_072)
    expect(await ui.find({ type: 'Text', text: /^\+1 more past the 8 floors/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^8 of 9 sessions$/ })).toBeDefined()
    expect(world.store.get('view')).toMatchObject({ floors: 8 })
    await ui.unmount()
  })
})

describe('idle sessions', () => {
  test('an unchanged heartbeat never moves this session\'s last activity; a change does, and a resume keeps it', async ($, on) => {
    const world = engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(1000)
    // Nothing has happened yet: no last activity to tell.
    expect(ownFile(world)?.active).toBeUndefined()
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    await world.clock.advance(2000)
    await $.turn.complete({ answer: 'Found it.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
    await world.clock.advance(1000)
    const active = ownFile(world)?.active ?? 0
    expect(active).toBeGreaterThan(0)
    // Ten minutes of idle heartbeats: the beat moves, the last activity does not.
    const beats = ownWrites(world).length
    await world.clock.advance(600_000)
    expect(ownWrites(world).length).toBeGreaterThan(beats + 100)
    expect(ownFile(world)?.beat).toBeGreaterThan(active + 590_000)
    expect(ownFile(world)?.active).toBe(active)
  })

  test('a resumed session reads its last activity back from its own file: the restart itself is not activity', async ($, on) => {
    const world = engine(on)
    const before = peerFile({ id: 's1', now: 400, project: 'agent-radar', active: 300, rows: [row({ status: 'completed', startedAt: 100, endedAt: 300 })] })
    world.disk.set(OWN, { text: JSON.stringify({ ...before, closed: true }), mtimeMs: 400 })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(1000)
    // Its first beat says other things than the old file (no agents now), and still keeps 300.
    expect(ownFile(world)).toMatchObject({ active: 300, agents: [] })
    expect(ownFile(world)?.closed).toBeUndefined()
    await world.clock.advance(20_000)
    expect(ownFile(world)?.active).toBe(300)
  })

  test('another session idle past the cutoff loses its floor; a bare heartbeat does not bring it back, a change does', async ($, on) => {
    const world = engine(on)
    // A 0.9.0 session: its file says no `active`, so this reader judges by what changes.
    const old = (phase: LiveLead['phase'], beat: number): LiveFile => {
      const { active: _active, ...rest } = peerFile({ id: 's2', now: beat, every: 5000, project: 'mod-dock', lead: { model: '', phase } })
      return rest
    }
    const put = (file: LiveFile): void => {
      world.disk.set(`${LIVE}/s2.json`, { text: JSON.stringify(file), mtimeMs: world.clock.now() })
    }
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    // 36 s of idle keeps a floor.
    expect((await $.command.run(radarArgs('idle 0.01'))).text).toContain('sessions recent (idle 36s)')
    put(old('thinking', world.clock.now()))
    await world.clock.advance(2000)
    put(old('idle', world.clock.now()))
    await world.clock.advance(2000)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', component: 'Pane', requestId: 'agents', props: PANE })
    const line = async (): Promise<string | undefined> => {
      const said = await buildingText(ui, 'terminal')
      return said?.match(/1 mod-dock \S.*?(?= ?$)/)?.[0]
    }
    expect(await line()).toMatch(/^1 mod-dock idle/)
    // Heartbeats that change nothing, past the cutoff: the floor goes, and the +N line says so.
    for (let beat = 0; beat < 9; beat += 1) {
      await world.clock.advance(5000)
      put(old('idle', world.clock.now()))
    }
    await world.clock.advance(1000)
    expect(await line()).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^\+1 idle session hidden · \/radar sessions all$/ })).toBeDefined()
    // `/radar sessions all` shows it again; `recent` hides it.
    await $.command.run(radarArgs('sessions all'))
    await world.clock.advance(1000)
    expect(await line()).toBeDefined()
    await $.command.run(radarArgs('sessions recent'))
    await world.clock.advance(1000)
    expect(await line()).toBeUndefined()
    // It does something: working, then idle again, it is back as a recent idle floor.
    put(old('thinking', world.clock.now()))
    await world.clock.advance(2000)
    expect(await line()).toMatch(/^1 mod-dock Lead thinking/)
    put(old('idle', world.clock.now()))
    await world.clock.advance(2000)
    expect(await line()).toMatch(/^1 mod-dock idle/)
    await ui.unmount()
  })

  test('a first sight of another session is not activity: an idle file that says no `active` stays hidden', async ($, on) => {
    const world = engine(on)
    const quiet = (): void => {
      const { active: _active, ...rest } = peerFile({ id: 's2', now: world.clock.now(), every: 5000, project: 'mod-dock' })
      world.disk.set(`${LIVE}/s2.json`, { text: JSON.stringify(rest), mtimeMs: world.clock.now() })
    }
    // Off time 0, so a first sight timed at its beat would read as activity.
    await world.clock.advance(60_000)
    quiet()
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    const text = async (): Promise<string> => (await $.command.run(radarArgs('sessions'))).text ?? ''
    expect(await text()).toContain('▸ 1 mod-dock · idle (no floor: idle too long)')
    for (let beat = 0; beat < 3; beat += 1) {
      await world.clock.advance(5000)
      quiet()
    }
    await world.clock.advance(2000)
    expect(await text()).toContain('▸ 1 mod-dock · idle (no floor: idle too long)')
  })

  test('a session with no heartbeat for 20 s is gone; one that says it closed is gone at once', async ($, on) => {
    const world = engine(on)
    const now = world.clock.now()
    putPeer(world, peerFile({ id: 's2', now, project: 'alpha', rows: [row({ startedAt: now })] }))
    putPeer(world, { ...peerFile({ id: 's3', now, project: 'beta', rows: [row({ startedAt: now })] }), closed: true })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    const listed = async (): Promise<string[]> =>
      ((await $.command.run(radarArgs('sessions'))).text ?? '').split('\n').filter(one => one.startsWith('▸'))
    expect(await listed()).toEqual([expect.stringMatching(/^▸ 1 alpha · 1 working/)])
    await world.clock.advance(17_000)
    expect(await listed()).toHaveLength(1)
    await world.clock.advance(3000)
    expect(await listed()).toEqual([])
  })
})

describe('press handles', () => {
  test('another session\'s changes redraws the pane at most every 4 s, and someone waiting on you shows at once', async ($, on) => {
    const world = engine(on)
    // Every write of the other sessions' atom is a redraw, and each redraw gives the buttons new press handles.
    const writes: number[] = []
    on('state.set', { plugin: 'agent-radar', key: 'peers' }, ((_$: unknown, e: unknown, next: (e: unknown) => unknown) => {
      writes.push(world.clock.now())
      return next(e)
    }) as never)
    const tools = ['Read', 'Grep', 'Edit', 'Bash']
    const beat = (step: number, needs?: { tool: string; since: number }): void => {
      const now = world.clock.now()
      const builder = row({ id: 'b1', type: 'delegate:builder', startedAt: 1000, phase: 'tool', tool: tools[step % tools.length], ...(needs === undefined ? {} : { needs }) })
      putPeer(world, peerFile({ id: 's2', now, project: 'mod-dock', lead: BUSY_LEAD, rows: [builder] }))
    }
    await world.clock.advance(5000)
    beat(0)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    const first = writes.length
    expect(first).toBeGreaterThan(0)
    // A new tool on every 2 s beat for 20 s: five redraws at most, not twenty.
    for (let step = 1; step <= 10; step += 1) {
      beat(step)
      await world.clock.advance(2000)
    }
    expect(writes.length - first).toBeLessThanOrEqual(6)
    for (let i = first + 1; i < writes.length; i += 1) expect((writes[i] ?? 0) - (writes[i - 1] ?? 0)).toBeGreaterThanOrEqual(4000)
    // It starts to wait on you: that shows at the next look, with no wait for the 4 s.
    const before = writes.length
    beat(11, { tool: 'Bash', since: world.clock.now() - 5000 })
    await world.clock.advance(2000)
    expect(writes.length).toBe(before + 1)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'desktop', component: 'Pane', requestId: 'agents', props: PANE })
    expect(await buildingText(ui, 'desktop')).toMatch(/Builder waiting on you/)
    await ui.unmount()
  })

  test('a session whose Lead alone works is drawn still: no redraw for time alone', async ($, on) => {
    const world = engine(on)
    const writes: number[] = []
    on('state.set', { plugin: 'agent-radar', key: 'peers' }, ((_$: unknown, e: unknown, next: (e: unknown) => unknown) => {
      writes.push(world.clock.now())
      return next(e)
    }) as never)
    await world.clock.advance(5000)
    const beat = (): void => putPeer(world, peerFile({ id: 's2', now: world.clock.now(), project: 'mod-dock', lead: BUSY_LEAD, active: 4000 }))
    beat()
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await world.clock.settle()
    await world.clock.advance(2000)
    const first = writes.length
    for (let step = 0; step < 10; step += 1) {
      beat()
      await world.clock.advance(2000)
    }
    expect(writes.length).toBe(first)
  })
})

describe('the pane\'s type', () => {
  test('a card ends with the router\'s pick, after its details; "needs you" is a red chip; the router\'s defaults go unsaid', async ($, on) => {
    engine(on, STEP_WITH_USAGE)
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    await run($.turn.step(stepOf({ agentId: 'a1' })))
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'desktop', component: 'Pane', requestId: 'agents', props: PANE })
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    const route = texts.findIndex(text => text.startsWith('⇄ '))
    const details = texts.findIndex(text => /^\d+ model call|^no tool calls/.test(text))
    expect(route).toBeGreaterThan(details)
    expect(details).toBeGreaterThan(-1)
    expect(texts.some(text => /routing auto|ceiling raise/.test(text))).toBe(false)
    await ui.unmount()
  })

  test('"N need you" is drawn as a filled red chip', async ($, on) => {
    const gate = deferred()
    const world = engine(on, TEXT_STEP, {
      checkDecision: 'ask',
      duringToolCall: async call => {
        await $.tool.check({ tool: call.tool, input: {}, tool_use_id: call.tool_use_id } as never)
        await gate.promise
      },
    })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.agent.spawn(spawnInput({ ...LOOKUP_ASK }))
    const pending = $.tool.call({ tool: 'Bash', command: 'make clean', tool_use_id: 'tu-9', agentId: 'a1' } as never)
    await world.clock.advance(3000)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'desktop', component: 'Pane', requestId: 'agents', props: PANE })
    const chip = await ui.find({ type: 'Text', text: /^ 1 needs you $/ })
    expect(chip?.props.backgroundColor).toBe('error')
    expect(chip?.props.bold).toBe(true)
    await ui.unmount()
    gate.resolve()
    await pending
  })

})
