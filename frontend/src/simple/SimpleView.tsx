import { useMemo, useState } from 'react'
import { PLATFORM_LABEL } from '../derive'
import type { Agent, AgentEvent, RunSnapshot } from '../types'
import { RUN_STATUS_TEXT, STATUS_TEXT, agentLabel, buildSteps, currentActivity, fmtAgo, fmtSpan, overview } from './plain'

interface Props {
  run: RunSnapshot | null
  events: AgentEvent[]
  now: number
}

const STEPS_SHOWN = 12

export function SimpleView({ run, events, now }: Props) {
  const steps = useMemo(() => (run ? buildSteps(run, events) : []), [run, events])
  const ov = useMemo(() => (run ? overview(run, events, steps) : null), [run, events, steps])
  const [showAll, setShowAll] = useState(false)

  if (!run || !ov) {
    return (
      <main className="simple">
        <div className="s-empty">
          <h2>还没有任务</h2>
          <p>在 Cursor、Claude Code 或 Codex 里开始一个任务，这里会自动显示它在做什么。</p>
        </div>
      </main>
    )
  }

  const project = run.cwd?.split(/[\\/]/).filter(Boolean).pop()
  const elapsed = (ov.turnEnd ?? (run.status === 'running' ? now : run.updated_at)) - ov.turnStart
  const recent = [...steps].reverse()
  const shown = showAll ? recent : recent.slice(0, STEPS_SHOWN)
  const pct = ov.progress.total ? Math.round((ov.progress.done / ov.progress.total) * 100) : 0

  return (
    <main className="simple">
      <section className={`s-hero s-${run.status}`}>
        <div className="s-hero-top">
          <span className={`s-badge s-${run.status}`}>{RUN_STATUS_TEXT[run.status]}</span>
          <span className="muted">
            {PLATFORM_LABEL[run.platform] ?? run.platform}{project ? ` · ${project}` : ''} · 已用时 {fmtSpan(elapsed)} · 最近更新 {fmtAgo(now - run.updated_at)}
          </span>
        </div>
        <h1>{ov.title}</h1>
        {ov.progress.total > 0 && (
          <div className="s-progress" aria-label={`已完成 ${ov.progress.done} / ${ov.progress.total} 个步骤`}>
            <div className="s-bar"><div style={{ width: `${pct}%` }} /></div>
            <span>已完成 {ov.progress.done} / {ov.progress.total} 个步骤</span>
          </div>
        )}
      </section>

      <div className="s-grid3">
        <section className="s-card">
          <h3>🔄 现在在做</h3>
          {ov.now.length === 0 ? <p className="muted">目前没有正在进行的工作</p> : (
            <ul className="s-list">
              {ov.now.map((n, i) => (
                <li key={i}><span className={`dot st-${n.status}`} /><b>{n.who}</b>{n.what}</li>
              ))}
            </ul>
          )}
        </section>
        <section className="s-card">
          <h3>➡️ 下一步</h3>
          <ul className="s-list">{ov.next.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </section>
        <section className="s-card">
          <h3>✅ 已经完成 <span className="muted">{ov.done.length ? `(${ov.done.length})` : ''}</span></h3>
          {ov.done.length === 0 ? <p className="muted">还没有完成的步骤</p> : (
            <ul className="s-list s-done">{ov.done.slice(0, 6).map((d, i) => <li key={i}>{d}</li>)}</ul>
          )}
          {ov.done.length > 6 && <p className="muted small">还有 {ov.done.length - 6} 项…</p>}
        </section>
      </div>

      {ov.errors.length > 0 && (
        <section className="s-card s-errors">
          <h3>⚠️ 这一轮出错了 ({ov.errors.length})</h3>
          <ul className="s-list">
            {[...ov.errors].reverse().slice(0, 5).map((e) => (
              <li key={e.key + e.ts}><b>{e.who}</b>{e.text}<span className="muted s-time">{fmtAgo(now - e.ts)}</span></li>
            ))}
          </ul>
        </section>
      )}

      <div className="s-grid2">
        <section className="s-card">
          <h3>📋 工作过程 <span className="muted small">最新的在最上面</span></h3>
          {shown.length === 0 ? <p className="muted">暂无记录</p> : (
            <ol className="s-steps">
              {shown.map((s) => (
                <li key={s.key + s.ts} className={`s-step s-${s.state}`}>
                  <span className="s-icon">{s.state === 'ok' ? '✓' : s.state === 'fail' ? '✗' : '•'}</span>
                  <span className="s-step-text"><b>{s.who}</b>{s.text}</span>
                  <span className="muted s-time">{fmtAgo(now - s.ts)}</span>
                </li>
              ))}
            </ol>
          )}
          {recent.length > STEPS_SHOWN && (
            <button className="link" onClick={() => setShowAll(!showAll)}>
              {showAll ? '收起' : `显示全部 ${recent.length} 条`}
            </button>
          )}
        </section>
        <section className="s-card">
          <h3>👥 谁在参与</h3>
          <Team agents={run.agents} events={events} />
        </section>
      </div>
    </main>
  )
}

function Team({ agents, events }: { agents: Agent[]; events: AgentEvent[] }) {
  const ids = new Set(agents.map((a) => a.id))
  const roots = agents.filter((a) => !a.parent || !ids.has(a.parent))
  const render = (a: Agent) => {
    const children = agents.filter((c) => c.parent === a.id)
    return (
      <li key={a.id}>
        <div className="s-member">
          <span className={`dot st-${a.status}`} />
          <b>{agentLabel(a)}</b>
          <span className={`st-text st-${a.status}`}>{STATUS_TEXT[a.status]}</span>
        </div>
        {['running', 'planning', 'waiting'].includes(a.status) && (
          <div className="muted s-member-sub">{currentActivity(a, events)}</div>
        )}
        {children.length > 0 && <ul className="s-team s-sub">{children.map(render)}</ul>}
      </li>
    )
  }
  return <ul className="s-team">{roots.map(render)}</ul>
}
