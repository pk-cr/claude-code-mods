// Turns engine events into plain facts: what a tool call did and which files it touched, whether it
// started background work, the text a person typed, the first line of a reply, the question a reply
// ends on. Pure: no `$`, no clock.
//
// classify(), stripPromptMarkers() and the notification reader are adapted from Conversation Atlas by
// NeelAPatel (MIT, see LICENSE and NOTICE.md).

import type { AtlasActivityKind } from '../types'

type Input = Record<string, unknown>

export const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function rawOf(value: unknown): Input {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Input) : {}
}

export function clip(value: unknown, max = 120): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

export function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function words(value: string): Set<string> {
  return new Set(norm(value).split(' ').filter(w => w.length > 2))
}

// Loose match for "the same item said twice": equal after normalizing, one long text holding the other,
// or most of the shorter text's words shared.
export function similar(a: string, b: string): boolean {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  if (Math.min(x.length, y.length) >= 12 && (x.includes(y) || y.includes(x))) return true
  const wa = words(a)
  const wb = words(b)
  if (wa.size < 2 || wb.size < 2) return false
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared += 1
  return shared / Math.min(wa.size, wb.size) >= 0.6
}

export function sentences(text: string): string[] {
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? [text]).map(p => p.trim()).filter(Boolean)
}

export function posix(path: string): string {
  return path.replace(/\\/g, '/')
}

export function base(path: string): string {
  const p = posix(path).replace(/\/+$/, '')
  return p.slice(p.lastIndexOf('/') + 1) || p
}

const TEST_CMD = /(^|[\s;&|(])((npm|pnpm|yarn|bun)( run)? test|npx (vitest|jest|mocha|playwright)|vitest|jest|pytest|py\.test|cargo test|go test|dotnet test|mvn test|gradle test|node --test|deno test|claude plugin test|plugin test|rspec|phpunit|ctest|make (test|check))\b/
const GIT_CMD = /(^|[\s;&|(])(git|gh)\s+(\w+)/

// Tools that feed a section of their own instead of an activity row.
export const TASK_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])
export const CHAPTER_TOOL = 'mcp__ccd_session__mark_chapter'
export const SESSION_TOOLS: ReadonlySet<string> = new Set(['mcp__ccd_session__start_session', 'mcp__ccd_session__hand_off_to_session'])
export const GOAL_TOOL = 'ProposeGoal'

export type Classified = { kind: AtlasActivityKind; label: string; files: { path: string; op: 'read' | 'write' }[] }

// One activity row for a tool call, with the files it read or wrote. Null for tools shown elsewhere.
export function classify(tool: string, input: Input): Classified | null {
  if (TASK_TOOLS.has(tool) || tool === CHAPTER_TOOL || tool === 'ToolSearch') return null
  const none: Classified['files'] = []
  switch (tool) {
    case 'Read': {
      const path = posix(str(input.file_path))
      return { kind: 'read', label: `Read ${base(path)}`, files: path ? [{ path, op: 'read' }] : none }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = posix(str(input.file_path) || str(input.notebook_path))
      return { kind: 'edit', label: `${tool === 'Write' ? 'Write' : 'Edit'} ${base(path)}`, files: path ? [{ path, op: 'write' }] : none }
    }
    case 'Grep':
      return { kind: 'search', label: `Search "${clip(input.pattern, 40)}"`, files: none }
    case 'Glob':
      return { kind: 'search', label: `Find ${clip(input.pattern, 40)}`, files: none }
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command)
      const short = clip((command.split('\n')[0] ?? '').replace(/^cd\s+\S+\s*&&\s*/, ''), 60)
      const description = clip(input.description, 60)
      if (TEST_CMD.test(command)) return { kind: 'test', label: `Tests: ${description || short}`, files: none }
      const git = GIT_CMD.exec(command)
      if (git) return { kind: 'git', label: `${git[2]} ${git[3]}${description ? ` · ${description}` : ''}`, files: none }
      return { kind: 'bash', label: description || short || 'Shell command', files: none }
    }
    case 'WebFetch':
      return { kind: 'web', label: `Fetch ${clip(str(input.url).replace(/^https?:\/\//, ''), 50)}`, files: none }
    case 'WebSearch':
      return { kind: 'web', label: `Search web "${clip(input.query, 40)}"`, files: none }
    case 'Agent':
    case 'Task':
      return { kind: 'agent', label: `Agent: ${clip(str(input.description) || str(input.subagent_type) || 'subagent', 60)}`, files: none }
    case 'AskUserQuestion':
      return { kind: 'ask', label: 'Asking you', files: none }
    case 'ExitPlanMode':
      return { kind: 'plan', label: 'Plan proposed', files: none }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      if (!mcp) return { kind: 'other', label: tool, files: none }
      const server = mcp[1] ?? ''
      const name = /^[0-9a-f-]{20,}$/i.test(server) ? 'MCP' : server.replace(/^claude_ai_/, '')
      return { kind: 'other', label: `${name}: ${mcp[2] ?? ''}`, files: none }
    }
  }
}

