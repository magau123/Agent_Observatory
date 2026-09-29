import { useMemo, useState } from 'react'
import { describeEvent, fmtDuration, fmtTime, isError, pretty } from '../derive'
import type { Agent, AgentEvent, EventType } from '../types'

const TYPES: EventType[] = [
  'agent_start', 'agent_end', 'agent_status', 'task_create', 'task_start', 'task_complete', 'task_failed',
  'agent_message', 'llm_start', 'llm_end', 'tool_start', 'tool_end', 'error', 'run_start', 'run_end',
]
const MAX_ROWS = 600

function AgentLink({ id, label, onSelect }: { id: string | null; label: string; onSelect: (id: string) => void }) {
  if (!id) return null
  if (id === 'user') return <span>{label}</span>
  return <button className="link" onClick={(ev) => { ev.stopPropagation(); onSelect(id) }}>{label}</button>
}

interface Props {
  events: AgentEvent[]
  agents: Agent[]
  onSelectAgent: (id: string) => void
}

export function Timeline({ events, agents, onSelectAgent }: Props) {
  const [hidden, setHidden] = useState<Set<EventType>>(new Set(['agent_status']))
  const [agent, setAgent] = useState('')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [newestFirst, setNewestFirst] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])

  const rows = useMemo(() => {
    const filtered = events.filter((e) =>
      !hidden.has(e.event_type) &&
      (!agent || e.source === agent || e.target === agent) &&
      (!errorsOnly || isError(e)))
    // ponytail: renders the newest MAX_ROWS rows; add list virtualization if deep scrollback is needed
    const tail = filtered.slice(-MAX_ROWS)
    return newestFirst ? tail.reverse() : tail
  }, [events, hidden, agent, errorsOnly, newestFirst])

  const toggle = (t: EventType) => setHidden((prev) => {
    const next = new Set(prev)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    return next
  })
  const label = (id: string | null) => (id ? names.get(id) ?? id : '')

  return (
    <div className="timeline">
      <div className="timeline-filters">
        <strong>Timeline</strong>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent filter">
          <option value="">all agents</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> errors only</label>
        <button className="ghost" onClick={() => setNewestFirst((v) => !v)}>{newestFirst ? 'newest ↑' : 'oldest ↑'}</button>
        <div className="chips">
          {TYPES.map((t) => (
            <button key={t} className={`chip ev-${t} ${hidden.has(t) ? 'off' : ''}`} onClick={() => toggle(t)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="timeline-rows">
        {rows.length === 0 && <div className="empty small">No events match the filters</div>}
        {rows.map((e) => (
          <div key={e.event_id} className={`trow ${isError(e) ? 'is-error' : ''}`}>
            <div className="trow-main" role="button" tabIndex={0} aria-expanded={open === e.event_id}
              onClick={() => setOpen(open === e.event_id ? null : e.event_id)}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpen(open === e.event_id ? null : e.event_id) } }}>
              <span className="t-time">{fmtTime(e.timestamp)}</span>
              <span className="t-agent">
                <AgentLink id={e.source} label={label(e.source)} onSelect={onSelectAgent} />
                {e.target && <> → <AgentLink id={e.target} label={label(e.target)} onSelect={onSelectAgent} /></>}
              </span>
              <span className={`badge ev-${e.event_type}`}>{e.event_type}</span>
              <span className="t-desc">{describeEvent(e)}</span>
              <span className="t-dur">{e.duration_ms !== null ? fmtDuration(e.duration_ms) : ''}</span>
            </div>
            {open === e.event_id && <pre className="json">{pretty(e)}</pre>}
          </div>
        ))}
      </div>
    </div>
  )
}
