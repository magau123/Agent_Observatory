import { fmtDuration, fmtNum } from '../derive'
import type { Metrics } from '../types'

export function MetricsBar({ m }: { m: Metrics | null }) {
  const items: [string, string, string?][] = m ? [
    ['Active Agents', String(m.active_agents), m.active_agents ? 'hot' : undefined],
    ['Total Agents', String(m.total_agents)],
    ['Tasks', String(m.total_tasks)],
    ['Completed', String(m.completed_tasks), 'ok'],
    ['Failed', String(m.failed_tasks), m.failed_tasks ? 'bad' : undefined],
    ['LLM Calls', String(m.llm_calls)],
    ['Tool Calls', String(m.tool_calls)],
    ['Messages', String(m.messages)],
    ['Errors', String(m.errors), m.errors ? 'bad' : undefined],
    ['Tokens', fmtNum(m.total_tokens)],
    ['Avg Latency', fmtDuration(m.avg_latency_ms)],
  ] : []
  return (
    <div className="metrics">
      {items.map(([label, value, tone]) => (
        <div key={label} className={`metric ${tone ?? ''}`}>
          <div className="metric-value">{value}</div>
          <div className="metric-label">{label}</div>
        </div>
      ))}
    </div>
  )
}