// The question texts of an AskUserQuestion call.
export function askedQuestions(input: Input): string[] {
  const qs = Array.isArray(input.questions) ? input.questions : []
  return qs.map(q => clip(rawOf(q).question, 200)).filter(Boolean)
}

// Background work a tool call leaves running: a shell or a monitor. Agents are tracked from agent.spawn.
export function backgroundStart(tool: string, input: Input): string | null {
  if ((tool === 'Bash' || tool === 'PowerShell') && input.run_in_background === true) {
    return clip(str(input.description) || (str(input.command).split('\n')[0] ?? ''), 80) || 'Background command'
  }
  if (tool === 'Monitor') return clip(str(input.description) || str(input.command), 80) || 'Monitor'
  return null
}

const TASK_ID_KEYS = ['taskId', 'task_id', 'backgroundTaskId', 'shellId', 'shell_id', 'bash_id', 'bashId']
const AGENT_ID_KEYS = ['agentId', 'agent_id']

function findId(value: unknown, keys: readonly string[], depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 3) return null
  const record = value as Input
  for (const key of keys) {
    const v = record[key]
    if (typeof v === 'string' && v) return v.slice(0, 120)
    if (typeof v === 'number') return String(v)
  }
  for (const v of Object.values(record)) {
    const found = findId(v, keys, depth + 1)
    if (found) return found
  }
  return null
}

// The engine's id for background work in a tool result (a shell or task id).
export function taskIdOf(value: unknown): string | null {
  return findId(value, TASK_ID_KEYS)
}

// The subagent id an Agent tool result carries, when it carries one.
export function agentIdOf(value: unknown): string | null {
  return findId(value, AGENT_ID_KEYS)
}

// The desktop session id (local_...) a start_session or hand_off_to_session result names.
export function sessionRefOf(value: unknown): string | null {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return /local_[0-9a-f][0-9a-f-]{7,}/i.exec(text)?.[0] ?? null
}

// What the person typed: engine blocks, quoted replies and command echoes removed. A local command that
// already ran (its output came back as local-command-stdout) is not a request to Claude, so it reads as empty.
export function stripPromptMarkers(text: string): string {
  if (/<local-command-stdout>/i.test(text)) return ''
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (/^\s*<!--\s*reply\b[^>]*?-->\s*$/i.test(line)) {
      index++
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) index++
      if ((lines[index] ?? '').trim() === '') index++
      index--
      continue
    }
    kept.push(line)
  }
  let body = kept.join('\n')
  const command = /<command-name>([\s\S]*?)<\/command-name>/i.exec(body)?.[1]?.trim() ?? ''
  const args = /<command-args>([\s\S]*?)<\/command-args>/i.exec(body)?.[1]?.trim() ?? ''
  body = body.replace(
    /<(task-notification|agent-message|system-reminder|local-command-caveat|cross-session-message|side-sessions-event|ci-monitor-event|command-name|command-message|command-args)\b[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  )
  body = body.replace(/<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content>/gi, (_whole, inner: string) => {
    const count = inner.trim() ? inner.trim().split(/\r?\n/).length : 0
    return `[pasted ${count} lines]`
  })
  body = body.replace(/\[Image\s+#\d+\]/gi, '[image]')
  body = body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!body && command) return `${command}${args ? ` ${args}` : ''}`
  return body
}

export type Notice = { taskId: string | null; status: string | null; summary: string | null; from: string | null }

function cleanMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function tagValue(body: string, name: string): string {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(body)
  return cleanMarkup(match?.[1] ?? '')
}

function lineValue(body: string, name: string): string {
  const match = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'im').exec(body)
  return cleanMarkup(match?.[1] ?? '')
}

// <task-notification> and <agent-message> blocks the engine delivers when background work ends.
export function notices(text: string): Notice[] {
  const out: Notice[] = []
  for (const match of text.matchAll(/<(task-notification|agent-message)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const attrs = match[2] ?? ''
    const body = match[3] ?? ''
    const from = /\bfrom\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i.exec(attrs)
    out.push({
      taskId: tagValue(body, 'task-id') || lineValue(body, 'task[-_ ]?id') || null,
      status: (tagValue(body, 'status') || lineValue(body, 'status')).toLowerCase() || null,
      summary: clip(tagValue(body, 'summary') || lineValue(body, 'summary'), 140) || null,
      from: from?.[1] ?? from?.[2] ?? null,
    })
  }
  return out
}

// The first line of a reply worth showing: headings, bullets, quotes, tables and code fences skipped.
export function firstLine(answer: string): string | null {
  let fenced = false
  for (const raw of answer.split('\n')) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced || !line || /^\|?\s*:?-{3,}/.test(line)) continue
    const text = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+>]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/[*_`]/g, '')
      .trim()
    if (text.length >= 2) return clip(text, 160)
  }
  return null
}

// The question a reply ends on: the last sentence of its last paragraph, when that ends with "?".
export function endingQuestion(answer: string): string | null {
  const last = (answer.trim().split(/\n\s*\n/).pop() ?? '').trim()
  if (!last.endsWith('?')) return null
  const question = sentences(last.replace(/[*_`]/g, '')).filter(x => x.endsWith('?')).pop()
  return question ? clip(question, 200) : null
}
