// Turns raw agent events into plain-language summaries for people who don't read code.
import { preview, toolCalls } from '../derive.ts'
import type { Agent, AgentEvent, RunSnapshot, RunStatus, Status } from '../types'

export const STATUS_TEXT: Record<Status, string> = {
  idle: '空闲', planning: '思考中', running: '正在进行', waiting: '等待中',
  completed: '已完成', failed: '出错了', aborted: '已停止',
}

export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  running: '进行中', idle: '等待新指令', completed: '已完成', failed: '出错了', aborted: '已停止',
}

const HELPER_NAMES: Record<string, string> = {
  explore: '探索助手', generalPurpose: '通用助手', 'general-purpose': '通用助手', shell: '命令助手',
  'browser-use': '浏览器助手', bugbot: '审查助手', 'security-review': '安全审查助手', Plan: '规划助手',
}

export function agentLabel(a: Pick<Agent, 'kind' | 'name'> | undefined): string {
  if (!a) return '助手'
  if (a.kind === 'main') return '主助手'
  return HELPER_NAMES[a.name] ?? a.name
}

export type Category = 'think' | 'read' | 'edit' | 'command' | 'search' | 'web' | 'delegate' | 'analyze' | 'other'

export const CATEGORY: Record<Category, { icon: string; label: string; color: string }> = {
  think: { icon: '💭', label: '思考', color: '#a78bfa' },
  read: { icon: '📖', label: '阅读', color: '#60a5fa' },
  edit: { icon: '✏️', label: '修改', color: '#34d399' },
  command: { icon: '⌨️', label: '运行命令', color: '#fbbf24' },
  search: { icon: '🔎', label: '查找', color: '#22d3ee' },
  web: { icon: '🌐', label: '查资料', color: '#818cf8' },
  delegate: { icon: '🤝', label: '安排助手', color: '#f472b6' },
  analyze: { icon: '📊', label: '分析', color: '#2dd4bf' },
  other: { icon: '🧩', label: '其他工具', color: '#94a3b8' },
}

interface Verb { now: string; past: string; colon: boolean; cat: Category }

// Order matters: the first matching pattern wins.
const VERBS: [RegExp, Verb][] = [
  [/web|fetch|browser|http|url/i, { now: '正在查资料', past: '查了资料', colon: true, cat: 'web' }],
  [/^(task|subagent|spawn)/i, { now: '正在安排助手', past: '安排了助手', colon: true, cat: 'delegate' }],
  [/^mcp/i, { now: '正在使用外部服务', past: '使用了外部服务', colon: true, cat: 'other' }],
  [/todo/i, { now: '正在更新待办清单', past: '更新了待办清单', colon: false, cat: 'other' }],
  [/read|view|cat|open/i, { now: '正在阅读', past: '阅读了', colon: false, cat: 'read' }],
  [/write|edit|replace|patch|delete|create|notebook/i, { now: '正在修改', past: '修改了', colon: false, cat: 'edit' }],
  [/shell|bash|powershell|terminal|exec|command/i, { now: '正在运行命令', past: '运行了命令', colon: true, cat: 'command' }],
  [/grep|glob|search|find|list|ls$/i, { now: '正在查找', past: '查找了', colon: false, cat: 'search' }],
  [/count|metric|analy|summar|stat/i, { now: '正在分析', past: '分析了', colon: false, cat: 'analyze' }],
]

function verbFor(tool: string): Verb {
  return VERBS.find(([re]) => re.test(tool))?.[1] ?? { now: `正在使用「${tool}」`, past: `使用了「${tool}」`, colon: true, cat: 'other' }
}

export const toolCategory = (tool: string): Category => verbFor(tool).cat
export const isSpawnTool = (tool: string) => verbFor(tool).cat === 'delegate'

const ROLE_ICONS: [RegExp, string][] = [
  [/explor|research|investig/i, '🔭'], [/plan|architect|lead|orchestr/i, '🧭'], [/review|critic|audit|bugbot/i, '🧐'],
  [/secur/i, '🛡️'], [/test|qa/i, '🧪'], [/writ|doc|author/i, '✍️'], [/code|dev|engineer|implement/i, '💻'],
  [/shell|command|terminal/i, '⌨️'], [/browser|web|fetch|crawl/i, '🌐'], [/data|analy/i, '📊'], [/design|ui/i, '🎨'],
]

