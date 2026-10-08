import { useEffect, useMemo, useState } from 'react'
import { AgentDetail } from './agent/AgentDetail'
import { RunList } from './components/RunList'
import { ErrorsPanel, ReportsPanel, RunOverview } from './components/SidePanels'
import { AgentGraph } from './graph/AgentGraph'
import { MetricsBar } from './metrics/MetricsBar'
import { SimpleView } from './simple/SimpleView'
import { Timeline } from './timeline/Timeline'
import { useObservatory } from './useObservatory'

type Tab = 'run' | 'errors' | 'reports'

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}

export default function App() {
  const obs = useObservatory()
  const now = useNow(1000)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('run')
  const [seenReports, setSeenReports] = useState(0)
  const [simple, setSimple] = useState(() => localStorage.getItem('obs-view') !== 'detailed')
  const { run, events } = obs

  useEffect(() => localStorage.setItem('obs-view', simple ? 'simple' : 'detailed'), [simple])

  useEffect(() => setSelectedAgent(null), [obs.selectedRunId])
  useEffect(() => { if (tab === 'reports') setSeenReports(obs.reports.length) }, [tab, obs.reports.length])

  const agents = run?.agents ?? []
  const agent = agents.find((a) => a.id === selectedAgent) ?? null
  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  const unread = Math.max(0, obs.reports.length - seenReports)
  const errorCount = run?.metrics.errors ?? 0

  const header = (
    <header>
      <div className="brand">◎ Agent Observatory</div>
      <span className={`conn ${obs.connected ? 'on' : 'off'}`}>{obs.connected ? '已连接' : '正在重新连接…'}</span>
      {!simple && run && <span className="muted crumbs">{run.title ?? run.run_id}</span>}
      <label className="right follow">
        <input type="checkbox" checked={obs.follow} onChange={(e) => obs.setFollow(e.target.checked)} /> 自动切换到正在进行的任务
      </label>
      <button className="view-toggle" onClick={() => setSimple(!simple)}>{simple ? '详细视图' : '简洁视图'}</button>
    </header>
  )
  const runList = <RunList runs={obs.runs} selected={obs.selectedRunId} now={now} onSelect={obs.selectRun} onDelete={obs.deleteRun} />

  if (simple) {
    return (
      <div className="app simple-app">
        {header}
        {runList}
        <SimpleView run={run} events={events} now={now} />
      </div>
    )
  }

  return (
    <div className="app">
      {header}
      {runList}
      <main>
        <MetricsBar m={run?.metrics ?? null} />
        <AgentGraph agents={agents} events={events} selectedAgent={selectedAgent} onSelect={setSelectedAgent} now={now} />
        <Timeline events={events} agents={agents} onSelectAgent={setSelectedAgent} />
      </main>
      <aside className="side">
        {agent ? (
          <AgentDetail agent={agent} tasks={run?.tasks ?? []} events={events} now={now} onClose={() => setSelectedAgent(null)} />
        ) : (
          <>
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'run'} className={tab === 'run' ? 'on' : ''} onClick={() => setTab('run')}>Run</button>
              <button role="tab" aria-selected={tab === 'errors'} className={tab === 'errors' ? 'on' : ''} onClick={() => setTab('errors')}>
                Errors{errorCount > 0 && <span className="pill bad">{errorCount}</span>}
              </button>
              <button role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'on' : ''} onClick={() => setTab('reports')}>
                Reports{unread > 0 && <span className="pill">{unread}</span>}
              </button>
            </div>
            {tab === 'run' && (run ? <RunOverview run={run} now={now} /> : <div className="empty small">Select a run</div>)}
            {tab === 'errors' && <ErrorsPanel events={events} names={names} onSelectAgent={setSelectedAgent} />}
            {tab === 'reports' && (
              <ReportsPanel reports={obs.reports} onRequest={() => { obs.requestReport().catch(console.error) }} onOpenRun={obs.selectRun} />
            )}
          </>
        )}
      </aside>
    </div>
  )
}
