import { PLATFORM_LABEL } from '../derive'
import { RUN_STATUS_TEXT, fmtAgo } from '../simple/plain'
import type { RunSummary } from '../types'

interface Props {
  runs: RunSummary[]
  selected: string | null
  now: number
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

const project = (r: RunSummary) => r.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? ''

export function RunList({ runs, selected, now, onSelect, onDelete }: Props) {
  return (
    <aside className="runs">
      <div className="runs-head">任务列表 <span className="muted">({runs.length})</span></div>
      {runs.length === 0 && <div className="empty small">还没有任务。开始一个 agent 任务后会自动出现在这里。</div>}
      {runs.map((r) => (
        <div key={r.run_id} className={`run-item ${r.run_id === selected ? 'active' : ''}`}>
          <button className="run-main" onClick={() => onSelect(r.run_id)}>
            <div className="run-top">
              <span className={`plat plat-${r.platform}`}>{PLATFORM_LABEL[r.platform] ?? r.platform}</span>
              <span className="muted">{project(r)}</span>
            </div>
            <div className="run-title">{r.title || '未命名任务'}</div>
            <div className="run-meta muted">
              <span className={`dot st-${r.status}`} />
              <span className={`st-text st-${r.status}`}>{RUN_STATUS_TEXT[r.status]}</span>
              {r.metrics.errors > 0 && <span className="bad"> · {r.metrics.errors} 处出错</span>}
              <span className="right">{fmtAgo(now - r.updated_at)}</span>
            </div>
          </button>
          <button className="ghost del" title="删除" aria-label="删除这个任务" onClick={() => onDelete(r.run_id)}>✕</button>
        </div>
      ))}
    </aside>
  )
}
