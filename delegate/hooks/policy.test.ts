import { describe, expect, test } from 'claude-code/testing'

import {
  AGENT_NOTE,
  DEFAULTS,
  EMPTY_NOTE,
  MARK,
  POLICY_TEXT,
  VERSION,
  capCheck,
  configOf,
  countDeny,
  countShape,
  emptyCounts,
  emptyGate,
  fillControl,
  fillCounts,
  fillGate,
  fillSeen,
  fmtTokens,
  gateAfter,
  isEmptyAnswer,
  isGeneric,
  isReadOnly,
  isRole,
  levelOf,
  judgeSpawn,
  nudgeText,
  parseArgs,
  remember,
  runAfter,
  scoreOf,
  scoreText,
  shapeOf,
  statusText,
  sumCounts,
  taskKey,
  tokensOf,
  withFooter,
} from './policy'
import type { Brief, JudgeContext } from './policy'

const CONFIG = { normalise: true, requireTag: true, blockNested: true } as const

const ctx = (over: Partial<JudgeContext> = {}): JudgeContext => ({
  isNested: false,
  config: CONFIG,
  seen: [],
  ...over,
})

const FULL = [
  '[difficulty: routine]',
  'Goal: list the exported functions in /home/me/proj/src/auth.ts.',
  'Scope: read-only, do not edit anything.',
  'Done when you have listed them all.',
  'Return format: a numbered list, under 200 words.',
  'Do not spawn agents.',
].join('\n')

const brief = (over: Partial<Brief> = {}): Brief => ({
  type: 'general-purpose',
  description: 'List auth exports',
  prompt: FULL,
  ...over,
})

const UNTAGGED_FULL = FULL.replace('[difficulty: routine]\n', '')

/** A brief with a tag and an anchor, and nothing else the footer adds. */
const BARE = '[difficulty: lookup]\nFind where the session key is read in /home/me/proj/src/state.ts and say which functions call it, with enough context for a stranger to follow.'

describe('reading a brief', () => {
  test('finds each part of a complete brief', () => {
    expect(shapeOf('List auth exports', FULL)).toEqual({ tag: true, scope: true, done: true, ret: true, nospawn: true, vague: false })
  })

  test('reads the tag in the description or in the first 400 characters only', () => {
    expect(shapeOf('[difficulty: hard] Plan the move', 'x'.repeat(300)).tag).toBe(true)
    expect(shapeOf('Plan the move', `[Difficulty: Deep]\n${'x'.repeat(300)}`).tag).toBe(true)
    expect(shapeOf('Plan the move', `${'x'.repeat(401)} [difficulty: hard]`).tag).toBe(false)
    expect(shapeOf('Plan the move', '[difficulty: easy] do it').tag).toBe(false)
    expect(shapeOf('Plan the move', '[difficulty: hard') .tag).toBe(false)
  })

  test('calls a short brief with no anchor vague, and a short brief with an anchor not vague', () => {
    expect(shapeOf('x', 'Look around.').vague).toBe(true)
    expect(shapeOf('x', 'Check /home/me/a/b.ts for the call.').vague).toBe(false)
    expect(shapeOf('x', 'Check `parseArgs` for the call.').vague).toBe(false)
    expect(shapeOf('x', 'Read https://example.com/docs and say what it states about caps').vague).toBe(false)
    expect(shapeOf('x', 'y'.repeat(250)).vague).toBe(false)
    expect(shapeOf('x', 'y'.repeat(249)).vague).toBe(true)
  })

  test('knows which agent types it judges', () => {
    for (const type of ['general-purpose', 'Explore', 'Plan', undefined, '']) expect(isGeneric(type)).toBe(true)
    for (const type of ['fork', 'delegate:scout', 'statslab:stats-planner', 'gsd-executor']) expect(isGeneric(type)).toBe(false)
    expect(isRole('delegate:scout')).toBe(true)
    expect(isRole('statslab:stats-planner')).toBe(false)
    expect(isRole(undefined)).toBe(false)
  })

  test('makes one key for one task, whatever the case and spacing', () => {
    expect(taskKey(undefined, '  List  AUTH exports ')).toBe(taskKey('general-purpose', 'list auth exports'))
    expect(taskKey('Explore', 'a')).not.toBe(taskKey('Plan', 'a'))
    expect(taskKey('Plan', 'x'.repeat(200)).length < 100).toBe(true)
  })

  test('a key holds the agent type and a hash, and none of the description', () => {
    const key = taskKey('Explore', 'Audit Acme payroll export')
    expect(key.startsWith('Explore|')).toBe(true)
    expect(key.toLowerCase()).not.toMatch(/acme|payroll|audit|export/)
    expect(taskKey('Explore', 'Audit Acme payroll export 2')).not.toBe(key)
  })
})

