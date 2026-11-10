// delegate: consistent subagent deployment. agent-radar picks a subagent's model and effort;
// this mod decides whether to delegate, how many, and what shape the brief has.
//
// What it does: adds a short policy to the system prompt and the Agent tool's description;
// sends the model one note when a turn makes a long run of read-only calls with no agent;
// checks each Agent call (deny once if the brief is vague or untagged, then add a footer with
// a return format, a done-when line and a no-spawn line; refuse an agent that starts agents);
// caps how many agents run, start in a turn and start in a session; toasts at token and
// five-hour-window levels (it never denies for those); counts everything for /delegate score.
//
// What it reads: tool names, the fields of an Agent call, usage numbers, rate-limit percents,
// the agent list. A subagent's answer is only measured for length, never kept or copied.
// What it calls on `$`: agent.list, clock.now, command.register, session.append,
// session.usage, state.*, store.*, ui.toast. No network, file or process call.
//
// Order with agent-radar: the content of an Agent call is rewritten here, in `tool.call`,
// which runs before `agent.spawn`. The `agent.spawn` hook below only counts and denies, and
// passes the event on unchanged, so the two mods can never rewrite the same field.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Control, Counts, Gate, Seen } from '../types'
import {
  AGENT_NOTE,
  EMPTY_NOTE,
  POLICY_SECTION_ID,
  POLICY_TEXT,
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
  gateAfter,
  isEmptyAnswer,
  judgeSpawn,
  nudgeText,
  parseArgs,
  remember,
  runAfter,
  scoreText,
  statusText,
  sumCounts,
  tokensOf,
} from './policy'
import type { Config } from './policy'

const counts = atom({ plugin: 'delegate', key: 'counts' } as const, emptyCounts())
const gate = atom({ plugin: 'delegate', key: 'gate' } as const, emptyGate())
const seen = atom({ plugin: 'delegate', key: 'seen' } as const, [] as Seen)
const control = atom({ plugin: 'delegate', key: 'control' } as const, { on: true } as Control)

/** Agents that start within this many milliseconds of each other count as started together. */
const TOGETHER_MS = 3000
/** After this many refused briefs in one turn, the check lets the rest through. */
const BRIEF_DENY_LIMIT = 3
/** How many sessions' counts the store keeps. */
const KEEP_SESSIONS = 30
const STORE_PREFIX = 'score:'

/** What one main turn has done so far. Lives in the module: a reload in the middle of a turn only loses it. */
type TurnMemo = { run: number; agents: number; stamps: number[]; nudged: boolean; trigger: boolean; briefDenies: number }
const freshTurn = (): TurnMemo => ({ run: 0, agents: 0, stamps: [], nudged: false, trigger: false, briefDenies: 0 })

let turnNow: TurnMemo = freshTurn()
/** Agents past the cap check whose start has not answered yet. A burst of starts claims its places here before any of them awaits. */
let inflight = 0
/** Agents this session has started, kept here so that a burst of starts sees the same number. -1 means: read it from the state first. */
let sessionSpawns = -1
/** Notes for the model, sent before its next request. Fixed text only. */
let pending: string[] = []
let isOn = true

/** Runs work that must never break the call it rides on. */
async function guard(work: () => unknown): Promise<void> {
  try {
    await work()
  } catch {
    // A failed count costs a number, never a turn.
  }
}

async function commitCounts($: EngineInterface, fn: (value: Counts) => Counts): Promise<void> {
  await update($, counts, value => fn(fillCounts(value)))
}

async function commitGate($: EngineInterface, fn: (value: Gate) => Gate): Promise<void> {
  await update($, gate, value => fn(fillGate(value)))
}

async function commitSeen($: EngineInterface, fn: (value: Seen) => Seen): Promise<void> {
  await update($, seen, value => fn(fillSeen(value)))
}

async function commitControl($: EngineInterface, fn: (value: Control) => Control): Promise<void> {
  await update($, control, value => fn(fillControl(value)))
}

async function countsNow($: EngineInterface): Promise<Counts> {
  return fillCounts(await read($, counts))
}

async function gateNow($: EngineInterface): Promise<Gate> {
  return fillGate(await read($, gate))
}

