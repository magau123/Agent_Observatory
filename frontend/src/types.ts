// Mirrors observatory/schema.py and observatory/state.py (JSON Schema served at /api/schema).

export type EventType =
  | 'run_start' | 'run_end'
  | 'agent_start' | 'agent_end' | 'agent_status'
  | 'task_create' | 'task_start' | 'task_complete' | 'task_failed'
  | 'agent_message'
  | 'llm_start' | 'llm_end'
  | 'tool_start' | 'tool_end'
  | 'error'

export type Status = 'idle' | 'planning' | 'running' | 'waiting' | 'completed' | 'failed' | 'aborted'

export interface AgentEvent {
  event_id: string
  timestamp: number
  event_type: EventType
  platform: string
  run_id: string
  task_id: string | null
  source: string | null
  target: string | null
  status: Status | null
  data: Record<string, unknown>
  duration_ms: number | null
}

export interface Metrics {
  active_agents: number
  total_agents: number
  total_tasks: number
  completed_tasks: number
  failed_tasks: number
  llm_calls: number
  tool_calls: number
  messages: number
  errors: number
  total_tokens: number | null
  avg_latency_ms: number | null
  events: number
}

export type RunStatus = 'running' | 'idle' | 'completed' | 'failed' | 'aborted'

export interface RunSummary {
  run_id: string
  platform: string
  title: string | null
  cwd: string | null
  model: string | null
  status: RunStatus
  started_at: number
  updated_at: number
  ended_at: number | null
  metrics: Metrics
}

export interface Agent {
  id: string
  name: string
  kind: 'main' | 'subagent' | 'agent'
  parent: string | null
  status: Status
  model: string | null
  task_id: string | null
  current_task: string | null
  current_action: string | null
  started_at: number | null
  ended_at: number | null
  last_active: number
  llm_calls: number
  tool_calls: number
  messages: number
  errors: number
  tokens: number | null
  input: string | null
  output: string | null
}

export interface Task {
  id: string
  agent: string
  description: string
  status: string
  created_at: number
  started_at: number | null
  ended_at: number | null
  duration_ms: number | null
  error: string | null
}

export interface RunSnapshot extends RunSummary {
  agents: Agent[]
  tasks: Task[]
}

export interface Report {
  id: string
  ts: number
  kind: 'turn' | 'periodic' | 'manual'
  title: string
  body: string
  lines: string[]
  run_id: string | null
  platform: string | null
}

export type ServerMessage =
  | { type: 'hello'; runs: RunSummary[]; reports: Report[] }
  | { type: 'event'; event: AgentEvent; run: RunSnapshot }
  | { type: 'report'; report: Report }
  | { type: 'run_removed'; run_id: string }
  | { type: 'run_updated'; run: RunSnapshot }
