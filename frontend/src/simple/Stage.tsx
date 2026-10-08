import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CallRecord } from '../derive'
import type { Agent, AgentEvent } from '../types'
import { CATEGORY, STATUS_TEXT, agentColor, agentIcon, agentLabel, currentActivity, radialLayout, toolCategory, type Category } from './plain'

interface Props {
  agents: Agent[]
  events: AgentEvent[]
  calls: CallRecord[]
  now: number
}

const ACTIVE = new Set(['running', 'planning', 'waiting'])
const MESSAGE_FLIGHT_MS = 4000

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

/** Gentle curve between two points; `bend` pushes the control point sideways so parallel paths don't overlap. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }, bend = 0.12): string {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  const cx = mx - (b.y - a.y) * bend, cy = my + (b.x - a.x) * bend
  return `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`
}

export function Stage({ agents, events, calls, now }: Props) {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const pos = useMemo(() => radialLayout(agents, w, h), [agents, w, h])

  const perAgent = useMemo(() => {
    const m = new Map<string, { counts: Map<Category, number>; open: CallRecord | undefined; failed: number }>()
    for (const c of calls) {
      const cat = toolCategory(c.name)
      const entry = m.get(c.agent) ?? { counts: new Map(), open: undefined, failed: 0 }
      if (cat !== 'delegate') entry.counts.set(cat, (entry.counts.get(cat) ?? 0) + 1)
      if (c.status === 'running') entry.open = c
      if (c.status === 'failed') entry.failed += 1
      m.set(c.agent, entry)
    }
    return m
  }, [calls])

  const flights = events.filter((e) => e.event_type === 'agent_message' && now - e.timestamp < MESSAGE_FLIGHT_MS &&
    e.source && e.target && e.source !== e.target && pos.has(e.source) && pos.has(e.target))

  return (
    <div className="stage" ref={ref}>
      <svg className="stage-svg" width={w} height={h}>
        <defs>
          <radialGradient id="spark"><stop offset="0%" stopColor="#fff" /><stop offset="100%" stopColor="#fff" stopOpacity="0" /></radialGradient>
        </defs>
        {agents.map((a) => {
          const from = a.kind === 'main' ? undefined : pos.get(a.parent ?? '') ?? pos.get(agents.find((x) => x.kind === 'main')?.id ?? '')
          const to = pos.get(a.id)
          if (!from || !to) return null
          const d = curve(from, to)
          const active = ACTIVE.has(a.status)
          return (
            <g key={a.id} className={`edge st-${a.status}`} style={{ color: agentColor(a.id) }}>
              <path d={d} className="edge-base" />
              {active && <path d={d} className="edge-flow" />}
              {active && (
                <circle r="4" className="edge-spark">
                  <animateMotion dur="1.8s" repeatCount="indefinite" path={d} />
                </circle>
              )}
            </g>
          )
        })}
        {flights.map((e) => {
          const d = curve(pos.get(e.source!)!, pos.get(e.target!)!, -0.18)
          return (
            <g key={e.event_id} className="flight" style={{ color: agentColor(e.source!) }}>
              <path d={d} className="flight-trail" />
              <circle r="5" className="flight-dot">
                <animateMotion dur="1.2s" fill="freeze" path={d} />
              </circle>
            </g>
          )
        })}
      </svg>

      {agents.map((a) => {
        const p = pos.get(a.id)
        if (!p) return null
        const info = perAgent.get(a.id)
        const active = ACTIVE.has(a.status)
        const cat: Category | null = !active ? null : info?.open ? toolCategory(info.open.name) : a.status === 'waiting' ? null : 'think'
        const activity = active ? currentActivity(a, events) : null
        const chips = [...(info?.counts ?? [])].sort((x, y) => y[1] - x[1]).slice(0, 4)
        return (
          <div key={a.id} className={`ag st-${a.status} ${a.kind === 'main' ? 'main' : ''}`}
               style={{ left: p.x, top: p.y, ['--c' as string]: agentColor(a.id) }}>
            {activity && <div className="ag-bubble" key={activity}>{activity}</div>}
            <div className="ag-avatar">
              <span className="ag-ring" />
              <span className="ag-emoji">{agentIcon(a)}</span>
              {cat && <span className="ag-act" title={CATEGORY[cat].label}>{CATEGORY[cat].icon}</span>}
              {a.status === 'waiting' && <span className="ag-act wait">⏳</span>}
              {a.status === 'completed' && <span className="ag-badge ok">✓</span>}
              {a.status === 'failed' && <span className="ag-badge bad">!</span>}
            </div>
            <div className="ag-name">{agentLabel(a)}</div>
            <div className={`ag-status st-text st-${a.status}`}>{STATUS_TEXT[a.status]}</div>
            {(chips.length > 0 || !!info?.failed) && (
              <div className="ag-chips">
                {chips.map(([c, n]) => (
                  <span key={c} title={`${CATEGORY[c].label} ${n} 次`} style={{ color: CATEGORY[c].color }}>{CATEGORY[c].icon}{n}</span>
                ))}
                {!!info?.failed && <span className="ag-err" title={`这一轮有 ${info.failed} 个动作失败`}>⚠{info.failed}</span>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