async function seenNow($: EngineInterface): Promise<Seen> {
  return fillSeen(await read($, seen))
}

async function controlNow($: EngineInterface): Promise<Control> {
  return fillControl(await read($, control))
}

/** Agents that run now, not counting teammates. A failed read counts as none: the cap fails open. */
async function liveAgents($: EngineInterface): Promise<number> {
  try {
    const rows = await $.agent.list()

    return rows.filter(row => row.teammateId === undefined && (row.status === 'running' || row.status === 'pending')).length
  } catch {
    return 0
  }
}

/** The type of the agent that made a call, or undefined when the list does not name it. */
async function callerType($: EngineInterface, id: string): Promise<string | undefined> {
  try {
    const rows = await $.agent.list()

    return rows.find(row => row.id === id)?.type
  } catch {
    return undefined
  }
}

/** Starts the counts for this session. A reload of the mod keeps the counts it has. */
async function startSession($: EngineInterface, isForced: boolean): Promise<void> {
  const usage = await $.session.usage()
  const had = await countsNow($)
  if (!isForced && had.key === usage.startedAt) return
  await commitCounts($, () => emptyCounts(usage.startedAt))
  await commitGate($, () => emptyGate())
  await commitSeen($, () => [])
  sessionSpawns = -1
}

/** A /clear starts the conversation over: the counts, the memory of denied tasks and the pending notes go. */
async function forget($: EngineInterface): Promise<void> {
  await commitCounts($, () => emptyCounts(0))
  await commitGate($, () => emptyGate())
  await commitSeen($, () => [])
  pending = []
  turnNow = freshTurn()
  sessionSpawns = -1
}

/** Sets the session key when a /clear left it at 0. */
async function ensureKey($: EngineInterface): Promise<void> {
  const had = await countsNow($)
  if (had.key !== 0) return
  const usage = await $.session.usage()
  await commitCounts($, value => (value.key === 0 ? { ...value, key: usage.startedAt } : value))
}

/** Keeps this session's counts in the store, and drops the oldest sessions beyond the newest 30. */
async function snapshot($: EngineInterface): Promise<void> {
  const mine = await countsNow($)
  if (mine.key === 0) return
  await $.store.set(`${STORE_PREFIX}${mine.key}`, mine)
}

async function prune($: EngineInterface): Promise<void> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(STORE_PREFIX))
  const old = keys.sort((a, b) => Number(b.slice(STORE_PREFIX.length)) - Number(a.slice(STORE_PREFIX.length))).slice(KEEP_SESSIONS)
  for (const key of old) await $.store.delete(key)
}

async function allSessions($: EngineInterface): Promise<{ total: Counts; n: number }> {
  const mine = await countsNow($)
  const list: Counts[] = []
  for (const key of (await $.store.keys()).filter(one => one.startsWith(STORE_PREFIX))) {
    if (key === `${STORE_PREFIX}${mine.key}`) continue
    list.push(fillCounts(await $.store.get(key)))
  }
  list.push(mine)

  return { total: sumCounts(list), n: list.length }
}

/** Folds the token total and the window percents into the gate and shows the toasts that earns. Warn only. */
async function foldGate($: EngineInterface, config: Config, patch: { five?: number; seven?: number }): Promise<void> {
  const total = (await countsNow($)).tokens
  // One read-modify-write, so that two events at once cannot overwrite each other: the toasts
  // are the ones the write that stood earned (the updater runs again on a version miss).
  let toasts: string[] = []
  await update($, gate, value => {
    const before = fillGate(value)
    const out = gateAfter(before, { five: patch.five ?? before.five, seven: patch.seven ?? before.seven, tokens: total }, config)
    toasts = out.toasts

    return out.gate
  })
  for (const text of toasts) $.ui.toast(text)
}

/** True when the agent list names this id and it is not a fork: an engine fork (compaction, memory) is not a subagent of the model's. */
async function isNamedSubagent($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.agent.list()).some(row => row.id === id && row.type !== 'fork')
  } catch {
    return false
  }
}