describe('judging an Agent call', () => {
  test('a complete brief passes unchanged and counts its shape', () => {
    const out = judgeSpawn(brief(), ctx())
    expect(out.verdict).toEqual({ kind: 'pass' })
    expect(out.isFirst).toBe(true)
    expect(out.shape?.tag).toBe(true)
  })

  test('a vague brief is denied once, then goes through with the footer', () => {
    const first = judgeSpawn(brief({ prompt: 'Look around.' }), ctx())
    expect(first.verdict.kind).toBe('deny')
    if (first.verdict.kind !== 'deny') return
    expect(first.verdict.why).toBe('vague')
    expect(first.verdict.reason).toMatch(/not ready/)
    expect(first.key).toBe(taskKey('general-purpose', 'List auth exports'))
    const again = judgeSpawn(brief({ prompt: 'Look around.' }), ctx({ seen: remember([], first.key ?? '') }))
    expect(again.verdict.kind).toBe('rewrite')
    expect(again.isFirst).toBe(false)
  })

  test('an untagged brief is denied once and names the tag', () => {
    const untagged = FULL.replace('[difficulty: routine]\n', '')
    const first = judgeSpawn(brief({ prompt: untagged }), ctx())
    expect(first.verdict.kind).toBe('deny')
    if (first.verdict.kind !== 'deny') return
    expect(first.verdict.why).toBe('untagged')
    expect(first.verdict.reason).toContain('[difficulty: ...]')
    const again = judgeSpawn(brief({ prompt: untagged }), ctx({ seen: [first.key ?? ''] }))
    expect(again.verdict).toEqual({ kind: 'pass' })
  })

  test('a brief that is both vague and untagged is denied once, as vague, naming both', () => {
    const out = judgeSpawn(brief({ prompt: 'Look around.' }), ctx())
    expect(out.verdict.kind === 'deny' && out.verdict.reason).toMatch(/goal, scope.*difficulty/)
  })

  test('requireTag off leaves an untagged brief alone', () => {
    const untagged = FULL.replace('[difficulty: routine]\n', '')
    const out = judgeSpawn(brief({ prompt: untagged }), ctx({ config: { ...CONFIG, requireTag: false } }))
    expect(out.verdict).toEqual({ kind: 'pass' })
  })

  test('a tagged brief without a return format, done-when or no-spawn line gets exactly those lines', () => {
    const out = judgeSpawn(brief({ prompt: BARE }), ctx())
    expect(out.verdict.kind).toBe('rewrite')
    if (out.verdict.kind !== 'rewrite') return
    expect(out.verdict.added).toEqual(['return', 'done', 'nospawn'])
    expect(out.verdict.prompt.startsWith(BARE)).toBe(true)
    expect(out.verdict.prompt).toContain(MARK)
    expect(out.verdict.prompt).toContain('Return format:')
    expect(out.verdict.prompt).toContain('Done when:')
    expect(out.verdict.prompt).toContain('Do not spawn other agents.')
  })

  test('only the missing parts are added', () => {
    const noReturn = FULL.replace('Return format: a numbered list, under 200 words.\n', '')
    const out = judgeSpawn(brief({ prompt: noReturn }), ctx())
    expect(out.verdict.kind === 'rewrite' && out.verdict.added).toEqual(['return'])
  })

  test('the rewrite is idempotent: the rewritten brief passes', () => {
    const first = judgeSpawn(brief({ prompt: BARE }), ctx())
    if (first.verdict.kind !== 'rewrite') throw new Error('expected a rewrite')
    const second = judgeSpawn(brief({ prompt: first.verdict.prompt }), ctx())
    expect(second.verdict).toEqual({ kind: 'pass' })
    expect(withFooter(first.verdict.prompt, { done: false, ret: false, nospawn: false })).toEqual({ prompt: first.verdict.prompt, added: [] })
  })

  test('forks, role agents and other plugins\' agents are not judged and not counted', () => {
    for (const type of ['fork', 'delegate:reviewer', 'statslab:stats-planner']) {
      const out = judgeSpawn(brief({ type, prompt: 'Look around.' }), ctx())
      expect(out.verdict).toEqual({ kind: 'pass' })
      expect(out.shape).toBeUndefined()
      expect(out.isFirst).toBe(false)
    }
  })

  test('normalise off passes everything', () => {
    const out = judgeSpawn(brief({ prompt: 'Look around.' }), ctx({ config: { ...CONFIG, normalise: false } }))
    expect(out.verdict).toEqual({ kind: 'pass' })
    expect(out.shape).toBeUndefined()
  })

  test('a general agent that starts an agent is denied every time', () => {
    for (const callerType of ['general-purpose', 'Explore', 'Plan']) {
      const out = judgeSpawn(brief(), ctx({ isNested: true, callerType }))
      expect(out.verdict.kind === 'deny' && out.verdict.why).toBe('nested')
      const again = judgeSpawn(brief(), ctx({ isNested: true, callerType, seen: [taskKey('general-purpose', 'List auth exports')] }))
      expect(again.verdict.kind === 'deny' && again.verdict.why).toBe('nested')
    }
  })

  test('a general agent may not start any agent: a role, a fork or another plugin\'s agent too, and with normalise off', () => {
    for (const type of ['delegate:scout', 'fork', 'statslab:stats-planner']) {
      const out = judgeSpawn(brief({ type }), ctx({ isNested: true, callerType: 'general-purpose' }))
      expect(out.verdict.kind === 'deny' && out.verdict.why).toBe('nested')
    }
    const off = judgeSpawn(brief(), ctx({ isNested: true, callerType: 'Plan', config: { ...CONFIG, normalise: false } }))
    expect(off.verdict.kind === 'deny' && off.verdict.why).toBe('nested')
    expect(off.shape).toBeDefined()
    expect(judgeSpawn(brief({ type: 'fork' }), ctx({ isNested: true, callerType: 'Plan' })).shape).toBeUndefined()
  })

  test('an orchestrator from another plugin, an unknown caller or blockNested off may start agents', () => {
    expect(judgeSpawn(brief(), ctx({ isNested: true, callerType: 'gsd-debug-session-manager' })).verdict).toEqual({ kind: 'pass' })
    expect(judgeSpawn(brief(), ctx({ isNested: true, callerType: undefined })).verdict).toEqual({ kind: 'pass' })
    expect(judgeSpawn(brief(), ctx({ isNested: true, callerType: 'Explore', config: { ...CONFIG, blockNested: false } })).verdict).toEqual({ kind: 'pass' })
  })

  test('isLoose lets a first-seen vague or untagged brief through with the footer, and still denies a nested call', () => {
    expect(judgeSpawn(brief({ prompt: 'Look around.' }), ctx({ isLoose: true })).verdict.kind).toBe('rewrite')
    expect(judgeSpawn(brief({ prompt: UNTAGGED_FULL }), ctx({ isLoose: true })).verdict).toEqual({ kind: 'pass' })
    expect(judgeSpawn(brief(), ctx({ isLoose: true, isNested: true, callerType: 'Explore' })).verdict.kind).toBe('deny')
  })

  test('remember keeps the newest 40 and ignores a repeat', () => {
    let seen: string[] = []
    for (let i = 0; i < 60; i += 1) seen = remember(seen, `k${i}`)
    expect(seen).toHaveLength(40)
    expect(seen[39]).toBe('k59')
    expect(seen[0]).toBe('k20')
    expect(remember(seen, 'k30')).toBe(seen)
  })
})

