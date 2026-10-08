import { fmtTime, type CallRecord } from '../derive'
import type { Agent } from '../types'
import { CATEGORY, actionText, agentColor, agentIcon, agentLabel, fmtSpan, toolCategory, type Category } from './plain'

interface Props {
  agents: Agent[]
  calls: CallRecord[]
  thoughts: CallRecord[]
  from: number
  to: number
  live: boolean
}

interface Seg { left: number; width: number; cat: Category; failed: boolean; tip: string; key: string }

/** One lane per helper on a shared time axis: who worked when, on what, and in parallel with whom. */
export function Swimlanes({ agents, calls, thoughts, from, to, live }: Props) {
  const span = Math.max(1, to - from)
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - from) / span) * 100))
  const seg = (c: CallRecord, cat: Category, tip: string): Seg | null => {
    const end = c.durationMs !== null ? c.startedAt + c.durationMs : c.status === 'running' ? to : c.startedAt
    if (end < from || c.startedAt > to) return null
    const left = pct(c.startedAt)
    return { left, width: Math.max(0.5, pct(end) - left), cat, failed: c.status === 'failed', tip, key: c.id }
  }

  const ordered: Agent[] = []
  const visit = (a: Agent) => {
    if (ordered.includes(a)) return
    ordered.push(a)
    agents.filter((c) => c.parent === a.id).forEach(visit)
  }
  agents.filter((a) => !a.parent || !agents.some((p) => p.id === a.parent)).forEach(visit)
  agents.forEach(visit)

  const used = new Set<Category>()
  const lanes = ordered.map((a) => {
    const segs = [
      ...thoughts.filter((c) => c.agent === a.id).map((c) => seg(c, 'think', `思考 · ${fmtSpan(c.durationMs)}`)),
      ...calls.filter((c) => c.agent === a.id && toolCategory(c.name) !== 'delegate').map((c) =>
        seg(c, toolCategory(c.name), `${actionText(c.name, c.input, 'past')}${c.status === 'failed' ? '（失败）' : ''} · ${fmtSpan(c.durationMs)}`)),
    ].filter((s): s is Seg => s !== null)
    segs.forEach((s) => used.add(s.cat))
    const lifeStart = a.started_at ?? from
    const lifeEnd = a.ended_at ?? to
    return { a, segs, life: lifeEnd >= from && lifeStart <= to ? { left: pct(lifeStart), width: Math.max(0.5, pct(lifeEnd) - pct(lifeStart)) } : null }
  }).filter((l) => l.segs.length > 0 || l.life)

  if (lanes.length === 0) return <div className="lanes-empty muted">这一轮还没有动作记录</div>

  return (
    <div className="lanes">
      <div className="lanes-axis">
        <span>{fmtTime(from)}</span>
        <span>{fmtTime(from + span / 2)}</span>
        <span>{live ? '现在' : fmtTime(to)}</span>
      </div>
      {lanes.map(({ a, segs, life }) => (
        <div className="lane" key={a.id} style={{ ['--c' as string]: agentColor(a.id) }}>
          <div className="lane-who"><span>{agentIcon(a)}</span>{agentLabel(a)}</div>
          <div className="lane-track">
            {life && <div className={`lane-life st-${a.status}`} style={{ left: `${life.left}%`, width: `${life.width}%` }} />}
            {segs.map((s) => (
              <div key={s.key} className={`lane-seg ${s.failed ? 'failed' : ''}`} title={s.tip}
                   style={{ left: `${s.left}%`, width: `${s.width}%`, background: CATEGORY[s.cat].color }} />
            ))}
            {live && <div className="lane-now" />}
          </div>
        </div>
      ))}
      <div className="lanes-legend">
        {[...used].map((c) => <span key={c}><i style={{ background: CATEGORY[c].color }} />{CATEGORY[c].icon} {CATEGORY[c].label}</span>)}
        <span><i className="legend-fail" />失败</span>
      </div>
    </div>
  )
}