export const register: Register = (on, options) => {
  const config: Config = configOf(options)

  on('session.start', async ($, e, next) => {
    await guard(() =>
      $.command.register({
        name: 'delegate',
        description: 'Delegation status and score: /delegate | status | score [all] | on | off | reset',
      }),
    )
    await guard(async () => {
      await startSession($, false)
      isOn = (await controlNow($)).on
      await prune($)
    })

    return next(e)
  })

  on('command.run', { command: 'delegate' }, async ($, e) => {
    const asked = parseArgs(e.args)
    if (asked.kind === 'bad') return { text: asked.usage }
    if (asked.kind === 'on' || asked.kind === 'off') {
      isOn = asked.kind === 'on'
      await commitControl($, () => ({ on: isOn }))

      return {
        text: isOn
          ? 'delegate is on.'
          : 'delegate is off: no nudge, no check and no cap. The policy text in the system prompt stays until the next session.',
      }
    }
    if (asked.kind === 'reset') {
      await guard(() => startSession($, true))
      // The cleared counts no longer hold this turn's trigger: a turn that ends after a reset is
      // not credited against a trigger that is gone (it broke triggersDelegated <= triggers).
      turnNow = freshTurn()

      return { text: 'Counts cleared.' }
    }
    if (asked.kind === 'score') {
      if (!asked.isAll) return { text: scoreText(await countsNow($), 'this session') }
      const all = await allSessions($)

      return { text: scoreText(all.total, `all ${all.n} stored sessions`) }
    }

    return {
      text: statusText({
        counts: await countsNow($),
        gate: await gateNow($),
        isOn,
        live: await liveAgents($),
        config,
      }),
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const base = await next(e)
    if (!config.policyText || e.traits.includes('bare') || e.traits.includes('teammate')) return base
    if (base.sections.some(section => section.id === POLICY_SECTION_ID)) return base

    return { sections: [...base.sections, { id: POLICY_SECTION_ID, text: POLICY_TEXT, scope: 'session' }] }
  })

  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const base = await next(e)
    if (!config.policyText || base.description.includes(AGENT_NOTE)) return base

    return { ...base, description: `${base.description}\n\n${AGENT_NOTE}` }
  })

  on('turn.start', async ($, e, next) => {
    turnNow = freshTurn()
    await guard(() => ensureKey($))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // The main thread's read-only run. A subagent's calls are not counted here.
    if (isOn && e.agentId === undefined) {
      turnNow.run = runAfter(turnNow.run, e.tool, e.tool === 'Bash' ? e.command : undefined)
      if (config.nudgeRun > 0 && turnNow.run >= config.nudgeRun && !turnNow.trigger) {
        turnNow.trigger = true
        // Counted for the score even when the note itself is off.
        const isNudging = config.nudge && turnNow.agents === 0
        if (isNudging) turnNow.nudged = true
        if (isNudging) pending.push(nudgeText(turnNow.run))
        await guard(() => commitCounts($, value => ({ ...value, triggers: value.triggers + 1, nudges: value.nudges + (isNudging ? 1 : 0) })))
      }
    }
    if (e.tool !== 'Agent' || !isOn) return next(e)

    // An Agent call: judge the brief, then pass it on as it is, with a footer, or refused.
    let nested = false
    let callerKind: string | undefined
    if (e.agentId !== undefined) {
      nested = true
      callerKind = await callerType($, e.agentId)
    }
    const known = await seenNow($)
    // The call may arrive malformed (the tool's own check comes later): read only strings.
    const judged = judgeSpawn(
      {
        type: typeof e.subagent_type === 'string' ? e.subagent_type : undefined,
        description: typeof e.description === 'string' ? e.description : '',
        prompt: typeof e.prompt === 'string' ? e.prompt : '',
      },
      { isNested: nested, callerType: callerKind, config, seen: known, isLoose: turnNow.briefDenies >= BRIEF_DENY_LIMIT },
    )
    const { verdict, shape } = judged
    await guard(async () => {
      if (shape !== undefined && judged.isFirst) await commitCounts($, value => countShape(value, shape))
      if (verdict.kind === 'deny') await commitCounts($, value => countDeny(value, verdict.why))
      if (verdict.kind === 'rewrite') await commitCounts($, value => ({ ...value, footers: value.footers + 1 }))
      const key = judged.key
      if (verdict.kind === 'deny' && key !== undefined) await commitSeen($, value => remember(value, key))
    })
    if (verdict.kind === 'deny') {
      if (verdict.why === 'vague' || verdict.why === 'untagged') turnNow.briefDenies += 1

      return { deny: verdict.reason }
    }
    if (verdict.kind === 'rewrite') return next({ ...e, prompt: verdict.prompt })

    return next(e)
  })

  // Caps and counts. This hook never changes the event: agent-radar's model pick runs beside it untouched.
  on('agent.spawn', async ($, e, next) => {
    if (!isOn || e.fork || e.workflow !== undefined || e.isTeammate === true) return next(e)
    const live = await liveAgents($)
    if (sessionSpawns < 0) {
      const have = (await countsNow($)).spawns
      if (sessionSpawns < 0) sessionSpawns = have
    }
    // The check and the claim are one step, with no await between them, so that a burst of
    // starts in one message cannot all read the same numbers. The running cap is close, not exact:
    // the agent list may not name an agent that has just started.
    const refused = capCheck(live + inflight, turnNow.agents + inflight, sessionSpawns + inflight, config)
    if (refused !== undefined) {
      await guard(() => commitCounts($, value => countDeny(value, refused.why)))

      return { deny: refused.reason }
    }
    inflight += 1
    let started
    try {
      started = await next(e)
    } finally {
      inflight -= 1
    }
    if (started.deny === undefined && started.agentId !== undefined) {
      turnNow.agents += 1
      sessionSpawns += 1
      turnNow.stamps.push(await $.clock.now())
      await guard(() => commitCounts($, value => ({ ...value, spawns: value.spawns + 1 })))
    }

    return started
  })

  on('turn.step', async function* ($, e, next) {
    // Notes wait for a main-loop request, so that a row never lands between a tool call and its result.
    if (e.agentId === undefined && pending.length > 0) {
      const notes = isOn ? pending : []
      pending = []
      if (notes.length > 0) {
        await guard(() => $.session.append({ message: { type: 'user', content: [{ type: 'text', text: notes.join('\n\n') }] } }))
      }
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Only the length of an answer is read, and only to see whether it is blank. A stopped agent is not blank.
    const isEmpty = !e.isAborted && isEmptyAnswer(typeof e.answer === 'string' ? e.answer : '')
    const usage = e.usage
    if (e.agentId !== undefined) {
      if (usage !== undefined) {
        const add = tokensOf(usage)
        await guard(async () => {
          await commitCounts($, value => ({ ...value, tokens: value.tokens + add }))
          await foldGate($, config, {})
        })
      }
      if (isEmpty && isOn && (await isNamedSubagent($, e.agentId))) {
        await guard(() => commitCounts($, value => ({ ...value, empty: value.empty + 1 })))
        if (!pending.includes(EMPTY_NOTE)) pending.push(EMPTY_NOTE)
      }

      // A subagent's text is its answer to its parent: it passes through untouched.
      return next(e)
    }
    const ended = turnNow
    await guard(async () => {
      if (isOn && ended.trigger && ended.agents > 0) {
        await commitCounts($, value => ({ ...value, triggersDelegated: value.triggersDelegated + 1 }))
      }
      if (isOn && ended.agents >= 2) {
        const first = Math.min(...ended.stamps)
        const last = Math.max(...ended.stamps)
        const together = ended.stamps.length >= 2 && last - first <= TOGETHER_MS
        await commitCounts($, value => ({ ...value, multi: value.multi + 1, multiParallel: value.multiParallel + (together ? 1 : 0) }))
      }
      await snapshot($)
    })
    // The next turn starts its own count; the agents of this one are done being counted.
    turnNow = freshTurn()

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await guard(() =>
      foldGate($, config, {
        five: e.rateLimits.find(limit => limit.kind === 'five_hour')?.percentUsed,
        seven: e.rateLimits.find(limit => limit.kind === 'seven_day')?.percentUsed,
      }),
    )

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await guard(() => forget($))

    return next(e)
  })
}