/** The cue patterns agent-radar 0.4.0 reads, copied here as a mirror. The footer must match none of them. */
const RADAR_CUES: readonly RegExp[] = [
  /\b(?:implement|add|create|write|edit|modify|fix|update|change|rename|delete|remove|generate|refactor|migrate|commit|push|install)\b/,
  /\b(?:research\w*|compare|comparison|evaluat\w*|assess\w*|recommend\w*|synthesi[sz]\w*|critique|judge|weigh|analy[sz]\w*|argue|justify)\b/,
  /\b(?:review|audit(?:s|ing|ed)?|critique|verification|adversarial|red[- ]team)\b/,
  /\b(?:root[- ]?cause|diagnos\w*|debug\w*|race condition|deadlock|memory leak|flaky)\b/,
  /\b(?:architect\w*|trade-?offs?|rfc|design (?:a|an|the|doc)\b)/,
  /\b(?:security|vulnerab\w*|threat model|exploit|injection)\b/,
  /\b(?:optimi[sz]\w*|performance|bottleneck|profil\w*)\b/,
  /\b(?:prove|proof|invariant|correctness|algorithm|concurren\w*|distributed)\b/,
  /\b(?:why (?:does|is|do|did|are)|figure out why|investigate)\b/,
  /\b(?:find|locate|list|enumerate|where (?:is|are|does)|which (?:files?|functions?|modules?|tests?)|grep|search for|look ?up|inventory)\b/,
  /\b(?:summari[sz]e|overview|survey|map out|outline)\b/,
  /\bread[- ]only\b|\b(?:do not|don't|never|without)\s+(?:modify|edit|write|change|touch|delete|create|commit)\b/,
  /\b(?:think (?:hard|carefully|deeply)|ultrathink|very thorough|maximum effort|take your time)\b/,
  /\b(?:typo|one[- ]liner|trivial(?:ly)?|bump (?:the )?version|reformat|lint fix)\b/,
  /[\w.-]+\/[\w./-]+\.\w{1,6}\b/,
]

describe('the footer and agent-radar', () => {
  test('the footer matches none of the cue patterns radar reads, so it cannot change a routing', () => {
    const footer = withFooter('x', { done: false, ret: false, nospawn: false }).prompt.slice(1).toLowerCase()
    expect(footer.length > 200).toBe(true)
    for (const cue of RADAR_CUES) expect(cue.test(footer)).toBe(false)
  })

  test('radar sees the same tag after the rewrite, because the footer sits at the end', () => {
    const out = judgeSpawn(brief({ prompt: BARE }), ctx())
    if (out.verdict.kind !== 'rewrite') throw new Error('expected a rewrite')
    expect(shapeOf('x', out.verdict.prompt).tag).toBe(true)
    expect(out.verdict.prompt.slice(0, 20)).toBe('[difficulty: lookup]')
  })

  test('the fixed texts carry no brace, no placeholder and no description', () => {
    for (const text of [POLICY_TEXT, AGENT_NOTE, EMPTY_NOTE, nudgeText(8)]) {
      expect(text).not.toMatch(/\$\{|undefined|NaN|\[object/)
    }
    expect(nudgeText(9)).toContain('9 read-only calls')
    expect(POLICY_TEXT).toContain('delegate:scout')
  })
})

describe('caps', () => {
  const cfg = { maxLive: 6, maxTurn: 8, maxSession: 25 }

  test('a cap holds at its number and not before', () => {
    expect(capCheck(5, 0, 0, cfg)).toBeUndefined()
    expect(capCheck(6, 0, 0, cfg)?.why).toBe('live')
    expect(capCheck(0, 7, 0, cfg)).toBeUndefined()
    expect(capCheck(0, 8, 0, cfg)?.why).toBe('turn')
    expect(capCheck(0, 0, 24, cfg)).toBeUndefined()
    expect(capCheck(0, 0, 25, cfg)?.why).toBe('session')
  })

  test('the live cap is named first, and a cap of 0 is off', () => {
    expect(capCheck(9, 9, 99, cfg)?.why).toBe('live')
    expect(capCheck(99, 99, 99, { maxLive: 0, maxTurn: 0, maxSession: 0 })).toBeUndefined()
  })

  test('the reasons tell the model what to do', () => {
    expect(capCheck(6, 0, 0, cfg)?.reason).toMatch(/Wait for a completion notice/)
    expect(capCheck(0, 8, 0, cfg)?.reason).toMatch(/fewer agents/)
    expect(capCheck(0, 0, 25, cfg)?.reason).toMatch(/Ask the person/)
  })
})

describe('read-only runs', () => {
  test('the reading tools count, and a Bash command counts only when it starts with a read command and writes nothing', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) expect(isReadOnly(tool)).toBe(true)
    for (const cmd of ['ls -la', 'cat a.ts | head -5', 'cd /x && grep -rn foo .', 'git log --oneline', 'git diff', 'find . -name "*.ts"', 'wc -l a']) expect(isReadOnly('Bash', cmd)).toBe(true)
    for (const cmd of ['rm a', 'cat a > b', 'git commit -m x', 'npm test', 'find . -delete', 'find . -exec rm {} ;', 'ls | tee out', 'sed -i s/a/b/ f', 'echo hi', 'mkdir x']) expect(isReadOnly('Bash', cmd)).toBe(false)
    for (const tool of ['Edit', 'Write', 'Agent', 'Skill']) expect(isReadOnly(tool)).toBe(false)
    expect(isReadOnly('Bash')).toBe(false)
  })

  test('a run grows with reads, keeps through an Agent call and ends on any other tool', () => {
    let run = 0
    run = runAfter(run, 'Read')
    run = runAfter(run, 'Bash', 'ls')
    expect(run).toBe(2)
    expect(runAfter(run, 'Agent')).toBe(2)
    expect(runAfter(run, 'Edit')).toBe(0)
    expect(runAfter(run, 'Bash', 'npm test')).toBe(0)
  })
})

describe('stored values', () => {
  test('a counts value from an older or damaged state is filled and clean', () => {
    const odd = fillCounts({ key: 5, spawns: 3, denied: { vague: 2, bogus: 9 }, tokens: -4, tag: 'x', extra: 1 })
    expect(odd.key).toBe(5)
    expect(odd.spawns).toBe(3)
    expect(odd.tokens).toBe(0)
    expect(odd.tag).toBe(0)
    expect(odd.denied).toEqual({ vague: 2, untagged: 0, nested: 0, live: 0, turn: 0, session: 0 })
    expect(Object.keys(odd).sort()).toEqual(Object.keys(emptyCounts()).sort())
    for (const bad of [undefined, null, 'x', 7, [], NaN]) expect(fillCounts(bad)).toEqual(emptyCounts())
  })

  test('counts survive a JSON round trip', () => {
    const c = countDeny(countShape(emptyCounts(7), shapeOf('d', FULL)), 'nested')
    expect(fillCounts(JSON.parse(JSON.stringify(c)))).toStrictEqual(c)
  })

  test('gate, seen and control are filled the same way', () => {
    expect(fillGate({ five: 61, fiveLevel: 9, tokenLevel: -1, seven: 'x' })).toEqual({ five: 61, fiveLevel: 2, tokenLevel: 0 })
    expect(fillGate(null)).toEqual(emptyGate())
    expect(fillSeen(['a', 3, 'b'])).toEqual(['a', 'b'])
    expect(fillSeen('x')).toEqual([])
    expect(fillSeen(Array.from({ length: 90 }, (_, i) => `k${i}`))).toHaveLength(40)
    expect(fillControl(undefined)).toEqual({ on: true })
    expect(fillControl({ on: false })).toEqual({ on: false })
    expect(fillControl({ on: 'no' })).toEqual({ on: true })
  })

  test('options fall back to the defaults for a value of the wrong kind', () => {
    expect(configOf({})).toEqual(DEFAULTS)
    expect(configOf({ nudgeRun: 'x', maxLive: -1, normalise: 'yes', warnTokens: NaN })).toEqual(DEFAULTS)
    expect(configOf({ nudgeRun: 0, maxLive: 0, normalise: false }).nudgeRun).toBe(0)
    expect(configOf({ maxLive: 3 }).maxLive).toBe(3)
  })

  test('sums add every field and keep the denied kinds apart', () => {
    const a = countDeny(emptyCounts(1), 'live')
    const b = { ...countDeny(emptyCounts(2), 'nested'), spawns: 4, tokens: 10 }
    const total = sumCounts([a, b])
    expect(total.spawns).toBe(4)
    expect(total.tokens).toBe(10)
    expect(total.denied.live).toBe(1)
    expect(total.denied.nested).toBe(1)
    expect(total.key).toBe(0)
  })
})

describe('warnings', () => {
  const cfg = { warnTokens: 2_500_000, alertTokens: 5_000_000, warnWindow: 80, alertWindow: 92 }

  test('each level shows once and a toast never denies anything', () => {
    let gate = emptyGate()
    let r = gateAfter(gate, { five: 79, tokens: 0 }, cfg)
    expect(r.toasts).toEqual([])
    gate = r.gate
    r = gateAfter(gate, { five: 83, tokens: 0 }, cfg)
    expect(r.toasts).toHaveLength(1)
    expect(r.toasts[0]).toMatch(/83%/)
    gate = r.gate
    r = gateAfter(gate, { five: 85, tokens: 0 }, cfg)
    expect(r.toasts).toEqual([])
    r = gateAfter(r.gate, { five: 95, tokens: 0 }, cfg)
    expect(r.toasts).toHaveLength(1)
    expect(r.toasts[0]).toMatch(/last of it/)
  })

  test('the window level comes back after the window falls under its warning', () => {
    const up = gateAfter(emptyGate(), { five: 90, tokens: 0 }, cfg)
    const down = gateAfter(up.gate, { five: 10, tokens: 0 }, cfg)
    expect(down.gate.fiveLevel).toBe(0)
    expect(gateAfter(down.gate, { five: 81, tokens: 0 }, cfg).toasts).toHaveLength(1)
  })

  test('the token level only rises', () => {
    const a = gateAfter(emptyGate(), { tokens: 2_600_000 }, cfg)
    expect(a.toasts[0]).toMatch(/2\.6M tokens/)
    const b = gateAfter(a.gate, { tokens: 100 }, cfg)
    expect(b.gate.tokenLevel).toBe(1)
    expect(b.toasts).toEqual([])
    expect(gateAfter(b.gate, { tokens: 5_100_000 }, cfg).toasts[0]).toMatch(/alert/)
  })

  test('a limit of 0 is off, and a missing window shows nothing', () => {
    const off = { warnTokens: 0, alertTokens: 0, warnWindow: 0, alertWindow: 0 }
    expect(gateAfter(emptyGate(), { five: 99, tokens: 99_000_000 }, off).toasts).toEqual([])
    expect(gateAfter(emptyGate(), { tokens: 0 }, cfg).toasts).toEqual([])
  })

  test('tokens count input, cache writes and output, and not cache reads', () => {
    expect(tokensOf({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100 })).toBe(115)
    expect(tokensOf({ input_tokens: NaN, output_tokens: -3, cache_creation_input_tokens: 2 })).toBe(2)
    expect(fmtTokens(2_540_000)).toBe('2.5M')
    expect(fmtTokens(48_200)).toBe('48k')
    expect(fmtTokens(12)).toBe('12')
  })

  test('an empty answer is blank or a stray mark, and a short real answer is not', () => {
    expect(isEmptyAnswer('')).toBe(true)
    expect(isEmptyAnswer('   ')).toBe(true)
    expect(isEmptyAnswer(' . ')).toBe(true)
    expect(isEmptyAnswer('RESULT: 7')).toBe(false)
    expect(isEmptyAnswer('none')).toBe(false)
  })
})

describe('thresholds', () => {
  test('a level starts exactly at its limit', () => {
    expect(levelOf(79.99, 80, 92)).toBe(0)
    expect(levelOf(80, 80, 92)).toBe(1)
    expect(levelOf(91.99, 80, 92)).toBe(1)
    expect(levelOf(92, 80, 92)).toBe(2)
    expect(levelOf(2_499_999, 2_500_000, 5_000_000)).toBe(0)
    expect(levelOf(2_500_000, 2_500_000, 5_000_000)).toBe(1)
    expect(levelOf(5_000_000, 2_500_000, 5_000_000)).toBe(2)
    expect(levelOf(undefined, 80, 92)).toBe(0)
    expect(levelOf(50, 0, 0)).toBe(0)
  })

  test('the memory of denied tasks holds the newest 40, one step at a time', () => {
    let seen: string[] = []
    for (let i = 1; i <= 100; i += 1) {
      seen = remember(seen, `k${i}`)
      expect(seen).toHaveLength(Math.min(i, 40))
      expect(seen[seen.length - 1]).toBe(`k${i}`)
      expect(seen[0]).toBe(`k${Math.max(1, i - 39)}`)
    }
  })
})

describe('the score and the command', () => {
  test('no data gives no number, and each part is a share', () => {
    expect(scoreOf(emptyCounts())).toEqual({ shape: undefined, decision: undefined, parallel: undefined, headline: undefined })
    const c = { ...emptyCounts(), checked: 10, tag: 5, scope: 10, done: 0, ret: 5, nospawn: 0, triggers: 4, triggersDelegated: 1, multi: 2, multiParallel: 2 }
    const s = scoreOf(c)
    expect(s.shape).toBe(40)
    expect(s.decision).toBe(25)
    expect(s.parallel).toBe(100)
    expect(s.headline).toBe(55)
  })

  test('the score text names every part and says when there is nothing yet', () => {
    expect(scoreText(emptyCounts(), 'this session')).toContain('no data yet')
    const text = scoreText({ ...emptyCounts(), checked: 2, tag: 1, triggers: 2, triggersDelegated: 1 }, 'this session')
    expect(text).toMatch(/Shape \d+%/)
    expect(text).toMatch(/1 of 2 read-heavy turns/)
    expect(text).toMatch(/Denied: vague 0/)
  })

  test('the status says the version, the caps and that nothing is denied for tokens or the window', () => {
    const text = statusText({ counts: emptyCounts(), gate: { fiveLevel: 0, tokenLevel: 0, five: 41.4 }, isOn: true, live: 2, config: DEFAULTS })
    expect(text).toContain(`delegate ${VERSION}: on`)
    expect(text).toContain('8 at once, 16 a turn, 25 a session')
    expect(text).toContain('Nudge after 6 read-only calls in a row')
    expect(text).toContain('Five-hour window 41%')
    expect(text).toContain('nothing is denied for tokens or the window')
    expect(statusText({ counts: emptyCounts(), gate: emptyGate(), isOn: false, live: 0, config: { ...DEFAULTS, maxLive: 0 } })).toContain('off. ')
    expect(statusText({ counts: emptyCounts(), gate: emptyGate(), isOn: true, live: 0, config: { ...DEFAULTS, nudgeRun: 0 } })).toContain('Nudge off.')
    expect(statusText({ counts: emptyCounts(), gate: emptyGate(), isOn: true, live: 0, config: { ...DEFAULTS, nudge: false } })).toContain('Nudge off.')
  })

  test('the words after /delegate', () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs(' STATUS ')).toEqual({ kind: 'status' })
    expect(parseArgs('score')).toEqual({ kind: 'score', isAll: false })
    expect(parseArgs('score all')).toEqual({ kind: 'score', isAll: true })
    expect(parseArgs('on')).toEqual({ kind: 'on' })
    expect(parseArgs('off')).toEqual({ kind: 'off' })
    expect(parseArgs('reset')).toEqual({ kind: 'reset' })
    expect(parseArgs('banana').kind).toBe('bad')
  })
})

