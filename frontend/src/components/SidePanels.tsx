import { useMemo } from 'react'
import { PLATFORM_LABEL, fmtDuration, fmtNum, fmtTime, isError, preview } from '../derive'
import type { AgentEvent, Report, RunSnapshot } from '../types'

export function RunOverview({ run, now }: { run: RunSnapshot; now: number }) {
  const m = run.metrics
  const end = run.ended_at ?? (run.status === 'running' ? now : run.updated_at)
  return (
    <div className="panel-body">
      <div className="panel-title"><span className={`dot st-${run.status}`} /><h3>Run</h3></div>
      <div className="kv">
        <span>Run ID</span><span className="mono">{run.run_id}</span>
        <span>Platform</span><span>{PLATFORM_LABEL[run.platform] ?? run.platform}</span>
        <span>Request</span><span>{run.title ? preview(run.title, 300) : '—'}</span>
        <span>Project</span><span className="mono">{run.cwd ?? '—'}</span>
        {run.model && <><span>Model</span><span>{run.model}</span></>}
        <span>Status</span><span className={`st-text st-${run.status}`}>{run.status}</span>
        <span>Started</span><span>{fmtTime(run.started_at)}</span>
        <span>Duration</span><span>{fmtDuration(end - run.started_at)}</span>
        <span>Agents</span><span>{run.agents.map((a) => a.name).join(', ') || '—'}</span>
        <span>Tasks</span><span>{m.total_tasks} ({m.completed_tasks} done, {m.failed_tasks} failed)</span>
        <span>Messages</span><span>{m.messages}</span>
        <span>Tool Calls</span><span>{m.tool_calls}</span>
        <span>LLM Calls</span><span>{m.llm_calls}</span>
        <span>Tokens</span><span>{fmtNum(m.total_tokens)}</span>
        <span>Events</span><span>{m.events}</span>
      </div>
    </div>
  )
}

export function ErrorsPanel({ events, names, onSelectAgent }: {
  events: AgentEvent[]; names: Map<string, string>; onSelectAgent: (id: string) => void
}) {
  const errors = useMemo(() => events.filter(isError).reverse(), [events])
  return (
    <div className="panel-body">
      {errors.length === 0 && <div className="empty small">No errors in this run 🎉</div>}
      {errors.map((e) => {
        const kind = e.event_type.startsWith('tool') ? 'Tool execution failed'
          : e.event_type.startsWith('llm') ? 'LLM request failed'
          : e.event_type.startsWith('task') ? 'Task failed'
          : e.event_type === 'agent_end' ? 'Agent failed' : 'Error'
        return (
          <div key={e.event_id} className="error-card">
            <div className="error-head">
              ⚠ {e.source ? <button className="link" onClick={() => onSelectAgent(e.source!)}>{names.get(e.source) ?? e.source}</button> : 'run'}
              <span className="muted right">{fmtTime(e.timestamp)}</span>
            </div>
            <div><b>{kind}</b>{e.data.tool_name ? <> · Tool: <code>{String(e.data.tool_name)}</code></> : null}
              {e.data.model ? <> · Model: <code>{String(e.data.model)}</code></> : null}</div>
            <div className="error-msg">{preview(e.data.error ?? e.data.reason ?? e.status, 500)}</div>
          </div>
        )
      })}
    </div>
  )
}

export function ReportsPanel({ reports, onRequest, onOpenRun }: {
  reports: Report[]; onRequest: () => void; onOpenRun: (id: string) => void
}) {
  return (
    <div className="panel-body">
      <button className="primary" onClick={onRequest}>Generate digest now</button>
      {reports.length === 0 && <div className="empty small">Reports appear when an agent turn finishes and every 30 min.</div>}
      {reports.map((r) => (
        <div key={r.id} className={`report kind-${r.kind}`}>
          <div className="report-head">
            <b>{r.title}</b>
            <span className="muted right">{fmtTime(r.ts)} · {r.kind}</span>
          </div>
          <div>{r.body}</div>
          {r.lines.length > 0 && <ul>{r.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
          {r.run_id && <button className="link" onClick={() => onOpenRun(r.run_id!)}>open run →</button>}
        </div>
      ))}
    </div>
  )
}