export function agentIcon(a: Pick<Agent, 'kind' | 'name'>): string {
  if (a.kind === 'main') return '🧠'
  return ROLE_ICONS.find(([re]) => re.test(a.name))?.[1] ?? '🤖'
}

/** Stable per-agent hue so the same helper keeps its colour across the stage, lanes and feed. */
export function agentColor(id: string): string {
  if (id === 'main') return 'hsl(222 90% 66%)'
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h} 75% 64%)`
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** The human-relevant object of a tool call: a file name, a command description, a search pattern... */
export function callTarget(input: unknown): string {
  let v = input
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return preview(v, 50)
    }
  }
  if (!v || typeof v !== 'object') return ''
  const o = v as Record<string, unknown>
  const file = o.file_path ?? o.path ?? o.target_file ?? o.filename ?? o.file ?? o.notebook_path
  if (typeof file === 'string' && file) return basename(file)
  const other = o.description ?? o.command ?? o.pattern ?? o.glob_pattern ?? o.query ?? o.url ?? o.prompt
  return typeof other === 'string' ? preview(other, 50) : ''
}

export function actionText(tool: string, input: unknown, tense: 'now' | 'past'): string {
  const v = verbFor(tool)
  const t = callTarget(input)
  return t ? `${v[tense]}${v.colon ? '：' : ' '}${t}` : v[tense]
}

/** What an agent is doing right now, in one short sentence. */
export function currentActivity(a: Agent, events: AgentEvent[]): string {
  const open = toolCalls(events).filter((c) => c.agent === a.id && c.status === 'running').pop()
  if (open && a.status !== 'completed' && a.status !== 'failed') return actionText(open.name, open.input, 'now')
  switch (a.status) {
    case 'planning': return '正在思考下一步'
    case 'running': return '正在思考'
    case 'waiting': return a.current_action?.startsWith('waiting for') ? '等待助手完成工作' : '等待你的确认或回复'
    case 'completed': return '已完成'
    case 'failed': return '出错了'
    case 'aborted': return '已停止'
    default: return '空闲'
  }
}

export interface Step {
  ts: number
  agent: string
  who: string
  text: string
  state: 'ok' | 'fail' | 'info'
  count: number
  key: string
}

/** Collapses the raw event stream into a short story of meaningful steps (oldest first). */
export function buildSteps(run: RunSnapshot, events: AgentEvent[]): Step[] {
  const agents = new Map(run.agents.map((a) => [a.id, a]))
  const steps: Step[] = []
  const groups = new Map<Step, string[]>()
  const push = (ev: AgentEvent, text: string, state: Step['state'], group = '', target = '') => {
    const who = agentLabel(agents.get(ev.source ?? ''))
    const last = steps[steps.length - 1]
    if (group && last && last.key === `${who}|${group}`) {
      last.count += 1
      last.ts = ev.timestamp
      const targets = groups.get(last) ?? []
      if (target && !targets.includes(target)) targets.push(target)
      last.text = groupText(group, targets, last.count)
      return
    }
    const step: Step = { ts: ev.timestamp, agent: ev.source ?? '', who, text, state, count: 1, key: group ? `${who}|${group}` : ev.event_id }
    if (group) groups.set(step, target ? [target] : [])
    steps.push(step)
  }

  for (const ev of events) {
    const d = ev.data
    const agent = agents.get(ev.source ?? '')
    const err = preview(d.error, 120)
    switch (ev.event_type) {
      case 'task_start':
        if (agent?.kind === 'subagent' || !d.description) break
        push(ev, agent?.kind === 'main' ? `收到任务：${preview(d.description, 100)}` : `开始：${preview(d.description, 100)}`, 'info')
        break
      case 'agent_start': {
        if (agent?.kind !== 'subagent') break
        const parent = agentLabel(agents.get(agent.parent ?? ''))
        const job = agent.current_task ? `去做：${preview(agent.current_task, 80)}` : '帮忙'
        push(ev, `${parent}安排${agentLabel(agent)}${job}`, 'info')
        break
      }
      case 'agent_end':
        if (ev.status === 'failed') push(ev, `没能完成工作${err ? `：${err}` : ''}`, 'fail')
        else if (agent?.kind !== 'main') push(ev, '完成了工作', 'ok')
        break
      case 'tool_end': {
        const tool = String(d.tool_name ?? '工具')
        if (isSpawnTool(tool)) break
        if (ev.status === 'failed') push(ev, `${actionText(tool, d.input, 'past')}，但失败了${err ? `：${err}` : ''}`, 'fail')
        else {
          const v = verbFor(tool)
          push(ev, actionText(tool, d.input, 'past'), 'ok', v.past + (v.colon ? '：' : ' '), callTarget(d.input))
        }
        break
      }
      case 'llm_end':
        if (ev.status === 'failed') push(ev, `请求 AI 模型失败${err ? `：${err}` : ''}`, 'fail')
        else if (d.kind === 'response' && d.output) push(ev, `回复你：${preview(d.output, 100)}`, 'info')
        break
      case 'task_complete':
        if (agent?.kind === 'main') push(ev, ev.status === 'aborted' ? '本轮任务被停止' : '本轮任务完成', 'ok')
        break
      case 'task_failed':
        push(ev, `任务失败${err ? `：${err}` : ''}`, 'fail')
        break
      case 'agent_message': {
        const to = agents.get(ev.target ?? '')
        if (!to || !d.content || !agent || ev.target === ev.source) break  // user prompts already appear as 收到任务
        if (to.kind === 'subagent' && to.parent === agent.id) break  // the dispatch already appears as 安排…去做
        const raw = typeof d.content === 'string' ? d.content.trim() : ''
        push(ev, raw && !/^[[{]/.test(raw) ? `告诉${agentLabel(to)}：${preview(raw, 80)}` : `把结果交给了${agentLabel(to)}`, 'info')
        break
      }
      case 'agent_status':
        if (ev.status === 'waiting') push(ev, `等待你的确认${d.message ? `：${preview(d.message, 80)}` : ''}`, 'info')
        break
      case 'error':
        push(ev, `出错：${err || '未知错误'}`, 'fail')
        break
    }
  }
  return steps
}

/** `prefix` is the past-tense verb plus its separator, e.g. "阅读了 " or "运行了命令：". */
function groupText(prefix: string, targets: string[], count: number): string {
  if (!targets.length) return `${prefix.replace(/[： ]$/, '')} ${count} 次`
  const shown = targets.slice(0, 3).join('、')
  const more = targets.length > 3 ? ` 等 ${targets.length} 项` : ''
  return `${prefix}${shown}${more}${count > targets.length ? `（共 ${count} 次）` : ''}`
}

export interface Overview {
  title: string
  turnStart: number
  turnEnd: number | null
  now: { who: string; what: string; status: Status }[]
  next: string[]
  checklist: { label: string; status: string }[]
  errors: Step[]
  progress: { done: number; total: number }
}

/**
 * Coding-agent sessions live for days and hold many requests ("turns"); the overview focuses on the
 * latest request from the main agent. Runs without a main agent (SDK) are treated as one turn.
 */
export function overview(run: RunSnapshot, events: AgentEvent[], steps: Step[]): Overview {
  const byId = new Map(run.agents.map((a) => [a.id, a]))
  const turn = run.tasks.filter((t) => byId.get(t.agent)?.kind === 'main')
    .sort((a, b) => (b.started_at ?? b.created_at) - (a.started_at ?? a.created_at))[0]
  const turnStart = turn ? turn.started_at ?? turn.created_at : run.started_at
  const label = (t: RunSnapshot['tasks'][number]) => {
    const owner = byId.get(t.agent)
    return preview(t.description || owner?.current_task, 80) || agentLabel(owner)
  }
  const inTurn = run.tasks.filter((t) => t !== turn && t.created_at >= turnStart && t.status !== 'aborted')
  const active = run.agents.filter((a) => ['running', 'planning', 'waiting'].includes(a.status))
  const now = active.map((a) => ({ who: agentLabel(a), what: currentActivity(a, events), status: a.status }))
  const pending = run.tasks.filter((t) => t.status === 'created').map(label).filter(Boolean)
  const waitingForUser = now.some((n) => n.what.startsWith('等待你'))
  const next = pending.length ? pending
    : waitingForUser ? ['需要你确认或回复后才能继续']
    : run.status === 'running' ? ['完成当前步骤后，由主助手决定下一步']
    : run.status === 'idle' ? ['这一轮已经做完，等待你的新指令']
    : run.status === 'failed' ? ['有步骤出错了，请看标红的助手']
    : run.status === 'aborted' ? ['任务已被停止']
    : ['全部完成，没有待办']
  const checklist = [...inTurn].sort((a, b) => a.created_at - b.created_at).map((t) => ({ label: label(t), status: t.status }))
  return {
    title: preview(turn?.description, 200) || run.title || '未命名任务',
    turnStart,
    turnEnd: turn ? turn.ended_at : run.ended_at,
    now, next, checklist,
    errors: steps.filter((s) => s.state === 'fail' && s.ts >= turnStart),
    progress: { done: inTurn.filter((t) => t.status === 'completed').length, total: inTurn.length },
  }
}

/**
 * Radial tree inside a w×h box: a single root sits in the centre, children share the ring around it
 * (angular space proportional to their own sub-tree size), grandchildren go on the next ring out.
 * Rings are ellipses so wide stages are used well.
 */
export function radialLayout(agents: Pick<Agent, 'id' | 'parent'>[], w: number, h: number): Map<string, { x: number; y: number }> {
  const ids = new Set(agents.map((a) => a.id))
  const kids = new Map<string, string[]>()
  const ROOT = '\u0000root'
  for (const a of agents) {
    const p = a.parent && ids.has(a.parent) && a.parent !== a.id ? a.parent : ROOT
    kids.set(p, [...(kids.get(p) ?? []), a.id])
  }
  const leaves = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 1
    seen.add(id)
    const c = kids.get(id) ?? []
    return c.length ? c.reduce((s, k) => s + leaves(k, seen), 0) : 1
  }
  const depth = (id: string, d = 0, seen = new Set<string>()): number =>
    seen.has(id) ? d : (seen.add(id), Math.max(d, ...(kids.get(id) ?? []).map((k) => depth(k, d + 1, seen))))
  const roots = kids.get(ROOT) ?? []
  const virtual = roots.length !== 1
  const start = virtual ? ROOT : roots[0] ?? ROOT
  const maxDepth = Math.max(1, depth(start))
  const rx = Math.max(0, w / 2 - 75), ry = Math.max(0, h / 2 - 70)
  const pos = new Map<string, { x: number; y: number }>()
  // A crowded ring alternates between an inner and outer radius so neighbouring cards don't collide.
  const place = (id: string, d: number, a0: number, a1: number, seen: Set<string>, stagger = 1) => {
    if (seen.has(id)) return
    seen.add(id)
    const a = (a0 + a1) / 2
    const r = (d / maxDepth) * stagger
    if (id !== ROOT) pos.set(id, { x: w / 2 + rx * r * Math.cos(a), y: h / 2 + ry * r * Math.sin(a) })
    const c = kids.get(id) ?? []
    const total = c.reduce((s, k) => s + leaves(k), 0) || 1
    let s = a0
    c.forEach((k, i) => {
      const span = ((a1 - a0) * leaves(k)) / total
      place(k, d + 1, s, s + span, seen, c.length > 6 && i % 2 ? 1 - 0.38 / (d + 1) : 1)
      s += span
    })
  }
  const n = Math.max(1, leaves(start))
  place(start, 0, -Math.PI / n, 2 * Math.PI - Math.PI / n, new Set())  // first child lands at 3 o'clock
  return pos
}

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

export function fmtSpan(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  if (s < 1) return '不到 1 秒'
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}
