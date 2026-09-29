import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, Report, RunSnapshot, RunSummary, ServerMessage } from './types'

const MAX_EVENTS = 5000

export interface Observatory {
  connected: boolean
  runs: RunSummary[]
  run: RunSnapshot | null
  events: AgentEvent[]
  reports: Report[]
  selectedRunId: string | null
  selectRun: (id: string) => void
  deleteRun: (id: string) => void
  requestReport: () => Promise<void>
  follow: boolean
  setFollow: (v: boolean) => void
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return (await res.json()) as T
}

export function useObservatory(): Observatory {
  const [connected, setConnected] = useState(false)
  const [runs, setRuns] = useState<Record<string, RunSummary>>({})
  const [run, setRun] = useState<RunSnapshot | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const selectedRef = useRef<string | null>(null)
  const runsRef = useRef<Record<string, RunSummary>>({})
  const followRef = useRef(follow)
  followRef.current = follow

  const selectRun = useCallback((id: string) => {
    selectedRef.current = id
    setSelectedRunId(id)
    setEvents([])
    setRun(null)
    Promise.all([
      getJson<RunSnapshot>(`/api/runs/${encodeURIComponent(id)}`),
      getJson<AgentEvent[]>(`/api/runs/${encodeURIComponent(id)}/events`),
    ])
      .then(([snap, evs]) => {
        if (selectedRef.current !== id) return
        // a live WebSocket snapshot may be newer than this REST response
        setRun((cur) => (cur && cur.run_id === id && cur.updated_at > snap.updated_at ? cur : snap))
        setEvents((live) => {
          const seen = new Set(evs.map((e) => e.event_id))
          return [...evs, ...live.filter((e) => !seen.has(e.event_id))].slice(-MAX_EVENTS)
        })
      })
      .catch((err: unknown) => console.error('failed to load run', err))
  }, [])

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry = 1000
    let timer: number | undefined
    let disposed = false

    const onMessage = (msg: ServerMessage) => {
      switch (msg.type) {
        case 'hello': {
          runsRef.current = Object.fromEntries(msg.runs.map((r) => [r.run_id, r]))
          setRuns(runsRef.current)
          setReports(msg.reports)
          const first = msg.runs[0]
          if (selectedRef.current) selectRun(selectedRef.current)
          else if (first) selectRun(first.run_id)
          break
        }
        case 'event': {
          const { event, run: snap } = msg
          runsRef.current = { ...runsRef.current, [snap.run_id]: snap }
          setRuns(runsRef.current)
          const current = selectedRef.current
          if (snap.run_id === current) {
            setRun(snap)
            // the REST load may already contain this event if it raced the WebSocket frame
            setEvents((prev) => prev.slice(-500).some((e) => e.event_id === event.event_id)
              ? prev : [...prev, event].slice(-MAX_EVENTS))
          } else if (followRef.current && snap.status === 'running') {
            // jump to live activity unless the run being watched is itself still running
            const watched = current ? runsRef.current[current] : undefined
            if (!watched || watched.status !== 'running') selectRun(snap.run_id)
          }
          break
        }
        case 'run_updated':  // older events were folded into this run (linked subagent): reload it
          runsRef.current = { ...runsRef.current, [msg.run.run_id]: msg.run }
          setRuns(runsRef.current)
          if (selectedRef.current === msg.run.run_id) selectRun(msg.run.run_id)
          break
        case 'report':
          setReports((prev) => [msg.report, ...prev].slice(0, 100))
          break
        case 'run_removed': {
          const { [msg.run_id]: _removed, ...rest } = runsRef.current
          runsRef.current = rest
          setRuns(rest)
          if (selectedRef.current === msg.run_id) {
            selectedRef.current = null
            setSelectedRunId(null)
            setRun(null)
            setEvents([])
          }
          break
        }
      }
    }

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      ws.onopen = () => {
        retry = 1000
        setConnected(true)
      }
      ws.onmessage = (e: MessageEvent<string>) => {
        try {
          onMessage(JSON.parse(e.data) as ServerMessage)
        } catch (err) {
          console.error('bad message', err)
        }
      }
      ws.onclose = () => {
        setConnected(false)
        if (!disposed) {
          timer = window.setTimeout(connect, retry)
          retry = Math.min(retry * 2, 10000)
        }
      }
    }
    connect()
    return () => {
      disposed = true
      window.clearTimeout(timer)
      ws?.close()
    }
  }, [selectRun])

  const deleteRun = useCallback((id: string) => {
    fetch(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((err: unknown) => console.error(err))
  }, [])

  const requestReport = useCallback(async () => {
    await getJson<Report>('/api/reports/now', { method: 'POST' })
  }, [])

  const sortedRuns = Object.values(runs).sort((a, b) => b.updated_at - a.updated_at)
  return { connected, runs: sortedRuns, run, events, reports, selectedRunId, selectRun, deleteRun,
    requestReport, follow, setFollow }
}
