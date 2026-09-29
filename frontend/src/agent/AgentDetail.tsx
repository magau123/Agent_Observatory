import { useMemo } from 'react'
import { fmtDuration, fmtNum, fmtTime, isError, llmCalls, preview, pretty, toolCalls, type CallRecord } from '../derive'
import type { Agent, AgentEvent, Task } from '../types'

interface Props {
  agent: Agent
  tasks: Task[]
  events: AgentEvent[]
  now: number
  onClose: () => void
}

function CallItem({ c, llm }: { c: CallRecord; llm?: boolean }) {
  return (
    <details className={`call st-${c.status}`}>
      <summary>
        <span className={`dot st-${c.status === 'completed' ? 'completed' : c.status}`} />
        <span className="call-name">{llm ? (c.model ?? 'LLM') : c.name}{c.kind ? ` · ${c.kind}` : ''}</span>
        <span className="muted">{c.status}</span>
        <span className="muted right">{fmtDuration(c.durationMs)}</span>
      </summary>
      {llm && (
        <div className="kv small">
          <span>Input tokens</span><span>{fmtNum(c.inputTokens)}</span>
          <span>Output tokens</span><span>{fmtNum(c.outputTokens)}</span>
          <span>Total tokens</span><span>{fmtNum(c.totalTokens)}</span>
          <span>Latency</span><span>{fmtDuration(c.durationMs)}</span>
        </div>
      )}
      {c.error && <div className="error-box">{c.error}</div>}
      {c.input !== undefined && c.input !== null && <><div className="label">Input</div><pre className="json">{pretty(c.input)}</pre></>}
      {c.output !== null && c.output !== undefined && <><div className="label">Output</div><pre className="json">{pretty(c.output)}</pre></>}
    </details>
  )
}

export function AgentDetail({ agent: a, tasks, events, now, onClose }: Props) {
  const mine = useMemo(() => events.filter((e) => e.source === a.id), [events, a.id])
  const tools = useMemo(() => toolCalls(mine).reverse(), [mine])
  const llms = useMemo(() => llmCalls(mine).reverse(), [mine])
  const errors = useMemo(() => mine.filter(isError).reverse(), [mine])
  const myTasks = tasks.filter((t) => t.agent === a.id).reverse()
  const end = a.ended_at ?? (a.status === 'completed' || a.status === 'failed' ? a.last_active : now)

  return (
    <div className="panel-body">
      <div className="panel-title">
        <span className={`dot st-${a.status}`} />
        <h3>{a.name}</h3>
        <span className="kind">{a.kind}</span>
        <button className="ghost right" onClick={onClose} aria-label="Close agent detail">✕</button>
      </div>
      <div className="kv">
        <span>Status</span><span className={`st-text st-${a.status}`}>{a.status}</span>
        <span>Current Task</span><span>{a.current_task ? preview(a.current_task, 160) : '—'}</span>
        <span>Doing</span><span>{a.current_action ?? '—'}</span>
        <span>Started</span><span>{a.started_at ? fmtTime(a.started_at) : '—'}</span>
        <span>Duration</span><span>{a.started_at ? fmtDuration(end - a.started_at) : 'N/A'}</span>
        <span>LLM Calls</span><span>{a.llm_calls}</span>
        <span>Tool Calls</span><span>{a.tool_calls}</span>
        <span>Messages</span><span>{a.messages}</span>
        <span>Tokens</span><span>{fmtNum(a.tokens)}</span>
        {a.model && <><span>Model</span><span>{a.model}</span></>}
        {a.parent && <><span>Parent</span><span>{a.parent}</span></>}
        <span>ID</span><span className="mono">{a.id}</span>
      </div>

      {errors.length > 0 && (
        <section>
          <h4 className="bad">Errors ({errors.length})</h4>
          {errors.map((e) => (
            <div key={e.event_id} className="error-box">
              <b>{fmtTime(e.timestamp)} {e.event_type}</b> {String(e.data.tool_name ?? '')}<br />{preview(e.data.error, 400)}
            </div>
          ))}
        </section>
      )}
      <section><h4>Input</h4><pre className="json">{a.input ?? '—'}</pre></section>
      <section><h4>Output</h4><pre className="json">{a.output ?? '—'}</pre></section>
      {myTasks.length > 0 && (
        <section>
          <h4>Tasks ({myTasks.length})</h4>
          {myTasks.map((t) => (
            <div key={t.id} className="task-row">
              <span className={`dot st-${t.status === 'running' ? 'running' : t.status}`} />
              <span className="grow">{preview(t.description, 90) || t.id}</span>
              <span className="muted">{fmtDuration(t.duration_ms)}</span>
            </div>
          ))}
        </section>
      )}
      <section>
        <h4>Tool Calls ({tools.length})</h4>
        {tools.length === 0 ? <div className="muted">none</div> : tools.slice(0, 200).map((c) => <CallItem key={c.id} c={c} />)}
      </section>
      <section>
        <h4>LLM Calls ({llms.length})</h4>
        {llms.length === 0 ? <div className="muted">none observed</div> : llms.slice(0, 200).map((c) => <CallItem key={c.id} c={c} llm />)}
      </section>
    </div>
  )
}
