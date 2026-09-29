import type { AgentEvent, Status } from './types'

export interface CallRecord {
  id: string
  agent: string
  name: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
  startedAt: number
  durationMs: number | null
  input: unknown
  output: unknown
  error: string | null
  model?: string
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  kind?: string
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v))
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
const endStatus = (s: Status | null): CallRecord['status'] =>
  s === 'failed' ? 'failed' : s === 'aborted' ? 'aborted' : 'completed'

/** Pairs *_start / *_end events by data.call_id; an end without a start becomes a standalone record. */
function pairCalls(events: AgentEvent[], start: string, end: string): CallRecord[] {
  const open = new Map<string, CallRecord>()
  const out: CallRecord[] = []
  for (const e of events) {
    if (e.event_type !== start && e.event_type !== end) continue
    const id = str(e.data.call_id) ?? e.event_id
    if (e.event_type === start) {
      const rec: CallRecord = {
        id, agent: e.source ?? '?', name: str(e.data.tool_name) ?? str(e.data.model) ?? 'call', status: 'running',
        startedAt: e.timestamp, durationMs: null, input: e.data.input, output: null, error: null,
        model: str(e.data.model) ?? undefined,
      }
      open.set(id, rec)
      out.push(rec)
      continue
    }
    const rec: CallRecord = open.get(id) ?? {
      id, agent: e.source ?? '?', name: str(e.data.tool_name) ?? str(e.data.model) ?? 'call', status: 'running',
      startedAt: e.timestamp - (e.duration_ms ?? 0), durationMs: null, input: e.data.input, output: null, error: null,
    }
    if (!open.has(id)) out.push(rec)
    open.delete(id)
    rec.status = endStatus(e.status)
    rec.durationMs = e.duration_ms
    rec.output = e.data.output ?? null
    rec.error = str(e.data.error)
    rec.input = rec.input ?? e.data.input
    rec.model = str(e.data.model) ?? rec.model
    rec.inputTokens = num(e.data.input_tokens)
    rec.outputTokens = num(e.data.output_tokens)
    rec.totalTokens = num(e.data.total_tokens) ??
      (rec.inputTokens !== null && rec.outputTokens !== null ? rec.inputTokens + rec.outputTokens : null)
    rec.kind = str(e.data.kind) ?? undefined
  }
  return out
}

export const toolCalls = (events: AgentEvent[]) => pairCalls(events, 'tool_start', 'tool_end')
export const llmCalls = (events: AgentEvent[]) => pairCalls(events, 'llm_start', 'llm_end')

export const isError = (e: AgentEvent) => e.event_type === 'error' || e.status === 'failed'

export function describeEvent(e: AgentEvent): string {
  const d = e.data
  switch (e.event_type) {
    case 'tool_start': return `${str(d.tool_name) ?? 'tool'} ${preview(d.intent ?? d.input, 90)}`
    case 'tool_end': return `${str(d.tool_name) ?? 'tool'} ${e.status ?? ''}${d.error ? ` — ${preview(d.error, 90)}` : ''}`
    case 'llm_start': return `${str(d.model) ?? 'LLM'} request`
    case 'llm_end': return `${str(d.model) ?? 'LLM'} ${str(d.kind) ?? ''} ${e.status ?? ''}${d.error ? ` — ${preview(d.error, 90)}` : ''}`
    case 'agent_message': return preview(d.content, 140)
    case 'task_create': case 'task_start': return preview(d.description, 120)
    case 'task_failed': case 'error': return preview(d.error, 140)
    case 'agent_start': return `${str(d.name) ?? ''} ${str(d.kind) ?? ''}`
    case 'agent_status': return `${e.status ?? ''} ${preview(d.message, 100)}`
    case 'run_start': return str(d.cwd) ?? str(d.title) ?? ''
    default: return preview(d.output ?? d.reason ?? '', 120)
  }
}

export function preview(v: unknown, max = 120): string {
  const s = str(v) ?? ''
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function pretty(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2)
    } catch {
      return v
    }
  }
  return JSON.stringify(v, null, 2)
}

export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false })

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'N/A'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(2)}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? 'N/A' : n.toLocaleString())

export const PLATFORM_LABEL: Record<string, string> = {
  cursor: 'Cursor', 'claude-code': 'Claude Code', codex: 'Codex', sdk: 'SDK',
}
