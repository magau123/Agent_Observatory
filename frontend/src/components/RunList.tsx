import { PLATFORM_LABEL, fmtDuration } from '../derive'
import type { RunSummary } from '../types'

interface Props {
  runs: RunSummary[]
  selected: string | null
  now: number
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

const project = (r: RunSummary) => r.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? r.run_id.slice(0, 18)

export function RunList({ runs, selected, now, onSelect, onDelete }: Props) {
  return (
    <aside className="runs">
      <div className="runs-head">Runs <span className="muted">({runs.length})</span></div>
      {runs.length === 0 && <div className="empty small">No runs yet. Start an agent task.</div>}
      {runs.map((r) => (
        <div key={r.run_id} className={`run-item ${r.run_id === selected ? 'active' : ''}`}>
          <button className="run-main" onClick={() => onSelect(r.run_id)}>
            <div className="run-top">
              <span className={`dot st-${r.status === 'idle' ? 'idle' : r.status}`} />
              <span className={`plat plat-${r.platform}`}>{PLATFORM_LABEL[r.platform] ?? r.platform}</span>
              <span className="muted">{project(r)}</span>
            </div>
            <div className="run-title">{r.title || r.run_id}</div>
            <div className="run-meta muted">
              {r.status} · {r.metrics.total_agents} agents · {r.metrics.tool_calls} tools
              {r.metrics.errors > 0 && <span className="bad"> · {r.metrics.errors} err</span>}
              <span className="right">{fmtDuration(now - r.updated_at)} ago</span>
            </div>
          </button>
          <button className="ghost del" title="Remove run" aria-label="Remove run" onClick={() => onDelete(r.run_id)}>✕</button>
        </div>
      ))}
    </aside>
  )
}
