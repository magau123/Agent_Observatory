import { useMemo, useState } from 'react'
import { PLATFORM_LABEL, fmtTime, llmCalls, toolCalls } from '../derive'
import type { AgentEvent, RunSnapshot } from '../types'
import { RUN_STATUS_TEXT, agentColor, agentIcon, buildSteps, fmtAgo, overview } from './plain'
import { Stage } from './Stage'
import { Swimlanes } from './Swimlanes'

interface Props {
  run: RunSnapshot | null
  events: AgentEvent[]
  now: number
}

const FEED_SHOWN = 30

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return hh ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`
}

function Ring({ done, total }: { done: number; total: number }) {
  const r = 26, c = 2 * Math.PI * r
  const frac = total ? done / total : 0
  return (
    <svg className="ring" viewBox="0 0 64 64" aria-label={`已完成 ${done} / ${total} 个步骤`}>
      <circle cx="32" cy="32" r={r} className="ring-bg" />
      <circle cx="32" cy="32" r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      <text x="32" y="36" textAnchor="middle">{total ? `${done}/${total}` : '—'}</text>
    </svg>
  )
}

export function SimpleView({ run, events, now }: Props) {
  const steps = useMemo(() => (run ? buildSteps(run, events) : []), [run, events])
  const ov = useMemo(() => (run ? overview(run, events, steps) : null), [run, events, steps])
  const calls = useMemo(() => toolCalls(events), [events])
  const thoughts = useMemo(() => llmCalls(events), [events])
  const [showAll, setShowAll] = useState(false)

  if (!run || !ov) {
    return (
      <main className="simple">
        <div className="s-empty">
          <div className="s-empty-orb">🔭</div>
          <h2>还没有任务</h2>
          <p>在 Cursor、Claude Code 或 Codex 里开始一个任务，助手们会出现在这里开始工作。</p>
        </div>
      </main>
    )
  }

  const live = run.status === 'running'
  const end = ov.turnEnd ?? (live ? now : run.updated_at)
  const turnAgents = run.agents.filter((a) => a.kind === 'main' || (a.started_at ?? a.last_active) >= ov.turnStart || a.status !== 'completed')
  const agents = turnAgents.length ? turnAgents : run.agents
  const turnCalls = calls.filter((c) => c.startedAt >= ov.turnStart || c.status === 'running')
  const turnThoughts = thoughts.filter((c) => c.startedAt >= ov.turnStart)
  const feed = steps.filter((s) => s.ts >= ov.turnStart).reverse()
  const shownFeed = showAll ? feed : feed.slice(0, FEED_SHOWN)
  const byId = new Map(run.agents.map((a) => [a.id, a]))
  const project = run.cwd?.split(/[\\/]/).filter(Boolean).pop()

  return (
    <main className="simple">
      <section className={`hero s-${run.status}`}>
        <div className="hero-main">
          <div className="hero-top">
            <span className={`s-badge s-${run.status}`}><i />{RUN_STATUS_TEXT[run.status]}</span>
            <span className="muted">{PLATFORM_LABEL[run.platform] ?? run.platform}{project ? ` · ${project}` : ''} · 开始于 {fmtTime(ov.turnStart)}</span>
          </div>
          <h1 title={ov.title}>{ov.title}</h1>
          <div className="hero-next"><span>下一步</span>{ov.next[0]}</div>
        </div>
        <div className="hero-stats">
          <div className="stat"><b className={live ? 'ticking' : ''}>{clock(end - ov.turnStart)}</b><span>本轮用时</span></div>
          <div className="stat"><b>{agents.length}</b><span>位助手</span></div>
          <div className={`stat ${ov.errors.length ? 'bad' : ''}`}><b>{ov.errors.length}</b><span>处出错</span></div>
          <Ring done={ov.progress.done} total={ov.progress.total} />
        </div>
      </section>

      <section className="panel stage-panel">
        <div className="panel-head"><h3>协作现场</h3><span className="muted">中间是主助手，周围是它安排的助手；流动的光点表示正在派活或传递结果</span></div>
        <Stage agents={agents} events={events} calls={turnCalls} now={now} />
      </section>

      <section className="panel lanes-panel">
        <div className="panel-head"><h3>时间轴</h3><span className="muted">每位助手一条泳道，色块是它在那段时间做的事</span></div>
        <Swimlanes agents={agents} calls={turnCalls} thoughts={turnThoughts} from={ov.turnStart} to={Math.max(end, ov.turnStart + 1)} live={live} />
      </section>

      <aside className="panel side-panel">
        {ov.checklist.length > 0 && (
          <div className="checklist">
            <h3>本轮清单</h3>
            <ul>
              {ov.checklist.map((t, i) => (
                <li key={i} className={`ck-${t.status}`}>
                  <span className="ck-box">{t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : ''}</span>
                  {t.label}
                </li>
              ))}
            </ul>
          </div>
        )}
        <h3>实时动态</h3>
        {feed.length === 0 ? <p className="muted">暂无动态</p> : (
          <ol className="feed">
            {shownFeed.map((s) => {
              const a = byId.get(s.agent)
              return (
                <li key={s.key + s.ts} className={`feed-item f-${s.state}`} style={{ ['--c' as string]: agentColor(s.agent || 'user') }}>
                  <span className="feed-avatar">{a ? agentIcon(a) : '🙂'}</span>
                  <div className="feed-body">
                    <div className="feed-head"><b>{s.who}</b><span className="muted">{fmtAgo(now - s.ts)}</span></div>
                    <div className="feed-text">{s.text}</div>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        {feed.length > FEED_SHOWN && (
          <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? '收起' : `显示全部 ${feed.length} 条`}</button>
        )}
      </aside>
    </main>
  )
}