describe('seeded fuzz of the judgement', () => {
  /** A small linear congruential generator, so a failure replays. */
  function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
  }
  const PARTS = {
    tag: '[difficulty: careful]',
    scope: 'Do not edit any file.',
    done: 'Done when the list is complete.',
    ret: 'Return format: a table, under 150 words.',
    nospawn: 'Do not spawn agents.',
    anchor: 'Look at /home/me/proj/src/a.ts and `parseArgs`.',
  } as const
  const TYPES = [undefined, 'general-purpose', 'Explore', 'Plan', 'fork', 'delegate:scout', 'statslab:stats-planner']

  test('over 4000 random briefs: the verdict is consistent, the rewrite is idempotent and no text is invented', () => {
    const rand = lcg(20261008)
    for (let i = 0; i < 4000; i += 1) {
      const chosen = (Object.keys(PARTS) as (keyof typeof PARTS)[]).filter(() => rand() < 0.5)
      const filler = 'word '.repeat(Math.floor(rand() * 60))
      const prompt = [...chosen.map(k => PARTS[k]), filler].join('\n').trim() || 'x'
      const type = TYPES[Math.floor(rand() * TYPES.length)]
      const desc = `task ${Math.floor(rand() * 5)}`
      const seen = rand() < 0.3 ? [taskKey(type, desc)] : []
      const isNested = rand() < 0.2
      const callerType = rand() < 0.5 ? 'Explore' : 'gsd-executor'
      const out = judgeSpawn({ type, description: desc, prompt }, ctx({ isNested, callerType, seen }))
      const v = out.verdict
      const judged = isGeneric(type) && type !== 'fork'
      const isBlocked = isNested && callerType === 'Explore'
      if (isBlocked) {
        expect(v.kind === 'deny' && v.why).toBe('nested')
        continue
      }
      if (!judged) {
        expect(v.kind).toBe('pass')
        expect(out.shape).toBeUndefined()
        continue
      }
      if (v.kind === 'deny') {
        expect(v.why).not.toBe('nested')
        {
          expect(out.key).toBe(taskKey(type, desc))
          expect(seen).toHaveLength(0)
        }
        expect(v.reason.length > 40).toBe(true)
      } else if (v.kind === 'rewrite') {
        expect(v.prompt.startsWith(prompt.replace(/\s+$/, ''))).toBe(true)
        const again = judgeSpawn({ type, description: desc, prompt: v.prompt }, ctx({ seen: [taskKey(type, desc)] }))
        expect(again.verdict.kind).toBe('pass')
        const extra = v.prompt.slice(prompt.replace(/\s+$/, '').length)
        expect(extra.includes(desc)).toBe(false)
      } else {
        expect(shapeOf(desc, prompt).ret && shapeOf(desc, prompt).done && shapeOf(desc, prompt).nospawn).toBe(true)
      }
    }
  })

  test('the score stays between 0 and 100 for any counts', () => {
    const rand = lcg(7)
    for (let i = 0; i < 500; i += 1) {
      const n = (): number => Math.floor(rand() * 20)
      const checked = n()
      const c = { ...emptyCounts(), checked, tag: Math.min(checked, n()), scope: Math.min(checked, n()), done: Math.min(checked, n()), ret: Math.min(checked, n()), nospawn: Math.min(checked, n()) }
      const s = scoreOf(c)
      for (const v of [s.shape, s.headline]) if (v !== undefined) expect(v >= 0 && v <= 100).toBe(true)
    }
  })
})
